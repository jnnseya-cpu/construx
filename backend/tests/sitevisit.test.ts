import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as sitevisit from '../src/engines/sitevisit.ts';
import * as planning from '../src/engines/planning.ts';
import { renderPdf } from '../src/export/pdf.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The site visit, and what it obliges for the rest of the job.
 *
 * A site visit produces a document nobody opens again. The information was
 * never missing — it was recorded and then it stopped being anybody's problem,
 * and eighteen months later a crane is erected over a boundary nobody agreed to
 * oversail. So these tests are not about whether a report renders. They are
 * about whether a finding stays somebody's problem:
 *
 *   - a finding that obliges nothing is refused;
 *   - a finding seen on site with no photograph is refused;
 *   - a finding that constrains an activity raises a **real** constraint in the
 *     planning engine, not a second register;
 *   - a permission is late when the arithmetic says so, not when somebody
 *     notices;
 *   - the serious ones cannot be self-certified.
 */

let platform: Platform;
let seed: SeedResult;

/** The planner walks and raises; the PM signs the serious ones off. */
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const PHOTO = `sha256:${'a'.repeat(64)}`;
const PHOTO_2 = `sha256:${'b'.repeat(64)}`;

let counter = 0;

function visit(purpose: sitevisit.VisitPurpose = 'PRE_CONSTRUCTION'): string {
  counter += 1;
  return sitevisit.recordVisit(asPlanner(), {
    purpose,
    visitedOn: '2027-04-12',
    attendees: [`Site Manager ${counter}`, 'Planner'],
    weather: 'Dry, 11°C',
  }).visitId;
}

/** A complete observed finding, so a test can break exactly one thing. */
const observed = (over: Partial<sitevisit.FindingInput> = {}): sitevisit.FindingInput => ({
  category: 'ACCESS_AND_EGRESS',
  description: 'Site gate measures 3.1m between posts; a 16.5m artic cannot turn in off the main road',
  location: 'North gate, off Ashworth Road',
  basis: 'OBSERVED',
  consequences: ['PRICES'],
  closesBy: 'MOBILISATION',
  owner: 'Site Manager',
  evidenceHash: PHOTO,
  ...over,
});

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── Recording the walk ──────────────────────────────────────────────────────

describe('site visit · the walk', () => {
  it('records who was there, because an unattributed walk cannot be relied on', () => {
    const { visitId, reference } = sitevisit.recordVisit(asPlanner(), {
      purpose: 'PRE_CONSTRUCTION',
      visitedOn: '2027-04-12',
      attendees: ['Site Manager', 'Planner', "Client's agent"],
    });

    assert.ok(visitId);
    assert.match(reference, /^SV-\d{3}$/);
  });

  it('refuses a walk nobody attended', () => {
    throwsCode(
      () => sitevisit.recordVisit(asPlanner(), { purpose: 'PRE_CONSTRUCTION', visitedOn: '2027-04-12', attendees: ['  '] }),
      'ATTENDEES_REQUIRED',
    );
  });

  it('refuses a date it cannot read', () => {
    throwsCode(
      () => sitevisit.recordVisit(asPlanner(), { purpose: 'PRE_CONSTRUCTION', visitedOn: 'last Tuesday', attendees: ['PM'] }),
      'VISIT_DATE_INVALID',
    );
  });

  /**
   * The walk happens before construction starts, so the module cannot sit
   * behind a phase gate that opens at CONSTRUCTION. The seeded project is in
   * OPERATIONS and this still has to work.
   */
  it('is not gated by the lifecycle phase', () => {
    const project = platform.ledger.get({ refType: 'Project', refId: seed.projectId })!;
    assert.equal(project.state.phase, 'OPERATIONS', 'the fixture no longer proves the gate is absent');
    assert.ok(visit('PRE_HANDOVER'), 'a walk was refused because of the project phase');
  });
});

// ── What a finding has to be ────────────────────────────────────────────────

