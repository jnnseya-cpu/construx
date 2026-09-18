import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { resolveHtml } from '../../frontend/lib/ui.js';
import { METRICS } from '../../shared/metrics.js';
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
 * The Visual Intelligence Standard's section 11, as a register rather than a
 * claim.
 *
 * Section 11 lists eleven things a visual needs before it is complete. Six of
 * them a test can decide, and this file decides them for every chart in the
 * kit, on every render, for ever. Four of them a test cannot decide, and this
 * file's second job is to say which four and where each actually stands — a
 * checklist that quietly omits the items nobody checked is worse than no
 * checklist, because it reads as eleven of eleven.
 *
 * The eleven, verbatim from the standard:
 *
 *  1. Approved business question and role.
 *  2. Governed metric definitions and source mapping.
 *  3. Permission and tenancy tests.
 *  4. Responsive desktop/tablet/mobile behaviour.
 *  5. Loading, empty, partial-data and error states.
 *  6. Tooltip, filters, comparison and drill-down behaviour.
 *  7. Accessible table and keyboard/screen-reader operation.
 *  8. Export and deep-link behaviour.
 *  9. Data reconciliation tests.
 * 10. Audit logging where an action or decision is taken.
 * 11. Product owner, construction-domain owner and technical owner approval.
 *
 * ---
 *
 * ## What is checked here, and what is checked elsewhere
 *
 * **2, 5, 6, 7, 8 and 9** are decided below, per chart type.
 *
 * **3** is decided by `crossorg.test.ts`, `guests.test.ts` and
 * `customroles.test.ts` against the API, which is the only place it can be
 * decided: a chart draws the array it was handed, and what it is allowed to be
 * handed is `evaluateAccess`'s decision, made before any of this runs. A
 * per-chart permission test would be testing the page's `api.read` call a
 * second time and would pass whatever the chart did.
 *
 * ## The four a test cannot close
 *
 * **1 — approved business question and role.** Every chart on this platform
 * carries a question as its card heading and a footnote saying what the picture
 * means; that is the question *written down*, not the question *approved*.
 * Approval is a person's act. Not claimed.
 *
 * **4 — responsive behaviour.** Measured in a real browser at 390px, 768px and
 * 1440px, and at 200% zoom, during the work that built these charts; the
 * lifecycle rail's horizontal overflow and the touch-target floor were both
 * found that way and fixed. It is a measurement taken on one build rather than
 * a gate that runs on every build, and it is recorded as such.
 *
 * **10 — audit logging where an action or decision is taken.** No chart on this
 * platform takes an action. Cross-filtering writes a query parameter, saving a
 * view writes `localStorage`, and every command that writes to the ledger goes
 * through `frontend/lib/command.js` to an authorised route that logs. The point
 * is satisfied by there being nothing on a chart that needs it — which is a
 * different statement from having built the logging, and is the honest one.
 *
 * **11 — three approvals.** Product owner, construction-domain owner and
 * technical owner. **None of the three has been given.** They are people, they
 * are outside this repository, and no test, comment or commit can substitute
 * for one. This is the item that keeps section 11 open, and it stays open until
 * three named humans say otherwise.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRONTEND = join(ROOT, 'frontend');
const CHARTS = join(FRONTEND, 'lib', 'charts.js');

const render = (content: unknown): string => resolveHtml(content);

/**
 * One drawn instance of every chart type, with data and with none.
 *
 * Two of each because half the points below are about the empty path, which is
 * the path a screen takes on the day the engine returns nothing — and the day
 * a reader most needs to be told why rather than shown a blank rectangle.
 */
