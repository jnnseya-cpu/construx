import { authorise, type EngineContext } from '../engines/context.ts';
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
      // A single 0–100 figure, from expected value against contract value. It
      // is a ranking device, not a currency — the money is carried alongside.
      const exposure = open.reduce((sum, r) => sum + Number(r.state.expectedValueMinor ?? 0), 0);
      const contract = Number(state.contractValueMinor ?? 0);
      row.riskScore = contract > 0 ? Math.min(100, Math.round((exposure / contract) * 1000)) : undefined;

      for (const item of open) {
        risks.push({
          projectId,
          projectName: name,
          title: String(item.state.title ?? ''),
          severity:
            Number(item.state.expectedValueMinor ?? 0) > contract * 0.02
              ? 'HIGH'
              : Number(item.state.expectedValueMinor ?? 0) > contract * 0.005
                ? 'MEDIUM'
                : 'LOW',
          exposureMinor: Number(item.state.expectedValueMinor ?? 0),
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
