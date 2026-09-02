import { api, session } from '../lib/api.js';
import { command } from '../lib/command.js';
import { badge, date, html, notice, raw, render, table, time, toast } from '../lib/ui.js';
import { barChart, donutChart, gauge, kpiCard, lineChart, proportionBar, treemap } from '../lib/charts.js';

/**
 * Security — a person's own credentials, and, for an administrator, everybody's.
 *
 * The screen exists because three controls were built and none of them was
 * reachable: a device register nobody could enrol into, passkeys nobody could
 * register, and a risk model that decided when to interrupt somebody without
 * ever showing them why. A control a person cannot see is one they experience
 * as the platform being arbitrary.
 *
 * Two things it does that a settings page usually does not:
 *
 * **It shows the working.** The risk model's weights, bands and every signal
 * counted against this session are published on the page, so "verify again" is
 * a sentence with a reason attached rather than a demand.
 *
 * **It shows the secret exactly once.** Enrolment returns a device secret the
 * server keeps only a digest of. There is no route that could return it a
 * second time, so the screen says so plainly at the moment it is shown rather
 * than letting somebody close the panel and go looking.
 */

/** Which half of the page is open. Module-level, so a re-render keeps the tab. */
let chosenTab = 'mine';

const TONE = { STRONG: 'ok', ADEQUATE: 'warn', WEAK: 'bad' };
const BAND_TONE = { LOW: 'ok', ELEVATED: 'warn', HIGH: 'bad' };

