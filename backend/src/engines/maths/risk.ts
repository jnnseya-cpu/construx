/**
 * Risk quantification, delay forecasting and safety prediction.
 *
 * Probabilities and impacts are held as explicit numbers rather than colour
 * bands, so that risk aggregates arithmetically across a portfolio and a
 * contingency figure can be defended line by line.
 */

export type RiskCategory =
  | 'COMMERCIAL'
  | 'PROGRAMME'
  | 'SAFETY'
  | 'DESIGN'
  | 'QUALITY'
  | 'ENVIRONMENTAL'
  | 'REGULATORY'
  | 'SUPPLY_CHAIN'
  | 'GROUND_CONDITIONS'
  | 'WEATHER';

export type RiskInput = {
  id: string;
  title: string;
  category: RiskCategory;
  /** Probability of occurrence in [0,1]. */
  probability: number;
  /** Three-point cost impact in minor units. */
  costImpact: { optimistic: number; mostLikely: number; pessimistic: number };
  /** Three-point schedule impact in working days. */
  scheduleImpactDays: { optimistic: number; mostLikely: number; pessimistic: number };
  ownerPartyId?: string;
  mitigations?: Array<{ description: string; costMinor: number; probabilityReduction: number; impactReduction: number }>;
};

export type ScoredRisk = RiskInput & {
  /** Expected cost = probability x weighted-average impact. */
  expectedCostMinor: number;
  expectedScheduleDays: number;
  /** Pre-mitigation exposure at the pessimistic impact. */
  worstCaseCostMinor: number;
  score: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Post-mitigation position, if mitigations are applied. */
  residual: {
    probability: number;
    expectedCostMinor: number;
    expectedScheduleDays: number;
    mitigationCostMinor: number;
    /** Value of mitigating: exposure avoided less what mitigation costs. */
    netBenefitMinor: number;
    recommended: boolean;
  };
};

/** PERT-weighted expected value: (o + 4m + p) / 6. */
function weighted(three: { optimistic: number; mostLikely: number; pessimistic: number }): number {
  return (three.optimistic + 4 * three.mostLikely + three.pessimistic) / 6;
}

function severityOf(score: number): ScoredRisk['severity'] {
  if (score >= 0.6) return 'CRITICAL';
  if (score >= 0.35) return 'HIGH';
  if (score >= 0.15) return 'MEDIUM';
  return 'LOW';
}

export function scoreRisk(risk: RiskInput, projectValueMinor: number, projectDurationDays: number): ScoredRisk {
  const expectedCost = risk.probability * weighted(risk.costImpact);
  const expectedSchedule = risk.probability * weighted(risk.scheduleImpactDays);

  // Normalise both dimensions against the project so a GBP 50k risk on a GBP 200k
  // job outranks the same risk on a GBP 200m job.
  const costShare = projectValueMinor === 0 ? 0 : weighted(risk.costImpact) / projectValueMinor;
  const scheduleShare = projectDurationDays === 0 ? 0 : weighted(risk.scheduleImpactDays) / projectDurationDays;
  const score = Math.min(1, risk.probability * Math.max(costShare, scheduleShare) * 4);

  const mitigations = risk.mitigations ?? [];
  const mitigationCost = mitigations.reduce((s, m) => s + m.costMinor, 0);
  const probabilityReduction = Math.min(0.95, mitigations.reduce((s, m) => s + m.probabilityReduction, 0));
  const impactReduction = Math.min(0.95, mitigations.reduce((s, m) => s + m.impactReduction, 0));

  const residualProbability = risk.probability * (1 - probabilityReduction);
  const residualCost = residualProbability * weighted(risk.costImpact) * (1 - impactReduction);
  const residualSchedule = residualProbability * weighted(risk.scheduleImpactDays) * (1 - impactReduction);

  const netBenefit = expectedCost - residualCost - mitigationCost;

  return {
    ...risk,
    expectedCostMinor: Math.round(expectedCost),
    expectedScheduleDays: Number(expectedSchedule.toFixed(2)),
    worstCaseCostMinor: Math.round(risk.costImpact.pessimistic),
    score: Number(score.toFixed(4)),
    severity: severityOf(score),
    residual: {
      probability: Number(residualProbability.toFixed(4)),
      expectedCostMinor: Math.round(residualCost),
      expectedScheduleDays: Number(residualSchedule.toFixed(2)),
      mitigationCostMinor: mitigationCost,
      netBenefitMinor: Math.round(netBenefit),
      // Only recommend mitigation that pays for itself.
      recommended: netBenefit > 0,
    },
  };
}

