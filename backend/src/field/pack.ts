import { canonicalize } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { signFor, verifyFor } from '../identity/secrets.ts';
import { FIELD_MODULES, moduleBySlug, type FieldModule } from './modules.ts';

/**
 * The offline pack: a bounded, verified working set a device may carry.
 *
 * §14.6 gives the lifecycle — estimate, authorise scope, build a signed
 * manifest, download it, then the priority entities, then the files, verify,
 * and activate atomically. Everything a field module does depends on it,
 * because a device with no pack has nothing to work from and a device with an
 * unbounded pack is a device that has copied the estate.
 *
 * ---
 *
 * ## What the signature is for, and what it is not
 *
 * This is the part that would be easy to describe dishonestly.
 *
 * The manifest is signed with `signFor`, which is an HMAC. **A device cannot
 * verify an HMAC** — verifying it needs the key, and a key on every handset is
 * not a key. So the signature is emphatically *not* "the device checks the pack
 * came from the platform"; TLS is what does that, and it does it already.
 *
 * What the signature actually buys is the other direction: a manifest handed
 * *back* to the platform — on a receipt, or in support of a later claim — can
 * be proven to be one the platform issued, unaltered. Without it a device could
 * present a manifest of its own invention and assert an authorised scope it was
 * never granted. That is a real attack and this closes it.
 *
 * **The device's verification is the hashes, and it needs no key for that.**
 * Every entity in the manifest carries its `stateHash` and every file its
 * content hash, so a device can prove that what it downloaded is what it was
 * promised. That is the "verify" in the lifecycle, and it is the step that has
 * to pass before activation.
 *
 * ## What the server can and cannot witness
 *
 * The server issues, signs and revokes. It cannot see a device activate a pack
 * atomically, or purge one, or hold anything back — those happen on a handset
 * with no signal. The receipt is therefore recorded as **what the device
 * reported**, named that way rather than as a fact the platform established.
 * Two rules the server *can* enforce, and does:
 *
 *   1. **Issuing a pack never invalidates the one before it.** §14.6 requires
 *      that a new pack must not destroy the last valid pack before the new one
 *      verifies. The superseded pack stays live until the new one's receipt
 *      lands, so a device whose download fails halfway still has a working set.
 *   2. **A revoked pack is refused for ever.** Revocation is not a state a
 *      receipt can argue with.
 *
 * The rule that a purge must never remove unsynced or referenced evidence is a
 * device-side rule and is stated here as one; nothing in this module can
 * enforce it.
 *
 * ## Expiry is per class, not per pack
 *
 * §14.6: "a drawing derivative, permit status, identity appointment and weather
 * reference may have different freshness rules". A single pack expiry would
 * take the loosest of those and call a fortnight-old permit current. So each
 * class carries its own freshness and the pack's own expiry is the *earliest*
 * of the classes it contains — the pack is stale as soon as any part of it is.
 */

/**
 * Content classes, each with the freshness its domain actually has.
 *
 * These hours are not round numbers chosen for tidiness. A permit governs
 * whether work may proceed at all and a stale one is a safety failure, so it is
 * the shortest. Criteria and drawings change under revision control and a
 * device is told about supersession through sync, so they run longer. The
 * ceiling on the whole pack is §16.5's fourteen days, which no class exceeds.
 */
