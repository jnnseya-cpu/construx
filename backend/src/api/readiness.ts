import { assertProductionSafety, config, environmentReport, isProduction } from '../config.ts';
import { parseTrustedProxies } from './clientaddress.ts';

/**
 * What this deployment actually has configured.
 *
 * The platform already knew all of this. `assertProductionSafety` computes it at
 * boot and prints it to a log nobody reads again, and `config.ts` holds the
 * values — so the one person whose job is to fix a half-configured deployment
 * had no way to see its state without SSH access to the box. That is how a
 * deployment sits for a day with a payment rail keyed on one side, an operator
 * address nobody set, and a ledger writing to nothing.
 *
 * The rule this module exists under, and the reason it is a separate file rather
 * than a handful of booleans in a route: **it reports whether a value is set and
 * never what it is.** No secret, no key, no password and no connection string
 * crosses this boundary, including in a `detail` string. A readiness screen that
 * leaks the thing it is reporting on is worse than no readiness screen. The env
 * var *names* are published deliberately — they are documentation, they are in
 * `.env.example` already, and an operator cannot fix what they cannot name.
 *
 * Three states, because two is a lie:
 *
 * - `CONFIGURED` — set, and usable.
 * - `NOT_SET` — absent. The feature is off, and the platform behaves correctly
 *   without it.
 * - `DEGRADED` — present and wrong, or present on one side only. This is the
 *   state that matters: a Stripe key with no webhook secret takes money and
 *   credits nothing, and it looks configured from every angle except this one.
 *
 * Nothing here is a latency, a percentage or an uptime figure. The platform does
 * not measure those, and inventing them is what makes a status page furniture.
 */

export type CapabilityState = 'CONFIGURED' | 'NOT_SET' | 'DEGRADED';

export type Capability = {
  key: string;
  label: string;
  /** The deployment is not fit to hold a paying customer without this. */
  critical: boolean;
  state: CapabilityState;
  /** What the current state means operationally. Never contains a value. */
  detail: string;
  /** The variables that govern it, by name. Never their contents. */
  env: string[];
};

export type Readiness = {
  at: string;
  environment: string;
  production: boolean;
  /** Boot-time warnings from `assertProductionSafety`, verbatim. */
  warnings: string[];
  configured: number;
  degraded: number;
  /** Critical capabilities not yet configured — the go-live blocker list. */
  blocking: string[];
  capabilities: Capability[];
  /**
   * Every variable this process reads, and what it actually received.
   *
   * The capability list above says what works; this says what arrived. They
   * answer different questions, and the second one is what catches a variable
   * set under a misspelt name, scoped to the wrong environment, or truncated by
   * a paste that swallowed the end of the line — all of which look like "not
   * configured" from the capability view with no way to tell them apart.
   */
  variables: ReturnType<typeof environmentReport>;
};

/** Both halves, one half, or neither — the shape every payment rail has. */
function pair(
  key: string,
  label: string,
  a: string,
  b: string,
  env: string[],
  wired: string,
  half: string,
  absent: string,
): Capability {
  const state: CapabilityState = a !== '' && b !== '' ? 'CONFIGURED' : a === '' && b === '' ? 'NOT_SET' : 'DEGRADED';
  return {
    key,
    label,
    critical: false,
    state,
    detail: state === 'CONFIGURED' ? wired : state === 'DEGRADED' ? half : absent,
    env,
  };
}

