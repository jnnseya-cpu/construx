import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import {
  CONTROL_ITEMS,
  controlItem,
  evaluateControl,
  type ControlReport,
  type ControlStage,
} from '../lifecycle/control.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';

/**
 * Corporate project control, and the memory it produces.
 *
 * Two things live here and they are the same idea at two scales.
 *
 * `projectControl` runs the standard against one project: what should be in
 * place by now, what is, what is not. `estateControl` runs it against every
 * project in the business at once, which is the point of having one standard —
 * a contractor whose projects are each controlled differently cannot tell a
 * well-run job from a lucky one, and cannot see that it is systematically bad
 * at something until it has been bad at it on twenty jobs.
 *
 * Lessons learned are the other half. A lesson recorded on the project that
 * produced it is a document nobody opens; the value is entirely in it being
 * findable from the *next* project, before the same money is spent again. So
 * lessons are captured against a project and read across the tenant.
 */

// --- Lessons -------------------------------------------------------------------

export type LessonCategory =
  | 'DESIGN'
  | 'PROCUREMENT'
  | 'COMMERCIAL'
  | 'PROGRAMME'
  | 'QUALITY'
  | 'SAFETY'
  | 'SUPPLY_CHAIN'
  | 'CLIENT'
  | 'GROUND_CONDITIONS'
  | 'HANDOVER';

/** Whether the business should do more of this or less of it. */
export type LessonKind = 'WENT_WRONG' | 'WENT_WELL';

export type LessonInput = {
  title: string;
  category: LessonCategory;
  kind: LessonKind;
  /** The stage of the control standard this belongs to. */
  stage: ControlStage;
  whatHappened: string;
  /** What it cost, in money or time. A lesson with no impact is an anecdote. */
  costImpactMinor?: number;
  scheduleImpactDays?: number;
  /**
   * What to do differently. This is the part that has to be actionable — a
   * lesson that says "communication could have been better" teaches nobody
   * anything and is refused.
   */
  recommendation: string;
  /** The control item this would have been caught by, if there is one. */
  relatedControlItemId?: string;
};

/**
 * Capture a lesson.
 *
 * Two rules, both there because "lessons learned" workshops reliably produce
 * neither. A lesson must carry a recommendation somebody could act on, and it
 * must name what it cost — in money, in days, or explicitly neither. A register
 * of vague regrets is worse than an empty one, because it looks like the job
 * was done.
 */
export function captureLesson(ctx: EngineContext, input: LessonInput): { lessonId: string } {
  // A lesson learned is the risk register read backwards — what happened, what
  // it cost, what to do about it — so it sits with the people who hold the risk
  // register rather than with business development, who are not on the job.
  authorise(ctx, 'RISK_REGISTER', 'C');

  if (input.recommendation.trim().length < 20) {
    throw new DomainError(
      'LESSON_NOT_ACTIONABLE',
      'A lesson needs a recommendation somebody on the next job could act on, not a sentiment',
    );
  }
  if (input.whatHappened.trim().length < 20) {
    throw new DomainError('LESSON_NOT_DESCRIBED', 'A lesson needs an account of what actually happened');
  }
  if (input.relatedControlItemId && !controlItem(input.relatedControlItemId)) {
    throw new DomainError('CONTROL_ITEM_UNKNOWN', `${input.relatedControlItemId} is not a control item`);
  }

  const lessonId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'LESSON_LEARNED',
    hash: hashEvidence(`${lessonId}:${input.title}:${input.recommendation}`),
    description: `Lesson captured: ${input.title}`,
  });

  write(ctx, {
    eventType: 'LESSON_CAPTURED',
    entity: { refType: 'LessonLearned', refId: lessonId },
    evidenceRefs: [evidence],
    nextState: {
      id: lessonId,
      projectId: ctx.projectId,
      title: input.title,
      category: input.category,
      kind: input.kind,
      stage: input.stage,
      whatHappened: input.whatHappened.trim(),
      recommendation: input.recommendation.trim(),
      costImpactMinor: input.costImpactMinor ?? 0,
      scheduleImpactDays: input.scheduleImpactDays ?? 0,
      relatedControlItemId: input.relatedControlItemId,
      capturedBy: ctx.auth.actorId,
      capturedAt: new Date().toISOString(),
    },
  });

  return { lessonId };
}

