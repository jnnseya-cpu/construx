import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import {
  FEEDS,
  FEED_CODES,
  feedConfigured,
  feedSettings,
  feedUnavailable,
  type FeedCode,
  type FeedObservation,
} from './registry.ts';

/**
 * Reading an external feed, under authorisation, with the reading on the record.
 *
 * `registry.ts` holds the catalogue and the response mappers as pure functions;
 * this is the governed half — who may read a feed, what leaves the platform,
 * what comes back, and what is written.
 *
 * ## The reading is evidence, not a fact
 *
 * `EXTERNAL_FEED_READ` says *this source said this, at this moment, in response
 * to this request*. It does not say the price is that, and nothing downstream
 * treats it as though it did. A rate on an estimate that cites a reading is
 * still a rate somebody set; a supplier's credit record updated from a reading
 * is still an act on the supply-chain register with an actor's name on it. That
 * separation is the whole reason this is a feed module rather than a set of
 * automatic updates: a third party's number that silently changed a project
 * record would be a change nobody made and nobody could defend.
 *
 * ## What leaves the platform
 *
 * The query, and nothing else. A feed request carries the parameters the caller
 * supplied and the configured credential — never a project name, never a
 * supplier's identifiers beyond what the caller typed, and never a record.
 * `#requestUrl` builds the URL from the configured endpoint plus the query, and
 * the recorded provenance is the **host and path** rather than the full URL,
 * because the query string is where a credential ends up on the APIs that take
 * one that way, and a credential in an append-only ledger is a credential that
 * cannot be redacted afterwards.
 */

export type FeedReading = {
  readingId: string;
  feed: FeedCode;
  /** What was asked, as the caller supplied it. Recorded so a reading is repeatable. */
  query: Record<string, string>;
  observations: FeedObservation[];
  source: {
    /** Host and path only — never the query string, which can carry the credential. */
    endpoint: string;
    /** SHA-256 of the exact bytes the source returned. The reading is checkable against it. */
    responseHash: string;
    responseBytes: number;
    status: number;
    /** How long the source took, which is the first thing to look at when one goes bad. */
    latencyMs: number;
  };
  readAt: string;
  readBy: string;
};

/** Host and path, with the query string dropped. */
function safeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable endpoint)';
  }
}

function requestUrl(endpoint: string, query: Record<string, string>, credential: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new DomainError(
      'FEED_ENDPOINT_INVALID',
      `The configured endpoint is not a URL: ${endpoint.slice(0, 80)}`,
      500,
    );
  }
  for (const [key, value] of Object.entries(query)) parsed.searchParams.set(key, value);
  // A credential in the query only where the endpoint already asks for one that
  // way — `{key}` in the configured URL. Otherwise it rides in the header
  // below, which is where it belongs.
  //
  // Both forms are matched, and that is not defensiveness. `new URL` percent-
  // encodes braces in a *path* but leaves them alone in a *query string*, so
  // `?key={key}` survives literally and `/{key}/prices` arrives as `%7Bkey%7D`.
  // Matching only the encoded form meant the common case never substituted:
  // the vendor was called with the literal string "{key}" as its credential and
  // answered 401, which reads as a bad key rather than as a platform bug.
  if (credential !== '') {
    for (const marker of ['{key}', '%7Bkey%7D']) {
      if (parsed.href.includes(marker)) return parsed.href.replace(marker, encodeURIComponent(credential));
    }
  }
  return parsed.href;
}

/**
 * Read a feed and record what the source said.
 *
 * Refuses, rather than answering, in four cases — and each refusal names what
 * to do about it, because "the feed failed" sends an operator to look at the
 * wrong thing:
 *
 *   - **Nothing configured.** Names the variable.
 *   - **The source refused or was unreachable.** Names the status and the host.
 *   - **The body was not JSON, or was too large.** A feed is a reading; a
 *     megabyte of HTML is a login page, not a price.
 *   - **The body was JSON the mapper could not read.** This is the one that
 *     matters most: a shape change at the vendor produces a valid 200 with
 *     nothing in it, and answering "no observations" as a success would put an
 *     empty reading on the record and let a screen show a blank where a price
 *     used to be.
 */
