import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PlanningAgent, extractJson } from '../src/agents/planning/planning-agent.js';
import {
  applyRiskFloor,
  codingBrief,
  hardChecks,
  normalizePlan,
  PlanParseError,
  repoDependencies,
  touchesMoney,
  validatePlan
} from '../src/agents/planning/plan-rules.js';
import { renderMissing, renderPlan, renderQuestions } from '../src/agents/planning/render.js';
import { ImpactAnalysisAgent } from '../src/agents/impact-analysis/agent.js';
import { AutomationWatcher, DEFAULT_LABELS, type PlanOutcome, type WatcherJira } from '../src/automation/watcher.js';
import type { ClaudeCodeRunner } from '../src/providers/claude-code-provider.js';
import type { TaskInput } from '../src/models/types.js';
import type { TicketPlan } from '../src/agents/planning/types.js';

// No Claude, Jira or git calls: the CLI runner and Jira are faked.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planning-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const repoDir = (id: string) => {
  const d = path.join(tmp, id);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const task = (over: Partial<TaskInput> = {}): TaskInput => ({
  id: 'T2-900',
  title: 'Split prize evenly for tied ranks',
  description: 'When two users tie on rank, the prize for that rank must be split evenly between them.',
  acceptanceCriteria: ['Tied ranks split the prize evenly'],
  metadata: { labels: [], comments: [] },
  ...over
});

const readyJson = {
  summary: 'Split prize for tied ranks',
  readiness: 'ready',
  assumptions: ['Rounding down to 2 decimals'],
  questions: [],
  contract: [],
  workItems: [
    { id: 'W1', repo: 'api', task: 'Tie split in payout calc', reason: 'src/payout.ts', confidence: 'high', dependsOn: [], filesLikelyTouched: ['src/payout.ts'], approach: ['add tie grouping'] }
  ],
  acceptanceCriteria: [{ id: 'AC1', text: 'Tied ranks split evenly', verify: 'unit_test', workItem: 'W1', source: 'ticket' }],
  testPlan: [{ ac: 'AC1', workItem: 'W1', name: 'test_AC1_tie_split', cases: ['2 tied users, prize 100 → 50 each'] }],
  risk: 'low',
  riskReason: 'small change',
  outOfScope: ['mobile app']
};

const fakeRunner = (answer: unknown, calls: Array<Parameters<ClaudeCodeRunner>[0]> = []): ClaudeCodeRunner => async (input) => {
  calls.push(input);
  return JSON.stringify({ type: 'result', subtype: 'success', result: typeof answer === 'string' ? answer : JSON.stringify(answer), num_turns: 3 });
};

describe('Planning: hard checks (no AI)', () => {
  it('passes a ticket with a real description', () => {
    expect(hardChecks(task())).toEqual([]);
  });
  it('flags an empty description with no acceptance criteria', () => {
    const gaps = hardChecks(task({ description: 'Split prize evenly for tied ranks', acceptanceCriteria: [] }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/description is empty or too short/);
  });
  it('accepts a short description when acceptance criteria exist', () => {
    expect(hardChecks(task({ description: 'fix', acceptanceCriteria: ['GET /x returns 200'] }))).toEqual([]);
  });
});

describe('Planning: normalising the model answer', () => {
  it('accepts snake_case keys and fills single-work-item links', () => {
    const plan = normalizePlan(
      {
        readiness: 'ready',
        work_items: [{ id: 'W1', repo: 'api', task: 't', depends_on: [] }],
        acceptance_criteria: [{ id: 'AC1', text: 'x', verify: 'unit test' }],
        test_plan: [{ ac: 'AC1', name: 'test_AC1' }]
      },
      'T2-1'
    );
    expect(plan.workItems[0].repo).toBe('api');
    expect(plan.acceptanceCriteria[0]).toMatchObject({ workItem: 'W1', verify: 'unit_test', source: 'derived' });
    expect(plan.testPlan[0].workItem).toBe('W1');
  });

  it('turns "ready" with questions into "blocking" (code decides, not the model)', () => {
    const plan = normalizePlan({ ...readyJson, questions: [{ text: 'Which product?', options: ['SportsBull', 'All'] }] }, 'T2-1');
    expect(plan.readiness).toBe('blocking');
    expect(plan.questions[0].id).toBe('Q1');
  });

  it('turns "blocking" without questions into "too_vague"', () => {
    const plan = normalizePlan({ readiness: 'blocking', questions: [] }, 'T2-1');
    expect(plan.readiness).toBe('too_vague');
    expect(plan.missingForReporter.length).toBeGreaterThan(0);
  });

  it('rejects an answer with no valid readiness', () => {
    expect(() => normalizePlan({ summary: 'x' }, 'T2-1')).toThrow(PlanParseError);
  });

  it('extracts JSON from fenced or prose-wrapped answers', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Plan follows {"a":2} done')).toEqual({ a: 2 });
    expect(extractJson('no json')).toBeUndefined();
  });
});

