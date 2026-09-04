import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as structure from '../src/domain/structure.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { resetSweep, SWEEP_ACTOR, sweepChainBreaks, sweepPosition } from '../src/ops/consistencysweep.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The chain-break sweep: the commercial escalation run for projects nobody
 * opens. `escalateChainBreaks` is proved in `chainbreak.test.ts`; this proves
 * the thing around it — that a timer-driven pass reaches every open customer
 * project under its own name, raises once, skips what it must not touch, and
 * publishes its position to the operator and to nobody else.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

const tokenFor = (userId: string): string => {
  const user = platform.user(userId);
  return issueTokens({ actorId: user.id, tenantId: user.tenantId, partyId: user.partyId, roles: user.roles, mfaSatisfied: true }).accessToken;
};

/** A project carrying one commitment against a subcontract that does not exist. */
function brokenProject(name: string, suffix: string): string {
  const governance = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');
  const project = structure.createProject(governance, {
    portfolioId: String(portfolios[0]!.state.id),
    name,
    sectorType: 'TRANSPORT',
    assetType: 'Pumping station',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Derby' },
    contractValueMinor: 500_000_00,
    currency: 'GBP',
    plannedStart: '2027-01-04',
    plannedCompletion: '2027-10-01',
  }).projectId;
  for (const [refType, refId, state] of [
    ['Subcontract', `SC-${suffix}`, { id: `SC-${suffix}`, rfqId: 'RFQ-1' }],
    ['Commitment', `CMT-${suffix}`, { id: `CMT-${suffix}`, type: 'SUBCONTRACT', contractId: `SC-MISSING-${suffix}`, valueMinor: 175_000_00 }],
  ] as const) {
    platform.ledger.commit({
      eventType: refType === 'Subcontract' ? 'SUBCONTRACT_ASSEMBLED' : 'COMMITMENT_RAISED',
      entity: { refType, refId },
      nextState: { ...state, projectId: project },
      tenantId: seed.tenantId,
      projectId: project,
      actor: { refType: 'User', refId: seed.users.admin!.auth.actorId },
      source: 'WEB',
      correlationId: `sweep-test-${suffix}`,
    });
  }
  return project;
}

before(async () => {
  resetSweep();
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the chain-break sweep', () => {
  let broken = '';

  it('raises a break on a project nobody has opened, under its own name', async () => {
    broken = brokenProject('Sweep finds it', 'SWP');
    const outcome = await sweepChainBreaks(platform);

    assert.ok(outcome.projectsChecked >= 2, 'every open customer project was checked');
    const raised = outcome.raised.filter((entry) => entry.projectId === broken);
    assert.equal(raised.length, 1);
    assert.equal(raised[0]!.check, 'Commitment against a subcontract');
    assert.equal(raised[0]!.tenantId, seed.tenantId);

    const exception = platform.ledger.list(broken, 'ChainException');
    assert.equal(exception.length, 1);
    assert.equal(exception[0]!.state.status, 'OPEN');
    const event = platform.ledger.events({ projectId: broken }).find((held) => held.eventType === 'CHAIN_EXCEPTION_RAISED');
    assert.ok(event);
    assert.deepEqual(event.actor, { refType: 'System', refId: SWEEP_ACTOR }, 'raised by the sweep, not attributed to a person');
    assert.equal(event.source, 'SYSTEM');
  });

  it('tells the roles that own the commercial position, and nobody else', () => {
    const owners = platform
      .users(seed.tenantId)
      .filter((user) => user.roles.some((role) => role === 'COMMERCIAL_MANAGER' || role === 'PROJECT_DIRECTOR'));
    const position = sweepPosition(platform);
    assert.ok(position.last);
    assert.equal(position.last.notified, owners.length * position.last.raised.length);
  });

  it('raises the same break once, however many passes run', async () => {
    const again = await sweepChainBreaks(platform);
    assert.equal(again.raised.filter((entry) => entry.projectId === broken).length, 0);
    assert.ok(again.alreadyOpen >= 1);
    assert.equal(platform.ledger.list(broken, 'ChainException').length, 1);
  });

  it('never touches the platform tenancy, and skips a closed one by name', async () => {
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    const closing = platform.createTenant({ legalName: 'Closing Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Closing' });
    const admin = platform.createUser({ tenantId: closing.tenant.id, name: 'Admin', email: 'admin@closing.example', roles: ['ENTERPRISE_ADMIN'] });
    const governance = platform.context(authOf(platform, admin.id), `${closing.tenant.id}-governance`, { source: 'WEB' });
    const portfolio = structure.createPortfolio(governance, {
      name: 'Closing works',
      enterpriseId: closing.tenant.enterpriseId!,
      governanceModel: 'TRADITIONAL',
      continentCode: 'EU',
      countryCode: 'GB',
    });
    structure.createProject(governance, {
      portfolioId: portfolio.portfolioId,
      name: 'Left behind',
      sectorType: 'TRANSPORT',
      assetType: 'Depot',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
      contractValueMinor: 100_000_00,
      currency: 'GBP',
      plannedStart: '2027-01-04',
      plannedCompletion: '2027-06-01',
    });
    platform.closeTenant(authOf(platform, operator.id), { tenantId: closing.tenant.id, reason: 'Wound up at the end of its only contract' });

    const outcome = await sweepChainBreaks(platform);
    assert.ok(outcome.skipped.some((entry) => entry.tenantId === closing.tenant.id && /closed/.test(entry.because)));
    assert.ok(!outcome.raised.some((entry) => entry.tenantId === 'platform'));
    assert.ok(!outcome.skipped.some((entry) => entry.tenantId === 'platform'));
  });

  it('publishes its position to the operator and refuses everybody else', async () => {
    const operator = platform.userByEmail('ops@construx.example')!;
    const read = await fetch(`${base}/v1/admin/consistency-sweep`, { headers: { authorization: `Bearer ${tokenFor(operator.id)}` } });
    assert.equal(read.status, 200);
    const position = (await read.json()) as { enabled: boolean; openExceptions: number; last?: { projectsChecked: number } };
    assert.equal(typeof position.enabled, 'boolean');
    assert.ok(position.openExceptions >= 1);
    assert.ok(position.last && position.last.projectsChecked >= 2);

    const run = await fetch(`${base}/v1/admin/consistency-sweep/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(operator.id)}`, 'content-type': 'application/json', 'idempotency-key': 'sweep-run-1' },
      body: '{}',
    });
    const body = await run.text();
    assert.equal(run.status, 201, body);
    const counts = JSON.parse(body) as { raised: number; alreadyOpen: number; skipped: number };
    assert.equal(counts.raised, 0, 'nothing new on a second pass');
    assert.ok(counts.alreadyOpen >= 1);

    const customer = await fetch(`${base}/v1/admin/consistency-sweep`, { headers: { authorization: `Bearer ${tokenFor(seed.users.pm!.id)}` } });
    assert.equal(customer.status, 403);
  });
});
