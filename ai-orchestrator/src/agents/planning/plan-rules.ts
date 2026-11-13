import type { TaskInput } from '../../models/types.js';
import { CHECKLIST_ITEMS, CHECKLIST_LABELS, ESSENTIAL_ITEMS } from './types.js';
import type {
  ChecklistItem,
  Confidence,
  EdgeCase,
  EdgeCaseStatus,
  GapEntry,
  GapStatus,
  PlanAcceptanceCriterion,
  PlanQuestion,
  PlannedTest,
  ReadinessVerdict,
  RiskLevel,
  TicketPlan,
  VerifyMethod,
  WorkItem
} from './types.js';

/**
 * Deterministic rules around the Planning Agent: cheap checks before calling the model,
 * and normalisation + validation of what the model returns. No AI here, all unit-testable.
 */

export const MIN_DESCRIPTION_CHARS = 30;

/**
 * Hard checks that need no AI. If any fail, the ticket goes straight back to the reporter
 * and no tokens are spent.
 */
export function hardChecks(task: TaskInput, minDescriptionChars = MIN_DESCRIPTION_CHARS): string[] {
  const gaps: string[] = [];
  const title = (task.title || '').trim();
  const description = (task.description || '').trim();
  const hasCriteria = task.acceptanceCriteria.some((c) => c.trim().length > 0);

  if (!title || title === task.id) gaps.push('The ticket has no summary/title.');
  // A ticket whose "description" is just its title (the Jira client falls back to it) has no description.
  const realDescription = description === title ? '' : description;
  if (realDescription.length < minDescriptionChars && !hasCriteria) {
    gaps.push(
      `The description is empty or too short (${realDescription.length} characters) and there are no acceptance criteria. ` +
        'Describe the expected behaviour and how to check it.'
    );
  }
  return gaps;
}

/**
 * Areas where a wrong guess costs real money or breaks user trust on a gaming/prediction platform.
 * Any plan touching these is at least medium risk, whatever the model says.
 */
export const MONEY_KEYWORDS = [
  'payout',
  'payment',
  'wallet',
  'withdraw',
  'withdrawal',
  'deposit',
  'refund',
  'balance',
  'bonus',
  'odds',
  'prize',
  'winnings',
  'contest rule',
  'settlement',
  'ledger',
  'transaction',
  'kyc',
  'tds',
  'gst'
];

export function touchesMoney(text: string): string[] {
  const lower = text.toLowerCase();
  return MONEY_KEYWORDS.filter((k) => new RegExp(`(?<![a-z0-9])${k.replace(/\s+/g, '\\s+')}s?(?![a-z0-9])`).test(lower));
}

// ── Normalisation: tolerate small shape mistakes from the model ────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : []);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, '_') as T;
  return allowed.includes(s) ? s : fallback;
};
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);

/** Accepts camelCase or snake_case keys. */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
}

const READINESS = ['ready', 'blocking', 'too_vague'] as const;
const VERIFY = ['unit_test', 'qa_api_check', 'human'] as const;
const RISK = ['low', 'medium', 'high'] as const;
const CONFIDENCE = ['high', 'medium', 'low'] as const;

const GAP_STATUS = ['found', 'missing', 'ambiguous'] as const;
const EDGE_STATUS = ['handled', 'not_affected', 'safe_default', 'unclear'] as const;

export class PlanParseError extends Error {}

