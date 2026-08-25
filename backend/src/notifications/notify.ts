import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { unsubscribeUrl } from '../messaging/audience.ts';
import { buildMime } from '../messaging/render.ts';
import { sendMail } from '../messaging/smtp.ts';
import type { Platform } from '../platform.ts';
import { fillTemplate, requireEvent, type Channel, type NotificationEvent } from './catalogue.ts';
import { allows, NOTIFICATIONS_PROJECT_ID, type Verdict } from './preferences.ts';
import { renderNotificationEmail, type Branding } from './render.ts';

/**
 * The dispatch engine. One event in, a delivery per channel per recipient out.
 *
 * ---
 *
 * **Nothing here reports a success it did not have.** Email goes through the
 * same SMTP transport the newsletter uses and comes back `SENT` only when a
 * server accepted it. SMS, push and WhatsApp have no provider configured in
 * this build, so they come back `RECORDED` — the dispatch happened, the
 * delivery did not, and the record says which. That distinction is the entire
 * value of a delivery log; a queue that marks everything green is a queue that
 * tells you nothing on the day somebody asks whether the payment-failure notice
 * went out.
 *
 * `RECORDED` is not a failure state. It is the honest description of a channel
 * that is wired into the engine and not yet connected to a carrier, and it is
 * what the console displays as "logged".
 *
 * **A failure on one channel does not stop the others.** A person whose SMS
 * bounces still gets the email. Each channel is attempted and recorded
 * independently, and the dispatch reports the set.
 */

export type DeliveryStatus = 'SENT' | 'RECORDED' | 'FAILED' | 'SUPPRESSED';

export type Delivery = {
  id: string;
  dispatchId: string;
  code: string;
  channel: Channel;
  recipientId: string;
  /** The address used, or the reason there was none. Never invented. */
  destination: string;
  status: DeliveryStatus;
  /** Which transport answered, so a delivery can be traced to a provider. */
  transport: string;
  detail: string;
  /** Why the engine allowed or refused this channel for this person. */
  reason: Verdict['reason'];
  at: string;
};

export type Dispatch = {
  id: string;
  code: string;
  title: string;
  category: string;
  severity: string;
  mandatory: boolean;
  subject: string;
  recipientIds: string[];
  deliveries: Delivery[];
  at: string;
};

export type Recipient = {
  id: string;
  name: string;
  email: string;
  mobile?: string;
  tenantId: string;
};

/** Channels with a real carrier behind them in this build. */
const WIRED: Partial<Record<Channel, boolean>> = { EMAIL: true, INAPP: true };

function transportFor(channel: Channel): string {
  if (channel === 'EMAIL') return config.smtp.host ? `smtp:${config.smtp.host}` : 'smtp:unconfigured';
  if (channel === 'INAPP') return 'ledger';
  return `${channel.toLowerCase()}:no-provider`;
}

/**
 * Deliver one event to one person on one channel.
 *
 * Returns what happened rather than throwing: a channel that could not deliver
 * is a recorded fact, not an exception that would abandon the other channels
 * and lose the record of the ones that did work.
 */
