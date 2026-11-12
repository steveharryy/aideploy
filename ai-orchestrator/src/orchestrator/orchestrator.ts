import type {
  AIProvider,
  DeduplicationResult,
  ImpactAnalysisResult,
  OrchestrationStatus,
  OrchestratorResult,
  RepoBranchResult,
  TaskInput,
  TeamExecutionResult,
  TestingResult
} from '../models/types.js';
import { ImpactAnalysisAgent, type IImpactAnalysisAgent } from '../agents/impact-analysis/agent.js';
import { DeduplicationAgent, type IDeduplicationAgent } from '../agents/deduplication/agent.js';
import { TeamAgent, type ITeamAgent } from '../agents/team-agent/team-agent.js';
import { TestingAgent, type ITestingAgent } from '../agents/testing/agent.js';
import { JobStore, TicketLockedError, type JobRun, type StageStatus } from '../jobs/job-store.js';
import type { IWorkspaceManager, RepoWorkspace } from '../workspace/git-workspace.js';

export interface OrchestratorOptions {
  aiProvider: AIProvider;
  impactAgent?: IImpactAnalysisAgent;
  dedupAgent?: IDeduplicationAgent;
  teamAgent?: ITeamAgent;
  testingAgent?: ITestingAgent;
  silent?: boolean;
  /** Optional: persist job state (.jobs/<ticket>/job.json) and lock each ticket to one run. */
  jobStore?: JobStore;
  /** Optional: isolate each ticket on its own git branch + worktree and commit on success. */
  workspace?: IWorkspaceManager;
  /** Required with `workspace`: where each repo lives on disk. */
  resolveRepoPath?: (repoId: string) => string;
  /** Optional with `workspace`: branch new ticket branches are created from. */
  resolveBaseBranch?: (repoId: string) => string | undefined;
  /**
   * Optional human gate after impact analysis, before any code is written
   * (design doc: "tech lead approves the plan"). Resolve false to stop with PLAN_REJECTED.
   */
  approvePlan?: (task: TaskInput, impact: ImpactAnalysisResult) => Promise<boolean>;
}

/** Read-only preview of what a run would do. */
export interface PlanPreview {
  deduplication: DeduplicationResult;
  impact?: ImpactAnalysisResult;
}

export class Orchestrator {
  private aiProvider: AIProvider;
  private impactAgent: IImpactAnalysisAgent;
  private dedupAgent: IDeduplicationAgent;
  private teamAgent: ITeamAgent;
  private testingAgent: ITestingAgent;
  private silent: boolean;
  private jobStore?: JobStore;
  private workspace?: IWorkspaceManager;
  private resolveRepoPath?: (repoId: string) => string;
  private resolveBaseBranch?: (repoId: string) => string | undefined;
  private approvePlan?: (task: TaskInput, impact: ImpactAnalysisResult) => Promise<boolean>;

  constructor(options: OrchestratorOptions) {
    this.aiProvider = options.aiProvider;
    this.silent = options.silent ?? false;

    // Use injected agents or defaults
    this.impactAgent = options.impactAgent || new ImpactAnalysisAgent();
    this.dedupAgent = options.dedupAgent || new DeduplicationAgent();
    this.teamAgent = options.teamAgent || new TeamAgent(this.aiProvider);
    this.testingAgent = options.testingAgent || new TestingAgent();

    this.jobStore = options.jobStore;
    this.workspace = options.workspace;
    this.resolveRepoPath = options.resolveRepoPath;
    this.resolveBaseBranch = options.resolveBaseBranch;
    this.approvePlan = options.approvePlan;
    if (this.workspace && !this.resolveRepoPath) {
      throw new Error('Orchestrator: resolveRepoPath is required when a workspace manager is configured.');
    }
  }

  private log(tag: string, message: string): void {
    if (!this.silent) {
      console.log(`\n[${tag}]\n${message}`);
    }
  }

  /**
   * Preview only: duplicate check and impact analysis. No lock, no workspace, no code changes.
   */
  async plan(task: TaskInput): Promise<PlanPreview> {
    const deduplication = await this.dedupAgent.check(task);
    if (deduplication.status === 'duplicate') return { deduplication };
    const impact = await this.impactAgent.analyze(task);
    return { deduplication, impact };
  }

