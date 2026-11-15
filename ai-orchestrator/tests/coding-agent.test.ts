import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodingAgent, parseCoderReply, parseReviewerReply } from '../src/agents/coding/coding-agent.js';
import { validateWorkItem, workItemFromTask, type WorkItem } from '../src/agents/coding/work-item.js';
import { acCoverage, acIdsIn, outOfPlanFiles, scanDebugLeftovers, scanSecrets, testNames, type CommandRunner, type TreeChange } from '../src/agents/coding/gates.js';
import { CodingAgentProvider } from '../src/providers/coding-agent-provider.js';
import type { ClaudeCodeRunner } from '../src/providers/claude-code-provider.js';

// No Claude Code process and no real npm: a fake agent edits files, a fake runner "runs tests".

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coding-agent-test-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const BUGGY = 'export function add(a: number, b: number) { return a - b; }\n';
const FIXED = 'export function add(a: number, b: number) { return a + b; }\n';
const GOOD_TESTS = `import { add } from '../src/add';\nit('test_AC1_adds_two_numbers', () => expect(add(1, 2)).toBe(3));\nit('test_AC2_handles_zero', () => expect(add(0, 5)).toBe(5));\n`;

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(root, 'repo-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'src', 'add.ts'), BUGGY);
  fs.writeFileSync(path.join(dir, 'src', 'other.ts'), 'export const other = 1;\n');
  fs.writeFileSync(path.join(dir, 'tests', 'existing.test.ts'), "it('existing behaviour', () => {});\n");
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","scripts":{"test":"vitest run"}}\n');
  return dir;
}

const workItem = (over: Partial<WorkItem> = {}): WorkItem => ({
  ticket: 'T2-9',
  workItemId: 'W1',
  repo: 'calc',
  title: 'Fix add',
  summary: 'add() must add',
  acceptanceCriteria: [
    { id: 'AC1', text: 'add(1,2) returns 3' },
    { id: 'AC2', text: 'add(0,5) returns 5' }
  ],
  testPlan: [
    { ac: 'AC1', name: 'test_AC1_adds_two_numbers', description: 'basic add' },
    { ac: 'AC2', name: 'test_AC2_handles_zero', description: 'zero' }
  ],
  plannedFiles: [{ path: 'src/add.ts', change: 'use +' }],
  ...over
});

const VERIFY = [
  { name: 'setup', run: 'npm install' },
  { name: 'typecheck', run: 'npx tsc --noEmit' },
  { name: 'test', run: 'npm test' }
];

/** Fake "npm": tests fail iff an AC test exists and add() is still buggy. */
const fakeExec: CommandRunner = async (cwd, command) => {
  const read = (p: string) => (fs.existsSync(path.join(cwd, p)) ? fs.readFileSync(path.join(cwd, p), 'utf-8') : '');
  if (command.startsWith('npx tsc')) {
    const bad = read('src/add.ts').includes('TYPE_ERROR');
    return { code: bad ? 2 : 0, output: bad ? 'src/add.ts(1,1): error TS2322: Type mismatch' : '', durationMs: 1, timedOut: false };
  }
  if (command === 'npm test') {
    const tests = fs.readdirSync(path.join(cwd, 'tests')).map((f) => read(`tests/${f}`)).join('\n');
    const hasAcTests = /AC\d/.test(tests);
    const fails = hasAcTests && read('src/add.ts').includes('a - b') && !tests.includes('TRIVIAL');
    return { code: fails ? 1 : 0, output: fails ? 'FAIL tests/add.test.ts > test_AC1_adds_two_numbers\nAssertionError: expected -1 to be 3' : 'all passed', durationMs: 1, timedOut: false };
  }
  return { code: 0, output: '', durationMs: 1, timedOut: false };
};

type Phase = 'tests' | 'implement' | 'fix' | 'review';
const phaseOf = (prompt: string): Phase =>
  prompt.includes('REVIEWER agent') ? 'review' : prompt.includes('Phase: WRITE TESTS FIRST') ? 'tests' : prompt.includes('Phase: IMPLEMENT') ? 'implement' : 'fix';

const done = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: JSON.stringify({ status: 'done', summary: 'ok', ...extra }) });
const approve = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ verdict: 'approve', findings: [], acAssessment: [], ...extra }) });

