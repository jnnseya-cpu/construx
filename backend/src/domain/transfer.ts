import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * H-WF-07 — keys, access, credentials, spares, tools and service transfer.
 *
 * The unglamorous half of a handover, and the half that decides whether anybody
 * can actually get into the plant room on Monday.
 *
 * **AC-H-WF-07-02 is structural, not a rule.** "No secret value appears in the
 * audit log or export" cannot be enforced by validating input, because a rule
 * that inspects a secret has already handled one. So there is **no field a
 * secret could be put in**: a credential is registered by its vault reference
 * and its status, and the transfer records that it happened through a named
 * mechanism. The platform never holds, sees, or moves the value — and because
 * the type has no place for one, no future caller can accidentally supply it.
 *
 * **AC-H-WF-07-01: both parties, and a receipt.** An inventory transfer signed
 * by one side is a note somebody wrote. The sender and the recipient are both
 * named, the quantity received is recorded against the quantity expected, and
 * the signed receipt is registered as hashed evidence rather than cited as a
 * reference — the criterion says *retain* the receipt, and a reference to a
 * document nobody kept is what either party finds six months later when the
 * tools are not where they should be.
 *
 * **AC-H-WF-07-03: a shortage is an obligation, not a note.** The commonest
 * outcome of a handover inventory is that most of it arrives. What happens to
 * the rest is decided in the fortnight afterwards or never, so a shortage
 * carries an owner and a date from the moment it is recorded, and a **critical**
 * item short blocks readiness.
 *
 * **A lost key is a security incident.** The exception control, and it is
 * separate from a shortage deliberately: a spare that never arrived is a
 * commercial problem, and a key that was issued and cannot be accounted for is a
 * building somebody may be able to get into.
 */

export const TRANSFER_ITEM_KIND = [
  'KEY',
  'ACCESS_CARD',
  'CREDENTIAL',
  'SPARE',
  'CONSUMABLE',
  'SPECIAL_TOOL',
  'TEST_EQUIPMENT',
] as const;
export type TransferItemKind = (typeof TRANSFER_ITEM_KIND)[number];

/** The kinds whose value must never touch this platform. */
const SECRET_KINDS: ReadonlySet<TransferItemKind> = new Set(['CREDENTIAL']);

export type TransferItemState = {
  itemId: string;
  reference: string;
  kind: TransferItemKind;
  description: string;
  quantityRequired: number;
  quantityHeld: number;
  condition: string;
  storageLocation: string;
  /** Whether the operator cannot run the building without it. */
  critical: boolean;
  transferOwner: string;
  /**
   * For a credential, the identifier in the secret store — never the secret.
   *
   * There is no field on this type that a value could go in, which is what makes
   * AC-H-WF-07-02 a property of the shape rather than a rule somebody enforces.
   */
  vaultReference?: string;
  status: 'REGISTERED' | 'TRANSFERRED' | 'SHORT' | 'LOST';
  transfer?: {
    quantityReceived: number;
    condition: string;
    sender: string;
    recipient: string;
    location: string;
    receiptReference: string;
    transferredAt: string;
  };
  credentialTransfer?: { vaultReference: string; mechanism: string; confirmedBy: string; confirmedAt: string };
  shortage?: { shortBy: number; owner: string; by: string; note: string; recordedAt: string };
  loss?: { what: string; reportedBy: string; reportedAt: string };
};

function items(ctx: EngineContext): TransferItemState[] {
  return ctx.ledger.list(ctx.projectId, 'TransferItem').map((record) => record.state as unknown as TransferItemState);
}

function requireItem(ctx: EngineContext, itemId: string) {
  const record = ctx.ledger.get({ refType: 'TransferItem', refId: itemId });
  if (!record) throw new DomainError('ITEM_NOT_FOUND', `No transfer item ${itemId}`, 404);
  return record;
}

