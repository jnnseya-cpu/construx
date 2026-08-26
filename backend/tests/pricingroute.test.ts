import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as pricingroute from '../src/domain/pricingroute.ts';
import * as tenderintel from '../src/domain/tenderintel.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Buy it or do it — T-WF-05.
 *
 * Every package is priced twice and one of the two answers goes in the bid. The
 * failures being tested for are the three that make the two numbers look
 * comparable when they are not.
 *
 * A quotation arrives on the firm's own basis and somebody normalises it —
 * a correction. What choosing that firm costs us is an addition. Mixing the two
 * produces a number nobody can defend, because half of it is arithmetic and
 * half of it is judgement.
 *
 * A return that excludes scaffold is not cheaper; it is incomplete.
 *
 * And a route chosen on price alone was chosen on one quarter of the question.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds ESTIMATE_TENDER R, C, U, A and PROCUREMENT_AWARD X — the estimator. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

const AMEY = 'party-amey';
const BALFOUR = 'party-balfour';

/** A comparison with two returns and one normalisation adjustment. */
function seedComparison(packageReference: string, options: { ameyExclusions?: string[] } = {}): string {
  const comparisonId = tenderintel.openComparison(asQS(), {
    packageReference,
    returnDeadline: '2027-03-05T12:00:00.000Z',
    informationCutOff: 'Addendum 3',
    bidders: [
      { partyId: AMEY, name: 'Amey' },
      { partyId: BALFOUR, name: 'Balfour' },
    ],
  }).comparisonId;

  tenderintel.recordRawReturn(asQS(), comparisonId, {
    bidderPartyId: AMEY,
    submittedAt: '2027-03-05T10:00:00.000Z',
    lines: [{ reference: 'A1', description: 'The works', amountMinor: 1_800_000_00 }],
    exclusions: options.ameyExclusions ?? [],
  });
  tenderintel.recordRawReturn(asQS(), comparisonId, {
    bidderPartyId: BALFOUR,
    submittedAt: '2027-03-05T11:00:00.000Z',
    lines: [{ reference: 'B1', description: 'The works', amountMinor: 1_930_000_00 }],
  });
  // A normalisation: Balfour priced in euros at a rate that has moved.
  tenderintel.adjustComparison(asQS(), comparisonId, {
    bidderPartyId: BALFOUR,
    category: 'TAX_OR_CURRENCY',
    amountMinor: -30_000_00,
    reason: 'Priced in EUR at 1.14; restated at the tender base date rate of 1.16',
    fromReturnLine: 'B1',
  });

  return comparisonId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to decide the buy-or-build route on the cladding package',
  });
});

// ── The three legs ──────────────────────────────────────────────────────────

