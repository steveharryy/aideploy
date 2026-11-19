import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QaAgent, qaArgs, parseQaReply, type QaFinding, type QaInput } from '../src/agents/qa/qa-agent.js';
import type { WorkItem } from '../src/agents/coding/work-item.js';
import type { ClaudeCodeRunner } from '../src/providers/claude-code-provider.js';
import {
  AutomationWatcher,
  DEFAULT_LABELS,
  mergeFindings,
  nextFindingNumber,
  withQaFindings,
  type PlanOutcome,
  type QaContext,
  type WatcherDeps,
  type WatcherJira
} from '../src/automation/watcher.js';
import type { OrchestratorResult, QaStepResult, TaskInput } from '../src/models/types.js';

// AI QA: a separate agent verifies the change; code decides what its answer means. No Claude, git or Jira.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-agent-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const workItem: WorkItem = {
  ticket: 'T2-9',
  workItemId: 'W1',
  repo: 'pay',
  title: 'Validate amount',
  summary: 'Reject negative amounts',
  acceptanceCriteria: [
    { id: 'AC1', text: 'negative amount → 400' },
    { id: 'AC2', text: 'zero amount → 400' }
  ],
  testPlan: [
    { ac: 'AC1', name: 'test_AC1_negative', description: '' },
    { ac: 'AC2', name: 'test_AC2_zero', description: '' }
  ]
};

const VERIFY = [
  { name: 'install', run: 'npm ci' },
  { name: 'test', run: 'npm test' }
];

function repo(): string {
  const dir = fs.mkdtempSync(path.join(root, 'repo-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'pay.ts'), 'export const pay = 1;\n');
  return dir;
}

const reply = (obj: Record<string, unknown>) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ summary: 's', previous: [], findings: [], questions: [], ...obj }) });
const allMet = [
  { id: 'AC1', met: true, evidence: 'test_AC1_negative' },
  { id: 'AC2', met: true, evidence: 'test_AC2_zero' }
];

function run(answer: string | ((cwd: string) => string), over: Partial<QaInput> = {}) {
  const calls: Array<{ args: string[]; prompt: string }> = [];
  const runner: ClaudeCodeRunner = async (i) => {
    calls.push({ args: i.args, prompt: i.prompt });
    return typeof answer === 'string' ? answer : answer(i.cwd);
  };
  const input: QaInput = { workItem, workdir: repo(), diff: 'DIFF', checks: 'test: passed', verify: VERIFY, round: 1, nextId: 1, ...over };
  return { promise: new QaAgent({ runner, bin: 'claude' }).review(input), calls, input };
}

const prevDefect = (over: Partial<QaFinding> = {}): QaFinding => ({ id: 'F1', type: 'defect', repo: 'pay', criterion: 'AC2', title: 'zero accepted', status: 'open', round: 1, ...over });