/** Register an item or a credential for transfer. */
export function registerTransferItem(
  ctx: EngineContext,
  input: {
    reference: string;
    kind: TransferItemKind;
    description: string;
    quantityRequired: number;
    quantityHeld: number;
    condition: string;
    storageLocation: string;
    critical: boolean;
    transferOwner: string;
    vaultReference?: string;
  },
): { itemId: string; shortBy: number } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.description.trim()) {
    throw new DomainError('ITEM_UNIDENTIFIED', 'A transfer item carries a reference and says what it is.');
  }
  if (items(ctx).some((item) => item.reference === input.reference)) {
    throw new DomainError('REFERENCE_TAKEN', `${input.reference} is already on the transfer register.`);
  }
  if (!input.transferOwner.trim()) {
    throw new DomainError(
      'OWNER_REQUIRED',
      'Name who is responsible for handing it over. An inventory with no owner is a list somebody compiled.',
    );
  }
  if (input.quantityRequired <= 0) {
    throw new DomainError('QUANTITY_REQUIRED', 'Say how many are required, or the item is not on the inventory.');
  }
  if (input.quantityHeld < 0) throw new DomainError('QUANTITY_REQUIRED', 'A held quantity is not negative.');

  if (SECRET_KINDS.has(input.kind)) {
    if (!input.vaultReference?.trim()) {
      throw new DomainError(
        'VAULT_REFERENCE_REQUIRED',
        'A credential is registered by its vault reference. This platform never holds the value — there is no field it ' +
          'could go in — so a credential with no reference to where it actually lives records nothing transferable.',
      );
    }
  } else if (input.vaultReference?.trim()) {
    throw new DomainError(
      'VAULT_REFERENCE_UNEXPECTED',
      `A ${input.kind.toLowerCase().replace('_', ' ')} is a physical item and does not live in a secret store. If this is ` +
        'a credential, register it as one.',
    );
  }

  if (!input.storageLocation.trim() || !input.condition.trim()) {
    throw new DomainError(
      'LOCATION_REQUIRED',
      'Record where it is and what condition it is in. Both are what the recipient checks it against.',
    );
  }

  const itemId = ulid();
  const shortBy = Math.max(0, input.quantityRequired - input.quantityHeld);

  write(ctx, {
    eventType: 'TRANSFER_ITEM_REGISTERED',
    entity: { refType: 'TransferItem', refId: itemId },
    nextState: {
      itemId,
      projectId: ctx.projectId,
      reference: input.reference,
      kind: input.kind,
      description: input.description,
      quantityRequired: input.quantityRequired,
      quantityHeld: input.quantityHeld,
      condition: input.condition,
      storageLocation: input.storageLocation,
      critical: input.critical,
      transferOwner: input.transferOwner,
      vaultReference: input.vaultReference,
      status: 'REGISTERED',
      registeredBy: ctx.auth.actorId,
      registeredAt: new Date().toISOString(),
    },
  });

  return { itemId, shortBy };
}

/**
 * Transfer a physical item, with both parties named and a receipt.
 *
 * A shortage is recorded as part of the same act rather than left to be noticed:
 * the moment the recipient counts what arrived is the only moment anybody is
 * looking.
 */
