import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as commissioningclose from '../src/domain/commissioningclose.ts';
import * as commissioningexception from '../src/domain/commissioningexception.ts';
import * as prefunctional from '../src/domain/prefunctional.ts';
import * as reliability from '../src/domain/reliability.ts';
import * as stagegate from '../src/domain/stagegate.ts';
import * as structure from '../src/domain/structure.ts';
import * as systemisation from '../src/domain/systemisation.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CM-WF-08 — training, documentation readiness and the commissioning gate — and
 * the 10.4 Definition of Done it is decided against.
 */

let platform: Platform;
let seed: SeedResult;

const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const FULL_DOSSIER = commissioningclose.DOSSIER_RECORD.map((record) => ({
  key: record.key,
  reference: `DOC-${record.key}`,
  revision: 'C',
  evidenceRef: `EV-${record.key}`,
}));

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(asOwner(), { to: 'COMMISSIONING', justification: 'Closing out commissioning' });

  systemisation.defineSystem(asQAQC(), {
    tag: 'FAC-01',
    level: 'FACILITY',
    name: 'Riverside Laboratory',
    boundary: 'The whole demised premises within the site boundary, excluding incoming utility connections.',
  });
  systemisation.defineSystem(asQAQC(), {
    tag: 'MEC-VENT',
    level: 'SYSTEM',
    parentTag: 'FAC-01',
    name: 'Ventilation',
    boundary: 'All supply and extract air handling from intake louvre to terminal device.',
    assetTags: ['AHU-01'],
  });
}

function training(overrides: Record<string, unknown> = {}) {
  return commissioningclose.recordTraining(asQAQC(), {
    reference: 'TR-001',
    systemTag: 'MEC-VENT',
    role: 'Estates duty engineer',
    deliveredAgainst: [
      { reference: 'CD-VENT-01', revision: 'B' },
      { reference: 'OM-VENT', revision: 'C' },
    ],
    deliveredBy: 'D. Okonjo',
    deliveredAt: iso(-3),
    attendees: [
      { name: 'K. Mensah', role: 'Duty engineer', organisation: 'Estates', competent: true },
      { name: 'L. Rowe', role: 'Duty engineer', organisation: 'Estates', competent: false },
    ],
    ...overrides,
  } as Parameters<typeof commissioningclose.recordTraining>[1]);
}

describe('CM-WF-08 the register', () => {
  beforeEach(freshProject);

  it('registers its five event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['TRAINING_DELIVERED', 'TrainingSession'],
      ['TRAINING_INVALIDATED', 'TrainingSession'],
      ['COMMISSIONING_DOSSIER_COMPILED', 'CommissioningDossier'],
      ['SYSTEM_COMMISSIONING_ACCEPTED', 'SystemAcceptance'],
      ['COMMISSIONING_COMPLETE', 'CommissioningCompletion'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot certify competence or system acceptance."
      assert.equal(definition.aiAllowed, false);
    }
  });
});

describe('AC-CM-WF-08-01 completeness from required records, not files', () => {
  beforeEach(freshProject);

  it('scores the dossier over the required list and hashes the index', () => {
    const result = commissioningclose.compileDossier(asQAQC(), {
      systemTag: 'MEC-VENT',
      entries: FULL_DOSSIER,
      compiledBy: 'S. Kaur',
    });
    assert.equal(result.completenessPercent, 100);
    assert.deepEqual(result.missing, []);
    assert.match(result.indexHash, /^sha256:[0-9a-f]{64}$/);
  });

  it('does not let a second copy of one record raise completeness', () => {
    const refusal = throwsCode(
      () =>
        commissioningclose.compileDossier(asQAQC(), {
          systemTag: 'MEC-VENT',
          entries: [...FULL_DOSSIER, { key: 'OM_MANUAL', reference: 'OM-VENT-OLD', revision: 'A', evidenceRef: 'EV-X' }],
          compiledBy: 'S. Kaur',
        }),
      'ENTRY_DUPLICATED',
    );
    assert.match(refusal.message ?? '', /hides which is current/);
  });

  it('names what is missing and separates the records an operator cannot start without', () => {
    const result = commissioningclose.compileDossier(asQAQC(), {
      systemTag: 'MEC-VENT',
      entries: FULL_DOSSIER.filter((entry) => entry.key !== 'OM_MANUAL' && entry.key !== 'SPARES'),
      compiledBy: 'S. Kaur',
    });
    assert.ok(result.completenessPercent < 100);
    assert.deepEqual(result.missing.sort(), ['OM_MANUAL', 'SPARES']);

    const dossier = commissioningclose.commissioningClosePosition(asQAQC()).dossiers[0]!;
    assert.deepEqual(dossier.missingCritical, ['OM_MANUAL']);
  });

  it('refuses an entry that is a filename rather than a controlled document', () => {
    const refusal = throwsCode(
      () =>
        commissioningclose.compileDossier(asQAQC(), {
          systemTag: 'MEC-VENT',
          entries: [{ key: 'AS_BUILT', reference: 'as built final FINAL.pdf', revision: '  ', evidenceRef: 'EV-1' }],
          compiledBy: 'S. Kaur',
        }),
      'ENTRY_UNREFERENCED',
    );
    assert.match(refusal.message ?? '', /is a filename/);
  });
});

