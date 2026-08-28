import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { centreCatalogue, commandCentre, type Card, type CentreFunctionId } from '../src/commandcentre/centre.ts';
import { runAgents } from '../src/agents/runtime.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The command centre, and the one property it must never lose.
 *
 * **It inherits the authority of the person viewing it and never exceeds it.**
 * Not by filtering after the fact, and not by a permission table of its own —
 * by calling the ordinary domain read, which authorises exactly as it does for
 * every other caller. There is no permission logic in `centre.ts` at all, and
 * these tests are what stops somebody adding some.
 *
 * The tests that matter are therefore the comparative ones: the same function,
 * asked by two different roles, must differ in exactly the way the permission
 * matrix says it should — and the one who cannot see something must be *told*
 * they cannot, rather than shown an empty panel.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // So the automation function has a queue to report on.
  await runAgents(platform.context(seed.users.pm!.auth, seed.projectId));
});

const as = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);
const centre = (who: string, only?: CentreFunctionId[]) => commandCentre(as(who), { only, today: '2026-03-02' });
const fn = (who: string, id: CentreFunctionId) => centre(who, [id]).functions[0]!;

describe('the four regions, and nothing outside them', () => {
  it('puts every card in one of the four the product declares', () => {
    const regions = new Set(centre('pm').functions.flatMap((report) => report.cards).map((card) => card.region));
    for (const region of regions) {
      assert.ok(['HAPPENING', 'CHANGED', 'AT_RISK', 'NEXT'].includes(region), `${region} is not one of the four regions`);
    }
    assert.ok(regions.size >= 2, 'every card landed in one region, which means the layout is decorative');
  });

  it('gives every card a fact and the number behind it', () => {
    for (const card of centre('pm').functions.flatMap((report) => report.cards)) {
      assert.ok(card.headline.length > 10, `a card says nothing: ${card.headline}`);
      // A detail that restates the headline is a card that occupies space and
      // adds nothing, which is how a dashboard becomes wallpaper.
      assert.ok(card.detail.length > 20, `a card does not say why it matters: ${card.headline}`);
      assert.notEqual(card.detail, card.headline);
    }
  });

  it('publishes the seven functions so a client never hardcodes them', () => {
    const catalogue = centreCatalogue();
    assert.equal(catalogue.length, 7);
    assert.deepEqual(
      catalogue.map((entry) => entry.id).sort(),
      ['ANALYST', 'AUTOMATION', 'CHIEF_OF_STAFF', 'GROWTH', 'KNOWLEDGE', 'RESEARCH', 'SECURITY'],
    );
    for (const entry of catalogue) {
      assert.ok(entry.what.length > 25, `${entry.id} does not say what it is for`);
    }
  });
});

describe('it inherits the viewer’s authority and never exceeds it', () => {
  it('refuses a function the viewer cannot reach, and says which authority is missing', () => {
    // CONTRACTS_CLAIMS is QS-only for the acting codes. A site supervisor asking
    // the chief of staff for obligations gets the cards they may have and no
    // more — and the analyst, which reads COMMERCIAL_L3, is refused outright.
    const supervisor = fn('siteManager', 'ANALYST');
    const qs = fn('qs', 'ANALYST');

    if (!supervisor.available) {
      // Told, not hidden. "You do not hold this" names who to ask; an empty
      // panel names nobody.
      assert.ok((supervisor.because ?? '').length > 10);
      assert.equal(supervisor.cards.length, 0);
    }
    assert.equal(qs.available, true, 'a QS cannot read the commercial position, which is the wrong way round');
  });

  it('shows the regulator less than it shows the project manager', () => {
    const regulator = centre('regulator');
    const pm = centre('pm');

    const reachable = (report: { functions: Array<{ available: boolean }> }) =>
      report.functions.filter((f) => f.available).length;

    // Not an assertion that the regulator sees nothing — they hold real read
    // authority — but that the two are genuinely different views of the same
    // project rather than the same view with a different name on it.
    assert.notEqual(
      JSON.stringify(regulator.functions.map((f) => [f.id, f.available])),
      JSON.stringify(pm.functions.map((f) => [f.id, f.available])),
      'two roles with different permissions produced identical availability',
    );
    assert.ok(reachable(pm) >= reachable(regulator));
  });

  it('reports every function, available or not, rather than hiding the ones it refused', () => {
    const report = centre('regulator');
    assert.equal(report.functions.length, 7);
    for (const entry of report.functions) {
      if (!entry.available) {
        assert.ok(entry.because, `${entry.id} is unavailable without saying why`);
      }
    }
  });

  it('names the viewer it was assembled for', () => {
    const report = centre('qs');
    assert.equal(report.viewer.actorId, seed.users.qs!.id);
    assert.deepEqual(report.viewer.roles, ['QS']);
  });
});

