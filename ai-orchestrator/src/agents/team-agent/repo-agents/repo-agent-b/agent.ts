import path from 'node:path';
import type { AIProvider } from '../../../../models/types.js';
import { BaseRepoAgent } from '../base-repo-agent.js';

/**
 * RepoAgentB
 *
 * Dedicated sub-agent responsible exclusively for Repository B (repo-b / Order Service).
 */
export class RepoAgentB extends BaseRepoAgent {
  constructor(aiProvider: AIProvider, repoPath?: string) {
    const resolvedPath = repoPath || path.resolve(process.cwd(), 'repositories', 'repo-b');
    super('repo-b', resolvedPath, aiProvider);
  }
}