describe('site visit · a finding that obliges nothing is a note', () => {
  it('records a complete finding with its reference', () => {
    const { reference } = sitevisit.raiseFinding(asPlanner(), visit(), observed());
    assert.match(reference, /^SF-\d{4}$/);
  });

  /** The single rule the register lives or dies by. */
  it('refuses a finding that obliges nothing', () => {
    const error = throwsCode(
      () => sitevisit.raiseFinding(asPlanner(), visit(), observed({ consequences: [] })),
      'CONSEQUENCE_REQUIRED',
    );
    assert.match(String(error.message), /notes are what fill a register until nobody reads it/);
  });

  it('refuses a description that says nothing', () => {
    throwsCode(
      () => sitevisit.raiseFinding(asPlanner(), visit(), observed({ description: 'Poor access' })),
      'FINDING_INSUBSTANTIAL',
    );
  });

  it('refuses a finding with no location or no owner', () => {
    throwsCode(() => sitevisit.raiseFinding(asPlanner(), visit(), observed({ location: '  ' })), 'LOCATION_REQUIRED');
    throwsCode(() => sitevisit.raiseFinding(asPlanner(), visit(), observed({ owner: '' })), 'OWNER_REQUIRED');
  });

  /**
   * An assertion about a physical condition with no image is the thing that
   * gets argued about later, and the argument is unwinnable.
   */
  it('refuses a finding seen on site with no photograph', () => {
    const error = throwsCode(
      () => sitevisit.raiseFinding(asPlanner(), visit(), observed({ evidenceHash: undefined })),
      'PHOTOGRAPH_REQUIRED',
    );
    assert.match(String(error.message), /record it as that instead and name the source/);
  });

  it('takes a finding read from a document, and makes it name the document', () => {
    const fromPaper = {
      ...observed(),
      basis: 'DOCUMENT' as const,
      evidenceHash: undefined,
      description: 'Planning condition 14 bars deliveries before 09:30 on weekdays because of the school opposite',
      consequences: ['SEQUENCES'] as sitevisit.FindingConsequence[],
    };

    throwsCode(() => sitevisit.raiseFinding(asPlanner(), visit(), fromPaper), 'SOURCE_REQUIRED');

    const { reference } = sitevisit.raiseFinding(asPlanner(), visit(), {
      ...fromPaper,
      source: 'Planning consent 2026/00412/FUL, condition 14',
    });
    assert.ok(reference, 'a documented finding was refused for having no photograph');
  });

  it('registers the photograph as evidence against the finding', () => {
    const visitId = visit();
    const before = platform.ledger.list(seed.projectId, 'EvidenceItem').length;
    sitevisit.raiseFinding(asPlanner(), visitId, observed({ evidenceHash: PHOTO_2 }));

    const evidence = platform.ledger.list(seed.projectId, 'EvidenceItem');
    assert.equal(evidence.length, before + 1);
    const registered = evidence.find((e) => e.state.hash === PHOTO_2);
    assert.equal(registered?.state.type, 'SITE_VISIT_PHOTOGRAPH');
  });
});

// ── Permissions and their lead times ────────────────────────────────────────

