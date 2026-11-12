import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ServiceCatalog } from '../src/catalog/service-catalog.js';
import { ImpactAnalysisAgent } from '../src/agents/impact-analysis/agent.js';
import { JobStore, TicketLockedError } from '../src/jobs/job-store.js';
import { checkTestIntegrity, countTestCases, isTestFile } from '../src/agents/team-agent/repo-agents/test-integrity.js';
import { RepoAgentA, TeamAgent } from '../src/agents/team-agent/team-agent.js';
import { TestingAgent } from '../src/agents/testing/agent.js';
import { DeduplicationAgent } from '../src/agents/deduplication/agent.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MockAIProvider } from '../src/providers/ai-provider.js';
import { GitWorkspaceManager } from '../src/workspace/git-workspace.js';
import { qaTickets } from '../src/qa-runner.js';
import type { FileChange, TaskInput } from '../src/models/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const catalogFile = path.resolve(__dirname, '../catalog/repos.yaml');
let tmp = '';

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-pilot-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const task = (id: string, title = 'Add feature', description = 'feature'): TaskInput => ({
  id,
  title,
  description,
  acceptanceCriteria: []
});

describe('Service catalog', () => {
  it('reproduces the built-in routing exactly for every QA ticket', async () => {
    const catalog = ServiceCatalog.load(catalogFile, '/repos')!;
    const fromCatalog = new ImpactAnalysisAgent({ customRules: catalog.impactRules() });
    const builtIn = new ImpactAnalysisAgent();
    for (const t of Object.values(qaTickets)) {
      const a = await fromCatalog.analyze(t);
      const b = await builtIn.analyze(t);
      expect(a.affectedRepositories, t.id).toEqual(b.affectedRepositories);
    }
  });

  it('resolves relative and absolute repo paths and exposes the verify contract', () => {
    const catalog = new ServiceCatalog(
      { repos: [{ id: 'web', path: '/abs/web', verify: [{ name: 'lint', run: 'npm run lint' }] }, { id: 'api' }] },
      '/root'
    );
    expect(catalog.resolvePath('web')).toBe('/abs/web');
    expect(catalog.resolvePath('api')).toBe(path.resolve('/root', 'api'));
    expect(catalog.verifyCommands('web')).toEqual([{ name: 'lint', run: 'npm run lint' }]);
    expect(catalog.verifyCommands('api')).toEqual([]);
  });

  it('rejects invalid catalogs', () => {
    expect(() => new ServiceCatalog({ repos: [{ id: 'a', dependsOn: ['ghost'] }] }, '/r')).toThrow(/unknown repo "ghost"/);
    expect(() => new ServiceCatalog({ repos: [{ id: 'a' }, { id: 'a' }] }, '/r')).toThrow(/duplicate/);
    expect(() => new ServiceCatalog({ repos: [{ id: 'a' }], routes: [{ keywords: ['x'], repos: ['b'] }] }, '/r')).toThrow(/unknown repo "b"/);
  });

  it('returns undefined when the catalog file does not exist (agents keep defaults)', () => {
    expect(ServiceCatalog.load(path.join(tmp, 'missing.yaml'), '/r')).toBeUndefined();
  });
});

