import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AutomationWatcher,
  DEFAULT_LABELS,
  buildPrDescription,
  type PlanOutcome,
  type WatcherConfig,
  type WatcherDeps,
  type WatcherJira
} from '../src/automation/watcher.js';
import { BitbucketClient } from '../src/integrations/bitbucket/bitbucket-client.js';
import { JiraClient, commentAdf } from '../src/integrations/jira/jira-client.js';
import type { OrchestratorResult, TaskInput } from '../src/models/types.js';

// Everything is faked: no Jira, Bitbucket, git or Claude calls.

const jobsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-'));
afterAll(() => fs.rmSync(jobsRoot, { recursive: true, force: true }));

const L = DEFAULT_LABELS;
const ticket = (id: string, labels: string[]): TaskInput => ({
  id,
  title: `Title ${id}`,
  description: 'desc',
  acceptanceCriteria: ['AC one'],
  metadata: { labels, url: `https://x.atlassian.net/browse/${id}` }
});

class FakeJira implements WatcherJira {
  comments: Array<{ key: string; lines: string[]; pre?: string }> = [];
  labelOps: Array<{ key: string; add: string[]; remove: string[] }> = [];
  transitions: string[] = [];
  constructor(public tickets: TaskInput[]) {}
  async searchTasks() { return this.tickets; }
  async getTask(key: string) { return { ...this.tickets.find((t) => t.id === key)! }; }
  async addComment(key: string, lines: string[], pre?: string) { this.comments.push({ key, lines, pre }); }
  async updateLabels(key: string, add: string[] = [], remove: string[] = []) { this.labelOps.push({ key, add, remove }); }
  async transition(key: string, status: string) { this.transitions.push(`${key}->${status}`); return true; }
  async getLabelAdder() { return 'Tech Lead'; }
}

const okResult = (id: string): OrchestratorResult => ({
  taskId: id,
  success: true,
  status: 'COMPLETED',
  durationMs: 1,
  teamResult: { success: true, executionPlan: [], repoResults: [{ repoId: 'gb', success: true, changedFiles: ['src/a.ts', 'tests/a.test.ts'], providerUsed: 'claude-code', reasoning: '', message: '' }] },
  testingResult: { overallSuccess: true, summary: 'ok', repoResults: [{ repoId: 'gb', success: true, summary: 'ok', checks: [{ name: 'verify:test', passed: true }] }] },
  branches: [{ repoId: 'gb', workdir: '/w', managedByGit: true, branch: 'ai/t2-1', commit: 'abc123' }]
});

function setup(tickets: TaskInput[], overrides: Partial<WatcherDeps> = {}, config: Partial<WatcherConfig> = {}) {
  const jobsDir = fs.mkdtempSync(path.join(jobsRoot, 'jobs-'));
  const jira = new FakeJira(tickets);
  const calls = { plan: 0, implement: [] as TaskInput[], publish: 0 };
  const deps: WatcherDeps = {
    jira,
    jobsDir,
    log: () => {},
    attempts: () => 0,
    plan: async (): Promise<PlanOutcome> => {
      calls.plan++;
      return { status: 'ready', repos: ['gb'], plans: { gb: { summary: 'do it' } }, text: 'CHANGE PLAN TEXT' };
    },
    implement: async (task) => {
      calls.implement.push(task);
      return okResult(task.id);
    },
    publish: async () => {
      calls.publish++;
      return { links: [{ repoId: 'gb', url: 'https://bitbucket.org/rosstech/gb/pull-requests/7', existing: false }], skipped: [] };
    },
    ...overrides
  };
  const watcher = new AutomationWatcher(
    { jql: 'labels in (ai-ready, ai-approved)', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, ...config },
    deps
  );
  return { watcher, jira, calls, jobsDir };
}

