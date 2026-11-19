import type { RiskLevel, TicketPlan } from './types.js';

/**
 * The approval sheet's two halves (team template):
 *   DEV PLAN  repos (= work items) · DB tables · cache keys · Secrets Manager keys · infra (Helm,
 *             service metadata, Terraform) · alerts and telemetry
 *   QA PLAN   test cases · what must NOT happen · happy cases · edge cases (= plan.edgeCases)
 * Every dev section is answered explicitly: changes, or "none" with the reason. A silent empty
 * section is refused, so "no DB change" is a statement the approver can check, not an omission.
 */

export interface PlanSection<T> {
  items: T[];
  /** Why nothing changes here (required when items is empty). */
  none?: string;
}

export const DB_CHANGES = ['create_table', 'add_column', 'alter_column', 'drop_column', 'drop_table', 'index', 'data_migration', 'query_only'] as const;
export const CACHE_CHANGES = ['create', 'update', 'delete', 'invalidate', 'ttl_change'] as const;
export const SECRET_CHANGES = ['add', 'update', 'remove', 'rotate'] as const;
export const INFRA_KINDS = ['helm', 'service_metadata', 'terraform', 'env_config', 'other'] as const;
export const TELEMETRY_KINDS = ['alert', 'metric', 'log', 'trace', 'dashboard'] as const;
export const QA_TYPES = ['unit', 'api', 'manual', 'e2e'] as const;

export interface DbChange {
  repo: string;
  database: string;
  table: string;
  change: (typeof DB_CHANGES)[number];
  summary: string;
  /** Migration file or script, e.g. src/migrations/<date>-add-ip.ts. */
  migration?: string;
  /** Old code keeps working against the new schema (safe deploy order). */
  backwardCompatible: boolean;
}
export interface CacheChange {
  repo: string;
  /** Key or pattern, e.g. user:{userId}:wallet. */
  key: string;
  change: (typeof CACHE_CHANGES)[number];
  summary: string;
  ttl?: string;
}
export interface SecretChange {
  /** Secrets Manager secret name, e.g. gb/payments/prod. */
  secret: string;
  /** Key inside the secret. Never a value. */
  key: string;
  change: (typeof SECRET_CHANGES)[number];
  summary: string;
  environments: string[];
}
export interface InfraChange {
  kind: (typeof INFRA_KINDS)[number];
  /** Chart / values file / Terraform module / service. */
  target: string;
  summary: string;
}
export interface TelemetryChange {
  kind: (typeof TELEMETRY_KINDS)[number];
  name: string;
  change: 'create' | 'update' | 'remove';
  summary: string;
  /** Alert condition / threshold, e.g. "5xx > 2% for 5 min". */
  condition?: string;
}
/** A repository that does not exist yet and must be created (by a person) for this change. */
export interface NewRepo {
  name: string;
  purpose: string;
  /** What goes in it for this ticket. */
  summary: string;
}
export interface DevPlan {
  /** Repos to CREATE. Existing repos to update are the plan's work items. */
  newRepos: NewRepo[];
  db: PlanSection<DbChange>;
  cache: PlanSection<CacheChange>;
  secrets: PlanSection<SecretChange>;
  infra: PlanSection<InfraChange>;
  telemetry: PlanSection<TelemetryChange>;
}

export interface QaTestCase {
  id: string; // TC1 ...
  title: string;
  /** What it proves. */
  validates: string;
  type: (typeof QA_TYPES)[number];
  ac?: string;
  /** test_plan name when the case is automated. */
  test?: string;
}
export interface QaStatement {
  id: string; // N1 / H1 ...
  text: string;
  /** Test case or test that checks it. */
  checkedBy?: string;
}
export interface QaPlan {
  testCases: QaTestCase[];
  mustNotHappen: QaStatement[];
  happyCases: QaStatement[];
}

