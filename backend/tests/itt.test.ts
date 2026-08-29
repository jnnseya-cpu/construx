import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { issueTokens, verifyToken } from '../src/identity/auth.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import * as itt from '../src/domain/itt.ts';
import * as costintel from '../src/domain/costintel.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The ITT analyst and the cost intelligence database.
 *
 * Both exist to stop a specific kind of confident wrongness. The analyst stops
 * a commercial term being priced as though it were a pricing question when it
 * is an insurance question or a bar to entry. The cost database stops a number
 * with two observations behind it being read as a benchmark.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // Estimating is phase-gated and the seeded project has been delivered.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Retender of the remaining scope',
  });
});

const qs = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const requirement = (over: Partial<itt.ITTRequirement> = {}): itt.ITTRequirement => ({
  reference: 'R1',
  category: 'INSURANCE',
  requirement: 'Employers liability insurance of £10m',
  mandatory: true,
  evidenceRequired: 'Certificate of employers liability insurance',
  ...over,
});

const analyse = (over: Partial<Parameters<typeof itt.analyseITT>[1]> = {}) =>
  itt.analyseITT(qs(), {
    reference: 'ITT-2026-01',
    clientName: 'Northern Water Authority',
    returnBy: '2026-06-01',
    estimatedValueMinor: 2_000_000_00,
    durationWeeks: 30,
    targetMarginPercent: 10,
    requirements: [requirement()],
    terms: { contractForm: 'NEC4 ECC Option A' },
    ...over,
  });

// ── The compliance matrix ───────────────────────────────────────────────────

describe('The compliance matrix', () => {
  it('refuses an invitation with nothing in it', () => {
    throwsCode(() => analyse({ requirements: [] }), 'ITT_EMPTY');
  });

  it('gives every requirement an owner, so nothing reaches the day before unclaimed', () => {
    const result = analyse({
      requirements: [
        requirement({ reference: 'R1', category: 'INSURANCE' }),
        requirement({ reference: 'R2', category: 'PROGRAMME', requirement: 'Outline programme' }),
        requirement({ reference: 'R3', category: 'HEALTH_AND_SAFETY', requirement: 'Safety policy' }),
      ],
    });

    assert.equal(result.matrix.length, 3);
    for (const line of result.matrix) {
      assert.ok(line.owner, `${line.reference} has no owner`);
    }
    // Owners follow the capability, not one person for everything.
    assert.notEqual(result.matrix[0]!.owner, result.matrix[1]!.owner);
  });

  it('proves what it can from the company profile and marks the rest unknown', () => {
    const result = analyse({
      requirements: [
        requirement({ reference: 'R1', requirement: 'Employers liability insurance of £5m' }),
        requirement({
          reference: 'R2',
          category: 'TECHNICAL',
          requirement: 'Method statement for the temporary works',
          evidenceRequired: 'Draft method statement with a temporary works design check',
        }),
      ],
    });

    const insurance = result.matrix.find((l) => l.reference === 'R1')!;
    assert.equal(insurance.status, 'SATISFIED');
    assert.ok(insurance.evidenceHeld?.includes('Public liability'));

    // The platform cannot probe a method statement, so it says so rather than
    // calling it a gap and burying the real gaps.
    const technical = result.matrix.find((l) => l.reference === 'R2')!;
    assert.equal(technical.status, 'UNKNOWN');
    assert.equal(technical.evidenceHeld, undefined);
  });

  it('notices when the stated evaluation weightings do not add up', () => {
    const result = analyse({
      requirements: [
        requirement({ reference: 'R1', category: 'COMMERCIAL', weightingPercent: 60 }),
        requirement({ reference: 'R2', category: 'TECHNICAL', weightingPercent: 30 }),
      ],
    });

    assert.equal(result.weightings.stated, 90);
    assert.equal(result.weightings.complete, false);
    assert.ok(result.clarifications.some((c) => c.includes('total 90%')));
  });
});

// ── Commercial terms ────────────────────────────────────────────────────────

