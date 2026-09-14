import type { EngineContext } from '../engines/context.ts';
import { authorise } from '../engines/context.ts';

/**
 * The commercial overview of one project, on one screen.
 *
 * Every figure here already existed. The contract sum is on the executed
 * contract, the committed value is the sum of the commitments, the certified
 * value is the sum of the payment certificates, the forecast final cost and the
 * unapproved exposure are fields on the published CVR, the cost breakdown is
 * the approved budget's own cost codes and the actuals are posted against those
 * same codes. What did not exist was the one read that puts them beside each
 * other, so answering "where is this job commercially" meant opening the
 * Command Centre for three of the numbers and Cost & Value for the rest.
 *
 * This composes; it computes nothing new and writes nothing. Two consequences
 * worth stating, because they are what keep it honest:
 *
 * **It never derives a figure the engines already publish.** The margin is the
 * CVR's margin, not a subtraction done here — a second arithmetic for the same
 * number is a second answer, and the one on the screen would be the one nobody
 * had tested.
 *
 * **An absent record is absent, not zero.** A project with no published CVR has
 * no forecast, and this says so by returning `null` and naming what is missing.
 * A dashboard that shows £0 forecast final cost for a project nobody has
 * forecast is worse than one that shows nothing, because £0 looks like an
 * answer.
 */

export type Headline = {
  key: string;
  label: string;
  /** Absent where the record it comes from does not exist yet. */
  amountMinor: number | null;
  /** The share this is of its reference figure, where one applies. */
  percent: number | null;
  /** What the percentage is a share *of*, so the screen never has to guess. */
  percentOf: string | null;
  /** Present only where the figure is missing, naming the record that would carry it. */
  absent?: string;
};

export type CommercialOverview = {
  projectId: string;
  header: {
    name: string;
    reference: string | null;
    client: string | null;
    contractor: string | null;
    contractForm: string | null;
    contractValueMinor: number;
    currency: string;
    plannedStart: string | null;
    plannedCompletion: string | null;
    phase: string;
  };
  headline: Headline[];
  costVsValue: {
    periods: string[];
    contractValueMinor: number[];
    forecastFinalCostMinor: Array<number | null>;
    certifiedMinor: number[];
    actualCostMinor: number[];
    /** Stated rather than implied: a curve drawn from two months is not a trend. */
    note: string;
  };
  breakdown: {
    totalMinor: number;
    byCostCode: Array<{ costCode: string; description: string; budgetMinor: number; actualMinor: number; share: number }>;
    absent?: string;
  };
  milestones: Array<{ label: string; at: string | null; state: 'DONE' | 'CURRENT' | 'AHEAD' }>;
  risks: Array<{ id: string; title: string; category: string; severity: string; expectedCostMinor: number }>;
  /**
   * Stated as a gap rather than left to be inferred from an empty list.
   *
   * A commercial overview of this shape usually carries opportunities beside
   * risks — value engineering, design development savings — as negative
   * exposure. This platform's risk register scores downside only: `scoreRisk`
   * takes a probability and an impact and returns an expected cost, and there
   * is no record anywhere that holds a priced upside. Showing an empty
   * "Opportunities" panel would imply the project has none; saying the register
   * does not model them is the truth.
   */
  opportunities: { modelled: false; because: string };
};

