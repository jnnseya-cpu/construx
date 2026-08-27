import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * C-WF-03 — site, asset and constraint due diligence.
 *
 * What the ground, the neighbours and the law will actually allow. Nearly every
 * expensive surprise on a construction project was knowable at this stage and
 * was either not surveyed, surveyed and not read, or read and not linked to the
 * option it invalidated.
 *
 * **`SiteConstraint` is not `Constraint`.** The platform already has a
 * `Constraint` entity and it stays exactly as it is: that one is the Last
 * Planner constraint log — something blocking a task in next week's lookahead,
 * closed by a phone call. This is a permanent property of the site. Overloading
 * one entity with both would put "waiting for the crane" and "the aquifer is
 * six metres down" in the same list, sorted by date.
 *
 * **Readiness is evidence coverage, not document count.** The deterministic
 * flow says so explicitly, and it is the rule that makes the score worth
 * reading. Twelve reports covering the same corner of the site is not diligence.
 * `dueDiligenceReadiness` scores the *impact categories a constraint could fall
 * under* against those a live survey actually covers, so uploading the same
 * report twice moves nothing.
 *
 * **An unknown coordinate system prevents spatial overlay.** The exception
 * control, enforced at registration rather than at overlay: a survey whose
 * coordinate system nobody recorded cannot be placed against another survey,
 * and discovering that at the moment two drawings are compared is discovering
 * it too late. `NONE` is a legitimate answer for a non-spatial survey — a
 * contamination desk study has no geometry — and is distinguished from an
 * unrecorded one.
 *
 * **A superseded survey stays as historic evidence.** It is not deleted and its
 * findings are not withdrawn: what changes is that it stops counting toward
 * coverage. A ground investigation from 2019 is still the record of what was
 * found in 2019.
 *
 * **A critical constraint that nobody has assessed blocks option
 * recommendation.** AC-C-WF-03-02. `constraintAssessmentBlockedReason` is what
 * C-WF-04 reads — the rule lives here, with the constraints, and the option
 * module asks rather than reimplementing it.
 *
 * **A material unknown carries an allowance or an explicit acceptance.** The
 * exception control, and it is the honest half of due diligence: not everything
 * can be known at concept, and the register records which unknowns were bought
 * off with money and which with a signature.
 */

/** What a constraint can affect. A constraint affecting nothing is an observation. */
export const IMPACT_CATEGORY = [
  'GROUND',
  'CONTAMINATION',
  'FLOOD',
  'ECOLOGY',
  'HERITAGE',
  'UTILITIES',
  'ACCESS',
  'PLANNING',
  'NEIGHBOUR',
  'OPERATIONAL',
  'STRUCTURAL',
  'AIR_QUALITY',
] as const;
export type ImpactCategory = (typeof IMPACT_CATEGORY)[number];

/**
 * How binding the constraint is.
 *
 * The four are genuinely different and the difference decides what happens
 * next: a HARD constraint changes the design, a SOFT one changes the cost, an
 * ASSUMPTION needs proving, and an OPPORTUNITY is the one nobody records and
 * everybody later wishes they had.
 */
export const CONSTRAINT_CLASS = ['HARD', 'SOFT', 'ASSUMPTION', 'OPPORTUNITY'] as const;
export type ConstraintClass = (typeof CONSTRAINT_CLASS)[number];

export const CONSTRAINT_SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type ConstraintSeverity = (typeof CONSTRAINT_SEVERITY)[number];

export const RELIANCE_STATUS = ['RELIED_UPON', 'INFORMATION_ONLY', 'SUPERSEDED'] as const;
export type RelianceStatus = (typeof RELIANCE_STATUS)[number];

export type SiteSurveyState = {
  surveyId: string;
  reference: string;
  discipline: string;
  author: string;
  surveyedOn: string;
  /** What the survey actually looked at, in impact-category terms. */
  coverage: readonly ImpactCategory[];
  /**
   * EPSG code, a named grid, or `NONE` for a survey with no geometry.
   *
   * Not optional. An absent coordinate system and a survey that legitimately
   * has none are different facts, and only one of them is a problem.
   */
  coordinateSystem: string;
  /** What the survey did not or could not establish. The half people skip. */
  limitations: string;
  relianceStatus: RelianceStatus;
  /** When the survey stops being current, if it does. Ecology and flood expire. */
  validUntil?: string;
  supersededBySurveyId?: string;
  registeredBy: string;
  registeredAt: string;
};

