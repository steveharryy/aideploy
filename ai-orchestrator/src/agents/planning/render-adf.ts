import { CHECKLIST_LABELS, type ChecklistItem, type TicketPlan } from './types.js';

/**
 * Jira-native (Atlassian Document Format) comments for the planning phase: headings, tables,
 * status lozenges, panels and lists instead of one monospace block. The plain-text renderers in
 * render.ts stay as the fallback if Jira ever rejects a rich comment.
 *
 * ADF rules that matter here: text nodes must be non-empty, "version" sits on the doc, and table
 * cells hold block nodes (paragraphs). Every builder below guarantees that.
 */

export type AdfNode = Record<string, unknown>;

// ── tiny builders ───────────────────────────────────────────────────────────────────────────

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
// Inline text keeps its edge spaces (collapsed, never trimmed): text, strong and code nodes sit
// side by side in one paragraph, and callers put the separating space in deliberately
// (strong('Q1. '), text(' again')). Trimming glued them together ("Q1.What", "labelai-ready").
const text = (s: string, marks?: AdfNode[]): AdfNode => {
  const value = (s ?? '').replace(/\s+/g, ' ');
  return { type: 'text', text: value.trim() ? value : '-', ...(marks ? { marks } : {}) };
};
const strong = (s: string) => text(s, [{ type: 'strong' }]);
const em = (s: string) => text(s, [{ type: 'em' }]);
const code = (s: string) => text(s, [{ type: 'code' }]);
const para = (...content: AdfNode[]): AdfNode => ({ type: 'paragraph', content: content.length ? content : [text('-')] });
const heading = (level: number, s: string): AdfNode => ({ type: 'heading', attrs: { level }, content: [text(s)] });
const rule = (): AdfNode => ({ type: 'rule' });
const status = (s: string, color: 'neutral' | 'purple' | 'blue' | 'red' | 'yellow' | 'green'): AdfNode => ({
  type: 'status',
  attrs: { text: s.toUpperCase(), color, localId: `s-${s}-${color}` }
});
const panel = (panelType: 'info' | 'note' | 'success' | 'warning' | 'error', ...content: AdfNode[]): AdfNode => ({
  type: 'panel',
  attrs: { panelType },
  content
});
const bullets = (items: AdfNode[][]): AdfNode =>
  items.length
    ? { type: 'bulletList', content: items.map((inline) => ({ type: 'listItem', content: [para(...inline)] })) }
    : para(em('none'));
