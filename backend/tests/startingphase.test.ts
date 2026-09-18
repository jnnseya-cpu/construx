import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as structure from '../src/domain/structure.ts';
import { LIFECYCLE_ORDER, phasesBefore } from '../src/lifecycle/phases.ts';
import { LIFECYCLE_STATES, LIFECYCLE_STATE_CODES, lifecycleState } from '../src/lifecycle/state.ts';
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
    // The commercial outcome and the lifecycle state both move here, because
    // this is the one command that completes the bid and opens delivery.
    assert.equal(state.commercialOutcome, 'WON');
    assert.equal(state.lifecycleState, 'LIVE_MOBILISING');
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
      () =>
        structure.setLifecycleState(ctx, {
          to: 'CLOSED_LOST',
          reason: 'Changed our mind about having won it.',
        }),
      'LIFECYCLE_TRANSITION_FORBIDDEN',
    );
  });
});

describe('the lifecycle state is its own dimension', () => {
  /**
   * The specification's §3.1 asks for seven independent control dimensions and
   * the platform had three of them fused. A project in `DESIGN` could be a live
   * job mobilising, a suspended job with everyone demobilised, or a bid nobody
   * has won — and one field said `DESIGN` to all three.
   *
   * These assert the separation rather than the states: that the lifecycle can
   * move without the phase moving, that the commercial outcome can be set
   * without the project going live, and that delivery follows the lifecycle
   * rather than drifting from it.
   */
  function bid(name: string): ReturnType<Platform['context']> {
    const created = open(name, {
      startingPhase: 'TENDER',
      startingPhaseReason: 'Competitive tender on the client’s issued information.',
    });
    return platform.context(seed.users.admin!.auth, created.projectId, { source: 'WEB' });
  }

  const stateOf = (ctx: { projectId: string }): Record<string, unknown> =>
    platform.ledger.entitiesOfType('Project').find((r) => r.state.id === ctx.projectId)!.state;

  it('opens a tender project as a tender opportunity, not a draft', () => {
    const ctx = bid('Opens pre-award');
    assert.equal(stateOf(ctx).lifecycleState, 'PRE_AWARD');
    assert.equal(stateOf(ctx).deliveryStatus, undefined, 'delivery started before anything was won');
  });

  it('moves into negotiation without moving the phase', () => {
    const ctx = bid('Negotiating');
    structure.setLifecycleState(ctx, {
      to: 'NEGOTIATION',
      reason: 'Client has opened commercial negotiation on preliminaries and the programme.',
    });

    const state = stateOf(ctx);
    assert.equal(state.lifecycleState, 'NEGOTIATION');
    // The work has not moved. The phase is where the work is; the lifecycle is
    // what the project is, and this is the separation the dimension exists for.
    assert.equal(state.phase, 'TENDER');
    assert.equal(state.deliveryStatus, 'NOT_STARTED');
  });

  it('refuses a transition the table does not allow, and says what is allowed', () => {
    const ctx = bid('Illegal move');
    const refusal = throwsCode(
      () => structure.setLifecycleState(ctx, { to: 'HANDOVER', reason: 'Skipping straight to handover, somehow.' }),
      'LIFECYCLE_TRANSITION_FORBIDDEN',
    );
    // The sentence names the permitted states in words, not codes — the screen
    // shows this to a person, and "PRE_AWARD" is not a thing anybody says.
    assert.match(String(refusal.message), /Tender negotiation/);
    assert.match(String(refusal.message), /Award validation/);
    assert.doesNotMatch(String(refusal.message), /AWARD_PENDING/);
  });

  it('will not reopen a closed project through the control that advances a live one', () => {
    const ctx = bid('Reopen guard');
    structure.setLifecycleState(ctx, {
      to: 'CLOSED_LOST',
      reason: 'Client awarded to an incumbent on their own framework.',
      commercialOutcome: 'LOST',
    });

    // The transition is permitted — but only as a reopen, and only when the
    // caller says so. A lost bid one click from being live is the failure.
    throwsCode(
      () => structure.setLifecycleState(ctx, { to: 'PRE_AWARD', reason: 'Client came back and asked us to re-bid.' }),
      'REOPEN_REQUIRED',
    );

    const reopened = structure.setLifecycleState(ctx, {
      to: 'PRE_AWARD',
      reason: 'Client cancelled the first award and invited us to re-bid the package.',
      reopen: true,
    });
    assert.equal(reopened.reopened, true);

    const history = stateOf(ctx).lifecycleHistory as Array<Record<string, unknown>>;
    assert.equal(history.at(-1)!.reopened, true, 'a reopen is not marked in the history that records it');
  });

  it('keeps every state the project has been in, in order', () => {
    const ctx = bid('Long road');
    structure.setLifecycleState(ctx, { to: 'ON_HOLD', reason: 'Client paused pending a funding decision.' });
    structure.setLifecycleState(ctx, { to: 'AWARD_PENDING', reason: 'Funding released; intent to award received.' });
    structure.setLifecycleState(ctx, { to: 'CLOSED_LOST', reason: 'Intent withdrawn; awarded elsewhere.', commercialOutcome: 'LOST' });

    const history = stateOf(ctx).lifecycleHistory as Array<Record<string, unknown>>;
    // Creation is the first entry. A history that began at the first *change*
    // could not say what the project opened as, which is the question every
    // "how did this get here" starts with.
    assert.deepEqual(history.map((entry) => entry.to), ['PRE_AWARD', 'ON_HOLD', 'AWARD_PENDING', 'CLOSED_LOST']);
    assert.equal(history[0]!.from, null, 'the opening entry claims a previous state');
    assert.equal(stateOf(ctx).lifecycleState, 'CLOSED_LOST');
  });

  it('separates the commercial outcome from the lifecycle state', () => {
    // BR-002 in one assertion: a Won outcome does not make a project live.
    const ctx = bid('Won but not live');
    structure.setLifecycleState(ctx, {
      to: 'AWARD_PENDING',
      reason: 'Letter of intent received; the executed contract is still with their solicitors.',
      commercialOutcome: 'WON',
    });

    const state = stateOf(ctx);
    assert.equal(state.commercialOutcome, 'WON');
    assert.equal(state.lifecycleState, 'AWARD_PENDING');
    assert.notEqual(state.lifecycleState, 'LIVE_MOBILISING');
    assert.equal(state.deliveryStatus, 'NOT_STARTED', 'delivery started on a letter of intent');
  });

  it('records a no-bid, which is not a loss', () => {
    // Counting a decision not to price as a loss understates a hit rate as
    // surely as ignoring losses overstates it.
    const ctx = bid('No bid');
    structure.setLifecycleState(ctx, {
      to: 'WITHDRAWN',
      reason: 'Qualified out at the bid/no-bid review: no capacity in the window and the risk profile was wrong.',
      commercialOutcome: 'NO_BID',
    });
    assert.equal(stateOf(ctx).commercialOutcome, 'NO_BID');
    assert.equal(stateOf(ctx).lifecycleState, 'WITHDRAWN');
  });

  it('suspends a live job without pretending it is still live', () => {
    // BR-009's sibling: a suspended job counted as live is how a portfolio
    // reports capacity it does not have.
    const ctx = bid('Suspended');
    structure.convertToDelivery(ctx, {
      award: {
        contractAwardDate: '2026-04-20',
        contractSumMinor: 50_000_000,
        contractForm: 'JCT D&B 2016',
        contractedScope: 'As tendered.',
        contractStartDate: '2026-05-05',
        contractCompletionDate: '2027-11-30',
      },
      deliveryEntry: 'CONSTRUCTION',
      justification: 'Awarded and converted; works start on site in May.',
    });
    assert.equal(stateOf(ctx).lifecycleState, 'LIVE_MOBILISING');

    structure.setLifecycleState(ctx, { to: 'SUSPENDED', reason: 'Client suspended the works pending a planning appeal.' });

    const state = stateOf(ctx);
    assert.equal(state.lifecycleState, 'SUSPENDED');
    assert.equal(state.deliveryStatus, 'SUSPENDED');
    // Still in CONSTRUCTION. The work has not moved; it has stopped.
    assert.equal(state.phase, 'CONSTRUCTION');
  });

  it('refuses a state that is not one', () => {
    const ctx = bid('Nonsense state');
    throwsCode(
      () => structure.setLifecycleState(ctx, { to: 'MOBILISED' as never, reason: 'Sounds plausible enough.' }),
      'LIFECYCLE_STATE_UNKNOWN',
    );
  });

  it('refuses a one-word reason', () => {
    const ctx = bid('Terse');
    throwsCode(() => structure.setLifecycleState(ctx, { to: 'ON_HOLD', reason: 'paused' }), 'LIFECYCLE_REASON_REQUIRED');
  });
});

