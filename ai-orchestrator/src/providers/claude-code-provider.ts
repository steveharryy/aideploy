import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AIProvider,
  AIProviderGenerateOptions,
  AIProviderResponse,
  FileChange,
  TaskInput
} from '../models/types.js';

/** Runs the Claude Code CLI. Injectable so tests never spawn a real process. */
export type ClaudeCodeRunner = (input: {
  bin: string;
  args: string[];
  cwd: string;
  prompt: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) => Promise<string>;

/** Structured change plan produced (read-only) before approval. */
export interface ImplementationPlan {
  summary?: string;
  currentBehaviour?: string;
  approach?: string[];
  filesToChange?: Array<{ path: string; change: string }>;
  testsToAdd?: Array<{ name: string; covers?: string }>;
  acCoverage?: Array<{ ac: string; how: string }>;
  behaviourChanges?: string;
  risks?: string[];
  outOfScope?: string[];
  openQuestions?: string[];
  effort?: string;
  /** Set when the agent's answer could not be parsed as JSON: the plan as plain text. */
  raw?: string;
}

export interface PlanProposal {
  plan: ImplementationPlan;
  stats: string;
}

export interface ClaudeCodeProviderConfig {
  /** Path to the `claude` binary (default: CLAUDE_CODE_BIN, then the project-local install, then `claude` on PATH). */
  bin?: string;
  /** Optional model override (default: CLAUDE_CODE_MODEL, else the CLI's default). */
  model?: string;
  /** Hard time limit for one repo (default: CLAUDE_CODE_TIMEOUT_MS or 30 minutes). */
  timeoutMs?: number;
  /** Verify commands the agent must run before finishing (from the service catalog). */
  verifyCommandsFor?: (repoId: string) => string[];
  /** One-line repo description (from the service catalog). */
  repoPurposeFor?: (repoId: string) => string | undefined;
  /** Keep the sandbox copy after the run (default: KEEP_SANDBOX=1). */
  keepSandbox?: boolean;
  runner?: ClaudeCodeRunner;
}

/** Tools the agent may use. Bash is limited to build/test commands; no web, no MCP connectors. */
const ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(npm test:*)',
  'Bash(npm run:*)',
  'Bash(npm install:*)',
  'Bash(npx tsc:*)',
  'Bash(npx vitest:*)',
  'Bash(node:*)',
  'Bash(ls:*)'
];
const DISALLOWED_TOOLS = ['WebFetch', 'WebSearch'];

/** Never copied into / collected from the sandbox. */
const IGNORED_DIRS = new Set(['.git', 'dist', 'coverage', '.worktrees', '.handoff', '.jobs']);
const IGNORED_FILES = new Set(['package-lock.json', '.DS_Store']);

/** Environment passed to the agent: enough to run node/npm, nothing secret. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];

/**
 * ClaudeCodeProvider
 *
 * Uses Claude Code (headless `claude -p`) as the coding agent for one repository:
 *  1. copies the repository into a throwaway sandbox,
 *  2. lets Claude Code implement the ticket there (tests first, verify commands must pass),
 *  3. returns only the files it changed as FileChange[].
 * The orchestrator then applies those changes to the real repo through the Repo Agent's
 * path-safety and test-integrity guards and re-runs the repo's verify contract itself.
 * Authenticates with the developer's Claude Code login (no API key is passed through).
 */
export class ClaudeCodeProvider implements AIProvider {
  public readonly name = 'claude-code';
  private bin: string;
  private model?: string;
  private timeoutMs: number;
  private verifyCommandsFor: (repoId: string) => string[];
  private repoPurposeFor: (repoId: string) => string | undefined;
  private keepSandbox: boolean;
  private runner: ClaudeCodeRunner;

  constructor(config: ClaudeCodeProviderConfig = {}) {
    this.bin = config.bin || process.env.CLAUDE_CODE_BIN || ClaudeCodeProvider.defaultBin();
    this.model = config.model || process.env.CLAUDE_CODE_MODEL || undefined;
    this.timeoutMs = config.timeoutMs || Number(process.env.CLAUDE_CODE_TIMEOUT_MS) || 30 * 60 * 1000;
    this.verifyCommandsFor = config.verifyCommandsFor || (() => []);
    this.repoPurposeFor = config.repoPurposeFor || (() => undefined);
    this.keepSandbox = config.keepSandbox ?? process.env.KEEP_SANDBOX === '1';
    this.runner = config.runner || runClaudeCli;
  }