export type SiteConstraintState = {
  constraintId: string;
  /** Stable, and the same id the map uses. AC-C-WF-03-03. */
  reference: string;
  description: string;
  constraintClass: ConstraintClass;
  severity: ConstraintSeverity;
  impacts: readonly ImpactCategory[];
  /** Where it applies. Free text plus an optional geometry reference. */
  spatialScope: string;
  geometryRef?: string;
  /** The survey that evidences it. A constraint with no evidence is an opinion. */
  surveyId: string;
  ownerId: string;
  /**
   * Money set aside against it, where the answer to an unknown was money.
   * Mutually meaningful with `acceptedUnknownBy` — the exception control asks
   * for one or the other on a material unknown.
   */
  allowanceMinor?: number;
  acceptedUnknownBy?: string;
  status: 'IDENTIFIED' | 'ASSESSED';
  assessment?: string;
  assessedBy?: string;
  assessedAt?: string;
  origin: 'AI' | 'HUMAN';
  identifiedAt: string;
};

export type InvestigationActionState = {
  actionId: string;
  reference: string;
  description: string;
  /** The gap it closes: a constraint, or a coverage category with no survey. */
  constraintId?: string;
  coverageGap?: ImpactCategory;
  ownerId: string;
  dueDate: string;
  status: 'OPEN' | 'CLOSED';
  closedFinding?: string;
  closedBy?: string;
  closedAt?: string;
  assignedAt: string;
};

export type DueDiligenceReviewState = {
  reviewId: string;
  projectId: string;
  version: number;
  /** The readiness at the moment of review, recorded rather than recomputed. */
  coveredCategories: readonly ImpactCategory[];
  uncoveredCategories: readonly ImpactCategory[];
  readinessPercent: number;
  constraintsAssessed: number;
  constraintsOpen: number;
  investigationsOpen: number;
  note: string;
  reviewedBy: string;
  reviewedAt: string;
};

function surveysOf(ctx: EngineContext): SiteSurveyState[] {
  return ctx.ledger.list(ctx.projectId, 'SiteSurvey').map((r) => r.state as unknown as SiteSurveyState);
}

function constraintsOf(ctx: EngineContext): SiteConstraintState[] {
  return ctx.ledger.list(ctx.projectId, 'SiteConstraint').map((r) => r.state as unknown as SiteConstraintState);
}

function investigationsOf(ctx: EngineContext): InvestigationActionState[] {
  return ctx.ledger
    .list(ctx.projectId, 'InvestigationAction')
    .map((r) => r.state as unknown as InvestigationActionState);
}

/** Surveys that still count: relied upon, not superseded, not expired. */
function liveSurveys(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): SiteSurveyState[] {
  return surveysOf(ctx).filter(
    (s) =>
      s.relianceStatus === 'RELIED_UPON' &&
      s.supersededBySurveyId === undefined &&
      (s.validUntil === undefined || s.validUntil >= today),
  );
}

/**
 * Register a survey.
 *
 * The coordinate system and the limitations are both mandatory, and both are
 * the fields that get skipped. The limitations are where "we could not access
 * the eastern boundary" lives, and its absence is how a project prices ground
 * it has never seen.
 */
