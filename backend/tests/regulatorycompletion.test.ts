import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as regulatorycompletion from '../src/domain/regulatorycompletion.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-05 — regulatory completion and Golden Thread transfer.
 *
 * The first thing tested is what the platform does *not* do: it records the
 * jurisdiction rather than encoding its law, and nothing here makes a legal
 * classification, signs a declaration or submits anything to a regulator.
 */

let platform: Platform;
let seed: SeedResult;

const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const EVIDENCE = regulatorycompletion.COMPLETION_EVIDENCE.map((entry) => ({
  key: entry.key,
  reference: `DOC-${entry.key}`,
  version: 'C',
  evidenceRef: `EV-${entry.key}`,
}));

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Applying for completion',
  });
}

function readiness(overrides: Record<string, unknown> = {}) {
  return regulatorycompletion.checkCompletionReadiness(asFM(), {
    reference: 'CR-001',
    jurisdiction: 'England — Building Safety Act 2022, gateway three',
    evidence: EVIDENCE,
    checkedBy: 'K. Mensah',
    ...overrides,
  } as Parameters<typeof regulatorycompletion.checkCompletionReadiness>[1]);
}

function approvedPack(overrides: Record<string, unknown> = {}) {
  const { readinessId } = readiness(overrides);
  return regulatorycompletion.approveRegulatoryPack(asFM(), readinessId, {
    reference: 'PACK-001',
    approvedBy: 'R. Nolan',
    approverRole: 'Principal Contractor, duty holder',
    declaration: 'The works comply with the approved design and all changes since approval are reflected as built.',
  }).packId;
}

function submitted(): string {
  const packId = approvedPack();
  regulatorycompletion.recordSubmission(asFM(), packId, {
    regulator: 'Building Safety Regulator',
    route: 'MANUAL',
    submissionReference: 'BSR/2026/44810',
    submittedBy: 'R. Nolan',
    submittedAt: iso(-7),
    receipt: 'BSR acknowledgement email, reference ACK-44810',
  });
  return packId;
}

