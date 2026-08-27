import { hashState } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';

/**
 * H-WF-04 — asset register, exchange validation and warranty activation.
 *
 * `handover.registerAsset` and `handover.registerWarranty` already create the
 * asset and its warranty, and the lifecycle plan, maintenance forecast and
 * operating position all read them. None of that is rebuilt. What was absent is
 * everything that decides whether the register is **fit to hand over**.
 *
 * **Blank is not pass.** The exception control, and the rule the whole workflow
 * turns on. An asset register with empty serial columns scores as complete on
 * every tool that counts rows, because a blank passes a presence check by not
 * being examined. Here a mandatory attribute is either supplied or recorded as
 * an explicit **Unknown with an owner and a reason** — which is a different
 * thing entirely, because somebody has to be asked about it.
 *
 * **A duplicate identity blocks acceptance.** Two assets with the same tag is
 * not a data-quality nuisance: the tag is the identity the maintenance system,
 * the manual, the drawing link and the warranty all hang off, and duplicating it
 * silently merges two machines. `registerAsset` now refuses one outright, which
 * is a correctness fix to existing code rather than a new rule.
 *
 * **Export success is not acceptance.** AC-H-WF-04-03, and it is the failure
 * that makes asset handovers famous. A COBie file uploads cleanly, the project
 * closes, and eighteen months later the maintenance system turns out to have
 * silently rejected four hundred rows for a classification value it did not
 * recognise. An export here is a claim; reconciliation against what the target
 * system actually accepted is the answer, and the totals have to add up.
 */

/**
 * The attributes an asset record must carry before it is handed over.
 *
 * From the specification's own required inputs. `identity` marks the three that
 * together make an asset the same asset in every system it appears in.
 */
export const ASSET_ATTRIBUTE = [
  { key: 'assetTag', what: 'The tag on the plate', identity: true },
  { key: 'assetClass', what: 'Classification to the agreed standard', identity: false },
  { key: 'location', what: 'Where it is', identity: false },
  { key: 'manufacturer', what: 'Who made it', identity: true },
  { key: 'modelNumber', what: 'Which model', identity: true },
  { key: 'serialNumber', what: 'The serial on the unit installed', identity: true },
  { key: 'installedAt', what: 'When it went in', identity: false },
  { key: 'expectedLifeYears', what: 'Expected service life', identity: false },
  { key: 'replacementCostMinor', what: 'Replacement cost', identity: false },
] as const;

export type AssetAttributeKey = (typeof ASSET_ATTRIBUTE)[number]['key'];

export type DeclaredUnknown = {
  attribute: AssetAttributeKey;
  /** Who has to find it out. An Unknown with no owner is a blank with a label. */
  owner: string;
  reason: string;
  /** When it has to be resolved by. */
  by: string;
};

export type ValidationError = {
  assetTag: string;
  attribute: AssetAttributeKey;
  /** Machine-readable, because the specification asks for machine-readable errors. */
  code: 'MISSING' | 'DUPLICATE_IDENTITY' | 'UNLINKED';
  detail: string;
};

/**
 * Why this asset register is not ready to hand over, or an empty list.
 *
 * Derived on read. A stored validation result is the one that still says "clean"
 * after somebody edited a row.
 */
