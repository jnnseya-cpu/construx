import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { FEATURES, type Feature } from '../messaging/content.ts';
import { esc } from '../messaging/render.ts';
import { sendMail, type SmtpOptions } from '../messaging/smtp.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';
import type { RequestContext } from '../api/middleware.ts';
import { hyperlink, postUrl, SHARE_CHANNELS, shareTargets, wordsOf } from './article.ts';
import {
  BLOG_PROJECT_ID,
  type BlogPost,
  commitPost,
  type PostActor,
  posts,
  publishAs,
  publishedPosts,
  SEO,
  seoReport,
  seoScore,
  uniqueSlug,
} from './blog.ts';
import { robots, sitemap } from './discovery.ts';
import { POST_PAGES, render, renderLanding, SITE_PAGES } from './index.ts';
import { mediaState } from './media.ts';
import { POSTS } from './posts.ts';
import { engagementFor, viewsPosition } from './views.ts';

/**
 * The visibility engine: what the public site looks like from outside, and the
 * marketing agent that keeps it moving.
 *
 * `blog.ts` governs one post at a time — its checks, its gate, its record. This
 * module reads the site as a whole and acts on the whole: a sweep of the
 * eleven things a crawler, a link preview and a search result actually look
 * for, each checked against the rendered markup rather than against a
 * checklist; the reach the pages have had; where a post can be sent and where
 * it has been; a composer that writes a post from the feature catalogue; a
 * library of one post per topic; and a daily release that runs once a day and
 * says what it did.
 *
 * Four rules hold, and each is the reason a line below is shaped the way it is.
 *
 * **Every check reads the real thing.** The sweep renders the pages and reads
 * their heads; it parses the sitemap it would serve; it stats the hero image.
 * A check that reads a flag saying "hreflang: on" is a check that passes while
 * the page is broken.
 *
 * **The template says only what the product already says.** `composePost`
 * assembles a post from `FEATURES` — the sentences the newsletter already sends
 * about capabilities that exist and link to screens that serve them — around a
 * topic and a keyword. It invents no figure, no customer and no claim. That is
 * what makes it the one authorship allowed to publish without a person: every
 * sentence was a published sentence before the post existed. A *model's* prose
 * still lands as a draft a person publishes, exactly as `draftPost` insists.
 *
 * **A channel is either configured or it is absent — never pretend.** Each
 * outside channel names the variable it is missing. Nothing is queued for a
 * channel with no credential, and a send that the network refused is on the
 * record as refused, with the network's answer.
 *
 * **Once a day means once a day.** The release is keyed by UTC date on the
 * chain. The timer and the button both ask the record first, so a restart at
 * 08:59 and a press at 09:01 produce one release, not two.
 */

// --- Topics -------------------------------------------------------------------

export type Topic = {
  id: string;
  /** The article's title, which carries the keyword — the gate requires it. */
  title: string;
  /** The phrase the post is meant to be found by. */
  keyword: string;
  /** The category the post is filed under, and the coverage check reads. */
  tag: string;
  /** Which entries of the feature catalogue the body draws on. */
  features: string[];
};

/**
 * The eight things the site should have a page about.
 *
 * One per capability area a buyer searches for, phrased as the phrase they
 * would type. Coverage is "a published post carries this keyword", nothing
 * softer: a topic with a draft about it is not covered, because a draft is not
 * on the internet.
 */
export const TOPICS: readonly Topic[] = [
  { id: 'commercial', title: 'Cost value reconciliation on a live project', keyword: 'cost value reconciliation', tag: 'Commercial', features: ['commercial', 'payments', 'billing'] },
  { id: 'contracts', title: 'Delay claim assessment with concurrency, not memory', keyword: 'delay claim assessment', tag: 'Contracts', features: ['contracts', 'payments', 'audit'] },
  { id: 'programme', title: 'Critical path float and a real probability of finishing', keyword: 'critical path float', tag: 'Programme', features: ['programme', 'autopilot', 'copilot'] },
  { id: 'risk', title: 'A P80 contingency you can defend in a board paper', keyword: 'P80 contingency', tag: 'Risk & Safety', features: ['risk', 'autopilot', 'audit'] },
  { id: 'field', title: 'Offline site records that survive no signal', keyword: 'offline site records', tag: 'Field', features: ['field', 'audit', 'copilot'] },
  { id: 'design', title: 'A drawing register with supersession and the RFI trail', keyword: 'drawing register', tag: 'Design & BIM', features: ['design', 'audit', 'autopilot'] },
  { id: 'handover', title: 'A handover pack that starts on day one', keyword: 'handover pack', tag: 'Handover', features: ['handover', 'audit', 'enterprise'] },
  { id: 'governance', title: 'The golden thread that detects its own tampering', keyword: 'golden thread', tag: 'Governance', features: ['audit', 'autopilot', 'copilot'] },
];

/** The post that covers a topic, if one is on the record. Published first. */
function postForTopic(platform: Platform, topic: Topic): BlogPost | undefined {
  const matching = posts(platform).filter((post) => post.keyword.trim().toLowerCase() === topic.keyword.toLowerCase());
  return matching.find((post) => post.status === 'PUBLISHED') ?? matching.find((post) => post.status === 'DRAFT') ?? matching[0];
}

export function topicCoverage(platform: Platform): Array<Topic & { covered: boolean; post?: { id: string; slug: string; status: BlogPost['status'] } }> {
  return TOPICS.map((topic) => {
    const post = postForTopic(platform, topic);
    return {
      ...topic,
      covered: post?.status === 'PUBLISHED',
      ...(post ? { post: { id: post.id, slug: post.slug, status: post.status } } : {}),
    };
  });
}

// --- The composer -------------------------------------------------------------

export type ComposeInput = {
  /** What the post is about, in a phrase. Becomes the title where it fits. */
  topic: string;
  /** The phrases it should be found by. The first is the one the checks enforce. */
  keywords: string[];
  tag?: string;
  /** Publish on the spot where every check passes. Default true. */
  publish?: boolean;
};