describe('Planning: validation and policy', () => {
  const ready = (over: Partial<TicketPlan> = {}): TicketPlan => ({ ...normalizePlan(readyJson, 'T2-1'), ...over });

  it('a correct single-repo plan has no problems', () => {
    expect(validatePlan(ready(), ['api'])).toEqual([]);
  });

  it('flags repos outside the catalog', () => {
    expect(validatePlan(ready(), ['web']).join(' ')).toMatch(/"api", which is not in the service catalog/);
  });

  it('flags dependency cycles, unknown deps, uncovered work items and a missing contract', () => {
    const plan = ready({
      workItems: [
        { ...ready().workItems[0], id: 'W1', repo: 'api', dependsOn: ['W2'] },
        { ...ready().workItems[0], id: 'W2', repo: 'web', dependsOn: ['W1', 'W9'] }
      ]
    });
    const problems = validatePlan(plan, ['api', 'web']).join('\n');
    expect(problems).toMatch(/cycle/);
    expect(problems).toMatch(/unknown work item W9/);
    expect(problems).toMatch(/W2 \(web\) has no acceptance criterion/);
    expect(problems).toMatch(/no shared contract/);
  });

  it('raises low risk to medium when money is involved', () => {
    expect(touchesMoney('fix the payout for tied ranks')).toEqual(['payout']);
    expect(touchesMoney('payload size')).toEqual([]);
    const plan = applyRiskFloor(ready({ risk: 'low' }), task({ title: 'Fix wallet balance after refund' }));
    expect(plan.risk).toBe('medium');
    expect(plan.riskReason).toMatch(/wallet/);
  });

  it('derives repo order and the per-repo coding brief from work items', () => {
    const plan = ready({
      contract: ['GET /payouts adds tie: bool'],
      workItems: [ready().workItems[0], { ...ready().workItems[0], id: 'W2', repo: 'web', dependsOn: ['W1'] }],
      acceptanceCriteria: [ready().acceptanceCriteria[0], { id: 'AC2', text: 'badge shows', verify: 'human', workItem: 'W2', source: 'derived' }]
    });
    expect(repoDependencies(plan)).toEqual({ api: [], web: ['api'] });
    const brief = codingBrief(plan, 'web')!;
    expect((brief.workItem as { id: string }).id).toBe('W2');
    expect(brief.acceptanceCriteria).toEqual([plan.acceptanceCriteria[1]]);
    expect(brief.contract).toEqual(['GET /payouts adds tie: bool']);
    expect(codingBrief(plan, 'other')).toBeUndefined();
  });
});

describe('PlanningAgent', () => {
  const repos = [
    { id: 'api', name: 'API', purpose: 'payouts', path: repoDir('api'), keywords: ['payout'], verify: ['npm test'] },
    { id: 'web', path: path.join(tmp, 'missing-web') }
  ];

  it('stops on the hard checks without calling Claude', async () => {
    const calls: Array<Parameters<ClaudeCodeRunner>[0]> = [];
    const agent = new PlanningAgent({ repos, runner: fakeRunner(readyJson, calls) });
    const result = await agent.plan(task({ description: '', acceptanceCriteria: [] }));
    expect(calls).toHaveLength(0);
    expect(result.modelCalled).toBe(false);
    expect(result.plan.readiness).toBe('too_vague');
  });

  it('runs Claude Code read-only over the catalog repos that exist on disk', async () => {
    const calls: Array<Parameters<ClaudeCodeRunner>[0]> = [];
    const agent = new PlanningAgent({ repos, runner: fakeRunner(readyJson, calls) });
    const result = await agent.plan(task(), { candidateRepos: ['api'] });

    expect(result.plan.readiness).toBe('ready');
    expect(result.problems).toEqual([]);
    expect(result.plan.risk).toBe('medium'); // "prize" → policy floor
    const args = calls[0].args;
    expect(args).toContain('--add-dir');
    expect(args).toContain(repos[0].path);
    expect(args).not.toContain(repos[1].path); // not on disk
    const disallowed = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--allowedTools'));
    expect(disallowed).toEqual(expect.arrayContaining(['Edit', 'Write', 'Bash']));
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['Read', 'Glob', 'Grep']);
    expect(calls[0].env.JIRA_API_TOKEN).toBeUndefined();
  });

  it('prompt carries ticket context, catalog, hints and earlier questions', () => {
    const agent = new PlanningAgent({ repos, runner: fakeRunner(readyJson) });
    const prompt = agent.buildPrompt(
      task({
        metadata: {
          labels: ['payouts'],
          parent: { key: 'T2-800', summary: 'Contest epic' },
          links: [{ key: 'T2-801', relation: 'blocks', summary: 'Leaderboard', status: 'Done' }],
          comments: [{ author: 'Ravi', created: '2026-11-12T10:00', body: 'Q1: A' }]
        }
      }),
      { candidateRepos: ['api'], previousQuestions: [{ id: 'Q1', text: 'How to split?', options: ['Evenly', 'First entry wins'] }] }
    );
    expect(prompt).toContain('Parent: T2-800 Contest epic');
    expect(prompt).toContain('blocks T2-801: Leaderboard [Done]');
    expect(prompt).toContain('Ravi: Q1: A');
    expect(prompt).toContain('- id: api (API)');
    expect(prompt).toContain('NOT on disk');
    expect(prompt).toContain('Suggested repos: api');
    expect(prompt).toContain('Q1. How to split?');
    expect(prompt).toMatch(/always blocking/);
  });

  it('reports structural problems instead of passing a broken plan', async () => {
    const agent = new PlanningAgent({ repos, runner: fakeRunner({ ...readyJson, workItems: [{ ...readyJson.workItems[0], repo: 'unknown' }] }) });
    const result = await agent.plan(task());
    expect(result.problems.join(' ')).toMatch(/not in the service catalog/);
  });

  it('fails clearly when the answer is not JSON', async () => {
    const agent = new PlanningAgent({ repos, runner: fakeRunner('I think we should...') });
    await expect(agent.plan(task())).rejects.toThrow(/not JSON/);
  });
});

