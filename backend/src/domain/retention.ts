import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';

/**
 * Retention: held on every certificate, and released in two halves.
 *
 * The platform has always *withheld* retention — every payment certificate
 * carries a `retentionMinor` and the commercial position sums it — and there
 * was no way to ever get it back. That is not a rounding gap. Retention is
 * typically 3 to 5% of the contract sum, it is cash the contractor has already
 * earned and funded, and the second half is often years away. For a small
 * business it is frequently the difference between the job having been worth
 * doing and not.
 *
 * ---
 *
 * ## Two halves, and the dates come from the certificate
 *
 * The first half falls due at practical completion, the second when the defects
 * liability period expires. **Neither date is computed here.** The completion
 * certificate already sets both — `RETENTION_FIRST_RELEASE` and
 * `RETENTION_FINAL_RELEASE` — derived from the contract's clause register,
 * each with the clause it came from, and frozen under a hash so a silent edit
 * shows.
 *
 * Re-deriving them from the contract's defects period would have been a second
 * answer to a question the platform already answers, computed from unvalidated
 * data, disagreeing with the certificate the moment a reviewer corrected a
 * clause. This module reads the certificate and does the money.
 *
 * ## What it refuses
 *
 * **Releasing before the trigger.** A release that has not fallen due is either
 * a mistake or a favour, and either way the record has to show which. So the
 * date is checked and the refusal names what is missing.
 *
 * **Releasing more than is held.** The entitlement is the share of what was
 * actually withheld on certificates, not a percentage of the contract sum —
 * those differ whenever the final account differs from the contract, which is
 * most of the time.
 *
 * ## What it is not
 *
 * It is not a payment. Releasing retention says the money has fallen due and
 * records it against the contract; the cash moves through the ordinary payment
 * cycle, which already exists and is not restated here.
 */

export type RetentionTranche = 'PRACTICAL_COMPLETION' | 'DEFECTS_EXPIRY';

/**
 * How the two halves are split.
 *
 * A half each is the overwhelming convention in the standard forms, and it is
 * the split every one of them defaults to. A contract that says otherwise is a
 * bespoke amendment, and this is the shape that would carry it.
 */
export const TRANCHE_SHARE: Record<
  RetentionTranche,
  { sharePercent: number; label: string; trigger: string; triggeredDateKey: string }
> = {
  PRACTICAL_COMPLETION: {
    sharePercent: 50,
    label: 'First half, at practical completion',
    trigger: 'The first half falls due',
    triggeredDateKey: 'RETENTION_FIRST_RELEASE',
  },
  DEFECTS_EXPIRY: {
    sharePercent: 50,
    label: 'Second half, after the defects period',
    trigger: 'The balance falls due',
    triggeredDateKey: 'RETENTION_FINAL_RELEASE',
  },
};

type ReleaseState = {
  id: string;
  contractId: string;
  tranche: RetentionTranche;
  amountMinor: number;
  dueOn: string;
  releasedOn: string;
  reason?: string;
  releasedBy: string;
};

export type TranchePosition = {
  tranche: RetentionTranche;
  label: string;
  sharePercent: number;
  entitlementMinor: number;
  releasedMinor: number;
  outstandingMinor: number;
  /** When it falls due, where that is derivable. */
  dueOn?: string;
  trigger: string;
  /** True where it may be released today. */
  releasable: boolean;
  /** Why not, where it is not. */
  blockedBy?: string;
  /** The clause the certificate derived this date from. */
  ruleSource?: string;
};

export type RetentionPosition = {
  contractId: string;
  /** Withheld on certificates — the real figure, not a percentage of the sum. */
  heldMinor: number;
  releasedMinor: number;
  outstandingMinor: number;
  completionDate?: string;
  defectsExpiresOn?: string;
  tranches: TranchePosition[];
  /** Money that has fallen due and nobody has claimed. */
  overdueMinor: number;
  summary: string;
};

