import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FAILURE_CONSEQUENCE,
  demandPosition,
  deploymentExceptions,
  reforecast,
  statutoryWcs,
  type DemandFacts,
} from '../src/engines/maths/demand.ts';

/**
 * §4.1 — the demand and capacity engine.
 *
 * "The engine stores formulas and assumptions, not just final quantities." That
 * sentence is the design, and it is what this file holds to. A platform that
 * recorded "seven WCs" cannot answer the only two questions asked six months
 * later: seven from what, and does it still hold.
 *
 * Four properties:
 *
 * 1. **Nothing computes against a missing input.** A capacity derived from zero
 *    is a number that looks like an answer.
 * 2. **Three capacities, not one.** Normal, peak and continuity are three
 *    different questions that get collapsed into one figure and then argued
 *    about.
 * 3. **Resilience follows the consequence of failure, not a percentage.** The
 *    industry habit of "add 15%" is wrong in both directions at once: it buys a
 *    spare canteen and leaves the potable water on a single tank.
 * 4. **A reduction in the design basis is a proposal, never an outcome.**
 */

const fact = (value: number, status: 'KNOWN' | 'PROVISIONAL' = 'KNOWN') => ({
  value,
  status,
  source: 'Test fixture',
});

/** A brief with everything the engine can use. Tests remove one thing at a time. */
function fullBrief(overrides: DemandFacts = {}): DemandFacts {
  return {
    peakWorkforce: fact(164),
    shiftOverlapPersons: fact(120),
    visitorsPerDay: fact(22),
    peakDurationDays: fact(45),
    plannedGrowthPercent: fact(10),
    connectedLoadKva: fact(900),
    foulTankCapacityM3: fact(20),
    accommodatedWorkers: fact(120),
    cleanableAreaSqm: fact(1800),
    travellingWorkforce: fact(96),
    gateThroughputPerHour: fact(120),
    ...overrides,
  };
}

const find = (facts: DemandFacts, id: string) =>
  demandPosition(facts).derivations.find((derivation) => derivation.id === id);

describe('every derivation keeps its working', () => {
  it('carries a formula, its inputs and its assumptions', () => {
    for (const derivation of demandPosition(fullBrief()).derivations) {
      assert.ok(derivation.formula.length > 10, `${derivation.id} has no formula`);
      assert.ok(derivation.unit.length > 0, `${derivation.id} has no unit`);
      assert.ok(derivation.continuityBasis.length > 20, `${derivation.id} does not say why that reserve`);
      // Either an input or an assumption. A derivation with neither came from
      // nowhere, which is exactly what this engine exists not to produce.
      assert.ok(
        derivation.inputs.length + derivation.assumptions.length > 0,
        `${derivation.id} was derived from nothing`,
      );
      for (const assumption of derivation.assumptions) {
        assert.ok(assumption.basis.length > 20, `${derivation.id}: ${assumption.name} has no stated basis`);
      }
      for (const input of derivation.inputs) {
        // The status travels. A capacity built on a provisional figure is not
        // the same thing as one built on a settled one, and flattening the two
        // is how an assumption becomes the design.
        assert.ok(['KNOWN', 'PROVISIONAL'].includes(input.status));
        assert.ok(input.source.length > 0);
      }
    }
  });

  it('names every input it needed and could not get', () => {
    const position = demandPosition({});
    assert.ok(position.derivations.length === 0, 'something was derived from an empty brief');
    // And says what each one needed rather than simply being absent.
    for (const entry of position.notDerivable) {
      assert.ok(entry.missing.length > 0, `${entry.id} is not derivable and does not say what is missing`);
    }
    assert.ok(position.notDerivable.some((entry) => entry.id === 'concurrentOccupancy'));
  });

  it('computes nothing against a missing input', () => {
    // The failure this prevents: a capacity of zero rendered beside a capacity
    // of seven, both looking like answers.
    const without = demandPosition(fullBrief({ connectedLoadKva: undefined }));
    assert.equal(
      without.derivations.find((derivation) => derivation.id === 'maximumDemand'),
      undefined,
    );
    assert.deepEqual(
      without.notDerivable.find((entry) => entry.id === 'maximumDemand')?.missing,
      ['connectedLoadKva'],
    );
  });
});