  /** Project-local install (node_modules/.bin/claude) if present, else `claude` from PATH. */
  static defaultBin(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const local = path.resolve(here, '../../node_modules/.bin/claude');
    return fsSync.existsSync(local) ? local : 'claude';
  }

  /** Builds the instructions for the agent. Exported for tests and for `--plan` previews. */
  buildPrompt(task: TaskInput, repoId: string): string {
    const verify = this.verifyCommandsFor(repoId);
    const purpose = this.repoPurposeFor(repoId);
    const criteria = task.acceptanceCriteria.length
      ? task.acceptanceCriteria.map((c, i) => `  AC-${i + 1}. ${c}`).join('\n')
      : '  (none provided: derive them from the description and state them in your summary)';
    const comments = ((task.metadata?.comments as Array<{ author: string; created: string; body: string }>) || [])
      .slice(-10)
      .map((c) => `  [${c.created.slice(0, 10)}] ${c.author}: ${c.body}`)
      .join('\n');

    const approved = (task.metadata?.approvedPlans as Record<string, ImplementationPlan> | undefined)?.[repoId];
    const approvedBlock = approved
      ? `\n<approved_plan>\nA reviewer approved this implementation plan. Follow it. If you must deviate, say exactly where and why in your summary.\n${JSON.stringify(approved, null, 2)}\n</approved_plan>\n`
      : '';

    return `You are the Repo Agent for repository "${repoId}" in an automated development pipeline.
Implement Jira ticket ${task.id} in this repository (your current working directory).
${purpose ? `Repository purpose: ${purpose}\n` : ''}
<ticket>
ID: ${task.id}
Title: ${task.title}
Description:
${task.description}

Acceptance criteria:
${criteria}
${comments ? `\nRecent comments:\n${comments}\n` : ''}</ticket>
${approvedBlock}
Rules:
1. Work only inside the current directory. Never call real services or the network; tests must mock external HTTP and Redis.
2. Tests first: add unit tests that encode every acceptance criterion, run them, and confirm they FAIL on the current code. Then change the implementation until they pass.
3. Never delete, skip (.skip/.only/xit/xdescribe), comment out or weaken existing tests.
4. Change only what the ticket needs. Keep existing behaviour, exports and response shapes unless the ticket explicitly changes them.
5. Use the repository's existing test setup. Only if it has no test runner at all, add vitest as a devDependency with "test": "vitest run" and keep the TypeScript build limited to src. Add or change dependencies only when the verify commands below include an install step (otherwise the pipeline cannot install them).
6. Before finishing, run these verify commands and make sure every one passes:
${verify.length ? verify.map((v) => `   - ${v}`).join('\n') : '   - the repository\'s typecheck and test scripts from package.json'}
7. Do not commit, push, or create branches.

Finish with a short summary: the files you changed, which test covers each acceptance criterion, confirmation that the new tests failed before your change, and the verify results.`;
  }

