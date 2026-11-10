/**
 * Core domain types and interfaces for the AI Orchestrator POC.
 */

export interface TaskInput {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  metadata?: Record<string, unknown>;
}

export interface ImpactAnalysisResult {
  taskId: string;
  affectedRepositories: string[];
  affectedModules: string[];
  affectedFiles: string[];
  confidence: number;
  reasoning: string;
}

export type DeduplicationStatus = 'new' | 'duplicate' | 'partial';

export interface DeduplicationResult {
  taskId: string;
  status: DeduplicationStatus;
  reason: string;
  overlappingTaskId?: string;
  overlapPercentage?: number;
}

export interface FileChange {
  path: string; // Relative to repository root
  action: 'create' | 'modify' | 'delete';
  content?: string;
}

export interface RepoFileSnapshot {
  path: string;
  content: string;
}

export interface RepoContext {
  repoId: string;
  repoPath: string;
  task: TaskInput;
  existingFiles: RepoFileSnapshot[];
  dependencies?: string[];
}

export interface AIProviderResponse {
  reasoning: string;
  fileChanges: FileChange[];
  providerName: string;
  rawResponse?: string;
}

export interface AIProviderGenerateOptions {
  task: TaskInput;
  repoContext: RepoContext;
  systemPrompt?: string;
}

export interface AIProvider {
  readonly name: string;
  generateChanges(options: AIProviderGenerateOptions): Promise<AIProviderResponse>;
}

export interface RepoExecutionResult {
  repoId: string;
  success: boolean;
  changedFiles: string[];
  providerUsed: string;
  reasoning: string;
  message: string;
  error?: string;
}

export interface TeamExecutionPlan {
  repoId: string;
  dependsOn?: string[];
}

export interface TeamExecutionResult {
  success: boolean;
  repoResults: RepoExecutionResult[];
  executionPlan: TeamExecutionPlan[];
  error?: string;
}

export interface TestCheckResult {
  name: string;
  passed: boolean;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface RepoTestResult {
  repoId: string;
  success: boolean;
  checks: TestCheckResult[];
  summary: string;
}

export interface TestingResult {
  overallSuccess: boolean;
  repoResults: RepoTestResult[];
  summary: string;
}

export type OrchestrationStatus =
  | 'COMPLETED'
  | 'DUPLICATE_SKIPPED'
  | 'IMPACT_FAILED'
  | 'DEDUPLICATION_FAILED'
  | 'EXECUTION_FAILED'
  | 'TEST_FAILED';

export interface OrchestratorResult {
  taskId: string;
  success: boolean;
  status: OrchestrationStatus;
  impact?: ImpactAnalysisResult;
  deduplication?: DeduplicationResult;
  teamResult?: TeamExecutionResult;
  testingResult?: TestingResult;
  error?: string;
  durationMs: number;
}

