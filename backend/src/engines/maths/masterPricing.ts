/**
 * Master pricing: the sum that actually goes out, and where each part of it
 * came from.
 *
 * Tender stage six, and the one that decides whether a bid is a price or a
 * hope. Every package has taken one of two routes — priced in-house, or sent to
 * the market — and both converge here. The consolidation is arithmetic; the
 * value is in what it finds while doing it, because each of these is a way to
 * lose money that nobody notices until the job is running.
 *
 * **Scope priced by nobody.** A package routed to the market that nothing came
 * back for, or one nobody routed at all. It goes out at zero and gets built for
 * nothing. This is the expensive one and it is invisible in a spreadsheet that
 * sums what is there.
 *
 * **Scope priced twice.** A package with a self-price *and* an award, both
 * carried. The bid is uncompetitive by exactly that amount and nobody can see
 * why it lost.
 *
 * **Exclusions inside a price.** The supplier's number is firm for what it
 * covers and silent about what it excludes. Those exclusions are somebody's
 * cost — usually the main contractor's — and they are carried here as items to
 * confirm rather than checked, because checking whether an exclusion is priced
 * elsewhere means reading two documents and this platform will not pretend it
 * did.
 *
 * **Provisional sums inside a firm price.** A price with a provisional sum in it
 * is not a firm price for that part, and a tender total that treats it as one
 * understates the risk being taken.
 *
 * Where a package has both a self-price and a market return, the difference is
 * reported rather than resolved. Which one goes in the bid is a commercial
 * decision, and the platform's job is to make sure it is a decision rather than
 * an accident of which number happened to be in the spreadsheet.
 */

export type PricingRoute = 'SUPPLY_CHAIN' | 'SELF_PRICE';

export type SchedulePricing = {
  scheduleId: string;
  packageId: string;
  packageName: string;
  route?: PricingRoute;
  /** The in-house price for this package, where one exists. */
  selfPricedMinor?: number;
  /** The awarded market price, where one exists. */
  awardedMinor?: number;
  awardedSupplier?: string;
  /** Provisional sums inside the awarded price. Firm for everything but these. */
  provisionalSumsMinor?: number;
  exclusions?: string[];
};

export type PricingFindingKind =
  | 'UNPRICED'
  | 'DOUBLE_COUNTED'
  | 'ROUTE_UNASSIGNED'
  | 'EXCLUSIONS_CARRIED'
  | 'PROVISIONAL_SUM'
  | 'MARKET_VARIANCE';

export type PricingFinding = {
  kind: PricingFindingKind;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  packageId: string;
  packageName: string;
  /** The money at stake, where it can be stated. Absent where it cannot. */
  amountMinor?: number;
  finding: string;
  consequence: string;
};

export type MasterPricing = {
  packages: number;
  /** The sum that goes out, once each package is taken from its own route. */
  totalMinor: number;
  selfPricedMinor: number;
  marketPricedMinor: number;
  /** Inside the total, not additional to it. */
  provisionalSumsMinor: number;
  unpricedPackages: number;
  findings: PricingFinding[];
  lines: Array<{
    packageId: string;
    packageName: string;
    route?: PricingRoute;
    source: 'SELF_PRICE' | 'MARKET' | 'NONE';
    amountMinor: number;
    supplier?: string;
  }>;
  summary: string;
};

/**
 * Which figure counts for a package.
 *
 * The route decides, not whichever number is larger or more recent. A package
 * sent to the market is carried at the market price even where an in-house
 * estimate exists — that estimate was the budget the enquiry was measured
 * against, and carrying it instead would put a number in the bid that nobody
 * has agreed to do the work for.
 */
function chosenPrice(pricing: SchedulePricing): { source: 'SELF_PRICE' | 'MARKET' | 'NONE'; amountMinor: number } {
  if (pricing.route === 'SUPPLY_CHAIN') {
    return pricing.awardedMinor === undefined
      ? { source: 'NONE', amountMinor: 0 }
      : { source: 'MARKET', amountMinor: pricing.awardedMinor };
  }
  if (pricing.route === 'SELF_PRICE') {
    return pricing.selfPricedMinor === undefined
      ? { source: 'NONE', amountMinor: 0 }
      : { source: 'SELF_PRICE', amountMinor: pricing.selfPricedMinor };
  }
  // No route assigned. Whatever price exists is not being carried on purpose,
  // so it is not carried at all — a total assembled from prices nobody routed
  // is a total nobody can defend.
  return { source: 'NONE', amountMinor: 0 };
}

