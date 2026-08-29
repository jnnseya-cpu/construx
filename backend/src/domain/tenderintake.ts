import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import {
  addBusinessDays,
  businessDayOnOrBefore,
  businessDaysBetween,
  DEFAULT_CALENDAR,
  type BusinessCalendar,
} from '../engines/maths/constructionAct.ts';
import type { Role } from '../identity/roles.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * Tender intake — T-WF-01.
 *
 * The pipeline already scored opportunities and decided whether to chase them,
 * and the ITT analyst already read an invitation into a compliance matrix with
 * an owner on every line. What sat between them was nothing at all: the moment
 * an invitation actually lands.
 *
 * Three things go wrong in that moment, and all three cost the whole bid.
 *
 * **The deadline is a wall-clock reading, not an instant.** An ITT says "12:00
 * noon on 14 October". Whose noon is a question almost nobody asks, and a
 * portal that closes at noon in Dublin has closed an hour before noon in
 * London. So the deadline is recorded as a local reading *plus* a named zone,
 * resolved to a single instant, and where the invitation did not state a zone
 * that fact is recorded and raised as a Critical clarification rather than
 * quietly assumed. Everything downstream counts down from the instant.
 *
 * **The invitation is immutable and the addenda are not corrections to it.**
 * An addendum that moves the return date does not overwrite the original — it
 * is appended, and the position reports the deadline in force with the history
 * behind it. A bid team that cannot say what the deadline was last Tuesday
 * cannot answer the only question that matters after a late submission.
 *
 * **A mandatory deliverable with no owner is how bids are lost.** Not lost on
 * price — disqualified, with a correct price inside, because one certificate
 * was not in the upload. `AC-T-WF-01-01` asks for a source, an owner and an
 * internal date on every mandatory deliverable, and this module refuses to
 * record a decision to bid until all three are present on all of them.
 *
 * ---
 *
 * **What this reuses rather than rebuilds.** The compliance matrix is
 * `analyseITT` — the requirement catalogue, the owner-by-category table, the
 * evidence probes and the commercial-term assessment already existed and are
 * called, not copied. The bid/no-bid decision is `decideBidNoBid`, extended
 * with the conditions, dissent and delegated authority `AC-T-WF-01-02` asks
 * for. The back-planning calendar is the Construction Act business-day
 * calendar, bank holidays and all. Three new things exist here: the zoned
 * deadline, the deliverable register, and the bid programme.
 *
 * **The event names.** `TENDER_RECEIVED` and `TENDER_PROGRAMME_CREATED` are the
 * specification's own names for acts that did not exist, so they take them. The
 * specification's `COMPLIANCE_MATRIX_CREATED` and `BID_DECISION_RECORDED` are
 * `ITT_ANALYSED` and `BID_NO_BID_DECIDED` here, already written to an
 * append-only ledger under those names. They are mapped, not renamed: renaming
 * an event orphans every record already carrying the old name.
 */

// --- Source anchors ----------------------------------------------------------

/**
 * Where a requirement came from.
 *
 * The whole point of `AC-T-WF-01-01` is that a requirement can be checked back
 * against the document that imposed it. A reference with no document behind it
 * is a note, and the argument on the day before return is always about whether
 * the buyer really asked for the thing.
 */
export type SourceAnchor = {
  /** The document as the invitation names it. */
  document: string;
  /** Clause, paragraph or question number. */
  clause?: string;
  page?: number;
};

/**
 * A local reading as somebody says it, not as ISO writes it.
 *
 * These strings are put in front of a bid manager, and `2027-03-12T12:00` in
 * the middle of a sentence reads as machine output — which is how a genuine
 * critical clarification gets skimmed past.
 */
function readable(reading: string): string {
  return reading.replace('T', ' ');
}

export function describeSource(source: SourceAnchor | undefined): string {
  if (!source) return 'no source recorded';
  const parts = [source.document];
  if (source.clause) parts.push(`cl. ${source.clause}`);
  if (source.page !== undefined) parts.push(`p. ${source.page}`);
  return parts.join(', ');
}

// --- Time zones --------------------------------------------------------------

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timeZone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    throw new DomainError(
      'TIME_ZONE_UNKNOWN',
      `${timeZone} is not a time zone this platform recognises. Use an IANA name such as Europe/London or Europe/Dublin.`,
    );
  }
  FORMATTERS.set(timeZone, formatter);
  return formatter;
}

/**
 * The wall-clock reading in a zone at an instant, expressed as the epoch value
 * that reading would have if it were UTC. Comparing that against the wall clock
 * asked for is what makes the resolution verifiable rather than assumed.
 */
function wallClock(instant: number, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(instant));
  const at = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // Some ICU builds render midnight as hour 24 under hour12:false.
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'));
}

/** A local reading that is not a single instant, because the clocks moved. */
export type ZoneAnomaly = 'SKIPPED' | 'AMBIGUOUS';

export type ZonedInstant = {
  /** What the invitation said, e.g. `2026-10-14T12:00`. */
  local: string;
  timeZone: string;
  /** The single instant it resolves to, in UTC. */
  instant: string;
  offsetMinutes: number;
  anomaly?: ZoneAnomaly;
};

const HALF_DAY_MS = 12 * 60 * 60 * 1000;