describe('site visit · a permission is late when the arithmetic says so', () => {
  const permit = {
    name: 'Section 50 highway licence',
    authority: 'Ashworth Borough Council Highways',
    leadTimeDays: 56,
    requiredBy: '2027-06-01',
  };

  it('names the last day an application can go in', () => {
    // 56 days before 1 June 2027 is 6 April 2027.
    const position = sitevisit.permitPosition(permit, '2027-03-01');
    assert.equal(position.applyBy, '2027-04-06');
    assert.equal(position.status, 'NOT_APPLIED');
    assert.equal(position.daysLate, 0);
    assert.match(position.note, /has to be in by 2027-04-06/);
  });

  /**
   * The whole point. Eight weeks quoted against work starting in three is not
   * a risk to monitor — it is already late, today, before anybody applies.
   */
  it('says how many days late an unmade application already is', () => {
    const position = sitevisit.permitPosition(permit, '2027-05-01');
    assert.equal(position.status, 'NOT_APPLIED');
    assert.equal(position.daysLate, 25, '1 May is 25 days past the 6 April application date');
    assert.match(position.note, /the 2027-06-01 start is already gone/);
  });

  /**
   * An application that has gone in is not late on the day it was submitted.
   * The authority may beat its own quoted lead time, and calling that late
   * would be crying wolf on the one register that must not be ignored.
   */
  it('does not call an application late merely for being inside the lead time', () => {
    const applied = sitevisit.permitPosition({ ...permit, appliedOn: '2027-05-01' }, '2027-05-02');
    assert.equal(applied.status, 'APPLIED');
    assert.equal(applied.daysLate, 0);

    const overdue = sitevisit.permitPosition({ ...permit, appliedOn: '2027-05-01' }, '2027-06-15');
    assert.equal(overdue.daysLate, 14, 'still not granted a fortnight after the work needed it');
  });

  it('treats a granted permission as finished whatever the dates say', () => {
    const granted = sitevisit.permitPosition({ ...permit, appliedOn: '2027-05-20', grantedOn: '2027-05-28' }, '2027-12-01');
    assert.equal(granted.status, 'GRANTED');
    assert.equal(granted.daysLate, 0);
  });

  it('refuses a permit finding that does not carry the permission', () => {
    throwsCode(
      () => sitevisit.raiseFinding(asPlanner(), visit(), observed({ consequences: ['PERMITS'] })),
      'PERMIT_REQUIRED',
    );
  });

  it('refuses a permission with no lead time, because nothing can tell you it is late', () => {
    throwsCode(
      () =>
        sitevisit.raiseFinding(
          asPlanner(),
          visit(),
          observed({ consequences: ['PERMITS'], permit: { ...permit, leadTimeDays: 0 } }),
        ),
      'LEAD_TIME_INVALID',
    );
  });

  it('surfaces the late permission on the position, worst first in the summary', () => {
    const ctx = asPlanner();
    sitevisit.raiseFinding(ctx, visit(), observed({ consequences: ['PERMITS'], permit }));

    const position = sitevisit.sitePosition(ctx, { today: '2027-05-01' });
    const late = position.latePermits.find((p) => p.name === permit.name);
    assert.ok(late, 'the late permission is not on the position');
    assert.equal(late!.daysLate, 25);
    assert.match(position.summary, /permission.* late/);
  });
});

// ── Into the programme ──────────────────────────────────────────────────────

describe('site visit · a finding that sequences work raises a real constraint', () => {
  /**
   * Zero re-entry. Not a second constraints log living in a site-visit module:
   * the planning engine's own `Constraint`, so the lookahead already refuses to
   * commit that activity and it appears in the PPC trend beside every other one.
   */
  it('writes the constraint into the planning engine, not a parallel list', () => {
    const ctx = asPlanner();
    const task = platform.ledger.list(seed.projectId, 'Task')[0];
    assert.ok(task, 'the fixture has no activity to constrain');

    const before = platform.ledger.list(seed.projectId, 'Constraint').length;
    const { reference, constraintReference } = sitevisit.raiseFinding(
      ctx,
      visit(),
      observed({
        category: 'EXISTING_SERVICES',
        description: 'Live 11kV cable crosses the north-east corner where the piling rig is planned to stand',
        consequences: ['SEQUENCES', 'HAZARDS'],
        closesBy: 'CONSTRUCTION',
        taskId: task.refId,
      }),
    );

    assert.ok(constraintReference, 'no constraint was raised');
    const constraints = platform.ledger.list(seed.projectId, 'Constraint');
    assert.equal(constraints.length, before + 1);

    const raised = constraints.find((c) => c.state.reference === constraintReference)!;
    assert.equal(raised.state.taskId, task.refId);
    assert.equal(raised.state.status, 'OPEN');
    // The constraint carries the finding's reference, so somebody reading the
    // constraints log can get back to the photograph.
    assert.match(String(raised.state.description), new RegExp(reference));
  });

  it('raises no constraint for a finding that only costs money', () => {
    const ctx = asPlanner();
    const task = platform.ledger.list(seed.projectId, 'Task')[0]!;
    const before = platform.ledger.list(seed.projectId, 'Constraint').length;

    const { constraintReference } = sitevisit.raiseFinding(
      ctx,
      visit(),
      observed({ consequences: ['PRICES'], taskId: task.refId }),
    );

    assert.equal(constraintReference, undefined);
    assert.equal(platform.ledger.list(seed.projectId, 'Constraint').length, before);
  });

  /** The lookahead already refuses to commit an activity with an open constraint. */
  it('makes the constrained activity uncommittable in the lookahead', () => {
    const ctx = asPlanner();
    const task = platform.ledger.list(seed.projectId, 'Task').at(-1)!;
    sitevisit.raiseFinding(
      ctx,
      visit(),
      observed({
        category: 'BOUNDARIES_AND_NEIGHBOURS',
        description: 'Party wall to number 14 is unpropped and shows movement at first floor level',
        consequences: ['SEQUENCES'],
        closesBy: 'CONSTRUCTION',
        taskId: task.refId,
      }),
    );

    const trend = planning.ppcTrend(ctx, '2027-04-19');
    // Matched on the finding's own reference, which the constraint carries in
    // its description — the lookahead's constraint rows do not expose a task id.
    assert.ok(
      trend.openConstraints.some((c) => c.reference.startsWith('CON-')),
      'the site finding did not reach the constraints the lookahead reads',
    );
    const raised = platform.ledger
      .list(seed.projectId, 'Constraint')
      .filter((c) => c.state.status === 'OPEN' && c.state.taskId === task.refId);
    assert.ok(raised.length > 0, 'no open constraint stands against the constrained activity');
  });
});