async function deliver(
  platform: Platform,
  input: {
    event: NotificationEvent;
    channel: Channel;
    recipient: Recipient;
    subject: string;
    payload: Record<string, unknown>;
    branding: Branding;
    dispatchId: string;
    verdict: Verdict;
  },
): Promise<Delivery> {
  const base = {
    id: ulid(),
    dispatchId: input.dispatchId,
    code: input.event.code,
    channel: input.channel,
    recipientId: input.recipient.id,
    transport: transportFor(input.channel),
    reason: input.verdict.reason,
    at: new Date().toISOString(),
  };

  if (input.channel === 'INAPP') {
    // In-app is delivered by being recorded: the record *is* the notification,
    // and the console reads it back. There is no carrier to fail.
    return { ...base, destination: input.recipient.id, status: 'SENT', detail: 'Recorded for in-app display' };
  }

  if (input.channel === 'EMAIL') {
    if (!input.recipient.email) {
      return { ...base, destination: '', status: 'FAILED', detail: 'The recipient has no email address on record' };
    }

    const rendered = renderNotificationEmail({
      event: input.event,
      subject: input.subject,
      recipient: input.recipient,
      payload: input.payload,
      branding: input.branding,
    });

    if (!config.smtp.host) {
      // No relay configured. The message was built and is reproducible; it was
      // not delivered, and saying "sent" here would be the lie the whole
      // delivery log exists to prevent.
      return {
        ...base,
        destination: input.recipient.email,
        status: 'RECORDED',
        detail: 'Rendered and recorded — no SMTP host configured, so nothing was transmitted',
      };
    }

    const raw = buildMime({
      to: input.recipient.email,
      toName: input.recipient.name,
      subject: input.subject,
      html: rendered.html,
      text: rendered.text,
      // A mandatory notice advertises no unsubscribe. RFC 8058 one-click on a
      // security notice would be a control that cannot work, and a mail client
      // showing the button makes the platform look like it ignored the press.
      unsubscribe: input.event.mandatory ? '' : unsubscribeUrl(input.recipient.id),
      messageId: base.id,
    });

    try {
      const result = await sendMail({ from: config.notifications.fromAddress, to: input.recipient.email, raw });
      // Said out loud when it fails. A refusal recorded and not logged is how
      // an afternoon goes by with a login screen reporting "code sent" and no
      // code sent — the platform knew and did not say. The relay's own words
      // are the diagnosis, so they are what gets printed.
      if (!result.accepted) {
        process.stderr.write(
          `[mail] REFUSED by ${config.smtp.host} sending as ${config.notifications.fromAddress}: ${result.response}\n`,
        );
      }
      return {
        ...base,
        destination: input.recipient.email,
        status: result.accepted ? 'SENT' : 'FAILED',
        detail: result.response,
      };
    } catch (error) {
      process.stderr.write(
        `[mail] FAILED to ${config.smtp.host} sending as ${config.notifications.fromAddress}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      // A refused connection, a TLS failure or a timeout. Recorded against this
      // recipient and this channel; the loop continues, because one bad address
      // must not stop the notice reaching everybody else.
      return {
        ...base,
        destination: input.recipient.email,
        status: 'FAILED',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // SMS, push and WhatsApp. Wired into the engine, no carrier behind them.
  const destination = input.channel === 'SMS' ? (input.recipient.mobile ?? '') : input.recipient.id;
  if (input.channel === 'SMS' && !destination) {
    return { ...base, destination: '', status: 'FAILED', detail: 'The recipient has no mobile number on record' };
  }

  return {
    ...base,
    destination,
    status: 'RECORDED',
    detail: `Dispatched to the ${input.channel.toLowerCase()} channel — no provider is configured, so nothing was transmitted`,
  };
}

/**
 * Fire one catalogue event at a set of recipients.
 *
 * `channels` may narrow the event's declared routing and may never widen it —
 * a caller cannot decide to start sending SMS for an event that does not
 * declare it.
 */
export async function notify(
  platform: Platform,
  input: {
    code: string;
    recipients: Recipient[];
    payload?: Record<string, unknown>;
    /** Narrow the routing. Omitted means the event's declared channels. */
    channels?: Channel[];
    branding: Branding;
    actorId: string;
    correlationId: string;
  },
): Promise<Dispatch> {
  const event = requireEvent(input.code);
  const payload = input.payload ?? {};
  const subject = fillTemplate(event.subject, payload);
  const dispatchId = ulid();

  const routed = input.channels
    ? event.channels.filter((channel) => input.channels!.includes(channel))
    : [...event.channels];

  const deliveries: Delivery[] = [];

  for (const recipient of input.recipients) {
    for (const channel of routed) {
      const verdict = allows(platform, { userId: recipient.id, code: event.code, channel });

      if (!verdict.allowed) {
        deliveries.push({
          id: ulid(),
          dispatchId,
          code: event.code,
          channel,
          recipientId: recipient.id,
          destination: '',
          status: 'SUPPRESSED',
          transport: transportFor(channel),
          detail:
            verdict.reason === 'MUTED_BY_USER'
              ? 'The recipient has muted this category on this channel'
              : 'Not a default channel for this event',
          reason: verdict.reason,
          at: new Date().toISOString(),
        });
        continue;
      }

      deliveries.push(
        await deliver(platform, {
          event,
          channel,
          recipient,
          subject,
          payload,
          branding: input.branding,
          dispatchId,
          verdict,
        }),
      );
    }
  }

  const dispatch: Dispatch = {
    id: dispatchId,
    code: event.code,
    title: event.title,
    category: event.category,
    severity: event.severity,
    mandatory: event.mandatory,
    subject,
    recipientIds: input.recipients.map((r) => r.id),
    deliveries,
    at: new Date().toISOString(),
  };

  const tenantId = input.recipients[0]?.tenantId ?? 'platform';

  platform.ledger.commit({
    tenantId,
    projectId: NOTIFICATIONS_PROJECT_ID,
    eventType: 'NOTIFICATION_DISPATCHED',
    entity: { refType: 'NotificationDispatch', refId: dispatchId },
    actor: { refType: 'System', refId: input.actorId },
    source: 'SYSTEM',
    correlationId: input.correlationId,
    nextState: { ...dispatch, deliveries: deliveries.length },
  });

  // One record per delivery, so "did the account-locked SMS reach them" is a
  // question with an answer rather than an inference from a summary.
  for (const delivery of deliveries) {
    platform.ledger.commit({
      tenantId,
      projectId: NOTIFICATIONS_PROJECT_ID,
      eventType: 'NOTIFICATION_DELIVERY_RECORDED',
      entity: { refType: 'NotificationDelivery', refId: delivery.id },
      actor: { refType: 'System', refId: input.actorId },
      source: 'SYSTEM',
      correlationId: input.correlationId,
      nextState: delivery,
    });
  }

  return dispatch;
}

/**
 * Every dispatch for one tenancy, most recent first.
 *
 * Scoped by tenant, not by the reserved project id. All tenancies share the
 * `platform-notifications` chain — that is what makes it a platform chain — so
 * reading it by project would hand one customer every other customer's
 * notification history, including the addresses in it.
 */
export function dispatches(platform: Platform, tenantId: string): Dispatch[] {
  return platform.ledger
    .listByTenant(tenantId, 'NotificationDispatch')
    .map((record) => record.state as unknown as Dispatch)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** Every delivery for one tenancy, most recent first. The "recent deliveries" feed. */
export function deliveries(platform: Platform, tenantId: string, limit = 50): Delivery[] {
  return platform.ledger
    .listByTenant(tenantId, 'NotificationDelivery')
    .map((record) => record.state as unknown as Delivery)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/**
 * A person's in-app inbox.
 *
 * Filtered by recipient *and* by tenancy. Either alone would be enough today
 * because an id is unique, but a person's inbox is exactly the read where an
 * id collision or an id supplied by a caller becomes somebody else's messages.
 */
export function inbox(platform: Platform, tenantId: string, userId: string, limit = 50): Delivery[] {
  return deliveries(platform, tenantId, Number.MAX_SAFE_INTEGER)
    .filter((delivery) => delivery.channel === 'INAPP' && delivery.recipientId === userId)
    .slice(0, limit);
}

/** Counts for the console header: attempted, and how many actually went. */
export function deliveryTotals(
  platform: Platform,
  tenantId: string,
): {
  attempted: number;
  sent: number;
  recorded: number;
  failed: number;
  suppressed: number;
} {
  const all = deliveries(platform, tenantId, Number.MAX_SAFE_INTEGER);
  return {
    attempted: all.length,
    sent: all.filter((d) => d.status === 'SENT').length,
    recorded: all.filter((d) => d.status === 'RECORDED').length,
    failed: all.filter((d) => d.status === 'FAILED').length,
    suppressed: all.filter((d) => d.status === 'SUPPRESSED').length,
  };
}

/** Which channels have a carrier behind them, for the console to state plainly. */
export function channelStatus(): Array<{ channel: Channel; wired: boolean; transport: string }> {
  return (['EMAIL', 'INAPP', 'SMS', 'PUSH', 'WHATSAPP'] as Channel[]).map((channel) => ({
    channel,
    wired: channel === 'EMAIL' ? Boolean(config.smtp.host) : WIRED[channel] === true,
    transport: transportFor(channel),
  }));
}