/** Builds a fake Claude whose behaviour per phase can be overridden; records every call. */
function fakeClaude(handlers: Partial<Record<Phase, (cwd: string, n: number) => string | Promise<string>>>) {
  const calls: Array<{ phase: Phase; args: string[]; prompt: string; cwd: string }> = [];
  const counts: Record<Phase, number> = { tests: 0, implement: 0, fix: 0, review: 0 };
  const defaults: Record<Phase, (cwd: string, n: number) => string> = {
    tests: (cwd) => (fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), GOOD_TESTS), done()),
    implement: (cwd) => (fs.writeFileSync(path.join(cwd, 'src', 'add.ts'), FIXED), done({ summary: 'fixed add' })),
    fix: () => done(),
    review: () => approve()
  };
  const runner: ClaudeCodeRunner = async (input) => {
    const phase = phaseOf(input.prompt);
    calls.push({ phase, args: input.args, prompt: input.prompt, cwd: input.cwd });
    counts[phase]++;
    return (handlers[phase] || defaults[phase])(input.cwd, counts[phase]);
  };
  return { runner, calls };
}

const agent = (runner: ClaudeCodeRunner, maxIterations = 3) => new CodingAgent({ runner, exec: fakeExec, maxIterations, bin: 'claude' });

describe('CodingAgent (points 4–9)', () => {
  let repo: string;
  beforeEach(() => {
    repo = makeRepo();
  });

  it('happy path: tests first (red) → implement → checks green → scope clean → review approve', async () => {
    const { runner, calls } = fakeClaude({});
    const { report, changes, diff } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });

    expect(report.status).toBe('ready_for_pr');
    // The saved diff shows exactly what changed (viewable without git).
    expect(diff).toContain('--- a/src/add.ts');
    expect(diff).toContain('+++ b/src/add.ts');
    expect(diff).toContain('--- /dev/null');
    expect(diff).toContain('+++ b/tests/add.test.ts');
    expect(report.testsFirst).toEqual({ baselinePassed: true, files: ['tests/add.test.ts'], failedBeforeChange: true });
    expect(report.acceptanceCriteria.map((a) => [a.id, a.status])).toEqual([['AC1', 'met'], ['AC2', 'met']]);
    expect(report.acceptanceCriteria[0].evidence[0]).toContain('test_AC1_adds_two_numbers');
    expect(report.checks.map((c) => `${c.name}:${c.passed}`)).toEqual(['setup:true', 'typecheck:true', 'test:true']);
    expect(report.review).toMatchObject({ verdict: 'approve', rounds: 1 });
    expect(report.iterationsUsed).toBe(0);
    expect(calls.map((c) => c.phase)).toEqual(['tests', 'implement', 'review']);
    expect(changes.map((c) => `${c.action} ${c.path}`)).toEqual(['modify src/add.ts', 'create tests/add.test.ts']);
    // The real repo is untouched; the agent worked in a sandbox.
    expect(fs.readFileSync(path.join(repo, 'src', 'add.ts'), 'utf-8')).toBe(BUGGY);
  });

  it('one continuous coder session (session-id then resume); reviewer is fresh and read-only', async () => {
    const { runner, calls } = fakeClaude({});
    await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    const [tests, impl, review] = calls;
    const id = tests.args[tests.args.indexOf('--session-id') + 1];
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(impl.args[impl.args.indexOf('--resume') + 1]).toBe(id);
    expect(review.args).toContain('--no-session-persistence');
    expect(review.args).not.toContain('--resume');
    expect(review.args.slice(review.args.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Glob', 'Grep']);
    expect(review.prompt).toContain('<diff>');
    expect(review.prompt).not.toContain('fixed add'); // reviewer never sees the coder's reasoning
  });

  it('point 4: non-test edits during tests-first are reverted automatically', async () => {
    const { runner } = fakeClaude({
      tests: (cwd) => {
        fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), GOOD_TESTS);
        fs.writeFileSync(path.join(cwd, 'src', 'other.ts'), 'export const other = 2;\n'); // sneaky
        return done();
      }
    });
    const { report, changes } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('ready_for_pr');
    expect(report.scope.revertedFiles[0]).toContain('src/other.ts');
    expect(changes.map((c) => c.path)).not.toContain('src/other.ts');
  });

  it('point 4: tests that pass on the current code are rejected (must be red first)', async () => {
    const { runner, calls } = fakeClaude({
      tests: (cwd, n) => {
        fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), GOOD_TESTS + (n === 1 ? '// TRIVIAL\n' : ''));
        return done();
      },
      fix: (cwd) => (fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), GOOD_TESTS), done())
    });
    const { report } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('ready_for_pr');
    expect(report.iterationsUsed).toBe(1);
    expect(calls.find((c) => c.phase === 'fix')!.prompt).toMatch(/PASS on the current code/);
  });

  it('point 4: every AC needs a test named for it', async () => {
    const { runner, calls } = fakeClaude({
      tests: (cwd) => (fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), "import { add } from '../src/add';\nit('test_AC1_adds', () => expect(add(1,2)).toBe(3));\n"), done()),
      fix: (cwd) => (fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), GOOD_TESTS), done())
    });
    const { report } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('ready_for_pr');
    expect(calls.find((c) => c.phase === 'fix')!.prompt).toMatch(/No test named for AC2/);
  });

  it('point 5: locked tests edited during implementation are restored', async () => {
    const { runner } = fakeClaude({
      implement: (cwd) => {
        fs.writeFileSync(path.join(cwd, 'src', 'add.ts'), FIXED);
        fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), GOOD_TESTS.replace('toBe(3)', 'toBeDefined()'));
        return done();
      }
    });
    const { report, changes } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('ready_for_pr');
    expect(report.scope.revertedFiles.join()).toContain('locked test');
    expect(changes.find((c) => c.path === 'tests/add.test.ts')!.content).toBe(GOOD_TESTS);
  });

  it('point 6: a failing check goes back to the agent with the trimmed log, then passes', async () => {
    const { runner, calls } = fakeClaude({
      implement: (cwd) => (fs.writeFileSync(path.join(cwd, 'src', 'add.ts'), FIXED + '// TYPE_ERROR\n'), done()),
      fix: (cwd) => (fs.writeFileSync(path.join(cwd, 'src', 'add.ts'), FIXED), done())
    });
    const { report } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('ready_for_pr');
    expect(report.iterationsUsed).toBe(1);
    expect(calls.find((c) => c.phase === 'fix')!.prompt).toContain('error TS2322');
    expect(report.fixRounds).toEqual([{ round: 1, phase: 'checks-and-scope', problems: ['Check "typecheck" failed:'] }]);
  });

  it('point 7: secrets, debug leftovers and unexplained out-of-plan edits are sent back', async () => {
    const { runner, calls } = fakeClaude({
      implement: (cwd) => {
        fs.writeFileSync(path.join(cwd, 'src', 'add.ts'), FIXED + "const apiKey = 'abcdef1234567890xyz';\nconsole.log('debug');\n");
        fs.writeFileSync(path.join(cwd, 'src', 'other.ts'), 'export const other = 3;\n');
        return done();
      },
      fix: (cwd) => {
        fs.writeFileSync(path.join(cwd, 'src', 'add.ts'), FIXED);
        return done({ outOfPlanReasons: { 'src/other.ts': 'shared constant had to change' } });
      }
    });
    const { report } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    const fix = calls.find((c) => c.phase === 'fix')!.prompt;
    expect(fix).toMatch(/Secret in diff: src\/add.ts/);
    expect(fix).toMatch(/Debug leftover: src\/add.ts: console.log/);
    expect(fix).toMatch(/src\/other.ts is outside the planned files/);
    expect(report.status).toBe('ready_for_pr');
    expect(report.scope.outOfPlan).toEqual([{ path: 'src/other.ts', reason: 'shared constant had to change' }]);
  });

  it('point 8: a blocked agent returns needs_input with at most 3 repo-prefixed questions', async () => {
    const { runner } = fakeClaude({
      tests: () => done({ status: 'blocked', summary: 'need a decision', questions: ['Q1?', 'Q2?', 'Q3?', 'Q4?'] })
    });
    const { report, changes, diff } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('needs_input');
    expect(report.questions).toEqual(['[calc] Q1?', '[calc] Q2?', '[calc] Q3?']);
    expect(changes).toEqual([]);
    expect(diff).toBe('');
  });

  it('point 2 (guard): plan does not match reality → escalated, nothing applied', async () => {
    const { runner } = fakeClaude({ tests: () => done({ status: 'escalate', escalation: 'getExposure is not in this repo' }) });
    const { report, changes } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('escalated');
    expect(report.escalation).toContain('not in this repo');
    expect(changes).toEqual([]);
  });

  it('point 9: reviewer blocker → fix round → second review approves', async () => {
    const { runner, calls } = fakeClaude({
      review: (_cwd, n) =>
        n === 1
          ? JSON.stringify({ type: 'result', subtype: 'success', result: JSON.stringify({ verdict: 'changes_requested', findings: [{ severity: 'blocker', file: 'src/add.ts', line: 1, issue: 'negative numbers untested' }, { severity: 'minor', issue: 'naming' }] }) })
          : approve()
    });
    const { report } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('ready_for_pr');
    expect(report.review.rounds).toBe(2);
    expect(report.iterationsUsed).toBe(1);
    expect(calls.find((c) => c.phase === 'fix')!.prompt).toContain('negative numbers untested');
    expect(calls.find((c) => c.phase === 'fix')!.prompt).not.toContain('naming'); // minor findings do not block
  });

  it('budget: problems that never get fixed end as failed with open issues (no infinite loop)', async () => {
    const { runner, calls } = fakeClaude({
      implement: (cwd) => (fs.writeFileSync(path.join(cwd, 'src', 'add.ts'), FIXED + '// TYPE_ERROR\n'), done()),
      fix: () => done()
    });
    const { report, changes } = await agent(runner, 2).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('failed');
    expect(report.iterationsUsed).toBe(2);
    expect(calls.filter((c) => c.phase === 'fix')).toHaveLength(2);
    expect(report.openIssues.join('\n')).toContain('typecheck');
    expect(changes).toEqual([]);
    fs.rmSync(report.openIssues.find((i) => i.startsWith('Sandbox kept'))!.replace('Sandbox kept for inspection: ', ''), { recursive: true, force: true });
  });

  it('sandbox keeps folders like node_modules/<pkg>/dist (installed tools work) but skips top-level dist', async () => {
    fs.mkdirSync(path.join(repo, 'node_modules', 'vitest', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', 'vitest', 'dist', 'cli.js'), '// cli');
    fs.mkdirSync(path.join(repo, 'dist'));
    fs.writeFileSync(path.join(repo, 'dist', 'build.js'), '// build output');
    let seen = { nested: false, topLevel: true };
    const { runner } = fakeClaude({
      tests: (cwd) => {
        seen = { nested: fs.existsSync(path.join(cwd, 'node_modules', 'vitest', 'dist', 'cli.js')), topLevel: fs.existsSync(path.join(cwd, 'dist')) };
        fs.writeFileSync(path.join(cwd, 'tests', 'add.test.ts'), GOOD_TESTS);
        return done();
      }
    });
    const { report } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('ready_for_pr');
    expect(seen).toEqual({ nested: true, topLevel: false });
  });

  it('red baseline (existing tests already failing) → escalated before any AI call', async () => {
    const exec: CommandRunner = async (cwd, cmd) => (cmd === 'npm test' ? { code: 1, output: 'existing failure', durationMs: 1, timedOut: false } : fakeExec(cwd, cmd, 1, {}));
    const { runner, calls } = fakeClaude({});
    const { report } = await new CodingAgent({ runner, exec, bin: 'claude' }).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('escalated');
    expect(report.summary).toMatch(/already fail before any change/);
    expect(calls).toHaveLength(0);
  });

  it('repo not green before the change (pre-existing type error) → escalated before any AI call, agent not blamed', async () => {
    const exec: CommandRunner = async (cwd, cmd) =>
      cmd.startsWith('npx tsc') ? { code: 2, output: 'tests/old.test.ts(27,3): error TS7031: implicit any', durationMs: 1, timedOut: false } : fakeExec(cwd, cmd, 1, {});
    const { runner, calls } = fakeClaude({});
    const { report } = await new CodingAgent({ runner, exec, bin: 'claude' }).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('escalated');
    expect(report.summary).toMatch(/not green before any change: verify step "typecheck"/);
    expect(report.summary).toContain('TS7031');
    expect(report.iterationsUsed).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('reviewer says changes_requested but names nothing → asked again; still nothing → fails closed', async () => {
    const empty = () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify({ verdict: 'changes_requested', findings: [], acAssessment: [] }) });
    const { runner, calls } = fakeClaude({ review: empty });
    const { report, changes } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('failed');
    expect(report.summary).toMatch(/changes requested without saying what/);
    expect(changes).toEqual([]);
    const reviews = calls.filter((c) => c.phase === 'review');
    expect(reviews).toHaveLength(2);
    expect(reviews[1].prompt).toContain('listed no findings');

    // Second answer is a real verdict → accepted.
    const { runner: r2, calls: c2 } = fakeClaude({ review: (_c, n) => (n === 1 ? empty() : approve()) });
    expect((await agent(r2).run({ workItem: workItem(), repoPath: makeRepo(), verify: VERIFY })).report.status).toBe('ready_for_pr');
    expect(c2.filter((c) => c.phase === 'review')).toHaveLength(2);
  });

  it('invalid work item → failed with clear errors, nothing run', async () => {
    const { runner, calls } = fakeClaude({});
    const { report } = await agent(runner).run({ workItem: workItem({ testPlan: [{ ac: 'AC1', name: 't', description: '' }] }), repoPath: repo, verify: VERIFY });
    expect(report.status).toBe('failed');
    expect(report.openIssues.join()).toContain('testPlan has no test for AC2');
    expect(calls).toHaveLength(0);
  });

  it('no test command in the verify contract → escalated', async () => {
    const { runner } = fakeClaude({});
    const { report } = await agent(runner).run({ workItem: workItem(), repoPath: repo, verify: [{ name: 'typecheck', run: 'npx tsc --noEmit' }] });
    expect(report.status).toBe('escalated');
  });
});

