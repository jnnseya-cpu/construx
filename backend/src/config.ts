import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DataSensitivity } from './identity/abac.ts';

/**
 * Configuration is entirely environment-driven — the gateway holds no state and
 * no baked-in secrets. `.env` is loaded if present; real environments inject
 * variables directly.
 */

function loadDotEnv(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // No .env file — environment variables and defaults carry the configuration.
  }
}

loadDotEnv();

/**
 * Every variable this process actually reads, recorded as it reads it.
 *
 * Hand-maintaining a second list of variable names beside the config object is
 * a list that goes stale the first time somebody adds a setting — and it goes
 * stale silently, in the direction that matters: the new variable is the one
 * nobody can see whether they set. So the readers register themselves, and the
 * registry is complete by construction.
 *
 * It holds names and types. It never holds a value.
 */
const registry = new Map<string, { key: string; kind: 'string' | 'number' | 'boolean'; secret: boolean }>();

/**
 * Whether a variable's *value* may be shown.
 *
 * Decided from the name, deliberately, rather than from a list somebody has to
 * remember to add to. A new `..._SECRET` or `..._API_KEY` is covered the moment
 * it exists; the failure mode of a name-based rule is treating a harmless
 * variable as secret, which costs nothing.
 */
function isSecretName(key: string): boolean {
  // A URL is only a secret when it is a connection string, which carries
  // credentials inside it. A checkout return address does not, and hiding one
  // costs something real: a wrong payment return URL is exactly the kind of
  // mistake this report exists to make visible.
  if (/_URL$/.test(key)) return /(REDIS|DATABASE|POSTGRES|MONGO|DSN|WEBHOOK)/.test(key);
  return /(SECRET|_KEY$|_KEY_|^KEY_|PASS|TOKEN|CREDENTIAL|PEM|_DSN)/.test(key);
}

function register(key: string, kind: 'string' | 'number' | 'boolean'): void {
  if (!registry.has(key)) registry.set(key, { key, kind, secret: isSecretName(key) });
}

/**
 * What the running process sees for every variable it reads.
 *
 * Presence and length, and the value only where the name says it is not a
 * secret. Length is here because it is what catches the mistake this exists
 * for: a key truncated by a paste that swallowed the end of the line looks
 * exactly like a correct one from every other angle, and its length does not.
 */
