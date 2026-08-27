import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as constructability from '../src/domain/constructability.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * D-WF-07 — constructability, temporary works and residual design risk.
 *
 * The cheapest hour on a construction project and the first one cancelled.
 * What is tested here is not that a review can be minuted; it is the two things
 * that make its output survive the meeting.
 *
 * A finding without a disposition is a sentence in a set of minutes. A residual
 * risk that stops at the designer has done two thirds of a duty — eliminate,
 * reduce, communicate — and it is always the third that fails.
 */

let platform: Platform;
let seed: SeedResult;

const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const ROOM = [
  { name: 'A. Okafor', organisation: 'Meridian Infrastructure Group', discipline: 'CONSTRUCTION' },
  { name: 'D. Whyte', organisation: 'Caldervale Engineering', discipline: 'DESIGN' },
  { name: 'M. Osei', organisation: 'Meridian Infrastructure Group', discipline: 'HSE' },
  { name: 'R. Sandhu', organisation: 'Northern Water Authority', discipline: 'OPERATIONS' },
];

function newReview(packageReference = 'PKG-CIV'): string {
  return constructability.holdReview(asPM(), {
    packageReference,
    zone: 'Inlet works',
    heldAt: day(-3),
    attendees: ROOM,
  }).reviewId;
}

const FINDING = {
  area: 'BUILDABILITY' as const,
  severity: 'MAJOR' as const,
  what: 'The wall kicker detail at grid C4 cannot be formed with the reinforcement congestion shown.',
  location: 'Clarifier No.2, grid C4',
  raisedBy: 'A. Okafor',
  disposition: 'DESIGN_CHANGE' as const,
  rationale: 'The congestion is a design condition, not a method one; no sequence resolves it without moving the bars.',
  owner: 'D. Whyte',
  by: day(14),
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── The occasion ────────────────────────────────────────────────────────────

describe('constructability · the review is the four voices, or it is a discipline meeting', () => {
  it('registers its four events against one entity', () => {
    for (const code of [
      'CONSTRUCTABILITY_REVIEWED',
      'DESIGN_RISK_UPDATED',
      'TEMPORARY_WORKS_INTERFACE_RAISED',
      'REVIEW_ACTION_CLOSED',
    ]) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'ConstructabilityReview');
      // How a designer discharged their duty is a competent person's judgement.
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('sits with design, not with safety, because its output is a design change', () => {
    assert.equal(classifyEntity('ConstructabilityReview')?.area, 'DESIGN_INFORMATION');
  });

  it('refuses a review with any of the four disciplines missing', () => {
    for (const absent of ['CONSTRUCTION', 'DESIGN', 'HSE', 'OPERATIONS']) {
      const refusal = throwsCode(
        () =>
          constructability.holdReview(asPM(), {
            packageReference: 'PKG-X',
            zone: 'z',
            heldAt: day(-1),
            attendees: ROOM.filter((attendee) => attendee.discipline !== absent),
          }),
        'DISCIPLINE_ABSENT',
        `a review with no ${absent} was accepted`,
      );
      assert.match(String(refusal.message), new RegExp(absent.toLowerCase()));
    }
  });

  it('refuses a review dated in the future', () => {
    throwsCode(
      () => constructability.holdReview(asPM(), { packageReference: 'PKG-X', zone: 'z', heldAt: day(7), attendees: ROOM }),
      'REVIEW_NOT_YET_HELD',
    );
  });
});

// ── Five outcomes, five owners ──────────────────────────────────────────────

describe('constructability · a finding becomes one of five things, with an owner', () => {
  let reviewId: string;

  before(() => {
    reviewId = newReview();
  });

  it('refuses a finding nobody owns', () => {
    throwsCode(() => constructability.recordFinding(asPM(), reviewId, { ...FINDING, owner: '  ' }), 'FINDING_UNOWNED');
  });

  it('refuses a disposition chosen with no reason', () => {
    const refusal = throwsCode(
      () => constructability.recordFinding(asPM(), reviewId, { ...FINDING, rationale: '' }),
      'DISPOSITION_UNEXPLAINED',
    );
    // The message names the disposition actually chosen rather than listing all
    // five, so the person reading it knows what they are being asked to justify.
    assert.match(String(refusal.message), /rather than one of the other four/);
  });

  it('refuses a finding with no location, which cannot be checked against a drawing', () => {
    throwsCode(() => constructability.recordFinding(asPM(), reviewId, { ...FINDING, location: '' }), 'FINDING_UNSTATED');
  });

  it('refuses to close a critical finding by accepting it', () => {
    // Accepting is a legitimate answer to something the review decided to live
    // with. A critical finding is by definition not that, and recording it as
    // accepted turns the severity into a label rather than a decision.
    const refusal = throwsCode(
      () =>
        constructability.recordFinding(asPM(), reviewId, {
          ...FINDING,
          severity: 'CRITICAL',
          disposition: 'ACCEPTED',
        }),
      'CRITICAL_NOT_ACCEPTABLE',
    );
    assert.match(String(refusal.message), /turn the severity into a label rather than a decision/);
  });

  it('records an accepted finding as decided rather than outstanding', () => {
    const accepted = constructability.recordFinding(asPM(), reviewId, {
      ...FINDING,
      area: 'TOLERANCES',
      severity: 'MINOR',
      what: 'The 5mm setting-out tolerance on the handrail standards is tighter than the trade normally works to.',
      disposition: 'ACCEPTED',
      rationale: 'Agreed to hold the tolerance; the metalwork subcontractor confirmed it is achievable off a template.',
    });
    assert.equal(accepted.blocksFreeze, false);

    const record = platform.ledger.get({ refType: 'ConstructabilityReview', refId: reviewId });
    const findings = record!.state.findings as Array<Record<string, unknown>>;
    const found = findings.find((entry) => entry.reference === accepted.reference)!;
    // The decision is the discharge. Leaving it open would fill the register
    // with things somebody already answered.
    assert.equal(found.status, 'CLOSED');
    assert.ok(found.closure);
  });

  it('refuses to close an open finding with nothing said about what resolved it', () => {
    const raised = constructability.recordFinding(asPM(), reviewId, { ...FINDING, location: 'Grid C5' });
    throwsCode(
      () => constructability.closeFinding(asPM(), reviewId, { reference: raised.reference, what: '   ' }),
      'CLOSURE_UNSTATED',
    );
    constructability.closeFinding(asPM(), reviewId, {
      reference: raised.reference,
      what: 'Bar arrangement revised at C-2110 revision D; kicker now formable in one pour.',
      linkedRef: 'DC-0004',
    });
  });
});

// ── What blocks a freeze ────────────────────────────────────────────────────

describe('constructability · safe access and testability stop a package being frozen', () => {
  let reviewId: string;

  before(() => {
    reviewId = newReview('PKG-FREEZE');
  });

  it('reports an open access finding as a freeze blocker', () => {
    const raised = constructability.recordFinding(asPM(), reviewId, {
      ...FINDING,
      area: 'ACCESS',
      severity: 'CRITICAL',
      what: 'The penstock actuator cannot be reached for its annual service without entering the wet well.',
      location: 'Inlet chamber, penstock P2',
      disposition: 'DESIGN_CHANGE',
      rationale: 'No method resolves it; the actuator has to move above the deck.',
      owner: 'D. Whyte',
    });
    assert.equal(raised.blocksFreeze, true);

    const blockers = constructability.freezeBlockersFor(asQS(), 'PKG-FREEZE');
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.area, 'ACCESS');
  });

  it('does not count an accepted finding in the same area as a blocker', () => {
    // Accepted means the review decided. A blocker list that included decisions
    // would never clear, and a list that never clears stops being read.
    constructability.recordFinding(asPM(), reviewId, {
      ...FINDING,
      area: 'TESTABILITY',
      severity: 'MINOR',
      what: 'The flow meter has no isolation for in-situ verification.',
      location: 'Gallery, FM-01',
      disposition: 'ACCEPTED',
      rationale: 'Verification is by portable clamp-on at the adjacent straight run; agreed with operations.',
    });
    assert.equal(constructability.freezeBlockersFor(asQS(), 'PKG-FREEZE').length, 1);
  });

  it('sorts blockers with the critical one first', () => {
    constructability.recordFinding(asPM(), reviewId, {
      ...FINDING,
      area: 'TESTABILITY',
      severity: 'MINOR',
      what: 'No test point on the return sludge line.',
      location: 'Gallery',
      disposition: 'RFI',
      rationale: 'The specification may already require one; asking before changing the design.',
      owner: 'S. Iqbal',
    });
    const blockers = constructability.freezeBlockersFor(asQS(), 'PKG-FREEZE');
    assert.equal(blockers[0]?.severity, 'CRITICAL');
  });

  it('clears the blocker when the finding is closed', () => {
    const blocker = constructability.freezeBlockersFor(asQS(), 'PKG-FREEZE').find((entry) => entry.severity === 'CRITICAL')!;
    constructability.closeFinding(asPM(), reviewId, {
      reference: blocker.reference,
      what: 'Actuator relocated above deck level at C-2140 revision C; the wet well entry is designed out.',
    });
    assert.equal(
      constructability.freezeBlockersFor(asQS(), 'PKG-FREEZE').some((entry) => entry.severity === 'CRITICAL'),
      false,
    );
  });
});

// ── Eliminate, reduce, communicate ──────────────────────────────────────────

describe('constructability · a residual risk that stops at the designer is two thirds of a duty', () => {
  let reviewId: string;
  let reference: string;

  before(() => {
    reviewId = newReview('PKG-RISK');
  });

  it('refuses a risk with nobody named as exposed to it', () => {
    const refusal = throwsCode(
      () =>
        constructability.recordResidualRisk(asPM(), reviewId, {
          hazard: 'Fragile roof lights over the filter gallery',
          whoIsExposed: '',
          treatment: 'REDUCED',
          what: 'Cages fitted over each light',
          shownOn: 'C-2210 rev B',
        }),
      'EXPOSURE_UNNAMED',
    );
    assert.match(String(refusal.message), /the third of the designer’s three duties/);
  });

  it('refuses a surviving risk that is on no drawing', () => {
    const refusal = throwsCode(
      () =>
        constructability.recordResidualRisk(asPM(), reviewId, {
          hazard: 'Fragile roof lights over the filter gallery',
          whoIsExposed: 'Anybody working at roof level, and the maintenance contractor',
          treatment: 'REDUCED',
          what: 'Cages fitted over each light',
          shownOn: '',
        }),
      'RISK_NOT_SHOWN',
    );
    // A hazard that survives into the works has to be findable *from* the works.
    assert.match(String(refusal.message), /findable only by somebody who already knows it exists/);
  });

  it('treats an eliminated hazard as needing no communication', () => {
    // There is nothing left to tell anybody about, and marking it outstanding
    // would fill the register with work nobody has to do.
    const eliminated = constructability.recordResidualRisk(asPM(), reviewId, {
      hazard: 'Confined space entry to the inlet chamber for screen cleaning',
      whoIsExposed: 'Operations staff, weekly',
      treatment: 'ELIMINATED',
      what: 'Screen replaced with a self-cleaning unit removable from deck level; the chamber is no longer entered.',
      shownOn: '',
    });
    assert.equal(eliminated.stillToCommunicate, false);
  });

  it('carries a surviving risk as an obligation until it reaches both places', () => {
    const risk = constructability.recordResidualRisk(asPM(), reviewId, {
      hazard: 'Fragile roof lights over the filter gallery',
      whoIsExposed: 'Anybody working at roof level, and the maintenance contractor for the life of the asset',
      treatment: 'REDUCED',
      what: 'Cages fitted over each light and the lights marked; the fragility itself cannot be designed out.',
      shownOn: 'C-2210 revision B',
    });
    reference = risk.reference;
    assert.equal(risk.stillToCommunicate, true);

    const position = constructability.constructabilityPosition(asQS());
    const outstanding = position.uncommunicated.find((entry) => entry.reference === reference);
    assert.deepEqual(outstanding?.missing, ['the pre-construction information', 'a method statement']);
  });

  it('refuses a communication with no document reference', () => {
    throwsCode(
      () =>
        constructability.communicateRisk(asPM(), reviewId, {
          reference,
          reached: 'PRE_CONSTRUCTION_INFORMATION',
          where: '',
        }),
      'REFERENCE_REQUIRED',
    );
  });

  it('is still outstanding after reaching only one of the two', () => {
    const after = constructability.communicateRisk(asPM(), reviewId, {
      reference,
      reached: 'PRE_CONSTRUCTION_INFORMATION',
      where: 'PCI revision 4, section 6.2',
    });
    assert.equal(after.stillToCommunicate, true);

    const outstanding = constructability
      .constructabilityPosition(asQS())
      .uncommunicated.find((entry) => entry.reference === reference);
    assert.deepEqual(outstanding?.missing, ['a method statement']);
  });

  it('is discharged once it has reached both', () => {
    const after = constructability.communicateRisk(asPM(), reviewId, {
      reference,
      reached: 'METHOD_STATEMENT',
      where: 'RAMS-0031, roof-level works, step 2',
    });
    assert.equal(after.stillToCommunicate, false);
    assert.equal(
      constructability.constructabilityPosition(asQS()).uncommunicated.some((entry) => entry.reference === reference),
      false,
    );
  });
});

// ── Temporary works ─────────────────────────────────────────────────────────

describe('constructability · a temporary works category is assigned by a person, never inferred', () => {
  let reviewId: string;

  const TW = {
    description: 'Sheet-piled cofferdam to the north inlet chamber, propped at two levels',
    category: '3' as const,
    assignedBy: 'J. Ellery, Temporary Works Coordinator',
    designer: 'Sable Structural Design',
    checker: 'Halden Consulting',
    permanentWorksAssumption:
      'The permanent base slab is designed for the props to be struck before backfill; the wall is not designed to be ' +
      'propped in the temporary condition.',
  };

  before(() => {
    reviewId = newReview('PKG-TW');
  });

  it('refuses a category with nobody’s name on it', () => {
    const refusal = throwsCode(
      () => constructability.raiseTemporaryWorks(asPM(), reviewId, { ...TW, assignedBy: '' }),
      'CATEGORY_UNASSIGNED',
    );
    assert.match(String(refusal.message), /a falsework scheme nobody appointed/);
  });

  it('refuses a design and check by the same party above category 0', () => {
    throwsCode(
      () => constructability.raiseTemporaryWorks(asPM(), reviewId, { ...TW, checker: TW.designer }),
      'TEMPORARY_WORKS_SELF_CHECKED',
    );
  });

  it('permits design and check by the same party at category 0, where BS 5975 does', () => {
    const raised = constructability.raiseTemporaryWorks(asPM(), reviewId, {
      ...TW,
      description: 'Trestle access to the valve chamber roof',
      category: '0',
      designer: 'Meridian site team',
      checker: 'Meridian site team',
      permanentWorksAssumption: 'Nothing is imposed on the permanent works; the trestle bears on the slab as designed.',
    });
    assert.equal(raised.needsIndependentCheck, false);
  });

  it('refuses one that does not say what the permanent works assumes about it', () => {
    const refusal = throwsCode(
      () => constructability.raiseTemporaryWorks(asPM(), reviewId, { ...TW, permanentWorksAssumption: '' }),
      'ASSUMPTION_UNSTATED',
    );
    // The assumption is the interface, and it is what gets lost when the two
    // designers are different firms.
    assert.match(String(refusal.message), /different firms/);
  });

  it('records one properly and marks it as needing an independent check', () => {
    const raised = constructability.raiseTemporaryWorks(asPM(), reviewId, TW);
    assert.equal(raised.needsIndependentCheck, true);
    const row = constructability.constructabilityPosition(asQS()).reviews.find((entry) => entry.packageReference === 'PKG-TW');
    assert.equal(row?.temporaryWorks, 2);
  });
});

// ── Reading it ──────────────────────────────────────────────────────────────

describe('constructability · the position', () => {
  it('is readable by a role holding only read on the area, and not writable by it', () => {
    const position = constructability.constructabilityPosition(asQS());
    assert.ok(position.reviews.length > 0);
    assert.match(position.summary, /review/);
    assert.throws(
      () => constructability.holdReview(asQS(), { packageReference: 'x', zone: 'z', heldAt: day(-1), attendees: ROOM }),
      /ACCESS_DENIED|No role/,
    );
  });

  it('counts a finding past its own date as overdue', () => {
    const reviewId = newReview('PKG-LATE');
    constructability.recordFinding(asPM(), reviewId, { ...FINDING, by: day(-10) });
    const row = constructability.constructabilityPosition(asQS()).reviews.find((entry) => entry.packageReference === 'PKG-LATE');
    assert.equal(row?.overdueFindings, 1);
  });
});