export type ComposeResult = {
  post: BlogPost;
  seo: ReturnType<typeof seoReport>;
  /** What actually happened, because "generate & publish" can legitimately stop at "generate". */
  outcome: 'PUBLISHED' | 'DRAFT' | 'HELD_BY_CHECKS';
  /** The checks that held it, when they did. */
  held: string[];
  /** Which pages the body links into, read from the same linker the page uses. */
  linked: Array<{ term: string; path: string }>;
};

function capitalise(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/**
 * A title that fits a search result and carries the keyword.
 *
 * Tried in order of how natural each reads; the first that fits wins. None
 * fitting is refused with the reason rather than published truncated — a title
 * cut mid-word is exactly what the title check exists to stop.
 */
function fitTitle(topic: string, keyword: string): string {
  const candidates = [
    topic,
    `${topic}: ${keyword}`,
    `${capitalise(keyword)}: ${topic}`,
    `${capitalise(keyword)} on a governed construction record`,
    `${capitalise(keyword)}: what the record has to show`,
  ];
  const lower = keyword.toLowerCase();
  const fit = candidates.find(
    (candidate) => candidate.length >= SEO.titleMin && candidate.length <= SEO.titleMax && candidate.toLowerCase().includes(lower),
  );
  if (!fit) {
    throw new DomainError(
      'TITLE_UNFITTABLE',
      `No title between ${SEO.titleMin} and ${SEO.titleMax} characters can be made from "${topic}" that carries "${keyword}". ` +
        'Shorten the topic or the keyword.',
      422,
    );
  }
  return fit;
}

/** The catalogue entries a free-form topic is about, by the words it shares with them. */
function featuresFor(topic: string, keywords: string[], preferred: string[] = []): Feature[] {
  const byId = new Map(FEATURES.map((feature) => [feature.id, feature] as const));
  const chosen: Feature[] = preferred.map((id) => byId.get(id)).filter((feature): feature is Feature => feature !== undefined);
  if (chosen.length >= 3) return chosen.slice(0, 3);

  const words = `${topic} ${keywords.join(' ')}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 3);
  const scored = FEATURES.filter((feature) => !chosen.includes(feature))
    .map((feature) => {
      const haystack = `${feature.title} ${feature.blurb}`.toLowerCase();
      return { feature, score: words.filter((word) => haystack.includes(word)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const entry of scored) {
    if (chosen.length >= 3) break;
    chosen.push(entry.feature);
  }
  // The three every post can truthfully say, when nothing more specific matched.
  for (const id of ['audit', 'autopilot', 'copilot']) {
    if (chosen.length >= 3) break;
    const feature = byId.get(id);
    if (feature && !chosen.includes(feature)) chosen.push(feature);
  }
  return chosen;
}

/**
 * The body, from the catalogue.
 *
 * The opening carries the keyword, as the gate requires; the middle is the
 * catalogue's own sentences under the feature's own title; the close names the
 * three things a reader can check without taking anybody's word — replay, the
 * document hash, the provenance on AI output — and points at the demonstration.
 * Phrases the glossary knows ("golden thread", "demo environment", "verify a
 * document") are in the fixed prose on purpose, so every composed post links
 * into the site at least twice.
 */
function composeBody(keyword: string, features: Feature[]): string[] {
  const lead = capitalise(keyword);
  return [
    `${lead} is the kind of thing a construction project usually argues about after the fact, from memory, with the ` +
      'evidence spread across inboxes and spreadsheets. CONSTRUX treats it as a record: every change to it is an ' +
      'append-only, hash-chained event on the golden thread, written before it is acknowledged, so the question ' +
      '"what did we know, and when" has an answer rather than an opinion.',
    '## Where it goes wrong',
    'The failure is rarely a missing number. It is a number that exists in three places and agrees in none of them — ' +
      `the site diary, the commercial report and the board paper each telling a slightly different story about ${keyword}, ` +
      'with nobody able to say which was true on the day it mattered. By the time the disagreement surfaces it is a ' +
      'dispute rather than a decision, and a dispute is priced by whoever kept the better record.',
    '## How CONSTRUX handles it',
    ...features.map((feature) => `${feature.title}. ${feature.blurb}`),
    '> A record you can replay is a record you can rely on.',
    '## What you can check for yourself',
    'None of this asks for trust. Replay reconstructs a project from its own history and reports a root hash; a ' +
      'document issued from the platform carries a content hash that lets anybody verify a document against what was ' +
      'issued; and every AI-assisted step names the engine that produced it and the records it read. If ' +
      `${keyword} matters on your projects, the demo environment runs the whole cycle on a seeded programme — open it, ` +
      'run it, and read the record it leaves behind.',
  ];
}

/**
 * Write a post from the catalogue, and publish it where every check passes.
 *
 * `publish` defaults to true because that is what the button says, and the
 * result says what happened: PUBLISHED, DRAFT (asked not to), or HELD_BY_CHECKS
 * with the checks named — never a success that did not occur.
 */
export function composePost(platform: Platform, actor: PostActor, input: ComposeInput, topicDefinition?: Topic): ComposeResult {
  const topic = input.topic.trim();
  const keywords = input.keywords.map((keyword) => keyword.trim()).filter(Boolean);
  if (topic.length < 3 || topic.length > 80) throw new DomainError('TOPIC_REQUIRED', 'Say what the post is about, in three to eighty characters.', 422);
  if (keywords.length === 0) throw new DomainError('KEYWORD_REQUIRED', 'A post needs at least one phrase it is meant to be found by.', 422);
  if (keywords.length > 5) throw new DomainError('TOO_MANY_KEYWORDS', 'Five keywords at most. A post found by everything is found by nothing.', 422);
  for (const keyword of keywords) {
    if (keyword.length < 3 || keyword.length > 40) {
      throw new DomainError('KEYWORD_LENGTH', `"${keyword}" — a keyword is between three and forty characters.`, 422);
    }
  }

  const keyword = keywords[0]!;
  const title = fitTitle(topic, keyword);
  const slug = uniqueSlug(platform, title);
  if (slug.length === 0) throw new DomainError('TITLE_REQUIRED', 'That title produces no usable address.', 422);

  const features = featuresFor(topic, keywords, topicDefinition?.features);
  const body = composeBody(keyword, features);

  const post: BlogPost = {
    id: ulid(),
    slug,
    title,
    standfirst: `What ${keyword} looks like on a governed record, and the checks a reader can run for themselves.`,
    metaDescription:
      `${capitalise(keyword)}: how CONSTRUX records it as governed, evidenced events on the golden thread, and what a ` +
      'reader can verify for themselves.',
    body,
    tag: input.tag?.trim() || topicDefinition?.tag || 'Marketing',
    keyword,
    status: 'DRAFT',
    authorship: 'MARKETING_AGENT',
    draftedAt: new Date().toISOString(),
    draftedBy: actor.refId,
  };

  commitPost(platform, actor, { eventType: 'SITE_POST_DRAFTED', post });

  const seo = seoReport(post);
  const held = seo.filter((finding) => !finding.ok).map((finding) => `${finding.check}: ${finding.detail}`);
  const { linked } = hyperlink(body.map((line) => esc(line)), { exclude: `/blog/${slug}` });

  if (input.publish === false) return { post, seo, outcome: 'DRAFT', held, linked };
  if (held.length > 0) return { post, seo, outcome: 'HELD_BY_CHECKS', held, linked };

  const published = publishAs(platform, actor, post.id);
  return { post: published.post, seo: published.seo, outcome: 'PUBLISHED', held: [], linked };
}

/**
 * One post per topic that has none.
 *
 * Idempotent by keyword: a topic with a post already on the record — published
 * or still a draft — is skipped and said so, so pressing the button twice
 * writes nothing twice.
 */
export function generateLibrary(
  platform: Platform,
  actor: PostActor,
): { created: ComposeResult[]; skipped: Array<{ topic: string; because: string }> } {
  const created: ComposeResult[] = [];
  const skipped: Array<{ topic: string; because: string }> = [];
  for (const topic of TOPICS) {
    const existing = postForTopic(platform, topic);
    if (existing) {
      skipped.push({ topic: topic.id, because: `Already on the record as /blog/${existing.slug} (${existing.status.toLowerCase()}).` });
      continue;
    }
    created.push(composePost(platform, actor, { topic: topic.title, keywords: [topic.keyword], tag: topic.tag }, topic));
  }
  return { created, skipped };
}

// --- Share kit ----------------------------------------------------------------

export type ShareKitEntry = {
  channel: string;
  label: string;
  /** The network's composer with the address in it, or the address itself for copy. */
  url: string;
  /** Suggested copy, within the network's limit where it has one. */
  text: string;
};

/** What to paste where, per channel, for one post. Deterministic, from the record. */
export function shareKit(post: Pick<BlogPost, 'slug' | 'title' | 'standfirst'>): ShareKitEntry[] {
  const url = postUrl(post.slug);
  const targets = shareTargets({ url, title: post.title });
  const long = `${post.title}\n\n${post.standfirst}\n\n${url}`;
  // X counts a link as 23 characters whatever its length; the rest is text.
  const room = 280 - 23 - 1;
  const short = post.title.length <= room ? `${post.title} ${url}` : `${post.title.slice(0, room - 1)}… ${url}`;
  return SHARE_CHANNELS.map((channel) => ({
    channel: channel.id,
    label: channel.label,
    url: channel.id === 'copy' ? url : targets[channel.id],
    text: channel.id === 'x' ? short : channel.id === 'email' ? `${post.title}\n\n${post.standfirst}\n\nRead it: ${url}` : long,
  }));
}

// --- Distribution -------------------------------------------------------------

export type DistributionChannel = 'linkedin' | 'x' | 'email';

export type ChannelStatus = {
  id: DistributionChannel;
  label: string;
  configured: boolean;
  /** The environment variables that are unset, so the screen can say which. */
  missing: string[];
  /** Where a send goes, in words. */
  target: string;
};

export function distributionChannels(): ChannelStatus[] {
  const m = config.marketing;
  const linkedinMissing = [m.linkedinAccessToken === '' ? 'LINKEDIN_ACCESS_TOKEN' : '', m.linkedinOrgId === '' ? 'LINKEDIN_ORG_ID' : ''].filter(Boolean);
  const xMissing = [m.xAccessToken === '' ? 'X_ACCESS_TOKEN' : ''].filter(Boolean);
  const emailMissing = [config.smtp.host === '' ? 'SMTP_HOST' : '', m.announceTo === '' ? 'MARKETING_ANNOUNCE_TO' : ''].filter(Boolean);
  return [
    {
      id: 'linkedin',
      label: 'LinkedIn',
      configured: linkedinMissing.length === 0,
      missing: linkedinMissing,
      target: m.linkedinOrgId ? `organisation ${m.linkedinOrgId}` : 'the organisation page named by LINKEDIN_ORG_ID',
    },
    { id: 'x', label: 'X', configured: xMissing.length === 0, missing: xMissing, target: 'the account the token belongs to' },
    {
      id: 'email',
      label: 'Email',
      configured: emailMissing.length === 0,
      missing: emailMissing,
      target: m.announceTo || 'the address named by MARKETING_ANNOUNCE_TO',
    },
  ];
}

export type Distribution = {
  id: string;
  postId: string;
  slug: string;
  channel: DistributionChannel;
  status: 'SENT' | 'FAILED';
  /** The network's identifier for what it created, where it gave one. */
  remoteId?: string;
  /** The network's answer, in its words. */
  detail: string;
  at: string;
  by: PostActor;
};

/**
 * Where each channel is reached. Held in one place, and replaceable, so the
 * client is tested against a socket that answers like the network rather than
 * against a mock of itself.
 */
const targets: { linkedin: string; x: string; smtp?: SmtpOptions } = {
  linkedin: 'https://api.linkedin.com/rest/posts',
  x: 'https://api.x.com/2/tweets',
};

/** Test isolation only. */
export function setDistributionTargets(overrides: Partial<typeof targets>): void {
  Object.assign(targets, overrides);
}

/** How long a network gets to answer before the send is recorded as failed. */
const SEND_TIMEOUT_MS = 15_000;

export function distributionsFor(platform: Platform, postId?: string): Distribution[] {
  return platform.ledger
    .list(BLOG_PROJECT_ID, 'SitePostDistribution')
    .map((row) => row.state as unknown as Distribution)
    .filter((entry) => postId === undefined || entry.postId === postId)
    .sort((a, b) => a.at.localeCompare(b.at));
}

async function readAnswer(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return '';
  }
}

async function sendLinkedIn(post: BlogPost): Promise<{ remoteId?: string; detail: string }> {
  const kit = shareKit(post).find((entry) => entry.channel === 'linkedin')!;
  const response = await fetch(targets.linkedin, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.marketing.linkedinAccessToken}`,
      'content-type': 'application/json',
      'linkedin-version': '202409',
      'x-restli-protocol-version': '2.0.0',
    },
    body: JSON.stringify({
      author: `urn:li:organization:${config.marketing.linkedinOrgId}`,
      commentary: kit.text,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { article: { source: postUrl(post.slug), title: post.title, description: post.standfirst } },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LinkedIn answered ${response.status}: ${await readAnswer(response)}`);
  const remoteId = response.headers.get('x-restli-id') ?? undefined;
  return { remoteId, detail: `LinkedIn accepted the post (${response.status})${remoteId ? ` as ${remoteId}` : ''}.` };
}

async function sendX(post: BlogPost): Promise<{ remoteId?: string; detail: string }> {
  const kit = shareKit(post).find((entry) => entry.channel === 'x')!;
  const response = await fetch(targets.x, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.marketing.xAccessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: kit.text }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`X answered ${response.status}: ${await readAnswer(response)}`);
  let remoteId: string | undefined;
  try {
    const parsed = JSON.parse(await response.text()) as { data?: { id?: unknown } };
    if (typeof parsed.data?.id === 'string') remoteId = parsed.data.id;
  } catch {
    // An answer that is not JSON is still a 2xx: the post went. The id is a courtesy.
  }
  return { remoteId, detail: `X accepted the post (${response.status})${remoteId ? ` as ${remoteId}` : ''}.` };
}

/** RFC 2047, so a title with a dash or an accent survives the Subject line. */
function encodedWord(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function sendEmail(post: BlogPost): Promise<{ remoteId?: string; detail: string }> {
  const kit = shareKit(post).find((entry) => entry.channel === 'email')!;
  const body = Buffer.from(kit.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const raw = [
    `From: ${encodedWord(config.newsletter.fromName)} <${config.newsletter.fromAddress}>`,
    `To: <${config.marketing.announceTo}>`,
    `Subject: ${encodedWord(`New on the CONSTRUX blog: ${post.title}`)}`,
    `Message-ID: <${post.id}.announce@construxvg.com>`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    'Auto-Submitted: auto-generated',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
    '',
  ].join('\r\n');
  const result = await sendMail(
    { from: config.newsletter.fromAddress, to: config.marketing.announceTo, raw },
    targets.smtp ?? { ...config.smtp },
  );
  if (!result.accepted) throw new Error(`The relay refused it: ${result.response}`);
  return { detail: `Sent to ${config.marketing.announceTo}; relay answered ${result.response.trim()}.` };
}

/**
 * Send one published post to the configured channels.
 *
 * Per channel: unconfigured is skipped and named; already sent is skipped and
 * named; otherwise one attempt, and the outcome — sent with the network's id,
 * or failed with the network's words — goes on the record either way. A draft
 * is refused: there is no public address to send.
 */
export async function distributePost(
  platform: Platform,
  actor: PostActor,
  postId: string,
  channels?: DistributionChannel[],
): Promise<{ post: BlogPost; sent: Distribution[]; failed: Distribution[]; skipped: Array<{ channel: DistributionChannel; because: string }> }> {
  const post = posts(platform).find((candidate) => candidate.id === postId);
  if (!post) throw new DomainError('POST_NOT_FOUND', `No post ${postId}`, 404);
  if (post.status !== 'PUBLISHED') {
    throw new DomainError('NOT_PUBLISHED', 'Only a live post can be sent anywhere — a draft has no public address.', 409);
  }

  const wanted = new Set<DistributionChannel>(channels && channels.length > 0 ? channels : ['linkedin', 'x', 'email']);
  const already = distributionsFor(platform, post.id).filter((entry) => entry.status === 'SENT');
  const sent: Distribution[] = [];
  const failed: Distribution[] = [];
  const skipped: Array<{ channel: DistributionChannel; because: string }> = [];

  for (const status of distributionChannels()) {
    if (!wanted.has(status.id)) continue;
    if (!status.configured) {
      skipped.push({ channel: status.id, because: `Not configured: ${status.missing.join(', ')} unset.` });
      continue;
    }
    const before = already.find((entry) => entry.channel === status.id);
    if (before) {
      skipped.push({ channel: status.id, because: `Already sent ${before.at}${before.remoteId ? ` as ${before.remoteId}` : ''}.` });
      continue;
    }

    let outcome: Distribution;
    try {
      const answer = status.id === 'linkedin' ? await sendLinkedIn(post) : status.id === 'x' ? await sendX(post) : await sendEmail(post);
      outcome = { id: ulid(), postId: post.id, slug: post.slug, channel: status.id, status: 'SENT', ...answer, at: new Date().toISOString(), by: actor };
    } catch (error) {
      outcome = {
        id: ulid(),
        postId: post.id,
        slug: post.slug,
        channel: status.id,
        status: 'FAILED',
        detail: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
        by: actor,
      };
    }

    platform.ledger.commit({
      tenantId: PLATFORM_TENANT_ID,
      projectId: BLOG_PROJECT_ID,
      actor,
      source: 'SYSTEM',
      correlationId: post.id,
      eventType: 'SITE_POST_DISTRIBUTED',
      entity: { refType: 'SitePostDistribution', refId: outcome.id },
      nextState: outcome as unknown as Record<string, unknown>,
    });
    (outcome.status === 'SENT' ? sent : failed).push(outcome);
  }

  return { post, sent, failed, skipped };
}

// --- The daily release --------------------------------------------------------

export type MarketingRelease = {
  id: string;
  /** UTC date, `YYYY-MM-DD`. The idempotency key. */
  day: string;
  ranAt: string;
  trigger: 'SCHEDULER' | 'OPERATOR';
  by: PostActor;
  /** What went live, or null with the reason in `note`. */
  published: { postId: string; slug: string; title: string; topic: string } | null;
  sent: Distribution[];
  failed: Distribution[];
  skipped: Array<{ channel: DistributionChannel; because: string }>;
  note: string;
};

export function releaseDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function releases(platform: Platform): MarketingRelease[] {
  return platform.ledger
    .list(BLOG_PROJECT_ID, 'MarketingRelease')
    .map((row) => row.state as unknown as MarketingRelease)
    .sort((a, b) => b.day.localeCompare(a.day));
}

export function releaseFor(platform: Platform, day: string): MarketingRelease | undefined {
  return releases(platform).find((release) => release.day === day);
}

/**
 * Today's release: publish the next uncovered topic, send it where a channel
 * is configured, and write down what happened — once.
 *
 * With every topic covered it publishes nothing and says so. It does not
 * re-share an old post to fill the day: a channel that sees the same article
 * every morning is a channel that stops seeing the company.
 */
export async function runDailyRelease(
  platform: Platform,
  actor: PostActor,
  options: { trigger: MarketingRelease['trigger']; now?: Date } ,
): Promise<MarketingRelease & { alreadyRun: boolean }> {
  const day = releaseDay(options.now);
  const existing = releaseFor(platform, day);
  if (existing) return { ...existing, alreadyRun: true };

  const next = TOPICS.find((topic) => postForTopic(platform, topic) === undefined);
  let published: MarketingRelease['published'] = null;
  let note: string;
  let sent: Distribution[] = [];
  let failed: Distribution[] = [];
  let skipped: MarketingRelease['skipped'] = [];

  if (!next) {
    note = 'Every topic in the library is on the record; nothing new was published today, and nothing old was re-sent.';
  } else {
    const composed = composePost(platform, actor, { topic: next.title, keywords: [next.keyword], tag: next.tag }, next);
    if (composed.outcome !== 'PUBLISHED') {
      note = `Composed /blog/${composed.post.slug} for "${next.id}" but it is held by its checks: ${composed.held.join(' ')}`;
    } else {
      published = { postId: composed.post.id, slug: composed.post.slug, title: composed.post.title, topic: next.id };
      const outcome = await distributePost(platform, actor, composed.post.id);
      sent = outcome.sent;
      failed = outcome.failed;
      skipped = outcome.skipped;
      note =
        `Published /blog/${composed.post.slug}. ` +
        (sent.length > 0 ? `Sent to ${sent.map((entry) => entry.channel).join(', ')}. ` : '') +
        (failed.length > 0 ? `Refused by ${failed.map((entry) => entry.channel).join(', ')}. ` : '') +
        (skipped.length > 0 ? `Not sent to ${skipped.map((entry) => entry.channel).join(', ')}: ${skipped.map((entry) => entry.because).join(' ')}` : '');
    }
  }

  const release: MarketingRelease = {
    id: `release-${day}`,
    day,
    ranAt: new Date().toISOString(),
    trigger: options.trigger,
    by: actor,
    published,
    sent,
    failed,
    skipped,
    note: note.trim(),
  };

  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: BLOG_PROJECT_ID,
    actor,
    source: 'SYSTEM',
    correlationId: release.id,
    eventType: 'MARKETING_RELEASE_RUN',
    entity: { refType: 'MarketingRelease', refId: release.id },
    nextState: release as unknown as Record<string, unknown>,
  });

  return { ...release, alreadyRun: false };
}

/** The actor the timer acts as. Named, so a scheduled post is not attributed to whoever last signed in. */
export const SCHEDULER: PostActor = { refType: 'System', refId: 'marketing-scheduler' };

/** Milliseconds between wake-ups. Hourly, like the newsletter's: date-keyed idempotency makes polling safe. */
const TICK_MS = 3_600_000;

/**
 * The daily timer. Off unless `MARKETING_RELEASE_ENABLED`; asks the record
 * before acting, so a restart inside the release hour cannot publish twice.
 */
export function startMarketingSchedule(
  platform: Platform,
  onRelease: (release: MarketingRelease) => void = () => {},
): { stop: () => void } {
  let running = false;

  const tick = async (): Promise<void> => {
    if (running || !config.marketing.releaseEnabled) return;
    const now = new Date();
    if (now.getUTCHours() !== config.marketing.releaseHourUtc) return;
    if (releaseFor(platform, releaseDay(now))) return;

    running = true;
    try {
      onRelease(await runDailyRelease(platform, SCHEDULER, { trigger: 'SCHEDULER', now }));
    } catch (error) {
      process.stderr.write(`[marketing] release failed: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  void tick();
  return { stop: () => clearInterval(timer) };
}

// --- The sweep ----------------------------------------------------------------

export type SweepFinding = {
  check: string;
  ok: boolean;
  /** Out of the hundred the signal score is made of. */
  weight: number;
  detail: string;
};

/** How stale the newest page may be before the site reads as abandoned. */
export const FRESHNESS_DAYS = 14;
/** Contextual links into the site a post should carry to hold a reader. */
export const MIN_INTERNAL_LINKS = 2;

const FRONTEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend');

function headOf(html: string): { title: string; description: string } {
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const description = /<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? '';
  return { title, description };
}

function jsonLdBlocks(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

/** Every published post, compiled and stored, as the sweep reads them. */
function livePosts(platform: Platform): Array<{ slug: string; title: string; date: string; keyword?: string; body: string[]; stored: boolean }> {
  return [
    ...POSTS.map((post) => ({ slug: post.slug, title: post.title, date: post.date, body: post.body, stored: false })),
    ...publishedPosts(platform).map((post) => ({
      slug: post.slug,
      title: post.title,
      date: (post.publishedAt ?? '').slice(0, 10),
      keyword: post.keyword,
      body: post.body.map((line) => esc(line)),
      stored: true,
    })),
  ];
}

/**
 * Eleven checks against the site as it is served.
 *
 * Each is what an outside reader — a crawler, a link preview, a search result
 * — would find, read off the rendered page rather than a setting. The weights
 * say what costs traffic: a stale site and an uncovered topic cost more than a
 * missing hreflang on a single-language site.
 */
export function seoSweep(platform: Platform, now: Date = new Date()): SweepFinding[] {
  const ctx = { locale: 'en-GB' } as unknown as RequestContext;
  const pages: Array<{ path: string; html: string }> = [
    { path: '/', html: renderLanding() },
    ...SITE_PAGES.map((page) => ({ path: page.path, html: render(page.path, platform, ctx) })),
  ];
  const live = livePosts(platform);
  const postPages = live.map((post) => ({ path: `/blog/${post.slug}`, html: render(`/blog/${post.slug}`, platform, ctx) }));

  // 1. Metadata: a title a result shows whole, a description it shows whole.
  const badMeta = pages
    .map((page) => ({ path: page.path, ...headOf(page.html) }))
    .filter((page) => page.title.length === 0 || page.title.length > SEO.titleMax || page.description.length < SEO.descriptionMin || page.description.length > SEO.descriptionMax)
    .map((page) => `${page.path} (title ${page.title.length}, description ${page.description.length})`);

  // 2. Sitemap: everything public, nothing else.
  const map = sitemap(platform);
  const expected = ['/', ...SITE_PAGES.map((page) => page.path), ...POST_PAGES.map((page) => page.path), ...publishedPosts(platform).map((post) => `/blog/${post.slug}`)];
  const missingFromMap = expected.filter((path) => !map.includes(`<loc>${config.publicBaseUrl.replace(/\/$/, '')}${path}</loc>`));
  const drafts = posts(platform).filter((post) => post.status !== 'PUBLISHED');
  const leakedToMap = drafts.filter((post) => map.includes(`/blog/${post.slug}</loc>`)).map((post) => post.slug);

  // 3. Robots: names the sitemap, keeps the crawler out of the application.
  const robotsText = robots();
  const robotsOk = /^Sitemap: https?:\/\/.+\/sitemap\.xml$/m.test(robotsText) && /^Disallow: \/app$/m.test(robotsText) && /^Disallow: \/unsubscribe$/m.test(robotsText);

  // 4. Social cards: an absolute image, a card type, a title and a description on every page.
  const badCards = [...pages, ...postPages]
    .filter(
      (page) =>
        !/<meta property="og:image" content="https?:\/\/[^"]+">/.test(page.html) ||
        !/<meta name="twitter:card" content="[^"]+">/.test(page.html) ||
        !/<meta property="og:title" content="[^"]+">/.test(page.html) ||
        !/<meta property="og:description" content="[^"]+">/.test(page.html),
    )
    .map((page) => page.path);

  // 5. Structured data: parses on every page; a post is a BlogPosting.
  const badJsonLd = [...pages, ...postPages]
    .filter((page) => {
      const blocks = jsonLdBlocks(page.html);
      if (blocks.length === 0) return true;
      try {
        const parsed = blocks.map((block) => JSON.parse(block) as { '@type'?: string });
        return page.path.startsWith('/blog/') && !parsed.some((block) => block['@type'] === 'BlogPosting');
      } catch {
        return true;
      }
    })
    .map((page) => page.path);

  // 6. Hero imagery: the preview image exists, and the landing slots are filled.
  const heroPresent = existsSync(join(FRONTEND_DIR, 'landing-hero.png'));
  const slots = mediaState();
  const emptySlots = slots.filter((slot) => !slot.held).map((slot) => slot.id);

  // 7. Freshness: something published inside the window.
  const newest = live.map((post) => post.date).sort().at(-1) ?? '';
  const ageDays = newest === '' ? Number.POSITIVE_INFINITY : Math.floor((now.getTime() - new Date(`${newest}T00:00:00Z`).getTime()) / 86_400_000);

  // 8. Topic coverage.
  const coverage = topicCoverage(platform);
  const covered = coverage.filter((topic) => topic.covered).length;

  // 9. hreflang on every page.
  const noHreflang = [...pages, ...postPages]
    .filter((page) => !/<link rel="alternate" hreflang="en-GB" href="https?:\/\/[^"]+">/.test(page.html) || !/hreflang="x-default"/.test(page.html))
    .map((page) => page.path);

  // 10. Keyword coverage: every stored post carries its phrase where a result reads it.
  const stored = publishedPosts(platform);
  const offKeyword = stored
    .filter((post) => seoReport(post).some((finding) => (finding.check === 'Keyword in the title' || finding.check === 'Keyword in the opening') && !finding.ok))
    .map((post) => post.slug);

  // 11. Internal linking: at least two links into the site from every post
  // published from the console. The compiled notes are counted and named but
  // not scored — they predate the glossary, as they predate the keyword, and
  // are not rewritten to a standard they were never written to.
  const linkCounts = live.map((post) => ({
    slug: post.slug,
    stored: post.stored,
    links: hyperlink(post.body, { exclude: `/blog/${post.slug}` }).linked.length,
  }));
  const thinLinks = linkCounts.filter((post) => post.stored && post.links < MIN_INTERNAL_LINKS);
  const thinCompiled = linkCounts.filter((post) => !post.stored && post.links < MIN_INTERNAL_LINKS);

  return [
    {
      check: 'Page metadata',
      ok: badMeta.length === 0,
      weight: 12,
      detail:
        badMeta.length === 0
          ? `${pages.length} pages carry a title within ${SEO.titleMax} characters and a description between ${SEO.descriptionMin} and ${SEO.descriptionMax}.`
          : `Outside what a result shows whole: ${badMeta.join('; ')}. Posts are checked by their own gate, not here.`,
    },
    {
      check: 'Sitemap',
      ok: missingFromMap.length === 0 && leakedToMap.length === 0,
      weight: 10,
      detail:
        missingFromMap.length === 0 && leakedToMap.length === 0
          ? `${expected.length} public addresses listed; no draft leaks.`
          : `${missingFromMap.length > 0 ? `Missing: ${missingFromMap.join(', ')}. ` : ''}${leakedToMap.length > 0 ? `Drafts listed: ${leakedToMap.join(', ')}.` : ''}`,
    },
    {
      check: 'Robots',
      ok: robotsOk,
      weight: 6,
      detail: robotsOk ? 'Names the sitemap; keeps crawlers out of /app and off the unsubscribe link.' : 'robots.txt is missing the sitemap line or a disallow the application depends on.',
    },
    {
      check: 'Social cards',
      ok: badCards.length === 0,
      weight: 10,
      detail: badCards.length === 0 ? `Every page and post carries an absolute preview image, a card type, a title and a description.` : `Incomplete cards on ${badCards.join(', ')}.`,
    },
    {
      check: 'Structured data',
      ok: badJsonLd.length === 0,
      weight: 8,
      detail: badJsonLd.length === 0 ? 'Organization data on every page; every post is a BlogPosting that parses.' : `Missing or unparseable on ${badJsonLd.join(', ')}.`,
    },
    {
      check: 'Hero imagery',
      ok: heroPresent && emptySlots.length === 0,
      weight: 6,
      detail: `${heroPresent ? 'The preview image is served.' : 'landing-hero.png, the image every share card points at, is not on disk.'} ${
        emptySlots.length === 0 ? `All ${slots.length} landing slots are filled.` : `${emptySlots.length} of ${slots.length} landing slots empty: ${emptySlots.join(', ')} — fill them on Company Profile.`
      }`,
    },
    {
      check: 'Freshness',
      ok: ageDays <= FRESHNESS_DAYS,
      weight: 12,
      detail:
        newest === ''
          ? 'Nothing is published.'
          : `Newest post ${newest}, ${ageDays} day${ageDays === 1 ? '' : 's'} ago; a site reads as maintained inside ${FRESHNESS_DAYS}.`,
    },
    {
      check: 'Topic coverage',
      ok: covered === TOPICS.length,
      weight: 12,
      detail: `${covered} of ${TOPICS.length} topics have a published post${
        covered === TOPICS.length ? '.' : `; uncovered: ${coverage.filter((topic) => !topic.covered).map((topic) => topic.id).join(', ')}.`
      }`,
    },
    {
      check: 'hreflang',
      ok: noHreflang.length === 0,
      weight: 4,
      detail: noHreflang.length === 0 ? 'en-GB and x-default declared on every page.' : `Missing on ${noHreflang.join(', ')}.`,
    },
    {
      check: 'Keyword coverage',
      ok: stored.length > 0 && offKeyword.length === 0,
      weight: 10,
      detail:
        stored.length === 0
          ? 'No post published from the console yet, so no page is targeting a phrase. The compiled notes carry no keyword by design.'
          : offKeyword.length === 0
            ? `${stored.length} published post${stored.length === 1 ? '' : 's'} carry their phrase in the title and the opening.`
            : `Phrase missing from the title or opening of ${offKeyword.join(', ')}.`,
    },
    {
      check: 'Internal linking',
      ok: stored.length > 0 && thinLinks.length === 0,
      weight: 10,
      detail:
        (stored.length === 0
          ? 'No post published from the console yet.'
          : thinLinks.length === 0
            ? `Every post published from the console links into the site at least ${MIN_INTERNAL_LINKS} times.`
            : `Under ${MIN_INTERNAL_LINKS} links: ${thinLinks.map((post) => `${post.slug} (${post.links})`).join(', ')}. Mention a phrase the glossary knows.`) +
        (thinCompiled.length > 0
          ? ` Compiled notes under ${MIN_INTERNAL_LINKS}, reported not scored: ${thinCompiled.map((post) => `${post.slug} (${post.links})`).join(', ')}.`
          : ''),
    },
  ];
}