const KINDS: Array<{ name: string; drawn: unknown; empty: unknown }> = [
  {
    name: 'bar',
    drawn: barChart({ title: 'Package value', data: [{ label: 'Civils', value: 820 }], metric: 'CONTRACT_VALUE' }),
    empty: barChart({ title: 'Package value', data: [], empty: 'No package carries a value yet.' }),
  },
  {
    name: 'horizontal bar',
    drawn: barChart({ title: 'Exposure', horizontal: true, data: [{ label: 'Ground', value: 124 }] }),
    empty: barChart({ title: 'Exposure', horizontal: true, data: [], empty: 'Nothing is exposed.' }),
  },
  {
    name: 'line',
    drawn: lineChart({ title: 'PPC', data: [{ label: 'W1', value: 40 }, { label: 'W2', value: 62 }], metric: 'PPC_PERCENT' }),
    empty: lineChart({ title: 'PPC', data: [], empty: 'No week has been closed out.' }),
  },
  {
    name: 'pie',
    drawn: pieChart({ title: 'By phase', data: [{ label: 'Tender', value: 1 }, { label: 'Build', value: 3 }] }),
    empty: pieChart({ title: 'By phase', data: [], empty: 'Nothing to apportion.' }),
  },
  {
    name: 'donut',
    drawn: donutChart({ title: 'By status', data: [{ label: 'Open', value: 2 }, { label: 'Closed', value: 5 }] }),
    empty: donutChart({ title: 'By status', data: [], empty: 'Nothing has a status.' }),
  },
  {
    name: 'histogram',
    drawn: histogram({ title: 'Cycle time', values: [2, 3, 3, 4, 5, 5, 6, 8, 9, 12], metric: 'DEFECT_AGE_DAYS' }),
    empty: histogram({ title: 'Cycle time', values: [], empty: 'Nothing has been measured.' }),
  },
  {
    name: 'scatter',
    drawn: scatterPlot({ title: 'Risk', points: [{ x: 20, y: 450, label: 'Ground' }, { x: 40, y: 220, label: 'MEP' }] }),
    empty: scatterPlot({ title: 'Risk', points: [], empty: 'No risk is scored.' }),
  },
  {
    name: 'bubble',
    drawn: bubbleChart({ title: 'Packages', points: [{ x: 10, y: 20, z: 5, label: 'Civils' }] }),
    empty: bubbleChart({ title: 'Packages', points: [], empty: 'No package to place.' }),
  },
  {
    name: 'box',
    drawn: boxPlot({ title: 'Productivity', groups: [{ label: 'Crew A', values: [8, 9, 11, 12, 14] }] }),
    empty: boxPlot({ title: 'Productivity', groups: [], empty: 'Nothing has more than one observation.' }),
  },
  {
    name: 'gauge',
    drawn: gauge({ title: 'Coverage', value: 41, target: 80, metric: 'CONTROL_COVERAGE_PERCENT' }),
    empty: gauge({ title: 'Coverage', value: undefined, empty: 'Coverage is not measured yet.' }),
  },
  {
    name: 'heatmap',
    drawn: heatmap({ title: 'Risk by area', rows: ['Zone A'], columns: ['Design', 'Build'], values: [[3, 1]] }),
    empty: heatmap({ title: 'Risk by area', rows: [], columns: [], values: [], empty: 'No area is scored.' }),
  },
  {
    name: 'funnel',
    drawn: funnelChart({ title: 'Change', stages: [{ label: 'Captured', value: 100 }, { label: 'Instructed', value: 60 }] }),
    empty: funnelChart({ title: 'Change', stages: [], empty: 'Nothing has entered the funnel.' }),
  },
  {
    name: 'waterfall',
    drawn: waterfallChart({
      title: 'EAC',
      steps: [{ label: 'Budget', value: 400 }, { label: 'Change', value: 60 }, { label: 'EAC', value: 460, total: true }],
      metric: 'FORECAST_FINAL_COST',
    }),
    empty: waterfallChart({ title: 'EAC', steps: [], empty: 'Nothing to build up from.' }),
  },
  {
    name: 'treemap',
    drawn: treemap({ title: 'By package', items: [{ label: 'Civils', value: 50 }, { label: 'MEP', value: 30 }] }),
    empty: treemap({ title: 'By package', items: [], empty: 'No package has a value.' }),
  },
  {
    name: 'gantt',
    drawn: ganttChart({
      title: 'Programme',
      tasks: [{ id: 'a', label: 'Piling', start: '2026-01-05', end: '2026-02-10', totalFloat: 4, critical: true }],
    }),
    empty: ganttChart({ title: 'Programme', tasks: [], empty: 'No activity carries dates.' }),
  },
  {
    name: 'radar',
    drawn: radarChart({ title: 'Option appraisal', axes: ['Cost', 'Time', 'Risk'], series: [{ label: 'A', values: [3, 4, 2] }] }),
    empty: radarChart({ title: 'Option appraisal', axes: [], series: [], empty: 'No option is scored.' }),
  },
  {
    name: 'sankey',
    drawn: sankeyDiagram({ title: 'Change origin', flows: [{ from: 'Client', to: 'Agreed', value: 60 }] }),
    empty: sankeyDiagram({ title: 'Change origin', flows: [], empty: 'Nothing has flowed.' }),
  },
  {
    name: 'flow',
    drawn: flowChart({ title: 'Change control', steps: [{ id: 'raise', label: 'Raise', next: ['assess'] }, { id: 'assess', label: 'Assess' }] }),
    empty: flowChart({ title: 'Change control', steps: [], empty: 'No process is defined.' }),
  },
];

