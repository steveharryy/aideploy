import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

/**
 * The standard ticket template (config/ticket-template.yaml) and the plain-code check of a ticket
 * against it. No AI: the description is split into sections by their headings and each section is
 * checked for real content. Used by intake before planning, and by `--check-ticket`.
 */

export type SectionCheck = 'repo' | 'paths' | 'ac';

export interface TemplateSection {
  id: string;
  title: string;
  aliases: string[];
  hint: string;
  requiredFor: string[];
  warnFor: string[];
  requiredIfMoney: boolean;
  minChars: number;
  minItems: number;
  check?: SectionCheck;
}

export interface TicketTemplate {
  sections: TemplateSection[];
  moneyKeywords: string[];
}

/** A repo a ticket may name: catalog id plus the other names people use (Bitbucket repo, display name). */
export interface KnownRepo {
  id: string;
  names: string[];
  /** Local clone, used to confirm that named source paths exist. */
  path?: string;
}

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

/** One line of the intake checklist shown on the ticket. */
export interface CheckRow {
  check: string;
  status: CheckStatus;
  detail: string;
}

export interface TemplateResult {
  rows: CheckRow[];
  /** Messages for the reporter, one per failed required section. */
  gaps: string[];
  /** Catalog repo ids the "Target repo" section names. */
  repos: string[];
  /** True when the ticket mentions money (edge cases become required). */
  money: boolean;
}

// ── loading ──────────────────────────────────────────────────────────────────────────────────

const list = (v: unknown, name: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' && typeof x !== 'number')) {
    throw new Error(`Ticket template: "${name}" must be a list of strings.`);
  }
  return v.map(String);
};

export function parseTicketTemplate(raw: unknown): TicketTemplate {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(r.sections) || r.sections.length === 0) throw new Error('Ticket template: "sections" must be a non-empty list.');
  const ids = new Set<string>();
  const sections = r.sections.map((s, i) => {
    const o = (s && typeof s === 'object' ? s : {}) as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    if (!id || !title) throw new Error(`Ticket template: section ${i + 1} needs an "id" and a "title".`);
    if (ids.has(id)) throw new Error(`Ticket template: duplicate section id "${id}".`);
    ids.add(id);
    const check = o.check === undefined ? undefined : String(o.check);
    if (check && !['repo', 'paths', 'ac'].includes(check)) throw new Error(`Ticket template: section "${id}" has unknown check "${check}" (repo, paths or ac).`);
    const num = (v: unknown, name: string) => {
      if (v === undefined) return 0;
      if (typeof v !== 'number' || v < 0) throw new Error(`Ticket template: "${id}.${name}" must be a number >= 0.`);
      return v;
    };
    return {
      id,
      title,
      aliases: list(o.aliases, `${id}.aliases`),
      hint: typeof o.hint === 'string' ? o.hint.trim() : '',
      requiredFor: list(o.required_for, `${id}.required_for`),
      warnFor: list(o.warn_for, `${id}.warn_for`),
      requiredIfMoney: o.required_if_money === true,
      minChars: num(o.min_chars, 'min_chars'),
      minItems: num(o.min_items, 'min_items'),
      ...(check ? { check: check as SectionCheck } : {})
    };
  });
  return { sections, moneyKeywords: list(r.money_keywords, 'money_keywords') };
}

export function loadTicketTemplate(file: string): TicketTemplate {
  return parseTicketTemplate(YAML.parse(fs.readFileSync(file, 'utf-8')));
}

