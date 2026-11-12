import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { DeduplicationAgent } from './agents/deduplication/agent.js';
import { TeamAgent } from './agents/team-agent/team-agent.js';
import { MockAIProvider } from './providers/ai-provider.js';
import type { TaskInput, OrchestratorResult } from './models/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../repositories');

export const qaTickets: Record<string, TaskInput> = {
  singleRepoPayment: {
    id: 'PAY-101',
    title: 'Add health endpoint',
    description: 'Add GET /health endpoint to the payment service',
    acceptanceCriteria: [
      'GET /health returns HTTP 200',
      'Response contains status UP'
    ]
  },
  singleRepoOrder: {
    id: 'ORD-201',
    title: 'Add cancel order endpoint',
    description: 'Add cancelOrder method to the order service in repo-b',
    acceptanceCriteria: [
      'Allows existing orders to transition to CANCELLED state',
      'Returns updated order record'
    ]
  },
  singleRepoNotification: {
    id: 'NOTIF-301',
    title: 'Add SMS delivery receipt channel',
    description: 'Add notification delivery tracking in repo-c',
    acceptanceCriteria: [
      'Tracks sent notification timestamp and recipient',
      'Verifies notification dispatch'
    ]
  },
  parallelMultiRepo: {
    id: 'CROSS-401',
    title: 'Add shared telemetry headers across all services',
    description: 'Add cross-service request tracing to repo-a, repo-b, and repo-c',
    acceptanceCriteria: [
      'Payment service supports X-Trace-ID',
      'Order service forwards X-Trace-ID',
      'Notification service records X-Trace-ID'
    ]
  },
  dependentMultiRepo: {
    id: 'DEP-501',
    title: 'Add synchronized checkout payment flow',
    description: 'Implement linked payment-order token handshake',
    acceptanceCriteria: [
      'Payment service charges invoice first',
      'Order service confirms after payment succeeds'
    ]
  },
  unroutable: {
    id: 'UNR-601',
    title: 'Show creators on the homepage',
    description: 'Display three NFL content creators in the homepage right column',
    acceptanceCriteria: ['Creators are visible on the homepage']
  }
};

async function runQASuite() {
  console.log('='.repeat(75));
  console.log('   AUTOMATED QA ORCHESTRATOR TEST HARNESS');
  console.log('   Running end-to-end sample tickets across single, multi, and dependent repos');
  console.log('='.repeat(75));

  const dedupAgent = new DeduplicationAgent({
    repositoriesRoot: repoRoot
  });

  const aiProvider = new MockAIProvider();

  // Configure TeamAgent dependency rule: repo-b waits for repo-a
  const teamAgent = new TeamAgent(aiProvider, {
    repositoriesRoot: repoRoot,
    dependencies: {
      'repo-b': ['repo-a']
    }
  });

  const orchestrator = new Orchestrator({
    aiProvider,
    dedupAgent,
    teamAgent,
    silent: false
  });

  interface QACase {
    name: string;
    task: TaskInput;
    expectStatus: OrchestratorResult['status'];
    expectRepos?: string[]; // exact set of repos that must be touched
  }

  const cases: QACase[] = [
    { name: 'Single Repository Task (PAY-101 -> repo-a)', task: qaTickets.singleRepoPayment, expectStatus: 'COMPLETED', expectRepos: ['repo-a'] },
    { name: 'Single Repository Task (ORD-201 -> repo-b)', task: qaTickets.singleRepoOrder, expectStatus: 'COMPLETED', expectRepos: ['repo-b'] },
    { name: 'Single Repository Task (NOTIF-301 -> repo-c)', task: qaTickets.singleRepoNotification, expectStatus: 'COMPLETED', expectRepos: ['repo-c'] },
    { name: 'Parallel Multi-Repo (CROSS-401 -> repo-a, repo-b, repo-c)', task: qaTickets.parallelMultiRepo, expectStatus: 'COMPLETED', expectRepos: ['repo-a', 'repo-b', 'repo-c'] },
    { name: 'Dependent Multi-Repo (DEP-501 -> repo-b depends on repo-a)', task: qaTickets.dependentMultiRepo, expectStatus: 'COMPLETED', expectRepos: ['repo-a', 'repo-b'] },
    { name: 'Deduplication Guard (re-submit PAY-101)', task: qaTickets.singleRepoPayment, expectStatus: 'DUPLICATE_SKIPPED' },
    { name: 'No Matching Repo (UNR-601 -> must stop, no code written)', task: qaTickets.unroutable, expectStatus: 'NO_MATCHING_REPO', expectRepos: [] }
  ];

  const failures: string[] = [];

  for (const [i, c] of cases.entries()) {
    console.log('\n' + '█'.repeat(75));
    console.log(`  TEST CASE ${i + 1}: ${c.name}`);
    console.log('█'.repeat(75));

    const result = await orchestrator.run(c.task);
    printCaseSummary(result);

    const problems: string[] = [];
    if (result.status !== c.expectStatus) {
      problems.push(`expected status ${c.expectStatus}, got ${result.status}${result.error ? ` (${result.error})` : ''}`);
    }
    if (c.expectRepos) {
      const touched = (result.teamResult?.repoResults ?? []).map((r) => r.repoId).sort();
      const expected = [...c.expectRepos].sort();
      if (touched.join(',') !== expected.join(',')) {
        problems.push(`expected repos [${expected.join(', ')}], got [${touched.join(', ')}]`);
      }
    }
    if (c.task.id === 'DEP-501' && result.teamResult) {
      const order = result.teamResult.repoResults.map((r) => r.repoId);
      if (order.indexOf('repo-a') > order.indexOf('repo-b')) {
        problems.push(`dependency order violated: ${order.join(' -> ')}`);
      }
      console.log(`[DEPENDENCY VERIFICATION] Execution order: ${order.join(' -> ')}`);
    }

    if (problems.length === 0) {
      console.log(`[QA] PASS`);
    } else {
      console.log(`[QA] FAIL: ${problems.join('; ')}`);
      failures.push(`Case ${i + 1} (${c.task.id}): ${problems.join('; ')}`);
    }
  }

  console.log('\n' + '='.repeat(75));
  if (failures.length === 0) {
    console.log(`   ALL ${cases.length} QA AUTOMATION CASES PASSED`);
  } else {
    console.log(`   ${failures.length}/${cases.length} QA CASES FAILED:`);
    for (const f of failures) console.log(`   - ${f}`);
    process.exitCode = 1;
  }
  console.log('='.repeat(75));
}

function printCaseSummary(result: OrchestratorResult) {
  console.log('\n--- Case Result ---');
  console.log(`Task:     ${result.taskId}`);
  console.log(`Status:   ${result.status}`);
  console.log(`Success:  ${result.success}`);
  console.log(`Duration: ${result.durationMs}ms`);
  if (result.teamResult?.repoResults) {
    for (const r of result.teamResult.repoResults) {
      console.log(`  └─ Repo [${r.repoId}]: ${r.changedFiles.length} file(s) -> ${r.changedFiles.join(', ')}`);
    }
  }
  if (result.deduplication?.status === 'duplicate') {
    console.log(`  └─ Guard: Successfully caught duplicate (${result.deduplication.reason})`);
  }
}

// Only run when executed directly (npm run qa), never when imported (e.g. by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runQASuite().catch((err) => {
    console.error('QA Harness Error:', err);
    process.exit(1);
  });
}