  /** Prompt for the read-only planning step. */
  buildPlanPrompt(task: TaskInput, repoId: string): string {
    const verify = this.verifyCommandsFor(repoId);
    const purpose = this.repoPurposeFor(repoId);
    const criteria = task.acceptanceCriteria.length
      ? task.acceptanceCriteria.map((c, i) => `  AC-${i + 1}. ${c}`).join('\n')
      : '  (none provided: derive them from the description)';
    const comments = ((task.metadata?.comments as Array<{ author: string; created: string; body: string }>) || [])
      .slice(-10)
      .map((c) => `  [${c.created.slice(0, 10)}] ${c.author}: ${c.body}`)
      .join('\n');

    return `You are planning (NOT implementing) Jira ticket ${task.id} for repository "${repoId}" (your current working directory).
${purpose ? `Repository purpose: ${purpose}\n` : ''}This is a READ-ONLY step: read the code (ignore node_modules and dist), do not modify anything.
A reviewer will approve or reject your plan before any code is written, so be concrete and honest.

<ticket>
ID: ${task.id}
Title: ${task.title}
Description:
${task.description}

Acceptance criteria:
${criteria}
${comments ? `\nRecent comments:\n${comments}\n` : ''}</ticket>

How the work will be done after approval: tests are written first and must fail on the current code, then the implementation, then these verify commands must pass:
${verify.length ? verify.map((v) => `  - ${v}`).join('\n') : '  - the repository typecheck and test scripts'}
Never weaken existing tests; keep existing behaviour and response shapes unless the ticket changes them.

Answer with ONLY one JSON object, no prose, in exactly this shape:
{
  "summary": "one or two sentences: what will be done",
  "currentBehaviour": "what the code does today and why that is a problem (cite file:line)",
  "approach": ["ordered implementation steps"],
  "filesToChange": [{"path": "repo-relative path", "change": "what changes in this file"}],
  "testsToAdd": [{"name": "test description", "covers": "AC-n"}],
  "acCoverage": [{"ac": "AC-n", "how": "how the change + test satisfy it"}],
  "behaviourChanges": "client-visible changes (API shape, status codes, ordering), or 'none'",
  "risks": ["risk and its mitigation"],
  "outOfScope": ["related issues deliberately NOT changed"],
  "openQuestions": ["decisions a human must make, or empty"],
  "effort": "S | M | L with a short reason"
}`;
  }

  /**
   * Read-only planning step: Claude Code reads the real repo (no edit/write/shell tools)
   * and returns a structured change plan for human approval.
   */
  async proposePlan(task: TaskInput, repoId: string, repoPath: string): Promise<PlanProposal> {
    const args = [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--permission-mode', 'default',
      '--strict-mcp-config',
      ...(this.model ? ['--model', this.model] : []),
      '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch',
      '--allowedTools', 'Read', 'Glob', 'Grep'
    ];
    const raw = await this.runner({
      bin: this.bin,
      args,
      cwd: repoPath,
      prompt: this.buildPlanPrompt(task, repoId),
      env: safeEnv(),
      timeoutMs: Math.min(this.timeoutMs, 10 * 60 * 1000)
    });
    const result = parseResult(raw);
    if (result.is_error || (result.subtype && result.subtype !== 'success')) {
      throw new Error(`ClaudeCodeProvider: planning failed (${result.subtype || 'error'}): ${String(result.result || '').slice(0, 300)}`);
    }
    const stats = [
      typeof result.num_turns === 'number' ? `turns: ${result.num_turns}` : '',
      typeof result.duration_ms === 'number' ? `time: ${Math.round(result.duration_ms / 1000)}s` : ''
    ].filter(Boolean).join(', ');
    return { plan: parsePlan(String(result.result || '')), stats };
  }

  async generateChanges(options: AIProviderGenerateOptions): Promise<AIProviderResponse> {
    const { task, repoContext } = options;
    const sandbox = await fs.mkdtemp(
      path.join(os.tmpdir(), `orchestrator-sandbox-${task.id.replace(/[^A-Za-z0-9._-]/g, '_')}-${repoContext.repoId}-`)
    );

    let keep = this.keepSandbox;
    try {
      // 1. Throwaway copy of the repo (including node_modules so the agent can run tests).
      await fs.cp(repoContext.repoPath, sandbox, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (src) => !IGNORED_DIRS.has(path.basename(src))
      });
      const before = await snapshot(sandbox);

      // 2. Let Claude Code work in the sandbox.
      const args = [
        '-p',
        '--output-format', 'json',
        '--no-session-persistence',
        '--permission-mode', 'acceptEdits',
        '--strict-mcp-config',
        ...(this.model ? ['--model', this.model] : []),
        '--disallowedTools', ...DISALLOWED_TOOLS,
        '--allowedTools', ...ALLOWED_TOOLS
      ];
      const raw = await this.runner({
        bin: this.bin,
        args,
        cwd: sandbox,
        prompt: this.buildPrompt(task, repoContext.repoId),
        env: safeEnv(),
        timeoutMs: this.timeoutMs
      });

      const result = parseResult(raw);
      if (result.is_error || (result.subtype && result.subtype !== 'success')) {
        keep = true;
        throw new Error(
          `ClaudeCodeProvider: agent run failed (${result.subtype || 'error'}): ${String(result.result || '').slice(0, 500)} [sandbox kept at ${sandbox}]`
        );
      }

      // 3. Collect exactly what changed.
      const fileChanges = await collectChanges(sandbox, before);
      const stats = [
        typeof result.num_turns === 'number' ? `turns: ${result.num_turns}` : '',
        typeof result.total_cost_usd === 'number' ? `cost: $${result.total_cost_usd.toFixed(2)}` : '',
        typeof result.duration_ms === 'number' ? `time: ${Math.round(result.duration_ms / 1000)}s` : ''
      ].filter(Boolean).join(', ');

      return {
        providerName: this.name,
        reasoning: `${String(result.result || 'Changes made by Claude Code.').trim()}${stats ? `\n[${stats}]` : ''}${keep ? `\n[sandbox: ${sandbox}]` : ''}`,
        fileChanges,
        rawResponse: raw
      };
    } catch (err) {
      keep = true;
      throw err instanceof Error && err.message.includes('sandbox kept')
        ? err
        : new Error(`${err instanceof Error ? err.message : String(err)} [sandbox kept at ${sandbox}]`);
    } finally {
      if (!keep) await fs.rm(sandbox, { recursive: true, force: true });
    }
  }
}

