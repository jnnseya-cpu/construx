import { api } from '../lib/api.js';
import { badge, html, raw, render, table, time } from '../lib/ui.js';
import { command, commandBar } from '../lib/command.js';
import { draw } from '../app.js';

/**
 * The blog.
 *
 * Six posts lived as a hard-coded array, so publishing a seventh meant editing
 * TypeScript and redeploying — and in practice nobody did, which is how a
 * company blog stops moving. This is where one gets written, checked and put
 * on the public site without touching the build.
 *
 * The screen is arranged around the one rule that matters: **a model drafts and
 * a person publishes.** Drafting is a button that spends ACUs and produces
 * something nobody outside this room can see. Publishing is a separate press,
 * on a separate row, and it is refused while any SEO check fails — with each
 * failure named, because "SEO score 62" is not something anybody can act on.
 */

const COMMANDS = {
  draft: () => ({
    title: 'Ask for a draft',
    intent:
      'The reasoning engine writes an article and it lands as a draft. Nothing reaches the public site until you ' +
      'press publish, and the record keeps that a model wrote the first version however much it is edited after.',
    path: '/v1/site/posts/draft',
    submitLabel: 'Draft it',
    aiCost: true,
    fields: [
      {
        name: 'keyword',
        label: 'The phrase it should be found by',
        hint: 'What somebody would actually type. It must appear in the title and the opening paragraph, and the checks below enforce that.',
      },
      {
        name: 'angle',
        label: 'What the post should argue',
        type: 'textarea',
        hint: 'A sentence at least. "Write about delays" produces an article about nothing — say what the reader should think differently by the end.',
      },
      { name: 'tag', label: 'Tag', required: false, hint: 'Industry, Engineering, Company. Defaults to Industry.' },
    ],
  }),
  write: () => ({
    title: 'Write one yourself',
    intent: 'No model involved, and the record says so.',
    path: '/v1/site/posts',
    submitLabel: 'Save draft',
    fields: [
      { name: 'title', label: 'Title', hint: 'Between 25 and 60 characters, or a search result truncates it.' },
      { name: 'standfirst', label: 'Standfirst', hint: 'The line under the headline. It is what the blog index shows.' },
      {
        name: 'metaDescription',
        label: 'Meta description',
        hint: 'Between 70 and 160 characters. This is the sentence under the link in a search result.',
      },
      { name: 'keyword', label: 'Keyword', hint: 'Must appear in the title and the first paragraph.' },
      {
        name: 'body',
        label: 'Body',
        type: 'textarea',
        hint: 'One paragraph per line. At least 300 words, or the page is treated as thin.',
      },
      { name: 'tag', label: 'Tag', required: false },
    ],
    transform: ({ body, ...rest }) => ({
      ...rest,
      body: String(body ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    }),
  }),
};

const STATUS_TONE = { PUBLISHED: 'ok', DRAFT: 'info', WITHDRAWN: 'muted' };

export async function blog(root) {
  const position = await api.get('/v1/site/posts').catch((error) => ({ error }));

  if (position.error) {
    render(
      root,
      html`<div class="view-head"><div><h1>Blog</h1></div></div>
        <div class="notice err">
          <div><b>The blog could not be read</b><br />${position.error.message}</div>
        </div>`,
    );
    return;
  }

  const posts = position.posts ?? [];
  const blocked = posts.filter((post) => post.status === 'DRAFT' && !post.publishable);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Blog</h1>
          <p>
            ${position.summary} A model may draft; only a person publishes, and a post is refused publication
            while any check below is failing.
          </p>
        </div>
        <div class="actions cmd-bar">
          ${raw(
            commandBar([
              { id: 'draft', label: 'Ask for a draft', permitted: true, tone: 'primary' },
              { id: 'write', label: 'Write one yourself', permitted: true },
            ]),
          )}
        </div>
      </div>

      <section class="grid g4">
        <div class="metric"><span>Live</span><strong>${(position.published ?? 0) + (position.fixed ?? 0)}</strong></div>
        <div class="metric"><span>Written into the build</span><strong>${position.fixed ?? 0}</strong></div>
        <div class="metric"><span>Drafts</span><strong>${position.drafts ?? 0}</strong></div>
        <div class="metric ${raw(blocked.length > 0 ? 'warn' : '')}"><span>Blocked by a check</span><strong>${blocked.length}</strong></div>
      </section>

      <div class="notice info">
        <div>
          <b>The ${position.fixed ?? 0} oldest posts are not listed here.</b><br />
          They are written into the build as source and stay that way — they are the engineering notes this project
          actually produced, and rewriting them as records would gain nothing and lose their history. Everything
          published from this screen is added alongside them.
        </div>
      </div>

      ${posts.map(
        (post) => html`
          <section class="card">
            <h3>
              ${post.title || '(untitled)'}
              ${badge(String(post.status).toLowerCase(), STATUS_TONE[post.status] ?? 'neutral')}
              ${post.authorship === 'AI_DRAFTED'
                ? badge(`drafted by ${String(post.provider ?? 'a model').toLowerCase()}`, 'ai')
                : badge('written by a person', 'neutral')}
            </h3>
            <p class="metric-sub">
              <code>/blog/${post.slug}</code> ·
              ${post.status === 'PUBLISHED' ? `published ${time(post.publishedAt)}` : `drafted ${time(post.draftedAt)}`}
              ${post.withdrawnReason ? ` · withdrawn: ${post.withdrawnReason}` : ''}
            </p>
            <p>${post.standfirst}</p>

            ${raw(
              table({
                headers: ['Check', 'Verdict', 'Why'],
                rows: (post.seo ?? []).map((finding) => [
                  finding.check,
                  finding.ok ? badge('ok', 'good') : badge('fix', 'bad'),
                  finding.detail,
                ]),
                empty: 'No checks ran against this post.',
              }),
            )}

            <div class="actions" style="margin-top:10px">
              ${post.status === 'DRAFT'
                ? html`<button
                      class="btn ${raw(post.publishable ? 'primary' : 'quiet locked')}"
                      data-publish="${post.id}"
                      ${raw(post.publishable ? '' : 'disabled')}
                      title="${post.publishable ? 'Put this on the public site' : 'Every check must pass before this can be published'}"
                    >
                      Publish${post.publishable ? '' : ' 🔒'}
                    </button>
                    <button class="btn quiet" data-revise="${post.id}">Edit</button>`
                : ''}
              ${post.status === 'PUBLISHED'
                ? html`<a class="btn quiet" href="/blog/${post.slug}" target="_blank" rel="noreferrer">View it live</a>
                    <button class="btn quiet" data-withdraw="${post.id}">Take it down</button>`
                : ''}
            </div>
          </section>
        `,
      )}

      ${posts.length === 0
        ? html`<div class="empty">
            <b>Nothing has been drafted yet.</b>The ${position.fixed ?? 0} posts in the build are still on the site;
            this is where the next one gets written.
          </div>`
        : ''}
    `,
  );

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;
    const spec = COMMANDS[button.dataset.command]?.();
    if (spec && (await command(spec))) await draw();
  });

  for (const button of root.querySelectorAll('[data-publish]')) {
    button.addEventListener('click', async () => {
      // Hoisted rather than interpolated inline. `consoleforms.test.ts` reads
      // the literal paths this console calls and checks each against the route
      // table; a nested call inside the template hides the path from it, and a
      // path the invariant cannot read is a path it cannot protect.
      const postId = button.getAttribute('data-publish');
      const ok = await command({
        title: 'Publish this post',
        intent:
          'It goes on the public site at its address, enters the sitemap, and becomes something a search engine ' +
          'can index. Taking it down later leaves the record that it was up.',
        path: `/v1/site/posts/${postId}/publish`,
        submitLabel: 'Publish',
        fields: [],
      });
      if (ok) await draw();
    });
  }

  for (const button of root.querySelectorAll('[data-withdraw]')) {
    button.addEventListener('click', async () => {
      const postId = button.getAttribute('data-withdraw');
      const ok = await command({
        title: 'Take this post down',
        intent: 'The URL stops answering. The record stays, because a page that was live is a thing that happened.',
        path: `/v1/site/posts/${postId}/withdraw`,
        submitLabel: 'Withdraw',
        fields: [{ name: 'reason', label: 'Why', hint: 'At least ten characters. Somebody will ask later.' }],
      });
      if (ok) await draw();
    });
  }

  for (const button of root.querySelectorAll('[data-revise]')) {
    button.addEventListener('click', async () => {
      const post = posts.find((candidate) => candidate.id === button.getAttribute('data-revise'));
      if (!post) return;
      const ok = await command({
        title: 'Edit this draft',
        intent: 'Leave a field as it is to keep it. A published post is withdrawn before it can be edited.',
        path: `/v1/site/posts/${post.id}/revise`,
        submitLabel: 'Save',
        fields: [
          { name: 'title', label: 'Title', value: post.title, required: false },
          { name: 'standfirst', label: 'Standfirst', value: post.standfirst, required: false },
          { name: 'metaDescription', label: 'Meta description', value: post.metaDescription, required: false },
          { name: 'keyword', label: 'Keyword', value: post.keyword, required: false },
          { name: 'tag', label: 'Tag', value: post.tag, required: false },
          {
            name: 'body',
            label: 'Body',
            type: 'textarea',
            value: (post.body ?? []).join('\n'),
            required: false,
            hint: 'One paragraph per line.',
          },
        ],
        transform: (fields) => {
          const patch = {};
          for (const [key, value] of Object.entries(fields)) {
            if (value === undefined || value === '') continue;
            patch[key] = key === 'body' ? String(value).split('\n').map((line) => line.trim()).filter(Boolean) : value;
          }
          return patch;
        },
      });
      if (ok) await draw();
    });
  }
}