export function registerSurvey(
  ctx: EngineContext,
  input: {
    reference: string;
    discipline: string;
    author: string;
    surveyedOn: string;
    coverage: readonly ImpactCategory[];
    coordinateSystem: string;
    limitations: string;
    relianceStatus?: RelianceStatus;
    validUntil?: string;
    evidenceHash: string;
  },
): { surveyId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  if (input.coordinateSystem.trim() === '') {
    throw new DomainError(
      'COORDINATE_SYSTEM_REQUIRED',
      'Record the coordinate system, or NONE for a survey with no geometry. A survey whose system nobody ' +
        'wrote down cannot be overlaid on another, and that is discovered at the moment two drawings disagree.',
      422,
    );
  }
  if (input.limitations.trim() === '') {
    throw new DomainError(
      'LIMITATIONS_REQUIRED',
      'State what this survey did not establish. "None" is an acceptable answer and a deliberate one; ' +
        'a blank is how a project prices ground nobody has seen.',
      422,
    );
  }
  if (input.coverage.length === 0) {
    throw new DomainError(
      'COVERAGE_REQUIRED',
      'A survey covering no impact category contributes nothing to due-diligence readiness.',
      422,
    );
  }
  if (surveysOf(ctx).some((s) => s.reference === input.reference)) {
    throw new DomainError('DUPLICATE_SURVEY', `Survey ${input.reference} is already registered`, 409);
  }
  if (input.validUntil !== undefined && input.validUntil < input.surveyedOn) {
    throw new DomainError('EXPIRY_BEFORE_SURVEY', 'A survey cannot expire before it was carried out', 422);
  }

  const evidence = registerEvidence(ctx, {
    type: 'SITE_SURVEY',
    hash: input.evidenceHash,
    description: `${input.reference} — ${input.discipline} survey by ${input.author}`,
  });

  const surveyId = ulid();
  write(ctx, {
    eventType: 'SURVEY_REGISTERED',
    entity: { refType: 'SiteSurvey', refId: surveyId },
    nextState: {
      surveyId,
      reference: input.reference,
      discipline: input.discipline,
      author: input.author,
      surveyedOn: input.surveyedOn.slice(0, 10),
      coverage: input.coverage,
      coordinateSystem: input.coordinateSystem,
      limitations: input.limitations,
      relianceStatus: input.relianceStatus ?? 'RELIED_UPON',
      validUntil: input.validUntil?.slice(0, 10),
      registeredBy: ctx.auth.actorId,
      registeredAt: new Date().toISOString(),
    } satisfies SiteSurveyState as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
  });

  return { surveyId };
}

/**
 * Supersede a survey with a later one.
 *
 * The old survey remains readable and its constraints remain valid records of
 * what was found. What changes is that it no longer counts toward coverage —
 * "we surveyed that in 2019" is not the same claim as "that is surveyed".
 */
export function supersedeSurvey(
  ctx: EngineContext,
  input: { surveyId: string; replacedBySurveyId: string; reason: string },
): { surveyId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'U');

  const existing = surveysOf(ctx).find((s) => s.surveyId === input.surveyId);
  if (!existing) throw new DomainError('NO_SUCH_SURVEY', 'No such survey on this project', 404);
  if (existing.supersededBySurveyId) {
    throw new DomainError('ALREADY_SUPERSEDED', `${existing.reference} is already superseded`, 409);
  }
  const replacement = surveysOf(ctx).find((s) => s.surveyId === input.replacedBySurveyId);
  if (!replacement) throw new DomainError('NO_SUCH_SURVEY', 'The replacing survey is not registered', 404);
  if (replacement.surveyId === existing.surveyId) {
    throw new DomainError('REPLACEMENT_SELF', 'A survey cannot supersede itself', 422);
  }
  if (replacement.surveyedOn < existing.surveyedOn) {
    throw new DomainError(
      'REPLACEMENT_OLDER',
      `${replacement.reference} was surveyed on ${replacement.surveyedOn}, before ` +
        `${existing.reference} on ${existing.surveyedOn}. An older survey does not supersede a newer one.`,
      422,
    );
  }

  write(ctx, {
    eventType: 'SURVEY_SUPERSEDED',
    entity: { refType: 'SiteSurvey', refId: input.surveyId },
    nextState: {
      ...existing,
      relianceStatus: 'SUPERSEDED',
      supersededBySurveyId: input.replacedBySurveyId,
      supersedeReason: input.reason,
      supersededAt: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  });

  return { surveyId: input.surveyId };
}

/**
 * Identify a constraint.
 *
 * Bound to the survey that evidences it. AC-C-WF-03-01 asks for evidence,
 * spatial scope, impact categories and owner on every constraint, and all four
 * are required here rather than checked later — a constraint register that can
 * hold an unevidenced entry becomes a list of worries.
 */