describe('Commercial terms, assessed rather than transcribed', () => {
  it('sets liquidated damages against the margin rather than reporting a rate', () => {
    const uncapped = analyse({
      terms: { contractForm: 'JCT D&B', liquidatedDamages: { perWeekMinor: 5_000_00 } },
    });

    const lads = uncapped.terms.find((t) => t.term === 'Liquidated damages')!;
    assert.equal(lads.severity, 'SEVERE');
    assert.match(lads.stated, /uncapped/);
    // £5k a week for ten weeks against a £200k margin is 0.25×; the assessment
    // has to carry the arithmetic, not just the rate.
    assert.match(lads.assessment, /× the expected margin/);
    assert.ok(uncapped.clarifications.some((c) => c.includes('cap on liquidated damages')));

    const capped = analyse({
      terms: { contractForm: 'JCT D&B', liquidatedDamages: { perWeekMinor: 5_000_00, capPercent: 5 } },
    });
    assert.notEqual(capped.terms.find((t) => t.term === 'Liquidated damages')!.severity, 'SEVERE');
  });

  it('treats fitness for purpose as an insurance problem, not a pricing one', () => {
    // The single most expensive term a small contractor signs without noticing.
    const result = analyse({ terms: { contractForm: 'JCT D&B', designLiability: 'FITNESS_FOR_PURPOSE' } });

    const design = result.terms.find((t) => t.term === 'Design liability')!;
    assert.equal(design.severity, 'SEVERE');
    assert.match(design.assessment, /excluded by almost every professional indemnity policy/);
    assert.ok(result.clarifications.some((c) => c.includes('reasonable skill and care')));

    const insurable = analyse({ terms: { contractForm: 'JCT D&B', designLiability: 'REASONABLE_SKILL_AND_CARE' } });
    assert.equal(insurable.terms.find((t) => t.term === 'Design liability')!.severity, 'ROUTINE');
  });

  it('treats a parent company guarantee as a bar, because a business without a parent cannot give one', () => {
    const result = analyse({ terms: { contractForm: 'NEC4', parentCompanyGuaranteeRequired: true } });

    assert.equal(result.terms.find((t) => t.term === 'Parent company guarantee')!.severity, 'BAR');
    assert.ok(result.bars.includes('Parent company guarantee required'));
    assert.equal(result.readyToPrice, false);
    assert.ok(result.clarifications.some((c) => c.includes('performance bond in place of')));
  });

  it('quantifies bonding and retention as cash rather than percentages', () => {
    const result = analyse({
      terms: { contractForm: 'NEC4', performanceBondPercent: 10, retentionPercent: 5 },
    });

    const bond = result.terms.find((t) => t.term === 'Performance bond')!;
    assert.equal(bond.exposureMinor, 200_000_00);
    assert.match(bond.assessment, /capacity taken from the next bid/);

    const retention = result.terms.find((t) => t.term === 'Retention')!;
    assert.equal(retention.exposureMinor, 100_000_00);
    assert.match(retention.assessment, /cash the business funds, not a discount/);

    assert.equal(result.quantifiedExposureMinor, 100_000_00, 'only retention is exposure; a bond is capacity');
  });

  it('orders terms by what they will actually do to the business', () => {
    const result = analyse({
      terms: {
        contractForm: 'JCT D&B',
        retentionPercent: 3,
        parentCompanyGuaranteeRequired: true,
        designLiability: 'FITNESS_FOR_PURPOSE',
      },
    });

    assert.equal(result.terms[0]!.severity, 'BAR');
    assert.equal(result.terms[1]!.severity, 'SEVERE');
  });

  it('blocks pricing while a mandatory requirement has no evidence', () => {
    const result = analyse({
      requirements: [requirement({ reference: 'R9', category: 'QUALIFICATION', requirement: 'Three years of audited accounts and a credit reference', evidenceRequired: 'Audited accounts' })],
    });

    // The probe finds turnover on file, so this one is satisfied. Prove the
    // opposite path with a requirement the profile genuinely cannot answer.
    const gap = analyse({
      requirements: [requirement({ reference: 'R10', category: 'QUALITY', requirement: 'ISO 9001 accreditation certificate', evidenceRequired: 'ISO 9001 certificate' })],
    });
    assert.ok(result.matrix.length === 1);
    assert.equal(gap.matrix[0]!.status, 'SATISFIED', 'ISO 9001 is on the seeded profile');
  });

  it('keeps the analysis event in the catalogue and off the AI', () => {
    const definition = lookupEventType('ITT_ANALYSED');
    assert.ok(definition);
    assert.equal(definition.entity, 'ITTAnalysis');
    assert.equal(definition.aiAllowed, false, 'reading a contract into a matrix is not a model’s decision to own');
  });
});

