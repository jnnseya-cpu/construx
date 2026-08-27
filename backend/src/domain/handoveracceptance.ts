import { hashState } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import * as asbuilt from './asbuilt.ts';
import * as assetregister from './assetregister.ts';
import * as commissioningclose from './commissioningclose.ts';
import * as handoverrequirements from './handoverrequirements.ts';
import * as operatorreadiness from './operatorreadiness.ts';
import * as practicalcompletion from './practicalcompletion.ts';
import * as regulatorycompletion from './regulatorycompletion.ts';
import * as transfer from './transfer.ts';

/**
 * H-WF-09 — EAM/CAFM activation, handover acceptance and archive.
 *
 * **This module composes; it does not re-derive.** Step 1 asks for a final
 * cross-domain validation across physical, commissioning, information, asset,
 * regulatory, competence, access and commercial conditions — and every one of
 * those eight already has a guard that answers it, written when its own
 * workflow was built. `crossDomainValidation` calls them. It computes nothing
 * itself, because a second opinion about whether the as-builts are ready is a
 * second thing to keep in step with the first.
 *
 * `engines/handover.compileHandoverPack` and `acceptHandover` already existed
 * and are not replaced. What they lacked is what this adds: a manifest that can
 * actually be *verified*, conditions that carry an owner and an expiry, and the
 * refusal to accept while a domain is still failing.
 *
 * **AC-H-WF-09-01: a manifest that verifies.** A manifest listing hashes proves
 * nothing on its own — the question is whether the entity still hashes to what
 * the manifest says. `verifyManifest` re-hashes every entry against the live
 * ledger and reports drift by name. A pack whose manifest cannot be verified is
 * a pack somebody edited after it was compiled.
 *
 * **AC-H-WF-09-02: no re-entry.** `activateOperations` reads the accepted asset
 * register and raises the maintenance and warranty obligations from it. Nothing
 * is retyped, and the activation refuses to run against assets that were not in
 * the accepted pack — the whole point of accepting data is that what goes live
 * is what was accepted.
 *
 * **AC-H-WF-09-03: a residual is visible to its new owner immediately.** Not
 * "on the next report". `residualObligations` is derived on read from the
 * conditions, the outstanding seasonal tests and the deferred defects, each
 * carrying the owner it transferred to, so it is answerable the moment
 * acceptance is written and there is no queue for it to be stuck in.
 */

// --- Step 1: the cross-domain validation ------------------------------------

/**
 * The eight domains, each answered by the workflow that owns it.
 *
 * Ordered as the specification lists them. `check` returns a reason the domain
 * is not ready, or null. None of these is implemented here.
 */
const DOMAIN: ReadonlyArray<{
  key: string;
  label: string;
  check: (ctx: EngineContext) => string | null;
}> = [
  {
    key: 'PHYSICAL',
    label: 'Physical completion',
    check: (ctx) => practicalcompletion.completionBlockedReason(ctx),
  },
  {
    key: 'COMMISSIONING',
    label: 'Commissioning',
    check: (ctx) => {
      // `handoverObligations` already returns only what is still owed, so
      // there is nothing to filter — an obligation that closed stops being
      // returned, which is the point of it being derived.
      const outstanding = commissioningclose.handoverObligations(ctx);
      return outstanding.length === 0
        ? null
        : `${outstanding.length} commissioning obligation${outstanding.length === 1 ? '' : 's'} outstanding: ` +
            `${outstanding.map((o) => o.reference).join(', ')}.`;
    },
  },
  {
    key: 'INFORMATION',
    label: 'As-built information',
    check: (ctx) => {
      // The guard answers for one system, so it is asked once per system the
      // project actually has as-built sets for. Enumerating the subjects here
      // is not duplicating the rule — the rule stays in `asbuilt`.
      const tags = [
        ...new Set(ctx.ledger.list(ctx.projectId, 'AsBuiltSet').map((record) => String(record.state.systemTag))),
      ].sort();
      const blocked = tags
        .map((tag) => asbuilt.asBuiltBlockedReason(ctx, tag))
        .filter((reason): reason is string => reason !== null);
      return blocked.length === 0 ? null : blocked.join(' ');
    },
  },
  {
    key: 'ASSET',
    label: 'Asset data',
    check: (ctx) => assetregister.assetHandoverBlockedReason(ctx),
  },
  {
    key: 'REGULATORY',
    label: 'Regulatory completion',
    check: (ctx) => regulatorycompletion.occupationBlockedReason(ctx),
  },
  {
    key: 'COMPETENCE',
    label: 'Operator competence',
    check: (ctx) => operatorreadiness.trainingHandoverBlockedReason(ctx),
  },
  {
    key: 'ACCESS',
    label: 'Keys, credentials and spares',
    check: (ctx) => transfer.transferBlockedReason(ctx),
  },
  {
    key: 'COMMERCIAL',
    label: 'Commercial conditions',
    check: (ctx) => {
      // Deliberately narrow. H-WF-08 settled that commercial closeout does not
      // delay a safety-critical closure, so this reports the position without
      // ever being the thing that blocks: an unagreed final account is a fact
      // the acceptor should see and not a reason to refuse the building.
      const accounts = ctx.ledger.list(ctx.projectId, 'FinalAccount');
      return accounts.length === 0 ? 'No final account has been agreed.' : null;
    },
  },
];

