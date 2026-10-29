import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { liveProjects } from './structure.ts';

/**
 * The cost intelligence database.
 *
 * It does not invent prices. It organises the ones the business has already
 * paid, quoted or been quoted, and reports what they actually say — including
 * when they do not say enough to be worth listening to.
 *
 * **It is a projection, not a store.** Every rate here is read from records
 * already committed to the Golden Thread: estimate lines carry a unit, a
 * quantity and a rate; supplier submissions and executed subcontracts carry
 * package prices. Nothing is entered twice, so nothing can drift, and a rate
 * cannot exist here that was not part of a real commercial position somebody
 * signed off.
 *
 * **A package price is never converted into a unit rate.** A subcontract for
 * £820,000 of groundworks covers dozens of measured items and there is no
 * honest way to apportion it back to a rate per cubic metre. Doing so is the
 * commonest way a "cost database" fills up with numbers that look precise and
 * mean nothing. So the two kinds of observation are kept apart: unit rates from
 * estimates, package outturns from the market.
 *
 * **Every figure carries how much is behind it.** A median of two observations
 * is not a benchmark, and a rate library nobody has added to since 2024 is
 * worse than none because it is trusted. So `n`, the spread and the age of the
 * newest observation travel with every answer, and confidence is stated rather
 * than implied.
 *
 * The most valuable output is the one only accumulation can give: how far the
 * business's own estimates sit from what the market actually returns. That is a
 * correction factor no rate book can supply, because it is a fact about this
 * contractor rather than about construction.
 */

// --- Observations -------------------------------------------------------------------

export type RateObservation = {
  /** Normalised description, used to group like with like. */
  key: string;
  description: string;
  unit: string;
  /** Rate per unit in minor units, all cost components combined. */
  rateMinor: number;
  quantity: number;
  /** Split, so labour-heavy and supply-heavy items can be told apart. */
  components: { labourMinor: number; materialMinor: number; plantMinor: number; subcontractMinor: number };
  projectId: string;
  projectName: string;
  /** The estimate this rate came from, so a benchmark can exclude itself. */
  estimateId: string;
  observedOn: string;
  /**
   * Where the observation came from, and the one thing a reader must be able to
   * tell about a rate:
   *
   *   - `ESTIMATE` — a rate the business committed on a frozen estimate, priced
   *     by somebody and approved by somebody else. The only defensible evidence
   *     of what this contractor actually charges.
   *   - `IMPORTED` — a figure the firm typed into its own rate card and loaded
   *     here to seed the library. It is the firm's *own* number — consistent
   *     with this platform's "own committed records, not a bought index"
   *     principle — but it is a starting point, not a rate proven on a bid, and
   *     it is kept distinct for exactly that reason. See `confidenceCap` and
   *     `harvestImportedRates` for the honesty guard that stops an imported rate
   *     ever manufacturing confidence beyond a single THIN data point.
   */
  source: 'ESTIMATE' | 'IMPORTED';
  /** The firm's own reference for an imported rate, carried through untouched. */
  code?: string;
  /** A free note attached to an imported rate card line. */
  note?: string;
};

export type PackageOutturn = {
  packageId: string;
  projectId: string;
  projectName: string;
  /** What the business estimated the package at, where an estimate exists. */
  estimatedMinor?: number;
  /** What the market actually returned — the accepted or executed figure. */
  marketMinor: number;
  supplierName: string;
  /** Market against estimate. Positive means the market came in above. */
  variancePercent?: number;
  observedOn: string;
  source: 'SUBCONTRACT' | 'SUBMISSION';
};

/** How much weight a figure can carry, stated rather than implied. */
export type Confidence = 'NONE' | 'THIN' | 'USABLE' | 'STRONG';

export const CONFIDENCE_THRESHOLDS = { thin: 1, usable: 3, strong: 8 } as const;

export function confidenceFor(observations: number): Confidence {
  if (observations < CONFIDENCE_THRESHOLDS.thin) return 'NONE';
  if (observations < CONFIDENCE_THRESHOLDS.usable) return 'THIN';
  if (observations < CONFIDENCE_THRESHOLDS.strong) return 'USABLE';
  return 'STRONG';
}