export const PACK_CLASS = {
  PERMITS: {
    id: 'PERMITS',
    label: 'Permits and authorisations',
    freshnessHours: 12,
    why: 'A permit decides whether work may start. A stale one is a safety failure, not an inconvenience.',
    entities: ['Permit', 'StartWorkAuthorisation'],
  },
  SAFETY: {
    id: 'SAFETY',
    label: 'Method statements and briefings',
    freshnessHours: 24,
    why: 'A superseded RAMS must not brief a crew for a second shift.',
    entities: ['RAMS', 'ToolboxTalk', 'Induction'],
  },
  CRITERIA: {
    id: 'CRITERIA',
    label: 'Inspection and test criteria',
    freshnessHours: 72,
    why: 'Criteria change under revision control, and a device is told of supersession on sync.',
    entities: ['InspectionPlan', 'TestPack', 'TestPackRequirement', 'CommissioningPlan'],
  },
  INFORMATION: {
    id: 'INFORMATION',
    label: 'Drawings, specifications and models',
    freshnessHours: 168,
    why: 'Controlled information carries its own revision, so age alone does not make it wrong.',
    entities: ['Drawing', 'Specification', 'SpecClause', 'InformationContainer'],
  },
  WORK: {
    id: 'WORK',
    label: 'Work packages and programme',
    freshnessHours: 168,
    why: 'The shape of the work changes slowly; the progress against it comes through sync.',
    entities: ['WorkPackage', 'Task', 'LookaheadPlan', 'Constraint'],
  },
  ASSETS: {
    id: 'ASSETS',
    label: 'Asset and system register',
    freshnessHours: 336,
    why: 'An installed asset register is the slowest-moving thing a field device carries.',
    entities: ['AssetRegisterItem', 'SystemNode', 'Instrument'],
  },
} as const;

export type PackClassId = keyof typeof PACK_CLASS;
export const PACK_CLASSES = Object.keys(PACK_CLASS) as PackClassId[];

export function isPackClass(value: string): value is PackClassId {
  return (PACK_CLASSES as readonly string[]).includes(value);
}

/** The ceiling §16.5 sets on offline operation. No class may exceed it. */
export const MAX_PACK_HOURS = 14 * 24;

export type ManifestEntity = {
  refType: string;
  refId: string;
  /** What the device must reproduce to prove it downloaded the right thing. */
  stateHash: string;
  /** Where the record stood in the project's stream when the pack was cut. */
  streamVersion?: number;
  class: PackClassId;
  /** Whether the pack is unusable without it. §13.2's required/optional split. */
  required: boolean;
};

export type ManifestFile = {
  /** The content hash, which is also the file's identity in the evidence store. */
  hash: string;
  bytes: number;
  contentType: string;
  class: PackClassId;
  required: boolean;
};

export type PackManifest = {
  manifestId: string;
  /** Bumped whenever a project re-cuts a pack for the same scope. */
  version: number;
  tenantId: string;
  projectId: string;
  deviceId: string;
  issuedAt: string;
  issuedBy: string;
  /** The earliest expiry of any class in the pack. */
  expiresAt: string;
  classes: Array<{ id: PackClassId; label: string; freshnessHours: number; expiresAt: string }>;
  /** The stream position the pack was cut at. A device resumes sync from here. */
  streamCursor: number;
  entities: ManifestEntity[];
  files: ManifestFile[];
  totalBytes: number;
};

export type SignedManifest = PackManifest & {
  signature: { kid: string; value: string };
};

export type PackState = {
  id: string;
  projectId: string;
  deviceId: string;
  manifest: PackManifest;
  signature: { kid: string; value: string };
  status: 'ISSUED' | 'ACTIVE' | 'SUPERSEDED' | 'REVOKED';
  issuedAt: string;
  issuedBy: string;
  /** What the device said it verified. Reported, not witnessed. */
  receipt?: {
    reportedAt: string;
    reportedBy: string;
    entitiesVerified: number;
    filesVerified: number;
    activated: boolean;
    note?: string;
  };
  supersedes?: string;
  supersededBy?: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
};

function packsOf(ctx: EngineContext): PackState[] {
  return ctx.ledger
    .list(ctx.projectId, 'OfflinePack')
    .map((record) => record.state as unknown as PackState)
    .sort((a, b) => (a.issuedAt < b.issuedAt ? 1 : -1));
}

function requirePack(ctx: EngineContext, packId: string): PackState {
  const found = packsOf(ctx).find((entry) => entry.id === packId);
  if (!found) throw new DomainError('NO_SUCH_PACK', `No offline pack ${packId} on this project`, 404);
  return found;
}

/** The classes a module needs, so a device asks for a module rather than a list of entity types. */
export function classesForModule(module: FieldModule): PackClassId[] {
  const wanted = new Set([...module.records, ...module.plans]);
  return PACK_CLASSES.filter((id) => PACK_CLASS[id].entities.some((entity) => wanted.has(entity)));
}