describe('Planning: rendering', () => {
  const plan = normalizePlan({ ...readyJson, questions: [{ id: 'Q1', text: 'Which product?', options: ['SportsBull', 'All'], defaultOption: 'SportsBull' }] }, 'T2-1');
  it('plan text shows work items, ACs with verify method, tests and assumptions', () => {
    const text = renderPlan(normalizePlan(readyJson, 'T2-1'));
    expect(text).toContain('W1  api  [update · confidence high]');
    expect(text).toMatch(/=== DEV PLAN ===\n1\. REPOS TO UPDATE OR CREATE/);
    expect(text).toContain('AC1 [W1] Tied ranks split evenly');
    expect(text).toContain('verify: unit_test');
    expect(text).toContain('test_AC1_tie_split');
    expect(text).toContain('Rounding down to 2 decimals');
  });
  it('questions come with options, the default, and how to answer', () => {
    const lines = renderQuestions(plan, 'ai-ready', 1, 2).join('\n');
    expect(lines).toContain('round 1 of 2');
    expect(lines).toContain('A) SportsBull  (default)');
    expect(lines).toContain('add the label "ai-ready" again');
  });
  it('missing-info message lists what to add', () => {
    expect(renderMissing({ ...plan, missingForReporter: ['Expected behaviour'] }, 'ai-ready').join('\n')).toContain('- Expected behaviour');
  });
});

describe('Approved plan drives the coding phase', () => {
  it('impact analysis uses the approved repos instead of keyword routing', async () => {
    const impact = await new ImpactAnalysisAgent().analyze(task({ metadata: { approvedRepos: ['web'] } }));
    expect(impact.affectedRepositories).toEqual(['web']);
    expect(impact.confidence).toBe(1);
  });
});

describe('AutomationWatcher: planning outcomes', () => {
  const L = DEFAULT_LABELS;
  class FakeJira implements WatcherJira {
    comments: Array<{ key: string; lines: string[] }> = [];
    labelOps: Array<{ add: string[]; remove: string[] }> = [];
    constructor(public tickets: TaskInput[]) {}
    async searchTasks() { return this.tickets; }
    async getTask(key: string) { return { ...this.tickets.find((t) => t.id === key)! }; }
    async addComment(key: string, lines: string[]) { this.comments.push({ key, lines }); }
    async updateLabels(_key: string, add: string[] = [], remove: string[] = []) { this.labelOps.push({ add, remove }); }
    async transition() { return true; }
    async getLabelAdder() { return 'Lead'; }
  }

  const blocking = normalizePlan({ readiness: 'blocking', questions: [{ id: 'Q1', text: 'Which product?', options: ['SportsBull', 'All'] }] }, 'T2-5');
  const vague = normalizePlan({ readiness: 'too_vague', missingForReporter: ['Expected behaviour'] }, 'T2-5');

  function setup(outcome: PlanOutcome) {
    const jobsDir = fs.mkdtempSync(path.join(tmp, 'jobs-'));
    const jira = new FakeJira([task({ id: 'T2-5', metadata: { labels: [L.ready] } })]);
    const seen: TaskInput[] = [];
    const watcher = new AutomationWatcher(
      { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, maxQuestionRounds: 2 },
      {
        jira,
        jobsDir,
        log: () => {},
        attempts: () => 0,
        plan: async (t) => {
          seen.push(structuredClone(t));
          return outcome;
        },
        implement: async () => { throw new Error('must not implement'); },
        publish: async () => ({ links: [], skipped: [] })
      }
    );
    return { watcher, jira, seen };
  }

  it('blocking → posts the questions, labels ai-needs-input, and passes them back on the next round', async () => {
    const { watcher, jira, seen } = setup({ status: 'needs-input', repos: [], plans: {}, text: '', ticketPlan: blocking });

    const r1 = await watcher.runOnce();
    expect(r1.actions[0].action).toBe('needs-input');
    expect(jira.comments[0].lines.join('\n')).toContain('Q1. Which product?');
    expect(jira.labelOps[0]).toEqual({ add: [], remove: [L.ready] });
    expect(watcher.sessions.get('T2-5')?.phase).toBe('needs_input');
    expect(watcher.readQuestionState('T2-5').rounds).toBe(1);

    await watcher.runOnce(); // human answered and re-added ai-ready
    expect((seen[1].metadata?.previousQuestions as Array<{ id: string }>)[0].id).toBe('Q1');
    expect(watcher.readQuestionState('T2-5').rounds).toBe(2);

    const r3 = await watcher.runOnce(); // still blocking after 2 rounds → back to reporter
    expect(r3.actions[0].action).toBe('needs-info');
    expect(jira.comments[2].lines.join('\n')).toMatch(/Still unclear after 2 round/);
    expect(watcher.sessions.get('T2-5')?.phase).toBe('needs_info');
  });

  it('too vague → asks the reporter for the missing details, labels ai-needs-info', async () => {
    const { watcher, jira } = setup({ status: 'needs-info', repos: [], plans: {}, text: '', ticketPlan: vague });
    const r = await watcher.runOnce();
    expect(r.actions[0].action).toBe('needs-info');
    expect(jira.comments[0].lines.join('\n')).toContain('- Expected behaviour');
    expect(jira.labelOps[0]).toEqual({ add: [], remove: [L.ready] });
    expect(watcher.sessions.get('T2-5')?.phase).toBe('needs_info');
  });

  it('ready → saves the structured plan with repos and order for the coding phase', async () => {
    const ready = normalizePlan(readyJson, 'T2-5');
    const { watcher, jira } = setup({
      status: 'ready',
      repos: ['api'],
      plans: { api: codingBrief(ready, 'api')! },
      text: 'PLAN',
      ticketPlan: ready,
      repoDependencies: { api: [] }
    });
    const r = await watcher.runOnce();
    expect(r.actions[0].action).toBe('planned');
    expect(watcher.sessions.get('T2-5')?.phase).toBe('plan_review');
    const saved = watcher.readPlan('T2-5')!;
    expect(saved.ticketPlan?.workItems[0].repo).toBe('api');
    expect(saved.repoDependencies).toEqual({ api: [] });
  });
});