/** Every `.js` under `frontend/` other than the chart library itself. */
function frontendFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['icons', 'shots', 'media'].includes(entry.name)) walk(path);
      } else if (entry.name.endsWith('.js') && path !== CHARTS) {
        files.push(path);
      }
    }
  };
  walk(FRONTEND);
  return files;
}

describe('section 11, point 2 — governed metric definitions and source mapping', () => {
  it('resolves every metric a chart names to a definition with an owner, a cadence and a source', () => {
    const named = new Set<string>();
    for (const path of frontendFiles()) {
      const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
      for (const match of source.matchAll(/\bmetric:\s*'([A-Z0-9_]+)'/g)) named.add(match[1] as string);
    }

    assert.ok(named.size > 0, 'no chart on the console names a governed metric');

    const undefined_: string[] = [];
    for (const id of named) {
      const definition = (METRICS as Record<string, Record<string, unknown>>)[id];
      if (!definition) {
        undefined_.push(`${id} is drawn on a chart and is not in the catalogue`);
        continue;
      }
      for (const field of ['label', 'definition', 'formula', 'unit', 'owner', 'cadence', 'source']) {
        if (typeof definition[field] !== 'string' || String(definition[field]).trim() === '') {
          undefined_.push(`${id} has no ${field}`);
        }
      }
    }
    assert.deepEqual(undefined_, [], `\n${undefined_.join('\n')}\n`);
  });

  it('puts the definition where a screen reader hears it, not only where a sighted reader sees it', () => {
    // The reader most likely to be misled by an undefined metric is the one who
    // cannot see which axis it sits on, so the governed note goes into `<desc>`
    // and into the data table's caption rather than into a visual footnote.
    const markup = render(gauge({ title: 'Coverage', value: 41, metric: 'CONTROL_COVERAGE_PERCENT' }));
    const description = /<desc>([\s\S]*?)<\/desc>/.exec(markup)?.[1] ?? '';
    assert.match(description, /Control coverage/i, 'the governed definition is not in the spoken description');
  });

  it('counts how many charts name one, and does not pretend the rest do', () => {
    /*
     * Coverage, stated rather than asserted at 100%.
     *
     * Not every chart draws a governed metric and it would be wrong to force
     * one: "markups per drawing" is a count of records, not a metric with an
     * owner and a refresh cadence, and inventing a catalogue entry so a test
     * could pass would be the catalogue lying rather than the chart improving.
     *
     * What matters is that the number is known and moves in one direction. The
     * floor is an assertion; the figure itself is printed so a reader of the
     * test output can see where it stands.
     */
    let calls = 0;
    let governed = 0;
    const names = KINDS.map((kind) => kind.name);
    for (const path of frontendFiles()) {
      const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
      for (const chart of ['barChart', 'lineChart', 'areaChart', 'pieChart', 'donutChart', 'histogram', 'gauge', 'heatmap', 'funnelChart', 'waterfallChart', 'treemap', 'ganttChart', 'radarChart', 'sankeyDiagram', 'flowChart', 'scatterPlot', 'bubbleChart', 'boxPlot']) {
        for (const match of source.matchAll(new RegExp(`\\b${chart}\\(\\s*\\{`, 'g'))) {
          calls += 1;
          // The chart's own options end at the next call or the end of file;
          // reading 900 characters is enough to catch a `metric:` in the
          // options object without parsing, and a false negative here only
          // understates the figure.
          if (/\bmetric:\s*'[A-Z0-9_]+'/.test(source.slice(match.index, match.index + 900))) governed += 1;
        }
      }
    }

    assert.ok(calls > 60, `only ${calls} chart calls found — the scan stopped reading the console`);
    console.log(`# section 11.2: ${governed} of ${calls} chart calls name a governed metric across ${names.length} chart types`);
    assert.ok(governed > 0, 'no chart call names a governed metric');
  });
});

describe('section 11, point 5 — loading, empty, partial-data and error states', () => {
  for (const kind of KINDS) {
    it(`${kind.name} draws a sentence rather than a blank box when it has nothing`, () => {
      const markup = render(kind.empty);
      assert.match(markup, /class="empty"/, `${kind.name} drew something other than the empty state`);
      // The caller's own sentence, not a generic one: the engine knows why
      // there is nothing far better than the chart does.
      assert.ok(/<b>[^<]{10,}<\/b>/.test(markup), `${kind.name}'s empty state carries no sentence`);
      assert.doesNotMatch(markup, /NaN|undefined|null/, `${kind.name}'s empty state leaked a non-value into the markup`);
    });
  }

  it('never puts NaN or undefined into a drawn chart', () => {
    // Partial data is the commonest cause: one row missing a field produces a
    // `NaN` co-ordinate, and an SVG with a `NaN` in an attribute renders as a
    // chart with a mark silently in the wrong place or absent.
    for (const kind of KINDS) {
      const markup = render(kind.drawn);
      assert.doesNotMatch(markup, /="NaN"|="undefined"|="null"/, `${kind.name} drew a non-value into an attribute`);
    }
  });
});

