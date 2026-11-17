import fs from 'node:fs';
import { parse } from 'yaml';
import { SESSION_PHASES, type SessionPhase } from '../jobs/session-store.js';

/**
 * Pipeline limits and switches (config/pipeline.yaml).
 * Read fresh on every call, so edits apply without a restart. A missing file means defaults;
 * a broken file is an error (never silently run without limits).
 */

export interface PipelineConfig {
  killSwitch: boolean;
  /** Coding phase on/off. Off: "ai-approved" is acknowledged but no code is written. */
  coding: { enabled: boolean };
  promptVersion: string;
  planning: {
    /** "tools": only the six planner tools (MCP); "readonly": built-in Read/Glob/Grep. */
    engine: 'tools' | 'readonly';
    /** Jira projects jira_read may open, besides the ticket's own. */
    allowedJiraProjects: string[];
    model: string;
    maxTokensPerRun: number;
    maxCostUsdPerTicket: number;
    maxToolCalls: number;
    maxWallClockMin: number;
    maxQuestionRounds: number;
    maxPlanRevisions: number;
  };
  /** Project key → intake rules that differ from the defaults (e.g. T2 has no Product field). */
  projectIntake: Record<string, Partial<PipelineConfig['intake']>>;
  intake: {
    minDescriptionChars: number;
    requireProduct: boolean;
    allowedProducts: string[];
    requireComponent: boolean;
    allowedIssueTypes: string[];
    maxStoryPoints: number;
    assignToReporter: boolean;
  };
  jira: {
    productField?: string;
    storyPointsField?: string;
    /** Move tickets to the mapped workflow status when they change phase. Off until the mapping is agreed. */
    moveStatus: boolean;
    /** Project key → phase → existing Jira status name. */
    phaseStatus: Record<string, Partial<Record<SessionPhase, string>>>;
    /**
     * Status-driven triggers (optional). A ticket entering `plan` starts planning; entering `implement`
     * approves the plan and starts coding. Absent = labels only. The statuses must exist in Jira.
     */
    triggerStatus?: { plan: string; implement: string };
  };
  concurrency: { maxActiveSessions: number };
  timers: { escalateAfterH: number; remindAfterH: number; giveUpAfterH: number };
}

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
  killSwitch: false,
  coding: { enabled: false },
  promptVersion: 'planning-v1',
  planning: {
    engine: 'tools',
    allowedJiraProjects: [],
    model: '',
    maxTokensPerRun: 300000,
    maxCostUsdPerTicket: 5,
    maxToolCalls: 40,
    maxWallClockMin: 20,
    maxQuestionRounds: 2,
    maxPlanRevisions: 3
  },
  projectIntake: {},
  intake: {
    minDescriptionChars: 50,
    requireProduct: false,
    allowedProducts: [],
    requireComponent: false,
    allowedIssueTypes: [],
    maxStoryPoints: 0,
    assignToReporter: false
  },
  jira: { moveStatus: false, phaseStatus: {} },
  concurrency: { maxActiveSessions: 3 },
  timers: { escalateAfterH: 4, remindAfterH: 24, giveUpAfterH: 48 }
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : {});

function num(v: unknown, fallback: number, name: string): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`Pipeline config: "${name}" must be a number >= 0.`);
  return v;
}
function bool(v: unknown, fallback: boolean, name: string): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new Error(`Pipeline config: "${name}" must be true or false.`);
  return v;
}
function strs(v: unknown, fallback: string[], name: string): string[] {
  if (v === undefined || v === null) return fallback;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`Pipeline config: "${name}" must be a list of strings.`);
  return v as string[];
}
function str(v: unknown, fallback: string, name: string): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw new Error(`Pipeline config: "${name}" must be text.`);
  return v.trim();
}

