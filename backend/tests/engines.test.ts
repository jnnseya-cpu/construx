import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { calculateCPM, completionProbability, durationAtConfidence, pert } from '../src/engines/maths/cpm.ts';
import { calculateCVR, calculateEVM, sCurveDistribution } from '../src/engines/maths/evm.ts';
import { DEFAULT_PENALTY_PROFILE, evaluateBids, analyseReturnVariance, validatePenaltyProfile } from '../src/engines/maths/bidScoring.ts';
import { attributeDelay, assessClaim, generatePaymentCycle, checkNoticeCompliance } from '../src/engines/maths/claims.ts';
import { contingencyRequirement, forecastDelayRisk, forecastSafety, scoreRisk } from '../src/engines/maths/risk.ts';

describe('critical path method', () => {
  const activities = [
    { id: 'A', name: 'Enabling', duration: 10 },
    { id: 'B', name: 'Excavation', duration: 20 },
    { id: 'C', name: 'Services diversion', duration: 5 },
    { id: 'D', name: 'Structure', duration: 30 },
  ];
  const dependencies = [
    { predecessorId: 'A', successorId: 'B', type: 'FS' as const, lag: 0 },
    { predecessorId: 'A', successorId: 'C', type: 'FS' as const, lag: 0 },
    { predecessorId: 'B', successorId: 'D', type: 'FS' as const, lag: 0 },
    { predecessorId: 'C', successorId: 'D', type: 'FS' as const, lag: 0 },
  ];

  it('computes the project duration along the longest path', () => {
    assert.equal(calculateCPM(activities, dependencies).projectDuration, 60);
  });

  it('identifies the critical path and gives the parallel branch float', () => {
    const result = calculateCPM(activities, dependencies);
    assert.deepEqual(result.criticalPath, ['A', 'B', 'D']);
    assert.equal(result.activities.find((a) => a.id === 'C')?.totalFloat, 15);
  });

  it('honours lag on a finish-to-start link', () => {
    const withLag = calculateCPM(activities, [
      { predecessorId: 'A', successorId: 'B', type: 'FS', lag: 5 },
      { predecessorId: 'B', successorId: 'D', type: 'FS', lag: 0 },
    ]);
    assert.equal(withLag.projectDuration, 65);
  });

  it('handles a start-to-start link', () => {
    const result = calculateCPM(
      [
        { id: 'A', name: 'A', duration: 10 },
        { id: 'B', name: 'B', duration: 10 },
      ],
      [{ predecessorId: 'A', successorId: 'B', type: 'SS', lag: 3 }],
    );
    assert.equal(result.activities.find((a) => a.id === 'B')?.earlyStart, 3);
  });

  it('reports a dependency cycle rather than looping', () => {
    const result = calculateCPM(
      [
        { id: 'A', name: 'A', duration: 5 },
        { id: 'B', name: 'B', duration: 5 },
      ],
      [
        { predecessorId: 'A', successorId: 'B', type: 'FS', lag: 0 },
        { predecessorId: 'B', successorId: 'A', type: 'FS', lag: 0 },
      ],
    );
    assert.equal(result.cycles.length, 1);
  });

  it('is deterministic across repeated runs', () => {
    const a = calculateCPM(activities, dependencies);
    const b = calculateCPM([...activities].reverse(), [...dependencies].reverse());
    assert.equal(a.projectDuration, b.projectDuration);
    assert.deepEqual(a.criticalPath, b.criticalPath);
  });
});

describe('probabilistic completion', () => {
  it('weights the most likely duration heaviest', () => {
    assert.equal(pert(10, 20, 60).mean, 25);
  });

  it('gives a target beyond the expected duration a probability above half', () => {
    const p = completionProbability(100, 25, 110);
    assert.ok(p > 0.5 && p < 1);
  });

  it('returns a P80 duration longer than the expected duration', () => {
    assert.ok(durationAtConfidence(100, 25, 0.8) > 100);
  });

  it('collapses to certainty when there is no variance', () => {
    assert.equal(completionProbability(100, 0, 110), 1);
    assert.equal(completionProbability(100, 0, 90), 0);
  });
});