describe('Work item contract', () => {
  it('validates required fields, AC ids and test plan coverage', () => {
    expect(validateWorkItem(workItem())).toEqual([]);
    expect(validateWorkItem({})).toEqual(expect.arrayContaining(['"ticket" must be a non-empty string']));
    expect(validateWorkItem(workItem({ acceptanceCriteria: [{ id: 'X1', text: 't' }] }))).toEqual(expect.arrayContaining(['acceptanceCriteria[0].id must look like "AC1"']));
    expect(validateWorkItem(workItem({ plannedFiles: [{ path: '../etc/passwd', change: '' }] }))).toEqual(['plannedFiles[0].path must be repo-relative']);
  });

  it('builds a valid work item from a Jira task + approved plan', () => {
    const task = { id: 'T2-1', title: 'T', description: 'd', acceptanceCriteria: ['Returns 200', 'Logs nothing'] };
    const w = workItemFromTask(task, 'gb', { summary: 's', filesToChange: [{ path: 'src/a.ts', change: 'x' }], testsToAdd: [{ name: 'returns ok', covers: 'AC-1' }] });
    expect(validateWorkItem(w)).toEqual([]);
    expect(w.testPlan.map((t) => t.name)).toEqual(['test_AC1_returns_ok', 'test_AC2_logs_nothing']);
    expect(w.plannedFiles).toEqual([{ path: 'src/a.ts', change: 'x' }]);
  });

  it('uses the planning agent work item as-is when the task carries one', () => {
    const provided = workItem({ repo: 'gb' });
    const task = { id: 'T2-9', title: 'x', description: '', acceptanceCriteria: [], metadata: { workItems: [provided] } };
    expect(workItemFromTask(task, 'gb')).toBe(provided);
  });
});