export type SignalScore = { score: number; band: 'STRONG' | 'WORKABLE' | 'WEAK'; passing: number; total: number; summary: string };

/** The sweep as one number, with the reason the number is beside the checks and not instead of them. */
export function signalScore(findings: readonly SweepFinding[]): SignalScore {
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
        ? 'Every check passes. The site reads as complete, current and findable.'
        : `${failing.length} check${failing.length === 1 ? '' : 's'} failing, costliest first: ${failing.map((finding) => finding.check).join(', ')}.`,
  };
}

// --- The position -------------------------------------------------------------

export type Recommendation = {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  title: string;
  detail: string;
  /** What the screen offers to do about it. Absent where the fix is outside the console. */
  action?: { label: string; command: 'library' | 'release' | 'generate' | 'distribute' | 'configure'; postId?: string };
};

/** Whether a real reasoning provider is configured, which decides what the generator button does. */
export function generatorMode(): { mode: 'TEMPLATE' | 'AI'; provider: string; note: string } {
  const provider = config.ai.reasoningProvider.toUpperCase();
  const key = provider === 'ANTHROPIC' ? config.ai.anthropicKey : provider === 'GEMINI' ? config.ai.geminiKey : config.ai.openaiKey;
  const live = config.ai.mode !== 'local' && key !== '';
  return live
    ? {
        mode: 'AI',
        provider,
        note:
          `${provider} is configured, so the generator asks the reasoning engine for an original article. It lands as a ` +
          'draft you publish: a model may draft, a person publishes.',
      }
    : {
        mode: 'TEMPLATE',
        provider: 'template',
        note:
          'No reasoning provider is configured, so the generator composes from the feature catalogue — sentences the ' +
          'product already publishes about itself — and may publish on the spot. Set AI_MODE and a provider key for original prose.',
      };
}

