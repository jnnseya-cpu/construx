import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { recordPayment } from '../src/domain/etablix/cash.ts';
import {
  certifyValuation,
  openLine,
  openValuation,
  recordAcceptedProgress,
  recordApplication,
} from '../src/domain/etablix/commercial.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { linkedSupplier, supplierPortal } from '../src/domain/etablix/portal.ts';
import {
  advanceEngagement,
  createPackage,
  engageSupplier,
  lockReturn,
  openPackageTender,
  procurementPosition,
  recommendAward,
  recordBid,
  scheduleFor,
  statePackageField,
  type ServiceBidLine,
} from '../src/domain/etablix/procurement.ts';
import { acceptInvitation, inviteToProject } from '../src/domain/invitation.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §13 Supplier Portal, the supplier's own sign-in.
 *
 * Three properties. A supplier identity is linked to its firm by the
 * invitation that created it, through the party the register already holds.
 * A signed-in supplier sees their own firm and is refused any other, whatever
 * the request names. And the payment state they see is their own lines under
 * award, with what was paid on a shared certificate apportioned and said so.
 */

let platform: Platform;
let seed: SeedResult;
let projectId = '';

const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, projectId);
const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

type Registered = { id: string; legalName: string; status: string; partyId?: string };
function approvedSuppliers(): Registered[] {
  return platform.ledger
    .listByTenant(seed.tenantId, 'Supplier')
    .map((record) => record.state as unknown as Registered)
    .filter((entry) => ['APPROVED', 'STRATEGIC', 'CONDITIONAL'].includes(entry.status));
}

const CLEAN_BASIS = {
  currency: 'GBP',
  taxBasis: 'EXCLUSIVE' as const,
  hirePeriodWeeks: 44,
  workingHours: '0700–1900, six days',
  transport: 'Delivered to site',
  mobilisationIncluded: true,
  demobilisationIncluded: true,
  consumablesIncluded: true,
  standbyIncluded: true,
  supervisionIncluded: true,
  reinstatementIncluded: true,
};
const line = (itemId: string, quantity: number, rateMinor: number): ServiceBidLine => ({ scheduleItemId: itemId, description: itemId, quantity, unit: 'unit', rateMinor });

/** A package awarded to the cheapest prequalified firm, taken to Contracted under Management Integrator. */
function awarded(): { packageId: string; winner: Registered; loser: Registered; systemId: string } {
  const { system, interfaces } = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'Main compound', ...WINDOW });
  for (const entry of interfaces) {
    assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
  }
  const pack = createPackage(as('pm'), { title: 'Welfare and accommodation', systemIds: [system.id] });
  for (const [field, value] of Object.entries({
    scope: 'In: supply, delivery, install, service and removal of all welfare units. Out: the compound platform.',
    drawings: 'WEL-100 rev C compound layout; WEL-210 rev B unit schedule',
    kpis: 'Availability 99% of shift hours; cleaning to schedule A',
    evidence: 'Weekly service sheets, water temperature log, waste transfer notes',
    acceptance: 'All units set, connected, tested and handed over with the O&M file',
    pricingMethod: 'Schedule of rates, remeasurable on the workforce curve',
    changeMechanism: 'Instructed change valued at the schedule rates',
  })) {
    statePackageField(as('pm'), { packageId: pack.id, field, value });
  }
  openPackageTender(as('pm'), { packageId: pack.id, returnDeadline: '2026-10-30' });
  const schedule = scheduleFor(as('pm'), procurementPosition(as('pm')).packages.find((entry) => entry.id === pack.id)!);
  const bidders = approvedSuppliers().slice(0, 2);
  assert.equal(bidders.length, 2, 'the demonstration register holds two prequalified firms to compete');
  bidders.forEach((supplier, index) => {
    const bid = recordBid(as('qs'), {
      packageId: pack.id,
      supplierId: supplier.id,
      supplierName: supplier.legalName,
      lines: schedule.map((entry) => line(entry.itemId, entry.quantity, 1_000_00 + index * 100_00)),
      basis: CLEAN_BASIS,
      technicalScore: 70,
    });
    lockReturn(as('qs'), { bidId: bid.id, acknowledgedBy: `Commercial manager, ${supplier.legalName}` });
  });
  const award = recommendAward(as('pm'), pack.id);
  const winner = bidders.find((entry) => entry.id === award.recommended!.supplierId)!;
  const loser = bidders.find((entry) => entry.id !== winner.id)!;
  const engagement = engageSupplier(as('pm'), { packageId: pack.id, supplierId: winner.id, supplierName: winner.legalName });
  for (const state of ['PREQUALIFIED', 'TENDERING', 'PREFERRED', 'CONTRACTED']) {
    advanceEngagement(as('pm'), { engagementId: engagement.id, to: state });
  }
  engageSupplier(as('pm'), { packageId: pack.id, supplierId: loser.id, supplierName: loser.legalName });
  return { packageId: pack.id, winner, loser, systemId: system.id };
}

