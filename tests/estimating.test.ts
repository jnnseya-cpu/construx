import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import {
  COST_HEADS,
  costHead,
  priceEstimate,
  reprice,
  type CostModelInput,
  type MeasuredLine,
} from '../src/engines/maths/costModel.ts';
import { cashflowScoreFor, modelFunding } from '../src/engines/maths/funding.ts';
import { scoreRisk } from '../src/engines/maths/risk.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The tender estimate, across all twenty cost heads.
 *
 * Listing twenty headings is not the hard part. What these tests pin is the
 * basis each head is priced on, because that is where the money goes:
 *
 *   - Time-related costs re-price when the programme moves. Priced as a
 *     percentage of works they do not, and eight weeks of overrun is eight
 *     weeks of unrecovered site staff.
 *   - Contingency comes from the risk register at P80, not from a round number.
 *   - Inflation lands on the spend exposed to it and nothing else. A firm-price
 *     subcontract sum indexed for inflation is an invented cost.
 *   - A head with nothing against it is an omission, never a zero.
 *
 * And the division of labour in the automatic response: the model writes the
 * words, the cost model produces every number, and whether a bid is fit to
 * submit is computed rather than asked.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // The seeded project has been delivered and sits in OPERATIONS, where the
  // phase gate rightly refuses a tender write. Estimating happens earlier, so
  // the project is regressed through the governed transition rather than by
  // weakening the gate — the point of the gate is that there is no way round it.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Retender of the remaining scope following the phase 2 scope change',
  });
});

const qsCtx = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

/**
 * A line big enough to make `complete()` a MEDIUM project, because the
 * twenty-head build-up is a medium-and-above concept. Which heads are expected
 * at which size is covered separately, below.
 */
const line = (over: Partial<MeasuredLine> = {}): MeasuredLine => ({
  description: 'Bulk excavation',
  unit: 'm3',
  quantity: 10_000,
  labourRateMinor: 2_000,
  materialRateMinor: 1_000,
  plantRateMinor: 500,
  ...over,
});

/** A model with every head priced, so tests can knock one out at a time. */
const complete = (over: Partial<CostModelInput> = {}): CostModelInput => ({
  durationWeeks: 40,
  lines: [line(), line({ description: 'Pipework', subcontractRateMinor: 4_000 })],
  timeRelated: [
    { head: 'SITE_MANAGEMENT', description: 'Site manager', weeklyRateMinor: 190_000, quantity: 1 },
    { head: 'PRELIMINARIES', description: 'Welfare', weeklyRateMinor: 100_000, quantity: 1 },
    { head: 'LOGISTICS', description: 'Gateman', weeklyRateMinor: 90_000, quantity: 1 },
    { head: 'HEALTH_AND_SAFETY', description: 'Safety adviser', weeklyRateMinor: 80_000, quantity: 1 },
    { head: 'QUALITY', description: 'Quality engineer', weeklyRateMinor: 85_000, quantity: 1 },
  ],
  quantified: [
    { head: 'TEMPORARY_WORKS', description: 'Propping', unit: 'week', quantity: 12, rateMinor: 150_000 },
    { head: 'TESTING', description: 'Cubes', unit: 'set', quantity: 100, rateMinor: 5_000 },
    { head: 'COMMISSIONING', description: 'Witnessing', unit: 'day', quantity: 8, rateMinor: 200_000 },
    { head: 'WASTE', description: 'Skips', unit: 'no', quantity: 40, rateMinor: 30_000 },
  ],
  fees: [
    { head: 'DESIGN', description: 'CDP', percentOfWorks: 1.5 },
    { head: 'PROFESSIONAL_FEES', description: 'Surveys', lumpSumMinor: 800_000 },
  ],
  insurance: { policies: [{ type: 'Contract works', percentOfContractValue: 0.6 }] },
  risks: [
    scoreRisk(
      {
        id: 'R1',
        title: 'Ground conditions',
        category: 'GROUND_CONDITIONS',
        probability: 0.3,
        costImpact: { optimistic: 100_000, mostLikely: 500_000, pessimistic: 2_000_000 },
        scheduleImpactDays: { optimistic: 2, mostLikely: 10, pessimistic: 30 },
      },
      100_000_000,
      280,
    ),
  ],
  inflation: { baseDate: '2026-01-01', annualRate: 0.04, startOnSite: '2026-07-01' },
  margin: { overheadPercent: 6, profitPercent: 8 },
  ...over,
});

