import { CHECKLIST_LABELS, type ChecklistItem, type TicketPlan } from './types.js';
import type { CheckRow } from '../intake/ticket-template.js';
import type { PlanSection, QaStatement } from './dev-qa-plan.js';

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
const codeBlock = (s: string): AdfNode => ({ type: 'codeBlock', attrs: { language: 'markdown' }, content: [{ type: 'text', text: s.trim() || '-' }] });
const checkLozenge = (st: CheckRow['status']) =>
  st === 'pass' ? status('ok', 'green') : st === 'fail' ? status('missing', 'red') : st === 'warn' ? status('check', 'yellow') : status('skipped', 'neutral');
/** The intake checklist: one row per check. */
const intakeTable = (rows: CheckRow[]): AdfNode => table(['Check', 'Result', 'Detail'], rows.map((r) => [[strong(r.check)], [checkLozenge(r.status)], withCode(r.detail)]));

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
  repoFacts?: Array<{ repo: string; branch?: string; verify?: string; rollback?: string; readAt?: string }>;
}

// ── approval sheet: dev plan and QA plan ─────────────────────────────────────────────────────

const changeColor = (c: string): 'green' | 'yellow' | 'red' | 'blue' =>
  /drop|remove|delete/.test(c) ? 'red' : /create|add/.test(c) ? 'green' : /query_only/.test(c) ? 'blue' : 'yellow';
/** A dev section: its table, or "None: <reason>". */
function devSection<T>(title: string, s: PlanSection<T> | undefined, header: string[], row: (t: T) => Array<AdfNode[] | string>): AdfNode[] {
  if (!s) return [];
  if (!s.items.length) return [heading(3, title), para(status('none', 'neutral'), ...(s.none ? [text(` ${s.none}`)] : []))];
  return [heading(3, title), table(header, s.items.map(row))];
}



// ── plan for review ────────────────────────────────────────────────────────────────────────

