import { ulid } from '../core/ids.ts';
import { DomainError } from '../core/errors.ts';
import { runAI, type EngineContext } from '../engines/context.ts';
import { MARKETING_PROJECT_ID } from '../messaging/audience.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';
import { POSTS } from './posts.ts';

/**
 * The blog, as records rather than as source code.
 *
 * Six posts existed as a hard-coded array. Publishing a seventh meant editing
 * TypeScript, rebuilding the image and redeploying — so in practice nobody
 * published a seventh, and the marketing site had a blog that had not moved in
 * months. A blog nobody can add to is a blog that stops being read.
 *
 * This puts a post in the ledger, where every other governed thing lives, and
 * lets the reasoning engine draft one. Four properties make that safe rather
 * than a spam generator pointed at the company's own domain.
 *
 * **A model drafts; a person publishes.** `draftPost` writes a DRAFT and
 * nothing else. `publishPost` is a separate command a named human runs, and it
 * is the only thing that puts a URL on the public internet. No agent mandate
 * reaches it — this sits outside the ladder entirely, because the ladder is
 * about acting on a project's own record and this acts on the company's public
 * face.
 *
 * **The stand-in never gets published.** With no provider configured the local
 * adapter answers every request with the same sentence and reasons about
 * nothing. Dressing that as an article and putting it on the website under the
 * company's name would be the exact failure `documents/generate.ts` refuses:
 * prose attributed to reasoning that never happened. So a synthetic draft is
 * refused at the point of drafting, with the reason.
 *
 * **SEO is a gate, not a score.** A post whose title will be truncated in a
 * result, whose description is missing, or which is too thin to rank, is
 * refused publication with each failure named. A blog that publishes anyway and
 * shows a red number nobody acts on is how a site accumulates pages that make
 * it rank worse.
 *
 * **The hard-coded posts stay.** They are the engineering notes this project
 * actually produced and they are not migrated, rewritten or replaced. Published
 * records are added to them. `POSTS` remains the source of truth for those six;
 * this is the source of truth for everything after.
 */

/** Where a post lives. The platform's own tenancy, not a customer's. */
export const BLOG_PROJECT_ID = MARKETING_PROJECT_ID;

export type PostStatus = 'DRAFT' | 'PUBLISHED' | 'WITHDRAWN';

export type BlogPost = {
  id: string;
  slug: string;
  title: string;
  standfirst: string;
  /** Paragraphs, in order. */
  body: string[];
  tag: string;
  /** The `<meta name="description">`. Distinct from the standfirst on purpose. */
  metaDescription: string;
  /** The phrase this post is meant to be found by. */
  keyword: string;
  status: PostStatus;
  /**
   * Who actually wrote the prose.
   *
   * `AI_DRAFTED` is never removed by editing. A person who rewrites every
   * sentence of a model's draft has still started from one, and the record says
   * so — the alternative is a field that means "nobody has admitted it yet".
   */
  authorship: 'HUMAN' | 'AI_DRAFTED';
  /** Present only for an AI draft. Which provider and model class produced it. */
  provider?: string;
  modelClass?: string;
  draftedAt: string;
  draftedBy: string;
  publishedAt?: string;
  publishedBy?: string;
  withdrawnAt?: string;
  withdrawnReason?: string;
};

/**
 * What a search result can show, and what a page needs to be worth indexing.
 *
 * These are not invented. A title beyond roughly sixty characters is truncated
 * in a result; a description beyond about a hundred and sixty is cut; a page
 * under three hundred words is treated as thin. The numbers are here rather
 * than scattered through the checks so that changing one is a single edit.
 */
export const SEO = {
  titleMin: 25,
  titleMax: 60,
  descriptionMin: 70,
  descriptionMax: 160,
  slugMax: 75,
  bodyMinWords: 300,
} as const;

export type SeoFinding = { check: string; ok: boolean; detail: string };

