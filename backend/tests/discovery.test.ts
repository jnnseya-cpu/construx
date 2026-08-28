import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { robots, sitemap } from '../src/site/discovery.ts';
import { POST_PAGES, render, SITE_PAGES } from '../src/site/index.ts';
import { Platform } from '../src/platform.ts';

/**
 * What a search engine and a link preview actually read.
 *
 * None of this existed, and none of it is visible from inside the product — a
 * missing `robots.txt` answers 404, a missing sitemap means the only pages
 * indexed are the ones something already links to, and a `twitter:card` of
 * `summary_large_image` with no image tag renders every share of every page as
 * a blank grey rectangle. Each is invisible until somebody runs an audit or
 * shares a link, which is the argument for asserting them here.
 */

describe('crawlers can discover the site', () => {
  it('serves a robots file that names the sitemap', () => {
    const body = robots();
    assert.match(body, /^User-agent: \*$/m);
    assert.match(body, /^Sitemap: https?:\/\/.+\/sitemap\.xml$/m, 'absolute, because a crawler has no base to resolve against');
  });

  it('keeps crawlers out of the application and the API', () => {
    // Every path under /app needs a session, so a crawler would collect URLs
    // that answer nothing and report them as thin or broken.
    const body = robots();
    assert.match(body, /^Disallow: \/app$/m);
    assert.match(body, /^Disallow: \/v1\/$/m);
  });

  it('keeps crawlers off the unsubscribe link', () => {
    // The strongest of the three. It is reached by a signed token in an email,
    // and a crawler following one would unsubscribe a real person.
    assert.match(robots(), /^Disallow: \/unsubscribe$/m);
  });
});

describe('the sitemap lists what exists and nothing else', () => {
  const xml = sitemap();
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? '');

  it('is well-formed and namespaced', () => {
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  });

  it('gives every url in absolute form', () => {
    assert.ok(locations.length > 0, 'the sitemap is not empty');
    for (const location of locations) {
      assert.match(location, /^https?:\/\//, `${location} must be absolute`);
    }
  });

  it('includes the landing page, every navigation page and every post', () => {
    // Derived from the same lists the navigation and the route table read, so
    // a page cannot be published and left out — which is how a sitemap becomes
    // a lie a search engine notices.
    for (const page of [...SITE_PAGES.map((p) => p.path), ...POST_PAGES.map((p) => p.path), '/']) {
      assert.ok(
        locations.some((location) => location.endsWith(page)),
        `${page} must be in the sitemap`,
      );
    }
  });

  it('excludes the signed-in application', () => {
    assert.ok(!locations.some((location) => location.includes('/app')), 'no console paths');
  });

  it('claims a last-modified date only where one is known', () => {
    // A sitemap that stamps today on every page teaches a crawler the date is
    // meaningless, and it stops re-reading the pages that genuinely changed.
    const stamped = (xml.match(/<lastmod>/g) ?? []).length;
    assert.equal(stamped, POST_PAGES.length, 'exactly the posts, which carry a publication date');
  });
});

/**
 * A real platform, for the pages that read live state.
 *
 * It was a two-property stub, which worked while `/status` was the only page
 * reading anything: it reports the running process rather than fixed copy,
 * which is the point of it. `/demo` reads the seeded identities and the free
 * booking slots, and the stub answered neither — so the page threw and the
 * assertion that every page carries its head tags could not reach it.
 *
 * An unseeded `Platform` is the right fixture rather than a shortcoming: it
 * renders the demonstration page's unavailable branch, which has to carry the
 * same canonical, preview image and card title as every other page and is
 * exactly the state nothing else covers.
 */
const PLATFORM = new Platform() as never;

describe('a shared link renders as something', () => {
  it('gives every page an absolute canonical, preview image and card title', () => {
    for (const path of SITE_PAGES.map((p) => p.path)) {
      const html = render(path, PLATFORM, {} as never);
      assert.match(html, /<link rel="canonical" href="https?:\/\/[^"]+">/, `${path} canonical must be absolute`);
      assert.match(html, /<meta property="og:image" content="https?:\/\/[^"]+">/, `${path} og:image`);
      // The card type was already promising a large image with no image to
      // show, which reserves the space and leaves it empty.
      assert.match(html, /<meta name="twitter:image" content="https?:\/\/[^"]+">/, `${path} twitter:image`);
      assert.match(html, /<meta property="og:url" content="https?:\/\/[^"]+">/, `${path} og:url`);
    }
  });

  it('marks a post as an article, with its date and structured data', () => {
    for (const post of POST_PAGES) {
      const html = render(post.path, PLATFORM, {} as never);
      assert.match(html, /<meta property="og:type" content="article">/, `${post.path} og:type`);
      assert.match(html, /<meta property="article:published_time" content="\d{4}-\d{2}-\d{2}">/, `${post.path} date`);

      const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
      assert.ok(block, `${post.path} carries structured data`);
      const data = JSON.parse(block) as Record<string, unknown>;
      assert.equal(data['@type'], 'BlogPosting');
      assert.equal(data['@context'], 'https://schema.org');
      assert.ok(typeof data.datePublished === 'string' && data.datePublished.length === 10);
      assert.ok(String(data.url).startsWith('http'), 'url must be absolute');
      assert.ok(data.publisher, 'a publisher, or it is not an article anybody can attribute');
    }
  });

  it('cannot let structured data break out of its own script element', () => {
    // The one escape that matters: a `</script>` inside a JSON string would end
    // the block early and put the rest of the document in the parser's hands.
    for (const post of POST_PAGES) {
      const html = render(post.path, PLATFORM, {} as never);
      const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
      assert.ok(!block.includes('</script'), 'no raw closing tag inside the JSON');
    }
  });

  it('does not mark an ordinary page as an article', () => {
    const html = render('/about', PLATFORM, {} as never);
    assert.match(html, /<meta property="og:type" content="website">/);
    assert.ok(!html.includes('article:published_time'), 'a page with no publication date must not claim one');
  });
});