export function planCommentAdf(plan: TicketPlan, meta: PlanCommentMeta): AdfNode {
  const v = meta.version && meta.version > 1 ? ` v${meta.version} (revised)` : '';
  const C: AdfNode[] = [];

  C.push(
    panel(
      'info',
      para(strong(`🤖 AI Orchestrator · Change plan${v} for ${plan.ticket}`), text(' · '), verdictLozenge(plan.readiness)),
      para(text('Nothing has been changed yet. Review the Dev Plan and QA Plan, then approve or request changes (see the end of this comment).'))
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

  // ── DEV PLAN (team template, items 1-6) ──
  C.push(rule(), heading(2, 'Dev Plan'));
  C.push(heading(3, '1. Repos to update or create, with change summary'));
  C.push(
    table(
      ['#', 'Repository', 'Action', 'Change summary', 'Why this repo', 'Order'],
      [
        ...plan.workItems.map((w) => [
          [strong(w.id)],
          [code(w.repo), text(' '), status(w.confidence, w.confidence === 'high' ? 'green' : w.confidence === 'medium' ? 'yellow' : 'red')],
          [status('update', 'blue')],
          withCode(w.task),
          withCode(w.reason),
          w.dependsOn.length ? `after ${w.dependsOn.join(', ')}` : 'first'
        ]),
        ...(plan.devPlan?.newRepos ?? []).map((r) => [[strong('new')], [code(r.name)], [status('create', 'green')], withCode(r.summary), withCode(r.purpose || '-'), 'before coding'])
      ]
    )
  );
  const d = plan.devPlan;
  const notGiven = (n: string) => [heading(3, n), para(em('Not given by the planner (plan made with an older prompt).'))];
  C.push(
    ...(d
      ? [
          ...devSection('2. Databases, change summary per table', d.db, ['Table', 'Change', 'Summary', 'Migration', 'Backward compatible'], (x) => [
            [code(`${x.database ? `${x.database}.` : ''}${x.table}`), ...(x.repo ? [text(` ${x.repo}`)] : [])],
            [status(x.change.replace('_', ' '), changeColor(x.change))],
            withCode(x.summary),
            x.migration ? [code(x.migration)] : '-',
            [x.backwardCompatible ? status('yes', 'green') : status('no', 'red')]
          ]),
          ...devSection('3. Cache keys, change summary per key', d.cache, ['Key', 'Change', 'Summary', 'TTL'], (x) => [
            [code(x.key), ...(x.repo ? [text(` ${x.repo}`)] : [])],
            [status(x.change.replace('_', ' '), changeColor(x.change))],
            withCode(x.summary),
            x.ttl || '-'
          ]),
          ...devSection('4. Secrets Manager keys, change summary per key', d.secrets, ['Secret / key', 'Change', 'Summary', 'Environments'], (x) => [
            [code(`${x.secret}/${x.key}`)],
            [status(x.change, changeColor(x.change))],
            withCode(x.summary),
            x.environments.join(', ') || '-'
          ]),
          ...devSection('5. Infra: Helm, service metadata, Terraform', d.infra, ['Kind', 'Target', 'Summary'], (x) => [
            [status(x.kind.replace('_', ' '), 'purple')],
            [code(x.target)],
            withCode(x.summary)
          ]),
          ...devSection('6. Alerts and telemetry', d.telemetry, ['Kind', 'Name', 'Change', 'Summary / condition'], (x) => [
            [status(x.kind, x.kind === 'alert' ? 'red' : 'blue')],
            [code(x.name)],
            [status(x.change, changeColor(x.change))],
            withCode(`${x.summary}${x.condition ? ` · when ${x.condition}` : ''}`)
          ])
        ]
      : [
          ...notGiven('2. Databases, change summary per table'),
          ...notGiven('3. Cache keys, change summary per key'),
          ...notGiven('4. Secrets Manager keys, change summary per key'),
          ...notGiven('5. Infra: Helm, service metadata, Terraform'),
          ...notGiven('6. Alerts and telemetry')
        ])
  );

  // ── QA PLAN (team template, items 1-4) ──
  C.push(rule(), heading(2, 'QA Plan'));
  const q = plan.qaPlan;
  C.push(heading(3, '1. Test cases, with what each validates'));
  if (q?.testCases.length) {
    C.push(
      table(['#', 'Test case', 'Validates', 'Type', 'AC', 'Automated test'], q.testCases.map((t) => [
        [strong(t.id)],
        withCode(t.title),
        withCode(t.validates),
        [status(t.type, t.type === 'manual' ? 'purple' : 'blue')],
        t.ac || '-',
        t.test ? [code(t.test)] : '-'
      ]))
    );
  } else if (plan.testPlan.length) {
    C.push(table(['Test', 'AC', 'Cases'], plan.testPlan.map((t) => [[code(t.name || '(unnamed)')], t.ac || '-', withCode(t.cases.join('; ') || '-')])));
  } else C.push(para(em('none')));
  const statements = (title: string, items: QaStatement[] | undefined) => [
    heading(3, title),
    items?.length ? table(['#', 'Statement', 'Checked by'], items.map((s) => [[strong(s.id)], withCode(s.text), s.checkedBy ? [code(s.checkedBy)] : '-'])) : para(em(q ? 'none' : 'Not given by the planner (plan made with an older prompt).'))
  ];
  C.push(...statements('2. Must NOT happen (constraints)', q?.mustNotHappen));
  C.push(...statements('3. Must happen (happy cases)', q?.happyCases));
  C.push(heading(3, '4. Edge cases'));
  C.push(
    plan.edgeCases.length
      ? table(
          ['#', 'Case', 'Source', 'Outcome'],
          plan.edgeCases.map((e) => {
            const qq = plan.questions.find((x) => x.from === e.id || x.covers?.includes(e.id));
            const outcome: AdfNode[] =
              e.status === 'handled'
                ? [status('handled', 'green'), text(' '), code(e.test ?? '?')]
                : e.status === 'safe_default'
                  ? [status('default', 'blue'), text(` ${e.note ?? ''}`)]
                  : e.status === 'not_affected'
                    ? [status('not affected', 'neutral'), text(` ${e.note ?? ''}`)]
                    : [status('question', 'yellow'), text(` ${qq?.id ?? ''}`)];
            return [[strong(e.id)], withCode(e.case || e.question || '-'), e.source, outcome];
          })
        )
      : para(em('none'))
  );

  // ── MORE DETAILS (everything else the plan carries) ──
  C.push(rule(), heading(2, 'More details'));
  for (const w of plan.workItems.filter((x) => x.approach.length || x.filesLikelyTouched.length || x.baselineFix)) {
    C.push(heading(3, `How ${w.id} · ${w.repo} will be changed`));
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
    C.push(heading(3, 'Unit tests written before the code'));
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
  if (plan.intakeChecks?.length) {
    const n = plan.intakeChecks.filter((r) => r.status === 'pass').length;
    const w = plan.intakeChecks.filter((r) => r.status === 'warn').length;
    C.push(heading(3, `Intake checks · ${n}/${plan.intakeChecks.filter((r) => r.status !== 'skip').length} passed${w ? ` · ${w} to check` : ''}`));
    C.push(intakeTable(plan.intakeChecks));
  }
  if (plan.gapAnalysis.length) {
    C.push(heading(3, 'Readiness checklist'));
    C.push(
      table(
        ['Item', 'Status', 'Where found / what is unclear'],
        plan.gapAnalysis.map((g) => [
          CHECKLIST_LABELS[g.item as ChecklistItem] ?? g.item,
          [g.status === 'found' ? status('found', 'green') : g.severity === 'minor' ? status('assumed', 'blue') : status(g.status, 'yellow')],
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
        ['Repository', 'Planned on', 'Branch', 'Verify steps', 'Rollback'],
        meta.repoFacts.map((f) => [[code(f.repo)], f.readAt ? [code(f.readAt)] : '-', f.branch ? [code(f.branch)] : '-', f.verify ? [code(f.verify)] : '-', f.rollback || '-'])
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
    ...(plan.intakeChecks?.length ? [heading(3, 'Every check on this ticket'), intakeTable(plan.intakeChecks)] : []),
    ...(plan.templateText
      ? [heading(3, 'Ticket template'), para(text('Copy into the description and fill in each section. Keep the headings: they are how the check finds each section.')), codeBlock(plan.templateText)]
      : []),
    panel('info', para(text(statusMode ? 'Then move the ticket back to ' : 'Then add the label '), code(readyLabel), text(statusMode ? '. Nothing has been changed.' : ' again. Nothing has been changed.')))
  ]);
}
