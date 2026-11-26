import { canonicalize, sha256 } from '../../core/canonical.ts';
import { DomainError } from '../../core/errors.ts';
import { write, type EngineContext } from '../../engines/context.ts';
import { createContract, executeContract, type ContractSuite } from '../../engines/claims.ts';
import { formByKey } from './catalogue.ts';
import { draftOf, guard, scheduleOf, valuesOf, type ApprovalScope, type ContractDraft, type Review } from './drafts.ts';
import { findings } from './schedules.ts';

/**
 * From a completed draft to a signed contract.
 *
 * **Review.** A draft is put up for review only with nothing blocking it, and
 * what is reviewed is fixed by a hash of exactly that revision — the form, the
 * schedule, the currency and every particular with its source. An approval
 * names that hash; once the draft changes, the hash does not match and the
 * approval is for something that no longer exists.
 *
 * **Two people, neither the one who put it up.** The commercial approval is
 * always needed. A legal approval is needed as well where the standard form is
 * amended, where the law of the contract is not one of the UK's, or where the
 * form is a consumer's (a homeowner's statutory protections are a legal
 * question). The two are different people, and neither submitted the draft.
 *
 * **Reopening voids.** An approved draft changes only by being reopened, which
 * ends its review and keeps it on the record as voided; the next approval is of
 * the next revision.
 *
 * **Execution is evidence, never inferred.** Exporting the pack signs nothing.
 * The signed instrument is recorded as itself — by its hash, with how and when
 * it was signed — and only then is the contract created in the register Change
 * & Claims works from, from the approved particulars, and executed there.
 */

const UK_LAW = new Set(['ENGLAND_AND_WALES', 'SCOTLAND', 'NORTHERN_IRELAND']);

const strip = (draft: ContractDraft & { version?: number }): ContractDraft => {
  const { version: _version, ...rest } = draft;
  return rest;
};

/** The hash of exactly what a reviewer approves. */
export function revisionHash(draft: ContractDraft): string {
  return sha256(
    canonicalize({
      formKey: draft.formKey,
      scheduleId: draft.scheduleId,
      currency: draft.currency,
      revision: draft.revision,
      fields: Object.fromEntries(Object.entries(draft.fields).map(([key, entry]) => [key, { value: entry.value, source: entry.source }])),
    }),
  );
}

/** Whether, and why, the draft needs a legal approval as well as a commercial one. */
export function legalReview(draft: ContractDraft): string[] {
  const values = valuesOf(draft);
  const reasons: string[] = [];
  if (values.z_clauses_reference) reasons.push('The NEC form is amended by Z clauses.');
  if (values.special_provisions_reference) reasons.push('The FIDIC general conditions are amended by particular conditions.');
  if (values.governing_law && scheduleOf(draft).fields.find((field) => field.key === 'governing_law')?.type === 'CHOICE' && !UK_LAW.has(values.governing_law)) {
    reasons.push('The law of the contract is not one of the UK’s.');
  }
  if (draft.scheduleId === 'fidic-yellow-2017r2022-v1' && values.governing_law) reasons.push('A FIDIC contract’s governing law, dispute board and place of work are confirmed by the legal reviewer.');
  if (formByKey(draft.formKey)?.type === 'consumer') reasons.push('A homeowner contract: the consumer’s statutory protections are a legal question.');
  return reasons;
}

function record(ctx: EngineContext, draft: ContractDraft, next: ContractDraft, event: { eventType: string; reason: string }): ContractDraft {
  write(ctx, { eventType: event.eventType, entity: { refType: 'ContractDraft', refId: draft.id }, nextState: next as unknown as Record<string, unknown>, reason: event.reason });
  return next;
}

const noteOf = (value: unknown, min: number, what: string): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw new DomainError('CONTRACT_FIELD_REQUIRED', what, 422, [{ field: 'note', message: what }]);
  return text.slice(0, 1000);
};

