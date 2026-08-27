import { DomainError } from '../core/errors.ts';
import { hashState } from '../core/canonical.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * C-WF-01 — project initiation and control configuration.
 *
 * What already exists and is not rebuilt: the project shell itself
 * (`structure.createProject`, which allocates the stable id, sets the phase to
 * CONCEPT and opens the first stage occupancy), the party and role register
 * (`platform.createUser` and `USER_ROLE_ASSIGNED`), maker-checker and party
 * separation (`identity/` and every gate clause that reads them), the CDE
 * (`informationcontrol.ts`), numbering (`documents/`), and the stage-gate
 * checklist (`stagegate.ts`). This module is the two things the workflow needs
 * that none of those provide.
 *
 * **The configuration is versioned, never edited.** The exception control says
 * changing configuration after approved outputs requires an impact assessment
 * and a new version, and that is only enforceable if the old version still
 * exists. So `ProjectConfiguration` is `creates: true` and each version is its
 * own record: version 1 is what the brief was baselined under, and version 2
 * cannot retroactively become what it was. A mutable configuration cannot
 * answer "under what rules was this approved", which is the only question it
 * gets asked two years later.
 *
 * **Jurisdiction, time zone and currency block baseline work.** Not a warning.
 * AC-C-WF-01-03 asks for dates in project time zone persisted as UTC, and a
 * project with no declared zone cannot satisfy it — every date it holds is
 * ambiguous by exactly the offset nobody wrote down. `configurationBlockedReason`
 * is what the brief baseline and the concept gate read.
 *
 * **The authority matrix is approved, not configured.** It says who may decide
 * what, so the act of setting it is itself an exercise of authority. It carries
 * the approver, and it is `creates: true` for the same reason the configuration
 * is: an approval given under one delegation is not evidence of an approval
 * under another.
 *
 * **A duplicate project code blocks creation.** The exception control, and it
 * is checked against the tenancy rather than the project: two projects sharing
 * a code is how a document reference collides, and the collision surfaces years
 * later as two drawings with the same number.
 *
 * AC-C-WF-01-01 — the platform operator cannot execute any of this — is not
 * enforced here and does not need to be. It is structural: `tenantContext` bars
 * the operator layer from customer delivery data before any command in this
 * file is reached, and `authorise` refuses `PROJECT_SETUP` to `PLATFORM_ADMIN`
 * because the permission matrix gives it none. Restating it here would be a
 * second opinion about the same rule.
 */

/** How dates are handled. Recorded so AC-C-WF-01-03 is checkable, not assumed. */
export type ProjectCalendar = {
  /** IANA zone, e.g. `Europe/London`. Dates render in this. */
  timeZone: string;
  /** Working days, ISO 1 (Monday) to 7 (Sunday). */
  workingDays: readonly number[];
  /** Public holidays observed, as ISO dates. */
  holidays: readonly string[];
};

export type ProjectConfigurationState = {
  configurationId: string;
  projectId: string;
  version: number;
  /** The versioned reference packs this project is governed by. */
  jurisdictionPack: string;
  classificationPack: string;
  contractCalendarPack: string;
  jurisdiction: string;
  calendar: ProjectCalendar;
  reportingCurrency: string;
  measurementSystem: 'METRIC' | 'IMPERIAL';
  projectCode: string;
  sponsorId: string;
  projectDirectorId: string;
  dataResidency: string;
  retentionYears: number;
  defaultSensitivity: string;
  /** Why this version exists. Version 1 says so; later ones carry the change. */
  reason: string;
  /**
   * The impact assessment behind a later version. Required from version 2 —
   * the exception control's whole point is that reconfiguring a running project
   * is not free, and the assessment is where somebody has to say what it costs.
   */
  impactAssessment?: string;
  supersedes?: string;
  configuredBy: string;
  configuredAt: string;
};

export type AuthorityDelegation = {
  /** What may be decided. Free text by design — this is the client's own matrix. */
  decision: string;
  /** Who may decide it, by user id. */
  holderId: string;
  /** Above this, it goes up. Absent means no financial limit on this delegation. */
  limitMinor?: number;
  /** Who it escalates to when the limit is exceeded. */
  escalatesToId?: string;
};