describe('training on superseded information is not training', () => {
  beforeEach(freshProject);

  it('records what the session was delivered against and who was assessed competent', () => {
    const result = training();
    assert.equal(result.attended, 2);
    assert.equal(result.competent, 1);
  });

  it('invalidates every session taught from a revision that has since been replaced', () => {
    training();
    training({ reference: 'TR-002', role: 'Night shift engineer' });
    // A session taught from a revision nobody superseded is untouched.
    training({ reference: 'TR-003', role: 'BMS operator', deliveredAgainst: [{ reference: 'CD-VENT-01', revision: 'C' }] });

    const result = commissioningclose.supersedeTrainingInformation(asQAQC(), {
      reference: 'CD-VENT-01',
      supersededRevision: 'B',
      newRevision: 'C',
      recordedBy: 'S. Kaur',
    });
    assert.deepEqual(result.invalidated.sort(), ['TR-001', 'TR-002']);

    const position = commissioningclose.commissioningClosePosition(asQAQC());
    assert.deepEqual(position.retrainingOwed.sort(), ['Estates duty engineer', 'Night shift engineer']);
    assert.match(position.summary, /trained on information since superseded/);
    assert.equal(position.training.find((entry) => entry.reference === 'TR-003')!.status, 'DELIVERED');
  });

  it('refuses a session with no revision behind it, or nobody named', () => {
    const refusal = throwsCode(() => training({ deliveredAgainst: [] }), 'INFORMATION_REQUIRED');
    assert.match(refusal.message ?? '', /still moving/);
    throwsCode(() => training({ reference: 'TR-004', attendees: [] }), 'NOBODY_ATTENDED');
    const unnamed = throwsCode(
      () =>
        training({
          reference: 'TR-005',
          attendees: [{ name: '  ', role: 'Duty engineer', organisation: 'Estates', competent: true }],
        }),
      'ATTENDEE_UNNAMED',
    );
    assert.match(unnamed.message ?? '', /A headcount is not competence evidence/);
  });
});