// ── splitting a description into sections ───────────────────────────────────────────────────

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_`#]/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Which section a line opens, if it is a heading or a "Label:" line. */
function matchHeading(line: string, sections: TemplateSection[]): { id?: string; rest: string; heading: boolean } | undefined {
  const raw = line.trim();
  if (!raw) return undefined;
  const md = /^#{1,6}\s+(.*)$/.exec(raw);
  let head = (md ? md[1] : raw).replace(/^\*\*(.+?)\*\*\s*/, '$1 ').trim();
  head = head.replace(/^\d+[.)]\s+/, ''); // "1. Problem"
  const colon = head.indexOf(':');
  const label = colon >= 0 ? head.slice(0, colon) : head;
  const rest = colon >= 0 ? head.slice(colon + 1).trim() : '';
  const n = norm(label);
  if (!n || n.length > 60) return md ? { rest: '', heading: true } : undefined;
  for (const s of sections) {
    for (const name of [s.title, ...s.aliases]) {
      const nn = norm(name);
      if (!nn) continue;
      // A Markdown heading may say more ("Edge cases and money rules (if any)"); a plain line must
      // be exactly the label (optionally "Label: text"), so ordinary sentences are never headings.
      if (n === nn || (md && n.startsWith(`${nn} `))) return { id: s.id, rest, heading: true };
    }
  }
  return md ? { rest: '', heading: true } : undefined; // an unknown Markdown heading ends the section
}

/** Section id → its text. Text under an unknown heading belongs to no section. */
export function splitSections(text: string, template: TicketTemplate): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const h = matchHeading(line, template.sections);
    if (h) {
      current = h.id;
      if (current && !out.has(current)) out.set(current, '');
      if (current && h.rest) out.set(current, `${out.get(current)}${h.rest}\n`);
      continue;
    }
    if (current) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

/** Real content: placeholders (<...>), table rules and list markers removed. */
export function contentOf(s: string): string {
  return s
    .replace(/<[^<>\n]*>/g, ' ')
    .replace(/^[^\n]*\|[^\n]*\n\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/gm, ' ') // a table's header row + its rule
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ')
    .replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/gim, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const realChars = (s: string) => contentOf(s).replace(/[^\p{L}\p{N}]/gu, '').length;
const items = (s: string) =>
  s
    .split('\n')
    .map((l) => contentOf(l))
    .filter((l) => l.replace(/[^\p{L}\p{N}]/gu, '').length >= 5).length;

// ── checks ───────────────────────────────────────────────────────────────────────────────────

/** Repos the text names (whole-word match on any of their names). */
export function namedRepos(text: string, repos: KnownRepo[]): string[] {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9_-]+/g, ' ')} `;
  return repos.filter((r) => r.names.some((n) => n && t.includes(` ${n.toLowerCase()} `))).map((r) => r.id);
}

