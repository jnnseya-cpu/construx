import { estateBurn } from '../billing/burn.ts';
import { estateOverview } from '../billing/overview.ts';
import * as storage from '../billing/storage.ts';
import { TIERS } from '../billing/subscription.ts';
import type { AuthContext } from '../identity/auth.ts';
import { ForbiddenError, NotFoundError } from '../core/errors.ts';
import type { Platform } from '../platform.ts';
import { assurancePosition } from './assurance.ts';
import { eventStorePosition } from './eventstore.ts';
import { forecastPosition } from './forecast.ts';
import { performancePosition } from './performance.ts';
import * as growth from '../growth/partners.ts';
import * as support from '../support/queue.ts';

/**
 * The operator's reports.
 *
 * Every figure on this console already exists on some screen. What did not
 * exist was any way to take a *position* away from it — the estate as it stood
 * on a date, in one document, to put in front of a board, an auditor or an
 * investor. Screenshots of five screens are not that.
 *
 * A report here is composed, never stored. It reads the same positions the
 * console reads, at the moment it is asked for, so a report and the screen it
 * came from cannot disagree. Nothing is cached and nothing is written to the
 * ledger: a report is a view of the record, not a new fact about it, and
 * committing one would put a second copy of every number into the thing the
 * numbers are derived from.
 *
 * **Each report states what it excludes.** The operator layer cannot see
 * delivery data, so an estate report is a commercial and operational document
 * and says so on its face rather than looking like a complete picture of what
 * the platform holds.
 */

export type ReportSection = {
  heading: string;
  /** A sentence about what the section is, for somebody reading it cold. */
  intent?: string;
  /** Label/value pairs. The shape most of these positions are already in. */
  rows?: { label: string; value: string; note?: string }[];
  table?: { headers: string[]; rows: (string | number)[][]; empty?: string };
  /** Stated where a section has nothing to report, rather than rendering blank. */
  empty?: string;
};

export type Report = {
  id: string;
  title: string;
  /** What question this report answers, and for whom. */
  purpose: string;
  generatedAt: string;
  generatedBy: string;
  sections: ReportSection[];
  /** What is deliberately not in it. */
  excludes: string[];
};

export type ReportDefinition = { id: string; title: string; purpose: string };

export const REPORTS: ReportDefinition[] = [
  {
    id: 'estate',
    title: 'Estate position',
    purpose: 'Where the business stands: tenancies, identities, revenue and what is committed. For a board or an investor.',
  },
  {
    id: 'economics',
    title: 'AI economics and margin',
    purpose: 'What the estate was charged for AI against what the providers cost, and the realised multiplier.',
  },
  {
    id: 'health',
    title: 'Platform health',
    purpose: 'Whether the deployment is behaving: request performance, failures and what is configured.',
  },
  {
    id: 'integrity',
    title: 'Record integrity',
    purpose: 'Whether the Golden Thread still verifies, how much of it there is, and when each chain was last proved.',
  },
  {
    id: 'commercial',
    title: 'Commercial exposure',
    purpose: 'What lands next — renewals, trials ending, credit running out — and what the growth programme owes.',
  },
  {
    id: 'service',
    title: 'Customer service',
    purpose: 'What customers have asked for, how fast they were answered, and what is past its target.',
  },
];

const money = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const gb = (bytes: number): string => `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 2)} GB`;

function operatorOnly(actor: AuthContext): void {
  if (!actor.roles.includes('PLATFORM_ADMIN')) {
    throw new ForbiddenError('Only the platform operator may generate estate reports', 'PLATFORM_ADMIN_REQUIRED');
  }
}

