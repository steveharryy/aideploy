import type { AIProvider, AIProviderGenerateOptions, AIProviderResponse } from '../models/types.js';
import type { VerifyCommand } from '../catalog/service-catalog.js';
import type { ImplementationPlan } from './claude-code-provider.js';
import { CodingAgent, type CodingAgentConfig, type CodingReport } from '../agents/coding/coding-agent.js';
import { workItemFromTask } from '../agents/coding/work-item.js';

export interface CodingAgentProviderConfig {
  verifyFor: (repoId: string) => VerifyCommand[];
  purposeFor?: (repoId: string) => string | undefined;
  agent?: CodingAgentConfig;
  /**
   * Receives every report (e.g. saved to .jobs/<ticket>/coding-<repo>.json) and, when it is
   * ready_for_pr, the unified diff of the change (e.g. .jobs/<ticket>/changes-<repo>.diff).
   */
  onReport?: (report: CodingReport, diff: string) => void;
}

/** Human-readable one-block summary of a coding report. */
export function formatCodingReport(r: CodingReport): string {
  const lines = [
    `Coding agent ${r.ticket} ${r.workItem} [${r.repo}]: ${r.status.toUpperCase()} — ${r.summary}`,
    ...r.acceptanceCriteria.map((a) => `  ${a.id} ${a.status}${a.evidence.length ? `: ${a.evidence.slice(0, 3).join('; ')}` : ''}`),
    `  tests-first: baseline ${r.testsFirst.baselinePassed ? 'green' : 'not green'}, new tests ${r.testsFirst.failedBeforeChange ? 'failed before the change ✓' : 'not proven red'}`,
    `  checks: ${r.checks.map((c) => `${c.name} ${c.passed ? '✓' : '✗'}`).join(', ') || '-'}`,
    `  review: ${r.review.verdict} after ${r.review.rounds} round(s)${r.review.findings.length ? `, ${r.review.findings.length} finding(s)` : ''}`,
    `  iterations: ${r.iterationsUsed}/${r.maxIterations}, Claude calls: ${r.claudeCalls}, ${Math.round(r.durationMs / 1000)}s`
  ];
  for (const f of r.fixRounds) lines.push(`  fix round ${f.round} (${f.phase}): ${f.problems.join(' | ').slice(0, 300)}`);
  if (r.scope.revertedFiles.length) lines.push(`  reverted: ${r.scope.revertedFiles.join('; ')}`);
  if (r.scope.outOfPlan.length) lines.push(`  outside plan: ${r.scope.outOfPlan.map((o) => `${o.path} (${o.reason ?? 'no reason'})`).join('; ')}`);
  if (r.questions.length) lines.push('  questions:', ...r.questions.map((q) => `    - ${q}`));
  if (r.escalation) lines.push(`  escalation: ${r.escalation}`);
  if (r.openIssues.length) lines.push('  open issues:', ...r.openIssues.map((i) => `    - ${i.split('\n')[0]}`));
  return lines.join('\n');
}

/**
 * Plugs the CodingAgent into the orchestrator pipeline as an AIProvider:
 * work item (from the planning agent, or derived from the approved plan) → CodingAgent →
 * file changes. The pipeline then applies them through the Repo Agent's guards and
 * re-runs the verify contract itself.
 */
export class CodingAgentProvider implements AIProvider {
  public readonly name = 'coding-agent';

  constructor(private config: CodingAgentProviderConfig) {}

  async generateChanges(options: AIProviderGenerateOptions): Promise<AIProviderResponse> {
    const { task, repoContext } = options;
    const plan = (task.metadata?.approvedPlans as Record<string, ImplementationPlan> | undefined)?.[repoContext.repoId];
    const workItem = workItemFromTask(task, repoContext.repoId, plan);

    const { report, changes, diff } = await new CodingAgent(this.config.agent).run({
      workItem,
      repoPath: repoContext.repoPath,
      verify: this.config.verifyFor(repoContext.repoId),
      repoPurpose: this.config.purposeFor?.(repoContext.repoId)
    });
    this.config.onReport?.(report, diff);

    if (report.status !== 'ready_for_pr') {
      // needs_input / escalated / failed: nothing is applied; the reason (and any questions) go to the caller.
      throw new Error(formatCodingReport(report));
    }
    return {
      providerName: this.name,
      reasoning: formatCodingReport(report),
      fileChanges: changes,
      rawResponse: JSON.stringify(report)
    };
  }
}
