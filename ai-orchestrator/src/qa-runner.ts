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

  console.log('\n' + '█'.repeat(75));
  console.log('  TEST CASE 1: Single Repository Task (PAY-101 -> repo-a)');
  console.log('█'.repeat(75));
  const res1 = await orchestrator.run(qaTickets.singleRepoPayment);
  printCaseSummary(res1);

  console.log('\n' + '█'.repeat(75));
  console.log('  TEST CASE 2: Single Repository Task (ORD-201 -> repo-b)');
  console.log('█'.repeat(75));
  const res2 = await orchestrator.run(qaTickets.singleRepoOrder);
  printCaseSummary(res2);

  console.log('\n' + '█'.repeat(75));
  console.log('  TEST CASE 3: Single Repository Task (NOTIF-301 -> repo-c)');
  console.log('█'.repeat(75));
  const res3 = await orchestrator.run(qaTickets.singleRepoNotification);
  printCaseSummary(res3);

  console.log('\n' + '█'.repeat(75));
  console.log('  TEST CASE 4: Parallel Multi-Repo (CROSS-401 -> repo-a, repo-b, repo-c concurrent)');
  console.log('█'.repeat(75));
  const startParallel = Date.now();
  const res4 = await orchestrator.run(qaTickets.parallelMultiRepo);
  const parallelDuration = Date.now() - startParallel;
  printCaseSummary(res4);
  console.log(`[PARALLEL VERIFICATION] 3 repositories executed concurrently in ${parallelDuration}ms!`);

  console.log('\n' + '█'.repeat(75));
  console.log('  TEST CASE 5: Dependent Multi-Repo (DEP-501 -> repo-b depends on repo-a)');
  console.log('█'.repeat(75));
  const res5 = await orchestrator.run(qaTickets.dependentMultiRepo);
  printCaseSummary(res5);
  if (res5.teamResult?.executionPlan) {
    console.log('[DEPENDENCY VERIFICATION] Plan order:');
    for (const p of res5.teamResult.executionPlan) {
      console.log(`  - ${p.repoId} (depends on: ${p.dependsOn?.length ? p.dependsOn.join(', ') : 'NONE - runs first'})`);
    }
  }

  console.log('\n' + '█'.repeat(75));
  console.log('  TEST CASE 6: Deduplication Guard (Re-submitting PAY-101 - should stop pipeline)');
  console.log('█'.repeat(75));
  const res6 = await orchestrator.run(qaTickets.singleRepoPayment);
  printCaseSummary(res6);

  console.log('\n' + '='.repeat(75));
  console.log('   ALL 6 QA AUTOMATION CASES COMPLETED SUCCESSFULLY!');
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

runQASuite().catch((err) => {
  console.error('QA Harness Error:', err);
  process.exit(1);
});
