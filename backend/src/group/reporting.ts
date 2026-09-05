import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';
import { GROUP_ROLES, groupOf, groupOfTenant, type GroupRoleName } from './directory.ts';
import { issuancesOf } from './issuance.ts';
import { liveProjects } from '../domain/structure.ts';

/**
 * Reporting grants and grant-filtered group reports (enterprise
 * specification §8.4, §12).
 *
 * A group role sees the billing figures the group pays for. It does not see
 * a company's operational position — how many projects, worth what, how
 * many documents it issued — unless that company said so. A reporting grant
 * is that saying-so: the company's administrator names which metrics, to
 * which group roles, over which period, whether they may be exported and
 * until when. It is recorded on the company's own chain, revisioned, and
 * revocable; a group report reads only what the grants in force allow and
 * says, company by company, what it was not allowed to read. It never
 * implies that a company it could not read had nothing to report.
 *
 * Metrics keep their currency. Nothing here converts or sums across
 * currencies: a report with two currencies shows two totals, and says so.
 * Every value names its source and the moment it was read.
 */

export const REPORT_METRICS = {
  'projects.count': { label: 'Projects', unit: 'count' },
  'projects.contract_value': { label: 'Contract value of projects', unit: 'money' },
  'people.active': { label: 'Active people', unit: 'count' },
  'documents.issued': { label: 'Documents issued', unit: 'count' },
  'acu.billed': { label: 'AI spend, billed', unit: 'money' },
  'events.governance': { label: 'Governance events', unit: 'count' },
} as const;
export type ReportMetric = keyof typeof REPORT_METRICS;
export const REPORT_METRIC_KEYS = Object.keys(REPORT_METRICS) as ReportMetric[];

export type ReportingGrant = {
  id: string;
  tenantId: string;
  groupId: string;
  metrics: ReportMetric[];
  roles: GroupRoleName[];
  exportAllowed: boolean;
  /** The period the grant covers, or open on either side. */
  periodFrom: string | null;
  periodTo: string | null;
  expiresAt: string | null;
  revision: number;
  note: string;
  grantedBy: string;
  grantedAt: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type MetricValue = { value: number; unit: 'count' | 'money'; currency?: string; source: 'construx'; asOf: string };

export type ReportSection = {
  tenantId: string;
  code: string;
  name: string;
  status: 'INCLUDED' | 'NOT_GRANTED' | 'GRANT_REVOKED';
  grantId: string | null;
  grantRevision: number | null;
  values: Partial<Record<ReportMetric, MetricValue>>;
  /** Metrics asked for that the grant does not cover. Named, not zeroed. */
  withheld: ReportMetric[];
};

export type GroupReport = {
  id: string;
  groupId: string;
  requestedBy: string;
  requestedRole: GroupRoleName;
  metrics: ReportMetric[];
  window: { from: string; to: string };
  currencyPolicy: 'ORIGINAL_CURRENCY_NO_CONVERSION';
  sections: ReportSection[];
  /** Per-currency totals of the money metrics, over the included sections only. */
  totals: Record<string, Partial<Record<ReportMetric, number>>>;
  generatedAt: string;
};

const governance = (id: string) => `${id}-governance`;

// --- grants --------------------------------------------------------------------------

export function grantsGiven(platform: Platform, tenantId: string): ReportingGrant[] {
  return platform.ledger.listByTenant(tenantId, 'ReportingGrant').map((record) => record.state as unknown as ReportingGrant);
}

export function grantsForGroup(platform: Platform, groupId: string): ReportingGrant[] {
  return platform.ledger
    .entitiesOfType('ReportingGrant')
    .map((record) => record.state as unknown as ReportingGrant)
    .filter((grant) => grant.groupId === groupId);
}

export function grantIsLive(grant: ReportingGrant, now = new Date().toISOString()): boolean {
  if (grant.revokedAt) return false;
  if (grant.expiresAt && grant.expiresAt <= now) return false;
  return true;
}

function commitGrant(platform: Platform, actorId: string, grant: ReportingGrant, eventType: 'REPORTING_GRANT_CREATED' | 'REPORTING_GRANT_REVOKED'): ReportingGrant {
  platform.ledger.commit({
    tenantId: grant.tenantId,
    projectId: governance(grant.tenantId),
    actor: { refType: 'User', refId: actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'ReportingGrant', refId: grant.id },
    nextState: { ...grant } as unknown as Record<string, unknown>,
  });
  return grant;
}

/** The company grants its group a view of named metrics (tenant administrator). */
export function createReportingGrant(
  platform: Platform,
  actor: AuthContext,
  input: { metrics: string[]; roles?: string[]; exportAllowed?: boolean; periodFrom?: string; periodTo?: string; expiresAt?: string; note?: string },
): ReportingGrant {
  const group = groupOfTenant(platform, actor.tenantId);
  if (!group) throw new DomainError('NOT_IN_GROUP', 'A reporting grant is given to a group; this company is not in one', 422);
  const metrics = [...new Set(input.metrics)] as ReportMetric[];
  if (metrics.length === 0) throw new DomainError('METRICS_REQUIRED', 'Name at least one metric');
  for (const metric of metrics) {
    if (!(metric in REPORT_METRICS)) throw new DomainError('METRIC_UNKNOWN', `${metric} is not a metric. One of: ${REPORT_METRIC_KEYS.join(', ')}`);
  }
  const roles = (input.roles && input.roles.length > 0 ? [...new Set(input.roles)] : ['GROUP_ADMIN', 'GROUP_FINANCE']) as GroupRoleName[];
  for (const role of roles) {
    if (!GROUP_ROLES.includes(role)) throw new DomainError('GROUP_ROLE_UNKNOWN', `${role} is not a group role`);
  }
  for (const [field, value] of [['periodFrom', input.periodFrom], ['periodTo', input.periodTo], ['expiresAt', input.expiresAt]] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) throw new DomainError('DATE_INVALID', `${field} is an ISO date-time`);
  }
  if (input.expiresAt && input.expiresAt <= new Date().toISOString()) throw new DomainError('EXPIRY_PAST', 'A grant cannot expire in the past');
  const grant: ReportingGrant = {
    id: ulid(),
    tenantId: actor.tenantId,
    groupId: group.id,
    metrics,
    roles,
    exportAllowed: input.exportAllowed ?? false,
    periodFrom: input.periodFrom ? new Date(input.periodFrom).toISOString() : null,
    periodTo: input.periodTo ? new Date(input.periodTo).toISOString() : null,
    expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : null,
    revision: grantsGiven(platform, actor.tenantId).length + 1,
    note: (input.note ?? '').trim().slice(0, 500),
    grantedBy: actor.actorId,
    grantedAt: new Date().toISOString(),
  };
  return commitGrant(platform, actor.actorId, grant, 'REPORTING_GRANT_CREATED');
}