describe('Planning: spec additions', () => {
  it('a low-confidence repo choice becomes a blocking question', () => {
    const plan = normalizePlan({ ...readyJson, workItems: [{ ...readyJson.workItems[0], confidence: 'low' }] }, 'T2-1');
    expect(plan.readiness).toBe('blocking');
    expect(plan.questions[0].text).toMatch(/Is "api" the right repository/);
  });

  it('clarifications are kept, shown, and handed to the coding agent', () => {
    const plan = normalizePlan({ ...readyJson, clarifications: ['Ties split evenly (Ravi)'] }, 'T2-1');
    expect(renderPlan(plan)).toContain('CLARIFICATIONS');
    expect(codingBrief(plan, 'api')!.clarifications).toEqual(['Ties split evenly (Ravi)']);
  });

  it('prompt includes linked documents, similar tickets and a rejected plan to revise', () => {
    const agent = new PlanningAgent({ repos: [{ id: 'api', path: repoDir('api') }], runner: fakeRunner(readyJson) });
    const prompt = agent.buildPrompt(
      task({
        metadata: {
          documents: [{ title: 'Payout rules', url: 'https://x/wiki/1', text: 'Ties split evenly.' }],
          similarTickets: [{ key: 'T2-100', title: 'Tie handling', status: 'Done' }]
        }
      }),
      { previousPlan: normalizePlan(readyJson, 'T2-900') }
    );
    expect(prompt).toContain('Payout rules (https://x/wiki/1)');
    expect(prompt).toContain('Ties split evenly.');
    expect(prompt).toContain('T2-100 [Done] Tie handling');
    expect(prompt).toContain('<previous_plan>');
  });
});