/**
 * Contingency from the risk register. Simple expected-value summation
 * understates tail risk, so this also reports a P80 figure derived from the
 * aggregate variance of the individual risks.
 */
export function contingencyRequirement(risks: ScoredRisk[]): {
  expectedMinor: number;
  p80Minor: number;
  worstCaseMinor: number;
  topDrivers: Array<{ id: string; title: string; expectedCostMinor: number; share: number }>;
} {
  const expected = risks.reduce((s, r) => s + r.expectedCostMinor, 0);

  // Variance of a Bernoulli-weighted impact: p(1-p)E[I]^2 + p.Var(I).
  const variance = risks.reduce((sum, r) => {
    const impact = weighted(r.costImpact);
    const impactSd = (r.costImpact.pessimistic - r.costImpact.optimistic) / 6;
    return sum + r.probability * (1 - r.probability) * impact ** 2 + r.probability * impactSd ** 2;
  }, 0);

  const p80 = expected + 0.8416 * Math.sqrt(variance); // z(0.80) = 0.8416

  const topDrivers = [...risks]
    .sort((a, b) => b.expectedCostMinor - a.expectedCostMinor)
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      title: r.title,
      expectedCostMinor: r.expectedCostMinor,
      share: expected === 0 ? 0 : Number((r.expectedCostMinor / expected).toFixed(3)),
    }));

  return {
    expectedMinor: Math.round(expected),
    p80Minor: Math.round(p80),
    worstCaseMinor: risks.reduce((s, r) => s + r.worstCaseCostMinor, 0),
    topDrivers,
  };
}

// --- Delay risk --------------------------------------------------------------

export type DelayDriver = {
  taskId: string;
  taskName: string;
  /** Days already lost against the baseline. */
  slippageDays: number;
  /** Total float remaining on this activity. */
  totalFloat: number;
  /** Open constraints blocking the activity. */
  openConstraints: number;
  /** Productivity achieved against plan (1.0 = on plan). */
  productivityFactor: number;
  onCriticalPath: boolean;
};

export type DelayRiskSnapshot = {
  projectId: string;
  asAt: string;
  /** Probability the contractual completion date is missed. */
  probabilityOfDelay: number;
  /** Most likely overrun in working days. */
  expectedDelayDays: number;
  p80DelayDays: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  drivers: Array<{ taskId: string; taskName: string; contributionDays: number; reason: string }>;
  correctiveMeasures: CorrectiveMeasure[];
  confidence: number;
};

export type CorrectiveMeasure = {
  code: string;
  measure: string;
  /** Days recoverable if applied. */
  recoveryDays: number;
  /** Indicative cost of applying it, in minor units. */
  costMinor: number;
  /** Cost per day recovered — the ranking key. */
  costPerDayMinor: number;
  applicability: string;
};

/**
 * System-controlled corrective measures library. The AI selects and sizes from
 * this list; it does not invent recovery actions, because an invented action
 * cannot be costed or contractually justified.
 */
export const CORRECTIVE_MEASURES: Array<Omit<CorrectiveMeasure, 'recoveryDays' | 'costMinor' | 'costPerDayMinor'> & {
  maxRecoveryRatio: number;
  costPerDayFactor: number;
}> = [
  {
    code: 'RESEQUENCE',
    measure: 'Re-sequence non-critical works to release the critical path',
    applicability: 'Where float exists elsewhere and access permits',
    maxRecoveryRatio: 0.25,
    costPerDayFactor: 0.2,
  },
  {
    code: 'ADDITIONAL_SHIFT',
    measure: 'Introduce a second shift on critical activities',
    applicability: 'Where working hours consents and supervision allow',
    maxRecoveryRatio: 0.4,
    costPerDayFactor: 1.6,
  },
  {
    code: 'ADDITIONAL_RESOURCE',
    measure: 'Increase gang sizes on critical activities',
    applicability: 'Where the work face can absorb more labour without congestion',
    maxRecoveryRatio: 0.3,
    costPerDayFactor: 1.2,
  },
  {
    code: 'OVERTIME',
    measure: 'Authorise weekend and evening overtime',
    applicability: 'Short-duration recovery; productivity decays beyond three weeks',
    maxRecoveryRatio: 0.2,
    costPerDayFactor: 1.4,
  },
  {
    code: 'PREFABRICATION',
    measure: 'Switch to offsite prefabrication for repetitive elements',
    applicability: 'Where lead time allows and design is frozen',
    maxRecoveryRatio: 0.35,
    costPerDayFactor: 0.9,
  },
  {
    code: 'CONSTRAINT_ESCALATION',
    measure: 'Escalate outstanding constraints (design, permits, materials) to the responsible party',
    applicability: 'Where the delay driver is an unresolved external constraint',
    maxRecoveryRatio: 0.5,
    costPerDayFactor: 0.05,
  },
  {
    code: 'SCOPE_RESEQUENCE_HANDOVER',
    measure: 'Agree sectional completion to hand over completed areas early',
    applicability: 'Where the client can take beneficial occupation in sections',
    maxRecoveryRatio: 0.3,
    costPerDayFactor: 0.3,
  },
];

