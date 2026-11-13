import type { TaskInput } from '../../models/types.js';

export interface JiraClientConfig {
  /** e.g. https://your-site.atlassian.net */
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  /** Optional custom field holding acceptance criteria, e.g. customfield_10042. */
  acceptanceCriteriaField?: string;
  /** Inject fetch (used by tests). */
  fetchImpl?: typeof fetch;
}

/** Minimal Atlassian Document Format node. */
export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: AdfNode | string | null;
    labels?: string[];
    components?: Array<{ name: string }>;
    issuetype?: { name: string };
    status?: { name: string };
    priority?: { name: string };
    comment?: {
      comments?: Array<{ author?: { displayName?: string }; created?: string; body?: AdfNode | string }>;
    };
    [field: string]: unknown;
  };
}

/**
 * JiraClient
 *
 * Read-only Jira Cloud REST v3 client that turns issues into TaskInput objects
 * for the orchestrator. Auth: Basic (account email + API token).
 */
export class JiraClient {
  private baseUrl: string;
  private authHeader: string;
  private acField?: string;
  private fetchImpl: typeof fetch;

  constructor(config: JiraClientConfig = {}) {
    const baseUrl = config.baseUrl || process.env.JIRA_BASE_URL;
    const email = config.email || process.env.JIRA_EMAIL;
    const apiToken = config.apiToken || process.env.JIRA_API_TOKEN;

    const missing = [
      !baseUrl && 'JIRA_BASE_URL',
      !email && 'JIRA_EMAIL',
      !apiToken && 'JIRA_API_TOKEN'
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`JiraClient: missing configuration: ${missing.join(', ')}. See .env.example.`);
    }

