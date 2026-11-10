import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { DeduplicationAgent } from './agents/deduplication/agent.js';
import { MockAIProvider } from './providers/ai-provider.js';
import { ClaudeProvider } from './providers/claude-provider.js';
import type { TaskInput } from './models/types.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.REPOSITORIES_ROOT
  ? path.resolve(process.cwd(), process.env.REPOSITORIES_ROOT)
  : path.resolve(__dirname, '../repositories');

export function createOrchestrator(providerType?: string): Orchestrator {
  const chosenProvider = providerType || process.env.AI_PROVIDER || 'mock';

  let provider;
  if (chosenProvider.toLowerCase() === 'claude') {
    provider = new ClaudeProvider();
  } else {
    provider = new MockAIProvider();
  }

  const historyFilePath = path.resolve(process.cwd(), '.task-history.json');
  const dedupAgent = new DeduplicationAgent({
    historyFilePath,
    repositoriesRoot: repoRoot
  });

  return new Orchestrator({
    aiProvider: provider,
    dedupAgent
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('   LOCAL AI DEVELOPMENT ORCHESTRATOR POC');
  console.log('='.repeat(60));

  const providerName = (process.env.AI_PROVIDER || 'mock').toLowerCase();
  console.log(`Active AI Provider: ${providerName.toUpperCase()}`);
  console.log(`Repositories Path:  ${repoRoot}`);
  console.log('='.repeat(60));

  const orchestrator = createOrchestrator(providerName);

  const sampleTask: TaskInput = {
    id: 'PAY-101',
    title: 'Add health endpoint',
    description: 'Add GET /health endpoint to the payment service',
    acceptanceCriteria: [
      'GET /health returns HTTP 200',
      'Response contains status UP'
    ]
  };

  console.log('\n>>> RUNNING SCENARIO 1: New Development Task (PAY-101)');
  const result1 = await orchestrator.run(sampleTask);

  console.log('\n--- Summary Report (Scenario 1) ---');
  console.log(`Task ID:  ${result1.taskId}`);
  console.log(`Status:   ${result1.status}`);
  console.log(`Success:  ${result1.success}`);
  console.log(`Duration: ${result1.durationMs}ms`);
  if (result1.teamResult?.repoResults) {
    for (const r of result1.teamResult.repoResults) {
      console.log(`Repo [${r.repoId}]: ${r.changedFiles.length} file(s) modified (${r.changedFiles.join(', ')})`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('>>> RUNNING SCENARIO 2: Duplicate Task Submission (Deduplication Check)');
  console.log('='.repeat(60));
  const result2 = await orchestrator.run(sampleTask);

  console.log('\n--- Summary Report (Scenario 2) ---');
  console.log(`Task ID:  ${result2.taskId}`);
  console.log(`Status:   ${result2.status}`);
  console.log(`Success:  ${result2.success}`);
  console.log(`Reason:   ${result2.deduplication?.reason}`);
  console.log('='.repeat(60));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error('Fatal orchestrator error:', err);
    process.exit(1);
  });
}