describe('pricing route · raw, normalised and evaluated are three different figures', () => {
  let routeId: string;

  before(() => {
    const comparisonId = seedComparison('PKG-CLAD');
    routeId = pricingroute.openRoute(asQS(), { packageReference: 'PKG-CLAD', comparisonId }).routeId;
  });

  it('refuses a route against a comparison that does not exist', () => {
    throwsCode(
      () => pricingroute.openRoute(asQS(), { packageReference: 'PKG-X', comparisonId: 'not-a-comparison' }),
      'COMPARISON_NOT_FOUND',
    );
  });

  /**
   * The comparison's own figure is raw plus its adjustments — the same scope,
   * differently priced. Read here as the normalised basis rather than
   * recomputed, so there is one register of the adjustments and not two.
   */
  it('reads the normalised figure from the comparison rather than rebuilding it', () => {
    const position = pricingroute.routePosition(asQS(), routeId);
    const balfour = position.options.find((option) => option.name === 'Balfour')!;
    assert.equal(balfour.rawMinor, 1_930_000_00);
    assert.equal(balfour.normalisedMinor, 1_900_000_00);
  });

  it('adds what choosing a route costs beyond its price, and reconciles', () => {
    pricingroute.evaluateRoute(asQS(), routeId, {
      partyId: AMEY,
      head: 'INTERFACE',
      amountMinor: 46_000_00,
      basis: 'Amey exclude the window interface; a second trade has to be managed across it for 14 weeks',
    });
    pricingroute.evaluateRoute(asQS(), routeId, {
      partyId: AMEY,
      head: 'RISK',
      amountMinor: 30_000_00,
      basis: 'No performance bond offered; exposure assessed at the P80 of the risk register line RSK-14',
    });

    const position = pricingroute.routePosition(asQS(), routeId);
    const amey = position.options.find((option) => option.name === 'Amey')!;
    assert.equal(amey.normalisedMinor, 1_800_000_00);
    assert.equal(amey.evaluatedMinor, 1_800_000_00 + 46_000_00 + 30_000_00);
    for (const option of position.options) {
      assert.equal(
        option.evaluatedMinor,
        option.normalisedMinor + option.allowancesMinor + option.adders.reduce((sum, a) => sum + a.amountMinor, 0),
        `${option.name}: normalised plus adders did not reconcile to evaluated`,
      );
    }
  });

  /**
   * A firm that takes design responsibility off us genuinely costs less than
   * its price, and refusing a negative adder would push that saving into a
   * fudge somewhere nobody can see it.
   */
  it('takes a negative adder, because a route can cost less than its price', () => {
    pricingroute.evaluateRoute(asQS(), routeId, {
      partyId: BALFOUR,
      head: 'RISK',
      amountMinor: -22_000_00,
      basis: 'Balfour take single-point design responsibility for the rainscreen, which we would otherwise carry',
    });
    const balfour = pricingroute.routePosition(asQS(), routeId).options.find((o) => o.name === 'Balfour')!;
    assert.equal(balfour.evaluatedMinor, 1_900_000_00 - 22_000_00);
  });

  it('replaces an adder on the same head rather than stacking two', () => {
    pricingroute.evaluateRoute(asQS(), routeId, {
      partyId: BALFOUR,
      head: 'RISK',
      amountMinor: -18_000_00,
      basis: 'Revised after the design responsibility matrix was confirmed',
    });
    const balfour = pricingroute.routePosition(asQS(), routeId).options.find((o) => o.name === 'Balfour')!;
    assert.equal(balfour.adders.filter((adder) => adder.head === 'RISK').length, 1);
    assert.equal(balfour.evaluatedMinor, 1_900_000_00 - 18_000_00);
  });

  it('refuses an adder with no basis an adjudication could test', () => {
    throwsCode(
      () => pricingroute.evaluateRoute(asQS(), routeId, { partyId: AMEY, head: 'MANAGEMENT', amountMinor: 10_000_00, basis: ' ' }),
      'BASIS_REQUIRED',
    );
  });

  it('refuses an adder of nothing', () => {
    throwsCode(
      () => pricingroute.evaluateRoute(asQS(), routeId, { partyId: AMEY, head: 'MANAGEMENT', amountMinor: 0, basis: 'None' }),
      'ADDER_IS_ZERO',
    );
  });

  it('refuses an adder against a firm that did not return', () => {
    throwsCode(
      () =>
        pricingroute.evaluateRoute(asQS(), routeId, {
          partyId: 'party-nobody',
          head: 'RISK',
          amountMinor: 1_000_00,
          basis: 'x',
        }),
      'BIDDER_NOT_IN_COMPARISON',
    );
  });
});

// ── The self-perform route ──────────────────────────────────────────────────

describe('pricing route · what it costs us to do it ourselves', () => {
  let routeId: string;

  before(() => {
    const comparisonId = seedComparison('PKG-GND');
    routeId = pricingroute.openRoute(asQS(), { packageReference: 'PKG-GND', comparisonId }).routeId;
  });

  it('refuses an evaluation adder before there is anything to evaluate', () => {
    throwsCode(
      () => pricingroute.evaluateRoute(asQS(), routeId, { head: 'MANAGEMENT', amountMinor: 10_000_00, basis: 'x' }),
      'NO_SELF_PERFORM_ESTIMATE',
    );
  });

  /**
   * Capacity is what constrains a self-perform route, and a route selected
   * without it was selected on price alone — which is the failure this whole
   * workflow exists to prevent.
   */
  it('refuses an estimate that does not say how many operatives it takes', () => {
    throwsCode(
      () =>
        pricingroute.recordSelfPerform(asQS(), routeId, {
          directCostMinor: 1_700_000_00,
          durationWeeks: 22,
          peakLabour: 0,
          basis: 'Own labour and plant against the measured schedule MS-004',
        }),
      'LABOUR_REQUIRED',
    );
  });

  it('refuses an estimate with no basis somebody could check', () => {
    throwsCode(
      () =>
        pricingroute.recordSelfPerform(asQS(), routeId, {
          directCostMinor: 1_700_000_00,
          durationWeeks: 22,
          peakLabour: 18,
          basis: '  ',
        }),
      'BASIS_REQUIRED',
    );
  });

  it('records it, and needs nothing normalised because it is already on our basis', () => {
    pricingroute.recordSelfPerform(asQS(), routeId, {
      directCostMinor: 1_700_000_00,
      durationWeeks: 22,
      peakLabour: 18,
      basis: 'Own labour and plant against measured schedule MS-004, at the current agreed rates',
      retainedRisks: ['Weather', 'Ground conditions below 3m'],
    });
    const self = pricingroute.routePosition(asQS(), routeId).options.find((o) => o.route === 'SELF_PERFORM')!;
    assert.equal(self.rawMinor, 1_700_000_00);
    assert.equal(self.normalisedMinor, 1_700_000_00);
    assert.equal(self.durationWeeks, 22);
    assert.equal(self.peakLabour, 18);
  });

  it('sits beside the supplier routes and ranks with them', () => {
    pricingroute.evaluateRoute(asQS(), routeId, {
      head: 'MANAGEMENT',
      amountMinor: 120_000_00,
      basis: 'A general foreman and a section engineer for 22 weeks, which a subcontract price would have carried',
    });
    const position = pricingroute.routePosition(asQS(), routeId);
    assert.equal(position.options.length, 3);
    assert.equal(position.rankingSuppressed, false);
    // Amey 1,800,000; Balfour 1,900,000; self-perform 1,820,000.
    assert.deepEqual(position.ranking, ['Amey', 'Self-perform', 'Balfour']);
  });
});

