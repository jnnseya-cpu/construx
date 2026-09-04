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
  if (!current?.refreshToken) {
    // A session with no refresh token cannot be renewed and never will be. It
    // is not "not signed in yet" — it is a stored session that is unusable, and
    // leaving it in place means every future request repeats the same failure.
    if (current) session.clear();
    return null;
  }

  refreshing ??= (async () => {
    try {
      const response = await fetch('/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      if (!response.ok) {
        // The refresh was *refused*, which is final: an expired refresh token,
        // a revoked one, a rotated signing secret, or a token minted by a build
        // whose issuer string has since changed. Whatever the reason, this
        // stored session can never work again.
        //
        // Found by somebody being unable to sign in at all. The issuer moved
        // from `construx.ai` to `construxvg.com`; both builds default to the
        // same JWT secret, so an old token passed the signature check and
        // failed the issuer check — and nothing cleared it. Every page load
        // repeated the same refusal for ever, with no way out but clearing
        // browser storage by hand.
        //
        // Cleared here rather than at each call site, because the call site
        // that forgets is the one that traps somebody.
        session.clear();
        return null;
      }
      const tokens = await response.json();
      session.set({ ...session.get(), accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      return tokens.accessToken;
    } catch {
      // A network failure is not a refusal. The session may be perfectly good
      // and the browser simply offline, and clearing it here would sign a site
      // operative out for driving through a tunnel.
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

/**
 * Whether a stored access token has lapsed, or is about to.
 *
 * Read from the token's own `exp` claim — no request is made. A token that has
 * expired is refused by the gateway before routing, and a console left open past
 * the fifteen-minute access lifetime used to discover that on its next page
 * load: a dozen parallel requests, every one refused, then one refresh and every
 * one retried. Each of those refusals counted as a failed authentication on the
 * operator's watch, and the operator was woken for "14 of 29 requests failed
 * authentication". Refreshing *before* sending a token known to be stale means
 * the refusals never happen. Thirty seconds of margin covers clock skew and the
 * time a request spends in flight.
 */
function expiresSoon(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now() + 30_000;
  } catch {
    // Not a JWT this code can read. Send it and let the gateway decide.
    return false;
  }
}

/** The access token to send: refreshed first where it is known to be stale. */
async function freshToken() {
  const token = session.get()?.accessToken;
  if (token && expiresSoon(token)) return (await rotate()) ?? token;
  return token;
}

async function request(method, path, body, options = {}) {
  // Retrying a command must not create a second one, so the idempotency key is
  // fixed before the first attempt and reused across the refresh retry.
  const attempt = { ...options, idempotencyKey: method === 'GET' ? undefined : crypto.randomUUID() };

  let response = await send(method, path, body, attempt, await freshToken());

  if (response.status === 401 && !options.anonymous) {
    const token = await rotate();
    if (token) response = await send(method, path, body, attempt, token);
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    noticeEnrolmentRequired(payload, response.status);
    throw new ApiError(payload, response.status);
  }
  return payload;
}

/**
 * A session the organisation holds to enrolment. The gateway refuses every
 * route but Security's with `MFA_ENROLMENT_REQUIRED`, and a page that asked
 * for eight positions would otherwise paint eight refusals and leave the
 * person reading "outside your role" on a screen they cannot use. The shell
 * registers a guard that takes them to Security instead; this only notices.
 */
let enrolmentGuard = null;

export function setEnrolmentGuard(guard) {
  enrolmentGuard = guard;
}

function noticeEnrolmentRequired(payload, status) {
  if (status === 403 && payload?.title === 'MFA_ENROLMENT_REQUIRED') enrolmentGuard?.(payload);
}

/**
 * Fetch a file and hand it to the browser to save.
 *
 * Separate from `request` because the response is bytes, not JSON — parsing a
 * PDF as JSON throws on the first byte, and a failure that reads as a syntax
 * error tells nobody what went wrong. A refusal still arrives as problem+json,
 * so that path is read as JSON and surfaced as the denial it is.
 */
async function download(path, body, options = {}) {
  const attempt = { ...options, idempotencyKey: crypto.randomUUID() };
  let response = await send('POST', path, body ?? {}, attempt, await freshToken());

  if (response.status === 401 && !options.anonymous) {
    const token = await rotate();
    if (token) response = await send('POST', path, body ?? {}, attempt, token);
  }

  if (!response.ok) {
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    noticeEnrolmentRequired(payload, response.status);
    throw new ApiError(payload, response.status);
  }

  // The filename the platform chose, which is the document's own reference.
  // Falling back to the route name would put "report.pdf" in every downloads
  // folder and make two of them indistinguishable.
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'document.pdf';

  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return { filename };
}

/**
 * Send a file as bytes.
 *
 * Not `request`, because a file is not JSON: base64 inside an envelope would
 * inflate a 50MB photograph to 67MB of text and hand the whole thing to a JSON
 * parser at each end. The refusal path is still problem+json, so a denial reads
 * as a denial rather than as a parse error.
 */
async function upload(path, file, options = {}) {
  const key = crypto.randomUUID();

  const attempt = async (token) =>
    fetch(path, {
      method: 'POST',
      headers: {
        // Whatever the operating system says the file is. The platform stores
        // it as a label and never trusts it — the address is the hash.
        'Content-Type': file.type || 'application/octet-stream',
        'Idempotency-Key': key,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: file,
    });

  let response = await attempt(await freshToken());
  if (response.status === 401 && !options.anonymous) {
    const token = await rotate();
    if (token) response = await attempt(token);
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new ApiError(payload, response.status);
  return payload;
}

/** SHA-256 of a file, in the form the ledger records. */
export async function hashFile(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  /** A position read gated on the capability area, and sensitivity, it belongs to. */
  read: (path, area, sensitivity) => read(path, area, sensitivity),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  put: (path, body, options) => request('PUT', path, body ?? {}, options),
  // No body. The one DELETE the console issues cancels an erasure request, and
  // the route's schema is a closed empty object — it refuses a stray body
  // rather than ignoring one.
  delete: (path, options) => request('DELETE', path, undefined, options),
  download,
  upload,
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

/**
 * Whether the current identity may read a record type, decided before asking.
 *
 * Installed by the shell once the permission matrix and the entity
 * classification have loaded. A screen bundling twelve record types for a
 * planner used to make twelve requests, be refused nine, and handle every
 * refusal correctly — while the browser console filled with nine red lines that
 * read, to anybody who opened it, as a broken screen. The refusal is the same
 * either way. With the classification the API already publishes, it is decided
 * here and the request is never made.
 *
 * Returns `{ reason }` to withhold, or `null` to ask the server. Absent (before
 * the matrix loads) or unsure (an unclassified type), the answer is to ask —
 * the server is authoritative, and this guard can only ever narrow what is
 * requested, never widen what is returned.
 */
let readGuard = null;

export function setEntityReadGuard(guard) {
  readGuard = typeof guard === 'function' ? guard : null;
}

/**
 * The same decision for a position read.
 *
 * A screen names the capability area each engine position belongs to — the
 * area the server's own `authorise` call checks — and, where the position is
 * commercial-in-confidence or legal, its data sensitivity. The shell answers
 * both from the published matrix. Where the role does not hold read on the
 * area, or is not cleared for the sensitivity, the request is never sent and
 * the caller receives exactly the refusal the server would have returned: an
 * `ApiError` with status 403, so every existing `.catch` on these reads
 * behaves as before. Where the matrix is not yet loaded or the role is cleared,
 * the server is asked and decides.
 *
 * Returns the reason to withhold, or `null` to ask.
 */
let areaGuard = null;

export function setAreaReadGuard(guard) {
  areaGuard = typeof guard === 'function' ? guard : null;
}

/** The refusal the server would have sent, raised here instead. */
function refused(reason) {
  return Promise.reject(new ApiError({ title: 'ACCESS_DENIED', status: 403, detail: reason }, 403));
}

function read(path, area, sensitivity) {
  const reason = area || sensitivity ? areaGuard?.(area, sensitivity) : null;
  if (reason) return refused(reason);
  return request('GET', path, undefined, undefined);
}

/**
 * Materialised entities of a type within a project.
 *
 * Decided before asking, where the published classification lets it be — the
 * same guard `entityBundle` applies, so a screen reading one type directly is
 * refused in the same place and the same way as one bundling twelve. The
 * refusal is the `ApiError` the server would have sent, so a caller's `.catch`
 * sees no difference.
 */
export async function entities(projectId, refType) {
  const held = readGuard?.(refType);
  if (held) return refused(held.reason);
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
      // `entities` decides before asking where the published classification
      // lets it, and raises the same refusal the server would have. The record
      // of the withholding is therefore identical whichever path produced it,
      // and the shell's "N record types withheld from your role" reads the same.
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
