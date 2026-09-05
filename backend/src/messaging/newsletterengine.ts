import { config, foreignSenderDomain } from '../config.ts';
import type { Platform } from '../platform.ts';
import { ROUTES } from '../api/routes.ts';
import { resolveAudience, suppressedAddresses, unsubscribeUrl, verifyUnsubscribeToken, type Recipient } from './audience.ts';
import { campaignForWeek, copyForWeek, deliveriesFor, isoWeek, latestPosts, listCampaigns, type Campaign, type Delivery } from './newsletter.ts';
import { buildMime, renderCampaign } from './render.ts';

/**
 * The newsletter read as a whole: whether what goes out can arrive, whether it
 * has been going out, and what to do next.
 *
 * `newsletter.ts` composes one issue and records what happened to each copy.
 * This module stands back from it, the way `site/visibility.ts` stands back
 * from one post, and asks the questions an operator otherwise answers by
 * hoping: is there a relay; does the sender domain match the site; will the
 * links open; does the one-click unsubscribe the headers promise actually
 * verify; is anybody in the audience; did the last issue bounce; when did one
 * last go out.
 *
 * Every check reads the real thing — the rendered MIME of this week's issue,
 * the configuration as loaded, the delivery record — never a flag saying it is
 * fine. The score is the weights of the checks that pass, shown beside the
 * failures and never instead of them, and it decides nothing: the issue is
 * sent by the schedule or the button whatever the score says, because a
 * newsletter that refuses to go out until a dashboard is green is a
 * newsletter that never goes out.
 */

export type DeliverabilityFinding = { check: string; ok: boolean; weight: number; detail: string };

/** A newsletter reads as alive while an issue has gone out inside this many days. Weekly, with a week of grace. */
export const CADENCE_DAYS = 14;
/** Failed and bounced copies over copies attempted, above which the sender's reputation is at stake. */
export const BOUNCE_LIMIT_PERCENT = 5;
/** Gmail clips a message above this and hides the footer — with the unsubscribe link in it. */
export const CLIP_BYTES = 102_400;
/** What a desktop client shows of a subject whole; a phone shows about sixty. */
export const SUBJECT_MAX = 78;

/** The reader the checks render for: nobody in particular, every feature in the running. */
const SAMPLE: Recipient = { userId: 'sample', tenantId: 'platform', name: 'Sample reader', email: 'reader@example.invalid', roles: [] };

function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replace(/&amp;/g, '&'));
}

/**
 * Whether a link in the issue lands on something this deployment serves.
 *
 * The console (`/app…`) is one application served for every path under it;
 * a landing anchor is the landing page; everything else has to be a public
 * HTML route in the table. A link that 404s in a marketing email is the
 * reader's last click.
 */
function linkResolves(href: string): boolean {
  const base = config.publicBaseUrl.replace(/\/$/, '');
  if (!href.startsWith(base)) return false;
  const path = href.slice(base.length).split('?')[0]!.split('#')[0] || '/';
  // The landing page is served by the gateway itself, before the route table.
  if (path === '/') return true;
  if (path === '/app' || path.startsWith('/app/')) return true;
  return ROUTES.some((route) => route.method === 'GET' && route.public && route.html && route.pattern === path);
}

function bounceRate(deliveries: Delivery[]): number | null {
  if (deliveries.length === 0) return null;
  const bad = deliveries.filter((delivery) => delivery.status === 'FAILED' || delivery.bounce !== undefined).length;
  return Math.round((bad / deliveries.length) * 1000) / 10;
}

