import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveHtml } from '../../frontend/lib/ui.js';
import {
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
  lineChart,
  pieChart,
  radarChart,
  sankeyDiagram,
  scatterPlot,
  treemap,
  waterfallChart,
} from '../../frontend/lib/charts.js';

/**
 * Every chart carries its own data, and the export is that data.
 *
 * Two of the Visual Intelligence Standard's acceptance criteria, and they are
 * the same mechanism: "every chart has an accessible tabular alternative" and
 * "exported results reconcile exactly with on-screen totals".
 *
 * The reconciliation is structural rather than diligent. `frame()` renders the
 * chart's dataset as a real table, that table is what a screen reader reads,
 * and `charttools.js` builds the CSV by reading the rendered table out of the
 * DOM. There is one set of numbers, so there is nothing to reconcile.
 *
 * What this file guards is the input to that: a chart that draws marks and
 * publishes no table has a picture nobody using a screen reader can read and
 * nothing to export. It is easy to add one — the chart still renders — so it
 * needs a test rather than a convention.
 */

const svg = (content: unknown): string => resolveHtml(content);

/** The rendered data panel's rows, as arrays of cell text. */
function tableRows(markup: string): string[][] {
  const panel = /<div class="chart-data"[^>]*>([\s\S]*?)<\/div>/.exec(markup)?.[1] ?? '';
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(panel)?.[1] ?? '';
  return [...body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...(row[1] as string).matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) =>
      (cell[1] as string).replace(/<[^>]*>/g, '').trim(),
    ),
  );
}

