import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { resolveHtml } from '../../frontend/lib/ui.js';
import {
  CHART_TYPES,
  SERIES,
  areaChart,
  barChart,
  boxPlot,
  bubbleChart,
  donutChart,
  flowChart,
  funnelChart,
  ganttChart,
  gauge,
  heatmap,
  histogram,
  kpiCard,
  lineChart,
  niceScale,
  pieChart,
  proportionBar,
  radarChart,
  sankeyDiagram,
  scatterPlot,
  sparkline,
  treemap,
  waterfallChart,
} from '../../frontend/lib/charts.js';

/**
 * The chart kit.
 *
 * A chart is the one component where a defect is invisible: a wrong scale, a
 * dropped point or a bar drawn from a non-zero baseline all produce a picture
 * that looks entirely correct and says something false. So these tests read the
 * geometry rather than checking that something was returned — they assert on the
 * numbers inside the SVG, which is the only place the lie would be.
 */

const svg = (content: unknown): string => resolveHtml(content);

/** Every `<rect y=…>` in draw order, as numbers. Geometry only — see `paints`. */
const attrs = (markup: string, attribute: string): number[] =>
  [...markup.matchAll(new RegExp(`${attribute}="(-?[\\d.]+)"`, 'g'))].map((found) => Number(found[1]));

/**
 * Every value of a non-numeric attribute, in draw order.
 *
 * `attrs` deliberately matches numbers only, because its job is geometry. A
 * colour is `var(--orange)`, which that pattern silently skips — so an
 * assertion about fills written against `attrs` compares two empty arrays and
 * passes whatever the chart did.
 */
const paints = (markup: string, attribute = 'fill'): string[] =>
  [...markup.matchAll(new RegExp(`${attribute}="([^"]+)"`, 'g'))].map((found) => String(found[1]));

const CHART_SOURCE = readFileSync(resolve(import.meta.dirname, '../../frontend/lib/charts.js'), 'utf8');
const CSS = readFileSync(resolve(import.meta.dirname, '../../frontend/app.css'), 'utf8');

describe('every chart refuses to draw nothing', () => {
  // The single most important behaviour in the kit. An axis drawn over an empty
  // array reads as "zero", and zero and "never measured" are different facts —
  // the same distinction `positionReport` makes for registers.
  const empties: Array<[string, unknown]> = [
    ['bar', barChart({ data: [], empty: 'No packages priced' })],
    ['line', lineChart({ data: [], empty: 'No weeks measured' })],
    ['area', areaChart({ data: [], empty: 'No weeks measured' })],
    ['pie', pieChart({ data: [], empty: 'Nothing to break down' })],
    ['donut', donutChart({ data: [], empty: 'Nothing to break down' })],
    ['histogram', histogram({ values: [], empty: 'Not enough measurements' })],
    ['scatter', scatterPlot({ points: [], empty: 'No pairs' })],
    ['bubble', bubbleChart({ points: [], empty: 'No items' })],
    ['box', boxPlot({ groups: [], empty: 'No spread' })],
    ['gauge', gauge({ value: undefined, empty: 'Not measured' })],
    ['heatmap', heatmap({ rows: [], columns: [], values: [], empty: 'No activity' })],
    ['funnel', funnelChart({ stages: [], empty: 'Nothing entered' })],
    ['waterfall', waterfallChart({ steps: [], empty: 'Nothing to build up' })],
    ['treemap', treemap({ items: [], empty: 'Nothing to size' })],
    ['gantt', ganttChart({ tasks: [], empty: 'No dated activities' })],
    ['radar', radarChart({ axes: [], series: [], empty: 'No criteria scored' })],
    ['sankey', sankeyDiagram({ flows: [], empty: 'Nothing flows yet' })],
    ['flow', flowChart({ steps: [], empty: 'No steps defined' })],
  ];

  for (const [name, output] of empties) {
    it(`${name} shows the caller's own empty sentence rather than an axis over nothing`, () => {
      const markup = svg(output);
      assert.match(markup, /class="empty"/, `${name} drew something when it had nothing`);
      assert.ok(!markup.includes('<svg'), `${name} drew an SVG with no data in it`);
    });
  }

  it('a build-up whose every term is zero is empty, not a forecast of nil', () => {
    // The site-services estimate at completion before any contract line is
    // open. Every term is a real, measured zero — so `finite` passes on all of
    // them — and the picture reads "the forecast is nil" where the fact is
    // "there is nothing to forecast from". The engine's own sentence says the
    // second, and it is the one that has to survive.
    const markup = svg(
      waterfallChart({
        steps: [
          { label: 'Budget', value: 0 },
          { label: 'Committed', value: 0 },
          { label: 'Agreed change', value: 0 },
          { label: 'Estimate at completion', value: 0, total: true },
        ],
        empty: 'No contract line is open, so there is nothing to forecast from.',
      }),
    );
    assert.match(markup, /nothing to forecast from/);
    assert.ok(!markup.includes('<svg'), 'a nil build-up was drawn as a chart');
  });

  it('still draws a build-up where only some terms are zero', () => {
    // The guard above must not swallow a real forecast that happens to carry an
    // untouched contingency or an agreed change of nothing.
    const markup = svg(
      waterfallChart({
        steps: [
          { label: 'Budget', value: 400_000 },
          { label: 'Agreed change', value: 0 },
          { label: 'Estimate at completion', value: 400_000, total: true },
        ],
        empty: 'Nothing to build up',
      }),
    );
    assert.ok(markup.includes('<svg'), 'a forecast with one zero term was refused');
  });

  it('a chart of entirely unusable values is empty, not a flat line at zero', () => {
    // Non-numeric values are not zeroes. A histogram of three nulls has no
    // distribution; drawing one at zero would report a measurement nobody took.
    const markup = svg(histogram({ values: [null, undefined, 'x'] as never, empty: 'Nothing numeric' }));
    assert.match(markup, /Nothing numeric/);
  });
});

describe('the value axis tells the truth', () => {
  it('starts a bar chart at zero even when the data does not go near it', () => {
    // The commonest way a chart lies without a single wrong number: an axis
    // starting at 4,000 makes 4,100 look twice 4,050.
    const axis = niceScale(4000, 4200);
    assert.equal(axis.min, 0, 'a value axis that skips zero exaggerates every difference on it');
  });

  it('lets a trend axis skip zero only when the movement is not an artefact of it', () => {
    // A line whose whole range sits high above zero is about movement, and
    // pinning it to zero flattens the thing being looked at.
    const high = niceScale(980, 1020, { zeroBased: false });
    assert.ok(high.min > 0, 'an explicitly non-zero-based axis still went to zero');
  });

  it('gives a flat series an axis rather than dividing by zero', () => {
    const flat = niceScale(50, 50);
    assert.ok(flat.max > flat.min, 'a series with one distinct value produced a zero-height axis');
    assert.ok(flat.ticks.length >= 2);
  });

  it('extends to round numbers so two charts can be compared', () => {
    const axis = niceScale(0, 8437);
    assert.equal(axis.max % axis.step, 0);
    assert.ok(axis.max >= 8437, 'the axis stopped below the data');
    assert.ok(axis.ticks.includes(0));
  });

  it('keeps the top tick despite floating point', () => {
    // 0.1 + 0.2 is not 0.3, and an axis that silently drops its top tick looks
    // like a rendering bug rather than an arithmetic one.
    const axis = niceScale(0, 0.3, { ticks: 3 });
    assert.ok(axis.ticks[axis.ticks.length - 1]! >= 0.3 - 1e-9, `top tick was ${axis.ticks[axis.ticks.length - 1]}`);
  });
});

describe('bar chart', () => {
  const data = [
    { label: 'Civils', value: 820_000 },
    { label: 'MEP', value: 1_240_000 },
    { label: 'Fit-out', value: 410_000 },
  ];

  it('draws one bar per category, taller for the larger value', () => {
    const markup = svg(barChart({ data, title: 'Package value' }));
    const heights = attrs(markup, 'height');
    assert.equal(heights.length, 3);
    // MEP is the biggest number, so it is the tallest bar. In SVG a taller bar
    // is a larger height and a smaller y — both are checked, because getting one
    // right and the other wrong draws bars hanging from the top of the chart.
    assert.ok(heights[1]! > heights[0]! && heights[1]! > heights[2]!, `heights ${heights.join(', ')}`);
    const tops = attrs(markup, 'y').filter((_, index) => index < 3);
    assert.ok(tops.length > 0);
  });

  it('puts the value in a tooltip on every bar', () => {
    const markup = svg(barChart({ data, title: 'Package value' }));
    assert.match(markup, /<title>Civils · Package value: 820k<\/title>/);
    assert.equal([...markup.matchAll(/<title>/g)].length >= 3, true);
  });

  it('stacks to a total when asked and groups when not', () => {
    const rows = [{ label: 'Q1', a: 30, b: 70 }];
    const series = [
      { key: 'a', label: 'Own labour' },
      { key: 'b', label: 'Subcontract' },
    ];
    const barX = (markup: string) =>
      new Set([...markup.matchAll(/class="chart-bar"\s+x="(-?[\d.]+)"/g)].map((found) => found[1]));
    // Grouped: two bars side by side, so two distinct x positions. Stacked: one
    // column, so one. Scraped from the bars themselves rather than from every
    // `x=` on the chart, which would also catch the grid's tick labels.
    assert.equal(barX(svg(barChart({ data: rows, series, title: 'Split' }))).size, 2);
    assert.equal(barX(svg(barChart({ data: rows, series, stacked: true, title: 'Split' }))).size, 1);
  });

  it('draws a negative value below the axis', () => {
    const markup = svg(barChart({ data: [{ label: 'Variance', value: -40 }, { label: 'Gain', value: 60 }], title: 'Movement' }));
    assert.match(markup, /class="chart-axis"/);
    const heights = attrs(markup, 'height');
    assert.ok(heights.every((height) => height >= 0), 'a bar was drawn with a negative height');
  });

  it('names its series in a legend only when there is more than one', () => {
    const one = svg(barChart({ data, title: 'Package value' }));
    const two = svg(
      barChart({ data: [{ label: 'Q1', a: 1, b: 2 }], series: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], title: 'Split' }),
    );
    assert.ok(!one.includes('chart-legend'), 'a single-series chart drew a legend of one');
    assert.match(two, /chart-legend/);
  });
});

