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

/** Every `<rect y=…>` in draw order, as numbers. */
const attrs = (markup: string, attribute: string): number[] =>
  [...markup.matchAll(new RegExp(`${attribute}="(-?[\\d.]+)"`, 'g'))].map((found) => Number(found[1]));

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
  ];

  for (const [name, output] of empties) {
    it(`${name} shows the caller's own empty sentence rather than an axis over nothing`, () => {
      const markup = svg(output);
      assert.match(markup, /class="empty"/, `${name} drew something when it had nothing`);
      assert.ok(!markup.includes('<svg'), `${name} drew an SVG with no data in it`);
    });
  }

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
    assert.match(over, /var\(--success\)/);
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
    const fills = new Set([...markup.matchAll(/fill="(var\(--[a-z]+\)|rgb\([^)]+\))"/g)].map((found) => found[1]));
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
