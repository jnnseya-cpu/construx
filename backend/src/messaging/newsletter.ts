import { config } from '../config.ts';
import { ulid } from '../core/ids.ts';
import { ConflictError, DomainError } from '../core/errors.ts';
import type { Platform } from '../platform.ts';
import { PLATFORM_TENANT_ID } from '../platform.ts';
import { MARKETING_PROJECT_ID, resolveAudience, suppressedAddresses, unsubscribeUrl, type Exclusion, type Recipient, type Suppression } from './audience.ts';
import { FEATURES, featuresFor } from './content.ts';
import { buildMime, renderCampaign, type CampaignCopy } from './render.ts';
import { sendMail } from './smtp.ts';
import { postUrl } from '../site/article.ts';
import { publishedPosts } from '../site/blog.ts';
import { POSTS } from '../site/posts.ts';

/**
 * The weekly issue: composing it, sending it, and recording what happened.
 *
 * Two properties matter more than anything else here.
 *
 * The first is that a campaign is keyed by ISO week rather than by an id the
 * caller supplies. A scheduler that fires twice, a restart that re-enters the
 * send window, an operator pressing the button while the timer is running —
 * all of them resolve to the same week, and the second attempt returns the
 * campaign that already exists instead of mailing the customer base again.
 *
 * The second is that a delivery is recorded with what actually happened. A
 * message that was composed but not transmitted is `RECORDED`, never `SENT`.
 * The distinction exists because the operator screen is otherwise a report of
 * the platform's intentions rather than of its effects.
 */

export type DeliveryStatus = 'SENT' | 'RECORDED' | 'FAILED';

export type Delivery = {
  id: string;
  campaignId: string;
  week: string;
  userId: string;
  tenantId: string;
  email: string;
  status: DeliveryStatus;
  attemptedAt: string;
  /** Server response or error text. Verbatim, because a summary loses the cause. */
  detail: string;
  /**
   * For a failure: whether the relay refused for good (a 5xx reply — no such
   * user, domain gone) or for now (4xx, or the connection). A permanent refusal
   * suppresses the address; a transient one is retried on the next issue.
   */
  failure?: 'PERMANENT' | 'TRANSIENT';
  /**
   * Present when the relay accepted the message and a downstream server
   * bounced it later. The platform reads no mailbox, so the bounce reaches the
   * record only when an operator, or a relay posting to the bounce endpoint,
   * reports it. Recorded against the delivery it concerns, so the campaign
   * report shows what actually reached people rather than what the relay took.
   */
  bounce?: {
    /** The bounce diagnostic, verbatim: the DSN status and the remote server's text. */
    diagnostic: string;
    reportedAt: string;
    /** The operator who recorded it, or the relay that posted it. */
    reportedBy: string;
  };
};

export type Campaign = {
  id: string;
  week: string;
  subject: string;
  headline: string;
  intro: string;
  issuedAt: string;
  issuedBy: string;
  audienceSize: number;
  excludedCount: number;
  /** How the issue left the platform, decided once at issue time. */
  channel: 'SMTP' | 'RECORD_ONLY';
};

export type IssueReport = {
  campaign: Campaign;
  sent: number;
  recorded: number;
  failed: number;
  excluded: Exclusion[];
  deliveries: Delivery[];
  /** True when this week's issue already existed and nothing was re-sent. */
  alreadyIssued: boolean;
};

// --- Week keys --------------------------------------------------------------

/**
 * ISO-8601 week key, e.g. `2026-W34`.
 *
 * ISO weeks are used rather than "days since epoch / 7" because the week a
 * human means when they say "this week" has to match the one the scheduler
 * means, including across a year boundary where 1 January is week 52 of the
 * year before.
 */