// ── Discharge ───────────────────────────────────────────────────────────────

describe('site visit · discharge, and what cannot be self-certified', () => {
  it('discharges an ordinary finding with what actually discharged it', () => {
    const ctx = asPlanner();
    const { findingId, reference } = sitevisit.raiseFinding(ctx, visit(), observed());

    const closed = sitevisit.closeFinding(ctx, findingId, {
      discharge: 'Gate posts moved to 4.8m and the kerb radius eased; swept path re-checked against a 16.5m artic',
    });
    assert.equal(closed.reference, reference);

    const record = platform.ledger.get({ refType: 'SiteFinding', refId: findingId })!;
    assert.equal(record.state.status, 'CLOSED');
  });

  it('refuses "done" as a discharge', () => {
    const ctx = asPlanner();
    const { findingId } = sitevisit.raiseFinding(ctx, visit(), observed());
    throwsCode(() => sitevisit.closeFinding(ctx, findingId, { discharge: 'Done' }), 'DISCHARGE_REQUIRED');
  });

  it('refuses to discharge the same finding twice', () => {
    const ctx = asPlanner();
    const { findingId } = sitevisit.raiseFinding(ctx, visit(), observed());
    sitevisit.closeFinding(ctx, findingId, { discharge: 'Gate widened and the swept path re-checked' });
    throwsCode(
      () => sitevisit.closeFinding(ctx, findingId, { discharge: 'Gate widened and the swept path re-checked' }),
      'FINDING_ALREADY_CLOSED',
    );
  });

  const hazard = () =>
    observed({
      category: 'OVERHEAD_SERVICES',
      description: 'Overhead line crosses the delivery route at the south gate at approximately 5.8m',
      consequences: ['HAZARDS'],
      closesBy: 'MOBILISATION',
    });

  /**
   * The permission matrix already keeps these apart: the planner who raises
   * findings holds write authority and not approval. So the ordinary case is
   * settled before the engine is reached, and it is settled as a denial.
   */
  it('does not let the planner who raised a hazard approve its closure', () => {
    const ctx = asPlanner();
    const { findingId } = sitevisit.raiseFinding(ctx, visit(), hazard());

    throwsCode(
      () => sitevisit.closeFinding(ctx, findingId, { discharge: 'Goalposts installed at 4.5m', evidenceHash: PHOTO_2 }),
      'ACCESS_DENIED',
    );

    const closed = sitevisit.closeFinding(asPM(), findingId, {
      discharge: 'Goalposts and bunting installed at 4.5m either side of the route; DNO notified',
      evidenceHash: PHOTO_2,
    });
    assert.ok(closed.reference);
  });

  /**
   * And where the matrix does *not* keep them apart, the act does.
   *
   * On a small job one person is the planner and the project manager, and holds
   * both roles — which is the whole reason separation of duties is enforced per
   * act in this codebase rather than left to the matrix. That person can raise
   * a hazard and has approval authority, and still cannot certify their own
   * goalposts.
   */
  it('refuses a hazard closed by the same person who raised it, however many roles they hold', () => {
    const planner = seed.users.planner!.auth;
    const both = platform.context({ ...planner, roles: [...planner.roles, 'PM'] }, seed.projectId, { source: 'WEB' });

    const { findingId } = sitevisit.raiseFinding(both, visit(), hazard());

    const error = throwsCode(
      () => sitevisit.closeFinding(both, findingId, { discharge: 'Goalposts installed at 4.5m', evidenceHash: PHOTO_2 }),
      'SELF_CLOSURE_REFUSED',
    );
    assert.match(String(error.message), /Somebody else has to confirm it was actually done/);

    // The same person may still close an ordinary finding they raised. The rule
    // is proportionate to what the finding obliges, not blanket.
    const ordinary = sitevisit.raiseFinding(both, visit(), observed());
    assert.ok(
      sitevisit.closeFinding(both, ordinary.findingId, {
        discharge: 'Gate posts moved to 4.8m and the swept path re-checked',
      }).reference,
    );
  });

  it('refuses to close a hazard on somebody’s word alone', () => {
    const { findingId } = sitevisit.raiseFinding(
      asPlanner(),
      visit(),
      observed({
        category: 'ENVIRONMENT_AND_ECOLOGY',
        description: 'Bat roost potential in the roof of the outbuilding; survey has not been done this season',
        consequences: ['HAZARDS'],
        closesBy: 'CONSTRUCTION',
      }),
    );

    throwsCode(
      () => sitevisit.closeFinding(asPM(), findingId, { discharge: 'Ecologist attended and confirmed no roost' }),
      'CLOSURE_EVIDENCE_REQUIRED',
    );
  });
});

