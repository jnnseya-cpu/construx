import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { scopesForRoles, type Scope } from '../identity/scopes.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { GoldenThreadLedger } from '../goldenthread/ledger.ts';
import type { Role } from '../identity/roles.ts';

/**
 * API keys, for the integrator who is not a person.
 *
 * A key is an identity that carries a **narrower** scope set than the person who
 * created it — never a wider one, and never an equal one by accident. That is
 * the whole design: an integration wants to post daily progress, and giving it a
 * user's session gives it the ability to certify a payment.
 *
 * ## Sandbox is a tenancy, not a flag
 *
 * A sandbox key acts on a **separate tenancy** — `<tenant>-sandbox` — rather than
 * on the live one behind a boolean. This matters more than it sounds. A flag is
 * a filter, and every filter is one forgotten `if` away from a sandbox
 * integration writing into a live payment cycle. A separate tenancy is enforced
 * by the isolation the platform already applies to every read and every write,
 * everywhere, without a single new check.
 *
 * It also means a sandbox is genuinely usable: an integrator can create, break
 * and delete records freely, because none of them is anybody's evidence.
 *
 * ## What a key can never be
 *
 * - **Wider than its creator.** Requested scopes are intersected with what the
 *   creating actor actually holds. Asking for more is refused by name rather
 *   than silently trimmed, because silently trimming means an integration that
 *   half works and nobody knows why.
 * - **`admin:*`.** A machine credential that can do anything is the one that
 *   ends up in a public repository. Refused outright, for every caller,
 *   including a platform operator.
 * - **Recoverable.** The secret is shown once and stored only as a SHA-256
 *   digest. A leaked database is not a leaked key.
 * - **Open-ended.** Every key has an expiry. The credential nobody remembers
 *   issuing is the one still working in three years.
 */

export type KeyMode = 'SANDBOX' | 'LIVE';

export type ApiKey = {
  id: string;
  /** The public half, safe to log and to show: `ck_live_…` / `ck_test_…`. */
  prefix: string;
  name: string;
  mode: KeyMode;
  /** The tenancy this key acts in. For SANDBOX, the sandbox tenancy. */
  tenantId: string;
  /** The live tenancy that owns it, so a sandbox key is traceable to its customer. */
  ownerTenantId: string;
  /** The identity a request made with this key acts as. */
  actorId: string;
  roles: Role[];
  scopes: Scope[];
  /** SHA-256 of the secret. The secret itself is never stored. */
  secretHash: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
};

/** What a caller sees exactly once, at creation. */
export type IssuedKey = { key: ApiKey; secret: string };

/** The longest a key may live. A year is a decision; five is an oversight. */
export const MAX_KEY_DAYS = 366;

const DAY_MS = 86_400_000;

/** The sandbox tenancy for a live one. Derived, never chosen by a caller. */
export function sandboxTenantOf(tenantId: string): string {
  return `${tenantId}-sandbox`;
}

/** True where this tenancy is a sandbox. Used to keep the two apart on screens. */
export function isSandboxTenant(tenantId: string): boolean {
  return tenantId.endsWith('-sandbox');
}

function keysOf(ctx: EngineContext): ApiKey[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'ApiKey')
    .map((record) => record.state as unknown as ApiKey);
}

/**
 * Issue a key.
 *
 * Authorised against `ENTERPRISE_STRUCTURE` `G` — the same governance authority
 * that grants an agent an envelope, and for the same reason: handing out a
 * credential that acts on this tenancy's record is a decision about the
 * enterprise, not an ordinary write.
 */
export function issueKey(
  ctx: EngineContext,
  input: { name: string; mode: KeyMode; scopes: string[]; expiresInDays?: number },
): IssuedKey {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');

  if (input.name.trim().length < 3) {
    throw new DomainError('API_KEY_NAME_REQUIRED', 'Name the integration this key is for. "key 4" is not a name.');
  }
  if (input.scopes.length === 0) {
    throw new DomainError('API_KEY_SCOPES_REQUIRED', 'A key with no scopes can do nothing. Name what this integration needs.');
  }

  // `admin:*` is refused for everybody, including an operator who holds it.
  // There is no integration whose correct answer is "everything".
  if (input.scopes.includes('admin:*')) {
    throw new DomainError(
      'API_KEY_SCOPE_FORBIDDEN',
      'No API key may hold admin:*. A machine credential that can do anything is the one that ends up in a public repository.',
    );
  }

  // Never wider than its creator. Refused by name rather than trimmed: a key
  // that half works because two scopes were silently dropped is a support call
  // nobody can answer.
  const held = new Set<string>(ctx.auth.scopes);
  const tooWide = input.scopes.filter((scope) => !held.has(scope) && !held.has('admin:*'));
  if (tooWide.length > 0) {
    throw new DomainError(
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
      `You do not hold ${tooWide.join(', ')}, so a key you create cannot. A key is never wider than the person who issued it.`,
    );
  }

  const days = input.expiresInDays ?? 90;
  if (days < 1 || days > MAX_KEY_DAYS) {
    throw new DomainError(
      'API_KEY_EXPIRY_INVALID',
      `A key may live between 1 and ${MAX_KEY_DAYS} days. The credential nobody remembers issuing is the one still working in three years.`,
    );
  }

  // 32 bytes from the CSPRNG. The prefix is public and identifies the key
  // without revealing it, so a log line can name which key made a call.
  const secretBytes = randomBytes(32).toString('base64url');
  const prefix = `ck_${input.mode === 'LIVE' ? 'live' : 'test'}_${randomBytes(6).toString('hex')}`;
  const secret = `${prefix}.${secretBytes}`;

  const key: ApiKey = {
    id: ulid(),
    prefix,
    name: input.name.trim(),
    mode: input.mode,
    tenantId: input.mode === 'SANDBOX' ? sandboxTenantOf(ctx.tenantId) : ctx.tenantId,
    ownerTenantId: ctx.tenantId,
    // Acts as the person who issued it. Not as a synthetic service account: an
    // event authored by "the API" is one nobody can be asked about, and every
    // event on this platform names somebody who can be.
    actorId: ctx.auth.actorId,
    roles: [...ctx.auth.roles],
    scopes: [...input.scopes] as Scope[],
    secretHash: createHash('sha256').update(secret).digest('hex'),
    createdBy: ctx.auth.actorId,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + days * DAY_MS).toISOString(),
  };

  write(ctx, {
    eventType: 'API_KEY_ISSUED',
    entity: { refType: 'ApiKey', refId: key.id },
    // The digest goes to the ledger; the secret does not. An append-only record
    // is the last place a credential should be, because it cannot be removed.
    nextState: key as unknown as Record<string, unknown>,
  });
  index.set(key.prefix, key);

  return { key, secret };
}