export function deliverabilitySweep(platform: Platform, now: Date = new Date()): DeliverabilityFinding[] {
  const week = isoWeek(now);
  const copy = copyForWeek(week, latestPosts(platform));
  const rendered = renderCampaign(copy, SAMPLE);
  const raw = buildMime({
    to: SAMPLE.email,
    toName: SAMPLE.name,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    unsubscribe: unsubscribeUrl(SAMPLE.userId),
    messageId: 'sweep',
  });
  const headers = raw.split('\r\n\r\n')[0] ?? '';

  // 1. A relay. Without one an issue is composed, recorded and goes nowhere.
  const relay = config.smtp.host !== '';

  // 2. Sender alignment. Mail claiming to be from a domain that is not the
  // site's fails SPF/DMARC alignment unless that domain authorises the relay.
  const foreign = foreignSenderDomain(config.newsletter.fromAddress, config.publicBaseUrl);

  // 3. Every link is https. The unsubscribe link carries a signed token; over
  // http it is readable by every hop, and a corporate scanner following it
  // acts on the reader's behalf.
  const links = hrefsOf(rendered.html);
  const insecure = links.filter((href) => !href.startsWith('https://'));

  // 4. One-click unsubscribe: the headers promise it, and the token in the link verifies.
  const unsubscribeLink = links.find((href) => href.includes('/unsubscribe'));
  let tokenVerifies = false;
  try {
    const url = new URL(unsubscribeLink ?? 'http://invalid.invalid/');
    tokenVerifies = verifyUnsubscribeToken(url.searchParams.get('u') ?? '', url.searchParams.get('t') ?? '');
  } catch {
    tokenVerifies = false;
  }
  const oneClick = /^List-Unsubscribe: <https?:\/\/.+>$/m.test(headers) && /^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m.test(headers) && tokenVerifies;

  // 5. A plain-text part that carries the same destinations.
  const textHasLinks = rendered.text.includes(unsubscribeUrl(SAMPLE.userId)) && rendered.text.includes(`${config.publicBaseUrl}/app`);
  const plainText = /Content-Type: text\/plain; charset=utf-8/.test(raw) && textHasLinks;

  // 6. The subject fits a client whole.
  const subjectOk = rendered.subject.length > 0 && rendered.subject.length <= SUBJECT_MAX;

  // 7. Every link lands on something served.
  const dead = [...new Set(links)].filter((href) => !linkResolves(href));

  // 8. Under the clipping threshold.
  const bytes = Buffer.byteLength(rendered.html, 'utf8');

  // 9. Somebody to send to.
  const { recipients, excluded } = resolveAudience(platform);

  // 10. The last issue's bounce health.
  const latest = listCampaigns(platform)[0];
  const latestDeliveries = latest ? deliveriesFor(platform, latest.id) : [];
  const rate = bounceRate(latestDeliveries);

  // 11. Cadence.
  const ageDays = latest ? Math.floor((now.getTime() - new Date(latest.issuedAt).getTime()) / 86_400_000) : Number.POSITIVE_INFINITY;

  return [
    {
      check: 'Relay',
      ok: relay,
      weight: 14,
      detail: relay ? `Issues are transmitted through ${config.smtp.host}:${config.smtp.port}.` : 'SMTP_HOST is unset: an issue is composed and recorded against each recipient and leaves nobody’s inbox any different.',
    },
    {
      check: 'Sender alignment',
      ok: foreign === null,
      weight: 10,
      detail:
        foreign === null
          ? `${config.newsletter.fromAddress} is on the site’s own domain, so SPF and DMARC can align.`
          : `Sends as ${foreign.sender} while the site is ${foreign.origin}: mail fails alignment unless ${foreign.sender} publishes this relay in its SPF record.`,
    },
    {
      check: 'Secure links',
      ok: insecure.length === 0,
      weight: 8,
      detail: insecure.length === 0 ? `${links.length} links, all https.` : `${insecure.length} of ${links.length} links are not https (PUBLIC_BASE_URL is ${config.publicBaseUrl}); the unsubscribe token travels in clear.`,
    },
    {
      check: 'One-click unsubscribe',
      ok: oneClick,
      weight: 12,
      detail: oneClick
        ? 'List-Unsubscribe and List-Unsubscribe-Post are on the message and the signed token in the link verifies.'
        : `${/^List-Unsubscribe:/m.test(headers) ? '' : 'List-Unsubscribe header missing. '}${tokenVerifies ? '' : 'The unsubscribe token in the link does not verify against this deployment’s secret.'}`.trim(),
    },
    {
      check: 'Plain-text part',
      ok: plainText,
      weight: 6,
      detail: plainText ? 'A text/plain alternative carries the sign-in and unsubscribe links.' : 'The plain-text part is missing or does not carry the links a text-only client needs.',
    },
    {
      check: 'Subject',
      ok: subjectOk,
      weight: 6,
      detail: `"${rendered.subject}" — ${rendered.subject.length} characters${rendered.subject.length > 60 ? ', longer than a phone shows whole (60)' : ''}; a desktop client shows ${SUBJECT_MAX}.`,
    },
    {
      check: 'Links resolve',
      ok: dead.length === 0,
      weight: 10,
      detail: dead.length === 0 ? `Every one of ${new Set(links).size} distinct links lands on a page this deployment serves.` : `Not served here: ${dead.join(', ')}.`,
    },
    {
      check: 'Message size',
      ok: bytes <= CLIP_BYTES,
      weight: 6,
      detail: `${Math.round(bytes / 1024)} KB of HTML; Gmail clips above ${Math.round(CLIP_BYTES / 1024)} KB and hides the footer — and the unsubscribe link in it.`,
    },
    {
      check: 'Audience',
      ok: recipients.length > 0,
      weight: 8,
      detail: `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}; ${excluded.length} excluded with a reason each${
        excluded.length > 0 ? ` (${Object.entries(excluded.reduce<Record<string, number>>((counts, entry) => ({ ...counts, [entry.reason]: (counts[entry.reason] ?? 0) + 1 }), {})).map(([reason, count]) => `${reason.toLowerCase()} ${count}`).join(', ')})` : ''
      }.`,
    },
    {
      check: 'Bounce health',
      ok: rate !== null && rate <= BOUNCE_LIMIT_PERCENT,
      weight: 10,
      detail:
        rate === null
          ? 'No issue has gone out, so there is no delivery record to judge.'
          : `${rate}% of ${latestDeliveries.length} copies of ${latest!.week} failed or bounced; ${BOUNCE_LIMIT_PERCENT}% is where a sender’s reputation starts to go.`,
    },
    {
      check: 'Cadence',
      ok: ageDays <= CADENCE_DAYS,
      weight: 10,
      detail: latest ? `Last issue ${latest.week}, ${ageDays} day${ageDays === 1 ? '' : 's'} ago; a weekly list reads as alive inside ${CADENCE_DAYS}.` : 'No issue has gone out yet.',
    },
  ];
}

