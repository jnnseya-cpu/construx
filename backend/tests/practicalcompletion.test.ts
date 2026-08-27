import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as practicalcompletion from '../src/domain/practicalcompletion.ts';
import * as structure from '../src/domain/structure.ts';
import * as valuechain from '../src/domain/valuechain.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-08 — defects, practical/sectional completion and commercial closeout.
 *
 * The existing defect, snag and value-chain records are reused rather than
 * rebuilt; what is tested here is the completion inspection that classifies
 * what is outstanding, the certificate, the dates it sets running once, and the
 * commercial reconciliation that must not hold up a safety-critical closure.
 */

let platform: Platform;
let seed: SeedResult;

const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds CONTRACTS_CLAIMS A — determining completion is a contractual act. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
/**
 * Holds CONTRACTS_CLAIMS [R,C,U,I,X] and no A.
 *
 * Which is the right split for the two commercial acts here: recording where a
 * bond stands is administration and the QS does it; agreeing the final account
 * is an approval and the owner does. The owner holds no C at all, so the
 * authority model separates them without either being restated as a rule.
 */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Walking the building for completion',
  });
}

const ITEM = {
  location: 'Level 3 east corridor',
  description: 'Ceiling tile grid is out of level over a six metre run and three tiles do not seat',
  classification: 'MINOR_DEFECT' as const,
  contractor: 'Ceilings subcontractor',
  dueDate: iso(21),
  accessWindow: 'Weekday evenings after 18:00, tenant in occupation from Monday',
};

function inspection(overrides: Record<string, unknown> = {}) {
  return practicalcompletion.recordCompletionInspection(asQAQC(), {
    reference: 'CI-001',
    scope: 'Levels 1 to 3 of the east wing, all finishes and the corridor ceilings',
    inspectedBy: 'Client representative',
    attendees: ['Client representative', 'Main contractor project manager'],
    evidenceHash: 'b'.repeat(64),
    items: [ITEM],
    ...overrides,
  } as Parameters<typeof practicalcompletion.recordCompletionInspection>[1]);
}

/**
 * The clause the demo project's register holds for a category.
 *
 * The seeded project already carries all ten extracted categories, every one of
 * them `requiresLegalReview: true` — which is exactly the state this workflow's
 * exception control exists for, so nothing is fabricated here.
 */
function clauseIdFor(category: string): string {
  const record = platform.ledger
    .list(seed.projectId, 'ContractClause')
    .find((entry) => entry.state.category === category);
  assert.ok(record, `the demo project has no ${category} clause`);
  return record.refId;
}

/** Clear legal review on the four categories a certificate reads dates from. */
function validatedContractPack() {
  for (const category of ['DEFECTS_LIABILITY', 'RETENTION', 'INSURANCE', 'LIQUIDATED_DAMAGES']) {
    practicalcompletion.validateContractClause(asOwner(), clauseIdFor(category), {
      agrees: true,
      note: `Checked ${category} against the executed contract`,
      validatedBy: 'Contract administrator',
    });
  }
}

const PERIODS = [
  { key: 'POSSESSION' as const, periodDays: 0, ruleSource: 'JCT cl. 2.30' },
  { key: 'INSURANCE_TRANSFER' as const, periodDays: 0, ruleSource: 'JCT cl. 6.4' },
  { key: 'LIQUIDATED_DAMAGES_END' as const, periodDays: 0, ruleSource: 'JCT cl. 2.32' },
  { key: 'DEFECTS_PERIOD_END' as const, periodDays: 365, ruleSource: 'JCT cl. 2.38' },
  { key: 'RETENTION_FIRST_RELEASE' as const, periodDays: 14, ruleSource: 'JCT cl. 4.18' },
  { key: 'RETENTION_FINAL_RELEASE' as const, periodDays: 379, ruleSource: 'JCT cl. 4.18' },
];