export function environmentReport(): Array<{
  key: string;
  kind: 'string' | 'number' | 'boolean';
  secret: boolean;
  present: boolean;
  /** Characters received. Absent where the variable is not set. */
  length?: number;
  /** The value, only for a variable whose name says it is not a secret. */
  value?: string;
}> {
  return [...registry.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((entry) => {
      const raw = process.env[entry.key];
      const present = raw !== undefined && raw !== '';
      return {
        ...entry,
        present,
        ...(present ? { length: raw.length } : {}),
        ...(present && !entry.secret ? { value: raw } : {}),
      };
    });
}

function bool(key: string, fallback: boolean): boolean {
  register(key, 'boolean');
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function num(key: string, fallback: number): number {
  register(key, 'number');
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(key: string, fallback: string): string {
  register(key, 'string');
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

const SENSITIVITY: DataSensitivity[] = ['PUBLIC', 'INTERNAL', 'SAFETY_L2', 'COMMERCIAL_L3', 'LEGAL_L4'];

/**
 * One level, or the safe answer.
 *
 * A mistyped level must never clear a vendor for more than the operator meant,
 * so anything unrecognised falls to `INTERNAL` rather than to the value that
 * was almost spelled.
 */
function clearanceLevel(raw: string): DataSensitivity {
  const value = raw.trim().toUpperCase() as DataSensitivity;
  return SENSITIVITY.includes(value) ? value : 'INTERNAL';
}

/**
 * `OPENAI:INTERNAL,ANTHROPIC:LEGAL_L4` into a map.
 *
 * A malformed entry is dropped rather than defaulted upward: somebody who
 * mistypes a level must not accidentally clear a vendor for privileged
 * material. The entry simply does not apply and the vendor falls back to the
 * default clearance, which is the lower answer.
 */
function parseClearance(raw: string): Record<string, DataSensitivity> {
  const out: Record<string, DataSensitivity> = {};
  for (const entry of raw.split(',')) {
    const [provider, level] = entry.split(':').map((part) => part.trim().toUpperCase());
    if (!provider || !level) continue;
    if (!SENSITIVITY.includes(level as DataSensitivity)) continue;
    out[provider] = level as DataSensitivity;
  }
  return out;
}

export type AIMode = 'local' | 'staging' | 'production';

export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 8080),

  /**
   * The commit this process is running.
   *
   * Set by the deployer, which is the only thing that knows it. Reported on
   * `/readyz` so the question "is the live site running the latest?" has an
   * answer somebody can read, rather than being inferred from whether a page
   * looks different.
   *
   * That gap is not hypothetical: `docs/STATE.md` records a day on which every
   * commit passed CI and none of it was running, because the deployer itself
   * had never been deployed. Nothing detected it — CI answers "does this
   * build" and, until this field, nothing answered "is this running".
   *
   * Unknown is reported as unknown. A default of "main" or a build timestamp
   * would answer the question wrongly rather than admit it cannot.
   */
  buildCommit: str('BUILD_COMMIT', ''),

  /**
   * Durability. An empty path means the ledger is in-process only, which is
   * correct for a test run and is total data loss on restart anywhere else —
   * so `assertProductionSafety` refuses to stay quiet about it.
   */
  ledger: {
    journalPath: str('LEDGER_JOURNAL_PATH', ''),
    /**
     * Flush to the platter on every event. Switchable only so a suite writing
     * thousands of events is not paying for a power-cut guarantee it does not
     * need. Never turn this off in a deployment.
     */
    fsync: bool('LEDGER_JOURNAL_FSYNC', true),
  },

  /**
   * The object store for field evidence.
   *
   * Unset means the platform records that a document with a given hash was the
   * evidence and does not hold the document — which is a real chain only while
   * somebody else still has the file. `assertProductionSafety` says so out loud
   * rather than letting a deployment discover it during a dispute.
   */
  evidence: {
    storePath: str('EVIDENCE_STORE_PATH', ''),
    /**
     * Per-object ceiling. A site photograph is a few megabytes; a scanned
     * drawing set is tens. The limit exists so one upload cannot fill the
     * volume the ledger journal is also writing to.
     */
    maxBytes: num('EVIDENCE_MAX_BYTES', 50 * 1_048_576),
    /** How long a signed link stays good. Short: it is a link to open now. */
    linkTtlSeconds: num('EVIDENCE_LINK_TTL_SECONDS', 300),
  },

  /**
   * The Ed25519 key the platform witnesses signatures with, as a PKCS8 PEM.
   *
   * Unset means signing is refused. Generating one at boot would be worse than
   * refusing: every signature the platform had ever made would fail
   * verification after the next restart, and it would fail silently.
   *
   *   openssl genpkey -algorithm ed25519 -out signing.pem
   *
   * Newlines in an environment variable are awkward, so `\n` is accepted and
   * expanded — the alternative is operators pasting a one-line PEM that no
   * parser accepts and reading it as a code fault.
   */
  signing: {
    privateKeyPem: str('SIGNING_PRIVATE_KEY_PEM', '').replace(/\\n/g, '\n'),
  },

  /**
   * Who account mail comes from.
   *
   * Separate from the newsletter sender on purpose. A login code and a
   * marketing issue are different kinds of message with different obligations:
   * one is mandatory and carries no unsubscribe, the other is consented to and
   * must. Sending both as `no-reply@` means a person cannot reply to the one
   * message they most often want to reply to, and sending both as the main
   * inbox puts marketing in the mailbox staff read.
   *
   * Falls back to the newsletter sender when unset, so a deployment that has
   * only ever configured one address keeps working.
   *
   * The relay usually requires this to match the mailbox `SMTP_USER`
   * authenticates as. Hostinger does; most do.
   */
  notifications: {
    fromName: str('NOTIFICATIONS_FROM_NAME', str('NEWSLETTER_FROM_NAME', 'CONSTRUX')),
    fromAddress: str('NOTIFICATIONS_FROM_ADDRESS', str('NEWSLETTER_FROM_ADDRESS', 'contact@construxvg.com')),
  },

  /**
   * The platform operator, ensured at boot.
   *
   * Without this a production deployment cannot be administered at all.
   * `createOperator` is reachable only from the demonstration seed, and the
   * demonstration seed is switched off in production — correctly, since it
   * hands a working session to anonymous callers. So every admin route required
   * an operator, and nothing could create the first one. The platform came up,
   * served the public site, and could never be signed into.
   *
   * Declared here rather than exposed as a route because a public endpoint that
   * mints a `PLATFORM_ADMIN` is the worst possible thing to put on the
   * internet, whatever guard is in front of it. Setting a variable requires the
   * server itself, which is the authority the act deserves.
   *
   * Keyed on the address, not on a count: boot ensures *this address* holds an
   * operator, and does nothing if it already does. Guarding on "no operators at
   * all" instead would mean changing this value silently did nothing, and a
   * deployment that had picked the wrong address once could never correct it
   * without being able to sign in — which is the situation the setting exists
   * to prevent.
   *
   * Adding colleagues is `POST /v1/operators`, once somebody can sign in.
   */
  platform: {
    operatorEmail: str('PLATFORM_OPERATOR_EMAIL', ''),
    operatorName: str('PLATFORM_OPERATOR_NAME', 'Platform operator'),
  },

  /**
   * The demonstration tenancy.
   *
   * A production deployment shows a prospective customer nothing: the seed is
   * off, so the platform serves a sign-in page onto an empty world. Turning
   * this on seeds the same Meridian lifecycle production runs in development —
   * one real project carried from concept to operations — as a genuine tenancy
   * with genuine identities that sign in through the ordinary login and MFA
   * path.
   *
   * **What it is not.** It is not an authentication bypass.
   * `POST /v1/console/session`, which hands an anonymous caller an access token
   * with no challenge at all, stays refused in production whatever this is set
   * to. What this enables is narrower and deliberate: an identity created by
   * the demonstration seed, and only such an identity, has its one-time code
   * returned in the login response instead of emailed — because the address it
   * would be emailed to is `@meridian.example` and belongs to nobody. The
   * challenge, its five-minute expiry, its single use and the verification step
   * are all the real ones. No account outside the demonstration tenancy is
   * affected, and an operator account is refused the shortcut even if something
   * ever flagged one.
   *
   * **What it costs.** The demonstration tenancy holds a real ACU wallet, and
   * in a deployment with live AI providers a visitor can spend it. That is the
   * point — a demonstration where the AI refuses is not a demonstration — but
   * it is real money, so the opening credit is set here rather than fixed in
   * the seed. When it runs out the platform refuses to call a provider, which
   * is existing, tested behaviour and reads correctly on screen.
   *
   * Off unless deliberately switched on. A deployment carrying real customers
   * should think before adding a tenancy anyone may write to.
   */
  demo: {
    enabled: bool('DEMO_TENANCY_ENABLED', false),
    /**
     * Opening credit for the demonstration wallet, in minor units.
     *
     * The seed itself consumes some of this producing the lifecycle it shows,
     * so a very low value leaves the demonstration seeded but unable to run AI.
     * That is a legitimate choice and it fails cleanly; it is not a fault.
     */
    acuCreditMinor: num('DEMO_ACU_CREDIT_MINOR', 500_000),
  },

  auth: {
    required: bool('GATEWAY_REQUIRE_AUTH', true),
    exposeMfa: bool('GATEWAY_AUTH_EXPOSE_MFA', true),
    accessTtlMinutes: num('GATEWAY_AUTH_ACCESS_TTL_MINUTES', 15),
    refreshTtlDays: num('GATEWAY_AUTH_REFRESH_TTL_DAYS', 7),
    jwtSecret: str('GATEWAY_JWT_SECRET', 'construx-development-secret'),
  },

  authz: {
    rbac: bool('GATEWAY_RBAC_ENABLED', true),
    abac: bool('GATEWAY_ABAC_ENABLED', true),
    scopes: bool('GATEWAY_SCOPES_ENABLED', true),
  },

  rateLimit: {
    max: num('GATEWAY_RATE_LIMIT_MAX', 1000),
    burst: num('GATEWAY_RATE_LIMIT_BURST', 200),
    windowSeconds: num('GATEWAY_RATE_LIMIT_WINDOW_SECONDS', 60),
    /**
     * Where the buckets live when there is more than one replica.
     *
     * Empty means in-process, which is correct for one process and silently
     * wrong for four: four replicas are four separate buckets, so the limit
     * configured above is multiplied by the replica count and the login route
     * hands out that much more budget to a brute-force attempt. Set this the
     * moment the deployment scales past one instance —
     * `assertProductionSafety` cannot detect the replica count, so it warns
     * about the absence rather than the mistake.
     */
    redisUrl: str('GATEWAY_RATE_LIMIT_REDIS_URL', ''),
  },

  validation: {
    required: bool('GATEWAY_REQUIRE_VALIDATION', true),
  },

  ai: {
    mode: str('AI_MODE', 'local') as AIMode,
    reasoningProvider: str('AI_REASONING_PROVIDER', 'OPENAI'),
    perceptionProvider: str('AI_PERCEPTION_PROVIDER', 'GEMINI'),
    openaiKey: str('OPENAI_API_KEY', ''),
    geminiKey: str('GEMINI_API_KEY', ''),
    anthropicKey: str('ANTHROPIC_API_KEY', ''),
    /**
     * The largest file that may be sent to a provider in one perception
     * request. Smaller than the evidence store's own ceiling on purpose: the
     * store holds a 50MB scanned drawing set quite happily, and no provider
     * accepts one inline. A file over this is refused with that reason rather
     * than sent and rejected by the vendor.
     */
    perceptionMaxBytes: num('AI_PERCEPTION_MAX_BYTES', 20 * 1_048_576),
    /**
     * The most sensitive material each vendor may be sent, as
     * `OPENAI:INTERNAL,ANTHROPIC:LEGAL_L4,GEMINI:PUBLIC`.
     *
     * `DataSensitivity` already decided who inside a customer may *read* a
     * record. It did not decide who the platform may *hand it to* — so a
     * legally privileged clause a safety manager is barred from opening could
     * be posted verbatim to any configured vendor by an engine that happened to
     * include it in its inputs.
     *
     * Whether a vendor may hold commercial-in-confidence or privileged material
     * is a fact about the contract signed with them: a data processing
     * agreement, a retention promise, a processing region. The platform cannot
     * know it, so it must be told.
     */
    providerClearance: parseClearance(str('AI_PROVIDER_CLEARANCE', '')),
    /**
     * What a vendor is cleared for when nothing has been said about it.
     *
     * `INTERNAL` is a deliberate middle. Clearing everything by default would
     * leave the hole where it was and call it closed; clearing nothing would
     * refuse every AI call on every existing deployment the day this shipped.
     * This keeps ordinary project work running and stops the three categories
     * that matter — safety, commercial, legal — until somebody states, per
     * vendor, that the contract permits it.
     */
    defaultClearance: clearanceLevel(str('AI_DEFAULT_CLEARANCE', 'INTERNAL')),
  },

  /**
   * Stripe. Both values are required together: a secret key with no webhook
   * secret can take a payment and has no way to be told about it, and a webhook
   * secret with no key is a listener for something nothing produces. Absent
   * means checkout is refused rather than half-wired.
   */
  stripe: {
    secretKey: str('STRIPE_SECRET_KEY', ''),
    /**
     * The signing secret for the webhook endpoint, from the Stripe dashboard.
     *
     * This is the only thing standing between a public URL and the wallet. With
     * it unset the webhook route refuses every request, which is the correct
     * failure: an unverified webhook that credits money is worse than no
     * webhook at all.
     */
    webhookSecret: str('STRIPE_WEBHOOK_SECRET', ''),
    /** Pinned, so a version rolled out on Stripe's side cannot reshape what we parse. */
    apiVersion: str('STRIPE_API_VERSION', '2024-06-20'),
    /** Where the customer lands after paying, and after giving up. */
    successUrl: str('STRIPE_SUCCESS_URL', ''),
    cancelUrl: str('STRIPE_CANCEL_URL', ''),
  },

  /**
   * KODA — mobile money, as a second payment rail beside the card.
   *
   * Same shape as Stripe on purpose: a secret key for the outbound call, a
   * webhook secret that is the only credential on the inbound one, and nothing
   * working until both are present.
   */
  koda: {
    secretKey: str('KODA_SECRET_KEY', ''),
    /**
     * Signs `x-koda-signature` — HMAC-SHA256 of the raw body, hex. Unset means
     * the webhook refuses everything, which is the only safe unconfigured
     * state for an endpoint that credits wallets.
     */
    webhookSecret: str('KODA_WEBHOOK_SECRET', ''),
    baseUrl: str('KODA_BASE_URL', 'https://kodajnn.com/v1'),
    /** Mobile-money operators offered at checkout, in KODA's own codes. */
    operators: str('KODA_OPERATORS', 'orange_cd,mpesa_cd')
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code !== ''),
    successUrl: str('KODA_SUCCESS_URL', ''),
    /**
     * US dollars per pound, for pricing a KODA top-up.
     *
     * The platform denominates in GBP — that is what closed the minor-unit
     * arbitrage — and KODA settles in USD, so one number has to bridge them.
     * It is a operator-set constant rather than a live feed: a rate fetched at
     * settlement makes the credited amount impossible to reproduce from the
     * ledger a year later, and adds a runtime dependency on a third party to
     * the one path where failing means taking money and crediting nothing.
     *
     * The rate in force is copied onto the intent when it is created and onto
     * the receipt when it settles, so every credit can be recomputed from its
     * own record, and changing this affects new top-ups rather than in-flight
     * ones. Review it when the market moves; the drift between reviews is the
     * cost of not having a feed, and it is bounded and visible.
     */
    usdPerGbp: num('KODA_USD_PER_GBP', 1.27),
  },

  billing: {
    /**
     * Hard economic rule: 1 unit of provider cost is charged at 4.
     *
     * The company keeps £3 of every £4 it takes — 300% profit on what it paid
     * the provider, against a required minimum of 100%.
     */
    markupMultiplier: num('ACU_MARKUP_MULTIPLIER', 4),
    /**
     * The company's required profit on every AI transaction, as a percentage
     * of what the provider charged.
     *
     * 100 means the platform keeps at least as much as it paid out — it never
     * takes less than double what a call cost it. This is a floor and a
     * business rule, not the price: the price is `markupMultiplier`, and at 4x
     * the realised profit is 300% of cost, comfortably above the requirement.
     *
     * Expressed as a profit requirement rather than as a bare multiplier so
     * the rule reads as the rule. A number called `minimumMultiplier` invites
     * somebody to tune it without asking what profit it leaves.
     */
    minimumProfitPercent: num('ACU_MINIMUM_PROFIT_PERCENT', 100),
    /**
     * One ACU is one minor unit, so £1 buys 100 ACUs and $1 buys 100. Stated
     * as its own value rather than assumed, because a currency with a
     * different exponent — a yen has no minor unit, a dinar has three — would
     * otherwise silently change what an ACU is worth.
     */
    acuUnitMinor: num('ACU_UNIT_MINOR', 1),
    acuPerMajorUnit: num('ACU_PER_MAJOR_UNIT', 100),
    /**
     * The share of every subscription payment credited to the tenant's AI
     * wallet. The rest carries no provider cost against it.
     */
    subscriptionAcuAllocationPercent: num('ACU_SUBSCRIPTION_ALLOCATION_PERCENT', 20),
    freeTrialGrantMinor: num('FREE_TRIAL_GRANT_MINOR', 500),
    /**
     * What one 100 GB block of extra storage costs per month.
     *
     * Recurring, not one-off, and that is the whole design. The record is
     * append-only, so storage a tenant buys is storage the platform holds for
     * as long as the contract can be sued on — selling that for a single
     * payment prices a permanent obligation as a transaction, and the liability
     * compounds with every block sold.
     *
     * Here rather than in the pricing table for the same reason every other
     * commercial number is: a rate is configuration, not a constant somebody
     * has to redeploy to change.
     *
     * **The default assumes object storage, and is wrong without it.** A block
     * is 100 GB held twice — the live copy and the off-machine backup the
     * runbook requires — so the underlying cost is 200 GB-months. At
     * object-storage rates that is about £0.95 (Backblaze B2) to £3.63 (S3),
     * making £15 a 4x to 16x markup. On a VPS block volume the same 200 GB
     * costs about £8.80 and £15 is a 1.7x markup at 41% gross, which is thin
     * for a permanent obligation.
     *
     * So this figure is a bet on where evidence lives. Moving the store to a
     * VPS volume without revisiting it converts the margin quietly rather than
     * loudly, which is the failure mode worth naming here.
     *
     * Egress does not appear in the price and should not need to: B2 and R2
     * charge nothing for it. On S3 a single customer pulling a 4 TB archive
     * costs about £284 in egress alone, seven times what holding it costs for a
     * month — which is the argument against S3 rather than an argument for a
     * higher price.
     */
    storageBlockPriceMinor: num('STORAGE_BLOCK_PRICE_MINOR', 1_500),
    /**
     * The largest single payment the platform will credit, in minor units.
     *
     * £100,000 by default. Not a limit on what a customer may spend — a larger
     * settlement is recorded as several receipts, each with its own reference,
     * which is also the form an auditor would rather see. It is a guard against
     * the two ways an amount goes wrong: a typo with an extra three zeros, and
     * a malformed webhook. Both put a number into an append-only ledger that
     * nobody can quietly take back out.
     */
    maximumCreditMinor: num('MAXIMUM_CREDIT_MINOR', 10_000_000),
    /**
     * How many free trials one organisation may take.
     *
     * Every tenancy is granted trial credit at creation, and signup creates a
     * tenancy per verified address — so with no counter, a company took a fresh
     * grant for every address it could verify, and one person took one for
     * every plus-suffix they could think of. Every pound of it buys real
     * provider compute.
     *
     * One, because a trial is an offer to an organisation rather than to a
     * mailbox. Raise it deliberately for a campaign; do not raise it because a
     * prospect asked.
     */
    trialsPerOrganisation: num('TRIALS_PER_ORGANISATION', 1),
  },

  privacy: {
    /**
     * Days between an erasure request and the erasure itself.
     *
     * The delay is a safety feature. Erasure is irreversible, and without a
     * window whoever holds a stolen session can destroy an identity that a
     * competent person's approvals are recorded against. It is also the window
     * in which the mandatory notice reaches the real mailbox, which is what
     * lets the true owner stop it.
     */
    erasureGraceDays: num('ERASURE_GRACE_DAYS', 30),
  },

  /** Absolute origin used in email links. Email cannot resolve a relative path. */
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 8080)}`),

  /**
   * Marketing measurement on the public site.
   *
   * Both are empty by default and everything downstream is inert while they
   * are: no third-party script is emitted, no consent banner appears, and the
   * content-security-policy stays as tight as it was. A deployment that does
   * not advertise should not be paying for a policy that permits advertising
   * scripts, and a development machine should never be sending page views to
   * somebody's ad account.
   *
   * **Scope is the public site and the signup funnel, and stops there.** The
   * signed-in console is deliberately outside it: its paths carry tenant,
   * project and entity identifiers, so a page view sent from `/app` hands a
   * customer's commercial position — which projects, how many, moving how fast
   * — to two advertising networks. There is also nothing to measure there. The
   * conversion happened at the door.
   */
  analytics: {
    /** Meta (Facebook) pixel id. Digits. */
    metaPixelId: str('ANALYTICS_META_PIXEL_ID', ''),
    /** Google tag id — `G-XXXXXXX` for GA4, `GT-XXXXXXX` for a Google tag. */
    googleTagId: str('ANALYTICS_GOOGLE_TAG_ID', ''),
  },

  newsletter: {
    /**
     * Off unless switched on. A marketing sender that arms itself at boot would
     * send from a laptop, a CI run and a restored backup — the switch has to be
     * a deliberate act in one environment, not a default everywhere.
     */
    enabled: bool('NEWSLETTER_ENABLED', false),
    /** UTC day-of-week and hour the weekly issue goes out. 1 = Monday. */
    sendDayUtc: num('NEWSLETTER_SEND_DAY_UTC', 2),
    sendHourUtc: num('NEWSLETTER_SEND_HOUR_UTC', 9),
    fromName: str('NEWSLETTER_FROM_NAME', 'CONSTRUX'),
    fromAddress: str('NEWSLETTER_FROM_ADDRESS', 'no-reply@construxvg.com'),
    replyTo: str('NEWSLETTER_REPLY_TO', ''),
    /**
     * Whether a registered user is in the audience before they have expressed a
     * preference. True treats product mail to an existing business customer as
     * the soft opt-in it is; false requires an explicit yes first. Either way a
     * withdrawal is permanent until the person re-subscribes.
     */
    defaultSubscribed: bool('NEWSLETTER_DEFAULT_SUBSCRIBED', true),
    /**
     * Roles never marketed to regardless of consent. A Building Safety
     * Regulator holds an oversight identity, not a customer relationship, and
     * selling to it would be inappropriate rather than merely unwanted.
     */
    excludedRoles: str('NEWSLETTER_EXCLUDED_ROLES', 'REGULATOR')
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
    /** Pause between sends, so a large audience does not arrive as a burst. */
    throttleMs: num('NEWSLETTER_THROTTLE_MS', 120),
  },

  smtp: {
    host: str('SMTP_HOST', ''),
    port: num('SMTP_PORT', 587),
    /** True for implicit TLS on 465. False starts plaintext and issues STARTTLS. */
    secure: bool('SMTP_SECURE', false),
    /** Refuse to continue in cleartext if STARTTLS is unavailable. */
    requireTls: bool('SMTP_REQUIRE_TLS', true),
    user: str('SMTP_USER', ''),
    pass: str('SMTP_PASS', ''),
    timeoutMs: num('SMTP_TIMEOUT_MS', 15_000),
  },
} as const;

/**
 * Whether this process is production, read fresh rather than from the boot
 * snapshot in `config.env`.
 *
 * The two agree in every real deployment: `loadDotEnv()` has already populated
 * `process.env` by the time `config` is built, so a `NODE_ENV` from either the
 * environment or `.env` reaches both. The difference is that this can be
 * exercised by a test, and the branches that depend on it are the ones that
 * decide whether an anonymous caller receives an access token or an MFA code.
 * A security gate nobody can test is a security gate nobody has checked.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

/**
 * Whether the demonstration tenancy is switched on, read fresh.
 *
 * The same argument as `isProduction()`, and for the same reason: this decides
 * whether an anonymous caller may be handed a one-time code, and a security
 * gate nobody can test is a security gate nobody has checked. `config.demo`
 * carries the value too — snapshotted at load, which is correct for the seed's
 * opening credit — but the gate itself has to be reachable from a test that
 * has not booted a second process.
 *
 * It reads the variable by exactly the rule `bool()` uses, not a stricter one
 * of its own. A gate that accepted `true` where the loader also accepts `1`
 * would leave a deployment set to `1` seeding a demonstration at boot that
 * every route then refused to show — working, invisible, and very hard to
 * explain.
 */
export function demonstrationEnabled(): boolean {
  const raw = process.env.DEMO_TENANCY_ENABLED;
  if (raw === undefined || raw === '') return false;
  return raw === 'true' || raw === '1';
}

/**
 * Whether outbound mail claims a domain this deployment does not serve.
 *
 * The from address on every email — the signup confirmation included, despite
 * the `NEWSLETTER_` prefix on the variable — defaults to a domain a given
 * deployment may not own. A provider asked to send as a domain it does not
 * carry either refuses outright or sends mail that fails SPF at the far end,
 * and the visible symptom is never "email is misconfigured": it is nobody being
 * able to finish signing up, which is a far more expensive thing to diagnose.
 *
 * Compared against the public origin because that is the domain the deployment
 * has already declared as its own. A subdomain sender (`mail.example.com`
 * against `example.com`) is accepted: that is a normal transactional setup and
 * the parent domain's SPF is what authorises it.
 */
export function foreignSenderDomain(
  fromAddress: string,
  publicBaseUrl: string,
): { sender: string; origin: string } | null {
  const sender = fromAddress.split('@')[1]?.toLowerCase() ?? '';
  let origin = '';
  try {
    origin = new URL(publicBaseUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    // A malformed PUBLIC_BASE_URL is its own problem and leaves nothing to
    // compare against. Staying quiet is better than blaming the from address.
    return null;
  }
  if (!sender || !origin) return null;
  if (sender === origin || sender.endsWith(`.${origin}`)) return null;
  return { sender, origin };
}

/** Warn loudly rather than fail silently when production is misconfigured. */
export function assertProductionSafety(): string[] {
  const warnings: string[] = [];
  if (config.env === 'production') {
    if (config.auth.jwtSecret === 'construx-development-secret') {
      warnings.push('GATEWAY_JWT_SECRET is still the development default');
    }
    if (config.evidence.storePath === '') {
      warnings.push(
        'EVIDENCE_STORE_PATH is unset — the platform records evidence hashes but holds no files, so a chain is only as good as whoever still has the original',
      );
    }
    if (config.signing.privateKeyPem === '') {
      warnings.push(
        'SIGNING_PRIVATE_KEY_PEM is unset — the platform cannot witness a signature, and every signing request will be refused',
      );
    }
    if (config.ledger.journalPath === '') {
      // The loudest thing this function says, because it is the only one that
      // loses the entire record rather than degrading a feature.
      warnings.push(
        'LEDGER_JOURNAL_PATH is unset — the ledger is in memory only and EVERY RECORD IS LOST ON RESTART',
      );
    }
    if (!config.ledger.fsync) {
      warnings.push('LEDGER_JOURNAL_FSYNC is disabled — events may be acknowledged before reaching the disk');
    }
    if (config.ai.mode !== 'production') {
      warnings.push(`AI_MODE is "${config.ai.mode}" in a production environment`);
    }
    if (!config.auth.required) warnings.push('GATEWAY_REQUIRE_AUTH is disabled in production');
    if (config.platform.operatorEmail === '') {
      warnings.push(
        'PLATFORM_OPERATOR_EMAIL is unset — if this deployment has no operator yet, nobody can sign in and no tenancy can be created',
      );
    }
    // A mistyped provider name silently falls back to the default. Said out
    // loud, because the deployment believes it is calling somebody else — and
    // the ledger will record the vendor that actually served each request.
    for (const [key, value] of [
      ['AI_REASONING_PROVIDER', config.ai.reasoningProvider],
      ['AI_PERCEPTION_PROVIDER', config.ai.perceptionProvider],
    ] as const) {
      if (!['OPENAI', 'GEMINI', 'ANTHROPIC'].includes(value)) {
        warnings.push(`${key} is "${value}", which is not a provider this platform can call — the default is being used instead`);
      }
    }
    // Which vendors may hold which material. Silence here is not neutral: it
    // means every provider is capped at INTERNAL, so any engine touching a
    // contract, a claim or safety material will be refused at the point of use.
    // Better said at boot than discovered by a user mid-command.
    if (Object.keys(config.ai.providerClearance).length === 0 && config.ai.mode === 'production') {
      warnings.push(
        `AI_PROVIDER_CLEARANCE is unset — every provider is capped at ${config.ai.defaultClearance}, so any AI request carrying commercial, safety or legally privileged records will be refused. Set it once the data processing agreement with each vendor is in place.`,
      );
    }
    if (config.rateLimit.redisUrl === '') {
      warnings.push(
        'GATEWAY_RATE_LIMIT_REDIS_URL is unset — rate limits are per-process, so N replicas enforce N times the configured limit',
      );
    }
    // Half-configured Stripe. The webhook secret alone is inert, but a secret
    // key without one is the dangerous half: checkout opens, the customer pays,
    // and there is nothing that can verify the notification saying so.
    if (config.stripe.secretKey !== '' && config.stripe.webhookSecret === '') {
      warnings.push(
        'STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not — card payments would be taken and never credited, so the checkout route stays disabled until both are present',
      );
    }
    if (config.stripe.webhookSecret !== '' && config.stripe.secretKey === '') {
      warnings.push('STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is not — no checkout can be opened');
    }
    // A live key against a test webhook secret, or the reverse. Stripe prefixes
    // its keys, so this one mistake is catchable before a customer finds it.
    if (config.stripe.secretKey.startsWith('sk_test_')) {
      warnings.push('STRIPE_SECRET_KEY is a test key on a production deployment — no real payment can be taken');
    }
    // The same half-configured trap on the mobile-money rail.
    if (config.koda.secretKey !== '' && config.koda.webhookSecret === '') {
      warnings.push(
        'KODA_SECRET_KEY is set but KODA_WEBHOOK_SECRET is not — mobile-money payments would be taken and never credited, so the checkout route stays disabled until both are present',
      );
    }
    if (config.koda.webhookSecret !== '' && config.koda.secretKey === '') {
      warnings.push('KODA_WEBHOOK_SECRET is set but KODA_SECRET_KEY is not — no mobile-money checkout can be opened');
    }
    // The rate every mobile-money credit is divided by. Zero or negative would
    // reach a wallet as an infinite or negative credit, and the conversion
    // refuses it — but at the point of payment, which is far too late to find
    // out. Say so at boot instead.
    if (config.koda.secretKey !== '' && !(config.koda.usdPerGbp > 0)) {
      warnings.push(
        `KODA_USD_PER_GBP is ${config.koda.usdPerGbp} — mobile-money payments will be refused at settlement until it is a positive rate`,
      );
    }
    if (config.newsletter.enabled && !config.smtp.host) {
      warnings.push('NEWSLETTER_ENABLED is on but SMTP_HOST is unset — issues will be recorded, not delivered');
    }
    if (config.newsletter.enabled && config.publicBaseUrl.startsWith('http://')) {
      // Unsubscribe links carry a signed token. Over http they are readable in
      // transit, and a mail client following one leaks it to every hop.
      warnings.push('PUBLIC_BASE_URL is not https — unsubscribe links would be sent over cleartext');
    }
    for (const [key, address] of [
      ['NEWSLETTER_FROM_ADDRESS', config.newsletter.fromAddress],
      ['NOTIFICATIONS_FROM_ADDRESS', config.notifications.fromAddress],
    ] as const) {
      const foreign = foreignSenderDomain(address, config.publicBaseUrl);
      if (foreign) {
        warnings.push(
          `${key} sends as "${foreign.sender}" but this deployment serves "${foreign.origin}" — ` +
            'mail from it will fail SPF unless that domain authorises this sender',
        );
      }
    }
  }
  if (config.smtp.host && config.smtp.pass === '' && config.smtp.user !== '') {
    warnings.push('SMTP_USER is set without SMTP_PASS — authentication will fail');
  }
  return warnings;
}
