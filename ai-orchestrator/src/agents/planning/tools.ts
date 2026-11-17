import fs from 'node:fs';
import path from 'node:path';
import type { TaskInput } from '../../models/types.js';
import { ComponentMap, type ComponentEntry } from '../../catalog/component-map.js';
import { normalizePlan, PlanParseError, validatePlan } from './plan-rules.js';

/**
 * The Planning Agent's tools (spec: "Planning agent tools"). Plain code with guards; the
 * agent never holds credentials. Engine-independent: today they are served to Claude Code over
 * MCP (mcp-server.ts); a Claude API loop can call the same class later.
 *
 *   jira_read    issue_key                 → fields, comments, links (≤ 20k chars)   allowed projects only
 *   list_repos   components[]              → map entries + all catalog repos           map/catalog only
 *   search_code  repo, query               → ≤ 20 matches: path, line, snippet         catalog repos only
 *   read_file    repo, path, start?, end?  → ≤ 400 lines                               inside the repo, no secrets
 *   submit_plan  plan + gap_analysis       → ends the session (validated; one retry on errors)
 *
 * There is no ask_user tool for the agent: it records every gap in gap_analysis / edge_cases
 * and CODE decides whether to ask, plan or send the ticket back (spec: "decision rule").
 */

export interface SessionRepo {
  id: string;
  name?: string;
  purpose?: string;
  path: string;
}

/** Everything the tool server needs; written to a private file per run. */
export interface PlannerSession {
  ticket: string;
  allowedProjects: string[];
  repos: SessionRepo[];
  components: ComponentEntry[];
  maxToolCalls: number;
  resultFile: string;
}

export interface ToolCallRecord {
  tool: string;
  input: string;
  ok: boolean;
  ms: number;
}

/** What the session produced; read by the orchestrator after the run. */
export interface PlannerOutcome {
  toolCalls: ToolCallRecord[];
  submittedPlan?: unknown;
  /** Validation problems the agent could not fix on its retry. */
  submitProblems?: string[];
  submitAttempts: number;
  budgetExceeded?: boolean;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export const LIMITS = {
  jiraChars: 20000,
  searchMatches: 20,
  readLines: 400,
  /** Longest line returned by read_file (minified files would otherwise flood the model). */
  lineChars: 500,
  snippetChars: 200,
  fileBytes: 512 * 1024,
  filesScanned: 20000,
  /** search_code stops after this long so one call cannot block the tool server. */
  searchMs: 10000,
  /** submit_plan attempts: a submission and its one retry. */
  submitAttempts: 2
};
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor', '.turbo', '.cache', '.worktrees', '.jobs']);
/** Never shown to the agent, even inside an allowed repo. */
const SECRET_FILE =
  /(^|\/)(\.env(\..*)?|\.envrc|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)[^/]*|credentials(\.[a-z]+)?|[^/]*secrets?[^/]*\.(json|ya?ml|env|txt)|service[-_]?account[^/]*\.json)$|\.(pem|key|p12|pfx|jks|keystore|ppk|tfvars|tfstate)$/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

