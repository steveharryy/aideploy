import type {
  AIProvider,
  ImpactAnalysisResult,
  OrchestratorResult,
  TaskInput,
  TeamExecutionResult,
  TestingResult
} from '../models/types.js';
import { ImpactAnalysisAgent, type IImpactAnalysisAgent } from '../agents/impact-analysis/agent.js';
import { DeduplicationAgent, type IDeduplicationAgent } from '../agents/deduplication/agent.js';
import { TeamAgent, type ITeamAgent } from '../agents/team-agent/team-agent.js';
import { TestingAgent, type ITestingAgent } from '../agents/testing/agent.js';

export interface OrchestratorOptions {
  aiProvider: AIProvider;
  impactAgent?: IImpactAnalysisAgent;
  dedupAgent?: IDeduplicationAgent;
  teamAgent?: ITeamAgent;
  testingAgent?: ITestingAgent;
  silent?: boolean;
}

export class Orchestrator {
  private aiProvider: AIProvider;
  private impactAgent: IImpactAnalysisAgent;
  private dedupAgent: IDeduplicationAgent;
  private teamAgent: ITeamAgent;
  private testingAgent: ITestingAgent;
  private silent: boolean;

  constructor(options: OrchestratorOptions) {
    this.aiProvider = options.aiProvider;
    this.silent = options.silent ?? false;

    // Use injected agents or defaults
    this.impactAgent = options.impactAgent || new ImpactAnalysisAgent();
    this.dedupAgent = options.dedupAgent || new DeduplicationAgent();
    this.teamAgent = options.teamAgent || new TeamAgent(this.aiProvider);
    this.testingAgent = options.testingAgent || new TestingAgent();
  }

  private log(tag: string, message: string): void {
    if (!this.silent) {
      console.log(`\n[${tag}]\n${message}`);
    }
  }

  async run(task: TaskInput): Promise<OrchestratorResult> {
    const startTime = Date.now();

    this.log('ORCHESTRATOR', `Task received: ${task.id} - ${task.title}`);

    // Step 1: Impact Analysis
    let impact: ImpactAnalysisResult;
    try {
      this.log('IMPACT ANALYSIS', 'Analyzing affected repositories...');
      impact = await this.impactAgent.analyze(task);
      this.log(
        'IMPACT ANALYSIS',
        `Identified ${impact.affectedRepositories.length} affected repo(s): ${impact.affectedRepositories.join(', ')} (Confidence: ${(impact.confidence * 100).toFixed(0)}%)`
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Impact Analysis: ${errorMessage}`);
      return {
        taskId: task.id,
        success: false,
        status: 'IMPACT_FAILED',
        error: `Impact Analysis failed: ${errorMessage}`,
        durationMs: Date.now() - startTime
      };
    }

    // Step 2: Deduplication Check
    this.log('DEDUPLICATION', 'Checking for duplicate/overlapping work...');
    let deduplication;
    try {
      deduplication = await this.dedupAgent.check(task);
      if (deduplication.status === 'duplicate') {
        this.log(
          'DEDUPLICATION',
          `Task flagged as DUPLICATE of ${deduplication.overlappingTaskId || 'prior work'}. Halting pipeline.\nReason: ${deduplication.reason}`
        );
        this.log('RESULT', 'Failed: Task is duplicate');
        return {
          taskId: task.id,
          success: false,
          status: 'DUPLICATE_SKIPPED',
          impact,
          deduplication,
          error: deduplication.reason,
          durationMs: Date.now() - startTime
        };
      }
      this.log(
        'DEDUPLICATION',
        `Task status: ${deduplication.status.toUpperCase()} (${deduplication.reason})`
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Deduplication: ${errorMessage}`);
      return {
        taskId: task.id,
        success: false,
        status: 'DEDUPLICATION_FAILED',
        impact,
        error: `Deduplication check error: ${errorMessage}`,
        durationMs: Date.now() - startTime
      };
    }

    // Step 3: Team Agent Coordination
    this.log(
      'TEAM AGENT',
      `Coordinating work across repositories: ${impact.affectedRepositories.join(', ')}`
    );

    this.log(this.aiProvider.name.toUpperCase(), 'Generating implementation...');

    let teamResult: TeamExecutionResult;
    try {
      teamResult = await this.teamAgent.coordinate(task, impact);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Code Modification: ${errorMessage}`);
      return {
        taskId: task.id,
        success: false,
        status: 'EXECUTION_FAILED',
        impact,
        deduplication,
        error: `Team coordination failed: ${errorMessage}`,
        durationMs: Date.now() - startTime
      };
    }

    if (!teamResult.success) {
      this.log('RESULT', `Failed at Code Modification: ${teamResult.error}`);
      return {
        taskId: task.id,
        success: false,
        status: 'EXECUTION_FAILED',
        impact,
        deduplication,
        teamResult,
        error: teamResult.error,
        durationMs: Date.now() - startTime
      };
    }

    // Step 4: Testing Agent Verification
    this.log('TESTING', 'Running tests on modified repositories...');
    let testingResult: TestingResult;
    try {
      testingResult = await this.testingAgent.runTests(impact.affectedRepositories);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.log('RESULT', `Failed at Testing: ${errorMessage}`);
      return {
        taskId: task.id,
        success: false,
        status: 'TEST_FAILED',
        impact,
        deduplication,
        teamResult,
        error: `Testing failed: ${errorMessage}`,
        durationMs: Date.now() - startTime
      };
    }

    if (!testingResult.overallSuccess) {
      const failedDetails = testingResult.repoResults
        .filter((r) => !r.success)
        .map((r) => `[${r.repoId}]: ${r.summary}`)
        .join('; ');
      const combinedError = `${testingResult.summary} Details: ${failedDetails}`;
      this.log('RESULT', `Failed: Tests failed.\n${combinedError}`);
      return {
        taskId: task.id,
        success: false,
        status: 'TEST_FAILED',
        impact,
        deduplication,
        teamResult,
        testingResult,
        error: combinedError,
        durationMs: Date.now() - startTime
      };
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
      durationMs: Date.now() - startTime
    };
  }
}