/** Words in the body, counted the way a crawler would. */
function wordCount(body: string[]): number {
  return body
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .split(/\s+/)
    .filter(Boolean).length;
}

/**
 * A slug, from a title.
 *
 * Derived once at draft time and then held, never recomputed. A slug is a
 * promise: it is what gets linked, shared and indexed, and retitling a post
 * must not break every link to it — the same rule `posts.ts` states for the
 * six that are hard-coded.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SEO.slugMax)
    .replace(/-+$/g, '');
}

/**
 * Every SEO check, with its verdict and why.
 *
 * Returned whole rather than as a pass/fail, because "this cannot be published"
 * is useless without "the description is 41 characters and needs at least 70".
 */
export function seoReport(
  post: Pick<BlogPost, 'title' | 'metaDescription' | 'slug' | 'body' | 'keyword' | 'standfirst'>,
): SeoFinding[] {
  const words = wordCount(post.body);
  const firstParagraph = (post.body[0] ?? '').toLowerCase();
  const keyword = post.keyword.trim().toLowerCase();

  return [
    {
      check: 'Title length',
      ok: post.title.length >= SEO.titleMin && post.title.length <= SEO.titleMax,
      detail: `${post.title.length} characters. A result truncates beyond ${SEO.titleMax}, and under ${SEO.titleMin} says too little to click.`,
    },
    {
      check: 'Meta description',
      ok: post.metaDescription.length >= SEO.descriptionMin && post.metaDescription.length <= SEO.descriptionMax,
      detail: `${post.metaDescription.length} characters. Between ${SEO.descriptionMin} and ${SEO.descriptionMax} is what a result will show whole.`,
    },
    {
      check: 'Slug',
      ok: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug) && post.slug.length <= SEO.slugMax,
      detail: `"${post.slug}" — lowercase words joined by hyphens, at most ${SEO.slugMax} characters.`,
    },
    {
      check: 'Depth',
      ok: words >= SEO.bodyMinWords,
      detail: `${words} words. Under ${SEO.bodyMinWords} is treated as thin, and thin pages lower the standing of the ones around them.`,
    },
    {
      check: 'Keyword in the title',
      ok: keyword.length > 0 && post.title.toLowerCase().includes(keyword),
      detail: keyword.length === 0 ? 'No keyword is set, so nothing can be checked against one.' : `"${post.keyword}" must appear in the title.`,
    },
    {
      check: 'Keyword in the opening',
      ok: keyword.length > 0 && firstParagraph.includes(keyword),
      detail: 'The first paragraph is what a result quotes when the description does not match the query.',
    },
    {
      check: 'Standfirst',
      ok: post.standfirst.trim().length >= 40,
      detail: 'The line under the headline, which is what the blog index shows. A card with nothing under its title is not clicked.',
    },
  ];
}

/** Every post in the ledger, newest first. Drafts included. */
export function posts(platform: Platform): BlogPost[] {
  return platform.ledger
    .list(BLOG_PROJECT_ID, 'SitePost')
    .map((row) => row as unknown as BlogPost)
    .sort((a, b) => (b.draftedAt ?? '').localeCompare(a.draftedAt ?? ''));
}

/** Just the published ones — what the public site and the sitemap may show. */
export function publishedPosts(platform: Platform): BlogPost[] {
  return posts(platform)
    .filter((post) => post.status === 'PUBLISHED')
    .sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
}

/** One published post by slug, or undefined. Never returns a draft. */
export function publishedPost(platform: Platform, slug: string): BlogPost | undefined {
  return publishedPosts(platform).find((post) => post.slug === slug);
}

/**
 * Is this slug already spoken for?
 *
 * Checked against the hard-coded six as well as the ledger. Two pages at one
 * address is the worst outcome available here: the router would answer with
 * whichever it found first, and a link that used to reach one would silently
 * start reaching the other.
 */
function slugTaken(platform: Platform, slug: string, exceptId?: string): boolean {
  if (POSTS.some((post) => post.slug === slug)) return true;
  return posts(platform).some((post) => post.slug === slug && post.id !== exceptId);
}

