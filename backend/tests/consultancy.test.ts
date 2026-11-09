import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  demandSwitchingValue,
  scenarioRuns,
  serviceBusinessCase,
} from '../src/domain/consultancy/model.ts';
import {
  intakeBlockers,
  recommendDecision,
  screenOptions,
  type AppraisalOption,
  type MinimumIntake,
} from '../src/domain/consultancy/engagement.ts';
import { assembleBusinessCase, type BusinessCaseInput } from '../src/domain/consultancy/businesscase.ts';

/**
 * The first vertical of the Autonomous Consultancy spec: the deterministic
 * appraisal model, the engagement decision logic, and the Five Case Model
 * deliverable. The spec names concrete acceptance tests; the ones that are pure
 * and computable now (C02, C06, C07, C12) are proven here against the numbers
 * the spec itself states.
 */

describe('the deterministic appraisal model (spec §5)', () => {
  it('C07 — 450,000 cost, 3 net receipt/use, 100,000 subsidy cap → 150,000 break-even and 116,667 minimum within cap', () => {
    const r = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000 });
    assert.equal(r.breakEvenUses, 150_000, 'operating break-even is cost / net receipt');
    assert.equal(r.minUsesWithinCap, 116_667, 'minimum whole uses once the capped subsidy is applied, rounded up');
  });

  it('the switching value equals the break-even, surfaced under its appraisal name', () => {
    assert.equal(
      demandSwitchingValue({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3 }),
      150_000,
    );
  });

  it('serves demand only up to capacity and surfaces unmet demand rather than satisfying it silently', () => {
    const r = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, capacityUses: 200_000, demandUses: 250_000 });
    assert.equal(r.servedUses, 200_000);
    assert.equal(r.unmetUses, 50_000);
    assert.equal(r.demandExceedsCapacity, true);
  });

  it('a central case above break-even runs an operating surplus and needs no subsidy', () => {
    const r = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000, demandUses: 160_000 });
    assert.equal(r.receiptsMinor, 480_000);
    assert.equal(r.operatingBalanceMinor, 30_000);
    assert.equal(r.fundingGapMinor, 0);
    assert.equal(r.residualGapMinor, 0);
    assert.equal(r.withinSubsidyCap, true);
  });

  it('a downside case below break-even draws the subsidy and leaves a residual gap when the cap bites', () => {
    const r = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000, demandUses: 116_000 });
    assert.equal(r.fundingGapMinor, 102_000, '450,000 − 348,000 receipts');
    assert.equal(r.subsidyDrawnMinor, 100_000, 'capped at the subsidy available');
    assert.equal(r.residualGapMinor, 2_000, 'the gap the cap cannot close');
    assert.equal(r.withinSubsidyCap, false);
  });

  it('a non-positive net receipt never breaks even (no divide-by-zero)', () => {
    const r = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 0, subsidyCapMinor: 0 });
    assert.equal(r.breakEvenUses, Number.POSITIVE_INFINITY);
  });

  it('scenario runs are reproducible and span downside / central / upside', () => {
    const input = { operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000, demandUses: 150_000 };
    const a = scenarioRuns(input);
    const b = scenarioRuns(input);
    assert.deepEqual(a.map((s) => s.result), b.map((s) => s.result), 'each scenario reproduces');
    assert.deepEqual(a.map((s) => s.name), ['Downside', 'Central', 'Upside']);
    assert.ok((a[0]!.result.servedUses ?? 0) < (a[2]!.result.servedUses ?? 0), 'downside serves fewer uses than upside');
  });

  it('tests zero demand (spec §5): a dead service is all deficit and all gap', () => {
    const r = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000, demandUses: 0 });
    assert.equal(r.receiptsMinor, 0);
    assert.equal(r.operatingBalanceMinor, -450_000);
    assert.equal(r.residualGapMinor, 350_000, 'the whole cost less the capped subsidy is unfunded');
  });
});

describe('option screening and the decision (spec §1, §5)', () => {
  const options: AppraisalOption[] = [
    { name: 'Do minimum', summary: 'Retain current frequency', constraints: [{ name: 'Deliverable', satisfied: true }], score: 40 },
    {
      name: 'Hourly + Sunday',
      summary: 'Reinstate hourly and add a Sunday service',
      // The highest-scored option, but a fatal constraint is unsatisfied.
      constraints: [{ name: 'Engineering access', satisfied: false, note: 'no Sunday path confirmed' }],
      score: 90,
    },
  ];

  it('C06 — a weighted score cannot clear a fatal constraint: the high-scored option is ineligible', () => {
    const screened = screenOptions(options);
    const hourly = screened.find((o) => o.name === 'Hourly + Sunday')!;
    assert.equal(hourly.eligible, false, 'excluded despite the top score');
    assert.ok(hourly.excludedBy.some((x) => /Engineering access/.test(x)));
    assert.equal(screened.find((o) => o.name === 'Do minimum')!.eligible, true);
  });

  it('recommends PROCEED on an eligible, affordable option with nothing outstanding', () => {
    const screened = screenOptions([{ name: 'Hourly', summary: 'Reinstate hourly', constraints: [{ name: 'Deliverable', satisfied: true }], score: 80 }]);
    const model = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000, demandUses: 160_000 });
    const d = recommendDecision(screened, model, []);
    assert.equal(d.recommendation, 'PROCEED');
    assert.equal(d.preferredOption, 'Hourly');
    assert.equal(d.conditions.length, 0);
  });

  it('recommends HOLD (conditional appraisal) when a confirmation is outstanding or a residual gap remains', () => {
    const screened = screenOptions([{ name: 'Hourly', summary: 'Reinstate hourly', constraints: [{ name: 'Deliverable', satisfied: true }], score: 80 }]);
    const model = serviceBusinessCase({ operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000, demandUses: 116_000 });
    const d = recommendDecision(screened, model, ['Operator confirmation of Sunday paths']);
    assert.equal(d.recommendation, 'HOLD');
    assert.ok(d.conditions.some((c) => /Operator confirmation/.test(c)), 'carries the outstanding confirmation');
    assert.ok(d.conditions.some((c) => /additional funding/.test(c)), 'carries the residual funding gap');
  });

  it('C12 — recommends STOP when no option clears the hard constraints', () => {
    const screened = screenOptions([options[1]!]); // only the fatally-constrained option
    const d = recommendDecision(screened, undefined, []);
    assert.equal(d.recommendation, 'STOP');
    assert.match(d.rationale, /cannot clear a fatal constraint|No option clears/);
  });
});

