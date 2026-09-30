import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { checkSelfReach, type Lookup } from '../src/ops/selfreach.ts';

/**
 * "This site can't provide a secure connection. ERR_SSL_PROTOCOL_ERROR."
 *
 * That was an invitation link, and the same `PUBLIC_BASE_URL` produced payments
 * guidance quoting a webhook origin nothing could open. Nothing had ever
 * checked it. It is only a string until a customer clicks it, and the customer
 * is the one who finds out.
 *
 * The states are kept apart because the remedies are — a name with no record, a
 * name that resolves with nothing listening, a certificate that does not cover
 * the name, and an origin that answers healthily as somebody else's deployment
 * are four different afternoons. **And the cause is established rather than
 * guessed**, which is the subject of the second test: the first version of this
 * check inferred it from the fetch's error code and named a DNS fault on a
 * deployment whose DNS was correct.
 */

const original = config.publicBaseUrl;

function at<T>(baseUrl: string, run: () => T): T {
  // The config object is the one the module reads, so the value is swapped for
  // the call and put back. Restored in a finally so a failing assertion cannot
  // leave the rest of the suite pointed somewhere else.
  (config as { publicBaseUrl: string }).publicBaseUrl = baseUrl;
  try {
    return run();
  } finally {
    (config as { publicBaseUrl: string }).publicBaseUrl = original;
  }
}

function answering(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
}

/** A name that resolves to these addresses, in whichever family they belong to. */
function resolving(...addresses: string[]): Lookup {
  return async (_host, family) => addresses.filter((a) => (a.includes(':') ? 6 : 4) === family);
}

/** A name with no record at all, in either family. */
const unresolvable: Lookup = async () => {
  throw Object.assign(new Error('queryA ENOTFOUND'), { code: 'ENOTFOUND' });
};

function failing(code: string): typeof fetch {
  return (async () => {
    const error = new TypeError('fetch failed');
    (error as { cause?: { code: string } }).cause = { code };
    throw error;
  }) as unknown as typeof fetch;
}

