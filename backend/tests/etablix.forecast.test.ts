import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { forecastAccuracy, snapshotForecast } from '../src/domain/etablix/cash.ts';
import { progressChange, raiseChange } from '../src/domain/etablix/change.ts';
import { automationMeasure } from '../src/domain/etablix/commandcentre.ts';
import { certifyValuation, openLine, openValuation, recordAcceptedProgress, recordApplication } from '../src/domain/etablix/commercial.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { acceptWorkstream, openWorkstream, recordDemobEvidence } from '../src/domain/etablix/demobilisation.ts';
import { createPackage } from '../src/domain/etablix/procurement.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §17 forecast accuracy: a prior estimate at completion against the final
 * outturn, separated into approved change and customer-driven change.
 *
 * Two properties. Nothing is measured while the account is open, because a
 * live forecast compared against itself is always right. And once it is
 * closed, the variance of each frozen forecast is split into the change agreed
 * after it — the customer's instructions and the other triggers separately —
 * and the error the forecaster actually owns.
 */

let platform: Platform;
let seed: SeedResult;
const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId);
const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

let lineId = '';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({ moduleId: 'ETABLIX', tenantId: seed.tenantId, status: 'ACTIVE', reason: 'Appointed as ETABLIX site-services delivery partner', decidedBy: seed.users.operator!.id });
  setAppointment(as('pm'), { model: 'PRINCIPAL_SERVICE_CONTRACTOR', contractingEntity: 'Meridian Infrastructure Group Ltd', fundingSource: 'Client capital programme', basis: 'Single-point accountability across all seven families' });
  for (const [itemId, value] of [['peakWorkforce', 164], ['shiftOverlapPersons', 120], ['visitorsPerDay', 22], ['accommodatedWorkers', 120], ['cleanableAreaSqm', 1800]] as [string, number][]) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
  }
});

describe('freezing a forecast', () => {
  it('refuses to freeze an EAC over nothing', () => {
    throwsCode(() => snapshotForecast(as('qs')), 'FORECAST_NOTHING_TO_FREEZE');
  });

  it('records the estimate at completion with every term, and is not yet measurable', () => {
    const { system, interfaces } = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
    for (const entry of interfaces) {
      assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
      acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
    }
    const pack = createPackage(as('pm'), { title: 'Welfare and accommodation', systemIds: [system.id] });
    const line = openLine(as('qs'), { packageId: pack.id, description: 'Welfare cabin hire, 44 weeks', budgetMinor: 440_000_00, commitmentMinor: 440_000_00, currency: 'GBP', method: 'TIME', contractWeeks: 44, systemId: system.id });
    lineId = line.id;

    const first = snapshotForecast(as('qs'), { note: 'Month one, before any change' });
    assert.equal(first.eacMinor, 440_000_00, 'the commitment, with no change and no exposure');
    assert.equal(first.terms.length, 3);
    assert.equal(first.agreedChangeMinor, 0);

    const held = forecastAccuracy(as('qs'));
    assert.equal(held.measurable, false);
    assert.equal(held.snapshots.length, 1);
    assert.match(held.basis, /Not measurable yet: 1 snapshot held/);
    assert.equal(held.snapshots[0]!.varianceMinor, undefined, 'no variance is reported against an open account');

    const metric = automationMeasure(as('qs')).metrics.find((entry) => entry.id === 'FORECAST_ACCURACY')!;
    assert.equal(metric.value, undefined);
    assert.match(metric.basis, /Not measurable yet/);
  });
});

