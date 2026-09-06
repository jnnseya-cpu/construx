import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { counters } from '../src/api/telemetry.ts';
import { config } from '../src/config.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { entriesByCodePrefix } from '../src/notifications/outbox.ts';
import { renderNotificationEmail } from '../src/notifications/render.ts';
import { requireEvent } from '../src/notifications/catalogue.ts';
import { onCallAt, onCallPosition, rotaOf, setOverride, setRota } from '../src/ops/oncall.ts';
import { evaluate, resetWatch, watchPosition } from '../src/ops/watch.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * Who the platform's own alerts reach first.
 *
 * The watch told every operator, every time, and nobody in particular. A
 * rota names one person per period, computed from time rather than from a
 * handover somebody has to perform; the alert names them and reaches them
 * first; an override for a swap lapses on its own; and all of it is on the
 * chain, so "who was on call when it fired" is answerable later.
 */

let platform: Platform;
let server: Server;
let base = '';
let ruth = '';
let amara = '';
let dev = '';
let plannerToken = '';

const original = { ...config.ops };
function tune(over: Partial<typeof config.ops>): void {
  Object.assign(config.ops as object, original, over);
}

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function send(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
  platform = new Platform();
  ruth = platform.createOperator({ name: 'Ruth Okafor', email: 'ruth@construx.example' }).id;
  amara = platform.createOperator({ name: 'Amara Bello', email: 'amara@construx.example' }).id;
  dev = platform.createOperator({ name: 'Dev Patel', email: 'dev@construx.example' }).id;
  const tenant = platform.createTenant({ legalName: 'Customer Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Customer', trialGrant: false, opensOn: 'CREATION' });
  plannerToken = tokenFor(platform.createUser({ tenantId: tenant.tenant.id, name: 'Esi Mensah', email: 'esi@customer.example', roles: ['PLANNER'] }).id);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  tune({});
});

beforeEach(() => {
  counters.reset();
  resetWatch();
  tune({ alertWebhookUrl: '', minimumSample: 20, serverErrorPercent: 5 });
});

const MONDAY = new Date('2026-09-07T00:00:00Z');
const day = (n: number) => new Date(MONDAY.getTime() + n * 86_400_000);

describe('with no rota', () => {
  it('names nobody, and the position offers every operator to compose one from', () => {
    const position = onCallPosition(platform, MONDAY);
    assert.equal(position.rota, null);
    assert.equal(position.now.person, null);
    assert.equal(position.schedule.length, 0);
    assert.deepEqual(position.operators.map((operator) => operator.operatorId).sort(), [ruth, amara, dev].sort());
    assert.equal(watchPosition(platform).onCall.person, null);
  });

  it('refuses an override before a rota exists', () => {
    throwsCode(() => setOverride(platform, authOf(platform, ruth), { operatorId: amara, reason: 'Holiday cover' }, MONDAY), 'ONCALL_NO_ROTA');
  });
});

describe('the rota', () => {
  it('is set on the chain, and time decides who holds the pager', () => {
    const rota = setRota(platform, authOf(platform, ruth), { operatorIds: [ruth, amara, dev], rotationDays: 7, startsAt: MONDAY.toISOString() }, MONDAY);
    assert.equal(rota.members.length, 3);
    assert.equal(rota.setBy, ruth);
    assert.equal(rotaOf(platform)!.rotationDays, 7);
    const event = platform.ledger.events({ tenantId: 'platform' }).find((entry) => entry.eventType === 'ONCALL_ROTA_SET');
    assert.ok(event, 'the rota is a governed event under the platform tenancy');

    assert.equal(onCallAt(platform, day(0)).person!.operatorId, ruth);
    assert.equal(onCallAt(platform, day(6)).person!.operatorId, ruth);
    assert.equal(onCallAt(platform, day(7)).person!.operatorId, amara);
    assert.equal(onCallAt(platform, day(15)).person!.operatorId, dev);
    assert.equal(onCallAt(platform, day(21)).person!.operatorId, ruth, 'the rotation wraps');
    assert.equal(onCallAt(platform, day(0)).until, day(7).toISOString());
    assert.equal(onCallAt(platform, day(0)).next!.operatorId, amara);
    // Before the start, the first person: a rota set to begin on Monday still names somebody on Sunday.
    assert.equal(onCallAt(platform, day(-1)).person!.operatorId, ruth);

    const position = onCallPosition(platform, day(1));
    assert.equal(position.schedule[0]!.person.operatorId, ruth);
    assert.equal(position.schedule[1]!.person.operatorId, amara);
    assert.equal(position.schedule[1]!.from.slice(0, 10), '2026-09-14');
  });

  it('refuses a rota naming somebody who is not an operator, an empty one, and a silly rotation', () => {
    throwsCode(() => setRota(platform, authOf(platform, ruth), { operatorIds: ['nobody'], rotationDays: 7 }), 'ONCALL_NOT_AN_OPERATOR');
    throwsCode(() => setRota(platform, authOf(platform, ruth), { operatorIds: [], rotationDays: 7 }), 'ONCALL_ROTA_EMPTY');
    throwsCode(() => setRota(platform, authOf(platform, ruth), { operatorIds: [ruth], rotationDays: 0 }), 'ONCALL_ROTATION_INVALID');
    throwsCode(() => setRota(platform, authOf(platform, ruth), { operatorIds: [ruth], rotationDays: 7, startsAt: 'yesterday' }), 'ONCALL_START_INVALID');
  });

  it('hands the pager over by override, which lapses on its own, and can be cleared', () => {
    const swapped = setOverride(platform, authOf(platform, amara), { operatorId: dev, until: day(3).toISOString(), reason: 'Ruth is on leave until Thursday' }, day(1));
    assert.equal(swapped.override!.operatorId, dev);
    const during = onCallAt(platform, day(2));
    assert.equal(during.person!.operatorId, dev);
    assert.equal(during.byOverride, true);
    assert.equal(during.until, day(3).toISOString());
    assert.equal(during.next!.operatorId, ruth, 'when it lapses, whoever the rotation names then');
    const afterwards = onCallAt(platform, day(4));
    assert.equal(afterwards.person!.operatorId, ruth);
    assert.equal(afterwards.byOverride, false);

    throwsCode(() => setOverride(platform, authOf(platform, ruth), { operatorId: dev, until: day(0).toISOString(), reason: 'In the past' }, day(1)), 'ONCALL_UNTIL_INVALID');
    throwsCode(() => setOverride(platform, authOf(platform, ruth), { operatorId: dev, reason: 'x' }, day(1)), 'REASON_REQUIRED');

    const cleared = setOverride(platform, authOf(platform, ruth), { operatorId: null, reason: 'Back early' }, day(2));
    assert.equal(cleared.override, undefined);
    assert.equal(onCallAt(platform, day(2)).person!.operatorId, ruth);
    throwsCode(() => setOverride(platform, authOf(platform, ruth), { operatorId: null, reason: 'Nothing to clear' }, day(2)), 'ONCALL_NO_OVERRIDE');
  });

  it('survives a restart', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.equal(onCallAt(rebuilt, day(8)).person!.operatorId, amara);
  });
});

