import { describe, it, expect } from 'vitest';
import { JiraClient, adfToText, extractAcceptanceCriteria } from '../src/integrations/jira/jira-client.js';

describe('Jira integration', () => {
  const adfDescription = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Add GET /health to the payment service.' }] },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Acceptance Criteria' }] },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'GET /health returns 200' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Response contains status UP' }] }] }
        ]
      },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Notes' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Low risk.' }] }
    ]
  };

  it('converts ADF to text and extracts acceptance criteria', () => {
    const text = adfToText(adfDescription);
    const { criteria, remainder } = extractAcceptanceCriteria(text);
    expect(criteria).toEqual(['GET /health returns 200', 'Response contains status UP']);
    expect(remainder).toContain('Add GET /health to the payment service.');
    expect(remainder).toContain('Low risk.');
    expect(remainder).not.toContain('Acceptance Criteria');
  });

  it('fetches an issue and maps it to a TaskInput', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return new Response(
        JSON.stringify({
          key: 'RT-42',
          fields: {
            summary: 'Add health endpoint',
            description: adfDescription,
            labels: ['repo-a'],
            components: [{ name: 'payment' }],
            status: { name: 'Ready for Dev' }
          }
        }),
        { status: 200 }
      );
    }) as typeof fetch;

    const jira = new JiraClient({
      baseUrl: 'https://example.atlassian.net/',
      email: 'bot@example.com',
      apiToken: 'token',
      fetchImpl
    });
    const task = await jira.getTask('RT-42');

    expect(requests[0].url).toMatch(/^https:\/\/example\.atlassian\.net\/rest\/api\/3\/issue\/RT-42\?fields=/);
    expect((requests[0].init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
    expect(task.id).toBe('RT-42');
    expect(task.title).toBe('Add health endpoint');
    expect(task.acceptanceCriteria).toHaveLength(2);
    expect(task.metadata?.labels).toEqual(['repo-a']);
    expect(task.metadata?.components).toEqual(['payment']);
    expect(task.metadata?.url).toBe('https://example.atlassian.net/browse/RT-42');
  });

  it('reports a helpful error on 401', async () => {
    const fetchImpl = (async () => new Response('Unauthorized', { status: 401 })) as unknown as typeof fetch;
    const jira = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 'b', fetchImpl });
    await expect(jira.getTask('RT-1')).rejects.toThrow(/401.*JIRA_API_TOKEN/);
  });

  it('fails fast when configuration is missing', () => {
    const saved = { ...process.env };
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
    try {
      expect(() => new JiraClient()).toThrow(/JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);
    } finally {
      process.env = saved;
    }
  });
});
