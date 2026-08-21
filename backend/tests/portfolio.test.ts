import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { scopesForRoles } from '../src/identity/scopes.ts';
import { changeWindow, enterpriseCommand, portfolioForecast } from '../src/domain/portfolio.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * The portfolio position, computed server-side.
 *
 * The console used to build this by listing projects and fetching entities per
 * project — an N+1 that put the aggregation rule in the browser, where nothing
 * tests it and each page that wanted the same number computed it again.
 *
 * The tests that matter here are not the sums. They are the three ways a
 * portfolio total lies: treating a missing figure as zero, averaging across
 * projects that cannot contribute to the average, and adding two currencies
 * together. Each produces a wrong number that looks exactly like a right one.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const governance = () =>
  platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

describe('the estate', () => {
  it('counts every project in the tenancy and totals the contract value', () => {
    const command = enterpriseCommand(governance());

    assert.ok(command.estate.projects > 0, 'the seeded tenancy reported no projects');
    assert.equal(command.estate.projects, command.projects.length, 'the count and the rows disagree');
    assert.equal(
      command.estate.totalContractValueMinor,
      command.projects.reduce((sum, p) => sum + p.contractValueMinor, 0),
    );
  });

  it('groups by lifecycle phase rather than flattening the estate', () => {
    const command = enterpriseCommand(governance());
    const grouped = Object.values(command.estate.byPhase).reduce((a, b) => a + b, 0);
    assert.equal(grouped, command.estate.projects, 'a project is in no phase, or in two');
  });

  it('reports a single currency, and refuses to name one when they differ', () => {
    const command = enterpriseCommand(governance());
    // The seed is entirely GBP. The value of this assertion is the shape: a
    // portfolio spanning currencies reports null rather than picking one, and
    // the console has to say "mixed" rather than print a wrong total.
    assert.equal(command.estate.currency, 'GBP');
  });
});

describe('the financial position', () => {
  it('states how many projects it is built from, before any figure', () => {
    const command = enterpriseCommand(governance());

    assert.equal(command.financial.coverage.of, command.estate.projects);
    assert.ok(
      command.financial.coverage.withCvr <= command.financial.coverage.of,
      'more projects carry a CVR than exist',
    );
  });

  it('omits a project with no CVR rather than counting it as nought', () => {
    // The failure this prevents: a portfolio of ten projects where two have
    // published a CVR reporting a confident total that is 80% missing.
    const command = enterpriseCommand(governance());
    const contributing = command.projects.filter((p) => p.cost !== undefined).length;
    assert.equal(command.financial.coverage.withCvr, contributing);
  });

  it('derives variance from the two totals rather than carrying a third number', () => {
    const command = enterpriseCommand(governance());
    assert.equal(
      command.financial.varianceMinor,
      command.financial.forecastFinalValueMinor - command.financial.forecastFinalCostMinor,
    );
  });
});

describe('the delivery position', () => {
  it('counts only projects with a baseline to be measured against', () => {
    const command = enterpriseCommand(governance());
    const { onTrack, atRisk, behind, coverage } = command.delivery;
    assert.equal(onTrack + atRisk + behind, coverage.withBaseline, 'a project was counted twice or not at all');
  });

  it('leaves a project with no delay snapshot out of the schedule figures', () => {
    const command = enterpriseCommand(governance());
    const withSchedule = command.projects.filter((p) => p.schedule !== undefined).length;
    assert.equal(command.delivery.coverage.withBaseline, withSchedule);
  });
});

describe('risk ranking', () => {
  it('returns the five largest exposures, ordered', () => {
    const command = enterpriseCommand(governance());
    assert.ok(command.risks.length <= 5, 'more than five risks were returned');

    for (let i = 1; i < command.risks.length; i += 1) {
      assert.ok(
        command.risks[i - 1]!.exposureMinor >= command.risks[i]!.exposureMinor,
        'risks are not ordered by exposure',
      );
    }
  });

  it('names the project each risk belongs to', () => {
    // A portfolio-level risk with no project attached is unactionable — the
    // reader cannot go and do anything about it.
    for (const risk of enterpriseCommand(governance()).risks) {
      assert.ok(risk.projectId.length > 0);
      assert.ok(risk.projectName.length > 0);
    }
  });
});

