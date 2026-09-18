import { config } from '../config.ts';

/**
 * Does `PUBLIC_BASE_URL` actually reach this process?
 *
 * ## Why this exists
 *
 * Reported twice, as two unrelated-looking faults with one cause.
 *
 * An invitation email arrived and its link would not open — *"This site can't
 * provide a secure connection, ERR_SSL_PROTOCOL_ERROR"*. And the payments
 * screen told an operator to *"check the endpoint URL in the provider's
 * dashboard against https://www.construxvg.com"*, a host that answered nothing.
 *
 * Both are `PUBLIC_BASE_URL`. It is the origin every email link is built from,
 * the origin the webhook guidance quotes, and the origin a payment redirect
 * returns to — and nothing had ever checked that it resolves, terminates TLS,
 * or belongs to this deployment rather than a previous one. A base URL naming a
 * subdomain with no DNS record, or one the proxy holds no certificate for, is
 * accepted in silence: it is only a string until somebody clicks it, and the
 * person who clicks it is a customer.
 *
 * ## What it checks
 *
 * One request to `${PUBLIC_BASE_URL}/readyz`, whose body carries the commit the
 * answering process is running. Four things can be wrong and they have
 * different remedies, so they are four states rather than one boolean:
 *
 * - the host does not resolve or refuses the connection — a missing DNS record,
 *   most often a `www.` that was never created;
 * - TLS fails — the certificate does not cover this hostname, which is the
 *   `ERR_SSL_PROTOCOL_ERROR` a customer sees;
 * - it answers, but as a different build — the URL points at another
 *   deployment, so links in this one's emails land in that one;
 * - it answers as this build — correct.
 *
 * ## What it is not
 *
 * Not a liveness check; `/readyz` already is one, and this is the opposite
 * direction — out through DNS, the proxy and the certificate, and back. It runs
 * on demand from the operator's own screen rather than on a timer: it is a
 * deployment fact that changes when somebody changes DNS, and polling it would
 * put this deployment's front door under load from inside.
 */

export type SelfReachState =
  | 'NOT_CONFIGURED'
  | 'LOCAL'
  | 'UNRESOLVED'
  | 'TLS_FAILED'
  | 'NOT_READY'
  | 'OTHER_BUILD'
  | 'REACHED';

export type SelfReach = {
  state: SelfReachState;
  /** The origin every email link, webhook URL and payment redirect is built from. */
  baseUrl: string;
  ok: boolean;
  because: string;
  remedy?: string;
  /** The commit this process runs, and the one that answered, when they differ. */
  thisBuild: string;
  answeredBy?: string;
  checkedAt: string;
};

const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1$)/i;

/**
 * Whether a failed fetch was the certificate rather than the network.
 *
 * Node reports TLS faults as an error `code` on the cause, and the distinction
 * decides the remedy: a name that does not resolve needs a DNS record, a name
 * whose certificate does not cover it needs the proxy to be issued one. Telling
 * an operator to "check DNS" when DNS is fine costs an afternoon.
 */
function isTlsFailure(error: unknown): boolean {
  const code = String((error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code ?? '');
  return code.startsWith('ERR_TLS') || code.startsWith('DEPTH_ZERO') || code.startsWith('UNABLE_TO_VERIFY') ||
    code === 'CERT_HAS_EXPIRED' || code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'HOSTNAME_MISMATCH' || code === 'ERR_TLS_CERT_ALTNAME_INVALID';
}

export async function checkSelfReach(
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<SelfReach> {
  const baseUrl = config.publicBaseUrl.replace(/\/+$/, '');
  const thisBuild = config.buildCommit || 'unknown';
  const checkedAt = now.toISOString();
  const base = { baseUrl, thisBuild, checkedAt };

  if (baseUrl === '') {
    return {
      ...base,
      state: 'NOT_CONFIGURED',
      ok: false,
      because: 'PUBLIC_BASE_URL is unset, so every link this platform puts in an email is relative and cannot be opened.',
      remedy: 'Set PUBLIC_BASE_URL to the origin customers reach this deployment on, including the scheme, and redeploy.',
    };
  }

  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch {
    return {
      ...base,
      state: 'NOT_CONFIGURED',
      ok: false,
      because: `PUBLIC_BASE_URL is "${baseUrl}", which is not a URL.`,
      remedy: 'Set it to an absolute origin such as https://example.com — scheme included, no trailing path.',
    };
  }

  // A development machine is not misconfigured for pointing at itself, and
  // there is nothing useful to say about whether localhost resolves.
  if (LOCAL.test(host)) {
    return {
      ...base,
      state: 'LOCAL',
      ok: true,
      because: `PUBLIC_BASE_URL is ${baseUrl}, which is this machine. Links in email will only work for somebody sitting at it.`,
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/readyz`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
      redirect: 'follow',
    });
  } catch (error) {
    const tls = isTlsFailure(error);
    return {
      ...base,
      state: tls ? 'TLS_FAILED' : 'UNRESOLVED',
      ok: false,
      because: tls
        ? `${host} is reachable but its TLS certificate is not valid for it. This is the "ERR_SSL_PROTOCOL_ERROR" a customer ` +
          'sees when they open an invitation link.'
        : `Nothing answered at ${host}. Every invitation, password reset and notification this platform sends carries a link ` +
          'to that host, and every one of them is dead.',
      remedy: tls
        ? `Issue a certificate covering ${host} — a proxy that obtains them automatically still needs the hostname in its ` +
          'site block, and a certificate for the bare domain does not cover a subdomain. Then reload the proxy.'
        : `Check that ${host} has a DNS record pointing at this deployment. A PUBLIC_BASE_URL naming a "www." host is the ` +
          'usual cause: the bare domain resolves and the www one was never created. Either add the record or set ' +
          'PUBLIC_BASE_URL to the host that does resolve.',
    };
  }

  let answeredBy: string | undefined;
  try {
    const body = (await response.json()) as { commit?: string };
    answeredBy = typeof body.commit === 'string' ? body.commit : undefined;
  } catch {
    answeredBy = undefined;
  }

  if (!response.ok) {
    return {
      ...base,
      state: 'NOT_READY',
      ok: false,
      ...(answeredBy ? { answeredBy } : {}),
      because: `${host} answered ${response.status} on /readyz. Something is serving that hostname, but it is not ready.`,
      remedy:
        'Read /readyz directly for the reasons it gives. If another service holds the hostname, the proxy is routing it ' +
        'somewhere other than this deployment.',
    };
  }

  // The build the answering process runs against the build this one runs. An
  // origin that answers healthily from a different deployment is the failure
  // hardest to see from inside: everything works, and the links go elsewhere.
  if (answeredBy !== undefined && thisBuild !== 'unknown' && answeredBy !== 'unknown' && answeredBy !== thisBuild) {
    return {
      ...base,
      state: 'OTHER_BUILD',
      ok: false,
      answeredBy,
      because: `${host} answers healthily, but as build ${answeredBy} while this process is ${thisBuild}. Links in this ` +
        "deployment's email reach that one.",
      remedy:
        'Either the proxy routes this hostname to another deployment, or this deployment has not been restarted since it ' +
        'was built. Confirm which build should own the hostname before changing anything — one of the two is serving customers.',
    };
  }

  return {
    ...base,
    state: 'REACHED',
    ok: true,
    ...(answeredBy ? { answeredBy } : {}),
    because: `${host} resolves, terminates TLS and answers as this deployment. Links in email, the webhook endpoints and ` +
      'payment redirects all reach this process.',
  };
}
