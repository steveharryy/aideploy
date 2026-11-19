import fs from 'node:fs';
import path from 'node:path';
import type { OrchestratorResult, QaStepResult, TaskInput } from '../models/types.js';
import type { ImplementationPlan } from '../providers/claude-code-provider.js';
import type { PlanQuestion, TicketPlan } from '../agents/planning/types.js';
import { againHow, renderMissing, renderQuestions } from '../agents/planning/render.js';
import { missingInfoCommentAdf, planCommentAdf, questionsCommentAdf, type AdfNode } from '../agents/planning/render-adf.js';
import { FileSessionStore, type SessionPhase, type SessionStore } from '../jobs/session-store.js';
import { redactSecrets, safeErrorMessage } from '../util/redact.js';
import { workItemsForCoding } from '../agents/planning/plan-rules.js';
import { isTemporaryClaudeFailure, limitResetHint } from '../util/claude-limits.js';
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
  /**
   * Status-driven triggers (in addition to the labels, which keep working). A ticket entering `plan`
   * starts planning; entering `implement` approves the plan and starts coding. Absent = labels only.
   */
  statusTriggers?: { plan: string; implement: string };
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
  repoFacts?: Array<{ repo: string; branch?: string; verify?: string; rollback?: string; readAt?: string }>;
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
  /** Last version that was approved (then reopened). The revision limit counts from it. */
  lastApprovedVersion?: number;
  /**
   * AI QA history for this plan: every finding (F1, F2… numbered across rounds, never reused) and
   * how many runs the QA loop started by itself (those are not counted as human-started attempts).
   */
  qa?: { round: number; findings: QaFindingRecord[]; autoRuns: number };
}

export type QaFindingRecord = QaStepResult['reports'][number]['findings'][number];

/** What an implementation run needs to know about AI QA (round, earlier findings, next F-number). */
export interface QaContext {
  round: number;
  previous: QaFindingRecord[];
  nextId: number;
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
  /** When and by whom the ticket last moved INTO a status (status-driven triggers). Optional. */
  getStatusEntry?(key: string, statusName: string): Promise<{ by?: string; at?: string } | undefined>;
  assign?(key: string, accountId: string): Promise<void>;
}

export interface WatcherDeps {
  jira: WatcherJira;
  /** Dedup + impact + read-only change plan. */
  plan(task: TaskInput): Promise<PlanOutcome>;
  /** Full pipeline with the plan already approved. */
  implement(task: TaskInput, onStage?: (stage: 'testing') => void | Promise<void>, qa?: QaContext): Promise<OrchestratorResult>;
  /** AI QA switched on (config/pipeline.yaml qa.enabled). Absent = off. */
  qaEnabled?: () => boolean;
  /** loop_count cap: QA → AI Dev loops per approval before a person takes over (default 3). */
  qaMaxLoops?: () => number;
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

  /** In-flight tickets (this process), and what the poll last saw as each ticket's Jira status. */
  private inFlight = new Set<string>();
  private currentStatus = new Map<string, string>();
  private statusActor = new Map<string, string>();

  private get statusMode(): boolean {
    return !!this.config.statusTriggers;
  }
  /** What a person types/clicks to start planning (label name, or the status to move the ticket to). */
  private readyName(): string {
    return this.config.statusTriggers?.plan ?? this.config.labels.ready;
  }
  private approvedName(): string {
    return this.config.statusTriggers?.implement ?? this.config.labels.approved;
  }
  /** "add the label "X"" (labels) or "move the ticket to "X"" (status mode). */
  private ask(kind: 'ready' | 'approved'): string {
    const name = kind === 'ready' ? this.readyName() : this.approvedName();
    return this.statusMode ? `move the ticket to "${name}"` : `add the label "${name}"`;
  }
  /** "add the label "X" again" / "move the ticket back to "X"". */
  private again(kind: 'ready' | 'approved'): string {
    return againHow(kind === 'ready' ? this.readyName() : this.approvedName(), this.statusMode);
  }
  /** Who approved: whoever moved the ticket into the implement status, else whoever added the label. */
  private async approver(task: TaskInput): Promise<string> {
    const byStatus = this.statusActor.get(task.id);
    if (byStatus) return byStatus;
    return (await this.deps.jira.getLabelAdder(task.id, this.config.labels.approved).catch(() => undefined)) || 'unknown';
  }