/**
 * Resolve a local reading in a named zone to one instant.
 *
 * Twice a year a local reading is not one instant. On the night the clocks go
 * back, 01:30 happens twice; on the night they go forward, 01:30 does not
 * happen at all. Both are recorded as anomalies rather than silently picked,
 * and where there is a choice the **earlier** instant is taken — a deadline
 * resolved early is a bid submitted early, and the other way round is a bid
 * submitted late.
 */
export function resolveZonedInstant(local: string, timeZone: string): ZonedInstant {
  const naive = Date.parse(`${local}Z`);
  if (Number.isNaN(naive)) {
    throw new DomainError(
      'DEADLINE_UNREADABLE',
      `"${local}" is not a local date and time. Give it as YYYY-MM-DDTHH:MM, without a zone suffix — the zone is named separately.`,
    );
  }

  // The offsets in force either side of any transition near this reading.
  const offsets = [wallClock(naive - HALF_DAY_MS, timeZone) - (naive - HALF_DAY_MS), wallClock(naive + HALF_DAY_MS, timeZone) - (naive + HALF_DAY_MS)];
  const candidates = [...new Set(offsets.map((offset) => naive - offset))]
    .filter((instant) => wallClock(instant, timeZone) === naive)
    .sort((a, b) => a - b);

  if (candidates.length === 1) {
    const instant = candidates[0]!;
    return { local, timeZone, instant: new Date(instant).toISOString(), offsetMinutes: (naive - instant) / 60_000 };
  }
  if (candidates.length > 1) {
    const instant = candidates[0]!;
    return {
      local,
      timeZone,
      instant: new Date(instant).toISOString(),
      offsetMinutes: (naive - instant) / 60_000,
      anomaly: 'AMBIGUOUS',
    };
  }

  // The reading never occurred. Take the earlier of the two possible instants,
  // which falls before the gap rather than after it.
  const instant = Math.min(...offsets.map((offset) => naive - offset));
  return {
    local,
    timeZone,
    instant: new Date(instant).toISOString(),
    offsetMinutes: (naive - instant) / 60_000,
    anomaly: 'SKIPPED',
  };
}

// --- Deliverables ------------------------------------------------------------

export const SUBMISSION_CHANNEL = ['PORTAL', 'EMAIL', 'PHYSICAL', 'HAND_DELIVERY'] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNEL)[number];

/**
 * One thing the invitation requires to be returned.
 *
 * Separate from the compliance matrix on purpose. A requirement is something
 * the bid must satisfy; a deliverable is a file that must be in the upload by a
 * date, with a page limit and possibly a wet signature. They are checked by
 * different people at different times, and conflating them is why the page
 * limit is discovered on the last afternoon.
 */
export type TenderDeliverable = {
  reference: string;
  title: string;
  mandatory: boolean;
  /** What the buyer will accept — PDF, native spreadsheet, a signed original. */
  format?: string;
  pageLimit?: number;
  fileSizeLimitMb?: number;
  /** A wet or qualified signature, which is a lead time rather than a task. */
  signatureRequired?: boolean;
  /** A bond or guarantee, which is a broker's lead time and a cost. */
  bondRequired?: boolean;
  channel?: SubmissionChannel;
  /** The role that owns producing it. */
  owner?: Role;
  /** Our own date, which is earlier than the buyer's and is the one that binds. */
  internalDueBy?: string;
  source?: SourceAnchor;
};

// --- Clarifications ----------------------------------------------------------

export const CLARIFICATION_SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type ClarificationSeverity = (typeof CLARIFICATION_SEVERITY)[number];

export type Clarification = {
  severity: ClarificationSeverity;
  subject: string;
  /** What to ask the buyer, in the words it would be asked in. */
  question: string;
};

// --- Recording the invitation ------------------------------------------------

type InvitationInput = {
  /** The buyer's own reference for the tender. */
  reference: string;
  /** When the invitation was issued, as an instant. Immutable thereafter. */
  issuedAt: string;
  /** The return deadline as the invitation states it, e.g. `2026-10-14T12:00`. */
  returnLocal: string;
  /** IANA zone the deadline is read in. */
  timeZone: string;
  /**
   * Whether the invitation actually stated a zone. False means the zone above
   * is an assumption, and an assumption about a deadline is a Critical
   * clarification rather than a note.
   */
  timeZoneStated: boolean;
  channel: SubmissionChannel;
  /** Deadline for questions to the buyer, where one is stated. */
  clarificationLocal?: string;
  /** Site visit or mid-tender interview, where one is offered. */
  siteVisitLocal?: string;
  /** What the transmittal actually contained. */
  documents?: string[];
  notes?: string;
};

function requireOpportunityRecord(ctx: EngineContext, opportunityId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'Opportunity', refId: opportunityId });
  if (!record) throw new DomainError('OPPORTUNITY_NOT_FOUND', `No opportunity ${opportunityId}`, 404);
  return record;
}

function requireInvitation(ctx: EngineContext, invitationId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'TenderInvitation', refId: invitationId });
  if (!record) throw new DomainError('TENDER_NOT_FOUND', `No tender invitation ${invitationId}`, 404);
  return record;
}

/**
 * Register the invitation and its deadline.
 *
 * Deliberately takes no requirements. The deadline is registered the hour the
 * ITT lands, by whoever opened the email, before anybody has read a word of it
 * — which is the only way the countdown is honest. Requirements arrive
 * afterwards, through `extractRequirements`.
 */
