import { obligationFacts } from '../engines/claims.ts';
import { paymentCycleFacts } from '../engines/cost.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import { compliancePosition } from '../engines/maths/constructionAct.ts';
import { AGENTS } from './registry.ts';
import { AGENT_DIVISIONS, type AgentDivision } from './types.ts';

/**
 * The morning briefing — what the business needs to know before nine o'clock.
 *
 * This is the only thing in the platform that answers a question nobody else
 * asks: *what should I do today?* Every other screen answers a question about
 * one subject — this project's cash, that supplier's insurance, the pipeline's
 * conversion. A person running a contracting business does not have a subject.
 * They have a morning, and a list of things that will cost money if nobody
 * touches them.
 *
 * Three rules keep it from becoming a wall of noise.
 *
 * **It states, it does not summarise.** "37 opportunities detected, 29
 * automatically rejected" is a fact with a number. "Pipeline health: good" is a
 * mood. Everything here carries the figure it was derived from.
 *
 * **Everything is actionable or it is not here.** A briefing that reports
 * things nobody can act on trains its reader to skim, and the one item that
 * mattered goes past with the rest. If there is nothing to do, it says so.
 *
 * **It never invents a number.** Where the platform does not hold something —
 * a client follow-up, a subcontract quotation with no return date — the
 * briefing is silent rather than approximate. A dashboard that guesses is worse
 * than one that admits a gap, because the guess gets believed.
 */

export type BriefingSeverity = 'URGENT' | 'ATTENTION' | 'INFO';

export type BriefingAction = {
  severity: BriefingSeverity;
  /** What to do, in the imperative. */
  action: string;
  /** Why it matters, with the number behind it. */
  because: string;
  /** Where it came from, so it can be checked. */
  source: { refType: string; refId: string };
  /** When it stops being possible, where that is known. */
  dueBy?: string;
  valueMinor?: number;
};

export type RecommendedBid = {
  reference: string;
  title: string;
  clientName: string;
  region: string;
  valueMinor: number;
  score: number;
  daysToDeadline: number;
};

export type MorningBriefing = {
  /** The date the briefing describes, not the date it was rendered. */
  asAt: string;
  greeting: string;
  market: {
    detected: number;
    /** Filtered out before anybody read them — the time the radar saved. */
    rejected: number;
    suitable: number;
    recommended: RecommendedBid[];
    /** Present only when a radar run exists; a briefing does not invent one. */
    lastRunOn?: string;
  };
  /** Everything with a deadline attached, most urgent first. */
  actions: BriefingAction[];
  money: {
    /**
     * When the next application falls due. The cycle holds statutory dates
     * rather than sums — the amount is not known until somebody applies — so
     * the briefing gives the date and stays silent on the figure rather than
     * reporting a confident zero.
     */
    paymentDueBy?: string;
    /** Margin the cost report says has already gone. */
    marginErosionMinor: number;
    /** Peak funding on tenders modelled but not yet decided. */
    fundingAtStakeMinor: number;
  };
  delivery: {
    projects: number;
    /** Worst forecast delay across the estate, in days. */
    worstDelayDays: number;
    worstDelayProject?: string;
  };
  /** Findings the fleet has open, by division, so the org chart is visible. */
  fleet: Array<{ division: AgentDivision; label: string; agents: number; openFindings: number }>;
  /** One line the reader can act on if they read nothing else. */
  headline: string;
};

const DAY_MS = 86_400_000;

function money(minor: number): string {
  const major = Math.abs(minor) / 100;
  const sign = minor < 0 ? '-' : '';
  if (major >= 1_000_000) return `${sign}£${(major / 1_000_000).toFixed(2)}m`;
  if (major >= 1_000) return `${sign}£${(major / 1_000).toFixed(1)}k`;
  return `${sign}£${major.toFixed(0)}`;
}

function daysUntil(date: string, today: string): number {
  return Math.ceil((Date.parse(date) - Date.parse(today)) / DAY_MS);
}

const SEVERITY_ORDER: Record<BriefingSeverity, number> = { URGENT: 0, ATTENTION: 1, INFO: 2 };

/**
 * Compose the briefing.
 *
 * Reads across the whole tenant rather than one project, because the person
 * reading it runs the business rather than a job. Everything is materialised
 * state — there is no model in this path at all, which is deliberate: the one
 * screen somebody acts on before they have had coffee should be arithmetic.
 */