export function revokeReportingGrant(platform: Platform, actor: AuthContext, grantId: string): ReportingGrant {
  const record = platform.ledger.get({ refType: 'ReportingGrant', refId: grantId });
  if (!record || record.tenantId !== actor.tenantId) throw new NotFoundError(`No reporting grant ${grantId} given by this company`);
  const grant = record.state as unknown as ReportingGrant;
  if (grant.revokedAt) throw new DomainError('GRANT_REVOKED', 'That grant is already revoked', 409);
  return commitGrant(platform, actor.actorId, { ...grant, revokedAt: new Date().toISOString(), revokedBy: actor.actorId }, 'REPORTING_GRANT_REVOKED');
}

/** Revoke every live grant a company gave one group — what a transfer out of the group does. */
export function revokeGrantsToGroup(platform: Platform, actor: AuthContext, tenantId: string, groupId: string): number {
  let revoked = 0;
  for (const grant of grantsGiven(platform, tenantId)) {
    if (grant.groupId !== groupId || !grantIsLive(grant)) continue;
    commitGrant(platform, actor.actorId, { ...grant, revokedAt: new Date().toISOString(), revokedBy: actor.actorId }, 'REPORTING_GRANT_REVOKED');
    revoked += 1;
  }
  return revoked;
}

/** The grant in force from a company to its group for a role, if any. */
export function liveGrant(platform: Platform, groupId: string, tenantId: string, role: GroupRoleName, now = new Date().toISOString()): ReportingGrant | undefined {
  return grantsGiven(platform, tenantId)
    .filter((grant) => grant.groupId === groupId && grantIsLive(grant, now) && grant.roles.includes(role))
    .sort((a, b) => b.revision - a.revision)[0];
}

// --- metrics, one company at a time -----------------------------------------------------

