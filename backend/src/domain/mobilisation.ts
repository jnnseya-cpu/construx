import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { packageReadiness } from './designbaseline.ts';
import { ramsCurrencyBlockedReason } from './safetycontrol.ts';

/**
 * CN-WF-01 — mobilisation and start-work readiness.
 *
 * The first workflow of the construction stage, and the one every subsequent
 * failure traces back to. Work starts on a Monday because the programme said
 * Monday; the method statement is still in draft, the temporary works design
 * has not been checked, and the drawing the gang is working to was superseded
 * on the Friday. Nobody decided any of that. It happened because start was a
 * date rather than an authorisation.
 *
 * So a start here is an act, with a name on it. Four rules, each a refusal.
 *
 * **No authorisation over a failed critical prerequisite.** The specification
 * names five — design, RAMS, permit, temporary works, competence — and this
 * adds contractual authority and possession, because work you have no
 * possession of is not work you can authorise whatever the paperwork says.
 * Every one of them is either verified by the platform against a record it
 * holds, or declared by a person who is named. A tick on a screen with nothing
 * behind it is the whole failure mode.
 *
 * **What the platform can check, it checks.** A readiness check does not ask
 * whether the RAMS is approved; it looks. It does not ask whether the
 * operatives are ticketed; it reads the competency records and their expiry
 * dates against the window. What it cannot see — welfare, logistics, a survey,
 * whether the materials are actually on site — it takes as a declaration with a
 * name against it, and says on the record which of the two each answer was.
 *
 * **Conditional readiness expires.** "Ready with conditions" without a date is
 * how a condition becomes a permanent state of affairs. Every condition needs
 * an owner and a date, and the readiness itself needs an expiry after which the
 * authority it supports stops being current.
 *
 * **Changed information rechecks the authority.** The third exception control,
 * and derived rather than stamped: the authorisation records the exact
 * information revisions it was issued against, and the moment those move it is
 * reported as requiring recheck. A stored "still valid" flag is always the one
 * nobody updated.
 *
 * And `startBlockedReason` is what makes AC-CN-WF-01-02 real: a package
 * assessed and found Not Ready cannot have progress recorded against its tasks.
 * A package nobody has assessed is untouched — the acceptance criterion is
 * about Not Ready, and refusing work on packages this workflow has never seen
 * would be inventing a requirement rather than enforcing one.
 */

/**
 * The prerequisites a start is checked against.
 *
 * `critical` is the specification's own exception control: design, RAMS,
 * permit, temporary works and competence block an authorisation outright.
 * Contract and access are added to that list because possession and authority
 * to proceed are not conditions you can carry as an open action while people
 * are on site — the rest are conditions a conditional readiness can hold.
 */
export const PREREQUISITE = {
  CONTRACT: { critical: true, what: 'Executed contract or authorised notice to proceed', verifiable: false },
  ACCESS: { critical: true, what: 'Possession and access to the working area', verifiable: false },
  DESIGN: { critical: true, what: 'Approved construction information at a known revision', verifiable: true },
  RAMS: { critical: true, what: 'Approved risk assessment and method statement', verifiable: true },
  PERMIT: { critical: true, what: 'Permit to work where the activity requires one', verifiable: true },
  TEMPORARY_WORKS: { critical: true, what: 'Temporary works designed and independently checked', verifiable: true },
  COMPETENCE: { critical: true, what: 'The people are qualified and in date for the window', verifiable: true },
  ITP: { critical: false, what: 'Inspection and test plan for the package', verifiable: true },
  WELFARE: { critical: false, what: 'Welfare and emergency arrangements in place', verifiable: false },
  SURVEY: { critical: false, what: 'Setting out and pre-condition survey complete', verifiable: false },
  RESOURCE: { critical: false, what: 'Labour, plant and materials available', verifiable: false },
  LOGISTICS: { critical: false, what: 'Access route, storage and traffic management agreed', verifiable: false },
} as const;

export type PrerequisiteKind = keyof typeof PREREQUISITE;
export const PREREQUISITE_KINDS = Object.keys(PREREQUISITE) as PrerequisiteKind[];

export const READINESS = ['READY', 'READY_WITH_CONDITIONS', 'NOT_READY'] as const;
export type Readiness = (typeof READINESS)[number];