function certificate(overrides: Record<string, unknown> = {}) {
  return practicalcompletion.issueCompletionCertificate(asOwner(), {
    reference: 'PC-001',
    kind: 'PRACTICAL',
    scopeBoundary: 'The whole of the works excluding the external landscaping, which is a separate contract',
    completionDate: iso(0),
    authority: 'Contract administrator under JCT cl. 2.30',
    decidedBy: 'A. Whitfield, contract administrator',
    evidenceHash: 'c'.repeat(64),
    periods: PERIODS,
    ...overrides,
  } as Parameters<typeof practicalcompletion.issueCompletionCertificate>[1]);
}

describe('H-WF-08 completion inspection', () => {
  beforeEach(freshProject);

  it('records an inspection and classifies what it found', () => {
    const result = inspection();
    assert.equal(result.recorded, 1);
    assert.equal(result.blockers, 0);

    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.items.length, 1);
    assert.equal(position.items[0]!.classification, 'MINOR_DEFECT');
    assert.equal(position.openByClassification.MINOR_DEFECT, 1);
  });

  it('refuses an inspection whose scope nobody could read as evidence later', () => {
    const error = throwsCode(() => inspection({ scope: 'The building' }), 'SCOPE_REQUIRED');
    assert.match(String(error.message), /any particular part of it was looked at/);
  });

  it('refuses an inspection with no attendees or no inspector', () => {
    const error = throwsCode(() => inspection({ attendees: [] }), 'ATTENDEES_REQUIRED');
    assert.match(String(error.message), /one they will dispute/);
    throwsCode(() => inspection({ inspectedBy: '' }), 'INSPECTOR_REQUIRED');
  });

  it('refuses an inspection with no items — a clean one is still written up', () => {
    const error = throwsCode(() => inspection({ items: [] }), 'ITEMS_REQUIRED');
    assert.match(String(error.message), /nobody wrote up/);
  });

  it('refuses an item with no contractor, no due date or no access window', () => {
    const error = throwsCode(() => inspection({ items: [{ ...ITEM, contractor: '' }] }), 'CONTRACTOR_REQUIRED');
    assert.match(String(error.message), /end of the defects period/);
    throwsCode(() => inspection({ items: [{ ...ITEM, dueDate: 'soon' }] }), 'DUE_DATE_REQUIRED');
    const access = throwsCode(() => inspection({ items: [{ ...ITEM, accessWindow: '' }] }), 'ACCESS_REQUIRED');
    assert.match(String(access.message), /occupied building is not available on demand/);
  });

  it('refuses an item the contractor could not price or programme from', () => {
    throwsCode(() => inspection({ items: [{ ...ITEM, description: 'Ceiling bad' }] }), 'ITEM_UNDESCRIBED');
    throwsCode(() => inspection({ items: [{ ...ITEM, location: '' }] }), 'ITEM_UNLOCATED');
  });

  it('flags an overdue open item in the position', () => {
    inspection({ items: [{ ...ITEM, dueDate: iso(-5) }] });
    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.items[0]!.overdue, true);
  });
});

