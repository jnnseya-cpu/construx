import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as designchange from '../src/domain/designchange.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * D-WF-06 — design change and impact control.
 *
 * The register that decides whether a project knows what it is building to.
 * Three things are worth testing and the rest is bookkeeping:
 *
 * A revision issued while the change is still being assessed is a decision
 * taken by whoever drew it. A change assessed on cost alone is a change whose
 * programme consequence somebody finds on site. And a change that named four
 * packages and closed with two of them untouched has left two packages built to
 * superseded information — which is a defect that surfaces at handover, when it
 * is at its most expensive.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds C and U on DESIGN_INFORMATION: proposes and implements. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds A: decides and closes. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
/** Holds R only. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const PROPOSAL = {
  title: 'Relocate the RAS pump suction to clear the drainage run',
  classification: 'CORRECTION' as const,
  origin: 'Coordination issue CI-0007, raised on federation run FS-0002',
  reason: 'The suction spool as drawn passes through the 300mm surface water drain at invert level.',
  currentRevision: 'P04',
  proposedRevision: 'P05',
  affects: [
    { kind: 'PACKAGE', reference: 'PKG-MEP' },
    { kind: 'DRAWING', reference: 'M-2201' },
  ],
  touchesSafety: false,
  touchesStatutoryApproval: false,
  // 0.05% of the seeded project value: inside the design manager's authority.
  estimatedCostMinor: 900_000,
};

const ASSESSORS: Record<designchange.ImpactDomain, string> = {
  DESIGN: 'D. Whyte',
  COMMERCIAL: 'S. Iqbal',
  PLANNING: 'T. Nakamura',
  SAFETY: 'M. Osei',
  PROCUREMENT: 'L. Fenwick',
  INFORMATION: 'K. Barr',
};

function propose(overrides: Partial<Parameters<typeof designchange.proposeChange>[1]> = {}) {
  return designchange.proposeChange(asPM(), { ...PROPOSAL, ...overrides });
}

/** All six domains, so the change is decidable. */
function assessAll(changeId: string): void {
  for (const domain of designchange.IMPACT_DOMAIN) {
    designchange.assessImpact(asPM(), changeId, {
      domain,
      applicable: domain === 'DESIGN' || domain === 'COMMERCIAL',
      assessment:
        domain === 'DESIGN'
          ? 'Spool and two hangers move; no structural penetration changes.'
          : domain === 'COMMERCIAL'
            ? 'Within the MEP subcontract remeasure; no entitlement.'
            : `No ${domain.toLowerCase()} consequence: the change is inside one room and one already-issued package.`,
      assessedBy: ASSESSORS[domain],
    });
  }
}

