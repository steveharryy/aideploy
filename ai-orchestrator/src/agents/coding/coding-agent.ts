import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileChange } from '../../models/types.js';
import type { VerifyCommand } from '../../catalog/service-catalog.js';
import {
  ALLOWED_TOOLS,
  ClaudeCodeProvider,
  DISALLOWED_TOOLS,
  parsePlan,
  parseResult,
  runClaudeCli,
  safeEnv,
  sandboxCopyFilter,
  type ClaudeCodeRunner
} from '../../providers/claude-code-provider.js';
import { checkTestIntegrity, isTestFile } from '../team-agent/repo-agents/test-integrity.js';
import {
  acCoverage,
  diffTrees,
  isAuxiliaryFile,
  outOfPlanFiles,
  readTree,
  restoreFile,
  runCommand,
  scanDebugLeftovers,
  scanSecrets,
  toFileChanges,
  trimLog,
  unifiedDiff,
  type CommandRunner,
  type Tree,
  type TreeChange
} from './gates.js';
import { normaliseAcId, validateWorkItem, type WorkItem } from './work-item.js';

export interface CodingAgentConfig {
  runner?: ClaudeCodeRunner;
  exec?: CommandRunner;
  bin?: string;
  /** Model for the reviewer (default: CLAUDE_CODE_MODEL, else the CLI's default). */
  model?: string;
  /** Model for the CODER only (default: CODING_AGENT_MODEL, else `model`). */
  coderModel?: string;
  /** Fix rounds shared by checks, scope and review findings (point 6/7/9). Default 3. */
  maxIterations?: number;
  /** Max ask_user questions per work item (point 8). Default 3. */
  maxQuestions?: number;
  /** Per Claude Code call. Default 20 min. */
  callTimeoutMs?: number;
  /** Per verify command (e.g. npm test). Default 10 min. */
  commandTimeoutMs?: number;
  keepSandbox?: boolean;
  log?: (message: string) => void;
}

export interface CodingAgentInput {
  workItem: WorkItem;
  repoPath: string;
  /** The repo's verify contract from catalog/repos.yaml (setup → lint/typecheck → test → build). */
  verify: VerifyCommand[];
  repoPurpose?: string;
}

export type CodingStatus = 'ready_for_pr' | 'needs_input' | 'escalated' | 'failed';

export interface ReviewFinding {
  severity: 'blocker' | 'major' | 'minor';
  file?: string;
  line?: number;
  issue: string;
  suggestion?: string;
}

export interface CodingReport {
  ticket: string;
  workItem: string;
  repo: string;
  status: CodingStatus;
  summary: string;
  acceptanceCriteria: Array<{ id: string; text: string; status: 'met' | 'not_met' | 'unverified'; evidence: string[] }>;
  testsFirst: { baselinePassed: boolean; files: string[]; failedBeforeChange: boolean };
  checks: Array<{ name: string; passed: boolean; durationMs: number; log?: string }>;
  scope: {
    changedFiles: string[];
    outOfPlan: Array<{ path: string; reason?: string }>;
    secrets: string[];
    debugLeftovers: string[];
    revertedFiles: string[];
  };
  review: { verdict: 'approve' | 'changes_requested' | 'not_run'; rounds: number; findings: ReviewFinding[] };
  iterationsUsed: number;
  maxIterations: number;
  /** Why each fix round was spent (audit trail). */
  fixRounds: Array<{ round: number; phase: 'tests-first' | 'checks-and-scope' | 'review'; problems: string[] }>;
  questions: string[];
  assumptionsMade: string[];
  openIssues: string[];
  escalation?: string;
  claudeCalls: number;
  durationMs: number;
}

export interface CodingOutcome {
  report: CodingReport;
  /** Full-content changes relative to the repo as it was (empty unless ready_for_pr). */
  changes: FileChange[];
  /** Unified diff of `changes` (empty unless ready_for_pr): what this ticket changed, viewable without git. */
  diff: string;
}

/** What the coding agent answers at the end of each of its steps. */
interface CoderReply {
  status: 'done' | 'blocked' | 'escalate';
  summary: string;
  outOfPlanReasons: Record<string, string>;
  assumptions: string[];
  questions: string[];
  escalation: string;
}

interface ReviewerReply {
  verdict: 'approve' | 'changes_requested';
  findings: ReviewFinding[];
  acAssessment: Array<{ id: string; met: boolean; note?: string }>;
}

