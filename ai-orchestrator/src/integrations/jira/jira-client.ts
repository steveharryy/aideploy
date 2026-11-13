import type { TaskInput } from '../../models/types.js';

export interface JiraClientConfig {
  /** e.g. https://your-site.atlassian.net */
  baseUrl?: string;
  email?: string;
  apiToken?: string;
  /** Optional custom field holding acceptance criteria, e.g. customfield_10042. */
  acceptanceCriteriaField?: string;
  /** "Product" select field (e.g. customfield_10224) → metadata.product. */
  productField?: string;
  /** Story points field (e.g. customfield_10070) → metadata.storyPoints. */
  storyPointsField?: string;
  /** Inject fetch (used by tests). */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms (default 30 s). */
  timeoutMs?: number;
  /** Attempts per request, including the first (default 4). */
  maxAttempts?: number;
  /** Inject the wait between retries (used by tests). */
  sleep?: (ms: number) => Promise<void>;
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
    parent?: { key: string; fields?: { summary?: string } };
    issuelinks?: Array<{
      type?: { inward?: string; outward?: string };
      inwardIssue?: { key: string; fields?: { summary?: string; status?: { name?: string } } };
      outwardIssue?: { key: string; fields?: { summary?: string; status?: { name?: string } } };
    }>;
    reporter?: { displayName?: string; accountId?: string };
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
  private productField?: string;
  private storyPointsField?: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;
  private maxAttempts: number;
  private sleep: (ms: number) => Promise<void>;

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
    this.productField = config.productField || process.env.JIRA_PRODUCT_FIELD || undefined;
    this.storyPointsField = config.storyPointsField || process.env.JIRA_STORY_POINTS_FIELD || undefined;
    this.fetchImpl = config.fetchImpl || fetch;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 4);
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private get fields(): string[] {
    const base = ['summary', 'description', 'labels', 'components', 'issuetype', 'status', 'priority', 'comment', 'parent', 'issuelinks', 'reporter'];
    return [...base, this.acField, this.productField, this.storyPointsField].filter((f): f is string => !!f);
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

  /** Assigns the issue (e.g. back to its reporter). */
  async assign(issueKey: string, accountId: string): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/assignee`, {
      method: 'PUT',
      body: JSON.stringify({ accountId })
    });
  }

  /** Web links attached to the issue (Confluence pages, docs, designs). */
  async getRemoteLinks(issueKey: string): Promise<Array<{ title: string; url: string }>> {
    const data = await this.request<Array<{ object?: { url?: string; title?: string } }>>(
      `/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`
    );
    return (data || [])
      .map((l) => ({ title: l.object?.title || l.object?.url || '', url: l.object?.url || '' }))
      .filter((l) => l.url);
  }

  /**
   * Plain text of a Confluence Cloud page, only on this same Atlassian site (credentials are
   * never sent to another host). Returns undefined for anything else.
   */
  async getConfluencePageText(url: string): Promise<string | undefined> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    if (u.origin !== new URL(this.baseUrl).origin || !u.pathname.startsWith('/wiki/')) return undefined;
    const id = /\/pages\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('pageId');
    if (!id || !/^\d+$/.test(id)) return undefined;
    const page = await this.request<{ body?: { storage?: { value?: string } } }>(`/wiki/api/v2/pages/${id}?body-format=storage`);
    return htmlToText(page?.body?.storage?.value || '');
  }

  /** Earlier tickets in the same project whose text matches the title's main words. */
  async findSimilarTasks(task: TaskInput, max = 5): Promise<TaskInput[]> {
    const project = task.id.split('-')[0];
    if (!/^[A-Z][A-Z0-9_]+$/i.test(project)) return [];
    const words = [...new Set(task.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !STOP_WORDS.has(w)))].slice(0, 6);
    if (words.length === 0) return [];
    const jql = `project = ${project} AND key != ${task.id} AND text ~ "${words.join(' ')}" ORDER BY updated DESC`;
    return this.searchTasks(jql, max);
  }

  /**
   * Extra context for the Planning Agent: linked documents and similar past tickets.
   * Best effort: a failure here never blocks planning.
   */
  async enrichForPlanning(task: TaskInput): Promise<TaskInput> {
    const meta = { ...(task.metadata || {}) };
    try {
      const links = await this.getRemoteLinks(task.id);
      const documents: Array<{ title: string; url: string; text?: string }> = [];
      for (const l of links.slice(0, 5)) {
        const text = await this.getConfluencePageText(l.url).catch(() => undefined);
        documents.push({ ...l, ...(text ? { text } : {}) });
      }
      if (documents.length) meta.documents = documents;
    } catch {
      /* no remote links or no permission */
    }
    try {
      const similar = await this.findSimilarTasks(task);
      if (similar.length) {
        meta.similarTickets = similar.map((t) => ({
          key: t.id,
          title: t.title,
          status: t.metadata?.status,
          description: t.description.slice(0, 400)
        }));
      }
    } catch {
      /* search failed */
    }
    return { ...task, metadata: meta };
  }

  /** Posts a comment: heading lines as paragraphs, optional preformatted block (e.g. the change plan). */
  /** Posts a ready-made Atlassian Document Format body (rich comment: tables, panels, lozenges). */
  async addCommentDoc(issueKey: string, body: Record<string, unknown>): Promise<void> {
    await this.request(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: 'POST',
      body: JSON.stringify({ body })
    });
  }

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

  /**
   * One Jira REST call with a timeout and retries.
   * - 429 (rate limited): always retried, honouring Retry-After; Jira did not process the request.
   * - 502/503/504, timeouts and network errors: retried only for calls that are safe to repeat
   *   (GET, PUT, and POST searches), never for creating comments or transitions, which could
   *   then happen twice.
   */
  private async request<T>(pathAndQuery: string, init: RequestInit = {}): Promise<T> {
    const method = (init.method || 'GET').toUpperCase();
    const repeatable = method === 'GET' || method === 'PUT' || pathAndQuery.startsWith('/rest/api/3/search');
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${pathAndQuery}`, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            Authorization: this.authHeader,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(init.headers || {})
          }
        });
      } catch (err) {
        // Timeout or network failure: the request may or may not have reached Jira.
        lastError = new Error(`Jira API ${method} ${pathAndQuery.split('?')[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
        if (repeatable && attempt < this.maxAttempts) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      if (res.ok) {
        // Write endpoints (labels, transitions) answer 204 No Content.
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || (repeatable && [502, 503, 504].includes(res.status));
      if (retryable && attempt < this.maxAttempts) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 60000) : this.backoffMs(attempt));
        continue;
      }
      const hint =
        res.status === 401 ? ' (check JIRA_EMAIL / JIRA_API_TOKEN)' :
        res.status === 403 ? ' (the Jira account lacks permission for this action)' :
        res.status === 404 ? ' (issue not found or no permission)' :
        res.status === 429 ? ' (rate limited by Jira)' : '';
      throw new Error(`Jira API ${res.status}${hint}: ${body.slice(0, 500)}`);
    }
    throw lastError instanceof Error ? lastError : new Error('Jira API call failed');
  }

  private backoffMs(attempt: number): number {
    return Math.min(1000 * 2 ** (attempt - 1), 15000) + Math.floor(Math.random() * 250);
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
        })),
        // Context for the Planning Agent.
        parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '' } : undefined,
        links: (f.issuelinks || [])
          .map((l) => {
            const other = l.outwardIssue || l.inwardIssue;
            if (!other) return undefined;
            return {
              key: other.key,
              relation: (l.outwardIssue ? l.type?.outward : l.type?.inward) || 'relates to',
              summary: other.fields?.summary || '',
              status: other.fields?.status?.name
            };
          })
          .filter(Boolean),
        reporter: f.reporter ? { name: f.reporter.displayName || 'unknown', accountId: f.reporter.accountId } : undefined,
        product: this.productField ? selectValue(f[this.productField]) : undefined,
        storyPoints: this.storyPointsField && typeof f[this.storyPointsField] === 'number' ? (f[this.storyPointsField] as number) : undefined
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
  // ADF: "version" is a top-level property of the doc node (not attrs); Jira rejects anything else.
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

const STOP_WORDS = new Set(['with', 'from', 'that', 'this', 'when', 'into', 'should', 'have', 'will', 'there', 'their', 'about', 'after', 'before', 'need', 'needs', 'make', 'add', 'update', 'issue', 'ticket']);

/** Confluence storage HTML → readable plain text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Value of a Jira select field ({ value }), or of a plain string field. */
function selectValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined;
  if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string') return (v as { value: string }).value;
  return undefined;
}
