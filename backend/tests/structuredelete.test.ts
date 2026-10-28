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
let adminToken = '';
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
  adminToken = tokenFor(seed.users.admin!.id);
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
    const planner = await send('POST', `/v1/projects/${projectId}/delete-request`, plannerToken, { reason: 'A planner tidying up the estate' });
    assert.equal(planner.status, 403);
    const short = await send('POST', `/v1/projects/${projectId}/delete-request`, ownerToken, { reason: 'gone' });
    assert.equal(short.status, 400);
    assert.equal(short.body.title, 'VALIDATION_FAILED');
    assert.ok((await send('GET', '/v1/projects', ownerToken)).body.projects as Array<unknown>, 'still there');
  });

  it('will not delete on one person’s say-so, however senior', async () => {
    // The whole point of the pair. The owner holds every code in every area and
    // still cannot do this alone, because the second answer is what is being
    // asked for and not a permission.
    const alone = await send('POST', `/v1/projects/${projectId}/delete`, ownerToken);
    assert.equal(alone.status, 409, JSON.stringify(alone.body));
    assert.equal(alone.body.title, 'PROJECT_DELETION_NOT_REQUESTED');
    assert.match(String(alone.body.detail), /two people/);
  });

  it('records the request, leaves the project live, and says who is waiting on whom', async () => {
    const asked = await send('POST', `/v1/projects/${projectId}/delete-request`, adminToken, { reason: 'Created to try the platform; never a real job' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    assert.equal(asked.body.requestedBy, seed.users.admin!.id);

    // Still a live project in every listing: it has not been deleted, and it
    // may never be.
    const listed = await send('GET', '/v1/projects', ownerToken);
    assert.ok((listed.body.projects as Array<{ id: string }>).some((project) => project.id === projectId), 'a request is not a deletion');

    const detail = await send('GET', `/v1/projects/${projectId}`, ownerToken);
    const pending = detail.body.deletionRequest as { requestedByName: string; you: boolean; reason: string };
    assert.equal(pending.requestedByName, 'Amara Osei', 'the owner is asked to decide against a name, not a user id');
    assert.equal(pending.you, false, 'the owner did not ask for this one');
    const mine = await send('GET', `/v1/projects/${projectId}`, adminToken);
    assert.equal((mine.body.deletionRequest as { you: boolean }).you, true, 'the requester must be told they cannot confirm it');
  });

  it('refuses the same person confirming their own request, and refuses a second ask', async () => {
    const themselves = await send('POST', `/v1/projects/${projectId}/delete`, adminToken);
    assert.equal(themselves.status, 409, JSON.stringify(themselves.body));
    assert.equal(themselves.body.title, 'PROJECT_DELETION_SAME_PERSON');

    const twice = await send('POST', `/v1/projects/${projectId}/delete-request`, adminToken, { reason: 'Asking a second time for the same thing' });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.title, 'PROJECT_DELETION_ALREADY_REQUESTED');
  });

  it('goes when the owner confirms, with both names and the requester’s reason on the record', async () => {
    const deleted = await send('POST', `/v1/projects/${projectId}/delete`, ownerToken);
    assert.equal(deleted.status, 201, JSON.stringify(deleted.body));
    assert.equal(deleted.body.projectId, projectId);

    const listed = await send('GET', '/v1/projects', ownerToken);
    assert.equal((listed.body.projects as Array<{ id: string }>).some((project) => project.id === projectId), false, 'off the list');

    const command = await send('GET', '/v1/enterprise/command', ownerToken);
    assert.equal(command.status, 200);
    assert.equal((command.body.projects as Array<{ projectId: string }>).some((project) => project.projectId === projectId), false, 'out of the estate rollup');

    const record = platform.ledger.require({ refType: 'Project', refId: projectId }).state;
    assert.equal(record.status, 'DELETED');
    // Both halves named. "Who deleted this" has two answers a year later, and
    // the pair is the authority rather than either one of them.
    assert.equal(record.deletedBy, seed.users.owner!.id, 'the confirmer');
    assert.equal(record.deletionRequestedBy, seed.users.admin!.id, 'the requester');
    assert.equal(record.deletionReason, 'Created to try the platform; never a real job', 'the requester’s reason, carried');
    assert.equal(structure.isLiveProject(record), false);
  });

  it('keeps the record readable by its id and takes no further command', async () => {
    const detail = await send('GET', `/v1/projects/${projectId}`, ownerToken);
    assert.equal(detail.status, 200);
    assert.equal((detail.body.project as { status: string }).status, 'DELETED');

    const phase = await send('POST', `/v1/projects/${projectId}/phase`, ownerToken, { to: 'DESIGN', justification: 'Trying to move a deleted project' });
    assert.equal(phase.status, 409);
    assert.equal(phase.body.title, 'PROJECT_DELETED');

    const again = await send('POST', `/v1/projects/${projectId}/delete-request`, ownerToken, { reason: 'Deleting it a second time' });
    assert.equal(again.status, 409);
    assert.ok(['PROJECT_ALREADY_DELETED', 'PROJECT_DELETED'].includes(String(again.body.title)), String(again.body.title));
  });

  it('refuses a project carrying certified money or an executed contract, at the asking', async () => {
    // Refused where it is asked for, not where it is confirmed. A request that
    // can never complete is worse than a refusal: it sits in somebody's queue
    // looking like a decision, and the answer was already no.
    const flagship = await send('POST', `/v1/projects/${seed.projectId}/delete-request`, ownerToken, { reason: 'Clearing the demonstration project' });
    assert.equal(flagship.status, 409, JSON.stringify(flagship.body));
    assert.ok(['PROJECT_HAS_CERTIFIED_PAYMENTS', 'PROJECT_HAS_EXECUTED_CONTRACT'].includes(String(flagship.body.title)), String(flagship.body.title));
    const listed = await send('GET', '/v1/projects', ownerToken);
    assert.ok((listed.body.projects as Array<{ id: string }>).some((project) => project.id === seed.projectId), 'still the flagship');
  });
});

