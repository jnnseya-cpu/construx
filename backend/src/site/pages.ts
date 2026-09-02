import { esc } from '../messaging/render.ts';
import { PACKAGES } from '../billing/seats.ts';
import type { ExposurePosition } from './exposure.ts';
import { config } from '../config.ts';
import { formatMoney } from '../domain/locale.ts';
import { NOTIFICATION_EVENTS, CATEGORIES } from '../notifications/catalogue.ts';
import { EVENT_TYPES } from '../goldenthread/eventTypes.ts';
import { ROUTES } from '../api/routes.ts';
import { accountTypes } from '../identity/signup.ts';
import { absolute, cards, cta, jsonLd, organisation, page, pageHead, SITE_PAGES } from './layout.ts';
import { POSTS, longDate } from './posts.ts';
import { publishedPost, publishedPosts } from './blog.ts';
import type { Platform } from '../platform.ts';

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
        'CONSTRUX is a construction operating system built around one idea: the record of how an asset came to exist should be evidence, not an afterthought.',
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

/** One post, at its own address. Unknown slugs never reach here — there is no route for them. */
export function blogPost(slug: string, platform?: Platform): string {
  const fixed = POSTS.find((candidate) => candidate.slug === slug);

  // Two sources, and they are not equally trusted.
  //
  // A post in `POSTS` is markup written into this repository by hand, and its
  // paragraphs carry deliberate `<code>` and `<em>`. A post in the ledger was
  // drafted by a model or typed into a form, and putting either into the page
  // unescaped would be a script tag away from an injection on the company's own
  // domain — published, indexed and served to strangers. So the stored ones are
  // escaped and the compiled ones are not, which is the difference between
  // trusted markup and untrusted text stated in code rather than assumed.
  const stored = !fixed && platform?.ledger ? publishedPost(platform, slug) : undefined;
  const post = fixed
    ? { ...fixed, paragraphs: fixed.body, date: fixed.date }
    : stored
      ? { ...stored, paragraphs: stored.body.map((line) => esc(line)), date: (stored.publishedAt ?? '').slice(0, 10) }
      : undefined;

  if (!post) throw new Error(`No post ${slug}`);

  return page(
    {
      title: post.title,
      // The standfirst is already the one-sentence version of the post, which
      // is exactly what a search result and a link preview want. Writing a
      // second summary would give two answers to one question.
      description: post.standfirst,
      path: `/blog/${post.slug}`,
      type: 'article',
      published: post.date,
      // A post presented as an untyped page is a page. Declared as a
      // BlogPosting it can appear as an article in a result, with its date, and
      // the headline is what gets shown rather than the browser tab title.
      jsonLd: jsonLd({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: post.title,
        description: post.standfirst,
        datePublished: post.date,
        url: absolute(`/blog/${post.slug}`),
        mainEntityOfPage: { '@type': 'WebPage', '@id': absolute(`/blog/${post.slug}`) },
        image: absolute('/landing-hero.png'),
        publisher: organisation(),
        author: organisation(),
        articleSection: post.tag,
      }),
    },
    `${pageHead({ eyebrow: post.tag, title: post.title, standfirst: post.standfirst })}

<section class="prose">
  <div class="wrap narrow">
    <p class="post-date"><time datetime="${esc(post.date)}">${esc(longDate(post.date))}</time></p>
    ${post.paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n    ')}
    <p class="note"><a href="/blog">← All engineering notes</a></p>
  </div>
</section>`,
  );
}