export function acceptTransfer(
  ctx: EngineContext,
  itemId: string,
  input: {
    quantityReceived: number;
    condition: string;
    sender: string;
    recipient: string;
    location: string;
    receiptReference: string;
    /** The hash of the signed receipt itself. Retained, not merely cited. */
    receiptHash: string;
    shortage?: { owner: string; by: string; note: string };
  },
): { reference: string; shortBy: number } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireItem(ctx, itemId);
  const state = record.state as unknown as TransferItemState;

  if (SECRET_KINDS.has(state.kind)) {
    throw new DomainError(
      'CREDENTIAL_NOT_PHYSICAL',
      `${state.reference} is a credential. It transfers through the secret mechanism and is confirmed, not handed over ` +
        'across a table.',
    );
  }
  if (state.transfer) throw new DomainError('ALREADY_TRANSFERRED', `${state.reference} has already been transferred.`);

  if (!input.sender.trim() || !input.recipient.trim()) {
    throw new DomainError(
      'PARTIES_REQUIRED',
      'Name both the sender and the recipient. An inventory transfer signed by one side is a note somebody wrote.',
    );
  }
  if (input.sender === input.recipient) {
    throw new DomainError('PARTIES_REQUIRED', 'The sender and the recipient are two people.');
  }
  if (!input.receiptReference.trim() || !input.receiptHash.trim()) {
    throw new DomainError(
      'RECEIPT_REQUIRED',
      'Retain the signed receipt, not a reference to one. It is what either party produces six months later when the ' +
        'tools are not where they should be, and a citation of a document nobody kept produces nothing.',
    );
  }
  if (!input.location.trim() || !input.condition.trim()) {
    throw new DomainError('LOCATION_REQUIRED', 'Record where it went and what condition it arrived in.');
  }
  if (input.quantityReceived < 0) throw new DomainError('QUANTITY_REQUIRED', 'A received quantity is not negative.');

  const shortBy = Math.max(0, state.quantityRequired - input.quantityReceived);
  if (shortBy > 0 && !input.shortage) {
    throw new DomainError(
      'SHORTAGE_UNOWNED',
      `${input.quantityReceived} of ${state.quantityRequired} received, and nothing says what happens to the other ` +
        `${shortBy}. The moment the recipient counts what arrived is the only moment anybody is looking, so a shortage ` +
        'carries an owner and a date from here rather than being noticed in a fortnight.',
    );
  }
  if (input.shortage && (!input.shortage.owner.trim() || Number.isNaN(Date.parse(input.shortage.by)))) {
    throw new DomainError('SHORTAGE_UNOWNED', 'A shortage carries an owner and the date it is made good by.');
  }

  const transferredAt = new Date().toISOString();
  const transfer = {
    quantityReceived: input.quantityReceived,
    condition: input.condition,
    sender: input.sender,
    recipient: input.recipient,
    location: input.location,
    receiptReference: input.receiptReference,
    transferredAt,
  };

  const evidence = registerEvidence(ctx, {
    type: 'TRANSFER_RECEIPT',
    hash: input.receiptHash,
    description: `${input.receiptReference} — ${state.reference} from ${input.sender} to ${input.recipient}`,
    linkedEntities: [{ refType: 'TransferItem', refId: itemId }],
  });

  // Two events for two facts. The transfer happened; separately, some of it did
  // not arrive, and that second fact is the one anybody has to act on.
  write(ctx, {
    eventType: state.kind === 'KEY' || state.kind === 'ACCESS_CARD' ? 'KEYS_TRANSFERRED' : 'SPARES_ACCEPTED',
    entity: { refType: 'TransferItem', refId: itemId },
    nextState: { ...record.state, status: shortBy > 0 ? 'SHORT' : 'TRANSFERRED', transfer },
    evidenceRefs: [evidence],
  });

  if (shortBy > 0) {
    const after = requireItem(ctx, itemId);
    write(ctx, {
      eventType: 'TRANSFER_SHORTAGE_RECORDED',
      entity: { refType: 'TransferItem', refId: itemId },
      nextState: {
        ...after.state,
        shortage: {
          shortBy,
          owner: input.shortage!.owner,
          by: input.shortage!.by,
          note: input.shortage!.note,
          recordedAt: transferredAt,
        },
      },
    });
  }

  return { reference: state.reference, shortBy };
}

/**
 * Confirm that a credential moved through the approved mechanism.
 *
 * Status metadata only. The vault reference identifies where the secret lives;
 * the mechanism names how it travelled. Neither is the secret, and this platform
 * has no way to become one.
 */