const amountOf = (priced: ReturnType<typeof priceEstimate>, head: string): number =>
  priced.heads.find((h) => h.head === head)!.amountMinor;

// ── The catalogue ───────────────────────────────────────────────────────────

describe('Tender cost heads', () => {
  it('carries all twenty heads, each with a stated basis', () => {
    assert.equal(COST_HEADS.length, 20);
    assert.equal(new Set(COST_HEADS.map((h) => h.head)).size, 20, 'a head appears twice');

    const expected = [
      'DIRECT_WORKS', 'SUBCONTRACT', 'MATERIALS', 'PLANT', 'PRELIMINARIES', 'SITE_MANAGEMENT',
      'TEMPORARY_WORKS', 'INSURANCE', 'DESIGN', 'PROFESSIONAL_FEES', 'TESTING', 'COMMISSIONING',
      'WASTE', 'LOGISTICS', 'HEALTH_AND_SAFETY', 'QUALITY', 'RISK', 'INFLATION', 'OVERHEAD', 'PROFIT',
    ];
    assert.deepEqual(COST_HEADS.map((h) => h.head), expected);

    for (const head of COST_HEADS) {
      assert.ok(head.label.length > 0 && head.note.length > 0, `${head.head} has no label or note`);
    }
  });

  it('prices site staff and welfare by the week, not as a share of the works', () => {
    const timeRelated = COST_HEADS.filter((h) => h.basis === 'TIME_RELATED').map((h) => h.head);
    assert.deepEqual(timeRelated, ['PRELIMINARIES', 'SITE_MANAGEMENT', 'LOGISTICS', 'HEALTH_AND_SAFETY', 'QUALITY']);
  });

  it('does not index firm-price subcontract sums for inflation', () => {
    assert.equal(costHead('SUBCONTRACT')!.inflationExposed, false);
    assert.equal(costHead('MATERIALS')!.inflationExposed, true);
  });
});

// ── The basis each head is priced on ────────────────────────────────────────

describe('Pricing basis', () => {
  it('multiplies quantity by rate, and adds waste to materials only', () => {
    const priced = priceEstimate(
      complete({
        lines: [line({ quantity: 100, labourRateMinor: 1_000, materialRateMinor: 1_000, plantRateMinor: 1_000, materialWastePercent: 10 })],
      }),
    );

    assert.equal(amountOf(priced, 'DIRECT_WORKS'), 100_000);
    assert.equal(amountOf(priced, 'PLANT'), 100_000);
    assert.equal(amountOf(priced, 'MATERIALS'), 110_000, 'the 10% waste allowance was not applied');
  });

  it('re-prices the time-related heads when the programme moves', () => {
    const model = complete();
    const at40 = priceEstimate(model);
    const at52 = reprice(model, 52);

    // 5 weekly resources across 12 extra weeks.
    const weekly = 190_000 + 100_000 + 90_000 + 80_000 + 85_000;
    const siteDelta = at52.subtotals.siteOverheadMinor - at40.subtotals.siteOverheadMinor;
    assert.equal(siteDelta, weekly * 12);

    assert.ok(at52.tenderTotalMinor > at40.tenderTotalMinor);
    // The measured works did not change; only the time did.
    assert.equal(at52.subtotals.netMeasuredMinor, at40.subtotals.netMeasuredMinor);
  });

  it('holds a resource with its own duration to that duration when the job stretches', () => {
    const model = complete({
      timeRelated: [
        { head: 'SITE_MANAGEMENT', description: 'Full duration', weeklyRateMinor: 100_000, quantity: 1 },
        { head: 'LOGISTICS', description: 'Crane, 10 weeks only', weeklyRateMinor: 300_000, quantity: 1, weeks: 10 },
      ],
    });

    const at40 = priceEstimate(model);
    const at60 = reprice(model, 60);

    assert.equal(amountOf(at40, 'LOGISTICS'), 3_000_000);
    assert.equal(amountOf(at60, 'LOGISTICS'), 3_000_000, 'a fixed-duration hire should not stretch with the job');
    assert.equal(amountOf(at60, 'SITE_MANAGEMENT'), 6_000_000);
  });

  it('reports the prelims percentage as an output and never accepts one as input', () => {
    const priced = priceEstimate(complete());

    assert.ok(priced.benchmarks.prelimsPercentOfWorks > 0);
    // The input type has no percentage field for time-related cost. If this
    // ever gains one, the whole model has quietly regressed.
    assert.ok(!('prelimsPercent' in complete()));
  });

  it('warns when a resource is priced for longer than the programme', () => {
    const priced = priceEstimate(
      complete({
        durationWeeks: 20,
        timeRelated: [{ head: 'SITE_MANAGEMENT', description: 'Site manager', weeklyRateMinor: 100_000, quantity: 1, weeks: 30 }],
      }),
    );
    assert.ok(priced.warnings.some((w) => w.includes('30 weeks against a 20-week programme')));
  });

  it('refuses to price anything without a programme', () => {
    assert.throws(() => priceEstimate(complete({ durationWeeks: 0 })), /DURATION_REQUIRED/);
  });
});