export function recordInvitation(
  ctx: EngineContext,
  opportunityId: string,
  input: InvitationInput,
): { invitationId: string; deadline: ZonedInstant; clarifications: Clarification[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const opportunity = requireOpportunityRecord(ctx, opportunityId);

  const existing = ctx.ledger
    .list(opportunity.projectId, 'TenderInvitation')
    .find((r) => r.state.opportunityId === opportunityId);
  if (existing) {
    throw new DomainError(
      'TENDER_ALREADY_RECORDED',
      `This opportunity already has invitation ${String(existing.state.reference)} recorded. An invitation is amended by addendum, never re-recorded.`,
    );
  }

  const deadline = resolveZonedInstant(input.returnLocal, input.timeZone);
  const clarification = input.clarificationLocal ? resolveZonedInstant(input.clarificationLocal, input.timeZone) : undefined;
  const siteVisit = input.siteVisitLocal ? resolveZonedInstant(input.siteVisitLocal, input.timeZone) : undefined;

  const issuedAt = Date.parse(input.issuedAt);
  if (Number.isNaN(issuedAt)) {
    throw new DomainError('ISSUE_DATE_UNREADABLE', `"${input.issuedAt}" is not a date and time the platform can read`);
  }
  if (Date.parse(deadline.instant) <= issuedAt) {
    throw new DomainError(
      'DEADLINE_BEFORE_ISSUE',
      'The return deadline is at or before the moment the invitation was issued. One of the two dates is wrong.',
    );
  }

  const clarifications = deadlineClarifications({ deadline, clarification, siteVisit, timeZoneStated: input.timeZoneStated });

  const invitationId = ulid();
  write(ctx, {
    projectId: opportunity.projectId,
    eventType: 'TENDER_RECEIVED',
    entity: { refType: 'TenderInvitation', refId: invitationId },
    nextState: {
      id: invitationId,
      tenantId: ctx.tenantId,
      opportunityId,
      reference: input.reference,
      clientName: opportunity.state.clientName,
      title: opportunity.state.title,
      // The issue is immutable. Addenda append; they never rewrite this.
      issue: {
        issuedAt: new Date(issuedAt).toISOString(),
        returnDeadline: deadline,
        clarificationDeadline: clarification,
        siteVisit,
        channel: input.channel,
        documents: input.documents ?? [],
        timeZoneStated: input.timeZoneStated,
      },
      addenda: [],
      deliverables: [],
      requirementsExtracted: false,
      clarifications,
      notes: input.notes,
      recordedAt: new Date().toISOString(),
      recordedBy: ctx.auth.actorId,
    },
  });

  return { invitationId, deadline, clarifications };
}

/**
 * The clarifications a set of dates raises on its own, before anybody has read
 * the requirements.
 *
 * Every one of these is a question for the buyer rather than a defect in our
 * own data, which is why they are recorded and reported instead of refused.
 */
function deadlineClarifications(input: {
  deadline: ZonedInstant;
  clarification?: ZonedInstant;
  siteVisit?: ZonedInstant;
  timeZoneStated: boolean;
}): Clarification[] {
  const out: Clarification[] = [];

  if (!input.timeZoneStated) {
    out.push({
      severity: 'CRITICAL',
      subject: 'Time zone not stated',
      question: `The invitation gives a return time of ${readable(input.deadline.local)} without naming a time zone. It has been taken as ${input.deadline.timeZone}. Please confirm the zone the portal closes in.`,
    });
  }

  if (input.deadline.anomaly === 'AMBIGUOUS') {
    out.push({
      severity: 'CRITICAL',
      subject: 'Return time occurs twice',
      question: `${readable(input.deadline.local)} occurs twice in ${input.deadline.timeZone} on the night the clocks go back. It has been taken as the earlier of the two. Please confirm which is intended.`,
    });
  }
  if (input.deadline.anomaly === 'SKIPPED') {
    out.push({
      severity: 'CRITICAL',
      subject: 'Return time does not exist',
      question: `${readable(input.deadline.local)} does not occur in ${input.deadline.timeZone} — the clocks go forward across it. Please confirm the intended return time.`,
    });
  }

  if (input.clarification && Date.parse(input.clarification.instant) >= Date.parse(input.deadline.instant)) {
    out.push({
      severity: 'CRITICAL',
      subject: 'Question deadline is not before the return',
      question: `The deadline for questions (${readable(input.clarification.local)}) is at or after the return deadline (${readable(input.deadline.local)}). Please confirm the date for questions.`,
    });
  }

  if (input.siteVisit && Date.parse(input.siteVisit.instant) >= Date.parse(input.deadline.instant)) {
    out.push({
      severity: 'MAJOR',
      subject: 'Site visit is after the return',
      question: `The site visit (${readable(input.siteVisit.local)}) falls at or after the return deadline. A price submitted before the visit carries whatever the visit would have found.`,
    });
  }

  return out;
}

// --- Requirements and the compliance matrix ----------------------------------

/**
 * Record the deliverables and bind the compliance matrix to the invitation.
 *
 * The matrix itself is produced by `analyseITT`, which is called by the route
 * rather than from here — the analyst is an existing engine with its own
 * authorisation, its own ACU cost and its own tests, and wrapping it would give
 * this module a second opinion about requirements.
 */
export function extractRequirements(
  ctx: EngineContext,
  invitationId: string,
  input: {
    deliverables: TenderDeliverable[];
    /** The id of the `analyseITT` run that produced the compliance matrix. */
    analysisId: string;
  },
): { deliverables: number; blockers: string[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireInvitation(ctx, invitationId);

  if (input.deliverables.length === 0) {
    throw new DomainError(
      'DELIVERABLES_EMPTY',
      'An invitation with no return deliverables has not been read. Every ITT asks for something back.',
    );
  }

  const references = new Set<string>();
  for (const deliverable of input.deliverables) {
    if (references.has(deliverable.reference)) {
      throw new DomainError('DELIVERABLE_DUPLICATE', `Deliverable ${deliverable.reference} is listed twice`);
    }
    references.add(deliverable.reference);
  }

  const returnDeadline = deadlineInForce(record.state);
  const conflicts: Clarification[] = [];
  for (const deliverable of input.deliverables) {
    if (deliverable.internalDueBy && `${deliverable.internalDueBy}T00:00:00Z` > returnDeadline.instant) {
      conflicts.push({
        severity: 'CRITICAL',
        subject: `${deliverable.reference} is due after the return`,
        question: `${deliverable.title} carries an internal date of ${deliverable.internalDueBy}, which is after the return deadline of ${readable(returnDeadline.local)}. The internal date has to move.`,
      });
    }
  }

  write(ctx, {
    projectId: record.projectId,
    eventType: 'TENDER_REQUIREMENTS_EXTRACTED',
    entity: { refType: 'TenderInvitation', refId: invitationId },
    nextState: {
      ...record.state,
      deliverables: input.deliverables,
      analysisId: input.analysisId,
      requirementsExtracted: true,
      clarifications: [...(record.state.clarifications as Clarification[] | undefined ?? []), ...conflicts],
      extractedAt: new Date().toISOString(),
      extractedBy: ctx.auth.actorId,
    },
  });

  return { deliverables: input.deliverables.length, blockers: deliverableBlockers(input.deliverables) };
}

/**
 * Add one deliverable to the register.
 *
 * The bulk call above is the agent's path: it reads the whole invitation and
 * returns everything it found with source anchors. This is the person's path,
 * and it exists because that is how somebody actually reads an ITT — a return
 * item at a time, as they find it, over an afternoon. Forcing a person through
 * the bulk shape would mean a form of forty fields that has to be right in one
 * go, and the practical result of that is a register nobody fills in.
 *
 * Same event, because it is the same act on the same record.
 */
export function addDeliverable(
  ctx: EngineContext,
  invitationId: string,
  deliverable: TenderDeliverable,
): { deliverables: number; blockers: string[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireInvitation(ctx, invitationId);
  const existing = (record.state.deliverables as TenderDeliverable[] | undefined) ?? [];

  if (existing.some((d) => d.reference === deliverable.reference)) {
    throw new DomainError('DELIVERABLE_DUPLICATE', `Deliverable ${deliverable.reference} is already on this invitation`);
  }

  const returnDeadline = deadlineInForce(record.state);
  // Copied, not appended to in place. `record.state` is the state the last
  // event produced; pushing into it would change the before-state as well as
  // the after-state, the diff between them would show nothing, and the
  // clarification would be visible in memory and absent on replay.
  const clarifications = [...((record.state.clarifications as Clarification[] | undefined) ?? [])];
  if (deliverable.internalDueBy && `${deliverable.internalDueBy}T00:00:00Z` > returnDeadline.instant) {
    clarifications.push({
      severity: 'CRITICAL',
      subject: `${deliverable.reference} is due after the return`,
      question: `${deliverable.title} carries an internal date of ${deliverable.internalDueBy}, which is after the return deadline of ${readable(returnDeadline.local)}. The internal date has to move.`,
    });
  }

  const deliverables = [...existing, deliverable];
  write(ctx, {
    projectId: record.projectId,
    eventType: 'TENDER_REQUIREMENTS_EXTRACTED',
    entity: { refType: 'TenderInvitation', refId: invitationId },
    nextState: {
      ...record.state,
      deliverables,
      requirementsExtracted: true,
      clarifications,
      extractedAt: new Date().toISOString(),
      extractedBy: ctx.auth.actorId,
    },
  });

  return { deliverables: deliverables.length, blockers: deliverableBlockers(deliverables) };
}

/**
 * `AC-T-WF-01-01`, stated as the list of reasons a bid cannot yet be approved.
 *
 * Source, owner and internal date, on every **mandatory** deliverable. Not on
 * the optional ones: a nice-to-have with no owner is a decision not to do it,
 * and blocking on those would train people to mark everything optional.
 */
export function deliverableBlockers(deliverables: TenderDeliverable[]): string[] {
  const blockers: string[] = [];
  for (const deliverable of deliverables) {
    if (!deliverable.mandatory) continue;
    const missing: string[] = [];
    if (!deliverable.owner) missing.push('an owner');
    if (!deliverable.source) missing.push('a source in the invitation');
    if (!deliverable.internalDueBy) missing.push('an internal date');
    if (missing.length > 0) {
      // Read out loud rather than joined with a separator. This sentence is put
      // in front of somebody the day before a return, and "has no an owner, no
      // a source" is the kind of thing that gets a real warning ignored.
      const list =
        missing.length === 1
          ? missing[0]!
          : `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}`;
      blockers.push(`${deliverable.reference} — ${deliverable.title} — is missing ${list}`);
    }
  }
  return blockers;
}

// --- Addenda -----------------------------------------------------------------

export type Addendum = {
  reference: string;
  issuedAt: string;
  summary: string;
  /** The revised return deadline, where the addendum moves it. */
  returnDeadline?: ZonedInstant;
  /** Deliverables the addendum adds. */
  addedDeliverables?: TenderDeliverable[];
  source?: SourceAnchor;
  /** Why this addendum forces the bid decision to be taken again. */
  reReviewReasons: string[];
  recordedAt: string;
  recordedBy: string;
};

/**
 * Issue an addendum.
 *
 * It appends. The original issue stays exactly as it was recorded, because
 * "what was the deadline on the day we planned the bid" is a question a late
 * submission turns into a dispute, and an overwritten field cannot answer it.
 *
 * An addendum that moves the deadline or adds a mandatory deliverable makes the
 * bid decision stale. That is not recorded as a flag to be cleared — it is
 * derived by comparing timestamps, so it cannot be cleared by anything except
 * actually deciding again.
 */
export function issueAddendum(
  ctx: EngineContext,
  invitationId: string,
  input: {
    reference: string;
    issuedAt: string;
    summary: string;
    returnLocal?: string;
    timeZone?: string;
    addedDeliverables?: TenderDeliverable[];
    source?: SourceAnchor;
  },
): { addendum: Addendum; deadline: ZonedInstant; reReviewRequired: boolean } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireInvitation(ctx, invitationId);
  const issue = record.state.issue as { returnDeadline: ZonedInstant };
  const addenda = (record.state.addenda as Addendum[] | undefined) ?? [];

  if (addenda.some((a) => a.reference === input.reference)) {
    throw new DomainError('ADDENDUM_DUPLICATE', `Addendum ${input.reference} is already on this invitation`);
  }
  if (!input.summary?.trim()) {
    throw new DomainError('ADDENDUM_SUMMARY_REQUIRED', 'An addendum needs a summary of what it changed');
  }

  const previous = deadlineInForce(record.state);
  const revised = input.returnLocal
    ? resolveZonedInstant(input.returnLocal, input.timeZone ?? issue.returnDeadline.timeZone)
    : undefined;

  const reReviewReasons: string[] = [];
  if (revised && revised.instant !== previous.instant) {
    const moved = Date.parse(revised.instant) < Date.parse(previous.instant) ? 'forward' : 'back';
    reReviewReasons.push(`The return deadline moved ${moved}, from ${readable(previous.local)} to ${readable(revised.local)}`);
  }
  const addedMandatory = (input.addedDeliverables ?? []).filter((d) => d.mandatory);
  if (addedMandatory.length > 0) {
    reReviewReasons.push(
      `${addedMandatory.length} mandatory deliverable${addedMandatory.length === 1 ? '' : 's'} added: ${addedMandatory.map((d) => d.reference).join(', ')}`,
    );
  }

  const addendum: Addendum = {
    reference: input.reference,
    issuedAt: input.issuedAt,
    summary: input.summary.trim(),
    returnDeadline: revised,
    addedDeliverables: input.addedDeliverables,
    source: input.source,
    reReviewReasons,
    recordedAt: new Date().toISOString(),
    recordedBy: ctx.auth.actorId,
  };

  const deliverables = [
    ...((record.state.deliverables as TenderDeliverable[] | undefined) ?? []),
    ...(input.addedDeliverables ?? []),
  ];

  write(ctx, {
    projectId: record.projectId,
    eventType: 'TENDER_ADDENDUM_ISSUED',
    entity: { refType: 'TenderInvitation', refId: invitationId },
    nextState: { ...record.state, addenda: [...addenda, addendum], deliverables },
  });

  return { addendum, deadline: revised ?? previous, reReviewRequired: reReviewReasons.length > 0 };
}

/** The deadline actually in force: the issue, as moved by the last addendum to move it. */
export function deadlineInForce(state: Record<string, unknown>): ZonedInstant {
  const issue = state.issue as { returnDeadline: ZonedInstant };
  const addenda = (state.addenda as Addendum[] | undefined) ?? [];
  for (let i = addenda.length - 1; i >= 0; i--) {
    const revised = addenda[i]!.returnDeadline;
    if (revised) return revised;
  }
  return issue.returnDeadline;
}

// --- The bid approval gate ---------------------------------------------------

export type BidApprovalPosition = {
  invitationId?: string;
  reference?: string;
  blockers: string[];
  /** Set when an addendum has landed since the last bid decision. */
  reReviewReasons: string[];
};

/**
 * What stands between this opportunity and a recorded decision to bid.
 *
 * Read by `decideBidNoBid`, which is why it takes an opportunity rather than an
 * invitation: most opportunities never receive a formal ITT, and those have no
 * gate to pass. An opportunity with no invitation returns no blockers, which is
 * the honest answer rather than a permissive one.
 */
/**
 * Whether the bid was decided *after* the last addendum that demanded a
 * re-review, read from the order of the ledger rather than from timestamps.
 *
 * Timestamps were the obvious way to answer this and they are wrong. Both
 * records stamp `new Date().toISOString()`, and two events written milliseconds
 * apart can carry the same millisecond — so a `>` comparison silently misses a
 * genuine addendum and a `>=` comparison silently invents one. An append-only
 * ledger already knows what came after what; that is the whole point of it.
 */
function decidedAfterLastAddendum(
  ctx: EngineContext,
  projectId: string,
  opportunityId: string,
  invitationId: string,
  addenda: Addendum[],
): boolean {
  // The k-th addendum event on this invitation wrote addenda[k], so the two
  // sequences line up and the material ones can be found by position. A later
  // addendum that changed nothing material must not re-open a decision the
  // material one already answered.
  let lastMaterialAddendum = -1;
  let lastDecision = -1;
  let seen = 0;
  const events = ctx.ledger.events({ projectId });
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.eventType === 'TENDER_ADDENDUM_ISSUED' && event.entity.refId === invitationId) {
      if ((addenda[seen]?.reReviewReasons.length ?? 0) > 0) lastMaterialAddendum = i;
      seen += 1;
    }
    if (event.eventType === 'BID_NO_BID_DECIDED' && event.entity.refId === opportunityId) lastDecision = i;
  }
  return lastDecision > lastMaterialAddendum;
}

