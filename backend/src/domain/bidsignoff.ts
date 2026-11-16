import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { Signatory } from '../group/profile.ts';
import type { BidResponsePack } from './bidresponse.ts';
import type { TenderDeliverable } from './tenderintake.ts';
import { projectTender } from './tenderregister.ts';
import type { ContractObligation } from './tenderreview.ts';

/**
 * One sign-off record for a bid, and where each file goes on the buyer's portal.
 *
 * The approvals a submission needs — the price, the programme, the contract and
 * the signatory — are taken here, on one record per tender, each by somebody
 * with the authority for it, each holding a snapshot of exactly what was
 * approved. When the thing approved changes afterwards (the price is re-run, the
 * programme replaced, a clause added, an answer rewritten), the approval is
 * **stale**: it stays on the record, and the brief asks for it again.
 *
 * The buyer's portal is not something the platform can see. So the record of
 * where each return goes on it — the section or upload slot, the file name, the
 * version — and the confirmation that it was uploaded and checked there, are a
 * person's, entered here and shown on the manifest. Nothing is uploaded or
 * submitted by the platform.
 */

export const SIGN_OFF_AREAS = ['COMMERCIAL', 'PROGRAMME', 'CONTRACT', 'SIGNATORY'] as const;
export type SignOffArea = (typeof SIGN_OFF_AREAS)[number];

type Snapshot = Record<string, string | number>;

export type ApprovalEntry = {
  area: SignOffArea;
  approvedBy: string;
  /** The signatory's title, for a signatory approval. */
  title?: string;
  approvedAt: string;
  note: string;
  /** What was approved, so a later change shows the approval as stale. */
  snapshot: Snapshot;
};

export type PortalFile = {
  reference: string;
  portalLocation: string;
  fileName?: string;
  version?: string;
  recordedBy: string;
  recordedAt: string;
  /** A person confirmed it was uploaded and checked on the portal. */
  uploaded?: { by: string; at: string; note: string };
};

type SignOffState = {
  id: string;
  invitationId: string;
  approvals: ApprovalEntry[];
  files: Record<string, PortalFile>;
};

export type SignOffPosition = {
  invitationId?: string;
  approvals: Array<{ area: SignOffArea; status: 'CURRENT' | 'STALE' | 'NONE'; latest?: ApprovalEntry; detail: string }>;
  files: Record<string, PortalFile>;
  /** The returns the invitation lists, to record a portal location against. */
  returns: Array<{ reference: string; title: string }>;
};

const refFor = (invitationId: string) => ({ refType: 'BidSignOff', refId: `${invitationId}-signoff` });

function requireTender(ctx: EngineContext): { invitationId: string; invitation: Record<string, unknown> } {
  const { invitation } = projectTender(ctx);
  if (!invitation) {
    throw new DomainError('NO_TENDER', 'There is no tender recorded on this project to sign off.', 409);
  }
  return { invitationId: String(invitation.id), invitation };
}

function current(ctx: EngineContext, invitationId: string): SignOffState {
  const record = ctx.ledger.get(refFor(invitationId));
  return record && record.tenantId === ctx.tenantId
    ? (record.state as unknown as SignOffState)
    : { id: refFor(invitationId).refId, invitationId, approvals: [], files: {} };
}