const REPLY_SHAPE = `{"status":"done"|"blocked"|"escalate","summary":"what you did","outOfPlanReasons":{"path":"why this file outside the plan had to change"},"assumptions":["..."],"questions":["only if blocked, max 3"],"escalation":"only if escalate: why"}`;

class Stop extends Error {
  constructor(public status: Exclude<CodingStatus, 'ready_for_pr'>, message: string) {
    super(message);
  }
}

/**
 * CodingAgent: turns ONE approved work item into a tested, self-checked, reviewed change in ONE repo.
 *
 *   4. tests first   – Claude writes AC-named tests; gates: only test files, every AC covered,
 *                      baseline green, suite RED with the new tests
 *   5. implement     – Claude makes the minimal change; phase-4 tests are locked (restored if touched)
 *   6. local checks  – the PIPELINE runs the repo's verify commands; failures go back to Claude
 *   7. scope check   – deterministic: test integrity, secrets, debug leftovers, out-of-plan files need a reason
 *   8. ask when stuck – Claude may stop with ≤3 questions instead of guessing → status needs_input
 *   9. review        – a separate reviewer (fresh context, read-only) checks the diff against the plan;
 *                      blocker/major findings go back to Claude
 * All fix rounds share one iteration budget. The AI proposes; the gates decide.
 */
export class CodingAgent {
  private runner: ClaudeCodeRunner;
  private exec: CommandRunner;
  private bin: string;
  private model?: string;
  private coderModel?: string;
  private maxIterations: number;
  private maxQuestions: number;
  private callTimeoutMs: number;
  private commandTimeoutMs: number;
  private keepSandbox: boolean;
  private log: (m: string) => void;

  constructor(config: CodingAgentConfig = {}) {
    this.runner = config.runner || runClaudeCli;
    this.exec = config.exec || runCommand;
    this.bin = config.bin || process.env.CLAUDE_CODE_BIN || ClaudeCodeProvider.defaultBin();
    this.model = config.model || process.env.CLAUDE_CODE_MODEL || undefined;
    this.coderModel = config.coderModel || process.env.CODING_AGENT_MODEL || this.model;
    this.maxIterations = config.maxIterations ?? (Number(process.env.CODING_MAX_ITERATIONS) || 3);
    this.maxQuestions = config.maxQuestions ?? 3;
    this.callTimeoutMs = config.callTimeoutMs ?? 20 * 60 * 1000;
    this.commandTimeoutMs = config.commandTimeoutMs ?? 10 * 60 * 1000;
    this.keepSandbox = config.keepSandbox ?? process.env.KEEP_SANDBOX === '1';
    this.log = config.log || (() => {});
  }

