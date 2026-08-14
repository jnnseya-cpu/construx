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
} as const;

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
  }
  return warnings;
}
