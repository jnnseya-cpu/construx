import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { MODULES, isModuleId } from '../src/identity/modules.ts';
import { PERMISSION_MATRIX } from '../src/identity/roles.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';

/**
 * CONSTRUX Bid-On — the provider, its customers, and what was agreed.
 *
 * The module exists because "we are being paid to write somebody else's bid" is
 * a different problem from "we are bidding for this job", and the difference is
 * not a feature list. It is three structural facts, and this suite asserts each
 * one as a refusal rather than as a capability:
 *
 *   - **The module has to be granted.** Every command and every read is refused
 *     for a tenancy without it, by the same mechanism that gives ETABLIX its
 *     module. There is no second entitlement path and no tenant id in a
 *     constant.
 *   - **A provider's customers compete with each other.** Access is per
 *     customer, restrictive by default, and the register says how many it is
 *     not showing. One login cannot be a guest of two customers.
 *   - **A declaration is the customer's own statement.** Insurance cover, an
 *     accident rate and a legal statement are representations made to a buyer
 *     under the customer's name, so the provider cannot confirm one and
 *     neither can an agent.
 *
 * And two commercial rules, because the engagement is what work is billed
 * against: a billing basis has to fit the type, and terms are versioned rather
 * than edited — a fee changed in place would rewrite what a customer owed for
 * work already delivered.
 */

let platform: Platform;
let seed: SeedResult;

/** The provider's director: `G` and `A` on BID_SERVICES, through OWNER's union. */
const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/** The provider's bid writer: authorship, and no approval. */
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/** The same person on a tenancy that was never granted the module. */
const ungranted = (): EngineContext => ({ ...asProviderAdmin(), grantedModules: [] });

/** A guest of a customer account, as the gateway would present one. */
const asGuest = (actorId: string): EngineContext => ({
  ...asProviderAdmin(),
  auth: { ...asProviderAdmin().auth, actorId },
});

const PROFILE = {
  legalName: 'Thornhill Electrical Services Ltd',
  companyNumber: '09112233',
  sicCodes: ['43210'],
  headcount: 38,
  turnoverBand: '£5m–£10m',
  sectors: ['energy', 'grid'],
  regions: ['North West', 'Yorkshire'],
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // Through the operator's own command rather than by writing a constant onto
  // a context, so these tests run against a tenancy that holds the module the
  // way a real one would.
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    decidedBy: seed.users.operator!.id,
  });
});

