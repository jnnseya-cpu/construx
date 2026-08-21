import { DomainError } from '../../core/errors.ts';

/**
 * Deterministic bid comparison.
 *
 * Award decisions get challenged, so none of this may depend on model output or
 * on evaluation order. Given the same submissions and the same penalty profile,
 * the ranking is always identical and every score is reproducible by hand.
 */

export type ScoringMethod = 'RATIO' | 'MIN_MAX';

export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH';

export type SubmissionInput = {
  submissionId: string;
  supplierPartyId: string;
  supplierName: string;
  /** Total tendered price in minor units. */
  priceMinor: number;
  /** Programme duration offered, in working days. */
  durationDays: number;
  exclusions: string[];
  contractExceptions: string[];
  provisionalSumsMinor: number;
  /** Insurance types the supplier has evidenced. */
  insurancesHeld: string[];
  /** Peak labour the supplier can commit. */
  peakLabour?: number;
  /** Supplier's own risk statement, used for the expected-risk-cost method. */
  riskItems?: Array<{ description: string; band: RiskBand; impactCostMostLikelyMinor: number }>;
};

export type PenaltyProfile = {
  id: string;
  priceWeight: number;
  programmeWeight: number;
  riskWeight: number;
  priceMethod: ScoringMethod;
  programmeMethod: ScoringMethod;
  riskMethod: 'BAND_TO_SCORE' | 'EXPECTED_RISK_COST';
  thresholds: {
    maxExclusions: number;
    maxContractExceptions: number;
    /** Provisional sums as a share of total price, above which the flag fires. */
    maxProvisionalSumRatio: number;
    requiredInsurances: string[];
    /** Minimum design maturity score required for the pricing format in use. */
    minDesignMaturity: number;
    /** Feasibility floor: durations below this are treated as unrealistic. */
    p10FeasibleDurationDays?: number;
  };
  /** Score multiplier deductions, expressed as a fraction (0.07 = 7%). */
  penalties: Record<FlagCode, number>;
  /** Band-to-probability mapping for the expected-risk-cost method. */
  bandProbability: Record<RiskBand, number>;
};

export type FlagCode =
  | 'DESIGN_MATURITY_LOW'
  | 'EXCESSIVE_EXCLUSIONS'
  | 'MATERIAL_PROVISIONAL_SUMS_HIGH'
  | 'CONTRACT_EXCEPTIONS_HIGH'
  | 'INSURANCE_GAPS'
  | 'CAPACITY_RISK'
  | 'UNREALISTIC_PROGRAMME';

export const DEFAULT_PENALTY_PROFILE: PenaltyProfile = {
  id: 'default-v1',
  priceWeight: 0.5,
  programmeWeight: 0.2,
  riskWeight: 0.3,
  priceMethod: 'RATIO',
  programmeMethod: 'RATIO',
  riskMethod: 'BAND_TO_SCORE',
  thresholds: {
    maxExclusions: 5,
    maxContractExceptions: 3,
    maxProvisionalSumRatio: 0.1,
    requiredInsurances: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY', 'PROFESSIONAL_INDEMNITY'],
    minDesignMaturity: 60,
  },
  penalties: {
    DESIGN_MATURITY_LOW: 0.05,
    EXCESSIVE_EXCLUSIONS: 0.05,
    MATERIAL_PROVISIONAL_SUMS_HIGH: 0.06,
    CONTRACT_EXCEPTIONS_HIGH: 0.07,
    INSURANCE_GAPS: 0.1,
    CAPACITY_RISK: 0.08,
    UNREALISTIC_PROGRAMME: 0.15,
  },
  bandProbability: { LOW: 0.1, MEDIUM: 0.3, HIGH: 0.6 },
};

