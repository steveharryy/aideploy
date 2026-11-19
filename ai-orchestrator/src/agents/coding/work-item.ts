import type { TaskInput } from '../../models/types.js';
import type { ImplementationPlan } from '../../providers/claude-code-provider.js';
import { isTestFile } from '../team-agent/repo-agents/test-integrity.js';

/**
 * WorkItem: the contract between the PLANNING agent (produces it) and the CODING agent (consumes it).
 * One work item = one repo. JSON Schema: schemas/work-item.schema.json. Example: examples/work-item.example.json.
 */
export interface WorkItem {
  /** Jira ticket key, e.g. "T2-547". */
  ticket: string;
  /** Work item id within the plan, e.g. "W1". */
  workItemId: string;
  /** Repo id from catalog/repos.yaml. The coding agent never switches repos. */
  repo: string;
  title: string;
  /** What to build, in one or two sentences. */
  summary: string;
  acceptanceCriteria: Array<{ id: string; text: string }>;
  /** Tests the coding agent must write first. Each entry covers one AC id. */
  testPlan: Array<{ ac: string; name: string; description: string }>;
  /** Files the plan expects to change (scope). Optional; edits outside need a reason. */
  plannedFiles?: Array<{ path: string; change: string }>;
  /** Shared contract with other repos (API shapes, message formats). Never changed by the coding agent. */
  contract?: string;
  /** Planning assumptions the coding agent must respect. */
  assumptions?: string[];
  /** Answers to earlier ask_user questions (filled on re-runs). */
  clarifications?: string[];
  /**
   * The approved plan says the repo's existing tests are already broken on the base branch and
   * must be repaired first. Only these files may change for it, and only test files or
   * test-runner config (never source). Without this, a red baseline stops the agent.
   */
  baselineFix?: { files: string[]; reason: string };
  /**
   * Open QA defects from an earlier attempt (AI QA sent the work back to AI Dev). Each must be fixed;
   * the QA agent re-checks them by ID. Filled by the pipeline, never by the planner.
   */
  qaFindings?: Array<{ id: string; title: string; criterion?: string; expected?: string; actual?: string; repro?: string }>;
}

/** Test-runner / build config files (package.json, tsconfig*.json, jest/vitest config, pytest config). */
export function isTestRunnerConfig(p: string): boolean {
  return /(^|\/)(package\.json|tsconfig[^/]*\.json|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|pytest\.ini|setup\.cfg|pyproject\.toml)$/.test(p);
}

/** Files a baseline fix may touch: tests and test-runner config, never application source. */
export function isBaselineFixFile(p: string): boolean {
  return isTestFile(p) || isTestRunnerConfig(p);
}

const AC_ID = /^AC-?\d+$/i;

/** Normalises "AC-1" / "ac1" to "AC1". */
export function normaliseAcId(id: string): string {
  return id.toUpperCase().replace('-', '');
}

