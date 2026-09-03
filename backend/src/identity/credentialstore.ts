import { ulid } from '../core/ids.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import { useAuthenticatorStore, type AuthenticatorRecord, type AuthenticatorStore } from './authenticators.ts';
import { useDeviceStore, type DeviceRecord, type DeviceStore } from './devices.ts';
import { usePasskeyStore, type PasskeyRecord, type PasskeyStore } from './passkeys.ts';

/**
 * Devices and passkeys, kept in the ledger.
 *
 * `devices.ts` and `passkeys.ts` deliberately do not import the ledger. They are
 * called from `authenticate`, which runs **before** any `EngineContext` exists —
 * there is no project, no authorised actor and no `write` to reach for at the
 * moment a request's device binding has to be checked. So each declares a narrow
 * store interface and this file is the one place that satisfies it against the
 * real ledger.
 *
 * That separation does one more thing worth stating: it makes both modules
 * testable without standing up a ledger, which is why their test file builds
 * real WebAuthn ceremonies rather than asserting against captured fixtures.
 *
 * ## Why these go in the ledger at all
 *
 * `identity/lockout.ts` argues the opposite way for lockouts, and both arguments
 * are right for their subject. A lock is operational state about the last few
 * minutes, and a restart forgiving it makes the platform *more* cautious, not
 * less. **A revocation is the reverse**: a revoked device that came back after a
 * restart would be a live session somebody believed they had ended, which is a
 * security defect rather than an inconvenience. So it is written where facts go,
 * survives a restart, and appears in the audit feed like every other governance
 * act.
 *
 * ## Resolving a credential before there is a caller to scope to
 *
 * `ledger.entitiesOfType` is documented as boot-only — "nothing serving a
 * request may use it" — and a device lookup inside `authenticate` is serving a
 * request. That rule is respected rather than argued with:
 *
 *   - **At bind time** (boot, once) the unscoped read runs, which is exactly
 *     what it is for, and builds an id → tenancy index.
 *   - **On every request** the index gives the tenancy, and the actual record is
 *     read with `listByTenant`, which is a scoped read like every other.
 *   - **Every write** updates the index, so a device enrolled after boot is
 *     resolvable without a second unscoped read.
 *
 * The index holds nothing but a tenancy string per credential id. It is not a
 * cache of records that could go stale against the ledger — the record always
 * comes from the ledger.
 *
 * ## The write path
 *
 * Written through `ledger.commit` rather than through `write()` from
 * `engines/context.ts`, because `write` requires an `EngineContext` and the
 * whole point of this file is the moments where there is not one. The event
 * codes are in the same closed catalogue and carry the same actor, tenancy and
 * ordering discipline; what is skipped is *project* scoping, because a device
 * belongs to a person and a tenancy rather than to a job.
 */

/** The pseudo-project a tenancy's credentials are filed under. */
export function credentialRegister(tenantId: string): string {
  return `${tenantId}-credentials`;
}

/**
 * Credential id → tenancy.
 *
 * Module-level rather than per-binding so that a rebind — which the tests do
 * between cases — starts from a clean index rather than inheriting one.
 */
let deviceTenancy = new Map<string, string>();
let passkeyTenancy = new Map<string, string>();

function commit(
  ledger: GoldenThreadLedger,
  input: { eventType: string; refType: string; refId: string; tenantId: string; actorId: string; state: Record<string, unknown> },
): void {
  ledger.commit({
    projectId: credentialRegister(input.tenantId),
    tenantId: input.tenantId,
    eventType: input.eventType,
    entity: { refType: input.refType, refId: input.refId },
    // A person enrolling their own device is the actor; a revocation performed
    // by an administrator names the administrator. Both are `User` — nothing
    // here is ever produced by an agent, and `aiAllowed` is false on all seven
    // codes, so an AI actor would be refused at the ledger itself.
    actor: { refType: 'User', refId: input.actorId },
    source: 'WEB',
    // Its own correlation id. A credential act is not part of a request chain
    // the caller started — enrolment is, but a sighting written mid-request is
    // a side effect, and threading the caller's id onto it would make the audit
    // feed claim the person asked for it.
    correlationId: ulid(),
    nextState: input.state,
  });
}

