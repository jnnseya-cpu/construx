import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import * as control from '../src/domain/control.ts';
import * as planning from '../src/engines/planning.ts';

/**
 * The site record on the project that is actually on site.
 *
 * Rossendale reached CONSTRUCTION carrying a contract, a drawing, a frozen
 * estimate and four phase transitions — 31 events, and nothing operational.
 * Every construction screen then reported that truth: Programme "0 activities,
 * 0 logic links", Field "64 of 64 working days have no diary", Risk "£0 across
 * 0 open risks", Project Control 13.0% with 20 gaps. All correct, and the whole
 * console read as unbuilt rather than as unstarted.
 *
 * This pins the record that fixed it. Not the exact figures — those move the
 * moment somebody adds a diary entry, and a test that pins them is a test that
 * has to be edited every time the estate improves. What it pins is that the
 * record *exists and computes*: a programme with logic in it, both baselines
 * approved, a safety file that satisfies its own gate, and derived positions
 * that come back as numbers rather than as "no data".
 *
 * Written because the empty version was deliberate and defended in a comment,
 * and nothing failed when it stopped being right.
 */

let platform: Platform;
let seed: SeedResult;
let projectId: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  const site = seed.workingProjects.find((project) => project.name === 'Rossendale Trunk Main Diversion');
  assert.ok(site, 'the project that is on site is no longer in the demonstration estate');
  assert.equal(site.phase, 'CONSTRUCTION');
  projectId = site.projectId;
});

/** How many records of a type the project holds, by the events that wrote them. */
function entities(refType: string): number {
  return new Set(
    platform.ledger
      .events({ projectId })
      .filter((event) => event.entity.refType === refType)
      .map((event) => event.entity.refId),
  ).size;
}

describe('the project on site carries a delivery record', () => {
  it('holds a programme with logic in it, not a list of activities', () => {
    assert.ok(entities('Task') >= 10, `only ${entities('Task')} activities`);
    // The logic is the half that makes a critical path mean anything. A
    // programme of unlinked bars computes a duration and tells nobody which
    // work is driving it.
    assert.ok(entities('Dependency') >= 10, `only ${entities('Dependency')} links`);
  });

  it('has both baselines approved, which are the two gates that were blocking it', () => {
    assert.ok(entities('ProgrammeBaseline') >= 1, 'no programme baseline — delay cannot be measured against anything');
    assert.ok(entities('Budget') >= 1, 'no cost baseline — the cost report reports against nothing');
  });

  it('has a safety file that satisfies its own gate rather than existing', () => {
    // The CDM engine refuses to approve a plan with a required section
    // unfilled, so an approved plan on the ledger is evidence all twelve were
    // written. This seed was refused the first time for exactly that reason.
    assert.ok(entities('CDMDocument') >= 1, 'no Construction Phase Plan');
    assert.ok(entities('RAMS') >= 1, 'no method statement');
    assert.ok(entities('Induction') >= 5, 'nobody inducted, so nobody was told the site rules');
    assert.ok(entities('Competency') >= 1, 'no qualification recorded for a permit to check against');
  });

  it('keeps the contemporaneous record a delay claim stands on', () => {
    assert.ok(entities('SiteDiary') >= 10, `only ${entities('SiteDiary')} diary days`);
    assert.ok(entities('ProgressMeasurement') >= 3, 'progress nobody measured is an assertion');
  });

  it('has quality, commercial and design records rather than empty registers', () => {
    assert.ok(entities('InspectionPlan') >= 1, 'nothing states what is inspected or against what');
    assert.ok(entities('QualityInspection') >= 2, 'the ITP was never inspected against');
    assert.ok(entities('NCR') >= 1, 'the failed inspection raised no non-conformance');
    assert.ok(entities('HoldPointRelease') >= 1, 'a hold point was passed but never released');
    assert.ok(entities('RFI') >= 1, 'no question was ever asked of the designer');
    assert.ok(entities('RiskRegisterItem') >= 3, 'contingency with no register behind it is a number somebody liked');
    assert.ok(entities('ActualCost') >= 2, 'no cost has been posted against the baseline');
    assert.ok(entities('EarnedValueSnapshot') >= 1, 'no earned value snapshot');
  });

  it('leaves the constrained work unpromised, which is what a constraint log is for', () => {
    // The platform refuses a commitment against constrained work with
    // COMMITMENT_CONSTRAINED. The second half of the trench is held by an open
    // information constraint, so it appears in the lookahead and carries no
    // promise — rather than being promised and missed every week while the PPC
    // records somebody else's failure.
    assert.ok(entities('LookaheadPlan') >= 3, 'fewer than three weeks — PPC has no trend');
    assert.ok(entities('Constraint') >= 2, 'nothing is recorded as holding the work up');
  });

  it('computes a position rather than reporting no data', () => {
    const ctx = platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' });

    const position = control.projectControl(ctx);
    assert.ok(position.stages.length > 0, 'the control standard assessed nothing');
    // The figure itself will move. That it is a number, and that there are far
    // fewer gaps than the twenty the empty project reported, is the claim.
    assert.equal(typeof position.completenessPercent, 'number');
    assert.ok(
      position.gaps.length < 15,
      `${position.gaps.length} gaps — no better than the empty project's twenty`,
    );
    assert.deepEqual(position.blockingGaps, [], `still blocked at the gate by ${position.blockingGaps.join(', ')}`);

    // The programme computes rather than refusing for want of activities. A
    // duration and a P80 out of the same call is the pair the whole
    // completion forecast is built on.
    const programme = planning.recalculateProgramme(ctx, { contractualDurationDays: 557 });
    assert.ok(programme.projectDurationDays > 0, 'the programme computed no duration');
    assert.ok(programme.criticalPath.length > 0, 'no activity is on the critical path');
    assert.ok(programme.p80DurationDays >= programme.projectDurationDays, 'P80 is shorter than the deterministic duration');
  });
});