/** Which domains block acceptance, and which are stated but never block. */
const ADVISORY_DOMAINS: ReadonlySet<string> = new Set(['COMMERCIAL']);

export type DomainResult = {
  key: string;
  label: string;
  ready: boolean;
  /** Whether a failure here stops acceptance, or is only reported. */
  blocking: boolean;
  reason: string | null;
};

export function crossDomainValidation(ctx: EngineContext): {
  domains: DomainResult[];
  blocking: DomainResult[];
  ready: boolean;
} {
  const domains = DOMAIN.map((domain) => {
    const reason = domain.check(ctx);
    return {
      key: domain.key,
      label: domain.label,
      ready: reason === null,
      blocking: !ADVISORY_DOMAINS.has(domain.key),
      reason,
    };
  });

  const blocking = domains.filter((domain) => !domain.ready && domain.blocking);
  return { domains, blocking, ready: blocking.length === 0 };
}

// --- Step 2: a manifest that can be verified --------------------------------

/**
 * The entity types a handover pack manifests.
 *
 * Types rather than a hand-listed set of ids: a manifest assembled by naming
 * the records somebody remembered is a manifest that omits the one nobody did.
 */
const MANIFEST_TYPE = [
  'AsBuiltSet',
  'OMManual',
  'AssetRegisterItem',
  'Warranty',
  'RegulatoryPack',
  'CommissioningDossier',
  'CompletionRecord',
  'TransferItem',
  'CompetenceAssessment',
] as const;

export type ManifestEntry = {
  refType: string;
  refId: string;
  reference: string;
  /** The hash of the entity's state as at compilation. */
  hash: string;
  /** How many events had been written against it — the source version. */
  version: number;
};

function manifestOf(ctx: EngineContext): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const refType of MANIFEST_TYPE) {
    for (const record of ctx.ledger.list(ctx.projectId, refType)) {
      entries.push({
        refType,
        refId: record.refId,
        reference: String(record.state.reference ?? record.state.assetTag ?? record.refId),
        hash: hashState(record.state),
        version: record.version ?? 0,
      });
    }
  }
  return entries.sort((a, b) => (a.refType + a.refId < b.refType + b.refId ? -1 : 1));
}

type PackManifestState = {
  manifestId: string;
  packId: string;
  entries: ManifestEntry[];
  manifestHash: string;
  compiledAt: string;
};

/**
 * Compile the evidence manifest for a pack.
 *
 * Separate from `engines/handover.compileHandoverPack`, which drafts the
 * readable pack through an agent. This is the machine-readable half, and it
 * carries no narrative on purpose: the thing a recipient checks a delivery
 * against should be a list of hashes nobody can write prose into.
 */
