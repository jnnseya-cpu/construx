import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { checkSelfReach } from '../src/ops/selfreach.ts';

/**
 * "This site can't provide a secure connection. ERR_SSL_PROTOCOL_ERROR."
 *
 * That was an invitation link, and the same cause produced payments guidance
 * quoting a webhook origin that answered nothing: `PUBLIC_BASE_URL` named a
 * `www.` host that had never been given a DNS record. Nothing checked it. It is
 * only a string until a customer clicks it, and the customer is the one who
 * finds out.
 *
 * The states are kept apart because the remedies are: a missing DNS record, a
 * certificate that does not cover the name, and an origin that answers
 * healthily as somebody else's deployment are three different afternoons.
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

function failing(code: string): typeof fetch {
  return (async () => {
    const error = new TypeError('fetch failed');
    (error as { cause?: { code: string } }).cause = { code };
    throw error;
  }) as unknown as typeof fetch;
}

describe('whether the public address reaches this deployment', () => {
  it('says a host that answers nothing is a dead link in every email', async () => {
    const reach = await at('https://www.construxvg.example', () =>
      checkSelfReach(new Date(), failing('ENOTFOUND')),
    );
    assert.equal(reach.state, 'UNRESOLVED');
    assert.equal(reach.ok, false);
    assert.match(reach.because, /invitation/i, 'the consequence for a customer is not stated');
    assert.match(String(reach.remedy), /DNS/, 'the remedy does not name what is missing');
    assert.match(String(reach.remedy), /www\./, 'the usual cause is not named');
  });

  it('separates a certificate fault from a missing record, because the fix differs', async () => {
    const reach = await at('https://www.construxvg.example', () =>
      checkSelfReach(new Date(), failing('ERR_TLS_CERT_ALTNAME_INVALID')),
    );
    assert.equal(reach.state, 'TLS_FAILED');
    assert.match(reach.because, /ERR_SSL_PROTOCOL_ERROR/, 'the error a customer actually sees is not named');
    assert.match(String(reach.remedy), /certificate/i);
    assert.doesNotMatch(String(reach.remedy), /DNS record/, 'a TLS fault was answered with a DNS remedy');
  });

  it('catches an origin that answers healthily as another deployment', async () => {
    // The hardest failure to see from inside: everything works, and the links
    // in this deployment's email reach a different one. Needs a known build on
    // both sides — two unknowns are not a mismatch, and saying they were would
    // report every development process as misrouted.
    const build = config.buildCommit;
    (config as { buildCommit: string }).buildCommit = 'aaaaaaa';
    try {
      const reach = await at('https://construx.example', () => checkSelfReach(new Date(), answering(200, { commit: 'bbbbbbb' })));
      assert.equal(reach.state, 'OTHER_BUILD');
      assert.equal(reach.ok, false);
      assert.equal(reach.answeredBy, 'bbbbbbb');
    } finally {
      (config as { buildCommit: string }).buildCommit = build;
    }
  });

  it('does not call two unknown builds a mismatch', async () => {
    const reach = await at('https://construx.example', () => checkSelfReach(new Date(), answering(200, { commit: 'unknown' })));
    assert.equal(reach.state, 'REACHED');
  });

  it('passes when the address answers as this build', async () => {
    const reach = await at('https://construx.example', () =>
      checkSelfReach(new Date(), answering(200, { commit: config.buildCommit || 'unknown' })),
    );
    assert.equal(reach.state, 'REACHED');
    assert.equal(reach.ok, true);
  });

  it('reports a host that is served but not ready, rather than calling it unreachable', async () => {
    const reach = await at('https://construx.example', () => checkSelfReach(new Date(), answering(503, { status: 'degraded' })));
    assert.equal(reach.state, 'NOT_READY');
    assert.match(reach.because, /503/);
  });

  it('does not scold a development machine for pointing at itself', async () => {
    const reach = await at('http://localhost:8080', () => checkSelfReach(new Date(), failing('ECONNREFUSED')));
    assert.equal(reach.state, 'LOCAL');
    assert.equal(reach.ok, true);
  });

  it('refuses a base URL that is not a URL', async () => {
    const reach = await at('construx.example', () => checkSelfReach(new Date(), answering(200, {})));
    assert.equal(reach.state, 'NOT_CONFIGURED');
    assert.match(reach.because, /not a URL/);
  });

  it('strips a trailing slash rather than requesting a double one', async () => {
    let asked = '';
    const spy = (async (url: string) => {
      asked = String(url);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    await at('https://construx.example/', () => checkSelfReach(new Date(), spy));
    assert.equal(asked, 'https://construx.example/readyz');
  });
});
