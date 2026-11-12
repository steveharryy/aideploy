import Anthropic from '@anthropic-ai/sdk';
import type {
  AIProvider,
  AIProviderGenerateOptions,
  AIProviderResponse,
  FileChange
} from '../models/types.js';

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeProviderConfig {
  /** Optional explicit key. If omitted, the SDK resolves ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / `ant auth login` profile. */
  apiKey?: string;
  model?: string;
  effort?: ClaudeEffort;
  maxTokens?: number;
  /** Server-side refusal fallback ("default" = model-defined fallback chain). Set false to disable. */
  enableFallbacks?: boolean;
  /** Refuse to send more than this many characters of repository files (cost/size guard). */
  maxContextChars?: number;
  /** Inject a pre-built client (used by tests). */
  client?: Anthropic;
}

const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT: ClaudeEffort = 'high';
const DEFAULT_MAX_TOKENS = 64000;
const DEFAULT_MAX_CONTEXT_CHARS = 400_000; // roughly 100K tokens of repository files
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const SYSTEM_PROMPT = `You are a senior software engineer acting as a Repo Agent inside an AI development orchestrator.
You are given one repository's files and one task (usually a Jira ticket). Implement the task in this repository only.

Rules:
- Return file changes, not instructions. For "create" and "modify", "content" must be the COMPLETE new file content (it overwrites the file). For "delete", set "content" to "".
- Paths are relative to the repository root. Never reference files outside the repository.
- Keep existing behaviour, exports and public method names intact unless the task explicitly asks to change them; the repository's own verify commands run after your changes.
- Never delete, skip, or weaken existing tests; add tests for new behaviour where the repository has tests.
- Change only what the task needs. Prefer modifying existing files over adding new ones when it fits the codebase.
- If the task does not apply to this repository, return an empty "fileChanges" array and say why in "reasoning".`;

/** JSON schema the response is constrained to (structured outputs). */
const FILE_CHANGES_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Brief explanation of what was changed and why.'
    },
    fileChanges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to the repository root.' },
          action: { type: 'string', enum: ['create', 'modify', 'delete'] },
          content: { type: 'string', description: 'Full file content; empty string for delete.' }
        },
        required: ['path', 'action', 'content'],
        additionalProperties: false
      }
    }
  },
  required: ['reasoning', 'fileChanges'],
  additionalProperties: false
} as const;

/**
 * ClaudeProvider
 *
 * Implements AIProvider on top of the official Anthropic TypeScript SDK.
 * Uses structured outputs so the response is always schema-valid JSON,
 * streams to avoid HTTP timeouts on large file outputs, and enables
 * server-side refusal fallbacks by default.
 */
export class ClaudeProvider implements AIProvider {
  public readonly name = 'claude';
  private client: Anthropic;
  private model: string;
  private effort: ClaudeEffort;
  private maxTokens: number;
  private enableFallbacks: boolean;
  private maxContextChars: number;

  constructor(config: ClaudeProviderConfig = {}) {
    this.client =
      config.client ?? new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});
    this.model = config.model || process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
    this.effort =
      config.effort || (process.env.ANTHROPIC_EFFORT as ClaudeEffort | undefined) || DEFAULT_EFFORT;
    this.maxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;
    this.enableFallbacks =
      config.enableFallbacks ?? process.env.ANTHROPIC_DISABLE_FALLBACKS !== 'true';
    this.maxContextChars =
      config.maxContextChars || Number(process.env.ANTHROPIC_MAX_CONTEXT_CHARS) || DEFAULT_MAX_CONTEXT_CHARS;
  }

  async generateChanges(options: AIProviderGenerateOptions): Promise<AIProviderResponse> {
    const { task, repoContext, systemPrompt } = options;

    const totalChars = repoContext.existingFiles.reduce((n, f) => n + f.content.length, 0);
    if (totalChars > this.maxContextChars) {
      // Never silently truncate: a partial view of the repo produces wrong code.
      throw new Error(
        `ClaudeProvider: repository ${repoContext.repoId} has ${totalChars.toLocaleString()} characters of source, ` +
          `over the ${this.maxContextChars.toLocaleString()} limit (ANTHROPIC_MAX_CONTEXT_CHARS). ` +
          'Narrow the files sent for this repo before using the API provider on it.'
      );
    }

    const fileSnapshots = repoContext.existingFiles
      .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
      .join('\n\n');

    const criteria = task.acceptanceCriteria.length
      ? task.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
      : '  (none provided — infer from the description)';

    const userPrompt = `<repository id="${repoContext.repoId}">
${fileSnapshots || '(repository is currently empty)'}
</repository>

<task>
ID: ${task.id}
Title: ${task.title}
Description:
${task.description}

Acceptance criteria:
${criteria}
</task>

Implement the task in repository ${repoContext.repoId}.`;

    let message;
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt || SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        output_config: {
          effort: this.effort,
          format: { type: 'json_schema', schema: FILE_CHANGES_SCHEMA }
        },
        messages: [{ role: 'user', content: userPrompt }],
        ...(this.enableFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {})
      });
      message = await stream.finalMessage();
    } catch (err: unknown) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error(
          'ClaudeProvider: authentication failed. Set ANTHROPIC_API_KEY (or run `ant auth login`), or use AI_PROVIDER=mock.'
        );
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error(`ClaudeProvider: rate limited by Anthropic API (${err.message}).`);
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`ClaudeProvider: API error ${err.status ?? ''}: ${err.message}`);
      }
      throw err;
    }

    if (message.stop_reason === 'refusal') {
      throw new Error(
        `ClaudeProvider: request declined (category: ${message.stop_details?.category ?? 'unknown'}).`
      );
    }
    if (message.stop_reason === 'max_tokens') {
      throw new Error(
        `ClaudeProvider: output truncated at max_tokens=${this.maxTokens}; refusing to apply partial file changes.`
      );
    }

    const text = message.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed = this.parseResponse(text);
    const usage = message.usage as { input_tokens?: number; output_tokens?: number } | undefined;

    return {
      providerName: `${this.name}:${message.model}`,
      reasoning:
        (parsed.reasoning || 'Changes generated by Claude.') +
        (usage ? ` [tokens in/out: ${usage.input_tokens ?? '?'}/${usage.output_tokens ?? '?'}]` : ''),
      fileChanges: parsed.fileChanges,
      rawResponse: text
    };
  }

  private parseResponse(text: string): { reasoning: string; fileChanges: FileChange[] } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`ClaudeProvider: response was not valid JSON (${message}).`);
    }

    const obj = parsed as { reasoning?: unknown; fileChanges?: unknown };
    if (!Array.isArray(obj.fileChanges)) {
      throw new Error('ClaudeProvider: response is missing the fileChanges array.');
    }

    const fileChanges: FileChange[] = obj.fileChanges.map((raw, i) => {
      const c = raw as { path?: unknown; action?: unknown; content?: unknown };
      if (typeof c.path !== 'string' || !['create', 'modify', 'delete'].includes(c.action as string)) {
        throw new Error(`ClaudeProvider: fileChanges[${i}] has an invalid path or action.`);
      }
      return {
        path: c.path,
        action: c.action as FileChange['action'],
        content: typeof c.content === 'string' ? c.content : ''
      };
    });

    return { reasoning: typeof obj.reasoning === 'string' ? obj.reasoning : '', fileChanges };
  }
}
