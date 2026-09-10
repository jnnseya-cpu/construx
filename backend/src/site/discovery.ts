import { absolute, SITE_PAGES } from './layout.ts';
import { POST_PAGES, POSTS } from './posts.ts';
import { publishedPosts } from './blog.ts';
import type { Platform } from '../platform.ts';

/**
 * `robots.txt` and `sitemap.xml` — how a crawler finds out this site exists.
 *
 * Neither was here. A missing `robots.txt` is answered with a 404, which every
 * crawler treats as "allowed" and every audit tool reports as a fault; a
 * missing sitemap means the only pages that get indexed are the ones something
 * already links to from outside. Both are the first two things any SEO check
 * looks for, and both are two dozen lines.
 *
 * Derived from the same lists that build the navigation and the route table,
 * so a page cannot be published and left out of the sitemap — which is the
 * usual way a sitemap becomes a lie, and a lie a search engine notices.
 *
 * **The application is excluded on purpose.** `/app` is a signed-in tool: every
 * path under it requires a session, so a crawler indexing them would collect a
 * set of URLs that answer nothing useful and would report them as thin or
 * broken. `/unsubscribe` is excluded for a stronger reason — it is reached by a
 * signed token from an email, and a crawler following one would unsubscribe a
 * real person.
 */

/**
 * Public pages the navigation does not offer, and which a sitemap built only
 * from `SITE_PAGES` therefore left invisible.
 *
 * `/verify-document` is the strongest of them. It is the page a stranger
 * holding a document from this platform uses to check it — a client's
 * solicitor, an adjudicator, an insurer — with no account and no relationship
 * to the customer. It is linked from the footer of every page and from every
 * document the platform issues, and it was in no sitemap at all: the one page
 * whose whole audience arrives from outside was the one page a search engine
 * was never told about.
 *
 * Not added to `SITE_PAGES` instead, because that list drives the header and
 * the footer columns, and a verification tool is not a section of the site.
 */
const UNLISTED = ['/verify-document'] as const;

/** Paths a crawler should never spend its budget on, or must never follow. */
const DISALLOW = [
  '/app',
  '/v1/',
  // A signed link from an email. Following it acts on somebody's behalf.
  '/unsubscribe',
];

export function robots(): string {
  return `User-agent: *
${DISALLOW.map((path) => `Disallow: ${path}`).join('\n')}

Sitemap: ${absolute('/sitemap.xml')}
`;
}

/**
 * `llms.txt` — the same courtesy as `robots.txt`, for the reader that answers
 * questions instead of listing links.
 *
 * A growing share of the people who will ever decide whether this platform is
 * worth a conversation never see a results page. They ask an assistant, and the
 * assistant reads a handful of pages and answers from them. What it reads is
 * whatever it can reach and parse — which, on a site that renders every page
 * from a template with a navigation bar, a footer and a cookie line, is mostly
 * furniture.
 *
 * This is the site described once, in plain prose, at a fixed address: what the
 * company does, which page settles which question, and what each post is about.
 * It is a convention rather than a standard and no engine is obliged to read
 * it — which is exactly the argument for it being twenty lines derived from the
 * lists that already exist rather than a project.
 *
 * **Nothing here is a claim the site does not already make.** Every line is a
 * page title, a page's own description or a post's standfirst, so the file
 * cannot drift away from what a reader would find on arriving, and cannot
 * become a place where a claim is made that no page is prepared to support.
 */
export function llms(platform?: Platform): string {
  const published = platform?.ledger ? publishedPosts(platform) : [];

  const pages = SITE_PAGES.map((page) => `- [${page.label}](${absolute(page.path)})`);
  const notes = POSTS.map((post) => `- [${post.title}](${absolute(`/blog/${post.slug}`)}): ${post.standfirst}`);
  const articles = published.map((post) => `- [${post.title}](${absolute(`/blog/${post.slug}`)}): ${post.standfirst}`);

  return `# CONSTRUX

> A construction operating system built on an append-only, hash-chained record.
> Every change to a project is an event on that record, written before it is
> acknowledged, so what was known and when has an answer rather than an opinion.
> AI engines read, check and draft against it; a decision event refuses an AI
> author outright, and no agent mandate goes above propose.

## Site

${pages.join('\n')}
- [Verify a document](${absolute('/verify-document')})

## Articles

${articles.length > 0 ? articles.join('\n') : '- None published yet.'}

## Engineering notes

${notes.join('\n')}

## Not for crawling

${DISALLOW.map((path) => `- ${absolute(path)} — ${path === '/unsubscribe' ? 'acting on it unsubscribes a real person' : 'requires a session and answers nothing useful without one'}`).join('\n')}
`;
}

/**
 * Every public page, with the posts carrying their publication date.
 *
 * `lastmod` is only claimed where it is known. A sitemap that stamps today's
 * date on every page teaches a crawler that the date means nothing, and it
 * stops re-reading the pages that genuinely changed.
 */
export function sitemap(platform?: Platform): string {
  // Posts published through the console, alongside those written into the
  // build. Taking the platform is what stops this becoming the lie the comment
  // above warns about: a post can now be published without a deploy, and a
  // sitemap that only knew about the compiled ones would leave every one of them
  // findable by nothing.
  //
  // Optional, so a caller with no platform to hand still gets the static site
  // rather than an error — but the gateway passes one, so the served sitemap is
  // always the complete one.
  const published = platform?.ledger ? publishedPosts(platform) : [];

  const dates = new Map<string, string>([
    ...POSTS.map((post) => [`/blog/${post.slug}`, post.date] as const),
    ...published.map((post) => [`/blog/${post.slug}`, (post.publishedAt ?? '').slice(0, 10)] as const),
  ]);

  const entries = [
    // The landing page is the site's root and is not in SITE_PAGES, which lists
    // the pages the navigation offers.
    { path: '/', priority: '1.0' },
    ...UNLISTED.map((path) => ({ path, priority: '0.7' })),
    ...SITE_PAGES.map((page) => ({ path: page.path, priority: '0.7' })),
    ...POST_PAGES.map((post) => ({ path: post.path, priority: '0.6' })),
    ...published.map((post) => ({ path: `/blog/${post.slug}`, priority: '0.6' })),
  ];

  const urls = entries
    .map((entry) => {
      const lastmod = dates.get(entry.path);
      return `  <url>
    <loc>${absolute(entry.path)}</loc>${lastmod ? `\n    <lastmod>${lastmod}</lastmod>` : ''}
    <priority>${entry.priority}</priority>
  </url>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}
