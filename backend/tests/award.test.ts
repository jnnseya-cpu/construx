import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as award from '../src/domain/award.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Submission, award, and the conversion that must not re-key anything.
 *
 * Two moments were missing either side of the locked bid pack, and both are
 * where money is lost.
 *
 * A submission went out and nothing recorded that it arrived — the portal
 * receipt, the one piece of paper proving the bid was in before the clock
 * stopped, lived in somebody's inbox. And an award arrived and was signed with
 * nobody comparing it against what was actually bid, which is where a contract
 * sum quietly differs by £40,000 and where the qualification the price depended
 * on has been struck out.
 *
 * So these tests are about whether the difference is *found* rather than
 * whether a record can be written.
 */

let platform: Platform;
let seed: SeedResult;

const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds both award approval and budget approval, which converting needs. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

const RECEIPT = `sha256:${'c'.repeat(64)}`;
const LETTER = `sha256:${'d'.repeat(64)}`;

const receipt = (over: Partial<award.SubmissionReceipt> = {}): award.SubmissionReceipt => ({
  reference: 'ASH/2027/014/SUB/0091',
  channel: 'PORTAL',
  receivedAt: '2027-03-12T11:52:00.000Z',
  evidenceHash: RECEIPT,
  ...over,
});

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── The comparison, on its own ──────────────────────────────────────────────

describe('award · a departure is a difference, not an opinion', () => {
  const submitted = {
    contractSumMinor: 18_400_000_00,
    commencementDate: '2027-05-04',
    completionDate: '2028-11-17',
    liquidatedDamagesPerDayMinor: 5_000_00,
    ldCapPercent: 5,
    retentionPercent: 3,
    defectsLiabilityMonths: 12,
    qualifications: [
      'Price excludes any works to the existing substation',
      'Price assumes unrestricted site access from 07:00',
    ],
  };

  it('finds nothing when the award is what was bid', () => {
    const departures = award.departuresBetween(submitted, {
      contractSumMinor: 18_400_000_00,
      commencementDate: '2027-05-04',
      completionDate: '2028-11-17',
      liquidatedDamagesPerDayMinor: 5_000_00,
      ldCapPercent: 5,
      retentionPercent: 3,
      defectsLiabilityMonths: 12,
      acceptedQualifications: submitted.qualifications,
    });
    assert.deepEqual(departures, []);
  });

  /**
   * Silence is not a change. A letter of intent names two terms and nothing
   * else, and reporting the rest as departures would bury the real ones.
   */
  it('treats a term the award is silent on as unstated, not as changed', () => {
    const departures = award.departuresBetween(submitted, { contractSumMinor: 18_400_000_00 });
    assert.deepEqual(departures, [], 'silence on the other terms was read as a change');
  });

  it('catches a contract sum below the price bid, with the arithmetic', () => {
    const departures = award.departuresBetween(submitted, { contractSumMinor: 18_360_000_00 });
    assert.equal(departures.length, 1);
    assert.equal(departures[0]!.field, 'Contract sum');
    assert.equal(departures[0]!.severity, 'CRITICAL');
    assert.equal(departures[0]!.differenceMinor, -40_000_00);
    assert.match(departures[0]!.detail, /£40,000 below the price bid/);
  });

  /** Being awarded *more* than was bid is a departure too, and for a real reason. */
  it('catches a contract sum above the price bid', () => {
    const departures = award.departuresBetween(submitted, { contractSumMinor: 18_500_000_00 });
    assert.equal(departures[0]!.differenceMinor, 100_000_00);
    assert.match(departures[0]!.detail, /the client has priced something we did not/);
  });

  it('catches a completion date that moved, and says by how many days', () => {
    const earlier = award.departuresBetween(submitted, { completionDate: '2028-10-20' });
    assert.equal(earlier[0]!.field, 'Completion date');
    assert.match(earlier[0]!.detail, /28 days earlier/);
    assert.match(earlier[0]!.detail, /price assumed the longer period/);

    const later = award.departuresBetween(submitted, { completionDate: '2028-12-01' });
    assert.match(later[0]!.detail, /14 days later/);
  });

  it('says when a term is harder than the one the price was given on', () => {
    const harder = award.departuresBetween(submitted, { liquidatedDamagesPerDayMinor: 8_000_00, ldCapPercent: 10 });
    assert.equal(harder.length, 2);
    for (const departure of harder) {
      assert.equal(departure.severity, 'CRITICAL');
      assert.match(departure.detail, /Harder than the terms the price was given on/);
    }
    assert.match(harder[0]!.awarded, /£8,000 per day/);
  });

  it('reports a term that moved in our favour as a departure all the same', () => {
    const softer = award.departuresBetween(submitted, { retentionPercent: 1.5 });
    assert.equal(softer.length, 1);
    assert.match(softer[0]!.detail, /in our favour. Still a departure/);
  });

  /**
   * The single most expensive line on the list. The price was given on this
   * basis, and if it is struck out the thing it excluded is now inside the sum.
   */
  it('catches a qualification the award does not carry', () => {
    const departures = award.departuresBetween(submitted, {
      acceptedQualifications: ['Price assumes unrestricted site access from 07:00'],
    });

    assert.equal(departures.length, 1);
    assert.equal(departures[0]!.field, 'Qualification struck out');
    assert.equal(departures[0]!.severity, 'CRITICAL');
    assert.match(departures[0]!.submitted, /existing substation/);
    assert.match(departures[0]!.detail, /now inside the contract sum/);
  });
});

