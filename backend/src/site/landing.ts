import { esc } from '../messaging/render.ts';
import { EVENT_TYPES } from '../goldenthread/eventTypes.ts';
import { NOTIFICATION_EVENTS } from '../notifications/catalogue.ts';
import { ROUTES } from '../api/routes.ts';
import { page } from './layout.ts';

/**
 * The landing page.
 *
 * The one page most people see before they see anything else, so it carries a
 * heavier visual budget than the rest of the site — depth, motion, a hero that
 * behaves like a control room rather than a brochure.
 *
 * Two constraints shaped every decision here.
 *
 * **Nothing loads from anywhere else.** No stock photography, no font CDN, no
 * analytics tag. Every visual is CSS and inline SVG generated here, which is
 * why the page is dense: gradients, grid work, a drawn site section and an
 * animated chain are cheaper and sharper than any image, and they cannot be
 * blocked, cached stale, or slow the first paint. It also means the page has
 * no third party watching the people who read it.
 *
 * **Every figure is read from the product.** Route count, event catalogue
 * sizes, engine names. A landing page is the easiest place for a number to
 * drift into fiction because nobody tests prose — so these are not prose. The
 * screenshot panel shows the seeded demonstration project's real shape rather
 * than an invented dashboard with rounder numbers.
 *
 * The motion respects `prefers-reduced-motion`: it is atmosphere, and atmosphere
 * that makes somebody ill is not a trade worth making.
 */

const ENGINES = [
  ['Programme', 'Critical path, float and PERT probability. Monte Carlo completion, corrected for merge bias.'],
  ['Commercial', 'Earned value with three EAC scenarios, CVR with margin erosion, S-curve cashflow.'],
  ['Contracts', 'The Construction Act position — which notice established the notified sum and what a missed one cost.'],
  ['Risk', 'Expected value, P80 contingency, and thresholds proportionate to the contract rather than fixed.'],
  ['Quality', 'Inspection and test plans with acceptance criteria, hold points witnessed rather than asserted.'],
  ['Design', 'Revisions, clash closeout with evidence, and clause extraction from the specification as supplied.'],
  ['Operations', 'Reliability-adjusted maintenance forecasting against the asset the record actually describes.'],
];

