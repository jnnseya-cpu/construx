import { authorise, type EngineContext } from '../engines/context.ts';
import { lookupEventType, type EventGroup } from '../goldenthread/eventTypes.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
import { evaluateAccess } from '../identity/abac.ts';
import { AUTHZ_OPTIONS } from '../engines/context.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';

/**
 * The enterprise position, computed rather than assembled in a browser.
 *
 * The console previously built its portfolio view by listing projects and then
 * fetching entities per project — an N+1 that puts the aggregation rule in the
 * client, where nothing tests it and every page that wants the same number
 * computes it again slightly differently. Settled decision 6 says the interface
 * holds no rule the API does not publish, and "what is the portfolio's cost
 * variance" is exactly such a rule.
 *
 * Two things this deliberately does not do.
 *
 * It does not invent a portfolio. Where a project has published no CVR, its
 * commercial contribution is absent rather than zero, and the response says how
 * many projects are behind each figure. A total that silently treats missing as
 * nought is the most confident wrong number a dashboard can show.
 *
 * It does not aggregate across lifecycle phases as though they were the same
 * thing. A project at TENDER has no earned value and a project at OPERATIONS
 * has no remaining programme; both are counted in the estate, neither is
 * averaged into a delivery figure it cannot contribute to.
 */

export type ProjectRow = {
  projectId: string;
  name: string;
  phase: LifecyclePhase;
  sectorType: string;
  contractValueMinor: number;
  currency: string;
  /** Percent complete from measured progress. Absent where nothing is measured. */
  progressPercent?: number;
  /** Commercial standing. Absent where no CVR has been published. */
  cost?: { status: 'GREEN' | 'AMBER' | 'RED'; forecastMarginPercent: number; marginErosionPercent: number };
  /** Delivery standing against the approved baseline. Absent where none exists. */
  schedule?: { status: 'ON_TRACK' | 'AT_RISK' | 'BEHIND'; expectedDelayDays: number };
  /** 0–100. Higher is worse. Absent where the register is empty. */
  riskScore?: number;
  openIssues: number;
};

export type EnterpriseCommand = {
  asAt: string;
  estate: {
    projects: number;
    byPhase: Record<string, number>;
    totalContractValueMinor: number;
    /** The currency every figure above is in, or null where they differ. */
    currency: string | null;
  };
  financial: {
    /** Projects that have published a CVR, of the total. Read this first. */
    coverage: { withCvr: number; of: number };
    forecastFinalValueMinor: number;
    forecastFinalCostMinor: number;
    varianceMinor: number;
    unapprovedExposureMinor: number;
    /** Projects whose forecast final cost exceeds their forecast final value. */
    lossMaking: number;
  };
  delivery: {
    coverage: { withBaseline: number; of: number };
    onTrack: number;
    atRisk: number;
    behind: number;
    worstDelayDays: number;
  };
  risks: Array<{
    projectId: string;
    projectName: string;
    title: string;
    severity: 'HIGH' | 'MEDIUM' | 'LOW';
    exposureMinor: number;
    probability: number;
  }>;
  projects: ProjectRow[];
  /** Anything the caller's policy withheld, named rather than silently dropped. */
  withheld: string[];
};

function phaseOf(state: Record<string, unknown>): LifecyclePhase {
  return String(state.phase ?? 'CONCEPT') as LifecyclePhase;
}

/**
 * What changed across the tenancy in a window.
 *
 * The per-project timeline already existed; nothing answered the question at
 * enterprise scale, which is the one a director actually asks on a Monday. The
 * naive version — every event in the tenancy for seven days — is thousands of
 * rows and answers nothing, because most of what a construction platform records
 * is routine and correct.
 *
 * So this counts rather than lists, grouped by the event catalogue's own
 * `EventGroup`. A group's count is the honest headline ("commercial: 14
 * movements"), and the sample beneath it is what to look at first. Grouping is
 * read from the catalogue rather than invented here, so a new event type lands
 * in the right group without this file being touched.
 *
 * Access is evaluated per event with the same rule the audit feed uses: an
 * event whose entity the caller may not read is counted but not described. A
 * change feed that leaked one line of a record the reader cannot open would be
 * the way around every capability boundary in the system, and one that silently
 * dropped it would under-report the estate.
 */
export type ChangeWindow = {
  from: string;
  to: string;
  /** Every event in the window, whether or not it could be described. */
  total: number;
  groups: Array<{
    group: EventGroup;
    count: number;
    /** Counted but not readable by this caller. Stated, never silently dropped. */
    withheld: number;
    /** The most recent readable changes in the group, newest first. */
    sample: Array<{
      timestamp: string;
      eventType: string;
      projectId: string;
      projectName: string;
      entity: string;
    }>;
  }>;
};