    this.baseUrl = baseUrl!.replace(/\/+$/, '');
    this.authHeader = 'Basic ' + Buffer.from(`${email}:${apiToken}`).toString('base64');
    this.acField = config.acceptanceCriteriaField || process.env.JIRA_ACCEPTANCE_CRITERIA_FIELD || undefined;
    this.fetchImpl = config.fetchImpl || fetch;
  }

  private get fields(): string[] {
    const base = ['summary', 'description', 'labels', 'components', 'issuetype', 'status', 'priority', 'comment'];
    return this.acField ? [...base, this.acField] : base;
  }

  async getTask(issueKey: string): Promise<TaskInput> {
    const params = new URLSearchParams({ fields: this.fields.join(',') });
    const issue = await this.request<JiraIssue>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params}`
    );
    return this.toTask(issue);
  }

  async searchTasks(jql: string, maxResults = 10): Promise<TaskInput[]> {
    const data = await this.request<{ issues?: JiraIssue[] }>('/rest/api/3/search/jql', {
      method: 'POST',
      body: JSON.stringify({ jql, maxResults, fields: this.fields })
    });
    return (data.issues || []).map((i) => this.toTask(i));
  }

  // ── Write-back (used by the automation watcher) ─────────────────────────────

  /** Posts a comment: heading lines as paragraphs, optional preformatted block (e.g. the change plan). */
  async addComment(issueKey: string, lines: string[], preformatted?: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body: commentAdf(lines, preformatted) })
    });
  }

  /** Adds and/or removes labels in one update. */
  async updateLabels(issueKey: string, add: string[] = [], remove: string[] = []): Promise<void> {
    const ops = [...add.map((l) => ({ add: l })), ...remove.map((l) => ({ remove: l }))];
    if (ops.length === 0) return;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      method: 'PUT',
      body: JSON.stringify({ update: { labels: ops } })
    });
  }

  /**
   * Moves the issue to a status by name (case-insensitive, matched on the transition or its target).
   * Returns false when the workflow has no such transition from the current status.
   */
  async transition(issueKey: string, statusName: string): Promise<boolean> {
    const data = await this.request<{ transitions?: Array<{ id: string; name: string; to?: { name: string } }> }>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`
    );
    const wanted = statusName.trim().toLowerCase();
    const match = (data.transitions || []).find(
      (t) => t.name.toLowerCase() === wanted || t.to?.name.toLowerCase() === wanted
    );
    if (!match) return false;
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } })
    });
    return true;
  }

  /** Who most recently added a label (from the changelog), e.g. the approver of "ai-approved". */
  async getLabelAdder(issueKey: string, label: string): Promise<string | undefined> {
    const data = await this.request<{
      values?: Array<{ author?: { displayName?: string }; created?: string; items?: Array<{ field?: string; fromString?: string | null; toString?: string | null }> }>;
    }>(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/changelog?maxResults=100`);
    const added = (data.values || []).filter((v) =>
      (v.items || []).some(
        (i) =>
          i.field === 'labels' &&
          (i.toString || '').split(/\s+/).includes(label) &&
          !(i.fromString || '').split(/\s+/).includes(label)
      )
    );
    return added.length ? added[added.length - 1].author?.displayName : undefined;
  }

  private async request<T>(pathAndQuery: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
      ...init,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const hint =
        res.status === 401 ? ' (check JIRA_EMAIL / JIRA_API_TOKEN)' :
        res.status === 404 ? ' (issue not found or no permission)' : '';
      throw new Error(`Jira API ${res.status}${hint}: ${body.slice(0, 500)}`);
    }
    // Write endpoints (labels, transitions) answer 204 No Content.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  toTask(issue: JiraIssue): TaskInput {
    const f = issue.fields;
    const descriptionText = adfToText(f.description).trim();

    let acceptanceCriteria: string[] = [];
    if (this.acField && f[this.acField]) {
      acceptanceCriteria = toLines(adfToText(f[this.acField] as AdfNode | string));
    }
    const extracted = extractAcceptanceCriteria(descriptionText);
    if (acceptanceCriteria.length === 0) {
      acceptanceCriteria = extracted.criteria;
    }

    return {
      id: issue.key,
      title: f.summary || issue.key,
      description: extracted.remainder || descriptionText || f.summary || '',
      acceptanceCriteria,
      metadata: {
        source: 'jira',
        url: `${this.baseUrl}/browse/${issue.key}`,
        labels: f.labels || [],
        components: (f.components || []).map((c) => c.name),
        issueType: f.issuetype?.name,
        status: f.status?.name,
        priority: f.priority?.name,
        // Real ticket status/decisions often live in comments (e.g. "design needed", "done").
        comments: (f.comment?.comments || []).map((c) => ({
          author: c.author?.displayName || 'unknown',
          created: c.created || '',
          body: adfToText(c.body).trim()
        }))
      }
    };
  }
}

/** Builds an ADF comment body: one paragraph per line, plus an optional code block. */
export function commentAdf(lines: string[], preformatted?: string): AdfNode {
  const content: AdfNode[] = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }));
  if (preformatted && preformatted.trim()) {
    // Jira limits comment size; keep the plan readable rather than failing the post.
    const text = preformatted.length > 30000 ? `${preformatted.slice(0, 30000)}\n… (truncated)` : preformatted;
    content.push({ type: 'codeBlock', content: [{ type: 'text', text }] });
  }
  // ADF root: "version" is a top-level property (not inside attrs), or Jira answers 400 INVALID_INPUT.
  return { type: 'doc', version: 1, content } as unknown as AdfNode;
}

/** Converts Atlassian Document Format (or a plain string) to readable text. */
export function adfToText(node: AdfNode | string | null | undefined): string {
  if (!node) return '';
  if (typeof node === 'string') return node;

  const children = (sep = '') => (node.content || []).map((c) => adfToText(c)).join(sep);

  switch (node.type) {
    case 'text':
      return node.text || '';
    case 'hardBreak':
      return '\n';
    case 'mention':
    case 'emoji':
      return String(node.attrs?.text ?? '');
    case 'inlineCard':
      return String(node.attrs?.url ?? '');
    case 'heading':
      return `\n${'#'.repeat(Number(node.attrs?.level ?? 2))} ${children()}\n`;
    case 'paragraph':
      return `${children()}\n`;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return `${(node.content || []).map((c) => `- ${adfToText(c).trim()}`).join('\n')}\n`;
    case 'listItem':
    case 'taskItem':
      return children();
    case 'codeBlock':
      return `\n\`\`\`\n${children()}\n\`\`\`\n`;
    default:
      return children();
  }
}

function toLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, '').trim())
    .filter((l) => l.length > 0 && !/^#+\s*$/.test(l));
}

/**
 * Pulls the "Acceptance Criteria" section out of a description.
 * The section starts at a line containing "acceptance criteria" (heading or bold label)
 * and ends at the next heading. Returns the criteria lines and the rest of the description.
 */
export function extractAcceptanceCriteria(text: string): { criteria: string[]; remainder: string } {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /acceptance\s+criteria|\bAC\s*:/i.test(l));
  if (start === -1) return { criteria: [], remainder: text };

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }

  // Allow criteria written inline on the label line, e.g. "AC: returns 200"
  const inline = lines[start].replace(/^.*?(acceptance\s+criteria|\bAC)\s*:?\s*/i, '').trim();
  const sectionLines = [...(inline ? [inline] : []), ...lines.slice(start + 1, end)];

  const criteria = toLines(sectionLines.join('\n'));
  const remainder = [...lines.slice(0, start), ...lines.slice(end)].join('\n').trim();
  return { criteria, remainder };
}
