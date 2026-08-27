import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import {
  checkDiaryContent,
  currentDiaries,
  type DiaryLabour,
  type DiaryPlant,
  type DiaryWeather,
} from '../engines/planning.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * CN-WF-03 — offline daily diary and voice field capture.
 *
 * Most of what this workflow asks for was already built and none of it is
 * rebuilt here.
 *
 * `field/sync.ts` is the offline path: operations carry a client-minted id so a
 * retried batch changes nothing the second time, device timestamps survive the
 * server's receipt time, and conflicts resolve deterministically with the
 * losing change still recorded. `engines/perception.ts` takes a voice capture
 * to a draft that a person confirms before anything becomes a record — which is
 * this workflow's own guardrail, that the agent may categorise and suggest but
 * never issue a formal record. And `recordSiteDiary` holds the evidential rules
 * that make a diary worth having: it cannot be dated ahead, it says whether it
 * was contemporaneous, and it records the weather on the good days too.
 *
 * What was missing is the **lifecycle**. The diary was written in one shot, and
 * a shift is not captured in one shot: it is captured across a day, on a device,
 * often with no signal, and submitted once at the end of it.
 *
 * **A draft that survives.** The device mints the id, so a draft interrupted by
 * a flat battery or an app restart is the same draft when it comes back rather
 * than a second one — and a sync that runs twice writes it once. That is
 * AC-CN-WF-03-01, and it is the client id doing the work rather than a
 * server-side guess about what looks like a duplicate.
 *
 * **The device's clock is kept, and its error with it.** The exception control
 * says the server's receipt time never replaces the original capture time. It
 * does not, and the *variance* between the two is stored as well — a device
 * eleven minutes fast is a fact about the evidence, and hiding it would make
 * every timestamp on the record slightly less true than it looks.
 *
 * **Submitted once.** A draft becomes the record for its day when a supervisor
 * submits it. After that, editing is an amendment: a new record naming what it
 * supersedes, with the reason, and with the **before and after of every field
 * that changed** computed onto it. AC-CN-WF-03-03 asks for exactly that, and a
 * diff nobody computes is a diff nobody reads.
 *
 * **Anomalous totals are reported, not refused.** Twenty-six hours in a day is
 * impossible and is refused. A twelve-hour shift is unusual and is surfaced for
 * the supervisor to confirm. Refusing the merely unlikely teaches people to
 * enter the number the form will accept instead of the one they measured, which
 * is how a diary stops being evidence.
 */

export const SHIFT = ['DAY', 'NIGHT', 'BACK_SHIFT'] as const;
export type Shift = (typeof SHIFT)[number];

export type DailyLogContent = {
  diaryDate: string;
  shift: Shift;
  weather: DiaryWeather;
  labour: DiaryLabour[];
  plant: DiaryPlant[];
  progressNarrative: string;
  /** The activities the shift worked. AC-CN-WF-03-02 asks for the WBS. */
  workedTaskIds: string[];
  /** Where on site. Required at submission, not at draft. */
  location: string;
  deliveries?: string[];
  blockers?: string[];
  visitors?: string[];
  safetyEvents?: string[];
};

type LogState = DailyLogContent & {
  id: string;
  status: 'DRAFT' | 'RECORDED';
  /** Client-minted, stable across restarts and retries. */
  clientUuid: string;
  deviceId: string;
  /** The device's own clock at capture. Never replaced by the server's. */
  capturedAt: string;
  receivedAt: string;
  deviceTimeVarianceSeconds: number;
  anomalies: string[];
  /** Voice segments, kept alongside what was transcribed from them. */
  voiceSegments: VoiceSegment[];
  supersedes?: string;
  supersessionReason?: string;
  changes?: FieldChange[];
  recordedAt?: string;
  recordedBy?: string;
};

/**
 * A segment of dictation and what was made of it.
 *
 * The audio reference is kept rather than discarded once transcribed, because
 * the transcript is an interpretation and the recording is the evidence. Which
 * section a statement was mapped to is recorded too, so a mapping that was
 * wrong can be seen to have been wrong.
 */