/**
 * Confidence for a bucket of observations, with the imported-rate honesty guard.
 *
 * **The rule imported rates must never break.** A figure the firm typed into
 * its own rate card is a starting point, not a rate proven on a committed bid.
 * So confidence is governed by the **committed** observations alone — an
 * imported rate never adds to it. The one thing it may do is establish a THIN
 * floor where there is no committed history at all, so a one-person firm's
 * first bid prices against a stated starting point rather than a blank box.
 *
 *   - 0 committed, any imported  → THIN (a starting point, said so plainly)
 *   - N committed, any imported  → `confidenceFor(N)` — the imported entry is
 *     shown as provenance and changes the number not at all
 *
 * Re-importing the same key replaces its prior imported entry rather than
 * stacking (see `harvestImportedRates`), so a key holds at most one imported
 * observation however many times it is pasted — and because imported
 * observations are excluded from the count here, even that one cannot move the
 * figure past THIN. Only committed bids do.
 *
 * For a bucket with no imported observations this is exactly `confidenceFor`:
 * `committed === total`, so the guard changes nothing for the estimate-only
 * library that existed before imports.
 */
export function confidenceCap(observations: readonly RateObservation[]): Confidence {
  const committed = observations.filter((observation) => observation.source !== 'IMPORTED').length;
  const base = confidenceFor(committed);
  const hasImported = committed < observations.length;
  // An imported rate lifts an empty key to a THIN starting point and does
  // nothing else: it can never raise confidence a committed bid has not earned.
  if (base === 'NONE' && hasImported) return 'THIN';
  return base;
}

export type RateSummary = {
  key: string;
  description: string;
  unit: string;
  observations: number;
  /** How many of the observations are proven on a committed bid. */
  committedObservations: number;
  /** How many are the firm's own imported rate-card figures (0 or 1 per key). */
  importedObservations: number;
  /**
   * Where the figure stands: `COMMITTED` (proven on bids), `IMPORTED` (a
   * starting rate from the firm's own rate card, not yet proven) or `MIXED`.
   * Carried so the console and any reader can tell a seeded rate from an earned
   * one — an imported rate reads as a starting point, never as history.
   */
  provenance: 'COMMITTED' | 'IMPORTED' | 'MIXED';
  confidence: Confidence;
  medianMinor: number;
  lowMinor: number;
  highMinor: number;
  /** How far the range spreads either side of the median, as a percentage. */
  spreadPercent: number;
  /** Newest observation, so a stale library cannot pass as a current one. */
  newestOn: string;
  ageDays: number;
  projects: number;
  /** Stated plainly where the figure should not be relied on. */
  caveat?: string;
};

const DAY_MS = 86_400_000;

/**
 * Group descriptions that are the same item written by different people.
 *
 * Deliberately crude: lowercase, strip punctuation and collapse whitespace. A
 * clever matcher that merged "excavation in rock" with "excavation in made
 * ground" would produce a median across two different jobs and no way to tell.
 * Under-grouping produces thin data that says so; over-grouping produces
 * confident nonsense.
 */
export function rateKey(description: string, unit: string): string {
  const normalised = description
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${normalised}::${unit.toLowerCase().trim()}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2) : sorted[middle]!;
}

// --- Harvest ------------------------------------------------------------------------

type EstimateLine = {
  description?: string;
  unit?: string;
  quantity?: number;
  rateSource?: string;
  labourRateMinor?: number;
  materialRateMinor?: number;
  plantRateMinor?: number;
  subcontractRateMinor?: number;
};

/**
 * The firm's own rate card, loaded to seed the library.
 *
 * `RATE_CARD_IMPORTED` carries one of these per line. It is the firm's *own*
 * number — not a bought index — stored here so a one-person firm can price its
 * first bid against something instead of a blank box. One record per
 * `rateKey(description, unit)` per tenancy: re-importing a key replaces its
 * entry rather than filing a second, which is half of the honesty guard (the
 * other half is `confidenceCap`).
 */