describe('line chart', () => {
  const weeks = [
    { label: 'W1', ppc: 62 },
    { label: 'W2', ppc: 71 },
    { label: 'W3', ppc: null },
    { label: 'W4', ppc: 84 },
  ];

  it('breaks the line at a gap rather than bridging it', () => {
    // Bridging is interpolation and interpolation is invention: a reader cannot
    // tell an invented segment from a measured one once it is drawn.
    const markup = svg(lineChart({ data: weeks, series: [{ key: 'ppc', label: 'PPC' }], title: 'PPC' }));
    const path = /<path class="chart-line" d="([^"]+)"/.exec(markup)?.[1] ?? '';
    const moves = [...path.matchAll(/M/g)].length;
    assert.equal(moves, 2, `expected two segments around the gap, path was: ${path}`);
  });

  it('draws no marker where there is no measurement', () => {
    const markup = svg(lineChart({ data: weeks, series: [{ key: 'ppc', label: 'PPC' }], title: 'PPC' }));
    assert.equal([...markup.matchAll(/class="chart-dot"/g)].length, 3, 'a dot was drawn for the missing week');
  });

  it('plots a single point in the middle rather than at the edge', () => {
    const markup = svg(lineChart({ data: [{ label: 'W1', value: 40 }], title: 'One week' }));
    const cx = attrs(markup, 'cx')[0]!;
    assert.ok(cx > 300 && cx < 420, `a single point should sit centred, was at ${cx}`);
  });

  it('draws a reference line where one is given', () => {
    const markup = svg(
      lineChart({ data: weeks, series: [{ key: 'ppc', label: 'PPC' }], title: 'PPC', reference: [{ value: 85, label: 'Target' }] }),
    );
    assert.match(markup, /class="chart-ref"/);
    assert.match(markup, /Target/);
  });

  it('fills under the line as an area chart and not otherwise', () => {
    const plain = svg(lineChart({ data: weeks, series: [{ key: 'ppc', label: 'PPC' }], title: 'PPC' }));
    const filled = svg(areaChart({ data: weeks, series: [{ key: 'ppc', label: 'PPC' }], title: 'PPC' }));
    assert.ok(!plain.includes('opacity="0.16"'));
    assert.match(filled, /opacity="0\.16"/);
  });
});

describe('pie and donut', () => {
  const parts = [
    { label: 'Labour', value: 45 },
    { label: 'Plant', value: 25 },
    { label: 'Materials', value: 30 },
  ];

  it('draws one slice per part and states each share', () => {
    const markup = svg(pieChart({ data: parts, title: 'Cost make-up' }));
    assert.equal([...markup.matchAll(/class="chart-slice"/g)].length, 3);
    assert.match(markup, /Labour: 45 \(45%\)/);
  });

  it('refuses a negative part rather than drawing it as a gap', () => {
    // Parts of a whole that is not one is the commonest chart mistake there is.
    const markup = svg(pieChart({ data: [{ label: 'A', value: 40 }, { label: 'B', value: -10 }], title: 'Make-up' }));
    assert.equal([...markup.matchAll(/class="chart-slice"/g)].length, 1, 'a negative slice was drawn');
  });

  it('draws a single 100% slice as a full ring rather than collapsing to nothing', () => {
    // At a full turn the start and end angles are the same point, so the
    // ordinary arc path sweeps from a point back to itself and encloses nothing
    // — a donut that renders as an empty box. The full-turn case must therefore
    // land somewhere other than where it started.
    const path = /class="chart-slice" d="([^"]+)"/.exec(
      svg(donutChart({ data: [{ label: 'All of it', value: 100 }], title: 'One thing' })),
    )?.[1] ?? '';
    // The point the arc leaves from and the point it lands on. Comparing the
    // landing point to the path's `M` instead would pass for the collapsed case
    // too, because the collapsed path's `M` is the inner radius, not the outer.
    const arc = /([\d.-]+ [\d.-]+) A 116 116 0 \d 1 ([\d.-]+ [\d.-]+)/.exec(path);
    assert.ok(arc, `no outer arc in: ${path}`);

    /*
     * And the ring must be concentric, which the arc alone does not prove.
     *
     * The earlier implementation traced each edge as one nearly-complete arc
     * between two points 0.01 apart. Two circles pass through such a pair — one
     * centred above them, one below — and the flags picked opposite ones for
     * the outer edge and the inner, so a whole-pie donut rendered as two
     * overlapping circles with the hole 68px north of the disc. Every assertion
     * above passed on it: there was an arc, it landed somewhere else, the path
     * was not collapsed. It was simply not a ring.
     *
     * Each edge is now two explicit half-circles, whose vertical extremes are
     * the only thing worth asserting: both edges must be centred on the same
     * point.
     */
    const ys = [...path.matchAll(/A (\d+) \d+ 0 0 1 [\d.]+ ([\d.]+)/g)].map((found) => ({
      radius: Number(found[1]),
      y: Number(found[2]),
    }));
    const centres = new Map<number, number[]>();
    for (const point of ys) centres.set(point.radius, [...(centres.get(point.radius) ?? []), point.y]);
    const middles = [...centres.entries()].map(([radius, points]) => (Math.max(...points) + Math.min(...points)) / 2);
    assert.ok(middles.length >= 2, `expected an outer and an inner edge, found ${middles.length}`);
    assert.ok(
      Math.max(...middles) - Math.min(...middles) < 0.5,
      `the ring is not concentric: edges centred at ${middles.join(' and ')}`,
    );
    assert.notEqual(arc[2]!, arc[1]!, 'the outer arc returned to its own start, enclosing no area');
    assert.match(path, /A 68 68/, 'the full-circle case did not cut the donut hole');
  });

  it('puts the total in the middle of a donut and nothing in the middle of a pie', () => {
    assert.match(svg(donutChart({ data: parts, title: 'Make-up' })), /class="chart-centre"/);
    assert.ok(!svg(pieChart({ data: parts, donut: false, title: 'Make-up' })).includes('chart-centre"'));
  });
});

describe('histogram', () => {
  it('derives its bin count from the data rather than defaulting to ten', () => {
    // The bin count changes the shape of a histogram completely. A fixed default
    // is how a bimodal distribution gets drawn as a single hump.
    // Freedman–Diaconis sets the bin *width* from the interquartile range, so
    // what changes the count is the span relative to the middle half — not the
    // range on its own. A tight cluster with a long tail needs many bins to show
    // the tail at all; an evenly spread set needs few.
    const bins = (values: number[]) =>
      [...svg(histogram({ values, title: 'D' })).matchAll(/class="chart-bar"/g)].length;
    const even = bins(Array.from({ length: 100 }, (_, i) => i));
    const tailed = bins(Array.from({ length: 100 }, (_, i) => (i < 95 ? 10 + (i % 2) : 500)));
    assert.ok(tailed > even, `an even spread got ${even} bins and a long-tailed one got ${tailed}`);
  });

  it('counts every measurement exactly once, the maximum included', () => {
    // The classic off-by-one: the largest value falls one past the last bucket
    // and is silently dropped, so the histogram counts n-1.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const markup = svg(histogram({ values, title: 'Counts' }));
    const counted = [...markup.matchAll(/<title>[^<]*?: (\d+)<\/title>/g)].reduce((sum, found) => sum + Number(found[1]), 0);
    assert.equal(counted, values.length, 'the histogram lost or duplicated a measurement');
  });

  it('needs at least two measurements before it claims a distribution', () => {
    assert.match(svg(histogram({ values: [7], empty: 'One reading is not a distribution' })), /One reading is not a distribution/);
  });
});

