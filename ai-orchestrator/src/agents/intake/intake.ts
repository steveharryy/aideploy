import type { TaskInput } from '../../models/types.js';
import type { ComponentMap, ComponentResolution } from '../../catalog/component-map.js';
import type { PipelineConfig } from '../../config/pipeline-config.js';
import { checkTemplate, type CheckRow, type KnownRepo, type TicketTemplate } from './ticket-template.js';

/**
 * Intake: plain code, no AI. Runs before any tokens are spent and decides whether a ticket
 * may enter planning. Every gap is written for the reporter: what is missing and how to fix it.
 * Every check also gives a checklist row (pass / fail / warn / skip), shown on the ticket.
 */

export interface IntakeResult {
  gaps: string[];
  /** One row per check, in order: basic checks, then the ticket template sections. */
  checks: CheckRow[];
  /** Component → repo resolution (empty when there is no map). */
  components: ComponentResolution;
  product?: string;
  storyPoints?: number;
  /** Repos named in the template's "Target repo" section (catalog ids). */
  templateRepos?: string[];
  /** The template was checked (on for this project and the ticket is new enough). */
  templateChecked: boolean;
}

export interface IntakeOptions {
  /** The standard ticket template; checked when the project's intake.template is on. */
  template?: TicketTemplate;
  /** Repos a ticket may name (catalog), for the "Target repo" and "Source location" checks. */
  repos?: KnownRepo[];
  /** Test hook for "does this source path exist". */
  exists?: (p: string) => boolean;
}

export function runIntake(task: TaskInput, config: PipelineConfig['intake'], componentMap?: ComponentMap, options: IntakeOptions = {}): IntakeResult {
  const meta = task.metadata || {};
  const gaps: string[] = [];
  const checks: CheckRow[] = [];
  const pass = (check: string, detail: string) => checks.push({ check, status: 'pass', detail });
  const fail = (check: string, detail: string, gap: string) => {
    checks.push({ check, status: 'fail', detail });
    gaps.push(gap);
  };
  const title = (task.title || '').trim();
  const product = typeof meta.product === 'string' && meta.product.trim() ? meta.product.trim() : undefined;
  const storyPoints = typeof meta.storyPoints === 'number' ? meta.storyPoints : undefined;
  const issueType = typeof meta.issueType === 'string' ? meta.issueType : undefined;
  const ticketComponents = Array.isArray(meta.components) ? (meta.components as unknown[]).map(String) : [];
  const ticketLabels = Array.isArray(meta.labels) ? (meta.labels as unknown[]).map(String) : [];
  const components: ComponentResolution = componentMap
    ? componentMap.resolveTicket(ticketComponents, ticketLabels)
    : { repos: [], products: [], matched: [], unmapped: ticketComponents };

  if (!title || title === task.id) fail('Summary', 'empty', 'Summary/title is empty.');
  else pass('Summary', 'given');

  if (config.allowedIssueTypes.length && issueType && !config.allowedIssueTypes.includes(issueType)) {
    fail('Issue type', `"${issueType}" not handled`, `Issue type "${issueType}" is not handled yet (handled: ${config.allowedIssueTypes.join(', ')}).`);
  } else pass('Issue type', issueType || 'not set (treated as Story)');

  // The Jira client falls back to the title when the description is empty: that is no description.
  const description = (task.description || '').trim() === title ? '' : (task.description || '').trim();
  const written = [description, ...task.acceptanceCriteria].join('\n').trim();
  if (written.length < config.minDescriptionChars) {
    fail(
      'Description length',
      `${written.length} of ${config.minDescriptionChars} characters`,
      `Description is empty or too short (${written.length} of at least ${config.minDescriptionChars} characters). ` +
        'Add the expected behaviour, an example (input → expected result) and how to check it.'
    );
  } else pass('Description length', `${written.length} characters`);

  if (config.requireProduct && !product) {
    fail('Product', 'not set', `Product is not set. Choose one of: ${config.allowedProducts.join(', ') || 'the Product field options'}.`);
  } else if (product && config.allowedProducts.length && !config.allowedProducts.includes(product)) {
    fail('Product', `"${product}" not handled`, `Product "${product}" is not handled by the AI pipeline yet (handled: ${config.allowedProducts.join(', ')}).`);
  } else if (product) pass('Product', product);
  else checks.push({ check: 'Product', status: 'skip', detail: 'not required for this project' });

  if (config.requireComponent && components.repos.length === 0) {
    if (ticketComponents.length === 0) {
      fail('Component / area', 'none set', 'No component (or area label from config/components.yaml) is set, so the target repository is unknown. Set the component of the affected service.');
    } else if (componentMap) {
      fail('Component / area', 'no repo mapping', `Component ${ticketComponents.map((c) => `"${c}"`).join(', ')} has no repository mapping yet (config/components.yaml).`);
    } else checks.push({ check: 'Component / area', status: 'warn', detail: 'no component map loaded' });
  } else if (components.repos.length) pass('Component / area', `${components.matched.join(', ')} → ${components.repos.join(', ')}`);
  else checks.push({ check: 'Component / area', status: 'skip', detail: 'not required for this project' });

  if (config.maxStoryPoints > 0 && storyPoints !== undefined && storyPoints > config.maxStoryPoints) {
    fail('Size', `${storyPoints} story points (max ${config.maxStoryPoints})`, `Too large for the AI pipeline: ${storyPoints} story points (max ${config.maxStoryPoints}). Split the ticket.`);
  } else if (storyPoints !== undefined) pass('Size', `${storyPoints} story points${config.maxStoryPoints ? ` (max ${config.maxStoryPoints})` : ''}`);
  else checks.push({ check: 'Size', status: 'skip', detail: 'no estimate' });

  // The standard ticket template: only for tickets created on/after template_applies_from.
  let templateRepos: string[] | undefined;
  const created = typeof meta.created === 'string' ? Date.parse(meta.created) : NaN;
  const from = config.templateAppliesFrom ? Date.parse(config.templateAppliesFrom) : NaN;
  const tooOld = !Number.isNaN(from) && !Number.isNaN(created) && created < from;
  const templateChecked = !!(config.template && options.template && !tooOld);
  if (config.template && options.template && tooOld) {
    checks.push({ check: 'Ticket template', status: 'skip', detail: `created before ${config.templateAppliesFrom}` });
  }
  if (templateChecked) {
    const raw = typeof meta.descriptionText === 'string' && meta.descriptionText.trim() ? (meta.descriptionText as string) : description;
    const r = checkTemplate(options.template!, {
      issueType,
      description: raw,
      title,
      labels: ticketLabels,
      // Jira's acceptance-criteria field (when used) is not in the description text.
      acceptanceCriteria: typeof meta.descriptionText === 'string' ? (meta.acFieldCriteria as string[] | undefined) : task.acceptanceCriteria,
      repos: options.repos,
      exists: options.exists
    });
    checks.push(...r.rows);
    gaps.push(...r.gaps);
    templateRepos = r.repos;
    // Two sources for the repo must agree: the component map and what the reporter wrote.
    if (r.repos.length && components.repos.length && !r.repos.some((x) => components.repos.includes(x))) {
      checks.push({
        check: 'Repo agreement',
        status: 'warn',
        detail: `"Target repo" says ${r.repos.join(', ')} but the component/labels map to ${components.repos.join(', ')}`
      });
    }
  }

  return { gaps, checks, components, product, storyPoints, templateChecked, ...(templateRepos ? { templateRepos } : {}) };
}
