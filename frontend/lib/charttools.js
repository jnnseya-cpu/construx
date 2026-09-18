import { clearFilter, toggleFilter } from './crossfilter.js';
import { forgetView, saveView, toggleCompare } from './views.js';
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

/**
 * A chart as a standalone image, with its colours resolved.
 *
 * The obstacle is custom properties. Every mark in this kit paints with
 * `var(--brand-blue)` and friends, and a detached SVG has no stylesheet — so
 * serialising the node as it stands produces an image where every fill resolves
 * to nothing and the chart comes out black on transparent. The fix is to read
 * the *computed* value off each element while it is still in the document and
 * write it back as a plain attribute.
 *
 * Fonts are the other half. A `font-family` naming IBM Plex means nothing to a
 * canvas that cannot fetch it, so the computed size and weight are inlined and
 * the family falls back — the numbers stay the right size and in the right
 * place, which is what a chart image is for.
 */
function inlineStyles(source, clone) {
  const PAINTED = [
    'fill',
    'stroke',
    'stroke-width',
    'stroke-dasharray',
    'stroke-linecap',
    'fill-opacity',
    'stroke-opacity',
    'opacity',
    'font-size',
    'font-family',
    'font-weight',
    'letter-spacing',
    'text-anchor',
    'dominant-baseline',
  ];
  const from = [source, ...source.querySelectorAll('*')];
  const to = [clone, ...clone.querySelectorAll('*')];
  for (let index = 0; index < from.length; index += 1) {
    const computed = getComputedStyle(from[index]);
    const parts = [];
    for (const property of PAINTED) {
      const value = computed.getPropertyValue(property);
      if (value && value !== 'none' && value !== 'normal') parts.push(`${property}:${value}`);
    }
    to[index].setAttribute('style', parts.join(';'));
  }
}

/**
 * The chart as a PNG the person can put in a report.
 *
 * Rendered at twice the on-screen size, because the commonest destination is a
 * document somebody prints and a 1x raster of a 720px chart is visibly soft on
 * paper. Painted onto an opaque ground first: a transparent PNG dropped into a
 * white document shows this interface's light text on white.
 */
async function chartToPng(figure, title) {
  const svg = figure.querySelector('svg.chart-svg');
  if (!svg) throw new Error('This panel has no chart to export.');

  const clone = svg.cloneNode(true);
  inlineStyles(svg, clone);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  const box = svg.viewBox.baseVal;
  const width = box && box.width ? box.width : svg.clientWidth || 720;
  const height = box && box.height ? box.height : svg.clientHeight || 320;
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const scale = 2;
  const markup = new XMLSerializer().serializeToString(clone);
  // A data URI rather than a blob URL: a blob URL taints the canvas in Safari
  // and `toBlob` then throws a security error on an image nobody fetched from
  // anywhere. `encodeURIComponent` handles the non-ASCII in the labels.
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;

  const image = new Image();
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('The chart could not be rasterised.'));
    image.src = uri;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  // The interface's own ground, read from the page rather than hardcoded, so an
  // exported chart matches the screen it came from.
  context.fillStyle = getComputedStyle(document.body).backgroundColor || '#111317';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The image could not be encoded.');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${fileName(title).replace(/\.csv$/, '')}.png`;
  document.body.append(link);
  link.click();
  link.remove();
  requestAnimationFrame(() => URL.revokeObjectURL(url));
}

/**
 * The chart as a PDF, through the browser's own print dialogue.
 *
 * No library, which is settled decision 2 rather than a shortcut — and the
 * browser's "Save as PDF" produces a better document than a hand-rolled
 * generator would: real vectors, selectable text, the reader's own paper size.
 *
 * What it needs is for the printed page to be the chart rather than the
 * console. `data-printing` on the root, and the print stylesheet hides
 * everything that is not the marked panel.
 */
function chartToPdf(figure) {
  document.documentElement.setAttribute('data-printing', '');
  figure.setAttribute('data-print-target', '');
  const done = () => {
    document.documentElement.removeAttribute('data-printing');
    figure.removeAttribute('data-print-target');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  // Safari does not always fire `afterprint`. A timer is a poor guarantee, so
  // it is a backstop rather than the mechanism — without it a refused print
  // dialogue would leave the console hidden behind a print stylesheet.
  setTimeout(done, 6000);
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

    // --- compare mode and saved views ---------------------------------------
    //
    // The same mechanism as the filter: change the address bar, ask the page to
    // redraw. A saved view is a stored URL, so opening one is a navigation and
    // nothing has to know what a view contains.
    if (event.target.closest?.('[data-toggle-compare]')) {
      toggleCompare();
      document.dispatchEvent(new CustomEvent('construx:refilter'));
      return;
    }

    if (event.target.closest?.('[data-save-view]')) {
      // `prompt` rather than a modal: this is a name for a bookmark, and the
      // console's modal is for commands that write to the ledger.
      const name = window.prompt('Name this view', document.title.split('\u2014')[0].trim() || 'My view');
      if (name) {
        saveView(name);
        toast('View saved', `${name} \u2014 on this browser, for you.`, 'ok');
        document.dispatchEvent(new CustomEvent('construx:refilter'));
      }
      return;
    }

    const open = event.target.closest?.('[data-open-view]');
    if (open) {
      history.pushState({}, '', open.getAttribute('data-open-view'));
      document.dispatchEvent(new CustomEvent('construx:refilter'));
      return;
    }

    const forget = event.target.closest?.('[data-forget-view]');
    if (forget) {
      forgetView(forget.getAttribute('data-forget-view'));
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

    // --- as a picture -------------------------------------------------------
    if (button.hasAttribute('data-chart-png')) {
      const { figure } = targetOf(button, 'data-chart-png');
      if (!figure) return;
      const title = figure.getAttribute('data-chart') ?? 'chart';
      try {
        await chartToPng(figure, title);
        toast('Image saved', `${title} \u2014 at twice the on-screen size, for a report.`, 'ok');
      } catch (error) {
        toast('Could not save the image', error.message ?? 'The chart could not be rasterised.', 'warn');
      }
      return;
    }

    // --- as a document ------------------------------------------------------
    if (button.hasAttribute('data-chart-pdf')) {
      const { figure } = targetOf(button, 'data-chart-pdf');
      if (figure) chartToPdf(figure);
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