describe('the calculation controls', () => {
  it('flags a brief that gives only a total headcount', () => {
    // The specification's first exception. Concurrency is what welfare is sized
    // on, and a headcount has not answered it.
    const only = demandPosition({ peakWorkforce: fact(164) });
    const occupancy = only.derivations.find((derivation) => derivation.id === 'concurrentOccupancy')!;
    assert.equal(occupancy.normal, 164, 'concurrency should fall back to the whole headcount');
    assert.ok(occupancy.exceptions.some((entry) => /Only a total headcount/.test(entry)));
    // And the assumption is on the record rather than in the arithmetic.
    assert.ok(occupancy.assumptions.some((entry) => entry.name === 'concurrency' && entry.value === 1));
  });

  it('separates an event peak from a sustained one', () => {
    const sustained = find(fullBrief({ peakDurationDays: fact(45) }), 'concurrentOccupancy')!;
    assert.ok(!sustained.exceptions.some((entry) => /event peak/.test(entry)));

    const event = find(fullBrief({ peakDurationDays: fact(2) }), 'concurrentOccupancy')!;
    assert.ok(event.exceptions.some((entry) => /event peak, not a sustained one/.test(entry)));
    // And says what to do about it, because "this is an event peak" is not an
    // instruction.
    assert.ok(event.exceptions.some((entry) => /manage the peak with temporary provision/.test(entry)));

    // Unstated is treated as sustained, and says so — it is the expensive
    // assumption and somebody should know they are making it.
    const unstated = find(fullBrief({ peakDurationDays: undefined }), 'concurrentOccupancy')!;
    assert.ok(unstated.exceptions.some((entry) => /treated as sustained/.test(entry)));
  });

  it('applies the peak factor from planned growth', () => {
    const occupancy = find(fullBrief({ plannedGrowthPercent: fact(25) }), 'concurrentOccupancy')!;
    assert.equal(occupancy.normal, 142);
    assert.equal(occupancy.peak, Math.ceil(142 * 1.25));
    assert.ok(occupancy.assumptions.some((entry) => entry.name === 'plannedGrowthPercent' && entry.value === 25));
  });

  it('recommends resilience by consequence of failure, not a blanket percentage', () => {
    const position = demandPosition(fullBrief());
    const water = position.derivations.find((derivation) => derivation.id === 'potableWater')!;
    const waste = position.derivations.find((derivation) => derivation.id === 'wasteVolume')!;
    const cleaning = position.derivations.find((derivation) => derivation.id === 'cleaningHours')!;

    // Losing potable water stops the site; losing a waste collection or a
    // cleaner degrades a shift. They do not get the same reserve.
    assert.equal(water.consequence, 'SITE_STOPS');
    assert.equal(waste.consequence, 'SHIFT_DEGRADED');
    assert.equal(cleaning.consequence, 'SHIFT_DEGRADED');
    assert.ok(water.continuity > 0, 'the site-stopping service has no reserve');
    assert.equal(waste.continuity, 0);
    assert.equal(cleaning.continuity, 0);

    // And the reserve is not a fixed fraction of the demand — which is exactly
    // what "not a blanket percentage" has to mean to be checkable.
    const fractions = position.derivations
      .filter((derivation) => derivation.normal > 0 && derivation.continuity > 0)
      .map((derivation) => derivation.continuity / derivation.normal);
    assert.ok(new Set(fractions.map((value) => Math.round(value * 100))).size > 1, 'every reserve is the same fraction');
  });

  it('sizes water storage to the autonomy the consequence demands', () => {
    const water = find(fullBrief(), 'potableWater')!;
    // 142 concurrent × 50 litres = 7,100 a day; peak is 157 × 50 = 7,850.
    assert.equal(water.normal, 7_100);
    assert.equal(water.peak, 7_850);
    // 48 hours of the peak draw, because losing it stops the site.
    assert.equal(water.continuity, Math.ceil((7_850 * FAILURE_CONSEQUENCE.SITE_STOPS.autonomyHours) / 24));
    assert.match(water.continuityUnit, /48 hours at peak draw/);
  });

  it('raises the autonomy conflict where the tanker cannot keep up', () => {
    const tight = find(fullBrief({ tankerIntervalHours: fact(72) }), 'potableWater')!;
    assert.ok(tight.exceptions.some((entry) => /runs dry on the first missed slot/.test(entry)));
    const fine = find(fullBrief({ tankerIntervalHours: fact(24) }), 'potableWater')!;
    assert.ok(!fine.exceptions.some((entry) => /missed slot/.test(entry)));
  });

  it('holds standby against the critical load, not the whole site', () => {
    const demand = find(fullBrief({ connectedLoadKva: fact(900) }), 'maximumDemand')!;
    // 900 connected × 0.7 diversity = 630 kVA maximum demand.
    assert.equal(demand.normal, 630);
    // A quarter of it standby — fire alarm, emergency lighting, security, comms
    // and welfare. Standby for the whole load is what a blanket percentage buys
    // and nobody can afford.
    assert.equal(demand.continuity, Math.ceil(630 * 0.25));
    assert.ok(demand.continuity < demand.normal / 2);
  });

  it('notices a stated maximum demand that was not derived from the load', () => {
    const disagreeing = find(fullBrief({ maximumDemandKva: fact(400) }), 'maximumDemand')!;
    assert.ok(disagreeing.exceptions.some((entry) => /apart/.test(entry)));
    assert.ok(disagreeing.exceptions.some((entry) => /the load schedule decides which/.test(entry)));

    // And says nothing where the two agree.
    const agreeing = find(fullBrief({ maximumDemandKva: fact(630) }), 'maximumDemand')!;
    assert.ok(!agreeing.exceptions.some((entry) => /apart/.test(entry)));
  });

  it('derives the tanker frequency from the foul volume and the tank', () => {
    const tanker = find(fullBrief({ foulTankCapacityM3: fact(20) }), 'tankerFrequency')!;
    // 7,850 litres a day peak × 0.9 = 7.065 m³, rounded up to 7; × 7 days = 49;
    // ÷ 20 m³ = 2.45, rounded up to 3 attendances a week.
    assert.equal(tanker.peak, 3);
    assert.equal(tanker.continuity, 4, 'no recovery slot in the tanker schedule');
    assert.match(tanker.continuityUnit, /recovery slot/);
  });

  it('refuses a tanker frequency against a tank of nothing', () => {
    const position = demandPosition(fullBrief({ foulTankCapacityM3: fact(0) }));
    assert.equal(
      position.derivations.find((derivation) => derivation.id === 'tankerFrequency'),
      undefined,
    );
    assert.ok(position.notDerivable.some((entry) => entry.id === 'tankerFrequency'));
  });
});