export function bidApprovalPosition(ctx: EngineContext, opportunityId: string): BidApprovalPosition {
  const opportunity = ctx.ledger.get({ refType: 'Opportunity', refId: opportunityId });
  if (!opportunity) return { blockers: [], reReviewReasons: [] };

  const invitation = ctx.ledger
    .list(opportunity.projectId, 'TenderInvitation')
    .find((r) => r.state.opportunityId === opportunityId);
  if (!invitation) return { blockers: [], reReviewReasons: [] };

  const blockers: string[] = [];
  if (!invitation.state.requirementsExtracted) {
    blockers.push(
      `Invitation ${String(invitation.state.reference)} has not been read: no deliverables and no compliance matrix are recorded against it`,
    );
  }
  blockers.push(...deliverableBlockers((invitation.state.deliverables as TenderDeliverable[] | undefined) ?? []));

  const addenda = (invitation.state.addenda as Addendum[] | undefined) ?? [];
  const material = addenda.filter((a) => a.reReviewReasons.length > 0);
  const reReviewReasons =
    material.length > 0 && decidedAfterLastAddendum(ctx, opportunity.projectId, opportunityId, String(invitation.state.id), material)
      ? []
      : material.flatMap((a) => a.reReviewReasons.map((r) => `${a.reference}: ${r}`));

  return {
    invitationId: String(invitation.state.id),
    reference: String(invitation.state.reference),
    blockers,
    reReviewReasons,
  };
}

