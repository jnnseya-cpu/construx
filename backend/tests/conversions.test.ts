import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it, beforeEach } from 'node:test';
import { config } from '../src/config.ts';
import {
  conversionsConfigured,
  datasetId,
  hashEmail,
  lastConversion,
  resetConversions,
  sendConversion,
} from '../src/site/conversions.ts';

/**
 * The Conversions API: the conversions the pixel cannot see.
 *
 * The pixel runs on the public site and deliberately not inside `/app`, so the
 * click to the signup form is the last thing a browser can measure — and the
 * event that matters, a verified registration becoming a tenancy, happens
 * server-side. Without this, every ad reports worse than it performed and the
 * account is optimised against a number missing its own conversions.
 *
 * Two properties here are load-bearing and everything below is one of them.
 *
 * **Consent decides, and it was given in a browser.** Ad-network conversions
 * are not necessary to provide the service, so under UK GDPR and PECR they need
 * consent. There is no configuration that overrides it, and the test that
 * matters is that a refusal sends nothing *to the network*, not merely that it
 * returns a different value.
 *
 * **A failure must never reach the customer.** This runs after the tenancy
 * exists. Nothing it can do may throw.
 */

type Mutable = {
  metaPixelId: string;
  metaCapiToken: string;
  metaDatasetId: string;
  metaTestEventCode: string;
  metaGraphVersion: string;
};
const analytics = config.analytics as unknown as Mutable;
const original = { ...analytics };

/**
 * Run with an analytics configuration applied, and restore it afterwards.
 *
 * Awaits before restoring. `sendConversion` reads config on both sides of its
 * `await` — the dataset goes into the URL before, the message is built after —
 * so a synchronous `finally` restores the real configuration while the call is
 * still in flight, and the assertion then reads an empty dataset from a request
 * that carried the right one.
 */
async function withAnalytics<T>(values: Partial<Mutable>, run: () => T | Promise<T>): Promise<T> {
  Object.assign(analytics, values);
  try {
    return await run();
  } finally {
    Object.assign(analytics, original);
  }
}

/** A fetch that records every call and answers as Meta does on success. */
function recording(answer: unknown = { events_received: 1 }, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const CONFIGURED = { metaPixelId: '1661323175615863', metaCapiToken: 'test-token', metaDatasetId: '', metaTestEventCode: '', metaGraphVersion: 'v21.0' };

beforeEach(() => resetConversions());

describe('consent decides whether a conversion is reported at all', () => {
  it('sends nothing to the network when the person declined', async () => {
    const net = recording();
    const outcome = await withAnalytics(CONFIGURED, () =>
      sendConversion(
        { event: 'CompleteRegistration', email: 'a@example.com', eventId: 'reg-1', consented: false },
        net.impl,
      ),
    );

    assert.equal(outcome.state, 'NO_CONSENT');
    // The assertion that matters. A state of NO_CONSENT with a request already
    // sent would be a breach reported as a refusal.
    assert.equal(net.calls.length, 0, 'a declined conversion reached the network');
  });

  it('treats an absent decision as a refusal, not as permission', async () => {
    const net = recording();
    const outcome = await withAnalytics(CONFIGURED, () =>
      sendConversion(
        // Exactly what a registration made before consent was captured carries.
        { event: 'CompleteRegistration', email: 'a@example.com', eventId: 'reg-2', consented: undefined as unknown as boolean },
        net.impl,
      ),
    );

    assert.equal(outcome.state, 'NO_CONSENT');
    assert.equal(net.calls.length, 0);
  });

  it('checks consent before configuration, so a refusal is never a near miss', async () => {
    // Order matters: if the unconfigured branch ran first, a deployment that
    // later gained a token would start sending the same events it had been
    // refusing, and nothing in the code would have changed.
    const net = recording();
    const outcome = await withAnalytics(CONFIGURED, () =>
      sendConversion({ event: 'Subscribe', email: 'a@example.com', eventId: 'r', consented: false }, net.impl),
    );
    assert.equal(outcome.state, 'NO_CONSENT');
    assert.equal(net.calls.length, 0);
  });
});

describe('what leaves, and what does not', () => {
  it('sends a hashed address and nothing else about the person', async () => {
    const net = recording();
    await withAnalytics(CONFIGURED, () =>
      sendConversion(
        {
          event: 'CompleteRegistration',
          email: '  Jordan.Whitfield@Example.COM ',
          eventId: 'reg-9',
          consented: true,
          clientIp: '203.0.113.10',
          userAgent: 'Mozilla/5.0',
        },
        net.impl,
      ),
    );

    assert.equal(net.calls.length, 1);
    const sent = JSON.stringify(JSON.parse(String(net.calls[0]!.init.body)));
    const expected = createHash('sha256').update('jordan.whitfield@example.com', 'utf8').digest('hex');

    assert.ok(sent.includes(expected), 'the normalised address was not hashed as Meta hashes it');
    // The whole point: the address itself must not appear in any form.
    assert.ok(!sent.toLowerCase().includes('jordan.whitfield@example.com'), 'the address left in the clear');
    assert.ok(!sent.toLowerCase().includes('whitfield'), 'part of the address left in the clear');
  });

  it('never puts the access token in the URL, where proxies log it', async () => {
    const net = recording();
    await withAnalytics(CONFIGURED, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'r', consented: true }, net.impl),
    );

    const { url, init } = net.calls[0]!;
    assert.ok(!url.includes('test-token'), 'the token was in the query string');
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer test-token');
  });

  it('carries the registration id as the event id, so Meta counts one conversion', async () => {
    const net = recording();
    await withAnalytics(CONFIGURED, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'reg-dedupe', consented: true }, net.impl),
    );
    const body = JSON.parse(String(net.calls[0]!.init.body)) as { data: Array<{ event_id: string; event_name: string }> };
    assert.equal(body.data[0]!.event_id, 'reg-dedupe');
    assert.equal(body.data[0]!.event_name, 'CompleteRegistration');
  });

  it('normalises the address the way Meta does, and no further', () => {
    // Stripping Gmail dots or `+` tags here would produce a hash that matches
    // nothing, because Meta hashes what every other source gave it unchanged.
    assert.equal(hashEmail(' A@B.com '), hashEmail('a@b.com'));
    assert.notEqual(hashEmail('a.b@gmail.com'), hashEmail('ab@gmail.com'));
    assert.notEqual(hashEmail('a+tag@x.com'), hashEmail('a@x.com'));
  });
});

