import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import { articleCta, byline, engineName, headingsOf, hyperlink, LINK_GLOSSARY, readMinutes, setBody, shareBar, shareTargets } from '../src/site/article.ts';
import * as blog from '../src/site/blog.ts';
import { ROUTES } from '../src/api/routes.ts';
import { POSTS } from '../src/site/posts.ts';
import { engagementFor, resetViews, viewsPosition } from '../src/site/views.ts';

/**
 * How a post is set on the page: the byline with its reading time, the share
 * bar at the top and the foot, the contextual links into the rest of the site,
 * the sections a body may carry, and the closing call to action — and the
 * press on any of those counted as a request, labelled that way, for a page
 * that exists and for no other.
 */

let platform: Platform;
let server: Server;
let base: string;
let slug = '';

const sentence = (lead: string) =>
  `${lead} A payment notice names the sum the payer considers due and the basis on which it was calculated, and the ` +
  'Construction Act fixes the day it is owed. A contractor working from the calendar rather than the contract loses the ' +
  'point the whole cycle turns on, and an adjudicator will say so in the first paragraph of the decision.';

before(async () => {
  resetViews();
  platform = new Platform();
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  const ctx = platform.context(authOf(platform, operator.id), blog.BLOG_PROJECT_ID, { source: 'WEB' });
  const { post } = blog.writePost(ctx, platform, {
    title: 'Why the payment notice matters now on site',
    standfirst: 'The one document that decides what is owed, and the day the platform starts counting.',
    metaDescription: 'What a payment notice is, why the Construction Act makes it decisive, and how the Golden Thread records it.',
    keyword: 'payment notice',
    body: [
      sentence('The payment notice is the instrument the whole payment cycle turns on.'),
      '## Why the payment notice matters now',
      sentence('Late payment is the oldest problem in the industry and the Golden Thread is the record of when it happened.'),
      '## How CONSTRUX delivers it',
      sentence('Every certificate carries a due date and a final date, computed rather than typed.'),
      '> A notice nobody can find is a notice nobody gave.',
      '## Your move',
      sentence('Open the demo environment and run a payment cycle through to its final date.'),
    ],
    tag: 'Commercial',
  });
  blog.publishPost(ctx, platform, post.id);
  slug = post.slug;

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the byline', () => {
  it('reads category, engine, minutes and date, and never under a minute', () => {
    const line = byline({ tag: 'Commercial', authorship: 'AI_DRAFTED', body: ['Short.'], date: '2026-06-28', longDate: '28 June 2026' });
    assert.match(line, /Commercial/);
    assert.match(line, /CONSTRUX AI Content Engine/);
    assert.match(line, /1 min read/);
    assert.match(line, /datetime="2026-06-28"/);
    assert.equal(readMinutes(['Short.']), 1);
    assert.equal(readMinutes(Array.from({ length: 50 }, () => sentence('Again.'))), Math.ceil((50 * sentence('Again.').split(/\s+/).length) / 220));
  });

  it('names who set the words down from the record, not from the sentence', () => {
    assert.equal(engineName('HUMAN'), 'CONSTRUX Editorial');
    assert.equal(engineName('AI_DRAFTED'), 'CONSTRUX AI Content Engine');
    assert.equal(engineName('MARKETING_AGENT'), 'CONSTRUX Marketing Agent');
    assert.equal(engineName(undefined), 'CONSTRUX Engineering');
  });
});

describe('the share bar', () => {
  it('links to each network’s own composer with the post’s absolute address, and copies by button', () => {
    const targets = shareTargets({ url: 'https://example.test/blog/a-post', title: 'A post & more' });
    assert.match(targets.linkedin, /^https:\/\/www\.linkedin\.com\/sharing\/share-offsite\/\?url=https%3A%2F%2Fexample\.test%2Fblog%2Fa-post$/);
    assert.match(targets.x, /^https:\/\/x\.com\/intent\/post\?text=A%20post%20%26%20more&url=/);
    assert.match(targets.whatsapp, /^https:\/\/wa\.me\/\?text=/);
    assert.match(targets.email, /^mailto:\?subject=A%20post%20%26%20more&body=/);

    const bar = shareBar({ slug: 'a-post', url: 'https://example.test/blog/a-post', title: 'A post', position: 'top' });
    assert.match(bar, /class="share-bar share-top"/);
    assert.match(bar, /<button[^>]*data-share="copy"[^>]*data-url="https:\/\/example\.test\/blog\/a-post"/);
    for (const channel of ['linkedin', 'x', 'whatsapp', 'email']) {
      assert.match(bar, new RegExp(`<a[^>]*rel="noopener noreferrer"[^>]*data-share="${channel}"`), channel);
    }
    assert.ok(!bar.includes('<script'), 'no script from any network');
  });
});