describe('AC-CM-WF-08-02 an acceptance is a named acknowledgement', () => {
  beforeEach(async () => {
    await freshProject();
    commissioningclose.compileDossier(asQAQC(), {
      systemTag: 'MEC-VENT',
      entries: FULL_DOSSIER,
      compiledBy: 'S. Kaur',
    });
  });

  it('accepts a system with the operator named and the organisation they act for', () => {
    const result = commissioningclose.acceptSystem(asQAQC(), {
      systemTag: 'MEC-VENT',
      decision: 'ACCEPTED',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Ventilation accepted with the dossier complete and the duty engineers trained.',
    });
    assert.equal(result.decision, 'ACCEPTED');

    const acceptance = commissioningclose.commissioningClosePosition(asQAQC()).acceptances[0]!;
    assert.equal(acceptance.acknowledgedBy, 'K. Mensah (Riverside Estates)');
  });

  it('refuses an acceptance nobody acknowledged', () => {
    const refusal = throwsCode(
      () =>
        commissioningclose.acceptSystem(asQAQC(), {
          systemTag: 'MEC-VENT',
          decision: 'ACCEPTED',
          acknowledgedBy: '  ',
          acknowledgedForOrganisation: 'Riverside Estates',
          note: 'Accepted at the commissioning meeting.',
        }),
      'ACKNOWLEDGEMENT_REQUIRED',
    );
    assert.match(refusal.message ?? '', /three in the morning/);
  });

  it('refuses a conditional acceptance missing any of its four parts', () => {
    const complete = {
      operatingLimits: 'The unit may not run above 70% duty until the fan is re-raked.',
      riskOwner: 'Main contractor',
      expiresOn: iso(45),
      closurePlan: 'Fan re-raked and re-tested within the defects period, witnessed by the client adviser.',
    };
    for (const field of ['operatingLimits', 'riskOwner', 'expiresOn', 'closurePlan'] as const) {
      throwsCode(
        () =>
          commissioningclose.acceptSystem(asQAQC(), {
            systemTag: 'MEC-VENT',
            decision: 'CONDITIONAL',
            acknowledgedBy: 'K. Mensah',
            acknowledgedForOrganisation: 'Riverside Estates',
            note: 'Accepted subject to the fan being re-raked.',
            conditions: { ...complete, [field]: field === 'expiresOn' ? 'sometime' : '  ' },
          }),
        'CONDITIONS_INCOMPLETE',
      );
    }
  });

  it('blocks acceptance over an open safety-critical exception', () => {
    const { checkId } = prefunctional.startPreFunctionalCheck(asQAQC(), {
      reference: 'PFC-01',
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      inspectedBy: 'J. Byrne',
    });
    prefunctional.recordCheckItem(asQAQC(), checkId, {
      key: 'GUARDING',
      result: 'FAIL',
      note: 'Drive guard missing from the supply fan.',
      responsibility: 'Mechanical subcontractor',
      route: 'COMMISSIONING_EXCEPTION',
    });
    commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-900',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'GUARDING' },
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      severity: 'SAFETY_CRITICAL',
      blocker: true,
      probableCause: 'Guard removed for the belt change and not refitted.',
      responsibleParty: 'Mechanical subcontractor',
    });

    const refusal = throwsCode(
      () =>
        commissioningclose.acceptSystem(asQAQC(), {
          systemTag: 'MEC-VENT',
          decision: 'ACCEPTED',
          acknowledgedBy: 'K. Mensah',
          acknowledgedForOrganisation: 'Riverside Estates',
          note: 'Accepted at the commissioning meeting.',
        }),
      'CRITICAL_EXCEPTION_OPEN',
    );
    assert.match(refusal.message ?? '', /believing it was checked/);

    // Rejecting it is always available — that is what a rejection is for.
    assert.ok(
      commissioningclose.acceptSystem(asQAQC(), {
        systemTag: 'MEC-VENT',
        decision: 'REJECTED',
        acknowledgedBy: 'K. Mensah',
        acknowledgedForOrganisation: 'Riverside Estates',
        note: 'Not accepted while the drive guard is missing.',
      }),
    );
  });

  it('blocks acceptance while the dossier is missing a record an operator cannot start without', async () => {
    await freshProject();
    commissioningclose.compileDossier(asQAQC(), {
      systemTag: 'MEC-VENT',
      entries: FULL_DOSSIER.filter((entry) => entry.key !== 'FIRE_SAFETY_INFORMATION'),
      compiledBy: 'S. Kaur',
    });
    const refusal = throwsCode(
      () =>
        commissioningclose.acceptSystem(asQAQC(), {
          systemTag: 'MEC-VENT',
          decision: 'ACCEPTED',
          acknowledgedBy: 'K. Mensah',
          acknowledgedForOrganisation: 'Riverside Estates',
          note: 'Accepted at the commissioning meeting.',
        }),
      'DOSSIER_INCOMPLETE',
    );
    assert.match(refusal.message ?? '', /FIRE_SAFETY_INFORMATION/);
  });

  it('blocks acceptance where no dossier has been compiled at all', async () => {
    await freshProject();
    const refusal = throwsCode(
      () =>
        commissioningclose.acceptSystem(asQAQC(), {
          systemTag: 'MEC-VENT',
          decision: 'ACCEPTED',
          acknowledgedBy: 'K. Mensah',
          acknowledgedForOrganisation: 'Riverside Estates',
          note: 'Accepted at the commissioning meeting.',
        }),
      'NO_DOSSIER',
    );
    assert.match(refusal.message ?? '', /cannot run one without the other/);
  });
});

