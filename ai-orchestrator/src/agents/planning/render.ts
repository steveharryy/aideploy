import { CHECKLIST_LABELS, type TicketPlan } from './types.js';
import { renderChecks } from '../intake/ticket-template.js';
import type { PlanSection } from './dev-qa-plan.js';

/**
 * Human-readable views of a TicketPlan for the CLI, Jira comments and plan.md.
 * Plain text (Jira comments put it in a code block).
 */

const bullets = (items: string[], indent = '  ') => (items.length ? items.map((i) => `${indent}- ${i}`) : [`${indent}- none`]);

export function renderPlan(plan: TicketPlan): string {
  const L: string[] = [];
  L.push(`Summary : ${plan.summary || '-'}`);
  for (const w of plan.warnings) L.push(`⚠ WARNING: ${w}`);
  L.push(`Verdict : ${plan.readiness.toUpperCase()}`);
  L.push(`Risk    : ${plan.risk.toUpperCase()}${plan.riskReason ? ` — ${plan.riskReason}` : ''}`);

  // ── DEV PLAN (team template, items 1-6) ──
  const d = plan.devPlan;
  const sec = <T>(title: string, x: PlanSection<T> | undefined, line: (t: T) => string) =>
    !x ? [`${title}`, '  - not given by the planner (older prompt)'] : x.items.length ? [title, ...x.items.map((t) => `  - ${line(t)}`)] : [title, `  - none${x.none ? `: ${x.none}` : ''}`];
  L.push('', '=== DEV PLAN ===', '1. REPOS TO UPDATE OR CREATE (change summary per repo)');
  if (plan.workItems.length === 0 && !d?.newRepos.length) L.push('  - none chosen yet');
  for (const w of plan.workItems) {
    L.push(`  ${w.id}  ${w.repo}  [update · confidence ${w.confidence}]${w.dependsOn.length ? `  after ${w.dependsOn.join(', ')}` : ''}`);
    L.push(`      Change: ${w.task}`);
    if (w.reason) L.push(`      Why   : ${w.reason}`);
  }
  for (const r of d?.newRepos ?? []) L.push(`  new  ${r.name}  [create, by a person before coding]`, `      Change: ${r.summary}`, ...(r.purpose ? [`      Purpose: ${r.purpose}`] : []));
  L.push(
    ...sec('2. DATABASES (change summary per table)', d?.db, (x) => `${x.database ? `${x.database}.` : ''}${x.table} [${x.change}] ${x.summary}${x.migration ? ` · migration ${x.migration}` : ''}${x.backwardCompatible ? '' : ' · NOT backward compatible'}`),
    ...sec('3. CACHE KEYS (change summary per key)', d?.cache, (x) => `${x.key} [${x.change}] ${x.summary}${x.ttl ? ` · TTL ${x.ttl}` : ''}`),
    ...sec('4. SECRETS MANAGER KEYS (change summary per key)', d?.secrets, (x) => `${x.secret}/${x.key} [${x.change}] ${x.summary}${x.environments.length ? ` · ${x.environments.join(', ')}` : ''}`),
    ...sec('5. INFRA (Helm, service metadata, Terraform)', d?.infra, (x) => `${x.kind}: ${x.target} · ${x.summary}`),
    ...sec('6. ALERTS AND TELEMETRY', d?.telemetry, (x) => `${x.kind} ${x.name} [${x.change}] ${x.summary}${x.condition ? ` · when ${x.condition}` : ''}`)
  );

  // ── QA PLAN (team template, items 1-4) ──
  const q = plan.qaPlan;
  L.push('', '=== QA PLAN ===', '1. TEST CASES (what each validates)');
  if (q?.testCases.length) for (const t of q.testCases) L.push(`  ${t.id} [${t.type}${t.ac ? ` · ${t.ac}` : ''}] ${t.title}: ${t.validates}${t.test ? ` (${t.test})` : ''}`);
  else if (plan.testPlan.length) for (const t of plan.testPlan) L.push(`  ${t.name || '(unnamed)'} [${t.ac}] ${t.cases.join('; ')}`);
  else L.push('  - none');
  const stmts = (title: string, items: Array<{ id: string; text: string; checkedBy?: string }> | undefined) => [
    title,
    ...(items?.length ? items.map((x) => `  ${x.id} ${x.text}${x.checkedBy ? ` (${x.checkedBy})` : ''}`) : [q ? '  - none' : '  - not given by the planner (older prompt)'])
  ];
  L.push(...stmts('2. MUST NOT HAPPEN (constraints)', q?.mustNotHappen), ...stmts('3. MUST HAPPEN (happy cases)', q?.happyCases));
  L.push('4. EDGE CASES');
  if (!plan.edgeCases.length) L.push('  - none');
  for (const e of plan.edgeCases) {
    const qq = plan.questions.find((x) => x.from === e.id || x.covers?.includes(e.id));
    const outcome =
      e.status === 'handled'
        ? `handled → test ${e.test ?? '?'}`
        : e.status === 'safe_default'
          ? `safe default → ${e.note ?? '-'}`
          : e.status === 'not_affected'
            ? `not affected${e.note ? ` (${e.note})` : ''}`
            : `unclear → ${qq?.id ?? 'question'}`;
    L.push(`  ${e.id} [${e.source}] ${e.case} → ${outcome}`);
  }

  // ── MORE DETAILS ──
  L.push('', '=== MORE DETAILS ===');
  for (const w of plan.workItems.filter((x) => x.approach.length || x.filesLikelyTouched.length || x.baselineFix)) {
    L.push(`HOW ${w.id} (${w.repo}) WILL BE CHANGED`);
    if (w.filesLikelyTouched.length) L.push(`  Files : ${w.filesLikelyTouched.join(', ')}`);
    if (w.baselineFix) L.push(`  Step 0: fix the test baseline (${w.baselineFix.reason}); only ${w.baselineFix.files.join(', ')}`);
    w.approach.forEach((a, i) => L.push(`  ${i + 1}) ${a}`));
  }
  if (plan.contract.length) L.push('SHARED CONTRACT (all repos build against this)', ...bullets(plan.contract));
  L.push('ACCEPTANCE CRITERIA (definition of done once approved)');
  if (plan.acceptanceCriteria.length === 0) L.push('  - none');
  for (const ac of plan.acceptanceCriteria) {
    L.push(`  ${ac.id} [${ac.workItem || '-'}] ${ac.text}`);
    L.push(`      verify: ${ac.verify}${ac.source === 'derived' ? '   (proposed by the agent: please confirm)' : ''}`);
  }
  L.push('UNIT TESTS WRITTEN BEFORE THE CODE');
  if (plan.testPlan.length === 0) L.push('  - none');
  for (const t of plan.testPlan) {
    L.push(`  ${t.name || '(unnamed)'}  [${t.ac}${t.workItem ? `, ${t.workItem}` : ''}]`);
    t.cases.forEach((c) => L.push(`      - ${c}`));
  }
  if (plan.intakeChecks?.length) {
    L.push('INTAKE CHECKS (plain code, before planning)');
    for (const l of renderChecks(plan.intakeChecks)) L.push(`  ${l}`);
  }
  if (plan.gapAnalysis.length) {
    L.push('READINESS CHECKLIST (the verdict is decided by code from this)');
    for (const g of plan.gapAnalysis) {
      const mark = g.status === 'found' ? '✓' : g.severity === 'blocking' ? '✗' : '~';
      const qq = plan.questions.find((x) => x.from === g.item);
      const viaEdgeCases = g.item === 'edge_cases' && plan.edgeCases.some((e) => e.status === 'unclear');
      const outcome =
        g.status === 'found' ? '' : g.severity === 'minor' ? ` → assumed: ${g.assumption ?? '-'}` : qq ? ` → ${qq.id}` : viaEdgeCases ? ' → see the unclear edge cases' : ' → blocking';
      L.push(`  ${mark} ${CHECKLIST_LABELS[g.item].padEnd(19)} ${g.status.padEnd(9)} ${g.source}${outcome}`);
    }
  }
  if (plan.clarifications.length) L.push('CLARIFICATIONS (answers already given)', ...bullets(plan.clarifications));
  L.push('ASSUMPTIONS (minor gaps filled with a default: correct them if wrong)', ...bullets(plan.assumptions));
  L.push('OUT OF SCOPE', ...bullets(plan.outOfScope));
  return L.join('\n');
}