/**
 * Completion confidence across the estate.
 *
 * Monte Carlo completion existed per project and nothing rolled it up, so a
 * portfolio reader could learn that one project has a 12% chance of finishing
 * on time only by opening it, one at a time.
 *
 * **What this deliberately does not do is simulate the portfolio.** Two projects
 * do not share a critical path, so there is no "portfolio P80" that means
 * anything — adding two distributions that describe unrelated networks produces
 * a number with a confidence interval and no referent. What a director actually
 * needs is the count: how many projects miss their contractual date at P80, and
 * what those projects are worth.
 *
 * It also states its own cost. A simulation per project is real work, so the
 * iteration count is lower than a single-project run would use and the response
 * says how many iterations produced it. A forecast whose precision is unstated
 * invites more confidence than it earned.
 */
export type PortfolioForecast = {
  /** Projects with a network to simulate, of the total. Read this first. */
  coverage: { simulated: number; of: number };
  iterations: number;
  /** Projects whose P80 duration exceeds their contractual duration. */
  lateAtP80: number;
  /** Contract value of those projects. What is at stake, not what is lost. */
  exposedContractValueMinor: number;
  currency: string | null;
  projects: Array<{
    projectId: string;
    name: string;
    p50Days: number;
    p80Days: number;
    /** From the project's own dates. Absent where the project has none. */
    contractualDurationDays?: number;
    /** Days by which P80 exceeds the contractual duration. Absent if not late. */
    overrunAtP80Days?: number;
  }>;
  /** Projects that could not be simulated, with the reason. Named, not dropped. */
  notSimulated: Array<{ projectId: string; name: string; reason: string }>;
};

export function portfolioForecast(
  ctx: EngineContext,
  simulate: (projectId: string, iterations: number, contractualDurationDays?: number) => { p50: number; p80: number },
  iterations = 500,
): PortfolioForecast {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'R');

  const projects = ctx.ledger.listByTenant(ctx.tenantId, 'Project');
  const rows: PortfolioForecast['projects'] = [];
  const notSimulated: PortfolioForecast['notSimulated'] = [];
  const currencies = new Set<string>();

  let lateAtP80 = 0;
  let exposedContractValueMinor = 0;

  for (const record of projects) {
    const name = String(record.state.name ?? record.refId);
    const contractual = contractualDays(record.state);

    let result;
    try {
      result = simulate(record.refId, iterations, contractual);
    } catch (error) {
      // A project at CONCEPT has no network, and that is not a failure — it is
      // the correct answer to "when will it finish". Named rather than dropped,
      // because a coverage figure with no explanation is the thing a reader
      // cannot act on.
      notSimulated.push({
        projectId: record.refId,
        name,
        reason: error instanceof Error ? error.message : 'Could not be simulated',
      });
      continue;
    }

    const row: PortfolioForecast['projects'][number] = {
      projectId: record.refId,
      name,
      p50Days: Math.round(result.p50),
      p80Days: Math.round(result.p80),
      ...(contractual === undefined ? {} : { contractualDurationDays: contractual }),
    };

    if (contractual !== undefined && result.p80 > contractual) {
      row.overrunAtP80Days = Math.round(result.p80 - contractual);
      lateAtP80 += 1;
      exposedContractValueMinor += Number(record.state.contractValueMinor ?? 0);
      currencies.add(String(record.state.currency ?? 'GBP'));
    }

    rows.push(row);
  }

  // Worst overrun first. A portfolio list ordered by anything else buries the
  // project the reader opened the screen for.
  rows.sort((a, b) => (b.overrunAtP80Days ?? -1) - (a.overrunAtP80Days ?? -1));

  return {
    coverage: { simulated: rows.length, of: projects.length },
    iterations,
    lateAtP80,
    exposedContractValueMinor,
    // Null rather than a guess, exactly as the financial position does it: no
    // exposed project, or exposure in more than one currency, both give null
    // rather than a total that reads as authoritative and is not.
    currency: currencies.size === 1 ? [...currencies][0]! : null,
    projects: rows,
    notSimulated,
  };
}

/**
 * The contractual span, in the same units the simulation answers in.
 *
 * The project's dates are calendar dates and the network is in working days, so
 * the two cannot be compared directly — a 913-day contract is not a 913-day
 * programme, and treating it as one flatters every project on the estate by
 * about forty percent.
 *
 * Five working days in seven is the approximation, applied here rather than
 * left implicit. It ignores public holidays, which is the right trade at
 * portfolio level: the question is "does this project miss its date at P80",
 * and eight bank holidays do not change that answer for a project that is
 * hundreds of days out. `businessDaysBetween` in the Construction Act engine is
 * the exact reckoning and is used where exactness is what is at stake — a
 * statutory payment deadline, where a day either way is the whole question.
 */