// --- The bid programme -------------------------------------------------------

/**
 * The spine of a tender programme, back-planned from the return date.
 *
 * The weights and minimums are here rather than in code because the same spine
 * has to serve a ten-day quotation and a ninety-day two-stage tender. Fixed
 * offsets would compress the ninety-day one into nothing useful and would
 * silently overrun the ten-day one; proportional stages with a floor do
 * neither, and where the floor cannot be met the programme is refused rather
 * than compressed into a fiction.
 *
 * Ten business days is the floor for the whole spine. That is not a
 * comfortable tender; it is the point below which the stages stop being
 * separable at all.
 */
export const BID_SPINE = [
  { key: 'DOCUMENT_REVIEW', label: 'Tender documents read, queries drafted', minDays: 1, weight: 0.14 },
  { key: 'TAKE_OFF', label: 'Measurement and take-off complete', minDays: 2, weight: 0.22 },
  { key: 'ENQUIRIES_OUT', label: 'Subcontract and supplier enquiries issued', minDays: 1, weight: 0.08 },
  { key: 'ENQUIRIES_IN', label: 'Subcontract and supplier prices returned', minDays: 2, weight: 0.24 },
  { key: 'ESTIMATE_ASSEMBLED', label: 'Estimate assembled and cash model run', minDays: 1, weight: 0.12 },
  { key: 'SETTLEMENT', label: 'Settlement meeting — margin and risk set', minDays: 1, weight: 0.08 },
  { key: 'ADJUDICATION', label: 'Director adjudication and sign-off', minDays: 1, weight: 0.06 },
  { key: 'ASSEMBLY', label: 'Submission assembled, signed and checked', minDays: 1, weight: 0.06 },
] as const;

