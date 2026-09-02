import { config } from '../config.ts';

/**
 * The transport posture: what protects data in flight, and what is terminating
 * TLS if this process is not.
 *
 * ## Why this is a report and not an implementation
 *
 * This process serves plain HTTP and always has. That is the right answer for a
 * container behind a load balancer, which is where it runs, and it would be the
 * wrong answer for a process exposed directly. The difference is not visible
 * from inside the process — both look like a socket — so the platform cannot
 * *enforce* TLS. What it can do is refuse to be vague about it: say which
 * arrangement the operator has declared, check the things that are checkable,
 * and name what is not.
 *
 * A platform that printed "TLS: enabled" because it had a certificate path in a
 * variable would be worse than one that said nothing, because somebody would
 * believe it.
 *
 * ## What is actually checkable from here
 *
 * - Whether the public address is `https`. An `http` public address means every
 *   token, every one-time code and every document travels in clear text, and it
 *   is checkable because the operator has to configure it either way.
 * - Whether HSTS is being sent, and for how long. A header the platform emits.
 * - Whether cookies are marked `Secure`. Also the platform's own doing.
 * - Whether a proxy's forwarded-protocol header is trusted, and by what rule —
 *   because trusting `x-forwarded-proto` from anywhere is how a redirect loop
 *   becomes an authentication bypass.
 *
 * ## What is not
 *
 * The cipher suites, the protocol versions, the certificate chain and its
 * expiry. Those belong to whatever terminates TLS, and inventing an answer for
 * them would be exactly the vagueness this module exists to remove.
 */

export type TerminationPoint = 'LOAD_BALANCER' | 'REVERSE_PROXY' | 'SERVICE_MESH' | 'THIS_PROCESS' | 'NOT_DECLARED';

export type TransportPosture = {
  /** What the operator has declared terminates TLS. */
  termination: TerminationPoint;
  /** The address the platform tells the world to reach it on. */
  publicAddress: string;
  /** True where that address is https. The one thing here that is not a claim. */
  publicAddressIsSecure: boolean;
  hsts: { sent: boolean; maxAgeSeconds: number; includeSubDomains: boolean; preload: boolean };
  cookiesSecure: boolean;
  /** Whether a forwarded-protocol header is honoured, and from where. */
  forwardedProtocol: { trusted: boolean; because: string };
  /** Every finding, worst first. Empty is a real answer and means it. */
  findings: Array<{ severity: 'CRITICAL' | 'WARNING' | 'NOTE'; finding: string; because: string; action: string }>;
  /** What this platform cannot see from inside itself. */
  notVisibleFromHere: string[];
  summary: string;
};

export function transportPosture(): TransportPosture {
  const address = config.publicBaseUrl;
  const secure = address.startsWith('https://');
  const termination = config.transport.termination as TerminationPoint;
  const findings: TransportPosture['findings'] = [];

  if (!secure) {
    findings.push({
      severity: address.startsWith('http://localhost') || address.startsWith('http://127.') ? 'NOTE' : 'CRITICAL',
      finding: `The public address is ${address}, which is not https.`,
      because:
        'Every access token, one-time code, signed document and site photograph travels in clear text, readable and ' +
        'alterable by anything on the path. On localhost this is expected; anywhere else it is the whole of the platform’s ' +
        'confidentiality gone.',
      action: 'Set PUBLIC_BASE_URL to the https address and terminate TLS in front of this process.',
    });
  }

  if (termination === 'NOT_DECLARED') {
    findings.push({
      severity: secure ? 'WARNING' : 'NOTE',
      finding: 'Nothing has declared what terminates TLS.',
      because:
        'This process serves plain HTTP by design, so the protection in flight is entirely somebody else’s — and an ' +
        'arrangement nobody has written down is one nobody is maintaining. It also means this platform cannot tell an ' +
        'auditor where the certificate lives.',
      action: 'Set TLS_TERMINATION to LOAD_BALANCER, REVERSE_PROXY, SERVICE_MESH or THIS_PROCESS.',
    });
  }

  if (termination === 'THIS_PROCESS') {
    findings.push({
      severity: 'CRITICAL',
      finding: 'TLS is declared as terminating in this process, and this process does not terminate TLS.',
      because:
        'The server is created with `node:http` and has never been given a certificate. A declaration that says otherwise ' +
        'is worse than none, because it is the answer somebody will give an auditor.',
      action: 'Put a load balancer or reverse proxy in front, and set TLS_TERMINATION to match what is actually there.',
    });
  }

  if (secure && !config.transport.hstsMaxAgeSeconds) {
    findings.push({
      severity: 'WARNING',
      finding: 'HSTS is not being sent.',
      because:
        'Without it, the first request of a session can be made over http — typed, bookmarked or redirected — and that ' +
        'one request carries a session cookie or a token in the clear. HSTS is what closes the first-request window.',
      action: 'Set HSTS_MAX_AGE_SECONDS to at least 15552000 (180 days).',
    });
  }

  if (secure && !config.transport.cookiesSecure) {
    findings.push({
      severity: 'CRITICAL',
      finding: 'Cookies are not marked Secure on an https deployment.',
      because: 'A cookie without the Secure attribute is sent over http, which is precisely the request an attacker arranges.',
      action: 'Set COOKIES_SECURE=true.',
    });
  }

  if (config.transport.trustForwardedProto && !config.transport.trustedProxyCidrs) {
    findings.push({
      severity: 'CRITICAL',
      finding: 'A forwarded-protocol header is trusted from any source.',
      because:
        'Anything that can reach this process can then assert that its request arrived over https. Where that header ' +
        'decides whether to redirect or whether to mark a cookie Secure, trusting it from anywhere turns a header into an ' +
        'authentication bypass.',
      action: 'Set TRUSTED_PROXY_CIDRS to the load balancer’s range, or set TRUST_FORWARDED_PROTO=false.',
    });
  }

  const order = { CRITICAL: 0, WARNING: 1, NOTE: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  const critical = findings.filter((finding) => finding.severity === 'CRITICAL').length;

  return {
    termination,
    publicAddress: address,
    publicAddressIsSecure: secure,
    hsts: {
      sent: config.transport.hstsMaxAgeSeconds > 0,
      maxAgeSeconds: config.transport.hstsMaxAgeSeconds,
      includeSubDomains: config.transport.hstsIncludeSubDomains,
      preload: config.transport.hstsPreload,
    },
    cookiesSecure: config.transport.cookiesSecure,
    findings,
    forwardedProtocol: {
      trusted: config.transport.trustForwardedProto,
      because: config.transport.trustedProxyCidrs
        ? `Only from ${config.transport.trustedProxyCidrs}.`
        : config.transport.trustForwardedProto
          ? 'From any source, which is not safe.'
          : 'Not trusted; the protocol is taken from the public address alone.',
    },
    notVisibleFromHere: [
      'Cipher suites and protocol versions — they belong to whatever terminates TLS, not to this process.',
      'The certificate, its chain and its expiry date. This process has never been given one.',
      'Whether the hop between the terminator and this process is itself encrypted.',
    ],
    summary:
      critical > 0
        ? `${critical} critical transport finding${critical === 1 ? '' : 's'}. ${findings[0]!.finding}`
        : findings.length > 0
          ? `Transport is sound with ${findings.length} thing${findings.length === 1 ? '' : 's'} worth tightening.`
          : `Public address is https, HSTS is sent for ${config.transport.hstsMaxAgeSeconds}s, cookies are Secure, and ` +
            `${termination.toLowerCase().replace(/_/g, ' ')} terminates TLS.`,
  };
}