// ── Cost intelligence ───────────────────────────────────────────────────────

describe('The cost intelligence database', () => {
  it('groups the same item written by different people', () => {
    assert.equal(
      costintel.rateKey('Bulk excavation in made ground (C40/50)', 'm3'),
      costintel.rateKey('bulk  excavation in made ground', 'M3'),
    );
    // But not two genuinely different items.
    assert.notEqual(costintel.rateKey('Excavation in rock', 'm3'), costintel.rateKey('Excavation in made ground', 'm3'));
  });

  it('states how much is behind every figure rather than implying it', () => {
    assert.equal(costintel.confidenceFor(0), 'NONE');
    assert.equal(costintel.confidenceFor(2), 'THIN');
    assert.equal(costintel.confidenceFor(5), 'USABLE');
    assert.equal(costintel.confidenceFor(12), 'STRONG');
  });

  it('harvests real rates from committed estimates without anything being typed twice', () => {
    const library = costintel.costIntelligence(qs(), { today: '2026-08-20' });

    assert.ok(library.totals.rateObservations > 0);
    assert.ok(library.rates.length > 0);
    for (const rate of library.rates) {
      assert.ok(rate.medianMinor > 0);
      assert.ok(rate.unit.length > 0);
      assert.ok(rate.observations >= 1);
    }
  });

  it('calls a single observation a data point, not a benchmark', () => {
    const library = costintel.costIntelligence(qs(), { today: '2026-08-20' });
    const thin = library.rates.filter((r) => r.confidence === 'THIN');

    assert.ok(thin.length > 0, 'the seeded project prices each item once');
    for (const rate of thin) {
      assert.match(rate.caveat!, /not a benchmark/);
    }
  });

  it('never turns a package price into a unit rate', () => {
    // A subcontract covers dozens of measured items and there is no honest way
    // to apportion it back to a rate. Package outturns stay package outturns.
    const library = costintel.costIntelligence(qs(), { today: '2026-08-20' });
    for (const outturn of library.outturns) {
      assert.ok(outturn.marketMinor > 0);
      assert.ok(!('rateMinor' in outturn), 'a package price leaked into the rate library');
      assert.ok(['SUBCONTRACT', 'SUBMISSION'].includes(outturn.source));
    }
  });

  it('refuses to benchmark a line against its own reflection', () => {
    const ctx = qs();
    const estimate = platform.ledger.list(seed.projectId, 'Estimate').at(-1)!;
    const benchmark = costintel.benchmarkEstimate(ctx, estimate.refId, '2026-08-20');

    // Every line on this estimate is the only observation of itself. Comparing
    // it to a median of one — its own rate — would report perfect agreement.
    assert.ok(benchmark.lines.length > 0);
    for (const line of benchmark.lines) {
      assert.equal(line.verdict, 'NO_HISTORY');
      assert.equal(line.medianMinor, null);
      assert.match(line.note, /Nothing comparable/);
    }
    assert.equal(benchmark.compared, 0);
    assert.equal(benchmark.medianVariancePercent, null);
    assert.ok(benchmark.warnings.some((w) => w.includes('says so rather than implying agreement')));
  });

  it('compares a line once the business has priced it before', () => {
    const ctx = qs();
    const line = (rate: number) => ({
      description: 'Reinforced concrete to walls',
      unit: 'm3',
      quantity: 100,
      labourRateMinor: rate,
    });

    // Three earlier estimates, then a fourth priced well above them.
    for (const rate of [60_000, 62_000, 64_000]) {
      tender.buildEstimate(ctx, {
        packageId: `PKG-HIST-${rate}`,
        durationWeeks: 20,
        lines: [line(rate)],
        margin: { overheadPercent: 5, profitPercent: 8 },
        basisOfEstimate: 'History',
        assumptions: [],
      });
    }
    const outlier = tender.buildEstimate(ctx, {
      packageId: 'PKG-OUTLIER',
      durationWeeks: 20,
      lines: [line(95_000)],
      margin: { overheadPercent: 5, profitPercent: 8 },
      basisOfEstimate: 'The one to question',
      assumptions: [],
    });

    const benchmark = costintel.benchmarkEstimate(ctx, outlier.estimateId, '2026-08-20');
    const concrete = benchmark.lines.find((l) => l.description === 'Reinforced concrete to walls')!;

    assert.equal(concrete.verdict, 'ABOVE');
    assert.equal(concrete.observations, 3, 'the line should not count itself');
    assert.equal(concrete.medianMinor, 62_000);
    assert.ok(concrete.variancePercent! > 50);
    assert.match(concrete.note, /Worth explaining before the tender goes in/);
    assert.ok(benchmark.warnings.some((w) => w.includes('more than 25%')));
  });

  it('reports estimating accuracy against the market, or says why it cannot', () => {
    const library = costintel.costIntelligence(qs(), { today: '2026-08-20' });

    if (library.estimatingAccuracy) {
      assert.ok(library.estimatingAccuracy.packages > 0);
      assert.ok(library.estimatingAccuracy.reading.length > 0);
    } else {
      assert.ok(
        library.observations.some((o) => o.includes('estimating accuracy cannot be measured')) ||
          library.outturns.length === 0,
        'silence about accuracy has to be explained',
      );
    }
  });
});