describe('minimum intake (spec §1, test C02)', () => {
  it('records missing mandatory inputs as blockers and clears when complete', () => {
    assert.ok(intakeBlockers({ client: 'North Lincolnshire Council' }).length > 0, 'a partial intake has blockers');
    const complete: MinimumIntake = {
      decisionRequested: 'Reinstate an hourly Doncaster–Scunthorpe service and add a Sunday service',
      decisionAuthority: 'North Lincolnshire Council',
      client: 'North Lincolnshire Council',
      partySide: 'CLIENT',
      assetOrService: 'Doncaster–Scunthorpe rail service',
      location: 'North Lincolnshire',
    };
    assert.deepEqual(intakeBlockers(complete), [], 'a complete intake has no blockers');
  });
});

describe('the Five Case Model deliverable (spec §5, §7 validation contract)', () => {
  const input: BusinessCaseInput = {
    title: 'Doncaster–Scunthorpe additional rail services',
    intake: {
      decisionRequested: 'Reinstate an hourly service and introduce a Sunday service',
      decisionAuthority: 'North Lincolnshire Council',
      client: 'North Lincolnshire Council',
      partySide: 'CLIENT',
      assetOrService: 'Doncaster–Scunthorpe rail service',
      location: 'North Lincolnshire',
      deadline: '25 June 2027',
    },
    objectives: ['Restore hourly connectivity', 'Introduce a Sunday service', 'Improve access to jobs and education'],
    options: [
      { name: 'Do minimum', summary: 'Retain current frequency', constraints: [{ name: 'Deliverable', satisfied: true }], score: 40 },
      { name: 'Hourly + Sunday', summary: 'Reinstate hourly and add Sunday', constraints: [{ name: 'Deliverable', satisfied: true }], score: 85 },
    ],
    preferredOption: 'Hourly + Sunday',
    serviceCase: { operatingCostMinor: 450_000, netReceiptPerUseMinor: 3, subsidyCapMinor: 100_000, demandUses: 160_000 },
    capitalCostMinor: 1_200_000,
    fundingSources: [{ body: 'North Lincolnshire Council', amountMinor: 100_000, status: 'indicative' }],
    programmeMonths: 7,
    stage: 'OBC',
    outstandingConfirmations: ['Network Rail confirmation of Sunday paths'],
  };

  it('assembles all five cases, reconciles figures to the model, and keeps economic value separate from funding', () => {
    const { blocks, model, decision } = assembleBusinessCase(input);
    const headings = blocks.filter((b) => b.kind === 'HEADING').map((b) => (b as { text: string }).text);
    for (const name of ['Strategic Case', 'Economic Case', 'Commercial Case', 'Financial Case', 'Management Case']) {
      assert.ok(headings.some((h) => h.includes(name)), `the pack carries the ${name}`);
    }
    // Economic value (options/appraisal) and funding (financial) are separate sections.
    const economicIdx = headings.findIndex((h) => h.includes('Economic Case'));
    const financialIdx = headings.findIndex((h) => h.includes('Financial Case'));
    assert.ok(economicIdx >= 0 && financialIdx > economicIdx, 'the Financial Case is a distinct, later section');

    // The preferred option and its figures reconcile to the model run.
    const text = JSON.stringify(blocks);
    assert.ok(text.includes('150,000'), 'the break-even reconciles to the model');
    assert.equal(model!.breakEvenUses, 150_000);
    assert.equal(decision.recommendation, 'HOLD', 'an outstanding operator confirmation makes the decision conditional');
    assert.ok(decision.conditions.some((c) => /Sunday paths/.test(c)));
  });

  it('completes without a model (qualitative case) and fabricates no figure it was not given', () => {
    const { blocks, model } = assembleBusinessCase({ ...input, serviceCase: undefined, capitalCostMinor: undefined, fundingSources: undefined });
    assert.equal(model, undefined);
    const text = JSON.stringify(blocks);
    assert.ok(!text.includes('150,000'), 'no break-even figure is invented when no model was run');
    assert.ok(text.includes('not supplied'), 'absent figures are shown as not supplied, not fabricated');
  });
});