export function validateRegister(ctx: EngineContext): {
  errors: ValidationError[];
  declaredUnknowns: Array<DeclaredUnknown & { assetTag: string; overdue: boolean }>;
  assets: number;
  completePercent: number;
} {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const today = new Date().toISOString().slice(0, 10);
  const records = ctx.ledger.list(ctx.projectId, 'AssetRegisterItem');
  const declared = new Map<string, DeclaredUnknown[]>();

  for (const record of ctx.ledger.list(ctx.projectId, 'AssetValidation')) {
    declared.set(
      String(record.state.assetTag),
      (record.state.declaredUnknowns as DeclaredUnknown[] | undefined) ?? [],
    );
  }

  const errors: ValidationError[] = [];
  const seenTags = new Map<string, number>();
  const seenSerials = new Map<string, number>();

  for (const record of records) {
    const state = record.state as Record<string, unknown>;
    const assetTag = String(state.assetTag ?? '');
    seenTags.set(assetTag, (seenTags.get(assetTag) ?? 0) + 1);
    const serial = String(state.serialNumber ?? '').trim();
    if (serial) seenSerials.set(serial, (seenSerials.get(serial) ?? 0) + 1);

    const unknowns = new Set((declared.get(assetTag) ?? []).map((entry) => entry.attribute));

    for (const attribute of ASSET_ATTRIBUTE) {
      const value = state[attribute.key];
      const blank = value === undefined || value === null || String(value).trim() === '';
      if (!blank || unknowns.has(attribute.key)) continue;
      errors.push({
        assetTag,
        attribute: attribute.key,
        code: 'MISSING',
        detail: `${attribute.what} is blank and no explicit Unknown has been declared for it. A blank passes a presence check by not being examined.`,
      });
    }
  }

  for (const [tag, count] of seenTags) {
    if (count > 1) {
      errors.push({
        assetTag: tag,
        attribute: 'assetTag',
        code: 'DUPLICATE_IDENTITY',
        detail: `${count} assets carry the tag ${tag}. The tag is what the maintenance system, the manual, the drawing link and the warranty all hang off.`,
      });
    }
  }
  for (const [serial, count] of seenSerials) {
    if (count > 1) {
      errors.push({
        assetTag: serial,
        attribute: 'serialNumber',
        code: 'DUPLICATE_IDENTITY',
        detail: `${count} assets carry the serial ${serial}. Either one unit is registered twice or a serial was copied from the row above.`,
      });
    }
  }

  const declaredUnknowns = [...declared.entries()].flatMap(([assetTag, entries]) =>
    entries.map((entry) => ({ ...entry, assetTag, overdue: entry.by.slice(0, 10) < today })),
  );

  const attributeCount = records.length * ASSET_ATTRIBUTE.length;
  const missing = errors.filter((error) => error.code === 'MISSING').length;

  return {
    errors,
    declaredUnknowns,
    assets: records.length,
    completePercent: attributeCount === 0 ? 0 : Math.round(((attributeCount - missing) / attributeCount) * 100),
  };
}

/**
 * Declare what is not known about an asset, and who has to find it out.
 *
 * The exception control made usable. An Unknown recorded this way is a fact
 * somebody owns; a blank is a fact nobody has noticed.
 */
