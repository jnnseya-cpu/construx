import { api } from '../lib/api.js';
import { lineChart } from '../lib/charts.js';
import { command, commandBar, confirmCost } from '../lib/command.js';
import { axisDay, head, refusal } from '../lib/estate.js';
import { badge, html, money, raw, render, table, time, toast, track } from '../lib/ui.js';
import { draw } from '../app.js';

/**
 * SEO and content — the AI visibility engine.
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
 *
 * Above the posts sits the site read as a whole: a sweep of eleven things a
 * crawler, a link preview and a search result actually look for, read off the
 * rendered pages; the reach the pages have had; the channels a post can be
 * sent to and which are configured; the eight topics the site should cover
 * and which do; the daily release and what it did; and what the marketing
 * agent recommends doing next. The generator composes a post from the feature
 * catalogue — sentences the product already publishes about itself — and may
 * publish it on the spot; with a reasoning provider configured it asks for an
 * original draft instead, which a person publishes.
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
  generate: () => ({
    title: 'Generate & publish',
    intent:
      'The marketing agent composes a post from the feature catalogue — sentences the product already publishes about ' +
      'itself — around your topic and keywords, runs every check, and publishes where all of them pass. It invents no ' +
      'figure and no claim. Where a check fails it stays a draft and the check is named.',
    path: '/v1/site/posts/compose',
    submitLabel: 'Generate & publish',
    fields: [
      { name: 'topic', label: 'Topic', hint: 'What the post is about, in a phrase. It becomes the title where it fits between 25 and 60 characters.' },
      {
        name: 'keywords',
        label: 'Keywords',
        hint: 'Comma-separated, up to five. The first is the phrase the checks enforce in the title and the opening.',
      },
      { name: 'tag', label: 'Tag', required: false, hint: 'Defaults to Marketing.' },
      {
        name: 'publish',
        label: 'Publish',
        type: 'select',
        options: [
          { value: 'true', label: 'Publish now where every check passes' },
          { value: 'false', label: 'Leave it as a draft for me to read first' },
        ],
      },
    ],
    transform: ({ keywords, publish, tag, ...rest }) => ({
      ...rest,
      ...(tag ? { tag } : {}),
      publish: publish !== 'false',
      keywords: String(keywords ?? '')
        .split(',')
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    }),
  }),
  library: () => ({
    title: 'Generate marketing library',
    intent:
      'One published post per topic that has none — eight topics, each with the phrase a buyer would type. A topic ' +
      'already on the record, published or in draft, is skipped and named, so pressing this twice writes nothing twice.',
    path: '/v1/site/marketing/library',
    submitLabel: 'Generate the library',
    fields: [],
  }),
  release: () => ({
    title: "Run today's release",
    intent:
      'Publishes the next uncovered topic and sends it to every configured channel, then writes down what it did. ' +
      'Once per UTC day: if today’s release has already run, this returns it rather than running again. With every ' +
      'topic covered it publishes nothing and says so — it never re-sends an old post to fill the day.',
    path: '/v1/site/marketing/release',
    submitLabel: 'Run the release',
    fields: [],
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
        hint:
          'One paragraph per line. At least 300 words, or the page is treated as thin. A line starting "## " is a section ' +
          'heading and one starting "> " is a pull-quote; the page links the first mention of a phrase that has a page on the site.',
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
const AUTHOR_LABEL = { HUMAN: 'written by a person', AI_DRAFTED: 'drafted by a model', MARKETING_AGENT: 'composed by the marketing agent' };

/** Held outside `blog()` so an audit survives the redraw that follows a publish. */
let lastAudit = null;

/** The generator door: the template when no provider is configured, the reasoning engine when one is. */
function generatorSpec(visibility) {
  if (visibility?.generator?.mode === 'AI') {
    const spec = COMMANDS.draft();
    spec.title = 'Generate a draft';
    spec.intent = `${visibility.generator.note} ${spec.intent}`;
    return spec;
  }
  return COMMANDS.generate();
}

/** Say what a compose actually did, because "Generate & publish" can legitimately stop at "generate". */
function reportCompose(result) {
  if (!result || !result.outcome) return;
  if (result.outcome === 'PUBLISHED') toast('Published', `/blog/${result.post.slug} is live and in the sitemap.`, 'ok');
  else if (result.outcome === 'DRAFT') toast('Drafted', `/blog/${result.post.slug} is a draft. Publish it from the list below.`, 'ok');
  else toast('Held by its checks', `${result.held.length} check${result.held.length === 1 ? '' : 's'} failing — it stays a draft. ${result.held[0] ?? ''}`, 'err');
}