describe('Deterministic gates', () => {
  const change = (p: string, before: string | undefined, after: string): TreeChange => ({ path: p, action: before === undefined ? 'create' : 'modify', before, after });

  it('finds AC ids in common test naming styles', () => {
    expect(acIdsIn('test_AC1_tied_ranks')).toEqual(['AC1']);
    expect(acIdsIn('[AC-2] returns 200')).toEqual(['AC2']);
    expect(acIdsIn('AC3: and AC12 too')).toEqual(['AC3', 'AC12']);
    expect(acIdsIn('ACCOUNT balance')).toEqual([]);
    expect(testNames("it('a', x); test(\"b\", y); describe(`c`, z)\ndef test_py_case():\nfunc TestGo(t *testing.T)")).toEqual(['a', 'b', 'c', 'test_py_case', 'TestGo']);
    expect(acCoverage([{ path: 't.ts', content: "it('test_AC1_x')" }], ['AC1', 'AC2'])).toEqual({ AC1: ['t.ts › test_AC1_x'], AC2: [] });
  });

  it('flags secrets in added lines only (and not fake test fixtures)', () => {
    expect(scanSecrets([change('src/a.ts', 'x', "x\nconst key = 'AKIAABCDEFGHIJKLMNOP';")])).toEqual(['src/a.ts: possible AWS access key']);
    expect(scanSecrets([change('src/a.ts', "password = 'already-there-long'", "password = 'already-there-long'")])).toEqual([]);
    expect(scanSecrets([change('tests/a.test.ts', undefined, "const token = 'fake-token-for-tests'")])).toEqual([]);
  });

  it('flags debug output in source files but not in tests', () => {
    expect(scanDebugLeftovers([change('src/a.ts', '', "console.log('x')")])).toEqual(['src/a.ts: console.log/debug added']);
    expect(scanDebugLeftovers([change('tests/a.test.ts', '', "console.log('x')")])).toEqual([]);
  });

  it('out-of-plan: source files not in the plan (tests and runner config are fine)', () => {
    const changes = [change('src/a.ts', '', 'x'), change('src/b.ts', '', 'x'), change('tests/b.test.ts', undefined, 'x'), change('package.json', '', 'x')];
    expect(outOfPlanFiles(changes, [{ path: 'src/a.ts' }])).toEqual(['src/b.ts']);
    expect(outOfPlanFiles(changes, undefined)).toEqual([]);
  });

  it('parses agent replies defensively', () => {
    expect(parseCoderReply('not json at all').status).toBe('done');
    expect(parseCoderReply('{"status":"blocked","questions":[]}').status).toBe('done'); // blocked without a question is not actionable
    expect(parseReviewerReply('{"verdict":"maybe"}')).toBeUndefined();
    expect(parseReviewerReply('```json\n{"verdict":"approve","findings":[{"severity":"weird","issue":"x"}]}\n```')!.findings[0].severity).toBe('minor');
  });
});

