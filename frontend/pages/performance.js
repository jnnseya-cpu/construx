import { api } from '../lib/api.js';
import { barChart } from '../lib/charts.js';
import { head, refusal } from '../lib/estate.js';
import { badge, html, humanise, pct, raw, render, table, time } from '../lib/ui.js';

/**
 * Performance.
 *
 * The console had two numbers for this — total requests and one estate-wide p95
 * — which is enough to know something is slow and useless for knowing what. An
 * estate p95 of 40ms hides a document generation at four seconds, because it
 * runs once an hour against ten thousand cheap reads.
 *
 * Arranged around the question somebody optimising actually asks: **what is in
 * the tail, and is it worth anything?** The tail attribution panel is the point
 * of the screen — not the route with the worst p95, which is usually something
 * called twice, but the routes whose calls are actually landing past the estate
 * p95 and therefore actually costing people time.
 */

function bar(route, format) {
  return {
    label: `${route.method} ${route.route}`,
    sub: `${route.calls} call${route.calls === 1 ? '' : 's'} · median ${route.p50DurationMs}ms · slowest ${route.maxDurationMs}ms`,
    value: format(route),
    tone: route.failures > 0 ? 'bad' : route.p95DurationMs >= 1000 ? 'warn' : '',
  };
}

export async function performance(root) {
  const position = await api.get('/v1/admin/performance').catch((error) => ({ error }));

  if (position.error) {
    render(root, html`${head({ title: 'Performance' })}${refusal('Platform performance', position.error)}`);
    return;
  }

  const classes = Object.entries(position.byStatusClass ?? {}).sort(([a], [b]) => a.localeCompare(b));

  render(
    root,
    html`
      ${head({
        title: 'Performance',
        intent: position.note,
      })}

      <section class="grid g4" style="margin-bottom:14px">
        <div class="card">
          <h2>Requests</h2>
          <div class="metric">${(position.requestsTotal ?? 0).toLocaleString('en-GB')}</div>
          <div class="metric-sub">
            since this process started${
              position.windowTrimmed
                ? ` · ${(position.windowRequests ?? 0).toLocaleString('en-GB')} of them still in the measured window`
                : ''
            }
          </div>
        </div>
        <div class="card">
          <h2>Median</h2>
          <div class="metric">${position.p50DurationMs}ms</div>
          <div class="metric-sub">half of all requests are faster than this</div>
        </div>
        <div class="card">
          <h2>p95</h2>
          <div class="metric ${raw(position.p95DurationMs >= 1000 ? 'warn' : '')}">${position.p95DurationMs}ms</div>
          <div class="metric-sub">one request in twenty is slower · p99 ${position.p99DurationMs}ms</div>
        </div>
        <div class="card">
          <h2>Failures</h2>
          <div class="metric ${raw(position.failuresPerThousand > 0 ? 'bad' : '')}">${position.failuresPerThousand}</div>
          <div class="metric-sub">per thousand requests — responses of 500 or above</div>
        </div>
      </section>

      <div class="grid g-2-1" style="margin-bottom:14px">
        <div class="card chart-card">
          <h2>What is in the tail</h2>
          <div class="metric-sub" style="margin-bottom:12px">
            Calls that landed <b>past the estate-wide p95 of ${position.p95DurationMs}ms</b>, attributed to the route
            they came from. Not the same question as "which route has the worst p95" — a route called twice, slowly,
            has a terrible p95 and costs nobody anything. This is where the waiting actually happens.
          </div>
          ${barChart({
            horizontal: true,
            data: (position.tailAttribution ?? []).map((entry) => ({
              label: entry.route,
              sub: `${pct(entry.share * 100, 1)} of everything past p95`,
              value: entry.callsOverP95,
            })),
            format: (value) => `${value} call${value === 1 ? '' : 's'}`,
            empty: 'Not enough traffic on this process for a tail to exist.',
          })}
        </div>
        <div class="card">
          <h2>Responses by class</h2>
          <div class="split-list">
            ${classes.map(
              ([cls, count]) => html`<div class="row">
                <span class="lbl">${cls}</span>
                <span class="val">${badge(
                  String(count),
                  cls.startsWith('5') ? 'bad' : cls.startsWith('4') ? 'warn' : 'ok',
                )}</span>
              </div>`,
            )}
          </div>
          <div class="metric-sub" style="margin-top:12px">
            A 4xx is usually the platform working: a refusal is what a permission model is for. A 5xx is the platform
            failing, and the two are never counted together.
          </div>
          ${
            position.observedFrom
              ? html`<div class="metric-sub" style="margin-top:12px">
                  Window runs from ${time(position.observedFrom)} to ${time(position.observedTo)}.
                </div>`
              : ''
          }
        </div>
      </div>

      <div class="grid g2" style="margin-bottom:14px">
        <div class="card chart-card">
          <h2>Slowest at the tail</h2>
          <div class="metric-sub" style="margin-bottom:12px">
            By p95, and only routes called at least three times — a single cold-start read is not a performance signal
            and putting one at the top of this list would send somebody to fix nothing.
          </div>
          ${barChart({
            horizontal: true,
            data: (position.slowest ?? []).map((route) => bar(route, (r) => r.p95DurationMs)),
            format: (value) => `${value}ms`,
            empty: 'Not enough traffic on this process to rank anything.',
          })}
        </div>
        <div class="card chart-card">
          <h2>Busiest</h2>
          <div class="metric-sub" style="margin-bottom:12px">
            Where the load is. A slow route nobody calls costs less than a fast route called constantly.
          </div>
          ${barChart({
            horizontal: true,
            data: (position.busiest ?? []).map((route) => bar(route, (r) => r.calls)),
            format: (value) => `${value}`,
            empty: 'No request has been recorded on this process.',
          })}
        </div>
      </div>

      ${
        (position.failing ?? []).length > 0
          ? html`<div class="card pad0" style="margin-bottom:14px">
              <h2 style="padding:15px 17px 0">Routes returning failures ${badge(String(position.failing.length), 'bad')}</h2>
              <div class="metric-sub" style="padding:0 17px 10px">
                A 500 is the platform's own fault. Every one of these is somebody who asked for something reasonable and
                got an error page.
              </div>
              ${table({
                headers: ['Route', 'Calls', 'Failures', 'Refusals', 'p95', 'Slowest'],
                align: ['', 'num', 'num', 'num', 'num', 'num'],
                rows: position.failing.map((route) => [
                  html`<span class="mono" style="font-size:11px">${route.method} ${route.route}</span>`,
                  route.calls,
                  badge(String(route.failures), 'bad'),
                  route.refusals,
                  `${route.p95DurationMs}ms`,
                  `${route.maxDurationMs}ms`,
                ]),
              })}
            </div>`
          : html`<div class="notice ok" style="margin-bottom:14px">
              <div><b>No route has returned a 500 on this process.</b><br />
              Refusals there are — that is the permission model working — but nothing has failed on the platform's own
              account since it started.</div>
            </div>`
      }

      <div class="card pad0" style="margin-bottom:14px">
        <h2 style="padding:15px 17px 0">Every route, as measured</h2>
        <div class="metric-sub" style="padding:0 17px 10px">
          ${(position.routes ?? []).length} route${(position.routes ?? []).length === 1 ? '' : 's'} have been called on
          this process. A route absent from this table has not been called; it is not broken.
        </div>
        ${table({
          headers: ['Route', 'Calls', 'Median', 'p95', 'Slowest', 'Failures', 'Refusals'],
          align: ['', 'num', 'num', 'num', 'num', 'num', 'num'],
          rows: (position.routes ?? []).map((route) => [
            html`<span class="mono" style="font-size:11px">${route.method} ${route.route}</span>`,
            route.calls,
            `${route.p50DurationMs}ms`,
            `${route.p95DurationMs}ms`,
            `${route.maxDurationMs}ms`,
            route.failures > 0 ? badge(String(route.failures), 'bad') : '—',
            route.refusals > 0 ? String(route.refusals) : '—',
          ]),
          empty: 'No request has been recorded on this process yet.',
        })}
      </div>

      <div class="card">
        <details>
          <summary>Latency held by the metrics registry
            <span class="metric-sub">${(position.latency ?? []).length} routes · survives the log buffer trimming</span>
          </summary>
          <div class="details-body">
            <div class="metric-sub" style="margin-bottom:12px">
              The registry keeps histogram buckets rather than individual calls, so it outlives the log buffer above and
              answers a different question. <b>These percentiles are bucket boundaries, not measurements</b> — a p95 read
              off a cumulative histogram is the edge of the bucket the 95th call fell into, which is why the columns say
              "at most". The last column counts calls past the final bucket, so the tail is never quietly dropped.
            </div>
            ${table({
              headers: ['Route', 'Calls', 'Mean', 'p50 at most', 'p95 at most', 'p99 at most', 'Past last bucket'],
              align: ['', 'num', 'num', 'num', 'num', 'num', 'num'],
              rows: (position.latency ?? []).map((entry) => [
                html`<span class="mono" style="font-size:11px">${entry.route}</span>`,
                entry.count,
                `${entry.meanMs}ms`,
                entry.p50AtMostMs === null ? 'beyond' : `${entry.p50AtMostMs}ms`,
                entry.p95AtMostMs === null ? 'beyond' : `${entry.p95AtMostMs}ms`,
                entry.p99AtMostMs === null ? 'beyond' : `${entry.p99AtMostMs}ms`,
                entry.beyondLastBucket > 0 ? badge(String(entry.beyondLastBucket), 'warn') : '—',
              ]),
              empty: 'The registry has observed nothing.',
            })}
          </div>
        </details>
      </div>
    `,
  );
}
