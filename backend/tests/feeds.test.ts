import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { DomainError } from '../src/core/errors.ts';
import * as feeds from '../src/feeds/read.ts';
import { FEEDS, FEED_CODES, feedUnavailable } from '../src/feeds/registry.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * External data feeds, driven against a real HTTP source.
 *
 * A stub function standing in for `fetch` proves the mapper and nothing else.
 * The failures that actually happen to a feed are HTTP failures — a 500, a
 * login page where JSON was expected, a body that never ends, a vendor that
 * quietly changed its response shape — and each of those is exercised here
 * against a server that really sends them.
 *
 * The one thing this does not claim: no real vendor has been called. What is
 * proven is the contract this platform holds a feed to, not any particular
 * provider's data.
 */

let platform: Platform;
let seed: SeedResult;
let source: Server;
let base: string;

/** What the fake source will answer next. Set per test. */
let reply: { status: number; body: string; contentType?: string; delayMs?: number } = { status: 200, body: '{}' };
/** Every request the source received, so a test can assert what left the platform. */
let received: Array<{ url: string; authorization?: string }> = [];

const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
const asSite = () => platform.context(seed.users.constructionManager!.auth, seed.projectId, { source: 'WEB' });

/**
 * Point a feed at the fake source, and put it back afterwards.
 *
 * `await run()` rather than returning the promise: the settings must still be
 * in place while the call is in flight, and a `finally` that fires the moment
 * a promise is *created* restores them before the request has been made.
 */
async function withFeed<T>(code: string, url: string, key: string, run: () => Promise<T> | T): Promise<T> {
  const feed = (config.feeds as unknown as Record<string, { url: string; key: string }>)[code]!;
  const was = { url: feed.url, key: feed.key };
  feed.url = url;
  feed.key = key;
  try {
    return await run();
  } finally {
    feed.url = was.url;
    feed.key = was.key;
  }
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  source = createServer((request, response) => {
    received.push({
      url: request.url ?? '',
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    });
    const send = (): void => {
      response.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'application/json' });
      response.end(reply.body);
    };
    if (reply.delayMs) setTimeout(send, reply.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const address = source.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => source.close(() => resolve()));
});

describe('the catalogue', () => {
  it('classifies its entity, so the generic entity route enforces the boundary', () => {
    // An unmapped type is unreadable by design; a mapped one that nobody
    // remembered to map is the hole this check exists to catch.
    assert.equal(classifyEntity('FeedReading')?.area, 'BUDGET_COST');
    assert.equal(classifyEntity('FeedReading')?.sensitivity, 'COMMERCIAL_L3');
  });

  it('declares its event on the closed catalogue, and no agent may write it', () => {
    const type = lookupEventType('EXTERNAL_FEED_READ');
    assert.equal(type?.entity, 'FeedReading');
    assert.equal(type?.creates, true);
    // A reading is a record of what a source said. An agent that could author
    // one could author the price it says.
    assert.equal(type?.aiAllowed, false);
  });

  it('gives every feed a variable, a landing place and a question in plain words', () => {
    for (const code of FEED_CODES) {
      const feed = FEEDS[code];
      assert.ok(feed.endpointKey.startsWith('FEED_'), `${code} names no endpoint variable`);
      assert.ok(feed.answers.length > 20, `${code} does not say what it answers`);
      assert.ok(feed.lands.length > 20, `${code} does not say where a reading lands`);
    }
  });
});

describe('a deployment with nothing configured', () => {
  it('refuses, names the variable, and says nothing was invented', async () => {
    // The default state of every deployment, and the one that has to be
    // unambiguous: a screen showing a blank price is indistinguishable from a
    // price of zero unless the platform says which it is.
    await assert.rejects(
      feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' }),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === 'FEED_NOT_CONFIGURED' &&
        // 501: nothing is down and retrying will never help.
        error.status === 501 &&
        error.message.includes('FEED_COMMODITY_URL') &&
        /invented|plausible/.test(error.message),
    );
  });

  it('says the same sentence wherever it is reported', () => {
    for (const code of FEED_CODES) {
      const reason = feedUnavailable(code);
      assert.ok(reason && reason.includes(FEEDS[code].endpointKey), `${code} does not name its variable`);
    }
  });

  it('still lists the unconfigured feeds on the position, with the reason', () => {
    // A screen listing only what works describes a platform with fewer
    // capabilities than it has, and hides the switch from the person who could
    // throw it.
    const position = feeds.feedPosition(asQS());
    assert.equal(position.feeds.length, FEED_CODES.length);
    for (const feed of position.feeds) {
      if (feed.configured) continue;
      assert.ok(feed.reason, `${feed.code} is unconfigured and gives no reason`);
      assert.equal(feed.endpoint, undefined, 'an unconfigured feed should not publish an endpoint');
    }
  });
});

