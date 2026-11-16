import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { safeErrorMessage } from '../util/redact.js';

const execFileAsync = promisify(execFile);

/**
 * Keeps the pipeline's own repo clones (ai-orchestrator/.repos/<repo>) on the latest base branch
 * before the Planning Agent reads them, so a plan is made on the same code the coding agent will
 * start from (origin/<baseBranch>), not on whatever the clone last had checked out.
 *
 * Safety:
 *  - Only folders inside the pipeline's clones root are touched; a catalog path elsewhere
 *    (e.g. a developer's own checkout) is skipped, never fetched or reset.
 *  - The clone is moved to a DETACHED checkout of origin/<base>, so no local branch is created or
 *    moved, and coding worktrees (branches ai/<ticket>) are not affected.
 *  - A failed fetch never blocks planning: the clone stays as it was and the result says so, so the
 *    plan can carry a warning that it was made on an older copy.
 */

export interface SyncRepo {
  id: string;
  path: string;
  baseBranch?: string;
}

export interface RepoSyncResult {
  repo: string;
  /** Branch the plan reads, e.g. "PRE". */
  ref?: string;
  /** Short commit the clone is at after the sync (or still at, on failure). */
  commit?: string;
  /** True when the clone is now at the latest origin/<ref>. */
  fresh: boolean;
  /** Why the clone was not synced (not ours, not git, no base branch). */
  skipped?: string;
  /** Fetch/checkout error (redacted). The clone was left as it was. */
  error?: string;
}

export type GitExec = (cwd: string, args: string[], env?: Record<string, string>) => Promise<string>;

const defaultGit: GitExec = async (cwd, args, env = {}) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }
  });
  return stdout.trim();
};

/** True when `child` is inside `root` (not equal, no ".." escape). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function syncPlanningClones(
  repos: SyncRepo[],
  options: { clonesRoot: string; remoteEnv?: () => Record<string, string>; git?: GitExec }
): Promise<RepoSyncResult[]> {
  const git = options.git ?? defaultGit;
  const env = options.remoteEnv?.() ?? {};
  return Promise.all(
    repos.map(async (r): Promise<RepoSyncResult> => {
      const base = r.baseBranch?.trim();
      if (!base) return { repo: r.id, fresh: false, skipped: 'no baseBranch in the catalog' };
      if (!isInside(options.clonesRoot, r.path)) return { repo: r.id, ref: base, fresh: false, skipped: `not a pipeline-owned clone (outside ${options.clonesRoot})` };
      if (!fs.existsSync(path.join(r.path, '.git'))) return { repo: r.id, ref: base, fresh: false, skipped: 'not a git clone' };
      const current = async () => git(r.path, ['rev-parse', '--short', 'HEAD']).catch(() => undefined);
      try {
        await git(r.path, ['fetch', '--no-tags', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], env);
        await git(r.path, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', `refs/remotes/origin/${base}`]);
        return { repo: r.id, ref: base, commit: await current(), fresh: true };
      } catch (err) {
        return { repo: r.id, ref: base, commit: await current(), fresh: false, error: safeErrorMessage(err).split('\n')[0].slice(0, 200) };
      }
    })
  );
}

/** One line per repo for logs: "gb-payments-api: PRE @ fbf2933". */
export function describeSync(r: RepoSyncResult): string {
  if (r.skipped) return `${r.repo}: not synced (${r.skipped})`;
  if (!r.fresh) return `${r.repo}: could not update to the latest ${r.ref} (${r.error ?? 'unknown error'}); still at ${r.commit ?? '?'}`;
  return `${r.repo}: ${r.ref} @ ${r.commit}`;
}