describe('AutomationWatcher', () => {
  it('ai-ready → drafts the plan, posts it to Jira, waits for approval (no code changes)', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', [L.ready])]);
    const report = await watcher.runOnce();

    expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'planned' }]);
    expect(calls.plan).toBe(1);
    expect(calls.implement).toHaveLength(0);
    expect(jira.comments[0].pre).toBe('CHANGE PLAN TEXT');
    expect(jira.comments[0].lines.join(' ')).toMatch(/add the label "ai-approved"/);
    // Only the human trigger is removed; no system label is added. The phase is in our store.
    // Claimed first (label removed before any AI work), then the phase change removes nothing new.
    expect(jira.labelOps[0]).toEqual({ key: 'T2-1', add: [], remove: [L.ready] });
    expect(jira.labelOps.every((op) => op.add.length === 0)).toBe(true);
    expect(watcher.sessions.get('T2-1')?.phase).toBe('plan_review');
    expect(watcher.sessions.get('T2-1')?.history.map((h) => h.phase)).toEqual(['planning', 'plan_review']);
    expect(watcher.readPlan('T2-1')?.plans.gb.summary).toBe('do it');
  });

  it('ai-approved → implements with the approved plan, opens a PR, comments the link', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', [L.ready])]);
    await watcher.runOnce(); // plan
    jira.tickets = [ticket('T2-1', [L.approved])];

    const report = await watcher.runOnce();

    expect(report.actions).toEqual([{ ticket: 'T2-1', action: 'implemented-pr' }]);
    expect(calls.implement[0].metadata?.approvedPlans).toEqual({ gb: { summary: 'do it' } });
    expect(calls.publish).toBe(1);
    const last = jira.comments.at(-1)!.lines.join('\n');
    expect(last).toContain('https://bitbucket.org/rosstech/gb/pull-requests/7');
    expect(last).toMatch(/nothing is merged or deployed automatically/);
    expect(jira.labelOps).toContainEqual({ key: 'T2-1', add: [], remove: [L.approved] });
    expect(jira.labelOps.every((op) => op.add.length === 0)).toBe(true);
    expect(watcher.sessions.get('T2-1')?.phase).toBe('pr_open');
    expect(watcher.sessions.get('T2-1')?.history.map((h) => h.phase)).toEqual(['planning', 'plan_review', 'coding', 'pr_open']);
    expect(watcher.readPlan('T2-1')?.approvedBy).toBe('Tech Lead');
  });

  it('a waiting ticket (plan pending, not approved) is left alone', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', ['some-other-label'])]);
    const report = await watcher.runOnce();
    expect(report.actions[0].action).toBe('skipped');
    expect(calls.plan + calls.implement.length).toBe(0);
    expect(jira.comments).toHaveLength(0);
  });

  it('approval without a plan on record plans first instead of implementing blind', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', [L.approved])]);
    const report = await watcher.runOnce();
    expect(report.actions[0].action).toBe('planned');
    expect(calls.implement).toHaveLength(0);
    expect(jira.labelOps[0]).toEqual({ key: 'T2-1', add: [], remove: [L.approved] });
  });

  it('duplicate / no repo / planning error → explains in Jira and hands to a human', async () => {
    for (const [status, action] of [['duplicate', 'duplicate'], ['no-repo', 'no-repo'], ['error', 'failed']] as const) {
      const { watcher, jira } = setup([ticket('T2-1', [L.ready])], {
        plan: async () => ({ status, reason: 'why', repos: [], plans: {}, text: '' })
      });
      const report = await watcher.runOnce();
      expect(report.actions[0].action).toBe(action);
      expect(jira.labelOps.at(-1)).toEqual({ key: 'T2-1', add: [], remove: [L.ready] });
      expect(watcher.sessions.get('T2-1')?.phase).toBe('needs_human');
      expect(jira.comments).toHaveLength(1);
    }
  });

  it('failed verification → comment with the failing check output, ai-needs-human, no PR', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', [L.ready])], {
      implement: async (task) => ({
        ...okResult(task.id),
        success: false,
        status: 'TEST_FAILED',
        error: '0/1 repositories passed',
        testingResult: { overallSuccess: false, summary: 'x', repoResults: [{ repoId: 'gb', success: false, summary: 'x', checks: [{ name: 'verify:test', passed: false, error: 'AssertionError: expected 2 to be 1' }] }] }
      })
    });
    await watcher.runOnce();
    jira.tickets = [ticket('T2-1', [L.approved])];
    const report = await watcher.runOnce();

    expect(report.actions[0].action).toBe('failed');
    expect(calls.publish).toBe(0);
    expect(jira.comments.at(-1)!.pre).toContain('AssertionError: expected 2 to be 1');
    expect(watcher.sessions.get('T2-1')?.phase).toBe('needs_human');
    expect(watcher.sessions.get('T2-1')?.detail).toMatch(/TEST_FAILED/);
  });

  it('stops at the retry limit', async () => {
    const { watcher, calls } = setup([ticket('T2-1', [L.ready])], { attempts: () => 3 });
    await watcher.runOnce();
    const jira2 = (watcher as any).deps.jira as FakeJira;
    jira2.tickets = [ticket('T2-1', [L.approved])];
    const report = await watcher.runOnce();
    expect(report.actions[0].action).toBe('retry-limit');
    expect(calls.implement).toHaveLength(0);
  });

  it('no PR when the repo is not a git clone: says why and labels ai-done', async () => {
    const { watcher, jira } = setup([ticket('T2-1', [L.ready])], {
      publish: async () => ({ links: [], skipped: ['gb: not a git clone, changes were applied in place'] })
    });
    await watcher.runOnce();
    jira.tickets = [ticket('T2-1', [L.approved])];
    const report = await watcher.runOnce();
    expect(report.actions[0].action).toBe('implemented-no-pr');
    expect(jira.comments.at(-1)!.lines.join(' ')).toContain('not a git clone');
    expect(watcher.sessions.get('T2-1')?.phase).toBe('done');
  });

  it('auto-approve mode goes straight from ai-ready to implementation', async () => {
    const { watcher, calls } = setup([ticket('T2-1', [L.ready])], {}, { autoApprove: true });
    const report = await watcher.runOnce();
    expect(report.actions[0].action).toBe('implemented-pr');
    expect(calls.plan).toBe(1);
    expect(calls.implement).toHaveLength(1);
  });

  it('dry run: reports what would happen without any Jira write or AI call', async () => {
    const { watcher, jira, calls } = setup([ticket('T2-1', [L.ready]), ticket('T2-2', ['other'])], {}, { dryRun: true });
    const report = await watcher.runOnce();
    expect(report.actions.map((a) => a.action)).toEqual(['planned', 'skipped']);
    expect(calls.plan + calls.implement.length + calls.publish).toBe(0);
    expect(jira.comments.length + jira.labelOps.length).toBe(0);
    expect(watcher.sessions.list()).toEqual([]);
  });

  it('moves the Jira status to the mapped existing workflow status, only for mapped phases', async () => {
    const map: Record<string, string> = { plan_review: 'Pending Approval', coding: 'Dev in Progress' };
    const { watcher, jira } = setup([ticket('T2-1', [L.ready])], {}, { statusForPhase: (_t, phase) => map[phase] });
    await watcher.runOnce();
    jira.tickets = [ticket('T2-1', [L.approved])];
    await watcher.runOnce();
    expect(jira.transitions).toEqual(['T2-1->Pending Approval', 'T2-1->Dev in Progress']);
  });

  it('no status mapping: Jira status is never touched', async () => {
    const { watcher, jira } = setup([ticket('T2-1', [L.ready])]);
    await watcher.runOnce();
    expect(jira.transitions).toEqual([]);
  });

  it('PR description contains ticket, approved plan, files and verify results', () => {
    const md = buildPrDescription(ticket('T2-1', []), okResult('T2-1'), { ticketId: 'T2-1', createdAt: '', repos: ['gb'], plans: {}, text: 'PLAN BODY', approvedBy: 'Tech Lead' }, 'gb');
    expect(md).toContain('## T2-1: Title T2-1');
    expect(md).toContain('approved by Tech Lead');
    expect(md).toContain('PLAN BODY');
    expect(md).toContain('`tests/a.test.ts`');
    expect(md).toContain('✅ verify:test');
  });
});