// ── parsing (the model's JSON, snake_case or camelCase) ─────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : typeof v === 'string' && v.trim() ? [v.trim()] : []);
const pick = (o: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => {
  const s = str(v).toLowerCase().replace(/[\s-]+/g, '_') as T;
  return allowed.includes(s) ? s : fallback;
};

function section<T>(raw: unknown, item: (o: Record<string, unknown>) => T, keep: (t: T) => boolean): PlanSection<T> | undefined {
  if (raw === undefined || raw === null) return undefined;
  // A bare array is accepted as the items.
  const o = Array.isArray(raw) ? { items: raw } : obj(raw);
  const none = str(pick(o, 'none', 'none_reason', 'noneReason'));
  return { items: list(o.items).map(item).filter(keep), ...(none ? { none } : {}) };
}

export function parseDevPlan(raw: unknown): DevPlan | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = obj(raw);
  const empty = <T>(): PlanSection<T> => ({ items: [] });
  return {
    newRepos: list(pick(o, 'new_repos', 'newRepos'))
      .map((r) => ({ name: str(pick(r, 'name', 'repo')), purpose: str(r.purpose), summary: str(r.summary) }))
      .filter((r) => r.name),
    db:
      section(pick(o, 'db_changes', 'dbChanges', 'db'), (d) => ({
        repo: str(d.repo),
        database: str(pick(d, 'database', 'db')),
        table: str(d.table),
        change: oneOf(d.change, DB_CHANGES, 'alter_column'),
        summary: str(d.summary),
        ...(str(d.migration) ? { migration: str(d.migration) } : {}),
        backwardCompatible: pick(d, 'backward_compatible', 'backwardCompatible') !== false
      }), (d) => !!(d.table || d.summary)) ?? empty(),
    cache:
      section(pick(o, 'cache_changes', 'cacheChanges', 'cache'), (c) => ({
        repo: str(c.repo),
        key: str(pick(c, 'key', 'key_pattern', 'keyPattern')),
        change: oneOf(c.change, CACHE_CHANGES, 'update'),
        summary: str(c.summary),
        ...(str(c.ttl) ? { ttl: str(c.ttl) } : {})
      }), (c) => !!(c.key || c.summary)) ?? empty(),
    secrets:
      section(pick(o, 'secret_changes', 'secretChanges', 'secrets'), (s) => ({
        secret: str(pick(s, 'secret', 'secret_name', 'secretName')),
        key: str(s.key),
        change: oneOf(s.change, SECRET_CHANGES, 'add'),
        summary: str(s.summary),
        environments: strList(pick(s, 'environments', 'envs'))
      }), (s) => !!(s.secret || s.key)) ?? empty(),
    infra:
      section(pick(o, 'infra_changes', 'infraChanges', 'infra'), (i) => ({
        kind: oneOf(i.kind, INFRA_KINDS, 'other'),
        target: str(i.target),
        summary: str(i.summary)
      }), (i) => !!(i.target || i.summary)) ?? empty(),
    telemetry:
      section(pick(o, 'telemetry_changes', 'telemetryChanges', 'telemetry', 'alerts_and_telemetry'), (t) => ({
        kind: oneOf(t.kind, TELEMETRY_KINDS, 'metric'),
        name: str(t.name),
        change: oneOf(t.change, ['create', 'update', 'remove'] as const, 'create'),
        summary: str(t.summary),
        ...(str(t.condition) ? { condition: str(t.condition) } : {})
      }), (t) => !!(t.name || t.summary)) ?? empty()
  };
}

/** Which dev sections the model answered at all (an absent key differs from "none"). */
export function answeredDevSections(raw: unknown): Set<keyof typeof DEV_SECTION_LABELS> {
  const o = obj(raw);
  const out = new Set<keyof typeof DEV_SECTION_LABELS>();
  const has = (...k: string[]) => k.some((x) => o[x] !== undefined && o[x] !== null);
  if (has('db_changes', 'dbChanges', 'db')) out.add('db');
  if (has('cache_changes', 'cacheChanges', 'cache')) out.add('cache');
  if (has('secret_changes', 'secretChanges', 'secrets')) out.add('secrets');
  if (has('infra_changes', 'infraChanges', 'infra')) out.add('infra');
  if (has('telemetry_changes', 'telemetryChanges', 'telemetry', 'alerts_and_telemetry')) out.add('telemetry');
  return out;
}

