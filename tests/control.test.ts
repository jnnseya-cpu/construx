import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import * as control from '../src/domain/control.ts';
import * as structure from '../src/domain/structure.ts';
import {
  CONTROL_ITEMS,
  CONTROL_STAGES,
  controlItem,
  evaluateControl,
  type ControlStage,
} from '../src/lifecycle/control.ts';
import { LIFECYCLE_ORDER, PHASE_GATES } from '../src/lifecycle/phases.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The corporate project control standard, and the memory it produces.
 *
 * The standard is only worth having if it tells the truth, and the way a
 * checklist lies is by reporting an item as satisfied when the platform has no
 * way to know. So the sharpest tests here are about the three statuses that are
 * not "present": an item the platform cannot evidence, an item not yet due, and
 * an item genuinely missing. Confusing any two of those makes the completeness
 * figure meaningless.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const pmCtx = (projectId = seed.projectId) =>
  platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' });

/** A lookup that returns nothing, for evaluating an empty project. */
const nothing = () => [];

// ── The standard ────────────────────────────────────────────────────────────

describe('The control standard', () => {
  it('covers four stages, and every item belongs to one of them', () => {
    assert.deepEqual(CONTROL_STAGES.map((s) => s.stage), [
      'PRECONSTRUCTION',
      'MOBILISATION',
      'DELIVERY',
      'COMPLETION',
    ]);

    const stages = new Set<ControlStage>(CONTROL_STAGES.map((s) => s.stage));
    for (const item of CONTROL_ITEMS) {
      assert.ok(stages.has(item.stage), `${item.id} is in no stage`);
    }
  });

  it('gives every item a unique id, a purpose and a phase it becomes due in', () => {
    assert.equal(new Set(CONTROL_ITEMS.map((i) => i.id)).size, CONTROL_ITEMS.length, 'an item id appears twice');

    for (const item of CONTROL_ITEMS) {
      assert.ok(item.purpose.length > 20, `${item.id} has no purpose worth stating`);
      assert.ok(LIFECYCLE_ORDER.includes(item.dueFrom), `${item.id} is due from a phase that does not exist`);
    }
  });

  it('states a reason for every item it cannot evidence, and evidences everything else', () => {
    for (const item of CONTROL_ITEMS) {
      if (item.evidence) {
        assert.ok(classifyEntity(item.evidence.refType), `${item.id} looks for ${item.evidence.refType}, which is not a classified entity`);
        assert.ok(item.evidence.minimum >= 1);
        assert.ok(item.evidence.counts.length > 0, `${item.id} counts something unnamed`);
        assert.equal(item.notTrackedReason, undefined, `${item.id} both evidences and claims to be untracked`);
      } else {
        // The whole honesty rule turns on this: an item with no evidence path
        // must say why, or it will read as an oversight rather than a gap.
        assert.ok(
          (item.notTrackedReason ?? '').length > 40,
          `${item.id} cannot be evidenced and does not say why`,
        );
      }
    }
  });

  it('claims gate enforcement only where a phase gate really enforces it', () => {
    const gateCriteria = new Set(PHASE_GATES.flatMap((g) => g.exitCriteria.map((c) => c.requires.refType)));
    for (const item of CONTROL_ITEMS.filter((i) => i.gateEnforced)) {
      assert.ok(
        item.evidence && gateCriteria.has(item.evidence.refType),
        `${item.id} claims to be gate-enforced but no phase gate checks ${item.evidence?.refType}`,
      );
    }
  });

  it('holds no second copy of the gate rule', () => {
    // The control standard cross-references the gates; `phases.ts` remains the
    // only thing that enforces. If this list ever grew its own enforcement,
    // there would be two rules to disagree with each other.
    assert.ok(CONTROL_ITEMS.some((i) => i.gateEnforced), 'nothing is cross-referenced to a gate at all');
    assert.ok(
      CONTROL_ITEMS.filter((i) => i.gateEnforced).length < CONTROL_ITEMS.length / 2,
      'most items are not gates, and the standard should say so',
    );
  });
});

// ── Evaluation ──────────────────────────────────────────────────────────────