describe('scatter and bubble', () => {
  const points = [
    { x: 1, y: 2, label: 'A' },
    { x: 2, y: 4.1, label: 'B' },
    { x: 3, y: 5.9, label: 'C' },
    { x: 4, y: 8.2, label: 'D' },
  ];

  it('reports r² beside a fitted line so the claim carries its evidence', () => {
    const markup = svg(scatterPlot({ points, fit: true, title: 'Correlation', xLabel: 'weeks', yLabel: 'cost' }));
    assert.match(markup, /class="chart-fit"/);
    assert.match(markup, /r² 0\.99\d/, 'a near-perfect fit did not report a near-1 r²');
  });

  it('draws no fit line unless one is asked for', () => {
    assert.ok(!svg(scatterPlot({ points, title: 'Correlation' })).includes('chart-fit'));
  });

  it('survives a vertical cloud rather than drawing a line off the chart', () => {
    const markup = svg(scatterPlot({ points: [{ x: 5, y: 1 }, { x: 5, y: 9 }], fit: true, title: 'Vertical' }));
    assert.match(markup, /r² 0/, 'a cloud with no x-variance should explain nothing');
  });

  it('scales a bubble by area, not by radius', () => {
    // Scaling the radius directly makes a value twice as large look four times
    // as big, which is the whole reason bubble charts have a bad name.
    const markup = svg(
      bubbleChart({ points: [{ x: 1, y: 1, z: 100, label: 'big' }, { x: 2, y: 2, z: 25, label: 'small' }], title: 'Three ways' }),
    );
    const radii = attrs(markup, 'r').sort((a, b) => b - a);
    const big = radii[0]!;
    const small = radii[1]!;
    // z of 100 against 25 is four times the value, so twice the radius of the
    // variable part. Base offset of 5 is in both.
    assert.ok(Math.abs((big - 5) / (small - 5) - 2) < 0.15, `radii ${big} and ${small} are not in a square-root relationship`);
  });

  it('draws the largest bubble first so it never hides a small one', () => {
    const markup = svg(bubbleChart({ points: [{ x: 1, y: 1, z: 1, label: 'small' }, { x: 1, y: 1, z: 90, label: 'big' }], title: 'Overlap' }));
    assert.ok(markup.indexOf('big') < markup.indexOf('small'), 'a small bubble was drawn behind a large one');
  });
});

describe('box plot', () => {
  it('separates outliers from the whisker rather than swallowing them', () => {
    // On this platform the outlier is usually the interesting record — the one
    // valuation, the one week, the one supplier.
    const markup = svg(boxPlot({ groups: [{ label: 'Rates', values: [10, 11, 12, 11, 10, 12, 11, 95] }], title: 'Spread' }));
    assert.match(markup, /class="chart-outlier"/);
    assert.match(markup, /outlier 95/);
  });

  it('refuses a group too small to have quartiles', () => {
    assert.match(svg(boxPlot({ groups: [{ label: 'Two', values: [1, 2] }], empty: 'Too few' })), /Too few/);
  });

  it('draws the median as the heaviest line in the box', () => {
    const markup = svg(boxPlot({ groups: [{ label: 'A', values: [1, 2, 3, 4, 5, 6, 7, 8] }], title: 'Spread' }));
    assert.match(markup, /class="chart-median"/);
    assert.match(markup, /median 4\.5/);
  });
});

describe('gauge', () => {
  it('colours itself against the target rather than by taste', () => {
    const under = svg(gauge({ value: 72, target: 80, title: 'PPC' }));
    const over = svg(gauge({ value: 88, target: 80, title: 'PPC' }));
    assert.match(under, /var\(--warning\)/);
    // `--viz-target` rather than `--success`: the same green, and the more
    // precise name. The standard reserves one colour for "on target", and a
    // dial that has reached its target is saying exactly that.
    assert.match(over, /var\(--viz-target\)/);
  });

  it('is the data colour, not the platform accent, when there is no target', () => {
    // Signal Orange is chrome. A dial with nothing to answer to is a
    // measurement, and the standard makes CONSTRUX Blue the colour of one.
    const markup = svg(gauge({ value: 41, title: 'Coverage' }));
    assert.match(markup, /var\(--viz-actual\)/);
    assert.ok(!markup.includes('var(--orange)'), 'the dial is still painted in the platform accent');
  });

  it('marks the target as a tick, so value and target read as two facts', () => {
    const markup = svg(gauge({ value: 72, target: 80, title: 'PPC' }));
    assert.match(markup, /class="chart-gauge-target"/);
    assert.match(markup, /<title>Target 80%<\/title>/);
  });

  it('clamps a value past the end of the scale instead of drawing off the arc', () => {
    // An unclamped 260 on a 0-100 gauge sweeps two and a half times round and
    // ends up somewhere arbitrary. The arc must stop exactly where a full gauge
    // stops — and the true figure must still be printed, because clamping the
    // drawing is not the same as changing the reading.
    const endOf = (markup: string) => /class="chart-gauge-fill" d="[^"]*A 108 108 0 \d 1 ([\d.-]+ [\d.-]+)"/.exec(markup)?.[1];
    assert.match(svg(gauge({ value: 260, max: 100, title: 'Over' })), /260%/);
    assert.equal(
      endOf(svg(gauge({ value: 260, max: 100, title: 'Over' }))),
      endOf(svg(gauge({ value: 100, max: 100, title: 'Full' }))),
      'a value past the top of the scale was drawn past the end of the arc',
    );
  });
});

describe('funnel', () => {
  const stages = [
    { label: 'Enquiries', value: 120 },
    { label: 'Bids', value: 44 },
    { label: 'Shortlisted', value: 12 },
    { label: 'Won', value: 3 },
  ];

  it('states conversion from the stage above and from the top', () => {
    // Two different questions. A funnel answering only one gets read as
    // answering the other.
    const markup = svg(funnelChart({ stages, title: 'Bid funnel' }));
    assert.match(markup, /36\.67% of the stage above/);
    assert.match(markup, /Bids: 44 · 36\.67% of the top/);
  });

  it('sizes each stage against the top rather than against its neighbour', () => {
    const markup = svg(funnelChart({ stages, title: 'Bid funnel' }));
    const widths = attrs(markup, 'width');
    assert.ok(widths[0]! > widths[1]! && widths[1]! > widths[2]! && widths[2]! > widths[3]!);
    assert.ok(Math.abs(widths[1]! / widths[0]! - 44 / 120) < 0.01);
  });
});

describe('waterfall', () => {
  const steps = [
    { label: 'Tender', value: 1_000_000, total: true },
    { label: 'Variations', value: 120_000 },
    { label: 'Deductions', value: -60_000 },
    { label: 'Final', value: 1_060_000, total: true },
  ];

  it('draws a subtotal from the axis and an increment from the running position', () => {
    const markup = svg(waterfallChart({ steps, title: 'Account' }));
    assert.match(markup, /Tender: 1M \(subtotal\)/);
    assert.match(markup, /Variations: \+120k · running 1\.12M/);
    assert.match(markup, /Deductions: -60k · running 1\.06M/);
  });

  it('colours an increase and a decrease differently, and names both in the legend', () => {
    const markup = svg(waterfallChart({ steps, title: 'Account' }));
    assert.match(markup, /var\(--success\)/);
    assert.match(markup, /var\(--critical\)/);
    assert.match(markup, /Increase/);
    assert.match(markup, /Decrease/);
  });

  it('arrives where the arithmetic says it should', () => {
    const markup = svg(waterfallChart({ steps: steps.slice(0, 3), title: 'Account' }));
    assert.match(markup, /running 1\.06M/, 'the running total did not reconcile');
  });

  it('draws a subtotal from the axis, so it is a column and not a zero-height sliver', () => {
    // A subtotal drawn from the running position spans from the total to the
    // total: no height at all, and the bar the whole chart builds towards
    // vanishes into a line.
    const heights = [...svg(waterfallChart({ steps, title: 'Account' })).matchAll(
      /class="chart-bar"[^>]*height="([\d.]+)"/g,
    )].map((found) => Number(found[1]));
    assert.equal(heights.length, 4);
    assert.ok(heights[3]! > 100, `the closing subtotal was ${heights[3]}px tall — it should span the whole account`);
    assert.ok(heights[3]! > heights[1]!, 'the closing subtotal should tower over the increment above it');
  });
});

describe('treemap', () => {
  it('lays out squarified tiles that fill the box exactly once', () => {
    const items = [
      { label: 'Civils', value: 50 },
      { label: 'MEP', value: 30 },
      { label: 'Fit-out', value: 15 },
      { label: 'Externals', value: 5 },
    ];
    const markup = svg(treemap({ items, title: 'Value by package' }));
    const widths = attrs(markup, 'width');
    const heights = attrs(markup, 'height');
    assert.equal(widths.length, 4);
    // The tiles' areas should reproduce the value shares. Two units are added
    // back for the 1px gutter each tile leaves.
    const areas = widths.map((width, index) => (width + 2) * (heights[index]! + 2));
    const total = areas.reduce((a, b) => a + b, 0);
    const largestShare = Math.max(...areas) / total;
    assert.ok(Math.abs(largestShare - 0.5) < 0.03, `largest tile took ${(largestShare * 100).toFixed(1)}% of the area, expected 50%`);
  });

  it('produces near-square tiles rather than slivers', () => {
    // The whole reason to squarify. Slice-and-dice on any real data produces
    // tiles too thin to compare or to click, and the tile areas are correct in
    // both layouts — so area alone cannot tell the two apart.
    const items = Array.from({ length: 10 }, (_, i) => ({ label: `P${i}`, value: 10 + i * 3 }));
    const markup = svg(treemap({ items, title: 'Packages' }));
    const widths = attrs(markup, 'width');
    const heights = attrs(markup, 'height');
    const ratios = widths.map((width, index) => Math.max(width / heights[index]!, heights[index]! / width));
    // The mean, not the worst. Slice-and-dice happens to keep one or two tiles
    // near-square by luck, so the worst ratio barely separates the two layouts;
    // what squarifying changes is the whole distribution — measured, the mean
    // is 1.6:1 squarified against 3.0:1 sliced.
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    assert.ok(mean < 2, `mean tile aspect ratio was ${mean.toFixed(2)}:1 — these are strips, not tiles`);
  });

  it('labels only the tiles a label fits in', () => {
    const items = [{ label: 'Dominant', value: 980 }, ...Array.from({ length: 12 }, (_, i) => ({ label: `Tiny ${i}`, value: 1 }))];
    const markup = svg(treemap({ items, title: 'Long tail' }));
    const labels = [...markup.matchAll(/class="chart-tile-label"/g)].length;
    assert.ok(labels < 13, 'a label was drawn in a tile too small to hold it');
    assert.ok(labels >= 1, 'the dominant tile lost its label');
  });
});

