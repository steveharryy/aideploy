import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServiceCatalog } from './catalog/service-catalog.js';
import { CodingAgent } from './agents/coding/coding-agent.js';
import { validateWorkItem, type WorkItem } from './agents/coding/work-item.js';
import { formatCodingReport } from './providers/coding-agent-provider.js';
import { createDefaultRepoAgent } from './agents/team-agent/team-agent.js';
import type { AIProvider } from './models/types.js';

/**
 * Standalone entry for the CODING agent (points 4–9), driven by a work item JSON file —
 * the hand-off format produced by the planning agent.
 *
 *   npm run code -- --validate work-item.json            check the file against the contract
 *   npm run code -- --work-item work-item.json           run in a sandbox; report + proposed changes saved, repo untouched
 *   npm run code -- --work-item work-item.json --apply   …and apply the changes to the repo through the Repo Agent's guards
 */

dotenv.config();
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.REPOSITORIES_ROOT ? path.resolve(process.cwd(), process.env.REPOSITORIES_ROOT) : path.resolve(here, '../repositories');
const catalogPath = process.env.CATALOG_PATH ? path.resolve(process.cwd(), process.env.CATALOG_PATH) : path.resolve(here, '../catalog/repos.yaml');
const jobsDir = path.resolve(process.cwd(), process.env.JOBS_DIR || '.jobs');

function usage(): void {
  console.log(`Usage:
  npm run code -- --validate <work-item.json>
  npm run code -- --work-item <work-item.json> [--apply]`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fileArg = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const file = fileArg('--validate') || fileArg('--work-item');
  if (!file) return usage();

  let workItem: WorkItem;
  try {
    workItem = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf-8')) as WorkItem;
  } catch (err) {
    console.error(`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const errors = validateWorkItem(workItem);
  if (errors.length) {
    console.error(`Work item is INVALID (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  if (argv.includes('--validate')) {
    console.log(`Work item ${workItem.ticket} ${workItem.workItemId} for repo "${workItem.repo}" is valid: ${workItem.acceptanceCriteria.length} AC(s), ${workItem.testPlan.length} planned test(s).`);
    return;
  }

  const catalog = ServiceCatalog.load(catalogPath, repoRoot);
  const entry = catalog?.get(workItem.repo);
  if (!catalog || !entry) {
    console.error(`Repo "${workItem.repo}" is not in ${catalogPath}. The coding agent only works on catalogued repos.`);
    process.exitCode = 1;
    return;
  }
  const repoPath = catalog.resolvePath(workItem.repo);

  console.log(`Coding agent: ${workItem.ticket} ${workItem.workItemId} → ${workItem.repo} (${repoPath})`);
  const { report, changes } = await new CodingAgent({ log: (m) => console.log(m) }).run({
    workItem,
    repoPath,
    verify: catalog.verifyCommands(workItem.repo),
    repoPurpose: entry.purpose
  });

  const dir = path.join(jobsDir, workItem.ticket.replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  const reportFile = path.join(dir, `coding-${workItem.repo}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  if (changes.length) fs.writeFileSync(path.join(dir, `coding-${workItem.repo}.changes.json`), JSON.stringify(changes, null, 2));

  console.log(`\n${formatCodingReport(report)}\n`);
  console.log(`Report: ${reportFile}`);

  if (report.status !== 'ready_for_pr') {
    process.exitCode = 1;
    return;
  }
  if (!argv.includes('--apply')) {
    console.log(`Proposed changes saved (repo untouched): ${path.join(dir, `coding-${workItem.repo}.changes.json`)}\nRe-run with --apply to write them to the repo.`);
    return;
  }

  // Apply through the Repo Agent so the same path-safety and test-integrity guards run.
  const handOff: AIProvider = {
    name: 'coding-agent',
    generateChanges: async () => ({ providerName: 'coding-agent', reasoning: report.summary, fileChanges: changes })
  };
  const applied = await createDefaultRepoAgent(workItem.repo, repoPath, handOff).execute({
    id: workItem.ticket,
    title: workItem.title,
    description: workItem.summary,
    acceptanceCriteria: workItem.acceptanceCriteria.map((a) => a.text)
  });
  if (!applied.success) {
    console.error(`Not applied: ${applied.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Applied ${applied.changedFiles.length} file(s) to ${repoPath}: ${applied.changedFiles.join(', ')}`);
}

main().catch((err) => {
  console.error('Coding agent error:', err);
  process.exit(1);
});