describe('an alert reaches the person on call first, and names them', () => {
  it('orders the recipients, carries the name in the payload, and the mail says so', async () => {
    // Amara's week. Fire the 5xx rule.
    for (let index = 0; index < 100; index += 1) counters.increment('requests_total', { route: 'GET /v1/x', status: '500' });
    await evaluate(platform, day(8));
    for (let index = 0; index < 100; index += 1) counters.increment('requests_total', { route: 'GET /v1/x', status: '500' });
    const report = await evaluate(platform, new Date(day(8).getTime() + 60_000));
    assert.ok(report.started.includes('server_errors'));

    const raised = entriesByCodePrefix(platform, 'system.watch', 5).find((entry) => entry.payload.rule === 'server_errors')!;
    assert.ok(raised, 'the alert is on the outbox');
    assert.equal(raised.recipients[0]!.id, amara, 'the person on call is first');
    assert.equal(raised.recipients.length, 3, 'the others are copied');
    assert.equal(raised.payload.onCall, 'Amara Bello');
    assert.equal(raised.payload.onCallEmail, 'amara@construx.example');

    const mail = renderNotificationEmail({
      event: requireEvent('system.watch_alert'),
      subject: 'x',
      recipient: raised.recipients[0]!,
      payload: raised.payload,
      branding: raised.branding,
    });
    assert.match(JSON.stringify(mail), /On call: Amara Bello/);
    // The position is read at the real clock, which is before the rota's
    // start: the first member holds it until period one begins.
    assert.equal(watchPosition(platform).onCall.person?.operatorId, onCallAt(platform).person?.operatorId);
    assert.ok(watchPosition(platform).onCall.person, 'somebody is always named once a rota exists');
  });
});

describe('the doors', () => {
  it('are the operator’s alone', async () => {
    const refused = await send('GET', '/v1/admin/oncall', plannerToken);
    assert.equal(refused.status, 403);
    const refusedWrite = await send('POST', '/v1/admin/oncall', plannerToken, { operatorIds: [ruth], rotationDays: 7 });
    assert.equal(refusedWrite.status, 403);
  });

  it('read the position, set the rota and the override over HTTP', async () => {
    const token = tokenFor(ruth);
    const before = await send('GET', '/v1/admin/oncall', token);
    assert.equal(before.status, 200);
    assert.equal((before.body.rota as { members: unknown[] }).members.length, 3);

    const set = await send('POST', '/v1/admin/oncall', token, { operatorIds: [dev, ruth], rotationDays: 3, startsAt: MONDAY.toISOString() });
    assert.equal(set.status, 201, JSON.stringify(set.body));
    assert.equal((set.body.rota as { members: Array<{ operatorId: string }> }).members[0]!.operatorId, dev);

    const override = await send('POST', '/v1/admin/oncall/override', token, { operatorId: ruth, reason: 'Dev at a conference' });
    assert.equal(override.status, 201, JSON.stringify(override.body));
    assert.equal((override.body.now as { byOverride: boolean }).byOverride, true);

    const cleared = await send('POST', '/v1/admin/oncall/override', token, { reason: 'Conference over' });
    assert.equal(cleared.status, 201, JSON.stringify(cleared.body));
    assert.equal((cleared.body.now as { byOverride: boolean }).byOverride, false);

    const bad = await send('POST', '/v1/admin/oncall', token, { operatorIds: ['nobody'], rotationDays: 3 });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.title, 'ONCALL_NOT_AN_OPERATOR');
  });
});