export type AuthorityMatrixState = {
  matrixId: string;
  projectId: string;
  version: number;
  configurationId: string;
  delegations: readonly AuthorityDelegation[];
  approvedBy: string;
  approvedAt: string;
  supersedes?: string;
};

const MEASUREMENT_SYSTEMS = new Set(['METRIC', 'IMPERIAL']);

/**
 * Is this a real IANA zone?
 *
 * Asked of the platform rather than of a list we maintain. `Intl` carries the
 * zone database the runtime actually uses, so a zone this accepts is a zone
 * every later `toLocaleString` will accept — which is the property that
 * matters. A hand-kept list would drift from it and would be wrong the first
 * time a zone was renamed.
 */
function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function configurationsOf(ctx: EngineContext): ProjectConfigurationState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ProjectConfiguration')
    .map((record) => record.state as unknown as ProjectConfigurationState)
    .filter((state) => state.projectId === ctx.projectId)
    .sort((a, b) => a.version - b.version);
}

/** The configuration in force, or undefined if the project has never been configured. */
export function currentConfiguration(ctx: EngineContext): ProjectConfigurationState | undefined {
  return configurationsOf(ctx).at(-1);
}

/**
 * Configure the project, or re-configure it.
 *
 * Version 1 is setup. Every later version is a change to a project that already
 * has approved work on it, so it requires an impact assessment and records what
 * it supersedes.
 */
export function versionConfiguration(
  ctx: EngineContext,
  input: {
    projectCode: string;
    jurisdiction: string;
    jurisdictionPack: string;
    classificationPack: string;
    contractCalendarPack: string;
    calendar: ProjectCalendar;
    reportingCurrency: string;
    measurementSystem: string;
    sponsorId: string;
    projectDirectorId: string;
    dataResidency: string;
    retentionYears: number;
    defaultSensitivity: string;
    reason: string;
    impactAssessment?: string;
  },
): { configurationId: string; version: number } {
  authorise(ctx, 'PROJECT_SETUP', 'C');

  if (!knownTimeZone(input.calendar.timeZone)) {
    throw new DomainError(
      'UNKNOWN_TIME_ZONE',
      `${input.calendar.timeZone} is not a time zone this platform can resolve. ` +
        'Every date on this project renders in it, so an unresolvable zone means every date is ambiguous.',
      422,
    );
  }
  if (!MEASUREMENT_SYSTEMS.has(input.measurementSystem)) {
    throw new DomainError('INVALID_MEASUREMENT_SYSTEM', 'Measurement system must be METRIC or IMPERIAL', 422);
  }
  if (input.calendar.workingDays.length === 0) {
    throw new DomainError(
      'NO_WORKING_DAYS',
      'A calendar with no working days makes every duration infinite. Name the days work happens on.',
      422,
    );
  }
  if (input.retentionYears <= 0) {
    throw new DomainError('INVALID_RETENTION', 'Retention must be a positive number of years', 422);
  }

  // The duplicate-code check, across the tenancy rather than the project. Two
  // projects sharing a code is how a document reference collides, and the
  // collision surfaces years later as two drawings with the same number.
  //
  // Scoped to the *current* version of each project's configuration: a code
  // released by a reconfiguration is free to be used again.
  const clash = ctx.ledger
    .entitiesOfType('ProjectConfiguration')
    .filter((record) => record.tenantId === ctx.tenantId)
    .map((record) => record.state as unknown as ProjectConfigurationState)
    .filter((state) => state.projectId !== ctx.projectId)
    .filter((state) => state.projectCode.trim().toUpperCase() === input.projectCode.trim().toUpperCase());
  if (clash.length > 0) {
    // The other project's own current version, not any version it ever had.
    const stillHeld = clash.some((candidate) => {
      const versions = ctx.ledger
        .entitiesOfType('ProjectConfiguration')
        .map((record) => record.state as unknown as ProjectConfigurationState)
        .filter((state) => state.projectId === candidate.projectId)
        .sort((a, b) => a.version - b.version);
      return versions.at(-1)?.projectCode.trim().toUpperCase() === input.projectCode.trim().toUpperCase();
    });
    if (stillHeld) {
      throw new DomainError(
        'DUPLICATE_PROJECT_CODE',
        `Project code ${input.projectCode} is already held by another project in this tenancy. ` +
          'Two projects on one code collide in every document reference derived from it.',
        409,
      );
    }
  }

  const previous = currentConfiguration(ctx);
  if (previous && (input.impactAssessment ?? '').trim() === '') {
    throw new DomainError(
      'IMPACT_ASSESSMENT_REQUIRED',
      'This project is already configured. Reconfiguring it after work has been approved against ' +
        `version ${previous.version} requires an impact assessment saying what the change reaches.`,
      422,
    );
  }
  if (input.reason.trim() === '') {
    throw new DomainError('REASON_REQUIRED', 'A configuration version must say why it exists', 422);
  }

  const configurationId = ulid();
  const version = (previous?.version ?? 0) + 1;
  const state: ProjectConfigurationState = {
    configurationId,
    projectId: ctx.projectId,
    version,
    jurisdiction: input.jurisdiction,
    jurisdictionPack: input.jurisdictionPack,
    classificationPack: input.classificationPack,
    contractCalendarPack: input.contractCalendarPack,
    calendar: input.calendar,
    reportingCurrency: input.reportingCurrency,
    measurementSystem: input.measurementSystem as 'METRIC' | 'IMPERIAL',
    projectCode: input.projectCode,
    sponsorId: input.sponsorId,
    projectDirectorId: input.projectDirectorId,
    dataResidency: input.dataResidency,
    retentionYears: input.retentionYears,
    defaultSensitivity: input.defaultSensitivity,
    reason: input.reason,
    impactAssessment: input.impactAssessment,
    supersedes: previous?.configurationId,
    configuredBy: ctx.auth.actorId,
    configuredAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'PROJECT_CONFIGURATION_VERSIONED',
    entity: { refType: 'ProjectConfiguration', refId: configurationId },
    nextState: state as unknown as Record<string, unknown>,
  });

  return { configurationId, version };
}

