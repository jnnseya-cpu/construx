import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as business from '../src/domain/business.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as evidence from '../src/domain/bidon/evidence.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as importing from '../src/domain/bidon/importing.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import type { CriterionScores } from '../src/domain/bidon/rubric.ts';

/**
 * A submission with no return date.
 *
 * ## Why this shape exists
 *
 * Everything in Bid-On judged expiry, insurance and declarations against the
 * bid's deadline, because on an ITT that is the day the buyer reads it and a
 * certificate lapsing the week before return is not evidence for that
 * submission. Two things a provider actually chases have no such day:
 *
 *   - a **dynamic market** under the Procurement Act, which accepts
 *     applications at any point in its life and cannot cap its membership;
 *   - a **registration that is maintained** rather than returned — UVDB,
 *     Constructionline — which is live until it lapses.
 *
 * The available workaround was to put a target date in the deadline field, and
 * that is what this exists to avoid: every verdict in the pack would then be
 * judged against a date somebody made up, and "this certificate lapses before
 * the deadline" would be a statement about an invention.
 *
 * So a rolling bid carries **no deadline at all** and is judged against the day
 * it is read, every time it is read. The tests below pin down the three things
 * that follow: it cannot be created ambiguously, the judgement day is published
 * on every read, and a pack genuinely goes red on its own as a certificate ages.
 */

let platform: Platform;
let seed: SeedResult;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const REASONS: Record<string, string> = {
  COMPLIANCE: 'Every part of the question is answered in the order asked',
  EVIDENCE: 'Each claim is cited to an in-date item',
  BUYER_RELEVANCE: 'Framed for a utilities buyer and the scheme',
  SPECIFICITY: 'Names the scheme, the figures and the dates',
  CLARITY_AND_LIMITS: 'Inside the word limit and plainly written',
};

const FULL: CriterionScores = {
  COMPLIANCE: 90,
  EVIDENCE: 90,
  BUYER_RELEVANCE: 90,
  SPECIFICITY: 90,
  CLARITY_AND_LIMITS: 90,
};

let customer: customers.CustomerAccount;
let engagement: engagements.Engagement;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    agreementRef: 'AGR-BIDON-2026-001',
    decidedBy: seed.users.operator!.id,
  });

  customer = customers.openCustomer(asProviderAdmin(), { legalName: 'Thornhill Electrical Services Ltd' });
  customers.assignStaff(asProviderAdmin(), customer.id, { add: [asBidWriter().auth.actorId] });
  engagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: customer.id,
    name: 'Dynamic market application',
    // A continuous engagement cannot be billed a fixed fee — the module
    // refuses the pair, because a basis that does not fit the type has no
    // answer to "what does the next one cost". Monthly is the shape a
    // maintained registration actually takes.
    type: 'CONTINUOUS',
    billingBasis: 'MONTHLY',
    // And it needs a schedule, because something has to decide when the next
    // cycle opens — a cycle that never opens is a retainer being paid for and
    // not received. Annual is the shape a UVDB re-verification takes.
    schedule: 'ANNUAL',
    feeMinor: 150_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), engagement.id);
});

/** A rolling bid with one mandatory question and nothing answered. */
function rollingBid(scheme: bids.BidScheme = 'UVDB'): bids.Bid {
  const bid = bids.createBid(asProviderAdmin(), {
    engagementId: engagement.id,
    buyerName: 'National Grid Electricity Transmission',
    scheme,
    rolling: true,
  });
  bids.confirmQuestions(asProviderAdmin(), bid.id, {
    questions: [
      {
        section: 'Insurance',
        number: 'Q1',
        text: 'Confirm your employers’ liability cover and provide the certificate.',
        answerType: 'TEXT',
        mandatory: true,
        passFail: false,
      },
    ],
  });
  return bids.requireBid(asProviderAdmin(), bid.id);
}

describe('the shape is declared, routed and unambiguous', () => {
  it('takes a deadline or rolling, and refuses both or neither', () => {
    const neither = throwsCode(
      () =>
        bids.createBid(asProviderAdmin(), {
          engagementId: engagement.id,
          buyerName: 'National Grid Electricity Transmission',
          scheme: 'UVDB',
        }),
      'BID_ON_DEADLINE_REQUIRED',
    );
    // The refusal has to teach the shape, or somebody invents a date instead.
    assert.match(String(neither.message), /rolling/);

    throwsCode(
      () =>
        bids.createBid(asProviderAdmin(), {
          engagementId: engagement.id,
          buyerName: 'National Grid Electricity Transmission',
          scheme: 'UVDB',
          rolling: true,
          deadline: '2027-06-01',
        }),
      'BID_ON_ROLLING_HAS_DEADLINE',
    );
  });

  it('leaves the deadline absent rather than filling it in', () => {
    const bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'UVDB',
      rolling: true,
    });
    // Absent, not today, and not an empty string. A date in this field is a
    // date every verdict in the pack would be judged against.
    assert.equal(bid.deadline, undefined);
    assert.equal(bid.rolling, true);
  });

  it('still routes the create, and no longer demands a deadline at the schema', () => {
    const route = ROUTES.find((entry) => entry.method === 'POST' && entry.pattern === '/v1/bid-on/bids')!;
    const schema = route.schema as { required: string[]; properties: Record<string, unknown> };
    assert.ok(!schema.required.includes('deadline'), 'the schema still demands a deadline');
    assert.ok(schema.properties.rolling, 'the schema does not accept rolling');
    // Exactly-one-of is checked in the domain, where the refusal can name which
    // mistake was made. A schema demanding one of two fields would say neither.
    assert.ok(schema.required.includes('engagementId'));
  });
});