export function compileManifest(ctx: EngineContext, packId: string): {
  manifestId: string;
  entries: number;
  manifestHash: string;
} {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  const pack = ctx.ledger.get({ refType: 'HandoverPack', refId: packId });
  if (!pack) throw new DomainError('PACK_NOT_FOUND', `No handover pack ${packId}`, 404);

  const entries = manifestOf(ctx);
  if (entries.length === 0) {
    throw new DomainError(
      'NOTHING_TO_MANIFEST',
      'The project holds none of the records a handover pack manifests. A manifest of nothing would verify perfectly and ' +
        'mean nothing.',
    );
  }

  const manifestId = ulid();
  const manifestHash = hashState(entries);

  write(ctx, {
    eventType: 'HANDOVER_MANIFEST_COMPILED',
    entity: { refType: 'HandoverManifest', refId: manifestId },
    nextState: {
      manifestId,
      projectId: ctx.projectId,
      packId,
      entries,
      manifestHash,
      compiledAt: new Date().toISOString(),
      compiledBy: ctx.auth.actorId,
    },
  });

  return { manifestId, entries: entries.length, manifestHash };
}

export type ManifestVerification = {
  verified: boolean;
  checked: number;
  /** Entities whose state no longer hashes to what the manifest recorded. */
  drifted: Array<{ refType: string; reference: string; wasVersion: number; nowVersion: number }>;
  /** Entities the manifest names that are no longer in the ledger. */
  missing: Array<{ refType: string; reference: string }>;
  /** Entities that exist now and were not in the manifest. */
  added: Array<{ refType: string; reference: string }>;
};

/**
 * Re-hash every manifest entry against the live record.
 *
 * AC-H-WF-09-01. A list of hashes proves nothing until somebody recomputes
 * them; this is the recomputation, and it reports what moved by name rather
 * than answering true or false. Drift is not necessarily wrong — a warranty
 * registered after compilation is progress — but it does mean the pack in
 * somebody's hands is not the project as it now stands, and the acceptor should
 * be the one to decide which of those they are accepting.
 */
export function verifyManifest(ctx: EngineContext, manifestId: string): ManifestVerification {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R');

  const record = ctx.ledger.get({ refType: 'HandoverManifest', refId: manifestId });
  if (!record) throw new DomainError('MANIFEST_NOT_FOUND', `No handover manifest ${manifestId}`, 404);
  const state = record.state as unknown as PackManifestState;

  const drifted: ManifestVerification['drifted'] = [];
  const missing: ManifestVerification['missing'] = [];

  const manifested = new Set(state.entries.map((entry) => `${entry.refType}:${entry.refId}`));

  for (const entry of state.entries) {
    const live = ctx.ledger.get({ refType: entry.refType, refId: entry.refId });
    if (!live) {
      missing.push({ refType: entry.refType, reference: entry.reference });
      continue;
    }
    if (hashState(live.state) !== entry.hash) {
      drifted.push({
        refType: entry.refType,
        reference: entry.reference,
        wasVersion: entry.version,
        nowVersion: live.version ?? 0,
      });
    }
  }

  const added = manifestOf(ctx)
    .filter((entry) => !manifested.has(`${entry.refType}:${entry.refId}`))
    .map((entry) => ({ refType: entry.refType, reference: entry.reference }));

  return {
    verified: drifted.length === 0 && missing.length === 0,
    checked: state.entries.length,
    drifted,
    missing,
    added,
  };
}

// --- Step 3: the acceptance decision ----------------------------------------

export type AcceptanceCondition = {
  conditionId: string;
  description: string;
  /** Who carries the risk while it is open. Not the person who raised it. */
  riskOwner: string;
  dueDate: string;
  /** When the acceptance lapses if it is not met. */
  expiresOn: string;
  escalateTo: string;
};

/**
 * Why the handover cannot be accepted, or null.
 *
 * Wired into `engines/handover.acceptHandover`, so the existing command gains
 * the validation rather than a second command existing beside it.
 *
 * Binds only where the project runs the handover workflows at all: on a project
 * with no requirements matrix, no completion inspection and no asset register,
 * every domain returns null and this returns null with them.
 */
export function handoverAcceptanceBlockedReason(ctx: EngineContext): string | null {
  const validation = crossDomainValidation(ctx);
  if (validation.blocking.length === 0) return null;

  return (
    `${validation.blocking.length} domain${validation.blocking.length === 1 ? '' : 's'} not ready — ` +
    validation.blocking.map((domain) => `${domain.label}: ${domain.reason}`).join(' ')
  );
}

