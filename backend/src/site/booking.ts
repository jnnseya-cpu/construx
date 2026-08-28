import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { config } from '../config.ts';
import type { AuthContext } from '../identity/auth.ts';
import { MARKETING_PROJECT_ID } from '../messaging/audience.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';

/**
 * Booking a guided walkthrough.
 *
 * The instant demonstration accounts are usually enough, and the page says so.
 * This is for the people they are not enough for — somebody evaluating for an
 * organisation, who wants twenty minutes and a person rather than a sandbox.
 *
 * There was nothing here at all: the only route in was `/contact`, which is an
 * email address and a hope. A form that offers specific times and books one is
 * a different proposition, and it is the difference between a lead and a
 * conversation.
 *
 * **Availability is computed, never stored.** Slots are generated from a
 * published window — working days, working hours, in a stated timezone — and
 * what is already booked is subtracted from them. Nothing has to be seeded, no
 * calendar has to be kept in step, and a slot cannot be offered that has quietly
 * expired: it is recomputed on every request against the clock.
 *
 * **A booking is a ledger record on the platform's own chain.** It is the
 * company's commitment to be somewhere at a time, which is exactly the kind of
 * thing this platform argues should be evidence rather than a row somebody can
 * edit. It also means it survives a restart, which a map would not.
 *
 * **It integrates with no calendar.** There is no Google Calendar, no Outlook
 * and no video link generated, because none of those are configured and
 * inventing a meeting URL that goes nowhere would be worse than none. The
 * booking is recorded and both sides are told; joining details follow from a
 * person. That limit is published on the confirmation rather than discovered
 * ten minutes before the call.
 */

export type BookingLanguage = 'EN' | 'FR';
export type BookingStatus = 'BOOKED' | 'CANCELLED' | 'COMPLETED';

export type Booking = {
  id: string;
  reference: string;
  /** ISO instant the session starts. UTC, always. */
  startsAt: string;
  minutes: number;
  name: string;
  email: string;
  organisation: string;
  language: BookingLanguage;
  /** What they want out of it. Optional, and the most useful field on the form. */
  about?: string;
  status: BookingStatus;
  bookedAt: string;
  cancelledAt?: string;
  cancelledReason?: string;
};

/**
 * The window, published rather than implied.
 *
 * Environment-overridable because a deployment in another timezone with another
 * working day should not need a code change, and hard-coding one company's
 * office hours into a platform is the kind of assumption that is invisible until
 * somebody in Lagos books 3am.
 */
export const BOOKING = {
  minutes: config.booking.minutes,
  /** UTC hours a session may start at. */
  hours: config.booking.hoursUtc,
  /** How many days ahead to offer, excluding weekends. */
  horizonDays: config.booking.horizonDays,
  /** How soon is too soon — nobody can prepare for a call in ten minutes. */
  leadHours: config.booking.leadHours,
  languages: ['EN', 'FR'] as const,
} as const;

function chain(): string {
  return MARKETING_PROJECT_ID;
}

/** A reference somebody can read down a telephone. */
function referenceFor(id: string): string {
  return `DEMO-${id.slice(-6).toUpperCase()}`;
}

export function bookings(platform: Platform): Booking[] {
  return platform.ledger
    .entitiesOfType('DemoBooking')
    .map((record) => record.state as unknown as Booking)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function commit(platform: Platform, actorId: string, { eventType, booking }: { eventType: string; booking: Booking }): void {
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: chain(),
    // A stranger booking a call has no identity on this platform, and inventing
    // one for them would put a user in the record who cannot sign in. The
    // platform itself is the actor; who asked is on the booking.
    actor: actorId === 'system' ? { refType: 'System', refId: 'platform' } : { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: booking.id,
    eventType,
    entity: { refType: 'DemoBooking', refId: booking.id },
    nextState: booking as unknown as Record<string, unknown>,
  });
}

/** Is this instant inside the published window, and far enough away to be useful? */
function offerable(at: Date, now: Date): boolean {
  const day = at.getUTCDay();
  // 0 Sunday, 6 Saturday. A weekend slot on a business demonstration is a slot
  // nobody turns up to.
  if (day === 0 || day === 6) return false;
  if (!BOOKING.hours.includes(at.getUTCHours())) return false;
  return at.getTime() - now.getTime() >= BOOKING.leadHours * 3_600_000;
}

export type Availability = {
  minutes: number;
  timezone: 'UTC';
  languages: readonly BookingLanguage[];
  /** Grouped by day, because that is how somebody picks one. */
  days: { date: string; label: string; slots: { startsAt: string; label: string }[] }[];
  note: string;
};

/**
 * Every slot that can still be booked.
 *
 * Computed from the clock on each request, so a page left open overnight offers
 * yesterday's times to nobody: the next request returns a list without them.
 */
export function availability(platform: Platform, now = new Date()): Availability {
  const taken = new Set(
    bookings(platform)
      .filter((booking) => booking.status === 'BOOKED')
      .map((booking) => booking.startsAt),
  );

  const days: Availability['days'] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (let offset = 0; days.length < BOOKING.horizonDays && offset < BOOKING.horizonDays * 3; offset += 1) {
    const day = new Date(cursor.getTime() + offset * 86_400_000);
    const slots: { startsAt: string; label: string }[] = [];

    for (const hour of BOOKING.hours) {
      const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour));
      const iso = at.toISOString();
      if (!offerable(at, now) || taken.has(iso)) continue;
      slots.push({ startsAt: iso, label: `${String(hour).padStart(2, '0')}:00 UTC` });
    }

    if (slots.length === 0) continue;
    days.push({
      date: day.toISOString().slice(0, 10),
      label: day.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' }),
      slots,
    });
  }

  return {
    minutes: BOOKING.minutes,
    timezone: 'UTC',
    languages: BOOKING.languages,
    days,
    note:
      `Times are UTC. Sessions are ${BOOKING.minutes} minutes, on working days, and the earliest is ` +
      `${BOOKING.leadHours} hours from now — a session booked for ten minutes' time is one nobody has prepared for. ` +
      'A slot disappears from this list the moment somebody takes it.',
  };
}

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

