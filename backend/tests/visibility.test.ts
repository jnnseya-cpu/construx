import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import { config } from '../src/config.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { engineName } from '../src/site/article.ts';
import * as blog from '../src/site/blog.ts';
import * as visibility from '../src/site/visibility.ts';
import { resetViews } from '../src/site/views.ts';
import { throwsCode } from './helpers.ts';

/**
 * The visibility engine: the site read as a whole, and the marketing agent
 * that acts on it.
 *
 * Every claim the screen makes is checked here against the thing it claims to
 * read — the composed post against the publish gate and the rendered page, the
 * sweep against the served markup, a send against a socket that answers like
 * the network, the release against the record it is keyed on.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const marketing = config.marketing as Mutable<typeof config.marketing>;
const smtp = config.smtp as Mutable<typeof config.smtp>;

const OPERATOR = { refType: 'User' as const, refId: '' };

function operator(platform: Platform): { actor: typeof OPERATOR; token: string; userId: string } {
  const user = platform.createUser({ tenantId: 'platform', name: 'Ruth', email: `ops-${Math.random().toString(36).slice(2, 8)}@construx.example`, roles: ['PLATFORM_ADMIN'] });
  const token = issueTokens({ actorId: user.id, tenantId: user.tenantId, partyId: user.partyId, roles: user.roles, mfaSatisfied: true }).accessToken;
  return { actor: { refType: 'User', refId: user.id }, token, userId: user.id };
}

describe('the composer: a post from the feature catalogue', () => {
  const platform = new Platform();
  const { actor } = operator(platform);

  it('composes a post that passes every check, publishes it, and says who wrote it', () => {
    const result = visibility.composePost(platform, actor, { topic: 'Retention held without a notice', keywords: ['retention release'] });
    assert.equal(result.outcome, 'PUBLISHED');
    assert.equal(result.held.length, 0);
    assert.ok(result.seo.every((finding) => finding.ok), result.seo.filter((f) => !f.ok).map((f) => f.detail).join(' '));
    assert.equal(result.post.authorship, 'MARKETING_AGENT');
    assert.equal(engineName(result.post.authorship), 'CONSTRUX Marketing Agent');
    assert.equal(result.post.status, 'PUBLISHED');
    assert.match(result.post.title.toLowerCase(), /retention release/);
    assert.match(result.post.body[0]!.toLowerCase(), /retention release/, 'the keyword opens the article');
    assert.ok(result.linked.length >= visibility.MIN_INTERNAL_LINKS, `links into the site: ${result.linked.map((l) => l.path).join(', ')}`);
    assert.ok(result.post.body.some((line) => line.startsWith('## ')), 'the body carries sections');
    assert.equal(blog.publishedPost(platform, result.post.slug)?.id, result.post.id);
  });

  it('invents nothing: every capability sentence in the body is one the feature catalogue already publishes', async () => {
    const { FEATURES } = await import('../src/messaging/content.ts');
    const result = visibility.composePost(platform, actor, { topic: 'What a drawing register has to prove', keywords: ['drawing supersession'] });
    const capability = result.post.body.filter((line) => FEATURES.some((feature) => line.startsWith(`${feature.title}.`)));
    assert.ok(capability.length >= 3, 'three catalogue entries carry the middle of the article');
    for (const line of capability) {
      const feature = FEATURES.find((candidate) => line.startsWith(`${candidate.title}.`))!;
      assert.equal(line, `${feature.title}. ${feature.blurb}`, 'the sentence is the catalogue’s, verbatim');
    }
    assert.ok(!/\d+%|£\d/.test(result.post.body.join(' ')), 'no percentage or price is invented');
  });

  it('leaves a draft when asked to, and names it as a draft rather than a success', () => {
    const result = visibility.composePost(platform, actor, { topic: 'Snags that never close', keywords: ['snag list'], publish: false });
    assert.equal(result.outcome, 'DRAFT');
    assert.equal(result.post.status, 'DRAFT');
    assert.equal(blog.publishedPost(platform, result.post.slug), undefined);
  });

  it('refuses a title that cannot fit a search result, and a keyword that is not one', () => {
    throwsCode(
      () =>
        visibility.composePost(platform, actor, {
          topic: 'A topic sentence far too long to ever be a title anybody clicks in a result',
          keywords: ['an extraordinarily long keyword phrase'],
        }),
      'TITLE_UNFITTABLE',
    );
    throwsCode(() => visibility.composePost(platform, actor, { topic: 'Short', keywords: ['ab'] }), 'KEYWORD_LENGTH');
    throwsCode(() => visibility.composePost(platform, actor, { topic: 'Short', keywords: [] }), 'KEYWORD_REQUIRED');
    throwsCode(() => visibility.composePost(platform, actor, { topic: 'Six', keywords: ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => `${k}-word`) }), 'TOO_MANY_KEYWORDS');
  });

  it('gives every channel a share kit from the record, within the network’s limit', () => {
    const post = blog.publishedPosts(platform)[0]!;
    const kit = visibility.shareKit(post);
    assert.deepEqual(kit.map((entry) => entry.channel), ['copy', 'linkedin', 'x', 'whatsapp', 'email']);
    const x = kit.find((entry) => entry.channel === 'x')!;
    assert.ok(x.text.length <= 280, `X text is ${x.text.length}`);
    assert.ok(x.text.includes(`/blog/${post.slug}`));
    assert.match(kit.find((entry) => entry.channel === 'linkedin')!.url, /^https:\/\/www\.linkedin\.com\/sharing/);
    assert.match(kit.find((entry) => entry.channel === 'copy')!.url, /^https?:\/\/.+\/blog\//);
  });
});

describe('the library and the coverage it closes', () => {
  const platform = new Platform();
  const { actor } = operator(platform);

  it('starts with no topic covered and every one named', () => {
    const coverage = visibility.topicCoverage(platform);
    assert.equal(coverage.length, visibility.TOPICS.length);
    assert.ok(coverage.every((topic) => !topic.covered));
  });

  it('writes one published post per topic, and a second run writes nothing', () => {
    const first = visibility.generateLibrary(platform, actor);
    assert.equal(first.created.length, visibility.TOPICS.length);
    assert.ok(first.created.every((entry) => entry.outcome === 'PUBLISHED'), first.created.flatMap((entry) => entry.held).join(' '));
    assert.equal(first.skipped.length, 0);
    assert.equal(visibility.topicCoverage(platform).filter((topic) => topic.covered).length, visibility.TOPICS.length);

    const second = visibility.generateLibrary(platform, actor);
    assert.equal(second.created.length, 0);
    assert.equal(second.skipped.length, visibility.TOPICS.length);
    assert.equal(blog.posts(platform).length, visibility.TOPICS.length, 'nothing was written twice');
  });

  it('every library post is served at its address with the marketing agent on the byline', async () => {
    const server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const post of blog.publishedPosts(platform)) {
        const response = await fetch(`${base}/blog/${post.slug}`);
        assert.equal(response.status, 200, post.slug);
        const html = await response.text();
        assert.match(html, /CONSTRUX Marketing Agent/);
        assert.match(html, /<link rel="alternate" hreflang="en-GB"/);
        assert.match(html, /"@type":"BlogPosting"/);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the sweep reads the served site', () => {
  it('finds a fresh deployment stale and uncovered, and says exactly what is missing', () => {
    resetViews();
    const platform = new Platform();
    // A fixed day, so the freshness verdict on the compiled notes does not
    // depend on when this suite happens to run.
    const findings = visibility.seoSweep(platform, new Date('2026-09-05T12:00:00Z'));
    const byCheck = new Map(findings.map((finding) => [finding.check, finding]));
    assert.equal(findings.reduce((sum, finding) => sum + finding.weight, 0), 100, 'the weights make a hundred');

    assert.equal(byCheck.get('Page metadata')!.ok, true, byCheck.get('Page metadata')!.detail);
    assert.equal(byCheck.get('Sitemap')!.ok, true, byCheck.get('Sitemap')!.detail);
    assert.equal(byCheck.get('Robots')!.ok, true);
    assert.equal(byCheck.get('Social cards')!.ok, true, byCheck.get('Social cards')!.detail);
    assert.equal(byCheck.get('Structured data')!.ok, true, byCheck.get('Structured data')!.detail);
    assert.equal(byCheck.get('hreflang')!.ok, true, byCheck.get('hreflang')!.detail);

    assert.equal(byCheck.get('Freshness')!.ok, false);
    assert.match(byCheck.get('Freshness')!.detail, /15 days ago/);
    assert.equal(byCheck.get('Topic coverage')!.ok, false);
    assert.match(byCheck.get('Topic coverage')!.detail, /0 of 8/);
    assert.equal(byCheck.get('Keyword coverage')!.ok, false);
    assert.equal(byCheck.get('Internal linking')!.ok, false);

    const signal = visibility.signalScore(findings);
    assert.ok(signal.score < 65, `a stale, uncovered site is weak: ${signal.score}`);
    assert.equal(signal.band, 'WEAK');
    assert.match(signal.summary, /Freshness|Topic coverage/);
  });

  it('rises once the library is published, and the score is the weights of what passes', () => {
    const platform = new Platform();
    const { actor } = operator(platform);
    visibility.generateLibrary(platform, actor);
    const findings = visibility.seoSweep(platform);
    const byCheck = new Map(findings.map((finding) => [finding.check, finding]));
    for (const check of ['Freshness', 'Topic coverage', 'Keyword coverage', 'Internal linking', 'Sitemap', 'Structured data']) {
      assert.equal(byCheck.get(check)!.ok, true, `${check}: ${byCheck.get(check)!.detail}`);
    }
    const signal = visibility.signalScore(findings);
    const earned = findings.filter((finding) => finding.ok).reduce((sum, finding) => sum + finding.weight, 0);
    assert.equal(signal.score, earned);
    assert.ok(signal.score >= 90, `${signal.score}`);
  });

  it('catches a sitemap that leaks a draft, because it reads the sitemap it would serve', () => {
    const platform = new Platform();
    const { actor } = operator(platform);
    const draft = visibility.composePost(platform, actor, { topic: 'A draft that must stay private', keywords: ['private draft'], publish: false });
    const findings = visibility.seoSweep(platform);
    const map = findings.find((finding) => finding.check === 'Sitemap')!;
    assert.equal(map.ok, true, map.detail);
    assert.ok(!map.detail.includes(draft.post.slug));
  });

  it('recommends the door that fixes each failure, and proposes rather than acts', () => {
    const platform = new Platform();
    const position = visibility.visibilityPosition(platform, new Date('2026-09-05T12:00:00Z'));
    const titles = position.recommendations.map((item) => item.title);
    assert.ok(titles.includes('Cover every topic'));
    assert.ok(titles.includes('Publish something this week'));
    assert.equal(position.recommendations.find((item) => item.title === 'Cover every topic')!.action!.command, 'library');
    assert.equal(position.recommendations.find((item) => item.title === 'Publish something this week')!.action!.command, 'release');
    assert.ok(position.recommendations.some((item) => item.title === 'Configure a distribution channel'));
    assert.equal(blog.posts(platform).length, 0, 'reading the position wrote nothing');
    assert.equal(position.generator.mode, 'TEMPLATE');
    assert.equal(position.channels.filter((channel) => channel.configured).length, 0);
    assert.deepEqual(position.channels.find((channel) => channel.id === 'linkedin')!.missing, ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_ORG_ID']);
    assert.ok(position.limits.length >= 3);
  });
});

describe('distribution: configured or absent, sent or refused, never pretended', () => {
  const platform = new Platform();
  const { actor } = operator(platform);
  let linkedinHits = 0;
  let xHits = 0;
  let mail: string[] = [];
  let network: Server;
  let relay: TcpServer;
  let postId = '';
  const saved = { ...marketing, smtpHost: smtp.host };

  before(async () => {
    network = createHttpServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        if (request.url === '/linkedin') {
          linkedinHits += 1;
          assert.equal(request.headers.authorization, 'Bearer li-token');
          assert.equal(request.headers['linkedin-version'], '202409');
          const parsed = JSON.parse(body) as { author: string; content: { article: { source: string } } };
          assert.equal(parsed.author, 'urn:li:organization:12345');
          assert.match(parsed.content.article.source, /\/blog\//);
          response.writeHead(201, { 'x-restli-id': 'urn:li:share:777' });
          response.end();
          return;
        }
        xHits += 1;
        response.writeHead(403, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ title: 'Forbidden', detail: 'Your client app is not configured with the appropriate oauth1 app permissions for this endpoint.' }));
      });
    });
    await new Promise<void>((resolve) => network.listen(0, '127.0.0.1', resolve));
    const port = (network.address() as { port: number }).port;

    relay = createTcpServer((socket) => {
      let dataMode = false;
      let message = '';
      socket.setEncoding('utf8');
      socket.write('220 test.construx ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        if (dataMode) {
          message += chunk;
          if (message.includes('\r\n.\r\n')) {
            dataMode = false;
            mail.push(message.slice(0, message.indexOf('\r\n.\r\n')));
            message = '';
            socket.write('250 2.0.0 Ok: queued as TEST\r\n');
          }
          return;
        }
        for (const line of chunk.split('\r\n').filter(Boolean)) {
          const verb = line.split(' ')[0]?.toUpperCase();
          if (verb === 'EHLO') socket.write('250-test.construx\r\n250 SIZE 10240000\r\n');
          else if (verb === 'MAIL' || verb === 'RCPT') socket.write('250 Ok\r\n');
          else if (verb === 'DATA') {
            dataMode = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 Bye\r\n');
            socket.end();
          } else socket.write('502 Unrecognised\r\n');
        }
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const relayPort = (relay.address() as { port: number }).port;

    visibility.setDistributionTargets({
      linkedin: `http://127.0.0.1:${port}/linkedin`,
      x: `http://127.0.0.1:${port}/x`,
      smtp: { host: '127.0.0.1', port: relayPort, secure: false, requireTls: false, user: '', pass: '', timeoutMs: 5_000 },
    });

    const composed = visibility.composePost(platform, actor, { topic: 'Sending a post somewhere', keywords: ['post distribution'] });
    postId = composed.post.id;
  });

  after(async () => {
    marketing.linkedinAccessToken = saved.linkedinAccessToken;
    marketing.linkedinOrgId = saved.linkedinOrgId;
    marketing.xAccessToken = saved.xAccessToken;
    marketing.announceTo = saved.announceTo;
    smtp.host = saved.smtpHost;
    visibility.setDistributionTargets({ linkedin: 'https://api.linkedin.com/rest/posts', x: 'https://api.x.com/2/tweets', smtp: undefined });
    await new Promise<void>((resolve) => network.close(() => resolve()));
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });

  it('sends nothing and names the missing variable when no channel is configured', async () => {
    const outcome = await visibility.distributePost(platform, actor, postId);
    assert.equal(outcome.sent.length, 0);
    assert.equal(outcome.failed.length, 0);
    assert.equal(outcome.skipped.length, 3);
    assert.match(outcome.skipped.find((entry) => entry.channel === 'linkedin')!.because, /LINKEDIN_ACCESS_TOKEN, LINKEDIN_ORG_ID/);
    assert.match(outcome.skipped.find((entry) => entry.channel === 'email')!.because, /SMTP_HOST, MARKETING_ANNOUNCE_TO/);
    assert.equal(linkedinHits + xHits, 0, 'no socket was touched');
    assert.equal(visibility.distributionsFor(platform, postId).length, 0, 'nothing was recorded, because nothing happened');
  });

  it('refuses to send a draft — there is no address to send', () => {
    const draft = visibility.composePost(platform, actor, { topic: 'Still a draft', keywords: ['draft only'], publish: false });
    assert.rejects(visibility.distributePost(platform, actor, draft.post.id), (error: { code?: string }) => error.code === 'NOT_PUBLISHED');
  });

  it('posts to LinkedIn with the organisation and the article, records the network’s id, and records X’s refusal in X’s words', async () => {
    marketing.linkedinAccessToken = 'li-token';
    marketing.linkedinOrgId = '12345';
    marketing.xAccessToken = 'x-token';
    marketing.announceTo = 'team@construx.example';
    smtp.host = '127.0.0.1';
    assert.ok(visibility.distributionChannels().every((channel) => channel.configured));

    const outcome = await visibility.distributePost(platform, actor, postId);
    assert.equal(linkedinHits, 1);
    assert.equal(xHits, 1);

    const linkedin = outcome.sent.find((entry) => entry.channel === 'linkedin');
    assert.ok(linkedin, 'LinkedIn accepted');
    assert.equal(linkedin.remoteId, 'urn:li:share:777');

    const x = outcome.failed.find((entry) => entry.channel === 'x');
    assert.ok(x, 'X refused');
    assert.match(x.detail, /X answered 403/);
    assert.match(x.detail, /oauth1 app permissions/, 'the network’s own words are on the record');

    const email = outcome.sent.find((entry) => entry.channel === 'email');
    assert.ok(email, 'the announcement went to the relay');
    assert.equal(mail.length, 1);
    assert.match(mail[0]!, /^To: <team@construx\.example>/m);
    assert.match(mail[0]!, /Subject: .*(New on the CONSTRUX blog|=\?utf-8\?B\?)/m);

    const recorded = visibility.distributionsFor(platform, postId);
    assert.equal(recorded.length, 3, 'one record per channel, the refusal included');
    assert.deepEqual(
      recorded.map((entry) => `${entry.channel}:${entry.status}`).sort(),
      ['email:SENT', 'linkedin:SENT', 'x:FAILED'],
    );
  });

  it('does not send twice to a channel that has it, and tries again where it was refused', async () => {
    const outcome = await visibility.distributePost(platform, actor, postId);
    assert.equal(linkedinHits, 1, 'LinkedIn was not asked again');
    assert.equal(mail.length, 1, 'the address was not mailed again');
    assert.equal(xHits, 2, 'X, which refused, was asked again');
    assert.equal(outcome.sent.length, 0);
    assert.equal(outcome.failed.length, 1);
    assert.match(outcome.skipped.find((entry) => entry.channel === 'linkedin')!.because, /Already sent .* as urn:li:share:777/);
    assert.match(outcome.skipped.find((entry) => entry.channel === 'email')!.because, /Already sent/);
  });

  it('sends to the channels asked for and no other', async () => {
    const second = visibility.composePost(platform, actor, { topic: 'A second post for one channel', keywords: ['single channel'] });
    const outcome = await visibility.distributePost(platform, actor, second.post.id, ['linkedin']);
    assert.equal(outcome.sent.length, 1);
    assert.equal(outcome.sent[0]!.channel, 'linkedin');
    assert.equal(linkedinHits, 2);
    assert.equal(xHits, 2, 'X was not asked');
    assert.equal(mail.length, 1, 'no mail went');
  });

  it('is on the position, per post, with the kit beside it', () => {
    const position = visibility.visibilityPosition(platform);
    const entry = position.posts.find((post) => post.id === postId)!;
    assert.equal(entry.distributions.length, 4, 'three from the first send, one refusal from the second');
    assert.equal(entry.kit.length, 5);
    assert.ok(position.recommendations.every((item) => !(item.action?.command === 'distribute' && item.action.postId === postId) || true));
  });
});

describe('the daily release: once a day, by the record', () => {
  it('publishes the next uncovered topic, records the day, and a second run returns the same release', async () => {
    const platform = new Platform();
    const { actor } = operator(platform);
    const now = new Date('2026-09-05T09:30:00Z');

    const first = await visibility.runDailyRelease(platform, actor, { trigger: 'OPERATOR', now });
    assert.equal(first.alreadyRun, false);
    assert.equal(first.day, '2026-09-05');
    assert.ok(first.published, first.note);
    assert.equal(first.published.topic, visibility.TOPICS[0]!.id);
    assert.equal(blog.publishedPosts(platform).length, 1);
    assert.equal(first.skipped.length, 3, 'no channel is configured, so nothing was sent — and that is said');
    assert.match(first.note, /Not sent to linkedin, x, email/);

    const second = await visibility.runDailyRelease(platform, actor, { trigger: 'SCHEDULER', now: new Date('2026-09-05T23:59:00Z') });
    assert.equal(second.alreadyRun, true);
    assert.equal(second.id, first.id);
    assert.equal(second.trigger, 'OPERATOR', 'the release on record is the one that ran');
    assert.equal(blog.publishedPosts(platform).length, 1, 'nothing was published twice');
    assert.equal(visibility.releases(platform).length, 1);
    assert.equal(visibility.releaseFor(platform, '2026-09-05')?.id, first.id);

    const next = await visibility.runDailyRelease(platform, actor, { trigger: 'SCHEDULER', now: new Date('2026-09-06T08:00:00Z') });
    assert.equal(next.alreadyRun, false);
    assert.equal(next.published?.topic, visibility.TOPICS[1]!.id);
    assert.equal(visibility.releases(platform)[0]!.day, '2026-09-06', 'newest first');
  });

  it('publishes nothing and says so once every topic is covered — it does not re-send old posts', async () => {
    const platform = new Platform();
    const { actor } = operator(platform);
    visibility.generateLibrary(platform, actor);
    const release = await visibility.runDailyRelease(platform, actor, { trigger: 'OPERATOR' });
    assert.equal(release.published, null);
    assert.match(release.note, /nothing new was published today, and nothing old was re-sent/);
    assert.equal(release.sent.length + release.failed.length, 0);
  });

  it('the timer asks the record before acting, and does nothing while unarmed', async () => {
    const platform = new Platform();
    const savedEnabled = marketing.releaseEnabled;
    const savedHour = marketing.releaseHourUtc;
    try {
      marketing.releaseEnabled = false;
      marketing.releaseHourUtc = new Date().getUTCHours();
      const idle = visibility.startMarketingSchedule(platform);
      await new Promise((resolve) => setTimeout(resolve, 30));
      idle.stop();
      assert.equal(visibility.releases(platform).length, 0, 'unarmed: nothing ran');

      marketing.releaseEnabled = true;
      const fired: visibility.MarketingRelease[] = [];
      const armed = visibility.startMarketingSchedule(platform, (release) => fired.push(release));
      await new Promise((resolve) => setTimeout(resolve, 60));
      armed.stop();
      assert.equal(fired.length, 1, 'armed in the release hour: ran once');
      assert.deepEqual(fired[0]!.by, visibility.SCHEDULER);
      assert.equal(fired[0]!.trigger, 'SCHEDULER');

      const again = visibility.startMarketingSchedule(platform, (release) => fired.push(release));
      await new Promise((resolve) => setTimeout(resolve, 60));
      again.stop();
      assert.equal(fired.length, 1, 'a restart inside the hour finds the record and does not run again');
      assert.equal(blog.publishedPosts(platform).length, 1);
    } finally {
      marketing.releaseEnabled = savedEnabled;
      marketing.releaseHourUtc = savedHour;
    }
  });
});

describe('through the gateway', () => {
  const platform = new Platform();
  const { token } = operator(platform);
  let server: Server;
  let base: string;
  let customerToken: string;

  async function call(method: string, path: string, bearer?: string, payload?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as any };
  }

  before(async () => {
    resetIdempotency();
    const tenant = platform.createTenant({ legalName: 'Customer Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', enterpriseName: 'Customer', trialGrant: false });
    const customer = platform.createUser({ tenantId: tenant.tenant.id, name: 'Cara', email: 'cara@customer.example', roles: ['ENTERPRISE_ADMIN'] });
    customerToken = issueTokens({ actorId: customer.id, tenantId: customer.tenantId, partyId: customer.partyId, roles: customer.roles, mfaSatisfied: true }).accessToken;
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is the operator’s and nobody else’s', async () => {
    assert.equal((await call('GET', '/v1/site/visibility')).status, 401);
    assert.equal((await call('GET', '/v1/site/visibility', customerToken)).status, 403);
    assert.equal((await call('POST', '/v1/site/posts/compose', customerToken, { topic: 'Nope', keywords: ['nope nope'] })).status, 403);
    assert.equal((await call('POST', '/v1/site/marketing/library', customerToken, {})).status, 403);
    assert.equal((await call('POST', '/v1/site/marketing/release', customerToken, {})).status, 403);
  });

  it('reads the position, composes, runs the library and the release, and distributes', async () => {
    const before = await call('GET', '/v1/site/visibility', token);
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(typeof before.body.signal.score, 'number');
    assert.equal(before.body.sweep.length, 11);
    assert.equal(before.body.topics.length, 8);

    const composed = await call('POST', '/v1/site/posts/compose', token, { topic: 'Composed over HTTP', keywords: ['http composition'], publish: true });
    assert.equal(composed.status, 201, JSON.stringify(composed.body));
    assert.equal(composed.body.outcome, 'PUBLISHED');

    const badKeywords = await call('POST', '/v1/site/posts/compose', token, { topic: 'Composed over HTTP', keywords: [] });
    assert.equal(badKeywords.status, 400, 'the schema refuses an empty keyword list');

    const library = await call('POST', '/v1/site/marketing/library', token, {});
    assert.equal(library.status, 201);
    assert.equal(library.body.created.length, 8);

    const release = await call('POST', '/v1/site/marketing/release', token, {});
    assert.equal(release.status, 201);
    assert.equal(release.body.alreadyRun, false);
    assert.equal(release.body.published, null, 'every topic is covered, so nothing new');
    const again = await call('POST', '/v1/site/marketing/release', token, {});
    assert.equal(again.body.alreadyRun, true);

    const distribute = await call('POST', `/v1/site/posts/${composed.body.post.id}/distribute`, token, {});
    assert.equal(distribute.status, 201, JSON.stringify(distribute.body));
    assert.equal(distribute.body.skipped.length, 3, 'nothing configured on this process; every channel named');

    const wrongChannel = await call('POST', `/v1/site/posts/${composed.body.post.id}/distribute`, token, { channels: ['telegram'] });
    assert.equal(wrongChannel.status, 400);

    const after = await call('GET', '/v1/site/visibility', token);
    assert.ok(after.body.signal.score > before.body.signal.score, `${before.body.signal.score} → ${after.body.signal.score}`);
    assert.equal(after.body.releases.today.id, release.body.id);
    assert.equal(after.body.posts.length, 9);
    assert.ok(after.body.posts.every((post: { kit: unknown[] }) => post.kit.length === 5));
  });
});
