import { request as httpRequest } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

/**
 * The one way this platform talks to an AI vendor.
 *
 * ## Why not `fetch`
 *
 * Because `fetch` has a clock the platform did not choose and cannot turn off.
 * Node's implementation aborts a request if response headers have not arrived
 * within 300 seconds, and again if the body stalls for 300 seconds. Neither
 * limit is configurable through the `fetch` API, and neither is visible
 * anywhere in this codebase — the platform states, in `config.ts` and in
 * `STATE.md`, that **no AI task is cut short by a clock**, sets
 * `AI_PROVIDER_DEADLINE_MS` to 0 to mean exactly that, and attaches no
 * `AbortSignal`. The transport was quietly imposing five minutes anyway.
 *
 * It surfaced on a real tender:
 *
 *     AI_PROVIDER_DROPPED — The connection to api.openai.com dropped after the
 *     request had gone out (UND_ERR_HEADERS_TIMEOUT …)
 *
 * A non-streaming completion sends no headers until the model has finished
 * writing, so every call that genuinely needs more than five minutes — a long
 * reasoning run over part of an invitation, a take-off across a drawing set —
 * was killed at the five-minute mark. The work had been done at the vendor's
 * end and billed for; the platform threw it away and parked the hold.
 *
 * `node:https` imposes no such deadline. A deadline is applied here only when
 * the operator has configured one, which is what the rule always said.
 *
 * ## What else it buys
 *
 * A request made here **knows** what happened to it, where `fetch` leaves the
 * caller guessing from an error code:
 *
 *   - `sent` — the request body was fully written to the socket.
 *   - `responded` — a status line came back.
 *
 * That is the difference between "the vendor never saw this, retry it safely"
 * and "the vendor may have answered and billed, park the hold" — a question
 * worth real money, previously answered from a table of error codes.
 */

/** A vendor's answer, read whole. Status is the vendor's, never interpreted here. */
export type VendorReply = {
  status: number;
  ok: boolean;
  text: string;
};

/**
 * A call that produced no answer, and what is known about how far it got.
 *
 * `cause` is the underlying socket, DNS or TLS error, kept so the diagnosis
 * can name the syscall and the code rather than saying "it failed".
 */
export class VendorTransportError extends Error {
  readonly sent: boolean;
  readonly responded: boolean;
  readonly timedOut: boolean;

  constructor(message: string, detail: { sent: boolean; responded: boolean; timedOut: boolean; cause?: unknown }) {
    super(message, detail.cause === undefined ? undefined : { cause: detail.cause });
    this.name = detail.timedOut ? 'TimeoutError' : 'VendorTransportError';
    this.sent = detail.sent;
    this.responded = detail.responded;
    this.timedOut = detail.timedOut;
  }
}

/**
 * The most of a vendor's reply that will be read.
 *
 * A reply is bounded by the model's own output ceiling, so this is not a limit
 * anybody should reach; it is here because a reply is somebody else's bytes and
 * reading them into memory without a bound is how one bad response takes the
 * process down.
 */
const MAX_REPLY_BYTES = 64 * 1_048_576;

/**
 * How often to prove the connection is still there while waiting.
 *
 * A model thinking for ten minutes sends nothing in that time, and an idle TCP
 * connection through a NAT or a load balancer is a connection something else
 * may decide to forget. Keep-alive probes make the wait visible to the network
 * rather than silent.
 */
const KEEPALIVE_MS = 15_000;

export async function postJson(input: {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Milliseconds of total silence to allow. **0 means no deadline at all.** */
  deadlineMs: number;
}): Promise<VendorReply> {
  const target = new URL(input.url);
  const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const payload = Buffer.from(input.body, 'utf8');

  const options: RequestOptions = {
    method: 'POST',
    hostname: target.hostname,
    ...(target.port === '' ? {} : { port: Number(target.port) }),
    path: `${target.pathname}${target.search}`,
    headers: { ...input.headers, 'content-length': String(payload.byteLength) },
  };

  return new Promise<VendorReply>((resolve, reject) => {
    let sent = false;
    let responded = false;
    let settled = false;

    const fail = (error: unknown, timedOut = false): void => {
      if (settled) return;
      settled = true;
      reject(
        new VendorTransportError(`${target.host}: ${(error as Error)?.message ?? String(error)}`, {
          sent,
          responded,
          timedOut,
          cause: error,
        }),
      );
    };

    const call = send(options, (response) => {
      responded = true;
      const pieces: Buffer[] = [];
      let held = 0;
      response.on('data', (chunk: Buffer) => {
        held += chunk.length;
        if (held > MAX_REPLY_BYTES) {
          response.destroy();
          fail(new Error(`the reply exceeded ${Math.round(MAX_REPLY_BYTES / 1_048_576)}MB and was abandoned`));
          return;
        }
        pieces.push(chunk);
      });
      response.on('aborted', () => fail(Object.assign(new Error('the connection closed before the reply finished'), { code: 'ECONNRESET' })));
      response.on('error', (error) => fail(error));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const status = response.statusCode ?? 0;
        resolve({ status, ok: status >= 200 && status < 300, text: Buffer.concat(pieces).toString('utf8') });
      });
    });

    // The connection, kept visibly alive through whatever is between this
    // process and the vendor while a model thinks.
    call.on('socket', (socket) => socket.setKeepAlive(true, KEEPALIVE_MS));

    /*
     * A deadline only where the operator asked for one.
     *
     * `setTimeout` here is inactivity on the socket, not total elapsed time,
     * which is the right shape for this rule: a model that is streaming an
     * answer slowly is working, and a connection that has gone quiet for the
     * configured period is not.
     */
    if (input.deadlineMs > 0) {
      call.setTimeout(input.deadlineMs, () => {
        call.destroy();
        fail(new Error(`no answer within ${input.deadlineMs}ms`), true);
      });
    }

    call.on('error', (error) => fail(error));
    call.end(payload, () => {
      sent = true;
    });
  });
}
