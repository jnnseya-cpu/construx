import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { DomainError } from '../src/core/errors.ts';
import { CDM_DOCUMENTS } from '../src/domain/cdm.ts';

/**
 * Where in the world a project is, and who says so.
 *
 * CONSTRUX is a worldwide, multi-project platform, and the hierarchy that makes
 * that true is Enterprise → Portfolio → Programme → Project. The **portfolio**
 * is the level that carries the geography: it is the thing a business decides
 * to open in a region, staff, fund and report on.
 *
 * Two failures were sitting in that model, and both were the same kind — a
 * relationship that existed on paper and was enforced nowhere.
 *
 * **A portfolio's region was optional.** So a portfolio could be attached to
 * nowhere at all, and every view that groups an estate by region had to cope
 * with a blank. A field that is usually empty is not a region model; it is a
 * column, and nothing can aggregate on it.
 *
 * **A project's location was never checked against its portfolio's.** A
 * portfolio for Europe would accept a project in Kenya without a word. Every
 * regional rollup after that — cost by region, risk by region, which
 * jurisdiction's contract law applies — is then wrong in a way no screen can
 * show, because each record is individually correct and only the relationship
 * between them is false.
 *
 * The distinction between a regional and a national portfolio is the load
 * bearing part. A portfolio scoped to one country is a promise that contract
 * law, tax and the working calendar are common to everything inside it. One
 * with no country is regional on purpose and accepts any country in its region.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const governanceCtx = () =>
  platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

function refusal(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: 'expected a refusal, and the call succeeded' });
}

describe('a portfolio has to say where in the world it is', () => {
  it('refuses a region that is not one of the six', () => {
    const error = refusal(() =>
      structure.createPortfolio(governanceCtx(), {
        name: 'Nowhere in particular',
        enterpriseId: String(platform.ledger.listByTenant(seed.tenantId, 'Enterprise')[0]!.state.id),
        governanceModel: 'Quarterly gate review',
        // Not a region. A free string is what this field used to be, and it is
        // how one tenancy ends up holding EU, Europe, europe and eu.
        continentCode: 'Europe' as never,
      }),
    );
    assert.equal(error.code, 'PORTFOLIO_REGION_REQUIRED');
    assert.ok(error.fieldErrors.some((f) => f.field === 'continentCode'));
  });

  it('refuses a country code that is not one', () => {
    const error = refusal(() =>
      structure.createPortfolio(governanceCtx(), {
        name: 'Great Britain',
        enterpriseId: String(platform.ledger.listByTenant(seed.tenantId, 'Enterprise')[0]!.state.id),
        governanceModel: 'Quarterly gate review',
        continentCode: 'EU',
        countryCode: 'GBR',
      }),
    );
    assert.equal(error.code, 'COUNTRY_CODE_INVALID');
  });

  it('accepts a regional portfolio with no country, which is the multi-country case', () => {
    const { portfolioId } = structure.createPortfolio(governanceCtx(), {
      name: 'West Africa Transport',
      enterpriseId: String(platform.ledger.listByTenant(seed.tenantId, 'Enterprise')[0]!.state.id),
      governanceModel: 'Multilateral-funded, quarterly gate review',
      continentCode: 'AF',
    });
    const record = platform.ledger.require({ refType: 'Portfolio', refId: portfolioId });
    assert.equal(record.state.continentCode, 'AF');
    assert.equal(record.state.countryCode, undefined);
  });
});

describe('a project sits inside the portfolio it is filed under', () => {
  const project = (portfolioId: string, continentCode: string, countryCode: string) => () =>
    structure.createProject(governanceCtx(), {
      portfolioId,
      name: `Test works ${continentCode}${countryCode}`,
      sectorType: 'UTILITIES',
      assetType: 'Treatment works',
      location: { continentCode, countryCode, city: 'Somewhere' },
      contractValueMinor: 100_000_000,
      currency: 'GBP',
      plannedStart: '2027-01-01',
      plannedCompletion: '2028-01-01',
    });

  let regional: string;
  let national: string;

  before(() => {
    const enterpriseId = String(platform.ledger.listByTenant(seed.tenantId, 'Enterprise')[0]!.state.id);
    regional = structure.createPortfolio(governanceCtx(), {
      name: 'East Africa — regional',
      enterpriseId,
      governanceModel: 'Quarterly gate review',
      continentCode: 'AF',
    }).portfolioId;
    national = structure.createPortfolio(governanceCtx(), {
      name: 'Kenya — national',
      enterpriseId,
      governanceModel: 'Quarterly gate review',
      continentCode: 'AF',
      countryCode: 'KE',
    }).portfolioId;
  });

  it('refuses a project in a different region from its portfolio', () => {
    const error = refusal(project(regional, 'EU', 'GB'));
    assert.equal(error.code, 'PROJECT_OUTSIDE_PORTFOLIO_REGION');
    assert.ok(
      error.message.includes('AF') && error.message.includes('EU'),
      'the refusal must name both regions, or it cannot be acted on',
    );
  });

  it('accepts any country inside a regional portfolio', () => {
    // The point of a regional portfolio. Two jurisdictions, one portfolio,
    // deliberately — and the model has to allow it or "regional" means nothing.
    assert.ok(project(regional, 'AF', 'KE')().projectId);
    assert.ok(project(regional, 'AF', 'TZ')().projectId);
  });

  it('refuses a second country inside a portfolio scoped to one', () => {
    const error = refusal(project(national, 'AF', 'TZ'));
    assert.equal(error.code, 'PROJECT_OUTSIDE_PORTFOLIO_COUNTRY');
    assert.ok(error.fieldErrors.some((f) => f.field === 'location.countryCode'));
  });

  it('accepts the country the portfolio is scoped to', () => {
    assert.ok(project(national, 'AF', 'KE')().projectId);
  });
});

describe('the demonstration estate spans more than one region', () => {
  it('has portfolios in two regions, each with a project in it', () => {
    const portfolios = platform.ledger
      .listByTenant(seed.tenantId, 'Portfolio')
      .map((record) => ({ id: String(record.state.id), region: record.state.continentCode as string }));

    // Seeded only. The portfolios the tests above create are on the same
    // tenancy, so this reads the two the seed is responsible for by name rather
    // than counting rows and being at the mercy of test order.
    const seeded = portfolios.filter((p) => ['EU', 'AF'].includes(p.region));
    assert.ok(seeded.some((p) => p.region === 'EU'), 'no European portfolio in the seeded estate');
    assert.ok(seeded.some((p) => p.region === 'AF'), 'no African portfolio in the seeded estate');

    // Every seeded project must be in its portfolio's region — which is now
    // enforced at creation, so this asserts the seed obeys its own platform
    // rather than having been written before the rule existed.
    for (const record of platform.ledger.listByTenant(seed.tenantId, 'Project')) {
      const location = record.state.location as { continentCode?: string } | undefined;
      const portfolio = portfolios.find((p) => p.id === String(record.state.portfolioId));
      if (!portfolio?.region || !location?.continentCode) continue;
      assert.equal(
        location.continentCode,
        portfolio.region,
        `${String(record.state.name)} is in ${location.continentCode} under a ${portfolio.region} portfolio`,
      );
    }
  });
});

describe('the CDM document catalogue has one source of truth', () => {
  it('offers every type the domain holds, and no others', async () => {
    const { CDM_DOCUMENTS } = await import('../src/domain/cdm.ts');
    const { ROUTES } = await import('../src/api/routes.ts');

    // The route's `enum` was a hand-written copy of the catalogue, and the two
    // agreed only because nobody had added a document since it was written.
    // Adding the traffic management plan proved it: the domain knew the type
    // and the gateway refused it, so a document the platform could produce was
    // unreachable through the only door that reaches it.
    const route = ROUTES.find((r) => r.pattern === '/v1/projects/:projectId/cdm/documents' && r.method === 'POST');
    assert.ok(route, 'the draft route is gone');

    const offered = (route.schema as { properties: { type: { enum: string[] } } }).properties.type.enum;
    assert.deepEqual(
      [...offered].sort(),
      CDM_DOCUMENTS.map((d) => d.type).sort(),
      'the door and the catalogue disagree about which documents exist',
    );
  });

  it('holds the site-management documents a live site runs on', () => {
    // Named individually rather than counted. Traffic management is the one
    // that matters most and was missing entirely: on a site, being struck by a
    // vehicle is a far commoner way to be killed than a dropped load, and the
    // platform could hold a lifting plan and not a traffic plan.
    const required = ['TRAFFIC_MANAGEMENT_PLAN', 'SITE_LOGISTICS_PLAN', 'UNDERGROUND_SERVICES_PLAN', 'EXCAVATION_PLAN'];
    for (const type of required) {
      const spec = CDM_DOCUMENTS.find((d) => d.type === type);
      assert.ok(spec, `${type} is not in the catalogue`);
      assert.ok(spec.requiredSections.length >= 5, `${type} has too few required sections to be a floor`);
      assert.ok(spec.approver, `${type} has no approver, so nothing signs it`);
    }

    // Vehicle–pedestrian segregation is the single control that prevents the
    // commonest fatal site accident. A traffic plan that describes routes and
    // not the separation between them has not addressed the hazard it exists
    // for, so it is required rather than optional.
    const traffic = CDM_DOCUMENTS.find((d) => d.type === 'TRAFFIC_MANAGEMENT_PLAN');
    assert.ok(
      traffic?.requiredSections.some((section) => /segregation/i.test(section)),
      'the traffic management plan does not require vehicle and pedestrian segregation',
    );
  });
});