  async run(input: CodingAgentInput): Promise<CodingOutcome> {
    const started = Date.now();
    const w = input.workItem;
    const report: CodingReport = {
      ticket: w?.ticket ?? '?',
      workItem: w?.workItemId ?? '?',
      repo: w?.repo ?? '?',
      status: 'failed',
      summary: '',
      acceptanceCriteria: (w?.acceptanceCriteria ?? []).map((ac) => ({ id: normaliseAcId(ac.id), text: ac.text, status: 'unverified', evidence: [] })),
      testsFirst: { baselinePassed: false, files: [], failedBeforeChange: false },
      checks: [],
      scope: { changedFiles: [], outOfPlan: [], secrets: [], debugLeftovers: [], revertedFiles: [] },
      review: { verdict: 'not_run', rounds: 0, findings: [] },
      iterationsUsed: 0,
      maxIterations: this.maxIterations,
      fixRounds: [],
      questions: [],
      assumptionsMade: [],
      openIssues: [],
      claudeCalls: 0,
      durationMs: 0
    };

    const invalid = validateWorkItem(w);
    if (invalid.length) {
      report.openIssues = invalid.map((e) => `invalid work item: ${e}`);
      report.summary = 'Work item failed validation; nothing was run.';
      report.durationMs = Date.now() - started;
      return { report, changes: [], diff: '' };
    }

    const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), `coding-agent-${w.ticket.replace(/[^A-Za-z0-9._-]/g, '_')}-${w.repo}-`));
    const sessionId = crypto.randomUUID();
    let sessionStarted = false;
    let changes: FileChange[] = [];
    let diff = '';
    let keep = this.keepSandbox;

    const env = safeEnv();
    const setupSteps = input.verify.filter((v) => /^(setup|install)$/i.test(v.name));
    const testStep = input.verify.find((v) => v.name.toLowerCase() === 'test') ?? input.verify.find((v) => /\btest\b/i.test(v.run));
    const acIds = report.acceptanceCriteria.map((a) => a.id);

    const run = async (cmd: VerifyCommand) => {
      const r = await this.exec(sandbox, cmd.run, (cmd.timeoutSec ?? 0) * 1000 || this.commandTimeoutMs, env);
      return r;
    };
    const runAll = async (steps: VerifyCommand[]) => {
      const results: CodingReport['checks'] = [];
      for (const step of steps) {
        const r = await run(step);
        results.push({ name: step.name, passed: r.code === 0, durationMs: r.durationMs, ...(r.code !== 0 ? { log: trimLog(r.output) } : {}) });
        if (r.code !== 0) break; // stop at the first failing step
      }
      return results;
    };

    // ── Claude Code calls ──────────────────────────────────────────────────
    const coderTools = [...new Set([...ALLOWED_TOOLS, ...input.verify.map((v) => `Bash(${v.run.split(/\s+/).slice(0, 2).join(' ')}:*)`)])];
    const callCoder = async (prompt: string): Promise<CoderReply> => {
      const args = [
        '-p',
        '--output-format', 'json',
        '--permission-mode', 'acceptEdits',
        '--strict-mcp-config',
        ...(sessionStarted ? ['--resume', sessionId] : ['--session-id', sessionId]),
        ...(this.coderModel ? ['--model', this.coderModel] : []),
        '--disallowedTools', ...DISALLOWED_TOOLS,
        '--allowedTools', ...coderTools
      ];
      report.claudeCalls++;
      const raw = await this.runner({ bin: this.bin, args, cwd: sandbox, prompt, env, timeoutMs: this.callTimeoutMs });
      sessionStarted = true;
      const result = parseResult(raw);
      if (result.is_error || (result.subtype && result.subtype !== 'success')) {
        throw new Stop('failed', `Claude Code call failed (${result.subtype || 'error'}): ${String(result.result || '').slice(0, 300)}`);
      }
      return parseCoderReply(String(result.result || ''));
    };

    const callReviewer = async (changeDiff: string, checksSummary: string): Promise<ReviewerReply> => {
      const args = reviewerArgs(this.model);
      let retryNote = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        report.claudeCalls++;
        const raw = await this.runner({
          bin: this.bin,
          args,
          cwd: sandbox,
          prompt: reviewerPrompt(w, changeDiff, checksSummary, input.repoPurpose) + retryNote,
          env,
          timeoutMs: this.callTimeoutMs
        });
        const result = parseResult(raw);
        if (result.is_error || (result.subtype && result.subtype !== 'success')) {
          throw new Stop('failed', `Reviewer call failed (${result.subtype || 'error'}): ${String(result.result || '').slice(0, 300)}`);
        }
        const parsed = parseReviewerReply(String(result.result || ''));
        // "changes_requested" with nothing to change is not actionable: ask once more, then fail closed.
        const unexplained = parsed?.verdict === 'changes_requested' && parsed.findings.length === 0 && parsed.acAssessment.every((a) => a.met);
        if (parsed && !unexplained) return parsed;
        retryNote = unexplained
          ? '\n\nYou answered "changes_requested" but listed no findings and no unmet acceptance criterion. Either list each required change as a finding, or approve. Reply with ONLY the JSON object.'
          : '\n\nYour previous answer was not valid JSON. Reply with ONLY the JSON object.';
      }
      throw new Stop('failed', 'Reviewer agent did not return a usable verdict (unreadable, or changes requested without saying what).');
    };

    /** Applies a coder reply: stop on blocked/escalate, remember assumptions and reasons. */
    const outOfPlanReasons: Record<string, string> = {};
    const absorb = (reply: CoderReply) => {
      report.assumptionsMade.push(...reply.assumptions.filter((a) => !report.assumptionsMade.includes(a)));
      Object.assign(outOfPlanReasons, reply.outOfPlanReasons);
      if (reply.status === 'blocked') {
        report.questions = reply.questions.slice(0, this.maxQuestions).map((q) => (q.startsWith(`[${w.repo}]`) ? q : `[${w.repo}] ${q}`));
        throw new Stop('needs_input', reply.summary || 'The coding agent needs answers before it can continue.');
      }
      if (reply.status === 'escalate') {
        report.escalation = reply.escalation || reply.summary || 'Plan does not match the code.';
        throw new Stop('escalated', report.escalation);
      }
    };
    const spendIteration = (why: string[], phase: CodingReport['fixRounds'][number]['phase']) => {
      if (report.iterationsUsed >= this.maxIterations) {
        report.openIssues.push(...why);
        throw new Stop('failed', `Iteration budget used up (${this.maxIterations}) with unresolved problems.`);
      }
      report.iterationsUsed++;
      report.fixRounds.push({ round: report.iterationsUsed, phase, problems: why.map((p) => p.split('\n')[0]) });
      this.log(`[${w.repo}] fix round ${report.iterationsUsed}/${this.maxIterations}: ${why.length} problem(s)`);
    };

    try {
      if (!testStep) throw new Stop('escalated', `Repo "${w.repo}" has no test command in its verify contract (catalog/repos.yaml), so tests-first cannot be enforced.`);

      // Sandbox copy: the real repo is never touched by the agent.
      await fs.cp(input.repoPath, sandbox, { recursive: true, verbatimSymlinks: true, filter: sandboxCopyFilter(input.repoPath) });
      const original: Tree = await readTree(sandbox);

      // ── Baseline: the WHOLE verify contract must pass before any change. Then a red new test
      // proves something, and a later failure (e.g. a type error) is the change's fault, not
      // a pre-existing problem the agent would burn its fix rounds on. ──
      const baselineSteps = input.verify.includes(testStep) ? input.verify : [...input.verify, testStep];
      this.log(`[${w.repo}] baseline: ${baselineSteps.map((s) => s.name).join(' → ')}`);
      const baselineFailure = (await runAll(baselineSteps)).find((c) => !c.passed);
      if (baselineFailure) {
        const log = baselineFailure.log ?? '';
        if (setupSteps.some((s) => s.name === baselineFailure.name)) throw new Stop('failed', `Setup step "${baselineFailure.name}" failed before any change:\n${log}`);
        if (baselineFailure.name === testStep.name) {
          throw new Stop('escalated', `Existing tests already fail before any change, so a failing new test proves nothing:\n${log}`);
        }
        throw new Stop(
          'escalated',
          `The repo is not green before any change: verify step "${baselineFailure.name}" already fails. Fix the repo (or its verify contract in catalog/repos.yaml) first; otherwise the agent would be blamed for it:\n${log}`
        );
      }
      report.testsFirst.baselinePassed = true;

      // ── Point 4: tests first ─────────────────────────────────────────────
      this.log(`[${w.repo}] phase 4: writing tests first`);
      let reply = await callCoder(testsFirstPrompt(w, input.repoPurpose, testStep.run));
      absorb(reply);
      let lockedTests: Tree = new Map();
      for (let round = 0; ; round++) {
        const now = await readTree(sandbox);
        const delta = diffTrees(original, now);
        const problems: string[] = [];

        // Only tests (and test-runner setup) may change in this phase: revert anything else.
        for (const c of delta.filter((d) => !isTestFile(d.path) && !isAuxiliaryFile(d.path))) {
          await restoreFile(sandbox, c.path, original.get(c.path));
          report.scope.revertedFiles.push(`${c.path} (changed during tests-first phase)`);
        }
        const testChanges = delta.filter((d) => isTestFile(d.path));
        const integrity = await checkTestIntegrity(toFileChanges(testChanges), async (p) => original.get(p));
        problems.push(...integrity);

        const testFiles = testChanges.filter((d) => d.action !== 'delete').map((d) => ({ path: d.path, content: d.after ?? '' }));
        const coverage = acCoverage(testFiles, acIds);
        const missing = acIds.filter((id) => coverage[id].length === 0);
        if (testFiles.length === 0) problems.push('No test files were written.');
        else if (missing.length) problems.push(`No test named for ${missing.join(', ')} (test names must contain the AC id, e.g. test_${missing[0]}_...).`);

        if (problems.length === 0) {
          if (delta.some((d) => isAuxiliaryFile(d.path))) for (const s of setupSteps) await run(s);
          const red = await run(testStep);
          if (red.code === 0) problems.push(`The new tests PASS on the current code, so they do not capture the change. Make them assert the new behaviour from the acceptance criteria.`);
          else {
            report.testsFirst = { baselinePassed: true, files: testFiles.map((f) => f.path), failedBeforeChange: true };
            lockedTests = new Map(testFiles.map((f) => [f.path, f.content]));
            report.acceptanceCriteria.forEach((ac) => (ac.evidence = coverage[ac.id]));
            this.log(`[${w.repo}] tests are red as expected (${testFiles.length} file(s))`);
            reply = await callCoder(implementPrompt(w, trimLog(red.output), input.verify));
            break;
          }
        }
        spendIteration(problems.map((p) => `tests-first: ${p}`), 'tests-first');
        reply = await callCoder(fixPrompt('FIX TESTS (tests-first phase: change only test files)', problems, report.iterationsUsed, this.maxIterations, testStep.run));
        absorb(reply);
      }

      // ── Points 5–9: implement → local checks → scope → review, with fix rounds ──
      this.log(`[${w.repo}] phase 5: implementing`);
      absorb(reply);
      for (;;) {
        // Locked tests from point 4 cannot be edited by the implementation.
        for (const [p, content] of lockedTests) {
          const current = await fs.readFile(path.join(sandbox, p), 'utf-8').catch(() => undefined);
          if (current !== content) {
            await restoreFile(sandbox, p, content);
            report.scope.revertedFiles.push(`${p} (locked test edited during implementation)`);
          }
        }

        // Point 6: the pipeline runs the repo's own checks.
        report.checks = await runAll(input.verify);
        const failedCheck = report.checks.find((c) => !c.passed);

        // Point 7: deterministic scope self-check.
        const delta = diffTrees(original, await readTree(sandbox));
        report.scope.changedFiles = delta.map((d) => d.path);
        report.scope.secrets = scanSecrets(delta);
        report.scope.debugLeftovers = scanDebugLeftovers(delta);
        const outside = outOfPlanFiles(delta, w.plannedFiles);
        report.scope.outOfPlan = outside.map((p) => ({ path: p, reason: outOfPlanReasons[p] }));
        const integrity = await checkTestIntegrity(toFileChanges(delta.filter((d) => isTestFile(d.path))), async (p) => original.get(p));
        const coverage = acCoverage(delta.filter((d) => isTestFile(d.path) && d.action !== 'delete').map((d) => ({ path: d.path, content: d.after ?? '' })), acIds);

        const problems: string[] = [];
        if (failedCheck) problems.push(`Check "${failedCheck.name}" failed:\n${failedCheck.log ?? ''}`);
        problems.push(...integrity.map((v) => `Test integrity: ${v}`));
        problems.push(...report.scope.secrets.map((s) => `Secret in diff: ${s}. Remove it; use configuration/env instead.`));
        problems.push(...report.scope.debugLeftovers.map((d) => `Debug leftover: ${d}. Remove it or use the repo's logger.`));
        problems.push(...report.scope.outOfPlan.filter((o) => !o.reason).map((o) => `${o.path} is outside the planned files. Revert it, or give a reason in outOfPlanReasons.`));
        if (delta.length === 0) problems.push('No changes were made.');
        problems.push(...acIds.filter((id) => coverage[id].length === 0).map((id) => `${id} no longer has a test named for it.`));

        if (problems.length) {
          spendIteration(problems, 'checks-and-scope');
          reply = await callCoder(fixPrompt('FIX', problems, report.iterationsUsed, this.maxIterations, input.verify.map((v) => v.run).join('  →  ')));
          absorb(reply);
          continue;
        }

        // Point 9: independent reviewer with a fresh context.
        this.log(`[${w.repo}] phase 9: reviewer agent (round ${report.review.rounds + 1})`);
        const review = await callReviewer(await unifiedDiff(delta), report.checks.map((c) => `${c.name}: ${c.passed ? 'passed' : 'FAILED'}`).join(', '));
        report.review.rounds++;
        report.review.verdict = review.verdict;
        report.review.findings = review.findings;
        const blocking = review.findings.filter((f) => f.severity === 'blocker' || f.severity === 'major');
        const notMet = review.acAssessment.filter((a) => a.met === false).map((a) => normaliseAcId(a.id));

        if (blocking.length === 0 && notMet.length === 0) {
          // Done: every AC has a named test, the suite is green, the reviewer agrees.
          for (const ac of report.acceptanceCriteria) {
            ac.evidence = coverage[ac.id];
            ac.status = coverage[ac.id].length ? 'met' : 'unverified';
          }
          report.status = report.acceptanceCriteria.every((a) => a.status === 'met') ? 'ready_for_pr' : 'failed';
          if (report.status !== 'ready_for_pr') report.openIssues.push('Not every acceptance criterion has passing test evidence.');
          report.summary = reply.summary || 'Change implemented, verified and reviewed.';
          changes = toFileChanges(delta);
          if (report.status === 'ready_for_pr') diff = await unifiedDiff(delta, 5_000_000);
          break;
        }

        const reviewProblems = [
          ...blocking.map((f) => `Review ${f.severity}: ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}${f.issue}${f.suggestion ? ` (suggestion: ${f.suggestion})` : ''}`),
          ...notMet.map((id) => `Reviewer: ${id} is not actually met by the change.`)
        ];
        spendIteration(reviewProblems, 'review');
        reply = await callCoder(fixPrompt('FIX REVIEW FINDINGS', reviewProblems, report.iterationsUsed, this.maxIterations, input.verify.map((v) => v.run).join('  →  ')));
        absorb(reply);
      }
    } catch (err) {
      if (err instanceof Stop) {
        report.status = err.status;
        report.summary = err.message;
        if (err.status === 'failed' && !report.openIssues.includes(err.message)) report.openIssues.unshift(err.message);
      } else {
        report.status = 'failed';
        report.summary = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
        report.openIssues.unshift(report.summary);
      }
      keep = true;
      changes = [];
      diff = '';
    } finally {
      report.durationMs = Date.now() - started;
      if (keep && report.status !== 'ready_for_pr') report.openIssues.push(`Sandbox kept for inspection: ${sandbox}`);
      if (!keep) await fs.rm(sandbox, { recursive: true, force: true });
    }
    return { report, changes, diff };
  }
}

