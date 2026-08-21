import type { ACUEntry } from './acu.ts';

/**
 * AI spend across every tenancy, for the operator.
 *
 * Each tenant's wallet already knows its own position. Nothing put those
 * positions side by side, which left the platform centre unable to answer the
 * one question the commercial model depends on: is the estate spending faster
 * than it is being paid for, and which tenant runs out first.
 *
 * Four figures, and each is a different question.
 *
 * **Runway** is per tenant and is the only one that is urgent. A tenant whose
 * available balance divides into its daily burn in three days has an AI service
 * that stops on Thursday, and the operator would rather know on Monday. Runway
 * is `Infinity` where a tenant is not spending — correct, and rendered as "not
 * spending" rather than as a large number.
 *
 * **Realised margin** is estate-wide and is the one that is easy to get wrong.
 * The configured multiplier says what a charge *should* be; the realised figure
 * says what it *was*, and the two diverge through volume incentives, refunds
 * and any charge that was raised at one multiplier and settled at another. A
 * platform that reports its configured multiplier as its margin is reporting an
 * intention.
 *
 * **Absorbed margin** is the one that explains the other two. `settle()` caps a
 * charge at the amount held, so a customer is never billed above what was
 * reserved and disclosed — which means an execution that overruns its estimate
 * costs the platform the difference. Verified against the seeded estate the
 * first time this ran: a configured 4x realised as 3.787x, with the gap
 * entirely accounted for by that cap. It is an estimation-quality signal, not a
 * leak, and without it the low realised multiplier invites the wrong diagnosis.
 *
 * **Concentration** is estate-wide and is the one nobody asks for. A platform
 * where one tenant is most of the AI revenue has a different risk profile from
 * one where it is spread, and the arithmetic is identical either way — only the
 * share reveals it.
 *
 * ---
 *
 * This module holds no policy. It does not decide what to do about a short
 * runway or a thin margin; it computes and returns. Suspension, alerting and
 * cap enforcement live where they already live.
 */

export type TenantBurn = {
  tenantId: string;
  legalName: string;
  availableMinor: number;
  /** Charged to the customer over the window. */
  billedMinor: number;
  /** What the providers actually cost over the window. */
  rawCostMinor: number;
  /** Average charge per day over the window. Zero where nothing was spent. */
  dailyBurnMinor: number;
  /**
   * Days of AI service left at the current rate, or `null` where the tenant is
   * not spending. Null rather than Infinity: a JSON response has no Infinity,
   * and a very large number reads as a healthy runway rather than as no data.
   */
  runwayDays: number | null;
  /** Realised multiplier for this tenant: billed ÷ raw cost over the window. */
  realisedMultiplier: number | null;
  /**
   * Margin the platform gave up because an execution overran its estimate.
   *
   * `settle()` caps a charge at the amount held, so a customer is never billed
   * above what was reserved and disclosed. That is the right commercial policy
   * and it has a cost, and until this figure existed the cost was invisible:
   * the estate's realised multiplier simply read below the configured one with
   * no explanation, which invites the wrong conclusion — that the multiplier is
   * misconfigured — and the wrong fix.
   *
   * It is an estimation-quality signal, not a leak. A large figure means the
   * estimator is running low, not that anybody is being undercharged.
   */
  absorbedMinor: number;
};

export type EstateBurn = {
  windowDays: number;
  from: string;
  to: string;
  billedMinor: number;
  rawCostMinor: number;
  marginMinor: number;
  /** Estate-wide billed ÷ raw. Null where nothing was spent — not 1, and not 0. */
  realisedMultiplier: number | null;
  /** Margin given up to the estimate cap across the estate. See `TenantBurn`. */
  absorbedMinor: number;
  dailyBurnMinor: number;
  /** Share of billed revenue from the largest single tenant, 0–1. */
  concentration: number | null;
  /** Tenants whose service stops within the window at the current rate. */
  runningOut: TenantBurn[];
  tenants: TenantBurn[];
};

/** Charges only. Top-ups and grants are money in, not spend. */
function isSpend(entry: ACUEntry): boolean {
  return entry.type === 'DEBIT';
}

export function estateBurn(
  tenants: ReadonlyArray<{ tenantId: string; legalName: string; availableMinor: number; entries: readonly ACUEntry[] }>,
  windowDays = 30,
  now = new Date(),
): EstateBurn {
  const to = now.toISOString();
  const from = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const rows: TenantBurn[] = tenants.map((tenant) => {
    const spend = tenant.entries.filter((entry) => isSpend(entry) && entry.timestamp >= from && entry.timestamp <= to);
    const billedMinor = spend.reduce((sum, entry) => sum + entry.billedMinor, 0);
    const rawCostMinor = spend.reduce((sum, entry) => sum + entry.rawCostMinor, 0);
    const dailyBurnMinor = billedMinor / windowDays;

    // What the charge would have been at each entry's own multiplier, against
    // what was actually taken. Per entry rather than on the totals, because the
    // multiplier can differ between entries under a volume incentive and
    // reconstructing it from a total would attribute the difference wrongly.
    const absorbedMinor = spend.reduce(
      (sum, e) => sum + Math.max(0, Math.ceil(e.rawCostMinor * e.effectiveMultiplier) - e.billedMinor),
      0,
    );

    return {
      tenantId: tenant.tenantId,
      legalName: tenant.legalName,
      availableMinor: tenant.availableMinor,
      billedMinor,
      rawCostMinor,
      dailyBurnMinor: Math.round(dailyBurnMinor),
      // A tenant not spending has no runway to report, and reporting a huge
      // number would read as the healthiest account on the estate.
      runwayDays: dailyBurnMinor > 0 ? Math.floor(tenant.availableMinor / dailyBurnMinor) : null,
      realisedMultiplier: rawCostMinor > 0 ? Number((billedMinor / rawCostMinor).toFixed(3)) : null,
      absorbedMinor,
    };
  });

  const billedMinor = rows.reduce((sum, row) => sum + row.billedMinor, 0);
  const rawCostMinor = rows.reduce((sum, row) => sum + row.rawCostMinor, 0);
  const largest = rows.reduce((most, row) => Math.max(most, row.billedMinor), 0);

  return {
    windowDays,
    from,
    to,
    billedMinor,
    rawCostMinor,
    marginMinor: billedMinor - rawCostMinor,
    absorbedMinor: rows.reduce((sum, row) => sum + row.absorbedMinor, 0),
    realisedMultiplier: rawCostMinor > 0 ? Number((billedMinor / rawCostMinor).toFixed(3)) : null,
    dailyBurnMinor: Math.round(billedMinor / windowDays),
    concentration: billedMinor > 0 ? Number((largest / billedMinor).toFixed(3)) : null,
    // Shortest runway first — this is a queue of work, not a report.
    runningOut: rows
      .filter((row) => row.runwayDays !== null && row.runwayDays <= windowDays)
      .sort((a, b) => (a.runwayDays ?? 0) - (b.runwayDays ?? 0)),
    // Biggest spender first: the operator's estate view is read top-down.
    tenants: [...rows].sort((a, b) => b.billedMinor - a.billedMinor),
  };
}
