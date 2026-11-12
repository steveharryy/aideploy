import { describe, it, expect } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ClaudeProvider } from '../src/providers/claude-provider.js';
import type { AIProviderGenerateOptions } from '../src/models/types.js';

// All tests use a fake client: no network, no API key, no cost.

const generateOptions: AIProviderGenerateOptions = {
  task: {
    id: 'RT-1',
    title: 'Add health endpoint',
    description: 'Add GET /health',
    acceptanceCriteria: ['Returns status UP']
  },
  repoContext: {
    repoId: 'repo-a',
    repoPath: '/tmp/repo-a',
    task: { id: 'RT-1', title: 't', description: 'd', acceptanceCriteria: [] },
    existingFiles: [{ path: 'src/server.ts', content: 'export class PaymentServer {}' }]
  }
};

function fakeClaude(message: Record<string, unknown>) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          calls.push(params);
          return { finalMessage: async () => message };
        }
      }
    }
  } as unknown as Anthropic;
  return { client, calls };
}

describe('ClaudeProvider', () => {
  it('parses structured output into file changes and sends schema + model', async () => {
    const { client, calls } = fakeClaude({
      model: 'claude-opus-5-5',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            reasoning: 'Added getHealth',
            fileChanges: [{ path: 'src/server.ts', action: 'modify', content: 'new' }]
          })
        }
      ]
    });

    const res = await new ClaudeProvider({ client, model: 'claude-opus-5-5' }).generateChanges(generateOptions);

    expect(res.fileChanges).toEqual([{ path: 'src/server.ts', action: 'modify', content: 'new' }]);
    expect(res.reasoning).toContain('Added getHealth');
    expect(res.reasoning).toContain('tokens in/out: 100/50');
    expect(res.providerName).toBe('claude:claude-opus-5-5');

    const params = calls[0] as { model: string; output_config: { format: { type: string } } };
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.output_config.format.type).toBe('json_schema');
  });

  it('refuses to apply truncated output', async () => {
    const { client } = fakeClaude({ model: 'm', stop_reason: 'max_tokens', content: [] });
    await expect(new ClaudeProvider({ client }).generateChanges(generateOptions)).rejects.toThrow(/truncated/);
  });

  it('surfaces refusals', async () => {
    const { client } = fakeClaude({ model: 'm', stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] });
    await expect(new ClaudeProvider({ client }).generateChanges(generateOptions)).rejects.toThrow(/declined/);
  });

  it('refuses oversized repositories instead of truncating them (and makes no API call)', async () => {
    const { client, calls } = fakeClaude({ model: 'm', stop_reason: 'end_turn', content: [] });
    const provider = new ClaudeProvider({ client, maxContextChars: 10 });
    await expect(provider.generateChanges(generateOptions)).rejects.toThrow(/over the 10 limit/);
    expect(calls).toHaveLength(0);
  });
});
