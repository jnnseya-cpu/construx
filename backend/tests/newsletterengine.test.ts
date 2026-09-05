import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { config } from '../src/config.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { resolveAudience } from '../src/messaging/audience.ts';
import { campaignForWeek, deliveriesFor, isoWeek, issueNewsletter, latestPosts, previewFor, recordBounce, sendTestIssue } from '../src/messaging/newsletter.ts';
import * as engine from '../src/messaging/newsletterengine.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { authOf } from '../src/seed.ts';
import * as blog from '../src/site/blog.ts';
import * as visibility from '../src/site/visibility.ts';
import { rejectsCode } from './helpers.ts';

/**
 * The newsletter read as a whole: whether what goes out can arrive, whether it
 * has been going out, and what to do next — every check against the rendered
 * message, the configuration and the delivery record rather than a flag.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const smtp = config.smtp as Mutable<typeof config.smtp>;
const newsletterConfig = config.newsletter as Mutable<typeof config.newsletter>;
const configRoot = config as unknown as { publicBaseUrl: string };

describe('the issue carries the blog', () => {
  const platform = new Platform();

  it('carries the newest published posts, compiled and stored alike, in both parts of the message', () => {
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    visibility.composePost(platform, { refType: 'User', refId: operator.id }, { topic: 'A post for the issue', keywords: ['issue carriage'] });
    const posts = latestPosts(platform);
    assert.equal(posts.length, 3);
    assert.match(posts[0]!.title, /^A post for the issue/, 'the post published today leads');
    assert.ok(posts.every((post) => post.url.startsWith(config.publicBaseUrl) && post.url.includes('/blog/')));

    const preview = previewFor({ userId: 'u', tenantId: 't', name: 'A', email: 'a@b.test', roles: [] }, undefined, posts);
    assert.ok(preview.html.includes('From the blog'));
    assert.ok(preview.html.includes(posts[0]!.url));
    assert.ok(preview.text.includes('From the blog'));
    assert.ok(preview.text.includes(posts[0]!.url));
    assert.equal(preview.posts.length, 3);
  });

  it('carries no draft: a draft has no address', () => {
    const operator = platform.createOperator({ name: 'Rowan', email: 'ops2@construx.example' });
    const ctx = platform.context(authOf(platform, operator.id), blog.BLOG_PROJECT_ID, { source: 'WEB' });
    const { post } = blog.writePost(ctx, platform, {
      title: 'A draft that stays out of the issue',
      standfirst: 'Not published, so not linked.',
      metaDescription: 'A draft used to prove the newsletter links only what the public can open on the site.',
      keyword: 'draft',
      body: ['Draft body.'],
    });
    assert.ok(!latestPosts(platform).some((entry) => entry.url.endsWith(post.slug)));
  });
});

describe('the deliverability sweep reads the message and the record', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('weighs to a hundred and judges a fresh deployment for what it is', () => {
    const findings = engine.deliverabilitySweep(platform);
    assert.equal(findings.reduce((sum, finding) => sum + finding.weight, 0), 100);
    const byCheck = new Map(findings.map((finding) => [finding.check, finding]));

    assert.equal(byCheck.get('Relay')!.ok, config.smtp.host !== '');
    assert.equal(byCheck.get('One-click unsubscribe')!.ok, true, byCheck.get('One-click unsubscribe')!.detail);
    assert.equal(byCheck.get('Plain-text part')!.ok, true, byCheck.get('Plain-text part')!.detail);
    assert.equal(byCheck.get('Links resolve')!.ok, true, byCheck.get('Links resolve')!.detail);
    assert.equal(byCheck.get('Message size')!.ok, true);
    assert.equal(byCheck.get('Subject')!.ok, true, byCheck.get('Subject')!.detail);
    assert.equal(byCheck.get('Audience')!.ok, true, byCheck.get('Audience')!.detail);
    assert.match(byCheck.get('Audience')!.detail, new RegExp(`${resolveAudience(platform).recipients.length} recipients`));
    assert.equal(byCheck.get('Bounce health')!.ok, false, 'nothing has gone out');
    assert.equal(byCheck.get('Cadence')!.ok, false);
    assert.match(byCheck.get('Cadence')!.detail, /No issue has gone out yet/);
  });

  it('notices a sender domain that is not the site’s, and links that are not https, from the configuration as loaded', () => {
    const savedBase = configRoot.publicBaseUrl;
    const savedFrom = newsletterConfig.fromAddress;
    try {
      configRoot.publicBaseUrl = 'https://construx.example';
      newsletterConfig.fromAddress = 'hello@construx.example';
      let byCheck = new Map(engine.deliverabilitySweep(platform).map((finding) => [finding.check, finding]));
      assert.equal(byCheck.get('Sender alignment')!.ok, true, byCheck.get('Sender alignment')!.detail);
      assert.equal(byCheck.get('Secure links')!.ok, true, byCheck.get('Secure links')!.detail);
      assert.equal(byCheck.get('Links resolve')!.ok, true, byCheck.get('Links resolve')!.detail);

      newsletterConfig.fromAddress = 'hello@elsewhere.example';
      configRoot.publicBaseUrl = 'http://construx.example';
      byCheck = new Map(engine.deliverabilitySweep(platform).map((finding) => [finding.check, finding]));
      assert.equal(byCheck.get('Sender alignment')!.ok, false);
      assert.match(byCheck.get('Sender alignment')!.detail, /elsewhere\.example .* construx\.example/);
      assert.equal(byCheck.get('Secure links')!.ok, false);
      assert.match(byCheck.get('Secure links')!.detail, /not https/);
    } finally {
      configRoot.publicBaseUrl = savedBase;
      newsletterConfig.fromAddress = savedFrom;
    }
  });

  it('turns cadence and bounce health on the delivery record once an issue goes out, and reads a bounce back', async () => {
    // Through a relay that accepts everything, so the copies are SENT rather
    // than RECORDED — only a message the relay took can bounce later.
    const accepted = { accepted: true, response: '250 2.0.0 Ok: queued as TEST' } as Awaited<ReturnType<typeof import('../src/messaging/smtp.ts').sendMail>>;
    const report = await issueNewsletter(platform, { issuedBy: seed.users.admin!.id, transport: { send: async () => accepted } });
    assert.ok(report.deliveries.length > 0);
    assert.ok(report.deliveries.every((delivery) => delivery.status === 'SENT'));

    let position = engine.newsletterPosition(platform);
    let byCheck = new Map(position.sweep.map((finding) => [finding.check, finding]));
    assert.equal(byCheck.get('Cadence')!.ok, true, byCheck.get('Cadence')!.detail);
    assert.equal(byCheck.get('Bounce health')!.ok, true, byCheck.get('Bounce health')!.detail);
    assert.equal(position.reach.totals.issues, 1);
    assert.equal(position.reach.series.length, 1);
    assert.equal(position.reach.series[0]!.recorded + position.reach.series[0]!.sent, report.deliveries.length);
    assert.equal(position.issue.issued?.id, report.campaign.id);
    assert.equal(position.health.score, position.sweep.filter((finding) => finding.ok).reduce((sum, finding) => sum + finding.weight, 0));

    // A delivery the relay took and a downstream server bounced later: the
    // record changes, and the sweep changes with it. One bounce in a small
    // audience is above the five per cent line.
    const campaign = campaignForWeek(platform, isoWeek(new Date()))!;
    const delivery = deliveriesFor(platform, campaign.id)[0]!;
    recordBounce(platform, {
      email: delivery.email,
      campaignId: campaign.id,
      kind: 'PERMANENT',
      diagnostic: '550 5.1.1 User unknown',
      actorId: seed.users.admin!.id,
    });
    position = engine.newsletterPosition(platform);
    byCheck = new Map(position.sweep.map((finding) => [finding.check, finding]));
    assert.equal(position.reach.series[0]!.bounced, 1);
    assert.equal(position.reach.suppressed, 1);
    if (report.deliveries.length < 20) {
      assert.equal(byCheck.get('Bounce health')!.ok, false, byCheck.get('Bounce health')!.detail);
      assert.ok(position.recommendations.some((item) => item.title === 'Bounces are high' && item.action?.command === 'bounce'));
    }
    assert.ok(position.recommendations.some((item) => item.action?.command === 'suppressions'));
  });

  it('recommends the door that fixes each failure, once, and proposes rather than acts', () => {
    const fresh = new Platform();
    const position = engine.newsletterPosition(fresh);
    const issueDoors = position.recommendations.filter((item) => item.action?.command === 'issue');
    assert.equal(issueDoors.length, 1, 'one line for the one button, not two');
    assert.equal(position.recommendations.filter((item) => item.action?.command === 'configure').length > 0, config.smtp.host === '');
    assert.equal(position.reach.totals.issues, 0, 'reading the position issued nothing');
    assert.equal(position.schedule.enabled, config.newsletter.enabled);
    assert.equal(position.limits.length, 3);
  });

  it('computes the next scheduled send from the configured day and hour, and null while unarmed', () => {
    const savedEnabled = newsletterConfig.enabled;
    const savedDay = newsletterConfig.sendDayUtc;
    const savedHour = newsletterConfig.sendHourUtc;
    try {
      newsletterConfig.enabled = false;
      assert.equal(engine.nextScheduledSend(new Date('2026-09-05T12:00:00Z')), null);
      newsletterConfig.enabled = true;
      newsletterConfig.sendDayUtc = 2; // Tuesday
      newsletterConfig.sendHourUtc = 9;
      // 2026-09-05 is a Saturday; the next Tuesday 09:00 UTC is the 8th.
      assert.equal(engine.nextScheduledSend(new Date('2026-09-05T12:00:00Z')), '2026-09-08T09:00:00.000Z');
      // Inside the send day but past the hour: next week.
      assert.equal(engine.nextScheduledSend(new Date('2026-09-08T10:00:00Z')), '2026-09-15T09:00:00.000Z');
      // Inside the send day before the hour: today.
      assert.equal(engine.nextScheduledSend(new Date('2026-09-08T08:00:00Z')), '2026-09-08T09:00:00.000Z');
    } finally {
      newsletterConfig.enabled = savedEnabled;
      newsletterConfig.sendDayUtc = savedDay;
      newsletterConfig.sendHourUtc = savedHour;
    }
  });
});

describe('the test send', () => {
  const platform = new Platform();
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  const recipient = { userId: operator.id, tenantId: operator.tenantId, name: operator.name, email: operator.email, roles: operator.roles };

  it('is refused while no relay is configured — a test that never leaves proves nothing', async () => {
    assert.equal(config.smtp.host, '', 'this test assumes no SMTP host is configured');
    await rejectsCode(() => sendTestIssue(platform, recipient), 'NO_RELAY');
  });

  it('sends the real message, marked as a test, to the operator’s own address and records nothing against the week', async () => {
    const sent: Array<{ from: string; to: string; raw: string }> = [];
    const result = await sendTestIssue(platform, recipient, {
      transport: {
        send: async (message) => {
          sent.push(message);
          return { accepted: true, response: '250 2.0.0 Ok: queued as TEST' } as Awaited<ReturnType<typeof import('../src/messaging/smtp.ts').sendMail>>;
        },
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, operator.email);
    // The subject carries an em dash, so it travels as an RFC 2047 encoded word.
    const subjectLine = /^Subject: (.+)$/m.exec(sent[0]!.raw)?.[1] ?? '';
    const encoded = /^=\?utf-8\?B\?(.+)\?=$/i.exec(subjectLine)?.[1];
    const subject = encoded ? Buffer.from(encoded, 'base64').toString('utf8') : subjectLine;
    assert.ok(subject.startsWith('[TEST] '), subject);
    assert.match(sent[0]!.raw, /^List-Unsubscribe: /m);
    assert.ok(sent[0]!.raw.includes('From the blog'), 'the test is the real issue, blog section included');
    assert.match(result.response, /^250/);
    assert.equal(campaignForWeek(platform, isoWeek(new Date())), undefined, 'no campaign was created');
  });
});

describe('through the gateway', () => {
  const platform = new Platform();
  let server: Server;
  let base: string;
  let operatorToken: string;
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
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    operatorToken = issueTokens({ actorId: operator.id, tenantId: operator.tenantId, partyId: operator.partyId, roles: operator.roles, mfaSatisfied: true }).accessToken;
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
    assert.equal((await call('GET', '/v1/newsletter/position')).status, 401);
    assert.equal((await call('GET', '/v1/newsletter/position', customerToken)).status, 403);
    assert.equal((await call('POST', '/v1/newsletter/test', customerToken, {})).status, 403);
  });

  it('reads the position and refuses a test with no relay, saying why', async () => {
    const position = await call('GET', '/v1/newsletter/position', operatorToken);
    assert.equal(position.status, 200, JSON.stringify(position.body));
    assert.equal(position.body.sweep.length, 11);
    assert.equal(typeof position.body.health.score, 'number');
    assert.equal(position.body.issue.posts.length, 3);

    const preview = await call('GET', '/v1/me/newsletter', operatorToken);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.preview.posts.length, 3, 'the preview a person sees carries the same posts');

    const test = await call('POST', '/v1/newsletter/test', operatorToken, {});
    assert.equal(test.status, 409, JSON.stringify(test.body));
    assert.equal(test.body.title, 'NO_RELAY');
  });

  it('answers with the relay’s words when a relay is configured', async () => {
    // The engine is configured through the environment; here the relay is
    // pointed at a socket that answers like one, the way the newsletter suite
    // does, so the test route is exercised for what it does.
    const { createServer } = await import('node:net');
    const received: string[] = [];
    const relay = createServer((socket) => {
      let dataMode = false;
      let message = '';
      socket.setEncoding('utf8');
      socket.write('220 test.construx ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        if (dataMode) {
          message += chunk;
          if (message.includes('\r\n.\r\n')) {
            dataMode = false;
            received.push(message.slice(0, message.indexOf('\r\n.\r\n')));
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
    const saved = { host: smtp.host, port: smtp.port, requireTls: smtp.requireTls };
    try {
      smtp.host = '127.0.0.1';
      smtp.port = (relay.address() as { port: number }).port;
      smtp.requireTls = false;
      const test = await call('POST', '/v1/newsletter/test', operatorToken, {});
      // 200, not 201: the route is read-only on the record — it creates nothing.
      assert.equal(test.status, 200, JSON.stringify(test.body));
      assert.equal(test.body.to, 'ops@construx.example');
      assert.match(test.body.response, /^250/);
      assert.equal(received.length, 1);
      assert.match(received[0]!, /Subject: (=\?utf-8\?B\?|\[TEST\])/i);

      const position = await call('GET', '/v1/newsletter/position', operatorToken);
      const relayCheck = position.body.sweep.find((finding: { check: string }) => finding.check === 'Relay');
      assert.equal(relayCheck.ok, true, 'the sweep reads the configuration as loaded');
    } finally {
      smtp.host = saved.host;
      smtp.port = saved.port;
      smtp.requireTls = saved.requireTls;
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  });
});