function resolveClasses(input: { classes?: string[]; module?: string }): PackClassId[] {
  if (input.module) {
    const module = moduleBySlug(input.module);
    if (!module) {
      throw new DomainError(
        'NO_SUCH_MODULE',
        `There is no field module "${input.module}". The modules are ${Object.values(FIELD_MODULES)
          .map((entry) => entry.slug)
          .join(', ')}.`,
        404,
      );
    }
    const resolved = classesForModule(module);
    if (resolved.length === 0) {
      throw new DomainError(
        'MODULE_CARRIES_NO_PACK',
        `${module.label} works to no content a device can carry offline, so there is nothing to pack.`,
      );
    }
    return resolved;
  }

  const asked = input.classes ?? [];
  if (asked.length === 0) {
    throw new DomainError(
      'PACK_SCOPE_REQUIRED',
      'Name the content classes to pack, or the field module to pack for. An unscoped pack is a copy of the estate.',
    );
  }
  const unknown = asked.filter((entry) => !isPackClass(entry));
  if (unknown.length > 0) {
    throw new DomainError('NO_SUCH_PACK_CLASS', `Not a pack class: ${unknown.join(', ')}. Classes are ${PACK_CLASSES.join(', ')}.`);
  }
  return asked as PackClassId[];
}

/** Every record of a class, with the hash a device verifies against. */
function entitiesOfClass(ctx: EngineContext, id: PackClassId): ManifestEntity[] {
  const at = new Map<string, number>();
  for (const event of ctx.ledger.events({ projectId: ctx.projectId })) {
    if (event.streamVersion !== undefined) at.set(event.eventId, event.streamVersion);
  }

  const rows: ManifestEntity[] = [];
  for (const refType of PACK_CLASS[id].entities) {
    for (const record of ctx.ledger.list(ctx.projectId, refType)) {
      const version = at.get(record.lastEventId);
      rows.push({
        refType,
        refId: record.refId,
        stateHash: record.stateHash,
        ...(version === undefined ? {} : { streamVersion: version }),
        class: id,
        // Permits and method statements are what a shift is authorised by. A
        // pack missing one of those is not a degraded pack, it is an unusable
        // one; everything else can be filled in later.
        required: id === 'PERMITS' || id === 'SAFETY',
      });
    }
  }
  return rows;
}

/** Evidence filed against anything in the pack, which is what the files are. */
function filesFor(ctx: EngineContext, entities: readonly ManifestEntity[]): ManifestFile[] {
  const inPack = new Map(entities.map((entry) => [`${entry.refType}:${entry.refId}`, entry.class]));
  const files: ManifestFile[] = [];
  const seen = new Set<string>();

  for (const record of ctx.ledger.list(ctx.projectId, 'EvidenceItem')) {
    const state = record.state as {
      hash?: string;
      bytes?: number;
      contentType?: string;
      linkedEntities?: Array<{ refType?: string; refId?: string }>;
    };
    if (typeof state.hash !== 'string' || seen.has(state.hash)) continue;

    const linked = Array.isArray(state.linkedEntities) ? state.linkedEntities : [];
    const match = linked
      .map((entry) => inPack.get(`${entry.refType}:${entry.refId}`))
      .find((value): value is PackClassId => value !== undefined);
    if (!match) continue;

    seen.add(state.hash);
    files.push({
      hash: state.hash,
      // A size the platform does not hold is published as zero rather than
      // guessed at, and the estimate says how many it could not size.
      bytes: typeof state.bytes === 'number' ? state.bytes : 0,
      contentType: typeof state.contentType === 'string' ? state.contentType : 'application/octet-stream',
      class: match,
      required: false,
    });
  }
  return files;
}