export function identifyConstraint(
  ctx: EngineContext,
  input: {
    reference: string;
    description: string;
    constraintClass: ConstraintClass;
    severity: ConstraintSeverity;
    impacts: readonly ImpactCategory[];
    spatialScope: string;
    geometryRef?: string;
    surveyId: string;
    ownerId: string;
    allowanceMinor?: number;
    origin?: 'AI' | 'HUMAN';
  },
): { constraintId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  const survey = surveysOf(ctx).find((s) => s.surveyId === input.surveyId);
  if (!survey) {
    throw new DomainError(
      'NO_SUCH_SURVEY',
      'A constraint must cite the survey that evidences it. An unevidenced constraint is an opinion, ' +
        'and a register of opinions is one nobody acts on.',
      404,
    );
  }
  if (input.geometryRef !== undefined && survey.coordinateSystem.toUpperCase() === 'NONE') {
    throw new DomainError(
      'NO_COORDINATE_SYSTEM',
      `${survey.reference} has no coordinate system, so a geometry reference on a constraint drawn from it ` +
        'cannot be placed against anything else.',
      422,
    );
  }
  if (input.impacts.length === 0) {
    throw new DomainError(
      'IMPACT_REQUIRED',
      'Name what this constraint affects. A constraint affecting nothing is an observation.',
      422,
    );
  }
  if (input.spatialScope.trim() === '') {
    throw new DomainError('SCOPE_REQUIRED', 'Say where the constraint applies', 422);
  }
  if (input.ownerId.trim() === '') {
    throw new DomainError('OWNER_REQUIRED', 'Every constraint needs a named owner', 422);
  }
  if (constraintsOf(ctx).some((c) => c.reference === input.reference)) {
    throw new DomainError('DUPLICATE_CONSTRAINT', `Constraint ${input.reference} already exists`, 409);
  }

  const constraintId = ulid();
  write(ctx, {
    eventType: 'CONSTRAINT_IDENTIFIED',
    entity: { refType: 'SiteConstraint', refId: constraintId },
    nextState: {
      constraintId,
      reference: input.reference,
      description: input.description,
      constraintClass: input.constraintClass,
      severity: input.severity,
      impacts: input.impacts,
      spatialScope: input.spatialScope,
      geometryRef: input.geometryRef,
      surveyId: input.surveyId,
      ownerId: input.ownerId,
      allowanceMinor: input.allowanceMinor,
      status: 'IDENTIFIED',
      origin: input.origin ?? 'HUMAN',
      identifiedAt: new Date().toISOString(),
    } satisfies SiteConstraintState as unknown as Record<string, unknown>,
  });

  return { constraintId };
}

/**
 * Assess a constraint.
 *
 * The act that turns "we found this" into "we know what it means". A material
 * unknown must leave here with either an allowance or a named acceptance —
 * the exception control's requirement, enforced at the point somebody actually
 * has the information to satisfy it.
 */