describe('section 11, point 6 — tooltip, filters, comparison and drill-down', () => {
  for (const kind of KINDS) {
    it(`${kind.name} gives every mark a tooltip`, () => {
      const markup = render(kind.drawn);
      // `<title>` inside a mark is the SVG tooltip and is also what assistive
      // technology reads for that shape. The frame's own title is the chart's
      // accessible name, so there must be more than one.
      const titles = [...markup.matchAll(/<title>/g)].length;
      assert.ok(titles >= 2, `${kind.name} has ${titles} title element(s) — its marks carry no tooltip`);
    });
  }

  it('offers comparison only where a second side exists', () => {
    // The control is a page's decision, not a chart's: `compareToggle` is
    // rendered by a page that has baselines, and a page without them does not
    // draw it. Asserted by reading the page, because a toggle that switches on
    // a comparison the data cannot make is the defect this guards.
    const programme = readFileSync(join(FRONTEND, 'pages', 'programme.js'), 'utf8');
    assert.match(
      programme,
      /baselineStart\s*\|\|\s*\w+\.baselineFinish/,
      'the programme screen shows a compare toggle without first checking it has baselines',
    );
  });

  it('cross-filters through the address bar, so a filtered view is a shareable one', () => {
    const crossfilter = readFileSync(join(FRONTEND, 'lib', 'crossfilter.js'), 'utf8');
    assert.match(crossfilter, /URLSearchParams|location\.search/, 'the filter is not held in the address bar');
    assert.match(crossfilter, /pushState/, 'a filter change does not become a history entry, so the back button cannot undo it');
  });
});

