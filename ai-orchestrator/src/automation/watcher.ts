import fs from 'node:fs';
import path from 'node:path';
import type { OrchestratorResult, TaskInput } from '../models/types.js';
import type { ImplementationPlan } from '../providers/claude-code-provider.js';
import type { PlanQuestion, TicketPlan } from '../agents/planning/types.js';
import { renderMissing, renderQuestions } from '../agents/planning/render.js';
import { missingInfoCommentAdf, planCommentAdf, questionsCommentAdf, type AdfNode } from '../agents/planning/render-adf.js';
import { FileSessionStore, type SessionPhase, type SessionStore } from '../jobs/session-store.js';
import { redactSecrets, safeErrorMessage } from '../util/redact.js';
import { workItemsForCoding } from '../agents/planning/plan-rules.js';
import type { CodingReport } from '../agents/coding/coding-agent.js';

/**
 * The only labels in Jira: the two HUMAN triggers. The bot removes a trigger once it has acted
 * on it. Where a ticket is in the pipeline (its phase) is kept in our session store, and shown in
 * Jira through comments and, optionally, the project's own workflow statuses.
 */
export interface WatcherLabels {
  ready: string; // human: "please plan this" (also: "I answered / updated the ticket, plan again")
  approved: string; // human: "plan approved, implement it"
}

export const DEFAULT_LABELS: WatcherLabels = {
  ready: 'ai-ready',
  approved: 'ai-approved'
};

export interface WatcherConfig {
  /** Which tickets to look at. Must include the ready + approved labels. */
  jql: string;
  labels: WatcherLabels;
  /** Skip the human approval step (not recommended). */
  autoApprove: boolean;
  /** Coding phase switch, read on every approval. Absent = on (tests, library use). */
  codingEnabled?: () => boolean;
  /** Stop after this many implementation attempts per ticket. */
  maxAttempts: number;
  /**
   * Existing Jira workflow status to move a ticket to when it enters a phase (per project, from
   * config). Undefined = leave the status alone. A missing transition is logged, never fatal.
   */
  statusForPhase?: (ticket: string, phase: SessionPhase) => string | undefined;
  /** Report what would happen; no Jira writes, no AI runs. */
  dryRun: boolean;
  /** Rounds of blocking questions before the ticket is sent back as too vague (default 2). */
  maxQuestionRounds?: number;
  /** "Request changes" rounds on a plan before the ticket is sent back (default 3). */
  maxPlanRevisions?: number;
  /** Assign the ticket back to its reporter when it is sent back for more information. */
  assignToReporter?: boolean;
  /**
   * A ticket still in "planning" / "coding" after this long without any update is treated as left
   * behind by a crash or restart and handed to a person (defaults: 45 min / 3 h).
   */
  stalePlanningMs?: number;
  staleCodingMs?: number;
}

/** Result of the planning phase for one ticket. */
export interface PlanOutcome {
  /** retry-later: a temporary problem (AI usage/rate limit, overload). Nothing is posted; the trigger stays for the next cycle. */
  status: 'ready' | 'duplicate' | 'no-repo' | 'error' | 'needs-input' | 'needs-info' | 'retry-later';
  reason?: string;
  repos: string[];
  /** Per-repo brief handed to the coding agent. */
  plans: Record<string, ImplementationPlan | Record<string, unknown>>;
  text: string;
  /** Structured plan from the Planning Agent (claude-code provider). */
  ticketPlan?: TicketPlan;
  /** Repo → repos it waits for, from the plan's work items. */
  repoDependencies?: Record<string, string[]>;
  promptVersion?: string;
  costUsd?: number;
  /** Per-repo branch / verify / rollback, for the plan comment. */
  repoFacts?: Array<{ repo: string; branch?: string; verify?: string; rollback?: string }>;
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
  plans: Record<string, ImplementationPlan | Record<string, unknown>>;
  text: string;
  ticketPlan?: TicketPlan;
  repoDependencies?: Record<string, string[]>;
  /** 1 for the first plan, +1 for every revision after "request changes". */
  version?: number;
  promptVersion?: string;
  costUsd?: number;
  approvedBy?: string;
  approvedAt?: string;
}

