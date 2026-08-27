import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import * as mobilisation from '../src/domain/mobilisation.ts';
import * as safetycontrol from '../src/domain/safetycontrol.ts';
import * as structure from '../src/domain/structure.ts';
import * as planning from '../src/engines/planning.ts';
import * as safety from '../src/engines/safety.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-07 — RAMS, permit, toolbox, observation and incident control.
 *
 * The safety engine could already draft a method statement, approve it, record
 * the briefing, check tickets, issue a permit, log an observation and record an
 * incident. What is tested here is the **second half** of each of those: the
 * revision nobody rebriefed, the permit nobody handed back, the observation
 * nobody closed, and the incident nobody investigated.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds SAFETY_RAMS A — approves, extends, hands back, closes. */
const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const hash = (text: string) => `sha256:${text.padEnd(64, '0').slice(0, 64)}`;

let sequence = 0;

async function briefedRAMS(): Promise<{ ramsId: string; workPackageId: string }> {
  sequence += 1;
  const { workPackageId } = planning.createWorkPackage(asPM(), {
    wbsCode: `SC-${String(sequence).padStart(3, '0')}`,
    title: `Excavation ${sequence}`,
    indicativeDurationDays: 10,
  });
  const { ramsId } = await safety.draftRAMS(asSafety(), {
    workPackageId,
    activityDescription: 'Bulk excavation to formation',
    location: 'Inlet works',
    steps: [{ description: 'Excavate in 300mm lifts', activityType: 'EXCAVATION' }],
  });
  safety.approveRAMS(asSafety(), ramsId, 'Reviewed against the excavation standard.');
  safety.acknowledgeRAMS(asSafety(), ramsId, ['OP-200', 'OP-201'], hash(`brief-${sequence}`));
  return { ramsId, workPackageId };
}

/**
 * A permit with two ticketed operatives, valid for a fortnight.
 *
 * The operatives are unique per permit. A person can legitimately hold several
 * tickets and the platform takes the longest-dated one, so reusing two names
 * across the file would let an earlier long ticket cover a later short one and
 * quietly hide the expiry check.
 */
async function issuedPermit(expiresAt = day(365)): Promise<string> {
  const { ramsId } = await briefedRAMS();
  sequence += 1;
  const crew = [`OP-${sequence}A`, `OP-${sequence}B`];
  for (const operativeId of crew) {
    safety.recordCompetency(asSafety(), {
      operativeId,
      qualification: 'Excavation / CPCS',
      issuedAt: day(-365),
      expiresAt,
      certificateHash: hash(`cert-${operativeId}-${sequence}`),
    });
  }
  return safety.issuePermit(asSafety(), {
    activity: 'EXCAVATION',
    location: `Inlet works, bay ${sequence}`,
    operativeIds: crew,
    validFrom: day(0),
    validTo: day(14),
    ramsId,
    precautions: 'Battered sides, edge protection, CAT scan before breaking ground.',
    evidenceHash: hash(`permit-${sequence}`),
  }).permitId;
}

function openIncident(): string {
  sequence += 1;
  return safety.recordIncident(asSafety(), {
    occurredAt: new Date().toISOString(),
    location: `Inlet works, bay ${sequence}`,
    category: 'NEAR_MISS',
    description: 'Excavator slew struck the edge protection with an operative inside the exclusion zone.',
    immediateAction: 'Work stopped, exclusion zone re-marked and the banksman rebriefed.',
    personsInvolved: ['OP-200'],
    riddorReportable: false,
    evidenceHash: hash(`inc-${sequence}`),
  }).incidentId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Running the site safety controls',
  });
});