function parseGapAnalysis(v: unknown): GapEntry[] {
  return list(v)
    .map((g) => {
      const item = str(g.item).toLowerCase().replace(/[\s-]+/g, '_').replace(/^product_and_repo$/, 'product') as ChecklistItem;
      const status = oneOf<GapStatus>(g.status, GAP_STATUS, 'missing');
      const sev = str(g.severity).toLowerCase();
      return {
        item,
        status,
        source: str(pick(g, 'source', 'where', 'reason')),
        // An unrated gap counts as blocking: asking is cheaper than a wrong guess.
        ...(status !== 'found' ? { severity: (sev === 'minor' ? 'minor' : 'blocking') as GapEntry['severity'] } : {}),
        ...(str(g.question) ? { question: str(g.question) } : {}),
        ...(strList(g.options).length ? { options: strList(g.options) } : {}),
        ...(str(pick(g, 'default', 'defaultOption', 'default_option')) ? { defaultOption: str(pick(g, 'default', 'defaultOption', 'default_option')) } : {}),
        ...(str(g.assumption) ? { assumption: str(g.assumption) } : {})
      };
    })
    .filter((g) => (CHECKLIST_ITEMS as readonly string[]).includes(g.item));
}

function parseEdgeCases(v: unknown): EdgeCase[] {
  return list(v)
    .map((e, i) => ({
      id: str(e.id) || `EC${i + 1}`,
      case: str(pick(e, 'case', 'text', 'description')),
      source: str(e.source) || 'generic',
      status: oneOf<EdgeCaseStatus>(e.status, EDGE_STATUS, 'unclear'),
      ...(str(e.test) ? { test: str(e.test) } : {}),
      ...(str(pick(e, 'note', 'assumption', 'reason')) ? { note: str(pick(e, 'note', 'assumption', 'reason')) } : {}),
      ...(str(e.question) ? { question: str(e.question) } : {}),
      ...(strList(e.options).length ? { options: strList(e.options) } : {}),
      ...(str(pick(e, 'default', 'defaultOption', 'default_option')) ? { defaultOption: str(pick(e, 'default', 'defaultOption', 'default_option')) } : {})
    }))
    // Never drop an entry silently: an unclear case without text still carries its question.
    // Entries with no case, question or note at all are noise and are dropped.
    .filter((e) => e.case || e.question || e.note);
}

/**
 * The spec's decision rule. Claude rates each gap; this code makes the call, so the same
 * analysis always gives the same verdict and every question traces back to a checklist item
 * or edge case:
 *   expected_behaviour OR product not found  → too_vague
 *   any blocking gap, or any unclear edge case → blocking (questions)
 *   otherwise                                  → ready (minor gaps and safe defaults become assumptions)
 */
export function decideReadiness(gaps: GapEntry[], edgeCases: EdgeCase[]): {
  readiness: ReadinessVerdict;
  questions: PlanQuestion[];
  missingForReporter: string[];
  assumptions: string[];
} {
  const notFound = gaps.filter((g) => g.status !== 'found');
  const essential = notFound.filter((g) => ESSENTIAL_ITEMS.includes(g.item));
  const assumptions = [
    ...notFound.filter((g) => g.severity === 'minor').map((g) => `${CHECKLIST_LABELS[g.item]}: ${g.assumption || g.source || 'default chosen'}`),
    ...edgeCases.filter((e) => e.status === 'safe_default').map((e) => `${e.id} ${e.case}: ${e.note || 'safe default'}`)
  ];

  if (essential.length > 0) {
    return {
      readiness: 'too_vague',
      questions: [],
      missingForReporter: notFound.map(
        (g) => `${CHECKLIST_LABELS[g.item]} (${g.status})${g.source ? `: ${g.source}` : ''}${g.question ? ` — ${g.question}` : ''}`
      ),
      assumptions
    };
  }

  const questions: PlanQuestion[] = [];
  const unclearEdgeCases = edgeCases.filter((e) => e.status === 'unclear');
  // The edge_cases checklist item is asked through its specific unclear edge cases, not twice.
  const askViaEdgeCases = (g: GapEntry) => g.item === 'edge_cases' && unclearEdgeCases.length > 0;
  for (const g of notFound.filter((g) => g.severity === 'blocking' && !askViaEdgeCases(g))) {
    questions.push({
      id: `Q${questions.length + 1}`,
      text: g.question || `Please clarify the ${CHECKLIST_LABELS[g.item].toLowerCase()}: ${g.source || 'not stated in the ticket'}`,
      options: g.options || [],
      ...(g.defaultOption ? { defaultOption: g.defaultOption } : {}),
      from: g.item
    });
  }
  for (const e of unclearEdgeCases) {
    // The same gap is often raised twice (a checklist item and an edge case): ask it once.
    const text = e.question || `How should this case behave: ${e.case}?`;
    const same = questions.find((q) => sameQuestion(q, { text, options: e.options || [] }));
    if (same) {
      same.covers = [...(same.covers ?? []), e.id];
      continue;
    }
    questions.push({
      id: `Q${questions.length + 1}`,
      text: e.question || `How should this case behave: ${e.case}?`,
      options: e.options || [],
      ...(e.defaultOption ? { defaultOption: e.defaultOption } : {}),
      from: e.id
    });
  }
  return { readiness: questions.length ? 'blocking' : 'ready', questions, missingForReporter: [], assumptions };
}