export type HealthScore = { score: number; band: 'STRONG' | 'WORKABLE' | 'WEAK'; passing: number; total: number; summary: string };

export function healthScore(findings: readonly DeliverabilityFinding[]): HealthScore {
  const total = findings.reduce((sum, finding) => sum + finding.weight, 0);
  const earned = findings.filter((finding) => finding.ok).reduce((sum, finding) => sum + finding.weight, 0);
  const score = total === 0 ? 0 : Math.round((earned / total) * 100);
  const failing = findings.filter((finding) => !finding.ok).sort((a, b) => b.weight - a.weight);
  return {
    score,
    band: score >= 90 ? 'STRONG' : score >= 65 ? 'WORKABLE' : 'WEAK',
    passing: findings.length - failing.length,
    total: findings.length,
    summary:
      failing.length === 0
        ? 'Every check passes. What goes out can arrive, and it has been going out.'
        : `${failing.length} check${failing.length === 1 ? '' : 's'} failing, costliest first: ${failing.map((finding) => finding.check).join(', ')}.`,
  };
}

export type Recommendation = {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  detail: string;
  action?: { label: string; command: 'issue' | 'test' | 'bounce' | 'suppressions' | 'configure' };
};

export function recommendations(platform: Platform, findings: readonly DeliverabilityFinding[]): Recommendation[] {
  const out: Recommendation[] = [];
  const failing = [...findings].filter((finding) => !finding.ok).sort((a, b) => b.weight - a.weight);
  const relay = config.smtp.host !== '';
  const thisWeek = campaignForWeek(platform, isoWeek(new Date()));

  for (const finding of failing) {
    const priority: Recommendation['priority'] = finding.weight >= 10 ? 'HIGH' : 'MEDIUM';
    if (finding.check === 'Relay' || finding.check === 'Sender alignment' || finding.check === 'Secure links') {
      out.push({ priority, title: `Fix: ${finding.check}`, detail: finding.detail, action: { label: 'What to set', command: 'configure' } });
    } else if (finding.check === 'Cadence') {
      out.push({ priority, title: thisWeek ? 'The list has gone quiet' : 'Issue this week', detail: finding.detail, action: { label: 'Issue this week now', command: 'issue' } });
    } else if (finding.check === 'Bounce health') {
      // With no issue out yet, the cadence line already offers the one door
      // that helps; a second line pointing at the same button is noise.
      if (finding.detail.startsWith('No issue')) continue;
      out.push({ priority, title: 'Bounces are high', detail: finding.detail, action: { label: 'Review who bounced', command: 'bounce' } });
    } else {
      out.push({ priority, title: `Fix: ${finding.check}`, detail: finding.detail });
    }
  }

  const suppressed = suppressedAddresses(platform).size;
  if (suppressed > 0) {
    out.push({
      priority: 'LOW',
      title: `${suppressed} address${suppressed === 1 ? '' : 'es'} suppressed`,
      detail: 'Each bounced permanently on an earlier issue and is skipped until an operator lifts it. Lift one only when the mailbox is known to exist again.',
      action: { label: 'See who', command: 'suppressions' },
    });
  }

  if (relay && !thisWeek) {
    out.push({
      priority: 'LOW',
      title: 'Send yourself a test before the week’s send',
      detail: 'The real message through the real relay to your own address, recorded against nothing. The relay’s answer comes back.',
      action: { label: 'Send a test to me', command: 'test' },
    });
  }

  return out.slice(0, 10);
}

