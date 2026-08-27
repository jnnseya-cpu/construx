import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * H-WF-02 — as-built drawing, model and specification verification.
 *
 * `engines/bim.ts` already generates an as-built model by reconciling design
 * intent against captured site reality, and that stays exactly as it is: it is
 * the *drafting* side, and it is allowed to be an AI act. What it cannot do —
 * and the specification says so plainly — is certify that the as-built is
 * accurate. This module is the verification layer that sits on top, and its
 * whole purpose is that **as-built status comes from a person, not a filename**.
 *
 * **AC-H-WF-02-01: status is verification, not naming.** A set called
 * "AS-BUILT-FINAL-rev-C" is a set somebody named. A set that is *as-built* is
 * one an authorised professional has verified against the approved design and
 * the changes implemented since, with their name and registration on it. Until
 * that happens the set is submitted, and submitted is not as-built.
 *
 * **AC-H-WF-02-02: every implemented change reflected, or explicitly not.** The
 * commonest defect in an as-built package is not a wrong line — it is a change
 * that was approved, built, and never drawn. Each implemented change is answered
 * one way or the other, and "not applicable" needs a reason: it is a claim about
 * the change, and a claim with no reasoning is how one gets lost.
 *
 * **AC-H-WF-02-03: the asset and the drawing open from each other.** A
 * maintenance engineer at two in the morning has an asset tag on a plate and
 * needs the drawing; a designer has a drawing and needs to know what is on it.
 * One link record answers both directions, so neither can be true while the
 * other is false.
 *
 * **A material variance blocks the handover it affects.** The exception control,
 * and it is exported rather than merely reported so H-WF-01's readiness reads
 * the same answer: a system whose as-built disagrees with what is installed
 * cannot be handed over on the strength of a document that is wrong about it.
 *
 * **Conversion loss is reported, not silently accepted.** A model exported to
 * IFC loses things. The native file stays related to the export, and what was
 * lost is recorded — an IFC alone, with no native behind it and no note of what
 * dropped out, is an as-built nobody can go back to.
 */

export const DELIVERABLE_FORMAT = ['NATIVE', 'IFC', 'PDF'] as const;
export type DeliverableFormat = (typeof DELIVERABLE_FORMAT)[number];

export type AsBuiltDeliverable = {
  format: DeliverableFormat;
  reference: string;
  fileHash: string;
  /** For a converted format, what the conversion dropped. */
  conversionNotes?: string;
};

export type ChangeReflection = {
  changeRef: string;
  reflected: 'REFLECTED' | 'NOT_APPLICABLE';
  /** Where it is shown, or why it does not apply. */
  note: string;
};

export type AsBuiltVariance = {
  reference: string;
  description: string;
  /** Whether it stops the affected system being handed over. */
  material: boolean;
  location: string;
  raisedBy: string;
  raisedAt: string;
  resolution?: { resolution: string; resolvedBy: string; resolvedAt: string };
};

export type AsBuiltSetState = {
  setId: string;
  reference: string;
  revision: number;
  systemTag: string;
  discipline: string;
  approvedDesignRefs: Array<{ reference: string; revision: string }>;
  implementedChanges: ChangeReflection[];
  deliverables: AsBuiltDeliverable[];
  metadata: { coordinateSystem: string; units: string; taggedObjects: number; totalObjects: number };
  variances: AsBuiltVariance[];
  status: 'SUBMITTED' | 'VERIFIED' | 'PUBLISHED' | 'SUPERSEDED';
  verification?: { verifiedBy: string; discipline: string; registration: string; statement: string; verifiedAt: string };
  publication?: { publishedBy: string; supersedes: string[]; publishedAt: string };
};

function sets(ctx: EngineContext): AsBuiltSetState[] {
  return ctx.ledger.list(ctx.projectId, 'AsBuiltSet').map((record) => record.state as unknown as AsBuiltSetState);
}

function requireSet(ctx: EngineContext, setId: string) {
  const record = ctx.ledger.get({ refType: 'AsBuiltSet', refId: setId });
  if (!record) throw new DomainError('SET_NOT_FOUND', `No as-built set ${setId}`, 404);
  return record;
}

