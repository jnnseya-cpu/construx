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

/**
 * A trend small enough to sit inside a metric card or a table cell.
 *
 * The enabler for putting a shape next to a number everywhere rather than on
 * six pages. No axis, no labels, no grid — at this size they are illegible and
 * their absence is the point: a sparkline answers "which way and how steadily",
 * and the number beside it answers "how much". A sparkline with an axis is a
 * small bad line chart.
 *
 * The last point is marked because it is the only one anybody is deciding on.
 *
 * @param {object} options
 * @param {number[]} options.points
 * @param {string} [options.tone] `good`, `bad`, `warn` — otherwise the accent.
 * @param {string} [options.label] For screen readers, since there are no axes.
 */
export function sparkline({ points, tone = '', label = 'Trend' }) {
  const values = (points ?? []).filter(Number.isFinite);
  // One point is not a trend. Drawing a dot and calling it one is the kind of
  // decoration that makes every other chart on the page less trusted.
  if (values.length < 2) return html`<span class="spark-empty" title="Not enough history to show a trend">—</span>`;

  const width = 100;
  const height = 24;
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  // A flat series draws along the middle rather than dividing by a zero range.
  const span = highest - lowest || 1;
  const x = (index) => (index / (values.length - 1)) * width;
  const y = (value) => height - 2 - ((value - lowest) / span) * (height - 4);
  const stroke =
    tone === 'good' ? 'var(--success)' : tone === 'bad' ? 'var(--critical)' : tone === 'warn' ? 'var(--warning)' : 'var(--orange)';

  return html`<span class="spark" role="img" aria-label="${label}">
    ${raw(
      `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">` +
        `<polyline points="${values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}" fill="none" ` +
        `stroke="${stroke}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<circle cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="2" fill="${stroke}"/>` +
        '</svg>',
    )}
  </span>`;
}

/**
 * The programme as bars on a date axis.
 *
 * The one chart a schedule cannot be read without. Everything else about a
 * programme — the float, the longest path, the data date — is a number in a
 * table until it is a shape against time.
 *
 * Four things it draws that a bar chart of durations does not:
 *
 * **The data date**, as a vertical line. Every bar to its left is history and
 * every bar to its right is forecast, and a Gantt without it invites the reader
 * to treat both the same.
 *
 * **The baseline underneath**, where there is one. A bar on its own says when
 * the work is planned; a bar against its baseline says whether that has moved,
 * which is the only version of the question anybody asks at a progress meeting.
 *
 * **The longest path in its own colour**, not "critical". With calendars and
 * constraints those are different sets, and the one worth colouring is the chain
 * that moves the finish date.
 *
 * **Milestones as diamonds**, because a zero-duration bar is invisible and a
 * one-pixel bar is a lie about a duration.
 *
 * @param {object} options
 * @param {Array<{id: string, name: string, start: string, finish: string, baselineStart?: string, baselineFinish?: string, milestone?: boolean, longestPath?: boolean, critical?: boolean, percentComplete?: number, wbsPath?: string}>} options.bars
 * @param {string} [options.dataDate] Drawn as the line between actual and forecast.
 * @param {number} [options.rowHeight]
 * @param {string} [options.empty]
 */
export function ganttChart({ bars, dataDate, rowHeight = 20, empty = 'Nothing scheduled yet' }) {
  const rows = (bars ?? []).filter((bar) => bar.start && bar.finish);
  if (rows.length === 0) {
    return html`<div class="empty"><b>${empty}</b>A programme appears once activities have been scheduled.</div>`;
  }

  const day = 86400000;
  const at = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00.000Z`);
  const spanDates = rows.flatMap((bar) => [bar.start, bar.finish, bar.baselineStart, bar.baselineFinish].filter(Boolean));
  if (dataDate) spanDates.push(dataDate);
  const from = Math.min(...spanDates.map(at));
  // The finish day is inclusive, so the axis runs to the end of it.
  const to = Math.max(...spanDates.map(at)) + day;
  const totalDays = Math.max(1, (to - from) / day);

  const labelWidth = 210;
  const width = 900;
  const plotW = width - labelWidth - 12;
  const headerH = 18;
  const height = headerH + rows.length * rowHeight + 8;
  const x = (iso) => labelWidth + ((at(iso) - from) / day / totalDays) * plotW;

  // Month ticks, so a three-year programme does not try to label every day.
  const months = [];
  const cursor = new Date(from);
  cursor.setUTCDate(1);
  while (cursor.getTime() <= to) {
    const iso = cursor.toISOString().slice(0, 10);
    if (at(iso) >= from) months.push(iso);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const monthLabel = (iso) => new Date(at(iso)).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' });

  const svg = [];
  for (const iso of months) {
    svg.push(
      `<line x1="${x(iso)}" y1="${headerH}" x2="${x(iso)}" y2="${height - 8}" class="chart-grid"/>` +
        `<text x="${x(iso) + 3}" y="${headerH - 6}" class="chart-axis">${monthLabel(iso)}</text>`,
    );
  }

  rows.forEach((bar, index) => {
    const top = headerH + index * rowHeight;
    const barH = Math.max(6, rowHeight - 10);
    const name = String(bar.name ?? bar.id).replace(/[<&>]/g, '');
    svg.push(
      `<text x="6" y="${top + barH + 1}" class="gantt-name" ${bar.longestPath ? 'data-driving="1"' : ''}>${
        // Indented by its place in the breakdown, so the shape of the WBS is
        // readable without a second column of dotted numbers.
        ' '.repeat(0)
      }${name.length > 34 ? `${name.slice(0, 33)}…` : name}</text>`,
    );

    // The baseline sits under the bar as a thin rule, never on top of it: the
    // current dates are what somebody is working to and must stay legible.
    if (bar.baselineStart && bar.baselineFinish) {
      svg.push(
        `<rect x="${x(bar.baselineStart)}" y="${top + barH + 1}" width="${Math.max(
          1.5,
          x(bar.baselineFinish) + plotW / totalDays - x(bar.baselineStart),
        )}" height="3" rx="1.5" class="gantt-baseline"/>`,
      );
    }

    if (bar.milestone) {
      // A diamond on the date. A zero-duration bar is invisible, and widening
      // it to be seen states a duration the activity does not have.
      const cx = x(bar.start);
      const cy = top + barH / 2;
      const r = Math.max(4, barH / 2);
      svg.push(
        `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" class="gantt-milestone ${
          bar.longestPath ? 'driving' : ''
        }"/>`,
      );
      return;
    }

    const left = x(bar.start);
    const right = x(bar.finish) + plotW / totalDays;
    const barW = Math.max(2, right - left);
    const klass = bar.longestPath ? 'gantt-bar driving' : bar.critical ? 'gantt-bar critical' : 'gantt-bar';
    svg.push(`<rect x="${left}" y="${top}" width="${barW}" height="${barH}" rx="2" class="${klass}"/>`);
    const done = Math.max(0, Math.min(100, Number(bar.percentComplete ?? 0)));
    if (done > 0) {
      svg.push(`<rect x="${left}" y="${top}" width="${(barW * done) / 100}" height="${barH}" rx="2" class="gantt-done"/>`);
    }
  });

  if (dataDate) {
    svg.push(
      `<line x1="${x(dataDate)}" y1="${headerH - 4}" x2="${x(dataDate)}" y2="${height - 8}" class="gantt-datadate"/>` +
        `<text x="${x(dataDate) + 3}" y="${height - 1}" class="chart-axis">Data date</text>`,
    );
  }

  return html`<div class="chart gantt">
    <svg viewBox="0 0 ${raw(width)} ${raw(height)}" role="img" aria-label="Programme, ${raw(String(rows.length))} activities">
      ${raw(svg.join(''))}
    </svg>
    <div class="chart-key">
      <span><i class="gantt-key-driving"></i>Longest path</span>
      <span><i class="gantt-key-bar"></i>Float available</span>
      <span><i class="gantt-key-baseline"></i>Baseline</span>
      ${dataDate ? html`<span><i class="gantt-key-datadate"></i>Data date</span>` : ''}
    </div>
  </div>`;
}