export interface WatcherJira {
  searchTasks(jql: string, maxResults?: number): Promise<TaskInput[]>;
  getTask(key: string): Promise<TaskInput>;
  addComment(key: string, lines: string[], preformatted?: string): Promise<void>;
  /** Rich comment (Atlassian Document Format). Optional: without it the plain comment is used. */
  addCommentDoc?(key: string, body: AdfNode): Promise<void>;
  updateLabels(key: string, add?: string[], remove?: string[]): Promise<void>;
  transition(key: string, statusName: string): Promise<boolean>;
  getLabelAdder(key: string, label: string): Promise<string | undefined>;
  assign?(key: string, accountId: string): Promise<void>;
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
  /** Checked before every step: true = start nothing new. */
  killSwitch?(): boolean;
  /** Where each ticket's phase is kept (default: files under jobsDir). */
  sessions?: SessionStore;
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
  | 'needs-input'
  | 'needs-info'
  | 'retry-limit'
  | 'skipped';

export interface CycleReport {
  checked: number;
  actions: Array<{ ticket: string; action: TicketAction; detail?: string }>;
}

const BOT = '🤖 AI Orchestrator';
/** Temporary planning failures (usage limit, timeout…) retried before a person is asked to look. */
const MAX_TEMPORARY_RETRIES = 2;

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
  readonly sessions: SessionStore;

  constructor(private config: WatcherConfig, private deps: WatcherDeps) {
    this.sessions = deps.sessions ?? new FileSessionStore(deps.jobsDir);
  }

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

  private questionsFile(ticketId: string): string {
    return path.join(this.deps.jobsDir, ticketId.replace(/[^A-Za-z0-9._-]/g, '_'), 'questions.json');
  }

  /** Blocking-question rounds asked so far for a ticket. */
  readQuestionState(ticketId: string): { rounds: number; questions: PlanQuestion[] } {
    try {
      return JSON.parse(fs.readFileSync(this.questionsFile(ticketId), 'utf-8'));
    } catch {
      return { rounds: 0, questions: [] };
    }
  }