export function assessConstraint(
  ctx: EngineContext,
  input: {
    constraintId: string;
    assessment: string;
    allowanceMinor?: number;
    acceptedUnknownBy?: string;
  },
): { constraintId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const existing = constraintsOf(ctx).find((c) => c.constraintId === input.constraintId);
  if (!existing) throw new DomainError('NO_SUCH_CONSTRAINT', 'No such constraint on this project', 404);
  if (existing.status === 'ASSESSED') {
    throw new DomainError('ALREADY_ASSESSED', `${existing.reference} is already assessed`, 409);
  }
  if (input.assessment.trim() === '') {
    throw new DomainError('ASSESSMENT_REQUIRED', 'Say what the constraint means for this project', 422);
  }

  const allowance = input.allowanceMinor ?? existing.allowanceMinor;
  const accepted = input.acceptedUnknownBy;
  // The exception control, applied to the classes where an unknown is actually
  // material. A HARD constraint is known — the design changes and the cost of
  // that change is priced by the cost plan, not carried as an allowance here.
  if (existing.constraintClass === 'ASSUMPTION' && allowance === undefined && (accepted ?? '').trim() === '') {
    throw new DomainError(
      'UNKNOWN_UNPRICED',
      `${existing.reference} is an assumption. Carry a quantified allowance against it, or name the sponsor ` +
        'accepting the unknown. An assumption with neither is a risk nobody has taken.',
      422,
    );
  }

  write(ctx, {
    eventType: 'CONSTRAINT_ASSESSED',
    entity: { refType: 'SiteConstraint', refId: input.constraintId },
    nextState: {
      ...existing,
      status: 'ASSESSED',
      assessment: input.assessment,
      allowanceMinor: allowance,
      acceptedUnknownBy: accepted,
      assessedBy: ctx.auth.actorId,
      assessedAt: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
  });

  return { constraintId: input.constraintId };
}

/** Assign further investigation against a constraint or an uncovered category. */
export function assignInvestigation(
  ctx: EngineContext,
  input: {
    reference: string;
    description: string;
    constraintId?: string;
    coverageGap?: ImpactCategory;
    ownerId: string;
    dueDate: string;
  },
): { actionId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  if (input.constraintId === undefined && input.coverageGap === undefined) {
    throw new DomainError(
      'TARGET_REQUIRED',
      'An investigation must close something: a constraint, or a coverage gap. One that closes nothing ' +
        'is an action item, and there is a register for those.',
      422,
    );
  }
  if (input.constraintId !== undefined && !constraintsOf(ctx).some((c) => c.constraintId === input.constraintId)) {
    throw new DomainError('NO_SUCH_CONSTRAINT', 'No such constraint on this project', 404);
  }
  if (input.ownerId.trim() === '') {
    throw new DomainError('OWNER_REQUIRED', 'Every investigation needs a named owner', 422);
  }

  const actionId = ulid();
  write(ctx, {
    eventType: 'INVESTIGATION_ASSIGNED',
    entity: { refType: 'InvestigationAction', refId: actionId },
    nextState: {
      actionId,
      reference: input.reference,
      description: input.description,
      constraintId: input.constraintId,
      coverageGap: input.coverageGap,
      ownerId: input.ownerId,
      dueDate: input.dueDate.slice(0, 10),
      status: 'OPEN',
      assignedAt: new Date().toISOString(),
    } satisfies InvestigationActionState as unknown as Record<string, unknown>,
  });

  return { actionId };
}

/** Close an investigation with what it found. */
export function closeInvestigation(
  ctx: EngineContext,
  input: { actionId: string; finding: string; evidenceHash: string },
): { actionId: string } {
  authorise(ctx, 'PROJECT_SETUP', 'U');

  const existing = investigationsOf(ctx).find((a) => a.actionId === input.actionId);
  if (!existing) throw new DomainError('NO_SUCH_INVESTIGATION', 'No such investigation on this project', 404);
  if (existing.status === 'CLOSED') {
    throw new DomainError('ALREADY_CLOSED', `${existing.reference} is already closed`, 409);
  }
  if (input.finding.trim() === '') {
    throw new DomainError(
      'FINDING_REQUIRED',
      'An investigation closed with no finding records only that somebody stopped looking.',
      422,
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'INVESTIGATION_FINDING',
    hash: input.evidenceHash,
    description: `${existing.reference} — ${input.finding.slice(0, 80)}`,
  });

  write(ctx, {
    eventType: 'INVESTIGATION_CLOSED',
    entity: { refType: 'InvestigationAction', refId: input.actionId },
    nextState: {
      ...existing,
      status: 'CLOSED',
      closedFinding: input.finding,
      closedBy: ctx.auth.actorId,
      closedAt: new Date().toISOString(),
    } as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
  });

  return { actionId: input.actionId };
}

export type Readiness = {
  covered: ImpactCategory[];
  uncovered: ImpactCategory[];
  percent: number;
};

/**
 * Due-diligence readiness.
 *
 * Coverage of impact categories by *live* surveys, against the full set. Not a
 * document count, per the deterministic flow: registering the same report three
 * times moves nothing, and a superseded or expired survey stops counting.
 */
export function dueDiligenceReadiness(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): Readiness {
  const covered = new Set<ImpactCategory>();
  for (const survey of liveSurveys(ctx, today)) {
    for (const category of survey.coverage) covered.add(category);
  }
  const uncovered = IMPACT_CATEGORY.filter((category) => !covered.has(category));
  return {
    covered: IMPACT_CATEGORY.filter((category) => covered.has(category)),
    uncovered: [...uncovered],
    percent: Math.round((covered.size / IMPACT_CATEGORY.length) * 100),
  };
}

/**
 * Why an option cannot yet be recommended.
 *
 * AC-C-WF-03-02, and the rule lives here rather than in the option module: the
 * constraints are here, and a second implementation over there would drift the
 * first time somebody added a severity.
 */
export function constraintAssessmentBlockedReason(ctx: EngineContext): string | null {
  const unassessed = constraintsOf(ctx).filter(
    (c) => c.severity === 'CRITICAL' && c.status !== 'ASSESSED',
  );
  if (unassessed.length === 0) return null;
  return (
    `${unassessed.length} critical constraint${unassessed.length === 1 ? '' : 's'} ` +
    `(${unassessed.map((c) => c.reference).join(', ')}) ${unassessed.length === 1 ? 'has' : 'have'} not been ` +
    'assessed. An option recommended over an unassessed critical constraint is a recommendation made ' +
    'without knowing whether the option is possible.'
  );
}

/**
 * Record a due-diligence review.
 *
 * The readiness figure is stored on the review rather than recomputed from it,
 * which is the one place this platform stores a derived number — deliberately.
 * The review is a statement about a moment: "on this date, with these surveys,
 * we were 58% covered and reviewed it anyway". Recomputing it later would
 * silently rewrite what the reviewers actually saw.
 */
export function reviewDueDiligence(ctx: EngineContext, input: { note: string }): {
  reviewId: string;
  version: number;
  readinessPercent: number;
} {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  if (surveysOf(ctx).length === 0) {
    throw new DomainError(
      'NOTHING_TO_REVIEW',
      'No survey has been registered. A due-diligence review over nothing is a signature on an empty page.',
      409,
    );
  }

  const readiness = dueDiligenceReadiness(ctx);
  const constraints = constraintsOf(ctx);
  const previous = ctx.ledger
    .list(ctx.projectId, 'DueDiligenceReview')
    .map((r) => r.state as unknown as DueDiligenceReviewState)
    .sort((a, b) => a.version - b.version)
    .at(-1);

  const reviewId = ulid();
  const state: DueDiligenceReviewState = {
    reviewId,
    projectId: ctx.projectId,
    version: (previous?.version ?? 0) + 1,
    coveredCategories: readiness.covered,
    uncoveredCategories: readiness.uncovered,
    readinessPercent: readiness.percent,
    constraintsAssessed: constraints.filter((c) => c.status === 'ASSESSED').length,
    constraintsOpen: constraints.filter((c) => c.status !== 'ASSESSED').length,
    investigationsOpen: investigationsOf(ctx).filter((a) => a.status === 'OPEN').length,
    note: input.note,
    reviewedBy: ctx.auth.actorId,
    reviewedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'DUE_DILIGENCE_REVIEWED',
    entity: { refType: 'DueDiligenceReview', refId: reviewId },
    nextState: state as unknown as Record<string, unknown>,
  });

  return { reviewId, version: state.version, readinessPercent: readiness.percent };
}

