import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describeSync, isInside, syncPlanningClones } from '../src/workspace/repo-sync.js';

// Real git, no network: a bare "origin" with main and PRE, and a pipeline clone checked out on main.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-sync-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf-8' }).trim();

function setup() {
  const dir = fs.mkdtempSync(path.join(tmp, 'case-'));
  const origin = path.join(dir, 'origin.git');
  const seed = path.join(dir, 'seed');
  const clonesRoot = path.join(dir, '.repos');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, seed);
  fs.writeFileSync(path.join(seed, 'a.ts'), 'main version\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'main');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  git(seed, 'checkout', '-q', '-b', 'PRE');
  fs.writeFileSync(path.join(seed, 'a.ts'), 'PRE version\n');
  fs.writeFileSync(path.join(seed, 'only-on-pre.ts'), 'new\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'pre work');
  git(seed, 'push', '-q', 'origin', 'HEAD:PRE');
  fs.mkdirSync(clonesRoot);
  const clone = path.join(clonesRoot, 'svc');
  git(dir, 'clone', '-q', '--branch', 'main', origin, clone); // like our .repos clones: on main, PRE never fetched
  return { dir, origin, seed, clonesRoot, clone };
}

describe('planning reads the latest base branch', () => {
  it('fetches origin/PRE and moves the pipeline clone to it (detached), then picks up new commits on the next run', () => {
    const { seed, clonesRoot, clone } = setup();
    expect(fs.readFileSync(path.join(clone, 'a.ts'), 'utf-8')).toBe('main version\n');
    return (async () => {
      const [r] = await syncPlanningClones([{ id: 'svc', path: clone, baseBranch: 'PRE' }], { clonesRoot });
      expect(r).toMatchObject({ repo: 'svc', ref: 'PRE', fresh: true });
      expect(r.commit).toBe(git(seed, 'rev-parse', '--short', 'HEAD'));
      expect(fs.readFileSync(path.join(clone, 'a.ts'), 'utf-8')).toBe('PRE version\n');
      expect(fs.existsSync(path.join(clone, 'only-on-pre.ts'))).toBe(true);
      expect(git(clone, 'branch', '--show-current')).toBe(''); // detached: no local branch moved
      expect(describeSync(r)).toBe(`svc: PRE @ ${r.commit}`);

      // Someone merges to PRE; the next planning run sees it.
      fs.writeFileSync(path.join(seed, 'a.ts'), 'PRE version 2\n');
      git(seed, 'commit', '-q', '-am', 'more pre work');
      git(seed, 'push', '-q', 'origin', 'HEAD:PRE');
      const [r2] = await syncPlanningClones([{ id: 'svc', path: clone, baseBranch: 'PRE' }], { clonesRoot });
      expect(r2.commit).toBe(git(seed, 'rev-parse', '--short', 'HEAD'));
      expect(fs.readFileSync(path.join(clone, 'a.ts'), 'utf-8')).toBe('PRE version 2\n');
    })();
  });

  it('never touches a folder outside the pipeline clones root (e.g. a developer checkout)', async () => {
    const { dir, origin, clonesRoot } = setup();
    const devCheckout = path.join(dir, 'dev-work');
    git(dir, 'clone', '-q', '--branch', 'main', origin, devCheckout);
    fs.writeFileSync(path.join(devCheckout, 'a.ts'), 'uncommitted developer work\n');
    const [r] = await syncPlanningClones([{ id: 'svc', path: devCheckout, baseBranch: 'PRE' }], { clonesRoot });
    expect(r.fresh).toBe(false);
    expect(r.skipped).toMatch(/not a pipeline-owned clone/);
    expect(fs.readFileSync(path.join(devCheckout, 'a.ts'), 'utf-8')).toBe('uncommitted developer work\n');
    expect(isInside(clonesRoot, path.join(clonesRoot, '..', 'evil'))).toBe(false);
  });

  it('a failed fetch leaves the clone as it was and reports it (planning still runs)', async () => {
    const { clonesRoot, clone } = setup();
    git(clone, 'remote', 'set-url', 'origin', path.join(clonesRoot, 'does-not-exist.git'));
    const before = git(clone, 'rev-parse', '--short', 'HEAD');
    const [r] = await syncPlanningClones([{ id: 'svc', path: clone, baseBranch: 'PRE' }], { clonesRoot });
    expect(r).toMatchObject({ fresh: false, commit: before });
    expect(r.error).toBeTruthy();
    expect(describeSync(r)).toMatch(/could not update to the latest PRE/);
  });

  it('repos without a base branch or not cloned are skipped, not errors', async () => {
    const { clonesRoot } = setup();
    const res = await syncPlanningClones(
      [{ id: 'a', path: path.join(clonesRoot, 'x') }, { id: 'b', path: path.join(clonesRoot, 'not-cloned'), baseBranch: 'PRE' }],
      { clonesRoot }
    );
    expect(res.map((r) => r.skipped)).toEqual(['no baseBranch in the catalog', 'not a git clone']);
  });
});
