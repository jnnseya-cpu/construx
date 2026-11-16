import { DomainError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import { CLAUSE_TOPICS, type ClauseTopic, type ContractClause, type TenderParticulars } from './tenderparticulars.ts';
import { interpretContract, openReview, type ContractObligation } from './tenderreview.ts';
import { projectTender } from './tenderregister.ts';
import { describeQuoteSource, type QuoteSource } from './tendersource.ts';

/**
 * The contract, reviewed clause by clause for what it does to this bid.
 *
 * The reading reports each material clause the pack states, with its passage.
 * This puts each one in plain language — what it does to cost, programme, cash,
 * insurance or liability — and says which need a lawyer, an insurer or the
 * finance lead before the bid is priced. The judgement here is a first pass by
 * rule, written down so it can be argued with: it never signs a clause off. The
 * clauses go into the tender review (`tenderreview.ts`), with the contract's own
 * wording verbatim, where a legal or commercial owner accepts or rejects each
 * reading — the sign-off that already exists.
 *
 * It also says what cannot be compared: the standard form's own wording is not
 * held here, so an amended form is reviewed only as far as the pack states it.
 */

export type Effect = 'COST' | 'PROGRAMME' | 'CASH' | 'INSURANCE' | 'LIABILITY';
export type ReviewNeeded = 'LEGAL' | 'INSURANCE' | 'FINANCE';
export type ClauseSeverity = 'SEVERE' | 'MATERIAL' | 'ROUTINE';

export type ContractReviewRow = {
  topic: ClauseTopic;
  title: string;
  clause?: string;
  stated: string;
  /** What it does to this bid, in plain language. */
  effect: string;
  affects: Effect[];
  severity: ClauseSeverity;
  review: ReviewNeeded[];
  source?: QuoteSource;
  sourceText: string;
};

export type ContractReview = {
  form?: string;
  edition?: string;
  options: string[];
  rows: ContractReviewRow[];
  /** Topics the pack does not state, and why each matters. */
  notStated: Array<{ topic: ClauseTopic; title: string; why: string }>;
  /** What cannot be compared, and why. */
  cannotCompare: string[];
  counts: { severe: number; material: number; legal: number; insurance: number; finance: number };
  summary: string;
};

const TITLES: Record<ClauseTopic, string> = {
  PAYMENT_CERTIFICATION: 'Payment and certification',
  RETENTION_RELEASE: 'Retention and its release',
  SET_OFF: 'Set-off',
  LIQUIDATED_DAMAGES: 'Liquidated damages',
  SECTIONAL_COMPLETION: 'Sectional completion',
  EXTENSION_OF_TIME: 'Delay and extension of time',
  NOTICES: 'Notices and time bars',
  VARIATIONS_COMPENSATION_EVENTS: 'Variations and compensation events',
  PRICE_ADJUSTMENT: 'Inflation and price adjustment',
  DESIGN_LIABILITY: 'Design liability',
  LIABILITY_CAP: 'Liability caps and exclusions',
  INDEMNITIES: 'Indemnities',
  INSURANCE: 'Insurance',
  BONDS_GUARANTEES: 'Bonds and guarantees',
  WARRANTIES: 'Warranties',
  TERMINATION: 'Termination',
  DEFECTS: 'Defects',
  INSOLVENCY: 'Insolvency',
};

/** Why a clause the pack does not state still matters, for the ones a bid cannot be priced without. */
const WHY_IT_MATTERS: Partial<Record<ClauseTopic, string>> = {
  PAYMENT_CERTIFICATION: 'how long the work is funded before it is paid for',
  LIABILITY_CAP: 'without a cap, liability may be unlimited',
  NOTICES: 'a missed notice can lose an entitlement to time or money',
  INSURANCE: 'the cover to price and to hold',
  LIQUIDATED_DAMAGES: 'what a week of delay costs',
  DEFECTS: 'how long the business is on the hook after completion',
};

const unitIs = (clause: ContractClause, ...units: string[]): boolean =>
  units.some((unit) => (clause.unit ?? '').toLowerCase().startsWith(unit));
const says = (clause: ContractClause, pattern: RegExp): boolean => pattern.test(clause.stated);

/** One clause, judged by rule — a first pass written down so a reviewer can disagree with it. */
export function assessClause(clause: ContractClause): Omit<ContractReviewRow, 'source' | 'sourceText'> {
  const base = { topic: clause.topic, title: TITLES[clause.topic], ...(clause.clause ? { clause: clause.clause } : {}), stated: clause.stated };
  const value = clause.value;
  switch (clause.topic) {
    case 'PAYMENT_CERTIFICATION': {
      const days = value !== undefined && unitIs(clause, 'day') ? value : undefined;
      return {
        ...base,
        effect:
          days !== undefined
            ? `Paid ${days} days after the due date or application: the business funds the work for that long.`
            : 'When and how the work is certified and paid.',
        affects: ['CASH'],
        severity: days !== undefined && days > 60 ? 'SEVERE' : days !== undefined && days > 30 ? 'MATERIAL' : 'ROUTINE',
        review: days !== undefined && days > 30 ? ['FINANCE'] : [],
      };
    }
    case 'RETENTION_RELEASE': {
      const percent = value !== undefined && unitIs(clause, '%', 'per') ? value : undefined;
      return {
        ...base,
        effect:
          percent !== undefined
            ? `${percent}% of each payment is held back until it is released — cash the business funds in the meantime.`
            : 'Money held back from each payment, and when it comes back.',
        affects: ['CASH'],
        severity: percent !== undefined && percent > 5 ? 'SEVERE' : percent !== undefined && percent > 3 ? 'MATERIAL' : 'ROUTINE',
        review: ['FINANCE'],
      };
    }
    case 'SET_OFF':
      return { ...base, effect: 'The client may deduct sums it says it is owed from what it pays.', affects: ['CASH', 'LIABILITY'], severity: 'MATERIAL', review: ['LEGAL'] };
    case 'LIQUIDATED_DAMAGES':
      return { ...base, effect: 'A fixed sum per period of delay, payable whatever the actual loss.', affects: ['COST', 'PROGRAMME'], severity: 'MATERIAL', review: ['LEGAL'] };
    case 'SECTIONAL_COMPLETION':
      return { ...base, effect: 'Parts of the works have their own completion dates, each carrying its own damages.', affects: ['PROGRAMME'], severity: 'MATERIAL', review: [] };
    case 'EXTENSION_OF_TIME':
      return { ...base, effect: 'When the completion date moves for delay, and what has to be shown to move it.', affects: ['PROGRAMME', 'COST'], severity: 'MATERIAL', review: ['LEGAL'] };
    case 'NOTICES': {
      const days = value !== undefined && unitIs(clause, 'day') ? value : value !== undefined && unitIs(clause, 'week') ? value * 7 : undefined;
      return {
        ...base,
        effect:
          days !== undefined
            ? `Notices must be given within ${days} days; one given late can lose the entitlement to time or money.`
            : 'What must be notified, and by when, to keep an entitlement.',
        affects: ['PROGRAMME', 'COST'],
        severity: days !== undefined && days < 28 ? 'SEVERE' : 'MATERIAL',
        review: ['LEGAL'],
      };
    }
    case 'VARIATIONS_COMPENSATION_EVENTS':
      return { ...base, effect: 'How a change is instructed, valued and added to the time and the price.', affects: ['COST', 'PROGRAMME'], severity: 'MATERIAL', review: [] };
    case 'PRICE_ADJUSTMENT': {
      const fixed = says(clause, /\b(fixed|firm) price\b|no (?:fluctuation|price adjustment|inflation|indexation)/i);
      return {
        ...base,
        effect: fixed ? 'The price is fixed: inflation over the whole period is the business’s to carry and to price.' : 'How the price moves with inflation.',
        affects: ['COST'],
        severity: fixed ? 'MATERIAL' : 'ROUTINE',
        review: fixed ? ['FINANCE'] : [],
      };
    }
    case 'DESIGN_LIABILITY': {
      const fitness = says(clause, /fit(?:ness)? for (?:its )?purpose/i);
      return {
        ...base,
        effect: fitness
          ? 'Fitness for purpose: the design must achieve the result, not only be done with reasonable care — professional indemnity cover is for the latter.'
          : 'The standard the business’s design is judged against.',
        affects: ['LIABILITY', 'INSURANCE'],
        severity: fitness ? 'SEVERE' : 'MATERIAL',
        review: fitness ? ['LEGAL', 'INSURANCE'] : ['LEGAL'],
      };
    }
    case 'LIABILITY_CAP': {
      const unlimited = says(clause, /\bunlimited\b|\bno (?:cap|limit)\b|\buncapped\b/i);
      return {
        ...base,
        effect: unlimited
          ? 'Liability is unlimited.'
          : value !== undefined
            ? `Liability is capped at ${value}${clause.unit === '%' ? '% of the contract sum' : ` ${clause.unit ?? ''}`.trimEnd()}.`
            : 'What the business’s total liability is limited to, and what is excluded from the limit.',
        affects: ['LIABILITY'],
        severity: unlimited ? 'SEVERE' : 'MATERIAL',
        review: ['LEGAL'],
      };
    }
    case 'INDEMNITIES': {
      const broad = says(clause, /\b(?:any and all|all|any)\b[^.]{0,40}\b(?:loss|claim|liabilit)|\bwhatsoever\b|\bhowsoever\b|\birrespective of\b/i);
      return {
        ...base,
        effect: broad
          ? 'A broad indemnity: the business covers losses beyond those it causes, which insurance may not answer.'
          : 'Losses the business must make good to the client.',
        affects: ['LIABILITY', 'INSURANCE'],
        severity: broad ? 'SEVERE' : 'MATERIAL',
        review: ['LEGAL', 'INSURANCE'],
      };
    }
    case 'INSURANCE':
      return { ...base, effect: 'The cover the business must hold, and for how long.', affects: ['INSURANCE', 'COST'], severity: 'MATERIAL', review: ['INSURANCE'] };
    case 'BONDS_GUARANTEES':
      return { ...base, effect: 'Security the business must provide — bonding capacity committed, and a fee to price.', affects: ['CASH', 'COST'], severity: 'MATERIAL', review: ['FINANCE'] };
    case 'WARRANTIES':
      return { ...base, effect: 'Warranties to others (funders, tenants, purchasers) extending who can claim.', affects: ['LIABILITY'], severity: 'MATERIAL', review: ['LEGAL'] };
    case 'TERMINATION': {
      const convenience = says(clause, /convenience|at will|without cause/i);
      return {
        ...base,
        effect: convenience ? 'The client may end the contract at its convenience — recovery of lost profit depends on the wording.' : 'When either party may end the contract and what is then paid.',
        affects: ['LIABILITY', 'CASH'],
        severity: convenience ? 'MATERIAL' : 'ROUTINE',
        review: ['LEGAL'],
      };
    }
    case 'DEFECTS': {
      const months = value !== undefined && unitIs(clause, 'month') ? value : value !== undefined && unitIs(clause, 'week') ? Math.round(value / 4.345) : undefined;
      return {
        ...base,
        effect: months !== undefined ? `Defects must be put right for ${months} months after completion.` : 'How long after completion defects must be put right.',
        affects: ['COST'],
        severity: months !== undefined && months > 12 ? 'MATERIAL' : 'ROUTINE',
        review: [],
      };
    }
    case 'INSOLVENCY':
      return { ...base, effect: 'What happens if either party becomes insolvent.', affects: ['LIABILITY'], severity: 'ROUTINE', review: ['LEGAL'] };
  }
}

/** The contract as the pack states it, reviewed — from the matrix's particulars. */
export function reviewContract(particulars: TenderParticulars | undefined): ContractReview {
  const contract = particulars?.contract;
  const rows: ContractReviewRow[] = (contract?.clauses ?? []).map((clause) => ({
    ...assessClause(clause),
    ...(clause.source ? { source: clause.source } : {}),
    sourceText: clause.source ? describeQuoteSource(clause.source) : 'no passage given',
  }));
  const order = (topic: ClauseTopic): number => CLAUSE_TOPICS.indexOf(topic);
  rows.sort((a, b) => order(a.topic) - order(b.topic));
  const stated = new Set(rows.map((row) => row.topic));
  const notStated = CLAUSE_TOPICS.filter((topic) => !stated.has(topic)).map((topic) => ({
    topic,
    title: TITLES[topic],
    why: WHY_IT_MATTERS[topic] ? `Not stated in the pack — ${WHY_IT_MATTERS[topic]}. Check the standard form or ask the buyer.` : 'Not stated in the pack.',
  }));

  const cannotCompare: string[] = [];
  const form = [contract?.form, contract?.edition].filter(Boolean).join(' ');
  if (!contract?.form) {
    cannotCompare.push('The pack does not name the form of contract, so no clause can be read against a standard form. Ask the buyer which form and edition.');
  } else {
    if (!contract.edition) cannotCompare.push(`${contract.form} is named without its edition; the edition changes what the clauses say.`);
    if (contract.amendmentsStated && contract.amendmentsSupplied === false) {
      cannotCompare.push(`The pack says ${form} is amended but the amendments are not in it, so no amended clause can be reviewed. Ask for them.`);
    }
    cannotCompare.push(
      `The standard wording of ${form} is not held on the platform, so only what the pack itself states is reviewed here; anything it leaves to the standard form is reviewed against your own copy.`,
    );
  }

  const counts = {
    severe: rows.filter((row) => row.severity === 'SEVERE').length,
    material: rows.filter((row) => row.severity === 'MATERIAL').length,
    legal: rows.filter((row) => row.review.includes('LEGAL')).length,
    insurance: rows.filter((row) => row.review.includes('INSURANCE')).length,
    finance: rows.filter((row) => row.review.includes('FINANCE')).length,
  };
  return {
    ...(contract?.form ? { form: contract.form } : {}),
    ...(contract?.edition ? { edition: contract.edition } : {}),
    options: contract?.options ?? [],
    rows,
    notStated,
    cannotCompare,
    counts,
    summary:
      rows.length === 0
        ? 'No contract clause has been read from the pack yet.'
        : `${rows.length} clause(s) read: ${counts.severe} severe, ${counts.material} material. Needs review — legal ${counts.legal}, insurance ${counts.insurance}, finance ${counts.finance}. ` +
          `${notStated.filter((entry) => WHY_IT_MATTERS[entry.topic]).length} key topic(s) the pack does not state.`,
  };
}

export function contractReviewForProject(ctx: EngineContext): ContractReview & { analysisId?: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const { analysisId, particulars } = projectTender(ctx);
  return { ...reviewContract(particulars), ...(analysisId ? { analysisId } : {}) };
}

/**
 * The project's open tender review, or one opened from the pack: the form and
 * edition it names, the edition supplied where it names none. One rule for every
 * part of the reading that goes onto the review — the contract, the scope.
 */
export function tenderReviewForPack(
  ctx: EngineContext,
  particulars: TenderParticulars | undefined,
  edition: string | undefined,
  title: string,
): { reviewId: string; reference: string; opened: boolean } {
  const open = ctx.ledger
    .list(ctx.projectId, 'TenderReview')
    .map((record) => record.state)
    .filter((state) => state.status === 'OPEN')
    .at(-1);
  if (open) return { reviewId: String(open.id), reference: String(open.reference), opened: false };
  const contract = particulars?.contract;
  const named = (edition ?? contract?.edition ?? '').trim();
  if (!contract?.form || !named) {
    throw new DomainError(
      'CONTRACT_FORM_REQUIRED',
      contract?.form
        ? `The pack names ${contract.form} but not its edition. Give the edition — it changes what the clauses say.`
        : 'The pack does not name the form of contract. Ask the buyer, or open the tender review by hand with the form and edition.',
      422,
      [{ field: 'edition', message: 'the edition, e.g. 2016 or June 2017 (amended January 2023)' }],
    );
  }
  const created = openReview(ctx, { title, form: { suite: contract.form, edition: named, amendmentsStated: contract.amendmentsStated === true } });
  return { reviewId: created.reviewId, reference: created.reference, opened: true };
}

const CATEGORY: Record<ClauseTopic, ContractObligation['category']> = {
  PAYMENT_CERTIFICATION: 'PAYMENT',
  RETENTION_RELEASE: 'PAYMENT',
  SET_OFF: 'PAYMENT',
  PRICE_ADJUSTMENT: 'PAYMENT',
  LIQUIDATED_DAMAGES: 'DELAY',
  SECTIONAL_COMPLETION: 'DELAY',
  EXTENSION_OF_TIME: 'DELAY',
  NOTICES: 'DEADLINE',
  VARIATIONS_COMPENSATION_EVENTS: 'CHANGE',
  INSURANCE: 'INSURANCE',
  BONDS_GUARANTEES: 'SECURITY',
  DESIGN_LIABILITY: 'LIABILITY',
  LIABILITY_CAP: 'LIABILITY',
  INDEMNITIES: 'LIABILITY',
  WARRANTIES: 'LIABILITY',
  TERMINATION: 'LIABILITY',
  DEFECTS: 'LIABILITY',
  INSOLVENCY: 'LIABILITY',
};

/**
 * Put the clauses read from the pack into the project's tender review, for a
 * legal or commercial owner to accept or reject each reading.
 *
 * Only a clause whose passage was found in the documents goes in, with that
 * passage as the verbatim wording — the review's rule is that the executed
 * wording is carried beside the interpretation, and a clause nobody can find in
 * the contract cannot be argued from. A clause already on the review is not
 * added twice. The review is opened with the form and edition the pack names;
 * where it names no edition, the person supplies it.
 */
export function draftContractReview(
  ctx: EngineContext,
  input: { edition?: string; owner?: string },
): { reviewId: string; reference: string; opened: boolean; recorded: number; skipped: Array<{ title: string; why: string }> } {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });
  const { particulars } = projectTender(ctx);
  const contract = particulars?.contract;
  if (!contract || contract.clauses.length === 0) {
    throw new DomainError(
      'NO_CONTRACT_READ',
      'No contract clause has been read from the pack on this project. Read the pack, or record the review by hand.',
      409,
    );
  }
  const { reviewId, reference, opened } = tenderReviewForPack(ctx, particulars, input.edition, 'Contract review, from the tender reading');

  const existing = ((ctx.ledger.require({ refType: 'TenderReview', refId: reviewId }).state.obligations as ContractObligation[] | undefined) ?? []).map(
    (obligation) => obligation.reference,
  );
  const skipped: Array<{ title: string; why: string }> = [];
  const obligations: Array<Omit<ContractObligation, 'status' | 'reviewedBy' | 'reviewedAt'>> = [];
  for (const clause of contract.clauses) {
    const assessed = assessClause(clause);
    const obligationReference = `C-${clause.clause ?? clause.topic}`;
    if (existing.includes(obligationReference) || obligations.some((entry) => entry.reference === obligationReference)) continue;
    if (!clause.source?.located || !clause.source.quote) {
      skipped.push({ title: assessed.title, why: 'its passage was not found in the documents, so there is no wording to carry' });
      continue;
    }
    obligations.push({
      reference: obligationReference,
      clause: clause.clause ?? assessed.title,
      ...(clause.source.page !== undefined ? { page: clause.source.page } : {}),
      wording: clause.source.quote,
      interpretation: `${assessed.effect} (${assessed.severity.toLowerCase()}${assessed.review.length > 0 ? `; needs ${assessed.review.join(', ').toLowerCase()} review` : ''})`,
      category: CATEGORY[clause.topic],
      response:
        assessed.severity === 'SEVERE'
          ? 'CLARIFICATION'
          : assessed.affects.includes('PROGRAMME')
            ? 'PROGRAMMED'
            : assessed.affects.includes('COST') || assessed.affects.includes('CASH')
              ? 'PRICED'
              : 'ACCEPTED_RISK',
      owner: input.owner?.trim() || (assessed.review.includes('LEGAL') ? 'Legal reviewer' : 'Commercial manager'),
    });
  }
  const recorded = obligations.length > 0 ? interpretContract(ctx, reviewId, obligations).recorded - existing.length : 0;
  return { reviewId, reference, opened, recorded, skipped };
}
