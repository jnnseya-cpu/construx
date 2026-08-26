import { html, raw } from './ui.js';

/**
 * Numeric series as inline SVG.
 *
 * The console had no way to draw a trend. Every figure it showed was a single
 * number, which answers "what is it" and never "is it moving" — and for spend,
 * margin and revenue the second question is the one an operator opens the screen
 * for. Rendered as SVG in the document rather than through a charting library:
 * the zero-runtime-dependency decision is settled, and a line chart over a
 * bounded series does not need one.
 *
 * Three rules these hold to, because each is a way a chart misleads:
 *
 * **No axis is invented.** A series of zeroes draws a flat line along the floor
 * with a labelled zero ceiling, not an auto-scaled line halfway up the panel
 * that implies activity. The scale is stated on the axis every time.
 *
 * **An empty series draws nothing.** Where there is no data these return the
 * caller's empty state rather than an axis around blank space, which reads as a
 * failure to load.
 *
 * **Nothing is smoothed.** Points are joined straight. A curve through sparse
 * daily figures invents readings between the days that were actually measured.
 */

/** The palette, taken from the design system rather than restated. */
const SERIES_COLOURS = ['var(--orange)', 'var(--info)', 'var(--success)', 'var(--warning)', 'var(--text-2)'];

/** Grid lines and axis ticks: nice round values covering `max`. */
function ticks(max, count = 4) {
  if (max <= 0) return [0];
  const step = max / count;
  // Rounded up to one significant figure so the axis reads 0/25/50/75/100
  // rather than 0/23.7/47.4 — an axis nobody can read at a glance is decoration.
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= step) ?? magnitude * 10;
  const out = [];
  for (let value = 0; value <= max + nice / 2; value += nice) out.push(value);
  return out;
}

/**
 * A multi-series line chart over a shared x axis.
 *
 * @param {object} options
 * @param {Array<{ label: string, points: number[] }>} options.series One entry per line; every `points` array must be the same length as `labels`.
 * @param {string[]} options.labels One per x position. Rendered thinned so they never overlap.
 * @param {(value: number) => string} options.format Turns an axis value into its label — money, units, whatever the series is.
 * @param {number} [options.height] Plot height in px.
 * @param {string} [options.empty] Shown instead of the chart when there is nothing to draw.
 */
export function lineChart({ series, labels, format = String, height = 190, empty = 'Nothing recorded yet' }) {
  const drawable = (series ?? []).filter((line) => line.points?.length > 0);
  if (drawable.length === 0 || (labels ?? []).length === 0) {
    return html`<div class="empty"><b>${empty}</b>A trend appears once there is more than one day of history.</div>`;
  }

  const width = 720;
  const pad = { top: 12, right: 12, bottom: 26, left: 56 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const highest = Math.max(0, ...drawable.flatMap((line) => line.points));
  const axis = ticks(highest);
  // A flat zero series still needs a ceiling, or every point divides by zero.
  const ceiling = Math.max(axis[axis.length - 1], 1);

  const x = (index, count) => pad.left + (count <= 1 ? plotW / 2 : (index / (count - 1)) * plotW);
  const y = (value) => pad.top + plotH - (value / ceiling) * plotH;

  // Thinned so labels never collide: at most eight along the axis.
  const every = Math.max(1, Math.ceil(labels.length / 8));

  return html`<div class="chart">
    <svg viewBox="0 0 ${raw(width)} ${raw(height)}" preserveAspectRatio="none" role="img"
         aria-label="${drawable.map((line) => line.label).join(', ')}">
      ${axis.map(
        (value) => raw(`<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" class="chart-grid"/>
          <text x="${pad.left - 8}" y="${y(value) + 3.5}" class="chart-axis" text-anchor="end">${format(value)}</text>`),
      )}
      ${labels.map((label, index) =>
        index % every === 0
          ? raw(`<text x="${x(index, labels.length)}" y="${height - 8}" class="chart-axis" text-anchor="middle">${label}</text>`)
          : '',
      )}
      ${drawable.map((line, lineIndex) => {
        const colour = SERIES_COLOURS[lineIndex % SERIES_COLOURS.length];
        const points = line.points.map((value, index) => `${x(index, line.points.length)},${y(value)}`).join(' ');
        return raw(
          `<polyline points="${points}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
            // The last reading, marked. It is the only point on the line an
            // operator is deciding anything on today.
            `<circle cx="${x(line.points.length - 1, line.points.length)}" cy="${y(line.points[line.points.length - 1])}" r="3" fill="${colour}"/>`,
        );
      })}
    </svg>
    <div class="chart-key">
      ${drawable.map(
        (line, index) =>
          html`<span><i style="background:${raw(SERIES_COLOURS[index % SERIES_COLOURS.length])}"></i>${line.label}</span>`,
      )}
    </div>
  </div>`;
}

/**
 * Ranked horizontal bars — a leaderboard, not a distribution.
 *
 * Each bar is drawn against the largest value present, so the top bar is always
 * full width and the rest are read relative to it. That is the honest scale for
 * "who is the biggest", which is the only question this shape answers well.
 *
 * @param {object} options
 * @param {Array<{ label: string, value: number, sub?: string, tone?: string }>} options.bars
 * @param {(value: number) => string} options.format
 * @param {string} [options.empty]
 */
export function barChart({ bars, format = String, empty = 'Nothing recorded yet' }) {
  const rows = (bars ?? []).filter((bar) => Number.isFinite(bar.value));
  if (rows.length === 0) {
    return html`<div class="empty"><b>${empty}</b>This populates as the estate records activity.</div>`;
  }

  const largest = Math.max(...rows.map((bar) => bar.value), 0);
  return html`<div class="bars">
    ${rows.map(
      (bar) => html`<div class="bar-row">
        <div class="bar-label">${bar.label}${bar.sub ? html`<span>${bar.sub}</span>` : ''}</div>
        <div class="track">
          <i class="${raw(bar.tone ?? '')}" style="width:${raw(largest > 0 ? (bar.value / largest) * 100 : 0)}%"></i>
        </div>
        <div class="bar-value">${format(bar.value)}</div>
      </div>`,
    )}
  </div>`;
}
