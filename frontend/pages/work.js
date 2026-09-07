import { api } from '../lib/api.js';
import { command, commandBar } from '../lib/command.js';
import { badge, date, html, humanise, notice, raw, render, statusTone, table } from '../lib/ui.js';
import { draw, state } from '../app.js';

/**
 * The field module workspace.
 *
 * Four stages run work in the field — tender, construction, commissioning and
 * handover — and §9.1, §10.1, §11.1 and §12.1 give each of them the same
 * screen: a header carrying stage and site context, the pack the device is
 * holding and the shift somebody is on; a strip of home indicators checked
 * before walking out; and six tabs over the module's own records.
 *
 * It is one screen with a module picker rather than four screens, because four
 * copies of the same shell drift apart within a release and the fourth one is
 * always the one nobody updates. The server agrees: `GET /work/{module}` and
 * `GET /work/{module}/{tab}` are the same two routes for every module, and the
 * module supplies its own record types.
 *
 * **This is not a second Field Execution screen.** That screen is the
 * construction site's register — permits, diaries, plant, observations, the
 * things a site manager does today. This is the stage-shaped way in, and it
 * covers the three stages that have field work and no site register: walking a
 * tender visit, witnessing a commissioning test, verifying an as-built on
 * handover. Nothing is duplicated; the records shown here are the records those
 * stages already produce.
 *
 * ## What is deliberately shown as unknown
 *
 * An indicator with no source publishes `measured: false` and names the
 * workflow that will produce it. It is rendered as **not measured**, never as
 * zero. A zero and an unmeasured figure look identical on a handset and mean
 * opposite things: one says there is nothing to do, the other says nobody
 * knows. The same rule governs the shift and the pack — a session bound to no
 * device is told the platform cannot see what it is holding rather than shown a
 * reassuring "up to date".
 *
 * ## Filters are applied by the server
 *
 * The device asking is the one on the bad connection, so a tab is filtered at
 * `/work/{module}/{tab}?status=…` rather than fetched whole and filtered here.
 * The options offered are the values the rows actually carry, so the screen
 * cannot present a filter that matches nothing.
 */

/** Which module is open, and which tab of it. Module-level so a redraw keeps the place. */
const chosen = { module: 'construction', tab: 'ACTION_QUEUE', status: '', owner: '', location: '', manifestPackId: '' };

const MODULES = [
  { slug: 'tender', label: 'Tender' },
  { slug: 'construction', label: 'Construction' },
  { slug: 'commissioning', label: 'Commissioning' },
  { slug: 'handover', label: 'Handover' },
];

const PACK_TONE = { CURRENT: 'ok', BEHIND: 'warn', NEVER_PULLED: 'warn', NO_DEVICE: 'neutral' };

/** A filter control offering only values present in the rows. */
function filterSelect(name, label, current, values) {
  if (values.length === 0) return '';
  return html`
    <label class="field" style="min-width:170px">
      <span>${label}</span>
      <select data-work-filter="${name}">
        <option value="">Any</option>
        ${raw(
          values
            .map(
              (value) =>
                `<option value="${value.replace(/"/g, '&quot;')}"${value === current ? ' selected' : ''}>${humanise(
                  value,
                )}</option>`,
            )
            .join(''),
        )}
      </select>
    </label>
  `;
}

function indicatorCard(indicator) {
  if (!indicator.measured) {
    return html`
      <div class="metric">
        <span class="metric-label">${indicator.label}</span>
        <span class="metric-value" style="font-size:1rem">Not measured</span>
        <span class="metric-sub">${indicator.pending ?? 'Nothing in the platform produces this figure yet.'}</span>
      </div>
    `;
  }

  const top = (indicator.breakdown ?? []).slice(0, 3);
  return html`
    <div class="metric">
      <span class="metric-label">${indicator.label}</span>
      <span class="metric-value">${String(indicator.total)}</span>
      <span class="metric-sub">
        ${top.length > 0
          ? raw(top.map((entry) => `${humanise(entry.key)} ${entry.count}`).join(' · '))
          : 'No breakdown recorded on these records.'}
      </span>
    </div>
  `;
}

