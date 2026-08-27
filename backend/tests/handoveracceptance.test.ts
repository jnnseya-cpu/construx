import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as handoveracceptance from '../src/domain/handoveracceptance.ts';
import * as structure from '../src/domain/structure.ts';
import * as transfer from '../src/domain/transfer.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-09 — EAM/CAFM activation, handover acceptance and archive.
 *
 * This module composes eight guards that were each written with their own
 * workflow, so what is tested here is the composition, the manifest that can
 * actually be verified, the conditions that carry an owner and an expiry, and
 * the activation that has no field an asset attribute could arrive through.
 */

let platform: Platform;
let seed: SeedResult;

const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Handing the building over',
  });
}

/** A pack to decide against. The engine's compile path needs a provider, so the record is written directly. */
function pack(): string {
  const ctx = asFM();
  const packId = 'pack-under-test';
  platform.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: 'WEB',
    correlationId: 'seed-pack',
    eventType: 'HANDOVER_PACK_COMPILED',
    entity: { refType: 'HandoverPack', refId: packId },
    nextState: { id: packId, projectId: ctx.projectId, status: 'READY', contents: [], gaps: [] },
    evidenceRefs: [{ refType: 'EvidenceItem', refId: 'seed-evidence' }],
  });
  return packId;
}


/**
 * Produce genuine drift in a manifested entity, using real commands.
 *
 * A transfer item is registered and then transferred, which is a CREATE
 * followed by an UPDATE against the same record — exactly the shape a manifest
 * has to notice. Re-emitting a `creates: true` event to fake it is refused by
 * the ledger, and rightly.
 */
function transferItemThatWillDrift(): string {
  const { itemId } = transfer.registerTransferItem(asFM(), {
    reference: 'KEY-MANIFEST-01',
    kind: 'KEY',
    description: 'Plant room key registered so the manifest has something that moves',
    quantityRequired: 2,
    quantityHeld: 2,
    condition: 'New',
    storageLocation: 'Estates key cabinet',
    critical: false,
    transferOwner: 'M&E subcontractor',
  });
  return itemId;
}

function causeDrift(itemId: string): void {
  transfer.acceptTransfer(asFM(), itemId, {
    quantityReceived: 2,
    condition: 'Both received and tested in the lock',
    sender: 'M&E subcontractor',
    recipient: 'Estates manager',
    location: 'Estates office',
    receiptReference: 'RCPT-001',
    receiptHash: 'e'.repeat(64),
  });
}

const DECISION = {
  decision: 'ACCEPTED' as const,
  decidedBy: 'Client estates director',
  forOrganisation: 'Meridian Infrastructure Group',
  reasons: 'All eight domains reported ready and the manifest verified against the live record',
};

const CONDITION = {
  description: 'The landscaping irrigation controller is to be commissioned before the first growing season',
  riskOwner: 'Main contractor project manager',
  dueDate: iso(60),
  expiresOn: iso(120),
  escalateTo: 'Commercial director',
};

describe('H-WF-09 cross-domain validation', () => {
  beforeEach(freshProject);

  it('reports all eight domains', () => {
    const validation = handoveracceptance.crossDomainValidation(asFM());
    assert.equal(validation.domains.length, 8);
    assert.deepEqual(
      validation.domains.map((d) => d.key),
      ['PHYSICAL', 'COMMISSIONING', 'INFORMATION', 'ASSET', 'REGULATORY', 'COMPETENCE', 'ACCESS', 'COMMERCIAL'],
    );
  });

  /**
   * The composition rule. On a project that has run none of the handover
   * workflows every guard returns null, so acceptance is not blocked by
   * machinery the project does not use.
   */
  it('binds nothing on a project that runs none of the handover workflows', () => {
    const validation = handoveracceptance.crossDomainValidation(asFM());
    const blockingKeys = validation.blocking.map((d) => d.key);
    assert.deepEqual(blockingKeys, [], `unexpected blockers: ${JSON.stringify(validation.blocking)}`);
    assert.equal(validation.ready, true);
    assert.equal(handoveracceptance.handoverAcceptanceBlockedReason(asFM()), null);
  });

  /**
   * H-WF-08 settled that commercial closeout never delays a safety-critical
   * closure. The commercial domain therefore reports and never blocks.
   */
  it('reports the commercial position without ever blocking on it', () => {
    const validation = handoveracceptance.crossDomainValidation(asFM());
    const commercial = validation.domains.find((d) => d.key === 'COMMERCIAL')!;
    assert.equal(commercial.ready, false);
    assert.equal(commercial.blocking, false);
    assert.match(commercial.reason!, /No final account/);
    // And it is absent from the blocking set, which is what decides acceptance.
    assert.equal(validation.blocking.some((d) => d.key === 'COMMERCIAL'), false);
  });
});