// ── Prompts ─────────────────────────────────────────────────────────────────

function workItemBlock(w: WorkItem): string {
  return `<work_item>\n${JSON.stringify(w, null, 2)}\n</work_item>`;
}

function testsFirstPrompt(w: WorkItem, purpose: string | undefined, testCommand: string): string {
  return `You are the CODING agent for work item ${w.workItemId} of ticket ${w.ticket}, repository "${w.repo}" (your current directory).
${purpose ? `Repository purpose: ${purpose}\n` : ''}${workItemBlock(w)}

Phase: WRITE TESTS FIRST. Change ONLY test files in this phase (non-test changes will be reverted automatically).
1. Verify the plan against reality first: the files and logic the work item refers to must exist. If the repo is wrong, the contract cannot work, or another repo must also change, do NOT improvise: reply with status "escalate".
2. Read the repo's rules (CLAUDE.md / AGENTS.md / README) and existing tests; use the same framework, location and conventions.
3. Write one or more tests for EVERY testPlan entry. Each test name must contain its AC id (e.g. "${w.testPlan[0]?.name ?? 'test_AC1_...'}").
4. Tests must assert the new behaviour and FAIL on the current code for the right reason (missing behaviour, not a typo or bad import in the test). Mock external HTTP, Redis and network calls; never call real services.
5. Never modify, skip or weaken existing tests.
6. Run: ${testCommand}  and confirm the new tests fail.
If a decision is genuinely missing from the work item, do NOT guess: reply with status "blocked" and at most 3 concrete questions.

Reply with ONLY this JSON:
${REPLY_SHAPE}`;
}