describe('BitbucketClient', () => {
  it('refuses to push anything but ai/* branches', async () => {
    const git: string[][] = [];
    const envs: Array<Record<string, string> | undefined> = [];
    const bb = new BitbucketClient({ token: 't', git: async (_c, a, env) => (git.push(a), envs.push(env), '') });
    await expect(bb.pushBranch('/w', 'main', { workspace: 'ws', repo: 'r' })).rejects.toThrow(/only ai\/\* ticket branches/);
    await expect(bb.pushBranch('/w', 'develop', { workspace: 'ws', repo: 'r' })).rejects.toThrow();
    await bb.pushBranch('/w', 'ai/t2-547', { workspace: 'ws', repo: 'r' });
    expect(git[0]).toEqual(['push', 'https://bitbucket.org/ws/r.git', 'ai/t2-547:ai/t2-547']);
    // The token travels in the environment, never on the command line (errors and `ps` show argv)
    expect(git[0].join(' ')).not.toMatch(/Bearer|Authorization|x-token-auth/);
    expect(envs[0]).toEqual({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Bearer t' });
  });

  it('creates a PR with the right payload, or reuses an open one', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let open = false;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (!init?.method) {
        return new Response(JSON.stringify({ values: open ? [{ id: 5, links: { html: { href: 'https://bb/pr/5' } } }] : [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 9, links: { html: { href: 'https://bb/pr/9' } } }), { status: 201 });
    }) as typeof fetch;
    const bb = new BitbucketClient({ token: 'tok', fetchImpl });
    const input = { workspace: 'rosstech', repo: 'gb', sourceBranch: 'ai/t2-547', destinationBranch: 'develop', title: 'T2-547: x', description: 'd' };

    expect(await bb.createPullRequest(input)).toEqual({ id: 9, url: 'https://bb/pr/9', existing: false });
    const post = requests.find((r) => r.init?.method === 'POST')!;
    expect(post.url).toBe('https://api.bitbucket.org/2.0/repositories/rosstech/gb/pullrequests');
    expect(JSON.parse(String(post.init!.body))).toMatchObject({
      source: { branch: { name: 'ai/t2-547' } },
      destination: { branch: { name: 'develop' } },
      close_source_branch: true
    });
    expect((post.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok');

    open = true;
    expect(await bb.createPullRequest(input)).toEqual({ id: 5, url: 'https://bb/pr/5', existing: true });
  });

  it('is not configured without credentials', () => {
    const saved = { ...process.env };
    delete process.env.BITBUCKET_TOKEN;
    delete process.env.BITBUCKET_EMAIL;
    delete process.env.BITBUCKET_API_TOKEN;
    try {
      expect(new BitbucketClient().configured).toBe(false);
    } finally {
      process.env = saved;
    }
  });
});

describe('Jira write-back', () => {
  const make = (handler: (url: string, init?: RequestInit) => Response) => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => (calls.push({ url, init }), handler(url, init))) as typeof fetch;
    return { calls, jira: new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'bot@x', apiToken: 't', fetchImpl }) };
  };

  it('posts comments as ADF with the plan in a code block', async () => {
    const { calls, jira } = make(() => new Response('{}', { status: 201 }));
    await jira.addComment('T2-1', ['line one'], 'PLAN');
    expect(calls[0].url).toBe('https://x.atlassian.net/rest/api/3/issue/T2-1/comment');
    expect(JSON.parse(String(calls[0].init!.body)).body).toEqual(commentAdf(['line one'], 'PLAN'));
    expect(commentAdf(['a'], 'P').content?.[1]).toEqual({ type: 'codeBlock', content: [{ type: 'text', text: 'P' }] });
  });

  it('updates labels (204 No Content) and transitions by status name', async () => {
    const { calls, jira } = make((url, init) =>
      url.endsWith('/transitions') && !init?.method
        ? new Response(JSON.stringify({ transitions: [{ id: '31', name: 'Start', to: { name: 'In Progress' } }] }), { status: 200 })
        : new Response(null, { status: 204 })
    );
    await jira.updateLabels('T2-1', ['ai-plan-pending'], ['ai-ready']);
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ update: { labels: [{ add: 'ai-plan-pending' }, { remove: 'ai-ready' }] } });
    expect(await jira.transition('T2-1', 'in progress')).toBe(true);
    expect(JSON.parse(String(calls.at(-1)!.init!.body))).toEqual({ transition: { id: '31' } });
    expect(await jira.transition('T2-1', 'Done')).toBe(false);
  });

  it('finds who added a label from the changelog', async () => {
    const { jira } = make(() =>
      new Response(
        JSON.stringify({
          values: [
            { author: { displayName: 'Someone' }, items: [{ field: 'labels', fromString: '', toString: 'ai-ready' }] },
            { author: { displayName: 'Tech Lead' }, items: [{ field: 'labels', fromString: 'ai-plan-pending', toString: 'ai-plan-pending ai-approved' }] }
          ]
        }),
        { status: 200 }
      )
    );
    expect(await jira.getLabelAdder('T2-1', 'ai-approved')).toBe('Tech Lead');
  });
});