describe('Evaluating a project against the standard', () => {
  it('does not fault a project for an item that is not yet due', () => {
    const early = evaluateControl('CONCEPT', nothing);

    const diary = early.stages.find((s) => s.stage === 'DELIVERY')!.items.find((i) => i.id === 'DEL.DIARY')!;
    assert.equal(diary.status, 'NOT_YET_DUE', 'a project in concept is not failing for having no site diary');

    // And a not-yet-due item is not a gap.
    assert.ok(!early.gaps.some((g) => g.id === 'DEL.DIARY'));
  });

  it('reports what it cannot evidence as untracked, never as missing or present', () => {
    const report = evaluateControl('HANDOVER', nothing);
    const all = report.stages.flatMap((s) => s.items);

    const untracked = all.filter((i) => i.status === 'NOT_TRACKED');
    assert.ok(untracked.length > 0);

    for (const item of untracked) {
      assert.ok(item.notTrackedReason, `${item.id} is untracked without saying why`);
      // Blaming the project for the platform's gap would be the easy mistake.
      assert.ok(!report.gaps.some((g) => g.id === item.id), `${item.id} was counted as a project gap`);
    }

    // Surveys, a procurement schedule and a final account are real control
    // items with no home in this platform. Saying so is the point.
    for (const id of ['PRE.SURVEYS', 'PRE.PROCUREMENT_SCHEDULE', 'COM.FINAL_ACCOUNT']) {
      assert.ok(report.notTracked.some((n) => n.id === id), `${id} should be declared untracked`);
    }
  });

  it('measures completeness over what is due and trackable, not over the whole list', () => {
    const report = evaluateControl('HANDOVER', nothing);
    const all = report.stages.flatMap((s) => s.items);

    const present = all.filter((i) => i.status === 'PRESENT').length;
    const missing = all.filter((i) => i.status === 'MISSING').length;
    const untracked = all.filter((i) => i.status === 'NOT_TRACKED').length;

    assert.equal(present, 0, 'an empty project evidences nothing');
    assert.equal(report.completenessPercent, 0);
    // The untracked items are excluded from the denominator rather than
    // dragging every project down for something no project can fix.
    assert.equal(present + missing + untracked, all.length);
    assert.equal(report.gaps.length, missing);
  });

  it('reports no completeness at all when nothing is yet due, rather than nought per cent', () => {
    const report = evaluateControl('CONCEPT', nothing);
    const preconstruction = report.stages.find((s) => s.stage === 'MOBILISATION')!;

    // Nothing in mobilisation is due in concept. "No opinion" and "zero per
    // cent" are different statements and the second one would be a lie.
    assert.equal(preconstruction.completenessPercent, null);
  });

  it('separates a gap that stops the project from a gap that is only discipline', () => {
    const report = evaluateControl('CONSTRUCTION', nothing);

    assert.ok(report.blockingGaps.includes('MOB.BASELINE'), 'a missing approved baseline is a phase gate');
    assert.ok(report.gaps.some((g) => g.id === 'DEL.DIARY'), 'a missing diary is still a gap');
    assert.ok(!report.blockingGaps.includes('DEL.DIARY'), 'but it does not stop the project, and saying it does would be false');
  });

  it('counts what it found, so a zero is interpretable', () => {
    const report = evaluateControl(
      'CONSTRUCTION',
      (refType) => (refType === 'SiteDiary' ? [{ id: 'a' }, { id: 'b' }] : []),
    );
    const diary = report.stages.flatMap((s) => s.items).find((i) => i.id === 'DEL.DIARY')!;

    assert.equal(diary.status, 'PRESENT');
    assert.equal(diary.found, 2);
    assert.equal(diary.counts, 'site diary entries');
  });

  it('applies a predicate rather than counting records of the right shape', () => {
    // An unapproved baseline is not a baseline. A checklist that counted the
    // record rather than its state would pass a project that has none.
    const draft = evaluateControl('CONSTRUCTION', (t) => (t === 'ProgrammeBaseline' ? [{ status: 'DRAFT' }] : []));
    const approved = evaluateControl('CONSTRUCTION', (t) => (t === 'ProgrammeBaseline' ? [{ status: 'APPROVED' }] : []));

    const statusOf = (r: ReturnType<typeof evaluateControl>) =>
      r.stages.flatMap((s) => s.items).find((i) => i.id === 'MOB.BASELINE')!.status;

    assert.equal(statusOf(draft), 'MISSING');
    assert.equal(statusOf(approved), 'PRESENT');
  });
});

// ── Against the real project ────────────────────────────────────────────────

