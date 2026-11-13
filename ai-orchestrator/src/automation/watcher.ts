import fs from 'node:fs';
import path from 'node:path';
import type { OrchestratorResult, TaskInput } from '../models/types.js';
import type { ImplementationPlan } from '../providers/claude-code-provider.js';
import type { CodingReport } from '../agents/coding/coding-agent.js';

/** Jira labels that drive the automation (configurable via env). */
export interface WatcherLabels {
  ready: string; // human: "please pick this up"
  planPending: string; // bot: plan posted, waiting for approval
  approved: string; // human: "plan approved, implement it"
  inProgress: string; // bot: implementing now
  prRaised: string; // bot: PR opened
  done: string; // bot: implemented, no PR (repo is not a git clone)
  needsHuman: string; // bot: stopped, a person must look
}

export const DEFAULT_LABELS: WatcherLabels = {
  ready: 'ai-ready',
  planPending: 'ai-plan-pending',
  approved: 'ai-approved',
  inProgress: 'ai-in-progress',
  prRaised: 'ai-pr-raised',
  done: 'ai-done',
  needsHuman: 'ai-needs-human'
};

export interface WatcherConfig {
  /** Which tickets to look at. Must include the ready + approved labels. */
  jql: string;
  labels: WatcherLabels;
  /** Skip the human approval step (not recommended). */
  autoApprove: boolean;
  /** Stop after this many implementation attempts per ticket. */
  maxAttempts: number;
  /** Optional Jira status names to move tickets to (skipped if unset or not in the workflow). */
  statusInProgress?: string;
  statusInReview?: string;
  /** Report what would happen; no Jira writes, no AI runs. */
  dryRun: boolean;
  /** Text in the ticket summary that also means "ready" (for create forms without a Labels field). */
  summaryTag?: string;
  /** Comment commands that approve / reject a posted plan (alternative to the approval label). */
  approveCommand?: string;
  rejectCommand?: string;
  /** Comment command that re-runs a stopped (needs-human) ticket with its already approved plan. */
  retryCommand?: string;
}

/** Result of the planning phase for one ticket. */
export interface PlanOutcome {
  status: 'ready' | 'duplicate' | 'no-repo' | 'error';
  reason?: string;
  repos: string[];
  plans: Record<string, ImplementationPlan>;
  text: string;
}

export interface PullRequestLink {
  repoId: string;
  url: string;
  existing: boolean;
}

export interface SavedPlan {
  ticketId: string;
  createdAt: string;
  repos: string[];
  plans: Record<string, ImplementationPlan>;
  text: string;
  approvedBy?: string;
  approvedAt?: string;
}

export interface WatcherJira {
  searchTasks(jql: string, maxResults?: number): Promise<TaskInput[]>;
  getTask(key: string): Promise<TaskInput>;
  addComment(key: string, lines: string[], preformatted?: string): Promise<void>;
  updateLabels(key: string, add?: string[], remove?: string[]): Promise<void>;
  transition(key: string, statusName: string): Promise<boolean>;
  getLabelAdder(key: string, label: string): Promise<string | undefined>;
}

export interface WatcherDeps {
  jira: WatcherJira;
  /** Dedup + impact + read-only change plan. */
  plan(task: TaskInput): Promise<PlanOutcome>;
  /** Full pipeline with the plan already approved. */
  implement(task: TaskInput): Promise<OrchestratorResult>;
  /** Push + open PRs for committed ticket branches (may return [] when no repo is a git clone). */
  publish(task: TaskInput, result: OrchestratorResult, plan: SavedPlan): Promise<{ links: PullRequestLink[]; skipped: string[] }>;
  /** Implementation attempts already made for this ticket (from the job record). */
  attempts(ticketId: string): number;
  jobsDir: string;
  log(message: string): void;
}

export type TicketAction =
  | 'planned'
  | 'implemented-pr'
  | 'implemented-no-pr'
  | 'duplicate'
  | 'no-repo'
  | 'failed'
  | 'waiting-approval'
  | 'retry-limit'
  | 'rejected'
  | 'skipped';

export interface CycleReport {
  checked: number;
  actions: Array<{ ticket: string; action: TicketAction; detail?: string }>;
}

const BOT = '🤖 AI Orchestrator';

