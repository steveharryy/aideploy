import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface BitbucketRepoRef {
  workspace: string;
  repo: string;
}

export interface PullRequestInput extends BitbucketRepoRef {
  sourceBranch: string;
  destinationBranch: string;
  title: string;
  description: string;
}

export interface PullRequestResult {
  id: number;
  url: string;
  /** True when an open PR for this branch already existed and was reused. */
  existing: boolean;
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export interface BitbucketClientConfig {
  /** Repository/workspace access token (Bearer). Preferred for automation. */
  token?: string;
  /** Alternative: Atlassian account email + scoped API token (Basic auth). */
  email?: string;
  apiToken?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  git?: GitRunner;
}

const defaultGit: GitRunner = async (cwd, args) => {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
};

/**
 * BitbucketClient
 *
 * Pushes an AI ticket branch and opens a pull request on Bitbucket Cloud.
 * Guardrails (enforced in code, not prompts):
 *  - only branches named ai/* can be pushed (never main/develop/release),
 *  - it never merges; merging stays with a human reviewer,
 *  - an existing open PR for the branch is reused instead of creating a duplicate.
 */
export class BitbucketClient {
  private token?: string;
  private email?: string;
  private apiToken?: string;
  private apiBase: string;
  private fetchImpl: typeof fetch;
  private git: GitRunner;

  constructor(config: BitbucketClientConfig = {}) {
    this.token = config.token ?? process.env.BITBUCKET_TOKEN;
    this.email = config.email ?? process.env.BITBUCKET_EMAIL;
    this.apiToken = config.apiToken ?? process.env.BITBUCKET_API_TOKEN;
    this.apiBase = (config.apiBase || process.env.BITBUCKET_API_BASE || 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');
    this.fetchImpl = config.fetchImpl || fetch;
    this.git = config.git || defaultGit;
  }

  /** True when API credentials are configured (needed to create PRs). */
  get configured(): boolean {
    return Boolean(this.token || (this.email && this.apiToken));
  }

  private authHeader(): string {
    if (this.token) return `Bearer ${this.token}`;
    if (this.email && this.apiToken) return `Basic ${Buffer.from(`${this.email}:${this.apiToken}`).toString('base64')}`;
    throw new Error('Bitbucket is not configured: set BITBUCKET_TOKEN (repository access token) or BITBUCKET_EMAIL + BITBUCKET_API_TOKEN.');
  }

  static assertPushableBranch(branch: string): void {
    if (!/^ai\/[a-z0-9._-]+$/i.test(branch)) {
      throw new Error(`Refusing to push "${branch}": only ai/* ticket branches may be pushed by the orchestrator.`);
    }
  }

  /** Pushes the ticket branch from its worktree. Uses the API credentials if set, else git's own (e.g. SSH). */
  async pushBranch(workdir: string, branch: string, ref: BitbucketRepoRef): Promise<void> {
    BitbucketClient.assertPushableBranch(branch);
    if (this.configured) {
      const url = `https://bitbucket.org/${ref.workspace}/${ref.repo}.git`;
      // Credentials go in a one-off header, never into the remote URL or logs.
      await this.git(workdir, ['-c', `http.extraHeader=Authorization: ${this.authHeader()}`, 'push', url, `${branch}:${branch}`]);
    } else {
      await this.git(workdir, ['push', 'origin', `${branch}:${branch}`]);
    }
  }

  private async api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
    const text = await res.text();
    const body = (text ? JSON.parse(text) : undefined) as T;
    if (!res.ok && res.status !== 400 && res.status !== 409) {
      throw new Error(`Bitbucket API ${res.status}: ${text.slice(0, 300)}`);
    }
    return { status: res.status, body };
  }

  async findOpenPullRequest(ref: BitbucketRepoRef, sourceBranch: string): Promise<PullRequestResult | undefined> {
    const q = encodeURIComponent(`source.branch.name="${sourceBranch}" AND state="OPEN"`);
    const { body } = await this.api<{ values?: Array<{ id: number; links?: { html?: { href?: string } } }> }>(
      `/repositories/${ref.workspace}/${ref.repo}/pullrequests?q=${q}`
    );
    const pr = body?.values?.[0];
    return pr ? { id: pr.id, url: pr.links?.html?.href || '', existing: true } : undefined;
  }

  /** Opens a PR (never merges). Reuses an open PR for the same branch if one exists. */
  async createPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    BitbucketClient.assertPushableBranch(input.sourceBranch);
    const existing = await this.findOpenPullRequest(input, input.sourceBranch);
    if (existing) return existing;

    const { status, body } = await this.api<{ id?: number; links?: { html?: { href?: string } }; error?: { message?: string } }>(
      `/repositories/${input.workspace}/${input.repo}/pullrequests`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: input.title.slice(0, 255),
          description: input.description,
          source: { branch: { name: input.sourceBranch } },
          destination: { branch: { name: input.destinationBranch } },
          close_source_branch: true
        })
      }
    );
    if (status >= 400 || !body?.id) {
      throw new Error(`Bitbucket could not create the PR: ${body?.error?.message || `HTTP ${status}`}`);
    }
    return { id: body.id, url: body.links?.html?.href || '', existing: false };
  }
}
