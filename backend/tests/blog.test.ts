import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import * as blog from '../src/site/blog.ts';

/**
 * The blog as records: written, gated, published, read on the public site,
 * withdrawn — and read back after every step.
 *
 * `posts()` read each entity record as if it were the post, so every field
 * was `undefined` and the first post ever written from the console made the
 * SEO & content screen answer 500. Nothing had caught it because nothing had
 * written a post and then read the blog. This suite does both, at every step.
 */

let platform: Platform;
let ctx: ReturnType<Platform['context']>;
let server: Server;
let base: string;

const paragraph = (lead: string) =>
  `${lead} Retention held without a notice is money withheld without a basis, and an adjudicator will say so. ` +
  'The Construction Act sets the timetable and the site has to keep to it, whatever the contract says about retention. ' +
  'Every certificate carries a due date and a final date, and the notice sits between them. A contractor who reads ' +
  'the dates off the contract rather than off the calendar loses the point on which the whole payment cycle turns.';

const article = {
  title: 'Retention and the pay-less notice on site',
  standfirst: 'What a contractor can and cannot withhold, and the notice that has to say so.',
  metaDescription:
    'A plain reading of the pay-less notice under the Construction Act, and why retention is not a way round it on a UK site.',
  keyword: 'pay-less notice',
  body: [
    paragraph('A pay-less notice is the only instrument that lets a payer pay less than the notified sum, and it has to be given in time.'),
    ...Array.from({ length: 6 }, (_, i) => paragraph(`Paragraph ${i + 2} keeps to the same point.`)),
  ],
};

before(async () => {
  platform = new Platform();
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  ctx = platform.context(authOf(platform, operator.id), blog.BLOG_PROJECT_ID, { source: 'WEB' });
  // The public site through the real gateway, which is how a reader reaches a post.
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const publicPage = async (path: string): Promise<{ status: number; html: string }> => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, html: await response.text() };
};

