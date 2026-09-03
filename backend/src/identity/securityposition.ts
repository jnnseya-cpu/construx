import { config } from '../config.ts';
import { assessRisk, riskModel, stepUpSatisfied, type RiskAssessment } from './risk.ts';
import { devicesFor, devicesForTenant, publicView as deviceView, type DeviceRecord } from './devices.ts';
import { passkeysFor, passkeysForTenant, publicView as passkeyView, type PasskeyRecord } from './passkeys.ts';
import { authenticatorFor, type PublicAuthenticator } from './authenticators.ts';
import type { AuthContext } from './auth.ts';

/**
 * What the security screen reads.
 *
 * One endpoint per audience — a person's own posture, and a tenancy's — because
 * those are two different questions and a screen that guessed which one it was
 * showing would eventually show the wrong one.
 *
 * The derivations here are the reason this is a module rather than a handler:
 * the console needs counts, distributions and a trend to draw, and every one of
 * those has to be computed from the same records the register shows, or the
 * chart and the table underneath it will disagree.
 */

const DAY_MS = 86_400_000;

export type SecurityPosture = {
  /** How strong this person's own credentials are, in one word and one sentence. */
  standing: 'STRONG' | 'ADEQUATE' | 'WEAK';
  statement: string;
  devices: Array<Omit<DeviceRecord, 'secretHash'>>;
  passkeys: Array<Omit<PasskeyRecord, 'publicKey'>>;
  /** The authenticator app enrolled as a second factor, or null. */
  authenticator: PublicAuthenticator | null;
  /** This session's own assessment, with everything it counted. */
  session: RiskAssessment & { bound: boolean; steppedUp: boolean };
  /** Devices by platform, for the composition chart. */
  byPlatform: Array<{ label: string; value: number }>;
  /** Sightings per day over the last thirty, for the activity trend. */
  activity: Array<{ label: string; sightings: number }>;
  /** The published model, so the screen explains rather than asserts. */
  model: ReturnType<typeof riskModel>;
  /** What would make this stronger, in order. Empty where nothing would. */
  advice: Array<{ action: string; because: string }>;
};

/**
 * Grade a person's own posture.
 *
 * Deliberately three bands and not a score out of a hundred. A score invites
 * a person to optimise the number; three bands and a sentence invite them to do
 * the one thing that would move it, which is what the advice list is for.
 */
export function posture(auth: AuthContext, verifiedDevice?: DeviceRecord, now = Date.now()): SecurityPosture {
  const devices = devicesFor(auth.actorId);
  const active = devices.filter((device) => device.status === 'ACTIVE');
  const passkeys = passkeysFor(auth.actorId);
  const authenticator = authenticatorFor(auth.actorId);
  // A second factor of either kind: a passkey, or an authenticator app.
  const secondFactor = passkeys.length > 0 || authenticator !== undefined;

  const session = assessRisk(
    {
      actorId: auth.actorId,
      // The device the *gateway* verified, not one looked up from a token
      // claim. The claim says which device the token was minted for; only the
      // gateway knows whether this request actually proved it. Scoring against
      // the claim would give an unproved request the credit of a bound one.
      device: verifiedDevice,
      authenticatedAt: auth.authenticatedAt,
      machineCredential: false,
    },
    {},
    now,
  );

  const standing: SecurityPosture['standing'] =
    secondFactor && active.length > 0 ? 'STRONG' : active.length > 0 || secondFactor ? 'ADEQUATE' : 'WEAK';

  const advice: SecurityPosture['advice'] = [];
  if (!secondFactor) {
    advice.push({
      action: 'Set up an authenticator app or add a passkey',
      because:
        'A one-time code by email is a shared secret in transit, and every serious attack on an account like this ends with somebody reading one out. A second factor on a device you hold cannot be read out of a mailbox.',
    });
  } else if (passkeys.length === 0) {
    advice.push({
      action: 'Add a passkey',
      because: 'An authenticator code can still be typed into a lookalike site; a passkey will not sign for one, because the origin is part of what it signs.',
    });
  }
  if (authenticator && authenticator.recoveryCodesLeft <= 2) {
    advice.push({
      action: authenticator.recoveryCodesLeft === 0 ? 'Generate new recovery codes' : `Generate new recovery codes (${authenticator.recoveryCodesLeft} left)`,
      because: 'A recovery code is how you get in when the phone is lost. Running out of them is being locked out with the door in sight.',
    });
  }
  if (active.length === 0) {
    advice.push({
      action: 'Enrol this device',
      because:
        'Until a device is enrolled, a copy of this session’s token works from anywhere, and there is nothing to revoke if a machine is lost.',
    });
  }
  if (active.length > 3) {
    advice.push({
      action: `Review ${active.length} enrolled devices`,
      because: 'A device nobody remembers enrolling is one nobody will notice being used.',
    });
  }
  const stale = active.filter((device) => device.lastSeenAt && now - Date.parse(device.lastSeenAt) > 90 * DAY_MS);
  if (stale.length > 0) {
    advice.push({
      action: `Revoke ${stale.length} device${stale.length === 1 ? '' : 's'} unused for 90 days`,
      because: 'A device that has not been used in three months is either gone or forgotten, and both should be off.',
    });
  }

  return {
    standing,
    statement:
      standing === 'STRONG'
        ? `A second factor and ${active.length} enrolled device${active.length === 1 ? '' : 's'}. Signing in takes something you hold as well as something sent to you.`
        : standing === 'ADEQUATE'
          ? 'Better than a code alone, and one step short of an account that cannot be phished.'
          : 'This account is protected by a code sent to an inbox and nothing else.',
    devices: devices.map(deviceView),
    passkeys: passkeys.map(passkeyView),
    authenticator: authenticator ?? null,
    session: { ...session, bound: verifiedDevice !== undefined, steppedUp: stepUpSatisfied(auth.tokenId, now) },
    byPlatform: countBy(active, (device) => device.platform),
    activity: sightings(active, now),
    model: riskModel(),
    advice,
  };
}

