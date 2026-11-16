import { authorise, type EngineContext } from '../engines/context.ts';
import { contractReviewForProject } from './contractreview.ts';
import { pricingSchedule } from './quotation.ts';
import { projectTender, tenderRegister } from './tenderregister.ts';
import { scopeReview } from './tenderscope.ts';

/**
 * The price, checked: whether it can be approved or is still provisional, how
 * its overhead and profit are applied, whether the buyer's schedule adds to the
 * same total, and what the cash does month by month.
 *
 * Everything is read from what the estimate, the pricing schedule and the
 * funding models already hold; nothing is re-priced here. A price is reported as
 * provisional for every reason that stops it being approved — each with the
 * thing to do about it — rather than as a number that only looks final.
 */

export type MonthRow = { month: string; inMinor: number; outMinor: number; netMinor: number; cumulativeMinor: number };

export type PriceCheck = {
  priced: boolean;
  /** The estimate the cash is modelled from. */
  estimateId?: string;
  /** Terms the pack states, offered as the starting point when the cash is modelled — never assumed where it is silent. */
  statedTerms?: { paymentDays?: number; retentionPercent?: number; defectsLiabilityWeeks?: number };
  totalMinor?: number;
  currency: string;
  status: 'NOT_PRICED' | 'PROVISIONAL' | 'READY_FOR_APPROVAL';
  /** Why it is provisional, each with what clears it. */
  provisional: Array<{ reason: string; clears: string }>;
  /** Overhead and profit, said both ways. */
  markup?: { overheadPercent: number; profitPercent: number; onCostPercent: number; marginOnPricePercent: number; ohpShareOfPricePercent: number; statement: string };
  /** The buyer's schedule against the internal total. */
  reconciliation?: { scheduleTotalMinor: number; estimateTotalMinor: number; differenceMinor: number; statement: string };
  cash?: { months: MonthRow[]; peakMinor: number; peakMonth: string; headroomMinor?: number; scenarios: Array<{ durationWeeks: number; peakMinor: number; headroomMinor?: number; verdict: string }> };
  summary: string;
};

const MONTH = (iso: string): string => iso.slice(0, 7);

