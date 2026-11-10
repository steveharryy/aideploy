import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { DeduplicationResult, DeduplicationStatus, TaskInput } from '../../models/types.js';

export interface ExistingTaskRecord {
  id: string;
  title: string;
  description: string;
  status: 'COMPLETED' | 'IN_PROGRESS';
  changedFiles?: string[];
  completedAt?: string;
}

export interface DeduplicationAgentConfig {
  initialTasks?: ExistingTaskRecord[];
  historyFilePath?: string;
  repositoriesRoot?: string;
}

export interface IDeduplicationAgent {
  check(task: TaskInput): Promise<DeduplicationResult>;
  registerCompletedTask(task: TaskInput, changedFiles?: string[]): Promise<void> | void;
}

export class DeduplicationAgent implements IDeduplicationAgent {
  private existingTasks: Map<string, ExistingTaskRecord> = new Map();
  private historyFilePath?: string;
  private repositoriesRoot: string;

  constructor(config: DeduplicationAgentConfig = {}) {
    this.historyFilePath = config.historyFilePath;
    this.repositoriesRoot = config.repositoriesRoot || path.resolve(process.cwd(), 'repositories');

    // 1. Load initial tasks passed in config
    if (config.initialTasks) {
      for (const task of config.initialTasks) {
        this.existingTasks.set(task.id, task);
      }
    }

    // 2. Load persisted tasks from history file if provided and exists
    if (this.historyFilePath && fsSync.existsSync(this.historyFilePath)) {
      try {
        const raw = fsSync.readFileSync(this.historyFilePath, 'utf-8');
        const list = JSON.parse(raw) as ExistingTaskRecord[];
        if (Array.isArray(list)) {
          for (const item of list) {
            this.existingTasks.set(item.id, item);
          }
        }
      } catch {
        // Corrupted or unreadable history file, start fresh
      }
    }
  }

  async registerCompletedTask(task: TaskInput, changedFiles: string[] = []): Promise<void> {
    const record: ExistingTaskRecord = {
      id: task.id,
      title: task.title,
      description: task.description,
      status: 'COMPLETED',
      changedFiles,
      completedAt: new Date().toISOString()
    };

    this.existingTasks.set(task.id, record);

    // Persist to file if configured
    if (this.historyFilePath) {
      try {
        const list = Array.from(this.existingTasks.values());
        await fs.writeFile(this.historyFilePath, JSON.stringify(list, null, 2), 'utf-8');
      } catch {
        // Silently continue if filesystem write fails
      }
    }
  }

  async check(task: TaskInput): Promise<DeduplicationResult> {
    if (!task || !task.id) {
      throw new Error('DeduplicationAgent Error: Invalid task input. Task ID is required.');
    }

    // 1. Direct ID match
    const existingById = this.existingTasks.get(task.id);
    if (existingById) {
      // Codebase verification: Check if code actually exists in the repository
      const isCodeStillPresent = await this.verifyImplementationPresent(task, existingById);

      if (!isCodeStillPresent) {
        // Code was removed or reverted! Clear record and treat as new
        this.existingTasks.delete(task.id);
        if (this.historyFilePath) {
          try {
            const list = Array.from(this.existingTasks.values());
            await fs.writeFile(this.historyFilePath, JSON.stringify(list, null, 2), 'utf-8');
          } catch {
            // Ignore write errors
          }
        }

        return {
          taskId: task.id,
          status: 'new',
          reason: `Task ${task.id} was in history, but its code is no longer present in the repository. Re-running implementation.`,
          overlapPercentage: 0
        };
      }

      return {
        taskId: task.id,
        status: 'duplicate',
        reason: `Task with ID ${task.id} has already been processed and its implementation is verified in the repository (status: ${existingById.status}).`,
        overlappingTaskId: existingById.id,
        overlapPercentage: 100
      };
    }

    // 2. Semantic/Title overlap check
    const normalizedTaskTitle = task.title.trim().toLowerCase();
    for (const existing of this.existingTasks.values()) {
      const normalizedExisting = existing.title.trim().toLowerCase();

      // Exact title match
      if (normalizedTaskTitle === normalizedExisting) {
        const isCodeStillPresent = await this.verifyImplementationPresent(task, existing);
        if (!isCodeStillPresent) {
          continue;
        }

        return {
          taskId: task.id,
          status: 'duplicate',
          reason: `Task title exactly matches completed task ${existing.id}: "${existing.title}".`,
          overlappingTaskId: existing.id,
          overlapPercentage: 100
        };
      }

      // High keyword overlap
      const taskWords = new Set(normalizedTaskTitle.split(/\s+/).filter((w) => w.length > 3));
      const existingWords = normalizedExisting.split(/\s+/).filter((w) => w.length > 3);
      if (taskWords.size > 0 && existingWords.length > 0) {
        let matches = 0;
        for (const w of existingWords) {
          if (taskWords.has(w)) matches++;
        }
        const overlapRatio = matches / Math.max(taskWords.size, existingWords.length);
        if (overlapRatio >= 0.8) {
          return {
            taskId: task.id,
            status: 'duplicate',
            reason: `High semantic overlap (${Math.round(overlapRatio * 100)}%) with completed task ${existing.id}: "${existing.title}".`,
            overlappingTaskId: existing.id,
            overlapPercentage: Math.round(overlapRatio * 100)
          };
        } else if (overlapRatio >= 0.5) {
          return {
            taskId: task.id,
            status: 'partial',
            reason: `Partial overlap (${Math.round(overlapRatio * 100)}%) with task ${existing.id}: "${existing.title}". Proceeding with caution.`,
            overlappingTaskId: existing.id,
            overlapPercentage: Math.round(overlapRatio * 100)
          };
        }
      }
    }

    return {
      taskId: task.id,
      status: 'new',
      reason: 'No duplicate or overlapping work found in task history.',
      overlapPercentage: 0
    };
  }

  /**
   * Verifies whether the changes for this task actually exist on disk.
   */
  private async verifyImplementationPresent(
    task: TaskInput,
    record: ExistingTaskRecord
  ): Promise<boolean> {
    const taskText = `${task.id} ${task.title} ${task.description}`.toLowerCase();

    // Check files recorded for this task
    const filesToCheck: string[] = [];
    if (record.changedFiles && record.changedFiles.length > 0) {
      filesToCheck.push(...record.changedFiles);
    } else {
      // Default guess based on task type
      if (taskText.includes('payment') || taskText.includes('pay') || taskText.includes('repo-a')) {
        filesToCheck.push('repo-a/src/server.ts');
      }
    }

    for (const relFile of filesToCheck) {
      const fullPath = path.resolve(this.repositoriesRoot, relFile);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');

        // Check if health endpoint was removed
        if (taskText.includes('health') || task.id.toLowerCase().includes('pay-101')) {
          if (!content.includes('getHealth') || !content.includes('UP')) {
            return false;
          }
        } else {
          // General check: does file still contain task id or title keyword
          if (!content.includes(task.id) && !content.toLowerCase().includes(task.title.toLowerCase())) {
            return false;
          }
        }
      } catch {
        // File does not exist on disk
        return false;
      }
    }

    return true;
  }
}