interface ClaudeResult {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  num_turns?: number;
  total_cost_usd?: number;
  duration_ms?: number;
}

function parseResult(raw: string): ClaudeResult {
  const text = raw.trim();
  try {
    return JSON.parse(text) as ClaudeResult;
  } catch {
    // Some versions print extra lines; the result object is the last JSON line.
    const last = text.split('\n').reverse().find((l) => l.trim().startsWith('{'));
    if (last) return JSON.parse(last) as ClaudeResult;
    throw new Error(`ClaudeCodeProvider: could not parse CLI output: ${text.slice(0, 300)}`);
  }
}

/** Extracts the JSON plan from the agent's answer (plain or fenced); falls back to raw text. */
export function parsePlan(text: string): ImplementationPlan {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [fenced?.[1], text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c || !c.trim().startsWith('{')) continue;
    try {
      const obj = JSON.parse(c.trim());
      if (obj && typeof obj === 'object') return obj as ImplementationPlan;
    } catch {
      /* try next */
    }
  }
  return { raw: text.trim() };
}

function safeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // Opt-in only: use an Anthropic API key instead of the developer's Claude Code login.
  if (process.env.CLAUDE_CODE_USE_API_KEY === 'true' && process.env.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  }
  return env;
}

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || IGNORED_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, relPath)));
    else if (entry.isFile() && !IGNORED_FILES.has(entry.name) && !entry.name.endsWith('.log')) out.push(relPath);
  }
  return out;
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const rel of await walk(root)) {
    hashes.set(rel, crypto.createHash('sha1').update(await fs.readFile(path.join(root, rel))).digest('hex'));
  }
  return hashes;
}

/** Compares the sandbox with its starting snapshot and returns full-content file changes. */
export async function collectChanges(root: string, before: Map<string, string>): Promise<FileChange[]> {
  const after = await snapshot(root);
  const changes: FileChange[] = [];

  for (const [rel, hash] of after) {
    if (before.get(rel) === hash) continue;
    const buf = await fs.readFile(path.join(root, rel));
    if (buf.includes(0)) throw new Error(`ClaudeCodeProvider: binary file change is not supported (${rel}).`);
    changes.push({ path: rel, action: before.has(rel) ? 'modify' : 'create', content: buf.toString('utf-8') });
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changes.push({ path: rel, action: 'delete' });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/** Default runner: spawns the CLI, feeds the prompt on stdin, returns stdout. */
const runClaudeCli: ClaudeCodeRunner = ({ bin, args, cwd, prompt, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`ClaudeCodeProvider: timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `ClaudeCodeProvider: Claude Code CLI not found at "${bin}". Install it with: npm install -D @anthropic-ai/claude-code`
            : `ClaudeCodeProvider: could not start Claude Code: ${err.message}`
        )
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stdout.trim()) return resolve(stdout); // JSON result (also on agent-level errors)
      reject(new Error(`ClaudeCodeProvider: Claude Code exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