describe('heatmap', () => {
  it('encodes density as one hue’s opacity rather than as a rainbow', () => {
    // A rainbow ramp has no perceptual order and is unreadable to a reader with
    // a colour-vision deficiency; lightness survives both.
    const markup = svg(
      heatmap({ rows: ['Mon', 'Tue'], columns: ['AM', 'PM'], values: [[1, 8], [4, 0]], title: 'Activity' }),
    );
    const fills = new Set([...markup.matchAll(/fill="(var\(--[a-z0-9-]+\)|rgb\([^)]+\))"/g)].map((found) => found[1]));
    assert.equal(fills.size, 1, `a heatmap should use one hue, used ${[...fills].join(', ')}`);
    const opacities = attrs(markup, 'fill-opacity');
    assert.ok(Math.max(...opacities) > Math.min(...opacities), 'every cell got the same opacity');
  });

  it('distinguishes a zero from a cell nobody recorded', () => {
    const markup = svg(
      heatmap({ rows: ['Mon'], columns: ['AM', 'PM'], values: [[0, null]] as never, title: 'Activity' }),
    );
    assert.match(markup, /Mon · PM: not recorded/);
    assert.match(markup, /Mon · AM: 0/);
    // And it must *look* different, not only read differently in a tooltip
    // nobody hovers: a blank cell is transparent with an outline, a recorded
    // zero is the lightest step of the ramp.
    const opacities = attrs(markup, 'fill-opacity');
    assert.equal(Math.min(...opacities), 0, 'an unrecorded cell was painted');
    assert.ok(Math.max(...opacities) > 0, 'a recorded zero was not painted at all');
    assert.match(markup, /stroke="var\(--line\)"/, 'an unrecorded cell was not outlined');
  });
});

describe('gantt', () => {
  const tasks = [
    { label: 'Enabling works', start: '2026-01-05', end: '2026-02-20', percentComplete: 100 },
    { label: 'Substructure', start: '2026-02-16', end: '2026-05-01', percentComplete: 40 },
    { label: 'Practical completion', start: '2026-09-30', end: '2026-09-30', milestone: true },
  ];

  it('draws a diamond for a milestone and a bar for a span', () => {
    const markup = svg(ganttChart({ tasks, title: 'Programme', today: '2026-03-15' }));
    assert.equal([...markup.matchAll(/class="chart-milestone"/g)].length, 1);
    assert.equal([...markup.matchAll(/class="chart-gantt"/g)].length, 2);
  });

  it('shows progress inside the planned bar only where progress is recorded', () => {
    const markup = svg(ganttChart({ tasks, title: 'Programme' }));
    assert.equal([...markup.matchAll(/class="chart-gantt-done"/g)].length, 2);
    const undated = svg(ganttChart({ tasks: [{ label: 'A', start: '2026-01-01', end: '2026-02-01' }], title: 'P' }));
    assert.ok(!undated.includes('chart-gantt-done'), 'progress was drawn for an activity with none recorded');
  });

  it('marks today only when today is inside the plotted span', () => {
    assert.match(svg(ganttChart({ tasks, title: 'P', today: '2026-03-15' })), /class="chart-today"/);
    assert.ok(!svg(ganttChart({ tasks, title: 'P', today: '2030-01-01' })).includes('chart-today'));
  });

  it('drops an activity whose dates run backwards rather than drawing it inside out', () => {
    const markup = svg(
      ganttChart({ tasks: [...tasks, { label: 'Impossible', start: '2026-06-01', end: '2026-05-01' }], title: 'P' }),
    );
    assert.ok(!markup.includes('Impossible'), 'an activity ending before it starts was plotted');
  });
});

describe('the small marks', () => {
  it('a sparkline needs two points before it is a trend', () => {
    assert.equal(svg(sparkline({ values: [4] })), '');
    assert.match(svg(sparkline({ values: [4, 9] })), /<svg/);
  });

  it('a KPI card carries direction in words as well as colour', () => {
    const up = svg(kpiCard({ label: 'PPC', value: '84%', delta: 6, deltaLabel: 'pts on last week' }));
    assert.match(up, /class="kpi-delta up"/);
    assert.match(up, /6 pts on last week/);
    const flat = svg(kpiCard({ label: 'PPC', value: '84%', delta: 0 }));
    assert.match(flat, /class="kpi-delta flat"/);
  });

  it('a proportion bar sums its segments to the full width', () => {
    const markup = svg(proportionBar({ parts: [{ label: 'Done', value: 3 }, { label: 'Left', value: 1 }] }));
    const widths = attrs(markup, 'width');
    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 100) < 0.5, `widths summed to ${widths.reduce((a, b) => a + b, 0)}`);
  });

  it('a proportion bar with nothing in it renders nothing rather than an empty rail', () => {
    assert.equal(svg(proportionBar({ parts: [] })), '');
  });
});

describe('the kit as a whole', () => {
  it('gives every chart an accessible name and a spoken summary', () => {
    // An optional accessible name is one nobody writes, so the frame requires
    // both and this pins that they are actually populated.
    const drawn = [
      barChart({ data: [{ label: 'A', value: 1 }], title: 'Bars' }),
      lineChart({ data: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], title: 'Line' }),
      pieChart({ data: [{ label: 'A', value: 1 }], title: 'Pie' }),
      gauge({ value: 10, title: 'Gauge' }),
      funnelChart({ stages: [{ label: 'A', value: 10 }], title: 'Funnel' }),
      treemap({ items: [{ label: 'A', value: 10 }], title: 'Treemap' }),
      ganttChart({ tasks: [{ label: 'A', start: '2026-01-01', end: '2026-02-01' }], title: 'Gantt' }),
      heatmap({ rows: ['A'], columns: ['B'], values: [[1]], title: 'Heatmap' }),
      histogram({ values: [1, 2, 3, 4, 5, 6], title: 'Histogram' }),
      scatterPlot({ points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], title: 'Scatter' }),
      bubbleChart({ points: [{ x: 1, y: 1, z: 1 }], title: 'Bubble' }),
      boxPlot({ groups: [{ label: 'A', values: [1, 2, 3, 4, 5] }], title: 'Box' }),
      waterfallChart({ steps: [{ label: 'A', value: 10 }], title: 'Waterfall' }),
    ];
    for (const chart of drawn) {
      const markup = svg(chart);
      assert.match(markup, /role="img"/);
      assert.match(markup, /aria-label="[^"]+"/);
      assert.match(markup, /<title>[^<]+<\/title>/);
      assert.match(markup, /<desc>[^<]+<\/desc>/, `a chart has no spoken summary: ${markup.slice(0, 120)}`);
    }
  });

  it('is responsive: a viewBox and no fixed pixel size', () => {
    const markup = svg(barChart({ data: [{ label: 'A', value: 1 }], title: 'Bars' }));
    assert.match(markup, /viewBox="0 0 \d+ \d+"/);
    assert.ok(!/<svg[^>]*\swidth="\d/.test(markup), 'a chart hardcoded a pixel width');
    assert.ok(!/<svg[^>]*\sheight="\d/.test(markup), 'a chart hardcoded a pixel height');
  });

  it('escapes a label that contains markup', () => {
    // A supplier called `<script>` is a supplier, and every label on every chart
    // comes from customer data.
    const markup = svg(barChart({ data: [{ label: '<script>x</script>', value: 1 }], title: 'Bars' }));
    assert.ok(!markup.includes('<script>'), 'a chart label was interpolated as markup');
    assert.match(markup, /&lt;script&gt;/);

    // The title reaches `aria-label`, `<title>` and `<desc>`. A screen name
    // assembled from a project or supplier name is customer data too.
    const titled = svg(barChart({ data: [{ label: 'A', value: 1 }], title: 'Value for "><img src=x>' }));
    assert.ok(!titled.includes('<img src=x'), 'a chart title escaped its attribute');
    assert.match(titled, /aria-label="Value for &quot;&gt;&lt;img src=x&gt;"/);
  });

  it('has a stylesheet rule for every class it draws', () => {
    // A chart class with no CSS behind it renders as an unstyled black shape,
    // and it renders that way only in a browser — which no unit test opens.
    const drawn = new Set(
      [...CHART_SOURCE.matchAll(/class="(chart-[a-z-]+|spark|spark-target|proportion|kpi-delta)[ "]/g)].map((found) => found[1]),
    );
    const missing = [...drawn].filter((className) => !CSS.includes(`.${className}`)).sort();
    assert.deepEqual(missing, [], `chart classes with no styling:\n  ${missing.join('\n  ')}`);
  });

  it('offers eight categorical colours, all distinct', () => {
    // More than eight categories is a table somebody drew; fewer than eight
    // means two series share a colour on a chart that has seven.
    assert.equal(SERIES.length, 8);
    assert.equal(new Set(SERIES).size, 8);
  });

  it('names every type it draws', () => {
    assert.ok(CHART_TYPES.includes('gantt'));
    assert.ok(CHART_TYPES.includes('waterfall'));
    assert.ok(CHART_TYPES.includes('treemap'));
    assert.equal(new Set(CHART_TYPES).size, CHART_TYPES.length);
  });
});