// ── Exclusions ──────────────────────────────────────────────────────────────

describe('pricing route · every exclusion is somebody’s cost', () => {
  let routeId: string;
  let clarification: string;

  before(() => {
    const comparisonId = seedComparison('PKG-MEP', {
      ameyExclusions: ['Common scaffold', 'Builders work in connection', 'Out-of-hours working'],
    });
    routeId = pricingroute.openRoute(asQS(), { packageReference: 'PKG-MEP', comparisonId }).routeId;

    const raised = tenderintel.raiseTenderClarification(asQS(), {
      side: 'BIDDER',
      subject: 'Builders work in connection',
      question: 'Is BWIC in the M&E package or by the main contractor?',
      links: { package: 'PKG-MEP' },
      bidderPartyId: AMEY,
    });
    clarification = raised.reference;
    tenderintel.issueClarification(asQS(), {
      clarificationId: raised.clarificationId,
      response: 'Builders work in connection is by the main contractor, and is priced in the preliminaries.',
      recipients: [
        { partyId: AMEY, name: 'Amey', isBidder: true },
        { partyId: BALFOUR, name: 'Balfour', isBidder: true },
      ],
      entitledBidders: [AMEY, BALFOUR],
    });
  });

  it('reports an undisposed exclusion as making the route not comparable', () => {
    const amey = pricingroute.routePosition(asQS(), routeId).options.find((o) => o.name === 'Amey')!;
    assert.equal(amey.comparable, false);
    assert.deepEqual(amey.openExclusions, ['Common scaffold', 'Builders work in connection', 'Out-of-hours working']);
  });

  it('suppresses the ranking while one is open', () => {
    const position = pricingroute.routePosition(asQS(), routeId);
    assert.equal(position.rankingSuppressed, true);
    assert.equal(position.ranking, undefined);
    assert.match(String(position.suppressionReason), /Common scaffold/);
  });

  it('refuses to price one at nothing, which is an exclusion with a label on it', () => {
    const error = throwsCode(
      () =>
        pricingroute.disposeExclusion(asQS(), routeId, {
          partyId: AMEY,
          exclusion: 'Common scaffold',
          disposition: 'PRICED',
          amountMinor: 0,
        }),
      'ALLOWANCE_REQUIRED',
    );
    assert.match(String(error.message), /an exclusion with a different label on it/);
  });

  it('carries a priced allowance into the evaluated figure', () => {
    pricingroute.disposeExclusion(asQS(), routeId, {
      partyId: AMEY,
      exclusion: 'Common scaffold',
      disposition: 'PRICED',
      amountMinor: 74_000_00,
    });
    const amey = pricingroute.routePosition(asQS(), routeId).options.find((o) => o.name === 'Amey')!;
    assert.equal(amey.allowancesMinor, 74_000_00);
    assert.equal(amey.evaluatedMinor, amey.normalisedMinor + 74_000_00);
  });

  it('refuses a clarified disposition that names no clarification', () => {
    throwsCode(
      () =>
        pricingroute.disposeExclusion(asQS(), routeId, {
          partyId: AMEY,
          exclusion: 'Builders work in connection',
          disposition: 'CLARIFIED',
        }),
      'DISPOSITION_UNREFERENCED',
    );
  });

  it('refuses one resting on a clarification nobody has answered', () => {
    const unanswered = tenderintel.raiseTenderClarification(asQS(), {
      side: 'CLIENT',
      subject: 'Out-of-hours working',
      question: 'Is out-of-hours working permitted?',
      links: { package: 'PKG-MEP' },
    });
    throwsCode(
      () =>
        pricingroute.disposeExclusion(asQS(), routeId, {
          partyId: AMEY,
          exclusion: 'Out-of-hours working',
          disposition: 'CLARIFIED',
          reference: unanswered.reference,
        }),
      'CLARIFICATION_NOT_ISSUED',
    );
  });

  it('accepts one answered by an issued clarification, at no cost', () => {
    pricingroute.disposeExclusion(asQS(), routeId, {
      partyId: AMEY,
      exclusion: 'Builders work in connection',
      disposition: 'CLARIFIED',
      reference: clarification,
    });
    const amey = pricingroute.routePosition(asQS(), routeId).options.find((o) => o.name === 'Amey')!;
    assert.deepEqual(amey.openExclusions, ['Out-of-hours working']);
    assert.equal(amey.allowancesMinor, 74_000_00);
  });

  it('refuses a project exclusion that names nothing the client will read', () => {
    throwsCode(
      () =>
        pricingroute.disposeExclusion(asQS(), routeId, {
          partyId: AMEY,
          exclusion: 'Out-of-hours working',
          disposition: 'PROJECT_EXCLUSION',
        }),
      'DISPOSITION_UNREFERENCED',
    );
  });

  it('lets the routes become comparable once every exclusion is disposed of', () => {
    pricingroute.disposeExclusion(asQS(), routeId, {
      partyId: AMEY,
      exclusion: 'Out-of-hours working',
      disposition: 'PROJECT_EXCLUSION',
      reference: 'EXC-07',
    });
    const position = pricingroute.routePosition(asQS(), routeId);
    assert.equal(position.rankingSuppressed, false);
    // Amey 1,800,000 + the 74,000 scaffold allowance = 1,874,000, against
    // Balfour's normalised 1,900,000. Amey was £130,000 cheaper raw and is
    // £26,000 cheaper once the work they excluded is put back — which is the
    // whole reason for disposing of exclusions before ranking anything.
    assert.deepEqual(position.ranking, ['Amey', 'Balfour']);
  });
});

