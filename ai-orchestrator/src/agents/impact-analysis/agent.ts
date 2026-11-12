import path from 'node:path';
import type { ImpactAnalysisResult, TaskInput } from '../../models/types.js';

export interface ImpactAnalysisRule {
  keywords: string[];
  repositories: string[];
  modules: string[];
  files?: string[];
}

export interface ImpactAnalysisAgentConfig {
  repositoriesDir?: string;
  customRules?: ImpactAnalysisRule[];
}

export interface IImpactAnalysisAgent {
  analyze(task: TaskInput): Promise<ImpactAnalysisResult>;
}

export class ImpactAnalysisAgent implements IImpactAnalysisAgent {
  private repositoriesDir: string;
  private customRules: ImpactAnalysisRule[];

  constructor(config: ImpactAnalysisAgentConfig = {}) {
    this.repositoriesDir = config.repositoriesDir || path.resolve(process.cwd(), 'repositories');
    this.customRules = config.customRules || [
      {
        keywords: ['payment', 'pay', 'checkout', 'charge', 'repo-a'],
        repositories: ['repo-a'],
        modules: ['payment-service', 'server'],
        files: ['repo-a/src/server.ts']
      },
      {
        keywords: ['order', 'cart', 'fulfillment', 'repo-b'],
        repositories: ['repo-b'],
        modules: ['order-service'],
        files: ['repo-b/src/index.ts']
      },
      {
        keywords: ['notification', 'email', 'sms', 'push', 'repo-c'],
        repositories: ['repo-c'],
        modules: ['notification-service'],
        files: ['repo-c/src/index.ts']
      },
      {
        // Multi-word phrases only: single generic words like "all"/"user" appear in most tickets.
        keywords: ['auth', 'shared', 'cross-service', 'all services', 'all repositories'],
        repositories: ['repo-a', 'repo-b'],
        modules: ['shared-auth', 'gateway'],
        files: ['repo-a/src/server.ts', 'repo-b/src/index.ts']
      }
    ];
  }

  async analyze(task: TaskInput): Promise<ImpactAnalysisResult> {
    if (!task || !task.id || !task.title) {
      throw new Error('ImpactAnalysisAgent Error: Invalid task input. Task ID and title are required.');
    }

    // Jira labels/components (if present) let tickets route explicitly, e.g. label "repo-b".
    const meta = task.metadata || {};
    const tags = [
      ...(Array.isArray(meta.labels) ? meta.labels : []),
      ...(Array.isArray(meta.components) ? meta.components : [])
    ].join(' ');

    const searchableText = `${task.id} ${task.title} ${task.description} ${task.acceptanceCriteria.join(' ')} ${tags}`.toLowerCase();

    const affectedRepos = new Set<string>();
    const affectedModules = new Set<string>();
    const affectedFiles = new Set<string>();

    for (const rule of this.customRules) {
      if (rule.keywords.some((kw) => matchesKeyword(searchableText, kw))) {
        for (const repo of rule.repositories) {
          affectedRepos.add(repo);
        }
        for (const mod of rule.modules) {
          affectedModules.add(mod);
        }
        for (const file of rule.files || []) {
          affectedFiles.add(file);
        }
      }
    }

    const repoList = Array.from(affectedRepos);
    const moduleList = Array.from(affectedModules);
    const fileList = Array.from(affectedFiles);

    // No silent fallback: an unmatched task must be triaged, not routed to an arbitrary repo.
    if (repoList.length === 0) {
      return {
        taskId: task.id,
        affectedRepositories: [],
        affectedModules: [],
        affectedFiles: [],
        confidence: 0,
        reasoning: 'No routing rule matched the task title, description, acceptance criteria, labels or components.'
      };
    }

    return {
      taskId: task.id,
      affectedRepositories: repoList,
      affectedModules: moduleList,
      affectedFiles: fileList,
      confidence: 0.95,
      reasoning: `Rule-based analysis identified ${repoList.length} affected repository/repositories (${repoList.join(', ')}) based on task scope.`
    };
  }
}

/**
 * Whole-word keyword match (case-insensitive), allowing a plural "s".
 * Prevents "pay" matching "payload", "all" matching "install", etc.
 */
export function matchesKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${escaped}s?(?![a-z0-9])`, 'i').test(text);
}