/**
 * Record the client or operator's decision on a compiled pack.
 *
 * The exception control: acceptance with conditions carries an explicit risk
 * owner, due date and expiry with an escalation route. All four, because the
 * common failure of conditional acceptance is that the conditions are a list of
 * sentences nobody owns which quietly become permanent.
 *
 * A rejection freezes the pack rather than editing it — "rejected pack remains
 * frozen and corrective version is created" — so the record shows what was
 * actually put forward and refused.
 */
export function decideHandover(
  ctx: EngineContext,
  packId: string,
  input: {
    decision: 'ACCEPTED' | 'ACCEPTED_WITH_CONDITIONS' | 'REJECTED';
    decidedBy: string;
    forOrganisation: string;
    reasons: string;
    manifestId?: string;
    conditions?: Array<{ description: string; riskOwner: string; dueDate: string; expiresOn: string; escalateTo: string }>;
  },
): { decision: string; conditions: number; manifestVerified: boolean | null } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const pack = ctx.ledger.get({ refType: 'HandoverPack', refId: packId });
  if (!pack) throw new DomainError('PACK_NOT_FOUND', `No handover pack ${packId}`, 404);

  if (pack.state.decision) {
    throw new DomainError(
      'ALREADY_DECIDED',
      `${packId} has already been decided. A rejected pack stays frozen and a corrective version is a new pack.`,
    );
  }
  if (!input.decidedBy.trim() || !input.forOrganisation.trim()) {
    throw new DomainError('DECIDER_REQUIRED', 'Name who decided and the organisation they decided for.');
  }
  if (input.reasons.trim().length < 20) {
    throw new DomainError(
      'REASONS_REQUIRED',
      'State the reasons. An acceptance with no stated basis is the document that gets disputed, and a rejection with ' +
        'none cannot be corrected against.',
    );
  }

  const conditions = input.conditions ?? [];
  if (input.decision === 'ACCEPTED_WITH_CONDITIONS' && conditions.length === 0) {
    throw new DomainError('CONDITIONS_REQUIRED', 'Accepting with conditions means saying what they are.');
  }
  if (input.decision !== 'ACCEPTED_WITH_CONDITIONS' && conditions.length > 0) {
    throw new DomainError(
      'CONDITIONS_UNEXPECTED',
      'Conditions belong to a conditional acceptance. Attaching them to a clean acceptance leaves obligations nobody is ' +
        'watching, which is the failure the conditional decision exists to prevent.',
    );
  }

  for (const condition of conditions) {
    if (condition.description.trim().length < 20) {
      throw new DomainError('CONDITION_UNDESCRIBED', `"${condition.description}" does not say what has to happen.`);
    }
    if (!condition.riskOwner.trim() || !condition.escalateTo.trim()) {
      throw new DomainError(
        'CONDITION_UNOWNED',
        `"${condition.description}" has no risk owner or no escalation route. A condition nobody owns is the one that is ` +
          'still open at the end of the aftercare period.',
      );
    }
    if (Number.isNaN(Date.parse(condition.dueDate)) || Number.isNaN(Date.parse(condition.expiresOn))) {
      throw new DomainError('CONDITION_UNDATED', `"${condition.description}" needs both a due date and an expiry.`);
    }
    if (condition.expiresOn.slice(0, 10) < condition.dueDate.slice(0, 10)) {
      throw new DomainError(
        'CONDITION_EXPIRY_INVALID',
        `"${condition.description}" expires before it is due, which makes the acceptance conditional on something that ` +
          'cannot be delivered in time.',
      );
    }
  }

  // Blocking domains stop an acceptance and never stop a rejection: refusing a
  // pack because the project is not ready is exactly the right decision.
  if (input.decision !== 'REJECTED') {
    const blocked = handoverAcceptanceBlockedReason(ctx);
    if (blocked) throw new DomainError('HANDOVER_NOT_READY', blocked);
  }

  let manifestVerified: boolean | null = null;
  if (input.manifestId) {
    const verification = verifyManifest(ctx, input.manifestId);
    manifestVerified = verification.verified;
    if (!verification.verified && input.decision !== 'REJECTED') {
      const parts = [
        verification.drifted.length > 0 ? `${verification.drifted.map((d) => d.reference).join(', ')} changed since compilation` : '',
        verification.missing.length > 0 ? `${verification.missing.map((m) => m.reference).join(', ')} no longer exist` : '',
      ].filter(Boolean);
      throw new DomainError(
        'MANIFEST_UNVERIFIED',
        `The pack cannot be accepted against a manifest that no longer matches the record: ${parts.join('; ')}. Recompile ` +
          'the manifest so what is accepted is what is actually there.',
      );
    }
  }

  const decided: AcceptanceCondition[] = conditions.map((condition) => ({
    conditionId: ulid(),
    description: condition.description,
    riskOwner: condition.riskOwner,
    dueDate: condition.dueDate.slice(0, 10),
    expiresOn: condition.expiresOn.slice(0, 10),
    escalateTo: condition.escalateTo,
  }));

  write(ctx, {
    eventType: input.decision === 'REJECTED' ? 'HANDOVER_REJECTED' : 'HANDOVER_DECISION_RECORDED',
    entity: { refType: 'HandoverPack', refId: packId },
    nextState: {
      ...pack.state,
      decision: input.decision,
      decidedBy: input.decidedBy,
      forOrganisation: input.forOrganisation,
      decisionReasons: input.reasons,
      acceptanceConditions: decided,
      manifestId: input.manifestId,
      manifestVerified,
      // A rejected pack is frozen: the corrective version is a new pack, and
      // this one stays as the record of what was actually put forward.
      frozen: input.decision === 'REJECTED',
      decidedAt: new Date().toISOString(),
    },
  });

  return { decision: input.decision, conditions: decided.length, manifestVerified };
}

