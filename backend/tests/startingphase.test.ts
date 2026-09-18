import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as structure from '../src/domain/structure.ts';
import { LIFECYCLE_ORDER, phasesBefore } from '../src/lifecycle/phases.ts';
import * as stages from '../src/lifecycle/stages.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * Where a project joins the lifecycle, and how a bid becomes a job.
 *
 * ## The thing this fixes
 *
 * Every project opened at `CONCEPT`, hardcoded. The lifecycle
 * `CONCEPT → DESIGN → TENDER → CONSTRUCTION → …` is the *asset's*, and a
 * business joins it wherever its own involvement begins: a contractor pricing
 * somebody else's design has no concept phase and no design phase.
 *
 * Forcing that contractor to start at `CONCEPT` meant inventing a scope package
 * and a design maturity assessment for the sole purpose of clearing two gates —
 * the platform teaching people, on day one, to put fabricated records into the
 * Golden Thread. That is the failure these tests exist to keep closed.
 *
 * ## And the thing it must not become
 *
 * A starting phase is not a way past a gate. A project that opened at `TENDER`
 * never had `CONCEPT.SCOPE_DEFINED` or `DESIGN.MATURITY_ASSESSED` evaluated
 * here, and three years later a reader has to be able to tell that project from
 * one that came through those gates. So the phases not traversed are recorded
 * on the project as state, a reason is required, and both are asserted below —
 * because a field nothing checks is a field that will be empty when it matters.
 */

let platform: Platform;
let seed: SeedResult;
let gov: ReturnType<Platform['context']>;
let portfolioId: string;
let programmeId: string | undefined;

const LOCATION = { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' };

function open(name: string, extra: Record<string, unknown> = {}): { projectId: string; phase: string } {
  return structure.createProject(gov, {
    portfolioId,
    programmeId,
    name,
    sectorType: 'UTILITIES',
    assetType: 'Fixture',
    location: LOCATION,
    contractValueMinor: 100_000_000,
    currency: 'GBP',
    plannedStart: '2026-02-02',
    plannedCompletion: '2027-08-13',
    ...extra,
  } as Parameters<typeof structure.createProject>[1]);
}

const projectState = (projectId: string): Record<string, unknown> =>
  platform.ledger.entitiesOfType('Project').find((record) => record.state.id === projectId)!.state;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const source = platform.ledger.entitiesOfType('Project').find((r) => r.state.id === seed.projectId)!;
  portfolioId = String(source.state.portfolioId);
  programmeId = source.state.programmeId as string | undefined;
});

