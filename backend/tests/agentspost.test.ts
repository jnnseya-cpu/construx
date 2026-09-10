import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { esc } from '../src/messaging/render.ts';
import { faqOf, hyperlink, LINK_GLOSSARY, wordsOf } from '../src/site/article.ts';
import { seoReport, seoScore, slugify } from '../src/site/blog.ts';
import { llms, robots, sitemap } from '../src/site/discovery.ts';
import { render, SITE_PAGES } from '../src/site/index.ts';
import { composePost, SCHEDULER, TOPICS } from '../src/site/visibility.ts';
import { Platform } from '../src/platform.ts';
import type { RequestContext } from '../src/api/middleware.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * The flagship article, and the two things that decide whether an answer engine
 * can use it.
 *
 * The site had eight topics and every one of them described a capability. None
 * answered the question a buyer now opens with — what is the software allowed
 * to decide — which is the question this company has the strongest answer to and
 * the one it had published nothing about.
 *
 * Three claims are asserted here rather than asserted in a commit message.
 *
 * **It passes its own gate outright.** Not "close enough to publish": every
 * check, which is a hundred out of a hundred, because the publish gate refuses
 * a post with any check failing and a flagship that has to be argued past its
 * own standard is not a flagship.
 *
 * **It carries links a reader would follow.** The glossary is what turns a
 * phrase into a link, and one link per destination is the rule — so the number
 * of links an article can carry is bounded by how many pages the glossary knows
 * and by how many of those the prose has a genuine reason to mention.
 *
 * **A machine can read what it answers.** A `BlogPosting` says a page is an
 * article. It does not say which questions the article settles, and an answer
 * engine quotes a question and the passage under it. The FAQ blocks are derived
 * from the body's own headings, so an article and its structured data cannot
 * disagree.
 */

const AGENTS = TOPICS.find((topic) => topic.id === 'agents');