function requirePost(platform: Platform, postId: string): BlogPost {
  const found = posts(platform).find((post) => post.id === postId);
  if (!found) throw new DomainError('POST_NOT_FOUND', `No post ${postId}`, 404);
  return found;
}

/**
 * One commit shape for all four events.
 *
 * The event code is passed in a property called `eventType` rather than as a
 * bare positional argument, and that is not cosmetic: `catalogue.test.ts` scans
 * the source for `eventType:` followed by a literal, and an event whose name
 * only ever appears as an anonymous parameter is invisible to it — which is how
 * a dead event hides in a codebase that has a test specifically to stop that.
 */
function commit(
  platform: Platform,
  actorId: string,
  { eventType, post }: { eventType: string; post: BlogPost },
): void {
  platform.ledger.commit({
    tenantId: PLATFORM_TENANT_ID,
    projectId: BLOG_PROJECT_ID,
    actor: { refType: 'User', refId: actorId },
    source: 'SYSTEM',
    correlationId: post.id,
    eventType,
    entity: { refType: 'SitePost', refId: post.id },
    nextState: post as unknown as Record<string, unknown>,
  });
}

/**
 * Ask the reasoning engine for a draft.
 *
 * The brief is deliberately narrow. The model is told what the company does,
 * given the angle and the phrase the post should be found by, and asked for a
 * structured article — not for facts about the platform, which it does not have
 * and would invent. Everything it returns lands in a DRAFT that a person reads
 * before anybody else can.
 */
export async function draftPost(
  ctx: EngineContext,
  platform: Platform,
  input: { keyword: string; angle: string; tag?: string },
): Promise<{ post: BlogPost; seo: SeoFinding[]; acuConsumed: number }> {
  const keyword = input.keyword.trim();
  const angle = input.angle.trim();
  if (keyword.length < 3) throw new DomainError('KEYWORD_REQUIRED', 'A post needs a phrase it is meant to be found by.', 422);
  if (angle.length < 20) {
    throw new DomainError(
      'ANGLE_REQUIRED',
      'Say what the post should argue, in a sentence. "Write about delays" produces an article about nothing.',
      422,
    );
  }

  const result = await runAI(ctx, {
    engine: 'EXECUTIVE',
    taskType: 'site_blog_draft',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Project', refId: BLOG_PROJECT_ID }],
    request: {
      task:
        'Write an article for the blog of a construction operating system company. Return JSON with: title, ' +
        'standfirst, metaDescription, and body as an array of paragraph strings.',
      payload: {
        keyword,
        angle,
        audience: 'Construction directors, commercial managers and project directors at contractors and clients.',
        constraint:
          'Write about the industry problem and how it is reasoned about. Do not state any statistic, customer name, ' +
          'case study, price or product claim — you have not been given any and inventing one would be a false ' +
          'statement published under a company name. Where a number would help, describe the mechanism instead. ' +
          `The phrase "${keyword}" must appear in the title and in the first paragraph. ` +
          `The title must be between ${SEO.titleMin} and ${SEO.titleMax} characters and the metaDescription between ` +
          `${SEO.descriptionMin} and ${SEO.descriptionMax}. The body must be at least ${SEO.bodyMinWords} words ` +
          'across several paragraphs.',
      },
    },
    // The draft is state and is written below under its own event. Returning
    // writes here would commit it twice.
    toWrites: () => [],
  });

  // The stand-in reasons about nothing and says so. Publishing its output as an
  // article under the company's name would be a false attribution on the public
  // internet, which is worse than having no post — so it is refused here rather
  // than filtered later.
  if (result.synthetic) {
    throw new DomainError(
      'NO_REASONING_PROVIDER',
      'This deployment is running the local stand-in, which reasons about nothing. It cannot write an article, and ' +
        'publishing what it returns under the company name would be prose attributed to reasoning that never ' +
        'happened. Configure a reasoning provider and set AI_MODE=live.',
      503,
    );
  }

  const output = result.output as {
    title?: unknown;
    standfirst?: unknown;
    metaDescription?: unknown;
    body?: unknown;
  };

  const title = String(output.title ?? '').trim();
  const body = Array.isArray(output.body) ? output.body.map((line) => String(line).trim()).filter(Boolean) : [];
  if (title.length === 0 || body.length === 0) {
    throw new DomainError('AI_DRAFT_UNUSABLE', 'The model returned no title or no body.', 502);
  }

  let slug = slugify(title);
  if (slug.length === 0) throw new DomainError('AI_DRAFT_UNUSABLE', 'The title produced no usable address.', 502);
  // A collision is resolved rather than refused: the draft is worth keeping and
  // the slug is editable before publication.
  if (slugTaken(platform, slug)) slug = `${slug}-${ulid().slice(-6).toLowerCase()}`;

  const post: BlogPost = {
    id: ulid(),
    slug,
    title,
    standfirst: String(output.standfirst ?? '').trim(),
    metaDescription: String(output.metaDescription ?? '').trim(),
    body,
    tag: input.tag?.trim() || 'Industry',
    keyword,
    status: 'DRAFT',
    authorship: 'AI_DRAFTED',
    provider: result.provider,
    modelClass: result.modelClass,
    draftedAt: new Date().toISOString(),
    draftedBy: ctx.auth.actorId,
  };

  commit(platform, ctx.auth.actorId, { eventType: 'SITE_POST_DRAFTED', post });
  return { post, seo: seoReport(post), acuConsumed: result.acuConsumed };
}