/** Turns the model's JSON into a well-typed TicketPlan. Throws PlanParseError if it is unusable. */
export function normalizePlan(raw: unknown, ticketId: string): TicketPlan {
  const o = obj(raw);
  const gapAnalysis = parseGapAnalysis(pick(o, 'gapAnalysis', 'gap_analysis'));
  const edgeCases = parseEdgeCases(pick(o, 'edgeCases', 'edge_cases'));
  let readinessRaw = str(pick(o, 'readiness', 'verdict')).toLowerCase().replace(/[\s-]+/g, '_');
  // With a gap analysis the verdict is computed below; the model's own verdict is not needed.
  if (gapAnalysis.length && !READINESS.includes(readinessRaw as ReadinessVerdict)) readinessRaw = 'ready';
  if (!READINESS.includes(readinessRaw as ReadinessVerdict)) {
    throw new PlanParseError(`Planning agent returned no valid "readiness" and no gap_analysis (got "${readinessRaw || 'nothing'}").`);
  }

  const questions: PlanQuestion[] = list(o.questions).map((q, i) => ({
    id: str(q.id) || `Q${i + 1}`,
    text: str(pick(q, 'text', 'question')),
    options: strList(q.options),
    defaultOption: str(pick(q, 'defaultOption', 'default_option', 'default')) || undefined
  })).filter((q) => q.text);

  const workItems: WorkItem[] = list(pick(o, 'workItems', 'work_items')).map((w, i) => ({
    id: str(w.id) || `W${i + 1}`,
    repo: str(w.repo),
    task: str(w.task),
    reason: str(w.reason),
    confidence: oneOf<Confidence>(w.confidence, CONFIDENCE, 'low'),
    dependsOn: strList(pick(w, 'dependsOn', 'depends_on')),
    filesLikelyTouched: strList(pick(w, 'filesLikelyTouched', 'files_likely_touched')),
    approach: strList(w.approach)
  }));

  const firstWorkItem = workItems[0]?.id ?? '';
  const acceptanceCriteria: PlanAcceptanceCriterion[] = list(pick(o, 'acceptanceCriteria', 'acceptance_criteria')).map((a, i) => ({
    id: str(a.id) || `AC${i + 1}`,
    text: str(a.text),
    verify: oneOf<VerifyMethod>(a.verify, VERIFY, 'human'),
    // Single-repo plans often omit it.
    workItem: str(pick(a, 'workItem', 'work_item')) || (workItems.length === 1 ? firstWorkItem : ''),
    source: (str(a.source).toLowerCase() === 'ticket' ? 'ticket' : 'derived') as PlanAcceptanceCriterion['source']
  })).filter((a) => a.text);

  const testPlan: PlannedTest[] = list(pick(o, 'testPlan', 'test_plan')).map((t) => ({
    ac: str(t.ac),
    workItem: str(pick(t, 'workItem', 'work_item')) || (workItems.length === 1 ? firstWorkItem : ''),
    name: str(t.name),
    cases: strList(t.cases)
  })).filter((t) => t.name || t.cases.length);

  const plan: TicketPlan = {
    ticket: ticketId,
    summary: str(o.summary),
    readiness: readinessRaw as ReadinessVerdict,
    assumptions: strList(o.assumptions),
    clarifications: strList(o.clarifications),
    questions,
    missingForReporter: strList(pick(o, 'missingForReporter', 'missing_for_reporter')),
    contract: strList(o.contract),
    workItems,
    acceptanceCriteria,
    testPlan,
    risk: oneOf<RiskLevel>(o.risk, RISK, 'medium'),
    riskReason: str(pick(o, 'riskReason', 'risk_reason')),
    outOfScope: strList(pick(o, 'outOfScope', 'out_of_scope')),
    warnings: [], // code-only; anything the model sends here is ignored
    gapAnalysis,
    edgeCases
  };

  // The decision rule: with a gap analysis, code decides the verdict, questions and what is missing.
  if (gapAnalysis.length) {
    const decided = decideReadiness(gapAnalysis, edgeCases);
    plan.readiness = decided.readiness;
    plan.questions = decided.questions;
    plan.missingForReporter = [...decided.missingForReporter, ...(decided.readiness === 'too_vague' ? plan.missingForReporter : [])];
    plan.assumptions = [...new Set([...plan.assumptions, ...decided.assumptions])];
  }

  // Verdict consistency (code decides, not the model).
  // A repo chosen with low confidence must be confirmed by a person before planning continues
  // (also when other questions are already being asked; not for tickets sent back as too vague).
  if (plan.readiness !== 'too_vague') {
    for (const w of plan.workItems.filter((w) => w.confidence === 'low' && w.repo)) {
      plan.questions.push({
        id: `Q${plan.questions.length + 1}`,
        text: `Is "${w.repo}" the right repository for: ${w.task}?${w.reason ? ` (agent's reason: ${w.reason})` : ''}`,
        options: [`Yes, ${w.repo}`, 'No, it is another repository (name it)'],
        defaultOption: `Yes, ${w.repo}`
      });
    }
  }
  if (plan.readiness === 'ready' && plan.questions.length > 0) plan.readiness = 'blocking';
  if (plan.readiness === 'blocking' && plan.questions.length === 0) {
    plan.readiness = 'too_vague';
    if (plan.missingForReporter.length === 0) {
      plan.missingForReporter = ['The planning agent found blocking gaps but could not phrase them as questions. Please clarify the expected behaviour.'];
    }
  }
  if (plan.readiness === 'too_vague' && plan.missingForReporter.length === 0) {
    plan.missingForReporter = ['Expected behaviour', 'Which product/service is affected', 'An example (input → expected result)', 'How to check that it works'];
  }
  return plan;
}

/** Raises the risk to at least "medium" when the ticket or plan touches money. */
export function applyRiskFloor(plan: TicketPlan, task: TaskInput): TicketPlan {
  const text = [task.title, task.description, ...task.acceptanceCriteria, plan.summary, ...plan.workItems.map((w) => w.task)].join(' ');
  const hits = touchesMoney(text);
  if (hits.length > 0 && plan.risk === 'low') {
    return {
      ...plan,
      risk: 'medium',
      riskReason: `${plan.riskReason ? `${plan.riskReason} ` : ''}(Raised to medium by policy: touches ${hits.join(', ')}.)`.trim()
    };
  }
  return plan;
}

/**
 * Structural problems in a "ready" plan. A non-empty result means the plan must not be
 * offered for approval as-is.
 */
export function validatePlan(plan: TicketPlan, knownRepos: string[], options: { requireGapAnalysis?: boolean } = {}): string[] {
  // Gap analysis completeness matters for every verdict: a forgotten item must never count as "found".
  const gapProblems = options.requireGapAnalysis || plan.gapAnalysis.length ? gapAnalysisProblems(plan) : [];
  // A repo outside the catalog is wrong whatever the verdict: the questions would be about the wrong code.
  const catalogRepos = new Set(knownRepos);
  const repoProblems = plan.workItems
    .filter((w) => w.repo && !catalogRepos.has(w.repo))
    .map((w) => `${w.id} targets "${w.repo}", which is not in the service catalog.`);
  if (plan.readiness !== 'ready') return [...gapProblems, ...repoProblems];
  const problems: string[] = [...gapProblems];
  const known = new Set(knownRepos);
  const ids = new Set<string>();

  if (plan.workItems.length === 0) problems.push('Plan is "ready" but has no work items.');
  if (plan.acceptanceCriteria.length === 0) problems.push('Plan is "ready" but has no acceptance criteria.');

  for (const w of plan.workItems) {
    if (ids.has(w.id)) problems.push(`Duplicate work item id ${w.id}.`);
    ids.add(w.id);
    if (!w.repo) problems.push(`${w.id} has no repo.`);
    else if (!known.has(w.repo)) problems.push(`${w.id} targets "${w.repo}", which is not in the service catalog.`);
    if (!w.task) problems.push(`${w.id} has no task description.`);
  }
  for (const w of plan.workItems) {
    for (const d of w.dependsOn) if (!ids.has(d)) problems.push(`${w.id} depends on unknown work item ${d}.`);
  }
  const cycle = findCycle(plan.workItems);
  if (cycle) problems.push(`Work items depend on each other in a cycle: ${cycle.join(' → ')}.`);

  const repos = plan.workItems.map((w) => w.repo);
  const dupRepos = repos.filter((r, i) => r && repos.indexOf(r) !== i);
  if (dupRepos.length) problems.push(`More than one work item for repo(s) ${[...new Set(dupRepos)].join(', ')}: use one work item per repo.`);

  const acIds = new Set<string>();
  for (const ac of plan.acceptanceCriteria) {
    if (acIds.has(ac.id)) problems.push(`Duplicate acceptance criterion id ${ac.id}.`);
    acIds.add(ac.id);
    if (!ids.has(ac.workItem)) problems.push(`${ac.id} is not linked to a known work item (got "${ac.workItem || 'none'}").`);
  }
  for (const w of plan.workItems) {
    if (!plan.acceptanceCriteria.some((ac) => ac.workItem === w.id)) problems.push(`${w.id} (${w.repo}) has no acceptance criterion.`);
  }
  // Every planned test must belong to a real work item and AC, or the coding agent never receives it.
  const acIdSet = new Set(plan.acceptanceCriteria.map((a) => a.id));
  for (const t of plan.testPlan) {
    const name = t.name || '(unnamed test)';
    if (!ids.has(t.workItem)) problems.push(`Test ${name} is not linked to a known work item (got "${t.workItem || 'none'}").`);
    if (t.ac && !acIdSet.has(t.ac)) problems.push(`Test ${name} refers to unknown acceptance criterion ${t.ac}.`);
  }
  if (plan.workItems.length > 1 && plan.contract.length === 0) {
    problems.push('Multi-repo plan has no shared contract (API shapes / field names the repos must agree on).');
  }
  return problems;
}

/** One entry per checklist item; every handled edge case is backed by a test in test_plan. */
export function gapAnalysisProblems(plan: TicketPlan): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const g of plan.gapAnalysis) counts.set(g.item, (counts.get(g.item) || 0) + 1);
  const absent = CHECKLIST_ITEMS.filter((i) => !counts.has(i));
  if (absent.length) problems.push(`gap_analysis has no entry for: ${absent.join(', ')} (one entry per checklist item is required).`);
  const twice = [...counts].filter(([, n]) => n > 1).map(([i]) => i);
  if (twice.length) problems.push(`gap_analysis lists ${twice.join(', ')} more than once.`);
  for (const g of plan.gapAnalysis) {
    if (g.status !== 'found' && g.severity === 'minor' && !g.assumption) problems.push(`gap_analysis ${g.item} is minor but has no "assumption".`);
    if (g.status !== 'found' && g.severity === 'blocking' && !ESSENTIAL_ITEMS.includes(g.item) && !g.question) {
      problems.push(`gap_analysis ${g.item} is blocking but has no "question".`);
    }
    if (g.status === 'found' && !g.source) problems.push(`gap_analysis ${g.item} is "found" but does not say where.`);
  }
  const testNames = new Set(plan.testPlan.map((t) => t.name).filter(Boolean));
  const ecSeen = new Set<string>();
  for (const e of plan.edgeCases) {
    if (ecSeen.has(e.id)) problems.push(`Edge case id ${e.id} is used more than once.`);
    ecSeen.add(e.id);
    if (!e.case) problems.push(`${e.id} has no "case" text describing the situation.`);
    if (e.status === 'handled' && (!e.test || !testNames.has(e.test))) {
      problems.push(`${e.id} (${e.case}) is marked handled but ${e.test ? `its test "${e.test}" is not in test_plan` : 'names no test'}.`);
    }
    if (e.status === 'safe_default' && !e.note) problems.push(`${e.id} (${e.case}) is a safe default but does not say which default.`);
  }
  return problems;
}

