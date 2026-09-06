import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import { PLATFORM_TENANT_ID, type Platform, type PlatformUser } from '../platform.ts';

/**
 * Who the platform's own alerts reach first.
 *
 * The watch told every operator, every time, and nobody in particular. That
 * is how an alert becomes furniture: three people each assume one of the
 * others has it. A rota names one person per period, the alert names them in
 * its subject and its webhook line, and they are the first recipient — the
 * others are copied, because an alert that reaches one inbox and nobody else
 * is a single point of failure with a name on it.
 *
 * **On the record.** The rota is an `OnCallRota` under the platform's own
 * governance chain: who set it, when, in what order, with what rotation. An
 * incident review asks "who was on call when it fired", and the answer is
 * derived from the chain as it stood, not from a spreadsheet somebody edited
 * since. An override — a swap, a holiday — is a second event on the same
 * record, with its end date, so it lapses on its own.
 *
 * **Time, not people, decides.** Whoever is on call is computed from the
 * rota's start and its rotation length: period *n* since the start goes to
 * member *n mod length*. Nothing has to run at the handover; a process that
 * was down at midnight still knows who is on call at 00:01.
 *
 * **What it is not.** It is not an escalation chain, a paging service or an
 * acknowledgement flow. The alert reaches the person through the outbox and
 * the webhook that already exist; whether they saw it is between them and
 * their pager. `OPS_ALERT_WEBHOOK_URL` pointed at a PagerDuty or Grafana
 * OnCall events URL is where escalation lives, and the payload carries the
 * on-call name so that service can route on it.
 */

export type OnCallMember = { operatorId: string; name: string; email: string };

export type OnCallOverride = {
  operatorId: string;
  name: string;
  email: string;
  /** ISO. The override lapses on its own here. */
  until: string;
  reason: string;
  setBy: string;
  setAt: string;
};

export type OnCallRota = {
  id: 'platform';
  /** In handover order. */
  members: OnCallMember[];
  /** How long each person holds the pager. */
  rotationDays: number;
  /** ISO. Period zero starts here, with members[0]. */
  startsAt: string;
  setBy: string;
  setAt: string;
  override?: OnCallOverride;
};

const ROTA_ID = 'platform';
const PROJECT_ID = `${PLATFORM_TENANT_ID}-governance`;
const DAY_MS = 86_400_000;

export function rotaOf(platform: Platform): OnCallRota | undefined {
  const record = platform.ledger.get({ refType: 'OnCallRota', refId: ROTA_ID });
  return record ? (record.state as unknown as OnCallRota) : undefined;
}

function commit(platform: Platform, actorId: string, eventType: 'ONCALL_ROTA_SET' | 'ONCALL_OVERRIDE_SET', rota: OnCallRota): OnCallRota {
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: PROJECT_ID,
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'OnCallRota', refId: ROTA_ID },
    nextState: { ...rota },
  });
  return rota;
}

function operatorById(platform: Platform, operatorId: string): PlatformUser {
  const found = platform.operators().find((operator) => operator.id === operatorId);
  if (!found) throw new DomainError('ONCALL_NOT_AN_OPERATOR', `${operatorId} is not a platform operator; only operators can be on call`, 422);
  return found;
}

/**
 * Set the rota. The whole rota each time — order, rotation, start — so the
 * record is a statement rather than a diff, and so a rota can be replaced by
 * one person in one act. An override in force is kept unless the person it
 * names has left the rota.
 */