describe('a post written by hand', () => {
  let postId = '';

  it('is read back as the post that was written, with its body', () => {
    const { post } = blog.writePost(ctx, platform, article);
    postId = post.id;
    const held = blog.posts(platform);
    assert.equal(held.length, 1);
    assert.equal(held[0]!.id, post.id);
    assert.deepEqual(held[0]!.body, article.body, 'the body is on the record, not undefined');
    assert.equal(held[0]!.authorship, 'HUMAN');
    assert.equal(held[0]!.status, 'DRAFT');
  });

  it('is on the SEO & content position with its checks, and the position reads', () => {
    const position = blog.blogPosition(platform);
    assert.equal(position.drafts, 1);
    assert.equal(position.published, 0);
    const [entry] = position.posts;
    assert.ok(entry);
    assert.equal(entry.id, postId);
    assert.ok(entry.seo.length > 0);
    assert.equal(typeof entry.publishable, 'boolean');
    assert.equal(entry.publishable, entry.seo.every((finding) => finding.ok));
  });

  it('is refused publication while a check fails, and the failing check is named', () => {
    const { post: thin } = blog.writePost(ctx, platform, {
      ...article,
      title: 'A second post that is far too thin',
      body: ['One line is not an article.'],
    });
    const error = throwsCode(() => blog.publishPost(ctx, platform, thin.id), 'SEO_CHECKS_FAILED');
    assert.match(String(error.message), /word/i);
    assert.equal(blog.publishedPosts(platform).length, 0);
  });

  it('is published when every check passes, and the public site serves it', async () => {
    assert.equal((await publicPage(`/blog/${blog.posts(platform).find((post) => post.id === postId)!.slug}`)).status, 404, 'a draft is not public');

    const { post, seo } = blog.publishPost(ctx, platform, postId);
    assert.equal(post.status, 'PUBLISHED');
    assert.ok(seo.every((finding) => finding.ok));
    assert.equal(blog.publishedPosts(platform).length, 1);
    assert.equal(blog.publishedPost(platform, post.slug)?.id, postId);

    const page = await publicPage(`/blog/${post.slug}`);
    assert.equal(page.status, 200, 'the public site renders the post at its slug');
    assert.match(page.html, /pay-less notice/);
    const index = await publicPage('/blog');
    assert.equal(index.status, 200);
    assert.match(index.html, new RegExp(`/blog/${post.slug}`));
  });

  it('cannot be published twice', () => {
    throwsCode(() => blog.publishPost(ctx, platform, postId), 'ALREADY_PUBLISHED');
  });

  it('is taken down with a reason, and leaves the public site', async () => {
    const post = blog.withdrawPost(ctx, platform, postId, 'Rewritten after a reader pointed out the dates.');
    assert.equal(post.status, 'WITHDRAWN');
    assert.equal(blog.publishedPosts(platform).length, 0);
    assert.equal((await publicPage(`/blog/${post.slug}`)).status, 404, 'a withdrawn post is not served');
    assert.equal(blog.blogPosition(platform).published, 0);
  });

  it('lets the operator fund the platform wallet the draft and the audit spend from', () => {
    // The platform's own wallet is built in memory and was never opened on the
    // ledger, so the first credit — the only way the AI draft could ever be
    // afforded — was refused as ENTITY_NOT_FOUND on the top-up event.
    assert.equal(platform.wallet('platform').snapshot().availableMinor, 0);
    const first = platform.creditFromPayment({
      tenantId: 'platform',
      amountMinor: 5_000,
      method: 'BANK_TRANSFER',
      reference: 'BACS-PLATFORM-0001',
      recordedBy: ctx.auth.actorId,
      source: 'OPERATOR',
    });
    assert.equal(first.alreadyRecorded, false);
    assert.equal(platform.wallet('platform').snapshot().availableMinor, 5_000);
    assert.ok(platform.ledger.get({ refType: 'ACUWallet', refId: 'platform' }), 'the wallet is on the record from its first credit');
    const opened = platform.ledger.events().filter((event) => event.eventType === 'ACU_WALLET_OPENED' && event.entity.refId === 'platform');
    assert.equal(opened.length, 1);

    const second = platform.creditFromPayment({
      tenantId: 'platform',
      amountMinor: 2_500,
      method: 'CARD',
      reference: 'CARD-PLATFORM-0002',
      recordedBy: ctx.auth.actorId,
      source: 'OPERATOR',
    });
    assert.equal(second.alreadyRecorded, false);
    assert.equal(platform.wallet('platform').snapshot().availableMinor, 7_500);
    assert.equal(
      platform.ledger.events().filter((event) => event.eventType === 'ACU_WALLET_OPENED' && event.entity.refId === 'platform').length,
      1,
      'opened once, not on every credit',
    );
    // And the whole record, including the wallet opened late, replays.
    const restored = new Platform();
    assert.deepEqual(restored.ledger.restore(platform.ledger.events()).discrepancies, []);
  });

  it('refuses a draft from the local stand-in before anything is charged', async () => {
    const before = platform.wallet('platform').snapshot();
    assert.ok(before.availableMinor > 0, 'funded by the test above');
    const entriesBefore = platform.wallet('platform').entries().length;
    await assert.rejects(
      blog.draftPost(ctx, platform, { keyword: 'golden thread', angle: 'A record that survives the people who made it is the only kind worth keeping.' }),
      (error: { code?: string }) => error.code === 'NO_REASONING_PROVIDER',
    );
    const after = platform.wallet('platform').snapshot();
    assert.equal(after.availableMinor, before.availableMinor, 'a refusal costs nothing');
    assert.equal(after.heldMinor, 0, 'the hold is released');
    const since = platform.wallet('platform').entries().slice(entriesBefore);
    assert.ok(since.every((entry) => entry.type !== 'DEBIT'), `no debit for a refusal: ${since.map((entry) => entry.type).join(',')}`);
    assert.equal(blog.posts(platform).length, 2, 'nothing was drafted');
  });

  it('survives a restart with every field intact', () => {
    const restored = new Platform();
    restored.ledger.restore(platform.ledger.events());
    restored.rehydrate();
    const held = blog.posts(restored);
    assert.equal(held.length, 2);
    assert.deepEqual(
      held.map((post) => ({ id: post.id, status: post.status, paragraphs: post.body.length })),
      blog.posts(platform).map((post) => ({ id: post.id, status: post.status, paragraphs: post.body.length })),
    );
  });
});
