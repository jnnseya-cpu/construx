import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  BRIEF_ITEMS,
  CHANGES,
  SERVICE_FAMILIES,
  assumeFact,
  briefConflicts,
  briefReadiness,
  recordFact,
  statutoryWcs,
} from '../src/domain/etablix/brief.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §3 — the brief gateway, and the two dozen numbers a site is designed from.
 *
 * A customer hands over a programme, a layout, an employer's requirements and a
 * workforce curve. Somewhere in them are the figures that decide how many WCs,
 * how much power, how many buses and how many beds. They are never all there,
 * and the missing ones are never the ones anybody notices.
 *
 * Three properties, and the second is the one the specification is emphatic
 * about:
 *
 * 1. **A fact is traceable or it is not recorded.** The argument in month six
 *    is always about where a number came from.
 * 2. **A percentage alone is forbidden.** Every gap carries what it decides,
 *    the date the answer arrives too late, what is assumed meanwhile, and whose
 *    answer it is. And an assumption is *not* an answer: it does not count
 *    towards the percentage, or a brief nobody has answered reads as complete.
 * 3. **Contradictions between recorded facts are found, with the arithmetic.**
 *    Two figures that disagree are worse than one that is missing, because
 *    nobody is looking for it.
 */

let platform: Platform;
let seed: SeedResult;

function granted(who = 'pm'): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

function ungranted(who = 'pm'): EngineContext {
  return { ...granted(who), grantedModules: [] };
}

/** Record a fact the short way, since almost every test needs several. */
function fact(id: string, value: number | string, source = 'Employer’s Requirements rev C, §4.2'): void {
  recordFact(granted(), { itemId: id, value, source });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'ETABLIX',
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'ACTIVE',
    reason: 'Appointed as ETABLIX site-services delivery partner',
    decidedBy: seed.users.operator!.id,
  });
});

beforeEach(() => {
  seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
});

