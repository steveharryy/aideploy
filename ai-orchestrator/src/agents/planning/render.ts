import { CHECKLIST_LABELS, type TicketPlan } from './types.js';

/**
 * Human-readable views of a TicketPlan for the CLI, Jira comments and plan.md.
 * Plain text (Jira comments put it in a code block).
 */

const bullets = (items: string[], indent = '  ') => (items.length ? items.map((i) => `${indent}- ${i}`) : [`${indent}- none`]);

export function renderPlan(plan: TicketPlan): string {
  const L: string[] = [];
  L.push(`Summary : ${plan.summary || '-'}`);
  L.push(
    `Repos   : ${
      plan.workItems.length
        ? plan.workItems
            .map((w) => `${w.repo} (${w.id}, confidence ${w.confidence}${w.dependsOn.length ? `, after ${w.dependsOn.join(', ')}` : ''})`)
            .join('; ')
        : 'none chosen yet'
    }`
  );
  for (const w of plan.warnings) L.push(`⚠ WARNING: ${w}`);
  L.push(`Verdict : ${plan.readiness.toUpperCase()}`);
  L.push(`Risk    : ${plan.risk.toUpperCase()}${plan.riskReason ? ` — ${plan.riskReason}` : ''}`);

  if (plan.gapAnalysis.length) {
    L.push('', 'READINESS CHECKLIST (the verdict is decided by code from this)');
    for (const g of plan.gapAnalysis) {
      const mark = g.status === 'found' ? '✓' : g.severity === 'blocking' ? '✗' : '~';
      const q = plan.questions.find((x) => x.from === g.item);
      const viaEdgeCases = g.item === 'edge_cases' && plan.edgeCases.some((e) => e.status === 'unclear');
      const outcome =
        g.status === 'found' ? '' : g.severity === 'minor' ? ` → assumed: ${g.assumption ?? '-'}` : q ? ` → ${q.id}` : viaEdgeCases ? ' → see the unclear edge cases' : ' → blocking';
      L.push(`  ${mark} ${CHECKLIST_LABELS[g.item].padEnd(19)} ${g.status.padEnd(9)} ${g.source}${outcome}`);
    }
  }
  if (plan.edgeCases.length) {
    L.push('', 'EDGE CASES');
    for (const e of plan.edgeCases) {
      const q = plan.questions.find((x) => x.from === e.id || x.covers?.includes(e.id));
      const outcome =
        e.status === 'handled'
          ? `handled → test ${e.test ?? '?'}`
          : e.status === 'safe_default'
            ? `safe default → ${e.note ?? '-'}`
            : e.status === 'not_affected'
              ? `not affected${e.note ? ` (${e.note})` : ''}`
              : `unclear → ${q?.id ?? 'question'}`;
      L.push(`  ${e.id} [${e.source}] ${e.case} → ${outcome}`);
    }
  }

  L.push('', 'WORK ITEMS (one coding agent per repo)');
  if (plan.workItems.length === 0) L.push('  - none');
  for (const w of plan.workItems) {
    L.push(`  ${w.id}  ${w.repo}  [confidence: ${w.confidence}]${w.dependsOn.length ? `  after ${w.dependsOn.join(', ')}` : ''}`);
    L.push(`      Task  : ${w.task}`);
    if (w.reason) L.push(`      Why   : ${w.reason}`);
    if (w.filesLikelyTouched.length) L.push(`      Files : ${w.filesLikelyTouched.join(', ')}`);
    w.approach.forEach((a, i) => L.push(`      ${i + 1}) ${a}`));
  }

  if (plan.contract.length) L.push('', 'SHARED CONTRACT (all repos build against this)', ...bullets(plan.contract));

  L.push('', 'ACCEPTANCE CRITERIA (definition of done once approved)');
  if (plan.acceptanceCriteria.length === 0) L.push('  - none');
  for (const ac of plan.acceptanceCriteria) {
    L.push(`  ${ac.id} [${ac.workItem || '-'}] ${ac.text}`);
    L.push(`      verify: ${ac.verify}${ac.source === 'derived' ? '   (proposed by the agent: please confirm)' : ''}`);
  }

  L.push('', 'TEST PLAN (written before the code)');
  if (plan.testPlan.length === 0) L.push('  - none');
  for (const t of plan.testPlan) {
    L.push(`  ${t.name || '(unnamed)'}  [${t.ac}${t.workItem ? `, ${t.workItem}` : ''}]`);
    t.cases.forEach((c) => L.push(`      - ${c}`));
  }

  if (plan.clarifications.length) L.push('', 'CLARIFICATIONS (answers already given)', ...bullets(plan.clarifications));
  L.push('', 'ASSUMPTIONS (minor gaps filled with a default: correct them if wrong)', ...bullets(plan.assumptions));
  L.push('', 'OUT OF SCOPE', ...bullets(plan.outOfScope));
  return L.join('\n');
}

/** Batched blocking questions, with answer instructions. */
export function renderQuestions(plan: TicketPlan, readyLabel: string, round: number, maxRounds: number): string[] {
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
  lines.push(`How to answer: reply in a comment (e.g. "${example}", or your own words), then add the label "${readyLabel}" again.`);
  if (plan.assumptions.length) lines.push('Already assumed (correct if wrong):', ...plan.assumptions.map((a) => `- ${a}`));
  return lines;
}

/** Too-vague ticket: what the reporter must add. */
export function renderMissing(plan: TicketPlan, readyLabel: string): string[] {
  return [
    `Not enough information to plan ${plan.ticket}. Please add:`,
    ...plan.missingForReporter.map((m) => `- ${m}`),
    `Then add the label "${readyLabel}" again. Nothing has been changed.`
  ];
}
