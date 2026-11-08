import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import * as structure from '../src/domain/structure.ts';

/**
 * One client, many projects. A project carries an optional `client` label, and
 * the create-project form offers the clients the tenant already has so the same
 * client is one string rather than several near-misses. The two things worth
 * pinning: the label is stored (trimmed, and absent when blank), and `clientsOf`
 * groups the projects under it with a correct count.
 */

let platform: Platform;
let tenantId: string;
let gov: ReturnType<Platform['context']>;
let portfolioId: string;

const make = (name: string, client?: string): string =>
  structure.createProject(gov, {
    portfolioId,
    name,
    ...(client === undefined ? {} : { client }),
    sectorType: 'RESIDENTIAL',
    assetType: 'Housing',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Telford' },
    contractValueMinor: 5_000_000,
    currency: 'GBP',
    plannedStart: '2027-01-01',
    plannedCompletion: '2027-12-31',
  }).projectId;

before(() => {
  platform = new Platform();
  const created = platform.createTenant({ legalName: 'JN Construction Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'ENTERPRISE', package: 'ENTERPRISE', enterpriseName: 'JN Construction Ltd' });
  tenantId = created.tenant.id;
  const admin = platform.createUser({ tenantId, name: 'Justin', email: 'justin@jn.example', roles: ['ENTERPRISE_ADMIN'] });
  gov = platform.context(authOf(platform, admin.id), `${tenantId}-governance`);
  portfolioId = structure.createPortfolio(gov, { name: 'Q4 portfolio', enterpriseId: created.tenant.enterpriseId!, governanceModel: 'CENTRALISED', continentCode: 'EU' }).portfolioId;
});

describe('a project carries the client it is for', () => {
  it('stores the client when given, trimmed', () => {
    const id = make('Hadley DFG', '  Telford & Wrekin Council  ');
    const state = platform.ledger.require({ refType: 'Project', refId: id }).state as { client?: string };
    assert.equal(state.client, 'Telford & Wrekin Council');
  });

  it('keeps no client key when none or a blank one is given', () => {
    const noneId = make('Internal fit-out');
    const blankId = make('Speculative study', '   ');
    for (const id of [noneId, blankId]) {
      const state = platform.ledger.require({ refType: 'Project', refId: id }).state as Record<string, unknown>;
      assert.ok(!('client' in state) || state.client === undefined, 'a project with no client should carry no client label');
    }
  });
});

describe('an existing project can be put under its client by amendment', () => {
  it('sets a client on a project recorded without one, and clears it', () => {
    const id = make('Legacy project, no client');
    assert.ok(!('client' in (platform.ledger.require({ refType: 'Project', refId: id }).state as Record<string, unknown>)));

    const pctx = platform.context(gov.auth, id);
    structure.amendProject(pctx, { reason: 'Recorded before the client field existed', client: 'Shropshire Council' });
    assert.equal((platform.ledger.require({ refType: 'Project', refId: id }).state as { client?: string }).client, 'Shropshire Council');
    assert.ok(structure.clientsOf(platform.ledger, tenantId).some((c) => c.name === 'Shropshire Council'));

    structure.amendProject(pctx, { reason: 'Client recorded in error, removing it', client: '' });
    assert.equal((platform.ledger.require({ refType: 'Project', refId: id }).state as { client?: string }).client, '');
    assert.ok(!structure.clientsOf(platform.ledger, tenantId).some((c) => c.name === 'Shropshire Council'));
  });
});

describe('clientsOf groups many projects under one client', () => {
  it('counts the projects per client and sorts by count then name', () => {
    make('Wrockwardine ramp', 'Telford & Wrekin Council');
    make('Priorslee adaptation', 'Telford & Wrekin Council');
    make('Edgbaston scheme', 'Birmingham City Council');

    const clients = structure.clientsOf(platform.ledger, tenantId);
    const tw = clients.find((c) => c.name === 'Telford & Wrekin Council');
    const bham = clients.find((c) => c.name === 'Birmingham City Council');
    // Three Telford projects (Hadley DFG + the two above), one Birmingham.
    assert.equal(tw?.projects, 3);
    assert.equal(bham?.projects, 1);
    // The busiest client sorts first.
    assert.equal(clients[0]?.name, 'Telford & Wrekin Council');
    // Projects with no client do not appear as a client.
    assert.ok(!clients.some((c) => !c.name.trim()));
  });
});
