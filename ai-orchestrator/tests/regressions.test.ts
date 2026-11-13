import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MockAIProvider } from '../src/providers/ai-provider.js';
import { DeduplicationAgent } from '../src/agents/deduplication/agent.js';
import { ImpactAnalysisAgent, matchesKeyword } from '../src/agents/impact-analysis/agent.js';
import { TeamAgent, RepoAgent } from '../src/agents/team-agent/team-agent.js';
import { TestingAgent } from '../src/agents/testing/agent.js';
import type { ImpactAnalysisResult, RepoExecutionResult, TaskInput } from '../src/models/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let tmpDir = '';
let root = '';

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-regress-'));
  root = path.join(tmpDir, 'repositories');
  await fs.cp(path.resolve(__dirname, '../repositories'), root, { recursive: true });
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const task = (id: string, title: string, description = '', acceptanceCriteria: string[] = []): TaskInput => ({
  id,
  title,
  description,
  acceptanceCriteria
});

const impactFor = (repos: string[]): ImpactAnalysisResult => ({
  taskId: 'T',
  affectedRepositories: repos,
  affectedModules: [],
  affectedFiles: [],
  confidence: 1,
  reasoning: ''
});

const okAgent = (order: string[]) => (repoId: string, repoPath: string) => ({
  repoId,
  repoPath,
  execute: async (): Promise<RepoExecutionResult> => {
    order.push(repoId);
    return { repoId, success: true, changedFiles: [], providerUsed: 'mock', reasoning: '', message: '' };
  }
});

describe('Regression: impact analysis routing', () => {
  it('matches whole words only (no "pay"→"payload", "all"→"install")', () => {
    expect(matchesKeyword('send payload to client', 'pay')).toBe(false);
    expect(matchesKeyword('install push banner', 'all')).toBe(false);
    expect(matchesKeyword('allows existing orders', 'order')).toBe(true); // plural ok
    expect(matchesKeyword('across all services', 'all services')).toBe(true);
    expect(matchesKeyword('update repo-a config', 'repo-a')).toBe(true);
  });

  it('routes ORD-201-style text only to repo-b', async () => {
    const impact = await new ImpactAnalysisAgent().analyze(
      task('ORD-201', 'Add cancel order endpoint', 'Add cancelOrder to the order service', [
        'Allows existing orders to transition to CANCELLED state'
      ])
    );
    expect(impact.affectedRepositories).toEqual(['repo-b']);
  });

  it('routes via Jira labels/components in metadata', async () => {
    const t = task('RT-1', 'Homepage tweak', 'Change copy');
    t.metadata = { labels: ['repo-c'], components: [] };
    expect((await new ImpactAnalysisAgent().analyze(t)).affectedRepositories).toEqual(['repo-c']);
  });

  describe('specific beats generic (T2-590: "same order as the input ids" pulled in the Order Service)', () => {
    const rules = [
      { keywords: ['EventController', 'buildEventsV2Response', 'web-api'], repositories: ['web-api'], modules: ['homepage'] },
      { keywords: ['order', 'cart', 'fulfillment', 'repo-b'], repositories: ['repo-b'], modules: ['order-service'] },
      { keywords: ['payment', 'pay', 'charge', 'repo-a'], repositories: ['repo-a'], modules: ['payment-service'] }
    ];
    const agent = () => new ImpactAnalysisAgent({ repositoriesDir: root, customRules: rules });

    it('a repo reached only by an everyday word is left out when the ticket names specific code', async () => {
      const impact = await agent().analyze(
        task('T2-590', 'EventController buildEventsV2Response: 60 sequential Redis calls (ai-ready)', 'Batch the reads', [
          'For normal data the response is unchanged: same events, same order as the input ids'
        ])
      );
      expect(impact.affectedRepositories).toEqual(['web-api']);
      expect(impact.reasoning).toContain('Left out: repo-b (only the generic word "order")');
    });

    it('generic-only tickets still route to every matching repo', async () => {
      const impact = await agent().analyze(task('X-9', 'Payment and order totals disagree', 'checkout charge vs order cart'));
      expect(impact.affectedRepositories.sort()).toEqual(['repo-a', 'repo-b']);
    });

    it('a repo named specifically is kept next to another specific match', async () => {
      const impact = await agent().analyze(task('X-10', 'EventController must also notify repo-b', 'x'));
      expect(impact.affectedRepositories.sort()).toEqual(['repo-b', 'web-api']);
    });
  });

  it('the approved change plan defines the scope at implementation time (not keyword routing)', async () => {
    let coordinated: string[] = [];
    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      dedupAgent: new DeduplicationAgent({ repositoriesRoot: root }),
      impactAgent: new ImpactAnalysisAgent({ repositoriesDir: root }), // routes "order" + "payment" text to repo-a and repo-b
      teamAgent: {
        coordinate: async (_t, impact) => {
          coordinated = impact.affectedRepositories;
          return { success: true, repoResults: [], executionPlan: [] };
        }
      },
      testingAgent: { runTests: async () => ({ overallSuccess: true, summary: 'ok', repoResults: [] }) },
      silent: true
    });
    const t = task('T2-591', 'Payment and order mismatch', 'pay order');
    t.metadata = {
      approvedPlans: {
        'repo-a': { summary: 'fix', filesToChange: [{ path: 'src/server.ts', change: 'x' }] },
        'repo-b': { summary: 'nothing here', filesToChange: [] } // planner found nothing → not in scope
      }
    };
    await orchestrator.run(t);
    expect(coordinated).toEqual(['repo-a']);
  });

  it('returns no repositories (no repo-a fallback) when nothing matches', async () => {
    const impact = await new ImpactAnalysisAgent({ repositoriesDir: root }).analyze(
      task('X-2', 'Homepage creators', 'Show NFL creators on homepage')
    );
    expect(impact.affectedRepositories).toEqual([]);
    expect(impact.confidence).toBe(0);
  });
});

