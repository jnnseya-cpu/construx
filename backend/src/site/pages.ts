import { esc } from '../messaging/render.ts';
import { PACKAGES } from '../billing/seats.ts';
import { config } from '../config.ts';
import { formatMoney } from '../domain/locale.ts';
import { NOTIFICATION_EVENTS, CATEGORIES } from '../notifications/catalogue.ts';
import { EVENT_TYPES } from '../goldenthread/eventTypes.ts';
import { ROUTES } from '../api/routes.ts';
import { accountTypes } from '../identity/signup.ts';
import { cards, cta, page, pageHead, SITE_PAGES } from './layout.ts';

/**
 * The public pages.
 *
 * Every number on these pages is read from the thing it describes — the route
 * table, the event catalogues, the package definitions — rather than typed into
 * the copy. Marketing figures that drift from the product are the most common
 * way a site starts lying, and they drift silently because nobody tests prose.
 * Here, adding a route changes the developers page, and a test asserts the two
 * agree.
 *
 * What is *not* here is as deliberate. There are no invented customer logos, no
 * fabricated case studies, no testimonials from people who do not exist, and no
 * uptime figure the platform does not measure. A status page that always says
 * "operational" because it is hard-coded is worse than no status page.
 */

const RESERVED_PROJECT_PREFIXES = ['platform-'];

/** Counts taken from the product, not from the copy. */
function facts() {
  const publicRoutes = ROUTES.filter((r) => r.public).length;
  return {
    routes: ROUTES.length,
    publicRoutes,
    ledgerEvents: EVENT_TYPES.length,
    commsEvents: NOTIFICATION_EVENTS.length,
    commsCategories: CATEGORIES.length,
    mandatoryNotices: NOTIFICATION_EVENTS.filter((e) => e.mandatory).length,
    packages: Object.keys(PACKAGES).length,
  };
}

// ---------------------------------------------------------------------- About

export function about(): string {
  const f = facts();
  return page(
    {
      title: 'About',
      description:
        'CONSTRUX.AI is a construction operating system built around one idea: the record of how an asset came to exist should be evidence, not an afterthought.',
      path: '/about',
    },
    `${pageHead({
      eyebrow: 'Company',
      title: 'One record, from concept to the thirtieth year',
      standfirst:
        'Construction does not lose money because nobody worked hard. It loses money because the record of what was agreed, when, and on what basis is scattered across email, spreadsheets and somebody’s memory of a site meeting.',
    })}

<section class="prose">
  <div class="wrap narrow">
    <h2>What we build</h2>
    <p>
      A single governed spine for an asset's whole life — concept, design, tender, construction, commissioning, handover
      and thirty-plus years of operation. Not seven products with an export button between them. One data model, one
      permission system, one append-only record.
    </p>

    <h2>Why the record is the product</h2>
    <p>
      When a dispute reaches adjudication, the question is never who worked hardest. It is what was notified, on what
      date, supported by what evidence. A platform that stores documents answers that badly. A platform that records
      every state change as a hash-chained event, and can replay the whole project from the log alone, answers it
      exactly.
    </p>
    <p>
      That is why ${f.ledgerEvents} event types are a <em>closed</em> catalogue rather than a free-text field. An event
      nothing can emit is a capability that does not exist, and a test fails if one appears. It is why a correction is a
      new event and the original stays visible. And it is why no AI agent in the system holds a mandate above
      <code>PROPOSE</code> — governance decisions are human by construction, not by policy.
    </p>

    <h2>What we will not do</h2>
    <p>
      We do not show invented numbers. If the platform has not measured something, it says so rather than estimating it
      into a dashboard. A denial is displayed as a denial, never as a zero. Where a figure depends on an exchange rate
      nobody published, the figure appears in its own currency with the reason.
    </p>
    <p>
      This site follows the same rule. Every count on these pages is read from the running product. There are no
      customer logos we do not have and no case studies we did not run.
    </p>

    <h2>How it is built</h2>
    <p>
      Zero runtime dependencies. ${f.routes} API endpoints, ${f.publicRoutes} of which are reachable without a
      credential and each one listed in a test that fails if that number changes by accident. Tenant isolation applied
      on every read. Money in minor units everywhere, because a floating-point pound is a rounding error waiting to
      reach an invoice.
    </p>
  </div>
</section>

${cta({
  title: 'See the record work',
  body: 'A worked project runs concept to operations and then verifies itself against its own chain.',
  primary: { href: '/get-started', label: 'Get started' },
  secondary: { href: '/how-it-works', label: 'How it works' },
})}`,
  );
}

// --------------------------------------------------------------- How it works

