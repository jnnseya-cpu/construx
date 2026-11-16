import { DomainError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import { tenderReviewForPack } from './contractreview.ts';
import type { ScopeLine } from './tenderparticulars.ts';
import { projectTender } from './tenderregister.ts';
import { mapScope, type ScopeFinding, type ScopeItem } from './tenderreview.ts';
import { describeQuoteSource } from './tendersource.ts';

/**
 * Who designs, supplies, installs and tests each part of the work, where it is
 * priced, and where the documents disagree.
 *
 * Read from the pack with everything else, and checked here in code: a
 * responsibility the documents do not state is flagged to be clarified, an
 * element nothing prices is a gap, a free-issue or nominated item is an
 * interface to manage, and a discrepancy is only shown as one where each side
 * is a passage actually found in the documents. Each discrepancy is a
 * clarification to raise; each scope line can go onto the tender review's
 * existing gap-and-overlap map, where the pricing is checked against it.
 */

export type Pricing = 'ITEM' | 'PRELIMINARIES' | 'PROVISIONAL_SUM' | 'NOT_PRICED';

export type InterfaceRow = ScopeLine & {
  pricing: Pricing;
  /** The bill item it is priced in, where the bill on the project carries it. */
  billItem?: { costCode: string; description: string };
  flags: string[];
  sourceText: string;
};

export type DiscrepancyRow = {
  /** Stable: from the subject, so it can be tracked across the outputs. */
  id: string;
  subject: string;
  statements: Array<{ document: string; clause?: string; says: string; sourceText: string; located: boolean }>;
  consequence?: string;
  /** Every side found in the documents by code. */
  verified: boolean;
  billItem?: { costCode: string; description: string };
  /** The clarification raised about it, where one has been. */
  clarification?: { reference: string; status: string };
  action: string;
};

export type ScopeReview = {
  rows: InterfaceRow[];
  discrepancies: DiscrepancyRow[];
  counts: { lines: number; unstated: number; unpriced: number; interfaces: number; discrepancies: number; unverified: number };
  summary: string;
};

const ROLE_WORD: Record<'design' | 'supply' | 'install' | 'testApprove', string> = {
  design: 'designs',
  supply: 'supplies',
  install: 'installs',
  testApprove: 'tests or approves',
};

const slug = (text: string): string =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

function pricingOf(pricedIn: string | undefined): Pricing {
  if (!pricedIn || /\b(not priced|nowhere|none|no item)\b/i.test(pricedIn)) return 'NOT_PRICED';
  if (/prelim/i.test(pricedIn)) return 'PRELIMINARIES';
  if (/provisional|\bp\.?c\.? sum|prime cost/i.test(pricedIn)) return 'PROVISIONAL_SUM';
  return 'ITEM';
}

function billItems(ctx: EngineContext): Array<{ costCode: string; description: string }> {
  return ctx.ledger
    .list(ctx.projectId, 'BoQItem')
    .map((record) => record.state)
    .map((state) => ({ costCode: String(state.costCode ?? ''), description: String(state.description ?? '') }));
}

/** The bill item a "priced in" reference names: by its cost code, or the item number its description opens with. */
function itemFor(reference: string | undefined, items: Array<{ costCode: string; description: string }>) {
  const wanted = (reference ?? '').trim().toLowerCase();
  if (!wanted) return undefined;
  const token = wanted.match(/\b\d+(?:\.\d+)*[a-z]?\b/)?.[0];
  return items.find(
    (item) =>
      (item.costCode && wanted.includes(item.costCode.toLowerCase())) ||
      (token !== undefined && new RegExp(`^${token.replace(/\./g, '\\.')}\\b`, 'i').test(item.description.trim())),
  );
}

export function scopeReview(ctx: EngineContext): ScopeReview {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const { particulars } = projectTender(ctx);
  const items = billItems(ctx);

  const rows = (particulars?.scope ?? []).map((line): InterfaceRow => {
    const flags: string[] = [];
    for (const role of ['design', 'supply', 'install', 'testApprove'] as const) {
      if (line[role] === 'NOT_STATED') flags.push(`Who ${ROLE_WORD[role]} it is not stated — clarify it.`);
    }
    const parties = [line.design, line.supply, line.install, line.testApprove];
    if (parties.includes('FREE_ISSUE')) flags.push('Free issue: receipt, storage, damage and late delivery are an interface to agree.');
    if (parties.includes('NOMINATED')) flags.push('Nominated: who carries their performance and their delay is to be settled.');
    if (line.design === 'CONTRACTOR' || line.design === 'SPECIALIST') flags.push('Contractor’s design: design liability and professional indemnity apply.');
    if (parties.includes('CLIENT') || parties.includes('OTHERS')) flags.push('Done by others: their dates and their tests are a dependency of the programme.');
    const pricing = pricingOf(line.pricedIn);
    if (pricing === 'NOT_PRICED') flags.push('Not priced anywhere in the documents — a gap: it will be built and nobody priced it.');
    const billItem = pricing === 'ITEM' ? itemFor(line.pricedIn, items) : undefined;
    return {
      ...line,
      pricing,
      ...(billItem ? { billItem } : {}),
      flags,
      sourceText: line.source ? describeQuoteSource(line.source) : 'no passage given',
    };
  });

  const clarifications = ctx.ledger
    .list(ctx.projectId, 'Clarification')
    .map((record) => record.state)
    .filter((state) => state.status !== 'WITHDRAWN');
  const discrepancies = (particulars?.discrepancies ?? []).map((entry): DiscrepancyRow => {
    const id = `DISC-${slug(entry.subject)}`;
    const statements = entry.statements.map((statement) => ({
      document: statement.document,
      ...(statement.clause ? { clause: statement.clause } : {}),
      says: statement.says,
      sourceText: statement.source ? describeQuoteSource(statement.source) : 'no passage given',
      located: statement.source?.located === true,
    }));
    const verified = statements.every((statement) => statement.located);
    const raised = clarifications.filter((state) => (state.links as { scopeItem?: string } | undefined)?.scopeItem === id).at(-1);
    const priced = statements.map((statement) => itemFor(statement.clause, items)).find(Boolean);
    return {
      id,
      subject: entry.subject,
      statements,
      ...(entry.consequence ? { consequence: entry.consequence } : {}),
      verified,
      ...(priced ? { billItem: priced } : {}),
      ...(raised ? { clarification: { reference: String(raised.reference), status: String(raised.status) } } : {}),
      action: raised
        ? raised.status === 'ANSWERED'
          ? `Answered in ${String(raised.reference)}: price and answer to the ruling.`
          : `Raised as ${String(raised.reference)}: price on the stricter reading until it is answered.`
        : verified
          ? 'Raise a clarification for the buyer to rule on; until then, price on the stricter reading.'
          : 'Check both passages against the documents before raising it: one side was not found.',
    };
  });

  const counts = {
    lines: rows.length,
    unstated: rows.filter((row) => [row.design, row.supply, row.install, row.testApprove].includes('NOT_STATED')).length,
    unpriced: rows.filter((row) => row.pricing === 'NOT_PRICED').length,
    interfaces: rows.filter((row) => [row.design, row.supply, row.install, row.testApprove].some((party) => ['FREE_ISSUE', 'NOMINATED', 'CLIENT', 'OTHERS'].includes(party))).length,
    discrepancies: discrepancies.length,
    unverified: discrepancies.filter((row) => !row.verified).length,
  };
  return {
    rows,
    discrepancies,
    counts,
    summary:
      rows.length === 0 && discrepancies.length === 0
        ? 'No scope or discrepancy has been read from the pack yet.'
        : `${counts.lines} scope line(s): ${counts.unstated} with a responsibility not stated, ${counts.unpriced} priced nowhere, ${counts.interfaces} interface(s). ` +
          `${counts.discrepancies} discrepancy(ies) between documents` +
          (counts.unverified > 0 ? `, ${counts.unverified} with a side not found in the documents` : '') +
          '.',
  };
}

/**
 * Put the scope onto the tender review's gap-and-overlap map: each element with
 * the document that imposes it and the package that prices it. An element
 * priced nowhere is a gap there; one priced in two packages is an overlap.
 */
export function sendScopeToReview(
  ctx: EngineContext,
  input: { edition?: string },
): { reviewId: string; reference: string; gaps: ScopeFinding[]; overlaps: ScopeFinding[]; skipped: string[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });
  const { particulars } = projectTender(ctx);
  const lines = particulars?.scope ?? [];
  if (lines.length === 0) {
    throw new DomainError('NO_SCOPE_READ', 'No scope has been read from the pack on this project.', 409);
  }
  const { reviewId, reference } = tenderReviewForPack(ctx, particulars, input.edition, 'Tender review, from the tender reading');

  // One element per description: the packages that price it, gathered.
  const byElement = new Map<string, { line: ScopeLine; packages: Set<string> }>();
  const skipped: string[] = [];
  for (const line of lines) {
    if (!line.source?.located || !line.source.document) {
      skipped.push(`${line.reference} ${line.description} — its passage was not found in the documents`);
      continue;
    }
    const key = line.description.trim().toLowerCase();
    const entry = byElement.get(key) ?? { line, packages: new Set<string>() };
    if (pricingOf(line.pricedIn) !== 'NOT_PRICED') entry.packages.add(line.workPackage);
    byElement.set(key, entry);
  }
  const items: ScopeItem[] = [...byElement.values()].map(({ line, packages }) => ({
    reference: line.reference,
    description: line.description,
    source: {
      document: line.source!.document!,
      ...(line.source!.clause ? { clause: line.source!.clause } : {}),
      ...(line.source!.page !== undefined ? { page: line.source!.page } : {}),
    },
    packages: [...packages],
  }));
  if (items.length === 0) {
    throw new DomainError('NO_SCOPE_CITED', 'No scope line could be cited to the documents, so none can go on the review.', 409);
  }
  const mapped = mapScope(ctx, reviewId, items);
  return { reviewId, reference, ...mapped, skipped };
}
