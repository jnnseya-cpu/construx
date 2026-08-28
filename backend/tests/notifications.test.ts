import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
  CATEGORIES,
  CATEGORY_TITLES,
  CHANNELS,
  channelCoverage,
  eventsInCategory,
  fillTemplate,
  findEvent,
  mandatoryEvents,
  NOTIFICATION_EVENTS,
  requireEvent,
} from '../src/notifications/catalogue.ts';
import { allows, preferenceMatrix, setPreferences } from '../src/notifications/preferences.ts';
import { channelStatus, deliveries, deliveryTotals, inbox, notify } from '../src/notifications/notify.ts';
import { previewNotification, renderNotificationEmail } from '../src/notifications/render.ts';
import type { ClientBranding } from '../src/export/exporter.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The communication event engine.
 *
 * Two properties carry the weight here, and both are the kind that fail
 * silently in production if nothing asserts them.
 *
 * The first is that **mandatory notices are not subject to preferences**.
 * Twenty-seven events tell somebody their account was locked, their password
 * was changed by another party, their payment failed or their data is being
 * deleted. A preference centre that can switch those off has sold the user a
 * control that harms them, and the failure is invisible — nobody notices the
 * notice that did not arrive.
 *
 * The second is that **nothing reports a delivery it did not make**. Email is
 * `SENT` only when a server accepted it. A channel with no carrier behind it is
 * `RECORDED`, which is what the console calls "logged". A queue that marks
 * everything green tells you nothing on the day somebody asks whether the
 * payment-failure notice went out.
 */

const BRANDING: ClientBranding = {
  clientName: 'Meridian Infrastructure Group Ltd',
  primaryColour: '#e2571e',
  legalFooter: 'Meridian Infrastructure Group Ltd · registered in GB',
  documentReferencePrefix: 'MIGL',
};

let platform: Platform;
let seed: SeedResult;

function recipientFor(who: string) {
  const user = platform.user(seed.users[who]!.id);
  return { id: user.id, name: user.name, email: user.email, tenantId: user.tenantId, mobile: '+447700900123' };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the catalogue', () => {
  it('holds 180 events across 15 categories', () => {
    assert.equal(NOTIFICATION_EVENTS.length, 180);
    assert.equal(CATEGORIES.length, 15);
    assert.equal(new Set(CATEGORIES.map((c) => CATEGORY_TITLES[c])).size, 15, 'two categories share a title');
  });

  it('files every event under a category, and every category has events', () => {
    const counted = CATEGORIES.reduce((total, category) => total + eventsInCategory(category).length, 0);
    assert.equal(counted, NOTIFICATION_EVENTS.length, 'an event is filed under no category');
    for (const category of CATEGORIES) {
      assert.ok(eventsInCategory(category).length > 0, `${category} is empty`);
    }
  });

  it('gives every event a unique code, a title and a subject', () => {
    const codes = new Set<string>();
    for (const event of NOTIFICATION_EVENTS) {
      assert.ok(!codes.has(event.code), `${event.code} is declared twice`);
      codes.add(event.code);
      assert.match(event.code, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, `${event.code} is not a dotted lower-case code`);
      assert.ok(event.title.length > 0, `${event.code} has no title`);
      assert.ok(event.subject.length > 0, `${event.code} has no subject`);
    }
  });

  it('routes every event to at least one channel', () => {
    for (const event of NOTIFICATION_EVENTS) {
      assert.ok(event.channels.length > 0, `${event.code} fires on no channel and can never be delivered`);
    }
  });

  it('reports the channel coverage the architecture claims', () => {
    const coverage = channelCoverage();
    assert.equal(coverage.INAPP, 180, 'in-app is meant to carry every event');
    assert.equal(coverage.EMAIL, 133);
    assert.equal(coverage.SMS, 18);
    assert.equal(coverage.PUSH, 28);
  });

  it('declares WhatsApp and routes nothing to it, which is stated rather than hidden', () => {
    // The channel exists in the model with no provider and no events. Asserting
    // the zero keeps it honest: the day something routes there, this fails and
    // somebody has to confirm a carrier exists.
    assert.ok((CHANNELS as readonly string[]).includes('WHATSAPP'));
    assert.equal(channelCoverage().WHATSAPP, 0);
  });

  it('carries 30 mandatory notices, and they are the ones that matter', () => {
    assert.equal(mandatoryEvents().length, 30);

    // Spot-checked by name rather than by count alone. A count stays green if
    // somebody moves the flag from "account locked" to "task assigned".
    for (const code of [
      'auth.login.suspicious',
      // The platform telling its operator it is broken, and that it recovered.
      // An operator must not be able to mute either.
      'system.watch_alert',
      'system.watch_resolved',
      'account.locked',
      'password.reset.successful',
      'security.alert',
      'session.revoked',
      'payment.failed',
      'invoice.overdue',
      'compliance.breach',
      'privacy.account_deletion_completed',
      'system.outage',
    ]) {
      assert.equal(requireEvent(code).mandatory, true, `${code} stopped being mandatory`);
    }
  });

  it('marks nothing routine as mandatory', () => {
    for (const code of ['task.assigned', 'project.created', 'report.generated', 'invitation.accepted']) {
      assert.equal(requireEvent(code).mandatory, false, `${code} would override a person's preferences`);
    }
  });

  it('is closed — an unknown code throws rather than sending nothing quietly', () => {
    assert.equal(findEvent('not.a.real.event'), undefined);
    assert.throws(() => requireEvent('not.a.real.event'), /catalogue is closed/);
  });

  it('leaves an unresolved placeholder visible rather than blanking it', () => {
    assert.equal(fillTemplate('Approval needed: {{item}}', { item: 'RFI 214' }), 'Approval needed: RFI 214');
    // The alternative is "Approval needed: " in somebody's inbox, which reads as
    // a bug and tells them nothing.
    assert.equal(fillTemplate('Approval needed: {{item}}', {}), 'Approval needed: {{item}}');
    assert.equal(fillTemplate('Approval needed: {{item}}', { item: '' }), 'Approval needed: {{item}}');
  });
});