export function parseQaPlan(raw: unknown): QaPlan | undefined {
  if (raw === undefined || raw === null) return undefined;
  const o = obj(raw);
  const statements = (v: unknown, prefix: string): QaStatement[] =>
    list(v)
      .map((s, i) => ({
        id: str(s.id) || `${prefix}${i + 1}`,
        text: str(pick(s, 'text', 'statement', 'case')),
        ...(str(pick(s, 'checked_by', 'checkedBy', 'test')) ? { checkedBy: str(pick(s, 'checked_by', 'checkedBy', 'test')) } : {})
      }))
      .filter((s) => s.text);
  return {
    testCases: list(pick(o, 'test_cases', 'testCases'))
      .map((t, i) => ({
        id: str(t.id) || `TC${i + 1}`,
        title: str(pick(t, 'title', 'name')),
        validates: str(pick(t, 'validates', 'summary')),
        type: oneOf(t.type, QA_TYPES, 'unit'),
        ...(str(t.ac) ? { ac: str(t.ac) } : {}),
        ...(str(t.test) ? { test: str(t.test) } : {})
      }))
      .filter((t) => t.title || t.validates),
    mustNotHappen: statements(pick(o, 'must_not_happen', 'mustNotHappen', 'constraints'), 'N'),
    happyCases: statements(pick(o, 'happy_cases', 'happyCases'), 'H')
  };
}

// ── rules (code, not the model) ─────────────────────────────────────────────────────────────

export const DEV_SECTION_LABELS: Record<Exclude<keyof DevPlan, 'newRepos'>, string> = {
  db: 'Database changes (db_changes)',
  cache: 'Cache keys (cache_changes)',
  secrets: 'Secrets Manager keys (secret_changes)',
  infra: 'Infra: Helm / service metadata / Terraform (infra_changes)',
  telemetry: 'Alerts and telemetry (telemetry_changes)'
};

