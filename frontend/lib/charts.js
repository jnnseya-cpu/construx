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
 * Eight, because a categorical chart with more than eight series is a table
 * somebody drew. They are spaced around the wheel far enough to survive both
 * the common colour-vision deficiencies and a greyscale print, and they sit in
 * the same cool-with-a-warm-signal family as the interface itself rather than
 * being a stock palette pasted in.
 *
 * The first is Signal Orange, so a single-series chart is in the platform's own
 * colour without the caller choosing anything.
 */
export const SERIES = [
  'rgb(255, 106, 26)',
  'rgb(93, 154, 245)',
  'rgb(46, 184, 116)',
  'rgb(190, 130, 246)',
  'rgb(240, 166, 42)',
  'rgb(64, 200, 208)',
  'rgb(244, 114, 182)',
  'rgb(148, 163, 184)',
];

/** The platform's semantic five, so a chart agrees with the badge beside it. */
export const TONES = {
  ok: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--critical)',
  info: 'var(--info)',
  accent: 'var(--orange)',
  neutral: 'var(--text-3)',
};

/** A series colour by index, wrapping rather than running out. */
export const seriesColour = (index) => SERIES[index % SERIES.length];

/** Resolve a caller's tone name, a raw colour, or an index, to a paint. */
function paint(value, index = 0) {
  if (value === undefined || value === null || value === '') return seriesColour(index);
  return TONES[value] ?? String(value);
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
    lo -= pad;
    hi += pad;
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

    return html`${filled && fill ? html`<path d="${raw(fill)}" fill="${raw(colour)}" opacity="0.16" />` : ''}
      <path class="chart-line" d="${raw(line)}" stroke="${raw(colour)}" fill="none" />
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
            stroke="${raw(paint(line.tone ?? 'warn'))}"
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
    return html`<path class="chart-slice" d="${raw(path)}" fill="${raw(paint(slice.tone, index))}" fill-rule="evenodd">
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
          <rect width="10" height="10" rx="2" fill="${raw(paint(slice.tone, index))}" />
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

  const box = { w: 320, h: 208 };
  const cx = 160;
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
  const resolved = tone ?? (target === undefined ? 'accent' : Number(value) >= Number(target) ? 'ok' : 'warn');

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
  const cell = Math.min(46, Math.max(18, Math.floor(560 / columns.length)));
  const left = 150;
  const top = 46;
  const box = { w: left + columns.length * cell + 20, h: top + rows.length * cell + 22 };
  const base = paint(tone);

  return frame({
    title,
    box,
    footnote,
    desc: desc ?? `${rows.length} rows by ${columns.length} columns. Darkest cell is ${format(max)}.`,
    body: html`${columns.map(
      (column, index) => html`<text class="chart-cat" x="${raw(r2(left + index * cell + cell / 2))}" y="${raw(top - 10)}" text-anchor="middle">
        ${column}
      </text>`,
    )}
    ${rows.map(
      (row, rowIndex) => html`<g>
        <text class="chart-cat" x="${raw(left - 10)}" y="${raw(r2(top + rowIndex * cell + cell / 2 + 4))}" text-anchor="end">${row}</text>
        ${columns.map((column, columnIndex) => {
          const value = values[rowIndex]?.[columnIndex];
          const share = finite(value) && max > 0 ? Number(value) / max : 0;
          return html`<rect
            class="chart-cell"
            x="${raw(r2(left + columnIndex * cell))}"
            y="${raw(r2(top + rowIndex * cell))}"
            width="${raw(cell - 2)}"
            height="${raw(cell - 2)}"
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
          fill="${raw(paint(stage.tone, index))}"
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
          fill="${raw(paint(node.tone, index))}"
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
export function ganttChart({
  tasks = [],
  title = 'Programme',
  desc,
  today,
  /** The line between what happened and what is forecast. Alias of `today`. */
  dataDate,
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
    }))
    .filter((task) => Number.isFinite(task.from) && Number.isFinite(task.to) && task.to >= task.from);
  if (bars.length === 0) return emptyChart(empty);

  // Baselines are inside the extent. A task that slipped has a baseline earlier
  // than every current date, and leaving it out of the scale draws the
  // comparison off the left edge — losing exactly the bar the reader opened the
  // chart for.
  const dates = bars.flatMap((bar) => [bar.from, bar.to, bar.baseFrom, bar.baseTo].filter(Number.isFinite));
  const min = Math.min(...dates);
  const max = Math.max(...dates);
  const rowHeight = 30;
  const left = 210;
  const box = { w: 760, h: Math.max(120, bars.length * rowHeight + 56) };
  const right = box.w - 20;
  const x = scale(min, max, left, right);
  const nowAt = today ?? dataDate ? Date.parse(today ?? dataDate) : Date.now();

  // Month gridlines, because a Gantt with no calendar behind it is a set of
  // floating rectangles.
  const months = [];
  const cursor = new Date(min);
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= max && months.length < 48) {
    if (cursor.getTime() >= min) months.push(new Date(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }

  const dayMs = 86_400_000;
  return frame({
    title,
    box,
    footnote,
    desc:
      desc ??
      `${bars.length} activities from ${new Date(min).toISOString().slice(0, 10)} to ${new Date(max).toISOString().slice(0, 10)}, ` +
        `a span of ${Math.round((max - min) / dayMs)} days.`,
    body: html`${months.map(
      (month) => html`<g class="chart-grid">
        <line x1="${raw(r2(x(month.getTime())))}" y1="30" x2="${raw(r2(x(month.getTime())))}" y2="${raw(box.h - 20)}" />
        <text x="${raw(r2(x(month.getTime())))}" y="22" text-anchor="middle">
          ${raw(month.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }))}
        </text>
      </g>`,
    )}
    ${Number.isFinite(nowAt) && nowAt >= min && nowAt <= max
      ? html`<line class="chart-today" x1="${raw(r2(x(nowAt)))}" y1="30" x2="${raw(r2(x(nowAt)))}" y2="${raw(box.h - 20)}">
          <title>Today</title>
        </line>`
      : ''}
    ${bars.map((bar, index) => {
      const y = 36 + index * rowHeight;
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

      return html`<g>
        <text class="chart-cat" x="${raw(left - 12)}" y="${raw(y + 15)}" text-anchor="end">
          <title>${bar.label}</title>${fitLabel(bar.label, left - 22)}
        </text>
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
                }</title>
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
  'proportion',
];

/** Escape hatch for a caller that needs the raw palette in a non-SVG context. */
export { esc };