export type RateCardEntry = {
  id: string;
  key: string;
  description: string;
  unit: string;
  /** Rate per unit in minor units. No component split — a rate card has none. */
  rateMinor: number;
  /** The firm's own reference, optional. */
  code?: string;
  note?: string;
  importedAt: string;
  importedBy: string;
};

/**
 * Read the firm's imported rate-card entries as unit-rate observations.
 *
 * Each becomes a single `IMPORTED` observation at the rate card's figure. They
 * join the unit-rate feed beside the committed estimate rates — same kind of
 * observation, kept apart only by provenance, which is how `confidenceCap`
 * keeps them from ever reading as more than a THIN starting point until a
 * committed bid proves the key.
 */
export function harvestImportedRates(ctx: EngineContext): RateObservation[] {
  const observations: RateObservation[] = [];
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'RateCardEntry')) {
    const entry = record.state as unknown as RateCardEntry;
    if (!entry.description || !entry.unit || !(Number(entry.rateMinor) > 0)) continue;
    observations.push({
      key: entry.key ?? rateKey(entry.description, entry.unit),
      description: entry.description,
      unit: entry.unit,
      rateMinor: Number(entry.rateMinor),
      quantity: 0,
      // A rate card carries an all-in figure and no breakdown. Zeroed rather
      // than apportioned: inventing a labour/material split for a number that
      // never had one is exactly the kind of precise-looking nonsense this
      // module refuses.
      components: { labourMinor: 0, materialMinor: 0, plantMinor: 0, subcontractMinor: 0 },
      // No project: the rate card is the tenancy's, not one job's. Excluded from
      // the project count for that reason.
      projectId: '',
      projectName: 'Rate card',
      // Never a real estimate id, so a benchmark never mistakes an imported rate
      // for one of the estimate's own lines and never excludes it by accident.
      estimateId: `rate-card:${entry.id}`,
      observedOn: String(entry.importedAt ?? '').slice(0, 10) || 'unknown',
      source: 'IMPORTED',
      ...(entry.code ? { code: entry.code } : {}),
      ...(entry.note ? { note: entry.note } : {}),
    });
  }
  return observations;
}

/**
 * Read every unit rate the business has: committed to an estimate, and seeded
 * from its own rate card.
 *
 * Estimates are where a *proven* unit rate lives — a description, a unit, a
 * quantity and a rate somebody priced and somebody else approved. Imported
 * rate-card lines join them as `IMPORTED` observations so the library is not
 * empty on a firm's first bid, tagged so a reader can always tell a seeded
 * starting rate from one earned on a bid. The two kinds of *source* for a unit
 * rate; package outturns from the market stay in their own feed, as ever.
 */
export function harvestRates(ctx: EngineContext): RateObservation[] {
  const observations: RateObservation[] = [];

  for (const project of liveProjects(ctx.ledger, ctx.tenantId)) {
    const projectId = String(project.state.id);
    const projectName = String(project.state.name ?? projectId);

    for (const estimate of ctx.ledger.list(projectId, 'Estimate')) {
      const lines = (estimate.state.lines ?? []) as EstimateLine[];
      const observedOn = String(estimate.state.frozenAt ?? estimate.state.createdAt ?? '').slice(0, 10);

      for (const line of lines) {
        if (!line.description || !line.unit || !line.quantity) continue;
        // A model's view of the market is not this business's own rate, and
        // harvesting it back as one would let a guess become history — more
        // confident every time it is reused, with nothing behind it but the
        // first guess. Excluded here, at the one place "our own rates" is
        // defined.
        if (line.rateSource === 'MARKET_AI') continue;
        const components = {
          labourMinor: line.labourRateMinor ?? 0,
          materialMinor: line.materialRateMinor ?? 0,
          plantMinor: line.plantRateMinor ?? 0,
          subcontractMinor: line.subcontractRateMinor ?? 0,
        };
        const rateMinor =
          components.labourMinor + components.materialMinor + components.plantMinor + components.subcontractMinor;
        if (rateMinor <= 0) continue;

        observations.push({
          key: rateKey(line.description, line.unit),
          description: line.description,
          unit: line.unit,
          rateMinor,
          quantity: line.quantity,
          components,
          projectId,
          projectName,
          estimateId: estimate.refId,
          observedOn: observedOn || 'unknown',
          source: 'ESTIMATE',
        });
      }
    }
  }

  observations.push(...harvestImportedRates(ctx));

  return observations;
}