describe('H-WF-09 the manifest', () => {
  beforeEach(freshProject);

  it('compiles a manifest of every entity with its hash and source version', () => {
    const packId = pack();
    const result = handoveracceptance.compileManifest(asFM(), packId);
    assert.ok(result.entries > 0, 'the demo project should hold manifestable records');
    assert.match(result.manifestHash, /^sha256:[0-9a-f]{64}$/);
  });

  it('verifies a fresh manifest against the live record', () => {
    const packId = pack();
    const { manifestId } = handoveracceptance.compileManifest(asFM(), packId);

    const verification = handoveracceptance.verifyManifest(asFM(), manifestId);
    assert.equal(verification.verified, true);
    assert.equal(verification.drifted.length, 0);
    assert.equal(verification.missing.length, 0);
  });

  /**
   * AC-H-WF-09-01. A list of hashes proves nothing until somebody recomputes
   * them, so the recomputation has to actually notice a change.
   */
  it('names what drifted when an entity changes after compilation', () => {
    const packId = pack();
    const itemId = transferItemThatWillDrift();
    const { manifestId } = handoveracceptance.compileManifest(asFM(), packId);

    causeDrift(itemId);

    const verification = handoveracceptance.verifyManifest(asFM(), manifestId);
    assert.equal(verification.verified, false);
    assert.equal(verification.drifted.length, 1);
    assert.equal(verification.drifted[0]!.refType, 'TransferItem');
    assert.equal(verification.drifted[0]!.reference, 'KEY-MANIFEST-01');
    assert.ok(verification.drifted[0]!.nowVersion > verification.drifted[0]!.wasVersion);
  });

  it('names what was added after compilation, which is progress rather than a fault', () => {
    const packId = pack();
    const { manifestId } = handoveracceptance.compileManifest(asFM(), packId);
    transferItemThatWillDrift();

    const verification = handoveracceptance.verifyManifest(asFM(), manifestId);
    assert.equal(verification.drifted.length, 0);
    assert.equal(verification.added.length, 1);
    assert.equal(verification.added[0]!.reference, 'KEY-MANIFEST-01');
    // An addition alone still leaves the manifest verified: nothing it named
    // has changed. What it means is that the pack is now a subset.
    assert.equal(verification.verified, true);
  });

  it('returns 404 for a manifest or pack that does not exist', () => {
    throwsCode(() => handoveracceptance.compileManifest(asFM(), 'NOPE'), 'PACK_NOT_FOUND');
    throwsCode(() => handoveracceptance.verifyManifest(asFM(), 'NOPE'), 'MANIFEST_NOT_FOUND');
  });
});