let winner: Registered;
let loser: Registered;
let packageId = '';
let supplierUserId = '';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  projectId = seed.projectId;
  platform.setModuleGrant({
    moduleId: 'ETABLIX',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Appointed as ETABLIX site-services delivery partner',
    decidedBy: seed.users.operator!.id,
  });
  setAppointment(as('pm'), {
    model: 'MANAGEMENT_INTEGRATOR',
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'The customer holds the supplier contracts; ETABLIX coordinates',
  });
  for (const [itemId, value] of [['peakWorkforce', 164], ['shiftOverlapPersons', 120], ['visitorsPerDay', 22], ['accommodatedWorkers', 120], ['cleanableAreaSqm', 1800]] as [string, number][]) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
  }
  ({ winner, loser, packageId } = awarded());
});

describe('a supplier identity is linked to its firm by the invitation that created it', () => {
  it('gives the accepted identity the firm’s party, and refuses a link to anybody who is not an external supplier', () => {
    throwsCode(
      () => inviteToProject(platform, as('pm'), { name: 'Not a supplier', email: 'staff@meridian.example', roles: ['SUPERVISOR'], external: false, because: 'Joining the site team for the winter works', supplierId: winner.id }),
      'SUPPLIER_LINK_MISPLACED',
    );
    throwsCode(
      () => inviteToProject(platform, as('pm'), { name: 'Nobody', email: 'nobody@nowhere.example', roles: ['SUPPLIER'], external: true, organisation: 'Nowhere Ltd', because: 'A firm the register does not hold', supplierId: 'not-a-supplier' }),
      'SUPPLIER_NOT_FOUND',
    );

    const sent = inviteToProject(platform, as('pm'), {
      name: 'Dev Patel',
      email: 'dev.patel@winner.example',
      roles: ['SUPPLIER'],
      external: true,
      organisation: winner.legalName,
      because: 'Their commercial manager, to see their own obligations and payment state',
      supplierId: winner.id,
    });
    const accepted = acceptInvitation(platform, as('pm'), { invitationId: sent.invitationId });
    supplierUserId = accepted.userId;
    const user = platform.user(supplierUserId);
    assert.equal(user.partyId, winner.partyId, 'the identity carries the firm’s party');
    assert.deepEqual(user.roles, ['SUPPLIER']);
    const linked = linkedSupplier(platform, authOf(platform, supplierUserId));
    assert.equal(linked?.supplierId, winner.id);
    assert.equal(linked?.legalName, winner.legalName);
  });
});

describe('a signed-in supplier sees one firm', () => {
  it('resolves the portal to the firm the sign-in belongs to, and needs no supplierId to do it', () => {
    const portal = supplierPortal(platform, platform.context(authOf(platform, supplierUserId), projectId));
    assert.equal(portal.scopedBy, 'SIGN_IN');
    assert.equal(portal.supplier.supplierId, winner.id);
    assert.equal(portal.panel.workspace.id, 'SUPPLIER_PORTAL');
    // Every entry the panel carries is this firm's or a package this firm is on.
    for (const entry of [...portal.panel.now, ...portal.panel.next]) {
      assert.ok(!entry.headline.includes(loser.legalName), `the portal named a competitor: ${entry.headline}`);
    }
  });

  it('refuses a request that names another firm, and refuses a sign-in that belongs to no firm', () => {
    throwsCode(() => supplierPortal(platform, platform.context(authOf(platform, supplierUserId), projectId), { supplierId: loser.id }), 'SUPPLIER_SCOPE');
    const stranger = platform.createUser({ tenantId: seed.tenantId, name: 'Unlinked', email: 'unlinked@somewhere.example', roles: ['SUPPLIER'] });
    throwsCode(() => supplierPortal(platform, platform.context(authOf(platform, stranger.id), projectId)), 'SUPPLIER_UNLINKED');
  });

  it('still gives the buyer the internal view, and only when the firm is named', () => {
    throwsCode(() => supplierPortal(platform, as('pm')), 'SUPPLIER_REQUIRED');
    throwsCode(() => supplierPortal(platform, as('pm'), { supplierId: 'nobody' }), 'SUPPLIER_NOT_FOUND');
    const internal = supplierPortal(platform, as('pm'), { supplierId: winner.id });
    assert.equal(internal.scopedBy, 'CHOICE');
    assert.equal(internal.supplier.supplierId, winner.id);
  });

  it('holds no site-services capability on the supplier role, so the reads behind the portal are not open to it', () => {
    const own = platform.context(authOf(platform, supplierUserId), projectId);
    assert.throws(() => procurementPosition(own), 'a supplier could read every firm’s engagement');
  });
});

