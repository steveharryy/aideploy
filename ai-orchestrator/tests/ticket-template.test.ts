import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  checkTemplate,
  loadTicketTemplate,
  parseTicketTemplate,
  pathTokens,
  splitSections,
  templateText,
  type KnownRepo
} from '../src/agents/intake/ticket-template.js';
import { runIntake } from '../src/agents/intake/intake.js';
import { DEFAULT_PIPELINE_CONFIG, parsePipelineConfig, type PipelineConfig } from '../src/config/pipeline-config.js';
import { PlanningAgent, emptyPlan } from '../src/agents/planning/planning-agent.js';
import { renderMissing, renderPlan } from '../src/agents/planning/render.js';
import { missingInfoCommentAdf } from '../src/agents/planning/render-adf.js';
import type { TaskInput } from '../src/models/types.js';

const tpl = loadTicketTemplate(path.resolve(__dirname, '../config/ticket-template.yaml'));
const repos: KnownRepo[] = [
  { id: 'gb-payments-api', names: ['gb-payments-api', 'gb-payments-api-service', 'GameBull Payments API'], path: '/clones/gb-payments-api-service' },
  { id: 'gb-homepage-api', names: ['gb-homepage-api', 'gb-homepage-api-service'], path: '/clones/gb-homepage-api-service' }
];
const existing = new Set(['/clones/gb-payments-api-service/src/utils/getUserIP.ts']);
const exists = (p: string) => existing.has(p);

const FILLED_STORY = `### Problem
Transaction records store IPs like ::ffff:203.0.113.5, which breaks the fraud checks that compare IPv4 strings.

### Target repo
gb-payments-api-service

### Source location
src/utils/getUserIP.ts, function getClientIp(req)

### Current behaviour
getClientIp returns the first value it finds as is, including the ::ffff: prefix.

### Expected behaviour
getClientIp returns the plain IPv4 address when the chosen value is an IPv4-mapped IPv6 address.

### Acceptance criteria
1. AC1: Given any source yields ::ffff:203.0.113.5, then 203.0.113.5 is returned.
2. AC2: A real IPv6 address such as 2001:db8::1 is returned unchanged.

### Examples
| Input | Expected output |
| --- | --- |
| ::ffff:203.0.113.5 | 203.0.113.5 |

### Edge cases and money rules
None, because no amounts or wallets are involved.

### Out of scope
No change to callers or to how IPs are stored.

### How to verify
Unit tests per AC (npm test).`;

const check = (description: string, over: Partial<Parameters<typeof checkTemplate>[1]> = {}) =>
  checkTemplate(tpl, { issueType: 'Story', description, title: 'getClientIp', repos, exists, ...over });
const row = (r: ReturnType<typeof check>, name: string) => r.rows.find((x) => x.check === name);

