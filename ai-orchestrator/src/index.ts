import dotenv from 'dotenv';
import path from 'node:path';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { DeduplicationAgent } from './agents/deduplication/agent.js';
import { ImpactAnalysisAgent, matchesKeyword } from './agents/impact-analysis/agent.js';
import { TeamAgent } from './agents/team-agent/team-agent.js';
import { TestingAgent } from './agents/testing/agent.js';
import { MockAIProvider } from './providers/ai-provider.js';
import { ClaudeProvider } from './providers/claude-provider.js';
import { HandoffProvider } from './providers/handoff-provider.js';
import { ClaudeCodeProvider, type ImplementationPlan } from './providers/claude-code-provider.js';
import { PlanningAgent, PlanningRunError, type PlannerRepo } from './agents/planning/planning-agent.js';
import { codingBrief, repoDependencies } from './agents/planning/plan-rules.js';
import { renderMissing, renderPlan, renderQuestions } from './agents/planning/render.js';
import type { PlanQuestion, TicketPlan } from './agents/planning/types.js';
import { JiraClient } from './integrations/jira/jira-client.js';
import { ServiceCatalog } from './catalog/service-catalog.js';
import { ComponentMap } from './catalog/component-map.js';
import { intakeFor, killSwitchOn, loadPipelineConfig, type PipelineConfig } from './config/pipeline-config.js';
import { runIntake } from './agents/intake/intake.js';
import { JobStore, PROCESS_INSTANCE } from './jobs/job-store.js';
import { FileSessionStore } from './jobs/session-store.js';
import { GitWorkspaceManager } from './workspace/git-workspace.js';
import { BitbucketClient } from './integrations/bitbucket/bitbucket-client.js';
import {
  AutomationWatcher,
  DEFAULT_LABELS,
  buildPrDescription,
  type PlanOutcome,
  type PullRequestLink,
  type WatcherLabels
} from './automation/watcher.js';
import { startWebhookServer } from './automation/webhook-server.js';
import { redactSecrets } from './util/redact.js';
import type { ImpactAnalysisResult, OrchestratorResult, TaskInput } from './models/types.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.REPOSITORIES_ROOT
  ? path.resolve(process.cwd(), process.env.REPOSITORIES_ROOT)
  : path.resolve(__dirname, '../repositories');
let catalogPath = process.env.CATALOG_PATH
  ? path.resolve(process.cwd(), process.env.CATALOG_PATH)
  : path.resolve(__dirname, '../catalog/repos.yaml');
/** The dummy repos (repo-a/b/c) for the offline demo; never used by the live pipeline. */
const sampleCatalogPath = path.resolve(__dirname, '../tests/fixtures/sample-catalog.yaml');
const jobsDir = path.resolve(process.cwd(), process.env.JOBS_DIR || '.jobs');
const pipelineConfigPath = process.env.PIPELINE_CONFIG_PATH
  ? path.resolve(process.cwd(), process.env.PIPELINE_CONFIG_PATH)
  : path.resolve(__dirname, '../config/pipeline.yaml');
const componentMapPath = process.env.COMPONENT_MAP_PATH
  ? path.resolve(process.cwd(), process.env.COMPONENT_MAP_PATH)
  : path.resolve(__dirname, '../config/components.yaml');

/** Read fresh every time: limits and switches change without a restart. */
function pipelineConfig(): PipelineConfig {
  return loadPipelineConfig(pipelineConfigPath);
}
const killSwitch = () => killSwitchOn(pipelineConfigPath);

function loadComponentMap(catalog: ServiceCatalog | undefined): ComponentMap | undefined {
  return ComponentMap.load(componentMapPath, catalog?.repos.map((r) => r.id));
}

/** Jira client with the custom fields the pipeline reads (Product, story points). */
function makeJira(): JiraClient {
  const cfg = pipelineConfig();
  return new JiraClient({ productField: cfg.jira.productField, storyPointsField: cfg.jira.storyPointsField });
}
const worktreesDir = path.resolve(process.cwd(), process.env.WORKTREES_DIR || '.worktrees');

const PROVIDERS = ['mock', 'claude', 'claude-code', 'handoff'];

export interface CreateOrchestratorOptions {
  /** Human approval after impact analysis, before any code is written. */
  approvePlan?: (task: TaskInput, impact: ImpactAnalysisResult) => Promise<boolean>;
}

/** Loaded once: routing, repo paths, deploy order and verify contract (catalog/repos.yaml). */
function loadCatalog(): ServiceCatalog | undefined {
  return ServiceCatalog.load(catalogPath, repoRoot);
}

export function createOrchestrator(providerType?: string, options: CreateOrchestratorOptions = {}): Orchestrator {
  const chosenProvider = providerType || process.env.AI_PROVIDER || 'claude-code';

  // Service catalog (catalog/repos.yaml): routing, repo paths, deploy order, verify contract.
  // If the file is missing, every agent falls back to its built-in defaults.
  const catalog = loadCatalog();
  const repoPaths = catalog?.repoPaths() ?? {};

  // mock     = offline, free (default)
  // claude   = Anthropic API (needs API credits)
  // claude-code = Claude Code CLI as the coding agent, in a sandbox copy (uses the developer's Claude login)
  // handoff  = change set prepared by an external agent, applied through the same guards
  // Fail loudly on anything else rather than silently running a different provider.
  const providerKey = chosenProvider.toLowerCase();
  if (!PROVIDERS.includes(providerKey)) {
    throw new Error(`Unsupported AI_PROVIDER "${chosenProvider}". Use one of: ${PROVIDERS.join(', ')}.`);
  }
  const provider =
    providerKey === 'claude'
      ? new ClaudeProvider()
      : providerKey === 'claude-code'
        ? makeClaudeCodeProvider(catalog)
        : providerKey === 'handoff'
          ? new HandoffProvider()
          : new MockAIProvider();

  const historyFilePath = path.resolve(process.cwd(), '.task-history.json');
  const dedupAgent = new DeduplicationAgent({
    historyFilePath,
    repositoriesRoot: repoRoot,
    repoPaths
  });

  // Every agent must use the same repositories root (REPOSITORIES_ROOT), not just dedup.
  return new Orchestrator({
    aiProvider: provider,
    dedupAgent,
    impactAgent: new ImpactAnalysisAgent({
      repositoriesDir: repoRoot,
      ...(catalog ? { customRules: catalog.impactRules() } : {})
    }),
    teamAgent: new TeamAgent(provider, {
      repositoriesRoot: repoRoot,
      repoPaths,
      ...(catalog ? { dependencies: catalog.dependencies() } : {})
    }),
    testingAgent: new TestingAgent({
      repositoriesRoot: repoRoot,
      repoPaths,
      ...(catalog ? { verifyCommands: (id: string) => catalog.verifyCommands(id) } : {})
    }),
    // One run per ticket + persisted stage history in .jobs/<ticket>/job.json
    jobStore: new JobStore({ jobsDir }),
    // Standalone git repos get an isolated ai/<ticket> branch + worktree; others run in place.
    workspace: new GitWorkspaceManager({ worktreesDir }),
    resolveRepoPath: (repoId) => repoPaths[repoId] || path.resolve(repoRoot, repoId),
    resolveBaseBranch: (repoId) => catalog?.get(repoId)?.baseBranch,
    approvePlan: options.approvePlan
  });
}