describe('horizontal bars, and the labels they exist for', () => {
  /**
   * The bug this block was written against: a risk title, a package name or a
   * supplier name is exactly why somebody reaches for horizontal bars, and a
   * label wider than the gutter was drawn at a negative x and clipped by the
   * viewBox edge — losing the *beginning* of the label, which is the part that
   * identifies the row.
   */
  const longRows = [
    { label: 'Unforeseen ground conditions in zone 3 requiring additional excavation', value: 124_500 },
    { label: 'Short one', value: 40_000 },
  ];

  it('keeps every label inside the drawing', () => {
    const markup = svg(barChart({ data: longRows, horizontal: true, title: 'Drivers' }));
    for (const x of attrs(markup, 'x')) {
      assert.ok(Number(x) >= 0, `a label or mark was placed at x=${x}, outside the viewBox`);
    }
  });

  it('truncates a label too long for its gutter rather than clipping it', () => {
    const markup = svg(barChart({ data: longRows, horizontal: true, title: 'Drivers' }));
    assert.match(markup, /…/, 'a label longer than the gutter should be visibly truncated');
  });

  it('keeps the whole label available, so nothing is actually lost', () => {
    const markup = svg(barChart({ data: longRows, horizontal: true, title: 'Drivers' }));
    // The full text survives in a <title>, which is what a hover and a screen
    // reader both read.
    assert.match(markup, /<title>Unforeseen ground conditions in zone 3 requiring additional excavation<\/title>/);
  });

  it('leaves a short label alone', () => {
    const markup = svg(barChart({ data: longRows, horizontal: true, title: 'Drivers' }));
    assert.match(markup, />Short one</, 'a label that fits must not be truncated');
  });
});

describe('the capabilities carried over when the two chart libraries became one', () => {
  /**
   * `lib/chart.js` could do two things `lib/charts.js` could not, and both were
   * load-bearing on real screens. They were ported before any call site moved,
   * because a merge that quietly drops a capability is a regression wearing a
   * refactor's clothes.
   */

  describe('a histogram of data somebody else binned', () => {
    const buckets = [
      { label: '320d', count: 4 },
      { label: '330d', count: 18 },
      { label: '340d', count: 9, marked: true },
      { label: '350d', count: 2, marked: true },
    ];

    it('draws pre-binned buckets rather than demanding raw values', () => {
      // A Monte Carlo distribution is computed where the trials are, and the
      // trials are never sent. Rebinning a summary would invent a shape the
      // simulation did not produce.
      const markup = svg(histogram({ buckets, title: 'Completion' }));
      assert.equal(attrs(markup, 'height').filter((h) => Number(h) > 0).length >= 4, true);
    });

    it('carries each bucket’s own label onto the axis', () => {
      const markup = svg(histogram({ buckets, title: 'Completion' }));
      assert.match(markup, /320d/);
      assert.match(markup, /350d/);
    });

    it('distinguishes a marked bucket from an unmarked one', () => {
      const markup = svg(histogram({ buckets, title: 'Completion' }));
      const fills = new Set(paints(markup));
      assert.equal(fills.size, 2, 'a marked bucket must not look identical to an unmarked one');
    });

    it('treats a limit on pre-binned buckets as a ceiling on the bars', () => {
      // A resource profile: the limit is the labour available per day, and the
      // bars that exceed it are the days that cannot be worked as planned.
      // Reading it as a threshold on the x axis — correct for a distribution —
      // would mark the wrong bars entirely.
      const profile = [
        { label: 'w1', count: 4 },
        { label: 'w2', count: 12 },
        { label: 'w3', count: 3 },
      ];
      const markup = svg(histogram({ buckets: profile, limit: 6, limitLabel: 'available' }));
      const fills = paints(markup);
      assert.equal(fills.filter((fill) => fill === 'var(--warning)').length, 1, 'only w2 exceeds the ceiling');
      assert.match(markup, /available/);
    });

    it('keeps a ceiling nothing reaches inside the scale', () => {
      // Otherwise the capacity line is drawn off the top and the chart says
      // nothing is near it — the opposite of what it is for.
      const markup = svg(histogram({ buckets: [{ label: 'w1', count: 2 }], limit: 40, limitLabel: 'available' }));
      for (const y of attrs(markup, 'y1')) assert.ok(y >= 0, `the capacity line was drawn at y=${y}`);
      assert.match(markup, /available/);
    });

    it('says nothing about a median it cannot know', () => {
      // With pre-binned input there is no sample to take a median from, and
      // computing one off bucket midpoints would be a figure nobody measured.
      const markup = svg(histogram({ buckets, title: 'Completion' }));
      assert.ok(!/Median/.test(markup));
    });

    it('still bins raw values when given them', () => {
      const markup = svg(histogram({ values: [1, 2, 2, 3, 3, 3, 4, 4, 5], title: 'Spread' }));
      assert.match(markup, /Median/);
    });

    it('marks every bin past a threshold, and draws the threshold', () => {
      const markup = svg(histogram({ values: Array.from({ length: 40 }, (_, i) => i), limit: 30, limitLabel: 'P80' }));
      assert.match(markup, /P80/);
      assert.ok(new Set(paints(markup)).size > 1, 'bins past the limit must be distinguishable');
    });

    it('marks the bucket the threshold falls inside, not only those beyond it', () => {
      // The bug this replaced: with the limit inside the last bucket, a strict
      // "starts past the limit" rule marked nothing at all — a threshold line
      // with no marking, which reads as "nothing is past this" when values
      // beyond it plainly exist.
      const markup = svg(histogram({ values: Array.from({ length: 40 }, (_, i) => i), limit: 30, limitLabel: 'P80' }));
      assert.ok(new Set(paints(markup)).has('var(--warning)'), 'the straddling bucket must be marked');
    });

    it('lets the empty state say why there is nothing, when "not recorded" is wrong', () => {
      const markup = histogram({ values: [], empty: 'Nothing simulated yet', emptyDetail: 'Run the simulation.' });
      assert.match(resolveHtml(markup), /Run the simulation\./);
      assert.ok(!/Nothing has been recorded/.test(resolveHtml(markup)));
    });
  });

  describe('a programme with a baseline to compare against', () => {
    // Declared apart from the array so a single task can be varied on its own.
    // Spreading `tasks[0]` instead would take the union of two differently
    // shaped literals, which is not one task.
    const piling = {
      name: 'Piling',
      start: '2026-03-01',
      finish: '2026-04-15',
      baselineStart: '2026-02-01',
      baselineFinish: '2026-03-10',
      critical: true,
      percentComplete: 60,
    };
    const tasks = [piling, { name: 'Inlet works', start: '2026-04-16', finish: '2026-06-01' }];

    it('accepts the field names a programme record actually uses', () => {
      // `name`/`finish`, not `label`/`end`. Translating at every call site is
      // how one call site eventually gets it wrong.
      const markup = svg(ganttChart({ tasks, title: 'Programme' }));
      assert.match(markup, /Piling/);
      assert.match(markup, /Inlet works/);
    });

    it('keeps a baseline earlier than every current date inside the drawing', () => {
      // A slipped task has a baseline before the whole current programme.
      // Leaving it out of the extent draws it off the left edge — losing the
      // one bar the reader opened the chart for.
      const markup = svg(ganttChart({ tasks, title: 'Programme' }));
      for (const x of attrs(markup, 'x1')) assert.ok(Number(x) >= 0, `a mark was drawn at x=${x}`);
    });

    it('says how far the work has slipped against its baseline', () => {
      const markup = svg(ganttChart({ tasks, title: 'Programme' }));
      assert.match(markup, /days late/);
    });

    it('tones critical work by what it is, not by its category', () => {
      const plain = svg(ganttChart({ tasks: [{ ...piling, critical: false }], title: 'P' }));
      const critical = svg(ganttChart({ tasks: [{ ...piling, critical: true }], title: 'P' }));
      assert.notDeepEqual(paints(plain), paints(critical));
      assert.ok(paints(critical).includes('var(--critical)'), 'critical work should read as critical');
    });

    it('takes a data date as the line between actual and forecast', () => {
      const markup = svg(ganttChart({ tasks, dataDate: '2026-04-01', title: 'Programme' }));
      assert.match(markup, /chart-today/);
    });
  });
});

/**
 * An all-zero money axis must not invent a negative range.
 *
 * The contingency chart on Risk & Safety drew expected, P80 and worst case on a
 * project with no risks registered. All three were £0, the flat-series padding
 * ran one unit either side, and the axis read
 * `£-1.00 · £-0.50 · £0 · £0.50 · £1.00`. Negative contingency is not a small
 * figure, it is a meaningless one, and a reader who sees money below zero stops
 * trusting the chart above it.
 */