export function blog(platform?: Platform): string {
  // Newest first across both sources, so a post published this morning is not
  // buried under one compiled in last year.
  //
  // Guarded on the ledger rather than on the platform: these renderers are
  // called with a stub in the tests that walk every public page, and a site
  // that cannot reach a ledger has no stored posts — it still has the six in
  // the build, and rendering those is the right answer rather than an error.
  const entries = [
    ...POSTS.map((post) => ({ slug: post.slug, title: post.title, standfirst: post.standfirst, tag: post.tag, date: post.date })),
    ...(platform?.ledger ? publishedPosts(platform) : []).map((post) => ({
      slug: post.slug,
      title: post.title,
      standfirst: post.standfirst,
      tag: post.tag,
      date: (post.publishedAt ?? '').slice(0, 10),
    })),
  ].sort((a, b) => b.date.localeCompare(a.date));

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
      ${entries.map(
        (post) => `<article class="post">
        <div class="post-meta"><span class="tag">${esc(post.tag)}</span><time datetime="${esc(post.date)}">${esc(
          longDate(post.date),
        )}</time></div>
        <h3><a href="/blog/${esc(post.slug)}">${esc(post.title)}</a></h3>
        <p>${esc(post.standfirst)}</p>
        <p class="post-more"><a href="/blog/${esc(post.slug)}">Read the note <span aria-hidden="true">→</span></a></p>
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
  "type": "https://construxvg.com/problems/access-denied",
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
      Write to <b>contact@construxvg.com</b> and say which of the four above you are. If it is a security report, put
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
          <li>${
            t.includedSeats === null
              ? 'Unlimited identities'
              : `${t.includedSeats} identit${t.includedSeats === 1 ? 'y' : 'ies'} included`
          }</li>
          <li>${t.storageGb >= 1000 ? `${(t.storageGb / 1000).toFixed(t.storageGb % 1000 === 0 ? 0 : 1)} TB storage` : `${t.storageGb} GB storage`}</li>
          <li>${
            t.aiAllowanceAcus > 0
              ? `<b>${t.aiAllowanceAcus.toLocaleString('en-GB')} ACUs</b> of AI included each month`
              : `${config.billing.freeTrialGrantMinor.toLocaleString('en-GB')} trial ACUs, once`
          }</li>
          <li>${
            t.monthlyPriceMinor === 0
              // A material term rather than small print: the trial is one per
              // account and it stops after thirty days. Saying so on the card is
              // the difference between an expiry and a surprise.
              ? 'One trial per account, 30 days'
              : 'Monthly rolling, cancel any time'
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
      Every plan includes an AI allowance each month, and you can top it up whenever you want more. The arithmetic
      behind it matters far less than the guarantee around it: <b>nothing is ever spent without being shown to you
      first</b>.
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
      description: 'The terms on which CONSTRUX is provided, and the limits of what it does.',
      path: '/terms',
      updated: UPDATED,
    },
    `<h2>1. What the service is</h2>
    <p>
      CONSTRUX records project state as an append-only, hash-chained event log and computes engineering and
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
      'Report a vulnerability to contact@construxvg.com with SECURITY in the subject. We will not pursue anybody acting in good faith within their own tenancy, and we will credit you unless you ask us not to.',
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

// ----------------------------------------------------------------------- Demo

/**
 * What each seeded identity will actually show somebody.
 *
 * Deliberately not the role code. `QAQC`, `SUPERVISOR` and `FM` mean something
 * to the permission matrix and nothing to a stranger who has not seen the
 * product yet — "are you the BIM Manager?" is unanswerable before you know what
 * a BIM Manager sees here. Each line answers the question somebody actually
 * has, which is *what will I be looking at*.
 *
 * Keyed by role rather than by address, so the seed can rename a person without
 * silently dropping them to the fallback.
 */
const DEMO_ROLES: Record<string, { lead: string; shows: string }> = {
  PM: {
    lead: 'The widest view of a live job',
    shows:
      'Programme against baseline, the cost position, what is blocking site this week, and the stage gate that decides whether the next phase may open.',
  },
  QS: {
    lead: 'The money, and what the contract says about it',
    shows:
      'Valuations, variations, the payment cycle under the Construction Act, and what the platform refuses to certify twice.',
  },
  PLANNER: {
    lead: 'Time, and the probability of hitting it',
    shows: 'The critical path, a Monte Carlo completion forecast, the lookahead, and PPC against what was promised.',
  },
  OWNER: {
    lead: 'The client’s own view',
    shows: 'What has been spent, what has been proved, and what the record says without asking the contractor for it.',
  },
  SAFETY: {
    lead: 'The duties somebody is legally answerable for',
    shows: 'Permits, method statements, inductions, incidents, and the CDM duty set with what is outstanding against each.',
  },
  BIM: {
    lead: 'Design coordination as a record rather than a meeting',
    shows: 'Federated model revisions, clash runs, and a clash closed out with the evidence attached to the closure.',
  },
  DESIGNER: {
    lead: 'Design information under control',
    shows: 'Packages, deliverables, RFIs raised off a drawing revision, and what freezing a package actually stops.',
  },
  CONSTRUCTION_MANAGER: {
    lead: 'Running the site',
    shows:
      'Permits issued and method statements approved, the traffic management plan for a job in a live carriageway, ' +
      'the week sequenced against the lookahead, and inspections accepted. The seat between the programme and the ' +
      'people doing the work — start on the Rossendale project, which is the one on site.',
  },
  SUPERVISOR: {
    lead: 'The site, from the site',
    shows: 'Daily diaries, progress against measure, observations, and what happens to a record captured with no signal.',
  },
  QAQC: {
    lead: 'Whether it was built the way it was specified',
    shows: 'Inspection and test plans, hold points witnessed rather than asserted, and non-conformances through to closure.',
  },
  FM: {
    lead: 'The asset after everybody has left',
    shows: 'The operations record assembled from what was already captured, and maintenance forecast against the asset it describes.',
  },
  ENTERPRISE_ADMIN: {
    lead: 'Running the tenancy itself',
    shows: 'People and seats, roles and policy, portfolio structure, AI budget, and the identity every document goes out under.',
  },
  REGULATOR: {
    lead: 'What an outside party is shown',
    shows: 'A read-only view with export redaction applied by audience. The interesting part is what is withheld, and that the page says so.',
  },
};

const roleCopy = (role: string) => DEMO_ROLES[role];

/** One identity, as a card somebody can press. */
function identityCard(identity: { name: string; email: string; roles: readonly string[] }): string {
  const role = identity.roles[0] ?? '';
  const copy = roleCopy(role);
  return `<article class="card demo-card">
    <span class="tag">${esc(role.replace(/_/g, ' ').toLowerCase())}</span>
    <h3>${esc(copy?.lead ?? identity.name)}</h3>
    <p>${esc(copy?.shows ?? 'Signs in on the seeded programme.')}</p>
    <p class="muted"><code>${esc(identity.email)}</code></p>
    <a class="btn" href="/app?as=${encodeURIComponent(identity.email)}">Sign in as ${esc(identity.name)} <span aria-hidden="true">→</span></a>
  </article>`;
}

export type DemoInput = {
  available: boolean;
  /**
   * Why not, when not. Two different sentences: an operator switched the
   * sandbox off, which is a decision and the right one beside real customer
   * records; or it is switched on and the programme is not there, which is a
   * fault. Telling somebody a setting is off when it is on wastes the time of
   * whoever goes to check it.
   */
  unavailableBecause: 'SWITCHED_OFF' | 'NOT_SEEDED';
  /** The seeded programme's identities, if the demonstration is offered. */
  seeded: { name: string; email: string; roles: readonly string[] }[];
  /** The empty workspace's three seats. */
  clean: { name: string; email: string; roles: readonly string[]; purpose: string }[];
  programme: string;
  /** Slots, grouped by day, for the booking form. */
  availability: {
    minutes: number;
    days: { date: string; label: string; slots: { startsAt: string; label: string }[] }[];
    note: string;
  };
  /** Set after a successful booking, so the page can confirm it. */
  booked?: { reference: string; startsAt: string; minutes: number; email: string };
  /** Set when a booking was refused, so the reason is shown on the form. */
  bookingError?: string;
};

/**
 * The demonstration, and the booking.
 *
 * It lived at the bottom of the sign-in screen, which got it wrong in both
 * directions: nobody browsing the site ever reaches `/app`, so the strongest
 * thing here — a seeded programme carried concept to operations that anybody
 * can walk through — was behind a login; and every real customer signing in had
 * to scroll past twelve fictional people to reach the form.
 *
 * A page rather than a section of the landing page, because it is a link
 * somebody sends: into an email, a deck, a post. Not folded into
 * `/get-started`, because that is the signup form and somebody who wants to look
 * before signing up is a different person at a different moment — merging them
 * makes the demonstration compete with the conversion.
 *
 * **Two ways in, because there are two questions.** The seeded programme answers
 * "what does a finished record look like". The empty workspace answers "what is
 * it like to put something in", which a tenancy with eleven stages already done
 * cannot: every screen on it is full.
 *
 * **The booking form works with scripting disabled.** Slots are rendered as
 * radio buttons and the form posts to this same path — the site's one script
 * opens the mobile menu and nothing else, and a booking form that needed
 * JavaScript would be the first thing on it that did.
 */
/** Days shown open on the form. The rest fold into a disclosure below them. */
const DAYS_SHOWN = 3;

export function demo(input: DemoInput): string {
  const f = facts();
  const { availability } = input;

  // Declared once and used in both halves of the slot list, so a day inside the
  // disclosure and a day above it are the same markup. `checked` is decided by
  // the slot's own time rather than by its index, because the second half is
  // rendered from a sliced array and index 0 occurs twice in it.
  const first = availability.days[0]?.slots[0]?.startsAt;
  const dayBlock = (day: DemoInput['availability']['days'][number]) => `<div class="demo-day">
          <h3>${esc(day.label)}</h3>
          <div class="demo-slots">
            ${day.slots
              .map(
                (slot) => `<label class="demo-slot">
              <input type="radio" name="startsAt" value="${esc(slot.startsAt)}" ${slot.startsAt === first ? 'checked' : ''} required>
              <span>${esc(slot.label)}</span>
            </label>`,
              )
              .join('')}
          </div>
        </div>`;

  const bookingSection = input.booked
    ? `<section class="prose" id="book">
  <div class="wrap">
    <div class="callout">
      <h2>Booked — ${esc(input.booked.reference)}</h2>
      <p>
        <b>${esc(input.booked.startsAt.slice(0, 16).replace('T', ' '))} UTC</b>, for ${input.booked.minutes} minutes.
        A confirmation is on its way to <b>${esc(input.booked.email)}</b>.
      </p>
      <p class="muted">
        Joining details follow separately from the person taking it. This platform integrates with no calendar and
        generates no meeting link — one that went nowhere would be worse than none — so the invitation comes from a
        human being rather than from here.
      </p>
    </div>
    <p>In the meantime, the instant accounts above need nothing from you.</p>
  </div>
</section>`
    : `<section class="prose" id="book">
  <div class="wrap">
    <h2>Book a live demo</h2>
    <p>
      The instant accounts above are usually all you need. If you would rather be walked through it,
      book ${availability.minutes} minutes with somebody — an online call, in English or French.
    </p>
    ${input.bookingError ? `<div class="callout bad"><p><b>That booking was not made.</b><br>${esc(input.bookingError)}</p></div>` : ''}
    ${
      availability.days.length === 0
        ? `<div class="callout"><p><b>Nothing is bookable at the moment.</b><br>
             Every slot inside the booking window is taken or has passed. <a href="/contact">Send a message</a> and
             somebody will find a time.</p></div>`
        : `<form method="post" action="/demo#book" class="demo-book">
      <fieldset>
        <legend>Pick a time</legend>
        <p class="muted">${esc(availability.note)}</p>
        ${availability.days.slice(0, DAYS_SHOWN).map(dayBlock).join('')}
        ${
          // The booking window is a fortnight and each day carries seven slots,
          // which is a hundred radio buttons on the page somebody is deciding
          // from. The rest fold into a native `<details>` rather than a script:
          // the whole form works with JavaScript switched off and this is the
          // one control that would have needed it. Every slot is still in the
          // markup, so nothing is hidden from a keyboard or a screen reader —
          // the browser opens the disclosure when focus lands inside it.
          availability.days.length > DAYS_SHOWN
            ? `<details class="demo-more">
          <summary>Later dates — ${availability.days.length - DAYS_SHOWN} more days</summary>
          ${availability.days.slice(DAYS_SHOWN).map(dayBlock).join('')}
        </details>`
            : ''
        }
      </fieldset>

      <fieldset>
        <legend>And who you are</legend>
        <label for="b-name">Your name</label>
        <input id="b-name" name="name" type="text" required minlength="2" maxlength="120" autocomplete="name">

        <label for="b-email">Email</label>
        <input id="b-email" name="email" type="email" required maxlength="254" autocomplete="email">

        <label for="b-org">Organisation</label>
        <input id="b-org" name="organisation" type="text" required minlength="2" maxlength="200" autocomplete="organization">
        <p class="muted">Twenty minutes goes further when whoever takes the call has looked you up first.</p>

        <label for="b-lang">Language</label>
        <select id="b-lang" name="language">
          <option value="EN">English</option>
          <option value="FR">Français</option>
        </select>

        <label for="b-about">What you want out of it <span class="muted">(optional, and the most useful box on this form)</span></label>
        <textarea id="b-about" name="about" rows="3" maxlength="2000"></textarea>
      </fieldset>

      <button class="btn lg" type="submit">Book it <span aria-hidden="true">→</span></button>
    </form>`
    }
  </div>
</section>`;

  return page(
    {
      title: 'Try CONSTRUX — instant demo accounts, or book 20 minutes',
      description:
        'Walk through a seeded infrastructure programme carried from concept to operations, start from an empty workspace, or book a twenty-minute guided session.',
      path: '/demo',
    },
    `${pageHead({
      eyebrow: 'Demonstration',
      title: 'Try it now, or have somebody walk you through it',
      standfirst:
        'No signup and no card. Sign in as any role on a sandbox tenancy — the platform enforces what each of them may see, exactly as it does for a customer.',
    })}

${
  input.available
    ? `<section class="prose">
  <div class="wrap">
    <h2>① Start from nothing — build it yourself</h2>
    <p>
      A working, empty workspace. Create the enterprise, the portfolio, a project, a programme, a cost plan and a risk
      register from scratch, and see what the platform asks of you at each step. This is the half a finished
      demonstration cannot show, because every screen on one is already full.
    </p>
    <div class="cards g3">
      ${input.clean
        .map(
          (seat) => `<article class="card demo-card">
        <span class="tag">${esc((seat.roles[0] ?? '').replace(/_/g, ' ').toLowerCase())}</span>
        <h3>${esc(seat.name)}</h3>
        <p>${esc(seat.purpose)}</p>
        <p class="muted"><code>${esc(seat.email)}</code></p>
        <a class="btn" href="/app?as=${encodeURIComponent(seat.email)}">Sign in as ${esc(seat.name)} <span aria-hidden="true">→</span></a>
      </article>`,
        )
        .join('')}
    </div>
    <p class="muted">
      Start as the administrator: on an empty tenancy it is the only seat that can create the structure the others
      need, and signing in as anybody else first means discovering that the hard way.
    </p>
  </div>
</section>

<section class="prose">
  <div class="wrap">
    <h2>② Loaded with a real programme — explore</h2>
    <p>
      <b>${esc(input.programme)}</b>, carried through every lifecycle stage: concept, design, tender, construction,
      commissioning, handover, operations. Nothing in it is a mock-up — every figure on every screen is computed from
      the same event chain a paying customer's would be, across ${f.ledgerEvents} event types and ${f.routes} routes.
    </p>
    <p>
      Twelve identities on the same programme, described here by what each one will put in front of you rather than by
      its role code, because a role code only means something once you have already seen the product.
    </p>
    <div class="cards g3">
      ${input.seeded.map(identityCard).join('')}
    </div>
  </div>
</section>

<section class="prose">
  <div class="wrap">
    <h2>What is real about it, and what is not</h2>
    ${cards(
      [
        {
          title: 'The platform is real',
          tag: 'Real',
          body:
            'Same code, same permission model, same event chain, same refusals. Nothing is stubbed and no screen is a screenshot. There are no passwords to hand out either — sign-in is a one-time code, and for these accounts the platform returns it rather than emailing an address nobody reads.',
        },
        {
          title: 'The AI is on',
          tag: 'Real',
          body:
            'Both workspaces carry prepaid credit, so the reasoning engine actually runs and the cost lands on a real meter you can watch. Where no provider is configured it says so and refuses to publish anything a model did not really write, rather than dressing up a stand-in.',
        },
        {
          title: 'The project is invented',
          tag: 'Seeded',
          body:
            'The programme, the people and the numbers are a fixture written to exercise every stage. They describe no real client and no real scheme.',
        },
        {
          title: 'It is a shared sandbox',
          tag: 'Shared',
          body:
            'Anybody may sign in, and what you write is visible to whoever looks next. Do not put anything into it you would not put on a postcard.',
        },
      ],
      2,
    )}
  </div>
</section>

${bookingSection}`
    : `<section class="prose">
  <div class="wrap">
    <div class="callout${input.unavailableBecause === 'NOT_SEEDED' ? ' bad' : ''}">
      ${
        input.unavailableBecause === 'SWITCHED_OFF'
          ? `<p>
        <b>The instant accounts are switched off on this deployment.</b><br>
        Somebody has set <code>DEMO_TENANCY_ENABLED=false</code>, which is the right setting for a deployment holding
        real customer records — a sandbox anybody can sign into does not belong beside them. Nothing is broken.
      </p>`
          : `<p>
        <b>The instant accounts are switched on and are not there.</b><br>
        The demonstration programme did not build on this deployment, so there is nothing to sign into. That is a
        fault rather than a setting, and it has been recorded. Booking below still works.
      </p>`
      }
    </div>
    <p>A guided session shows the same platform, and a trial gives you your own record in it.</p>
  </div>
</section>

${bookingSection}`
}

${cta({
  title: 'Or start your own record',
  body: 'A trial governs, records and computes from the first event. Nothing leaves the platform until you are on a paid package.',
  primary: { href: '/get-started', label: 'Start free' },
  secondary: { href: '/how-it-works', label: 'How verification works' },
})}`,
  );
}

/**
 * The exposure page: what the payment notice regime puts at stake, on the
 * visitor's own turnover.
 *
 * Every other page on this site argues from the product outwards. This one
 * argues from the reader's balance sheet inwards, which is the order a managing
 * director actually asks the questions in — "what does this get me" comes before
 * "how does it work", and a site that only answers the second is answering a
 * question nobody asked yet.
 *
 * A form POST rather than a script, for the same reason the booking form is:
 * the CSP admits no inline script, and putting the arithmetic in the browser
 * would put it in two places. `site/exposure.ts` holds it, is tested, and is the
 * only implementation.
 */
export function exposure(position?: ExposurePosition): string {
  const shown = position?.input ?? {
    turnover: 40_000_000,
    liveContracts: 8,
    applicationsPerMonth: 1,
    gapPercent: 8,
    retentionPercent: 5,
  };

  const field = (name: string, label: string, hint: string, value: number, step: string) =>
    `<label class="exposure-field">
       <span class="exposure-label">${esc(label)}</span>
       <span class="exposure-hint">${esc(hint)}</span>
       <input type="number" name="${esc(name)}" value="${esc(String(value))}" step="${esc(step)}" min="0" required>
     </label>`;

  const form = `<form method="post" action="/exposure" class="exposure-form">
      ${field('turnover', 'Annual turnover', 'In pounds. Group or division, whichever you are answering for.', shown.turnover, '1000')}
      ${field('liveContracts', 'Live contracts', 'Being applied against at any one time.', shown.liveContracts, '1')}
      ${field('applicationsPerMonth', 'Applications per contract, per month', 'One is the ordinary cycle.', shown.applicationsPerMonth, '0.25')}
      ${field('gapPercent', 'Applied-to-certified gap (%)', 'The typical difference between what you apply for and what is certified.', shown.gapPercent, '0.5')}
      ${field('retentionPercent', 'Retention (%)', 'Held against the works.', shown.retentionPercent, '0.5')}
      <button class="btn lg" type="submit">Show my position</button>
    </form>`;

  const result = position
    ? `<section class="prose">
  <div class="wrap">
    <h2 class="section-h">Your position</h2>
    <div class="exposure-lines">
      ${position.lines
        .map(
          (line) => `<article class="exposure-line${line.emphasis ? ' emphasis' : ''}">
        <div class="exposure-line-head">
          <span class="exposure-line-label">${esc(line.label)}</span>
          <b class="exposure-line-value">${esc(line.value)}</b>
        </div>
        <p class="exposure-line-meaning">${esc(line.meaning)}</p>
        <p class="exposure-line-working">${esc(line.working)}</p>
      </article>`,
        )
        .join('\n      ')}
    </div>

    <h3>What this page does not claim</h3>
    <ul class="exposure-not">
      ${position.notClaimed.map((limit) => `<li>${esc(limit)}</li>`).join('')}
    </ul>

    <div class="cta-row">
      <a class="btn lg" href="/demo">See it computed on a live £17.6M job</a>
      <a class="btn lg ghost" href="/get-started">Start free</a>
    </div>
  </div>
</section>`
    : '';

  return page(
    {
      title: 'What the payment notice regime puts at stake',
      description:
        'Arithmetic on your own turnover: how many payment windows you run a year, what passes through one, and what a ' +
        'single missed pay less notice is worth under s.111 of the Construction Act.',
      path: '/exposure',
    },
    `${pageHead({
      eyebrow: 'HGCRA 1996 · s.111',
      title: 'What one missed notice is worth',
      standfirst:
        'Where the payer gives no payment notice and no pay less notice in time, the sum applied for becomes payable in ' +
        'full — however optimistic the application was. Five figures of yours, and the arithmetic below is all yours too. ' +
        'There is no industry average anywhere on this page.',
    })}

<section class="prose">
  <div class="wrap narrow">
    ${form}
  </div>
</section>

${result}`,
  );
}