describe('the module is an allocation, not a feature flag', () => {
  it('is in the closed catalogue, restricted, and never self-activated', () => {
    assert.ok(isModuleId('BID_ON'));
    assert.equal(MODULES.BID_ON.registry.visibility, 'restricted');
    assert.equal(MODULES.BID_ON.registry.customerSelfActivation, false);
    assert.equal(MODULES.BID_ON.registry.eligibilityPolicy, 'explicit_tenant_grant');
    // Why it is restricted has to be readable, so "why can this company see
    // something mine cannot" has an answer that is not "ask somebody".
    assert.match(MODULES.BID_ON.restricted, /signed agreement/);
    // And it says plainly that it adds rather than replaces.
    assert.match(MODULES.BID_ON.restricted, /does not replace/);
  });

  it('refuses every command and every read for a tenancy without it', () => {
    // Not a 404. Pretending the routes do not exist would be obscurity against
    // somebody who can already read the route list, and would make a genuine
    // misconfiguration indistinguishable from a typo.
    const refusals: Array<[string, () => unknown]> = [
      ['customerRegister', () => customers.customerRegister(ungranted())],
      ['openCustomer', () => customers.openCustomer(ungranted(), { legalName: 'Anything Ltd' })],
      ['offeringCatalogue', () => engagements.offeringCatalogue(ungranted())],
      ['engagementRegister', () => engagements.engagementRegister(ungranted())],
    ];
    for (const [name, call] of refusals) {
      const error = throwsCode(call, 'MODULE_NOT_GRANTED');
      assert.match(String(error.message), /does not hold the CONSTRUX Bid-On module/, `${name} refused differently`);
    }
  });

  it('routes every act, classifies every entity, and lets no agent author one', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/bid-on/offerings'],
      ['POST', '/v1/bid-on/offerings'],
      ['PUT', '/v1/bid-on/offerings/:offeringId'],
      ['GET', '/v1/bid-on/customers'],
      ['POST', '/v1/bid-on/customers'],
      ['GET', '/v1/bid-on/customers/:customerId'],
      ['PUT', '/v1/bid-on/customers/:customerId/profile'],
      ['POST', '/v1/bid-on/customers/:customerId/staff'],
      ['POST', '/v1/bid-on/customers/:customerId/guests'],
      ['POST', '/v1/bid-on/customers/:customerId/declarations'],
      ['POST', '/v1/bid-on/customers/:customerId/close'],
      ['GET', '/v1/bid-on/engagements'],
      ['POST', '/v1/bid-on/customers/:customerId/engagements'],
      ['POST', '/v1/bid-on/engagements/:engagementId/activate'],
      ['PUT', '/v1/bid-on/engagements/:engagementId'],
      ['POST', '/v1/bid-on/engagements/:engagementId/pause'],
      ['POST', '/v1/bid-on/engagements/:engagementId/resume'],
      ['POST', '/v1/bid-on/engagements/:engagementId/stages/:stageId/sign-off'],
      ['POST', '/v1/bid-on/engagements/:engagementId/cycles'],
      ['POST', '/v1/bid-on/engagements/:engagementId/close'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    // Apart from the Tender & Procurement paths every tenancy already has.
    const standard = ROUTES.filter((route) => /^\/v1\/bid-on\//.test(route.pattern));
    assert.ok(standard.length >= 20);
    assert.ok(
      !ROUTES.some((route) => /^\/v1\/pipeline\/bid-on/.test(route.pattern)),
      'a Bid-On path has been put inside the standard section',
    );

    for (const entity of ['BidOnCustomer', 'BidOnEngagement', 'BidOnOffering']) {
      assert.equal(classifyEntity(entity)?.area, 'BID_SERVICES', `${entity} is not classified`);
      // The strictest case of COMMERCIAL_L3 anywhere here: these records are
      // commercially damaging to a third party who is not even the tenant.
      assert.equal(classifyEntity(entity)?.sensitivity, 'COMMERCIAL_L3');
    }

    for (const type of [
      'BID_ON_CUSTOMER_OPENED',
      'BID_ON_CUSTOMER_UPDATED',
      'BID_ON_CUSTOMER_CLOSED',
      'BID_ON_STAFF_ASSIGNED',
      'BID_ON_OFFERING_DEFINED',
      'BID_ON_OFFERING_UPDATED',
      'BID_ON_ENGAGEMENT_OPENED',
      'BID_ON_ENGAGEMENT_ACTIVATED',
      'BID_ON_ENGAGEMENT_RETERMED',
      'BID_ON_ENGAGEMENT_PAUSED',
      'BID_ON_ENGAGEMENT_RESUMED',
      'BID_ON_ENGAGEMENT_COMPLETED',
      'BID_ON_ENGAGEMENT_CANCELLED',
      'BID_ON_STAGE_SIGNED_OFF',
      'BID_ON_CYCLE_OPENED',
    ]) {
      assert.equal(lookupEventType(type)?.aiAllowed, false, `${type} is open to an agent`);
    }
  });

  it('keeps the bid writer out of approval, so the matrix means what the module says', () => {
    // The reviewer is not whoever ran the agent. The platform's own modelled
    // split does this and the module leans on it rather than restating it.
    const writer = PERMISSION_MATRIX.DEVELOPMENT_MANAGER.BID_SERVICES ?? [];
    assert.ok(writer.includes('C'), 'the bid writer cannot author');
    assert.ok(writer.includes('X'), 'the bid writer cannot run an agent');
    assert.ok(writer.includes('I'), 'the bid writer cannot export');
    assert.ok(!writer.includes('A'), 'the bid writer can approve, which is the split this role exists for');
    assert.ok(!writer.includes('G'), 'the bid writer can set commercial terms');

    // And the director holds the commercial authority, through OWNER's union.
    assert.ok((PERMISSION_MATRIX.OWNER.BID_SERVICES ?? []).includes('G'));
  });
});

describe('the service catalogue is the provider’s own', () => {
  it('refuses a billing basis that does not fit the type', () => {
    // A staged service billed monthly has no answer to "what does the next
    // stage cost", and nobody finds that out until the invoice.
    const error = throwsCode(
      () =>
        engagements.defineOffering(asProviderAdmin(), {
          name: 'Tender quality submission',
          engagementType: 'STAGED',
          billingBasis: 'MONTHLY',
          defaultFeeMinor: 250_000,
          currency: 'GBP',
          deliverables: ['Quality answers', 'Win themes'],
        }),
      'BID_ON_BASIS_MISMATCH',
    );
    assert.match(String(error.message), /what does the next one cost/);
  });

  it('refuses a price with nothing attached to it', () => {
    throwsCode(
      () =>
        engagements.defineOffering(asProviderAdmin(), {
          name: 'Bid help',
          engagementType: 'ONE_OFF',
          billingBasis: 'FIXED_FEE',
          defaultFeeMinor: 150_000,
          currency: 'GBP',
          deliverables: [],
        }),
      'BID_ON_NO_DELIVERABLES',
    );
  });

  it('defines the launch catalogue, with the provider’s own prices', () => {
    const pack = engagements.defineOffering(asProviderAdmin(), {
      name: 'UVDB / prequalification pack',
      engagementType: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      defaultFeeMinor: 150_000,
      currency: 'GBP',
      depositPercent: 50,
      deliverables: ['Full questionnaire', 'HSEQ policy set', 'CV and case-study library'],
      rubricScheme: 'uvdb',
    });
    assert.match(pack.reference, /^SVC-\d{4}$/);
    assert.equal(pack.active, true);
    assert.equal(pack.defaultFeeMinor, 150_000);

    const retainer = engagements.defineOffering(asProviderAdmin(), {
      name: 'Bid retainer',
      engagementType: 'PERMANENT',
      billingBasis: 'MONTHLY',
      defaultFeeMinor: 80_000,
      currency: 'GBP',
      deliverables: ['Tender-portal watch', 'Bid/no-bid advice', 'Content library kept current'],
    });
    assert.equal(retainer.billingBasis, 'MONTHLY');

    const catalogue = engagements.offeringCatalogue(asProviderAdmin());
    assert.ok(catalogue.offerings.length >= 2);
    assert.match(catalogue.summary, /active service/);
  });

  it('does not let the bid writer set a price', () => {
    throwsCode(
      () =>
        engagements.defineOffering(asBidWriter(), {
          name: 'Something cheaper',
          engagementType: 'ONE_OFF',
          billingBasis: 'FIXED_FEE',
          defaultFeeMinor: 1,
          currency: 'GBP',
          deliverables: ['A discount'],
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('a customer workspace is walled off from the provider’s other customers', () => {
  let thornhill: customers.CustomerAccount;

  it('opens one, visible to its author and to nobody else by default', () => {
    thornhill = customers.openCustomer(asProviderAdmin(), PROFILE);
    assert.match(thornhill.reference, /^CUS-\d{4}$/);
    assert.equal(thornhill.status, 'ACTIVE');
    assert.deepEqual(thornhill.assignedStaff, [asProviderAdmin().auth.actorId]);
    assert.equal(thornhill.profile.headcount, 38);

    // Restrictive by default. The opposite default is one forgotten exclusion
    // away from a competitor's evidence on the wrong screen.
    assert.equal(
      customers.maySeeCustomer(thornhill, asBidWriter().auth.actorId),
      false,
      'an unassigned member of staff can already see a new customer',
    );
    assert.equal(customers.maySeeCustomer(thornhill, asProviderAdmin().auth.actorId), true);
  });

  it('refuses a second workspace for the same firm', () => {
    // Two workspaces for one firm is how its evidence library ends up split in
    // half, and which of the two is the real one is not a question the platform
    // can answer.
    const error = throwsCode(
      () => customers.openCustomer(asProviderAdmin(), { legalName: 'thornhill electrical services ltd' }),
      'BID_ON_CUSTOMER_EXISTS',
    );
    assert.match(String(error.message), /split in half/);
  });

  it('hides it from the register of anybody not assigned, and says it is hiding it', () => {
    const mine = customers.customerRegister(asProviderAdmin());
    assert.ok(mine.customers.some((entry) => entry.id === thornhill.id));

    const theirs = customers.customerRegister(asBidWriter());
    assert.ok(
      !theirs.customers.some((entry) => entry.id === thornhill.id),
      'an unassigned bid writer can read another customer’s workspace',
    );
    // Said rather than hidden. A list that looks complete and is not is worse
    // than one that names what it withheld.
    assert.ok(
      theirs.limits.some((line) => /further customer\(s\) exist/.test(line)),
      'the register looks complete while withholding customers',
    );

    const direct = throwsCode(
      () => customers.customerWorkspace(asBidWriter(), thornhill.id),
      'BID_ON_CUSTOMER_NOT_ASSIGNED',
    );
    assert.match(String(direct.message), /compete with each other/);
  });

  it('assigns staff, and keeps the author’s access whatever anybody asks', () => {
    const assigned = customers.assignStaff(asProviderAdmin(), thornhill.id, { add: [asBidWriter().auth.actorId] });
    assert.ok(assigned.assignedStaff.includes(asBidWriter().auth.actorId));
    assert.ok(customers.customerRegister(asBidWriter()).customers.some((entry) => entry.id === thornhill.id));

    throwsCode(
      () => customers.assignStaff(asProviderAdmin(), thornhill.id, { remove: [thornhill.openedBy] }),
      'BID_ON_CANNOT_UNASSIGN_AUTHOR',
    );
  });

  it('will not let one login be a guest of two customers', () => {
    const second = customers.openCustomer(asProviderAdmin(), { legalName: 'Calder Civils Ltd' });
    customers.inviteGuest(asProviderAdmin(), thornhill.id, {
      actorId: 'guest-thornhill-admin',
      organisation: 'Thornhill Electrical Services Ltd',
      role: 'CUSTOMER_ADMIN',
    });

    // Two competitors' evidence behind one account is the exact failure the
    // whole wall exists to prevent.
    const error = throwsCode(
      () =>
        customers.inviteGuest(asProviderAdmin(), second.id, {
          actorId: 'guest-thornhill-admin',
          organisation: 'Thornhill Electrical Services Ltd',
          role: 'CUSTOMER_ADMIN',
        }),
      'BID_ON_GUEST_ELSEWHERE',
    );
    assert.match(String(error.message), /cannot see two customers/);

    throwsCode(
      () =>
        customers.inviteGuest(asProviderAdmin(), thornhill.id, {
          actorId: 'guest-thornhill-admin',
          organisation: 'Thornhill Electrical Services Ltd',
          role: 'CUSTOMER_CONTRIBUTOR',
        }),
      'BID_ON_GUEST_EXISTS',
    );
  });
});

describe('a declaration is the customer’s own statement, and only theirs', () => {
  let account: customers.CustomerAccount;

  before(() => {
    account = customers.openCustomer(asProviderAdmin(), { legalName: 'Pennine Site Services Ltd' });
    account = customers.inviteGuest(asProviderAdmin(), account.id, {
      actorId: 'pennine-admin',
      organisation: 'Pennine Site Services Ltd',
      role: 'CUSTOMER_ADMIN',
    });
    account = customers.inviteGuest(asProviderAdmin(), account.id, {
      actorId: 'pennine-staff',
      organisation: 'Pennine Site Services Ltd',
      role: 'CUSTOMER_CONTRIBUTOR',
    });
  });

  const insurance = {
    kind: 'INSURANCE' as const,
    statement: 'Employers liability cover of £10m each and every claim, and public liability of £10m',
    value: '£10m each and every claim',
  };

  it('refuses the provider’s own staff, however senior', () => {
    // The load-bearing rule. A bid writer confirming an insurance value is a
    // representation to a buyer by somebody who does not have the facts.
    const error = throwsCode(
      () => customers.confirmDeclaration(asProviderAdmin(), account.id, insurance),
      'BID_ON_DECLARATION_NOT_YOURS',
    );
    assert.match(String(error.message), /never by the provider writing the bid and never by an agent/);
    assert.match(String(error.message), /whoever confirms it is who the buyer will hold to it/);
  });

  it('refuses the customer’s own contributor, who may upload but may not speak for the company', () => {
    throwsCode(
      () => customers.confirmDeclaration(asGuest('pennine-staff'), account.id, insurance),
      'BID_ON_DECLARATION_NEEDS_ADMIN',
    );
  });

  it('accepts the customer’s admin, and records whose company they belong to', () => {
    const declared = customers.confirmDeclaration(asGuest('pennine-admin'), account.id, {
      ...insurance,
      validUntil: '2027-04-01',
    });
    assert.equal(declared.confirmedBy, 'pennine-admin');
    assert.equal(declared.confirmedByOrganisation, 'Pennine Site Services Ltd');
    assert.equal(declared.kind, 'INSURANCE');
  });

  it('supersedes rather than overwrites, and reads live against the day the buyer reads it', () => {
    const first = customers.customerWorkspace(asProviderAdmin(), account.id).declarations[0]!;
    customers.confirmDeclaration(asGuest('pennine-admin'), account.id, {
      kind: 'INSURANCE',
      statement: 'Employers liability cover of £10m and public liability raised to £15m on renewal',
      value: '£15m each and every claim',
      validUntil: '2028-04-01',
      supersedes: first.id,
    });

    const workspace = customers.customerWorkspace(asProviderAdmin(), account.id, '2027-01-01');
    // Nothing is removed. What the company said last year is what a bid that
    // went out on it said too.
    assert.equal(workspace.declarations.length, 2);
    assert.equal(workspace.liveDeclarations.length, 1);
    assert.match(String(workspace.liveDeclarations[0]!.value), /15m/);

    // Judged against the date given, not today: a confirmation that lapses the
    // week before the buyer reads the submission is not a confirmation for it.
    const afterRenewal = customers.customerWorkspace(asProviderAdmin(), account.id, '2029-01-01');
    assert.deepEqual(afterRenewal.liveDeclarations, []);
  });

  it('says on the register when nobody can confirm one at all', () => {
    customers.openCustomer(asProviderAdmin(), { legalName: 'Ribble Groundworks Ltd' });
    const register = customers.customerRegister(asProviderAdmin());
    assert.ok(
      register.limits.some((line) => /cannot confirm on their behalf/.test(line)),
      'a customer with no guest invited is not flagged',
    );
  });
});

describe('an engagement is the terms work is billed against', () => {
  let account: customers.CustomerAccount;
  let oneOff: engagements.Engagement;

  before(() => {
    account = customers.openCustomer(asProviderAdmin(), { legalName: 'Wharfedale Electrical Ltd' });
  });

  it('takes a copy of the catalogue’s terms, so repricing the service never moves it', () => {
    const offering = engagements.defineOffering(asProviderAdmin(), {
      name: 'Prequalification pack 2027',
      engagementType: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      defaultFeeMinor: 150_000,
      currency: 'GBP',
      depositPercent: 50,
      deliverables: ['Full questionnaire', 'HSEQ policy set'],
    });

    oneOff = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account.id,
      name: 'UVDB prequalification',
      type: 'ONE_OFF',
      offeringId: offering.id,
    });
    assert.equal(oneOff.feeMinor, 150_000);
    assert.equal(oneOff.depositPercent, 50);
    assert.deepEqual(oneOff.deliverables, ['Full questionnaire', 'HSEQ policy set']);
    assert.equal(oneOff.status, 'DRAFT');

    engagements.updateOffering(asProviderAdmin(), offering.id, { defaultFeeMinor: 300_000 });
    const unchanged = engagements
      .engagementRegister(asProviderAdmin())
      .engagements.find((entry) => entry.id === oneOff.id)!;
    assert.equal(unchanged.feeMinor, 150_000, 'repricing the service moved an engagement already signed');
  });

  it('refuses work until it is activated, and says why', () => {
    const standing = engagements.engagementOpenForWork(oneOff);
    assert.equal(standing.open, false);
    assert.match(String(standing.reason), /has not been activated/);
    throwsCode(() => engagements.requireOpenEngagement(asProviderAdmin(), oneOff.id), 'BID_ON_ENGAGEMENT_NOT_OPEN');

    const active = engagements.activateEngagement(asProviderAdmin(), oneOff.id);
    assert.equal(active.status, 'ACTIVE');
    assert.equal(engagements.engagementOpenForWork(active).open, true);

    // Activating twice is not a correction.
    throwsCode(() => engagements.activateEngagement(asProviderAdmin(), oneOff.id), 'BID_ON_NOT_DRAFT');
  });

  it('pauses any type, blocks work while paused, and resumes exactly where it stopped', () => {
    const paused = engagements.pauseEngagement(asProviderAdmin(), oneOff.id, {
      reason: 'Customer deferred the submission to the next framework window',
    });
    assert.equal(paused.status, 'PAUSED');

    const blocked = engagements.engagementOpenForWork(paused);
    assert.equal(blocked.open, false);
    assert.match(String(blocked.reason), /Nothing is lost and nothing is billed/);
    throwsCode(() => engagements.requireOpenEngagement(asProviderAdmin(), oneOff.id), 'BID_ON_ENGAGEMENT_NOT_OPEN');

    throwsCode(
      () => engagements.pauseEngagement(asProviderAdmin(), oneOff.id, { reason: 'Pausing it twice over' }),
      'BID_ON_NOT_ACTIVE',
    );

    const resumed = engagements.resumeEngagement(asProviderAdmin(), oneOff.id);
    assert.equal(resumed.status, 'ACTIVE');
    // How long they were away, and why, stays on the record — otherwise a
    // stop-start engagement is indistinguishable from one that never stopped.
    assert.ok(resumed.pausedAt, 'the pause was erased by resuming');
    assert.match(String(resumed.pauseReason), /deferred the submission/);
    assert.ok(resumed.resumedAt);
  });

  it('refuses a pause nobody explained', () => {
    throwsCode(
      () => engagements.pauseEngagement(asProviderAdmin(), oneOff.id, { reason: 'later' }),
      'BID_ON_REASON_TOO_SHORT',
    );
  });

  it('versions the terms rather than editing them', () => {
    const before_ = engagements
      .engagementRegister(asProviderAdmin())
      .engagements.find((entry) => entry.id === oneOff.id)!;

    const retermed = engagements.retermEngagement(asProviderAdmin(), oneOff.id, {
      reason: 'Scope extended to the ITT stage at the customer\u2019s request',
      feeMinor: 250_000,
    });

    assert.equal(retermed.feeMinor, 250_000);
    // The old terms stay. A fee edited in place would rewrite what the customer
    // owed for work already delivered, and last month's statement would change
    // after it was sent.
    assert.equal(retermed.termsHistory.length, before_.termsHistory.length + 1);
    assert.equal(retermed.termsHistory[0]!.feeMinor, 150_000, 'the original fee was overwritten');
    assert.match(String(retermed.termsHistory.at(-1)!.reason), /extended to the ITT stage/);
    assert.equal(retermed.termsHistory.at(-1)!.by, asProviderAdmin().auth.actorId);

    throwsCode(
      () => engagements.retermEngagement(asProviderAdmin(), oneOff.id, { reason: 'no', feeMinor: 1 }),
      'BID_ON_REASON_TOO_SHORT',
    );
  });

  it('completes, and refuses everything afterwards', () => {
    const closed = engagements.closeEngagement(asProviderAdmin(), oneOff.id, {
      outcome: 'COMPLETED',
      reason: 'Prequalification pack delivered and the customer was accepted onto the framework',
    });
    assert.equal(closed.status, 'COMPLETED');

    const standing = engagements.engagementOpenForWork(closed);
    assert.equal(standing.open, false);
    assert.match(String(standing.reason), /readable and nothing more can be written/);

    throwsCode(
      () =>
        engagements.retermEngagement(asProviderAdmin(), oneOff.id, {
          reason: 'Trying to reprice finished work',
          feeMinor: 1,
        }),
      'BID_ON_ENGAGEMENT_CLOSED',
    );
    throwsCode(
      () => engagements.closeEngagement(asProviderAdmin(), oneOff.id, { outcome: 'CANCELLED', reason: 'Closing it twice' }),
      'BID_ON_ENGAGEMENT_CLOSED',
    );
  });

  it('will not complete an engagement that never started', () => {
    // The record should say the work never started rather than that it finished.
    const never = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account.id,
      name: 'Tender that was abandoned',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 250_000,
      currency: 'GBP',
    });
    const error = throwsCode(
      () => engagements.closeEngagement(asProviderAdmin(), never.id, { outcome: 'COMPLETED', reason: 'Calling it done' }),
      'BID_ON_NOT_ACTIVE',
    );
    assert.match(String(error.message), /Cancel it instead/);

    const cancelled = engagements.closeEngagement(asProviderAdmin(), never.id, {
      outcome: 'CANCELLED',
      reason: 'The customer decided not to bid for this framework after all',
    });
    assert.equal(cancelled.status, 'CANCELLED');
  });
});

describe('a staged engagement waits for a sign-off', () => {
  let account: customers.CustomerAccount;
  let staged: engagements.Engagement;

  before(() => {
    account = customers.openCustomer(asProviderAdmin(), { legalName: 'Airedale Utilities Ltd' });
  });

  it('refuses one stage, because that is a one-off with extra paperwork', () => {
    const error = throwsCode(
      () =>
        engagements.openEngagement(asProviderAdmin(), {
          customerAccountId: account.id,
          name: 'Prequalification only',
          type: 'STAGED',
          billingBasis: 'PER_STAGE',
          feeMinor: 0,
          currency: 'GBP',
          stages: [{ name: 'Prequalification', scope: 'The UVDB questionnaire in full', feeMinor: 150_000 }],
        }),
      'BID_ON_STAGES_REQUIRED',
    );
    assert.match(String(error.message), /will not open its next stage until somebody signs off the last/);
  });

  it('refuses a stage with no scope, and stages on a type that does not run in them', () => {
    throwsCode(
      () =>
        engagements.openEngagement(asProviderAdmin(), {
          customerAccountId: account.id,
          name: 'Vague stages',
          type: 'STAGED',
          billingBasis: 'PER_STAGE',
          feeMinor: 0,
          currency: 'GBP',
          stages: [
            { name: 'Stage one', scope: 'bits', feeMinor: 1 },
            { name: 'Stage two', scope: 'more bits', feeMinor: 1 },
          ],
        }),
      'BID_ON_SCOPE_TOO_SHORT',
    );

    throwsCode(
      () =>
        engagements.openEngagement(asProviderAdmin(), {
          customerAccountId: account.id,
          name: 'Retainer with stages',
          type: 'PERMANENT',
          billingBasis: 'MONTHLY',
          feeMinor: 80_000,
          currency: 'GBP',
          stages: [
            { name: 'Stage one', scope: 'The first part of the work', feeMinor: 1 },
            { name: 'Stage two', scope: 'The second part of the work', feeMinor: 1 },
          ],
        }),
      'BID_ON_STAGES_UNUSED',
    );
  });

  it('opens the first stage and leaves the rest pending', () => {
    staged = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account.id,
      name: 'Prequalification, then tender, then clarifications',
      type: 'STAGED',
      billingBasis: 'PER_STAGE',
      feeMinor: 0,
      currency: 'GBP',
      stages: [
        { name: 'Prequalification', scope: 'The UVDB questionnaire in full, with the policy set', feeMinor: 150_000 },
        { name: 'Tender', scope: 'Quality answers and win themes for the ITT', feeMinor: 300_000 },
        { name: 'Clarifications', scope: 'Answers to the buyer\u2019s post-tender questions', feeMinor: 50_000 },
      ],
    });
    engagements.activateEngagement(asProviderAdmin(), staged.id);

    assert.deepEqual(
      staged.stages.map((stage) => stage.status),
      ['OPEN', 'PENDING', 'PENDING'],
    );
  });

  it('refuses a sign-off on a stage that has not opened, and opens exactly one next', () => {
    const tender = staged.stages[1]!;
    const early = throwsCode(
      () => engagements.signOffStage(asProviderAdmin(), staged.id, tender.id, { note: 'Signing the second one first' }),
      'BID_ON_STAGE_NOT_OPEN',
    );
    assert.match(String(early.message), /Stages run in order/);

    const result = engagements.signOffStage(asProviderAdmin(), staged.id, staged.stages[0]!.id, {
      note: 'Questionnaire submitted and the policy set delivered in full',
    });
    assert.equal(result.signedOff.status, 'SIGNED_OFF');
    assert.equal(result.signedOff.signedOffBy, asProviderAdmin().auth.actorId);
    assert.equal(result.opened?.name, 'Tender', 'the next stage did not open');
    // Exactly one. Opening two would bill two pieces of work at once against an
    // engagement that bills per stage.
    assert.deepEqual(
      result.engagement.stages.map((stage) => stage.status),
      ['SIGNED_OFF', 'OPEN', 'PENDING'],
    );

    throwsCode(
      () =>
        engagements.signOffStage(asProviderAdmin(), staged.id, result.signedOff.id, {
          note: 'Signing the same stage twice over',
        }),
      'BID_ON_STAGE_SIGNED_OFF',
    );
  });

  it('does not let the bid writer sign off a stage', () => {
    const open = engagements
      .engagementRegister(asProviderAdmin())
      .engagements.find((entry) => entry.id === staged.id)!.openStage!;
    customers.assignStaff(asProviderAdmin(), account.id, { add: [asBidWriter().auth.actorId] });
    throwsCode(
      () => engagements.signOffStage(asBidWriter(), staged.id, open.id, { note: 'Signing off my own work here' }),
      'ACCESS_DENIED',
    );
  });
});

describe('a continuous engagement repeats on its schedule', () => {
  let account: customers.CustomerAccount;
  let retainer: engagements.Engagement;

  before(() => {
    account = customers.openCustomer(asProviderAdmin(), { legalName: 'Calderdale Grid Contractors Ltd' });
  });

  it('insists on a schedule, and refuses one where nothing would read it', () => {
    const missing = throwsCode(
      () =>
        engagements.openEngagement(asProviderAdmin(), {
          customerAccountId: account.id,
          name: 'Weekly tender watch',
          type: 'CONTINUOUS',
          billingBasis: 'PER_CYCLE',
          feeMinor: 80_000,
          currency: 'GBP',
        }),
      'BID_ON_SCHEDULE_REQUIRED',
    );
    assert.match(String(missing.message), /a cycle that never opens is a retainer the customer is paying for/);

    throwsCode(
      () =>
        engagements.openEngagement(asProviderAdmin(), {
          customerAccountId: account.id,
          name: 'One-off with a schedule',
          type: 'ONE_OFF',
          billingBasis: 'FIXED_FEE',
          feeMinor: 150_000,
          currency: 'GBP',
          schedule: 'WEEKLY',
        }),
      'BID_ON_SCHEDULE_UNUSED',
    );
  });

  it('opens one cycle at a time, with the due date derived from the last rather than from today', () => {
    retainer = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account.id,
      name: 'Annual re-verification',
      type: 'CONTINUOUS',
      billingBasis: 'PER_CYCLE',
      feeMinor: 80_000,
      currency: 'GBP',
      schedule: 'ANNUAL',
      startOn: '2027-01-01',
    });
    engagements.activateEngagement(asProviderAdmin(), retainer.id);

    const first = engagements.openNextCycle(asProviderAdmin(), retainer.id, {
      scope: 'Re-verify the UVDB registration and refresh the policy set',
    });
    const cycle1 = first.stages.at(-1)!;
    assert.equal(cycle1.cycle, 1);
    assert.equal(cycle1.status, 'OPEN');
    assert.equal(cycle1.dueOn, '2028-01-01', 'the first cycle is not due a year after the start');
    assert.equal(cycle1.feeMinor, 80_000);

    // Two open cycles is two cycles billed for one period of work.
    const second = throwsCode(
      () => engagements.openNextCycle(asProviderAdmin(), retainer.id, { scope: 'Opening a second one straight away' }),
      'BID_ON_CYCLE_OPEN',
    );
    assert.match(String(second.message), /two cycles billed for one period of work/);

    engagements.signOffStage(asProviderAdmin(), retainer.id, cycle1.id, {
      note: 'Registration re-verified and the policy set reissued',
    });
    const next = engagements.openNextCycle(asProviderAdmin(), retainer.id, {
      scope: 'Re-verify the registration for the following year',
    });
    const cycle2 = next.stages.at(-1)!;
    assert.equal(cycle2.cycle, 2);
    // Derived from the last cycle, so a gap does not silently reset the cadence.
    assert.equal(cycle2.dueOn, '2029-01-01');
  });

  it('keeps an annual cycle on its calendar date across a leap year', () => {
    /*
     * The defect this caught. The first implementation added 365 days, so
     * 1 January 2028 plus a year came out as 31 December 2028 — 2028 being a
     * leap year — and an annual re-verification would walk a day earlier every
     * four years, drifting out of step with the registration it exists to
     * renew. Silently, over the life of a retainer that is supposed to last.
     */
    const account2 = customers.openCustomer(asProviderAdmin(), { legalName: 'Leap Year Utilities Ltd' });
    const annual = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account2.id,
      name: 'Annual re-verification across a leap year',
      type: 'CONTINUOUS',
      billingBasis: 'PER_CYCLE',
      feeMinor: 80_000,
      currency: 'GBP',
      schedule: 'ANNUAL',
      startOn: '2027-01-01',
    });
    engagements.activateEngagement(asProviderAdmin(), annual.id);

    const due: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const opened = engagements.openNextCycle(asProviderAdmin(), annual.id, {
        scope: `Re-verify the registration for cycle ${i + 1} of the retainer`,
      });
      const stage = opened.stages.at(-1)!;
      due.push(String(stage.dueOn));
      engagements.signOffStage(asProviderAdmin(), annual.id, stage.id, {
        note: `Cycle ${i + 1} delivered and signed off at the annual review`,
      });
    }
    assert.deepEqual(due, ['2028-01-01', '2029-01-01', '2030-01-01', '2031-01-01']);
  });

  it('clamps a monthly cycle to the end of a short month rather than rolling into the next', () => {
    // 31 January plus one month is 28 or 29 February, never 2 or 3 March.
    // Rolling over would move a monthly cycle forward a few days every short
    // month, which is the same drift by a different route.
    const account2 = customers.openCustomer(asProviderAdmin(), { legalName: 'Month End Electrical Ltd' });
    const monthly = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account2.id,
      name: 'Month-end tender watch',
      type: 'CONTINUOUS',
      billingBasis: 'PER_CYCLE',
      feeMinor: 80_000,
      currency: 'GBP',
      schedule: 'MONTHLY',
      startOn: '2027-01-31',
    });
    engagements.activateEngagement(asProviderAdmin(), monthly.id);

    const first = engagements.openNextCycle(asProviderAdmin(), monthly.id, {
      scope: 'Watch the portals for the month and advise on bid/no-bid',
    });
    assert.equal(first.stages.at(-1)!.dueOn, '2027-02-28');
  });

  it('refuses a cycle on an engagement that does not repeat, and while it is paused', () => {
    const oneOff = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account.id,
      name: 'A single submission',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 250_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(asProviderAdmin(), oneOff.id);
    throwsCode(
      () => engagements.openNextCycle(asProviderAdmin(), oneOff.id, { scope: 'A cycle on something that does not repeat' }),
      'BID_ON_NOT_CONTINUOUS',
    );

    engagements.pauseEngagement(asProviderAdmin(), retainer.id, {
      reason: 'Customer paused the retainer over the winter shutdown',
    });
    throwsCode(
      () => engagements.openNextCycle(asProviderAdmin(), retainer.id, { scope: 'A cycle while the work is paused' }),
      'BID_ON_ENGAGEMENT_NOT_OPEN',
    );
  });

  it('reports a retainer with no cycle open, because that is one being billed and not delivered', () => {
    engagements.resumeEngagement(asProviderAdmin(), retainer.id);
    const open = engagements
      .engagementRegister(asProviderAdmin())
      .engagements.find((entry) => entry.id === retainer.id)!.openStage!;
    engagements.signOffStage(asProviderAdmin(), retainer.id, open.id, {
      note: 'Cycle delivered and signed off at the review',
    });

    const register = engagements.engagementRegister(asProviderAdmin());
    assert.ok(
      register.limits.some((line) => /no open cycle/.test(line)),
      'a retainer with nothing open is not reported',
    );
  });
});