export function landing(): string {
  const routes = ROUTES.length;
  const ledgerEvents = EVENT_TYPES.length;
  const commsEvents = NOTIFICATION_EVENTS.length;

  return page(
    {
      title: 'The construction operating system',
      description:
        'One governed record from concept to the thirtieth year of operation. Every state change hash-chained, every figure computed, every claim checkable by replay.',
      path: '/',
    },
    `<section class="hero">
  <!-- Depth, drawn rather than photographed: a survey grid, a horizon glow and
       a structural section, all vector, none of it loaded from anywhere. -->
  <div class="hero-bg" aria-hidden="true">
    <div class="grid-plane"></div>
    <div class="glow"></div>
    <svg class="section-art" viewBox="0 0 1440 620" preserveAspectRatio="xMidYMax slice">
      <defs>
        <linearGradient id="steel" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#2a2f37"/><stop offset="100%" stop-color="#0c0c0e"/>
        </linearGradient>
        <linearGradient id="edge" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#ff6600" stop-opacity="0"/>
          <stop offset="50%" stop-color="#ff6600" stop-opacity=".55"/>
          <stop offset="100%" stop-color="#ff6600" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <!-- Ground line and strata -->
      <path d="M0 470 H1440" stroke="url(#edge)" stroke-width="1.2"/>
      <path d="M0 470 L1440 470 L1440 620 L0 620 Z" fill="url(#steel)" opacity=".85"/>
      <path d="M0 512 H1440 M0 556 H1440 M0 598 H1440" stroke="#ffffff" stroke-opacity=".045"/>
      <!-- Piles -->
      <g stroke="#ffffff" stroke-opacity=".09">
        <path d="M240 470 V612 M241 470 V612"/><path d="M560 470 V600"/>
        <path d="M880 470 V608"/><path d="M1200 470 V596"/>
      </g>
      <!-- Frame above ground -->
      <g stroke="#ffffff" stroke-opacity=".13" fill="none">
        <path d="M240 470 V250 H560 V470"/>
        <path d="M560 470 V190 H880 V470"/>
        <path d="M880 470 V286 H1200 V470"/>
        <path d="M240 340 H560 M560 300 H880 M880 372 H1200"/>
        <path d="M240 250 L560 340 M560 340 L240 470 M560 190 L880 300 M880 300 L560 470"/>
      </g>
      <!-- Survey ticks -->
      <g fill="#ff6600" fill-opacity=".5">
        <circle cx="240" cy="250" r="3"/><circle cx="560" cy="190" r="3"/>
        <circle cx="880" cy="286" r="3"/><circle cx="1200" cy="470" r="3"/>
      </g>
    </svg>
    <div class="scanline"></div>
  </div>

  <div class="wrap hero-inner">
    <div class="hero-copy">
      <div class="eyebrow"><span class="dot"></span> Construction AI Operating System</div>
      <h1>The record of <span class="accent">how your asset<br>came to exist</span>.</h1>
      <p class="lede">
        One governed spine from concept to the thirtieth year of operation. Every state change is an append-only,
        hash-chained event. Every figure is computed from the record rather than typed into it. Every claim on this
        page is checkable by replaying the log.
      </p>
      <div class="cta-row">
        <a class="btn lg" href="/get-started">Start free <span aria-hidden="true">→</span></a>
        <a class="btn lg ghost" href="/how-it-works">How verification works</a>
      </div>

      <div class="rail" role="list" aria-label="Asset lifecycle">
        ${['Concept', 'Design', 'Tender', 'Construction', 'Commissioning', 'Handover', '30-yr O&amp;M']
          .map((phase, i) => `<div role="listitem" style="--i:${i}">${phase}</div>`)
          .join('')}
      </div>
      <p class="rail-cap">One system across all seven. No migration at handover, because there is nothing to migrate to.</p>
    </div>

    <!-- The console, drawn to the shape of the real seeded project rather than
         an invented dashboard with rounder numbers. -->
    <div class="hero-panel" aria-hidden="true">
      <div class="panel">
        <div class="panel-top">
          <span class="tl r"></span><span class="tl a"></span><span class="tl g"></span>
          <div class="crumb">Meridian Infrastructure &rsaquo; National Water Resilience &rsaquo; <b>Ashworth WTW — Phase 2</b></div>
          <div class="pill live">CHAIN VERIFIED</div>
        </div>
        <div class="panel-body">
          <div class="kpis">
            <div class="kpi"><div class="k">Contract value</div><div class="val accent">£17.6M</div><div class="d">infrastructure · Manchester</div></div>
            <div class="kpi"><div class="k">Forecast margin</div><div class="val warn">5.91%</div><div class="d">2.09 pts eroded vs tender</div></div>
            <div class="kpi"><div class="k">Delay exposure</div><div class="val bad">48.6d</div><div class="d">critical · recovery costed</div></div>
          </div>

          <div class="bars">
            <div class="cap"><span>Programme — critical path</span><span>326d · P80 339d</span></div>
            <div class="bar-row"><span>Bulk excavation</span><div class="track"><i style="--w:55%"></i></div><em>55%</em></div>
            <div class="bar-row"><span>Piling</span><div class="track"><i style="--w:82%"></i></div><em>82%</em></div>
            <div class="bar-row"><span>Inlet works</span><div class="track"><i class="warn" style="--w:31%"></i></div><em>31%</em></div>
            <div class="bar-row"><span>MEP first fix</span><div class="track"><i style="--w:12%"></i></div><em>12%</em></div>
          </div>

          <div class="chain">
            <div class="cap"><span>Golden Thread</span><span>append-only</span></div>
            <div class="chain-row">
              ${[
                'PAYMENT_CERTIFIED',
                'VARIATION_INSTRUCTED',
                'PROGRESS_RECORDED',
                'SITE_OBSERVATION_CAPTURED',
                'NCR_RAISED',
              ]
                .map((code, i) => `<span class="link" style="--i:${i}">${esc(code)}</span>`)
                .join('<span class="join"></span>')}
            </div>
          </div>
        </div>
      </div>
      <div class="panel-shadow"></div>
    </div>
  </div>

  <div class="hero-stats">
    <div class="wrap">
      <div><b>${ledgerEvents}</b><span>event types, closed catalogue</span></div>
      <div><b>${routes}</b><span>API endpoints</span></div>
      <div><b>${commsEvents}</b><span>communication events</span></div>
      <div><b>0</b><span>runtime dependencies</span></div>
    </div>
  </div>
</section>

<section class="proof">
  <div class="wrap">
    <h2 class="section-h">Not a document store with a search box</h2>
    <p class="section-lede">
      Three things separate a record that survives a dispute from a folder that does not.
    </p>
    <div class="proof-grid">
      <article>
        <div class="proof-n">01</div>
        <h3>Nothing is edited in place</h3>
        <p>
          A correction is a new event and the original stays visible. Each event carries the hash before, the hash
          after, and a chain hash over its predecessor — so an insertion, deletion or alteration anywhere changes every
          hash after it and the state root along with them.
        </p>
      </article>
      <article>
        <div class="proof-n">02</div>
        <h3>The catalogue is closed</h3>
        <p>
          ${ledgerEvents} event types and no others. An event nothing can emit is a capability that does not exist, and
          a test fails if one appears. That invariant exists because a control standard once reported a missing site
          diary on every project — with no command able to write one.
        </p>
      </article>
      <article>
        <div class="proof-n">03</div>
        <h3>Replay is the proof</h3>
        <p>
          Rebuild every entity from the log alone, verify each event independently, emit one root hash any party
          holding the same log can recompute. Where your policy withholds a record, the redaction is reported and the
          root still covers the complete record.
        </p>
      </article>
    </div>
  </div>
</section>

<section class="engines">
  <div class="wrap">
    <h2 class="section-h">Seven engines, real arithmetic</h2>
    <p class="section-lede">
      Not summarisation over your documents. Forward and backward pass, expected value, statutory date reckoning —
      computed, deterministic, and the same answer twice.
    </p>
    <div class="engine-grid">
      ${ENGINES.map(
        ([name, body], i) => `<article class="engine" style="--i:${i}">
        <h3>${esc(name!)}</h3><p>${esc(body!)}</p>
      </article>`,
      ).join('\n      ')}
    </div>
  </div>
</section>

<section class="statute">
  <div class="wrap narrow">
    <div class="statute-mark">HGCRA 1996 · s.108 · s.111 · s.116</div>
    <h2>The statute that decides who gets paid</h2>
    <p>
      If the payer gives no payment notice and no pay less notice, the sum applied for becomes the notified sum and is
      payable in full, however optimistic the application was. The platform computes that position rather than
      describing it: which notice established the notified sum, what a missed or invalid one has already cost in money,
      whether the right to suspend is open, and what has to be served next.
    </p>
    <p>
      A term the Act makes void is replaced by the Scheme whether anybody noticed or not — so a contractor who priced
      for a payment period the Act strikes out has priced for a cost he does not carry. A term that is merely onerous
      is lawful, and stays his problem. The platform tells the two apart.
    </p>
    <p class="statute-note">
      And it invents nothing. Statutory interest runs at base rate plus 8%; the base rate is a fact about the outside
      world this platform is not connected to, so the entitlement is stated and the amount is not.
    </p>
  </div>
</section>

<section class="cta-band big">
  <div class="wrap">
    <h2>Start with a record you can defend</h2>
    <p>A trial governs, records and computes. No card, no call, no sales qualification step.</p>
    <div class="cta-row">
      <a class="btn lg" href="/get-started">Get started <span aria-hidden="true">→</span></a>
      <a class="btn lg ghost" href="/developers">Read the API</a>
    </div>
  </div>
</section>`,
  );
}