export function readiness(now = new Date()): Readiness {
  const production = isProduction();
  const providers = [
    ['OPENAI', config.ai.openaiKey],
    ['GEMINI', config.ai.geminiKey],
    ['ANTHROPIC', config.ai.anthropicKey],
  ] as const;
  const keyed = providers.filter(([, key]) => key !== '').map(([name]) => name);

  const capabilities: Capability[] = [
    {
      key: 'ledger.journal',
      label: 'Ledger durability',
      critical: true,
      state: config.ledger.journalPath === '' ? 'NOT_SET' : config.ledger.fsync ? 'CONFIGURED' : 'DEGRADED',
      detail:
        config.ledger.journalPath === ''
          ? 'The ledger is in memory only. Every record is lost on restart.'
          : config.ledger.fsync
            ? 'Every event is appended to the journal and flushed to disk before it is acknowledged.'
            : 'The journal is written but not flushed — an event can be acknowledged before it reaches the disk.',
      env: ['LEDGER_JOURNAL_PATH', 'LEDGER_JOURNAL_FSYNC'],
    },
    {
      key: 'ledger.store',
      label: 'Ledger store',
      // Not critical: the journal on the volume is a complete, durable answer
      // for one instance, and a deployment without Postgres is not degraded by
      // not having it. What is critical is a store that is configured and
      // cannot be reached, and that refuses boot rather than reporting here.
      critical: false,
      state:
        config.ledger.postgresMode === 'off'
          ? 'NOT_SET'
          : config.postgres.host === ''
            ? 'DEGRADED'
            : 'CONFIGURED',
      detail:
        config.ledger.postgresMode === 'off'
          ? 'The record lives in the journal on this volume alone. A new host starts from a backup of that file.'
          : config.postgres.host === ''
            ? `LEDGER_POSTGRES_MODE is "${config.ledger.postgresMode}" and POSTGRES_HOST is not set, so the store cannot be reached and the process will not have started.`
            : config.ledger.postgresMode === 'primary'
              ? `Every event is shipped to Postgres at ${config.postgres.host}, in order, and a new host replays from there. The journal is the local write-ahead log.`
              : config.ledger.postgresMode === 'follower'
                ? `This process follows Postgres at ${config.postgres.host}: it replayed the record at boot, polls every ${config.ledger.followIntervalMs}ms for what the primary ships, answers reads and refuses every write (503 LEDGER_FOLLOWER). Promote it by restarting with LEDGER_POSTGRES_MODE=primary once the primary has stopped.`
                : `Every event is shipped to Postgres at ${config.postgres.host} beside the journal, which is still what a restart replays. Switch to "primary" once the two agree.`,
      env: ['LEDGER_POSTGRES_MODE', 'POSTGRES_HOST', 'POSTGRES_PASSWORD'],
    },
    {
      key: 'auth.secret',
      label: 'Session signing secret',
      critical: true,
      // The default is a published string. On a deployment that keeps it, anyone
      // who has read this repository can mint a session for any role.
      state: config.auth.jwtSecret === 'construx-development-secret' ? 'DEGRADED' : 'CONFIGURED',
      detail:
        config.auth.jwtSecret === 'construx-development-secret'
          ? 'Still the development default, which is a published value — anyone holding it can forge a session for any role.'
          : 'A deployment-specific secret is set. Sessions cannot be forged from the repository.',
      env: ['GATEWAY_JWT_SECRET'],
    },
    {
      key: 'platform.operator',
      label: 'Platform operator',
      critical: true,
      state: config.platform.operatorEmail === '' ? 'NOT_SET' : 'CONFIGURED',
      detail:
        config.platform.operatorEmail === ''
          ? 'No operator address. If this deployment has no operator yet, nobody can sign in and no tenancy can be created.'
          : 'An operator is ensured at boot for the configured address. Sign-in is an emailed one-time code.',
      env: ['PLATFORM_OPERATOR_EMAIL', 'PLATFORM_OPERATOR_NAME'],
    },
    {
      key: 'auth.enforcement',
      label: 'Authorisation enforcement',
      critical: true,
      state:
        config.auth.required && config.authz.rbac && config.authz.abac && config.authz.scopes ? 'CONFIGURED' : 'DEGRADED',
      detail:
        config.auth.required && config.authz.rbac && config.authz.abac && config.authz.scopes
          ? 'Authentication, RBAC, ABAC and scopes are all enforced on every protected route.'
          : 'One of authentication, RBAC, ABAC or scopes is switched off. The platform is not enforcing its own permission model.',
      env: ['GATEWAY_REQUIRE_AUTH', 'GATEWAY_RBAC_ENABLED', 'GATEWAY_ABAC_ENABLED', 'GATEWAY_SCOPES_ENABLED'],
    },
    {
      key: 'evidence.store',
      label: 'Evidence store',
      critical: true,
      state: config.evidence.storePath === '' ? 'NOT_SET' : 'CONFIGURED',
      detail:
        config.evidence.storePath === ''
          ? 'Hashes only — the platform records that a document was the evidence and does not hold the document. The chain lasts as long as whoever else still has the file.'
          : process.env.EVIDENCE_STORE_PATH
            ? 'Files follow their hashes into a tenant-scoped store, so the record carries its own evidence.'
            : 'Files follow their hashes into a tenant-scoped store beside the ledger journal, on the same volume (EVIDENCE_STORE_PATH is unset, so the location is derived from LEDGER_JOURNAL_PATH).',
      env: ['EVIDENCE_STORE_PATH', 'EVIDENCE_MAX_BYTES'],
    },
    {
      key: 'signing.key',
      label: 'Signature witness',
      critical: false,
      state: config.signing.privateKeyPem === '' ? 'NOT_SET' : 'CONFIGURED',
      detail:
        config.signing.privateKeyPem === ''
          ? 'No signing key, so every signature request is refused. Generating one at boot would be worse: every signature ever made would fail verification after the next restart.'
          : 'An Ed25519 key is loaded. The platform can witness a signature and the witness survives a restart.',
      env: ['SIGNING_PRIVATE_KEY_PEM'],
    },
    {
      key: 'transport.trustedProxies',
      label: 'Client address behind a proxy',
      critical: false,
      state:
        parseTrustedProxies(config.transport.trustedProxyCidrs).rejected.length > 0
          ? 'DEGRADED'
          : config.transport.trustedProxyCidrs === ''
            ? 'NOT_SET'
            : 'CONFIGURED',
      detail:
        parseTrustedProxies(config.transport.trustedProxyCidrs).rejected.length > 0
          ? `Some entries could not be read: ${parseTrustedProxies(config.transport.trustedProxyCidrs).rejected.join(', ')}. ` +
            'Those ranges are not trusted, so requests arriving through them are rate limited as if they came from the proxy.'
          : config.transport.trustedProxyCidrs === ''
            ? 'Rate limits are keyed on the socket address. Correct with nothing in front of this process — but behind a ' +
              'reverse proxy every request in the world shares one bucket, so one client can exhaust the budget for ' +
              'everybody and the login limit stops being per-address.'
            : `${parseTrustedProxies(config.transport.trustedProxyCidrs).blocks.length} range(s) trusted. Requests through ` +
              'them are rate limited on the forwarded client address rather than on the proxy.',
      env: ['TRUSTED_PROXY_CIDRS'],
    },
    pair(
      'payments.card',
      'Card payments',
      config.stripe.secretKey,
      config.stripe.webhookSecret,
      ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_SUCCESS_URL', 'STRIPE_CANCEL_URL'],
      'Checkout can be opened and settlements are verified before anything is credited.',
      'Keyed on one side only. A secret key with no webhook secret takes the money and has no verified way to be told, so the checkout route stays disabled until both are present.',
      'Not configured. The card checkout route refuses, which is the correct unconfigured state for a route that credits wallets.',
    ),
    pair(
      'payments.mobile',
      'Mobile money',
      config.koda.secretKey,
      config.koda.webhookSecret,
      ['KODA_SECRET_KEY', 'KODA_WEBHOOK_SECRET', 'KODA_USD_PER_GBP', 'KODA_OPERATORS'],
      'Mobile-money checkout can be opened and settlements are verified before anything is credited.',
      'Keyed on one side only, so the mobile-money checkout route stays disabled until both are present.',
      'Not configured. The mobile-money checkout route refuses.',
    ),
    {
      key: 'ai.providers',
      label: 'AI providers',
      critical: false,
      // The mode is the switch that decides whether a key is used at all. A
      // deployment holding three keys in local mode spends nothing and calls
      // nobody, which is a state worth naming rather than reporting as ready.
      state:
        config.ai.mode === 'production' && keyed.length > 0
          ? 'CONFIGURED'
          : config.ai.mode === 'production' && keyed.length === 0
            ? 'DEGRADED'
            : 'NOT_SET',
      detail:
        config.ai.mode !== 'production'
          ? `Mode is "${config.ai.mode}" — the deterministic engines serve every request and no provider is called, whatever keys are present.`
          : keyed.length > 0
            ? `Live calls enabled. Keyed: ${keyed.join(', ')}. Routing leads with the configured primaries and falls back through the rest.`
            : 'Mode is production and no provider key is set, so every AI request falls back to the deterministic engines.',
      env: ['AI_MODE', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'AI_REASONING_PROVIDER', 'AI_PERCEPTION_PROVIDER'],
    },
    {
      key: 'ai.clearance',
      label: 'AI vendor clearance',
      critical: false,
      // Not critical in the go-live sense — a deployment with nothing cleared is
      // safe, it simply refuses the sensitive work. It is listed because the
      // refusal is otherwise discovered by a user mid-command rather than by an
      // operator reading a screen.
      state: Object.keys(config.ai.providerClearance).length > 0 ? 'CONFIGURED' : 'NOT_SET',
      detail:
        Object.keys(config.ai.providerClearance).length > 0
          ? `Set per vendor: ${Object.entries(config.ai.providerClearance)
              .map(([provider, level]) => `${provider} up to ${level}`)
              .join(', ')}. Anything else is capped at ${config.ai.defaultClearance}.`
          : `Nothing stated, so every vendor is capped at ${config.ai.defaultClearance}. Contracts, claims and safety records will not be sent to any provider — the request is refused rather than routed. Set this once the data processing agreement with each vendor is in place.`,
      env: ['AI_PROVIDER_CLEARANCE', 'AI_DEFAULT_CLEARANCE'],
    },
    {
      key: 'mail.transactional',
      label: 'Transactional email',
      critical: true,
      // Sign-in is an emailed one-time code and there is no password anywhere.
      // With no relay a production deployment cannot be signed into at all.
      state:
        config.smtp.host !== '' && config.smtp.user !== '' && config.smtp.pass !== ''
          ? 'CONFIGURED'
          : config.smtp.host === '' && config.smtp.user === '' && config.smtp.pass === ''
            ? 'NOT_SET'
            : 'DEGRADED',
      detail:
        config.smtp.host !== '' && config.smtp.user !== '' && config.smtp.pass !== ''
          ? `Login codes and account mail are sent as ${config.notifications.fromAddress}.`
          : config.smtp.host === ''
            ? 'No relay. Sign-in is an emailed one-time code and there is no password anywhere, so nobody can sign in to a production deployment without this.'
            : 'A relay is named but the credentials are incomplete, so every send will be refused by the server.',
      env: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'NOTIFICATIONS_FROM_ADDRESS'],
    },
    {
      key: 'mail.newsletter',
      label: 'Weekly newsletter',
      critical: false,
      state: !config.newsletter.enabled ? 'NOT_SET' : config.smtp.host === '' ? 'DEGRADED' : 'CONFIGURED',
      detail: !config.newsletter.enabled
        ? 'Switched off. Nothing is sent, and no issue is composed.'
        : config.smtp.host === ''
          ? 'Armed with no relay configured — issues are recorded and never delivered.'
          : `Armed. A weekly issue goes to verified, opted-in recipients as ${config.newsletter.fromAddress}, each with a signed one-click unsubscribe.`,
      env: ['NEWSLETTER_ENABLED', 'NEWSLETTER_FROM_ADDRESS', 'NEWSLETTER_SEND_DAY_UTC', 'NEWSLETTER_SEND_HOUR_UTC'],
    },
    {
      key: 'gateway.ratelimit',
      label: 'Shared rate limiter',
      critical: false,
      state: config.rateLimit.redisUrl === '' ? 'NOT_SET' : 'CONFIGURED',
      detail:
        config.rateLimit.redisUrl === ''
          ? 'Buckets are per-process. Correct for one instance; behind a load balancer with N replicas the configured limit is enforced N times over, including on the login route.'
          : 'Buckets live in Redis, so every replica shares one limit. An unreachable store is a denial, never a fall-back to the local bucket.',
      env: ['GATEWAY_RATE_LIMIT_REDIS_URL', 'GATEWAY_RATE_LIMIT_MAX', 'GATEWAY_RATE_LIMIT_WINDOW_SECONDS'],
    },
    {
      key: 'public.url',
      label: 'Public address',
      critical: true,
      state: config.publicBaseUrl.startsWith('https://')
        ? 'CONFIGURED'
        : config.publicBaseUrl.startsWith('http://localhost')
          ? 'NOT_SET'
          : 'DEGRADED',
      detail: config.publicBaseUrl.startsWith('https://')
        ? `Links the platform sends — sign-in, unsubscribe, payment returns — are built on ${config.publicBaseUrl}.`
        : config.publicBaseUrl.startsWith('http://localhost')
          ? 'Still the local default, so every link the platform emails points at the machine it is running on.'
          : 'Not https. Signed links, including unsubscribe tokens, would be readable in transit and leaked to every hop a mail client follows.',
      env: ['PUBLIC_BASE_URL'],
    },
    {
      key: 'analytics',
      label: 'Marketing analytics',
      critical: false,
      state: config.analytics.metaPixelId === '' && config.analytics.googleTagId === '' ? 'NOT_SET' : 'CONFIGURED',
      detail:
        config.analytics.metaPixelId === '' && config.analytics.googleTagId === ''
          ? 'No tag is loaded on the public site, so no third party sees a visitor.'
          : 'A tag is loaded on the public site. It is not loaded inside the console — delivery data is never handed to an analytics vendor.',
      env: ['ANALYTICS_META_PIXEL_ID', 'ANALYTICS_GOOGLE_TAG_ID'],
    },
  ];

  return {
    at: now.toISOString(),
    environment: config.env,
    production,
    // The boot warnings, unchanged. They are the same judgements and rewording
    // them here would give the platform two voices on one question.
    warnings: assertProductionSafety(),
    configured: capabilities.filter((c) => c.state === 'CONFIGURED').length,
    degraded: capabilities.filter((c) => c.state === 'DEGRADED').length,
    blocking: capabilities.filter((c) => c.critical && c.state !== 'CONFIGURED').map((c) => c.label),
    capabilities,
    variables: environmentReport(),
  };
}