export function declareUnknowns(
  ctx: EngineContext,
  input: { assetTag: string; declaredUnknowns: DeclaredUnknown[]; declaredBy: string },
): { assetTag: string; declared: number } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const asset = ctx.ledger
    .list(ctx.projectId, 'AssetRegisterItem')
    .find((record) => record.state.assetTag === input.assetTag);
  if (!asset) throw new DomainError('ASSET_NOT_FOUND', `No asset tagged ${input.assetTag}.`, 404);

  if (input.declaredUnknowns.length === 0) {
    throw new DomainError('NOTHING_DECLARED', 'Declare at least one attribute, or there is nothing to record.');
  }
  for (const entry of input.declaredUnknowns) {
    if (!ASSET_ATTRIBUTE.some((attribute) => attribute.key === entry.attribute)) {
      throw new DomainError('ATTRIBUTE_UNKNOWN', `${entry.attribute} is not a mandatory asset attribute.`);
    }
    if (!entry.owner.trim() || entry.reason.trim().length < 10) {
      throw new DomainError(
        'UNKNOWN_UNOWNED',
        `${entry.attribute} is declared Unknown with no ${!entry.owner.trim() ? 'owner' : 'reason'}. An Unknown with no ` +
          'owner is a blank with a label on it.',
      );
    }
    if (Number.isNaN(Date.parse(entry.by))) {
      throw new DomainError(
        'UNKNOWN_UNDATED',
        `${entry.attribute} is declared Unknown with no date to resolve it by, which makes it permanent.`,
      );
    }
    const identity = ASSET_ATTRIBUTE.find((attribute) => attribute.key === entry.attribute)!.identity;
    if (identity && entry.attribute !== 'serialNumber') {
      throw new DomainError(
        'IDENTITY_NOT_DECLARABLE',
        `${entry.attribute} is part of the asset's identity and cannot be Unknown. An asset with no tag, manufacturer or ` +
          'model is not an asset record — it is a row.',
      );
    }
  }
  if (!input.declaredBy.trim()) throw new DomainError('DECLARATION_UNSIGNED', 'Name who declared them.');

  const validationId = `${ctx.projectId}-${input.assetTag}`;

  write(ctx, {
    eventType: 'ASSET_DATA_VALIDATED',
    entity: { refType: 'AssetValidation', refId: validationId },
    nextState: {
      validationId,
      projectId: ctx.projectId,
      assetTag: input.assetTag,
      declaredUnknowns: input.declaredUnknowns,
      declaredBy: input.declaredBy,
      declaredAt: new Date().toISOString(),
    },
  });

  return { assetTag: input.assetTag, declared: input.declaredUnknowns.length };
}

// --- Exchange and reconciliation --------------------------------------------

export const EXCHANGE_FORMAT = ['COBIE', 'IFC', 'IDS'] as const;
export type ExchangeFormat = (typeof EXCHANGE_FORMAT)[number];

export type ExchangeState = {
  exportId: string;
  reference: string;
  format: ExchangeFormat;
  externalSystem: string;
  /** The stable identifiers sent, which is what reconciliation matches on. */
  externalIds: string[];
  rowsExported: number;
  contentHash: string;
  exportedBy: string;
  exportedAt: string;
  reconciliation?: {
    rowsAccepted: number;
    rejected: Array<{ externalId: string; reason: string }>;
    reconciledBy: string;
    reconciledAt: string;
  };
};

function exchanges(ctx: EngineContext): ExchangeState[] {
  return ctx.ledger.list(ctx.projectId, 'AssetExchange').map((record) => record.state as unknown as ExchangeState);
}

/**
 * Export the register to an external system.
 *
 * Refused while the register has errors, because exporting a register with
 * duplicate tags and blank serials into a maintenance system does not fix
 * either; it copies them somewhere harder to correct.
 */
export function exportExchange(
  ctx: EngineContext,
  input: { reference: string; format: ExchangeFormat; externalSystem: string; assetTags: string[]; exportedBy: string },
): { exportId: string; rowsExported: number; contentHash: string } {
  authorise(ctx, 'HANDOVER_OM', 'I', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.externalSystem.trim()) {
    throw new DomainError('EXPORT_UNIDENTIFIED', 'An export names its reference and the system it is going to.');
  }
  if (!input.exportedBy.trim()) throw new DomainError('EXPORT_UNSIGNED', 'Name who exported it.');
  if (input.assetTags.length === 0) throw new DomainError('NOTHING_TO_EXPORT', 'No assets were selected.');

  const records = ctx.ledger.list(ctx.projectId, 'AssetRegisterItem');
  const byTag = new Map(records.map((record) => [String(record.state.assetTag), record]));
  const unknown = input.assetTags.filter((tag) => !byTag.has(tag));
  if (unknown.length > 0) {
    throw new DomainError('ASSET_NOT_FOUND', `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not on the register.`, 404);
  }

  const validation = validateRegister(ctx);
  const relevant = validation.errors.filter((error) => input.assetTags.includes(error.assetTag));
  if (relevant.length > 0) {
    throw new DomainError(
      'REGISTER_INVALID',
      `${relevant.length} validation error${relevant.length === 1 ? '' : 's'} on the selected assets, starting with ` +
        `${relevant[0]!.assetTag}: ${relevant[0]!.detail} Exporting a register with these in it does not fix them; it ` +
        'copies them somewhere harder to correct.',
    );
  }

  // The external id is the asset tag, deliberately: a stable identifier the
  // receiving system can match on next time, rather than one allocated here that
  // changes on every export.
  const externalIds = [...input.assetTags];
  const contentHash = hashState(
    externalIds.map((tag) => {
      const state = byTag.get(tag)!.state as Record<string, unknown>;
      return Object.fromEntries(ASSET_ATTRIBUTE.map((attribute) => [attribute.key, state[attribute.key] ?? null]));
    }),
  );

  const exportId = ulid();

  write(ctx, {
    eventType: 'ASSET_EXCHANGE_EXPORTED',
    entity: { refType: 'AssetExchange', refId: exportId },
    nextState: {
      exportId,
      projectId: ctx.projectId,
      reference: input.reference,
      format: input.format,
      externalSystem: input.externalSystem,
      externalIds,
      rowsExported: externalIds.length,
      contentHash,
      exportedBy: input.exportedBy,
      exportedAt: new Date().toISOString(),
    },
  });

  return { exportId, rowsExported: externalIds.length, contentHash };
}

