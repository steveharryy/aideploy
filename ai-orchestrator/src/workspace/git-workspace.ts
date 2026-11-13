import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TaskInput } from '../models/types.js';

const execFileAsync = promisify(execFile);

/** Where one repo's work for one ticket happens. */
export interface RepoWorkspace {
  repoId: string;
  /** Directory the repo agent and tests run in. */
  workdir: string;
  /** True when work happens on an isolated git branch + worktree. */
  managedByGit: boolean;
  branch?: string;
  baseRef?: string;
}

export interface IWorkspaceManager {
  prepare(task: TaskInput, repoId: string, repoPath: string, baseBranch?: string): Promise<RepoWorkspace>;
  /** Commits the ticket's changes on its branch. Returns the commit SHA, or undefined if nothing changed. */
  commit(task: TaskInput, workspace: RepoWorkspace): Promise<string | undefined>;
}

export interface GitWorkspaceConfig {
  /** Where worktrees are created (default ./.worktrees). */
  worktreesDir?: string;
  /** Branch name prefix (default "ai/"). */
  branchPrefix?: string;
  /** Extra `git -c ...` args for talking to the remote (e.g. a host-scoped auth header for fetch). */
  remoteGitArgs?: () => string[];
  log?: (message: string) => void;
}

/** Never committed, whatever the repo's .gitignore says (install/build output, local secrets). */
export const NEVER_COMMIT = [
  ':(exclude,glob)**/node_modules/**',
  ':(exclude,glob)**/dist/**',
  ':(exclude,glob)**/coverage/**',
  ':(exclude,glob)**/.env',
  ':(exclude,glob)**/.env.*'
];

async function git(cwd: string, args: string[]): Promise<string> {
  // No interactive credential prompts: a missing login must fail fast, not hang the watcher.
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return stdout.trim();
}

/**
 * GitWorkspaceManager
 *
 * Gives every ticket its own branch (ai/<ticket>) and git worktree per repo, so:
 *  - the developer's own checkout is never modified,
 *  - a failed run leaves nothing on the base branch (just delete the branch/worktree),
 *  - each repo's changes end up as one reviewable commit, ready for a PR.
 *
 * Repos that are not the root of their own git repository (e.g. the sample repos,
 * which live inside the orchestrator's repo) are worked on in place, exactly as before.
 * This class never pushes; publishing (push + PR) is a separate, explicit step.
 */
export class GitWorkspaceManager implements IWorkspaceManager {
  private worktreesDir: string;
  private branchPrefix: string;
  private remoteGitArgs: () => string[];
  private log: (message: string) => void;

  constructor(config: GitWorkspaceConfig = {}) {
    this.worktreesDir = config.worktreesDir || path.resolve(process.cwd(), '.worktrees');
    this.branchPrefix = config.branchPrefix ?? 'ai/';
    this.remoteGitArgs = config.remoteGitArgs ?? (() => []);
    this.log = config.log ?? (() => {});
  }

