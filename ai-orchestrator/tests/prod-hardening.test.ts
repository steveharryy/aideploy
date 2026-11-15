import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AutomationWatcher, DEFAULT_LABELS, type PlanOutcome, type WatcherJira } from '../src/automation/watcher.js';
import { JiraClient } from '../src/integrations/jira/jira-client.js';
import { redactSecrets } from '../src/util/redact.js';
import { JobStore, PROCESS_INSTANCE } from '../src/jobs/job-store.js';
import type { TaskInput } from '../src/models/types.js';

// Regression tests for the production-readiness blockers. No network.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hardening-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const L = DEFAULT_LABELS;
const ticket = (id: string, labels: string[]): TaskInput => ({ id, title: `T ${id}`, description: 'd', acceptanceCriteria: [], metadata: { labels } });

function watcherWith(jira: Partial<WatcherJira>, plan: () => Promise<PlanOutcome>, extra: { stalePlanningMs?: number } = {}) {
  const calls = { plan: 0 };
  const full: WatcherJira = {
    searchTasks: async () => [ticket('T2-1', [L.ready])],
    getTask: async () => ticket('T2-1', [L.ready]),
    addComment: async () => {},
    updateLabels: async () => {},
    transition: async () => true,
    getLabelAdder: async () => 'x',
    ...jira
  };
  const w = new AutomationWatcher(
    { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, ...extra },
    {
      jira: full,
      jobsDir: fs.mkdtempSync(path.join(tmp, 'jobs-')),
      log: () => {},
      attempts: () => 0,
      plan: async () => (calls.plan++, plan()),
      implement: async () => { throw new Error('no'); },
      publish: async () => ({ links: [], skipped: [] })
    }
  );
  return { w, calls };
}

describe('B1: a ticket is claimed before any paid work', () => {
  it('if the trigger label cannot be removed, no AI run starts (no loop, no cost)', async () => {
    const { w, calls } = watcherWith(
      { updateLabels: async () => { throw new Error('Jira API 403 (the Jira account lacks permission for this action)'); } },
      async () => ({ status: 'ready', repos: [], plans: {}, text: '' })
    );
    for (let i = 0; i < 3; i++) {
      const r = await w.runOnce();
      expect(r.actions[0].action).toBe('failed');
      expect(r.actions[0].detail).toMatch(/could not claim ticket/);
    }
    expect(calls.plan).toBe(0);
  });

  it('the label is removed before planning starts', async () => {
    const order: string[] = [];
    const { w } = watcherWith(
      { updateLabels: async (_k, add = [], remove = []) => void order.push(`labels +${add.join(',')} -${remove.join(',')}`) },
      async () => (order.push('plan'), { status: 'ready', repos: [], plans: {}, text: 'P' })
    );
    await w.runOnce();
    expect(order[0]).toBe(`labels + -${L.ready}`);
    expect(order.indexOf('plan')).toBeGreaterThan(0);
  });
});

describe('B2: secrets never reach Jira comments, logs or the session store', () => {
  it('redacts auth headers, Atlassian/Anthropic tokens, URL credentials and key=value secrets', () => {
    // Fake credentials are assembled at runtime so no token-shaped literal sits in the repo
    // (secret scanners would flag it).
    const fakeAtlassian = 'ATA' + 'TT' + 'fakefakefake'.repeat(3);
    const fakeAnthropic = ['sk', 'ant', 'api03', 'fake'.repeat(6)].join('-');
    const msg = [
      'Command failed: git -c http.extraHeader=Authorization: Basic dXNlcjpzZWNyZXRzZWNyZXQ= push',
      `token ${fakeAtlassian}`,
      `key ${fakeAnthropic}`,
      'https://bot:hunter2secret@bitbucket.org/ws/r.git',
      'BITBUCKET_TOKEN=abcd1234efgh5678'
    ].join('\n');
    const out = redactSecrets(msg);
    for (const secret of ['dXNlcjpzZWNyZXRzZWNyZXQ=', fakeAtlassian, fakeAnthropic, 'hunter2secret', 'abcd1234efgh5678']) {
      expect(out, secret).not.toContain(secret);
    }
    expect(out).toContain('push'); // the useful part of the message stays
  });

  it('an error carrying a token is redacted in the Jira comment and the session', async () => {
    const comments: string[] = [];
    const { w } = watcherWith(
      { addComment: async (_k, lines) => void comments.push(lines.join('\n')) },
      async () => { throw new Error('push failed: Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'); }
    );
    await w.runOnce();
    expect(comments.join('\n')).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
    expect(comments.join('\n')).toContain('[REDACTED]');
    expect(JSON.stringify(w.sessions.get('T2-1'))).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });
});