  /**
   * Runs one ticket through the pipeline. With a job store configured, the ticket is
   * locked for the duration of the run and every stage is recorded in job.json.
   */
  async run(task: TaskInput): Promise<OrchestratorResult> {
    if (!this.jobStore) {
      return this.runPipeline(task);
    }

    let job: JobRun;
    try {
      job = this.jobStore.start(task.id, task.title);
    } catch (err: unknown) {
      if (err instanceof TicketLockedError) {
        this.log('RESULT', `Skipped: ${err.message}`);
        return { taskId: task.id, success: false, status: 'LOCKED', error: err.message, durationMs: 0 };
      }
      throw err;
    }

    try {
      const result = await this.runPipeline(task, job);
      result.jobFile = this.jobStore.jobPath(task.id);
      job.finish(result.status, result.error);
      return result;
    } catch (err: unknown) {
      // runPipeline never throws by design; this guarantees the lock is released if it ever does.
      job.finish('EXECUTION_FAILED', err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  private async runPipeline(task: TaskInput, job?: JobRun): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const begin = (name: string) => job?.startStage(name);
    const end = (name: string, status: Exclude<StageStatus, 'running'>, detail?: string) =>
      job?.endStage(name, status, detail);
    const fail = (
      status: OrchestrationStatus,
      error: string,
      extra: Partial<OrchestratorResult> = {}
    ): OrchestratorResult => ({
      taskId: task.id,
      success: false,
      status,
      ...extra,
      error,
      durationMs: Date.now() - startTime
    });

    this.log('ORCHESTRATOR', `Task received: ${task.id} - ${task.title}`);

    // Step 1: Deduplication Check (cheap; runs before any analysis so duplicates cost nothing)
    this.log('DEDUPLICATION', 'Checking for duplicate/overlapping work...');
    begin('deduplication');
    let deduplication: DeduplicationResult;
    try {
      deduplication = await this.dedupAgent.check(task);
      if (deduplication.status === 'duplicate') {
        this.log(
          'DEDUPLICATION',
          `Task flagged as DUPLICATE of ${deduplication.overlappingTaskId || 'prior work'}. Halting pipeline.\nReason: ${deduplication.reason}`
        );
        this.log('RESULT', 'Failed: Task is duplicate');
        end('deduplication', 'failed', deduplication.reason);
        return fail('DUPLICATE_SKIPPED', deduplication.reason, { deduplication });
      }
      this.log(
        'DEDUPLICATION',
        `Task status: ${deduplication.status.toUpperCase()} (${deduplication.reason})`
      );
      end('deduplication', 'passed', deduplication.status);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Deduplication: ${errorMessage}`);
      end('deduplication', 'failed', errorMessage);
      return fail('DEDUPLICATION_FAILED', `Deduplication check error: ${errorMessage}`);
    }

    // Step 2: Impact Analysis
    begin('impact-analysis');
    let impact: ImpactAnalysisResult;
    try {
      this.log('IMPACT ANALYSIS', 'Analyzing affected repositories...');
      impact = await this.impactAgent.analyze(task);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Impact Analysis: ${errorMessage}`);
      end('impact-analysis', 'failed', errorMessage);
      return fail('IMPACT_FAILED', `Impact Analysis failed: ${errorMessage}`, { deduplication });
    }

    if (impact.affectedRepositories.length === 0) {
      this.log('IMPACT ANALYSIS', `No repository matched this task. ${impact.reasoning}`);
      this.log('RESULT', 'Stopped: no matching repository (needs triage)');
      end('impact-analysis', 'failed', 'no matching repository');
      return fail(
        'NO_MATCHING_REPO',
        `No repository matched task ${task.id}. Add routing (label/component/keyword rule) or connect the repo.`,
        { impact, deduplication }
      );
    }

    this.log(
      'IMPACT ANALYSIS',
      `Identified ${impact.affectedRepositories.length} affected repo(s): ${impact.affectedRepositories.join(', ')} (Confidence: ${(impact.confidence * 100).toFixed(0)}%)`
    );
    end('impact-analysis', 'passed', impact.affectedRepositories.join(', '));

    // Step 2a (optional): human approval of the plan before any code is written
    if (this.approvePlan) {
      begin('plan-approval');
      let approved = false;
      try {
        approved = await this.approvePlan(task, impact);
      } catch (err: unknown) {
        this.log('PLAN APPROVAL', `Approval step failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!approved) {
        end('plan-approval', 'failed', 'plan not approved');
        this.log('RESULT', 'Stopped: plan was not approved. No code was written.');
        return fail('PLAN_REJECTED', 'Plan was not approved; no changes were made.', { impact, deduplication });
      }
      end('plan-approval', 'passed', 'approved');
      this.log('PLAN APPROVAL', 'Plan approved.');
    }

    // Step 2b (optional): isolated branch + worktree per repo
    const workspaces: RepoWorkspace[] = [];
    const workdirs: Record<string, string> = {};
    if (this.workspace && this.resolveRepoPath) {
      begin('workspace');
      try {
        for (const repoId of impact.affectedRepositories) {
          const ws = await this.workspace.prepare(
            task,
            repoId,
            this.resolveRepoPath(repoId),
            this.resolveBaseBranch?.(repoId)
          );
          workspaces.push(ws);
          workdirs[repoId] = ws.workdir;
          job?.setRepo({ repoId, workdir: ws.workdir, branch: ws.branch, managedByGit: ws.managedByGit });
          this.log(
            'WORKSPACE',
            ws.managedByGit
              ? `${repoId}: branch ${ws.branch} in worktree ${ws.workdir}`
              : `${repoId}: not a standalone git repo, working in place (${ws.workdir})`
          );
        }
        end('workspace', 'passed');
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.log('RESULT', `Failed at Workspace setup: ${errorMessage}`);
        end('workspace', 'failed', errorMessage);
        return fail('EXECUTION_FAILED', `Workspace setup failed: ${errorMessage}`, {
          impact,
          deduplication,
          branches: toBranches(workspaces)
        });
      }
    }

    // Step 3: Team Agent Coordination
    this.log(
      'TEAM AGENT',
      `Coordinating work across repositories: ${impact.affectedRepositories.join(', ')}`
    );

    this.log(this.aiProvider.name.toUpperCase(), 'Generating implementation...');
    begin('team');

    let teamResult: TeamExecutionResult;
    try {
      teamResult = await this.teamAgent.coordinate(task, impact, workdirs);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Code Modification: ${errorMessage}`);
      end('team', 'failed', errorMessage);
      return fail('EXECUTION_FAILED', `Team coordination failed: ${errorMessage}`, {
        impact,
        deduplication,
        ...branchesIf(workspaces)
      });
    }

    if (!teamResult.success) {
      this.log('RESULT', `Failed at Code Modification: ${teamResult.error}`);
      end('team', 'failed', teamResult.error);
      return fail('EXECUTION_FAILED', teamResult.error || 'Team execution failed', {
        impact,
        deduplication,
        teamResult,
        ...branchesIf(workspaces)
      });
    }
    end('team', 'passed');

    // Step 4: Testing Agent Verification
    this.log('TESTING', 'Running tests on modified repositories...');
    begin('verify');
    let testingResult: TestingResult;
    try {
      testingResult = await this.testingAgent.runTests(impact.affectedRepositories, workdirs);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Testing: ${errorMessage}`);
      end('verify', 'failed', errorMessage);
      return fail('TEST_FAILED', `Testing failed: ${errorMessage}`, {
        impact,
        deduplication,
        teamResult,
        ...branchesIf(workspaces)
      });
    }

    if (!testingResult.overallSuccess) {
      const failedDetails = testingResult.repoResults
        .filter((r) => !r.success)
        .map((r) => `[${r.repoId}]: ${r.summary}`)
        .join('; ');
      const combinedError = `${testingResult.summary} Details: ${failedDetails}`;
      this.log('RESULT', `Failed: Tests failed.\n${combinedError}`);
      end('verify', 'failed', combinedError);
      return fail('TEST_FAILED', combinedError, {
        impact,
        deduplication,
        teamResult,
        testingResult,
        ...branchesIf(workspaces)
      });
    }
    end('verify', 'passed', testingResult.summary);

    // Step 4b (optional): commit each repo's changes on its ticket branch (never pushed)
    const branches = toBranches(workspaces);
    if (this.workspace && workspaces.some((w) => w.managedByGit)) {
      begin('commit');
      try {
        for (const ws of workspaces) {
          if (!ws.managedByGit) continue;
          const sha = await this.workspace.commit(task, ws);
          const entry = branches.find((b) => b.repoId === ws.repoId);
          if (entry && sha) entry.commit = sha;
          job?.setRepo({ repoId: ws.repoId, workdir: ws.workdir, branch: ws.branch, commit: sha, managedByGit: true });
          this.log('COMMIT', `${ws.repoId}: ${sha ? `${ws.branch} @ ${sha.slice(0, 10)}` : 'no changes to commit'}`);
        }
        end('commit', 'passed');
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.log('RESULT', `Failed at Commit: ${errorMessage}`);
        end('commit', 'failed', errorMessage);
        return fail('EXECUTION_FAILED', `Commit failed: ${errorMessage}`, {
          impact,
          deduplication,
          teamResult,
          testingResult,
          branches
        });
      }
    }

    // Register successfully completed task in deduplication agent with modified files
    const changedFiles = teamResult.repoResults.flatMap((r) =>
      r.changedFiles.map((f) => `${r.repoId}/${f}`)
    );
    await this.dedupAgent.registerCompletedTask(task, changedFiles);

    this.log('RESULT', 'Success');

    return {
      taskId: task.id,
      success: true,
      status: 'COMPLETED',
      impact,
      deduplication,
      teamResult,
      testingResult,
      ...(workspaces.length > 0 ? { branches } : {}),
      durationMs: Date.now() - startTime
    };
  }
}

function toBranches(workspaces: RepoWorkspace[]): RepoBranchResult[] {
  return workspaces.map((w) => ({
    repoId: w.repoId,
    workdir: w.workdir,
    managedByGit: w.managedByGit,
    ...(w.branch ? { branch: w.branch } : {})
  }));
}

/** Adds `branches` to a result only when workspaces were used (keeps old result shape otherwise). */
function branchesIf(workspaces: RepoWorkspace[]): Partial<OrchestratorResult> {
  return workspaces.length > 0 ? { branches: toBranches(workspaces) } : {};
}
