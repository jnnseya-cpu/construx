import { DomainError, NotFoundError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import { costHead, lineNetCostMinor, type MeasuredLine } from '../engines/maths/costModel.ts';
import type { DocumentBlock } from '../export/exporter.ts';
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

/** The most a single row's value holds, which is what a long field runs into. */
const BODY_VALUE_LIMIT = 2_000;

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

  // Fixed and provisional sums are carried after margin, so the measured lines
  // are apportioned the works total only and these print under their own labels.
  const fixedSumsList = ((estimate.fixedSums as Array<{ label?: string; amountMinor?: number; provisional?: boolean }> | undefined) ?? [])
    .map((sum) => ({ label: String(sum.label ?? 'Fixed sum'), amountMinor: Math.round(Number(sum.amountMinor) || 0), provisional: Boolean(sum.provisional) }))
    .filter((sum) => sum.amountMinor > 0);
  const fixedSumsMinor = fixedSumsList.reduce((total, sum) => total + sum.amountMinor, 0);
  const worksTotal = totalMinor - fixedSumsMinor;

  const rows = 9 + lines.length + fixedSumsList.length + assumptions.length + exclusions.length;
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
  /*
   * The item number is the label and everything else is the value.
   *
   * The obvious shape — the description as the label, the money as the value —
   * met `DOCUMENT_BODY_INVALID: … is too long` on the first real bill, because
   * a document label is capped at 80 characters and a measured item is
   * routinely longer: *"Excavation for two number pad foundations, commencing
   * from existing ground level, maximum depth not exceeding 2.0m."* is 108.
   *
   * Truncating was never an option. The description **is** what the customer is
   * being offered, and a quotation that shortens it offers something else. So
   * the row is turned round: a short stable label, and the description,
   * quantity and price together in the value, which holds two thousand
   * characters. It also reads the way a priced bill reads.
   */
  lines.forEach((line, index) => {
    const label = `Item ${index + 1}`;
    const measured = `${line.description} — ${line.quantity} ${line.unit}`;
    if (netTotal <= 0) {
      // Every rate excluded rather than priced: the works are stated and the
      // price stands as one sum, which is truthful where an apportionment
      // would be invented.
      body[label] = `${measured} — included in the sum below`;
      return;
    }
    const share =
      index === lines.length - 1 ? worksTotal - allocated : Math.round((worksTotal * lineNetCostMinor(line)) / netTotal);
    allocated += share;
    body[label] = `${measured} — ${formatMoney(share, currency)}`;
  });

  // The fixed and provisional sums, each under its own label, after the works —
  // listed, never marked up, so the lines still sum to the total.
  fixedSumsList.forEach((sum, index) => {
    body[`Item ${lines.length + index + 1}`] = `${sum.label}${sum.provisional ? ' (provisional sum)' : ''} — ${formatMoney(sum.amountMinor, currency)}`;
  });

  body['Total, excluding VAT'] = formatMoney(totalMinor, currency);
  if (input.paymentTerms) body['Payment terms'] = input.paymentTerms;
  assumptions.forEach((assumption, index) => {
    body[`Assumed ${index + 1}`] = assumption;
  });
  /*
   * Never a build-up head, whatever the estimate carries against it.
   *
   * The rule at the top of this file is that the customer sees a price and not
   * our build-up. An *exclusion* against overhead or profit breaks it as
   * completely as a priced line would, and worse: a quotation reading
   * **"Not included — Profit"** tells the customer what the business does not
   * intend to charge them. It reached a real quotation, because the run
   * offered both as heads to settle and the form's honest default is that a
   * head left blank is one excluded.
   *
   * Fixed there, and refused here as well. This is the boundary the rule
   * belongs on: whatever else changes upstream, a margin head does not get
   * printed on an offer.
   */
  exclusions
    .filter((exclusion) => costHead(String(exclusion.head ?? ''))?.basis !== 'MARGIN')
    .forEach((exclusion, index) => {
      body[`Not included ${index + 1} — ${exclusion.label ?? exclusion.head ?? ''}`.trim()] = exclusion.reason ?? 'Excluded';
    });

  /*
   * Every row against the limit the document body enforces, named by the row
   * it is on.
   *
   * Refused rather than truncated. A basis of estimate or a covering note cut
   * off mid-sentence in a quotation says something the estimate does not, and
   * nobody reading the document can tell that anything was removed — which is
   * the one failure mode a document that exists to be relied on cannot have.
   */
  for (const [label, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.length > BODY_VALUE_LIMIT) {
      throw new DomainError(
        'QUOTATION_FIELD_TOO_LONG',
        `"${label}" is ${value.length} characters and a quotation row holds ${BODY_VALUE_LIMIT}. Shorten it — a quotation that cuts it off mid-sentence says something the estimate does not.`,
        422,
      );
    }
  }

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

/** One priced line of the pricing schedule — a measured item with its apportioned price. */
export type PricingScheduleLine = {
  n: number;
  description: string;
  quantity: number;
  unit: string;
  amountMinor: number;
};

/**
 * The priced take-off as a pricing schedule — the buyer's "Appendix B" from the record.
 *
 * A formal tender wants its price on the buyer's own elemental schedule, and the
 * only way to produce one was to read every measured line off the bill by hand and
 * retype its price into the buyer's form — the exact "quotation from memory" the
 * quotation composer was built to end, just pointed at a different document.
 *
 * This returns the same priced lines the quotation composes — every measured line
 * with the tender total apportioned across it in proportion to its cost, the
 * rounding remainder carried onto the last line so the lines sum to the total
 * exactly — but as data rather than a legal instrument, so the console can hand it
 * to a person to transcribe into the buyer's Appendix B (or attach as the priced
 * breakdown). It reuses `lineNetCostMinor` and the same apportionment as
 * `quoteFromEstimate`, so the schedule and the quotation can never disagree.
 *
 * It reads the latest *complete* estimate — one with every cost head priced or
 * excluded. An incomplete estimate has no defensible total to apportion, so rather
 * than export a schedule that is wrong it refuses and names what to finish.
 */
export type PricingSchedule = {
  estimateId: string;
  projectName: string;
  packageId: string;
  currency: string;
  durationWeeks: number;
  lines: PricingScheduleLine[];
  totalMinor: number;
  /** The portion of the total that is fixed/provisional sums, listed but not marked up. */
  fixedSumsMinor: number;
  /** False where every rate was excluded: the works stand as one sum, not apportioned. */
  apportioned: boolean;
  assumptions: string[];
  exclusions: Array<{ label: string; reason: string }>;
};

export function pricingSchedule(ctx: EngineContext): PricingSchedule {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const estimates = ctx.ledger.list(ctx.projectId, 'Estimate').map((record) => record.state);
  const complete = estimates.filter(
    (estimate) =>
      ((estimate.omissions as string[] | undefined) ?? []).length === 0 && Number(estimate.totalMinor ?? 0) > 0,
  );
  const estimate = complete.at(-1);
  if (!estimate) {
    throw new DomainError(
      'NO_COMPLETE_ESTIMATE',
      'No complete, priced estimate to build a pricing schedule from. Finish an estimate — price or exclude every cost ' +
        'head so it reads DRAFT rather than INCOMPLETE — before exporting the schedule.',
      409,
    );
  }

  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });
  const currency = String(project?.state.currency ?? 'GBP');
  const projectName = String(project?.state.name ?? ctx.projectId);

  const allMeasured = (estimate.lines as MeasuredLine[] | undefined) ?? [];
  const totalMinor = Number(estimate.totalMinor ?? 0);
  // Fixed and provisional sums are carried after margin, so they are listed
  // beside the measured works rather than apportioned into them: the measured
  // lines share the works total only, and the fixed sums sit under their own
  // labels. Together they still sum to the tender total exactly.
  const fixedSumsList = ((estimate.fixedSums as Array<{ label?: string; amountMinor?: number; provisional?: boolean }> | undefined) ?? [])
    .map((sum) => ({ label: String(sum.label ?? 'Fixed sum'), amountMinor: Math.round(Number(sum.amountMinor) || 0), provisional: Boolean(sum.provisional) }))
    .filter((sum) => sum.amountMinor > 0);
  const fixedSumsMinor = fixedSumsList.reduce((total, sum) => total + sum.amountMinor, 0);
  const worksTotal = totalMinor - fixedSumsMinor;

  const netTotal = allMeasured.reduce((sum, line) => sum + lineNetCostMinor(line), 0);
  const apportioned = netTotal > 0;
  // A measured line that carries no cost apportions to nothing, and "£0.00"
  // against an item on a buyer's schedule reads as work left unpriced or a
  // duplicate — which is exactly what a placeholder line removed from the
  // take-off but lingering in the estimate is. Drop the zero-cost lines where
  // there is a cost to apportion; where nothing is apportioned (every rate
  // excluded) the works stand as one sum and the lines are left as drawn.
  const measuredLines = apportioned ? allMeasured.filter((line) => lineNetCostMinor(line) > 0) : allMeasured;

  let allocated = 0;
  const lines: PricingScheduleLine[] = measuredLines.map((line, index) => {
    const share = !apportioned
      ? 0
      : index === measuredLines.length - 1
        ? worksTotal - allocated
        : Math.round((worksTotal * lineNetCostMinor(line)) / netTotal);
    allocated += share;
    return {
      n: index + 1,
      description: String(line.description),
      quantity: Number(line.quantity),
      unit: String(line.unit),
      amountMinor: share,
    };
  });

  // The fixed and provisional sums, each as their own line, after the works.
  fixedSumsList.forEach((sum, index) => {
    lines.push({
      n: measuredLines.length + index + 1,
      description: sum.provisional ? `${sum.label} (provisional sum)` : sum.label,
      quantity: 1,
      unit: 'sum',
      amountMinor: sum.amountMinor,
    });
  });

  // Whether the offer now carries a contingency as one of its sums. The P80
  // risk-register head may still be excluded — that register was never
  // quantified — but if a contingency line is on the schedule, the offer does
  // carry one, and saying otherwise in the same document contradicts a line the
  // buyer can see.
  const carriesContingency = fixedSumsList.some((sum) => /contingen/i.test(sum.label));

  const assumptions = ((estimate.assumptions as string[] | undefined) ?? []).filter(Boolean);
  // The same rule the quotation holds: a margin head is never printed on an offer,
  // so an excluded overhead or profit head is not carried onto the schedule either.
  const exclusions = ((estimate.exclusions as Array<{ label?: string; head?: string; reason?: string }> | undefined) ?? [])
    .filter((exclusion) => costHead(String(exclusion.head ?? ''))?.basis !== 'MARGIN')
    // Drop the "Contingency and risk: not included" exclusion when a contingency
    // sum is on the schedule: the two together read as the document contradicting
    // itself, and a buyer reads the line, not the QS distinction between a P80
    // register figure and a stated provisional.
    .filter((exclusion) => !(carriesContingency && (String(exclusion.head ?? '').toUpperCase() === 'RISK' || /contingen/i.test(String(exclusion.label ?? '')))))
    .map((exclusion) => ({
      label: String(exclusion.label ?? exclusion.head ?? ''),
      reason: String(exclusion.reason ?? 'Excluded'),
    }));

  return {
    estimateId: String(estimate.id ?? ''),
    projectName,
    packageId: String(estimate.packageId ?? ''),
    currency,
    durationWeeks: Number(estimate.durationWeeks ?? 0),
    lines,
    totalMinor,
    fixedSumsMinor,
    apportioned,
    assumptions,
    exclusions,
  };
}

