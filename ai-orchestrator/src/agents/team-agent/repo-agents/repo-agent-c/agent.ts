import path from 'node:path';
import type { AIProvider } from '../../../../models/types.js';
import { BaseRepoAgent } from '../base-repo-agent.js';

/**
 * RepoAgentC
 *
 * Dedicated sub-agent responsible exclusively for Repository C (repo-c / Notification Service).
 */
export class RepoAgentC extends BaseRepoAgent {
  constructor(aiProvider: AIProvider, repoPath?: string) {
    const resolvedPath = repoPath || path.resolve(process.cwd(), 'repositories', 'repo-c');
    super('repo-c', resolvedPath, aiProvider);
  }
}

