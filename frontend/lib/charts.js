import { esc, html, raw } from './ui.js';

/**
 * The chart kit.
 *
 * Fifteen chart types as inline SVG, drawn by pure functions. No library: zero
 * runtime dependencies is a settled decision, and a charting package is the
 * single largest dependency a console like this normally carries. What it would
 * buy — axes, scales, layout — is a few hundred lines of arithmetic, and what it
 * would cost is a bundle, a theming layer that fights this one, and an upgrade
 * treadmill on a product whose whole premise is an auditable record.
 *
 * ## The rules every chart here keeps
 *
 * **A chart with no data is not a blank box.** Every function returns the design
 * system's empty state, with the caller's own sentence saying what empty means
 * on this screen. A chart axis drawn over nothing reads as "zero", and zero and
 * "never measured" are different facts — the same distinction `positionReport`
 * makes for registers.
 *
 * **A chart never invents a number.** No interpolation across gaps, no smoothing
 * that moves a point, no "projected" segment that is not in the data. A line
 * with a hole in it is drawn with a hole in it.
 *
 * **Colour is not the only channel.** Every categorical series carries a label,
 * every threshold crossing carries a shape or a rule as well as a hue, and the
 * semantic tones are the platform's own five so that "bad" is the same red on a
 * chart as it is on a badge. Roughly one man in twelve cannot separate the red
 * from the green.
 *
 * **Every chart is readable by a screen reader and by a mouse.** The `<svg>`
 * carries `role="img"` and a `<title>`/`<desc>` pair that states the headline in
 * words; every drawn shape carries its own `<title>`, which is the browser's
 * native tooltip and costs no JavaScript at all.
 *
 * **Every chart is responsive.** A `viewBox` with `width:100%` and no fixed
 * height in the SVG, so the container decides. Nothing here reads the DOM, so a
 * chart renders identically on a server, in a test and in a phone browser.
 *
 * ## Reading this file
 *
 * The scale helpers come first, then the palette, then the charts in the order
 * the specification lists them: comparison and trend, distribution and
 * correlation, then the specialised dashboard elements.
 */

/**
 * @typedef {string|number|null|undefined} Scalar
 * @typedef {{label: string, value?: Scalar, tone?: string, [key: string]: unknown}} Row
 * @typedef {{key: string, label: string, colour?: string}} Series
 * @typedef {{x: Scalar, y: Scalar, z?: Scalar, label?: string, tone?: string}} Point
 * @typedef {{label: string, values: number[], tone?: string}} Group
 * @typedef {{label: string, value: number, tone?: string, total?: boolean}} Step
 * @typedef {{id?: string|number, label?: string, name?: string, start: string, end?: string, finish?: string, baselineStart?: string, baselineFinish?: string, baselineEnd?: string, lateFinish?: string, totalFloat?: number, wbs?: string, milestone?: boolean, critical?: boolean, longestPath?: boolean, percentComplete?: number, tone?: string}} GanttTask
 * @typedef {{predecessorId?: string|number, successorId?: string|number, from?: string|number, to?: string|number, type?: string, lag?: number, critical?: boolean}} GanttLink
 * @typedef {{label?: string, name?: string, start: string, end?: string, finish?: string,
 *   baselineStart?: string, baselineFinish?: string, baselineEnd?: string,
 *   percentComplete?: number, milestone?: boolean, critical?: boolean, longestPath?: boolean,
 *   tone?: string, id?: string, wbsPath?: string}} Task
 *
 * `name`/`finish` are accepted beside `label`/`end` because a programme record
 * calls them that. Translating at every call site is how one call site
 * eventually gets it wrong.
 * @typedef {{label: string, count: number, marked?: boolean}} Bucket
 * @typedef {(value: Scalar) => string} Formatter
 */

// --- Palette ----------------------------------------------------------------

/**
 * The categorical series colours.
 *
 * The Enterprise Visual Intelligence Standard's palette, in the order it
 * assigns meaning: CONSTRUX Blue is primary data, Cyan is secondary data, and
 * the rest follow. A single-series chart is therefore blue — the platform's
 * data colour — rather than Signal Orange, which the standard reserves for
 * chrome and signal.
 *
 * Eight, because a categorical chart with more than eight series is a table
 * somebody drew. Four of the eight are lifted from their published hex so they
 * clear WCAG AA on `--raised`, the lightest surface a chart is painted on;
 * `app.css` carries the measurements and the unlifted `-spec` values.
 *
 * ## The order is a measurement, not a preference
 *
 * `backend/tests/palette.test.ts` simulates protanopia, deuteranopia and
 * tritanopia and measures every pair in CIE Lab. The result is the reason this
 * list is in this order, and it is worth stating plainly because the comment
 * that used to sit here claimed something nobody had computed:
 *
 * **Eight categorical hues cannot all survive colour-vision deficiency.** Of
 * the 56 orderings' worth of five-colour subsets containing Blue, exactly two
 * hold together, and the longest mutually separable run this palette admits is
 * **five**. Past five, hue is not a channel a reader can rely on. That is a
 * property of human vision and of any eight-colour palette, not of this one.
 *
 * So the first five are the separable set — worst pair ΔE 13.1 across all three
 * deficiencies — and the test locks that. The three past it are, as it happens,
 * exactly the three the standard reserves for a fixed meaning: Green is on
 * target, Purple is AI and forecast, Orange is the platform's own signal. A
 * chart reaching a sixth series is reaching into a reserved colour, and the
 * order says so.
 *
 * Beyond the fifth series the separation has to come from somewhere other than
 * hue, which is why every mark in this kit carries its label and its value in a
 * `<title>`, and why bars, slices and nodes print their own.
 */
export const SERIES = [
  // The separable five. Order fixed by measurement — do not reorder without
  // re-running the palette test, which will tell you what it cost.
  'rgb(82, 147, 255)',   // CONSTRUX Blue  — primary data
  'rgb(22, 199, 217)',   // Cyan           — secondary data, digital intelligence
  'rgb(242, 169, 0)',    // Amber          — third category
  'rgb(228, 114, 119)',  // Red            — fourth category
  'rgb(135, 150, 166)',  // Slate          — fifth category, neutral context
  // Past here hue stops carrying the distinction on its own, and each of these
  // already means something specific elsewhere in the interface.
  'rgb(24, 171, 88)',    // Green          — on target, accepted, complete
  'rgb(150, 130, 255)',  // Purple         — AI, forecast, machine-generated
  'rgb(255, 106, 26)',   // Signal Orange  — the platform's own accent
];

/**
 * How many series deep the palette stays separable to a colour-blind reader.
 *
 * Published rather than kept in the test, so a caller composing a chart can ask
 * — and so the number is one fact in one place when somebody changes the list.
 */
export const SERIES_SEPARABLE = 5;

/**
 * Tones a caller names instead of a colour.
 *
 * The first five keep a chart agreeing with the badge beside it. The last five
 * are the standard's plan-against-reality set: baseline, actual, forecast,
 * target and threshold have one colour each across the whole platform, so a
 * dotted purple line means a forecast on every screen that draws one.
 */
export const TONES = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--critical)',
  info: 'var(--info)',
  accent: 'var(--orange)',
  neutral: 'var(--text-3)',

  actual: 'var(--viz-actual)',
  baseline: 'var(--viz-baseline)',
  forecast: 'var(--viz-forecast)',
  target: 'var(--viz-target)',
  threshold: 'var(--viz-threshold)',

  blue: 'var(--brand-blue)',
  cyan: 'var(--brand-cyan)',
  green: 'var(--brand-green)',
  amber: 'var(--brand-amber)',
  red: 'var(--brand-red)',
  purple: 'var(--brand-purple)',
  slate: 'var(--brand-slate)',
};

/**
 * The stroke pattern each plan-against-reality tone carries.
 *
 * Colour alone is not an encoding the standard accepts, and it is right: a
 * reader who cannot separate blue from purple still has to be able to tell a
 * forecast from a measurement. Baseline is dashed, forecast is dotted, actual
 * is solid, and a threshold is a long dash — so the four are distinguishable
 * in greyscale, in print and to a colour-blind reader.
 */
export const DASHES = {
  baseline: '6 4',
  forecast: '2 4',
  threshold: '10 5',
  actual: undefined,
  target: undefined,
};

/** The dash array a tone carries, or undefined for a solid stroke. */
export const toneDash = (tone) => DASHES[tone];

/** A series colour by index, wrapping rather than running out. */
export const seriesColour = (index) => SERIES[index % SERIES.length];

/** Resolve a caller's tone name, a raw colour, or an index, to a paint. */
function paint(value, index = 0) {
  if (value === undefined || value === null || value === '') return seriesColour(index);
  return TONES[value] ?? String(value);
}

/**
 * One colour per mark, where some marks name a tone and others do not.
 *
 * The case this exists for, found on the Command Centre severity donut: three
 * slices, two of them toned `bad` and `warn`, and the third left untoned so it
 * fell through to a series colour. The third series colour is Amber, `warn`
 * resolves to Amber, and "Attention" and "Info" came out the same colour in the
 * same chart with a legend insisting they were different things.
 *
 * Colour is a state channel in this platform. An untoned mark must therefore
 * never be handed a colour that a toned mark in the same chart is already using
 * to mean something — so the untoned ones take the next series colour that is
 * not already spoken for, rather than the one their index happens to land on.
 *
 * It changes nothing for a chart where every mark is toned, or where none is.
 */
function assignColours(rows) {
  const taken = new Set(
    rows
      .filter((row) => row && row.tone !== undefined && row.tone !== null && row.tone !== '')
      .map((row) => paint(row.tone)),
  );
  let next = 0;
  return rows.map((row, index) => {
    const tone = row?.tone;
    if (tone !== undefined && tone !== null && tone !== '') return paint(tone, index);
    while (next < SERIES.length && taken.has(SERIES[next])) next += 1;
    // Past the end, fall back to the plain index: eight toned marks in one
    // chart is a chart whose colours have stopped being a channel anyway.
    const colour = next < SERIES.length ? SERIES[next] : seriesColour(index);
    next += 1;
    return colour;
  });
}

// --- Geometry ---------------------------------------------------------------

/** The drawing box every chart works in. Aspect is set per chart type. */
const BOX = { w: 720, h: 320 };

/** Room for axis labels. Left is widest because numbers are. */
const PAD = { top: 18, right: 18, bottom: 34, left: 54 };

const plot = (box = BOX, pad = PAD) => ({
  x: pad.left,
  y: pad.top,
  w: Math.max(1, box.w - pad.left - pad.right),
  h: Math.max(1, box.h - pad.top - pad.bottom),
});

/**
 * Whether a value is a measurement.
 *
 * `Number.isFinite(Number(value))` alone is not this test, and the difference is
 * the whole "a chart never invents a number" rule: `Number(null)` is `0`,
 * `Number('')` is `0` and `Number(true)` is `1`, so a week nobody measured, a
 * blank cell and a boolean all arrived as real values and were plotted. A gap in
 * a line was drawn as a drop to zero, and a heatmap cell nobody had filled in
 * was drawn as a recorded zero — both of which are readings, and neither of
 * which anybody took.
 */
const finite = (value) =>
  value !== null && value !== undefined && value !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value));
const num = (value, fallback = 0) => (finite(value) ? Number(value) : fallback);

/** Round for SVG. Two decimals is below a pixel at any size we render at. */
const r2 = (value) => Math.round(Number(value) * 100) / 100;

/**
 * A linear scale from a data range to a pixel range.
 *
 * A zero-width domain maps everything to the middle of the range rather than
 * dividing by zero. One measurement is a legitimate chart — it is a dot in the
 * centre, not a crash and not a full bar.
 */
function scale(min, max, from, to) {
  const span = max - min;
  if (!Number.isFinite(span) || span === 0) return () => (from + to) / 2;
  return (value) => from + ((num(value) - min) / span) * (to - from);
}

/**
 * A readable axis range and its ticks.
 *
 * Extends to a round number rather than to the data, because an axis that stops
 * at 8,437 makes the reader do arithmetic to compare two charts. Always includes
 * zero for a value axis unless the data is entirely negative or the caller opts
 * out — a bar chart whose axis starts at 4,000 exaggerates every difference on
 * it, and that is the commonest way a chart lies without a single wrong number.
 */
export function niceScale(min, max, { ticks = 5, zeroBased = true } = {}) {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : 0;
  if (zeroBased && lo > 0) lo = 0;
  if (zeroBased && hi < 0) hi = 0;
  if (lo === hi) {
    // A flat series still deserves an axis. One unit either side of the value.
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    // …except that padding an all-zero value axis downwards invents a negative
    // range the data cannot occupy. The contingency chart on Risk & Safety did
    // exactly this on a project with no risks registered: expected, P80 and
    // worst case were all £0, and the axis read £-1.00 · £-0.50 · £0 · £0.50 ·
    // £1.00. Negative contingency is not a small figure, it is a meaningless
    // one, and a reader who sees money below zero on an axis stops trusting
    // the chart above it. A zero-based axis grows upwards only.
    if (zeroBased && lo >= 0) hi += pad;
    else if (zeroBased && hi <= 0) lo -= pad;
    else {
      lo -= pad;
      hi += pad;
    }
  }
  const rawStep = (hi - lo) / Math.max(1, ticks);
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rawStep) || 1));
  const normalised = rawStep / magnitude;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const values = [];
  // A tolerance of a thousandth of a step, because 0.1 + 0.2 is famously not 0.3
  // and an axis that silently drops its top tick looks like a rendering bug.
  for (let value = start; value <= end + step / 1000; value += step) values.push(r2(value));
  return { min: start, max: end, ticks: values, step };
}

