import { absolute, SITE_PAGES } from './layout.ts';
import { POST_PAGES, POSTS } from './posts.ts';

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
 * Every public page, with the posts carrying their publication date.
 *
 * `lastmod` is only claimed where it is known. A sitemap that stamps today's
 * date on every page teaches a crawler that the date means nothing, and it
 * stops re-reading the pages that genuinely changed.
 */
export function sitemap(): string {
  const dates = new Map(POSTS.map((post) => [`/blog/${post.slug}`, post.date]));

  const entries = [
    // The landing page is the site's root and is not in SITE_PAGES, which lists
    // the pages the navigation offers.
    { path: '/', priority: '1.0' },
    ...SITE_PAGES.map((page) => ({ path: page.path, priority: '0.7' })),
    ...POST_PAGES.map((post) => ({ path: post.path, priority: '0.6' })),
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