describe('a sole owner deleting their own project', () => {
  // The two-person rule assumes a second person exists. A sole trader or a
  // one-director consultancy has exactly one owner: the rule becomes a wall
  // with no door — the owner asks, nobody else can ever confirm, and the
  // project is trapped. The seed tenancy has exactly one OWNER (Priya), so it
  // is a genuine sole-owner company and these run against the real path, not a
  // contrivance.
  let portfolioId = '';

  before(() => {
    portfolioId = scratchPortfolio('Sole-owner Europe', 'EU');
  });

  it('lets the one owner confirm their own request, and records it as a sole-owner deletion', async () => {
    const projectId = scratchProject(portfolioId, 'Project a one-person company must be able to remove');

    const asked = await send('POST', `/v1/projects/${projectId}/delete-request`, ownerToken, {
      reason: 'The only owner of the company is removing a project they created',
    });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));

    // The same person confirms — which is refused for anyone else, and is the
    // only thing a sole owner can do.
    const confirmed = await send('POST', `/v1/projects/${projectId}/delete`, ownerToken);
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.projectId, projectId);

    const listed = await send('GET', '/v1/projects', ownerToken);
    assert.equal((listed.body.projects as Array<{ id: string }>).some((project) => project.id === projectId), false, 'off the list');

    const record = platform.ledger.require({ refType: 'Project', refId: projectId }).state;
    assert.equal(record.status, 'DELETED');
    // Both halves name the one owner, and the record says plainly that it was a
    // sole-owner deletion rather than looking like a two-person act it was not.
    assert.equal(record.deletedBy, seed.users.owner!.id, 'the confirmer');
    assert.equal(record.deletionRequestedBy, seed.users.owner!.id, 'the requester');
    assert.equal(record.soleOwnerDeletion, true, 'the record is honest that one person held both halves');
  });

  it('restores the same-person rule the moment a second owner exists, and opens the proper two-person door', async () => {
    // Promote a second person to OWNER. Now the company is no longer sole-owner,
    // so the safeguard is real again: the owner who asked may not also confirm,
    // but the second owner can.
    const second = platform.createUser({
      tenantId: seed.tenantId,
      name: 'Second Owner',
      email: 'second-owner@meridian.example',
      roles: ['OWNER'],
      demonstration: true,
    });
    const secondOwnerToken = issueTokens({
      actorId: second.id,
      tenantId: second.tenantId,
      partyId: second.partyId,
      roles: second.roles,
      mfaSatisfied: true,
    }).accessToken;

    const projectId = scratchProject(portfolioId, 'Project the sole-owner door must now refuse');
    assert.equal(
      (await send('POST', `/v1/projects/${projectId}/delete-request`, ownerToken, { reason: 'The first owner asks, with a second owner now present' })).status,
      201,
    );

    const alone = await send('POST', `/v1/projects/${projectId}/delete`, ownerToken);
    assert.equal(alone.status, 409, JSON.stringify(alone.body));
    assert.equal(alone.body.title, 'PROJECT_DELETION_SAME_PERSON', 'a second owner exists, so one person cannot hold both halves');

    const together = await send('POST', `/v1/projects/${projectId}/delete`, secondOwnerToken);
    assert.equal(together.status, 201, JSON.stringify(together.body));
    const record = platform.ledger.require({ refType: 'Project', refId: projectId }).state;
    assert.equal(record.deletedBy, second.id, 'the second owner confirmed');
    assert.equal(record.deletionRequestedBy, seed.users.owner!.id, 'the first owner asked');
    assert.notEqual(record.soleOwnerDeletion, true, 'a genuine two-person deletion is not marked sole-owner');
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
    // Two people, because that is what deleting a project takes now.
    assert.equal((await send('POST', `/v1/projects/${projectId}/delete-request`, adminToken, { reason: 'Never started; the client withdrew' })).status, 201);
    assert.equal((await send('POST', `/v1/projects/${projectId}/delete`, ownerToken)).status, 201);
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