/** Batched blocking questions, with answer instructions. */
/** How a person asks for another planning round: a label (default) or moving the ticket to a status. */
export const againHow = (name: string, statusMode?: boolean): string =>
  statusMode ? `move the ticket back to "${name}"` : `add the label "${name}" again`;

export function renderQuestions(plan: TicketPlan, readyLabel: string, round: number, maxRounds: number, statusMode?: boolean): string[] {
  const letters = 'ABCDEFGH';
  const lines: string[] = [
    `${plan.ticket} needs ${plan.questions.length} answer${plan.questions.length === 1 ? '' : 's'} before it can be planned (round ${round} of ${maxRounds}).`
  ];
  for (const q of plan.questions) {
    const from = q.from ? (q.from in CHECKLIST_LABELS ? CHECKLIST_LABELS[q.from as keyof typeof CHECKLIST_LABELS] : `edge case ${q.from}`) : '';
    lines.push(`${q.id}. ${q.text}${from ? `  [${from}]` : ''}`);
    q.options.forEach((o, i) => lines.push(`   ${letters[i] ?? '-'}) ${o}${q.defaultOption && o === q.defaultOption ? '  (default)' : ''}`));
  }
  const example = plan.questions.map((q) => `${q.id}: A`).join(', ');
  lines.push(`How to answer: reply in a comment (e.g. "${example}", or your own words), then ${againHow(readyLabel, statusMode)}.`);
  if (plan.assumptions.length) lines.push('Already assumed (correct if wrong):', ...plan.assumptions.map((a) => `- ${a}`));
  return lines;
}

/** Too-vague ticket: what the reporter must add. */
export function renderMissing(plan: TicketPlan, readyLabel: string, statusMode?: boolean): string[] {
  return [
    `Not enough information to plan ${plan.ticket}. Please add:`,
    ...plan.missingForReporter.map((m) => `- ${m}`),
    ...(plan.intakeChecks?.length ? ['', 'EVERY CHECK ON THIS TICKET (✓ ok · ✗ missing · ! check · – skipped)', ...renderChecks(plan.intakeChecks).map((l) => `  ${l}`)] : []),
    ...(plan.templateText ? ['', 'TICKET TEMPLATE (copy into the description; keep the headings):', ...plan.templateText.split('\n')] : []),
    `Then ${againHow(readyLabel, statusMode)}. Nothing has been changed.`
  ];
}