export type TenantSecurity = {
  /** Everybody's devices, so an administrator can see the tenancy's exposure. */
  devices: Array<Omit<DeviceRecord, 'secretHash'>>;
  passkeys: Array<Omit<PasskeyRecord, 'publicKey'>>;
  /** How many of the tenancy's people hold each kind of credential. */
  adoption: { people: number; withDevice: number; withPasskey: number; withNeither: number };
  byPlatform: Array<{ label: string; value: number }>;
  /** Enrolments per day over the last thirty, for the roll-out trend. */
  enrolment: Array<{ label: string; devices: number; passkeys: number }>;
  /** Devices grouped by how recently they were used. */
  freshness: Array<{ label: string; value: number; tone: string }>;
  revoked: Array<Omit<DeviceRecord, 'secretHash'>>;
  /** Whether this deployment refuses an unbound session outright. */
  bindingRequired: boolean;
  summary: string;
};

/**
 * The tenancy's exposure.
 *
 * `people` is passed in rather than read here, because this module has no
 * business knowing how the platform stores users — and because the count that
 * matters is "people who could enrol", which is a question about seats.
 */
export function tenantSecurity(tenantId: string, peopleIds: readonly string[], now = Date.now()): TenantSecurity {
  const devices = devicesForTenant(tenantId);
  const active = devices.filter((device) => device.status === 'ACTIVE');
  const passkeys = passkeysForTenant(tenantId).filter((passkey) => !passkey.revokedAt);

  const withDevice = new Set(active.map((device) => device.actorId));
  const withPasskey = new Set(passkeys.map((passkey) => passkey.actorId));
  const withNeither = peopleIds.filter((id) => !withDevice.has(id) && !withPasskey.has(id)).length;

  const days = 30;
  const enrolment = lastDays(days, now).map((day) => ({
    label: day.label,
    devices: devices.filter((device) => device.enrolledAt.slice(0, 10) === day.iso).length,
    passkeys: passkeys.filter((passkey) => passkey.createdAt.slice(0, 10) === day.iso).length,
  }));

  // Buckets rather than a mean. "Average 41 days since last use" hides the
  // twelve machines nobody has touched since March.
  const bucket = (device: DeviceRecord): string => {
    if (!device.lastSeenAt) return 'Never used';
    const age = (now - Date.parse(device.lastSeenAt)) / DAY_MS;
    if (age <= 7) return 'This week';
    if (age <= 30) return 'This month';
    if (age <= 90) return 'Last quarter';
    return 'Over 90 days';
  };
  const TONES: Record<string, string> = {
    'This week': 'ok',
    'This month': 'ok',
    'Last quarter': 'warn',
    'Over 90 days': 'bad',
    'Never used': 'bad',
  };
  const freshness = countBy(active, bucket).map((entry) => ({ ...entry, tone: TONES[entry.label] ?? 'neutral' }));

  return {
    devices: devices.map(deviceView),
    passkeys: passkeys.map(passkeyView),
    adoption: { people: peopleIds.length, withDevice: withDevice.size, withPasskey: withPasskey.size, withNeither },
    byPlatform: countBy(active, (device) => device.platform),
    enrolment,
    freshness,
    revoked: devices.filter((device) => device.status === 'REVOKED').map(deviceView),
    bindingRequired: config.auth.requireDeviceBinding,
    summary:
      peopleIds.length === 0
        ? 'No people on this tenancy yet.'
        : `${withPasskey.size} of ${peopleIds.length} ${withPasskey.size === 1 ? 'person holds' : 'people hold'} a passkey, ` +
          `${withDevice.size} ${withDevice.size === 1 ? 'has' : 'have'} an enrolled device, and ${withNeither} ` +
          `${withNeither === 1 ? 'is' : 'are'} protected by a one-time code alone.` +
          (config.auth.requireDeviceBinding
            ? ' Device binding is required, so an unbound session is refused outright.'
            : ' Device binding is not required, so an unbound session is scored rather than refused.'),
  };
}

// --- Shaping -----------------------------------------------------------------

function countBy<T>(items: readonly T[], key: (item: T) => string): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

function lastDays(count: number, now: number): Array<{ iso: string; label: string }> {
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(now - (count - 1 - index) * DAY_MS);
    return { iso: at.toISOString().slice(0, 10), label: at.toISOString().slice(5, 10) };
  });
}

/**
 * Sightings per day.
 *
 * Derived from `lastSeenAt` alone, which is one point per device rather than a
 * history — so a device seen every day for a month contributes one sighting, on
 * the day it was last seen. That is stated rather than smoothed over: the chart
 * shows *when devices were last active*, which is a real and useful shape, and
 * a per-request history would be a surveillance log of a named employee's
 * working hours, which is not something to build without being asked.
 */
function sightings(devices: readonly DeviceRecord[], now: number): Array<{ label: string; sightings: number }> {
  return lastDays(30, now).map((day) => ({
    label: day.label,
    sightings: devices.filter((device) => device.lastSeenAt?.slice(0, 10) === day.iso).length,
  }));
}
