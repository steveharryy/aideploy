import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeProvider, type ClaudeCodeRunner } from '../src/providers/claude-code-provider.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MockAIProvider } from '../src/providers/ai-provider.js';
import type { ImpactAnalysisResult, TaskInput } from '../src/models/types.js';

// All tests use a fake runner: no Claude Code process is spawned, nothing is billed.

let tmp = '';
let repo = '';

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-code-provider-'));
  repo = path.join(tmp, 'web');
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.mkdir(path.join(repo, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'keep.ts'), 'export const keep = 1;\n');
  await fs.writeFile(path.join(repo, 'src', 'edit.ts'), 'export const v = 1;\n');
  await fs.writeFile(path.join(repo, 'src', 'remove.ts'), 'export const r = 1;\n');
  await fs.writeFile(path.join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const task: TaskInput = {
  id: 'T2-999',
  title: 'Batch lookups',
  description: 'Make it faster',
  acceptanceCriteria: ['Uses one pipeline call', 'Missing field does not crash'],
  metadata: { comments: [{ author: 'Lead', created: '2026-11-11T10:00:00Z', body: 'Keep the response shape.' }] }
};

const generate = (provider: ClaudeCodeProvider) =>
  provider.generateChanges({
    task,
    repoContext: { repoId: 'web', repoPath: repo, task, existingFiles: [] }
  });

const okResult = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done: 2 tests added.', num_turns: 7, total_cost_usd: 0.42, ...extra });

describe('ClaudeCodeProvider', () => {
  it('works in a sandbox copy and returns only the files it changed', async () => {
    let seen: Parameters<ClaudeCodeRunner>[0] | undefined;
    const runner: ClaudeCodeRunner = async (input) => {
      seen = input;
      // The "agent" edits, creates and deletes files in the sandbox, and also touches ignored artefacts.
      await fs.writeFile(path.join(input.cwd, 'src', 'edit.ts'), 'export const v = 2;\n');
      await fs.mkdir(path.join(input.cwd, 'tests'), { recursive: true });
      await fs.writeFile(path.join(input.cwd, 'tests', 'edit.test.ts'), "it('v', () => {});\n");
      await fs.rm(path.join(input.cwd, 'src', 'remove.ts'));
      await fs.writeFile(path.join(input.cwd, 'package-lock.json'), '{}');
      await fs.writeFile(path.join(input.cwd, 'node_modules', 'dep', 'index.js'), 'changed');
      return okResult();
    };

    const res = await generate(new ClaudeCodeProvider({ runner, bin: 'claude' }));

    expect(res.providerName).toBe('claude-code');
    expect(res.fileChanges).toEqual([
      { path: 'src/edit.ts', action: 'modify', content: 'export const v = 2;\n' },
      { path: 'src/remove.ts', action: 'delete' },
      { path: 'tests/edit.test.ts', action: 'create', content: "it('v', () => {});\n" }
    ]);
    expect(res.reasoning).toContain('Done: 2 tests added.');
    expect(res.reasoning).toContain('turns: 7');

    // The real repo was never touched; the sandbox was a different folder and is cleaned up.
    expect(await fs.readFile(path.join(repo, 'src', 'edit.ts'), 'utf-8')).toBe('export const v = 1;\n');
    await expect(fs.access(path.join(repo, 'src', 'remove.ts'))).resolves.toBeUndefined();
    expect(seen!.cwd).not.toBe(repo);
    await expect(fs.access(seen!.cwd)).rejects.toThrow();
  });

  it('runs with restricted tools, no MCP servers and no secrets in the environment', async () => {
    let seen: Parameters<ClaudeCodeRunner>[0] | undefined;
    process.env.JIRA_API_TOKEN = 'jira-secret';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-no-credits';
    try {
      await generate(new ClaudeCodeProvider({ runner: async (i) => ((seen = i), okResult()) }));
    } finally {
      delete process.env.JIRA_API_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }

    expect(seen!.args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--permission-mode', 'acceptEdits']));
    expect(seen!.args).toContain('WebFetch'); // disallowed
    expect(seen!.args.join(' ')).not.toMatch(/Bash\(\*|Bash\)/); // never unrestricted Bash
    expect(seen!.env.JIRA_API_TOKEN).toBeUndefined();
    expect(seen!.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen!.env.PATH).toBeDefined();
  });

  it('gives the agent the ticket, acceptance criteria, comments, tests-first rule and verify commands', () => {
    const provider = new ClaudeCodeProvider({
      runner: async () => okResult(),
      verifyCommandsFor: () => ['npx tsc --noEmit', 'npm test'],
      repoPurposeFor: () => 'Homepage API'
    });
    const prompt = provider.buildPrompt(task, 'web');
    expect(prompt).toContain('T2-999');
    expect(prompt).toContain('AC-1. Uses one pipeline call');
    expect(prompt).toContain('AC-2. Missing field does not crash');
    expect(prompt).toContain('Keep the response shape.');
    expect(prompt).toMatch(/FAIL on the current code/);
    expect(prompt).toContain('- npx tsc --noEmit');
    expect(prompt).toContain('Homepage API');
  });

  it('reports agent failures and keeps the sandbox for inspection', async () => {
    const provider = new ClaudeCodeProvider({
      runner: async () => JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'gave up' })
    });
    const err = await generate(provider).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/agent run failed \(error_max_turns\)/);
    const kept = /sandbox kept at (\S+)\]/.exec((err as Error).message)![1];
    await expect(fs.access(kept)).resolves.toBeUndefined();
    await fs.rm(kept, { recursive: true, force: true });
  });
});