export type PrerequisiteResult = {
  kind: PrerequisiteKind;
  status: 'MET' | 'NOT_MET' | 'NOT_APPLICABLE';
  /** What was found, or why it does not apply. */
  detail: string;
  /**
   * How the answer was reached. `VERIFIED` means the platform read a record;
   * `DECLARED` means a person said so. The distinction is the point: an audit
   * six months later needs to know which of the twelve answers somebody typed.
   */
  source: 'VERIFIED' | 'DECLARED';
  /** Required on a declaration. Absent on a verification, which names itself. */
  declaredBy?: string;
};

export type ReadinessCondition = {
  what: string;
  owner: string;
  /** Time-bound, or it is a hope. */
  by: string;
};

type PlanState = {
  id: string;
  reference: string;
  site: string;
  items: Array<{ workPackageId: string; wbsCode: string; title: string; zone: string }>;
  openedAt: string;
  openedBy: string;
};

type CheckState = {
  id: string;
  reference: string;
  planId: string;
  workPackageId: string;
  wbsCode: string;
  zone: string;
  window: { from: string; to: string };
  prerequisites: PrerequisiteResult[];
  readiness: Readiness;
  conditions: ReadinessCondition[];
  expiresAt?: string;
  note: string;
  checkedAt: string;
  checkedBy: string;
};

type AuthorisationState = {
  id: string;
  reference: string;
  checkId: string;
  workPackageId: string;
  scope: string;
  location: string;
  window: { from: string; to: string };
  informationRevisions: Array<{ reference: string; revision: string; source: string }>;
  designPackageReference?: string;
  designFreezeReference?: string;
  approvedAt: string;
  approvedBy: string;
  revokedAt?: string;
  revokedReason?: string;
};

function requirePlan(ctx: EngineContext, planId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'MobilisationPlan', refId: planId });
  if (!record) throw new DomainError('MOBILISATION_PLAN_NOT_FOUND', `No mobilisation plan ${planId}`, 404);
  return record;
}

function requireCheck(ctx: EngineContext, checkId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'ReadinessCheck', refId: checkId });
  if (!record) throw new DomainError('READINESS_CHECK_NOT_FOUND', `No readiness check ${checkId}`, 404);
  return record;
}

const rows = (ctx: EngineContext, refType: string): Array<Record<string, unknown>> =>
  ctx.ledger.list(ctx.projectId, refType).map((record) => record.state);

// --- Step 1: the checklist --------------------------------------------------

export function openMobilisation(
  ctx: EngineContext,
  input: { reference: string; site: string; workPackageIds: string[]; zoneOf?: Record<string, string> },
): { planId: string; reference: string; items: number } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.site.trim()) {
    throw new DomainError('MOBILISATION_UNNAMED', 'A mobilisation plan names the site it is for and carries a reference.');
  }
  if (input.workPackageIds.length === 0) {
    throw new DomainError(
      'MOBILISATION_EMPTY',
      'A mobilisation plan over no work package readies nothing. The checklist is by package because start authority is ' +
        'by package — one plan covering "the site" authorises everything and therefore nothing.',
    );
  }

  const items = input.workPackageIds.map((workPackageId) => {
    const record = ctx.ledger.get({ refType: 'WorkPackage', refId: workPackageId });
    if (!record) throw new DomainError('WORK_PACKAGE_NOT_FOUND', `No work package ${workPackageId}`, 404);
    return {
      workPackageId,
      wbsCode: String(record.state.wbsCode),
      title: String(record.state.title),
      zone: input.zoneOf?.[workPackageId] ?? 'Site-wide',
    };
  });

  const planId = ulid();

  write(ctx, {
    eventType: 'MOBILISATION_STARTED',
    entity: { refType: 'MobilisationPlan', refId: planId },
    nextState: {
      id: planId,
      projectId: ctx.projectId,
      reference: input.reference.trim(),
      site: input.site.trim(),
      items,
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
  });

  return { planId, reference: input.reference.trim(), items: items.length };
}

// --- Step 2: what the platform can see for itself ---------------------------

/**
 * Verify every prerequisite the platform holds a record for.
 *
 * Exported and read-only, so the console can show a person what is already
 * satisfied before they start typing declarations. A screen that made somebody
 * re-answer what the platform already knows would teach them to answer without
 * looking, which is exactly the habit this workflow exists to break.
 */
