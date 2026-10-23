import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';

/**
 * The credentials an operator sets without a shell.
 *
 * ## The one rule this file exists to hold
 *
 * **A secret never enters the Golden Thread.** The ledger is append-only and
 * hash-chained, and it is copied into the journal, the snapshot, every backup
 * and the object store. A key written there could never be rotated out — not by
 * the operator, not by anybody — and it would leave the platform in a state
 * where the honest remedy is to destroy the chain. So the value lives here, in
 * a file beside the journal and never in it, and the ledger records only the
 * *act*: which credential was set, by whom, when and why.
 *
 * That split is also why this is not a settings table. Everything else an
 * operator changes is a decision somebody should be able to read back; a
 * credential is the one kind of configuration whose value nobody should ever
 * read back, including the operator who set it.
 *
 * ## Encrypted, and what that is and is not worth
 *
 * AES-256-GCM under a key derived from `GATEWAY_JWT_SECRET` with HKDF, under
 * its own label, exactly as `secrets.ts` derives a key per purpose. Stated
 * plainly: this protects the file, not the process. Anybody who can read the
 * environment of the running container can derive the key, and anybody who can
 * read the environment could have read `.env` anyway. What it buys is real but
 * narrow — a stolen volume, a copied backup or a stray `cat` of the data
 * directory yields ciphertext rather than a working key.
 *
 * Writing it in the clear would have bought nothing and read as though it had.
 *
 * ## Read back, never
 *
 * `credential()` is for the platform's own call sites. No route returns a
 * value, and the shape the console gets — `CredentialState` — carries whether
 * it is set, the key id, who set it and when. The key id is the first eight hex
 * characters of its SHA-256: enough to tell one key from another and to confirm
 * a rotation landed, and not enough to be a key.
 *
 * ## The environment still wins where nothing is stored
 *
 * `credential(name) ?? config…` at every call site. A deployment configured
 * entirely through `.env` behaves exactly as it did, and an operator setting a
 * credential here overrides it for the running process. The precedence is that
 * way round because this is the newer, revocable place: clearing a credential
 * here falls back to whatever `.env` holds rather than leaving the platform
 * with nothing.
 */

let cache: StoreFile | undefined;

/** The label the encryption key is derived under. Its own, so it shares nothing. */
const KEY_LABEL = 'construx/credential-store/v1';

/**
 * Every credential an operator may set, and nothing else.
 *
 * A closed list rather than an open key/value store. An open one would accept
 * `OPENAI_KEY`, store it, show it as set, and change nothing about how the
 * platform behaves — which is worse than refusing, because the screen would
 * then be evidence that the key was configured.
 *
 * `unlocks` is what stops working without it, in the words of somebody deciding
 * whether to go and find the value.
 */
export const CREDENTIALS = [
  {
    name: 'OPENAI_API_KEY',
    label: 'OpenAI',
    group: 'AI providers',
    unlocks: 'Reading a document, parsing a questionnaire, drafting and scoring an answer — wherever OpenAI serves reasoning or perception.',
  },
  {
    name: 'GEMINI_API_KEY',
    label: 'Google Gemini',
    group: 'AI providers',
    unlocks: 'The same work where Gemini is the configured provider, and the failover chain when another vendor is unhealthy.',
  },
  {
    name: 'ANTHROPIC_API_KEY',
    label: 'Anthropic Claude',
    group: 'AI providers',
    unlocks: 'The same work where Anthropic is configured, and the failover chain. Anthropic publishes no embedding endpoint, so never semantic search.',
  },
  {
    name: 'STRIPE_SECRET_KEY',
    label: 'Stripe — secret key',
    group: 'Payments',
    unlocks: 'Taking a payment at all. Without it no checkout can be created and the platform records payments somebody tells it about.',
  },
  {
    name: 'STRIPE_WEBHOOK_SECRET',
    label: 'Stripe — webhook signing secret',
    group: 'Payments',
    unlocks:
      'Trusting what Stripe sends back. Without it a settlement notice cannot be verified as Stripe’s, and the platform refuses it rather than crediting a wallet on an unsigned message.',
  },
] as const;

export type CredentialName = (typeof CREDENTIALS)[number]['name'];

const BY_NAME = new Map(CREDENTIALS.map((entry) => [entry.name as string, entry]));

export function isCredentialName(value: string): value is CredentialName {
  return BY_NAME.has(value);
}

