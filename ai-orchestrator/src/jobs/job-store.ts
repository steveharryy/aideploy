import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

export type StageStatus = 'running' | 'passed' | 'failed' | 'skipped';

export interface JobStage {
  name: string;
  status: StageStatus;
  startedAt: string;
  finishedAt?: string;
  detail?: string;
}

export interface JobRepoState {
  repoId: string;
  workdir: string;
  branch?: string;
  commit?: string;
  managedByGit: boolean;
}

export interface JobState {
  ticketId: string;
  title: string;
  runId: string;
  /** RUNNING while in progress, then the final OrchestrationStatus (COMPLETED, TEST_FAILED, ...). */
  status: string;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs?: number;
  stages: JobStage[];
  repos: JobRepoState[];
  error?: string;
  /** Pull requests opened for this ticket (automation). */
  pullRequests?: Array<{ repoId: string; url: string; existing: boolean }>;
  /** Summaries of earlier runs of this ticket, oldest first (never lost on re-run). */
  history?: Array<Pick<JobState, 'runId' | 'status' | 'attempt' | 'startedAt' | 'finishedAt' | 'repos' | 'error'>>;
}

interface LockInfo {
  runId: string;
  pid: number;
  host: string;
  startedAt: string;
}

export interface JobStoreConfig {
  /** Directory holding one folder per ticket (default ./.jobs). */
  jobsDir?: string;
  /** A lock older than this is treated as stale (default 2 hours). */
  lockTtlMs?: number;
}

export class TicketLockedError extends Error {
  constructor(public readonly ticketId: string, public readonly holder: LockInfo) {
    super(
      `Ticket ${ticketId} is already being processed (run ${holder.runId}, pid ${holder.pid}, started ${holder.startedAt}).`
    );
  }
}

/** Handle for one run of one ticket. All writes go through it. */
export class JobRun {
  constructor(private store: JobStore, public state: JobState) {}

  get runId(): string {
    return this.state.runId;
  }

  startStage(name: string, detail?: string): void {
    this.state.stages.push({ name, status: 'running', startedAt: new Date().toISOString(), detail });
    this.save();
  }

  endStage(name: string, status: Exclude<StageStatus, 'running'>, detail?: string): void {
    const stage = [...this.state.stages].reverse().find((s) => s.name === name && s.status === 'running');
    if (stage) {
      stage.status = status;
      stage.finishedAt = new Date().toISOString();
      if (detail) stage.detail = detail;
    } else {
      const now = new Date().toISOString();
      this.state.stages.push({ name, status, startedAt: now, finishedAt: now, detail });
    }
    this.save();
  }

  setRepo(repo: JobRepoState): void {
    const i = this.state.repos.findIndex((r) => r.repoId === repo.repoId);
    if (i >= 0) this.state.repos[i] = { ...this.state.repos[i], ...repo };
    else this.state.repos.push(repo);
    this.save();
  }

  /** Marks the run finished and releases the lock. Safe to call more than once. */
  finish(status: string, error?: string): void {
    // Close any stage left running (e.g. after an unexpected exception).
    for (const s of this.state.stages) {
      if (s.status === 'running') {
        s.status = 'failed';
        s.finishedAt = new Date().toISOString();
      }
    }
    this.state.status = status;
    this.state.error = error;
    this.state.finishedAt = new Date().toISOString();
    this.state.durationMs = Date.parse(this.state.finishedAt) - Date.parse(this.state.startedAt);
    this.save();
    this.store.releaseLock(this.state.ticketId, this.state.runId);
  }

  private save(): void {
    this.state.updatedAt = new Date().toISOString();
    this.store.write(this.state);
  }
}

/**
 * JobStore
 *
 * Persistent per-ticket job state (.jobs/<TICKET>/job.json) plus an exclusive
 * lock (.jobs/<TICKET>/lock) so a ticket can only be processed by one run at a time.
 * A lock whose process is gone, or which is older than the TTL, is considered stale
 * and taken over.
 */
