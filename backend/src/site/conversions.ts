import { createHash } from 'node:crypto';
import { config } from '../config.ts';
import { measurementIds } from './analytics.ts';

/**
 * The Meta Conversions API: the conversions the pixel cannot see.
 *
 * ## Why this exists
 *
 * `site/analytics.ts` runs the pixel on the public site and deliberately not
 * inside `/app`, because a page view from there would hand an advertising
 * network a customer's commercial position — which projects they run and how
 * fast they are moving. That decision is right and it has a cost: the click to
 * the signup form is the last thing the browser can measure, and the event that
 * actually matters — a verified registration becoming a tenancy — happens on
 * this side, where no pixel runs.
 *
 * So every ad reports worse than it performed. The account is then optimised
 * against a number missing its own conversions, which is worse than having no
 * number at all: it is confidently wrong, and it spends money in the direction
 * of the error.
 *
 * Sending the same event from here fixes that, and is more accurate than a
 * browser would have been in any case — unaffected by ad blockers, by Safari's
 * storage limits, and by somebody closing the tab before a beacon fires.
 *
 * ## The four rules this module is built on
 *
 * **1. Consent decides, and consent was given in a browser.** A server has no
 * special permission. Measurement cookies and ad-network conversions are not
 * necessary to provide the service, so under UK GDPR and PECR they need consent
 * — and consent given to the pixel is the same consent this needs. The decision
 * is therefore captured at registration and carried on the record;
 * `send` refuses anything whose registration did not carry it. There is no
 * configuration flag that overrides this, because there should not be one.
 *
 * **2. Only hashed identifiers leave.** Meta's matching takes SHA-256 of a
 * normalised email, and that is all this sends of a person. No name, no
 * organisation, no package, no amount, no project. The conversion is the fact
 * that somebody converted; everything else is the customer's business.
 *
 * **3. A failure here must never reach the customer.** This runs after the
 * tenancy exists and the person is already signed in. A network error, a
 * refused token, an outage at Meta — none of them may fail a registration that
 * has already succeeded, so every path is caught, nothing is thrown, and the
 * failure is recorded for an operator instead of shown to a buyer.
 *
 * **4. The browser and this must agree on the event id.** When the pixel does
 * fire for the same person, Meta sees two events and counts one, but only if
 * both carry the same `event_id`. The registration id is used, which is
 * deterministic, already unique, and is not a secret — it identifies a signup,
 * not a person.
 *
 * ## What is deliberately not here
 *
 * No retry queue. A conversion is worth sending once, promptly; a queue that
 * replays conversions days later reports them against the wrong attribution
 * window and distorts the thing it is trying to measure. Failures are counted
 * and named on the growth position so an operator can see a broken token, which
 * is the fault worth acting on. A single dropped event is not.
 */

/** Which conversion. Meta's standard names — a custom name optimises against nothing. */
export type ConversionEvent = 'CompleteRegistration' | 'Subscribe';

export type ConversionOutcome = {
  event: ConversionEvent;
  /** `SENT` reached Meta and was accepted. Everything else is named for the operator. */
  state: 'SENT' | 'NOT_CONFIGURED' | 'NO_CONSENT' | 'REFUSED' | 'UNREACHABLE';
  at: string;
  because: string;
  /** Meta's own count of events received, when it answered. */
  received?: number;
};

export type ConversionInput = {
  event: ConversionEvent;
  /** The address the registration proved. Hashed here; never sent in the clear. */
  email: string;
  /** The registration id, shared with the browser so Meta counts one conversion. */
  eventId: string;
  /** Whether the person accepted measurement. False or absent refuses the send. */
  consented: boolean;
  /** When the conversion happened, not when this ran. */
  at?: Date;
  /** From the request that caused it, where the caller has them. Improves matching. */
  clientIp?: string;
  userAgent?: string;
  /** The page the signup came from, if known. No query string — it carries tokens. */
  sourceUrl?: string;
};

/** Whether a conversion could be sent at all: a dataset, a token and a pixel. */
export function conversionsConfigured(): boolean {
  return config.analytics.metaCapiToken !== '' && datasetId() !== '';
}

/**
 * The dataset to post to.
 *
 * Empty `ANALYTICS_META_DATASET_ID` means the pixel id. Events Manager shows
 * the same number for both on a dataset created from a pixel, which is the
 * common case, so one variable covers most deployments and the second exists
 * only for the deployments where they differ.
 */
export function datasetId(): string {
  const explicit = config.analytics.metaDatasetId.trim();
  if (/^[0-9]{1,32}$/.test(explicit)) return explicit;
  return measurementIds().meta;
}

/**
 * SHA-256 of the address, normalised the way Meta normalises before it hashes.
 *
 * Lower-cased and trimmed, and nothing else. The temptation is to go further —
 * stripping dots from Gmail addresses, cutting `+` tags — and it is wrong:
 * Meta hashes what it was given by the advertiser's other sources too, and a
 * normalisation only this side performs produces a hash that matches nothing.
 */
