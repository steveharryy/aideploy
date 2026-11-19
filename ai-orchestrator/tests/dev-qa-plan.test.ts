import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePlan, validatePlan, workItemsForCoding } from '../src/agents/planning/plan-rules.js';
import { devQaProblems } from '../src/agents/planning/dev-qa-plan.js';
import { renderPlan } from '../src/agents/planning/render.js';
import { planCommentAdf } from '../src/agents/planning/render-adf.js';
import { PlannerTools, TOOL_DEFINITIONS } from '../src/agents/planning/tools.js';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devqa-')));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const allFound = ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'].map((item) => ({ item, status: 'found', source: 'description' }));
const devPlan = {
  db_changes: {
    items: [
      { repo: 'api', database: 'payments', table: 'transactions', change: 'add_column', summary: 'customer_ip_v4 VARCHAR(15) NULL', migration: 'src/migrations/<date>-add-ip.ts', backward_compatible: true }
    ]
  },
  cache_changes: { none: 'getClientIp reads request headers only; no Redis access' },
  secret_changes: { none: 'no new credentials' },
  infra_changes: { none: 'no chart, metadata or Terraform change' },
  telemetry_changes: { items: [{ kind: 'alert', name: 'payments-ip-unmapped', change: 'create', summary: 'IPv6 left unmapped', condition: '> 50/min for 10 min' }] }
};
const qaPlan = {
  test_cases: [{ id: 'TC1', title: 'Mapped IPv4 from every source', validates: 'AC1 for headers and socket', type: 'unit', ac: 'AC1', test: 'test_AC1_mapped' }],
  must_not_happen: [{ id: 'N1', text: 'A real IPv6 address is changed or truncated', checked_by: 'TC1' }],
  happy_cases: [{ id: 'H1', text: '::ffff:203.0.113.5 is stored as 203.0.113.5' }]
};
const raw = {
  summary: 'Plain IPv4 for mapped addresses',
  gap_analysis: allFound,
  edge_cases: [{ id: 'EC1', case: 'uppercase prefix', source: 'generic', status: 'handled', test: 'test_AC1_mapped' }],
  work_items: [{ id: 'W1', repo: 'api', task: 'strip ::ffff:', reason: 'src/utils/getUserIP.ts:4', confidence: 'high' }],
  acceptance_criteria: [{ id: 'AC1', text: 'Mapped IPv4 is returned plain', verify: 'unit_test', work_item: 'W1' }],
  test_plan: [{ ac: 'AC1', name: 'test_AC1_mapped', cases: ['::ffff:1.2.3.4 → 1.2.3.4'] }],
  risk: 'low',
  dev_plan: devPlan,
  qa_plan: qaPlan
};
const plan = (over: Record<string, unknown> = {}) => normalizePlan({ ...raw, ...over }, 'T2-9');

describe('Dev plan and QA plan: parsing', () => {
  it('reads every section, keeps "none" reasons, and raises risk for a DB change', () => {
    const p = plan();
    expect(p.devPlan?.db.items[0]).toMatchObject({ table: 'transactions', change: 'add_column', backwardCompatible: true });
    expect(p.devPlan?.cache).toEqual({ items: [], none: 'getClientIp reads request headers only; no Redis access' });
    expect(p.qaPlan?.mustNotHappen[0]).toMatchObject({ id: 'N1', checkedBy: 'TC1' });
    expect(p.risk).toBe('medium');
    expect(p.riskReason).toMatch(/Raised to medium/);
    expect(validatePlan(p, ['api'], { requireGapAnalysis: true, requireDevQaPlan: true })).toEqual([]);
  });

  it('warns the approver: unsafe DB change, and work DevOps must do', () => {
    const p = plan({
      dev_plan: {
        ...devPlan,
        db_changes: { items: [{ table: 'transactions', change: 'alter_column', summary: 'ip to VARBINARY', migration: 'm.ts', backward_compatible: false }] },
        secret_changes: { items: [{ secret: 'gb/payments/prod', key: 'CHATBIZ_API_KEY', change: 'add', summary: 'vendor key', environments: ['qa', 'prod'] }] },
        infra_changes: { items: [{ kind: 'helm', target: 'charts/payments/values-prod.yaml', summary: 'mount CHATBIZ_API_KEY' }] }
      }
    });
    expect(p.risk).toBe('high');
    expect(p.warnings.join('\n')).toMatch(/NOT backward compatible/);
    expect(p.warnings.join('\n')).toMatch(/Needs DevOps before deploy: Secrets Manager gb\/payments\/prod\/CHATBIZ_API_KEY \(add, qa\/prod\); helm: charts\/payments\/values-prod.yaml/);
  });
});