/** Write a post by hand, with no model involved. */
export function writePost(
  ctx: EngineContext,
  platform: Platform,
  input: { title: string; standfirst: string; metaDescription: string; body: string[]; keyword: string; tag?: string },
): { post: BlogPost; seo: SeoFinding[] } {
  const title = input.title.trim();
  if (title.length === 0) throw new DomainError('TITLE_REQUIRED', 'A post needs a title.', 422);

  let slug = slugify(title);
  if (slug.length === 0) throw new DomainError('TITLE_REQUIRED', 'That title produces no usable address.', 422);
  if (slugTaken(platform, slug)) slug = `${slug}-${ulid().slice(-6).toLowerCase()}`;

  const post: BlogPost = {
    id: ulid(),
    slug,
    title,
    standfirst: input.standfirst.trim(),
    metaDescription: input.metaDescription.trim(),
    body: input.body.map((line) => line.trim()).filter(Boolean),
    tag: input.tag?.trim() || 'Industry',
    keyword: input.keyword.trim(),
    status: 'DRAFT',
    authorship: 'HUMAN',
    draftedAt: new Date().toISOString(),
    draftedBy: ctx.auth.actorId,
  };

  commit(platform, ctx.auth.actorId, { eventType: 'SITE_POST_DRAFTED', post });
  return { post, seo: seoReport(post) };
}

/** Edit a draft. A published post is withdrawn before it can be changed. */
export function revisePost(
  ctx: EngineContext,
  platform: Platform,
  postId: string,
  patch: Partial<Pick<BlogPost, 'title' | 'standfirst' | 'metaDescription' | 'body' | 'tag' | 'keyword' | 'slug'>>,
): { post: BlogPost; seo: SeoFinding[] } {
  const existing = requirePost(platform, postId);
  if (existing.status === 'PUBLISHED') {
    throw new DomainError(
      'POST_IS_PUBLISHED',
      'This post is live. Withdraw it first — editing a page underneath the people reading it, and underneath the ' +
        'index that already has it, is how a link comes to point at something it did not promise.',
      409,
    );
  }

  const slug = patch.slug ? slugify(patch.slug) : existing.slug;
  if (slug !== existing.slug && slugTaken(platform, slug, existing.id)) {
    throw new DomainError('SLUG_TAKEN', `Another post already lives at /blog/${slug}.`, 409);
  }

  const post: BlogPost = {
    ...existing,
    ...patch,
    slug,
    body: patch.body ? patch.body.map((line) => line.trim()).filter(Boolean) : existing.body,
  };

  commit(platform, ctx.auth.actorId, { eventType: 'SITE_POST_REVISED', post });
  return { post, seo: seoReport(post) };
}

