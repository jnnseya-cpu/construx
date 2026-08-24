import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';
import * as stages from '../src/lifecycle/stages.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Stage instances and gate reviews.
 *
 * A lifecycle stage used to be a string on the project plus an array of past
 * transitions inside its state. That records *that* a project moved. It cannot
 * record what was frozen at the moment it moved, who decided, on what
 * authority, or what was still open when the decision was taken — which are
 * exactly the questions asked three years later, when somebody wants to know
 * why the design was signed off with a clash still on the register.
 *
 * These tests are mostly about what the gate refuses. A control point that
 * cannot be failed is not a control point, and the failures below are the ones
 * that decide whether the record is worth anything: self-approval, approval
 * over open blockers, deciding twice, and — the one that matters most — an
 * approved stage being rewritten after the fact.
 */

let platform: Platform;
let seed: SeedResult;

/**
 * A fresh project, so each test owns its own stage history.
 *
 * Created by the enterprise admin, who is the only seeded role holding `C` on
 * PROJECT_SETUP — and created on the tenant governance pseudo-project, which is
 * where structural commands run.
 */
function freshProject(name: string): string {
  const ctx = platform.context(seed.users.admin!.auth, `${seed.users.admin!.auth.tenantId}-governance`);
  const { projectId } = structure.createProject(ctx, {
    portfolioId,
    name,
    sectorType: 'TRANSPORT',
    assetType: 'Bridge',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
    contractValueMinor: 5_000_000_00,
    currency: 'GBP',
    plannedStart: '2026-01-05',
    plannedCompletion: '2027-06-30',
  });
  return projectId;
}

/** A context for a named seed identity against a given project. */
const as = (who: string, projectId: string) => platform.context(seed.users[who]!.auth, projectId);

/** Satisfy the CONCEPT gate, which needs one scope package. */
function defineScope(projectId: string, who = 'pm'): void {
  structure.createScopePackage(as(who, projectId), {
    name: 'Main works',
    discipline: 'CIVILS',
    scopeOfWorks: 'Substructure, superstructure and approach embankments to the crossing.',
    inclusions: ['Piling'],
    exclusions: ['Statutory diversions'],
    acceptanceCriteria: ['Handed over free of category A defects'],
    estimatedValueMinor: 4_000_000_00,
    designResponsibility: 'CONTRACTOR',
  });
}

let portfolioId: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // Read off the seeded project rather than added to SeedResult: the seed's
  // return shape is depended on by a dozen other suites, and this needs one
  // field that is already recorded on an entity.
  portfolioId = platform.ledger.require({ refType: 'Project', refId: seed.projectId }).state
    .portfolioId as string;
});

// --------------------------------------------------------------- the record

describe('a project records the stages it occupies', () => {
  it('opens the first stage instance when the project is created', () => {
    const projectId = freshProject('Aire Crossing');
    const current = stages.currentStage(as('pm', projectId));

    assert.ok(current, 'a new project has no stage instance');
    assert.equal(current.phase, 'CONCEPT');
    assert.equal(current.status, 'ACTIVE');
    assert.equal(current.projectId, projectId, 'the stage was filed against the wrong project');
    assert.deepEqual(current.openActions, [], 'a new project inherits nothing');
    assert.equal(current.baselineHash, null, 'nothing is frozen until a gate approves it');
  });

  it('files the stage against its own project, not the context the caller came from', () => {
    // `createProject` runs on the tenant governance pseudo-project, so the
    // context still points there when the stage is opened. Getting this wrong
    // files every new project's first stage against the governance record,
    // where nothing would ever look for it.
    const a = freshProject('Calder Viaduct');
    const b = freshProject('Wharfe Underpass');

    assert.notEqual(a, b);
    assert.equal(stages.stageInstances(as('pm', a)).length, 1);
    assert.equal(stages.stageInstances(as('pm', b)).length, 1);
  });
});

// -------------------------------------------------------------- submitting

