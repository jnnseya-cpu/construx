import { api } from '../lib/api.js';
import { lineChart } from '../lib/charts.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { axisDay, head, refusal } from '../lib/estate.js';
import { badge, html, money, raw, render, table, time, toast, track } from '../lib/ui.js';
import { draw } from '../app.js';

/**
 * SEO and content.
 *
 * Six posts lived as a hard-coded array, so publishing a seventh meant editing
 * TypeScript and redeploying — and in practice nobody did, which is how a
 * company blog stops moving. This is where one gets written, checked, measured
 * and put on the public site without touching the build.
 *
 * Three things are on this screen and they are deliberately different kinds of
 * thing:
 *
 * **The gate.** A post is refused publication while any check fails, with each
 * failure named. That is binary and it decides.
 *
 * **The score.** Weighted, out of a hundred, derived from the same checks. It
 * decides nothing. It exists because a gate gives no gradient: you cannot tell
 * a post failing one check by two characters from one failing four badly, and
 * you cannot tell whether the blog is getting better. The score is always shown
 * beside the failing checks, never instead of them.
 *
 * **The views.** Server-rendered requests for a page — not readers. A crawler
 * counts, one person reading twice counts twice, and nobody is identified. The
 * label says "requests" everywhere it appears, because a number that is honest
 * about what it measures is worth more than a bigger one nobody can defend.
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
  fund: () => ({
    title: 'Fund the platform wallet',
    intent:
      'The draft and the audit spend the platform’s own ACU wallet, not a customer’s. This records a payment already ' +
      'received into the company’s own account and credits the wallet against it. The reference is the bank’s or the ' +
      'provider’s and is the idempotency key: the same reference twice credits once. Do not invent one.',
    path: '/v1/admin/tenants/platform/credit',
    submitLabel: 'Credit the wallet',
    fields: [
      { name: 'amountMinor', label: 'Amount (pence)', type: 'number', hint: '£50 is 5000.' },
      {
        name: 'method',
        label: 'How it arrived',
        type: 'select',
        options: [
          { value: 'BANK_TRANSFER', label: 'Bank transfer' },
          { value: 'CARD', label: 'Card' },
          { value: 'MANUAL_ADJUSTMENT', label: 'Manual adjustment' },
        ],
      },
      { name: 'reference', label: 'Reference', hint: 'The bank’s or provider’s own identifier. Unique for ever.' },
      { name: 'note', label: 'Note', required: false },
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
const BAND_TONE = { STRONG: 'ok', WORKABLE: 'warn', WEAK: 'bad' };
const SEVERITY_TONE = { HIGH: 'bad', MEDIUM: 'warn', LOW: 'info' };

/** Held outside `blog()` so an audit survives the redraw that follows a publish. */
let lastAudit = null;

