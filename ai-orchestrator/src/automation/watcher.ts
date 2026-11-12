import fs from 'node:fs';
import path from 'node:path';
import type { OrchestratorResult, TaskInput } from '../models/types.js';
import type { ImplementationPlan } from '../providers/claude-code-provider.js';

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

  /** One polling cycle. */
  async runOnce(): Promise<CycleReport> {
    const L = this.config.labels;
    const report: CycleReport = { checked: 0, actions: [] };
    const tasks = await this.deps.jira.searchTasks(this.config.jql, 50);
    report.checked = tasks.length;

    for (const task of tasks) {
      try {
        const action = this.hasLabel(task, L.approved)
          ? await this.handleApproved(task)
          : this.hasLabel(task, L.ready)
            ? await this.handleReady(task)
            : 'skipped';
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
        `To approve: add the label "${L.approved}". To reject: remove "${L.planPending}" (optionally comment why).`,
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

    await this.labels(task.id, [L.inProgress], [L.approved, L.planPending]);
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
        [`Implementation stopped: ${result.status}.`, `Reason: ${result.error ?? '-'}`, ...(verify.length ? ['Verify:', ...verify] : []), 'A person needs to look at this. To retry, add the approval label again.'],
        failedCheck || undefined
      );
      await this.labels(task.id, [L.needsHuman], [L.inProgress]);
      return 'failed';
    }

    const { links, skipped } = await this.deps.publish(fresh, result, plan);
    if (links.length > 0) {
      await this.comment(task.id, [
        'Implementation verified and pull request(s) opened. A reviewer must approve and merge; nothing is merged or deployed automatically.',
        ...links.map((l) => `PR (${l.repoId})${l.existing ? ' [updated existing]' : ''}: ${l.url}`),
        'Changed files:',
        ...changed,
        'Verify:',
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
      'Verify:',
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
export function buildPrDescription(task: TaskInput, result: OrchestratorResult, plan: SavedPlan, repoId: string): string {
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
    '### Verify results',
    ...checks.filter((c) => c.name !== 'directory-exists').map((c) => `- ${c.passed ? '✅' : '❌'} ${c.name}`),
    '',
    '---',
    'Generated by the AI development orchestrator (tests written first; pipeline-verified).',
    'Review required: nothing is merged or deployed automatically.'
  ]
    .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
    .join('\n');
}
