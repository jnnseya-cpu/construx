import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The other road: an invitation arrives, and what goes back is a submission
 * rather than a price.
 *
 * `pricingline.test.ts` drives the PRICE road — drawings in, quotation out.
 * This is the BID road, which is the one a contractor is on whenever the buyer
 * wants more than a number: a compliance matrix, a written submission, a
 * response pack attacked before the buyer attacks it.
 *
 * The two roads are decided by one fact, and the platform computes it rather
 * than asking: **an invitation asking for more than a price is a submission to
 * write; one that asks only for a price is a quotation, whatever it calls
 * itself.** Everything downstream hangs off that, which makes it worth driving
 * over the wire rather than trusting.
 *
 * Every step is over HTTP, through the schemas, and asserts on the state it
 * claims to have produced.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

type Reply = { status: number; body: any; text: string };

async function call(method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

async function signIn(email: string): Promise<string> {
  rateLimiter.reset();
  const login = await call('POST', '/v1/auth/login', { body: { email } });
  assert.equal(login.status, 201, login.text);
  const verified = await call('POST', '/v1/auth/mfa/verify', {
    body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
  });
  assert.equal(verified.status, 201, verified.text);
  return verified.body.accessToken as string;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server?.close());

let qs = '';
let admin = '';
let opportunityId = '';
let invitationId = '';
let projectId = '';

/**
 * What the buyer wants back. Four items, so this is a submission and not a
 * quotation — the fact the whole road hangs off.
 */
const DELIVERABLES = [
  { reference: 'A', title: 'Form of tender, signed', mandatory: true, signatureRequired: true, owner: 'QS', internalDueBy: '2026-10-09' },
  { reference: 'B', title: 'Pricing schedule', mandatory: true, owner: 'QS', internalDueBy: '2026-10-12' },
  { reference: 'C', title: 'Method statement', mandatory: true, pageLimit: 20, owner: 'PM', internalDueBy: '2026-10-09' },
  { reference: 'D', title: 'Social value proposal', mandatory: true, pageLimit: 6, owner: 'PM', internalDueBy: '2026-10-07' },
];

/*
 * Every mandatory item carries an owner and an internal date, because the
 * platform refuses to let a bid be decided without them — and it is right to.
 * "A mandatory deliverable with no owner, no source or no internal date is how
 * a correctly priced bid is disqualified." The first version of this fixture
 * left both out and was refused by name, which is the rule working.
 */

describe('the bid road, over HTTP', () => {
  it('signs in the seats a submission passes through', async () => {
    qs = await signIn('qs@meridian.example');
    admin = await signIn('amara.osei@meridian.example');
    assert.ok(qs.length > 20);
    assert.ok(admin.length > 20);
  });

  it('registers the pursuit and records the invitation against it', async () => {
    const opportunity = await call('POST', '/v1/pipeline/opportunities', {
      token: qs,
      body: {
        title: 'Hinckley depot resurfacing',
        clientName: 'Leicestershire County Council',
        sectorType: 'TRANSPORT',
        estimatedValueMinor: 680_000_00,
        source: 'Find a Tender',
        countryCode: 'GB',
        city: 'Hinckley',
      },
    });
    assert.equal(opportunity.status, 201, opportunity.text);
    opportunityId = String(opportunity.body.opportunityId ?? opportunity.body.id);

    const invitation = await call('POST', `/v1/pipeline/opportunities/${opportunityId}/tenders`, {
      token: qs,
      body: {
        reference: 'LCC/2026/HD/114',
        issuedAt: '2026-09-14T09:00:00Z',
        returnLocal: '2026-10-16T12:00',
        timeZone: 'Europe/London',
        // Whether the invitation stated a zone is the fact a clarification
        // hangs on, and it is not defaulted.
        timeZoneStated: true,
        channel: 'PORTAL',
        clarificationLocal: '2026-10-02T17:00',
      },
    });
    assert.equal(invitation.status, 201, invitation.text);
    invitationId = String(invitation.body.invitationId);

    for (const deliverable of DELIVERABLES) {
      const added = await call('POST', `/v1/pipeline/tenders/${invitationId}/deliverables`, {
        token: qs,
        body: { ...deliverable, source: { document: 'Instructions to tenderers', clause: '4.2' } },
      });
      assert.equal(added.status, 201, added.text);
    }
  });

  it('converts the pursuit into a project once it is decided as a bid', async () => {
    const qualified = await call('POST', `/v1/pipeline/opportunities/${opportunityId}/qualify`, {
      token: qs,
      // The platform's own criteria, scored 1 to 5. Named by the engine, not
      // invented here — a score against a factor that does not exist is
      // refused, which is how this fixture's first version was caught.
      body: {
        relevantExperience: 5,
        clientAttractiveness: 4,
        contractSize: 4,
        geography: 5,
        supplyChainCapacity: 4,
        competition: 3,
        marginOpportunity: 3,
        cashflowRisk: 4,
        strategicValue: 4,
        winProbability: 3,
      },
    });
    assert.equal(qualified.status, 201, qualified.text);

    const decided = await call('POST', `/v1/pipeline/opportunities/${opportunityId}/decide`, {
      token: admin,
      body: {
        bid: true,
        rationale: 'Repeat client, our own surfacing gangs are free from November, and the value sits in our band.',
      },
    });
    assert.equal(decided.status, 201, decided.text);

    const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
    const converted = await call('POST', `/v1/pipeline/opportunities/${opportunityId}/convert`, {
      token: admin,
      body: {
        projectName: 'Hinckley depot resurfacing',
        portfolioId,
        assetType: 'Depot',
        location: { continentCode: 'EU', countryCode: 'GB', city: 'Hinckley' },
        currency: 'GBP',
        plannedStart: '2026-11-16',
        plannedCompletion: '2027-03-12',
      },
    });
    assert.equal(converted.status, 201, converted.text);
    projectId = String(converted.body.projectId);
  });

  it('knows this job is a submission and not a quotation', async () => {
    /*
     * The join that decides everything downstream, and the one that was
     * broken.
     *
     * An opportunity and its invitation live on the tenant's pipeline chain —
     * there is no project when a tender arrives, which is the whole point of a
     * pipeline. The flow looked for the invitation on the *project's* chain,
     * found none on every real project there has ever been, and therefore put
     * every job on the PRICE road with every bid step blocked behind *"No
     * invitation is recorded on this project."*
     *
     * Reported exactly that way by the person using it: **"Plan a response
     * pack — Nothing to act on yet. This needs a compliance matrix to act
     * against, and this project holds none."** The matrix could not exist,
     * because the step before it could never leave BLOCKED.
     *
     * A converted project records the opportunity it came from, so the link
     * exists and was simply not followed.
     */
    const flow = await call('GET', `/v1/projects/${projectId}/flow`, { token: qs });
    assert.equal(flow.status, 200, flow.text);
    assert.equal(
      flow.body.road,
      'BID',
      `an invitation asking for ${DELIVERABLES.length} deliverables put the job on the ${flow.body.road} road`,
    );
    assert.match(String(flow.body.why), /submission|deliverable|price/i);

    const register = (flow.body.steps as Array<Record<string, any>>).find((step) => step.id === 'RETURN_REGISTER');
    assert.ok(register, 'the bid road names no return register');
    assert.equal(register.state, 'DONE', `the return register is ${register.state} with four deliverables recorded`);
  });

  it('will not plan a submission before the company has facts to set it against', async () => {
    /*
     * A compliance matrix answers "can this business do what the buyer is
     * asking for", and a business with no recorded facts cannot answer it. The
     * refusal is right; what matters is that it says so and names the door,
     * rather than leaving somebody on a screen with a locked button.
     */
    const matrix = (flowStep: Array<Record<string, any>>) => flowStep.find((step) => step.id === 'MATRIX');
    const flow = await call('GET', `/v1/projects/${projectId}/flow`, { token: qs });
    const step = matrix(flow.body.steps as Array<Record<string, any>>);
    assert.ok(step, 'the bid road names no compliance matrix step');
    assert.ok(String(step.door ?? '').length > 0, 'the matrix step names no door');
  });

  it('records the company facts the matrix is set against', async () => {
    const profile = await call('PUT', '/v1/company/profile', {
      token: admin,
      body: {
        legalName: 'Meridian Infrastructure Group Limited',
        // Integers, because the engine reads `number[]`. The schema once said
        // objects here and refused a correctly filled form.
        turnoverMinorByYear: [4_200_000_00, 5_100_000_00, 6_400_000_00],
        netAssetsMinor: 1_900_000_00,
        workingCapitalMinor: 800_000_00,
        regions: ['GB'],
        sectors: ['TRANSPORT', 'UTILITIES'],
        valueBandMinor: { min: 50_000_00, max: 2_000_000_00 },
        insurances: [
          { type: 'Public liability', limitMinor: 10_000_000_00, expiresOn: '2027-03-31' },
          { type: 'Contract works', limitMinor: 5_000_000_00, expiresOn: '2027-03-31' },
        ],
        accreditations: ['ISO 9001', 'ISO 14001', 'CHAS'],
        selfDeliveredTrades: ['Surfacing', 'Drainage', 'Kerbing'],
        capacity: { concurrentProjects: 6, committedProjects: 4 },
      },
    });
    assert.equal(profile.status, 200, profile.text);

    const read = await call('GET', '/v1/company/profile', { token: qs });
    assert.equal(read.status, 200, read.text);
    assert.ok(JSON.stringify(read.body).includes('Meridian Infrastructure Group Limited'), 'the facts did not come back');
  });

  it('unblocks the matrix step once the facts exist', async () => {
    const flow = await call('GET', `/v1/projects/${projectId}/flow`, { token: qs });
    const step = (flow.body.steps as Array<Record<string, any>>).find((entry) => entry.id === 'MATRIX');
    assert.ok(step, 'the matrix step disappeared');
    assert.notEqual(
      step.state,
      'BLOCKED',
      `the company's facts are recorded and the matrix step is still blocked: ${step.detail}`,
    );
  });

  it('names one thing to do next, on a screen, with a button', async () => {
    /*
     * The complaint this whole flow was built for: **"the flow is not working
     * everywhere in this OS."** A step that says what to do without saying
     * where the control is sends a person hunting, and a customer who cannot
     * ask anybody gives up instead.
     */
    const flow = await call('GET', `/v1/projects/${projectId}/flow`, { token: qs });
    const now = flow.body.nowDo as Record<string, any> | null;
    assert.ok(now, 'the bid road names nothing to do next');
    assert.ok(String(now.door ?? '').length > 0, `"${now.title}" is the next thing to do and names no door`);
    assert.ok(String(now.screen ?? '').length > 0, `"${now.title}" names a door on no screen`);
  });
});