describe('judgedOn decides the day, and one function decides it', () => {
  it('is the deadline on a dated bid and the read date on a rolling one', () => {
    assert.equal(bids.judgedOn({ deadline: '2027-06-01' }, '2026-10-20'), '2027-06-01');
    assert.equal(bids.judgedOn({ rolling: true }, '2026-10-20'), '2026-10-20');
    // A dated bid ignores the read date entirely, which is the original rule
    // and the one that must not have moved.
    assert.equal(bids.judgedOn({ deadline: '2027-06-01' }), '2027-06-01');
  });

  it('publishes the day it used on every position', () => {
    const bid = rollingBid();
    const asRead = bids.bidPosition(asProviderAdmin(), bid.id, '2026-11-01');
    assert.equal(asRead.judgementDay, '2026-11-01');
    // A readiness figure somebody screenshots is worthless without the date it
    // was true on, and on a rolling bid that date is today.
    assert.ok(asRead.limits.some((line) => /judged against today \(2026-11-01\)/.test(line)));
  });
});

describe('a certificate ageing takes a rolling pack backwards on its own', () => {
  let bid: bids.Bid;

  before(() => {
    bid = rollingBid();
    const certificate = evidence.fileEvidence(asProviderAdmin(), {
      customerAccountId: customer.id,
      type: 'INSURANCE',
      title: 'Employers’ liability certificate',
      hash: `sha256:${'a'.repeat(64)}`,
      expiresOn: '2027-01-31',
    });
    const read = evidence.recordExtraction(asProviderAdmin(), certificate.id, {
      extractedText: ['Employers’ liability, £10m each and every claim.'],
      chunks: [
        {
          pageRef: 'page 1',
          text:
            'Employers’ liability insurance is held at £10,000,000 each and every claim, renewed annually and ' +
            'evidenced by the certificate attached.',
        },
      ],
    });

    const question = bid.questions[0]!;
    const written = bids.recordAnswer(asBidWriter(), bid.id, {
      questionId: question.id,
      body: ['We hold employers’ liability cover of £10m each and every claim.'],
      citations: [{ evidenceId: read.id, chunkId: read.chunks[0]!.id }],
    });
    bids.scoreAnswer(asProviderAdmin(), bid.id, written.answer.id, { scores: FULL, reasons: REASONS });
    bids.approveAnswer(asProviderAdmin(), bid.id, written.answer.id, {
      note: 'Read against the certificate; the figure and the renewal date match.',
    });
  });

  it('is exportable while the certificate is current on the day it is read', () => {
    const position = bids.bidPosition(asProviderAdmin(), bid.id, '2026-12-01');
    assert.equal(position.judgementDay, '2026-12-01');
    assert.equal(position.readiness.exportable, true);
    assert.equal(position.readiness.red, 0);
  });

  it('is red on a later read, with no event in between', () => {
    // Nothing was written. The same record, read on a day after the
    // certificate lapses, is a different and correct answer — which is exactly
    // what a dated bid cannot express and what a maintained registration needs.
    const later = bids.bidPosition(asProviderAdmin(), bid.id, '2027-02-15');
    assert.equal(later.judgementDay, '2027-02-15');
    assert.equal(later.readiness.exportable, false);
    assert.equal(later.readiness.red, 1);
    const verdict = later.questions[0]!.verdict;
    assert.ok(
      verdict.hardRules.some((rule) => rule.rule === 'EVIDENCE_LAPSES_BEFORE_DEADLINE'),
      'the lapsed certificate did not fire the hard rule',
    );
  });

  it('says so in the pack it renders, rather than printing a return date', () => {
    const pack = bids.renderPack(
      asProviderAdmin(),
      bid.id,
      'TEXT',
      platform.exports.branding(seed.tenantId),
    );
    // A buyer must not read "Return by <today>" off the front page of something
    // that has no return date.
    assert.doesNotMatch(pack.content, /Return by/);
  });
});