/**
 * Read what the market actually charged, at package level.
 *
 * An executed subcontract is the strongest evidence a contractor has of what
 * something costs, because somebody signed it. A received submission is weaker
 * — it is an offer, not a price paid — so both are kept with their source
 * rather than merged.
 */
function harvestOutturns(ctx: EngineContext): PackageOutturn[] {
  const outturns: PackageOutturn[] = [];

  for (const project of liveProjects(ctx.ledger, ctx.tenantId)) {
    const projectId = String(project.state.id);
    const projectName = String(project.state.name ?? projectId);

    // The estimate against the package, so market-versus-estimate is real
    // rather than a comparison against a different scope.
    const estimateByPackage = new Map<string, number>();
    for (const estimate of ctx.ledger.list(projectId, 'Estimate')) {
      const packageId = String(estimate.state.packageId ?? '');
      if (packageId) estimateByPackage.set(packageId, Number(estimate.state.totalMinor ?? 0));
    }

    for (const subcontract of ctx.ledger.list(projectId, 'Subcontract')) {
      const marketMinor = Number(subcontract.state.valueMinor ?? 0);
      if (marketMinor <= 0) continue;
      const packageId = String(subcontract.state.packageId ?? '');
      const estimatedMinor = estimateByPackage.get(packageId);

      outturns.push({
        packageId,
        projectId,
        projectName,
        estimatedMinor,
        marketMinor,
        supplierName: String(subcontract.state.supplierName ?? 'unknown'),
        variancePercent:
          estimatedMinor && estimatedMinor > 0
            ? Number((((marketMinor - estimatedMinor) / estimatedMinor) * 100).toFixed(2))
            : undefined,
        observedOn: String(subcontract.state.executedAt ?? subcontract.state.assembledAt ?? '').slice(0, 10) || 'unknown',
        source: 'SUBCONTRACT',
      });
    }
  }

  return outturns;
}

// --- The library --------------------------------------------------------------------

export type CostIntelligence = {
  /** Unit rates the business has used, grouped and summarised. */
  rates: RateSummary[];
  /** Package prices the market has actually returned. */
  outturns: PackageOutturn[];
  totals: { rateObservations: number; distinctItems: number; packages: number; projects: number };
  /**
   * How far this business's estimates sit from the market, across every
   * package where both exist. The one number no rate book can supply, because
   * it is a fact about this contractor rather than about construction.
   */
  estimatingAccuracy?: {
    packages: number;
    medianVariancePercent: number;
    confidence: Confidence;
    reading: string;
  };
  observations: string[];
};