export type DueDiligencePosition = {
  surveys: number;
  liveSurveys: number;
  expiredSurveys: number;
  supersededSurveys: number;
  constraints: number;
  assessed: number;
  criticalOpen: number;
  investigationsOpen: number;
  investigationsOverdue: number;
  allowanceMinor: number;
  readiness: Readiness;
  lastReview?: DueDiligenceReviewState;
  optionBlocked: string | null;
};

/** The due-diligence position, derived on every read. */
export function dueDiligencePosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): DueDiligencePosition {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const surveys = surveysOf(ctx);
  const constraints = constraintsOf(ctx);
  const investigations = investigationsOf(ctx);

  return {
    surveys: surveys.length,
    liveSurveys: liveSurveys(ctx, today).length,
    expiredSurveys: surveys.filter(
      (s) => s.supersededBySurveyId === undefined && s.validUntil !== undefined && s.validUntil < today,
    ).length,
    supersededSurveys: surveys.filter((s) => s.supersededBySurveyId !== undefined).length,
    constraints: constraints.length,
    assessed: constraints.filter((c) => c.status === 'ASSESSED').length,
    criticalOpen: constraints.filter((c) => c.severity === 'CRITICAL' && c.status !== 'ASSESSED').length,
    investigationsOpen: investigations.filter((a) => a.status === 'OPEN').length,
    investigationsOverdue: investigations.filter((a) => a.status === 'OPEN' && a.dueDate < today).length,
    allowanceMinor: constraints.reduce((sum, c) => sum + (c.allowanceMinor ?? 0), 0),
    readiness: dueDiligenceReadiness(ctx, today),
    lastReview: ctx.ledger
      .list(ctx.projectId, 'DueDiligenceReview')
      .map((r) => r.state as unknown as DueDiligenceReviewState)
      .sort((a, b) => a.version - b.version)
      .at(-1),
    optionBlocked: constraintAssessmentBlockedReason(ctx),
  };
}