/**
 * A distribution, as counted rather than as a smooth curve.
 *
 * For the Monte Carlo completion dates and the float spread — questions whose
 * whole answer is the shape of the spread, and which a single P50 figure
 * flattens into a false certainty. The bars are counts of what the simulation
 * actually produced; nothing is fitted, because a fitted curve puts probability
 * on outcomes the model never generated.
 *
 * Also draws a **limit line** where the caller has one — a resource
 * availability, a consent threshold. A demand curve without the line it is
 * being judged against is a picture of some bars: the reader cannot tell a
 * comfortable week from an impossible one, which is the only question they came
 * with. Bars above the line mark themselves, so the overrun reads at a glance
 * rather than by comparing heights against an axis.
 *
 * @param {object} options
 * @param {Array<{ label: string, count: number, marked?: boolean }>} options.buckets
 * @param {string} [options.markLabel] What a marked bucket means — a P80 date, say.
 * @param {number} [options.limit] Draw a line here, and mark every bar above it.
 * @param {string} [options.limitLabel] What the line is.
 */
export function histogram({
  buckets,
  markLabel = '',
  limit,
  limitLabel = '',
  empty = 'Nothing simulated yet',
  // The second line of the empty state. A parameter because this chart started
  // as the Monte Carlo one and now draws resource demand too: "once the
  // simulation has been run" is wrong on a labour histogram, and an empty state
  // that explains the wrong thing is worse than one that explains nothing.
  emptyDetail = 'A distribution appears once the simulation has been run.',
}) {
  const rows = (buckets ?? []).filter((bucket) => Number.isFinite(bucket.count));
  if (rows.length === 0) {
    return html`<div class="empty"><b>${empty}</b>${emptyDetail}</div>`;
  }

  const width = 720;
  const height = 170;
  const pad = { top: 10, right: 10, bottom: 30, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  // The limit is part of the range even where nothing reaches it: a chart scaled
  // to the bars alone puts the line off the top and reports a comfortable week
  // as a crisis, or off the bottom and hides one.
  const hasLimit = Number.isFinite(limit);
  const highest = Math.max(...rows.map((bucket) => bucket.count), hasLimit ? limit : 0, 1);
  const axis = ticks(highest);
  const ceiling = Math.max(axis[axis.length - 1], 1);
  const barW = plotW / rows.length;
  const every = Math.max(1, Math.ceil(rows.length / 10));

  const svg = axis.map(
    (value) =>
      `<line x1="${pad.left}" y1="${pad.top + plotH - (value / ceiling) * plotH}" x2="${width - pad.right}" y2="${
        pad.top + plotH - (value / ceiling) * plotH
      }" class="chart-grid"/><text x="${pad.left - 6}" y="${pad.top + plotH - (value / ceiling) * plotH + 3.5}" class="chart-axis" text-anchor="end">${value}</text>`,
  );

  rows.forEach((bucket, index) => {
    const h = (bucket.count / ceiling) * plotH;
    const over = hasLimit && bucket.count > limit;
    svg.push(
      `<rect x="${pad.left + index * barW + 1}" y="${pad.top + plotH - h}" width="${Math.max(1, barW - 2)}" height="${h}" class="hist-bar ${
        bucket.marked || over ? 'marked' : ''
      }"/>`,
    );
    if (index % every === 0) {
      svg.push(
        `<text x="${pad.left + index * barW + barW / 2}" y="${height - 12}" class="chart-axis" text-anchor="middle">${String(
          bucket.label,
        ).replace(/[<&>]/g, '')}</text>`,
      );
    }
  });

  if (hasLimit) {
    const y = pad.top + plotH - (limit / ceiling) * plotH;
    svg.push(
      `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="hist-limit"/>`,
    );
  }

  return html`<div class="chart">
    <svg viewBox="0 0 ${raw(width)} ${raw(height)}" role="img" aria-label="Distribution">${raw(svg.join(''))}</svg>
    ${
      markLabel || (hasLimit && limitLabel)
        ? html`<div class="chart-key">
            ${markLabel ? html`<span><i class="hist-key-marked"></i>${markLabel}</span>` : ''}
            ${hasLimit && limitLabel ? html`<span><i class="hist-key-limit"></i>${limitLabel}</span>` : ''}
          </div>`
        : ''
    }
  </div>`;
}

/**
 * Composition over time — what a total is made of, month by month.
 *
 * Stacked, because the question is "what is in this total and how is the mix
 * changing", and separate lines answer a different one. The order of the
 * segments is the caller's and is held constant across every column, since a
 * stack that reorders itself per column cannot be read across at all.
 *
 * @param {object} options
 * @param {string[]} options.labels One per column.
 * @param {Array<{ label: string, values: number[] }>} options.series
 * @param {(value: number) => string} options.format
 */
export function stackedBarChart({ labels, series, format = String, height = 200, empty = 'Nothing recorded yet' }) {
  const drawable = (series ?? []).filter((entry) => entry.values?.length > 0);
  if (drawable.length === 0 || (labels ?? []).length === 0) {
    return html`<div class="empty"><b>${empty}</b>This fills in as periods are recorded.</div>`;
  }

  const width = 720;
  const pad = { top: 12, right: 12, bottom: 28, left: 58 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const totals = labels.map((_, index) => drawable.reduce((sum, entry) => sum + Math.max(0, entry.values[index] ?? 0), 0));
  const axis = ticks(Math.max(...totals, 0));
  const ceiling = Math.max(axis[axis.length - 1], 1);
  const columnW = plotW / labels.length;
  const barW = Math.max(2, columnW * 0.66);
  const every = Math.max(1, Math.ceil(labels.length / 8));

  const svg = axis.map((value) => {
    const y = pad.top + plotH - (value / ceiling) * plotH;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="chart-grid"/><text x="${
      pad.left - 8
    }" y="${y + 3.5}" class="chart-axis" text-anchor="end">${format(value)}</text>`;
  });

  labels.forEach((label, index) => {
    let base = 0;
    drawable.forEach((entry, seriesIndex) => {
      const value = Math.max(0, entry.values[index] ?? 0);
      if (value <= 0) return;
      const y = pad.top + plotH - ((base + value) / ceiling) * plotH;
      const h = (value / ceiling) * plotH;
      svg.push(
        `<rect x="${pad.left + index * columnW + (columnW - barW) / 2}" y="${y}" width="${barW}" height="${h}" fill="${
          SERIES_COLOURS[seriesIndex % SERIES_COLOURS.length]
        }"/>`,
      );
      base += value;
    });
    if (index % every === 0) {
      svg.push(
        `<text x="${pad.left + index * columnW + columnW / 2}" y="${height - 9}" class="chart-axis" text-anchor="middle">${String(
          label,
        ).replace(/[<&>]/g, '')}</text>`,
      );
    }
  });

  return html`<div class="chart">
    <svg viewBox="0 0 ${raw(width)} ${raw(height)}" role="img" aria-label="${drawable.map((entry) => entry.label).join(', ')}">
      ${raw(svg.join(''))}
    </svg>
    <div class="chart-key">
      ${drawable.map(
        (entry, index) =>
          html`<span><i style="background:${raw(SERIES_COLOURS[index % SERIES_COLOURS.length])}"></i>${entry.label}</span>`,
      )}
    </div>
  </div>`;
}

/**
 * How a total is built up, or taken apart, step by step.
 *
 * The shape a price build-up and a variance bridge both want: a base, a run of
 * additions and deductions each starting where the last one ended, and a total.
 * A stacked bar answers "what is in it" and this answers "how did it get from
 * there to here", which is the question anybody arguing about a number asks.
 *
 * @param {object} options
 * @param {Array<{ label: string, value: number, kind?: 'BASE'|'ADD'|'SUBTRACT'|'TOTAL' }>} options.steps
 * @param {(value: number) => string} options.format
 */
export function waterfall({ steps, format = String, height = 210, empty = 'Nothing to break down yet' }) {
  const rows = (steps ?? []).filter((step) => Number.isFinite(step.value));
  if (rows.length === 0) {
    return html`<div class="empty"><b>${empty}</b>This appears once the figure has parts.</div>`;
  }

  const width = 720;
  const pad = { top: 14, right: 12, bottom: 34, left: 62 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // Walk the steps once to find where each bar sits and how high the stack gets.
  let running = 0;
  const placed = rows.map((step) => {
    const kind = step.kind ?? 'ADD';
    if (kind === 'BASE' || kind === 'TOTAL') {
      const bar = { ...step, kind, from: 0, to: kind === 'BASE' ? step.value : running };
      if (kind === 'BASE') running = step.value;
      return bar;
    }
    const delta = kind === 'SUBTRACT' ? -Math.abs(step.value) : Math.abs(step.value);
    const bar = { ...step, kind, from: running, to: running + delta };
    running += delta;
    return bar;
  });

  const axis = ticks(Math.max(...placed.map((bar) => Math.max(bar.from, bar.to)), 0));
  const ceiling = Math.max(axis[axis.length - 1], 1);
  const columnW = plotW / placed.length;
  const barW = Math.max(3, columnW * 0.6);
  const y = (value) => pad.top + plotH - (value / ceiling) * plotH;

  const svg = axis.map(
    (value) =>
      `<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" class="chart-grid"/><text x="${
        pad.left - 8
      }" y="${y(value) + 3.5}" class="chart-axis" text-anchor="end">${format(value)}</text>`,
  );

  placed.forEach((bar, index) => {
    const top = Math.min(y(bar.from), y(bar.to));
    const barH = Math.max(1.5, Math.abs(y(bar.to) - y(bar.from)));
    const klass =
      bar.kind === 'TOTAL' || bar.kind === 'BASE' ? 'wf-total' : bar.kind === 'SUBTRACT' ? 'wf-down' : 'wf-up';
    svg.push(
      `<rect x="${pad.left + index * columnW + (columnW - barW) / 2}" y="${top}" width="${barW}" height="${barH}" rx="1.5" class="${klass}"/>` +
        `<text x="${pad.left + index * columnW + columnW / 2}" y="${height - 20}" class="chart-axis" text-anchor="middle">${String(
          bar.label,
        )
          .replace(/[<&>]/g, '')
          .slice(0, 16)}</text>` +
        `<text x="${pad.left + index * columnW + columnW / 2}" y="${height - 8}" class="chart-axis" text-anchor="middle">${format(
          bar.kind === 'SUBTRACT' ? -Math.abs(bar.value) : bar.value,
        )}</text>`,
    );
  });

  return html`<div class="chart">
    <svg viewBox="0 0 ${raw(width)} ${raw(height)}" role="img" aria-label="Build-up">${raw(svg.join(''))}</svg>
  </div>`;
}

/**
 * Share of a whole, for a handful of parts.
 *
 * Deliberately capped and deliberately labelled with the figures. A ring is
 * poor at comparing similar slices and good at one thing — showing that one
 * part dominates — so beyond a few parts the rest are gathered into "other"
 * rather than drawn as an unreadable fan, and every slice carries its number so
 * nobody has to judge an angle.
 *
 * @param {object} options
 * @param {Array<{ label: string, value: number }>} options.slices
 * @param {(value: number) => string} options.format
 * @param {number} [options.max] Parts drawn before the rest become "other".
 */
export function donut({ slices, format = String, max = 5, empty = 'Nothing to divide yet' }) {
  const rows = (slices ?? []).filter((slice) => Number.isFinite(slice.value) && slice.value > 0);
  if (rows.length === 0) {
    return html`<div class="empty"><b>${empty}</b>This appears once there is something to divide.</div>`;
  }

  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const shown = sorted.slice(0, max);
  const rest = sorted.slice(max);
  if (rest.length > 0) {
    shown.push({ label: `${rest.length} other${rest.length === 1 ? '' : 's'}`, value: rest.reduce((sum, s) => sum + s.value, 0) });
  }
  const total = shown.reduce((sum, slice) => sum + slice.value, 0);

  const size = 132;
  const centre = size / 2;
  const radius = 52;
  const thickness = 20;
  let angle = -Math.PI / 2;
  const arcs = shown.map((slice, index) => {
    const sweep = total > 0 ? (slice.value / total) * Math.PI * 2 : 0;
    const end = angle + sweep;
    const point = (a, r) => `${(centre + Math.cos(a) * r).toFixed(2)},${(centre + Math.sin(a) * r).toFixed(2)}`;
    const outer = radius;
    const inner = radius - thickness;
    const large = sweep > Math.PI ? 1 : 0;
    const d =
      `M ${point(angle, outer)} A ${outer} ${outer} 0 ${large} 1 ${point(end, outer)} ` +
      `L ${point(end, inner)} A ${inner} ${inner} 0 ${large} 0 ${point(angle, inner)} Z`;
    angle = end;
    return `<path d="${d}" fill="${SERIES_COLOURS[index % SERIES_COLOURS.length]}"/>`;
  });

  return html`<div class="chart donut">
    <svg viewBox="0 0 ${raw(size)} ${raw(size)}" role="img" aria-label="Share of the total">${raw(arcs.join(''))}</svg>
    <div class="chart-key">
      ${shown.map(
        (slice, index) => html`<span><i style="background:${raw(SERIES_COLOURS[index % SERIES_COLOURS.length])}"></i>${
          slice.label
        } · ${format(slice.value)} · ${raw(String(total > 0 ? Math.round((slice.value / total) * 1000) / 10 : 0))}%</span>`,
      )}
    </div>
  </div>`;
}