/** What each area approves, as it stands now — or why there is nothing to approve. */
function snapshotOf(ctx: EngineContext, area: SignOffArea): { snapshot?: Snapshot; missing?: string } {
  if (area === 'COMMERCIAL') {
    const estimate = ctx.ledger.list(ctx.projectId, 'Estimate').map((record) => record.state).at(-1);
    if (!estimate) return { missing: 'The job has not been priced.' };
    return { snapshot: { estimateId: String(estimate.id), totalMinor: Number(estimate.totalMinor ?? 0) } };
  }
  if (area === 'PROGRAMME') {
    const programme = ctx.ledger
      .list(ctx.projectId, 'TenderProgrammeDraft')
      .map((record) => record.state)
      .filter((state) => state.status === 'CONFIRMED')
      .at(-1);
    if (!programme) return { missing: 'No tender programme has been confirmed.' };
    const forecast = programme.forecast as { finishDate?: string } | undefined;
    return { snapshot: { programmeId: String(programme.id), startDate: String(programme.startDate ?? ''), finishDate: String(forecast?.finishDate ?? '') } };
  }
  if (area === 'CONTRACT') {
    const obligations = ctx.ledger
      .list(ctx.projectId, 'TenderReview')
      .flatMap((record) => (record.state.obligations as ContractObligation[] | undefined) ?? []);
    if (obligations.length === 0) return { missing: 'No clause is on the tender review.' };
    const unsigned = obligations.filter((obligation) => obligation.status === 'DRAFT').length;
    if (unsigned > 0) return { missing: `${unsigned} clause(s) on the tender review are not yet signed off; sign them first.` };
    return { snapshot: { clauses: obligations.length, rejected: obligations.filter((obligation) => obligation.status === 'REJECTED').length } };
  }
  const pack = ctx.ledger
    .list(ctx.projectId, 'BidResponsePack')
    .map((record) => record.state as unknown as BidResponsePack)
    .at(-1);
  if (!pack) return { missing: 'No response pack has been planned.' };
  const content = hashEvidence(JSON.stringify(pack.sections.map((section) => [section.key, section.status, section.body ?? []])));
  return { snapshot: { packId: pack.id, reference: pack.reference, contentHash: content } };
}

const same = (a: Snapshot, b: Snapshot): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);

export function signOffPosition(ctx: EngineContext): SignOffPosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const { invitation } = projectTender(ctx);
  if (!invitation) {
    return { approvals: SIGN_OFF_AREAS.map((area) => ({ area, status: 'NONE', detail: 'No tender recorded.' })), files: {}, returns: [] };
  }
  const invitationId = String(invitation.id);
  const state = current(ctx, invitationId);
  const approvals = SIGN_OFF_AREAS.map((area) => {
    const latest = state.approvals.filter((entry) => entry.area === area).at(-1);
    if (!latest) return { area, status: 'NONE' as const, detail: 'Not yet approved.' };
    const now = snapshotOf(ctx, area);
    const stale = !now.snapshot || !same(latest.snapshot, now.snapshot);
    return {
      area,
      status: stale ? ('STALE' as const) : ('CURRENT' as const),
      latest,
      detail: stale
        ? `Approved ${latest.approvedAt.slice(0, 10)}, but what was approved has changed since${now.missing ? `: ${now.missing}` : ''}. Approve it again.`
        : `Approved ${latest.approvedAt.slice(0, 10)}${latest.title ? ` by the ${latest.title}` : ''}.`,
    };
  });
  return {
    invitationId,
    approvals,
    files: state.files,
    returns: ((invitation.deliverables as TenderDeliverable[] | undefined) ?? []).map((entry) => ({ reference: entry.reference, title: entry.title })),
  };
}

/**
 * Who approves each area. The price and the submission carry the commercial
 * sensitivity of the bid; the programme and the contract are approved by the
 * people with that authority, who see dates and clause counts here, not prices.
 */
const AUTHORITY: Record<SignOffArea, { area: 'ESTIMATE_TENDER' | 'WORKPACKAGES_TASKS' | 'CONTRACTS_CLAIMS'; commercial: boolean }> = {
  COMMERCIAL: { area: 'ESTIMATE_TENDER', commercial: true },
  PROGRAMME: { area: 'WORKPACKAGES_TASKS', commercial: false },
  CONTRACT: { area: 'CONTRACTS_CLAIMS', commercial: false },
  SIGNATORY: { area: 'ESTIMATE_TENDER', commercial: true },
};