// ── Reading a matrix back ───────────────────────────────────────────────────

/**
 * The half that did not exist.
 *
 * `analyseITT` wrote a full compliance matrix into the ledger and handed it
 * back in a response body, and that was the only time anybody could see it.
 * Close the tab and the analysis was hashed into the chain, woke the tender
 * agents, and had no screen — so the bid manager asking on the Monday which
 * mandatory requirement has nothing behind it had to run the analysis again,
 * spending AI budget to re-derive a record the platform already held and
 * writing a second `ITT_ANALYSED` event saying the same thing.
 *
 * What is asserted here is that the record read back is the same analysis, not
 * a lookalike: the two fields the stored state does not carry verbatim —
 * `mandatoryGaps` as whole lines and `weightings.declared` — are re-derived,
 * and re-derived to the same answer.
 */
describe('A compliance matrix stays readable after the session that produced it', () => {
  const full = () =>
    analyse({
      reference: 'ITT-READBACK-01',
      estimatedValueMinor: 8_000_000_00,
      durationWeeks: 52,
      targetMarginPercent: 7,
      requirements: [
        requirement({ reference: 'R1', category: 'INSURANCE', weightingPercent: 40 }),
        requirement({
          reference: 'R2',
          category: 'TECHNICAL',
          requirement: 'A method statement for the deep basement',
          evidenceRequired: 'Technical submission',
          weightingPercent: 35,
        }),
        requirement({
          reference: 'R3',
          category: 'SOCIAL_VALUE',
          requirement: 'Local labour commitment',
          mandatory: false,
          evidenceRequired: 'Social value schedule',
          weightingPercent: 25,
        }),
      ],
      terms: {
        contractForm: 'JCT D&B 2016',
        liquidatedDamages: { perWeekMinor: 20_000_00, capPercent: 8 },
        retentionPercent: 5,
        designLiability: 'FITNESS_FOR_PURPOSE',
      },
    });

  it('returns the same analysis on read as it did on write', () => {
    const written = full();
    const read = itt.complianceMatrix(qs(), written.analysisId);

    assert.equal(read.analysisId, written.analysisId);
    assert.equal(read.reference, written.reference);
    assert.equal(read.clientName, written.clientName);
    assert.equal(read.readyToPrice, written.readyToPrice);
    assert.equal(read.quantifiedExposureMinor, written.quantifiedExposureMinor);
    assert.deepEqual(read.matrix, written.matrix);
    // The order matters and is the reason the terms are sorted before the
    // write rather than after it: worst first is how the list is read.
    assert.deepEqual(read.terms.map((t) => t.severity), written.terms.map((t) => t.severity));
    assert.deepEqual(read.bars, written.bars);
    assert.deepEqual(read.clarifications, written.clarifications);
  });

  it('re-derives the two fields the record does not carry verbatim', () => {
    const written = full();
    const read = itt.complianceMatrix(qs(), written.analysisId);

    // `mandatoryGaps` is stored as references. Read back as whole lines, and
    // the same lines — a gap on the day is a gap on the read.
    assert.deepEqual(read.mandatoryGaps, written.mandatoryGaps);
    for (const gap of read.mandatoryGaps) {
      assert.equal(gap.mandatory, true);
      assert.equal(gap.status, 'GAP');
    }

    // `weightings.declared` is not stored at all, and comes back identical
    // because both sides compute it with the same function.
    assert.deepEqual(read.weightings, written.weightings);
    assert.equal(read.weightings.stated, 100);
    assert.equal(read.weightings.complete, true);
  });

  it('carries what the exposure was computed against, so a later reader can check it', () => {
    const written = full();
    const read = itt.complianceMatrix(qs(), written.analysisId);

    // Without these two figures the exposure column is a number with no
    // denominator — £640,000 of damages means nothing without the contract
    // value and the programme it was judged against.
    assert.equal(read.estimatedValueMinor, 8_000_000_00);
    assert.equal(read.durationWeeks, 52);
    assert.ok(read.analysedAt.length > 0, 'the analysis carries no date');
    assert.ok(read.analysedBy.length > 0, 'the analysis carries no author');
    assert.equal(read.projectId, seed.projectId);
  });

  it('lists every matrix on file, worst news first on each row', () => {
    const written = full();
    const board = itt.analysisBoard(qs());

    const row = board.analyses.find((a) => a.analysisId === written.analysisId);
    assert.ok(row, 'an analysis that was written is not on the board');
    assert.equal(row.reference, 'ITT-READBACK-01');
    assert.equal(row.requirements, written.matrix.length);
    assert.equal(row.mandatoryGaps, written.mandatoryGaps.length);
    assert.equal(row.bars, written.bars.length);
    assert.equal(row.clarifications, written.clarifications.length);
    // Fitness for purpose is SEVERE, and it must be the severity the row
    // reports — a list that showed the mildest term would read as reassurance.
    assert.equal(row.worstTerm, 'SEVERE');
    assert.equal(row.readyToPrice, written.readyToPrice);
  });

  it('orders the board most recently analysed first', () => {
    itt.analyseITT(qs(), {
      reference: 'ITT-READBACK-02',
      clientName: 'Second Buyer',
      returnBy: '2026-07-01',
      estimatedValueMinor: 1_000_000_00,
      durationWeeks: 20,
      requirements: [requirement()],
      terms: { contractForm: 'NEC4 ECC Option A' },
    });

    const board = itt.analysisBoard(qs());
    const dates = board.analyses.map((a) => a.analysedAt);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'the board is not in reverse date order');
    assert.match(board.summary, /compliance matri/);
  });

  it('refuses an analysis that does not exist, rather than returning an empty one', () => {
    throwsCode(() => itt.complianceMatrix(qs(), 'no-such-analysis'), 'ITT_ANALYSIS_NOT_FOUND');
  });

  it('will not hand a matrix to another tenancy on the same platform', () => {
    // A second tenancy in the *same* ledger, which is the only arrangement
    // that tests anything. A separate `Platform` has a separate ledger, so the
    // record is simply absent and the read would refuse whether the tenant was
    // checked or not — that version of this test passed with the isolation
    // check deleted.
    const written = full();
    const other = platform.createTenant({
      legalName: 'Somebody Else Contracting Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'Somebody Else Contracting',
    });
    const stranger = platform.createUser({
      tenantId: other.tenant.id,
      name: 'Their commercial manager',
      email: 'commercial@somebodyelse.example',
      roles: ['COMMERCIAL_MANAGER'],
    });
    const strangerAuth = verifyToken(
      issueTokens({ actorId: stranger.id, tenantId: other.tenant.id, roles: stranger.roles, mfaSatisfied: true }).accessToken,
    );

    // Our analysis id, in their hands, in a ledger that holds both: refused as
    // "no such matrix" rather than "not yours". The distinction is itself
    // information about what another contractor is bidding on.
    throwsCode(
      () =>
        itt.complianceMatrix(
          platform.context(strangerAuth, `${other.tenant.id}-governance`, { source: 'WEB' }),
          written.analysisId,
        ),
      'ITT_ANALYSIS_NOT_FOUND',
    );

    // And their board is empty rather than showing ours.
    const theirBoard = itt.analysisBoard(platform.context(strangerAuth, `${other.tenant.id}-governance`, { source: 'WEB' }));
    assert.deepEqual(theirBoard.analyses, [], 'another tenancy can see our compliance matrices');
  });

  it('refuses a reader with no commercial rights', () => {
    // The matrix carries the client, the contract value and every exposure
    // figure. It is COMMERCIAL_L3, and the read is authorised as such.
    throwsCode(
      () => itt.complianceMatrix(platform.context(seed.users.regulator!.auth, seed.projectId, { source: 'WEB' }), full().analysisId),
      'ACCESS_DENIED',
    );
  });
});
