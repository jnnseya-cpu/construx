import { commandCatalogue, groupCommands, specFor } from '../lib/catalogue.js';
import { barChart, treemap } from '../lib/charts.js';
import { command } from '../lib/command.js';
import { badge, html, humanise, raw, render, table, toast } from '../lib/ui.js';
import { draw, state } from '../app.js';

/**
 * Every command, and a door to each.
 *
 * Seventy-eight of the platform's write routes had no console entry point. Every
 * one was a capability that existed with no way to reach it, and that — not any
 * missing feature — is the likeliest reason a reviewer concludes there is
 * nowhere to put information in.
 *
 * This screen is not a replacement for the curated panels. A drawing register
 * with a real dropdown of this project's current revisions is better than a text
 * box called `drawingId`, and every page that has one keeps it. What this adds is
 * that a command with no curated panel now has a door rather than nothing, built
 * from the schema the platform publishes rather than from a copy of it kept here.
 *
 * The screen is deliberately plain. It is a directory, and a directory that
 * tries to be a dashboard is harder to search.
 */

export async function commands(root) {
  const projectId = state.session.projectId;
  const catalogue = await commandCatalogue();
  const groups = groupCommands(catalogue.commands);

  render(
    root,
    html`
      <div class="view-head">
        <div>
          <h1>Commands</h1>
          <p>
            Every write command the platform accepts, with the fields it takes. The forms are generated from the platform's own
            schemas, so what is offered here and what is enforced cannot drift apart.
          </p>
        </div>
      </div>

      <div class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Commands</h2>
          <div class="metric orange">${catalogue.commands.length}</div>
          <div class="metric-sub">every write route, none hidden</div>
        </div>
        <div class="card">
          <h2>Areas</h2>
          <div class="metric">${groups.length}</div>
          <div class="metric-sub">grouped as the platform groups them</div>
        </div>
        <div class="card">
          <h2>Schema-checked</h2>
          <div class="metric good">${catalogue.commands.length - catalogue.withoutSchema}</div>
          <div class="metric-sub">the body is validated before a handler sees it</div>
        </div>
        <div class="card">
          <h2>Unchecked</h2>
          <div class="metric ${raw(catalogue.withoutSchema > 0 ? 'warn' : 'good')}">${catalogue.withoutSchema}</div>
          <div class="metric-sub">no published schema — the form can only offer free text</div>
        </div>
      </div>

      ${commandCharts(catalogue, groups)}

      <div class="card" style="margin-bottom:14px">
        <div class="field">
          <label for="q">Find a command</label>
          <input id="q" type="search" placeholder="notice, permit, subcontract, baseline…" autocomplete="off">
        </div>
        <div class="metric-sub" style="margin-top:9px">
          A command you may not run is still listed. Pressing it produces the platform's own refusal, with the reason —
          which is more useful than a control that is not there.
        </div>
      </div>

      ${groups.map(
        (group) => html`<div class="card pad0 cmd-group" data-area="${group.area}" style="margin-bottom:14px">
          <h2 style="padding:15px 17px 0">${humanise(group.area)}</h2>
          ${table({
            headers: ['Command', 'Method', 'Body', ''],
            rows: group.commands.map((entry) => [
              entry.description,
              entry.method,
              entry.schema
                ? `${Object.keys(entry.schema.properties ?? {}).length} field(s)`
                : badge('unchecked', 'warn'),
              html`<button class="btn quiet sm" data-run="${entry.id}">Open</button>`,
            ]),
          })}
        </div>`,
      )}
    `,
  );

  const byId = new Map(catalogue.commands.map((entry) => [entry.id, entry]));

  root.querySelector('#q')?.addEventListener('input', (event) => {
    const term = event.target.value.trim().toLowerCase();
    for (const group of root.querySelectorAll('.cmd-group')) {
      let visible = 0;
      for (const row of group.querySelectorAll('tbody tr')) {
        const match = term === '' || row.textContent.toLowerCase().includes(term);
        row.hidden = !match;
        if (match) visible += 1;
      }
      group.hidden = visible === 0;
    }
  });

  root.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-run]');
    if (!button) return;
    const entry = byId.get(button.dataset.run);
    if (!entry) return;

    if (entry.upload) {
      // A file is not a form field. The upload routes are reached from the
      // screen that owns the record, and saying so beats opening a panel that
      // cannot do the one thing the route is for.
      toast('Not a form', 'This command takes a file. Supply it from the record it belongs to.', 'warn');
      return;
    }

    try {
      if (await command(specFor(entry, { projectId, actorName: state.session.user.name }))) await draw();
    } catch (error) {
      toast('Could not run', error.message, 'err');
    }
  });
}

/**
 * A directory that can be scanned as well as searched.
 *
 * This screen is deliberately plain, and it stays plain: a directory that tries
 * to be a dashboard is harder to search, and the search box above is still the
 * fastest way to reach one command. What the two charts add is the thing a
 * search cannot give you — the shape of the whole surface, for somebody who
 * does not yet know the name of what they are looking for.
 *
 * The unchecked bar is the one that earns its place. A command with no
 * published schema can only be offered as free text, so the form here cannot
 * validate before the platform does. That is a property of the surface rather
 * than of any one command, and it is invisible in a list.
 */
function commandCharts(catalogue, groups) {
  const all = catalogue?.commands ?? [];
  if (all.length === 0) return '';

  const byArea = (groups ?? [])
    .map((group) => ({ label: humanise(String(group.area ?? group.title ?? 'Other')), value: (group.commands ?? []).length }))
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value);

  const schema = (groups ?? [])
    .map((group) => ({
      label: humanise(String(group.area ?? group.title ?? 'Other')),
      checked: (group.commands ?? []).filter((entry) => entry.schema ?? entry.hasSchema ?? true).length,
      unchecked: (group.commands ?? []).filter((entry) => !(entry.schema ?? entry.hasSchema ?? true)).length,
    }))
    .filter((row) => row.unchecked > 0)
    .sort((a, b) => b.unchecked - a.unchecked);

  return html`
    <div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <h2>Where the platform accepts writing</h2>
        ${raw(
          treemap({
            title: 'Commands by capability area',
            items: byArea,
            format: (value) => `${value} command${value === 1 ? '' : 's'}`,
            empty: 'The command catalogue is empty.',
            footnote:
              'Grouped as the platform groups them, not as this screen chooses to. A command you may not run is still ' +
              'counted — pressing it produces the platform’s own refusal, with the reason.',
          }),
        )}
      </div>
      <div class="card">
        <h2>Where a form can only offer free text</h2>
        ${raw(
          barChart({
            title: 'Commands with no published schema, by area',
            horizontal: true,
            data: schema,
            series: [{ key: 'unchecked', label: 'No schema', colour: 'warn' }],
            format: (value) => `${value} command${value === 1 ? '' : 's'}`,
            empty: `Every one of the ${all.length} commands publishes a schema, so every generated form validates before a handler sees the body.`,
            footnote:
              'A command with no schema can only be offered as free text here, so the form cannot check anything the ' +
              'platform will check a moment later. The refusal still arrives; it just arrives after the press.',
          }),
        )}
      </div>
    </div>
  `;
}
