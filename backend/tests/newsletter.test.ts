import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { readdirSync } from 'node:fs';
import { config } from '../src/config.ts';
import {
  readConsent,
  resolveAudience,
  resolveUnsubscribe,
  setConsent,
  unsubscribeToken,
  verifyUnsubscribeToken,
} from '../src/messaging/audience.ts';
import { FEATURES, featuresFor, STANDING_LINKS } from '../src/messaging/content.ts';
import {
  campaignForWeek,
  deliveriesFor,
  isoWeek,
  issueNewsletter,
  previewFor,
} from '../src/messaging/newsletter.ts';
import { buildMime, renderCampaign } from '../src/messaging/render.ts';
import { sendMail } from '../src/messaging/smtp.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/** Page ids taken from the application itself, not from a list kept in step. */
const PAGE_IDS = readdirSync(new URL('../../frontend/pages/', import.meta.url))
  .filter((file) => file.endsWith('.js') && file !== 'index.js')
  .map((file) => file.replace('.js', ''));

/**
 * The weekly newsletter.
 *
 * The tests worth having are the ones about restraint: that it does not send
 * to someone who said no, that a forged link cannot unsubscribe a stranger,
 * that pressing the button twice does not mail the customer base twice, and
 * that a message which never left the process is not reported as delivered.
 */

describe('newsletter content', () => {
  it('links only to screens that exist', () => {
    // Marketing copy is the easiest thing in a codebase to invent. This is the
    // check that stops the newsletter promising a page the router cannot serve.
    for (const feature of FEATURES) {
      const page = feature.path.replace(/^\/app\/?/, '').split('/')[0] ?? '';
      assert.ok(PAGE_IDS.includes(page), `${feature.id} links to /app/${page}, which is not a page`);
    }
    for (const link of STANDING_LINKS) {
      const ok = link.path === '/app' || link.path.startsWith('/#') || PAGE_IDS.includes(link.path.replace('/app/', ''));
      assert.ok(ok, `standing link ${link.path} does not resolve`);
    }
  });

  it('says something to every role rather than leaving one with an empty issue', () => {
    for (const role of ['QS', 'PM', 'PLANNER', 'SAFETY', 'FM', 'DESIGNER', 'SUPERVISOR', 'OWNER'] as const) {
      assert.ok(featuresFor([role]).length >= 3, `${role} would receive an almost empty newsletter`);
    }
  });

  it('leads with what the reader does, not with a fixed running order', () => {
    const forQs = featuresFor(['QS']).map((f) => f.id);
    const forPlanner = featuresFor(['PLANNER']).map((f) => f.id);

    assert.notDeepEqual(forQs, forPlanner, 'every role receives an identically ordered issue');
    assert.equal(forPlanner[0], 'programme', 'a planner should be led with the programme');
  });
});