export function validatePenaltyProfile(profile: PenaltyProfile): void {
  const sum = profile.priceWeight + profile.programmeWeight + profile.riskWeight;
  if (Math.abs(sum - 1) > 1e-9) {
    throw new DomainError('PENALTY_PROFILE_INVALID', `Evaluation weights must sum to 1.0, received ${sum}`);
  }
  for (const [flag, penalty] of Object.entries(profile.penalties)) {
    if (penalty < 0 || penalty >= 1) {
      throw new DomainError('PENALTY_PROFILE_INVALID', `Penalty for ${flag} must be in [0,1)`);
    }
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function ratioScore(value: number, best: number, lowerIsBetter: boolean): number {
  if (value <= 0) return 0;
  return lowerIsBetter ? clamp01(best / value) : clamp01(value / best);
}

function minMaxScore(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return clamp01((max - value) / (max - min));
}

export type BidScore = {
  submissionId: string;
  supplierPartyId: string;
  supplierName: string;
  priceMinor: number;
  durationDays: number;
  priceScore: number;
  programmeScore: number;
  riskScore: number;
  /** Weighted score before flag penalties. */
  rawTotalScore: number;
  /** Weighted score after every applicable penalty multiplier. */
  totalScore: number;
  flags: FlagCode[];
  penaltyApplied: number;
  expectedRiskCostMinor?: number;
  /** Conditions that must be discharged before this bid could be awarded. */
  conditions: string[];
  /** True where a flag bars award until cleared, regardless of score. */
  blockedFromAward: boolean;
};

export type EvaluationResult = {
  profileId: string;
  scores: BidScore[];
  recommendedSubmissionId?: string;
  recommendation: string;
  /** A mandatory clarification round is required before any award. */
  clarificationRequired: boolean;
  method: { price: ScoringMethod; programme: ScoringMethod; risk: string };
};

/** Flags that stop an award outright until the supplier clears them. */
const BLOCKING_FLAGS = new Set<FlagCode>(['INSURANCE_GAPS']);

const CONDITION_TEXT: Record<FlagCode, string> = {
  DESIGN_MATURITY_LOW: 'Confirm pricing assumptions against a design maturity uplift before award',
  EXCESSIVE_EXCLUSIONS: 'Remove or clarify exclusions so scope is complete',
  MATERIAL_PROVISIONAL_SUMS_HIGH: 'Cap or convert provisional sums to fixed prices',
  CONTRACT_EXCEPTIONS_HIGH: 'Withdraw or negotiate contract exceptions',
  INSURANCE_GAPS: 'Provide insurance endorsements meeting the required limits',
  CAPACITY_RISK: 'Evidence resourcing and peak labour against the package demand',
  UNREALISTIC_PROGRAMME: 'Confirm programme logic and resourcing supports the offered duration',
};

export function evaluateBids(
  submissions: SubmissionInput[],
  profile: PenaltyProfile = DEFAULT_PENALTY_PROFILE,
  context: { designMaturityScore?: number; packageLabourDemand?: number } = {},
): EvaluationResult {
  validatePenaltyProfile(profile);
  if (submissions.length === 0) {
    throw new DomainError('EVALUATION_NO_SUBMISSIONS', 'Cannot evaluate an empty submission set');
  }

  // Order first so that ties resolve identically on every run.
  const ordered = [...submissions].sort((a, b) => (a.submissionId < b.submissionId ? -1 : 1));

  const prices = ordered.map((s) => s.priceMinor);
  const durations = ordered.map((s) => s.durationDays);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const minDuration = Math.min(...durations);
  const maxDuration = Math.max(...durations);

  const expectedRiskCosts = ordered.map((s) =>
    (s.riskItems ?? []).reduce(
      (sum, item) => sum + profile.bandProbability[item.band] * item.impactCostMostLikelyMinor,
      0,
    ),
  );
  const minErc = Math.min(...expectedRiskCosts);
  const maxErc = Math.max(...expectedRiskCosts);

  const scores: BidScore[] = ordered.map((submission, index) => {
    const flags: FlagCode[] = [];

    // --- Flags (evidence-based, derived from structured fields only) ---------
    if (
      context.designMaturityScore !== undefined &&
      context.designMaturityScore < profile.thresholds.minDesignMaturity
    ) {
      flags.push('DESIGN_MATURITY_LOW');
    }
    if (submission.exclusions.length > profile.thresholds.maxExclusions) flags.push('EXCESSIVE_EXCLUSIONS');
    if (submission.contractExceptions.length > profile.thresholds.maxContractExceptions) {
      flags.push('CONTRACT_EXCEPTIONS_HIGH');
    }
    if (
      submission.priceMinor > 0 &&
      submission.provisionalSumsMinor / submission.priceMinor > profile.thresholds.maxProvisionalSumRatio
    ) {
      flags.push('MATERIAL_PROVISIONAL_SUMS_HIGH');
    }
    const missingInsurances = profile.thresholds.requiredInsurances.filter((i) => !submission.insurancesHeld.includes(i));
    if (missingInsurances.length > 0) flags.push('INSURANCE_GAPS');
    if (
      context.packageLabourDemand !== undefined &&
      submission.peakLabour !== undefined &&
      submission.peakLabour < context.packageLabourDemand
    ) {
      flags.push('CAPACITY_RISK');
    }

    // --- Price ---------------------------------------------------------------
    const priceScore =
      profile.priceMethod === 'RATIO'
        ? ratioScore(submission.priceMinor, minPrice, true)
        : minMaxScore(submission.priceMinor, minPrice, maxPrice);

    // --- Programme -----------------------------------------------------------
    let programmeScore =
      profile.programmeMethod === 'RATIO'
        ? ratioScore(submission.durationDays, minDuration, true)
        : minMaxScore(submission.durationDays, minDuration, maxDuration);

    // An implausibly short programme is not an advantage; it is undisclosed risk.
    const feasibilityFloor = profile.thresholds.p10FeasibleDurationDays;
    if (feasibilityFloor !== undefined && submission.durationDays < feasibilityFloor) {
      flags.push('UNREALISTIC_PROGRAMME');
      programmeScore = programmeScore * 0.85;
    }

    // --- Risk ----------------------------------------------------------------
    let riskScore: number;
    let expectedRiskCostMinor: number | undefined;

    if (profile.riskMethod === 'EXPECTED_RISK_COST') {
      expectedRiskCostMinor = Math.round(expectedRiskCosts[index] as number);
      riskScore = maxErc === minErc ? 1 : clamp01((maxErc - (expectedRiskCosts[index] as number)) / (maxErc - minErc));
    } else {
      const exceptionsIndex = submission.contractExceptions.length / Math.max(1, profile.thresholds.maxContractExceptions);
      const provSumIndex =
        submission.priceMinor === 0
          ? 0
          : submission.provisionalSumsMinor / submission.priceMinor / Math.max(0.0001, profile.thresholds.maxProvisionalSumRatio);
      const insuranceIndex = missingInsurances.length / Math.max(1, profile.thresholds.requiredInsurances.length);
      const capacityIndex =
        context.packageLabourDemand && submission.peakLabour
          ? Math.max(0, (context.packageLabourDemand - submission.peakLabour) / context.packageLabourDemand)
          : 0;
      const riskPenalty = 0.3 * exceptionsIndex + 0.25 * provSumIndex + 0.3 * insuranceIndex + 0.15 * capacityIndex;
      riskScore = 1 - clamp01(riskPenalty);
    }

    const rawTotalScore =
      profile.priceWeight * priceScore + profile.programmeWeight * programmeScore + profile.riskWeight * riskScore;

    // Penalties compound multiplicatively so several small issues still matter.
    let multiplier = 1;
    for (const flag of flags) multiplier *= 1 - (profile.penalties[flag] ?? 0);

    return {
      submissionId: submission.submissionId,
      supplierPartyId: submission.supplierPartyId,
      supplierName: submission.supplierName,
      priceMinor: submission.priceMinor,
      durationDays: submission.durationDays,
      priceScore: Number(priceScore.toFixed(4)),
      programmeScore: Number(programmeScore.toFixed(4)),
      riskScore: Number(riskScore.toFixed(4)),
      rawTotalScore: Number(rawTotalScore.toFixed(4)),
      totalScore: Number((rawTotalScore * multiplier).toFixed(4)),
      flags,
      penaltyApplied: Number((1 - multiplier).toFixed(4)),
      expectedRiskCostMinor,
      conditions: flags.map((f) => CONDITION_TEXT[f]),
      blockedFromAward: flags.some((f) => BLOCKING_FLAGS.has(f)),
    };
  });

  // Rank by score, then by price, then by id — no ties left to chance.
  const ranked = [...scores].sort(
    (a, b) => b.totalScore - a.totalScore || a.priceMinor - b.priceMinor || (a.submissionId < b.submissionId ? -1 : 1),
  );
  const winner = ranked[0];

  const clarificationRequired = winner?.blockedFromAward === true || (winner?.conditions.length ?? 0) > 0;

  return {
    profileId: profile.id,
    scores: ranked,
    recommendedSubmissionId: winner?.submissionId,
    recommendation: winner
      ? winner.blockedFromAward
        ? `${winner.supplierName} scores highest (${winner.totalScore}) but cannot be awarded until blocking conditions are cleared.`
        : `${winner.supplierName} scores highest (${winner.totalScore})${
            winner.conditions.length > 0 ? ', subject to the listed conditions.' : '.'
          }`
      : 'No award recommendation could be formed.',
    clarificationRequired,
    method: { price: profile.priceMethod, programme: profile.programmeMethod, risk: profile.riskMethod },
  };
}

/**
 * Line-item normalisation across supplier formats — the precondition for any
 * meaningful comparison. Detects missing scope and pricing outliers.
 */
export type NormalisedLine = {
  reference: string;
  description: string;
  unit: string;
  quantity: number;
  rateMinor: number;
  totalMinor: number;
};

export type VarianceFinding = {
  reference: string;
  description: string;
  severity: 'LOW' | 'MEDIUM' | 'HIGH';
  finding: string;
  suppliersAffected: string[];
};

/** Deviation from the median beyond which a rate is queried. */
const OUTLIER_RATIO = 0.35;

export function analyseReturnVariance(
  baseline: NormalisedLine[],
  returns: Array<{ supplierName: string; lines: NormalisedLine[] }>,
): VarianceFinding[] {
  const findings: VarianceFinding[] = [];

  for (const line of baseline) {
    const priced = returns
      .map((r) => ({ supplier: r.supplierName, line: r.lines.find((l) => l.reference === line.reference) }))
      .filter((entry): entry is { supplier: string; line: NormalisedLine } => entry.line !== undefined);

    const missing = returns.filter((r) => !r.lines.some((l) => l.reference === line.reference));
    if (missing.length > 0) {
      findings.push({
        reference: line.reference,
        description: line.description,
        severity: 'HIGH',
        finding: `Scope not priced by ${missing.length} of ${returns.length} suppliers — comparison is not like-for-like`,
        suppliersAffected: missing.map((m) => m.supplierName),
      });
    }

    if (priced.length < 2) continue;

    // Compare against the median, not the mean: with three or four returns a
    // single wild rate drags the mean towards itself and hides the very outlier
    // the buyer needs to see.
    const rates = priced.map((p) => p.line.rateMinor).sort((a, b) => a - b);
    const middle = Math.floor(rates.length / 2);
    const median =
      rates.length % 2 === 0 ? (((rates[middle - 1] as number) + (rates[middle] as number)) / 2) : (rates[middle] as number);
    if (median === 0) continue;

    for (const entry of priced) {
      const deviation = Math.abs(entry.line.rateMinor - median);
      const ratio = deviation / median;
      if (ratio <= OUTLIER_RATIO) continue;

      const below = entry.line.rateMinor < median;
      findings.push({
        reference: line.reference,
        description: line.description,
        // An under-price is the dangerous direction: it usually means the
        // supplier has not understood the scope, and the gap surfaces later.
        severity: below ? 'HIGH' : 'MEDIUM',
        finding: below
          ? `${entry.supplier} priced ${(ratio * 100).toFixed(0)}% below the median — likely scope misunderstanding`
          : `${entry.supplier} priced ${(ratio * 100).toFixed(0)}% above the median — query basis of rate`,
        suppliersAffected: [entry.supplier],
      });
    }
  }

  return findings;
}

/** Turn variance findings into tender clarification questions. */
export function generateClarifications(findings: VarianceFinding[]): Array<{ supplier: string; question: string; severity: string }> {
  return findings.flatMap((finding) =>
    finding.suppliersAffected.map((supplier) => ({
      supplier,
      severity: finding.severity,
      question: `Regarding ${finding.reference} (${finding.description}): ${finding.finding}. Please confirm your inclusion and the basis of your price.`,
    })),
  );
}