describe('B3: Jira calls have a timeout and retry safely', () => {
  const client = (fetchImpl: typeof fetch, timeoutMs = 50) =>
    new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 't', fetchImpl, timeoutMs, sleep: async () => {} });

  it('429 is retried, honouring Retry-After, then succeeds', async () => {
    let n = 0;
    const waits: number[] = [];
    const c = new JiraClient({
      baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 't',
      sleep: async (ms) => void waits.push(ms),
      fetchImpl: (async () => (++n < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : new Response(JSON.stringify({ key: 'T2-1', fields: { summary: 's' } }), { status: 200 }))) as unknown as typeof fetch
    });
    await expect(c.getTask('T2-1')).resolves.toMatchObject({ id: 'T2-1' });
    expect(n).toBe(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it('5xx is retried for reads but NOT for creating a comment (no duplicate comments)', async () => {
    let reads = 0;
    const get = client((async () => (++reads < 2 ? new Response('', { status: 503 }) : new Response(JSON.stringify({ key: 'T2-1', fields: {} }), { status: 200 }))) as unknown as typeof fetch);
    await expect(get.getTask('T2-1')).resolves.toBeDefined();
    expect(reads).toBe(2);

    let posts = 0;
    const post = client((async () => (posts++, new Response('', { status: 503 }))) as unknown as typeof fetch);
    await expect(post.addComment('T2-1', ['x'])).rejects.toThrow(/Jira API 503/);
    expect(posts).toBe(1);
  });

  it('a hung request times out instead of blocking the queue', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout'))))) as unknown as typeof fetch;
    const started = Date.now();
    await expect(new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 't', fetchImpl: hang, timeoutMs: 30, maxAttempts: 1 }).addComment('T2-1', ['x'])).rejects.toThrow(/aborted by timeout/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('B4: locks survive restarts and pid reuse', () => {
  it('watcher lock: our pid from another process instance is stale, our live instance is not, another live process is not', async () => {
    const { watcherLockIsStale } = await import('../src/index.js');
    const f = path.join(tmp, 'watcher.lock');
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, instance: 'an-earlier-process' }));
    expect(watcherLockIsStale(f)).toBe(true);
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid, instance: PROCESS_INSTANCE }));
    expect(watcherLockIsStale(f)).toBe(false);
    fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, instance: 'x' })); // a live process that is not us
    expect(watcherLockIsStale(f)).toBe(false);
    fs.writeFileSync(f, JSON.stringify({ pid: 2 ** 22 + 12345, instance: 'x' })); // no such process
    expect(watcherLockIsStale(f)).toBe(true);
    fs.writeFileSync(f, '{half-written');
    expect(watcherLockIsStale(f)).toBe(true);
  });

  it('ticket lock left by an earlier process with the same pid is taken over', () => {
    const jobsDir = fs.mkdtempSync(path.join(tmp, 'locks-'));
    const store = new JobStore({ jobsDir });
    const run = store.start('T2-9', 'x');
    const lockFile = path.join(jobsDir, 'T2-9', 'lock');
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
    expect(lock.instance).toBe(PROCESS_INSTANCE);
    run.finish?.('failed', 'x');
    fs.writeFileSync(lockFile, JSON.stringify({ ...lock, instance: 'an-earlier-process' }));
    expect(() => store.start('T2-9', 'x')).not.toThrow();
  });
});

describe('B5: tickets left mid-run are handed to a person', () => {
  it('stale planning/coding sessions → needs_human with a Jira comment; retries and fresh runs are left alone', async () => {
    const comments: Array<{ key: string; text: string }> = [];
    const { w } = watcherWith(
      { searchTasks: async () => [], addComment: async (k, lines) => void comments.push({ key: k, text: lines.join(' ') }) },
      async () => ({ status: 'ready', repos: [], plans: {}, text: '' })
    );
    w.sessions.setPhase('T2-10', 'planning');
    w.sessions.setPhase('T2-11', 'coding');
    w.sessions.setPhase('T2-12', 'planning', 'waiting to retry: usage limit');
    w.sessions.setPhase('T2-13', 'plan_review');
    const later = Date.now() + 4 * 60 * 60 * 1000;
    const swept = await w.sweepStale(later);
    expect(swept.sort()).toEqual(['T2-10', 'T2-11']);
    expect(w.sessions.get('T2-10')?.phase).toBe('needs_human');
    expect(w.sessions.get('T2-11')?.phase).toBe('needs_human');
    expect(w.sessions.get('T2-12')?.phase).toBe('planning');
    expect(w.sessions.get('T2-13')?.phase).toBe('plan_review');
    expect(comments.find((c) => c.key === 'T2-11')?.text).toMatch(/add the label "ai-approved"/);
    expect(comments.find((c) => c.key === 'T2-10')?.text).toMatch(/add the label "ai-ready"/);
    expect(await w.sweepStale(Date.now())).toEqual([]); // nothing fresh is swept
  });
});

