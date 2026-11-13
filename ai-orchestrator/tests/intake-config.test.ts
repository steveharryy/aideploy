import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_PIPELINE_CONFIG,
  intakeFor,
  killSwitchOn,
  loadPipelineConfig,
  parsePipelineConfig,
  type PipelineConfig
} from '../src/config/pipeline-config.js';
import { ComponentMap, maxRisk } from '../src/catalog/component-map.js';
import { ServiceCatalog } from '../src/catalog/service-catalog.js';
import { runIntake } from '../src/agents/intake/intake.js';
import { PlanningAgent } from '../src/agents/planning/planning-agent.js';
import { JiraClient } from '../src/integrations/jira/jira-client.js';
import { AutomationWatcher, DEFAULT_LABELS, type PlanOutcome, type WatcherJira } from '../src/automation/watcher.js';
import { normalizePlan } from '../src/agents/planning/plan-rules.js';
import type { ClaudeCodeRunner } from '../src/providers/claude-code-provider.js';
import type { TaskInput } from '../src/models/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const root = path.resolve(__dirname, '..');

const strictIntake: PipelineConfig['intake'] = {
  minDescriptionChars: 50,
  requireProduct: true,
  allowedProducts: ['SportsBull', 'GameBull'],
  requireComponent: true,
  allowedIssueTypes: ['Bug', 'Story'],
  maxStoryPoints: 3,
  assignToReporter: true
};
const map = ComponentMap.parse({
  components: {
    Payouts: { product: 'SportsBull', repos: ['sportsbull-api'], risk_floor: 'high' },
    'Contest UI': { product: 'SportsBull', repos: ['sportsbull-web'], risk_floor: 'medium' }
  }
});
const goodTicket = (meta: Record<string, unknown> = {}, over: Partial<TaskInput> = {}): TaskInput => ({
  id: 'RT-1',
  title: 'Split prize evenly for tied ranks',
  description: 'When two users tie on a rank the prize for that rank must be split evenly between them.',
  acceptanceCriteria: [],
  metadata: { product: 'SportsBull', components: ['Payouts'], issueType: 'Story', storyPoints: 2, ...meta },
  ...over
});

describe('Pipeline config', () => {
  it('maps the YAML keys and keeps defaults for what is missing', () => {
    const cfg = parsePipelineConfig({ kill_switch: true, planning: { max_cost_usd_per_ticket: 2 }, intake: { require_product: true } });
    expect(cfg.killSwitch).toBe(true);
    expect(cfg.planning.maxCostUsdPerTicket).toBe(2);
    expect(cfg.planning.maxQuestionRounds).toBe(DEFAULT_PIPELINE_CONFIG.planning.maxQuestionRounds);
    expect(cfg.intake.requireProduct).toBe(true);
  });

  it('rejects wrong types, "latest" models and malformed field ids', () => {
    expect(() => parsePipelineConfig({ kill_switch: 'yes' })).toThrow(/kill_switch/);
    expect(() => parsePipelineConfig({ planning: { max_tool_calls: -1 } })).toThrow(/max_tool_calls/);
    expect(() => parsePipelineConfig({ planning: { model: 'claude-latest' } })).toThrow(/never "latest"/);
    expect(() => parsePipelineConfig({ jira: { product_field: 'Product' } })).toThrow(/customfield_/);
  });

  it('missing file = defaults; kill switch fails closed on a broken file', () => {
    expect(loadPipelineConfig(path.join(tmp, 'none.yaml')).killSwitch).toBe(false);
    const broken = path.join(tmp, 'broken.yaml');
    fs.writeFileSync(broken, 'kill_switch: maybe\n');
    expect(killSwitchOn(broken, {})).toBe(true);
    const off = path.join(tmp, 'off.yaml');
    fs.writeFileSync(off, 'kill_switch: false\n');
    expect(killSwitchOn(off, {})).toBe(false);
    expect(killSwitchOn(off, { AI_KILL_SWITCH: 'true' })).toBe(true);
  });

  it('the shipped config files are valid and match the catalog', () => {
    const cfg = loadPipelineConfig(path.join(root, 'config/pipeline.yaml'));
    expect(cfg.killSwitch).toBe(false);
    expect(cfg.jira.productField).toMatch(/^customfield_\d+$/);
    const catalog = ServiceCatalog.load(path.join(root, 'catalog/repos.yaml'), path.join(root, 'repositories'))!;
    expect(() => ComponentMap.load(path.join(root, 'config/components.yaml'), catalog.repos.map((r) => r.id))).not.toThrow();
  });
});

