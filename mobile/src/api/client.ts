/**
 * The API client.
 *
 * The same gateway the console talks to, with the same auth. §A1: "one RBAC+ABAC
 * policy set, evaluated at the gateway" — this client adds no authorisation of
 * its own and must not appear to.
 *
 * Three things it does that a plain fetch wrapper does not, and each one exists
 * because of a specific failure on a bad connection.
 *
 * **The idempotency key is the caller's, not the client's.** It is minted with
 * the command, stored in the outbox, and reused on every retry. A client that
 * generated one per request would turn a dropped response into a duplicate
 * record — precisely the case retrying exists for.
 *
 * **A 409 is data, not an error.** §15.1 returns the current version and the
 * resolutions the server will accept. Throwing it away and surfacing "conflict"
 * leaves the device unable to offer the user any of the choices the platform
 * just listed.
 *
 * **A timeout is not a failure.** The request may have been applied. The caller
 * is told `AWAITING_RECEIPT`, not `REJECTED`, because the difference decides
 * whether retrying is safe and whether the person is told their record is lost.
 */

export type ProblemDetail = {
  type?: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  traceId?: string;
  correlationId?: string;
  errors?: Array<{ field: string; message: string }>;
  /** Present on a 409. §15.1. */
  currentVersion?: number;
  permittedResolutions?: string[];
};

export type Outcome<T> =
  | { kind: 'OK'; value: T; status: number; correlationId?: string }
  | { kind: 'CONFLICT'; problem: ProblemDetail }
  | { kind: 'REJECTED'; problem: ProblemDetail }
  | { kind: 'UNAUTHORISED'; problem: ProblemDetail }
  | { kind: 'REVOKED'; problem: ProblemDetail }
  /** Sent, outcome unknown. Retry with the same key. */
  | { kind: 'UNKNOWN'; reason: string };

export type ClientOptions = {
  baseUrl: string;
  /** Resolves the current access token, refreshing it if needed. */
  token: () => Promise<string | undefined>;
  /** Proof of the enrolled device, per request. */
  deviceProof?: () => Promise<{ deviceId: string; proof: string } | undefined>;
  installationId: string;
  appBuild: string;
  timeoutMs?: number;
};

export type Request = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  /** Required on every material write. Minted with the command, never regenerated. */
  idempotencyKey?: string;
  correlationId?: string;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 20_000;

export class ApiClient {
  readonly #options: ClientOptions;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  async send<T>(request: Request): Promise<Outcome<T>> {
    const token = await this.#options.token();
    const device = await this.#options.deviceProof?.();

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Installation-Id': this.#options.installationId,
      'X-App-Build': this.#options.appBuild,
    };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
    if (request.correlationId) headers['X-Correlation-Id'] = request.correlationId;
    if (device) {
      headers['X-Device-Id'] = device.deviceId;
      headers['X-Device-Proof'] = device.proof;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (request.signal) request.signal.addEventListener('abort', () => controller.abort(), { once: true });

    let response: Response;
    try {
      response = await fetch(`${this.#options.baseUrl}${request.path}`, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      // The request may or may not have been applied. Saying "failed" here is
      // the lie that turns a retry into a duplicate or a lost record into a
      // silently accepted one.
      return { kind: 'UNKNOWN', reason: error instanceof Error ? error.message : 'The request did not complete' };
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 204) {
      return { kind: 'OK', value: undefined as T, status: 204 };
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (response.ok) {
      return {
        kind: 'OK',
        value: parsed as T,
        status: response.status,
        ...(response.headers.get('x-correlation-id')
          ? { correlationId: response.headers.get('x-correlation-id') as string }
          : {}),
      };
    }

    const problem = problemFrom(parsed, response.status, text);

    // 5xx and 429 are "unknown", not "rejected": the platform did not refuse the
    // command, it failed to answer, and the command stays queued for a retry
    // under the same key.
    if (response.status >= 500 || response.status === 429) {
      return { kind: 'UNKNOWN', reason: problem.detail ?? problem.title };
    }
    if (response.status === 409) return { kind: 'CONFLICT', problem };
    if (response.status === 401) return { kind: 'UNAUTHORISED', problem };
    // 403 with a scope-shaped reason means access went away, which is a
    // quarantine rather than a correction the user can make.
    if (response.status === 403) {
      const revoked = /revoked|no longer|not on this project|scope/i.test(problem.detail ?? problem.title);
      return revoked ? { kind: 'REVOKED', problem } : { kind: 'REJECTED', problem };
    }
    return { kind: 'REJECTED', problem };
  }
}

function problemFrom(parsed: unknown, status: number, raw: string): ProblemDetail {
  if (parsed && typeof parsed === 'object' && 'title' in parsed) {
    return { status, ...(parsed as Record<string, unknown>) } as ProblemDetail;
  }
  return {
    title: `HTTP_${status}`,
    status,
    // Truncated: a body that is not problem+json is usually a proxy's HTML, and
    // putting a page of it in a device log is how evidence-bearing responses
    // end up in a diagnostic bundle.
    detail: raw.slice(0, 300) || 'The platform returned no detail.',
  };
}
