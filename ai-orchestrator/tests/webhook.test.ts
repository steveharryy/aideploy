import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import {
  TicketQueue,
  deliveryId,
  extractIssueKey,
  startWebhookServer,
  verifyRequest,
  type RunningWebhookServer
} from '../src/automation/webhook-server.js';

// Real HTTP server on a random port; the pipeline itself is faked.

const SECRET = 'test-secret-0123456789';
const sign = (body: string) => `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
const jiraEvent = (key: string, changelogId = '1') =>
  JSON.stringify({ webhookEvent: 'jira:issue_updated', timestamp: 1, issue: { key, fields: { labels: ['ai-ready'] } }, changelog: { id: changelogId } });

let server: RunningWebhookServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(processed: string[], extra: { projects?: string[]; delayMs?: number } = {}) {
  server = await startWebhookServer({
    secret: SECRET,
    port: 0,
    host: '127.0.0.1',
    projects: extra.projects,
    log: () => {},
    process: async (key) => {
      if (extra.delayMs) await new Promise((r) => setTimeout(r, extra.delayMs));
      processed.push(key);
      return 'planned';
    }
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (body: string, headers: Record<string, string>, path = '/webhooks/jira') =>
    fetch(`${base}${path}`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', ...headers } });
  return { base, post };
}

describe('Webhook: request checks', () => {
  it('accepts a Jira HMAC signature or the Automation shared-secret header, nothing else', () => {
    const body = Buffer.from(jiraEvent('T2-1'));
    expect(verifyRequest({ 'x-hub-signature': sign(body.toString()) }, body, SECRET)).toBe(true);
    expect(verifyRequest({ 'x-webhook-secret': SECRET }, body, SECRET)).toBe(true);
    expect(verifyRequest({ 'x-hub-signature': sign('other body') }, body, SECRET)).toBe(false);
    expect(verifyRequest({ 'x-hub-signature': 'sha1=abc' }, body, SECRET)).toBe(false);
    expect(verifyRequest({ 'x-webhook-secret': 'wrong' }, body, SECRET)).toBe(false);
    expect(verifyRequest({}, body, SECRET)).toBe(false);
    expect(verifyRequest({ 'x-webhook-secret': '' }, body, '')).toBe(false);
  });

  it('reads the issue key from system-webhook and Automation payloads, rejecting junk', () => {
    expect(extractIssueKey({ issue: { key: 'T2-547' } })).toBe('T2-547');
    expect(extractIssueKey({ issueKey: 'rt-12' })).toBe('RT-12');
    expect(extractIssueKey({ key: 'T2-1; rm -rf /' })).toBeUndefined();
    expect(extractIssueKey(null)).toBeUndefined();
  });

  it('identifies retries of the same delivery', () => {
    expect(deliveryId({ 'x-atlassian-webhook-identifier': 'abc' }, {}, 'T2-1')).toBe('abc');
    const body = JSON.parse(jiraEvent('T2-1', '77'));
    expect(deliveryId({}, body, 'T2-1')).toBe(deliveryId({}, body, 'T2-1'));
    expect(deliveryId({}, body, 'T2-1')).not.toBe(deliveryId({}, JSON.parse(jiraEvent('T2-1', '78')), 'T2-1'));
  });
});

describe('Webhook server', () => {
  it('refuses to start without a strong secret', async () => {
    await expect(startWebhookServer({ secret: 'short', port: 0, log: () => {}, process: async () => '' })).rejects.toThrow(/JIRA_WEBHOOK_SECRET/);
  });

  it('queues a signed event (202) and runs the ticket', async () => {
    const processed: string[] = [];
    const { post } = await start(processed);
    const body = jiraEvent('T2-547');
    const res = await post(body, { 'X-Hub-Signature': sign(body) });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ticket: 'T2-547', state: 'queued' });
    await server!.queue.idle();
    expect(processed).toEqual(['T2-547']);
  });

  it('rejects unsigned or wrongly signed requests (401) without running anything', async () => {
    const processed: string[] = [];
    const { post } = await start(processed);
    expect((await post(jiraEvent('T2-1'), {})).status).toBe(401);
    expect((await post(jiraEvent('T2-1'), { 'X-Webhook-Secret': 'nope' })).status).toBe(401);
    await server!.queue.idle();
    expect(processed).toEqual([]);
  });

  it('drops Jira retries of the same delivery', async () => {
    const processed: string[] = [];
    const { post } = await start(processed);
    const headers = { 'X-Webhook-Secret': SECRET, 'X-Atlassian-Webhook-Identifier': 'delivery-1' };
    expect((await post(jiraEvent('T2-2'), headers)).status).toBe(202);
    expect(await (await post(jiraEvent('T2-2'), headers)).json()).toEqual({ duplicate: 'T2-2' });
    await server!.queue.idle();
    expect(processed).toEqual(['T2-2']);
  });

  it('ignores projects that are not enabled, bad JSON and wrong routes', async () => {
    const processed: string[] = [];
    const { post, base } = await start(processed, { projects: ['T2'] });
    const other = jiraEvent('HR-9');
    expect(await (await post(other, { 'X-Hub-Signature': sign(other) })).json()).toMatchObject({ ignored: 'HR-9' });
    expect((await post('{bad', { 'X-Hub-Signature': sign('{bad') })).status).toBe(400);
    expect((await post(jiraEvent('T2-3'), { 'X-Webhook-Secret': SECRET }, '/other')).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    await server!.queue.idle();
    expect(processed).toEqual([]);
  });
});

describe('TicketQueue', () => {
  it('runs one ticket at a time, never queues a ticket twice, and re-runs once if it changed mid-run', async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const q = new TicketQueue(async (key) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(key);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return 'ok';
    }, () => {});

    expect(q.enqueue('T2-1')).toBe('queued'); // starts running
    expect(q.enqueue('T2-2')).toBe('queued');
    expect(q.enqueue('T2-2')).toBe('already-queued');
    expect(q.enqueue('T2-1')).toBe('rerun-after-current');
    await q.idle();

    expect(maxActive).toBe(1);
    expect(order).toEqual(['T2-1', 'T2-2', 'T2-1']);
  });
});
