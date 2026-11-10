import path from 'node:path';
import type { AIProvider } from '../../../../models/types.js';
import { BaseRepoAgent } from '../base-repo-agent.js';

/**
 * RepoAgentA
 *
 * Dedicated sub-agent responsible exclusively for Repository A (repo-a / Payment Service).
 */
export class RepoAgentA extends BaseRepoAgent {
  constructor(aiProvider: AIProvider, repoPath?: string) {
    const resolvedPath = repoPath || path.resolve(process.cwd(), 'repositories', 'repo-a');
    super('repo-a', resolvedPath, aiProvider);
  }
}