describe('CN-WF-07 the register', () => {
  it('registers its six event types', () => {
    for (const [code, entity] of [
      ['RAMS_REVISED', 'RAMS'],
      ['RAMS_SUPERSEDED', 'RAMS'],
      ['PERMIT_EXTENDED', 'Permit'],
      ['PERMIT_HANDED_BACK', 'Permit'],
      ['SAFETY_ACTION_CLOSED', 'SafetyObservation'],
      ['INCIDENT_INVESTIGATED', 'Incident'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Never set acceptability." Nothing here is AI-authorable.
      assert.equal(definition.aiAllowed, false);
    }
    assert.equal(lookupEventType('PERMIT_EXTENDED')?.action, 'APPROVE');
  });
});

describe('CN-WF-07 a method that was revised and nobody rebriefed', () => {
  it('supersedes rather than edits, and names who is owed the difference', async () => {
    const { ramsId } = await briefedRAMS();
    const result = safetycontrol.reviseRAMS(asSafety(), ramsId, {
      reason: 'Ground conditions on the east side are worse than the trial holes showed.',
      whatChanged: 'Battered sides replaced with a trench box below 1.2m; a second banksman added.',
    });
    assert.equal(result.revision, 2);
    assert.deepEqual(result.owedRebriefing, ['OP-200', 'OP-201']);

    // The superseded revision stays readable: somebody worked to it.
    const old = platform.ledger.get({ refType: 'RAMS', refId: ramsId })!;
    assert.equal(old.state.supersededBy, result.revisionId);
    assert.equal(old.state.status, 'APPROVED');

    // The new one starts unapproved and unbriefed, whatever the last one was.
    const revised = platform.ledger.get({ refType: 'RAMS', refId: result.revisionId })!;
    assert.equal(revised.state.status, 'DRAFT');
    assert.deepEqual(revised.state.acknowledgements, []);
  });

  it('blocks a start while the gang is on the superseded briefing', async () => {
    const { ramsId, workPackageId } = await briefedRAMS();
    assert.equal(safetycontrol.ramsCurrencyBlockedReason(asSafety(), workPackageId), null);

    safetycontrol.reviseRAMS(asSafety(), ramsId, {
      reason: 'Method changed after the service strike.',
      whatChanged: 'Hand dig within 500mm of the marked services.',
    });

    const reason = safetycontrol.ramsCurrencyBlockedReason(asSafety(), workPackageId);
    assert.ok(reason);
    assert.match(reason, /nobody has been rebriefed/);
    assert.match(reason, /OP-200/);
  });

  it('carries that through to the CN-WF-01 readiness check', () => {
    // Reused rather than re-derived: the readiness verification asks the safety
    // module rather than growing its own opinion about a superseded method.
    const workPackageId = platform.ledger
      .list(seed.projectId, 'RAMS')
      .filter((record) => record.state.supersedes !== undefined)
      .map((record) => String(record.state.workPackageId))[0]!;
    const results = mobilisation.verifyPrerequisites(asPM(), {
      workPackageId,
      window: { from: day(1), to: day(7) },
      operativeIds: ['OP-200'],
    });
    const rams = results.find((entry) => entry.kind === 'RAMS')!;
    assert.equal(rams.status, 'NOT_MET');
    assert.match(rams.detail, /rebriefed/);
  });

  it('refuses a revision that does not say what changed', async () => {
    const { ramsId } = await briefedRAMS();
    throwsCode(
      () => safetycontrol.reviseRAMS(asSafety(), ramsId, { reason: 'Updated.', whatChanged: '  ' }),
      'REVISION_UNEXPLAINED',
    );
  });

  it('refuses to revise a revision something has already superseded', async () => {
    const { ramsId } = await briefedRAMS();
    safetycontrol.reviseRAMS(asSafety(), ramsId, { reason: 'First change.', whatChanged: 'Trench box added.' });
    throwsCode(
      () => safetycontrol.reviseRAMS(asSafety(), ramsId, { reason: 'Again.', whatChanged: 'Something else.' }),
      'RAMS_ALREADY_SUPERSEDED',
    );
  });

  it('surfaces what is awaiting a rebriefing', () => {
    const position = safetycontrol.safetyControlPosition(asSafety());
    assert.ok(position.awaitingRebriefing.length > 0);
    assert.match(position.summary, /rebriefed/);
  });
});

describe('CN-WF-07 a permit that ran out and nobody handed back', () => {
  it('extends it, and records what it ran from and to', async () => {
    const permitId = await issuedPermit();
    const result = safetycontrol.extendPermit(asSafety(), permitId, {
      validTo: day(21),
      reason: 'Ground water is slowing the dig; three more shifts needed.',
    });
    assert.equal(result.validTo, day(21));
  });

  it('refuses an extension that runs past a ticket', async () => {
    // A permit extended over a lapsed ticket authorises work by somebody nobody
    // has checked, which is what the check at issue exists to prevent.
    const permitId = await issuedPermit(day(20));
    const refusal = throwsCode(
      () => safetycontrol.extendPermit(asSafety(), permitId, { validTo: day(60), reason: 'More time needed.' }),
      'COMPETENCY_LAPSES_IN_EXTENSION',
    );
    assert.match(refusal.message ?? '', /nobody has checked/);
  });

  it('refuses an extension that shortens the permit', async () => {
    const permitId = await issuedPermit();
    throwsCode(
      () => safetycontrol.extendPermit(asSafety(), permitId, { validTo: day(3), reason: 'Finishing early.' }),
      'EXTENSION_NOT_AN_EXTENSION',
    );
  });

  it('hands the area back with the state it was left in', async () => {
    const permitId = await issuedPermit();
    const result = safetycontrol.handBackPermit(asSafety(), permitId, {
      areaCondition: 'Excavation backfilled and compacted; edge protection removed; ground level and clear.',
      checkedBy: 'M. Osei',
      outstandingHazards: 'The temporary sump remains open and is fenced pending the drainage connection.',
    });
    assert.equal(result.handedBack, true);
  });

  it('refuses a handback nobody checked', async () => {
    const permitId = await issuedPermit();
    throwsCode(
      () => safetycontrol.handBackPermit(asSafety(), permitId, { areaCondition: 'Fine.', checkedBy: '  ' }),
      'HANDBACK_UNCHECKED',
    );
  });

  it('refuses to extend or hand back a permit already handed back', async () => {
    const permitId = await issuedPermit();
    safetycontrol.handBackPermit(asSafety(), permitId, { areaCondition: 'Backfilled.', checkedBy: 'M. Osei' });
    throwsCode(
      () => safetycontrol.extendPermit(asSafety(), permitId, { validTo: day(30), reason: 'More work.' }),
      'PERMIT_NOT_OPEN',
    );
    throwsCode(
      () => safetycontrol.handBackPermit(asSafety(), permitId, { areaCondition: 'Again.', checkedBy: 'M. Osei' }),
      'PERMIT_NOT_OPEN',
    );
  });
});

describe('AC-CN-WF-07-02 every action has an owner and verification', () => {
  it('refuses a closure with no owner, no action or no verification', async () => {
    const { observationId } = await safety.logSafetyObservation(asSafety(), {
      description: 'Unprotected leading edge on the east scaffold lift.',
      location: 'Inlet works, east elevation',
      mediaHash: hash('obs-1'),
      observationType: 'UNSAFE_CONDITION',
      reportedBy: 'M. Osei',
    });
    const good = {
      owner: 'A. Okafor',
      actionTaken: 'Double guard rail and toe board fitted to the full lift.',
      verificationEvidence: 'Scaffold handover tag reissued and photographed 14th.',
      evidenceHash: hash('obs-close-1'),
    };
    for (const field of ['owner', 'actionTaken', 'verificationEvidence'] as const) {
      throwsCode(
        () => safetycontrol.closeSafetyAction(asSafety(), observationId, { ...good, [field]: '  ' }),
        'ACTION_UNVERIFIED',
      );
    }
    assert.equal(safetycontrol.closeSafetyAction(asSafety(), observationId, good).closed, true);
  });

  it('refuses to close the same observation twice', async () => {
    const { observationId } = await safety.logSafetyObservation(asSafety(), {
      description: 'Trailing lead across the walkway.',
      location: 'Compound',
      mediaHash: hash('obs-2'),
      observationType: 'UNSAFE_CONDITION',
      reportedBy: 'M. Osei',
    });
    const args = {
      owner: 'A. Okafor',
      actionTaken: 'Lead rerouted overhead.',
      verificationEvidence: 'Rechecked at the end of the shift.',
      evidenceHash: hash('obs-close-2'),
    };
    safetycontrol.closeSafetyAction(asSafety(), observationId, args);
    throwsCode(() => safetycontrol.closeSafetyAction(asSafety(), observationId, args), 'OBSERVATION_CLOSED');
  });
});

describe('CN-WF-07 an incident recorded and never investigated', () => {
  const INVESTIGATION = {
    immediateCause: 'The excavator slewed with an operative inside the exclusion zone.',
    underlyingCause: 'The exclusion zone was marked in tape that had been driven over and was no longer visible.',
    rootCause:
      'The method statement allowed a tape exclusion zone for a 13t machine, which the plant risk assessment had already ' +
      'identified as inadequate for tracked plant.',
    actions: [
      { what: 'Rigid barriers for all tracked plant exclusion zones', owner: 'M. Osei', by: '2026-09-30' },
      { what: 'Plant risk assessment findings fed back into the RAMS template', owner: 'D. Whyte', by: '2026-10-15' },
    ],
    investigatedBy: 'M. Osei',
    evidenceHash: 'sha256:aaaa',
  };

  it('refuses to close before it has been investigated', () => {
    const incidentId = openIncident();
    const refusal = throwsCode(
      () => safetycontrol.closeIncident(asSafety(), incidentId, { note: 'Sorted.' }),
      'INVESTIGATION_REQUIRED',
    );
    assert.match(refusal.message ?? '', /taught the project nothing/);
  });

  it('refuses an investigation that stops at the immediate cause', () => {
    const incidentId = openIncident();
    throwsCode(
      () =>
        safetycontrol.investigateIncident(asSafety(), incidentId, {
          ...INVESTIGATION,
          underlyingCause: '  ',
          rootCause: '  ',
        }),
      'INVESTIGATION_INCOMPLETE',
    );
  });

  it('refuses an investigation with no actions out of it', () => {
    const incidentId = openIncident();
    throwsCode(
      () => safetycontrol.investigateIncident(asSafety(), incidentId, { ...INVESTIGATION, actions: [] }),
      'ACTIONS_REQUIRED',
    );
  });

  it('refuses an action with no owner or no date', () => {
    const incidentId = openIncident();
    throwsCode(
      () =>
        safetycontrol.investigateIncident(asSafety(), incidentId, {
          ...INVESTIGATION,
          actions: [{ what: 'Something', owner: '', by: '2026-09-30' }],
        }),
      'ACTIONS_REQUIRED',
    );
    throwsCode(
      () =>
        safetycontrol.investigateIncident(asSafety(), incidentId, {
          ...INVESTIGATION,
          actions: [{ what: 'Something', owner: 'M. Osei', by: 'soon' }],
        }),
      'ACTIONS_REQUIRED',
    );
  });

  it('records the three causes and their actions, then closes', () => {
    const incidentId = openIncident();
    const result = safetycontrol.investigateIncident(asSafety(), incidentId, INVESTIGATION);
    assert.equal(result.actions, 2);

    assert.equal(safetycontrol.closeIncident(asSafety(), incidentId, { note: 'Both actions verified complete.' }).closed, true);
    throwsCode(() => safetycontrol.closeIncident(asSafety(), incidentId, { note: 'Again.' }), 'INCIDENT_CLOSED');
  });

  it('surfaces what has not been investigated and what is overdue', () => {
    openIncident();
    const position = safetycontrol.safetyControlPosition(asSafety(), '2026-12-31');
    assert.ok(position.uninvestigated.length > 0);
    assert.ok(position.outstandingActions.some((action) => action.overdue));
    assert.match(position.summary, /not investigated/);
  });

  it('still refuses to decide RIDDOR for anybody', async () => {
    // The guardrail the specification names, and it was already right: the
    // platform asks the question either way and never answers it.
    await rejectsCode(
      async () =>
        safety.recordIncident(asSafety(), {
          occurredAt: new Date().toISOString(),
          location: 'Compound',
          category: 'NEAR_MISS',
          description: 'x',
          immediateAction: 'y',
          personsInvolved: [],
          riddorReportable: undefined as unknown as boolean,
          evidenceHash: hash('riddor'),
        }),
      'RIDDOR_DECISION_REQUIRED',
    );
  });
});