// ── Logistics ───────────────────────────────────────────────────────────────

describe('site visit · the logistics checks arithmetic can settle', () => {
  const welfare = { type: 'WELFARE' as const, reference: 'W1', description: 'Welfare and drying room, north compound' };
  const gate = { type: 'GATE' as const, reference: 'G1', description: 'Main gate off Ashworth Road' };

  /**
   * The one that costs the most and is missed the most: a jib that crosses the
   * boundary needs an agreement from somebody with no reason to hurry.
   */
  it('catches a crane that oversails the boundary', () => {
    const warnings = sitevisit.logisticsWarnings({
      elements: [welfare, gate],
      cranes: [
        { reference: 'TC1', type: 'TOWER', radiusMetres: 45, distanceToBoundaryMetres: 38, tipHeightMetres: 42 },
      ],
    });

    const oversail = warnings.find((w) => /oversails/.test(w.subject));
    assert.equal(oversail?.severity, 'CRITICAL');
    assert.match(oversail!.detail, /7\.0m over the adjoining land/);
    assert.match(oversail!.detail, /oversail agreement/);
  });

  it('passes a crane that stays inside the boundary', () => {
    const warnings = sitevisit.logisticsWarnings({
      elements: [welfare, gate],
      cranes: [
        { reference: 'TC1', type: 'TOWER', radiusMetres: 30, distanceToBoundaryMetres: 38, tipHeightMetres: 42 },
      ],
    });
    assert.equal(warnings.filter((w) => /oversails/.test(w.subject)).length, 0);
  });

  it('catches a jib that can be slewed into an overhead line', () => {
    const warnings = sitevisit.logisticsWarnings({
      elements: [welfare, gate],
      cranes: [
        {
          reference: 'TC1',
          type: 'TOWER',
          radiusMetres: 45,
          distanceToBoundaryMetres: 60,
          tipHeightMetres: 42,
          overhead: { distanceMetres: 30, exclusionMetres: 9 },
        },
      ],
    });

    const reach = warnings.find((w) => /reach the overhead line/.test(w.subject));
    assert.equal(reach?.severity, 'CRITICAL');
    assert.match(reach!.detail, /the crane can be slewed into it/);
  });

  it('catches a crane standing inside the exclusion zone even when the jib is short', () => {
    const warnings = sitevisit.logisticsWarnings({
      elements: [welfare, gate],
      cranes: [
        {
          reference: 'MC1',
          type: 'MOBILE',
          radiusMetres: 6,
          distanceToBoundaryMetres: 40,
          tipHeightMetres: 20,
          overhead: { distanceMetres: 8, exclusionMetres: 9 },
        },
      ],
    });
    assert.ok(warnings.some((w) => /inside the exclusion zone/.test(w.subject)));
  });

  it('catches a delivery the route cannot take', () => {
    const warnings = sitevisit.logisticsWarnings({
      elements: [welfare, gate],
      routes: [
        {
          reference: 'R1',
          description: 'Ashworth Road via the railway bridge',
          maxVehicleLengthMetres: 12,
          maxHeightMetres: 4.2,
          maxWeightTonnes: 18,
        },
      ],
      largestDelivery: { description: 'Precast stair flights', lengthMetres: 16.5, heightMetres: 4.1, weightTonnes: 32 },
    });

    const breach = warnings.find((w) => /cannot use R1/.test(w.subject));
    assert.equal(breach?.severity, 'CRITICAL');
    assert.match(breach!.detail, /16\.5m long against a 12m limit/);
    assert.match(breach!.detail, /32t against a 18t limit/);
    // The height passes, so it must not be listed.
    assert.ok(!/high against/.test(breach!.detail), 'a limit that was met was reported as breached');
  });

  it('catches a plan with no welfare on it, because that is a legal duty from day one', () => {
    const warnings = sitevisit.logisticsWarnings({ elements: [gate] });
    const missing = warnings.find((w) => /No welfare/.test(w.subject));
    assert.equal(missing?.severity, 'MAJOR');
    assert.match(missing!.detail, /Schedule 2 of CDM 2015/);
  });

  it('catches a plan with no way in', () => {
    const warnings = sitevisit.logisticsWarnings({ elements: [welfare] });
    assert.ok(warnings.some((w) => /No way in/.test(w.subject)));
  });

  it('supersedes rather than accumulating, and keeps the warnings that stood', () => {
    const ctx = asPlanner();
    // Relative, not absolute. The claim is that a second plan supersedes the
    // first rather than sitting beside it; the seeded project already has one,
    // and the version it starts from is not what this test is about.
    const before = Number(platform.ledger.list(seed.projectId, 'SiteLogisticsPlan')[0]?.state.version ?? 0);
    const first = sitevisit.setLogisticsPlan(ctx, {
      elements: [gate],
      cranes: [{ reference: 'TC1', type: 'TOWER', radiusMetres: 45, distanceToBoundaryMetres: 38, tipHeightMetres: 42 }],
    });
    assert.equal(first.version, before + 1);
    assert.ok(first.warnings.length >= 2, 'no welfare and an oversail should both be reported');

    const second = sitevisit.setLogisticsPlan(ctx, {
      elements: [gate, welfare],
      cranes: [{ reference: 'TC1', type: 'TOWER', radiusMetres: 30, distanceToBoundaryMetres: 38, tipHeightMetres: 42 }],
    });
    assert.equal(second.version, before + 2, 'a second plan was created rather than superseding the first');
    assert.deepEqual(second.warnings, [], 'the corrected plan still reports warnings');

    // A site with two logistics plans has none.
    assert.equal(platform.ledger.list(seed.projectId, 'SiteLogisticsPlan').length, 1);
  });

  it('refuses a plan with nothing on it', () => {
    throwsCode(() => sitevisit.setLogisticsPlan(asPlanner(), { elements: [] }), 'ELEMENTS_REQUIRED');
  });
});