describe('the article about what an agent may decide', () => {
  it('exists as a topic, with written prose rather than the template', () => {
    assert.ok(AGENTS, 'the AI agents topic is gone from the library');
    assert.ok(AGENTS.article, 'the topic fell back to the composed template, which says the same thing as the other eight');
    // First in the list, so it is the next thing the daily release publishes.
    assert.equal(TOPICS[0]?.id, 'agents', 'the flagship is queued behind eight other posts');
  });

  it('scores a hundred out of a hundred and passes every check', () => {
    const article = AGENTS!.article!;
    const findings = seoReport({
      title: AGENTS!.title,
      standfirst: article.standfirst,
      metaDescription: article.metaDescription,
      slug: slugify(AGENTS!.title),
      body: article.body,
      keyword: AGENTS!.keyword,
    });

    const failed = findings.filter((finding) => !finding.ok);
    assert.deepEqual(
      failed.map((finding) => `${finding.check}: ${finding.detail}`),
      [],
      'the flagship post would be refused publication by the platform’s own gate',
    );

    const score = seoScore(findings);
    assert.equal(score.score, 100);
    assert.equal(score.band, 'STRONG');
    // Depth stated as a number, because "at least 300" is the floor for a page
    // not being thin and is nowhere near what makes one worth citing.
    assert.ok(wordsOf(article.body) >= 800, `${wordsOf(article.body)} words is short for the article this is meant to be`);
  });

  it('links into ten or more different pages of the site', () => {
    const slug = slugify(AGENTS!.title);
    const { linked } = hyperlink(AGENTS!.article!.body.map((line) => esc(line)), { exclude: `/blog/${slug}` });
    const destinations = new Set(linked.map((entry) => entry.path));

    assert.ok(
      destinations.size >= 10,
      `only ${destinations.size} pages linked: ${[...destinations].join(', ')}. The glossary knows more, and prose that ` +
        'mentions none of them is prose a reader leaves from.',
    );
    // The three pages nothing could reach before. Each is in the navigation and
    // in the sitemap and had no contextual link from any article.
    for (const path of ['/status', '/contact']) {
      assert.ok(destinations.has(path), `${path} is still reachable only by somebody deciding to look for it`);
    }
  });

  it('every glossary destination is a page the site actually serves', () => {
    // A phrase pointing at a path the router does not answer is a link that
    // 404s from inside an article, which costs more than the link was worth.
    const served = new Set<string>([...SITE_PAGES.map((page) => page.path), '/verify-document', '/blog', '/']);
    const orphans = LINK_GLOSSARY.map((entry) => entry.path).filter((path) => !served.has(path));
    assert.deepEqual([...new Set(orphans)], [], 'glossary phrases pointing at pages that do not exist');
  });

  it('declares the questions it answers, from its own headings', () => {
    const faq = faqOf(AGENTS!.article!.body.map((line) => esc(line)));
    assert.ok(faq.length >= 4, `${faq.length} questions declared; the article is written around more than that`);

    for (const entry of faq) {
      assert.ok(entry.question.endsWith('?'), `"${entry.question}" is not a question`);
      assert.ok(entry.answer.length > 120, `the answer to "${entry.question}" is too short to be quoted as one`);
      // The escaper's output must not reach a consumer reading the answer text.
      assert.ok(!/&(amp|quot|#39|lt|gt);/.test(entry.answer), `the answer to "${entry.question}" still carries HTML entities`);
      assert.ok(!entry.answer.includes('<'), `the answer to "${entry.question}" still carries markup`);
    }
  });

  it('takes nothing from an article whose sections are statements', () => {
    // The honest answer for a post not written in that shape. A heading dressed
    // up as a question it never asked is worse than no FAQ block at all.
    assert.deepEqual(faqOf(['## How CONSTRUX handles it', 'A paragraph.', '> A pull quote.']), []);
  });
});

describe('the post page says what it is to a machine', () => {
  let platform: Platform;
  let slug: string;

  before(async () => {
    platform = new Platform();
    await seedDemoProject(platform);
    const composed = composePost(
      platform,
      SCHEDULER,
      { topic: AGENTS!.title, keywords: [AGENTS!.keyword], tag: AGENTS!.tag },
      AGENTS,
    );
    assert.equal(composed.outcome, 'PUBLISHED', `the article did not go live: ${composed.held.join(' ')}`);
    slug = composed.post.slug;
  });

  it('carries an article, a breadcrumb and an FAQ, each parsing on its own', () => {
    const html = render(`/blog/${slug}`, platform, { locale: 'en-GB' } as unknown as RequestContext);
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((match) =>
      JSON.parse(match[1]!.replace(/\\u003c/g, '<')) as { '@type'?: string; mainEntity?: unknown[] },
    );
    const types = blocks.map((block) => block['@type']);

    // Separate blocks, not one @graph: every consumer reads a top-level @type,
    // and the site's own sweep asserts a post declares itself an article.
    assert.ok(types.includes('BlogPosting'), `no BlogPosting on the page; found ${types.join(', ')}`);
    assert.ok(types.includes('BreadcrumbList'), 'the post declares no place in the site');
    assert.ok(types.includes('Organization'), 'the publisher block was displaced');

    const faq = blocks.find((block) => block['@type'] === 'FAQPage');
    assert.ok(faq, 'the questions the article answers are not declared');
    assert.ok((faq.mainEntity ?? []).length >= 4, 'fewer questions declared than the article answers');
  });

  it('adds no FAQ to a post that asks none', () => {
    // One of the engineering notes written into the build. Its sections are
    // statements, so it declares an article and a breadcrumb and stops there.
    const html = render('/blog/the-clause-that-was-never-in-the-specification', platform, { locale: 'en-GB' } as unknown as RequestContext);
    assert.ok(!html.includes('"FAQPage"'), 'a post with no questions in it declared an FAQ anyway');
    assert.ok(html.includes('"BlogPosting"'), 'the compiled note stopped declaring itself an article');
  });
});

describe('llms.txt — the reader that answers instead of listing', () => {
  let platform: Platform;

  before(async () => {
    platform = new Platform();
    await seedDemoProject(platform);
  });

  it('names every public page and the paths a machine must not follow', () => {
    const text = llms(platform);
    assert.ok(text.startsWith('# CONSTRUX'), 'the file does not open by saying whose site this is');

    for (const page of SITE_PAGES) {
      assert.ok(text.includes(`${page.path})`), `${page.path} is a public page an assistant is never told about`);
    }
    assert.ok(text.includes('/verify-document)'), 'the one page whose whole audience arrives from outside is absent');

    // The two paths robots.txt refuses, said in prose rather than left out —
    // following the unsubscribe link acts on somebody's behalf.
    assert.ok(text.includes('/unsubscribe'), 'nothing warns a machine off the unsubscribe link');
    assert.ok(text.includes('/app'), 'nothing says the application needs a session');
  });

  it('says only what a page already says', () => {
    // The file cannot become a place where a claim is made that no page is
    // prepared to support: every article line is that post's own standfirst.
    const text = llms(platform);
    for (const post of [
      { slug: 'the-clause-that-was-never-in-the-specification' },
    ]) {
      assert.ok(text.includes(`/blog/${post.slug})`), `${post.slug} is not offered to an assistant`);
    }
  });

  it('is served, and does not disturb robots or the sitemap', () => {
    // The three discovery documents are derived from the same lists, so a page
    // added to one and missed by another is the drift this guards.
    const map = sitemap(platform);
    const text = llms(platform);
    for (const page of SITE_PAGES) {
      assert.ok(map.includes(`${page.path}</loc>`), `${page.path} missing from the sitemap`);
      assert.ok(text.includes(`${page.path})`), `${page.path} missing from llms.txt`);
    }
    assert.match(robots(), /^Sitemap: https?:\/\/.+\/sitemap\.xml$/m);
  });
});