describe('H-WF-09 the acceptance decision', () => {
  beforeEach(freshProject);

  it('records a clean acceptance', () => {
    const packId = pack();
    const result = handoveracceptance.decideHandover(asFM(), packId, DECISION);
    assert.equal(result.decision, 'ACCEPTED');
    assert.equal(result.conditions, 0);
  });

  it('refuses to accept against a manifest that no longer matches the record', () => {
    const packId = pack();
    const itemId = transferItemThatWillDrift();
    const { manifestId } = handoveracceptance.compileManifest(asFM(), packId);
    causeDrift(itemId);

    const error = throwsCode(
      () => handoveracceptance.decideHandover(asFM(), packId, { ...DECISION, manifestId }),
      'MANIFEST_UNVERIFIED',
    );
    assert.match(String(error.message), /what is accepted is what is actually there/);
  });

  it('allows a rejection against an unverified manifest — refusing a moved target is the right call', () => {
    const packId = pack();
    const itemId = transferItemThatWillDrift();
    const { manifestId } = handoveracceptance.compileManifest(asFM(), packId);
    causeDrift(itemId);

    const result = handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'REJECTED',
      manifestId,
      reasons: 'The pack no longer matches the record it was compiled from',
    });
    assert.equal(result.manifestVerified, false);
  });

  it('freezes a rejected pack rather than editing it', () => {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'REJECTED',
      reasons: 'The as-built model was delivered without the coordinate system stated',
    });

    const state = platform.ledger.get({ refType: 'HandoverPack', refId: packId })!.state;
    assert.equal(state.frozen, true);
    assert.equal(state.decision, 'REJECTED');

    // A corrective version is a new pack, not an edit to this one.
    throwsCode(() => handoveracceptance.decideHandover(asFM(), packId, DECISION), 'ALREADY_DECIDED');
  });

  it('requires a risk owner, a due date, an expiry and an escalation on every condition', () => {
    const packId = pack();
    const conditional = { ...DECISION, decision: 'ACCEPTED_WITH_CONDITIONS' as const };

    throwsCode(() => handoveracceptance.decideHandover(asFM(), packId, conditional), 'CONDITIONS_REQUIRED');
    const unowned = throwsCode(
      () => handoveracceptance.decideHandover(asFM(), packId, { ...conditional, conditions: [{ ...CONDITION, riskOwner: '' }] }),
      'CONDITION_UNOWNED',
    );
    assert.match(String(unowned.message), /still open at the end of the aftercare period/);
    throwsCode(
      () => handoveracceptance.decideHandover(asFM(), packId, { ...conditional, conditions: [{ ...CONDITION, escalateTo: '' }] }),
      'CONDITION_UNOWNED',
    );
    throwsCode(
      () => handoveracceptance.decideHandover(asFM(), packId, { ...conditional, conditions: [{ ...CONDITION, dueDate: 'soon' }] }),
      'CONDITION_UNDATED',
    );
  });

  it('refuses a condition that expires before it is due', () => {
    const packId = pack();
    const error = throwsCode(
      () =>
        handoveracceptance.decideHandover(asFM(), packId, {
          ...DECISION,
          decision: 'ACCEPTED_WITH_CONDITIONS',
          conditions: [{ ...CONDITION, dueDate: iso(90), expiresOn: iso(30) }],
        }),
      'CONDITION_EXPIRY_INVALID',
    );
    assert.match(String(error.message), /cannot be delivered in time/);
  });

  it('refuses conditions attached to a clean acceptance', () => {
    const packId = pack();
    const error = throwsCode(
      () => handoveracceptance.decideHandover(asFM(), packId, { ...DECISION, conditions: [CONDITION] }),
      'CONDITIONS_UNEXPECTED',
    );
    assert.match(String(error.message), /obligations nobody is watching/);
  });

  it('refuses a decision with no stated reasons or no decider', () => {
    const packId = pack();
    throwsCode(() => handoveracceptance.decideHandover(asFM(), packId, { ...DECISION, reasons: 'Fine' }), 'REASONS_REQUIRED');
    throwsCode(() => handoveracceptance.decideHandover(asFM(), packId, { ...DECISION, decidedBy: '' }), 'DECIDER_REQUIRED');
  });

  it('denies the decision to a role without HANDOVER_OM A', () => {
    const packId = pack();
    // The planner holds no approval on handover.
    const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
    throwsCode(() => handoveracceptance.decideHandover(asPlanner(), packId, DECISION), 'ACCESS_DENIED');
  });
});

describe('H-WF-09 operational activation', () => {
  beforeEach(freshProject);

  function accepted(): string {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, DECISION);
    return packId;
  }

  it('raises maintenance and warranty obligations from the accepted register', () => {
    const packId = accepted();
    const result = handoveracceptance.activateOperations(asFM(), packId, {
      activatedBy: 'Client asset manager',
      maintenanceStartsOn: iso(1),
    });
    assert.ok(result.assets > 0);
    assert.ok(result.activationId);
  });

  /**
   * AC-H-WF-09-02, tested structurally. Every activated field is read from the
   * register; the command's input carries only who and when, so there is no
   * parameter an asset attribute could arrive through.
   */
  it('derives every asset field from the register, with no input that could carry one', () => {
    const packId = accepted();
    handoveracceptance.activateOperations(asFM(), packId, {
      activatedBy: 'Client asset manager',
      maintenanceStartsOn: iso(1),
    });

    const activation = platform.ledger.list(seed.projectId, 'OperationalActivation')[0]!;
    const activated = activation.state.assets as Array<Record<string, unknown>>;
    const register = platform.ledger.list(seed.projectId, 'AssetRegisterItem');

    assert.equal(activated.length, register.length);
    for (const asset of activated) {
      const source = register.find((r) => r.refId === asset.assetId)!;
      assert.equal(asset.assetTag, source.state.assetTag);
      assert.equal(asset.location, source.state.location);
    }
  });

  it('refuses to activate before a decision, and after a rejection', () => {
    const packId = pack();
    const notYet = throwsCode(
      () => handoveracceptance.activateOperations(asFM(), packId, { activatedBy: 'A', maintenanceStartsOn: iso(1) }),
      'NOT_ACCEPTED',
    );
    assert.match(String(notYet.message), /nothing to derive them from/);

    handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'REJECTED',
      reasons: 'The asset register failed its own validation on four identity attributes',
    });
    const rejected = throwsCode(
      () => handoveracceptance.activateOperations(asFM(), packId, { activatedBy: 'A', maintenanceStartsOn: iso(1) }),
      'NOT_ACCEPTED',
    );
    assert.match(String(rejected.message), /not from a rejected submission/);
  });

  it('refuses to activate twice', () => {
    const packId = accepted();
    const run = () =>
      handoveracceptance.activateOperations(asFM(), packId, {
        activatedBy: 'Client asset manager',
        maintenanceStartsOn: iso(1),
      });
    run();
    const error = throwsCode(run, 'ALREADY_ACTIVATED');
    assert.match(String(error.message), /second set of maintenance obligations/);
  });

  it('activates under a conditional acceptance — conditions are obligations, not a bar to operating', () => {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'ACCEPTED_WITH_CONDITIONS',
      conditions: [CONDITION],
    });
    const result = handoveracceptance.activateOperations(asFM(), packId, {
      activatedBy: 'Client asset manager',
      maintenanceStartsOn: iso(1),
    });
    assert.ok(result.assets > 0);
  });
});

