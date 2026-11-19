import type { VerifyCommand } from '../../catalog/service-catalog.js';
import {
  ClaudeCodeProvider,
  DISALLOWED_TOOLS,
  parseResult,
  runClaudeCli,
  safeEnv,
  type ClaudeCodeRunner
} from '../../providers/claude-code-provider.js';
import { diffTrees, readRepoTree, restoreFile } from '../coding/gates.js';
import { normaliseAcId, type WorkItem } from '../coding/work-item.js';

/**
 * QA agent (AI Agent Jira Workflow, "AI QA" / "QA doubts").
 *
 * A separate, fresh Claude Code session that VERIFIES a finished change against the ticket's
 * acceptance criteria and the approved plan, not against the coding agent's own summary. It may read
 * the code and run the repo's test command; it never edits code (any file it changes is restored and
 * reported). Its answer is a verdict with numbered findings; the CODE below decides what the verdict
 * means (the agent proposes, the rules decide):
 *
 *   defect            code does not meet the plan or an AC        → fail: back to AI Dev (loop_count++)
 *   spec_ambiguity    expected behaviour unclear / ticket vs plan  → needs_input (a person answers)
 *   flaky             infra, timeout, nondeterminism               → needs_input tagged infra (no loop)
 *   pre_existing      also fails on the base branch                → not blocking, logged
 *   out_of_scope      real bug in nearby code the ticket skips     → not blocking, follow-up ticket
 *
 * On re-entry it checks the previous findings by ID first. A defect still open after a fix loop is
 * "the same finding failing twice" → escalate to a person immediately.
 */

export type QaFindingType = 'defect' | 'spec_ambiguity' | 'flaky' | 'pre_existing' | 'out_of_scope';

export interface QaFinding {
  /** F1, F2… numbered by the pipeline across all QA rounds of a ticket. */
  id: string;
  type: QaFindingType;
  repo: string;
  /** The AC id or plan item the finding is about. */
  criterion?: string;
  title: string;
  expected?: string;
  actual?: string;
  /** The failing test, or steps to reproduce. */
  repro?: string;
  file?: string;
  line?: number;
  status: 'open' | 'fixed' | 'waived';
  /** QA round (1-based) the finding was raised in. */
  round: number;
}

export type QaVerdict = 'pass' | 'fail' | 'needs_input' | 'escalate';

export interface QaReport {
  ticket: string;
  repo: string;
  round: number;
  verdict: QaVerdict;
  /** Why the code reached this verdict (one line). */
  reason: string;
  summary: string;
  /** New findings from this round, plus previous ones with their updated status. */
  findings: QaFinding[];
  acResults: Array<{ id: string; met: boolean; evidence: string }>;
  /** Questions for a person (spec ambiguity only). */
  questions: string[];
  /** Routing tag for needs_input / escalate: who should answer. */
  tag?: 'product' | 'technical' | 'infra';
  /** Files the QA agent changed although it must not (restored). */
  restoredFiles: string[];
  claudeCalls: number;
  durationMs: number;
}

export interface QaAgentConfig {
  runner?: ClaudeCodeRunner;
  bin?: string;
  model?: string;
  timeoutMs?: number;
  log?: (m: string) => void;
}

export interface QaInput {
  workItem: WorkItem;
  /** The changed repo (worktree with the change applied, not committed yet). */
  workdir: string;
  /** Unified diff of the change. */
  diff: string;
  /** Pipeline check results as one line (e.g. "build: passed, test: passed"). */
  checks: string;
  /** The repo's verify contract: the QA agent may run its test command. */
  verify: VerifyCommand[];
  /** Tests already failing on the base branch (not blocking). */
  preExistingFailures?: string[];
  /** Findings from earlier QA rounds of this ticket (any repo; this repo's are re-checked by ID). */
  previous?: QaFinding[];
  /** 1-based QA round for this ticket. */
  round: number;
  /** Next free finding number (F<n>). */
  nextId: number;
  repoPurpose?: string;
}