export function verifyPrerequisites(
  ctx: EngineContext,
  input: {
    workPackageId: string;
    window: { from: string; to: string };
    /** The operatives the start covers. Their tickets are read, not assumed. */
    operativeIds?: string[];
    /** Where the package is built to a design package this project holds. */
    designPackageReference?: string;
    /** Where the activity needs a permit. Absent means it does not. */
    permitActivity?: string;
    /** The constructability review whose temporary works this package depends on. */
    temporaryWorksPackageReference?: string;
  },
): PrerequisiteResult[] {
  const results: PrerequisiteResult[] = [];

  // Design. Reused from D-WF-08 rather than re-derived — the question "is this
  // package's information current" already has one answer in the platform and a
  // second one here would eventually disagree with it.
  if (input.designPackageReference) {
    const readiness = packageReadiness(ctx, input.designPackageReference);
    results.push({
      kind: 'DESIGN',
      status: readiness.ready ? 'MET' : 'NOT_MET',
      detail: readiness.why,
      source: 'VERIFIED',
    });
  }

  // RAMS. Approved, and briefed out — an approved method statement nobody has
  // been briefed on is a document, and the briefing is the control.
  // Superseded revisions are excluded: the question is whether the *current*
  // method is approved and briefed, and CN-WF-07's currency check below covers
  // the case where a revision has left everybody on the old briefing.
  const rams = rows(ctx, 'RAMS').filter(
    (entry) => entry.workPackageId === input.workPackageId && entry.supersededBy === undefined,
  );
  if (rams.length === 0) {
    results.push({
      kind: 'RAMS',
      status: 'NOT_MET',
      detail: 'No method statement exists for this work package.',
      source: 'VERIFIED',
    });
  } else {
    const approved = rams.filter((entry) => entry.status === 'APPROVED');
    const briefed = approved.filter((entry) => ((entry.acknowledgements as unknown[]) ?? []).length > 0);
    // CN-WF-07's first exception control, reused rather than re-derived: a
    // revision nobody has been rebriefed on leaves the gang working to the
    // superseded method, which this check could not otherwise see.
    const stale = ramsCurrencyBlockedReason(ctx, input.workPackageId);
    results.push({
      kind: 'RAMS',
      status: briefed.length > 0 && stale === null ? 'MET' : 'NOT_MET',
      detail:
        stale !== null
          ? stale
          : approved.length === 0
            ? `${rams.length} method statement${rams.length === 1 ? '' : 's'} for this package, none approved.`
            : briefed.length === 0
              ? `${approved.length} approved, none briefed out. A method statement nobody has been briefed on is a document.`
              : `${briefed.length} approved and briefed.`,
      source: 'VERIFIED',
    });
  }

  // Permit. Only where the activity needs one, and it has to cover the window
  // rather than merely exist — a permit that lapses on the Wednesday does not
  // authorise Thursday.
  if (input.permitActivity) {
    const permits = rows(ctx, 'Permit').filter(
      (entry) => entry.activity === input.permitActivity && entry.status === 'ISSUED',
    );
    const covering = permits.filter(
      (entry) => String(entry.validFrom) <= input.window.from && String(entry.validTo) >= input.window.to,
    );
    results.push({
      kind: 'PERMIT',
      status: covering.length > 0 ? 'MET' : 'NOT_MET',
      detail:
        covering.length > 0
          ? `${String(covering[0]!.reference)} covers ${input.window.from} to ${input.window.to}.`
          : permits.length === 0
            ? `No ${input.permitActivity.toLowerCase().replace(/_/g, ' ')} permit has been issued.`
            : `${permits.length} permit(s) issued, none covering ${input.window.from} to ${input.window.to} in full.`,
      source: 'VERIFIED',
    });
  }

  // Temporary works. A BS 5975 category above 0 that nobody has checked is the
  // failure that collapses a formwork deck.
  if (input.temporaryWorksPackageReference) {
    const outstanding: string[] = [];
    let total = 0;
    for (const review of rows(ctx, 'ConstructabilityReview')) {
      if (review.packageReference !== input.temporaryWorksPackageReference) continue;
      for (const item of (review.temporaryWorks as Array<Record<string, unknown>>) ?? []) {
        total += 1;
        if (item.category !== '0' && item.status !== 'CHECKED') {
          outstanding.push(`${String(item.reference)} is category ${String(item.category)} and ${String(item.status).toLowerCase()}`);
        }
      }
    }
    results.push({
      kind: 'TEMPORARY_WORKS',
      status: outstanding.length === 0 ? 'MET' : 'NOT_MET',
      detail:
        outstanding.length === 0
          ? total === 0
            ? 'No temporary works interface is raised against this package.'
            : `All ${total} temporary works interface${total === 1 ? '' : 's'} designed and independently checked.`
          : outstanding.join('; ') + '.',
      source: 'VERIFIED',
    });
  }

  // Competence. Read from the tickets and their expiry dates against the whole
  // window, not against today.
  if (!input.operativeIds || input.operativeIds.length === 0) {
    // Never left unanswered. A start with nobody named against it cannot be
    // checked for competence at all, and an unanswerable question reported as
    // not applicable reads as satisfied to whoever scans the list.
    results.push({
      kind: 'COMPETENCE',
      status: 'NOT_MET',
      detail:
        'No operative is named against this start, so nothing can say whether the people doing the work are qualified for ' +
        'it or in date for the window.',
      source: 'VERIFIED',
    });
  } else {
    const competencies = rows(ctx, 'Competency');
    const failures: string[] = [];
    for (const operativeId of input.operativeIds) {
      const held = competencies.filter((entry) => entry.operativeId === operativeId);
      if (held.length === 0) {
        failures.push(`${operativeId} holds no recorded qualification`);
        continue;
      }
      const covering = held.filter((entry) => String(entry.expiresAt ?? '') >= input.window.to);
      if (covering.length === 0) {
        const latest = held.map((entry) => String(entry.expiresAt ?? '')).sort().at(-1);
        failures.push(`${operativeId}: every ticket expires by ${latest}, before the window ends ${input.window.to}`);
      }
    }
    results.push({
      kind: 'COMPETENCE',
      status: failures.length === 0 ? 'MET' : 'NOT_MET',
      detail:
        failures.length === 0
          ? `${input.operativeIds.length} operative${input.operativeIds.length === 1 ? '' : 's'} ticketed and in date to ${input.window.to}.`
          : failures.join('; ') + '.',
      source: 'VERIFIED',
    });
  }

  // The quality plan.
  const plans = rows(ctx, 'InspectionPlan').filter((entry) => entry.workPackageId === input.workPackageId);
  results.push({
    kind: 'ITP',
    status: plans.length > 0 ? 'MET' : 'NOT_MET',
    detail:
      plans.length > 0
        ? `${plans.length} inspection and test plan${plans.length === 1 ? '' : 's'} against this package.`
        : 'No inspection and test plan exists for this package.',
    source: 'VERIFIED',
  });

  return results;
}