// ── The whole sequence, on the pack the demonstration actually built ────────

/**
 * One pack, in order, because that is what the workflow is.
 *
 * The seeded project compiles and locks a real bid pack while it is still in
 * the tender phase, and by the time the demonstration finishes the project has
 * moved to operations — where `ESTIMATE_TENDER` writes are correctly gated.
 * So the pack is not re-compiled here: it is the one the platform built, and
 * the sequence runs against it exactly as it would on a live job.
 */
describe('award · submission, award and conversion, in order', () => {
  let packId: string;
  let contentHash: string;
  let estimateTotalMinor: number;

  before(() => {
    const pack = platform.ledger.list(seed.projectId, 'BidSubmissionPack')[0];
    assert.ok(pack, 'the seeded project no longer builds a bid submission pack');
    packId = pack.refId;
    contentHash = String(pack.state.contentHash);
    estimateTotalMinor = Number((pack.state.assembly as { estimateTotalMinor: number }).estimateTotalMinor);

    // `PROCUREMENT_AWARD` writes are gated to TENDER and CONSTRUCTION, which is
    // right — an award is a tender-stage act and recording one against a job in
    // operations is a process error. The demonstration finishes in OPERATIONS,
    // so the fixture moves it back through the platform's own governed
    // regression rather than around the gate.
    structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
      to: 'CONSTRUCTION',
      justification: 'Reopened to record the award against the bid pack this project was won on',
    });
  });

  it('refuses an award against a pack that was never submitted', () => {
    throwsCode(
      () => award.recordAward(asPM(), packId, { outcome: 'WON', reference: 'LOI-1', receivedOn: '2027-04-02', terms: {} }),
      'NOT_SUBMITTED',
    );
  });

  it('refuses a receipt with no reference from the buyer', () => {
    const error = throwsCode(
      () => award.recordSubmission(asQS(), packId, receipt({ reference: '   ' })),
      'RECEIPT_REFERENCE_REQUIRED',
    );
    assert.match(String(error.message), /"Sent" is not a receipt/);
  });

  /** `AC-T-WF-08-01`: the receipt identifies the exact immutable pack hash. */
  it('binds the receipt to the pack’s content hash', () => {
    const submitted = award.recordSubmission(asQS(), packId, receipt());
    assert.equal(submitted.contentHash, contentHash);

    const row = award.awardPosition(asQS()).packs.find((p) => p.packId === packId)!;
    assert.equal(row.submitted?.reference, 'ASH/2027/014/SUB/0091');
    assert.equal(row.submitted?.hashMatches, true);
  });

  it('refuses a second receipt on the same pack', () => {
    throwsCode(() => award.recordSubmission(asQS(), packId, receipt({ reference: 'SECOND' })), 'ALREADY_SUBMITTED');
  });

  it('refuses a win that does not say what was awarded', () => {
    const error = throwsCode(
      () => award.recordAward(asPM(), packId, { outcome: 'WON', reference: 'AW-1', receivedOn: '2027-04-02' }),
      'AWARDED_TERMS_REQUIRED',
    );
    assert.match(String(error.message), /the only moment that comparison is cheap/);
  });

  it('computes the departures rather than asking somebody to notice them', () => {
    // The client accepts every qualification the bid carried except the last
    // one, so exactly two things depart: the sum, and that qualification. Read
    // off the pack rather than hardcoded — the seed's qualifications are the
    // seed's business, and a count baked in here would break when it changes.
    const bid = (platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!.state.assembly as {
      qualifications: string[];
    }).qualifications;
    assert.ok(bid.length >= 1, 'the seeded pack carries no qualifications to strike out');

    const { departures } = award.recordAward(asPM(), packId, {
      outcome: 'WON',
      reference: 'AW-2027-014',
      receivedOn: '2027-04-02',
      evidenceHash: LETTER,
      terms: {
        contractSumMinor: estimateTotalMinor - 40_000_00,
        acceptedQualifications: bid.slice(0, -1),
      },
    });

    assert.equal(departures.length, 2, 'the sum and the struck-out qualification should both be found');
    assert.ok(departures.some((d) => d.field === 'Contract sum' && d.differenceMinor === -40_000_00));
    assert.ok(departures.some((d) => d.field === 'Qualification struck out'));

    const position = award.awardPosition(asQS());
    assert.equal(position.packs.find((p) => p.packId === packId)!.departuresOutstanding, 2);
    assert.match(position.summary, /award departures still open/);
  });

  it('refuses a second award on the same pack', () => {
    throwsCode(
      () => award.recordAward(asPM(), packId, { outcome: 'LOST', reference: 'AW-3', receivedOn: '2027-04-03' }),
      'ALREADY_AWARDED',
    );
  });

  /** `AC-T-WF-08-03`: the departures are visible, and blocking, before execution. */
  it('refuses to convert while a departure is open, and names them', () => {
    const error = throwsCode(
      () =>
        award.convertAward(asOwner(), packId, {
          budgetVersion: 'v1',
          contingencyMinor: 0,
          managementReserveMinor: 0,
          tenderMarginPercent: 6,
        }),
      'DEPARTURES_OUTSTANDING',
    );
    assert.match(String(error.message), /DEP-01 Contract sum/);
    assert.match(String(error.message), /before the money starts moving/);
  });

  it('takes a departure on knowingly, with who agreed and why', () => {
    throwsCode(() => award.acceptDeparture(asPM(), packId, 'DEP-01', 'fine'), 'ACCEPTANCE_REASON_REQUIRED');
    throwsCode(
      () => award.acceptDeparture(asPM(), packId, 'DEP-99', 'No such departure exists on this award'),
      'DEPARTURE_NOT_FOUND',
    );

    const first = award.acceptDeparture(
      asPM(),
      packId,
      'DEP-01',
      'The £40,000 is the provisional sum for the substation, which the client has removed from our scope entirely',
    );
    assert.equal(first.outstanding, 1);

    throwsCode(
      () => award.acceptDeparture(asPM(), packId, 'DEP-01', 'Accepting it a second time for no reason at all'),
      'DEPARTURE_NOT_OPEN',
    );

    const second = award.acceptDeparture(
      asPM(),
      packId,
      'DEP-02',
      'The substation qualification is moot now that the substation is outside our scope',
    );
    assert.equal(second.outstanding, 0);

    // And the record says who agreed, which is the question a year later.
    const stored = platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!;
    const departures = stored.state.departures as Array<{ status: string; acceptedBy?: string; acceptedReason?: string }>;
    assert.ok(departures.every((d) => d.status === 'ACCEPTED'));
    assert.equal(departures[0]!.acceptedBy, seed.users.pm!.id);
    assert.match(String(departures[0]!.acceptedReason), /provisional sum/);
  });

  /**
   * `AC-T-WF-08-02`. Nothing is typed: the sum comes off the award, and the
   * breakdown off the estimate's own priced cost heads. A budget re-keyed from
   * a spreadsheet agrees with the tender until the first typo.
   */
  /**
   * Converting approves a cost baseline, which is a commercial authority. A
   * project manager can accept an award and still not be the person who sets
   * the budget the job is measured against, and the platform says so before it
   * writes anything.
   */
  it('refuses to convert for somebody who cannot approve a budget', () => {
    throwsCode(
      () =>
        award.convertAward(asPM(), packId, {
          budgetVersion: 'v1',
          contingencyMinor: 0,
          managementReserveMinor: 0,
          tenderMarginPercent: 6,
        }),
      'ACCESS_DENIED',
    );
  });

  it('builds the budget and the buyout targets from the estimate, and reconciles', () => {
    const converted = award.convertAward(asOwner(), packId, {
      budgetVersion: 'v1',
      contingencyMinor: 500_000_00,
      managementReserveMinor: 250_000_00,
      tenderMarginPercent: 6,
    });

    assert.equal(converted.contractSumMinor, estimateTotalMinor - 40_000_00);
    assert.ok(converted.buyoutTargets.length > 0, 'no buyout targets were produced');

    const budget = platform.ledger.get({ refType: 'Budget', refId: converted.budgetId })!;
    const estimateId = String(
      platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!.state.estimateId,
    );
    const heads = (platform.ledger.get({ refType: 'Estimate', refId: estimateId })!.state.heads as Array<{
      head: string;
      amountMinor: number;
      status: string;
    }>).filter((h) => h.status === 'PRICED' && h.amountMinor > 0);

    assert.equal((budget.state.byCostCode as unknown[]).length, heads.length);
    assert.equal(
      Number(budget.state.directTotalMinor),
      heads.reduce((total, h) => total + h.amountMinor, 0),
      'the budget does not reconcile to the estimate it was carried from',
    );
    // Buyout is measured against the estimate, not the budget: a package bought
    // at budget has spent the contingency for it.
    assert.equal(
      converted.buyoutTargets.reduce((total, t) => total + t.targetMinor, 0),
      Number(budget.state.directTotalMinor),
    );
    assert.equal(converted.budgetTotalMinor, Number(budget.state.directTotalMinor) + 750_000_00);

    const row = award.awardPosition(asQS()).packs.find((p) => p.packId === packId)!;
    assert.equal(row.converted, true);
  });
});