describe('Plan preview and approval gate', () => {
  const impact: ImpactAnalysisResult = {
    taskId: 'T2-999',
    affectedRepositories: ['web'],
    affectedModules: [],
    affectedFiles: [],
    confidence: 1,
    reasoning: ''
  };
  const deps = (onTeam: () => void) => ({
    aiProvider: new MockAIProvider(),
    silent: true,
    dedupAgent: { check: async () => ({ taskId: 'T2-999', status: 'new' as const, reason: 'new' }), registerCompletedTask: () => {} },
    impactAgent: { analyze: async () => impact },
    teamAgent: { coordinate: async () => (onTeam(), { success: true, repoResults: [], executionPlan: [] }) },
    testingAgent: { runTests: async () => ({ overallSuccess: true, repoResults: [], summary: 'ok' }) }
  });

  it('plan() returns dedup + impact without running any code-writing stage', async () => {
    let teamCalled = false;
    const preview = await new Orchestrator(deps(() => (teamCalled = true))).plan(task);
    expect(preview.deduplication.status).toBe('new');
    expect(preview.impact?.affectedRepositories).toEqual(['web']);
    expect(teamCalled).toBe(false);
  });

  it('stops with PLAN_REJECTED and writes nothing when the plan is not approved', async () => {
    let teamCalled = false;
    let asked: ImpactAnalysisResult | undefined;
    const orchestrator = new Orchestrator({
      ...deps(() => (teamCalled = true)),
      approvePlan: async (_t, i) => ((asked = i), false)
    });
    const result = await orchestrator.run(task);
    expect(result.status).toBe('PLAN_REJECTED');
    expect(asked?.affectedRepositories).toEqual(['web']);
    expect(teamCalled).toBe(false);
  });

  it('continues normally when the plan is approved', async () => {
    let teamCalled = false;
    const orchestrator = new Orchestrator({ ...deps(() => (teamCalled = true)), approvePlan: async () => true });
    const result = await orchestrator.run(task);
    expect(result.status).toBe('COMPLETED');
    expect(teamCalled).toBe(true);
  });
});

describe('ClaudeCodeProvider planning (read-only, before approval)', () => {
  const planJson = {
    summary: 'Batch Redis reads',
    approach: ['add bulk reader', 'refactor builder'],
    filesToChange: [{ path: 'src/a.ts', change: 'add getBulk' }],
    testsToAdd: [{ name: 'pipelineGet once', covers: 'AC-1' }],
    acCoverage: [{ ac: 'AC-1', how: 'one pipeline call' }],
    behaviourChanges: 'none',
    openQuestions: []
  };

  it('reads the real repo with read-only tools only and parses the JSON plan', async () => {
    let seen: Parameters<ClaudeCodeRunner>[0] | undefined;
    const provider = new ClaudeCodeProvider({
      runner: async (i) => ((seen = i), okResult({ result: '```json\n' + JSON.stringify(planJson) + '\n```' })),
      verifyCommandsFor: () => ['npm test']
    });

    const { plan, stats } = await provider.proposePlan(task, 'web', repo);

    expect(plan.summary).toBe('Batch Redis reads');
    expect(plan.filesToChange?.[0].path).toBe('src/a.ts');
    expect(stats).toContain('turns: 7');
    expect(seen!.cwd).toBe(repo); // reads the real repo, no sandbox needed
    const allowed = seen!.args.slice(seen!.args.indexOf('--allowedTools') + 1);
    expect(allowed).toEqual(['Read', 'Glob', 'Grep']);
    expect(seen!.args).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash'])); // explicitly disallowed
    expect(seen!.prompt).toMatch(/READ-ONLY/);
    expect(seen!.prompt).toContain('AC-1. Uses one pipeline call');
    // Nothing in the repo changed.
    expect(await fs.readFile(path.join(repo, 'src', 'edit.ts'), 'utf-8')).toBe('export const v = 1;\n');
  });

  it('falls back to the raw text when the agent does not return JSON', async () => {
    const provider = new ClaudeCodeProvider({ runner: async () => okResult({ result: 'Plan: change two files.' }) });
    const { plan } = await provider.proposePlan(task, 'web', repo);
    expect(plan.raw).toBe('Plan: change two files.');
  });

  it('passes the approved plan to the coding step', () => {
    const provider = new ClaudeCodeProvider({ runner: async () => okResult() });
    const approvedTask: TaskInput = { ...task, metadata: { ...task.metadata, approvedPlans: { web: planJson } } };
    const prompt = provider.buildPrompt(approvedTask, 'web');
    expect(prompt).toContain('<approved_plan>');
    expect(prompt).toContain('add getBulk');
    expect(provider.buildPrompt(task, 'web')).not.toContain('<approved_plan>');
  });
});