/** Withdraw a key. Immediate: the next request made with it is refused. */
export function revokeKey(ctx: EngineContext, input: { keyId: string; reason: string }): ApiKey {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');

  const record = ctx.ledger.get({ refType: 'ApiKey', refId: input.keyId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('API_KEY_NOT_FOUND', `No API key ${input.keyId}`, 404);
  }
  const key = record.state as unknown as ApiKey;
  if (key.revokedAt) {
    throw new DomainError('API_KEY_ALREADY_REVOKED', `That key was withdrawn on ${key.revokedAt}`, 409);
  }
  if (input.reason.trim().length < 4) {
    throw new DomainError('API_KEY_REASON_REQUIRED', 'Say why the key is being withdrawn.');
  }

  const revoked: ApiKey = {
    ...key,
    revokedAt: new Date().toISOString(),
    revokedBy: ctx.auth.actorId,
    revokedReason: input.reason.trim(),
  };

  write(ctx, {
    eventType: 'API_KEY_REVOKED',
    entity: { refType: 'ApiKey', refId: key.id },
    nextState: revoked as unknown as Record<string, unknown>,
  });
  // Immediate. The next request made with this key is refused, rather than
  // working until something happens to reload.
  index.set(revoked.prefix, revoked);

  return revoked;
}

/** Every key this tenancy has ever issued, with the secret nowhere in sight. */
export function keyRegister(ctx: EngineContext, now = new Date().toISOString()): Array<Omit<ApiKey, 'secretHash'> & { live: boolean }> {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'R');

  return keysOf(ctx).map((key) => {
    const { secretHash: _withheld, ...rest } = key;
    return { ...rest, live: !key.revokedAt && key.expiresAt > now };
  });
}

/**
 * Every live key, indexed by its public prefix.
 *
 * Authentication happens before the platform knows whose request this is, so it
 * cannot use a tenant-scoped read — and `entitiesOfType` says in its own
 * doc-comment that nothing serving a request may use it, which is correct: an
 * unscoped scan on the authentication path is one refactor away from becoming an
 * unscoped scan on a data path.
 *
 * So keys are indexed the same way identities already are — rebuilt from the
 * ledger at boot, maintained by issue and revoke. `main.ts` already restores the
 * people who can sign in; this restores the credentials that can.
 */
const index = new Map<string, ApiKey>();

/** Rebuild the index from the record. Boot only, like identity rehydration. */
export function rehydrateKeys(ledger: GoldenThreadLedger): number {
  index.clear();
  for (const record of ledger.entitiesOfType('ApiKey')) {
    const key = record.state as unknown as ApiKey;
    index.set(key.prefix, key);
  }
  return index.size;
}

/** Test isolation only. */
export function resetKeys(): void {
  index.clear();
}

/**
 * Resolve a presented secret to the identity it authorises.
 *
 * Returns `undefined` for anything that is not a live key. Callers must not
 * distinguish "no such key" from "revoked" from "expired" in what they tell the
 * client: those three answers together are an oracle for enumerating which keys
 * exist.
 */
export function resolveKey(secret: string, now = Date.now()): AuthContext | undefined {
  const prefix = secret.split('.')[0] ?? '';
  if (!/^ck_(live|test)_[0-9a-f]{12}$/.test(prefix)) return undefined;

  const presented = createHash('sha256').update(secret).digest();

  {
    const key = index.get(prefix);
    if (!key) return undefined;

    const stored = Buffer.from(key.secretHash, 'hex');
    // Constant time, so a wrong key cannot be narrowed down by how long the
    // comparison took. The prefix already selected the candidate, so this is
    // one comparison rather than a scan.
    if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) return undefined;

    if (key.revokedAt) return undefined;
    if (Date.parse(key.expiresAt) <= now) return undefined;

    return {
      actorId: key.actorId,
      tenantId: key.tenantId,
      roles: key.roles,
      scopes: key.scopes,
      // The key's own id, so a request made with it is attributable to the key
      // and not only to the person who issued it — which is what makes "revoke
      // the key that did this" a possible instruction.
      tokenId: key.id,
      // A key never satisfies MFA. Anything gated on a second factor is a
      // ceremony a person performs, and a credential in a config file is not a
      // person performing one.
      mfaSatisfied: false,
      regulatorAiEnabled: false,
      expiresAt: Date.parse(key.expiresAt),
    };
  }
}

/**
 * The scopes a role could grant, so a developer screen offers real choices.
 *
 * Published rather than hardcoded in the console, for the same reason the
 * permission matrix is: two lists of what a role may do will eventually
 * disagree, and the one in the browser is the one that will be wrong.
 */
export function grantableScopes(roles: Role[]): Scope[] {
  return scopesForRoles(roles).filter((scope) => scope !== 'admin:*');
}