function contractualDays(state: Record<string, unknown>): number | undefined {
  const start = Date.parse(String(state.plannedStart ?? ''));
  const end = Date.parse(String(state.plannedCompletion ?? ''));
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return undefined;
  const calendarDays = (end - start) / 86_400_000;
  return Math.round((calendarDays * 5) / 7);
}

export function changeWindow(ctx: EngineContext, from: string, to: string, sampleSize = 4): ChangeWindow {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'R');

  const names = new Map<string, string>();
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'Project')) {
    names.set(record.refId, String(record.state.name ?? record.refId));
  }
  // Tenant-level governance — creating a portfolio, changing a role, updating a
  // policy — is committed against a pseudo-project rather than a real one, so
  // it has no name in the Project list. Naming it here is not cosmetic: without
  // this the busiest group on the panel is labelled with a raw identifier, and
  // a reader cannot tell governance from a project they have never heard of.
  names.set(`${ctx.tenantId}-governance`, 'Enterprise governance');

  const grouped = new Map<EventGroup, { count: number; withheld: number; sample: ChangeWindow['groups'][number]['sample'] }>();
  const events = ctx.ledger.events({ tenantId: ctx.tenantId, from, until: to });

  // Newest first, so a sample of four is the four most recent rather than the
  // four oldest — which on a busy week is the difference between "what changed"
  // and "what changed a week ago".
  for (const event of [...events].reverse()) {
    const definition = lookupEventType(event.eventType);
    if (!definition) continue;

    const bucket = grouped.get(definition.group) ?? { count: 0, withheld: 0, sample: [] };
    bucket.count += 1;

    const classification = classifyEntity(event.entity.refType);
    const readable =
      classification === undefined ||
      evaluateAccess(
        ctx.auth,
        classification.area,
        'R',
        { tenantId: ctx.tenantId, projectId: event.projectId, dataSensitivity: classification.sensitivity },
        AUTHZ_OPTIONS,
      ).decision === 'ALLOW';

    if (!readable) bucket.withheld += 1;
    else if (bucket.sample.length < sampleSize) {
      bucket.sample.push({
        timestamp: event.timestamp,
        eventType: event.eventType,
        projectId: event.projectId,
        projectName: names.get(event.projectId) ?? event.projectId,
        entity: event.entity.refType,
      });
    }

    grouped.set(definition.group, bucket);
  }

  return {
    from,
    to,
    total: events.length,
    groups: [...grouped.entries()]
      .map(([group, bucket]) => ({ group, ...bucket }))
      // Busiest first: the group that moved most is what a portfolio reader
      // should look at, and alphabetical order would bury it.
      .sort((a, b) => b.count - a.count || a.group.localeCompare(b.group)),
  };
}

/** Latest record of a type on a project, or undefined. */
function latest(ctx: EngineContext, projectId: string, refType: string): Record<string, unknown> | undefined {
  return ctx.ledger.list(projectId, refType).at(-1)?.state;
}

function costStatus(marginPercent: number, erosionPercent: number): 'GREEN' | 'AMBER' | 'RED' {
  // Loss-making is red whatever the erosion says; a project can be comfortably
  // above its tender margin and still be losing money if the tender was wrong.
  if (marginPercent < 0) return 'RED';
  if (erosionPercent > 2) return 'AMBER';
  return 'GREEN';
}

function scheduleStatus(delayDays: number, severity: string): 'ON_TRACK' | 'AT_RISK' | 'BEHIND' {
  if (delayDays <= 0) return 'ON_TRACK';
  return severity === 'CRITICAL' ? 'BEHIND' : 'AT_RISK';
}

/**
 * The portfolio position for one tenant.
 *
 * Reads at enterprise scope, so the capability checked is the governance one
 * rather than any project's — a delivery role holding project access does not
 * thereby hold a view across every project in the business.
 */