function implementPrompt(w: WorkItem, redLog: string, verify: VerifyCommand[]): string {
  return `Phase: IMPLEMENT. Your tests are now LOCKED: do not edit them (edits are reverted automatically).
Current failing output (trimmed):
${redLog}

Make the minimal, targeted change that satisfies every acceptance criterion of ${w.ticket} ${w.workItemId}.
- Follow the shared contract exactly${w.contract ? '' : ' (none given)'}; no unrelated refactoring; no out-of-scope work.
- Planned files: ${w.plannedFiles?.length ? w.plannedFiles.map((f) => f.path).join(', ') : '(not specified)'}. Any edit outside them needs a reason in "outOfPlanReasons".
- No debug output (console.log/print), no secrets, no commented-out code.
- Run and fix until all pass: ${verify.map((v) => v.run).join('  →  ')}
If you hit a genuine decision the work item does not answer, reply "blocked" with at most 3 questions instead of guessing.

Reply with ONLY this JSON:
${REPLY_SHAPE}`;
}

function fixPrompt(phase: string, problems: string[], round: number, max: number, commands: string): string {
  return `Phase: ${phase} (fix round ${round} of ${max}). The pipeline's own checks found these problems:
${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}

Fix them with minimal changes. Tests from the tests-first phase stay locked unless this phase is about writing tests.
Then run: ${commands}

Reply with ONLY this JSON:
${REPLY_SHAPE}`;
}