/** Submit an as-built set against the approved design and the changes implemented since. */
export function submitAsBuiltSet(
  ctx: EngineContext,
  input: {
    reference: string;
    systemTag: string;
    discipline: string;
    approvedDesignRefs: Array<{ reference: string; revision: string }>;
    implementedChanges: ChangeReflection[];
    deliverables: AsBuiltDeliverable[];
    metadata: { coordinateSystem: string; units: string; taggedObjects: number; totalObjects: number };
    submittedBy: string;
  },
): { setId: string; revision: number; taggedPercent: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.discipline.trim()) {
    throw new DomainError('SET_UNIDENTIFIED', 'An as-built set names its reference and its discipline.');
  }
  if (!input.submittedBy.trim()) throw new DomainError('SUBMISSION_UNSIGNED', 'Name who submitted it.');

  if (input.approvedDesignRefs.length === 0) {
    throw new DomainError(
      'APPROVED_DESIGN_REQUIRED',
      'Name the approved design this is the as-built of, at the revision approved. An as-built set with nothing behind it ' +
        'cannot be checked against anything, and checking it against something is the entire exercise.',
    );
  }
  if (input.approvedDesignRefs.some((entry) => !entry.reference.trim() || !entry.revision.trim())) {
    throw new DomainError('APPROVED_DESIGN_REQUIRED', 'Every approved document names its reference and its revision.');
  }

  // AC-H-WF-02-02. The commonest defect in an as-built package is not a wrong
  // line — it is a change that was approved, built, and never drawn.
  const unanswered = input.implementedChanges.find((change) => !change.note.trim());
  if (unanswered) {
    throw new DomainError(
      'CHANGE_UNANSWERED',
      `${unanswered.changeRef} is recorded as ${unanswered.reflected.toLowerCase().replace('_', ' ')} with nothing said ` +
        'about it. Say where it is shown, or why it does not apply — "not applicable" is a claim about the change, and one ' +
        'with no reasoning behind it is how a change gets lost.',
    );
  }

  if (input.deliverables.length === 0) {
    throw new DomainError('NO_DELIVERABLES', 'A set with no files in it delivers nothing.');
  }
  if (input.deliverables.some((deliverable) => !deliverable.reference.trim() || !deliverable.fileHash.trim())) {
    throw new DomainError('DELIVERABLE_UNIDENTIFIED', 'Every deliverable names its reference and carries its hash.');
  }
  // The exception control: the native/IFC relationship is retained.
  const converted = input.deliverables.filter((deliverable) => deliverable.format !== 'NATIVE');
  if (converted.length > 0 && !input.deliverables.some((deliverable) => deliverable.format === 'NATIVE')) {
    throw new DomainError(
      'NATIVE_REQUIRED',
      'A converted deliverable is supplied with no native file behind it. An IFC or a PDF alone is an as-built nobody can ' +
        'go back to when the export turns out to have dropped something.',
    );
  }
  const unreported = converted.find((deliverable) => !deliverable.conversionNotes?.trim());
  if (unreported) {
    throw new DomainError(
      'CONVERSION_LOSS_UNREPORTED',
      `The ${unreported.format} deliverable says nothing about what the conversion lost. Every export drops something, and ` +
        'a conversion with no note is one where nobody looked.',
    );
  }

  if (!input.metadata.coordinateSystem.trim() || !input.metadata.units.trim()) {
    throw new DomainError(
      'METADATA_REQUIRED',
      'State the coordinate system and the units. A model delivered without them is one that will be inserted at the wrong ' +
        'origin by whoever opens it next.',
    );
  }
  if (input.metadata.totalObjects <= 0) {
    throw new DomainError('METADATA_REQUIRED', 'An as-built set with no objects in it describes nothing.');
  }

  const existing = sets(ctx).filter((entry) => entry.reference === input.reference);
  const revision = existing.length + 1;
  const setId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'AS_BUILT_SUBMISSION',
    hash: input.deliverables[0]!.fileHash,
    description: `${input.reference} revision ${revision} — ${input.discipline} as-built for ${input.systemTag}`,
    linkedEntities: [{ refType: 'Project', refId: ctx.projectId }],
  });

  write(ctx, {
    eventType: 'AS_BUILT_SUBMITTED',
    entity: { refType: 'AsBuiltSet', refId: setId },
    nextState: {
      setId,
      projectId: ctx.projectId,
      reference: input.reference,
      revision,
      systemTag: input.systemTag,
      discipline: input.discipline,
      approvedDesignRefs: input.approvedDesignRefs,
      implementedChanges: input.implementedChanges,
      deliverables: input.deliverables,
      metadata: input.metadata,
      variances: [],
      status: 'SUBMITTED',
      submittedBy: input.submittedBy,
      submittedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  return {
    setId,
    revision,
    taggedPercent: Math.round((input.metadata.taggedObjects / input.metadata.totalObjects) * 100),
  };
}

/** Record a variance between the as-built information and what is installed. */
export function recordVariance(
  ctx: EngineContext,
  setId: string,
  input: { reference: string; description: string; material: boolean; location: string; raisedBy: string },
): { reference: string; material: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSet(ctx, setId);
  const state = record.state as unknown as AsBuiltSetState;

  // Twenty characters, and it is a floor rather than a judgement of clarity: no
  // rule can tell a real description from a plausible one. What it stops is the
  // one-word entry — "discrepancy", "as noted" — which is common and useless.
  if (input.description.trim().length < 20 || !input.location.trim()) {
    throw new DomainError(
      'VARIANCE_UNDESCRIBED',
      'Say what differs and where. A variance recorded as "discrepancy" is one nobody else can find.',
    );
  }
  if (!input.raisedBy.trim()) throw new DomainError('VARIANCE_UNSIGNED', 'Name who found it.');
  if (state.variances.some((variance) => variance.reference === input.reference)) {
    throw new DomainError('VARIANCE_TAKEN', `${input.reference} is already recorded against this set.`);
  }

  write(ctx, {
    eventType: 'AS_BUILT_VARIANCE_IDENTIFIED',
    entity: { refType: 'AsBuiltSet', refId: setId },
    nextState: {
      ...record.state,
      variances: [
        ...state.variances,
        { ...input, raisedAt: new Date().toISOString() },
      ],
    },
  });

  return { reference: input.reference, material: input.material };
}

/** Resolve a variance, saying what was done about it. */
export function resolveVariance(
  ctx: EngineContext,
  setId: string,
  input: { reference: string; resolution: string; resolvedBy: string },
): { reference: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSet(ctx, setId);
  const state = record.state as unknown as AsBuiltSetState;
  const variance = state.variances.find((entry) => entry.reference === input.reference);
  if (!variance) throw new DomainError('VARIANCE_NOT_FOUND', `No variance ${input.reference} on this set.`, 404);
  if (variance.resolution) throw new DomainError('VARIANCE_RESOLVED', `${input.reference} is already resolved.`);

  if (input.resolution.trim().length < 10 || !input.resolvedBy.trim()) {
    throw new DomainError(
      'RESOLUTION_REQUIRED',
      'Say what was done — the drawing corrected, the installation changed, or the difference accepted and why.',
    );
  }

  write(ctx, {
    eventType: 'AS_BUILT_VARIANCE_RESOLVED',
    entity: { refType: 'AsBuiltSet', refId: setId },
    nextState: {
      ...record.state,
      variances: state.variances.map((entry) =>
        entry.reference === input.reference
          ? {
              ...entry,
              resolution: {
                resolution: input.resolution,
                resolvedBy: input.resolvedBy,
                resolvedAt: new Date().toISOString(),
              },
            }
          : entry,
      ),
    },
  });

  return { reference: input.reference };
}

/**
 * Verify the set.
 *
 * AC-H-WF-02-01. This is the act that makes a set as-built, and it is signed by
 * a named professional with their registration on it. An agent may compare
 * revisions and find missing tags all day; it cannot do this.
 */
export function verifyAsBuiltSet(
  ctx: EngineContext,
  setId: string,
  input: { verifiedBy: string; discipline: string; registration: string; statement: string },
): { status: string; unresolvedVariances: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSet(ctx, setId);
  const state = record.state as unknown as AsBuiltSetState;

  if (state.status !== 'SUBMITTED') {
    throw new DomainError('NOT_SUBMITTED', `${state.reference} is ${state.status.toLowerCase()}, not awaiting verification.`);
  }
  if (!input.verifiedBy.trim() || !input.registration.trim()) {
    throw new DomainError(
      'VERIFICATION_UNSIGNED',
      'Name the professional verifying it and the registration they hold. As-built status comes from a person, not a ' +
        'filename, and the person is the part that has to be identifiable.',
    );
  }
  if (input.statement.trim().length < 20) {
    throw new DomainError(
      'STATEMENT_REQUIRED',
      'State what was verified and against what. "Checked" is a word, not a verification.',
    );
  }

  const material = state.variances.filter((variance) => variance.material && !variance.resolution);
  if (material.length > 0) {
    throw new DomainError(
      'MATERIAL_VARIANCE_OPEN',
      `${material.map((variance) => variance.reference).join(', ')} ${material.length === 1 ? 'is' : 'are'} a material ` +
        'variance nobody has resolved. Verifying the set now certifies information that is known to disagree with what is ' +
        'installed.',
    );
  }

  write(ctx, {
    eventType: 'AS_BUILT_VERIFIED',
    entity: { refType: 'AsBuiltSet', refId: setId },
    nextState: {
      ...record.state,
      status: 'VERIFIED',
      verification: {
        verifiedBy: input.verifiedBy,
        discipline: input.discipline,
        registration: input.registration,
        statement: input.statement,
        verifiedAt: new Date().toISOString(),
      },
    },
  });

  return { status: 'VERIFIED', unresolvedVariances: state.variances.filter((variance) => !variance.resolution).length };
}

/** Publish the verified set, superseding the construction information for operational use. */
export function publishAsBuiltSet(
  ctx: EngineContext,
  setId: string,
  input: { publishedBy: string; supersedes: string[] },
): { supersededSets: string[] } {
  authorise(ctx, 'DESIGN_INFORMATION', 'I', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSet(ctx, setId);
  const state = record.state as unknown as AsBuiltSetState;

  if (state.status !== 'VERIFIED') {
    throw new DomainError(
      'NOT_VERIFIED',
      `${state.reference} has not been verified. Publishing it for operational use would put unverified information in ` +
        'front of the people who maintain the building.',
    );
  }
  if (!input.publishedBy.trim()) throw new DomainError('PUBLICATION_UNSIGNED', 'Name who published it.');

  const publishedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'AS_BUILT_PUBLISHED',
    entity: { refType: 'AsBuiltSet', refId: setId },
    nextState: {
      ...record.state,
      status: 'PUBLISHED',
      publication: { publishedBy: input.publishedBy, supersedes: input.supersedes, publishedAt },
    },
  });

  // Earlier published revisions of the same reference stop being current. An
  // operator with two current as-builts has none.
  const superseded: string[] = [];
  for (const earlier of sets(ctx)) {
    if (earlier.setId === setId) continue;
    if (earlier.reference !== state.reference) continue;
    if (earlier.status !== 'PUBLISHED') continue;
    const earlierRecord = requireSet(ctx, earlier.setId);
    write(ctx, {
      eventType: 'AS_BUILT_SUPERSEDED',
      entity: { refType: 'AsBuiltSet', refId: earlier.setId },
      nextState: { ...earlierRecord.state, status: 'SUPERSEDED', supersededBy: state.reference, supersededAt: publishedAt },
    });
    superseded.push(`${earlier.reference} rev ${earlier.revision}`);
  }

  return { supersededSets: superseded };
}

// --- Asset information links ------------------------------------------------

/**
 * Link a maintainable asset to where it is shown.
 *
 * AC-H-WF-02-03, as one record rather than two. A maintenance engineer at two in
 * the morning has a tag on a plate and needs the drawing; a designer has a
 * drawing and needs to know what is on it. One link answers both, so neither
 * direction can be true while the other is false.
 */
export function linkAssetInformation(
  ctx: EngineContext,
  input: { assetTag: string; setId: string; drawingReference: string; modelElementId?: string; location: string },
): { assetTag: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSet(ctx, input.setId);
  const state = record.state as unknown as AsBuiltSetState;

  if (!input.assetTag.trim() || !input.drawingReference.trim() || !input.location.trim()) {
    throw new DomainError(
      'LINK_INCOMPLETE',
      'A link names the asset tag, the drawing or model it appears on, and where on it. Two of the three is a link that ' +
        'only works in one direction.',
    );
  }
  if (
    ctx.ledger
      .list(ctx.projectId, 'AssetInformationLink')
      .some((entry) => entry.state.assetTag === input.assetTag && entry.state.setId === input.setId)
  ) {
    throw new DomainError('LINK_EXISTS', `${input.assetTag} is already linked to ${state.reference}.`);
  }

  const linkId = ulid();

  write(ctx, {
    eventType: 'ASSET_INFORMATION_LINKED',
    entity: { refType: 'AssetInformationLink', refId: linkId },
    nextState: {
      linkId,
      projectId: ctx.projectId,
      assetTag: input.assetTag,
      setId: input.setId,
      setReference: state.reference,
      drawingReference: input.drawingReference,
      modelElementId: input.modelElementId,
      location: input.location,
      linkedAt: new Date().toISOString(),
    },
  });

  return { assetTag: input.assetTag };
}

/** What information shows this asset. The two-in-the-morning direction. */
export function informationForAsset(
  ctx: EngineContext,
  assetTag: string,
): Array<{ setReference: string; drawingReference: string; modelElementId?: string; location: string; status: string }> {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const byId = new Map(sets(ctx).map((state) => [state.setId, state]));
  return ctx.ledger
    .list(ctx.projectId, 'AssetInformationLink')
    .filter((record) => record.state.assetTag === assetTag)
    .map((record) => ({
      setReference: String(record.state.setReference),
      drawingReference: String(record.state.drawingReference),
      modelElementId: record.state.modelElementId as string | undefined,
      location: String(record.state.location),
      status: byId.get(String(record.state.setId))?.status ?? 'UNKNOWN',
    }));
}

/** What assets appear on this drawing. The other direction, from the same record. */
export function assetsOnDrawing(
  ctx: EngineContext,
  drawingReference: string,
): Array<{ assetTag: string; location: string; setReference: string }> {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  return ctx.ledger
    .list(ctx.projectId, 'AssetInformationLink')
    .filter((record) => record.state.drawingReference === drawingReference)
    .map((record) => ({
      assetTag: String(record.state.assetTag),
      location: String(record.state.location),
      setReference: String(record.state.setReference),
    }));
}

/**
 * Why this system's handover is blocked by its as-built information, or null.
 *
 * The exception control, exported so H-WF-01's readiness reads the same answer
 * rather than keeping its own. Binds only where the project submits as-built
 * sets at all.
 */
export function asBuiltBlockedReason(ctx: EngineContext, systemTag: string): string | null {
  const all = sets(ctx);
  if (all.length === 0) return null;

  const mine = all.filter((state) => state.systemTag === systemTag && state.status !== 'SUPERSEDED');
  if (mine.length === 0) {
    return `No as-built information has been submitted for ${systemTag}.`;
  }

  const material = mine.flatMap((state) =>
    state.variances
      .filter((variance) => variance.material && !variance.resolution)
      .map((variance) => `${state.reference}: ${variance.reference} — ${variance.description}`),
  );
  if (material.length > 0) {
    return (
      `${material.join('; ')}. A system whose as-built is known to disagree with what is installed cannot be handed over ` +
      'on the strength of a document that is wrong about it.'
    );
  }

  if (!mine.some((state) => state.status === 'PUBLISHED')) {
    const latest = mine[mine.length - 1]!;
    return `${latest.reference} is ${latest.status.toLowerCase()} and has not been published for operational use.`;
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type AsBuiltPosition = {
  sets: Array<{
    setId: string;
    reference: string;
    revision: number;
    systemTag: string;
    discipline: string;
    status: string;
    verifiedBy?: string;
    taggedPercent: number;
    openVariances: number;
    materialVariances: number;
    changesNotApplicable: number;
  }>;
  /** Material variances nobody has resolved, which block the systems they touch. */
  blocking: Array<{ systemTag: string; setReference: string; variance: string; description: string }>;
  links: number;
  summary: string;
};

export function asBuiltPosition(ctx: EngineContext): AsBuiltPosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const all = sets(ctx);
  const blocking: AsBuiltPosition['blocking'] = [];

  const rows = all.map((state) => {
    for (const variance of state.variances) {
      if (variance.material && !variance.resolution && state.status !== 'SUPERSEDED') {
        blocking.push({
          systemTag: state.systemTag,
          setReference: state.reference,
          variance: variance.reference,
          description: variance.description,
        });
      }
    }
    return {
      setId: state.setId,
      reference: state.reference,
      revision: state.revision,
      systemTag: state.systemTag,
      discipline: state.discipline,
      status: state.status,
      verifiedBy: state.verification?.verifiedBy,
      taggedPercent:
        state.metadata.totalObjects === 0
          ? 0
          : Math.round((state.metadata.taggedObjects / state.metadata.totalObjects) * 100),
      openVariances: state.variances.filter((variance) => !variance.resolution).length,
      materialVariances: state.variances.filter((variance) => variance.material && !variance.resolution).length,
      changesNotApplicable: state.implementedChanges.filter((change) => change.reflected === 'NOT_APPLICABLE').length,
    };
  });

  const published = rows.filter((row) => row.status === 'PUBLISHED').length;
  const parts = [`${rows.length} as-built set${rows.length === 1 ? '' : 's'}`, `${published} published`];
  if (blocking.length > 0) parts.push(`${blocking.length} material variance blocking a handover`);

  return {
    sets: rows,
    blocking,
    links: ctx.ledger.list(ctx.projectId, 'AssetInformationLink').length,
    summary: parts.join(', ') + '.',
  };
}