export function enterpriseCommand(ctx: EngineContext): EnterpriseCommand {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'R');

  const projects = ctx.ledger.listByTenant(ctx.tenantId, 'Project');
  const withheld: string[] = [];

  const byPhase: Record<string, number> = {};
  const currencies = new Set<string>();
  let totalContractValueMinor = 0;

  let forecastFinalValueMinor = 0;
  let forecastFinalCostMinor = 0;
  let unapprovedExposureMinor = 0;
  let withCvr = 0;
  let lossMaking = 0;

  let withBaseline = 0;
  let onTrack = 0;
  let atRisk = 0;
  let behind = 0;
  let worstDelayDays = 0;

  const risks: EnterpriseCommand['risks'] = [];
  const rows: ProjectRow[] = [];

  for (const record of projects) {
    const projectId = record.refId;
    const state = record.state;
    const phase = phaseOf(state);
    const name = String(state.name ?? projectId);

    byPhase[phase] = (byPhase[phase] ?? 0) + 1;
    totalContractValueMinor += Number(state.contractValueMinor ?? 0);
    currencies.add(String(state.currency ?? 'GBP'));

    const row: ProjectRow = {
      projectId,
      name,
      phase,
      sectorType: String(state.sectorType ?? ''),
      contractValueMinor: Number(state.contractValueMinor ?? 0),
      currency: String(state.currency ?? 'GBP'),
      openIssues: 0,
    };

    // --- Commercial ---------------------------------------------------------
    const cvr = latest(ctx, projectId, 'CVR');
    if (cvr) {
      withCvr += 1;
      const value = Number(cvr.forecastFinalValueMinor ?? 0);
      const cost = Number(cvr.forecastFinalCostMinor ?? 0);
      forecastFinalValueMinor += value;
      forecastFinalCostMinor += cost;
      unapprovedExposureMinor += Number(cvr.unapprovedExposureMinor ?? 0);
      if (cost > value) lossMaking += 1;

      const marginPercent = Number(cvr.forecastMarginPercent ?? 0);
      const erosionPercent = Number(cvr.marginErosionPercent ?? 0);
      row.cost = {
        status: costStatus(marginPercent, erosionPercent),
        forecastMarginPercent: marginPercent,
        marginErosionPercent: erosionPercent,
      };
    }

    // --- Delivery -----------------------------------------------------------
    const delay = latest(ctx, projectId, 'DelayRiskSnapshot');
    if (delay) {
      withBaseline += 1;
      const days = Number(delay.expectedDelayDays ?? 0);
      const status = scheduleStatus(days, String(delay.severity ?? ''));
      row.schedule = { status, expectedDelayDays: days };
      if (status === 'ON_TRACK') onTrack += 1;
      else if (status === 'AT_RISK') atRisk += 1;
      else behind += 1;
      if (days > worstDelayDays) worstDelayDays = days;
    }

    // --- Progress -----------------------------------------------------------
    const measurements = ctx.ledger.list(projectId, 'ProgressMeasurement');
    if (measurements.length > 0) {
      const total = measurements.reduce((sum, m) => sum + Number(m.state.percentComplete ?? 0), 0);
      row.progressPercent = Math.round(total / measurements.length);
    }

    // --- Risk ---------------------------------------------------------------
    const open = ctx.ledger.list(projectId, 'RiskRegisterItem').filter((r) => r.state.status === 'OPEN');
    row.openIssues = open.length;
    if (open.length > 0) {
      // The register already scores and grades each item — probability against
      // a three-point impact, with thresholds proportionate to the contract.
      // Re-deriving either here would produce a second opinion about the same
      // fact, and the two would drift.
      const worst = open.reduce((highest, r) => Math.max(highest, Number(r.state.score ?? 0)), 0);
      row.riskScore = worst > 0 ? Math.round(worst) : undefined;

      for (const item of open) {
        const grade = String(item.state.severity ?? '').toUpperCase();
        risks.push({
          projectId,
          projectName: name,
          title: String(item.state.title ?? ''),
          severity: grade === 'HIGH' || grade === 'MEDIUM' || grade === 'LOW' ? grade : 'LOW',
          // Expected cost: probability against the three-point impact, which is
          // what the register computes. Not the worst case, which is carried
          // separately and is a different question.
          exposureMinor: Number(item.state.expectedCostMinor ?? 0),
          probability: Number(item.state.probability ?? 0),
        });
      }
    }

    rows.push(row);
  }

  risks.sort((a, b) => b.exposureMinor - a.exposureMinor);

  return {
    asAt: new Date().toISOString(),
    estate: {
      projects: projects.length,
      byPhase,
      totalContractValueMinor,
      // Null rather than a guess. Summing two currencies into one figure is a
      // wrong number that looks exactly like a right one.
      currency: currencies.size === 1 ? [...currencies][0]! : null,
    },
    financial: {
      coverage: { withCvr, of: projects.length },
      forecastFinalValueMinor,
      forecastFinalCostMinor,
      varianceMinor: forecastFinalValueMinor - forecastFinalCostMinor,
      unapprovedExposureMinor,
      lossMaking,
    },
    delivery: {
      coverage: { withBaseline, of: projects.length },
      onTrack,
      atRisk,
      behind,
      worstDelayDays,
    },
    risks: risks.slice(0, 5),
    projects: rows,
    withheld,
  };
}