export function setRota(
  platform: Platform,
  actor: AuthContext,
  input: { operatorIds: string[]; rotationDays: number; startsAt?: string },
  now = new Date(),
): OnCallRota {
  const unique = [...new Set(input.operatorIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) throw new DomainError('ONCALL_ROTA_EMPTY', 'A rota names at least one operator', 422);
  if (!Number.isInteger(input.rotationDays) || input.rotationDays < 1 || input.rotationDays > 90) {
    throw new DomainError('ONCALL_ROTATION_INVALID', 'The rotation is a whole number of days, from one to ninety', 422);
  }
  const startsAt = input.startsAt ? new Date(input.startsAt) : now;
  if (Number.isNaN(startsAt.getTime())) throw new DomainError('ONCALL_START_INVALID', 'The start is not a date', 422);

  const members = unique.map((operatorId) => {
    const operator = operatorById(platform, operatorId);
    return { operatorId: operator.id, name: operator.name, email: operator.email };
  });
  const existing = rotaOf(platform);
  const override = existing?.override && members.some((member) => member.operatorId === existing.override!.operatorId) ? existing.override : undefined;
  return commit(platform, actor.actorId, 'ONCALL_ROTA_SET', {
    id: ROTA_ID,
    members,
    rotationDays: input.rotationDays,
    startsAt: startsAt.toISOString(),
    setBy: actor.actorId,
    setAt: now.toISOString(),
    ...(override ? { override } : {}),
  });
}

/** Hand the pager to one person until a date, for a reason that stays on the record. Clearing is `operatorId: null`. */
export function setOverride(
  platform: Platform,
  actor: AuthContext,
  input: { operatorId: string | null; until?: string; reason: string },
  now = new Date(),
): OnCallRota {
  const rota = rotaOf(platform);
  if (!rota) throw new DomainError('ONCALL_NO_ROTA', 'Set the rota before overriding it', 409);
  const reason = input.reason.trim();
  if (reason.length < 3) throw new DomainError('REASON_REQUIRED', 'Say why the pager is being handed over; it stays on the record', 422);

  if (input.operatorId === null) {
    if (!rota.override) throw new DomainError('ONCALL_NO_OVERRIDE', 'No override is in force', 409);
    const { override: _cleared, ...rest } = rota;
    return commit(platform, actor.actorId, 'ONCALL_OVERRIDE_SET', { ...rest, setBy: rota.setBy, setAt: rota.setAt });
  }

  const operator = operatorById(platform, input.operatorId);
  const until = input.until ? new Date(input.until) : new Date(now.getTime() + rota.rotationDays * DAY_MS);
  if (Number.isNaN(until.getTime()) || until.getTime() <= now.getTime()) {
    throw new DomainError('ONCALL_UNTIL_INVALID', 'The override ends at a date in the future', 422);
  }
  return commit(platform, actor.actorId, 'ONCALL_OVERRIDE_SET', {
    ...rota,
    override: { operatorId: operator.id, name: operator.name, email: operator.email, until: until.toISOString(), reason, setBy: actor.actorId, setAt: now.toISOString() },
  });
}

export type OnCallNow = {
  /** Who holds the pager now, or null with no rota. */
  person: OnCallMember | null;
  /** When they hand over. */
  until: string | null;
  /** Whether the person is there by override rather than by rotation. */
  byOverride: boolean;
  next: OnCallMember | null;
};

/** Who is on call at an instant, derived from the rota as it stands. */
export function onCallAt(platform: Platform, now = new Date()): OnCallNow {
  const rota = rotaOf(platform);
  if (!rota || rota.members.length === 0) return { person: null, until: null, byOverride: false, next: null };

  const period = rota.rotationDays * DAY_MS;
  const start = Date.parse(rota.startsAt);
  // Before the start, the first member holds it: a rota set to begin on
  // Monday still has to name somebody on Sunday night.
  const elapsed = Math.max(0, now.getTime() - start);
  const index = Math.floor(elapsed / period) % rota.members.length;
  const rotationUntil = new Date(start + (Math.floor(elapsed / period) + 1) * period);
  const byRotation = rota.members[index]!;
  const next = rota.members[(index + 1) % rota.members.length]!;

  if (rota.override && Date.parse(rota.override.until) > now.getTime()) {
    const overrideUntil = new Date(rota.override.until);
    const person = { operatorId: rota.override.operatorId, name: rota.override.name, email: rota.override.email };
    // When the override lapses, whoever the rotation names then takes over.
    const afterIndex = Math.floor(Math.max(0, overrideUntil.getTime() - start) / period) % rota.members.length;
    return { person, until: overrideUntil.toISOString(), byOverride: true, next: rota.members[afterIndex]! };
  }
  return { person: byRotation, until: rotationUntil.toISOString(), byOverride: false, next };
}

export type OnCallPosition = {
  rota: OnCallRota | null;
  now: OnCallNow;
  /** The next handovers, so the week is visible. */
  schedule: Array<{ from: string; until: string; person: OnCallMember }>;
  /** Every operator, so a rota can be composed from them. */
  operators: OnCallMember[];
};

export function onCallPosition(platform: Platform, now = new Date()): OnCallPosition {
  const rota = rotaOf(platform) ?? null;
  const schedule: OnCallPosition['schedule'] = [];
  if (rota && rota.members.length > 0) {
    let at = now;
    for (let step = 0; step < Math.min(8, rota.members.length * 2); step += 1) {
      const standing = onCallAt(platform, at);
      if (!standing.person || !standing.until) break;
      schedule.push({ from: at.toISOString(), until: standing.until, person: standing.person });
      at = new Date(Date.parse(standing.until) + 1);
    }
  }
  return {
    rota,
    now: onCallAt(platform, now),
    schedule,
    operators: platform.operators().map((operator) => ({ operatorId: operator.id, name: operator.name, email: operator.email })),
  };
}