/**
 * What is held, what has been released, and what has fallen due.
 *
 * Derived on every read. A stored position would go on saying what it said
 * after another certificate withheld more.
 */
export function retentionPosition(ctx: EngineContext, contractId: string, asAt?: string): RetentionPosition {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const contract = ctx.ledger.get({ refType: 'Contract', refId: contractId });
  if (!contract || contract.tenantId !== ctx.tenantId) {
    throw new DomainError('CONTRACT_NOT_FOUND', `No contract ${contractId}`, 404);
  }

  // Held is what was actually withheld, certificate by certificate. A
  // percentage of the contract sum is the wrong number the moment the final
  // account differs from the contract, which is most of the time.
  const heldMinor = ctx.ledger
    .list(ctx.projectId, 'PaymentCertificate')
    .reduce((sum, record) => sum + Number(record.state.retentionMinor ?? 0), 0);

  const releases = ctx.ledger
    .list(ctx.projectId, 'RetentionRelease')
    .map((record) => record.state as unknown as ReleaseState)
    .filter((release) => release.contractId === contractId);
  const releasedMinor = releases.reduce((sum, release) => sum + release.amountMinor, 0);

  const certificate = completionCertificate(ctx);
  const today = (asAt ?? new Date().toISOString()).slice(0, 10);

  const tranches: TranchePosition[] = (Object.keys(TRANCHE_SHARE) as RetentionTranche[]).map((tranche) => {
    const share = TRANCHE_SHARE[tranche];
    const entitlement = Math.round((heldMinor * share.sharePercent) / 100);
    const released = releases.filter((release) => release.tranche === tranche).reduce((sum, release) => sum + release.amountMinor, 0);

    const triggered = certificate?.triggeredDates.find((entry) => entry.key === share.triggeredDateKey);
    const dueOn = triggered?.date?.slice(0, 10);
    const blockedBy = !certificate
      ? 'Practical completion has not been certified, so nothing has fallen due yet.'
      : !dueOn
        ? `The completion certificate sets no date for ${share.label.toLowerCase()}. It is on the certificate that the date is agreed, not here.`
        : dueOn <= today
          ? undefined
          : `${share.trigger} on ${dueOn}, under ${triggered?.ruleSource ?? 'the contract'}.`;

    return {
      tranche,
      label: share.label,
      sharePercent: share.sharePercent,
      entitlementMinor: entitlement,
      releasedMinor: released,
      outstandingMinor: Math.max(0, entitlement - released),
      ...(dueOn ? { dueOn } : {}),
      trigger: share.trigger,
      ...(triggered?.ruleSource ? { ruleSource: triggered.ruleSource } : {}),
      releasable: blockedBy === undefined && entitlement - released > 0,
      ...(blockedBy ? { blockedBy } : {}),
    };
  });

  // Fallen due and unclaimed. This is the number the whole module exists for:
  // retention goes unrecovered because nobody was watching a date a year out.
  const overdueMinor = tranches
    .filter((entry) => entry.dueOn !== undefined && entry.dueOn <= today)
    .reduce((sum, entry) => sum + entry.outstandingMinor, 0);

  const outstandingMinor = Math.max(0, heldMinor - releasedMinor);
  const finalDue = tranches.find((entry) => entry.tranche === 'DEFECTS_EXPIRY')?.dueOn;
  return {
    contractId,
    heldMinor,
    releasedMinor,
    outstandingMinor,
    ...(certificate ? { completionDate: certificate.completionDate.slice(0, 10) } : {}),
    ...(finalDue ? { defectsExpiresOn: finalDue } : {}),
    tranches,
    overdueMinor,
    summary: summarise({ heldMinor, outstandingMinor, overdueMinor, completion: certificate?.completionDate, defectsExpiresOn: finalDue }),
  };
}