export function submitForReview(ctx: EngineContext, id: string, input: { expectedRevision: number }): ContractDraft {
  guard(ctx, 'U');
  const draft = draftOf(ctx, id);
  if (draft.status !== 'DRAFTING') throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is ${draft.status.toLowerCase()}.`, 409);
  if (input.expectedRevision !== draft.revision) throw new DomainError('CONTRACT_DRAFT_STALE', `${draft.reference} has moved on to revision ${draft.revision}; check it again before putting it up.`, 412);
  const blocking = findings(scheduleOf(draft), valuesOf(draft)).filter((finding) => finding.severity === 'BLOCKING');
  if (blocking.length) {
    throw new DomainError('CONTRACT_DRAFT_BLOCKED', `${draft.reference} cannot go to review: ${blocking.map((finding) => finding.message).join(' ')}`, 409);
  }
  const reasons = legalReview(draft);
  const review: Review = {
    revision: draft.revision,
    hash: revisionHash(draft),
    submittedBy: ctx.auth.actorId,
    submittedAt: new Date().toISOString(),
    legalRequired: reasons.length > 0,
    legalReasons: reasons,
    approvals: [],
  };
  return record(ctx, draft, { ...strip(draft), status: 'IN_REVIEW', review }, { eventType: 'CONTRACT_DRAFT_SUBMITTED', reason: `${draft.reference} revision ${draft.revision} put up for review${reasons.length ? '; legal review needed' : ''}` });
}

/**
 * One approval, of one scope, against the hash the approver was shown.
 *
 * `brandVersion` is the company document identity in force now; the last
 * approval freezes it, and the pack is issued under it.
 */
export function approveDraft(ctx: EngineContext, id: string, input: { scope: ApprovalScope; revisionHash: string; note: string }, brandVersion: number | null): ContractDraft {
  guard(ctx, 'A');
  const draft = draftOf(ctx, id);
  if (draft.status !== 'IN_REVIEW' || !draft.review) throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is not in review.`, 409);
  const review = draft.review;
  if (input.revisionHash !== review.hash) {
    throw new DomainError('CONTRACT_APPROVAL_STALE', `What you were shown is not revision ${review.revision} of ${draft.reference} as it stands. Reload it and read it again.`, 412);
  }
  if (input.scope !== 'COMMERCIAL' && input.scope !== 'LEGAL') throw new DomainError('CONTRACT_APPROVAL_SCOPE', 'An approval is commercial or legal.', 422);
  if (input.scope === 'LEGAL' && !review.legalRequired) throw new DomainError('CONTRACT_LEGAL_NOT_REQUIRED', `${draft.reference} does not need a legal approval: nothing in it is amended, foreign or a consumer’s.`, 409);
  if (ctx.auth.actorId === review.submittedBy) throw new DomainError('CONTRACT_APPROVAL_SAME_PERSON', 'The person who put the draft up for review does not approve it.', 403);
  if (review.approvals.some((approval) => approval.scope === input.scope)) throw new DomainError('CONTRACT_APPROVAL_DONE', `The ${input.scope.toLowerCase()} approval is already given.`, 409);
  if (review.approvals.some((approval) => approval.by === ctx.auth.actorId)) {
    throw new DomainError('CONTRACT_APPROVAL_SAME_PERSON', 'The commercial and legal approvals are given by two different people.', 403);
  }
  const approvals = [...review.approvals, { scope: input.scope, by: ctx.auth.actorId, at: new Date().toISOString(), note: noteOf(input.note, 3, 'Say what you checked.') }];
  const complete = approvals.some((approval) => approval.scope === 'COMMERCIAL') && (!review.legalRequired || approvals.some((approval) => approval.scope === 'LEGAL'));
  const next: ContractDraft = {
    ...strip(draft),
    status: complete ? 'APPROVED' : 'IN_REVIEW',
    review: { ...review, approvals, ...(complete ? { approvedAt: new Date().toISOString(), brandVersion } : {}) },
  };
  return record(ctx, draft, next, { eventType: 'CONTRACT_DRAFT_APPROVED', reason: `${draft.reference} revision ${review.revision}: ${input.scope.toLowerCase()} approval${complete ? '; approved for issue' : ''}` });
}