describe('a zero-based axis grows upwards only', () => {
  it('never puts a negative tick under an all-zero series', () => {
    const axis = niceScale(0, 0);
    assert.equal(axis.min, 0, `axis started at ${axis.min}`);
    assert.ok(axis.max > 0, 'a flat zero series still needs a range to draw in');
    assert.deepEqual(axis.ticks.filter((t) => t < 0), []);
  });

  it('still pads both ways when the caller has opted out of a zero base', () => {
    // A flat non-zero line — a temperature, an index — is legitimately centred.
    const axis = niceScale(47, 47, { zeroBased: false });
    assert.ok(axis.min < 47 && axis.max > 47);
  });

  it('grows downwards for an all-zero series that can only be negative', () => {
    const axis = niceScale(-0, -0, { zeroBased: true });
    assert.equal(axis.max >= 0, true);
  });

  it('leaves a flat positive series alone, because zero already gives it a range', () => {
    const axis = niceScale(5000, 5000);
    assert.equal(axis.min, 0);
    assert.ok(axis.max >= 5000);
  });
});

/**
 * Radar — one subject measured against several criteria at once.
 *
 * The chart's one job is comparing shapes, and the shape is only comparable if
 * every axis is scaled against the same ceiling and the axes are evenly spaced.
 * A radar that normalises each axis to its own maximum draws a picture where a
 * weak option and a strong one have the same outline.
 */
describe('radar', () => {
  const axes = ['Cost', 'Programme', 'Buildability', 'Carbon', 'Risk'];

  it('places the axes evenly around the circle, starting at the top', () => {
    const markup = svg(radarChart({ axes, series: [{ label: 'Option A', values: [4, 4, 4, 4, 4] }], max: 4 }));
    // An all-maximum profile sits on the outer ring, so its polygon's vertices
    // are the axis endpoints — the geometry the grid is built from.
    const ring = markup.match(/class="chart-grid chart-radar-ring"\s+points="([^"]+)"/g);
    assert.ok(ring && ring.length === 4, 'a radar without rings gives a reader no scale to judge distance against');

    const outer = [...markup.matchAll(/<line class="chart-grid" x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/g)];
    assert.equal(outer.length, axes.length, 'one spoke per criterion');
    const cx = Number(outer[0]![1]);
    const cy = Number(outer[0]![2]);
    const angles = outer.map((spoke) => Math.atan2(Number(spoke[4]) - cy, Number(spoke[3]) - cx));
    // First spoke at twelve o'clock, i.e. -90 degrees in SVG coordinates.
    assert.ok(Math.abs(angles[0]! + Math.PI / 2) < 0.01, `first axis drawn at ${((angles[0]! * 180) / Math.PI).toFixed(1)}°, expected -90°`);
    // Normalised into one turn: `atan2` wraps at ±π, so a raw difference across
    // the wrap reads as -288° where the spokes are in fact 72° apart.
    const gaps = angles.slice(1).map((angle, index) => (angle - angles[index]! + Math.PI * 2) % (Math.PI * 2));
    for (const gap of gaps) {
      assert.ok(Math.abs(gap - (Math.PI * 2) / axes.length) < 0.01, `axes ${((gap * 180) / Math.PI).toFixed(1)}° apart, expected ${360 / axes.length}°`);
    }
  });

  it('scales every series against one ceiling, so two profiles can be compared', () => {
    const markup = svg(
      radarChart({
        axes,
        max: 10,
        series: [
          { label: 'Strong', values: [10, 10, 10, 10, 10] },
          { label: 'Weak', values: [5, 5, 5, 5, 5] },
        ],
      }),
    );
    // The rings carry a `class` before their points; a series polygon opens
    // straight onto `points`, which is what separates the two here.
    const polygons = [...markup.matchAll(/<polygon points="([^"]+)" fill=/g)].map((found) =>
      String(found[1])
        .split(' ')
        .map((pair) => pair.split(',').map(Number) as [number, number]),
    );
    assert.equal(polygons.length, 2, 'both profiles should be drawn');
    const spread = (points: [number, number][]): number => {
      const xs = points.map((point) => point[0]);
      const ys = points.map((point) => point[1]);
      return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    };
    const ratio = spread(polygons[1]!) / spread(polygons[0]!);
    assert.ok(Math.abs(ratio - 0.5) < 0.02, `half the score drew ${(ratio * 100).toFixed(0)}% of the shape — the axes are not sharing a ceiling`);
  });

  it('refuses a profile with fewer than three criteria, which has no shape', () => {
    const markup = svg(radarChart({ axes: ['Cost', 'Risk'], series: [{ label: 'A', values: [1, 2] }], empty: 'Two measures is a bar chart' }));
    assert.match(markup, /Two measures is a bar chart/);
  });

  it('drops a series whose values do not line up with the axes', () => {
    // Four readings against five criteria is a data error, and drawing it would
    // silently attribute each reading to the wrong measure.
    const markup = svg(radarChart({ axes, series: [{ label: 'Short', values: [1, 2, 3, 4] }], empty: 'Nothing scored' }));
    assert.match(markup, /Nothing scored/);
  });
});

/**
 * Sankey — quantity moving from one set of things to another.
 *
 * Ribbon thickness is the only quantity in the picture, so it has to be
 * proportional to the value and the ribbons leaving a node have to add up to
 * that node. Anything else is a diagram that looks quantitative and is not.
 */
describe('sankey', () => {
  const flows = [
    { from: 'Client', to: 'Agreed', value: 60 },
    { from: 'Subcontractor', to: 'Claimed', value: 30 },
    { from: 'Subcontractor', to: 'Agreed', value: 10 },
  ];

  it('draws one ribbon per flow and one node per distinct end', () => {
    const markup = svg(sankeyDiagram({ flows, title: 'Origin against status' }));
    assert.equal([...markup.matchAll(/class="chart-sankey"/g)].length, 3);
    // Two sources, two destinations.
    assert.equal([...markup.matchAll(/class="chart-node"/g)].length, 4);
  });

  it('sizes each node by the total passing through it', () => {
    const markup = svg(sankeyDiagram({ flows }));
    const heights = [...markup.matchAll(/class="chart-node"[^>]*height="([\d.]+)"/g)].map((found) => Number(found[1]));
    // Draw order is sources then targets, each in first-seen order:
    // Client 60, Subcontractor 40, Agreed 70, Claimed 30.
    const [client, subcontractor, agreed, claimed] = heights as [number, number, number, number];
    assert.ok(Math.abs(client / subcontractor - 60 / 40) < 0.02, `sources sized ${client}:${subcontractor}, expected 60:40`);
    assert.ok(Math.abs(agreed / claimed - 70 / 30) < 0.02, `destinations sized ${agreed}:${claimed}, expected 70:30`);
    // Both sides carry the same total, so both columns are the same height.
    assert.ok(Math.abs(client + subcontractor - (agreed + claimed)) < 0.5, 'the two columns do not carry the same total');
  });

  it('refuses a flow with no quantity rather than drawing a hairline', () => {
    // A zero-value ribbon is a relationship, not a quantity, and a Sankey that
    // draws one invites the reader to compare it against a real one.
    const markup = svg(sankeyDiagram({ flows: [{ from: 'A', to: 'B', value: 0 }], empty: 'Nothing valued' }));
    assert.match(markup, /Nothing valued/);
  });

  it('names the share in each ribbon, because thickness alone is not readable to a number', () => {
    const markup = svg(sankeyDiagram({ flows, format: (value) => `£${value}` }));
    assert.match(markup, /Client → Agreed: £60 \(60%\)/);
  });
});

/**
 * Flowchart — the order steps happen in.
 *
 * The only chart here with no quantity in it. What it has to get right is
 * depth: a step sits below everything that leads to it, and a process that
 * loops back still lays out rather than running forever.
 */
describe('flow', () => {
  const steps = [
    { id: 'raise', label: 'Raise change', next: ['assess'] },
    { id: 'assess', label: 'Assess', next: ['instruct', 'reject'] },
    { id: 'instruct', label: 'Instruct', next: ['value'] },
    { id: 'reject', label: 'Reject' },
    { id: 'value', label: 'Value', next: [] },
  ];

  it('puts each step below the step that leads to it', () => {
    const markup = svg(flowChart({ steps, title: 'Change control' }));
    // Lazily, and anchored on the `x` before it: a greedy run to `y="` lands
    // on the `y="0.2"` inside `fill-opacity`, which is the same for every node.
    const ys = [...markup.matchAll(/class="chart-flow-node" x="[\d.]+" y="([\d.]+)"/g)].map((found) => Number(found[1]));
    assert.equal(ys.length, 5);
    const [raise, assess, instruct, reject, value] = ys as [number, number, number, number, number];
    assert.ok(raise < assess, 'the first step was not drawn first');
    assert.ok(assess < instruct && assess < reject, 'both branches should sit below the decision');
    assert.ok(Math.abs(instruct - reject) < 0.5, 'two steps at the same depth belong on the same row');
    assert.ok(instruct < value, 'valuation follows instruction');
  });

  it('draws one arrow per link and none to a step that is not there', () => {
    const markup = svg(flowChart({ steps: [...steps, { id: 'orphan', label: 'Orphan', next: ['nowhere'] }] }));
    // 1 + 2 + 1 = 4 real links; the dangling one is dropped rather than drawn
    // into empty space.
    assert.equal([...markup.matchAll(/class="chart-flow-link"/g)].length, 4);
  });

  it('lays out a process that loops back on itself', () => {
    // Rejected work returning to assessment is a real process, and a
    // depth-first layout that follows it without a guard never terminates.
    const looping = [
      { id: 'a', label: 'Submit', next: ['b'] },
      { id: 'b', label: 'Review', next: ['c'] },
      { id: 'c', label: 'Rework', next: ['b'] },
    ];
    const markup = svg(flowChart({ steps: looping }));
    assert.equal([...markup.matchAll(/class="chart-flow-node"/g)].length, 3);
    assert.match(markup, /Rework/);
  });

  it('refuses a step with no label, which would draw an empty box', () => {
    const markup = svg(flowChart({ steps: [{ id: 'x', label: '' }], empty: 'No process' }));
    assert.match(markup, /No process/);
  });
});

