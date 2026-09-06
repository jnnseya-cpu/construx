import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';
import { AGENTS } from '../src/agents/registry.ts';
import { DEMO_TENANCY } from '../src/seed.ts';
import { abbreviateMoney } from '../src/domain/locale.ts';
import { demo, developers, about, getStarted, policies, privacy, terms } from '../src/site/pages.ts';
import { demoInput, renderLanding } from '../src/site/index.ts';
import { sitemap } from '../src/site/discovery.ts';
import { config } from '../src/config.ts';

/**
 * The public site, against the product it describes.
 *
 * `pages.ts` opens by stating the rule this file exists to enforce: every
 * number on the marketing pages is read from the thing it describes, because
 * "marketing figures that drift from the product are the most common way a
 * site starts lying, and they drift silently because nobody tests prose".
 *
 * The rule held for the counts that were derived and did nothing for the ones
 * that were not, and an audit of every page found four that had drifted:
 *
 * - The demonstration was advertised as a **£17.6M** job, in a button, three
 *   times, against a project the seed builds at **£18.5M**. A visitor pressing
 *   "walk a live £17.6M job" landed on a project showing something else.
 * - The hero panel, introduced as "drawn to the shape of the real seeded
 *   project", carried a forecast margin and a delay exposure that appear
 *   nowhere in the seed, above a payment scenario — "application 14 at £1.42M"
 *   — asserted to run on the demonstration project, which builds three cycles
 *   and no such application.
 * - The demonstration page said **twelve** identities beside a list of
 *   **thirteen**.
 * - Four pages and the **Terms of Service** said no agent holds a mandate above
 *   `PROPOSE`, months after two agents were given an ACT ceiling.
 *
 * The last of those is why this file asserts on prose at all. A stale figure on
 * a landing page is embarrassing; the same drift inside a contractual term is a
 * different class of thing, and the only durable defence is a test that reads
 * the page and the product and refuses to let them disagree.
 *
 * Seeding once in `before` because the demonstration is the expensive fixture
 * here and every assertion below reads the same one.
 */

let platform: Platform;
let projectId: string;
let landing: string;

before(async () => {
  platform = new Platform();
  const seeded = await seedDemoProject(platform);
  projectId = seeded.projectId;
  landing = renderLanding();
});

/** The flagship project as the record holds it, not as the copy remembers it. */
function project(): Record<string, unknown> {
  const row = platform.ledger.list(projectId, 'Project')[0];
  assert.ok(row, 'the seed produced no project to check the site against');
  return row.state as unknown as Record<string, unknown>;
}

describe('the demonstration, as the site advertises it', () => {
  it('quotes the contract value the seed actually builds', () => {
    const minor = project().contractValueMinor as number;
    assert.equal(
      minor,
      DEMO_TENANCY.contractValueMinor,
      'the seed no longer builds the project at the value DEMO_TENANCY publishes',
    );

    // The figure as a reader sees it, through the platform's own formatter —
    // which is the point: one value, one formatter, so the button and the
    // project cannot disagree again.
    const shown = abbreviateMoney(minor, 'GBP');
    assert.ok(landing.includes(shown), `the landing page does not quote ${shown}`);
    assert.ok(
      !/£17\.6M/.test(landing),
      'the landing page still carries the £17.6M figure the seed disproves',
    );
  });

  it('names the project where it is and what it is', () => {
    const state = project();
    assert.equal(state.sectorType, DEMO_TENANCY.sector);
    assert.equal((state.location as { city: string }).city, DEMO_TENANCY.city);
  });

  it('counts the seeded identities rather than naming a number', () => {
    const input = demoInput(platform);
    assert.ok(input.seeded.length > 0, 'the demonstration seeded no identities to count');

    const page = demo(input);
    assert.ok(
      page.includes(`${input.seeded.length} identities on the same programme`),
      `the demonstration page does not say ${input.seeded.length} identities`,
    );
    assert.ok(!/Twelve identities/.test(page), 'the page still hardcodes "Twelve identities"');
  });

  it('tells the payment story with the seeded cycle’s own figures', () => {
    // The landing page's money section states these as the demonstration
    // project's, and invites the reader to open the cycle and read them. That
    // invitation is only honest while the two agree.
    const applications = platform.ledger
      .list(projectId, 'PaymentApplication')
      .map((row) => row.state as unknown as { cycleNumber: number; netAppliedMinor: number });
    const third = applications.find((application) => application.cycleNumber === 3);
    assert.ok(third, 'the seed no longer builds a third payment cycle');

    const certificates = platform.ledger
      .list(projectId, 'PaymentCertificate')
      .map((row) => row.state as unknown as { cycleNumber: number; certifiedMinor: number; withheldMinor: number });
    const certificate = certificates.find((entry) => entry.cycleNumber === 3);
    assert.ok(certificate, 'the seed no longer certifies the third cycle');

    const applied = (third.netAppliedMinor / 100).toLocaleString('en-GB');
    const certified = (certificate.certifiedMinor / 100).toLocaleString('en-GB');
    const withheld = (certificate.withheldMinor / 100).toLocaleString('en-GB');

    for (const figure of [applied, certified, withheld]) {
      assert.ok(landing.includes(figure), `the money section does not carry £${figure} from the seeded cycle`);
    }
    assert.ok(
      !/Application 14/.test(landing),
      'the landing page still describes an application the seed does not build',
    );
  });
});

