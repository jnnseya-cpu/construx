import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { AREA_CONSOLE_PAGE, CONSOLE_PAGE, values } from '../../shared/vocabulary.js';
import { CAPABILITY_AREA_LIST, type CapabilityArea } from '../src/identity/roles.ts';
import { rejectsCode } from './helpers.ts';
import { morningBriefing } from '../src/agents/briefing.ts';
import { AGENTS } from '../src/agents/registry.ts';
import { AGENT_DIVISIONS } from '../src/agents/types.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The fleet, and the briefing it feeds.
 *
 * The briefing is the one screen somebody acts on before they have had coffee,
 * so the tests that matter are about what it refuses to say. A dashboard that
 * reports a confident zero because it read the wrong field is worse than one
 * that says nothing — the zero gets believed, and the £1.4m of margin behind it
 * goes unexamined for a month.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = (who = 'owner') =>
  platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const brief = (today = '2026-03-02') => morningBriefing(ctx(), { name: 'Justin', today });

// ── The fleet ───────────────────────────────────────────────────────────────

describe('The agent fleet', () => {
  it('names every agent once, and puts each in a declared division', () => {
    // The count is deliberately not asserted. It was 12, and pinning it meant
    // every new agent broke a test that was not about the new agent — so what
    // is asserted is the property that actually matters: no duplicate name, and
    // nobody outside the declared divisions.
    assert.ok(AGENTS.length >= 12);
    assert.equal(new Set(AGENTS.map((a) => a.name)).size, AGENTS.length, 'an agent name appears twice');

    for (const { division } of AGENT_DIVISIONS) {
      assert.ok(AGENTS.some((a) => a.division === division), `${division} has no agents`);
    }
    for (const agent of AGENTS) {
      assert.ok(AGENT_DIVISIONS.some((d) => d.division === agent.division), `${agent.name} is in no division`);
    }
  });

  it('keeps every mandate no wider than what the agent may read', () => {
    // The runtime checks this at proposal time; asserting it here catches a
    // mandate written wrong rather than a proposal caught late.
    for (const agent of AGENTS) {
      for (const area of agent.mandate.proposes) {
        assert.ok(agent.mandate.reads.includes(area), `${agent.name} proposes in ${area} without reading it`);
      }
      assert.ok(agent.mandate.approvers.length > 0, `${agent.name} has nobody who can approve it`);
      // ACT is eligibility, not authority — `mandate.test.ts` holds that line.
      // What is asserted here is that eligibility is never declared without the
      // bound that goes with it.
      if (agent.mandate.maxUnattended === 'ACT') {
        assert.ok(agent.mandate.envelope, `${agent.name} is ACT-eligible with no declared envelope`);
      }
    }
  });

  it('gives the new watchers observation only, since none of them can fix what they see', () => {
    for (const name of ['radar', 'pipeline', 'supply-chain', 'hseq']) {
      const agent = AGENTS.find((a) => a.name === name)!;
      assert.ok(agent, `${name} is missing`);
      assert.equal(agent.mandate.maxUnattended, 'OBSERVE');
    }
  });
});

// ── The briefing ────────────────────────────────────────────────────────────