function headers(markup: string): string[] {
  const head = /<thead>([\s\S]*?)<\/thead>/.exec(markup)?.[1] ?? '';
  return [...head.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map((cell) => (cell[1] as string).trim());
}

/** One drawn instance of every chart type in the kit. */
const DRAWN: Array<[string, unknown]> = [
  ['bar', barChart({ title: 'Package value', data: [{ label: 'Civils', value: 820 }, { label: 'MEP', value: 1240 }] })],
  [
    'grouped bar',
    barChart({
      title: 'Confidence',
      data: [{ label: 'Ashworth', p50: 360, p80: 380 }],
      series: [
        { key: 'p50', label: 'P50' },
        { key: 'p80', label: 'P80' },
      ],
    }),
  ],
  [
    'horizontal bar',
    barChart({ title: 'Exposure', horizontal: true, data: [{ label: 'Ground conditions', value: 124 }, { label: 'Discharge', value: 116 }] }),
  ],
  ['line', lineChart({ title: 'PPC', data: [{ label: 'W1', value: 40 }, { label: 'W2', value: 62 }] })],
  ['pie', pieChart({ title: 'By phase', data: [{ label: 'Tender', value: 1 }, { label: 'Construction', value: 3 }] })],
  ['donut', donutChart({ title: 'By status', data: [{ label: 'Open', value: 2 }, { label: 'Closed', value: 5 }] })],
  ['histogram', histogram({ title: 'Cycle time', values: [2, 3, 3, 4, 5, 5, 6, 8, 9, 12] })],
  ['scatter', scatterPlot({ title: 'Risk', points: [{ x: 20, y: 450, label: 'Ground' }, { x: 40, y: 220, label: 'MEP' }] })],
  ['bubble', bubbleChart({ title: 'Packages', points: [{ x: 10, y: 20, z: 5, label: 'Civils' }] })],
  ['box', boxPlot({ title: 'Productivity', groups: [{ label: 'Crew A', values: [8, 9, 11, 12, 14] }] })],
  ['gauge', gauge({ title: 'Coverage', value: 41, target: 80 })],
  [
    'heatmap',
    heatmap({ title: 'Risk by area', rows: ['Zone A', 'Zone B'], columns: ['Design', 'Build'], values: [[3, 1], [0, 5]] }),
  ],
  [
    'funnel',
    funnelChart({ title: 'Change', stages: [{ label: 'Captured', value: 100 }, { label: 'Instructed', value: 60 }] }),
  ],
  [
    'waterfall',
    waterfallChart({
      title: 'EAC',
      steps: [{ label: 'Budget', value: 400 }, { label: 'Change', value: 60 }, { label: 'EAC', value: 460, total: true }],
    }),
  ],
  ['treemap', treemap({ title: 'By package', items: [{ label: 'Civils', value: 50 }, { label: 'MEP', value: 30 }] })],
  [
    'gantt',
    ganttChart({
      title: 'Programme',
      tasks: [{ id: 'a', label: 'Piling', start: '2026-01-05', end: '2026-02-10', totalFloat: 4, critical: true }],
    }),
  ],
  [
    'radar',
    radarChart({
      title: 'Option appraisal',
      axes: ['Cost', 'Time', 'Risk'],
      series: [{ label: 'Option A', values: [3, 4, 2] }],
    }),
  ],
  ['sankey', sankeyDiagram({ title: 'Change origin', flows: [{ from: 'Client', to: 'Agreed', value: 60 }] })],
  [
    'flow',
    flowChart({ title: 'Change control', steps: [{ id: 'raise', label: 'Raise', next: ['assess'] }, { id: 'assess', label: 'Assess' }] }),
  ],
];

describe('every chart publishes the data it drew', () => {
  for (const [name, chart] of DRAWN) {
    it(`${name} renders a data panel a screen reader can read`, () => {
      const markup = svg(chart);
      assert.match(markup, /class="chart-data"/, `${name} drew marks and published no table`);
      const rows = tableRows(markup);
      assert.ok(rows.length > 0, `${name} published an empty table`);
      // Every row is the same width as the header, or the table is misaligned
      // and the CSV built from it carries values under the wrong columns.
      const width = headers(markup).length;
      assert.ok(width > 1, `${name} published a table with no columns`);
      for (const row of rows) {
        assert.equal(row.length, width, `${name} has a ${row.length}-cell row under ${width} columns: ${row.join(' | ')}`);
      }
    });

    it(`${name} offers the data, the export, the expand and the link`, () => {
      const markup = svg(chart);
      assert.match(markup, /data-chart-data=/, `${name} has no "view data" control`);
      assert.match(markup, /data-chart-csv=/, `${name} has no export`);
      assert.match(markup, /data-chart-full=/, `${name} cannot be opened full screen`);
      assert.match(markup, /data-chart-link=/, `${name} cannot be linked to`);
    });
  }

  it('gives each chart an id its own link can name', () => {
    const markup = svg(barChart({ title: 'Contract value by project', data: [{ label: 'A', value: 1 }] }));
    assert.match(markup, /id="chart-contract-value-by-project"/);
    // The controls point at that id, so a link and a panel cannot drift apart.
    assert.match(markup, /aria-controls="chart-contract-value-by-project-data"/);
    assert.match(markup, /id="chart-contract-value-by-project-data"/);
  });

  it('keeps the data panel closed until it is asked for', () => {
    // Open by default would double the height of every screen in the console.
    const markup = svg(pieChart({ title: 'By phase', data: [{ label: 'Tender', value: 1 }] }));
    assert.match(markup, /class="chart-data"[^>]*hidden/);
    assert.match(markup, /aria-expanded="false"/);
  });

  it('publishes the total where a chart has one, so an export reconciles to it', () => {
    // The acceptance criterion names totals specifically, and a composition
    // chart is where a reader most expects one.
    const rows = tableRows(svg(pieChart({ title: 'By phase', data: [{ label: 'Tender', value: 1 }, { label: 'Build', value: 3 }] })));
    const total = rows.at(-1) as string[];
    assert.equal(total[0], 'Total');
    assert.equal(total[2], '100%');
  });

  it('says "not measured" in the table where the chart drew a gap', () => {
    // The whole point of breaking a line at a gap is that a missing week is not
    // a zero. A table that printed 0 there would undo it for the reader who is
    // using the table *because* they cannot see the chart.
    const rows = tableRows(
      svg(
        lineChart({
          title: 'PPC',
          data: [{ label: 'W1', value: 40 }, { label: 'W2' }, { label: 'W3', value: 51 }],
        }),
      ),
    );
    assert.equal((rows[1] as string[])[1], 'not measured');
  });

  it('draws every band of a stacked horizontal bar, not just the first', () => {
    /*
     * `barChart` routes every `horizontal: true` call to `horizontalBars`, which
     * used to read `keys[0]` and ignore the rest. A three-series call therefore
     * rendered one series, with a legend beside it naming two bands that were
     * not on the chart and a table that listed all three.
     *
     * Nothing threw and nothing was blank, which is the failure mode this kit is
     * written against — the reader sees a picture and it is wrong. The check is
     * geometric: count the bars actually drawn in the SVG, because the table
     * was right the whole time and testing it would have passed either way.
     */
    const markup = svg(
      barChart({
        title: 'By discipline',
        horizontal: true,
        stacked: true,
        data: [
          { label: 'Architectural', first: 3, second: 2, third: 1 },
          { label: 'Structural', first: 4, second: 1, third: 2 },
        ],
        series: [
          { key: 'first', label: 'First issue' },
          { key: 'second', label: 'Second issue' },
          { key: 'third', label: 'Third or later' },
        ],
      }),
    );

    const drawn = [...markup.matchAll(/class="chart-bar"/g)].length;
    assert.equal(drawn, 6, `two rows of three bands should draw six bars, drew ${drawn}`);

    // Each row's bands must abut rather than all start at the axis, or they are
    // six overlapping bars rather than a stack.
    const xs = [...markup.matchAll(/class="chart-bar" x="([\d.]+)"/g)].map((match) => Number(match[1]));
    assert.equal(new Set(xs).size > 2, true, 'every band starts at the same x, so nothing is stacked');

    // And the total reaches the table, so the export reconciles with the bar.
    const rows = tableRows(markup);
    assert.equal((rows[0] as string[]).at(-1), '6', 'the stack total is not in the published data');
    assert.equal(headers(markup).at(-1), 'Total');
  });

  it('keeps a single-series horizontal bar exactly as it was', () => {
    // The fix above must not change the twenty-odd existing callers, which pass
    // one series and rely on `row.tone` painting the bar.
    const markup = svg(
      barChart({
        title: 'Exposure',
        horizontal: true,
        data: [{ label: 'Ground conditions', value: 124, tone: 'bad' }],
      }),
    );
    assert.equal([...markup.matchAll(/class="chart-bar"/g)].length, 1);
    assert.equal(headers(markup).includes('Total'), false, 'a one-series bar gained a total column it never had');
  });

  it('keys a waterfall legend to the colours it actually painted', () => {
    /*
     * The legend used to say "Increase, Decrease, Subtotal" whatever the bars
     * were. The CVR's value build-up tones its steps — contract sum, agreed
     * variations and variations-not-agreed are three kinds of money, not three
     * increases — so it drew blue, blue, amber and grey under a legend naming
     * green, red and grey. Three keys for colours that were not there.
     *
     * Three cases, because the first fix broke the middle one: fully toned,
     * partly toned, and untoned. A legend keyed to the toned steps alone would
     * have left the variation waterfall's untoned bars unexplained.
     */
    const keys = (chart: unknown): string[] => {
      const markup = svg(chart);
      const caption = /<figcaption class="chart-legend">([\s\S]*?)<\/figcaption>/.exec(markup)?.[1] ?? '';
      return [...caption.matchAll(/<span class="chart-key"[\s\S]*?<\/span\s*>/g)].map((match) =>
        (match[0] as string).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(),
      );
    };

    assert.deepEqual(
      keys(waterfallChart({ title: 'EAC', steps: [{ label: 'Budget', value: 400 }, { label: 'Change', value: -60 }, { label: 'EAC', value: 340, total: true }] })),
      ['Increase', 'Decrease', 'Subtotal'],
      'an untoned waterfall lost its default keys',
    );

    assert.deepEqual(
      keys(
        waterfallChart({
          title: 'Variations',
          steps: [
            { label: 'Instructed', value: 100 },
            { label: 'Movement on assessment', value: -20, tone: 'bad' },
            { label: 'Agreed', value: 80, total: true },
          ],
        }),
      ),
      ['Increase', 'Movement on assessment', 'Subtotal'],
      'a partly toned waterfall left its untoned bars unexplained',
    );

    // Two steps sharing a colour get one key naming both, because a legend says
    // what a colour means and two keys of one colour is a difference that is
    // not there.
    assert.deepEqual(
      keys(
        waterfallChart({
          title: 'Value',
          steps: [
            { label: 'Contract sum', value: 2052, tone: 'actual' },
            { label: 'Agreed variations', value: 0, tone: 'actual' },
            { label: 'Not agreed', value: 86, tone: 'warn' },
            { label: 'Forecast final value', value: 2138, total: true },
          ],
        }),
      ),
      ['Contract sum and Agreed variations', 'Not agreed', 'Subtotal'],
      'a fully toned waterfall keys a colour it did not paint',
    );
  });

  it('carries the float and the critical flag a Gantt draws but a table would lose', () => {
    const rows = tableRows(
      svg(
        ganttChart({
          title: 'Programme',
          tasks: [
            { id: 'a', label: 'Piling', start: '2026-01-05', end: '2026-02-10', totalFloat: 0, critical: true },
            { id: 'b', label: 'Fit-out', start: '2026-03-01', end: '2026-04-01', totalFloat: 12 },
          ],
        }),
      ),
    );
    assert.equal((rows[0] as string[])[4], 'yes', 'the critical activity is not marked in the table');
    assert.equal((rows[1] as string[])[3], '12d', 'float did not reach the table');
  });
});