export type PackEstimate = {
  classes: Array<{
    id: PackClassId;
    label: string;
    why: string;
    freshnessHours: number;
    entities: number;
    files: number;
    bytes: number;
  }>;
  totalEntities: number;
  totalFiles: number;
  totalBytes: number;
  /** Files whose size the platform does not hold, so the total is a floor rather than a figure. */
  filesOfUnknownSize: number;
  expiresAt: string;
  /** The class that sets the expiry, so a person can see why it is that short. */
  expiryDrivenBy: PackClassId;
};

/**
 * What a pack would contain, without issuing one.
 *
 * A device on a metered connection asks this before committing to a download,
 * and the answer has to be honest about what it cannot size: a total presented
 * as exact, over files the platform holds no byte count for, is a number that
 * will be wrong on the one connection where being wrong costs money.
 */
export function estimatePack(
  ctx: EngineContext,
  input: { classes?: string[]; module?: string },
  now = new Date(),
): PackEstimate {
  authorise(ctx, 'FIELD_EXECUTION', 'R');
  const classes = resolveClasses(input);

  const perClass = classes.map((id) => {
    const entities = entitiesOfClass(ctx, id);
    const files = filesFor(ctx, entities);
    return {
      id,
      label: PACK_CLASS[id].label,
      why: PACK_CLASS[id].why,
      freshnessHours: PACK_CLASS[id].freshnessHours,
      entities: entities.length,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
    };
  });

  const allEntities = classes.flatMap((id) => entitiesOfClass(ctx, id));
  const allFiles = filesFor(ctx, allEntities);
  const shortest = classes.reduce((soonest, id) =>
    PACK_CLASS[id].freshnessHours < PACK_CLASS[soonest].freshnessHours ? id : soonest,
  );

  return {
    classes: perClass,
    totalEntities: allEntities.length,
    totalFiles: allFiles.length,
    totalBytes: allFiles.reduce((total, file) => total + file.bytes, 0),
    filesOfUnknownSize: allFiles.filter((file) => file.bytes === 0).length,
    expiresAt: new Date(now.getTime() + PACK_CLASS[shortest].freshnessHours * 3_600_000).toISOString(),
    expiryDrivenBy: shortest,
  };
}

/**
 * Cut and sign a pack for one device.
 *
 * The previous pack for the same device is **not** revoked here. It is marked
 * superseded only when this one's receipt arrives, so a device whose download
 * fails halfway still holds a working set — §14.6's rule, and the difference
 * between a failed download and a site crew with nothing to work from.
 */
export function issuePack(
  ctx: EngineContext,
  input: { deviceId: string; classes?: string[]; module?: string },
  now = new Date(),
): { packId: string; manifest: SignedManifest } {
  // `C` rather than `R`: a pack takes a copy of controlled information off the
  // platform and onto a handset, which is a grant, not a read.
  authorise(ctx, 'FIELD_EXECUTION', 'C');

  if (!input.deviceId?.trim()) {
    throw new DomainError(
      'DEVICE_REQUIRED',
      'A pack is issued to a device. Without one, nothing can be revoked later and nothing can be held to a scope.',
    );
  }
  const classes = resolveClasses(input);
  const deviceId = input.deviceId.trim();

  const entities = classes.flatMap((id) => entitiesOfClass(ctx, id));
  const files = filesFor(ctx, entities);

  const shortest = classes.reduce((soonest, id) =>
    PACK_CLASS[id].freshnessHours < PACK_CLASS[soonest].freshnessHours ? id : soonest,
  );
  const hours = Math.min(PACK_CLASS[shortest].freshnessHours, MAX_PACK_HOURS);

  const held = packsOf(ctx).filter((pack) => pack.deviceId === deviceId);
  const live = held.find((pack) => pack.status === 'ISSUED' || pack.status === 'ACTIVE');

  const packId = ulid();
  const events = ctx.ledger.events({ projectId: ctx.projectId });
  const manifest: PackManifest = {
    manifestId: packId,
    version: held.length + 1,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    deviceId,
    issuedAt: now.toISOString(),
    issuedBy: ctx.auth.actorId,
    expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
    classes: classes.map((id) => ({
      id,
      label: PACK_CLASS[id].label,
      freshnessHours: PACK_CLASS[id].freshnessHours,
      expiresAt: new Date(now.getTime() + PACK_CLASS[id].freshnessHours * 3_600_000).toISOString(),
    })),
    streamCursor: events.at(-1)?.streamVersion ?? 0,
    entities,
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };

  const signature = signFor('offline-pack', canonicalize(manifest));

  write(ctx, {
    eventType: 'OFFLINE_PACK_ISSUED',
    entity: { refType: 'OfflinePack', refId: packId },
    nextState: {
      id: packId,
      projectId: ctx.projectId,
      deviceId,
      manifest,
      signature: { kid: signature.kid, value: signature.signature },
      status: 'ISSUED',
      issuedAt: manifest.issuedAt,
      issuedBy: ctx.auth.actorId,
      ...(live ? { supersedes: live.id } : {}),
    } satisfies PackState as unknown as Record<string, unknown>,
  });

  return { packId, manifest: { ...manifest, signature: { kid: signature.kid, value: signature.signature } } };
}