export function consolidate(pricings: SchedulePricing[]): MasterPricing {
  const findings: PricingFinding[] = [];
  const lines: MasterPricing['lines'] = [];

  let totalMinor = 0;
  let selfPricedMinor = 0;
  let marketPricedMinor = 0;
  let provisionalSumsMinor = 0;
  let unpricedPackages = 0;

  for (const pricing of pricings) {
    const { source, amountMinor } = chosenPrice(pricing);
    lines.push({
      packageId: pricing.packageId,
      packageName: pricing.packageName,
      route: pricing.route,
      source,
      amountMinor,
      supplier: source === 'MARKET' ? pricing.awardedSupplier : undefined,
    });

    totalMinor += amountMinor;
    if (source === 'SELF_PRICE') selfPricedMinor += amountMinor;
    if (source === 'MARKET') {
      marketPricedMinor += amountMinor;
      provisionalSumsMinor += pricing.provisionalSumsMinor ?? 0;
    }

    if (source === 'NONE') {
      unpricedPackages += 1;
      findings.push(
        pricing.route === undefined
          ? {
              kind: 'ROUTE_UNASSIGNED',
              severity: 'CRITICAL',
              packageId: pricing.packageId,
              packageName: pricing.packageName,
              finding: 'No pricing route has been assigned to this package.',
              consequence:
                'It is in nobody’s number. Whether it is priced in-house or bought is a decision that has not been taken, and the tender total does not include it either way.',
            }
          : {
              kind: 'UNPRICED',
              severity: 'CRITICAL',
              packageId: pricing.packageId,
              packageName: pricing.packageName,
              finding:
                pricing.route === 'SUPPLY_CHAIN'
                  ? 'Routed to the market and nothing has been awarded.'
                  : 'Routed to self-perform and no estimate exists.',
              consequence:
                'This scope goes out at zero. It is the most expensive thing on this page, because it is built at the contractor’s cost and nobody finds it until somebody starts the work.',
            },
      );
    }

    // Both prices present. Only one is carried, but the other one existing is
    // worth saying: it is either a check on the market or a number somebody is
    // about to add by hand.
    if (pricing.selfPricedMinor !== undefined && pricing.awardedMinor !== undefined) {
      const variance = pricing.selfPricedMinor - pricing.awardedMinor;
      findings.push({
        kind: 'MARKET_VARIANCE',
        severity: 'INFO',
        packageId: pricing.packageId,
        packageName: pricing.packageName,
        amountMinor: Math.abs(variance),
        // No figure in the prose. This module does not know the currency and
        // has no business formatting money; the amount is on the finding and
        // the caller shows it in the reader's own currency.
        finding:
          variance > 0
            ? 'The market came in under the in-house estimate.'
            : variance < 0
              ? 'The market came in over the in-house estimate.'
              : 'The market and the in-house estimate agree exactly.',
        consequence:
          variance > 0
            ? 'Carried at the market price, which is the one somebody has agreed to. The difference is margin or a lower bid, and which of those it becomes is a decision rather than an accident.'
            : 'Carried at the market price. The estimate that lost the difference is the one the enquiry was measured against, so the gap is worth understanding before the next enquiry of the same kind.',
      });
    }

    if (source === 'MARKET' && (pricing.provisionalSumsMinor ?? 0) > 0) {
      findings.push({
        kind: 'PROVISIONAL_SUM',
        severity: 'WARNING',
        packageId: pricing.packageId,
        packageName: pricing.packageName,
        amountMinor: pricing.provisionalSumsMinor,
        finding: 'The awarded price contains a provisional sum.',
        consequence:
          'Firm for everything but that. A tender total treating it as fixed understates the risk, and the sum is expended against actual cost rather than the figure carried.',
      });
    }

    if (source === 'MARKET' && (pricing.exclusions ?? []).length > 0) {
      findings.push({
        kind: 'EXCLUSIONS_CARRIED',
        severity: 'WARNING',
        packageId: pricing.packageId,
        packageName: pricing.packageName,
        finding: `The awarded price excludes: ${(pricing.exclusions ?? []).join('; ')}.`,
        consequence:
          'Each exclusion is somebody’s cost, usually the main contractor’s. Confirm each is priced elsewhere — this is listed rather than checked, because checking means reading two documents and the platform has not read them.',
      });
    }
  }

  const critical = findings.filter((f) => f.severity === 'CRITICAL');

  const summary =
    pricings.length === 0
      ? 'No pricing schedule has been routed.'
      : critical.length > 0
        ? `${critical.length} package${critical.length === 1 ? '' : 's'} carry no price at all. The total below excludes them, which is what the bid would do.`
        : provisionalSumsMinor > 0
          ? 'Every package is priced, but part of the total is provisional sum rather than firm price.'
          : 'Every package is priced from its assigned route, and the total is firm.';

  return {
    packages: pricings.length,
    totalMinor,
    selfPricedMinor,
    marketPricedMinor,
    provisionalSumsMinor,
    unpricedPackages,
    findings: findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    lines,
    summary,
  };
}

function severityRank(severity: PricingFinding['severity']): number {
  return severity === 'CRITICAL' ? 0 : severity === 'WARNING' ? 1 : 2;
}