describe('earned value', () => {
  it('flags a project that is over cost and behind schedule', () => {
    const snapshot = calculateEVM({
      plannedValueMinor: 100_000,
      earnedValueMinor: 80_000,
      actualCostMinor: 100_000,
      budgetAtCompletionMinor: 500_000,
    });
    assert.equal(snapshot.costPerformanceIndex, 0.8);
    assert.equal(snapshot.schedulePerformanceIndex, 0.8);
    assert.equal(snapshot.costVarianceMinor, -20_000);
    assert.ok(snapshot.estimateAtCompletionMinor > 500_000, 'EAC should exceed budget when CPI is below 1');
  });

  it('orders the three EAC scenarios sensibly', () => {
    const snapshot = calculateEVM({
      plannedValueMinor: 100_000,
      earnedValueMinor: 80_000,
      actualCostMinor: 100_000,
      budgetAtCompletionMinor: 500_000,
    });
    assert.ok(snapshot.estimateAtCompletionOptimisticMinor < snapshot.estimateAtCompletionMinor);
    assert.ok(snapshot.estimateAtCompletionPessimisticMinor > snapshot.estimateAtCompletionMinor);
  });

  it('reports low confidence when little of the work is measured', () => {
    const snapshot = calculateEVM(
      { plannedValueMinor: 100, earnedValueMinor: 100, actualCostMinor: 100, budgetAtCompletionMinor: 1_000 },
      0.15,
    );
    assert.ok(snapshot.confidence < 0.2);
  });
});

describe('cost value reconciliation', () => {
  it('raises alerts when margin erodes against the tender', () => {
    const cvr = calculateCVR(
      {
        contractValueMinor: 1_000_000,
        approvedVariationsMinor: 50_000,
        unapprovedVariationsMinor: 80_000,
        certifiedToDateMinor: 400_000,
        commitmentsMinor: 700_000,
        costToDateMinor: 500_000,
        accrualsMinor: 40_000,
        costToCompleteMinor: 560_000,
      },
      12,
    );
    assert.ok(cvr.forecastMarginPercent < 12);
    assert.ok(cvr.alerts.some((a) => a.includes('Margin eroded')));
    assert.ok(cvr.alerts.some((a) => a.includes('Unapproved variations')));
  });

  it('identifies a loss-making forecast', () => {
    const cvr = calculateCVR(
      {
        contractValueMinor: 1_000_000,
        approvedVariationsMinor: 0,
        unapprovedVariationsMinor: 0,
        certifiedToDateMinor: 0,
        commitmentsMinor: 0,
        costToDateMinor: 900_000,
        accrualsMinor: 0,
        costToCompleteMinor: 300_000,
      },
      10,
    );
    assert.ok(cvr.forecastMarginMinor < 0);
    assert.ok(cvr.alerts.some((a) => a.includes('loss-making')));
  });
});

describe('cashflow', () => {
  it('distributes the full value across the periods', () => {
    const curve = sCurveDistribution(1_000_000, 12);
    assert.equal(curve.reduce((s, v) => s + v, 0), 1_000_000);
  });

  it('peaks in the middle rather than running flat', () => {
    const curve = sCurveDistribution(1_000_000, 12);
    const first = curve[0] as number;
    const middle = curve[6] as number;
    assert.ok(middle > first * 2, 'construction spend ramps up rather than being linear');
  });
});