describe('a project opens where the business joins the lifecycle', () => {
  it('still starts at CONCEPT when nothing says otherwise', () => {
    // The settled behaviour, and every existing caller depends on it. A default
    // that moved would rewrite the seed and every fixture silently.
    const { projectId, phase } = open('Default start');
    assert.equal(phase, 'CONCEPT');

    const state = projectState(projectId);
    assert.equal(state.phase, 'CONCEPT');
    assert.equal(state.startedAtPhase, 'CONCEPT');
    assert.deepEqual(state.phasesNotTraversed, []);
    // No reason, because nothing was skipped. An empty explanation field on a
    // project that skipped nothing is noise in every reader.
    assert.equal(state.startingPhaseReason, undefined);
  });

  it('opens a bid at TENDER without inventing a scope package to get there', () => {
    const { projectId, phase } = open('Ashworth tender', {
      startingPhase: 'TENDER',
      startingPhaseReason: 'Pricing the client’s own design against their bill of quantities.',
    });

    assert.equal(phase, 'TENDER');
    const state = projectState(projectId);
    assert.equal(state.phase, 'TENDER');

    // No ScopePackage and no DesignMaturityAssessment exist on this project,
    // which is the whole point: it reached TENDER without either.
    assert.equal(platform.ledger.list(projectId, 'ScopePackage').length, 0);
    assert.equal(platform.ledger.list(projectId, 'DesignMaturityAssessment').length, 0);
  });

  it('records the phases it never entered, so nobody has to infer them', () => {
    const { projectId } = open('Recorded skip', {
      startingPhase: 'CONSTRUCTION',
      startingPhaseReason: 'Novated onto a job already under way; the earlier phases are the previous contractor’s.',
    });

    const state = projectState(projectId);
    assert.deepEqual(state.phasesNotTraversed, ['CONCEPT', 'DESIGN', 'TENDER']);
    assert.match(String(state.startingPhaseReason), /Novated/);

    // And on the history entry, where a reader walking the timeline finds it.
    const history = state.phaseHistory as Array<Record<string, unknown>>;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.phase, 'CONSTRUCTION');
    assert.equal(history[0]!.openedHere, true);
    assert.deepEqual(history[0]!.notTraversed, ['CONCEPT', 'DESIGN', 'TENDER']);
  });

  it('opens the stage record at that phase and says what was skipped in it', () => {
    // The stage instance is the record an auditor reads, and one that opened at
    // CONSTRUCTION saying only "project created" would be the same record a
    // project that walked there would have.
    const { projectId } = open('Stage record', {
      startingPhase: 'OPERATIONS',
      startingPhaseReason: 'Took over an existing asset under a facilities management appointment.',
    });

    const ctx = platform.context(seed.users.admin!.auth, projectId, { source: 'WEB' });
    const current = stages.currentStage(ctx)!;
    assert.equal(current.phase, 'OPERATIONS');
    assert.match(String(current.reason), /not traversing CONCEPT, DESIGN, TENDER, CONSTRUCTION, COMMISSIONING, HANDOVER/);
  });

  it('refuses a start past CONCEPT with no reason, and says why it wants one', () => {
    const refusal = throwsCode(
      () => open('No reason', { startingPhase: 'TENDER' }),
      'STARTING_PHASE_UNEXPLAINED',
    );
    // The sentence matters as much as the code: it is what the person filling
    // the form reads, and "required field" would not tell them what to write.
    assert.match(String(refusal.message), /CONCEPT and DESIGN gate/);
    assert.match(String(refusal.message), /three years from now/);
  });

  it('refuses a one-word reason, which is the reason nobody can use later', () => {
    throwsCode(() => open('Terse', { startingPhase: 'TENDER', startingPhaseReason: 'bid' }), 'STARTING_PHASE_UNEXPLAINED');
  });

  it('refuses a phase that is not one', () => {
    throwsCode(
      () => open('Nonsense', { startingPhase: 'PRECONSTRUCTION', startingPhaseReason: 'Sounds plausible enough' }),
      'PHASE_UNKNOWN',
    );
  });

  it('agrees with the lifecycle order about what comes before each phase', () => {
    // `phasesBefore` is what the record is built from, so it is checked against
    // the order rather than against a second hand-written list.
    for (const [index, phase] of LIFECYCLE_ORDER.entries()) {
      assert.deepEqual(phasesBefore(phase), LIFECYCLE_ORDER.slice(0, index));
    }
  });
});