export const BID_SPINE_MINIMUM_DAYS = BID_SPINE.reduce((sum, stage) => sum + stage.minDays, 0);

export type BidMilestone = {
  key: string;
  label: string;
  start: string;
  finish: string;
  businessDays: number;
  /** True where the stage was held at its floor because the window was tight. */
  atMinimum: boolean;
};

export type BidWorkPackage = {
  owner: Role;
  mandatoryCount: number;
  earliestDueBy?: string;
  items: Array<{ reference: string; title: string; mandatory: boolean; internalDueBy?: string; kind: 'DELIVERABLE' | 'REQUIREMENT' }>;
};

export type BidProgramme = {
  programmeId: string;
  invitationId: string;
  /** The date the submission has to be complete by — the last business day on or before the deadline. */
  submissionDay: string;
  availableBusinessDays: number;
  milestones: BidMilestone[];
  workPackages: BidWorkPackage[];
  fixedDates: Array<{ label: string; date: string }>;
};

/**
 * Allocate the available business days across the spine.
 *
 * Each stage gets its share of the window or its floor, whichever is larger,
 * and the excess is trimmed from whichever stage is furthest above its own
 * floor. Trimming the biggest surplus rather than the biggest stage is what
 * keeps a tight programme proportional instead of eating one stage alive.
 */