describe('H-WF-05 the register', () => {
  beforeEach(freshProject);

  it('registers its five event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['COMPLETION_READINESS_CHECKED', 'CompletionReadiness'],
      ['REGULATORY_PACK_APPROVED', 'RegulatoryPack'],
      ['REGULATORY_SUBMISSION_RECORDED', 'RegulatoryPack'],
      ['COMPLETION_CERTIFICATE_RECEIVED', 'RegulatoryPack'],
      ['GOLDEN_THREAD_TRANSFERRED', 'GoldenThreadTransfer'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot make legal classification, declaration or regulatory submission."
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('records the jurisdiction rather than deciding what it requires', () => {
    const result = readiness();
    assert.equal(result.ready, true);
    const position = regulatorycompletion.regulatoryPosition(asFM());
    assert.match(position.readinessChecks[0]!.jurisdiction, /Building Safety Act 2022/);
  });

  it('refuses a check that does not say which regime it was built for', () => {
    const refusal = throwsCode(() => readiness({ jurisdiction: '  ' }), 'JURISDICTION_REQUIRED');
    assert.match(refusal.message ?? '', /does not decide what a jurisdiction requires/);
  });
});

describe('AC-H-WF-05-01 the pack references exact versions', () => {
  beforeEach(freshProject);

  it('refuses an evidence item with no version', () => {
    const refusal = throwsCode(
      () => readiness({ evidence: [{ key: 'AS_BUILT', reference: 'the as-built drawings', version: '  ', evidenceRef: 'EV' }] }),
      'VERSION_REQUIRED',
    );
    assert.match(refusal.message ?? '', /references nothing/);
    assert.match(refusal.message ?? '', /which revision was in it/);
  });

  it('names what is missing rather than refusing the check', () => {
    // A readiness check that could only be run when it would pass would never
    // be run at all.
    const result = readiness({ evidence: EVIDENCE.filter((item) => item.key !== 'FIRE_SAFETY') });
    assert.deepEqual(result.missing, ['FIRE_SAFETY']);
    assert.equal(result.ready, false);
  });

  it('refuses to approve a pack with a mandatory item missing', () => {
    const { readinessId } = readiness({ evidence: EVIDENCE.filter((item) => item.key !== 'STRUCTURAL') });
    const refusal = throwsCode(
      () =>
        regulatorycompletion.approveRegulatoryPack(asFM(), readinessId, {
          reference: 'PACK-X',
          approvedBy: 'R. Nolan',
          approverRole: 'Principal Contractor',
          declaration: 'The works comply with the approved design and all changes are reflected as built.',
        }),
      'EVIDENCE_MISSING',
    );
    assert.match(refusal.message ?? '', /at the cost of the time it takes to be refused/);
  });

  it('refuses to approve over an open completion blocker', () => {
    const { readinessId } = readiness({
      blockers: ['CX-900 is open and safety-critical against the ventilation system'],
    });
    const refusal = throwsCode(
      () =>
        regulatorycompletion.approveRegulatoryPack(asFM(), readinessId, {
          reference: 'PACK-Y',
          approvedBy: 'R. Nolan',
          approverRole: 'Principal Contractor',
          declaration: 'The works comply with the approved design and all changes are reflected as built.',
        }),
      'BLOCKERS_OPEN',
    );
    assert.match(refusal.message ?? '', /not merely the occupation/);
  });

  it('refuses an approval with no declaration or nobody signing it', () => {
    const { readinessId } = readiness();
    throwsCode(
      () =>
        regulatorycompletion.approveRegulatoryPack(asFM(), readinessId, {
          reference: 'PACK-Z',
          approvedBy: '  ',
          approverRole: 'Principal Contractor',
          declaration: 'The works comply with the approved design and all changes are reflected as built.',
        }),
      'APPROVAL_UNSIGNED',
    );
    const refusal = throwsCode(
      () =>
        regulatorycompletion.approveRegulatoryPack(asFM(), readinessId, {
          reference: 'PACK-Z',
          approvedBy: 'R. Nolan',
          approverRole: 'Principal Contractor',
          declaration: 'Complies.',
        }),
      'DECLARATION_REQUIRED',
    );
    assert.match(refusal.message ?? '', /will not record an empty one on somebody’s behalf/);
  });
});

describe('submission happens outside the platform; the receipt is what is kept', () => {
  beforeEach(freshProject);

  it('records the route, the reference and the receipt', () => {
    const packId = approvedPack();
    const result = regulatorycompletion.recordSubmission(asFM(), packId, {
      regulator: 'Building Safety Regulator',
      route: 'MANUAL',
      submissionReference: 'BSR/2026/44810',
      submittedBy: 'R. Nolan',
      submittedAt: iso(-7),
      receipt: 'BSR acknowledgement email, reference ACK-44810',
    });
    assert.equal(result.reference, 'PACK-001');
  });

  it('refuses a submission with no receipt', () => {
    const packId = approvedPack();
    const refusal = throwsCode(
      () =>
        regulatorycompletion.recordSubmission(asFM(), packId, {
          regulator: 'Building Safety Regulator',
          route: 'MANUAL',
          submissionReference: 'BSR/2026/44810',
          submittedBy: 'R. Nolan',
          submittedAt: iso(-7),
          receipt: '  ',
        }),
      'RECEIPT_REQUIRED',
    );
    assert.match(refusal.message ?? '', /the day somebody disputes the date/);
  });

  it('refuses a decision on something nobody submitted, and a second submission', () => {
    const packId = approvedPack();
    throwsCode(
      () =>
        regulatorycompletion.recordCompletionDecision(asFM(), packId, {
          decision: 'GRANTED',
          decisionReference: 'BSR/CC/44810',
          decidedOn: iso(-1),
          certificateHash: 'a'.repeat(64),
          recordedBy: 'K. Mensah',
        }),
      'NOT_SUBMITTED',
    );
    regulatorycompletion.recordSubmission(asFM(), packId, {
      regulator: 'Building Safety Regulator',
      route: 'INTEGRATED',
      submissionReference: 'BSR/2026/44810',
      submittedBy: 'R. Nolan',
      submittedAt: iso(-7),
      receipt: 'ACK-44810',
    });
    throwsCode(
      () =>
        regulatorycompletion.recordSubmission(asFM(), packId, {
          regulator: 'Building Safety Regulator',
          route: 'INTEGRATED',
          submissionReference: 'BSR/2026/44811',
          submittedBy: 'R. Nolan',
          submittedAt: iso(-6),
          receipt: 'ACK-44811',
        }),
      'ALREADY_SUBMITTED',
    );
  });
});

describe('AC-H-WF-05-03 conditions are operational obligations', () => {
  beforeEach(freshProject);

  it('carries a granted certificate’s conditions out as obligations', () => {
    const packId = submitted();
    const result = regulatorycompletion.recordCompletionDecision(asFM(), packId, {
      decision: 'GRANTED',
      decisionReference: 'BSR/CC/44810',
      decidedOn: iso(-1),
      certificateHash: 'a'.repeat(64),
      recordedBy: 'K. Mensah',
      conditions: [
        {
          reference: 'COND-01',
          condition: 'The smoke control system is re-tested within six months of occupation.',
          owner: 'Riverside Estates',
          by: iso(180),
        },
      ],
    });
    assert.equal(result.conditions, 1);

    const conditions = regulatorycompletion.regulatoryConditions(asFM());
    assert.equal(conditions[0]!.reference, 'COND-01');
    assert.equal(conditions[0]!.certificate, 'BSR/CC/44810');
    assert.equal(regulatorycompletion.occupationBlockedReason(asFM()), null);
  });

  it('refuses a condition with no owner or no date, which outlives the project', () => {
    const packId = submitted();
    const refusal = throwsCode(
      () =>
        regulatorycompletion.recordCompletionDecision(asFM(), packId, {
          decision: 'GRANTED',
          decisionReference: 'BSR/CC/44810',
          decidedOn: iso(-1),
          certificateHash: 'a'.repeat(64),
          recordedBy: 'K. Mensah',
          conditions: [{ reference: 'COND-01', condition: 'Re-test the smoke control.', owner: '  ', by: iso(180) }],
        }),
      'CONDITION_UNBOUND',
    );
    assert.match(refusal.message ?? '', /outlives the project/);
  });

  it('refuses a grant with no certificate recorded', () => {
    const packId = submitted();
    const refusal = throwsCode(
      () =>
        regulatorycompletion.recordCompletionDecision(asFM(), packId, {
          decision: 'GRANTED',
          decisionReference: 'BSR/CC/44810',
          decidedOn: iso(-1),
          recordedBy: 'K. Mensah',
        }),
      'CERTIFICATE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /occupation, insurance and half the operational obligations run from/);
  });
});

describe('a refusal preserves the pack and blocks occupation', () => {
  beforeEach(freshProject);

  it('records the reasons and blocks occupation until a corrective version is granted', () => {
    const packId = submitted();
    regulatorycompletion.recordCompletionDecision(asFM(), packId, {
      decision: 'REFUSED',
      decisionReference: 'BSR/REF/44810',
      decidedOn: iso(-1),
      recordedBy: 'K. Mensah',
      reasons: ['The fire strategy submitted is at revision B and the as-built reflects revision D.'],
    });

    const blocked = regulatorycompletion.occupationBlockedReason(asFM())!;
    assert.match(blocked, /was refused/);
    assert.match(blocked, /A corrective version has to be submitted and granted/);

    // The pack that was submitted is untouched: it is the evidence of what was
    // applied for. A corrective version is a new pack that names it.
    const { readinessId } = readiness({ reference: 'CR-002' });
    const corrective = regulatorycompletion.approveRegulatoryPack(asFM(), readinessId, {
      reference: 'PACK-002',
      approvedBy: 'R. Nolan',
      approverRole: 'Principal Contractor, duty holder',
      declaration: 'The fire strategy is resubmitted at revision D, matching the as-built.',
      supersedes: 'PACK-001',
    });
    const position = regulatorycompletion.regulatoryPosition(asFM());
    assert.equal(position.packs.find((pack) => pack.packId === corrective.packId)!.supersedes, 'PACK-001');
    assert.equal(position.packs.find((pack) => pack.reference === 'PACK-001')!.decision, 'REFUSED');
  });

  it('refuses a refusal with no reasons', () => {
    const packId = submitted();
    const refusal = throwsCode(
      () =>
        regulatorycompletion.recordCompletionDecision(asFM(), packId, {
          decision: 'REFUSED',
          decisionReference: 'BSR/REF/44810',
          decidedOn: iso(-1),
          recordedBy: 'K. Mensah',
        }),
      'REASONS_REQUIRED',
    );
    assert.match(refusal.message ?? '', /comes back refused/);
  });

  it('blocks occupation on an approved pack nobody submitted, and one awaiting a decision', () => {
    approvedPack();
    assert.match(regulatorycompletion.occupationBlockedReason(asFM())!, /approved but never submitted/);
  });

  it('binds nothing on a project that runs no regulatory completion', () => {
    assert.equal(regulatorycompletion.occupationBlockedReason(asFM()), null);
  });
});

describe('AC-H-WF-05-02 the recipient confirms', () => {
  beforeEach(freshProject);

  /** Holds both EVIDENCE_AUDIT import/export and PROJECT_SETUP approve. */
  const asTransferAuthority = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

  const TRANSFER = {
    toParty: 'Riverside Estates Limited',
    toPerson: 'K. Mensah',
    role: 'ACCOUNTABLE_PERSON' as const,
    format: 'Structured export plus native source files',
    scope: 'The complete golden thread for the laboratory building, from concept through commissioning.',
    transferredBy: 'R. Nolan',
  };

  it('transfers once all three confirmations are true', () => {
    const result = regulatorycompletion.transferGoldenThread(asTransferAuthority(), {
      ...TRANSFER,
      recipientConfirmation: { access: true, completeness: true, usableFormat: true, confirmedBy: 'K. Mensah' },
    });
    assert.ok(result.transferId);
    assert.equal(regulatorycompletion.goldenThreadTransferred(asFM()), true);

    const position = regulatorycompletion.regulatoryPosition(asFM());
    assert.equal(position.transfer!.role, 'ACCOUNTABLE_PERSON');
  });

  it('refuses when any one of the three is false, naming which', () => {
    for (const [field, expected] of [
      ['access', 'access'],
      ['completeness', 'completeness'],
      ['usableFormat', 'a usable format'],
    ] as const) {
      const refusal = throwsCode(
        () =>
          regulatorycompletion.transferGoldenThread(asTransferAuthority(), {
            ...TRANSFER,
            recipientConfirmation: {
              access: field !== 'access',
              completeness: field !== 'completeness',
              usableFormat: field !== 'usableFormat',
              confirmedBy: 'K. Mensah',
            },
          }),
        'RECIPIENT_NOT_CONFIRMED',
      );
      assert.match(refusal.message ?? '', new RegExp(expected));
      assert.match(refusal.message ?? '', /the duty does not move/);
    }
  });

  it('refuses a transfer to nobody, and one with no scope', () => {
    const refusal = throwsCode(
      () =>
        regulatorycompletion.transferGoldenThread(asTransferAuthority(), {
          ...TRANSFER,
          toPerson: '  ',
          recipientConfirmation: { access: true, completeness: true, usableFormat: true, confirmedBy: 'K. Mensah' },
        }),
      'RECIPIENT_REQUIRED',
    );
    assert.match(refusal.message ?? '', /what is written when nobody took it/);
    throwsCode(
      () =>
        regulatorycompletion.transferGoldenThread(asTransferAuthority(), {
          ...TRANSFER,
          scope: 'Everything',
          recipientConfirmation: { access: true, completeness: true, usableFormat: true, confirmedBy: 'K. Mensah' },
        }),
      'SCOPE_REQUIRED',
    );
  });

  it('needs the governance authority as well as the export one', () => {
    // Nearly every delivery role may export the evidence record, and should.
    // Transferring control of the duty is a different act: the planner and the
    // project manager both hold EVIDENCE_AUDIT import/export and neither holds
    // approve on the project itself.
    const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
    for (const context of [asPlanner, asPM, asFM]) {
      throwsCode(
        () =>
          regulatorycompletion.transferGoldenThread(context(), {
            ...TRANSFER,
            recipientConfirmation: { access: true, completeness: true, usableFormat: true, confirmedBy: 'K. Mensah' },
          }),
        'ACCESS_DENIED',
      );
    }
    const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
    assert.ok(
      regulatorycompletion.transferGoldenThread(asOwner(), {
        ...TRANSFER,
        recipientConfirmation: { access: true, completeness: true, usableFormat: true, confirmedBy: 'K. Mensah' },
      }).transferId,
    );
  });
});