export function confirmCredentialTransfer(
  ctx: EngineContext,
  itemId: string,
  input: { mechanism: string; confirmedBy: string },
): { reference: string; vaultReference: string } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireItem(ctx, itemId);
  const state = record.state as unknown as TransferItemState;

  if (!SECRET_KINDS.has(state.kind)) {
    throw new DomainError(
      'NOT_A_CREDENTIAL',
      `${state.reference} is a physical item and is handed over, not confirmed through a secret mechanism.`,
    );
  }
  if (state.credentialTransfer) {
    throw new DomainError('ALREADY_CONFIRMED', `${state.reference} has already been confirmed.`);
  }
  if (input.mechanism.trim().length < 10) {
    throw new DomainError(
      'MECHANISM_REQUIRED',
      'Name the mechanism the credential travelled by. "Sent it over" covers an approved secret store and an email, and ' +
        'the difference is the whole control.',
    );
  }
  if (!input.confirmedBy.trim()) throw new DomainError('CONFIRMATION_UNSIGNED', 'Name who confirmed receipt.');

  write(ctx, {
    eventType: 'CREDENTIAL_TRANSFER_CONFIRMED',
    entity: { refType: 'TransferItem', refId: itemId },
    nextState: {
      ...record.state,
      status: 'TRANSFERRED',
      credentialTransfer: {
        vaultReference: state.vaultReference!,
        mechanism: input.mechanism,
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date().toISOString(),
      },
    },
  });

  return { reference: state.reference, vaultReference: state.vaultReference! };
}

/**
 * Report a key or card that cannot be accounted for.
 *
 * Separate from a shortage deliberately. A spare that never arrived is a
 * commercial problem; a key that was issued and is missing is a building
 * somebody may be able to get into.
 */
export function reportLostItem(
  ctx: EngineContext,
  itemId: string,
  input: { what: string; reportedBy: string },
): { reference: string; securityIncident: true } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireItem(ctx, itemId);
  const state = record.state as unknown as TransferItemState;

  if (input.what.trim().length < 10) {
    throw new DomainError(
      'LOSS_UNDESCRIBED',
      'Say what is missing and what is known about it. A lost key recorded as "lost" cannot be acted on by security.',
    );
  }
  if (!input.reportedBy.trim()) throw new DomainError('REPORT_UNSIGNED', 'Name who reported it.');

  write(ctx, {
    eventType: 'TRANSFER_ITEM_LOST',
    entity: { refType: 'TransferItem', refId: itemId },
    nextState: {
      ...record.state,
      status: 'LOST',
      loss: { what: input.what, reportedBy: input.reportedBy, reportedAt: new Date().toISOString() },
    },
  });

  return { reference: state.reference, securityIncident: true };
}

// --- Service contacts -------------------------------------------------------

export function registerServiceContact(
  ctx: EngineContext,
  input: {
    system: string;
    provider: string;
    contractReference: string;
    contact: string;
    telephone: string;
    responseTime: string;
    escalation: string;
    coverUntil: string;
  },
): { contactId: string } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.provider.trim() || !input.contact.trim() || !input.telephone.trim()) {
    throw new DomainError(
      'CONTACT_REQUIRED',
      'A service contact names the provider, a person and a number. "Contact the supplier" is what an O&M says when ' +
        'nobody asked the supplier.',
    );
  }
  if (!input.responseTime.trim() || input.escalation.trim().length < 10) {
    throw new DomainError(
      'ESCALATION_REQUIRED',
      'State the response time and what happens when nobody answers. The escalation route is the part that matters at ' +
        'two in the morning.',
    );
  }
  if (Number.isNaN(Date.parse(input.coverUntil))) {
    throw new DomainError('COVER_REQUIRED', 'Say how long the cover runs. One with no end date is assumed to be for ever.');
  }

  const contactId = ulid();

  write(ctx, {
    eventType: 'SERVICE_CONTACT_REGISTERED',
    entity: { refType: 'ServiceContact', refId: contactId },
    nextState: {
      contactId,
      projectId: ctx.projectId,
      ...input,
      registeredBy: ctx.auth.actorId,
      registeredAt: new Date().toISOString(),
    },
  });

  return { contactId };
}

/**
 * Why the transfer blocks the handover, or null.
 *
 * Binds only where the project runs a transfer inventory at all.
 */
