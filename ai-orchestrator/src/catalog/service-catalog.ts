import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { ImpactAnalysisRule } from '../agents/impact-analysis/agent.js';

/** One command in a repo's verify contract (e.g. lint, test, smoke). */
export interface VerifyCommand {
  name: string;
  run: string;
  /** Per-command timeout in seconds (default 600). */
  timeoutSec?: number;
}

/** One repository entry in the service catalog. */
export interface CatalogRepo {
  id: string;
  name?: string;
  purpose?: string;
  owner?: string;
  /** Path to the repo: absolute, or relative to the repositories root. Defaults to the id. */
  path?: string;
  /** Branch new ticket branches are created from (default: the repo's current HEAD). */
  baseBranch?: string;
  /** Whole-word keywords / Jira labels / components that route a ticket to this repo. */
  keywords?: string[];
  modules?: string[];
  files?: string[];
  /** Repos that must finish before this one (deploy order). */
  dependsOn?: string[];
  /** Verify contract: commands that must all pass. */
  verify?: VerifyCommand[];
  devUrl?: string;
  /** Where pull requests are opened (Bitbucket Cloud). Requires the repo to be a real git clone. */
  bitbucket?: { workspace: string; repo: string };
  jenkinsJob?: string;
  [extra: string]: unknown;
}

/** A routing rule that sends matching tickets to several repos at once. */
export interface CatalogRoute {
  keywords: string[];
  repos: string[];
  modules?: string[];
  files?: string[];
}

export interface ServiceCatalogData {
  repos: CatalogRepo[];
  routes?: CatalogRoute[];
}

/**
 * ServiceCatalog
 *
 * Single source of truth for "what repos exist, where they live, how a ticket
 * is routed to them, what order they deploy in, and how each one is verified".
 * Loaded from catalog/repos.yaml. Everything that used to be hardcoded per agent
 * is derived from here.
 */
export class ServiceCatalog {
  readonly repos: CatalogRepo[];
  readonly routes: CatalogRoute[];
  private readonly repositoriesRoot: string;

  constructor(data: ServiceCatalogData, repositoriesRoot: string) {
    ServiceCatalog.validate(data);
    this.repos = data.repos;
    this.routes = data.routes || [];
    this.repositoriesRoot = repositoriesRoot;
  }

  /** Loads the catalog file, or returns undefined if it does not exist. */
  static load(filePath: string, repositoriesRoot: string): ServiceCatalog | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    const raw = parse(fs.readFileSync(filePath, 'utf-8')) as ServiceCatalogData;
    return new ServiceCatalog(raw, repositoriesRoot);
  }

  private static validate(data: ServiceCatalogData): void {
    if (!data || !Array.isArray(data.repos)) {
      throw new Error('Service catalog: "repos" must be a list.');
    }
    const ids = new Set<string>();
    for (const repo of data.repos) {
      if (!repo.id || typeof repo.id !== 'string') {
        throw new Error('Service catalog: every repo needs an "id".');
      }
      if (ids.has(repo.id)) throw new Error(`Service catalog: duplicate repo id "${repo.id}".`);
      ids.add(repo.id);
      for (const v of repo.verify || []) {
        if (!v.name || !v.run) throw new Error(`Service catalog: repo "${repo.id}" has a verify command without name/run.`);
      }
    }
    for (const repo of data.repos) {
      for (const dep of repo.dependsOn || []) {
        if (!ids.has(dep)) throw new Error(`Service catalog: repo "${repo.id}" depends on unknown repo "${dep}".`);
      }
    }
    for (const route of data.routes || []) {
      for (const r of route.repos || []) {
        if (!ids.has(r)) throw new Error(`Service catalog: route references unknown repo "${r}".`);
      }
    }
  }

  get(repoId: string): CatalogRepo | undefined {
    return this.repos.find((r) => r.id === repoId);
  }

  /** Absolute path of a repo on disk. */
  resolvePath(repoId: string): string {
    const repo = this.get(repoId);
    const p = repo?.path || repoId;
    return path.isAbsolute(p) ? p : path.resolve(this.repositoriesRoot, p);
  }

  /** repoId -> absolute path, for every catalog repo. */
  repoPaths(): Record<string, string> {
    return Object.fromEntries(this.repos.map((r) => [r.id, this.resolvePath(r.id)]));
  }

  /** Routing rules for the Impact Analysis Agent (per-repo keywords first, then shared routes). */
  impactRules(): ImpactAnalysisRule[] {
    const perRepo: ImpactAnalysisRule[] = this.repos
      .filter((r) => (r.keywords || []).length > 0)
      .map((r) => ({
        keywords: [...(r.keywords || []), r.id],
        repositories: [r.id],
        modules: r.modules || [],
        files: (r.files || []).map((f) => `${r.id}/${f}`)
      }));
    const shared: ImpactAnalysisRule[] = this.routes.map((route) => ({
      keywords: route.keywords,
      repositories: route.repos,
      modules: route.modules || [],
      files: route.files || []
    }));
    return [...perRepo, ...shared];
  }

  /** Dependency map for the Team Agent: { repoId: [repos it waits for] }. */
  dependencies(): Record<string, string[]> {
    return Object.fromEntries(
      this.repos.filter((r) => (r.dependsOn || []).length > 0).map((r) => [r.id, r.dependsOn as string[]])
    );
  }

  /** Verify contract for a repo (empty = fall back to make verify / npm test). */
  verifyCommands(repoId: string): VerifyCommand[] {
    return this.get(repoId)?.verify || [];
  }
}