describe('submitting a stage for gate review', () => {
  it('answers NOT_READY with the blockers named, rather than refusing', () => {
    // Refusing the submission would withhold the one thing the submitter needs,
    // which is the list of what is stopping them.
    const projectId = freshProject('Blocked Bridge');
    const submission = stages.submitForGate(as('pm', projectId), { comments: 'Ready?' });

    assert.equal(submission.result, 'NOT_READY');
    assert.ok(submission.blockers.length > 0, 'an unmet gate must name what is unmet');
    assert.match(submission.blockers[0]!, /CONCEPT\.SCOPE_DEFINED/);

    // And nothing moved.
    const project = platform.ledger.require({ refType: 'Project', refId: projectId });
    assert.equal(project.state.phase, 'CONCEPT');
    assert.equal(stages.currentStage(as('pm', projectId))!.status, 'READY_FOR_GATE');
  });

  it('answers READY_FOR_REVIEW once the exit criteria are met', () => {
    const projectId = freshProject('Ready Bridge');
    defineScope(projectId);

    const submission = stages.submitForGate(as('pm', projectId), { comments: 'Scope defined' });

    assert.equal(submission.result, 'READY_FOR_REVIEW');
    assert.deepEqual(submission.blockers, []);
    assert.equal(stages.currentStage(as('pm', projectId))!.status, 'GATE_REVIEW');
  });

  it('records what the reviewer was shown, so a later argument has an answer', () => {
    const projectId = freshProject('Evidenced Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Scope defined' });

    const review = platform.ledger.require({ refType: 'GateReview', refId: gateReviewId }).state;
    assert.equal(review.submittedBy, seed.users.pm!.id);
    assert.ok(Array.isArray(review.criteria) && (review.criteria as unknown[]).length > 0);
    assert.equal(review.decidedAt, null, 'submitting is not deciding');
  });

  it('refuses a second submission while one is open', () => {
    const projectId = freshProject('Twice Bridge');
    defineScope(projectId);
    stages.submitForGate(as('pm', projectId), { comments: 'First' });

    throwsCode(
      () => stages.submitForGate(as('pm', projectId), { comments: 'Second' }),
      'GATE_ALREADY_SUBMITTED',
    );
  });
});

// ---------------------------------------------------------------- deciding

