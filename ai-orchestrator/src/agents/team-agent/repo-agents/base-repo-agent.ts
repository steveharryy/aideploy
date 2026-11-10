import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AIProvider,
  FileChange,
  RepoContext,
  RepoExecutionResult,
  RepoFileSnapshot,
  TaskInput
} from '../../../models/types.js';

export interface IRepoAgent {
  readonly repoId: string;
  readonly repoPath: string;
  execute(task: TaskInput): Promise<RepoExecutionResult>;
}

/**
 * BaseRepoAgent
 *
 * Reusable base implementation for repository-specific agents.
 * Provides file inspection, context construction, AI provider invocation,
 * safe boundary-checked file mutations, and error handling.
 */
export abstract class BaseRepoAgent implements IRepoAgent {
  public readonly repoId: string;
  public readonly repoPath: string;
  protected aiProvider: AIProvider;

  constructor(repoId: string, repoPath: string, aiProvider: AIProvider) {
    this.repoId = repoId;
    this.repoPath = repoPath;
    this.aiProvider = aiProvider;
  }

  async execute(task: TaskInput): Promise<RepoExecutionResult> {
    try {
      // 1. Verify repository exists
      await this.verifyRepoDirectory();

      // 2. Read relevant files to build focused context
      const existingFiles = await this.collectRelevantFiles(this.repoPath);

      const repoContext: RepoContext = {
        repoId: this.repoId,
        repoPath: this.repoPath,
        task,
        existingFiles
      };

      // 3. Call AI Provider
      const aiResponse = await this.aiProvider.generateChanges({
        task,
        repoContext
      });

      // 4. Apply changes within repository boundary
      const appliedFiles = await this.applyFileChanges(aiResponse.fileChanges);

      return {
        repoId: this.repoId,
        success: true,
        changedFiles: appliedFiles,
        providerUsed: aiResponse.providerName,
        reasoning: aiResponse.reasoning,
        message: `Successfully applied ${appliedFiles.length} file change(s) in repository ${this.repoId}.`
      };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        repoId: this.repoId,
        success: false,
        changedFiles: [],
        providerUsed: this.aiProvider.name,
        reasoning: 'Execution failed during repo agent processing.',
        message: `Failed to execute changes in repository ${this.repoId}: ${errorMessage}`,
        error: errorMessage
      };
    }
  }

  private async verifyRepoDirectory(): Promise<void> {
    try {
      const stats = await fs.stat(this.repoPath);
      if (!stats.isDirectory()) {
        throw new Error(`Repository path exists but is not a directory: ${this.repoPath}`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Repository not found at path: ${this.repoPath}`);
      }
      throw err;
    }
  }

  private async collectRelevantFiles(
    dir: string,
    relativeBase: string = ''
  ): Promise<RepoFileSnapshot[]> {
    const snapshots: RepoFileSnapshot[] = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.join(relativeBase, entry.name);

      if (entry.isDirectory()) {
        const nested = await this.collectRelevantFiles(fullPath, relativePath);
        snapshots.push(...nested);
      } else if (entry.isFile()) {
        if (/\.(ts|js|json|md|txt)$/.test(entry.name)) {
          const content = await fs.readFile(fullPath, 'utf-8');
          snapshots.push({
            path: relativePath,
            content
          });
        }
      }
    }

    return snapshots;
  }

  private async applyFileChanges(changes: FileChange[]): Promise<string[]> {
    const modified: string[] = [];

    for (const change of changes) {
      const targetPath = path.resolve(this.repoPath, change.path);

      if (!targetPath.startsWith(path.resolve(this.repoPath))) {
        throw new Error(`Security violation: File path escapes repository boundary: ${change.path}`);
      }

      if (change.action === 'delete') {
        try {
          await fs.unlink(targetPath);
          modified.push(change.path);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw err;
          }
        }
      } else {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, change.content ?? '', 'utf-8');
        modified.push(change.path);
      }
    }

    return modified;
  }
}

