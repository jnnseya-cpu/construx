import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
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
 * A DNS lookup, then one request to `${PUBLIC_BASE_URL}/readyz`, whose body
 * carries the commit the answering process is running. Several things can be
 * wrong and they have different remedies, so they are separate states rather
 * than one boolean:
 *
 * - the name has no address record at all;
 * - it resolves but nothing answers — the address is wrong, or the proxy is not
 *   listening for that name;
 * - TLS fails — the certificate does not cover this hostname, which is the
 *   `ERR_SSL_PROTOCOL_ERROR` a customer sees;
 * - it answers, but as a different build — the URL points at another
 *   deployment, so links in this one's emails land in that one;
 * - it answers as this build — correct.
 *
 * **The lookup happens first, and it is the reason this is not simply a fetch.**
 * The first version of this inferred the cause from the fetch's error code and
 * then named the likely reason in the remedy: "a `www.` host that was never
 * given a DNS record". On the very deployment that prompted it, that was
 * false — `www.construxvg.com` is a CNAME to a domain with both A and AAAA
 * records, and the fault was a certificate that did not cover the `www` name.
 * The remedy would have sent somebody to the DNS panel for an afternoon.
 * Resolving first turns the cause from a guess into a fact, and the resolved
 * addresses travel on the result so a wrong one is visible rather than deduced.
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
  /** The name has no address record. Nothing can reach it, by anybody. */
  | 'DNS_MISSING'
  /** It resolves, and nothing answered on it. */
  | 'UNREACHABLE'
  /** It resolves and answers, and the certificate does not cover this name. */
  | 'TLS_FAILED'
  /**
   * It answers, and only after sending the browser to a different origin.
   *
   * Healthy on every measure a follow-redirects fetch takes, and wrong for
   * everything derived from the value: WebAuthn compares the origin as an exact
   * string and derives the relying-party id from the same host, so a base URL
   * that redirects is a passkey that cannot be registered or used.
   */
  | 'REDIRECTED'
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
  /**
   * What the hostname resolved to, so a wrong address is visible rather than
   * deduced from a failure. Empty means it resolved to nothing.
   */
  addresses: string[];
  checkedAt: string;
  /**
   * The other form of the same name — `www.` added, or `www.` removed.
   *
   * Absent where there is no sensible other form: a local address, an IP
   * literal, or a lookup that was not asked for.
   */
  sibling?: SiblingReach;
};

/**
 * The hostname nobody configured, which half the world types anyway.
 *
 * `PUBLIC_BASE_URL` is one origin and the check above is about that one. A
 * deployment can pass it completely while `www.` of the same name answers
 * nothing — and that is not a cosmetic gap. Somebody types it, a customer
 * pastes it into a signature, an old card links it, a search result still
 * carries it; and if the platform's own base URL is the `www.` form while the
 * certificate covers only the apex, every blog canonical, every sitemap entry
 * and every emailed link is pointing at a host that refuses the handshake.
 *
 * DNS decides whether the name is expected to work, which avoids a guess this
 * module has no way to make correctly. A name with no address record is a
 * deliberate absence and reported as such. A name that resolves — to this
 * deployment's own address, usually, because somebody added the record years
 * ago — and then does not serve is a dead front door, and it is reported as a
 * fault however healthy `PUBLIC_BASE_URL` is.
 */
export type SiblingReach = {
  /** The origin that was probed. */
  url: string;
  host: string;
  /** `DNS_MISSING` means nobody points this name here. That is a choice, not a fault. */
  state: SelfReachState;
  ok: boolean;
  because: string;
  remedy?: string;
  addresses: string[];
};

const LOCAL = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1$)/i;

/**
 * Whether a failed fetch was the certificate rather than the network.
 *
 * Node reports TLS faults as an error `code` on the cause. Read alongside the
 * lookup rather than instead of it: the codes are indicative, the resolution is
 * evidence, and the two together decide which remedy is printed. Telling an
 * operator to "check DNS" when DNS is fine costs an afternoon.
 */