describe('H-WF-09 baseline and archive', () => {
  beforeEach(freshProject);

  it('freezes the handover set under a named retention policy', () => {
    const result = handoveracceptance.baselineHandover(asFM(), {
      baselinedBy: 'Client estates director',
      retentionPolicy: 'Retained for the life of the asset plus twelve years under the group records policy',
      retainUntil: iso(365 * 30),
      legalHold: false,
    });
    assert.ok(result.entries > 0);
    assert.match(result.manifestHash, /^sha256:[0-9a-f]{64}$/);
  });

  it('states plainly that nothing was deleted, because nothing here can be', () => {
    handoveracceptance.baselineHandover(asFM(), {
      baselinedBy: 'Client estates director',
      retentionPolicy: 'Retained for the life of the asset plus twelve years',
      retainUntil: iso(365 * 30),
      legalHold: false,
    });
    const state = platform.ledger.list(seed.projectId, 'HandoverBaseline')[0]!.state;
    assert.match(String(state.disposition), /No record was deleted/);
  });

  it('refuses a legal hold with no reason — nobody would know when it can be lifted', () => {
    const error = throwsCode(
      () =>
        handoveracceptance.baselineHandover(asFM(), {
          baselinedBy: 'Client estates director',
          retentionPolicy: 'Retained for the life of the asset plus twelve years',
          retainUntil: iso(365 * 30),
          legalHold: true,
        }),
      'LEGAL_HOLD_UNEXPLAINED',
    );
    assert.match(String(error.message), /when it can be lifted/);
  });

  it('refuses a baseline with no retention policy or no date', () => {
    throwsCode(
      () =>
        handoveracceptance.baselineHandover(asFM(), {
          baselinedBy: 'A',
          retentionPolicy: 'Kept',
          retainUntil: iso(30),
          legalHold: false,
        }),
      'RETENTION_POLICY_REQUIRED',
    );
    throwsCode(
      () =>
        handoveracceptance.baselineHandover(asFM(), {
          baselinedBy: 'A',
          retentionPolicy: 'Retained for the life of the asset plus twelve years',
          retainUntil: 'forever',
          legalHold: false,
        }),
      'RETENTION_DATE_REQUIRED',
    );
  });
});