export function howItWorks(): string {
  const f = facts();
  const phases = [
    ['Concept', 'Sector, governance model and portfolio fit. The first event of the chain is the project’s own creation.'],
    ['Design', 'Drawings, revisions and clash closeout. A markup becomes an RFI with the drawing and revision attached.'],
    ['Tender', 'Take-off, estimate across twenty cost heads, deterministic bid scoring, and a cash-flow model before anybody bids.'],
    ['Construction', 'Work packages, lookahead and PPC, progress against measure, diaries, observations and hold points.'],
    ['Commissioning', 'Inspection and test plans with acceptance criteria, witnessed and evidenced rather than asserted.'],
    ['Handover', 'The operations record is assembled from what was already captured. There is nothing to migrate.'],
    ['Operations', 'Reliability-adjusted maintenance forecasting against the asset the record describes.'],
  ];

  return page(
    {
      title: 'How it works',
      description:
        'Every state change is an event on an append-only hash chain. Replay reconstructs the project from the log alone and produces a root hash anybody holding the same log can recompute.',
      path: '/how-it-works',
    },
    `${pageHead({
      eyebrow: 'Product',
      title: 'Governed by construction, not by policy',
      standfirst:
        'The platform’s central claim is checkable rather than asserted: replay rebuilds every entity from the event log and produces one root hash that any party holding the same log can recompute.',
    })}

<section class="prose">
  <div class="wrap narrow">
    <h2>1 · Every change is an event</h2>
    <p>
      Nothing is edited in place. A command produces an event carrying the actor, the time, the hash before, the hash
      after, and a chain hash over its predecessor. A correction is a new event; the original stays visible. Insert,
      delete or alter anything and every chain hash after it changes.
    </p>

    <h2>2 · The catalogue is closed</h2>
    <p>
      ${f.ledgerEvents} event types, and no others. An event type with nothing able to emit it reads as capability while
      being unreachable — the project control standard once reported a missing daily site diary on every project because
      no command could write one. That is an invariant now: every event is either emitted, or named with the reason it
      is not.
    </p>

    <h2>3 · Authorisation is layered and fails closed</h2>
    <p>
      Role permissions, then OAuth2 scopes, then attribute rules on the record itself — lifecycle phase, data
      sensitivity, tenancy. A phase gate is evaluated from the ledger rather than asserted, so a command locked in
      Operations says which phase it needs. The browser holds no rule the API does not publish: the permission matrix
      and the phase gates are fetched, never duplicated.
    </p>

    <h2>4 · Replay proves it</h2>
    <p>
      Rebuild every entity from the log, verify each event independently, and emit a state root. Where your access
      policy withholds a record, the redaction is reported and the root still covers the complete record — so you can
      verify the chain is intact without being shown what you may not see.
    </p>

    <h2>5 · What leaves the platform is redacted by audience</h2>
    <p>
      An export is the one artefact that escapes every access control in the system, so redaction is the last
      enforcement point there is. A regulator's copy carries no forecast margin, and it says the commercial detail was
      withheld rather than showing an empty section — a silent redaction is indistinguishable from a project with no
      commercial data.
    </p>
  </div>
</section>

<section class="phases">
  <div class="wrap">
    <h2>Seven phases, one system</h2>
    <div class="phase-list">
      ${phases
        .map(
          ([name, body], i) => `<div class="phase">
        <div class="phase-n">${String(i + 1).padStart(2, '0')}</div>
        <div><h3>${esc(name!)}</h3><p>${esc(body!)}</p></div>
      </div>`,
        )
        .join('\n      ')}
    </div>
    <p class="note">No migration at handover, because there is nothing to migrate to.</p>
  </div>
</section>

${cta({
  title: 'Run it end to end',
  body: 'The demonstration takes one asset from concept to operations and then verifies its own chain.',
  primary: { href: '/get-started', label: 'Get started' },
  secondary: { href: '/developers', label: 'Read the API' },
})}`,
  );
}

// ----------------------------------------------------------------- Industries