describe('rendering', () => {
  const recipient = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    name: 'Amara Osei',
    email: 'amara@example.test',
    roles: ['QS' as const],
  };

  it('produces an HTML and a plain-text part that agree', () => {
    const rendered = renderCampaign({ week: '2026-W34', subject: 'S', headline: 'H', intro: 'I' }, recipient);

    for (const feature of featuresFor(recipient.roles)) {
      assert.ok(rendered.html.includes(feature.path), `HTML part omits ${feature.id}`);
      assert.ok(rendered.text.includes(feature.path), `text part omits ${feature.id}`);
    }
    assert.ok(rendered.text.includes('Unsubscribe:'), 'the text part must carry a way out');
    assert.ok(rendered.html.includes('/unsubscribe?'), 'the HTML part must carry a way out');
  });

  it('escapes a name rather than letting it become markup', () => {
    const rendered = renderCampaign(
      { week: '2026-W34', subject: 'S', headline: 'H', intro: 'I' },
      { ...recipient, name: '<script>alert(1)</script>' },
    );
    assert.ok(!rendered.html.includes('<script>'), 'a display name reached the document as markup');
    assert.ok(rendered.html.includes('&lt;script&gt;'));
  });

  it('builds a message a relay will accept', () => {
    const raw = buildMime({
      to: recipient.email,
      toName: recipient.name,
      subject: 'Weekly',
      html: '<p>hello</p>',
      text: 'hello',
      unsubscribe: 'https://construx.test/unsubscribe?u=1&t=2',
      messageId: 'abc',
    });

    assert.ok(raw.includes('MIME-Version: 1.0'));
    assert.ok(raw.includes('Content-Type: multipart/alternative'));
    assert.ok(raw.includes('text/plain; charset=utf-8'));
    assert.ok(raw.includes('text/html; charset=utf-8'));
    // One-click unsubscribe is what keeps the spam button from being the only
    // way out, which is a deliverability property rather than a nicety.
    assert.ok(raw.includes('List-Unsubscribe: <https://construx.test/unsubscribe?u=1&t=2>'));
    assert.ok(raw.includes('List-Unsubscribe-Post: List-Unsubscribe=One-Click'));
    assert.ok(raw.split('\r\n').length > 10, 'headers must be CRLF separated');
  });

  it('encodes a non-ASCII subject rather than putting raw bytes in a header', () => {
    const raw = buildMime({
      to: 'a@b.test',
      toName: 'Zoë Fernández',
      subject: 'Programme — week 34',
      html: '<p>x</p>',
      text: 'x',
      unsubscribe: 'https://construx.test/u',
      messageId: 'abc',
    });

    assert.ok(raw.includes('=?UTF-8?B?'), 'a header with non-ASCII must be RFC 2047 encoded');
    const headerBlock = raw.slice(0, raw.indexOf('\r\n\r\n'));
    // eslint-disable-next-line no-control-regex -- asserting the ASCII range holds
    assert.ok(/^[\x00-\x7f]*$/.test(headerBlock), 'headers contain raw non-ASCII bytes');
  });
});

describe('consent and the unsubscribe link', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('signs a link that cannot be forged for someone else', () => {
    const qs = seed.users.qs!.id;
    const pm = seed.users.pm!.id;

    assert.ok(verifyUnsubscribeToken(qs, unsubscribeToken(qs)));
    assert.ok(!verifyUnsubscribeToken(pm, unsubscribeToken(qs)), 'one person’s token unsubscribed another');
    assert.ok(!verifyUnsubscribeToken(qs, 'not-a-token'));
    assert.ok(!verifyUnsubscribeToken(qs, ''));
  });

  it('refuses a forged link and an unknown user with the same answer', () => {
    // Distinguishing them would turn the endpoint into a registration oracle.
    throwsCode(() => resolveUnsubscribe(platform, seed.users.qs!.id, 'forged'), 'INVALID_UNSUBSCRIBE_TOKEN');
    throwsCode(
      () => resolveUnsubscribe(platform, 'no-such-user', unsubscribeToken('no-such-user')),
      'INVALID_UNSUBSCRIBE_TOKEN',
    );
  });

  it('records the decision in the ledger rather than on the user', () => {
    const user = platform.user(seed.users.fm!.id);
    setConsent(platform, { user, subscribed: false, source: 'UNSUBSCRIBE_LINK', actorId: user.id });

    const consent = readConsent(platform, user.id);
    assert.equal(consent?.subscribed, false);
    assert.equal(consent?.source, 'UNSUBSCRIBE_LINK');
    assert.ok(consent?.decidedAt);
  });

  it('drops the person who said no, and says who else it dropped and why', () => {
    const { recipients, excluded } = resolveAudience(platform);

    assert.ok(!recipients.some((r) => r.userId === seed.users.fm!.id), 'an unsubscribed person is still in the audience');
    assert.ok(excluded.some((e) => e.userId === seed.users.fm!.id && e.reason === 'UNSUBSCRIBED'));
    // The regulator holds an oversight identity, not a customer relationship.
    assert.ok(
      excluded.some((e) => e.userId === seed.users.regulator!.id && e.reason === 'ROLE_EXCLUDED'),
      'the Building Safety Regulator was marketed to',
    );
    assert.ok(recipients.every((r) => r.email.includes('@')), 'an unusable address reached the audience');
  });

  it('lets someone opt back in', () => {
    const user = platform.user(seed.users.fm!.id);
    setConsent(platform, { user, subscribed: true, source: 'PREFERENCE_PAGE', actorId: user.id });

    assert.equal(readConsent(platform, user.id)?.subscribed, true);
    assert.ok(resolveAudience(platform).recipients.some((r) => r.userId === user.id));
  });
});