export async function blog(root) {
  const position = await api.get('/v1/site/posts').catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'SEO & content' })}${refusal('The blog', position.error)}`);
    return;
  }

  const posts = position.posts ?? [];
  const blocked = posts.filter((post) => post.status === 'DRAFT' && !post.publishable);
  const live = posts.filter((post) => post.status === 'PUBLISHED');
  const views = position.views ?? { total: 0, bySlug: [], daily: [], durable: false, note: '' };
  const wallet = position.wallet ?? null;

  render(
    root,
    html`
      ${head({
        title: 'SEO & content',
        intent: `${position.summary} A model may draft; only a person publishes, and a post is refused publication while any check is failing.`,
        actions: commandBar([
          { id: 'draft', label: 'Ask for a draft', permitted: true, tone: 'primary' },
          { id: 'write', label: 'Write one yourself', permitted: true },
          { id: 'audit', label: 'Audit the blog', permitted: true },
          { id: 'fund', label: 'Fund the platform wallet', permitted: true },
        ]),
      })}

      ${wallet && wallet.availableMinor <= 0
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>The platform wallet holds ${money(wallet.availableMinor)}, so a draft and an audit are held.</b><br />
              Both spend the platform’s own ACU wallet rather than a customer’s, and it starts empty: nothing spends
              without credit behind it. Press <b>Fund the platform wallet</b> to record a payment received into the
              company’s own account; the quote on each action then clears on its own.
            </div>
          </div>`
        : ''}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Live</h2>
          <div class="metric">${(position.published ?? 0) + (position.fixed ?? 0)}</div>
          <div class="metric-sub">${position.fixed ?? 0} written into the build · ${position.published ?? 0} published from here</div>
        </div>
        <div class="card">
          <h2>Average score</h2>
          <div class="metric ${raw(
            position.averageScore === null ? '' : position.averageScore >= 90 ? 'good' : position.averageScore >= 65 ? 'warn' : 'bad',
          )}">${position.averageScore === null ? '—' : position.averageScore}</div>
          <div class="metric-sub">
            ${position.averageScore === null
              ? 'nothing published from the console yet to average'
              : 'across posts published from here — drafts are excluded so writing one does not drag it down'}
          </div>
        </div>
        <div class="card">
          <h2>Page requests</h2>
          <div class="metric">${(views.total ?? 0).toLocaleString('en-GB')}</div>
          <div class="metric-sub">
            requests, not readers${views.durable ? '' : ' · not durable on this process'}
          </div>
        </div>
        <div class="card">
          <h2>Platform wallet</h2>
          <div class="metric ${raw(wallet && wallet.availableMinor > 0 ? 'good' : 'warn')}">${wallet ? money(wallet.availableMinor) : '—'}</div>
          <div class="metric-sub">available for the draft and the audit · ${wallet ? money(wallet.heldMinor) : '—'} held against runs in flight</div>
        </div>
        <div class="card ${raw(blocked.length > 0 ? 'warn' : '')}">
          <h2>Blocked by a check</h2>
          <div class="metric ${raw(blocked.length > 0 ? 'warn' : '')}">${blocked.length}</div>
          <div class="metric-sub">drafts that cannot be published until every check passes</div>
        </div>
      </section>

      <div class="notice info" style="margin-bottom:14px">
        <div>
          <b>The score decides nothing.</b><br />
          A post is refused publication while <i>any</i> check fails — that is the gate, and it is binary. The score
          exists because a gate gives no gradient: it cannot tell a post failing one check by two characters from one
          failing four badly, and it cannot say whether the blog is getting better. It is always shown beside the
          failing checks, never instead of them.
        </div>
      </div>

      ${views.daily?.length > 0
        ? html`<div class="grid g-2-1" style="margin-bottom:14px">
            <div class="card chart-card">
              <h2>Page requests — last ${views.windowDays} days</h2>
              <div class="metric-sub" style="margin-bottom:12px">${views.note}</div>
              ${lineChart({
                title: 'Requests, day by day',
                data: views.daily.map((day) => ({ label: axisDay(day.date), value: day.views })),
                series: [{ key: 'value', label: 'Requests' }],
                format: (value) => String(value),
                empty: 'No page has been requested in this window.',
              })}
            </div>
            <div class="card">
              <h2>Most requested</h2>
              <div class="metric-sub" style="margin-bottom:12px">
                Every published page, including the ones written into the build.
              </div>
              <div class="split-list">
                ${(views.bySlug ?? []).slice(0, 10).map(
                  (entry) => html`<div class="row">
                    <span class="lbl mono" style="font-size:11px">${entry.slug}</span>
                    <span class="val">${entry.views} · ${entry.last30} in ${views.windowDays}d</span>
                  </div>`,
                )}
              </div>
            </div>
          </div>`
        : html`<div class="card" style="margin-bottom:14px">
            <h2>Page requests</h2>
            <div class="metric-sub" style="margin-top:8px">
              Nothing has been requested yet. ${views.note}
            </div>
          </div>`}

      ${lastAudit
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>
              SEO audit
              ${badge(`by ${String(lastAudit.provider).toLowerCase()}`, 'ai')}
              ${badge(`${lastAudit.acuConsumed} ACU`, 'info')}
            </h2>
            <div class="metric-sub" style="margin:8px 0 14px">
              Run ${time(lastAudit.ranAt)} against ${lastAudit.reviewed.length}
              post${lastAudit.reviewed.length === 1 ? '' : 's'} published from the console. It proposes and never acts —
              nothing below has been written, published or scheduled.
            </div>

            ${lastAudit.findings.length > 0
              ? raw(
                  table({
                    headers: ['Finding', 'Severity', 'Detail'],
                    rows: lastAudit.findings.map((finding) => [
                      html`<b>${finding.title}</b>`,
                      badge(finding.severity.toLowerCase(), SEVERITY_TONE[finding.severity] ?? 'info'),
                      finding.detail,
                    ]),
                  }),
                )
              : html`<div class="metric-sub">It found nothing wrong with what is published.</div>`}

            ${lastAudit.proposals.length > 0
              ? html`<h3 style="margin-top:16px">What to write next</h3>
                  <div class="split-list">
                    ${lastAudit.proposals.map(
                      (proposal, index) => html`<div class="row" style="align-items:flex-start;gap:14px">
                        <span class="lbl" style="flex:1 1 0;min-width:0">
                          <b>${proposal.title}</b><br />
                          <span class="metric-sub">found by "${proposal.keyword}" · ${proposal.why}</span>
                        </span>
                        <span class="val"><button class="btn quiet sm" data-take="${index}">Draft this</button></span>
                      </div>`,
                    )}
                  </div>`
              : ''}

            <div class="metric-sub" style="margin-top:16px">
              <b>What this audit is not.</b>
              ${lastAudit.limits.map((limit) => html`<div>· ${limit}</div>`)}
            </div>
          </div>`
        : ''}

      ${posts.map(
        (post) => html`
          <section class="card">
            <h3>
              ${post.title || '(untitled)'}
              ${badge(String(post.status).toLowerCase(), STATUS_TONE[post.status] ?? 'neutral')}
              ${badge(`score ${post.score.score}`, BAND_TONE[post.score.band] ?? 'neutral')}
              ${post.authorship === 'AI_DRAFTED'
                ? badge(`drafted by ${String(post.provider ?? 'a model').toLowerCase()}`, 'ai')
                : badge('written by a person', 'neutral')}
            </h3>
            <p class="metric-sub">
              <code>/blog/${post.slug}</code> ·
              ${post.status === 'PUBLISHED' ? `published ${time(post.publishedAt)}` : `drafted ${time(post.draftedAt)}`}
              ${post.status === 'PUBLISHED' ? ` · ${post.views} page request${post.views === 1 ? '' : 's'}` : ''}
              ${post.withdrawnReason ? ` · withdrawn: ${post.withdrawnReason}` : ''}
            </p>
            <p>${post.standfirst}</p>

            <div style="margin:10px 0">
              ${track(post.score.score, post.score.band === 'STRONG' ? '' : post.score.band === 'WORKABLE' ? 'warn' : 'bad')}
              <div class="metric-sub" style="margin-top:6px">
                ${post.score.passing} of ${post.score.total} checks passing. ${post.score.summary}
              </div>
            </div>

            ${raw(
              table({
                headers: ['Check', 'Verdict', 'Costs', 'Why'],
                align: ['', '', 'num', ''],
                rows: (post.seo ?? []).map((finding) => {
                  const weight = post.score.worst.find((entry) => entry.check === finding.check);
                  return [
                    finding.check,
                    finding.ok ? badge('ok', 'good') : badge('fix', 'bad'),
                    weight ? `−${weight.weight}` : '—',
                    finding.detail,
                  ];
                }),
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
            this is where the next one gets written. They are not scored — they predate these checks and carry no
            keyword, and rewriting them as records would gain nothing and lose their history.
          </div>`
        : ''}
    `,
  );

  root.querySelector('.cmd-bar')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-command]');
    if (!button) return;

    if (button.dataset.command === 'audit') {
      // The same disclosure a drafting press gets: it reaches a provider and it
      // spends, so the cost is quoted before anybody commits to it.
      if (
        !(await confirmCost({
          title: 'Audit the blog',
          intent:
            'The reasoning engine reads every post published from here — its title, the phrase it targets, its length, ' +
            'its check score and how many requests its page has served — and returns what is wrong and what to write ' +
            'next. It proposes and never acts.',
          path: '/v1/site/posts/audit',
          runLabel: 'Run the audit',
        }))
      ) {
        return;
      }
      button.disabled = true;
      button.textContent = 'Reading the blog…';
      try {
        lastAudit = await api.post('/v1/site/posts/audit', {});
        toast(
          'Audit complete',
          `${lastAudit.findings.length} finding${lastAudit.findings.length === 1 ? '' : 's'} · ` +
            `${lastAudit.proposals.length} article${lastAudit.proposals.length === 1 ? '' : 's'} proposed`,
          'ok',
        );
        await blog(root);
      } catch (error) {
        toast('The audit was refused', error.message, 'err');
        button.disabled = false;
        button.textContent = 'Audit the blog';
      }
      return;
    }

    const spec = COMMANDS[button.dataset.command]?.();
    if (spec && (await command(spec))) await draw();
  });

  // Take a proposal straight into a draft, with the model's own reasoning as the
  // angle. The person still edits and still publishes.
  for (const button of root.querySelectorAll('[data-take]')) {
    button.addEventListener('click', async () => {
      const proposal = lastAudit?.proposals?.[Number(button.getAttribute('data-take'))];
      if (!proposal) return;
      const spec = COMMANDS.draft();
      spec.fields[0].value = proposal.keyword;
      spec.fields[1].value = `${proposal.title}. ${proposal.why}`;
      if (await command(spec)) await draw();
    });
  }

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