/**
 * Publish. A person, never a model, and never past a failing check.
 *
 * The refusal names every failed check rather than the first, because fixing
 * them one publish attempt at a time is how somebody gives up and lowers the
 * standard instead.
 */
export function publishPost(ctx: EngineContext, platform: Platform, postId: string): { post: BlogPost; seo: SeoFinding[] } {
  const existing = requirePost(platform, postId);
  if (existing.status === 'PUBLISHED') throw new DomainError('ALREADY_PUBLISHED', 'This post is already live.', 409);

  const seo = seoReport(existing);
  const failed = seo.filter((finding) => !finding.ok);
  if (failed.length > 0) {
    throw new DomainError(
      'SEO_CHECKS_FAILED',
      `This post cannot be published yet — ${failed.length} check${failed.length === 1 ? '' : 's'} failed. ` +
        failed.map((finding) => `${finding.check}: ${finding.detail}`).join(' '),
      422,
    );
  }

  if (slugTaken(platform, existing.slug, existing.id)) {
    throw new DomainError('SLUG_TAKEN', `Another post already lives at /blog/${existing.slug}.`, 409);
  }

  const post: BlogPost = {
    ...existing,
    status: 'PUBLISHED',
    publishedAt: new Date().toISOString(),
    publishedBy: ctx.auth.actorId,
  };

  commit(platform, ctx.auth.actorId, { eventType: 'SITE_POST_PUBLISHED', post });
  return { post, seo };
}

/**
 * Take a post down.
 *
 * The record stays and the URL stops answering. A published post that was wrong
 * is a thing that happened, and deleting the evidence of it is the one option
 * this platform does not offer anywhere else either.
 */
export function withdrawPost(
  ctx: EngineContext,
  platform: Platform,
  postId: string,
  reason: string,
): BlogPost {
  const existing = requirePost(platform, postId);
  if (existing.status !== 'PUBLISHED') throw new DomainError('NOT_PUBLISHED', 'Only a live post can be withdrawn.', 409);
  if (reason.trim().length < 10) {
    throw new DomainError('REASON_REQUIRED', 'Say why it is coming down. A page that vanished for no recorded reason invites the question later.', 422);
  }

  const post: BlogPost = {
    ...existing,
    status: 'WITHDRAWN',
    withdrawnAt: new Date().toISOString(),
    withdrawnReason: reason.trim(),
  };

  commit(platform, ctx.auth.actorId, { eventType: 'SITE_POST_WITHDRAWN', post });
  return post;
}

/** The operator's view: every post, its state, and what is stopping it. */
export function blogPosition(platform: Platform): {
  posts: Array<BlogPost & { seo: SeoFinding[]; publishable: boolean }>;
  published: number;
  drafts: number;
  fixed: number;
  summary: string;
} {
  const all = posts(platform).map((post) => {
    const seo = seoReport(post);
    return { ...post, seo, publishable: seo.every((finding) => finding.ok) };
  });

  const published = all.filter((post) => post.status === 'PUBLISHED').length;
  const drafts = all.filter((post) => post.status === 'DRAFT').length;
  const blocked = all.filter((post) => post.status === 'DRAFT' && !post.publishable).length;

  return {
    posts: all,
    published,
    drafts,
    // The six that ship in the source. Named so the totals here are not mistaken
    // for the whole blog.
    fixed: POSTS.length,
    summary:
      `${published + POSTS.length} live (${POSTS.length} written into the build), ${drafts} in draft` +
      (blocked > 0 ? `, ${blocked} of which cannot be published until their checks pass.` : '.'),
  };
}