describe('whether the public address reaches this deployment', () => {
  it('says a name with no record at all is a dead link in every email', async () => {
    const reach = await at('https://www.construxvg.example', () =>
      checkSelfReach(new Date(), failing('ENOTFOUND'), unresolvable),
    );
    assert.equal(reach.state, 'DNS_MISSING');
    assert.equal(reach.ok, false);
    assert.deepEqual(reach.addresses, []);
    assert.match(reach.because, /invitation/i, 'the consequence for a customer is not stated');
    assert.match(String(reach.remedy), /record/, 'the remedy does not name what is missing');
  });

  it('does not blame DNS for a certificate fault on a name that resolves', async () => {
    /*
     * **The defect this test exists for.** The first version inferred the cause
     * from the fetch's error code and then asserted the likely reason: "a www.
     * host that was never given a DNS record". On the deployment that prompted
     * the check that was false — the www name is a CNAME to a domain with both
     * A and AAAA records, and the fault was a certificate that did not cover
     * it. The remedy would have sent somebody to the DNS panel for an
     * afternoon.
     */
    const reach = await at('https://www.construxvg.example', () =>
      checkSelfReach(new Date(), failing('ERR_TLS_CERT_ALTNAME_INVALID'), resolving('187.124.117.159', '2a02:4780:f:683c::1')),
    );
    assert.equal(reach.state, 'TLS_FAILED');
    assert.deepEqual(reach.addresses, ['187.124.117.159', '2a02:4780:f:683c::1']);
    assert.match(reach.because, /ERR_SSL_PROTOCOL_ERROR/, 'the error a customer actually sees is not named');
    assert.match(reach.because, /resolves/, 'the remedy must say DNS is fine, not leave it open');
    assert.match(String(reach.remedy), /certificate/i);
    assert.doesNotMatch(String(reach.remedy), /Add a record/, 'a TLS fault was answered with a DNS remedy');
    // And the one-line alternative, because it needs nothing from DNS and is
    // entirely in the operator's own hands.
    assert.match(String(reach.remedy), /construxvg\.example/, 'the bare-domain alternative is not offered');
  });

  it('says a name that resolves but answers nothing is not a DNS problem', async () => {
    const reach = await at('https://construx.example', () =>
      checkSelfReach(new Date(), failing('ECONNREFUSED'), resolving('203.0.113.10')),
    );
    assert.equal(reach.state, 'UNREACHABLE');
    assert.match(reach.because, /DNS is not the problem/);
    assert.match(String(reach.remedy), /203\.0\.113\.10/, 'the remedy does not say where to look');
  });

  it('catches an origin that answers healthily as another deployment', async () => {
    // The hardest failure to see from inside: everything works, and the links
    // in this deployment's email reach a different one. Needs a known build on
    // both sides — two unknowns are not a mismatch, and saying they were would
    // report every development process as misrouted.
    const build = config.buildCommit;
    (config as { buildCommit: string }).buildCommit = 'aaaaaaa';
    try {
      const reach = await at('https://construx.example', () => checkSelfReach(new Date(), answering(200, { commit: 'bbbbbbb' }), resolving('203.0.113.10')));
      assert.equal(reach.state, 'OTHER_BUILD');
      assert.equal(reach.ok, false);
      assert.equal(reach.answeredBy, 'bbbbbbb');
    } finally {
      (config as { buildCommit: string }).buildCommit = build;
    }
  });

  it('does not call two unknown builds a mismatch', async () => {
    const reach = await at('https://construx.example', () => checkSelfReach(new Date(), answering(200, { commit: 'unknown' }), resolving('203.0.113.10')));
    assert.equal(reach.state, 'REACHED');
  });

  it('passes when the address answers as this build', async () => {
    const reach = await at('https://construx.example', () =>
      checkSelfReach(new Date(), answering(200, { commit: config.buildCommit || 'unknown' }), resolving('203.0.113.10')),
    );
    assert.equal(reach.state, 'REACHED');
    assert.equal(reach.ok, true);
  });

  it('reports a host that is served but not ready, rather than calling it unreachable', async () => {
    const reach = await at('https://construx.example', () => checkSelfReach(new Date(), answering(503, { status: 'degraded' }), resolving('203.0.113.10')));
    assert.equal(reach.state, 'NOT_READY');
    assert.match(reach.because, /503/);
  });

  it('does not scold a development machine for pointing at itself', async () => {
    const reach = await at('http://localhost:8080', () => checkSelfReach(new Date(), failing('ECONNREFUSED')));
    assert.equal(reach.state, 'LOCAL');
    assert.equal(reach.ok, true);
  });

  it('refuses a base URL that is not a URL', async () => {
    const reach = await at('construx.example', () => checkSelfReach(new Date(), answering(200, {}), resolving('203.0.113.10')));
    assert.equal(reach.state, 'NOT_CONFIGURED');
    assert.match(reach.because, /not a URL/);
  });

  it('strips a trailing slash rather than requesting a double one', async () => {
    const asked: string[] = [];
    const spy = (async (url: string) => {
      asked.push(String(url));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await at('https://construx.example/', () => checkSelfReach(new Date(), spy, resolving('203.0.113.10')));
    // The base URL is asked first. The second call is the `www.` counterpart,
    // which is the subject of the suite below.
    assert.equal(asked[0], 'https://construx.example/readyz');
  });
});

/**
 * The hostname nobody configured, which half the world types anyway.
 *
 * Reported from the live site: *"www.construxvg.com is not working, only
 * construxvg.com"* — on a deployment whose every blog canonical, sitemap entry
 * and emailed link was built on the `www.` form. The check above passed
 * throughout, because it only ever asked about one origin.
 *
 * DNS decides whether the other name is expected to work. A name nobody
 * published is an absence; a name that resolves and then refuses the handshake
 * is a dead front door, and somebody is walking into it.
 */
describe('the other form of the same name', () => {
  /** Answers for one hostname and fails the handshake for the other. */
  function servingOnly(goodHost: string): typeof fetch {
    return (async (url: string) => {
      if (new URL(String(url)).hostname === goodHost) {
        return new Response(JSON.stringify({ commit: config.buildCommit || 'unknown' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const error = new TypeError('fetch failed');
      (error as { cause?: { code: string } }).cause = { code: 'ERR_TLS_CERT_ALTNAME_INVALID' };
      throw error;
    }) as unknown as typeof fetch;
  }

  it('fails the www host that resolves to this deployment and refuses the handshake', async () => {
    const reach = await at('https://construx.example', () =>
      checkSelfReach(new Date(), servingOnly('construx.example'), resolving('203.0.113.10')),
    );

    // The base URL itself is fine, which is exactly how this hid.
    assert.equal(reach.state, 'REACHED');
    assert.equal(reach.ok, true);

    const sibling = reach.sibling;
    assert.ok(sibling, 'no sibling was checked at all');
    assert.equal(sibling.host, 'www.construx.example');
    assert.equal(sibling.state, 'TLS_FAILED');
    assert.equal(sibling.ok, false);
    assert.match(sibling.because, /ERR_SSL_PROTOCOL_ERROR/);
    // The remedy has to say that redirecting is not a way around the
    // certificate, because that is the wrong turn people take here.
    assert.match(sibling.remedy ?? '', /site block that already serves construx\.example/);
    assert.match(sibling.remedy ?? '', /handshake happens first/);
  });

  it('treats a www host nobody published as an absence rather than a fault', async () => {
    const reach = await at('https://construx.example', () =>
      checkSelfReach(new Date(), servingOnly('construx.example'), async (host, family) =>
        host.startsWith('www.') ? [] : ['203.0.113.10'].filter(() => family === 4),
      ),
    );

    assert.equal(reach.ok, true);
    assert.equal(reach.sibling?.state, 'DNS_MISSING');
    assert.equal(reach.sibling?.ok, true, 'a name nobody published is not a fault');
    assert.match(reach.sibling?.because ?? '', /no address record/);
  });

  it('checks the apex when the base URL is the www form, which is the reported case', async () => {
    // PUBLIC_BASE_URL on the www name and a certificate covering only the
    // apex: the base URL fails, and the apex is named as the one that works.
    const reach = await at('https://www.construx.example', () =>
      checkSelfReach(new Date(), servingOnly('construx.example'), resolving('203.0.113.10')),
    );

    assert.equal(reach.state, 'TLS_FAILED');
    assert.equal(reach.ok, false);
    assert.equal(reach.sibling?.host, 'construx.example');
    assert.equal(reach.sibling?.state, 'REACHED');
    assert.equal(reach.sibling?.ok, true);
  });

  it('accepts a redirect as serving, because a 301 to the apex is a working front door', async () => {
    // `probe` follows redirects, so a www that 301s to the apex answers 200 on
    // /readyz. That is the recommended arrangement and must not read as broken.
    const reach = await at('https://construx.example', () =>
      checkSelfReach(new Date(), answering(200, { commit: config.buildCommit || 'unknown' }), resolving('203.0.113.10')),
    );

    assert.equal(reach.sibling?.state, 'REACHED');
    assert.equal(reach.sibling?.ok, true);
    assert.match(reach.sibling?.because ?? '', /directly or by redirect/);
  });

  it('fails a base URL that only answers by redirecting somewhere else', async () => {
    // The live case. PUBLIC_BASE_URL was the www form, the proxy redirected
    // www to the apex, and every check passed: it resolved, it terminated TLS,
    // it answered 200, it reported the right build. Meanwhile passkeys could
    // not work at all, because WebAuthn takes the relying-party id from this
    // host and the apex is not a subdomain of www.
    const redirectingTo = (async (url: string) => {
      const target = new URL(String(url));
      target.hostname = target.hostname.replace(/^www\./, '');
      const answer = new Response(JSON.stringify({ commit: config.buildCommit || 'unknown' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      // What a followed redirect leaves behind: the final URL, not the asked one.
      Object.defineProperty(answer, 'url', { value: target.toString() });
      return answer;
    }) as unknown as typeof fetch;

    const reach = await at('https://www.construx.example', () =>
      checkSelfReach(new Date(), redirectingTo, resolving('203.0.113.10')),
    );

    assert.equal(reach.state, 'REDIRECTED');
    assert.equal(reach.ok, false, 'a base URL that redirects elsewhere is not a working base URL');
    assert.match(reach.because, /passkey registration and sign-in fail/);
    assert.match(reach.remedy ?? '', /Set PUBLIC_BASE_URL to https:\/\/construx\.example/);
    // And it must not tell anybody to remove the redirect: the www name still
    // has to answer for whoever types it.
    assert.match(reach.remedy ?? '', /Keep the redirect/);
  });

  it('passes the sibling that redirects, because that is what the second name is for', async () => {
    // The same fact, opposite verdict. The apex is the base URL and serves
    // directly; www redirects onto it, which is the arrangement to aim for.
    const apexDirect = (async (url: string) => {
      const asked = new URL(String(url));
      const final = new URL(String(url));
      final.hostname = final.hostname.replace(/^www\./, '');
      const answer = new Response(JSON.stringify({ commit: config.buildCommit || 'unknown' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      Object.defineProperty(answer, 'url', { value: asked.hostname.startsWith('www.') ? final.toString() : asked.toString() });
      return answer;
    }) as unknown as typeof fetch;

    const reach = await at('https://construx.example', () =>
      checkSelfReach(new Date(), apexDirect, resolving('203.0.113.10')),
    );

    assert.equal(reach.state, 'REACHED');
    assert.equal(reach.ok, true);
    assert.equal(reach.sibling?.host, 'www.construx.example');
    assert.equal(reach.sibling?.state, 'REDIRECTED');
    assert.equal(reach.sibling?.ok, true, 'a www that redirects to the apex is a working front door');
    assert.equal(reach.sibling?.remedy, undefined, 'nothing to remedy on a name that is doing its job');
  });

  it('asks about nothing when there is no other form to ask about', async () => {
    const local = await at('http://localhost:8080', () => checkSelfReach(new Date(), failing('ECONNREFUSED')));
    assert.equal(local.sibling, undefined, 'localhost has no www form worth probing');

    const unset = await at('', () => checkSelfReach(new Date(), failing('ECONNREFUSED')));
    assert.equal(unset.sibling, undefined);
  });
});