describe('the statutory sanitary table', () => {
  it('follows Schedule 1, Table 1', () => {
    assert.equal(statutoryWcs(0), 0);
    assert.equal(statutoryWcs(5), 1);
    assert.equal(statutoryWcs(6), 2);
    assert.equal(statutoryWcs(100), 5);
    assert.equal(statutoryWcs(142), 7);
    assert.equal(statutoryWcs(164), 8);
  });

  it('sizes sanitary provision on concurrent occupancy and holds one spare', () => {
    const wcs = find(fullBrief(), 'sanitaryProvision')!;
    assert.equal(wcs.normal, statutoryWcs(142));
    assert.equal(wcs.peak, statutoryWcs(157));
    assert.equal(wcs.consequence, 'STATUTORY_BREACH');
    // One spare, so a single failure cannot drop provision below the minimum —
    // which is a different reserve from the water's, for a different reason.
    assert.equal(wcs.continuity, statutoryWcs(142) + 1);
  });
});

describe('the asset deployment curve', () => {
  const windows = [
    { systemId: 'civils', label: 'Enabling civils', fromDate: '2026-10-01', toDate: '2027-06-01', leadDays: 20 },
    { systemId: 'mep', label: 'Temporary MEP', fromDate: '2026-11-01', toDate: '2027-08-01', leadDays: 60 },
    { systemId: 'welfare', label: 'Welfare', fromDate: '2026-11-15', toDate: '2027-09-01', leadDays: 30 },
  ];

  it('finds a service removed before something depending on it', () => {
    // The failure that matters: a cabin off-hired while the fire alarm panel
    // inside it still covers the block next door.
    const exceptions = deploymentExceptions(
      windows,
      [{ from: 'mep', to: 'welfare', note: 'Welfare has no power, water or foul without it.' }],
      '2026-09-01',
    );
    const premature = exceptions.find((entry) => entry.kind === 'PREMATURE_REMOVAL')!;
    assert.ok(premature, 'nothing noticed the MEP leaving before the welfare it feeds');
    assert.match(premature.statement, /2027-08-01/);
    assert.match(premature.statement, /2027-09-01/);
    assert.match(premature.resolution, /Hold it until the dependent service is released/);
  });

  it('says nothing where the dependency outlasts what depends on it', () => {
    const fine = deploymentExceptions(
      [
        { systemId: 'mep', label: 'Temporary MEP', fromDate: '2026-11-01', toDate: '2027-10-01', leadDays: 60 },
        { systemId: 'welfare', label: 'Welfare', fromDate: '2026-11-15', toDate: '2027-09-01', leadDays: 30 },
      ],
      [{ from: 'mep', to: 'welfare', note: 'Welfare has no power without it.' }],
      '2026-09-01',
    );
    assert.equal(fine.find((entry) => entry.kind === 'PREMATURE_REMOVAL'), undefined);
  });

  it('finds a lead time that has already run out', () => {
    const exceptions = deploymentExceptions(windows, [], '2026-10-15');
    // The MEP needs sixty days and there are seventeen left.
    const missed = exceptions.find((entry) => entry.kind === 'LEAD_TIME_MISSED' && entry.systemId === 'mep')!;
    assert.ok(missed);
    assert.match(missed.statement, /needs 60 days/);
    assert.match(missed.resolution, /accept the service is late and say which shift it affects/);
  });

  it('does not call the last service off site stranded', () => {
    // Something has to be last. Reporting it as stranded hire would put a
    // permanent false positive on every job.
    const exceptions = deploymentExceptions(windows, [], '2026-09-01');
    assert.equal(exceptions.find((entry) => entry.kind === 'STRANDED_HIRE'), undefined);
  });
});

