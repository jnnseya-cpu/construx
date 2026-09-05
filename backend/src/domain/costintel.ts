import { DomainError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
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
  source: 'ESTIMATE';
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

export type RateSummary = {
  key: string;
  description: string;
  unit: string;
  observations: number;
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
  labourRateMinor?: number;
  materialRateMinor?: number;
  plantRateMinor?: number;
  subcontractRateMinor?: number;
};

/**
 * Read every unit rate the business has committed to an estimate.
 *
 * Estimates are the only place a defensible unit rate exists: they carry a
 * description, a unit, a quantity and a rate that somebody priced and somebody
 * else approved.
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
      const confidence = confidenceFor(observations.length);

      const caveats: string[] = [];
      if (confidence === 'THIN') caveats.push(`Only ${observations.length} observation${observations.length === 1 ? '' : 's'} — this is a data point, not a benchmark`);
      if (ageDays > 365) caveats.push(`Newest observation is ${Math.round(ageDays / 30)} months old`);
      if (mid > 0 && (high - low) / mid > 0.5) caveats.push('The observations disagree by more than half the median — they may not be the same item');

      return {
        key: observations[0]!.key,
        description: observations[0]!.description,
        unit: observations[0]!.unit,
        observations: observations.length,
        confidence,
        medianMinor: mid,
        lowMinor: low,
        highMinor: high,
        spreadPercent: mid === 0 ? 0 : Number((((high - low) / mid) * 100).toFixed(1)),
        newestOn,
        ageDays,
        projects: new Set(observations.map((o) => o.projectId)).size,
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

  const observations: string[] = [];
  if (rawRates.length === 0) {
    observations.push('No priced estimate lines yet. The library fills itself as estimates are built — nothing needs entering twice.');
  } else {
    const strong = rates.filter((r) => r.confidence === 'STRONG' || r.confidence === 'USABLE').length;
    observations.push(
      `${rawRates.length} rate observations across ${rates.length} distinct items. ${strong} ${strong === 1 ? 'item has' : 'items have'} enough history to price against.`,
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
      projects: new Set(rawRates.map((o) => o.projectId)).size,
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
      confidence: confidenceFor(otherObservations),
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
