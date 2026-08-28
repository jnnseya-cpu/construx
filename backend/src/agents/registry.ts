import { abbreviateMoney } from '../domain/locale.ts';
import type { EngineContext } from '../engines/context.ts';
import { PLATFORM_AGENTS } from './platform.ts';
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
  return abbreviateMoney(minor, currency);
}

const empty: AgentOutput = { findings: [], proposals: [] };

// ---------------------------------------------------------------- programme

const programmeAgent: AgentDefinition = {
  name: 'programme',
  agentId: 'AGT-PROG-DELAY',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING'],
  triggers: [{ kind: 'SCHEDULE', at: '06:00' }, { kind: 'EVENT', eventType: 'DELAY_EVENT_RECORDED' }, { kind: 'EVENT', eventType: 'PROGRESS_MEASURED' }],
  inputs: ['Approved programme baseline', 'Progress measurements', 'Delay events', 'Critical path'],
  outputs: ['Delay prediction', 'Critical-path threats', 'Recovery scenarios', 'EOT candidates with evidence chains'],
  emits: ['DELAY_FORECAST_RUN', 'RECOVERY_PLAN_PROPOSED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  division: 'DELIVERY',
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
  agentId: 'AGT-COMMERCIAL',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
  triggers: [{ kind: 'SCHEDULE', at: '07:00', days: [1] }, { kind: 'EVENT', eventType: 'CVR_PUBLISHED' }],
  inputs: ['Cost value reconciliation', 'Commitments', 'Applications and certificates', 'Variation register'],
  outputs: ['Margin-erosion alerts', 'Cost to complete', 'Over/under-claim detection', 'What changed this week'],
  emits: ['CVR_PUBLISHED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.65,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  division: 'DELIVERY',
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
  agentId: 'CX-RISK-REGISTER',
  activeIn: 'ANY',
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'EVENT', eventType: 'RISK_SCORED' }],
  inputs: ['Risk register', 'Contract value', 'Programme float'],
  outputs: ['Unmitigated exposure', 'Risks with no owner', 'Scoring drift'],
  emits: ['RISK_MITIGATION_SET'],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  division: 'DELIVERY',
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
  agentId: 'AGT-CONTRACT-OBS',
  activeIn: ['TENDER', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
  triggers: [{ kind: 'SCHEDULE', at: '06:30' }, { kind: 'EVENT', eventType: 'CONTRACT_EXECUTED' }],
  inputs: ['Executed contract', 'Clause register', 'Obligation calendar', 'Notices served'],
  outputs: ['Obligations falling due', 'Missed notice windows', 'Time-bar exposure'],
  emits: ['CONTRACT_NOTICE_SERVED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.7,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  division: 'DELIVERY',
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
  agentId: 'AGT-DESIGN-COORD',
  activeIn: ['DESIGN', 'TENDER', 'CONSTRUCTION'],
  triggers: [{ kind: 'EVENT', eventType: 'MODEL_INGESTED' }, { kind: 'EVENT', eventType: 'CLASH_RUN_COMPLETED' }, { kind: 'CONTINUOUS' }],
  inputs: ['Federated model revisions', 'Clash runs', 'Design packages', 'RFIs'],
  outputs: ['Unresolved clash exposure', 'Coordination risk by discipline', 'Freeze readiness'],
  emits: ['CLASH_RESOLVED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  division: 'DELIVERY',
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
  agentId: 'AGT-SITE-PROGRESS',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING'],
  triggers: [{ kind: 'SCHEDULE', at: '18:00' }, { kind: 'EVENT', eventType: 'DAILY_DIARY_RECORDED' }],
  inputs: ['Daily diaries', 'Progress measurement', 'Work orders', 'Site observations'],
  outputs: ['Diary gaps', 'Progress against measure', 'Productivity drift'],
  emits: ['PROGRESS_MEASURED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.55,
  acuTier: 'MED',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  division: 'DELIVERY',
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
  agentId: 'AGT-HANDOVER',
  activeIn: ['COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'EVENT', eventType: 'HANDOVER_PACK_COMPILED' }],
  inputs: ['Handover requirements matrix', 'O&M manuals', 'Asset register', 'Training records'],
  outputs: ['Handover readiness', 'Missing deliverables by requirement', 'Acceptance blockers'],
  emits: ['HANDOVER_PACK_COMPILED'],
  hitl: 'APPROVAL',
  confidenceFloor: 0.7,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ASSET'], writes: ['PROJECT', 'ASSET'] },
  division: 'DELIVERY',
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
  agentId: 'AGT-ESTIMATE',
  activeIn: ['CONCEPT', 'DESIGN', 'TENDER'],
  triggers: [{ kind: 'EVENT', eventType: 'TAKEOFF_COMPLETED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Take-off', 'Organisation rate library', 'Commodity indices', 'Risk register'],
  outputs: ['Bottom-up estimate', 'BoQ benchmark deltas', 'Assumption register'],
  emits: ['ESTIMATE_CREATED', 'ESTIMATE_REPRICED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.65,
  acuTier: 'HIGH',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  division: 'BID',
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


// ------------------------------------------------------------- market intel

/**
 * Watches the last radar run for opportunities running out of time.
 *
 * Screening finds what is worth reading; this notices when something worth
 * reading has been sat on. The commonest way a small contractor loses a job it
 * should have won is not losing it — it is failing to return it.
 */
const radarAgent: AgentDefinition = {
  name: 'radar',
  agentId: 'CX-TENDER-RADAR',
  activeIn: ['CONCEPT', 'DESIGN', 'TENDER'],
  triggers: [{ kind: 'SCHEDULE', at: '05:00' }],
  inputs: ['Published notices', 'Capability profile', 'Framework memberships'],
  outputs: ['Shortlisted notices', 'Filtered-out reasoning'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.5,
  acuTier: 'MED',
  memory: { reads: ['ORGANISATION'], writes: [] },
  division: 'MARKET_INTEL',
  purpose: 'Watches shortlisted opportunities against their return dates, and the requirements that keep disqualifying the business.',
  mandate: {
    reads: ['BUSINESS_DEVELOPMENT'],
    proposes: ['BUSINESS_DEVELOPMENT'],
    approvers: ['OWNER', 'EPC', 'PM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const run = ctx.ledger
      .list(`${ctx.tenantId}-governance`, 'RadarRun')
      .filter((r) => r.tenantId === ctx.tenantId)
      .at(-1);
    if (!run) return empty;

    type Screened = { reference: string; title: string; daysToDeadline: number; eligible: boolean; estimatedValueMinor: number; qualification: { score: number; recommendation: string } };
    const results = (run.state.results ?? []) as Screened[];

    const closing = results.filter((r) => r.eligible && r.qualification.recommendation !== 'NO_BID' && r.daysToDeadline >= 0 && r.daysToDeadline <= 14);
    for (const item of closing) {
      findings.push({
        key: `radar:closing:${item.reference}`,
        severity: item.daysToDeadline <= 7 ? 'URGENT' : 'ATTENTION',
        summary: `${item.title} closes in ${item.daysToDeadline} day${item.daysToDeadline === 1 ? '' : 's'} and scored ${item.qualification.score}`,
        consequence: `${money(item.estimatedValueMinor)} of work the screening said was worth reading. A bid not returned is a bid lost without the courtesy of losing it.`,
        evidence: [{ refType: 'RadarRun', refId: run.refId, note: `${item.reference} — ${item.daysToDeadline} days to the deadline` }],
      });
    }

    // The same requirement disqualifying the business repeatedly is a decision
    // about the company, not about any one bid, and it belongs in front of
    // whoever can actually change it.
    const reasons = new Map<string, number>();
    for (const item of results.filter((r) => !r.eligible)) {
      for (const failure of (item as unknown as { eligibilityFailures: Array<{ requirement: string }> }).eligibilityFailures ?? []) {
        reasons.set(failure.requirement, (reasons.get(failure.requirement) ?? 0) + 1);
      }
    }
    for (const [requirement, count] of reasons) {
      if (count < 2) continue;
      findings.push({
        key: `radar:systemic:${requirement}`,
        severity: 'ATTENTION',
        summary: `${requirement} disqualified the business from ${count} opportunities in one run`,
        consequence: 'Closing this gap changes what the business can chase at all. Nothing on any single bid will fix it.',
        evidence: [{ refType: 'RadarRun', refId: run.refId, note: `${count} of ${results.length} screened` }],
      });
    }

    return { findings, proposals: [] };
  },
};

// ---------------------------------------------------------------- bid engine

/**
 * Watches the pipeline for decisions nobody has taken.
 *
 * An opportunity scored and left is worse than one never looked at: the work of
 * qualifying it has been spent and none of the benefit collected.
 */
const pipelineAgent: AgentDefinition = {
  name: 'pipeline',
  agentId: 'CX-PIPELINE',
  activeIn: ['CONCEPT', 'DESIGN', 'TENDER'],
  triggers: [{ kind: 'CONTINUOUS' }],
  inputs: ['Opportunity pipeline', 'Bid decisions', 'Win/loss history'],
  outputs: ['Pipeline coverage', 'Decision latency', 'Conversion drift'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.5,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: [] },
  division: 'BID',
  purpose: 'Watches qualified opportunities awaiting a bid decision, and bids taken against the algorithm.',
  mandate: {
    reads: ['BUSINESS_DEVELOPMENT'],
    proposes: ['BUSINESS_DEVELOPMENT'],
    approvers: ['OWNER', 'EPC'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const opportunities = ctx.ledger
      .list(`${ctx.tenantId}-governance`, 'Opportunity')
      .filter((r) => r.tenantId === ctx.tenantId);

    for (const record of opportunities) {
      const state = record.state;
      if (state.stage !== 'QUALIFIED') continue;
      const qualification = state.qualification as { score: number; recommendation: string } | undefined;
      if (!qualification) continue;

      findings.push({
        key: `pipeline:undecided:${record.refId}`,
        severity: qualification.recommendation === 'BID' ? 'ATTENTION' : 'INFO',
        summary: `${String(state.title)} scored ${qualification.score} and has no bid decision`,
        consequence: `The cost of qualifying it has been spent. ${qualification.recommendation === 'BID' ? 'The algorithm says chase it.' : 'Deciding not to is still a decision worth recording.'}`,
        evidence: [{ refType: 'Opportunity', refId: record.refId, note: `${qualification.recommendation} at ${qualification.score}/100` }],
      });
    }

    return { findings, proposals: [] };
  },
};

// -------------------------------------------------------------- supply chain

/**
 * Watches whether the business can still buy what it sells.
 *
 * Expiries are the quiet failure. A supplier whose insurance lapsed is still on
 * the register, still looks approved, and cannot lawfully be sent an enquiry —
 * and nobody finds out until the enquiry is refused on the day it was needed.
 */
const supplyChainAgent: AgentDefinition = {
  name: 'supply-chain',
  agentId: 'AGT-PROCURE',
  activeIn: ['TENDER', 'CONSTRUCTION'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'EVENT', eventType: 'RFQ_ISSUED' }],
  inputs: ['Enquiries and returns', 'Subcontract register', 'Supplier performance', 'Buyout position'],
  outputs: ['Packages without cover', 'Buyout exposure', 'Single-source risk'],
  emits: ['RFQ_ISSUED', 'SUBCONTRACT_EXECUTED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  division: 'SUPPLY_CHAIN',
  purpose: 'Watches supplier eligibility, trades too thin to compete, and frameworks running out of term.',
  mandate: {
    reads: ['PROCUREMENT_AWARD'],
    proposes: ['PROCUREMENT_AWARD'],
    approvers: ['OWNER', 'EPC', 'QS', 'PM'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const register = `${ctx.tenantId}-governance`;
    const today = new Date().toISOString().slice(0, 10);

    const suppliers = ctx.ledger.list(register, 'Supplier').filter((r) => r.tenantId === ctx.tenantId);
    for (const supplier of suppliers) {
      const expiry = supplier.state.prequalificationExpiresOn;
      if (typeof expiry !== 'string') continue;
      const daysLeft = Math.ceil((Date.parse(expiry) - Date.parse(today)) / 86_400_000);
      if (daysLeft > 60 || daysLeft < 0) continue;
      findings.push({
        key: `supply-chain:lapsing:${supplier.refId}`,
        severity: daysLeft <= 30 ? 'ATTENTION' : 'INFO',
        summary: `${String(supplier.state.legalName)} lapses in ${daysLeft} days`,
        consequence: 'A lapsed firm cannot be sent an enquiry, and it will be found out on the day the enquiry was needed.',
        evidence: [{ refType: 'Supplier', refId: supplier.refId, note: `Prequalification expires ${expiry}` }],
      });
    }

    const frameworks = ctx.ledger.list(register, 'Framework').filter((r) => r.tenantId === ctx.tenantId);
    for (const framework of frameworks) {
      const endsOn = String(framework.state.endsOn ?? '');
      if (!endsOn) continue;
      const daysLeft = Math.ceil((Date.parse(endsOn) - Date.parse(today)) / 86_400_000);
      if (daysLeft > 180 || daysLeft < 0) continue;
      findings.push({
        key: `supply-chain:framework-expiry:${framework.refId}`,
        severity: daysLeft <= 90 ? 'ATTENTION' : 'INFO',
        summary: `${String(framework.state.reference)} expires in ${daysLeft} days`,
        consequence: 'Re-tendering a framework takes longer than people expect, and the gap is bought at spot rates.',
        evidence: [{ refType: 'Framework', refId: framework.refId, note: `Term ends ${endsOn}` }],
      });
    }

    return { findings, proposals: [] };
  },
};

// ---------------------------------------------------------------------- HSEQ

/**
 * Watches the duties that are legal obligations rather than good practice.
 *
 * Everything else an agent finds costs money. These cost prosecutions, so they
 * are raised as urgent whatever else is on the list.
 */
const hseqAgent: AgentDefinition = {
  name: 'hseq',
  agentId: 'AGT-HSE',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
  triggers: [{ kind: 'CONTINUOUS' }, { kind: 'EVENT', eventType: 'INCIDENT_REPORTED' }, { kind: 'EVENT', eventType: 'SAFETY_OBSERVATION_LOGGED' }],
  inputs: ['Permits', 'Method statements', 'Inductions', 'Incidents', 'Observations'],
  outputs: ['Expired or missing controls', 'Induction gaps', 'Incident trend'],
  emits: ['SAFETY_OBSERVATION_LOGGED'],
  hitl: 'REVIEW',
  confidenceFloor: 0.7,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: ['PROJECT'] },
  division: 'DELIVERY',
  purpose: 'Watches the Construction Phase Plan, RIDDOR answers and competency expiry — the duties that are law rather than preference.',
  mandate: {
    reads: ['SAFETY_RAMS', 'QUALITY_COMMISSIONING'],
    proposes: ['SAFETY_RAMS'],
    approvers: ['OWNER', 'EPC', 'PM', 'SAFETY'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const phase = latest(ctx, 'Project');

    // No construction work without an approved Construction Phase Plan. This is
    // a CDM duty, not a preference, and the platform already refuses the work —
    // the agent's job is to say so before somebody is standing on site.
    const plans = list(ctx, 'CDMDocument').filter(
      (d) => d.state.type === 'CONSTRUCTION_PHASE_PLAN' && d.state.status === 'APPROVED',
    );
    const projectPhase = String((phase as Record<string, unknown> | undefined)?.phase ?? '');
    if (plans.length === 0 && ['CONSTRUCTION', 'COMMISSIONING'].includes(projectPhase)) {
      findings.push({
        key: 'hseq:no-cpp',
        severity: 'URGENT',
        summary: 'No approved Construction Phase Plan on a project in construction',
        consequence: 'Construction work and site inductions are both refused without one, and the duty sits with the Principal Contractor personally.',
        evidence: [{ refType: 'Project', refId: ctx.projectId, note: `Project is in ${projectPhase}` }],
      });
    }

    // An incident where the RIDDOR question was never answered is an incident
    // that may be an unreported one.
    for (const incident of list(ctx, 'Incident')) {
      if (incident.state.riddorReportable !== undefined) continue;
      findings.push({
        key: `hseq:riddor-unanswered:${incident.refId}`,
        severity: 'URGENT',
        summary: `Incident ${String(incident.state.reference ?? incident.refId)} has no RIDDOR determination`,
        consequence: 'A reportable incident not reported inside the statutory period is an offence in itself.',
        evidence: [{ refType: 'Incident', refId: incident.refId, note: 'RIDDOR question unanswered' }],
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const training of list(ctx, 'TrainingRecord')) {
      const expiry = training.state.expiresOn;
      if (typeof expiry !== 'string') continue;
      const daysLeft = Math.ceil((Date.parse(expiry) - Date.parse(today)) / 86_400_000);
      if (daysLeft > 45) continue;
      findings.push({
        key: `hseq:training-expiry:${training.refId}`,
        severity: daysLeft < 0 ? 'URGENT' : 'ATTENTION',
        summary: `${String(training.state.competency ?? 'A competency')} for ${String(training.state.personName ?? 'an operative')} ${daysLeft < 0 ? 'has expired' : `expires in ${daysLeft} days`}`,
        consequence: 'A lapsed competency reads exactly like one nobody held, and it is the operative who is stopped at the gate.',
        evidence: [{ refType: 'TrainingRecord', refId: training.refId, note: `Expires ${expiry}` }],
      });
    }

    return { findings, proposals: [] };
  },
};

export const AGENTS: AgentDefinition[] = [
  // Market intelligence — what work is out there.
  radarAgent,
  // Bid engine — should we chase it, and at what price.
  pipelineAgent,
  tenderAgent,
  // Delivery engine — are the jobs we have going wrong.
  programmeAgent,
  commercialAgent,
  riskAgent,
  contractsAgent,
  designAgent,
  fieldAgent,
  handoverAgent,
  hseqAgent,
  // Supply chain — can we still buy what we sell.
  supplyChainAgent,
  // Platform operations, security, revenue, customer and compliance. Kept in
  // their own module because they read the platform's own internals — gateway
  // counters, the security stream, the wallet — rather than a project, and
  // mixing them here would make the project fleet look as though it had that
  // reach too.
  ...PLATFORM_AGENTS,
];

export function agentsByDivision(division: AgentDefinition['division']): AgentDefinition[] {
  return AGENTS.filter((a) => a.division === division);
}

export function agentByName(name: string): AgentDefinition | undefined {
  return AGENTS.find((a) => a.name === name);
}

/**
 * The agents that will actually run.
 *
 * A `DECLARED` agent has a mandate and no `evaluate`: it is in the manifest so
 * the org chart and the blast radius are inspectable, and it is not in the
 * fleet the runtime iterates. Filtering here rather than in the runtime keeps
 * "which agents exist" and "which agents run" as one question with two answers,
 * rather than two questions that drift.
 */
export function deployedAgents(): AgentDefinition[] {
  return AGENTS.filter((agent) => agent.deployment !== 'DECLARED' && typeof agent.evaluate === 'function');
}