// ── Contingency, inflation, insurance and margin ────────────────────────────

describe('Risk, inflation, insurance and margin', () => {
  it('draws contingency from the register at P80 rather than expected value', () => {
    const model = complete();
    const p80 = priceEstimate(model);
    const expected = priceEstimate({ ...model, contingencyBasis: 'EXPECTED' });

    assert.ok(p80.subtotals.riskMinor > expected.subtotals.riskMinor, 'P80 must sit above expected value');
    assert.match(p80.heads.find((h) => h.head === 'RISK')!.derivation, /1 quantified risk at P80/);
  });

  it('carries no contingency without a register, and says so', () => {
    const priced = priceEstimate(complete({ risks: [], exclusions: [{ head: 'RISK', reason: 'No register' }] }));
    assert.equal(priced.subtotals.riskMinor, 0);
    assert.ok(priced.warnings.some((w) => w.includes('no contingency has been carried')));
  });

  it('applies inflation to exposed spend only, leaving firm-price sums alone', () => {
    const base = complete({
      lines: [line({ quantity: 1_000, labourRateMinor: 0, materialRateMinor: 0, plantRateMinor: 0, subcontractRateMinor: 10_000 })],
    });

    const floating = priceEstimate(base);
    const fixed = priceEstimate({
      ...base,
      lines: [line({ quantity: 1_000, labourRateMinor: 0, materialRateMinor: 0, plantRateMinor: 0, subcontractRateMinor: 10_000, subcontractFixedPrice: true })],
    });

    assert.ok(floating.subtotals.inflationMinor > fixed.subtotals.inflationMinor);
    assert.match(fixed.heads.find((h) => h.head === 'INFLATION')!.derivation, /firm-price subcontract sums excluded/);
  });

  it('takes inflation to the mid-point of spend, not to the start', () => {
    const model = complete({ durationWeeks: 52, inflation: { baseDate: '2026-01-01', annualRate: 0.1, startOnSite: '2026-01-01' } });
    const priced = priceEstimate(model);

    // Half of a 52-week job past the base date, so roughly half a year of a
    // 10% rate on the exposed spend.
    const exposed = priced.subtotals.netMeasuredMinor + priced.subtotals.siteOverheadMinor;
    const ratio = priced.subtotals.inflationMinor / exposed;
    assert.ok(ratio > 0.045 && ratio < 0.05, `expected roughly 4.9%, got ${(ratio * 100).toFixed(2)}%`);
  });

  it('notices a start on site that precedes the base date', () => {
    const priced = priceEstimate(
      complete({ inflation: { baseDate: '2026-06-01', annualRate: 0.04, startOnSite: '2026-01-01' } }),
    );
    assert.ok(priced.warnings.some((w) => w.includes('precedes the base date')));
  });

  it('warns about a long programme priced with no inflation at all', () => {
    const priced = priceEstimate(complete({ durationWeeks: 80, inflation: undefined }));
    assert.ok(priced.warnings.some((w) => w.includes('fixed price on future costs')));
  });

  it('insures the value it actually insures, including risk and inflation', () => {
    const priced = priceEstimate(complete({ insurance: { policies: [{ type: 'Contract works', percentOfContractValue: 1 }] } }));

    const insurable = priced.subtotals.netCostMinor + priced.subtotals.inflationMinor + priced.subtotals.riskMinor;
    assert.equal(priced.subtotals.insuranceMinor, Math.round(insurable * 0.01));
  });

  it('takes overhead on cost and profit on cost plus overhead, in that order', () => {
    const priced = priceEstimate(complete());
    const { totalCostMinor, overheadMinor, profitMinor } = priced.subtotals;

    assert.equal(overheadMinor, Math.round(totalCostMinor * 0.06));
    assert.equal(profitMinor, Math.round((totalCostMinor + overheadMinor) * 0.08));
    assert.equal(priced.tenderTotalMinor, totalCostMinor + overheadMinor + profitMinor);

    // Margin is profit over the tender total — always less than the applied
    // percentage, which is the number people get wrong in both directions.
    assert.ok(priced.marginPercent < 8 && priced.marginPercent > 6);
  });

  it('says so when the build-up carries no profit', () => {
    const priced = priceEstimate(complete({ margin: { overheadPercent: 6, profitPercent: 0 } }));
    assert.ok(priced.warnings.some((w) => w.includes('Profit is zero')));
  });
});