/** Default tick text: compact for large numbers, plain otherwise. */
function tickLabel(value) {
  const n = Number(value);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${r2(n / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${r2(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${r2(n / 1_000)}k`;
  return String(r2(n));
}

// --- The frame ---------------------------------------------------------------

/**
 * The empty state.
 *
 * Deliberately the same block `table` uses, so an empty chart and an empty
 * register look like the same kind of absence rather than two different bugs.
 */
function emptyChart(empty, detail) {
  // The second sentence is overridable because the generic one is wrong for a
  // chart whose data has to be *computed* rather than recorded: a distribution
  // appears once the simulation has been run, and "nothing has been recorded"
  // sends the reader looking for data entry that was never the problem.
  return html`<div class="empty"><b>${empty}</b>${
    detail ?? 'Nothing has been recorded that this can be drawn from.'
  }</div>`;
}

/**
 * Wrap an SVG body in the chart frame.
 *
 * `title` is the accessible name and `desc` the one-sentence summary a screen
 * reader hears instead of the shapes. Both are required by the signature rather
 * than optional, because an optional accessible name is one nobody writes.
 */
function frame({ title, desc, body, box = BOX, legend, footnote, className = '' }) {
  return html`<figure class="chart ${raw(className)}">
    <svg
      viewBox="0 0 ${raw(box.w)} ${raw(box.h)}"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="${title}"
      class="chart-svg"
    >
      <title>${title}</title>
      <desc>${desc}</desc>
      ${body}
    </svg>
    ${legend ? html`<figcaption class="chart-legend">${legend}</figcaption>` : ''}
    ${footnote ? html`<p class="chart-foot">${footnote}</p>` : ''}
  </figure>`;
}

/** A legend row: a swatch and a name, optionally a value. */
/** @param {{label: string, colour?: string, value?: Scalar}[]} entries */
export function legend(entries) {
  return entries.map(
    (entry, index) =>
      html`<span class="chart-key"
        ><i style="background:${raw(paint(entry.colour, index))}"></i>${entry.label}${
          entry.value === undefined ? '' : html` <b>${entry.value}</b>`
        }</span
      >`,
  );
}

/** The horizontal grid and the value axis, shared by every cartesian chart. */
function valueAxis(area, ticks, y, format) {
  return ticks.map(
    (tick) => html`<g class="chart-grid">
      <line x1="${raw(r2(area.x))}" y1="${raw(r2(y(tick)))}" x2="${raw(r2(area.x + area.w))}" y2="${raw(r2(y(tick)))}" />
      <text x="${raw(r2(area.x - 8))}" y="${raw(r2(y(tick) + 4))}" text-anchor="end">${format(tick)}</text>
    </g>`,
  );
}

/**
 * Category labels along the bottom, thinned so they never overlap.
 *
 * A chart of fifty weeks cannot show fifty labels at this width, and drawing
 * them anyway produces the grey smear every dashboard has somewhere. Every nth
 * is shown, chosen from how many will fit.
 */
function categoryAxis(area, labels, bandWidth) {
  const perLabel = 62;
  const stride = Math.max(1, Math.ceil((labels.length * bandWidth) / (area.w / (area.w / perLabel))) / bandWidth | 0) || 1;
  const step = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(area.w / perLabel))));
  const chosen = stride && step ? step : 1;
  return labels.map((label, index) =>
    index % chosen === 0
      ? html`<text
          class="chart-cat"
          x="${raw(r2(area.x + index * bandWidth + bandWidth / 2))}"
          y="${raw(r2(area.y + area.h + 20))}"
          text-anchor="middle"
        >
          ${label}
        </text>`
      : '',
  );
}

// ═══════════════════════════════════════════════════ comparison and trends ══

/**
 * Bar chart — values across categories.
 *
 * `series` may hold one entry (a plain bar chart) or several. Several are drawn
 * grouped by default and stacked when `stacked` is set; a grouped chart answers
 * "which is biggest" and a stacked one answers "what is the total made of",
 * which are different questions and should not share a default.
 */
/** @param {{data?: Row[], series?: Series[], stacked?: boolean, horizontal?: boolean, title?: string, desc?: string, format?: Formatter, empty?: string, footnote?: string}} options */
export function barChart({
  data = [],
  series,
  stacked = false,
  horizontal = false,
  title = 'Bar chart',
  desc,
  format = tickLabel,
  empty = 'Nothing to compare yet',
  footnote,
}) {
  const rows = data.filter((row) => row && row.label !== undefined);
  if (rows.length === 0) return emptyChart(empty);

  // One series unless the caller named more. `value` is the shorthand.
  const keys = series ?? [{ key: 'value', label: title }];
  const valueOf = (row, key) => num(row[key]);

  if (horizontal) return horizontalBars({ rows, keys, title, desc, format, footnote });

  const totals = rows.map((row) => (stacked ? keys.reduce((sum, k) => sum + valueOf(row, k.key), 0) : Math.max(...keys.map((k) => valueOf(row, k.key)))));
  const lows = rows.map((row) => (stacked ? 0 : Math.min(...keys.map((k) => valueOf(row, k.key)))));
  const axis = niceScale(Math.min(0, ...lows), Math.max(...totals));
  const area = plot();
  const y = scale(axis.min, axis.max, area.y + area.h, area.y);
  const band = area.w / rows.length;
  const inner = band * 0.68;
  const barWidth = stacked ? inner : inner / keys.length;

  const bars = rows.map((row, rowIndex) => {
    const left = area.x + rowIndex * band + (band - inner) / 2;
    let stackTop = 0;
    return keys.map((key, keyIndex) => {
      const value = valueOf(row, key.key);
      const colour = paint(key.colour, keyIndex);
      const x = stacked ? left : left + keyIndex * barWidth;
      const top = stacked ? y(stackTop + value) : y(Math.max(0, value));
      const bottom = stacked ? y(stackTop) : y(Math.min(0, value));
      stackTop += value;
      const height = Math.abs(bottom - top);
      return html`<rect
        class="chart-bar"
        x="${raw(r2(x))}"
        y="${raw(r2(top))}"
        width="${raw(r2(Math.max(1, barWidth - 2)))}"
        height="${raw(r2(Math.max(0, height)))}"
        fill="${raw(colour)}"
      >
        <title>${row.label} · ${key.label}: ${format(value)}</title>
      </rect>`;
    });
  });

  return frame({
    title,
    desc: desc ?? `${rows.length} categor${rows.length === 1 ? 'y' : 'ies'}, ${keys.length} series. Highest ${format(Math.max(...totals))}.`,
    footnote,
    body: html`${valueAxis(area, axis.ticks, y, format)}
      <line
        class="chart-axis"
        x1="${raw(r2(area.x))}"
        y1="${raw(r2(y(0)))}"
        x2="${raw(r2(area.x + area.w))}"
        y2="${raw(r2(y(0)))}"
      />
      ${bars} ${categoryAxis(area, rows.map((row) => row.label), band)}`,
    legend: keys.length > 1 ? legend(keys.map((key, index) => ({ label: key.label, colour: key.colour ?? seriesColour(index) }))) : undefined,
  });
}

/** The horizontal variant — for long category names, which is most of them. */
/**
 * A category label cut to the gutter it has to live in.
 *
 * Horizontal bars are the chart type you reach for *because* the labels are
 * long — risk titles, package names, supplier names — and a label wider than
 * the gutter is drawn at a negative x and clipped by the viewBox edge, which
 * loses the beginning of the word rather than the end. Truncating keeps the
 * part that identifies the row and puts the whole label in a `<title>`, so it
 * is still there on hover and for a screen reader.
 *
 * 0.55em per character is a deliberate over-estimate for this face at this
 * size: a budget that is slightly too tight leaves a gap, and one that is too
 * loose clips again.
 */
function fitLabel(label, gutterPx, fontPx = 10.5) {
  const text = String(label ?? '');
  const budget = Math.max(4, Math.floor(gutterPx / (fontPx * 0.55)));
  return text.length <= budget ? text : `${text.slice(0, budget - 1).trimEnd()}…`;
}

function horizontalBars({ rows, keys, title, desc, format, footnote }) {
  const box = { w: 720, h: Math.max(120, 34 * rows.length + 40) };
  const pad = { top: 12, right: 60, bottom: 26, left: 168 };
  const area = plot(box, pad);
  const axis = niceScale(0, Math.max(...rows.map((row) => Math.max(...keys.map((k) => num(row[k.key]))))));
  const x = scale(axis.min, axis.max, area.x, area.x + area.w);
  const band = area.h / rows.length;

  return frame({
    title,
    desc: desc ?? `${rows.length} rows ranked by value.`,
    box,
    footnote,
    body: html`${axis.ticks.map(
      (tick) => html`<g class="chart-grid">
        <line x1="${raw(r2(x(tick)))}" y1="${raw(r2(area.y))}" x2="${raw(r2(x(tick)))}" y2="${raw(r2(area.y + area.h))}" />
        <text x="${raw(r2(x(tick)))}" y="${raw(r2(area.y + area.h + 18))}" text-anchor="middle">${format(tick)}</text>
      </g>`,
    )}
    ${rows.map((row, index) => {
      const value = num(row[keys[0].key]);
      const top = area.y + index * band + band * 0.18;
      const height = band * 0.64;
      // A second line under the label, where the caller gave one. Bar lists in
      // this product routinely carry a qualifier the bar itself cannot say —
      // "6 executions · 41%", "runway 12 days" — and dropping it would make the
      // chart shorter and the screen less informative.
      const sub = typeof row.sub === 'string' && row.sub.trim() !== '' ? row.sub : undefined;
      const labelY = sub ? top + height / 2 - 1 : top + height / 2 + 4;

      return html`<g>
        <text class="chart-cat" x="${raw(r2(area.x - 10))}" y="${raw(r2(labelY))}" text-anchor="end">
          <title>${row.label}</title>${fitLabel(row.label, pad.left - 12)}
        </text>
        ${sub
          ? html`<text class="chart-foot" x="${raw(r2(area.x - 10))}" y="${raw(r2(labelY + 11))}" text-anchor="end">
              ${fitLabel(sub, pad.left - 12, 9)}
            </text>`
          : ''}
        <rect
          class="chart-bar"
          x="${raw(r2(area.x))}"
          y="${raw(r2(top))}"
          width="${raw(r2(Math.max(1, x(value) - area.x)))}"
          height="${raw(r2(height))}"
          fill="${raw(paint(row.tone ?? keys[0].colour, 0))}"
        >
          <title>${row.label}: ${format(value)}</title>
        </rect>
        <text class="chart-value" x="${raw(r2(x(value) + 8))}" y="${raw(r2(top + height / 2 + 4))}">${format(value)}</text>
      </g>`;
    })}`,
  });
}

/**
 * Line chart — a value over time.
 *
 * A missing point breaks the line rather than being bridged. Bridging is
 * interpolation, interpolation is invention, and a reader cannot tell an
 * invented segment from a measured one once it is drawn.
 */
/** @param {{data?: Row[], series?: Series[], title?: string, desc?: string, format?: Formatter, area?: boolean, empty?: string, markers?: boolean, footnote?: string, reference?: {value: number, label: string, tone?: string}[]}} options */
export function lineChart({
  data = [],
  series = [{ key: 'value', label: 'Value' }],
  title = 'Trend',
  desc,
  format = tickLabel,
  area: filled = false,
  empty = 'No trend recorded yet',
  markers = true,
  footnote,
  reference,
}) {
  const rows = data.filter((row) => row && row.label !== undefined);
  if (rows.length === 0) return emptyChart(empty);

  const values = rows.flatMap((row) => series.map((s) => row[s.key])).filter(finite).map(Number);
  if (values.length === 0) return emptyChart(empty);

  const referenceValues = (reference ?? []).map((line) => num(line.value));
  const axis = niceScale(Math.min(...values, ...referenceValues), Math.max(...values, ...referenceValues), {
    // A trend is about movement, so it may start above zero — but only when
    // every value is comfortably clear of it, otherwise the movement is an
    // artefact of the axis.
    zeroBased: Math.min(...values) < Math.max(...values) * 0.35,
  });
  const box = BOX;
  const areaBox = plot(box);
  const y = scale(axis.min, axis.max, areaBox.y + areaBox.h, areaBox.y);
  const step = rows.length === 1 ? 0 : areaBox.w / (rows.length - 1);
  const px = (index) => areaBox.x + (rows.length === 1 ? areaBox.w / 2 : index * step);

  const paths = series.map((s, seriesIndex) => {
    const colour = paint(s.colour, seriesIndex);
    // Segments, not one path: a gap in the data is a gap on the chart.
    const segments = [];
    let current = [];
    rows.forEach((row, index) => {
      if (finite(row[s.key])) current.push([px(index), y(row[s.key])]);
      else if (current.length) {
        segments.push(current);
        current = [];
      }
    });
    if (current.length) segments.push(current);

    const line = segments
      .map((segment) => segment.map(([cx, cy], i) => `${i === 0 ? 'M' : 'L'}${r2(cx)} ${r2(cy)}`).join(' '))
      .join(' ');

    const fill = filled
      ? segments
          .filter((segment) => segment.length > 1)
          .map(
            (segment) =>
              `M${r2(segment[0][0])} ${r2(y(Math.max(axis.min, 0)))} ` +
              segment.map(([cx, cy]) => `L${r2(cx)} ${r2(cy)}`).join(' ') +
              ` L${r2(segment[segment.length - 1][0])} ${r2(y(Math.max(axis.min, 0)))} Z`,
          )
          .join(' ')
      : '';

    // A series named for one of the plan-against-reality states carries that
    // state's stroke pattern as well as its colour. Colour alone is not an
    // encoding: a reader who cannot separate blue from purple still has to be
    // able to tell a forecast from a measurement.
    const dash = toneDash(s.colour ?? s.tone);

    return html`${filled && fill ? html`<path d="${raw(fill)}" fill="${raw(colour)}" opacity="0.16" />` : ''}
      <path class="chart-line" d="${raw(line)}" stroke="${raw(colour)}" fill="none"${raw(dash ? ` stroke-dasharray="${dash}"` : '')} />
      ${markers
        ? rows.map((row, index) =>
            finite(row[s.key])
              ? html`<circle class="chart-dot" cx="${raw(r2(px(index)))}" cy="${raw(r2(y(row[s.key])))}" r="3.4" fill="${raw(colour)}">
                  <title>${row.label} · ${s.label}: ${format(row[s.key])}</title>
                </circle>`
              : '',
          )
        : ''}`;
  });

  return frame({
    title,
    desc:
      desc ??
      `${rows.length} point${rows.length === 1 ? '' : 's'} from ${rows[0].label} to ${rows[rows.length - 1].label}. ` +
        `Range ${format(Math.min(...values))} to ${format(Math.max(...values))}.`,
    footnote,
    body: html`${valueAxis(areaBox, axis.ticks, y, format)}
      ${(reference ?? []).map(
        (line) => html`<g class="chart-ref">
          <line
            x1="${raw(r2(areaBox.x))}"
            y1="${raw(r2(y(line.value)))}"
            x2="${raw(r2(areaBox.x + areaBox.w))}"
            y2="${raw(r2(y(line.value)))}"
            stroke="${raw(paint(line.tone ?? 'warn'))}"${raw(toneDash(line.tone) ? ` stroke-dasharray="${toneDash(line.tone)}"` : '')}
          />
          <text x="${raw(r2(areaBox.x + areaBox.w))}" y="${raw(r2(y(line.value) - 6))}" text-anchor="end" fill="${raw(paint(line.tone ?? 'warn'))}">
            ${line.label}
          </text>
        </g>`,
      )}
      ${paths} ${categoryAxis(areaBox, rows.map((row) => row.label), step || areaBox.w)}`,
    legend: series.length > 1 ? legend(series.map((s, i) => ({ label: s.label, colour: s.colour ?? seriesColour(i) }))) : undefined,
  });
}

/** Area chart — a line chart with the area under it filled. */
export function areaChart(options) {
  return lineChart({ ...options, area: true, title: options.title ?? 'Area' });
}

/**
 * Pie and donut — parts of a whole.
 *
 * Refuses to draw parts of a whole that is not one. A pie of values that do not
 * share a total is the most common chart mistake there is, so a slice whose
 * value is negative is refused outright rather than drawn as a gap.
 */
/** @param {{data?: Row[], title?: string, desc?: string, donut?: boolean, format?: Formatter, empty?: string, centreLabel?: string, footnote?: string}} options */
export function pieChart({
  data = [],
  title = 'Composition',
  desc,
  donut = true,
  format = tickLabel,
  empty = 'Nothing to break down yet',
  centreLabel,
  footnote,
}) {
  const slices = data.filter((slice) => slice && finite(slice.value) && Number(slice.value) > 0);
  if (slices.length === 0) return emptyChart(empty);

  const total = slices.reduce((sum, slice) => sum + Number(slice.value), 0);
  const box = { w: 420, h: 300 };
  const cx = 150;
  const cy = 150;
  const outer = 116;
  const inner = donut ? 68 : 0;

  // Resolved once for the whole chart, so a slice and its legend swatch cannot
  // disagree and an untoned slice cannot land on a toned slice's colour.
  const colours = assignColours(slices);

  let angle = -Math.PI / 2;
  const arcs = slices.map((slice, index) => {
    const share = Number(slice.value) / total;
    const sweep = share * Math.PI * 2;
    const end = angle + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (radius, at) => `${r2(cx + radius * Math.cos(at))} ${r2(cy + radius * Math.sin(at))}`;
    // A single slice at 100% cannot be drawn as an arc — start and end are the
    // same point, and the path collapses to nothing. Drawn as two half-circles.
    const path =
      share >= 0.9999
        ? `M ${r2(cx)} ${r2(cy - outer)} A ${outer} ${outer} 0 1 1 ${r2(cx - 0.01)} ${r2(cy - outer)} Z` +
          (inner ? ` M ${r2(cx)} ${r2(cy - inner)} A ${inner} ${inner} 0 1 0 ${r2(cx - 0.01)} ${r2(cy - inner)} Z` : '')
        : `M ${p(inner, angle)} L ${p(outer, angle)} A ${outer} ${outer} 0 ${large} 1 ${p(outer, end)} L ${p(inner, end)}` +
          (inner ? ` A ${inner} ${inner} 0 ${large} 0 ${p(inner, angle)}` : '') +
          ' Z';
    angle = end;
    return html`<path class="chart-slice" d="${raw(path)}" fill="${raw(colours[index])}" fill-rule="evenodd">
      <title>${slice.label}: ${format(slice.value)} (${raw(r2(share * 100))}%)</title>
    </path>`;
  });

  return frame({
    title,
    box,
    desc: desc ?? `${slices.length} parts of ${format(total)}. Largest ${slices.reduce((a, b) => (Number(a.value) > Number(b.value) ? a : b)).label}.`,
    footnote,
    body: html`${arcs}
      ${donut
        ? html`<text class="chart-centre" x="${raw(cx)}" y="${raw(cy - 2)}" text-anchor="middle">${centreLabel ?? format(total)}</text>
            <text class="chart-centre-sub" x="${raw(cx)}" y="${raw(cy + 18)}" text-anchor="middle">total</text>`
        : ''}
      ${slices.map(
        (slice, index) => html`<g class="chart-key-svg" transform="translate(288, ${raw(38 + index * 22)})">
          <rect width="10" height="10" rx="2" fill="${raw(colours[index])}" />
          <text x="16" y="9">${slice.label}</text>
        </g>`,
      )}`,
  });
}

/** Donut is the default; named so a caller can say what they mean. */
export const donutChart = (options) => pieChart({ ...options, donut: true });

// ═══════════════════════════════════════════ distribution and correlation ══

/**
 * Histogram — how a set of numbers is distributed.
 *
 * Bins are computed with the Freedman–Diaconis rule where there is enough data
 * for it and Sturges' where there is not. The bin count changes the shape of a
 * histogram completely, so it is derived from the data rather than left at a
 * default of ten — which is how a bimodal distribution gets drawn as a hump.
 */
/** @param {{values?: Scalar[], buckets?: Bucket[], title?: string, desc?: string, format?: Formatter, bins?: number, empty?: string, emptyDetail?: string, tone?: string, limit?: number, limitLabel?: string, markLabel?: string, markPast?: 'above'|'below', footnote?: string}} options */
export function histogram({
  values = [],
  buckets: given,
  title = 'Distribution',
  desc,
  format = tickLabel,
  bins,
  empty = 'Not enough measurements to show a distribution',
  emptyDetail,
  tone = 'accent',
  limit,
  limitLabel = '',
  markLabel = '',
  markPast = 'above',
  footnote,
}) {
  // Two ways in, one picture out.
  //
  // `values` is raw and this bins it. `buckets` is already binned, which is the
  // only honest input where the binning happened somewhere this cannot see —
  // a Monte Carlo run whose distribution is computed server-side and whose raw
  // trials were never sent. Rebinning a summary would invent a shape the
  // simulation did not produce.
  // `limit` means two different things because the two inputs are two different
  // charts, and conflating them would mis-mark whichever came second.
  //
  // With raw `values` the picture is a *distribution* and the limit is a
  // threshold on the measured quantity — a P80 duration — so it is a vertical
  // line and it marks the bins holding values beyond it.
  //
  // With pre-binned `buckets` the picture is almost always a *profile* over
  // time, and the limit is a ceiling on the bar height — the labour available
  // per day — so it is a horizontal line and it marks the bars that exceed it.
  const preBinned = Array.isArray(given) && given.length > 0;
  if (!preBinned && values.filter(finite).length < 2) return emptyChart(empty, emptyDetail);

  const sample = preBinned ? [] : values.filter(finite).map(Number).sort((a, b) => a - b);
  const bucketList = preBinned
    ? given.map((bucket) => {
        const n = num(bucket.count);
        const over = finite(limit) && (markPast === 'below' ? n < Number(limit) : n > Number(limit));
        return { from: bucket.label, to: bucket.label, n, marked: bucket.marked === true || over };
      })
    : (() => {
        const min = sample[0];
        const max = sample[sample.length - 1];
        const count = bins ?? binCount(sample);
        const width = (max - min) / count || 1;
        const made = Array.from({ length: count }, (_, index) => ({
          from: min + index * width,
          to: min + (index + 1) * width,
          n: 0,
          marked: false,
        }));
        for (const value of sample) {
          // The last bucket is closed at the top, so the maximum lands in it
          // rather than in a bucket past the end of the array.
          const index = Math.min(count - 1, Math.floor((value - min) / width));
          made[index].n += 1;
        }
        // A threshold marks every bucket that *contains* a value past it, not
        // only those starting past it.
        //
        // The strict reading marks nothing whenever the limit falls inside a
        // bucket, which is the common case — the reader then sees a threshold
        // line with no marking and concludes nothing is beyond it, which is
        // false. A bucket straddling the line does hold values past it, and
        // saying so overstates far less than saying nothing does.
        if (finite(limit)) {
          for (const bucket of made) {
            bucket.marked = markPast === 'below' ? bucket.from < Number(limit) : bucket.to > Number(limit);
          }
        }
        return made;
      })();

  const buckets = bucketList;
  const count = buckets.length;
  const min = preBinned ? 0 : sample[0];
  const max = preBinned ? 0 : sample[sample.length - 1];
  const median = preBinned ? undefined : sample[Math.floor(sample.length / 2)];

  // The ceiling includes the limit even where no bar reaches it. A chart scaled
  // only to its bars would draw the capacity line off the top and tell the
  // reader nothing is near it — which is the opposite of what the chart is for.
  const axis = niceScale(
    0,
    Math.max(...buckets.map((b) => b.n), preBinned && finite(limit) ? Number(limit) : 0),
  );
  const area = plot();
  const y = scale(axis.min, axis.max, area.y + area.h, area.y);
  const band = area.w / count;
  const marked = buckets.filter((bucket) => bucket.marked).length;

  const label = (bucket) => (preBinned ? String(bucket.from) : format(bucket.from));

  return frame({
    title,
    footnote,
    desc:
      desc ??
      (preBinned
        ? `${count} bins${marked > 0 ? `, ${marked} past ${limitLabel || 'the threshold'}` : ''}.`
        : `${sample.length} measurements from ${format(min)} to ${format(max)} in ${count} bins.` +
          ` Median ${format(median)}.` +
          (marked > 0 ? ` ${marked} bins past ${limitLabel || 'the threshold'}.` : '')),
    body: html`${valueAxis(area, axis.ticks, y, (t) => String(t))}
      ${buckets.map(
        (bucket, index) => html`<rect
          class="chart-bar"
          x="${raw(r2(area.x + index * band))}"
          y="${raw(r2(y(bucket.n)))}"
          width="${raw(r2(Math.max(1, band - 1.5)))}"
          height="${raw(r2(Math.max(0, y(0) - y(bucket.n))))}"
          fill="${raw(paint(bucket.marked ? 'warn' : tone))}"
        >
          <title>${label(bucket)}${preBinned ? '' : ` to ${format(bucket.to)}`}: ${raw(bucket.n)}${
            bucket.marked && markLabel ? ` — ${markLabel}` : ''
          }</title>
        </rect>`,
      )}
      <line class="chart-axis" x1="${raw(r2(area.x))}" y1="${raw(r2(y(0)))}" x2="${raw(r2(area.x + area.w))}" y2="${raw(r2(y(0)))}" />
      ${
        // A capacity line, across the bars, where the input was pre-binned.
        preBinned && finite(limit)
          ? html`<g class="chart-ref">
              <line
                x1="${raw(r2(area.x))}"
                y1="${raw(r2(y(Number(limit))))}"
                x2="${raw(r2(area.x + area.w))}"
                y2="${raw(r2(y(Number(limit))))}"
              />
              <text class="chart-axis-label" x="${raw(r2(area.x + 4))}" y="${raw(r2(y(Number(limit)) - 5))}">
                ${limitLabel || format(Number(limit))}
              </text>
            </g>`
          : ''
      }
      ${
        // A threshold on the measured quantity, where the values were binned
        // here and the x scale is a real number line.
        !preBinned && finite(limit) && Number(limit) >= min && Number(limit) <= max
          ? html`<g class="chart-ref">
              <line
                x1="${raw(r2(area.x + ((Number(limit) - min) / ((max - min) || 1)) * area.w))}"
                y1="${raw(r2(area.y))}"
                x2="${raw(r2(area.x + ((Number(limit) - min) / ((max - min) || 1)) * area.w))}"
                y2="${raw(r2(y(0)))}"
              />
              <text
                class="chart-axis-label"
                x="${raw(r2(area.x + ((Number(limit) - min) / ((max - min) || 1)) * area.w + 4))}"
                y="${raw(r2(area.y + 12))}"
              >${limitLabel || format(Number(limit))}</text>
            </g>`
          : ''
      }
      ${[0, Math.floor(count / 2), count - 1].map(
        (index) => html`<text class="chart-cat" x="${raw(r2(area.x + index * band + band / 2))}" y="${raw(r2(area.y + area.h + 20))}" text-anchor="middle">
          ${label(buckets[index])}
        </text>`,
      )}`,
  });
}

/** Freedman–Diaconis where the interquartile range is usable, Sturges otherwise. */
function binCount(sorted) {
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const iqr = q(0.75) - q(0.25);
  const span = sorted[sorted.length - 1] - sorted[0];
  if (iqr > 0 && span > 0) {
    const width = (2 * iqr) / Math.cbrt(sorted.length);
    if (width > 0) return Math.max(4, Math.min(24, Math.ceil(span / width)));
  }
  return Math.max(4, Math.min(24, Math.ceil(Math.log2(sorted.length) + 1)));
}

/**
 * Scatter plot — whether two measurements move together.
 *
 * Draws the least-squares fit only when asked, and labels it with r² so a reader
 * can see how much of the scatter the line actually explains. A trend line with
 * no r² beside it is a claim with its evidence removed.
 */
/** @param {{points?: Point[], title?: string, desc?: string, xLabel?: string, yLabel?: string, formatX?: Formatter, formatY?: Formatter, fit?: boolean, empty?: string, tone?: string, footnote?: string}} options */
export function scatterPlot({
  points = [],
  title = 'Correlation',
  desc,
  xLabel = 'x',
  yLabel = 'y',
  formatX = tickLabel,
  formatY = tickLabel,
  fit = false,
  empty = 'Not enough paired measurements to plot',
  tone = 'info',
  footnote,
}) {
  const data = points.filter((point) => point && finite(point.x) && finite(point.y));
  if (data.length < 2) return emptyChart(empty);

  const xs = data.map((p) => Number(p.x));
  const ys = data.map((p) => Number(p.y));
  const xAxis = niceScale(Math.min(...xs), Math.max(...xs), { zeroBased: false });
  const yAxis = niceScale(Math.min(...ys), Math.max(...ys), { zeroBased: false });
  const area = plot();
  const x = scale(xAxis.min, xAxis.max, area.x, area.x + area.w);
  const y = scale(yAxis.min, yAxis.max, area.y + area.h, area.y);

  const line = fit ? leastSquares(xs, ys) : undefined;

  return frame({
    title,
    footnote,
    desc:
      desc ??
      `${data.length} paired measurements of ${yLabel} against ${xLabel}` +
        // r² to three places, not two. A fit that explains 99.8% of the scatter
        // and one that explains all of it are different claims, and rounding
        // both to "1" reports the weaker one as perfect.
        (line ? `. Fitted slope ${r2(line.slope)}, r² ${Math.round(line.r2 * 1000) / 1000}.` : '.'),
    body: html`${valueAxis(area, yAxis.ticks, y, formatY)}
      ${xAxis.ticks.map(
        (tick) => html`<g class="chart-grid">
          <line x1="${raw(r2(x(tick)))}" y1="${raw(r2(area.y))}" x2="${raw(r2(x(tick)))}" y2="${raw(r2(area.y + area.h))}" />
          <text x="${raw(r2(x(tick)))}" y="${raw(r2(area.y + area.h + 18))}" text-anchor="middle">${formatX(tick)}</text>
        </g>`,
      )}
      ${line
        ? html`<line
            class="chart-fit"
            x1="${raw(r2(x(xAxis.min)))}"
            y1="${raw(r2(y(line.at(xAxis.min))))}"
            x2="${raw(r2(x(xAxis.max)))}"
            y2="${raw(r2(y(line.at(xAxis.max))))}"
            stroke="${raw(paint('warn'))}"
          >
            <title>Least-squares fit · r² ${raw(Math.round(line.r2 * 1000) / 1000)}</title>
          </line>`
        : ''}
      ${data.map(
        (point) => html`<circle
          class="chart-dot"
          cx="${raw(r2(x(point.x)))}"
          cy="${raw(r2(y(point.y)))}"
          r="4"
          fill="${raw(paint(point.tone ?? tone))}"
          opacity="0.85"
        >
          <title>${point.label ?? ''}${point.label ? ' · ' : ''}${xLabel} ${formatX(point.x)}, ${yLabel} ${formatY(point.y)}</title>
        </circle>`,
      )}
      <text class="chart-axis-label" x="${raw(r2(area.x + area.w / 2))}" y="${raw(BOX.h - 4)}" text-anchor="middle">${xLabel}</text>`,
  });
}

/** Ordinary least squares, with the coefficient of determination. */
function leastSquares(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    sxx += (xs[i] - meanX) ** 2;
    syy += (ys[i] - meanY) ** 2;
  }
  // A vertical cloud has no slope. Reported as flat with no explanatory power
  // rather than as a division by zero drawn off the top of the chart.
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2Value = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2: r2Value, at: (x) => intercept + slope * x };
}

/**
 * Bubble chart — a scatter plot where size carries a third measurement.
 *
 * Radius is scaled by the **square root** of the value, so the area is
 * proportional rather than the radius. Scaling the radius directly makes a value
 * twice as large look four times as big, which is the whole reason bubble charts
 * have a bad name.
 */
/** @param {{points?: Point[], title?: string, desc?: string, xLabel?: string, yLabel?: string, zLabel?: string, formatX?: Formatter, formatY?: Formatter, formatZ?: Formatter, empty?: string, footnote?: string}} options */
export function bubbleChart({
  points = [],
  title = 'Three measurements',
  desc,
  xLabel = 'x',
  yLabel = 'y',
  zLabel = 'size',
  formatX = tickLabel,
  formatY = tickLabel,
  formatZ = tickLabel,
  empty = 'Not enough measurements to plot',
  footnote,
}) {
  const data = points.filter((p) => p && finite(p.x) && finite(p.y) && finite(p.z) && Number(p.z) >= 0);
  if (data.length === 0) return emptyChart(empty);

  const xs = data.map((p) => Number(p.x));
  const ys = data.map((p) => Number(p.y));
  const zs = data.map((p) => Number(p.z));
  const xAxis = niceScale(Math.min(...xs), Math.max(...xs), { zeroBased: false });
  const yAxis = niceScale(Math.min(...ys), Math.max(...ys), { zeroBased: false });
  const area = plot();
  const x = scale(xAxis.min, xAxis.max, area.x, area.x + area.w);
  const y = scale(yAxis.min, yAxis.max, area.y + area.h, area.y);
  const maxZ = Math.max(...zs);
  const radius = (z) => (maxZ <= 0 ? 8 : 5 + Math.sqrt(Number(z) / maxZ) * 26);

  return frame({
    title,
    footnote,
    desc: desc ?? `${data.length} items placed by ${xLabel} and ${yLabel}, sized by ${zLabel}. Bubble area is proportional to ${zLabel}.`,
    body: html`${valueAxis(area, yAxis.ticks, y, formatY)}
      ${xAxis.ticks.map(
        (tick) => html`<g class="chart-grid">
          <line x1="${raw(r2(x(tick)))}" y1="${raw(r2(area.y))}" x2="${raw(r2(x(tick)))}" y2="${raw(r2(area.y + area.h))}" />
          <text x="${raw(r2(x(tick)))}" y="${raw(r2(area.y + area.h + 18))}" text-anchor="middle">${formatX(tick)}</text>
        </g>`,
      )}
      ${data
        // Largest first, so a big bubble never hides a small one behind it.
        .slice()
        .sort((a, b) => Number(b.z) - Number(a.z))
        .map(
          (point, index) => html`<circle
            class="chart-bubble"
            cx="${raw(r2(x(point.x)))}"
            cy="${raw(r2(y(point.y)))}"
            r="${raw(r2(radius(point.z)))}"
            fill="${raw(paint(point.tone, index))}"
            opacity="0.55"
          >
            <title>${point.label ?? ''}${point.label ? ' · ' : ''}${xLabel} ${formatX(point.x)}, ${yLabel} ${formatY(point.y)}, ${zLabel} ${formatZ(point.z)}</title>
          </circle>`,
        )}
      <text class="chart-axis-label" x="${raw(r2(area.x + area.w / 2))}" y="${raw(BOX.h - 4)}" text-anchor="middle">${xLabel}</text>`,
  });
}

/**
 * Box plot — spread, median and outliers.
 *
 * Outliers are drawn individually beyond 1.5 × IQR rather than being swallowed
 * by the whisker. On this platform an outlier is usually the interesting record:
 * the one valuation, the one week, the one supplier.
 */
/** @param {{groups?: Group[], title?: string, desc?: string, format?: Formatter, empty?: string, footnote?: string}} options */
export function boxPlot({
  groups = [],
  title = 'Spread',
  desc,
  format = tickLabel,
  empty = 'Not enough measurements to show a spread',
  footnote,
}) {
  const boxes = groups
    .map((group) => ({ label: group.label, stats: quartiles((group.values ?? []).filter(finite).map(Number)), tone: group.tone }))
    .filter((group) => group.stats !== undefined);
  if (boxes.length === 0) return emptyChart(empty);

  const all = boxes.flatMap((box) => [box.stats.low, box.stats.high, ...box.stats.outliers]);
  const axis = niceScale(Math.min(...all), Math.max(...all), { zeroBased: false });
  const area = plot();
  const y = scale(axis.min, axis.max, area.y + area.h, area.y);
  const band = area.w / boxes.length;
  const width = Math.min(64, band * 0.5);

  return frame({
    title,
    footnote,
    desc:
      desc ??
      `${boxes.length} group${boxes.length === 1 ? '' : 's'}. Box is the middle half, line is the median, points beyond the whiskers are outliers.`,
    body: html`${valueAxis(area, axis.ticks, y, format)}
      ${boxes.map((box, index) => {
        const cx = area.x + index * band + band / 2;
        const s = box.stats;
        const colour = paint(box.tone, index);
        return html`<g>
          <line class="chart-whisker" x1="${raw(r2(cx))}" y1="${raw(r2(y(s.low)))}" x2="${raw(r2(cx))}" y2="${raw(r2(y(s.high)))}" stroke="${raw(colour)}" />
          <line class="chart-whisker" x1="${raw(r2(cx - width / 3))}" y1="${raw(r2(y(s.low)))}" x2="${raw(r2(cx + width / 3))}" y2="${raw(r2(y(s.low)))}" stroke="${raw(colour)}" />
          <line class="chart-whisker" x1="${raw(r2(cx - width / 3))}" y1="${raw(r2(y(s.high)))}" x2="${raw(r2(cx + width / 3))}" y2="${raw(r2(y(s.high)))}" stroke="${raw(colour)}" />
          <rect
            class="chart-box"
            x="${raw(r2(cx - width / 2))}"
            y="${raw(r2(y(s.q3)))}"
            width="${raw(r2(width))}"
            height="${raw(r2(Math.max(1, y(s.q1) - y(s.q3))))}"
            fill="${raw(colour)}"
            opacity="0.28"
            stroke="${raw(colour)}"
          >
            <title>${box.label} · median ${format(s.median)}, middle half ${format(s.q1)} to ${format(s.q3)}, ${raw(s.n)} measurements</title>
          </rect>
          <line
            class="chart-median"
            x1="${raw(r2(cx - width / 2))}"
            y1="${raw(r2(y(s.median)))}"
            x2="${raw(r2(cx + width / 2))}"
            y2="${raw(r2(y(s.median)))}"
            stroke="${raw(colour)}"
          />
          ${s.outliers.map(
            (value) => html`<circle class="chart-outlier" cx="${raw(r2(cx))}" cy="${raw(r2(y(value)))}" r="3" fill="${raw(paint('bad'))}">
              <title>${box.label} · outlier ${format(value)}</title>
            </circle>`,
          )}
          <text class="chart-cat" x="${raw(r2(cx))}" y="${raw(r2(area.y + area.h + 20))}" text-anchor="middle">${box.label}</text>
        </g>`;
      })}`,
  });
}

/** Quartiles by linear interpolation, with the 1.5 × IQR fences. */
function quartiles(values) {
  if (values.length < 4) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (p) => {
    const position = p * (sorted.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  };
  const q1 = at(0.25);
  const median = at(0.5);
  const q3 = at(0.75);
  const iqr = q3 - q1;
  const fenceLow = q1 - 1.5 * iqr;
  const fenceHigh = q3 + 1.5 * iqr;
  const inside = sorted.filter((value) => value >= fenceLow && value <= fenceHigh);
  return {
    q1,
    median,
    q3,
    low: inside.length ? inside[0] : sorted[0],
    high: inside.length ? inside[inside.length - 1] : sorted[sorted.length - 1],
    outliers: sorted.filter((value) => value < fenceLow || value > fenceHigh),
    n: sorted.length,
  };
}

// ══════════════════════════════════════════ specialised dashboard elements ══

/**
 * Gauge — one value against a target.
 *
 * A 240° arc rather than a full circle, because a gauge that wraps round has no
 * unambiguous zero. The target is a tick on the arc, not a colour change, so
 * "we are at 72% and the target is 80%" reads as two facts rather than one
 * verdict.
 */
/** @param {{value?: Scalar, min?: number, max?: number, target?: number, title?: string, desc?: string, format?: Formatter, tone?: string, label?: string, empty?: string, footnote?: string}} options */
export function gauge({
  value,
  min = 0,
  max = 100,
  target,
  title = 'Progress',
  desc,
  format = (v) => `${r2(v)}%`,
  tone,
  label,
  empty = 'Not measured yet',
  footnote,
}) {
  if (!finite(value)) return emptyChart(empty);

  // Sized so the dial is not blown up, and tall enough for the arc's own ink.
  //
  // Width first: the frame scales its viewBox to the card, so a 320px box in an
  // 850px column was magnified 2.7x and the dial filled two thirds of a screen.
  // The arc keeps its radius and is centred in a wider box instead, which puts
  // the scale near 1.5x and the gauge at the size of the charts beside it.
  //
  // The 240-degree sweep ends 30 degrees below the horizontal, so the lowest
  // point of the path is `cy + radius * sin(30°)` = 212 — already past the box
  // — and a 14px round cap puts the last ink at 219, with the target tick at
  // 217. `.chart svg` sets `overflow: visible` on purpose, so instead of being
  // clipped the arc was drawn over the footnote beneath the card.
  const box = { w: 560, h: 234 };
  const cx = 280;
  const cy = 158;
  const radius = 108;
  const sweep = (Math.PI * 4) / 3; // 240°
  const start = Math.PI / 2 + sweep / 2;
  const clamp = (v) => Math.max(min, Math.min(max, Number(v)));
  const at = (v) => start - ((clamp(v) - min) / (max - min || 1)) * sweep;
  const point = (angle, rad = radius) => `${r2(cx + rad * Math.cos(angle))} ${r2(cy - rad * Math.sin(angle))}`;
  const arc = (from, to) =>
    `M ${point(from)} A ${radius} ${radius} 0 ${Math.abs(from - to) > Math.PI ? 1 : 0} 1 ${point(to)}`;

  // The tone follows the target where there is one, so the colour is a
  // measurement rather than a mood.
  // Blue, not Signal Orange: the standard makes CONSTRUX Blue the data colour
  // and reserves orange for chrome and signal. Where a target exists the dial
  // answers to it instead, because then the colour is a measurement.
  const resolved = tone ?? (target === undefined ? 'actual' : Number(value) >= Number(target) ? 'target' : 'warn');

  return frame({
    title,
    box,
    footnote,
    desc:
      desc ??
      `${format(value)} of a possible ${format(max)}` + (target === undefined ? '.' : `, against a target of ${format(target)}.`),
    className: 'chart-gauge',
    body: html`<path class="chart-gauge-track" d="${raw(arc(start, start - sweep))}" fill="none" />
      <path class="chart-gauge-fill" d="${raw(arc(start, at(value)))}" fill="none" stroke="${raw(paint(resolved))}">
        <title>${title}: ${format(value)}</title>
      </path>
      ${target === undefined
        ? ''
        : html`<line
              class="chart-gauge-target"
              x1="${raw(point(at(target), radius - 16).split(' ')[0])}"
              y1="${raw(point(at(target), radius - 16).split(' ')[1])}"
              x2="${raw(point(at(target), radius + 10).split(' ')[0])}"
              y2="${raw(point(at(target), radius + 10).split(' ')[1])}"
            >
              <title>Target ${format(target)}</title>
            </line>`}
      <text class="chart-gauge-value" x="${raw(cx)}" y="${raw(cy - 18)}" text-anchor="middle">${format(value)}</text>
      <text class="chart-gauge-label" x="${raw(cx)}" y="${raw(cy + 6)}" text-anchor="middle">
        ${label ?? (target === undefined ? '' : `target ${format(target)}`)}
      </text>`,
  });
}

/**
 * KPI card — one number, what moved it, and against what.
 *
 * Not an SVG. A scorecard is typography, and drawing it as a picture makes it
 * unselectable, unsearchable and worse to read at every size. The sparkline
 * inside it is the only drawn part.
 */
/** @param {{label: string, value: Scalar, sub?: string, delta?: Scalar, deltaLabel?: string, tone?: string, spark?: Scalar[], target?: number, format?: Formatter}} options */
export function kpiCard({ label, value, sub, delta, deltaLabel, tone = '', spark, target, format = tickLabel }) {
  const direction = finite(delta) ? (Number(delta) > 0 ? 'up' : Number(delta) < 0 ? 'down' : 'flat') : undefined;
  return html`<div class="card kpi">
    <h3>${label}</h3>
    <div class="metric ${raw(tone)}">${value}</div>
    ${sub ? html`<div class="metric-sub">${sub}</div>` : ''}
    ${direction
      ? html`<div class="kpi-delta ${raw(direction)}">
          <span aria-hidden="true">${raw(direction === 'up' ? '▲' : direction === 'down' ? '▼' : '■')}</span>
          ${raw(r2(Math.abs(Number(delta))))}${deltaLabel ? html` ${deltaLabel}` : ''}
        </div>`
      : ''}
    ${spark && spark.length > 1 ? sparkline({ values: spark, tone, target, format }) : ''}
  </div>`;
}

/**
 * Sparkline — a trend with no axes, sized to sit inside a card.
 *
 * Its own function because it appears in a KPI card, a table cell and a list
 * row, and those are three places that must not each grow their own version.
 */
/** @param {{values?: Scalar[], tone?: string, width?: number, height?: number, target?: number, format?: Formatter}} options */
export function sparkline({ values = [], tone = 'accent', width = 180, height = 34, target, format = tickLabel }) {
  const points = values.filter(finite).map(Number);
  if (points.length < 2) return '';
  const min = Math.min(...points, ...(finite(target) ? [Number(target)] : []));
  const max = Math.max(...points, ...(finite(target) ? [Number(target)] : []));
  const x = scale(0, points.length - 1, 1, width - 1);
  const y = scale(min, max, height - 2, 2);
  const path = points.map((value, index) => `${index === 0 ? 'M' : 'L'}${r2(x(index))} ${r2(y(value))}`).join(' ');
  const last = points[points.length - 1];
  return html`<svg
    class="spark"
    viewBox="0 0 ${raw(width)} ${raw(height)}"
    preserveAspectRatio="none"
    role="img"
    aria-label="Trend from ${format(points[0])} to ${format(last)}"
  >
    <title>From ${format(points[0])} to ${format(last)} over ${raw(points.length)} points</title>
    ${finite(target)
      ? html`<line class="spark-target" x1="1" y1="${raw(r2(y(target)))}" x2="${raw(width - 1)}" y2="${raw(r2(y(target)))}" />`
      : ''}
    <path d="${raw(path)}" fill="none" stroke="${raw(paint(tone))}" stroke-width="1.6" vector-effect="non-scaling-stroke" />
    <circle cx="${raw(r2(x(points.length - 1)))}" cy="${raw(r2(y(last)))}" r="2.2" fill="${raw(paint(tone))}" />
  </svg>`;
}

/**
 * Heatmap — density across two categorical axes.
 *
 * The colour ramp runs through a single hue's lightness rather than through a
 * rainbow. A rainbow ramp has no perceptual order — nobody can say whether green
 * is more than yellow without consulting the key — and it is unreadable to a
 * reader with a colour-vision deficiency, whereas lightness survives both.
 */
/** @param {{rows?: string[], columns?: string[], values?: Scalar[][], title?: string, desc?: string, format?: Formatter, empty?: string, tone?: string, footnote?: string}} options */
export function heatmap({
  rows = [],
  columns = [],
  values = [],
  title = 'Activity',
  desc,
  format = tickLabel,
  empty = 'No activity recorded yet',
  tone = 'accent',
  footnote,
}) {
  if (rows.length === 0 || columns.length === 0) return emptyChart(empty);

  const flat = values.flat().filter(finite).map(Number);
  if (flat.length === 0) return emptyChart(empty);
  const max = Math.max(...flat);
  // Cell width and height are set separately, and the box has a floor.
  //
  // A four-column, sixteen-row grid — the notification preference matrix — is
  // 354px wide and 800 tall at one square cell size. The frame scales its
  // viewBox to the card, so that narrow box was blown up 2.6x and the chart ran
  // two thousand pixels down the page: legible, and unusable.
  //
  // So rows compress when there are many of them, and a narrow grid is centred
  // inside a normal-width frame rather than stretched to fill one.
  const cell = Math.min(46, Math.max(18, Math.floor(560 / columns.length)));
  const cellHigh = Math.min(cell, Math.max(18, Math.floor(430 / rows.length)));
  const base = paint(tone);

  // Column headings, upright or on the diagonal.
  //
  // A permission matrix is twenty-five capability areas wide, which puts the
  // cell at eighteen pixels and the headings at eight characters of overlap
  // each. Horizontal headings that do not fit do not degrade — they smear into
  // one another and the grid stops being readable at all, which is worse than
  // the table it replaced.
  //
  // So the whole header rotates the moment any one heading is too wide for its
  // column, and the top gutter grows with the longest label rather than staying
  // at a fixed 46: a diagonal heading is as tall as it is long.
  const fits = (label) => String(label).length * 5.8 <= cell - 4;
  const slanted = columns.some((column) => !fits(column));
  const longest = Math.max(...columns.map((column) => String(column).length));
  // Trimmed to what the slant can carry, so a long area name cannot run off the
  // top of the box. 22 characters at 45 degrees is about 90px of rise.
  const headings = columns.map((column) => (slanted ? fitLabel(column, 128, 10) : column));
  const top = slanted ? Math.min(150, 34 + Math.min(longest, 22) * 4.4) : 46;
  const natural = 150 + columns.length * cell + (slanted ? 90 : 20);
  // Widened towards a normal frame, but never more than half again its natural
  // width: padding a 354px grid all the way out to 720 leaves the grid sitting
  // in a field of empty card, which looks like a rendering fault rather than a
  // deliberate margin.
  const box = { w: Math.min(720, Math.max(natural, Math.round(natural * 1.4))), h: top + rows.length * cellHigh + 22 };
  const left = 150 + (box.w - natural) / 2;

  return frame({
    title,
    box,
    footnote,
    desc:
      desc ??
      `${rows.length} rows by ${columns.length} columns. Brightest cell is ${format(max)}; an empty cell is nothing rather than zero.`,
    body: html`${headings.map((column, index) => {
      const x = r2(left + index * cell + cell / 2);
      const y = top - 8;
      return slanted
        ? html`<text
            class="chart-cat"
            x="${raw(x)}"
            y="${raw(r2(y))}"
            text-anchor="start"
            transform="rotate(-45 ${raw(x)} ${raw(r2(y))})"
          >${column}</text>`
        : html`<text class="chart-cat" x="${raw(x)}" y="${raw(y)}" text-anchor="middle">${column}</text>`;
    })}
    ${rows.map(
      (row, rowIndex) => html`<g>
        <text class="chart-cat" x="${raw(r2(left - 10))}" y="${raw(r2(top + rowIndex * cellHigh + cellHigh / 2 + 4))}" text-anchor="end">${row}</text>
        ${columns.map((column, columnIndex) => {
          const value = values[rowIndex]?.[columnIndex];
          const share = finite(value) && max > 0 ? Number(value) / max : 0;
          return html`<rect
            class="chart-cell"
            x="${raw(r2(left + columnIndex * cell))}"
            y="${raw(r2(top + rowIndex * cellHigh))}"
            width="${raw(cell - 2)}"
            height="${raw(cellHigh - 2)}"
            rx="2"
            fill="${raw(base)}"
            fill-opacity="${raw(finite(value) ? r2(0.08 + share * 0.86) : 0)}"
            stroke="${raw(finite(value) ? 'none' : 'var(--line)')}"
          >
            <title>${row} · ${column}: ${finite(value) ? format(value) : 'not recorded'}</title>
          </rect>`;
        })}
      </g>`,
    )}`,
  });
}

/**
 * Funnel — how many survive each stage.
 *
 * Each stage is labelled with its conversion from the stage above *and* from the
 * top, because those are the two questions and a funnel that answers only one of
 * them gets read as answering the other.
 */
/** @param {{stages?: Row[], title?: string, desc?: string, format?: Formatter, empty?: string, footnote?: string}} options */
export function funnelChart({
  stages = [],
  title = 'Funnel',
  desc,
  format = tickLabel,
  empty = 'Nothing has entered the funnel yet',
  footnote,
}) {
  const steps = stages.filter((stage) => stage && finite(stage.value));
  if (steps.length === 0) return emptyChart(empty);

  const top = Number(steps[0].value);
  if (top <= 0) return emptyChart(empty);

  const box = { w: 720, h: Math.max(140, steps.length * 54 + 24) };
  const left = 14;
  const width = 470;
  const rowHeight = 54;
  const stageColours = assignColours(steps);

  return frame({
    title,
    box,
    footnote,
    desc:
      desc ??
      `${steps.length} stages from ${format(top)} to ${format(steps[steps.length - 1].value)}. ` +
        `Overall ${r2((Number(steps[steps.length - 1].value) / top) * 100)}% survive.`,
    body: steps.map((stage, index) => {
      const value = Number(stage.value);
      const share = value / top;
      const barWidth = Math.max(2, share * width);
      const y = 14 + index * rowHeight;
      const previous = index === 0 ? undefined : Number(steps[index - 1].value);
      const fromPrevious = previous && previous > 0 ? (value / previous) * 100 : undefined;
      return html`<g>
        <rect
          class="chart-funnel"
          x="${raw(r2(left + (width - barWidth) / 2))}"
          y="${raw(y)}"
          width="${raw(r2(barWidth))}"
          height="${raw(rowHeight - 14)}"
          rx="3"
          fill="${raw(stageColours[index])}"
        >
          <title>${stage.label}: ${format(value)} · ${raw(r2(share * 100))}% of the top${
            fromPrevious === undefined ? '' : `, ${r2(fromPrevious)}% of the stage above`
          }</title>
        </rect>
        <text class="chart-funnel-label" x="${raw(left + width + 20)}" y="${raw(y + 16)}">${stage.label}</text>
        <text class="chart-funnel-value" x="${raw(left + width + 20)}" y="${raw(y + 32)}">
          ${format(value)} · ${raw(r2(share * 100))}% of the top${raw(fromPrevious === undefined ? '' : ` · ${r2(fromPrevious)}% from above`)}
        </text>
      </g>`;
    }),
  });
}

/**
 * Waterfall — how a total was arrived at.
 *
 * Increases, decreases and subtotals are three different marks, not three
 * colours of the same one: a subtotal is drawn from the axis and an increment is
 * drawn from the running position, which is the distinction the chart exists to
 * make. Pass `total: true` on a step to draw it as a subtotal.
 */
/** @param {{steps?: Step[], title?: string, desc?: string, format?: Formatter, empty?: string, footnote?: string}} options */
export function waterfallChart({
  steps = [],
  title = 'Build-up',
  desc,
  format = tickLabel,
  empty = 'Nothing to build up yet',
  footnote,
}) {
  const entries = steps.filter((step) => step && finite(step.value));
  if (entries.length === 0) return emptyChart(empty);
  // A build-up whose every term is zero has nothing to build up, and drawing it
  // says "the forecast is nil" where the fact is "there is nothing to forecast
  // from". Those are opposite readings of the same picture, and the second one
  // is the caller's own empty sentence — which the engine usually words far
  // better than a chart could.
  if (entries.every((step) => Number(step.value) === 0)) return emptyChart(empty);

  // Walk once to find where each bar sits, and how high the running total goes.
  let running = 0;
  const bars = entries.map((step) => {
    const value = Number(step.value);
    const from = step.total ? 0 : running;
    const to = step.total ? value : running + value;
    running = to;
    return { ...step, value, from, to };
  });

  const axis = niceScale(Math.min(0, ...bars.map((b) => Math.min(b.from, b.to))), Math.max(...bars.map((b) => Math.max(b.from, b.to))));
  const area = plot();
  const y = scale(axis.min, axis.max, area.y + area.h, area.y);
  const band = area.w / bars.length;
  const width = Math.min(56, band * 0.62);

  return frame({
    title,
    footnote,
    desc: desc ?? `${bars.length} steps arriving at ${format(bars[bars.length - 1].to)}.`,
    body: html`${valueAxis(area, axis.ticks, y, format)}
      <line class="chart-axis" x1="${raw(r2(area.x))}" y1="${raw(r2(y(0)))}" x2="${raw(r2(area.x + area.w))}" y2="${raw(r2(y(0)))}" />
      ${bars.map((bar, index) => {
        const cx = area.x + index * band + band / 2;
        const tone = bar.total ? 'neutral' : bar.value >= 0 ? 'ok' : 'bad';
        const top = Math.min(y(bar.from), y(bar.to));
        const height = Math.max(1.5, Math.abs(y(bar.to) - y(bar.from)));
        const previous = bars[index - 1];
        return html`<g>
          ${previous
            ? html`<line
                class="chart-connector"
                x1="${raw(r2(cx - band / 2 - width / 2 + band / 2))}"
                y1="${raw(r2(y(previous.to)))}"
                x2="${raw(r2(cx + width / 2))}"
                y2="${raw(r2(y(previous.to)))}"
              />`
            : ''}
          <rect
            class="chart-bar"
            x="${raw(r2(cx - width / 2))}"
            y="${raw(r2(top))}"
            width="${raw(r2(width))}"
            height="${raw(r2(height))}"
            fill="${raw(paint(bar.tone ?? tone))}"
          >
            <title>${bar.label}: ${raw(bar.total ? '' : bar.value >= 0 ? '+' : '')}${format(bar.value)}${
              bar.total ? ' (subtotal)' : ` · running ${format(bar.to)}`
            }</title>
          </rect>
          <text class="chart-cat" x="${raw(r2(cx))}" y="${raw(r2(area.y + area.h + 20))}" text-anchor="middle">${bar.label}</text>
        </g>`;
      })}`,
    legend: legend([
      { label: 'Increase', colour: 'ok' },
      { label: 'Decrease', colour: 'bad' },
      { label: 'Subtotal', colour: 'neutral' },
    ]),
  });
}

/**
 * Treemap — a hierarchy sized by value.
 *
 * Squarified rather than sliced: a slice-and-dice treemap produces slivers at
 * any real data, and a sliver cannot be compared with anything or clicked on.
 */
/** @param {{items?: Row[], title?: string, desc?: string, format?: Formatter, empty?: string, footnote?: string}} options */
export function treemap({
  items = [],
  title = 'Composition by size',
  desc,
  format = tickLabel,
  empty = 'Nothing to size yet',
  footnote,
}) {
  const nodes = items.filter((item) => item && finite(item.value) && Number(item.value) > 0);
  if (nodes.length === 0) return emptyChart(empty);

  const box = { w: 720, h: 380 };
  const total = nodes.reduce((sum, node) => sum + Number(node.value), 0);
  const sorted = nodes.slice().sort((a, b) => Number(b.value) - Number(a.value));
  const rects = squarify(sorted.map((node) => Number(node.value)), { x: 0, y: 0, w: box.w, h: box.h }, total);
  const tileColours = assignColours(sorted);

  return frame({
    title,
    box,
    footnote,
    desc: desc ?? `${nodes.length} items totalling ${format(total)}. Largest is ${sorted[0].label} at ${format(sorted[0].value)}.`,
    body: rects.map((rect, index) => {
      const node = sorted[index];
      const share = Number(node.value) / total;
      // A label only where it fits. A truncated word in a 20px box is noise.
      const fits = rect.w > 74 && rect.h > 34;
      return html`<g>
        <rect
          class="chart-tile"
          x="${raw(r2(rect.x))}"
          y="${raw(r2(rect.y))}"
          width="${raw(r2(Math.max(0, rect.w - 2)))}"
          height="${raw(r2(Math.max(0, rect.h - 2)))}"
          rx="3"
          fill="${raw(tileColours[index])}"
          fill-opacity="0.82"
        >
          <title>${node.label}: ${format(node.value)} · ${raw(r2(share * 100))}%</title>
        </rect>
        ${fits
          ? html`<text class="chart-tile-label" x="${raw(r2(rect.x + 10))}" y="${raw(r2(rect.y + 22))}">${node.label}</text>
              <text class="chart-tile-value" x="${raw(r2(rect.x + 10))}" y="${raw(r2(rect.y + 38))}">${format(node.value)}</text>`
          : ''}
      </g>`;
    }),
  });
}

/**
 * The squarified treemap layout.
 *
 * Rows are accumulated while adding the next item improves the worst aspect
 * ratio in the row, and closed when it does not — which is what keeps the tiles
 * near-square. Bruls, Huizing and van Wijk's algorithm, written out because it
 * is thirty lines and a dependency for thirty lines is not a trade.
 */
function squarify(values, area, total) {
  const out = [];
  const scaled = values.map((value) => (value / total) * area.w * area.h);
  let remaining = { ...area };
  let index = 0;

  const worst = (row, side) => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    if (sum === 0 || side === 0) return Infinity;
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  while (index < scaled.length) {
    const side = Math.min(remaining.w, remaining.h);
    const row = [scaled[index]];
    let next = index + 1;
    while (next < scaled.length && worst([...row, scaled[next]], side) <= worst(row, side)) {
      row.push(scaled[next]);
      next += 1;
    }

    const sum = row.reduce((a, b) => a + b, 0);
    const horizontal = remaining.w >= remaining.h;
    const thickness = side === 0 ? 0 : sum / side;
    let offset = horizontal ? remaining.y : remaining.x;

    for (const value of row) {
      const length = sum === 0 ? 0 : (value / sum) * side;
      out.push(
        horizontal
          ? { x: remaining.x, y: offset, w: thickness, h: length }
          : { x: offset, y: remaining.y, w: length, h: thickness },
      );
      offset += length;
    }

    if (horizontal) remaining = { x: remaining.x + thickness, y: remaining.y, w: remaining.w - thickness, h: remaining.h };
    else remaining = { x: remaining.x, y: remaining.y + thickness, w: remaining.w, h: remaining.h - thickness };

    index = next;
  }
  return out;
}

/**
 * Gantt — tasks against a calendar.
 *
 * Draws what the record holds and nothing more: a bar for the planned span, a
 * second bar inside it for progress where progress is recorded, a diamond for a
 * milestone, and a dependency line only where a dependency is stated. A Gantt
 * that draws inferred links is a Gantt that argues with the programme.
 */
/** @param {{tasks?: Task[], title?: string, desc?: string, today?: string, dataDate?: string, empty?: string, footnote?: string}} options */
/**
 * A programme, drawn the way a planner reads one.
 *
 * The critical-path engine has always computed early dates, late dates, total
 * float, free float and the dependency network. This chart drew the early dates
 * and threw the rest away, which made it a picture of *when* work is scheduled
 * with nothing about *why* — and why is the whole job. A bar with no float
 * behind it and no logic into it cannot answer "what happens if this slips",
 * which is the only question anybody opens a programme to ask.
 *
 * What is drawn, and what each thing is for:
 *
 * **The float bar.** A hollow extension from the early finish to the late
 * finish. Its length is the total float — how long this activity can slip
 * before it moves the end date. An activity with no visible float bar is on the
 * critical path, and that is the reading a planner wants at a glance rather
 * than from a column of numbers.
 *
 * **Logic links.** An arrow from predecessor to successor, routed by the
 * relationship the record holds: finish-to-start leaves the right edge and
 * enters the left, start-to-start joins the two left edges, finish-to-finish
 * the two right. Lag is drawn as the gap it is. Links are what turn a chart of
 * bars into a network.
 *
 * **WBS grouping.** Activities under their parent, with a summary bar spanning
 * the group's earliest start to its latest finish. A flat list of two hundred
 * activities is a spreadsheet with rounded corners.
 *
 * **Negative float** is drawn in the refusal colour and called out, because an
 * activity with less than zero float means the logic already cannot be met and
 * that is a fact about the programme rather than a risk in it.
 *
 * Everything else the chart already did — baseline hairline, data date,
 * per-cent complete, milestones — is kept, because it worked.
 */
/** @param {{tasks?: GanttTask[], links?: GanttLink[], title?: string, desc?: string, today?: string, dataDate?: string, showFloat?: boolean, showLinks?: boolean, empty?: string, footnote?: string}} options */
export function ganttChart({
  tasks = [],
  links = [],
  title = 'Programme',
  desc,
  today,
  /** The line between what happened and what is forecast. Alias of `today`. */
  dataDate,
  /** Draw the float bar and the logic links. Off for a simple timeline. */
  showFloat = true,
  showLinks = true,
  /**
   * Time granularity: 'MONTH' (default), 'WEEK' or 'DAY'.
   *
   * It changes the gridline the calendar is drawn on *and* the width of the
   * chart, because those are the same decision. Asking for days on a
   * two-year programme and keeping the same 760px box would draw seven
   * hundred gridlines into a grey block — so the box widens with the
   * granularity and the container scrolls it.
   */
  scale: timeScale = 'MONTH',
  empty = 'No dated activities to plot',
  footnote,
}) {
  // `finish` alongside `end`, and `name` alongside `label`, because a
  // programme record calls them that and translating at every call site is how
  // one of the call sites eventually gets it wrong.
  const bars = tasks
    .map((task) => ({ ...task, label: task.label ?? task.name, end: task.end ?? task.finish }))
    .filter((task) => task && task.start && task.end)
    .map((task) => ({
      ...task,
      from: Date.parse(task.start),
      to: Date.parse(task.end),
      baseFrom: task.baselineStart ? Date.parse(task.baselineStart) : NaN,
      baseTo: task.baselineFinish ?? task.baselineEnd ? Date.parse(task.baselineFinish ?? task.baselineEnd) : NaN,
      // The late finish is what the float bar runs to. Where the caller gives a
      // float in days instead, it is converted here so both shapes of record
      // draw the same picture.
      lateTo: task.lateFinish
        ? Date.parse(task.lateFinish)
        : finite(task.totalFloat)
          ? Date.parse(task.end) + Number(task.totalFloat) * 86_400_000
          : NaN,
    }))
    .filter((task) => Number.isFinite(task.from) && Number.isFinite(task.to) && task.to >= task.from);
  if (bars.length === 0) return emptyChart(empty);

  // --- WBS ------------------------------------------------------------------
  //
  // Rows are the activities plus a summary row per group. Built here rather
  // than asked of the caller, so a page that has a `wbs` on its records gets
  // the grouping without assembling it, and a page that does not gets a flat
  // chart with no empty headings.
  const grouped = bars.some((bar) => bar.wbs);
  const rows = [];
  if (grouped) {
    const order = [];
    const byGroup = new Map();
    for (const bar of bars) {
      const key = bar.wbs ?? 'Unassigned';
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
        order.push(key);
      }
      byGroup.get(key).push(bar);
    }
    for (const key of order) {
      const members = byGroup.get(key);
      rows.push({
        kind: 'group',
        label: key,
        from: Math.min(...members.map((member) => member.from)),
        to: Math.max(...members.map((member) => member.to)),
        count: members.length,
      });
      for (const member of members) rows.push({ kind: 'task', ...member });
    }
  } else {
    for (const bar of bars) rows.push({ kind: 'task', ...bar });
  }

  // Baselines and float are inside the extent. A task that slipped has a
  // baseline earlier than every current date, and leaving it out of the scale
  // draws the comparison off the left edge — losing exactly the bar the reader
  // opened the chart for.
  const dates = bars.flatMap((bar) => [bar.from, bar.to, bar.baseFrom, bar.baseTo, showFloat ? bar.lateTo : NaN].filter(Number.isFinite));
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const rowHeight = 30;
  const left = 210;
  const spanDays = Math.max(1, Math.round((max - min) / 86_400_000));
  // Pixels per day at each granularity, and the chart is as wide as the
  // programme needs rather than as wide as the panel happens to be.
  const perDay = timeScale === 'DAY' ? 14 : timeScale === 'WEEK' ? 3.2 : 0;
  const width = perDay > 0 ? Math.max(760, Math.round(left + 40 + spanDays * perDay)) : 760;
  const box = { w: width, h: Math.max(120, rows.length * rowHeight + 56) };
  const right = box.w - 20;
  const x = scale(min, max, left, right);
  const nowAt = today ?? dataDate ? Date.parse(today ?? dataDate) : Date.now();

  // Calendar gridlines, because a Gantt with no calendar behind it is a set of
  // floating rectangles. The step follows the requested granularity, and the
  // cap is per-scale: 48 months, 120 weeks or 180 days is the point past which
  // another line stops being a calendar and starts being hatching.
  const months = [];
  const cursor = new Date(min);
  if (timeScale === 'MONTH') {
    cursor.setUTCDate(1);
  } else if (timeScale === 'WEEK') {
    // Back to the Monday, so a week gridline is a week somebody recognises.
    cursor.setUTCDate(cursor.getUTCDate() - ((cursor.getUTCDay() + 6) % 7));
  }
  cursor.setUTCHours(0, 0, 0, 0);
  const cap = timeScale === 'DAY' ? 180 : timeScale === 'WEEK' ? 120 : 48;
  while (cursor.getTime() <= max && months.length < cap) {
    if (cursor.getTime() >= min) months.push(new Date(cursor));
    if (timeScale === 'MONTH') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + (timeScale === 'WEEK' ? 7 : 1));
  }
  const gridLabel = (date) =>
    timeScale === 'MONTH'
      ? date.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
      : timeScale === 'WEEK'
        ? date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
        : String(date.getUTCDate());

  const dayMs = 86_400_000;
  const geometry = new Map();
  rows.forEach((row, index) => {
    if (row.kind === 'task' && row.id !== undefined) {
      geometry.set(String(row.id), { y: 36 + index * rowHeight, from: x(row.from), to: x(row.to) });
    }
  });

  const criticalCount = bars.filter((bar) => bar.critical || bar.longestPath).length;
  const negativeFloat = bars.filter((bar) => finite(bar.totalFloat) && Number(bar.totalFloat) < 0).length;

  return frame({
    title,
    box,
    footnote,
    legend: showFloat
      ? [
          { label: `${criticalCount} critical`, tone: 'bad' },
          { label: 'float to late finish', tone: 'neutral' },
          ...(negativeFloat > 0 ? [{ label: `${negativeFloat} negative float`, tone: 'bad' }] : []),
        ]
      : undefined,
    desc:
      desc ??
      `${bars.length} activities from ${new Date(min).toISOString().slice(0, 10)} to ${new Date(max).toISOString().slice(0, 10)}, ` +
        `a span of ${Math.round((max - min) / dayMs)} days. ${criticalCount} on the critical path` +
        `${showLinks && links.length > 0 ? `, ${links.length} logic links drawn` : ''}` +
        `${negativeFloat > 0 ? `, ${negativeFloat} carrying negative float` : ''}.`,
    body: html`${months.map(
      (month) => html`<g class="chart-grid">
        <line x1="${raw(r2(x(month.getTime())))}" y1="30" x2="${raw(r2(x(month.getTime())))}" y2="${raw(box.h - 20)}" />
        <text x="${raw(r2(x(month.getTime())))}" y="22" text-anchor="middle">
          ${raw(gridLabel(month))}
        </text>
      </g>`,
    )}
    ${Number.isFinite(nowAt) && nowAt >= min && nowAt <= max
      ? html`<line class="chart-today" x1="${raw(r2(x(nowAt)))}" y1="30" x2="${raw(r2(x(nowAt)))}" y2="${raw(box.h - 20)}">
          <title>Data date</title>
        </line>`
      : ''}
    ${rows.map((row, index) => {
      const y = 36 + index * rowHeight;

      // --- A WBS summary row ---------------------------------------------
      if (row.kind === 'group') {
        const from = x(row.from);
        const to = x(row.to);
        return html`<g>
          <text class="chart-cat chart-wbs" x="${raw(left - 12)}" y="${raw(y + 15)}" text-anchor="end">
            <title>${row.label} · ${row.count} activities</title>${fitLabel(row.label, left - 22)}
          </text>
          <path
            class="chart-summary"
            d="${raw(`M ${r2(from)} ${r2(y + 9)} L ${r2(to)} ${r2(y + 9)} L ${r2(to)} ${r2(y + 17)} L ${r2(to - 5)} ${r2(y + 11)} L ${r2(from + 5)} ${r2(y + 11)} L ${r2(from)} ${r2(y + 17)} Z`)}"
          >
            <title>${row.label}: ${row.count} activities, ${raw(String(new Date(row.from).toISOString().slice(0, 10)))} to ${raw(String(new Date(row.to).toISOString().slice(0, 10)))}</title>
          </path>
        </g>`;
      }

      const bar = row;
      const from = x(bar.from);
      const to = x(bar.to);
      const width = Math.max(3, to - from);
      // Critical and longest-path work is toned by what it *is*, overriding any
      // tone the caller passed: on a programme, "this drives the completion
      // date" outranks whatever colour a category would have given it.
      const colour = paint(bar.critical || bar.longestPath ? 'bad' : bar.tone, index);
      const milestone = bar.milestone === true || bar.to === bar.from;
      const done = finite(bar.percentComplete) ? Math.max(0, Math.min(100, Number(bar.percentComplete))) : undefined;
      const baseline =
        Number.isFinite(bar.baseFrom) && Number.isFinite(bar.baseTo) && bar.baseTo >= bar.baseFrom
          ? { from: x(bar.baseFrom), to: x(bar.baseTo) }
          : undefined;
      const slipDays = baseline ? Math.round((bar.to - bar.baseTo) / 86_400_000) : 0;
      const floatDays = finite(bar.totalFloat)
        ? Number(bar.totalFloat)
        : Number.isFinite(bar.lateTo)
          ? Math.round((bar.lateTo - bar.to) / dayMs)
          : undefined;
      // Negative float runs *backwards* from the early finish: the late finish
      // is before it, and drawing it forwards would say the opposite of what it
      // means.
      const floatBar =
        showFloat && Number.isFinite(bar.lateTo) && floatDays !== undefined && floatDays !== 0
          ? { from: x(Math.min(bar.to, bar.lateTo)), to: x(Math.max(bar.to, bar.lateTo)), negative: floatDays < 0 }
          : undefined;

      return html`<g>
        <text class="chart-cat" x="${raw(left - 12)}" y="${raw(y + 15)}" text-anchor="end">
          <title>${bar.label}${floatDays === undefined ? '' : ` · ${floatDays} days total float`}</title>${fitLabel(grouped ? `  ${bar.label}` : bar.label, left - 22)}
        </text>
        ${
          // The float bar first, so the activity bar sits on top of it.
          floatBar
            ? html`<rect
                class="chart-float${raw(floatBar.negative ? ' is-negative' : '')}"
                x="${raw(r2(floatBar.from))}"
                y="${raw(y + 8)}"
                width="${raw(r2(Math.max(2, floatBar.to - floatBar.from)))}"
                height="10"
                rx="2"
              >
                <title>${bar.label}: ${raw(String(Math.abs(floatDays)))} days ${raw(floatDays < 0 ? 'negative float — the logic already cannot be met' : 'total float before the end date moves')}</title>
              </rect>`
            : ''
        }
        ${
          // The baseline as a hairline under the bar rather than a second solid
          // bar: the current dates are what somebody acts on, and two bars of
          // equal weight make the reader work out which is which every row.
          baseline
            ? html`<g class="chart-ref">
                <line
                  x1="${raw(r2(baseline.from))}"
                  y1="${raw(y + 24)}"
                  x2="${raw(r2(Math.max(baseline.from + 2, baseline.to)))}"
                  y2="${raw(y + 24)}"
                />
                <title>${bar.label}: baseline ${raw(String(bar.baselineStart).slice(0, 10))} to ${raw(
                  String(bar.baselineFinish ?? bar.baselineEnd).slice(0, 10),
                )}${slipDays === 0 ? '' : ` · ${Math.abs(slipDays)} days ${slipDays > 0 ? 'late' : 'early'}`}</title>
              </g>`
            : ''
        }
        ${milestone
          ? html`<path
              class="chart-milestone"
              d="${raw(`M ${r2(from)} ${r2(y + 4)} L ${r2(from + 9)} ${r2(y + 13)} L ${r2(from)} ${r2(y + 22)} L ${r2(from - 9)} ${r2(y + 13)} Z`)}"
              fill="${raw(colour)}"
            >
              <title>${bar.label} · milestone ${bar.start.slice(0, 10)}</title>
            </path>`
          : html`<rect class="chart-gantt" x="${raw(r2(from))}" y="${raw(y + 5)}" width="${raw(r2(width))}" height="16" rx="3" fill="${raw(colour)}" fill-opacity="0.34">
                <title>${bar.label}: ${bar.start.slice(0, 10)} to ${bar.end.slice(0, 10)}${
                  done === undefined ? '' : ` · ${done}% complete`
                }${floatDays === undefined ? '' : ` · ${floatDays} days float`}</title>
              </rect>
              ${done === undefined
                ? ''
                : html`<rect
                    class="chart-gantt-done"
                    x="${raw(r2(from))}"
                    y="${raw(y + 5)}"
                    width="${raw(r2((width * done) / 100))}"
                    height="16"
                    rx="3"
                    fill="${raw(colour)}"
                  >
                    <title>${bar.label}: ${raw(done)}% complete</title>
                  </rect>`}`}
      </g>`;
    })}
    ${
      // --- Logic links ----------------------------------------------------
      //
      // Drawn last so they sit above the bars. Each is routed by its own
      // relationship type: a finish-to-start leaves the predecessor's right
      // edge and enters the successor's left, a start-to-start joins the two
      // left edges, a finish-to-finish the two right. A link whose either end
      // is not on the chart is skipped rather than drawn to the edge.
      showLinks
        ? links
            .map((link) => {
              const a = geometry.get(String(link.predecessorId ?? link.from));
              const b = geometry.get(String(link.successorId ?? link.to));
              if (!a || !b) return '';
              const type = String(link.type ?? 'FS').toUpperCase();
              const startX = type === 'SS' || type === 'SF' ? a.from : a.to;
              const endX = type === 'SS' || type === 'FS' ? b.from : b.to;
              const y1 = a.y + 13;
              const y2 = b.y + 13;
              const midX = type === 'FS' ? Math.max(startX + 6, endX - 8) : startX + 6;
              const lag = finite(link.lag) ? Number(link.lag) : 0;
              return html`<g class="chart-link${raw(link.critical ? ' is-critical' : '')}">
                <path
                  d="${raw(`M ${r2(startX)} ${r2(y1)} L ${r2(midX)} ${r2(y1)} L ${r2(midX)} ${r2(y2)} L ${r2(endX)} ${r2(y2)}`)}"
                  fill="none"
                />
                <path d="${raw(`M ${r2(endX)} ${r2(y2)} l -4 -3 l 0 6 Z`)}" />
                <title>${raw(type)}${lag === 0 ? '' : raw(` ${lag > 0 ? '+' : ''}${lag}d`)}</title>
              </g>`;
            })
        : ''
    }`,
  });
}


/**
 * A radar chart: several measures for one or more subjects, on radial axes.
 *
 * The chart for a *profile* rather than a ranking. A bar chart of six scores
 * answers "which is highest"; a radar answers "what shape is this", which is
 * the question behind a supplier scorecard, a bid assessment or a maturity
 * review — and the shape is what a reader remembers when two of them are drawn
 * on the same axes.
 *
 * Every axis is scaled to the same maximum on purpose. Per-axis scaling makes
 * every profile look balanced, which is flattering and false: a supplier scoring
 * 9 on price and 2 on safety should look lopsided, because it is.
 *
 * @param {{axes?: string[], series?: {label: string, values: number[], tone?: string}[], max?: number, title?: string, desc?: string, format?: Formatter, empty?: string, footnote?: string}} options
 */
export function radarChart({ axes = [], series = [], max, title = 'Profile', desc, format = tickLabel, empty = 'Nothing to profile yet', footnote }) {
  const rows = series.filter((entry) => entry && Array.isArray(entry.values) && entry.values.length === axes.length);
  if (axes.length < 3 || rows.length === 0) return emptyChart(empty);

  const ceiling = finite(max)
    ? Number(max)
    : Math.max(1, ...rows.flatMap((row) => row.values.filter(finite).map(Number)));
  const box = { w: 520, h: 420 };
  const cx = box.w / 2;
  const cy = box.h / 2 + 6;
  const radius = Math.min(box.w, box.h) / 2 - 62;
  const step = (Math.PI * 2) / axes.length;
  // Start at twelve o'clock: a profile read from the top is the convention, and
  // starting at three puts the first axis where a reader looks last.
  const angle = (index) => index * step - Math.PI / 2;
  const at = (index, value) => {
    const r = (Math.max(0, Math.min(ceiling, num(value))) / ceiling) * radius;
    return { x: cx + Math.cos(angle(index)) * r, y: cy + Math.sin(angle(index)) * r };
  };
  const rings = [0.25, 0.5, 0.75, 1];

  return frame({
    title,
    box,
    footnote,
    legend: rows.length > 1 ? rows.map((row, index) => ({ label: row.label, tone: row.tone, colour: paint(row.tone, index) })) : undefined,
    desc:
      desc ??
      `${rows.length} profile${rows.length === 1 ? '' : 's'} across ${axes.length} measures, each scaled to ${format(ceiling)}.`,
    body: html`${rings.map(
      (ring) => html`<polygon
        class="chart-grid chart-radar-ring"
        points="${raw(axes.map((_, index) => { const p = at(index, ceiling * ring); return `${r2(p.x)},${r2(p.y)}`; }).join(' '))}"
        fill="none"
      />`,
    )}
    ${axes.map((axis, index) => {
      const outer = at(index, ceiling);
      const label = at(index, ceiling * 1.18);
      return html`<g>
        <line class="chart-grid" x1="${raw(r2(cx))}" y1="${raw(r2(cy))}" x2="${raw(r2(outer.x))}" y2="${raw(r2(outer.y))}" />
        <text
          class="chart-cat"
          x="${raw(r2(label.x))}"
          y="${raw(r2(label.y))}"
          text-anchor="${raw(Math.abs(label.x - cx) < 6 ? 'middle' : label.x > cx ? 'start' : 'end')}"
          dominant-baseline="middle"
        >${axis}</text>
      </g>`;
    })}
    ${rows.map((row, index) => {
      const colour = paint(row.tone, index);
      const points = row.values.map((value, axisIndex) => { const p = at(axisIndex, value); return `${r2(p.x)},${r2(p.y)}`; }).join(' ');
      return html`<g class="chart-radar">
        <polygon points="${raw(points)}" fill="${raw(colour)}" fill-opacity="0.18" stroke="${raw(colour)}" stroke-width="1.6">
          <title>${row.label}: ${raw(row.values.map((value, axisIndex) => `${axes[axisIndex]} ${format(value)}`).join(', '))}</title>
        </polygon>
        ${row.values.map((value, axisIndex) => {
          const p = at(axisIndex, value);
          return html`<circle class="chart-dot" cx="${raw(r2(p.x))}" cy="${raw(r2(p.y))}" r="3" fill="${raw(colour)}">
            <title>${row.label} · ${axes[axisIndex]}: ${format(value)}</title>
          </circle>`;
        })}
      </g>`;
    })}`,
  });
}

/**
 * A Sankey diagram: quantity flowing from one set of things to another.
 *
 * The chart for "where did it go". A bar chart of spend by category and a bar
 * chart of spend by supplier are two true pictures that cannot be read
 * together; a Sankey is the one picture that holds both and the link between
 * them, which is the whole question when money moves through stages.
 *
 * Two columns only, deliberately. A multi-level Sankey needs a layout solver to
 * avoid crossings, and a diagram whose ribbons cross arbitrarily is harder to
 * read than the table it replaced.
 *
 * @param {{flows?: {from: string, to: string, value: number, tone?: string}[], title?: string, desc?: string, format?: Formatter, empty?: string, footnote?: string}} options
 */
export function sankeyDiagram({ flows = [], title = 'Flow', desc, format = tickLabel, empty = 'No flow to trace yet', footnote }) {
  const rows = flows.filter((flow) => flow && flow.from && flow.to && finite(flow.value) && Number(flow.value) > 0);
  if (rows.length === 0) return emptyChart(empty);

  const sources = [...new Set(rows.map((row) => row.from))];
  const targets = [...new Set(rows.map((row) => row.to))];
  const total = rows.reduce((sum, row) => sum + Number(row.value), 0);

  const box = { w: 760, h: Math.max(220, Math.max(sources.length, targets.length) * 46 + 60) };
  const gap = 10;
  const nodeWidth = 12;
  const leftX = 150;
  const rightX = box.w - 150 - nodeWidth;
  const usable = box.h - 44 - gap * (Math.max(sources.length, targets.length) - 1);

  const sizeOf = (name, side) =>
    rows.filter((row) => (side === 'from' ? row.from : row.to) === name).reduce((sum, row) => sum + Number(row.value), 0);

  const place = (names, side) => {
    const map = new Map();
    let y = 30;
    for (const name of names) {
      const height = Math.max(4, (sizeOf(name, side) / total) * usable);
      map.set(name, { y, height, used: 0 });
      y += height + gap;
    }
    return map;
  };
  const left = place(sources, 'from');
  const right = place(targets, 'to');

  return frame({
    title,
    box,
    footnote,
    desc:
      desc ??
      `${format(total)} flowing from ${sources.length} source${sources.length === 1 ? '' : 's'} to ${targets.length} destination${targets.length === 1 ? '' : 's'} across ${rows.length} flows.`,
    body: html`${rows.map((row, index) => {
      const a = left.get(row.from);
      const b = right.get(row.to);
      const height = Math.max(1.5, (Number(row.value) / total) * usable);
      const y1 = a.y + a.used;
      const y2 = b.y + b.used;
      a.used += height;
      b.used += height;
      const midX = (leftX + nodeWidth + rightX) / 2;
      const colour = paint(row.tone, index);
      // A filled ribbon rather than a stroked curve: the thickness *is* the
      // quantity, and a stroke of varying width is not a shape a reader can
      // compare against its neighbour.
      const d =
        `M ${r2(leftX + nodeWidth)} ${r2(y1)} ` +
        `C ${r2(midX)} ${r2(y1)}, ${r2(midX)} ${r2(y2)}, ${r2(rightX)} ${r2(y2)} ` +
        `L ${r2(rightX)} ${r2(y2 + height)} ` +
        `C ${r2(midX)} ${r2(y2 + height)}, ${r2(midX)} ${r2(y1 + height)}, ${r2(leftX + nodeWidth)} ${r2(y1 + height)} Z`;
      return html`<path class="chart-sankey" d="${raw(d)}" fill="${raw(colour)}" fill-opacity="0.26">
        <title>${row.from} → ${row.to}: ${format(row.value)} (${raw(String(Math.round((Number(row.value) / total) * 100)))}%)</title>
      </path>`;
    })}
    ${[...left.entries()].map(([name, node], index) => html`<g>
      <rect class="chart-node" x="${raw(r2(leftX))}" y="${raw(r2(node.y))}" width="${raw(nodeWidth)}" height="${raw(r2(node.height))}" rx="2" fill="${raw(paint(undefined, index))}" />
      <text class="chart-cat" x="${raw(leftX - 10)}" y="${raw(r2(node.y + node.height / 2))}" text-anchor="end" dominant-baseline="middle">
        <title>${name}: ${format(sizeOf(name, 'from'))}</title>${fitLabel(name, leftX - 18)}
      </text>
    </g>`)}
    ${[...right.entries()].map(([name, node], index) => html`<g>
      <rect class="chart-node" x="${raw(r2(rightX))}" y="${raw(r2(node.y))}" width="${raw(nodeWidth)}" height="${raw(r2(node.height))}" rx="2" fill="${raw(paint(undefined, index + 3))}" />
      <text class="chart-cat" x="${raw(rightX + nodeWidth + 10)}" y="${raw(r2(node.y + node.height / 2))}" text-anchor="start" dominant-baseline="middle">
        <title>${name}: ${format(sizeOf(name, 'to'))}</title>${fitLabel(name, box.w - rightX - nodeWidth - 18)}
      </text>
    </g>`)}`,
  });
}

/**
 * A flowchart: steps in a process, and what each one can lead to.
 *
 * Laid out in rows by *depth* — how many steps from the start — rather than by
 * declaration order, so the picture shows the shape of the process rather than
 * the order somebody happened to type it. A step that several others lead to
 * sits below all of them, which is what makes a convergence visible.
 *
 * Decision nodes are drawn as diamonds and terminal nodes as stadiums, because
 * a reader scanning for "where does this stop" should not have to read every
 * label to find out.
 *
 * @param {{steps?: {id: string, label: string, kind?: 'START'|'STEP'|'DECISION'|'END', tone?: string, next?: string[]}[], title?: string, desc?: string, empty?: string, footnote?: string}} options
 */
export function flowChart({ steps = [], title = 'Process', desc, empty = 'No process to draw yet', footnote }) {
  const nodes = steps.filter((step) => step && step.id && step.label);
  if (nodes.length === 0) return emptyChart(empty);

  const byId = new Map(nodes.map((node) => [node.id, node]));
  // Depth by breadth-first walk from every node nothing points at. A cycle
  // cannot deepen a node twice, so a process that loops back still lays out.
  const targeted = new Set(nodes.flatMap((node) => (node.next ?? []).filter((id) => byId.has(id))));
  const roots = nodes.filter((node) => !targeted.has(node.id));
  const depth = new Map();
  let frontier = (roots.length > 0 ? roots : [nodes[0]]).map((node) => node.id);
  let level = 0;
  const seen = new Set(frontier);
  while (frontier.length > 0 && level < 24) {
    for (const id of frontier) depth.set(id, level);
    const next = [];
    for (const id of frontier) {
      for (const child of byId.get(id)?.next ?? []) {
        if (byId.has(child) && !seen.has(child)) { seen.add(child); next.push(child); }
      }
    }
    frontier = next;
    level += 1;
  }
  for (const node of nodes) if (!depth.has(node.id)) depth.set(node.id, level);

  const rows = [];
  for (const node of nodes) {
    const d = depth.get(node.id) ?? 0;
    (rows[d] ??= []).push(node);
  }

  const boxW = 150;
  const boxH = 44;
  const gapY = 40;
  const box = { w: 760, h: Math.max(160, rows.length * (boxH + gapY) + 40) };
  const centres = new Map();
  rows.forEach((row, rowIndex) => {
    const width = row.length * boxW + (row.length - 1) * 26;
    let x = (box.w - width) / 2;
    for (const node of row) {
      centres.set(node.id, { x: x + boxW / 2, y: 28 + rowIndex * (boxH + gapY) + boxH / 2 });
      x += boxW + 26;
    }
  });

  return frame({
    title,
    box,
    footnote,
    desc: desc ?? `${nodes.length} steps over ${rows.length} stage${rows.length === 1 ? '' : 's'}.`,
    body: html`${nodes.flatMap((node) =>
      (node.next ?? [])
        .filter((id) => byId.has(id) && centres.has(id))
        .map((id) => {
          const a = centres.get(node.id);
          const b = centres.get(id);
          const y1 = a.y + boxH / 2;
          const y2 = b.y - boxH / 2;
          return html`<g class="chart-flow-link">
            <path d="${raw(`M ${r2(a.x)} ${r2(y1)} C ${r2(a.x)} ${r2((y1 + y2) / 2)}, ${r2(b.x)} ${r2((y1 + y2) / 2)}, ${r2(b.x)} ${r2(y2)}`)}" fill="none" />
            <path d="${raw(`M ${r2(b.x)} ${r2(y2)} l -4 -5 l 8 0 Z`)}" />
          </g>`;
        }),
    )}
    ${nodes.map((node, index) => {
      const at = centres.get(node.id);
      const kind = node.kind ?? 'STEP';
      const colour = paint(node.tone, index);
      const x = at.x - boxW / 2;
      const y = at.y - boxH / 2;
      const shape =
        kind === 'DECISION'
          ? html`<path class="chart-flow-node" d="${raw(`M ${r2(at.x)} ${r2(y)} L ${r2(x + boxW)} ${r2(at.y)} L ${r2(at.x)} ${r2(y + boxH)} L ${r2(x)} ${r2(at.y)} Z`)}" fill="${raw(colour)}" fill-opacity="0.2" stroke="${raw(colour)}" />`
          : html`<rect class="chart-flow-node" x="${raw(r2(x))}" y="${raw(r2(y))}" width="${raw(boxW)}" height="${raw(boxH)}" rx="${raw(kind === 'START' || kind === 'END' ? boxH / 2 : 5)}" fill="${raw(colour)}" fill-opacity="0.2" stroke="${raw(colour)}" />`;
      return html`<g>
        ${shape}
        <text class="chart-flow-label" x="${raw(r2(at.x))}" y="${raw(r2(at.y))}" text-anchor="middle" dominant-baseline="middle">
          <title>${node.label}${raw(kind === 'DECISION' ? ' · decision' : kind === 'END' ? ' · ends here' : '')}</title>${fitLabel(node.label, boxW - 16)}
        </text>
      </g>`;
    })}`,
  });
}

/**
 * A stacked proportion bar — one row, parts of a whole, no axes.
 *
 * The smallest chart in the kit and the one used most: it fits in a table cell
 * and in a card header, where a pie chart does not, and it answers "what is this
 * made of" without spending a whole panel on it.
 */
/** @param {{parts?: Row[], format?: Formatter, height?: number, empty?: string}} options */
export function proportionBar({ parts = [], format = tickLabel, height = 10, empty = '' }) {
  const segments = parts.filter((part) => part && finite(part.value) && Number(part.value) > 0);
  if (segments.length === 0) return empty ? emptyChart(empty) : '';
  const total = segments.reduce((sum, part) => sum + Number(part.value), 0);
  let offset = 0;
  return html`<svg
    class="proportion"
    viewBox="0 0 100 ${raw(height)}"
    preserveAspectRatio="none"
    role="img"
    aria-label="${segments.map((part) => `${part.label} ${format(part.value)}`).join(', ')}"
  >
    <title>${segments.map((part) => `${part.label}: ${format(part.value)}`).join(' · ')}</title>
    ${segments.map((part, index) => {
      const width = (Number(part.value) / total) * 100;
      const x = offset;
      offset += width;
      return html`<rect x="${raw(r2(x))}" y="0" width="${raw(r2(width))}" height="${raw(height)}" fill="${raw(paint(part.tone, index))}">
        <title>${part.label}: ${format(part.value)} (${raw(r2(width))}%)</title>
      </rect>`;
    })}
  </svg>`;
}

/** Every chart type this kit draws, for the pattern library and its test. */
export const CHART_TYPES = [
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'histogram',
  'scatter',
  'bubble',
  'box',
  'gauge',
  'kpi',
  'sparkline',
  'heatmap',
  'funnel',
  'waterfall',
  'treemap',
  'gantt',
  'radar',
  'sankey',
  'flow',
  'proportion',
];

/** Escape hatch for a caller that needs the raw palette in a non-SVG context. */
export { esc };