describe('Job store and ticket lock', () => {
  it('locks a ticket to one run and records stages', () => {
    const store = new JobStore({ jobsDir: path.join(tmp, 'jobs-1') });
    const run = store.start('RT-1', 'Title');
    expect(() => store.start('RT-1', 'Title')).toThrow(TicketLockedError);
    run.startStage('verify');
    run.endStage('verify', 'passed', 'ok');
    run.finish('COMPLETED');
    const job = store.read('RT-1')!;
    expect(job.status).toBe('COMPLETED');
    expect(job.stages).toEqual([expect.objectContaining({ name: 'verify', status: 'passed', detail: 'ok' })]);
    expect(store.readLock('RT-1')).toBeUndefined();
    const second = store.start('RT-1', 'Title'); // lock released, attempt counted
    expect(second.state.attempt).toBe(2);
    second.finish('DUPLICATE_SKIPPED');
    // The earlier COMPLETED run is preserved in history, not overwritten.
    expect(store.read('RT-1')!.history).toEqual([expect.objectContaining({ attempt: 1, status: 'COMPLETED' })]);
  });

  it('takes over a stale lock left by a dead process, but never an active one', () => {
    const dir = path.join(tmp, 'jobs-2');
    const store = new JobStore({ jobsDir: dir });
    fsSync.mkdirSync(path.join(dir, 'RT-2'), { recursive: true });
    fsSync.writeFileSync(
      path.join(dir, 'RT-2', 'lock'),
      JSON.stringify({ runId: 'old', pid: 999999, host: os.hostname(), startedAt: new Date().toISOString() })
    );
    expect(store.forceUnlock('RT-2')).toBe('removed');

    const active = store.start('RT-2', 'T');
    expect(store.forceUnlock('RT-2')).toBe('active');
    active.finish('COMPLETED');
    expect(store.forceUnlock('RT-2')).toBe('none');
  });

  it('orchestrator returns LOCKED (and does no work) when the ticket is already running', async () => {
    const store = new JobStore({ jobsDir: path.join(tmp, 'jobs-3') });
    const held = store.start('RT-3', 'T');
    let dedupCalled = false;
    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      dedupAgent: { check: async () => { dedupCalled = true; throw new Error('must not run'); }, registerCompletedTask: () => {} },
      jobStore: store,
      silent: true
    });
    const result = await orchestrator.run(task('RT-3'));
    expect(result.status).toBe('LOCKED');
    expect(dedupCalled).toBe(false);
    held.finish('COMPLETED');
  });
});