const PHASE_ORDER = ['CONCEPT', 'DESIGN', 'TENDER', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER', 'OPERATIONS'];

/** The month an ISO timestamp falls in, which is the grain a commercial report is read at. */
function month(iso: string): string {
  return String(iso).slice(0, 7);
}

function share(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export function commercialOverview(ctx: EngineContext): CommercialOverview {
  // The commercial position of a project is Commercial-L3 by definition: it is
  // the margin. Authorised on the area that owns it rather than on the project
  // read, so the roles cleared for the commercial position are the ones the
  // permission matrix already says are, and no wider.
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId }).state as Record<string, unknown>;
  const contracts = ctx.ledger.list(ctx.projectId, 'Contract').filter((record) => record.state.status === 'EXECUTED');
  const contract = contracts[contracts.length - 1];
  const parties = (contract?.state.parties as Array<{ role: string; partyId: string; name: string }> | undefined) ?? [];
  const client = parties.find((party) => party.role === 'CLIENT');
  const cvrs = ctx.ledger.list(ctx.projectId, 'CVR');
  const cvr = cvrs[cvrs.length - 1]?.state as Record<string, unknown> | undefined;
  const budgets = ctx.ledger.list(ctx.projectId, 'Budget').filter((record) => record.state.status === 'APPROVED');
  const budget = budgets[budgets.length - 1]?.state as Record<string, unknown> | undefined;
  const certificates = ctx.ledger.list(ctx.projectId, 'PaymentCertificate').map((record) => record.state);
  const commitments = ctx.ledger.list(ctx.projectId, 'Commitment').map((record) => record.state);
  const actuals = ctx.ledger.list(ctx.projectId, 'ActualCost').map((record) => record.state);
  const risks = ctx.ledger.list(ctx.projectId, 'RiskRegisterItem').filter((record) => record.state.status === 'OPEN');

  // The contract sum where a contract has been executed; the project's own
  // contract value before that. They are different facts and the earlier one is
  // an intention, so the header says which it is showing.
  const contractValueMinor = Number(contract?.state.contractSumMinor ?? project.contractValueMinor ?? 0);
  const committedMinor = commitments.reduce((sum, entry) => sum + Number(entry.valueMinor ?? 0), 0);
  const certifiedMinor = certificates.reduce((sum, entry) => sum + Number(entry.certifiedMinor ?? 0), 0);

  const headline: Headline[] = [
    {
      key: 'contractValue',
      label: 'Contract value',
      amountMinor: contractValueMinor,
      percent: null,
      percentOf: null,
      ...(contract ? {} : { absent: 'No executed contract — this is the project’s stated value, not a contract sum' }),
    },
    {
      key: 'committed',
      label: 'Committed',
      amountMinor: committedMinor,
      percent: share(committedMinor, contractValueMinor),
      percentOf: 'contract value',
    },
    {
      key: 'certified',
      label: 'Certified to date',
      amountMinor: certifiedMinor,
      percent: share(certifiedMinor, contractValueMinor),
      percentOf: 'contract value',
    },
    {
      key: 'forecastFinalCost',
      label: 'Forecast final cost',
      amountMinor: cvr ? Number(cvr.forecastFinalCostMinor ?? 0) : null,
      percent: cvr ? share(Number(cvr.forecastFinalCostMinor ?? 0), contractValueMinor) : null,
      percentOf: 'contract value',
      ...(cvr ? {} : { absent: 'No CVR has been published on this project' }),
    },
    {
      key: 'forecastMargin',
      label: 'Forecast margin',
      // The CVR's own margin. Not recomputed here — see the note at the top.
      amountMinor: cvr ? Number(cvr.forecastMarginMinor ?? 0) : null,
      percent: cvr && cvr.forecastMarginPercent !== undefined ? Number(cvr.forecastMarginPercent) : null,
      percentOf: 'forecast final value',
      ...(cvr ? {} : { absent: 'No CVR has been published on this project' }),
    },
    {
      key: 'exposure',
      label: 'Potential exposure',
      amountMinor: cvr ? Number(cvr.unapprovedExposureMinor ?? 0) : null,
      percent: cvr ? share(Number(cvr.unapprovedExposureMinor ?? 0), contractValueMinor) : null,
      percentOf: 'contract value',
      ...(cvr ? {} : { absent: 'No CVR has been published on this project' }),
    },
  ];

  // --- Cost against value, by month ------------------------------------------
  //
  // Built from the dates on the records themselves — a certificate's
  // `certifiedAt`, an actual's `date`, a CVR's `publishedAt` — rather than from
  // a reporting table kept alongside. Cumulative, because that is what a
  // cost-against-value curve is; the contract value is flat because it does not
  // move until a variation is agreed, at which point the CVR moves.
  const stamps = [
    ...certificates.map((entry) => month(String(entry.certifiedAt ?? ''))),
    ...actuals.map((entry) => month(String(entry.date ?? ''))),
    ...cvrs.map((record) => month(String(record.state.publishedAt ?? ''))),
  ].filter((value) => /^\d{4}-\d{2}$/.test(value));
  const periods = [...new Set(stamps)].sort();

  const cumulative = (entries: Array<Record<string, unknown>>, at: (entry: Record<string, unknown>) => string, amount: (entry: Record<string, unknown>) => number) =>
    periods.map((period) => entries.filter((entry) => at(entry) <= period).reduce((sum, entry) => sum + amount(entry), 0));

  const costVsValue = {
    periods,
    contractValueMinor: periods.map(() => contractValueMinor),
    // The forecast as it stood in each month, carried forward: a CVR published
    // in March is the forecast in April too, until another one is published.
    forecastFinalCostMinor: periods.map((period) => {
      const published = cvrs
        .map((record) => record.state as Record<string, unknown>)
        .filter((state) => month(String(state.publishedAt ?? '')) <= period);
      const latest = published[published.length - 1];
      return latest ? Number(latest.forecastFinalCostMinor ?? 0) : null;
    }),
    certifiedMinor: cumulative(certificates as Array<Record<string, unknown>>, (entry) => month(String(entry.certifiedAt ?? '')), (entry) => Number(entry.certifiedMinor ?? 0)),
    actualCostMinor: cumulative(actuals as Array<Record<string, unknown>>, (entry) => month(String(entry.date ?? '')), (entry) => Number(entry.amountMinor ?? 0)),
    note:
      periods.length === 0
        ? 'Nothing has been certified, posted or forecast on this project yet, so there is no curve to draw.'
        : periods.length < 3
          ? `${periods.length} month${periods.length === 1 ? '' : 's'} of record. Too few points to read as a trend.`
          : `${periods.length} months of record, from the certificates, the posted actuals and each published CVR.`,
  };

  // --- Where the money is, by cost code --------------------------------------
  const codes = (budget?.byCostCode as Array<{ costCode: string; description: string; budgetMinor: number }> | undefined) ?? [];
  const directTotal = codes.reduce((sum, entry) => sum + Number(entry.budgetMinor ?? 0), 0);
  const breakdown = {
    totalMinor: directTotal,
    byCostCode: codes
      .map((entry) => ({
        costCode: entry.costCode,
        description: entry.description,
        budgetMinor: Number(entry.budgetMinor ?? 0),
        actualMinor: actuals
          .filter((actual) => actual.costCode === entry.costCode)
          .reduce((sum, actual) => sum + Number(actual.amountMinor ?? 0), 0),
        share: share(Number(entry.budgetMinor ?? 0), directTotal) ?? 0,
      }))
      .sort((a, b) => b.budgetMinor - a.budgetMinor),
    ...(budget ? {} : { absent: 'No cost baseline has been approved, so there is nothing to break the cost down by' }),
  };

  // --- Where the project is -------------------------------------------------
  //
  // The phase history the project already carries, rather than a milestone
  // record invented for this screen. A phase it has not reached has no date,
  // and saying so is more useful than a projected one nobody committed to.
  const history = (project.phaseHistory as Array<{ phase: string; at: string }> | undefined) ?? [];
  const reached = new Map(history.map((entry) => [entry.phase, entry.at]));
  const current = PHASE_ORDER.indexOf(String(project.phase));
  const milestones = PHASE_ORDER.map((phase, index) => ({
    label: phase,
    at: reached.get(phase) ?? null,
    state: (index < current ? 'DONE' : index === current ? 'CURRENT' : 'AHEAD') as 'DONE' | 'CURRENT' | 'AHEAD',
  }));

  return {
    projectId: ctx.projectId,
    header: {
      name: String(project.name ?? ''),
      reference: project.reference ? String(project.reference) : null,
      contractor: parties.find((party) => party.role === 'CONTRACTOR')?.name ?? null,
      // The client by name, off the contract's own party list. A party id
      // ("CLIENT-AWA") is what the record keys on and not what anybody calls
      // the client, and a header that shows the key has not answered the
      // question it asked.
      client: client?.name ?? null,
      contractForm: contract?.state.form ? String(contract.state.form) : null,
      contractValueMinor,
      currency: String(project.currency ?? 'GBP'),
      plannedStart: project.plannedStart ? String(project.plannedStart) : null,
      plannedCompletion: project.plannedCompletion ? String(project.plannedCompletion) : null,
      phase: String(project.phase ?? ''),
    },
    headline,
    costVsValue,
    breakdown,
    milestones,
    risks: risks
      .map((record) => record.state as Record<string, unknown>)
      .map((state) => ({
        id: String(state.id),
        title: String(state.title ?? ''),
        category: String(state.category ?? ''),
        severity: String(state.severity ?? ''),
        expectedCostMinor: Number(state.expectedCostMinor ?? 0),
      }))
      .sort((a, b) => b.expectedCostMinor - a.expectedCostMinor),
    opportunities: {
      modelled: false,
      because:
        'The risk register scores downside only — a probability and an impact producing an expected cost. ' +
        'No record on this platform holds a priced upside, so there are no opportunities to show rather than none to find.',
    },
  };
}