describe('issuing', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('computes ISO weeks the way a person means them', () => {
    assert.equal(isoWeek(new Date('2026-08-17T00:00:00Z')), '2026-W34');
    // 2027 opens mid-week, so 1 January belongs to the last week of 2026.
    assert.equal(isoWeek(new Date('2027-01-01T00:00:00Z')), '2026-W53');
    assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026-W01');
  });

  it('sends to the audience and records an outcome for every recipient', async () => {
    const report = await issueNewsletter(platform, { issuedBy: seed.users.admin!.id });
    const { recipients } = resolveAudience(platform);

    assert.equal(report.alreadyIssued, false);
    assert.equal(report.deliveries.length, recipients.length);
    assert.ok(report.deliveries.length > 0, 'the seeded platform has nobody to write to');
    assert.equal(report.campaign.issuedBy, seed.users.admin!.id, 'the issuer must be recorded, not inferred');
  });

  it('does not claim delivery for a message that never left the process', () => {
    // No SMTP host is configured in this environment, so every outcome must be
    // RECORDED. Reporting these as SENT is the exact failure this test exists for.
    assert.equal(config.smtp.host, '', 'this test assumes no SMTP host is configured');

    const campaign = campaignForWeek(platform, isoWeek(new Date()))!;
    const deliveries = deliveriesFor(platform, campaign.id);

    assert.ok(deliveries.length > 0);
    assert.ok(deliveries.every((d) => d.status === 'RECORDED'), 'a message was reported as sent without an SMTP host');
    assert.equal(campaign.channel, 'RECORD_ONLY');
  });

  it('refuses to mail the same week twice', async () => {
    const again = await issueNewsletter(platform, { issuedBy: seed.users.admin!.id });

    assert.equal(again.alreadyIssued, true, 'a second issue went out in the same week');
    assert.equal(again.sent + again.recorded + again.failed, 0, 'the customer base was written to twice');
  });

  it('refuses a forced re-issue when there is nothing that failed', async () => {
    await rejectsCode(
      () => issueNewsletter(platform, { issuedBy: seed.users.admin!.id, force: true }),
      'CAMPAIGN_ALREADY_ISSUED',
    );
  });

  it('shows a person exactly what they would receive without sending it', () => {
    const before = deliveriesFor(platform, campaignForWeek(platform, isoWeek(new Date()))!.id).length;
    const user = platform.user(seed.users.pm!.id);

    const preview = previewFor({
      userId: user.id,
      tenantId: user.tenantId,
      name: user.name,
      email: user.email,
      roles: user.roles,
    });

    assert.ok(preview.subject.length > 0);
    assert.ok(preview.html.includes(user.email), 'the preview must show the address it would go to');
    assert.equal(
      deliveriesFor(platform, campaignForWeek(platform, isoWeek(new Date()))!.id).length,
      before,
      'previewing sent something',
    );
  });

  it('produces the same issue for the same week, so a retry is not a different email', () => {
    const first = previewFor(
      { userId: 'u', tenantId: 't', name: 'A', email: 'a@b.test', roles: ['QS'] },
      '2026-W34',
    );
    const second = previewFor(
      { userId: 'u', tenantId: 't', name: 'A', email: 'a@b.test', roles: ['QS'] },
      '2026-W34',
    );
    assert.equal(first.subject, second.subject);
    assert.deepEqual(first.features, second.features);
  });
});

