import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  AIProvider,
  AIProviderGenerateOptions,
  AIProviderResponse,
  FileChange
} from '../models/types.js';

/**
 * HandoffProvider
 *
 * Lets an external coding agent (e.g. Claude Code working interactively with a developer)
 * act as the "AI" step of the pipeline. The agent writes its proposed change set to
 *
 *   <HANDOFF_DIR>/<TICKET>/<repoId>.json   →   { "reasoning": "...", "author": "...", "fileChanges": [...] }
 *
 * and the orchestrator applies it exactly like any other provider's output: through the
 * Repo Agent's path-safety and test-integrity guards, then the repo's verify contract,
 * then commit/job state. Nothing is generated here; a missing handoff file fails the repo.
 */
export class HandoffProvider implements AIProvider {
  public readonly name = 'handoff';
  private handoffDir: string;

  constructor(handoffDir?: string) {
    this.handoffDir = handoffDir || process.env.HANDOFF_DIR || path.resolve(process.cwd(), '.handoff');
  }

  handoffPath(taskId: string, repoId: string): string {
    return path.join(this.handoffDir, taskId.replace(/[^A-Za-z0-9._-]/g, '_'), `${repoId}.json`);
  }

  async generateChanges(options: AIProviderGenerateOptions): Promise<AIProviderResponse> {
    const { task, repoContext } = options;
    const file = this.handoffPath(task.id, repoContext.repoId);

    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf-8');
    } catch {
      throw new Error(
        `HandoffProvider: no prepared change set for ${task.id} in repo ${repoContext.repoId} (expected ${file}).`
      );
    }

    let parsed: { reasoning?: unknown; author?: unknown; fileChanges?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (err: unknown) {
      throw new Error(`HandoffProvider: ${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
    }

    if (!Array.isArray(parsed.fileChanges)) {
      throw new Error(`HandoffProvider: ${file} has no "fileChanges" array.`);
    }

    const fileChanges: FileChange[] = parsed.fileChanges.map((c: unknown, i: number) => {
      const change = c as { path?: unknown; action?: unknown; content?: unknown };
      if (typeof change.path !== 'string' || !['create', 'modify', 'delete'].includes(change.action as string)) {
        throw new Error(`HandoffProvider: fileChanges[${i}] in ${file} has an invalid path or action.`);
      }
      if (change.action !== 'delete' && typeof change.content !== 'string') {
        throw new Error(`HandoffProvider: fileChanges[${i}] (${change.path}) is missing its full file content.`);
      }
      return {
        path: change.path,
        action: change.action as FileChange['action'],
        content: typeof change.content === 'string' ? change.content : ''
      };
    });

    const author = typeof parsed.author === 'string' && parsed.author ? parsed.author : 'external-agent';
    return {
      providerName: `${this.name}:${author}`,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : 'Change set supplied via handoff.',
      fileChanges,
      rawResponse: raw
    };
  }
}