function estateReport(platform: Platform): { sections: ReportSection[]; excludes: string[] } {
  const tenants = platform.tenants();
  const overview = estateOverview({
    tenancies: tenants.map((tenant) => {
      const subscription = platform.subscription(tenant.id);
      return {
        tenantId: tenant.id,
        createdAt: tenant.createdAt,
        tier: subscription.tier,
        status: subscription.status,
        seatsUsed: subscription.assignedIdentities.length,
        seatsIncluded: TIERS[subscription.tier].includedIdentities,
        identities: platform.users(tenant.id).map((user) => ({ status: user.status, administrator: user.roles.includes('ENTERPRISE_ADMIN') })),
      };
    }),
    receipts: platform.paymentReceipts(),
    awaitingPayment: platform.topUpIntents().filter((intent) => intent.status === 'AWAITING_PAYMENT'),
    operators: platform.operators().length,
  });

  const positions = tenants.map((tenant) =>
    storage.storagePosition({
      tier: platform.subscription(tenant.id).package,
      usedBytes: platform.evidence.usage(tenant.id),
      purchasedBlocks: storage.purchasedBlocks(platform.ledger, tenant.id),
    }),
  );

  return {
    sections: [
      {
        heading: 'Revenue',
        intent: 'Every settled payment the platform has recorded. Money received, not money invoiced or expected.',
        rows: [
          { label: 'Today', value: money(overview.revenue.todayMinor) },
          { label: 'Month to date', value: money(overview.revenue.monthToDateMinor) },
          { label: 'Previous month', value: money(overview.revenue.previousMonthMinor) },
          { label: 'Lifetime', value: money(overview.revenue.lifetimeMinor), note: `${overview.revenue.receipts} receipts` },
          {
            label: 'Run rate this month',
            value: overview.revenue.runRateMinor === null ? 'withheld' : money(overview.revenue.runRateMinor),
            note:
              overview.revenue.runRateBasis
                ? `${money(overview.revenue.runRateBasis.monthToDateMinor)} ÷ ${overview.revenue.runRateBasis.elapsedDays} days × ${overview.revenue.runRateBasis.daysInMonth}. Arithmetic, not a forecast.`
                : 'Too little of the month has elapsed to extrapolate honestly.',
          },
          { label: 'Raised and unsettled', value: money(overview.awaitingPayment.amountMinor), note: `${overview.awaitingPayment.count} top-ups` },
        ],
      },
      {
        heading: 'Tenancies',
        rows: [
          { label: 'Total', value: String(overview.tenancies.total) },
          { label: 'Active', value: String(overview.tenancies.active) },
          { label: 'On trial', value: String(overview.tenancies.onTrial) },
          { label: 'Suspended', value: String(overview.tenancies.suspended) },
          { label: 'Cancelled', value: String(overview.tenancies.cancelled) },
          { label: 'New in the last 30 days', value: String(overview.tenancies.newInWindow) },
          {
            label: 'With no administrator',
            value: String(overview.tenancies.unreachable),
            note: overview.tenancies.unreachable > 0 ? 'Nobody can run these. They are paying for something they cannot configure.' : undefined,
          },
        ],
      },
      {
        heading: 'Identities and seats',
        rows: [
          { label: 'Identities', value: String(overview.identities.total) },
          { label: 'Active', value: String(overview.identities.active) },
          { label: 'Seats assigned', value: String(overview.identities.seatsUsed) },
          {
            label: 'Seats included',
            value: overview.identities.seatsIncluded === null ? 'uncapped tier on the estate' : String(overview.identities.seatsIncluded),
          },
          { label: 'Platform operators', value: String(overview.identities.operators) },
        ],
      },
      {
        heading: 'Tenancy by tenancy',
        table: {
          headers: ['Tenancy', 'Tier', 'Status', 'People', 'Seats', 'Lifetime paid', 'ACU available'],
          rows: tenants.map((tenant) => {
            const subscription = platform.subscription(tenant.id);
            return [
              tenant.legalName,
              subscription.tier,
              subscription.status,
              platform.users(tenant.id).length,
              `${subscription.assignedIdentities.length} / ${TIERS[subscription.tier].includedIdentities ?? '∞'}`,
              money(platform.paymentReceipts(tenant.id).reduce((sum, receipt) => sum + receipt.amountMinor, 0)),
              money(platform.wallet(tenant.id).availableMinor()),
            ];
          }),
          empty: 'No tenancy on the estate.',
        },
      },
      {
        heading: 'Evidence storage',
        intent: 'What the platform has promised against what it is holding. Committed arrives the day a tenancy signs, not as it uploads.',
        rows: [
          { label: 'Held', value: gb(positions.reduce((sum, position) => sum + position.usedBytes, 0)) },
          { label: 'Committed', value: gb(positions.reduce((sum, position) => sum + position.limitBytes, 0)) },
          { label: 'Tenancies at warning', value: String(positions.filter((position) => position.state === 'WARNING').length) },
          { label: 'Tenancies at limit', value: String(positions.filter((position) => position.state === 'FULL').length) },
        ],
      },
    ],
    excludes: [
      'Any customer’s delivery data. The operator layer cannot read a project, a document or a record, and this report is composed from what it can.',
      'Invoiced-but-unpaid revenue. Every figure here is money actually received.',
      'Forecast revenue. The run rate is arithmetic on the month so far and is labelled as such.',
    ],
  };
}