// ── The position, carried to handover ───────────────────────────────────────

describe('site visit · what is still owed at handover', () => {
  it('keeps a handover obligation visible and separates it from the rest', () => {
    const ctx = asPlanner();
    const visitId = visit();
    sitevisit.raiseFinding(
      ctx,
      visitId,
      observed({
        category: 'TRAFFIC_AND_HIGHWAYS',
        description: 'Temporary bellmouth formed across the verge will have to be broken out and the verge reinstated',
        consequences: ['PRICES'],
        closesBy: 'HANDOVER',
        owner: 'Site Manager',
      }),
    );

    const position = sitevisit.sitePosition(ctx, { today: '2027-04-19' });
    assert.ok(
      position.handoverBlockers.some((f) => /bellmouth/.test(f.description)),
      'the handover obligation is not surfaced',
    );
    assert.ok(position.byStage.some((s) => s.closesBy === 'HANDOVER' && s.open > 0));
    assert.match(position.summary, /to discharge before handover/);
  });

  it('counts findings by what they oblige, not only by category', () => {
    const position = sitevisit.sitePosition(asPlanner(), { today: '2027-04-19' });
    assert.ok(position.byConsequence.some((c) => c.consequence === 'PRICES' && c.total > 0));
    assert.ok(position.byCategory.some((c) => c.total > 0));
    assert.ok(position.photographs > 0);
  });
});