  /**
   * Where a new ticket branch starts. With an "origin" remote, the base branch is fetched first and
   * origin/<base> is used, so the PR starts from the latest code, not from a stale local checkout.
   */
  private async resolveBaseRef(repoPath: string, baseBranch?: string): Promise<string> {
    if (!baseBranch) return 'HEAD';
    const remotes = await git(repoPath, ['remote']).catch(() => '');
    if (!remotes.split('\n').includes('origin')) return baseBranch;
    const remoteRef = `refs/remotes/origin/${baseBranch}`;
    try {
      await git(repoPath, [...this.remoteGitArgs(), 'fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:${remoteRef}`]);
    } catch (err) {
      const message = err instanceof Error ? err.message.split('\n')[0] : String(err);
      this.log(`Could not fetch origin/${baseBranch} (${message}); using the last fetched copy.`);
    }
    const hasRemote = await git(repoPath, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]).then(() => true, () => false);
    return hasRemote ? `origin/${baseBranch}` : baseBranch;
  }

  static branchName(prefix: string, ticketId: string): string {
    return `${prefix}${ticketId.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`;
  }

  /** True only if repoPath is the top level of its own git repository. */
  static async isGitRepoRoot(repoPath: string): Promise<boolean> {
    try {
      const top = await git(repoPath, ['rev-parse', '--show-toplevel']);
      return fs.realpathSync(top) === fs.realpathSync(repoPath);
    } catch {
      return false;
    }
  }

  /**
   * A temporary, detached checkout of the LATEST base branch for read-only work (planning), so a plan
   * describes the same code the coding agent will start from, not whatever the clone has checked out.
   * Returns undefined for non-git folders or when no base branch is configured. Always call cleanup().
   */
  async snapshot(
    repoPath: string,
    baseBranch: string | undefined,
    label: string
  ): Promise<{ dir: string; ref: string; commit: string; cleanup: () => Promise<void> } | undefined> {
    if (!baseBranch || !(await GitWorkspaceManager.isGitRepoRoot(repoPath))) return undefined;
    const ref = await this.resolveBaseRef(repoPath, baseBranch);
    const dir = path.join(this.worktreesDir, '_snapshots', `${label.replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repoPath, ['worktree', 'add', '--detach', dir, ref]);
    const commit = await git(dir, ['rev-parse', '--short', 'HEAD']);
    const cleanup = async () => {
      await git(repoPath, ['worktree', 'remove', '--force', dir]).catch(() => fs.rmSync(dir, { recursive: true, force: true }));
      await git(repoPath, ['worktree', 'prune']).catch(() => undefined);
    };
    return { dir, ref, commit, cleanup };
  }

  async prepare(task: TaskInput, repoId: string, repoPath: string, baseBranch?: string): Promise<RepoWorkspace> {
    if (!(await GitWorkspaceManager.isGitRepoRoot(repoPath))) {
      return { repoId, workdir: repoPath, managedByGit: false };
    }

    const branch = GitWorkspaceManager.branchName(this.branchPrefix, task.id);
    const workdir = path.join(this.worktreesDir, task.id.replace(/[^A-Za-z0-9._-]/g, '_'), repoId);

    // Resume: worktree already exists for this ticket (e.g. after a failed run).
    if (fs.existsSync(path.join(workdir, '.git'))) {
      const current = await git(workdir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (current !== branch) {
        throw new Error(`Worktree ${workdir} is on branch "${current}", expected "${branch}". Remove it and retry.`);
      }
      // Uncommitted files can only be leftovers of an earlier FAILED run (a successful run commits).
      // A retry starts clean: they are discarded; commits on the ticket branch and ignored files
      // (node_modules) are kept.
      if (await git(workdir, ['status', '--porcelain', '--', '.', ':(exclude,glob)**/node_modules/**'])) {
        await git(workdir, ['reset', '--hard', '-q']);
        await git(workdir, ['clean', '-fdq', '-e', 'node_modules']); // keep installs even if not in .gitignore
        this.log(`Discarded uncommitted leftovers of an earlier failed run in ${workdir}.`);
      }
      return { repoId, workdir, managedByGit: true, branch };
    }

    fs.mkdirSync(path.dirname(workdir), { recursive: true });
    await git(repoPath, ['worktree', 'prune']); // forget worktrees whose folders were deleted

    const branchExists = await git(repoPath, ['branch', '--list', branch]).then((o) => o.length > 0);
    if (branchExists) {
      await git(repoPath, ['worktree', 'add', workdir, branch]);
      return { repoId, workdir, managedByGit: true, branch };
    }

    const baseRef = await this.resolveBaseRef(repoPath, baseBranch);
    await git(repoPath, ['rev-parse', '--verify', `${baseRef}^{commit}`]).catch(() => {
      throw new Error(`Base branch "${baseBranch || baseRef}" not found in ${repoPath} (locally or on origin).`);
    });
    // --no-track: the ticket branch must never be set up to push into the base branch.
    await git(repoPath, ['worktree', 'add', '--no-track', '-b', branch, workdir, baseRef]);
    return { repoId, workdir, managedByGit: true, branch, baseRef };
  }

  async commit(task: TaskInput, workspace: RepoWorkspace): Promise<string | undefined> {
    if (!workspace.managedByGit) return undefined;

    await git(workspace.workdir, ['add', '-A', '--', '.', ...NEVER_COMMIT]);
    const staged = await git(workspace.workdir, ['diff', '--cached', '--name-only']);
    if (!staged) return undefined;

    const message = `${task.id}: ${task.title}\n\nGenerated by the AI orchestrator: tests written first, verified by the pipeline, reviewed by an independent AI reviewer.\nHuman review required before merge.`;
    await git(workspace.workdir, ['commit', '-m', message]);
    return git(workspace.workdir, ['rev-parse', 'HEAD']);
  }
}