describe('bid evaluation', () => {
  const submissions = [
    {
      submissionId: 'S1',
      supplierPartyId: 'P1',
      supplierName: 'Complete Bid Ltd',
      priceMinor: 1_000_000,
      durationDays: 200,
      exclusions: ['Rock excavation'],
      contractExceptions: [],
      provisionalSumsMinor: 20_000,
      insurancesHeld: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY', 'PROFESSIONAL_INDEMNITY'],
    },
    {
      submissionId: 'S2',
      supplierPartyId: 'P2',
      supplierName: 'Cheap But Qualified Ltd',
      priceMinor: 800_000,
      durationDays: 180,
      exclusions: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
      contractExceptions: ['X', 'Y', 'Z', 'W'],
      provisionalSumsMinor: 200_000,
      insurancesHeld: ['PUBLIC_LIABILITY'],
    },
  ];

  it('does not recommend the cheapest bid when it is riddled with exclusions', () => {
    const result = evaluateBids(submissions);
    assert.equal(result.recommendedSubmissionId, 'S1');
  });

  it('blocks award where insurance cover is missing', () => {
    const result = evaluateBids(submissions);
    const cheap = result.scores.find((s) => s.submissionId === 'S2');
    assert.ok(cheap?.flags.includes('INSURANCE_GAPS'));
    assert.equal(cheap?.blockedFromAward, true);
    // The clean bid wins, so no clarification round gates this particular award.
    assert.equal(result.clarificationRequired, false);
  });

  it('produces identical results regardless of submission order', () => {
    const forwards = evaluateBids(submissions);
    const backwards = evaluateBids([...submissions].reverse());
    assert.deepEqual(
      forwards.scores.map((s) => [s.submissionId, s.totalScore]),
      backwards.scores.map((s) => [s.submissionId, s.totalScore]),
    );
  });

  it('penalises an implausibly short programme instead of rewarding it', () => {
    const withFloor = evaluateBids(submissions, {
      ...DEFAULT_PENALTY_PROFILE,
      thresholds: { ...DEFAULT_PENALTY_PROFILE.thresholds, p10FeasibleDurationDays: 190 },
    });
    assert.ok(withFloor.scores.find((s) => s.submissionId === 'S2')?.flags.includes('UNREALISTIC_PROGRAMME'));
  });

  it('rejects a profile whose weights do not sum to one', () => {
    throwsCode(() => validatePenaltyProfile({ ...DEFAULT_PENALTY_PROFILE, priceWeight: 0.9 }), 'PENALTY_PROFILE_INVALID');
  });

  it('refuses to evaluate an empty submission set', () => {
    throwsCode(() => evaluateBids([]), 'EVALUATION_NO_SUBMISSIONS');
  });
});

describe('tender return variance', () => {
  const baseline = [
    { reference: '1.1', description: 'Excavation', unit: 'm3', quantity: 100, rateMinor: 1_000, totalMinor: 100_000 },
    { reference: '1.2', description: 'Concrete', unit: 'm3', quantity: 50, rateMinor: 20_000, totalMinor: 1_000_000 },
  ];

  it('flags scope a supplier has not priced at all', () => {
    const findings = analyseReturnVariance(baseline, [
      { supplierName: 'A', lines: baseline },
      { supplierName: 'B', lines: [baseline[0] as (typeof baseline)[0]] },
    ]);
    assert.ok(findings.some((f) => f.reference === '1.2' && f.suppliersAffected.includes('B') && f.severity === 'HIGH'));
  });

  it('flags a rate far below the pack as a likely scope misunderstanding', () => {
    const findings = analyseReturnVariance([baseline[1] as (typeof baseline)[0]], [
      { supplierName: 'A', lines: [{ ...(baseline[1] as (typeof baseline)[0]), rateMinor: 20_000 }] },
      { supplierName: 'B', lines: [{ ...(baseline[1] as (typeof baseline)[0]), rateMinor: 19_500 }] },
      { supplierName: 'C', lines: [{ ...(baseline[1] as (typeof baseline)[0]), rateMinor: 4_000 }] },
    ]);
    assert.ok(findings.some((f) => f.suppliersAffected.includes('C') && f.finding.includes('below')));
  });
});

describe('delay attribution', () => {
  const employerEvent = {
    id: 'E1',
    cause: 'CLIENT_CHANGE' as const,
    description: 'Instruction to change design',
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-21T00:00:00.000Z',
    criticalDelayDays: 20,
    affectedTaskIds: ['T1'],
    evidenceCount: 4,
    noticeServed: true,
    noticeWithinTimeBar: true,
  };
  const contractorEvent = {
    id: 'E2',
    cause: 'CONTRACTOR_RESOURCE' as const,
    description: 'Insufficient labour',
    start: '2026-01-05T00:00:00.000Z',
    end: '2026-01-15T00:00:00.000Z',
    criticalDelayDays: 10,
    affectedTaskIds: ['T1'],
    evidenceCount: 2,
    noticeServed: false,
    noticeWithinTimeBar: false,
  };

  it('gives time but not money where employer and contractor delay overlap', () => {
    const attribution = attributeDelay([employerEvent, contractorEvent]);
    assert.equal(attribution.concurrency[0]?.treatment, 'TIME_BUT_NO_MONEY');
    assert.ok(attribution.extensionOfTimeDays > 0);
    assert.ok(attribution.compensableDays < attribution.extensionOfTimeDays);
  });

  it('gives no entitlement for contractor-risk delay', () => {
    const attribution = attributeDelay([contractorEvent]);
    assert.equal(attribution.extensionOfTimeDays, 0);
    assert.equal(attribution.contractorRiskDays, 10);
  });

  it('gives time but never money for neutral events such as exceptional weather', () => {
    const attribution = attributeDelay([
      { ...employerEvent, id: 'E3', cause: 'EXCEPTIONAL_WEATHER', criticalDelayDays: 8 },
    ]);
    assert.ok(attribution.extensionOfTimeDays > 0);
    assert.equal(attribution.compensableDays, 0);
  });

  it('discounts entitlement when no contractual notice was served', () => {
    const withNotice = attributeDelay([employerEvent]);
    const withoutNotice = attributeDelay([{ ...employerEvent, noticeServed: false, noticeWithinTimeBar: false }]);
    assert.ok(withoutNotice.extensionOfTimeDays < withNotice.extensionOfTimeDays);
  });

  it('awards nothing at all for an unevidenced event', () => {
    const attribution = attributeDelay([{ ...employerEvent, evidenceCount: 0 }]);
    assert.equal(attribution.extensionOfTimeDays, 0);
    assert.ok(attribution.perEvent[0]?.notes.some((n) => n.includes('No evidence')));
  });
});