describe('deciding a gate', () => {
  it('refuses the person who submitted it', () => {
    // The whole purpose of a gate is that somebody other than the person doing
    // the work confirms it is fit to pass. A gate one person can raise and
    // approve is a formality with a timestamp on it.
    // Tested with the enterprise admin, who holds both U and A on PROJECT_SETUP
    // and could therefore do both halves. A project manager is stopped earlier,
    // by not holding A at all — which is the same protection from a different
    // direction and is asserted separately below.
    const projectId = freshProject('Self Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('admin', projectId), { comments: 'Ready' });

    throwsCode(
      () =>
        stages.decideGate(as('admin', projectId), {
          gateReviewId,
          result: 'APPROVED',
          authorityBasis: 'Enterprise Admin',
          comments: 'Looks fine to me',
        }),
      'GATE_SELF_APPROVAL',
    );
  });

  it('refuses a decision from a role that holds no approval authority', () => {
    // The other half of segregation of duties, and the stronger half: the
    // project manager is not stopped by the self-approval check, but by not
    // holding `A` on PROJECT_SETUP at all. Splitting submit (`U`) from decide
    // (`A`) is what makes the permission matrix enforce this rather than one
    // hand-written comparison inside the command.
    const projectId = freshProject('Unauthorised Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });

    assert.throws(
      () =>
        stages.decideGate(as('qs', projectId), {
          gateReviewId,
          result: 'APPROVED',
          authorityBasis: 'Quantity Surveyor',
          comments: 'Fine by me',
        }),
      /ACCESS_DENIED|holds/,
      'a role with no approval authority decided a gate',
    );
  });

  it('refuses approval while exit criteria are unmet', () => {
    const projectId = freshProject('Premature Bridge');
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready?' });

    throwsCode(
      () =>
        stages.decideGate(as('owner', projectId), {
          gateReviewId,
          result: 'APPROVED',
          authorityBasis: 'Sponsor',
          comments: 'Proceed anyway',
        }),
      'GATE_BLOCKERS_OPEN',
    );
  });

  it('transitions the project and freezes what was approved', () => {
    const projectId = freshProject('Approved Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Scope defined' });

    const decision = stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Project Sponsor, delegated authority level 3',
      comments: 'Concept accepted; proceed to design',
    });

    assert.equal(decision.result, 'APPROVED');
    assert.equal(decision.from, 'CONCEPT');
    assert.equal(decision.to, 'DESIGN');
    assert.ok(decision.baselineHash, 'an approved stage must freeze a baseline');

    const project = platform.ledger.require({ refType: 'Project', refId: projectId });
    assert.equal(project.state.phase, 'DESIGN', 'the project did not move');

    const history = stages.stageInstances(as('pm', projectId));
    assert.equal(history.length, 2, 'one closed stage and one open one');

    const [concept, design] = history;
    assert.equal(concept!.status, 'LOCKED');
    assert.equal(concept!.baselineHash, decision.baselineHash);
    assert.equal(design!.status, 'ACTIVE');
    assert.equal(design!.phase, 'DESIGN');
    assert.equal(design!.predecessorId, concept!.id, 'the new stage does not name what it followed');
  });

  it('freezes component versions, not a summary of them', () => {
    // "The design was approved" is not a checkable claim. "These entities at
    // these versions were approved" is, and it is what lets a later dispute
    // establish whether the thing being argued about is the thing signed off.
    const projectId = freshProject('Pinned Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });
    stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Sponsor',
      comments: 'Proceed',
    });

    const [concept] = stages.stageInstances(as('pm', projectId));
    const components = concept!.baselineComponents as Array<{ refType: string; refId: string; version: number }>;

    assert.ok(components.length > 0, 'nothing was pinned');
    assert.ok(
      components.every((c) => typeof c.version === 'number' && c.version > 0),
      'every component must carry the version it was approved at',
    );
    assert.ok(
      components.some((c) => c.refType === 'ScopePackage'),
      'the entity that satisfied the gate is not in its baseline',
    );
  });

  it('produces a different hash when a pinned component is revised', () => {
    // The property that makes the hash worth storing: it is a function of what
    // was approved, so a later revision cannot pass itself off as the approved
    // version.
    const a = freshProject('Hash Bridge A');
    defineScope(a);
    const first = stages.submitForGate(as('pm', a), { comments: 'Ready' });
    const decisionA = stages.decideGate(as('owner', a), {
      gateReviewId: first.gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Sponsor',
      comments: 'Proceed',
    });

    const b = freshProject('Hash Bridge B');
    defineScope(b);
    // A second package, so the set being hashed genuinely differs.
    structure.createScopePackage(as('pm', b), {
      name: 'Enabling works',
      discipline: 'CIVILS',
      scopeOfWorks: 'Site clearance, haul roads and temporary drainage ahead of the main works.',
      inclusions: [],
      exclusions: [],
      acceptanceCriteria: ['Handed over to the main works contractor'],
      estimatedValueMinor: 500_000_00,
      designResponsibility: 'CLIENT',
    });
    const second = stages.submitForGate(as('pm', b), { comments: 'Ready' });
    const decisionB = stages.decideGate(as('owner', b), {
      gateReviewId: second.gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Sponsor',
      comments: 'Proceed',
    });

    assert.notEqual(decisionA.baselineHash, decisionB.baselineHash, 'two different baselines share a hash');
  });

  it('sends a rejected stage back to work without moving the project', () => {
    const projectId = freshProject('Rejected Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });

    stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'REJECTED',
      authorityBasis: 'Sponsor',
      comments: 'Funding envelope not confirmed',
    });

    assert.equal(platform.ledger.require({ refType: 'Project', refId: projectId }).state.phase, 'CONCEPT');
    assert.equal(stages.currentStage(as('pm', projectId))!.status, 'ACTIVE', 'a rejected stage goes back to work');

    // The rejection stays on the record even though the stage carries on.
    const review = platform.ledger.require({ refType: 'GateReview', refId: gateReviewId }).state;
    assert.equal(review.result, 'REJECTED');
    assert.equal(review.decidedBy, seed.users.owner!.id);
    assert.ok(review.decidedAt);
  });

  it('refuses to decide the same review twice', () => {
    const projectId = freshProject('Decided Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });
    stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'REJECTED',
      authorityBasis: 'Sponsor',
      comments: 'No',
    });

    throwsCode(
      () =>
        stages.decideGate(as('owner', projectId), {
          gateReviewId,
          result: 'APPROVED',
          authorityBasis: 'Sponsor',
          comments: 'Changed my mind',
        }),
      'GATE_ALREADY_DECIDED',
    );
  });

  it('names the authority the approver acted under', () => {
    const projectId = freshProject('Authority Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });
    stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Project Sponsor, delegated authority level 3',
      comments: 'Proceed',
    });

    const review = platform.ledger.require({ refType: 'GateReview', refId: gateReviewId }).state;
    assert.equal(review.authorityBasis, 'Project Sponsor, delegated authority level 3');
    assert.equal(review.decidedBy, seed.users.owner!.id);
  });
});

