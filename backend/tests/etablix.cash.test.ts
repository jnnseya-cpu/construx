import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import {
  cashPosition,
  drawContingency,
  estimateAtCompletion,
  portfolioRollUp,
  recordPayment,
  setContingency,
} from '../src/domain/etablix/cash.ts';
import {
  certifyValuation,
  openLine,
  openValuation,
  recordAcceptedProgress,
  recordApplication,
} from '../src/domain/etablix/commercial.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { createPackage, statePackageField } from '../src/domain/etablix/procurement.ts';
import * as structure from '../src/domain/structure.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §13 Commercial's two missing answers and the executive roll-up: money paid
 * against a certificate, the pot and the estimate at completion, and every
 * project of the company at once.
 */

let platform: Platform;
let seed: SeedResult;
let projectId = '';

const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, projectId);

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

/** A real project on the seeded tenancy, so the roll-up can find it. */
function realProject(name: string): string {
  const governance = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');
  return structure.createProject(governance, {
    portfolioId: String(portfolios[0]!.state.id),
    name,
    sectorType: 'TRANSPORT',
    assetType: 'Compound',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Derby' },
    contractValueMinor: 5_000_000_00,
    currency: 'GBP',
    plannedStart: '2026-11-01',
    plannedCompletion: '2027-09-01',
  }).projectId;
}

function appointed(): void {
  setAppointment(as('pm'), {
    model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'Single-point accountability across all seven families',
  });
  for (const [itemId, value] of [
    ['peakWorkforce', 164],
    ['shiftOverlapPersons', 120],
    ['visitorsPerDay', 22],
    ['accommodatedWorkers', 120],
    ['cleanableAreaSqm', 1800],
  ] as [string, number][]) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
  }
}

function certifiedLine(): { lineId: string; valuationId: string; certifiedMinor: number } {
  const { system, interfaces } = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
  for (const entry of interfaces) {
    assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
  }
  const pkg = createPackage(as('pm'), { title: 'Welfare and accommodation', systemIds: [system.id] });
  statePackageField(as('pm'), { packageId: pkg.id, field: 'scope', value: 'Supply, service and remove all welfare units' });
  const line = openLine(as('pm'), {
    packageId: pkg.id,
    systemId: system.id,
    description: 'Welfare cabin hire, 40 weeks',
    budgetMinor: 200_000_00,
    commitmentMinor: 200_000_00,
    currency: 'GBP',
    method: 'TIME',
    contractWeeks: 40,
  });
  recordAcceptedProgress(as('pm'), { lineId: line.id, periodTo: '2027-01-31', accepted: 10, evidence: 'Hire dockets W1–W10' });
  const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
  recordApplication(as('pm'), { valuationId: valuation.id, lines: [{ lineId: line.id, claimed: 10, narrative: 'Ten weeks' }] });
  const certified = certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Ten weeks accepted against dockets' });
  return { lineId: line.id, valuationId: certified.id, certifiedMinor: certified.certifiedMinor ?? 0 };
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
  projectId = realProject('Cash and forecast');
  appointed();
});

describe('paid, accrual and cash', () => {
  let valuationId = '';
  let certifiedMinor = 0;

  it('records a payment against a certified valuation under the bank’s reference, and never above it', () => {
    const line = certifiedLine();
    valuationId = line.valuationId;
    certifiedMinor = line.certifiedMinor;
    assert.ok(certifiedMinor > 0, 'the fixture certifies something');

    const first = recordPayment(as('pm'), { valuationId, amountMinor: Math.floor(certifiedMinor / 2), reference: 'BACS-0001' });
    assert.equal(first.alreadyRecorded, false);
    const again = recordPayment(as('pm'), { valuationId, amountMinor: Math.floor(certifiedMinor / 2), reference: 'BACS-0001' });
    assert.equal(again.alreadyRecorded, true, 'the same reference records once');
    throwsCode(() => recordPayment(as('pm'), { valuationId, amountMinor: 100, reference: 'BACS-0001' }), 'PAYMENT_REFERENCE_CONFLICT');
    throwsCode(() => recordPayment(as('pm'), { valuationId, amountMinor: certifiedMinor, reference: 'BACS-0002' }), 'OVERPAYMENT');
  });

  it('keeps earned, certified and paid apart', () => {
    const cash = cashPosition(as('pm'));
    const own = cash.valuations.find((entry) => entry.id === valuationId)!;
    assert.equal(own.paidMinor, Math.floor(certifiedMinor / 2));
    assert.equal(own.outstandingMinor, certifiedMinor - Math.floor(certifiedMinor / 2));
    assert.equal(own.payer, 'ETABLIX', 'under Prime, ETABLIX owes the supplier');
    assert.equal(cash.totals.certifiedMinor, certifiedMinor);
    assert.equal(cash.totals.paidMinor, own.paidMinor);
    assert.equal(cash.totals.outstandingMinor, own.outstandingMinor);
    assert.equal(cash.totals.outstandingByPayer.ETABLIX, own.outstandingMinor);
    assert.equal(cash.totals.accruedMinor, Math.max(0, cash.totals.earnedMinor - certifiedMinor));
    assert.match(cash.statement, /paid against/);
  });

  it('refuses money against a valuation that is not certified', () => {
    const open = openValuation(as('pm'), { periodFrom: '2027-02-01', periodTo: '2027-02-28' });
    throwsCode(() => recordPayment(as('pm'), { valuationId: open.id, amountMinor: 100, reference: 'BACS-0003' }), 'VALUATION_NOT_CERTIFIED');
  });
});