export const TOOL_DEFINITIONS = [
  {
    name: 'jira_read',
    description: 'Read a Jira issue: summary, description, acceptance criteria, status, product, components, comments, linked issues, parent. Use it for linked or parent issues; the ticket itself is already in your instructions.',
    inputSchema: { type: 'object', properties: { issue_key: { type: 'string', description: 'e.g. RT-1234' } }, required: ['issue_key'] }
  },
  {
    name: 'list_repos',
    description:
      "Map the ticket's Jira components AND labels to repositories (with product and risk floor), and list every repository you may read. Some projects (e.g. T2) tag areas with labels such as coin-sportsbook instead of components.",
    inputSchema: {
      type: 'object',
      properties: { components: { type: 'array', items: { type: 'string' } }, labels: { type: 'array', items: { type: 'string' } } },
      required: ['components']
    }
  },
  {
    name: 'search_code',
    description: `Search one repository for a literal text (case-insensitive). Returns up to ${LIMITS.searchMatches} matches: path, line, snippet.`,
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'repository id from list_repos' }, query: { type: 'string', minLength: 2 } },
      required: ['repo', 'query']
    }
  },
  {
    name: 'read_file',
    description: `Read a file from a repository, at most ${LIMITS.readLines} lines per call. Lines are numbered from 1.`,
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string' },
        path: { type: 'string', description: 'path relative to the repository root' },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 }
      },
      required: ['repo', 'path']
    }
  },
  {
    name: 'submit_plan',
    description:
      'Submit your analysis and plan. Call exactly once, at the end, whatever you found: gap_analysis (one entry for each of the 7 checklist items) and edge_cases are always required; the pipeline decides from them whether to plan, ask questions or send the ticket back. Fill the plan fields as far as you can. It is validated: if it comes back with errors, fix them and call again (one retry).',
    inputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          properties: {
            gap_analysis: {
              type: 'array',
              description: 'Exactly one entry per checklist item.',
              items: {
                type: 'object',
                properties: {
                  item: { type: 'string', enum: ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'] },
                  status: { type: 'string', enum: ['found', 'missing', 'ambiguous'] },
                  source: { type: 'string', description: 'found: where (e.g. "description", "comment by Ravi", "src/payout.ts:42"); otherwise what is unclear' },
                  severity: { type: 'string', enum: ['minor', 'blocking'], description: 'not found only: does a wrong guess change what users see, money or data? yes → blocking' },
                  question: { type: 'string', description: 'blocking only' },
                  options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
                  default: { type: 'string', description: 'one of the options' },
                  assumption: { type: 'string', description: 'minor only: the safe default you chose' }
                },
                required: ['item', 'status', 'source']
              }
            },
            edge_cases: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'EC1, EC2 ...' },
                  case: { type: 'string' },
                  source: { type: 'string', enum: ['code', 'tests', 'past_bugs', 'domain', 'generic'] },
                  status: { type: 'string', enum: ['handled', 'not_affected', 'safe_default', 'unclear'] },
                  test: { type: 'string', description: 'handled: the test_plan name that covers it' },
                  note: { type: 'string', description: 'safe_default: the default; not_affected: why' },
                  question: { type: 'string', description: 'unclear: the question to ask' },
                  options: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3 },
                  default: { type: 'string' }
                },
                required: ['id', 'case', 'source', 'status']
              }
            },
            summary: { type: 'string' },
            missing_for_reporter: { type: 'array', items: { type: 'string' } },
            assumptions: { type: 'array', items: { type: 'string' } },
            clarifications: { type: 'array', items: { type: 'string' } },
            contract: { type: 'array', items: { type: 'string' } },
            work_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  repo: { type: 'string' },
                  task: { type: 'string' },
                  reason: { type: 'string' },
                  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
                  depends_on: { type: 'array', items: { type: 'string' } },
                  files_likely_touched: { type: 'array', items: { type: 'string' } },
                  approach: { type: 'array', items: { type: 'string' } },
                  baseline_fix: {
                    type: 'object',
                    description: "Only if the repo's EXISTING tests already fail on the base branch: the minimal repair (test files or test-runner config only, never source).",
                    properties: { files: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } },
                    required: ['files', 'reason']
                  }
                },
                required: ['id', 'repo', 'task', 'reason', 'confidence']
              }
            },
            acceptance_criteria: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  text: { type: 'string' },
                  verify: { type: 'string', enum: ['unit_test', 'qa_api_check', 'human'] },
                  work_item: { type: 'string' },
                  source: { type: 'string', enum: ['ticket', 'derived'] }
                },
                required: ['id', 'text', 'verify', 'work_item']
              }
            },
            test_plan: {
              type: 'array',
              items: {
                type: 'object',
                properties: { ac: { type: 'string' }, work_item: { type: 'string' }, name: { type: 'string' }, cases: { type: 'array', items: { type: 'string' } } },
                required: ['ac', 'name', 'cases']
              }
            },
            risk: { type: 'string', enum: ['low', 'medium', 'high'] },
            risk_reason: { type: 'string' },
            out_of_scope: { type: 'array', items: { type: 'string' } }
          },
          required: ['gap_analysis', 'edge_cases']
        }
      },
      required: ['plan']
    }
  }
] as const;

export type ToolName = (typeof TOOL_DEFINITIONS)[number]['name'];

export class PlannerTools {
  readonly outcome: PlannerOutcome = { toolCalls: [], submitAttempts: 0 };
  /** Exploration calls that actually ran (refused calls and submit_plan do not count). */
  private explored = 0;
  private map: ComponentMap;

  constructor(
    private session: PlannerSession,
    private jiraGetTask?: (key: string) => Promise<TaskInput>
  ) {
    this.map = new ComponentMap(session.components);
  }

  get finished(): boolean {
    return this.outcome.submittedPlan !== undefined;
  }