describe('Regression: orchestrator flow', () => {
  it('stops with NO_MATCHING_REPO and writes nothing for unroutable tasks', async () => {
    let teamCalled = false;
    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      dedupAgent: new DeduplicationAgent({ repositoriesRoot: root }),
      impactAgent: new ImpactAnalysisAgent({ repositoriesDir: root }),
      teamAgent: { coordinate: async () => { teamCalled = true; throw new Error('must not run'); } },
      silent: true
    });
    const result = await orchestrator.run(task('X-3', 'Homepage creators', 'Show NFL creators'));
    expect(result.status).toBe('NO_MATCHING_REPO');
    expect(result.success).toBe(false);
    expect(teamCalled).toBe(false);
  });

  it('runs the duplicate check before impact analysis', async () => {
    let impactCalls = 0;
    const dedup = new DeduplicationAgent({
      repositoriesRoot: root,
      initialTasks: [{ id: 'DUP-1', title: 'x', description: 'x', status: 'IN_PROGRESS', changedFiles: [] }]
    });
    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      dedupAgent: dedup,
      impactAgent: { analyze: async () => { impactCalls++; return impactFor(['repo-a']); } },
      silent: true
    });
    const result = await orchestrator.run(task('DUP-1', 'x', 'x'));
    expect(result.status).toBe('DUPLICATE_SKIPPED');
    expect(impactCalls).toBe(0);
  });
});

describe('Regression: team agent dependency scheduling', () => {
  it('runs a chain a <- b <- c in dependency order regardless of input order', async () => {
    const order: string[] = [];
    const team = new TeamAgent(new MockAIProvider(), {
      repositoriesRoot: root,
      dependencies: { 'repo-b': ['repo-a'], 'repo-c': ['repo-b'] },
      repoAgentFactory: okAgent(order)
    });
    const result = await team.coordinate(task('C-1', 'chain'), impactFor(['repo-c', 'repo-a', 'repo-b']));
    expect(result.success).toBe(true);
    expect(order).toEqual(['repo-a', 'repo-b', 'repo-c']);
  });

  it('skips transitive dependents when an upstream repo fails', async () => {
    const team = new TeamAgent(new MockAIProvider(), {
      repositoriesRoot: root,
      dependencies: { 'repo-b': ['repo-a'], 'repo-c': ['repo-b'] },
      repoAgentFactory: (repoId, repoPath) => ({
        repoId,
        repoPath,
        execute: async () => ({
          repoId,
          success: repoId !== 'repo-a',
          changedFiles: [],
          providerUsed: 'mock',
          reasoning: '',
          message: '',
          error: repoId === 'repo-a' ? 'boom' : undefined
        })
      })
    });
    const result = await team.coordinate(task('C-2', 'chain'), impactFor(['repo-a', 'repo-b', 'repo-c']));
    const byId = Object.fromEntries(result.repoResults.map((r) => [r.repoId, r]));
    expect(result.success).toBe(false);
    expect(byId['repo-b'].reasoning).toContain('upstream');
    expect(byId['repo-c'].reasoning).toContain('upstream');
  });

  it('detects dependency cycles instead of hanging', async () => {
    const order: string[] = [];
    const team = new TeamAgent(new MockAIProvider(), {
      repositoriesRoot: root,
      dependencies: { 'repo-a': ['repo-b'], 'repo-b': ['repo-a'] },
      repoAgentFactory: okAgent(order)
    });
    const result = await team.coordinate(task('C-3', 'cycle'), impactFor(['repo-a', 'repo-b']));
    expect(result.success).toBe(false);
    expect(order).toEqual([]);
    expect(result.error).toContain('Circular dependency');
  });
});