describe('The standard against a real project', () => {
  it('reports the seeded project honestly, gaps and all', () => {
    const report = control.projectControl(pmCtx());

    assert.equal(report.phase, 'OPERATIONS');
    assert.ok(report.completenessPercent !== null && report.completenessPercent > 50);
    assert.ok(report.completenessPercent! < 100, 'a report that says a real project is perfect is not measuring anything');

    // Every stage has an opinion by operations.
    for (const stage of report.stages) {
      assert.equal(stage.notYetDue, 0, `${stage.stage} still has items pending in operations`);
    }

    // The gaps it names are real: the demo project genuinely keeps no site
    // diary and runs no quality inspections.
    assert.ok(report.gaps.some((g) => g.id === 'DEL.DIARY'));
    assert.ok(report.gaps.some((g) => g.id === 'DEL.INSPECTIONS'));

    // And the things it did do are found.
    const found = report.stages.flatMap((s) => s.items).filter((i) => i.status === 'PRESENT').map((i) => i.id);
    for (const id of ['PRE.SCOPE', 'MOB.BASELINE', 'COM.HANDOVER', 'COM.AS_BUILTS', 'COM.LESSONS_LEARNED']) {
      assert.ok(found.includes(id), `${id} was delivered by the seed but not found`);
    }
  });

  it('refuses to report on a project that does not exist', () => {
    throwsCode(() => control.projectControl(pmCtx('does-not-exist')), 'PROJECT_NOT_FOUND');
  });

  it('measures every project the same way and finds what is systemic', () => {
    const admin = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');

    const { projectId } = structure.createProject(admin, {
      portfolioId: String(portfolios[0]!.state.id),
      name: 'Kielder spillway strengthening',
      sectorType: 'INFRASTRUCTURE',
      assetType: 'Reservoir spillway',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Hexham' },
      contractValueMinor: 940_000_000,
      currency: 'GBP',
      plannedStart: '2027-01-11',
      plannedCompletion: '2028-06-30',
    });

    // Brand new, so almost nothing is due. A checklist that reported a fresh
    // project as failing thirty items would be ignored inside a week, which is
    // how checklists die. The one thing it does ask for is the scope, which is
    // the only item due in concept and the right thing to be asking about.
    const fresh = control.projectControl(platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' }));
    assert.equal(fresh.phase, 'CONCEPT');
    assert.deepEqual(fresh.gaps.map((g) => g.id), ['PRE.SCOPE']);

    // Move it into design through the governed transition, so both projects
    // are past the point where the same items became due.
    structure.createScopePackage(platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' }), {
      name: 'Spillway civils',
      discipline: 'CIVILS',
      scopeOfWorks: 'Strengthening of the existing spillway chute and stilling basin',
      inclusions: ['Concrete repairs', 'Anchor installation'],
      exclusions: ['Reservoir drawdown'],
      acceptanceCriteria: ['Pull-out testing to specification'],
      estimatedValueMinor: 740_000_000,
      designResponsibility: 'SHARED',
    });
    structure.transitionPhase(platform.context(seed.users.admin!.auth, projectId, { source: 'WEB' }), {
      to: 'DESIGN',
      justification: 'Scope defined and funding released for design',
    });

    const estate = control.estateControl(admin);

    assert.equal(estate.standardItems, CONTROL_ITEMS.length);
    assert.equal(estate.projects.length, 2);
    // Worst first, so the view opens on the project that needs attention.
    assert.ok((estate.projects[0]!.completenessPercent ?? 101) <= (estate.projects[1]!.completenessPercent ?? 101));

    // The untracked list is stated once, not once per project — otherwise a
    // platform gap reads as a failure on every job.
    assert.ok(estate.notTracked.length > 0);
    assert.equal(new Set(estate.notTracked.map((n) => n.id)).size, estate.notTracked.length);

    // Both projects are missing specifications and constraints. That neither
    // project team could have seen is the whole argument for one standard.
    assert.ok(estate.systemicGaps.length > 0, 'nothing was found across both projects');
    for (const gap of estate.systemicGaps) {
      assert.ok(gap.missingOn > 1, 'a gap on one project is not systemic');
      assert.equal(gap.ofProjects, 2);
      assert.ok(controlItem(gap.id), `${gap.id} is not a control item`);
    }
    assert.ok(estate.systemicGaps.some((g) => g.id === 'PRE.SPECIFICATIONS'));
    assert.ok(estate.observations.some((o) => o.includes('missing on 2 of 2 projects')));
  });
});