describe('a won tender converts the same project — it does not create a second one', () => {
  /**
   * The correction this file was rewritten for.
   *
   * The first implementation created a successor project at award and linked
   * the two. That is how many contractors number their work — bid number, then
   * job number — but it is the wrong model for a platform whose whole claim is
   * one immutable Golden Thread: two records for one job put a seam in the
   * chain exactly where the most-argued question lives, because a variation in
   * year three has to trace back through a join to the tender assumption that
   * priced it. And a join is a thing that breaks.
   *
   * So the project id, its reference, its evidence vault and its chain are
   * created once at tender registration and never reissued. Award changes the
   * project's lifecycle status; it does not change which project it is.
   */
  function bid(name: string): { projectId: string; ctx: ReturnType<Platform['context']> } {
    const created = open(name, {
      startingPhase: 'TENDER',
      startingPhaseReason: 'Pricing the client design against their bill of quantities.',
    });
    return { projectId: created.projectId, ctx: platform.context(seed.users.admin!.auth, created.projectId, { source: 'WEB' }) };
  }

  const AWARD = {
    contractAwardDate: '2026-04-20',
    contractSumMinor: 142_500_000,
    contractForm: 'NEC4 ECC Option A',
    amendments: 'Z-clauses 1 to 14, client standard',
    contractedScope: 'Civils, MEP and commissioning of the treatment works as tendered, less the access road.',
    contractStartDate: '2026-05-05',
    contractCompletionDate: '2027-11-30',
    paymentTermsDays: 30,
    retentionPercent: 3,
  };

  it('keeps the same project id, and says it entered at tender', () => {
    const { projectId, ctx } = bid('Cawley WTW');
    const before = platform.ledger.entitiesOfType('Project').length;

    const result = structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded under LOI-4471; conversion approved by the commercial director.',
    });

    // The assertion the whole rewrite is for.
    assert.equal(result.projectId, projectId, 'award changed the project id');
    assert.equal(
      platform.ledger.entitiesOfType('Project').length,
      before,
      'award created a second project record',
    );

    assert.equal(result.entryStage, 'TENDER');
    assert.equal(result.phase, 'DESIGN');

    const state = projectState(projectId);
    assert.equal(state.startedAtPhase, 'TENDER', 'the entry stage was overwritten by the delivery stage');
    assert.equal(state.phase, 'DESIGN');
    assert.equal(state.commercialStatus, 'AWARDED');
    assert.equal(state.deliveryStatus, 'MOBILISING');
    assert.equal(state.tenderOutcome, 'WON');
  });

  it('moves to DESIGN as a conversion, not as a regression', () => {
    /*
     * DESIGN is *earlier* than TENDER in this lifecycle, because the order is
     * the asset's and the asset's order is the client's: design it, then tender
     * it. A contractor's order is the reverse. Recording award as a regression
     * would put "the project went back a stage" on the one event that is the
     * opposite of a setback.
     */
    const { projectId, ctx } = bid('Conversion not regression');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; contractor carries the detailed design.',
    });

    const history = projectState(projectId).phaseHistory as Array<Record<string, unknown>>;
    assert.equal(history.at(-1)!.phase, 'DESIGN');
    assert.equal(history.at(-1)!.direction, 'CONVERSION');
  });

  it('opens at CONSTRUCTION where the design is novated', () => {
    const { projectId, ctx } = bid('Novated design');
    const result = structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'CONSTRUCTION',
      justification: 'Design novated complete at award; works start on site directly.',
    });
    assert.equal(result.phase, 'CONSTRUCTION');
    assert.equal(projectState(projectId).phase, 'CONSTRUCTION');
  });

  it('takes the contract sum and dates, and keeps the tender figures rather than losing them', () => {
    const { projectId, ctx } = bid('Figures');
    const tenderValue = Number(projectState(projectId).contractValueMinor);

    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded at a negotiated figure above the tendered sum.',
    });

    const state = projectState(projectId);
    assert.equal(state.contractValueMinor, AWARD.contractSumMinor, 'the contract sum did not become the headline figure');
    assert.equal(state.tenderValueMinor, tenderValue, 'the tendered figure was lost');
    assert.equal(state.plannedStart, AWARD.contractStartDate);
    assert.equal(state.plannedCompletion, AWARD.contractCompletionDate);
    assert.equal((state.award as Record<string, unknown>).contractForm, 'NEC4 ECC Option A');
  });

  it('freezes the tender and the award as two separate baselines', () => {
    const { projectId, ctx } = bid('Baselines');
    const tenderValue = Number(projectState(projectId).contractValueMinor);

    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; freezing the tender position before design starts.',
    });

    const baselines = platform.ledger.list(projectId, 'ProjectBaseline').map((record) => record.state);
    const tender = baselines.find((b) => b.kind === 'TENDER')!;
    const award = baselines.find((b) => b.kind === 'CONTRACT_AWARD')!;

    assert.ok(tender, 'no tender baseline was frozen');
    assert.ok(award, 'no contract award baseline was frozen');

    // The original tender is never overwritten by the award — that is the whole
    // point of two records rather than one moving number.
    assert.equal(tender.tenderValueMinor, tenderValue);
    assert.equal(award.contractSumMinor, AWARD.contractSumMinor);
    assert.notEqual(tender.tenderValueMinor, award.contractSumMinor);
    assert.equal(award.comparedToBaselineId, tender.id);
  });

  it('opens the reconciliation with all ten lines, measuring only the two it holds both sides of', () => {
    const { projectId, ctx } = bid('Reconciliation');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; reconciliation of tender against contract opens now.',
    });

    const position = structure.awardReconciliation(ctx)!;
    assert.equal(position.items.length, 10);
    assert.equal(position.openCount, 10);
    // Nothing is complete at the moment it opens. The platform measured two
    // movements; a movement is the input to a judgement, not the judgement, and
    // reporting 20% complete on arrival would be reporting arithmetic as work.
    assert.equal(position.completePercent, 0);

    const price = position.items.find((item) => item.id === 'PRICE')!;
    assert.equal(price.measurable, true);
    // A number and its unit, not a formatted sentence. A domain returning
    // "£4.50M" would be choosing a currency, a locale and a precision on behalf
    // of every reader of every project — and the screen printed the bare
    // integer beside a correctly rendered "209 days" until the unit travelled
    // with it.
    assert.equal(price.movement, AWARD.contractSumMinor - 100_000_000);
    assert.equal(price.unit, 'MONEY');

    const programme = position.items.find((item) => item.id === 'PROGRAMME')!;
    assert.equal(programme.unit, 'DAYS');
    assert.equal(typeof programme.movement, 'number');

    // Scope is deliberately not measured. A machine-generated "no difference"
    // against a scope nobody read is the most dangerous row this table carries.
    const scope = position.items.find((item) => item.id === 'SCOPE')!;
    assert.equal(scope.measurable, false);
    assert.equal(scope.movement, undefined);
    assert.equal(scope.unit, null, 'an unmeasured line carries a unit, which implies a number that is not there');
    assert.equal(scope.owner, null);

    void projectId;
  });

  it('will not settle a reconciliation line without the sentence that explains it', () => {
    const { ctx } = bid('Settling');
    const { reconciliationId } = structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the reconciliation is the first month of work.',
    });

    throwsCode(
      () => structure.settleReconciliationItem(ctx, { reconciliationId, itemId: 'SCOPE', status: 'AGREED' }),
      'RECONCILIATION_NOTE_REQUIRED',
    );

    structure.settleReconciliationItem(ctx, {
      reconciliationId,
      itemId: 'SCOPE',
      status: 'AGREED',
      owner: 'Nadia Hussain',
      note: 'Access road removed from the contracted scope; the tender allowance of £180k comes out of the budget.',
    });

    const position = structure.awardReconciliation(ctx)!;
    const scope = position.items.find((item) => item.id === 'SCOPE')!;
    assert.equal(scope.status, 'AGREED');
    assert.equal(scope.owner, 'Nadia Hussain');
    assert.ok(scope.approvedAt, 'a settled line carries no approval date');
    assert.equal(position.openCount, 9);
    assert.equal(position.completePercent, 10);
  });

  it('does not stamp an approval on a line that is merely in progress', () => {
    const { ctx } = bid('In progress');
    const { reconciliationId } = structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; work starts on the reconciliation immediately.',
    });

    structure.settleReconciliationItem(ctx, {
      reconciliationId,
      itemId: 'RISKS',
      status: 'IN_PROGRESS',
      owner: 'Marie Okonkwo',
    });

    const risks = structure.awardReconciliation(ctx)!.items.find((item) => item.id === 'RISKS')!;
    assert.equal(risks.status, 'IN_PROGRESS');
    assert.equal(risks.approvedAt, null, 'an open line was stamped as approved');
  });

  it('refuses a second award on one project', () => {
    const { ctx } = bid('Awarded once');
    structure.convertToDelivery(ctx, { award: AWARD, deliveryEntry: 'DESIGN', justification: 'Awarded under the framework.' });
    throwsCode(
      () => structure.convertToDelivery(ctx, { award: AWARD, deliveryEntry: 'DESIGN', justification: 'Awarded again somehow.' }),
      'ALREADY_CONVERTED',
    );
  });

  it('refuses to convert a project that was never at tender', () => {
    const concept = open('Never tendered');
    const ctx = platform.context(seed.users.admin!.auth, concept.projectId, { source: 'WEB' });
    throwsCode(
      () => structure.convertToDelivery(ctx, { award: AWARD, deliveryEntry: 'DESIGN', justification: 'Awarded, allegedly.' }),
      'PROJECT_NOT_AT_TENDER',
    );
  });

  it('refuses a tender outcome once the project has been converted', () => {
    const { ctx } = ((): { ctx: ReturnType<Platform['context']> } => {
      const made = bid('Converted then reconsidered');
      structure.convertToDelivery(made.ctx, { award: AWARD, deliveryEntry: 'DESIGN', justification: 'Awarded and under way.' });
      return made;
    })();
    throwsCode(
      () => structure.recordTenderOutcome(ctx, { outcome: 'LOST', reason: 'Changed our mind about having won it.' }),
      'TENDER_ALREADY_CONVERTED',
    );
  });
});