export function morningBriefing(
  ctx: EngineContext,
  options: { name?: string; today?: string } = {},
): MorningBriefing {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');

  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const governance = `${ctx.tenantId}-governance`;
  const actions: BriefingAction[] = [];

  // --- Market ---------------------------------------------------------------
  const run = ctx.ledger
    .list(governance, 'RadarRun')
    .filter((r) => r.tenantId === ctx.tenantId)
    .sort((a, b) => String(a.state.ranOn).localeCompare(String(b.state.ranOn)))
    .at(-1);

  type Screened = {
    reference: string;
    title: string;
    clientName: string;
    region: string;
    estimatedValueMinor: number;
    daysToDeadline: number;
    eligible: boolean;
    qualification: { score: number; recommendation: string };
  };

  const screened = (run?.state.results ?? []) as Screened[];
  const suitable = screened.filter((s) => s.eligible && s.qualification.recommendation !== 'NO_BID');
  const recommended: RecommendedBid[] = suitable
    .filter((s) => s.daysToDeadline >= 0)
    .sort((a, b) => b.qualification.score - a.qualification.score)
    .slice(0, 3)
    .map((s) => ({
      reference: s.reference,
      title: s.title,
      clientName: s.clientName,
      region: s.region,
      valueMinor: s.estimatedValueMinor,
      score: s.qualification.score,
      daysToDeadline: s.daysToDeadline,
    }));

  for (const bid of recommended.filter((b) => b.daysToDeadline <= 14)) {
    actions.push({
      severity: bid.daysToDeadline <= 7 ? 'URGENT' : 'ATTENTION',
      action: `Return ${bid.title} or decide not to`,
      because: `${money(bid.valueMinor)}, scored ${bid.score}, ${bid.daysToDeadline} day${bid.daysToDeadline === 1 ? '' : 's'} left`,
      source: { refType: 'RadarRun', refId: run!.refId },
      dueBy: undefined,
      valueMinor: bid.valueMinor,
    });
  }

  // --- Opportunities scored and left ----------------------------------------
  for (const opportunity of ctx.ledger.list(governance, 'Opportunity').filter((r) => r.tenantId === ctx.tenantId)) {
    if (opportunity.state.stage !== 'QUALIFIED') continue;
    const qualification = opportunity.state.qualification as { score: number; recommendation: string } | undefined;
    if (!qualification) continue;
    const due = typeof opportunity.state.submissionDueAt === 'string' ? opportunity.state.submissionDueAt : undefined;
    actions.push({
      severity: qualification.recommendation === 'BID' ? 'ATTENTION' : 'INFO',
      action: `Decide bid or no bid on ${String(opportunity.state.title)}`,
      because: `Scored ${qualification.score}, recommendation ${qualification.recommendation.replace('_', ' ').toLowerCase()}. The qualifying is already paid for.`,
      source: { refType: 'Opportunity', refId: opportunity.refId },
      dueBy: due,
      valueMinor: Number(opportunity.state.estimatedValueMinor ?? 0),
    });
  }

  // --- Delivery, across every project ---------------------------------------
  const projects = ctx.ledger.listByTenant(ctx.tenantId, 'Project').map((r) => r.state);
  let worstDelayDays = 0;
  let worstDelayProject: string | undefined;
  let marginErosionMinor = 0;
  let paymentDueBy: string | undefined;

  for (const project of projects) {
    const projectId = String(project.id);
    const name = String(project.name ?? projectId);

    // The engine reports an expected figure and a P80. The briefing carries the
    // expected one and names the P80 beside it, because a recovery plan built
    // on the average is a recovery plan that fails half the time.
    const delay = ctx.ledger.list(projectId, 'DelayRiskSnapshot').at(-1);
    const expectedDays = Math.round(Number(delay?.state.expectedDelayDays ?? 0));
    const p80Days = Math.round(Number(delay?.state.p80DelayDays ?? 0));
    if (expectedDays > worstDelayDays) {
      worstDelayDays = expectedDays;
      worstDelayProject = name;
    }
    if (delay && expectedDays > 0) {
      actions.push({
        severity: String(delay.state.severity) === 'CRITICAL' || expectedDays >= 10 ? 'URGENT' : 'ATTENTION',
        action: `Review the recovery position on ${name}`,
        because: `Forecasting ${expectedDays} days of delay, ${p80Days} at P80`,
        source: { refType: 'DelayRiskSnapshot', refId: delay.refId },
      });
    }

    // Margin erosion is the number that says the job is going wrong before
    // anybody on it has said so.
    const cvr = ctx.ledger.list(projectId, 'CVR').at(-1);
    if (cvr) {
      // The cost report holds erosion as a percentage against the tender
      // margin. Money is what a person acts on, so it is converted here rather
      // than shown as a percentage of a percentage.
      const erosionPercent = Number(cvr.state.marginErosionPercent ?? 0);
      const contractValue = Number(cvr.state.contractValueMinor ?? 0);
      const erosion = erosionPercent < 0 ? Math.round((Math.abs(erosionPercent) / 100) * contractValue) : 0;
      if (erosion > 0) {
        marginErosionMinor += erosion;
        actions.push({
          severity: 'ATTENTION',
          action: `Explain the margin movement on ${name}`,
          because: `${money(erosion)} of margin has gone since the tender — ${Math.abs(erosionPercent).toFixed(2)}% of contract value`,
          source: { refType: 'CVR', refId: cvr.refId },
          valueMinor: erosion,
        });
      }
    }

    // Payment applications. The statutory dates are generated for the whole
    // contract up front and live inside the cycle's periods, so the next one
    // due has to be found rather than read off the top.
    type Period = { cycleNumber: number; applicationDate: string; dueDate: string; finalDateForPayment: string };
    for (const cycle of ctx.ledger.list(projectId, 'PaymentCycle')) {
      const periods = (cycle.state.periods ?? []) as Period[];
      // Upstream is money the business is owed; downstream is money it owes.
      const upstream = String(cycle.state.direction) === 'UPSTREAM';
      const next = periods
        .filter((p) => daysUntil(p.applicationDate, today) >= 0)
        .sort((a, b) => a.applicationDate.localeCompare(b.applicationDate))[0];
      if (!next) continue;

      const days = daysUntil(next.applicationDate, today);
      if (days > 14) continue;
      if (!paymentDueBy || next.applicationDate < paymentDueBy) paymentDueBy = next.applicationDate;
      actions.push({
        severity: days <= 3 ? 'URGENT' : 'ATTENTION',
        action: upstream
          ? `Submit application ${next.cycleNumber} on ${name}`
          : `Certify or pay-less on application ${next.cycleNumber} for ${name}`,
        because: upstream
          ? `Due ${next.applicationDate}, ${days} day${days === 1 ? '' : 's'} away. A missed application is a month of cash.`
          : `Due ${next.applicationDate}. A missed pay-less notice means paying the notified sum in full.`,
        source: { refType: 'PaymentCycle', refId: cycle.refId },
        dueBy: next.applicationDate,
      });
    }

    // Statutory exposure that has already crystallised. The block above says
    // what is coming; this says what a missed date has already cost, which is a
    // different and more urgent thing — nobody can serve last month's notice.
    for (const cycle of ctx.ledger.list(projectId, 'PaymentCycle')) {
      const upstream = String(cycle.state.direction) === 'UPSTREAM';
      const position = compliancePosition(paymentCycleFacts(ctx.ledger, projectId, cycle.refId), today);

      if (position.totalExposureMinor > 0) {
        actions.push({
          severity: 'URGENT',
          action: upstream
            ? `Pursue the notified sum on ${name}`
            : `Take advice on the payment position for ${name}`,
          because: upstream
            ? `${money(position.totalExposureMinor)} is payable above the certified valuation because a notice was missed, late or given without its basis.`
            : `${money(position.totalExposureMinor)} is payable above what was certified because a notice was missed, late or given without its basis.`,
          source: { refType: 'PaymentCycle', refId: cycle.refId },
          valueMinor: position.totalExposureMinor,
        });
      }

      if (position.totalOverdueMinor > 0 && upstream) {
        actions.push({
          severity: 'URGENT',
          action: `Chase ${money(position.totalOverdueMinor)} past its final date on ${name}`,
          because:
            'The notified sum was not paid by the final date for payment. Statutory interest runs and the right to suspend is available on seven days’ notice.',
          source: { refType: 'PaymentCycle', refId: cycle.refId },
          valueMinor: position.totalOverdueMinor,
        });
      }
    }

    // Contractual obligations with a date on them. Nothing on the project
    // triggers these — that is precisely why they get missed — so the briefing
    // is the only place they surface before somebody notices the bond expired.
    const calendar = obligationFacts(ctx.ledger, projectId, today, 45);
    for (const entry of calendar.entries.filter((e) => e.status === 'OVERDUE' || e.status === 'APPROACHING')) {
      actions.push({
        severity: entry.status === 'OVERDUE' ? 'URGENT' : 'ATTENTION',
        action: `${entry.status === 'OVERDUE' ? 'Close out' : 'Deal with'} ${entry.description.slice(0, 70)} on ${name}`,
        because:
          entry.status === 'OVERDUE'
            ? `Was due ${entry.dueDate}, ${Math.abs(entry.daysRemaining)} day${Math.abs(entry.daysRemaining) === 1 ? '' : 's'} ago. ${entry.owner} owns it.`
            : `Due ${entry.dueDate}, ${entry.daysRemaining} day${entry.daysRemaining === 1 ? '' : 's'} away. ${entry.owner} owns it.`,
        source: entry.entityRef ?? { refType: 'Contract', refId: projectId },
        dueBy: entry.dueDate,
      });
    }

    for (const running of calendar.running.filter((r) => !r.served && !r.lost && r.daysRemaining <= 14)) {
      actions.push({
        severity: running.daysRemaining <= 5 ? 'URGENT' : 'ATTENTION',
        action: `Serve notice on ${running.trigger.slice(0, 60)} for ${name}`,
        because: `${running.daysRemaining} day${running.daysRemaining === 1 ? '' : 's'} of a ${running.timeBarDays}-day time bar left. A time bar that runs cannot be recovered by argument.`,
        source: { refType: 'Contract', refId: projectId },
      });
    }

    // Enquiries issued and not returned.
    for (const rfq of ctx.ledger.list(projectId, 'RFQ')) {
      const returnBy = rfq.state.returnDeadline;
      if (rfq.state.status !== 'ISSUED' || typeof returnBy !== 'string') continue;
      const days = daysUntil(returnBy, today);
      if (days >= 0) continue;
      actions.push({
        severity: 'ATTENTION',
        action: `Chase the ${String(rfq.state.reference ?? 'enquiry')} returns on ${name}`,
        because: `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue. A package that cannot be compared cannot be let.`,
        source: { refType: 'RFQ', refId: rfq.refId },
        dueBy: returnBy,
      });
    }
  }

  // --- Funding at stake on undecided tenders --------------------------------
  let fundingAtStakeMinor = 0;
  for (const project of projects) {
    for (const model of ctx.ledger.list(String(project.id), 'FundingModel')) {
      if (model.state.verdict === 'UNFUNDABLE' || model.state.verdict === 'TIGHT') {
        fundingAtStakeMinor += Number(model.state.peakFundingRequirementMinor ?? 0);
        actions.push({
          severity: model.state.verdict === 'UNFUNDABLE' ? 'URGENT' : 'ATTENTION',
          action: `Renegotiate terms or decline — ${String(project.name)} is ${String(model.state.verdict).toLowerCase()}`,
          because: `Peak funding ${money(Number(model.state.peakFundingRequirementMinor ?? 0))} against available working capital`,
          source: { refType: 'FundingModel', refId: model.refId },
          valueMinor: Number(model.state.peakFundingRequirementMinor ?? 0),
        });
      }
    }
  }

  // --- The fleet ------------------------------------------------------------
  const openProposals = ctx.ledger
    .listByTenant(ctx.tenantId, 'AgentProposal')
    .map((r) => r.state)
    .filter((p) => p.status === 'OPEN');

  const fleet = AGENT_DIVISIONS.map(({ division, label }) => {
    const names = new Set(AGENTS.filter((a) => a.division === division).map((a) => a.name));
    return {
      division,
      label,
      agents: names.size,
      openFindings: openProposals.filter((p) => names.has(String(p.agent))).length,
    };
  });

  actions.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (b.valueMinor ?? 0) - (a.valueMinor ?? 0),
  );

  const urgent = actions.filter((a) => a.severity === 'URGENT').length;
  const headline =
    actions.length === 0
      ? 'Nothing needs a decision today. That is a real answer, not an empty screen.'
      : urgent > 0
        ? `${urgent} thing${urgent === 1 ? '' : 's'} will cost money if nobody touches ${urgent === 1 ? 'it' : 'them'} today.`
        : `${actions.length} action${actions.length === 1 ? '' : 's'}, none of them urgent yet.`;

  return {
    asAt: today,
    greeting: `Good morning${options.name ? `, ${options.name}` : ''}.`,
    market: {
      detected: screened.length,
      rejected: screened.length - suitable.length,
      suitable: suitable.length,
      recommended,
      lastRunOn: run ? String(run.state.ranOn) : undefined,
    },
    actions,
    money: { paymentDueBy, marginErosionMinor, fundingAtStakeMinor },
    delivery: { projects: projects.length, worstDelayDays, worstDelayProject },
    fleet,
    headline,
  };
}
