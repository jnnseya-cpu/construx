import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { AuthError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { Role } from './roles.ts';
import { scopesForRoles } from './scopes.ts';

/**
 * Token issuance and verification.
 *
 * The gateway is stateless: it verifies a signed token and rebuilds the auth
 * context from claims. No server-side session is held. The same normalised
 * context is produced whether the token came from the platform's own identity
 * service or from an external IdP.
 */

export type AuthContext = {
  actorId: string;
  tenantId: string;
  enterpriseId?: string;
  /** Party this actor belongs to — the supplier confinement anchor. */
  partyId?: string;
  roles: Role[];
  scopes: string[];
  tokenId: string;
  mfaSatisfied: boolean;
  /** Owners may explicitly enable AI execution for a regulator. Off by default. */
  regulatorAiEnabled: boolean;
  expiresAt: number;
};

type TokenClaims = {
  sub: string;
  tid: string;
  eid?: string;
  pid?: string;
  roles: Role[];
  scopes: string[];
  jti: string;
  mfa: boolean;
  rai?: boolean;
  typ: 'access' | 'refresh';
  iat: number;
  exp: number;
  iss: string;
  aud: string;
};

const ISSUER = 'https://construx.ai';
const AUDIENCE = 'construx-gateway';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', config.auth.jwtSecret).update(payload).digest('base64url');
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function encode(claims: TokenClaims): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(claims));
  return `${header}.${body}.${sign(`${header}.${body}`)}`;
}

export type IssueInput = {
  actorId: string;
  tenantId: string;
  enterpriseId?: string;
  partyId?: string;
  roles: Role[];
  /** Explicit scope grant; defaults to the roles' full derived scope set. */
  scopes?: string[];
  mfaSatisfied?: boolean;
  regulatorAiEnabled?: boolean;
};

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  tokenType: 'Bearer';
};

export function issueTokens(input: IssueInput, now = Date.now()): TokenPair {
  const issuedAt = Math.floor(now / 1000);
  const accessTtl = config.auth.accessTtlMinutes * 60;
  const refreshTtl = config.auth.refreshTtlDays * 24 * 60 * 60;
  const scopes = input.scopes ?? scopesForRoles(input.roles);
  const tokenId = ulid();

  const base = {
    sub: input.actorId,
    tid: input.tenantId,
    eid: input.enterpriseId,
    pid: input.partyId,
    roles: input.roles,
    scopes,
    jti: tokenId,
    mfa: input.mfaSatisfied ?? false,
    rai: input.regulatorAiEnabled ?? false,
    iat: issuedAt,
    iss: ISSUER,
    aud: AUDIENCE,
  };

  return {
    accessToken: encode({ ...base, typ: 'access', exp: issuedAt + accessTtl }),
    // Refresh tokens carry no scopes: they buy a new access token, nothing else.
    refreshToken: encode({ ...base, scopes: [], typ: 'refresh', exp: issuedAt + refreshTtl }),
    expiresIn: accessTtl,
    refreshExpiresIn: refreshTtl,
    tokenType: 'Bearer',
  };
}

/** Revoked token ids. A real deployment backs this with a shared store. */
const revoked = new Set<string>();

export function revokeToken(tokenId: string): void {
  revoked.add(tokenId);
}

export function verifyToken(token: string, expectedType: 'access' | 'refresh' = 'access', now = Date.now()): AuthContext {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('Malformed token');
  const [header, body, signature] = parts as [string, string, string];

  if (!safeEquals(signature, sign(`${header}.${body}`))) throw new AuthError('Invalid token signature');

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenClaims;
  } catch {
    throw new AuthError('Unreadable token payload');
  }

  if (claims.iss !== ISSUER || claims.aud !== AUDIENCE) throw new AuthError('Token issuer or audience mismatch');
  if (claims.typ !== expectedType) throw new AuthError(`Expected a ${expectedType} token`);
  // No grace window: an expired token is rejected before routing.
  if (claims.exp * 1000 <= now) throw new AuthError('Token has expired');
  if (revoked.has(claims.jti)) throw new AuthError('Token has been revoked');

  return {
    actorId: claims.sub,
    tenantId: claims.tid,
    enterpriseId: claims.eid,
    partyId: claims.pid,
    roles: claims.roles ?? [],
    scopes: claims.scopes ?? [],
    tokenId: claims.jti,
    mfaSatisfied: claims.mfa === true,
    regulatorAiEnabled: claims.rai === true,
    expiresAt: claims.exp * 1000,
  };
}

/** Rotate a refresh token: the presented one is revoked as the new pair is minted. */
export function refreshTokens(refreshToken: string, now = Date.now()): TokenPair {
  const context = verifyToken(refreshToken, 'refresh', now);
  revokeToken(context.tokenId);
  return issueTokens(
    {
      actorId: context.actorId,
      tenantId: context.tenantId,
      enterpriseId: context.enterpriseId,
      partyId: context.partyId,
      roles: context.roles,
      mfaSatisfied: context.mfaSatisfied,
      regulatorAiEnabled: context.regulatorAiEnabled,
    },
    now,
  );
}

// --- Multi-factor challenge -------------------------------------------------

export type MfaChallenge = { challengeId: string; methods: string[]; code: string; expiresAt: number };

const challenges = new Map<string, MfaChallenge>();

export function createMfaChallenge(actorId: string, methods = ['TOTP', 'SMS']): MfaChallenge {
  const challenge: MfaChallenge = {
    challengeId: ulid(),
    methods,
    code: randomBytes(3).toString('hex').toUpperCase(),
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
  challenges.set(`${actorId}:${challenge.challengeId}`, challenge);
  return challenge;
}

export function verifyMfaChallenge(actorId: string, challengeId: string, code: string): boolean {
  const key = `${actorId}:${challengeId}`;
  const challenge = challenges.get(key);
  if (!challenge) return false;
  if (challenge.expiresAt < Date.now()) {
    challenges.delete(key);
    return false;
  }
  const matched = challenge.code === code.toUpperCase();
  if (matched) challenges.delete(key);
  return matched;
}

/**
 * Strip MFA detail when GATEWAY_AUTH_EXPOSE_MFA is off — clients then see only
 * a generic "additional verification required".
 */
export function shapeMfaResponse(challenge: MfaChallenge): Record<string, unknown> {
  if (config.auth.exposeMfa) {
    return { mfaRequired: true, challengeId: challenge.challengeId, methods: challenge.methods };
  }
  return { mfaRequired: true, message: 'Additional verification required' };
}