function inWindow(timestamp: string, from: string, to: string): boolean {
  return timestamp >= from && timestamp < to;
}

/** One metric for one company, read from that company's own records by its id. */
export function readMetric(platform: Platform, tenantId: string, metric: ReportMetric, from: string, to: string): MetricValue {
  const asOf = new Date().toISOString();
  const tenant = platform.tenant(tenantId);
  switch (metric) {
    case 'projects.count':
      return { value: liveProjects(platform.ledger, tenantId).length, unit: 'count', source: 'construx', asOf };
    case 'projects.contract_value': {
      const projects = liveProjects(platform.ledger, tenantId).map((record) => record.state);
      const value = projects.reduce((sum, project) => sum + (typeof project.contractValueMinor === 'number' ? project.contractValueMinor : 0), 0);
      return { value, unit: 'money', currency: tenant.defaultCurrency, source: 'construx', asOf };
    }
    case 'people.active':
      return { value: platform.users(tenantId).filter((user) => user.status === 'ACTIVE').length, unit: 'count', source: 'construx', asOf };
    case 'documents.issued': {
      const exports = platform.ledger.listByTenant(tenantId, 'Export').filter((record) => inWindow(String(record.state.generatedAt ?? ''), from, to)).length;
      const issued = issuancesOf(platform, tenantId).filter((issuance) => issuance.status === 'ISSUED' && inWindow(issuance.issuedAt ?? '', from, to)).length;
      return { value: exports + issued, unit: 'count', source: 'construx', asOf };
    }
    case 'acu.billed': {
      const value = platform
        .wallet(tenantId)
        .entries()
        .filter((entry) => entry.type === 'DEBIT' && inWindow(entry.timestamp, from, to))
        .reduce((sum, entry) => sum + entry.billedMinor, 0);
      return { value, unit: 'money', currency: tenant.defaultCurrency, source: 'construx', asOf };
    }
    case 'events.governance':
      return { value: platform.ledger.events({ tenantId, from, until: to }).filter((event) => event.projectId === governance(tenantId)).length, unit: 'count', source: 'construx', asOf };
  }
}

// --- the report -----------------------------------------------------------------------

function sectionFor(platform: Platform, groupId: string, role: GroupRoleName, centre: { tenantId: string; code: string }, metrics: ReportMetric[], from: string, to: string): ReportSection {
  const name = platform.tenant(centre.tenantId).legalName;
  const grant = liveGrant(platform, groupId, centre.tenantId, role);
  if (!grant) return { tenantId: centre.tenantId, code: centre.code, name, status: 'NOT_GRANTED', grantId: null, grantRevision: null, values: {}, withheld: metrics };
  const windowFrom = grant.periodFrom && grant.periodFrom > from ? grant.periodFrom : from;
  const windowTo = grant.periodTo && grant.periodTo < to ? grant.periodTo : to;
  const values: ReportSection['values'] = {};
  const withheld: ReportMetric[] = [];
  for (const metric of metrics) {
    if (grant.metrics.includes(metric)) values[metric] = readMetric(platform, centre.tenantId, metric, windowFrom, windowTo);
    else withheld.push(metric);
  }
  return { tenantId: centre.tenantId, code: centre.code, name, status: 'INCLUDED', grantId: grant.id, grantRevision: grant.revision, values, withheld };
}

function totalsOf(sections: ReportSection[]): GroupReport['totals'] {
  const totals: GroupReport['totals'] = {};
  for (const section of sections) {
    if (section.status !== 'INCLUDED') continue;
    for (const [metric, value] of Object.entries(section.values) as Array<[ReportMetric, MetricValue]>) {
      const key = value.unit === 'money' ? value.currency ?? '?' : 'count';
      totals[key] = totals[key] ?? {};
      totals[key][metric] = (totals[key][metric] ?? 0) + value.value;
    }
  }
  return totals;
}

/**
 * Run a report for the group under the role the person holds. Companies are
 * read one at a time, by id, under their own grant; nothing is read across
 * the group at once. The report is stored with its participating companies,
 * grant revisions and window, so reading it later can say what has changed.
 */