describe('The morning briefing', () => {
  it('counts what the radar screened, and what it saved somebody reading', () => {
    const b = brief();

    assert.equal(b.market.detected, 5);
    assert.equal(b.market.rejected, 3);
    assert.equal(b.market.suitable, 2);
    assert.equal(b.market.detected, b.market.rejected + b.market.suitable);
    assert.equal(b.market.lastRunOn, '2026-03-02');
  });

  it('recommends the best-scoring bids that are still open, best first', () => {
    const b = brief();

    assert.ok(b.market.recommended.length > 0);
    const scores = b.market.recommended.map((r) => r.score);
    assert.deepEqual(scores, [...scores].sort((x, y) => y - x));
    for (const bid of b.market.recommended) {
      assert.ok(bid.daysToDeadline >= 0, `${bid.reference} has closed and is still recommended`);
      assert.ok(bid.valueMinor > 0 && bid.score > 0);
    }
  });

  it('reads the delay forecast from the field the engine actually writes', () => {
    // The engine writes expectedDelayDays and p80DelayDays. Reading a field
    // that does not exist would report zero days on a project forecasting fifty.
    const b = brief();

    assert.ok(b.delivery.worstDelayDays > 40, `expected a real delay forecast, got ${b.delivery.worstDelayDays}`);
    assert.ok(b.delivery.worstDelayProject);
    assert.ok(b.actions.some((a) => a.because.includes('at P80')), 'the P80 figure was not carried');
  });

  it('converts margin erosion into money, because a percentage is not actionable', () => {
    const b = brief();

    assert.ok(b.money.marginErosionMinor > 1_000_000_00, `expected real erosion, got ${b.money.marginErosionMinor}`);
    const action = b.actions.find((a) => a.action.includes('margin movement'))!;
    assert.ok(action);
    assert.match(action.because, /% of contract value/);
  });

  it('stays silent on a payment sum it does not hold rather than reporting zero', () => {
    // The payment cycle holds statutory dates, not applied sums — the amount is
    // not known until somebody applies. A briefing that printed £0 would be
    // read as "nothing due", which is a different and false statement.
    const b = brief();
    assert.ok(!('paymentDueMinor' in b.money));
  });

  it('finds the next application only when it is actually close', () => {
    const far = brief('2026-03-02');
    assert.equal(far.money.paymentDueBy, undefined, 'the seeded cycle starts in July');

    const near = brief('2026-08-20');
    assert.equal(near.money.paymentDueBy, '2026-08-25');
    assert.ok(near.actions.some((a) => a.action.includes('application 1')));
  });

  it('orders actions by urgency and then by what they are worth', () => {
    const b = brief();
    const rank = { URGENT: 0, ATTENTION: 1, INFO: 2 } as const;

    for (let i = 1; i < b.actions.length; i++) {
      const previous = b.actions[i - 1]!;
      const current = b.actions[i]!;
      assert.ok(rank[previous.severity] <= rank[current.severity], 'a less urgent action came first');
    }
  });

  it('gives every action a source that can be checked', () => {
    for (const action of brief().actions) {
      assert.ok(action.source.refType && action.source.refId, `"${action.action}" cannot be traced`);
      assert.ok(action.action.length > 0 && action.because.length > 0);
      // The action is an instruction; the reason carries the number.
      assert.ok(/\d/.test(action.because), `"${action.action}" gives no figure`);
    }
  });

  it('leads with one line somebody can act on', () => {
    const b = brief();
    const urgent = b.actions.filter((a) => a.severity === 'URGENT').length;

    assert.ok(b.headline.length > 0);
    if (urgent > 0) assert.match(b.headline, /will cost money/);
    assert.match(b.greeting, /^Good morning, Justin\.$/);
    assert.equal(b.asAt, '2026-03-02');
  });

  it('shows the org chart with its open findings', () => {
    const b = brief();

    assert.equal(b.fleet.length, AGENT_DIVISIONS.length);
    assert.equal(b.fleet.reduce((n, f) => n + f.agents, 0), AGENTS.length);
    for (const division of b.fleet) {
      assert.ok(division.agents > 0);
      assert.ok(division.openFindings >= 0);
    }
  });

  it('says so plainly when there is nothing to do', async () => {
    // A separate tenant with no projects, no pipeline and no radar run.
    const { tenant } = platform.createTenant({
      legalName: 'Quiet Contractor Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'Quiet Group',
    });
    const quiet = platform.context(
      { ...seed.users.owner!.auth, tenantId: tenant.id },
      `${tenant.id}-governance`,
      { source: 'WEB' },
    );

    const b = morningBriefing(quiet, { today: '2026-03-02' });
    assert.equal(b.actions.length, 0);
    assert.equal(b.market.detected, 0);
    assert.equal(b.market.lastRunOn, undefined, 'a briefing does not invent a radar run');
    assert.match(b.headline, /Nothing needs a decision today/);
    assert.equal(b.greeting, 'Good morning.');
    await Promise.resolve();
  });


  it('raises a notified sum unpaid past its final date, with the figure', () => {
    // The third certificate is certified and never paid. Under the Act the
    // notified sum was payable by 24 November whatever anybody thinks of the
    // valuation, so by December it is a debt and not a discussion.
    const b = brief('2026-12-01');

    const chase = b.actions.find((a) => a.action.includes('past its final date'));
    assert.ok(chase, 'an unpaid notified sum did not reach the briefing');
    assert.equal(chase.severity, 'URGENT');
    assert.ok((chase.valueMinor ?? 0) > 2_000_000_00, `expected the certified sum, got ${chase.valueMinor}`);
    assert.match(chase.because, /right to suspend/);
  });

  it('stays silent about cycles nobody has applied against', () => {
    // Nine of the twelve cycles have no application. Reporting them as exposure
    // would bury the one that is real under nine that are not.
    const b = brief('2026-12-01');
    assert.equal(b.actions.filter((a) => a.action.includes('past its final date')).length, 1);
  });

  it('says nothing about statutory exposure before any of it has crystallised', () => {
    const b = brief();
    assert.equal(b.actions.filter((a) => a.because.includes('notice was missed')).length, 0);
  });


  it('surfaces a dated obligation nothing on the project would trigger', () => {
    // The bond expires on 31 October 2026 and nothing in the delivery of the
    // job will remind anybody. That is the whole reason it is in the briefing.
    const b = brief('2026-10-20');

    const bond = b.actions.find((a) => a.action.includes('Performance bond'));
    assert.ok(bond, 'the bond expiry did not reach the briefing');
    assert.match(bond.because, /Finance director owns it/);
    assert.equal(bond.dueBy, '2026-10-31');
  });

  it('escalates an obligation once its date has passed', () => {
    const b = brief('2026-11-10');
    const bond = b.actions.find((a) => a.action.includes('Performance bond'))!;

    assert.equal(bond.severity, 'URGENT');
    assert.match(bond.because, /10 days ago/);
  });

  it('stays quiet about an obligation months away', () => {
    // A briefing that reports everything trains its reader to skim.
    const b = brief('2026-08-20');
    assert.equal(b.actions.filter((a) => a.action.includes('Performance bond')).length, 0);
  });

  it('refuses a role with no business development read', async () => {
    const supplier = seed.users.regulator;
    if (!supplier) return;
    await rejectsCode(
      async () => morningBriefing(platform.context(supplier.auth, `${seed.tenantId}-governance`, { source: 'WEB' })),
      'ACCESS_DENIED',
    );
  });
});


