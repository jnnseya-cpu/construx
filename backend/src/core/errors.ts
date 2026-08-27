/**
 * Error semantics. Everything surfaced to a client is rendered as
 * application/problem+json (RFC 7807) by the gateway.
 */
import { config } from '../config.ts';

export type ProblemDetail = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  traceId?: string;
  correlationId?: string;
  errors?: Array<{ field: string; message: string }>;
};

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fieldErrors: Array<{ field: string; message: string }>;

  constructor(code: string, message: string, status = 422, fieldErrors: Array<{ field: string; message: string }> = []) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
    this.fieldErrors = fieldErrors;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string, fieldErrors: Array<{ field: string; message: string }> = []) {
    super('VALIDATION_FAILED', message, 400, fieldErrors);
    this.name = 'ValidationError';
  }
}

export class AuthError extends DomainError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, 401);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Not permitted in this context', code = 'FORBIDDEN') {
    super(code, message, 403);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends DomainError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends DomainError {
  constructor(message: string, code = 'CONFLICT') {
    super(code, message, 409);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends DomainError {
  readonly retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super('RATE_LIMITED', message, 429);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Raised when a wallet cannot fund an AI execution. Halts before any spend. */
export class ACUExhaustedError extends DomainError {
  constructor(message: string) {
    super('ACU_EXHAUSTED', message, 402);
    this.name = 'ACUExhaustedError';
  }
}

/**
 * The base a problem `type` URL is built on.
 *
 * Derived from `PUBLIC_BASE_URL` rather than hardcoded. RFC 7807 says the type
 * should be a URI that documents the problem, so it has to be a domain this
 * deployment actually answers on — a build serving one domain while naming
 * another in every error is telling clients to look somewhere it does not live.
 *
 * This was a literal `https://construxvg.com`, which meant the domain could
 * only be changed by editing source. Two deployments on two domains therefore
 * needed two source trees, and the difference between them was invisible except
 * in the error bodies.
 */
function problemBase(): string {
  try {
    return new URL(config.publicBaseUrl).origin;
  } catch {
    // A malformed PUBLIC_BASE_URL is its own problem, reported elsewhere at
    // boot. An error response is the wrong place to throw a second error.
    return 'about:blank';
  }
}

export function toProblem(error: unknown, instance: string, traceId: string, correlationId: string): ProblemDetail {
  if (error instanceof DomainError) {
    const problem: ProblemDetail = {
      type: `${problemBase()}/problems/${error.code.toLowerCase().replace(/_/g, '-')}`,
      title: error.code,
      status: error.status,
      detail: error.message,
      instance,
      traceId,
      correlationId,
    };
    if (error.fieldErrors.length > 0) problem.errors = error.fieldErrors;
    return problem;
  }
  return {
    type: `${problemBase()}/problems/internal-error`,
    title: 'INTERNAL_ERROR',
    status: 500,
    detail: 'The request could not be completed.',
    instance,
    traceId,
    correlationId,
  };
}
