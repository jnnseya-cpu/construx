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

/**
 * AC-05: every material movement between tender and contract carries a name.
 *
 * The fixture awards deliberately move the price and the programme, because a
 * conversion where nothing moved proves nothing about the register. Since the
 * conversion now refuses a material movement with nobody against it, the
 * fixtures name owners — and the tests that exercise the refusal leave them out
 * on purpose.
 */
const OWNERS = { PRICE: 'u-commercial-lead', PROGRAMME: 'u-planner', SCOPE: 'u-commercial-lead' };

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
      varianceOwners: OWNERS,
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
      varianceOwners: OWNERS,
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
      varianceOwners: OWNERS,
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
      varianceOwners: OWNERS,
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
      varianceOwners: OWNERS,
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
      varianceOwners: OWNERS,
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
      varianceOwners: OWNERS,
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
      varianceOwners: OWNERS,
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

  it('returns the original receipt when the same attempt arrives twice (AC-03)', () => {
    /*
     * A double-click, a proxy retry, a response that never got back. The key
     * says "this is the same attempt", and the honest answer is the receipt
     * that attempt produced — not a 409 telling somebody their award failed
     * when it did not, because that is the moment a person creates the
     * duplicate project this whole identity model exists to prevent.
     */
    const { projectId, ctx } = bid('Retried once');
    const key = 'idem-4471-a';

    const first = structure.convertToDelivery(ctx, {
      award: AWARD,
      varianceOwners: OWNERS,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded under LOI-4471; approved by the commercial director.',
      idempotencyKey: key,
    });
    const events = platform.ledger.list(projectId, 'ProjectBaseline').length;

    const replay = structure.convertToDelivery(ctx, {
      award: AWARD,
      varianceOwners: OWNERS,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded under LOI-4471; approved by the commercial director.',
      idempotencyKey: key,
    });

    assert.equal(replay.conversionId, first.conversionId, 'the replay minted a second conversion');
    assert.equal(replay.tenderBaselineId, first.tenderBaselineId);
    assert.equal(replay.awardBaselineId, first.awardBaselineId);
    assert.equal(replay.committedAt, first.committedAt, 'the replay restamped the commit time');
    assert.equal(replay.replayed, true, 'a replay is indistinguishable from a fresh commit');
    assert.equal(first.replayed, undefined, 'the first commit claimed to be a replay');

    // And nothing happened a second time.
    assert.equal(platform.ledger.list(projectId, 'ProjectBaseline').length, events, 'the replay wrote another baseline');
    assert.equal(platform.ledger.list(projectId, 'AwardReconciliation').length, 1, 'the replay opened a second reconciliation');
  });

  it('still refuses a different award on an already-converted project', () => {
    // The key distinguishes two very different things. A *different* key is
    // somebody awarding an already-awarded project, which is a supplemental
    // agreement rather than a conversion.
    const { ctx } = bid('Second award attempt');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      varianceOwners: OWNERS,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded and converted.',
      idempotencyKey: 'idem-first',
    });
    throwsCode(
      () =>
        structure.convertToDelivery(ctx, {
          award: { ...AWARD, contractSumMinor: 999 },
          varianceOwners: OWNERS,
          deliveryEntry: 'DESIGN',
          justification: 'A different award entirely.',
          idempotencyKey: 'idem-second',
        }),
      'ALREADY_CONVERTED',
    );
  });

  it('carries the receipt §11.4 asks for', () => {
    const { ctx } = bid('Receipt shape');
    const receipt = structure.convertToDelivery(ctx, {
      award: AWARD,
      varianceOwners: OWNERS,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the receipt is what somebody produces a year later.',
    });

    assert.equal(receipt.previousState, 'PRE_AWARD');
    assert.equal(receipt.currentState, 'LIVE_MOBILISING');
    assert.equal(receipt.entryStage, 'TENDER');
    assert.equal(receipt.phase, 'DESIGN');
    assert.equal(receipt.unresolvedReconciliationItems, 10);
    assert.ok(receipt.conversionId, 'no conversion id');
    assert.ok(receipt.committedAt, 'no commit time');
  });

  it('refuses a second award on one project', () => {
    const { ctx } = bid('Awarded once');
    structure.convertToDelivery(ctx, { award: AWARD, varianceOwners: OWNERS, deliveryEntry: 'DESIGN', justification: 'Awarded under the framework.' });
    throwsCode(
      () => structure.convertToDelivery(ctx, { award: AWARD, varianceOwners: OWNERS, deliveryEntry: 'DESIGN', justification: 'Awarded again somehow.' }),
      'ALREADY_CONVERTED',
    );
  });

  it('refuses to convert a project that was never at tender', () => {
    const concept = open('Never tendered');
    const ctx = platform.context(seed.users.admin!.auth, concept.projectId, { source: 'WEB' });
    throwsCode(
      () => structure.convertToDelivery(ctx, { award: AWARD, varianceOwners: OWNERS, deliveryEntry: 'DESIGN', justification: 'Awarded, allegedly.' }),
      'PROJECT_NOT_AT_TENDER',
    );
  });

  it('refuses a tender outcome once the project has been converted', () => {
    const { ctx } = ((): { ctx: ReturnType<Platform['context']> } => {
      const made = bid('Converted then reconsidered');
      structure.convertToDelivery(made.ctx, { award: AWARD, varianceOwners: OWNERS, deliveryEntry: 'DESIGN', justification: 'Awarded and under way.' });
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
      varianceOwners: OWNERS,
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

describe('the award is validated before anything is written', () => {
  /**
   * §5.4's first rule: *no partial visible conversion is permitted*.
   *
   * On an append-only ledger that cannot be kept by rolling back, so it is kept
   * by validating everything first. These tests assert both halves — the
   * refusal, and that nothing was committed by the attempt.
   */
  function bid(name: string, over: Record<string, unknown> = {}): ReturnType<Platform['context']> {
    const created = open(name, {
      startingPhase: 'TENDER',
      startingPhaseReason: 'Pricing the client design against their bill of quantities.',
      ...over,
    });
    return platform.context(seed.users.admin!.auth, created.projectId, { source: 'WEB' });
  }

  /** Awarded at the tender price and the tender programme: nothing material moved. */
  const FLAT = {
    contractAwardDate: '2026-04-20',
    contractSumMinor: 100_000_000,
    contractForm: 'NEC4 ECC Option A',
    contractedScope: 'Exactly as tendered, with no change to scope, price or programme.',
    contractStartDate: '2026-02-02',
    contractCompletionDate: '2027-08-13',
  };

  it('AC-05 — refuses a material price movement with nobody against it, naming the field', () => {
    const ctx = bid('AC-05 price');
    const before = platform.ledger.list(ctx.projectId, 'AwardReconciliation').length;

    // 100,000,000 tendered against 142,500,000 contracted: 42.5%, far past the
    // share at which a movement stops being a detail.
    const error = throwsCode(
      () =>
        structure.convertToDelivery(ctx, {
          award: { ...FLAT, contractSumMinor: 142_500_000 },
          deliveryEntry: 'DESIGN',
          justification: 'Awarded at a figure nobody has been made responsible for.',
        }),
      'CONVERSION_NOT_READY',
    ) as { status?: number; fieldErrors?: Array<{ field: string; message: string }> };

    assert.equal(error.status, 422);
    // Field-level remediation, which is the whole of AC-05's third column: the
    // form marks the box rather than printing a paragraph above it.
    assert.ok(
      (error.fieldErrors ?? []).some((entry) => entry.field === 'varianceOwners.PRICE'),
      `the refusal named no field: ${JSON.stringify(error.fieldErrors)}`,
    );

    // And nothing was written by the attempt.
    assert.equal(platform.ledger.list(ctx.projectId, 'AwardReconciliation').length, before);
    assert.equal(platform.ledger.list(ctx.projectId, 'InheritanceRegister').length, 0);
    assert.equal(platform.ledger.list(ctx.projectId, 'ProjectBaseline').length, 0);
    assert.equal(projectState(ctx.projectId).lifecycleState, 'PRE_AWARD');
  });

  it('AC-05 — refuses a material programme movement, and a struck-out exclusion, by name', () => {
    const programme = throwsCode(
      () =>
        structure.convertToDelivery(bid('AC-05 programme'), {
          // 558 tendered days against 663: 18.8%.
          award: { ...FLAT, contractCompletionDate: '2027-11-30' },
          deliveryEntry: 'DESIGN',
          justification: 'Awarded on a programme three months longer than the one priced.',
        }),
      'CONVERSION_NOT_READY',
    ) as { fieldErrors?: Array<{ field: string }> };
    assert.ok((programme.fieldErrors ?? []).some((entry) => entry.field === 'varianceOwners.PROGRAMME'));

    // A struck-out exclusion is material at any size: the business priced the
    // work without it and is now carrying it for nothing.
    const scope = throwsCode(
      () =>
        structure.convertToDelivery(bid('AC-05 scope'), {
          award: { ...FLAT, removedExclusions: ['Asbestos removal in the existing plant room'] },
          deliveryEntry: 'DESIGN',
          justification: 'Awarded with the asbestos exclusion struck out by the client.',
        }),
      'CONVERSION_NOT_READY',
    ) as { fieldErrors?: Array<{ field: string }> };
    assert.ok((scope.fieldErrors ?? []).some((entry) => entry.field === 'varianceOwners.SCOPE'));
  });

  it('AC-05 — converts once the owners are named, and opens those lines already owned', () => {
    const ctx = bid('AC-05 owned');
    const receipt = structure.convertToDelivery(ctx, {
      award: { ...FLAT, contractSumMinor: 142_500_000, contractCompletionDate: '2027-11-30' },
      varianceOwners: { PRICE: 'u-commercial-lead', PROGRAMME: 'u-planner' },
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the commercial lead owns the price movement and the planner the programme.',
    });

    const register = structure.awardReconciliation(ctx)!;
    const price = register.items.find((item) => item.id === 'PRICE')!;
    const programme = register.items.find((item) => item.id === 'PROGRAMME')!;
    const scope = register.items.find((item) => item.id === 'SCOPE')!;

    assert.equal(price.owner, 'u-commercial-lead');
    assert.equal(programme.owner, 'u-planner');
    assert.equal(price.material, true, 'a 42.5% price movement is not marked material');
    // Nothing moved on scope in this award, so it opens unowned like the rest.
    assert.equal(scope.material, false);
    assert.equal(scope.owner, null);
    assert.ok(receipt.reconciliationId);
  });

  it('AC-05 — leaves an immaterial movement alone rather than demanding an owner for it', () => {
    // A movement below the share is a detail, and a platform that blocked a
    // conversion over one would teach people to name a fictional owner.
    const ctx = bid('AC-05 immaterial');
    const receipt = structure.convertToDelivery(ctx, {
      award: { ...FLAT, contractSumMinor: 100_200_000 },
      deliveryEntry: 'DESIGN',
      justification: 'Awarded at the tender figure less a rounding adjustment.',
    });
    assert.ok(receipt.conversionId);
    const price = structure.awardReconciliation(ctx)!.items.find((item) => item.id === 'PRICE')!;
    assert.equal(price.material, false);
  });

  it('AC-09 — refuses to convert a framework appointment that has no call-off', () => {
    const ctx = bid('AC-09 framework');
    const error = throwsCode(
      () =>
        structure.convertToDelivery(ctx, {
          award: { ...FLAT, frameworkAppointment: true },
          deliveryEntry: 'CONSTRUCTION',
          justification: 'Appointed to the framework, so the job is live, allegedly.',
        }),
      'CONVERSION_NOT_READY',
    ) as { fieldErrors?: Array<{ field: string }> };

    assert.ok((error.fieldErrors ?? []).some((entry) => entry.field === 'award.callOffReference'));
    assert.equal(projectState(ctx.projectId).lifecycleState, 'PRE_AWARD', 'the framework appointment went live');

    // Named the call-off, and it converts.
    const receipt = structure.convertToDelivery(ctx, {
      award: { ...FLAT, frameworkAppointment: true, callOffReference: 'Call-off 7 — Ribble catchment, task order TO-118', callOffDate: '2026-04-22' },
      deliveryEntry: 'CONSTRUCTION',
      justification: 'Call-off 7 instructed under the framework; this is the job being delivered.',
    });
    assert.equal(receipt.currentState, 'LIVE_MOBILISING');
  });

  it('AC-09 — treats a project already recorded as framework-appointed the same way', () => {
    // The flag can come from either side: the award says so, or the project was
    // already marked FRAMEWORK_APPOINTED when the outcome was recorded. Both
    // are the same commercial fact and neither is a job.
    const ctx = bid('AC-09 outcome');
    structure.setLifecycleState(ctx, {
      to: 'ON_HOLD',
      reason: 'Appointed to the framework; waiting on the first call-off.',
      commercialOutcome: 'FRAMEWORK_APPOINTED',
    });
    throwsCode(
      () =>
        structure.convertToDelivery(ctx, {
          award: FLAT,
          deliveryEntry: 'CONSTRUCTION',
          justification: 'Converting the framework place into a live job.',
        }),
      'CONVERSION_NOT_READY',
    );
  });

  it('AC-04 — a commit against a stale project version is refused, and writes nothing', () => {
    const ctx = bid('AC-04 stale');
    const held = platform.ledger.require({ refType: 'Project', refId: ctx.projectId }).version;

    // Somebody else moves the project after this caller read it.
    structure.setLifecycleState(ctx, { to: 'NEGOTIATION', reason: 'Clarifications issued; the bid is in negotiation.' });
    const current = platform.ledger.require({ refType: 'Project', refId: ctx.projectId }).version;
    assert.ok(current > held, 'the project did not move, so this proves nothing');

    const stale = platform.context(seed.users.admin!.auth, ctx.projectId, { source: 'WEB', expectedVersion: held });
    assert.throws(
      () =>
        structure.convertToDelivery(stale, {
          award: FLAT,
          deliveryEntry: 'DESIGN',
          justification: 'Awarded, from a screen loaded before somebody else moved it.',
        }),
      (error: { code?: string; status?: number; currentVersion?: number; expectedVersion?: number }) => {
        assert.equal(error.code, 'VERSION_CONFLICT');
        assert.equal(error.status, 409);
        assert.equal(error.currentVersion, current);
        assert.equal(error.expectedVersion, held);
        return true;
      },
    );

    // §5.4: no partial visible conversion. Refused before the baselines rather
    // than at the project write four commitments later.
    assert.equal(platform.ledger.list(ctx.projectId, 'ProjectBaseline').length, 0);
    assert.equal(platform.ledger.list(ctx.projectId, 'AwardReconciliation').length, 0);
    assert.equal(platform.ledger.list(ctx.projectId, 'InheritanceRegister').length, 0);

    // And the same award at the current version goes through.
    const fresh = platform.context(seed.users.admin!.auth, ctx.projectId, { source: 'WEB', expectedVersion: current });
    assert.equal(
      structure.convertToDelivery(fresh, {
        award: FLAT,
        deliveryEntry: 'DESIGN',
        justification: 'Awarded, from a screen that had been reloaded.',
      }).currentState,
      'LIVE_MOBILISING',
    );
  });
});

describe('a converted project can reach site', () => {
  /**
   * The defect this closes, found by driving a conversion over HTTP rather than
   * by reading the rule.
   *
   * A design-and-build contractor registers at TENDER, wins, and the conversion
   * opens delivery at DESIGN — earlier in this order, because the order is the
   * asset's and the asset's order is the client's. The job then goes to site,
   * and `DESIGN → CONSTRUCTION` steps over TENDER. Read as a skip it was
   * refused, so **every design-and-build project the platform converted was
   * stuck at DESIGN**, and the only way forward was a "regression" to TENDER
   * the project was not in fact making: a false statement in the record, made
   * to satisfy a check.
   *
   * The rule is not one step at a time. It is that nothing may be passed over
   * unseen.
   */
  function converted(name: string): ReturnType<Platform['context']> {
    const created = open(name, {
      startingPhase: 'TENDER',
      startingPhaseReason: 'Pricing the client design against their bill of quantities.',
    });
    const ctx = platform.context(seed.users.admin!.auth, created.projectId, { source: 'WEB' });
    structure.convertToDelivery(ctx, {
      award: {
        contractAwardDate: '2026-04-20',
        contractSumMinor: 100_000_000,
        contractForm: 'NEC4 ECC Option A',
        contractedScope: 'Design and build of the treatment works, as tendered.',
        contractStartDate: '2026-02-02',
        contractCompletionDate: '2027-08-13',
      },
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the contractor develops the concept design it priced.',
    });

    // The DESIGN gate, satisfied honestly. The point of this test is the skip
    // rule, and a project that cleared the gate is the only one that can reach
    // it — a fixture that skipped the gate would be testing the wrong refusal.
    const designer = platform.context(seed.users.designer!.auth, created.projectId, { source: 'WEB' });
    structure.assessDesignMaturity(designer, {
      packageId: 'PKG-CIVILS',
      disciplineScores: [{ discipline: 'Civil', ribaStage: 4, completenessPercent: 92, frozen: true }],
      informationGaps: [],
      assessorNotes: 'Civils package frozen at RIBA 4; quantities measurable and the sequence agreed.',
    });
    return ctx;
  }

  it('moves from DESIGN to CONSTRUCTION, stepping over the tender it has already been through', () => {
    const ctx = converted('Converted to site');
    assert.equal(projectState(ctx.projectId).phase, 'DESIGN');

    const moved = structure.transitionPhase(ctx, {
      to: 'CONSTRUCTION',
      justification: 'The design is issued for construction and the ground works have started on site.',
    });

    assert.equal(moved.direction, 'FORWARD', 'going to site was recorded as the project going backwards');
    assert.equal(projectState(ctx.projectId).phase, 'CONSTRUCTION');
    // And the entry stage is unchanged: this project entered at tender and
    // still says so, which is how a reader tells it from one that came through
    // concept and design.
    assert.equal(projectState(ctx.projectId).startedAtPhase, 'TENDER');
  });

  it('still refuses a leap over a phase the project has never been in', () => {
    // The failure the check exists for, which the fix must not open.
    const { projectId } = open('Never been anywhere', {
      startingPhase: 'CONCEPT',
      startingPhaseReason: 'An ordinary project, starting at the start.',
    });
    const ctx = platform.context(seed.users.admin!.auth, projectId, { source: 'WEB' });
    throwsCode(
      () =>
        structure.transitionPhase(ctx, {
          to: 'CONSTRUCTION',
          justification: 'Straight to site, with no design and no tender behind it.',
        }),
      'PHASE_SKIP_FORBIDDEN',
    );
    assert.equal(projectState(projectId).phase, 'CONCEPT');
  });

  it('names what was passed over, rather than saying the move is forbidden', () => {
    const { projectId } = open('Named skip', {
      startingPhase: 'CONCEPT',
      startingPhaseReason: 'An ordinary project, starting at the start.',
    });
    const ctx = platform.context(seed.users.admin!.auth, projectId, { source: 'WEB' });
    const error = throwsCode(
      () => structure.transitionPhase(ctx, { to: 'HANDOVER', justification: 'Straight to handover, somehow.' }),
      'PHASE_SKIP_FORBIDDEN',
    ) as { message: string; fieldErrors?: Array<{ field: string }> };

    for (const phase of ['DESIGN', 'TENDER', 'CONSTRUCTION', 'COMMISSIONING']) {
      assert.match(error.message, new RegExp(phase), `${phase} was passed over and not named`);
    }
    assert.ok((error.fieldErrors ?? []).some((entry) => entry.field === 'to'));
  });
});