// ----------------------------------------------------------------- actions

describe('approval with conditions attached', () => {
  it('carries the conditions across the boundary they were attached to', () => {
    // Real gates pass with conditions. A system offering only approve or reject
    // forces that into one of two lies: an approval with the conditions
    // recorded nowhere, or a rejection of work everybody agreed should proceed.
    const projectId = freshProject('Conditional Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });

    const decision = stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED_WITH_ACTIONS',
      authorityBasis: 'Sponsor',
      comments: 'Proceed subject to the ground investigation',
      actions: [
        { description: 'Complete the ground investigation', ownerId: seed.users.pm!.id, dueDate: '2026-03-31' },
      ],
    });

    assert.equal(decision.carriedActions.length, 1);

    const design = stages.currentStage(as('pm', projectId))!;
    assert.equal(design.phase, 'DESIGN');

    const carried = design.openActions as Array<Record<string, unknown>>;
    assert.equal(carried.length, 1, 'the condition evaporated at the boundary it was attached to');
    assert.equal(carried[0]!.ownerId, seed.users.pm!.id, 'an action with no owner is a wish');
    assert.equal(carried[0]!.dueDate, '2026-03-31');
    assert.equal(carried[0]!.status, 'OPEN');
    assert.ok(carried[0]!.raisedInStageInstanceId, 'a carried action must remember where it came from');
  });

  it('refuses an approval-with-actions that states no actions', () => {
    const projectId = freshProject('Empty Conditions Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });

    throwsCode(
      () =>
        stages.decideGate(as('owner', projectId), {
          gateReviewId,
          result: 'APPROVED_WITH_ACTIONS',
          authorityBasis: 'Sponsor',
          comments: 'Proceed',
        }),
      'GATE_ACTIONS_REQUIRED',
    );
  });

  it('refuses actions attached to an outright approval, rather than dropping them', () => {
    // Silently ignoring them is how a condition of approval disappears.
    const projectId = freshProject('Unrecorded Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });

    throwsCode(
      () =>
        stages.decideGate(as('owner', projectId), {
          gateReviewId,
          result: 'APPROVED',
          authorityBasis: 'Sponsor',
          comments: 'Proceed',
          actions: [{ description: 'Do the thing', ownerId: seed.users.pm!.id, dueDate: '2026-03-31' }],
        }),
      'GATE_ACTIONS_UNRECORDED',
    );
  });

  it('closes an action with a note, and stops it being closed twice', () => {
    const projectId = freshProject('Closing Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });
    const decision = stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED_WITH_ACTIONS',
      authorityBasis: 'Sponsor',
      comments: 'Proceed subject to conditions',
      actions: [{ description: 'Complete the GI', ownerId: seed.users.pm!.id, dueDate: '2026-03-31' }],
    });

    const actionId = decision.carriedActions[0]!.id;
    stages.closeAction(as('pm', projectId), { actionId, evidenceNote: 'GI report GI-001 issued' });

    const design = stages.currentStage(as('pm', projectId))!;
    const actions = design.openActions as Array<Record<string, unknown>>;
    assert.equal(actions[0]!.status, 'CLOSED');
    assert.equal((design.actionClosures as Array<Record<string, unknown>>)[0]!.evidenceNote, 'GI report GI-001 issued');

    throwsCode(
      () => stages.closeAction(as('pm', projectId), { actionId, evidenceNote: 'again' }),
      'ACTION_ALREADY_CLOSED',
    );
  });
});

// ---------------------------------------------------------------- reopening

