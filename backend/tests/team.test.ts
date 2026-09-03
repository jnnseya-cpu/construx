import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { authOf } from '../src/seed.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';

/**
 * Team & Access — the identity directory and the organisation structure.
 *
 * Requested as a screen an enterprise administrator could run their people
 * from: who is here, where they sit, what they may do, how they sign in, what
 * they have done. Everything on it is read from records that already exist;
 * the two things it adds — units and placement — are governance events like
 * any other.
 */

let platform: Platform;
let server: Server;
let base: string;
let tenantId: string;
let admin: { id: string; token: string };
let planner: { id: string; token: string };

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true })
    .accessToken;
}

async function send(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

before(async () => {
  platform = new Platform();
  const created = platform.createTenant({
    legalName: 'Northgate Build Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'TEAM',
    package: 'CORE_PROJECT',
    enterpriseName: 'Northgate',
  });
  tenantId = created.tenant.id;
  const a = platform.createUser({ tenantId, name: 'Rowan Adeyemi', email: 'rowan@northgate.example', roles: ['ENTERPRISE_ADMIN'] });
  const p = platform.createUser({ tenantId, name: 'Esi Mensah', email: 'esi@northgate.example', roles: ['PLANNER'] });
  admin = { id: a.id, token: tokenFor(a.id) };
  planner = { id: p.id, token: tokenFor(p.id) };
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the directory', () => {
  it('lists everybody with state, second factor, activity and risk, from the record', async () => {
    const team = await send('GET', '/v1/team', admin.token);
    assert.equal(team.status, 200, JSON.stringify(team.body));
    const summary = team.body.summary as Record<string, number | Record<string, number>>;
    assert.equal(summary.identities, 2);
    assert.equal(summary.active, 2);
    const people = team.body.people as Array<Record<string, unknown>>;
    const esi = people.find((person) => person.id === planner.id)!;
    assert.equal(esi.state, 'ACTIVE');
    assert.deepEqual(esi.mfa, { passkey: false, device: false, label: 'Code only' });
    assert.ok((esi.risk as string[]).includes('No second factor enrolled'));
    assert.equal(esi.activity, 'NEVER', 'nobody has acted yet');
    const seats = team.body.seats as Record<string, unknown>;
    assert.equal(seats.used, 2);
    assert.equal(seats.cap, 10);
    assert.ok(Array.isArray(team.body.roles));
    assert.ok((team.body.governance as Record<string, unknown>).separationOfDuties);
  });

  it('is readable by anyone with structure read, and the operator is barred', async () => {
    const asPlanner = await send('GET', '/v1/team', planner.token);
    // PLANNER holds no ENTERPRISE_STRUCTURE read; the refusal is a refusal.
    assert.equal(asPlanner.status, 403, JSON.stringify(asPlanner.body));
    const operator = platform.createUser({ tenantId: 'platform', name: 'Ops', email: 'ops@construx.example', roles: ['PLATFORM_ADMIN'] });
    const asOperator = await send('GET', '/v1/team', tokenFor(operator.id));
    assert.equal(asOperator.status, 403);
    assert.equal(asOperator.body.title, 'ACCOUNT_LAYER_SEPARATION');
  });
});

describe('organisation structure', () => {
  let operationsId: string;

  it('creates a department, then a team under it', async () => {
    const department = await send('POST', '/v1/team/units', admin.token, { name: 'Operations', kind: 'DEPARTMENT' });
    assert.equal(department.status, 201, JSON.stringify(department.body));
    operationsId = String(department.body.id);
    const team = await send('POST', '/v1/team/units', admin.token, { name: 'Field', kind: 'TEAM', parentId: operationsId });
    assert.equal(team.status, 201, JSON.stringify(team.body));
    assert.equal(team.body.parentId, operationsId);

    const duplicate = await send('POST', '/v1/team/units', admin.token, { name: 'operations', kind: 'DEPARTMENT' });
    assert.equal(duplicate.status, 409);
    const orphan = await send('POST', '/v1/team/units', admin.token, { name: 'Lost', kind: 'TEAM', parentId: 'nope' });
    assert.equal(orphan.status, 422);
  });

  it('is the administrator’s to change', async () => {
    const refused = await send('POST', '/v1/team/units', planner.token, { name: 'Shadow', kind: 'TEAM' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.title, 'ENTERPRISE_ADMIN_REQUIRED');
  });

  it('places a person in a unit under a manager, refuses loops and self', async () => {
    const placed = await send('POST', `/v1/users/${planner.id}/placement`, admin.token, { unitId: operationsId, managerId: admin.id });
    assert.equal(placed.status, 201, JSON.stringify(placed.body));
    assert.equal(placed.body.unitId, operationsId);
    assert.equal(placed.body.managerId, admin.id);

    const self = await send('POST', `/v1/users/${planner.id}/placement`, admin.token, { managerId: planner.id });
    assert.equal(self.status, 422);
    assert.equal(self.body.title, 'MANAGER_IS_SELF');
    // Rowan cannot now report to Esi, who reports to Rowan.
    const loop = await send('POST', `/v1/users/${admin.id}/placement`, admin.token, { managerId: planner.id });
    assert.equal(loop.status, 422);
    assert.equal(loop.body.title, 'MANAGER_LOOP');

    const team = await send('GET', '/v1/team', admin.token);
    const esi = (team.body.people as Array<Record<string, unknown>>).find((person) => person.id === planner.id)!;
    assert.equal(esi.unitName, 'Operations');
    assert.equal(esi.managerName, 'Rowan Adeyemi');
    const rowan = (team.body.people as Array<Record<string, unknown>>).find((person) => person.id === admin.id)!;
    assert.equal(rowan.reports, 1);
    const units = team.body.units as Array<Record<string, unknown>>;
    assert.equal(units.find((unit) => unit.id === operationsId)!.members, 1);
  });

  it('survives a restart', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.equal(rebuilt.orgUnits(tenantId).length, 2);
    assert.equal(rebuilt.user(planner.id).unitId, operationsId);
    assert.equal(rebuilt.user(planner.id).managerId, admin.id);
  });

  it('will not retire a unit that still holds units, and releases people when it does', async () => {
    const held = await send('POST', `/v1/team/units/${operationsId}/retire`, admin.token, { reason: 'Reorganisation' });
    assert.equal(held.status, 409);
    assert.equal(held.body.title, 'UNIT_HAS_CHILDREN');

    const team = await send('GET', '/v1/team', admin.token);
    const field = (team.body.units as Array<Record<string, unknown>>).find((unit) => unit.name === 'Field')!;
    const retiredField = await send('POST', `/v1/team/units/${field.id}/retire`, admin.token, { reason: 'Merged into Operations' });
    assert.equal(retiredField.status, 201, JSON.stringify(retiredField.body));
    const retiredOps = await send('POST', `/v1/team/units/${operationsId}/retire`, admin.token, { reason: 'Reorganisation' });
    assert.equal(retiredOps.status, 201, JSON.stringify(retiredOps.body));
    assert.equal(platform.user(planner.id).unitId, undefined, 'the placement went with the unit');
  });
});

describe('importing people', () => {
  it('admits each row on its own and says which were refused and why', async () => {
    await send('POST', '/v1/team/units', admin.token, { name: 'Commercial', kind: 'DEPARTMENT' });
    const result = await send('POST', '/v1/users/import', admin.token, {
      rows: [
        { email: 'nadia@northgate.example', name: 'Nadia Hussain', roles: ['QS'], unit: 'Commercial', managerEmail: 'rowan@northgate.example' },
        { email: 'esi@northgate.example', name: 'Esi Again', roles: ['PLANNER'] },
        { email: 'ghost@northgate.example', name: 'Ghost', roles: ['PLATFORM_ADMIN'] },
        { email: 'lost@northgate.example', name: 'Lost', roles: ['SUPERVISOR'], unit: 'Nowhere' },
      ],
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.created, 1);
    assert.equal(result.body.refused, 3);
    const rows = result.body.rows as Array<Record<string, unknown>>;
    assert.equal(rows[0]!.outcome, 'CREATED');
    assert.match(String(rows[1]!.reason), /already holds an identity/);
    assert.match(String(rows[2]!.reason), /cannot be granted from inside a tenancy/);
    assert.match(String(rows[3]!.reason), /No unit called Nowhere/);

    const nadia = platform.userByEmail('nadia@northgate.example')!;
    assert.equal(nadia.managerId, admin.id);
    assert.ok(nadia.unitId);
  });
});

describe('history and the report', () => {
  it('reads what a person has done from the ledger, newest first', async () => {
    const history = await send('GET', `/v1/users/${admin.id}/history`, admin.token);
    assert.equal(history.status, 200, JSON.stringify(history.body));
    const events = history.body.events as Array<Record<string, unknown>>;
    assert.ok(events.length >= 3, 'the administrator created units and placed people');
    assert.ok(events.some((event) => event.eventType === 'ORG_UNIT_CREATED'));
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(String(events[index - 1]!.at) >= String(events[index]!.at), 'newest first');
    }
    const other = await send('GET', `/v1/users/${planner.id}/history`, planner.token);
    assert.equal(other.status, 403, 'a planner holds no structure read');
  });

  it('exports the user report as a spreadsheet', async () => {
    const report = await send('POST', '/v1/team/report', admin.token, {});
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.match(report.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(report.headers.get('content-disposition') ?? '', /user-report-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = String(report.body.raw).trim().split('\n');
    assert.equal(lines[0], 'Name,Email,Roles,Unit,Manager,Status,Second factor,Last activity,Risk signals');
    assert.equal(lines.length, 1 + 3, 'three identities');
    assert.ok(lines.some((line) => line.startsWith('Nadia Hussain,nadia@northgate.example,QS,Commercial,Rowan Adeyemi,ACTIVE,Code only')));
  });
});
