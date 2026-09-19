import { DomainError, NotFoundError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import { lineNetCostMinor, type MeasuredLine } from '../engines/maths/costModel.ts';
import { createDraft, type DocumentBody, type LifecycleDocument } from '../group/issuance.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';
import { formatMoney } from './locale.ts';

/**
 * The last step of the estimating line: a priced estimate drawn up as the
 * quotation that goes to the customer.
 *
 * Everything before this existed. A drawing was read, quantities were measured
 * and confirmed by a person, the measured lines were priced across the twenty
 * cost heads — and then the line stopped. The only way to get a quotation out
 * of the platform was to open the legal-document screen and retype the total
 * into a free-text box, which is not a quotation produced from the record; it
 * is a quotation produced from somebody's memory of the record, and it is the
 * point in the chain where the traceability was being thrown away.
 *
 * This composes the body and hands it to the document lifecycle that already
 * exists. Nothing here renders, numbers or brands anything: generation,
 * approval and issue are `group/issuance.ts`'s and stay there. What this adds
 * is the one thing that module could not know — how an estimate becomes the
 * rows a customer reads.
 *
 * Three rules decide what those rows say.
 *
 * **An incomplete estimate is not quoted.** A head neither priced nor excluded
 * is an omission, and the cost model marks the estimate incomplete when it
 * finds one. Sending that out as a price is how a contractor discovers at
 * final account that nobody priced the waste. It is refused here, by name.
 *
 * **The customer sees a price, not our build-up.** No overhead line, no profit
 * line, no margin percentage, no cost — the same rule the billing screen was
 * corrected for. What the customer gets is the works, the quantities, the
 * money and the qualifications.
 *
 * **Every line's share of the price is its share of the cost.** The tender
 * total is apportioned across the measured lines in proportion to what each
 * one costs, using the same arithmetic the estimate used, with the rounding
 * remainder carried onto the last line so the lines add up to the total
 * exactly. A quotation whose lines do not sum to its own total is the first
 * thing a client's QS finds.
 */

/** What a person has to say that the estimate cannot. */
export type QuotationInput = {
  estimateId: string;
  /** Who the offer is made to. Not derivable: an estimate has no addressee. */
  clientName: string;
  /** The day the offer lapses. A quotation without one is a standing offer. */
  validUntil: string;
  /** Terms of payment, where the company states them on its quotations. */
  paymentTerms?: string;
  /** A covering sentence, printed above the works. */
  coveringNote?: string;
};

/** The most rows a document body holds, before the lifecycle refuses it. */
const BODY_ROW_LIMIT = 200;

export function quoteFromEstimate(
  platform: Platform,
  ctx: EngineContext,
  actor: AuthContext,
  input: QuotationInput,
): { document: LifecycleDocument; totalMinor: number; currency: string; lines: number } {
  // Reading a commercial position, which is what an estimate is. The document
  // side is authorised separately by the caller, because creating a legal
  // instrument is a different authority from reading a price.
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = platform.ledger.get({ refType: 'Estimate', refId: input.estimateId });
  // A record belonging to another company or another project is answered
  // exactly as a record that does not exist.
  if (!record || record.tenantId !== ctx.tenantId || record.projectId !== ctx.projectId) {
    throw new NotFoundError(`No estimate ${input.estimateId} on this project`);
  }
  const estimate = record.state;

  const omissions = (estimate.omissions as string[] | undefined) ?? [];
  if (omissions.length > 0) {
    throw new DomainError(
      'ESTIMATE_INCOMPLETE',
      `This estimate carries ${omissions.length} cost head${omissions.length === 1 ? '' : 's'} that ${
        omissions.length === 1 ? 'is' : 'are'
      } neither priced nor excluded: ${omissions.join(', ')}. Price ${
        omissions.length === 1 ? 'it' : 'them'
      } or state ${omissions.length === 1 ? 'it' : 'them'} as an exclusion before quoting — a nought against a head ` +
        'is not a job without it.',
      409,
    );
  }

  const totalMinor = Number(estimate.totalMinor ?? 0);
  if (!Number.isFinite(totalMinor) || totalMinor <= 0) {
    throw new DomainError('ESTIMATE_NOT_PRICED', 'This estimate has no tender total to quote', 409);
  }

  const lines = (estimate.lines as MeasuredLine[] | undefined) ?? [];
  if (lines.length === 0) throw new DomainError('ESTIMATE_NOT_PRICED', 'This estimate prices no measured line', 409);

  const validUntil = Date.parse(input.validUntil);
  if (Number.isNaN(validUntil)) throw new DomainError('VALID_UNTIL_INVALID', 'The validity date is not a date');
  if (validUntil <= Date.now()) {
    throw new DomainError('VALID_UNTIL_PAST', 'A quotation cannot lapse before it is sent', 422);
  }

  const project = platform.ledger.get({ refType: 'Project', refId: ctx.projectId });
  const currency = String(project?.state.currency ?? 'GBP');
  const projectName = String(project?.state.name ?? ctx.projectId);

  const assumptions = ((estimate.assumptions as string[] | undefined) ?? []).filter(Boolean);
  const exclusions = (estimate.exclusions as Array<{ label?: string; head?: string; reason?: string }> | undefined) ?? [];

  const rows = 9 + lines.length + assumptions.length + exclusions.length;
  if (rows > BODY_ROW_LIMIT) {
    throw new DomainError(
      'QUOTATION_TOO_LONG',
      `This quotation would print ${rows} rows and a document holds ${BODY_ROW_LIMIT}. Quote the packages separately.`,
      422,
    );
  }

  const body: DocumentBody = {
    Client: input.clientName,
    Project: projectName,
    'Work package': String(estimate.packageId ?? '—'),
    'Our reference': input.estimateId,
    'Date of this quotation': new Date().toISOString().slice(0, 10),
    'Valid until': input.validUntil.slice(0, 10),
    'Period on site': `${Number(estimate.durationWeeks ?? 0)} weeks`,
  };
  if (input.coveringNote) body['Covering note'] = input.coveringNote;
  if (estimate.basisOfEstimate) body['Basis of this price'] = String(estimate.basisOfEstimate);

  // Each line's share of the price is its share of the cost. The remainder
  // from rounding goes on the last line rather than being dropped, so the
  // lines sum to the total exactly.
  const netTotal = lines.reduce((sum, line) => sum + lineNetCostMinor(line), 0);
  let allocated = 0;
  lines.forEach((line, index) => {
    const label = `${index + 1}. ${line.description} — ${line.quantity} ${line.unit}`;
    if (netTotal <= 0) {
      // Every rate excluded rather than priced: the works are stated and the
      // price stands as one sum, which is truthful where an apportionment
      // would be invented.
      body[label] = 'Included in the sum below';
      return;
    }
    const share =
      index === lines.length - 1 ? totalMinor - allocated : Math.round((totalMinor * lineNetCostMinor(line)) / netTotal);
    allocated += share;
    body[label] = formatMoney(share, currency);
  });

  body['Total, excluding VAT'] = formatMoney(totalMinor, currency);
  if (input.paymentTerms) body['Payment terms'] = input.paymentTerms;
  assumptions.forEach((assumption, index) => {
    body[`Assumed ${index + 1}`] = assumption;
  });
  exclusions.forEach((exclusion, index) => {
    body[`Not included ${index + 1} — ${exclusion.label ?? exclusion.head ?? ''}`.trim()] = exclusion.reason ?? 'Excluded';
  });

  const document = createDraft(platform, actor, {
    documentType: 'quotation',
    title: `Quotation — ${projectName}${estimate.packageId ? `, ${String(estimate.packageId)}` : ''}`,
    body,
    // The estimate is the source record, so the manifest freezes the estimate's
    // version alongside the rows: a quotation can be shown to have come from a
    // particular state of a particular estimate, not merely to resemble it.
    source: { refType: 'Estimate', refId: input.estimateId },
  });

  return { document, totalMinor, currency, lines: lines.length };
}