/**
 * The pricing schedule as document blocks, for a branded, downloadable PDF/DOCX.
 *
 * The domain builds the blocks and the exporter does branding, the content hash
 * and the two ledger events that make the document provable — the seam every
 * generated document on the platform uses. This is what turns the priced
 * take-off from a number on a screen into a file a bidder downloads and submits,
 * rather than something copied out and finished in another tool.
 */
export function pricingScheduleBlocks(schedule: PricingSchedule): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const head: Array<{ label: string; value: string }> = [];
  if (schedule.packageId) head.push({ label: 'Work package', value: schedule.packageId });
  head.push({ label: 'Period on site', value: `${schedule.durationWeeks} week${schedule.durationWeeks === 1 ? '' : 's'}` });
  blocks.push({ kind: 'KEY_VALUES', rows: head });

  blocks.push({
    kind: 'TABLE',
    caption: 'Priced schedule — measured works',
    headers: ['Item', 'Description', 'Quantity', 'Unit', 'Amount'],
    rows: schedule.lines.map((line) => [
      String(line.n),
      line.description,
      Number(line.quantity).toLocaleString('en-GB'),
      line.unit,
      formatMoney(line.amountMinor, schedule.currency),
    ]),
  });

  blocks.push({ kind: 'KEY_VALUES', rows: [{ label: 'Total, excluding VAT', value: formatMoney(schedule.totalMinor, schedule.currency) }] });

  if (schedule.assumptions.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Assumptions' });
    blocks.push({ kind: 'LIST', ordered: false, items: schedule.assumptions });
  }
  if (schedule.exclusions.length > 0) {
    blocks.push({ kind: 'HEADING', level: 2, text: 'Exclusions' });
    blocks.push({ kind: 'LIST', ordered: false, items: schedule.exclusions.map((exclusion) => `${exclusion.label}: ${exclusion.reason}`) });
  }

  const carriesContingency = schedule.lines.some((line) => /contingen/i.test(line.description));
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      schedule.fixedSumsMinor > 0
        ? `This schedule carries the measured works and the provisional and fixed sums listed above${carriesContingency ? ', including a contingency' : ''}, ` +
          `each under its own label and not marked up. VAT is shown separately on the buyer’s own schedule${carriesContingency ? '' : ', which may also require a contingency sum'}; ` +
          'confirm any scope not measured or listed here is priced before submission.'
        : 'This schedule carries the measured works only. A buyer’s own pricing schedule may also require a contingency ' +
          'sum, provisional sums (for example soakaway, plumbing and asbestos) and any mechanical, electrical or external ' +
          'works not contained in this take-off; those are priced separately and are not included in the total above.',
  });

  return blocks;
}