// --- Steps 3 and 4: the readiness review ------------------------------------

export function checkReadiness(
  ctx: EngineContext,
  planId: string,
  input: {
    workPackageId: string;
    window: { from: string; to: string };
    operativeIds?: string[];
    designPackageReference?: string;
    permitActivity?: string;
    temporaryWorksPackageReference?: string;
    /** What only a person can answer. Each needs a name against it. */
    declarations: Array<{ kind: PrerequisiteKind; met: boolean; detail: string; declaredBy: string }>;
    conditions?: ReadinessCondition[];
    /** Required where the outcome is conditional. */
    expiresAt?: string;
    note: string;
  },
): { checkId: string; reference: string; readiness: Readiness; failing: PrerequisiteKind[] } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const plan = requirePlan(ctx, planId);
  const item = ((plan.state as unknown as PlanState).items ?? []).find(
    (entry) => entry.workPackageId === input.workPackageId,
  );
  if (!item) {
    throw new DomainError(
      'NOT_IN_MOBILISATION_PLAN',
      `${String(plan.state.reference)} does not cover this work package. Readying something the plan never listed would let ` +
        'the checklist be written after the fact, which is the same as not having one.',
      404,
    );
  }
  if (Number.isNaN(Date.parse(input.window.from)) || Number.isNaN(Date.parse(input.window.to))) {
    throw new DomainError('WINDOW_REQUIRED', 'A readiness check is against a window. Say when it starts and when it ends.');
  }
  if (input.window.to < input.window.from) {
    throw new DomainError('WINDOW_REQUIRED', 'The window ends before it begins.');
  }
  if (!input.note.trim()) {
    throw new DomainError('READINESS_UNEXPLAINED', 'Say what the review found. A disposition with no words behind it is a tick.');
  }

  const verified = verifyPrerequisites(ctx, {
    workPackageId: input.workPackageId,
    window: input.window,
    ...(input.operativeIds ? { operativeIds: input.operativeIds } : {}),
    ...(input.designPackageReference ? { designPackageReference: input.designPackageReference } : {}),
    ...(input.permitActivity ? { permitActivity: input.permitActivity } : {}),
    ...(input.temporaryWorksPackageReference
      ? { temporaryWorksPackageReference: input.temporaryWorksPackageReference }
      : {}),
  });
  const verifiedKinds = new Set(verified.map((entry) => entry.kind));

  // A declaration cannot overwrite a verification. Somebody typing "RAMS: yes"
  // over a platform that has read the record and found it in draft is the exact
  // failure the workflow is written against, and it is refused rather than
  // silently ignored — an ignored input is one somebody believes took effect.
  for (const declaration of input.declarations) {
    if (verifiedKinds.has(declaration.kind)) {
      throw new DomainError(
        'ALREADY_VERIFIED',
        `${declaration.kind.toLowerCase().replace(/_/g, ' ')} is read from the record rather than declared. The platform ` +
          `found: ${verified.find((entry) => entry.kind === declaration.kind)!.detail} A declaration over a verification is ` +
          'how a tick replaces a check.',
        409,
      );
    }
    if (!declaration.declaredBy.trim() || !declaration.detail.trim()) {
      throw new DomainError(
        'DECLARATION_UNATTRIBUTED',
        `The ${declaration.kind.toLowerCase().replace(/_/g, ' ')} declaration has no ${declaration.declaredBy.trim() ? 'detail' : 'name'} ` +
          'against it. A tick on a screen with nobody behind it is the whole failure mode.',
      );
    }
  }

  const declared: PrerequisiteResult[] = input.declarations.map((declaration) => ({
    kind: declaration.kind,
    status: declaration.met ? 'MET' : 'NOT_MET',
    detail: declaration.detail,
    source: 'DECLARED',
    declaredBy: declaration.declaredBy,
  }));

  const prerequisites = [...verified, ...declared];
  const answered = new Set(prerequisites.map((entry) => entry.kind));

  // Anything nobody has answered is NOT_MET, never absent. A silent
  // prerequisite reads as satisfied to whoever scans the list.
  for (const kind of PREREQUISITE_KINDS) {
    if (answered.has(kind)) continue;
    prerequisites.push({
      kind,
      status: PREREQUISITE[kind].verifiable ? 'NOT_APPLICABLE' : 'NOT_MET',
      detail: PREREQUISITE[kind].verifiable
        ? 'Not applicable to this package — nothing of this kind was named on the check.'
        : `Nobody has said whether ${PREREQUISITE[kind].what.toLowerCase()} is in place.`,
      source: 'VERIFIED',
    });
  }

  const failing = prerequisites
    .filter((entry) => entry.status === 'NOT_MET' && PREREQUISITE[entry.kind].critical)
    .map((entry) => entry.kind);
  const softFailing = prerequisites.filter(
    (entry) => entry.status === 'NOT_MET' && !PREREQUISITE[entry.kind].critical,
  );

  const readiness: Readiness =
    failing.length > 0 ? 'NOT_READY' : softFailing.length > 0 ? 'READY_WITH_CONDITIONS' : 'READY';

  if (readiness === 'READY_WITH_CONDITIONS') {
    const conditions = input.conditions ?? [];
    if (conditions.length === 0) {
      throw new DomainError(
        'CONDITIONS_REQUIRED',
        `${softFailing.map((entry) => entry.kind.toLowerCase().replace(/_/g, ' ')).join(', ')} ${softFailing.length === 1 ? 'is' : 'are'} ` +
          'not met, so this is ready with conditions. Name them, with an owner and a date each — a conditional readiness with ' +
          'no conditions on it is a readiness.',
      );
    }
    for (const condition of conditions) {
      if (!condition.owner.trim() || !condition.what.trim()) {
        throw new DomainError('CONDITION_UNBOUND', 'A condition names what has to happen and who has to do it.');
      }
      if (Number.isNaN(Date.parse(condition.by))) {
        throw new DomainError('CONDITION_UNBOUND', `"${condition.by}" is not a date. A condition with no date is a hope.`);
      }
    }
    // The specification's second exception control.
    if (!input.expiresAt || Number.isNaN(Date.parse(input.expiresAt))) {
      throw new DomainError(
        'READINESS_EXPIRY_REQUIRED',
        'A conditional readiness expires. Without a date it becomes a permanent state of affairs, and the conditions stop ' +
          'being conditions and become a description of the site.',
      );
    }
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'ReadinessCheck').length + 1;
  const reference = `RDY-${String(sequence).padStart(4, '0')}`;
  const checkId = ulid();

  const nextState = {
    id: checkId,
    projectId: ctx.projectId,
    reference,
    planId,
    workPackageId: input.workPackageId,
    wbsCode: item.wbsCode,
    zone: item.zone,
    window: input.window,
    prerequisites,
    readiness,
    conditions: input.conditions ?? [],
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.designPackageReference ? { designPackageReference: input.designPackageReference } : {}),
    note: input.note,
    checkedAt: new Date().toISOString(),
    checkedBy: ctx.auth.actorId,
  };

  // Two events rather than one with an answer inside it. Not ready is the fact
  // somebody needs to find in the ledger without opening state, and it is the
  // one that stops work.
  if (readiness === 'NOT_READY') {
    write(ctx, {
      eventType: 'WORK_NOT_READY',
      entity: { refType: 'ReadinessCheck', refId: checkId },
      nextState,
    });
  } else {
    write(ctx, {
      eventType: 'READINESS_CHECK_COMPLETED',
      entity: { refType: 'ReadinessCheck', refId: checkId },
      nextState,
    });
  }

  return { checkId, reference, readiness, failing };
}