export function transferBlockedReason(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): string | null {
  const all = items(ctx);
  if (all.length === 0) return null;

  const lost = all.filter((item) => item.status === 'LOST');
  if (lost.length > 0) {
    return (
      `${lost.map((item) => item.reference).join(', ')} reported lost or unaccounted for. A key that was issued and ` +
      'cannot be found is a building somebody may be able to get into, not a line on an inventory.'
    );
  }

  const criticalShort = all.filter(
    (item) => item.critical && (item.status === 'SHORT' || (item.status === 'REGISTERED' && item.quantityHeld < item.quantityRequired)),
  );
  if (criticalShort.length > 0) {
    return (
      `${criticalShort.map((item) => item.reference).join(', ')} ${criticalShort.length === 1 ? 'is' : 'are'} short and ` +
      'the operator cannot run the building without them.'
    );
  }

  const overdue = all.filter((item) => item.shortage && item.shortage.by.slice(0, 10) < today);
  if (overdue.length > 0) {
    return (
      `${overdue.map((item) => item.reference).join(', ')} short and past the date ${overdue[0]!.shortage!.owner} was to ` +
      'make it good by.'
    );
  }

  const untransferred = all.filter((item) => item.critical && item.status === 'REGISTERED');
  if (untransferred.length > 0) {
    return `${untransferred.map((item) => item.reference).join(', ')} registered and never transferred.`;
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type TransferPosition = {
  items: Array<{
    reference: string;
    kind: TransferItemKind;
    description: string;
    critical: boolean;
    quantityRequired: number;
    quantityReceived?: number;
    status: string;
    /** Present only for a credential, and only ever the vault identifier. */
    vaultReference?: string;
    shortBy?: number;
    shortageOwner?: string;
  }>;
  shortages: Array<{ reference: string; shortBy: number; owner: string; by: string; overdue: boolean }>;
  lost: Array<{ reference: string; what: string; reportedBy: string }>;
  serviceContacts: Array<{ system: string; provider: string; contact: string; responseTime: string; coverUntil: string }>;
  blockedReason: string | null;
  summary: string;
};

export function transferPosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): TransferPosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const all = items(ctx);

  const shortages = all
    .filter((item) => item.shortage)
    .map((item) => ({
      reference: item.reference,
      shortBy: item.shortage!.shortBy,
      owner: item.shortage!.owner,
      by: item.shortage!.by,
      overdue: item.shortage!.by.slice(0, 10) < today,
    }));

  const serviceContacts = ctx.ledger.list(ctx.projectId, 'ServiceContact').map((record) => ({
    system: String(record.state.system),
    provider: String(record.state.provider),
    contact: String(record.state.contact),
    responseTime: String(record.state.responseTime),
    coverUntil: String(record.state.coverUntil),
  }));

  const parts = [`${all.length} transfer item${all.length === 1 ? '' : 's'}`];
  const transferred = all.filter((item) => item.status === 'TRANSFERRED').length;
  parts.push(`${transferred} transferred`);
  if (shortages.length > 0) parts.push(`${shortages.length} short`);
  const lost = all.filter((item) => item.status === 'LOST');
  if (lost.length > 0) parts.push(`${lost.length} lost or unaccounted for`);
  if (serviceContacts.length > 0) parts.push(`${serviceContacts.length} service contact registered`);

  return {
    items: all.map((item) => ({
      reference: item.reference,
      kind: item.kind,
      description: item.description,
      critical: item.critical,
      quantityRequired: item.quantityRequired,
      quantityReceived: item.transfer?.quantityReceived,
      status: item.status,
      vaultReference: item.vaultReference,
      shortBy: item.shortage?.shortBy,
      shortageOwner: item.shortage?.owner,
    })),
    shortages,
    lost: lost.map((item) => ({ reference: item.reference, what: item.loss!.what, reportedBy: item.loss!.reportedBy })),
    serviceContacts,
    blockedReason: transferBlockedReason(ctx, today),
    summary: parts.join(', ') + '.',
  };
}