// ── Corporate memory ────────────────────────────────────────────────────────

describe('Lessons learned as corporate memory', () => {
  const lesson = (over: Partial<control.LessonInput> = {}): control.LessonInput => ({
    title: 'Piling rig could not reach the north-east corner',
    category: 'GROUND_CONDITIONS',
    kind: 'WENT_WRONG',
    stage: 'PRECONSTRUCTION',
    whatHappened: 'The access route assumed at tender was withdrawn by the landowner two weeks before piling started.',
    recommendation: 'Confirm third-party access in writing before the piling package is let, not before it starts.',
    costImpactMinor: 4_200_000,
    scheduleImpactDays: 9,
    ...over,
  });

  it('refuses a lesson nobody could act on', () => {
    // "Communication could have been better" is the output of most lessons
    // workshops and teaches the next job nothing.
    throwsCode(() => control.captureLesson(pmCtx(), lesson({ recommendation: 'Communicate better' })), 'LESSON_NOT_ACTIONABLE');
    throwsCode(() => control.captureLesson(pmCtx(), lesson({ whatHappened: 'It went badly' })), 'LESSON_NOT_DESCRIBED');
  });

  it('refuses to link a lesson to a control item that does not exist', () => {
    throwsCode(
      () => control.captureLesson(pmCtx(), lesson({ relatedControlItemId: 'PRE.INVENTED' })),
      'CONTROL_ITEM_UNKNOWN',
    );
  });

  it('captures a lesson with its cost and keeps it on the project that produced it', () => {
    const { lessonId } = control.captureLesson(pmCtx(), lesson({ relatedControlItemId: 'PRE.CONSTRAINTS' }));
    const record = platform.ledger.require({ refType: 'LessonLearned', refId: lessonId });

    assert.equal(record.state.projectId, seed.projectId);
    assert.equal(record.state.costImpactMinor, 4_200_000);
    assert.equal(record.state.relatedControlItemId, 'PRE.CONSTRAINTS');
    assert.ok(record.state.capturedBy);
  });

  it('reads across every project, because that is the only way a lesson pays', () => {
    const library = control.lessonsLibrary(pmCtx());

    // The seed captured three; this suite has added more.
    assert.ok(library.lessons.length >= 4);
    assert.ok(library.recurring.length > 0);

    // Newest first — a library nobody can skim is a library nobody reads.
    const dates = library.lessons.map((l) => String(l.capturedAt));
    assert.deepEqual(dates, [...dates].sort().reverse());

    // Only things that went wrong recur; what went well is recorded but is not
    // a problem to be counted.
    const wentWell = library.lessons.filter((l) => l.kind === 'WENT_WELL');
    assert.ok(wentWell.length > 0);
    for (const entry of library.recurring) {
      assert.ok(entry.occurrences > 0);
    }
  });

  it('filters without losing the cross-project view', () => {
    const ground = control.lessonsLibrary(pmCtx(), { category: 'GROUND_CONDITIONS' });
    assert.ok(ground.lessons.length > 0);
    assert.ok(ground.lessons.every((l) => l.category === 'GROUND_CONDITIONS'));

    const good = control.lessonsLibrary(pmCtx(), { kind: 'WENT_WELL' });
    assert.ok(good.lessons.every((l) => l.kind === 'WENT_WELL'));
    // Nothing that went well can recur as a problem.
    assert.equal(good.recurring.length, 0);
  });

  it('says when the library is only worth so much yet', () => {
    const library = control.lessonsLibrary(pmCtx());

    // Every lesson so far comes from one project, and the library says so
    // rather than presenting a single job's experience as corporate knowledge.
    assert.equal(library.contributingProjects, 1);
    assert.ok(library.observations.some((o) => o.includes('one project')));
    assert.equal(library.costOfRepeatedMistakesMinor, 0, 'nothing has recurred across projects yet');
  });

  it('keeps the lesson event in the catalogue, evidenced and off the AI', () => {
    const definition = lookupEventType('LESSON_CAPTURED');
    assert.ok(definition);
    assert.equal(definition.entity, 'LessonLearned');
    assert.equal(definition.requiresEvidence, true);
    assert.equal(definition.aiAllowed, false, 'what a job taught the business is not for a model to assert');
    assert.equal(classifyEntity('LessonLearned')?.area, 'RISK_REGISTER');
  });
});
