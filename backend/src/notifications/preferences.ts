import { ulid } from '../core/ids.ts';
import type { Platform } from '../platform.ts';
import {
  CATEGORIES,
  CHANNELS,
  eventsInCategory,
  requireEvent,
  type Category,
  type Channel,
} from './catalogue.ts';

/**
 * Notification preferences, and the thing they may not switch off.
 *
 * A preference is held per person, per category, per channel. Not per event:
 * 177 individual switches is a screen nobody completes, and the category is the
 * unit somebody actually has an opinion about ("stop emailing me about tasks",
 * not "stop emailing me about task.accepted").
 *
 * ---
 *
 * **Mandatory notices are not subject to preferences and never reach this
 * module's opinion.** `allows()` answers `true` for them before it reads
 * anything, and it says so in its return value rather than merely behaving that
 * way, so a caller displaying "muted" cannot show it for a notice that will be
 * sent regardless. Twenty-seven events carry the flag: account locked, password
 * changed, payment failed, compliance breach, data deletion. A person who has
 * muted "Login & Security" is still told their password was reset by somebody
 * else — that is the notice that lets them react to a compromise, and a product
 * that lets them turn it off has sold them a switch that harms them.
 *
 * The rule is enforced here rather than at the call sites because there are
 * many call sites and one of them will forget.
 */

/** The reserved chain platform-to-person communication is recorded on. */
export const NOTIFICATIONS_PROJECT_ID = 'platform-notifications';

export type ChannelPreference = Partial<Record<Channel, boolean>>;

export type NotificationPreferences = {
  id: string;
  userId: string;
  tenantId: string;
  /** Category → channel → whether the person wants it. Absent means default. */
  muted: Partial<Record<Category, ChannelPreference>>;
  updatedAt: string;
  updatedBy: string;
};

export type Verdict = {
  allowed: boolean;
  /** Why, in terms a preference screen can display without inventing a reason. */
  reason: 'MANDATORY' | 'DEFAULT_ON' | 'MUTED_BY_USER' | 'NOT_A_DEFAULT_CHANNEL';
};

function entityRef(userId: string) {
  return { refType: 'NotificationPreferences', refId: `prefs-${userId}` } as const;
}

export function readPreferences(platform: Platform, userId: string): NotificationPreferences | undefined {
  const record = platform.ledger.get(entityRef(userId));
  return record ? (record.state as NotificationPreferences) : undefined;
}

/**
 * Record a person's choice.
 *
 * Muting a category on a channel is expressed as `false`; clearing the entry
 * restores the catalogue default. Both are written as events — a preference
 * change is exactly the kind of fact somebody later disputes ("I never turned
 * that off"), so the history is the answer rather than the current value.
 */
export function setPreferences(
  platform: Platform,
  input: {
    userId: string;
    tenantId: string;
    muted: Partial<Record<Category, ChannelPreference>>;
    updatedBy: string;
    correlationId: string;
  },
): NotificationPreferences {
  for (const category of Object.keys(input.muted)) {
    if (!(CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`${category} is not a notification category`);
    }
  }
  for (const channels of Object.values(input.muted)) {
    for (const channel of Object.keys(channels ?? {})) {
      if (!(CHANNELS as readonly string[]).includes(channel)) {
        throw new Error(`${channel} is not a notification channel`);
      }
    }
  }

  const existing = readPreferences(platform, input.userId);
  const next: NotificationPreferences = {
    id: existing?.id ?? ulid(),
    userId: input.userId,
    tenantId: input.tenantId,
    muted: input.muted,
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  };

  platform.ledger.commit({
    tenantId: input.tenantId,
    projectId: NOTIFICATIONS_PROJECT_ID,
    eventType: 'NOTIFICATION_PREFERENCES_SET',
    entity: entityRef(input.userId),
    actor: { refType: 'User', refId: input.updatedBy },
    source: 'WEB',
    correlationId: input.correlationId,
    nextState: next,
  });

  return next;
}

/**
 * Whether an event may be sent to a person on a channel.
 *
 * Order matters and is the point: mandatory is answered before preferences are
 * loaded, and the default channel set is answered before the mute. A caller
 * cannot widen the routing by asking about a channel the event does not
 * declare.
 */
export function allows(
  platform: Platform,
  input: { userId: string; code: string; channel: Channel },
): Verdict {
  const event = requireEvent(input.code);

  // First, and without reading anything the recipient has said.
  if (event.mandatory) return { allowed: true, reason: 'MANDATORY' };

  if (!event.channels.includes(input.channel)) {
    return { allowed: false, reason: 'NOT_A_DEFAULT_CHANNEL' };
  }

  const preferences = readPreferences(platform, input.userId);
  const muted = preferences?.muted?.[event.category]?.[input.channel];

  if (muted === false) return { allowed: false, reason: 'MUTED_BY_USER' };
  return { allowed: true, reason: 'DEFAULT_ON' };
}

/**
 * What a preference screen should show: every category, the channels it fires
 * on, and whether each is switchable at all.
 *
 * A category containing a mandatory event still shows its other events as
 * switchable — muting "Login & Security" on email stops the successful-login
 * notice and does not stop the account-locked one. Stating that in the payload
 * is what stops the screen from either lying or refusing the whole category.
 */
export function preferenceMatrix(
  platform: Platform,
  userId: string,
): Array<{
  category: Category;
  channels: Array<{ channel: Channel; enabled: boolean; switchable: boolean; mandatoryEvents: number }>;
  events: number;
}> {
  const preferences = readPreferences(platform, userId);

  return CATEGORIES.map((category) => {
    const events = [...eventsInCategory(category)];
    const channels = CHANNELS.filter((channel) => events.some((e) => e.channels.includes(channel))).map((channel) => {
      const mandatoryOnChannel = events.filter((e) => e.mandatory && e.channels.includes(channel)).length;
      const optional = events.filter((e) => !e.mandatory && e.channels.includes(channel)).length;
      return {
        channel,
        enabled: preferences?.muted?.[category]?.[channel] !== false,
        // A category whose events on this channel are all mandatory has nothing
        // to switch, and showing a live control for it would be a lie.
        switchable: optional > 0,
        mandatoryEvents: mandatoryOnChannel,
      };
    });

    return { category, channels, events: events.length };
  });
}