/** Validates a work item; returns a list of human-readable problems (empty = valid). */
export function validateWorkItem(input: unknown): string[] {
  const errors: string[] = [];
  const w = input as Partial<WorkItem> | null;
  if (!w || typeof w !== 'object') return ['work item must be a JSON object'];

  for (const key of ['ticket', 'workItemId', 'repo', 'title', 'summary'] as const) {
    if (typeof w[key] !== 'string' || !(w[key] as string).trim()) errors.push(`"${key}" must be a non-empty string`);
  }

  if (!Array.isArray(w.acceptanceCriteria) || w.acceptanceCriteria.length === 0) {
    errors.push('"acceptanceCriteria" must be a non-empty array');
  } else {
    const seen = new Set<string>();
    w.acceptanceCriteria.forEach((ac, i) => {
      if (!ac || typeof ac.id !== 'string' || !AC_ID.test(ac.id)) errors.push(`acceptanceCriteria[${i}].id must look like "AC1"`);
      else if (seen.has(normaliseAcId(ac.id))) errors.push(`acceptanceCriteria[${i}].id "${ac.id}" is duplicated`);
      else seen.add(normaliseAcId(ac.id));
      if (!ac || typeof ac.text !== 'string' || !ac.text.trim()) errors.push(`acceptanceCriteria[${i}].text must be a non-empty string`);
    });

    if (!Array.isArray(w.testPlan) || w.testPlan.length === 0) {
      errors.push('"testPlan" must be a non-empty array (tests are written first)');
    } else {
      w.testPlan.forEach((t, i) => {
        if (!t || typeof t.ac !== 'string' || !seen.has(normaliseAcId(t.ac))) errors.push(`testPlan[${i}].ac must reference an existing acceptance criterion`);
        if (!t || typeof t.name !== 'string' || !t.name.trim()) errors.push(`testPlan[${i}].name must be a non-empty string`);
        if (!t || typeof t.description !== 'string') errors.push(`testPlan[${i}].description must be a string`);
      });
      const covered = new Set(w.testPlan.filter((t) => t && typeof t.ac === 'string').map((t) => normaliseAcId(t.ac)));
      for (const id of seen) if (!covered.has(id)) errors.push(`testPlan has no test for ${id}`);
    }
  }

  if (w.plannedFiles !== undefined) {
    if (!Array.isArray(w.plannedFiles)) errors.push('"plannedFiles" must be an array');
    else
      w.plannedFiles.forEach((f, i) => {
        if (!f || typeof f.path !== 'string' || !f.path.trim()) errors.push(`plannedFiles[${i}].path must be a non-empty string`);
        else if (f.path.startsWith('/') || f.path.split('/').includes('..')) errors.push(`plannedFiles[${i}].path must be repo-relative`);
      });
  }
  for (const key of ['assumptions', 'clarifications'] as const) {
    if (w[key] !== undefined && (!Array.isArray(w[key]) || (w[key] as unknown[]).some((x) => typeof x !== 'string'))) {
      errors.push(`"${key}" must be an array of strings`);
    }
  }
  if (w.contract !== undefined && typeof w.contract !== 'string') errors.push('"contract" must be a string');
  if (w.baselineFix !== undefined) {
    const b = w.baselineFix;
    if (!b || typeof b !== 'object' || !Array.isArray(b.files) || b.files.length === 0) errors.push('"baselineFix.files" must be a non-empty array');
    else
      b.files.forEach((f, i) => {
        if (typeof f !== 'string' || !f.trim() || f.startsWith('/') || f.split('/').includes('..')) errors.push(`baselineFix.files[${i}] must be a repo-relative path`);
        else if (!isBaselineFixFile(f)) errors.push(`baselineFix.files[${i}] "${f}" is not a test or test-runner config file (source files are never part of a baseline fix)`);
      });
    if (!b || typeof b.reason !== 'string' || !b.reason.trim()) errors.push('"baselineFix.reason" must be a non-empty string');
  }
  return errors;
}

/** Slug for test names: "Response contains status UP" → "response_contains_status_up". */
function slug(text: string, max = 40): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max).replace(/_+$/, '');
}

/**
 * Builds a work item from a Jira task + (optional) approved change plan, until the planning
 * agent produces work items itself. If the task already carries planning-agent work items
 * (task.metadata.workItems), the one for this repo is used as-is.
 */
export function workItemFromTask(task: TaskInput, repo: string, plan?: ImplementationPlan): WorkItem {
  const provided = (task.metadata?.workItems as WorkItem[] | undefined)?.find((w) => w.repo === repo);
  if (provided) return provided;

  const acceptanceCriteria = (task.acceptanceCriteria.length ? task.acceptanceCriteria : [task.title]).map((text, i) => ({
    id: `AC${i + 1}`,
    text
  }));

  const planned = (plan?.testsToAdd || []).filter((t) => t?.name);
  const testPlan = acceptanceCriteria.map((ac) => {
    const fromPlan = planned.find((t) => (t.covers || '').toUpperCase().replace('-', '').split(/[^A-Z0-9]+/).includes(ac.id));
    return {
      ac: ac.id,
      name: `test_${ac.id}_${slug(fromPlan?.name || ac.text)}`,
      description: fromPlan?.name || ac.text
    };
  });

  return {
    ticket: task.id,
    workItemId: 'W1',
    repo,
    title: task.title,
    summary: plan?.summary || task.description.slice(0, 500) || task.title,
    acceptanceCriteria,
    testPlan,
    plannedFiles: plan?.filesToChange?.filter((f) => f?.path).map((f) => ({ path: f.path, change: f.change || '' })),
    clarifications: ((task.metadata?.comments as Array<{ author: string; body: string }>) || [])
      .slice(-10)
      .map((c) => `${c.author}: ${c.body}`)
  };
}