/** The next moment the timer will act, or null while it is not armed. */
export function nextScheduledSend(now: Date = new Date()): string | null {
  if (!config.newsletter.enabled) return null;
  const wanted = config.newsletter.sendDayUtc; // 1 = Monday … 7 = Sunday
  const hour = config.newsletter.sendHourUtc;
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0, 0));
  for (let offset = 0; offset < 8; offset += 1) {
    const day = new Date(candidate.getTime() + offset * 86_400_000);
    const iso = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
    if (iso === wanted && day.getTime() > now.getTime()) return day.toISOString();
  }
  return null;
}

export type NewsletterPosition = {
  health: HealthScore;
  sweep: DeliverabilityFinding[];
  reach: {
    audience: number;
    byRole: Record<string, number>;
    excluded: number;
    suppressed: number;
    totals: { issues: number; sent: number; recorded: number; failed: number; bounced: number };
    series: Array<{ week: string; sent: number; recorded: number; failed: number; bounced: number; audience: number }>;
  };
  issue: {
    week: string;
    subject: string;
    headline: string;
    posts: NonNullable<ReturnType<typeof latestPosts>>;
    issued: Campaign | null;
  };
  schedule: { enabled: boolean; dayUtc: number; hourUtc: number; nextRunAt: string | null; channel: 'SMTP' | 'RECORD_ONLY' };
  recommendations: Recommendation[];
  limits: string[];
};

export function newsletterPosition(platform: Platform, now: Date = new Date()): NewsletterPosition {
  const sweep = deliverabilitySweep(platform, now);
  const week = isoWeek(now);
  const copy = copyForWeek(week, latestPosts(platform));
  const { recipients, excluded } = resolveAudience(platform);
  const campaigns = listCampaigns(platform);
  const series = campaigns
    .map((campaign) => {
      const deliveries = deliveriesFor(platform, campaign.id);
      return {
        week: campaign.week,
        sent: deliveries.filter((delivery) => delivery.status === 'SENT').length,
        recorded: deliveries.filter((delivery) => delivery.status === 'RECORDED').length,
        failed: deliveries.filter((delivery) => delivery.status === 'FAILED').length,
        bounced: deliveries.filter((delivery) => delivery.bounce !== undefined).length,
        audience: campaign.audienceSize,
      };
    })
    .sort((a, b) => a.week.localeCompare(b.week));

  return {
    health: healthScore(sweep),
    sweep,
    reach: {
      audience: recipients.length,
      byRole: recipients.reduce<Record<string, number>>((counts, recipient) => {
        for (const role of recipient.roles) counts[role] = (counts[role] ?? 0) + 1;
        return counts;
      }, {}),
      excluded: excluded.length,
      suppressed: suppressedAddresses(platform).size,
      totals: {
        issues: campaigns.length,
        sent: series.reduce((sum, entry) => sum + entry.sent, 0),
        recorded: series.reduce((sum, entry) => sum + entry.recorded, 0),
        failed: series.reduce((sum, entry) => sum + entry.failed, 0),
        bounced: series.reduce((sum, entry) => sum + entry.bounced, 0),
      },
      series,
    },
    issue: {
      week,
      subject: copy.subject,
      headline: copy.headline,
      posts: copy.posts ?? [],
      issued: campaignForWeek(platform, week) ?? null,
    },
    schedule: {
      enabled: config.newsletter.enabled,
      dayUtc: config.newsletter.sendDayUtc,
      hourUtc: config.newsletter.sendHourUtc,
      nextRunAt: nextScheduledSend(now),
      channel: config.smtp.host ? 'SMTP' : 'RECORD_ONLY',
    },
    recommendations: recommendations(platform, sweep),
    limits: [
      'No open or click tracking. The platform puts no pixel and no redirect in the message; “sent” is the relay’s acceptance, not a reader’s eyes.',
      'A bounce that arrives after the relay accepted the message reaches the record only when somebody records it; the platform reads no mailbox.',
      'The score says whether what goes out can arrive and whether it has been going out. It decides nothing: the schedule and the button send regardless.',
    ],
  };
}