describe('the five endings that are not a win', () => {
  function bid(name: string): ReturnType<Platform['context']> {
    const created = open(name, {
      startingPhase: 'TENDER',
      startingPhaseReason: 'Competitive tender on the client’s issued information.',
    });
    return platform.context(seed.users.admin!.auth, created.projectId, { source: 'WEB' });
  }

  it('carries six outcomes, because two cannot describe a pipeline', () => {
    // A register that knows only won and lost reads everything genuinely in
    // between — negotiating, on hold, withdrawn, awaiting a framework call-off —
    // as "still being priced", and a business then cannot tell live work from
    // dead paper.
    assert.deepEqual(Object.keys(structure.TENDER_OUTCOMES).sort(), [
      'FRAMEWORK_APPOINTMENT',
      'LOST',
      'NEGOTIATION',
      'ON_HOLD',
      'WITHDRAWN',
      'WON',
    ]);
    // Only one of them converts, and it is the only one with its own gate.
    assert.deepEqual(
      Object.entries(structure.TENDER_OUTCOMES).filter(([, meta]) => meta.converts).map(([id]) => id),
      ['WON'],
    );
  });

  it('closes a lost bid and records who won it', () => {
    const ctx = bid('Lost');
    structure.recordTenderOutcome(ctx, {
      outcome: 'LOST',
      reason: 'Priced 11% above the winner on preliminaries; our programme was four weeks longer.',
      wonBy: 'Hartley Civils',
      winningValueMinor: 128_000_000,
    });

    const state = platform.ledger.entitiesOfType('Project').find((r) => r.state.id === ctx.projectId)!.state;
    assert.equal(state.tenderOutcome, 'LOST');
    assert.equal(state.commercialStatus, 'CLOSED');
    assert.equal(state.lostTo, 'Hartley Civils');
    // Still at TENDER. The project did not move; it stopped.
    assert.equal(state.phase, 'TENDER');
  });

  it('leaves an on-hold or negotiating bid exactly where it was', () => {
    for (const outcome of ['ON_HOLD', 'NEGOTIATION'] as const) {
      const ctx = bid(`Still live — ${outcome}`);
      structure.recordTenderOutcome(ctx, {
        outcome,
        reason: 'Client has paused the award pending a funding decision in the autumn.',
      });
      const state = platform.ledger.entitiesOfType('Project').find((r) => r.state.id === ctx.projectId)!.state;
      assert.equal(state.tenderOutcome, outcome);
      assert.equal(state.commercialStatus, 'PRE_AWARD', `${outcome} closed a bid that is still live`);
      assert.equal(state.status, 'ACTIVE');
    }
  });

  it('keeps every outcome a bid has had, in order', () => {
    // A bid that went on hold in March, back into negotiation in May and was
    // lost in July has a story, and one overwritten field tells none of it.
    const ctx = bid('Long road');
    structure.recordTenderOutcome(ctx, { outcome: 'ON_HOLD', reason: 'Client paused pending a funding decision.' });
    structure.recordTenderOutcome(ctx, { outcome: 'NEGOTIATION', reason: 'Funding released; commercial terms reopened.' });
    structure.recordTenderOutcome(ctx, { outcome: 'LOST', reason: 'Client awarded to an incumbent on their framework.' });

    const state = platform.ledger.entitiesOfType('Project').find((r) => r.state.id === ctx.projectId)!.state;
    const history = state.outcomeHistory as Array<Record<string, unknown>>;
    assert.deepEqual(history.map((entry) => entry.outcome), ['ON_HOLD', 'NEGOTIATION', 'LOST']);
    assert.equal(state.tenderOutcome, 'LOST');
  });

  it('records a framework appointment without converting anything', () => {
    const ctx = bid('Framework');
    structure.recordTenderOutcome(ctx, {
      outcome: 'FRAMEWORK_APPOINTMENT',
      reason: 'Appointed to Lot 3 of the regional framework; call-offs follow as child projects.',
      frameworkReference: 'RWF-2026-L3',
    });
    const state = platform.ledger.entitiesOfType('Project').find((r) => r.state.id === ctx.projectId)!.state;
    assert.equal(state.frameworkReference, 'RWF-2026-L3');
    assert.equal(state.commercialStatus, 'PRE_AWARD');
    assert.equal(state.phase, 'TENDER');
  });

  it('refuses the one-word reason a business gives itself instead of looking', () => {
    const ctx = bid('Terse loss');
    throwsCode(() => structure.recordTenderOutcome(ctx, { outcome: 'LOST', reason: 'price' }), 'OUTCOME_REASON_REQUIRED');
  });

  it('leaves a hit rate computable, which is why a loss is recorded at all', () => {
    // Without a loss record a bid that went nowhere and a bid still being priced
    // are the same row, and the ratio of wins to *open* bids always flatters.
    const bids = platform.ledger
      .entitiesOfType('Project')
      .map((record) => record.state)
      .filter((state) => state.startedAtPhase === 'TENDER');

    assert.ok(bids.length >= 5);
    assert.ok(bids.some((s) => s.tenderOutcome === 'WON'));
    assert.ok(bids.some((s) => s.tenderOutcome === 'LOST'));
    assert.ok(bids.some((s) => s.tenderOutcome === undefined), 'every bid was decided — the denominator is complete by accident');
  });
});