  /**
   * Status-driven trigger: is this ticket in the plan / implement status AND has it entered that
   * status since the pipeline last wrote to it? The second check stops a ticket that could not be
   * moved on (no transition, Jira outage) from being run again every cycle.
   */
  private async statusTrigger(task: TaskInput): Promise<'ready' | 'approved' | undefined> {
    const st = this.config.statusTriggers;
    const status = typeof task.metadata?.status === 'string' ? (task.metadata.status as string) : undefined;
    if (!st || !status) return undefined;
    const now = status.trim().toLowerCase();
    const kind = now === st.implement.trim().toLowerCase() ? 'approved' : now === st.plan.trim().toLowerCase() ? 'ready' : undefined;
    if (!kind) return undefined;
    const session = this.sessions.get(task.id);
    if (session && ['planning', 'coding', 'qa'].includes(session.phase)) return undefined; // still running
    let entry: { by?: string; at?: string } | undefined;
    try {
      entry = await this.deps.jira.getStatusEntry?.(task.id, status);
    } catch (err) {
      // Fail closed: without the change history we cannot tell a new entry from one already handled.
      this.deps.log(`${task.id}: could not read the status history, not started: ${safeErrorMessage(err)}`);
      return undefined;
    }
    // A ticket the pipeline already worked on needs a dated move into the status to run again. Without
    // one (created directly in the status, or no history support) it would be re-run on every poll.
    if (session && !entry?.at) return undefined;
    if (entry?.at && session?.updatedAt && Date.parse(entry.at) <= Date.parse(session.updatedAt)) return undefined; // already handled
    if (entry?.by) this.statusActor.set(task.id, entry.by);
    return kind;
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
    if (this.currentStatus.get(key)?.trim().toLowerCase() === status.trim().toLowerCase()) return; // already there
    try {
      const moved = await this.deps.jira.transition(key, status);
      if (moved) this.currentStatus.set(key, status);
      else this.deps.log(`${key}: workflow has no transition to "${status}" from its current status; left as is.`);
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

  /**
   * Routes a ticket by its labels, or (status mode) by the status it was moved into; any error is
   * reported on the ticket and handed to a human.
   */
  private async processTask(task: TaskInput): Promise<{ action: TicketAction; detail?: string }> {
    const L = this.config.labels;
    if (this.deps.killSwitch?.()) {
      this.deps.log(`${task.id}: kill switch is on, not started`);
      return { action: 'skipped', detail: 'kill switch on' };
    }
    if (typeof task.metadata?.status === 'string') this.currentStatus.set(task.id, task.metadata.status as string);
    const triggers = [L.approved, L.ready].filter((l) => this.hasLabel(task, l));
    const statusTrigger = triggers.length === 0 ? await this.statusTrigger(task) : undefined;
    if (triggers.length === 0 && !statusTrigger) return { action: 'skipped' };
    if (this.inFlight.has(task.id)) return { action: 'skipped', detail: 'already running' };
    this.inFlight.add(task.id);
    try {
      return await this.runTriggered(task, triggers, statusTrigger);
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  private async runTriggered(task: TaskInput, triggers: string[], statusTrigger?: 'ready' | 'approved'): Promise<{ action: TicketAction; detail?: string }> {
    const L = this.config.labels;
    // Claim first: remove the trigger label BEFORE any paid work. If Jira refuses (no Edit
    // permission, outage), nothing runs, so a ticket can never be re-planned every cycle.
    // (A status trigger is claimed by the session phase written when the run starts.)
    if (triggers.length > 0 && !this.config.dryRun) {
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
      const approved = triggers.includes(L.approved) || statusTrigger === 'approved';
      const action = approved ? await this.handleApproved(task) : await this.handleReady(task);
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
    const limits: Partial<Record<SessionPhase, number>> = {
      planning: this.config.stalePlanningMs ?? 45 * 60 * 1000,
      coding: this.config.staleCodingMs ?? 3 * 60 * 60 * 1000,
      qa: this.config.staleCodingMs ?? 3 * 60 * 60 * 1000
    };
    const swept: string[] = [];
    for (const s of this.sessions.list()) {
      const limit = limits[s.phase];
      if (!limit || now - Date.parse(s.updatedAt) < limit) continue;
      if (s.phase === 'planning' && s.detail?.startsWith('waiting to retry')) continue;
      const working = s.phase === 'coding' || s.phase === 'qa';
      const what = working ? 'implementing' : 'planning';
      const retryHow = this.ask(working ? 'approved' : 'ready');
      this.deps.log(`${s.ticket}: stuck in ${s.phase} since ${s.updatedAt} → needs_human`);
      try {
        await this.comment(s.ticket, [
          `The pipeline stopped while ${what} this ticket (no progress since ${s.updatedAt.slice(0, 16).replace('T', ' ')} UTC), probably a restart or crash.`,
          `Nothing was posted or merged. To try again, ${retryHow}.`
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
    // Revisions since the plan was last approved (or since v1): an approval resets the count,
    // so reopening an approved plan does not count the versions that were already agreed.
    const lastApprovedVersion = reopening ? prior!.version ?? 1 : prior?.lastApprovedVersion;
    if (revising && version - (lastApprovedVersion ?? 1) > maxRevisions) {
      this.deps.log(`${task.id}: plan revised ${maxRevisions} times without approval → back to reporter`);
      await this.sendBack(task, [
        `The plan for ${task.id} was revised ${maxRevisions} times without being approved.`,
        'Please clarify the ticket (expected behaviour, scope, examples) so a plan can be agreed, or plan it by hand.',
        `Then ${this.again('ready')}.`
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
          `Approval of change plan v${prior!.version ?? 1} (approved by ${prior!.approvedBy ?? 'unknown'} at ${prior!.approvedAt}) is withdrawn because ${this.statusMode ? `the ticket was moved back to "${this.readyName()}"` : `"${L.ready}" was added again`}.`,
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
        `Add a component for the target repo, or add the repo to catalog/repos.yaml, then ${this.again('ready')}.`
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
        await this.sendBack(task, renderMissing(plan, this.readyName(), this.statusMode), clear, missingInfoCommentAdf(plan, this.readyName(), this.statusMode));
        return 'needs-info';
      }
      const round = questionState.rounds + 1;
      this.saveQuestionState(task.id, { rounds: round, questions: outcome.ticketPlan.questions });
      this.deps.log(`${task.id}: ${outcome.ticketPlan.questions.length} blocking question(s) (round ${round}/${maxRounds})`);
      await this.richComment(
        task.id,
        questionsCommentAdf(outcome.ticketPlan, this.readyName(), round, maxRounds, this.statusMode),
        renderQuestions(outcome.ticketPlan, this.readyName(), round, maxRounds, this.statusMode)
      );
      await this.toPhase(task.id, 'needs_input', clear, `round ${round}: ${outcome.ticketPlan.questions.length} question(s)`);
      return 'needs-input';
    }
    if (outcome.status === 'needs-info' && outcome.ticketPlan) {
      this.deps.log(`${task.id}: too vague → back to reporter`);
      await this.sendBack(task, renderMissing(outcome.ticketPlan, this.readyName(), this.statusMode), clear, missingInfoCommentAdf(outcome.ticketPlan, this.readyName(), this.statusMode));
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
      ...(lastApprovedVersion ? { lastApprovedVersion } : {}),
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
        `To approve: ${this.ask('approved')}.`,
        `To request changes: comment what to change, then ${this.again('ready')} (the plan is revised using your comments).`,
        'To reject: do nothing (optionally comment why); the ticket stays as it is.',
        'Nothing has been changed yet.'
    ];
    if (outcome.ticketPlan) {
      await this.richComment(
        task.id,
        planCommentAdf(outcome.ticketPlan, {
          version: saved.version,
          readyLabel: this.readyName(),
          approvedLabel: this.approvedName(),
          statusMode: this.statusMode,
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
      await this.comment(task.id, [`${this.statusMode ? `The ticket was moved to "${this.approvedName()}"` : `"${L.approved}" was added`} before a change plan existed. Drafting the plan first; approve it once you have reviewed it.`]);
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
        plan.approvedBy = await this.approver(task);
        plan.approvedAt = new Date().toISOString();
        this.savePlan(plan);
      }
      const v = plan.version ? ` v${plan.version}` : '';
      await this.toPhase(task.id, 'approved', [], `plan${v} approved by ${plan.approvedBy}; coding switched off`);
      await this.comment(task.id, [
        `Change plan${v} approved by ${plan.approvedBy} at ${plan.approvedAt}. The plan is now locked.`,
        `The coding phase is switched off for now, so no branch, code or PR was created.`,
        `When coding is switched on, ${this.again('approved')} to start implementation from this plan.`
      ]);
      return 'skipped';
    }

    // Runs paused by a temporary Claude limit are not attempts.
    const paused = (this.sessions.get(task.id)?.history ?? []).filter((h) => h.detail?.startsWith('coding paused (temporary)')).length;
    // …and neither are the runs the AI QA loop started by itself (they share one approval).
    const attempts = Math.max(0, this.deps.attempts(task.id) - paused - (plan.qa?.autoRuns ?? 0));
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
      plan.approvedBy = await this.approver(task);
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
    // AI Dev ⇄ AI QA: QA defects go back to AI Dev automatically (loop_count), at most qaMaxLoops
    // times for this approval; then a person takes over. Each finding keeps its F-number for good.
    const qaOn = this.deps.qaEnabled?.() ?? false;
    const maxLoops = Math.max(1, this.deps.qaMaxLoops?.() ?? 3);
    const onStage = async (stage: 'testing') => {
      if (stage === 'testing') await this.toPhase(task.id, 'qa', [], 'AI QA: re-test and QA agent verify the change');
    };
    let loops = 0;
    let result: OrchestratorResult;
    for (;;) {
      const qaState = plan.qa ?? { round: 0, findings: [], autoRuns: 0 };
      const open = qaState.findings.filter((f) => f.type === 'defect' && f.status === 'open');
      result = await this.deps.implement(
        withQaFindings(fresh, open),
        onStage,
        qaOn ? { round: qaState.round + 1, previous: qaState.findings, nextId: nextFindingNumber(qaState.findings) } : undefined
      );
      if (!result.qaResult) break; // QA did not run (off, or the run stopped before it)
      const qa = result.qaResult;
      plan.qa = { round: qaState.round + 1, findings: mergeFindings(qaState.findings, qa), autoRuns: qaState.autoRuns };
      this.savePlan(plan);
      if (result.status !== 'QA_FAILED' || qa.verdict !== 'fail') break;
      loops++;
      if (loops >= maxLoops) break;
      plan.qa.autoRuns++;
      this.savePlan(plan);
      this.deps.log(`${task.id}: AI QA found defects → back to AI Dev (loop ${loops}/${maxLoops})`);
      await this.comment(task.id, [
        ...qaLines(qa, plan.qa.round),
        `Back to AI Dev automatically to fix ${qa.reports.flatMap((r) => r.findings.filter((f) => f.round === plan.qa!.round && f.type === 'defect' && f.status === 'open').map((f) => f.id)).join(', ')} (loop ${loops} of ${maxLoops}). Nothing was committed or pushed.`
      ]);
      await this.toPhase(task.id, 'coding', [], `AI QA loop ${loops}/${maxLoops}: fixing ${qa.reason}`);
    }

    const changed = (result.teamResult?.repoResults ?? []).map((r) => `${r.repoId}: ${r.changedFiles.join(', ') || 'no file changes'}`);
    const verify = (result.testingResult?.repoResults ?? []).flatMap((r) =>
      r.checks.filter((c) => c.name !== 'directory-exists').map((c) => `${r.repoId} ${c.name}: ${c.passed ? 'passed' : 'FAILED'}`)
    );

    if (!result.success && isTemporaryClaudeFailure(result.error)) {
      // A Claude usage/rate limit is not a failed attempt: nothing was pushed, the plan stays approved.
      // Paused (not auto-retried: each retry re-runs install/build/test before reaching Claude).
      const reset = limitResetHint(result.error);
      this.deps.log(`${task.id}: coding paused, Claude limit reached${reset ? ` (${reset})` : ''}; attempt not counted`);
      await this.comment(task.id, [
        `Implementation paused: the Claude usage limit was reached${reset ? ` (${reset})` : ''}. Nothing was pushed; the approved plan is unchanged.`,
        `This does not count as a failed attempt. Add the label "${L.approved}" again after the limit resets.`
      ]);
      await this.toPhase(task.id, 'approved', [], `coding paused (temporary): ${redactSecrets(result.error ?? '').slice(0, 160)}`);
      return 'skipped';
    }

    if (result.status === 'QA_FAILED' && result.qaResult) {
      const qa = result.qaResult;
      const round = plan.qa?.round ?? 1;
      const tag = qa.reports.find((r) => r.verdict === qa.verdict)?.tag;
      const questions = qa.reports.flatMap((r) => r.questions.map((q) => `${r.repo}: ${q}`));
      const lines = [...qaLines(qa, round)];
      let detail: string;
      if (qa.verdict === 'needs_input' && tag !== 'infra') {
        lines.push('AI QA needs an answer before it can pass this change:', ...questions.map((q) => `- ${q}`), `Reply in a comment, then ${this.again('approved')} to re-run AI Dev and AI QA with your answer.`);
        detail = `AI QA needs input [${tag ?? 'product'}]: return_to AI QA`;
      } else if (qa.verdict === 'needs_input') {
        lines.push('Tagged infra: this looks like an environment or flaky-test problem, not the change. It does not count as a loop. DevOps should check it, then ' + this.again('approved') + '.');
        detail = 'AI QA needs input [infra]: flaky or environment failure';
      } else if (qa.verdict === 'fail') {
        lines.push(`AI could not converge: AI QA still found defects after ${loops} loop(s) back to AI Dev (limit ${maxLoops}). A person takes over: fix by hand, clarify the ticket and ${this.again('approved')}, or discard.`);
        detail = `AI QA: could not converge after ${loops} loop(s)`;
      } else {
        lines.push(`Escalated to a person: ${qa.reason}`);
        detail = `AI QA escalated [${tag ?? 'technical'}]: ${qa.reason}`;
      }
      this.deps.log(`${task.id}: ${detail}`);
      await this.comment(task.id, lines);
      await this.toPhase(task.id, qa.verdict === 'needs_input' && tag !== 'infra' ? 'needs_input' : 'needs_human', [], detail);
      return qa.verdict === 'needs_input' ? 'needs-input' : 'failed';
    }

    if (!result.success) {
      const failedCheck = (result.testingResult?.repoResults ?? [])
        .flatMap((r) => r.checks.filter((c) => !c.passed).map((c) => `${r.repoId} ${c.name}:\n${(c.error || c.output || '').trim().split('\n').slice(-15).join('\n')}`))
        .join('\n\n');
      await this.comment(
        task.id,
        [`Implementation stopped: ${result.status}.`, `Reason: ${result.error ?? '-'}`, ...(verify.length ? ['Verify:', ...verify] : []), ...(failedCheck.includes('[infra]') ? ['Tagged infra: different tests failed on each run, so this looks like an environment or flaky-test problem, not the change. DevOps should check it.'] : []), `A person needs to look at this. To retry with the same approved plan, ${this.again('approved')}.`],
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
        ...(result.qaResult ? qaLines(result.qaResult, plan.qa?.round ?? 1, true) : []),
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
/** The next free finding number: F-numbers are never reused across rounds. */
export function nextFindingNumber(findings: QaFindingRecord[]): number {
  return findings.reduce((n, f) => Math.max(n, Number(/^F(\d+)$/i.exec(f.id)?.[1] ?? 0)), 0) + 1;
}

/** Earlier findings updated by this QA run (by ID), plus its new ones. */
export function mergeFindings(previous: QaFindingRecord[], qa: QaStepResult): QaFindingRecord[] {
  const byId = new Map(previous.map((f) => [f.id, f]));
  for (const f of qa.reports.flatMap((r) => r.findings)) byId.set(f.id, f);
  return [...byId.values()].sort((a, b) => nextFindingNumber([a]) - nextFindingNumber([b]));
}

/** The ticket for the next AI Dev run, with each repo's open QA defects on its work item. */
export function withQaFindings(task: TaskInput, open: QaFindingRecord[]): TaskInput {
  const items = task.metadata?.workItems as Array<Record<string, unknown> & { repo: string }> | undefined;
  if (!open.length || !items) return task;
  return {
    ...task,
    metadata: {
      ...task.metadata,
      workItems: items.map((w) => {
        const mine = open.filter((f) => f.repo === w.repo);
        return mine.length
          ? { ...w, qaFindings: mine.map((f) => ({ id: f.id, title: f.title, criterion: f.criterion, expected: f.expected, actual: f.actual, repro: f.repro })) }
          : w;
      })
    }
  };
}

/** AI QA result as Jira comment lines: verdict, then every finding of this round and re-checked ones. */
export function qaLines(qa: QaStepResult, round: number, passed = false): string[] {
  const label: Record<string, string> = { defect: 'defect', spec_ambiguity: 'unclear spec', flaky: 'flaky / environment', pre_existing: 'already failing before', out_of_scope: 'out of scope' };
  const lines = [`AI QA round ${round}: ${qa.verdict.toUpperCase()}. ${qa.reason}`];
  for (const r of qa.reports) {
    const shown = r.findings.filter((f) => f.round === round || f.status === 'fixed' || (f.type === 'defect' && f.status === 'open'));
    if (r.summary) lines.push(`${r.repo}: ${r.summary}`);
    for (const f of shown) {
      const state = f.round === round ? (f.status === 'open' ? 'open' : f.status === 'waived' ? 'not blocking' : f.status) : f.status === 'fixed' ? 'FIXED (re-checked)' : 'STILL OPEN (re-checked)';
      lines.push(
        `- ${f.id} [${label[f.type] ?? f.type}${f.criterion ? `, ${f.criterion}` : ''}] ${state}: ${f.title}${f.expected ? ` | expected: ${f.expected}` : ''}${f.actual ? ` | actual: ${f.actual}` : ''}${f.repro ? ` | repro: ${f.repro}` : ''}${f.file ? ` | ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`
      );
    }
    if (r.restoredFiles.length) lines.push(`- The QA agent changed ${r.restoredFiles.join(', ')}; restored (QA never edits code).`);
  }
  const followUps = qa.reports.flatMap((r) => r.findings.filter((f) => f.round === round && f.type === 'out_of_scope'));
  if (followUps.length) lines.push(`Suggested follow-up ticket(s), not part of this change: ${followUps.map((f) => `${f.id} ${f.title}`).join('; ')}`);
  if (passed && !lines.slice(1).some((l) => l.startsWith('- '))) lines.push('No findings.');
  return lines;
}

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
  if (r.baselineFix) {
    lines.push(
      `${bold('Step 0, test baseline fix (approved in the plan):')} ${r.baselineFix.reason}. Changed: ${r.baselineFix.files.map(code).join(', ') || 'nothing'}${r.baselineFix.reverted.length ? `; reverted (not allowed): ${r.baselineFix.reverted.map(code).join(', ')}` : ''}`
    );
  }
  if (r.preExistingFailures) {
    const t = r.preExistingFailures.tests;
    lines.push(
      `${bold('Already failing before this change (not blocking, not caused by it):')} ${t.length} test(s) on the base branch: ${t.slice(0, 5).map(code).join(', ')}${t.length > 5 ? ` (+${t.length - 5} more)` : ''}. Worth a separate ticket.`
    );
  }
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