export function bindCredentialStores(ledger: GoldenThreadLedger): void {
  // The one unscoped read, at boot, which is what `entitiesOfType` exists for.
  deviceTenancy = new Map(
    ledger.entitiesOfType('Device').map((record) => [String(record.state.id), record.tenantId]),
  );
  passkeyTenancy = new Map(
    ledger.entitiesOfType('Passkey').map((record) => [String(record.state.credentialId), record.tenantId]),
  );

  const deviceIn = (tenantId: string) =>
    ledger.listByTenant(tenantId, 'Device').map((record) => record.state as unknown as DeviceRecord);
  const passkeyIn = (tenantId: string) =>
    ledger.listByTenant(tenantId, 'Passkey').map((record) => record.state as unknown as PasskeyRecord);

  const devices: DeviceStore = {
    get(deviceId) {
      const tenantId = deviceTenancy.get(deviceId);
      if (!tenantId) return undefined;
      return deviceIn(tenantId).find((device) => device.id === deviceId);
    },
    put(device) {
      const existing = ledger.get({ refType: 'Device', refId: device.id });
      const newlyRevoked = device.status === 'REVOKED' && existing?.state.status !== 'REVOKED';
      // Three call sites rather than one with a computed code. The catalogue
      // invariant reads `eventType:` lines for literals, and an event whose
      // name only ever appears in a variable is one it cannot see — so a
      // computed code would read as a dead event and would have to be excused
      // in `NOT_EMITTED`, which would be a lie about a code that is emitted.
      const entry = {
        refType: 'Device',
        refId: device.id,
        tenantId: device.tenantId,
        actorId: device.revokedBy ?? device.actorId,
        state: device as unknown as Record<string, unknown>,
      };
      if (!existing) commit(ledger, { eventType: 'DEVICE_ENROLLED', ...entry });
      else if (newlyRevoked) commit(ledger, { eventType: 'DEVICE_REVOKED', ...entry });
      else commit(ledger, { eventType: 'DEVICE_SEEN', ...entry });
      deviceTenancy.set(device.id, device.tenantId);
    },
    forActor(actorId) {
      // A person's own register. The tenancy comes from the index rather than
      // from a scan, and a person only ever has devices in one tenancy.
      const tenancies = new Set([...deviceTenancy.values()]);
      return [...tenancies].flatMap((tenantId) => deviceIn(tenantId)).filter((device) => device.actorId === actorId);
    },
    forTenant(tenantId) {
      return deviceIn(tenantId);
    },
  };

  const passkeys: PasskeyStore = {
    get(credentialId) {
      const tenantId = passkeyTenancy.get(credentialId);
      if (!tenantId) return undefined;
      return passkeyIn(tenantId).find((passkey) => passkey.credentialId === credentialId);
    },
    put(passkey) {
      const existing = ledger.get({ refType: 'Passkey', refId: passkey.id });
      const newlyRevoked = Boolean(passkey.revokedAt) && !existing?.state.revokedAt;
      const entry = {
        refType: 'Passkey',
        refId: passkey.id,
        tenantId: passkey.tenantId,
        actorId: passkey.revokedBy ?? passkey.actorId,
        state: passkey as unknown as Record<string, unknown>,
      };
      if (!existing) commit(ledger, { eventType: 'PASSKEY_REGISTERED', ...entry });
      else if (newlyRevoked) commit(ledger, { eventType: 'PASSKEY_REVOKED', ...entry });
      else commit(ledger, { eventType: 'PASSKEY_USED', ...entry });
      passkeyTenancy.set(passkey.credentialId, passkey.tenantId);
    },
    forActor(actorId) {
      const tenancies = new Set([...passkeyTenancy.values()]);
      return [...tenancies].flatMap((tenantId) => passkeyIn(tenantId)).filter((passkey) => passkey.actorId === actorId);
    },
    forTenant(tenantId) {
      return passkeyIn(tenantId);
    },
  };

  // Authenticator apps, kept the same way and for the same reason: a second
  // factor that vanished on restart would be a requirement the platform could
  // not hold, and a revocation that came back would be a factor somebody
  // believed they had removed.
  // Read live from the ledger rather than through an index taken at bind
  // time: the platform binds its stores in the constructor, before a journal
  // is replayed into the ledger, so an index built here would miss everything
  // a restart brought back.
  const authenticatorIn = (tenantId: string) =>
    ledger.listByTenant(tenantId, 'Authenticator').map((record) => record.state as unknown as AuthenticatorRecord);
  const authenticators: AuthenticatorStore = {
    forActor(actorId) {
      return ledger
        .entitiesOfType('Authenticator')
        .map((record) => record.state as unknown as AuthenticatorRecord)
        .find((record) => record.actorId === actorId && !record.revokedAt);
    },
    forTenant(tenantId) {
      return authenticatorIn(tenantId);
    },
    put(record, event) {
      const entry = {
        refType: 'Authenticator',
        refId: record.id,
        tenantId: record.tenantId,
        actorId: record.revokedBy ?? record.actorId,
        state: record as unknown as Record<string, unknown>,
      };
      if (event === 'ENROLLED') commit(ledger, { eventType: 'AUTHENTICATOR_ENROLLED', ...entry });
      else if (event === 'REVOKED') commit(ledger, { eventType: 'AUTHENTICATOR_REVOKED', ...entry });
      else if (event === 'RECOVERY_CODES_ISSUED') commit(ledger, { eventType: 'AUTHENTICATOR_RECOVERY_CODES_ISSUED', ...entry });
      else commit(ledger, { eventType: 'AUTHENTICATOR_USED', ...entry });
    },
  };

  useDeviceStore(devices);
  usePasskeyStore(passkeys);
  useAuthenticatorStore(authenticators);
}