function findCycle(items: WorkItem[]): string[] | undefined {
  const deps = new Map(items.map((w) => [w.id, w.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    if (state.get(id) === 'done') return undefined;
    if (state.get(id) === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const d of deps.get(id) || []) {
      if (!deps.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };
  for (const w of items) {
    const c = visit(w.id);
    if (c) return c;
  }
  return undefined;
}

/** Repo-level dependency map derived from work items: { repo: [repos it waits for] }. */
export function repoDependencies(plan: TicketPlan): Record<string, string[]> {
  const repoOf = new Map(plan.workItems.map((w) => [w.id, w.repo]));
  return Object.fromEntries(
    plan.workItems.map((w) => [w.repo, w.dependsOn.map((d) => repoOf.get(d)).filter((r): r is string => !!r && r !== w.repo)])
  );
}

/** What the coding agent for one repo receives: its work item plus the shared context. */
export function codingBrief(plan: TicketPlan, repo: string): Record<string, unknown> | undefined {
  const item = plan.workItems.find((w) => w.repo === repo);
  if (!item) return undefined;
  return {
    ticket: plan.ticket,
    summary: plan.summary,
    workItem: item,
    otherWorkItems: plan.workItems.filter((w) => w.id !== item.id).map((w) => ({ id: w.id, repo: w.repo, task: w.task })),
    contract: plan.contract,
    acceptanceCriteria: plan.acceptanceCriteria.filter((ac) => ac.workItem === item.id),
    testPlan: plan.testPlan.filter((t) => t.workItem === item.id),
    assumptions: plan.assumptions,
    clarifications: plan.clarifications,
    outOfScope: plan.outOfScope,
    risk: plan.risk,
    rules: [
      'Work only in this repository. If the repo looks wrong, or another repo also needs changes, stop and say so in your summary.',
      'Follow the shared contract exactly. Do not change it; report a conflict instead.',
      'Name each test after its acceptance criterion id (e.g. AC1).'
    ]
  };
}

const QUESTION_STOP = new Set(['should', 'would', 'which', 'what', 'when', 'where', 'there', 'their', 'this', 'that', 'these', 'with', 'from', 'into', 'today', 'ticket', 'keep', 'only', 'also', 'have', 'does', 'will', 'been', 'being', 'about', 'other', 'current', 'currently', 'change', 'option', 'default']);
function questionWords(q: { text: string; options: string[] }): Set<string> {
  return new Set(
    `${q.text} ${q.options.join(' ')}`
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(' ')
      .filter((w) => w.length >= 4 && !QUESTION_STOP.has(w))
      .map((w) => w.replace(/(ies|es|s|ed|ing)$/, ''))
  );
}
/** Two questions are the same when most of the smaller one's meaningful words appear in the other. */
export function sameQuestion(a: { text: string; options: string[] }, b: { text: string; options: string[] }): boolean {
  const wa = questionWords(a);
  const wb = questionWords(b);
  if (wa.size < 3 || wb.size < 3) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}
