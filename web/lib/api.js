/**
 * API client.
 *
 * The application talks to exactly the same public API as any other consumer —
 * it holds no privileged path into the platform, and is subject to the same
 * RBAC, scopes and ABAC. A 403 here is a real authorisation decision, and the
 * UI surfaces the reason rather than hiding the control.
 */

const TOKEN_KEY = 'construx.session';

export const session = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  set(value) {
    localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
  },
};

/** Raised for any non-2xx response, carrying the problem+json detail. */
export class ApiError extends Error {
  constructor(problem, status) {
    super(problem?.detail || problem?.title || `Request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem?.title;
    this.problem = problem;
    this.fieldErrors = problem?.errors ?? [];
  }
}

/**
 * Access tokens are short-lived. One refresh runs at a time and every request
 * that hit the same expiry waits on it, rather than each firing its own
 * rotation and invalidating the others.
 */
let refreshing = null;

async function rotate() {
  const current = session.get();
  if (!current?.refreshToken) return null;

  refreshing ??= (async () => {
    try {
      const response = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) return null;
      const tokens = await response.json();
      session.set({ ...session.get(), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      return tokens.accessToken;
    } catch {
      return null;
    } finally {
      // Cleared on the next tick so concurrent callers all read this result.
      queueMicrotask(() => {
        refreshing = null;
      });
    }
  })();

  return refreshing;
}

async function send(method, path, body, options, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token && !options.anonymous) headers.Authorization = `Bearer ${token}`;
  // Commands are retried by users far more often than anyone admits.
  if (method !== 'GET') headers['Idempotency-Key'] = options.idempotencyKey ?? crypto.randomUUID();

  return fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function request(method, path, body, options = {}) {
  // Retrying a command must not create a second one, so the idempotency key is
  // fixed before the first attempt and reused across the refresh retry.
  const attempt = { ...options, idempotencyKey: method === 'GET' ? undefined : crypto.randomUUID() };

  let response = await send(method, path, body, attempt, session.get()?.accessToken);

  if (response.status === 401 && !options.anonymous) {
    const token = await rotate();
    if (token) response = await send(method, path, body, attempt, token);
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) throw new ApiError(payload, response.status);
  return payload;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  put: (path, body, options) => request('PUT', path, body ?? {}, options),
};

// --- domain helpers ---------------------------------------------------------

/**
 * Records withheld from the current role during this render.
 *
 * A denial is not the same as an empty record, and showing "nothing recorded
 * yet" when the real answer is "you may not see this" would misrepresent the
 * project. The shell reads this after a view renders and says so.
 */
const withheld = new Map();

export function resetWithheld() {
  withheld.clear();
}

export function withheldRecords() {
  return [...withheld.entries()].map(([refType, reason]) => ({ refType, reason }));
}

/** Was this record type refused during the current render? */
export function isWithheld(refType) {
  return withheld.has(refType);
}

/** Materialised entities of a type within a project. */
export async function entities(projectId, refType) {
  const result = await api.get(`/v1/projects/${projectId}/entities/${refType}`);
  return result.entities.map((e) => ({ ...e.state, _refId: e.refId, _version: e.version, _hash: e.stateHash }));
}

/** The most recent entity of a type, or undefined. */
export async function latest(projectId, refType) {
  const list = await entities(projectId, refType);
  return list[list.length - 1];
}

/**
 * Several entity types in one round of requests. A type the role may not read
 * comes back empty and is recorded as withheld rather than failing the page —
 * most screens are legitimately partial for some roles.
 */
export async function entityBundle(projectId, refTypes) {
  const results = await Promise.all(
    refTypes.map((refType) =>
      entities(projectId, refType).catch((error) => {
        if (error instanceof ApiError && error.status === 403) {
          withheld.set(refType, error.message);
        }
        return [];
      }),
    ),
  );
  return Object.fromEntries(refTypes.map((t, i) => [t, results[i]]));
}