describe('claim assessment', () => {
  it('advises submitting the assessed figure, not the claimed one', () => {
    const attribution = attributeDelay([
      {
        id: 'E1',
        cause: 'CLIENT_CHANGE',
        description: 'Change',
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-21T00:00:00.000Z',
        criticalDelayDays: 20,
        affectedTaskIds: ['T1'],
        evidenceCount: 5,
        noticeServed: true,
        noticeWithinTimeBar: true,
      },
    ]);

    const assessment = assessClaim({
      attribution,
      dailyProlongationMinor: 100_000,
      claimedDays: 45,
      claimedAmountMinor: 4_500_000,
      contractualBasisIdentified: true,
      recordsContemporaneous: true,
      programmeBaselineApproved: true,
    });

    assert.ok(assessment.assessedDays < assessment.claimedDays);
    assert.ok(assessment.entitlementScore > 0.7);
    assert.equal(assessment.assessedAmountMinor, Math.round(attribution.compensableDays * 100_000));
  });

  it('advises against submitting when the record will not stand up', () => {
    const attribution = attributeDelay([
      {
        id: 'E1',
        cause: 'CLIENT_CHANGE',
        description: 'Change',
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-11T00:00:00.000Z',
        criticalDelayDays: 10,
        affectedTaskIds: ['T1'],
        evidenceCount: 1,
        noticeServed: false,
        noticeWithinTimeBar: false,
      },
    ]);

    const assessment = assessClaim({
      attribution,
      dailyProlongationMinor: 100_000,
      claimedDays: 10,
      claimedAmountMinor: 1_000_000,
      contractualBasisIdentified: false,
      recordsContemporaneous: false,
      programmeBaselineApproved: false,
    });

    assert.ok(assessment.entitlementScore < 0.4);
    assert.match(assessment.recommendation, /Do not submit|Weak position/);
  });
});

describe('payment cycle', () => {
  const terms = { applicationDayOfMonth: 25, paymentNoticeDays: 5, payLessNoticeDaysBeforeFinal: 7, finalDateDays: 30 };

  it('generates the statutory dates in the correct order', () => {
    const [first] = generatePaymentCycle('2026-07-01', 3, terms);
    assert.ok(first);
    assert.ok(first.dueDate < first.paymentNoticeDeadline);
    assert.ok(first.paymentNoticeDeadline < first.payLessNoticeDeadline);
    assert.ok(first.payLessNoticeDeadline < first.finalDateForPayment);
  });

  it('warns that an un-issued payment notice makes the applied sum payable', () => {
    const [first] = generatePaymentCycle('2026-07-01', 1, terms);
    assert.ok(first);
    const checks = checkNoticeCompliance(first, {}, '2027-01-01');
    const paymentNotice = checks.find((c) => c.notice === 'Payment notice');
    assert.equal(paymentNotice?.status, 'OVERDUE');
    assert.match(paymentNotice?.consequence ?? '', /payable in full/);
  });

  it('accepts a notice issued in time', () => {
    const [first] = generatePaymentCycle('2026-07-01', 1, terms);
    assert.ok(first);
    const checks = checkNoticeCompliance(first, { paymentNotice: first.paymentNoticeDeadline }, first.dueDate);
    assert.equal(checks[0]?.status, 'ISSUED_IN_TIME');
  });
});

