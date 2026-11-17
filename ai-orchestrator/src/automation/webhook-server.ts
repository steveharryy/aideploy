import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Jira webhook receiver.
 *
 *   Jira (system webhook or Automation "Send web request")
 *     → POST /webhooks/jira  (secret checked, duplicates dropped, answers 202 at once)
 *     → TicketQueue          (one ticket at a time; the same ticket is never queued twice)
 *     → process(key)         (the watcher re-reads the ticket from Jira; its labels decide what happens)
 *
 * The webhook only says "look at this ticket now". It never carries instructions: the ticket is
 * fetched fresh with the API token, so a forged or stale payload cannot change what is run.
 * A reconciliation poll (JQL) catches anything a lost webhook missed.
 */

export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
const MAX_BODY_BYTES = 1024 * 1024;

export interface WebhookServerConfig {
  /** Shared secret. Required: the server refuses to start without one. */
  secret: string;
  port: number;
  host?: string;
  /** Path that receives Jira events (default /webhooks/jira). */
  path?: string;
  /** Only these projects are accepted (e.g. ["T2", "RT"]). Empty = any project. */
  projects?: string[];
  /** Run one ticket through the pipeline. */
  process(key: string): Promise<string>;
  /** Optional safety net: find and process tickets a webhook may have missed. */
  reconcile?(): Promise<string[]>;
  reconcileIntervalMs?: number;
  log(message: string): void;
}

/**
 * Checks that a request came from our Jira:
 *  - Jira Cloud system webhook with a secret: header X-Hub-Signature = "sha256=<HMAC of the raw body>"
 *  - Jira Automation "Send web request": custom header X-Webhook-Secret = <secret>
 */
export function verifyRequest(headers: http.IncomingHttpHeaders, rawBody: Buffer, secret: string): boolean {
  if (!secret) return false;
  const signature = header(headers, 'x-hub-signature');
  if (signature) {
    const [algo, hex] = signature.split('=', 2);
    if (algo !== 'sha256' || !hex) return false;
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(hex.toLowerCase(), expected);
  }
  const shared = header(headers, 'x-webhook-secret');
  return !!shared && safeEqual(shared, secret);
}

function header(headers: http.IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Issue key from a Jira system-webhook payload or a custom Automation payload. */
export function extractIssueKey(body: unknown): string | undefined {
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const issue = (o.issue && typeof o.issue === 'object' ? o.issue : {}) as Record<string, unknown>;
  const key = [issue.key, o.issueKey, o.key].find((k) => typeof k === 'string') as string | undefined;
  const upper = key?.trim().toUpperCase();
  return upper && ISSUE_KEY.test(upper) ? upper : undefined;
}

/** Identity of one delivery: Jira retries reuse it, so a retry is not processed twice. */
export function deliveryId(headers: http.IncomingHttpHeaders, body: unknown, key: string): string {
  const fromHeader = header(headers, 'x-atlassian-webhook-identifier');
  if (fromHeader) return fromHeader;
  const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const changelog = (o.changelog && typeof o.changelog === 'object' ? o.changelog : {}) as Record<string, unknown>;
  return `${key}:${String(changelog.id ?? '')}:${String(o.timestamp ?? '')}:${String(o.webhookEvent ?? '')}`;
}

/**
 * Serial queue: one ticket runs at a time (same guarantee as a single watcher).
 * A ticket that is already waiting is not added again; one that is running is re-run once
 * afterwards, so a label change made during a run is not lost.
 */
export class TicketQueue {
  private pending: string[] = [];
  private running?: string;
  private rerun = new Set<string>();
  private draining?: Promise<void>;

  constructor(private run: (key: string) => Promise<string>, private log: (m: string) => void) {}

  enqueue(key: string): 'queued' | 'already-queued' | 'rerun-after-current' {
    if (this.pending.includes(key)) return 'already-queued';
    if (this.running === key) {
      this.rerun.add(key);
      return 'rerun-after-current';
    }
    this.pending.push(key);
    this.drain();
    return 'queued';
  }

  get size(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  /** Resolves when the queue is empty (used by tests and shutdown). */
  async idle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      while (this.pending.length) {
        const key = this.pending.shift()!;
        this.running = key;
        try {
          const outcome = await this.run(key);
          this.log(`${key}: ${outcome}`);
        } catch (err) {
          this.log(`${key}: failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          this.running = undefined;
        }
        if (this.rerun.delete(key)) this.pending.push(key);
      }
    })().finally(() => {
      this.draining = undefined;
    });
  }
}

export interface RunningWebhookServer {
  port: number;
  queue: TicketQueue;
  close(): Promise<void>;
}

export async function startWebhookServer(config: WebhookServerConfig): Promise<RunningWebhookServer> {
  if (!config.secret || config.secret.length < 16) {
    throw new Error('Webhook server: set JIRA_WEBHOOK_SECRET to a random value of at least 16 characters.');
  }
  const route = config.path || '/webhooks/jira';
  const projects = new Set((config.projects || []).map((p) => p.toUpperCase()));
  const queue = new TicketQueue(config.process, config.log);
  const seen = new Map<string, number>(); // deliveryId → time seen
  const SEEN_TTL_MS = 60 * 60 * 1000;

  const reply = (res: http.ServerResponse, status: number, body: Record<string, unknown>) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') return reply(res, 200, { ok: true, queued: queue.size });
    if (url.pathname !== route) return reply(res, 404, { error: 'not found' });
    if (req.method !== 'POST') return reply(res, 405, { error: 'method not allowed' });

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      const raw = Buffer.concat(chunks);
      if (!verifyRequest(req.headers, raw, config.secret)) {
        config.log(`rejected webhook from ${req.socket.remoteAddress}: bad or missing secret`);
        return reply(res, 401, { error: 'unauthorized' });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf-8') || '{}');
      } catch {
        return reply(res, 400, { error: 'invalid JSON' });
      }
      const key = extractIssueKey(body);
      if (!key) return reply(res, 400, { error: 'no issue key in payload' });
      if (projects.size && !projects.has(key.split('-')[0])) return reply(res, 202, { ignored: key, reason: 'project not enabled' });

      const now = Date.now();
      for (const [id, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(id);
      const id = deliveryId(req.headers, body, key);
      if (seen.has(id)) return reply(res, 202, { duplicate: key });
      seen.set(id, now);

      const state = queue.enqueue(key);
      config.log(`webhook: ${key} → ${state}`);
      return reply(res, 202, { ticket: key, state });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host || '0.0.0.0', () => resolve());
  });

  let timer: NodeJS.Timeout | undefined;
  if (config.reconcile && (config.reconcileIntervalMs ?? 0) > 0) {
    const tick = async () => {
      try {
        const keys = await config.reconcile!();
        for (const k of keys) queue.enqueue(k);
        if (keys.length) config.log(`reconcile: ${keys.length} ticket(s) queued: ${keys.join(', ')}`);
      } catch (err) {
        config.log(`reconcile failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    timer = setInterval(tick, config.reconcileIntervalMs);
    void tick(); // also catch up on start
  }

  return {
    port: (server.address() as AddressInfo).port,
    queue,
    async close() {
      if (timer) clearInterval(timer);
      await new Promise<void>((r) => server.close(() => r()));
      await queue.idle();
    }
  };
}