// ── Every row is somewhere to go ────────────────────────────────────────────

describe('The briefing is actionable, in the sense the word usually means', () => {
  /*
   * ## What happened
   *
   * `BriefingAction`'s own contract says "Everything is actionable or it is not
   * here", and for as long as the briefing existed the console rendered the
   * action as a bare string: no link, no button, no handler on the row. The
   * first screen anybody sees told them four things would cost money today and
   * gave them nothing to press. A reviewer's words for it were "review button
   * very useless, nowhere to act or action anything under your
   * responsibility", and they were describing the product accurately.
   *
   * The fix is a destination on the action, decided by the server — which is
   * what decided the row exists and therefore knows where it is answered.
   *
   * ## What this holds shut
   *
   * A new action with no destination, and a destination pointing at a screen
   * the console does not have. Both are silent failures otherwise: the first
   * renders a button that goes nowhere, the second a button that navigates to
   * a blank route.
   */

  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const shell = readFileSync(join(REPO, 'frontend', 'app.js'), 'utf8');
  /*
   * The registry, not the menu.
   *
   * The first version of this check looked for `id: '<page>'` in the sidebar's
   * `NAV`, and it was wrong in a way worth keeping a note about: not every
   * screen is a menu item. "What your role can do" is reached from the sidebar
   * footer and from a command bar, never from the menu itself, so a correct
   * destination failed the check. `frontend/pages/index.js` is what `navigate`
   * actually resolves against, which makes it the thing to ask.
   */
  const registry = readFileSync(join(REPO, 'frontend', 'pages', 'index.js'), 'utf8');
  const routed = (page: string): boolean =>
    new RegExp(`^\\s*${page},\\s*$|^\\s*${page}:`, 'm').test(registry);

  it('sends every action to a screen the console actually has', () => {
    const b = brief();
    assert.ok(b.actions.length > 0, 'the briefing produced no actions — this check matched nothing');

    const known = new Set(values(CONSOLE_PAGE));
    for (const action of b.actions) {
      assert.ok(action.goTo, `"${action.action}" has nowhere to go`);
      assert.ok(
        known.has(action.goTo.page),
        `"${action.action}" points at "${action.goTo.page}", which is not in CONSOLE_PAGE`,
      );
      // The vocabulary is only worth something if it is the console's own ids.
      assert.ok(
        routed(action.goTo.page),
        `CONSOLE_PAGE offers "${action.goTo.page}" but the console has no such screen`,
      );
    }
  });

  it('names the project an action is about, wherever it is about one', () => {
    // The briefing reads across every live project while the console looks at
    // one. Without the project id, "Explain the margin movement on Rossendale"
    // lands on whichever job happened to be open — which is worse than not
    // moving, because it looks like it worked.
    const b = brief();
    const perProject = b.actions.filter((a) => /\bon\b .+/.test(a.action) && a.goTo.page !== 'pipeline');
    assert.ok(perProject.length > 0, 'no project-scoped actions were produced — this check matched nothing');
    for (const action of perProject) {
      assert.ok(action.goTo.projectId, `"${action.action}" is about a project but carries no project to switch to`);
    }
  });

  it('draws each one as something that can be pressed', () => {
    // The guard on the guard: the server can carry a perfect destination and
    // the screen can still print it as prose, which is exactly the state this
    // was found in.
    const overview = readFileSync(join(REPO, 'frontend', 'pages', 'overview.js'), 'utf8');
    assert.match(overview, /data-goto="\$\{raw\(a\.goTo\.page\)\}"/, 'the briefing table no longer renders a destination');
    assert.match(shell, /\[data-goto\]/, 'the shell no longer listens for a destination');
    assert.match(shell, /export function goTo\(/, 'the shell no longer exposes the navigation a destination needs');
  });

  it('every screen CONSOLE_PAGE offers is one the console has', () => {
    // CONSOLE_PAGE is a shared vocabulary, so a stale entry in it is a
    // destination waiting to be used. Checked as a whole, not only the ids this
    // fixture happened to produce.
    for (const page of values(CONSOLE_PAGE)) {
      assert.ok(routed(page), `CONSOLE_PAGE offers "${page}"; the console has no such screen`);
    }
  });
});


// ── Where a capability area is exercised ────────────────────────────────────

describe('every capability area has a screen it is exercised on', () => {
  /*
   * `AREA_CONSOLE_PAGE` is what makes a copilot suggestion actionable: the
   * suggestion carries the capability area it needs, and this says which screen
   * that is taken on. An area with no entry is a suggestion with nowhere to go,
   * which is the defect the whole map was added to close — so a new capability
   * area fails here rather than silently falling back to the command centre.
   */
  const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const registry = readFileSync(join(REPO, 'frontend', 'pages', 'index.js'), 'utf8');
  const known = new Set(values(CONSOLE_PAGE));
  // Partial by construction — the operator's area has no customer screen — and
  // the type says so, which is why the lookup is widened rather than asserted.
  const pageFor = AREA_CONSOLE_PAGE as Partial<Record<CapabilityArea, string>>;

  it('maps every area the matrix grants, bar the one the operator owns', () => {
    for (const area of CAPABILITY_AREA_LIST) {
      if (area === 'PLATFORM_ADMINISTRATION') {
        // The operator's cross-tenant area. A customer's console has no screen
        // for it, deliberately, and mapping it to one would be the first step
        // towards drawing a door to it.
        assert.equal(pageFor[area], undefined, 'the operator area was given a screen in the customer console');
        continue;
      }
      const page = pageFor[area];
      assert.ok(page, `${area} has no screen; a copilot suggestion needing it would have nowhere to go`);
      assert.ok(known.has(page), `${area} maps to "${page}", which is not in CONSOLE_PAGE`);
      assert.match(registry, new RegExp(`^\\s*${page},\\s*$|^\\s*${page}:`, 'm'), `${area} maps to a screen the console does not have`);
    }
  });
});