/**
 * Reconcile what the target system actually accepted.
 *
 * AC-H-WF-04-03, and the failure it exists for: a COBie file uploads cleanly,
 * the project closes, and eighteen months later the maintenance system turns out
 * to have silently rejected four hundred rows for a classification value it did
 * not recognise. The totals have to add up and every rejected row has to say
 * why.
 */
export function reconcileExchange(
  ctx: EngineContext,
  exportId: string,
  input: { rowsAccepted: number; rejected: Array<{ externalId: string; reason: string }>; reconciledBy: string },
): { reconciles: boolean; rowsExported: number; rowsAccepted: number; rejected: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'AssetExchange', refId: exportId });
  if (!record) throw new DomainError('EXPORT_NOT_FOUND', `No export ${exportId}`, 404);
  const state = record.state as unknown as ExchangeState;

  if (state.reconciliation) {
    throw new DomainError('ALREADY_RECONCILED', `${state.reference} has already been reconciled.`);
  }
  if (!input.reconciledBy.trim()) throw new DomainError('RECONCILIATION_UNSIGNED', 'Name who reconciled it.');

  const unexplained = input.rejected.find((row) => !row.reason.trim());
  if (unexplained) {
    throw new DomainError(
      'REJECTION_UNEXPLAINED',
      `${unexplained.externalId} is reported as rejected with no reason. A rejected row nobody can explain is the row that ` +
        'is still missing eighteen months later.',
    );
  }
  const foreign = input.rejected.filter((row) => !state.externalIds.includes(row.externalId));
  if (foreign.length > 0) {
    throw new DomainError(
      'REJECTION_NOT_EXPORTED',
      `${foreign.map((row) => row.externalId).join(', ')} was reported as rejected but was never in this export. The ` +
        'reconciliation is against what was sent, or it reconciles to nothing.',
    );
  }

  // The arithmetic that makes "no silent rejected rows" checkable.
  const reconciles = input.rowsAccepted + input.rejected.length === state.rowsExported;
  if (!reconciles) {
    throw new DomainError(
      'TOTALS_DO_NOT_RECONCILE',
      `${state.rowsExported} rows were exported, ${input.rowsAccepted} are reported accepted and ${input.rejected.length} ` +
        `rejected, which leaves ${state.rowsExported - input.rowsAccepted - input.rejected.length} unaccounted for. Those ` +
        'are the rows nobody discovers until somebody looks for an asset that is not there.',
    );
  }

  write(ctx, {
    eventType: 'ASSET_RECONCILED',
    entity: { refType: 'AssetExchange', refId: exportId },
    nextState: {
      ...record.state,
      reconciliation: {
        rowsAccepted: input.rowsAccepted,
        rejected: input.rejected,
        reconciledBy: input.reconciledBy,
        reconciledAt: new Date().toISOString(),
      },
    },
  });

  return {
    reconciles: true,
    rowsExported: state.rowsExported,
    rowsAccepted: input.rowsAccepted,
    rejected: input.rejected.length,
  };
}