describe('AC-CM-WF-08-03 handover inherits obligations by their own identifier', () => {
  beforeEach(async () => {
    await freshProject();
    commissioningclose.compileDossier(asQAQC(), {
      systemTag: 'MEC-VENT',
      entries: FULL_DOSSIER,
      compiledBy: 'S. Kaur',
    });
  });

  it('reads seasonal tests and conditional acceptances rather than copying them', () => {
    reliability.planSeasonalTest(asQAQC(), {
      reference: 'ST-010',
      systemTag: 'MEC-VENT',
      condition: 'Outside air below 2°C sustained for six hours, which cannot occur before handover.',
      criteria: 'Frost protection holds the coil above 5°C with the supply air within 1.5°C of setpoint.',
      owner: 'D. Okonjo',
      ownerOrganisation: 'Mechanical subcontractor',
      responsibilityAcceptedBy: 'Main contractor, under the aftercare obligations',
      windowFrom: '2026-11-01',
      windowTo: '2027-03-31',
    });

    commissioningclose.acceptSystem(asQAQC(), {
      systemTag: 'MEC-VENT',
      decision: 'CONDITIONAL',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Accepted subject to the fan being re-raked within the defects period.',
      conditions: {
        operatingLimits: 'The unit may not run above 70% duty until the fan is re-raked and re-tested.',
        riskOwner: 'Main contractor',
        expiresOn: iso(45),
        closurePlan: 'Fan re-raked and re-tested within the defects period, witnessed by the client adviser.',
      },
    });

    const obligations = commissioningclose.handoverObligations(asQAQC());
    const seasonal = obligations.find((entry) => entry.reference === 'ST-010')!;
    // The identifier is the one CM-WF-06 gave it. Nothing is renumbered.
    assert.equal(seasonal.kind, 'SEASONAL_TEST');
    assert.equal(seasonal.owner, 'Main contractor, under the aftercare obligations');
    assert.ok(obligations.some((entry) => entry.reference === 'MEC-VENT/ACCEPTANCE'));
  });

  it('closes the stage once every system carries a decision', () => {
    commissioningclose.acceptSystem(asQAQC(), {
      systemTag: 'MEC-VENT',
      decision: 'ACCEPTED',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Ventilation accepted with the dossier complete.',
    });

    const result = commissioningclose.completeCommissioning(asOwner(), {
      acceptedBy: 'The Employer, by its project director',
      statement: 'Every system is accepted, the dossiers are complete and the residual obligations are stated against each.',
    });
    assert.equal(result.systemsAccepted, 1);
    assert.equal(commissioningclose.commissioningClosePosition(asQAQC()).complete, true);
  });

  it('refuses to close over a system nobody decided on, or one that was rejected', () => {
    const undecided = throwsCode(
      () =>
        commissioningclose.completeCommissioning(asOwner(), {
          acceptedBy: 'The Employer',
          statement: 'Every system is accepted and the residual obligations are stated against each.',
        }),
      'SYSTEMS_UNDECIDED',
    );
    assert.match(undecided.message ?? '', /a system nobody decided on is neither/);

    commissioningclose.acceptSystem(asQAQC(), {
      systemTag: 'MEC-VENT',
      decision: 'REJECTED',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Not accepted; the supply volumes are short of design.',
    });
    const rejected = throwsCode(
      () =>
        commissioningclose.completeCommissioning(asOwner(), {
          acceptedBy: 'The Employer',
          statement: 'Every system is accepted and the residual obligations are stated against each.',
        }),
      'SYSTEMS_REJECTED',
    );
    assert.match(rejected.message ?? '', /hands the operator something nobody accepted/);
  });

  it('refuses closure from a role that runs commissioning but does not govern the project', () => {
    commissioningclose.acceptSystem(asQAQC(), {
      systemTag: 'MEC-VENT',
      decision: 'ACCEPTED',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Ventilation accepted with the dossier complete.',
    });
    throwsCode(
      () =>
        commissioningclose.completeCommissioning(asQAQC(), {
          acceptedBy: 'S. Kaur',
          statement: 'Every system is accepted and the residual obligations are stated against each.',
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('the 10.4 stage gate', () => {
  beforeEach(freshProject);

  it('assesses the commissioning gate when the project is in that phase', () => {
    const report = stagegate.gateFor(asOwner());
    assert.equal(report.phase, 'COMMISSIONING');
    assert.equal(report.clauses.length, 7);
  });

  it('fails the inputs clause while the systemisation is unapproved', () => {
    const report = stagegate.evaluateCommissioningGate(asOwner());
    const inputs = report.clauses.find((clause) => clause.clause === 'INPUTS_COMPLETE')!;
    assert.equal(inputs.state, 'FAIL');
    assert.ok(inputs.blocking.some((entry) => entry.includes('approved systemisation')));
    assert.ok(inputs.blocking.some((entry) => entry.includes('commissioning plan')));
  });

  it('fails the downstream clause while a system carries no decision and training rests on superseded information', () => {
    training();
    commissioningclose.supersedeTrainingInformation(asQAQC(), {
      reference: 'CD-VENT-01',
      supersededRevision: 'B',
      newRevision: 'C',
      recordedBy: 'S. Kaur',
    });

    const downstream = stagegate
      .evaluateCommissioningGate(asOwner())
      .clauses.find((clause) => clause.clause === 'DOWNSTREAM_CREATED')!;
    assert.equal(downstream.state, 'FAIL');
    assert.ok(downstream.blocking.some((entry) => entry.includes('MEC-VENT')));
    assert.ok(downstream.blocking.some((entry) => entry.includes('since superseded')));
  });

  it('fails the blockers clause on an open safety-critical exception', () => {
    const { checkId } = prefunctional.startPreFunctionalCheck(asQAQC(), {
      reference: 'PFC-02',
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      inspectedBy: 'J. Byrne',
    });
    prefunctional.recordCheckItem(asQAQC(), checkId, {
      key: 'EARTHING',
      result: 'FAIL',
      note: 'Bonding not continuous across the flexible connection.',
      responsibility: 'Electrical subcontractor',
      route: 'COMMISSIONING_EXCEPTION',
    });
    commissioningexception.raiseException(asQAQC(), {
      reference: 'CX-901',
      source: { kind: 'PRE_FUNCTIONAL', checkId, itemKey: 'EARTHING' },
      systemTag: 'MEC-VENT',
      location: 'Plant room, level 3',
      severity: 'SAFETY_CRITICAL',
      blocker: true,
      probableCause: 'Bonding lead omitted at the flexible connection.',
      responsibleParty: 'Electrical subcontractor',
    });

    const blockers = stagegate
      .evaluateCommissioningGate(asOwner())
      .clauses.find((clause) => clause.clause === 'BLOCKERS_CLOSED')!;
    assert.equal(blockers.state, 'FAIL');
    assert.ok(blockers.blocking.some((entry) => entry.includes('CX-901')));
  });

  it('accounts for the AI clause as every other gate does', () => {
    // This read NOT_ASSESSABLE at every gate until assumptions, prompt version
    // and human disposition were built. It now passes on a project whose AI
    // outputs a person has decided about, and the shared clause is what all six
    // gates use — so asserting it here is asserting they still share it.
    const ai = stagegate.evaluateCommissioningGate(asOwner()).clauses.find((c) => c.clause === 'AI_ACCOUNTED');
    assert.ok(ai, 'the shared AI clause is missing from this gate');
    assert.equal(ai.state, 'PASS', ai.blocking.join('; '));
    assert.match(ai.detail, /accepted or rejected by a named person/);
  });

  it('refuses a clean pass while clauses are outstanding', () => {
    throwsCode(
      () =>
        stagegate.decideGate(asOwner(), {
          decision: 'PASS',
          rationale: 'Commissioning is finished as far as anybody can tell.',
        }),
      'GATE_NOT_MET',
    );
  });
});