describe('re-entering a stage the project has left', () => {
  it('supersedes the live stage and opens a new one without touching the approved record', () => {
    // Projects genuinely re-enter design and re-tender. What must not happen is
    // the approved instance being edited: the decision was taken on the
    // evidence available at the time, and rewriting it destroys the only record
    // of what was actually known.
    const projectId = freshProject('Reopened Bridge');
    defineScope(projectId);
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Ready' });
    const approval = stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Sponsor',
      comments: 'Proceed',
    });

    const [conceptBefore] = stages.stageInstances(as('pm', projectId));

    stages.reopenStage(as('owner', projectId), {
      phase: 'CONCEPT',
      reason: 'Funding envelope withdrawn; the option must be re-appraised',
      scope: 'Option selection and affordability only',
    });

    const [conceptAfter] = stages.stageInstances(as('pm', projectId));
    assert.equal(conceptAfter!.status, 'LOCKED', 'the approved instance was rewritten');
    assert.equal(conceptAfter!.baselineHash, approval.baselineHash, 'the frozen baseline changed');
    assert.deepEqual(conceptAfter, conceptBefore, 'the approved stage is not the same record it was');

    const live = stages.currentStage(as('pm', projectId))!;
    assert.equal(live.phase, 'CONCEPT');
    assert.equal(live.status, 'ACTIVE');
    assert.equal(live.reopensStageInstanceId, conceptAfter!.id, 'the new instance does not point at what it returns to');
    assert.equal(live.scope, 'Option selection and affordability only');
    assert.equal(live.baselineHash, null, 'a re-opened stage starts with nothing frozen');
  });

  it('refuses a re-open with no stated reason or scope', () => {
    const projectId = freshProject('Unjustified Bridge');
    throwsCode(
      () => stages.reopenStage(as('owner', projectId), { phase: 'CONCEPT', reason: '  ', scope: 'x' }),
      'REOPEN_UNJUSTIFIED',
    );
  });
});

// -------------------------------------------------- the continuous last phase

describe('the last phase is reviewed, not exited', () => {
  /**
   * Operations runs for thirty years. The specification is explicit that it has
   * no terminal gate: it is assured annually and at each change,
   * refurbishment or replacement.
   *
   * This began as a bug found by driving the API rather than the unit tests.
   * Approving a gate at OPERATIONS wrote the decision event and *then* threw
   * PHASE_TERMINAL — leaving a review marked APPROVED with its actions carried
   * nowhere and its stage never locked, while the caller got an error saying
   * nothing had happened. On an append-only ledger there is no taking that back.
   */

  /**
   * The seeded project, which the demonstration walks all the way to
   * OPERATIONS through real work at every gate.
   *
   * Shared rather than built per test: reaching OPERATIONS honestly means
   * satisfying six gates' worth of exit criteria, and a helper that skipped
   * them would be testing a path the product does not have. So these assert
   * relative to the state they find rather than to absolute counts.
   */
  const operational = () => seed.projectId;

  it('locks the period reviewed and opens the next, without moving the project', () => {
    const projectId = operational();
    const before = stages.stageInstances(as('pm', projectId)).filter((s) => s.phase === 'OPERATIONS').length;
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Annual assurance' });

    const decision = stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Asset Owner',
      comments: 'Assured for the year',
    });

    assert.equal(decision.from, 'OPERATIONS');
    assert.equal(decision.to, undefined, 'an assurance review must not claim a destination');
    assert.ok(decision.baselineHash, 'the period reviewed must still be frozen');

    assert.equal(
      platform.ledger.require({ refType: 'Project', refId: projectId }).state.phase,
      'OPERATIONS',
      'the project moved somewhere there is nowhere to move to',
    );

    const operations = stages.stageInstances(as('pm', projectId)).filter((s) => s.phase === 'OPERATIONS');
    assert.equal(operations.length, before + 1, 'the reviewed period should be followed by exactly one more');

    const reviewed = operations.at(-2)!;
    const next = operations.at(-1)!;
    assert.equal(reviewed.status, 'LOCKED', 'the period reviewed was not frozen');
    assert.equal(reviewed.baselineHash, decision.baselineHash);
    assert.equal(next.status, 'ACTIVE');
    assert.equal(next.predecessorId, reviewed.id, 'the new period does not name the one it follows');
  });

  it('writes no phase transition for a review that moved nothing', () => {
    // A transition in the project's history that nothing corresponds to is
    // worse than no record at all: it is a phase change somebody will later try
    // to explain.
    const projectId = operational();
    const before = (
      platform.ledger.require({ refType: 'Project', refId: projectId }).state.phaseHistory as unknown[]
    ).length;

    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Annual assurance' });
    stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED',
      authorityBasis: 'Asset Owner',
      comments: 'Assured',
    });

    const after = (
      platform.ledger.require({ refType: 'Project', refId: projectId }).state.phaseHistory as unknown[]
    ).length;
    assert.equal(after, before, 'an assurance review invented a phase transition');
  });

  it('carries assurance conditions into the next period', () => {
    const projectId = operational();
    const { gateReviewId } = stages.submitForGate(as('pm', projectId), { comments: 'Annual assurance' });

    stages.decideGate(as('owner', projectId), {
      gateReviewId,
      result: 'APPROVED_WITH_ACTIONS',
      authorityBasis: 'Asset Owner',
      comments: 'Assured subject to the fire damper survey',
      actions: [{ description: 'Complete the fire damper survey', ownerId: seed.users.fm!.id, dueDate: '2027-03-31' }],
    });

    const live = stages.currentStage(as('pm', projectId))!;
    assert.equal(live.phase, 'OPERATIONS');
    assert.ok(
      (live.openActions as Array<{ description: string }>).some((a) =>
        a.description.includes('fire damper survey'),
      ),
      'the assurance condition did not reach the next period',
    );
  });
});