describe('JiraClient: planning context', () => {
  const make = async (routes: Record<string, unknown>) => {
    const { JiraClient } = await import('../src/integrations/jira/jira-client.js');
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      return new Response(JSON.stringify(key ? routes[key] : { issues: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { client: new JiraClient({ baseUrl: 'https://rosstech.atlassian.net', email: 'a@b.c', apiToken: 't', fetchImpl }), seen };
  };

  it('reads Confluence pages only from the same Atlassian site', async () => {
    const { client, seen } = await make({ '/wiki/api/v2/pages/123': { body: { storage: { value: '<p>Ties <b>split</b> evenly</p><ul><li>one</li></ul>' } } } });
    expect(await client.getConfluencePageText('https://rosstech.atlassian.net/wiki/spaces/RT/pages/123/Payouts')).toBe('Ties split evenly\n- one');
    expect(await client.getConfluencePageText('https://evil.example.com/wiki/spaces/RT/pages/123')).toBeUndefined();
    expect(seen.every((u) => u.startsWith('https://rosstech.atlassian.net/'))).toBe(true);
  });

  it('enriches a task with linked documents and similar tickets, and never throws', async () => {
    const { client, seen } = await make({
      '/remotelink': [{ object: { title: 'Payout rules', url: 'https://rosstech.atlassian.net/wiki/spaces/RT/pages/9/x' } }],
      '/wiki/api/v2/pages/9': { body: { storage: { value: '<p>Rule text</p>' } } },
      '/search': { issues: [{ key: 'T2-100', fields: { summary: 'Prize tie handling', description: 'old', status: { name: 'Done' } } }] }
    });
    const enriched = await client.enrichForPlanning(task());
    expect(enriched.metadata?.documents).toEqual([{ title: 'Payout rules', url: 'https://rosstech.atlassian.net/wiki/spaces/RT/pages/9/x', text: 'Rule text' }]);
    expect((enriched.metadata?.similarTickets as Array<{ key: string }>)[0].key).toBe('T2-100');
    expect(decodeURIComponent(seen.find((u) => u.includes('/search'))! + '')).not.toContain('key != T2-900 AND text ~ ""');

    const broken = new (await import('../src/integrations/jira/jira-client.js')).JiraClient({
      baseUrl: 'https://rosstech.atlassian.net', email: 'a', apiToken: 't',
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch
    });
    await expect(broken.enrichForPlanning(task())).resolves.toMatchObject({ id: 'T2-900' });
  });
});

describe('Planning: repo must be readable', () => {
  it('a "ready" plan for a repo that is not on disk is not approvable', async () => {
    const agent = new PlanningAgent({
      repos: [{ id: 'api', path: path.join(tmp, 'not-cloned') }],
      runner: fakeRunner(readyJson)
    });
    const result = await agent.plan(task());
    expect(result.problems.join(' ')).toMatch(/"api" is not on disk/);
  });
});

describe('Planning: warning when the agent overrides the component map', () => {
  const repos = [
    { id: 'api', path: repoDir('api') },
    { id: 'web', path: repoDir('web') }
  ];
  const agent = () => new PlanningAgent({ repos, runner: fakeRunner({ ...readyJson, warnings: ['model-made warning'] }) });

  it('warns (but stays approvable) when a chosen repo is not in the component map', async () => {
    const result = await agent().plan(task(), { componentRepos: ['web'] });
    expect(result.plan.readiness).toBe('ready');
    expect(result.problems).toEqual([]);
    expect(result.plan.warnings).toHaveLength(1);
    expect(result.plan.warnings[0]).toMatch(/W1 uses "api", but the ticket's component map points to "web"/);
    expect(result.plan.warnings[0]).toContain("Agent's reason: src/payout.ts");
    expect(renderPlan(result.plan)).toContain('⚠ WARNING: W1 uses "api"');
  });

  it('no warning when the plan matches the map, or when there is no map; the model cannot add warnings', async () => {
    expect((await agent().plan(task(), { componentRepos: ['api', 'web'] })).plan.warnings).toEqual([]);
    expect((await agent().plan(task())).plan.warnings).toEqual([]);
  });

  it('the Jira plan comment calls the warning out before the approve instructions', async () => {
    const L = DEFAULT_LABELS;
    const plan = { ...normalizePlan(readyJson, 'T2-7'), warnings: ['W1 uses "api", but the map points to "web".'] };
    const comments: string[][] = [];
    const jira: WatcherJira = {
      searchTasks: async () => [task({ id: 'T2-7', metadata: { labels: [L.ready] } })],
      getTask: async () => task({ id: 'T2-7' }),
      addComment: async (_k, lines) => void comments.push(lines),
      updateLabels: async () => {},
      transition: async () => true,
      getLabelAdder: async () => 'x'
    };
    const watcher = new AutomationWatcher(
      { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false },
      {
        jira,
        jobsDir: fs.mkdtempSync(path.join(tmp, 'jobs-')),
        log: () => {},
        attempts: () => 0,
        plan: async () => ({ status: 'ready', repos: ['api'], plans: {}, text: 'PLAN', ticketPlan: plan }),
        implement: async () => { throw new Error('no'); },
        publish: async () => ({ links: [], skipped: [] })
      }
    );
    await watcher.runOnce();
    const text = comments[0].join('\n');
    expect(text).toContain('⚠ 1 warning(s) in this plan');
    expect(text.indexOf('⚠ W1 uses "api"')).toBeLessThan(text.indexOf('To approve'));
  });
});

describe('Finding missing information: the decision rule (code, not the model)', () => {
  const items = ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'];
  const found = items.map((item) => ({ item, status: 'found', source: 'description' }));
  const gaps = (...replace: Array<Record<string, unknown>>) => found.map((g) => replace.find((r) => r.item === g.item) ?? g);
  const plan = (gap_analysis: unknown[], edge_cases: unknown[] = [], over: Record<string, unknown> = {}) =>
    normalizePlan({ ...readyJson, readiness: 'ready', gap_analysis, edge_cases, ...over }, 'T2-1');

  it.each(['expected_behaviour', 'product'])('%s not found → too_vague (either one is enough)', (item) => {
    const p = plan(gaps({ item, status: 'missing', source: 'not in the ticket', severity: 'blocking' }));
    expect(p.readiness).toBe('too_vague');
    expect(p.questions).toEqual([]);
    expect(p.missingForReporter.join(' ')).toMatch(/not in the ticket/);
  });

  it('a blocking gap on another item → one question per gap, traced to the item', () => {
    const p = plan(gaps({ item: 'scope', status: 'ambiguous', source: 'mobile?', severity: 'blocking', question: 'Mobile too?', options: ['Web only', 'Web and mobile'], default: 'Web only' }));
    expect(p.readiness).toBe('blocking');
    expect(p.questions).toEqual([{ id: 'Q1', text: 'Mobile too?', options: ['Web only', 'Web and mobile'], defaultOption: 'Web only', from: 'scope' }]);
  });

  it('an unclear edge case → a question traced to the edge case', () => {
    const p = plan(found, [{ id: 'EC2', case: 'paise remainder', source: 'generic', status: 'unclear', question: 'Who gets the remainder?', options: ['House', 'Rank 1'], default: 'House' }]);
    expect(p.readiness).toBe('blocking');
    expect(p.questions[0]).toMatchObject({ text: 'Who gets the remainder?', from: 'EC2' });
  });

  it('only minor gaps and safe defaults → ready, all of them listed as assumptions', () => {
    const p = plan(
      gaps({ item: 'example', status: 'missing', source: 'no example', severity: 'minor', assumption: 'use the 2-way tie from AC1' }),
      [{ id: 'EC3', case: 'empty leaderboard', source: 'generic', status: 'safe_default', note: 'no payout' }]
    );
    expect(p.readiness).toBe('ready');
    expect(p.assumptions).toEqual(expect.arrayContaining(['Example: use the 2-way tie from AC1', 'EC3 empty leaderboard: no payout']));
  });

  it("the model's own verdict is ignored when there is a gap analysis; an unrated gap counts as blocking", () => {
    const p = plan(gaps({ item: 'verification', status: 'ambiguous', source: 'how to check?', question: 'QA check or unit test?', options: ['QA', 'Unit'], default: 'Unit' }), [], { readiness: 'ready' });
    expect(p.readiness).toBe('blocking');
    expect(p.gapAnalysis.find((g) => g.item === 'verification')?.severity).toBe('blocking');
  });

  it('the same analysis always gives the same decision', () => {
    const input = gaps({ item: 'scope', status: 'missing', source: 'x', severity: 'blocking', question: 'q', options: ['a', 'b'], default: 'a' });
    expect(plan(input)).toEqual(plan(input));
  });

  it('an incomplete or inconsistent analysis is a problem whatever the verdict', () => {
    const missingItems = plan(found.slice(2));
    expect(validatePlan(missingItems, ['api']).join(' ')).toMatch(/no entry for: expected_behaviour, current_behaviour/);
    const minorNoAssumption = plan(gaps({ item: 'example', status: 'missing', source: 'none', severity: 'minor' }));
    expect(validatePlan(minorNoAssumption, ['api']).join(' ')).toMatch(/example is minor but has no "assumption"/);
    const blockingVague = plan(gaps({ item: 'product', status: 'missing', source: '' }), [], { gap_analysis: [...found.slice(0, 6)] });
    expect(validatePlan(blockingVague, ['api']).join(' ')).toMatch(/no entry for: verification/);
  });

  it('a handled edge case must point to a real test in test_plan', () => {
    const p = plan(found, [{ id: 'EC1', case: '3-way tie', source: 'domain', status: 'handled', test: 'test_AC1_nope' }]);
    expect(validatePlan(p, ['api']).join(' ')).toMatch(/EC1 \(3-way tie\) is marked handled but its test "test_AC1_nope" is not in test_plan/);
    const ok = plan(found, [{ id: 'EC1', case: '3-way tie', source: 'domain', status: 'handled', test: 'test_AC1_tie_split' }]);
    expect(validatePlan(ok, ['api'])).toEqual([]);
  });

  it('the plan text shows the checklist, the edge cases and where each question came from', () => {
    const p = plan(
      gaps({ item: 'scope', status: 'ambiguous', source: 'mobile?', severity: 'blocking', question: 'Mobile too?', options: ['Web', 'Both'], default: 'Web' }),
      [
        { id: 'EC1', case: '3-way tie', source: 'domain', status: 'handled', test: 'test_AC1_tie_split' },
        { id: 'EC2', case: 'remainder', source: 'generic', status: 'unclear', question: 'Remainder?', options: ['House', 'Rank 1'], default: 'House' }
      ]
    );
    const text = renderPlan(p);
    expect(text).toContain('READINESS CHECKLIST');
    expect(text).toMatch(/✓ Expected behaviour\s+found\s+description/);
    expect(text).toMatch(/✗ Scope\s+ambiguous mobile\? → Q1/);
    expect(text).toContain('EC1 [domain] 3-way tie → handled → test test_AC1_tie_split');
    expect(text).toContain('EC2 [generic] remainder → unclear → Q2');
    const questions = renderQuestions(p, 'ai-ready', 1, 2).join('\n');
    expect(questions).toContain('Q1. Mobile too?  [Scope]');
    expect(questions).toContain('Q2. Remainder?  [edge case EC2]');
  });
});

describe('Planning: an uncloned repo is a setup problem, not a ticket problem', () => {
  it('flags the missing clone even when the verdict is not "ready"', async () => {
    const blocking = {
      ...readyJson,
      gap_analysis: ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'].map((item) =>
        item === 'scope'
          ? { item, status: 'missing', source: 'x', severity: 'blocking', question: 'q?', options: ['a', 'b'], default: 'a' }
          : { item, status: 'found', source: 'description' }
      )
    };
    const agent = new PlanningAgent({ repos: [{ id: 'api', path: path.join(tmp, 'never-cloned') }], runner: fakeRunner(blocking) });
    const result = await agent.plan(task());
    expect(result.plan.readiness).toBe('blocking');
    expect(result.problems.join(' ')).toMatch(/"api" is not on disk/);
  });
});

describe('Planning: no duplicate questions', () => {
  it('a blocking "edge cases" checklist item is asked through its unclear edge cases only', () => {
    const items = ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'];
    const p = normalizePlan(
      {
        ...readyJson,
        gap_analysis: items.map((item) =>
          item === 'edge_cases'
            ? { item, status: 'ambiguous', source: 'misses not covered', severity: 'blocking', question: 'What on a miss?', options: ['skip', 'null'], default: 'skip' }
            : { item, status: 'found', source: 'description' }
        ),
        edge_cases: [{ id: 'EC3', case: 'key missing', source: 'domain', status: 'unclear', question: 'Missing key: skip or null?', options: ['skip', 'null'], default: 'skip' }]
      },
      'T2-1'
    );
    expect(p.readiness).toBe('blocking');
    expect(p.questions.map((q) => q.from)).toEqual(['EC3']);
    expect(renderPlan(p)).toMatch(/✗ Edge cases\s+ambiguous misses not covered → see the unclear edge cases/);
  });
});

describe('Review fixes (plan rules)', () => {
  const items = ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'];
  const found = items.map((item) => ({ item, status: 'found', source: 'description' }));
  const mk = (over: Record<string, unknown>) => normalizePlan({ ...readyJson, gap_analysis: found, ...over }, 'T2-1');

  it('#2 an unclear edge case without "case" text still becomes a question, and is flagged', () => {
    const p = mk({ edge_cases: [{ id: 'EC1', source: 'domain', status: 'unclear', question: 'Tie split?', options: ['Even', 'First'], default: 'Even' }] });
    expect(p.readiness).toBe('blocking');
    expect(p.questions[0]).toMatchObject({ text: 'Tie split?', from: 'EC1' });
    expect(validatePlan(p, ['api']).join(' ')).toMatch(/EC1 has no "case" text/);
  });

  it('#4 tests must point at a real work item and AC', () => {
    const p = mk({ testPlan: [{ ac: 'AC9', workItem: 'W9', name: 't1', cases: ['x'] }], edge_cases: [{ id: 'EC1', case: 'tie', source: 'code', status: 'handled', test: 't1' }] });
    const problems = validatePlan(p, ['api']).join(' ');
    expect(problems).toMatch(/Test t1 is not linked to a known work item \(got "W9"\)/);
    expect(problems).toMatch(/Test t1 refers to unknown acceptance criterion AC9/);
  });

  it('#5 duplicate edge-case ids are flagged', () => {
    const ec = { id: 'EC1', case: 'a', source: 'code', status: 'not_affected', note: 'n' };
    expect(validatePlan(mk({ edge_cases: [ec, { ...ec, case: 'b' }] }), ['api']).join(' ')).toMatch(/Edge case id EC1 is used more than once/);
  });

  it('#10 repo rules apply to blocking plans too', () => {
    const blockingGap = found.map((g) => (g.item === 'scope' ? { item: 'scope', status: 'missing', source: 'x', severity: 'blocking', question: 'Scope?', options: ['a', 'b'], default: 'a' } : g));
    const p = mk({ gap_analysis: blockingGap, workItems: [{ id: 'W1', repo: 'made-up', task: 't', reason: 'r', confidence: 'low' }] });
    expect(p.readiness).toBe('blocking');
    expect(p.questions.map((q) => q.text).join(' ')).toMatch(/Is "made-up" the right repository/);
    expect(validatePlan(p, ['api']).join(' ')).toMatch(/"made-up", which is not in the service catalog/);
  });
});

describe('Review fixes (watcher)', () => {
  const L = DEFAULT_LABELS;
  function setupW(outcomes: PlanOutcome[]) {
    const jobsDir = fs.mkdtempSync(path.join(tmp, 'jobs-'));
    const jira: WatcherJira = {
      searchTasks: async () => [task({ id: 'T2-9', metadata: { labels: [L.ready] } })],
      getTask: async () => task({ id: 'T2-9' }),
      addComment: async () => {},
      updateLabels: async () => {},
      transition: async () => true,
      getLabelAdder: async () => 'x'
    };
    let i = 0;
    const watcher = new AutomationWatcher(
      { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false, maxQuestionRounds: 2 },
      { jira, jobsDir, log: () => {}, attempts: () => 0, plan: async () => outcomes[Math.min(i++, outcomes.length - 1)], implement: async () => { throw new Error('no'); }, publish: async () => ({ links: [], skipped: [] }) }
    );
    return watcher;
  }
  const blocking = normalizePlan({ readiness: 'blocking', questions: [{ id: 'Q1', text: 'q?', options: ['a', 'b'] }] }, 'T2-9');
  const vague = normalizePlan({ readiness: 'too_vague', missingForReporter: ['x'] }, 'T2-9');

  it('#6 question rounds start again after the ticket is sent back', async () => {
    const w = setupW([
      { status: 'needs-input', repos: [], plans: {}, text: '', ticketPlan: blocking },
      { status: 'needs-input', repos: [], plans: {}, text: '', ticketPlan: blocking },
      { status: 'needs-input', repos: [], plans: {}, text: '', ticketPlan: blocking }, // round limit → sent back
      { status: 'needs-input', repos: [], plans: {}, text: '', ticketPlan: blocking }  // after a rewrite: round 1 again
    ]);
    for (let n = 0; n < 3; n++) await w.runOnce();
    expect(w.sessions.get('T2-9')?.phase).toBe('needs_info');
    expect(w.readQuestionState('T2-9').rounds).toBe(0);
    await w.runOnce();
    expect(w.sessions.get('T2-9')?.phase).toBe('needs_input');
    expect(w.readQuestionState('T2-9').rounds).toBe(1);
    void vague;
  });

  it('#7 temporary failures are retried at most twice, then a person is asked', async () => {
    const w = setupW([{ status: 'retry-later', reason: 'session limit', repos: [], plans: {}, text: '' }]);
    expect((await w.runOnce()).actions[0].action).toBe('skipped');
    expect((await w.runOnce()).actions[0].action).toBe('skipped');
    expect((await w.runOnce()).actions[0].action).toBe('failed');
    expect(w.sessions.get('T2-9')?.phase).toBe('needs_human');
  });
});

describe('Duplicate questions are merged (real pairs from T2 runs)', () => {
  it('merges a checklist question and an edge-case question about the same thing, keeps different ones', async () => {
    const { sameQuestion } = await import('../src/agents/planning/plan-rules.js');
    const scope = {
      text: "For POST /deactivateCategory with parentCategoryId: should we fix the existing bug so ALL child categories under that parent are deactivated (and their upcoming events cascaded), or keep today's behavior of only updating/cascading the first matched child category (items[0])?",
      options: [
        'Fix it: update + cascade events for every child category under the parent',
        'Keep current behavior: only the first matched child category (items[0]) is updated/cascaded',
        'Reject/no-op parentCategoryId for now and only support categoryId in this ticket'
      ]
    };
    const ec6 = { text: "Should fixing the parentCategoryId selection bug (only items[0] updated today) be in scope for this ticket's event cascade?", options: ['Fix: cascade for all child categories', 'Keep current single-category behavior'] };
    expect(sameQuestion(scope, ec6)).toBe(true);
    const statuses = { text: 'Which withdrawal statuses count toward the daily total?', options: ['PENDING, ACCEPTED, PROCESSING, COMPLETED', 'Only PENDING, ACCEPTED, COMPLETED'] };
    const day = { text: 'What is the day boundary for the daily withdrawal limit?', options: ['UTC midnight', 'Asia/Colombo midnight'] };
    expect(sameQuestion(statuses, day)).toBe(false);

    const items = ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'];
    const p = normalizePlan({
      ...readyJson,
      gap_analysis: items.map((item) => (item === 'scope' ? { item, status: 'ambiguous', source: 'parent bug', severity: 'blocking', question: scope.text, options: scope.options, default: scope.options[0] } : { item, status: 'found', source: 'd' })),
      edge_cases: [{ id: 'EC6', case: 'parent selection bug', source: 'code', status: 'unclear', question: ec6.text, options: ec6.options }]
    }, 'T2-593');
    expect(p.questions).toHaveLength(1);
    expect(p.questions[0]).toMatchObject({ from: 'scope', covers: ['EC6'] });
    expect(renderPlan(p)).toContain('EC6 [code] parent selection bug → unclear → Q1');
  });
});

describe('Rich Jira comments (ADF)', () => {
  const items = ['expected_behaviour', 'current_behaviour', 'product', 'example', 'edge_cases', 'scope', 'verification'];
  const plan = normalizePlan({
    ...readyJson,
    gap_analysis: items.map((item) => (item === 'example' ? { item, status: 'missing', source: 'no example', severity: 'minor', assumption: 'use AC1' } : { item, status: 'found', source: 'description' })),
    edge_cases: [
      { id: 'EC1', case: '3-way tie', source: 'domain', status: 'handled', test: 'test_AC1_tie_split' },
      { id: 'EC2', case: 'empty board', source: 'generic', status: 'safe_default', note: 'no payout' }
    ],
    contract: ['GET /payouts adds `tie: bool`'],
    clarifications: ['Ties split evenly (Ravi)']
  }, 'T2-1');
  const nodes = (n: unknown, out: Array<Record<string, unknown>> = []) => {
    if (n && typeof n === 'object') {
      out.push(n as Record<string, unknown>);
      for (const c of ((n as { content?: unknown[] }).content ?? [])) nodes(c, out);
    }
    return out;
  };

  it('plan comment: tables, lozenges, panels, revision title, next steps, and never an empty text node', async () => {
    const { planCommentAdf } = await import('../src/agents/planning/render-adf.js');
    const d = planCommentAdf({ ...plan, warnings: ['W1 uses "api" but the map points to "web".'] }, { version: 2, readyLabel: 'ai-ready', approvedLabel: 'ai-approved', promptVersion: 'planning-v2', costUsd: 0.41, repoFacts: [{ repo: 'api', branch: 'ai/T2-1', verify: 'npm test', rollback: 'delete branch' }] });
    const all = nodes(d);
    expect(d).toMatchObject({ type: 'doc', version: 1 });
    expect(all.filter((n) => n.type === 'text').every((n) => typeof n.text === 'string' && (n.text as string).length > 0)).toBe(true);
    const types = new Set(all.map((n) => n.type));
    for (const t of ['table', 'panel', 'status', 'heading', 'bulletList', 'orderedList', 'rule']) expect(types, t).toContain(t);
    const textAll = all.filter((n) => n.type === 'text').map((n) => n.text).join(' ');
    expect(textAll).toContain('Change plan v2 (revised) for T2-1');
    expect(textAll).toContain('test_AC1_tie_split');
    expect(textAll).toContain('ai-approved');
    expect(all.some((n) => n.type === 'panel' && (n.attrs as { panelType: string }).panelType === 'warning')).toBe(true);
    expect(all.some((n) => n.type === 'text' && n.text === 'tie: bool' && JSON.stringify(n.marks).includes('code'))).toBe(true);
  });

  it('questions and missing-info comments are well formed', async () => {
    const { questionsCommentAdf, missingInfoCommentAdf } = await import('../src/agents/planning/render-adf.js');
    const q = questionsCommentAdf({ ...plan, questions: [{ id: 'Q1', text: 'Ties?', options: ['Split', 'First'], defaultOption: 'Split', from: 'EC2' }] }, 'ai-ready', 1, 2);
    const qt = nodes(q).filter((n) => n.type === 'text');
    expect(qt.every((n) => (n.text as string).length > 0)).toBe(true);
    expect(qt.map((n) => n.text).join(' ')).toContain('Q1: A');
    const m = missingInfoCommentAdf({ ...plan, missingForReporter: ['Expected behaviour'] }, 'ai-ready');
    expect(nodes(m).some((n) => n.type === 'panel' && (n.attrs as { panelType: string }).panelType === 'error')).toBe(true);
  });

  it('the watcher posts the rich plan, and falls back to plain text if Jira rejects it', async () => {
    const L = DEFAULT_LABELS;
    for (const failRich of [false, true]) {
      const plain: string[][] = [];
      const rich: unknown[] = [];
      const jira: WatcherJira = {
        searchTasks: async () => [task({ id: 'T2-8', metadata: { labels: [L.ready] } })],
        getTask: async () => task({ id: 'T2-8' }),
        addComment: async (_k, lines) => void plain.push(lines),
        addCommentDoc: async (_k, body) => {
          if (failRich) throw new Error('Jira API 400: INVALID_INPUT');
          rich.push(body);
        },
        updateLabels: async () => {},
        transition: async () => true,
        getLabelAdder: async () => 'x'
      };
      const w = new AutomationWatcher(
        { jql: 'x', labels: L, autoApprove: false, maxAttempts: 3, dryRun: false },
        { jira, jobsDir: fs.mkdtempSync(path.join(tmp, 'jobs-')), log: () => {}, attempts: () => 0, plan: async () => ({ status: 'ready', repos: ['api'], plans: {}, text: 'PLAIN PLAN', ticketPlan: plan }), implement: async () => { throw new Error('no'); }, publish: async () => ({ links: [], skipped: [] }) }
      );
      await w.runOnce();
      expect(rich.length + plain.length).toBe(1);
      expect(failRich ? plain.length : rich.length).toBe(1);
    }
  });
});