function summarise(input: {
  heldMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  completion?: string;
  defectsExpiresOn?: string;
}): string {
  if (input.heldMinor === 0) return 'No retention has been withheld on this contract yet.';
  if (input.outstandingMinor === 0) return `All ${money(input.heldMinor)} of retention has been released.`;
  if (input.overdueMinor > 0) {
    return `${money(input.overdueMinor)} of retention has fallen due and is unclaimed. ${money(input.outstandingMinor)} is outstanding in total.`;
  }
  if (!input.completion) {
    return `${money(input.outstandingMinor)} of retention is held. Nothing falls due until practical completion is certified.`;
  }
  return `${money(input.outstandingMinor)} of retention is held; the second half falls due ${input.defectsExpiresOn ?? 'when the defects period expires'}.`;
}

/**
 * Release a tranche of retention.
 *
 * Refuses a release that has not fallen due, and refuses more than is held.
 * Both are the same principle: this record is what the contractor will point at
 * when asked why the money moved, so it has to say a true thing.
 */
export function releaseRetention(
  ctx: EngineContext,
  input: { contractId: string; tranche: RetentionTranche; amountMinor: number; releasedOn: string; reason?: string },
): { releaseId: string; amountMinor: number; outstandingMinor: number } {
  authorise(ctx, 'PAYMENT_APPLICATIONS', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const position = retentionPosition(ctx, input.contractId, input.releasedOn);
  const tranche = position.tranches.find((entry) => entry.tranche === input.tranche)!;

  if (tranche.blockedBy) {
    throw new DomainError('RETENTION_NOT_DUE', `${TRANCHE_SHARE[input.tranche].label} has not fallen due. ${tranche.blockedBy}`, 409);
  }
  if (input.amountMinor <= 0) {
    throw new DomainError('RETENTION_AMOUNT_INVALID', 'A release is a positive amount');
  }
  if (input.amountMinor > tranche.outstandingMinor) {
    throw new DomainError(
      'RETENTION_OVER_RELEASE',
      `${money(input.amountMinor)} is more than the ${money(tranche.outstandingMinor)} outstanding on this tranche. ` +
        `${money(position.heldMinor)} was withheld in total and ${money(position.releasedMinor)} has already been released.`,
    );
  }

  const releaseId = ulid();
  write(ctx, {
    eventType: 'RETENTION_RELEASED',
    entity: { refType: 'RetentionRelease', refId: releaseId },
    reason: `${TRANCHE_SHARE[input.tranche].label}: ${money(input.amountMinor)}`,
    nextState: {
      id: releaseId,
      contractId: input.contractId,
      tranche: input.tranche,
      amountMinor: input.amountMinor,
      dueOn: tranche.dueOn ?? input.releasedOn.slice(0, 10),
      releasedOn: input.releasedOn.slice(0, 10),
      ...(input.reason ? { reason: input.reason } : {}),
      releasedBy: ctx.auth.actorId,
    } satisfies ReleaseState,
  });

  return {
    releaseId,
    amountMinor: input.amountMinor,
    outstandingMinor: Math.max(0, position.outstandingMinor - input.amountMinor),
  };
}

// --- Dates -------------------------------------------------------------------

/**
 * The completion certificate that started the clock.
 *
 * Sectional certificates are excluded. A car park handed over early starts its
 * own section's dates, and taking one would release the balance of the whole
 * contract's retention on the strength of it.
 */
function completionCertificate(ctx: EngineContext):
  | { completionDate: string; triggeredDates: Array<{ key: string; date: string; ruleSource?: string }> }
  | undefined {
  return ctx.ledger
    .list(ctx.projectId, 'CompletionRecord')
    .map((record) => record.state as Record<string, unknown>)
    .filter((state) => String(state.kind ?? '') !== 'SECTIONAL')
    .map((state) => ({
      completionDate: String(state.completionDate ?? ''),
      triggeredDates: (state.triggeredDates as Array<{ key: string; date: string; ruleSource?: string }> | undefined) ?? [],
    }))
    .filter((entry) => entry.completionDate.length >= 10)
    .sort((a, b) => a.completionDate.localeCompare(b.completionDate))[0];
}

const money = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