describe('the catalogue itself', () => {
  it('gives every item a family, a consequence, an assumption and something it changes', () => {
    // An item that changes nothing is a question nobody should be asked, and
    // the adaptive interview is derived from this list rather than curated
    // beside it — so a hole here becomes a wasted question there.
    for (const item of BRIEF_ITEMS) {
      assert.ok(item.family in SERVICE_FAMILIES, `${item.id} has no family`);
      assert.ok(item.decides.length > 20, `${item.id} does not say what it decides`);
      assert.ok(item.provisionalBasis.length > 20, `${item.id} has no stated provisional basis`);
      assert.ok(item.question.endsWith('?'), `${item.id} has no question`);
      assert.ok(item.changes.length > 0, `${item.id} changes nothing, so nobody should be asked it`);
      for (const change of item.changes) assert.ok(CHANGES.includes(change), `${item.id}: ${change} is not a change`);
    }
  });

  it('covers every service family', () => {
    // A family with no items would report 0 of 0 settled, which renders as
    // complete — the worst possible way for a gap in the catalogue to look.
    for (const family of Object.keys(SERVICE_FAMILIES)) {
      assert.ok(
        BRIEF_ITEMS.some((item) => item.family === family),
        `${family} has no brief items, so it would report as complete with nothing known`,
      );
    }
  });

  it('uses no item id twice', () => {
    const ids = BRIEF_ITEMS.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe('recording a fact', () => {
  it('keeps the source, because that is what the argument is about later', () => {
    const recorded = recordFact(granted(), {
      itemId: 'peakWorkforce',
      value: 164,
      source: 'Resource histogram, programme rev D, week 34',
    });
    assert.equal(recorded.status, 'KNOWN');
    assert.equal(recorded.value, 164);
    assert.equal(recorded.unit, 'persons');
    assert.match(recorded.source, /histogram/);
  });

  it('refuses a fact with no source', () => {
    throwsCode(
      () => recordFact(granted(), { itemId: 'peakWorkforce', value: 164, source: '  ' }),
      'BRIEF_FACT_SOURCE_REQUIRED',
    );
  });

  it('refuses text where a calculation expects a number', () => {
    // The failure this prevents is silent: a string in a numeric slot makes
    // every comparison against it quietly false rather than loudly wrong, so
    // the conflict checks would simply stop finding anything.
    throwsCode(
      () => recordFact(granted(), { itemId: 'peakWorkforce', value: 'about 160', source: 'A conversation' }),
      'BRIEF_FACT_VALUE_INVALID',
    );
    throwsCode(
      () => recordFact(granted(), { itemId: 'peakWorkforce', value: -4, source: 'A conversation' }),
      'BRIEF_FACT_VALUE_INVALID',
    );
  });

  it('takes text where the unit is not numeric', () => {
    assert.doesNotThrow(() =>
      recordFact(granted(), {
        itemId: 'reinstatementStandard',
        value: 'Return to pre-existing condition per the survey of 2026-03-02',
        source: 'Lease, schedule 4',
      }),
    );
    assert.doesNotThrow(() =>
      recordFact(granted(), { itemId: 'firstMobilisationDate', value: '2026-11-02', source: 'Programme rev D' }),
    );
    throwsCode(
      () => recordFact(granted(), { itemId: 'firstMobilisationDate', value: 'November', source: 'Programme rev D' }),
      'BRIEF_FACT_VALUE_INVALID',
    );
  });

  it('refuses an item nobody defined', () => {
    throwsCode(
      () => recordFact(granted(), { itemId: 'vibes', value: 3, source: 'Somewhere' }),
      'BRIEF_ITEM_UNKNOWN',
    );
  });

  it('supersedes rather than overwrites', () => {
    fact('peakWorkforce', 100, 'Employer’s Requirements rev A');
    fact('peakWorkforce', 164, 'Resource histogram, programme rev D');

    const readiness = briefReadiness(granted());
    const live = readiness.facts.filter((entry) => entry.itemId === 'peakWorkforce');
    assert.equal(live.length, 1, 'two live facts for one item');
    assert.equal(live[0]!.value, 164);

    // And the old figure is still readable. A number that changed with no
    // record of the change is how two teams end up working to different ones,
    // and `register` is what somebody opens when that has happened.
    assert.equal(readiness.register.filter((entry) => entry.itemId === 'peakWorkforce').length, 2);
    const retired = readiness.register.find((entry) => entry.value === 100)!;
    assert.equal(retired.supersededBy, live[0]!.id);
    assert.ok(retired.supersededAt);

    const all = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((event) => event.eventType === 'SITE_SERVICE_FACT_SUPERSEDED');
    assert.equal(all.length, 1);
  });

  it('is refused to a tenancy without the module', () => {
    throwsCode(
      () => recordFact(ungranted(), { itemId: 'peakWorkforce', value: 164, source: 'x' }),
      'MODULE_NOT_GRANTED',
    );
    throwsCode(() => briefReadiness(ungranted()), 'MODULE_NOT_GRANTED');
  });
});

describe('assuming a value out loud', () => {
  it('records the basis, the decision date and the owner', () => {
    const assumed = assumeFact(granted(), {
      itemId: 'visitorsPerDay',
      value: 16,
      basis: '10% of the 164 peak, pending the client’s visitor policy',
      decideBy: '2026-10-01',
      owner: 'Ruth Adeyemi',
    });
    assert.equal(assumed.status, 'PROVISIONAL');
    assert.equal(assumed.owner, 'Ruth Adeyemi');
    assert.equal(assumed.decideBy, '2026-10-01');
    // The source says it is provisional in its own words, so a reader who sees
    // only the fact and not its status still knows.
    assert.match(assumed.source, /^Provisional:/);
  });

  it('refuses an assumption nobody owns and nothing expires', () => {
    // The specification's rule: agents may not silently replace missing facts.
    // An assumption with no owner is never revisited, and one with no date
    // quietly becomes the design.
    throwsCode(
      () =>
        assumeFact(granted(), {
          itemId: 'visitorsPerDay',
          value: 16,
          basis: '10% of peak',
          decideBy: '2026-10-01',
          owner: '  ',
        }),
      'BRIEF_ASSUMPTION_UNOWNED',
    );
    throwsCode(
      () =>
        assumeFact(granted(), {
          itemId: 'visitorsPerDay',
          value: 16,
          basis: '10% of peak',
          decideBy: 'soon',
          owner: 'Ruth Adeyemi',
        }),
      'BRIEF_ASSUMPTION_UNDATED',
    );
    throwsCode(
      () =>
        assumeFact(granted(), {
          itemId: 'visitorsPerDay',
          value: 16,
          basis: '',
          decideBy: '2026-10-01',
          owner: 'Ruth Adeyemi',
        }),
      'BRIEF_ASSUMPTION_UNBASED',
    );
  });

  it('does not count towards completeness', () => {
    // The heart of "a percentage alone is forbidden". If an assumption counted,
    // a brief nobody has answered would report as complete — which is the
    // reading the whole structure exists to prevent.
    fact('peakWorkforce', 164);
    assumeFact(granted(), {
      itemId: 'shiftOverlapPersons',
      value: 142,
      basis: 'Both shifts fully overlapping for the changeover hour',
      decideBy: '2026-10-01',
      owner: 'Ruth Adeyemi',
    });

    const welfare = briefReadiness(granted()).families.find(
      (family) => family.family === 'WELFARE_ACCOMMODATION',
    )!;
    assert.equal(welfare.known, 1);
    assert.equal(welfare.provisional, 1);
    // Two of the family's items are answered in some sense and only one counts.
    assert.ok(welfare.percentKnown < (2 / welfare.items) * 100);
  });

  it('shows the assumption on the gap it is standing in for', () => {
    assumeFact(granted(), {
      itemId: 'operatingHours',
      value: 24,
      basis: 'The programme shows a night shift from week 12',
      decideBy: '2026-09-20',
      owner: 'Tom Bramall',
    });
    const gap = briefReadiness(granted())
      .families.find((family) => family.family === 'SECURITY_LOGISTICS')!
      .gaps.find((entry) => entry.itemId === 'operatingHours')!;

    // The four things a percentage is forbidden from standing in for.
    assert.ok(gap.decides.length > 20);
    assert.equal(gap.latestAnswer, '2026-09-20');
    assert.equal(gap.owner, 'Tom Bramall');
    assert.equal(gap.provisionalValue, 24);
    assert.ok(gap.provisionalAssumption.length > 20);
  });

  it('reports an assumption whose decision date has passed', () => {
    assumeFact(granted(), {
      itemId: 'operatingHours',
      value: 24,
      basis: 'The programme shows a night shift',
      decideBy: '2026-01-05',
      owner: 'Tom Bramall',
    });
    const overdue = briefReadiness(granted(), '2026-09-01').overdue;
    assert.equal(overdue.length, 1);
    assert.equal(overdue[0]!.itemId, 'operatingHours');

    // And is not overdue before the date, or every assumption would be red
    // from the moment it was made.
    assert.equal(briefReadiness(granted(), '2026-01-01').overdue.length, 0);
  });
});

describe('the statutory sanitary calculation', () => {
  it('follows Schedule 1 of the Workplace Regulations 1992', () => {
    // A real rule with a citation. An inspector arrives with these numbers and
    // a platform that invented its own would be wrong in the one conversation
    // it exists to be right in.
    assert.equal(statutoryWcs(0), 0);
    assert.equal(statutoryWcs(5), 1);
    assert.equal(statutoryWcs(6), 2);
    assert.equal(statutoryWcs(25), 2);
    assert.equal(statutoryWcs(26), 3);
    assert.equal(statutoryWcs(50), 3);
    assert.equal(statutoryWcs(75), 4);
    assert.equal(statutoryWcs(100), 5);
    // Beyond 100: one more per 25 people or part thereof.
    assert.equal(statutoryWcs(101), 6);
    assert.equal(statutoryWcs(125), 6);
    assert.equal(statutoryWcs(126), 7);
    assert.equal(statutoryWcs(142), 7);
    assert.equal(statutoryWcs(150), 7);
    assert.equal(statutoryWcs(151), 8);
  });
});

describe('cross-checking what has been recorded', () => {
  it('finds the specification’s own worked example', () => {
    // "The brief states 100 workers, but the programme peaks at 164 across two
    // shifts and includes 22 visitors. The current welfare basis provides only
    // 5 WCs during the overlap."
    fact('peakWorkforce', 164);
    fact('shiftOverlapPersons', 120, 'Shift plan rev B');
    fact('visitorsPerDay', 22, 'Visitor log, four-week average');
    fact('wcProvision', 5, 'Welfare layout rev A');

    const conflicts = briefConflicts(granted());
    const welfare = conflicts.find((conflict) => conflict.id === 'WELFARE_BELOW_STATUTORY')!;
    assert.ok(welfare, 'the welfare shortfall was not found');
    assert.equal(welfare.severity, 'BLOCKING');
    // Concurrent occupancy is 142 — the overlap plus the visitors — which needs
    // seven WCs. The statement has to carry both figures or nobody can check it.
    assert.match(welfare.statement, /142 people/);
    assert.match(welfare.statement, /needs 7 WCs/);
    assert.match(welfare.statement, /provides 5/);
    // And it ends in a choice, as the specification's example does, not a warning.
    assert.match(welfare.resolution, /Confirm the peak concurrent occupancy, or accept/);
    assert.match(welfare.resolution, /164 persons/);
  });

  it('runs no check where either figure is missing', () => {
    // A check against an absent value would compare against zero and produce a
    // false alarm with arithmetic on it. The missing figure is already reported
    // as a gap, which is the honest way to say the check could not be made.
    fact('wcProvision', 2, 'Welfare layout rev A');
    assert.deepEqual(briefConflicts(granted()), []);

    fact('shiftOverlapPersons', 120, 'Shift plan rev B');
    assert.equal(briefConflicts(granted()).length, 1);
  });

  it('finds a changeover larger than the daily peak', () => {
    fact('peakWorkforce', 100);
    fact('shiftOverlapPersons', 140, 'Shift plan rev B');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'OVERLAP_EXCEEDS_PEAK')!;
    assert.ok(conflict);
    assert.match(conflict.resolution, /cannot exceed/);
  });

  it('finds a site live longer than it is guarded', () => {
    fact('operatingHours', 24, 'Shift plan rev B');
    fact('securityHoursCovered', 12, 'Security tender return, Falcon Security');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'SECURITY_BELOW_OPERATING_HOURS')!;
    assert.ok(conflict);
    assert.match(conflict.statement, /unmanned for 12 hours/);
  });

  it('finds storage that does not bridge the tanker interval', () => {
    fact('waterStorageHours', 24, 'Water strategy rev A');
    fact('tankerIntervalHours', 48, 'Access restriction — one delivery every other day');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'WATER_AUTONOMY_BELOW_INTERVAL')!;
    assert.ok(conflict);
    assert.match(conflict.statement, /runs dry 24 hours before/);
  });

  it('finds demand above the secured supply', () => {
    fact('maximumDemandKva', 640, 'Load schedule rev C, 0.7 diversity');
    fact('suppliedKva', 400, 'DNO connection offer');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'SUPPLY_BELOW_DEMAND')!;
    assert.ok(conflict);
    assert.match(conflict.statement, /short by 240 kVA/);
    // A grid connection is a lead-time problem before it is a cost one, and the
    // resolution has to say so or somebody prices it and waits four months.
    assert.match(conflict.resolution, /sequence problem before it is a cost one/);
  });

  it('finds more people than beds', () => {
    fact('accommodatedWorkers', 120, 'Workforce origin analysis');
    fact('roomsAvailable', 90, 'Accommodation layout rev A');
    fact('occupancyPerRoom', 1, 'Client rooming policy — single occupancy');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'BEDS_BELOW_DEMAND')!;
    assert.ok(conflict);
    assert.match(conflict.statement, /short by 30/);
    // And it names the knock-on, because moving people to daily travel is not
    // free — it lands on the transport demand.
    assert.match(conflict.resolution, /transport demand/);
  });

  it('is satisfied when a shared rooming policy makes the beds fit', () => {
    fact('accommodatedWorkers', 120, 'Workforce origin analysis');
    fact('roomsAvailable', 90, 'Accommodation layout rev A');
    fact('occupancyPerRoom', 2, 'Client rooming policy — twin');
    assert.equal(briefConflicts(granted()).find((entry) => entry.id === 'BEDS_BELOW_DEMAND'), undefined);
  });

  it('finds more people needing transport than there are seats', () => {
    fact('travellingWorkforce', 96, 'Workforce origin analysis, shift A');
    fact('busSeatsPerShift', 60, 'Transport plan rev A — four 15-seat minibuses');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'SEATS_BELOW_TRAVELLING')!;
    assert.ok(conflict);
    assert.match(conflict.statement, /36 people have no way to site/);
    // Not "add buses" — the alternative is that they drive, and that only works
    // if the parking exists, which is the question this sends somebody to.
    assert.match(conflict.resolution, /whether the parking exists/);
  });

  it('says nothing where the transport covers everybody', () => {
    fact('travellingWorkforce', 60, 'Workforce origin analysis');
    fact('busSeatsPerShift', 60, 'Transport plan rev A');
    assert.equal(briefConflicts(granted()).find((entry) => entry.id === 'SEATS_BELOW_TRAVELLING'), undefined);
  });

  it('finds waste arriving faster than it leaves', () => {
    fact('wasteVolumeM3PerWeek', 48, 'Waste projection at 0.3 m³ per person per week');
    fact('wasteContainerCapacityM3', 12, 'Two 6 m³ skips');
    fact('wasteCollectionsPerWeek', 2, 'Waste carrier contract');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'WASTE_ACCUMULATES')!;
    assert.ok(conflict);
    assert.match(conflict.statement, /24 m³ accumulates/);
    // Material rather than blocking: it degrades over weeks, it does not stop
    // the site on day one, and grading everything the same trains people to
    // ignore all of it.
    assert.equal(conflict.severity, 'MATERIAL');
  });

  it('finds a gate that cannot get the shift on site', () => {
    fact('shiftOverlapPersons', 200, 'Shift plan rev B');
    fact('gateThroughputPerHour', 120, 'Turnstile specification, single lane');
    const conflict = briefConflicts(granted()).find((entry) => entry.id === 'GATE_QUEUE')!;
    assert.ok(conflict);
    assert.match(conflict.statement, /takes 100 minutes/);
  });

  it('says nothing about a gate that keeps up', () => {
    fact('shiftOverlapPersons', 50, 'Shift plan rev B');
    fact('gateThroughputPerHour', 120, 'Turnstile specification');
    assert.equal(briefConflicts(granted()).find((entry) => entry.id === 'GATE_QUEUE'), undefined);
  });
});