export class JobStore {
  readonly jobsDir: string;
  private lockTtlMs: number;

  constructor(config: JobStoreConfig = {}) {
    this.jobsDir = config.jobsDir || path.resolve(process.cwd(), '.jobs');
    this.lockTtlMs = config.lockTtlMs ?? 2 * 60 * 60 * 1000;
  }

  private dir(ticketId: string): string {
    // Ticket keys are like RT-3006; keep the folder name filesystem-safe.
    return path.join(this.jobsDir, ticketId.replace(/[^A-Za-z0-9._-]/g, '_'));
  }

  private lockPath(ticketId: string): string {
    return path.join(this.dir(ticketId), 'lock');
  }

  jobPath(ticketId: string): string {
    return path.join(this.dir(ticketId), 'job.json');
  }

  read(ticketId: string): JobState | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.jobPath(ticketId), 'utf-8')) as JobState;
    } catch {
      return undefined;
    }
  }

  write(state: JobState): void {
    fs.mkdirSync(this.dir(state.ticketId), { recursive: true });
    const target = this.jobPath(state.ticketId);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, target); // atomic replace: readers never see a half-written file
  }

  readLock(ticketId: string): LockInfo | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.lockPath(ticketId), 'utf-8')) as LockInfo;
    } catch {
      return undefined;
    }
  }

  private isStale(lock: LockInfo): boolean {
    if (Date.now() - Date.parse(lock.startedAt) > this.lockTtlMs) return true;
    if (lock.host !== hostName()) return false; // can't check a pid on another machine
    try {
      process.kill(lock.pid, 0); // signal 0 = existence check only
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  /** Acquires the ticket lock and starts a new job run. Throws TicketLockedError if held. */
  start(ticketId: string, title: string): JobRun {
    fs.mkdirSync(this.dir(ticketId), { recursive: true });
    const lock: LockInfo = {
      runId: crypto.randomUUID(),
      pid: process.pid,
      host: hostName(),
      startedAt: new Date().toISOString()
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 'wx' = create exclusively; fails if the lock file already exists.
        fs.writeFileSync(this.lockPath(ticketId), JSON.stringify(lock), { flag: 'wx' });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const holder = this.readLock(ticketId);
        if (holder && !this.isStale(holder)) throw new TicketLockedError(ticketId, holder);
        fs.rmSync(this.lockPath(ticketId), { force: true }); // stale: take over
        if (attempt === 1) throw new Error(`Could not acquire lock for ${ticketId}.`);
      }
    }

    const previous = this.read(ticketId);
    const now = new Date().toISOString();
    const state: JobState = {
      ticketId,
      title,
      runId: lock.runId,
      status: 'RUNNING',
      attempt: (previous?.attempt ?? 0) + 1,
      startedAt: now,
      updatedAt: now,
      stages: [],
      repos: [],
      history: previous
        ? [
            ...(previous.history || []),
            {
              runId: previous.runId,
              status: previous.status,
              attempt: previous.attempt,
              startedAt: previous.startedAt,
              finishedAt: previous.finishedAt,
              repos: previous.repos,
              error: previous.error
            }
          ]
        : []
    };
    this.write(state);
    return new JobRun(this, state);
  }

  /** Releases the lock only if it still belongs to this run. */
  releaseLock(ticketId: string, runId: string): void {
    const holder = this.readLock(ticketId);
    if (holder && holder.runId === runId) {
      fs.rmSync(this.lockPath(ticketId), { force: true });
    }
  }

  /**
   * Manual recovery (`npm start -- --unlock RT-123`): removes a lock only if its run is no
   * longer alive (process gone or TTL exceeded). An active run's lock is never removed.
   */
  forceUnlock(ticketId: string): 'removed' | 'none' | 'active' {
    const holder = this.readLock(ticketId);
    if (!holder) return 'none';
    if (!this.isStale(holder)) return 'active';
    fs.rmSync(this.lockPath(ticketId), { force: true });
    return 'removed';
  }
}

function hostName(): string {
  return os.hostname();
}
