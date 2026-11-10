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

  for (const repo of ['repo-a', 'repo-b', 'repo-c']) {
    const featuresDir = path.join(repoRoot, repo, 'src', 'features');
    if (fsSync.existsSync(featuresDir)) {
      await fs.rm(featuresDir, { recursive: true, force: true });
      console.log(`✓ Cleaned: ${repo}/src/features/ folder removed`);
    }
  }

  if (fsSync.existsSync(historyFile)) {
    await fs.unlink(historyFile);
    console.log('✓ Deleted: .task-history.json (Deduplication memory cleared)');
  }

  console.log('='.repeat(65));
  console.log('   CLEANUP COMPLETE: All repositories restored to original baseline.');
  console.log('='.repeat(65));
}

cleanAll().catch((err) => {
  console.error('Clean error:', err);
  process.exit(1);
});