// --- Step 5: the start authority --------------------------------------------

export function authoriseStart(
  ctx: EngineContext,
  checkId: string,
  input: {
    /** AC-CN-WF-01-03: the four things an authority has to identify. */
    scope: string;
    location: string;
    window: { from: string; to: string };
    /** The exact revisions this start is against. */
    informationRevisions: Array<{ reference: string; revision: string; source: string }>;
  },
): { authorisationId: string; reference: string; conditional: boolean } {
  // Approve, not create. Authorising a start is somebody taking responsibility
  // for people going to work, and the specification is explicit that no agent
  // mandate reaches it.
  authorise(ctx, 'FIELD_EXECUTION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireCheck(ctx, checkId);
  const check = record.state as unknown as CheckState;

  if (check.readiness === 'NOT_READY') {
    const failing = check.prerequisites.filter(
      (entry) => entry.status === 'NOT_MET' && PREREQUISITE[entry.kind].critical,
    );
    throw new DomainError(
      'NOT_READY',
      `${check.reference} found ${check.wbsCode} not ready: ${failing.map((entry) => `${entry.kind.toLowerCase().replace(/_/g, ' ')} — ${entry.detail}`).join(' ')} ` +
        'A start authorised over a failed critical prerequisite is the decision nobody remembers taking when it is ' +
        'investigated afterwards.',
      409,
    );
  }

  if (!input.scope.trim() || !input.location.trim()) {
    throw new DomainError(
      'AUTHORITY_UNSCOPED',
      'A start authority names the scope and the location it covers. "Start work" covers the whole site, which is the same ' +
        'as covering nothing.',
    );
  }
  if (Number.isNaN(Date.parse(input.window.from)) || Number.isNaN(Date.parse(input.window.to))) {
    throw new DomainError('AUTHORITY_UNSCOPED', 'A start authority runs between two dates. Say which.');
  }
  if (input.window.from < check.window.from || input.window.to > check.window.to) {
    throw new DomainError(
      'WINDOW_EXCEEDS_CHECK',
      `${check.reference} assessed ${check.window.from} to ${check.window.to}. An authority running outside the window that ` +
        'was checked is authorised against conditions nobody looked at.',
      409,
    );
  }
  if (check.expiresAt && check.expiresAt < input.window.to) {
    throw new DomainError(
      'READINESS_EXPIRED',
      `${check.reference} is conditional and expires ${check.expiresAt}, before this authority ends ${input.window.to}. ` +
        'The expiry is what stops a condition becoming permanent; authorising past it would remove it.',
      409,
    );
  }
  if (input.informationRevisions.length === 0) {
    throw new DomainError(
      'INFORMATION_REVISIONS_REQUIRED',
      'A start authority names the exact revisions it is issued against. Without them nothing can tell, later, whether the ' +
        'gang was working to the drawing that was superseded on the Friday.',
    );
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'StartWorkAuthorisation').length + 1;
  const reference = `SWA-${String(sequence).padStart(4, '0')}`;
  const authorisationId = ulid();

  // Held so the third exception control can compare later without asking
  // anybody what the information looked like at the time.
  const designPackageReference = (record.state as Record<string, unknown>).designPackageReference;
  const freeze =
    typeof designPackageReference === 'string' ? packageReadiness(ctx, designPackageReference) : undefined;

  write(ctx, {
    eventType: 'START_WORK_AUTHORISED',
    entity: { refType: 'StartWorkAuthorisation', refId: authorisationId },
    nextState: {
      id: authorisationId,
      projectId: ctx.projectId,
      reference,
      checkId,
      workPackageId: check.workPackageId,
      wbsCode: check.wbsCode,
      scope: input.scope,
      location: input.location,
      window: input.window,
      informationRevisions: input.informationRevisions,
      ...(typeof designPackageReference === 'string' ? { designPackageReference } : {}),
      ...(freeze?.freezeReference ? { designFreezeReference: freeze.freezeReference } : {}),
      conditional: check.readiness === 'READY_WITH_CONDITIONS',
      conditions: check.conditions,
      ...(check.expiresAt ? { expiresAt: check.expiresAt } : {}),
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.auth.actorId,
    },
  });

  return { authorisationId, reference, conditional: check.readiness === 'READY_WITH_CONDITIONS' };
}

/**
 * Withdraw a start authority.
 *
 * Not a deletion — the ledger has no such thing and the authority may have been
 * relied on. Revoking says work stops from now, and the record of what was
 * authorised, and against which revisions, stays exactly where it was.
 */
export function revokeAuthorisation(
  ctx: EngineContext,
  authorisationId: string,
  input: { reason: string },
): { revoked: true } {
  authorise(ctx, 'FIELD_EXECUTION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'StartWorkAuthorisation', refId: authorisationId });
  if (!record) throw new DomainError('AUTHORISATION_NOT_FOUND', `No start authority ${authorisationId}`, 404);
  if (record.state.revokedAt) {
    throw new DomainError('ALREADY_REVOKED', `${String(record.state.reference)} was already withdrawn.`);
  }
  if (!input.reason.trim()) {
    throw new DomainError('REVOCATION_UNEXPLAINED', 'Say why the authority is being withdrawn. People are working under it.');
  }

  write(ctx, {
    eventType: 'START_WORK_AUTHORISED',
    entity: { refType: 'StartWorkAuthorisation', refId: authorisationId },
    nextState: {
      ...record.state,
      revokedAt: new Date().toISOString(),
      revokedBy: ctx.auth.actorId,
      revokedReason: input.reason,
    },
  });

  return { revoked: true };
}

// --- AC-CN-WF-01-02: Not Ready prevents work --------------------------------

/**
 * Why work on this package cannot start, or null.
 *
 * Called by `recordProgress` before a task moves to in progress. The rule is
 * exactly the acceptance criterion and no wider: a package **assessed and found
 * not ready** is stopped. A package this workflow has never seen is untouched,
 * because refusing work on every package of every project that does not run
 * mobilisation would be inventing a requirement rather than enforcing one.
 */
export function startBlockedReason(
  ctx: EngineContext,
  workPackageId: string,
  today = new Date().toISOString().slice(0, 10),
): string | null {
  const checks = ctx.ledger
    .list(ctx.projectId, 'ReadinessCheck')
    .map((record) => record.state as unknown as CheckState)
    .filter((check) => check.workPackageId === workPackageId);

  if (checks.length === 0) return null;

  const latest = checks[checks.length - 1]!;
  if (latest.readiness === 'NOT_READY') {
    const failing = latest.prerequisites.filter(
      (entry) => entry.status === 'NOT_MET' && PREREQUISITE[entry.kind].critical,
    );
    return (
      `${latest.reference} found ${latest.wbsCode} not ready: ` +
      `${failing.map((entry) => entry.kind.toLowerCase().replace(/_/g, ' ')).join(', ')}. Work cannot be progressed against ` +
      'it until the check is redone and passes.'
    );
  }

  if (latest.expiresAt && latest.expiresAt < today) {
    return (
      `${latest.reference} was conditional and expired on ${latest.expiresAt}. The expiry is what stops a condition becoming ` +
      'permanent, so the check has to be redone before work continues.'
    );
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type MobilisationPosition = {
  plans: Array<{ planId: string; reference: string; site: string; packages: number; checked: number }>;
  checks: Array<{
    checkId: string;
    reference: string;
    wbsCode: string;
    zone: string;
    readiness: Readiness;
    failing: string[];
    conditions: ReadinessCondition[];
    expiresAt?: string;
    expired: boolean;
    /** How many answers a person typed rather than the platform read. */
    declared: number;
  }>;
  authorisations: Array<{
    authorisationId: string;
    reference: string;
    wbsCode: string;
    scope: string;
    location: string;
    window: { from: string; to: string };
    approvedBy: string;
    revoked: boolean;
    /** Set where the information it was issued against has since moved. */
    requiresRecheck?: string;
  }>;
  /** Conditions past their date on a readiness nothing has replaced. */
  overdueConditions: Array<{ check: string; what: string; owner: string; by: string }>;
  summary: string;
};

export function mobilisationPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): MobilisationPosition {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const overdueConditions: MobilisationPosition['overdueConditions'] = [];

  const checkRecords = ctx.ledger
    .list(ctx.projectId, 'ReadinessCheck')
    .map((record) => record.state as unknown as CheckState);

  const checks = checkRecords.map((check) => {
    for (const condition of check.conditions) {
      if (condition.by.slice(0, 10) < today) {
        overdueConditions.push({ check: check.reference, what: condition.what, owner: condition.owner, by: condition.by });
      }
    }
    return {
      checkId: check.id,
      reference: check.reference,
      wbsCode: check.wbsCode,
      zone: check.zone,
      readiness: check.readiness,
      failing: check.prerequisites
        .filter((entry) => entry.status === 'NOT_MET')
        .map((entry) => entry.kind.toLowerCase().replace(/_/g, ' ')),
      conditions: check.conditions,
      ...(check.expiresAt ? { expiresAt: check.expiresAt } : {}),
      expired: check.expiresAt !== undefined && check.expiresAt < today,
      declared: check.prerequisites.filter((entry) => entry.source === 'DECLARED').length,
    };
  });

  const plans = ctx.ledger.list(ctx.projectId, 'MobilisationPlan').map((record) => {
    const plan = record.state as unknown as PlanState;
    const covered = new Set(
      checkRecords.filter((check) => check.planId === plan.id).map((check) => check.workPackageId),
    );
    return {
      planId: plan.id,
      reference: plan.reference,
      site: plan.site,
      packages: plan.items.length,
      checked: plan.items.filter((item) => covered.has(item.workPackageId)).length,
    };
  });

  const authorisations = ctx.ledger.list(ctx.projectId, 'StartWorkAuthorisation').map((record) => {
    const state = record.state as unknown as AuthorisationState & { conditional?: boolean };

    // The third exception control, derived. If the design information this
    // authority was issued against has moved, the authority needs rechecking —
    // and the platform says so without anybody having remembered to run
    // anything.
    let requiresRecheck: string | undefined;
    if (state.designPackageReference && !state.revokedAt) {
      const now = packageReadiness(ctx, state.designPackageReference);
      if (state.designFreezeReference && now.freezeReference !== state.designFreezeReference) {
        requiresRecheck = `Issued against ${state.designFreezeReference}; the package now stands at ${now.freezeReference ?? 'no freeze at all'}.`;
      } else if (!now.ready) {
        requiresRecheck = now.why;
      }
    }

    return {
      authorisationId: state.id,
      reference: state.reference,
      wbsCode: String((record.state as Record<string, unknown>).wbsCode ?? ''),
      scope: state.scope,
      location: state.location,
      window: state.window,
      approvedBy: state.approvedBy,
      revoked: state.revokedAt !== undefined,
      ...(requiresRecheck ? { requiresRecheck } : {}),
    };
  });

  const notReady = checks.filter((check) => check.readiness === 'NOT_READY').length;
  const recheck = authorisations.filter((entry) => entry.requiresRecheck !== undefined).length;

  const parts = [`${plans.length} mobilisation plan${plans.length === 1 ? '' : 's'}`];
  if (checks.length > 0) parts.push(`${checks.length} readiness check${checks.length === 1 ? '' : 's'}`);
  if (notReady > 0) parts.push(`${notReady} not ready`);
  if (recheck > 0) parts.push(`${recheck} start authorit${recheck === 1 ? 'y' : 'ies'} issued against information that has moved`);
  if (overdueConditions.length > 0) parts.push(`${overdueConditions.length} condition(s) past their date`);

  return { plans, checks, authorisations, overdueConditions, summary: parts.join(', ') + '.' };
}
