import { clearFilter, toggleFilter } from './crossfilter.js';
import { toast } from './ui.js';

/**
 * The interactions the Visual Intelligence Standard requires of every chart.
 *
 * View the data, export it, open it full screen, link to it. Four behaviours,
 * one delegated listener on the document, and therefore nothing for a page to
 * remember to wire. The console re-renders whole screens on every navigation,
 * so a listener attached per chart would have to be re-attached per render and
 * would be forgotten on the screen somebody adds next month.
 *
 * ## The export reads the table, not the data
 *
 * `frame()` publishes each chart's dataset as a real `<table>`, and that table
 * is what a screen reader reads. The CSV is generated from the same table
 * rather than from the values the chart was built out of.
 *
 * That is the difference between an export that reconciles and one that usually
 * reconciles. Two code paths over one dataset drift — a filter applied in one,
 * a rounding in the other — and the day they disagree is the day somebody takes
 * the wrong number into a meeting. Reading the rendered table makes them the
 * same number by construction.
 *
 * ## Cross-filtering goes through the page, not the DOM
 *
 * A mark that names a dimension is a filter control, and clicking one does two
 * things: it writes the filter to the address bar and it asks the console to
 * redraw. Nothing in this file hides a row or dims a slice.
 *
 * That is deliberate. Hiding rows is quick and looks right, and it is a lie —
 * the KPI totals do not move, the captions still describe the unfiltered set,
 * and the CSV exports everything. Going through `draw()` means the page narrows
 * its own payload and every figure on the screen is recomputed from the same
 * array, so the tiles, the tables, the data panels and the exports agree with
 * the charts by construction. See `crossfilter.js`.
 */

/** Everything a CSV field can contain, quoted the one way every reader accepts. */
function csvField(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A rendered table, exactly as it appears, as CSV text. */
function tableToCsv(table) {
  return [...table.rows]
    .map((row) =>
      [...row.cells]
        // `textContent` rather than innerText: the values are already plain,
        // and innerText would collapse the monospace figures' spacing.
        .map((cell) => csvField(cell.textContent.trim()))
        .join(','),
    )
    .join('\r\n');
}

/** A filename a person can find again, from the chart's own title. */
function fileName(title) {
  const slug = String(title ?? 'chart')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `construx-${slug || 'chart'}-${new Date().toISOString().slice(0, 10)}.csv`;
}

function download(name, text) {
  // A BOM, because the commonest thing done with one of these is opening it in
  // Excel, and Excel reads a UTF-8 file without one as Windows-1252 — which
  // turns every pound sign in a construction export into Â£.
  const blob = new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next frame rather than immediately: Safari has not finished
  // reading the blob when click() returns, and an immediate revoke silently
  // downloads nothing.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/** The chart a tool button belongs to, and the id it names. */
function targetOf(button, attribute) {
  const id = button.getAttribute(attribute);
  const figure = button.closest('figure.chart') ?? (id ? document.getElementById(id) : null);
  return { id, figure };
}

let wired = false;

/**
 * Install the one listener. Idempotent: calling it twice does not double-fire,
 * which matters because the console re-runs page modules on navigation.
 */
export function wireCharts() {
  if (wired) return;
  wired = true;

  document.addEventListener('click', async (event) => {
    // --- cross-filter -------------------------------------------------------
    //
    // A mark that names a dimension is a filter control. Handled before the
    // tool buttons because a mark is inside the figure the tools sit on, and
    // handled here rather than per page for the same reason everything else in
    // this file is: the console re-renders whole screens, so a per-chart
    // listener would need re-attaching on every one of them.
    const mark = event.target.closest?.('[data-filter-dimension]');
    if (mark) {
      toggleFilter(
        mark.getAttribute('data-filter-dimension'),
        mark.getAttribute('data-filter-key'),
        mark.getAttribute('data-filter-label'),
      );
      // The page redraws itself from its own payload with the filter applied.
      // Nothing here touches the DOM: a filter that dimmed marks without moving
      // the totals would be a filter that looks applied and is not.
      document.dispatchEvent(new CustomEvent('construx:refilter'));
      return;
    }

    const clear = event.target.closest?.('[data-clear-filter]');
    if (clear) {
      clearFilter();
      document.dispatchEvent(new CustomEvent('construx:refilter'));
      return;
    }

    const button = event.target.closest?.('.chart-tool');
    if (!button) return;

    // --- view the data ------------------------------------------------------
    if (button.hasAttribute('data-chart-data')) {
      const { id } = targetOf(button, 'data-chart-data');
      const panel = document.getElementById(`${id}-data`);
      if (!panel) return;
      const open = !panel.hidden;
      panel.hidden = open;
      button.setAttribute('aria-expanded', String(!open));
      button.textContent = open ? 'View data' : 'Hide data';
      return;
    }

    // --- export it ----------------------------------------------------------
    if (button.hasAttribute('data-chart-csv')) {
      const { id, figure } = targetOf(button, 'data-chart-csv');
      const table = document.querySelector(`#${CSS.escape(`${id}-data`)} table`);
      if (!table) return;
      const title = figure?.getAttribute('data-chart') ?? 'chart';
      download(fileName(title), tableToCsv(table));
      toast('Exported', `${title} — the same rows the data panel shows.`, 'ok');
      return;
    }

    // --- open it full screen ------------------------------------------------
    if (button.hasAttribute('data-chart-full')) {
      const { figure } = targetOf(button, 'data-chart-full');
      if (!figure) return;
      if (document.fullscreenElement === figure) await document.exitFullscreen().catch(() => {});
      // Not every browser and not every context allows it — an iframe without
      // the permission, or a refused gesture. Say so rather than doing nothing.
      else if (figure.requestFullscreen) {
        await figure.requestFullscreen().catch(() => {
          toast('Cannot expand', 'This browser refused full screen for this panel.', 'warn');
        });
      }
      return;
    }

    // --- link to it ---------------------------------------------------------
    if (button.hasAttribute('data-chart-link')) {
      const { id, figure } = targetOf(button, 'data-chart-link');
      // The whole address including the page's own query, so a link carries the
      // filters the reader had applied when they copied it.
      const url = `${location.origin}${location.pathname}${location.search}#${id}`;
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied', figure?.getAttribute('data-chart') ?? 'This chart', 'ok');
      } catch {
        // Clipboard access is refused outside a secure context and in some
        // embeddings. Falling back to the address bar still hands the person a
        // link they can copy.
        location.hash = id;
        toast('Link in the address bar', 'Clipboard access was refused, so the address was set instead.', 'info');
      }
    }
  });

  // A chart arrived at by a deep link is scrolled to and marked, because
  // landing halfway down a long screen with no indication of why is the same
  // as landing nowhere.
  const settle = () => {
    if (!location.hash.startsWith('#chart-')) return;
    const figure = document.getElementById(location.hash.slice(1));
    if (!figure) return;
    figure.scrollIntoView({ block: 'center', behavior: 'smooth' });
    figure.classList.add('is-linked');
    setTimeout(() => figure.classList.remove('is-linked'), 2400);
  };
  window.addEventListener('hashchange', settle);
  // Also after each render, since the console draws its screens asynchronously
  // and the element a link names does not exist at load.
  document.addEventListener('construx:rendered', settle);
}