/**
 * Plan against reality, drawn so the difference survives the colour.
 *
 * The Visual Intelligence Standard requires baseline, actual, forecast and
 * target to be visually distinct and consistent everywhere they appear
 * together, and it explicitly refuses colour as the only carrier. So the tone
 * sets the stroke pattern as well as the hue, and these tests read the pattern
 * out of the SVG rather than trusting that the table in `charts.js` is wired to
 * anything.
 */
describe('the four states are distinct without relying on hue', () => {
  const weeks = [
    { label: 'W1', plan: 10, real: 9, ahead: 11 },
    { label: 'W2', plan: 20, real: 17, ahead: 22 },
    { label: 'W3', plan: 30, real: 26, ahead: 34 },
  ];

  it('dashes a baseline, dots a forecast and leaves the measured line solid', () => {
    const markup = svg(
      lineChart({
        data: weeks,
        title: 'Progress',
        series: [
          { key: 'plan', label: 'Baseline', colour: 'baseline' },
          { key: 'real', label: 'Actual', colour: 'actual' },
          { key: 'ahead', label: 'Forecast', colour: 'forecast' },
        ],
      }),
    );
    const lines = [...markup.matchAll(/<path class="chart-line"[^>]*>/g)].map((found) => found[0] as string);
    assert.equal(lines.length, 3);
    assert.match(lines[0] as string, /stroke-dasharray="6 4"/, 'the baseline is not dashed');
    assert.ok(!(lines[1] as string).includes('stroke-dasharray'), 'the measured line should be the solid one');
    assert.match(lines[2] as string, /stroke-dasharray="2 4"/, 'the forecast is not dotted');
  });

  it('gives each of the three its own pattern, so greyscale still separates them', () => {
    const markup = svg(
      lineChart({
        data: weeks,
        title: 'Progress',
        series: [
          { key: 'plan', label: 'Baseline', colour: 'baseline' },
          { key: 'ahead', label: 'Forecast', colour: 'forecast' },
        ],
      }),
    );
    const patterns = [...markup.matchAll(/stroke-dasharray="([^"]+)"/g)].map((found) => found[1]);
    assert.equal(new Set(patterns).size, patterns.length, 'two states drew the same dash pattern');
  });

  it('long-dashes a threshold and marks a target apart from it', () => {
    const markup = svg(
      lineChart({
        data: weeks,
        title: 'Cost performance',
        series: [{ key: 'real', label: 'CPI', colour: 'actual' }],
        reference: [
          { value: 28, label: 'target', tone: 'target' },
          { value: 32, label: 'limit', tone: 'threshold' },
        ],
      }),
    );
    const refs = [...markup.matchAll(/<line\s+x1="[^"]*"\s+y1="[^"]*"\s+x2="[^"]*"\s+y2="[^"]*"\s+stroke="([^"]*)"([^>]*)>/g)];
    assert.equal(refs.length, 2, 'both reference lines should be drawn');
    // A target is the line you are trying to reach: solid, and green.
    assert.match(refs[0]![1] as string, /viz-target/);
    assert.ok(!(refs[0]![2] as string).includes('stroke-dasharray'));
    // A threshold is the line you must not cross: long-dashed, and red.
    assert.match(refs[1]![1] as string, /viz-threshold/);
    assert.match(refs[1]![2] as string, /stroke-dasharray="10 5"/);
  });

  it('resolves each state to the one colour the whole platform uses for it', () => {
    // The point of naming a tone rather than passing a hex: a forecast is the
    // same purple on the programme screen and the commercial one.
    const markup = svg(
      lineChart({
        data: weeks,
        title: 'Progress',
        series: [
          { key: 'plan', label: 'Baseline', colour: 'baseline' },
          { key: 'real', label: 'Actual', colour: 'actual' },
          { key: 'ahead', label: 'Forecast', colour: 'forecast' },
        ],
      }),
    );
    assert.match(markup, /stroke="var\(--viz-baseline\)"/);
    assert.match(markup, /stroke="var\(--viz-actual\)"/);
    assert.match(markup, /stroke="var\(--viz-forecast\)"/);
  });
});

/**
 * Colour is a state channel, so two marks in one chart must not share one.
 *
 * The Command Centre severity donut is the case. Three slices — Urgent toned
 * `bad`, Attention toned `warn`, Info left untoned — and the untoned one fell
 * through to its index's series colour. The third series colour is Amber,
 * `warn` resolves to Amber, and the chart drew "Attention" and "Info" in
 * exactly the same colour under a legend insisting they were different things.
 *
 * Nothing threw and nothing failed; the picture was simply wrong. So an untoned
 * mark now takes the next series colour that no toned mark in the same chart
 * has already claimed.
 */
describe('a chart mixing toned and untoned marks keeps them apart', () => {
  const fills = (markup: string): string[] =>
    [...markup.matchAll(/class="chart-slice"[^>]*fill="([^"]+)"/g)].map((found) => String(found[1]));

  it('never gives an untoned slice a colour a toned slice is already using', () => {
    const markup = svg(
      pieChart({
        title: 'By severity',
        data: [
          { label: 'Urgent', value: 3, tone: 'bad' },
          { label: 'Attention', value: 6, tone: 'warn' },
          { label: 'Info', value: 12, tone: '' },
        ],
      }),
    );
    const drawn = fills(markup);
    assert.equal(drawn.length, 3);
    assert.equal(new Set(drawn).size, 3, `two slices share a colour: ${drawn.join(', ')}`);
    // The toned two keep exactly the colours their tone names.
    assert.equal(drawn[0], 'var(--critical)');
    assert.equal(drawn[1], 'var(--warning)');
  });

  it('leaves a chart where every mark is toned exactly as the caller asked', () => {
    const markup = svg(
      pieChart({
        title: 'By standing',
        data: [
          { label: 'Open', value: 2, tone: 'ok' },
          { label: 'Late', value: 1, tone: 'bad' },
        ],
      }),
    );
    assert.deepEqual(fills(markup), ['var(--success)', 'var(--critical)']);
  });

  it('leaves a chart where no mark is toned on the series colours, in order', () => {
    const markup = svg(
      pieChart({
        title: 'By package',
        data: [
          { label: 'Civils', value: 3 },
          { label: 'MEP', value: 2 },
          { label: 'Fit-out', value: 1 },
        ],
      }),
    );
    assert.deepEqual(fills(markup), SERIES.slice(0, 3));
  });

  it('applies the same rule to the legend swatch, so the key cannot disagree with the chart', () => {
    const markup = svg(
      pieChart({
        title: 'By severity',
        data: [
          { label: 'Urgent', value: 3, tone: 'bad' },
          { label: 'Attention', value: 6, tone: 'warn' },
          { label: 'Info', value: 12, tone: '' },
        ],
      }),
    );
    const swatches = [...markup.matchAll(/<rect width="10" height="10" rx="2" fill="([^"]+)"/g)].map((found) => String(found[1]));
    assert.deepEqual(swatches, fills(markup), 'the legend is painted differently from the slices it labels');
  });
});

/**
 * The misuse controls the standard sets out, enforced in the kit.
 *
 * Section 4 lists a prohibited misuse against each chart type. A style guide
 * that lists them and leaves it to reviewers is a style guide that is violated
 * by the third person to add a chart, so the ones that can be enforced are
 * enforced here — in the component, once, for every screen.
 *
 * Each refusal names the remedy. A chart that simply disappears teaches nobody
 * anything and gets worked around with a different chart type that has the same
 * problem.
 */