export type LessonsLibrary = {
  lessons: Array<Record<string, unknown>>;
  /** Projects that have contributed at least one lesson. */
  contributingProjects: number;
  /** What the business keeps getting wrong, worst first. */
  recurring: Array<{
    category: LessonCategory;
    occurrences: number;
    projects: number;
    costImpactMinor: number;
    scheduleImpactDays: number;
  }>;
  /** Total quantified cost of what went wrong, across the estate. */
  costOfRepeatedMistakesMinor: number;
  observations: string[];
};

/**
 * The library, across every project in the business.
 *
 * A lesson only pays for itself when somebody on a different job finds it, so
 * this reads the tenant rather than the project. The recurring list is the
 * interesting output: one project getting ground conditions wrong is bad luck,
 * and the same category recurring across four projects is a business problem
 * that no individual project team was ever in a position to see.
 */
export function lessonsLibrary(
  ctx: EngineContext,
  filter: { category?: LessonCategory; kind?: LessonKind; stage?: ControlStage } = {},
): LessonsLibrary {
  authorise(ctx, 'RISK_REGISTER', 'R');

  const all = ctx.ledger
    .listByTenant(ctx.tenantId, 'LessonLearned')
    .map((r) => r.state)
    .filter((l) => (filter.category ? l.category === filter.category : true))
    .filter((l) => (filter.kind ? l.kind === filter.kind : true))
    .filter((l) => (filter.stage ? l.stage === filter.stage : true))
    .sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));

  const byCategory = new Map<LessonCategory, { occurrences: number; projects: Set<string>; cost: number; days: number }>();
  for (const lesson of all) {
    if (lesson.kind !== 'WENT_WRONG') continue;
    const category = lesson.category as LessonCategory;
    const bucket = byCategory.get(category) ?? { occurrences: 0, projects: new Set<string>(), cost: 0, days: 0 };
    bucket.occurrences += 1;
    bucket.projects.add(String(lesson.projectId));
    bucket.cost += Number(lesson.costImpactMinor ?? 0);
    bucket.days += Number(lesson.scheduleImpactDays ?? 0);
    byCategory.set(category, bucket);
  }

  const recurring = [...byCategory.entries()]
    .map(([category, b]) => ({
      category,
      occurrences: b.occurrences,
      projects: b.projects.size,
      costImpactMinor: b.cost,
      scheduleImpactDays: b.days,
    }))
    .sort((a, b) => b.costImpactMinor - a.costImpactMinor || b.occurrences - a.occurrences);

  const contributingProjects = new Set(all.map((l) => String(l.projectId))).size;
  const costOfRepeatedMistakesMinor = recurring
    .filter((r) => r.projects > 1)
    .reduce((sum, r) => sum + r.costImpactMinor, 0);

  const observations: string[] = [];
  if (all.length === 0) {
    observations.push('No lessons have been captured. The business is paying for the same mistakes without a record of them.');
  } else {
    const acrossProjects = recurring.filter((r) => r.projects > 1);
    if (acrossProjects.length > 0) {
      const worst = acrossProjects[0]!;
      observations.push(
        `${worst.category} has cost money on ${worst.projects} separate projects. That is a business problem, not bad luck on one job.`,
      );
    }
    if (contributingProjects === 1 && all.length > 1) {
      observations.push('Every lesson so far comes from one project. The library is only worth having once other jobs contribute to it.');
    }
    const wentWell = all.filter((l) => l.kind === 'WENT_WELL').length;
    if (wentWell === 0) {
      observations.push('Nothing has been recorded as having gone well, so the library cannot tell anybody what to repeat.');
    }
  }

  return { lessons: all, contributingProjects, recurring, costOfRepeatedMistakesMinor, observations };
}

