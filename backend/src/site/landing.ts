import { esc } from '../messaging/render.ts';
import { EVENT_TYPES } from '../goldenthread/eventTypes.ts';
import { ROUTES } from '../api/routes.ts';
import { page } from './layout.ts';
import { MEDIA_SLOTS, slotFile } from './media.ts';

/**
 * The landing page.
 *
 * The one page most people see before they see anything else, so it carries a
 * heavier visual budget than the rest of the site — depth, motion, a hero that
 * behaves like a control room rather than a brochure.
 *
 * Two constraints shaped every decision here.
 *
 * **Nothing loads from anywhere else.** No font CDN, no analytics tag, no
 * third-party host of any kind. The structural visuals are CSS and inline SVG
 * generated here — gradients, grid work, a drawn site section, an animated
 * chain — which is why the page is dense: they are cheaper and sharper than an
 * image and cannot be blocked, cached stale, or slow the first paint.
 *
 * Photography was originally excluded outright. It is now allowed on one
 * condition: the file is ours and served from this origin, under the same
 * `img-src 'self'` policy as everything else. That keeps the part of the
 * original rule that actually protects somebody — no third party learns who
 * read this page. See `frontend/media/README.md` for the slots.
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

/**
 * Landing imagery, rendered only where the file is really there.
 *
 * A slot with no file renders nothing at all — no broken icon, no empty frame
 * reserving space for an image that is never coming. The alternative is a page
 * that looks finished and is not, which is the failure this codebase spends
 * most of its effort avoiding.
 *
 * The slot itself — where it goes, what it has to show, what size — is declared
 * in `site/media.ts`, which is also what the upload route and the operator's
 * screen read. Three lists of five filenames would be three chances to
 * disagree about which picture belongs where.
 *
 * Presence is still not a filesystem call per visit; `media.ts` caches it and
 * invalidates the cache when a picture is uploaded, so a new one appears
 * without the restart this used to need.
 */
function figure(id: string): string {
  const slot = MEDIA_SLOTS.find((candidate) => candidate.id === id);
  const file = slot && slotFile(id);
  if (!slot || !file) return '';

  // width and height reserve the space before the bytes arrive, so the page
  // does not reflow under the reader as each image lands. `loading="lazy"`
  // is deliberately absent on the first plate — it is above the fold on a
  // laptop, and lazily loading what is already visible delays it.
  return `<figure class="${slot.className}">
      <img src="/media/${esc(file)}" alt="${esc(slot.alt)}"
           width="${slot.width}" height="${slot.height}"
           decoding="async" loading="lazy">
    </figure>`;
}