export async function work(root) {
  const projectId = state.session?.projectId;
  if (!projectId) {
    render(root, notice('Open a project to use a field module workspace.', 'info'));
    return;
  }

  const position = await api
    .read(`/v1/projects/${projectId}/work/${chosen.module}`, 'FIELD_EXECUTION')
    .catch((error) => ({ error }));

  if (position.error) {
    render(
      root,
      html`
        <div class="view-head"><h1>Field module workspace</h1></div>
        ${notice(position.error.detail ?? 'This workspace could not be read.', 'bad')}
      `,
    );
    return;
  }

  const query = new URLSearchParams();
  if (chosen.status) query.set('status', chosen.status);
  if (chosen.owner) query.set('owner', chosen.owner);
  if (chosen.location) query.set('location', chosen.location);
  const suffix = query.toString() ? `?${query.toString()}` : '';

  const contents = await api
    .read(`/v1/projects/${projectId}/work/${chosen.module}/${chosen.tab}${suffix}`, 'FIELD_EXECUTION')
    .catch((error) => ({ error }));

  const packs = await api
    .read(`/v1/projects/${projectId}/offline-packs`, 'FIELD_EXECUTION')
    .catch((error) => ({ error }));

  // The manifest is a lookup, not a position: it cannot answer until somebody
  // says which pack. Fetched only once one is chosen.
  const manifest = chosen.manifestPackId
    ? await api
        .read(`/v1/projects/${projectId}/offline-packs/${chosen.manifestPackId}/manifest`, 'FIELD_EXECUTION')
        .catch((error) => ({ error }))
    : null;

  const header = position.header;
  const rows = contents.rows ?? [];
  const filters = contents.filters ?? { status: [], owner: [], location: [] };

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>${position.label}</h1>
          <p>${position.outcome}</p>
        </div>
        <div class="actions">
          ${raw(
            MODULES.map(
              (module) =>
                `<button class="btn ${module.slug === chosen.module ? '' : 'quiet'} sm" data-work-module="${
                  module.slug
                }">${module.label}</button>`,
            ).join(''),
          )}
        </div>
      </div>

      <section class="card" style="margin-bottom:14px" aria-labelledby="wk-head-h">
        <h2 id="wk-head-h">Before you walk out</h2>
        <div class="grid g4">
          <div class="metric">
            <span class="metric-label">Stage</span>
            <span class="metric-value" style="font-size:1rem">${humanise(header.phase)}</span>
            <span class="metric-sub">
              ${header.openNow
                ? 'This module is open in the phase the project is in.'
                : `The project is in ${humanise(header.phase)}. This module belongs to ${header.opensIn
                    .map(humanise)
                    .join(', ')} — what follows is the record, not live work.`}
            </span>
          </div>
          <div class="metric">
            <span class="metric-label">Records waiting</span>
            <span class="metric-value">${String(header.pack.recordsWaiting)}</span>
            <span class="metric-sub">${header.pack.note}</span>
          </div>
          <div class="metric">
            <span class="metric-label">Pack</span>
            <span class="metric-value" style="font-size:1rem">
              ${badge(humanise(header.pack.freshness), PACK_TONE[header.pack.freshness] ?? 'neutral')}
            </span>
            <span class="metric-sub">
              ${header.pack.projectLastChangedAt
                ? `Project last changed ${date(header.pack.projectLastChangedAt)}.`
                : 'Nothing has been recorded on this project yet.'}
            </span>
          </div>
          <div class="metric">
            <span class="metric-label">Shift</span>
            <span class="metric-value" style="font-size:1rem">
              ${header.shift.shift ? humanise(header.shift.shift) : 'Not stated'}
            </span>
            <span class="metric-sub">
              ${header.shift.unknownBecause ?? `From the daily log for ${header.shift.diaryDate}.`}
            </span>
          </div>
        </div>

        <p class="metric-sub" style="margin-top:12px">
          <b>${String(header.context.packages.length)}</b> work packages ·
          <b>${String(header.context.systems.length)}</b> systems ·
          <b>${String(header.context.locations.length)}</b> locations named on this module's records.
        </p>
      </section>

      <section class="card" style="margin-bottom:14px" aria-labelledby="wk-ind-h">
        <h2 id="wk-ind-h">Home indicators</h2>
        <div class="grid g4">${raw(position.indicators.map((entry) => indicatorCard(entry).html ?? '').join(''))}</div>
      </section>

      <section class="card" aria-labelledby="wk-tabs-h">
        <h2 id="wk-tabs-h">${position.tabs.find((tab) => tab.id === chosen.tab)?.label ?? 'Records'}</h2>
        <div class="actions" style="flex-wrap:wrap;margin-bottom:10px">
          ${raw(
            position.tabs
              .map(
                (tab) =>
                  `<button class="btn ${tab.id === chosen.tab ? '' : 'quiet'} sm" data-work-tab="${tab.id}">${
                    tab.label
                  } (${tab.count})</button>`,
              )
              .join(''),
          )}
        </div>
        <p class="metric-sub">${position.tabs.find((tab) => tab.id === chosen.tab)?.basis ?? ''}</p>

        <div class="actions" style="gap:12px;flex-wrap:wrap;align-items:flex-end;margin:10px 0">
          ${filterSelect('status', 'Status', chosen.status, filters.status)}
          ${filterSelect('owner', 'Owner', chosen.owner, filters.owner)}
          ${filterSelect('location', 'Location', chosen.location, filters.location)}
          ${chosen.status || chosen.owner || chosen.location
            ? html`<button class="btn quiet sm" data-work-clear>Clear filters</button>`
            : ''}
        </div>

        ${contents.error
          ? notice(contents.error.detail ?? 'This tab could not be read.', 'bad')
          : table({
              headers: ['Record', 'Reference', 'Status', 'Owner', 'Location', 'Due', 'Changed'],
              rows: rows.map((row) => [
                humanise(row.refType),
                row.reference ?? row.title ?? row.refId,
                row.status ? badge(humanise(row.status), statusTone(row.status)) : '—',
                row.owner ?? '—',
                row.location ?? '—',
                row.due ? date(row.due) : '—',
                row.updatedAt ? date(row.updatedAt) : '—',
              ]),
              empty: 'Nothing on this tab yet.',
            })}
      </section>

      <section class="card" style="margin-top:14px" aria-labelledby="wk-pack-h">
        <h2 id="wk-pack-h">Offline packs</h2>
        <p class="metric-sub">
          A bounded working set a device carries. Each class expires on its own clock — a permit at twelve hours, an
          asset register at two weeks — and the pack is stale as soon as any part of it is. Issuing a new pack does not
          withdraw the one before it: the old pack stays live until the new one is verified, so a download that fails
          halfway does not leave a crew with nothing.
        </p>
        <div class="actions cmd-bar" style="margin:10px 0">
          ${commandBar([
            { id: 'pack-estimate', label: 'Estimate a pack', tone: 'quiet' },
            { id: 'pack-issue', label: 'Issue a pack' },
            { id: 'pack-receipt', label: 'Record a device receipt', tone: 'quiet' },
            { id: 'pack-revoke', label: 'Withdraw a pack', tone: 'quiet' },
          ])}
        </div>
        ${
          packs.error
            ? notice(packs.error.detail ?? 'The pack register could not be read.', 'bad')
            : html`
                <p class="metric-sub">
                  <b>${String(packs.live ?? 0)}</b> live · ${String(packs.expired ?? 0)} expired ·
                  ${String(packs.revoked ?? 0)} withdrawn · ${String((packs.devices ?? []).length)} devices holding one
                </p>
                <div class="actions" style="gap:12px;flex-wrap:wrap;align-items:flex-end;margin:10px 0">
                  <label class="field" style="min-width:260px">
                    <span>Inspect a manifest</span>
                    <select data-pack-manifest>
                      <option value="">Choose a pack</option>
                      ${raw(
                        (packs.packs ?? [])
                          .map(
                            (entry) =>
                              `<option value="${entry.id}"${entry.id === chosen.manifestPackId ? ' selected' : ''}>${entry.id.slice(-8)} — ${entry.deviceId}</option>`,
                          )
                          .join(''),
                      )}
                    </select>
                  </label>
                </div>
                ${
                  manifest === null
                    ? ''
                    : manifest.error
                      ? notice(manifest.error.detail ?? 'That manifest could not be read.', 'warn')
                      : html`
                          <div class="notice info" style="margin-bottom:10px">
                            <b>Manifest v${String(manifest.version)}</b> for ${manifest.deviceId} · cut at stream
                            position ${String(manifest.streamCursor)} · expires ${date(manifest.expiresAt)} ·
                            ${String(manifest.entities.length)} records, ${String(manifest.files.length)} files ·
                            signed under key ${manifest.signature.kid}.
                            <br />
                            Classes: ${manifest.classes.map((entry) => `${entry.label} (${entry.freshnessHours}h)`).join(' · ')}
                          </div>
                        `
                }
                ${table({
                  headers: ['Pack', 'Device', 'Status', 'Records', 'Files', 'Expires', 'Receipt'],
                  rows: (packs.packs ?? []).map((entry) => [
                    entry.id.slice(-8),
                    entry.deviceId,
                    badge(
                      entry.expired && entry.status !== 'REVOKED' ? 'Expired' : humanise(entry.status),
                      entry.status === 'REVOKED' ? 'bad' : entry.expired ? 'warn' : statusTone(entry.status),
                    ),
                    String(entry.entities),
                    String(entry.files),
                    date(entry.expiresAt),
                    entry.receipt
                      ? `${entry.receipt.activated ? 'Activated' : 'Verified only'} — ${String(
                          entry.receipt.entitiesVerified,
                        )} records, ${String(entry.receipt.filesVerified)} files`
                      : 'Not yet reported',
                  ]),
                  empty: 'No pack has been issued on this project.',
                })}
              `
        }
      </section>

      ${position.webOnly.length > 0
        ? notice(
            `Not done from a field device: ${position.webOnly.join(', ')}. These decide money, a baseline or an ` +
              'award, and are taken at a desk.',
            'info',
          )
        : ''}
    `,
  );

  const packOptions = (packs.packs ?? []).map((entry) => ({
    value: entry.id,
    label: `${entry.id.slice(-8)} — ${entry.deviceId} (${humanise(entry.status)})`,
  }));
  const deviceOptions = [...new Set((packs.packs ?? []).map((entry) => entry.deviceId))].map((id) => ({
    value: id,
    label: id,
  }));

  const COMMANDS = {
    'pack-estimate': () =>
      command({
        title: 'Estimate a pack',
        intent:
          'What this module would cost a device to download, before anything is issued. The total is a floor where ' +
          'the platform holds no byte count for a file, and the answer says how many those are.',
        path: `/v1/projects/${projectId}/offline-packs/estimate`,
        submitLabel: 'Estimate',
        fields: [{ name: 'module', label: 'Field module', type: 'select', options: MODULES.map((m) => ({ value: m.slug, label: m.label })), value: chosen.module }],
      }),
    'pack-issue': () =>
      command({
        title: 'Issue a pack',
        intent:
          'Cuts and signs a working set for one device. The pack it replaces stays live until this one is verified, ' +
          'so a failed download never leaves a crew without one.',
        path: `/v1/projects/${projectId}/offline-packs`,
        submitLabel: 'Issue',
        fields: [
          { name: 'deviceId', label: 'Device', required: true, hint: 'The handset this pack is granted to.' },
          { name: 'module', label: 'Field module', type: 'select', options: MODULES.map((m) => ({ value: m.slug, label: m.label })), value: chosen.module },
        ],
      }),
    'pack-receipt': () =>
      command({
        title: 'Record a device receipt',
        intent:
          'What the device reports it verified. The platform did not watch it hash the files, so this is recorded as ' +
          'a report — and a pack cannot be activated reporting fewer verified records than it carries as required.',
        path: (values) => `/v1/projects/${projectId}/offline-packs/${values.packId}/receipt`,
        submitLabel: 'Record',
        fields: [
          { name: 'packId', label: 'Pack', type: 'select', options: packOptions, required: true },
          { name: 'deviceId', label: 'Device', type: 'select', options: deviceOptions, required: true },
          { name: 'entitiesVerified', label: 'Records verified', type: 'number', required: true },
          { name: 'filesVerified', label: 'Files verified', type: 'number', required: true },
          { name: 'activated', label: 'Activated on the device', type: 'checkbox' },
          { name: 'note', label: 'Note', type: 'textarea' },
        ],
        transform: (values) => ({
          deviceId: values.deviceId,
          entitiesVerified: Number(values.entitiesVerified),
          filesVerified: Number(values.filesVerified),
          activated: values.activated === true || values.activated === 'on',
          ...(values.note ? { note: values.note } : {}),
        }),
      }),
    'pack-revoke': () =>
      command({
        title: 'Withdraw a pack',
        intent:
          'Refuses the manifest from here on. A device that loses its working set mid-shift stops work, so the ' +
          'reason is required and is recorded against whoever withdrew it.',
        path: (values) => `/v1/projects/${projectId}/offline-packs/${values.packId}/revoke`,
        submitLabel: 'Withdraw',
        fields: [
          { name: 'packId', label: 'Pack', type: 'select', options: packOptions, required: true },
          { name: 'reason', label: 'Reason', type: 'textarea', required: true, hint: 'At least ten characters.' },
        ],
        transform: (values) => ({ reason: values.reason }),
      }),
  };

  root.querySelector('.cmd-bar')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-cmd]');
    if (button && COMMANDS[button.dataset.cmd]) COMMANDS[button.dataset.cmd]();
  });

  root.querySelector('[data-pack-manifest]')?.addEventListener('change', (event) => {
    chosen.manifestPackId = event.target.value;
    draw();
  });

  root.querySelectorAll('[data-work-module]').forEach((button) => {
    button.addEventListener('click', () => {
      chosen.module = button.dataset.workModule;
      chosen.tab = 'ACTION_QUEUE';
      chosen.status = chosen.owner = chosen.location = '';
      draw();
    });
  });
  root.querySelectorAll('[data-work-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      chosen.tab = button.dataset.workTab;
      // A status that exists on one tab need not exist on the next, and a
      // filter that matches nothing looks like an empty tab rather than a
      // filter.
      chosen.status = chosen.owner = chosen.location = '';
      draw();
    });
  });
  root.querySelectorAll('[data-work-filter]').forEach((select) => {
    select.addEventListener('change', () => {
      chosen[select.dataset.workFilter] = select.value;
      draw();
    });
  });
  root.querySelector('[data-work-clear]')?.addEventListener('click', () => {
    chosen.status = chosen.owner = chosen.location = '';
    draw();
  });
}