interface QaReply {
  summary: string;
  previous: Array<{ id: string; status: 'fixed' | 'still_open'; note?: string }>;
  findings: Array<Omit<QaFinding, 'id' | 'repo' | 'status' | 'round'>>;
  acResults: Array<{ id: string; met: boolean; evidence: string }>;
  questions: string[];
}

const TYPES: QaFindingType[] = ['defect', 'spec_ambiguity', 'flaky', 'pre_existing', 'out_of_scope'];

export class QaAgent {
  private runner: ClaudeCodeRunner;
  private bin: string;
  private model?: string;
  private timeoutMs: number;
  private log: (m: string) => void;

  constructor(config: QaAgentConfig = {}) {
    this.runner = config.runner || runClaudeCli;
    this.bin = config.bin || process.env.CLAUDE_CODE_BIN || ClaudeCodeProvider.defaultBin();
    this.model = config.model || process.env.QA_AGENT_MODEL || process.env.CLAUDE_CODE_MODEL || undefined;
    this.timeoutMs = config.timeoutMs ?? 20 * 60 * 1000;
    this.log = config.log || (() => {});
  }

  async review(input: QaInput): Promise<QaReport> {
    const started = Date.now();
    const w = input.workItem;
    const report: QaReport = {
      ticket: w.ticket,
      repo: w.repo,
      round: input.round,
      verdict: 'escalate',
      reason: '',
      summary: '',
      findings: [],
      acResults: [],
      questions: [],
      restoredFiles: [],
      claudeCalls: 0,
      durationMs: 0
    };
    const mine = (input.previous ?? []).filter((f) => f.repo === w.repo);

    // The QA agent never edits code: snapshot the worktree, restore anything it changes.
    const before = await readRepoTree(input.workdir, input.workdir);
    let reply: QaReply | undefined;
    try {
      let retryNote = '';
      for (let attempt = 0; attempt < 2 && !reply; attempt++) {
        report.claudeCalls++;
        const raw = await this.runner({
          bin: this.bin,
          args: qaArgs(input.verify, this.model),
          cwd: input.workdir,
          prompt: qaPrompt(input, mine) + retryNote,
          env: safeEnv(),
          timeoutMs: this.timeoutMs
        });
        const result = parseResult(raw);
        if (result.is_error || (result.subtype && result.subtype !== 'success')) {
          throw new Error(`QA agent call failed (${result.subtype || 'error'}): ${String(result.result || '').slice(0, 300)}`);
        }
        reply = parseQaReply(String(result.result || ''));
        retryNote = '\n\nYour previous answer was not valid JSON. Reply with ONLY the JSON object.';
      }
    } finally {
      for (const d of diffTrees(before, await readRepoTree(input.workdir, input.workdir))) {
        await restoreFile(input.workdir, d.path, before.get(d.path));
        report.restoredFiles.push(d.path);
      }
    }
    report.durationMs = Date.now() - started;
    if (!reply) {
      report.reason = 'The QA agent did not return a usable verdict.';
      return report;
    }
    if (report.restoredFiles.length) this.log(`[${w.repo}] QA agent changed ${report.restoredFiles.join(', ')}; restored (QA never edits code)`);
    return decide(report, reply, input, mine);
  }
}