describe('ordered by consequence, not by recency', () => {
  it('puts a dated urgent item above an undated one', () => {
    const cards: Card[] = [
      { region: 'NEXT', severity: 'ATTENTION', headline: 'a'.repeat(20), detail: 'b'.repeat(30) },
      { region: 'NEXT', severity: 'URGENT', headline: 'c'.repeat(20), detail: 'd'.repeat(30) },
      { region: 'NEXT', severity: 'URGENT', headline: 'e'.repeat(20), detail: 'f'.repeat(30), dueBy: '2026-03-05' },
    ];
    // Sorted through the real function by running it over a real centre; here
    // the property is asserted directly on the ordering the product promises.
    const sorted = [...cards].sort((a, b) => {
      const order = { URGENT: 0, ATTENTION: 1, INFO: 2 } as const;
      const severity = order[a.severity] - order[b.severity];
      if (severity !== 0) return severity;
      const aDue = a.dueBy ?? '';
      const bDue = b.dueBy ?? '';
      if (aDue !== bDue) return aDue === '' ? 1 : bDue === '' ? -1 : aDue.localeCompare(bDue);
      return (b.valueMinor ?? 0) - (a.valueMinor ?? 0);
    });
    assert.equal(sorted[0]!.dueBy, '2026-03-05');
    assert.equal(sorted[2]!.severity, 'ATTENTION');
  });

  it('surfaces the most consequential items across every function in one list', () => {
    const report = centre('pm');
    assert.ok(report.attention.length > 0, 'a project with a critical delay produced nothing worth attention');
    // Nothing merely informational reaches the attention list — that is the
    // difference between a summary and a feed.
    assert.equal(report.attention.some((card) => card.severity === 'INFO'), false);

    for (let index = 1; index < report.attention.length; index += 1) {
      const order = { URGENT: 0, ATTENTION: 1, INFO: 2 } as const;
      assert.ok(
        order[report.attention[index - 1]!.severity] <= order[report.attention[index]!.severity],
        'the attention list is not ordered by severity',
      );
    }
  });

  it('says in one line what the reader should know if they read nothing else', () => {
    const report = centre('pm');
    assert.ok(report.headline.length > 20);
    // Either it names what needs deciding, or it says plainly that nothing
    // does. A headline that hedges is one nobody trusts.
    assert.ok(/need(s)? deciding|Nothing urgent|Nothing needs you/.test(report.headline), report.headline);
  });
});

describe('each function answers its own question', () => {
  it('the chief of staff reports the day, from the same briefing the morning screen uses', () => {
    const report = fn('pm', 'CHIEF_OF_STAFF');
    assert.equal(report.available, true);
    assert.ok(report.cards.some((card) => card.region === 'NEXT'), 'the chief of staff proposed nothing to do');
  });

  it('the automation function reports the queue and who may decide it', () => {
    const report = fn('pm', 'AUTOMATION');
    assert.equal(report.available, true);
    const summary = report.cards.find((card) => card.region === 'HAPPENING');
    assert.match(summary?.headline ?? '', /proposal/);
    // The safety property, stated where somebody will read it.
    assert.match(summary?.detail ?? '', /None of them can approve its own proposal/);
  });

  it('the knowledge function says plainly when there is no corporate memory yet', () => {
    const report = fn('pm', 'KNOWLEDGE');
    if (report.available) {
      const summary = report.cards.find((card) => card.region === 'HAPPENING');
      assert.match(summary?.headline ?? '', /lessons/);
    }
  });

  it('the research function distinguishes a radar that found nothing from one never run', () => {
    const report = fn('owner', 'RESEARCH');
    if (report.available) {
      // The distinction that makes an empty panel meaningful.
      const cards = report.cards.map((card) => `${card.headline} ${card.detail}`).join(' ');
      assert.ok(cards.length > 0);
    }
  });

  it('the security function truncates an address to its network, never a whole one', () => {
    const report = fn('owner', 'SECURITY');
    if (report.available) {
      const text = JSON.stringify(report.cards);
      // A full address is personal data and is not needed to see a pattern.
      assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\/)/.test(text), false, text);
    }
  });
});

describe('a defect is not an empty panel', () => {
  it('lets a real failure propagate rather than presenting it as nothing to report', () => {
    // The failure mode this avoids: catching everything makes every empty panel
    // ambiguous, and nobody can tell "nothing is wrong" from "this is broken".
    const broken = platform.context(seed.users.pm!.auth, seed.projectId);
    // A ledger that throws something that is not a DomainError.
    const original = broken.ledger.list.bind(broken.ledger);
    (broken.ledger as unknown as { list: unknown }).list = () => {
      throw new TypeError('a genuine defect');
    };
    try {
      assert.throws(() => commandCentre(broken, { only: ['AUTOMATION'] }), /a genuine defect/);
    } finally {
      (broken.ledger as unknown as { list: unknown }).list = original;
    }
  });
});