describe('Regression: repo agent file safety', () => {
  const attempt = async (badPath: string) => {
    const provider = new MockAIProvider(async () => ({
      providerName: 'mock',
      reasoning: '',
      fileChanges: [
        { path: 'src/ok.ts', action: 'create', content: 'ok' },
        { path: badPath, action: 'create', content: 'x' }
      ]
    }));
    return new RepoAgent('repo-a', path.join(root, 'repo-a'), provider).execute(task('S-1', 'x'));
  };

  it.each(['../repo-a-evil/pwn.txt', '../../escape.txt', '/etc/passwd-copy', '.git/hooks/pre-commit'])(
    'blocks unsafe path %s and writes nothing',
    async (badPath) => {
      const result = await attempt(badPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Security violation');
      await expect(fs.access(path.join(root, 'repo-a', 'src', 'ok.ts'))).rejects.toThrow();
      await expect(fs.access(path.join(root, 'repo-a-evil'))).rejects.toThrow();
    }
  );
});

describe('Regression: mock provider is non-destructive', () => {
  it('health task on repo-b adds src/health.ts and keeps OrderService intact', async () => {
    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      dedupAgent: new DeduplicationAgent({ repositoriesRoot: root }),
      impactAgent: new ImpactAnalysisAgent({ repositoriesDir: root }),
      teamAgent: new TeamAgent(new MockAIProvider(), { repositoriesRoot: root }),
      testingAgent: new TestingAgent({ repositoriesRoot: root }),
      silent: true
    });
    const result = await orchestrator.run(task('H-1', 'Add health check to order service', 'Order service health'));
    const index = await fs.readFile(path.join(root, 'repo-b', 'src', 'index.ts'), 'utf-8');
    expect(result.status).toBe('COMPLETED');
    expect(result.teamResult?.repoResults[0].changedFiles).toEqual(['src/health.ts']);
    expect(index).toContain('class OrderService');
  });
});

describe('Regression: duplicate check is read-only and recognises real code', () => {
  it('flags a completed ticket as duplicate even though its files do not mention the ticket ID', async () => {
    const historyFile = path.join(tmpDir, 'history-dup.json');
    await fs.writeFile(
      historyFile,
      JSON.stringify([{ id: 'T2-1', title: 'Batch lookups', description: 'x', status: 'COMPLETED', changedFiles: ['repo-b/src/index.ts'] }])
    );
    const dedup = new DeduplicationAgent({ historyFilePath: historyFile, repositoriesRoot: root });
    const result = await dedup.check(task('T2-1', 'Batch lookups'));
    expect(result.status).toBe('duplicate');
  });

  it('never modifies the history file during check() (plan previews must have no side effects)', async () => {
    const historyFile = path.join(tmpDir, 'history-readonly.json');
    const original = JSON.stringify([
      { id: 'T2-2', title: 'Gone', description: 'x', status: 'COMPLETED', changedFiles: ['repo-b/src/does-not-exist.ts'] }
    ]);
    await fs.writeFile(historyFile, original);
    const dedup = new DeduplicationAgent({ historyFilePath: historyFile, repositoriesRoot: root });
    const result = await dedup.check(task('T2-2', 'Gone'));
    expect(result.status).toBe('new'); // its file is missing, so re-running is allowed
    expect(await fs.readFile(historyFile, 'utf-8')).toBe(original); // ...but nothing was written
  });

  it('a similar title (≥80% overlap) is only a duplicate while that work is still in the repo', async () => {
    const historyFile = path.join(tmpDir, 'history-overlap.json');
    const title = 'SportsBull events shows live scores wrong events mapping';
    // Done in an old copy of the repo: its test file does not exist in this repo (e.g. a fresh clone).
    await fs.writeFile(
      historyFile,
      JSON.stringify([{ id: 'T2-587', title, description: 'x', status: 'COMPLETED', changedFiles: ['repo-b/src/index.ts', 'repo-b/tests/gone.test.ts'] }])
    );
    const dedup = new DeduplicationAgent({ historyFilePath: historyFile, repositoriesRoot: root });
    expect((await dedup.check(task('T2-600', `${title} again`))).status).toBe('new');

    // Same history, but the work IS in the repo → duplicate.
    await fs.writeFile(
      historyFile,
      JSON.stringify([{ id: 'T2-587', title, description: 'x', status: 'COMPLETED', changedFiles: ['repo-b/src/index.ts'] }])
    );
    const dedup2 = new DeduplicationAgent({ historyFilePath: historyFile, repositoriesRoot: root });
    expect((await dedup2.check(task('T2-600', `${title} again`))).status).toBe('duplicate');
  });
});

describe('Regression: health-task duplicate check looks at ANY changed file', () => {
  it('treats PAY-101 as duplicate when server.ts has getHealth even though package.json does not', async () => {
    const repoA = path.join(root, 'repo-a');
    await fs.writeFile(path.join(repoA, 'src', 'server.ts'), "export class PaymentServer { getHealth() { return { status: 'UP' }; } charge() {} }\n");
    const historyFile = path.join(tmpDir, 'history-health.json');
    await fs.writeFile(
      historyFile,
      JSON.stringify([{ id: 'PAY-101', title: 'Add health endpoint', description: 'health', status: 'COMPLETED', changedFiles: ['repo-a/package.json', 'repo-a/src/server.ts'] }])
    );
    const dedup = new DeduplicationAgent({ historyFilePath: historyFile, repositoriesRoot: root });
    expect((await dedup.check(task('PAY-101', 'Add health endpoint', 'health'))).status).toBe('duplicate');
  });
});