/** The rules: what the QA agent's answer means. Exported for tests. */
export function decide(report: QaReport, reply: QaReply, input: QaInput, mine: QaFinding[]): QaReport {
  const w = input.workItem;
  report.summary = reply.summary;
  report.acResults = reply.acResults.map((a) => ({ ...a, id: normaliseAcId(a.id) }));

  // 1. Previous findings, by ID. A defect still open after a fix loop = the same finding failing twice.
  const repeated: QaFinding[] = [];
  for (const prev of mine) {
    const answer = reply.previous.find((p) => p.id.toUpperCase() === prev.id.toUpperCase());
    const blocking = prev.type === 'defect' && prev.status === 'open';
    if (!blocking) {
      report.findings.push({ ...prev });
      continue;
    }
    // Not mentioned = not confirmed fixed: treat as still open (fail closed).
    const stillOpen = !answer || answer.status === 'still_open';
    report.findings.push({ ...prev, status: stillOpen ? 'open' : 'fixed' });
    if (stillOpen) repeated.push(prev);
  }

  // 2. New findings get pipeline-assigned IDs. A failing pre-existing test is not a defect.
  const known = new Set(input.preExistingFailures ?? []);
  let n = input.nextId;
  for (const f of reply.findings) {
    let type = f.type;
    if (type === 'defect' && f.repro && [...known].some((t) => f.repro!.includes(t))) type = 'pre_existing';
    report.findings.push({ ...f, type, id: `F${n++}`, repo: w.repo, status: type === 'defect' || type === 'spec_ambiguity' || type === 'flaky' ? 'open' : 'waived', round: input.round });
  }

  // 3. An AC the agent says is not met, with no defect naming it, still blocks.
  const fresh = report.findings.filter((f) => f.round === input.round);
  for (const ac of report.acResults.filter((a) => !a.met)) {
    if (fresh.some((f) => f.type === 'defect' && normaliseAcId(f.criterion ?? '') === ac.id)) continue;
    report.findings.push({ id: `F${n++}`, type: 'defect', repo: w.repo, criterion: ac.id, title: `${ac.id} is not met`, actual: ac.evidence, status: 'open', round: input.round });
  }
  const unchecked = w.acceptanceCriteria.map((a) => normaliseAcId(a.id)).filter((id) => !report.acResults.some((r) => r.id === id));
  for (const id of unchecked) {
    report.findings.push({ id: `F${n++}`, type: 'defect', repo: w.repo, criterion: id, title: `${id} was not verified by QA`, status: 'open', round: input.round });
  }

  const open = (t: QaFindingType) => report.findings.filter((f) => f.round === input.round && f.type === t && f.status === 'open');
  if (repeated.length) {
    report.verdict = 'escalate';
    report.tag = 'technical';
    report.reason = `${repeated.map((f) => f.id).join(', ')} failed again after a fix loop (same finding twice): a person takes over.`;
  } else if (open('spec_ambiguity').length) {
    report.verdict = 'needs_input';
    report.tag = 'product';
    report.questions = reply.questions.length ? reply.questions : open('spec_ambiguity').map((f) => `${f.id}: ${f.title}`);
    report.reason = `Expected behaviour is unclear (${open('spec_ambiguity').map((f) => f.id).join(', ')}).`;
  } else if (open('flaky').length) {
    report.verdict = 'needs_input';
    report.tag = 'infra';
    report.reason = `Flaky or environment failure (${open('flaky').map((f) => f.id).join(', ')}): needs DevOps, not counted as a loop.`;
  } else if (open('defect').length) {
    report.verdict = 'fail';
    report.reason = `${open('defect').length} defect(s): ${open('defect').map((f) => f.id).join(', ')}.`;
  } else {
    report.verdict = 'pass';
    report.reason = 'Every acceptance criterion verified; no open defects.';
  }
  return report;
}

/** Fresh session; read-only tools plus the repo's own test command (to verify by running, not asking). */
export function qaArgs(verify: VerifyCommand[], model?: string): string[] {
  const test = verify.find((v) => v.name.toLowerCase() === 'test') ?? verify.find((v) => /\btest\b/i.test(v.run));
  const bashTest = test ? [`Bash(${test.run.split(/\s+/).slice(0, 2).join(' ')}:*)`] : [];
  return [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--permission-mode', 'default',
    '--strict-mcp-config',
    ...(model ? ['--model', model] : []),
    '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', ...DISALLOWED_TOOLS,
    '--allowedTools', 'Read', 'Glob', 'Grep', ...bashTest
  ];
}