export async function readFeed(
  ctx: EngineContext,
  input: { feed: FeedCode; query?: Record<string, string> },
): Promise<FeedReading> {
  const definition = FEEDS[input.feed];
  if (!definition) throw new DomainError('NO_SUCH_FEED', `${input.feed} is not a feed this platform reads`, 404);

  authorise(ctx, definition.area, definition.code_);

  const unavailable = feedUnavailable(input.feed);
  if (unavailable) {
    // 501, not 503. Nothing is down and retrying will not help — this
    // deployment has not turned the feed on.
    throw new DomainError('FEED_NOT_CONFIGURED', unavailable, 501);
  }

  const { endpoint, credential } = feedSettings(input.feed);
  const query = input.query ?? {};
  const url = requestUrl(endpoint, query, credential);
  // Whether the endpoint asked for the credential in the URL, decided from the
  // configured endpoint rather than by searching the built URL for the secret —
  // a short credential can occur in a URL by coincidence.
  const urlCarriesCredential = credential !== '' && /\{key\}|%7Bkey%7D/.test(endpoint);
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        // Only where the credential did not already go into the URL. Sending
        // it twice would put it in a vendor's access log as well as its
        // request body, for no gain.
        ...(credential !== '' && !urlCarriesCredential
          ? { Authorization: `Bearer ${credential}` }
          : {}),
      },
      signal: AbortSignal.timeout(config.feeds.timeoutMs),
    });
  } catch (error) {
    const timedOut = (error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError';
    throw new DomainError(
      timedOut ? 'FEED_TIMEOUT' : 'FEED_UNREACHABLE',
      timedOut
        ? `${definition.label} did not answer within ${config.feeds.timeoutMs}ms. Nothing was recorded.`
        : `${definition.label} could not be reached at ${safeEndpoint(endpoint)}: ${String(error)}`,
      timedOut ? 504 : 502,
    );
  }

  const latencyMs = Date.now() - started;
  const raw = await response.text().catch(() => '');

  if (!response.ok) {
    throw new DomainError(
      'FEED_REFUSED',
      `${definition.label} returned ${response.status} from ${safeEndpoint(endpoint)}: ${raw.slice(0, 160)}`,
      502,
    );
  }
  const bytes = Buffer.byteLength(raw);
  if (bytes > config.feeds.maxBytes) {
    throw new DomainError(
      'FEED_RESPONSE_TOO_LARGE',
      `${definition.label} returned ${bytes} bytes; the ceiling is ${config.feeds.maxBytes}. A feed is a reading, ` +
        'not a bulk import, and a body this size is usually an error page.',
      502,
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new DomainError(
      'FEED_NOT_JSON',
      `${definition.label} answered ${response.status} with something that is not JSON. The first bytes were: ` +
        `${raw.slice(0, 120).replace(/\s+/g, ' ')}`,
      502,
    );
  }

  const observations = definition.read(body);
  if (observations.length === 0) {
    // The failure that would otherwise ship. A vendor shape change gives a
    // valid 200 the mapper reads nothing out of, and recording that as a
    // successful empty reading puts a blank on the screen where a price was.
    throw new DomainError(
      'FEED_UNREADABLE',
      `${definition.label} answered ${response.status}, but nothing in the body could be read as a measurement. ` +
        'This usually means the source changed its response shape. Nothing has been recorded.',
      502,
    );
  }

  const reading: FeedReading = {
    readingId: ulid(),
    feed: input.feed,
    query,
    observations,
    source: {
      endpoint: safeEndpoint(endpoint),
      responseHash: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      responseBytes: bytes,
      status: response.status,
      latencyMs,
    },
    readAt: new Date().toISOString(),
    readBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'EXTERNAL_FEED_READ',
    entity: { refType: 'FeedReading', refId: reading.readingId },
    nextState: reading as unknown as Record<string, unknown>,
  });

  return reading;
}

export type FeedPosition = {
  feeds: Array<{
    code: FeedCode;
    label: string;
    answers: string;
    lands: string;
    configured: boolean;
    /** Absent where configured; the sentence naming the variable where not. */
    reason?: string;
    /** Host and path of the configured endpoint. Never the query string. */
    endpoint?: string;
    readings: number;
    lastReadAt?: string;
  }>;
  /** Every reading on this project, newest first. */
  recent: FeedReading[];
};

/**
 * What this deployment can read, and what it has read.
 *
 * Reports the unconfigured feeds too, with the reason. A screen listing only
 * the feeds that work describes a platform with fewer capabilities than it has,
 * and leaves the person who could turn one on unaware there is anything to turn
 * on.
 */
export function feedPosition(ctx: EngineContext): FeedPosition {
  authorise(ctx, 'BUDGET_COST', 'R');

  const readings = ctx.ledger
    .list(ctx.projectId, 'FeedReading')
    .map((record) => record.state as unknown as FeedReading)
    .sort((a, b) => (a.readAt < b.readAt ? 1 : -1));

  return {
    feeds: FEED_CODES.map((code) => {
      const mine = readings.filter((reading) => reading.feed === code);
      const configured = feedConfigured(code);
      return {
        code,
        label: FEEDS[code].label,
        answers: FEEDS[code].answers,
        lands: FEEDS[code].lands,
        configured,
        ...(configured ? { endpoint: safeEndpoint(feedSettings(code).endpoint) } : { reason: feedUnavailable(code)! }),
        readings: mine.length,
        ...(mine[0] ? { lastReadAt: mine[0].readAt } : {}),
      };
    }),
    recent: readings.slice(0, 20),
  };
}
