import { api } from '../lib/api.js';
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

      <div class="card" id="site-media" style="margin-bottom:14px">
        <h2>Pictures on the landing page</h2>
        <div class="metric-sub" style="margin:8px 0 14px">
          Each slot says what it is for and what it has to show, because a picture chosen without knowing where it lands
          is a picture that has to be replaced. Export at the size given and compress; the ceiling is
          ${Math.round(media.maxBytes / 1_048_576)}MB per picture. PNG, JPEG or WebP — read from the file itself rather
          than from its name, so renaming something does not get it past.
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
                  <input type="file" accept="image/png,image/jpeg,image/webp" data-put="${slot.id}" style="display:none" />
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