export function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest('hex');
}

/** The last outcome per event, so a screen can show what happened without re-sending. */
const last = new Map<ConversionEvent, ConversionOutcome>();

export function lastConversion(event: ConversionEvent): ConversionOutcome | undefined {
  return last.get(event);
}

export function conversionPosition(): ConversionOutcome[] {
  return [...last.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** Test isolation only. A deployment does not forget what it sent. */
export function resetConversions(): void {
  last.clear();
}

function remember(outcome: ConversionOutcome): ConversionOutcome {
  last.set(outcome.event, outcome);
  return outcome;
}

/**
 * Send one conversion, and never throw.
 *
 * Returns what happened rather than a boolean, because "we are not configured",
 * "they declined" and "Meta refused the token" are three different situations
 * with three different remedies, and a caller that only knows "it did not send"
 * can act on none of them.
 */
export async function sendConversion(
  input: ConversionInput,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<ConversionOutcome> {
  const at = now.toISOString();

  if (!conversionsConfigured()) {
    return remember({
      event: input.event,
      state: 'NOT_CONFIGURED',
      at,
      because:
        'No Conversions API token or dataset on this deployment, so conversions are reported by the browser only ' +
        'and the ones that happen inside the console are not reported at all.',
    });
  }

  // Rule 1, and it is the first thing checked rather than the last. A send that
  // happens and is then regretted cannot be unsent.
  if (!input.consented) {
    return remember({
      event: input.event,
      state: 'NO_CONSENT',
      at,
      because: 'The person did not accept measurement, so nothing about them is sent to an advertising network.',
    });
  }

  const body = {
    data: [
      {
        event_name: input.event,
        event_time: Math.floor((input.at ?? now).getTime() / 1000),
        // The id the browser would have used for the same conversion. Meta sees
        // two and counts one.
        event_id: input.eventId,
        action_source: 'website',
        ...(input.sourceUrl ? { event_source_url: input.sourceUrl } : {}),
        user_data: {
          em: [hashEmail(input.email)],
          // Not hashed, by Meta's specification: both are transport facts about
          // the request rather than identifiers of a person, and hashing them
          // would match nothing.
          ...(input.clientIp ? { client_ip_address: input.clientIp } : {}),
          ...(input.userAgent ? { client_user_agent: input.userAgent } : {}),
        },
      },
    ],
    ...(config.analytics.metaTestEventCode ? { test_event_code: config.analytics.metaTestEventCode } : {}),
  };

  const url =
    `https://graph.facebook.com/${encodeURIComponent(config.analytics.metaGraphVersion)}/` +
    `${encodeURIComponent(datasetId())}/events`;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The token travels as a header rather than in the query string, where
        // it would be written to every proxy log between here and Meta.
        authorization: `Bearer ${config.analytics.metaCapiToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    if (!response.ok) {
      // Meta's own message, trimmed. It is specific — an expired token and a
      // wrong dataset read very differently — and paraphrasing it would cost
      // the operator the one useful sentence.
      let detail = '';
      try {
        const problem = (await response.json()) as { error?: { message?: string } };
        detail = typeof problem.error?.message === 'string' ? problem.error.message.slice(0, 300) : '';
      } catch {
        detail = '';
      }
      return remember({
        event: input.event,
        state: 'REFUSED',
        at,
        because:
          `Meta answered ${response.status} and did not record the conversion` +
          `${detail ? `: ${detail}` : '.'} The token, the dataset or the permission on it is wrong.`,
      });
    }

    let received: number | undefined;
    try {
      const answer = (await response.json()) as { events_received?: number };
      received = typeof answer.events_received === 'number' ? answer.events_received : undefined;
    } catch {
      received = undefined;
    }

    return remember({
      event: input.event,
      state: 'SENT',
      at,
      ...(received === undefined ? {} : { received }),
      because:
        `${input.event} reported to dataset ${datasetId()}` +
        `${config.analytics.metaTestEventCode ? ' as a test event, so it does not count' : ''}.`,
    });
  } catch (error) {
    return remember({
      event: input.event,
      state: 'UNREACHABLE',
      at,
      because:
        `graph.facebook.com did not answer: ${error instanceof Error ? error.message : String(error)}. ` +
        'The conversion happened and was not reported; the tenancy is unaffected.',
    });
  }
}

/**
 * Fire and forget, for the callers that must not wait.
 *
 * `verify()` creates a tenancy and returns it to somebody staring at a loading
 * spinner. Reporting a conversion is not worth a second of that, and is
 * certainly not worth failing it — so the promise is deliberately not awaited
 * and its rejection is impossible by construction, because `sendConversion`
 * catches everything.
 */
export function reportConversion(input: ConversionInput): void {
  void sendConversion(input).then((outcome) => {
    if (outcome.state === 'SENT' || outcome.state === 'NO_CONSENT' || outcome.state === 'NOT_CONFIGURED') return;
    process.stderr.write(`[conversions] ${outcome.event} ${outcome.state}: ${outcome.because}\n`);
  });
}