export function recommendations(platform: Platform, findings: readonly SweepFinding[]): Recommendation[] {
  const out: Recommendation[] = [];
  const failing = [...findings].filter((finding) => !finding.ok).sort((a, b) => b.weight - a.weight);
  const channels = distributionChannels();
  const configured = channels.filter((channel) => channel.configured);

  for (const finding of failing) {
    const priority: Recommendation['priority'] = finding.weight >= 10 ? 'HIGH' : 'MEDIUM';
    if (finding.check === 'Topic coverage') {
      out.push({ priority, title: 'Cover every topic', detail: finding.detail, action: { label: 'Generate marketing library', command: 'library' } });
    } else if (finding.check === 'Freshness') {
      out.push({ priority, title: 'Publish something this week', detail: finding.detail, action: { label: "Run today's release", command: 'release' } });
    } else if (finding.check === 'Keyword coverage') {
      out.push({ priority, title: 'Target a phrase', detail: finding.detail, action: { label: 'Generate a post', command: 'generate' } });
    } else {
      out.push({ priority, title: `Fix: ${finding.check}`, detail: finding.detail });
    }
  }

  const live = publishedPosts(platform);
  for (const post of live) {
    const sentTo = new Set(distributionsFor(platform, post.id).filter((entry) => entry.status === 'SENT').map((entry) => entry.channel));
    const unsent = configured.filter((channel) => !sentTo.has(channel.id));
    if (unsent.length > 0) {
      out.push({
        priority: 'MEDIUM',
        title: `Send "${post.title}" to ${unsent.map((channel) => channel.label).join(', ')}`,
        detail: 'Published and not yet sent to a channel that is configured. Reach is what a channel gives a page.',
        action: { label: 'Distribute', command: 'distribute', postId: post.id },
      });
    }
  }

  if (configured.length === 0) {
    out.push({
      priority: 'LOW',
      title: 'Configure a distribution channel',
      detail: `Nothing is configured, so a published post reaches only whoever finds the blog. Set ${channels
        .map((channel) => channel.missing.join(' and '))
        .join('; or ')}.`,
      action: { label: 'See the channels', command: 'configure' },
    });
  }

  if (generatorMode().mode === 'TEMPLATE') {
    out.push({
      priority: 'LOW',
      title: 'Configure a reasoning provider for original articles',
      detail: 'The template can only restate the feature catalogue. With a provider key set, the generator drafts original prose that a person publishes.',
    });
  }

  return out.slice(0, 10);
}