/** The signed manifest, for a device that is downloading or re-verifying. */
export function packManifest(ctx: EngineContext, packId: string): SignedManifest {
  authorise(ctx, 'FIELD_EXECUTION', 'R');
  const pack = requirePack(ctx, packId);
  if (pack.status === 'REVOKED') {
    throw new DomainError(
      'PACK_REVOKED',
      `This pack was revoked${pack.revocationReason ? `: ${pack.revocationReason}` : ''}. Ask for a new one.`,
      403,
    );
  }
  return { ...pack.manifest, signature: pack.signature };
}

/**
 * Whether a manifest presented back to the platform is one it issued.
 *
 * The half of the signature that is actually usable — see the module comment.
 * A device cannot check an HMAC, but the platform can, and that is what stops a
 * handset asserting a scope it was never granted.
 */
export function manifestIsOurs(manifest: PackManifest, signature: { kid: string; value: string }): boolean {
  return verifyFor('offline-pack', canonicalize(manifest), signature.value).valid;
}

/**
 * The device reports what it verified, and whether it activated.
 *
 * Recorded as a report. The platform did not watch the device hash 4,000 files,
 * and a field named `verified` would say it had. What the platform *does*
 * enforce is that a device cannot activate a pack that was revoked, cannot
 * report against a pack that is not its own, and cannot claim activation while
 * saying it verified fewer required entities than the manifest carries.
 */
export function recordPackReceipt(
  ctx: EngineContext,
  input: { packId: string; deviceId: string; entitiesVerified: number; filesVerified: number; activated: boolean; note?: string },
  now = new Date(),
): { packId: string; status: PackState['status']; supersededPackId?: string } {
  authorise(ctx, 'FIELD_EXECUTION', 'U');

  const pack = requirePack(ctx, input.packId);
  if (pack.deviceId !== input.deviceId) {
    throw new DomainError('PACK_NOT_FOR_DEVICE', 'This pack was issued to another device.', 403);
  }
  if (pack.status === 'REVOKED') {
    throw new DomainError('PACK_REVOKED', 'A revoked pack cannot be activated.', 409);
  }
  if (pack.receipt) {
    throw new DomainError(
      'PACK_ALREADY_RECEIPTED',
      'This pack already carries a receipt. A second one would overwrite what the device first reported, which is the record a dispute turns on.',
      409,
    );
  }

  const required = pack.manifest.entities.filter((entry) => entry.required).length;
  if (input.activated && input.entitiesVerified < required) {
    throw new DomainError(
      'REQUIRED_CONTENT_UNVERIFIED',
      `This pack carries ${required} required records — permits and method statements — and the device reports ` +
        `verifying ${input.entitiesVerified}. A pack activated without them would let a shift start against ` +
        'authorisations nobody checked.',
    );
  }

  const superseded = input.activated && pack.supersedes ? pack.supersedes : undefined;

  write(ctx, {
    eventType: 'OFFLINE_PACK_ACTIVATED',
    entity: { refType: 'OfflinePack', refId: pack.id },
    nextState: {
      ...pack,
      status: input.activated ? 'ACTIVE' : 'ISSUED',
      receipt: {
        reportedAt: now.toISOString(),
        reportedBy: ctx.auth.actorId,
        entitiesVerified: input.entitiesVerified,
        filesVerified: input.filesVerified,
        activated: input.activated,
        ...(input.note ? { note: input.note } : {}),
      },
    } as unknown as Record<string, unknown>,
  });

  // Only now, and only on a real activation: the previous pack stays live until
  // this one is verified, which is the whole point of the rule.
  if (superseded) {
    const previous = packsOf(ctx).find((entry) => entry.id === superseded);
    if (previous && previous.status !== 'REVOKED') {
      write(ctx, {
        eventType: 'OFFLINE_PACK_SUPERSEDED',
        entity: { refType: 'OfflinePack', refId: previous.id },
        nextState: { ...previous, status: 'SUPERSEDED', supersededBy: pack.id } as unknown as Record<string, unknown>,
      });
    }
  }

  return {
    packId: pack.id,
    status: input.activated ? 'ACTIVE' : 'ISSUED',
    ...(superseded ? { supersededPackId: superseded } : {}),
  };
}