function economicsReport(platform: Platform): { sections: ReportSection[]; excludes: string[] } {
  const burn = estateBurn(
    platform.tenants().map((tenant) => {
      const wallet = platform.wallet(tenant.id);
      return { tenantId: tenant.id, legalName: tenant.legalName, availableMinor: wallet.availableMinor(), entries: wallet.entries() };
    }),
    30,
  );

  return {
    sections: [
      {
        heading: `Estate position — last ${burn.windowDays} days`,
        rows: [
          { label: 'Charged for AI', value: money(burn.billedMinor) },
          { label: 'Provider cost', value: money(burn.rawCostMinor) },
          { label: 'Margin', value: money(burn.marginMinor) },
          { label: 'Per day', value: money(burn.dailyBurnMinor) },
          { label: 'ACU consumed', value: burn.acuUnits.toLocaleString('en-GB') },
          { label: 'Realised multiplier', value: burn.realisedMultiplier === null ? '—' : `${burn.realisedMultiplier}x` },
          {
            label: 'Absorbed',
            value: money(burn.absorbedMinor),
            note: 'An estimation-quality signal, not a leak: a charge is capped at the amount reserved, so nobody is billed above what was disclosed.',
          },
          {
            label: 'Concentration',
            value: burn.concentration === null ? '—' : `${Math.round(burn.concentration * 100)}%`,
            note: 'Share of AI spend from the single heaviest tenancy.',
          },
        ],
      },
      {
        heading: 'Where the spend went',
        intent: 'Realised routing, computed from what was actually charged rather than from the configured routing table. The two differ whenever a provider is unhealthy.',
        table: {
          headers: ['Provider', 'Executions', 'Charged', 'Share'],
          rows: burn.providers.map((provider) => [
            provider.provider,
            provider.executions,
            money(provider.billedMinor),
            `${Math.round(provider.share * 100)}%`,
          ]),
          empty: 'No AI was executed in this window.',
        },
      },
      {
        heading: 'By tenancy',
        table: {
          headers: ['Tenancy', 'Charged', 'Provider cost', 'Available', 'Days left at this rate'],
          rows: burn.tenants.map((tenant) => [
            tenant.legalName,
            money(tenant.billedMinor),
            money(tenant.rawCostMinor),
            money(tenant.availableMinor),
            tenant.runwayDays === null ? 'not spending' : String(tenant.runwayDays),
          ]),
          empty: 'No tenancy has spent in this window.',
        },
      },
    ],
    excludes: [
      'Subscription revenue. This report is AI economics only; subscriptions are in the estate report.',
      'What any tenancy used AI for. An ACU entry names a module and a feature, both billing facts, and never the content of the work.',
    ],
  };
}

function healthReport(platform: Platform): { sections: ReportSection[]; excludes: string[] } {
  const performance = performancePosition();
  const health = platform.health();

  return {
    sections: [
      {
        heading: 'Request performance',
        intent: performance.note,
        rows: [
          { label: 'Requests since start', value: performance.requestsTotal.toLocaleString('en-GB') },
          { label: 'In the measured window', value: performance.windowRequests.toLocaleString('en-GB') },
          { label: 'Median', value: `${performance.p50DurationMs}ms` },
          { label: 'p95', value: `${performance.p95DurationMs}ms` },
          { label: 'p99', value: `${performance.p99DurationMs}ms` },
          { label: 'Failures per thousand', value: String(performance.failuresPerThousand) },
        ],
      },
      {
        heading: 'Slowest routes',
        intent: 'Ranked by p95 and limited to routes called at least three times — a single cold-start read is not a performance signal.',
        table: {
          headers: ['Route', 'Calls', 'Median', 'p95', 'Slowest'],
          rows: performance.slowest.map((route) => [
            `${route.method} ${route.route}`,
            route.calls,
            `${route.p50DurationMs}ms`,
            `${route.p95DurationMs}ms`,
            `${route.maxDurationMs}ms`,
          ]),
          empty: 'Not enough traffic on this process to rank anything.',
        },
      },
      {
        heading: 'Routes returning failures',
        table: {
          headers: ['Route', 'Calls', 'Failures (5xx)', 'Refusals (4xx)'],
          rows: performance.failing.map((route) => [`${route.method} ${route.route}`, route.calls, route.failures, route.refusals]),
          empty: 'No route has returned a 500 on this process.',
        },
      },
      {
        heading: 'AI control plane',
        table: {
          headers: ['Provider', 'Role', 'Healthy'],
          rows: health.controlPlane.available.map((provider) => [provider.provider, provider.role, provider.healthy ? 'yes' : 'no']),
          empty: 'No AI provider is keyed on this deployment.',
        },
      },
    ],
    excludes: [
      'Anything from before this process started. The gateway’s log buffer is in-process and bounded; a restart empties it.',
      'Infrastructure metrics. The platform measures itself at the gateway and has no view of the host it runs on.',
    ],
  };
}