/** Parses the YAML structure (snake_case keys) into a validated config. */
export function parsePipelineConfig(raw: unknown): PipelineConfig {
  const r = obj(raw);
  const d = DEFAULT_PIPELINE_CONFIG;
  const p = obj(r.planning);
  const i = obj(r.intake);
  const j = obj(r.jira);
  const c = obj(r.concurrency);
  const t = obj(r.timers);
  const model = str(p.model, d.planning.model, 'planning.model');
  if (/latest/i.test(model)) throw new Error('Pipeline config: pin "planning.model" to an exact model ID, never "latest".');
  const fieldId = (v: unknown, name: string) => {
    const s = str(v, '', name);
    if (s && !/^customfield_\d+$/.test(s)) throw new Error(`Pipeline config: "${name}" must look like customfield_12345.`);
    return s || undefined;
  };
  return {
    killSwitch: bool(r.kill_switch, d.killSwitch, 'kill_switch'),
    coding: { enabled: bool(obj(r.coding).enabled, d.coding.enabled, 'coding.enabled') },
    promptVersion: str(r.prompt_version, d.promptVersion, 'prompt_version') || d.promptVersion,
    planning: {
      engine: (() => {
        const e = str(p.engine, d.planning.engine, 'planning.engine');
        if (e !== 'tools' && e !== 'readonly') throw new Error('Pipeline config: "planning.engine" must be tools or readonly.');
        return e;
      })(),
      allowedJiraProjects: strs(p.allowed_jira_projects, d.planning.allowedJiraProjects, 'planning.allowed_jira_projects'),
      model,
      maxTokensPerRun: num(p.max_tokens_per_run, d.planning.maxTokensPerRun, 'planning.max_tokens_per_run'),
      maxCostUsdPerTicket: num(p.max_cost_usd_per_ticket, d.planning.maxCostUsdPerTicket, 'planning.max_cost_usd_per_ticket'),
      maxToolCalls: num(p.max_tool_calls, d.planning.maxToolCalls, 'planning.max_tool_calls'),
      maxWallClockMin: num(p.max_wall_clock_min, d.planning.maxWallClockMin, 'planning.max_wall_clock_min'),
      maxQuestionRounds: num(p.max_question_rounds, d.planning.maxQuestionRounds, 'planning.max_question_rounds'),
      maxPlanRevisions: num(p.max_plan_revisions, d.planning.maxPlanRevisions, 'planning.max_plan_revisions')
    },
    projectIntake: Object.fromEntries(
      Object.entries(obj(obj(r.projects))).map(([project, pv]) => {
        const pi = obj(obj(pv).intake);
        const o: Partial<PipelineConfig['intake']> = {};
        const n = `projects.${project}.intake`;
        if (pi.min_description_chars !== undefined) o.minDescriptionChars = num(pi.min_description_chars, 0, `${n}.min_description_chars`);
        if (pi.require_product !== undefined) o.requireProduct = bool(pi.require_product, false, `${n}.require_product`);
        if (pi.allowed_products !== undefined) o.allowedProducts = strs(pi.allowed_products, [], `${n}.allowed_products`);
        if (pi.require_component !== undefined) o.requireComponent = bool(pi.require_component, false, `${n}.require_component`);
        if (pi.allowed_issue_types !== undefined) o.allowedIssueTypes = strs(pi.allowed_issue_types, [], `${n}.allowed_issue_types`);
        if (pi.max_story_points !== undefined) o.maxStoryPoints = num(pi.max_story_points, 0, `${n}.max_story_points`);
        if (pi.assign_to_reporter !== undefined) o.assignToReporter = bool(pi.assign_to_reporter, false, `${n}.assign_to_reporter`);
        return [project.toUpperCase(), o];
      })
    ),
    intake: {
      minDescriptionChars: num(i.min_description_chars, d.intake.minDescriptionChars, 'intake.min_description_chars'),
      requireProduct: bool(i.require_product, d.intake.requireProduct, 'intake.require_product'),
      allowedProducts: strs(i.allowed_products, d.intake.allowedProducts, 'intake.allowed_products'),
      requireComponent: bool(i.require_component, d.intake.requireComponent, 'intake.require_component'),
      allowedIssueTypes: strs(i.allowed_issue_types, d.intake.allowedIssueTypes, 'intake.allowed_issue_types'),
      maxStoryPoints: num(i.max_story_points, d.intake.maxStoryPoints, 'intake.max_story_points'),
      assignToReporter: bool(i.assign_to_reporter, d.intake.assignToReporter, 'intake.assign_to_reporter')
    },
    jira: {
      productField: fieldId(j.product_field, 'jira.product_field'),
      storyPointsField: fieldId(j.story_points_field, 'jira.story_points_field'),
      moveStatus: bool(j.move_status, d.jira.moveStatus, 'jira.move_status'),
      triggerStatus: (() => {
        const t = obj(j.trigger_status);
        if (Object.keys(t).length === 0) return undefined;
        return {
          plan: str(t.plan, '', 'jira.trigger_status.plan'),
          implement: str(t.implement, '', 'jira.trigger_status.implement')
        };
      })(),
      phaseStatus: (() => {
        const out: Record<string, Partial<Record<SessionPhase, string>>> = {};
        for (const [project, map] of Object.entries(obj(j.phase_status))) {
          out[project.toUpperCase()] = {};
          for (const [phase, status] of Object.entries(obj(map))) {
            if (!SESSION_PHASES.includes(phase as SessionPhase)) {
              throw new Error(`Pipeline config: jira.phase_status.${project}.${phase} is not a phase (use: ${SESSION_PHASES.join(', ')}).`);
            }
            if (status === null || status === undefined || status === '') continue;
            out[project.toUpperCase()][phase as SessionPhase] = str(status, '', `jira.phase_status.${project}.${phase}`);
          }
        }
        return out;
      })()
    },
    concurrency: { maxActiveSessions: num(c.max_active_sessions, d.concurrency.maxActiveSessions, 'concurrency.max_active_sessions') },
    timers: {
      escalateAfterH: num(t.escalate_after_h, d.timers.escalateAfterH, 'timers.escalate_after_h'),
      remindAfterH: num(t.remind_after_h, d.timers.remindAfterH, 'timers.remind_after_h'),
      giveUpAfterH: num(t.give_up_after_h, d.timers.giveUpAfterH, 'timers.give_up_after_h')
    }
  };
}

/** Reads the config file now (not cached). */
export function loadPipelineConfig(filePath: string): PipelineConfig {
  if (!fs.existsSync(filePath)) return structuredClone(DEFAULT_PIPELINE_CONFIG);
  try {
    return parsePipelineConfig(parse(fs.readFileSync(filePath, 'utf-8')));
  } catch (err) {
    throw new Error(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Kill switch, checked before every step. On if AI_KILL_SWITCH=true, or the file says so,
 * or the file cannot be read (fail closed: an unreadable config must not mean "no limits").
 */
export function killSwitchOn(filePath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AI_KILL_SWITCH === 'true') return true;
  try {
    return loadPipelineConfig(filePath).killSwitch;
  } catch {
    return true;
  }
}

/** Intake rules for one ticket: the defaults with its project's overrides applied. */
export function intakeFor(cfg: PipelineConfig, ticket: string): PipelineConfig['intake'] {
  return { ...cfg.intake, ...(cfg.projectIntake[ticket.split('-')[0].toUpperCase()] || {}) };
}