export function runGroupReport(
  platform: Platform,
  actor: AuthContext,
  groupId: string,
  held: GroupRoleName[],
  input: { metrics: string[]; tenantIds?: string[]; from?: string; to?: string },
): GroupReport {
  const group = groupOf(platform, groupId);
  const metrics = [...new Set(input.metrics)] as ReportMetric[];
  if (metrics.length === 0) throw new DomainError('METRICS_REQUIRED', 'Name at least one metric');
  for (const metric of metrics) {
    if (!(metric in REPORT_METRICS)) throw new DomainError('METRIC_UNKNOWN', `${metric} is not a metric. One of: ${REPORT_METRIC_KEYS.join(', ')}`);
  }
  const to = input.to ?? new Date().toISOString();
  const from = input.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from >= to) throw new DomainError('WINDOW_INVALID', 'The window is two ISO date-times, from before to');
  // The strongest role held is the one the grants are checked against.
  const role: GroupRoleName = held.includes('GROUP_ADMIN') ? 'GROUP_ADMIN' : held.includes('GROUP_FINANCE') ? 'GROUP_FINANCE' : 'GROUP_VIEWER';
  const wanted = input.tenantIds && input.tenantIds.length > 0 ? new Set(input.tenantIds) : null;
  const centres = group.costCentres.filter((centre) => !wanted || wanted.has(centre.tenantId));
  if (wanted) {
    for (const tenantId of wanted) {
      if (!group.costCentres.some((centre) => centre.tenantId === tenantId)) throw new NotFoundError(`${tenantId} is not a company in ${group.displayName}`);
    }
  }
  const sections = centres.map((centre) => sectionFor(platform, groupId, role, centre, metrics, from, to));
  const report: GroupReport = {
    id: ulid(),
    groupId,
    requestedBy: actor.actorId,
    requestedRole: role,
    metrics,
    window: { from, to },
    currencyPolicy: 'ORIGINAL_CURRENCY_NO_CONVERSION',
    sections,
    totals: totalsOf(sections),
    generatedAt: new Date().toISOString(),
  };
  platform.ledger.commit({
    tenantId: groupId,
    projectId: governance(groupId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType: 'GROUP_REPORT_GENERATED',
    entity: { refType: 'GroupReport', refId: report.id },
    nextState: { ...report } as unknown as Record<string, unknown>,
  });
  return report;
}

export function groupReports(platform: Platform, groupId: string): Array<Pick<GroupReport, 'id' | 'metrics' | 'window' | 'generatedAt' | 'requestedBy' | 'requestedRole'> & { companies: number; included: number }> {
  return platform.ledger
    .listByTenant(groupId, 'GroupReport')
    .map((record) => record.state as unknown as GroupReport)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
    .map((report) => ({
      id: report.id,
      metrics: report.metrics,
      window: report.window,
      generatedAt: report.generatedAt,
      requestedBy: report.requestedBy,
      requestedRole: report.requestedRole,
      companies: report.sections.length,
      included: report.sections.filter((section) => section.status === 'INCLUDED').length,
    }));
}

/**
 * Read a stored report, rechecking every grant it was built under (AT-33).
 * A section whose grant has since been revoked or has expired is withheld
 * from this read, marked as such; the stored record is not rewritten.
 */
export function readGroupReport(platform: Platform, groupId: string, reportId: string, held: GroupRoleName[]): GroupReport & { withheldSinceGeneration: string[] } {
  const record = platform.ledger.get({ refType: 'GroupReport', refId: reportId });
  if (!record || record.tenantId !== groupId) throw new NotFoundError(`No report ${reportId} in this group`);
  const stored = record.state as unknown as GroupReport;
  if (!held.includes(stored.requestedRole) && !held.includes('GROUP_ADMIN')) {
    throw new ForbiddenError(`This report was run under ${stored.requestedRole}; it is read under that role or by a group administrator`, 'GROUP_ROLE_REQUIRED');
  }
  const withheldSinceGeneration: string[] = [];
  const sections = stored.sections.map((section) => {
    if (section.status !== 'INCLUDED' || !section.grantId) return section;
    const grantRecord = platform.ledger.get({ refType: 'ReportingGrant', refId: section.grantId });
    const grant = grantRecord?.state as unknown as ReportingGrant | undefined;
    if (grant && grantIsLive(grant)) return section;
    withheldSinceGeneration.push(section.name);
    return { ...section, status: 'GRANT_REVOKED' as const, values: {}, withheld: stored.metrics };
  });
  return { ...stored, sections, totals: totalsOf(sections), withheldSinceGeneration };
}