describe('QaAgent: the verdict is decided by code', () => {
  it('every AC met, no findings → pass', async () => {
    const r = await run(reply({ acResults: allMet })).promise;
    expect(r.verdict).toBe('pass');
    expect(r.findings).toEqual([]);
  });

  it('a defect → fail; findings are numbered by the pipeline from nextId', async () => {
    const r = await run(reply({ acResults: allMet, findings: [{ type: 'defect', criterion: 'AC2', title: 'zero accepted', expected: '400', actual: '200', repro: 'test_AC2_zero' }] }), { nextId: 4 }).promise;
    expect(r.verdict).toBe('fail');
    expect(r.findings).toMatchObject([{ id: 'F4', type: 'defect', status: 'open', round: 1, repo: 'pay', expected: '400', actual: '200' }]);
  });

  it('an AC reported not met (without a defect) or not checked at all still blocks', async () => {
    const r = await run(reply({ acResults: [{ id: 'AC1', met: false, evidence: 'no test' }] })).promise;
    expect(r.verdict).toBe('fail');
    expect(r.findings.map((f) => f.title)).toEqual(['AC1 is not met', 'AC2 was not verified by QA']);
  });

  it('unclear spec → needs_input (product) with questions; flaky → needs_input (infra), not a loop', async () => {
    const amb = await run(reply({ acResults: allMet, findings: [{ type: 'spec_ambiguity', title: 'Is 0.001 zero?' }], questions: ['Should 0.001 be rejected?'] })).promise;
    expect(amb).toMatchObject({ verdict: 'needs_input', tag: 'product', questions: ['Should 0.001 be rejected?'] });
    const flaky = await run(reply({ acResults: allMet, findings: [{ type: 'flaky', title: 'DB timeout in test_AC1' }] })).promise;
    expect(flaky).toMatchObject({ verdict: 'needs_input', tag: 'infra' });
  });

  it('pre-existing failures and out-of-scope bugs do not block', async () => {
    const r = await run(
      reply({
        acResults: allMet,
        findings: [
          { type: 'defect', title: 'old date test fails', repro: 'tests/old.test.ts > date' },
          { type: 'out_of_scope', title: 'refund rounding bug' }
        ]
      }),
      { preExistingFailures: ['tests/old.test.ts > date'] }
    ).promise;
    expect(r.verdict).toBe('pass');
    expect(r.findings.map((f) => [f.type, f.status])).toEqual([
      ['pre_existing', 'waived'],
      ['out_of_scope', 'waived']
    ]);
  });

  it('re-entry: previous defects are re-checked by ID; fixed → pass', async () => {
    const { promise, calls } = run(reply({ acResults: allMet, previous: [{ id: 'F1', status: 'fixed' }] }), { previous: [prevDefect()], round: 2, nextId: 2 });
    const r = await promise;
    expect(calls[0].prompt).toContain('Check these FIRST, by ID');
    expect(calls[0].prompt).toContain('F1 [defect, open] zero accepted');
    expect(r.verdict).toBe('pass');
    expect(r.findings).toMatchObject([{ id: 'F1', status: 'fixed', round: 1 }]);
  });

  it('the same finding failing twice (still open, or not confirmed fixed) → escalate', async () => {
    const still = await run(reply({ acResults: allMet, previous: [{ id: 'F1', status: 'still_open' }] }), { previous: [prevDefect()], round: 2 }).promise;
    expect(still.verdict).toBe('escalate');
    expect(still.reason).toMatch(/F1 failed again after a fix loop/);
    const silent = await run(reply({ acResults: allMet }), { previous: [prevDefect()], round: 2 }).promise;
    expect(silent.verdict).toBe('escalate');
  });

  it('never edits code: a file it changes is restored and reported', async () => {
    const { promise, input } = run((cwd) => (fs.writeFileSync(path.join(cwd, 'src', 'pay.ts'), 'HACKED\n'), reply({ acResults: allMet })));
    const r = await promise;
    expect(fs.readFileSync(path.join(input.workdir, 'src', 'pay.ts'), 'utf-8')).toBe('export const pay = 1;\n');
    expect(r.restoredFiles).toEqual(['src/pay.ts']);
  });

  it('read-only tools plus only the repo test command; unreadable answers twice → escalate', async () => {
    const args = qaArgs(VERIFY);
    expect(args.slice(args.indexOf('--disallowedTools'))).toEqual(expect.arrayContaining(['Edit', 'Write']));
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Glob', 'Grep', 'Bash(npm test:*)']);
    const { promise, calls } = run(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'not json' }));
    const r = await promise;
    expect(calls).toHaveLength(2);
    expect(r.verdict).toBe('escalate');
    expect(parseQaReply('{"summary":"x"}')).toBeUndefined();
  });
});

// ── Watcher: AI Dev ⇄ AI QA loop ────────────────────────────────────────────

const qaResult = (verdict: QaStepResult['verdict'], findings: QaStepResult['reports'][number]['findings'], extra: Partial<QaStepResult['reports'][number]> = {}): QaStepResult => ({
  verdict,
  reason: `${verdict} reason`,
  reports: [{ repo: 'pay', round: findings[0]?.round ?? 1, verdict, reason: `${verdict} reason`, summary: 'sum', findings, acResults: [], questions: [], restoredFiles: [], ...extra }]
});
const defect = (id: string, round: number, status: 'open' | 'fixed' = 'open') => ({ id, type: 'defect' as const, repo: 'pay', criterion: 'AC2', title: `defect ${id}`, status, round });