/** Looks like a secret value rather than a name (long token, key=value with a long value, PEM). */
const SECRET_VALUE = /-----BEGIN|(?:=|:)\s*["']?[A-Za-z0-9+/_\-]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b[A-Za-z0-9+/]{40,}={0,2}\b/;

/** Problems with the dev and QA plan of a "ready" plan; empty = fine. */
export function devQaProblems(plan: TicketPlan, answered?: Set<keyof typeof DEV_SECTION_LABELS>): string[] {
  const p: string[] = [];
  const dev = plan.devPlan;
  if (!dev) {
    p.push('dev_plan is missing. For each of db_changes, cache_changes, secret_changes, infra_changes and telemetry_changes give the changes, or "none" with the reason nothing changes.');
  } else {
    for (const r of dev.newRepos) if (!r.summary) p.push(`dev_plan.new_repos ${r.name}: say what goes in it for this ticket.`);
    for (const k of Object.keys(DEV_SECTION_LABELS) as Array<keyof typeof DEV_SECTION_LABELS>) {
      const s = dev[k];
      if ((answered && !answered.has(k)) || (!s.items.length && !s.none)) {
        p.push(`dev_plan ${DEV_SECTION_LABELS[k]}: list the changes, or set "none" to the reason nothing changes.`);
      }
    }
    for (const d of dev.db.items) {
      if (!d.table) p.push(`db_changes: an entry has no table ("${d.summary.slice(0, 40)}").`);
      if (!d.summary) p.push(`db_changes ${d.table}: no change summary.`);
      if (['create_table', 'add_column', 'alter_column', 'drop_column', 'drop_table', 'index', 'data_migration'].includes(d.change) && !d.migration) {
        p.push(`db_changes ${d.table} (${d.change}): name the migration file or script.`);
      }
    }
    for (const c of dev.cache.items) if (!c.key || !c.summary) p.push(`cache_changes: every entry needs a key (or pattern) and a summary.`);
    for (const s of dev.secrets.items) {
      if (!s.secret || !s.key) p.push('secret_changes: every entry needs the secret name and the key inside it.');
      if (SECRET_VALUE.test(`${s.key} ${s.summary}`)) p.push(`secret_changes ${s.secret}/${s.key}: looks like a secret VALUE. Give only names, never values.`);
    }
    for (const i of dev.infra.items) if (!i.target || !i.summary) p.push('infra_changes: every entry needs a target (chart, values file, module, service) and a summary.');
    for (const t of dev.telemetry.items) {
      if (!t.name || !t.summary) p.push('telemetry_changes: every entry needs a name and a summary.');
      if (t.kind === 'alert' && t.change !== 'remove' && !t.condition) p.push(`telemetry_changes alert "${t.name}": give the condition / threshold.`);
    }
  }

  const qa = plan.qaPlan;
  if (!qa) {
    p.push('qa_plan is missing: test_cases, must_not_happen and happy_cases are required.');
    return p;
  }
  if (!qa.testCases.length) p.push('qa_plan.test_cases is empty: list the test cases with what each validates.');
  if (!qa.mustNotHappen.length) p.push('qa_plan.must_not_happen is empty: list what must definitely NOT happen (constraints).');
  if (!qa.happyCases.length) p.push('qa_plan.happy_cases is empty: list what must definitely happen.');
  const seen = new Set<string>();
  for (const id of [...qa.testCases.map((t) => t.id), ...qa.mustNotHappen.map((s) => s.id), ...qa.happyCases.map((s) => s.id)]) {
    if (seen.has(id)) p.push(`qa_plan id ${id} is used more than once.`);
    seen.add(id);
  }
  const acIds = new Set(plan.acceptanceCriteria.map((a) => a.id));
  for (const t of qa.testCases) {
    if (!t.validates) p.push(`qa_plan ${t.id} (${t.title}) does not say what it validates.`);
    if (t.ac && !acIds.has(t.ac)) p.push(`qa_plan ${t.id} refers to unknown acceptance criterion ${t.ac}.`);
  }
  for (const ac of plan.acceptanceCriteria) {
    if (!qa.testCases.some((t) => t.ac === ac.id)) p.push(`${ac.id} has no QA test case (qa_plan.test_cases with "ac": "${ac.id}").`);
  }
  return p;
}

/** Things the approver must notice, set by code: unsafe DB order, work for DevOps. */
export function devPlanWarnings(dev: DevPlan | undefined): string[] {
  if (!dev) return [];
  const w: string[] = [];
  for (const r of dev.newRepos) {
    w.push(`New repo "${r.name}" must be created by a person (Bitbucket + catalog/repos.yaml) before coding starts; the pipeline only changes existing repos.`);
  }
  for (const d of dev.db.items) {
    if (!d.backwardCompatible) w.push(`DB change ${d.table} (${d.change}) is NOT backward compatible: plan the deploy order (migration vs. code) before approving.`);
    else if (d.change === 'drop_table' || d.change === 'drop_column') w.push(`DB change drops data: ${d.table} (${d.change}). Check backups and rollback.`);
  }
  const devops = [
    ...dev.secrets.items.map((s) => `Secrets Manager ${s.secret}/${s.key} (${s.change}${s.environments.length ? `, ${s.environments.join('/')}` : ''})`),
    ...dev.infra.items.map((i) => `${i.kind.replace('_', ' ')}: ${i.target}`)
  ];
  if (devops.length) w.push(`Needs DevOps before deploy: ${devops.join('; ')}. The coding agent does not change these.`);
  return w;
}

/** Risk is never "low" when the plan changes data, secrets or infra. */
export function devPlanRiskFloor(dev: DevPlan | undefined): RiskLevel | undefined {
  if (!dev) return undefined;
  if (dev.db.items.some((d) => !d.backwardCompatible || d.change.startsWith('drop'))) return 'high';
  if (dev.db.items.length || dev.secrets.items.length || dev.infra.items.length) return 'medium';
  return undefined;
}

/** One-line context for the coding and QA agents (they get the approved plan as plain lines). */
export function devQaContext(plan: TicketPlan): string[] {
  const L: string[] = [];
  const dev = plan.devPlan;
  if (dev) {
    for (const d of dev.db.items) L.push(`Approved DB change: ${d.database ? `${d.database}.` : ''}${d.table} (${d.change}) ${d.summary}${d.migration ? `; migration ${d.migration}` : ''}`);
    for (const c of dev.cache.items) L.push(`Approved cache change: ${c.key} (${c.change}) ${c.summary}${c.ttl ? `; TTL ${c.ttl}` : ''}`);
    for (const s of dev.secrets.items) L.push(`Secret ${s.secret}/${s.key} (${s.change}) is set up by DevOps; read it by name, never hard-code a value.`);
    for (const t of dev.telemetry.items) L.push(`Telemetry to add: ${t.kind} ${t.name} (${t.change}) ${t.summary}${t.condition ? `; condition ${t.condition}` : ''}`);
  }
  for (const n of plan.qaPlan?.mustNotHappen ?? []) L.push(`Must NOT happen (${n.id}): ${n.text}`);
  for (const h of plan.qaPlan?.happyCases ?? []) L.push(`Must happen (${h.id}): ${h.text}`);
  return L;
}