export type VoiceSegment = {
  segmentId: string;
  /** The stored audio. The transcript never replaces it. */
  audioHash: string;
  transcript: string;
  mappedTo: keyof DailyLogContent | 'UNMAPPED';
  /** A person confirmed the mapping. The agent may propose it; it may not file it. */
  confirmedBy?: string;
};

export type FieldChange = { field: string; before: string; after: string };

function requireLog(ctx: EngineContext, logId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'SiteDiary', refId: logId });
  if (!record) throw new DomainError('DAILY_LOG_NOT_FOUND', `No daily log ${logId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): LogState {
  return record.state as unknown as LogState;
}

function existingDraft(ctx: EngineContext, clientUuid: string): EntityRecord | undefined {
  return ctx.ledger
    .list(ctx.projectId, 'SiteDiary')
    .find((record) => record.state.clientUuid === clientUuid);
}

/** Seconds the device's clock was out by, positive when the device was fast. */
function varianceSeconds(capturedAt: string, receivedAt: string): number {
  return Math.round((Date.parse(receivedAt) - Date.parse(capturedAt)) / 1000) * -1;
}

// --- Step 1: the draft ------------------------------------------------------

export function draftDailyLog(
  ctx: EngineContext,
  input: DailyLogContent & {
    /** Minted on the device. This is what makes the capture survive a restart. */
    clientUuid: string;
    deviceId: string;
    /** The device's own clock. */
    capturedAt: string;
    voiceSegments?: VoiceSegment[];
  },
  now = new Date(),
): { logId: string; status: 'DRAFT'; deviceTimeVarianceSeconds: number; anomalies: string[]; alreadyHeld: boolean } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.clientUuid.trim() || !input.deviceId.trim()) {
    throw new DomainError(
      'CLIENT_IDENTITY_REQUIRED',
      'A field capture carries the id the device minted for it and the device that made it. Without the id a retried sync ' +
        'writes the shift twice, and without the device nothing can say which handset the record came from.',
    );
  }
  if (Number.isNaN(Date.parse(input.capturedAt))) {
    throw new DomainError('CAPTURE_TIME_REQUIRED', 'A field capture carries the time the device recorded it.');
  }

  // AC-CN-WF-03-01. The same capture arriving twice — an app restart, a retried
  // batch, a sync that ran while the first was still in flight — is one record.
  const held = existingDraft(ctx, input.clientUuid.trim());
  if (held) {
    const state = stateOf(held);
    return {
      logId: state.id,
      status: 'DRAFT',
      deviceTimeVarianceSeconds: state.deviceTimeVarianceSeconds,
      anomalies: state.anomalies,
      alreadyHeld: true,
    };
  }

  // Anomalies are computed at draft so the device can show them before anybody
  // walks away from the shift, which is the only time they can still be checked.
  const check = checkDiaryContent(input, now);

  const receivedAt = now.toISOString();
  const logId = ulid();

  write(ctx, {
    eventType: 'DAILY_LOG_DRAFTED',
    entity: { refType: 'SiteDiary', refId: logId },
    nextState: {
      id: logId,
      projectId: ctx.projectId,
      status: 'DRAFT',
      clientUuid: input.clientUuid.trim(),
      deviceId: input.deviceId.trim(),
      capturedAt: input.capturedAt,
      receivedAt,
      // Stored rather than corrected. A device eleven minutes fast is a fact
      // about the evidence, and the exception control is explicit that the
      // server's receipt time never replaces the capture time.
      deviceTimeVarianceSeconds: varianceSeconds(input.capturedAt, receivedAt),
      diaryDate: check.diaryDate,
      shift: input.shift,
      weather: input.weather,
      labour: input.labour,
      plant: input.plant,
      labourHours: check.labourHours,
      plantIdleHours: check.plantIdleHours,
      progressNarrative: input.progressNarrative,
      workedTaskIds: input.workedTaskIds,
      location: input.location,
      deliveries: input.deliveries ?? [],
      blockers: input.blockers ?? [],
      visitors: input.visitors ?? [],
      safetyEvents: input.safetyEvents ?? [],
      voiceSegments: input.voiceSegments ?? [],
      anomalies: check.anomalies,
      draftedBy: ctx.auth.actorId,
    },
  });

  return {
    logId,
    status: 'DRAFT',
    deviceTimeVarianceSeconds: varianceSeconds(input.capturedAt, receivedAt),
    anomalies: check.anomalies,
    alreadyHeld: false,
  };
}

// --- Step 5: submitted once -------------------------------------------------

export function submitDailyLog(
  ctx: EngineContext,
  logId: string,
  input: { evidenceHash: string; confirmedAnomalies?: string[] },
  now = new Date(),
): { logId: string; contemporaneous: boolean; daysLate: number; labourHours: number } {
  authorise(ctx, 'FIELD_EXECUTION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireLog(ctx, logId);
  const state = stateOf(record);

  if (state.status !== 'DRAFT') {
    throw new DomainError(
      'DAILY_LOG_ALREADY_SUBMITTED',
      `${state.diaryDate} was already submitted. A submitted log is amended rather than re-submitted, so the record of what ` +
        'was said first survives — which is the only reason a diary is worth anything in a dispute.',
      409,
    );
  }

  // AC-CN-WF-03-02. A log with no activity or no location cannot be tied to
  // anything afterwards, and a diary that cannot be tied to the work is a
  // narrative.
  if (state.workedTaskIds.length === 0) {
    throw new DomainError(
      'WBS_REQUIRED',
      'Name the activities the shift worked. A day of labour and plant against no activity cannot be reconciled with the ' +
        'programme, and reconciling them is what the diary is for.',
    );
  }
  if (!state.location?.trim()) {
    throw new DomainError('LOCATION_REQUIRED', 'Say where on site the shift worked.');
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('EVIDENCE_REQUIRED', 'A submitted log carries the evidence it was captured with.');
  }

  // Anomalies raised at draft have to be looked at rather than scrolled past.
  const unconfirmed = state.anomalies.filter((anomaly) => !(input.confirmedAnomalies ?? []).includes(anomaly));
  if (unconfirmed.length > 0) {
    throw new DomainError(
      'ANOMALIES_UNCONFIRMED',
      `${unconfirmed.join('; ')}. Confirm each of these or correct the figures. They are not refused — an unusual shift is ` +
        'still a shift — but they are not submitted unseen either.',
    );
  }

  const alreadyRecorded = currentDiaries(ctx).filter(
    (entry) => String(entry.state.diaryDate) === state.diaryDate && entry.refId !== logId,
  );
  if (alreadyRecorded.length > 0) {
    throw new DomainError(
      'DIARY_ALREADY_RECORDED',
      `A diary already stands for ${state.diaryDate}. Amend it rather than submitting a second one — two versions of a day ` +
        'in front of an adjudicator is worse than none.',
      409,
    );
  }

  const check = checkDiaryContent(state, now);

  const evidence = registerEvidence(ctx, {
    type: 'SITE_DIARY_RECORD',
    hash: input.evidenceHash,
    description: `Daily log for ${state.diaryDate}, ${state.shift.toLowerCase().replace(/_/g, ' ')} shift`,
    linkedEntities: [{ refType: 'SiteDiary', refId: logId }],
  });

  write(ctx, {
    eventType: 'DAILY_LOG_SUBMITTED',
    entity: { refType: 'SiteDiary', refId: logId },
    nextState: {
      ...record.state,
      status: 'RECORDED',
      daysLate: check.daysLate,
      contemporaneous: check.contemporaneous,
      confirmedAnomalies: input.confirmedAnomalies ?? [],
      recordedAt: now.toISOString(),
      recordedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return {
    logId,
    contemporaneous: check.contemporaneous,
    daysLate: check.daysLate,
    labourHours: check.labourHours,
  };
}

// --- Step 5 continued: an amendment shows what changed ----------------------

/** The fields an amendment diffs. Material to the record, so worth showing. */
const DIFFED: Array<keyof DailyLogContent> = [
  'shift',
  'weather',
  'labour',
  'plant',
  'progressNarrative',
  'workedTaskIds',
  'location',
  'deliveries',
  'blockers',
  'visitors',
  'safetyEvents',
];

function describe(value: unknown): string {
  if (value === undefined || value === null) return '(nothing)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function amendDailyLog(
  ctx: EngineContext,
  logId: string,
  input: { content: Partial<DailyLogContent>; reason: string; evidenceHash: string },
  now = new Date(),
): { logId: string; supersedes: string; changes: FieldChange[] } {
  authorise(ctx, 'FIELD_EXECUTION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireLog(ctx, logId);
  const state = stateOf(record);

  if (state.status !== 'RECORDED') {
    throw new DomainError(
      'DAILY_LOG_NOT_SUBMITTED',
      'A draft is edited, not amended. Amendment exists to preserve what was submitted, and nothing has been submitted yet.',
    );
  }
  const superseded = ctx.ledger
    .list(ctx.projectId, 'SiteDiary')
    .some((entry) => entry.state.supersedes === logId);
  if (superseded) {
    throw new DomainError(
      'DAILY_LOG_SUPERSEDED',
      'This entry has already been amended. Amend the entry that stands, or the register carries two corrections of the ' +
        'same day and no way to tell which is current.',
      409,
    );
  }
  if (!input.reason.trim()) {
    throw new DomainError(
      'AMENDMENT_UNEXPLAINED',
      'Say why the record is being changed. An amendment with no reason on it is indistinguishable from a correction ' +
        'somebody made because they did not like the first answer.',
    );
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('EVIDENCE_REQUIRED', 'An amendment carries its own evidence.');
  }

  const amended = { ...state, ...input.content };
  const check = checkDiaryContent(amended, now);

  // AC-CN-WF-03-03. Before and after, computed rather than described, so the
  // amendment can be read without holding both versions side by side.
  const changes: FieldChange[] = [];
  for (const field of DIFFED) {
    const before = describe(state[field]);
    const after = describe(amended[field]);
    if (before !== after) changes.push({ field, before, after });
  }
  if (changes.length === 0) {
    throw new DomainError(
      'AMENDMENT_CHANGES_NOTHING',
      'This amendment changes nothing on the record. An amendment that changes nothing still supersedes an entry, which ' +
        'makes the register harder to read for no gain.',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'SITE_DIARY_RECORD',
    hash: input.evidenceHash,
    description: `Amendment to the daily log for ${state.diaryDate}: ${input.reason}`,
    linkedEntities: [{ refType: 'SiteDiary', refId: logId }],
  });

  const amendmentId = ulid();

  write(ctx, {
    eventType: 'DAILY_LOG_AMENDED',
    entity: { refType: 'SiteDiary', refId: amendmentId },
    nextState: {
      ...amended,
      id: amendmentId,
      projectId: ctx.projectId,
      status: 'RECORDED',
      // A new capture id, because this is a new record. The original keeps its
      // own, so a device retrying the original sync still resolves to it.
      clientUuid: `${state.clientUuid}:amend:${amendmentId}`,
      labourHours: check.labourHours,
      plantIdleHours: check.plantIdleHours,
      anomalies: check.anomalies,
      daysLate: check.daysLate,
      contemporaneous: check.contemporaneous,
      supersedes: logId,
      supersessionReason: input.reason,
      changes,
      recordedAt: now.toISOString(),
      recordedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { logId: amendmentId, supersedes: logId, changes };
}

// --- The sync receipt -------------------------------------------------------

/**
 * Record that a device finished a sync.
 *
 * `field/sync.ts` already applies the batch and resolves conflicts; what it did
 * not do is leave a mark saying a device came back and what it brought. That
 * matters on a project where a handset has been out of signal for four days:
 * the question afterwards is never "did the sync work" but "when did this
 * device last reach us, and what was still on it".
 */
export function recordSyncCompleted(
  ctx: EngineContext,
  input: {
    deviceId: string;
    syncSessionId: string;
    accepted: number;
    duplicates: number;
    conflicts: number;
    /** The device's clock when it started the batch. */
    deviceTimestamp: string;
  },
  now = new Date(),
): { syncSessionId: string; deviceTimeVarianceSeconds: number } {
  authorise(ctx, 'FIELD_EXECUTION', 'C');

  if (!input.deviceId.trim() || !input.syncSessionId.trim()) {
    throw new DomainError('SYNC_UNIDENTIFIED', 'A sync receipt names the device and the session it completed.');
  }
  if (Number.isNaN(Date.parse(input.deviceTimestamp))) {
    throw new DomainError('SYNC_UNIDENTIFIED', 'A sync receipt carries the device clock at the time of the batch.');
  }

  const receivedAt = now.toISOString();
  const variance = varianceSeconds(input.deviceTimestamp, receivedAt);

  write(ctx, {
    eventType: 'OFFLINE_SYNC_COMPLETED',
    entity: { refType: 'SyncSession', refId: input.syncSessionId },
    nextState: {
      id: input.syncSessionId,
      projectId: ctx.projectId,
      deviceId: input.deviceId,
      accepted: input.accepted,
      duplicates: input.duplicates,
      conflicts: input.conflicts,
      deviceTimestamp: input.deviceTimestamp,
      receivedAt,
      deviceTimeVarianceSeconds: variance,
      syncedBy: ctx.auth.actorId,
    },
  });

  return { syncSessionId: input.syncSessionId, deviceTimeVarianceSeconds: variance };
}

// --- The position -----------------------------------------------------------

export type DailyLogPosition = {
  drafts: Array<{ logId: string; diaryDate: string; shift: string; deviceId: string; anomalies: string[] }>;
  submitted: Array<{
    logId: string;
    diaryDate: string;
    shift: string;
    contemporaneous: boolean;
    daysLate: number;
    amended: boolean;
  }>;
  amendments: Array<{ logId: string; diaryDate: string; reason: string; changes: FieldChange[] }>;
  /** Devices whose clock is out by more than a minute, and by how much. */
  clockDrift: Array<{ deviceId: string; seconds: number }>;
  summary: string;
};

export function dailyLogPosition(ctx: EngineContext): DailyLogPosition {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const all = ctx.ledger.list(ctx.projectId, 'SiteDiary').map((record) => stateOf(record));
  const superseded = new Set(all.map((entry) => entry.supersedes).filter((id): id is string => typeof id === 'string'));

  const drafts = all
    .filter((entry) => entry.status === 'DRAFT')
    .map((entry) => ({
      logId: entry.id,
      diaryDate: entry.diaryDate,
      shift: entry.shift ?? 'DAY',
      deviceId: entry.deviceId ?? '',
      anomalies: entry.anomalies ?? [],
    }));

  const submitted = all
    .filter((entry) => entry.status === 'RECORDED')
    .map((entry) => ({
      logId: entry.id,
      diaryDate: entry.diaryDate,
      shift: entry.shift ?? 'DAY',
      contemporaneous: Boolean((entry as unknown as { contemporaneous?: boolean }).contemporaneous),
      daysLate: Number((entry as unknown as { daysLate?: number }).daysLate ?? 0),
      amended: superseded.has(entry.id),
    }));

  const amendments = all
    .filter((entry) => entry.supersedes !== undefined)
    .map((entry) => ({
      logId: entry.id,
      diaryDate: entry.diaryDate,
      reason: entry.supersessionReason ?? '',
      changes: entry.changes ?? [],
    }));

  // Worth surfacing rather than silently correcting: a handset an hour out
  // stamps every capture on it an hour out, and somebody has to fix the phone.
  const drift = new Map<string, number>();
  for (const entry of all) {
    if (!entry.deviceId) continue;
    const seconds = entry.deviceTimeVarianceSeconds ?? 0;
    if (Math.abs(seconds) > 60) drift.set(entry.deviceId, seconds);
  }
  for (const record of ctx.ledger.list(ctx.projectId, 'SyncSession')) {
    const seconds = Number(record.state.deviceTimeVarianceSeconds ?? 0);
    if (Math.abs(seconds) > 60) drift.set(String(record.state.deviceId), seconds);
  }

  const parts = [`${submitted.length} day${submitted.length === 1 ? '' : 's'} recorded`];
  if (drafts.length > 0) parts.push(`${drafts.length} still in draft on a device`);
  if (amendments.length > 0) parts.push(`${amendments.length} amended`);
  if (drift.size > 0) parts.push(`${drift.size} device clock(s) out by more than a minute`);

  return {
    drafts,
    submitted,
    amendments,
    clockDrift: [...drift].map(([deviceId, seconds]) => ({ deviceId, seconds })),
    summary: parts.join(', ') + '.',
  };
}