/** Claude Code CLI arguments for the reviewer: fresh session, read-only tools, no MCP servers. */
export function reviewerArgs(model?: string): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', 'default',
    '--strict-mcp-config',
    ...(model ? ['--model', model] : []),
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', ...DISALLOWED_TOOLS,
    '--allowedTools', 'Read', 'Glob', 'Grep'
  ];
}

export function reviewerPrompt(w: WorkItem, diff: string, checks: string, purpose?: string): string {
  return `You are an independent REVIEWER agent with no prior context. Review a change made for ticket ${w.ticket} (${w.workItemId}) in repository "${w.repo}".
The changed repository is your current directory: you may read files, you cannot change anything.
${purpose ? `Repository notes (the coding agent had the same notes; changes they ask for are in scope): ${purpose}\n` : ''}
${workItemBlock(w)}

<diff>
${diff}
</diff>

<pipeline_checks>${checks}</pipeline_checks>

Check:
1. Every acceptance criterion is really implemented AND covered by a test that asserts the behaviour (not trivially true, not mocking away the code under test).
2. The shared contract and planned scope are respected; no unrelated changes.
3. No regressions for existing callers (response shapes, status codes, ordering, error handling).
4. Edge cases and error paths the ACs imply.
5. No secrets, debug leftovers or commented-out code; repo conventions followed.
Severity: "blocker" = wrong, unsafe or an AC not met; "major" = likely bug or missing test; "minor" = style/nit (does not block).

Reply with ONLY this JSON:
{"verdict":"approve"|"changes_requested","findings":[{"severity":"blocker"|"major"|"minor","file":"path","line":0,"issue":"...","suggestion":"..."}],"acAssessment":[{"id":"AC1","met":true,"note":"..."}]}`;
}