export function costIntelligence(
  ctx: EngineContext,
  filter: { unit?: string; search?: string; today?: string } = {},
): CostIntelligence {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const today = filter.today ?? new Date().toISOString().slice(0, 10);
  const rawRates = harvestRates(ctx);
  const outturns = harvestOutturns(ctx);

  const grouped = new Map<string, RateObservation[]>();
  for (const observation of rawRates) {
    if (filter.unit && observation.unit.toLowerCase() !== filter.unit.toLowerCase()) continue;
    if (filter.search && !observation.description.toLowerCase().includes(filter.search.toLowerCase())) continue;
    const bucket = grouped.get(observation.key) ?? [];
    bucket.push(observation);
    grouped.set(observation.key, bucket);
  }

  const rates: RateSummary[] = [...grouped.values()]
    .map((observations) => {
      const values = observations.map((o) => o.rateMinor);
      const mid = median(values);
      const low = Math.min(...values);
      const high = Math.max(...values);
      const newestOn = observations.map((o) => o.observedOn).filter((d) => d !== 'unknown').sort().at(-1) ?? 'unknown';
      const ageDays = newestOn === 'unknown' ? -1 : Math.max(0, Math.round((Date.parse(today) - Date.parse(newestOn)) / DAY_MS));
      // Capped, not raw: an imported rate card cannot manufacture confidence
      // past a single THIN data point. Only committed bids lift a key.
      const confidence = confidenceCap(observations);
      const committedObservations = observations.filter((o) => o.source !== 'IMPORTED').length;
      const importedObservations = observations.length - committedObservations;
      const provenance: RateSummary['provenance'] =
        importedObservations === 0 ? 'COMMITTED' : committedObservations === 0 ? 'IMPORTED' : 'MIXED';

      const caveats: string[] = [];
      if (provenance === 'IMPORTED') {
        caveats.push(
          'A starting rate from your own rate card, not yet proven on a committed bid — a point to price from and correct, not a benchmark',
        );
      } else if (confidence === 'THIN') {
        caveats.push(`Only ${observations.length} observation${observations.length === 1 ? '' : 's'} — this is a data point, not a benchmark`);
      }
      if (provenance === 'MIXED') {
        caveats.push(`Includes an imported starting rate alongside ${committedObservations} committed observation${committedObservations === 1 ? '' : 's'}`);
      }
      if (ageDays > 365) caveats.push(`Newest observation is ${Math.round(ageDays / 30)} months old`);
      if (mid > 0 && (high - low) / mid > 0.5) caveats.push('The observations disagree by more than half the median — they may not be the same item');

      return {
        key: observations[0]!.key,
        description: observations[0]!.description,
        unit: observations[0]!.unit,
        observations: observations.length,
        committedObservations,
        importedObservations,
        provenance,
        confidence,
        medianMinor: mid,
        lowMinor: low,
        highMinor: high,
        spreadPercent: mid === 0 ? 0 : Number((((high - low) / mid) * 100).toFixed(1)),
        newestOn,
        ageDays,
        // Projects, not the rate card: an imported rate belongs to no job, so it
        // is not counted as one.
        projects: new Set(observations.filter((o) => o.source !== 'IMPORTED').map((o) => o.projectId)).size,
        ...(caveats.length > 0 ? { caveat: caveats.join('. ') } : {}),
      };
    })
    .sort((a, b) => b.observations - a.observations || a.description.localeCompare(b.description));

  // --- Estimating accuracy --------------------------------------------------
  const withBoth = outturns.filter((o) => o.variancePercent !== undefined);
  const estimatingAccuracy =
    withBoth.length === 0
      ? undefined
      : (() => {
          const variances = withBoth.map((o) => o.variancePercent!);
          const medianVariance = Number(median(variances.map((v) => Math.round(v * 100))) / 100);
          const confidence = confidenceFor(withBoth.length);
          return {
            packages: withBoth.length,
            medianVariancePercent: medianVariance,
            confidence,
            reading:
              confidence === 'THIN'
                ? `${withBoth.length} package${withBoth.length === 1 ? '' : 's'} is not enough to correct an estimate by. It is the start of a record, not a factor.`
                : medianVariance > 0
                  ? `Estimates run ${medianVariance.toFixed(1)}% under what the market returns, across ${withBoth.length} packages. Pricing without allowing for that is a loss taken at tender.`
                  : `Estimates run ${Math.abs(medianVariance).toFixed(1)}% above what the market returns, across ${withBoth.length} packages. That is money left on the table on every competitive bid.`,
          };
        })();

  const importedCount = rawRates.filter((o) => o.source === 'IMPORTED').length;
  const committedCount = rawRates.length - importedCount;
  const observations: string[] = [];
  if (rawRates.length === 0) {
    observations.push('No priced estimate lines yet. The library fills itself as estimates are built — nothing needs entering twice. You can also seed it from your own rate card to price a first bid.');
  } else {
    const strong = rates.filter((r) => r.confidence === 'STRONG' || r.confidence === 'USABLE').length;
    observations.push(
      `${rawRates.length} rate observations across ${rates.length} distinct items. ${strong} ${strong === 1 ? 'item has' : 'items have'} enough committed history to price against.`,
    );
  }
  if (importedCount > 0) {
    observations.push(
      `${importedCount} ${importedCount === 1 ? 'item is' : 'items are'} a starting rate imported from your own rate card — your own number, not a bought index. ${importedCount === 1 ? 'It stays' : 'They stay'} at THIN until a committed bid proves the item.`,
    );
  }
  const stale = rates.filter((r) => r.ageDays > 365).length;
  if (stale > 0) {
    observations.push(`${stale} item${stale === 1 ? '' : 's'} last observed over a year ago. An old rate that is trusted is worse than no rate.`);
  }
  if (outturns.length > 0 && withBoth.length === 0) {
    observations.push('Packages have been let but none can be compared to an estimate against the same package, so estimating accuracy cannot be measured yet.');
  }

  return {
    rates,
    outturns,
    totals: {
      rateObservations: rawRates.length,
      distinctItems: rates.length,
      packages: outturns.length,
      // Distinct delivery projects, which an imported rate does not belong to.
      projects: new Set(rawRates.filter((o) => o.source === 'ESTIMATE').map((o) => o.projectId)).size,
    },
    estimatingAccuracy,
    observations,
  };
}