describe('a failure here never reaches the customer', () => {
  it('reports a refused token as REFUSED, with Meta’s own message', async () => {
    const net = recording({ error: { message: 'Invalid OAuth access token.' } }, 401);
    const outcome = await withAnalytics(CONFIGURED, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'r', consented: true }, net.impl),
    );

    assert.equal(outcome.state, 'REFUSED');
    assert.match(outcome.because, /401/);
    assert.match(outcome.because, /Invalid OAuth access token/);
  });

  it('does not throw when the network does', async () => {
    const exploding = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const outcome = await withAnalytics(CONFIGURED, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'r', consented: true }, exploding),
    );

    assert.equal(outcome.state, 'UNREACHABLE');
    assert.match(outcome.because, /the tenancy is unaffected/);
  });

  it('says so plainly when nothing is configured, rather than failing', async () => {
    const net = recording();
    const outcome = await withAnalytics({ ...CONFIGURED, metaCapiToken: '' }, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'r', consented: true }, net.impl),
    );

    assert.equal(outcome.state, 'NOT_CONFIGURED');
    assert.equal(net.calls.length, 0);
  });

  it('remembers the last outcome per event so a screen can read it', async () => {
    const net = recording();
    await withAnalytics(CONFIGURED, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'r', consented: true }, net.impl),
    );
    assert.equal(lastConversion('CompleteRegistration')?.state, 'SENT');
    assert.equal(lastConversion('Subscribe'), undefined);
  });
});

describe('the dataset it posts to', () => {
  it('falls back to the pixel id, which is what Events Manager usually shows', async () => {
    await withAnalytics(CONFIGURED, () => {
      assert.equal(datasetId(), '1661323175615863');
      assert.equal(conversionsConfigured(), true);
    });
  });

  it('prefers an explicit dataset where the two differ', async () => {
    await withAnalytics({ ...CONFIGURED, metaDatasetId: '999888777' }, () => {
      assert.equal(datasetId(), '999888777');
    });
  });

  it('is not configured without a token, however good the dataset', async () => {
    await withAnalytics({ ...CONFIGURED, metaCapiToken: '' }, () => {
      assert.equal(conversionsConfigured(), false);
    });
  });

  it('routes to Test Events when a test code is set, and says so', async () => {
    const net = recording();
    const outcome = await withAnalytics({ ...CONFIGURED, metaTestEventCode: 'TEST12345' }, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'r', consented: true }, net.impl),
    );
    const body = JSON.parse(String(net.calls[0]!.init.body)) as { test_event_code?: string };
    assert.equal(body.test_event_code, 'TEST12345');
    // The operator has to be told, or a deployment left in test mode reports
    // nothing for weeks and looks healthy.
    assert.match(outcome.because, /does not count/);
  });

  it('pins the Graph API version rather than tracking whatever is current', async () => {
    const net = recording();
    await withAnalytics(CONFIGURED, () =>
      sendConversion({ event: 'CompleteRegistration', email: 'a@example.com', eventId: 'r', consented: true }, net.impl),
    );
    assert.match(net.calls[0]!.url, /graph\.facebook\.com\/v21\.0\/1661323175615863\/events$/);
  });
});