describe('the lifecycle transition table itself', () => {
  it('carries the fifteen canonical states', () => {
    assert.equal(LIFECYCLE_STATES.length, 15);
    assert.deepEqual(new Set(LIFECYCLE_STATE_CODES).size, 15, 'a state code is duplicated');
  });

  it('names every state it points at', () => {
    // A transition to a state that does not exist is a dead end nobody finds
    // until somebody tries to take it.
    const known = new Set<string>(LIFECYCLE_STATE_CODES);
    for (const definition of LIFECYCLE_STATES) {
      for (const target of [...definition.next, ...(definition.reopenTo ?? [])]) {
        assert.ok(known.has(target), `${definition.state} points at ${target}, which is not a state`);
      }
    }
  });

  it('gives every state a label and an entry condition a person can read', () => {
    for (const definition of LIFECYCLE_STATES) {
      assert.ok(definition.label.length > 2, `${definition.state} has no label`);
      assert.ok(definition.entryCondition.length > 8, `${definition.state} has no entry condition`);
      // No underscores and no shouting: §9's UI principle is that users see
      // decisions and status, never implementation codes. "Draft" is a fine
      // label for DRAFT; "LIVE_MOBILISING" would not be one for itself.
      assert.doesNotMatch(definition.label, /_/, `${definition.state}'s label is a code`);
      assert.notEqual(definition.label, definition.label.toUpperCase(), `${definition.state}'s label is shouted`);
    }
  });

  it('counts only genuinely live states as live', () => {
    const live = LIFECYCLE_STATES.filter((d) => d.live).map((d) => d.state);
    assert.deepEqual(live.sort(), ['HANDOVER', 'LIVE_ACTIVE', 'LIVE_MOBILISING', 'OPERATIONS']);
    // The two that would be wrong, asserted by name because both are tempting.
    assert.equal(lifecycleState('SUSPENDED').live, false, 'a suspended job counts as live capacity');
    assert.equal(lifecycleState('AWARD_PENDING').live, false, 'an unsigned job counts as live work');
  });

  it('lets every terminal state be reopened, rather than forcing a duplicate project', () => {
    for (const definition of LIFECYCLE_STATES.filter((d) => d.terminal)) {
      const ways = [...definition.next, ...(definition.reopenTo ?? [])];
      assert.ok(ways.length > 0, `${definition.state} is a dead end, so the only way out is a duplicate project`);
    }
  });
});