/** Back to drafting from review, with what needs to change. */
export function returnDraft(ctx: EngineContext, id: string, input: { note: string }): ContractDraft {
  guard(ctx, 'A');
  const draft = draftOf(ctx, id);
  if (draft.status !== 'IN_REVIEW' || !draft.review) throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is not in review.`, 409);
  const note = noteOf(input.note, 5, 'Say what needs to change.');
  const { review: _review, ...rest } = strip(draft);
  const next: ContractDraft = { ...rest, status: 'DRAFTING', pastReviews: [...(draft.pastReviews ?? []), { ...draft.review, ended: { how: 'RETURNED', by: ctx.auth.actorId, at: new Date().toISOString(), note } }] };
  return record(ctx, draft, next, { eventType: 'CONTRACT_DRAFT_RETURNED', reason: `${draft.reference} returned: ${note}` });
}

/** An approved draft reopened for a change. Its approvals are voided, and kept on the record as voided. */
export function reopenDraft(ctx: EngineContext, id: string, input: { reason: string }): ContractDraft {
  guard(ctx, 'U');
  const draft = draftOf(ctx, id);
  if (draft.status !== 'APPROVED' || !draft.review) throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is not approved.`, 409);
  const note = noteOf(input.reason, 5, 'Say what is to change.');
  const { review: _review, ...rest } = strip(draft);
  const next: ContractDraft = { ...rest, status: 'DRAFTING', pastReviews: [...(draft.pastReviews ?? []), { ...draft.review, ended: { how: 'REOPENED', by: ctx.auth.actorId, at: new Date().toISOString(), note } }] };
  return record(ctx, draft, next, { eventType: 'CONTRACT_DRAFT_REOPENED', reason: `${draft.reference} reopened; its approvals are void: ${note}` });
}

// =============================================================================
// Execution: the signed instrument, and the contract register
// =============================================================================

const SUITE: Record<string, ContractSuite> = { JCT: 'JCT', FIDIC: 'FIDIC', IChemE: 'ICHEME' };

const months = (duration: string | undefined): number | undefined => {
  if (!duration) return undefined;
  const [n, unit] = duration.split(' ');
  const value = Number(n);
  return unit === 'MONTHS' ? value : unit === 'YEARS' ? value * 12 : unit === 'WEEKS' ? Math.round((value * 12) / 52) : Math.round(value / 30);
};

const addDuration = (iso: string, duration: string): string => {
  const [n, unit] = duration.split(' ');
  const date = new Date(`${iso}T00:00:00Z`);
  const value = Number(n);
  if (unit === 'DAYS') date.setUTCDate(date.getUTCDate() + value);
  else if (unit === 'WEEKS') date.setUTCDate(date.getUTCDate() + value * 7);
  else if (unit === 'MONTHS') date.setUTCMonth(date.getUTCMonth() + value);
  else date.setUTCFullYear(date.getUTCFullYear() + value);
  return date.toISOString().slice(0, 10);
};