function integrityReport(platform: Platform): { sections: ReportSection[]; excludes: string[] } {
  const events = eventStorePosition(platform);
  const assurance = assurancePosition(platform);

  return {
    sections: [
      {
        heading: 'Chain verification',
        intent: 'Verification is a rotating slice through the estate, so the date each chain was last proved matters as much as the verdict.',
        rows: [
          { label: 'Chains', value: String(events.chains) },
          {
            label: 'Chains ever proved',
            value: String(assurance.projects.filter((project) => project.lastVerifiedAt).length),
            note: 'Verification rotates through the estate, so a chain not yet in this count is unproved rather than suspect.',
          },
          {
            label: 'Diverged',
            value: String(assurance.diverged.length),
            note: assurance.diverged.length > 0 ? 'A chain has been altered, deleted from or reordered. Treat it as unreliable until investigated.' : undefined,
          },
          { label: 'Passes for a full sweep', value: String(assurance.passesForFullSweep) },
          { label: 'Last pass', value: assurance.lastPassAt ?? 'never — verification has not run on this process' },
        ],
      },
      {
        heading: 'The record',
        rows: [
          { label: 'Events', value: events.total.toLocaleString('en-GB') },
          { label: 'Tenancies writing', value: String(events.tenancies) },
          { label: 'Written by a person', value: events.authorship.human.toLocaleString('en-GB') },
          { label: 'Written by a model', value: events.authorship.ai.toLocaleString('en-GB') },
          { label: 'Written by the platform', value: events.authorship.system.toLocaleString('en-GB') },
          { label: 'Carrying evidence', value: events.evidence.withEvidence.toLocaleString('en-GB') },
        ],
      },
      {
        heading: 'Durability',
        rows: [
          { label: 'Ledger holds', value: events.durability.ledgerEvents.toLocaleString('en-GB') },
          { label: 'Journal holds', value: events.durability.journalEvents.toLocaleString('en-GB') },
          { label: 'They agree', value: events.durability.agrees ? 'yes' : 'no', note: events.durability.note },
        ],
      },
      {
        heading: 'Catalogue coverage',
        intent: 'An event type defined and never emitted is either a feature nobody uses or a command nobody can reach.',
        rows: [
          { label: 'Codes defined', value: String(events.catalogue.defined) },
          { label: 'Codes ever written', value: String(events.catalogue.used) },
          { label: 'Never written', value: String(events.catalogue.unused.length) },
        ],
      },
    ],
    excludes: [
      'The content of any customer chain. Integrity is proved by walking hashes; nothing here reads what an event says.',
      'A repair. A divergence in an append-only chain cannot be repaired, and anything that claimed to would be indistinguishable from the tampering it exists to catch.',
    ],
  };
}