export function industries(): string {
  return page(
    {
      title: 'Industries',
      description:
        'Building, civil infrastructure and specialised works run on one data model. Sector is an attribute of a project, never a separate code path.',
      path: '/industries',
    },
    `${pageHead({
      eyebrow: 'Product',
      title: 'One operating logic across every sector',
      standfirst:
        'Sector is an attribute of a project, not a product line. A tunnel and a fit-out differ in their work breakdown and their risk register — not in how a payment notice is reckoned or how evidence is chained.',
    })}

<section class="prose">
  <div class="wrap">
    ${cards(
      [
        {
          title: 'Building',
          tag: 'Residential · commercial · industrial · public',
          body:
            'Fit-out and superstructure packages, design responsibility matrices, and the Building Safety Regulator as a first-class read-only identity with a seat that costs nothing — a regulator holds an oversight relationship, not a customer one.',
        },
        {
          title: 'Civil and infrastructure',
          tag: 'Transport · utilities · energy',
          body:
            'Remeasurable works, statutory undertakers as a named delay cause, ground-condition risk carried explicitly, and NEC4 compensation events tracked against the notice clock rather than against a spreadsheet.',
        },
        {
          title: 'Specialised and operational',
          tag: 'Demolition · MEP · fit-out · facilities',
          body:
            'Short-cycle packages where the payment cycle bites hardest. The Construction Act engine computes the position — which notice established the notified sum, and what a missed one has already cost.',
        },
      ],
      3,
    )}
  </div>
</section>

<section class="prose">
  <div class="wrap narrow">
    <h2>Sized from sole trader to sovereign programme</h2>
    <p>
      Thresholds are proportionate rather than fixed. A £40,000 domestic extension and a £2bn programme both have a
      "material variation", and it is not the same number. The platform decides the scale band from the contract value
      and applies the thresholds that follow from it, in one place, rather than scattering magic numbers through the
      engines.
    </p>

    <h2>Jurisdiction is data, not a fork</h2>
    <p>
      UK statutory periods, bank holiday calendars across the three jurisdictions including the weekend substitution
      rules, and the Scheme for Construction Contracts defaults where a contract is silent. Currency and tax
      presentation are held per jurisdiction for display — what a figure is labelled and what an invoice must say — not
      to compute a liability, which turns on registration and place of supply.
    </p>
  </div>
</section>

${cta({
  title: 'Your sector, your thresholds',
  body: 'Start with the scale you actually work at rather than the one a template assumes.',
  primary: { href: '/get-started', label: 'Get started' },
  secondary: { href: '/contact', label: 'Talk to us' },
})}`,
  );
}

// ----------------------------------------------------------------------- Blog

type Post = { title: string; standfirst: string; date: string; tag: string };

/**
 * Posts are the engineering notes this project actually produced, not invented
 * thought leadership. Each one corresponds to work recorded in docs/STATE.md.
 */
const POSTS: Post[] = [
  {
    title: 'A pay less notice the platform said was overdue, and no way to give one',
    standfirst:
      'Building the Construction Act engine found the hole: the event existed, the position read it, and no command could emit one — so "pay in full" was the only advice the platform could ever offer.',
    date: '2026-07-02',
    tag: 'Engineering',
  },
  {
    title: 'Why a minor unit is not always a hundredth',
    standfirst:
      'Money in minor units is a correct decision. Dividing by 100 in five places is not: a yen has no minor unit and a dinar has three, so a JPY figure displayed a hundred times too small.',
    date: '2026-07-18',
    tag: 'Engineering',
  },
  {
    title: 'The clause that was never in the specification',
    standfirst:
      'Splitting a wrapped specification clause on newlines invented a hold point that did not exist. A register that gains a requirement nobody imposed is worse than one that misses it.',
    date: '2026-08-04',
    tag: 'Engineering',
  },
  {
    title: 'Writing a PDF by hand, and what it caught',
    standfirst:
      'Printing a web page is not an answer when the document carries a content hash. Building the writer found the report putting raw minor units in front of an adjudicator.',
    date: '2026-08-19',
    tag: 'Engineering',
  },
  {
    title: 'A demonstration route that handed out a working session',
    standfirst:
      'One console endpoint was public with no production gate and returned a PM access token to anyone who could reach the origin. Its sibling already carried the gate, which is what made it dangerous.',
    date: '2026-08-21',
    tag: 'Security',
  },
];