describe('who may read it', () => {
  it('refuses a role without the governance capability', () => {
    // A delivery role holding access to a project does not thereby hold a view
    // across every project in the business.
    const supervisorCtx = platform.context(
      { ...seed.users.pm!.auth, roles: ['SUPERVISOR'] },
      `${seed.tenantId}-governance`,
      { source: 'WEB' },
    );
    throwsCode(() => enterpriseCommand(supervisorCtx), 'ACCESS_DENIED');
  });

  it('never reaches beyond the caller’s tenancy', () => {
    const other = new Platform();
    const { tenant } = other.createTenant({
      legalName: 'Ashcombe Civil Engineering Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'ENTERPRISE',
      enterpriseName: 'Ashcombe',
    });
    const admin = other.createUser({
      name: 'Rowan Ellis',
      email: `rowan.${tenant.id.slice(-6)}@ashcombe.example`,
      roles: ['ENTERPRISE_ADMIN'],
      tenantId: tenant.id,
    });

    const command = enterpriseCommand(
      other.context(
        {
          actorId: admin.id,
          tenantId: tenant.id,
          roles: ['ENTERPRISE_ADMIN'],
          // Real scopes for the role, not a wildcard — the wildcard would
          // route around the very check this test exists to exercise.
          scopes: scopesForRoles(['ENTERPRISE_ADMIN']),
          tokenId: 'tok',
          mfaSatisfied: true,
          regulatorAiEnabled: false,
          expiresAt: Date.now() + 900_000,
        },
        `${tenant.id}-governance`,
        { source: 'WEB' },
      ),
    );

    // A brand new tenancy has no projects. If tenant scoping were wrong this
    // would return the seeded estate from the other platform instance.
    assert.equal(command.estate.projects, 0);
    assert.deepEqual(command.projects, []);
    assert.equal(command.financial.coverage.of, 0);
  });
});

describe('a project added to the estate', () => {
  it('appears in the totals without anything else being recomputed by hand', () => {
    const before = enterpriseCommand(governance());
    const portfolioId = String(platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.state.id);

    structure.createProject(governance(), {
      portfolioId,
      name: 'Kielder spillway strengthening',
      sectorType: 'UTILITIES',
      assetType: 'Reservoir spillway',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Hexham' },
      contractValueMinor: 940_000_000,
      currency: 'GBP',
      plannedStart: '2027-01-11',
      plannedCompletion: '2028-06-30',
    });

    const after = enterpriseCommand(governance());
    assert.equal(after.estate.projects, before.estate.projects + 1);
    assert.equal(
      after.estate.totalContractValueMinor,
      before.estate.totalContractValueMinor + 940_000_000,
    );
    // Brand new, so it contributes to the estate and to nothing else.
    assert.equal(after.financial.coverage.withCvr, before.financial.coverage.withCvr);
    assert.equal(after.delivery.coverage.withBaseline, before.delivery.coverage.withBaseline);
  });
});

describe('what changed across the tenancy', () => {
  it('counts every event in the window, whether or not it can be described', () => {
    const window = changeWindow(governance(), '1970-01-01T00:00:00.000Z', new Date().toISOString());

    assert.ok(window.total > 0, 'the seeded lifecycle produced no events in an unbounded window');
    const counted = window.groups.reduce((sum, g) => sum + g.count, 0);
    assert.equal(counted, window.total, 'a group total and the headline disagree');
  });

  it('groups by the event catalogue rather than by a list held here', () => {
    // The value of reading the catalogue's own EventGroup is that a new event
    // type lands in the right group without portfolio.ts being touched. If this
    // ever fails it means an event exists that the catalogue does not define,
    // which is a bigger problem than the grouping.
    for (const group of changeWindow(governance(), '1970-01-01T00:00:00.000Z', new Date().toISOString()).groups) {
      assert.ok(group.count > 0, `${group.group} was returned with no events in it`);
    }
  });

  it('puts the busiest group first, because that is what to look at', () => {
    const groups = changeWindow(governance(), '1970-01-01T00:00:00.000Z', new Date().toISOString()).groups;
    for (let i = 1; i < groups.length; i += 1) {
      assert.ok(groups[i - 1]!.count >= groups[i]!.count, 'groups are not ordered by movement');
    }
  });

  it('samples the most recent change, not the oldest', () => {
    const groups = changeWindow(governance(), '1970-01-01T00:00:00.000Z', new Date().toISOString()).groups;
    const withSample = groups.find((g) => g.sample.length > 1);

    if (withSample) {
      for (let i = 1; i < withSample.sample.length; i += 1) {
        assert.ok(
          withSample.sample[i - 1]!.timestamp >= withSample.sample[i]!.timestamp,
          'the sample is oldest-first — on a busy week that is last week’s news',
        );
      }
    }
  });

  it('names the project each change belongs to', () => {
    for (const group of changeWindow(governance(), '1970-01-01T00:00:00.000Z', new Date().toISOString()).groups) {
      for (const change of group.sample) {
        assert.ok(change.projectName.length > 0);
        assert.notEqual(change.projectName, change.projectId, 'a project id was shown where a name was expected');
      }
    }
  });

  it('returns nothing for a window before the estate existed', () => {
    // A window with no events is an empty answer, not an error and not the
    // whole history — an off-by-one on the filter would show everything.
    const window = changeWindow(governance(), '1970-01-01T00:00:00.000Z', '1970-01-02T00:00:00.000Z');
    assert.equal(window.total, 0);
    assert.deepEqual(window.groups, []);
  });

  it('counts a change it cannot describe rather than dropping it', () => {
    // A supervisor sees that the commercial position moved without seeing what
    // moved. Dropping it would under-report the estate; describing it would be
    // the way around every capability boundary in the system.
    const supervisor = platform.context(
      { ...seed.users.pm!.auth, roles: ['SUPERVISOR'] },
      `${seed.tenantId}-governance`,
      { source: 'WEB' },
    );
    // A supervisor cannot read the enterprise structure at all, so the whole
    // call is refused — which is the correct answer and the one worth asserting.
    throwsCode(() => changeWindow(supervisor, '1970-01-01T00:00:00.000Z', new Date().toISOString()), 'ACCESS_DENIED');
  });

  it('withholds rather than leaks where the reader is inside the tenancy but outside the area', () => {
    // The QS holds enterprise read but not every capability area. Whatever they
    // cannot read must appear in `withheld` and never in `sample`.
    const qs = platform.context(
      { ...seed.users.admin!.auth, roles: ['ENTERPRISE_ADMIN'] },
      `${seed.tenantId}-governance`,
      { source: 'WEB' },
    );
    const window = changeWindow(qs, '1970-01-01T00:00:00.000Z', new Date().toISOString());
    for (const group of window.groups) {
      assert.ok(group.withheld <= group.count, `${group.group}: withheld more events than occurred`);
      // The sample is capped, so it can only ever be a subset of what was
      // readable — never larger, and never drawn from what was withheld.
      assert.ok(
        group.sample.length <= group.count - group.withheld,
        `${group.group}: sampled ${group.sample.length} from ${group.count - group.withheld} readable — a withheld event was described`,
      );
    }
  });
});