  async call(name: string, input: Record<string, unknown>): Promise<ToolResult> {
    const started = Date.now();
    const record = (ok: boolean) =>
      this.outcome.toolCalls.push({ tool: name, input: JSON.stringify(input ?? {}).slice(0, 300), ok, ms: Date.now() - started });

    if (this.finished) {
      record(false);
      return { text: 'The session is finished (submit_plan was accepted). Stop now and end your turn.', isError: true };
    }
    // The budget counts only exploration calls that actually ran. submit_plan has its own allowance
    // (a submission and its one retry), so the analysis done so far is never lost to the budget.
    const isSubmit = name === 'submit_plan';
    if (isSubmit ? this.outcome.submitAttempts >= LIMITS.submitAttempts : this.explored >= this.session.maxToolCalls) {
      if (!isSubmit) this.outcome.budgetExceeded = true;
      record(false);
      return {
        text: isSubmit
          ? 'submit_plan was already tried twice; the pipeline uses your last submission. Stop now.'
          : `Tool-call budget (${this.session.maxToolCalls}) used up. Call submit_plan now with what you have.`,
        isError: true
      };
    }
    if (!isSubmit) this.explored++;
    try {
      const result = await this.dispatch(name, input ?? {});
      record(!result.isError);
      const left = this.session.maxToolCalls - this.explored;
      if (name !== 'submit_plan' && left <= 5 && !this.finished) {
        return {
          ...result,
          text: `${result.text}\n\n⚠ Only ${Math.max(left, 0)} tool call(s) left. Stop exploring and call submit_plan now with what you have; mark anything you could not confirm as ambiguous in gap_analysis.`
        };
      }
      return result;
    } catch (err) {
      record(false);
      return { text: `Error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
  }

  private dispatch(name: string, input: Record<string, unknown>): Promise<ToolResult> | ToolResult {
    switch (name) {
      case 'jira_read':
        return this.jiraRead(String(input.issue_key ?? ''));
      case 'list_repos':
        return this.listRepos(
          Array.isArray(input.components) ? input.components.map(String) : [],
          Array.isArray(input.labels) ? input.labels.map(String) : []
        );
      case 'search_code':
        return this.searchCode(String(input.repo ?? ''), String(input.query ?? ''));
      case 'read_file':
        return this.readFile(String(input.repo ?? ''), String(input.path ?? ''), num(input.start_line), num(input.end_line));
      case 'submit_plan':
        return this.submitPlan(input.plan);
      default:
        return { text: `Unknown tool "${name}".`, isError: true };
    }
  }

  private async jiraRead(key: string): Promise<ToolResult> {
    const upper = key.trim().toUpperCase();
    if (!ISSUE_KEY.test(upper)) return { text: `"${key}" is not an issue key.`, isError: true };
    const project = upper.split('-')[0];
    if (!this.session.allowedProjects.includes(project)) {
      return { text: `Project ${project} is not readable here (allowed: ${this.session.allowedProjects.join(', ')}).`, isError: true };
    }
    if (!this.jiraGetTask) return { text: 'Jira is not configured for this session.', isError: true };
    const t = await this.jiraGetTask(upper);
    const m = t.metadata || {};
    const view = {
      key: t.id,
      title: t.title,
      type: m.issueType,
      status: m.status,
      product: m.product,
      components: m.components,
      labels: m.labels,
      parent: m.parent,
      description: t.description,
      acceptanceCriteria: t.acceptanceCriteria,
      links: m.links,
      comments: (Array.isArray(m.comments) ? m.comments : []).slice(-20)
    };
    return { text: trim(JSON.stringify(view, null, 2), LIMITS.jiraChars) };
  }

  private listRepos(components: string[], labels: string[] = []): ToolResult {
    const resolution = this.map.resolveTicket(components, labels);
    const mapped = resolution.matched.map((c) => {
      const e = this.map.get(c)!;
      return { component: e.name, product: e.product, repos: e.repos, risk_floor: e.riskFloor };
    });
    const all = this.session.repos.map((r) => ({ id: r.id, name: r.name, purpose: r.purpose, readable: fs.existsSync(r.path) }));
    return { text: JSON.stringify({ mapped, unmapped_components: resolution.unmapped, all_repos: all }, null, 2) };
  }

  private repo(id: string): SessionRepo {
    const r = this.session.repos.find((x) => x.id === id);
    if (!r) throw new Error(`Unknown repo "${id}". Use an id from list_repos.`);
    if (!fs.existsSync(r.path)) throw new Error(`Repo "${id}" is not cloned on this machine, so it cannot be read.`);
    return r;
  }

  private searchCode(repoId: string, query: string): ToolResult {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return { text: 'Query must be at least 2 characters.', isError: true };
    const root = this.repo(repoId).path;
    const matches: string[] = [];
    let scanned = 0;
    const deadline = Date.now() + LIMITS.searchMs;
    let timedOut = false;
    const walk = (dir: string): boolean => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= LIMITS.searchMatches || scanned >= LIMITS.filesScanned) return false;
        if (Date.now() > deadline) {
          timedOut = true;
          return false;
        }
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).split(path.sep).join('/');
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && walk(full) === false) return false;
          continue;
        }
        if (!entry.isFile() || SECRET_FILE.test(rel)) continue;
        scanned++;
        const stat = fs.statSync(full);
        if (stat.size > LIMITS.fileBytes) continue;
        const buf = fs.readFileSync(full);
        if (buf.includes(0)) continue;
        const lines = buf.toString('utf-8').split('\n');
        for (let i = 0; i < lines.length && matches.length < LIMITS.searchMatches; i++) {
          if (lines[i].toLowerCase().includes(q)) matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, LIMITS.snippetChars)}`);
        }
      }
      return true;
    };
    walk(root);
    const stopped = timedOut ? `\n(search stopped after ${LIMITS.searchMs / 1000}s; narrow the query)` : '';
    if (matches.length === 0) return { text: `No matches for "${query}" in ${repoId}.${stopped}` };
    const more = matches.length >= LIMITS.searchMatches ? `\n(first ${LIMITS.searchMatches} matches; narrow the query for more)` : '';
    return { text: matches.join('\n') + more + stopped };
  }

  private readFile(repoId: string, relPath: string, start?: number, end?: number): ToolResult {
    const repo = this.repo(repoId);
    const rootReal = fs.realpathSync(repo.path);
    const target = path.resolve(rootReal, relPath);
    // Refuse before touching the disk, so the tool cannot be used to probe paths outside the repo.
    if (target !== rootReal && !target.startsWith(rootReal + path.sep)) return { text: 'Path is outside the repository.', isError: true };
    if (!fs.existsSync(target)) return { text: `No such file: ${relPath}`, isError: true };
    const real = fs.realpathSync(target); // follows symlinks: must still be inside the repo
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { text: 'Path is outside the repository.', isError: true };
    const rel = path.relative(rootReal, real).split(path.sep).join('/');
    if (SECRET_FILE.test(rel)) return { text: `Refused: ${rel} may contain secrets.`, isError: true };
    if (rel.split('/').some((part) => SKIP_DIRS.has(part))) return { text: `Refused: ${rel} is in an ignored folder (dependencies/build output).`, isError: true };
    if (fs.statSync(real).isDirectory()) {
      const names = fs.readdirSync(real, { withFileTypes: true }).filter((e) => !SKIP_DIRS.has(e.name)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { text: `${rel || '.'} is a folder:\n${names.sort().join('\n')}` };
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) return { text: `${rel} is not a regular file.`, isError: true }; // FIFOs, sockets, devices
    if (stat.size > LIMITS.fileBytes) {
      return { text: `${rel} is ${Math.round(stat.size / 1024)} KB, over the ${LIMITS.fileBytes / 1024} KB limit (generated or minified?). Use search_code to find the part you need.`, isError: true };
    }
    const buf = fs.readFileSync(real);
    if (buf.includes(0)) return { text: `${rel} is a binary file.`, isError: true };
    const lines = buf.toString('utf-8').split('\n');
    const from = Math.max(1, start ?? 1);
    const to = Math.min(lines.length, end ?? from + LIMITS.readLines - 1, from + LIMITS.readLines - 1);
    if (from > lines.length) return { text: `${rel} has only ${lines.length} lines.`, isError: true };
    const clip = (l: string) => (l.length > LIMITS.lineChars ? `${l.slice(0, LIMITS.lineChars)} …(line cut at ${LIMITS.lineChars} chars)` : l);
    const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${clip(l)}`).join('\n');
    const tail = to < lines.length ? `\n(lines ${from}-${to} of ${lines.length}; call again with start_line=${to + 1} for more)` : '';
    return { text: `${rel} (lines ${from}-${to} of ${lines.length})\n${body}${tail}` };
  }

  private submitPlan(raw: unknown): ToolResult {
    this.outcome.submitAttempts++;
    let problems: string[];
    try {
      const plan = normalizePlan(raw, this.session.ticket);
      problems = validatePlan(plan, this.session.repos.map((r) => r.id), { requireGapAnalysis: true });
    } catch (err) {
      problems = [err instanceof PlanParseError || err instanceof Error ? err.message : String(err)];
    }
    if (problems.length && this.outcome.submitAttempts < 2) {
      return { text: `Plan not accepted. Fix these and call submit_plan again (last try):\n- ${problems.join('\n- ')}`, isError: true };
    }
    this.outcome.submittedPlan = raw;
    if (problems.length) this.outcome.submitProblems = problems;
    return { text: 'Plan submitted. The session ends here. Stop now and end your turn.' };
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function trim(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(trimmed at ${max} characters)` : text;
}