describe('preferences, and what they may not switch off', () => {
  it('allows an event on its default channel when nothing is muted', () => {
    const verdict = allows(platform, { userId: seed.users.pm!.id, code: 'task.assigned', channel: 'INAPP' });
    assert.deepEqual(verdict, { allowed: true, reason: 'DEFAULT_ON' });
  });

  it('refuses a channel the event does not declare, so a caller cannot widen routing', () => {
    // task.assigned is in-app and push. Asking about SMS is not a preference
    // question at all.
    const verdict = allows(platform, { userId: seed.users.pm!.id, code: 'task.assigned', channel: 'SMS' });
    assert.deepEqual(verdict, { allowed: false, reason: 'NOT_A_DEFAULT_CHANNEL' });
  });

  it('honours a mute on an optional category', () => {
    const user = platform.user(seed.users.planner!.id);
    setPreferences(platform, {
      userId: user.id,
      tenantId: user.tenantId,
      muted: { PROJECT_MANAGEMENT: { INAPP: false } },
      updatedBy: user.id,
      correlationId: 'prefs-mute',
    });

    const verdict = allows(platform, { userId: user.id, code: 'task.assigned', channel: 'INAPP' });
    assert.deepEqual(verdict, { allowed: false, reason: 'MUTED_BY_USER' });
  });

  it('ignores the mute for a mandatory notice in the same category', () => {
    // The whole point. PROJECT_MANAGEMENT is muted for this user above, and
    // risk.escalated is in PROJECT_MANAGEMENT and mandatory.
    const user = platform.user(seed.users.planner!.id);
    const verdict = allows(platform, { userId: user.id, code: 'risk.escalated', channel: 'EMAIL' });
    assert.deepEqual(verdict, { allowed: true, reason: 'MANDATORY' });
  });

  it('says the notice was mandatory rather than merely behaving that way', () => {
    // A screen that cannot tell "allowed because they want it" from "allowed
    // because they cannot refuse it" will show a live mute control for a notice
    // that ignores it.
    const user = platform.user(seed.users.planner!.id);
    assert.equal(allows(platform, { userId: user.id, code: 'account.locked', channel: 'SMS' }).reason, 'MANDATORY');
    assert.equal(allows(platform, { userId: user.id, code: 'invoice.paid', channel: 'EMAIL' }).reason, 'DEFAULT_ON');
  });

  it('refuses a category or channel that does not exist rather than storing it', () => {
    const user = platform.user(seed.users.qs!.id);
    assert.throws(
      () =>
        setPreferences(platform, {
          userId: user.id,
          tenantId: user.tenantId,
          muted: { NOT_A_CATEGORY: { EMAIL: false } } as never,
          updatedBy: user.id,
          correlationId: 'prefs-bad-category',
        }),
      /not a notification category/,
    );
    assert.throws(
      () =>
        setPreferences(platform, {
          userId: user.id,
          tenantId: user.tenantId,
          muted: { APPROVALS: { PIGEON: false } } as never,
          updatedBy: user.id,
          correlationId: 'prefs-bad-channel',
        }),
      /not a notification channel/,
    );
  });

  it('records the change as an event, because somebody will dispute it later', () => {
    const events = platform.ledger.events({ projectId: 'platform-notifications' });
    assert.ok(
      events.some((e) => e.eventType === 'NOTIFICATION_PREFERENCES_SET'),
      'a preference change left no record',
    );
  });

  it('shows a category as unswitchable only where every event on that channel is mandatory', () => {
    const matrix = preferenceMatrix(platform, seed.users.pm!.id);

    // Platform Administration on SMS is outage, emergency maintenance and
    // policy violation — all mandatory. Nothing to switch, and rendering a live
    // control would be a lie.
    const admin = matrix.find((row) => row.category === 'PLATFORM_ADMINISTRATION')!;
    const adminSms = admin.channels.find((c) => c.channel === 'SMS')!;
    assert.equal(adminSms.switchable, false);
    assert.equal(adminSms.mandatoryEvents, 3);

    // Login & Security on SMS is *not* fully locked, and the reason is worth
    // stating: mfa.otp_code rides that channel and is optional in the
    // catalogue. So the control stays live there.
    const security = matrix.find((row) => row.category === 'LOGIN_SECURITY')!;
    assert.equal(security.channels.find((c) => c.channel === 'SMS')!.switchable, true);

    // Email in Login & Security carries optional notices too, so muting the
    // category on email is offered rather than the whole category being locked.
    assert.equal(security.channels.find((c) => c.channel === 'EMAIL')!.switchable, true);
  });
});