/**
 * Withdraw a pack.
 *
 * §14.6: revocation invalidates the local project keys and hides the content.
 * The platform's half is refusing the manifest from here on and recording who
 * withdrew it and why; the device's half — dropping keys, hiding content, and
 * surrendering unsynced work only through an approved recovery — happens on the
 * handset and is stated rather than claimed.
 */
export function revokePack(
  ctx: EngineContext,
  input: { packId: string; reason: string },
  now = new Date(),
): { packId: string; status: 'REVOKED' } {
  // An approval: withdrawing a working set from a device mid-shift stops work.
  authorise(ctx, 'FIELD_EXECUTION', 'A');

  if (!input.reason || input.reason.trim().length < 10) {
    throw new DomainError(
      'REASON_REQUIRED',
      'Say why the pack is being withdrawn. A device that loses its working set mid-shift needs a reason somebody can answer for.',
    );
  }

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'REVOKED') {
    throw new DomainError('PACK_ALREADY_REVOKED', 'This pack is already revoked.', 409);
  }

  write(ctx, {
    eventType: 'OFFLINE_PACK_REVOKED',
    entity: { refType: 'OfflinePack', refId: pack.id },
    nextState: {
      ...pack,
      status: 'REVOKED',
      revokedAt: now.toISOString(),
      revokedBy: ctx.auth.actorId,
      revocationReason: input.reason.trim(),
    } as unknown as Record<string, unknown>,
  });

  return { packId: pack.id, status: 'REVOKED' };
}

export type PackPosition = {
  packs: Array<
    Omit<PackState, 'manifest' | 'signature'> & {
      entities: number;
      files: number;
      totalBytes: number;
      expiresAt: string;
      expired: boolean;
      classes: PackClassId[];
    }
  >;
  live: number;
  expired: number;
  revoked: number;
  /** Devices holding a live pack, which is who a revocation would reach. */
  devices: string[];
};

/** Every pack the project has issued, for the console. */
export function packPosition(ctx: EngineContext, now = new Date()): PackPosition {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const packs = packsOf(ctx).map((pack) => {
    const { manifest, signature: _signature, ...rest } = pack;
    return {
      ...rest,
      entities: manifest.entities.length,
      files: manifest.files.length,
      totalBytes: manifest.totalBytes,
      expiresAt: manifest.expiresAt,
      expired: manifest.expiresAt < now.toISOString(),
      classes: manifest.classes.map((entry) => entry.id),
    };
  });

  const isLive = (pack: (typeof packs)[number]) =>
    (pack.status === 'ISSUED' || pack.status === 'ACTIVE') && !pack.expired;

  return {
    packs,
    live: packs.filter(isLive).length,
    expired: packs.filter((pack) => pack.expired && pack.status !== 'REVOKED').length,
    revoked: packs.filter((pack) => pack.status === 'REVOKED').length,
    devices: [...new Set(packs.filter(isLive).map((pack) => pack.deviceId))].sort(),
  };
}