/**
 * Why baseline work cannot start.
 *
 * Read by the brief baseline and by the concept gate rather than duplicated in
 * either. The exception control names three fields; all three are structurally
 * required by `versionConfiguration`, so what this actually checks is that a
 * configuration exists at all — which is the case the workflow is guarding
 * against.
 */
export function configurationBlockedReason(ctx: EngineContext): string | null {
  const configuration = currentConfiguration(ctx);
  if (!configuration) {
    return 'The project has no configuration. Jurisdiction, time zone and reporting currency are undeclared, ' +
      'so no date or figure on this project has a defined meaning.';
  }
  if (configuration.reportingCurrency.trim() === '') return 'The configuration declares no reporting currency.';
  if (configuration.jurisdiction.trim() === '') return 'The configuration declares no jurisdiction.';
  return null;
}

function matricesOf(ctx: EngineContext): AuthorityMatrixState[] {
  return ctx.ledger
    .list(ctx.projectId, 'AuthorityMatrix')
    .map((record) => record.state as unknown as AuthorityMatrixState)
    .filter((state) => state.projectId === ctx.projectId)
    .sort((a, b) => a.version - b.version);
}

/** The authority matrix in force. */
export function currentAuthorityMatrix(ctx: EngineContext): AuthorityMatrixState | undefined {
  return matricesOf(ctx).at(-1);
}

/**
 * Approve the delegated authority matrix.
 *
 * Bound to the configuration version it was approved under. A matrix approved
 * against version 1 does not silently carry into version 2 as evidence of who
 * could decide what — the concept gate checks the binding, so reconfiguring a
 * project surfaces the matrix as needing re-approval rather than leaving a
 * stale delegation in force.
 */