function allocate(available: number): number[] {
  const days = BID_SPINE.map((stage) => Math.max(stage.minDays, Math.floor(stage.weight * available)));
  let total = days.reduce((sum, d) => sum + d, 0);

  while (total > available) {
    let index = -1;
    let slack = 0;
    for (let i = 0; i < days.length; i++) {
      const surplus = days[i]! - BID_SPINE[i]!.minDays;
      if (surplus > slack) {
        slack = surplus;
        index = i;
      }
    }
    if (index === -1) break; // Everything is at its floor; the caller already checked the total.
    days[index]! -= 1;
    total -= 1;
  }

  // Any remainder from the flooring goes to the stage that benefits most from
  // it: getting prices back is what a longer tender actually buys.
  let remaining = available - total;
  const enquiriesIn = BID_SPINE.findIndex((s) => s.key === 'ENQUIRIES_IN');
  if (remaining > 0 && enquiriesIn >= 0) {
    days[enquiriesIn]! += remaining;
    remaining = 0;
  }

  return days;
}

/**
 * Build the tender programme and the bid work packages.
 *
 * Refused for anything not decided as a bid — `AC-T-WF-01-03` says a no-bid
 * does not proceed, and a tender programme is the first thing that proceeding
 * looks like.
 */
export function generateBidProgramme(
  ctx: EngineContext,
  invitationId: string,
  options: { from?: string; calendar?: BusinessCalendar } = {},
): BidProgramme {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireInvitation(ctx, invitationId);
  const opportunity = requireOpportunityRecord(ctx, String(record.state.opportunityId));
  const stage = opportunity.state.stage as string;

  if (stage !== 'BID' && stage !== 'CONVERTED') {
    throw new DomainError(
      'OPPORTUNITY_NOT_BID',
      stage === 'NO_BID'
        ? 'This opportunity was decided as a no-bid. A no-bid does not get a tender programme, and it cannot proceed to pricing.'
        : `A tender programme follows the decision to bid. This opportunity is ${stage.toLowerCase()}.`,
    );
  }

  const position = bidApprovalPosition(ctx, String(record.state.opportunityId));
  if (position.reReviewReasons.length > 0) {
    throw new DomainError(
      'BID_DECISION_STALE',
      `An addendum has landed since the bid decision was taken, so the programme would be built on a superseded invitation. ${position.reReviewReasons.join('; ')}. Record the decision again first.`,
    );
  }

  const calendar = options.calendar ?? DEFAULT_CALENDAR;
  const deadline = deadlineInForce(record.state);
  const submissionDay = businessDayOnOrBefore(deadline.instant.slice(0, 10), calendar);
  const from = (options.from ?? new Date().toISOString()).slice(0, 10);

  const available = businessDaysBetween(from, submissionDay, calendar);
  if (available < BID_SPINE_MINIMUM_DAYS) {
    throw new DomainError(
      'TENDER_WINDOW_TOO_SHORT',
      `${available} business day${available === 1 ? '' : 's'} remain to ${submissionDay}, and the tender spine needs ${BID_SPINE_MINIMUM_DAYS}. ` +
        'Ask the buyer for an extension, or record the decision to bid on a compressed programme knowingly — the platform will not compress it silently.',
    );
  }

  const days = allocate(available);
  const milestones: BidMilestone[] = [];
  let cursor = from;
  for (let i = 0; i < BID_SPINE.length; i++) {
    const stageDef = BID_SPINE[i]!;
    const finish = addBusinessDays(cursor, days[i]!, calendar);
    milestones.push({
      key: stageDef.key,
      label: stageDef.label,
      start: cursor,
      finish,
      businessDays: days[i]!,
      atMinimum: days[i] === stageDef.minDays,
    });
    cursor = finish;
  }

  const issue = record.state.issue as { clarificationDeadline?: ZonedInstant; siteVisit?: ZonedInstant };
  const fixedDates: Array<{ label: string; date: string }> = [];
  if (issue.clarificationDeadline) fixedDates.push({ label: 'Last date for questions to the buyer', date: readable(issue.clarificationDeadline.local) });
  if (issue.siteVisit) fixedDates.push({ label: 'Site visit', date: readable(issue.siteVisit.local) });
  fixedDates.push({ label: 'Return deadline', date: `${readable(deadline.local)} ${deadline.timeZone}` });

  const workPackages = buildWorkPackages(ctx, record);

  const programmeId = ulid();
  const programme: BidProgramme = {
    programmeId,
    invitationId,
    submissionDay,
    availableBusinessDays: available,
    milestones,
    workPackages,
    fixedDates,
  };

  write(ctx, {
    projectId: record.projectId,
    eventType: 'TENDER_PROGRAMME_CREATED',
    entity: { refType: 'BidProgramme', refId: programmeId },
    nextState: {
      ...programme,
      tenantId: ctx.tenantId,
      opportunityId: record.state.opportunityId,
      reference: record.state.reference,
      calendar: calendar.jurisdiction,
      createdAt: new Date().toISOString(),
      createdBy: ctx.auth.actorId,
    },
  });

  return programme;
}

/**
 * The work packages: what each role owes, and by when.
 *
 * Built from the deliverables and from the compliance matrix together, because
 * they are the same job seen from two sides — the QS who owns the pricing
 * schedule also owns the commercial requirements behind it, and giving them two
 * lists is how one of the lists goes unread.
 */