describe('contingency and the estimate at completion', () => {
  it('sets a pot with its basis, draws with a reason, and never beyond what remains', () => {
    throwsCode(() => drawContingency(as('pm'), { amountMinor: 100, reason: 'Nothing to draw from yet' }), 'NO_CONTINGENCY');
    throwsCode(() => setContingency(as('pm'), { potMinor: 10_000_00, basis: 'because' }), 'BASIS_REQUIRED');
    const pot = setContingency(as('pm'), { potMinor: 10_000_00, basis: '5% of the welfare commitment, per the control standard' });
    assert.equal(pot.potMinor, 10_000_00);
    const drawn = drawContingency(as('pm'), { amountMinor: 4_000_00, reason: 'Second drying room after the induction count rose' });
    assert.equal(drawn.draws.length, 1);
    throwsCode(() => drawContingency(as('pm'), { amountMinor: 7_000_00, reason: 'More than the pot has left in it' }), 'CONTINGENCY_EXHAUSTED');
    throwsCode(() => setContingency(as('pm'), { potMinor: 3_000_00, basis: 'Cut below what has already been drawn' }), 'POT_BELOW_DRAWS');
  });

  it('publishes every term of the estimate at completion beside the total', () => {
    const eac = estimateAtCompletion(as('pm'));
    assert.equal(eac.contingencyPotMinor, 10_000_00);
    assert.equal(eac.contingencyDrawnMinor, 4_000_00);
    assert.equal(eac.contingencyRemainingMinor, 6_000_00);
    assert.equal(eac.eacMinor, Math.max(eac.commitmentMinor, eac.earnedMinor) + eac.agreedChangeMinor + eac.exposureMinor);
    assert.equal(eac.headroomMinor, eac.budgetMinor + eac.contingencyPotMinor - eac.eacMinor);
    assert.equal(eac.terms.length, 3);
    assert.equal(eac.terms.reduce((sum, term) => sum + term.amountMinor, 0), eac.eacMinor, 'the terms add up to the total');
    assert.match(eac.statement, /Estimate at completion/);
  });
});

describe('the portfolio roll-up', () => {
  it('sums every readable project of the company and names the ones it skipped', () => {
    const rollUp = portfolioRollUp(platform, seed.users.pm!.auth);
    const own = rollUp.projects.find((entry) => entry.projectId === projectId);
    assert.ok(own, 'the project with a position is in the roll-up');
    assert.equal(own.name, 'Cash and forecast');
    assert.ok(own.certifiedMinor > 0);
    assert.ok(own.paidMinor > 0);
    assert.equal(rollUp.totals.certifiedMinor, rollUp.projects.reduce((sum, entry) => sum + entry.certifiedMinor, 0));
    // The seeded project has nothing appointed, so it is skipped with the reason, not summed as zero.
    const skipped = rollUp.skipped.find((entry) => entry.projectId === seed.projectId);
    assert.ok(skipped, 'the unappointed seeded project is listed as skipped');
    assert.match(skipped.because, /SITE_SERVICES_NOT_APPOINTED|APPOINT|appointed/i);
    assert.match(rollUp.statement, /estimate at completion/);
  });

  it('is scoped to the caller’s own company', () => {
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    const outsider = platform.createTenant({ legalName: 'Elsewhere Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Elsewhere' });
    const admin = platform.createUser({ tenantId: outsider.tenant.id, name: 'Admin', email: 'admin@elsewhere.example', roles: ['ENTERPRISE_ADMIN'] });
    void operator;
    const theirs = portfolioRollUp(platform, authOf(platform, admin.id));
    assert.equal(theirs.projects.length, 0);
    assert.ok(!theirs.skipped.some((entry) => entry.projectId === projectId), 'another company’s project is not even named');
  });
});