export function blog(): string {
  return page(
    {
      title: 'Blog',
      description:
        'Engineering notes from building a construction operating system — including the defects found along the way and what they cost.',
      path: '/blog',
    },
    `${pageHead({
      eyebrow: 'Company',
      title: 'Engineering notes',
      standfirst:
        'What we built, what broke, and what the break taught us. These are the real notes from the work — including the defects, because a changelog that only lists features is a marketing document.',
    })}

<section class="prose">
  <div class="wrap narrow">
    <div class="posts">
      ${POSTS.map(
        (post) => `<article class="post">
        <div class="post-meta"><span class="tag">${esc(post.tag)}</span><time datetime="${esc(post.date)}">${esc(
          new Date(`${post.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
        )}</time></div>
        <h3>${esc(post.title)}</h3>
        <p>${esc(post.standfirst)}</p>
      </article>`,
      ).join('\n      ')}
    </div>
    <p class="note">
      Posts are engineering notes rather than announcements, and there is no subscription form on this page — the
      weekly issue is role-targeted and sent from the product, where consent is recorded against the person.
    </p>
  </div>
</section>`,
  );
}

// ----------------------------------------------------------------- Developers

export function developers(): string {
  const f = facts();
  const sample = ROUTES.filter((r) => r.method === 'POST' && r.pattern.includes('/projects/:projectId/')).slice(0, 8);

  return page(
    {
      title: 'Developers',
      description:
        `${f.routes} endpoints over a command-and-query API. RFC 7807 problem+json, correlation ids on every response, idempotency keys on every command.`,
      path: '/developers',
    },
    `${pageHead({
      eyebrow: 'Product',
      title: 'The API is the product',
      standfirst:
        'The console talks to exactly the same public API as any other consumer. It holds no privileged path into the platform and is subject to the same roles, scopes and attribute rules.',
    })}

<section class="prose">
  <div class="wrap narrow">
    <h2>Shape</h2>
    <p>
      Command-and-query over project resources. <code>GET /v1/routes</code> lists every endpoint — ${f.routes} of them,
      ${f.publicRoutes} reachable without a credential — and that list is the documentation rather than a copy of it.
    </p>

    <div class="code-block"><pre><code>${sample
      .map((r) => `${esc(r.method.padEnd(5))} ${esc(r.pattern)}\n      ${esc(r.description)}`)
      .join('\n')}</code></pre></div>

    <h2>Errors</h2>
    <p>
      RFC 7807 <code>application/problem+json</code>, with per-field detail where a schema rejected the body. Every
      response carries <code>x-correlation-id</code> and <code>x-trace-id</code>, and a command accepts an
      <code>Idempotency-Key</code> so a retried request returns the original result rather than performing the state
      change twice.
    </p>

    <div class="code-block"><pre><code>{
  "type": "https://construx.ai/problems/access-denied",
  "title": "ACCESS_DENIED",
  "status": 403,
  "detail": "No role of PM holds \\"C\\" on PROJECT_SETUP",
  "traceId": "…",
  "correlationId": "…"
}</code></pre></div>

    <h2>Authentication</h2>
    <p>
      Bearer access tokens with a short lifetime and rotating refresh tokens, behind an MFA challenge. A public route
      may <em>begin</em> an authentication and never complete one — an invariant with a test behind it, because a
      demonstration endpoint once returned a working session to anonymous callers.
    </p>

    <h2>Communication events</h2>
    <p>
      ${f.commsEvents} notification events across ${f.commsCategories} categories, fanning out over email, in-app, SMS,
      push and WhatsApp. ${f.mandatoryNotices} of them are mandatory and override a recipient's preferences, because a
      person is entitled to be told their account was locked whatever they have muted.
    </p>

    <h2>What the API will not do</h2>
    <p>
      It will not tell you which project ids exist. An id that does not exist and one belonging to another tenancy both
      answer <code>200</code> with an empty list on the generic entity read — a <code>404</code> for unknown and a
      <code>403</code> for forbidden would together be an enumeration oracle. That behaviour is tested, so nobody
      "fixes" it.
    </p>
  </div>
</section>

${cta({
  title: 'Read the route table',
  body: 'Every endpoint, its method, its description and whether it needs a credential.',
  primary: { href: '/get-started', label: 'Get started' },
  secondary: { href: '/status', label: 'Platform status' },
})}`,
  );
}

// -------------------------------------------------------------------- Contact

export function contact(): string {
  return page(
    {
      title: 'Contact',
      description: 'Talk to us about a pilot, an enterprise agreement, security review or a support question.',
      path: '/contact',
    },
    `${pageHead({
      eyebrow: 'Company',
      title: 'Talk to us',
      standfirst: 'Four routes in, and they go to different people. Picking the right one is faster than a switchboard.',
    })}

<section class="prose">
  <div class="wrap">
    ${cards(
      [
        {
          title: 'Pilot and evaluation',
          tag: 'Sales',
          body:
            'A trial governs, records and computes; nothing leaves the platform until you are on a paid package. Start it yourself from <a href="/get-started">Get started</a> — no call required.',
        },
        {
          title: 'Enterprise agreement',
          tag: 'Sales',
          body:
            'Enterprise is provisioned with an agreement rather than a form, so there is no self-serve button for it. Tell us the programme, the jurisdictions and the identity count.',
        },
        {
          title: 'Security and assurance',
          tag: 'Security',
          body:
            'Architecture review, penetration testing windows, and questions about tenancy isolation, the permission model or the audit chain. Vulnerability reports are read the same day.',
        },
        {
          title: 'Support',
          tag: 'Support',
          body:
            'Signed-in customers raise a ticket from the console, where it arrives with the correlation id already attached — which is usually the difference between a fast answer and a slow one.',
        },
      ],
      2,
    )}
  </div>
</section>

<section class="prose">
  <div class="wrap narrow">
    <h2>Reaching a person</h2>
    <p>
      There is no contact form on this page, deliberately. A form that posts into a queue nobody has wired up is worse
      than an address, and this platform does not ship things that pretend to work. Until the enquiry pipeline is
      connected to a real inbox, the honest instruction is the one below.
    </p>
    <p class="callout">
      Write to <b>hello@construx.ai</b> and say which of the four above you are. If it is a security report, put
      <b>SECURITY</b> in the subject and it is triaged ahead of everything else.
    </p>
  </div>
</section>`,
  );
}

// ---------------------------------------------------------------- Get started

export function getStarted(): string {
  const types = accountTypes();

  return page(
    {
      title: 'Get started',
      description: 'Choose an account type and confirm your address. A trial governs, records and computes — nothing leaves the platform.',
      path: '/get-started',
    },
    `${pageHead({
      eyebrow: 'Product',
      title: 'Start in about a minute',
      standfirst:
        'Pick the package, confirm your address, and you are the administrator of your own tenancy. No card, no call, no sales qualification step.',
    })}

<section class="prose">
  <div class="wrap">
    <div class="plans">
      ${types
        .map(
          (t) => `<article class="plan${t.package === 'CORE_PROJECT' ? ' featured' : ''}">
        ${t.package === 'CORE_PROJECT' ? '<span class="plan-flag">Most chosen</span>' : ''}
        <h3>${esc(t.label)}</h3>
        <p class="plan-for">${esc(t.targetCustomer)}</p>
        <div class="plan-price">${
          t.monthlyPriceMinor === 0
            ? '<b>Free</b>'
            : `<b>${esc(formatMoney(t.monthlyPriceMinor, 'GBP'))}</b><span>/month</span>`
        }</div>
        <ul class="plan-list">
          <li>${t.includedSeats === null ? 'Unlimited identities' : `${t.includedSeats} identities included`}</li>
          <li>${t.storageGb >= 1000 ? `${(t.storageGb / 1000).toFixed(t.storageGb % 1000 === 0 ? 0 : 1)} TB storage` : `${t.storageGb} GB storage`}</li>
          <li>${
            t.aiAllowanceAcus > 0
              ? `<b>${t.aiAllowanceAcus.toLocaleString('en-GB')} ACUs</b> of AI included each month`
              : `${config.billing.freeTrialGrantMinor.toLocaleString('en-GB')} trial ACUs, once`
          }</li>
          <li class="${t.export ? 'yes' : 'no'}">${t.export ? 'Branded export and print' : 'No export or print'}</li>
          <li class="${t.apiAccess ? 'yes' : 'no'}">${t.apiAccess ? 'API access' : 'No API access'}</li>
        </ul>
        ${
          t.selfServe
            ? `<a class="btn${t.package === 'CORE_PROJECT' ? '' : ' ghost'}" href="/app/signup?package=${esc(t.package)}">Start with ${esc(t.label)}</a>`
            : '<a class="btn ghost" href="/contact">Talk to us</a>'
        }
      </article>`,
        )
        .join('\n      ')}
    </div>
  </div>
</section>

<section class="prose">
  <div class="wrap narrow">
    <h2>How AI is paid for</h2>
    <p>
      Every plan credits <b>${config.billing.subscriptionAcuAllocationPercent}% of what you pay</b> to your AI wallet
      each month. £1 buys 100 ACUs, so a £950 plan includes £285 — 28,500 ACUs — of AI. Model usage is charged at
      ${config.billing.markupMultiplier}× what the provider charges us, and every action tells you its price before
      you run it.
    </p>
    <p>
      <b>When the ACUs run out, AI stops.</b> Not a warning, not an overdraft, not a surprise line on next month's
      invoice — the work is refused and the platform says why. Every AI action is priced before you press the button,
      from what that action has actually cost on your account rather than from a list price, and you can set a monthly
      cap per account or per project that halts spend at a number you chose.
    </p>
    <p>
      Top up whenever you want more. Unused allowance is exactly what it looks like: credit on the account, recorded
      as its own entry so an invoice can tell an allowance from a purchase.
    </p>

    <h2>What a trial does and does not include</h2>
    <p>
      A trial governs, records and computes — the whole product minus the thing you would take to a client. Every
      engine runs, the chain verifies, the permission model applies. What a trial cannot do is export or print, and the
      platform says so in commercial terms rather than returning a permission error that would send you to your
      administrator.
    </p>
    <p>
      Two roles are exempt from that limit and the second is the one that matters. A regulator's export is an access the
      asset owner is obliged to provide, so refusing it on the contractor's subscription would be this platform
      enforcing a commercial term against a statutory right. It does not get to make that trade.
    </p>

    <h2>What happens when you press the button</h2>
    <ol class="steps">
      <li>You give an address, a name, an organisation and a jurisdiction.</li>
      <li>We send a link. Nothing exists yet — no tenancy, no seat, no billing record.</li>
      <li>You follow the link. That is the point the tenancy is created and you become its administrator.</li>
      <li>You sign in normally, with MFA. Confirming an address produces an account, never a session.</li>
    </ol>
    <p class="note">
      Registering an address that already has an account looks identical from the outside — we will not tell a stranger
      which addresses are customers. The owner of the address is told by email either way.
    </p>
  </div>
</section>`,
  );
}

// ------------------------------------------------------ Growth & Influencers

export function growth(): string {
  return page(
    {
      title: 'Growth & Influencers',
      description:
        'Referral, partner and creator programmes for people who work in construction and write about it honestly.',
      path: '/growth',
    },
    `${pageHead({
      eyebrow: 'Company',
      title: 'Growth, partners and creators',
      standfirst:
        'We would rather be recommended by twenty quantity surveyors who use the product than by one influencer who has not opened it.',
    })}

<section class="prose">
  <div class="wrap">
    ${cards(
      [
        {
          title: 'Referral',
          tag: 'For customers',
          body:
            'Introduce a contractor who takes a paid package and both accounts receive credit against their subscription. Recorded against the account, not paid as cash, so it never becomes an inducement somebody has to declare.',
        },
        {
          title: 'Implementation partners',
          tag: 'For consultancies',
          body:
            'Project controls and commercial consultancies who set the platform up inside a client. Partner tenancies get sandbox environments and the same API as everybody else — there is no partner-only endpoint.',
        },
        {
          title: 'Creators and educators',
          tag: 'For writers',
          body:
            'If you teach NEC4, JCT, planning or quantity surveying, we will give you an account and answer your questions on the record. We will not ask for approval over what you publish.',
        },
      ],
      3,
    )}
  </div>
</section>

<section class="prose">
  <div class="wrap narrow">
    <h2>The rules we hold ourselves to</h2>
    <ul class="rules">
      <li><b>Disclosure is not optional.</b> Anything we pay for or provide free is disclosed by the person publishing it. If a platform asks you to hide the relationship, that tells you what the product is worth.</li>
      <li><b>No approval rights over criticism.</b> We do not review copy before publication and do not withdraw access over a bad review. We will correct a factual error and say so publicly.</li>
      <li><b>No fabricated metrics.</b> We will not supply a figure the platform does not measure, and we would rather give you a smaller true number than a large invented one.</li>
      <li><b>Customer data never leaves.</b> No case study quotes a real project's figures without the asset owner's written agreement, and the export redaction rules apply to anything we are given.</li>
    </ul>

    <h2>What is not built yet</h2>
    <p class="callout">
      The referral credit above is a stated commercial intent, not a shipped mechanism — there is no self-serve referral
      code in the product today and it is applied by hand. It is written here as the policy rather than as a feature so
      that nobody signs up expecting a dashboard that does not exist.
    </p>
  </div>
</section>

${cta({
  title: 'Come and break it',
  body: 'The most useful thing a creator can do with this product is try to make it say something untrue.',
  primary: { href: '/contact', label: 'Get in touch' },
  secondary: { href: '/get-started', label: 'Start an account' },
})}`,
  );
}

// ------------------------------------------------------------ Legal documents

/** Shared shell for the legal pages, so they cannot drift apart in structure. */
function legal(meta: { title: string; description: string; path: string; updated: string }, body: string): string {
  return page(
    { title: meta.title, description: meta.description, path: meta.path },
    `${pageHead({ eyebrow: 'Legal', title: meta.title, standfirst: meta.description })}
<section class="prose legal">
  <div class="wrap narrow">
    <p class="updated">Last updated ${esc(meta.updated)}</p>
    ${body}
    <p class="note">
      This document describes how the platform behaves. Where it states a technical guarantee — chaining, redaction,
      tenancy isolation, notice handling — that behaviour is implemented and tested, and the corresponding test is the
      thing that keeps this page true.
    </p>
  </div>
</section>`,
  );
}

const UPDATED = '21 August 2026';

export function terms(): string {
  return legal(
    {
      title: 'Terms of Service',
      description: 'The terms on which CONSTRUX.AI is provided, and the limits of what it does.',
      path: '/terms',
      updated: UPDATED,
    },
    `<h2>1. What the service is</h2>
    <p>
      CONSTRUX.AI records project state as an append-only, hash-chained event log and computes engineering and
      commercial positions from it. It is a record and a calculation engine. It is not legal advice, not a substitute
      for a contract administrator, and not a guarantee of any commercial outcome.
    </p>

    <h2>2. What the calculations are and are not</h2>
    <p>
      Statutory positions — payment cycles, notice deadlines, adjudication timetables — are computed from the dates and
      terms you supply, against the rules in force for the jurisdiction you select. If the inputs are wrong, the output
      is wrong. Where the platform lacks a fact it does not invent one: no exchange rate is assumed, no interest rate is
      supplied, and a figure that depends on an unpublished rate appears in its own currency with the reason.
    </p>

    <h2>3. Your account and your people</h2>
    <p>
      The administrator of a tenancy controls who holds an identity in it and what each may do. Seats are consumed by
      identities, not by logins. A platform operator identity and a regulator identity consume no seat, and the operator
      is barred from customer delivery data by the permission model rather than by policy.
    </p>

    <h2>4. Packages and what they include</h2>
    <p>
      What each package includes is stated on <a href="/get-started">Get started</a> and enforced by the product. A
      trial governs, records and computes and cannot export or print. Where a limit applies, the platform states it in
      commercial terms rather than as a permission failure.
    </p>

    <h2>5. AI usage and charging</h2>
    <p>
      AI actions are charged in ACUs against the provider cost actually incurred, at the published multiplier. No
      provider is called on an empty wallet, and no charge is made without a corresponding ledger entry. Before an
      action runs, its cost is quoted from what that action has actually cost on your account — where it has never run,
      the quote says so and states the provider's floor rather than presenting a floor as a forecast.
    </p>
    <p>
      No AI agent holds a mandate above <code>PROPOSE</code>. Every governance decision is taken by a person, and the
      event catalogue refuses AI authorship on decision events.
    </p>

    <h2>6. Your data</h2>
    <p>
      Your project record is yours. It is held in your tenancy, isolated on every read, and exportable in full on a
      package that includes export. We do not use your project data to train models. See the
      <a href="/privacy">Privacy Policy</a> for what we hold and why.
    </p>

    <h2>7. The record is append-only</h2>
    <p>
      This is a feature with a consequence you should understand before you rely on it. Nothing is edited in place and
      nothing is deleted; a correction is a new event and the original stays visible. That is what makes the record
      evidence. It also means a value entered incorrectly is corrected rather than erased, and the incorrect entry
      remains part of the chain.
    </p>

    <h2>8. Availability</h2>
    <p>
      Availability commitments are set in an enterprise agreement where one exists. On self-serve packages the service
      is provided as-is, and current state is published on <a href="/status">Platform status</a>.
    </p>

    <h2>9. Ending the relationship</h2>
    <p>
      You may close a tenancy at any time. On closure you may export the complete record while the tenancy is still
      live — export first, then close, because the export entitlement goes with the package.
    </p>`,
  );
}

export function privacy(): string {
  return legal(
    {
      title: 'Privacy Policy',
      description: 'What personal data the platform holds, why, and what it will never do with it.',
      path: '/privacy',
      updated: UPDATED,
    },
    `<h2>What we hold</h2>
    <p>
      For each identity: a name, an email address, the roles held, and the tenancy. Optionally a mobile number, where
      one has been given for notices that ride SMS. Nothing else about a person is required to use the product.
    </p>

    <h2>What the record contains about people</h2>
    <p>
      Every event names its actor, because an audit record that cannot say who did something is not an audit record.
      That attribution is the point of the system and cannot be switched off. It is visible to those in your tenancy
      whose role permits it, and to nobody outside it.
    </p>

    <h2>Communication</h2>
    <p>
      The platform sends across email, in-app, SMS and push. Most of it is subject to your preferences, which you set
      per category and per channel. A defined set of notices is not: security events, payment failures, compliance
      breaches, and data-protection notices such as a deletion request. You are entitled to be told your account was
      locked whatever you have muted, and a preference control that could suppress that would be a control that harms
      you.
    </p>
    <p>
      Marketing mail is separate and consent-based, with a working unsubscribe on every message and a permanent
      withdrawal until you re-subscribe. Mandatory notices carry no unsubscribe link, because an unsubscribe that
      cannot work is worse than none.
    </p>

    <h2>What we do not do</h2>
    <ul class="rules">
      <li>We do not sell personal data, and we do not share it with advertisers.</li>
      <li>We do not train models on your project data.</li>
      <li>We do not use geolocation to decide what language to show you — that asks where somebody is standing to answer what they read, and is wrong for every expatriate engineer on a project.</li>
      <li>We do not send project figures by email. The weekly issue is role-targeted, not data-personalised, because a message leaves the platform's access controls behind the moment it is sent.</li>
    </ul>

    <h2>Your rights</h2>
    <p>
      You can request an export of the personal data we hold about you, and its deletion. Deletion of an identity
      removes the person's contact details and credentials. It does not rewrite the event chain, because doing so would
      destroy the integrity of a record other parties rely on — the events retain an actor reference, and the person
      behind it is no longer resolvable.
    </p>

    <h2>Sub-processors</h2>
    <p>
      Email is delivered through an SMTP relay you can see named in your own delivery log. AI actions are executed by
      the provider recorded on the event, with the model class and cost. Every channel that has no provider configured
      records as dispatched-not-transmitted rather than as delivered.
    </p>`,
  );
}

export function policies(): string {
  const items = [
    ['Terms of Service', '/terms', 'The terms on which the service is provided.'],
    ['Privacy Policy', '/privacy', 'What personal data is held, why, and what is never done with it.'],
    [
      'Acceptable use',
      '/policies',
      'No unlawful content, no attempts to reach another tenancy, no automated traffic that degrades the service for others. Security testing against your own tenancy is welcome — tell us first.',
    ],
    [
      'Security disclosure',
      '/policies',
      'Report a vulnerability to hello@construx.ai with SECURITY in the subject. We will not pursue anybody acting in good faith within their own tenancy, and we will credit you unless you ask us not to.',
    ],
    [
      'Data retention',
      '/policies',
      'The event chain is retained for the life of the tenancy. Notification delivery records are retained because "we told you on the 14th" must stay answerable. Bounded operational logs rotate and are never the source of a metric.',
    ],
    [
      'Sub-processors',
      '/policies',
      'The SMTP relay, and the AI providers named on each AI event with model class and cost. Any channel with no provider configured records as dispatched-not-transmitted.',
    ],
    [
      'AI usage',
      '/policies',
      'No agent mandate above PROPOSE. Governance decisions refuse AI authorship at the catalogue level. Costs are quoted before an action runs and charged against the wallet with a ledger entry.',
    ],
    [
      'Accessibility',
      '/policies',
      'Semantic markup and keyboard focus are in place. Neither has been audited against WCAG, and we will not claim conformance we have not tested.',
    ],
  ];

  return legal(
    {
      title: 'All policies',
      description: 'Every policy in one place, including the ones that say what has not been done.',
      path: '/policies',
      updated: UPDATED,
    },
    `<p>
      Everything that governs how the platform is run and used. Where a policy describes something not yet built, it
      says so rather than being written in the present tense.
    </p>
    <dl class="policy-list">
      ${items
        .map(
          ([title, href, body]) =>
            `<dt><a href="${esc(href!)}">${esc(title!)}</a></dt><dd>${esc(body!)}</dd>`,
        )
        .join('\n      ')}
    </dl>`,
  );
}

// ------------------------------------------------------------ Platform status

export function status(input: {
  uptimeSeconds: number;
  health: { status: string; checks?: Array<{ name: string; status: string; detail?: string }> };
  channels: Array<{ channel: string; wired: boolean; transport: string }>;
}): string {
  const ok = input.health.status === 'ok' || input.health.status === 'ready';
  const hours = Math.floor(input.uptimeSeconds / 3600);
  const minutes = Math.floor((input.uptimeSeconds % 3600) / 60);

  return page(
    {
      title: 'Platform status',
      description: 'Live status read from the running process, including which delivery channels have a carrier behind them.',
      path: '/status',
    },
    `${pageHead({
      eyebrow: 'Legal',
      title: 'Platform status',
      standfirst:
        'Read from the running process at the moment you loaded this page. There is no historical uptime figure here because the platform does not yet measure one, and a hard-coded 99.9% would be a decoration.',
    })}

<section class="prose">
  <div class="wrap narrow">
    <div class="status-banner ${ok ? 'ok' : 'bad'}">
      <span class="dot"></span>
      <div>
        <b>${ok ? 'All systems operational' : 'Degraded'}</b>
        <span>This process has been up for ${hours}h ${minutes}m.</span>
      </div>
    </div>

    <h2>Components</h2>
    <table class="status-table">
      <thead><tr><th>Component</th><th>State</th><th>Detail</th></tr></thead>
      <tbody>
        ${(input.health.checks ?? [])
          .map(
            (check) =>
              `<tr><td>${esc(check.name)}</td><td><span class="pill ${
                check.status === 'ok' || check.status === 'up' ? 'ok' : 'warn'
              }">${esc(check.status)}</span></td><td>${esc(check.detail ?? '—')}</td></tr>`,
          )
          .join('\n        ')}
      </tbody>
    </table>

    <h2>Delivery channels</h2>
    <p>
      A channel is "wired" when the engine can route to it <em>and</em> a carrier is configured. A channel with no
      carrier records what it dispatched and states that nothing was transmitted, rather than reporting a delivery it
      did not make.
    </p>
    <table class="status-table">
      <thead><tr><th>Channel</th><th>Carrier</th><th>Transport</th></tr></thead>
      <tbody>
        ${input.channels
          .map(
            (c) =>
              `<tr><td>${esc(c.channel.toLowerCase())}</td><td><span class="pill ${
                c.wired ? 'ok' : 'warn'
              }">${c.wired ? 'configured' : 'none'}</span></td><td><code>${esc(c.transport)}</code></td></tr>`,
          )
          .join('\n        ')}
      </tbody>
    </table>

    <h2>What this page does not tell you</h2>
    <p class="callout">
      There is no incident history, no per-region breakdown and no rolling availability percentage, because none of
      those are measured yet. When they are, they will appear here with the measurement behind them. Until then this
      page reports exactly what the process can answer for.
    </p>
  </div>
</section>`,
  );
}

/** Path → renderer, for the router and for the test that walks every page. */
export const PAGE_PATHS = SITE_PAGES.map((p) => p.path);