/** Path-like tokens: src/utils/x.ts, routes/withdraw, ./config/a.yaml. */
export function pathTokens(text: string): string[] {
  const found = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ').match(/(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)+/g) ?? [];
  return [...new Set(found.map((p) => p.replace(/^\.\//, '').replace(/[.:,;]+$/, '')).filter((p) => !/^https?$/i.test(p) && !p.includes('//')))];
}

export interface TemplateCheckInput {
  issueType?: string;
  /** The whole description as written (headings included). */
  description: string;
  /** Title, labels: used to detect money tickets. */
  title?: string;
  labels?: string[];
  /** Criteria from Jira's acceptance-criteria field (counted for the "ac" check). */
  acceptanceCriteria?: string[];
  repos?: KnownRepo[];
  /** Override for tests: does this file exist? */
  exists?: (p: string) => boolean;
}

export function checkTemplate(t: TicketTemplate, input: TemplateCheckInput): TemplateResult {
  const type = input.issueType || 'Story';
  const sections = splitSections(input.description, t);
  const hay = ` ${[input.title, input.description, ...(input.labels ?? [])].join(' ').toLowerCase()} `;
  const money = t.moneyKeywords.some((k) => new RegExp(`(^|[^a-z])${k.toLowerCase().replace(/[^a-z0-9]/g, '\\$&')}(s|es)?([^a-z]|$)`).test(hay));
  const exists = input.exists ?? ((p: string) => fs.existsSync(p));
  const rows: CheckRow[] = [];
  const gaps: string[] = [];
  let repos: string[] = [];

  for (const s of t.sections) {
    const role = sectionRole(s, type, money);
    if (role === 'none') continue;
    const required = role === 'required';
    const warnOnly = role === 'warn';
    const label = s.title;
    const why = required && s.requiredIfMoney && !s.requiredFor.includes(type) ? ' (required: the ticket mentions money)' : '';
    const body = sections.get(s.id);
    const extraItems = s.check === 'ac' ? (input.acceptanceCriteria ?? []).filter((c) => c.trim()) : [];
    const present = body !== undefined || extraItems.length > 0;
    const text = [body ?? '', ...extraItems].join('\n');
    const bad = (detail: string, gap: string) => {
      if (required) {
        rows.push({ check: label, status: 'fail', detail: `${detail}${why}` });
        gaps.push(gap);
      } else if (warnOnly) rows.push({ check: label, status: 'warn', detail });
      else rows.push({ check: label, status: 'skip', detail: 'optional, not given' });
    };
    const how = `${s.hint ? ` ${s.hint}` : ''}`;
    if (!present) {
      bad('heading missing', `Section "${s.title}" is missing. Add a heading "${s.title}".${how}`);
      continue;
    }
    if (realChars(text) < s.minChars) {
      bad('heading present but empty', `Section "${s.title}" is empty.${how}`);
      continue;
    }
    if (s.minItems && items(text) < s.minItems) {
      bad(`${items(text)} item(s), need ${s.minItems}`, `Section "${s.title}" needs at least ${s.minItems} item(s).${how}`);
      continue;
    }
    if (s.check === 'repo') {
      const known = input.repos ?? [];
      const named = namedRepos(text, known);
      if (!named.length) {
        const names = known.map((r) => r.names[1] || r.id).join(', ');
        bad(
          `names no known repo ("${contentOf(text).slice(0, 60)}")`,
          `Section "${s.title}" does not name a repo the pipeline knows. Use the Bitbucket repo name${names ? `: ${names}` : ''}.`
        );
        continue;
      }
      repos = named;
      rows.push({ check: label, status: 'pass', detail: named.join(', ') });
      continue;
    }
    if (s.check === 'paths') {
      const tokens = pathTokens(text);
      const clones = (input.repos ?? []).filter((r) => repos.includes(r.id) && r.path);
      if (tokens.length && clones.length) {
        const missing = tokens.filter((p) => !clones.some((r) => exists(path.join(r.path!, p))));
        if (missing.length) {
          rows.push({ check: label, status: 'warn', detail: `not found in ${clones.map((r) => r.id).join(', ')}: ${missing.join(', ')} (typo or renamed?)` });
          continue;
        }
        rows.push({ check: label, status: 'pass', detail: `${tokens.join(', ')} (found in the repo)` });
        continue;
      }
      rows.push({ check: label, status: 'pass', detail: tokens.length ? tokens.join(', ') : contentOf(text).slice(0, 60) });
      continue;
    }
    rows.push({ check: label, status: 'pass', detail: s.minItems ? `${items(text)} item(s)` : 'given' });
  }
  return { rows, gaps, repos, money };
}

/**
 * required: blocks when missing · warn: shown, never blocks · optional: listed only when given ·
 * none: not part of this issue type's template (e.g. "Steps to reproduce" on a Story).
 */
export function sectionRole(s: TemplateSection, issueType: string, money: boolean): 'required' | 'warn' | 'optional' | 'none' {
  if (s.requiredFor.includes(issueType) || (s.requiredIfMoney && money)) return 'required';
  if (s.warnFor.includes(issueType)) return 'warn';
  if (!s.requiredFor.length && !s.warnFor.length && !s.requiredIfMoney) return 'optional';
  return 'none';
}

// ── the copy-paste template ─────────────────────────────────────────────────────────────────

/** The template as Markdown for the Jira description, for one issue type. */
export function templateText(t: TicketTemplate, issueType = 'Story'): string {
  const L: string[] = [];
  for (const s of t.sections) {
    const role = sectionRole(s, issueType, false);
    const moneyOnly = role !== 'required' && s.requiredIfMoney;
    if (role === 'none' && !moneyOnly) continue;
    const tag = role === 'required' ? '' : moneyOnly ? ' (required if it touches money)' : role === 'warn' ? ' (recommended)' : ' (optional)';
    L.push(`### ${s.title}${tag}`);
    if (s.id === 'acceptance') L.push('1. AC1: Given <state>, when <action>, then <result>.', '2. AC2: ...');
    else if (s.id === 'examples') L.push('| Input | Expected output |', '| --- | --- |', '| <value or request> | <value or response> |');
    else if (s.id === 'steps') L.push('1. <step>', '2. <step>');
    else L.push(`<${s.hint}>`);
    L.push('');
  }
  return L.join('\n').trim();
}

export const CHECK_MARK: Record<CheckStatus, string> = { pass: '✓', fail: '✗', warn: '!', skip: '–' };

/** "✓ Problem — given" lines, aligned. */
export function renderChecks(rows: CheckRow[]): string[] {
  const w = Math.min(28, Math.max(...rows.map((r) => r.check.length), 0));
  return rows.map((r) => `${CHECK_MARK[r.status]} ${r.check.padEnd(w)}  ${r.detail}`);
}