const okRun = (id: string, qa?: QaStepResult): OrchestratorResult => ({
  taskId: id,
  success: true,
  status: 'COMPLETED',
  durationMs: 1,
  teamResult: { success: true, executionPlan: [], repoResults: [{ repoId: 'pay', success: true, changedFiles: ['src/pay.ts'], providerUsed: 'coding-agent', reasoning: '', message: '' }] },
  testingResult: { overallSuccess: true, summary: 'ok', repoResults: [] },
  branches: [{ repoId: 'pay', workdir: '/w', managedByGit: true, branch: 'ai/t2-1', commit: 'abc' }],
  ...(qa ? { qaResult: qa } : {})
});
const qaFail = (id: string, qa: QaStepResult): OrchestratorResult => ({ ...okRun(id), success: false, status: 'QA_FAILED', error: qa.reason, qaResult: qa });

function setupWatcher(runs: Array<(task: TaskInput, qa?: QaContext) => OrchestratorResult>, maxLoops = 3) {
  const jobsDir = fs.mkdtempSync(path.join(root, 'jobs-'));
  const ticket: TaskInput = { id: 'T2-1', title: 'Validate amount', description: 'd', acceptanceCriteria: ['a'], metadata: { labels: [DEFAULT_LABELS.ready] } };
  const comments: string[][] = [];
  const jira: WatcherJira = {
    async searchTasks() { return [ticket]; },
    async getTask() { return { ...ticket, metadata: { ...ticket.metadata } }; },
    async addComment(_k, lines) { comments.push(lines); },
    async updateLabels() {},
    async transition() { return true; },
    async getLabelAdder() { return 'Approver'; }
  };
  const implementCalls: Array<{ task: TaskInput; qa?: QaContext }> = [];
  let attemptsMade = 0;
  const deps: WatcherDeps = {
    jira,
    jobsDir,
    log: () => {},
    attempts: () => attemptsMade,
    plan: async (): Promise<PlanOutcome> => ({ status: 'ready', repos: ['pay'], plans: { pay: { summary: 'do it' } }, text: 'PLAN' }),
    implement: async (task, _onStage, qa) => {
      implementCalls.push({ task, qa });
      attemptsMade++;
      return runs[Math.min(implementCalls.length - 1, runs.length - 1)](task, qa);
    },
    publish: async () => ({ links: [{ repoId: 'pay', url: 'https://bitbucket.org/ws/pay/pull-requests/9', existing: false }], skipped: [] }),
    qaEnabled: () => true,
    qaMaxLoops: () => maxLoops
  };
  const watcher = new AutomationWatcher({ jql: 'x', labels: DEFAULT_LABELS, autoApprove: false, maxAttempts: 3, dryRun: false }, deps);
  const approve = async () => {
    await watcher.runOnce(); // plan
    ticket.metadata = { labels: [DEFAULT_LABELS.approved] };
    return watcher.runOnce();
  };
  const plan = () => JSON.parse(fs.readFileSync(path.join(jobsDir, 'T2-1', 'plan.json'), 'utf-8'));
  return { approve, implementCalls, comments, plan, ticket, watcher, sessions: () => JSON.parse(fs.readFileSync(path.join(jobsDir, 'T2-1', 'session.json'), 'utf-8')) };
}