function isTlsFailure(error: unknown): boolean {
  const code = String((error as { cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code ?? '');
  return code.startsWith('ERR_TLS') || code.startsWith('DEPTH_ZERO') || code.startsWith('UNABLE_TO_VERIFY') ||
    code === 'CERT_HAS_EXPIRED' || code === 'ERR_SSL_WRONG_VERSION_NUMBER' || code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'HOSTNAME_MISMATCH' || code === 'ERR_TLS_CERT_ALTNAME_INVALID';
}

/** Every address the name has, A and AAAA together, or none. */
async function addressesOf(host: string, lookup: Lookup): Promise<string[]> {
  const found = await Promise.all(
    ([4, 6] as const).map(async (family) => {
      try {
        return await lookup(host, family);
      } catch {
        // A family with no record is normal — most names have one or the
        // other. "No addresses at all" is the finding, and it is the caller
        // that draws it, from both families having come back empty.
        return [];
      }
    }),
  );
  return found.flat();
}

/** Injected so the tests can state a resolution rather than depend on one. */
export type Lookup = (host: string, family: 4 | 6) => Promise<string[]>;

const RESOLVE: Lookup = async (host, family) =>
  family === 4 ? await dns.resolve4(host) : await dns.resolve6(host);

/**
 * One origin, end to end: resolve it, open it, read back which build answered.
 *
 * Split out from `checkSelfReach` so the same journey can be run against the
 * `www.` counterpart without a second, drifting copy of it. The wording here is
 * written for `PUBLIC_BASE_URL`, which is what the caller below re-states for
 * the sibling — the facts are identical, the consequences are not.
 */
async function probe(
  origin: string,
  now: Date,
  fetchImpl: typeof fetch,
  lookup: Lookup,
): Promise<SelfReach> {
  const baseUrl = origin.replace(/\/+$/, '');
  const thisBuild = config.buildCommit || 'unknown';
  const checkedAt = now.toISOString();
  const base = { baseUrl, thisBuild, checkedAt, addresses: [] as string[] };

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

  // Resolved before anything is opened, so the cause is established rather
  // than inferred from whatever the fetch happens to throw.
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const addresses = await addressesOf(hostname, lookup);
  const resolved = { ...base, addresses };
  const bare = hostname.replace(/^www\./, '');
  const wwwSuffix = hostname.startsWith('www.')
    ? ` The name is a "www." host; a certificate issued for ${bare} does not cover it, and a proxy that obtains ` +
      `certificates automatically still only requests the names in its own site blocks. Either add ${hostname} to the ` +
      `site block that serves ${bare} and reload the proxy, or set PUBLIC_BASE_URL to https://${bare}, which is a one-line ` +
      'change needing nothing from DNS.'
    : '';

  if (addresses.length === 0) {
    return {
      ...resolved,
      state: 'DNS_MISSING',
      ok: false,
      because:
        `${hostname} has no A or AAAA record, so nothing can reach it — not this process, and not a customer. Every ` +
        'invitation, password reset and notification this platform sends carries a link to that host, and every one of ' +
        'them is dead.',
      remedy:
        `Add a record for ${hostname} pointing at this deployment, or set PUBLIC_BASE_URL to a host that already has ` +
        `one.${hostname.startsWith('www.') ? ` ${bare} is the obvious candidate.` : ''}`,
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
    // It resolves. So this is the proxy or the certificate, never DNS, and the
    // remedy says so instead of sending somebody to a DNS panel that is right.
    const tls = isTlsFailure(error);
    const at = addresses.join(', ');
    return {
      ...resolved,
      state: tls ? 'TLS_FAILED' : 'UNREACHABLE',
      ok: false,
      because: tls
        ? `${hostname} resolves to ${at} and answers, and the TLS certificate presented for it is not valid for that name. ` +
          'This is the "ERR_SSL_PROTOCOL_ERROR" a customer sees when they open an invitation link.'
        : `${hostname} resolves to ${at}, and nothing answered there. DNS is not the problem. Every invitation, password ` +
          'reset and notification this platform sends carries a link to that host, and every one of them is dead.',
      remedy: tls
        ? `Issue a certificate covering ${hostname} and reload the proxy.${wwwSuffix}`
        : `The name resolves, so check what is listening at ${at}: the proxy may not have a site block for ${hostname}, ` +
          'may not be running, or the record may point at a different machine than the one serving this process.' +
          wwwSuffix,
    };
  }

  // Where the request actually ended up.
  //
  // `redirect: 'follow'` is right for asking "does this reach the platform",
  // and it is exactly what hides the fault this catches: a base URL that 301s
  // to another origin answers 200, reports the correct build, and passes every
  // other test here — while the browser never stays on the name the value
  // holds. Emailed links take a needless hop, canonicals disagree with the
  // origin serving them, and passkeys do not work at all, because WebAuthn
  // compares the origin as an exact string and takes the relying-party id from
  // the same host.
  //
  // `response.url` is empty on a synthesised Response, so an absent value is
  // treated as "not known to have moved" rather than as a redirect.
  let landedOn = '';
  try {
    landedOn = response.url === '' ? '' : new URL(response.url).origin;
  } catch {
    landedOn = '';
  }
  const requested = new URL(baseUrl).origin;
  if (landedOn !== '' && landedOn !== requested) {
    return {
      ...resolved,
      state: 'REDIRECTED',
      ok: false,
      because:
        `${requested} answers, and only by redirecting to ${landedOn}. PUBLIC_BASE_URL names the origin this platform ` +
        'believes it is served on, and it is not the one a browser ends up on. Every emailed link takes a needless hop, ' +
        'every canonical URL points somewhere other than the page serving it, and passkey registration and sign-in fail ' +
        'outright — WebAuthn matches the origin as an exact string and derives the relying-party id from the same host.',
      remedy:
        `Set PUBLIC_BASE_URL to ${landedOn}, which is the origin that actually serves, and restart. Keep the redirect: ` +
        `${requested} should go on answering for anybody who types it.`,
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
      ...resolved,
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
      ...resolved,
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
    ...resolved,
    state: 'REACHED',
    ok: true,
    ...(answeredBy ? { answeredBy } : {}),
    because: `${host} resolves, terminates TLS and answers as this deployment. Links in email, the webhook endpoints and ` +
      'payment redirects all reach this process.',
  };
}

/**
 * The same origin with `www.` put on or taken off, or null where there is no
 * such thing.
 *
 * No attempt is made to work out whether the name *ought* to exist. A public
 * suffix list is the only correct way to tell `construx.co.uk` from
 * `app.construx.com`, this platform carries no runtime dependencies, and a
 * hand-rolled label count gets one of those two wrong. DNS answers the question
 * properly and for free: a name nobody has published has no address record, and
 * that is reported as an absence rather than as a fault.
 */
export function siblingOrigin(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  const host = url.hostname;
  if (host === '' || LOCAL.test(host) || isIP(host) || isIP(host.replace(/^\[|\]$/g, ''))) return null;
  const other = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  if (other === '' || other === host || !other.includes('.')) return null;
  url.hostname = other;
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.origin;
}

/** The sibling's own facts, said in terms of what a dead second front door costs. */
async function probeSibling(
  origin: string,
  primaryHost: string,
  now: Date,
  fetchImpl: typeof fetch,
  lookup: Lookup,
): Promise<SiblingReach> {
  const found = await probe(origin, now, fetchImpl, lookup);
  const host = new URL(origin).hostname;
  const at = found.addresses.join(', ');
  const common = {
    url: origin,
    host,
    state: found.state,
    addresses: found.addresses,
  };

  if (found.state === 'DNS_MISSING') {
    return {
      ...common,
      ok: true,
      because: `${host} has no address record, so nobody is being sent there. Only ${primaryHost} is published.`,
    };
  }
  // Redirecting is what the second name is *supposed* to do, so `REDIRECTED`
  // is a pass here and a fault on the base URL. Same fact, opposite verdicts.
  if (found.state === 'REACHED' || found.state === 'REDIRECTED' || found.state === 'OTHER_BUILD' || found.state === 'NOT_READY') {
    const serving = found.state === 'REACHED' || found.state === 'REDIRECTED';
    return {
      ...common,
      ok: serving,
      because: serving
        ? `${host} resolves and serves, directly or by redirect. Somebody typing it, or following an old link that ` +
          'carries it, gets to this deployment.'
        : `${host} resolves and answers, but ${found.state === 'OTHER_BUILD' ? 'as a different build' : 'not as ready'}.`,
      ...(!serving && found.remedy ? { remedy: found.remedy } : {}),
    };
  }

  // It resolves and it does not serve. This is the one worth shouting about.
  const tls = found.state === 'TLS_FAILED';
  return {
    ...common,
    ok: false,
    because:
      `${host} resolves to ${at} and ${tls ? 'presents a certificate that is not valid for that name' : 'nothing answered there'}. ` +
      'Somebody published that record, so somebody is being sent there — from a typed address, a business card, an old ' +
      'search result or a link somebody pasted — and every one of them gets a browser error rather than this site. ' +
      (tls ? 'This is the "ERR_SSL_PROTOCOL_ERROR" a visitor sees.' : ''),
    remedy:
      tls
        ? `Add ${host} to the site block that already serves ${primaryHost} so the proxy requests a certificate covering ` +
          `both, then reload it. Redirecting ${host} to ${primaryHost} still needs that certificate: the redirect is HTTP, ` +
          'and the handshake happens first.'
        : `The name resolves, so the proxy has no site block for ${host}, or routes it somewhere that is not running. Add ` +
          `it alongside ${primaryHost}.`,
  };
}

export async function checkSelfReach(
  now = new Date(),
  fetchImpl: typeof fetch = fetch,
  lookup: Lookup = RESOLVE,
): Promise<SelfReach> {
  const primary = await probe(config.publicBaseUrl, now, fetchImpl, lookup);

  // Only worth asking once the base URL itself is a real public name. There is
  // nothing to say about the `www.` form of a value that is unset, malformed or
  // pointed at this machine.
  if (primary.state === 'NOT_CONFIGURED' || primary.state === 'LOCAL') return primary;
  const other = siblingOrigin(primary.baseUrl);
  if (other === null) return primary;

  let sibling: SiblingReach;
  try {
    sibling = await probeSibling(other, new URL(primary.baseUrl).hostname, now, fetchImpl, lookup);
  } catch {
    // The second opinion must never cost the first one. A sibling probe that
    // throws leaves the primary finding exactly as it was.
    return primary;
  }
  return { ...primary, sibling };
}

/**
 * The last finding, so a screen can show what boot found without opening the
 * front door again.
 *
 * One value rather than a history: this answers "is the public address working
 * now", and a stale entry beside a fresh one invites somebody to read the wrong
 * one. `checkedAt` travels on it so an old answer is visibly old, and the
 * operator's button replaces it.
 */
let last: SelfReach | undefined;

export function rememberSelfReach(reach: SelfReach): void {
  last = reach;
}

export function lastSelfReach(): SelfReach | undefined {
  return last;
}

/** Test isolation only. A deployment does not forget what it found. */
export function resetSelfReach(): void {
  last = undefined;
}