/** What a screen may know about a credential. Never its value. */
export type CredentialState = {
  name: CredentialName;
  label: string;
  group: string;
  unlocks: string;
  /** Whether this store holds one. `false` does not mean the platform has none — see `fromEnvironment`. */
  stored: boolean;
  /** Set where the environment supplies one, so "configured" is answerable without reading either. */
  fromEnvironment: boolean;
  /**
   * Whether the environment's copy has been taken out of service.
   *
   * `fromEnvironment: true` with this also true is the state that matters on
   * the screen: a superseded secret is still sitting in a file on the host,
   * the platform will not use it, and somebody still has to delete it and
   * revoke it at the vendor.
   */
  environmentRetired: boolean;
  /** Who retired it, when and why, where one has been. */
  retired?: RetiredEnvironment;
  /**
   * What is still outstanding on a retired credential, in the words the screen
   * shows.
   *
   * Two jobs the platform cannot do and cannot see: the line has to come out of
   * `.env` on the host, and the key has to be revoked at the vendor. It used to
   * state both for ever, so an operator who had done them was told to do them
   * again every time they opened the screen — and a message nobody can clear is
   * one everybody stops reading.
   *
   * Empty once both are confirmed. The platform still cannot verify either;
   * what it can do is record who said so and when, which is a better answer for
   * an access review than silence.
   */
  outstanding: Array<'FILE' | 'VENDOR'>;
  /** First eight hex of the SHA-256 of what is stored. Identifies a key; is not one. */
  keyId?: string;
  setAt?: string;
  setBy?: string;
  /** Why it was last set or cleared, as the operator stated it. */
  reason?: string;
};

type StoredCredential = {
  /** base64: 12-byte IV ‖ ciphertext ‖ 16-byte GCM tag. */
  sealed: string;
  keyId: string;
  setAt: string;
  setBy: string;
  reason: string;
};

/**
 * An environment value the operator has taken out of service.
 *
 * Carries no secret — it is a decision about one, and it is kept beside the
 * store because it is read on exactly the same path.
 */
type RetiredEnvironment = {
  retiredAt: string;
  retiredBy: string;
  reason: string;
  /** The line removed from `.env` on the host, as somebody confirmed it. */
  fileRemovedAt?: string;
  fileRemovedBy?: string;
  /** The key revoked at the vendor, as somebody confirmed it. */
  revokedAt?: string;
  revokedBy?: string;
};

/**
 * `retiredEnvironment` is optional and the version stays 1 deliberately.
 *
 * A store written by a build that predates it simply has no such key, and a
 * build that predates it ignores one it does not know. Bumping the version
 * would make the file unreadable to the image a rollback puts back, and
 * `deploy/autodeploy.sh` exists to put an image back.
 */
type StoreFile = {
  version: 1;
  credentials: Record<string, StoredCredential>;
  retiredEnvironment?: Record<string, RetiredEnvironment>;
};

/**
 * Where the file lives.
 *
 * Beside the journal by default rather than at a path of its own, because it
 * belongs to the same volume and the same backup: a deployment whose journal
 * survives a host and whose credentials do not is one that comes back up unable
 * to call anything. With no journal path configured — an in-memory deployment —
 * there is nowhere durable to put it, and the store holds nothing rather than
 * writing a key into a directory nobody is backing up.
 */
let pathOverride: string | undefined;

/**
 * Test seam, and the only one.
 *
 * `config` is built from the environment once at import, so a test cannot set
 * `CREDENTIAL_STORE_PATH` and have it read — and a test that wrote to the
 * deployment's real path would be a test that rewrites a production key. This
 * is explicit rather than clever for that reason, and nothing in the platform
 * calls it.
 */
export function useCredentialStore(path: string | undefined): void {
  pathOverride = path;
  cache = undefined;
}

function storePath(): string | undefined {
  if (pathOverride !== undefined) return pathOverride;
  if (config.credentials.path !== '') return config.credentials.path;
  if (config.ledger.journalPath === '') return undefined;
  return join(dirname(config.ledger.journalPath), 'credentials.enc');
}

/** The identifier for a secret that is not the secret. */
export function keyIdOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function encryptionKey(): Buffer {
  // Derived, never the raw secret: a key recovered from this file proves
  // nothing about a session token or an export tag, which is the whole reason
  // `secrets.ts` derives per purpose rather than signing with the secret.
  return Buffer.from(hkdfSync('sha256', Buffer.from(config.auth.jwtSecret, 'utf8'), Buffer.alloc(0), Buffer.from(KEY_LABEL, 'utf8'), 32));
}