describe('Component map', () => {
  it('resolves components case-insensitively, with the highest risk floor and unmapped names', () => {
    const r = map.resolve(['payouts', 'contest ui', 'Devops']);
    expect(r.repos).toEqual(['sportsbull-api', 'sportsbull-web']);
    expect(r.riskFloor).toBe('high');
    expect(r.products).toEqual(['SportsBull']);
    expect(r.unmapped).toEqual(['Devops']);
    expect(map.riskFloorForRepos(['sportsbull-web'])).toBe('medium');
    expect(maxRisk('low', undefined)).toBe('low');
  });

  it('rejects unknown repos, bad risk floors, empty repo lists and duplicates', () => {
    expect(() => ComponentMap.parse({ components: { A: { repos: ['nope'] } } }, ['api'])).toThrow(/not in catalog/);
    expect(() => ComponentMap.parse({ components: { A: { repos: ['api'], risk_floor: 'huge' } } })).toThrow(/risk_floor/);
    expect(() => ComponentMap.parse({ components: { A: { repos: [] } } })).toThrow(/non-empty/);
    expect(() => ComponentMap.parse({ components: { A: { repos: ['x'] }, a: { repos: ['x'] } } })).toThrow(/twice/);
  });
});

describe('Intake checks (no AI)', () => {
  it('a complete ticket passes', () => {
    const r = runIntake(goodTicket(), strictIntake, map);
    expect(r.gaps).toEqual([]);
    expect(r.components.repos).toEqual(['sportsbull-api']);
  });

  it.each([
    ['short description', goodTicket({}, { description: 'fix it' }), /Description is empty or too short/],
    ['no product', goodTicket({ product: undefined }), /Product is not set/],
    ['product not handled', goodTicket({ product: 'Coin' }), /"Coin" is not handled/],
    ['no component', goodTicket({ components: [] }), /No component \(or area label/],
    ['unmapped component', goodTicket({ components: ['Devops'] }), /"Devops" has no repository mapping/],
    ['issue type', goodTicket({ issueType: 'Epic' }), /"Epic" is not handled/],
    ['too large', goodTicket({ storyPoints: 5 }), /5 story points \(max 3\)/]
  ])('flags: %s', (_name, ticket, expected) => {
    expect(runIntake(ticket, strictIntake, map).gaps.join('\n')).toMatch(expected);
  });

  it('written acceptance criteria count toward the description; no estimate passes', () => {
    const ticket = goodTicket({ storyPoints: undefined }, { description: 'Ties', acceptanceCriteria: ['Tied ranks split the prize evenly between users'] });
    expect(runIntake(ticket, strictIntake, map).gaps).toEqual([]);
  });

  it('checks that are switched off do not apply', () => {
    const relaxed = { ...strictIntake, requireProduct: false, requireComponent: false, allowedIssueTypes: [], maxStoryPoints: 0 };
    expect(runIntake(goodTicket({ product: undefined, components: [], issueType: 'Task', storyPoints: 13 }), relaxed, map).gaps).toEqual([]);
  });
});

describe('Planning agent: config limits and risk floor', () => {
  const lowRiskPlan = {
    readiness: 'ready',
    summary: 'Show a tied badge',
    workItems: [{ id: 'W1', repo: 'sportsbull-web', task: 'badge', confidence: 'high' }],
    acceptanceCriteria: [{ id: 'AC1', text: 'Badge shows for ties', verify: 'human', workItem: 'W1' }],
    risk: 'low'
  };
  const runner = (calls: string[][]): ClaudeCodeRunner => async ({ args }) => {
    calls.push(args);
    return JSON.stringify({ subtype: 'success', result: JSON.stringify(lowRiskPlan), total_cost_usd: 0.12 });
  };
  const repos = [{ id: 'sportsbull-web', path: tmp }];

  it('raises risk to the component floor, passes the cost cap, and reports cost', async () => {
    const calls: string[][] = [];
    const agent = new PlanningAgent({ repos, runner: runner(calls), maxBudgetUsd: 5, hardChecks: () => [] });
    const ui = goodTicket({}, { title: 'Show tie badge', description: 'Show a small "Tied" badge next to users who share a rank on the leaderboard.' });
    const result = await agent.plan(ui, { riskFloorForRepos: (r) => map.riskFloorForRepos(r) });
    expect(result.plan.risk).toBe('medium');
    expect(result.plan.riskReason).toMatch(/component map/);
    expect(calls[0].slice(calls[0].indexOf('--max-budget-usd'), calls[0].indexOf('--max-budget-usd') + 2)).toEqual(['--max-budget-usd', '5']);
    expect(result.costUsd).toBe(0.12);
  });

  it('intake gaps stop the run before the model', async () => {
    const calls: string[][] = [];
    const agent = new PlanningAgent({ repos, runner: runner(calls), hardChecks: (t) => runIntake(t, strictIntake, map).gaps });
    const result = await agent.plan(goodTicket({ product: undefined }));
    expect(calls).toHaveLength(0);
    expect(result.plan.readiness).toBe('too_vague');
    expect(result.plan.missingForReporter.join(' ')).toMatch(/Product is not set/);
  });
});

describe('Jira client: Product, story points, assign', () => {
  it('maps the configured custom fields and assigns by account id', async () => {
    const requests: Array<{ url: string; method?: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      requests.push({ url, method: init.method, body: init.body as string });
      if (init.method === 'PUT') return new Response(null, { status: 204 });
      return new Response(
        JSON.stringify({
          key: 'RT-1',
          fields: { summary: 's', customfield_10224: { value: 'SportsBull' }, customfield_10070: 2, reporter: { displayName: 'R', accountId: 'acc-1' } }
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const jira = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a', apiToken: 't', productField: 'customfield_10224', storyPointsField: 'customfield_10070', fetchImpl });
    const task = await jira.getTask('RT-1');
    expect(task.metadata).toMatchObject({ product: 'SportsBull', storyPoints: 2, reporter: { accountId: 'acc-1' } });
    expect(decodeURIComponent(requests[0].url)).toContain('customfield_10224,customfield_10070');
    await jira.assign('RT-1', 'acc-1');
    expect(requests[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ accountId: 'acc-1' }) });
    expect(requests[1].url).toMatch(/\/issue\/RT-1\/assignee$/);
  });
});

describe('Watcher: kill switch, send back to reporter, revision limit', () => {
  const L = DEFAULT_LABELS;
  class FakeJira implements WatcherJira {
    searches = 0;
    assigned: string[] = [];
    comments: string[][] = [];
    labelOps: Array<{ add: string[]; remove: string[] }> = [];
    constructor(public tickets: TaskInput[]) {}
    async searchTasks() { this.searches++; return this.tickets; }
    async getTask(key: string) { return { ...this.tickets.find((t) => t.id === key)! }; }
    async addComment(_k: string, lines: string[]) { this.comments.push(lines); }
    async updateLabels(_k: string, add: string[] = [], remove: string[] = []) { this.labelOps.push({ add, remove }); }
    async transition() { return true; }
    async getLabelAdder() { return 'Lead'; }
    async assign(_k: string, accountId: string) { this.assigned.push(accountId); }
  }
  const ticket = goodTicket({ labels: [L.ready], reporter: { name: 'R', accountId: 'acc-9' } });

  function setup(outcome: () => PlanOutcome, opts: { kill?: boolean; maxPlanRevisions?: number } = {}) {
    const jira = new FakeJira([ticket]);
    let plans = 0;
    const watcher = new AutomationWatcher(
      { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, assignToReporter: true, maxPlanRevisions: opts.maxPlanRevisions },
      {
        jira,
        jobsDir: fs.mkdtempSync(path.join(tmp, 'jobs-')),
        log: () => {},
        attempts: () => 0,
        killSwitch: () => !!opts.kill,
        plan: async () => { plans++; return outcome(); },
        implement: async () => { throw new Error('no'); },
        publish: async () => ({ links: [], skipped: [] })
      }
    );
    return { watcher, jira, plans: () => plans };
  }

  it('kill switch: no Jira search, no planning, ticket runs report "skipped"', async () => {
    const { watcher, jira, plans } = setup(() => ({ status: 'ready', repos: [], plans: {}, text: '' }), { kill: true });
    expect((await watcher.runOnce()).checked).toBe(0);
    expect(jira.searches).toBe(0);
    expect(await watcher.runTicket('RT-1')).toEqual({ action: 'skipped', detail: 'kill switch on' });
    expect(plans()).toBe(0);
  });

  it('too vague: comment, ai-needs-info, and assigned back to the reporter', async () => {
    const vague = normalizePlan({ readiness: 'too_vague', missingForReporter: ['Product is not set.'] }, 'RT-1');
    const { watcher, jira } = setup(() => ({ status: 'needs-info', repos: [], plans: {}, text: '', ticketPlan: vague }));
    await watcher.runOnce();
    expect(jira.comments[0].join('\n')).toContain('Product is not set.');
    expect(jira.labelOps[0]).toEqual({ add: [], remove: [L.ready] });
    expect(watcher.sessions.get('RT-1')?.phase).toBe('needs_info');
    expect(jira.assigned).toEqual(['acc-9']);
  });

  it('plan versions count up on each revision and stop after the limit', async () => {
    const ready = normalizePlan(
      { readiness: 'ready', workItems: [{ id: 'W1', repo: 'sportsbull-api', task: 't' }], acceptanceCriteria: [{ id: 'AC1', text: 'x', verify: 'unit_test' }] },
      'RT-1'
    );
    const { watcher, jira, plans } = setup(() => ({ status: 'ready', repos: ['sportsbull-api'], plans: {}, text: 'PLAN', ticketPlan: ready }), { maxPlanRevisions: 1 });
    await watcher.runOnce(); // v1
    expect(watcher.readPlan('RT-1')?.version).toBe(1);
    await watcher.runOnce(); // reviewer asked for changes → v2
    expect(watcher.readPlan('RT-1')?.version).toBe(2);
    const jobDir = path.dirname((watcher as unknown as { planFile(t: string): string }).planFile('RT-1'));
    expect(JSON.parse(fs.readFileSync(path.join(jobDir, 'plan.v1.json'), 'utf-8')).version).toBe(1); // v1 kept
    expect(jira.comments[1].join('\n')).toContain('v2 (revised)');
    const r = await watcher.runOnce(); // v3 would exceed 1 revision
    expect(r.actions[0].action).toBe('needs-info');
    expect(plans()).toBe(2);
    expect(jira.assigned).toEqual(['acc-9']);
  });
});

describe('Session store (phase lives in our store, not in Jira labels)', () => {
  it('records phases with history, lists newest first, and writes atomically', async () => {
    const { FileSessionStore } = await import('../src/jobs/session-store.js');
    const dir = fs.mkdtempSync(path.join(tmp, 'sessions-'));
    const store = new FileSessionStore(dir);
    expect(store.get('RT-1')).toBeUndefined();
    store.setPhase('RT-1', 'planning');
    const s = store.setPhase('RT-1', 'needs_input', 'round 1: 2 question(s)');
    expect(s.phase).toBe('needs_input');
    expect(s.history.map((h) => h.phase)).toEqual(['planning', 'needs_input']);
    expect(s.createdAt <= s.updatedAt).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    store.setPhase('RT-2', 'plan_review');
    expect(store.list().map((x) => x.ticket)).toEqual(['RT-2', 'RT-1']);
    expect(fs.readdirSync(path.join(dir, 'RT-1'))).toEqual(['session.json']); // no leftover temp file
  });

  it('config maps phases to existing Jira statuses per project, and rejects unknown phases', () => {
    const cfg = parsePipelineConfig({ jira: { move_status: true, phase_status: { rt: { plan_review: 'Pending Approval', done: '' } } } });
    expect(cfg.jira.moveStatus).toBe(true);
    expect(cfg.jira.phaseStatus).toEqual({ RT: { plan_review: 'Pending Approval' } });
    expect(() => parsePipelineConfig({ jira: { phase_status: { RT: { reviewing: 'X' } } } })).toThrow(/not a phase/);
    const shipped = loadPipelineConfig(path.join(root, 'config/pipeline.yaml'));
    expect(shipped.jira.moveStatus).toBe(false); // off until the team agrees the mapping
    expect(shipped.jira.phaseStatus.RT.plan_review).toBe('Pending Approval');
  });
});

describe('Targeting T2: per-project intake and area labels', () => {
  it('T2 uses its own intake rules; other projects keep the defaults', () => {
    const cfg = loadPipelineConfig(path.join(root, 'config/pipeline.yaml'));
    const t2 = intakeFor(cfg, 'T2-547');
    expect(t2).toMatchObject({ requireProduct: false, requireComponent: false, allowedIssueTypes: ['Story', 'Task', 'Bug'] });
    expect(intakeFor(cfg, 'RT-1')).toMatchObject({ requireProduct: true, requireComponent: true });
    expect(cfg.planning.allowedJiraProjects).toEqual(['T2']);
  });

  it('a T2-style ticket (no Product, no component) passes T2 intake, but Request Tasks do not', () => {
    const cfg = loadPipelineConfig(path.join(root, 'config/pipeline.yaml'));
    const t2Ticket = goodTicket({ product: undefined, components: [], labels: ['coin-sportsbook'], issueType: 'Task' }, { id: 'T2-9' });
    expect(runIntake(t2Ticket, intakeFor(cfg, 'T2-9'), map).gaps).toEqual([]);
    const request = goodTicket({ product: undefined, components: [], issueType: 'Request Tasks' }, { id: 'T2-10' });
    expect(runIntake(request, intakeFor(cfg, 'T2-10'), map).gaps.join(' ')).toMatch(/"Request Tasks" is not handled/);
  });

  it('area labels map to repos like components; unknown labels are ignored', () => {
    const labelMap = ComponentMap.parse({ components: { 'coin-sportsbook': { repos: ['sportsbook-api'], risk_floor: 'high' } } });
    const r = labelMap.resolveTicket([], ['frontend', 'Coin-Sportsbook', 'P1']);
    expect(r.repos).toEqual(['sportsbook-api']);
    expect(r.riskFloor).toBe('high');
    expect(r.unmapped).toEqual([]); // labels never count as unmapped
    const strict = { ...strictIntake, requireProduct: false };
    expect(runIntake(goodTicket({ product: undefined, components: [], labels: ['coin-sportsbook'] }), strict, labelMap).gaps).toEqual([]);
  });
});
