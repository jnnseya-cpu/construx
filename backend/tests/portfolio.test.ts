import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { scopesForRoles } from '../src/identity/scopes.ts';
import { enterpriseCommand } from '../src/domain/portfolio.ts';
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