describe('Watcher: AI QA loop (loop_count)', () => {
  it('QA defect → back to AI Dev with the finding on the work item → QA passes → PR', async () => {
    const w = setupWatcher([
      (t) => qaFail(t.id, qaResult('fail', [defect('F1', 1)])),
      (t) => okRun(t.id, qaResult('pass', [defect('F1', 1, 'fixed')], { round: 2 }))
    ]);
    const res = await w.approve();
    expect(res.actions[0].action).toBe('implemented-pr');
    expect(w.implementCalls).toHaveLength(2);
    expect(w.implementCalls[0].qa).toEqual({ round: 1, previous: [], nextId: 1 });
    expect(w.implementCalls[1].qa).toMatchObject({ round: 2, nextId: 2, previous: [{ id: 'F1', status: 'open' }] });
    const all = w.comments.flat().join('\n');
    expect(all).toContain('AI QA round 1: FAIL');
    expect(all).toContain('Back to AI Dev automatically to fix F1 (loop 1 of 3)');
    expect(all).toContain('F1 [defect, AC2] FIXED (re-checked)');
    expect(w.plan().qa).toMatchObject({ round: 2, autoRuns: 1, findings: [{ id: 'F1', status: 'fixed' }] });
    expect(w.sessions().phase).toBe('pr_open');
  });

  it('loop_count cap: defects every round → stops after max loops, "AI could not converge", a person takes over', async () => {
    let n = 0;
    const w = setupWatcher([(t) => (n++, qaFail(t.id, qaResult('fail', [defect(`F${n}`, n)], { round: n })))], 2);
    const res = await w.approve();
    expect(w.implementCalls).toHaveLength(2);
    expect(res.actions[0].action).toBe('failed');
    expect(w.comments.flat().join('\n')).toMatch(/AI could not converge: AI QA still found defects after 2 loop\(s\)/);
    expect(w.sessions().phase).toBe('needs_human');
  });

  it('QA loop runs are not counted as human-started attempts', async () => {
    const w = setupWatcher([
      (t) => qaFail(t.id, qaResult('fail', [defect('F1', 1)])),
      (t) => qaFail(t.id, qaResult('fail', [defect('F2', 2)], { round: 2 })),
      (t) => okRun(t.id, qaResult('pass', [], { round: 3 }))
    ]);
    const res = await w.approve();
    expect(res.actions[0].action).toBe('implemented-pr');
    expect(w.implementCalls).toHaveLength(3); // maxAttempts is 3, but 2 of these were QA loops
  });

  it('unclear spec → Needs Input with the questions; no loop', async () => {
    const w = setupWatcher([(t) => qaFail(t.id, qaResult('needs_input', [{ ...defect('F1', 1), type: 'spec_ambiguity' }], { tag: 'product', questions: ['Is 0.001 zero?'] }))]);
    const res = await w.approve();
    expect(res.actions[0].action).toBe('needs-input');
    expect(w.implementCalls).toHaveLength(1);
    expect(w.comments.flat().join('\n')).toContain('pay: Is 0.001 zero?');
    expect(w.sessions().phase).toBe('needs_input');
  });

  it('same finding twice → escalated to a person', async () => {
    const w = setupWatcher([(t) => qaFail(t.id, qaResult('escalate', [defect('F1', 1)], { tag: 'technical' }))]);
    const res = await w.approve();
    expect(res.actions[0].action).toBe('failed');
    expect(w.comments.flat().join('\n')).toContain('Escalated to a person');
    expect(w.sessions().phase).toBe('needs_human');
  });
});

describe('QA finding helpers', () => {
  it('F-numbers are never reused; merge updates by ID', () => {
    expect(nextFindingNumber([])).toBe(1);
    expect(nextFindingNumber([defect('F2', 1), defect('F7', 2)])).toBe(8);
    const merged = mergeFindings([defect('F1', 1), defect('F2', 1)], qaResult('pass', [defect('F2', 1, 'fixed'), defect('F3', 2)]));
    expect(merged.map((f) => `${f.id}:${f.status}`)).toEqual(['F1:open', 'F2:fixed', 'F3:open']);
  });

  it('open defects are put on their repo work item only', () => {
    const task: TaskInput = { id: 'T', title: 't', description: '', acceptanceCriteria: [], metadata: { workItems: [{ repo: 'pay' }, { repo: 'web' }] } };
    const out = withQaFindings(task, [defect('F1', 1)]);
    const items = out.metadata!.workItems as Array<{ repo: string; qaFindings?: unknown[] }>;
    expect(items[0].qaFindings).toEqual([{ id: 'F1', title: 'defect F1', criterion: 'AC2', expected: undefined, actual: undefined, repro: undefined }]);
    expect(items[1].qaFindings).toBeUndefined();
  });
});