describe('reading a source that answers', () => {
  it('records what it said, with the response’s own hash', async () => {
    received = [];
    reply = {
      status: 200,
      body: JSON.stringify({ date: '2026-09-08', base: 'GBP', rates: { 'steel-rebar': 1284.5, cement: 132 } }),
    };

    const reading = await withFeed('COMMODITY_PRICE', `${base}/prices`, '', () =>
      feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE', query: { symbols: 'steel-rebar,cement' } }),
    );

    assert.equal(reading.feed, 'COMMODITY_PRICE');
    assert.equal(reading.observations.length, 2);
    const rebar = reading.observations.find((o) => o.measure === 'steel-rebar');
    assert.equal(rebar?.value, 1284.5);
    assert.equal(rebar?.unit, 'CURRENCY_PER_UNIT');
    // The source's date, not the moment it was read. A reading dated when it
    // was fetched is a reading nobody can line up against a valuation period.
    assert.equal(rebar?.observedAt, '2026-09-08');
    assert.match(reading.source.responseHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(reading.source.status, 200);
    assert.equal(reading.query.symbols, 'steel-rebar,cement');
    assert.equal(received[0]?.url.includes('symbols=steel-rebar%2Ccement'), true);
  });

  it('puts the reading on the ledger as an event that can be replayed', async () => {
    reply = { status: 200, body: JSON.stringify({ rates: { cement: 140 } }) };
    const reading = await withFeed('COMMODITY_PRICE', `${base}/prices`, '', () =>
      feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' }),
    );
    const record = platform.ledger.get({ refType: 'FeedReading', refId: reading.readingId });
    assert.ok(record, 'the reading is not on the ledger');
    assert.equal((record!.state as unknown as feeds.FeedReading).source.status, 200);
  });

  it('reads the weather shape by index, so a short array drops rows rather than mispairing days', async () => {
    reply = {
      status: 200,
      body: JSON.stringify({
        daily: {
          time: ['2026-09-08', '2026-09-09'],
          temperature_2m_max: [18.4, 17.1],
          // One value short on purpose: read positionally without the guard,
          // day two's rainfall would be filed against a day that has none.
          precipitation_sum: [12.2],
        },
      }),
    };
    const reading = await withFeed('WEATHER_FORECAST', `${base}/weather`, '', () =>
      feeds.readFeed(asSite(), { feed: 'WEATHER_FORECAST', query: { latitude: '53.48', longitude: '-2.24' } }),
    );
    const rain = reading.observations.filter((o) => o.measure === 'precipitation');
    assert.equal(rain.length, 1);
    assert.equal(rain[0]?.observedAt, '2026-09-08');
    assert.equal(reading.observations.filter((o) => o.measure === 'temperature-max').length, 2);
  });

  it('carries the agency’s scale through rather than normalising a credit score', async () => {
    reply = { status: 200, body: JSON.stringify({ agency: 'Example Bureau', score: 74, creditLimit: 250000, status: 'Active' }) };
    const reading = await withFeed('CREDIT_REFERENCE', `${base}/credit`, '', () =>
      feeds.readFeed(asQS(), { feed: 'CREDIT_REFERENCE', query: { company: '01234567' } }),
    );
    const score = reading.observations.find((o) => o.measure === 'credit-score');
    assert.equal(score?.value, 74);
    // Not rescaled to a percentage or a band. Two agencies' scores are not
    // comparable, and a number this platform invented a scale for is one
    // nobody can check against the report it came from.
    assert.match(score?.note ?? '', /Example Bureau/);
    assert.equal(reading.observations.find((o) => o.measure === 'company-status')?.value, 'Active');
  });
});

describe('what leaves the platform, and what is recorded of it', () => {
  it('sends a bearer credential in the header, not in the URL', async () => {
    received = [];
    reply = { status: 200, body: JSON.stringify({ rates: { cement: 1 } }) };
    await withFeed('COMMODITY_PRICE', `${base}/prices`, 'secret-token', () =>
      feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' }),
    );
    assert.equal(received[0]?.authorization, 'Bearer secret-token');
    assert.ok(!received[0]?.url.includes('secret-token'), 'the credential reached the query string');
  });

  it('puts the credential in the URL only where the endpoint asks for it that way', async () => {
    received = [];
    reply = { status: 200, body: JSON.stringify({ rates: { cement: 1 } }) };
    await withFeed('COMMODITY_PRICE', `${base}/prices?key={key}`, 'url-token', () =>
      feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' }),
    );
    assert.ok(received[0]?.url.includes('key=url-token'), received[0]?.url ?? 'no request reached the source');
    // And then it must not also go in the header, which would send the
    // credential twice to a vendor that only needed it once.
    assert.equal(received[0]?.authorization, undefined);
  });

  it('records the host and path but never the query string', async () => {
    reply = { status: 200, body: JSON.stringify({ rates: { cement: 1 } }) };
    const reading = await withFeed('COMMODITY_PRICE', `${base}/prices?key={key}`, 'url-token', () =>
      feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' }),
    );
    // The load-bearing assertion of this whole file. The ledger is append-only:
    // a credential written into it cannot be redacted afterwards, on any
    // deployment, ever.
    assert.ok(!reading.source.endpoint.includes('url-token'), reading.source.endpoint);
    assert.ok(!reading.source.endpoint.includes('?'), reading.source.endpoint);
    assert.ok(!JSON.stringify(reading).includes('url-token'), 'the credential is somewhere in the reading');
    assert.ok(reading.source.endpoint.endsWith('/prices'));
  });
});

describe('the failures that actually happen to a feed', () => {
  it('refuses a source that answers with an error, naming the status and host', async () => {
    reply = { status: 503, body: 'upstream unavailable' };
    await assert.rejects(
      withFeed('COMMODITY_PRICE', `${base}/prices`, '', () => feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' })),
      (error: unknown) =>
        error instanceof DomainError && error.code === 'FEED_REFUSED' && error.message.includes('503'),
    );
  });

  it('refuses a login page where JSON was expected', async () => {
    // What a lapsed subscription actually returns: 200, and HTML.
    reply = { status: 200, body: '<!doctype html><title>Sign in</title>', contentType: 'text/html' };
    await assert.rejects(
      withFeed('COMMODITY_PRICE', `${base}/prices`, '', () => feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' })),
      (error: unknown) => error instanceof DomainError && error.code === 'FEED_NOT_JSON',
    );
  });

  it('refuses a body over the ceiling rather than holding it', async () => {
    const limits = config.feeds as unknown as { maxBytes: number; timeoutMs: number };
    const was = limits.maxBytes;
    limits.maxBytes = 200;
    reply = { status: 200, body: JSON.stringify({ rates: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`m${i}`, i])) }) };
    try {
      await assert.rejects(
        withFeed('COMMODITY_PRICE', `${base}/prices`, '', () => feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' })),
        (error: unknown) => error instanceof DomainError && error.code === 'FEED_RESPONSE_TOO_LARGE',
      );
    } finally {
      limits.maxBytes = was;
    }
  });

  it('refuses valid JSON it could read nothing out of, rather than recording an empty success', async () => {
    // The failure that would otherwise ship. A vendor changes its response
    // shape, the call still returns 200, and an empty reading goes on the
    // record — so the screen shows a blank where a price was and nothing
    // anywhere says why.
    reply = { status: 200, body: JSON.stringify({ data: { series: [{ v: 1284.5 }] } }) };
    await assert.rejects(
      withFeed('COMMODITY_PRICE', `${base}/prices`, '', () => feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' })),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === 'FEED_UNREADABLE' &&
        error.message.includes('changed its response shape') &&
        error.message.includes('Nothing has been recorded'),
    );
  });

  it('gives up on a source that hangs, and records nothing', async () => {
    const limits = config.feeds as unknown as { maxBytes: number; timeoutMs: number };
    const was = limits.timeoutMs;
    limits.timeoutMs = 60;
    reply = { status: 200, body: JSON.stringify({ rates: { cement: 1 } }), delayMs: 400 };
    try {
      await assert.rejects(
        withFeed('COMMODITY_PRICE', `${base}/prices`, '', () => feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' })),
        (error: unknown) => error instanceof DomainError && error.code === 'FEED_TIMEOUT' && error.status === 504,
      );
    } finally {
      limits.timeoutMs = was;
      reply = { status: 200, body: '{}' };
    }
  });

  it('refuses a value that is not a finite number rather than storing NaN', async () => {
    // `Number("about 1284")` is NaN, and a NaN on a price record renders as
    // nothing at all on every screen that shows it.
    reply = { status: 200, body: JSON.stringify({ rates: { 'steel-rebar': 'about 1284', cement: '132.50' } }) };
    const reading = await withFeed('COMMODITY_PRICE', `${base}/prices`, '', () =>
      feeds.readFeed(asQS(), { feed: 'COMMODITY_PRICE' }),
    );
    assert.equal(reading.observations.length, 1);
    assert.equal(reading.observations[0]?.measure, 'cement');
    assert.equal(reading.observations[0]?.value, 132.5);
  });
});

describe('authorisation', () => {
  it('holds a credit reference to procurement authority, not to whoever can see a price', async () => {
    reply = { status: 200, body: JSON.stringify({ score: 60 }) };
    // A site supervisor may read the weather. Reading a firm's credit file is
    // an act on the procurement register and a different authority entirely.
    await assert.rejects(
      withFeed('CREDIT_REFERENCE', `${base}/credit`, '', () => feeds.readFeed(asSite(), { feed: 'CREDIT_REFERENCE' })),
      (error: unknown) => error instanceof Error && /permission|denied|ACCESS/i.test((error as DomainError).code ?? error.message),
    );
  });
});