// ── The selection ───────────────────────────────────────────────────────────

describe('pricing route · a route chosen on price alone is chosen on a quarter of the question', () => {
  let routeId: string;

  const bases = {
    rationale: 'Balfour on the evaluated cost and with the only crew available before March',
    costBasis: 'Normalised at the tender base date; evaluated with design responsibility taken off us',
    riskBasis: 'Single-point design responsibility for the rainscreen, bonded at 10%',
    programmeBasis: '18 weeks against a 22-week window, with the mock-up inside it',
    capacityBasis: 'Two crews confirmed available from 4 January; Amey have none until March',
  };

  before(() => {
    const comparisonId = seedComparison('PKG-FIT');
    routeId = pricingroute.openRoute(asQS(), { packageReference: 'PKG-FIT', comparisonId }).routeId;
  });

  it('refuses a selection while an exclusion is undisposed', () => {
    const dirty = pricingroute.openRoute(asQS(), {
      packageReference: 'PKG-DIRTY',
      comparisonId: seedComparison('PKG-DIRTY', { ameyExclusions: ['Temporary works design'] }),
    }).routeId;
    const error = throwsCode(
      () => pricingroute.selectRoute(asQS(), dirty, { route: 'SUPPLY_CHAIN', partyId: BALFOUR, ...bases }),
      'EXCLUSIONS_UNDISPOSED',
    );
    assert.match(String(error.message), /Temporary works design/);
  });

  /** `AC-T-WF-05-03`. */
  it('refuses a selection that names cost and nothing else', () => {
    const error = throwsCode(
      () =>
        pricingroute.selectRoute(asQS(), routeId, {
          route: 'SUPPLY_CHAIN',
          partyId: BALFOUR,
          rationale: 'Cheapest',
          costBasis: 'Lowest evaluated',
          riskBasis: '',
          programmeBasis: '',
          capacityBasis: '',
        }),
      'BASIS_INCOMPLETE',
    );
    assert.match(String(error.message), /riskBasis, programmeBasis, capacityBasis/);
    assert.match(String(error.message), /cheaper and has no capacity until March is not cheaper/);
  });

  it('refuses a route nobody priced', () => {
    throwsCode(
      () => pricingroute.selectRoute(asQS(), routeId, { route: 'SELF_PERFORM', ...bases }),
      'ROUTE_NOT_PRICED',
    );
  });

  it('records the selection and whether it was the cheapest evaluated', () => {
    const result = pricingroute.selectRoute(asQS(), routeId, { route: 'SUPPLY_CHAIN', partyId: BALFOUR, ...bases });
    assert.equal(result.name, 'Balfour');
    // Amey 1,800,000 against Balfour's normalised 1,900,000 — deliberately not
    // the cheapest, which is the case worth recording.
    assert.equal(result.cheapest, false);
    assert.equal(result.evaluatedMinor, 1_900_000_00);
  });

  it('refuses every change after the selection', () => {
    throwsCode(
      () =>
        pricingroute.evaluateRoute(asQS(), routeId, { partyId: AMEY, head: 'RISK', amountMinor: 5_000_00, basis: 'Late thought' }),
      'ROUTE_SELECTED',
    );
    throwsCode(
      () => pricingroute.selectRoute(asQS(), routeId, { route: 'SUPPLY_CHAIN', partyId: AMEY, ...bases }),
      'ROUTE_SELECTED',
    );
  });

  it('reports the packages where the cheapest evaluated option was not chosen', () => {
    const position = pricingroute.pricingRoutePosition(asQS());
    assert.match(position.summary, /where the cheapest evaluated option was not chosen/);
    const row = position.routes.find((route) => route.packageReference === 'PKG-FIT')!;
    assert.equal(row.selectedName, 'Balfour');
    assert.equal(row.selectedWasCheapest, false);
  });
});