export function book(
  platform: Platform,
  input: { startsAt: string; name: string; email: string; organisation: string; language?: BookingLanguage; about?: string },
  now = new Date(),
): Booking {
  const name = input.name.trim();
  const email = input.email.trim().toLowerCase();
  const organisation = input.organisation.trim();

  if (name.length < 2) throw new DomainError('NAME_REQUIRED', 'A name, so somebody knows who they are meeting.', 422);
  if (!EMAIL.test(email)) throw new DomainError('EMAIL_REQUIRED', 'A working email address — the confirmation goes there.', 422);
  if (organisation.length < 2) {
    throw new DomainError(
      'ORGANISATION_REQUIRED',
      'Which organisation this is for. Twenty minutes goes further when whoever takes the call has looked you up first.',
      422,
    );
  }

  const at = new Date(input.startsAt);
  if (Number.isNaN(at.getTime())) throw new DomainError('SLOT_INVALID', 'That is not a time.', 422);
  // Re-checked against the window rather than trusted from the form. The list
  // was computed when the page was drawn and the page may have been open for
  // hours; a slot that has since passed, or was never on offer, is refused here.
  if (at.toISOString() !== new Date(at.toISOString()).toISOString() || !offerable(at, now)) {
    throw new DomainError(
      'SLOT_UNAVAILABLE',
      'That time is no longer available. It may have passed while this page was open, or it was never offered. Choose another.',
      409,
    );
  }

  const clash = bookings(platform).find((booking) => booking.status === 'BOOKED' && booking.startsAt === at.toISOString());
  if (clash) {
    // Somebody got there first. Said plainly rather than double-booking and
    // sorting it out by email afterwards.
    throw new DomainError('SLOT_TAKEN', 'Somebody booked that slot while this page was open. Choose another and it will hold.', 409);
  }

  const id = ulid();
  const booking: Booking = {
    id,
    reference: referenceFor(id),
    startsAt: at.toISOString(),
    minutes: BOOKING.minutes,
    name,
    email,
    organisation,
    language: input.language ?? 'EN',
    about: input.about?.trim() || undefined,
    status: 'BOOKED',
    bookedAt: now.toISOString(),
  };

  commit(platform, 'system', { eventType: 'DEMO_BOOKING_MADE', booking });
  return booking;
}

export function cancel(platform: Platform, actor: AuthContext, bookingId: string, reason: string): Booking {
  if (!actor.roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError('Only the platform operator may cancel a booking', 'PLATFORM_ADMIN_REQUIRED');
  }
  const record = platform.ledger.get({ refType: 'DemoBooking', refId: bookingId });
  if (!record) throw new NotFoundError(`No booking ${bookingId}`);
  const existing = record.state as unknown as Booking;
  if (existing.status !== 'BOOKED') throw new DomainError('NOT_BOOKED', 'That booking is not live.', 409);

  const stated = reason.trim();
  if (stated.length < 5) {
    throw new DomainError('REASON_REQUIRED', 'Say why. Somebody has this in their diary and is owed an explanation.', 422);
  }

  const updated: Booking = {
    ...existing,
    status: 'CANCELLED',
    cancelledAt: new Date().toISOString(),
    cancelledReason: stated,
  };
  commit(platform, actor.actorId, { eventType: 'DEMO_BOOKING_CANCELLED', booking: updated });
  return updated;
}

export type BookingPosition = {
  upcoming: Booking[];
  past: Booking[];
  cancelled: Booking[];
  counts: { upcoming: number; thisWeek: number; cancelled: number; total: number };
  /** Whether a confirmation can actually be sent. */
  canConfirm: boolean;
  summary: string;
};

export function bookingPosition(platform: Platform, actor: AuthContext, now = new Date()): BookingPosition {
  if (!actor.roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError('Only the platform operator may see the booking diary', 'PLATFORM_ADMIN_REQUIRED');
  }

  const all = bookings(platform);
  const live = all.filter((booking) => booking.status === 'BOOKED');
  const upcoming = live.filter((booking) => booking.startsAt >= now.toISOString());
  const weekEnd = new Date(now.getTime() + 7 * 86_400_000).toISOString();

  return {
    upcoming,
    past: live.filter((booking) => booking.startsAt < now.toISOString()),
    cancelled: all.filter((booking) => booking.status === 'CANCELLED'),
    counts: {
      upcoming: upcoming.length,
      thisWeek: upcoming.filter((booking) => booking.startsAt <= weekEnd).length,
      cancelled: all.filter((booking) => booking.status === 'CANCELLED').length,
      total: all.length,
    },
    // A booking recorded and never confirmed is somebody expecting a call that
    // nobody knows to make. Reported rather than assumed.
    canConfirm: config.smtp.host !== '',
    summary:
      all.length === 0
        ? 'Nobody has booked a walkthrough. The instant demonstration accounts are the route most people take and this is the one for the rest.'
        : `${upcoming.length} upcoming · ${all.length} booked in total.`,
  };
}