/** Propose → assess → approve, which is where most tests want to start. */
function approved(): string {
  const { changeId } = propose();
  assessAll(changeId);
  designchange.decideChange(asDesigner(), changeId, {
    decision: 'APPROVE',
    rationale: 'The clash is real and the relocation is the cheapest of the three options assessed.',
  });
  return changeId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('D-WF-06 the register itself', () => {
  it('registers its six event types against DesignChange', () => {
    for (const code of [
      'DESIGN_CHANGE_PROPOSED',
      'CHANGE_IMPACT_ASSESSED',
      'DESIGN_CHANGE_APPROVED',
      'DESIGN_CHANGE_DECIDED',
      'CHANGE_IMPLEMENTED',
      'CHANGE_VERIFIED',
    ]) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'DesignChange');
      // Governance. Nothing here may be authored by an agent: a change to
      // approved design is a decision, and no mandate exceeds PROPOSE.
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('is a design record, not a contractual one', () => {
    // The distinction the module exists for. If these two ever collapse into
    // one area, every drawing correction lands in the variation register.
    assert.equal(classifyEntity('DesignChange')?.area, 'DESIGN_INFORMATION');
    assert.equal(classifyEntity('ChangeRequest')?.area, 'CHANGE_VARIATION');
  });

  it('numbers changes in sequence', () => {
    const first = propose();
    const second = propose();
    assert.match(first.reference, /^DC-\d{4}$/);
    assert.notEqual(first.reference, second.reference);
  });

  it('refuses a change nobody can read six months later', () => {
    throwsCode(() => propose({ reason: '   ' }), 'CHANGE_UNSTATED');
    throwsCode(() => propose({ title: '' }), 'CHANGE_UNSTATED');
  });

  it('refuses a change that cannot be traced back to whoever asked for it', () => {
    throwsCode(() => propose({ origin: '' }), 'ORIGIN_REQUIRED');
  });

  it('refuses a change with no revision either side of it', () => {
    throwsCode(() => propose({ currentRevision: '' }), 'REVISIONS_REQUIRED');
    throwsCode(() => propose({ proposedRevision: '  ' }), 'REVISIONS_REQUIRED');
  });

  it('refuses a change that affects nothing, because closure is checked against that list', () => {
    throwsCode(() => propose({ affects: [] }), 'AFFECTS_NOTHING');
  });

  it('refuses to let a reader propose one', () => {
    throwsCode(() => designchange.proposeChange(asQS(), PROPOSAL), 'ACCESS_DENIED');
  });
});

describe('D-WF-06 materiality is a proportion, never a figure', () => {
  it('routes a small share to the design manager', () => {
    const materiality = designchange.materialityOf({
      estimatedCostMinor: 900_000,
      projectValueMinor: 1_850_000_000,
      touchesSafety: false,
      touchesStatutoryApproval: false,
    });
    assert.equal(materiality.route, 'DESIGN_MANAGER');
    assert.ok(materiality.sharePercent! < designchange.MATERIALITY.significantSharePercent);
  });

  it('routes a significant share to the project director', () => {
    // 1% of the project: over the significant share, under the client one.
    const materiality = designchange.materialityOf({
      estimatedCostMinor: 18_500_000,
      projectValueMinor: 1_850_000_000,
      touchesSafety: false,
      touchesStatutoryApproval: false,
    });
    assert.equal(materiality.route, 'PROJECT_DIRECTOR');
    assert.equal(materiality.sharePercent, 1);
  });

  it('routes a large share to the client', () => {
    const materiality = designchange.materialityOf({
      estimatedCostMinor: 100_000_000,
      projectValueMinor: 1_850_000_000,
      touchesSafety: false,
      touchesStatutoryApproval: false,
    });
    assert.equal(materiality.route, 'CLIENT');
  });

  it('treats safety and statutory approval as material at any value', () => {
    // The whole reason the route is not a money test. A change to a fire
    // strategy on a small job is not the design manager's because it is cheap.
    const safety = designchange.materialityOf({
      estimatedCostMinor: 1,
      projectValueMinor: 1_850_000_000,
      touchesSafety: true,
      touchesStatutoryApproval: false,
    });
    assert.equal(safety.route, 'PROJECT_DIRECTOR');

    const statutory = designchange.materialityOf({
      estimatedCostMinor: 1,
      projectValueMinor: 1_850_000_000,
      touchesSafety: false,
      touchesStatutoryApproval: true,
    });
    assert.equal(statutory.route, 'CLIENT');
  });

  it('takes the higher route where the project has no value to size against', () => {
    const materiality = designchange.materialityOf({
      estimatedCostMinor: 5_000_000,
      touchesSafety: false,
      touchesStatutoryApproval: false,
    });
    assert.equal(materiality.route, 'PROJECT_DIRECTOR');
    assert.equal(materiality.sharePercent, undefined);
    assert.match(materiality.why, /unknown proportion is not a small one/);
  });

  it('hardcodes no money figure in its configuration', async () => {
    // lifecycle/scale.ts's rule, applied here. An absolute threshold is always
    // wrong at one end of the market, so the two numbers that configure the
    // approval route are shares and a test says so.
    const fs = await import('node:fs/promises');
    const source = await fs.readFile(new URL('../src/domain/designchange.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export const MATERIALITY');
    const configuration = source.slice(start, source.indexOf('} as const;', start));
    assert.ok(start > 0);
    assert.ok(!/_000\b/.test(configuration), 'MATERIALITY must carry shares, not amounts');
  });

  it('carries the derived route onto the record', () => {
    const { changeId, materiality } = propose({ touchesStatutoryApproval: true });
    assert.equal(materiality.route, 'CLIENT');
    const position = designchange.designChangePosition(asPM());
    assert.equal(position.changes.find((change) => change.changeId === changeId)!.route, 'CLIENT');
  });
});

describe('D-WF-06 every domain is assessed or explicitly not applicable', () => {
  it('reports what is still outstanding after each assessment', () => {
    const { changeId } = propose();
    const first = designchange.assessImpact(asPM(), changeId, {
      domain: 'DESIGN',
      applicable: true,
      assessment: 'Spool and two hangers move.',
      assessedBy: 'D. Whyte',
    });
    assert.equal(first.assessed, 1);
    assert.equal(first.outstanding.length, designchange.IMPACT_DOMAIN.length - 1);
    assert.ok(!first.outstanding.includes('DESIGN'));
  });

  it('accepts a domain assessed as not applicable, with the reason', () => {
    const { changeId } = propose();
    const result = designchange.assessImpact(asPM(), changeId, {
      domain: 'PROCUREMENT',
      applicable: false,
      assessment: 'The spool is fabricated on site from stock; nothing is ordered against the old arrangement.',
      assessedBy: 'L. Fenwick',
    });
    assert.equal(result.assessed, 1);
  });

  it('refuses silence in place of an assessment, applicable or not', () => {
    const { changeId } = propose();
    throwsCode(
      () =>
        designchange.assessImpact(asPM(), changeId, {
          domain: 'PLANNING',
          applicable: false,
          assessment: '   ',
          assessedBy: 'T. Nakamura',
        }),
      'ASSESSMENT_REQUIRED',
    );
  });

  it('refuses an assessment nobody will stand behind', () => {
    const { changeId } = propose();
    throwsCode(
      () =>
        designchange.assessImpact(asPM(), changeId, {
          domain: 'SAFETY',
          applicable: true,
          assessment: 'Working at height during the change-over.',
          assessedBy: '',
        }),
      'ASSESSOR_REQUIRED',
    );
  });

  it('replaces rather than duplicates an assessment of the same domain', () => {
    const { changeId } = propose();
    for (const assessment of ['Initial view.', 'Revised after the model check.']) {
      designchange.assessImpact(asPM(), changeId, {
        domain: 'DESIGN',
        applicable: true,
        assessment,
        assessedBy: 'D. Whyte',
      });
    }
    const position = designchange.designChangePosition(asPM());
    assert.equal(position.changes.find((change) => change.changeId === changeId)!.domainsAssessed, 1);
  });

  it('marks the change assessed only once all six are in', () => {
    const { changeId } = propose();
    assessAll(changeId);
    const position = designchange.designChangePosition(asPM());
    const change = position.changes.find((entry) => entry.changeId === changeId)!;
    assert.equal(change.status, 'ASSESSED');
    assert.deepEqual(change.outstandingDomains, []);
  });
});

describe('D-WF-06 the decision', () => {
  it('refuses approval while any domain is unassessed', () => {
    // AC-D-WF-06-02. A change approved on cost alone is a change whose
    // programme consequence somebody discovers on site.
    const { changeId } = propose();
    designchange.assessImpact(asPM(), changeId, {
      domain: 'COMMERCIAL',
      applicable: true,
      assessment: 'Within the remeasure.',
      assessedBy: 'S. Iqbal',
    });
    throwsCode(
      () => designchange.decideChange(asDesigner(), changeId, { decision: 'APPROVE', rationale: 'Looks fine.' }),
      'IMPACT_ASSESSMENT_INCOMPLETE',
    );
  });

  it('allows a rejection without a complete assessment', () => {
    // Refusing to reject an unassessed change would force six assessments of a
    // change everybody has already agreed is not happening.
    const { changeId } = propose();
    const result = designchange.decideChange(asDesigner(), changeId, {
      decision: 'REJECT',
      rationale: 'The drain is being diverted under a separate change; the spool stays where it is.',
    });
    assert.equal(result.status, 'REJECTED');
    assert.equal(result.mayImplement, false);
  });

  it('refuses a decision with nothing behind it', () => {
    const { changeId } = propose();
    throwsCode(
      () => designchange.decideChange(asDesigner(), changeId, { decision: 'REJECT', rationale: '' }),
      'DECISION_UNEXPLAINED',
    );
  });

  it('refuses the proposer as the decider', () => {
    // The separation the approval route exists for, and worth as much on a
    // correction as on a client change.
    const { changeId } = designchange.proposeChange(asDesigner(), PROPOSAL);
    assessAll(changeId);
    throwsCode(
      () => designchange.decideChange(asDesigner(), changeId, { decision: 'APPROVE', rationale: 'My own change.' }),
      'SELF_APPROVAL_REFUSED',
    );
  });

  it('refuses a second decision on the same change', () => {
    const changeId = approved();
    throwsCode(
      () => designchange.decideChange(asDesigner(), changeId, { decision: 'REJECT', rationale: 'Changed my mind.' }),
      'CHANGE_ALREADY_DECIDED',
    );
  });

  it('refuses a decision from someone who can only propose', () => {
    const { changeId } = propose();
    assessAll(changeId);
    throwsCode(
      () => designchange.decideChange(asPM(), changeId, { decision: 'APPROVE', rationale: 'Approving my own route.' }),
      'ACCESS_DENIED',
    );
  });

  it('writes an approval as an approval and everything else as an update', () => {
    const changeId = approved();
    const codes = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((event) => event.entity.refId === changeId)
      .map((event) => event.eventType);
    assert.ok(codes.includes('DESIGN_CHANGE_APPROVED'));
    assert.ok(!codes.includes('DESIGN_CHANGE_DECIDED'));

    const { changeId: rejectedId } = propose();
    designchange.decideChange(asDesigner(), rejectedId, { decision: 'REJECT', rationale: 'Superseded.' });
    const rejectedCodes = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((event) => event.entity.refId === rejectedId)
      .map((event) => event.eventType);
    assert.ok(rejectedCodes.includes('DESIGN_CHANGE_DECIDED'));
    assert.ok(!rejectedCodes.includes('DESIGN_CHANGE_APPROVED'));
  });
});

describe('D-WF-06 implementation does not start before approval', () => {
  it('refuses a revision issued while the change is still being assessed', () => {
    // AC-D-WF-06-01. The whole reason the change was registered.
    const { changeId } = propose();
    throwsCode(() => designchange.recordImplemented(asPM(), changeId, { note: 'P05 issued.' }), 'NOT_APPROVED');
  });

  it('refuses to implement a rejected change', () => {
    const { changeId } = propose();
    designchange.decideChange(asDesigner(), changeId, { decision: 'REJECT', rationale: 'Not proceeding.' });
    throwsCode(
      () => designchange.recordImplemented(asPM(), changeId, { note: 'P05 issued anyway.' }),
      'CHANGE_REJECTED',
    );
  });

  it('records what was actually changed', () => {
    const changeId = approved();
    throwsCode(() => designchange.recordImplemented(asPM(), changeId, { note: '  ' }), 'IMPLEMENTATION_UNSTATED');
  });

  it('links to the contractual change rather than becoming one', () => {
    const changeId = approved();
    designchange.recordImplemented(asPM(), changeId, {
      note: 'M-2201 reissued at P05 with the spool at +200mm.',
      changeRequestRef: 'CR-0042',
    });
    const position = designchange.designChangePosition(asPM());
    assert.equal(position.changes.find((change) => change.changeId === changeId)!.changeRequestRef, 'CR-0042');
  });
});

describe('D-WF-06 the emergency path is a deferral, not a bypass', () => {
  it('refuses an emergency with nothing behind the word', () => {
    throwsCode(() => propose({ emergency: { why: '   ' } }), 'EMERGENCY_UNJUSTIFIED');
  });

  it('lets a safety correction be implemented before approval, and says approval is owed', () => {
    const { changeId } = propose({
      touchesSafety: true,
      emergency: { why: 'The handrail gap was found open to a 4m drop with operatives working below it that shift.' },
    });
    const result = designchange.recordImplemented(asPM(), changeId, {
      note: 'Infill panel detailed and issued the same afternoon as S-4410 P02.',
    });
    assert.equal(result.emergency, true);
    assert.equal(result.retrospectiveApprovalOwed, true);

    const position = designchange.designChangePosition(asPM());
    assert.ok(position.approvalOwed.length > 0);
    assert.match(position.summary, /emergency path and never approved/);
  });

  it('refuses to close an emergency change nobody went back and approved', () => {
    const { changeId } = propose({
      affects: [{ kind: 'DRAWING', reference: 'S-4410' }],
      touchesSafety: true,
      emergency: { why: 'Open edge over a 4m drop, operatives working below.' },
    });
    designchange.recordImplemented(asPM(), changeId, { note: 'Infill panel issued.' });
    designchange.confirmAffected(asPM(), changeId, {
      reference: 'S-4410',
      outcome: 'REVISED',
      note: 'Reissued at P02.',
    });
    throwsCode(() => designchange.closeChange(asDesigner(), changeId, { note: 'Done.' }), 'RETROSPECTIVE_APPROVAL_OWED');
  });

  it('discharges the retrospective approval when it is finally given', () => {
    const { changeId } = propose({
      affects: [{ kind: 'DRAWING', reference: 'S-4411' }],
      touchesSafety: true,
      emergency: { why: 'Open edge over a 4m drop, operatives working below.' },
    });
    designchange.recordImplemented(asPM(), changeId, { note: 'Infill panel issued.' });
    assessAll(changeId);
    designchange.decideChange(asDesigner(), changeId, {
      decision: 'APPROVE',
      rationale: 'The correction was right and the expedited route was justified by the exposure.',
    });
    designchange.confirmAffected(asPM(), changeId, {
      reference: 'S-4411',
      outcome: 'REVISED',
      note: 'Reissued at P02.',
    });

    // The approval moved the record back to APPROVED, so it comes back through
    // implementation before it can close — the register should never show a
    // change as implemented on the strength of a decision alone.
    designchange.recordImplemented(asPM(), changeId, { note: 'Confirmed issued at P02.' });
    assert.deepEqual(designchange.closeChange(asDesigner(), changeId, { note: 'Closed.' }), { closed: true });

    const position = designchange.designChangePosition(asPM());
    const change = position.changes.find((entry) => entry.changeId === changeId)!;
    assert.equal(change.retrospectiveApprovalOwed, false);
    assert.ok(!position.approvalOwed.includes(change.reference));
  });
});

describe('D-WF-06 closure confirms everything the change named', () => {
  it('refuses closure while anything it named is unconfirmed', () => {
    // AC-D-WF-06-03. Two packages built to superseded information is the defect
    // this refusal exists to prevent, and it surfaces at handover.
    const changeId = approved();
    designchange.recordImplemented(asPM(), changeId, { note: 'M-2201 reissued at P05.' });
    designchange.confirmAffected(asPM(), changeId, {
      reference: 'M-2201',
      outcome: 'REVISED',
      note: 'P05 issued 14th.',
    });
    throwsCode(() => designchange.closeChange(asDesigner(), changeId, { note: 'Closing.' }), 'AFFECTED_UNCONFIRMED');
  });

  it('accepts "not affected after all", with the reason', () => {
    const changeId = approved();
    designchange.recordImplemented(asPM(), changeId, { note: 'M-2201 reissued at P05.' });
    designchange.confirmAffected(asPM(), changeId, { reference: 'M-2201', outcome: 'REVISED', note: 'P05 issued.' });
    const result = designchange.confirmAffected(asPM(), changeId, {
      reference: 'PKG-MEP',
      outcome: 'UNAFFECTED',
      note: 'The spool sits inside the package boundary; no interface or quantity changes, so the package stands at P03.',
    });
    assert.deepEqual(result.outstanding, []);
    assert.deepEqual(designchange.closeChange(asDesigner(), changeId, { note: 'Closed.' }), { closed: true });
  });

  it('refuses a confirmation of something the change never claimed to touch', () => {
    // Otherwise the closure list gets written at the end rather than the start,
    // which is the same as not having one.
    const changeId = approved();
    throwsCode(
      () =>
        designchange.confirmAffected(asPM(), changeId, {
          reference: 'E-1100',
          outcome: 'UNAFFECTED',
          note: 'Not touched.',
        }),
      'NOT_AFFECTED_BY_THIS_CHANGE',
    );
  });

  it('refuses an unexplained confirmation', () => {
    const changeId = approved();
    throwsCode(
      () => designchange.confirmAffected(asPM(), changeId, { reference: 'M-2201', outcome: 'REVISED', note: '' }),
      'CONFIRMATION_UNSTATED',
    );
  });

  it('refuses to close a change that was never implemented', () => {
    const changeId = approved();
    throwsCode(() => designchange.closeChange(asDesigner(), changeId, { note: 'Closing.' }), 'NOT_IMPLEMENTED');
  });

  it('closes a rejected change on the rejection, with nothing to confirm', () => {
    const { changeId } = propose();
    designchange.decideChange(asDesigner(), changeId, { decision: 'REJECT', rationale: 'Not proceeding.' });
    assert.deepEqual(designchange.closeChange(asDesigner(), changeId, { note: 'Closed on rejection.' }), {
      closed: true,
    });
  });

  it('refuses to close the same change twice', () => {
    const { changeId } = propose();
    designchange.decideChange(asDesigner(), changeId, { decision: 'REJECT', rationale: 'Not proceeding.' });
    designchange.closeChange(asDesigner(), changeId, { note: 'Closed.' });
    throwsCode(() => designchange.closeChange(asDesigner(), changeId, { note: 'Again.' }), 'CHANGE_CLOSED');
  });

  it('refuses to assess a closed change', () => {
    const { changeId } = propose();
    designchange.decideChange(asDesigner(), changeId, { decision: 'REJECT', rationale: 'Not proceeding.' });
    designchange.closeChange(asDesigner(), changeId, { note: 'Closed.' });
    throwsCode(
      () =>
        designchange.assessImpact(asPM(), changeId, {
          domain: 'DESIGN',
          applicable: true,
          assessment: 'Late thought.',
          assessedBy: 'D. Whyte',
        }),
      'CHANGE_CLOSED',
    );
  });
});

describe('D-WF-06 the position', () => {
  it('sorts what is owed to the top', () => {
    // Emergencies awaiting approval sort first: the register is read by someone
    // with two minutes, and this is what those two minutes are for.
    const position = designchange.designChangePosition(asPM());
    const owed = position.changes
      .map((change, index) => (change.retrospectiveApprovalOwed ? index : -1))
      .filter((index) => index >= 0);
    const notOwed = position.changes
      .map((change, index) => (change.retrospectiveApprovalOwed ? -1 : index))
      .filter((index) => index >= 0);
    if (owed.length > 0 && notOwed.length > 0) {
      assert.ok(Math.max(...owed) < Math.min(...notOwed));
    }
    assert.match(position.summary, /design changes/);
  });

  it('reports an implemented change still carrying something unconfirmed', () => {
    const changeId = approved();
    designchange.recordImplemented(asPM(), changeId, { note: 'M-2201 reissued at P05.' });
    const position = designchange.designChangePosition(asPM());
    const change = position.changes.find((entry) => entry.changeId === changeId)!;
    assert.equal(change.affected, 2);
    assert.equal(change.affectedConfirmed, 0);
    assert.ok(position.unconfirmed.some((entry) => entry.reference === change.reference));
  });

  it('is readable by a role that cannot write to it', () => {
    const position = designchange.designChangePosition(asQS());
    assert.ok(position.changes.length > 0);
  });
});