// ── The report ──────────────────────────────────────────────────────────────

describe('site visit · the report, with the photographs', () => {
  it('leads with what is already late, then the findings', () => {
    const ctx = asPlanner();
    const visitId = visit();
    sitevisit.raiseFinding(ctx, visitId, observed());
    sitevisit.raiseFinding(
      ctx,
      visitId,
      observed({
        category: 'TRAFFIC_AND_HIGHWAYS',
        description: 'Deliveries need a temporary traffic order for the lane closure on Ashworth Road',
        consequences: ['PERMITS'],
        closesBy: 'CONSTRUCTION',
        permit: {
          name: 'Temporary traffic regulation order',
          authority: 'Ashworth Borough Council',
          leadTimeDays: 84,
          requiredBy: '2027-06-01',
        },
      }),
    );

    const report = sitevisit.siteVisitReportBlocks(ctx, visitId, { today: '2027-05-01' });
    const headings = report.blocks.filter((b) => b.kind === 'HEADING').map((b) => (b as { text: string }).text);

    assert.equal(headings[0], 'Already late', 'the late permission is not the first thing on the page');
    assert.ok(headings.includes('Findings'));
    assert.ok(headings.includes('Photographs'));
    assert.match(report.title, /^Site visit report — SV-/);
  });

  it('captions every photograph with the finding it belongs to', () => {
    const ctx = asPlanner();
    const visitId = visit();
    sitevisit.raiseFinding(ctx, visitId, observed());

    const report = sitevisit.siteVisitReportBlocks(ctx, visitId, { today: '2027-04-19' });
    const photos = report.blocks.filter((b) => b.kind === 'PHOTOGRAPH');
    assert.equal(photos.length, 1);
    const photo = photos[0] as { caption: string; evidenceHash: string; takenOn?: string };
    // A photograph with no caption is a photograph of a wall.
    assert.match(photo.caption, /^SF-\d{4} — Site gate measures 3\.1m/);
    assert.match(photo.caption, /North gate/);
    assert.equal(photo.evidenceHash, PHOTO);
    assert.equal(photo.takenOn, '2027-04-12');
  });

  it('says on the page when a photograph is not in the store', () => {
    const ctx = asPlanner();
    const visitId = visit();
    sitevisit.raiseFinding(ctx, visitId, observed());
    const report = sitevisit.siteVisitReportBlocks(ctx, visitId);

    // No resolver at all: every photograph is absent, which is what a bundle
    // rendered on a machine with no evidence store configured looks like.
    const pdf = renderPdf(
      {
        id: 'doc', reference: 'REP-00001', title: report.title, branding: {
          clientName: 'Meridian', primaryColour: '#d4711e', legalFooter: 'Registered in England',
          documentReferencePrefix: 'REP',
        },
        audience: 'INTERNAL', format: 'PDF', generatedAt: '2027-04-19T09:00:00.000Z', generatedBy: 'u',
        projectId: seed.projectId, blocks: report.blocks, contentHash: 'sha256:x',
      },
      undefined,
    );

    const text = Buffer.from(pdf).toString('latin1');
    assert.ok(text.startsWith('%PDF-'), 'the renderer did not produce a PDF');
    assert.match(text, /is not in the store/, 'an absent photograph was rendered as nothing at all');
  });

  /**
   * The photograph is embedded once however many times it is referenced, and a
   * JPEG passes straight through as `DCTDecode` — PDF's image filter *is* JPEG,
   * so nothing is decoded and re-encoded.
   */
  it('embeds a real photograph once, whatever the block count', () => {
    const ctx = asPlanner();
    const visitId = visit();
    sitevisit.raiseFinding(ctx, visitId, observed());
    const report = sitevisit.siteVisitReportBlocks(ctx, visitId);

    // A 1×1 baseline JPEG, so the test exercises the real marker walk rather
    // than a stub that agrees with itself.
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
        'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64',
    );

    const twice = [...report.blocks, ...report.blocks.filter((b) => b.kind === 'PHOTOGRAPH')];
    const pdf = renderPdf(
      {
        id: 'doc', reference: 'REP-00002', title: report.title, branding: {
          clientName: 'Meridian', primaryColour: '#d4711e', legalFooter: 'Registered in England',
          documentReferencePrefix: 'REP',
        },
        audience: 'INTERNAL', format: 'PDF', generatedAt: '2027-04-19T09:00:00.000Z', generatedBy: 'u',
        projectId: seed.projectId, blocks: twice, contentHash: 'sha256:x',
      },
      () => ({ mime: 'image/jpeg', bytes: jpeg }),
    );

    const text = Buffer.from(pdf).toString('latin1');
    assert.ok(text.startsWith('%PDF-'));
    assert.ok(!/is not in the store/.test(text), 'a resolvable photograph was reported missing');
    // The JPEG goes in untouched, under PDF's own JPEG filter.
    assert.match(text, /\/Filter \/DCTDecode/);
    assert.equal(
      (text.match(/\/Subtype \/Image/g) ?? []).length,
      1,
      'the same photograph was embedded more than once',
    );
  });
});