function makeClaudeCodeProvider(catalog: ServiceCatalog | undefined): ClaudeCodeProvider {
  return new ClaudeCodeProvider({
    verifyCommandsFor: (id) => catalog?.verifyCommands(id).map((v) => v.run) ?? [],
    repoPurposeFor: (id) => catalog?.get(id)?.purpose
  });
}

function makePlanningAgent(catalog: ServiceCatalog | undefined, cfg: PipelineConfig, componentMap: ComponentMap | undefined): PlanningAgent {
  const repos: PlannerRepo[] = catalog
    ? catalog.repos.map((r) => ({
        id: r.id,
        name: r.name,
        purpose: r.purpose,
        path: catalog.resolvePath(r.id),
        keywords: r.keywords,
        dependsOn: r.dependsOn,
        verify: catalog.verifyCommands(r.id).map((v) => v.run)
      }))
    : fs
        .readdirSync(repoRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => ({ id: d.name, path: path.join(repoRoot, d.name) }));
  const promptFile = path.resolve(__dirname, '../prompts', `${cfg.promptVersion}.md`);
  if (cfg.planning.engine === 'tools' && !fs.existsSync(promptFile)) {
    throw new Error(`System prompt ${promptFile} not found (prompt_version "${cfg.promptVersion}" in ${pipelineConfigPath}).`);
  }
  // Only what the tool server needs to read Jira; never passed to the model.
  const toolServerEnv = Object.fromEntries(
    [
      ['JIRA_BASE_URL', process.env.JIRA_BASE_URL],
      ['JIRA_EMAIL', process.env.JIRA_EMAIL],
      ['JIRA_API_TOKEN', process.env.JIRA_API_TOKEN],
      ['JIRA_PRODUCT_FIELD', cfg.jira.productField],
      ['JIRA_STORY_POINTS_FIELD', cfg.jira.storyPointsField]
    ].filter((e): e is [string, string] => !!e[1])
  );
  return new PlanningAgent({
    repos,
    engine: cfg.planning.engine,
    ...(cfg.planning.engine === 'tools' ? { systemPrompt: fs.readFileSync(promptFile, 'utf-8') } : {}),
    maxToolCalls: cfg.planning.maxToolCalls || undefined,
    allowedProjects: cfg.planning.allowedJiraProjects.length ? cfg.planning.allowedJiraProjects : undefined,
    components: componentMap?.entries,
    toolServerEnv,
    // Intake (plain code) runs first: no tokens on tickets that are incomplete.
    hardChecks: (task) => runIntake(task, intakeFor(cfg, task.id), componentMap).gaps,
    model: cfg.planning.model || undefined,
    timeoutMs: cfg.planning.maxWallClockMin > 0 ? cfg.planning.maxWallClockMin * 60 * 1000 : undefined,
    maxBudgetUsd: cfg.planning.maxCostUsdPerTicket || undefined
  });
}

/** Per-repo facts shown to the approver: where changes go, how they are verified, how to roll back. */
async function repoExecutionLines(
  task: TaskInput,
  repoId: string,
  catalog: ServiceCatalog | undefined,
  providerName: string,
  why: string
): Promise<{ header: string[]; tail: string[] }> {
  const repoPath = catalog?.resolvePath(repoId) ?? path.resolve(repoRoot, repoId);
  const isGit = await GitWorkspaceManager.isGitRepoRoot(repoPath);
  const branch = GitWorkspaceManager.branchName('ai/', task.id);
  const verify = catalog?.verifyCommands(repoId).map((v) => v.run) ?? [];
  const verifyText = verify.length ? verify.join('  →  ') : 'make verify / npm test (fallback)';

  const header = [
    '',
    `REPOSITORY  ${repoId}${catalog?.get(repoId)?.name ? `  (${catalog.get(repoId)!.name})` : ''}`,
    `  Why this repo : ${why}`,
    `  Path          : ${repoPath}`,
    `  Changes go to : ${isGit ? `new branch ${branch} in a separate worktree (your checkout is not touched)` : 'the folder itself (not a standalone git repo, so no branch)'}`,
    `  Verify        : ${verifyText}`
  ];
  const tail = ['', '  Process after approval'];
  if (providerName === 'claude-code') {
    tail.push(
      `     1) Copy ${repoId} to a temporary sandbox (the real folder is not touched yet)`,
      '     2) Claude Code writes the tests first and confirms they FAIL on the current code',
      `     3) Claude Code implements the approved plan and runs: ${verifyText}`
    );
  } else {
    tail.push(`     1-3) AI step: ${describeProvider(providerName)}`);
  }
  tail.push(
    '     4) Pipeline safety checks: every file stays inside the repo; no test deleted, skipped or weakened',
    `     5) Pipeline applies the changes to ${isGit ? `branch ${branch} (separate worktree)` : 'the folder in place'}`,
    `     6) Pipeline re-runs the verify steps itself: ${verifyText}`,
    `     7) Result saved to .jobs/${task.id}/ (job.json + plan.md)${isGit ? `; commit on ${branch}, never pushed` : ''}`,
    `  Rollback      : ${isGit ? `delete branch ${branch} and its worktree; your base branch is never changed` : 'no git history in this folder: restore from a backup/copy (or clone the real repo to get branch-based rollback)'}`
  );
  return { header, tail };
}

export type TicketPlanStatus = 'ready' | 'needs-input' | 'needs-info' | 'invalid';

interface TicketPlanResult {
  status: TicketPlanStatus;
  ticketPlan: TicketPlan;
  problems: string[];
  repos: string[];
  /** Per-repo brief for the coding agent. */
  plans: Record<string, Record<string, unknown>>;
  repoDependencies: Record<string, string[]>;
  text: string;
  promptVersion: string;
  costUsd?: number;
  engine?: string;
  toolCalls?: unknown[];
  repoFacts?: Array<{ repo: string; branch?: string; verify?: string; rollback?: string }>;
}

/**
 * Planning phase (claude-code provider): the Planning Agent reads the ticket and every catalog
 * repo read-only and returns a structured plan. Code maps its verdict to the next step.
 */