describe('Jira comment formatting', () => {
  it('keeps the spaces around inline labels and code in rich comments', async () => {
    const { missingInfoCommentAdf } = await import('../src/agents/planning/render-adf.js');
    const adf = missingInfoCommentAdf({ ticket: 'T2-1', missingForReporter: [] } as unknown as Parameters<typeof missingInfoCommentAdf>[0], 'ai-ready');
    const texts: string[] = [];
    const walk = (n: { text?: string; content?: unknown[] }) => { if (n.text) texts.push(n.text); (n.content ?? []).forEach((c) => walk(c as typeof n)); };
    walk(adf as never);
    const line = texts.join('');
    expect(line).toContain('Then add the label ai-ready again.');
    expect(texts).toContain('ai-ready'); // the code-marked node itself has no stray spaces
  });

  it('question numbers and option letters are separated from their text', async () => {
    const { questionsCommentAdf } = await import('../src/agents/planning/render-adf.js');
    const plan = {
      ticket: 'T2-1', assumptions: [],
      questions: [{ id: 'Q1', text: 'Which path?', options: ['Template API', 'Webhook'], defaultOption: 'Template API' }]
    } as unknown as Parameters<typeof questionsCommentAdf>[0];
    const texts: string[] = [];
    const walk = (n: { text?: string; content?: unknown[] }) => { if (n.text) texts.push(n.text); (n.content ?? []).forEach((c) => walk(c as typeof n)); };
    walk(questionsCommentAdf(plan, 'ai-ready', 1, 2) as never);
    const all = texts.join('');
    expect(all).toContain('Q1. Which path?');
    expect(all).toContain('How to answer: reply');
  });
});

describe('coding phase switch', () => {
  it('ai-approved with coding switched off: label removed, comment posted, nothing implemented', async () => {
    const comments: string[] = [];
    const removed: string[] = [];
    let implemented = 0;
    const jobsDir = fs.mkdtempSync(path.join(tmp, 'coding-off-'));
    fs.mkdirSync(path.join(jobsDir, 'T2-1'), { recursive: true });
    fs.writeFileSync(path.join(jobsDir, 'T2-1', 'plan.json'), JSON.stringify({ ticketId: 'T2-1', version: 2, text: 'P', repos: [], plans: {} }));
    const w = new AutomationWatcher(
      { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, codingEnabled: () => false },
      {
        jira: {
          searchTasks: async () => [ticket('T2-1', [L.approved])],
          getTask: async () => ticket('T2-1', [L.approved]),
          addComment: async (_k, lines) => void comments.push(lines.join(' ')),
          updateLabels: async (_k, _a = [], r = []) => void removed.push(...r),
          transition: async () => true,
          getLabelAdder: async () => 'x'
        },
        jobsDir,
        log: () => {},
        attempts: () => 0,
        plan: async () => { throw new Error('no'); },
        implement: async () => { implemented++; throw new Error('must not run'); },
        publish: async () => ({ links: [], skipped: [] })
      }
    );
    const r = await w.runOnce();
    expect(r.actions[0].detail ?? '').toBe('');
    expect(r.actions[0].action).toBe('skipped');
    expect(implemented).toBe(0);
    expect(removed).toContain(L.approved);
    expect(comments.join(' ')).toMatch(/coding phase is switched off/);
    expect(comments.join(' ')).toMatch(/plan v2 approved by x/);
    expect(w.sessions.get('T2-1')?.phase).toBe('approved');
    const saved = JSON.parse(fs.readFileSync(path.join(jobsDir, 'T2-1', 'plan.json'), 'utf-8'));
    expect(saved.approvedBy).toBe('x');
    expect(saved.approvedAt).toBeTruthy();
  });

  it('pipeline config: coding is off unless switched on', async () => {
    const { parsePipelineConfig, loadPipelineConfig } = await import('../src/config/pipeline-config.js');
    expect(parsePipelineConfig({}).coding.enabled).toBe(false);
    expect(parsePipelineConfig({ coding: { enabled: true } }).coding.enabled).toBe(true);
    expect(loadPipelineConfig(path.join(__dirname, '..', 'config', 'pipeline.yaml')).coding.enabled).toBe(false);
  });
});

