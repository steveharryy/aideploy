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

export { BaseRepoAgent, type IRepoAgent };

/** The agent that works on ONE repository. Every repo gets one; its settings come from catalog/repos.yaml. */
export class RepoAgent extends BaseRepoAgent {}

export interface TeamAgentConfig {
  repositoriesRoot?: string;
  repoAgentFactory?: (repoId: string, repoPath: string, aiProvider: AIProvider) => IRepoAgent;
  dependencies?: Record<string, string[]>; // e.g. { 'repo-b': ['repo-a'] }
  /** Explicit repo locations (e.g. from the service catalog); overrides repositoriesRoot/<id>. */
  repoPaths?: Record<string, string>;
}

export interface ITeamAgent {
  /** @param workdirs optional per-run locations (e.g. a ticket's git worktree) that override configured paths. */
  coordinate(
    task: TaskInput,
    impact: ImpactAnalysisResult,
    workdirs?: Record<string, string>
  ): Promise<TeamExecutionResult>;
}

/**
 * Creates the appropriate Repo Agent instance based on repository identifier.
 */
export function createDefaultRepoAgent(repoId: string, repoPath: string, aiProvider: AIProvider): IRepoAgent {
  return new RepoAgent(repoId, repoPath, aiProvider);
}

/**
 * TeamAgent
 *
 * Coordinates repository-specific sub-agents (one RepoAgent per repository).
 * Evaluates dependencies and executes independent repo agents concurrently via Promise.all
 * while maintaining sequential order for dependent repositories.
 */
export class TeamAgent implements ITeamAgent {
  private repositoriesRoot: string;
  private repoPaths: Record<string, string>;
  private aiProvider: AIProvider;
  private repoAgentFactory: (repoId: string, repoPath: string, aiProvider: AIProvider) => IRepoAgent;
  private dependencies: Record<string, string[]>;

  constructor(aiProvider: AIProvider, config: TeamAgentConfig = {}) {
    this.aiProvider = aiProvider;
    this.repositoriesRoot = config.repositoriesRoot || path.resolve(process.cwd(), 'repositories');
    this.repoPaths = config.repoPaths || {};
    this.repoAgentFactory =
      config.repoAgentFactory ||
      ((repoId, repoPath, provider) => createDefaultRepoAgent(repoId, repoPath, provider));
    this.dependencies = config.dependencies || {};
  }

  async coordinate(
    task: TaskInput,
    impact: ImpactAnalysisResult,
    workdirs: Record<string, string> = {}
  ): Promise<TeamExecutionResult> {
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

    const repoResults: RepoExecutionResult[] = [];
    const succeeded = new Set<string>();
    const failed = new Set<string>();
    let pending = [...executionPlan];

    const skip = (planItem: TeamExecutionPlan, reasoning: string, error: string) => {
      failed.add(planItem.repoId);
      repoResults.push({
        repoId: planItem.repoId,
        success: false,
        changedFiles: [],
        providerUsed: this.aiProvider.name,
        reasoning,
        message: `Skipping ${planItem.repoId}: ${error}`,
        error
      });
    };

    // Dependency-ordered waves: each wave runs (in parallel) every repo whose
    // dependencies have all succeeded. Works for chains (a <- b <- c) in any input order.
    while (pending.length > 0) {
      // Repos with a failed/skipped dependency are skipped. Repeat until stable so the
      // skip propagates transitively (a fails -> b skipped -> c skipped) in one pass.
      let blocked = pending.filter((p) => (p.dependsOn || []).some((d) => failed.has(d)));
      while (blocked.length > 0) {
        for (const planItem of blocked) {
          const failedDeps = (planItem.dependsOn || []).filter((d) => failed.has(d));
          skip(planItem, 'Skipped due to upstream repository failure.', `Upstream dependency failure: ${failedDeps.join(', ')}`);
        }
        pending = pending.filter((p) => !blocked.includes(p));
        blocked = pending.filter((p) => (p.dependsOn || []).some((d) => failed.has(d)));
      }

      const ready = pending.filter((p) => (p.dependsOn || []).every((d) => succeeded.has(d)));
      if (ready.length === 0) {
        // Nothing runnable and nothing failed upstream => dependency cycle.
        for (const planItem of pending) {
          skip(planItem, 'Dependency cycle detected.', `Circular dependency involving: ${pending.map((p) => p.repoId).join(', ')}`);
        }
        break;
      }

      const waveResults = await Promise.all(
        ready.map((planItem) => {
          const repoPath =
            workdirs[planItem.repoId] ||
            this.repoPaths[planItem.repoId] ||
            path.resolve(this.repositoriesRoot, planItem.repoId);
          const agent = this.repoAgentFactory(planItem.repoId, repoPath, this.aiProvider);
          return agent.execute(task);
        })
      );

      for (const result of waveResults) {
        repoResults.push(result);
        (result.success ? succeeded : failed).add(result.repoId);
      }
      pending = pending.filter((p) => !ready.includes(p));
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
