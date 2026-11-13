import fs from 'node:fs';
import { parse } from 'yaml';
import type { RiskLevel } from '../agents/planning/types.js';

/** One Jira component and the repos it maps to (config/components.yaml). */
export interface ComponentEntry {
  name: string;
  product?: string;
  repos: string[];
  riskFloor?: RiskLevel;
}

export interface ComponentResolution {
  repos: string[];
  /** Highest risk floor among the matched components. */
  riskFloor?: RiskLevel;
  products: string[];
  matched: string[];
  /** Ticket components that have no entry in the map. */
  unmapped: string[];
}

const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high'];

export function maxRisk(a: RiskLevel | undefined, b: RiskLevel | undefined): RiskLevel | undefined {
  if (!a) return b;
  if (!b) return a;
  return RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;
}

/**
 * ComponentMap: Jira component → repos (+ product, risk floor).
 * The deterministic first step of repo selection; the Planning Agent confirms it in the code.
 * Component names match case-insensitively.
 */
export class ComponentMap {
  readonly entries: ComponentEntry[];

  constructor(entries: ComponentEntry[]) {
    this.entries = entries;
  }

  static parse(raw: unknown, knownRepos?: string[]): ComponentMap {
    const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const comps = root.components && typeof root.components === 'object' ? (root.components as Record<string, unknown>) : {};
    const known = knownRepos ? new Set(knownRepos) : undefined;
    const seen = new Set<string>();
    const entries: ComponentEntry[] = [];
    for (const [name, value] of Object.entries(comps)) {
      const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      const lower = name.toLowerCase();
      if (seen.has(lower)) throw new Error(`Component map: "${name}" is listed twice.`);
      seen.add(lower);
      const repos = v.repos;
      if (!Array.isArray(repos) || repos.length === 0 || repos.some((r) => typeof r !== 'string')) {
        throw new Error(`Component map: "${name}" needs a non-empty "repos" list.`);
      }
      if (known) {
        const unknown = (repos as string[]).filter((r) => !known.has(r));
        if (unknown.length) throw new Error(`Component map: "${name}" points to repos not in catalog/repos.yaml: ${unknown.join(', ')}.`);
      }
      const floor = v.risk_floor;
      if (floor !== undefined && !RISK_ORDER.includes(floor as RiskLevel)) {
        throw new Error(`Component map: "${name}" risk_floor must be low, medium or high.`);
      }
      entries.push({
        name,
        product: typeof v.product === 'string' ? v.product : undefined,
        repos: repos as string[],
        riskFloor: floor as RiskLevel | undefined
      });
    }
    return new ComponentMap(entries);
  }

  /** Loads the map file; undefined if it does not exist. */
  static load(filePath: string, knownRepos?: string[]): ComponentMap | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    try {
      return ComponentMap.parse(parse(fs.readFileSync(filePath, 'utf-8')), knownRepos);
    } catch (err) {
      throw new Error(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  get(component: string): ComponentEntry | undefined {
    const lower = component.toLowerCase();
    return this.entries.find((e) => e.name.toLowerCase() === lower);
  }

  /**
   * Resolves a ticket's components, and its labels for projects that tag areas with labels
   * (T2: coin-sportsbook, betslip…). Labels that are not in the map are ignored (frontend, P1…);
   * only unmapped COMPONENTS are reported as unmapped.
   */
  resolveTicket(components: string[], labels: string[] = []): ComponentResolution {
    const byComponent = this.resolve(components);
    const byLabel = this.resolve(labels.filter((l) => this.get(l)));
    const merged = new Set([...byComponent.repos, ...byLabel.repos]);
    return {
      repos: [...merged],
      riskFloor: maxRisk(byComponent.riskFloor, byLabel.riskFloor),
      products: [...new Set([...byComponent.products, ...byLabel.products])],
      matched: [...new Set([...byComponent.matched, ...byLabel.matched])],
      unmapped: byComponent.unmapped
    };
  }

  resolve(components: string[]): ComponentResolution {
    const repos = new Set<string>();
    const products = new Set<string>();
    const matched: string[] = [];
    const unmapped: string[] = [];
    let riskFloor: RiskLevel | undefined;
    for (const c of components) {
      const e = this.get(c);
      if (!e) {
        unmapped.push(c);
        continue;
      }
      matched.push(e.name);
      e.repos.forEach((r) => repos.add(r));
      if (e.product) products.add(e.product);
      riskFloor = maxRisk(riskFloor, e.riskFloor);
    }
    return { repos: [...repos], riskFloor, products: [...products], matched, unmapped };
  }

  /** Highest risk floor of any component that maps to one of these repos. */
  riskFloorForRepos(repos: string[]): RiskLevel | undefined {
    const set = new Set(repos);
    return this.entries.filter((e) => e.repos.some((r) => set.has(r))).reduce<RiskLevel | undefined>((acc, e) => maxRisk(acc, e.riskFloor), undefined);
  }
}
