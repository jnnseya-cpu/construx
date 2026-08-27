import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as handoverrequirements from '../src/domain/handoverrequirements.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-01 — the handover requirements matrix.
 *
 * The spine of stage 11. What is tested here is that a requirement cannot be
 * closed by a file, that readiness is arithmetic somebody can drill through,
 * that a statutory obligation cannot be waived by any project authority, and
 * that a reissued source is a question rather than a silent update.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds HANDOVER_OM C and U — records requirements and submits against them. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds HANDOVER_OM A — baselines the matrix and decides requirements. */
const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });
/** Holds PROJECT_SETUP A — the only authority that can waive anything. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const BASE = {
  source: 'Employer’s requirements',
  sourceVersion: '3',
  sourceClause: 'Section 8.4',
  description: 'Operation and maintenance manuals for every mechanical system.',
  acceptanceCriteria: 'Manuals accepted by the facilities manager against the installed configuration.',
  evidenceRule: 'The facilities manager confirms each manual opens from the asset tag and matches the installed model.',
  acceptanceParty: 'Riverside Estates',
  dependency: 'MANUAL' as const,
  mandatory: true,
  statutory: false,
  weight: 3,
};

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(asOwner(), { to: 'HANDOVER', justification: 'Running the handover matrix' });
}

function requirement(reference: string, overrides: Record<string, unknown> = {}) {
  return handoverrequirements.createRequirement(asPM(), {
    reference,
    ...BASE,
    ...overrides,
  } as Parameters<typeof handoverrequirements.createRequirement>[1]).requirementId;
}

function assigned(reference: string, overrides: Record<string, unknown> = {}) {
  const requirementId = requirement(reference, overrides);
  handoverrequirements.assignDeliverable(asPM(), requirementId, {
    producer: 'Mechanical subcontractor',
    checker: 'D. Okonjo',
    approver: 'S. Kaur',
    requiredBy: (overrides.requiredBy as string) ?? iso(14),
  });
  return requirementId;
}

function accept(requirementId: string) {
  handoverrequirements.submitRequirement(asPM(), requirementId, {
    evidence: 'OM-VENT rev C',
    submittedBy: 'Mechanical subcontractor',
  });
  handoverrequirements.decideRequirement(asFM(), requirementId, {
    decision: 'ACCEPTED',
    acceptedBy: 'K. Mensah',
    forParty: 'Riverside Estates',
    reason: 'Opened each manual from the asset tag and confirmed the installed model against the nameplate.',
  });
}

describe('H-WF-01 the register', () => {
  beforeEach(freshProject);

  it('registers its event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['HANDOVER_REQUIREMENT_CREATED', 'HandoverRequirement'],
      ['DELIVERABLE_ASSIGNED', 'HandoverRequirement'],
      ['HANDOVER_MATRIX_BASELINED', 'HandoverRequirement'],
      ['HANDOVER_REQUIREMENT_SUBMITTED', 'HandoverRequirement'],
      ['HANDOVER_REQUIREMENT_DECIDED', 'HandoverRequirement'],
      ['HANDOVER_REQUIREMENT_WAIVED', 'HandoverRequirement'],
      ['HANDOVER_REQUIREMENT_DELTA_FLAGGED', 'HandoverRequirement'],
      ['HANDOVER_SECTION_DEFINED', 'HandoverSection'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Predict late/missing deliverables; cannot waive or accept."
      assert.equal(definition.aiAllowed, false);
    }
    assert.equal(classifyEntity('HandoverRequirement')?.area, 'HANDOVER_OM');
  });

  it('registers no READINESS_UPDATED event, because readiness is derived', () => {
    // The specification lists one. A stored readiness figure is the number
    // nobody updates after the requirement it was computed from moved.
    assert.equal(lookupEventType('READINESS_UPDATED'), undefined);
  });
});

describe('AC-H-WF-01-01 every requirement carries what it needs', () => {
  beforeEach(freshProject);

  it('records the source, version, clause, acceptance party and evidence rule', () => {
    const requirementId = requirement('HR-001');
    const readiness = handoverrequirements.handoverReadiness(asFM());
    const unmet = readiness.unmet.find((entry) => entry.reference === 'HR-001')!;
    assert.equal(unmet.source, 'Employer’s requirements');
    assert.equal(unmet.sourceClause, 'Section 8.4');
    assert.ok(requirementId);
  });

  it('refuses a requirement with no source, no version or no clause', () => {
    for (const field of ['source', 'sourceVersion', 'sourceClause'] as const) {
      const refusal = throwsCode(() => requirement(`HR-X-${field}`, { [field]: '  ' }), 'SOURCE_REQUIRED');
      assert.match(refusal.message ?? '', /reissue detectable/);
    }
  });

  it('refuses one with no evidence rule and one nobody accepts', () => {
    const refusal = throwsCode(() => requirement('HR-002', { evidenceRule: 'Upload it.' }), 'EVIDENCE_RULE_REQUIRED');
    assert.match(refusal.message ?? '', /document-collection exercise/);
    throwsCode(() => requirement('HR-003', { acceptanceParty: '  ' }), 'ACCEPTANCE_PARTY_REQUIRED');
  });

  it('refuses an assignment where one person is producer, checker and approver', () => {
    const requirementId = requirement('HR-004');
    const refusal = throwsCode(
      () =>
        handoverrequirements.assignDeliverable(asPM(), requirementId, {
          producer: 'D. Okonjo',
          checker: 'D. Okonjo',
          approver: 'S. Kaur',
          requiredBy: iso(14),
        }),
      'SEPARATION_BREACHED',
    );
    assert.match(refusal.message ?? '', /cannot be all of them/);
  });

  it('refuses to baseline a matrix full of unassigned rows', () => {
    requirement('HR-005');
    const refusal = throwsCode(
      () => handoverrequirements.baselineMatrix(asFM(), { baselinedBy: 'K. Mensah' }),
      'DELIVERABLES_UNASSIGNED',
    );
    assert.match(refusal.message ?? '', /a list of things somebody hopes will happen/);

    assigned('HR-006');
    handoverrequirements.assignDeliverable(asPM(), requirement('HR-007'), {
      producer: 'Mechanical subcontractor',
      checker: 'D. Okonjo',
      approver: 'S. Kaur',
      requiredBy: iso(14),
    });
    // HR-005 is still unassigned, so the baseline is still refused.
    throwsCode(() => handoverrequirements.baselineMatrix(asFM(), { baselinedBy: 'K. Mensah' }), 'DELIVERABLES_UNASSIGNED');
  });
});

describe('AC-H-WF-01-03 no requirement is closed by a file upload', () => {
  beforeEach(freshProject);

  it('needs a decision by the named acceptance party, against the evidence rule', () => {
    const requirementId = assigned('HR-010');
    handoverrequirements.submitRequirement(asPM(), requirementId, {
      evidence: 'OM-VENT rev C',
      submittedBy: 'Mechanical subcontractor',
    });

    // The document is in. The requirement is still unmet.
    let readiness = handoverrequirements.handoverReadiness(asFM());
    const pending = readiness.unmet.find((entry) => entry.reference === 'HR-010')!;
    assert.match(pending.why, /awaiting a decision from Riverside Estates/);

    handoverrequirements.decideRequirement(asFM(), requirementId, {
      decision: 'ACCEPTED',
      acceptedBy: 'K. Mensah',
      forParty: 'Riverside Estates',
      reason: 'Opened each manual from the asset tag and confirmed the installed model against the nameplate.',
    });
    readiness = handoverrequirements.handoverReadiness(asFM());
    assert.ok(!readiness.unmet.some((entry) => entry.reference === 'HR-010'));
  });

  it('refuses a decision recorded for the wrong party', () => {
    const requirementId = assigned('HR-011');
    handoverrequirements.submitRequirement(asPM(), requirementId, {
      evidence: 'OM-VENT rev C',
      submittedBy: 'Mechanical subcontractor',
    });
    const refusal = throwsCode(
      () =>
        handoverrequirements.decideRequirement(asFM(), requirementId, {
          decision: 'ACCEPTED',
          acceptedBy: 'S. Kaur',
          forParty: 'Main contractor',
          reason: 'Reviewed the manual at the handover meeting and it looked complete.',
        }),
      'WRONG_ACCEPTANCE_PARTY',
    );
    assert.match(refusal.message ?? '', /is closed by nobody/);
  });

  it('refuses a decision with no reasoning, quoting the evidence rule back', () => {
    const requirementId = assigned('HR-012');
    handoverrequirements.submitRequirement(asPM(), requirementId, {
      evidence: 'OM-VENT rev C',
      submittedBy: 'Mechanical subcontractor',
    });
    const refusal = throwsCode(
      () =>
        handoverrequirements.decideRequirement(asFM(), requirementId, {
          decision: 'ACCEPTED',
          acceptedBy: 'K. Mensah',
          forParty: 'Riverside Estates',
          reason: 'Fine.',
        }),
      'REASON_REQUIRED',
    );
    assert.match(refusal.message ?? '', /opens from the asset tag/);
    assert.match(refusal.message ?? '', /because a document was attached/);
  });

  it('refuses a decision on something nobody submitted', () => {
    const requirementId = assigned('HR-013');
    throwsCode(
      () =>
        handoverrequirements.decideRequirement(asFM(), requirementId, {
          decision: 'ACCEPTED',
          acceptedBy: 'K. Mensah',
          forParty: 'Riverside Estates',
          reason: 'Everything looked in order when we walked the plant room.',
        }),
      'NOT_SUBMITTED',
    );
  });

  it('counts an acceptance with conditions as unmet, not as done', () => {
    const requirementId = assigned('HR-014');
    handoverrequirements.submitRequirement(asPM(), requirementId, {
      evidence: 'OM-VENT rev B',
      submittedBy: 'Mechanical subcontractor',
    });
    handoverrequirements.decideRequirement(asFM(), requirementId, {
      decision: 'ACCEPTED_WITH_CONDITIONS',
      acceptedBy: 'K. Mensah',
      forParty: 'Riverside Estates',
      reason: 'The manual is usable but the control description is still at the pre-commissioning revision.',
      conditions: 'Reissue section 4 against the as-commissioned control strategy within thirty days.',
    });

    const unmet = handoverrequirements.handoverReadiness(asFM()).unmet.find((entry) => entry.reference === 'HR-014')!;
    assert.match(unmet.why, /Accepted subject to: Reissue section 4/);
  });

  it('refuses a submission from a role that only reads the matrix, and a decision from one that cannot approve', () => {
    const requirementId = assigned('HR-015');
    const asRegulator = () => platform.context(seed.users.regulator!.auth, seed.projectId, { source: 'WEB' });
    throwsCode(
      () => handoverrequirements.submitRequirement(asRegulator(), requirementId, { evidence: 'X', submittedBy: 'Y' }),
      'ACCESS_DENIED',
    );
    handoverrequirements.submitRequirement(asPM(), requirementId, {
      evidence: 'OM-VENT rev C',
      submittedBy: 'Mechanical subcontractor',
    });
    throwsCode(
      () =>
        handoverrequirements.decideRequirement(asPM(), requirementId, {
          decision: 'ACCEPTED',
          acceptedBy: 'A PM',
          forParty: 'Riverside Estates',
          reason: 'Opened the manual and it matched the installed configuration.',
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('AC-H-WF-01-02 readiness drills to the unmet requirement and its source', () => {
  beforeEach(freshProject);

  it('weights mandatory requirements only, so the advisory ones cannot inflate it', () => {
    const heavy = assigned('HR-020', { weight: 6 });
    assigned('HR-021', { weight: 2 });
    // An advisory requirement, never accepted, which must not move the figure.
    assigned('HR-022', { mandatory: false, weight: 50 });

    accept(heavy);

    const readiness = handoverrequirements.handoverReadiness(asFM());
    assert.equal(readiness.weightTotal, 8);
    assert.equal(readiness.weightAccepted, 6);
    assert.equal(readiness.percent, 75);
    // The advisory one is still listed as unmet — it is just not weighted.
    assert.ok(readiness.unmet.some((entry) => entry.reference === 'HR-022'));
  });

  it('names why each unmet requirement is unmet, and what it came from', () => {
    assigned('HR-023');
    const unmet = handoverrequirements.handoverReadiness(asFM()).unmet[0]!;
    assert.equal(unmet.source, 'Employer’s requirements');
    assert.equal(unmet.sourceClause, 'Section 8.4');
    assert.match(unmet.why, /Not yet submitted — The facilities manager confirms/);
    assert.equal(unmet.owner, 'Mechanical subcontractor');
  });

  it('flags one past the date it was required, and treats it as a blocker', () => {
    assigned('HR-024', { requiredBy: iso(-5) });
    const readiness = handoverrequirements.handoverReadiness(asFM());
    assert.deepEqual(readiness.overdue, ['HR-024']);
    assert.deepEqual(readiness.blockers, ['HR-024']);
    assert.match(readiness.summary, /past the date it was required/);
  });

  it('computes a section against its own subset rather than the whole matrix', () => {
    const inSection = assigned('HR-025');
    assigned('HR-026');
    accept(inSection);

    handoverrequirements.defineHandoverSection(asFM(), {
      reference: 'SEC-GF',
      boundary: 'The ground floor east wing from grid line 4 eastwards, including its plant but excluding the riser.',
      requirementRefs: ['HR-025'],
      definedBy: 'K. Mensah',
    });

    const readiness = handoverrequirements.handoverReadiness(asFM());
    const section = readiness.sections[0]!;
    assert.equal(section.percent, 100);
    assert.equal(section.unmet, 0);
    // Against the whole matrix, the project is only half ready.
    assert.equal(readiness.percent, 50);
  });

  it('refuses a section with no boundary or no subset', () => {
    assigned('HR-027');
    throwsCode(
      () =>
        handoverrequirements.defineHandoverSection(asFM(), {
          reference: 'SEC-X',
          boundary: 'Ground floor.',
          requirementRefs: ['HR-027'],
          definedBy: 'K. Mensah',
        }),
      'BOUNDARY_REQUIRED',
    );
    const refusal = throwsCode(
      () =>
        handoverrequirements.defineHandoverSection(asFM(), {
          reference: 'SEC-Y',
          boundary: 'The ground floor east wing from grid line 4 eastwards, including its plant.',
          requirementRefs: [],
          definedBy: 'K. Mensah',
        }),
      'SUBSET_REQUIRED',
    );
    assert.match(refusal.message ?? '', /requirements that do not apply to it/);
  });
});

describe('a statutory requirement is not waivable by any project authority', () => {
  beforeEach(freshProject);

  it('refuses the waiver outright and says why', () => {
    const requirementId = assigned('HR-030', {
      statutory: true,
      source: 'Building Safety Act 2022',
      sourceClause: 'section 87',
      description: 'Golden thread information transferred to the accountable person in a usable format.',
    });
    const refusal = throwsCode(
      () =>
        handoverrequirements.waiveRequirement(asOwner(), requirementId, {
          reason: 'The accountable person has agreed to receive it after occupation.',
          approvedBy: 'The Employer',
          expiresOn: iso(60),
        }),
      'STATUTORY_NOT_WAIVABLE',
    );
    assert.match(refusal.message ?? '', /the authority that could is not a project authority/);
    assert.match(refusal.message ?? '', /Building Safety Act 2022 section 87/);
  });

  it('waives an ordinary one, with a reason and an expiry, and takes it off the unmet list until it lapses', () => {
    const requirementId = assigned('HR-031');
    handoverrequirements.waiveRequirement(asOwner(), requirementId, {
      reason: 'The spares schedule is superseded by the framework maintenance contract, which covers the same items.',
      approvedBy: 'The Employer',
      expiresOn: iso(30),
    });

    const live = handoverrequirements.handoverReadiness(asFM());
    assert.ok(!live.unmet.some((entry) => entry.reference === 'HR-031'));
    assert.equal(live.liveWaivers[0]!.reference, 'HR-031');

    // Read at a date past the expiry, it is unmet again. A waiver with no end is
    // a deletion, and this is what stops one becoming permanent by neglect.
    const later = handoverrequirements.handoverReadiness(asFM(), iso(45));
    assert.ok(later.unmet.some((entry) => entry.reference === 'HR-031'));
  });

  it('refuses a waiver with no expiry and one from a role that runs handover but does not govern the project', () => {
    const requirementId = assigned('HR-032');
    throwsCode(
      () =>
        handoverrequirements.waiveRequirement(asOwner(), requirementId, {
          reason: 'The spares schedule is superseded by the framework maintenance contract.',
          approvedBy: 'The Employer',
          expiresOn: 'when convenient',
        }),
      'EXPIRY_REQUIRED',
    );
    throwsCode(
      () =>
        handoverrequirements.waiveRequirement(asFM(), requirementId, {
          reason: 'The spares schedule is superseded by the framework maintenance contract.',
          approvedBy: 'K. Mensah',
          expiresOn: iso(30),
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('a reissued source is a question, not a silent update', () => {
  beforeEach(freshProject);

  it('flags every requirement drawn from the version that was replaced', () => {
    assigned('HR-040');
    assigned('HR-041');
    assigned('HR-042', { sourceVersion: '4' });

    const result = handoverrequirements.recordSourceReissue(asPM(), {
      source: 'Employer’s requirements',
      fromVersion: '3',
      toVersion: '4',
      recordedBy: 'K. Mensah',
    });
    assert.deepEqual(result.flagged.sort(), ['HR-040', 'HR-041']);

    const readiness = handoverrequirements.handoverReadiness(asFM());
    assert.deepEqual(readiness.deltaReview.sort(), ['HR-040', 'HR-041']);
    assert.match(readiness.summary, /awaiting delta review after a source reissue/);
  });

  it('flags nothing where no requirement came from that version', () => {
    assigned('HR-043');
    const result = handoverrequirements.recordSourceReissue(asPM(), {
      source: 'Employer’s requirements',
      fromVersion: '1',
      toVersion: '2',
      recordedBy: 'K. Mensah',
    });
    assert.deepEqual(result.flagged, []);
  });
});
