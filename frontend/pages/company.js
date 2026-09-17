import { api } from '../lib/api.js';
import { barChart, gauge, lineChart } from '../lib/charts.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, raw, render, table, time, toast } from '../lib/ui.js';

/**
 * The company profile — CONSTRUX's own, not a customer's.
 *
 * The public face of the platform, in the one place somebody would look for it:
 * the pictures on the landing page, the addresses mail goes out from, and what a
 * stranger sees at the front door.
 *
 * The picture slots are the substance of this screen. Five have existed on the
 * landing page since it was built, and until recently the only way to fill one
 * was to copy a file into the checkout and restart the process — which on a
 * deployed container means a rebuild. The company's own photographs could not be
 * put on the company's own website by the person whose photographs they are.
 *
 * An empty slot renders **nothing at all** on the public page, not an empty
 * frame, so a missing picture never looks like a broken site.
 */

export async function company(root) {
  const [media, ready, blog] = await Promise.all([
    api.get('/v1/site/media').catch((error) => ({ error })),
    api.get('/v1/admin/readiness').catch(() => null),
    api.get('/v1/site/posts').catch(() => null),
  ]);

  if (media.error) {
    render(root, html`${head({ title: 'Company profile' })}${refusal('The landing page media', media.error)}`);
    return;
  }

  const mailFrom = (ready?.variables ?? []).filter((entry) => /^(SMTP_FROM|NEWSLETTER_FROM|NOTIFICATIONS_FROM|PUBLIC_BASE_URL|PLATFORM_OPERATOR_EMAIL)/.test(entry.key));
  const filled = media.slots.filter((slot) => slot.held);

  render(
    root,
    html`
      ${head({
        title: 'Company profile',
        intent:
          'The platform’s own public face — the pictures on the landing page, where mail goes out from, and what a ' +
          'stranger sees before they sign up.',
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Landing pictures</h2>
          <div class="metric ${raw(filled.length === media.slots.length ? 'good' : 'warn')}">${filled.length} / ${media.slots.length}</div>
          <div class="metric-sub">slots filled · an empty one renders nothing at all</div>
        </div>
        <div class="card">
          <h2>Blog</h2>
          <div class="metric">${blog ? (blog.published ?? 0) + (blog.fixed ?? 0) : '—'}</div>
          <div class="metric-sub">${blog ? `${blog.drafts ?? 0} in draft` : 'the blog could not be read'}</div>
        </div>
        <div class="card">
          <h2>Public address</h2>
          <div class="metric" style="font-size:16px;word-break:break-all">${
            (ready?.variables ?? []).find((entry) => entry.key === 'PUBLIC_BASE_URL')?.value ?? 'not set'
          }</div>
          <div class="metric-sub">every link in every email is built from this</div>
        </div>
        <div class="card">
          <h2>Media store</h2>
          <div class="metric ${raw(String(media.directory).startsWith('/data') ? 'good' : 'warn')}" style="font-size:15px;word-break:break-all">${media.directory}</div>
          <div class="metric-sub">
            ${String(media.directory).startsWith('/data')
              ? 'on the volume, so an uploaded picture survives a redeploy'
              : 'not on the volume — a picture uploaded here is destroyed by the next rebuild'}
          </div>
        </div>
      </section>

      ${!String(media.directory).startsWith('/data')
        ? html`<div class="notice warn" style="margin-bottom:14px">
            <div>
              <b>Pictures uploaded now will not survive the next deploy.</b><br />
              <span class="mono">SITE_MEDIA_PATH</span> is not pointed at the volume, so uploads land in the container's
              own writable layer. Uploading works, the picture appears, and it is destroyed the next time the image is
              rebuilt — which is the worst kind of failure, because nothing reports it.
            </div>
          </div>`
        : ''}

      ${companyCharts(media, filled, blog)}

      <div class="card" id="site-media" style="margin-bottom:14px">
        <h2>Pictures on the landing page</h2>
        <div class="metric-sub" style="margin:8px 0 14px">
          Each slot says what it is for and what it has to show, because a picture chosen without knowing where it lands
          is a picture that has to be replaced. Export at the size given and compress; the ceiling is
          ${Math.round(media.maxBytes / 1_048_576)}MB per picture. ${media.accepts} — read from the file itself rather
          than from its name, so renaming something does not get it past. A photograph straight off an iPhone is
          HEIC, which no browser can display: shoot in "Most Compatible" or export it as JPEG first.
        </div>

        <div class="split-list">
          ${media.slots.map(
            (slot) => html`<div class="row" data-slot="${slot.id}" style="align-items:flex-start;gap:14px">
              <span class="lbl" style="flex:1 1 0;min-width:0">
                <b>${slot.where}</b><br />
                <span class="metric-sub">${slot.alt}</span><br />
                <span class="metric-sub">${slot.width}×${slot.height}px · ${
                  slot.held
                    ? `${slot.file} · ${Math.round((slot.bytes ?? 0) / 1024)}KB · replaced ${time(slot.updatedAt)}`
                    : 'nothing here yet'
                }</span>
              </span>
              <span class="val" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                ${slot.held ? badge('filled', 'ok') : badge('empty', 'warn')}
                <label class="btn quiet sm" style="cursor:pointer">
                  ${slot.held ? 'Replace' : 'Add picture'}
                  <input type="file" accept="${media.acceptTypes}" data-put="${slot.id}" style="display:none" />
                </label>
                ${slot.held ? html`<button class="btn quiet sm" data-clear="${slot.id}">Remove</button>` : ''}
              </span>
            </div>`,
          )}
        </div>

        <div class="cmd-error" hidden style="margin-top:12px"></div>
      </div>

      <div class="card">
        <h2>How the platform identifies itself</h2>
        <div class="metric-sub" style="margin:8px 0 14px">
          Set on the server, reported here. A mail address that is not set means the platform sends nothing — and a
          public base URL that is wrong means every link in every email points somewhere that does not exist, which
          nothing else on this console would tell you.
        </div>
        ${table({
          headers: ['Setting', 'State', 'Value'],
          rows: mailFrom.map((entry) => [
            html`<span class="mono" style="font-size:11px">${entry.key}</span>`,
            entry.present ? badge('set', 'ok') : badge('not set', 'neutral'),
            entry.present
              ? entry.secret
                ? html`<span class="metric-sub">hidden · ${entry.length} characters</span>`
                : html`<span class="mono" style="font-size:11px">${entry.value}</span>`
              : html`<span class="metric-sub">—</span>`,
          ]),
          empty: 'This build registers no public identity variables.',
        })}
      </div>
    `,
  );

  const panel = document.getElementById('site-media');
  const showError = (message) => {
    const box = panel?.querySelector('.cmd-error');
    if (!box) return;
    box.textContent = message;
    box.hidden = message === '';
  };

  for (const input of panel?.querySelectorAll('input[data-put]') ?? []) {
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      showError('');
      try {
        const result = await api.upload(`/v1/site/media/${encodeURIComponent(input.dataset.put)}`, file);
        toast('Picture set', `${result.file} · ${Math.round(result.bytes / 1024)}KB — live on the landing page now`, 'ok');
        await company(root);
      } catch (error) {
        // Named on the panel rather than only in a toast: the refusals here are
        // specific ("that is not a PNG, JPEG or WebP") and worth reading twice.
        showError(`${error.code ? `${error.code} — ` : ''}${error.message}`);
        input.value = '';
      }
    });
  }

  for (const button of panel?.querySelectorAll('[data-clear]') ?? []) {
    button.addEventListener('click', async () => {
      showError('');
      button.disabled = true;
      try {
        await api.delete(`/v1/site/media/${encodeURIComponent(button.dataset.clear)}`);
        toast('Picture removed', 'The slot renders nothing at all now, which is how the page is designed', 'ok');
        await company(root);
      } catch (error) {
        showError(`${error.code ? `${error.code} — ` : ''}${error.message}`);
        button.disabled = false;
      }
    });
  }
}