export function isoWeek(date: Date): string {
  const local = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday determines the ISO year; day 0 (Sunday) counts as 7.
  const day = local.getUTCDay() || 7;
  local.setUTCDate(local.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(local.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((local.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${local.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// --- Copy -------------------------------------------------------------------

/**
 * The framing for a given week.
 *
 * The rotation is deterministic from the week number, so the same week always
 * produces the same issue: a resend after a failure is the message the reader
 * was already promised, and a preview shows what will actually be sent.
 */
export function copyForWeek(week: string, posts: CampaignCopy['posts'] = []): CampaignCopy {
  const index = Number(week.slice(-2));
  const lead = FEATURES[index % FEATURES.length]!;

  return {
    week,
    subject: `${lead.title} — CONSTRUX`,
    headline: lead.title,
    intro:
      'One data spine from concept to thirty years of operation: seven engines doing real arithmetic on your project, ' +
      'an append-only record that detects its own tampering, and agents that propose while people decide.',
    posts,
  };
}

/** How many blog posts an issue carries. Three is a section; ten is a second newsletter. */
export const POSTS_PER_ISSUE = 3;

/**
 * The newest posts on the public blog, compiled and published alike.
 *
 * Read from the record when the issue is composed rather than written into
 * the copy, so a post the marketing agent published this morning is in this
 * week's email without anybody editing anything. Only what is public: a draft
 * has no address to link to.
 */
export function latestPosts(platform: Platform, limit = POSTS_PER_ISSUE): NonNullable<CampaignCopy['posts']> {
  const entries = [
    ...POSTS.map((post) => ({ title: post.title, standfirst: post.standfirst, slug: post.slug, date: post.date })),
    ...(platform.ledger ? publishedPosts(platform) : []).map((post) => ({
      title: post.title,
      standfirst: post.standfirst,
      slug: post.slug,
      date: (post.publishedAt ?? '').slice(0, 10),
    })),
  ];
  return entries
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map((post) => ({ title: post.title, standfirst: post.standfirst, url: postUrl(post.slug) }));
}

// --- Reading ----------------------------------------------------------------

function campaigns(platform: Platform): Campaign[] {
  return platform.ledger
    .list(MARKETING_PROJECT_ID, 'NewsletterCampaign')
    .map((record) => record.state as unknown as Campaign);
}

export function campaignForWeek(platform: Platform, week: string): Campaign | undefined {
  return campaigns(platform).find((campaign) => campaign.week === week);
}

/** Every issue so far, most recent first. */
export function listCampaigns(platform: Platform): Campaign[] {
  return campaigns(platform).sort((a, b) => b.week.localeCompare(a.week));
}

export function deliveriesFor(platform: Platform, campaignId: string): Delivery[] {
  return platform.ledger
    .list(MARKETING_PROJECT_ID, 'NewsletterDelivery')
    .map((record) => record.state as unknown as Delivery)
    .filter((delivery) => delivery.campaignId === campaignId);
}

/** What a named recipient would receive, without sending anything. */
export function previewFor(recipient: Recipient, week = isoWeek(new Date()), posts: CampaignCopy['posts'] = []) {
  const copy = copyForWeek(week, posts);
  const rendered = renderCampaign(copy, recipient);
  return {
    week,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    features: featuresFor(recipient.roles).map((feature) => ({ id: feature.id, title: feature.title, path: feature.path })),
    posts: copy.posts ?? [],
  };
}

/**
 * Send this week's issue to one person, now, and record nothing against the
 * week.
 *
 * The operator's own address, before the audience gets it: the real message,
 * through the real relay, with the relay's answer returned. Refused rather than
 * "recorded" when no relay is configured — a test that quietly succeeds
 * without leaving the building proves nothing about deliverability.
 */
export async function sendTestIssue(
  platform: Platform,
  recipient: Recipient,
  options: { week?: string; transport?: { send: typeof sendMail } } = {},
): Promise<{ to: string; subject: string; week: string; response: string }> {
  if (!options.transport && !config.smtp.host) {
    throw new DomainError('NO_RELAY', 'No SMTP host is configured, so a test cannot leave the platform. Set SMTP_HOST first.', 409);
  }
  const week = options.week ?? isoWeek(new Date());
  const copy = copyForWeek(week, latestPosts(platform));
  const rendered = renderCampaign(copy, recipient);
  const raw = buildMime({
    to: recipient.email,
    toName: recipient.name,
    subject: `[TEST] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
    unsubscribe: unsubscribeUrl(recipient.userId),
    messageId: `test-${ulid()}`,
  });
  const send = options.transport?.send ?? sendMail;
  const result = await send({ from: config.newsletter.fromAddress, to: recipient.email, raw });
  return { to: recipient.email, subject: `[TEST] ${rendered.subject}`, week, response: result.response };
}

// --- Issuing ----------------------------------------------------------------

/** Record a permanent refusal against the address. One active record per address. */
function suppressAddress(
  platform: Platform,
  recipient: Pick<Recipient, 'userId' | 'email'>,
  campaignId: string,
  detail: string,
): void {
  const email = recipient.email.trim().toLowerCase();
  if (suppressedAddresses(platform).has(email)) return;
  const suppression: Suppression = {
    id: ulid(),
    email,
    userId: recipient.userId,
    campaignId,
    detail,
    status: 'ACTIVE',
    suppressedAt: new Date().toISOString(),
  };
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: MARKETING_PROJECT_ID,
    actor: { refType: 'System', refId: 'platform' },
    source: 'SYSTEM',
    correlationId: campaignId,
    eventType: 'NEWSLETTER_ADDRESS_SUPPRESSED',
    entity: { refType: 'NewsletterSuppression', refId: suppression.id },
    nextState: suppression as unknown as Record<string, unknown>,
  });
}

function nameOf(platform: Platform, userId: string): string {
  try {
    return platform.user(userId).name;
  } catch {
    return userId;
  }
}

export type BounceKind = NonNullable<Delivery['failure']>;

export type BounceInput = {
  /** The operator recording the bounce. */
  actorId: string;
  /** The address the bounce names. Matched against the delivery record, not the current user record. */
  email: string;
  /** The issue concerned, where the bounce message says. Absent, the most recent message sent to the address. */
  campaignId?: string;
  kind: BounceKind;
  /** The bounce diagnostic, verbatim. */
  diagnostic: string;
  /** Who reported it: the operator by default, or the relay's name when it posted the bounce. */
  reportedBy?: string;
};

/**
 * Record a bounce that arrived after the relay accepted the message.
 *
 * The relay's `250` means the relay took the message, not that a mailbox
 * received it. A domain that later says the user is unknown, a full mailbox,
 * a greylisting server that never came back: each of these is a bounce
 * message to the sender's mailbox, and this platform reads no mailbox. What
 * it does instead is take the report — an operator reading the bounce, or a
 * relay posting it — and record it against the delivery it concerns, so the
 * campaign report says `FAILED` where the message never arrived.
 *
 * A permanent bounce suppresses the address exactly as a synchronous
 * permanent refusal does: sending to a dead address next week is how a sender
 * gets blocklisted. A transient bounce leaves the address in the audience.
 */
export function recordBounce(platform: Platform, input: BounceInput): { delivery: Delivery; suppressed: boolean } {
  const email = (input.email ?? '').trim().toLowerCase();
  if (!email.includes('@')) throw new DomainError('BOUNCE_EMAIL_REQUIRED', 'The bounced address is required.', 400);
  const diagnostic = (input.diagnostic ?? '').trim();
  if (!diagnostic) {
    throw new DomainError('BOUNCE_DIAGNOSTIC_REQUIRED', 'The bounce diagnostic is required, verbatim from the bounce message.', 400);
  }
  if (input.kind !== 'PERMANENT' && input.kind !== 'TRANSIENT') {
    throw new DomainError('BOUNCE_KIND_INVALID', 'A bounce is PERMANENT (the address is gone) or TRANSIENT (try again next issue).', 400);
  }
  if (input.campaignId && !campaigns(platform).some((campaign) => campaign.id === input.campaignId)) {
    throw new DomainError('BOUNCE_CAMPAIGN_UNKNOWN', 'No issue with that id.', 404);
  }

  const forAddress = platform.ledger
    .list(MARKETING_PROJECT_ID, 'NewsletterDelivery')
    .map((record) => record.state as unknown as Delivery)
    .filter((delivery) => delivery.email.trim().toLowerCase() === email)
    .filter((delivery) => !input.campaignId || delivery.campaignId === input.campaignId)
    .sort((a, b) => b.attemptedAt.localeCompare(a.attemptedAt));

  if (forAddress.length === 0) {
    if (!platform.userByEmail(email)) {
      throw new DomainError('BOUNCE_ADDRESS_UNKNOWN', `${email} is not an address this platform has ever mailed.`, 404);
    }
    throw new DomainError(
      'BOUNCE_NO_DELIVERY',
      input.campaignId
        ? `${email} was not sent the issue named. Nothing to bounce.`
        : `${email} has been sent no issue. Nothing to bounce.`,
      409,
    );
  }

  const latest = forAddress[0]!;
  if (latest.bounce) {
    throw new ConflictError(`The ${latest.week} issue to ${email} is already recorded as bounced.`, 'BOUNCE_ALREADY_RECORDED');
  }
  if (latest.status !== 'SENT') {
    throw new ConflictError(
      latest.status === 'RECORDED'
        ? `The ${latest.week} issue to ${email} was composed and recorded, never transmitted, so it cannot have bounced.`
        : `The ${latest.week} issue to ${email} was refused by the relay at send time and is already recorded as failed.`,
      'BOUNCE_NOT_SENT',
    );
  }

  // The operator's name rather than their id, because this is read on a screen
  // by a person, and the event's actor already carries the id.
  const reportedBy = (input.reportedBy ?? '').trim() || nameOf(platform, input.actorId);
  const bounced: Delivery = {
    ...latest,
    status: 'FAILED',
    failure: input.kind,
    detail: `Accepted by the relay (${latest.detail}); bounced later: ${diagnostic}`,
    bounce: { diagnostic, reportedAt: new Date().toISOString(), reportedBy },
  };
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: MARKETING_PROJECT_ID,
    actor: { refType: 'User', refId: input.actorId },
    source: 'WEB',
    correlationId: bounced.campaignId,
    eventType: 'NEWSLETTER_DELIVERY_BOUNCED',
    entity: { refType: 'NewsletterDelivery', refId: bounced.id },
    nextState: bounced as unknown as Record<string, unknown>,
  });

  let suppressed = false;
  if (input.kind === 'PERMANENT') {
    suppressed = !suppressedAddresses(platform).has(email);
    suppressAddress(platform, { userId: bounced.userId, email }, bounced.campaignId, `Bounced after acceptance: ${diagnostic}`);
  }
  return { delivery: bounced, suppressed };
}

/**
 * Lift a suppression, so the next issue tries the address again.
 *
 * An operator's act, recorded under their name: the relay said the address
 * was gone, and somebody has decided it is worth another attempt — after the
 * person changed it, or the domain came back. The record of the refusal stays.
 */
export function clearSuppression(
  platform: Platform,
  actorId: string,
  userId: string,
): { suppression: Suppression; cleared: true } {
  const user = platform.user(userId);
  const active = suppressedAddresses(platform).get(user.email.trim().toLowerCase());
  if (!active) throw new DomainError('NOT_SUPPRESSED', `${user.name} is not suppressed.`, 404);
  const cleared: Suppression = { ...active, status: 'CLEARED', clearedAt: new Date().toISOString(), clearedBy: actorId };
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: MARKETING_PROJECT_ID,
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: cleared.id,
    eventType: 'NEWSLETTER_SUPPRESSION_CLEARED',
    entity: { refType: 'NewsletterSuppression', refId: cleared.id },
    nextState: cleared as unknown as Record<string, unknown>,
  });
  return { suppression: cleared, cleared: true };
}

function recordDelivery(platform: Platform, delivery: Delivery): void {
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: MARKETING_PROJECT_ID,
    actor: { refType: 'System', refId: 'platform' },
    source: 'SYSTEM',
    correlationId: delivery.campaignId,
    eventType: 'NEWSLETTER_DELIVERY_RECORDED',
    entity: { refType: 'NewsletterDelivery', refId: delivery.id },
    nextState: delivery as unknown as Record<string, unknown>,
  });
}

/**
 * Issue this week's newsletter.
 *
 * `issuedBy` is the identity that caused the send — an operator's user id, or
 * `scheduler` when the timer fired. It is recorded rather than inferred so that
 * "who sent this" is answerable without reading the timestamps.
 */
export async function issueNewsletter(
  platform: Platform,
  options: {
    issuedBy: string;
    week?: string;
    force?: boolean;
    /**
     * The submission, where a test supplies one. Absent, the configured SMTP
     * relay is used and the channel follows `SMTP_HOST`. Present, the channel
     * is SMTP whatever the configuration says — the point is to exercise the
     * relay's answers without a relay.
     */
    transport?: { send: typeof sendMail };
  } = { issuedBy: 'scheduler' },
): Promise<IssueReport> {
  const week = options.week ?? isoWeek(new Date());
  const existing = campaignForWeek(platform, week);

  if (existing && !options.force) {
    return {
      campaign: existing,
      sent: 0,
      recorded: 0,
      failed: 0,
      excluded: [],
      deliveries: deliveriesFor(platform, existing.id),
      alreadyIssued: true,
    };
  }
  if (existing && options.force) {
    // Re-issuing is for a run that failed part-way, not for mailing everyone
    // twice. Anyone already delivered to this week is skipped below.
    if (deliveriesFor(platform, existing.id).every((delivery) => delivery.status !== 'FAILED')) {
      throw new ConflictError(
        `The ${week} issue has already gone out with no failed deliveries to retry`,
        'CAMPAIGN_ALREADY_ISSUED',
      );
    }
  }

  const copy = copyForWeek(week, latestPosts(platform));
  const { recipients, excluded } = resolveAudience(platform);
  const channel: Campaign['channel'] = options.transport || config.smtp.host ? 'SMTP' : 'RECORD_ONLY';

  const campaign: Campaign = existing ?? {
    id: ulid(),
    week,
    subject: copy.subject,
    headline: copy.headline,
    intro: copy.intro,
    issuedAt: new Date().toISOString(),
    issuedBy: options.issuedBy,
    audienceSize: recipients.length,
    excludedCount: excluded.length,
    channel,
  };

  if (!existing) {
    platform.ledger.commit({
      tenantId: PLATFORM_TENANT_ID,
      projectId: MARKETING_PROJECT_ID,
      actor:
        options.issuedBy === 'scheduler'
          ? { refType: 'System', refId: 'platform' }
          : { refType: 'User', refId: options.issuedBy },
      source: 'SYSTEM',
      correlationId: campaign.id,
      eventType: 'NEWSLETTER_CAMPAIGN_ISSUED',
      entity: { refType: 'NewsletterCampaign', refId: campaign.id },
      nextState: campaign as unknown as Record<string, unknown>,
    });
  }

  const alreadyDelivered = new Set(
    deliveriesFor(platform, campaign.id)
      .filter((delivery) => delivery.status !== 'FAILED')
      .map((delivery) => delivery.userId),
  );

  const deliveries: Delivery[] = [];

  for (const recipient of recipients) {
    if (alreadyDelivered.has(recipient.userId)) continue;

    const rendered = renderCampaign(copy, recipient);
    const messageId = ulid();
    const raw = buildMime({
      to: recipient.email,
      toName: recipient.name,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      unsubscribe: unsubscribeUrl(recipient.userId),
      messageId,
    });

    const delivery: Delivery = {
      id: messageId,
      campaignId: campaign.id,
      week,
      userId: recipient.userId,
      tenantId: recipient.tenantId,
      email: recipient.email,
      status: 'RECORDED',
      attemptedAt: new Date().toISOString(),
      detail: 'Composed and recorded. No SMTP host is configured, so nothing was transmitted.',
    };

    if (channel === 'SMTP') {
      try {
        const send = options.transport?.send ?? sendMail;
        const result = await send({ from: config.newsletter.fromAddress, to: recipient.email, raw });
        delivery.status = 'SENT';
        delivery.detail = result.response;
      } catch (error) {
        // One bad address must not end the run. The failure is recorded against
        // the recipient so a retry knows exactly who to try again.
        delivery.status = 'FAILED';
        delivery.detail = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown }).code;
        delivery.failure = code === 'SMTP_PERMANENT' ? 'PERMANENT' : 'TRANSIENT';
        // A permanent refusal is the relay saying the address does not exist.
        // Sending to it again next week is how a sender gets blocklisted, so
        // the address is suppressed until an operator lifts it deliberately.
        if (delivery.failure === 'PERMANENT') suppressAddress(platform, recipient, campaign.id, delivery.detail);
      }
      if (config.newsletter.throttleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.newsletter.throttleMs));
      }
    }

    recordDelivery(platform, delivery);
    deliveries.push(delivery);
  }

  return {
    campaign,
    sent: deliveries.filter((d) => d.status === 'SENT').length,
    recorded: deliveries.filter((d) => d.status === 'RECORDED').length,
    failed: deliveries.filter((d) => d.status === 'FAILED').length,
    excluded,
    deliveries,
    alreadyIssued: false,
  };
}

// --- Scheduling -------------------------------------------------------------

/** Milliseconds between scheduler wake-ups. Hourly is fine for a weekly job. */
const TICK_MS = 3_600_000;

/**
 * The weekly timer.
 *
 * It wakes hourly and asks whether the configured send window has arrived and
 * this week's issue has not gone out. That is deliberately duller than
 * computing a precise delay: a long `setTimeout` drifts, does not survive a
 * clock change, and silently never fires if the process restarts a minute
 * before it was due. Week-keyed idempotency makes the polling safe.
 */
export function startNewsletterSchedule(
  platform: Platform,
  onIssue: (report: IssueReport) => void = () => {},
): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running || !config.newsletter.enabled) return;

    const now = new Date();
    const day = now.getUTCDay() === 0 ? 7 : now.getUTCDay();
    if (day !== config.newsletter.sendDayUtc || now.getUTCHours() !== config.newsletter.sendHourUtc) return;
    if (campaignForWeek(platform, isoWeek(now))) return;

    running = true;
    try {
      onIssue(await issueNewsletter(platform, { issuedBy: 'scheduler' }));
    } catch (error) {
      // A scheduler that dies on one bad week never runs again. Report and live.
      process.stderr.write(`[newsletter] issue failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  // Never hold the process open on account of the newsletter.
  timer.unref();
  void tick();

  return { stop: () => clearInterval(timer) };
}
