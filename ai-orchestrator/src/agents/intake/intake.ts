import type { TaskInput } from '../../models/types.js';
import type { ComponentMap, ComponentResolution } from '../../catalog/component-map.js';
import type { PipelineConfig } from '../../config/pipeline-config.js';

/**
 * Intake: plain code, no AI. Runs before any tokens are spent and decides whether a ticket
 * may enter planning. Every gap is written for the reporter: what is missing and how to fix it.
 */

export interface IntakeResult {
  gaps: string[];
  /** Component → repo resolution (empty when there is no map). */
  components: ComponentResolution;
  product?: string;
  storyPoints?: number;
}

export function runIntake(task: TaskInput, config: PipelineConfig['intake'], componentMap?: ComponentMap): IntakeResult {
  const meta = task.metadata || {};
  const gaps: string[] = [];
  const title = (task.title || '').trim();
  const product = typeof meta.product === 'string' && meta.product.trim() ? meta.product.trim() : undefined;
  const storyPoints = typeof meta.storyPoints === 'number' ? meta.storyPoints : undefined;
  const issueType = typeof meta.issueType === 'string' ? meta.issueType : undefined;
  const ticketComponents = Array.isArray(meta.components) ? (meta.components as unknown[]).map(String) : [];
  const ticketLabels = Array.isArray(meta.labels) ? (meta.labels as unknown[]).map(String) : [];
  const components: ComponentResolution = componentMap
    ? componentMap.resolveTicket(ticketComponents, ticketLabels)
    : { repos: [], products: [], matched: [], unmapped: ticketComponents };

  if (!title || title === task.id) gaps.push('Summary/title is empty.');

  // The Jira client falls back to the title when the description is empty: that is no description.
  const description = (task.description || '').trim() === title ? '' : (task.description || '').trim();
  const written = [description, ...task.acceptanceCriteria].join('\n').trim();
  if (written.length < config.minDescriptionChars) {
    gaps.push(
      `Description is empty or too short (${written.length} of at least ${config.minDescriptionChars} characters). ` +
        'Add the expected behaviour, an example (input → expected result) and how to check it.'
    );
  }

  if (config.requireProduct && !product) {
    gaps.push(`Product is not set. Choose one of: ${config.allowedProducts.join(', ') || 'the Product field options'}.`);
  } else if (product && config.allowedProducts.length && !config.allowedProducts.includes(product)) {
    gaps.push(`Product "${product}" is not handled by the AI pipeline yet (handled: ${config.allowedProducts.join(', ')}).`);
  }

  if (config.requireComponent && components.repos.length === 0) {
    if (ticketComponents.length === 0) {
      gaps.push('No component (or area label from config/components.yaml) is set, so the target repository is unknown. Set the component of the affected service.');
    } else if (componentMap && components.repos.length === 0) {
      gaps.push(`Component ${ticketComponents.map((c) => `"${c}"`).join(', ')} has no repository mapping yet (config/components.yaml).`);
    }
  }

  if (config.allowedIssueTypes.length && issueType && !config.allowedIssueTypes.includes(issueType)) {
    gaps.push(`Issue type "${issueType}" is not handled yet (handled: ${config.allowedIssueTypes.join(', ')}).`);
  }

  if (config.maxStoryPoints > 0 && storyPoints !== undefined && storyPoints > config.maxStoryPoints) {
    gaps.push(`Too large for the AI pipeline: ${storyPoints} story points (max ${config.maxStoryPoints}). Split the ticket.`);
  }

  return { gaps, components, product, storyPoints };
}