describe('Test integrity guard', () => {
  const original: Record<string, string> = {
    'tests/a.test.ts': "it('one', () => {});\nit('two', () => {});\n",
    'src/app.ts': 'export const x = 1;'
  };
  const read = async (p: string) => original[p];
  const check = (changes: FileChange[]) => checkTestIntegrity(changes, read);

  it('recognises test files', () => {
    expect(isTestFile('tests/a.ts')).toBe(true);
    expect(isTestFile('src/Button.test.tsx')).toBe(true);
    expect(isTestFile('app/test_views.py')).toBe(true);
    expect(isTestFile('src/app.ts')).toBe(false);
  });

  it('blocks deleting, skipping, focusing or removing tests', async () => {
    expect(await check([{ path: 'tests/a.test.ts', action: 'delete' }])).toHaveLength(1);
    expect((await check([{ path: 'tests/a.test.ts', action: 'modify', content: "it.skip('one', () => {});\nit('two', () => {});" }]))[0]).toMatch(/\.skip/);
    expect((await check([{ path: 'tests/a.test.ts', action: 'modify', content: "it.only('one', () => {});\nit('two', () => {});" }]))[0]).toMatch(/\.only/);
    expect((await check([{ path: 'tests/a.test.ts', action: 'modify', content: "it('one', () => {});\n// it('two', () => {});" }]))[0]).toMatch(/removes or comments out 1/);
  });

  it('allows adding tests and changing non-test files', async () => {
    expect(await check([{ path: 'tests/a.test.ts', action: 'modify', content: original['tests/a.test.ts'] + "it('three', () => {});" }])).toEqual([]);
    expect(await check([{ path: 'tests/new.test.ts', action: 'create', content: "test('x', () => {});" }])).toEqual([]);
    expect(await check([{ path: 'src/app.ts', action: 'delete' }])).toEqual([]);
    expect(countTestCases("it('a')\n/* it('b') */\ntest('c')")).toBe(2);
  });

  it('repo agent writes nothing when the change set weakens tests', async () => {
    const repo = path.join(tmp, 'integrity-repo');
    await fs.mkdir(path.join(repo, 'tests'), { recursive: true });
    await fs.writeFile(path.join(repo, 'tests', 'a.test.ts'), original['tests/a.test.ts']);
    const provider = new MockAIProvider(async () => ({
      providerName: 'mock',
      reasoning: '',
      fileChanges: [
        { path: 'src/fix.ts', action: 'create', content: 'x' },
        { path: 'tests/a.test.ts', action: 'delete' }
      ]
    }));
    const result = await new RepoAgentA(provider, repo).execute(task('T-1'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Test integrity violation/);
    await expect(fs.access(path.join(repo, 'src', 'fix.ts'))).rejects.toThrow();
    await expect(fs.access(path.join(repo, 'tests', 'a.test.ts'))).resolves.toBeUndefined();
  });
});

describe('Verify contract', () => {
  it('runs catalog verify commands in order and stops at the first failure', async () => {
    const repo = path.join(tmp, 'verify-repo');
    await fs.mkdir(repo, { recursive: true });
    const agent = new TestingAgent({
      repoPaths: { web: repo },
      verifyCommands: () => [
        { name: 'lint', run: 'echo lint-ok' },
        { name: 'test', run: 'exit 3' },
        { name: 'smoke', run: 'echo never' }
      ]
    });
    const result = await agent.runTests(['web']);
    expect(result.overallSuccess).toBe(false);
    expect(result.repoResults[0].checks.map((c) => `${c.name}:${c.passed}`)).toEqual([
      'directory-exists:true',
      'verify:lint:true',
      'verify:test:false'
    ]);
  });

  it('uses `make verify` when the repo has that target and no catalog contract', async () => {
    const repo = path.join(tmp, 'make-repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.writeFile(path.join(repo, 'Makefile'), 'verify:\n\t@echo verified\n');
    const result = await new TestingAgent({ repoPaths: { svc: repo } }).runTests(['svc']);
    expect(result.overallSuccess).toBe(true);
    expect(result.repoResults[0].checks.map((c) => c.name)).toContain('make-verify');
  });
});

describe('Git branch + worktree per ticket', () => {
  const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

  async function makeGitRepo(name: string): Promise<string> {
    const repo = path.join(tmp, name);
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ name, type: 'module', scripts: { test: 'node -e "process.exit(0)"' } })
    );
    await fs.writeFile(path.join(repo, 'src', 'index.ts'), 'export const app = 1;\n');
    gitIn(repo, 'init', '-q', '-b', 'main');
    gitIn(repo, 'config', 'user.email', 'orchestrator-test@example.com');
    gitIn(repo, 'config', 'user.name', 'Orchestrator Test');
    gitIn(repo, 'add', '-A');
    gitIn(repo, 'commit', '-q', '-m', 'init');
    return repo;
  }

  function orchestratorFor(repo: string, jobsDir: string, worktreesDir: string) {
    const provider = new MockAIProvider();
    return new Orchestrator({
      aiProvider: provider,
      silent: true,
      dedupAgent: new DeduplicationAgent({ repoPaths: { web: repo } }),
      impactAgent: new ImpactAnalysisAgent({ customRules: [{ keywords: ['web'], repositories: ['web'], modules: [] }] }),
      teamAgent: new TeamAgent(provider, { repoPaths: { web: repo } }),
      testingAgent: new TestingAgent({ repoPaths: { web: repo } }),
      jobStore: new JobStore({ jobsDir }),
      workspace: new GitWorkspaceManager({ worktreesDir }),
      resolveRepoPath: () => repo
    });
  }

  it('implements on ai/<ticket> in a worktree, commits, and leaves the main checkout untouched', async () => {
    const repo = await makeGitRepo('web-repo');
    const worktrees = path.join(tmp, 'wt-1');
    const orchestrator = orchestratorFor(repo, path.join(tmp, 'jobs-git-1'), worktrees);

    const result = await orchestrator.run(task('FEAT-1', 'Add web banner', 'web banner'));

    expect(result.status).toBe('COMPLETED');
    const branch = result.branches![0];
    expect(branch).toMatchObject({ repoId: 'web', managedByGit: true, branch: 'ai/feat-1' });
    expect(branch.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(branch.workdir.startsWith(worktrees)).toBe(true);

    // The commit is on the ticket branch and contains the generated file.
    expect(gitIn(repo, 'show', '--name-only', '--format=%s', 'ai/feat-1')).toContain('src/features/feat-1.ts');
    expect(gitIn(repo, 'log', '-1', '--format=%s', 'ai/feat-1')).toBe('FEAT-1: Add web banner');

    // The developer's checkout (main) is unchanged and clean.
    expect(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(gitIn(repo, 'status', '--porcelain')).toBe('');
    await expect(fs.access(path.join(repo, 'src', 'features', 'feat-1.ts'))).rejects.toThrow();

    // Job state records the branch and commit.
    const job = new JobStore({ jobsDir: path.join(tmp, 'jobs-git-1') }).read('FEAT-1')!;
    expect(job.status).toBe('COMPLETED');
    expect(job.repos[0]).toMatchObject({ branch: 'ai/feat-1', commit: branch.commit });
    expect(job.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      'deduplication:passed',
      'impact-analysis:passed',
      'workspace:passed',
      'team:passed',
      'verify:passed',
      'commit:passed'
    ]);
  });

  it('does not commit when verification fails, and keeps the worktree for inspection', async () => {
    const repo = await makeGitRepo('web-repo-fail');
    await fs.writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'node -e "process.exit(1)"' } })
    );
    gitIn(repo, 'commit', '-q', '-am', 'failing tests');
    const orchestrator = orchestratorFor(repo, path.join(tmp, 'jobs-git-2'), path.join(tmp, 'wt-2'));

    const result = await orchestrator.run(task('FEAT-2', 'Add web thing', 'web thing'));

    expect(result.status).toBe('TEST_FAILED');
    expect(result.branches![0].commit).toBeUndefined();
    expect(gitIn(repo, 'rev-list', '--count', 'main..ai/feat-2')).toBe('0'); // nothing committed
    expect(gitIn(repo, 'status', '--porcelain')).toBe(''); // main checkout untouched
    await expect(fs.access(path.join(result.branches![0].workdir, 'src', 'features', 'feat-2.ts'))).resolves.toBeUndefined();
  });

  it('works in place (old behaviour) for folders that are not standalone git repos', async () => {
    const plain = path.join(tmp, 'plain-repo');
    await fs.mkdir(plain, { recursive: true });
    const ws = await new GitWorkspaceManager({ worktreesDir: path.join(tmp, 'wt-3') }).prepare(task('X-1'), 'plain', plain);
    expect(ws).toEqual({ repoId: 'plain', workdir: plain, managedByGit: false });
  });
});