describe('what the site says about the agent fleet', () => {
  const actEligible = () => AGENTS.filter((agent) => agent.mandate?.maxUnattended === 'ACT');

  it('never claims the whole fleet is capped at PROPOSE', () => {
    // The claim that made this file necessary. It sat in the Terms of Service,
    // which is the one page where a stale sentence is a term rather than a
    // typo.
    assert.ok(actEligible().length > 0, 'no agent is ACT-eligible, so this guard has nothing to protect');

    for (const [name, page] of [
      ['landing', landing],
      ['about', about()],
      ['terms', terms()],
      ['policies', policies()],
    ] as const) {
      assert.ok(
        !/whole fleet is capped/i.test(page),
        `${name} still says the whole fleet is capped at propose`,
      );
      assert.ok(
        !/no ai agent (?:in the system )?holds a mandate above/i.test(page),
        `${name} still claims no agent holds a mandate above PROPOSE`,
      );
    }
  });

  it('counts the fleet and the part of it that may act', () => {
    const page = about();
    assert.ok(page.includes(`${AGENTS.length} AI agents`), 'the about page does not count the fleet');
    assert.ok(
      page.includes(`${actEligible().length} of the ${AGENTS.length} may act`),
      'the about page does not say how many agents may act unattended',
    );
  });

  it('is only ever quoting agents whose envelope carries no money', () => {
    // The pages say the acting agents carry a value ceiling of zero. If that
    // stops being true the sentence has to change, so fail here rather than
    // let the page keep saying it.
    for (const agent of actEligible()) {
      assert.equal(
        agent.mandate.envelope?.valueCeilingMinor,
        0,
        `${agent.agentId} may act with a value ceiling above zero, which the public pages deny`,
      );
    }
  });
});

describe('the commercial terms the pages publish', () => {
  it('publishes the multiplier the Terms refer to', () => {
    // Terms section 5 charges "at the published multiplier". It was published
    // nowhere.
    assert.ok(/published multiplier/.test(terms()), 'the Terms no longer refer to a published multiplier');
    assert.ok(
      getStarted().includes(`<b>${config.billing.markupMultiplier}</b>`),
      'the pricing page does not publish the multiplier the Terms commit to',
    );
  });

  it('does not promise a signup with no card on a page that charges before it opens', () => {
    const page = getStarted();
    assert.ok(!/No card, no call/.test(page), 'the pricing page still promises "No card" for every package');
    assert.ok(
      /first month paid before the account opens/.test(page),
      'the pricing page no longer states when a paid account opens',
    );
  });

  it('gives each legal document its own date', () => {
    // One shared constant meant bumping the Terms restamped the Privacy Policy
    // as revised on a day nothing in it changed.
    for (const [name, page] of [['terms', terms()], ['privacy', privacy()], ['policies', policies()]] as const) {
      assert.ok(/Last updated \d/.test(page), `${name} carries no last-updated date`);
    }
  });
});

describe('what a crawler is told about', () => {
  it('lists the document verification page', () => {
    // The one page whose entire audience — an adjudicator, an insurer, a
    // client's solicitor — arrives from outside, and it was in no sitemap.
    const map = sitemap(platform);
    assert.ok(
      map.includes(`${config.publicBaseUrl.replace(/\/$/, '')}/verify-document</loc>`),
      'verify-document is missing from the sitemap',
    );
  });

  it('does not assert a platform state the footer cannot know', () => {
    // Every page carries the footer, and the footer had no platform to ask.
    assert.ok(
      !/All systems operational/.test(landing),
      'the footer still asserts every system is operational on a page that cannot check',
    );
    assert.ok(/Platform status/.test(landing), 'the footer no longer links to the status page');
  });

  it('describes the integration surface the platform actually has', () => {
    const page = developers();
    for (const term of ['webhook', 'passkey', 'signature scanner']) {
      assert.ok(new RegExp(term, 'i').test(page), `the developers page does not mention ${term}`);
    }
  });
});
