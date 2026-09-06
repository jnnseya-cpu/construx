import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { beat, heartbeatState, resetHeartbeat, startHeartbeat, stopHeartbeat } from '../src/ops/heartbeat.ts';
import { readiness } from '../src/api/readiness.ts';
import { Platform } from '../src/platform.ts';

/**
 * The dead-man's switch.
 *
 * Every watch rule runs inside the process it watches, so a dead process
 * alerts nobody. The heartbeat is the one signal an external monitor can
 * miss: sent on the interval, only while the platform can extend the record,
 * so the monitor raises on a dead process and on a live one that cannot
 * write — and never learns "fine" from a process that is not.
 */

let monitor: Server;
let monitorUrl = '';
const pings: Array<{ headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];

const original = { ...config.ops };
function tune(over: Partial<typeof config.ops>): void {
  Object.assign(config.ops as object, original, over);
}

before(async () => {
  monitor = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      pings.push({ headers: request.headers, body: JSON.parse(raw) as Record<string, unknown> });
      response.writeHead(200).end('OK');
    });
  });
  await new Promise<void>((resolve) => monitor.listen(0, '127.0.0.1', resolve));
  monitorUrl = `http://127.0.0.1:${(monitor.address() as { port: number }).port}/ping/abc`;
});

after(async () => {
  stopHeartbeat();
  tune({});
  await new Promise<void>((resolve) => monitor.close(() => resolve()));
});

beforeEach(() => {
  pings.length = 0;
  resetHeartbeat();
});

describe('the heartbeat', () => {
  it('sends nothing, and says it is not configured, with no URL', async () => {
    tune({ heartbeatUrl: '' });
    const platform = new Platform();
    const outcome = await beat(platform);
    assert.equal(outcome.sent, false);
    assert.match(outcome.because ?? '', /no heartbeat URL/);
    assert.equal(heartbeatState().configured, false);
    assert.equal(pings.length, 0);
    const capability = readiness().capabilities.find((entry) => entry.key === 'uptime.monitor')!;
    assert.equal(capability.state, 'NOT_SET');
    assert.match(capability.detail, /dead process alerts nobody/);
  });

  it('pings the monitor while the platform is live, with the commit and the event count', async () => {
    tune({ heartbeatUrl: monitorUrl, heartbeatIntervalSeconds: 30 });
    const platform = new Platform();
    const outcome = await beat(platform, new Date('2026-09-06T12:00:00Z'));
    assert.equal(outcome.sent, true, JSON.stringify(outcome));
    assert.equal(pings.length, 1);
    assert.equal(pings[0]!.body.platform, 'CONSTRUX');
    assert.equal(pings[0]!.body.at, '2026-09-06T12:00:00.000Z');
    assert.equal(pings[0]!.body.events, platform.ledger.size);
    assert.equal(pings[0]!.headers['user-agent'], 'construx-heartbeat/1');
    const state = heartbeatState();
    assert.equal(state.configured, true);
    assert.equal(state.beats, 1);
    assert.equal(state.lastStatus, 200);
    assert.equal(state.lastError, undefined);
    assert.equal(state.intervalSeconds, 30);
    assert.equal(readiness().capabilities.find((entry) => entry.key === 'uptime.monitor')!.state, 'CONFIGURED');
  });

  it('withholds the ping while the platform cannot extend the record, so the monitor raises', async () => {
    // The property that makes it a dead-man's switch rather than a liveness
    // lie: a process mid-shutdown, or one whose journal refuses writes, must
    // not tell the monitor everything is fine.
    tune({ heartbeatUrl: monitorUrl });
    const platform = new Platform();
    platform.beginShutdown();
    const outcome = await beat(platform);
    assert.equal(outcome.sent, false);
    assert.match(outcome.because ?? '', /shutting down/);
    assert.equal(pings.length, 0);
    const state = heartbeatState();
    assert.equal(state.withheld, 1);
    assert.match(state.lastWithheld ?? '', /shutting down/);
    assert.equal(state.beats, 0);
  });

  it('records a monitor that cannot be reached without throwing', async () => {
    tune({ heartbeatUrl: 'http://127.0.0.1:1/nobody' });
    const platform = new Platform();
    const outcome = await beat(platform);
    assert.equal(outcome.sent, false);
    assert.ok(heartbeatState().lastError, 'the failure is on the state');
    assert.equal(heartbeatState().beats, 0);
  });

  it('arms a timer only when configured, and stops on request', () => {
    tune({ heartbeatUrl: '' });
    const platform = new Platform();
    startHeartbeat(platform)();
    tune({ heartbeatUrl: monitorUrl, heartbeatIntervalSeconds: 5 });
    const stop = startHeartbeat(platform);
    stop();
    stopHeartbeat();
  });
});