const numbered = (items: AdfNode[][]): AdfNode => ({
  type: 'orderedList',
  attrs: { order: 1 },
  content: items.map((inline) => ({ type: 'listItem', content: [para(...inline)] }))
});
const cell = (inline: AdfNode[] | string, header = false): AdfNode => ({
  type: header ? 'tableHeader' : 'tableCell',
  content: [para(...(typeof inline === 'string' ? [text(inline)] : inline))]
});
const table = (header: string[], rows: Array<Array<AdfNode[] | string>>): AdfNode => ({
  type: 'table',
  attrs: { isNumberColumnEnabled: false, layout: 'default' },
  content: [
    { type: 'tableRow', content: header.map((h) => cell(h, true)) },
    ...rows.map((r) => ({ type: 'tableRow', content: r.map((c) => cell(c)) }))
  ]
});
/** "a `code` b" → text and code nodes. */
const withCode = (s: string): AdfNode[] => {
  const parts = clean(s).split(/`([^`]+)`/);
  const out = parts.map((p, i) => (i % 2 ? code(p) : p ? text(p) : null)).filter((n): n is AdfNode => !!n);
  return out.length ? out : [text('-')];
};
const doc = (content: AdfNode[]): AdfNode => ({ type: 'doc', version: 1, content });

const riskColor = { low: 'green', medium: 'yellow', high: 'red' } as const;
const verifyLabel = { unit_test: 'Unit test', qa_api_check: 'QA API check', human: 'Human check' } as const;
const verdictLozenge = (r: TicketPlan['readiness']) =>
  r === 'ready' ? status('ready for review', 'green') : r === 'blocking' ? status('needs answers', 'yellow') : status('needs more info', 'red');

export interface PlanCommentMeta {
  version?: number;
  readyLabel: string;
  approvedLabel: string;
  /** readyLabel / approvedLabel are Jira status names: the ticket is moved, not labelled. */
  statusMode?: boolean;
  promptVersion?: string;
  costUsd?: number;
  /** Per-repo facts: branch, verify commands, rollback. */
  repoFacts?: Array<{ repo: string; branch?: string; verify?: string; rollback?: string }>;
}

// ── plan for review ────────────────────────────────────────────────────────────────────────

export function planCommentAdf(plan: TicketPlan, meta: PlanCommentMeta): AdfNode {
  const v = meta.version && meta.version > 1 ? ` v${meta.version} (revised)` : '';
  const C: AdfNode[] = [];

  C.push(
    panel(
      'info',
      para(strong(`🤖 AI Orchestrator · Change plan${v} for ${plan.ticket}`), text(' · '), verdictLozenge(plan.readiness)),
      para(text('Nothing has been changed yet. Review the plan below, then approve or request changes (see the end of this comment).'))
    )
  );
  if (plan.warnings.length) {
    C.push(panel('warning', para(strong(`⚠ ${plan.warnings.length} warning(s): read before approving`)), bullets(plan.warnings.map((w) => withCode(w)))));
  }

  C.push(heading(3, 'Summary'), para(...withCode(plan.summary)));
  C.push(
    table(
      ['Risk', 'Repositories', 'Planned with'],
      [
        [
          [status(plan.risk, riskColor[plan.risk]), text(` ${plan.riskReason || ''}`)],
          plan.workItems.map((w, i) => [...(i ? [text(', ')] : []), code(w.repo)]).flat(),
          `prompt ${meta.promptVersion ?? '-'}${typeof meta.costUsd === 'number' ? ` · $${meta.costUsd.toFixed(2)}` : ''}`
        ]
      ]
    )
  );

  C.push(heading(3, 'Work items'));
  C.push(
    table(
      ['#', 'Repository', 'What changes', 'Why this repo', 'Order'],
      plan.workItems.map((w) => [
        [strong(w.id)],
        [code(w.repo), text(' '), status(w.confidence, w.confidence === 'high' ? 'green' : w.confidence === 'medium' ? 'yellow' : 'red')],
        withCode(w.task),
        withCode(w.reason),
        w.dependsOn.length ? `after ${w.dependsOn.join(', ')}` : 'first'
      ])
    )
  );
  for (const w of plan.workItems.filter((x) => x.approach.length || x.filesLikelyTouched.length || x.baselineFix)) {
    C.push(para(strong(`${w.id} · ${w.repo}`)));
    if (w.baselineFix) {
      C.push(
        panel(
          'warning',
          para(strong('Step 0, test baseline fix: '), text(`${w.baselineFix.reason} Only these files may change for it: `), ...w.baselineFix.files.flatMap((f, i) => [...(i ? [text(', ')] : []), code(f)]))
        )
      );
    }
    if (w.filesLikelyTouched.length) C.push(para(text('Files: '), ...w.filesLikelyTouched.flatMap((f, i) => [...(i ? [text(', ')] : []), code(f)])));
    if (w.approach.length) C.push(numbered(w.approach.map((a) => withCode(a))));
  }

  if (plan.contract.length) {
    C.push(heading(3, 'Shared contract (all repos build against this)'), bullets(plan.contract.map((c) => withCode(c))));
  }

  C.push(heading(3, 'Acceptance criteria (definition of done)'));
  C.push(
    table(
      ['#', 'Criterion', 'Verified by', 'Work item', 'Source'],
      plan.acceptanceCriteria.map((a) => [
        [strong(a.id)],
        withCode(a.text),
        [status(verifyLabel[a.verify], a.verify === 'human' ? 'purple' : 'blue')],
        a.workItem || '-',
        a.source === 'derived' ? [em('proposed, please confirm')] : 'ticket'
      ])
    )
  );

  if (plan.testPlan.length) {
    C.push(heading(3, 'Test plan (written before the code)'));
    C.push({
      type: 'bulletList',
      content: plan.testPlan.map((t) => ({
        type: 'listItem',
        content: [
          para(code(t.name || '(unnamed test)'), text(`  ${t.ac}${t.workItem ? ` · ${t.workItem}` : ''}`)),
          ...(t.cases.length ? [bullets(t.cases.map((c) => withCode(c)))] : [])
        ]
      }))
    });
  }

  if (plan.edgeCases.length) {
    C.push(heading(3, 'Edge cases'));
    C.push(
      table(
        ['#', 'Case', 'Source', 'Outcome'],
        plan.edgeCases.map((e) => {
          const q = plan.questions.find((x) => x.from === e.id || x.covers?.includes(e.id));
          const outcome: AdfNode[] =
            e.status === 'handled'
              ? [status('handled', 'green'), text(' '), code(e.test ?? '?')]
              : e.status === 'safe_default'
                ? [status('default', 'blue'), text(` ${e.note ?? ''}`)]
                : e.status === 'not_affected'
                  ? [status('not affected', 'neutral'), text(` ${e.note ?? ''}`)]
                  : [status('question', 'yellow'), text(` ${q?.id ?? ''}`)];
          return [[strong(e.id)], withCode(e.case || e.question || '-'), e.source, outcome];
        })
      )
    );
  }

  if (plan.gapAnalysis.length) {
    C.push(heading(3, 'Readiness checklist'));
    C.push(
      table(
        ['Item', 'Status', 'Where found / what is unclear'],
        plan.gapAnalysis.map((g) => [
          CHECKLIST_LABELS[g.item as ChecklistItem] ?? g.item,
          [
            g.status === 'found'
              ? status('found', 'green')
              : g.severity === 'minor'
                ? status('assumed', 'blue')
                : status(g.status, 'yellow')
          ],
          withCode(g.status !== 'found' && g.severity === 'minor' && g.assumption ? `${g.source} → assumed: ${g.assumption}` : g.source)
        ])
      )
    );
  }

  if (plan.clarifications.length) C.push(heading(3, 'Clarifications (answers already given)'), bullets(plan.clarifications.map((c) => withCode(c))));
  if (plan.assumptions.length) {
    C.push(panel('note', para(strong('Assumptions: correct them if wrong')), bullets(plan.assumptions.map((a) => withCode(a)))));
  }
  if (plan.outOfScope.length) C.push(heading(3, 'Out of scope'), bullets(plan.outOfScope.map((o) => withCode(o))));

  if (meta.repoFacts?.length) {
    C.push(heading(3, 'How it will be done after approval'));
    C.push(
      table(
        ['Repository', 'Branch', 'Verify steps', 'Rollback'],
        meta.repoFacts.map((f) => [[code(f.repo)], f.branch ? [code(f.branch)] : '-', f.verify ? [code(f.verify)] : '-', f.rollback || '-'])
      )
    );
  }

  C.push(rule());
  C.push(
    panel(
      'success',
      para(strong('Next step')),
      bullets([
        [strong('Approve: '), text(meta.statusMode ? 'move the ticket to ' : 'add the label '), code(meta.approvedLabel)],
        [strong('Request changes: '), text(meta.statusMode ? 'comment what to change, then move the ticket back to ' : 'comment what to change, then add the label '), code(meta.readyLabel), text(meta.statusMode ? ' (you get a revised plan)' : ' again (you get a revised plan)')],
        [strong('Reject: '), text('do nothing; optionally comment why')]
      ])
    )
  );
  return doc(C);
}

// ── blocking questions ─────────────────────────────────────────────────────────────────────

export function questionsCommentAdf(plan: TicketPlan, readyLabel: string, round: number, maxRounds: number, statusMode?: boolean): AdfNode {
  const letters = 'ABCDEFGH';
  const C: AdfNode[] = [
    panel(
      'warning',
      para(strong(`🤖 AI Orchestrator · ${plan.ticket} needs ${plan.questions.length} answer${plan.questions.length === 1 ? '' : 's'} before it can be planned`), text(' · '), status(`round ${round} of ${maxRounds}`, 'yellow'))
    )
  ];
  for (const q of plan.questions) {
    const from = q.from ? (q.from in CHECKLIST_LABELS ? CHECKLIST_LABELS[q.from as ChecklistItem] : `edge case ${q.from}`) : '';
    C.push(para(strong(`${q.id}. `), ...withCode(q.text), ...(from ? [text(' '), status(from, 'neutral')] : [])));
    if (q.options.length) {
      C.push(
        bullets(
          q.options.map((o, i) => [strong(`${letters[i] ?? '-'})`), text(' '), ...withCode(o), ...(q.defaultOption === o ? [text(' '), status('default', 'blue')] : [])])
        )
      );
    }
  }
  if (plan.assumptions.length) C.push(panel('note', para(strong('Already assumed (correct if wrong)')), bullets(plan.assumptions.map((a) => withCode(a)))));
  C.push(
    panel(
      'info',
      para(strong('How to answer: '), text('reply in a comment, e.g. '), code(plan.questions.map((q) => `${q.id}: A`).join(', ')), text(statusMode ? ' or in your own words, then move the ticket back to ' : ' or in your own words, then add the label '), code(readyLabel), text(statusMode ? '.' : ' again.'))
    )
  );
  return doc(C);
}

// ── too vague: back to the reporter ────────────────────────────────────────────────────────

export function missingInfoCommentAdf(plan: TicketPlan, readyLabel: string, statusMode?: boolean): AdfNode {
  return doc([
    panel('error', para(strong(`🤖 AI Orchestrator · Not enough information to plan ${plan.ticket}`), text(' · '), status('needs more info', 'red'))),
    para(text('Please add the following to the ticket (description or a comment):')),
    bullets(plan.missingForReporter.map((m) => withCode(m))),
    panel('info', para(text(statusMode ? 'Then move the ticket back to ' : 'Then add the label '), code(readyLabel), text(statusMode ? '. Nothing has been changed.' : ' again. Nothing has been changed.')))
  ]);
}