export function priceCheck(ctx: EngineContext): PriceCheck {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const estimates = ctx.ledger.list(ctx.projectId, 'Estimate').map((record) => record.state);
  const latest = estimates.at(-1);
  const currency = String(latest?.currency ?? 'GBP');
  if (!latest) {
    return { priced: false, currency, status: 'NOT_PRICED', provisional: [], summary: 'The job has not been priced.' };
  }

  const provisional: PriceCheck['provisional'] = [];
  const omissions = (latest.omissions as Array<string | { label?: string; head?: string; reason?: string }> | undefined) ?? [];
  for (const omission of omissions) {
    // A head code ("SUBCONTRACT") read as words.
    const words = (text: string): string => (/^[A-Z_]+$/.test(text) ? text.toLowerCase().replace(/_/g, ' ') : text);
    const what = typeof omission === 'string' ? words(omission) : `${words(omission.label ?? omission.head ?? 'A cost head')}${omission.reason ? `: ${omission.reason}` : ''}`;
    provisional.push({ reason: `Not priced in the estimate — ${what.replace(/[.\s]+$/, '')}.`, clears: 'Price it, or exclude it on the record.' });
  }
  const scope = scopeReview(ctx);
  for (const row of scope.rows.filter((entry) => entry.pricing === 'NOT_PRICED')) {
    provisional.push({ reason: `${row.description} (${row.reference}) is priced nowhere in the documents.`, clears: 'Price it, or confirm with the buyer that it is excluded.' });
  }
  for (const row of scope.discrepancies.filter((entry) => entry.clarification?.status !== 'ANSWERED')) {
    provisional.push({ reason: `The documents disagree on ${row.subject.toLowerCase()} (${row.id}).`, clears: 'Price on the stricter reading until the buyer rules.' });
  }
  const register = tenderRegister(ctx);
  for (const missing of [...register.notSupplied, ...register.listedNotUploaded]) {
    provisional.push({ reason: `${missing.title} is not in the pack, so what it says is not in the price.`, clears: 'Obtain it and read it with the pack.' });
  }
  const open = ctx.ledger
    .list(ctx.projectId, 'Clarification')
    .map((record) => record.state)
    .filter((state) => state.side === 'CLIENT' && state.status === 'OPEN' && (state.urgency === 'CRITICAL' || state.urgency === 'HIGH'));
  for (const question of open) {
    provisional.push({
      reason: `${String(question.reference)} is unanswered${question.interimTreatment ? `; priced meanwhile as: ${String(question.interimTreatment).replace(/[.\s]+$/, '')}` : ''}.`,
      clears: 'Revisit the price when the buyer answers.',
    });
  }
  const contract = contractReviewForProject(ctx);
  for (const row of contract.rows.filter((entry) => entry.severity === 'SEVERE')) {
    provisional.push({ reason: `${row.title}: ${row.effect}`, clears: 'Price the risk, or settle it on the tender review.' });
  }

  const model = latest.model as { margin?: { overheadPercent: number; profitPercent: number } } | undefined;
  const heads = (latest.heads as Array<{ head: string; amountMinor: number }> | undefined) ?? [];
  const total = Number(latest.totalMinor ?? 0);
  const amount = (head: string): number => heads.find((entry) => entry.head === head)?.amountMinor ?? 0;
  let markup: PriceCheck['markup'];
  if (model?.margin && total > 0) {
    const { overheadPercent, profitPercent } = model.margin;
    const onCost = ((1 + overheadPercent / 100) * (1 + profitPercent / 100) - 1) * 100;
    const marginOnPrice = (amount('PROFIT') / total) * 100;
    const ohpShare = ((amount('OVERHEAD') + amount('PROFIT')) / total) * 100;
    const round = (value: number): number => Math.round(value * 100) / 100;
    markup = {
      overheadPercent,
      profitPercent,
      onCostPercent: round(onCost),
      marginOnPricePercent: round(marginOnPrice),
      ohpShareOfPricePercent: round(ohpShare),
      statement:
        `Overhead is ${overheadPercent}% of total cost and profit ${profitPercent}% of cost plus overhead — both markups on cost, ` +
        `${round(onCost)}% on cost together. As a margin on the selling price, profit is ${round(marginOnPrice)}% of the tender total ` +
        `and overhead with profit ${round(ohpShare)}%. Fixed and provisional sums are added after, unmarked.`,
    };
  }

  let reconciliation: PriceCheck['reconciliation'];
  if (omissions.length === 0) {
    try {
      const schedule = pricingSchedule(ctx);
      const difference = schedule.totalMinor - total;
      reconciliation = {
        scheduleTotalMinor: schedule.totalMinor,
        estimateTotalMinor: total,
        differenceMinor: difference,
        statement:
          difference === 0
            ? 'The buyer’s schedule adds to the internal total.'
            : `The buyer’s schedule is ${difference > 0 ? 'over' : 'under'} the internal total by ${Math.abs(difference) / 100} — find it before the price is approved.`,
      };
    } catch {
      // No schedule can be built from this estimate; said by its absence.
    }
  }

  // The cash, month by month, from the latest funding model on this estimate.
  const fundings = ctx.ledger.list(ctx.projectId, 'FundingModel').map((record) => record.state);
  const latestFunding = fundings.at(-1);
  let cash: PriceCheck['cash'];
  if (latestFunding) {
    const periods = (latestFunding.periods as Array<{ week: number; cashInMinor: number; cashOutMinor: number; netMinor: number; cumulativeMinor: number }> | undefined) ?? [];
    const programme = ctx.ledger
      .list(ctx.projectId, 'TenderProgrammeDraft')
      .map((record) => record.state)
      .filter((state) => state.status === 'CONFIRMED')
      .at(-1);
    const start = (programme?.startDate as string | undefined) ?? projectTender(ctx).particulars?.worksStartOn;
    const monthOf = (week: number): string =>
      start ? MONTH(new Date(Date.parse(`${start.slice(0, 10)}T00:00:00Z`) + (week - 1) * 7 * 86_400_000).toISOString()) : `Month ${Math.ceil((week * 7) / 30.44)}`;
    const months = new Map<string, MonthRow>();
    for (const period of periods) {
      const key = monthOf(period.week);
      const row = months.get(key) ?? { month: key, inMinor: 0, outMinor: 0, netMinor: 0, cumulativeMinor: 0 };
      row.inMinor += period.cashInMinor;
      row.outMinor += period.cashOutMinor;
      row.netMinor += period.netMinor;
      row.cumulativeMinor = period.cumulativeMinor;
      months.set(key, row);
    }
    const rows = [...months.values()];
    const peak = rows.reduce((worst, row) => (row.cumulativeMinor < worst.cumulativeMinor ? row : worst), rows[0] ?? { month: '—', cumulativeMinor: 0 } as MonthRow);
    cash = {
      months: rows,
      peakMinor: Number(latestFunding.peakFundingRequirementMinor ?? 0),
      peakMonth: peak.month,
      ...(latestFunding.headroomMinor !== undefined && latestFunding.headroomMinor !== null ? { headroomMinor: Number(latestFunding.headroomMinor) } : {}),
      // Every funding model on the project is a scenario: a different duration, different terms.
      scenarios: fundings.map((funding) => ({
        durationWeeks: Number(funding.durationWeeks ?? 0),
        peakMinor: Number(funding.peakFundingRequirementMinor ?? 0),
        ...(funding.headroomMinor !== undefined && funding.headroomMinor !== null ? { headroomMinor: Number(funding.headroomMinor) } : {}),
        verdict: String(funding.verdict ?? 'UNKNOWN'),
      })),
    };
  }

  // The terms the pack states, as the starting point for the cash model.
  const stated = projectTender(ctx).particulars?.contract?.clauses ?? [];
  const valueOf = (topic: string, unit: RegExp): number | undefined =>
    stated.find((entry) => entry.topic === topic && entry.value !== undefined && unit.test(entry.unit ?? ''))?.value;
  const paymentDays = valueOf('PAYMENT_CERTIFICATION', /^day/i);
  const retentionPercent = valueOf('RETENTION_RELEASE', /%|per/i);
  const defectsWeeks = valueOf('DEFECTS', /^week/i);
  const defectsMonths = valueOf('DEFECTS', /^month/i);
  const statedTerms = {
    ...(paymentDays !== undefined ? { paymentDays } : {}),
    ...(retentionPercent !== undefined ? { retentionPercent } : {}),
    ...(defectsWeeks !== undefined
      ? { defectsLiabilityWeeks: defectsWeeks }
      : defectsMonths !== undefined
        ? { defectsLiabilityWeeks: Math.round(defectsMonths * 4.345) }
        : {}),
  };

  const status: PriceCheck['status'] = provisional.length > 0 ? 'PROVISIONAL' : 'READY_FOR_APPROVAL';
  // The cash is modelled on the latest estimate even while the price is provisional — the
  // reasons it is provisional are listed above it, and the cash a job needs is a decision input either way.
  return {
    priced: true,
    estimateId: String(latest.id),
    ...(Object.keys(statedTerms).length > 0 ? { statedTerms } : {}),
    totalMinor: total,
    currency,
    status,
    provisional,
    ...(markup ? { markup } : {}),
    ...(reconciliation ? { reconciliation } : {}),
    ...(cash ? { cash } : {}),
    summary:
      status === 'PROVISIONAL'
        ? `Provisional: ${provisional.length} reason(s) the price cannot be approved yet.`
        : 'Every reason a price is provisional has cleared: it is ready for commercial approval.' +
          (cash ? '' : ' The cash it needs has not been modelled.'),
  };
}