// --- Control -------------------------------------------------------------------

/** Run the standard against the project in context. */
export function projectControl(ctx: EngineContext): ControlReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });
  const phase = currentPhase(ctx);
  if (!phase || !project) throw new DomainError('PROJECT_NOT_FOUND', `No project ${ctx.projectId}`, 404);

  return evaluateControl(
    phase,
    (refType) => ctx.ledger.list(ctx.projectId, refType).map((r) => r.state),
    Number(project.state.contractValueMinor ?? 0) || undefined,
  );
}

export type EstateControl = {
  standardItems: number;
  projects: Array<{
    projectId: string;
    name: string;
    phase: LifecyclePhase;
    completenessPercent: number | null;
    gaps: number;
    blockingGaps: string[];
  }>;
  /**
   * Items missing on more than one project. One project without a cost report
   * is a project problem; the same item missing across the estate is how the
   * business runs jobs, and only this view can see it.
   */
  systemicGaps: Array<{ id: string; label: string; stage: ControlStage; missingOn: number; ofProjects: number; purpose: string }>;
  /** What the platform does not track, stated once rather than per project. */
  notTracked: Array<{ id: string; label: string; reason: string }>;
  observations: string[];
};

/**
 * The same standard over every project at once.
 *
 * This is the reason for having one standard rather than letting each project
 * find its own way. A project manager can see their own gaps; nobody can see
 * that eleven of fourteen projects have no maintained risk register until every
 * project is measured the same way.
 */
export function estateControl(ctx: EngineContext): EstateControl {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const projects = ctx.ledger
    .listByTenant(ctx.tenantId, 'Project')
    .map((r) => r.state)
    .filter((p) => typeof p.phase === 'string');

  const missingCounts = new Map<string, number>();
  const rows: EstateControl['projects'] = [];

  for (const project of projects) {
    const projectId = String(project.id);
    const report = evaluateControl(
      project.phase as LifecyclePhase,
      (refType) => ctx.ledger.list(projectId, refType).map((r) => r.state),
      Number(project.contractValueMinor ?? 0) || undefined,
    );

    for (const gap of report.gaps) missingCounts.set(gap.id, (missingCounts.get(gap.id) ?? 0) + 1);

    rows.push({
      projectId,
      name: String(project.name ?? projectId),
      phase: project.phase as LifecyclePhase,
      completenessPercent: report.completenessPercent,
      gaps: report.gaps.length,
      blockingGaps: report.blockingGaps,
    });
  }

  const systemicGaps = [...missingCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => {
      const item = controlItem(id)!;
      return {
        id,
        label: item.label,
        stage: item.stage,
        missingOn: count,
        ofProjects: projects.length,
        purpose: item.purpose,
      };
    })
    .sort((a, b) => b.missingOn - a.missingOn);

  const observations: string[] = [];
  if (projects.length === 0) {
    observations.push('No projects to measure.');
  } else if (projects.length === 1) {
    observations.push('One project. The standard is running, but a single project cannot show what the business does systematically.');
  }
  for (const gap of systemicGaps.slice(0, 3)) {
    observations.push(`${gap.label} is missing on ${gap.missingOn} of ${gap.ofProjects} projects — ${gap.purpose}`);
  }

  return {
    standardItems: CONTROL_ITEMS.length,
    projects: rows.sort((a, b) => (a.completenessPercent ?? 101) - (b.completenessPercent ?? 101)),
    systemicGaps,
    // Identical for every project, so it is stated once. Reporting it per
    // project would read as fourteen separate failures rather than one gap.
    notTracked: CONTROL_ITEMS.filter((i) => !i.evidence).map((i) => ({
      id: i.id,
      label: i.label,
      reason: i.notTrackedReason ?? 'No evidence path',
    })),
    observations,
  };
}