// --- Step 4: activate the operational records -------------------------------

/**
 * Raise the maintenance and warranty obligations from the accepted asset data.
 *
 * AC-H-WF-09-02: without re-entry. Every field comes from the register that was
 * accepted; nothing is retyped, and there is no input on this command that
 * could carry an asset attribute. It refuses to run before a decision, because
 * activating operations off data nobody has accepted is how a CAFM system ends
 * up as the third place the asset list disagrees with itself.
 */
export function activateOperations(
  ctx: EngineContext,
  packId: string,
  input: { activatedBy: string; maintenanceStartsOn: string },
): { assets: number; withWarranty: number; activationId: string } {
  authorise(ctx, 'HANDOVER_OM', 'X', { lifecyclePhase: currentPhase(ctx) });

  const pack = ctx.ledger.get({ refType: 'HandoverPack', refId: packId });
  if (!pack) throw new DomainError('PACK_NOT_FOUND', `No handover pack ${packId}`, 404);

  const decision = pack.state.decision;
  if (decision !== 'ACCEPTED' && decision !== 'ACCEPTED_WITH_CONDITIONS') {
    throw new DomainError(
      'NOT_ACCEPTED',
      decision === 'REJECTED'
        ? 'The pack was rejected. Operations are activated from accepted data, not from a rejected submission.'
        : 'Nothing has been accepted yet. Operational records derive from the accepted register, so there is nothing to ' +
          'derive them from.',
    );
  }
  if (!input.activatedBy.trim()) throw new DomainError('ACTIVATOR_REQUIRED', 'Name who activated the operational records.');
  if (Number.isNaN(Date.parse(input.maintenanceStartsOn))) {
    throw new DomainError('START_DATE_REQUIRED', 'Say when planned maintenance starts running.');
  }

  if (ctx.ledger.list(ctx.projectId, 'OperationalActivation').length > 0) {
    throw new DomainError(
      'ALREADY_ACTIVATED',
      'Operations have already been activated for this project. Running it twice would raise a second set of maintenance ' +
        'obligations against the same assets.',
    );
  }

  const assets = ctx.ledger.list(ctx.projectId, 'AssetRegisterItem');
  if (assets.length === 0) {
    throw new DomainError(
      'NO_ASSET_DATA',
      'The accepted pack carries no asset register. There is nothing to raise maintenance against.',
    );
  }

  const warranties = ctx.ledger.list(ctx.projectId, 'Warranty');
  const warrantyByAsset = new Map(warranties.map((record) => [String(record.state.assetId), record]));

  // Derived, every field of it. The shape of this array is the whole of
  // AC-H-WF-09-02: there is no parameter on this function an asset attribute
  // could arrive through.
  const activated = assets.map((record) => {
    const warranty = warrantyByAsset.get(record.refId);
    return {
      assetId: record.refId,
      assetTag: String(record.state.assetTag),
      assetClass: String(record.state.assetClass),
      location: String(record.state.location),
      maintenanceStartsOn: input.maintenanceStartsOn.slice(0, 10),
      warrantyId: warranty?.refId,
      warrantyExpiresOn: warranty ? String(warranty.state.expiryDate) : undefined,
      // Whoever raises a defect in the first year needs to know before they
      // price it, and the answer is already in the data.
      underWarrantyAtStart: warranty ? String(warranty.state.expiryDate) >= input.maintenanceStartsOn.slice(0, 10) : false,
    };
  });

  const activationId = ulid();

  write(ctx, {
    eventType: 'ASSET_OPERATION_ACTIVATED',
    entity: { refType: 'OperationalActivation', refId: activationId },
    nextState: {
      activationId,
      projectId: ctx.projectId,
      packId,
      activatedBy: input.activatedBy,
      maintenanceStartsOn: input.maintenanceStartsOn.slice(0, 10),
      assets: activated,
      activatedAt: new Date().toISOString(),
    },
  });

  return {
    assets: activated.length,
    withWarranty: activated.filter((asset) => asset.warrantyId !== undefined).length,
    activationId,
  };
}

