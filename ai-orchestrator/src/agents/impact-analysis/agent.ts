import fs from 'node:fs/promises';
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
        keywords: ['auth', 'user', 'shared', 'all', 'cross-service'],
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

    const searchableText = `${task.id} ${task.title} ${task.description} ${task.acceptanceCriteria.join(' ')}`.toLowerCase();

    const affectedRepos = new Set<string>();
    const affectedModules = new Set<string>();
    const affectedFiles = new Set<string>();

    for (const rule of this.customRules) {
      if (rule.keywords.some((kw) => searchableText.includes(kw.toLowerCase()))) {
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

    // If no explicit keyword matched, discover available repos from disk or fallback to repo-a
    if (affectedRepos.size === 0) {
      try {
        const entries = await fs.readdir(this.repositoriesDir, { withFileTypes: true });
        const availableRepos = entries.filter((e) => e.isDirectory()).map((e) => e.name);
        if (availableRepos.length > 0) {
          affectedRepos.add(availableRepos[0]);
          affectedModules.add('core');
        } else {
          affectedRepos.add('repo-a');
          affectedModules.add('core');
        }
      } catch {
        affectedRepos.add('repo-a');
        affectedModules.add('core');
      }
    }

    const repoList = Array.from(affectedRepos);
    const moduleList = Array.from(affectedModules);
    const fileList = affectedFiles.size > 0
      ? Array.from(affectedFiles)
      : repoList.map((r) => `${r}/src/index.ts`);

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