describe('dispatch', () => {
  it('fans one event across its declared channels and records each separately', async () => {
    const dispatch = await notify(platform, {
      code: 'approval.requested',
      recipients: [recipientFor('pm')],
      payload: { item: 'RFI 214' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-approval',
    });

    assert.equal(dispatch.subject, 'Approval needed: RFI 214');
    // email, in-app and push.
    assert.deepEqual(dispatch.deliveries.map((d) => d.channel).sort(), ['EMAIL', 'INAPP', 'PUSH']);
    for (const delivery of dispatch.deliveries) {
      assert.equal(delivery.dispatchId, dispatch.id);
      assert.equal(delivery.code, 'approval.requested');
    }
  });

  it('reports a channel with no carrier as recorded, never as sent', async () => {
    const dispatch = await notify(platform, {
      code: 'approval.requested',
      recipients: [recipientFor('qs')],
      payload: { item: 'RFI 215' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-carrier',
    });

    const push = dispatch.deliveries.find((d) => d.channel === 'PUSH')!;
    assert.equal(push.status, 'RECORDED');
    assert.match(push.detail, /no provider is configured/);
    assert.equal(push.transport, 'push:no-provider');

    // Email with no SMTP host is the same honesty, on a channel that does have
    // an implementation.
    const email = dispatch.deliveries.find((d) => d.channel === 'EMAIL')!;
    assert.equal(email.status, 'RECORDED');
    assert.match(email.detail, /no SMTP host configured/);
  });

  it('delivers in-app by recording it, and the recipient can read it back', async () => {
    const user = recipientFor('safety');
    await notify(platform, {
      code: 'milestone.due',
      recipients: [user],
      payload: { item: 'Commissioning start' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-inapp',
    });

    const messages = inbox(platform, user.tenantId, user.id);
    assert.ok(messages.length > 0, 'nothing reached the in-app inbox');
    assert.equal(messages[0]!.channel, 'INAPP');
    assert.equal(messages[0]!.status, 'SENT');
  });

  it('suppresses a muted channel and records the suppression with its reason', async () => {
    // The planner muted PROJECT_MANAGEMENT on in-app earlier.
    const dispatch = await notify(platform, {
      code: 'task.assigned',
      recipients: [recipientFor('planner')],
      payload: { task: 'Pour slab B2' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-muted',
    });

    const inApp = dispatch.deliveries.find((d) => d.channel === 'INAPP')!;
    assert.equal(inApp.status, 'SUPPRESSED');
    assert.equal(inApp.reason, 'MUTED_BY_USER');
    // Suppressed is recorded, not dropped: "why did they not get it" has an
    // answer rather than an absence.
    assert.ok(deliveries(platform, recipientFor('planner').tenantId, 500).some((d) => d.id === inApp.id));
  });

  it('reaches a person who muted the category when the notice is mandatory', async () => {
    const dispatch = await notify(platform, {
      code: 'risk.escalated',
      recipients: [recipientFor('planner')],
      payload: { item: 'Ground water ingress' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-mandatory',
    });

    assert.ok(dispatch.mandatory);
    for (const delivery of dispatch.deliveries) {
      assert.notEqual(delivery.status, 'SUPPRESSED', `${delivery.channel} was suppressed for a mandatory notice`);
      assert.equal(delivery.reason, 'MANDATORY');
    }
  });

  it('narrows the routing when asked, and cannot be made to widen it', async () => {
    const narrowed = await notify(platform, {
      code: 'approval.requested',
      recipients: [recipientFor('pm')],
      channels: ['EMAIL'],
      payload: { item: 'RFI 216' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-narrow',
    });
    assert.deepEqual(narrowed.deliveries.map((d) => d.channel), ['EMAIL']);

    // task.assigned declares in-app and push. Asking for SMS as well must not
    // produce an SMS.
    const widened = await notify(platform, {
      code: 'task.assigned',
      recipients: [recipientFor('pm')],
      channels: ['SMS', 'INAPP'],
      payload: { task: 'Fix soffit' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-widen',
    });
    assert.deepEqual(widened.deliveries.map((d) => d.channel), ['INAPP']);
  });

  it('records a failure per recipient rather than abandoning the dispatch', async () => {
    const dispatch = await notify(platform, {
      code: 'account.mobile_verification_required',
      recipients: [{ ...recipientFor('fm'), mobile: undefined }],
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-no-mobile',
    });

    const sms = dispatch.deliveries.find((d) => d.channel === 'SMS')!;
    assert.equal(sms.status, 'FAILED');
    assert.match(sms.detail, /no mobile number/);
    // The email still went out. One missing address must not silence the rest.
    assert.ok(dispatch.deliveries.some((d) => d.channel === 'EMAIL' && d.status !== 'FAILED'));
  });

  it('writes a dispatch and a delivery record for every send', () => {
    const events = platform.ledger.events({ projectId: 'platform-notifications' });
    assert.ok(events.some((e) => e.eventType === 'NOTIFICATION_DISPATCHED'));
    assert.ok(events.some((e) => e.eventType === 'NOTIFICATION_DELIVERY_RECORDED'));
  });

  it('totals attempted against actually delivered, which are different numbers', () => {
    const totals = deliveryTotals(platform, recipientFor('pm').tenantId);
    assert.ok(totals.attempted > 0);
    assert.equal(
      totals.sent + totals.recorded + totals.failed + totals.suppressed,
      totals.attempted,
      'the totals do not account for every delivery',
    );
    // With no SMTP host in the test environment, no email can be `SENT`.
    assert.ok(totals.recorded > 0, 'nothing was recorded — check the fixture');
  });

  it('states which channels have a carrier behind them', () => {
    const status = channelStatus();
    assert.equal(status.find((s) => s.channel === 'INAPP')!.wired, true);
    assert.equal(status.find((s) => s.channel === 'WHATSAPP')!.wired, false);
    // Email is wired only when a relay is configured; there is none here.
    assert.equal(status.find((s) => s.channel === 'EMAIL')!.wired, false);
  });
});

describe('the branded message', () => {
  it('carries the tenant name, colour and legal footer', () => {
    const rendered = renderNotificationEmail({
      event: requireEvent('invoice.generated'),
      subject: 'Invoice INV-204 is ready',
      recipient: { id: 'u1', name: 'Amara Osei', email: 'amara@example.com' },
      payload: { number: 'INV-204' },
      branding: BRANDING,
    });

    assert.ok(rendered.html.includes('Meridian Infrastructure Group Ltd'));
    assert.ok(rendered.html.includes('#e2571e'), 'the tenant colour is not on the message');
    assert.ok(rendered.html.includes('registered in GB'));
    assert.ok(rendered.text.includes('Meridian Infrastructure Group Ltd'));
  });

  it('offers an unsubscribe on an optional notice and none on a mandatory one', () => {
    const optional = renderNotificationEmail({
      event: requireEvent('invoice.generated'),
      subject: 'Invoice ready',
      recipient: { id: 'u1', name: 'Amara Osei', email: 'amara@example.com' },
      payload: {},
      branding: BRANDING,
    });
    assert.match(optional.html, /Unsubscribe/);

    // An unsubscribe link on a security notice is a control that cannot work.
    const mandatory = renderNotificationEmail({
      event: requireEvent('account.locked'),
      subject: 'Your account has been locked',
      recipient: { id: 'u1', name: 'Amara Osei', email: 'amara@example.com' },
      payload: {},
      branding: BRANDING,
    });
    assert.ok(!/Unsubscribe/.test(mandatory.html), 'a mandatory notice advertised an unsubscribe that cannot work');
    assert.match(mandatory.html, /not subject to notification preferences/);
  });

  it('escapes recipient and payload text rather than interpolating it raw', () => {
    const rendered = renderNotificationEmail({
      event: requireEvent('approval.requested'),
      subject: 'Approval needed: <script>alert(1)</script>',
      recipient: { id: 'u1', name: '<img src=x onerror=alert(1)>', email: 'a@example.com' },
      payload: {},
      branding: BRANDING,
    });

    assert.ok(!rendered.html.includes('<script>'), 'a subject was interpolated unescaped');
    assert.ok(!rendered.html.includes('<img src=x'), 'a recipient name was interpolated unescaped');
    assert.ok(rendered.html.includes('&lt;script&gt;'));
  });

  it('previews with the same code that sends, so the preview cannot go stale', () => {
    const event = requireEvent('account.registration.requested');
    const recipient = { id: 'u1', name: 'Amara Osei', email: 'amara@example.com' };
    const preview = previewNotification({ event, recipient, branding: BRANDING });
    const real = renderNotificationEmail({ event, subject: preview.subject, recipient, payload: {}, branding: BRANDING });

    assert.equal(preview.html, real.html);
    assert.equal(preview.text, real.text);
    assert.ok(preview.from.includes('@'), 'the preview does not say who it comes from');
  });

  it('falls back to the tenant name when no logo is configured, never to the platform mark', () => {
    const rendered = renderNotificationEmail({
      event: requireEvent('invoice.paid'),
      subject: 'Invoice paid',
      recipient: { id: 'u1', name: 'Amara', email: 'a@example.com' },
      payload: {},
      branding: { ...BRANDING, logoRef: undefined },
    });

    assert.ok(rendered.html.includes('Meridian Infrastructure Group Ltd'));
    assert.ok(!rendered.html.includes('<img'), 'a placeholder image stood in for a logo that does not exist');
  });
});

describe('tenant isolation on the shared platform chain', () => {
  /**
   * Every tenancy's notifications are recorded on one reserved chain —
   * `platform-notifications` — because platform-to-person messaging is not a
   * project fact. That makes reading it by project id a cross-tenant leak, and
   * it was one: the deliveries feed returned every customer's notification
   * history, addresses included, to any administrator who could open the
   * screen. Reads are scoped by tenant now, and this is why.
   */
  it('shows an administrator their own tenancy’s deliveries and nobody else’s', async () => {
    const other = platform.createTenant({
      legalName: 'Northgate Civils Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      enterpriseName: 'Northgate',
    });
    const outsider = platform.createUser({
      tenantId: other.tenant.id,
      name: 'Northgate Admin',
      email: 'admin@northgate.example',
      roles: ['ENTERPRISE_ADMIN'],
    });

    await notify(platform, {
      code: 'invoice.generated',
      recipients: [{ id: outsider.id, name: outsider.name, email: outsider.email, tenantId: other.tenant.id }],
      payload: { number: 'NG-001' },
      branding: BRANDING,
      actorId: 'system',
      correlationId: 'notify-other-tenant',
    });

    const mine = deliveries(platform, recipientFor('pm').tenantId, 500);
    const theirs = deliveries(platform, other.tenant.id, 500);

    assert.ok(theirs.length > 0, 'the other tenancy recorded nothing — check the fixture');
    assert.ok(mine.length > 0, 'this tenancy recorded nothing — check the fixture');
    assert.equal(
      mine.filter((d) => d.recipientId === outsider.id).length,
      0,
      'another tenancy’s deliveries appeared in this one’s feed',
    );
    assert.equal(
      theirs.filter((d) => d.destination === 'pm@meridian.example').length,
      0,
      'this tenancy’s addresses leaked into another’s feed',
    );
  });

  it('keeps an inbox to the person it belongs to', async () => {
    const mine = inbox(platform, recipientFor('pm').tenantId, seed.users.pm!.id, 500);
    for (const message of mine) {
      assert.equal(message.recipientId, seed.users.pm!.id, 'somebody else’s message is in this inbox');
    }
  });
});