export function forecastDelayRisk(
  projectId: string,
  drivers: DelayDriver[],
  remainingDurationDays: number,
  dailyPreliminariesMinor: number,
  dataCompleteness = 1,
): DelayRiskSnapshot {
  const asAt = new Date().toISOString();

  if (drivers.length === 0) {
    return {
      projectId,
      asAt,
      probabilityOfDelay: 0,
      expectedDelayDays: 0,
      p80DelayDays: 0,
      severity: 'LOW',
      drivers: [],
      correctiveMeasures: [],
      confidence: Number(dataCompleteness.toFixed(3)),
    };
  }

  // Only slippage that exceeds available float actually moves completion.
  const contributions = drivers.map((driver) => {
    const floatConsumed = Math.max(0, driver.slippageDays - Math.max(0, driver.totalFloat));
    const productivityDrag =
      driver.productivityFactor > 0 && driver.productivityFactor < 1
        ? remainingDurationDays * (1 / driver.productivityFactor - 1) * (driver.onCriticalPath ? 1 : 0.2)
        : 0;
    const constraintDrag = driver.openConstraints * (driver.onCriticalPath ? 2 : 0.5);
    const contribution = (floatConsumed + productivityDrag + constraintDrag) * (driver.onCriticalPath ? 1 : 0.15);

    const reasons: string[] = [];
    if (floatConsumed > 0) reasons.push(`${floatConsumed.toFixed(1)}d slippage beyond available float`);
    if (productivityDrag > 0) reasons.push(`productivity at ${(driver.productivityFactor * 100).toFixed(0)}% of plan`);
    if (driver.openConstraints > 0) reasons.push(`${driver.openConstraints} open constraint(s)`);
    if (reasons.length === 0) reasons.push('within float');

    return {
      taskId: driver.taskId,
      taskName: driver.taskName,
      contributionDays: Number(contribution.toFixed(2)),
      reason: reasons.join('; '),
      onCriticalPath: driver.onCriticalPath,
    };
  });

  const expectedDelay = contributions.reduce((s, c) => s + c.contributionDays, 0);

  // Spread grows with the number of contributing drivers — more moving parts,
  // wider outcome distribution.
  const spread = Math.sqrt(contributions.filter((c) => c.contributionDays > 0).length || 1) * 1.5;
  const p80Delay = expectedDelay + 0.8416 * spread;

  const probabilityOfDelay =
    expectedDelay <= 0 ? 0 : Number(Math.min(0.99, 0.5 + 0.5 * Math.tanh(expectedDelay / 10)).toFixed(4));

  const severity: DelayRiskSnapshot['severity'] =
    expectedDelay >= remainingDurationDays * 0.2
      ? 'CRITICAL'
      : expectedDelay >= remainingDurationDays * 0.1
        ? 'HIGH'
        : expectedDelay > 0
          ? 'MEDIUM'
          : 'LOW';

  // Size and cost each measure against the delay actually being recovered.
  const correctiveMeasures: CorrectiveMeasure[] = CORRECTIVE_MEASURES.map((template) => {
    const recoveryDays = Number(Math.min(expectedDelay, expectedDelay * template.maxRecoveryRatio).toFixed(2));
    const costMinor = Math.round(recoveryDays * dailyPreliminariesMinor * template.costPerDayFactor);
    return {
      code: template.code,
      measure: template.measure,
      applicability: template.applicability,
      recoveryDays,
      costMinor,
      costPerDayMinor: recoveryDays === 0 ? 0 : Math.round(costMinor / recoveryDays),
    };
  })
    .filter((m) => m.recoveryDays > 0)
    .sort((a, b) => a.costPerDayMinor - b.costPerDayMinor);

  return {
    projectId,
    asAt,
    probabilityOfDelay,
    expectedDelayDays: Number(expectedDelay.toFixed(2)),
    p80DelayDays: Number(p80Delay.toFixed(2)),
    severity,
    drivers: contributions
      .filter((c) => c.contributionDays > 0)
      .sort((a, b) => b.contributionDays - a.contributionDays)
      .map(({ taskId, taskName, contributionDays, reason }) => ({ taskId, taskName, contributionDays, reason })),
    correctiveMeasures,
    confidence: Number(dataCompleteness.toFixed(3)),
  };
}

