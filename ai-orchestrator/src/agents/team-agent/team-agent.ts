import path from 'node:path';
import type {
  AIProvider,
  ImpactAnalysisResult,
  RepoExecutionResult,
  TaskInput,
  TeamExecutionPlan,
  TeamExecutionResult
} from '../../models/types.js';
import { BaseRepoAgent, type IRepoAgent } from './repo-agents/base-repo-agent.js';
import { RepoAgentA } from './repo-agents/repo-agent-a/agent.js';
import { RepoAgentB } from './repo-agents/repo-agent-b/agent.js';
import { RepoAgentC } from './repo-agents/repo-agent-c/agent.js';

export { BaseRepoAgent, type IRepoAgent, RepoAgentA, RepoAgentB, RepoAgentC };

export interface TeamAgentConfig {
  repositoriesRoot?: string;
  repoAgentFactory?: (repoId: string, repoPath: string, aiProvider: AIProvider) => IRepoAgent;
  dependencies?: Record<string, string[]>; // e.g. { 'repo-b': ['repo-a'] }
}

export interface ITeamAgent {
  coordinate(task: TaskInput, impact: ImpactAnalysisResult): Promise<TeamExecutionResult>;
}

/**
 * Creates the appropriate Repo Agent instance based on repository identifier.
 */
export function createDefaultRepoAgent(
  repoId: string,
  repoPath: string,
  aiProvider: AIProvider
): IRepoAgent {
  switch (repoId.toLowerCase()) {
    case 'repo-a':
      return new RepoAgentA(aiProvider, repoPath);
    case 'repo-b':
      return new RepoAgentB(aiProvider, repoPath);
    case 'repo-c':
      return new RepoAgentC(aiProvider, repoPath);
    default:
      // Generic fallback for any additional repository
      return new (class extends BaseRepoAgent { })(repoId, repoPath, aiProvider);
  }
}

/**
 * TeamAgent
 *
 * Coordinates repository-specific sub-agents (RepoAgentA, RepoAgentB, RepoAgentC).
 * Evaluates dependencies and executes independent repo agents concurrently via Promise.all
 * while maintaining sequential order for dependent repositories.
 */
export class TeamAgent implements ITeamAgent {
  private repositoriesRoot: string;
  private aiProvider: AIProvider;
  private repoAgentFactory: (repoId: string, repoPath: string, aiProvider: AIProvider) => IRepoAgent;
  private dependencies: Record<string, string[]>;

  constructor(aiProvider: AIProvider, config: TeamAgentConfig = {}) {
    this.aiProvider = aiProvider;
    this.repositoriesRoot = config.repositoriesRoot || path.resolve(process.cwd(), 'repositories');
    this.repoAgentFactory =
      config.repoAgentFactory ||
      ((repoId, repoPath, provider) => createDefaultRepoAgent(repoId, repoPath, provider));
    this.dependencies = config.dependencies || {};
  }

  async coordinate(task: TaskInput, impact: ImpactAnalysisResult): Promise<TeamExecutionResult> {
    const reposToProcess = impact.affectedRepositories;

    if (!reposToProcess || reposToProcess.length === 0) {
      return {
        success: true,
        repoResults: [],
        executionPlan: [],
        error: undefined
      };
    }


    const executionPlan: TeamExecutionPlan[] = reposToProcess.map((repoId) => ({
      repoId,
      dependsOn: this.dependencies[repoId]?.filter((dep) => reposToProcess.includes(dep)) || []
    }));

    // Partition into independent repos (no dependencies in this set) and dependent repos
    const independentRepos = executionPlan.filter((p) => !p.dependsOn || p.dependsOn.length === 0);
    const dependentRepos = executionPlan.filter((p) => p.dependsOn && p.dependsOn.length > 0);

    const repoResults: RepoExecutionResult[] = [];

    // Step 1: Execute independent repositories in parallel using Promise.all
    if (independentRepos.length > 0) {
      const independentPromises = independentRepos.map((planItem) => {
        const repoPath = path.resolve(this.repositoriesRoot, planItem.repoId);
        const agent = this.repoAgentFactory(planItem.repoId, repoPath, this.aiProvider);
        return agent.execute(task);
      });

      const independentResults = await Promise.all(independentPromises);
      repoResults.push(...independentResults);
    }


    const hasFailures = repoResults.some((r) => !r.success);

    if (hasFailures && dependentRepos.length > 0) {
      for (const planItem of dependentRepos) {
        repoResults.push({
          repoId: planItem.repoId,
          success: false,
          changedFiles: [],
          providerUsed: this.aiProvider.name,
          reasoning: 'Skipped due to upstream repository failure.',
          message: `Skipping ${planItem.repoId} because upstream dependencies failed.`,
          error: 'Upstream dependency failure'
        });
      }
    }

    // Step 3: Execute dependent repositories sequentially
    if (!hasFailures && dependentRepos.length > 0) {
      for (const planItem of dependentRepos) {
        // Verify dependencies succeeded
        const depsMet = (planItem.dependsOn || []).every((dep) =>
          repoResults.some((r) => r.repoId === dep && r.success)
        );

        if (!depsMet) {
          repoResults.push({
            repoId: planItem.repoId,
            success: false,
            changedFiles: [],
            providerUsed: this.aiProvider.name,
            reasoning: 'Dependency check failed.',
            message: `Skipping ${planItem.repoId} because required dependencies failed or were not met.`,
            error: `Unmet dependencies: ${(planItem.dependsOn || []).join(', ')}`
          });
          continue;
        }

        const repoPath = path.resolve(this.repositoriesRoot, planItem.repoId);
        const agent = this.repoAgentFactory(planItem.repoId, repoPath, this.aiProvider);
        const result = await agent.execute(task);
        repoResults.push(result);
      }
    }

    const overallSuccess = repoResults.length > 0 && repoResults.every((r) => r.success);
    const errorDetails = repoResults
      .filter((r) => !r.success)
      .map((r) => `[${r.repoId}]: ${r.error || r.message}`)
      .join('; ');

    return {
      success: overallSuccess,
      repoResults,
      executionPlan,
      error: overallSuccess ? undefined : errorDetails || 'One or more repositories failed to execute.'
    };
  }
}