function seal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
}

function unseal(sealed: string): string | undefined {
  try {
    const raw = Buffer.from(sealed, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const body = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    // The secret was rotated, or the file was tampered with. Either way this
    // value is unreadable and the platform must behave as though it is unset —
    // falling back to the environment — rather than throwing on a call that had
    // nothing to do with credentials.
    return undefined;
  }
}

function load(): StoreFile {
  if (cache) return cache;
  const path = storePath();
  if (!path || !existsSync(path)) {
    cache = { version: 1, credentials: {} };
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
    cache = parsed.version === 1 && parsed.credentials ? parsed : { version: 1, credentials: {} };
  } catch {
    // A corrupt store is not a reason to refuse to boot. It reads as empty, the
    // environment answers, and the operator sees every credential as unset —
    // which is the visible symptom that sends somebody to look.
    cache = { version: 1, credentials: {} };
  }
  return cache;
}

function persist(next: StoreFile): void {
  const path = storePath();
  if (!path) {
    throw new DomainError(
      'CREDENTIAL_STORE_UNAVAILABLE',
      'This deployment has no durable path to keep credentials on: LEDGER_JOURNAL_PATH is unset and so is ' +
        'CREDENTIAL_STORE_PATH. A key written to a directory nobody is backing up is one that disappears with the ' +
        'container, so it is refused rather than accepted and lost.',
      409,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  // Written through a temporary file and renamed, so a crash mid-write leaves
  // the previous store rather than half of this one. A truncated credential
  // file reads as empty, which would silently take every key away.
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
  cache = next;
}

/**
 * The value, for the platform's own call sites.
 *
 * Never reached from a route. Returns `undefined` where nothing is stored or
 * where what is stored cannot be decrypted, and every caller falls back to the
 * environment.
 */
export function credential(name: CredentialName): string | undefined {
  const held = load().credentials[name];
  if (!held) return undefined;
  const value = unseal(held.sealed);
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The value the platform should actually use, from the one place that knows
 * the rule.
 *
 * The rule was written out at five call sites as `credential(X) ?? config.Y` —
 * five copies of "the store beats the environment", which is fine until the
 * rule gains a third clause, and it just has. Everything that needs a secret
 * asks here.
 *
 * Never reached from a route.
 */
export function secretFor(name: CredentialName): string {
  const stored = credential(name);
  if (stored !== undefined) return stored;
  // Retired: the operator has said the copy in the environment is superseded
  // and must not be used again. Without this, clearing the store — or a
  // deployment that lost it — silently falls back to a key somebody has already
  // revoked at the vendor, and the symptom is a 401 nobody can explain.
  if (environmentRetired(name)) return '';
  return environmentValue(name);
}

/** Whether the operator has taken the environment's copy of this out of service. */
export function environmentRetired(name: CredentialName): boolean {
  return load().retiredEnvironment?.[name] !== undefined;
}

/**
 * Stop reading the environment for this credential.
 *
 * ## Why this is a command and not a note in a runbook
 *
 * An operator sets a key from the console because the old one was revoked.
 * The superseded value is still sitting in `.env` on the host, and nothing in
 * the platform can delete it — that file is the deployment's configuration, not
 * the application's data, and an application that edits its own configuration
 * is one nobody can reason about after an incident.
 *
 * What the platform *can* do is refuse to use it, for good. After this, the
 * stale string in the file is inert: clearing the store leaves the capability
 * off and says so, rather than quietly falling back to a dead key and producing
 * a 401 on a tender deadline.
 *
 * The two things this does not do are stated on the screen beside it, because
 * neither is the platform's to do: the bytes still have to come out of the file,
 * and the key still has to be revoked at the vendor.
 */
export function retireEnvironment(name: CredentialName, by: string, reason: string): CredentialState {
  const current = load();
  persist({
    ...current,
    version: 1,
    retiredEnvironment: {
      ...(current.retiredEnvironment ?? {}),
      [name]: { retiredAt: new Date().toISOString(), retiredBy: by, reason },
    },
  });
  return stateOf(name);
}

/**
 * Record that the superseded key is actually gone.
 *
 * The platform cannot see either fact — the file is the deployment's
 * configuration and the vendor's console is somebody else's — so this is an
 * attestation rather than a check, and it says so. What it buys is that the
 * screen stops telling an operator to do something they have already done,
 * which is the difference between a warning and wallpaper.
 */
export function confirmEnvironmentGone(
  name: CredentialName,
  by: string,
  what: { fileRemoved?: boolean; revokedAtVendor?: boolean },
): CredentialState {
  const current = load();
  const held = current.retiredEnvironment?.[name];
  if (!held) {
    throw new DomainError(
      'ENVIRONMENT_NOT_RETIRED',
      `${name} has not been retired from the environment, so there is nothing outstanding to confirm. Retire it ` +
        'first — that is the part the platform can actually enforce.',
      409,
    );
  }
  const now = new Date().toISOString();
  persist({
    ...current,
    version: 1,
    retiredEnvironment: {
      ...current.retiredEnvironment,
      [name]: {
        ...held,
        ...(what.fileRemoved ? { fileRemovedAt: now, fileRemovedBy: by } : {}),
        ...(what.revokedAtVendor ? { revokedAt: now, revokedBy: by } : {}),
      },
    },
  });
  return stateOf(name);
}

/**
 * Read the environment for this credential again.
 *
 * The way back, for the operator who retired the wrong one — a decision with no
 * way out sends people to edit a file under pressure, which is the thing this
 * whole store exists to stop.
 */
export function restoreEnvironment(name: CredentialName): CredentialState {
  const current = load();
  const { [name]: _removed, ...rest } = current.retiredEnvironment ?? {};
  persist({ ...current, version: 1, retiredEnvironment: rest });
  return stateOf(name);
}

/** Store a credential. The value is encrypted here and leaves no other copy. */
export function setCredential(name: CredentialName, value: string, by: string, reason: string): CredentialState {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new DomainError('CREDENTIAL_EMPTY', 'An empty credential is a credential cleared; say so with the clear command.', 400);
  }
  const current = load();
  const entry: StoredCredential = {
    sealed: seal(trimmed),
    keyId: keyIdOf(trimmed),
    setAt: new Date().toISOString(),
    setBy: by,
    reason,
  };
  persist({ ...current, version: 1, credentials: { ...current.credentials, [name]: entry } });
  return stateOf(name);
}

/**
 * Take a credential out of the store.
 *
 * Not the same as setting an empty one: this removes the override, so the
 * platform falls back to whatever the environment holds. Where the environment
 * holds nothing either, the capability that credential unlocks stops — which is
 * the point of being able to clear one.
 */
export function clearCredential(name: CredentialName): CredentialState {
  const current = load();
  const { [name]: _removed, ...rest } = current.credentials;
  persist({ ...current, version: 1, credentials: rest });
  return stateOf(name);
}

/** What the environment holds for a credential, so "configured" is answerable. */
function environmentValue(name: CredentialName): string {
  switch (name) {
    case 'OPENAI_API_KEY':
      return config.ai.openaiKey;
    case 'GEMINI_API_KEY':
      return config.ai.geminiKey;
    case 'ANTHROPIC_API_KEY':
      return config.ai.anthropicKey;
    case 'STRIPE_SECRET_KEY':
      return config.stripe.secretKey;
    case 'STRIPE_WEBHOOK_SECRET':
      return config.stripe.webhookSecret;
    default:
      return '';
  }
}

export function stateOf(name: CredentialName): CredentialState {
  const definition = BY_NAME.get(name)!;
  const held = load().credentials[name];
  const held2 = load().retiredEnvironment?.[name];
  return {
    name,
    label: definition.label,
    group: definition.group,
    unlocks: definition.unlocks,
    stored: held !== undefined,
    fromEnvironment: environmentValue(name) !== '',
    environmentRetired: environmentRetired(name),
    ...(held2 ? { retired: held2 } : {}),
    outstanding: held2
      ? [...(held2.fileRemovedAt ? [] : ['FILE' as const]), ...(held2.revokedAt ? [] : ['VENDOR' as const])]
      : [],
    ...(held ? { keyId: held.keyId, setAt: held.setAt, setBy: held.setBy, reason: held.reason } : {}),
  };
}

/** Every credential and its state, for the operator's screen. No values. */
export function credentialStates(): CredentialState[] {
  return CREDENTIALS.map((entry) => stateOf(entry.name));
}

/** Test seam: forget what was loaded, so a test can write a store and read it back. */
export function resetCredentialCache(): void {
  cache = undefined;
}