describe('the register and the agent do not invent a countdown', () => {
  it('reports no days left, sorts rolling last, and never calls one late', () => {
    // A dated bid long past its deadline, beside a rolling one.
    const dated = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Yorkshire Water Services Limited',
      scheme: 'ITT',
      deadline: '2026-01-05',
    });
    const rolling = rollingBid('CONSTRUCTIONLINE');

    const register = bids.bidRegister(asProviderAdmin(), '2026-10-20');
    const rollingRow = register.bids.find((row) => row.id === rolling.id)!;
    const datedRow = register.bids.find((row) => row.id === dated.id)!;

    assert.equal(rollingRow.daysLeft, null);
    assert.equal(rollingRow.deadline, undefined);
    assert.equal(rollingRow.rolling, true);
    assert.ok(datedRow.daysLeft !== null && datedRow.daysLeft < 0);

    // The dated one is late. The rolling one is not, and never will be: a
    // permanent false alarm on every membership a provider maintains is how a
    // register stops being read.
    assert.ok(register.limits.some((line) => /past their deadline/.test(line)));
    assert.match(
      register.limits.find((line) => /rolling submissions/.test(line)) ?? '',
      /judged against today/,
    );

    // Soonest first, with the ones that have no date at the end rather than at
    // the front where the most urgent thing belongs.
    const order = register.bids.map((row) => row.id);
    assert.ok(order.indexOf(datedRow.id) < order.indexOf(rollingRow.id));
  });
});

describe('importing, and the one path this shape does not reach', () => {
  /*
   * Stated rather than claimed, because the test below asserts the *dated*
   * outcome and its first draft was titled as if it asserted the rolling one.
   *
   * `importBid` no longer refuses a tender with no return date — it imports it
   * as rolling. That branch is **not reachable through the standard section
   * today**: `recordInvitation` requires a return date by design (the deadline
   * is registered the hour the ITT lands, before anybody has read a word of
   * it), so `deadlineInForce` always answers and the digest always carries a
   * date. The branch is defensive, for a record with no `issue` block.
   *
   * That costs nothing, because importing was always a shortcut. A dynamic
   * market application is started here with `rolling: true` and never needs the
   * tender recorded in the standard section at all — which is the path every
   * other test in this file exercises. Making the standard section able to
   * record a dateless invitation is a change to its countdown, its
   * clarifications and its re-review rules, and it is recorded in
   * `docs/STATE.md` rather than smuggled in here.
   */
  it('imports a tender that has a return date as a dated bid', () => {
    // A dynamic market notice: recorded in the standard section like any other
    // invitation, and it has no return date to record.
    const opportunity = business.registerOpportunity(asProviderAdmin(), {
      title: 'Substation construction dynamic market',
      clientName: 'National Grid Electricity Transmission',
      sectorType: 'UTILITIES',
      estimatedValueMinor: 1_000_000_00,
      source: 'Find a Tender — dynamic market',
      countryCode: 'GB',
      city: 'Warwick',
    });
    // A return date, because `recordInvitation` requires one: the standard
    // section's countdown, its clarifications and its re-review rules are all
    // built on it.
    const invitation = tenderintake.recordInvitation(asProviderAdmin(), opportunity.opportunityId, {
      reference: 'NG/DM/SUBSTATION/2026',
      issuedAt: '2026-02-19T09:00:00Z',
      returnLocal: '2027-04-21T12:00',
      timeZone: 'Europe/London',
      timeZoneStated: true,
      channel: 'PORTAL',
      documents: ['Conditions of membership'],
    });

    const imported = importing.importBid(asProviderAdmin(), {
      tenderId: invitation.invitationId,
      engagementId: engagement.id,
      scheme: 'CUSTOM',
    });

    // Dated, and that is the honest outcome: rolling is not the default and
    // not something an import guesses at.
    assert.equal(imported.rolling, false);
    assert.equal(imported.bid.rolling, undefined);
    assert.equal(imported.bid.deadline, '2027-04-21');
  });
});

describe('what a rolling bid still refuses, unchanged', () => {
  it('refuses export while a mandatory answer is unapproved', () => {
    const bid = rollingBid();
    throwsCode(() => bids.exportBid(asProviderAdmin(), bid.id), 'BID_ON_NOT_EXPORTABLE');
  });

  it('is not a way round the question-list confirmation', () => {
    const bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'UVDB',
      rolling: true,
    });
    // No questions confirmed, so there is nothing to be ready. The gate is the
    // same one a dated bid passes through.
    const position = bids.bidPosition(asProviderAdmin(), bid.id);
    assert.equal(position.readiness.exportable, false);
    assert.ok(position.limits.some((line) => /has not been confirmed/.test(line)));
  });
});