const slug = (text: string): string => text.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** The approved particulars as the contract register holds a contract, or what is missing to do so. */
export function contractTerms(draft: ContractDraft): { terms?: Parameters<typeof createContract>[1]; missing: string[] } {
  const v = valuesOf(draft);
  const missing: string[] = [];
  const employer = v.employer_legal_name ?? v.client_legal_name;
  const contractor = v.contractor_legal_name;
  const sum = v.contract_sum ?? v.accepted_contract_amount;
  const start = v.start_date ?? v.possession_date ?? v.starting_date ?? v.commencement_date;
  const completion = v.completion_date ?? (start && v.time_for_completion ? addDuration(start, v.time_for_completion) : undefined);
  if (!employer) missing.push('the employer or client’s legal name');
  if (!contractor) missing.push('the contractor’s legal name');
  if (!sum) missing.push('the contract sum');
  if (!start) missing.push('the start, possession or commencement date');
  if (!completion) missing.push('the completion date');
  if (missing.length) return { missing };
  const damages = v.delay_damages ?? v.liquidated_damages;
  const per = v.delay_damages_per ?? v.liquidated_damages_per;
  const damagesMinor = damages ? Math.round(Number(damages) * 100) : 0;
  const publisher = draft.form.publisher;
  const suite: ContractSuite = publisher === 'NEC' ? (draft.form.edition.startsWith('NEC4') ? 'NEC4' : 'BESPOKE') : (SUITE[publisher] ?? 'BESPOKE');
  return {
    missing,
    terms: {
      suite,
      form: `${draft.form.publisher} ${draft.form.code} ${draft.form.title} (${draft.form.edition})`,
      parties: [
        { role: publisher === 'NEC' ? 'CLIENT' : 'EMPLOYER', partyId: `${publisher === 'NEC' ? 'CLIENT' : 'EMPLOYER'}-${slug(employer!)}`, name: employer! },
        { role: 'CONTRACTOR', partyId: `CONTRACTOR-${slug(contractor!)}`, name: contractor! },
      ],
      contractSumMinor: Math.round(Number(sum) * 100),
      commencementDate: start!,
      completionDate: completion!,
      liquidatedDamagesPerDayMinor: per === 'WEEK' ? Math.round(damagesMinor / 7) : damagesMinor,
      // Blank is uncapped, which is how the register already reads a zero cap.
      ldCapPercent: v.delay_damages_cap_percent ? Number(v.delay_damages_cap_percent) : 0,
      retentionPercent: v.retention_percent ? Number(v.retention_percent) : 0,
      defectsLiabilityMonths: months(v.defects_period ?? v.rectification_period ?? v.defects_date ?? v.defects_notification_period) ?? 0,
    },
  };
}

/**
 * The executed package: the signed instrument, recorded as itself.
 *
 * Creates the contract in the register from the approved particulars and
 * executes it there — the same `CONTRACT_EXECUTED` every other contract on the
 * platform reaches, with the signed document as its evidence — and closes the
 * draft against it. Signing binds the business, so it takes `A` on contracts
 * and the Legal-L4 clearance the register's own execution requires.
 */
export function recordExecution(
  ctx: EngineContext,
  id: string,
  input: { signedDocumentHash: string; signatureMethod: string; executedOn: string },
): ContractDraft {
  guard(ctx, 'A');
  const draft = draftOf(ctx, id);
  if (draft.status !== 'APPROVED' || !draft.review) throw new DomainError('CONTRACT_DRAFT_STATE', `${draft.reference} is executed only once approved; it is ${draft.status.toLowerCase()}.`, 409);
  if (revisionHash(draft) !== draft.review.hash) throw new DomainError('CONTRACT_APPROVAL_STALE', `${draft.reference} no longer matches what was approved.`, 409);
  if (!/^(sha256:)?[a-f0-9]{64}$/i.test(String(input.signedDocumentHash ?? ''))) {
    throw new DomainError('CONTRACT_SIGNED_DOCUMENT', 'Attach the signed contract; it is recorded by its SHA-256.', 422, [{ field: 'signedDocumentHash', message: 'the signed document' }]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.executedOn ?? '') || input.executedOn > new Date().toISOString().slice(0, 10)) {
    throw new DomainError('CONTRACT_EXECUTED_ON', 'The date the parties signed, not in the future.', 422, [{ field: 'executedOn', message: 'a past date' }]);
  }
  const method = noteOf(input.signatureMethod, 3, 'Say how it was signed — wet ink, deed, electronic signature.');
  const { terms, missing } = contractTerms(draft);
  if (!terms) throw new DomainError('CONTRACT_HANDOFF_INCOMPLETE', `The contract register needs ${missing.join(', ')}.`, 409);
  const { contractId } = createContract(ctx, terms);
  executeContract(ctx, { contractId, signedDocumentHash: input.signedDocumentHash, signatureMethod: method, executedOn: input.executedOn });
  const next: ContractDraft = {
    ...strip(draft),
    status: 'EXECUTED',
    executed: { contractId, by: ctx.auth.actorId, at: new Date().toISOString(), executedOn: input.executedOn, signedDocumentHash: input.signedDocumentHash, signatureMethod: method },
  };
  return record(ctx, draft, next, { eventType: 'CONTRACT_DRAFT_EXECUTED', reason: `${draft.reference} executed on ${input.executedOn} (${method}); contract created in the register` });
}
