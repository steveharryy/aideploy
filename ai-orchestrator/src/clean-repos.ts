import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../repositories');
const historyFile = path.resolve(process.cwd(), '.task-history.json');

async function cleanAll() {
  console.log('='.repeat(65));
  console.log('   REVOKING ALL CHANGES (Resetting to Clean Baseline)');
  console.log('='.repeat(65));

  const repoAServer = path.join(repoRoot, 'repo-a', 'src', 'server.ts');
  const repoABaseline = `export class PaymentServer {
  private startTime = Date.now();

  public charge(amount: number): { success: boolean; txId: string } {
    return {
      success: true,
      txId: \`tx_\${Date.now()}_\${amount}\`
    };
  }
}
`;
  await fs.writeFile(repoAServer, repoABaseline, 'utf-8');
  console.log('✓ Reset: repo-a/src/server.ts (removed getHealth API)');

  const repoBIndex = path.join(repoRoot, 'repo-b', 'src', 'index.ts');
  const repoBBaseline = `export interface Order {
  id: string;
  items: string[];
  total: number;
}

export class OrderService {
  private orders: Map<string, Order> = new Map();

  createOrder(items: string[], total: number): Order {
    const id = \`order_\${Date.now()}\`;
    const order: Order = { id, items, total };
    this.orders.set(id, order);
    return order;
  }

  getOrder(id: string): Order | undefined {
    return this.orders.get(id);
  }
}
`;
  await fs.writeFile(repoBIndex, repoBBaseline, 'utf-8');
  console.log('✓ Reset: repo-b/src/index.ts');

  const repoCIndex = path.join(repoRoot, 'repo-c', 'src', 'index.ts');
  const repoCBaseline = `export interface NotificationPayload {
  recipient: string;
  channel: 'email' | 'sms' | 'push';
  message: string;
}

export class NotificationService {
  private sentNotifications: NotificationPayload[] = [];

  sendNotification(payload: NotificationPayload): { success: boolean; id: string } {
    this.sentNotifications.push(payload);
    return {
      success: true,
      id: \`notif_\${Date.now()}\`
    };
  }

  getSentNotifications(): NotificationPayload[] {
    return [...this.sentNotifications];
  }
}
`;
  await fs.writeFile(repoCIndex, repoCBaseline, 'utf-8');
  console.log('✓ Reset: repo-c/src/index.ts');

  const descriptions: Record<string, string> = {
    'repo-a': 'Payment Service Repository',
    'repo-b': 'Order Service Repository',
    'repo-c': 'Notification Service Repository'
  };
  for (const repo of ['repo-a', 'repo-b', 'repo-c']) {
    const repoDir = path.join(repoRoot, repo);

    const featuresDir = path.join(repoDir, 'src', 'features');
    if (fsSync.existsSync(featuresDir)) {
      await fs.rm(featuresDir, { recursive: true, force: true });
      console.log(`✓ Cleaned: ${repo}/src/features/ folder removed`);
    }

    // Anything an AI agent added: extra source/test files, dependencies, installed packages.
    for (const extra of ['src/health.ts', 'node_modules', 'package-lock.json', 'tsconfig.json']) {
      const target = path.join(repoDir, extra);
      if (fsSync.existsSync(target)) {
        await fs.rm(target, { recursive: true, force: true });
        console.log(`✓ Cleaned: ${repo}/${extra}`);
      }
    }
    const testsDir = path.join(repoDir, 'tests');
    for (const file of fsSync.existsSync(testsDir) ? await fs.readdir(testsDir) : []) {
      if (file !== 'test.js') {
        await fs.rm(path.join(testsDir, file), { recursive: true, force: true });
        console.log(`✓ Cleaned: ${repo}/tests/${file}`);
      }
    }
    const baselinePkg = {
      name: repo,
      version: '1.0.0',
      description: descriptions[repo],
      type: 'module',
      scripts: { test: 'node tests/test.js' }
    };
    await fs.writeFile(path.join(repoDir, 'package.json'), JSON.stringify(baselinePkg, null, 2) + '\n\n', 'utf-8');
  }

  // Forget only the SAMPLE tickets; real tickets (e.g. T2-546) keep their history and job records.
  const sampleIds = new Set(['PAY-101', 'ORD-201', 'NOTIF-301', 'CROSS-401', 'DEP-501', 'UNR-601', 'MULTI-101']);
  if (fsSync.existsSync(historyFile)) {
    try {
      const history = JSON.parse(await fs.readFile(historyFile, 'utf-8')) as Array<{ id: string }>;
      const kept = history.filter((t) => !sampleIds.has(t.id));
      await fs.writeFile(historyFile, JSON.stringify(kept, null, 2), 'utf-8');
      console.log(`✓ History: removed ${history.length - kept.length} sample ticket(s), kept ${kept.length} real ticket(s)`);
    } catch {
      console.log('! History file unreadable; left untouched');
    }
  }
  const jobsDir = path.resolve(process.cwd(), process.env.JOBS_DIR || '.jobs');
  for (const id of sampleIds) {
    const dir = path.join(jobsDir, id);
    if (fsSync.existsSync(dir)) {
      await fs.rm(dir, { recursive: true, force: true });
      console.log(`✓ Removed job record: .jobs/${id}`);
    }
  }

  console.log('='.repeat(65));
  console.log('   CLEANUP COMPLETE: sample repos restored; history of real tickets kept.');
  console.log('='.repeat(65));
}

cleanAll().catch((err) => {
  console.error('Clean error:', err);
  process.exit(1);
});