// --- Safety prediction -------------------------------------------------------

export type SafetySignal = {
  /** Observations classified as unsafe acts or conditions, last 30 days. */
  unsafeObservations: number;
  nearMisses: number;
  incidents: number;
  /** Operatives on site. */
  headcount: number;
  /** Share of active RAMS acknowledged by the workforce. */
  ramsAcknowledgementRate: number;
  /** Share of operatives with in-date competency records. */
  competencyComplianceRate: number;
  /** High-risk activities planned in the next lookahead window. */
  highRiskActivitiesPlanned: number;
  /** Adverse weather days forecast in the window. */
  adverseWeatherDays: number;
};

export type SafetyForecast = {
  riskIndex: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Expected recordable incidents in the next 30 days. */
  expectedIncidents30d: number;
  drivers: Array<{ factor: string; contribution: number; detail: string }>;
  recommendedControls: string[];
};

export function forecastSafety(signal: SafetySignal): SafetyForecast {
  const exposure = Math.max(1, signal.headcount);

  // Heinrich-style leading indicators: near misses and unsafe acts precede
  // recordable incidents, so they carry the forecast rather than the lagging count.
  const nearMissRate = signal.nearMisses / exposure;
  const unsafeRate = signal.unsafeObservations / exposure;
  const incidentRate = signal.incidents / exposure;

  const drivers = [
    { factor: 'Unsafe observation rate', contribution: Math.min(0.3, unsafeRate * 3), detail: `${signal.unsafeObservations} in 30 days across ${signal.headcount} operatives` },
    { factor: 'Near-miss rate', contribution: Math.min(0.25, nearMissRate * 5), detail: `${signal.nearMisses} near misses reported` },
    { factor: 'Recorded incidents', contribution: Math.min(0.2, incidentRate * 10), detail: `${signal.incidents} recordable incident(s)` },
    { factor: 'RAMS acknowledgement gap', contribution: Math.min(0.15, (1 - signal.ramsAcknowledgementRate) * 0.3), detail: `${(signal.ramsAcknowledgementRate * 100).toFixed(0)}% of RAMS acknowledged` },
    { factor: 'Competency gap', contribution: Math.min(0.15, (1 - signal.competencyComplianceRate) * 0.3), detail: `${(signal.competencyComplianceRate * 100).toFixed(0)}% competency compliance` },
    { factor: 'High-risk activity load', contribution: Math.min(0.15, signal.highRiskActivitiesPlanned * 0.02), detail: `${signal.highRiskActivitiesPlanned} high-risk activities planned` },
    { factor: 'Adverse weather exposure', contribution: Math.min(0.1, signal.adverseWeatherDays * 0.01), detail: `${signal.adverseWeatherDays} adverse weather days forecast` },
  ].filter((d) => d.contribution > 0.001);

  const riskIndex = Number(Math.min(1, drivers.reduce((s, d) => s + d.contribution, 0)).toFixed(4));

  const severity: SafetyForecast['severity'] =
    riskIndex >= 0.6 ? 'CRITICAL' : riskIndex >= 0.4 ? 'HIGH' : riskIndex >= 0.2 ? 'MEDIUM' : 'LOW';

  const recommendedControls: string[] = [];
  if (signal.ramsAcknowledgementRate < 0.95) recommendedControls.push('Complete RAMS briefings and record acknowledgements before work proceeds');
  if (signal.competencyComplianceRate < 0.95) recommendedControls.push('Suspend affected operatives until competency records are back in date');
  if (signal.highRiskActivitiesPlanned > 3) recommendedControls.push('Stagger high-risk activities across the lookahead to reduce concurrent exposure');
  if (signal.adverseWeatherDays > 3) recommendedControls.push('Re-plan weather-sensitive works and review lifting operations against wind limits');
  if (nearMissRate > 0.05) recommendedControls.push('Run a targeted stand-down on the trades generating near misses');
  if (recommendedControls.length === 0) recommendedControls.push('Maintain current controls; continue leading-indicator monitoring');

  return {
    riskIndex,
    severity,
    // Scaled from leading indicators against exposure, not extrapolated from
    // the incident count alone, which under-predicts on low-incident sites.
    expectedIncidents30d: Number((riskIndex * Math.sqrt(exposure) * 0.4).toFixed(2)),
    drivers: drivers.sort((a, b) => b.contribution - a.contribution).map((d) => ({ ...d, contribution: Number(d.contribution.toFixed(4)) })),
    recommendedControls,
  };
}