function reportRelease(release) {
  if (!release) return;
  toast(release.alreadyRun ? `Today's release already ran` : 'Release complete', release.note, release.alreadyRun ? 'err' : 'ok');
}

export async function blog(root) {
  const [position, visibility] = await Promise.all([
    api.get('/v1/site/posts').catch((error) => ({ error })),
    api.get('/v1/site/visibility').catch((error) => ({ error })),
  ]);

  if (position.error) {
    render(root, html`${head({ title: 'SEO & content' })}${refusal('The blog', position.error)}`);
    return;
  }

  const posts = position.posts ?? [];
  const blocked = posts.filter((post) => post.status === 'DRAFT' && !post.publishable);
  const live = posts.filter((post) => post.status === 'PUBLISHED');
  const views = position.views ?? { total: 0, bySlug: [], daily: [], durable: false, note: '' };
  const wallet = position.wallet ?? null;

  const vis = visibility.error ? null : visibility;
  const signal = vis?.signal ?? null;
  const channels = vis?.channels ?? [];
  const configured = channels.filter((channel) => channel.configured);
  const topics = vis?.topics ?? [];
  const covered = topics.filter((topic) => topic.covered).length;
  const byPostId = new Map((vis?.posts ?? []).map((entry) => [entry.id, entry]));
  const generatorLabel = vis?.generator?.mode === 'AI' ? 'Generate a draft' : 'Generate & publish';

  render(
    root,
    html`
      ${head({
        title: 'SEO & content',
        intent: `${position.summary} A model may draft; only a person publishes, and a post is refused publication while any check is failing. The marketing agent composes from the feature catalogue and may publish what it composes.`,
        actions: commandBar([
          { id: 'generate', label: generatorLabel, permitted: true, tone: 'primary' },
          { id: 'library', label: 'Generate marketing library', permitted: true },
          { id: 'release', label: "Run today's release", permitted: true },
          { id: 'draft', label: 'Ask for a draft', permitted: true },
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
              company’s own account; the quote on each action then clears on its own. The generator, the library and
              the release compose from the catalogue and spend nothing.
            </div>
          </div>`
        : ''}

      ${visibility.error ? refusal('The visibility position', visibility.error) : ''}

      ${vis
        ? html`<section class="grid g4" style="margin-bottom:14px">
            <div class="card">
              <h2>Signal score</h2>
              <div class="metric ${raw(signal.band === 'STRONG' ? 'good' : signal.band === 'WORKABLE' ? 'warn' : 'bad')}">${signal.score}</div>
              <div class="metric-sub">${signal.passing} of ${signal.total} sweep checks passing · ${signal.band.toLowerCase()}</div>
            </div>
            <div class="card">
              <h2>Reach</h2>
              <div class="metric">${(vis.reach.requests ?? 0).toLocaleString('en-GB')}</div>
              <div class="metric-sub">page requests, ${(vis.reach.last30 ?? 0).toLocaleString('en-GB')} in the last ${vis.reach.windowDays} days · requests, not readers</div>
            </div>
            <div class="card">
              <h2>Shares · clicks</h2>
              <div class="metric">${vis.reach.shares} · ${vis.reach.clicks}</div>
              <div class="metric-sub">
                ${Object.keys(vis.reach.byChannel ?? {}).length > 0
                  ? Object.entries(vis.reach.byChannel).map(([channel, count]) => `${channel} ${count}`).join(' · ')
                  : 'no share-bar or call-to-action press reported yet'}
              </div>
            </div>
            <div class="card ${raw(covered < topics.length ? 'warn' : '')}">
              <h2>Topics covered</h2>
              <div class="metric ${raw(covered === topics.length ? 'good' : 'warn')}">${covered}/${topics.length}</div>
              <div class="metric-sub">
                ${configured.length} of ${channels.length} channels configured${configured.length > 0 ? `: ${configured.map((channel) => channel.label).join(', ')}` : ''}
              </div>
            </div>
          </section>`
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

      ${vis && vis.recommendations.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>What the agent recommends</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              Derived from the sweep, the reach and the record — no model, no invented figure. Each one names what it
              costs and offers the door that fixes it. It proposes; you press.
            </div>
            <div class="split-list">
              ${vis.recommendations.map(
                (item) => html`<div class="row" style="align-items:flex-start;gap:14px">
                  <span class="lbl" style="flex:1 1 0;min-width:0">
                    ${badge(item.priority.toLowerCase(), SEVERITY_TONE[item.priority] ?? 'info')} <b>${item.title}</b><br />
                    <span class="metric-sub">${item.detail}</span>
                  </span>
                  ${item.action
                    ? html`<span class="val"><button class="btn quiet sm" data-act="${item.action.command}" data-post="${item.action.postId ?? ''}">${item.action.label}</button></span>`
                    : ''}
                </div>`,
              )}
            </div>
          </div>`
        : ''}

      ${vis
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Platform SEO sweep ${badge(`${signal.score} / 100`, BAND_TONE[signal.band] ?? 'neutral')}</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              ${signal.summary} Every check reads the rendered site — the page heads, the sitemap it would serve, the
              image on disk — not a setting that says it is on. The weights say what costs traffic.
            </div>
            ${raw(
              table({
                headers: ['Check', 'Verdict', 'Weight', 'Detail'],
                align: ['', '', 'num', ''],
                rows: vis.sweep.map((finding) => [
                  html`<b>${finding.check}</b>`,
                  finding.ok ? badge('ok', 'ok') : badge('fix', 'bad'),
                  String(finding.weight),
                  finding.detail,
                ]),
              }),
            )}
          </div>`
        : ''}

      ${vis
        ? html`<div class="grid g-2-1" style="margin-bottom:14px">
            <div class="card">
              <h2>Distribution channels</h2>
              <div class="metric-sub" style="margin:8px 0 12px">
                A channel sends only when its credential is set on the server. Nothing here pretends: an unconfigured
                channel names the variable it is missing, and a send the network refused is on the record as refused.
                ${vis.generator.note}
              </div>
              ${raw(
                table({
                  headers: ['Channel', 'State', 'Sends to', 'To configure'],
                  rows: channels.map((channel) => [
                    html`<b>${channel.label}</b>`,
                    channel.configured ? badge('configured', 'ok') : badge('not configured', 'neutral'),
                    channel.target,
                    channel.missing.length > 0 ? html`<code>${channel.missing.join(', ')}</code>` : 'set',
                  ]),
                }),
              )}
            </div>
            <div class="card">
              <h2>Daily release</h2>
              <div class="metric-sub" style="margin:8px 0 12px">
                ${vis.releases.schedule.enabled
                  ? `Armed: runs at ${String(vis.releases.schedule.hourUtc).padStart(2, '0')}:00 UTC every day.`
                  : 'Timer not armed on this deployment (MARKETING_RELEASE_ENABLED). The button above runs it by hand, once per day.'}
              </div>
              ${vis.releases.today
                ? html`<div class="notice ${raw(vis.releases.today.published ? 'ok' : 'info')}" style="margin-bottom:10px">
                    <div>
                      <b>Today (${vis.releases.today.day}) — ran ${time(vis.releases.today.ranAt)} by ${vis.releases.today.trigger.toLowerCase()}.</b><br />
                      ${vis.releases.today.note}
                    </div>
                  </div>`
                : html`<div class="notice info" style="margin-bottom:10px"><div>Today's release has not run yet.</div></div>`}
              <div class="split-list">
                ${vis.releases.recent.map(
                  (release) => html`<div class="row" style="align-items:flex-start">
                    <span class="lbl" style="flex:1 1 0;min-width:0">
                      <b>${release.day}</b> · ${release.trigger.toLowerCase()}<br />
                      <span class="metric-sub">${release.note}</span>
                    </span>
                    <span class="val">${release.published ? badge('published', 'ok') : badge('nothing new', 'neutral')}</span>
                  </div>`,
                )}
              </div>
              ${vis.releases.recent.length === 0 ? html`<div class="metric-sub">No release has run yet.</div>` : ''}
            </div>
          </div>`
        : ''}

      ${vis
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Topic coverage ${badge(`${covered} of ${topics.length}`, covered === topics.length ? 'ok' : 'warn')}</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              The eight things a buyer searches for. A topic counts as covered when a <i>published</i> post carries its
              phrase — a draft is not on the internet. <b>Generate marketing library</b> writes one post for every topic
              that has none.
            </div>
            ${raw(
              table({
                headers: ['Topic', 'Found by', 'Filed under', 'State', 'Post'],
                rows: topics.map((topic) => [
                  html`<b>${topic.title}</b>`,
                  html`<code>${topic.keyword}</code>`,
                  topic.tag,
                  topic.covered ? badge('covered', 'ok') : topic.post ? badge(topic.post.status.toLowerCase(), 'info') : badge('uncovered', 'warn'),
                  topic.post ? html`<code>/blog/${topic.post.slug}</code>` : '—',
                ]),
              }),
            )}
          </div>`
        : ''}

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

      ${posts.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Posts</h2>
            <div class="metric-sub" style="margin:8px 0 12px">
              Every post on the record. Unpublish takes a live page down and keeps the record; Distribute sends a live
              post to the configured channels; the share kit is on each post below.
            </div>
            ${raw(
              table({
                headers: ['Title', 'State', 'Filed under', 'By', 'Score', 'Requests', 'Shares', 'Sent to', ''],
                align: ['', '', '', '', 'num', 'num', 'num', '', ''],
                rows: posts.map((post) => {
                  const extra = byPostId.get(post.id);
                  const sentTo = (extra?.distributions ?? []).filter((entry) => entry.status === 'SENT').map((entry) => entry.channel);
                  return [
                    html`<button class="btn quiet sm" data-jump="${post.id}" style="text-align:left"><b>${post.title || '(untitled)'}</b></button><br /><code>/blog/${post.slug}</code>`,
                    badge(String(post.status).toLowerCase(), STATUS_TONE[post.status] ?? 'neutral'),
                    post.tag,
                    AUTHOR_LABEL[post.authorship] ?? post.authorship,
                    String(post.score.score),
                    String(post.views ?? 0),
                    String(extra?.shares ?? 0),
                    sentTo.length > 0 ? sentTo.join(', ') : '—',
                    html`<span class="actions">
                      ${post.status === 'PUBLISHED'
                        ? html`<button class="btn quiet sm" data-distribute="${post.id}">Distribute</button>
                            <button class="btn quiet sm" data-withdraw="${post.id}">Unpublish</button>`
                        : ''}
                      ${post.status === 'DRAFT' && post.publishable ? html`<button class="btn quiet sm" data-publish="${post.id}">Publish</button>` : ''}
                    </span>`,
                  ];
                }),
              }),
            )}
          </div>`
        : ''}

      ${posts.map((post) => {
        const extra = byPostId.get(post.id);
        return html`
          <section class="card" id="post-${post.id}">
            <h3>
              ${post.title || '(untitled)'}
              ${badge(String(post.status).toLowerCase(), STATUS_TONE[post.status] ?? 'neutral')}
              ${badge(`score ${post.score.score}`, BAND_TONE[post.score.band] ?? 'neutral')}
              ${post.authorship === 'AI_DRAFTED'
                ? badge(`drafted by ${String(post.provider ?? 'a model').toLowerCase()}`, 'ai')
                : post.authorship === 'MARKETING_AGENT'
                  ? badge('composed by the marketing agent', 'ai')
                  : badge('written by a person', 'neutral')}
            </h3>
            <p class="metric-sub">
              <code>/blog/${post.slug}</code> ·
              ${post.status === 'PUBLISHED' ? `published ${time(post.publishedAt)}` : `drafted ${time(post.draftedAt)}`}
              ${post.status === 'PUBLISHED' ? ` · ${post.views} page request${post.views === 1 ? '' : 's'}` : ''}
              ${extra && post.status === 'PUBLISHED' ? ` · ${extra.shares} share${extra.shares === 1 ? '' : 's'} · ${extra.clicks} click${extra.clicks === 1 ? '' : 's'}` : ''}
              ${extra ? ` · ${extra.linked} link${extra.linked === 1 ? '' : 's'} into the site` : ''}
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

            ${extra && post.status === 'PUBLISHED'
              ? html`<details style="margin-top:10px">
                  <summary class="metric-sub"><b>Share kit</b> — what to paste where, per channel</summary>
                  ${raw(
                    table({
                      headers: ['Channel', 'Suggested text', 'Open'],
                      rows: extra.kit.map((entry) => [
                        html`<b>${entry.label}</b>`,
                        html`<span style="white-space:pre-wrap;font-size:12px">${entry.text}</span>`,
                        html`<a class="btn quiet sm" href="${entry.url}" target="_blank" rel="noreferrer">${entry.channel === 'copy' ? 'Address' : 'Composer'}</a>`,
                      ]),
                    }),
                  )}
                  ${extra.distributions.length > 0
                    ? html`<div class="metric-sub" style="margin-top:8px">
                        <b>Sent from here.</b>
                        ${extra.distributions.map(
                          (entry) => html`<div>
                            · ${entry.channel} ${badge(entry.status.toLowerCase(), entry.status === 'SENT' ? 'ok' : 'bad')} ${time(entry.at)} — ${entry.detail}
                          </div>`,
                        )}
                      </div>`
                    : html`<div class="metric-sub" style="margin-top:8px">Not sent from here to any channel yet.</div>`}
                </details>`
              : ''}

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
                    <button class="btn quiet" data-distribute="${post.id}">Distribute</button>
                    <button class="btn quiet" data-withdraw="${post.id}">Unpublish</button>`
                : ''}
            </div>
          </section>
        `;
      })}

      ${posts.length === 0
        ? html`<div class="empty">
            <b>Nothing has been drafted yet.</b>The ${position.fixed ?? 0} posts in the build are still on the site;
            this is where the next one gets written. They are not scored — they predate these checks and carry no
            keyword, and rewriting them as records would gain nothing and lose their history. Press
            <b>Generate marketing library</b> to cover every topic, or <b>${generatorLabel}</b> for one of your own.
          </div>`
        : ''}

      ${vis
        ? html`<div class="metric-sub" style="margin-top:14px">
            <b>What this screen is not.</b>
            ${vis.limits.map((limit) => html`<div>· ${limit}</div>`)}
          </div>`
        : ''}
    `,
  );

  const runCommand = async (id, postId) => {
    if (id === 'generate') {
      const result = await command(generatorSpec(vis));
      if (result) {
        reportCompose(result);
        await draw();
      }
      return;
    }
    if (id === 'library') {
      const result = await command(COMMANDS.library());
      if (result) {
        toast(
          'Library generated',
          `${result.created.length} post${result.created.length === 1 ? '' : 's'} composed, ${result.skipped.length} topic${result.skipped.length === 1 ? '' : 's'} already on the record.`,
          'ok',
        );
        await draw();
      }
      return;
    }
    if (id === 'release') {
      const result = await command(COMMANDS.release());
      if (result) {
        reportRelease(result);
        await draw();
      }
      return;
    }
    if (id === 'distribute') {
      await distribute(postId);
      return;
    }
    if (id === 'configure') {
      toast('Channels', 'Set the variables named under Distribution channels on the server and restart. Nothing is sent until then.', 'err');
      return;
    }
    const spec = COMMANDS[id]?.();
    if (spec && (await command(spec))) await draw();
  };

  const distribute = async (postId) => {
    if (!postId) return;
    if (configured.length === 0) {
      toast('No channel is configured', `Set ${channels.map((channel) => channel.missing.join(' and ')).join('; or ')} on the server first.`, 'err');
      return;
    }
    // Hoisted rather than interpolated inline, for the same reason the publish
    // door is: the console-forms invariant reads the literal path.
    const result = await command({
      title: 'Distribute this post',
      intent:
        'Sends the post to each channel you pick, using its own share text. A channel already sent to is skipped, and a ' +
        'refusal is recorded with the network’s own answer. Leave the list empty to send to every configured channel.',
      path: `/v1/site/posts/${postId}/distribute`,
      submitLabel: 'Send',
      fields: [
        {
          name: 'channels',
          label: 'Channels',
          type: 'multiselect',
          required: false,
          options: configured.map((channel) => ({ value: channel.id, label: `${channel.label} → ${channel.target}` })),
          hint: 'Only configured channels are offered.',
        },
      ],
      transform: ({ channels: chosen }) => (Array.isArray(chosen) && chosen.length > 0 ? { channels: chosen } : {}),
    });
    if (result) {
      const sent = result.sent?.length ?? 0;
      const failed = result.failed?.length ?? 0;
      toast(
        sent > 0 ? 'Sent' : failed > 0 ? 'Refused' : 'Nothing sent',
        `${sent} sent, ${failed} refused, ${result.skipped?.length ?? 0} skipped.${failed > 0 ? ` ${result.failed[0].detail}` : ''}`,
        failed > 0 && sent === 0 ? 'err' : 'ok',
      );
      await draw();
    }
  };

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

    await runCommand(button.dataset.command);
  });

  // A recommendation's own door: the same commands the bar offers, pressed
  // from the line that explains why.
  for (const button of root.querySelectorAll('[data-act]')) {
    button.addEventListener('click', () => void runCommand(button.getAttribute('data-act'), button.getAttribute('data-post') || undefined));
  }

  for (const button of root.querySelectorAll('[data-distribute]')) {
    button.addEventListener('click', () => void distribute(button.getAttribute('data-distribute')));
  }

  // From the table row to the post's own card. A button rather than a hash
  // link, because a hash in the address is something the app's router reads.
  for (const button of root.querySelectorAll('[data-jump]')) {
    button.addEventListener('click', () => {
      root.querySelector(`#post-${CSS.escape(button.getAttribute('data-jump'))}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

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
        title: 'Unpublish this post',
        intent: 'The URL stops answering and it leaves the sitemap. The record stays, because a page that was live is a thing that happened.',
        path: `/v1/site/posts/${postId}/withdraw`,
        submitLabel: 'Unpublish',
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
            hint: 'One paragraph per line. "## " starts a section heading, "> " a pull-quote.',
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