// ── The loss ───────────────────────────────────────────────────────────────

/**
 * A second tenancy, because a pack carries one outcome and the loss is a
 * different one. Seeded rather than hand-built: the point is that the real
 * pack the platform compiles behaves this way, not that a fixture does.
 */
describe('award · a lost bid is not a dead end', () => {
  let lostPlatform: Platform;
  let lostSeed: SeedResult;
  let packId: string;

  before(async () => {
    lostPlatform = new Platform();
    lostSeed = await seedDemoProject(lostPlatform);
    packId = lostPlatform.ledger.list(lostSeed.projectId, 'BidSubmissionPack')[0]!.refId;
    structure.transitionPhase(
      lostPlatform.context(lostSeed.users.owner!.auth, lostSeed.projectId, { source: 'WEB' }),
      { to: 'CONSTRUCTION', justification: 'Reopened to record the standstill notice against the bid pack' },
    );
  });

  const qs = () => lostPlatform.context(lostSeed.users.qs!.auth, lostSeed.projectId, { source: 'WEB' });
  const pm = () => lostPlatform.context(lostSeed.users.pm!.auth, lostSeed.projectId, { source: 'WEB' });
  const owner = () => lostPlatform.context(lostSeed.users.owner!.auth, lostSeed.projectId, { source: 'WEB' });

  it('keeps who won and at what, and refuses to convert it', () => {
    award.recordSubmission(qs(), packId, receipt());
    award.recordAward(pm(), packId, {
      outcome: 'LOST',
      reference: 'STANDSTILL-14',
      receivedOn: '2027-04-02',
      winner: { name: 'Corbridge Construction', sumMinor: 17_900_000_00 },
      notes: 'Second on price, first on quality. Four bidders.',
    });

    const error = throwsCode(
      () =>
        award.convertAward(owner(), packId, {
          budgetVersion: 'v1',
          contingencyMinor: 0,
          managementReserveMinor: 0,
          tenderMarginPercent: 6,
        }),
      'NOT_WON',
    );
    assert.match(String(error.message), /market data on a loss stays searchable/);

    // And it does. The only thing that pays for a losing bid is what it taught.
    const stored = lostPlatform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!;
    const recorded = stored.state.award as { winner?: { name?: string; sumMinor?: number }; notes?: string };
    assert.equal(recorded.winner?.name, 'Corbridge Construction');
    assert.equal(recorded.winner?.sumMinor, 17_900_000_00);
    assert.match(String(recorded.notes), /Four bidders/);

    const position = award.awardPosition(qs());
    assert.match(position.summary, /0 won, 1 lost/);
  });

  it('computes no departures for a loss, because there is nothing to compare', () => {
    const row = award.awardPosition(qs()).packs.find((p) => p.packId === packId)!;
    assert.deepEqual(row.departures, []);
    assert.equal(row.outcome, 'LOST');
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('award · the event catalogue', () => {
  it('registers the four events the specification names', () => {
    for (const code of ['TENDER_SUBMITTED', 'AWARD_RECEIVED', 'AWARD_DEPARTURE_IDENTIFIED', 'BID_CONVERTED_TO_CONTRACT']) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      // No autonomous signature, submission, acceptance or execution.
      assert.equal(definition!.aiAllowed, false, `${code} may be authored by an agent`);
    }

    // TENDER_SUBMISSION_LOCKED in the specification is BID_PACK_LOCKED here,
    // already written to an append-only ledger under that name and not renamed.
    assert.ok(lookupEventType('BID_PACK_LOCKED'));
    assert.equal(lookupEventType('TENDER_SUBMISSION_LOCKED'), undefined);

    // The receipt and the conversion both carry evidence: one proves arrival,
    // the other is the join the whole no-re-entry rule stands on.
    assert.equal(lookupEventType('TENDER_SUBMITTED')!.requiresEvidence, true);
    assert.equal(lookupEventType('BID_CONVERTED_TO_CONTRACT')!.requiresEvidence, true);
  });
});