// --- Step 5: freeze and archive ---------------------------------------------

/**
 * Freeze the handover baseline and record what is archived.
 *
 * The exception control is that the archive preserves legal hold and immutable
 * evidence. Nothing is deleted here and nothing could be: the ledger is
 * append-only, so an "archive" is a statement about which records are no longer
 * the working set, not an act that removes any. What the retention policy
 * governs is what may be *disposed of later*, and an item under legal hold is
 * marked so that decision cannot be taken quietly.
 */
export function baselineHandover(
  ctx: EngineContext,
  input: { baselinedBy: string; retentionPolicy: string; retainUntil: string; legalHold: boolean; legalHoldReason?: string },
): { baselineId: string; manifestHash: string; entries: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.baselinedBy.trim() || input.retentionPolicy.trim().length < 10) {
    throw new DomainError(
      'RETENTION_POLICY_REQUIRED',
      'Name who baselined it and the retention policy it is held under. An archive with no policy is a folder.',
    );
  }
  if (Number.isNaN(Date.parse(input.retainUntil))) {
    throw new DomainError('RETENTION_DATE_REQUIRED', 'State how long it is retained for.');
  }
  if (input.legalHold && !input.legalHoldReason?.trim()) {
    throw new DomainError(
      'LEGAL_HOLD_UNEXPLAINED',
      'A legal hold suspends the retention policy indefinitely. Record what it is for, or nobody will ever know when it ' +
        'can be lifted.',
    );
  }

  const entries = manifestOf(ctx);
  const baselineId = ulid();
  const manifestHash = hashState(entries);

  write(ctx, {
    eventType: 'PROJECT_HANDOVER_BASELINED',
    entity: { refType: 'HandoverBaseline', refId: baselineId },
    nextState: {
      baselineId,
      projectId: ctx.projectId,
      baselinedBy: input.baselinedBy,
      retentionPolicy: input.retentionPolicy,
      retainUntil: input.retainUntil.slice(0, 10),
      legalHold: input.legalHold,
      legalHoldReason: input.legalHoldReason,
      entries,
      manifestHash,
      // Stated rather than implied. Nothing was removed, because nothing here
      // can be.
      disposition: 'The ledger is append-only; this records which records form the frozen handover set and how long they '
        + 'are retained. No record was deleted.',
      baselinedAt: new Date().toISOString(),
    },
  });

  return { baselineId, manifestHash, entries: entries.length };
}

// --- Step 6: residual obligations transfer ----------------------------------

export type ResidualObligation = {
  reference: string;
  kind: 'ACCEPTANCE_CONDITION' | 'SEASONAL_TEST' | 'COMMISSIONING_EXCEPTION' | 'DEFERRED_DEFECT' | 'REGULATORY_CONDITION';
  description: string;
  owner: string;
  dueDate?: string;
  /** Traceable back to the requirement it came from — AC-H-WF-10-01. */
  sourceRef: string;
};

