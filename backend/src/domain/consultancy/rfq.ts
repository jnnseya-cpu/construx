/**
 * RFQ and bid packs — the buyer and bidder sides of a procurement — with the
 * machine-checkable acceptance contracts the spec (§7) defines.
 *
 * The spec's deliverable-validation table is explicit about what each pack must
 * contain and reconcile. This module makes those contracts executable:
 *
 * - **RFQ issue pack** — "Contains mandate, scope, data responsibilities, priced
 *   core and options, deliverable acceptance, instructions, scoring and contract
 *   schedules. Published deadlines and evaluation rules reconcile across all
 *   files." Here the reconciliation that bites is the scoring: the evaluation
 *   weights must sum to 100, or the pack scores on a basis that does not add up.
 * - **Bid issue pack** — "Every mandatory requirement has a response or a named
 *   blocker. … Price schedule totals reconcile including tax, disbursements and
 *   optional items."
 *
 * All deterministic: the pack is composed from the inputs and validated by
 * arithmetic, never by a model. A reasoning provider may later draft the prose
 * of a response, but whether the pack is *complete and reconciles* is a check,
 * not an opinion — which is exactly what lets "recommend hold or stop" be
 * trustworthy.
 */

import type { DocumentBlock } from '../../export/exporter.ts';

function gbp(minor: number): string {
  return `£${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A finding against a pack's acceptance contract. An empty list means the pack passes. */
export type ContractIssue = { code: string; detail: string };

// --- RFQ (buyer side) -------------------------------------------------------

export type EvaluationCriterion = { name: string; weightPct: number; type?: 'QUALITY' | 'PRICE' };
export type DeliverableAcceptance = { deliverable: string; acceptanceTest: string };
export type RfqPriceLine = { item: string; basis: 'CORE' | 'OPTION'; amountMinor?: number };

export type RfqInput = {
  title: string;
  organisation: string;
  mandate: string;
  scope: string;
  deadline: string;
  dataResponsibilities?: string[];
  evaluation: EvaluationCriterion[];
  deliverables: DeliverableAcceptance[];
  priceLines: RfqPriceLine[];
  contractSchedules?: string[];
  instructions?: string;
};

/**
 * The RFQ issue-pack contract (§7). Returns the issues; empty means the pack is
 * issuable. The scoring reconciliation — weights summing to 100 — is the one
 * that most often fails silently, so it is checked exactly (to the penny of a
 * percentage point).
 */
export function validateRfqInput(input: RfqInput): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!input.mandate?.trim()) issues.push({ code: 'NO_MANDATE', detail: 'The RFQ has no mandate' });
  if (!input.scope?.trim()) issues.push({ code: 'NO_SCOPE', detail: 'The RFQ has no scope' });
  if (!input.deadline?.trim()) issues.push({ code: 'NO_DEADLINE', detail: 'The RFQ has no submission deadline' });

  if (!input.evaluation || input.evaluation.length === 0) {
    issues.push({ code: 'NO_SCORING', detail: 'The RFQ has no evaluation criteria' });
  } else {
    const sum = input.evaluation.reduce((t, c) => t + c.weightPct, 0);
    if (Math.round(sum * 100) !== 10_000) {
      issues.push({ code: 'WEIGHTS_UNRECONCILED', detail: `Evaluation weights sum to ${sum}%, not 100%` });
    }
  }

  if (!input.deliverables || input.deliverables.length === 0) {
    issues.push({ code: 'NO_ACCEPTANCE', detail: 'The RFQ names no deliverable with an acceptance test' });
  } else {
    for (const d of input.deliverables) {
      if (!d.acceptanceTest?.trim()) issues.push({ code: 'DELIVERABLE_NO_ACCEPTANCE', detail: `"${d.deliverable}" has no acceptance test` });
    }
  }

  const core = (input.priceLines ?? []).filter((l) => l.basis === 'CORE');
  if (core.length === 0) issues.push({ code: 'NO_PRICED_CORE', detail: 'The RFQ pricing schedule has no core line' });

  return issues;
}

/** Compose the RFQ issue pack as export blocks. */
export function composeRfqBlocks(input: RfqInput): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  const h = (level: 1 | 2 | 3, text: string): void => { blocks.push({ kind: 'HEADING', level, text }); };
  const para = (text: string): void => { blocks.push({ kind: 'PARAGRAPH', text }); };

  h(1, `${input.title} — Request for Quotation`);
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Issued by', value: input.organisation },
      { label: 'Submission deadline', value: input.deadline },
    ],
  });

  h(2, '1. Mandate'); para(input.mandate);
  h(2, '2. Scope'); para(input.scope);

  if (input.dataResponsibilities && input.dataResponsibilities.length > 0) {
    h(2, '3. Data responsibilities');
    blocks.push({ kind: 'LIST', ordered: false, items: input.dataResponsibilities });
  }

  h(2, '4. Evaluation');
  blocks.push({
    kind: 'TABLE',
    caption: 'Award criteria and weightings',
    headers: ['Criterion', 'Type', 'Weighting'],
    rows: input.evaluation.map((c) => [c.name, c.type ?? 'QUALITY', `${c.weightPct}%`]),
  });

  h(2, '5. Deliverables and acceptance');
  blocks.push({
    kind: 'TABLE',
    caption: 'Deliverables and their acceptance tests',
    headers: ['Deliverable', 'Acceptance test'],
    rows: input.deliverables.map((d) => [d.deliverable, d.acceptanceTest]),
  });

  h(2, '6. Pricing schedule');
  blocks.push({
    kind: 'TABLE',
    caption: 'Priced core and options',
    headers: ['Item', 'Basis', 'Price'],
    rows: input.priceLines.map((l) => [l.item, l.basis, l.amountMinor === undefined ? '[to be priced]' : gbp(l.amountMinor)]),
  });

  if (input.instructions) { h(2, '7. Instructions to tenderers'); para(input.instructions); }
  if (input.contractSchedules && input.contractSchedules.length > 0) {
    h(2, '8. Contract schedules');
    blocks.push({ kind: 'LIST', ordered: false, items: input.contractSchedules });
  }

  return blocks;
}

// --- Bid (bidder side) ------------------------------------------------------

export type BidRequirement = { ref: string; mandatory: boolean; response?: string; blocker?: string };
export type BidPriceLine = { item: string; amountMinor: number; kind: 'CORE' | 'OPTION' | 'TAX' | 'DISBURSEMENT' };

export type BidPack = {
  requirements: BidRequirement[];
  priceLines: BidPriceLine[];
  /** The total the bidder has stated on the price schedule. */
  statedTotalMinor: number;
};

export type BidValidation = { issues: ContractIssue[]; computedTotalMinor: number; reconciles: boolean };

/**
 * The bid issue-pack contract (§7): every mandatory requirement has a response
 * or a named blocker, and the price schedule total reconciles — including tax,
 * disbursements and optional items. A mandatory requirement that is neither
 * answered nor blockered is the gap that fails a submission at format check, so
 * it is named rather than left for the buyer to find.
 */
export function validateBidPack(pack: BidPack): BidValidation {
  const issues: ContractIssue[] = [];

  for (const r of pack.requirements) {
    if (r.mandatory && !r.response?.trim() && !r.blocker?.trim()) {
      issues.push({ code: 'MANDATORY_UNADDRESSED', detail: `Requirement ${r.ref} is mandatory and has neither a response nor a named blocker` });
    }
  }

  // Every line — core, option, tax and disbursement — counts toward the total.
  const computedTotalMinor = pack.priceLines.reduce((t, l) => t + l.amountMinor, 0);
  const reconciles = computedTotalMinor === pack.statedTotalMinor;
  if (!reconciles) {
    issues.push({
      code: 'PRICE_UNRECONCILED',
      detail: `Stated total ${gbp(pack.statedTotalMinor)} does not reconcile with the schedule lines ${gbp(computedTotalMinor)} (including tax, disbursements and optional items)`,
    });
  }

  return { issues, computedTotalMinor, reconciles };
}