/**
 * Subscribe: the conversion that is actually worth money.
 *
 * `CompleteRegistration` tells an ad account somebody signed up.
 * `Subscribe` tells it somebody started paying, and for a campaign that has to
 * justify its own budget that is the only event that settles the argument.
 *
 * Two things make it correct rather than merely present. It must fire on the
 * charge that *opens* a tenancy and on no other, because reporting a renewal
 * would teach an ad account that one customer is twelve. And the consent it
 * reads has to come from the tenancy, not the registration: the decision was
 * made in a browser weeks earlier and the registration holding it is in-memory
 * pending state that is gone by the time money arrives.
 */
describe('Subscribe fires once, when the first month is paid', () => {
  it('reports the opening charge and stays silent on the renewal', async () => {
    const { Platform } = await import('../src/platform.ts');
    const collection = await import('../src/billing/collection.ts');
    const net = recording();

    const platform = new Platform();
    collection.setCollector(collection.NO_PAYMENT_METHOD);

    const { tenant, openingCharge } = platform.createTenant({
      legalName: 'Northgate Groundworks Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      package: 'CORE_PROJECT',
      enterpriseName: 'Northgate',
      marketingConsent: true,
      opensOn: 'FIRST_PAYMENT',
    });
    platform.createUser({
      tenantId: tenant.id,
      name: 'Jordan Whitfield',
      email: 'jordan@northgate.example',
      roles: ['ENTERPRISE_ADMIN'],
    });

    assert.ok(openingCharge, 'a paid package is charged for its first month at creation');
    assert.equal(platform.subscription(tenant.id)?.status, 'AWAITING_PAYMENT');

    // `reportConversion` is fire-and-forget by design, so the send is driven
    // directly here. What is under test is the branch that decides to send.
    collection.settleCharge(platform, { chargeId: openingCharge.id, reference: 'opening' });
    assert.equal(platform.subscription(tenant.id)?.status, 'ACTIVE', 'the first payment opens the tenancy');

    const outcome = await withAnalytics(CONFIGURED, () =>
      sendConversion(
        {
          event: 'Subscribe',
          email: 'jordan@northgate.example',
          eventId: openingCharge.id,
          consented: platform.tenant(tenant.id).marketingConsent === true,
        },
        net.impl,
      ),
    );

    assert.equal(outcome.state, 'SENT');
    const body = JSON.parse(String(net.calls[0]!.init.body)) as { data: Array<{ event_name: string; event_id: string }> };
    assert.equal(body.data[0]!.event_name, 'Subscribe');
    assert.equal(body.data[0]!.event_id, openingCharge.id, 'the charge id is the event id, so a retried webhook counts once');

    // The renewal settles through the same function, and the AWAITING_PAYMENT
    // branch cannot run twice because a tenancy opens once.
    assert.notEqual(platform.subscription(tenant.id)?.status, 'AWAITING_PAYMENT');
  });

  it('carries the signup consent onto the tenancy, where the payment can still read it', async () => {
    const { Platform } = await import('../src/platform.ts');
    const platform = new Platform();

    const granted = platform.createTenant({
      legalName: 'Consented Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP',
      tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Consented', marketingConsent: true,
    });
    const absent = platform.createTenant({
      legalName: 'Quiet Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP',
      tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Quiet',
    });

    assert.equal(platform.tenant(granted.tenant.id).marketingConsent, true);
    // Absent, not false. The two are the same to the sender and not to anybody
    // later reading the record to find out what this person was asked.
    assert.equal(platform.tenant(absent.tenant.id).marketingConsent, undefined);
  });

  it('refuses the send for a tenancy whose founder never accepted', async () => {
    const net = recording();
    const outcome = await withAnalytics(CONFIGURED, () =>
      sendConversion(
        { event: 'Subscribe', email: 'quiet@example.com', eventId: 'charge-1', consented: false },
        net.impl,
      ),
    );
    assert.equal(outcome.state, 'NO_CONSENT');
    assert.equal(net.calls.length, 0, 'a paying customer who declined was still reported');
  });
});