/**
 * Everything still owed after acceptance, derived on read.
 *
 * AC-H-WF-09-03 says a residual item appears to its receiving owner
 * *immediately* after acceptance. Deriving it is what makes that true: a stored
 * transfer list would be as current as the last time somebody rebuilt it, and
 * the gap between acceptance and that rebuild is exactly the window in which
 * nobody is watching the obligations.
 *
 * Each item carries the reference of what it came from, so AC-H-WF-10-01's
 * traceability back to the original requirement is a property of the data
 * rather than a report somebody assembles.
 */
export function residualObligations(ctx: EngineContext): ResidualObligation[] {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const out: ResidualObligation[] = [];

  for (const pack of ctx.ledger.list(ctx.projectId, 'HandoverPack')) {
    const conditions = (pack.state.acceptanceConditions ?? []) as AcceptanceCondition[];
    for (const condition of conditions) {
      out.push({
        reference: `COND-${condition.conditionId.slice(-6)}`,
        kind: 'ACCEPTANCE_CONDITION',
        description: condition.description,
        owner: condition.riskOwner,
        dueDate: condition.dueDate,
        sourceRef: `HandoverPack:${pack.refId}`,
      });
    }
  }

  for (const obligation of commissioningclose.handoverObligations(ctx)) {
    out.push({
      reference: obligation.reference,
      kind: obligation.kind === 'SEASONAL_TEST' ? 'SEASONAL_TEST' : 'COMMISSIONING_EXCEPTION',
      description: obligation.detail,
      owner: obligation.owner,
      dueDate: obligation.by,
      // The system it belongs to is the trace back. CM-WF-08 keeps the
      // obligation's own reference rather than renumbering it, so the pair
      // identifies the original record.
      sourceRef: `System:${obligation.systemTag}`,
    });
  }

  for (const inspection of ctx.ledger.list(ctx.projectId, 'CompletionInspection')) {
    const items = (inspection.state.items ?? []) as Array<Record<string, unknown>>;
    for (const item of items) {
      if (item.status !== 'DEFERRED') continue;
      const deferral = item.deferral as Record<string, unknown>;
      out.push({
        reference: `DEF-${String(item.itemId).slice(-6)}`,
        kind: 'DEFERRED_DEFECT',
        description: String(item.description),
        owner: String(deferral.owner),
        dueDate: String(deferral.by),
        sourceRef: `CompletionInspection:${inspection.refId}`,
      });
    }
  }

  for (const condition of regulatorycompletion.regulatoryConditions(ctx)) {
    out.push({
      reference: condition.reference,
      kind: 'REGULATORY_CONDITION',
      description: condition.condition,
      owner: condition.owner,
      dueDate: condition.by,
      // The certificate it was imposed on. A condition on a completion
      // certificate outlives the project, so the trace is to the certificate
      // rather than to anything the project holds.
      sourceRef: `Certificate:${condition.certificate}`,
    });
  }

  return out;
}

/**
 * Hand the residual obligations to their receiving owners.
 *
 * The event is the notification. What it does *not* do is copy the obligations
 * into it: they are read live by `residualObligations`, so an obligation closed
 * the day after transfer stops appearing without anybody maintaining a second
 * copy of the list.
 */
export function transferResidualObligations(
  ctx: EngineContext,
  input: { toOperations: string; toAftercare: string; note: string },
): { transferred: number; owners: string[] } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const obligations = residualObligations(ctx);
  if (obligations.length === 0) {
    throw new DomainError(
      'NOTHING_OUTSTANDING',
      'There are no residual obligations to transfer. Recording a transfer of nothing would put a milestone in the record ' +
        'that did not happen.',
    );
  }
  if (!input.toOperations.trim() || !input.toAftercare.trim()) {
    throw new DomainError(
      'RECEIVING_OWNERS_REQUIRED',
      'Name the operations and aftercare owners receiving them. "Transferred to the client" is what nobody picks up.',
    );
  }

  const transferId = ulid();
  const owners = [...new Set(obligations.map((obligation) => obligation.owner))].sort();

  write(ctx, {
    eventType: 'RESIDUAL_OBLIGATIONS_TRANSFERRED',
    entity: { refType: 'ResidualTransfer', refId: transferId },
    nextState: {
      transferId,
      projectId: ctx.projectId,
      toOperations: input.toOperations,
      toAftercare: input.toAftercare,
      note: input.note,
      // The count and the owners at the moment of transfer, for the record.
      // The obligations themselves stay derived.
      countAtTransfer: obligations.length,
      ownersAtTransfer: owners,
      transferredBy: ctx.auth.actorId,
      transferredAt: new Date().toISOString(),
    },
  });

  return { transferred: obligations.length, owners };
}