describe('the payment state is the firm’s own lines under award', () => {
  it('attributes lines by the award, certifies per certificate, and apportions what was paid on a shared certificate', () => {
    const own = openLine(as('qs'), {
      packageId,
      description: 'Welfare units, weekly service',
      budgetMinor: 500_000_00,
      commitmentMinor: 480_000_00,
      currency: 'GBP',
      method: 'TIME',
      contractWeeks: 44,
    });
    // A second package on another system, awarded to nobody, with a line on
    // the same certificate.
    const cleaning = composeSystem(as('pm'), { family: 'CLEANING_FM', zone: 'Main compound', ...WINDOW }).system;
    const other = createPackage(as('pm'), { title: 'Cleaning', systemIds: [cleaning.id] });
    const theirs = openLine(as('qs'), {
      packageId: other.id,
      description: 'Cleaning, weekly',
      budgetMinor: 100_000_00,
      commitmentMinor: 88_000_00,
      currency: 'GBP',
      method: 'TIME',
      contractWeeks: 44,
    });
    recordAcceptedProgress(as('pm'), { lineId: own.id, periodTo: '2026-11-30', accepted: 4, evidence: 'Weekly service sheets 1–4' });
    recordAcceptedProgress(as('pm'), { lineId: theirs.id, periodTo: '2026-11-30', accepted: 4, evidence: 'Cleaning sheets 1–4' });
    const valuation = openValuation(as('qs'), { periodFrom: '2026-11-01', periodTo: '2026-11-30' });
    recordApplication(as('qs'), {
      valuationId: valuation.id,
      lines: [
        { lineId: own.id, claimed: 4, narrative: 'Four weeks of the welfare service' },
        { lineId: theirs.id, claimed: 4, narrative: 'Four weeks of cleaning' },
      ],
    });
    const certified = certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Four weeks of both, evidenced' });
    // Half of the whole certificate has been paid.
    recordPayment(as('qs'), { valuationId: certified.id, amountMinor: Math.round(certified.certifiedMinor! / 2), reference: 'BACS-0001' });

    const portal = supplierPortal(platform, platform.context(authOf(platform, supplierUserId), projectId));
    const payment = portal.payment;
    assert.deepEqual(payment.lines.map((entry) => entry.id), [own.id], 'only the line under this firm’s award');
    assert.equal(payment.valuations.length, 1);
    const cert = payment.valuations[0]!;
    assert.equal(cert.certifiedMinor, payment.lines[0]!.certifiedMinor, 'the firm’s share is what its own line was certified');
    assert.ok(cert.certifiedMinor > 0 && cert.certifiedMinor < certified.certifiedMinor!, 'a share of the certificate, not the whole of it');
    assert.equal(cert.apportioned, true, 'the certificate carries the other line too');
    assert.equal(cert.paidMinor, Math.round((Math.round(certified.certifiedMinor! / 2) * cert.certifiedMinor) / certified.certifiedMinor!));
    assert.equal(cert.outstandingMinor, cert.certifiedMinor - cert.paidMinor);
    assert.equal(cert.payer, 'CUSTOMER', 'under Management the customer pays this firm direct');
    assert.match(payment.statement, /apportioned/);
    assert.equal(payment.totals.certifiedMinor, cert.certifiedMinor);
    assert.ok(payment.totals.earnedMinor >= payment.totals.certifiedMinor);
  });

  it('answers the portal’s payment question, so no command centre question is left unbuilt', () => {
    const portal = supplierPortal(platform, as('pm'), { supplierId: winner.id });
    assert.ok(portal.panel.workspace.questions.every((question) => question.answered));
  });
});