describe('rejecting an approved plan', () => {
  it('ai-ready on an approved plan: approval withdrawn, approved version kept, agent gets the old plan', async () => {
    const comments: string[] = [];
    let seenPrevious: unknown;
    const jobsDir = fs.mkdtempSync(path.join(tmp, 'reopen-'));
    fs.mkdirSync(path.join(jobsDir, 'T2-1'), { recursive: true });
    const approved = { ticketId: 'T2-1', version: 2, text: 'P2', repos: [], plans: {}, ticketPlan: { ticket: 'T2-1', summary: 'old approach' }, approvedBy: 'Abhay', approvedAt: '2026-11-15T13:41:43.749Z' };
    fs.writeFileSync(path.join(jobsDir, 'T2-1', 'plan.json'), JSON.stringify(approved));
    const w = new AutomationWatcher(
      { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, codingEnabled: () => false },
      {
        jira: {
          searchTasks: async () => [ticket('T2-1', [L.ready])],
          getTask: async () => ticket('T2-1', [L.ready]),
          addComment: async (_k, lines) => void comments.push(lines.join(' ')),
          updateLabels: async () => {},
          transition: async () => true,
          getLabelAdder: async () => 'x'
        },
        jobsDir,
        log: () => {},
        attempts: () => 0,
        plan: async (t) => { seenPrevious = t.metadata?.previousPlan; return { status: 'ready', repos: [], plans: {}, text: 'P3' }; },
        implement: async () => { throw new Error('no'); },
        publish: async () => ({ links: [], skipped: [] })
      }
    );
    await w.runOnce();
    expect(comments.join(' ')).toMatch(/Approval of change plan v2 \(approved by Abhay.*withdrawn/);
    expect(seenPrevious).toMatchObject({ summary: 'old approach' });
    const kept = JSON.parse(fs.readFileSync(path.join(jobsDir, 'T2-1', 'plan.v2.json'), 'utf-8'));
    expect(kept.approvedBy).toBe('Abhay');
    const current = JSON.parse(fs.readFileSync(path.join(jobsDir, 'T2-1', 'plan.json'), 'utf-8'));
    expect(current.approvedAt).toBeUndefined();
    expect(w.sessions.get('T2-1')?.phase).toBe('plan_review');
  });
});

describe('planning → coding hand-off', () => {
  it('turns an approved plan into valid coding work items; untested ACs become notes', async () => {
    const { workItemsForCoding } = await import('../src/agents/planning/plan-rules.js');
    const { validateWorkItem } = await import('../src/agents/coding/work-item.js');
    const plan = {
      ticket: 'T2-1', summary: 's', assumptions: ['a1'], clarifications: ['Q1: A (product)'], outOfScope: ['stage 2'],
      contract: ['POST /x {id}'],
      workItems: [
        { id: 'W1', repo: 'gb-payments-api', task: 'send it', reason: 'r', confidence: 'high', dependsOn: [], filesLikelyTouched: ['src/a.ts'], approach: ['add client', 'call it'] },
        { id: 'W2', repo: 'gb-onboarding-api', task: 'docs only', reason: 'r', confidence: 'high', dependsOn: [], filesLikelyTouched: [], approach: [] }
      ],
      acceptanceCriteria: [
        { id: 'AC1', text: 'sends once', verify: 'unit_test', workItem: 'W1', source: 'ticket' },
        { id: 'AC2', text: 'baselines captured', verify: 'human', workItem: 'W1', source: 'ticket' },
        { id: 'AC3', text: 'reviewed', verify: 'human', workItem: 'W2', source: 'derived' }
      ],
      testPlan: [{ ac: 'AC1', workItem: 'W1', name: 'test_AC1_sends_once', cases: ['retry', 'restart'] }]
    } as unknown as Parameters<typeof workItemsForCoding>[0];
    const items = workItemsForCoding(plan, 'Title');
    expect(items.map((w) => w.repo)).toEqual(['gb-payments-api']); // W2 has nothing the coding agent can test
    const [w] = items;
    expect(validateWorkItem(w)).toEqual([]);
    expect(w.acceptanceCriteria).toEqual([{ id: 'AC1', text: 'sends once' }]);
    expect(w.testPlan).toEqual([{ ac: 'AC1', name: 'test_AC1_sends_once', description: 'retry; restart' }]);
    expect(w.summary).toContain('1. add client 2. call it');
    expect(w.contract).toBe('POST /x {id}');
    expect(w.assumptions?.join(' ')).toMatch(/AC2 is verified outside the code \(human\)/);
    expect(w.clarifications).toEqual(['Q1: A (product)']);
  });
});

describe('planned baseline fix (planning side)', () => {
  it('parses baseline_fix, rejects source files, passes it to the coding work item', async () => {
    const { normalizePlan, validatePlan, workItemsForCoding } = await import('../src/agents/planning/plan-rules.js');
    const raw = {
      summary: 's', readiness: 'ready', risk: 'medium', riskReason: 'r',
      workItems: [{ id: 'W1', repo: 'api', task: 't', reason: 'r', confidence: 'high', files_likely_touched: ['src/a.ts'], approach: ['x'],
        baseline_fix: { files: ['tsconfig.test.json'], reason: 'jest cannot see src/types' } }],
      acceptanceCriteria: [{ id: 'AC1', text: 'a', verify: 'unit_test', workItem: 'W1', source: 'ticket' }],
      testPlan: [{ ac: 'AC1', workItem: 'W1', name: 'test_AC1_a', cases: ['x'] }]
    };
    const plan = normalizePlan(raw, 'T2-1');
    expect(plan.workItems[0].baselineFix).toEqual({ files: ['tsconfig.test.json'], reason: 'jest cannot see src/types' });
    expect(validatePlan(plan, ['api']).join(' ')).not.toMatch(/baseline fix/);
    expect(workItemsForCoding(plan, 'T')[0].baselineFix).toEqual(plan.workItems[0].baselineFix);

    const bad = normalizePlan({ ...raw, workItems: [{ ...raw.workItems[0], baseline_fix: { files: ['src/controllers/x.ts'], reason: 'r' } }] }, 'T2-1');
    expect(validatePlan(bad, ['api']).join(' ')).toMatch(/baseline fix may only touch test files or test-runner config, not src\/controllers\/x.ts/);
  });
});

describe('revision limit after an approval is withdrawn', () => {
  it('counts revisions since the last approved version, not since v1', async () => {
    const jobsDir = fs.mkdtempSync(path.join(tmp, 'revlimit-'));
    fs.mkdirSync(path.join(jobsDir, 'T2-1'), { recursive: true });
    const { normalizePlan } = await import('../src/agents/planning/plan-rules.js');
    const ticketPlan = normalizePlan({ readiness: 'ready', workItems: [{ id: 'W1', repo: 'api', task: 't' }], acceptanceCriteria: [{ id: 'AC1', text: 'x', verify: 'unit_test' }] }, 'T2-1');
    fs.writeFileSync(path.join(jobsDir, 'T2-1', 'plan.json'), JSON.stringify({ ticketId: 'T2-1', version: 4, text: 'P', repos: [], plans: {}, ticketPlan, approvedBy: 'A', approvedAt: '2026-11-15T00:00:00Z' }));
    let planned = 0;
    const w = new AutomationWatcher(
      { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, maxPlanRevisions: 1 },
      {
        jira: {
          searchTasks: async () => [ticket('T2-1', [L.ready])],
          getTask: async () => ticket('T2-1', [L.ready]),
          addComment: async () => {},
          updateLabels: async () => {},
          transition: async () => true,
          getLabelAdder: async () => 'x'
        },
        jobsDir,
        log: () => {},
        attempts: () => 0,
        plan: async () => (planned++, { status: 'ready', repos: [], plans: {}, text: 'P', ticketPlan }),
        implement: async () => { throw new Error('no'); },
        publish: async () => ({ links: [], skipped: [] })
      }
    );
    const first = await w.runOnce();
    expect(first.actions[0].detail ?? '').toBe('');
    expect(first.actions[0].action).toBe('planned'); // v5: 1st revision since approved v4
    expect(w.readPlan('T2-1')).toMatchObject({ version: 5, lastApprovedVersion: 4 });
    expect((await w.runOnce()).actions[0].action).toBe('needs-info'); // v6 would be the 2nd
    expect(planned).toBe(1);
  });
});
