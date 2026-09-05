import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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

/** A comma-separated list; blanks dropped, order kept. */
function list(key: string): string[] {
  return str(key, '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item);
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

/**
 * Per-task confidence thresholds, as `title_block_extraction:0.9,clause:0.85`.
 *
 * A value outside 0–1 is dropped rather than clamped. Clamping `1.5` to `1`
 * would silently turn "I typed the wrong thing" into "hold every extraction for
 * review", and the deployment would look broken with nothing to say why.
 */
function parseThresholds(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const entry of raw.split(',')) {
    const [task, value] = entry.split(':').map((part) => part.trim());
    if (!task || !value) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) continue;
    out[task] = parsed;
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
    /**
     * How often the writer refreshes its claim on the journal, and therefore
     * how long a dead writer blocks a replacement — three heartbeats.
     *
     * Ten seconds is chosen against the two failure modes in tension. Longer,
     * and a container killed by an OOM leaves the volume unusable for minutes
     * while its replacement refuses to start. Shorter, and a process paused by
     * a long GC or a slow flush looks dead to a replica that is about to
     * corrupt the chain by taking over from it.
     */
    writerHeartbeatSeconds: num('LEDGER_WRITER_HEARTBEAT_SECONDS', 10),
    /**
     * Whether the ledger is also kept in Postgres, and which copy a boot trusts.
     *
     * `off`: the journal alone, as every deployment has run. `mirror`: every
     * event is shipped to Postgres beside the journal, and a restart still
     * replays the journal — the mode a deployment runs in until the two are
     * seen to agree. `primary`: a boot replays Postgres and ships the journal's
     * unshipped tail; a new host with an empty volume comes up with the record.
     * `follower`: a boot replays Postgres, polls it for what the primary ships
     * afterwards, answers reads and refuses every write — a warm standby that
     * is promoted by restarting it in primary mode once the primary has
     * stopped. Anything else is treated as `off` and said so at boot.
     */
    postgresMode: ((): 'off' | 'mirror' | 'primary' | 'follower' => {
      const value = str('LEDGER_POSTGRES_MODE', 'off').trim().toLowerCase();
      return value === 'mirror' || value === 'primary' || value === 'follower' ? value : 'off';
    })(),
    /** How often a follower asks the database for what the primary has shipped. */
    followIntervalMs: Math.max(250, num('LEDGER_FOLLOW_INTERVAL_MS', 2_000)),
  },

  /**
   * The object store for field evidence.
   *
   * Unset means the platform records that a document with a given hash was the
   * evidence and does not hold the document — which is a real chain only while
   * somebody else still has the file. `assertProductionSafety` says so out loud
   * rather than letting a deployment discover it during a dispute.
   */
  /**
   * A signature scanner, if this deployment has one beside it.
   *
   * The platform holds no signatures and never will — zero runtime dependencies
   * is settled. What it can do is talk to a daemon that does, over clamd's
   * INSTREAM protocol. Unset means nothing scans, and every ingestion record and
   * every read says so rather than implying a check nobody made.
   */
  /**
   * Postgres, for the deployment that has one.
   *
   * Unset means the ledger stays in the append-only journal on a volume, which
   * is what every deployment does today and is a complete, durable answer for a
   * single instance. Setting `POSTGRES_HOST` is what makes the application tier
   * stateless and therefore horizontally scalable — the schema in
   * `deploy/postgres/` and the client in `backend/src/store/` are both verified
   * against a live Postgres 16.
   */
  postgres: {
    host: str('POSTGRES_HOST', ''),
    port: num('POSTGRES_PORT', 5432),
    user: str('POSTGRES_USER', 'construx_app'),
    password: str('POSTGRES_PASSWORD', ''),
    database: str('POSTGRES_DATABASE', 'construx'),
    /**
     * `require` refuses a server that will not start TLS, and is the only
     * defensible setting for a database reached over anything but a loopback.
     */
    tls: str('POSTGRES_TLS', 'require') as 'require' | 'prefer' | 'disable',
    verifyCertificate: bool('POSTGRES_TLS_VERIFY', true),
    /**
     * Where the ledger tables live. Pinned as a startup parameter rather than
     * SET later, so it holds for the first statement and cannot be changed
     * mid-connection by a hostile schema shadowing a function.
     */
    searchPath: str('POSTGRES_SEARCH_PATH', 'goldenthread, public'),
    poolSize: num('POSTGRES_POOL_SIZE', 8),
    connectTimeoutMs: num('POSTGRES_CONNECT_TIMEOUT_MS', 10_000),
    /**
     * A statement that has run this long is not going to finish usefully, and
     * one holding the chain-head row lock blocks every other writer on that
     * project while it does.
     */
    statementTimeoutMs: num('POSTGRES_STATEMENT_TIMEOUT_MS', 30_000),
  },

  /**
   * S3-compatible object storage for evidence, if configured.
   *
   * Unset means the volume at `EVIDENCE_STORE_PATH`, which is correct for one
   * instance and is exactly why the application tier cannot be replicated: two
   * containers on separate volumes each hold half the evidence.
   */
  objectStore: {
    endpoint: str('OBJECT_STORE_ENDPOINT', ''),
    region: str('OBJECT_STORE_REGION', 'us-east-1'),
    bucket: str('OBJECT_STORE_BUCKET', ''),
    accessKeyId: str('OBJECT_STORE_ACCESS_KEY_ID', ''),
    secretAccessKey: str('OBJECT_STORE_SECRET_ACCESS_KEY', ''),
    /** Most self-hosted stores need path style; AWS prefers virtual-hosted. */
    pathStyle: bool('OBJECT_STORE_PATH_STYLE', true),
    timeoutMs: num('OBJECT_STORE_TIMEOUT_MS', 30_000),
  },

  /**
   * Auto-repair, bounded to restart and reroute.
   *
   * Never code, never configuration, never a deploy, and never a chain. What it
   * fixes is a timer that stopped and a queue that is owed and idle — both
   * silent failures whose first symptom is a customer noticing.
   */
  repair: {
    enabled: bool('AUTO_REPAIR_ENABLED', true),
    intervalSeconds: num('AUTO_REPAIR_INTERVAL_SECONDS', 120),
  },

  /**
   * Verifying the chain before somebody has to rely on it.
   *
   * The verification has existed since the ledger did; what did not exist was
   * anything that ran it in the background. Off means a divergence is found
   * during a dispute, by the person least able to do anything about it.
   */
  assurance: {
    enabled: bool('CHAIN_ASSURANCE_ENABLED', true),
    intervalSeconds: num('CHAIN_ASSURANCE_INTERVAL_SECONDS', 900),
    /**
     * A slice per pass, rotating. A full verification of every project on every
     * pass grows without bound and would consume the process on a mature
     * estate; the position reports how many passes a full circuit takes, so
     * "verified continuously" is a measurable claim rather than a reassuring one.
     */
    projectsPerPass: num('CHAIN_ASSURANCE_PROJECTS_PER_PASS', 5),
  },

  /**
   * Where logs and metrics are shipped, if anywhere.
   *
   * Unset means the counters, the latency histogram and the security stream
   * still exist and still answer the admin screens — they simply die with the
   * container, which is what `docs/STATE.md` has said since they were built.
   * Setting an endpoint is what makes post-incident analysis possible without
   * having happened to keep the container.
   */
  otlp: {
    /** Collector base URL. `/v1/metrics` and `/v1/logs` are appended. */
    endpoint: str('OTEL_EXPORTER_OTLP_ENDPOINT', ''),
    /** `key=value,key2=value2`. Where a collector's auth token arrives. */
    headers: str('OTEL_EXPORTER_OTLP_HEADERS', ''),
    serviceName: str('OTEL_SERVICE_NAME', 'construx'),
    intervalSeconds: num('OTEL_EXPORT_INTERVAL_SECONDS', 30),
    /**
     * Bounded on purpose. A collector down for a week must fill this and then
     * drop — counted and visible — rather than grow until the process is killed
     * for memory, taking the platform down to protect its own telemetry.
     */
    queueSize: num('OTEL_QUEUE_SIZE', 2_048),
    batchSize: num('OTEL_BATCH_SIZE', 256),
    timeoutMs: num('OTEL_EXPORT_TIMEOUT_MS', 10_000),
  },

  antivirus: {
    host: str('ANTIVIRUS_CLAMD_HOST', ''),
    port: num('ANTIVIRUS_CLAMD_PORT', 3310),
    /**
     * A scan is in the path of an ingestion somebody is waiting on, and a
     * daemon that has stopped answering must fail rather than hang. Generous
     * enough for a large drawing set on a busy scanner.
     */
    timeoutMs: num('ANTIVIRUS_TIMEOUT_MS', 10_000),
  },

  /**
   * The platform watching its own numbers.
   *
   * Counters have existed since the gateway was built and nothing read them.
   * These are the thresholds a handful of rules judge them against, evaluated
   * on a timer and sent to the operator through the outbox.
   */
  ops: {
    watchEnabled: bool('OPS_WATCH_ENABLED', true),
    watchIntervalSeconds: num('OPS_WATCH_INTERVAL_SECONDS', 60),
    /**
     * How long a condition may keep firing before the operator is told again.
     * Short enough that a real outage is not forgotten, long enough that a
     * two-hour incident does not arrive as 120 emails.
     */
    renotifyMinutes: num('OPS_WATCH_RENOTIFY_MINUTES', 30),
    /**
     * How often the chain-break sweep runs the commercial escalation over every
     * open customer project. Zero disables it, and a break is then raised
     * only when somebody opens the position or calls the route.
     */
    consistencySweepMinutes: num('OPS_CONSISTENCY_SWEEP_MINUTES', 60),
    /**
     * The floor under every rate rule. "100% of requests failed" over one
     * request is the alert that gets the whole system muted within a day.
     */
    minimumSample: num('OPS_WATCH_MINIMUM_SAMPLE', 20),
    serverErrorPercent: num('OPS_WATCH_SERVER_ERROR_PERCENT', 5),
    authFailurePercent: num('OPS_WATCH_AUTH_FAILURE_PERCENT', 20),
    rateLimitedThreshold: num('OPS_WATCH_RATE_LIMITED_THRESHOLD', 50),
  },

  evidence: {
    /**
     * Where files live. Set explicitly, or — when unset and the ledger journal
     * is on a volume — beside the journal, in `evidence/` under the same
     * directory. A deployment that had somewhere durable to keep the record
     * had somewhere durable to keep the files, and every upload on it was
     * refused with "no object store is configured" until somebody found the
     * second setting. Unset with no journal stays unset: an in-memory ledger
     * has no volume to put files on, and pretending otherwise would hold
     * evidence that vanished with the container.
     */
    storePath:
      str('EVIDENCE_STORE_PATH', '') ||
      (str('LEDGER_JOURNAL_PATH', '') !== '' && str('OBJECT_STORE_ENDPOINT', '') === ''
        ? resolve(dirname(str('LEDGER_JOURNAL_PATH', '')), 'evidence')
        : ''),
    /**
     * Per-object ceiling. A site photograph is a few megabytes; a scanned
     * drawing set is tens. The limit exists so one upload cannot fill the
     * volume the ledger journal is also writing to.
     */
    maxBytes: num('EVIDENCE_MAX_BYTES', 50 * 1_048_576),
    /** How long a signed link stays good. Short: it is a link to open now. */
    linkTtlSeconds: num('EVIDENCE_LINK_TTL_SECONDS', 300),

    /**
     * The master key for envelope encryption of evidence at rest. 32 bytes as
     * hex or base64.
     *
     * Empty means evidence is stored as plaintext, which is the honest default:
     * generating a key at boot would produce a deployment whose evidence becomes
     * unreadable on the next restart, and that is a worse failure than an
     * unencrypted volume because it is silent until somebody needs a file.
     *
     * It must not live on the same volume as the evidence. A key kept beside
     * the ciphertext makes the control worth nothing, and `evidence/envelope.ts`
     * says so in the posture rather than reporting "encryption: on".
     */
    masterKey: str('EVIDENCE_MASTER_KEY', ''),
  },

  /**
   * What protects data in flight.
   *
   * This process serves plain HTTP, which is correct behind a load balancer and
   * wrong when exposed directly — and the difference is not visible from inside
   * the process. So these are **declarations** an operator makes, checked
   * against the things that are checkable, and reported by `ops/transport.ts`
   * with the unverifiable parts named as unverifiable.
   */
  transport: {
    /** LOAD_BALANCER, REVERSE_PROXY, SERVICE_MESH, THIS_PROCESS, NOT_DECLARED. */
    termination: str('TLS_TERMINATION', 'NOT_DECLARED'),
    /** 180 days. Zero disables the header, which is only right on localhost. */
    hstsMaxAgeSeconds: num('HSTS_MAX_AGE_SECONDS', 15_552_000),
    hstsIncludeSubDomains: bool('HSTS_INCLUDE_SUBDOMAINS', true),
    /**
     * Off by default and deliberately: preload is a one-way door. Once a domain
     * is on the browser preload list, removing it takes months, and every
     * subdomain must be https from that moment — including ones nobody
     * remembered.
     */
    hstsPreload: bool('HSTS_PRELOAD', false),
    cookiesSecure: bool('COOKIES_SECURE', true),
    /**
     * Whether `x-forwarded-proto` is believed.
     *
     * Off by default. Trusting it from anywhere lets anything that can reach
     * this process assert that its request arrived over https, which turns a
     * header into an authentication bypass wherever that decides a redirect or
     * a cookie attribute.
     */
    trustForwardedProto: bool('TRUST_FORWARDED_PROTO', false),
    /** The ranges the header is believed from. Empty with trust on is a finding. */
    trustedProxyCidrs: str('TRUSTED_PROXY_CIDRS', ''),
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
    /**
     * How many times the outbox will try to deliver a notice before it stops.
     *
     * Five, because the failures worth retrying are transient — a relay
     * refusing a connection, a DNS blip, a restart mid-send — and the ones that
     * are not transient do not become deliverable on the sixth attempt. A queue
     * that retries for ever is a queue that hides a permanently bad address
     * behind a number that never stops going up.
     */
    maxAttempts: num('NOTIFICATIONS_MAX_ATTEMPTS', 5),
    /**
     * How long the outbox waits before retrying, doubling per attempt.
     *
     * The first retry is a minute out, then two, four, eight. A relay that
     * refused because it was overloaded is not helped by being asked again
     * immediately, and a person waiting for a sign-in code is not helped by
     * an hour.
     */
    retryBackoffSeconds: num('NOTIFICATIONS_RETRY_BACKOFF_SECONDS', 60),
    /**
     * How often the outbox drains on its own.
     *
     * The queue is drained inline on every `notify()`, so this timer exists for
     * exactly one case: notices queued by a process that died before delivering
     * them. Every sixty seconds is often enough that nobody notices the
     * difference and rare enough to cost nothing on an empty queue.
     */
    drainIntervalSeconds: num('NOTIFICATIONS_DRAIN_INTERVAL_SECONDS', 60),
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
   * **On by default**, and the cost argument above no longer applies: the seed
   * runs against the deterministic local engines whatever `AI_MODE` says, so
   * building the fixture is free and reproducible. Only what a visitor does
   * afterwards spends anything, and that is bounded by the wallet.
   *
   * The default was `false` while seeding could spend money. It is `true` now
   * because a deployment that shows a prospective customer an empty sign-in
   * page is a deployment that does not work, and requiring somebody to know
   * about a variable before the product demonstrates itself made the common
   * case the broken one. A deployment carrying real customers that would rather
   * not publish a sandbox sets `DEMO_TENANCY_ENABLED=false`.
   */
  demo: {
    enabled: bool('DEMO_TENANCY_ENABLED', true),
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
    /**
     * Whether a platform operator must hold an authenticator app.
     *
     * On by default: the operator can credit wallets, move packages and close
     * tenancies, and an emailed code is one mailbox compromise away from all of
     * it. An operator without one is not refused — they are taken to enrol on
     * their next sign-in and can do nothing else until they have. Tenancies
     * set their own requirement on Team & Access.
     */
    operatorMfaRequired: bool('GATEWAY_AUTH_OPERATOR_MFA_REQUIRED', true),
    accessTtlMinutes: num('GATEWAY_AUTH_ACCESS_TTL_MINUTES', 15),
    refreshTtlDays: num('GATEWAY_AUTH_REFRESH_TTL_DAYS', 7),
    jwtSecret: str('GATEWAY_JWT_SECRET', 'construx-development-secret'),

    /**
     * How many wrong codes one challenge accepts before it dies.
     *
     * A one-time code is six hex characters — sixteen million of them — and
     * until this existed a challenge accepted wrong guesses without limit for
     * its whole five-minute life. The only thing in the way was a per-address
     * rate limit, which is the one control a botnet defeats by definition,
     * because rotating addresses is what a botnet is for.
     *
     * Five, because a person who has mistyped a six-character code five times
     * is not going to get it right on the sixth; they need a new code, which
     * costs them one click and costs an attacker the whole guessing run.
     */
    maxChallengeAttempts: num('GATEWAY_AUTH_MAX_CHALLENGE_ATTEMPTS', 5),

    /**
     * Failed verifications against one identity before it stops accepting any,
     * and for how long.
     *
     * Counted against the **identity**, not the connection. That is the whole
     * point: an attack spread over a thousand addresses is a thousand
     * unremarkable rate-limit keys and one account being attacked, and only the
     * second of those is worth counting.
     *
     * The lock lifts by itself. A permanent one is a denial-of-service anybody
     * can perform on anybody by failing their sign-in enough times, so the
     * cooling period is short enough to be survivable and long enough to make
     * a sustained run pointless — fifteen minutes takes a sixteen-million-code
     * space from days to centuries.
     */
    maxIdentityFailures: num('GATEWAY_AUTH_MAX_IDENTITY_FAILURES', 10),
    failureWindowMinutes: num('GATEWAY_AUTH_FAILURE_WINDOW_MINUTES', 15),
    lockoutMinutes: num('GATEWAY_AUTH_LOCKOUT_MINUTES', 15),

    /**
     * Whether every session must be bound to an enrolled device.
     *
     * Off by default, and that default is a migration decision rather than a
     * security opinion. Turning it on refuses every session minted before a
     * device existed, which on a live deployment signs everybody out at once —
     * so it is the operator's switch to throw once their people have enrolled,
     * and the security screen shows them how far through that they are.
     *
     * With it off, an unbound session is not refused; it is *scored*, and
     * `identity/risk.ts` charges it thirty points, which is enough that an
     * unbound session doing anything serious is asked to verify again.
     */
    requireDeviceBinding: bool('GATEWAY_AUTH_REQUIRE_DEVICE_BINDING', false),

    /**
     * How long a step-up lasts, and how old a sign-in may be before an
     * ordinary act starts counting as stale.
     *
     * Fifteen minutes: long enough that a person doing a run of related work is
     * asked once, short enough that a session left open on a desk over lunch is
     * not still trusted to certify a payment.
     */
    stepUpWindowMinutes: num('GATEWAY_AUTH_STEP_UP_WINDOW_MINUTES', 15),

    /**
     * The amount past which committing money is a step-up signal, in minor
     * units. £50,000 by default.
     *
     * A business value, so it is here rather than in the risk model — a
     * tenancy whose smallest package is a million pounds and one whose largest
     * is twenty thousand should not share a threshold, and neither of them
     * should have to edit code to say so.
     */
    stepUpValueMinor: num('GATEWAY_AUTH_STEP_UP_VALUE_MINOR', 5_000_000),
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
    /**
     * Below this confidence, a machine-read result is held for review rather
     * than taken as read.
     *
     * 0.75 is where it has always been, and it was a constant in one domain
     * module. It is a policy about how much a deployment trusts extraction, not
     * a fact about the brief, and the deployments that need to move it are the
     * ones with either a much better model or much worse source documents.
     */
    confidenceThresholdDefault: num('AI_CONFIDENCE_THRESHOLD', 0.75),
    /**
     * Per-task overrides, as `title_block_extraction:0.9,clause_extraction:0.85`.
     *
     * Reading a title block off a drawing and reading an obligation out of a
     * contract are not the same risk, and one number for both is either too
     * loose for the clause or too tight for the drawing. Anything not named
     * here uses the default above.
     */
    confidenceThresholds: parseThresholds(str('AI_CONFIDENCE_THRESHOLDS', '')),
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
     * Hard economic rule: 1 unit of provider cost is charged at 5.
     *
     * The company keeps £4 of every £5 it takes — 400% profit on what it paid
     * the provider. Stated by the business as two halves of one rule: the
     * price is five times provider cost, and every £1 the platform spends with
     * a provider has to produce £5 of revenue.
     *
     * Everything downstream derives from this number — the wallet's charge, the
     * quote a screen shows before spending, what an ACU bundle is worth, the
     * invoice line — so this is the only place the rate is set. It was 4×.
     */
    markupMultiplier: num('ACU_MARKUP_MULTIPLIER', 5),
    /**
     * The company's required profit on every AI transaction, as a percentage
     * of what the provider charged.
     *
     * 400 means £1 of provider cost must produce £5 of revenue — the business
     * rule as stated, expressed as the profit it requires rather than as a bare
     * multiplier so the rule reads as the rule. A number called
     * `minimumMultiplier` invites somebody to tune it without asking what
     * profit it leaves.
     *
     * **The floor and the price now coincide at 5×, and that has a consequence
     * worth stating rather than discovering.** `settle` capped an execution
     * that overran its estimate at the amount reserved and disclosed, *unless*
     * honouring the cap would sell below this floor. With the floor at the
     * price, `floor === billed` on every settlement, so the cap is inert: an
     * execution that costs more than its estimate is charged in full at 5× and
     * the customer pays more than they were quoted.
     *
     * That is the rule as instructed — every £1 of provider cost produces £5,
     * with no case in which it produces less — and the exposure it creates is
     * handled by disclosure rather than by a silent discount: an overrun is
     * named on the ledger entry, carried into the invoice line, and shows up in
     * the operator's realised-multiplier view. Nothing about it is inferred
     * from arithmetic after the fact.
     */
    minimumProfitPercent: num('ACU_MINIMUM_PROFIT_PERCENT', 400),
    /**
     * One ACU is one minor unit, so £1 buys 100 ACUs and $1 buys 100. Stated
     * as its own value rather than assumed, because a currency with a
     * different exponent — a yen has no minor unit, a dinar has three — would
     * otherwise silently change what an ACU is worth.
     */
    acuUnitMinor: num('ACU_UNIT_MINOR', 1),
    acuPerMajorUnit: num('ACU_PER_MAJOR_UNIT', 100),
    /**
     * The provider cost of one run at each metering class, in minor units.
     *
     * The specification's Part H tiers. These are **provider cost**, not price:
     * what the customer is quoted is this multiplied by the same markup as
     * every other AI charge, so a tier cannot become a second pricing model
     * sitting beside the first.
     *
     * Configured rather than hardcoded because they are the one thing here that
     * genuinely moves — vendor prices change, and a tier is a claim about how
     * expensive a class of thinking is, not a constant of the platform. The
     * agents that used to carry their own figures (40, 50, 60, 75, chosen by
     * hand, unrelated to each other) now declare a tier and get their estimate
     * from here.
     */
    acuTierRawCostMinor: {
      LOW: num('ACU_TIER_LOW_RAW_MINOR', 2),
      MED: num('ACU_TIER_MED_RAW_MINOR', 10),
      HIGH: num('ACU_TIER_HIGH_RAW_MINOR', 30),
      PREMIUM: num('ACU_TIER_PREMIUM_RAW_MINOR', 90),
    },
    /**
     * The share of every subscription payment credited to the tenant's AI
     * wallet. The rest carries no provider cost against it.
     */
    subscriptionAcuAllocationPercent: num('ACU_SUBSCRIPTION_ALLOCATION_PERCENT', 20),
    /**
     * Days a subscription may run unpaid before the tenancy stops.
     *
     * Not zero, and the reason is that most late payments are not refusals. A
     * card expires, a finance team is on holiday, a bank holds a transfer —
     * cutting a customer off the hour a payment is late costs more in goodwill
     * and support than it saves in exposure. Seven days is one working week,
     * which is long enough for somebody to notice an email and short enough
     * that a genuine non-payer is not running a platform for a month free.
     */
    /**
     * What rendering one document out of the platform costs, before markup.
     *
     * Rendering is deterministic local compute, so unlike an AI task it carries
     * no provider bill — this is a platform service price, and it is here
     * rather than inline in the renderer for the same reason every other
     * figure is: a price written into a function is a price nobody can find.
     *
     * The same for both forms. A Word file and a PDF of one document are the
     * same instrument off the same `ExportDocument`, and charging differently
     * for them would be charging for the file extension. It runs through the
     * ordinary markup, so the ACU statement shows a document render beside an
     * AI call in the units the customer already reads.
     */
    documentRenderRawCostMinor: num('DOCUMENT_RENDER_RAW_COST_MINOR', 4),
    /**
     * What a spatial stage costs to run, before markup.
     *
     * The site-capture stages are compute the platform performs rather than
     * compute it buys — a reconstruction, a segmentation, a volume between two
     * meshes. That makes them exactly like a document render and unlike an AI
     * call: the cost is real, it is ours, and it is charged through the same
     * markup so a customer reads one statement rather than two.
     *
     * A fixed cost per stage would be a lie about the work. Reconstructing four
     * hundred feature tracks and reconstructing forty thousand are not the same
     * job, and a flat fee either overcharges the small site or subsidises the
     * large one out of the small one's money. So each stage carries a base and
     * a rate per thousand primitives it actually processed.
     */
    spatialStageRawCostMinor: {
      RECONSTRUCTION: num('SPATIAL_RECONSTRUCTION_RAW_COST_MINOR', 12),
      SEGMENTATION: num('SPATIAL_SEGMENTATION_RAW_COST_MINOR', 6),
      CHANGE_VOLUME: num('SPATIAL_CHANGE_VOLUME_RAW_COST_MINOR', 4),
    },
    /** Added per thousand primitives, so a large mesh costs more than a small one. */
    spatialRawCostMinorPerThousandPrimitives: num('SPATIAL_RAW_COST_MINOR_PER_THOUSAND', 2),
    /**
     * The integrator's commercial build-up, as four named components.
     *
     * A single "overhead" percentage is the industry habit and it is the thing
     * a client refuses to accept, because it cannot be argued with — 20% of
     * what, for what? Named separately, each part is defensible on its own:
     * this is what it costs to manage the interface, this is what the business
     * costs to keep open, this is the return for carrying the risk, and this is
     * money held against things going wrong that is not ours until they do not.
     *
     * Configuration rather than constants because the split is a commercial
     * position, and a business bidding against a framework rate has to be able
     * to move it without a code change.
     */
    integrationContingencyPercent: num('INTEGRATION_CONTINGENCY_PERCENT', 5),
    integrationManagementPercent: num('INTEGRATION_MANAGEMENT_PERCENT', 8),
    integrationOverheadPercent: num('INTEGRATION_OVERHEAD_PERCENT', 5),
    integrationProfitPercent: num('INTEGRATION_PROFIT_PERCENT', 7),
    /**
     * How many days of committed supplier spend the client advance must cover.
     *
     * The number that decides whether an integrator survives a client paying
     * late. Thirty days is one payment cycle: enough to pay everybody once
     * without the client's money having arrived.
     */
    integrationReserveCoverDays: num('INTEGRATION_RESERVE_COVER_DAYS', 30),
    /**
     * The payment period a public body must impose on itself and flow down the
     * whole chain — Public Contracts Regulations 2015, regulation 113.
     *
     * Configurable because the platform is not only used on public work and the
     * figure is a rule rather than a law of nature, but it is not a preference:
     * on a public contract, 30 days is the number and a subcontract stating
     * longer is in breach of a term the regulations require to be there.
     */
    publicSectorFlowDownDays: num('PUBLIC_SECTOR_FLOW_DOWN_DAYS', 30),
    /**
     * Beyond this, a business-to-business payment period is in the territory the
     * Late Payment of Commercial Debts (Interest) Act 1998 calls grossly unfair
     * to the supplier, and a term imposing it can be struck out.
     *
     * Sixty days is not a hard prohibition and this is not legal advice — it is
     * the point at which the platform stops treating a long period as a
     * commercial choice and starts saying it may not survive challenge.
     */
    grosslyUnfairPaymentDays: num('GROSSLY_UNFAIR_PAYMENT_DAYS', 60),
    /**
     * The share of committed value above which one supplier is the service
     * rather than part of it.
     *
     * A default, and the weakest kind of answer: a business that has set its
     * own maximum share on a framework has answered this with more care than a
     * platform constant can, and `intermediation.ts` uses that instead where it
     * exists. Forty per cent is the point at which replacing the coordinator is
     * one appointment rather than a re-procurement.
     */
    supplierConcentrationPercent: num('SUPPLIER_CONCENTRATION_PERCENT', 40),
    /**
     * How long before a framework ends that its expiry stops being a diary
     * entry and becomes something to act on.
     *
     * Six months, because re-procuring a framework takes longer than that and
     * the alternative is the client buying at will while the replacement is
     * still in procurement.
     */
    frameworkExpiryNoticeDays: num('FRAMEWORK_EXPIRY_NOTICE_DAYS', 180),

    subscriptionGraceDays: num('SUBSCRIPTION_GRACE_DAYS', 7),
    /**
     * Whether the collection timer runs.
     *
     * Off by default. A billing cycle that starts itself on a developer's
     * laptop, or on a staging box restored from a production journal, raises
     * charges against real tenancies — so arming it is a deliberate act on a
     * deployment rather than the default everywhere.
     */
    collectionEnabled: bool('SUBSCRIPTION_COLLECTION_ENABLED', false),
    /**
     * The one-off trial grant, in minor units of AI credit.
     *
     * Sized as a first task, not a first project. It was 500 — £5.00 of credit
     * at face value, £1.00 of provider cost at the 5× markup if every unit is
     * spent — which is a real invoice per signup with nothing paid against it,
     * and it scales with signups rather than with revenue. At 100 the grant
     * still covers a handful of standard runs (a MED-class run costs 10 raw,
     * 50 billed) and the worst case per trial is £0.20 of provider cost.
     *
     * The aggregate exposure is bounded separately by
     * `trialMonthlyBudgetMinor` below; this figure only sizes one grant.
     */
    freeTrialGrantMinor: num('FREE_TRIAL_GRANT_MINOR', 100),
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
    /**
     * The most trial credit the platform will give away in one calendar month,
     * in minor units at face value, across every signup.
     *
     * The per-organisation rule above bounds how often one company can take
     * the grant; nothing bounded how many companies could. A million signups
     * at £1.00 of provider cost each is a million pounds the platform has
     * promised to vendors with no revenue against it, and a free tier that
     * scales its own cost with its own popularity is a liability, not a
     * funnel. This is the ceiling: once the month's allocation is issued, a
     * new tenancy is still created and everything else works, but the wallet
     * opens empty and the person is told so — AI runs as soon as they top up.
     *
     * The default is £1,000 of face-value credit a month: at the default grant
     * that is a thousand trials, and at most £200 of provider cost. Raise it
     * deliberately for a campaign; the Command Center shows how much of it has
     * gone.
     */
    trialMonthlyBudgetMinor: num('TRIALS_MONTHLY_BUDGET_MINOR', 100_000),
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

  /**
   * The public site's own assets, as opposed to any customer's.
   *
   * The landing page has five picture slots. They used to be fillable only by
   * putting a file inside the checkout, which on a deployed container means a
   * rebuild — so in practice they could not be filled at all by the person
   * whose pictures they are. Pointing this at the volume the ledger journal
   * already uses makes an upload survive a redeploy.
   *
   * Empty means `frontend/media/` in the checkout, which is where the files
   * were before and keeps a development machine behaving as it did.
   */
  site: {
    mediaPath: str('SITE_MEDIA_PATH', ''),
    /**
     * Per-picture ceiling. The largest slot is a 2400px plate, which lands
     * around 600KB–1.5MB compressed; 8MB is generous for that and small enough
     * that the marketing page cannot fill the volume the ledger writes to.
     */
    mediaMaxBytes: num('SITE_MEDIA_MAX_BYTES', 8 * 1_048_576),
    /**
     * The business behind the site, for the header, the footer, the contact
     * page and the `Organization` structured data on every page. Nothing here
     * is invented when unset: a phone that is not configured is not shown.
     * The email defaults to the address the contact page has always named.
     */
    business: {
      legalName: str('SITE_LEGAL_NAME', 'CONSTRUX'),
      email: str('SITE_CONTACT_EMAIL', 'contact@construxvg.com'),
      phone: str('SITE_CONTACT_PHONE', ''),
      addressStreet: str('SITE_ADDRESS_STREET', ''),
      addressLocality: str('SITE_ADDRESS_LOCALITY', ''),
      addressRegion: str('SITE_ADDRESS_REGION', ''),
      addressPostcode: str('SITE_ADDRESS_POSTCODE', ''),
      addressCountry: str('SITE_ADDRESS_COUNTRY', 'GB'),
      social: list('SITE_SOCIAL_LINKS'),
      openingHours: list('SITE_OPENING_HOURS'),
    },
  },

  /**
   * When a guided walkthrough can be booked.
   *
   * Overridable because hard-coding one company's office hours into a platform
   * is the kind of assumption that stays invisible until somebody in another
   * timezone is offered three in the morning. Everything is UTC — a single
   * reference frame that both sides can convert from beats a timezone guessed
   * from a browser.
   */
  booking: {
    minutes: num('BOOKING_MINUTES', 20),
    /** UTC hours a session may start at. Nine to four, London working hours. */
    hoursUtc: (process.env.BOOKING_HOURS_UTC ?? '9,10,11,13,14,15,16')
      .split(',')
      .map((hour) => Number(hour.trim()))
      .filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23),
    /** Working days offered ahead. Two working weeks is a choice, not a wait. */
    horizonDays: num('BOOKING_HORIZON_DAYS', 10),
    /** Nobody prepares for a call in ten minutes, so nothing sooner is offered. */
    leadHours: num('BOOKING_LEAD_HOURS', 4),
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

  /**
   * The marketing agent: the daily release and where a published post is sent.
   *
   * Every channel is off until its credential is set, and the SEO & Content
   * screen says which variable is missing rather than showing a channel that
   * looks live and is not. The release timer is a deliberate act on one
   * deployment for the same reason the newsletter's is: a marketing agent that
   * armed itself at boot would publish from a laptop and a CI run.
   */
  marketing: {
    releaseEnabled: bool('MARKETING_RELEASE_ENABLED', false),
    /** UTC hour the daily release runs. Once a day, idempotent by date. */
    releaseHourUtc: num('MARKETING_RELEASE_HOUR_UTC', 8),
    /** A LinkedIn Community Management API token with `w_organization_social`, and the organisation it posts as. */
    linkedinAccessToken: str('LINKEDIN_ACCESS_TOKEN', ''),
    linkedinOrgId: str('LINKEDIN_ORG_ID', ''),
    /** An X API OAuth 2.0 user-context token with `tweet.write`. An app-only bearer token cannot post. */
    xAccessToken: str('X_ACCESS_TOKEN', ''),
    /** Where the email announcement of a published post goes — a list or team address the operator controls. */
    announceTo: str('MARKETING_ANNOUNCE_TO', ''),
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
/**
 * The confidence below which a machine-read result is held for review.
 *
 * One function, so the brief's extraction threshold and anything else that
 * needs one cannot drift apart. Per-task first, then the default.
 */
export function confidenceThresholdFor(taskType: string): number {
  return config.ai.confidenceThresholds[taskType] ?? config.ai.confidenceThresholdDefault;
}

export function demonstrationEnabled(): boolean {
  const raw = process.env.DEMO_TENANCY_ENABLED;
  // Unset means on, matching `config.demo.enabled`. The two must agree or a
  // deployment seeds a demonstration at boot that every route then refuses to
  // show — working, invisible, and very hard to explain.
  if (raw === undefined || raw === '') return true;
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
    if (config.ledger.postgresMode === 'off' && config.postgres.host !== '') {
      warnings.push(
        'POSTGRES_HOST is set and LEDGER_POSTGRES_MODE is off — the database is configured and the ledger is not being shipped to it',
      );
    }
    {
      const raw = (process.env.LEDGER_POSTGRES_MODE ?? '').trim().toLowerCase();
      if (raw !== '' && raw !== 'off' && raw !== 'mirror' && raw !== 'primary' && raw !== 'follower') {
        warnings.push(`LEDGER_POSTGRES_MODE is "${raw}", which is not off, mirror, primary or follower — the ledger store is off`);
      }
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
    if (config.marketing.releaseEnabled && !config.marketing.linkedinAccessToken && !config.marketing.xAccessToken && !config.marketing.announceTo) {
      warnings.push('MARKETING_RELEASE_ENABLED is on with no distribution channel configured — the daily release will publish and tell nobody');
    }
    if (config.marketing.linkedinAccessToken !== '' && config.marketing.linkedinOrgId === '') {
      warnings.push('LINKEDIN_ACCESS_TOKEN is set without LINKEDIN_ORG_ID — LinkedIn has no organisation to post as');
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

  // The check that had to live outside the block above, and why.
  //
  // Every warning in this function sat inside `if (config.env === 'production')`
  // — so the deployment that most needs them is the one that gets none. Unset
  // `NODE_ENV` and the platform stops warning about the development signing
  // secret, stops warning about an in-memory ledger, and stops warning about
  // anything else, at exactly the moment it also:
  //
  //   - returns `devCode` — the live one-time sign-in code — in the login
  //     response, to any anonymous caller, for any address on the deployment;
  //   - serves `POST /v1/console/session`, which hands a PM access token to
  //     anyone who asks, with no credential and no challenge.
  //
  // Both gates read `isProduction()` and both are correct. The defect was that
  // nothing said the gates were open. An audit reproduced it: with `NODE_ENV`
  // unset and everything else configured like a real deployment, the login
  // route returned a working code and the console route returned a working
  // token, and readiness reported zero warnings.
  //
  // `deploy/Dockerfile` sets `NODE_ENV=production`, `deploy/compose.yaml` sets
  // it, and `deploy/env-check.sh` reports it as critical — so the shipped path
  // is covered. This is for the deployment that does not use them: somebody
  // running `npm start` behind a reverse proxy, which is the ordinary way a
  // first deployment happens.
  //
  // Deliberately not an error. Refusing to boot would brick a legitimate
  // staging environment that is https and non-production on purpose. It says
  // what is open and lets an operator decide.
  if (config.env !== 'production') {
    const looksPublic: string[] = [];
    if (/^https:\/\//.test(config.publicBaseUrl)) looksPublic.push('PUBLIC_BASE_URL is https');
    if (config.transport.termination !== 'NOT_DECLARED') looksPublic.push('TLS_TERMINATION is declared');
    if (config.smtp.host !== '') looksPublic.push('SMTP_HOST is set');
    if (config.ledger.journalPath !== '') looksPublic.push('LEDGER_JOURNAL_PATH is set');
    if (config.auth.jwtSecret !== 'construx-development-secret') looksPublic.push('a deployment-specific signing secret is set');

    if (looksPublic.length >= 2) {
      warnings.push(
        `NODE_ENV is "${config.env}", not "production", on a deployment that looks live (${looksPublic.join('; ')}). ` +
          'While it stays that way the login route returns the one-time sign-in code to any anonymous caller for any ' +
          'address, and POST /v1/console/session hands out a working access token with no credential at all. Every ' +
          'other warning this function raises is also suppressed. Set NODE_ENV=production.',
      );
    }
  }

  return warnings;
}