export type VisibilityPosition = {
  signal: SignalScore;
  sweep: SweepFinding[];
  reach: {
    requests: number;
    last30: number;
    shares: number;
    clicks: number;
    byChannel: Record<string, number>;
    durable: boolean;
    windowDays: number;
    note: string;
  };
  channels: ChannelStatus[];
  generator: ReturnType<typeof generatorMode>;
  topics: ReturnType<typeof topicCoverage>;
  releases: {
    today: MarketingRelease | null;
    recent: MarketingRelease[];
    schedule: { enabled: boolean; hourUtc: number };
  };
  posts: Array<{
    id: string;
    slug: string;
    title: string;
    status: BlogPost['status'];
    tag: string;
    authorship: BlogPost['authorship'];
    publishedAt?: string;
    draftedAt: string;
    words: number;
    score: number;
    requests: number;
    shares: number;
    clicks: number;
    linked: number;
    kit: ShareKitEntry[];
    distributions: Distribution[];
  }>;
  recommendations: Recommendation[];
  limits: string[];
};

export function visibilityPosition(platform: Platform, now: Date = new Date()): VisibilityPosition {
  const sweep = seoSweep(platform, now);
  const views = viewsPosition();
  const byChannel: Record<string, number> = {};
  for (const entry of views.bySlug) {
    for (const [channel, count] of Object.entries(engagementFor(entry.slug).byChannel)) byChannel[channel] = (byChannel[channel] ?? 0) + count;
  }
  const all = releases(platform);
  const today = releaseDay(now);

  return {
    signal: signalScore(sweep),
    sweep,
    reach: {
      requests: views.total,
      last30: views.bySlug.reduce((sum, entry) => sum + entry.last30, 0),
      shares: views.shares,
      clicks: views.clicks,
      byChannel,
      durable: views.durable,
      windowDays: views.windowDays,
      note: views.note,
    },
    channels: distributionChannels(),
    generator: generatorMode(),
    topics: topicCoverage(platform),
    releases: {
      today: all.find((release) => release.day === today) ?? null,
      recent: all.slice(0, 7),
      schedule: { enabled: config.marketing.releaseEnabled, hourUtc: config.marketing.releaseHourUtc },
    },
    posts: posts(platform).map((post) => {
      const engagement = post.status === 'PUBLISHED' ? engagementFor(post.slug) : { shares: 0, clicks: 0 };
      return {
        id: post.id,
        slug: post.slug,
        title: post.title,
        status: post.status,
        tag: post.tag,
        authorship: post.authorship,
        ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
        draftedAt: post.draftedAt,
        words: wordsOf(post.body),
        score: seoScore(seoReport(post)).score,
        requests: post.status === 'PUBLISHED' ? (views.bySlug.find((entry) => entry.slug === post.slug)?.views ?? 0) : 0,
        shares: engagement.shares,
        clicks: engagement.clicks,
        linked: hyperlink(post.body.map((line) => esc(line)), { exclude: `/blog/${post.slug}` }).linked.length,
        kit: shareKit(post),
        distributions: distributionsFor(platform, post.id),
      };
    }),
    recommendations: recommendations(platform, sweep),
    limits: [
      'No ranking data. The platform does not query a search engine; the score says whether the site is complete and current, not where it ranks.',
      'Requests are not readers: a crawler counts, and one person reading twice counts twice. Shares and clicks are presses the page reported.',
      'A composed post restates the feature catalogue. It claims nothing the product does not already publish about itself, and it invents no figure.',
      'A channel sends only when its credential is set; a refusal is recorded with the network’s own answer, never retried silently.',
    ],
  };
}