describe('measuring against the final account', () => {
  it('splits each snapshot’s variance into customer change, other change and the forecaster’s own error', () => {
    // The customer instructs a second drying room, agreed at £40,000; a
    // supplier failure is agreed at £10,000. Both after the first snapshot.
    const customer = raiseChange(as('qs'), { trigger: 'CUSTOMER_INSTRUCTION', summary: 'A second drying room', difference: 'One drying room in the baseline; two instructed.', entitlement: 'CLEAR', probabilityPercent: 90, valueMinor: 40_000_00 });
    for (const to of ['NOTIFIED', 'QUOTED', 'INSTRUCTED', 'AGREED']) progressChange(as('pm'), { changeId: customer.id, to, basis: `${to} on the instruction` });
    const supplier = raiseChange(as('qs'), { trigger: 'SUPPLIER_FAILURE', summary: 'Replacement cabin supplier', difference: 'The first supplier withdrew; the replacement is dearer.', entitlement: 'NONE', probabilityPercent: 100, valueMinor: 10_000_00 });
    for (const to of ['NOTIFIED', 'QUOTED', 'INSTRUCTED', 'AGREED']) progressChange(as('pm'), { changeId: supplier.id, to, basis: `${to} on the failure` });

    const second = snapshotForecast(as('qs'), { note: 'After both changes were agreed' });
    assert.equal(second.agreedChangeMinor, 50_000_00);
    assert.equal(second.eacMinor, 490_000_00);

    // The whole service is delivered and certified: 44 weeks accepted.
    recordAcceptedProgress(as('pm'), { lineId, periodTo: '2027-09-01', accepted: 44, evidence: 'Hire dockets W1–W44' });
    const valuation = openValuation(as('qs'), { periodFrom: '2026-11-01', periodTo: '2027-09-01' });
    recordApplication(as('qs'), { valuationId: valuation.id, lines: [{ lineId, claimed: 44, narrative: 'The whole hire' }] });
    const certified = certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Final account: forty-four weeks accepted' });
    assert.equal(certified.certifiedMinor, 440_000_00);

    // Still open until the closeout is accepted.
    assert.equal(forecastAccuracy(as('qs')).measurable, false);

    const record = openWorkstream(as('pm'), { workstream: 'TEMPORARY_CIVILS' });
    recordDemobEvidence(as('pm'), { recordId: record.id, reference: 'SUR-2027-088', description: 'As-left survey against the pre-occupation condition record' });
    recordDemobEvidence(as('pm'), { recordId: record.id, reference: 'WTN-4471 to WTN-4488', description: 'Waste transfer notes to the licensed transfer station' });
    acceptWorkstream(as('pm'), { recordId: record.id, note: 'Hardstanding broken out, drainage capped, land returned to CS-01' });

    const measured = forecastAccuracy(as('qs'));
    assert.equal(measured.measurable, true);
    assert.equal(measured.outturnMinor, 440_000_00);
    const [first, latest] = measured.snapshots;
    assert.equal(first!.varianceMinor, 0, 'the first forecast landed exactly on the certified outturn');
    assert.equal(first!.customerChangeMinor, 40_000_00, 'the customer’s instruction was agreed after it');
    assert.equal(first!.otherChangeMinor, 10_000_00, 'so was the supplier failure');
    assert.equal(first!.forecastErrorMinor, 50_000_00, 'with the agreed change taken out, the forecast was £50,000 light of the account it should have carried');
    assert.equal(latest!.varianceMinor, 50_000_00, 'the second forecast carried the change the certificate never did');
    assert.equal(latest!.customerChangeMinor, 0);
    assert.equal(latest!.forecastErrorMinor, 50_000_00);
    assert.equal(measured.meanAbsoluteErrorPercent, 11.4);
    assert.match(measured.basis, /customer instructions and the other five triggers separately/);

    const metric = automationMeasure(as('qs')).metrics.find((entry) => entry.id === 'FORECAST_ACCURACY')!;
    assert.equal(metric.value, 88.6);
  });

  it('withholds the measure from a reader without commercial standing rather than showing a number', () => {
    const metric = automationMeasure(as('siteManager')).metrics.find((entry) => entry.id === 'FORECAST_ACCURACY')!;
    assert.equal(metric.value, undefined);
    assert.match(metric.basis, /Withheld/);
  });
});