export function approveAuthorityMatrix(
  ctx: EngineContext,
  input: { delegations: readonly AuthorityDelegation[] },
): { matrixId: string; version: number } {
  authorise(ctx, 'PROJECT_SETUP', 'A');

  const configuration = currentConfiguration(ctx);
  if (!configuration) {
    throw new DomainError(
      'NOT_CONFIGURED',
      'The project has no configuration. An authority matrix is a delegation under a set of project rules, ' +
        'and there are none to delegate under.',
      409,
    );
  }
  if (input.delegations.length === 0) {
    throw new DomainError(
      'NO_DELEGATIONS',
      'An empty authority matrix delegates nothing, which is not the same as delegating everything. ' +
        'Name at least one decision and who holds it.',
      422,
    );
  }

  for (const delegation of input.delegations) {
    if (delegation.decision.trim() === '') {
      throw new DomainError('DELEGATION_UNNAMED', 'Every delegation must name the decision it covers', 422);
    }
    if (delegation.holderId.trim() === '') {
      throw new DomainError(
        'DELEGATION_UNHELD',
        `"${delegation.decision}" names no holder. A decision nobody holds is a decision nobody makes.`,
        422,
      );
    }
    // A limit with nowhere to go is a dead end: the decision above it cannot be
    // taken by anyone, and the matrix would read as though it could.
    if (delegation.limitMinor !== undefined && (delegation.escalatesToId ?? '').trim() === '') {
      throw new DomainError(
        'ESCALATION_MISSING',
        `"${delegation.decision}" has a limit but names nobody above it. ` +
          'A limit with no escalation stops the decision rather than raising it.',
        422,
      );
    }
    if (delegation.escalatesToId !== undefined && delegation.escalatesToId === delegation.holderId) {
      throw new DomainError(
        'ESCALATION_SELF',
        `"${delegation.decision}" escalates to its own holder, which is not an escalation.`,
        422,
      );
    }
  }

  const previous = currentAuthorityMatrix(ctx);
  const matrixId = ulid();
  const state: AuthorityMatrixState = {
    matrixId,
    projectId: ctx.projectId,
    version: (previous?.version ?? 0) + 1,
    configurationId: configuration.configurationId,
    delegations: input.delegations,
    approvedBy: ctx.auth.actorId,
    approvedAt: new Date().toISOString(),
    supersedes: previous?.matrixId,
  };

  write(ctx, {
    eventType: 'AUTHORITY_MATRIX_APPROVED',
    entity: { refType: 'AuthorityMatrix', refId: matrixId },
    nextState: state as unknown as Record<string, unknown>,
  });

  return { matrixId, version: state.version };
}

/**
 * Why the authority position is not governed.
 *
 * Two failures, and the second is the one nobody notices: a matrix approved
 * under a superseded configuration. It reads as approved on every screen and
 * delegates authority under rules that have since changed.
 */
export function authorityBlockedReason(ctx: EngineContext): string | null {
  const configuration = currentConfiguration(ctx);
  if (!configuration) return 'The project has no configuration, so there is nothing to delegate under.';

  const matrix = currentAuthorityMatrix(ctx);
  if (!matrix) return 'No authority matrix has been approved. Nobody holds a named decision on this project.';

  if (matrix.configurationId !== configuration.configurationId) {
    return (
      `The authority matrix (v${matrix.version}) was approved under configuration v` +
      `${configurationsOf(ctx).find((c) => c.configurationId === matrix.configurationId)?.version ?? '?'}, ` +
      `and the project is now on v${configuration.version}. Re-approve it under the current rules.`
    );
  }
  return null;
}

export type InitiationPosition = {
  configuration?: ProjectConfigurationState;
  configurationVersions: number;
  authorityMatrix?: AuthorityMatrixState;
  /** A stable hash of the configuration in force, for the gate's cut-off check. */
  configurationHash?: string;
  configurationBlocked: string | null;
  authorityBlocked: string | null;
};

/** The initiation position, derived on every read. */
export function initiationPosition(ctx: EngineContext): InitiationPosition {
  const configuration = currentConfiguration(ctx);
  const matrix = currentAuthorityMatrix(ctx);
  return {
    configuration,
    configurationVersions: configurationsOf(ctx).length,
    authorityMatrix: matrix,
    configurationHash: configuration
      ? hashState(configuration as unknown as Record<string, unknown>)
      : undefined,
    configurationBlocked: configurationBlockedReason(ctx),
    authorityBlocked: authorityBlockedReason(ctx),
  };
}
