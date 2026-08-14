import type { EngineContext } from '../engines/context.ts';
import type { AgentDefinition, AgentOutput, Finding, ProposedCommand } from './types.ts';

/**
 * The agent fleet — one per engine, each watching the part of the project its
 * engine owns.
 *
 * Every agent here reads materialised state and applies a stated threshold. No
 * agent asks a model whether something is wrong: the trigger is arithmetic over
 * the record, so the same project state always produces the same findings, and
 * a person can check the agent's working. The models contribute narrative and
 * classification inside the engines the agents propose to run — not the
 * decision to run them.
 */

const list = (ctx: EngineContext, refType: string) => ctx.ledger.list(ctx.projectId, refType);
const latest = (ctx: EngineContext, refType: string) => list(ctx, refType).at(-1)?.state;

/** Round a money figure to a readable phrase without pulling in the UI layer. */
function money(minor: number, currency = 'GBP'): string {
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  const major = Math.abs(minor) / 100;
  const sign = minor < 0 ? '-' : '';
  if (major >= 1_000_000) return `${sign}${symbol}${(major / 1_000_000).toFixed(2)}M`;
  if (major >= 1_000) return `${sign}${symbol}${(major / 1_000).toFixed(1)}K`;
  return `${sign}${symbol}${major.toFixed(0)}`;
}

const empty: AgentOutput = { findings: [], proposals: [] };

// ---------------------------------------------------------------- programme