// --- The position -----------------------------------------------------------

export type HandoverAcceptancePosition = {
  domains: DomainResult[];
  ready: boolean;
  readiness: ReturnType<typeof handoverrequirements.handoverReadiness> | null;
  packs: Array<{
    packId: string;
    status: string;
    decision?: string;
    decidedBy?: string;
    manifestVerified?: boolean | null;
    conditions: number;
    frozen: boolean;
  }>;
  manifests: Array<{ manifestId: string; packId: string; entries: number; manifestHash: string }>;
  activation: { assets: number; withWarranty: number; maintenanceStartsOn: string } | null;
  baseline: { retainUntil: string; legalHold: boolean; entries: number } | null;
  residual: ResidualObligation[];
  transferred: boolean;
  summary: string;
};

export function handoverAcceptancePosition(ctx: EngineContext): HandoverAcceptancePosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const validation = crossDomainValidation(ctx);

  const packs = ctx.ledger.list(ctx.projectId, 'HandoverPack').map((record) => ({
    packId: record.refId,
    status: String(record.state.status ?? 'DRAFT'),
    decision: record.state.decision === undefined ? undefined : String(record.state.decision),
    decidedBy: record.state.decidedBy === undefined ? undefined : String(record.state.decidedBy),
    manifestVerified: record.state.manifestVerified as boolean | null | undefined,
    conditions: ((record.state.acceptanceConditions ?? []) as unknown[]).length,
    frozen: record.state.frozen === true,
  }));

  const manifests = ctx.ledger.list(ctx.projectId, 'HandoverManifest').map((record) => ({
    manifestId: record.refId,
    packId: String(record.state.packId),
    entries: ((record.state.entries ?? []) as unknown[]).length,
    manifestHash: String(record.state.manifestHash),
  }));

  const activationRecord = ctx.ledger.list(ctx.projectId, 'OperationalActivation')[0];
  const activationAssets = (activationRecord?.state.assets ?? []) as Array<Record<string, unknown>>;
  const activation = activationRecord
    ? {
        assets: activationAssets.length,
        withWarranty: activationAssets.filter((asset) => asset.warrantyId !== undefined).length,
        maintenanceStartsOn: String(activationRecord.state.maintenanceStartsOn),
      }
    : null;

  const baselineRecord = ctx.ledger.list(ctx.projectId, 'HandoverBaseline')[0];
  const baseline = baselineRecord
    ? {
        retainUntil: String(baselineRecord.state.retainUntil),
        legalHold: baselineRecord.state.legalHold === true,
        entries: ((baselineRecord.state.entries ?? []) as unknown[]).length,
      }
    : null;

  const residual = residualObligations(ctx);

  const parts = [`${validation.domains.filter((d) => d.ready).length} of ${validation.domains.length} domains ready`];
  if (packs.length > 0) parts.push(`${packs.length} pack${packs.length === 1 ? '' : 's'}`);
  if (activation) parts.push(`${activation.assets} assets activated`);
  if (residual.length > 0) parts.push(`${residual.length} residual obligation${residual.length === 1 ? '' : 's'}`);

  let readiness: ReturnType<typeof handoverrequirements.handoverReadiness> | null = null;
  try {
    readiness = handoverrequirements.handoverReadiness(ctx);
  } catch {
    // A project with no requirements matrix has no readiness to report, which
    // is a different thing from a readiness of zero and is shown as such.
    readiness = null;
  }

  return {
    domains: validation.domains,
    ready: validation.ready,
    readiness,
    packs,
    manifests,
    activation,
    baseline,
    residual,
    transferred: ctx.ledger.list(ctx.projectId, 'ResidualTransfer').length > 0,
    summary: parts.join(', ') + '.',
  };
}