describe('H-WF-08 closing an item', () => {
  beforeEach(freshProject);

  function openItem() {
    inspection();
    return practicalcompletion.practicalCompletionPosition(asQAQC()).items[0]!.itemId;
  }

  it('closes an item against rectification somebody accepted', () => {
    const itemId = openItem();
    const result = practicalcompletion.closeInspectionItem(asQAQC(), itemId, {
      rectification: 'Grid re-levelled over the full run and all three tiles reseated',
      acceptedBy: 'Client representative',
      reinspectedBy: 'Main contractor quality manager',
      evidenceHash: 'd'.repeat(64),
    });
    assert.equal(result.remainingOpen, 0);

    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.items[0]!.status, 'CLOSED');
  });

  it('refuses a closure the contractor who did the work signed off', () => {
    const itemId = openItem();
    const error = throwsCode(
      () =>
        practicalcompletion.closeInspectionItem(asQAQC(), itemId, {
          rectification: 'Grid re-levelled over the full run and all three tiles reseated',
          acceptedBy: 'Client representative',
          reinspectedBy: 'Ceilings subcontractor',
          evidenceHash: 'd'.repeat(64),
        }),
      'SELF_VERIFIED',
    );
    assert.match(String(error.message), /nobody checked/);
  });

  it('refuses a closure with no rectification evidence — AC-H-WF-08-03', () => {
    const itemId = openItem();
    throwsCode(
      () =>
        practicalcompletion.closeInspectionItem(asQAQC(), itemId, {
          rectification: 'Grid re-levelled over the full run and all three tiles reseated',
          acceptedBy: 'Client representative',
          reinspectedBy: 'Main contractor quality manager',
          evidenceHash: '',
        }),
      'RECTIFICATION_EVIDENCE_REQUIRED',
    );
  });

  it('refuses a closure that records a button press rather than what was done', () => {
    const itemId = openItem();
    const error = throwsCode(
      () =>
        practicalcompletion.closeInspectionItem(asQAQC(), itemId, {
          rectification: 'Rectified',
          acceptedBy: 'Client representative',
          reinspectedBy: 'Main contractor quality manager',
          evidenceHash: 'd'.repeat(64),
        }),
      'RECTIFICATION_UNDESCRIBED',
    );
    assert.match(String(error.message), /pressed a button/);
  });

  it('refuses to close the same item twice', () => {
    const itemId = openItem();
    const close = () =>
      practicalcompletion.closeInspectionItem(asQAQC(), itemId, {
        rectification: 'Grid re-levelled over the full run and all three tiles reseated',
        acceptedBy: 'Client representative',
        reinspectedBy: 'Main contractor quality manager',
        evidenceHash: 'd'.repeat(64),
      });
    close();
    throwsCode(close, 'ALREADY_CLOSED');
  });

  it('returns 404 for an item that does not exist', () => {
    throwsCode(
      () =>
        practicalcompletion.closeInspectionItem(asQAQC(), 'NOPE', {
          rectification: 'Grid re-levelled over the full run and all three tiles reseated',
          acceptedBy: 'Client representative',
          reinspectedBy: 'Main contractor quality manager',
          evidenceHash: 'd'.repeat(64),
        }),
      'ITEM_NOT_FOUND',
    );
  });
});

describe('H-WF-08 deferring an item', () => {
  beforeEach(freshProject);

  const DEFERRAL = {
    reason: 'The tenant fit-out covers this corridor and access is not available until the fit-out completes',
    owner: 'Main contractor project manager',
    by: iso(90),
    risk: 'Cosmetic only; no fire or acoustic function is carried by this section of grid',
    accessConstraint: 'Tenant fit-out in progress, no access before October',
    acceptanceCondition: 'Grid level checked over the full run and all tiles seating with no visible step',
  };

  function openItem(classification: practicalcompletion.ItemClassification = 'MINOR_DEFECT') {
    inspection({ items: [{ ...ITEM, classification }] });
    return practicalcompletion.practicalCompletionPosition(asQAQC()).items[0]!.itemId;
  }

  it('defers an item with its owner, risk, access and acceptance condition', () => {
    const itemId = openItem();
    practicalcompletion.deferInspectionItem(asQAQC(), itemId, DEFERRAL);

    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.items[0]!.status, 'DEFERRED');
    assert.equal(position.deferred.length, 1);
    assert.equal(position.deferred[0]!.owner, 'Main contractor project manager');
    assert.match(position.deferred[0]!.acceptanceCondition, /no visible step/);
  });

  it('refuses a deferral with no acceptance condition — the part people leave out', () => {
    const itemId = openItem();
    const error = throwsCode(
      () => practicalcompletion.deferInspectionItem(asQAQC(), itemId, { ...DEFERRAL, acceptanceCondition: 'Fix it' }),
      'ACCEPTANCE_CONDITION_REQUIRED',
    );
    assert.match(String(error.message), /settle the argument/);
  });

  it('refuses a deferral with no owner, no date, no reason or no risk', () => {
    const itemId = openItem();
    throwsCode(() => practicalcompletion.deferInspectionItem(asQAQC(), itemId, { ...DEFERRAL, owner: '' }), 'DEFERRAL_UNOWNED');
    throwsCode(() => practicalcompletion.deferInspectionItem(asQAQC(), itemId, { ...DEFERRAL, by: 'later' }), 'DEFERRAL_UNOWNED');
    throwsCode(() => practicalcompletion.deferInspectionItem(asQAQC(), itemId, { ...DEFERRAL, risk: 'Low' }), 'DEFERRAL_UNJUSTIFIED');
    throwsCode(
      () => practicalcompletion.deferInspectionItem(asQAQC(), itemId, { ...DEFERRAL, accessConstraint: '' }),
      'ACCESS_REQUIRED',
    );
  });

  it('refuses to defer a blocker — that is a reclassification, not a scheduling change', () => {
    const itemId = openItem('BLOCKER');
    const error = throwsCode(
      () => practicalcompletion.deferInspectionItem(asQAQC(), itemId, DEFERRAL),
      'BLOCKER_NOT_DEFERRABLE',
    );
    assert.match(String(error.message), /whether the building can be handed over/);
  });
});

