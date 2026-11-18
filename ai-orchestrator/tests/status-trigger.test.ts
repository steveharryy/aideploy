import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AutomationWatcher,
  DEFAULT_LABELS,
  type PlanOutcome,
  type WatcherConfig,
  type WatcherDeps,
  type WatcherJira
} from '../src/automation/watcher.js';
import type { OrchestratorResult, TaskInput } from '../src/models/types.js';
import { JiraClient } from '../src/integrations/jira/jira-client.js';

// Status-driven triggers: a ticket MOVED into "AI Planning" / "AI Dev" starts the pipeline, with no
// labels. Everything is faked: no Jira, git or Claude calls.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-trigger-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const TRIGGERS = { plan: 'AI Planning', implement: 'AI Dev' };
const PHASE_STATUS: Record<string, string> = {
  plan_review: 'Plan Review',
  needs_input: 'Needs Input',
  needs_info: 'Needs Input',
  needs_human: 'Needs Input',
  qa: 'AI QA',
  pr_open: 'Human Review'
};

const ticket = (id: string, status: string, labels: string[] = []): TaskInput => ({
  id,
  title: `Title ${id}`,
  description: 'desc',
  acceptanceCriteria: ['AC one'],
  metadata: { labels, status, url: `https://x.atlassian.net/browse/${id}` }
});

const later = () => new Date(Date.now() + 60_000).toISOString();
const earlier = () => new Date(Date.now() - 60_000).toISOString();

class FakeJira implements WatcherJira {
  comments: Array<{ key: string; lines: string[] }> = [];
  transitions: string[] = [];
  entry: { by?: string; at?: string } | undefined;
  entryError = false;
  constructor(public tickets: TaskInput[]) {}
  async searchTasks() { return this.tickets; }
  async getTask(key: string) { return { ...this.tickets.find((t) => t.id === key)! }; }
  async addComment(key: string, lines: string[]) { this.comments.push({ key, lines }); }
  async updateLabels() {}
  async transition(key: string, status: string) { this.transitions.push(`${key}->${status}`); return true; }
  async getLabelAdder() { return 'Label Person'; }
  async getStatusEntry() {
    if (this.entryError) throw new Error('changelog unavailable');
    return this.entry;
  }
}

const okResult = (id: string): OrchestratorResult => ({
  taskId: id,
  success: true,
  status: 'COMPLETED',
  durationMs: 1,
  teamResult: { success: true, executionPlan: [], repoResults: [{ repoId: 'gb', success: true, changedFiles: ['src/a.ts'], providerUsed: 'claude-code', reasoning: '', message: '' }] },
  testingResult: { overallSuccess: true, summary: 'ok', repoResults: [{ repoId: 'gb', success: true, summary: 'ok', checks: [{ name: 'verify:test', passed: true }] }] },
  branches: [{ repoId: 'gb', workdir: '/w', managedByGit: true, branch: 'ai/t2-1', commit: 'abc123' }]
});

function setup(tickets: TaskInput[], config: Partial<WatcherConfig> = {}) {
  const jobsDir = fs.mkdtempSync(path.join(root, 'jobs-'));
  const jira = new FakeJira(tickets);
  const calls = { plan: 0, implement: 0, publish: 0 };
  const deps: WatcherDeps = {
    jira,
    jobsDir,
    log: () => {},
    attempts: () => 0,
    plan: async (): Promise<PlanOutcome> => {
      calls.plan++;
      return { status: 'ready', repos: ['gb'], plans: { gb: { summary: 'do it' } }, text: 'CHANGE PLAN TEXT' };
    },
    implement: async (task, onStage) => {
      calls.implement++;
      await onStage?.('testing');
      return okResult(task.id);
    },
    publish: async () => {
      calls.publish++;
      return { links: [{ repoId: 'gb', url: 'https://bitbucket.org/ws/gb/pull-requests/7', existing: false }], skipped: [] };
    }
  };
  const watcher = new AutomationWatcher(
    {
      jql: 'status in ("AI Planning", "AI Dev")',
      labels: DEFAULT_LABELS,
      autoApprove: false,
      maxAttempts: 3,
      dryRun: false,
      statusTriggers: TRIGGERS,
      statusForPhase: (_t, phase) => PHASE_STATUS[phase],
      ...config
    },
    deps
  );
  return { watcher, jira, calls };
}

