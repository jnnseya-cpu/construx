import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export type AIMode = 'local' | 'staging' | 'production';

export const config = {
  env: str('NODE_ENV', 'development'),
  port: num('PORT', 8080),

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
  },

  billing: {
    /** Hard economic rule: GBP/USD 1 of provider cost is charged at 3. */
    markupMultiplier: num('ACU_MARKUP_MULTIPLIER', 3),
    acuUnitMinor: num('ACU_UNIT_MINOR', 1),
    freeTrialGrantMinor: num('FREE_TRIAL_GRANT_MINOR', 500),
  },

  /** Absolute origin used in email links. Email cannot resolve a relative path. */
  publicBaseUrl: str('PUBLIC_BASE_URL', `http://localhost:${num('PORT', 8080)}`),

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
    fromName: str('NEWSLETTER_FROM_NAME', 'CONSTRUX.AI'),
    fromAddress: str('NEWSLETTER_FROM_ADDRESS', 'hello@construx.ai'),
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

/** Warn loudly rather than fail silently when production is misconfigured. */
export function assertProductionSafety(): string[] {
  const warnings: string[] = [];
  if (config.env === 'production') {
    if (config.auth.jwtSecret === 'construx-development-secret') {
      warnings.push('GATEWAY_JWT_SECRET is still the development default');
    }
    if (config.ai.mode !== 'production') {
      warnings.push(`AI_MODE is "${config.ai.mode}" in a production environment`);
    }
    if (!config.auth.required) warnings.push('GATEWAY_REQUIRE_AUTH is disabled in production');
    if (config.newsletter.enabled && !config.smtp.host) {
      warnings.push('NEWSLETTER_ENABLED is on but SMTP_HOST is unset — issues will be recorded, not delivered');
    }
    if (config.newsletter.enabled && config.publicBaseUrl.startsWith('http://')) {
      // Unsubscribe links carry a signed token. Over http they are readable in
      // transit, and a mail client following one leaks it to every hop.
      warnings.push('PUBLIC_BASE_URL is not https — unsubscribe links would be sent over cleartext');
    }
  }
  if (config.smtp.host && config.smtp.pass === '' && config.smtp.user !== '') {
    warnings.push('SMTP_USER is set without SMTP_PASS — authentication will fail');
  }
  return warnings;
}