describe('CodingAgentProvider (pipeline adapter)', () => {
  it('returns file changes when ready, throws with the questions when it needs input', async () => {
    const repo = makeRepo();
    const reports: string[] = [];
    const task = { id: 'T2-9', title: 'Fix add', description: 'add must add', acceptanceCriteria: ['add(1,2) returns 3', 'add(0,5) returns 5'] };
    const opts = { task, repoContext: { repoId: 'calc', repoPath: repo, task, existingFiles: [] } };

    const diffs: string[] = [];
    const ok = new CodingAgentProvider({
      verifyFor: () => VERIFY,
      agent: { runner: fakeClaude({}).runner, exec: fakeExec, bin: 'claude' },
      onReport: (r, d) => {
        reports.push(r.status);
        diffs.push(d);
      }
    });
    const res = await ok.generateChanges(opts);
    expect(res.providerName).toBe('coding-agent');
    expect(res.fileChanges.map((c) => c.path)).toContain('src/add.ts');
    expect(diffs[0]).toContain('+++ b/src/add.ts');

    const blocked = new CodingAgentProvider({
      verifyFor: () => VERIFY,
      agent: { runner: fakeClaude({ tests: () => done({ status: 'blocked', questions: ['Which rounding?'] }) }).runner, exec: fakeExec, bin: 'claude' },
      onReport: (r) => reports.push(r.status)
    });
    await expect(blocked.generateChanges(opts)).rejects.toThrow(/NEEDS_INPUT[\s\S]*\[calc\] Which rounding\?/);
    expect(reports).toEqual(['ready_for_pr', 'needs_input']);
  });
});