  private saveQuestionState(ticketId: string, state: { rounds: number; questions: PlanQuestion[] }): void {
    const file = this.questionsFile(ticketId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  }

  private hasLabel(task: TaskInput, label: string): boolean {
    const labels = task.metadata?.labels;
    return Array.isArray(labels) && labels.includes(label);
  }

  // Jira writes are no-ops in dry-run mode.
  private async comment(key: string, lines: string[], pre?: string) {
    if (!this.config.dryRun) await this.deps.jira.addComment(key, [BOT, ...lines].map(redactSecrets), pre === undefined ? undefined : redactSecrets(pre));
  }
  /**
   * Records the ticket's new phase in our store, removes the human trigger label(s) the bot has
   * acted on, and moves the Jira status if the project maps this phase to one.
   */
  private async toPhase(key: string, phase: SessionPhase, consume: string[], detail?: string) {
    if (this.config.dryRun) return;
    this.sessions.setPhase(key, phase, detail === undefined ? undefined : redactSecrets(detail));
    if (consume.length) await this.deps.jira.updateLabels(key, [], consume);
    await this.move(key, this.config.statusForPhase?.(key, phase));
  }
  /** Temporary-failure retries since the last real outcome (read from the session history). */
  private consecutiveRetries(ticketId: string): number {
    let n = 0;
    for (const h of [...(this.sessions.get(ticketId)?.history ?? [])].reverse()) {
      if (h.phase !== 'planning') break;
      if (h.detail?.startsWith('waiting to retry')) n++;
    }
    return n;
  }

  /**
   * Starts the question rounds and plan revisions from zero. Used when a plan is posted and when the
   * ticket goes back to the reporter, so a rewritten ticket is not judged by an old round count.
   */
  private resetRounds(ticketId: string, archivePlan: boolean): void {
    const dir = path.dirname(this.questionsFile(ticketId));
    fs.rmSync(this.questionsFile(ticketId), { force: true });
    if (archivePlan && fs.existsSync(this.planFile(ticketId)) && !this.readPlan(ticketId)?.approvedAt) {
      fs.renameSync(this.planFile(ticketId), path.join(dir, `plan.superseded-${Date.now()}.json`));
    }
  }

  /**
   * Rich (Jira-formatted) comment, falling back to the plain one if Jira rejects it or the client
   * cannot send rich comments: a comment is never lost to formatting.
   */
  private async richComment(key: string, body: AdfNode, fallbackLines: string[], fallbackPre?: string) {
    if (this.config.dryRun) return;
    if (this.deps.jira.addCommentDoc) {
      try {
        await this.deps.jira.addCommentDoc(key, body);
        return;
      } catch (err) {
        this.deps.log(`${key}: rich comment rejected, posting plain text instead: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await this.comment(key, fallbackLines, fallbackPre);
  }

  /** Too vague: comment what is missing, record the phase, and give the ticket back to its reporter. */
  private async sendBack(task: TaskInput, lines: string[], consume: string[], rich?: AdfNode) {
    if (rich) await this.richComment(task.id, rich, lines);
    else await this.comment(task.id, lines);
    if (!this.config.dryRun) this.resetRounds(task.id, true);
    await this.toPhase(task.id, 'needs_info', consume, lines[0]);
    const reporter = (task.metadata?.reporter as { accountId?: string } | undefined)?.accountId;
    if (this.config.assignToReporter && reporter && this.deps.jira.assign && !this.config.dryRun) {
      await this.deps.jira.assign(task.id, reporter).catch((err) =>
        this.deps.log(`${task.id}: could not assign to the reporter: ${err instanceof Error ? err.message : String(err)}`)
      );
    }
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
    const report: CycleReport = { checked: 0, actions: [] };
    if (this.deps.killSwitch?.()) {
      this.deps.log('kill switch is on: not looking for tickets');
      return report;
    }
    await this.sweepStale();
    const tasks = await this.deps.jira.searchTasks(this.config.jql, 50);
    report.checked = tasks.length;

    for (const task of tasks) {
      const { action, detail } = await this.processTask(task);
      report.actions.push({ ticket: task.id, action, ...(detail ? { detail } : {}) });
    }
    return report;
  }

  /** Runs one ticket by key (e.g. from a webhook). The ticket is re-read, so its labels decide. */
  async runTicket(key: string): Promise<{ action: TicketAction; detail?: string }> {
    await this.sweepStale();
    const task = await this.deps.jira.getTask(key);
    return this.processTask(task);
  }

  /** Routes a ticket by its labels; any error is reported on the ticket and handed to a human. */
  private async processTask(task: TaskInput): Promise<{ action: TicketAction; detail?: string }> {
    const L = this.config.labels;
    if (this.deps.killSwitch?.()) {
      this.deps.log(`${task.id}: kill switch is on, not started`);
      return { action: 'skipped', detail: 'kill switch on' };
    }
    const triggers = [L.approved, L.ready].filter((l) => this.hasLabel(task, l));
    if (triggers.length === 0) return { action: 'skipped' };

    // Claim first: remove the trigger label BEFORE any paid work. If Jira refuses (no Edit
    // permission, outage), nothing runs, so a ticket can never be re-planned every cycle.
    if (!this.config.dryRun) {
      try {
        await this.deps.jira.updateLabels(task.id, [], triggers);
      } catch (err) {
        const message = safeErrorMessage(err);
        this.deps.log(`${task.id}: not started, could not remove the trigger label (${triggers.join(', ')}): ${message}`);
        this.sessions.setPhase(task.id, this.sessions.get(task.id)?.phase ?? 'needs_human', `could not claim ticket: ${message}`);
        return { action: 'failed', detail: `could not claim ticket: ${message}` };
      }
    }
    try {
      const action = triggers.includes(L.approved) ? await this.handleApproved(task) : await this.handleReady(task);
      return { action };
    } catch (err) {
      const message = safeErrorMessage(err);
      this.deps.log(`${task.id}: unexpected error: ${message}`);
      await this.comment(task.id, ['Stopped because of an unexpected error. A person needs to look at this.', `Error: ${message}`]).catch(() => {});
      await this.toPhase(task.id, 'needs_human', [], `error: ${message}`).catch(() => {});
      return { action: 'failed', detail: message };
    }
  }

  /**
   * Tickets left in "planning" or "coding" by a crash or restart (no update for too long) are
   * handed to a person with a Jira comment, instead of sitting there with no label and no alert.
   * A ticket waiting for a planned retry (its label is back on) is left alone.
   */
  async sweepStale(now = Date.now()): Promise<string[]> {
    if (this.config.dryRun) return [];
    const L = this.config.labels;
    const limits: Partial<Record<SessionPhase, number>> = {
      planning: this.config.stalePlanningMs ?? 45 * 60 * 1000,
      coding: this.config.staleCodingMs ?? 3 * 60 * 60 * 1000
    };
    const swept: string[] = [];
    for (const s of this.sessions.list()) {
      const limit = limits[s.phase];
      if (!limit || now - Date.parse(s.updatedAt) < limit) continue;
      if (s.phase === 'planning' && s.detail?.startsWith('waiting to retry')) continue;
      const what = s.phase === 'coding' ? 'implementing' : 'planning';
      const retryLabel = s.phase === 'coding' ? L.approved : L.ready;
      this.deps.log(`${s.ticket}: stuck in ${s.phase} since ${s.updatedAt} → needs_human`);
      try {
        await this.comment(s.ticket, [
          `The pipeline stopped while ${what} this ticket (no progress since ${s.updatedAt.slice(0, 16).replace('T', ' ')} UTC), probably a restart or crash.`,
          `Nothing was posted or merged. To try again, add the label "${retryLabel}".`
        ]);
      } catch (err) {
        this.deps.log(`${s.ticket}: could not post the stuck-ticket comment: ${safeErrorMessage(err)}`);
      }
      this.sessions.setPhase(s.ticket, 'needs_human', `stuck in ${s.phase} (no update since ${s.updatedAt})`);
      swept.push(s.ticket);
    }
    return swept;
  }

  /** ai-ready: dedup → impact → change plan → Jira comment → waiting for approval. */
  private async handleReady(task: TaskInput): Promise<TicketAction> {
    const L = this.config.labels;
    this.deps.log(`${task.id}: picked up (${L.ready}) → planning`);
    if (this.config.dryRun) return 'planned';
    this.sessions.setPhase(task.id, 'planning');

    const questionState = this.readQuestionState(task.id);
    if (questionState.questions.length) {
      task.metadata = { ...(task.metadata || {}), previousQuestions: questionState.questions };
    }
    const clear = [L.ready];
    // A plan already exists: re-plan from it using the reviewer's comments. If it was approved,
    // "ai-ready" withdraws that approval (rejected after approval, or product changed direction);
    // the approved version is kept on disk with its approval record.
    const prior = this.readPlan(task.id);
    const revising = !!prior?.ticketPlan;
    const reopening = revising && !!prior!.approvedAt;
    const version = revising ? (prior!.version ?? 1) + 1 : 1;
    const maxRevisions = this.config.maxPlanRevisions ?? 3;
    if (revising && version > maxRevisions + 1) {
      this.deps.log(`${task.id}: plan revised ${maxRevisions} times without approval → back to reporter`);
      await this.sendBack(task, [
        `The plan for ${task.id} was revised ${maxRevisions} times without being approved.`,
        'Please clarify the ticket (expected behaviour, scope, examples) so a plan can be agreed, or plan it by hand.',
        `Then add the label "${L.ready}" again.`
      ], clear);
      return 'needs-info';
    }
    if (revising) {
      task.metadata = { ...(task.metadata || {}), previousPlan: prior!.ticketPlan };
      // Keep the version being replaced, so the approver can compare v1 with v2.
      if (!this.config.dryRun) {
        const dir = path.dirname(this.planFile(task.id));
        fs.copyFileSync(this.planFile(task.id), path.join(dir, `plan.v${prior!.version ?? 1}.json`));
      }
      if (reopening && !this.config.dryRun) {
        this.deps.log(`${task.id}: approved plan v${prior!.version ?? 1} reopened → re-planning`);
        await this.comment(task.id, [
          `Approval of change plan v${prior!.version ?? 1} (approved by ${prior!.approvedBy ?? 'unknown'} at ${prior!.approvedAt}) is withdrawn because "${L.ready}" was added again.`,
          `Re-planning from the newest comments. The approved version is kept for comparison.`
        ]);
      }
    }
    const outcome = await this.deps.plan(task);

    if (outcome.status === 'retry-later') {
      // Capped: after MAX_TEMPORARY_RETRIES temporary failures in a row, a person looks at it.
      const retries = this.consecutiveRetries(task.id);
      if (retries < MAX_TEMPORARY_RETRIES) {
        this.deps.log(`${task.id}: temporary problem, will retry next cycle (${retries + 1}/${MAX_TEMPORARY_RETRIES}): ${redactSecrets(outcome.reason ?? '-')}`);
        this.sessions.setPhase(task.id, 'planning', `waiting to retry: ${redactSecrets(outcome.reason ?? '').slice(0, 200)}`);
        // The label was claimed at the start; put it back so the next cycle picks the ticket up.
        if (!this.config.dryRun) {
          await this.deps.jira.updateLabels(task.id, [L.ready], []).catch((err) =>
            this.deps.log(`${task.id}: could not re-add "${L.ready}" for the retry: ${safeErrorMessage(err)}`)
          );
        }
        return 'skipped';
      }
      outcome.status = 'error';
      outcome.reason = `${outcome.reason ?? ''} (still failing after ${retries} retries)`;
    }
    if (outcome.status === 'duplicate') {
      await this.comment(task.id, ['Not started: this looks like work that is already done.', `Reason: ${outcome.reason ?? '-'}`]);
      await this.toPhase(task.id, 'needs_human', clear, `duplicate: ${outcome.reason ?? ''}`);
      return 'duplicate';
    }
    if (outcome.status === 'no-repo') {
      await this.comment(task.id, [
        'Not started: no repository matched this ticket.',
        ...(outcome.reason ? [`Reason: ${outcome.reason}`] : []),
        `Add a component for the target repo, or add the repo to catalog/repos.yaml, then add the label "${L.ready}" again.`
      ]);
      await this.toPhase(task.id, 'needs_human', clear, 'no matching repository');
      return 'no-repo';
    }
    if (outcome.status === 'error') {
      await this.comment(task.id, ['Planning failed. A person needs to look at this.', `Error: ${outcome.reason ?? '-'}`], outcome.text || undefined);
      await this.toPhase(task.id, 'needs_human', clear, `planning failed: ${outcome.reason ?? ''}`);
      return 'failed';
    }

    const maxRounds = this.config.maxQuestionRounds ?? 2;
    if (outcome.status === 'needs-input' && outcome.ticketPlan) {
      if (questionState.rounds >= maxRounds) {
        // Still blocked after the allowed rounds: hand back to the reporter instead of asking forever.
        const plan: TicketPlan = {
          ...outcome.ticketPlan,
          readiness: 'too_vague',
          missingForReporter: [
            `Still unclear after ${questionState.rounds} round(s) of questions. Open points:`,
            ...outcome.ticketPlan.questions.map((q) => `${q.id}. ${q.text}`)
          ]
        };
        this.deps.log(`${task.id}: still blocked after ${questionState.rounds} question round(s) → back to reporter`);
        await this.sendBack(task, renderMissing(plan, L.ready), clear, missingInfoCommentAdf(plan, L.ready));
        return 'needs-info';
      }
      const round = questionState.rounds + 1;
      this.saveQuestionState(task.id, { rounds: round, questions: outcome.ticketPlan.questions });
      this.deps.log(`${task.id}: ${outcome.ticketPlan.questions.length} blocking question(s) (round ${round}/${maxRounds})`);
      await this.richComment(
        task.id,
        questionsCommentAdf(outcome.ticketPlan, L.ready, round, maxRounds),
        renderQuestions(outcome.ticketPlan, L.ready, round, maxRounds)
      );
      await this.toPhase(task.id, 'needs_input', clear, `round ${round}: ${outcome.ticketPlan.questions.length} question(s)`);
      return 'needs-input';
    }
    if (outcome.status === 'needs-info' && outcome.ticketPlan) {
      this.deps.log(`${task.id}: too vague → back to reporter`);
      await this.sendBack(task, renderMissing(outcome.ticketPlan, L.ready), clear, missingInfoCommentAdf(outcome.ticketPlan, L.ready));
      return 'needs-info';
    }

    const saved: SavedPlan = {
      ticketId: task.id,
      createdAt: new Date().toISOString(),
      repos: outcome.repos,
      plans: outcome.plans,
      text: outcome.text,
      ...(outcome.ticketPlan ? { ticketPlan: outcome.ticketPlan } : {}),
      ...(outcome.repoDependencies ? { repoDependencies: outcome.repoDependencies } : {}),
      ...(outcome.ticketPlan ? { version } : {}),
      ...(outcome.promptVersion ? { promptVersion: outcome.promptVersion } : {}),
      ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {})
    };

    if (this.config.autoApprove) {
      saved.approvedBy = 'auto (AUTO_APPROVE_PLAN=true)';
      saved.approvedAt = new Date().toISOString();
      this.savePlan(saved);
      await this.comment(task.id, ['Change plan (auto-approved, implementation starts now):'], outcome.text);
      await this.toPhase(task.id, 'approved', clear, 'auto-approved');
      task.metadata = { ...(task.metadata || {}), labels: [L.approved] };
      return this.handleApproved(task);
    }

    this.savePlan(saved);
    this.resetRounds(task.id, false); // a posted plan closes the question rounds
    const plainPlanLines = [
        `Change plan${saved.version && saved.version > 1 ? ` v${saved.version} (revised)` : ''} for ${task.id} is ready for review. Repos: ${outcome.repos.join(', ')}.`,
        ...(outcome.ticketPlan?.warnings.length
          ? [`⚠ ${outcome.ticketPlan.warnings.length} warning(s) in this plan: read them before approving.`, ...outcome.ticketPlan.warnings.map((w) => `⚠ ${w}`)]
          : []),
        `To approve: add the label "${L.approved}".`,
        `To request changes: comment what to change, then add the label "${L.ready}" again (the plan is revised using your comments).`,
        'To reject: do nothing (optionally comment why); the ticket stays as it is.',
        'Nothing has been changed yet.'
    ];
    if (outcome.ticketPlan) {
      await this.richComment(
        task.id,
        planCommentAdf(outcome.ticketPlan, {
          version: saved.version,
          readyLabel: L.ready,
          approvedLabel: L.approved,
          promptVersion: outcome.promptVersion,
          costUsd: outcome.costUsd,
          repoFacts: outcome.repoFacts
        }),
        plainPlanLines,
        outcome.text
      );
    } else {
      await this.comment(task.id, plainPlanLines, outcome.text);
    }
    await this.toPhase(task.id, 'plan_review', clear, `plan v${saved.version ?? 1}`);
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
      await this.deps.jira.updateLabels(task.id, [], [L.approved]);
      await this.comment(task.id, [`"${L.approved}" was added before a change plan existed. Drafting the plan first; approve it once you have reviewed it.`]);
      return this.handleReady(task);
    }

    if (this.config.codingEnabled && !this.config.codingEnabled()) {
      // The approval itself is recorded (who, when, which plan version) so the plan is locked and
      // the flow is complete; only the coding step waits. Re-adding the label once coding is on
      // starts implementation from this approved plan.
      this.deps.log(`${task.id}: approved, but the coding phase is switched off → approval recorded, not started`);
      if (this.config.dryRun) return 'skipped';
      await this.deps.jira.updateLabels(task.id, [], [L.approved]);
      if (!plan.approvedAt) {
        plan.approvedBy = (await this.deps.jira.getLabelAdder(task.id, L.approved).catch(() => undefined)) || 'unknown';
        plan.approvedAt = new Date().toISOString();
        this.savePlan(plan);
      }
      const v = plan.version ? ` v${plan.version}` : '';
      await this.toPhase(task.id, 'approved', [], `plan${v} approved by ${plan.approvedBy}; coding switched off`);
      await this.comment(task.id, [
        `Change plan${v} approved by ${plan.approvedBy} at ${plan.approvedAt}. The plan is now locked.`,
        `The coding phase is switched off for now, so no branch, code or PR was created.`,
        `When coding is switched on, add the label "${L.approved}" again to start implementation from this plan.`
      ]);
      return 'skipped';
    }

    const attempts = this.deps.attempts(task.id);
    if (attempts >= this.config.maxAttempts) {
      this.deps.log(`${task.id}: retry limit reached (${attempts}/${this.config.maxAttempts})`);
      if (this.config.dryRun) return 'retry-limit';
      await this.comment(task.id, [
        `Not started: ${attempts} implementation attempts already made (limit ${this.config.maxAttempts}). Handing over to a person.`
      ]);
      await this.toPhase(task.id, 'needs_human', [L.approved], `retry limit (${attempts})`);
      return 'retry-limit';
    }

    this.deps.log(`${task.id}: approved → implementing (attempt ${attempts + 1}/${this.config.maxAttempts})`);
    if (this.config.dryRun) return 'implemented-no-pr';

    if (!plan.approvedAt) {
      plan.approvedBy = (await this.deps.jira.getLabelAdder(task.id, L.approved).catch(() => undefined)) || 'unknown';
      plan.approvedAt = new Date().toISOString();
      this.savePlan(plan);
    }

    await this.toPhase(task.id, 'coding', [L.approved], `attempt ${attempts + 1}, approved by ${plan.approvedBy}`);
    await this.comment(task.id, [
      `Plan approved by ${plan.approvedBy}. Implementation started: tests first, then the code, then the repo's verify steps.`
    ]);

    // Fresh ticket data (description/comments may have changed), carrying the approved plan.
    const fresh = await this.deps.jira.getTask(task.id);
    fresh.metadata = {
      ...(fresh.metadata || {}),
      approvedPlans: plan.plans,
      // With a structured plan, the plan (not keyword routing) decides repos and order.
      ...(plan.ticketPlan
        ? {
            approvedRepos: plan.repos,
            approvedRepoDependencies: plan.repoDependencies || {},
            // The coding agent builds exactly the approved ACs and test plan (one work item per repo).
            workItems: workItemsForCoding(plan.ticketPlan, fresh.title)
          }
        : {})
    };
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
        [`Implementation stopped: ${result.status}.`, `Reason: ${result.error ?? '-'}`, ...(verify.length ? ['Verify:', ...verify] : []), `A person needs to look at this. To retry with the same approved plan, add the label "${L.approved}" again.`],
        failedCheck || undefined
      );
      await this.toPhase(task.id, 'needs_human', [], `implementation stopped: ${result.status}`);
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
      await this.toPhase(task.id, 'pr_open', [], links.map((l) => l.url).join(' '));
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
    await this.toPhase(task.id, 'done', [], 'verified, no PR');
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