const programmeAgent: AgentDefinition = {
  name: 'programme',
  purpose: 'Watches the critical path and the delay forecast, and proposes the cheapest recovery that is actually applicable.',
  mandate: {
    reads: ['PROGRAMME_BASELINES', 'WORKPACKAGES_TASKS', 'FIELD_EXECUTION'],
    proposes: ['PROGRAMME_BASELINES'],
    approvers: ['PM', 'EPC', 'PLANNER', 'OWNER'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const proposals: AgentOutput['proposals'] = [];

    const baseline = list(ctx, 'ProgrammeBaseline').filter((b) => b.state.status === 'APPROVED').at(-1);
    const delay = list(ctx, 'DelayRiskSnapshot').at(-1);
    const tasks = list(ctx, 'Task');

    if (!baseline) return empty;

    // A delay forecast that is stale is worse than none, because it is trusted.
    const measured = tasks.filter((t) => Number(t.state.percentComplete ?? 0) > 0).length;
    const progressSinceForecast = delay
      ? list(ctx, 'ProgressMeasurement').filter((m) => String(m.state.recordedAt ?? '') > String(delay.state.asAt ?? '')).length
      : measured;

    if (!delay || progressSinceForecast >= 3) {
      const key = `programme:forecast-stale:${progressSinceForecast}`;
      findings.push({
        key,
        severity: delay ? 'ATTENTION' : 'URGENT',
        summary: delay
          ? `${progressSinceForecast} progress records have landed since the delay forecast was taken.`
          : 'No delay forecast has been taken against the approved baseline.',
        consequence: 'The recovery options being relied on were costed against a programme that has since moved.',
        evidence: [
          { refType: 'ProgrammeBaseline', refId: baseline.refId, note: `Baseline ${String(baseline.state.version)}` },
          ...(delay ? [{ refType: 'DelayRiskSnapshot', refId: delay.refId, note: 'Forecast being superseded' }] : []),
        ],
      });
      proposals.push({
        findingKey: key,
        autonomy: 'PROPOSE',
        command: {
          command: 'planning:forecastDelay',
          area: 'PROGRAMME_BASELINES',
          code: 'X',
          input: { contractualDurationDays: Number(baseline.state.durationDays ?? 0) },
          effect: 'Re-runs the delay forecast against current progress and re-costs every recovery measure.',
          ifDeclined: 'The programme position on screen continues to reflect a superseded forecast.',
          estimatedAcuMinor: 40,
        },
      });
    }

    if (delay && Number(delay.state.expectedDelayDays ?? 0) > 0) {
      const measures = (delay.state.correctiveMeasures ?? []) as Array<{ measure: string; recoveryDays: number; costMinor: number; costPerDayMinor: number }>;
      const cheapest = measures[0];
      const expected = Number(delay.state.expectedDelayDays);

      findings.push({
        key: `programme:delay:${delay.refId}`,
        severity: String(delay.state.severity) === 'CRITICAL' ? 'URGENT' : 'ATTENTION',
        summary: `${expected.toFixed(1)} days of forecast delay, severity ${String(delay.state.severity)}.`,
        consequence: cheapest
          ? `Cheapest recovery is "${cheapest.measure}" at ${money(cheapest.costMinor)} for ${Number(cheapest.recoveryDays ?? 0).toFixed(1)} days — ${money(cheapest.costPerDayMinor ?? 0)} per day recovered. Recovery options get more expensive the later they are taken.`
          : 'No corrective measure has been costed against this delay.',
        evidence: [{ refType: 'DelayRiskSnapshot', refId: delay.refId, note: `P80 ${String(delay.state.p80DelayDays)} days` }],
      });
    }

    return { findings, proposals };
  },
};

// --------------------------------------------------------------- commercial

const commercialAgent: AgentDefinition = {
  name: 'commercial',
  purpose: 'Watches margin, cost against budget and the certified-versus-paid position, and proposes a CVR refresh when the picture has moved.',
  mandate: {
    reads: ['BUDGET_COST', 'PAYMENT_APPLICATIONS', 'CHANGE_VARIATION'],
    proposes: ['BUDGET_COST'],
    approvers: ['QS', 'PM', 'EPC', 'OWNER'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const proposals: AgentOutput['proposals'] = [];

    const cvr = list(ctx, 'CVR').at(-1);
    const budget = list(ctx, 'Budget').filter((b) => b.state.status === 'APPROVED').at(-1);
    if (!budget) return empty;

    const actuals = list(ctx, 'ActualCost');
    const sinceCvr = cvr
      ? actuals.filter((a) => String(a.state.postedAt ?? a.state.date ?? '') > String(cvr.state.publishedAt ?? '')).length
      : actuals.length;

    if (sinceCvr >= 2) {
      const key = `commercial:cvr-stale:${sinceCvr}`;
      findings.push({
        key,
        severity: 'ATTENTION',
        summary: `${sinceCvr} cost postings since the CVR was published.`,
        consequence: 'The forecast margin being reported does not include the most recent spend.',
        evidence: cvr ? [{ refType: 'CVR', refId: cvr.refId, note: `Published ${String(cvr.state.publishedAt).slice(0, 10)}` }] : [],
      });
      proposals.push({
        findingKey: key,
        autonomy: 'PROPOSE',
        command: {
          command: 'cost:publishCVR',
          area: 'BUDGET_COST',
          code: 'X',
          input: { period: new Date().toISOString().slice(0, 7) },
          effect: 'Republishes the cost value reconciliation against current actuals, commitments and variations.',
          ifDeclined: 'Margin and cash position continue to be reported from stale costs.',
          estimatedAcuMinor: 60,
        },
      });
    }

    if (cvr && Number(cvr.state.marginErosionPercent ?? 0) > 2) {
      findings.push({
        key: `commercial:erosion:${cvr.refId}`,
        severity: Number(cvr.state.forecastMarginPercent ?? 0) < 0 ? 'URGENT' : 'ATTENTION',
        summary: `Margin has eroded ${Number(cvr.state.marginErosionPercent).toFixed(2)} points against tender, now ${Number(cvr.state.forecastMarginPercent).toFixed(2)}%.`,
        consequence: 'Erosion at this rate is recoverable through change and productivity while the job is running, and not afterwards.',
        evidence: [{ refType: 'CVR', refId: cvr.refId, note: `Forecast final cost ${money(Number(cvr.state.forecastFinalCostMinor ?? 0))}` }],
      });
    }

    // Cost codes running over budget, worth naming individually.
    const spendByCode = new Map<string, number>();
    for (const actual of actuals) {
      const code = String(actual.state.costCode);
      spendByCode.set(code, (spendByCode.get(code) ?? 0) + Number(actual.state.amountMinor ?? 0));
    }
    for (const line of (budget.state.byCostCode ?? []) as Array<{ costCode: string; description: string; budgetMinor: number }>) {
      const spent = spendByCode.get(line.costCode) ?? 0;
      if (line.budgetMinor > 0 && spent > line.budgetMinor) {
        findings.push({
          key: `commercial:overspend:${line.costCode}`,
          severity: 'URGENT',
          summary: `${line.costCode} (${line.description}) has spent ${money(spent)} against a budget of ${money(line.budgetMinor)}.`,
          consequence: 'An overspent code with work still to come will not recover on its own.',
          evidence: [{ refType: 'Budget', refId: budget.refId, note: `Baseline ${String(budget.state.version ?? '')}` }],
        });
      }
    }

    return { findings, proposals };
  },
};

// -------------------------------------------------------------------- risk

const riskAgent: AgentDefinition = {
  name: 'risk',
  purpose: 'Watches the risk register and the leading safety indicators, and proposes a contingency reassessment when exposure moves.',
  mandate: {
    reads: ['RISK_REGISTER', 'SAFETY_RAMS'],
    proposes: ['RISK_REGISTER'],
    approvers: ['SAFETY', 'PM', 'EPC', 'OWNER'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const proposals: AgentOutput['proposals'] = [];

    const risks = list(ctx, 'RiskRegisterItem').filter((r) => r.state.status === 'OPEN');
    if (risks.length === 0) return empty;

    const exposure = risks.reduce((sum, r) => sum + Number(r.state.expectedCostMinor ?? 0), 0);

    // A mitigation that pays for itself and has not been funded is money left
    // on the table, and it is the most actionable thing on this screen.
    for (const risk of risks) {
      const mitigations = (risk.state.mitigations ?? []) as Array<{ description: string; netBenefitMinor?: number; funded?: boolean }>;
      const worthwhile = mitigations.find((m) => Number(m.netBenefitMinor ?? 0) > 0 && !m.funded);
      if (!worthwhile) continue;

      findings.push({
        key: `risk:unfunded-mitigation:${risk.refId}`,
        severity: 'ATTENTION',
        summary: `"${String(risk.state.title)}" has a mitigation worth ${money(Number(worthwhile.netBenefitMinor))} net that is not funded.`,
        consequence: `Not funding it keeps ${money(Number(risk.state.expectedCostMinor ?? 0))} of expected cost on the project for no offsetting saving.`,
        evidence: [{ refType: 'RiskRegisterItem', refId: risk.refId, note: worthwhile.description }],
      });
    }

    const safety = latest(ctx, 'SafetyForecast');
    if (safety && String(safety.severity) !== 'LOW') {
      findings.push({
        key: `risk:safety:${String(safety.severity)}:${String(safety.riskIndex)}`,
        severity: String(safety.severity) === 'HIGH' ? 'URGENT' : 'ATTENTION',
        summary: `Safety risk index ${String(safety.riskIndex)} (${String(safety.severity)}), ${String(safety.expectedRecordables ?? '?')} expected recordables in 30 days.`,
        consequence: 'The leading indicators behind this move before incidents do, which is the only point at which they can be acted on.',
        evidence: [{ refType: 'SafetyForecast', refId: String(safety.id), note: 'Leading indicator forecast' }],
      });
    }

    const contingency = latest(ctx, 'ContingencyAssessment');
    if (!contingency || exposure > Number(contingency?.assessedExposureMinor ?? 0) * 1.15) {
      const key = `risk:contingency-stale:${risks.length}`;
      findings.push({
        key,
        severity: 'ATTENTION',
        summary: `Open risk exposure is ${money(exposure)} across ${risks.length} risks.`,
        consequence: 'The contingency being held was set against a different exposure, so it is either short or idle.',
        evidence: risks.slice(0, 3).map((r) => ({ refType: 'RiskRegisterItem', refId: r.refId, note: String(r.state.title) })),
      });
      proposals.push({
        findingKey: key,
        autonomy: 'PROPOSE',
        command: {
          command: 'safety:assessContingency',
          area: 'RISK_REGISTER',
          // Pure arithmetic over the open register — it reads, it does not run
          // a model, so it is a read capability and not an AI execution.
          code: 'R',
          input: {},
          effect: 'Recomputes the P80 contingency requirement across the open register.',
          ifDeclined: 'The contingency held continues to be sized against a superseded register.',
          estimatedAcuMinor: 0,
        },
      });
    }

    return { findings, proposals };
  },
};

// --------------------------------------------------------------- contracts

const contractsAgent: AgentDefinition = {
  name: 'contracts',
  purpose: 'Watches notices against their time bars and change against its downstream effect. A missed time bar cannot be recovered by argument.',
  mandate: {
    reads: ['CONTRACTS_CLAIMS', 'CHANGE_VARIATION', 'PAYMENT_APPLICATIONS'],
    proposes: ['CONTRACTS_CLAIMS'],
    approvers: ['QS', 'PM', 'EPC', 'OWNER'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const proposals: AgentOutput['proposals'] = [];

    // Delay events with no notice served are the classic way entitlement is
    // lost, so they are surfaced individually rather than as a count.
    for (const event of list(ctx, 'DelayEvent')) {
      if (event.state.noticeServed) continue;
      findings.push({
        key: `contracts:no-notice:${event.refId}`,
        severity: 'URGENT',
        summary: `Delay event "${String(event.state.description).slice(0, 60)}" has no notice served.`,
        consequence: 'Entitlement for this event is at risk of being time-barred, and no amount of later evidence recovers a notice that was never served.',
        evidence: [{ refType: 'DelayEvent', refId: event.refId, note: `${String(event.state.criticalDelayDays)} days critical` }],
      });
    }

    for (const notice of list(ctx, 'Notice')) {
      if (notice.state.withinTimeBar !== false) continue;
      findings.push({
        key: `contracts:late-notice:${notice.refId}`,
        severity: 'ATTENTION',
        summary: `Notice ${String(notice.state.reference ?? notice.refId.slice(-6))} was served outside its time bar.`,
        consequence: 'Recorded rather than hidden — the contemporaneous record is what supports an argument on waiver later.',
        evidence: [{ refType: 'Notice', refId: notice.refId, note: String(notice.state.noticeType ?? '') }],
      });
    }

    const claim = list(ctx, 'Claim').at(-1);
    const contract = list(ctx, 'Contract').filter((c) => c.state.status === 'EXECUTED').at(-1);
    const delayEvents = list(ctx, 'DelayEvent').length;
    const assessedOver = Number(claim?.state.evidencePackEventCount ?? 0);
    if (claim && contract && delayEvents > assessedOver) {
      const key = `contracts:claim-stale:${delayEvents}`;
      findings.push({
        key,
        severity: 'ATTENTION',
        summary: `${delayEvents} delay events recorded, against a claim whose evidence pack covered ${assessedOver}.`,
        consequence: 'The assessed entitlement understates the position, and an under-claimed event is as lost as an unclaimed one.',
        evidence: [{ refType: 'Claim', refId: claim.refId, note: `Assessed ${String(claim.state.assessedDays)} days` }],
      });
      proposals.push({
        findingKey: key,
        autonomy: 'PROPOSE',
        command: {
          command: 'claims:assessDelayClaim',
          area: 'CONTRACTS_CLAIMS',
          code: 'X',
          // Carried forward from the claim being superseded, so approving this
          // reassesses the same claim rather than opening a different one.
          input: {
            contractId: contract.refId,
            claimType: String(claim.state.type ?? 'EOT'),
            claimedDays: Number(claim.state.claimedDays ?? 0),
            claimedAmountMinor: Number(claim.state.claimedAmountMinor ?? 0),
            dailyProlongationMinor: 250_000,
          },
          effect: 'Reassesses the claim across every recorded delay event, including concurrency.',
          ifDeclined: 'The claim position continues to be argued from an incomplete set of events.',
          estimatedAcuMinor: 75,
        },
      });
    }

    return { findings, proposals };
  },
};

// ------------------------------------------------------------------ design

const designAgent: AgentDefinition = {
  name: 'design',
  purpose: 'Watches clashes and design maturity, and keeps the cost of fixing something once built in front of whoever can still avoid it.',
  mandate: {
    reads: ['BIM_TWIN', 'DESIGN_INFORMATION'],
    proposes: ['BIM_TWIN'],
    approvers: ['BIM', 'PM', 'EPC', 'DESIGNER'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];

    const critical = list(ctx, 'Clash').filter((c) => c.state.status === 'OPEN' && c.state.severity === 'CRITICAL');
    if (critical.length > 0) {
      const worst = critical.reduce((a, b) => (Number(b.state.severityScore ?? 0) > Number(a.state.severityScore ?? 0) ? b : a));
      findings.push({
        key: `design:critical-clashes:${critical.length}`,
        severity: 'URGENT',
        summary: `${critical.length} critical clash${critical.length === 1 ? '' : 'es'} unresolved, worst scoring ${Number(worst.state.severityScore ?? 0).toFixed(2)} at ${String(worst.state.location ?? 'unstated location')}.`,
        consequence: 'Clash severity here is weighted by what it costs to fix once built — structural and below-ground clashes cost an order of magnitude more after the pour than before it.',
        evidence: critical.slice(0, 3).map((c) => ({
          refType: 'Clash',
          refId: c.refId,
          note: `${String(c.state.disciplineA)} vs ${String(c.state.disciplineB)} at ${String(c.state.location ?? '')}`,
        })),
      });
    }

    const maturity = latest(ctx, 'DesignMaturityAssessment');
    if (maturity && Number(maturity.score ?? 100) < 70) {
      findings.push({
        key: `design:maturity:${String(maturity.score)}`,
        severity: 'ATTENTION',
        summary: `Design maturity is ${String(maturity.score)}, supporting a ${String(maturity.supportablePricingBasis ?? 'target cost')} basis only.`,
        consequence: 'Pricing lump sum against this maturity moves the risk of the gaps onto whoever prices it, and it comes back as change.',
        evidence: [{ refType: 'DesignMaturityAssessment', refId: String(maturity.id), note: String(maturity.gaps ?? '') }],
      });
    }

    return { findings, proposals: [] };
  },
};

// ------------------------------------------------------------------- field

const fieldAgent: AgentDefinition = {
  name: 'field',
  purpose: 'Watches measurement coverage and open snags, because a forecast built on thin data is a guess wearing a number.',
  mandate: {
    reads: ['FIELD_EXECUTION', 'WORKPACKAGES_TASKS', 'QUALITY_COMMISSIONING'],
    proposes: ['FIELD_EXECUTION'],
    approvers: ['PM', 'EPC', 'SUPERVISOR'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];

    const tasks = list(ctx, 'Task');
    if (tasks.length === 0) return empty;

    const unmeasured = tasks.filter((t) => Number(t.state.percentComplete ?? 0) === 0 && t.state.status !== 'NOT_STARTED');
    const coverage = (tasks.length - unmeasured.length) / tasks.length;

    if (coverage < 0.8) {
      findings.push({
        key: `field:coverage:${Math.round(coverage * 100)}`,
        severity: coverage < 0.5 ? 'URGENT' : 'ATTENTION',
        summary: `Only ${Math.round(coverage * 100)}% of activities carry a measurement.`,
        consequence: 'Earned value and the delay forecast are both computed from measured progress, so both are reported at low confidence until this closes.',
        evidence: unmeasured.slice(0, 3).map((t) => ({ refType: 'Task', refId: t.refId, note: `${String(t.state.activityCode)} · ${String(t.state.name)}` })),
      });
    }

    const stale = list(ctx, 'Snag').filter((s) => s.state.status === 'OPEN' && !s.state.responsibleTrade);
    if (stale.length > 0) {
      findings.push({
        key: `field:unrouted-snags:${stale.length}`,
        severity: 'ATTENTION',
        summary: `${stale.length} open snag${stale.length === 1 ? '' : 's'} with no responsible trade.`,
        consequence: 'A snag with no owner is a snag nobody closes; routing by cost code is what turns a list into work.',
        evidence: stale.slice(0, 3).map((s) => ({ refType: 'Snag', refId: s.refId, note: String(s.state.description ?? '') })),
      });
    }

    return { findings, proposals: [] };
  },
};

// ---------------------------------------------------------------- handover

const handoverAgent: AgentDefinition = {
  name: 'handover',
  purpose: 'Watches handover completeness, defects under warranty and the maintenance forecast across the operating life.',
  mandate: {
    reads: ['HANDOVER_OM', 'QUALITY_COMMISSIONING'],
    proposes: ['HANDOVER_OM'],
    approvers: ['FM', 'OWNER', 'PM'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const proposals: AgentOutput['proposals'] = [];

    const pack = list(ctx, 'HandoverPack').at(-1);
    if (pack) {
      const gaps = (pack.state.gaps ?? []) as string[];
      if (gaps.length > 0) {
        findings.push({
          key: `handover:gaps:${gaps.length}`,
          severity: 'ATTENTION',
          summary: `Handover pack is ${Math.round(Number(pack.state.completeness ?? 0) * 100)}% complete with ${gaps.length} gap${gaps.length === 1 ? '' : 's'}: ${gaps.join(', ')}.`,
          consequence: 'A pack accepted with qualifications leaves the qualification as the operator’s problem for the life of the asset.',
          evidence: [{ refType: 'HandoverPack', refId: pack.refId, note: String(pack.state.status ?? '') }],
        });
      }
    }

    const openDefects = list(ctx, 'Defect').filter((d) => d.state.status !== 'CLOSED');
    const underWarranty = openDefects.filter((d) => d.state.warrantyCovered);
    if (underWarranty.length > 0) {
      findings.push({
        key: `handover:warranty-defects:${underWarranty.length}`,
        severity: 'ATTENTION',
        summary: `${underWarranty.length} open defect${underWarranty.length === 1 ? ' sits' : 's sit'} under an active warranty.`,
        consequence: 'Warranty cover expires on a date, and a defect recharged after that date is paid for twice.',
        evidence: underWarranty.slice(0, 3).map((d) => ({ refType: 'Defect', refId: d.refId, note: String(d.state.description ?? '') })),
      });
    }

    const assets = list(ctx, 'AssetRegisterItem').length;
    const forecast = latest(ctx, 'MaintenanceForecast');
    if (assets > 0 && !forecast) {
      const key = `handover:no-forecast:${assets}`;
      findings.push({
        key,
        severity: 'INFO',
        summary: `${assets} assets registered with no maintenance forecast.`,
        consequence: 'Whole-life cost is unbudgeted, which is where the operating surprise comes from.',
        evidence: [],
      });
      proposals.push({
        findingKey: key,
        autonomy: 'PROPOSE',
        command: {
          command: 'handover:forecastMaintenance',
          area: 'HANDOVER_OM',
          code: 'X',
          input: { horizonYears: 5 },
          effect: 'Produces a reliability-adjusted maintenance forecast across the registered assets.',
          ifDeclined: 'Operating cost stays unbudgeted for the asset life.',
          estimatedAcuMinor: 50,
        },
      });
    }

    return { findings, proposals };
  },
};

// ------------------------------------------------------------------ tender

const tenderAgent: AgentDefinition = {
  name: 'tender',
  purpose: 'Watches the tender position — estimate currency, return variance and award conditions that were never closed out.',
  mandate: {
    reads: ['ESTIMATE_TENDER', 'PROCUREMENT_AWARD', 'BOQ_TAKEOFF'],
    proposes: ['ESTIMATE_TENDER'],
    approvers: ['QS', 'PM', 'EPC'],
    maxUnattended: 'PROPOSE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];

    const adjudication = list(ctx, 'Adjudication').at(-1);
    if (adjudication) {
      const conditions = (adjudication.state.conditions ?? []) as string[];
      const contract = list(ctx, 'Contract').filter((c) => c.state.status === 'EXECUTED').at(-1);
      if (conditions.length > 0 && contract) {
        findings.push({
          key: `tender:award-conditions:${adjudication.refId}`,
          severity: 'ATTENTION',
          summary: `${conditions.length} award condition${conditions.length === 1 ? '' : 's'} were attached to the recommendation: ${conditions.join('; ')}.`,
          consequence: 'A condition attached at award and not closed before execution becomes a change after it.',
          evidence: [
            { refType: 'Adjudication', refId: adjudication.refId, note: String(adjudication.state.selectedSupplier ?? '') },
            { refType: 'Contract', refId: contract.refId, note: 'Executed' },
          ],
        });
      }

      if (adjudication.state.deviatedFromRecommendation) {
        findings.push({
          key: `tender:deviation:${adjudication.refId}`,
          severity: 'URGENT',
          summary: 'The award deviated from the scored recommendation.',
          consequence: 'A deviation is defensible only with a recorded reason, and this is the record that will be asked for.',
          evidence: [{ refType: 'Adjudication', refId: adjudication.refId, note: String(adjudication.state.rationale ?? 'no rationale recorded') }],
        });
      }
    }

    const evaluation = list(ctx, 'BidEvaluation').at(-1);
    if (evaluation) {
      const outliers = ((evaluation.state.scores ?? []) as Array<{ supplierName: string; flags?: string[] }>).filter(
        (s) => (s.flags ?? []).length >= 3,
      );
      for (const outlier of outliers) {
        findings.push({
          key: `tender:flagged-bid:${evaluation.refId}:${outlier.supplierName}`,
          severity: 'INFO',
          summary: `${outlier.supplierName} carried ${(outlier.flags ?? []).length} penalty flags: ${(outlier.flags ?? []).join(', ')}.`,
          consequence: 'The cheapest number on a bid list with this many qualifications is usually the most expensive outcome.',
          evidence: [{ refType: 'BidEvaluation', refId: evaluation.refId, note: 'Deterministic scoring' }],
        });
      }
    }

    return { findings, proposals: [] };
  },
};

export const AGENTS: AgentDefinition[] = [
  programmeAgent,
  commercialAgent,
  riskAgent,
  contractsAgent,
  designAgent,
  fieldAgent,
  handoverAgent,
  tenderAgent,
];

export function agentByName(name: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.name === name);
}
