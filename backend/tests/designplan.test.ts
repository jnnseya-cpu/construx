import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as designplan from '../src/domain/designplan.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * D-WF-01 — design mobilisation, responsibility and information planning.
 *
 * Three failures, and none of them is a missing record.
 *
 * Information planned to arrive after the thing waiting for it needs it. An
 * interface with an owner on one side, which is a boundary somebody drew and
 * nobody agreed. And responsibility that moved without the incoming party ever
 * seeing it, which reads afterwards exactly like a clean handover.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds DESIGN_INFORMATION R, C, U — plans and produces. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds DESIGN_INFORMATION R, C, U, A — approves the plan. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
/** Holds DESIGN_INFORMATION R only. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

function newPackage(reference: string, overrides: Record<string, string> = {}): string {
  return designplan.createPackage(asPM(), {
    reference,
    title: 'Clarifier structures',
    discipline: 'CIVILS',
    zone: 'Inlet works',
    leadDesigner: 'D. Whyte',
    leadOrganisation: 'Caldervale Engineering',
    ...overrides,
  }).packageId;
}

const DELIVERABLE = {
  reference: 'C-2001',
  title: 'Clarifier No.2 general arrangement',
  kind: 'DRAWING' as const,
  purpose: 'For construction',
  format: 'PDF and native DWG',
  author: 'S. Iqbal',
  checker: 'D. Whyte',
  approver: 'A. Okafor',
  acceptingParty: 'Northern Water Authority',
  dueBy: day(20),
  neededBy: day(60),
  neededFor: 'The civils enquiry, which goes out on that date',
  reviewDays: 10,
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── The record ──────────────────────────────────────────────────────────────

describe('design plan · the record', () => {
  it('registers its four events against two entities', () => {
    for (const [code, entity] of [
      ['DESIGN_PACKAGE_CREATED', 'DesignPackage'],
      ['DESIGN_RESPONSIBILITY_ASSIGNED', 'DesignPackage'],
      ['DESIGN_RESPONSIBILITY_TRANSFERRED', 'DesignPackage'],
      ['MIDP_APPROVED', 'MIDP'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // Who owes what information to whom is an appointment, not a suggestion.
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('classifies both entities under design information', () => {
    assert.equal(classifyEntity('DesignPackage')?.area, 'DESIGN_INFORMATION');
    assert.equal(classifyEntity('MIDP')?.area, 'DESIGN_INFORMATION');
  });

  it('refuses a package with no lead, because a package with no lead has no interface owner', () => {
    throwsCode(() => newPackage('PKG-NOLEAD', { leadDesigner: '  ' }), 'PACKAGE_UNLED');
  });

  it('refuses a second package on a reference already taken', () => {
    newPackage('PKG-A');
    throwsCode(() => newPackage('PKG-A'), 'PACKAGE_REFERENCE_TAKEN');
  });

  it('refuses the whole thing to a role that holds only read on the area', () => {
    assert.throws(
      () =>
        designplan.createPackage(asQS(), {
          reference: 'PKG-QS',
          title: 'x',
          discipline: 'CIVILS',
          zone: 'z',
          leadDesigner: 'a',
          leadOrganisation: 'b',
        }),
      /ACCESS_DENIED|No role/,
    );
    // ...but reads the plan, which is the half that matters commercially.
    assert.ok(designplan.designPlanPosition(asQS()).packages.length > 0);
  });
});

// ── The arithmetic nobody does ──────────────────────────────────────────────

describe('design plan · a deliverable planned to arrive after it is needed', () => {
  let packageId: string;

  before(() => {
    packageId = newPackage('PKG-DATES');
  });

  it('computes the slack from issue, review and need rather than asking for it', () => {
    // Due in 20 days, reviewed for 10, needed in 60: 30 days of slack. Nobody
    // types that number, which is how it stays true when one of the three moves.
    const planned = designplan.planDeliverable(asPM(), packageId, DELIVERABLE);
    assert.equal(planned.slackDays, 30);
    assert.equal(planned.late, false);
  });

  it('reports negative slack on the day the plan is written, not the week it fails', () => {
    const planned = designplan.planDeliverable(asPM(), packageId, {
      ...DELIVERABLE,
      reference: 'C-2002',
      dueBy: day(30),
      neededBy: day(35),
      reviewDays: 15,
      neededFor: 'The piling enquiry',
    });
    // Issued on day 30, reviewed to day 45, needed on day 35: ten days short.
    assert.equal(planned.slackDays, -10);
    assert.equal(planned.late, true);
  });

  it('records it anyway, because a plan that does not work is still the plan being worked to', () => {
    // Refusing would push it into a spreadsheet where nothing can see it. It is
    // recorded, reported, and blocks the MIDP approval instead.
    const position = designplan.designPlanPosition(asQS());
    const row = position.packages.find((entry) => entry.reference === 'PKG-DATES');
    assert.equal(row?.deliverables, 2);
    assert.equal(row?.worstSlackDays, -10);
  });

  it('refuses a review period nobody stated, and says why zero is different', () => {
    const refusal = throwsCode(
      () =>
        designplan.planDeliverable(asPM(), packageId, {
          ...DELIVERABLE,
          reference: 'C-2003',
          reviewDays: Number.NaN,
        }),
      'REVIEW_PERIOD_REQUIRED',
    );
    assert.match(String(refusal.message), /Zero is a legitimate answer/);
  });

  it('refuses a need date with nothing waiting on it', () => {
    throwsCode(
      () => designplan.planDeliverable(asPM(), packageId, { ...DELIVERABLE, reference: 'C-2004', neededFor: '' }),
      'NEED_UNEXPLAINED',
    );
  });
});

// ── Four acts, four names ───────────────────────────────────────────────────

describe('design plan · author, checker, approver and accepting party are four different acts', () => {
  let packageId: string;

  before(() => {
    packageId = newPackage('PKG-ROLES');
  });

  it('refuses a deliverable missing any one of the four', () => {
    for (const role of ['author', 'checker', 'approver', 'acceptingParty'] as const) {
      throwsCode(
        () =>
          designplan.planDeliverable(asPM(), packageId, {
            ...DELIVERABLE,
            reference: `C-30${role.length}`,
            [role]: '   ',
          }),
        'DELIVERABLE_UNOWNED',
        `a deliverable with no ${role} was accepted`,
      );
    }
  });

  it('refuses the same person as author and checker', () => {
    throwsCode(
      () =>
        designplan.planDeliverable(asPM(), packageId, {
          ...DELIVERABLE,
          reference: 'C-3100',
          author: 'S. Iqbal',
          checker: 'S. Iqbal',
        }),
      'SELF_CHECK_PLANNED',
    );
  });

  it('refuses a deliverable with no issue purpose, because for-information and for-construction are different instruments', () => {
    throwsCode(
      () => designplan.planDeliverable(asPM(), packageId, { ...DELIVERABLE, reference: 'C-3200', purpose: '' }),
      'ISSUE_PURPOSE_MISSING',
    );
  });
});

// ── Interfaces ──────────────────────────────────────────────────────────────

describe('design plan · an interface is owned on both sides or not recorded', () => {
  let packageId: string;

  before(() => {
    packageId = newPackage('PKG-IF');
    newPackage('PKG-MECH', { title: 'Mechanical', discipline: 'MECHANICAL' });
  });

  it('refuses an interface with an owner on one side only', () => {
    const refusal = throwsCode(
      () =>
        designplan.recordInterface(asPM(), packageId, {
          reference: 'IF-01',
          description: 'Penetrations through the clarifier wall for the process main',
          withPackage: 'PKG-MECH',
          ourOwner: 'D. Whyte',
          theirOwner: '',
          resolveBy: day(30),
        }),
      'INTERFACE_UNOWNED',
    );
    assert.match(String(refusal.message), /both sides assumed the other held/);
  });

  it('records one owned on both sides', () => {
    designplan.recordInterface(asPM(), packageId, {
      reference: 'IF-01',
      description: 'Penetrations through the clarifier wall for the process main',
      withPackage: 'PKG-MECH',
      ourOwner: 'D. Whyte',
      theirOwner: 'K. Adeyemi',
      resolveBy: day(30),
    });
    const row = designplan.designPlanPosition(asQS()).packages.find((entry) => entry.reference === 'PKG-IF');
    assert.equal(row?.openInterfaces, 1);
  });

  it('refuses to close one with nothing said about what was agreed', () => {
    throwsCode(() => designplan.agreeInterface(asPM(), packageId, { reference: 'IF-01', what: '  ' }), 'AGREEMENT_UNSTATED');
  });

  it('closes it with what was actually agreed', () => {
    designplan.agreeInterface(asPM(), packageId, {
      reference: 'IF-01',
      what: 'Puddle flanges cast in by civils to the mechanical schedule issued at revision C; sleeve sizes on C-2110.',
    });
    const row = designplan.designPlanPosition(asQS()).packages.find((entry) => entry.reference === 'PKG-IF');
    assert.equal(row?.openInterfaces, 0);
  });

  it('counts an interface past its own date as overdue', () => {
    designplan.recordInterface(asPM(), packageId, {
      reference: 'IF-02',
      description: 'Cable routes through the gallery slab',
      withPackage: 'PKG-MECH',
      ourOwner: 'D. Whyte',
      theirOwner: 'K. Adeyemi',
      resolveBy: day(-5),
    });
    const row = designplan.designPlanPosition(asQS()).packages.find((entry) => entry.reference === 'PKG-IF');
    assert.equal(row?.overdueInterfaces, 1);
  });
});

// ── Delegation is not transfer ──────────────────────────────────────────────

describe('design plan · delegation does not discharge the interface obligation', () => {
  let packageId: string;

  before(() => {
    packageId = newPackage('PKG-DEL');
    designplan.planDeliverable(asPM(), packageId, { ...DELIVERABLE, reference: 'C-4001' });
    designplan.recordInterface(asPM(), packageId, {
      reference: 'IF-10',
      description: 'Structural support for the mechanical plant',
      withPackage: 'PKG-MECH',
      ourOwner: 'D. Whyte',
      theirOwner: 'K. Adeyemi',
      resolveBy: day(40),
    });
  });

  it('leaves the author of record and the lead’s interfaces where they were', () => {
    const result = designplan.delegate(asPM(), packageId, {
      deliverableReference: 'C-4001',
      party: 'M. Farrow',
      organisation: 'Sable Structural Design',
      why: 'Specialist post-tensioning design outside the lead’s appointment scope',
    });
    // The rule the CDM regime states and most information plans quietly lose.
    assert.equal(result.author, 'S. Iqbal', 'delegation moved the author of record');
    assert.equal(result.interfacesStillOwnedByLead, 1, 'delegation moved an interface off the lead');
  });

  it('refuses a delegation with no reason, which is a transfer nobody accepted', () => {
    throwsCode(
      () =>
        designplan.delegate(asPM(), packageId, {
          deliverableReference: 'C-4001',
          party: 'M. Farrow',
          organisation: 'Sable',
          why: '',
        }),
      'DELEGATION_UNSTATED',
    );
  });

  it('shows the delegation on the position without changing who owes it', () => {
    const row = designplan.designPlanPosition(asQS()).packages.find((entry) => entry.reference === 'PKG-DEL');
    assert.equal(row?.delegated, 1);
    assert.equal(row?.leadDesigner, 'D. Whyte');
  });
});

// ── Transfer needs both signatures ──────────────────────────────────────────

describe('design plan · responsibility moves only when both parties say so', () => {
  let packageId: string;

  before(() => {
    packageId = newPackage('PKG-XFER');
    designplan.planDeliverable(asPM(), packageId, { ...DELIVERABLE, reference: 'C-5001' });
  });

  it('refuses a transfer the incoming party never accepted', () => {
    const refusal = throwsCode(
      () =>
        designplan.transferResponsibility(asPM(), packageId, {
          deliverableReference: 'C-5001',
          role: 'checker',
          to: 'P. Nowak',
          acceptedByOutgoing: 'D. Whyte',
          acceptedByIncoming: '',
          reason: 'Whyte is off the project from Monday',
        }),
      'TRANSFER_UNACCEPTED',
    );
    assert.match(String(refusal.message), /reads afterwards exactly like a clean handover/);
  });

  it('refuses a transfer that would make one person author and checker', () => {
    throwsCode(
      () =>
        designplan.transferResponsibility(asPM(), packageId, {
          deliverableReference: 'C-5001',
          role: 'checker',
          to: 'S. Iqbal',
          acceptedByOutgoing: 'D. Whyte',
          acceptedByIncoming: 'S. Iqbal',
          reason: 'Whyte is off the project',
        }),
      'SELF_CHECK_AFTER_TRANSFER',
    );
  });

  it('moves it when both parties have accepted, and keeps who held it before', () => {
    const moved = designplan.transferResponsibility(asPM(), packageId, {
      deliverableReference: 'C-5001',
      role: 'checker',
      to: 'P. Nowak',
      acceptedByOutgoing: 'D. Whyte',
      acceptedByIncoming: 'P. Nowak',
      reason: 'Whyte is off the project from Monday; Nowak holds the same chartered status',
    });
    assert.equal(moved.from, 'D. Whyte');

    const record = platform.ledger.get({ refType: 'DesignPackage', refId: packageId });
    const deliverable = (record!.state.deliverables as Array<Record<string, unknown>>)[0]!;
    assert.equal(deliverable.checker, 'P. Nowak');
    // Somebody who held a duty for four months held it for four months, and an
    // audit resolving only the current holder reports the wrong party.
    const transfers = deliverable.transfers as Array<Record<string, unknown>>;
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0]!.from, 'D. Whyte');
    assert.equal(transfers[0]!.acceptedByOutgoing, 'D. Whyte');
    assert.equal(transfers[0]!.acceptedByIncoming, 'P. Nowak');
  });
});

// ── The CDE ladder ──────────────────────────────────────────────────────────

describe('design plan · nothing reaches Shared unchecked', () => {
  let packageId: string;

  before(() => {
    packageId = newPackage('PKG-CDE');
    designplan.planDeliverable(asPM(), packageId, { ...DELIVERABLE, reference: 'C-6001' });
  });

  it('refuses a jump that skips a state', () => {
    const refusal = throwsCode(
      () => designplan.advanceDeliverable(asPM(), packageId, { reference: 'C-6001', to: 'PUBLISHED' }),
      'CDE_TRANSITION_REFUSED',
    );
    // The refusal says what *is* permitted, so a person is not left guessing.
    assert.match(String(refusal.message), /permitted moves from wip are shared/);
  });

  it('moves through the ladder and records who moved it', () => {
    designplan.advanceDeliverable(asPM(), packageId, { reference: 'C-6001', to: 'SHARED' });
    designplan.advanceDeliverable(asPM(), packageId, { reference: 'C-6001', to: 'PUBLISHED' });

    const row = designplan.designPlanPosition(asQS()).packages.find((entry) => entry.reference === 'PKG-CDE');
    assert.equal(row?.published, 1);

    const record = platform.ledger.get({ refType: 'DesignPackage', refId: packageId });
    const history = (record!.state.deliverables as Array<Record<string, unknown>>)[0]!.history as unknown[];
    assert.equal(history.length, 2);
  });

  it('refuses to move a published deliverable back down the ladder', () => {
    throwsCode(
      () => designplan.advanceDeliverable(asPM(), packageId, { reference: 'C-6001', to: 'SHARED' }),
      'CDE_TRANSITION_REFUSED',
    );
  });

  it('lets a shared deliverable go back to work in progress, because a review can send it back', () => {
    designplan.planDeliverable(asPM(), packageId, { ...DELIVERABLE, reference: 'C-6002' });
    designplan.advanceDeliverable(asPM(), packageId, { reference: 'C-6002', to: 'SHARED' });
    assert.equal(designplan.advanceDeliverable(asPM(), packageId, { reference: 'C-6002', to: 'WIP' }).to, 'WIP');
  });
});

// ── The MIDP is what the TIDPs add up to ────────────────────────────────────

describe('design plan · the MIDP is reconciled, not written', () => {
  let clean: Platform;
  let cleanSeed: SeedResult;
  const asCleanPM = () => clean.context(cleanSeed.users.pm!.auth, cleanSeed.projectId, { source: 'WEB' });
  const asCleanDesigner = () => clean.context(cleanSeed.users.designer!.auth, cleanSeed.projectId, { source: 'WEB' });

  before(async () => {
    clean = new Platform();
    cleanSeed = await seedDemoProject(clean);
  });

  it('refuses to approve a plan on a project with no packages', () => {
    throwsCode(() => designplan.approveMIDP(asCleanDesigner(), { cutOff: day(0), note: 'x' }), 'NO_PACKAGES');
  });

  it('finds one reference planned in two packages', () => {
    const a = designplan.createPackage(asCleanPM(), {
      reference: 'PKG-1',
      title: 'Civils',
      discipline: 'CIVILS',
      zone: 'Inlet',
      leadDesigner: 'D. Whyte',
      leadOrganisation: 'Caldervale',
    }).packageId;
    const b = designplan.createPackage(asCleanPM(), {
      reference: 'PKG-2',
      title: 'Structures',
      discipline: 'STRUCTURES',
      zone: 'Inlet',
      leadDesigner: 'M. Farrow',
      leadOrganisation: 'Sable',
    }).packageId;

    designplan.planDeliverable(asCleanPM(), a, { ...DELIVERABLE, reference: 'SHARED-REF' });
    designplan.planDeliverable(asCleanPM(), b, { ...DELIVERABLE, reference: 'SHARED-REF', author: 'M. Farrow' });

    const reconciliation = designplan.reconcileMIDP(asCleanPM());
    assert.equal(reconciliation.duplicated.length, 1);
    assert.deepEqual(reconciliation.duplicated[0]!.packages, ['PKG-1', 'PKG-2']);
    assert.equal(reconciliation.ready, false);
  });

  it('refuses to approve while a reference is produced twice, and says both packages', () => {
    const refusal = throwsCode(
      () => designplan.approveMIDP(asCleanDesigner(), { cutOff: day(0), note: 'Design freeze cut-off' }),
      'MIDP_DOES_NOT_RECONCILE',
    );
    assert.match(String(refusal.message), /SHARED-REF is planned in PKG-1 and PKG-2/);
    assert.match(String(refusal.message), /somebody else’s problem/);
  });

  it('finds an interface naming a package that does not exist', () => {
    const c = designplan.createPackage(asCleanPM(), {
      reference: 'PKG-3',
      title: 'MEP',
      discipline: 'MECHANICAL',
      zone: 'Gallery',
      leadDesigner: 'K. Adeyemi',
      leadOrganisation: 'Halden MEP',
    }).packageId;
    designplan.recordInterface(asCleanPM(), c, {
      reference: 'IF-X',
      description: 'Plant plinths',
      withPackage: 'PKG-NOT-A-PACKAGE',
      ourOwner: 'K. Adeyemi',
      theirOwner: 'D. Whyte',
      resolveBy: day(30),
    });

    const reconciliation = designplan.reconcileMIDP(asCleanPM());
    assert.equal(reconciliation.danglingInterfaces.length, 1);
    assert.equal(reconciliation.danglingInterfaces[0]!.namesPackage, 'PKG-NOT-A-PACKAGE');
  });

  it('approves once every contradiction is gone', async () => {
    // A fresh project rather than repairing the broken one: what is being
    // tested is that a plan which reconciles is approved, and unpicking a
    // deliberately broken fixture proves nothing about that.
    const ok = new Platform();
    const okSeed = await seedDemoProject(ok);
    const pm = ok.context(okSeed.users.pm!.auth, okSeed.projectId, { source: 'WEB' });
    const designer = ok.context(okSeed.users.designer!.auth, okSeed.projectId, { source: 'WEB' });

    const id = designplan.createPackage(pm, {
      reference: 'PKG-OK',
      title: 'Civils',
      discipline: 'CIVILS',
      zone: 'Inlet',
      leadDesigner: 'D. Whyte',
      leadOrganisation: 'Caldervale',
    }).packageId;
    designplan.planDeliverable(pm, id, DELIVERABLE);

    const approved = designplan.approveMIDP(designer, {
      cutOff: day(0),
      note: 'Approved at the design mobilisation review; TIDPs from all three teams reconciled.',
    });
    assert.equal(approved.deliverables, 1);

    const position = designplan.designPlanPosition(pm);
    assert.equal(position.approvedMIDP?.deliverables, 1);
    assert.equal(position.midp.ready, true);
  });

  it('will not let the planner approve it — approval is the designer’s A', () => {
    // Authorisation runs before the reconciliation, so this is a permission
    // refusal and not a plan refusal — the two must not be confusable.
    assert.throws(() => designplan.approveMIDP(asCleanPM(), { cutOff: day(0), note: 'x' }), /ACCESS_DENIED|No role/);
  });
});