// --- Benchmarking -------------------------------------------------------------------

export type BenchmarkedLine = {
  description: string;
  unit: string;
  rateMinor: number;
  /** Null when the library holds nothing comparable — never a guess. */
  medianMinor: number | null;
  observations: number;
  confidence: Confidence;
  variancePercent: number | null;
  verdict: 'NO_HISTORY' | 'IN_LINE' | 'ABOVE' | 'BELOW';
  note: string;
};

export type EstimateBenchmark = {
  estimateId: string;
  lines: BenchmarkedLine[];
  /** Lines the library can say something useful about. */
  compared: number;
  withoutHistory: number;
  /** Where the estimate as a whole sits, over the lines that had history. */
  medianVariancePercent: number | null;
  warnings: string[];
};

/**
 * Compare an estimate to the business's own history.
 *
 * The point is not to correct the estimator. It is to make them explain the
 * outliers — a rate 40% above everything the business has ever paid is either
 * a scope difference worth writing down or a mistake worth catching before the
 * tender goes in.
 */
export function benchmarkEstimate(ctx: EngineContext, estimateId: string, today?: string): EstimateBenchmark {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.get({ refType: 'Estimate', refId: estimateId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('ESTIMATE_NOT_FOUND', `No estimate ${estimateId}`, 404);
  }

  // The estimate being benchmarked is itself in the library. Comparing a line
  // to a median that includes its own rate is comparing it to its own
  // reflection, and it drags the median towards whatever the line already says
  // — which is the failure mode that makes a benchmark agree with everything.
  const history = harvestRates(ctx).filter((o) => o.estimateId !== estimateId);
  const grouped = new Map<string, RateObservation[]>();
  for (const observation of history) {
    const bucket = grouped.get(observation.key) ?? [];
    bucket.push(observation);
    grouped.set(observation.key, bucket);
  }
  const lines = (record.state.lines ?? []) as EstimateLine[];

  const benchmarked: BenchmarkedLine[] = [];
  for (const line of lines) {
    if (!line.description || !line.unit) continue;
    const rateMinor =
      (line.labourRateMinor ?? 0) + (line.materialRateMinor ?? 0) + (line.plantRateMinor ?? 0) + (line.subcontractRateMinor ?? 0);
    if (rateMinor <= 0) continue;

    const key = rateKey(line.description, line.unit);
    const observations = grouped.get(key) ?? [];
    const otherObservations = observations.length;
    const medianMinor = otherObservations > 0 ? median(observations.map((o) => o.rateMinor)) : 0;
    const newestOn = observations.map((o) => o.observedOn).filter((d) => d !== 'unknown').sort().at(-1);
    const ageDays =
      newestOn === undefined
        ? -1
        : Math.max(0, Math.round((Date.parse(today ?? new Date().toISOString().slice(0, 10)) - Date.parse(newestOn)) / DAY_MS));

    if (otherObservations < 1) {
      benchmarked.push({
        description: line.description,
        unit: line.unit,
        rateMinor,
        medianMinor: null,
        observations: 0,
        confidence: 'NONE',
        variancePercent: null,
        verdict: 'NO_HISTORY',
        note: 'Nothing comparable in the library. The rate stands on its own build-up.',
      });
      continue;
    }

    const variance = Number((((rateMinor - medianMinor) / medianMinor) * 100).toFixed(1));
    const verdict = Math.abs(variance) <= 10 ? 'IN_LINE' : variance > 0 ? 'ABOVE' : 'BELOW';
    benchmarked.push({
      description: line.description,
      unit: line.unit,
      rateMinor,
      medianMinor,
      observations: otherObservations,
      // Capped: an imported starting rate the key carries cannot, on its own,
      // make the business's history read as more than a single THIN data point.
      confidence: confidenceCap(observations),
      variancePercent: variance,
      verdict,
      note:
        verdict === 'IN_LINE'
          ? `Within 10% of the median of ${otherObservations} other observation${otherObservations === 1 ? '' : 's'}.`
          : `${Math.abs(variance)}% ${verdict === 'ABOVE' ? 'above' : 'below'} the median of ${otherObservations} other observation${otherObservations === 1 ? '' : 's'}${ageDays > 365 ? `, newest ${Math.round(ageDays / 30)} months old` : ''}. Worth explaining before the tender goes in.`,
    });
  }

  const compared = benchmarked.filter((b) => b.verdict !== 'NO_HISTORY');
  const warnings: string[] = [];
  const outliers = compared.filter((b) => Math.abs(b.variancePercent ?? 0) > 25);
  if (outliers.length > 0) {
    warnings.push(`${outliers.length} line${outliers.length === 1 ? '' : 's'} sit more than 25% from the business's own history: ${outliers.map((o) => o.description).join('; ')}`);
  }
  if (compared.length === 0 && benchmarked.length > 0) {
    warnings.push('Nothing on this estimate has been priced before. The library cannot check it, and says so rather than implying agreement.');
  }

  return {
    estimateId,
    lines: benchmarked,
    compared: compared.length,
    withoutHistory: benchmarked.length - compared.length,
    medianVariancePercent:
      compared.length === 0 ? null : Number(median(compared.map((c) => Math.round((c.variancePercent ?? 0) * 10))) / 10),
    warnings,
  };
}

// --- Importing a rate card ----------------------------------------------------

/**
 * One line as it arrives from the console's bulk paste.
 *
 * The description, unit and rate are the library's; the code is the firm's own
 * reference and optional; the note travels with the rate. `line` and `raw` are
 * carried only so a rejected line can be named back to the person precisely.
 * Validation is the domain's job, not the route's — a line missing a field must
 * be *reported*, not dropped at the door, which is why the route admits a line
 * that has not got one.
 */
export type RateCardImportEntry = {
  line?: number;
  code?: string;
  description?: string;
  unit?: string;
  rateMinor?: number;
  note?: string;
  raw?: string;
};

export type RateCardImportResult = {
  imported: Array<{
    key: string;
    code?: string;
    description: string;
    unit: string;
    rateMinor: number;
    note?: string;
    status: 'NEW' | 'REPLACED';
  }>;
  skipped: Array<{ line?: number; raw?: string; reason: string }>;
  totals: { imported: number; replaced: number; skipped: number };
  /** The honest framing, returned so the console can repeat it verbatim. */
  note: string;
};

const RATE_CARD_DESCRIPTION_MIN = 3;

/**
 * Seed the rate library from the firm's own rate card.
 *
 * `ESTIMATE_TENDER` `C`, `COMMERCIAL_L3`, human-authored (the catalogue marks
 * `RATE_CARD_IMPORTED` `aiAllowed: false` — what a firm says its own rates are
 * is a person's statement, not a model's). Tenant-scoped, like the library it
 * feeds: a rate card is the business's, not one project's.
 *
 * Two honesty guards, both here and in `confidenceCap`:
 *
 *   - **It is the firm's own number, not a bought index.** Nothing is fetched
 *     or invented; every rate is one the firm typed, loaded under its own name.
 *   - **It cannot buy confidence.** Each line is one THIN observation keyed by
 *     `rateKey`. Re-importing a key *replaces* its entry rather than filing a
 *     second, so the key still holds one imported observation however many
 *     times it is pasted, and `confidenceCap` holds it at THIN until a
 *     committed bid proves it. A key appearing twice in one paste keeps the
 *     last and reports the earlier as replaced — the same rule, within a paste.
 *
 * A malformed line is reported, never silently dropped: the result names which
 * line and why.
 */
export function importRateCard(ctx: EngineContext, input: { entries: RateCardImportEntry[] }): RateCardImportResult {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const entries = Array.isArray(input.entries) ? input.entries : [];
  if (entries.length === 0) {
    throw new DomainError('RATE_CARD_EMPTY', 'No rate lines were supplied to import.', 400);
  }

  const skipped: RateCardImportResult['skipped'] = [];

  // First pass: validate, and keep the last line for each key so a paste that
  // lists the same item twice does not try to write it twice.
  const valid = new Map<string, { entry: RateCardImportEntry; description: string; unit: string; rateMinor: number }>();
  for (const [index, entry] of entries.entries()) {
    const line = entry.line ?? index + 1;
    const description = String(entry.description ?? '').trim();
    const unit = String(entry.unit ?? '').trim();
    const rateMinor = Number(entry.rateMinor);

    if (!description) {
      skipped.push({ line, raw: entry.raw, reason: 'no description — a rate needs the item it prices' });
      continue;
    }
    if (description.length < RATE_CARD_DESCRIPTION_MIN) {
      skipped.push({ line, raw: entry.raw, reason: `description "${description}" is too short to key a rate on` });
      continue;
    }
    if (!unit) {
      skipped.push({ line, raw: entry.raw, reason: 'no unit — a rate per nothing is not a rate' });
      continue;
    }
    if (!Number.isFinite(rateMinor) || !Number.isInteger(rateMinor) || rateMinor <= 0) {
      skipped.push({ line, raw: entry.raw, reason: 'no valid rate — expected a positive amount per unit' });
      continue;
    }

    const key = rateKey(description, unit);
    if (valid.has(key)) {
      const previous = valid.get(key)!;
      skipped.push({
        line: previous.entry.line ?? undefined,
        raw: previous.entry.raw,
        reason: `the same item and unit (${description} · ${unit}) appears again later in this paste; the later line is kept`,
      });
    }
    valid.set(key, { entry, description, unit, rateMinor });
  }

  // Existing entries, so a re-import replaces its key rather than stacking.
  const existingByKey = new Map<string, EntityRecord>();
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'RateCardEntry')) {
    const state = record.state as unknown as RateCardEntry;
    if (state.key) existingByKey.set(state.key, record);
  }

  const imported: RateCardImportResult['imported'] = [];
  for (const [key, { entry, description, unit, rateMinor }] of valid) {
    const existing = existingByKey.get(key);
    const id = existing ? String((existing.state as unknown as RateCardEntry).id) : ulid();
    const code = entry.code ? String(entry.code).trim() : '';
    const note = entry.note ? String(entry.note).trim() : '';

    const next: RateCardEntry = {
      id,
      key,
      description,
      unit,
      rateMinor,
      ...(code ? { code } : {}),
      ...(note ? { note } : {}),
      importedAt: new Date().toISOString(),
      importedBy: ctx.auth.actorId,
    };

    write(ctx, {
      eventType: 'RATE_CARD_IMPORTED',
      entity: { refType: 'RateCardEntry', refId: id },
      nextState: { ...next },
    });

    imported.push({
      key,
      ...(code ? { code } : {}),
      description,
      unit,
      rateMinor,
      ...(note ? { note } : {}),
      status: existing ? 'REPLACED' : 'NEW',
    });
  }

  const replaced = imported.filter((row) => row.status === 'REPLACED').length;
  return {
    imported,
    skipped,
    totals: { imported: imported.length, replaced, skipped: skipped.length },
    note:
      'These are your own rate card figures, not a bought index. Each enters the library as a THIN, imported ' +
      'starting rate and stays there until a committed bid proves the item — importing the same rate again does ' +
      'not make it any more certain.',
  };
}