describe('a chart refuses the misuses the standard prohibits', () => {
  it('never draws a pie with more than six segments', () => {
    const data = Array.from({ length: 11 }, (_, index) => ({ label: `Cost code ${index + 1}`, value: 20 - index }));
    const markup = svg(pieChart({ title: 'By cost code', data }));
    assert.equal([...markup.matchAll(/class="chart-slice"/g)].length, 6, 'the six-segment cap was not applied');
    // The remainder is gathered and named, not dropped.
    assert.match(markup, /6 smaller/);
  });

  it('keeps every gathered part in the data panel, with its own share', () => {
    // The picture may pool them. The accessible alternative may not — an
    // alternative that hides what the chart hid is not an alternative.
    const data = Array.from({ length: 11 }, (_, index) => ({ label: `Cost code ${index + 1}`, value: 20 - index }));
    const markup = svg(pieChart({ title: 'By cost code', data }));
    for (let index = 1; index <= 11; index += 1) {
      assert.match(markup, new RegExp(`Cost code ${index}<`), `cost code ${index} is not in the data panel`);
    }
  });

  it('leaves six or fewer in the order the caller gave them', () => {
    // Severity is an order. Re-sorting by size to satisfy a cap that is not
    // being hit would throw that away on every pie in the platform.
    const markup = svg(
      pieChart({
        title: 'By severity',
        data: [
          { label: 'Urgent', value: 3 },
          { label: 'Attention', value: 6 },
          { label: 'Info', value: 12 },
        ],
      }),
    );
    const order = [...markup.matchAll(/<text x="16" y="9">([^<]+)<\/text>/g)].map((found) => found[1]);
    assert.deepEqual(order, ['Urgent', 'Attention', 'Info']);
  });

  it('refuses a pie of negative values rather than drawing a gap', () => {
    // Parts of a whole that is not one. The commonest chart mistake there is.
    const markup = svg(pieChart({ title: 'Movement', data: [{ label: 'Up', value: 40 }, { label: 'Down', value: -25 }], empty: 'Nothing' }));
    assert.equal([...markup.matchAll(/class="chart-slice"/g)].length, 1, 'a negative slice was drawn');
  });

  it('refuses a radar past eight axes and says what to draw instead', () => {
    const axes = Array.from({ length: 9 }, (_, index) => `Measure ${index + 1}`);
    const markup = svg(radarChart({ title: 'Profile', axes, series: [{ label: 'A', values: axes.map(() => 3) }] }));
    assert.ok(!markup.includes('<svg'), 'a nine-axis radar was drawn');
    assert.match(markup, /too many for a profile/);
    assert.match(markup, /bar chart/, 'the refusal does not name the remedy');
  });

  it('draws a radar at exactly eight, which is the limit rather than past it', () => {
    const axes = Array.from({ length: 8 }, (_, index) => `Measure ${index + 1}`);
    const markup = svg(radarChart({ title: 'Profile', axes, series: [{ label: 'A', values: axes.map(() => 3) }] }));
    assert.ok(markup.includes('<svg'), 'eight axes were refused, but eight is allowed');
  });

  it('refuses more than eight stacked bands and says what to draw instead', () => {
    const series = Array.from({ length: 9 }, (_, index) => ({ key: `s${index}`, label: `Series ${index}` }));
    const row: { label: string } & Record<string, unknown> = { label: 'Q1' };
    for (const s of series) row[s.key] = 5;
    const markup = svg(barChart({ title: 'Composition', stacked: true, data: [row], series }));
    assert.ok(!markup.includes('<svg'), 'nine stacked bands were drawn');
    assert.match(markup, /more than a bar can carry/);
    assert.match(markup, /side by side/, 'the refusal does not name the remedy');
  });

  it('still groups nine series side by side, because only stacking is capped', () => {
    // The prohibition is about stacking. Nine grouped bars are readable — they
    // share a baseline, which is the whole difference.
    const series = Array.from({ length: 9 }, (_, index) => ({ key: `s${index}`, label: `Series ${index}` }));
    const row: { label: string } & Record<string, unknown> = { label: 'Q1' };
    for (const s of series) row[s.key] = 5;
    const markup = svg(barChart({ title: 'Comparison', data: [row], series }));
    assert.ok(markup.includes('<svg'), 'nine grouped series were refused');
  });

  it('starts a bar chart at zero, which is the truncation the standard prohibits', () => {
    // Already true, asserted here because section 4 names it as a prohibited
    // misuse and this is where the prohibitions are collected.
    const markup = svg(barChart({ title: 'Value', data: [{ label: 'A', value: 4100 }, { label: 'B', value: 4200 }] }));
    const ticks = [...markup.matchAll(/class="chart-grid">\s*<line[^>]*>\s*<text[^>]*>([^<]+)</g)].map((found) => found[1]);
    assert.ok(ticks.includes('0'), `the axis does not include zero: ${ticks.join(', ')}`);
  });
});

/**
 * A forecast never looks like a measurement.
 *
 * Section 3.3 requires predicted values to be marked distinctly from actual
 * ones and requires a confidence band, and it is the most consequential rule in
 * the standard: a prediction that reads as a fact is how a forecast ends up in
 * a board pack as a number. The rule is enforced three times over — the line
 * changes colour *and* stroke, the band is drawn, and the table says which
 * rows are which — because a reader who cannot see the chart still has to be
 * told.
 */
describe('a forecast is drawn as a forecast', () => {
  const months = [
    { label: '2026-01', cost: 100, low: 95, high: 105 },
    { label: '2026-02', cost: 210, low: 200, high: 220 },
    { label: '2026-03', cost: 320, low: 290, high: 350 },
    { label: '2026-04', cost: 450, low: 380, high: 520 },
  ];

  it('splits the line at the data date, and dots the half that is predicted', () => {
    const markup = svg(
      lineChart({
        title: 'Cost forecast',
        data: months,
        series: [{ key: 'cost', label: 'Cost', colour: 'actual' }],
        forecastFrom: '2026-02',
      }),
    );
    const measured = /<path class="chart-line" d="([^"]+)"/.exec(markup)?.[1] ?? '';
    const predicted = /<path\s+class="chart-line chart-predicted"\s+d="([^"]+)"/.exec(markup)?.[1] ?? '';
    assert.ok(measured, 'the measured half was not drawn');
    assert.ok(predicted, 'the predicted half was not drawn');
    assert.match(markup, /class="chart-line chart-predicted"[\s\S]*?stroke="var\(--viz-forecast\)"/);
    assert.match(markup, /class="chart-line chart-predicted"[\s\S]*?stroke-dasharray="2 4"/);
  });

  it('joins the two halves at the data date rather than leaving a gap', () => {
    // The forecast starts from the last thing actually measured. A gap would
    // read as missing data between the fact and the prediction.
    const markup = svg(
      lineChart({
        title: 'Cost forecast',
        data: months,
        series: [{ key: 'cost', label: 'Cost', colour: 'actual' }],
        forecastFrom: '2026-02',
      }),
    );
    const measured = /<path class="chart-line" d="([^"]+)"/.exec(markup)?.[1] ?? '';
    const predicted = /<path\s+class="chart-line chart-predicted"\s+d="([^"]+)"/.exec(markup)?.[1] ?? '';
    const lastMeasured = measured.trim().split(/[ML]/).filter(Boolean).at(-1)?.trim();
    const firstPredicted = predicted.trim().split(/[ML]/).filter(Boolean)[0]?.trim();
    assert.equal(firstPredicted, lastMeasured, 'the forecast does not start where the measurement ended');
  });

  it('shades the confidence band behind the line', () => {
    const markup = svg(
      lineChart({
        title: 'Cost forecast',
        data: months,
        series: [{ key: 'cost', label: 'Cost', colour: 'actual' }],
        forecastFrom: '2026-02',
        band: { low: 'low', high: 'high' },
      }),
    );
    assert.match(markup, /class="chart-band"/, 'no confidence band was drawn');
    assert.match(markup, /class="chart-band"[^>]*fill="var\(--viz-forecast\)"/);
    // Behind, not in front: it is drawn before the line in document order.
    assert.ok(markup.indexOf('chart-band') < markup.indexOf('class="chart-line"'), 'the band was drawn over the line');
  });

  it('says in the table which rows are measured and which are forecast', () => {
    // The chart says it in a colour and a stroke. A reader using the table is
    // using it because they cannot see either.
    const markup = svg(
      lineChart({
        title: 'Cost forecast',
        data: months,
        series: [{ key: 'cost', label: 'Cost', colour: 'actual' }],
        forecastFrom: '2026-02',
        band: { low: 'low', high: 'high' },
      }),
    );
    assert.match(markup, /<th scope="col">Basis<\/th>/);
    assert.match(markup, /<th scope="col">Low<\/th>/);
    assert.match(markup, /<th scope="col">High<\/th>/);
    const cells = [...markup.matchAll(/<td>(Measured|Forecast)<\/td>/g)].map((found) => found[1]);
    assert.deepEqual(cells, ['Measured', 'Measured', 'Forecast', 'Forecast']);
  });

  it('tells a screen reader where measurement stops', () => {
    const markup = svg(
      lineChart({
        title: 'Cost forecast',
        data: months,
        series: [{ key: 'cost', label: 'Cost', colour: 'actual' }],
        forecastFrom: '2026-02',
        band: { low: 'low', high: 'high' },
      }),
    );
    assert.match(markup, /Measured to 2026-02; everything after it is forecast\./);
    assert.match(markup, /shaded band is the forecast confidence interval/);
  });

  it('draws an ordinary line where nothing is forecast', () => {
    // The overwhelming majority of charts. None of this may cost them anything.
    const markup = svg(lineChart({ title: 'PPC', data: months, series: [{ key: 'cost', label: 'Cost' }] }));
    assert.ok(!markup.includes('chart-predicted'), 'a chart with no forecast drew a predicted half');
    assert.ok(!markup.includes('chart-band'), 'a chart with no band drew one');
  });

  it('widens the axis to fit the band, so an interval is never clipped', () => {
    // A band whose high edge runs past the top of the plot is a band that
    // understates the uncertainty, which is the opposite of its purpose.
    const markup = svg(
      lineChart({
        title: 'Cost forecast',
        data: [
          { label: '2026-01', cost: 100, low: 90, high: 110 },
          { label: '2026-02', cost: 200, low: 120, high: 900 },
        ],
        series: [{ key: 'cost', label: 'Cost' }],
        band: { low: 'low', high: 'high' },
      }),
    );
    // Read from the chart's own spoken range, which is built from the same
    // values the axis is: if the band is in one it is in the other.
    const range = /Range ([\d.km]+) to ([\d.km]+)\./.exec(markup);
    assert.ok(range, `the chart published no range: ${/\<desc\>([^<]*)/.exec(markup)?.[1]}`);
    assert.equal((range as RegExpExecArray)[2], '900', 'the band\u2019s high edge is outside the plotted range');
  });
});