function commercialReport(platform: Platform, actor: AuthContext): { sections: ReportSection[]; excludes: string[] } {
  const forecast = forecastPosition(platform);
  const programme = growth.programmePosition(platform, actor);

  return {
    sections: [
      {
        heading: 'What lands next',
        intent: forecast.note,
        rows: [
          { label: 'Critical', value: String(forecast.counts.critical) },
          { label: 'Warning', value: String(forecast.counts.warning) },
          { label: 'Watch', value: String(forecast.counts.watch) },
          { label: `Renewing inside ${forecast.windowDays} days`, value: money(forecast.renewalExposureMinor) },
          { label: `Quiet for ${forecast.quietThresholdDays}+ days`, value: String(forecast.quietTenancies) },
        ],
      },
      {
        heading: 'The queue',
        table: {
          headers: ['Severity', 'Tenancy', 'What happens', 'When', 'On what basis'],
          rows: forecast.signals.map((signal) => [
            signal.severity,
            signal.legalName,
            signal.headline,
            signal.daysAway === null ? '—' : `${signal.daysAway} days`,
            signal.basis,
          ]),
          empty: 'Nothing lands inside the horizon.',
        },
      },
      {
        heading: 'Growth programme',
        intent: 'Commission is computed from settled receipts, never from signups — so nothing here is owed against money that has not arrived.',
        rows: [
          { label: 'Active agreements', value: String(programme.totals.active) },
          { label: 'Tenancies attributed', value: String(programme.totals.referredTenancies) },
          { label: 'Of those, paying', value: String(programme.totals.convertedTenancies) },
          { label: 'Revenue attributed', value: money(programme.totals.attributedRevenueMinor) },
          { label: 'Earned', value: money(programme.totals.earnedMinor) },
          { label: 'Paid', value: money(programme.totals.paidMinor) },
          { label: 'Owed', value: money(programme.totals.owedMinor) },
        ],
      },
    ],
    excludes: [
      'A churn probability. Nothing models one and a percentage on this estate would be invented.',
      'Pipeline. The platform records tenancies that exist, not conversations about ones that might.',
    ],
  };
}

function serviceReport(platform: Platform, actor: AuthContext): { sections: ReportSection[]; excludes: string[] } {
  const position = support.supportPosition(platform, actor);

  return {
    sections: [
      {
        heading: 'The queue',
        rows: [
          { label: 'Live', value: String(position.open) },
          { label: 'Waiting on us', value: String(position.awaitingPlatform) },
          { label: 'Waiting on the customer', value: String(position.awaitingCustomer) },
          { label: 'Unassigned', value: String(position.unassigned) },
          { label: 'Resolved or closed', value: String(position.resolved) },
        ],
      },
      {
        heading: 'Response',
        intent: 'First response only. A queue measured on how fast it closes things is a queue optimised for closing things.',
        rows: [
          {
            label: 'Median first response',
            value: position.medianFirstResponseHours === null ? 'nothing answered yet' : `${position.medianFirstResponseHours} hours`,
          },
          { label: 'Past the target', value: String(position.overdue) },
          { label: 'Urgent target', value: `${position.responseTargets.URGENT} hours` },
          { label: 'Normal target', value: `${position.responseTargets.NORMAL} hours` },
          { label: 'Low target', value: `${position.responseTargets.LOW} hours` },
        ],
      },
      {
        heading: 'Past the response target',
        table: {
          headers: ['Reference', 'Tenancy', 'Priority', 'Waiting', 'Target'],
          rows: position.breaching.map((entry) => [
            entry.reference,
            entry.tenantName,
            entry.priority,
            `${entry.hoursWaiting}h`,
            `${entry.targetHours}h`,
          ]),
          empty: 'Nothing is past its response target.',
        },
      },
      {
        heading: 'What people ask about',
        table: {
          headers: ['Category', 'Requests'],
          rows: position.byCategory.map((entry) => [entry.label, entry.count]),
          empty: 'Nothing has been raised.',
        },
      },
    ],
    excludes: [
      'The text of any request. A queue report is about how the queue is running; the words a customer wrote are on the request itself.',
    ],
  };
}

export function generate(platform: Platform, actor: AuthContext, reportId: string): Report {
  operatorOnly(actor);
  const definition = REPORTS.find((report) => report.id === reportId);
  if (!definition) throw new NotFoundError(`No report ${reportId}`);

  const built =
    reportId === 'estate'
      ? estateReport(platform)
      : reportId === 'economics'
        ? economicsReport(platform)
        : reportId === 'health'
          ? healthReport(platform)
          : reportId === 'integrity'
            ? integrityReport(platform)
            : reportId === 'commercial'
              ? commercialReport(platform, actor)
              : serviceReport(platform, actor);

  return {
    ...definition,
    generatedAt: new Date().toISOString(),
    generatedBy: platform.user(actor.actorId).name,
    sections: built.sections,
    excludes: built.excludes,
  };
}

export function catalogue(actor: AuthContext): ReportDefinition[] {
  operatorOnly(actor);
  return REPORTS;
}