describe('contextual links', () => {
  it('links a glossary phrase once, on first appearance, never inside code or an existing link, never to the page itself', () => {
    const { paragraphs, linked } = hyperlink(
      [
        'The golden thread is the record. The Golden Thread again is not linked twice.',
        '<code>golden thread</code> in code stays. <a href="/x">pay less notice</a> inside a link stays.',
        'Open the demo environment and ask the developers.',
      ],
      { exclude: '/developers' },
    );
    assert.match(paragraphs[0]!, /<a href="\/how-it-works">golden thread<\/a>/);
    assert.equal((paragraphs[0]!.match(/<a /g) ?? []).length, 1, 'once per article');
    assert.equal(paragraphs[1], '<code>golden thread</code> in code stays. <a href="/x">pay less notice</a> inside a link stays.');
    assert.match(paragraphs[2]!, /<a href="\/demo">demo environment<\/a>/);
    assert.ok(!paragraphs[2]!.includes('href="/developers"'), 'the page being read is not linked to');
    assert.ok(linked.every((entry) => entry.path !== '/developers'));
  });

  it('caps the links in one paragraph so prose stays prose', () => {
    const { paragraphs } = hyperlink(['Golden thread, pay less notice, civil infrastructure, developers and pricing all in one line.']);
    assert.equal((paragraphs[0]!.match(/<a /g) ?? []).length, 2);
  });

  it('points only at pages the site serves', () => {
    const served = new Set(ROUTES.filter((route) => route.method === 'GET' && route.public && route.html).map((route) => route.pattern));
    for (const entry of LINK_GLOSSARY) {
      assert.ok(served.has(entry.path), `${entry.term} → ${entry.path} is not a public page`);
    }
  });
});

describe('sections', () => {
  it('turns two prefixes into a heading and a pull-quote and leaves every other paragraph a paragraph', () => {
    const html = setBody(['Plain.', '## Why it matters now', '> A quote.', '&gt; An escaped quote.']);
    assert.equal(
      html.replace(/\n\s*/g, ''),
      '<p>Plain.</p><h2>Why it matters now</h2><blockquote class="pullquote"><p>A quote.</p></blockquote><blockquote class="pullquote"><p>An escaped quote.</p></blockquote>',
    );
    assert.deepEqual(headingsOf(['a', '## One', '## Two']), ['One', 'Two']);
    assert.match(articleCta('a-post'), /href="\/demo"[^>]*data-share="demo"[^>]*data-slug="a-post"[^>]*>Launch the demo environment</);
  });
});

describe('the published page', () => {
  const page = async (path: string) => {
    const response = await fetch(`${base}${path}`);
    return { status: response.status, html: await response.text() };
  };

  it('carries the byline, the share bar top and bottom, sections, contextual links and the call to action', async () => {
    const { status, html } = await page(`/blog/${slug}`);
    assert.equal(status, 200);
    assert.match(html, /class="post-byline"/);
    assert.match(html, /CONSTRUX Editorial/);
    assert.match(html, /\d+ min read/);
    assert.equal((html.match(/class="share-bar share-top"/g) ?? []).length, 1);
    assert.equal((html.match(/class="share-bar share-bottom"/g) ?? []).length, 1);
    assert.match(html, /<h2>Why the payment notice matters now<\/h2>/);
    assert.match(html, /<h2>How CONSTRUX delivers it<\/h2>/);
    assert.match(html, /<blockquote class="pullquote"><p>A notice nobody can find is a notice nobody gave\.<\/p><\/blockquote>/);
    assert.match(html, /<a href="\/exposure">/, 'a contextual link into the site');
    assert.match(html, /<a href="\/demo">demo environment<\/a>/);
    assert.match(html, /Launch the demo environment/);
    assert.match(html, /<meta name="description" content="What a payment notice is/);
    const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}';
    const data = JSON.parse(block) as Record<string, unknown>;
    assert.equal(data.keywords, 'payment notice');
    assert.match(String(data.timeRequired), /^PT\d+M$/);
    assert.ok(Number(data.wordCount) > 300);
  });

  it('sets the compiled notes the same way, with their own markup kept', async () => {
    const note = POSTS[0]!;
    const { html } = await page(`/blog/${note.slug}`);
    assert.match(html, /CONSTRUX Engineering/);
    assert.match(html, /class="share-bar share-top"/);
    assert.match(html, /<code>PAY_LESS_NOTICE_GIVEN<\/code>/, 'trusted markup survives the linker');
  });

  it('shows the reading time on the index', async () => {
    const { html } = await page('/blog');
    assert.match(html, /class="byline-read">\d+ min read</);
  });
});

describe('a press on the bar, counted as a request', () => {
  const report = (payload: unknown) =>
    fetch(`${base}/v1/site/engagement`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

  it('records a share and a click against a page that exists, by channel', async () => {
    assert.equal((await report({ slug, kind: 'share', channel: 'linkedin' })).status, 200);
    assert.equal((await report({ slug, kind: 'share', channel: 'copy' })).status, 200);
    const clicked = await report({ slug, kind: 'click', channel: 'demo' });
    assert.equal(clicked.status, 200);
    assert.deepEqual(await clicked.json(), { recorded: true });
    assert.deepEqual(engagementFor(slug), { shares: 2, clicks: 1, byChannel: { linkedin: 1, copy: 1 } });
    const position = viewsPosition();
    assert.equal(position.shares, 2);
    assert.equal(position.clicks, 1);
    assert.equal(position.bySlug.find((entry) => entry.slug === slug)?.shares, 2);
  });

  it('records nothing for a page the site does not serve, and says so without a 404', async () => {
    const response = await report({ slug: 'a-draft-nobody-published', kind: 'share', channel: 'x' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { recorded: false });
    assert.equal(engagementFor('a-draft-nobody-published').shares, 0);
  });

  it('refuses a channel or a kind it does not know', async () => {
    assert.equal((await report({ slug, kind: 'share', channel: 'telegram' })).status, 400);
    assert.equal((await report({ slug, kind: 'view', channel: 'x' })).status, 400);
    assert.equal((await report({ slug, kind: 'share', channel: 'x', extra: 1 })).status, 400);
  });
});