/** An approval on the one record: by somebody with the authority, of exactly what stands now. */
export function approve(ctx: EngineContext, input: { area: SignOffArea; note: string }): ApprovalEntry {
  if (!SIGN_OFF_AREAS.includes(input.area)) {
    throw new DomainError('SIGN_OFF_AREA_INVALID', `An approval is one of ${SIGN_OFF_AREAS.join(', ')}.`, 422, [{ field: 'area', message: 'choose one' }]);
  }
  authorise(ctx, AUTHORITY[input.area].area, 'A', AUTHORITY[input.area].commercial ? { dataSensitivity: 'COMMERCIAL_L3' } : {});
  const { invitationId } = requireTender(ctx);
  const note = input.note.trim();
  if (note.length < 5) {
    throw new DomainError('SIGN_OFF_NOTE_REQUIRED', 'Say what was checked before approving, so the record shows it.', 422, [{ field: 'note', message: 'what was checked' }]);
  }
  let title: string | undefined;
  if (input.area === 'SIGNATORY') {
    const signatories = ((ctx.ledger.get({ refType: 'IssuerProfile', refId: ctx.tenantId })?.state.signatories as Signatory[] | undefined) ?? []);
    // A tender is an offer to contract: it is signed by someone who signs the
    // company's quotations or contracts.
    const signatory = signatories.find(
      (entry) => entry.userId === ctx.auth.actorId && entry.documents.some((type) => type === 'quotation' || type === 'contract'),
    );
    if (!signatory) {
      throw new DomainError(
        'NOT_A_SIGNATORY',
        'Only a person named as a signatory for the company’s quotations or contracts approves the submission. Signatories are set on Documents, in the issuer details.',
        403,
      );
    }
    title = signatory.title;
  }
  const now = snapshotOf(ctx, input.area);
  if (!now.snapshot) throw new DomainError('NOTHING_TO_APPROVE', now.missing ?? 'There is nothing to approve yet.', 409);
  const state = current(ctx, invitationId);
  const entry: ApprovalEntry = {
    area: input.area,
    approvedBy: ctx.auth.actorId,
    ...(title ? { title } : {}),
    approvedAt: new Date().toISOString(),
    note,
    snapshot: now.snapshot,
  };
  write(ctx, {
    eventType: 'BID_SIGN_OFF_RECORDED',
    entity: refFor(invitationId),
    nextState: { ...state, approvals: [...state.approvals, entry] },
    reason: `${input.area.toLowerCase()} approved: ${note}`,
  });
  return entry;
}

function requireReturn(invitation: Record<string, unknown>, reference: string): void {
  const returns = (invitation.deliverables as TenderDeliverable[] | undefined) ?? [];
  if (!returns.some((entry) => entry.reference === reference)) {
    throw new DomainError('RETURN_NOT_FOUND', `${reference} is not a return the invitation lists.`, 404, [{ field: 'reference', message: 'choose a return' }]);
  }
}

/** Where a return goes on the buyer's portal, as the person who knows the portal records it. */
export function recordPortalFile(
  ctx: EngineContext,
  input: { reference: string; portalLocation: string; fileName?: string; version?: string },
): PortalFile {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });
  const { invitationId, invitation } = requireTender(ctx);
  requireReturn(invitation, input.reference);
  const location = input.portalLocation.trim();
  if (location.length < 3) {
    throw new DomainError('PORTAL_LOCATION_REQUIRED', 'Say where on the portal it goes — the section, envelope or upload slot.', 422, [
      { field: 'portalLocation', message: 'where it goes' },
    ]);
  }
  const state = current(ctx, invitationId);
  const file: PortalFile = {
    reference: input.reference,
    portalLocation: location,
    ...(input.fileName?.trim() ? { fileName: input.fileName.trim() } : {}),
    ...(input.version?.trim() ? { version: input.version.trim() } : {}),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SUBMISSION_FILE_RECORDED',
    entity: refFor(invitationId),
    nextState: { ...state, files: { ...state.files, [input.reference]: file } },
    reason: `${input.reference} goes to ${location}`,
  });
  return file;
}

/** A person's confirmation that the return was uploaded and checked on the portal — the portal-only check. */
export function confirmPortalUpload(ctx: EngineContext, input: { reference: string; note: string }): PortalFile {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });
  const { invitationId, invitation } = requireTender(ctx);
  requireReturn(invitation, input.reference);
  const state = current(ctx, invitationId);
  const file = state.files[input.reference];
  if (!file) {
    throw new DomainError('PORTAL_LOCATION_FIRST', `Record where ${input.reference} goes on the portal before confirming it is there.`, 409);
  }
  const note = input.note.trim();
  if (note.length < 5) {
    throw new DomainError('UPLOAD_NOTE_REQUIRED', 'Say what was checked on the portal — the file opened, the name, the size accepted.', 422, [
      { field: 'note', message: 'what was checked' },
    ]);
  }
  const next: PortalFile = { ...file, uploaded: { by: ctx.auth.actorId, at: new Date().toISOString(), note } };
  write(ctx, {
    eventType: 'SUBMISSION_FILE_RECORDED',
    entity: refFor(invitationId),
    nextState: { ...state, files: { ...state.files, [input.reference]: next } },
    reason: `${input.reference} confirmed on the portal: ${note}`,
  });
  return next;
}