export async function security(root) {
  // The tenancy-wide view is asked for only where the session holds a role that
  // could be granted it. The route is the authority either way — this is not a
  // client-side permission check — but probing it for everybody put a 403 in
  // every non-administrator's console on every load, which is noise that
  // teaches people to ignore the console.
  const administers = (session.get()?.user?.roles ?? []).some((role) =>
    ['ENTERPRISE_ADMIN', 'PLATFORM_ADMIN', 'OWNER'].includes(role),
  );
  const [mine, tenancy, protection] = await Promise.all([
    api.get('/v1/me/security'),
    administers ? api.get('/v1/admin/credentials').catch((error) => ({ error })) : Promise.resolve({ error: 'not asked' }),
    administers
      ? api.get('/v1/admin/data-protection').catch((error) => ({ error }))
      : Promise.resolve({ error: 'not asked' }),
  ]);

  const mayAdminister = !tenancy.error;
  if (!mayAdminister) chosenTab = 'mine';

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Security</h1>
          <p>${mine.statement}</p>
        </div>
        <div class="actions">
          ${mayAdminister
            ? html`<button class="btn ${raw(chosenTab === 'mine' ? '' : 'ghost')}" data-tab="mine">My credentials</button>
                <button class="btn ${raw(chosenTab === 'tenancy' ? '' : 'ghost')}" data-tab="tenancy">Across the company</button>
                <button class="btn ${raw(chosenTab === 'protection' ? '' : 'ghost')}" data-tab="protection">Data protection</button>`
            : ''}
        </div>
      </div>

      ${chosenTab === 'mine' ? mineView(mine) : chosenTab === 'protection' ? protectionView(protection) : tenancyView(tenancy)}
    `,
  );

  for (const button of root.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => {
      chosenTab = button.dataset.tab;
      security(root);
    });
  }

  root.querySelector('[data-enrol]')?.addEventListener('click', () =>
    command({
      title: 'Enrol this device',
      intent:
        'Binds this session to this machine. A copy of the token stops working anywhere else, and revoking the device ends every session on it.',
      method: 'POST',
      path: '/v1/me/devices',
      fields: [
        { name: 'label', label: 'What do you call this machine?', required: true, placeholder: 'Site tablet' },
        {
          name: 'platform',
          label: 'Kind',
          type: 'select',
          options: ['BROWSER', 'MOBILE', 'TABLET', 'DESKTOP', 'UNKNOWN'],
        },
      ],
      onDone: (result) => {
        // Shown once, said plainly. The server holds only a digest of this.
        toast(
          'Device enrolled — copy the secret now',
          `${result.deviceSecret}\n\nThis is the only time it is shown. ${result.howToUse}`,
          'ok',
        );
        security(root);
      },
    }),
  );

  for (const button of root.querySelectorAll('[data-revoke-device]')) {
    button.addEventListener('click', () =>
      command({
        title: `Revoke ${button.dataset.label}`,
        intent: 'Every session on this device stops working on its next request. This cannot be undone; the device would have to be enrolled again.',
        method: 'POST',
        path: `/v1/me/devices/${button.dataset.revokeDevice}/revoke`,
        fields: [{ name: 'reason', label: 'Why?', required: true, placeholder: 'Left on a train' }],
        onDone: () => security(root),
      }),
    );
  }

  for (const button of root.querySelectorAll('[data-revoke-passkey]')) {
    button.addEventListener('click', () =>
      command({
        title: `Revoke ${button.dataset.label}`,
        intent: 'This passkey stops signing in. The authenticator keeps its copy; the platform stops accepting it.',
        method: 'POST',
        path: `/v1/me/passkeys/${button.dataset.revokePasskey}/revoke`,
        fields: [],
        onDone: () => security(root),
      }),
    );
  }

  root.querySelector('[data-passkey]')?.addEventListener('click', () => addPasskey(root));
}

// --- A person's own posture --------------------------------------------------

function mineView(mine) {
  const active = mine.devices.filter((device) => device.status === 'ACTIVE');
  const assessment = mine.session;

  return html`
    <div class="grid-4" style="margin-bottom:14px">
      ${kpiCard({
        label: 'Account strength',
        value: mine.standing,
        sub: mine.advice.length === 0 ? 'Nothing outstanding' : `${mine.advice.length} thing${mine.advice.length === 1 ? '' : 's'} would improve it`,
        tone: TONE[mine.standing] === 'ok' ? 'good' : TONE[mine.standing],
      })}
      ${kpiCard({
        label: 'Passkeys',
        value: String(mine.passkeys.length),
        sub: mine.passkeys.length === 0 ? 'Protected by an emailed code alone' : 'Cannot be phished or read out',
        tone: mine.passkeys.length > 0 ? 'good' : 'warn',
      })}
      ${kpiCard({
        label: 'Enrolled devices',
        value: String(active.length),
        sub: `${mine.devices.length - active.length} revoked`,
        tone: active.length > 0 ? 'good' : 'warn',
        spark: mine.activity.map((day) => day.sightings),
      })}
      ${gauge({
        value: assessment.score,
        max: 100,
        target: mine.model.bands.HIGH,
        title: 'This session’s risk',
        label: `${assessment.band} · verify again at ${mine.model.bands.HIGH}`,
        format: (value) => String(Math.round(value)),
        tone: BAND_TONE[assessment.band],
      })}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h2>This session ${badge(assessment.band, BAND_TONE[assessment.band])}${assessment.steppedUp ? badge('VERIFIED AGAIN', 'ok') : ''}</h2>
      ${notice(assessment.statement, BAND_TONE[assessment.band] === 'ok' ? 'info' : BAND_TONE[assessment.band])}
      ${
        assessment.signals.length === 0
          ? html`<p class="muted" style="margin-top:12px">Nothing was counted against this session.</p>`
          : html`<div style="margin-top:13px">
              ${barChart({
                data: assessment.signals.map((signal) => ({ label: humanSignal(signal.signal), value: signal.points })),
                horizontal: true,
                title: 'What was counted against this session',
                format: (value) => `${value} pts`,
              })}
              ${table({
                headers: ['Signal', 'Points', 'Why'],
                rows: assessment.signals.map((signal) => [humanSignal(signal.signal), String(signal.points), signal.because]),
                align: ['', 'num', ''],
              })}
            </div>`
      }
      <p class="chart-foot">
        A step-up is a fresh verification, not a lock: it holds for ${mine.model.windowMinutes} minutes and nobody has to
        clear it for you. Bands begin at ${mine.model.bands.ELEVATED} and ${mine.model.bands.HIGH}, and no single signal
        reaches the second on its own.
      </p>
    </div>

    ${
      mine.advice.length > 0
        ? html`<div class="card" style="margin-bottom:14px">
            <h2>What would make this stronger</h2>
            ${table({
              headers: ['Do this', 'Because'],
              rows: mine.advice.map((entry) => [html`<b>${entry.action}</b>`, entry.because]),
            })}
          </div>`
        : ''
    }

    <div class="chart-row wide" style="margin-bottom:14px">
      <div class="card">
        <h2>Passkeys</h2>
        <p class="muted">
          A passkey is held by this machine and signs a challenge this server issued. It cannot be read out over the
          phone, and it will not sign on a lookalike domain — the origin is part of what gets signed.
        </p>
        ${table({
          headers: ['Name', 'Kind', 'Added', 'Last used', ''],
          empty: 'No passkeys yet',
          emptyDetail: 'A passkey is added from this machine, and takes about ten seconds.',
          rows: mine.passkeys.map((passkey) => [
            passkey.label,
            html`${badge(passkey.algorithm, 'info')}${passkey.userVerified ? badge('BIOMETRIC', 'ok') : ''}`,
            date(passkey.createdAt),
            passkey.lastUsedAt ? date(passkey.lastUsedAt) : '—',
            html`<button class="btn ghost sm" data-revoke-passkey="${passkey.id}" data-label="${passkey.label}">Revoke</button>`,
          ]),
        })}
        <div class="actions" style="margin-top:13px"><button class="btn" data-passkey>Add a passkey</button></div>
      </div>

      <div class="card">
        <h2>Devices</h2>
        <p class="muted">
          A bound session carries a proof computed from a secret that never travels in the same header the token does, so
          a token on its own is not enough. Revoking a device ends every session on it.
        </p>
        ${
          mine.byPlatform.length > 0
            ? donutChart({ data: mine.byPlatform, title: 'Enrolled devices by kind', format: (value) => String(value) })
            : ''
        }
        ${table({
          headers: ['Device', 'Kind', 'Enrolled', 'Last seen', 'Networks', ''],
          empty: 'No devices enrolled',
          emptyDetail: 'Until one is, a copy of this session’s token works from anywhere.',
          rows: mine.devices.map((device) => [
            html`${device.label}${device.status === 'REVOKED' ? badge('REVOKED', 'bad') : ''}`,
            device.platform,
            date(device.enrolledAt),
            device.lastSeenAt ? time(device.lastSeenAt) : html`<span class="muted">never used</span>`,
            String(device.networks.length),
            device.status === 'ACTIVE'
              ? html`<button class="btn ghost sm" data-revoke-device="${device.id}" data-label="${device.label}">Revoke</button>`
              : html`<span class="muted">${device.revokedReason ?? ''}</span>`,
          ]),
        })}
        <div class="actions" style="margin-top:13px"><button class="btn" data-enrol>Enrol this device</button></div>
      </div>
    </div>

    <div class="card">
      <h2>The risk model, in full</h2>
      <p class="muted">
        Published rather than described. A rule a person can only learn by tripping over it is a rule they experience as
        the platform being arbitrary — and every one of these is arithmetic over records this platform already holds, so
        the same facts always produce the same answer.
      </p>
      ${barChart({
        data: mine.model.signals.map((signal) => ({ label: humanSignal(signal.signal), value: signal.points })),
        horizontal: true,
        title: 'Every signal and what it is worth',
        format: (value) => `${value} pts`,
      })}
      ${table({
        headers: ['Signal', 'Points', 'What it means'],
        rows: mine.model.signals.map((signal) => [humanSignal(signal.signal), String(signal.points), signal.meaning]),
        align: ['', 'num', ''],
      })}
    </div>
  `;
}

const SIGNAL_NAMES = {
  UNBOUND_SESSION: 'Session not bound to a device',
  UNKNOWN_NETWORK: 'New network for this device',
  RECENT_FAILURES: 'Recent failed verifications',
  STALE_AUTHENTICATION: 'Sign-in is getting old',
  DEVICE_FIRST_USE: 'Device never used before',
  HIGH_VALUE: 'Commits real money',
  IRREVERSIBLE: 'Cannot be undone',
  GOVERNANCE: 'Changes who may do what',
  MACHINE_CREDENTIAL: 'An API key is acting',
};

const humanSignal = (signal) => SIGNAL_NAMES[signal] ?? signal;

// --- The tenancy's posture ---------------------------------------------------

function tenancyView(tenancy) {
  const { adoption } = tenancy;
  const covered = adoption.people - adoption.withNeither;

  return html`
    <div class="grid-4" style="margin-bottom:14px">
      ${kpiCard({
        label: 'People with a passkey',
        value: `${adoption.withPasskey} of ${adoption.people}`,
        sub: 'Cannot be phished',
        tone: adoption.withPasskey === adoption.people ? 'good' : 'warn',
      })}
      ${kpiCard({
        label: 'People with a device',
        value: `${adoption.withDevice} of ${adoption.people}`,
        sub: 'Sessions that stop working if copied',
        tone: adoption.withDevice === adoption.people ? 'good' : 'warn',
      })}
      ${kpiCard({
        label: 'Code alone',
        value: String(adoption.withNeither),
        sub: 'Protected by an emailed one-time code and nothing else',
        tone: adoption.withNeither === 0 ? 'good' : 'bad',
      })}
      ${gauge({
        value: adoption.people === 0 ? 0 : Math.round((covered / adoption.people) * 100),
        target: 100,
        title: 'Coverage',
        label: `${covered} of ${adoption.people} hold something stronger than a code`,
      })}
    </div>

    <div class="card" style="margin-bottom:14px">
      <h2>Where this tenancy stands</h2>
      ${notice(tenancy.summary, adoption.withNeither === 0 ? 'ok' : 'warn')}
      ${proportionBar({
        parts: [
          { label: 'Passkey and device', value: Math.min(adoption.withPasskey, adoption.withDevice), tone: 'ok' },
          { label: 'One or the other', value: Math.abs(adoption.withPasskey - adoption.withDevice), tone: 'warn' },
          { label: 'Code alone', value: adoption.withNeither, tone: 'bad' },
        ],
        format: (value) => `${value} people`,
      })}
      ${
        tenancy.bindingRequired
          ? ''
          : html`<p class="chart-foot">
              Device binding is not required on this deployment, so a session with no device is scored rather than
              refused. Requiring it signs out everybody who has not enrolled, which is why it is a switch and not a
              default.
            </p>`
      }
    </div>

    <div class="chart-row wide" style="margin-bottom:14px">
      <div class="card">
        <h2>Roll-out</h2>
        ${lineChart({
          data: tenancy.enrolment,
          series: [
            { key: 'devices', label: 'Devices enrolled' },
            { key: 'passkeys', label: 'Passkeys added' },
          ],
          title: 'Enrolments over the last thirty days',
          format: (value) => String(value),
          empty: 'Nothing has been enrolled in the last thirty days',
        })}
      </div>
      <div class="card">
        <h2>When devices were last used</h2>
        ${barChart({
          data: tenancy.freshness,
          title: 'Devices by last use',
          format: (value) => String(value),
          empty: 'No devices enrolled yet',
          footnote:
            'Buckets rather than an average. "Average 41 days since last use" hides the twelve machines nobody has touched since March.',
        })}
      </div>
    </div>

    <div class="chart-row wide" style="margin-bottom:14px">
      <div class="card">
        <h2>Devices by kind</h2>
        ${treemap({
          items: tenancy.byPlatform,
          title: 'Enrolled devices by kind',
          format: (value) => String(value),
          empty: 'No devices enrolled yet',
        })}
      </div>
      <div class="card">
        <h2>Revoked</h2>
        <p class="muted">Every session on these ended the moment they were revoked. Kept, because why a device was revoked is the useful part.</p>
        ${table({
          headers: ['Device', 'Revoked', 'Why'],
          empty: 'Nothing has been revoked',
        emptyDetail: 'Every device enrolled on this tenancy is still live.',
          rows: tenancy.revoked.map((device) => [device.label, date(device.revokedAt), device.revokedReason ?? '—']),
        })}
      </div>
    </div>

    <div class="card">
      <h2>Everybody’s credentials</h2>
      ${table({
        headers: ['Device', 'Kind', 'Enrolled', 'Last seen', 'Status'],
        empty: 'Nobody has enrolled a device yet',
        emptyDetail: 'Every session on this tenancy is currently unbound, and is scored accordingly.',
        rows: tenancy.devices.map((device) => [
          device.label,
          device.platform,
          date(device.enrolledAt),
          device.lastSeenAt ? date(device.lastSeenAt) : html`<span class="muted">never used</span>`,
          badge(device.status, device.status === 'ACTIVE' ? 'ok' : 'bad'),
        ]),
      })}
    </div>
  `;
}

// --- The WebAuthn ceremony ---------------------------------------------------

/**
 * Register a passkey, in the browser.
 *
 * The one piece of this platform that has to touch a browser API the server
 * cannot stand in for. It is written defensively for a reason: `navigator
 * .credentials` is absent on http origins other than localhost, absent in some
 * embedded browsers, and rejects for half a dozen reasons that all arrive as the
 * same exception. Every one of those needs a sentence, because "registration
 * failed" on a security feature is how people conclude the feature is broken and
 * stop trying.
 */
async function addPasskey(root) {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    toast(
      'This browser cannot hold a passkey',
      'Passkeys need a secure origin (https, or localhost) and a browser with WebAuthn. Everything else on this page still works.',
      'warn',
    );
    return;
  }

  const label = window.prompt('What do you call this key? ("MacBook Touch ID", "YubiKey on my keyring")');
  if (!label) return;

  try {
    const options = await api.post('/v1/me/passkeys/register/begin', {});
    const credential = await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: fromBase64Url(options.challenge),
        user: { ...options.user, id: fromBase64Url(options.user.id) },
        excludeCredentials: options.excludeCredentials.map((entry) => ({ ...entry, id: fromBase64Url(entry.id) })),
      },
    });
    if (!credential) {
      toast('Nothing was registered', 'The browser returned no credential. Nothing has changed.', 'warn');
      return;
    }

    await api.post('/v1/me/passkeys/register/complete', {
      label,
      credentialId: toBase64Url(credential.rawId),
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      attestationObject: toBase64Url(credential.response.attestationObject),
    });
    toast('Passkey added', `"${label}" can now sign you in without a code.`, 'ok');
    security(root);
  } catch (error) {
    // The browser's own refusals, named. `NotAllowedError` is what both a
    // cancellation and a timeout produce, and telling somebody their key failed
    // when they simply pressed Escape is how a feature gets a reputation.
    const named =
      error?.name === 'NotAllowedError'
        ? 'The request was cancelled or timed out. Nothing has changed.'
        : error?.name === 'InvalidStateError'
          ? 'This authenticator already holds a passkey for this account.'
          : error?.name === 'SecurityError'
            ? 'The browser refused because this page is not on a secure origin it recognises.'
            : (error?.problem?.detail ?? error?.message ?? 'The browser refused the request.');
    toast('Passkey not added', named, 'bad');
  }
}

const fromBase64Url = (value) =>
  Uint8Array.from(atob(String(value).replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));

const toBase64Url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const _internals = { humanSignal, fromBase64Url, toBase64Url };

/**
 * What protects customer data at rest and in flight.
 *
 * This is the screen an enterprise admin opens with a client's security
 * questionnaire beside them, so it is written to be read out rather than
 * interpreted: what is protected, what is explicitly not, and what an operator
 * still has to do about it.
 *
 * Two decisions shape it.
 *
 * **The non-claims are as prominent as the claims.** "Encrypted at rest: yes"
 * is the answer every product gives and tells a security team nothing. What
 * this control does *not* do — protect a live process, survive a stolen master
 * key, hide file sizes — sits in the same card at the same weight, because a
 * customer who discovers a limit later treats every other claim as suspect.
 *
 * **Nothing is inferred.** The transport section reports what this process can
 * actually see and names what it cannot. A page that printed "TLS: enabled"
 * from a certificate path in a variable would be worse than one that said
 * nothing, because somebody would believe it.
 */
function protectionView(protection) {
  if (protection.error) {
    return notice(
      'This part of the page needs enterprise administrator access, which this identity does not hold.',
      'warn',
    );
  }

  const rest = protection.atRest;
  const flight = protection.inFlight;
  const findings = flight.findings ?? [];
  const severityTone = { CRITICAL: 'bad', WARNING: 'warn', NOTE: 'info' };

  // Severity counts, so the shape of the transport position reads before any of
  // it is read word by word.
  const counts = ['CRITICAL', 'WARNING', 'NOTE'].map((severity) => ({
    label: severity,
    value: findings.filter((finding) => finding.severity === severity).length,
  }));

  return html`
    <div class="chart-row">
      ${kpiCard({
        label: 'Overall standing',
        value: protection.standing,
        detail: protection.standing === 'ADEQUATE' ? 'Both legs in place' : 'A leg is missing or failing',
        tone: protection.standing === 'ADEQUATE' ? 'ok' : 'bad',
      })}
      ${kpiCard({
        label: 'Evidence at rest',
        value: rest.enabled ? rest.cipher : 'Not encrypted',
        detail: rest.enabled ? `Key version ${rest.keyVersion}, from ${rest.keySource.toLowerCase()}` : 'No master key configured',
        tone: rest.enabled ? 'ok' : 'bad',
      })}
      ${gauge({
        label: 'Transport findings',
        value: findings.filter((finding) => finding.severity === 'CRITICAL').length,
        max: Math.max(3, findings.length),
        target: 0,
        caption: flight.summary,
      })}
    </div>

    <section class="card">
      <h2>Evidence at rest</h2>
      <p class="muted">${rest.enabled
        ? 'Every file written to the evidence store is encrypted before it reaches the disk or the bucket.'
        : 'Evidence is written in clear. A stolen volume is a readable archive.'}</p>

      <h3>What this protects against</h3>
      ${rest.protects.length
        ? html`<ul>${raw(rest.protects.map((claim) => `<li>${escapeText(claim)}</li>`).join(''))}</ul>`
        : notice('Nothing, while no master key is configured.', 'bad')}

      <h3>What it does not</h3>
      <ul>${raw(rest.doesNotProtect.map((limit) => `<li>${escapeText(limit)}</li>`).join(''))}</ul>

      ${rest.actions.length
        ? html`${rest.actions.map((action) => notice(action, 'bad'))}`
        : ''}
    </section>

    <section class="card">
      <h2>In flight</h2>
      <p class="muted">${flight.summary}</p>

      ${barChart({
        title: 'Findings by severity',
        data: counts,
        valueKey: 'value',
        labelKey: 'label',
      })}

      ${table({
        headers: ['Severity', 'Finding', 'Why it matters', 'What to do'],
        rows: findings.map((finding) => [
          badge(finding.severity, severityTone[finding.severity] ?? 'info'),
          finding.finding,
          finding.because,
          finding.action,
        ]),
        empty: 'Nothing outstanding on transport.',
        emptyDetail: 'The public address is https, HSTS is sent, cookies are Secure and TLS termination is declared.',
      })}

      <h3>What this platform cannot see from inside itself</h3>
      <ul>${raw(flight.notVisibleFromHere.map((limit) => `<li>${escapeText(limit)}</li>`).join(''))}</ul>
    </section>

    <section class="card">
      <h2>Documents that have left the platform</h2>
      <p class="muted">
        Every exported document carries a verification code. Anyone holding the document — a client's solicitor, an
        adjudicator, an insurer — can check it at
        <code>${protection.exportVerification.page}</code> without an account.
      </p>

      <h3>What a check establishes</h3>
      <ul>${raw(protection.exportVerification.proves.map((claim) => `<li>${escapeText(claim)}</li>`).join(''))}</ul>

      <h3>What it does not</h3>
      <ul>${raw(protection.exportVerification.doesNotProve.map((limit) => `<li>${escapeText(limit)}</li>`).join(''))}</ul>
    </section>
  `;
}

/** Text into an HTML-safe string, for the list items built as raw markup. */
function escapeText(value) {
  return String(value).replace(/[&<>"]/g, (character) => `&#${character.charCodeAt(0)};`);
}
