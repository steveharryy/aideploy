import { exec, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FileChange } from '../../models/types.js';
import { IGNORED_DIRS, IGNORED_FILES } from '../../providers/claude-code-provider.js';
import { isTestFile } from '../team-agent/repo-agents/test-integrity.js';
import { normaliseAcId } from './work-item.js';

/**
 * Deterministic gates used by the coding agent. Nothing here calls an AI:
 * these checks decide pass/fail, the AI only proposes changes.
 */

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ── File tree snapshots and diffs ───────────────────────────────────────────

export type Tree = Map<string, string>;

/** Text content of every file in the repo (no node_modules/.git/dist/lockfiles/binaries). */
export async function readTree(root: string, rel = ''): Promise<Tree> {
  const tree: Tree = new Map();
  for (const entry of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || IGNORED_DIRS.has(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of await readTree(root, relPath)) tree.set(k, v);
    } else if (entry.isFile() && !IGNORED_FILES.has(entry.name) && !entry.name.endsWith('.log')) {
      const buf = await fs.readFile(path.join(root, relPath));
      if (!buf.includes(0)) tree.set(relPath, buf.toString('utf-8')); // skip binaries
    }
  }
  return tree;
}

export interface TreeChange {
  path: string;
  action: 'create' | 'modify' | 'delete';
  before?: string;
  after?: string;
}