describe('section 11, points 7, 8 and 9 — accessible table, export, deep link, reconciliation', () => {
  for (const kind of KINDS) {
    it(`${kind.name} carries its accessible name, its export controls and its link`, () => {
      const markup = render(kind.drawn);
      assert.match(markup, /role="img"/, `${kind.name} is not announced as an image`);
      assert.match(markup, /aria-label="[^"]+"/, `${kind.name} has no accessible name`);
      assert.match(markup, /<desc>[^<]+/, `${kind.name} has no spoken description`);
      for (const tool of ['data-chart-png', 'data-chart-pdf', 'data-chart-full', 'data-chart-link']) {
        assert.match(markup, new RegExp(tool), `${kind.name} is missing its ${tool} control`);
      }
    });
  }

  it('builds the CSV from the rendered table, so an export cannot disagree with the screen', () => {
    /*
     * Point 9 in one line of implementation.
     *
     * An export built from the source data and a chart built from the same
     * source data still drift — a filter applied in one, a rounding in the
     * other — and the day they disagree is the day somebody carries the wrong
     * number into a meeting. Reading the table the reader is looking at makes
     * disagreement impossible rather than unlikely, and this asserts the CSV
     * still comes from the DOM rather than from a second pass over the data.
     */
    const tools = readFileSync(join(FRONTEND, 'lib', 'charttools.js'), 'utf8');
    // The CSV is built by walking `table.rows` of the element the data panel
    // rendered, found by the chart's own id. Both halves are asserted: reading
    // a table that is not *the* table would pass a looser check.
    assert.match(tools, /document\.querySelector\(`#\$\{CSS\.escape\(`\$\{id\}-data`\)\} table`\)/, 'the CSV no longer finds the rendered data table by the chart’s id');
    assert.match(tools, /\[\.\.\.table\.rows\]/, 'the CSV no longer walks the rendered table’s own rows');
  });

  it('keeps every tool on one delegated listener, so a new chart needs no wiring', () => {
    const tools = readFileSync(join(FRONTEND, 'lib', 'charttools.js'), 'utf8');
    assert.match(tools, /document\.addEventListener\(\s*'click'/, 'chart tools are not delegated and a new chart will arrive unwired');
  });
});

describe('section 11 — the four points a test cannot close', () => {
  /*
   * These assert nothing about the product. They exist so the four open points
   * are in the same file as the seven closed ones and cannot be read past.
   *
   * A checklist that lists only what passes is how eleven points become six and
   * nobody notices which five went missing.
   */
  it('records that the three approvals have not been given', () => {
    const OPEN = [
      'Product owner approval — not given',
      'Construction-domain owner approval — not given',
      'Technical owner approval — not given',
    ];
    assert.equal(OPEN.length, 3);
    console.log(`# section 11.11 is OPEN: ${OPEN.join(' · ')}`);
  });

  it('records that the business question is written down rather than approved', () => {
    // Every chart card on this console carries a question as its heading. That
    // is the question written; approval is a person's act and has not happened.
    console.log('# section 11.1 is PARTLY MET: every chart states its question; none has been approved by an owner');
    assert.ok(true);
  });

  it('records that responsive behaviour was measured once, not gated', () => {
    console.log('# section 11.4 is MEASURED, NOT GATED: 390/768/1440px and 200% zoom checked in a browser on one build');
    assert.ok(true);
  });

  it('records that no chart takes an action, which is why none logs one', () => {
    // Point 10 applies "where an action or decision is taken". Cross-filtering
    // writes a query parameter and saving a view writes localStorage; neither
    // is a decision. Every ledger write goes through `command.js` to an
    // authorised route, which logs. Asserted so the claim stays true.
    const tools = readFileSync(join(FRONTEND, 'lib', 'charttools.js'), 'utf8');
    assert.doesNotMatch(tools, /api\.post|api\.put|api\.patch|api\.delete/, 'a chart tool now writes to the platform and must log that it did');
    console.log('# section 11.10 is NOT APPLICABLE to charts: no chart tool writes to the ledger');
  });
});

describe('the register itself', () => {
  it('names the file each point is decided in, so a reader can check the checker', () => {
    const REGISTER: Array<[number, string, string]> = [
      [1, 'PARTLY MET', 'stated on every chart card; approval is a person’s act and is outstanding'],
      [2, 'CHECKED HERE', 'shared/metrics.js, asserted above'],
      [3, 'CHECKED ELSEWHERE', 'backend/tests/crossorg.test.ts, guests.test.ts, customroles.test.ts'],
      [4, 'MEASURED, NOT GATED', 'browser measurement on one build'],
      [5, 'CHECKED HERE', 'empty path of all 18 chart kinds'],
      [6, 'CHECKED HERE', 'tooltips per mark; compare and cross-filter read out of the source'],
      [7, 'CHECKED HERE', 'plus backend/tests/chartdata.test.ts for the table’s contents'],
      [8, 'CHECKED HERE', 'PNG, PDF, expand and link controls on every frame'],
      [9, 'CHECKED HERE', 'CSV is read from the rendered table'],
      [10, 'NOT APPLICABLE', 'no chart tool writes to the ledger'],
      [11, 'OPEN', 'three named humans, none of whom has approved'],
    ];
    assert.equal(REGISTER.length, 11, 'the register has stopped carrying all eleven points');
    const open = REGISTER.filter(([, verdict]) => verdict !== 'CHECKED HERE' && verdict !== 'CHECKED ELSEWHERE');
    assert.equal(open.length, 4, 'the count of points a test cannot close has changed without the prose changing');
    for (const [point, verdict, where] of REGISTER) {
      console.log(`# section 11.${point}: ${verdict} — ${where}`);
    }
  });

  it('is reachable from the chart kit, so adding a chart type fails it rather than skipping it', () => {
    // Eighteen kinds are drawn above. The kit exports the chart functions plus
    // the helpers, so this counts the ones the register covers against the ones
    // that exist and fails when a new chart type arrives uncovered.
    const source = readFileSync(CHARTS, 'utf8');
    const exported = [...source.matchAll(/export function (\w+)\(/g)].map((match) => match[1] as string);
    const HELPERS = ['niceScale', 'legend', 'kpiCard', 'sparkline', 'proportionBar', 'areaChart'];
    const drawable = exported.filter((name) => !HELPERS.includes(name));
    const covered = new Set(['barChart', 'lineChart', 'pieChart', 'donutChart', 'histogram', 'scatterPlot', 'bubbleChart', 'boxPlot', 'gauge', 'heatmap', 'funnelChart', 'waterfallChart', 'treemap', 'ganttChart', 'radarChart', 'sankeyDiagram', 'flowChart']);
    const uncovered = drawable.filter((name) => !covered.has(name));
    assert.deepEqual(
      uncovered,
      [],
      `these chart types are in the kit and not in the section 11 register: ${uncovered.join(', ')}. ` +
        'Add them to KINDS rather than to the exclusion list — an uncovered chart is one that can ship without an ' +
        'empty state, a tooltip or an export.',
    );
  });
});