export function qaPrompt(input: QaInput, previous: QaFinding[]): string {
  const w = input.workItem;
  const test = input.verify.find((v) => v.name.toLowerCase() === 'test') ?? input.verify.find((v) => /\btest\b/i.test(v.run));
  return `You are the QA agent for ticket ${w.ticket}, repository "${w.repo}". You have no prior context.
Your job is a VERDICT, not a conversation. Verify the change in your current directory against the ticket's acceptance criteria and the approved plan below, NOT against what the developer says it does.
You may read files${test ? ` and run the test command (\`${test.run}\`, optionally with a file or name filter)` : ''}. You must NOT edit any file: fixes go back to the developer.
Never ask a question that can be answered by reading the code or running a test.
${input.repoPurpose ? `Repository notes: ${input.repoPurpose}\n` : ''}
<work_item>
${JSON.stringify({ ...w, qaFindings: undefined }, null, 2)}
</work_item>

<diff>
${input.diff}
</diff>

<pipeline_checks>${input.checks}</pipeline_checks>
${input.preExistingFailures?.length ? `\n<already_failing_on_base_branch>\nThese tests failed before the change. They are NOT defects of this change (report one as "pre_existing" only if relevant):\n${input.preExistingFailures.map((t) => `- ${t}`).join('\n')}\n</already_failing_on_base_branch>\n` : ''}${
    previous.length
      ? `\n<previous_findings>\nCheck these FIRST, by ID, and say for each whether it is now fixed:\n${previous.map((f) => `- ${f.id} [${f.type}, ${f.status}] ${f.title}${f.expected ? ` | expected: ${f.expected}` : ''}${f.actual ? ` | actual: ${f.actual}` : ''}`).join('\n')}\n</previous_findings>\n`
      : ''
  }
Steps:
1. ${previous.length ? 'Re-check every previous finding by ID.' : 'Read the acceptance criteria and the plan.'}
2. For EACH acceptance criterion: find the code path and a test that really asserts it (not trivially true, not mocking away the code under test). Run the relevant tests if in doubt.
3. Look for regressions for existing callers, and for the edge and error cases the ACs imply.
4. Report each problem as one finding:
   - "defect": the code does not meet the plan or an AC. Include the failing test or reproduction steps, expected vs actual, and the criterion (AC id).
   - "spec_ambiguity": the expected behaviour is genuinely unclear, or the ticket and plan conflict. Add one question per ambiguity.
   - "flaky": a failure caused by infrastructure, timeouts or nondeterminism (it passed on another run).
   - "pre_existing": also fails without this change.
   - "out_of_scope": a real bug in nearby code that this ticket does not cover.
   Style nits are not findings.

Reply with ONLY this JSON:
{"summary":"one or two sentences","previous":[{"id":"F1","status":"fixed"|"still_open","note":"..."}],"findings":[{"type":"defect"|"spec_ambiguity"|"flaky"|"pre_existing"|"out_of_scope","criterion":"AC1","title":"...","expected":"...","actual":"...","repro":"test name or steps","file":"path","line":0}],"acResults":[{"id":"AC1","met":true,"evidence":"test name / code path"}],"questions":["only for spec_ambiguity"]}`;
}

export function parseQaReply(text: string): QaReply | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  if (!Array.isArray(obj.acResults)) return undefined;
  return {
    summary: str(obj.summary) ?? '',
    previous: arr(obj.previous)
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { id?: unknown }).id === 'string')
      .map((p) => ({ id: String(p.id), status: p.status === 'fixed' ? 'fixed' : 'still_open', note: str(p.note) })),
    findings: arr(obj.findings)
      .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object' && typeof (f as { title?: unknown }).title === 'string')
      .map((f) => ({
        type: TYPES.includes(f.type as QaFindingType) ? (f.type as QaFindingType) : 'defect',
        criterion: str(f.criterion),
        title: String(f.title),
        expected: str(f.expected),
        actual: str(f.actual),
        repro: str(f.repro),
        file: str(f.file),
        line: typeof f.line === 'number' && f.line > 0 ? f.line : undefined
      })),
    acResults: arr(obj.acResults)
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
      .map((a) => ({ id: String(a.id), met: a.met === true, evidence: str(a.evidence) ?? '' })),
    questions: arr(obj.questions).filter((q): q is string => typeof q === 'string').slice(0, 5)
  };
}