export function diffTrees(before: Tree, after: Tree): TreeChange[] {
  const changes: TreeChange[] = [];
  for (const [p, content] of after) {
    if (!before.has(p)) changes.push({ path: p, action: 'create', after: content });
    else if (before.get(p) !== content) changes.push({ path: p, action: 'modify', before: before.get(p), after: content });
  }
  for (const [p, content] of before) if (!after.has(p)) changes.push({ path: p, action: 'delete', before: content });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function toFileChanges(changes: TreeChange[]): FileChange[] {
  return changes.map((c) => (c.action === 'delete' ? { path: c.path, action: 'delete' } : { path: c.path, action: c.action, content: c.after ?? '' }));
}

/** Writes a file back to its earlier content (or removes it if it did not exist). */
export async function restoreFile(root: string, relPath: string, content: string | undefined): Promise<void> {
  const target = path.join(root, relPath);
  if (content === undefined) await fs.rm(target, { force: true });
  else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/** Unified diff of all changes (for the reviewer agent). */
export async function unifiedDiff(changes: TreeChange[], maxChars = 60000): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-agent-diff-'));
  const parts: string[] = [];
  try {
    for (const [i, c] of changes.entries()) {
      const a = path.join(tmp, `${i}.a`);
      const b = path.join(tmp, `${i}.b`);
      await fs.writeFile(a, c.before ?? '');
      await fs.writeFile(b, c.after ?? '');
      try {
        await execFileAsync('diff', ['-u', '--label', c.before === undefined ? '/dev/null' : `a/${c.path}`, '--label', c.after === undefined ? '/dev/null' : `b/${c.path}`, a, b]);
      } catch (err) {
        // diff exits 1 when files differ; that is the normal case here.
        const out = (err as { stdout?: string }).stdout;
        if (out) parts.push(out);
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
  const text = parts.join('\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (diff truncated at ${maxChars} characters)` : text;
}

/** Lines added by a change (exact line multiset difference). */
export function addedLines(change: TreeChange): string[] {
  const before = new Map<string, number>();
  for (const l of (change.before ?? '').split('\n')) before.set(l, (before.get(l) || 0) + 1);
  const added: string[] = [];
  for (const l of (change.after ?? '').split('\n')) {
    const n = before.get(l) || 0;
    if (n > 0) before.set(l, n - 1);
    else added.push(l);
  }
  return added;
}

// ── Scope / safety scans ────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ label: string; re: RegExp; testsToo: boolean }> = [
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/, testsToo: true },
  { label: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, testsToo: true },
  { label: 'Atlassian API token', re: /\bATATT[0-9A-Za-z_\-=]{20,}/, testsToo: true },
  { label: 'Anthropic API key', re: /\bsk-ant-[a-z0-9]+-[A-Za-z0-9_\-]{20,}/, testsToo: true },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, testsToo: true },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, testsToo: true },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, testsToo: false },
  {
    label: 'hard-coded credential',
    re: /(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    testsToo: false
  }
];

export function scanSecrets(changes: TreeChange[]): string[] {
  const found: string[] = [];
  for (const c of changes.filter((x) => x.action !== 'delete')) {
    const test = isTestFile(c.path);
    for (const line of addedLines(c)) {
      for (const p of SECRET_PATTERNS) {
        if ((p.testsToo || !test) && p.re.test(line)) found.push(`${c.path}: possible ${p.label}`);
      }
    }
  }
  return [...new Set(found)];
}

const DEBUG_PATTERNS: Array<{ label: string; re: RegExp; ext: RegExp }> = [
  { label: 'console.log/debug', re: /\bconsole\.(?:log|debug)\s*\(/, ext: /\.[cm]?[jt]sx?$/ },
  { label: 'debugger statement', re: /^\s*debugger\s*;?\s*$/, ext: /\.[cm]?[jt]sx?$/ },
  { label: 'print()', re: /^\s*print\s*\(/, ext: /\.py$/ },
  { label: 'breakpoint()', re: /\b(?:breakpoint|pdb\.set_trace)\s*\(/, ext: /\.py$/ }
];

/** Debug output added to non-test source files. */
export function scanDebugLeftovers(changes: TreeChange[]): string[] {
  const found: string[] = [];
  for (const c of changes.filter((x) => x.action !== 'delete' && !isTestFile(x.path))) {
    for (const line of addedLines(c)) {
      for (const d of DEBUG_PATTERNS) if (d.ext.test(c.path) && d.re.test(line)) found.push(`${c.path}: ${d.label} added`);
    }
  }
  return [...new Set(found)];
}

/** Supporting files that may change with tests (test runner setup), not counted as scope creep. */
export function isAuxiliaryFile(p: string): boolean {
  return /(^|\/)(package\.json|tsconfig[^/]*\.json|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|pytest\.ini|setup\.cfg|pyproject\.toml)$/.test(p);
}

/** Changed source files that the plan did not list (each needs a reason). */
export function outOfPlanFiles(changes: TreeChange[], planned?: Array<{ path: string }>): string[] {
  if (!planned || planned.length === 0) return [];
  const allowed = new Set(planned.map((f) => f.path.replace(/^\.\//, '')));
  return changes.map((c) => c.path).filter((p) => !allowed.has(p) && !isTestFile(p) && !isAuxiliaryFile(p));
}

// ── Acceptance-criteria test coverage ───────────────────────────────────────

/** Test names declared in a test file (JS/TS it/test/describe, Python def test_, Go func Test). */
export function testNames(content: string): string[] {
  const names: string[] = [];
  for (const m of content.matchAll(/\b(?:it|test|describe)(?:\.each\([^)]*\))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) names.push(m[2]);
  for (const m of content.matchAll(/\bdef\s+(test_\w+)/g)) names.push(m[1]);
  for (const m of content.matchAll(/\bfunc\s+(Test\w+)/g)) names.push(m[1]);
  return names;
}

/** AC ids a test name refers to: "test_AC1_x", "AC1: x", "[AC-2] x". */
export function acIdsIn(name: string): string[] {
  return [...name.matchAll(/(?<![A-Za-z0-9])AC[-_ ]?(\d+)(?![0-9])/gi)].map((m) => normaliseAcId(`AC${m[1]}`));
}

/** For each AC id, the test names (in the given test files) that cover it. */
export function acCoverage(testFiles: Array<{ path: string; content: string }>, acIds: string[]): Record<string, string[]> {
  const coverage: Record<string, string[]> = Object.fromEntries(acIds.map((id) => [normaliseAcId(id), []]));
  for (const f of testFiles) {
    for (const name of testNames(f.content)) {
      for (const id of acIdsIn(name)) if (coverage[id]) coverage[id].push(`${f.path} › ${name}`);
    }
  }
  return coverage;
}

// ── Running the repo's commands ─────────────────────────────────────────────

export interface CommandResult {
  code: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export type CommandRunner = (cwd: string, command: string, timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<CommandResult>;

export const runCommand: CommandRunner = async (cwd, command, timeoutMs, env) => {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: timeoutMs, env, maxBuffer: 20 * 1024 * 1024 });
    return { code: 0, output: `${stdout}\n${stderr}`.trim(), durationMs: Date.now() - start, timedOut: false };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean; message?: string };
    return {
      code: typeof e.code === 'number' ? e.code : 1,
      output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim() || (e.message ?? 'command failed'),
      durationMs: Date.now() - start,
      timedOut: Boolean(e.killed)
    };
  }
};

/** Keeps a failure log short: lines that look like errors first, then the tail. */
export function trimLog(output: string, maxLines = 60, maxChars = 6000): string {
  const lines = output.split('\n');
  const important = lines.filter((l) => /error|fail|expected|received|assert|✗|×|TS\d{4}|cannot|undefined|exception/i.test(l));
  const picked = [...new Set([...important.slice(0, maxLines / 2), ...lines.slice(-maxLines / 2)])];
  const text = picked.join('\n');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