// ── Reply parsing (defensive: never trust the shape) ────────────────────────

function strings(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];
}

export function parseCoderReply(text: string): CoderReply {
  const obj = parsePlan(text) as Record<string, unknown>;
  if ('raw' in obj) {
    // Unparseable: treat as "done"; the deterministic gates decide whether it actually is.
    return { status: 'done', summary: String(obj.raw).slice(0, 500), outOfPlanReasons: {}, assumptions: [], questions: [], escalation: '' };
  }
  const status = obj.status === 'blocked' || obj.status === 'escalate' ? obj.status : 'done';
  const reasons: Record<string, string> = {};
  if (obj.outOfPlanReasons && typeof obj.outOfPlanReasons === 'object') {
    for (const [k, v] of Object.entries(obj.outOfPlanReasons as Record<string, unknown>)) if (typeof v === 'string' && v.trim()) reasons[k] = v;
  }
  const questions = strings(obj.questions);
  return {
    // "blocked" without a question is not actionable: let the gates continue.
    status: status === 'blocked' && questions.length === 0 ? 'done' : status,
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    outOfPlanReasons: reasons,
    assumptions: strings(obj.assumptions),
    questions,
    escalation: typeof obj.escalation === 'string' ? obj.escalation : ''
  };
}

export function parseReviewerReply(text: string): ReviewerReply | undefined {
  const obj = parsePlan(text) as Record<string, unknown>;
  if ('raw' in obj || (obj.verdict !== 'approve' && obj.verdict !== 'changes_requested')) return undefined;
  const findings: ReviewFinding[] = (Array.isArray(obj.findings) ? obj.findings : [])
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as Record<string, unknown>).issue === 'string')
    .map((f) => ({
      severity: f.severity === 'blocker' || f.severity === 'major' ? f.severity : 'minor',
      file: typeof f.file === 'string' ? f.file : undefined,
      line: typeof f.line === 'number' ? f.line : undefined,
      issue: f.issue as string,
      suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined
    }));
  const acAssessment = (Array.isArray(obj.acAssessment) ? obj.acAssessment : [])
    .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as Record<string, unknown>).id === 'string')
    .map((a) => ({ id: a.id as string, met: a.met !== false, note: typeof a.note === 'string' ? a.note : undefined }));
  return { verdict: obj.verdict as ReviewerReply['verdict'], findings, acAssessment };
}