describe('Work item contract files (shared with the planning agent)', () => {
  const base = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const schema = JSON.parse(fs.readFileSync(path.join(base, 'schemas', 'work-item.schema.json'), 'utf-8'));

  it('the example work item passes the validator', () => {
    const example = JSON.parse(fs.readFileSync(path.join(base, 'examples', 'work-item.example.json'), 'utf-8'));
    expect(validateWorkItem(example)).toEqual([]);
  });

  it('JSON Schema and validator agree on required fields and properties', () => {
    expect(schema.required.sort()).toEqual(['acceptanceCriteria', 'repo', 'summary', 'testPlan', 'ticket', 'title', 'workItemId']);
    const typed: Array<keyof WorkItem> = ['ticket', 'workItemId', 'repo', 'title', 'summary', 'acceptanceCriteria', 'testPlan', 'plannedFiles', 'contract', 'assumptions', 'clarifications'];
    expect(Object.keys(schema.properties).sort()).toEqual([...typed].sort());
    // Every schema-required field is enforced by the validator too.
    for (const field of schema.required) {
      const w: Record<string, unknown> = { ...workItem() };
      delete w[field];
      expect(validateWorkItem(w).length, field).toBeGreaterThan(0);
    }
  });
});

describe('CodingAgent model selection', () => {
  it('coder uses coderModel; reviewer keeps the default model', async () => {
    const { runner, calls } = fakeClaude({});
    await new CodingAgent({ runner, exec: fakeExec, bin: 'claude', coderModel: 'sonnet', model: 'opus' }).run({ workItem: workItem(), repoPath: makeRepo(), verify: VERIFY });
    const modelOf = (c: { args: string[] }) => c.args[c.args.indexOf('--model') + 1];
    expect(calls.filter((c) => c.phase !== 'review').map(modelOf)).toEqual(['sonnet', 'sonnet']);
    expect(modelOf(calls.find((c) => c.phase === 'review')!)).toBe('opus');
  });
});