describe('the adaptive interview', () => {
  it('asks only what is unanswered', () => {
    const before = briefReadiness(granted()).interview.length;
    assert.equal(before, BRIEF_ITEMS.length, 'an empty brief should ask about everything');

    fact('peakWorkforce', 164);
    const after = briefReadiness(granted()).interview;
    assert.equal(after.length, before - 1);
    assert.ok(!after.some((gap) => gap.itemId === 'peakWorkforce'));
  });

  it('still asks about a value that is only assumed', () => {
    // An assumption is a placeholder, not an answer. Dropping it from the
    // interview is exactly how a provisional value becomes the design.
    assumeFact(granted(), {
      itemId: 'operatingHours',
      value: 24,
      basis: 'Programme shows a night shift',
      decideBy: '2026-09-20',
      owner: 'Tom Bramall',
    });
    assert.ok(briefReadiness(granted()).interview.some((gap) => gap.itemId === 'operatingHours'));
  });

  it('puts the question whose answer runs out first at the top', () => {
    assumeFact(granted(), {
      itemId: 'operatingHours',
      value: 24,
      basis: 'Programme shows a night shift',
      decideBy: '2026-12-01',
      owner: 'Tom Bramall',
    });
    assumeFact(granted(), {
      itemId: 'suppliedKva',
      value: 400,
      basis: 'DNO budget estimate only',
      decideBy: '2026-09-15',
      owner: 'Ruth Adeyemi',
    });

    const interview = briefReadiness(granted()).interview;
    // Both dated items come before everything undated, and the earlier of the
    // two is first. A list ordered by whatever the catalogue happens to say
    // asks the least urgent question first.
    assert.equal(interview[0]!.itemId, 'suppliedKva');
    assert.equal(interview[1]!.itemId, 'operatingHours');
  });
});
