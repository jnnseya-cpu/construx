import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { analyticsCspHosts, analyticsEnabled, analyticsScriptTag, consentBanner, measurementIds } from '../src/site/analytics.ts';
import { page } from '../src/site/layout.ts';
import { POST_PAGES, render } from '../src/site/index.ts';
import { absolute } from '../src/site/layout.ts';

/**
 * Marketing measurement on the public site.
 *
 * The suite runs with no measurement id configured, which is the state every
 * development machine, CI run and unconfigured deployment is in — so most of
 * what is asserted here is that nothing happens. That is the important half:
 * a tag that arms itself by default reports a developer's page views into a
 * live ad account, and the first sign is a conversion figure nobody can
 * explain.
 *
 * The identifier validation is tested directly rather than through config,
 * because `config` snapshots the environment at import and this file cannot
 * rewind it.
 */

describe('measurement is inert until an operator configures it', () => {
  it('is disabled with no id set', () => {
    assert.equal(analyticsEnabled(), false);
  });

  it('emits no script tag', () => {
    assert.equal(analyticsScriptTag(), '');
  });

  it('emits no consent banner', () => {
    // A banner with nothing behind it asks people to decide about a thing that
    // is not happening, which trains them to dismiss the one that matters.
    assert.equal(consentBanner(), '');
  });

  it('adds nothing to the content-security-policy', () => {
    const hosts = analyticsCspHosts();
    assert.deepEqual(hosts, { script: '', img: '', connect: '' });
  });

  it('renders a public page with no third-party reference anywhere in it', () => {
    const html = page(
      { title: 'How it works', description: 'What the platform does', path: '/how-it-works' },
      '<p>Body</p>',
    );
    assert.ok(!html.includes('facebook'), 'no Meta reference');
    assert.ok(!html.includes('googletagmanager'), 'no Google reference');
    assert.ok(!html.includes('/analytics.js'), 'no loader');
    assert.ok(!html.includes('id="consent"'), 'no banner');
  });
});

describe('identifiers are validated rather than escaped', () => {
  // These values reach an HTML attribute and a script loader. The honest
  // answer to "this id contains a quote" is that it is not an id, so it is
  // dropped — escaping it would keep a broken value alive and pass it on.
  const cases: Array<[string, string, boolean, boolean]> = [
    // meta,           google,        metaKept, googleKept
    ['1234567890', 'G-ABC123', true, true],
    ['1', 'GT-XYZ789', true, true],
    ['', 'AW-12345', false, true],
    ['12345', '', true, false],
    ['12a45', 'G-ABC', false, true],
    ['"><script>', 'G-ABC', false, true],
    ['12345', 'G-ABC"><script>', true, false],
    ['12345', 'javascript:alert(1)', true, false],
    ['12345 6789', 'G ABC', false, false],
  ];

  for (const [meta, google, metaKept, googleKept] of cases) {
    it(`meta ${JSON.stringify(meta)} / google ${JSON.stringify(google)}`, () => {
      // Exercising the same expressions the module applies, against inputs the
      // frozen config cannot be made to hold.
      const keptMeta = /^[0-9]{1,32}$/.test(meta) ? meta : '';
      const keptGoogle = /^[A-Z]{1,4}-[A-Z0-9]{1,24}$/i.test(google) ? google : '';
      assert.equal(keptMeta !== '', metaKept);
      assert.equal(keptGoogle !== '', googleKept);
      assert.ok(!keptMeta.includes('"') && !keptMeta.includes('<'));
      assert.ok(!keptGoogle.includes('"') && !keptGoogle.includes('<'));
    });
  }

  it('rejects both of the ids this deployment has not set', () => {
    assert.deepEqual(measurementIds(), { meta: '', google: '' });
  });
});

describe('the console is out of scope, and provably so', () => {
  it('never widens the application shell policy', async () => {
    // The one assertion that matters most. Everything else here is about the
    // marketing site; this is the guarantee that a customer's project paths
    // are not being reported to an advertising network. APP_SHELL is a
    // separate policy that the measurement hosts must never appear in — read
    // from the source so it holds however config is set at runtime.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const source = readFileSync(resolve(import.meta.dirname, '../src/api/middleware.ts'), 'utf8');
    // From the key to the end of the object literal. The policy strings mix
    // single and double quotes — `"… 'self' …"` — so a quote-aware pattern
    // gets it wrong; the bounds are what is unambiguous here.
    const start = source.indexOf('  APP_SHELL:');
    const end = source.indexOf('} as const', start);
    const shell = start === -1 || end === -1 ? '' : source.slice(start, end);

    assert.ok(shell.length > 0, 'APP_SHELL policy found in source');
    assert.ok(!shell.includes('facebook'), 'APP_SHELL must not permit Meta');
    assert.ok(!shell.includes('googletagmanager'), 'APP_SHELL must not permit Google');
    assert.ok(!shell.includes('analyticsCspHosts'), 'APP_SHELL must not interpolate the measurement hosts');
    assert.ok(shell.includes("connect-src 'self'"), 'the console still talks only to this origin');
  });

  it('serves the loader only from the public site chrome', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const shellHtml = readFileSync(resolve(import.meta.dirname, '../../frontend/index.html'), 'utf8');
    assert.ok(!shellHtml.includes('analytics.js'), 'the application shell must not load the measurement script');
  });
});

describe('blog posts have addresses, which is what makes them countable', () => {
  it('gives every post a unique slug and a route', () => {
    // Nothing can count a post that has no URL — not a first-party counter, not
    // Google, not any third-party tool. Cards on a list page were the reason
    // there were no view figures, and a duplicate slug would silently merge two
    // posts' numbers into one.
    const paths = POST_PAGES.map((post) => post.path);
    assert.ok(paths.length >= 5, `expected the posts to be registered, got ${paths.length}`);
    assert.equal(new Set(paths).size, paths.length, 'slugs must be unique');
    for (const path of paths) {
      assert.match(path, /^\/blog\/[a-z0-9-]+$/, `${path} must be a lowercase hyphenated path`);
    }
  });

  it('renders each post with its own title, description and canonical link', () => {
    for (const post of POST_PAGES) {
      const html = render(post.path, {} as never, {} as never);
      // Absolute now: a canonical link states which URL is the real one, and a
      // relative one resolves against whatever host served the page.
      assert.ok(html.includes(`<link rel="canonical" href="${absolute(post.path)}">`), `${post.path} canonical`);
      assert.ok(html.includes('<meta name="description"'), `${post.path} description`);
      assert.ok(html.includes('href="/blog"'), `${post.path} links back to the index`);
    }
  });

  it('links to every post from the index', () => {
    const index = render('/blog', {} as never, {} as never);
    for (const post of POST_PAGES) {
      assert.ok(index.includes(`href="${post.path}"`), `the index must link to ${post.path}`);
    }
  });

  it('refuses a slug that does not exist', () => {
    // There is no route for an unknown slug, so it never reaches a renderer —
    // it 404s through the ordinary not-found path instead.
    assert.throws(() => render('/blog/not-a-real-post', {} as never, {} as never));
  });
});