/**
 * Why the asset register is not ready to hand over, or null.
 *
 * Exported so H-WF-01's readiness reads the same answer. An export that has not
 * been reconciled is not an accepted export, which is the exception control
 * stated as a refusal.
 */
export function assetHandoverBlockedReason(ctx: EngineContext): string | null {
  const records = ctx.ledger.list(ctx.projectId, 'AssetRegisterItem');
  if (records.length === 0) return null;

  const validation = validateRegister(ctx);
  const duplicates = validation.errors.filter((error) => error.code === 'DUPLICATE_IDENTITY');
  if (duplicates.length > 0) return duplicates[0]!.detail;

  const overdue = validation.declaredUnknowns.filter((entry) => entry.overdue);
  if (overdue.length > 0) {
    return (
      `${overdue.map((entry) => `${entry.assetTag}/${entry.attribute}`).join(', ')} declared Unknown and past the date ` +
      `${overdue[0]!.owner} was to resolve it by.`
    );
  }

  const all = exchanges(ctx);
  if (all.length === 0) return null;
  const unreconciled = all.filter((exchange) => !exchange.reconciliation);
  if (unreconciled.length > 0) {
    return (
      `${unreconciled.map((exchange) => exchange.reference).join(', ')} exported to ` +
      `${unreconciled[0]!.externalSystem} and never reconciled. Export success is not acceptance.`
    );
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type AssetRegisterPosition = {
  assets: number;
  completePercent: number;
  errors: ValidationError[];
  declaredUnknowns: Array<DeclaredUnknown & { assetTag: string; overdue: boolean }>;
  exchanges: Array<{
    reference: string;
    format: ExchangeFormat;
    externalSystem: string;
    rowsExported: number;
    rowsAccepted?: number;
    rejected: Array<{ externalId: string; reason: string }>;
    reconciled: boolean;
  }>;
  blockedReason: string | null;
  summary: string;
};

export function assetRegisterPosition(ctx: EngineContext): AssetRegisterPosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const validation = validateRegister(ctx);
  const rows = exchanges(ctx).map((exchange) => ({
    reference: exchange.reference,
    format: exchange.format,
    externalSystem: exchange.externalSystem,
    rowsExported: exchange.rowsExported,
    rowsAccepted: exchange.reconciliation?.rowsAccepted,
    rejected: exchange.reconciliation?.rejected ?? [],
    reconciled: Boolean(exchange.reconciliation),
  }));

  const parts = [`${validation.assets} asset${validation.assets === 1 ? '' : 's'}`, `${validation.completePercent}% complete`];
  if (validation.errors.length > 0) parts.push(`${validation.errors.length} validation error`);
  const unresolved = validation.declaredUnknowns.filter((entry) => entry.overdue).length;
  if (unresolved > 0) parts.push(`${unresolved} Unknown past its date`);
  const unreconciled = rows.filter((row) => !row.reconciled).length;
  if (unreconciled > 0) parts.push(`${unreconciled} export never reconciled`);
  const rejected = rows.reduce((sum, row) => sum + row.rejected.length, 0);
  if (rejected > 0) parts.push(`${rejected} row rejected by the receiving system`);

  return {
    assets: validation.assets,
    completePercent: validation.completePercent,
    errors: validation.errors,
    declaredUnknowns: validation.declaredUnknowns,
    exchanges: rows,
    blockedReason: assetHandoverBlockedReason(ctx),
    summary: parts.join(', ') + '.',
  };
}