/**
 * The public face, measured.
 *
 * Two things here are counts of requests and are labelled as such everywhere
 * they appear, including on this chart. A view is one server-rendered request
 * for a post's page: a crawler counts, one person reading twice counts twice,
 * and nobody is identified because no cookie, address or fingerprint is
 * recorded. It is not a count of readers and the axis does not pretend it is.
 */
function companyCharts(media, filled, blog) {
  const slots = media?.slots ?? [];

  const daily = (blog?.views?.daily ?? []).map((entry) => ({
    label: String(entry.day ?? entry.date ?? '').slice(5),
    value: Number(entry.views ?? entry.count ?? 0),
  }));

  const bySlug = (blog?.views?.bySlug ?? [])
    .map((entry) => ({ label: String(entry.slug ?? '').slice(0, 40), value: Number(entry.views ?? entry.count ?? 0) }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  if (slots.length === 0 && daily.length === 0 && bySlug.length === 0) return '';

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>How much of the landing page has a picture</h2>
        ${raw(
          gauge({
            title: 'Slots filled',
            value: slots.length > 0 ? (filled.length / slots.length) * 100 : undefined,
            max: 100,
            format: (value) => `${Math.round(value)}%`,
            desc: `${filled.length} of ${slots.length} slots · an empty slot renders nothing at all rather than a placeholder`,
          }),
        )}
      </div>
      <div class="card">
        <h2>Requests for the blog, by day</h2>
        ${raw(
          lineChart({
            title: `Page requests over a ${blog?.views?.windowDays ?? 30}-day window`,
            data: daily,
            format: (value) => `${value} request${value === 1 ? '' : 's'}`,
            empty: 'No request for a post has been recorded.',
            footnote:
              'Server-rendered requests, one per request — a crawler counts and one person reading twice counts twice. ' +
              'Nobody is identified: the log holds a slug and a day. This is not a count of readers and is not labelled ' +
              'as one anywhere.',
          }),
        )}
      </div>
    </div>

    ${
      bySlug.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>Which posts are being asked for</h2>
            ${raw(
              barChart({
                title: 'Requests by post',
                horizontal: true,
                data: bySlug,
                format: (value) => `${value} request${value === 1 ? '' : 's'}`,
                empty: 'No post has been requested.',
                footnote:
                  `${blog?.views?.shares ?? 0} share${(blog?.views?.shares ?? 0) === 1 ? '' : 's'} and ` +
                  `${blog?.views?.clicks ?? 0} call-to-action press${(blog?.views?.clicks ?? 0) === 1 ? '' : 'es'} reported by the page’s script. ` +
                  'A reader with scripting off is not counted in either.',
              }),
            )}
          </div>`
        : ''
    }
  `;
}