describe('H-WF-09 residual obligations', () => {
  beforeEach(freshProject);

  it('surfaces an acceptance condition immediately, with no transfer needed first', () => {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'ACCEPTED_WITH_CONDITIONS',
      conditions: [CONDITION],
    });

    // AC-H-WF-09-03: immediately, not on the next report.
    const residual = handoveracceptance.residualObligations(asFM());
    const condition = residual.find((item) => item.kind === 'ACCEPTANCE_CONDITION');
    assert.ok(condition, 'the condition should be visible the moment acceptance is written');
    assert.equal(condition.owner, 'Main contractor project manager');
    assert.equal(condition.sourceRef, `HandoverPack:${packId}`);
  });

  it('carries the source reference on every obligation — AC-H-WF-10-01 traceability', () => {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'ACCEPTED_WITH_CONDITIONS',
      conditions: [CONDITION],
    });
    for (const item of handoveracceptance.residualObligations(asFM())) {
      assert.ok(item.sourceRef.includes(':'), `${item.reference} has no traceable source`);
      assert.ok(item.owner.trim().length > 0, `${item.reference} has no owner`);
    }
  });

  it('refuses to record a transfer of nothing', () => {
    const error = throwsCode(
      () =>
        handoveracceptance.transferResidualObligations(asFM(), {
          toOperations: 'Estates manager',
          toAftercare: 'Main contractor aftercare lead',
          note: 'Handing over the outstanding items',
        }),
      'NOTHING_OUTSTANDING',
    );
    assert.match(String(error.message), /did not happen/);
  });

  it('transfers to named owners and keeps the list derived rather than copied', () => {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'ACCEPTED_WITH_CONDITIONS',
      conditions: [CONDITION],
    });

    const result = handoveracceptance.transferResidualObligations(asFM(), {
      toOperations: 'Estates manager',
      toAftercare: 'Main contractor aftercare lead',
      note: 'Handing over the outstanding items',
    });
    assert.equal(result.transferred, 1);

    const state = platform.ledger.list(seed.projectId, 'ResidualTransfer')[0]!.state;
    // The count at transfer is recorded; the obligations themselves are not
    // copied into it, so closing one stops it appearing without maintenance.
    assert.equal(state.countAtTransfer, 1);
    assert.equal('obligations' in state, false);
  });

  it('refuses a transfer with no named receiving owners', () => {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, {
      ...DECISION,
      decision: 'ACCEPTED_WITH_CONDITIONS',
      conditions: [CONDITION],
    });
    const error = throwsCode(
      () =>
        handoveracceptance.transferResidualObligations(asFM(), {
          toOperations: '',
          toAftercare: 'Aftercare lead',
          note: 'Handed to the client',
        }),
      'RECEIVING_OWNERS_REQUIRED',
    );
    assert.match(String(error.message), /nobody picks up/);
  });
});

describe('H-WF-09 the position', () => {
  beforeEach(freshProject);

  it('summarises the domains and reads for a role holding HANDOVER_OM R', () => {
    const position = handoveracceptance.handoverAcceptancePosition(asPM());
    assert.equal(position.domains.length, 8);
    assert.match(position.summary, /of 8 domains ready/);
    assert.equal(position.activation, null);
    assert.equal(position.baseline, null);
    assert.equal(position.transferred, false);
  });

  it('reports the activation and baseline once they exist', () => {
    const packId = pack();
    handoveracceptance.decideHandover(asFM(), packId, DECISION);
    handoveracceptance.activateOperations(asFM(), packId, {
      activatedBy: 'Client asset manager',
      maintenanceStartsOn: iso(1),
    });
    handoveracceptance.baselineHandover(asFM(), {
      baselinedBy: 'Client estates director',
      retentionPolicy: 'Retained for the life of the asset plus twelve years',
      retainUntil: iso(365 * 30),
      legalHold: true,
      legalHoldReason: 'An adjudication is live on the mechanical package',
    });

    const position = handoveracceptance.handoverAcceptancePosition(asFM());
    assert.ok(position.activation);
    assert.ok(position.activation.assets > 0);
    assert.equal(position.baseline!.legalHold, true);
    assert.equal(position.packs.find((p) => p.packId === packId)!.decision, 'ACCEPTED');
  });
});

describe('H-WF-09 catalogue and classification', () => {
  it('registers every acceptance event with no AI mandate', () => {
    for (const [code, entity] of [
      ['HANDOVER_MANIFEST_COMPILED', 'HandoverManifest'],
      ['HANDOVER_DECISION_RECORDED', 'HandoverPack'],
      ['HANDOVER_REJECTED', 'HandoverPack'],
      ['ASSET_OPERATION_ACTIVATED', 'OperationalActivation'],
      ['PROJECT_HANDOVER_BASELINED', 'HandoverBaseline'],
      ['RESIDUAL_OBLIGATIONS_TRANSFERRED', 'ResidualTransfer'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot accept asset or close obligations."
      assert.equal(definition.aiAllowed, false, `${code} must carry no AI mandate`);
    }
  });

  it('classifies the manifest and baseline as evidence records', () => {
    assert.equal(classifyEntity('HandoverManifest')?.area, 'EVIDENCE_AUDIT');
    assert.equal(classifyEntity('HandoverBaseline')?.area, 'EVIDENCE_AUDIT');
    assert.equal(classifyEntity('OperationalActivation')?.area, 'HANDOVER_OM');
    assert.equal(classifyEntity('ResidualTransfer')?.area, 'HANDOVER_OM');
  });
});