// ── The honesty rule ────────────────────────────────────────────────────────

describe('A head is priced or excluded, never silently zero', () => {
  it('reports an unpriced head as an omission rather than as nothing to pay', () => {
    const priced = priceEstimate(complete({ quantified: [] }));

    assert.ok(priced.omissions.includes('WASTE'));
    assert.ok(priced.omissions.includes('TESTING'));
    assert.equal(priced.heads.find((h) => h.head === 'WASTE')!.status, 'UNPRICED');
    assert.ok(priced.warnings.some((w) => w.includes('neither priced nor excluded')));
  });

  it('turns a deliberate exclusion into wording for the tender', () => {
    const priced = priceEstimate(
      complete({
        quantified: [
          { head: 'TEMPORARY_WORKS', description: 'Propping', unit: 'week', quantity: 12, rateMinor: 150_000 },
          { head: 'TESTING', description: 'Cubes', unit: 'set', quantity: 100, rateMinor: 5_000 },
          { head: 'COMMISSIONING', description: 'Witnessing', unit: 'day', quantity: 8, rateMinor: 200_000 },
        ],
        exclusions: [{ head: 'WASTE', reason: 'Waste removal is by others per the employer’s requirements clause 4.7' }],
      }),
    );

    assert.ok(!priced.omissions.includes('WASTE'));
    const waste = priced.heads.find((h) => h.head === 'WASTE')!;
    assert.equal(waste.status, 'EXCLUDED');
    assert.equal(waste.amountMinor, 0);
    assert.match(priced.exclusions.find((e) => e.head === 'WASTE')!.reason, /by others/);
  });

  it('flags a head that is both priced and excluded', () => {
    const priced = priceEstimate(complete({ exclusions: [{ head: 'WASTE', reason: 'By others' }] }));
    assert.ok(priced.warnings.some((w) => w.includes('both priced and excluded')));
  });

  it('gives every priced head a derivation somebody can check', () => {
    const priced = priceEstimate(complete());
    for (const head of priced.heads.filter((h) => h.status === 'PRICED')) {
      assert.ok(head.derivation.length > 0, `${head.label} carries no derivation`);
    }
  });
});

// ── The engine, on the ledger ───────────────────────────────────────────────