export function landing(): string {
  const routes = ROUTES.length;
  const ledgerEvents = EVENT_TYPES.length;

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
          <stop offset="0%" stop-color="#2a2f37"/><stop offset="100%" stop-color="#090a0d"/>
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
      <!--
        One colour.

        This headline used to put its second and third lines in Signal Orange.
        That is the most recognisable machine-made-landing-page gesture there
        is after the gradient fill, and it also broke the rule this palette is
        built on: orange means something on every other screen in the product —
        a value at risk, a path that drives the date — and a headline wearing it
        teaches the reader it means nothing.

        The emphasis is now typographic, which is what typography is for.
      -->
      <h1>The record of how your asset came to exist.</h1>
      <p class="lede">
        A missed pay less notice makes the application payable in full. An extension of time you cannot substantiate is
        an extension you do not get. Margin erodes in the four weeks between the thing happening and the review that
        finds it. This platform computes all three on the day they happen — not at the month end.
      </p>
      <p class="lede-second">
        One governed record from concept to the thirtieth year of operation, and every figure on it computed from that
        record rather than typed into it.
      </p>
      <!--
        Three, and the order is the argument.

        "Try it" first because the strongest thing this company owns is a
        programme somebody can walk through, and until now it was behind a login
        screen that no prospect ever reaches. A landing page whose only offers
        are a signup form and an essay is a page that describes the product and
        never shows it.
      -->
      <div class="cta-row">
        <a class="btn lg" href="/demo">Walk a live £17.6M job <span aria-hidden="true">→</span></a>
        <a class="btn lg ghost" href="/exposure">What one missed notice costs you</a>
      </div>
      <p class="cta-note">
        Real programme, real notices, real money, no signup. Or
        <a href="/get-started">start free</a> and
        <a href="/demo#book">book twenty minutes</a> when you want somebody on the call.
      </p>

      <!--
        A spine, not a row of pills.

        Seven rounded chips in a wrapping row is the default way to render a
        list of anything, and it says nothing about what the list is. This is a
        *sequence* — thirty years of one asset, in order, with no break at the
        point every other toolchain hands over — so it is drawn as a continuous
        rule with a tick at each stage. The form is the argument.
      -->
      <ol class="lifespan" aria-label="Asset lifecycle">
        ${['Concept', 'Design', 'Tender', 'Construction', 'Commissioning', 'Handover', 'Operation']
          .map((phase, i) => `<li style="--i:${i}"><span>${phase}</span></li>`)
          .join('')}
      </ol>
      <p class="rail-cap">
        One system across all seven, and the last of them runs for thirty years. There is no migration at handover
        because there is nothing to migrate to.
      </p>
    </div>

    <!-- The console, drawn to the shape of the real seeded project rather than
         an invented dashboard with rounder numbers. -->
    <div class="hero-panel" aria-hidden="true">
      <div class="panel">
        <!--
          No red-amber-green window buttons. This is not a screenshot of a Mac,
          it is the product's own chrome, and three coloured dots are a costume
          worn by every mocked-up panel on the internet. The bar carries what
          the real console's bar carries: where you are, and whether the record
          verifies.
        -->
        <div class="panel-top">
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

  <!--
    A specification strip, not a counter row.

    Four enormous numerals across the foot of a hero is the house style of every
    generated marketing page, and it flatters figures that do not need
    flattering: these are not a growth metric, they are the dimensions of a
    system. So they are set the way dimensions are set — label first, value in
    mono at a readable size, hairline between each. It reads as a data sheet,
    which is what it is.
  -->
  <div class="hero-stats">
    <div class="wrap">
      <div><span>Event catalogue</span><b>${ledgerEvents}</b><em>closed, versioned</em></div>
      <div><span>API surface</span><b>${routes}</b><em>documented endpoints</em></div>
      <div><span>Runtime dependencies</span><b>0</b><em>nothing to patch at 3am</em></div>
    </div>
  </div>
</section>

${figure('command-centre')}

<!--
  The money section, and it goes first.

  Everything below this argues that the record can be trusted, which is the
  second question. The first is what any of it is worth, and it has one answer
  in this industry that everybody has felt: a notice window that closed while
  nobody was counting.

  The figures are the seeded demonstration project's own — the same ones the
  walkthrough opens on — and they are labelled as a demonstration rather than
  dressed as a customer outcome we have not earned.
-->
<section class="money">
  <div class="wrap narrow">
    <div class="statute-mark">HGCRA 1996 · s.111</div>
    <h2 class="section-h">The notice nobody was counting</h2>
    <p class="money-scene">
      Application 14 goes in at <b>£1.42M</b>. The valuation says <b>£1.19M</b>. The client's pay less notice is served
      two days after the window shuts.
    </p>
    <p class="money-verdict">
      On that day the whole <b>£1.42M</b> became the notified sum and payable in full — whatever the valuation said.
      The QS found out at the month-end review, three weeks later. <b>The platform computes it the day the window
      closes</b>, names the notice that established the sum, and states what has to be served next.
    </p>
    <p class="money-note">
      That scenario runs on the seeded demonstration project, not on a customer's job. Put your own turnover into
      <a href="/exposure">the arithmetic</a> and it will tell you what one window is worth on your books — with no
      industry average anywhere in it, because we have not got one and would not print one if we had.
    </p>
    <div class="cta-row">
      <a class="btn" href="/exposure">Work it out on my numbers</a>
    </div>
  </div>
</section>

<!--
  The argument nothing else on this site was making.

  Every product in this market sells generation: it writes your method
  statement, drafts your RFI, summarises your drawings. This one is most useful
  at the moments it declines, and for a duty-holder that is the whole of the
  difference. The examples are behaviours in the codebase with tests behind
  them, not aspirations.
-->
<section class="refusal">
  <div class="wrap">
    <h2 class="section-h">It refuses</h2>
    <p class="section-lede">
      Every other platform in this market generates. The useful moments here are the ones where this one declines —
      because a document the system was willing to invent is a document you cannot stand behind.
    </p>
    <div class="refusal-grid">
      <article>
        <h3>It will not certify the same payment twice</h3>
        <p>
          Over-certification, double certification and overpayment are refused by the payment cycle itself, not caught
          by a report afterwards. A refusal arrives as a refusal, never as a zero.
        </p>
      </article>
      <article>
        <h3>It will not approve a plan with gaps in it</h3>
        <p>
          A Construction Phase Plan missing its judgement sections cannot be approved, and while it is unapproved the
          platform refuses to record an induction against it. The paperwork order is the safety order.
        </p>
      </article>
      <article>
        <h3>It will not sign in a name that is not competent</h3>
        <p>
          Six of the sixteen CDM documents need a principal contractor's appointed approver. Where nobody holds that
          duty, those documents sit complete and unsigned rather than carrying a signature the platform had to invent.
        </p>
      </article>
      <article>
        <h3>It will not spend on AI it cannot account for</h3>
        <p>
          No provider is called on an empty wallet, and no charge is taken without a ledger entry. Where a model is
          unavailable it falls back and says which one answered.
        </p>
      </article>
      <article>
        <h3>No agent decides anything</h3>
        <p>
          The whole fleet is capped at <b>propose</b>. Governance events are marked as closed to AI in the catalogue
          itself, so a decision made by a model is not a permission that was withheld — it is a state the system cannot
          reach.
        </p>
      </article>
      <article>
        <h3>Every AI-written line says so</h3>
        <p>
          Narrative sections carry their author and whether a model or the local stand-in produced them. An assurance
          team asking who wrote the safety case gets a name, not a shrug.
        </p>
      </article>
    </div>
  </div>
</section>

<section class="proof">
  <div class="wrap">
    ${figure('broken-workflows')}
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
      ${figure('visibility-control')}
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
    ${figure('control-every-variable')}
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

<!--
  Who built this, and why that is the argument rather than a biography.

  A buyer is being asked to trust the record they will defend themselves with to
  a supplier they have not heard of. "About us" pages answer that with adjectives.
  The only answer that lands in this market is that the person who built it has
  stood on the site and met the problem — so the section leads with the failure
  he met, not with his CV, and the CV is one line.
-->
<section class="origin">
  <div class="wrap narrow">
    <div class="statute-mark">Why it exists</div>
    <h2 class="section-h">Built by someone who spent twenty years working without it</h2>
    <p class="origin-lede">
      CONSTRUX comes out of <b>Justin Nseya's</b> twenty years as an MCIOB construction professional and senior
      project-management leader — and out of the same failure, met on project after project.
    </p>
    <p class="origin-body">
      Design, programme, cost, procurement, contracts, delivery, commissioning and handover were each managed
      competently, and each in a different system. Every one of them was fine on its own. What did not exist anywhere
      was the join — so information arrived late rather than missing, risks were found after they had already become
      variations, and the most expensive people on the project spent their time chasing updates instead of controlling
      delivery.
    </p>
    <p class="origin-body">
      That is not a people problem and no better version of any one of those systems fixes it. It is structural: there
      was nowhere that recorded what happened once, at the moment it happened, in a form every discipline could read.
    </p>
    <div class="cta-row">
      <a class="btn ghost" href="/about">The whole of why</a>
    </div>
  </div>
</section>

<!--
  The objection nobody in this market answers out loud.

  A buyer is being asked to put the record they will defend themselves with
  inside a company they have not heard of. "We will still be here" is what every
  vendor says and none of them can prove. What *is* provable is that the record
  does not need us — and after the verification work, that stopped being a
  promise and became an endpoint anyone can call.
-->
<section class="exit">
  <div class="wrap narrow">
    <h2 class="section-h">If we disappeared tomorrow, you would keep the evidence</h2>
    <p class="section-lede">
      That is not a reassurance. It is three properties of the record, and you can test all three before you pay us
      anything.
    </p>
    <ol class="exit-list">
      <li>
        <b>Every export leaves whole.</b> Branded, hashed and recorded, in PDF, Word, JSON or CSV. Nothing about a
        document depends on this platform being reachable to read it.
      </li>
      <li>
        <b>Every document proves itself without us — to a stranger.</b> A content hash proves nothing on its own:
        whoever alters a document recomputes it. So each one carries a verification code only this platform can
        produce, and <a href="/verify-document">anyone holding the document can check it</a> with no account and no
        relationship to you. A client's solicitor. An adjudicator. An insurer.
      </li>
      <li>
        <b>The log verifies on its own terms.</b> Replay every event, recompute the chain, and a single root hash falls
        out that any party holding the same log can reproduce. That check does not run here — it runs wherever the log
        is.
      </li>
    </ol>
    <p class="exit-note">
      Which is also the answer to the question behind it: an evidence trail whose truth depends on the supplier still
      trading is not an evidence trail. It is a subscription.
    </p>
    <div class="cta-row">
      <a class="btn ghost" href="/verify-document">Check a document now</a>
    </div>
  </div>
</section>

<section class="cta-band big">
  <div class="wrap">
    ${figure('founder')}
    <h2>Start with a record you can defend</h2>
    <p>A trial governs, records and computes. No card, no call, no sales qualification step.</p>
    <div class="cta-row">
      <a class="btn lg" href="/demo">Walk a live £17.6M job <span aria-hidden="true">→</span></a>
      <a class="btn lg ghost" href="/exposure">What it costs you</a>
      <a class="btn lg ghost" href="/get-started">Start free</a>
      <a class="btn lg ghost" href="/developers">Read the API</a>
    </div>
  </div>
</section>`,
  );
}