describe('status-driven triggers', () => {
  it('Backlog → AI Planning plans the ticket and moves it to Plan Review, with status wording in the comment', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Planning')]);
    jira.entry = { by: 'Reporter', at: later() };

    const report = await watcher.runOnce();

    expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'planned' }]);
    expect(calls.plan).toBe(1);
    expect(watcher.sessions.get('T2-1')?.phase).toBe('plan_review');
    expect(jira.transitions).toEqual(['T2-1->Plan Review']);
    const text = jira.comments.map((c) => c.lines.join('\n')).join('\n');
    expect(text).toContain('To approve: move the ticket to "AI Dev".');
    expect(text).toContain('move the ticket back to "AI Planning"');
    expect(text).not.toContain('add the label');
  });

  it('moving Plan Review → AI Dev approves (approver = who moved it), codes, re-tests (AI QA), opens the PR (Human Review)', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Planning')]);
    jira.entry = { by: 'Reporter', at: later() };
    await watcher.runOnce(); // plan

    jira.tickets = [ticket('T2-1', 'AI Dev')];
    jira.entry = { by: 'Tech Lead', at: later() };
    jira.transitions.length = 0;
    const report = await watcher.runOnce();

    expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'implemented-pr' }]);
    expect(calls.implement).toBe(1);
    expect(calls.publish).toBe(1);
    expect(watcher.readPlan('T2-1')?.approvedBy).toBe('Tech Lead');
    expect(watcher.sessions.get('T2-1')?.history.map((h) => h.phase)).toEqual(['planning', 'plan_review', 'coding', 'qa', 'pr_open']);
    // The ticket is already in AI Dev, so no pointless move; then AI QA and Human Review.
    expect(jira.transitions).toEqual(['T2-1->AI QA', 'T2-1->Human Review']);
  });

  it('a ticket that could not be moved on is not run again (its entry into the status was already handled)', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Planning')]);
    jira.entry = { by: 'Reporter', at: later() };
    await watcher.runOnce();
    expect(calls.plan).toBe(1);

    // The bot could not leave AI Planning (e.g. no transition); the entry is older than our last write.
    jira.entry = { by: 'Reporter', at: earlier() };
    const second = await watcher.runOnce();

    expect(second.actions).toEqual([{ ticket: 'T2-1', action: 'skipped' }]);
    expect(calls.plan).toBe(1);
  });

  it('moving the ticket back to AI Planning after a plan or an answer runs it again', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Planning')]);
    jira.entry = { at: later() };
    await watcher.runOnce();
    expect(calls.plan).toBe(1);

    jira.tickets = [ticket('T2-1', 'AI Planning')];
    jira.entry = { at: new Date(Date.now() + 120_000).toISOString() };
    await watcher.runOnce();

    expect(calls.plan).toBe(2);
    expect(watcher.sessions.get('T2-1')?.phase).toBe('plan_review');
  });

  it('a ticket still being worked on (phase coding) is left alone', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Dev')]);
    watcher.sessions.setPhase('T2-1', 'coding');
    jira.entry = { by: 'Tech Lead', at: later() };

    const report = await watcher.runOnce();

    expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'skipped' }]);
    expect(calls.implement).toBe(0);
  });

  it('fails closed when the status history cannot be read: nothing paid is started', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Planning')]);
    jira.entryError = true;

    const report = await watcher.runOnce();

    expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'skipped' }]);
    expect(calls.plan).toBe(0);
  });

  it('other statuses are ignored (Backlog, Plan Review, Human Review, Needs Input)', async () => {
    for (const status of ['Backlog', 'Plan Review', 'Human Review', 'Needs Input']) {
      const { watcher, jira, calls } = setup([ticket('T2-1', status)]);
      jira.entry = { at: later() };
      const report = await watcher.runOnce();
      expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'skipped' }]);
      expect(calls.plan + calls.implement).toBe(0);
    }
  });

  it('without status triggers configured, the status alone never starts anything (labels only)', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Planning')], { statusTriggers: undefined });
    jira.entry = { at: later() };

    const report = await watcher.runOnce();

    expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'skipped' }]);
    expect(calls.plan).toBe(0);
  });

  it('labels still work alongside status triggers', async () => {
    const { watcher, calls } = setup([ticket('T2-1', 'Backlog', [DEFAULT_LABELS.ready])]);

    await watcher.runOnce();

    expect(calls.plan).toBe(1);
  });

  it('blocking questions move the ticket to Needs Input and tell the person to move it back to AI Planning', async () => {
    const { watcher, jira } = setup([ticket('T2-1', 'AI Planning')]);
    jira.entry = { at: later() };
    (watcher as unknown as { deps: WatcherDeps }).deps.plan = async (): Promise<PlanOutcome> => ({
      status: 'needs-input',
      repos: [],
      plans: {},
      text: '',
      ticketPlan: {
        ticket: 'T2-1',
        readiness: 'blocking',
        questions: [{ id: 'Q1', text: 'Which page?', options: ['A', 'B'] }],
        assumptions: [],
        missingForReporter: [],
        warnings: []
      } as never
    });

    const report = await watcher.runOnce();

    expect(report.actions[0].action).toBe('needs-input');
    expect(jira.transitions).toEqual(['T2-1->Needs Input']);
    const text = jira.comments.map((c) => c.lines.join('\n')).join('\n');
    expect(text).toContain('move the ticket back to "AI Planning"');
  });

  it('a ticket created directly in AI Planning (no status history) is planned once, not on every poll', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', 'AI Planning')]);
    jira.entry = undefined;
    jira.transition = async () => false; // the bot cannot move it on
    await watcher.runOnce();
    await watcher.runOnce();
    await watcher.runOnce();
    expect(calls.plan).toBe(1);
  });
});

describe('Jira changelog: the newest entries are read on a long history', () => {
  it('fetches the last page when the history has more than 100 entries', async () => {
    const urls: string[] = [];
    const entry = (n: number, status: string) => ({ author: { displayName: `P${n}` }, created: `2026-11-18T10:${String(n % 60).padStart(2, '0')}:00.000+0000`, items: [{ field: 'status', toString: status }] });
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const body = url.includes('startAt=50')
        ? { values: [...Array.from({ length: 99 }, (_, i) => entry(i, 'Plan Review')), entry(150, 'AI Planning')], total: 150 }
        : { values: Array.from({ length: 100 }, (_, i) => entry(i, i === 0 ? 'AI Planning' : 'Plan Review')), total: 150 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;
    const client = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 'b', fetchImpl });
    const got = await client.getStatusEntry('T2-1', 'AI Planning');
    expect(urls.some((u) => u.includes('startAt=50'))).toBe(true);
    expect(got?.by).toBe('P150');
  });
});