describe('Dev plan and QA plan: rules', () => {
  const problems = (over: Record<string, unknown>) => devQaProblems(plan(over));

  it('every dev section must be answered: changes, or "none" with a reason', () => {
    expect(problems({ dev_plan: undefined }).join(' ')).toMatch(/dev_plan is missing/);
    const { cache_changes: _c, ...noCache } = devPlan;
    expect(problems({ dev_plan: noCache }).join(' ')).toMatch(/Cache keys \(cache_changes\): list the changes, or set "none"/);
    expect(problems({ dev_plan: { ...devPlan, infra_changes: { items: [] } } }).join(' ')).toMatch(/infra_changes/);
  });

  it('DB changes need a migration; alerts need a condition; secrets never carry values', () => {
    const p = problems({
      dev_plan: {
        ...devPlan,
        db_changes: { items: [{ table: 'transactions', change: 'add_column', summary: 'new column', backward_compatible: true }] },
        telemetry_changes: { items: [{ kind: 'alert', name: 'x', change: 'create', summary: 'y' }] },
        secret_changes: { items: [{ secret: 'gb/payments/prod', key: 'API_KEY', change: 'add', summary: 'value: ' + ['sk', 'live', '9f8a7b6c5d4e3f2a1b0c9d8e'].join('_') }] }
      }
    }).join('\n');
    expect(p).toMatch(/transactions \(add_column\): name the migration/);
    expect(p).toMatch(/alert "x": give the condition/);
    expect(p).toMatch(/looks like a secret VALUE/);
  });

  it('QA plan: test cases, must-not-happen and happy cases required; every AC covered', () => {
    expect(problems({ qa_plan: undefined }).join(' ')).toMatch(/qa_plan is missing/);
    const p = problems({ qa_plan: { test_cases: [{ id: 'TC1', title: 't', validates: 'v', type: 'unit', ac: 'AC9' }], must_not_happen: [], happy_cases: [] } }).join('\n');
    expect(p).toMatch(/must_not_happen is empty/);
    expect(p).toMatch(/happy_cases is empty/);
    expect(p).toMatch(/TC1 refers to unknown acceptance criterion AC9/);
    expect(p).toMatch(/AC1 has no QA test case/);
  });

  it('not required for questions/too-vague plans, nor for older prompts', () => {
    const blocking = plan({ dev_plan: undefined, qa_plan: undefined, gap_analysis: allFound.map((g) => (g.item === 'example' ? { item: 'example', status: 'missing', source: 'no example', severity: 'blocking', question: 'Which input?', options: ['a', 'b'], default: 'a' } : g)) });
    expect(blocking.readiness).toBe('blocking');
    expect(validatePlan(blocking, ['api'], { requireGapAnalysis: true, requireDevQaPlan: true }).join(' ')).not.toMatch(/dev_plan|qa_plan/);
    expect(validatePlan(plan({ dev_plan: undefined, qa_plan: undefined }), ['api'], { requireGapAnalysis: true })).toEqual([]);
  });

  it('submit_plan: schema requires both halves; a session that requires them refuses a plan without', async () => {
    const schema = TOOL_DEFINITIONS.find((t) => t.name === 'submit_plan')!.inputSchema.properties.plan.properties as Record<string, { required?: string[] }>;
    expect(schema.dev_plan.required).toEqual(['db_changes', 'cache_changes', 'secret_changes', 'infra_changes', 'telemetry_changes']);
    expect(schema.qa_plan.required).toEqual(['test_cases', 'must_not_happen', 'happy_cases']);
    const session = { ticket: 'T2-9', allowedProjects: ['T2'], repos: [{ id: 'api', path: tmp }], components: [], maxToolCalls: 10, resultFile: path.join(tmp, 'r.json'), requireDevQaPlan: true };
    const refused = await new PlannerTools(session).call('submit_plan', { plan: { ...raw, dev_plan: undefined } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/dev_plan is missing/);
    expect((await new PlannerTools(session).call('submit_plan', { plan: raw })).isError).toBeUndefined();
  });
});

describe('Dev plan and QA plan: what the approver and the agents see', () => {
  it('plan text and Jira comment carry both halves as tables, "none" sections with their reason', () => {
    const p = plan();
    const text = renderPlan(p);
    // The team template's order: Dev Plan 1-6, QA Plan 1-4, then everything else.
    const order = ['=== DEV PLAN ===', '1. REPOS TO UPDATE OR CREATE', '2. DATABASES', '3. CACHE KEYS', '4. SECRETS MANAGER KEYS', '5. INFRA', '6. ALERTS AND TELEMETRY',
      '=== QA PLAN ===', '1. TEST CASES', '2. MUST NOT HAPPEN', '3. MUST HAPPEN', '4. EDGE CASES', '=== MORE DETAILS ===', 'ACCEPTANCE CRITERIA', 'READINESS CHECKLIST'];
    const at = order.map((h) => text.indexOf(h));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toMatch(/2\. DATABASES \(change summary per table\)\n\s+- payments\.transactions \[add_column\]/);
    expect(text).toMatch(/3\. CACHE KEYS \(change summary per key\)\n\s+- none: getClientIp reads request headers only/);
    expect(text).toMatch(/2\. MUST NOT HAPPEN \(constraints\)\n\s+N1 A real IPv6 address/);
    const adf = JSON.stringify(planCommentAdf(p, { readyLabel: 'AI Planning', approvedLabel: 'AI Dev', statusMode: true }));
    const adfOrder = ['Dev Plan', '1. Repos to update or create', '2. Databases', '3. Cache keys', '4. Secrets Manager keys', '5. Infra', '6. Alerts and telemetry',
      'QA Plan', '1. Test cases', '2. Must NOT happen', '3. Must happen', '4. Edge cases', 'More details', 'Acceptance criteria'];
    const adfAt = adfOrder.map((h) => adf.indexOf(`"text":"${h}`)); // heading text, not the intro sentence
    expect(adfAt.every((i) => i >= 0)).toBe(true);
    expect([...adfAt].sort((a, b) => a - b)).toEqual(adfAt);
  });

  it('a repo to create is listed in Dev Plan 1 and warned about', () => {
    const p = plan({ dev_plan: { ...devPlan, new_repos: [{ name: 'gb-chatbiz-worker', purpose: 'WhatsApp sender', summary: 'SQS consumer that calls Chatbiz' }] } });
    expect(p.warnings.join(' ')).toMatch(/New repo "gb-chatbiz-worker" must be created by a person/);
    expect(renderPlan(p)).toMatch(/new  gb-chatbiz-worker  \[create, by a person before coding\]/);
    expect(JSON.stringify(planCommentAdf(p, { readyLabel: 'r', approvedLabel: 'a' }))).toMatch(/gb-chatbiz-worker[\s\S]*CREATE/);
    expect(devQaProblems(plan({ dev_plan: { ...devPlan, new_repos: [{ name: 'x' }] } })).join(' ')).toMatch(/new_repos x: say what goes in it/);
  });

  it('the coding and QA agents receive the approved DB/cache/telemetry changes and the must / must-not lists', () => {
    const [wi] = workItemsForCoding(plan(), 'IP fix');
    const a = wi.assumptions!.join('\n');
    expect(a).toMatch(/Approved DB change: payments\.transactions \(add_column\)/);
    expect(a).toMatch(/Telemetry to add: alert payments-ip-unmapped/);
    expect(a).toMatch(/Must NOT happen \(N1\): A real IPv6 address is changed or truncated/);
    expect(a).toMatch(/Must happen \(H1\)/);
  });
});