describe('Handoff provider (external agent change set)', () => {
  const opts = (repoId: string) => ({
    task: task('T2-1', 'x'),
    repoContext: { repoId, repoPath: '/r', task: task('T2-1'), existingFiles: [] }
  });

  it('loads a prepared change set and labels the provider with its author', async () => {
    const { HandoffProvider } = await import('../src/providers/handoff-provider.js');
    const dir = path.join(tmp, 'handoff-1');
    await fs.mkdir(path.join(dir, 'T2-1'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'T2-1', 'web.json'),
      JSON.stringify({ author: 'claude-code', reasoning: 'why', fileChanges: [{ path: 'src/a.ts', action: 'modify', content: 'x' }] })
    );
    const res = await new HandoffProvider(dir).generateChanges(opts('web'));
    expect(res.providerName).toBe('handoff:claude-code');
    expect(res.fileChanges).toEqual([{ path: 'src/a.ts', action: 'modify', content: 'x' }]);
  });

  it('fails clearly when no change set was prepared, or it is malformed', async () => {
    const { HandoffProvider } = await import('../src/providers/handoff-provider.js');
    const dir = path.join(tmp, 'handoff-2');
    await expect(new HandoffProvider(dir).generateChanges(opts('web'))).rejects.toThrow(/no prepared change set/);
    await fs.mkdir(path.join(dir, 'T2-1'), { recursive: true });
    await fs.writeFile(path.join(dir, 'T2-1', 'web.json'), JSON.stringify({ fileChanges: [{ path: 'a.ts', action: 'modify' }] }));
    await expect(new HandoffProvider(dir).generateChanges(opts('web'))).rejects.toThrow(/missing its full file content/);
  });
});
