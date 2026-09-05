import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as structure from '../src/domain/structure.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * A project or a portfolio can be deleted.
 *
 * The record is kept — the chain is append-only and the project stays readable
 * by its id — and the thing leaves the estate: the listings, the rollups, the
 * picker, and every command from then on. A project carrying certified money
 * or an executed contract is closed out rather than deleted; a portfolio goes
 * only when nothing live is filed under it.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let ownerToken = '';
let plannerToken = '';
let enterpriseId = '';

function tokenFor(userId: string): string {
  const auth = seed.users[Object.keys(seed.users).find((key) => seed.users[key]!.id === userId)!]!.auth;
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

const governance = (who: string) => platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`);

function scratchPortfolio(name: string, continentCode: 'EU' | 'AM'): string {
  return structure.createPortfolio(governance('owner'), { name, enterpriseId, governanceModel: 'Board', continentCode }).portfolioId;
}

function scratchProject(portfolioId: string, name: string, countryCode = 'GB'): string {
  return structure.createProject(governance('owner'), {
    portfolioId,
    name,
    sectorType: 'COMMERCIAL',
    assetType: 'Office',
    location: { continentCode: countryCode === 'GB' ? 'EU' : 'AM', countryCode, city: countryCode === 'GB' ? 'Leeds' : 'Toronto' },
    contractValueMinor: 250_000_00,
    currency: 'GBP',
    plannedStart: '2027-01-11',
    plannedCompletion: '2027-11-30',
  }).projectId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  enterpriseId = platform.ledger.listByTenant(seed.tenantId, 'Enterprise')[0]!.refId;
  ownerToken = tokenFor(seed.users.owner!.id);
  plannerToken = tokenFor(seed.users.planner!.id);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('deleting a project', () => {
  let portfolioId = '';
  let projectId = '';

  before(() => {
    portfolioId = scratchPortfolio('Scratch Europe', 'EU');
    projectId = scratchProject(portfolioId, 'Test job nobody wants');
  });

  it('is listed until it goes', async () => {
    const listed = await send('GET', '/v1/projects', ownerToken);
    assert.ok((listed.body.projects as Array<{ id: string }>).some((project) => project.id === projectId));
  });

  it('needs the authority to approve project set-up, and a reason', async () => {
    const planner = await send('POST', `/v1/projects/${projectId}/delete`, plannerToken, { reason: 'A planner tidying up the estate' });
    assert.equal(planner.status, 403);
    const short = await send('POST', `/v1/projects/${projectId}/delete`, ownerToken, { reason: 'gone' });
    assert.equal(short.status, 400);
    assert.equal(short.body.title, 'VALIDATION_FAILED');
    assert.ok((await send('GET', '/v1/projects', ownerToken)).body.projects as Array<unknown>, 'still there');
  });

  it('goes with the reason on the record, and leaves every listing', async () => {
    const deleted = await send('POST', `/v1/projects/${projectId}/delete`, ownerToken, { reason: 'Created to try the platform; never a real job' });
    assert.equal(deleted.status, 201, JSON.stringify(deleted.body));
    assert.equal(deleted.body.projectId, projectId);

    const listed = await send('GET', '/v1/projects', ownerToken);
    assert.equal((listed.body.projects as Array<{ id: string }>).some((project) => project.id === projectId), false, 'off the list');

    const command = await send('GET', '/v1/enterprise/command', ownerToken);
    assert.equal(command.status, 200);
    assert.equal((command.body.projects as Array<{ projectId: string }>).some((project) => project.projectId === projectId), false, 'out of the estate rollup');

    const record = platform.ledger.require({ refType: 'Project', refId: projectId }).state;
    assert.equal(record.status, 'DELETED');
    assert.equal(record.deletedBy, seed.users.owner!.id);
    assert.equal(record.deletionReason, 'Created to try the platform; never a real job');
    assert.equal(structure.isLiveProject(record), false);
  });

  it('keeps the record readable by its id and takes no further command', async () => {
    const detail = await send('GET', `/v1/projects/${projectId}`, ownerToken);
    assert.equal(detail.status, 200);
    assert.equal((detail.body.project as { status: string }).status, 'DELETED');

    const phase = await send('POST', `/v1/projects/${projectId}/phase`, ownerToken, { to: 'DESIGN', justification: 'Trying to move a deleted project' });
    assert.equal(phase.status, 409);
    assert.equal(phase.body.title, 'PROJECT_DELETED');

    const again = await send('POST', `/v1/projects/${projectId}/delete`, ownerToken, { reason: 'Deleting it a second time' });
    assert.equal(again.status, 409);
  });

  it('refuses a project carrying certified money or an executed contract', async () => {
    const flagship = await send('POST', `/v1/projects/${seed.projectId}/delete`, ownerToken, { reason: 'Clearing the demonstration project' });
    assert.equal(flagship.status, 409, JSON.stringify(flagship.body));
    assert.ok(['PROJECT_HAS_CERTIFIED_PAYMENTS', 'PROJECT_HAS_EXECUTED_CONTRACT'].includes(String(flagship.body.title)), String(flagship.body.title));
    const listed = await send('GET', '/v1/projects', ownerToken);
    assert.ok((listed.body.projects as Array<{ id: string }>).some((project) => project.id === seed.projectId), 'still the flagship');
  });
});

describe('deleting a portfolio', () => {
  let portfolioId = '';
  let projectId = '';

  before(() => {
    portfolioId = scratchPortfolio('Scratch Americas', 'AM');
    projectId = scratchProject(portfolioId, 'Toronto fit-out', 'CA');
  });

  it('refuses while a project is still filed under it, naming the project', async () => {
    const refused = await send('POST', `/v1/portfolios/${portfolioId}/delete`, ownerToken, { reason: 'We are not operating in the Americas' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.title, 'PORTFOLIO_HOLDS_PROJECTS');
    assert.match(String(refused.body.detail), /Toronto fit-out/);
  });

  it('needs the authority to approve the enterprise structure', async () => {
    const planner = await send('POST', `/v1/portfolios/${portfolioId}/delete`, plannerToken, { reason: 'A planner tidying up the estate' });
    assert.equal(planner.status, 403);
  });

  it('goes once nothing live is filed under it, and leaves the listing', async () => {
    assert.equal((await send('POST', `/v1/projects/${projectId}/delete`, ownerToken, { reason: 'Never started; the client withdrew' })).status, 201);
    const deleted = await send('POST', `/v1/portfolios/${portfolioId}/delete`, ownerToken, { reason: 'We are not operating in the Americas' });
    assert.equal(deleted.status, 201, JSON.stringify(deleted.body));
    assert.equal(deleted.body.portfolioId, portfolioId);

    const listed = await send('GET', '/v1/portfolios', ownerToken);
    assert.equal((listed.body.portfolios as Array<{ id: string }>).some((portfolio) => portfolio.id === portfolioId), false);
    assert.equal(structure.livePortfolios(platform.ledger, seed.tenantId).some((record) => record.refId === portfolioId), false);
    assert.equal(platform.ledger.require({ refType: 'Portfolio', refId: portfolioId }).state.status, 'DELETED', 'the record is kept');

    const again = await send('POST', `/v1/portfolios/${portfolioId}/delete`, ownerToken, { reason: 'Deleting it a second time' });
    assert.equal(again.status, 409);
    assert.equal(again.body.title, 'PORTFOLIO_ALREADY_DELETED');
  });

  it('a project cannot be filed under a deleted portfolio', () => {
    assert.throws(
      () => scratchProject(portfolioId, 'Filed under nothing', 'CA'),
      (error: Error & { code?: string }) => error.code === 'PORTFOLIO_DELETED',
    );
  });
});