describe('reforecasting against what was consumed', () => {
  const derivations = demandPosition(fullBrief()).derivations;

  it('treats a reduction as a proposal that needs approval', () => {
    // The rule that matters: a design basis is not a forecast corrected downward
    // as the meters come in. It is what the service was sized, contracted and
    // priced against.
    const [result] = reforecast(derivations, [
      { derivationId: 'potableWater', observed: 5_000, over: 'the four weeks to 2027-02-01', source: 'Meter M-01' },
    ]);
    assert.ok(result);
    assert.equal(result!.reducesBaseline, true);
    assert.ok(result!.requiresApproval, 'a reduction was proposed with nothing to approve it');
    assert.match(result!.requiresApproval!, /service owner and change control together/);
    assert.match(result!.requiresApproval!, /the basis stands/);
  });

  it('treats an increase as an alert about the basis, not the usage', () => {
    const [result] = reforecast(derivations, [
      { derivationId: 'potableWater', observed: 9_000, over: 'the four weeks to 2027-02-01', source: 'Meter M-01' },
    ]);
    assert.equal(result!.reducesBaseline, false);
    assert.equal(result!.requiresApproval, undefined);
    assert.match(result!.proposal, /the basis, not the usage, is what is wrong/);
  });

  it('reports the variance against the figure it was sized on', () => {
    const [result] = reforecast(derivations, [
      { derivationId: 'potableWater', observed: 7_100 * 1.2, over: 'a week', source: 'Meter M-01' },
    ]);
    assert.equal(result!.basis, 7_100);
    assert.equal(result!.variancePercent, 20);
  });

  it('ignores an observation against a derivation that was never made', () => {
    assert.deepEqual(
      reforecast(derivations, [{ derivationId: 'nothingLikeThis', observed: 10, over: 'a week', source: 'A guess' }]),
      [],
    );
  });
});
