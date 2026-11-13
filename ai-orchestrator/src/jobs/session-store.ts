import fs from 'node:fs';
import path from 'node:path';

/**
 * Where each ticket is in the AI pipeline. This lives in OUR store, not in Jira labels:
 * Jira keeps only the two human triggers (ai-ready, ai-approved) and its own workflow statuses.
 */
export type SessionPhase =
  | 'planning' // picked up, Planning Agent running
  | 'needs_input' // blocking questions posted, waiting for answers
  | 'needs_info' // too vague, sent back to the reporter
  | 'plan_review' // plan posted, waiting for approval
  | 'approved' // plan approved, coding about to start
  | 'coding' // coding agents running
  | 'pr_open' // verified, pull request(s) opened
  | 'done' // verified, no PR (repo not a git clone)
  | 'needs_human'; // stopped: duplicate, error, invalid plan, retry limit…

export const SESSION_PHASES: SessionPhase[] = ['planning', 'needs_input', 'needs_info', 'plan_review', 'approved', 'coding', 'pr_open', 'done', 'needs_human'];

export interface PhaseChange {
  phase: SessionPhase;
  at: string;
  detail?: string;
}

export interface Session {
  ticket: string;
  phase: SessionPhase;
  detail?: string;
  createdAt: string;
  updatedAt: string;
  /** Every phase change, oldest first (audit). */
  history: PhaseChange[];
}

/** Storage for sessions. File-based today; a DynamoDB implementation can replace it later. */
export interface SessionStore {
  get(ticket: string): Session | undefined;
  setPhase(ticket: string, phase: SessionPhase, detail?: string): Session;
  list(): Session[];
}

/** One JSON file per ticket: <jobsDir>/<ticket>/session.json, written atomically. */
export class FileSessionStore implements SessionStore {
  constructor(private jobsDir: string) {}

  private file(ticket: string): string {
    return path.join(this.jobsDir, ticket.replace(/[^A-Za-z0-9._-]/g, '_'), 'session.json');
  }

  get(ticket: string): Session | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(ticket), 'utf-8')) as Session;
    } catch {
      return undefined;
    }
  }

  setPhase(ticket: string, phase: SessionPhase, detail?: string): Session {
    const now = new Date().toISOString();
    const prev = this.get(ticket);
    const session: Session = {
      ticket,
      phase,
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      history: [...(prev?.history ?? []), { phase, at: now, ...(detail ? { detail: detail.slice(0, 500) } : {}) }].slice(-100)
    };
    const file = this.file(ticket);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2));
    fs.renameSync(tmp, file); // atomic: never a half-written session
    return session;
  }

  list(): Session[] {
    if (!fs.existsSync(this.jobsDir)) return [];
    return fs
      .readdirSync(this.jobsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.get(d.name))
      .filter((s): s is Session => !!s)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