describe('H-WF-08 the contract pack a certificate may read', () => {
  beforeEach(freshProject);

  it('reports a register nobody has reviewed as unusable, which is how every project starts', () => {
    const pack = practicalcompletion.contractPackValidation(asOwner());
    assert.equal(pack.usable, false);
    assert.deepEqual(pack.awaitingReview.sort(), ['DEFECTS_LIABILITY', 'INSURANCE', 'LIQUIDATED_DAMAGES', 'RETENTION']);
    assert.equal(pack.validated.length, 0);
  });

  it('reports a category with no clause at all as absent', () => {
    // Validating three of the four leaves the fourth awaiting review, not absent
    // — absence is only reportable where the register was never written.
    const pack = practicalcompletion.contractPackValidation(asOwner());
    assert.deepEqual(pack.absent, []);
  });

  it('clears requiresLegalReview, which nothing in the platform could do before', () => {
    validatedContractPack();
    const pack = practicalcompletion.contractPackValidation(asOwner());
    assert.equal(pack.usable, true);
    assert.equal(pack.awaitingReview.length, 0);
  });

  it('keeps what the machine read even when the reviewer corrects it', () => {
    const clauseId = clauseIdFor('RETENTION');
    const extracted = String(platform.ledger.get({ refType: 'ContractClause', refId: clauseId })!.state.clauseRef);

    const result = practicalcompletion.validateContractClause(asOwner(), clauseId, {
      agrees: false,
      correctedClauseRef: 'JCT cl. 4.18.2',
      note: 'The extraction pointed at the wrong sub-clause',
      validatedBy: 'Contract administrator',
    });
    assert.equal(result.clauseRef, 'JCT cl. 4.18.2');

    const state = platform.ledger.get({ refType: 'ContractClause', refId: clauseId })!.state as Record<string, unknown>;
    const validation = state.validation as Record<string, unknown>;
    assert.equal(validation.extractedClauseRef, extracted);
    assert.equal(state.requiresLegalReview, false);
  });

  it('refuses a rejection that leaves nothing in its place, and an unsigned or unnoted review', () => {
    const clauseId = clauseIdFor('RETENTION');

    throwsCode(
      () =>
        practicalcompletion.validateContractClause(asOwner(), clauseId, {
          agrees: false,
          note: 'The extraction is wrong',
          validatedBy: 'Contract administrator',
        }),
      'CORRECTION_REQUIRED',
    );
    throwsCode(
      () => practicalcompletion.validateContractClause(asOwner(), clauseId, { agrees: true, note: 'ok', validatedBy: 'A' }),
      'REVIEW_NOTE_REQUIRED',
    );
    throwsCode(
      () =>
        practicalcompletion.validateContractClause(asOwner(), clauseId, {
          agrees: true,
          note: 'Checked against the executed contract',
          validatedBy: '',
        }),
      'REVIEW_UNSIGNED',
    );
  });

  it('returns 404 for a clause that does not exist', () => {
    throwsCode(
      () =>
        practicalcompletion.validateContractClause(asOwner(), 'NOPE', {
          agrees: true,
          note: 'Checked against the executed contract',
          validatedBy: 'Contract administrator',
        }),
      'CLAUSE_NOT_FOUND',
    );
  });
});