/**
 * AutomationWatcher
 *
 * Polls Jira and moves each labelled ticket through the pipeline:
 *
 *   ai-ready ──► plan (dedup → impact → Claude Code change plan) ──► comment + ai-plan-pending
 *   ai-approved ──► implement (tests first → code → verify) ──► commit → push → PR ──► comment + ai-pr-raised
 *   any failure ──► comment with the reason + ai-needs-human
 *
 * Labels are the only trigger (comments are ignored), so the bot never reacts to itself.
 */
export class AutomationWatcher {
  constructor(private config: WatcherConfig, private deps: WatcherDeps) {}

  private planFile(ticketId: string): string {
    return path.join(this.deps.jobsDir, ticketId.replace(/[^A-Za-z0-9._-]/g, '_'), 'plan.json');
  }

  readPlan(ticketId: string): SavedPlan | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.planFile(ticketId), 'utf-8')) as SavedPlan;
    } catch {
      return undefined;
    }
  }

  private savePlan(plan: SavedPlan): void {
    const file = this.planFile(plan.ticketId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(plan, null, 2));
    fs.writeFileSync(
      path.join(path.dirname(file), 'plan.md'),
      `# Change plan ${plan.ticketId}\n\n\`\`\`\n${plan.text.trim()}\n\`\`\`\n\n` +
        (plan.approvedBy || plan.approvedAt
          ? `**Decision:** APPROVED by ${plan.approvedBy ?? 'unknown'} at ${plan.approvedAt}\n`
          : '**Decision:** pending approval\n')
    );
  }

  private hasLabel(task: TaskInput, label: string): boolean {
    const labels = task.metadata?.labels;
    return Array.isArray(labels) && labels.includes(label);
  }

  // Jira writes are no-ops in dry-run mode.
  private async comment(key: string, lines: string[], pre?: string) {
    if (!this.config.dryRun) await this.deps.jira.addComment(key, [BOT, ...lines], pre);
  }
  private async labels(key: string, add: string[], remove: string[]) {
    if (!this.config.dryRun) await this.deps.jira.updateLabels(key, add, remove);
  }
  private async move(key: string, status?: string) {
    if (!status || this.config.dryRun) return;
    try {
      const moved = await this.deps.jira.transition(key, status);
      if (!moved) this.deps.log(`${key}: workflow has no transition to "${status}" from its current status; left as is.`);
    } catch (err) {
      this.deps.log(`${key}: status change to "${status}" failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Labels the bot sets once it has started on a ticket (the summary tag is ignored after that). */
  private hasBotState(task: TaskInput): boolean {
    const L = this.config.labels;
    return [L.planPending, L.approved, L.inProgress, L.prRaised, L.done, L.needsHuman].some((l) => this.hasLabel(task, l));
  }

  private hasSummaryTag(task: TaskInput): boolean {
    const tag = this.config.summaryTag?.trim().toLowerCase();
    if (!tag) return false;
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9])\\[?${escaped}\\]?(?![a-z0-9])`, 'i').test(task.title);
  }

  /**
   * A human comment posted after the plan that starts with the approve/reject command.
   * Bot comments are ignored; the latest matching command wins.
   */
  private planDecisionFromComments(task: TaskInput, planCreatedAt: string): { decision: 'approve' | 'reject'; by: string } | undefined {
    const approve = (this.config.approveCommand || '').trim().toLowerCase();
    const reject = (this.config.rejectCommand || '').trim().toLowerCase();
    if (!approve && !reject) return undefined;
    const since = Date.parse(planCreatedAt);
    const comments = (task.metadata?.comments as Array<{ author: string; created: string; body: string }>) || [];
    let found: { decision: 'approve' | 'reject'; by: string; at: number } | undefined;
    for (const c of comments) {
      const body = (c.body || '').trim();
      if (body.startsWith(BOT)) continue;
      const at = parseJiraDate(c.created);
      if (!(at > since)) continue;
      const first = body.toLowerCase();
      const decision = approve && first.startsWith(approve) ? 'approve' : reject && first.startsWith(reject) ? 'reject' : undefined;
      if (decision && (!found || at >= found.at)) found = { decision, by: c.author || 'unknown', at };
    }
    return found ? { decision: found.decision, by: found.by } : undefined;
  }

  /** Who asked for a retry: a human comment starting with the retry command, posted after the bot's latest comment. */
  private retryRequestedBy(task: TaskInput): string | undefined {
    const command = (this.config.retryCommand || '').trim().toLowerCase();
    if (!command) return undefined;
    const comments = (task.metadata?.comments as Array<{ author: string; created: string; body: string }>) || [];
    const lastBot = Math.max(0, ...comments.filter((c) => (c.body || '').trim().startsWith(BOT)).map((c) => parseJiraDate(c.created) || 0));
    const request = comments
      .filter((c) => !(c.body || '').trim().startsWith(BOT) && (c.body || '').trim().toLowerCase().startsWith(command))
      .filter((c) => parseJiraDate(c.created) > lastBot)
      .pop();
    return request ? request.author || 'unknown' : undefined;
  }

  private async dispatch(task: TaskInput): Promise<TicketAction> {
    const L = this.config.labels;
    if (this.hasLabel(task, L.approved)) return this.handleApproved(task);

    // Stopped ticket + "/retry" comment: run the implementation again with the approved plan.
    if (this.hasLabel(task, L.needsHuman)) {
      const by = this.retryRequestedBy(task);
      if (!by) return 'skipped';
      if (!this.readPlan(task.id)) {
        this.deps.log(`${task.id}: retry requested by ${by}, but there is no approved plan on record`);
        if (!this.config.dryRun) {
          await this.labels(task.id, [L.ready], [L.needsHuman]);
          await this.comment(task.id, [`Retry requested by ${by}, but no change plan is on record: drafting a new plan for approval.`]);
        }
        return this.config.dryRun ? 'planned' : this.handleReady(task);
      }
      this.deps.log(`${task.id}: retry requested by ${by} → implementing the approved plan again`);
      if (this.config.dryRun) return 'implemented-no-pr';
      await this.labels(task.id, [L.approved], [L.needsHuman]);
      return this.handleApproved(task);
    }

    if (this.hasLabel(task, L.planPending)) {
      const plan = this.readPlan(task.id);
      const decision = plan ? this.planDecisionFromComments(task, plan.createdAt) : undefined;
      if (!plan || !decision) return 'waiting-approval';
      if (decision.decision === 'reject') {
        this.deps.log(`${task.id}: plan rejected by ${decision.by}`);
        if (this.config.dryRun) return 'rejected';
        await this.labels(task.id, [L.needsHuman], [L.planPending]);
        await this.comment(task.id, [`Plan rejected by ${decision.by}. Nothing was changed. Update the ticket and put "${L.ready}" back to plan again.`]);
        return 'rejected';
      }
      this.deps.log(`${task.id}: plan approved by comment from ${decision.by}`);
      if (!this.config.dryRun) {
        plan.approvedBy = decision.by;
        plan.approvedAt = new Date().toISOString();
        this.savePlan(plan);
        await this.labels(task.id, [L.approved], []);
      }
      return this.handleApproved(task);
    }

    if (this.hasLabel(task, L.ready)) return this.handleReady(task);

    if (this.hasSummaryTag(task) && !this.hasBotState(task)) {
      this.deps.log(`${task.id}: "${this.config.summaryTag}" found in the summary → treating as ${L.ready}`);
      if (!this.config.dryRun) await this.labels(task.id, [L.ready], []);
      return this.handleReady(task);
    }
    return 'skipped';
  }

  /** One polling cycle. */
  async runOnce(): Promise<CycleReport> {
    const L = this.config.labels;
    const report: CycleReport = { checked: 0, actions: [] };
    const tasks = await this.deps.jira.searchTasks(this.config.jql, 50);
    report.checked = tasks.length;

    for (const task of tasks) {
      try {
        const action = await this.dispatch(task);
        report.actions.push({ ticket: task.id, action });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.log(`${task.id}: unexpected error: ${message}`);
        report.actions.push({ ticket: task.id, action: 'failed', detail: message });
        await this.comment(task.id, ['Stopped because of an unexpected error. A person needs to look at this.', `Error: ${message}`]).catch(() => {});
        await this.labels(task.id, [L.needsHuman], [L.ready, L.approved, L.inProgress]).catch(() => {});
      }
    }
    return report;
  }

  /** ai-ready: dedup → impact → change plan → Jira comment → waiting for approval. */
  private async handleReady(task: TaskInput): Promise<TicketAction> {
    const L = this.config.labels;
    this.deps.log(`${task.id}: picked up (${L.ready}) → planning`);
    if (this.config.dryRun) return 'planned';

    const outcome = await this.deps.plan(task);

    if (outcome.status === 'duplicate') {
      await this.comment(task.id, ['Not started: this looks like work that is already done.', `Reason: ${outcome.reason ?? '-'}`]);
      await this.labels(task.id, [L.needsHuman], [L.ready]);
      return 'duplicate';
    }
    if (outcome.status === 'no-repo') {
      await this.comment(task.id, [
        'Not started: no repository matched this ticket.',
        ...(outcome.reason ? [`Reason: ${outcome.reason}`] : []),
        'Add a label/component for the target repo, or add the repo to catalog/repos.yaml, then put the ai-ready label back.'
      ]);
      await this.labels(task.id, [L.needsHuman], [L.ready]);
      return 'no-repo';
    }
    if (outcome.status === 'error') {
      await this.comment(task.id, ['Planning failed. A person needs to look at this.', `Error: ${outcome.reason ?? '-'}`]);
      await this.labels(task.id, [L.needsHuman], [L.ready]);
      return 'failed';
    }

    const saved: SavedPlan = {
      ticketId: task.id,
      createdAt: new Date().toISOString(),
      repos: outcome.repos,
      plans: outcome.plans,
      text: outcome.text
    };

    if (this.config.autoApprove) {
      saved.approvedBy = 'auto (AUTO_APPROVE_PLAN=true)';
      saved.approvedAt = new Date().toISOString();
      this.savePlan(saved);
      await this.comment(task.id, ['Change plan (auto-approved, implementation starts now):'], outcome.text);
      await this.labels(task.id, [L.approved], [L.ready]);
      task.metadata = { ...(task.metadata || {}), labels: [L.approved] };
      return this.handleApproved(task);
    }

    this.savePlan(saved);
    await this.comment(
      task.id,
      [
        `Change plan for ${task.id} is ready for review. Repos: ${outcome.repos.join(', ')}.`,
        this.config.approveCommand
          ? `To approve: comment "${this.config.approveCommand}" (or add the label "${L.approved}"). To reject: comment "${this.config.rejectCommand ?? '/reject'}".`
          : `To approve: add the label "${L.approved}". To reject: remove "${L.planPending}" (optionally comment why).`,
        'Nothing has been changed yet.'
      ],
      outcome.text
    );
    await this.labels(task.id, [L.planPending], [L.ready]);
    return 'planned';
  }

  /** ai-approved: implement the approved plan → verify → commit → PR → Jira comment. */
  private async handleApproved(task: TaskInput): Promise<TicketAction> {
    const L = this.config.labels;
    const plan = this.readPlan(task.id);

    if (!plan) {
      // Approval without a plan on record: plan first, the approval must come after the plan.
      this.deps.log(`${task.id}: "${L.approved}" found but no plan on record → planning first`);
      if (this.config.dryRun) return 'planned';
      await this.labels(task.id, [], [L.approved]);
      await this.comment(task.id, [`"${L.approved}" was added before a change plan existed. Drafting the plan first; approve it once you have reviewed it.`]);
      return this.handleReady(task);
    }

    const attempts = this.deps.attempts(task.id);
    if (attempts >= this.config.maxAttempts) {
      this.deps.log(`${task.id}: retry limit reached (${attempts}/${this.config.maxAttempts})`);
      if (this.config.dryRun) return 'retry-limit';
      await this.comment(task.id, [
        `Not started: ${attempts} implementation attempts already made (limit ${this.config.maxAttempts}). Handing over to a person.`
      ]);
      await this.labels(task.id, [L.needsHuman], [L.approved, L.planPending]);
      return 'retry-limit';
    }

    this.deps.log(`${task.id}: approved → implementing (attempt ${attempts + 1}/${this.config.maxAttempts})`);
    if (this.config.dryRun) return 'implemented-no-pr';

    if (!plan.approvedAt) {
      plan.approvedBy = (await this.deps.jira.getLabelAdder(task.id, L.approved).catch(() => undefined)) || 'unknown';
      plan.approvedAt = new Date().toISOString();
      this.savePlan(plan);
    }

    await this.labels(task.id, [L.inProgress], [L.approved, L.planPending, L.needsHuman]);
    await this.move(task.id, this.config.statusInProgress);
    await this.comment(task.id, [
      `Plan approved by ${plan.approvedBy}. Implementation started: tests first, then the code, then the repo's verify steps.`
    ]);

    // Fresh ticket data (description/comments may have changed), carrying the approved plan.
    const fresh = await this.deps.jira.getTask(task.id);
    fresh.metadata = { ...(fresh.metadata || {}), approvedPlans: plan.plans };
    const result = await this.deps.implement(fresh);

    const changed = (result.teamResult?.repoResults ?? []).map((r) => `${r.repoId}: ${r.changedFiles.join(', ') || 'no file changes'}`);
    const verify = (result.testingResult?.repoResults ?? []).flatMap((r) =>
      r.checks.filter((c) => c.name !== 'directory-exists').map((c) => `${r.repoId} ${c.name}: ${c.passed ? 'passed' : 'FAILED'}`)
    );

    if (!result.success) {
      const failedCheck = (result.testingResult?.repoResults ?? [])
        .flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => `${r.repoId} ${c.name}:\n${(c.error || c.output || '').trim().split('\n').slice(-15).join('\n')}`))
        .join('\n\n');
      await this.comment(
        task.id,
        [`Implementation stopped: ${result.status}.`, `Reason: ${result.error ?? '-'}`, ...(verify.length ? ['Verify:', ...verify] : []), `A person needs to look at this. To retry with the same approved plan, comment "${this.config.retryCommand || '/retry'}" (or add the label "${L.approved}").`],
        failedCheck || undefined
      );
      await this.labels(task.id, [L.needsHuman], [L.inProgress]);
      return 'failed';
    }

    // How each repo's change was tested and reviewed (from the coding agent's report of this run).
    const quality = (result.teamResult?.repoResults ?? []).flatMap((r) => {
      const report = readCodingReport(this.deps.jobsDir, result, task.id, r.repoId);
      return report ? [`How ${r.repoId} was tested and reviewed:`, ...qualitySummary(report, false)] : [];
    });

    const { links, skipped } = await this.deps.publish(fresh, result, plan);
    if (links.length > 0) {
      await this.comment(task.id, [
        'Implementation verified and pull request(s) opened. A reviewer must approve and merge; nothing is merged or deployed automatically.',
        ...links.map((l) => `PR (${l.repoId})${l.existing ? ' [updated existing]' : ''}: ${l.url}`),
        'Changed files:',
        ...changed,
        ...quality,
        'Verify (re-run after applying):',
        ...verify
      ]);
      await this.labels(task.id, [L.prRaised], [L.inProgress]);
      await this.move(task.id, this.config.statusInReview);
      return 'implemented-pr';
    }

    await this.comment(task.id, [
      'Implementation verified. No pull request was opened:',
      ...skipped,
      'Changed files:',
      ...changed,
      ...quality,
      'Verify (re-run after applying):',
      ...verify
    ]);
    await this.labels(task.id, [L.done], [L.inProgress]);
    return 'implemented-no-pr';
  }

  /** Polls until stopped (Ctrl+C). */
  async start(intervalMs: number, shouldStop: () => boolean = () => false): Promise<void> {
    while (!shouldStop()) {
      const started = Date.now();
      try {
        const report = await this.runOnce();
        const acted = report.actions.filter((a) => a.action !== 'skipped');
        this.deps.log(
          `cycle done: ${report.checked} ticket(s) checked${acted.length ? `, ${acted.map((a) => `${a.ticket}=${a.action}`).join(', ')}` : ', nothing to do'}`
        );
      } catch (err) {
        this.deps.log(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const wait = Math.max(0, intervalMs - (Date.now() - started));
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** Markdown PR description: ticket, approved plan, verify results. */
/**
 * The coding agent's report for one repo of THIS run (.jobs/<ticket>/coding-<repo>.json).
 * Only used when the coding agent actually produced this run's change, so a stale report from an
 * earlier run (e.g. with another provider) is never shown.
 */
export function readCodingReport(jobsDir: string, result: OrchestratorResult, ticketId: string, repoId: string): CodingReport | undefined {
  const repo = result.teamResult?.repoResults.find((r) => r.repoId === repoId);
  if (!repo || repo.providerUsed !== 'coding-agent') return undefined;
  try {
    const file = path.join(jobsDir, ticketId.replace(/[^A-Za-z0-9._-]/g, '_'), `coding-${repoId}.json`);
    const report = JSON.parse(fs.readFileSync(file, 'utf-8')) as CodingReport;
    return report.status === 'ready_for_pr' ? report : undefined;
  } catch {
    return undefined;
  }
}

const testName = (evidence: string) => evidence.split(' › ').pop() ?? evidence;

/** How the change was tested and reviewed. markdown=true for PR descriptions, false for Jira comments. */
export function qualitySummary(r: CodingReport, markdown: boolean): string[] {
  const code = (s: string) => (markdown ? `\`${s}\`` : s);
  const bold = (s: string) => (markdown ? `**${s}**` : s);
  const tf = r.testsFirst;
  const blocking = r.review.findings.filter((f) => f.severity !== 'minor');
  const notes = r.review.findings.map(
    (f) => `- [${f.severity}] ${f.file ? `${code(`${f.file}${f.line ? `:${f.line}` : ''}`)} ` : ''}${f.issue}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ''}`
  );
  const lines = [
    `${bold('1. Tests written first:')} ${tf.files.length} test file(s), written before the code and ${tf.failedBeforeChange ? 'FAILING on the old code (proves they test the change)' : 'not proven to fail on the old code'}: ${tf.files.map(code).join(', ')}`,
    `${bold('2. Acceptance criteria → tests:')}`,
    ...r.acceptanceCriteria.map(
      (a) =>
        `- ${a.status === 'met' ? '✅' : '⚠️'} ${a.id} ${a.status}${a.evidence.length ? `: ${a.evidence.slice(0, 2).map((e) => code(testName(e))).join(', ')}${a.evidence.length > 2 ? ` (+${a.evidence.length - 2} more)` : ''}` : ''}`
    ),
    `${bold('3. Checks run by the pipeline itself:')} ${r.checks.map((c) => `${c.passed ? '✅' : '❌'} ${c.name}`).join(' · ')}`,
    `${bold('4. Independent AI review')} (fresh session, read-only, saw the ticket, plan, diff and check results): ${r.review.verdict === 'approve' || blocking.length === 0 ? 'APPROVED' : r.review.verdict.toUpperCase()} after ${r.review.rounds} round(s)${r.review.findings.length ? `, ${r.review.findings.length} note(s)${blocking.length ? '' : ' (non-blocking)'}:` : ', no findings.'}`,
    ...notes,
    `${bold('Fix rounds:')} ${r.fixRounds.length === 0 ? 'none needed' : r.fixRounds.map((f) => `round ${f.round} (${f.phase}): ${f.problems[0] ?? ''}`.slice(0, 200)).join(' | ')}`
  ];
  if (r.scope.revertedFiles.length) lines.push(`${bold('Reverted by the pipeline:')} ${r.scope.revertedFiles.join('; ')}`);
  if (r.assumptionsMade.length) lines.push(`${bold('Assumptions the agent made:')}`, ...r.assumptionsMade.slice(0, 5).map((a) => `- ${a}`));
  return lines;
}

export function buildPrDescription(task: TaskInput, result: OrchestratorResult, plan: SavedPlan, repoId: string, coding?: CodingReport): string {
  const repoResult = result.teamResult?.repoResults.find((r) => r.repoId === repoId);
  const checks = result.testingResult?.repoResults.find((r) => r.repoId === repoId)?.checks ?? [];
  return [
    `## ${task.id}: ${task.title}`,
    task.metadata?.url ? `Jira: ${String(task.metadata.url)}` : '',
    '',
    '### Acceptance criteria',
    ...task.acceptanceCriteria.map((c, i) => `- AC-${i + 1}. ${c}`),
    '',
    `### Approved change plan (approved by ${plan.approvedBy ?? 'unknown'})`,
    '```',
    plan.text.trim(),
    '```',
    '',
    '### Files changed',
    ...(repoResult?.changedFiles ?? []).map((f) => `- \`${f}\``),
    '',
    ...(coding ? ['### How this change was tested and reviewed', ...qualitySummary(coding, true), ''] : []),
    '### Verify results (re-run on this branch after the change was applied)',
    ...checks.filter((c) => c.name !== 'directory-exists').map((c) => `- ${c.passed ? '✅' : '❌'} ${c.name}`),
    '',
    '---',
    'Generated by the AI development orchestrator (tests written first; pipeline-verified; AI-reviewed).',
    'Human review required: nothing is merged or deployed automatically.'
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}

/** Jira timestamps use "+0530" offsets; normalise to "+05:30" so Date.parse is reliable. */
export function parseJiraDate(value: string): number {
  return Date.parse(String(value || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}