describe('Estimating through the engine', () => {
  it('commits the twenty heads and the inputs that produced them', () => {
    const ctx = qsCtx();
    const built = tender.buildEstimate(ctx, {
      packageId: 'PKG-TEST',
      ...complete(),
      basisOfEstimate: 'Test rates',
      assumptions: ['Access from commencement'],
    });

    const record = ctx.ledger.require({ refType: 'Estimate', refId: built.estimateId });
    assert.equal((record.state.heads as unknown[]).length, 20);
    assert.equal(record.state.status, 'DRAFT');
    assert.ok(record.state.model, 'the inputs were not kept, so the estimate cannot be recomputed');
    assert.equal(record.state.totalMinor, built.totalMinor);
    assert.equal(built.breakdown.profitMinor, built.priced.subtotals.profitMinor);
  });

  it('marks an estimate with unpriced heads incomplete rather than draft', () => {
    const ctx = qsCtx();
    const built = tender.buildEstimate(ctx, {
      packageId: 'PKG-GAPPY',
      ...complete({ quantified: [] }),
      basisOfEstimate: 'Test rates',
      assumptions: [],
    });

    assert.equal(ctx.ledger.require({ refType: 'Estimate', refId: built.estimateId }).state.status, 'INCOMPLETE');
  });

  it('refuses an estimate with nothing measured', () => {
    throwsCode(
      () => tender.buildEstimate(qsCtx(), { packageId: 'PKG-EMPTY', ...complete({ lines: [] }), basisOfEstimate: 'x', assumptions: [] }),
      'ESTIMATE_EMPTY',
    );
  });

  it('answers what the tender becomes on a longer programme', () => {
    const ctx = qsCtx();
    const built = tender.buildEstimate(ctx, {
      packageId: 'PKG-REPRICE',
      ...complete(),
      basisOfEstimate: 'Test rates',
      assumptions: [],
    });

    const repriced = tender.repriceEstimate(ctx, built.estimateId, 52);

    assert.equal(repriced.originalWeeks, 40);
    assert.equal(repriced.durationWeeks, 52);
    assert.ok(repriced.deltaMinor > 0, 'twelve more weeks of site staff must cost something');
    assert.equal(repriced.originalTotalMinor, built.totalMinor);

    // A what-if is not a commercial position: nothing was written.
    assert.equal(ctx.ledger.require({ refType: 'Estimate', refId: built.estimateId }).state.totalMinor, built.totalMinor);

    throwsCode(() => tender.repriceEstimate(ctx, built.estimateId, 0), 'DURATION_INVALID');
  });
});

// ── The automatic tender response ───────────────────────────────────────────

describe('Automatic tender response', () => {
  const enquiry = (over: Partial<tender.TenderEnquiry> = {}): tender.TenderEnquiry => ({
    clientReference: 'ITT-2026-0114',
    clientName: 'Northern Water Authority',
    projectTitle: 'Clarifier replacement, phase 2',
    contractForm: 'NEC4 ECC Option B',
    returnBy: '2026-05-29',
    scopeNarrative:
      'Design, supply and install replacement clarifier structures including all associated civils, temporary works and process pipework connections, to the issued drawings and specification.',
    documents: [{ name: 'C-1001', revision: 'P03' }, { name: 'Specification', revision: 'C01' }],
    employerRequirements: ['Site to remain operational throughout', 'No works within 6m of the live inlet channel'],
    contractorDesignedPortions: ['Temporary works', 'Pipework supports'],
    ...over,
  });

  it('prices the enquiry and drafts the response against a committed number', async () => {
    const ctx = qsCtx();
    const response = await tender.respondToTender(ctx, {
      enquiry: enquiry(),
      estimate: { packageId: 'PKG-ITT', ...complete(), basisOfEstimate: 'Rate library Q1 2026', assumptions: ['Access from commencement'] },
    });

    const estimate = ctx.ledger.require({ refType: 'Estimate', refId: response.estimateId });
    assert.equal(response.tenderTotalMinor, estimate.state.totalMinor, 'the response quoted a different number to the estimate');
    assert.ok(response.readyToSubmit, `blocked unexpectedly: ${response.blockers.join('; ')}`);
    assert.equal(response.blockers.length, 0);
    assert.ok(response.acuConsumed > 0, 'the response was drafted without any AI spend recorded');

    const drafted = ctx.ledger.require({ refType: 'TenderResponse', refId: response.responseId });
    assert.equal(drafted.state.status, 'DRAFTED');
    assert.equal(drafted.state.tenderTotalMinor, response.tenderTotalMinor);
  });

  it('attributes the draft to the AI, not to the surveyor who pressed the button', () => {
    const ctx = qsCtx();
    const events = ctx.ledger
      .events({ projectId: seed.projectId })
      .filter((e) => e.eventType === 'TENDER_RESPONSE_DRAFTED');

    assert.ok(events.length > 0);
    for (const event of events) {
      assert.equal(event.actor.refType, 'AI', 'liability follows attribution');
      assert.equal(event.source, 'AI');
    }
  });

  it('refuses to call a bid submittable while a cost head is unpriced', async () => {
    const response = await tender.respondToTender(qsCtx(), {
      enquiry: enquiry(),
      estimate: {
        packageId: 'PKG-ITT-GAPPY',
        ...complete({ quantified: [] }),
        basisOfEstimate: 'Rate library Q1 2026',
        assumptions: [],
      },
    });

    assert.equal(response.readyToSubmit, false);
    assert.ok(response.blockers.some((b) => b.includes('neither priced nor excluded')));
    assert.ok(response.blockers.some((b) => b.includes('Waste')));
  });

  it('turns a gap in the enquiry into a tender query rather than an assumption', async () => {
    const response = await tender.respondToTender(qsCtx(), {
      enquiry: enquiry({ documents: [{ name: 'C-1001' }], employerRequirements: [] }),
      estimate: { packageId: 'PKG-ITT-THIN', ...complete(), basisOfEstimate: 'Rates', assumptions: [] },
    });

    assert.equal(response.readyToSubmit, false);
    assert.ok(response.blockers.some((b) => b.includes('The enquiry is incomplete')));
    assert.ok(response.tenderQueries.some((q) => q.includes('Document revisions')));
    assert.ok(response.tenderQueries.some((q) => q.includes("Employer's requirements")));
  });

  it('blocks a bid carrying no profit however well it is written', async () => {
    const response = await tender.respondToTender(qsCtx(), {
      enquiry: enquiry(),
      estimate: {
        packageId: 'PKG-ITT-FLAT',
        ...complete({ margin: { overheadPercent: 6, profitPercent: 0 } }),
        basisOfEstimate: 'Rates',
        assumptions: [],
      },
    });

    assert.equal(response.readyToSubmit, false);
    assert.ok(response.blockers.some((b) => b.includes('no profit')));
  });

  it('will not let a regulator without AI enabled run the response', async () => {
    const regulator = seed.users.regulator;
    if (!regulator) return;
    const ctx = platform.context(regulator.auth, seed.projectId, { source: 'WEB' });
    await rejectsCode(
      () =>
        tender.respondToTender(ctx, {
          enquiry: enquiry(),
          estimate: { packageId: 'PKG-ITT-REG', ...complete(), basisOfEstimate: 'Rates', assumptions: [] },
        }),
      'ACCESS_DENIED',
    );
  });

  it('keeps the response event in the catalogue, against its own entity', () => {
    const definition = lookupEventType('TENDER_RESPONSE_DRAFTED');
    assert.ok(definition);
    assert.equal(definition.entity, 'TenderResponse');
    assert.equal(definition.aiAllowed, true, 'the drafting is the part the model does');
  });
});