describe('Jira comment format (ADF)', () => {
  it('puts version at the top level of the doc, as Jira requires (attrs.version is rejected with INVALID_INPUT)', () => {
    const doc = commentAdf(['line one', '', 'line two'], 'PLAN') as unknown as Record<string, unknown>;
    expect(doc.type).toBe('doc');
    expect(doc.version).toBe(1);
    expect(doc.attrs).toBeUndefined();
    expect((doc.content as Array<{ type: string }>).map((n) => n.type)).toEqual(['paragraph', 'paragraph', 'codeBlock']);
  });
});

describe('Temporary AI failures are retried, not handed to a person', () => {
  it('retry-later keeps the trigger label, posts nothing and records the wait', async () => {
    const { watcher, jira } = setup([ticket('T2-1', [L.ready])], {
      plan: async () => ({ status: 'retry-later', reason: "You've hit your session limit", repos: [], plans: {}, text: '' })
    });
    const report = await watcher.runOnce();
    expect(report.actions[0].action).toBe('skipped');
    expect(jira.comments).toHaveLength(0);
    // claimed, then put back for the next cycle
    expect(jira.labelOps).toEqual([{ key: 'T2-1', add: [], remove: [L.ready] }, { key: 'T2-1', add: [L.ready], remove: [] }]);
    expect(watcher.sessions.get('T2-1')?.detail).toMatch(/waiting to retry/);
  });
});