async function buildTicketPlan(task: TaskInput, candidateRepos: string[], providerName: string): Promise<TicketPlanResult> {
  const catalog = loadCatalog();
  const cfg = pipelineConfig();
  const componentMap = loadComponentMap(catalog);
  const resolved = componentMap?.resolveTicket(
    Array.isArray(task.metadata?.components) ? (task.metadata!.components as string[]) : [],
    Array.isArray(task.metadata?.labels) ? (task.metadata!.labels as string[]) : []
  );
  if (task.metadata?.source === 'jira') {
    console.log('\n[PLANNING] Gathering context: linked documents and similar past tickets...');
    task = await makeJira().enrichForPlanning(task);
  }
  console.log('\n[PLANNING] Planning Agent is reading the ticket and the repositories (read-only)...');
  const result = await makePlanningAgent(catalog, cfg, componentMap).plan(task, {
    // Component map first, keyword routing only as a fallback.
    candidateRepos: resolved?.repos.length ? resolved.repos : candidateRepos,
    componentHint: resolved?.matched.length
      ? resolved.matched.map((c) => `${c} → ${componentMap!.get(c)!.repos.join(', ')}`).join('; ')
      : undefined,
    riskFloor: resolved?.riskFloor,
    componentRepos: resolved?.repos,
    riskFloorForRepos: componentMap ? (repos) => componentMap.riskFloorForRepos(repos) : undefined,
    previousQuestions: task.metadata?.previousQuestions as PlanQuestion[] | undefined,
    previousPlan: task.metadata?.previousPlan as TicketPlan | undefined
  });
  const plan = result.plan;
  const status: TicketPlanStatus =
    // Problems first: an incomplete gap analysis means the verdict itself cannot be trusted.
    result.problems.length ? 'invalid' : plan.readiness === 'blocking' ? 'needs-input' : plan.readiness === 'too_vague' ? 'needs-info' : 'ready';
  const repos = [...new Set(plan.workItems.map((w) => w.repo))];
  const repoFacts: Array<{ repo: string; branch?: string; verify?: string; rollback?: string }> = [];

  const hr = '─'.repeat(78);
  const L: string[] = ['', hr, `TICKET PLAN  ${task.id}  (${status === 'ready' ? 'for approval' : status})`, hr, `Ticket   : ${task.title}`];
  if (task.metadata?.url) L.push(`Link     : ${String(task.metadata.url)}`);
  if (result.modelCalled) L.push('', renderPlan(plan));
  if (plan.questions.length) {
    L.push('', 'BLOCKING QUESTIONS');
    for (const q of plan.questions) L.push(`  ${q.id}. ${q.text}`, ...q.options.map((o) => `      - ${o}${o === q.defaultOption ? '  (default)' : ''}`));
  }
  if (plan.missingForReporter.length) L.push('', 'MISSING FROM THE TICKET', ...plan.missingForReporter.map((m) => `  - ${m}`));
  if (result.problems.length) L.push('', 'PLAN PROBLEMS (cannot be approved as-is)', ...result.problems.map((p) => `  - ${p}`));
  if (status === 'ready') {
    for (const item of plan.workItems) {
      const { header, tail } = await repoExecutionLines(task, item.repo, catalog, providerName, item.reason || item.task);
      L.push(...header, ...tail);
      const repoPath = catalog?.resolvePath(item.repo) ?? path.resolve(repoRoot, item.repo);
      const isGit = await GitWorkspaceManager.isGitRepoRoot(repoPath);
      const branch = GitWorkspaceManager.branchName('ai/', task.id);
      const verify = catalog?.verifyCommands(item.repo).map((v) => v.run) ?? [];
      repoFacts.push({
        repo: item.repo,
        ...(isGit ? { branch } : {}),
        verify: verify.length ? verify.join(' → ') : 'make verify / npm test',
        rollback: isGit ? `delete branch ${branch} and its worktree` : 'restore the folder from a copy (not a git clone)'
      });
    }
  }
  L.push('', result.modelCalled ? `(Drafted by the Planning Agent, ${result.engine === 'tools' ? `planner tools only (${result.toolCalls?.length ?? 0} tool calls)` : 'read-only'}; prompt ${cfg.promptVersion}${result.stats ? `; ${result.stats}` : ''})` : '(Stopped by the intake checks; no AI call was made)');
  L.push(hr);

  const plans: Record<string, Record<string, unknown>> = {};
  for (const r of repos) {
    const brief = codingBrief(plan, r);
    if (brief) plans[r] = brief;
  }
  return {
    status,
    ticketPlan: plan,
    problems: result.problems,
    repos,
    plans,
    repoDependencies: repoDependencies(plan),
    text: L.join('\n'),
    promptVersion: cfg.promptVersion,
    ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
    engine: result.engine,
    toolCalls: result.toolCalls,
    repoFacts
  };
}

/** Ticket words that routed it to a repo (shown to the approver as "why this repo"). */
function matchedKeywords(task: TaskInput, repoId: string, catalog: ServiceCatalog | undefined): string[] {
  const meta = task.metadata || {};
  const tags = [...(Array.isArray(meta.labels) ? meta.labels : []), ...(Array.isArray(meta.components) ? meta.components : [])];
  const text = `${task.id} ${task.title} ${task.description} ${task.acceptanceCriteria.join(' ')} ${tags.join(' ')}`.toLowerCase();
  const keywords = [
    ...(catalog?.get(repoId)?.keywords ?? []),
    repoId,
    ...(catalog?.routes ?? []).filter((r) => r.repos.includes(repoId)).flatMap((r) => r.keywords)
  ];
  return [...new Set(keywords.filter((k) => matchesKeyword(text, k)))];
}

function formatImplementationPlan(plan: ImplementationPlan): string[] {
  if (plan.raw) return ['  Change plan (as written by the agent):', ...plan.raw.split('\n').map((l) => `    ${l}`)];
  const L: string[] = [];
  const list = (items: string[] | undefined) => (items?.length ? items.map((i) => `     - ${i}`) : ['     - none']);
  L.push('  1. Summary', `     ${plan.summary ?? '-'}`);
  L.push('  2. Problem today', `     ${plan.currentBehaviour ?? '-'}`);
  L.push('  3. Approach', ...(plan.approach?.length ? plan.approach.map((a, i) => `     ${i + 1}) ${a}`) : ['     -']));
  L.push('  4. Files to change', ...(plan.filesToChange?.length ? plan.filesToChange.map((f) => `     - ${f.path} — ${f.change}`) : ['     - none']));
  L.push(
    '  5. Tests to add (written FIRST; must fail on the current code)',
    ...(plan.testsToAdd?.length ? plan.testsToAdd.map((t) => `     - ${t.name}${t.covers ? `  [${t.covers}]` : ''}`) : ['     - none'])
  );
  L.push('  6. Acceptance criteria coverage', ...(plan.acCoverage?.length ? plan.acCoverage.map((c) => `     ${c.ac} → ${c.how}`) : ['     -']));
  L.push('  7. Client-visible behaviour changes', `     ${plan.behaviourChanges ?? '-'}`);
  L.push('  8. Risks and mitigations', ...list(plan.risks));
  L.push('  9. Out of scope (deliberately not changed)', ...list(plan.outOfScope));
  L.push(`  10. Open questions for the approver${plan.openQuestions?.length ? '  ⚠' : ''}`, ...list(plan.openQuestions));
  L.push('  11. Effort', `     ${plan.effort ?? '-'}`);
  return L;
}

