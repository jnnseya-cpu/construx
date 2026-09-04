import { api } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, date, html, initials, notice, positionReport, raw, render, table, toast } from '../lib/ui.js';

/**
 * Account — and the one control on it that cannot be undone.
 *
 * The Apple and Google stores require an in-app route to account deletion, and
 * this is the same route on the web: a person should not have to install an app
 * to leave. It sits outside the capability matrix for the same reason — asking
 * to be erased is not a permission somebody else grants you.
 *
 * The screen's real job is to tell the truth about what erasure does here.
 * "Delete my account" on most products means the data is gone. On this one the
 * project record stays, because retaining it is a legal obligation and because
 * an adjudication three years from now is decided on what it says. Saying so
 * before the button is pressed is the difference between a lawful basis and a
 * complaint. So the wording is read from `GET /v1/me/erasure` rather than
 * written into this file: what the person is told has to be what the platform
 * will actually do, and the only way to guarantee that is to read it from the
 * code that does it.
 */

export async function account(root) {
  const erasure = await api.get('/v1/me/erasure');
  // Your own notifications, and which of them you may switch off. Both had
  // engines and no screen — a platform that sends notices nobody can read back
  // or turn off is one people learn to ignore.
  const [inbox, preferences] = await Promise.all([
    api.get('/v1/notifications/inbox').catch((error) => ({ error })),
    api.get('/v1/notifications/preferences').catch((error) => ({ error })),
  ]);
  // From the endpoint, not the session: the session payload carries no address,
  // and a confirmation screen for an irreversible act has to name the account.
  const user = erasure.identity;
  const outstanding = Boolean(erasure.requestedAt) && !erasure.erasedAt;

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Account</h1>
          <p>${user.name ?? ''} · ${user.email ?? ''}</p>
        </div>
      </div>

      ${
        outstanding
          ? html`<div class="card" style="margin-bottom:14px">
              <h2>Erasure requested ${badge('PENDING', 'warn')}</h2>
              ${notice(
                `This account is scheduled to be erased on ${date(erasure.dueAt)}. ` +
                  'It has already been suspended. Until that date you can still stop it.',
                'warn',
              )}
              <div class="actions" style="margin-top:13px">
                <button class="btn" data-cancel-erasure>Cancel the request</button>
              </div>
            </div>`
          : ''
      }

      <div class="card" style="margin-bottom:14px">
        <h2>Identity</h2>
        ${table({
          headers: ['Field', 'Value'],
          rows: [
            ['Name', user.name],
            ['Email', user.email],
            ['Roles', user.roles.join(', ')],
          ],
          empty: 'No identity on this session',
        })}
      </div>

      <div class="card">
        <h2>Delete this account</h2>
        <p style="font-size:13px;color:var(--text-2);margin:2px 0 13px">
          Your account is suspended immediately and erased
          ${erasure.graceDays} days later. During those ${erasure.graceDays} days you can cancel it.
          Once erased it cannot be restored.
        </p>

        <div class="grid g2" style="margin-bottom:13px">
          <div>
            ${table({
              headers: ['Erased'],
              rows: erasure.removed.map((item) => [item]),
              empty: 'Nothing listed',
            })}
          </div>
          <div>
            ${table({
              headers: ['Kept'],
              rows: erasure.retained.map((item) => [item]),
              empty: 'Nothing listed',
            })}
          </div>
        </div>

        ${notice(erasure.lawfulBasis, 'info')}

        <div class="actions" style="margin-top:13px">
          <button class="btn danger" data-request-erasure ${raw(outstanding ? 'disabled' : '')}>
            Delete my account
          </button>
        </div>
      </div>

      <div class="card">
        <h2>Your cover image</h2>
        <div class="metric-sub" style="margin-bottom:10px">
          The banner across the top of your own page. Decoration rather than identification — which is exactly why it
          is a separate image from the picture below: a face cropped square onto a record is not the same thing as a
          wide photograph of a site, and one field serving both gives a stretched face and a squashed landscape.
        </div>
        <div class="account-cover ${raw(user?.coverHash ? 'has-image' : '')}">
          ${user?.coverHash ? html`<img data-authed-src="/v1/users/${user.id}/cover" alt="" />` : html`<span>No cover image yet</span>`}
        </div>
        <div style="margin-top:11px">
          <input type="file" accept="image/png,image/jpeg,image/webp" data-cover style="display:none" />
          <button class="btn quiet" data-choose-cover>${user?.coverHash ? 'Replace it' : 'Choose a cover image'}</button>
          <div class="metric-sub" style="margin-top:6px">
            Same rules as the picture: PNG, JPEG or WebP, the type read from the file itself, and an SVG refused.
          </div>
        </div>
      </div>

      <div class="card">
        <h2>Your account picture</h2>
        <div class="metric-sub" style="margin-bottom:10px">
          It appears beside your name wherever the platform names you — on a permit you issued, on an induction
          you ran. Yours to set and nobody else's: an administrator cannot put a face on a record somebody else made.
        </div>
        <div class="row" style="display:flex;gap:14px;align-items:center">
          <span class="avatar lg">${
            user?.pictureHash
              ? html`<img data-authed-src="/v1/users/${user.id}/picture" alt="" width="56" height="56" />`
              : initials(user?.name)
          }</span>
          <div>
            <input type="file" accept="image/png,image/jpeg,image/webp" data-picture style="display:none" />
            <button class="btn quiet" data-choose-picture>
              ${user?.pictureHash ? 'Replace it' : 'Choose a picture'}
            </button>
            <div class="metric-sub" style="margin-top:6px">
              PNG, JPEG or WebP. The type is read from the file itself rather than from what it claims, and an SVG
              is refused — it is a document that can carry script, and this is served from the platform's own origin.
            </div>
          </div>
        </div>
      </div>

      ${positionReport({
        title: 'Your notifications',
        intent: 'What the platform has sent you, readable back rather than only arriving.',
        data: inbox,
        error: inbox?.error,
        sections: [{ key: 'messages', label: 'Messages', empty: 'Nothing has been sent to you.' }],
      })}

      ${positionReport({
        title: 'What you may switch off',
        intent:
          'Some notices are switchable and some are not. A notice about your own account being changed is not ' +
          'somebody else\u2019s to silence, and the matrix says which is which rather than leaving you to find out.',
        data: preferences,
        error: preferences?.error,
        sections: [{ key: 'matrix', label: 'By category', empty: 'No notification category is published.' }],
      })}
    `,
  );

  // The picture and the cover are behind the gateway, which an <img> cannot
  // authenticate to on its own.
  void api.hydrateImages(root);

  root.querySelector('[data-choose-picture]')?.addEventListener('click', () => {
    root.querySelector('[data-picture]')?.click();
  });

  root.querySelector('[data-picture]')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      // `api.upload` posts the bytes themselves rather than a multipart form —
      // the same path the landing pictures take. The platform reads the type
      // from the file's own magic bytes, so a declared content type is
      // something it deliberately ignores.
      await api.upload('/v1/me/picture', file);
      toast('Picture set', 'It appears beside your name from now on.', 'ok');
      // The shell redraws the header chip from this.
      document.dispatchEvent(new CustomEvent('identity-changed'));
    } catch (error) {
      toast('That picture was refused', error.message, 'err');
    }
  });

  root.querySelector('[data-choose-cover]')?.addEventListener('click', () => {
    root.querySelector('[data-cover]')?.click();
  });

  root.querySelector('[data-cover]')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      await api.upload('/v1/me/cover', file);
      toast('Cover set', 'It appears across the top of your account page.', 'ok');
      document.dispatchEvent(new CustomEvent('identity-changed'));
    } catch (error) {
      toast('That image was refused', error.message, 'err');
    }
  });

  root.querySelector('[data-request-erasure]')?.addEventListener('click', async () => {
    const result = await command({
      title: 'Delete this account',
      intent:
        `Your account is suspended now and erased in ${erasure.graceDays} days. ` +
        'The project record is kept — see the screen behind this panel for what that means.',
      path: '/v1/me/erasure',
      submitLabel: 'Request erasure',
      fields: [
        {
          name: 'reason',
          label: 'Why are you leaving?',
          type: 'textarea',
          rows: 2,
          hint: 'Recorded against the request. It is not used to talk you out of it.',
        },
      ],
    });

    if (result) {
      toast('Erasure requested', `This account will be erased on ${date(result.dueAt)}.`, 'warn');
      await account(root);
    }
  });

  root.querySelector('[data-cancel-erasure]')?.addEventListener('click', async () => {
    await api.delete('/v1/me/erasure');
    toast('Request cancelled', 'The account is active again.', 'ok');
    await account(root);
  });
}