describe('Ticket template: config', () => {
  it('loads the real template file and rejects broken ones', () => {
    expect(tpl.sections.map((s) => s.id)).toEqual(expect.arrayContaining(['problem', 'target_repo', 'source', 'expected', 'acceptance', 'examples', 'verify']));
    expect(() => parseTicketTemplate({ sections: [] })).toThrow(/non-empty/);
    expect(() => parseTicketTemplate({ sections: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] })).toThrow(/duplicate/);
    expect(() => parseTicketTemplate({ sections: [{ id: 'a', title: 'A', check: 'magic' }] })).toThrow(/unknown check/);
  });

  it('prints a copy-paste template per issue type', () => {
    const story = templateText(tpl, 'Story');
    const bug = templateText(tpl, 'Bug');
    expect(story).toMatch(/### Target repo\n/);
    expect(story).toMatch(/### Source location\n/);
    expect(story).toMatch(/### Edge cases and money rules \(required if it touches money\)/);
    expect(story).not.toMatch(/Steps to reproduce/);
    expect(bug).toMatch(/### Steps to reproduce\n1\. <step>/);
    expect(bug).toMatch(/### Current behaviour\n/); // required for bugs
  });
});

describe('Ticket template: checking a ticket', () => {
  it('a filled Story passes every required section', () => {
    const r = check(FILLED_STORY);
    expect(r.gaps).toEqual([]);
    expect(r.repos).toEqual(['gb-payments-api']);
    expect(row(r, 'Source location')).toMatchObject({ status: 'pass', detail: expect.stringMatching(/found in the repo/) });
    expect(row(r, 'Acceptance criteria')).toMatchObject({ status: 'pass', detail: '2 item(s)' });
    expect(row(r, 'Links')).toMatchObject({ status: 'skip' });
    expect(r.rows.some((x) => x.check === 'Steps to reproduce')).toBe(false);
  });

  it('the template pasted unfilled fails: placeholders and table headers are not content', () => {
    const r = check(templateText(tpl, 'Story'));
    expect(r.rows.filter((x) => x.status === 'fail').map((x) => x.check)).toEqual(
      expect.arrayContaining(['Problem', 'Target repo', 'Source location', 'Expected behaviour', 'Acceptance criteria', 'Examples', 'Out of scope', 'How to verify'])
    );
    expect(row(r, 'Examples')?.detail).toBe('heading present but empty');
  });

  it('accepts plain and bold "Label:" lines and alias headings', () => {
    const text = [
      'Background: users see wrong IPs in transaction exports every day.',
      '**Target repo:** gb-payments-api',
      'Source: POST /withdrawals handler',
      'What to change: return the plain IPv4 address for IPv4-mapped addresses.',
      'Acceptance criteria',
      '- AC1: ::ffff:1.2.3.4 becomes 1.2.3.4 for every source',
      'Example: ::ffff:1.2.3.4 → 1.2.3.4',
      'Not in scope: callers of getClientIp',
      'How to test: unit tests per AC'
    ].join('\n');
    const s = splitSections(text, tpl);
    expect(s.get('problem')).toMatch(/users see wrong IPs/);
    expect(s.get('target_repo')).toMatch(/gb-payments-api/);
    expect(s.get('expected')).toMatch(/plain IPv4/);
    expect(check(text, { title: 'IP fix', labels: [] }).gaps.filter((g) => !/Edge cases/.test(g))).toEqual([]);
  });

  it('an ordinary sentence that starts like a heading is not a heading', () => {
    const s = splitSections('### Problem\nThe problem statement in the old doc was wrong about it.\n', tpl);
    expect(s.get('problem')).toMatch(/old doc/);
  });

  it('Target repo must name a repo the pipeline knows (id or Bitbucket name)', () => {
    const r = check(FILLED_STORY.replace('gb-payments-api-service', 'the payments thing'));
    expect(row(r, 'Target repo')).toMatchObject({ status: 'fail' });
    expect(r.gaps.join(' ')).toMatch(/gb-payments-api-service, gb-homepage-api-service/);
    expect(check(FILLED_STORY.replace('gb-payments-api-service', 'gb-homepage-api')).repos).toEqual(['gb-homepage-api']);
  });

  it('a source path that does not exist in the target repo is a warning, not a stop', () => {
    const r = check(FILLED_STORY.replace('src/utils/getUserIP.ts', 'src/utils/getUserIp.ts'));
    expect(row(r, 'Source location')).toMatchObject({ status: 'warn', detail: expect.stringMatching(/not found in gb-payments-api: src\/utils\/getUserIp\.ts/) });
    expect(r.gaps).toEqual([]);
    expect(pathTokens('see https://x.io/a and ./src/a/b.ts, POST /withdrawals')).toEqual(['src/a/b.ts']);
  });

  it('edge cases are a warning, but required once the ticket mentions money', () => {
    // (A payments repo counts as money too, so this ticket targets the homepage service.)
    const noEdge = FILLED_STORY.replace(/### Edge cases and money rules\n[^\n]*\n/, '').replace(/Transaction records store/, 'Logs store').replace('gb-payments-api-service', 'gb-homepage-api-service');
    expect(row(check(noEdge), 'Edge cases and money rules')).toMatchObject({ status: 'warn' });
    const money = check(noEdge, { title: 'Round the withdrawal fee' });
    expect(money.money).toBe(true);
    expect(row(money, 'Edge cases and money rules')).toMatchObject({ status: 'fail', detail: expect.stringMatching(/mentions money/) });
  });

  it('a Bug needs steps to reproduce and the actual result', () => {
    const r = check(FILLED_STORY, { issueType: 'Bug' });
    expect(row(r, 'Steps to reproduce')).toMatchObject({ status: 'fail' });
    expect(row(r, 'Current behaviour')).toMatchObject({ status: 'pass' });
    expect(row(r, 'Environment and evidence')).toMatchObject({ status: 'warn' });
  });

  it("counts criteria from Jira's acceptance-criteria field", () => {
    const noAc = FILLED_STORY.replace(/### Acceptance criteria\n(?:\d\.[^\n]*\n)+/, '');
    expect(row(check(noAc), 'Acceptance criteria')).toMatchObject({ status: 'fail' });
    expect(row(check(noAc, { acceptanceCriteria: ['Given a mapped IP, then the IPv4 part is returned'] }), 'Acceptance criteria')).toMatchObject({ status: 'pass' });
  });
});

const intakeRules = (over: Partial<PipelineConfig['intake']> = {}): PipelineConfig['intake'] => ({
  ...DEFAULT_PIPELINE_CONFIG.intake,
  minDescriptionChars: 50,
  template: true,
  ...over
});
const ticket = (description: string, meta: Record<string, unknown> = {}): TaskInput => ({
  id: 'T2-9',
  title: 'getClientIp returns plain IPv4',
  description,
  acceptanceCriteria: [],
  metadata: { issueType: 'Story', labels: ['gb-payments'], descriptionText: description, acFieldCriteria: [], created: '2026-11-19T10:00:00.000+0530', ...meta }
});

describe('Intake with the template', () => {
  it('lists every check (basic + template) and blocks on missing sections', () => {
    const r = runIntake(ticket('Make the IP helper better for the payments team, it is wrong sometimes.'), intakeRules(), undefined, { template: tpl, repos, exists });
    expect(r.templateChecked).toBe(true);
    expect(r.checks.map((c) => c.check).slice(0, 6)).toEqual(['Summary', 'Issue type', 'Description length', 'Product', 'Component / area', 'Size']);
    expect(r.gaps.length).toBeGreaterThan(3);
    expect(r.checks.find((c) => c.check === 'Target repo')?.status).toBe('fail');
  });

  it('a filled ticket passes; template off or ticket older than template_applies_from = not checked', () => {
    expect(runIntake(ticket(FILLED_STORY), intakeRules(), undefined, { template: tpl, repos, exists }).gaps).toEqual([]);
    const off = runIntake(ticket('Make the IP helper better for the payments team, it is wrong sometimes.'), intakeRules({ template: false }), undefined, { template: tpl, repos });
    expect(off.gaps).toEqual([]);
    expect(off.templateChecked).toBe(false);
    const old = runIntake(ticket('Make the IP helper better for the payments team, it is wrong sometimes.', { created: '2026-11-01T10:00:00.000+0530' }), intakeRules({ templateAppliesFrom: '2026-11-18' }), undefined, { template: tpl, repos });
    expect(old.gaps).toEqual([]);
    expect(old.checks.find((c) => c.check === 'Ticket template')).toMatchObject({ status: 'skip', detail: 'created before 2026-11-18' });
  });

  it('config: template switches per project, and a bad date is refused', () => {
    const cfg = parsePipelineConfig({ intake: { template: false }, projects: { T2: { intake: { template: true, template_applies_from: '2026-11-18' } } } });
    expect(cfg.intake.template).toBe(false);
    expect(cfg.projectIntake.T2).toMatchObject({ template: true, templateAppliesFrom: '2026-11-18' });
    expect(parsePipelineConfig({ intake: { template_applies_from: new Date('2026-11-18T00:00:00Z') } }).intake.templateAppliesFrom).toBe('2026-11-18');
    expect(() => parsePipelineConfig({ intake: { template_applies_from: '18/11/2026' } })).toThrow(/date like/);
  });
});

describe('Planning stops on the template and shows every check', () => {
  it('too vague: the comment carries the full checklist and the template to copy; no AI call', async () => {
    let called = false;
    const agent = new PlanningAgent({
      repos: [],
      runner: async () => {
        called = true;
        throw new Error('should not run');
      },
      hardChecks: (t) => {
        const r = runIntake(t, intakeRules(), undefined, { template: tpl, repos, exists });
        return { gaps: r.gaps, checks: r.checks, template: templateText(tpl, 'Story') };
      }
    });
    const res = await agent.plan(ticket('Make the IP helper better for the payments team, it is wrong sometimes.'));
    expect(called).toBe(false);
    expect(res.plan.readiness).toBe('too_vague');
    expect(res.plan.intakeChecks?.length).toBeGreaterThan(10);
    const text = renderMissing(res.plan, 'AI Planning', true).join('\n');
    expect(text).toMatch(/EVERY CHECK ON THIS TICKET/);
    expect(text).toMatch(/✗ Target repo/);
    expect(text).toMatch(/### Source location/);
    const adf = JSON.stringify(missingInfoCommentAdf(res.plan, 'AI Planning', true));
    expect(adf).toMatch(/"type":"codeBlock"/);
    expect(adf).toMatch(/Every check on this ticket/);
  });

  it('the plan view lists the passed intake checks', () => {
    const plan = {
      ...emptyPlan('T2-9', 'ready'),
      intakeChecks: [{ check: 'Target repo', status: 'pass' as const, detail: 'gb-payments-api' }]
    };
    expect(renderPlan(plan)).toMatch(/INTAKE CHECKS[\s\S]*✓ Target repo/);
  });
});