describe('risk quantification', () => {
  const risk = {
    id: 'R1',
    title: 'Ground conditions',
    category: 'GROUND_CONDITIONS' as const,
    probability: 0.5,
    costImpact: { optimistic: 10_000, mostLikely: 50_000, pessimistic: 200_000 },
    scheduleImpactDays: { optimistic: 5, mostLikely: 20, pessimistic: 60 },
  };

  it('computes expected cost from probability and weighted impact', () => {
    const scored = scoreRisk(risk, 10_000_000, 400);
    assert.equal(scored.expectedCostMinor, Math.round(0.5 * ((10_000 + 4 * 50_000 + 200_000) / 6)));
  });

  it('recommends mitigation only when it pays for itself', () => {
    const worthwhile = scoreRisk(
      { ...risk, mitigations: [{ description: 'Survey', costMinor: 2_000, probabilityReduction: 0.6, impactReduction: 0.4 }] },
      10_000_000,
      400,
    );
    const wasteful = scoreRisk(
      { ...risk, mitigations: [{ description: 'Gold plating', costMinor: 500_000, probabilityReduction: 0.1, impactReduction: 0.1 }] },
      10_000_000,
      400,
    );
    assert.equal(worthwhile.residual.recommended, true);
    assert.equal(wasteful.residual.recommended, false);
  });

  it('produces a P80 contingency above the simple expected value', () => {
    const requirement = contingencyRequirement([scoreRisk(risk, 10_000_000, 400), scoreRisk({ ...risk, id: 'R2' }, 10_000_000, 400)]);
    assert.ok(requirement.p80Minor > requirement.expectedMinor);
    assert.ok(requirement.worstCaseMinor > requirement.p80Minor);
  });
});

describe('delay risk forecast', () => {
  it('ignores slippage that is absorbed by float', () => {
    const snapshot = forecastDelayRisk(
      'P1',
      [{ taskId: 'T1', taskName: 'Non critical', slippageDays: 5, totalFloat: 20, openConstraints: 0, productivityFactor: 1, onCriticalPath: false }],
      100,
      10_000,
    );
    assert.equal(snapshot.expectedDelayDays, 0);
    assert.equal(snapshot.severity, 'LOW');
  });

  it('counts slippage beyond float on the critical path', () => {
    const snapshot = forecastDelayRisk(
      'P1',
      [{ taskId: 'T1', taskName: 'Critical', slippageDays: 15, totalFloat: 0, openConstraints: 2, productivityFactor: 0.8, onCriticalPath: true }],
      100,
      10_000,
    );
    assert.ok(snapshot.expectedDelayDays > 15);
    assert.ok(snapshot.probabilityOfDelay > 0.5);
  });

  it('ranks corrective measures by cost per day recovered', () => {
    const snapshot = forecastDelayRisk(
      'P1',
      [{ taskId: 'T1', taskName: 'Critical', slippageDays: 20, totalFloat: 0, openConstraints: 1, productivityFactor: 0.9, onCriticalPath: true }],
      100,
      10_000,
    );
    const costs = snapshot.correctiveMeasures.map((m) => m.costPerDayMinor);
    assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
    assert.ok(snapshot.correctiveMeasures.length > 0);
  });
});

describe('safety forecast', () => {
  it('rates a site with poor leading indicators as high risk', () => {
    const forecast = forecastSafety({
      unsafeObservations: 30,
      nearMisses: 12,
      incidents: 2,
      headcount: 60,
      ramsAcknowledgementRate: 0.6,
      competencyComplianceRate: 0.7,
      highRiskActivitiesPlanned: 6,
      adverseWeatherDays: 5,
    });
    assert.ok(forecast.riskIndex > 0.4);
    assert.ok(['HIGH', 'CRITICAL'].includes(forecast.severity));
    assert.ok(forecast.recommendedControls.some((c) => c.includes('RAMS')));
  });

  it('rates a well-controlled site as low risk', () => {
    const forecast = forecastSafety({
      unsafeObservations: 1,
      nearMisses: 0,
      incidents: 0,
      headcount: 60,
      ramsAcknowledgementRate: 1,
      competencyComplianceRate: 1,
      highRiskActivitiesPlanned: 1,
      adverseWeatherDays: 0,
    });
    assert.equal(forecast.severity, 'LOW');
  });
});