// ── Cash flow and peak funding ──────────────────────────────────────────────

/**
 * Never bid without a cash model.
 *
 * A contract can cover its cost, carry a healthy margin, and still take more
 * working capital than the business has. The estimate is a statement about
 * cost; this is a statement about cash, and they answer different questions.
 * These tests pin the three timing effects that make the difference — labour
 * paid weekly whatever the client does, retention held then released in halves,
 * and VAT flowing in the direction it actually flows.
 */
describe('Peak funding requirement', () => {
  const terms = {
    payment: {
      applicationIntervalDays: 30,
      certificationDays: 14,
      paymentDays: 28,
      retentionPercent: 5,
      retentionReleasedAtCompletionPercent: 50,
      defectsLiabilityWeeks: 52,
    },
    supply: {
      subcontractorPaymentDays: 30,
      materialSupplierPaymentDays: 30,
      materialsDepositPercent: 25,
      materialsDepositLeadWeeks: 4,
      plantPaymentDays: 30,
    },
    vat: { ratePercent: 20, reverseCharge: true, returnIntervalWeeks: 13, settlementLagWeeks: 5 },
  };

  /** A job that is comfortably profitable on paper. */
  const job = (over: Partial<Parameters<typeof modelFunding>[0]> = {}) =>
    modelFunding({
      contractValueMinor: 500_000_00,
      durationWeeks: 26,
      cost: {
        labourMinor: 130_000_00,
        materialsMinor: 110_000_00,
        subcontractMinor: 140_000_00,
        plantAndPrelimsMinor: 42_000_00,
        mobilisationMinor: 12_000_00,
        weeklyOverheadMinor: 230_00,
      },
      ...terms,
      ...over,
    });

  it('refuses to model a job with no programme', () => {
    assert.throws(() => job({ durationWeeks: 0 }), /DURATION_REQUIRED/);
  });

  it('finds a funding requirement a healthy margin completely hides', () => {
    const model = job();

    // Twelve per cent margin. The estimate would call this a good job.
    assert.ok(model.marginPercent > 10);
    // And it needs multiples of that margin in cash before it earns any of it.
    assert.ok(model.peakFundingRequirementMinor > model.marginMinor);
    assert.ok(model.returnOnPeakFunding < 1, 'the business puts in more than it takes out, for months');
    assert.ok(model.peakWeek > 0 && model.peakWeek < 26, 'the peak falls during the build, not at the end');
    assert.ok(model.warnings.some((w) => w.includes('more than the whole margin')));
  });

  it('gives the verdict against working capital, not against a feeling', () => {
    const peak = job().peakFundingRequirementMinor;

    assert.equal(job({ availableWorkingCapitalMinor: Math.round(peak * 0.5) }).verdict, 'UNFUNDABLE');
    // Using more than 80% of the business's cash is a bet, not a plan.
    assert.equal(job({ availableWorkingCapitalMinor: Math.round(peak * 1.05) }).verdict, 'TIGHT');
    assert.equal(job({ availableWorkingCapitalMinor: Math.round(peak * 3) }).verdict, 'FUNDABLE');
    // Without knowing the working capital it declines to guess.
    assert.equal(job().verdict, 'UNKNOWN');
    assert.equal(job().headroomMinor, undefined);
  });

  it('prices what would fix it rather than only refusing', () => {
    const model = job({ availableWorkingCapitalMinor: 25_000_00 });

    assert.equal(model.verdict, 'UNFUNDABLE');
    assert.ok(model.remedies.length > 0, 'refusing without saying what would change is half an answer');

    // Best first, and every one has to actually help.
    for (const remedy of model.remedies) {
      assert.ok(remedy.improvementMinor > 0, `${remedy.change} was offered without improving anything`);
      assert.equal(remedy.peakWouldBecomeMinor, model.peakFundingRequirementMinor - remedy.improvementMinor);
    }
    const improvements = model.remedies.map((r) => r.improvementMinor);
    assert.deepEqual(improvements, [...improvements].sort((a, b) => b - a));

    // An advance payment is the thing most worth negotiating, and it shows.
    assert.ok(model.remedies.some((r) => r.change.includes('advance payment')));
  });

  it('offers no remedies to a job that does not need them', () => {
    assert.deepEqual(job({ availableWorkingCapitalMinor: 5_000_000_00 }).remedies, []);
  });

  it('holds retention and gives it back in two halves, long after the work', () => {
    const model = job();

    assert.ok(model.retentionHeldMinor > 0);
    // The second half lands after the defects period, not at completion.
    assert.ok(model.finalRetentionWeek > 26 + 52, 'the tail of retention was not carried');

    const released = model.periods.reduce((sum, p) => sum + p.cashInMinor, 0);
    const contract = 500_000_00;
    // Everything comes back eventually — retention is cash withheld, not a
    // discount, and a model that treated it as a deduction would understate
    // the requirement and overstate the final position.
    assert.ok(Math.abs(released - contract) < contract * 0.01, `expected the whole contract to be received, got ${released}`);
  });

  it('shows the reverse charge for what it is: working capital that no longer exists', () => {
    const charged = job({ vat: { ...terms.vat, reverseCharge: false } });
    const reversed = job();

    // With VAT on the sale the contractor holds the client's VAT until the
    // quarter falls due, and that float funds the job. Under the reverse charge
    // it is simply not there.
    assert.ok(
      reversed.peakFundingRequirementMinor > charged.peakFundingRequirementMinor,
      'the reverse charge should make the funding requirement worse, not better',
    );
    assert.ok(reversed.warnings.some((w) => w.includes('no VAT on the sale')));
  });

  it('notices when the contractor is funding its own supply chain', () => {
    const model = job({ supply: { ...terms.supply, subcontractorPaymentDays: 14 } });
    assert.ok(model.warnings.some((w) => w.includes('paid faster than the client pays')));
  });

  it('improves when the client pays sooner, and worsens when they pay later', () => {
    const fast = job({ payment: { ...terms.payment, paymentDays: 14 } });
    const slow = job({ payment: { ...terms.payment, paymentDays: 60 } });

    assert.ok(fast.peakFundingRequirementMinor < slow.peakFundingRequirementMinor);
    assert.ok(slow.weeksNegative >= fast.weeksNegative);
  });

  it('maps a funding requirement onto the bid/no-bid cash-flow score', () => {
    // The same 1–5 scale the algorithm uses, so the evidence reaches the
    // decision rather than sitting in a separate report.
    assert.equal(cashflowScoreFor(10_000_00, 100_000_00), 5);
    assert.equal(cashflowScoreFor(50_000_00, 100_000_00), 3);
    assert.equal(cashflowScoreFor(120_000_00, 100_000_00), 1);
    assert.equal(cashflowScoreFor(10_000_00, 0), 1, 'no working capital is the worst case, not a divide by zero');
  });
});

