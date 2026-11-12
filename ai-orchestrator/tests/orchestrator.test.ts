import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { MockAIProvider } from '../src/providers/ai-provider.js';
import type { TaskInput, AIProvider, RepoExecutionResult, RepoTestResult } from '../src/models/types.js';
import { DeduplicationAgent } from '../src/agents/deduplication/agent.js';
import { ImpactAnalysisAgent } from '../src/agents/impact-analysis/agent.js';
import { TeamAgent } from '../src/agents/team-agent/team-agent.js';
import { TestingAgent } from '../src/agents/testing/agent.js';
import { RepoAgentA } from '../src/agents/team-agent/team-agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourceRepoRoot = path.resolve(__dirname, '../repositories');

// Tests run against a throwaway copy of repositories/ so they never modify the real sample repos.
// Agents that default to process.cwd()/repositories also resolve to this copy via chdir.
let testRepoRoot = '';
let tmpDir = '';
const originalCwd = process.cwd();

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-test-'));
  testRepoRoot = path.join(tmpDir, 'repositories');
  await fs.cp(sourceRepoRoot, testRepoRoot, { recursive: true });
  process.chdir(tmpDir);
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('AI Orchestrator Pipeline', () => {
  let sampleTask: TaskInput;

  beforeEach(() => {
    sampleTask = {
      id: 'PAY-101',
      title: 'Add health endpoint',
      description: 'Add GET /health endpoint to the payment service',
      acceptanceCriteria: [
        'GET /health returns HTTP 200',
        'Response contains status UP'
      ]
    };
  });

  it('1. should flow a new task through the complete pipeline successfully', async () => {
    const aiProvider = new MockAIProvider();
    const orchestrator = new Orchestrator({
      aiProvider,
      silent: true
    });

    const result = await orchestrator.run(sampleTask);

    expect(result.success).toBe(true);
    expect(result.status).toBe('COMPLETED');
    expect(result.taskId).toBe('PAY-101');
    expect(result.impact).toBeDefined();
    expect(result.impact?.affectedRepositories).toContain('repo-a');
    expect(result.deduplication?.status).toBe('new');
    expect(result.teamResult?.success).toBe(true);
    expect(result.testingResult?.overallSuccess).toBe(true);
  });

  it('2. should stop the pipeline early when a task is duplicate', async () => {
    const aiProvider = new MockAIProvider();
    const dedupAgent = new DeduplicationAgent();
    const orchestrator = new Orchestrator({
      aiProvider,
      dedupAgent,
      silent: true
    });

    const firstRun = await orchestrator.run(sampleTask);
    expect(firstRun.success).toBe(true);
    expect(firstRun.status).toBe('COMPLETED');

    const secondRun = await orchestrator.run(sampleTask);
    expect(secondRun.success).toBe(false);
    expect(secondRun.status).toBe('DUPLICATE_SKIPPED');
    expect(secondRun.deduplication?.status).toBe('duplicate');
    expect(secondRun.teamResult).toBeUndefined();
    expect(secondRun.testingResult).toBeUndefined();
  });

  it('2b. should allow task to re-run when implementation was deleted from repository', async () => {
    const aiProvider = new MockAIProvider();
    const dedupAgent = new DeduplicationAgent({
      repositoriesRoot: testRepoRoot
    });
    const orchestrator = new Orchestrator({
      aiProvider,
      dedupAgent,
      silent: true
    });

    const firstRun = await orchestrator.run(sampleTask);
    expect(firstRun.success).toBe(true);

    // Simulate developer deleting the implementation from disk
    const serverPath = path.resolve(testRepoRoot, 'repo-a', 'src', 'server.ts');
    const originalContent = `export class PaymentServer {
  private startTime = Date.now();
  public charge(amount: number) {
    return { success: true, txId: 'tx_123' };
  }
}
`;
    await fs.writeFile(serverPath, originalContent, 'utf-8');

    const reRun = await orchestrator.run(sampleTask);
    expect(reRun.success).toBe(true);
    expect(reRun.status).toBe('COMPLETED');
    expect(reRun.deduplication?.status).toBe('new');
  });

  it('3. should handle RepoAgent execution failure gracefully', async () => {
    const failingProvider: AIProvider = {
      name: 'failing-provider',
      generateChanges: async () => {
        throw new Error('Claude rate limit exceeded / connection timeout');
      }
    };

    const orchestrator = new Orchestrator({
      aiProvider: failingProvider,
      silent: true
    });

    const result = await orchestrator.run(sampleTask);

    expect(result.success).toBe(false);
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.error).toContain('Claude rate limit exceeded');
    expect(result.testingResult).toBeUndefined();
  });

  it('3b. should handle repository not found error gracefully', async () => {
    const repoAgent = new RepoAgentA(new MockAIProvider(), '/tmp/nonexistent-repo-path-12345');
    const result = await repoAgent.execute(sampleTask);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Repository not found at path');
  });

  it('4. should report test failure correctly when deterministic tests fail', async () => {
    const aiProvider = new MockAIProvider();
    const failingTestingAgent = new TestingAgent({
      repositoriesRoot: testRepoRoot,
      customTestRunner: async (repoId: string): Promise<RepoTestResult> => {
        return {
          repoId,
          success: false,
          checks: [
            {
              name: 'endpoint-contract-test',
              passed: false,
              error: 'Assertion failed: expected HTTP 200 but received HTTP 500'
            }
          ],
          summary: `Test failure in ${repoId}: Endpoint returned 500.`
        };
      }
    });

    const orchestrator = new Orchestrator({
      aiProvider,
      testingAgent: failingTestingAgent,
      silent: true
    });

    const result = await orchestrator.run(sampleTask);

    expect(result.success).toBe(false);
    expect(result.status).toBe('TEST_FAILED');
    expect(result.testingResult?.overallSuccess).toBe(false);
    expect(result.error).toContain('Test failure in repo-a');
  });

  it('5. should execute independent RepoAgents in parallel', async () => {
    const executionTimestamps: { repoId: string; start: number; end: number }[] = [];
    const simulatedDelayMs = 60;

    const parallelImpactAgent: ImpactAnalysisAgent = new ImpactAnalysisAgent({
      customRules: [
        {
          keywords: ['parallel-test'],
          repositories: ['repo-a', 'repo-b'],
          modules: ['core']
        }
      ]
    });

    const customTeamAgent = new TeamAgent(new MockAIProvider(), {
      repositoriesRoot: testRepoRoot,
      repoAgentFactory: (repoId: string, repoPath: string, provider: AIProvider) => {
        return {
          repoId,
          repoPath,
          execute: async (): Promise<RepoExecutionResult> => {
            const start = Date.now();
            await new Promise((resolve) => setTimeout(resolve, simulatedDelayMs));
            const end = Date.now();
            executionTimestamps.push({ repoId, start, end });

            return {
              repoId,
              success: true,
              changedFiles: ['simulated.ts'],
              providerUsed: provider.name,
              reasoning: 'Parallel execution test mock',
              message: `Completed ${repoId}`
            };
          }
        };
      }
    });

    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      impactAgent: parallelImpactAgent,
      teamAgent: customTeamAgent,
      testingAgent: new TestingAgent({
        customTestRunner: async (repoId) => ({
          repoId,
          success: true,
          checks: [{ name: 'mock-pass', passed: true }],
          summary: 'Passed'
        })
      }),
      silent: true
    });

    const parallelTask: TaskInput = {
      id: 'TASK-PARALLEL-1',
      title: 'Run parallel-test on both services',
      description: 'Trigger changes in both repo-a and repo-b',
      acceptanceCriteria: ['Both services updated']
    };

    const overallStart = Date.now();
    const result = await orchestrator.run(parallelTask);
    const overallDuration = Date.now() - overallStart;

    expect(result.success).toBe(true);
    expect(result.status).toBe('COMPLETED');
    expect(result.teamResult?.repoResults.length).toBe(2);

    // Parallel duration must be significantly lower than sequential sum
    expect(executionTimestamps.length).toBe(2);
    expect(overallDuration).toBeLessThan(simulatedDelayMs * 1.8);
  });

  it('6. should execute dependent repositories sequentially after dependencies', async () => {
    const executionOrder: string[] = [];

    const customTeamAgent = new TeamAgent(new MockAIProvider(), {
      repositoriesRoot: testRepoRoot,
      dependencies: {
        'repo-b': ['repo-a'] // repo-b depends on repo-a
      },
      repoAgentFactory: (repoId: string, repoPath: string, provider: AIProvider) => ({
        repoId,
        repoPath,
        execute: async (): Promise<RepoExecutionResult> => {
          executionOrder.push(repoId);
          return {
            repoId,
            success: true,
            changedFiles: ['dep.ts'],
            providerUsed: provider.name,
            reasoning: 'Dependency ordering test',
            message: `Completed ${repoId}`
          };
        }
      })
    });

    const impactAgent = new ImpactAnalysisAgent({
      customRules: [
        {
          keywords: ['dep-test'],
          repositories: ['repo-b', 'repo-a'], // Intentional reverse order to verify dependency sorting
          modules: ['core']
        }
      ]
    });

    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      impactAgent,
      teamAgent: customTeamAgent,
      testingAgent: new TestingAgent({
        customTestRunner: async (repoId) => ({
          repoId,
          success: true,
          checks: [{ name: 'mock-pass', passed: true }],
          summary: 'Passed'
        })
      }),
      silent: true
    });

    const task: TaskInput = {
      id: 'DEP-1',
      title: 'Run dep-test order check',
      description: 'Test dependency order',
      acceptanceCriteria: ['Ordered execution']
    };

    const result = await orchestrator.run(task);

    expect(result.success).toBe(true);
    expect(executionOrder).toEqual(['repo-a', 'repo-b']);
  });

  it('7. should handle unexpected exception in TeamAgent coordinate gracefully', async () => {
    const throwingTeamAgent = {
      coordinate: async () => {
        throw new Error('Unexpected fatal error in TeamAgent');
      }
    };

    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      teamAgent: throwingTeamAgent,
      silent: true
    });

    const result = await orchestrator.run(sampleTask);

    expect(result.success).toBe(false);
    expect(result.status).toBe('EXECUTION_FAILED');
    expect(result.error).toContain('Team coordination failed: Unexpected fatal error in TeamAgent');
  });

  it('8. should handle unexpected exception in TestingAgent runTests gracefully', async () => {
    const throwingTestingAgent = {
      runTests: async () => {
        throw new Error('Unexpected spawn failure in TestingAgent');
      }
    };

    const orchestrator = new Orchestrator({
      aiProvider: new MockAIProvider(),
      testingAgent: throwingTestingAgent,
      silent: true
    });

    const result = await orchestrator.run(sampleTask);

    expect(result.success).toBe(false);
    expect(result.status).toBe('TEST_FAILED');
    expect(result.error).toContain('Testing failed: Unexpected spawn failure in TestingAgent');
  });

  it('9. should record skipped entries for dependent repos when upstream repo fails', async () => {
    const failingTeamAgent = new TeamAgent(new MockAIProvider(), {
      repositoriesRoot: testRepoRoot,
      dependencies: {
        'repo-b': ['repo-a'] // repo-b depends on repo-a
      },
      repoAgentFactory: (repoId) => ({
        repoId,
        repoPath: path.resolve(testRepoRoot, repoId),
        execute: async (): Promise<RepoExecutionResult> => {
          if (repoId === 'repo-a') {
            return {
              repoId: 'repo-a',
              success: false,
              changedFiles: [],
              providerUsed: 'mock',
              reasoning: 'Simulated failure',
              message: 'Failed to build repo-a',
              error: 'Compilation error'
            };
          }
          return {
            repoId,
            success: true,
            changedFiles: ['file.ts'],
            providerUsed: 'mock',
            reasoning: 'Success',
            message: 'Success'
          };
        }
      })
    });

    const impact = {
      taskId: 'TASK-DEP-FAIL',
      affectedRepositories: ['repo-a', 'repo-b'],
      affectedModules: ['core'],
      affectedFiles: [],
      confidence: 1,
      reasoning: 'Multi-repo impact'
    };

    const result = await failingTeamAgent.coordinate(sampleTask, impact);

    expect(result.success).toBe(false);
    expect(result.repoResults.length).toBe(2);

    const repoAResult = result.repoResults.find((r) => r.repoId === 'repo-a');
    const repoBResult = result.repoResults.find((r) => r.repoId === 'repo-b');

    expect(repoAResult?.success).toBe(false);
    expect(repoBResult?.success).toBe(false);
    expect(repoBResult?.reasoning).toContain('Skipped due to upstream repository failure');
  });

  it('10. should instantiate and coordinate RepoAgentA, RepoAgentB, and RepoAgentC', async () => {
    const teamAgent = new TeamAgent(new MockAIProvider(), {
      repositoriesRoot: testRepoRoot
    });

    const multiRepoImpact = {
      taskId: 'MULTI-101',
      affectedRepositories: ['repo-a', 'repo-b', 'repo-c'],
      affectedModules: ['payment-service', 'order-service', 'notification-service'],
      affectedFiles: ['repo-a/src/server.ts', 'repo-b/src/index.ts', 'repo-c/src/index.ts'],
      confidence: 1,
      reasoning: 'Changes touch all three services'
    };

    const task: TaskInput = {
      id: 'MULTI-101',
      title: 'Update shared telemetry Across all repositories',
      description: 'Add telemetry check in repo-a, repo-b, and repo-c',
      acceptanceCriteria: ['All 3 repos updated']
    };

    const result = await teamAgent.coordinate(task, multiRepoImpact);

    expect(result.success).toBe(true);
    expect(result.repoResults.length).toBe(3);
    const repoIds = result.repoResults.map((r) => r.repoId);
    expect(repoIds).toContain('repo-a');
    expect(repoIds).toContain('repo-b');
    expect(repoIds).toContain('repo-c');
  });
});