describe('closing a customer', () => {
  it('refuses while an engagement is still open, and names them', () => {
    const account = customers.openCustomer(asProviderAdmin(), { legalName: 'Holme Valley Power Ltd' });
    const live = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: account.id,
      name: 'Live retainer',
      type: 'PERMANENT',
      billingBasis: 'MONTHLY',
      feeMinor: 80_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(asProviderAdmin(), live.id);

    const error = throwsCode(
      () => customers.closeCustomer(asProviderAdmin(), account.id, { reason: 'Closing with live work under it' }),
      'BID_ON_ENGAGEMENTS_OPEN',
    );
    assert.match(String(error.message), new RegExp(live.reference));
    assert.match(String(error.message), /leaving it running under a closed customer/);

    engagements.closeEngagement(asProviderAdmin(), live.id, {
      outcome: 'COMPLETED',
      reason: 'Retainer ended by agreement at the end of the term',
    });
    const closed = customers.closeCustomer(asProviderAdmin(), account.id, {
      reason: 'Customer was acquired and the relationship moved to the parent group',
    });
    assert.equal(closed.status, 'CLOSED');
    // Nothing is deleted.
    assert.ok(customers.customerRegister(asProviderAdmin()).customers.some((entry) => entry.id === account.id));

    // And no new work can be opened against it.
    throwsCode(
      () =>
        engagements.openEngagement(asProviderAdmin(), {
          customerAccountId: account.id,
          name: 'Work against a closed customer',
          type: 'ONE_OFF',
          billingBasis: 'FIXED_FEE',
          feeMinor: 150_000,
          currency: 'GBP',
        }),
      'BID_ON_CUSTOMER_CLOSED',
    );
  });
});