interface ChangePlan {
  plans: Record<string, ImplementationPlan>;
  text: string;
}

/**
 * Builds the change plan shown for approval: ticket, why each repo, the implementation plan
 * (drafted read-only by Claude Code), the process after approval, and how to roll back.
 */
async function buildChangePlan(task: TaskInput, impact: ImpactAnalysisResult, providerName: string): Promise<ChangePlan> {
  const catalog = loadCatalog();
  const planner = providerName === 'claude-code' ? makeClaudeCodeProvider(catalog) : undefined;
  const hr = '─'.repeat(78);
  const plans: Record<string, ImplementationPlan> = {};
  const L: string[] = ['', hr, `CHANGE PLAN  ${task.id}  (for approval)`, hr];

  L.push(`Ticket   : ${task.title}`);
  if (task.metadata?.url) L.push(`Link     : ${String(task.metadata.url)}`);
  L.push(`Criteria : ${task.acceptanceCriteria.length || 'none given'}`);
  task.acceptanceCriteria.forEach((c, i) => L.push(`  AC-${i + 1}. ${c}`));

  for (const repoId of impact.affectedRepositories) {
    const repoPath = catalog?.resolvePath(repoId) ?? path.resolve(repoRoot, repoId);
    const matched = matchedKeywords(task, repoId, catalog);
    const { header, tail } = await repoExecutionLines(
      task,
      repoId,
      catalog,
      providerName,
      `ticket mentions ${matched.length ? matched.join(', ') : '(matched by routing rule)'}`
    );
    L.push(...header, '');

    if (planner) {
      console.log(`\n[PLANNING] Claude Code is reading ${repoId} (read-only) to draft the change plan...`);
      try {
        const proposal = await planner.proposePlan(task, repoId, repoPath);
        plans[repoId] = proposal.plan;
        L.push(...formatImplementationPlan(proposal.plan));
        L.push(`  (Drafted by Claude Code in read-only mode${proposal.stats ? `; ${proposal.stats}` : ''})`);
      } catch (err: unknown) {
        L.push(`  Change plan unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      L.push(`  Change plan   : detailed plan is drafted only with --provider claude-code (current: ${providerName})`);
    }

    L.push(...tail);
  }
  L.push(hr);
  return { plans, text: L.join('\n') };
}

function describeProvider(providerName: string): string {
  switch (providerName) {
    case 'claude-code':
      return 'Claude Code (headless) codes in a sandbox copy: tests first, then implementation; pipeline applies + verifies';
    case 'claude':
      return 'Claude API returns full-file changes; pipeline applies + verifies';
    case 'handoff':
      return 'change set prepared in .handoff/<ticket>/<repo>.json; pipeline applies + verifies';
    default:
      return 'mock provider (demo only, does not write real code)';
  }
}

/** Saves the plan and the decision next to the job record (audit trail). */
function savePlanRecord(taskId: string, text: string, decision: string, planned?: TicketPlanResult): string {
  const dir = path.join(jobsDir, taskId.replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  if (planned) {
    fs.writeFileSync(
      path.join(dir, 'ticket-plan.json'),
      JSON.stringify(
        { promptVersion: planned.promptVersion, engine: planned.engine, costUsd: planned.costUsd, status: planned.status, plan: planned.ticketPlan, toolCalls: planned.toolCalls },
        null,
        2
      )
    );
  }
  const file = path.join(dir, 'plan.md');
  fs.writeFileSync(file, `# Change plan ${taskId}\n\n\`\`\`\n${text.trim()}\n\`\`\`\n\n**Decision:** ${decision} at ${new Date().toISOString()}\n`);
  return file;
}

/** Asks the human in the terminal (or auto-approves with --yes). */
async function askApproval(taskId: string, autoYes: boolean): Promise<{ approved: boolean; decision: string }> {
  if (autoYes) return { approved: true, decision: 'APPROVED (auto, --yes)' };
  if (!process.stdin.isTTY) return { approved: false, decision: 'NOT APPROVED (no interactive terminal; re-run with --yes to approve)' };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`\nApprove this change plan and start implementation for ${taskId}? [y/N] `)).trim().toLowerCase();
    const approved = answer === 'y' || answer === 'yes';
    return { approved, decision: approved ? 'APPROVED' : `NOT APPROVED (answer: "${answer || 'empty'}")` };
  } finally {
    rl.close();
  }
}

/** Interactive gate: shows the full change plan and asks for approval (or auto-approves with --yes). */
function makeApprovalGate(providerName: string, autoYes: boolean) {
  return async (task: TaskInput, impact: ImpactAnalysisResult): Promise<boolean> => {
    const { plans, text } = await buildChangePlan(task, impact, providerName);
    console.log(text);
    const { approved, decision } = await askApproval(task.id, autoYes);

    // The coding step follows exactly the plan that was approved.
    if (approved && Object.keys(plans).length) {
      task.metadata = { ...(task.metadata || {}), approvedPlans: plans };
    }
    const file = savePlanRecord(task.id, text, decision);
    console.log(`Plan decision: ${decision}  (saved to ${file})`);
    return approved;
  };
}

function printUsage(): void {
  console.log(`Usage:
  npm start -- T2-547              Run a Jira ticket (note the space after "--")
  npm start -- --demo               Run the built-in PAY-101 sample demo on repositories/repo-a
  npm run watch                     AUTOMATION: poll Jira for labelled tickets and run them end to end
  npm run webhook                   AUTOMATION: receive Jira webhooks (POST /webhooks/jira) instead of polling
  npm run watch -- --once           One polling cycle and exit (for Jenkins/cron)
  npm run watch -- --dry-run        Show what the watcher would do; no Jira writes, no AI runs
  npm start -- RT-123 [RT-124 ...]  Fetch Jira issue(s) by key and run them through the pipeline
  npm start -- --jql "<JQL>" [--max N]
                                    Fetch issues matching JQL (default max 5) and run each
  npm start -- --dry-run RT-123     Fetch and print the parsed task(s) without running the pipeline
  npm start -- --plan RT-123        Duplicate check + impact analysis only: which repos, where, which verify steps
  npm start -- RT-123 --yes         Run without the interactive "Approve plan?" prompt
  npm start -- RT-123 --provider claude-code
                                    Full pipeline with Claude Code as the coding agent
                                    (same as AI_PROVIDER=claude-code; providers: mock, claude, claude-code, handoff)
  npm start -- --status RT-123      Show a ticket's pipeline phase (history) and saved job state
  npm start -- --sessions           List every ticket's pipeline phase
  npm start -- --unlock RT-123      Remove a stuck lock for a ticket (only if no run is active)`);
}

interface CliArgs {
  keys: string[];
  jql?: string;
  max: number;
  dryRun: boolean;
  plan: boolean;
  yes: boolean;
  demo: boolean;
  watch: boolean;
  webhook: boolean;
  once: boolean;
  interval: number;
  provider?: string;
  help: boolean;
  status?: string;
  unlock?: string;
  sessions: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { keys: [], max: 5, dryRun: false, plan: false, yes: false, demo: false, watch: false, webhook: false, sessions: false, once: false, interval: 120, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jql') args.jql = argv[++i];
    else if (a === '--max') args.max = Number(argv[++i]) || args.max;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--plan') args.plan = true;
    else if (a === '--yes' || a === '-y') args.yes = true;
    else if (a === '--demo') args.demo = true;
    else if (a === '--watch') args.watch = true;
    else if (a === '--webhook') args.webhook = true;
    else if (a === '--sessions') args.sessions = true;
    else if (a === '--once') args.once = true;
    else if (a === '--interval') args.interval = Number(argv[++i]) || args.interval;
    else if (a === '--provider') args.provider = (argv[++i] || '').toLowerCase();
    else if (a === '--status') args.status = (argv[++i] || '').toUpperCase();
    else if (a === '--unlock') args.unlock = (argv[++i] || '').toUpperCase();
    else if (a === '-h' || a === '--help') args.help = true;
    else if (/^[A-Z][A-Z0-9_]+-\d+$/i.test(a)) args.keys.push(a.toUpperCase());
    else throw new Error(`Unrecognised argument: ${a}`);
  }
  return args;
}

async function runJiraTasks(orchestrator: Orchestrator, args: CliArgs, providerName: string): Promise<void> {
  const jira = makeJira();

  const tasks: TaskInput[] = [];
  for (const key of args.keys) {
    tasks.push(await jira.getTask(key));
  }
  if (args.jql) {
    tasks.push(...(await jira.searchTasks(args.jql, args.max)));
  }

  if (tasks.length === 0) {
    console.log('No Jira issues found for the given keys / JQL.');
    return;
  }

  let failures = 0;
  for (const task of tasks) {
    console.log('\n' + '='.repeat(60));
    console.log(`>>> JIRA ${task.id}: ${task.title}`);
    console.log(`    ${String(task.metadata?.url ?? '')}`);
    console.log(`    Acceptance criteria: ${task.acceptanceCriteria.length}`);
    for (const c of task.acceptanceCriteria) console.log(`      - ${c}`);
    const comments = (task.metadata?.comments as Array<{ author: string; created: string; body: string }>) || [];
    console.log(`    Comments: ${comments.length}`);
    for (const c of comments.slice(-5)) {
      console.log(`      [${c.created.slice(0, 10)}] ${c.author}: ${c.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    console.log('='.repeat(60));

    if (args.dryRun) {
      console.log(JSON.stringify(task, null, 2));
      continue;
    }

    if (!args.dryRun && killSwitch()) {
      console.log(`\nKill switch is on (${pipelineConfigPath} or AI_KILL_SWITCH): ${task.id} not started.`);
      failures++;
      continue;
    }
    if (providerName === 'claude-code') {
      // Planning phase first (dedup → Planning Agent), then approval, then the coding pipeline.
      const preview = await orchestrator.plan(task);
      console.log(`\n[DEDUPLICATION] ${preview.deduplication.status.toUpperCase()}: ${preview.deduplication.reason}`);
      if (preview.deduplication.status === 'duplicate') {
        failures++;
        continue;
      }
      let planned: TicketPlanResult;
      try {
        planned = await buildTicketPlan(task, preview.impact?.affectedRepositories ?? [], providerName);
      } catch (err) {
        // One ticket failing must not stop the others.
        console.log(`\n[PLANNING] ${task.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!args.plan) new FileSessionStore(jobsDir).setPhase(task.id, 'needs_human', `CLI run: planning failed`);
        failures++;
        continue;
      }
      console.log(planned.text);
      const readyLabel = process.env.LABEL_READY || DEFAULT_LABELS.ready;
      if (planned.status === 'needs-input') console.log('\n' + renderQuestions(planned.ticketPlan, readyLabel, 1, 1).join('\n'));
      if (planned.status === 'needs-info') console.log('\n' + renderMissing(planned.ticketPlan, readyLabel).join('\n'));
      if (args.plan) {
        savePlanRecord(task.id, planned.text, `PREVIEW ONLY (${planned.status})`, planned);
        console.log(`\n(Plan only: nothing was locked, written or changed. Saved to .jobs/${task.id}/. To run it: npm start -- ${task.id})`);
        continue;
      }
      const sessions = new FileSessionStore(jobsDir);
      if (planned.status !== 'ready') {
        sessions.setPhase(
          task.id,
          planned.status === 'needs-input' ? 'needs_input' : planned.status === 'needs-info' ? 'needs_info' : 'needs_human',
          `CLI run: plan ${planned.status}`
        );
        savePlanRecord(task.id, planned.text, `NOT STARTED (${planned.status})`, planned);
        console.log(`\nNot started: the plan is "${planned.status}". Update the ticket and run again.`);
        failures++;
        continue;
      }
      const { approved, decision } = await askApproval(task.id, args.yes);
      console.log(`Plan decision: ${decision}  (saved to ${savePlanRecord(task.id, planned.text, decision, planned)})`);
      if (!approved) {
        sessions.setPhase(task.id, 'plan_review', `CLI run: ${decision}`);
        failures++;
        continue;
      }
      sessions.setPhase(task.id, 'coding', `CLI run: ${decision}`);
      task.metadata = {
        ...(task.metadata || {}),
        approvedPlans: planned.plans,
        approvedRepos: planned.repos,
        approvedRepoDependencies: planned.repoDependencies
      };
      const result = await createOrchestrator(providerName, { approvePlan: async () => true }).run(task);
      sessions.setPhase(task.id, result.success ? 'done' : 'needs_human', `CLI run: ${result.status}`);
      if (!reportResult(result)) failures++;
      continue;
    }

    if (args.plan) {
      const preview = await orchestrator.plan(task);
      console.log(`\n[DEDUPLICATION] ${preview.deduplication.status.toUpperCase()}: ${preview.deduplication.reason}`);
      if (!preview.impact) continue;
      if (preview.impact.affectedRepositories.length === 0) {
        console.log('[IMPACT ANALYSIS] No repository matched: the run would stop with NO_MATCHING_REPO.');
        continue;
      }
      console.log((await buildChangePlan(task, preview.impact, providerName)).text);
      console.log('\n(Plan only: nothing was locked, written or changed. To run it: npm start -- ' + task.id + ')');
      continue;
    }

    const result = await orchestrator.run(task);
    if (!reportResult(result)) failures++;
  }

  if (failures > 0) process.exitCode = 1;
}

/** Prints a pipeline result; returns whether it succeeded. */
function reportResult(result: OrchestratorResult): boolean {
  console.log(`\n--- ${result.taskId}: ${result.status} (${result.durationMs}ms) ---`);
  for (const r of result.teamResult?.repoResults ?? []) {
    console.log(`Repo [${r.repoId}] via ${r.providerUsed}: ${r.changedFiles.join(', ') || 'no changes'}`);
    console.log(`  Reasoning: ${r.reasoning}`);
  }
  for (const b of result.branches ?? []) {
    if (b.managedByGit) console.log(`Branch [${b.repoId}]: ${b.branch}${b.commit ? ` @ ${b.commit.slice(0, 10)}` : ''} (worktree ${b.workdir})`);
  }
  for (const repoTest of result.testingResult?.repoResults ?? []) {
    for (const check of repoTest.checks.filter((c) => !c.passed)) {
      const detail = (check.error || check.output || '').trim().split('\n').slice(-6).join('\n      ');
      console.log(`Verify FAILED [${repoTest.repoId}] ${check.name}:\n      ${detail}`);
    }
  }
  if (result.jobFile) console.log(`Job state: ${result.jobFile}`);
  if (!result.success && result.status !== 'DUPLICATE_SKIPPED') console.log(`Error: ${result.error}`);
  return result.success;
}

/** Prevents two watchers from processing the same tickets at once. */
function acquireWatcherLock(): (() => void) | undefined {
  fs.mkdirSync(jobsDir, { recursive: true });
  const lockFile = path.join(jobsDir, '.watcher.lock');
  const mine = JSON.stringify({ pid: process.pid, instance: PROCESS_INSTANCE, startedAt: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockFile, mine, { flag: 'wx' }); // atomic: fails if another process holds it
      return () => fs.rmSync(lockFile, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    if (!watcherLockIsStale(lockFile)) return undefined; // another watcher is alive
    fs.rmSync(lockFile, { force: true }); // stale: take over (second loop iteration)
  }
  return undefined;
}

/**
 * A watcher lock is stale when its process is gone, or when it carries OUR pid but another process
 * instance: after an unclean stop in a container the new process often gets the same pid, which
 * would otherwise look alive.
 */
export function watcherLockIsStale(lockFile: string, pid = process.pid, instance = PROCESS_INSTANCE): boolean {
  let held: { pid?: number; instance?: string };
  try {
    held = JSON.parse(fs.readFileSync(lockFile, 'utf-8')) as { pid?: number; instance?: string };
  } catch {
    return true; // unreadable or half-written: nobody can be relying on it
  }
  if (!held.pid) return true;
  if (held.pid === pid) return held.instance !== instance;
  try {
    process.kill(held.pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** Ctrl+C (SIGINT) and service-manager stops (SIGTERM from systemd, docker, k8s) end runs the same way. */
function onStopSignal(handler: () => void): void {
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

/** The label-driven automation (shared by the poller and the webhook server). */
function createWatcher(args: CliArgs, providerName: string) {
  const labels: WatcherLabels = {
    ready: process.env.LABEL_READY || DEFAULT_LABELS.ready,
    approved: process.env.LABEL_APPROVED || DEFAULT_LABELS.approved
  };
  const project = process.env.AUTOMATION_PROJECT || 'T2';
  const jql =
    process.env.AUTOMATION_JQL ||
    `project = ${project} AND labels in ("${labels.ready}", "${labels.approved}") AND statusCategory != Done ORDER BY updated ASC`;
  const store = new JobStore({ jobsDir });
  const jira = makeJira();
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${redactSecrets(m)}`);

  const watcher = new AutomationWatcher(
    {
      jql,
      labels,
      autoApprove: process.env.AUTO_APPROVE_PLAN === 'true',
      maxAttempts: Number(process.env.AUTOMATION_MAX_ATTEMPTS) || 3,
      maxQuestionRounds: Number(process.env.AUTOMATION_MAX_QUESTION_ROUNDS) || pipelineConfig().planning.maxQuestionRounds,
      maxPlanRevisions: pipelineConfig().planning.maxPlanRevisions,
      assignToReporter: intakeFor(pipelineConfig(), `${project}-0`).assignToReporter,
      // Existing workflow statuses per phase (config/pipeline.yaml → jira), read fresh each time.
      statusForPhase: (ticket, phase) => {
        const cfg = pipelineConfig().jira;
        return cfg.moveStatus ? cfg.phaseStatus[ticket.split('-')[0]]?.[phase] : undefined;
      },
      dryRun: args.dryRun
    },
    {
      jira,
      jobsDir,
      log,
      attempts: (id) => store.read(id)?.attempt ?? 0,
      killSwitch,
      async plan(task): Promise<PlanOutcome> {
        try {
          const preview = await createOrchestrator(providerName).plan(task);
          if (preview.deduplication.status === 'duplicate') {
            return { status: 'duplicate', reason: preview.deduplication.reason, repos: [], plans: {}, text: '' };
          }
          if (providerName === 'claude-code') {
            // The Planning Agent chooses repos itself; keyword routing is only a hint.
            const planned = await buildTicketPlan(task, preview.impact?.affectedRepositories ?? [], providerName);
            const base = {
              repos: planned.repos,
              plans: planned.plans,
              text: planned.text,
              ticketPlan: planned.ticketPlan,
              repoDependencies: planned.repoDependencies,
              promptVersion: planned.promptVersion,
              costUsd: planned.costUsd,
              repoFacts: planned.repoFacts
            };
            if (planned.status === 'invalid') return { ...base, status: 'error', reason: `The plan has problems: ${planned.problems.join(' ')}` };
            return { ...base, status: planned.status };
          }
          if (!preview.impact || preview.impact.affectedRepositories.length === 0) {
            return { status: 'no-repo', repos: [], plans: {}, text: '' };
          }
          const changePlan = await buildChangePlan(task, preview.impact, providerName);
          const missing = preview.impact.affectedRepositories.filter((r) => !changePlan.plans[r]);
          if (providerName === 'claude-code' && missing.length > 0) {
            return { status: 'error', reason: `Claude Code could not draft a plan for: ${missing.join(', ')}`, repos: [], plans: {}, text: changePlan.text };
          }
          return { status: 'ready', repos: preview.impact.affectedRepositories, plans: changePlan.plans, text: changePlan.text };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          // Usage/rate limits and overload are temporary: keep the trigger and try again next cycle.
          const status = err instanceof PlanningRunError && err.temporary ? 'retry-later' : 'error';
          return { status, reason, repos: [], plans: {}, text: '' };
        }
      },
      implement: (task) => createOrchestrator(providerName, { approvePlan: async () => true }).run(task),
      async publish(task, result, plan) {
        const catalog = loadCatalog();
        const bitbucket = new BitbucketClient();
        const links: PullRequestLink[] = [];
        const skipped: string[] = [];
        for (const repo of result.teamResult?.repoResults ?? []) {
          const branch = result.branches?.find((b) => b.repoId === repo.repoId);
          const entry = catalog?.get(repo.repoId);
          if (!branch || !branch.managedByGit || !branch.branch) {
            skipped.push(`${repo.repoId}: not a git clone, changes were applied in place${branch ? ` at ${branch.workdir}` : ''}`);
          } else if (!branch.commit) {
            skipped.push(`${repo.repoId}: nothing to commit`);
          } else if (!entry?.bitbucket || !entry.baseBranch) {
            skipped.push(`${repo.repoId}: set bitbucket + baseBranch in catalog/repos.yaml to open PRs (branch ${branch.branch} is committed locally)`);
          } else if (!bitbucket.configured) {
            skipped.push(`${repo.repoId}: Bitbucket credentials not set (BITBUCKET_TOKEN, or BITBUCKET_EMAIL + BITBUCKET_API_TOKEN); branch ${branch.branch} is committed locally`);
          } else {
            await bitbucket.pushBranch(branch.workdir, branch.branch, entry.bitbucket);
            const pr = await bitbucket.createPullRequest({
              ...entry.bitbucket,
              sourceBranch: branch.branch,
              destinationBranch: entry.baseBranch,
              title: `${task.id}: ${task.title}`,
              description: buildPrDescription(task, result, plan, repo.repoId)
            });
            links.push({ repoId: repo.repoId, url: pr.url, existing: pr.existing });
          }
        }
        const job = store.read(task.id);
        if (job && links.length) {
          job.pullRequests = links;
          store.write(job);
        }
        return { links, skipped };
      }
    }
  );
  return { watcher, jql, labels };
}

/**
 * Webhook mode: Jira pushes "ticket changed" events; each ticket is re-read from Jira and run
 * through the same label-driven automation as the poller. A slow JQL poll catches missed events.
 */
async function runWebhook(args: CliArgs, providerName: string): Promise<void> {
  const release = acquireWatcherLock();
  if (!release) {
    console.error(`A watcher or webhook server is already running (see ${path.join(jobsDir, '.watcher.lock')}).`);
    process.exitCode = 1;
    return;
  }
  const { watcher, jql, labels } = createWatcher({ ...args, dryRun: false }, providerName);
  const jira = makeJira();
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${redactSecrets(m)}`);
  const reconcileMin = Number(process.env.WEBHOOK_RECONCILE_MINUTES ?? 15);
  const projects = (process.env.WEBHOOK_PROJECTS || process.env.AUTOMATION_PROJECT || 'T2')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  try {
    const server = await startWebhookServer({
      secret: process.env.JIRA_WEBHOOK_SECRET || '',
      port: Number(process.env.WEBHOOK_PORT) || 8080,
      host: process.env.WEBHOOK_HOST || '0.0.0.0',
      projects,
      log,
      process: async (key) => {
        const { action, detail } = await watcher.runTicket(key);
        return `${action}${detail ? ` (${detail})` : ''}`;
      },
      reconcile: async () => (await jira.searchTasks(jql, 50)).map((t) => t.id),
      reconcileIntervalMs: reconcileMin > 0 ? reconcileMin * 60 * 1000 : 0
    });
    console.log(`Webhook server listening on port ${server.port}: POST /webhooks/jira  (health: GET /healthz)`);
    console.log(`Projects: ${projects.join(', ')} | triggers: labels "${labels.ready}" / "${labels.approved}" | AI: ${providerName}`);
    console.log(reconcileMin > 0 ? `Safety-net poll every ${reconcileMin} min: ${jql}` : 'Safety-net poll disabled.');

    await new Promise<void>((resolve) => {
      let stopping = false;
      onStopSignal(() => {
        if (stopping) process.exit(130);
        stopping = true;
        console.log('\nStopping: no new events; finishing the ticket in progress (Ctrl+C again to force).');
        void server.close().then(resolve);
      });
    });
  } finally {
    release();
  }
}

async function runWatch(args: CliArgs, providerName: string): Promise<void> {
  const release = args.dryRun ? () => {} : acquireWatcherLock();
  if (!release) {
    console.error(`Another watcher is already running (see ${path.join(jobsDir, '.watcher.lock')}).`);
    process.exitCode = 1;
    return;
  }

  const { watcher, jql, labels } = createWatcher(args, providerName);

  console.log(`Watching Jira with: ${jql}`);
  console.log(`AI: ${providerName} | approval: ${process.env.AUTO_APPROVE_PLAN === 'true' ? 'AUTO (no human gate)' : `label "${labels.approved}"`}${args.dryRun ? ' | DRY RUN (no Jira writes, no AI runs)' : ''}`);
  try {
    if (args.once || args.dryRun) {
      const report = await watcher.runOnce();
      console.log(`Checked ${report.checked} ticket(s).`);
      for (const a of report.actions) console.log(`  ${a.ticket}: ${a.action}${a.detail ? ` (${a.detail})` : ''}`);
      return;
    }
    let stopping = false;
    onStopSignal(() => {
      if (stopping) process.exit(130);
      stopping = true;
      console.log('\nStopping after the current cycle (Ctrl+C again to force).');
    });
    console.log(`Polling every ${args.interval}s. Ctrl+C to stop.`);
    await watcher.start(args.interval * 1000, () => stopping);
  } finally {
    release();
  }
}

/**
 * `npm start --T2-547` (no space after --) is swallowed by npm as its own config flag and the
 * script receives no arguments. npm exposes it as npm_config_t2_547; detect that and stop.
 */
function ticketSwallowedByNpm(): string | undefined {
  for (const key of Object.keys(process.env)) {
    const m = /^npm_config_([a-z][a-z0-9]*)_(\d+)$/i.exec(key);
    if (m) return `${m[1].toUpperCase()}-${m[2]}`;
  }
  return undefined;
}

async function main() {
  const swallowed = ticketSwallowedByNpm();
  if (swallowed && process.argv.slice(2).length === 0) {
    console.error(`npm took "--${swallowed}" as its own option, so the ticket never reached the orchestrator.`);
    console.error(`Put a space after "--":   npm start -- ${swallowed}`);
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (args.sessions) {
    const sessions = new FileSessionStore(jobsDir).list();
    if (!sessions.length) console.log('No sessions yet.');
    for (const s of sessions) console.log(`${s.ticket.padEnd(10)} ${s.phase.padEnd(12)} ${s.updatedAt}  ${s.detail ?? ''}`.slice(0, 160));
    return;
  }
  if (args.status || args.unlock) {
    const store = new JobStore({ jobsDir });
    if (args.unlock) {
      const outcome = store.forceUnlock(args.unlock);
      console.log(
        outcome === 'removed'
          ? `Lock removed for ${args.unlock}.`
          : outcome === 'active'
            ? `${args.unlock} is locked by a run that is still active; not removing it.`
            : `No lock found for ${args.unlock}.`
      );
      return;
    }
    const session = new FileSessionStore(jobsDir).get(args.status!);
    if (session) {
      console.log(`${session.ticket}: phase ${session.phase}${session.detail ? ` (${session.detail})` : ''}, updated ${session.updatedAt}`);
      for (const h of session.history.slice(-10)) console.log(`  ${h.at}  ${h.phase}${h.detail ? ` — ${h.detail.slice(0, 120)}` : ''}`);
    }
    const job = store.read(args.status!);
    if (!job) {
      if (!session) console.log(`No session or job found for ${args.status}.`);
      return;
    }
    const lock = store.readLock(job.ticketId);
    console.log(`${job.ticketId}: ${job.title}`);
    console.log(`Status: ${job.status} | attempt ${job.attempt} | started ${job.startedAt}${lock ? ` | LOCKED by pid ${lock.pid}` : ''}`);
    for (const st of job.stages) console.log(`  ${st.status.padEnd(7)} ${st.name}${st.detail ? ` — ${st.detail.slice(0, 120)}` : ''}`);
    for (const r of job.repos) console.log(`  repo ${r.repoId}: ${r.branch ? `${r.branch}${r.commit ? ` @ ${r.commit.slice(0, 10)}` : ''}` : 'in place'} (${r.workdir})`);
    if (job.error) console.log(`Error: ${job.error}`);
    for (const pr of job.pullRequests || []) console.log(`  PR ${pr.repoId}: ${pr.url}${pr.existing ? ' (existing)' : ''}`);
    for (const h of job.history || []) {
      const repos = h.repos.map((r) => `${r.repoId}${r.branch ? `:${r.branch}${r.commit ? `@${r.commit.slice(0, 10)}` : ''}` : ''}`).join(', ');
      console.log(`  earlier attempt ${h.attempt}: ${h.status} (${h.startedAt})${repos ? ` [${repos}]` : ''}`);
    }
    console.log(`File: ${store.jobPath(job.ticketId)}`);
    return;
  }

  console.log('='.repeat(60));
  console.log('   LOCAL AI DEVELOPMENT ORCHESTRATOR POC');
  console.log('='.repeat(60));

  // --provider on the command line wins over AI_PROVIDER in the environment / .env
  const providerName = (args.provider || process.env.AI_PROVIDER || 'claude-code').toLowerCase();
  console.log(`Active AI Provider: ${providerName.toUpperCase()}`);
  console.log(`Repositories Path:  ${repoRoot}`);
  console.log('='.repeat(60));

  if (args.webhook) {
    await runWebhook(args, providerName);
    return;
  }
  if (args.watch) {
    await runWatch(args, providerName);
    return;
  }

  if (args.keys.length > 0 || args.jql) {
    // Jira runs stop for human approval after impact analysis (unless --yes).
    const gated = !args.dryRun && !args.plan;
    const orchestrator = createOrchestrator(
      providerName,
      gated ? { approvePlan: makeApprovalGate(providerName, args.yes) } : {}
    );
    await runJiraTasks(orchestrator, args, providerName);
    return;
  }

  // The sample demo writes into repositories/repo-a. With a real AI that costs usage and edits
  // files, so it only runs when asked for explicitly.
  if (providerName !== 'mock' && !args.demo) {
    console.log(`No ticket given. Nothing was run.\n`);
    printUsage();
    console.log(`\nTo run the PAY-101 sample demo with ${providerName}: npm start -- --demo   (offline: npm start -- --demo --provider mock)`);
    return;
  }

  // The demo runs on the dummy sample repos, never on the real catalog.
  catalogPath = sampleCatalogPath;
  const orchestrator = createOrchestrator(providerName);

  const sampleTask: TaskInput = {
    id: 'PAY-101',
    title: 'Add health endpoint',
    description: 'Add GET /health endpoint to the payment service',
    acceptanceCriteria: [
      'GET /health returns HTTP 200',
      'Response contains status UP'
    ]
  };

  console.log('\n>>> RUNNING SCENARIO 1: New Development Task (PAY-101)');
  const result1 = await orchestrator.run(sampleTask);

  console.log('\n--- Summary Report (Scenario 1) ---');
  console.log(`Task ID:  ${result1.taskId}`);
  console.log(`Status:   ${result1.status}`);
  console.log(`Success:  ${result1.success}`);
  console.log(`Duration: ${result1.durationMs}ms`);
  if (result1.teamResult?.repoResults) {
    for (const r of result1.teamResult.repoResults) {
      console.log(`Repo [${r.repoId}]: ${r.changedFiles.length} file(s) modified (${r.changedFiles.join(', ')})`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('>>> RUNNING SCENARIO 2: Duplicate Task Submission (Deduplication Check)');
  console.log('='.repeat(60));
  const result2 = await orchestrator.run(sampleTask);

  console.log('\n--- Summary Report (Scenario 2) ---');
  console.log(`Task ID:  ${result2.taskId}`);
  console.log(`Status:   ${result2.status}`);
  console.log(`Success:  ${result2.success}`);
  console.log(`Reason:   ${result2.deduplication?.reason}`);
  console.log('='.repeat(60));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('Fatal orchestrator error:', err);
    process.exit(1);
  });
}