// ── Related parties ─────────────────────────────────────────────────────────

describe('pricing route · a declared interest is declared before the decision', () => {
  let routeId: string;

  before(() => {
    routeId = pricingroute.openRoute(asQS(), {
      packageReference: 'PKG-CONN',
      comparisonId: seedComparison('PKG-CONN'),
    }).routeId;
  });

  it('refuses a declaration that does not say what the connection is', () => {
    throwsCode(
      () => pricingroute.declareInterest(asQS(), routeId, { partyId: AMEY, name: 'Amey', nature: '   ' }),
      'NATURE_REQUIRED',
    );
  });

  it('records it against the firm', () => {
    pricingroute.declareInterest(asQS(), routeId, {
      partyId: AMEY,
      name: 'Amey',
      nature: 'Their commercial director is my brother-in-law',
    });
    const amey = pricingroute.routePosition(asQS(), routeId).options.find((o) => o.name === 'Amey')!;
    assert.match(String(amey.interest?.nature), /brother-in-law/);
  });

  /**
   * Declaring an interest and then making the decision anyway is worse than not
   * declaring it, because it puts the conflict on the record beside your own
   * signature. Somebody else decides.
   */
  it('refuses the person who declared it their own decision on that firm', () => {
    const error = throwsCode(
      () =>
        pricingroute.selectRoute(asQS(), routeId, {
          route: 'SUPPLY_CHAIN',
          partyId: AMEY,
          rationale: 'Cheapest evaluated',
          costBasis: 'x',
          riskBasis: 'x',
          programmeBasis: 'x',
          capacityBasis: 'x',
        }),
      'DECLARED_INTEREST_CONFLICT',
    );
    assert.match(String(error.message), /worse than not declaring it/);
  });

  it('lets somebody else make it, with the declaration on the record beside it', () => {
    const result = pricingroute.selectRoute(asOwner(), routeId, {
      route: 'SUPPLY_CHAIN',
      partyId: AMEY,
      rationale: 'Cheapest evaluated; the declared connection was reviewed and does not affect the price',
      costBasis: 'Lowest evaluated by £100,000',
      riskBasis: 'Bonded at 10%',
      programmeBasis: '16 weeks against a 20-week window',
      capacityBasis: 'Crew confirmed from January',
    });
    assert.equal(result.name, 'Amey');
    const row = pricingroute.pricingRoutePosition(asQS()).routes.find((r) => r.packageReference === 'PKG-CONN')!;
    assert.equal(row.interests, 1);
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('pricing route · what the catalogue says', () => {
  it('lets an agent normalise and never lets one price our own work or choose', () => {
    assert.equal(lookupEventType('RETURN_NORMALISED')?.aiAllowed, true);
    assert.equal(lookupEventType('SELF_PERFORM_PRICED')?.aiAllowed, false);
    assert.equal(lookupEventType('PRICING_ROUTE_SELECTED')?.aiAllowed, false);
  });

  it('records the selection as an approval', () => {
    assert.equal(lookupEventType('PRICING_ROUTE_SELECTED')?.action, 'APPROVE');
  });

  it('classifies the route as commercial', () => {
    const classification = classifyEntity('PricingRoute');
    assert.equal(classification?.area, 'ESTIMATE_TENDER');
    assert.equal(classification?.sensitivity, 'COMMERCIAL_L3');
  });
});