// ------------------------------------------------------- the other door in

describe('the direct phase transition keeps the stage record honest', () => {
  it('maintains stage instances when a project moves without a gate decision', () => {
    // Two commands change a project's phase. If only the gate maintained stage
    // instances, a project moved through the other door would acquire a phase
    // its stage record disagreed with — fatal for a record whose purpose is to
    // be trustworthy when the project's own state is in doubt.
    const projectId = freshProject('Direct Bridge');
    defineScope(projectId);

    structure.transitionPhase(as('owner', projectId), {
      to: 'DESIGN',
      justification: 'Scope defined and funding approved at gate review',
    });

    const history = stages.stageInstances(as('pm', projectId));
    assert.equal(history.length, 2);
    assert.equal(history[1]!.phase, 'DESIGN');
    assert.equal(history[1]!.status, 'ACTIVE');
  });

  it('marks an ungated stage SUPERSEDED, never LOCKED', () => {
    // A LOCKED stage carries a frozen baseline that a gate approved. Stamping
    // one on a stage no gate reviewed would be a lie in the shape of a hash,
    // and a regression is exactly this case: it must not look like approval.
    const projectId = freshProject('Ungated Bridge');
    defineScope(projectId);
    structure.transitionPhase(as('owner', projectId), { to: 'DESIGN', justification: 'Proceeding' });

    const [concept] = stages.stageInstances(as('pm', projectId));
    assert.equal(concept!.status, 'SUPERSEDED');
    assert.equal(concept!.baselineHash, null, 'an ungated stage must not claim a frozen baseline');
    assert.ok(concept!.supersededReason, 'and it must say why it closed');
  });
});

// ------------------------------------------------------------- authorship

describe('a gate decision is never AI-authored', () => {
  it('marks every stage and gate event as human-only', () => {
    // The agent mandate ceiling is PROPOSE. An agent able to record a gate
    // decision would be an agent able to approve its own proposals, which is
    // the one thing the whole governance model exists to prevent.
    const governed = [
      'STAGE_INSTANCE_OPENED',
      'STAGE_INSTANCE_STATUS_CHANGED',
      'STAGE_INSTANCE_LOCKED',
      'GATE_REVIEW_SUBMITTED',
      'GATE_REVIEW_DECIDED',
      'STAGE_REOPENED',
    ];

    for (const code of governed) {
      const definition = EVENT_TYPES.find((e) => e.code === code);
      assert.ok(definition, `${code} is not in the event catalogue`);
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('requires evidence on every decision and every freeze', () => {
    // A decision with no evidence behind it is a claim, and the point of the
    // record is that it is not one.
    for (const code of ['STAGE_INSTANCE_LOCKED', 'GATE_REVIEW_SUBMITTED', 'GATE_REVIEW_DECIDED', 'STAGE_REOPENED']) {
      const definition = EVENT_TYPES.find((e) => e.code === code);
      assert.equal(definition?.requiresEvidence, true, `${code} must carry evidence`);
    }
  });
});