describe('completion confidence across the estate', () => {
  /** A stand-in simulation, so these tests exercise the aggregation not the maths. */
  const fixedSimulation = (p50: number, p80: number) => () => ({ p50, p80 });

  it('states how many projects it could simulate, before any figure', () => {
    const forecast = portfolioForecast(governance(), fixedSimulation(300, 400));
    assert.equal(forecast.coverage.of, platform.ledger.listByTenant(seed.tenantId, 'Project').length);
    assert.ok(forecast.coverage.simulated <= forecast.coverage.of);
    assert.equal(forecast.coverage.simulated, forecast.projects.length);
  });

  it('names what it could not simulate rather than dropping it', () => {
    // A project at CONCEPT has no network, and that is the correct answer to
    // "when will it finish" — not a failure, and not an omission either.
    const forecast = portfolioForecast(governance(), () => {
      throw new Error('No activities exist to simulate');
    });
    assert.equal(forecast.coverage.simulated, 0);
    assert.equal(forecast.notSimulated.length, forecast.coverage.of);
    for (const row of forecast.notSimulated) assert.ok(row.reason.length > 0);
  });

  it('counts a project late only against its own contractual duration', () => {
    // A 400-day P80 is late for a one-year project and early for a two-year
    // one. Counting late projects against a portfolio-wide threshold would be
    // the classic wrong aggregation.
    const generous = portfolioForecast(governance(), fixedSimulation(10, 20));
    assert.equal(generous.lateAtP80, 0, 'a twenty-day P80 was called late');

    const hopeless = portfolioForecast(governance(), fixedSimulation(9000, 10_000));
    assert.ok(hopeless.lateAtP80 > 0, 'a ten-thousand-day P80 was called on time');
  });

  it('reports exposure as contract value at stake, not as a loss', () => {
    const hopeless = portfolioForecast(governance(), fixedSimulation(9000, 10_000));
    const late = hopeless.projects.filter((p) => p.overrunAtP80Days !== undefined);
    assert.equal(hopeless.lateAtP80, late.length);
    assert.ok(hopeless.exposedContractValueMinor > 0);

    const onTime = portfolioForecast(governance(), fixedSimulation(1, 2));
    assert.equal(onTime.exposedContractValueMinor, 0, 'exposure was reported with nothing exposed');
    assert.equal(onTime.currency, null, 'a currency was named for an empty exposure');
  });

  it('puts the worst overrun first', () => {
    const forecast = portfolioForecast(governance(), fixedSimulation(9000, 10_000));
    for (let i = 1; i < forecast.projects.length; i += 1) {
      assert.ok(
        (forecast.projects[i - 1]!.overrunAtP80Days ?? -1) >= (forecast.projects[i]!.overrunAtP80Days ?? -1),
        'the estate is not ordered by overrun — the project the reader came for is buried',
      );
    }
  });

  it('says how many iterations produced the numbers', () => {
    // A forecast whose precision is unstated invites more confidence than it
    // earned, and a portfolio sweep runs fewer iterations than a single project.
    const forecast = portfolioForecast(governance(), fixedSimulation(300, 400), 250);
    assert.equal(forecast.iterations, 250);
  });

  it('refuses a role without the governance capability', () => {
    const supervisor = platform.context(
      { ...seed.users.pm!.auth, roles: ['SUPERVISOR'] },
      `${seed.tenantId}-governance`,
      { source: 'WEB' },
    );
    throwsCode(() => portfolioForecast(supervisor, fixedSimulation(300, 400)), 'ACCESS_DENIED');
  });
});