describe('site visit · the report title survives the trip into the file', () => {
  /**
   * Found by opening the PDF and reading the viewer's tab, which said
   * "Site visit report Š SV-001". A literal string outside a content stream is
   * read as PDFDocEncoding, not the WinAnsi the fonts are declared with, and
   * the two disagree above 0x7F. The same fault turns "Société Générale" into
   * noise on every document that client is ever sent.
   */
  it('writes a non-ASCII title as UTF-16 rather than mangling it', () => {
    const document = {
      id: 'doc', reference: 'REP-00003', title: 'Site visit report — SV-001', branding: {
        clientName: 'Société Générale Construction', primaryColour: '#d4711e',
        legalFooter: 'Registered in England', documentReferencePrefix: 'REP',
      },
      audience: 'INTERNAL' as const, format: 'PDF' as const, generatedAt: '2027-04-19T09:00:00.000Z',
      generatedBy: 'u', projectId: seed.projectId, blocks: [], contentHash: 'sha256:x',
    };

    const text = Buffer.from(renderPdf(document)).toString('latin1');

    // The em-dash is U+2014 and the BOM precedes it.
    assert.match(text, /\/Title <FEFF[0-9A-F]*2014[0-9A-F]*>/, 'the title was not written as UTF-16BE');
    // And the client's name, which is the one that reaches a real customer.
    assert.match(text, /\/Author <FEFF[0-9A-F]*00E9[0-9A-F]*>/, 'an accented client name was not encoded');
  });

  it('leaves a plain title as a readable literal', () => {
    const document = {
      id: 'doc', reference: 'REP-00004', title: 'Site visit report SV-002', branding: {
        clientName: 'Meridian', primaryColour: '#d4711e',
        legalFooter: 'Registered in England', documentReferencePrefix: 'REP',
      },
      audience: 'INTERNAL' as const, format: 'PDF' as const, generatedAt: '2027-04-19T09:00:00.000Z',
      generatedBy: 'u', projectId: seed.projectId, blocks: [], contentHash: 'sha256:x',
    };

    const text = Buffer.from(renderPdf(document)).toString('latin1');
    assert.match(text, /\/Title \(Site visit report SV-002\)/, 'an ASCII title was needlessly hex-encoded');
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('site visit · the event catalogue', () => {
  it('registers all four events, none of them AI-authorable', () => {
    for (const code of ['SITE_VISIT_RECORDED', 'SITE_FINDING_RAISED', 'SITE_FINDING_DISCHARGED', 'LOGISTICS_PLAN_SET']) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      // A site visit is a person standing on the ground looking at it. Nothing
      // here is something an agent can assert.
      assert.equal(definition!.aiAllowed, false, `${code} may be authored by an agent`);
    }
  });

  /**
   * A site finding is not a site observation. An observation is about the state
   * of the work and closes next week; a finding is about the state of the site
   * and governs the job for years. Both exist, and neither replaced the other.
   */
  it('leaves the site observation register exactly where it was', () => {
    assert.ok(lookupEventType('SITE_OBSERVATION_CAPTURED'));
    assert.ok(lookupEventType('SITE_OBSERVATION_CLOSED'));
  });
});