describe('SMTP transport', () => {
  let server: Server;
  let port: number;
  let received: string[] = [];

  /**
   * A minimal SMTP server, so the client is verified against a socket rather
   * than against a mock of itself. It speaks only what submission requires and
   * deliberately splits its EHLO reply across continuation lines, which is
   * where a naive client desynchronises.
   */
  before(async () => {
    server = createServer((socket) => {
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
          if (verb === 'EHLO') socket.write('250-test.construx\r\n250-SIZE 10240000\r\n250 AUTH PLAIN LOGIN\r\n');
          else if (verb === 'AUTH') socket.write('235 2.7.0 Authentication successful\r\n');
          else if (verb === 'MAIL') socket.write('250 2.1.0 Ok\r\n');
          else if (verb === 'RCPT') socket.write('250 2.1.5 Ok\r\n');
          else if (verb === 'DATA') {
            dataMode = true;
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
          } else if (verb === 'QUIT') {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
          } else socket.write('502 5.5.2 Unrecognised\r\n');
        }
      });
      socket.on('error', () => {});
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  after(() => server.close());

  const options = {
    host: '127.0.0.1',
    port: 0,
    secure: false,
    requireTls: false,
    user: 'construx',
    pass: 'secret',
    timeoutMs: 5_000,
  };

  it('completes the submission conversation and delivers the message body', async () => {
    received = [];
    const raw = buildMime({
      to: 'reader@example.test',
      toName: 'Reader',
      subject: 'Weekly',
      html: '<p>hello</p>',
      text: 'hello',
      unsubscribe: 'https://construx.test/unsubscribe?u=1&t=2',
      messageId: 'msg-1',
    });

    const result = await sendMail({ from: 'hello@construx.ai', to: 'reader@example.test', raw }, { ...options, port });

    assert.equal(result.accepted, true);
    assert.match(result.response, /^250/);
    assert.equal(received.length, 1);
    assert.ok(received[0]!.includes('Subject: Weekly'));
    assert.ok(received[0]!.includes('List-Unsubscribe:'));
  });

  it('escapes a line that would otherwise end the message early', async () => {
    received = [];
    // A body line of "." terminates DATA. Without dot-stuffing the message is
    // truncated exactly where its content chose, which is a correctness bug and
    // an injection point at the same time.
    const raw = ['Subject: Dots', '', 'first', '.', 'second'].join('\r\n');

    await sendMail({ from: 'a@construx.ai', to: 'b@example.test', raw }, { ...options, port });

    assert.ok(received[0]!.includes('\r\n..\r\n'), 'a leading dot was not stuffed');
    assert.ok(received[0]!.includes('second'), 'the message was truncated at the dot');
  });

  it('reports a refusal rather than pretending the message went', async () => {
    const closed = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write('220 test.construx ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        if (chunk.startsWith('EHLO')) socket.write('250 test.construx\r\n');
        else if (chunk.startsWith('MAIL')) socket.write('550 5.1.8 Sender rejected\r\n');
        else socket.write('250 Ok\r\n');
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const rejectedPort = (closed.address() as { port: number }).port;

    await assert.rejects(
      () =>
        sendMail(
          { from: 'a@construx.ai', to: 'b@example.test', raw: 'Subject: x\r\n\r\nx' },
          { ...options, port: rejectedPort, user: '' },
        ),
      /550/,
    );

    closed.close();
  });

  it('reports a message the relay took and never answered for as unknown, not failed', async () => {
    // The relay accepts the whole conversation up to and including the body,
    // then says nothing. The message may be in the queue behind it; the client
    // cannot know, and must not say "failed" — a caller that believes that
    // sends the same message again.
    const silent = createServer((socket) => {
      let dataMode = false;
      socket.setEncoding('utf8');
      socket.write('220 test.construx ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        if (dataMode) return; // took the body, answered nothing
        if (chunk.startsWith('EHLO')) socket.write('250 test.construx\r\n');
        else if (chunk.startsWith('DATA')) {
          dataMode = true;
          socket.write('354 go ahead\r\n');
        } else socket.write('250 Ok\r\n');
      });
      socket.on('error', () => {});
    });
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const silentPort = (silent.address() as { port: number }).port;

    const result = await sendMail(
      { from: 'a@construx.ai', to: 'b@example.test', raw: 'Subject: x\r\n\r\nx' },
      { ...options, port: silentPort, user: '', timeoutMs: 300 },
    );
    assert.equal(result.accepted, false);
    assert.equal(result.indeterminate, true);
    assert.match(result.response, /No reply after the message was sent/);

    silent.close();
  });

  it('refuses to authenticate in cleartext when TLS is required', async () => {
    await assert.rejects(
      () => sendMail({ from: 'a@construx.ai', to: 'b@example.test', raw: 'x' }, { ...options, port, requireTls: true }),
      /STARTTLS/,
    );
  });
});

import { suppressedAddresses as suppressedNow } from '../src/messaging/audience.ts';
import { clearSuppression, recordBounce } from '../src/messaging/newsletter.ts';

describe('an address the relay refuses for good', () => {
  let platform: Platform;
  let seed: SeedResult;
  let gone = { userId: '', email: '' };
  let flaky = { userId: '', email: '' };

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('is suppressed, while a transient refusal is retried, and both are on the record', async () => {
    const { recipients } = resolveAudience(platform);
    assert.ok(recipients.length >= 3);
    gone = { userId: recipients[0]!.userId, email: recipients[0]!.email };
    flaky = { userId: recipients[1]!.userId, email: recipients[1]!.email };
    const transport = {
      send: async ({ to }: { to: string }) => {
        if (to === gone.email) throw Object.assign(new Error('550 5.1.1 The email account that you tried to reach does not exist'), { code: 'SMTP_PERMANENT' });
        if (to === flaky.email) throw Object.assign(new Error('451 4.7.1 Try again later'), { code: 'SMTP_TRANSIENT' });
        return { accepted: true as const, response: '250 2.0.0 Ok' };
      },
    };

    const report = await issueNewsletter(platform, { issuedBy: seed.users.admin!.id, week: '2031-W10', transport });
    assert.equal(report.campaign.channel, 'SMTP');
    assert.equal(report.failed, 2);
    assert.equal(report.sent, recipients.length - 2);
    const failures = report.deliveries.filter((delivery) => delivery.status === 'FAILED');
    assert.equal(failures.find((delivery) => delivery.userId === gone.userId)!.failure, 'PERMANENT');
    assert.equal(failures.find((delivery) => delivery.userId === flaky.userId)!.failure, 'TRANSIENT');
    assert.equal(suppressedNow(platform).get(gone.email.toLowerCase())?.status, 'ACTIVE');
    assert.equal(suppressedNow(platform).has(flaky.email.toLowerCase()), false);

    // The next audience leaves the gone address out, with the relay's words,
    // and keeps the one that merely asked for later.
    const next = resolveAudience(platform);
    const excluded = next.excluded.find((entry) => entry.userId === gone.userId);
    assert.equal(excluded?.reason, 'SUPPRESSED');
    assert.match(String(excluded?.detail), /550 5\.1\.1/);
    assert.ok(next.recipients.some((entry) => entry.userId === flaky.userId), 'a transient failure is retried');

    const second = await issueNewsletter(platform, {
      issuedBy: seed.users.admin!.id,
      week: '2031-W11',
      transport: { send: async () => ({ accepted: true as const, response: '250 2.0.0 Ok' }) },
    });
    assert.ok(!second.deliveries.some((delivery) => delivery.userId === gone.userId), 'a suppressed address was written to again');
    assert.ok(second.deliveries.some((delivery) => delivery.userId === flaky.userId && delivery.status === 'SENT'));
  });

  it('is lifted by an operator, once, under their name', () => {
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    const { suppression } = clearSuppression(platform, operator.id, gone.userId);
    assert.equal(suppression.status, 'CLEARED');
    assert.equal(suppression.clearedBy, operator.id);
    assert.ok(resolveAudience(platform).recipients.some((entry) => entry.userId === gone.userId), 'back in the audience');
    throwsCode(() => clearSuppression(platform, operator.id, gone.userId), 'NOT_SUPPRESSED');
    // The refusal is still on the record; it is the suppression that ended.
    assert.equal(platform.ledger.list('platform-marketing', 'NewsletterSuppression').length, 1);
  });

  it('survives a restart in whichever state it was left', () => {
    const restored = new Platform();
    restored.ledger.restore(platform.ledger.events());
    restored.rehydrate();
    assert.equal(suppressedNow(restored).size, 0, 'cleared stays cleared');
    assert.equal(restored.ledger.list('platform-marketing', 'NewsletterSuppression')[0]!.state.status, 'CLEARED');
  });
});

/**
 * A bounce that arrives after the relay said 250.
 *
 * The relay accepting a message is not the message arriving. The platform
 * reads no mailbox, so the bounce reaches the record when an operator (or a
 * relay posting to the endpoint) reports it — and from then on the campaign
 * report says FAILED where the message never arrived, and a dead address is
 * suppressed exactly as if the relay had refused it at the door.
 */
describe('a message accepted by the relay and bounced later', () => {
  let platform: Platform;
  let seed: SeedResult;
  let operatorId = '';
  let campaignId = '';
  let gone = { userId: '', email: '' };
  let full = { userId: '', email: '' };
  const accepting = { send: async () => ({ accepted: true as const, response: '250 2.0.0 Ok: queued as 4XyZ' }) };

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    const report = await issueNewsletter(platform, { issuedBy: seed.users.admin!.id, week: '2031-W20', transport: accepting });
    campaignId = report.campaign.id;
    // Created after the issue and unsubscribed, so this is a person the
    // platform knows and has never written to, and will not write to on a retry.
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops-bounce@construx.example' });
    operatorId = operator.id;
    setConsent(platform, { user: operator, subscribed: false, source: 'PREFERENCE_PAGE' });
    assert.ok(report.sent >= 3, 'the relay accepted everything, so every delivery is SENT');
    gone = { userId: report.deliveries[0]!.userId, email: report.deliveries[0]!.email };
    full = { userId: report.deliveries[1]!.userId, email: report.deliveries[1]!.email };
  });

  it('turns SENT into FAILED against the delivery it concerns, and suppresses a dead address', () => {
    const diagnostic = '550 5.1.1 <' + gone.email + '>: Recipient address rejected: User unknown in virtual mailbox table';
    const { delivery, suppressed } = recordBounce(platform, {
      actorId: operatorId,
      email: gone.email.toUpperCase(),
      kind: 'PERMANENT',
      diagnostic,
    });
    assert.equal(delivery.userId, gone.userId);
    assert.equal(delivery.status, 'FAILED');
    assert.equal(delivery.failure, 'PERMANENT');
    assert.equal(delivery.bounce?.diagnostic, diagnostic);
    assert.equal(delivery.bounce?.reportedBy, 'Ruth', 'recorded under the operator by name by default');
    assert.match(delivery.detail, /Accepted by the relay \(250 2\.0\.0 Ok: queued as 4XyZ\); bounced later: 550 5\.1\.1/);
    assert.equal(suppressed, true);

    // The campaign report now tells the truth, and so does the audience.
    const onRecord = deliveriesFor(platform, campaignId).find((d) => d.userId === gone.userId)!;
    assert.equal(onRecord.status, 'FAILED');
    assert.equal(onRecord.id, delivery.id, 'the same delivery record, updated, not a second one');
    assert.equal(suppressedNow(platform).get(gone.email.toLowerCase())?.status, 'ACTIVE');
    const excluded = resolveAudience(platform).excluded.find((entry) => entry.userId === gone.userId);
    assert.equal(excluded?.reason, 'SUPPRESSED');
    assert.match(String(excluded?.detail), /Bounced after acceptance: 550 5\.1\.1/);
  });

  it('records a transient bounce without suppressing, and a forced re-issue tries the address again', async () => {
    const { delivery, suppressed } = recordBounce(platform, {
      actorId: operatorId,
      email: full.email,
      campaignId,
      kind: 'TRANSIENT',
      diagnostic: '452 4.2.2 Mailbox full',
      reportedBy: 'relay.example (webhook)',
    });
    assert.equal(delivery.status, 'FAILED');
    assert.equal(delivery.failure, 'TRANSIENT');
    assert.equal(delivery.bounce?.reportedBy, 'relay.example (webhook)');
    assert.equal(suppressed, false);
    assert.equal(suppressedNow(platform).has(full.email.toLowerCase()), false);
    assert.ok(resolveAudience(platform).recipients.some((entry) => entry.userId === full.userId), 'still in the audience');

    // The issue now has a failed delivery to retry: the full mailbox is tried
    // again, the dead one is not, and nobody already reached is mailed twice.
    const retry = await issueNewsletter(platform, { issuedBy: operatorId, week: '2031-W20', force: true, transport: accepting });
    assert.equal(retry.deliveries.length, 1, 'only the transient bounce is retried');
    assert.equal(retry.deliveries[0]!.userId, full.userId);
    assert.equal(retry.deliveries[0]!.status, 'SENT');
  });

  it('refuses what cannot have bounced, and says why', async () => {
    // Nobody this platform has ever mailed.
    throwsCode(
      () => recordBounce(platform, { actorId: operatorId, email: 'stranger@nowhere.example', kind: 'PERMANENT', diagnostic: '550' }),
      'BOUNCE_ADDRESS_UNKNOWN',
    );
    // A user the platform knows and has never sent an issue.
    throwsCode(
      () => recordBounce(platform, { actorId: operatorId, email: 'ops-bounce@construx.example', kind: 'PERMANENT', diagnostic: '550' }),
      'BOUNCE_NO_DELIVERY',
    );
    // Already on the record.
    throwsCode(
      () => recordBounce(platform, { actorId: operatorId, email: gone.email, campaignId, kind: 'PERMANENT', diagnostic: '550 again' }),
      'BOUNCE_ALREADY_RECORDED',
    );
    // An issue that does not exist, an empty diagnostic, a kind that is neither.
    throwsCode(
      () => recordBounce(platform, { actorId: operatorId, email: full.email, campaignId: 'no-such-issue', kind: 'PERMANENT', diagnostic: '550' }),
      'BOUNCE_CAMPAIGN_UNKNOWN',
    );
    throwsCode(() => recordBounce(platform, { actorId: operatorId, email: full.email, kind: 'PERMANENT', diagnostic: '  ' }), 'BOUNCE_DIAGNOSTIC_REQUIRED');
    throwsCode(
      () => recordBounce(platform, { actorId: operatorId, email: full.email, kind: 'SOFT' as 'PERMANENT', diagnostic: '550' }),
      'BOUNCE_KIND_INVALID',
    );

    // A message that never left the box cannot have bounced. This environment
    // has no SMTP host, so an issue with no transport is composed and recorded.
    assert.equal(config.smtp.host, '');
    const recorded = await issueNewsletter(platform, { issuedBy: operatorId, week: '2031-W21' });
    const someone = recorded.deliveries.find((d) => d.status === 'RECORDED')!;
    throwsCode(
      () => recordBounce(platform, { actorId: operatorId, email: someone.email, campaignId: recorded.campaign.id, kind: 'PERMANENT', diagnostic: '550' }),
      'BOUNCE_NOT_SENT',
    );
  });

  it('is on the ledger as an update to the delivery, under the operator, and survives a restart', () => {
    const events = platform.ledger.events().filter((event) => event.eventType === 'NEWSLETTER_DELIVERY_BOUNCED');
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.actor.refType === 'User' && event.actor.refId === operatorId));
    assert.ok(events.every((event) => event.correlationId === campaignId), 'correlated to the issue it concerns');

    const restored = new Platform();
    restored.ledger.restore(platform.ledger.events());
    restored.rehydrate();
    const after = deliveriesFor(restored, campaignId);
    assert.equal(after.find((d) => d.userId === gone.userId)?.bounce?.diagnostic.slice(0, 9), '550 5.1.1');
    assert.equal(suppressedNow(restored).get(gone.email.toLowerCase())?.status, 'ACTIVE');
  });
});