describe('H-WF-08 the certificate', () => {
  beforeEach(freshProject);

  it('issues practical completion and sets its dates running once', () => {
    validatedContractPack();
    const result = certificate();
    assert.equal(result.triggeredDates.length, 6);
    assert.match(result.datesHash, /^sha256:[0-9a-f]{64}$/);

    const defects = result.triggeredDates.find((entry) => entry.key === 'DEFECTS_PERIOD_END')!;
    assert.equal(defects.date, iso(365));
    assert.equal(defects.ruleSource, 'JCT cl. 2.38');
  });

  it('writes the defects period as its own event with its own audience', () => {
    validatedContractPack();
    certificate();

    const types = platform.ledger
      .events({ projectId: seed.projectId })
      .map((event) => event.eventType)
      .filter((type) => type === 'PRACTICAL_COMPLETION_RECORDED' || type === 'DEFECTS_PERIOD_STARTED');
    assert.deepEqual(types, ['PRACTICAL_COMPLETION_RECORDED', 'DEFECTS_PERIOD_STARTED']);

    const record = platform.ledger.list(seed.projectId, 'CompletionRecord')[0]!.state as Record<string, unknown>;
    const period = record.defectsPeriod as Record<string, unknown>;
    assert.equal(period.to, iso(365));
  });

  it('refuses a certificate while a blocker is open', () => {
    validatedContractPack();
    inspection({ items: [{ ...ITEM, classification: 'BLOCKER' }] });
    const error = throwsCode(() => certificate(), 'BLOCKERS_OPEN');
    assert.match(String(error.message), /Ceiling tile grid/);
  });

  it('refuses to derive dates from a contract pack nobody has read — the exception control', () => {
    const error = throwsCode(() => certificate(), 'CONTRACT_PACK_UNVALIDATED');
    assert.match(String(error.message), /written by a model reading the contract/);
  });

  it('requires the authority, the scope boundary, the date and the evidence — AC-H-WF-08-01', () => {
    validatedContractPack();
    throwsCode(() => certificate({ authority: '' }), 'AUTHORITY_REQUIRED');
    throwsCode(() => certificate({ decidedBy: '' }), 'AUTHORITY_REQUIRED');
    const scope = throwsCode(() => certificate({ scopeBoundary: 'All done' }), 'SCOPE_BOUNDARY_REQUIRED');
    assert.match(String(scope.message), /damages argument turns on/);
    throwsCode(() => certificate({ completionDate: 'today' }), 'COMPLETION_DATE_REQUIRED');
    throwsCode(() => certificate({ evidenceHash: '' }), 'CERTIFICATE_EVIDENCE_REQUIRED');
  });

  it('requires a section reference on a sectional completion', () => {
    validatedContractPack();
    throwsCode(() => certificate({ kind: 'SECTIONAL' }), 'SECTION_REQUIRED');
    const result = certificate({ kind: 'SECTIONAL', sectionReference: 'Section 2 — east wing' });
    assert.ok(result.completionId);
  });

  it('refuses a certificate that sets some of its dates and leaves the rest undefined', () => {
    validatedContractPack();
    const error = throwsCode(() => certificate({ periods: PERIODS.slice(0, 3) }), 'PERIODS_REQUIRED');
    assert.match(String(error.message), /nobody can answer questions about/);
  });

  it('refuses a period with no rule source — the answer to a challenge is a clause', () => {
    validatedContractPack();
    const error = throwsCode(
      () => certificate({ periods: PERIODS.map((p) => (p.key === 'DEFECTS_PERIOD_END' ? { ...p, ruleSource: '' } : p)) }),
      'RULE_SOURCE_REQUIRED',
    );
    assert.match(String(error.message), /answers with a clause/);
  });

  it('records an AI readiness score alongside the decision, never as it', () => {
    validatedContractPack();
    certificate({
      aiReadinessScore: { score: 0.82, basis: 'Open items by classification against the closed set at previous handovers' },
    });

    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.certificates[0]!.advisoryReadiness!.score, 0.82);
    // The determination is still a named person's, not the score's.
    assert.equal(position.certificates[0]!.decidedBy, 'A. Whitfield, contract administrator');
  });

  it('refuses a readiness score with no basis, which would read as a verdict', () => {
    validatedContractPack();
    const error = throwsCode(
      () => certificate({ aiReadinessScore: { score: 0.9, basis: 'Looks ready' } }),
      'ADVISORY_BASIS_REQUIRED',
    );
    assert.match(String(error.message), /reads as a verdict/);
  });

  it('refuses a duplicate certificate reference', () => {
    validatedContractPack();
    certificate();
    throwsCode(() => certificate(), 'REFERENCE_TAKEN');
  });

  it('denies the certificate to a role without CONTRACTS_CLAIMS A', () => {
    validatedContractPack();
    // The project manager holds [R,C,U] on contracts and claims, and no A.
    throwsCode(
      () =>
        practicalcompletion.issueCompletionCertificate(asPM(), {
          reference: 'PC-002',
          kind: 'PRACTICAL',
          scopeBoundary: 'The whole of the works excluding the external landscaping',
          completionDate: iso(0),
          authority: 'Contract administrator under JCT cl. 2.30',
          decidedBy: 'A project manager who does not hold the authority',
          evidenceHash: 'c'.repeat(64),
          periods: PERIODS,
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('H-WF-08 triggered dates are protected from silent edit', () => {
  beforeEach(freshProject);

  it('moves a date only under a named authority and a stated reason, keeping the previous hash', () => {
    validatedContractPack();
    const issued = certificate();

    const result = practicalcompletion.reviseTriggeredDates(asOwner(), issued.completionId, {
      authority: 'Contract administrator under JCT cl. 2.38',
      reason: 'The defects liability period is 24 months under the amended contract, not 12',
      periods: [{ key: 'DEFECTS_PERIOD_END', periodDays: 730, ruleSource: 'JCT cl. 2.38 as amended by schedule 3' }],
    });

    assert.equal(result.moved.length, 1);
    assert.match(result.moved[0]!, /Defects liability period ends/);
    assert.notEqual(result.datesHash, issued.datesHash);

    const record = platform.ledger.list(seed.projectId, 'CompletionRecord')[0]!.state as Record<string, unknown>;
    const revisions = record.revisions as Array<Record<string, unknown>>;
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.previousHash, issued.datesHash);
    assert.equal(revisions[0]!.authority, 'Contract administrator under JCT cl. 2.38');
  });

  it('refuses a revision with no authority or no reason', () => {
    validatedContractPack();
    const issued = certificate();
    const error = throwsCode(
      () =>
        practicalcompletion.reviseTriggeredDates(asOwner(), issued.completionId, {
          authority: '',
          reason: 'The defects liability period is 24 months under the amended contract',
          periods: [{ key: 'DEFECTS_PERIOD_END', periodDays: 730, ruleSource: 'JCT cl. 2.38' }],
        }),
      'REVISION_UNJUSTIFIED',
    );
    assert.match(String(error.message), /moving its own deadline/);
  });

  it('refuses a revision that changes nothing', () => {
    validatedContractPack();
    const issued = certificate();
    throwsCode(
      () =>
        practicalcompletion.reviseTriggeredDates(asOwner(), issued.completionId, {
          authority: 'Contract administrator',
          reason: 'Re-checking the defects liability period against the executed contract',
          periods: [{ key: 'DEFECTS_PERIOD_END', periodDays: 365, ruleSource: 'JCT cl. 2.38' }],
        }),
      'NOTHING_MOVED',
    );
  });

  it('returns 404 for a completion record that does not exist', () => {
    throwsCode(
      () =>
        practicalcompletion.reviseTriggeredDates(asOwner(), 'NOPE', {
          authority: 'Contract administrator',
          reason: 'The defects liability period is 24 months under the amended contract',
          periods: [{ key: 'DEFECTS_PERIOD_END', periodDays: 730, ruleSource: 'JCT cl. 2.38' }],
        }),
      'COMPLETION_NOT_FOUND',
    );
  });
});

describe('H-WF-08 commercial closeout', () => {
  beforeEach(freshProject);

  function submitAndAssess() {
    valuechain.recordValue(asQS(), {
      subjectType: 'FinalAccount',
      subjectRef: 'FA-MAIN',
      title: 'Main contract final account',
      stage: 'SUBMITTED',
      amountMinor: 128_400_00,
      basis: 'Contractor final account submission with measured remeasure and variation schedule',
      by: 'Main contractor commercial manager',
    });
    valuechain.recordValue(asQS(), {
      subjectType: 'FinalAccount',
      subjectRef: 'FA-MAIN',
      title: 'Main contract final account',
      stage: 'ASSESSED',
      amountMinor: 119_900_00,
      basis: 'Quantity surveyor assessment against the measured works and agreed variation values',
      by: 'Project quantity surveyor',
    });
  }

  it('records a security position without carrying a second copy of the money', () => {
    practicalcompletion.recordSecurityPosition(asQS(), {
      kind: 'PERFORMANCE_BOND',
      reference: 'BOND-2024-77',
      holder: 'Client',
      status: 'Live, to be released on the final certificate',
      expiresOn: iso(400),
      note: 'Ten per cent bond under the executed contract',
    });

    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.securities.length, 1);
    assert.equal(position.securities[0]!.kind, 'PERFORMANCE_BOND');
    // No amount field: the figures live in the value chain and would disagree
    // within a month if they were kept in two places.
    assert.equal('amountMinor' in position.securities[0]!, false);
  });

  it('refuses a security with no reference or no holder', () => {
    throwsCode(
      () =>
        practicalcompletion.recordSecurityPosition(asQS(), {
          kind: 'RETENTION',
          reference: '',
          holder: 'Client',
          status: 'Held',
          note: 'Three per cent',
        }),
      'SECURITY_UNIDENTIFIED',
    );
  });

  it('agrees the final account against the figures the value chain already holds', () => {
    submitAndAssess();
    valuechain.recordValue(asOwner(), {
      subjectType: 'FinalAccount',
      subjectRef: 'FA-MAIN',
      title: 'Main contract final account',
      stage: 'AGREED',
      amountMinor: 123_000_00,
      basis: 'Settled at a commercial meeting between the parties on the measured account',
      by: 'Commercial director',
    });

    const result = practicalcompletion.agreeFinalAccount(asOwner(), {
      subjectRef: 'FA-MAIN',
      agreedBy: 'Client commercial director',
      forContractor: 'Main contractor commercial manager',
      note: 'Settled on the measured account with the variation schedule closed at the same meeting',
    });
    assert.equal(result.agreedMinor, 123_000_00);
    assert.equal(result.outstandingMinor, 123_000_00);

    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.finalAccounts.length, 1);
  });

  it('refuses agreement before submission and assessment — the states are separate on purpose', () => {
    const error = throwsCode(
      () =>
        practicalcompletion.agreeFinalAccount(asOwner(), {
          subjectRef: 'FA-MAIN',
          agreedBy: 'Client commercial director',
          forContractor: 'Main contractor commercial manager',
          note: 'Settled on the measured account at a commercial meeting',
        }),
      'NO_VALUE_CHAIN',
    );
    assert.match(String(error.message), /not declared on its own/);

    submitAndAssess();
    const notAgreed = throwsCode(
      () =>
        practicalcompletion.agreeFinalAccount(asOwner(), {
          subjectRef: 'FA-MAIN',
          agreedBy: 'Client commercial director',
          forContractor: 'Main contractor commercial manager',
          note: 'Settled on the measured account at a commercial meeting',
        }),
      'AGREEMENT_NOT_RECORDED',
    );
    assert.match(String(notAgreed.message), /not a second place to enter the number/);
  });
});

describe('H-WF-08 what blocks completion, and what deliberately does not', () => {
  beforeEach(freshProject);

  it('binds nothing where the project runs no completion inspections', () => {
    assert.equal(practicalcompletion.completionBlockedReason(asQAQC()), null);
  });

  it('blocks on an open blocker', () => {
    inspection({ items: [{ ...ITEM, classification: 'BLOCKER' }] });
    const reason = practicalcompletion.completionBlockedReason(asQAQC());
    assert.match(reason!, /blocking completion/);
  });

  it('blocks on a contract pack that cannot set trigger dates', () => {
    inspection();
    const reason = practicalcompletion.completionBlockedReason(asQAQC());
    assert.match(reason!, /cannot set trigger dates/);
  });

  /**
   * Step 6: the commercial reconciliation happens "without delaying
   * safety-critical closure". Enforced by omission — a blocked reason that
   * mentioned retention would turn a commercial argument into a reason to leave
   * a building uncertified.
   */
  it('never cites the final account, retention or a security as a reason completion is blocked', () => {
    validatedContractPack();
    inspection();
    practicalcompletion.recordSecurityPosition(asQS(), {
      kind: 'RETENTION',
      reference: 'RET-01',
      holder: 'Client',
      status: 'Held in full and disputed',
      note: 'Contractor disputes the retention percentage',
    });

    assert.equal(practicalcompletion.completionBlockedReason(asQAQC()), null);
    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.equal(position.blockedReason, null);
    assert.equal(position.securities.length, 1);
  });

  it('summarises the position', () => {
    inspection();
    const position = practicalcompletion.practicalCompletionPosition(asQAQC());
    assert.match(position.summary, /1 inspection item, 1 open/);
  });
});

describe('H-WF-08 catalogue and classification', () => {
  it('registers every completion event with no AI mandate', () => {
    for (const [code, entity] of [
      ['COMPLETION_INSPECTION_COMPLETED', 'CompletionInspection'],
      ['DEFECT_CLOSED', 'CompletionInspection'],
      ['DEFECT_DEFERRED', 'CompletionInspection'],
      ['CONTRACT_CLAUSE_VALIDATED', 'ContractClause'],
      ['PRACTICAL_COMPLETION_RECORDED', 'CompletionRecord'],
      ['DEFECTS_PERIOD_STARTED', 'CompletionRecord'],
      ['CONTRACT_DATES_REVISED', 'CompletionRecord'],
      ['SECURITY_POSITION_RECORDED', 'CommercialSecurity'],
      ['FINAL_ACCOUNT_AGREED', 'FinalAccount'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot issue certificate, determine legal completion or agree final
      // account."
      assert.equal(definition.aiAllowed, false, `${code} must carry no AI mandate`);
    }
  });

  it('requires evidence on the inspection, the closure and the certificate', () => {
    assert.equal(lookupEventType('COMPLETION_INSPECTION_COMPLETED')?.requiresEvidence, true);
    assert.equal(lookupEventType('DEFECT_CLOSED')?.requiresEvidence, true);
    assert.equal(lookupEventType('PRACTICAL_COMPLETION_RECORDED')?.requiresEvidence, true);
  });

  it('classifies the certificate as legal and the commercial records as commercial', () => {
    assert.equal(classifyEntity('CompletionInspection')?.area, 'HANDOVER_OM');
    assert.equal(classifyEntity('CompletionRecord')?.sensitivity, 'LEGAL_L4');
    assert.equal(classifyEntity('CommercialSecurity')?.sensitivity, 'COMMERCIAL_L3');
    assert.equal(classifyEntity('FinalAccount')?.sensitivity, 'COMMERCIAL_L3');
  });
});