function buildWorkPackages(ctx: EngineContext, invitation: EntityRecord): BidWorkPackage[] {
  const byOwner = new Map<Role, BidWorkPackage>();
  const add = (owner: Role, item: BidWorkPackage['items'][number]): void => {
    let pack = byOwner.get(owner);
    if (!pack) {
      pack = { owner, mandatoryCount: 0, items: [] };
      byOwner.set(owner, pack);
    }
    pack.items.push(item);
    if (item.mandatory) pack.mandatoryCount += 1;
    if (item.internalDueBy && (!pack.earliestDueBy || item.internalDueBy < pack.earliestDueBy)) {
      pack.earliestDueBy = item.internalDueBy;
    }
  };

  for (const deliverable of (invitation.state.deliverables as TenderDeliverable[] | undefined) ?? []) {
    if (!deliverable.owner) continue;
    add(deliverable.owner, {
      reference: deliverable.reference,
      title: deliverable.title,
      mandatory: deliverable.mandatory,
      internalDueBy: deliverable.internalDueBy,
      kind: 'DELIVERABLE',
    });
  }

  const analysisId = invitation.state.analysisId as string | undefined;
  if (analysisId) {
    const analysis = ctx.ledger.get({ refType: 'ITTAnalysis', refId: analysisId });
    const matrix = (analysis?.state.matrix as Array<{ reference: string; requirement: string; mandatory: boolean; owner: Role; dueBy?: string }> | undefined) ?? [];
    for (const line of matrix) {
      add(line.owner, {
        reference: line.reference,
        title: line.requirement,
        mandatory: line.mandatory,
        internalDueBy: line.dueBy,
        kind: 'REQUIREMENT',
      });
    }
  }

  return [...byOwner.values()].sort((a, b) => b.mandatoryCount - a.mandatoryCount || a.owner.localeCompare(b.owner));
}

// --- Reading the position ----------------------------------------------------

export type TenderPosition = {
  invitationId: string;
  reference: string;
  clientName: string;
  title: string;
  opportunityId: string;
  stage: string;
  deadline: ZonedInstant;
  /** Business days from today to the last business day before the deadline. */
  businessDaysRemaining: number;
  submissionDay: string;
  addenda: number;
  deliverables: { total: number; mandatory: number };
  requirementsExtracted: boolean;
  /**
   * The compliance matrix this invitation was read against, where one is
   * linked. Carried so the board can open it: without it the analysis is a
   * record with no route to it from the thing it describes.
   */
  analysisId?: string;
  blockers: string[];
  reReviewReasons: string[];
  clarifications: Clarification[];
  programmeId?: string;
};

export function tenderPosition(
  ctx: EngineContext,
  invitationId: string,
  options: { today?: string; calendar?: BusinessCalendar } = {},
): TenderPosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  return readPosition(ctx, requireInvitation(ctx, invitationId), options);
}

function readPosition(
  ctx: EngineContext,
  record: EntityRecord,
  options: { today?: string; calendar?: BusinessCalendar },
): TenderPosition {
  const calendar = options.calendar ?? DEFAULT_CALENDAR;
  const today = (options.today ?? new Date().toISOString()).slice(0, 10);
  const deadline = deadlineInForce(record.state);
  const submissionDay = businessDayOnOrBefore(deadline.instant.slice(0, 10), calendar);
  const opportunityId = String(record.state.opportunityId);
  const opportunity = ctx.ledger.get({ refType: 'Opportunity', refId: opportunityId });
  const position = bidApprovalPosition(ctx, opportunityId);
  const deliverables = (record.state.deliverables as TenderDeliverable[] | undefined) ?? [];

  const programme = ctx.ledger
    .list(record.projectId, 'BidProgramme')
    .find((r) => r.state.invitationId === record.state.id);

  return {
    invitationId: String(record.state.id),
    reference: String(record.state.reference),
    clientName: String(record.state.clientName ?? ''),
    title: String(record.state.title ?? ''),
    opportunityId,
    stage: String(opportunity?.state.stage ?? 'UNKNOWN'),
    deadline,
    businessDaysRemaining: businessDaysBetween(today, submissionDay, calendar),
    submissionDay,
    addenda: ((record.state.addenda as Addendum[] | undefined) ?? []).length,
    deliverables: { total: deliverables.length, mandatory: deliverables.filter((d) => d.mandatory).length },
    requirementsExtracted: Boolean(record.state.requirementsExtracted),
    ...(record.state.analysisId ? { analysisId: String(record.state.analysisId) } : {}),
    blockers: position.blockers,
    reReviewReasons: position.reReviewReasons,
    clarifications: (record.state.clarifications as Clarification[] | undefined) ?? [],
    programmeId: programme ? String(programme.state.programmeId) : undefined,
  };
}

export type TenderBoard = {
  tenders: TenderPosition[];
  summary: string;
};

/** Every live invitation, soonest deadline first. */
export function tenderBoard(
  ctx: EngineContext,
  options: { today?: string; calendar?: BusinessCalendar } = {},
): TenderBoard {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const tenders = ctx.ledger
    .list(`${ctx.tenantId}-governance`, 'TenderInvitation')
    .map((record) => readPosition(ctx, record, options))
    .sort((a, b) => a.deadline.instant.localeCompare(b.deadline.instant));

  const blocked = tenders.filter((t) => t.blockers.length > 0).length;
  const stale = tenders.filter((t) => t.reReviewReasons.length > 0).length;
  const critical = tenders.filter((t) => t.clarifications.some((c) => c.severity === 'CRITICAL')).length;

  const parts = [`${tenders.length} invitation${tenders.length === 1 ? '' : 's'} recorded`];
  if (blocked > 0) parts.push(`${blocked} not ready to approve a bid`);
  if (stale > 0) parts.push(`${stale} awaiting re-review after an addendum`);
  if (critical > 0) parts.push(`${critical} with a critical clarification outstanding`);
  if (parts.length === 1) parts.push('nothing outstanding');

  return { tenders, summary: `${parts.join(', ')}.` };
}