describe('Funding modelled from the estimate itself', () => {
  const terms = {
    payment: {
      applicationIntervalDays: 30,
      certificationDays: 14,
      paymentDays: 28,
      retentionPercent: 5,
      retentionReleasedAtCompletionPercent: 50,
      defectsLiabilityWeeks: 52,
    },
    supply: {
      subcontractorPaymentDays: 30,
      materialSupplierPaymentDays: 30,
      materialsDepositPercent: 25,
      materialsDepositLeadWeeks: 4,
      plantPaymentDays: 30,
    },
    vat: { ratePercent: 20, reverseCharge: true, returnIntervalWeeks: 13, settlementLagWeeks: 5 },
  };

  it('reads the cost profile from the priced estimate rather than asking again', () => {
    const ctx = qsCtx();
    const built = tender.buildEstimate(ctx, {
      packageId: 'PKG-FUND',
      ...complete(),
      basisOfEstimate: 'Rates',
      assumptions: [],
    });

    const funding = tender.modelTenderFunding(ctx, built.estimateId, {
      ...terms,
      mobilisationMinor: 8_000_00,
      availableWorkingCapitalMinor: 50_000_00,
    });

    // The cash model prices the same job the estimate priced. If these could
    // drift, one of them would be describing a different contract.
    const record = ctx.ledger.require({ refType: 'FundingModel', refId: funding.fundingId });
    assert.equal(record.state.contractValueMinor, built.totalMinor);
    assert.equal(record.state.estimateId, built.estimateId);
    assert.equal(record.state.durationWeeks, 40);

    assert.ok(funding.peakFundingRequirementMinor > 0);
    assert.ok(funding.suggestedCashflowScore! >= 1 && funding.suggestedCashflowScore! <= 5);

    // The weekly working is kept, because "we refused it on cash" needs to be
    // answerable years later.
    assert.ok(Array.isArray(record.state.periods) && (record.state.periods as unknown[]).length > 40);
  });

  it('suggests no cash-flow score when nobody said what the business can fund', () => {
    const ctx = qsCtx();
    const built = tender.buildEstimate(ctx, { packageId: 'PKG-FUND-2', ...complete(), basisOfEstimate: 'Rates', assumptions: [] });
    const funding = tender.modelTenderFunding(ctx, built.estimateId, terms);

    assert.equal(funding.verdict, 'UNKNOWN');
    assert.equal(funding.suggestedCashflowScore, undefined);
  });

  it('refuses to model an estimate that carries no programme', () => {
    const ctx = qsCtx();
    const built = tender.buildEstimate(ctx, { packageId: 'PKG-FUND-3', ...complete(), basisOfEstimate: 'Rates', assumptions: [] });
    // Strip the programme the way a legacy record would lack one.
    const record = ctx.ledger.require({ refType: 'Estimate', refId: built.estimateId });
    const original = record.state.durationWeeks;
    delete (record.state as Record<string, unknown>).durationWeeks;

    throwsCode(() => tender.modelTenderFunding(ctx, built.estimateId, terms), 'ESTIMATE_NOT_TIME_BASED');
    (record.state as Record<string, unknown>).durationWeeks = original;
  });

  it('keeps the funding event in the catalogue and off the AI', () => {
    const definition = lookupEventType('TENDER_FUNDING_MODELLED');
    assert.ok(definition);
    assert.equal(definition.entity, 'FundingModel');
    assert.equal(definition.aiAllowed, false, 'whether the business can fund a job is not a model’s call');
  });
});
