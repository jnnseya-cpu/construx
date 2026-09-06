import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { counters } from '../src/api/telemetry.ts';
import { config } from '../src/config.ts';
import { Journal } from '../src/goldenthread/journal.ts';
import { alertWebhookState, evaluate, resetWatch, watchPosition, WATCH_RULES } from '../src/ops/watch.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * The alert channel that is not the mail pipeline, and the two rules that
 * watch the volume the record lives on.
 *
 * Every alert went through the outbox and the relay it was monitoring, so a
 * relay outage took its own alert down with it. A webhook is the belt to that
 * brace. Disk space and journal size were watched by nobody: a full volume is
 * a journal refusing its next append, and the journal's size is the length
 * of every future boot.
 */

let platform: Platform;
let hook: Server;
let hookUrl = '';
const posted: Array<Record<string, unknown>> = [];
const scratch = mkdtempSync(join(tmpdir(), 'construx-alerting-'));

const original = { ...config.ops };
function tune(over: Partial<typeof config.ops>): void {
  Object.assign(config.ops as object, original, over);
}

function requests(count: number, status = '200'): void {
  for (let index = 0; index < count; index += 1) {
    counters.increment('requests_total', { route: 'GET /v1/x', status });
  }
}

before(async () => {
  platform = new Platform();
  await seedDemoProject(platform);
  hook = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      posted.push({ headers: request.headers, body: JSON.parse(raw) as unknown });
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
  hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/alerts`;
});

after(async () => {
  tune({});
  await new Promise<void>((resolve) => hook.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  counters.reset();
  resetWatch();
  posted.length = 0;
  tune({ minimumSample: 20, serverErrorPercent: 5, authFailurePercent: 20, rateLimitedThreshold: 50, renotifyMinutes: 30 });
});

describe('the webhook channel', () => {
  it('is reported as not configured, and posts nothing, when the URL is empty', async () => {
    tune({ alertWebhookUrl: '' });
    requests(100, '500');
    await evaluate(platform, new Date('2026-09-06T09:00:00Z'));
    requests(100, '500');
    await evaluate(platform, new Date('2026-09-06T09:01:00Z'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(posted.length, 0);
    assert.equal(watchPosition(platform).webhook.configured, false);
  });

  it('posts the alert as JSON with a Slack-readable text line, and records the outcome', async () => {
    tune({ alertWebhookUrl: hookUrl });
    requests(100, '500');
    await evaluate(platform, new Date('2026-09-06T09:00:00Z'));
    requests(100, '500');
    const report = await evaluate(platform, new Date('2026-09-06T09:01:00Z'));
    assert.ok(report.started.includes('server_errors'));
    for (let attempt = 0; attempt < 40 && posted.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(posted.length, 1, 'one alert, one post');
    const body = posted[0]!.body as Record<string, unknown>;
    assert.equal(body.platform, 'CONSTRUX');
    assert.equal(body.rule, 'server_errors');
    assert.equal(body.severity, 'CRITICAL');
    assert.equal(body.transition, 'STARTED');
    assert.match(String(body.text), /^\[CONSTRUX\] CRITICAL: /);
    assert.equal((posted[0]!.headers as Record<string, string>)['content-type'], 'application/json');
    const state = alertWebhookState();
    assert.equal(state.configured, true);
    assert.equal(state.lastStatus, 202);
    assert.equal(state.lastError, undefined);
    assert.equal(watchPosition(platform).webhook.lastStatus, 202);
  });

  it('records a failure to reach the endpoint without failing the evaluation', async () => {
    tune({ alertWebhookUrl: 'http://127.0.0.1:1/nobody-listens' });
    requests(100, '500');
    await evaluate(platform, new Date('2026-09-06T10:00:00Z'));
    requests(100, '500');
    const report = await evaluate(platform, new Date('2026-09-06T10:01:00Z'));
    assert.ok(report.started.includes('server_errors'), 'the alert still fires and is still queued on the outbox');
    for (let attempt = 0; attempt < 40 && alertWebhookState().lastError === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(alertWebhookState().lastError, 'the refusal is on the position');
  });
});

describe('the volume rules', () => {
  it('decline to judge with no journal, and judge the real volume once there is one', async () => {
    tune({ alertWebhookUrl: '' });
    const disk = WATCH_RULES.find((rule) => rule.id === 'disk_space')!;
    const size = WATCH_RULES.find((rule) => rule.id === 'journal_size')!;
    const empty = new Platform();
    const window = { requests: 0, serverErrors: 0, authFailures: 0, rateLimited: 0, validationRejects: 0, seconds: 60 };
    assert.equal((await disk.observe(empty, window)).judged, false);
    assert.equal((await size.observe(empty, window)).judged, false);

    const journalled = new Platform();
    const journal = new Journal(join(scratch, 'ledger.jsonl'), { fsync: false });
    journalled.ledger.attachJournal(journal);
    journalled.createTenant({ legalName: 'Volume Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Volume', trialGrant: false, opensOn: 'CREATION' });

    const space = await disk.observe(journalled, window);
    assert.equal(space.judged, true);
    if (space.judged) {
      assert.ok((space.value ?? 0) > 0, 'free megabytes on the scratch volume');
      assert.equal(space.threshold, config.ops.diskFreeMinimumMb);
    }
    const grown = await size.observe(journalled, window);
    assert.equal(grown.judged, true);
    if (grown.judged) {
      assert.equal(grown.breached, false, 'a few events are nowhere near the threshold');
      assert.match(grown.detail, /replayed in full at every boot/);
    }

    // The threshold is what decides, not the number.
    tune({ journalMaximumMb: 0, diskFreeMinimumMb: Number.MAX_SAFE_INTEGER });
    assert.equal((await size.observe(journalled, window) as { breached: boolean }).breached, true);
    assert.equal((await disk.observe(journalled, window) as { breached: boolean }).breached, true);
    journal.close();
  });
});
