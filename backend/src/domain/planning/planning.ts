import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import type { PermissionCode } from '../../identity/roles.ts';
import { FEE_ROUTES, FEE_SCHEDULES, FeeInputError, quoteFee, scheduleHash, type FeeQuoteResult, type FeeRoute } from './fees.ts';
import { areaDivergence, geodeticAreaM2, GeometryError, parseSiteGeometry, type SiteGeometry } from './geometry.ts';
import { evaluateRules, RULE_PACK_VERSION, rulePackHash, SITE_FACTS, THRESHOLDS, type Finding, type Gate, type RuleInput, type SiteFactKey } from './rules.ts';

/**
 * CONSTRUX Planning, first release: the appraisal half.
 *
 * The red line and its measured area, the facts recorded about the site, the
 * proposals and their scenarios, the rules evaluated against them, standard
 * planning fees and the planning costs. Every record is a ledger entity on the
 * project; the publication of a rule version is a company record on the
 * tenancy's governance stream. Every command checks the module grant and the
 * PLANNING_CONSENT permission, and nothing here is computed by a model.
 *
 * Records that the specification calls immutable are immutable by
 * construction: a new red line is a new revision, a changed proposal is a new
 * version, an evaluation and a fee quote are never rewritten. Each evaluation
 * reports itself stale when what it read has moved on, rather than silently
 * re-running.
 */

const governance = (ctx: EngineContext) => `${ctx.tenantId}-governance`;

/**
 * What runs after a planning write: the gates and releases re-check themselves
 * against what changed, and record their own invalidation. Registered by
 * `gates.ts` rather than imported, so this module does not depend on the one
 * that depends on it.
 */
const afterChange: Array<(ctx: EngineContext) => void> = [];
export function onPlanningChange(listener: (ctx: EngineContext) => void): void {
  if (!afterChange.includes(listener)) afterChange.push(listener);
}
export function planningChanged(ctx: EngineContext): void {
  for (const listener of afterChange) listener(ctx);
}

export function guard(ctx: EngineContext, code: PermissionCode): void {
  requireModule(ctx.grantedModules, 'PLANNING');
  authorise(ctx, 'PLANNING_CONSENT', code);
}

export const states = <T>(ctx: EngineContext, type: string): T[] => ctx.ledger.list(ctx.projectId, type).map((record) => record.state as unknown as T);

export function text(value: unknown, field: string, min: number, what: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length < min) throw new DomainError('PLANNING_FIELD_REQUIRED', what, 422, [{ field, message: what }]);
  return trimmed;
}

// =============================================================================
// Rule versions: prepared by one person, published by another
// =============================================================================

export type RulePack = { version: string; kind: 'FEE_SCHEDULE' | 'EVALUATION'; title: string; sources: string[]; hash: string; effective?: string; content: unknown };

export function rulePacks(): RulePack[] {
  return [
    {
      version: RULE_PACK_VERSION,
      kind: 'EVALUATION',
      title: 'England housing rules: major development, flood risk, EIA screening, BNG, validation, CIL, determination period',
      sources: [
        'https://www.legislation.gov.uk/uksi/2015/595/article/2',
        'https://www.gov.uk/guidance/flood-risk-assessment-flood-zones-1-2-3-and-3b',
        'https://www.legislation.gov.uk/uksi/2017/571/schedule/2',
        'https://www.gov.uk/guidance/biodiversity-net-gain',
        'https://www.gov.uk/guidance/determining-a-planning-application',
      ],
      hash: rulePackHash(),
      content: THRESHOLDS,
    },
    ...FEE_SCHEDULES.map((schedule) => ({
      version: schedule.version,
      kind: 'FEE_SCHEDULE' as const,
      title: schedule.title,
      sources: [schedule.sourceUrl],
      hash: scheduleHash(schedule),
      content: schedule,
      effective: `${schedule.effectiveFrom} to ${schedule.effectiveTo}`,
    })),
  ];
}

type RuleVersionRecord = {
  id: string;
  version: string;
  status: 'PREPARED' | 'PUBLISHED' | 'RETURNED';
  hash: string;
  preparedBy: string;
  preparedAt: string;
  checkNote: string;
  /** The content as it was checked: what a later change is compared against. */
  content?: unknown;
  publishedBy?: string;
  publishedAt?: string;
  publishNote?: string;
  returnedBy?: string;
  returnedAt?: string;
  returnReason?: string;
};

export type RuleVersionPosition = RulePack & {
  status: 'UNPUBLISHED' | 'PREPARED' | 'PUBLISHED' | 'CHANGED_SINCE_PUBLISHED' | 'RETURNED';
  record?: RuleVersionRecord;
  /** Whether the reader prepared it — and so may not publish it. */
  preparedByYou: boolean;
};

const ruleRef = (ctx: EngineContext, version: string) => ({ refType: 'PlanningRuleVersion', refId: `${ctx.tenantId}-${version}` });

function ruleRecord(ctx: EngineContext, version: string): RuleVersionRecord | undefined {
  const record = ctx.ledger.get(ruleRef(ctx, version));
  return record && record.tenantId === ctx.tenantId ? (record.state as unknown as RuleVersionRecord) : undefined;
}

export function ruleVersions(ctx: EngineContext): RuleVersionPosition[] {
  guard(ctx, 'R');
  return ruleVersionPositions(ctx);
}

/** The same positions without the reader's permission check, for the watching agent (which runs under the module grant). */
export function ruleVersionPositions(ctx: EngineContext): RuleVersionPosition[] {
  return rulePacks().map((pack) => {
    const record = ruleRecord(ctx, pack.version);
    const status: RuleVersionPosition['status'] = !record
      ? 'UNPUBLISHED'
      : record.hash !== pack.hash
        ? record.status === 'PUBLISHED'
          ? 'CHANGED_SINCE_PUBLISHED'
          : 'UNPUBLISHED'
        : record.status;
    return { ...pack, status, ...(record ? { record } : {}), preparedByYou: record?.status === 'PREPARED' && record.preparedBy === ctx.auth.actorId };
  });
}

function packOf(version: string): RulePack {
  const pack = rulePacks().find((entry) => entry.version === version);
  if (!pack) throw new DomainError('RULE_VERSION_NOT_FOUND', `${version} is not a rule version this platform holds.`, 404);
  return pack;
}

/** A rule editor records that the version was checked against its sources, and how. */
export function prepareRuleVersion(ctx: EngineContext, input: { version: string; checkNote: string }): RuleVersionRecord {
  guard(ctx, 'U');
  const pack = packOf(input.version);
  const checkNote = text(input.checkNote, 'checkNote', 20, 'Say what was checked against which published source — each figure, each threshold.');
  const existing = ruleRecord(ctx, pack.version);
  if (existing?.status === 'PUBLISHED' && existing.hash === pack.hash) {
    throw new DomainError('RULE_VERSION_PUBLISHED', `${pack.version} is already published, unchanged.`, 409);
  }
  const record: RuleVersionRecord = { id: ruleRef(ctx, pack.version).refId, version: pack.version, status: 'PREPARED', hash: pack.hash, preparedBy: ctx.auth.actorId, preparedAt: new Date().toISOString(), checkNote, content: pack.content };
  write(ctx, { eventType: 'PLANNING_RULE_VERSION_PREPARED', entity: ruleRef(ctx, pack.version), projectId: governance(ctx), nextState: record, reason: `${pack.version} checked: ${checkNote}` });
  return record;
}

/** A different person, holding approval, publishes it. Never the one who prepared it. */
export function publishRuleVersion(ctx: EngineContext, input: { version: string; note: string }): RuleVersionRecord {
  guard(ctx, 'A');
  const pack = packOf(input.version);
  const existing = ruleRecord(ctx, pack.version);
  if (!existing || existing.status !== 'PREPARED' || existing.hash !== pack.hash) {
    throw new DomainError('RULE_VERSION_NOT_PREPARED', `${pack.version} has not been checked and prepared in its current form, so it cannot be published.`, 409);
  }
  if (existing.preparedBy === ctx.auth.actorId) {
    throw new DomainError('RULE_VERSION_SAME_PERSON', 'The person who prepared a rule version cannot also publish it. A second person publishes.', 403);
  }
  const note = text(input.note, 'note', 5, 'Say what you reviewed before publishing.');
  const record: RuleVersionRecord = { ...existing, status: 'PUBLISHED', publishedBy: ctx.auth.actorId, publishedAt: new Date().toISOString(), publishNote: note };
  write(ctx, { eventType: 'PLANNING_RULE_VERSION_PUBLISHED', entity: ruleRef(ctx, pack.version), projectId: governance(ctx), nextState: record, reason: `${pack.version} published: ${note}` });
  planningChanged(ctx);
  return record;
}

export function returnRuleVersion(ctx: EngineContext, input: { version: string; reason: string }): RuleVersionRecord {
  guard(ctx, 'A');
  const pack = packOf(input.version);
  const existing = ruleRecord(ctx, pack.version);
  if (!existing || existing.status !== 'PREPARED') throw new DomainError('RULE_VERSION_NOT_PREPARED', `${pack.version} is not awaiting publication.`, 409);
  const reason = text(input.reason, 'reason', 5, 'Say what is wrong so the editor can correct it.');
  const record: RuleVersionRecord = { ...existing, status: 'RETURNED', returnedBy: ctx.auth.actorId, returnedAt: new Date().toISOString(), returnReason: reason };
  write(ctx, { eventType: 'PLANNING_RULE_VERSION_RETURNED', entity: ruleRef(ctx, pack.version), projectId: governance(ctx), nextState: record, reason: `${pack.version} returned: ${reason}` });
  return record;
}

/** Every leaf of a rule version's content, by path. */
function leaves(value: unknown, path = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      for (const [leaf, leafValue] of leaves(child, path ? `${path}.${key}` : key)) out.set(leaf, leafValue);
    }
  } else {
    out.set(path, value);
  }
  return out;
}

export type RuleDifference = { path: string; from: unknown; to: unknown };

export function differences(from: unknown, to: unknown): RuleDifference[] {
  const before = leaves(from);
  const after = leaves(to);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .map((path) => ({ path, from: before.get(path) ?? null, to: after.get(path) ?? null }));
}

export type RuleVersionDetail = RuleVersionPosition & {
  /** Against the previous version of the same kind — what the new schedule changes. */
  comparedWith?: string;
  differences: RuleDifference[];
  /** Against the content as it was checked, where it has changed since. */
  changedSinceChecked: RuleDifference[];
  impact: {
    projects: number;
    payableQuotes: number;
    unpayableQuotes: number;
    staleEvaluations: number;
    openPacks: number;
  };
};

/** Source differences and the impact on the company's open projects, for the rule administrator. */
export function ruleVersionDetail(ctx: EngineContext, version: string): RuleVersionDetail {
  guard(ctx, 'R');
  const position = ruleVersionPositions(ctx).find((entry) => entry.version === version);
  if (!position) throw new DomainError('RULE_VERSION_NOT_FOUND', `${version} is not a rule version this platform holds.`, 404);
  const sameKind = rulePacks().filter((entry) => entry.kind === position.kind);
  const previous = sameKind[sameKind.findIndex((entry) => entry.version === version) - 1];
  const quotes = ctx.ledger.listByTenant(ctx.tenantId, 'PlanningFeeQuote').map((record) => ({ projectId: record.projectId, state: record.state as unknown as FeeQuoteRecord }));
  const pinned = ctx.ledger.listByTenant(ctx.tenantId, 'PlanningEvaluation').map((record) => ({ projectId: record.projectId, state: record.state as unknown as EvaluationRecord }));
  const packs = ctx.ledger.listByTenant(ctx.tenantId, 'PlanningPack').map((record) => ({ projectId: record.projectId, state: record.state as { status: string; items: Array<{ kind: string; refId: string; hash?: string }> } }));
  const onVersion = quotes.filter((entry) => entry.state.ruleVersion === version);
  const staleEvaluations = position.kind === 'EVALUATION' ? pinned.filter((entry) => entry.state.ruleVersion === version && entry.state.rulePackHash !== position.hash) : [];
  const openPacks = packs.filter((entry) => entry.state.status === 'ASSEMBLED' && entry.state.items.some((item) => item.kind === 'RULE_VERSION' && item.refId === version));
  const projects = new Set([...onVersion, ...staleEvaluations, ...openPacks].map((entry) => entry.projectId));
  return {
    ...position,
    ...(previous ? { comparedWith: previous.version } : {}),
    differences: previous ? differences(previous.content, position.content) : [],
    changedSinceChecked: position.record?.content !== undefined ? differences(position.record.content, position.content) : [],
    impact: {
      projects: projects.size,
      payableQuotes: onVersion.filter((entry) => entry.state.amountMinor !== null).length,
      unpayableQuotes: onVersion.filter((entry) => entry.state.amountMinor === null).length,
      staleEvaluations: staleEvaluations.length,
      openPacks: openPacks.length,
    },
  };
}

const isPublished = (ctx: EngineContext, pack: RulePack): boolean => {
  const record = ruleRecord(ctx, pack.version);
  return record?.status === 'PUBLISHED' && record.hash === pack.hash;
};

function publishedFeeVersions(ctx: EngineContext): Set<string> {
  return new Set(rulePacks().filter((pack) => pack.kind === 'FEE_SCHEDULE' && isPublished(ctx, pack)).map((pack) => pack.version));
}

// =============================================================================
// The red line
// =============================================================================

export type SiteVersion = {
  id: string;
  revision: number;
  geometry: SiteGeometry;
  calculatedAreaM2: number;
  /** The confirmed legal red-line area, held apart from the drawn one. */
  confirmedAreaM2: number | null;
  authority: { name: string; code?: string; confirmed: boolean; source?: string };
  boundarySource: string;
  recordedBy: string;
  recordedAt: string;
  accepted?: { by: string; at: string; note: string };
};

export function siteVersions(ctx: EngineContext): SiteVersion[] {
  return states<SiteVersion>(ctx, 'PlanningSiteVersion').sort((a, b) => a.revision - b.revision);
}

function siteVersion(ctx: EngineContext, id: string): SiteVersion {
  const found = siteVersions(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('SITE_VERSION_NOT_FOUND', 'No such red-line revision on this project.', 404);
  return found;
}

export function recordSiteVersion(
  ctx: EngineContext,
  input: { geometry: unknown; confirmedAreaM2?: number | null; authority: { name: string; code?: string; confirmed: boolean; source?: string }; boundarySource: string },
): SiteVersion & { divergence: ReturnType<typeof areaDivergence> } {
  guard(ctx, 'C');
  let geometry: SiteGeometry;
  try {
    geometry = parseSiteGeometry(input.geometry);
  } catch (error) {
    if (error instanceof GeometryError) throw new DomainError('SITE_GEOMETRY_INVALID', error.message, 422, [{ field: 'geometry', message: error.message }]);
    throw error;
  }
  const confirmed = input.confirmedAreaM2 ?? null;
  if (confirmed !== null && (!Number.isFinite(confirmed) || confirmed <= 0)) {
    throw new DomainError('SITE_AREA_INVALID', 'The confirmed area is a positive number of square metres.', 422, [{ field: 'confirmedAreaM2', message: 'positive m²' }]);
  }
  const name = text(input.authority?.name, 'authority.name', 3, 'Name the local planning authority, even if it is still to be confirmed.');
  if (input.authority.confirmed && !input.authority.source?.trim()) {
    throw new DomainError('AUTHORITY_SOURCE_REQUIRED', 'A confirmed authority needs the source it was confirmed from.', 422, [{ field: 'authority.source', message: 'where it was confirmed' }]);
  }
  const boundarySource = text(input.boundarySource, 'boundarySource', 3, 'Say where the boundary came from — the title plan, a survey, a drawing and its revision.');
  const revision = siteVersions(ctx).length + 1;
  const site: SiteVersion = {
    id: `${ctx.projectId}-site-r${revision}`,
    revision,
    geometry,
    calculatedAreaM2: geodeticAreaM2(geometry),
    confirmedAreaM2: confirmed === null ? null : Math.round(confirmed * 100) / 100,
    authority: {
      name,
      confirmed: Boolean(input.authority.confirmed),
      ...(input.authority.code?.trim() ? { code: input.authority.code.trim() } : {}),
      ...(input.authority.source?.trim() ? { source: input.authority.source.trim() } : {}),
    },
    boundarySource,
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'PLANNING_SITE_VERSION_RECORDED', entity: { refType: 'PlanningSiteVersion', refId: site.id }, nextState: site, reason: `Red line revision ${revision}: ${boundarySource}` });
  planningChanged(ctx);
  return { ...site, divergence: areaDivergence(site.calculatedAreaM2, site.confirmedAreaM2) };
}

/** A reviewer accepts a revision as the one fees and rules read. */
export function acceptSiteVersion(ctx: EngineContext, input: { siteVersionId: string; note: string }): SiteVersion {
  guard(ctx, 'U');
  const site = siteVersion(ctx, input.siteVersionId);
  const latest = siteVersions(ctx).at(-1)!;
  if (site.id !== latest.id) throw new DomainError('SITE_VERSION_SUPERSEDED', `Revision ${site.revision} has been superseded by revision ${latest.revision}.`, 409);
  if (site.accepted) throw new DomainError('SITE_VERSION_ACCEPTED', `Revision ${site.revision} is already accepted.`, 409);
  const note = text(input.note, 'note', 5, 'Say what the boundary was checked against.');
  const next: SiteVersion = { ...site, accepted: { by: ctx.auth.actorId, at: new Date().toISOString(), note } };
  write(ctx, { eventType: 'PLANNING_SITE_VERSION_ACCEPTED', entity: { refType: 'PlanningSiteVersion', refId: site.id }, nextState: next, reason: `Red line revision ${site.revision} accepted: ${note}` });
  planningChanged(ctx);
  return next;
}

// =============================================================================
// Facts about the site, each with its source
// =============================================================================

export type SiteFact = { key: SiteFactKey; value: string; source: string; note?: string; recordedBy: string; recordedAt: string };

export function siteFacts(ctx: EngineContext): Partial<Record<SiteFactKey, SiteFact>> {
  return Object.fromEntries(states<SiteFact>(ctx, 'PlanningSiteFact').map((fact) => [fact.key, fact]));
}

export function recordSiteFact(ctx: EngineContext, input: { key: string; value: string; source: string; note?: string }): SiteFact {
  guard(ctx, 'U');
  if (!(input.key in SITE_FACTS)) {
    throw new DomainError('SITE_FACT_UNKNOWN', `${input.key} is not a site fact the rules read.`, 422, [{ field: 'key', message: 'choose one' }]);
  }
  const key = input.key as SiteFactKey;
  const allowed = SITE_FACTS[key].values as readonly string[];
  if (!allowed.includes(input.value)) {
    throw new DomainError('SITE_FACT_VALUE', `${SITE_FACTS[key].label} is one of ${allowed.join(', ')}.`, 422, [{ field: 'value', message: 'choose one' }]);
  }
  const source = text(input.source, 'source', 3, 'Name the source — the map, survey, report or authority letter, with its date.');
  const fact: SiteFact = { key, value: input.value, source, ...(input.note?.trim() ? { note: input.note.trim() } : {}), recordedBy: ctx.auth.actorId, recordedAt: new Date().toISOString() };
  write(ctx, { eventType: 'PLANNING_SITE_FACT_RECORDED', entity: { refType: 'PlanningSiteFact', refId: `${ctx.projectId}-fact-${key}` }, nextState: fact, reason: `${SITE_FACTS[key].label}: ${input.value} (${source})` });
  planningChanged(ctx);
  return fact;
}

// =============================================================================
// Proposals and scenarios
// =============================================================================

export type Proposal = {
  id: string;
  scenarioName: string;
  version: number;
  siteVersionId: string;
  route: 'full' | 'outline';
  use: 'HOUSING' | 'MIXED' | 'OTHER';
  dwellings: number | null;
  createdGiaM2: number | null;
  assumptions: string[];
  recordedBy: string;
  recordedAt: string;
};

export function proposals(ctx: EngineContext): Proposal[] {
  return states<Proposal>(ctx, 'PlanningProposal');
}

function proposal(ctx: EngineContext, id: string): Proposal {
  const found = proposals(ctx).find((entry) => entry.id === id);
  if (!found) throw new DomainError('PROPOSAL_NOT_FOUND', 'No such proposal on this project.', 404);
  return found;
}

export function recordProposal(
  ctx: EngineContext,
  input: { siteVersionId: string; scenarioName: string; route: string; use: string; dwellingCount: number | null; createdGiaM2: number | null; assumptions?: string[] },
): Proposal {
  guard(ctx, 'C');
  siteVersion(ctx, input.siteVersionId);
  const scenarioName = text(input.scenarioName, 'scenarioName', 2, 'Name the scenario, e.g. "Outline, 40 homes".');
  if (input.route !== 'full' && input.route !== 'outline') {
    throw new DomainError('PROPOSAL_ROUTE', 'A first-release proposal is a full or an outline application.', 422, [{ field: 'route', message: 'full or outline' }]);
  }
  if (!['HOUSING', 'MIXED', 'OTHER'].includes(input.use)) throw new DomainError('PROPOSAL_USE', 'The use is housing, mixed or other.', 422, [{ field: 'use', message: 'choose one' }]);
  const dwellings = input.dwellingCount ?? null;
  if (dwellings !== null && (!Number.isInteger(dwellings) || dwellings < 1)) {
    throw new DomainError('PROPOSAL_DWELLINGS', 'The dwelling count is a positive whole number, or left unknown.', 422, [{ field: 'dwellingCount', message: 'whole number' }]);
  }
  const gia = input.createdGiaM2 ?? null;
  if (gia !== null && (!Number.isFinite(gia) || gia < 0)) {
    throw new DomainError('PROPOSAL_GIA', 'The created floorspace is square metres, or left unknown.', 422, [{ field: 'createdGiaM2', message: 'm²' }]);
  }
  const version = proposals(ctx).filter((entry) => entry.scenarioName === scenarioName).length + 1;
  const next: Proposal = {
    id: ulid(),
    scenarioName,
    version,
    siteVersionId: input.siteVersionId,
    route: input.route,
    use: input.use as Proposal['use'],
    dwellings,
    createdGiaM2: gia,
    assumptions: (input.assumptions ?? []).map((entry) => String(entry).trim()).filter(Boolean),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };
  write(ctx, { eventType: 'PLANNING_PROPOSAL_RECORDED', entity: { refType: 'PlanningProposal', refId: next.id }, nextState: next, reason: `${scenarioName} v${version}` });
  planningChanged(ctx);
  return next;
}

// =============================================================================
// Evaluation
// =============================================================================

export type EvaluationRecord = {
  id: string;
  proposalId: string;
  siteVersionId: string;
  ruleVersion: string;
  rulePackHash: string;
  rulePackPublished: boolean;
  inputs: RuleInput;
  major: 'MAJOR' | 'NOT_MAJOR' | 'UNRESOLVED';
  findings: Finding[];
  evaluatedBy: string;
  evaluatedAt: string;
};

function ruleInputFor(ctx: EngineContext, subject: Proposal): RuleInput {
  const site = siteVersion(ctx, subject.siteVersionId);
  const facts = Object.fromEntries(Object.values(siteFacts(ctx)).map((fact) => [fact!.key, fact!.value])) as RuleInput['facts'];
  return {
    use: subject.use,
    siteAreaM2: site.confirmedAreaM2 ?? site.calculatedAreaM2,
    areaBasis: site.confirmedAreaM2 !== null ? 'CONFIRMED' : 'CALCULATED',
    areaReviewReasons: areaDivergence(site.calculatedAreaM2, site.confirmedAreaM2).reasons,
    authorityConfirmed: site.authority.confirmed,
    dwellings: subject.dwellings,
    createdGiaM2: subject.createdGiaM2,
    facts,
  };
}

export function evaluateProposal(ctx: EngineContext, input: { proposalId: string }): EvaluationRecord {
  guard(ctx, 'C');
  const subject = proposal(ctx, input.proposalId);
  const inputs = ruleInputFor(ctx, subject);
  const result = evaluateRules(inputs);
  const pack = rulePacks().find((entry) => entry.version === RULE_PACK_VERSION)!;
  const record: EvaluationRecord = {
    id: ulid(),
    proposalId: subject.id,
    siteVersionId: subject.siteVersionId,
    ruleVersion: result.ruleVersion,
    rulePackHash: pack.hash,
    rulePackPublished: isPublished(ctx, pack),
    inputs,
    major: result.major,
    findings: result.findings,
    evaluatedBy: ctx.auth.actorId,
    evaluatedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'PLANNING_EVALUATION_RECORDED',
    entity: { refType: 'PlanningEvaluation', refId: record.id },
    nextState: record,
    reason: `${subject.scenarioName} v${subject.version} evaluated: ${result.findings.filter((finding) => finding.status === 'review_required').length} for review`,
  });
  planningChanged(ctx);
  return record;
}

/** Why an evaluation no longer describes the project, if it does not. */
export function evaluationStaleness(ctx: EngineContext, evaluation: EvaluationRecord): string[] {
  const reasons: string[] = [];
  const subject = proposals(ctx).find((entry) => entry.id === evaluation.proposalId);
  const latestSite = siteVersions(ctx).at(-1);
  if (latestSite && latestSite.id !== evaluation.siteVersionId) reasons.push(`The red line has a newer revision (${latestSite.revision}).`);
  if (subject) {
    const newer = proposals(ctx).filter((entry) => entry.scenarioName === subject.scenarioName && entry.version > subject.version);
    if (newer.length > 0) reasons.push(`${subject.scenarioName} has a newer version (v${newer.at(-1)!.version}).`);
    const now = ruleInputFor(ctx, subject);
    const changed = (Object.keys(SITE_FACTS) as SiteFactKey[]).filter((key) => (now.facts[key] ?? null) !== (evaluation.inputs.facts[key] ?? null));
    if (changed.length > 0) reasons.push(`Site facts changed since: ${changed.map((key) => SITE_FACTS[key].label).join(', ')}.`);
    if (now.siteAreaM2 !== evaluation.inputs.siteAreaM2) reasons.push('The site area it read has changed.');
  }
  const pack = rulePacks().find((entry) => entry.version === evaluation.ruleVersion);
  if (!pack || pack.hash !== evaluation.rulePackHash) reasons.push('The rule pack has changed since.');
  return reasons;
}

export function evaluations(ctx: EngineContext): EvaluationRecord[] {
  return states<EvaluationRecord>(ctx, 'PlanningEvaluation');
}

// =============================================================================
// Fee quotes: append-only snapshots
// =============================================================================

export type FeeQuoteRecord = FeeQuoteResult & {
  id: string;
  dateBasis: 'ASSUMED' | 'EVIDENCED';
  proposalId?: string;
  inputs: { dwellings: number | null; areaM2: number | null; reservedHistoryThresholdMet: boolean | null; nonStandard?: string };
  scheduleHash: string | null;
  quotedBy: string;
  quotedAt: string;
};

export function quoteFeeFor(
  ctx: EngineContext,
  input: {
    route: string;
    madeOn: string;
    dateBasis: string;
    proposalId?: string;
    dwellings?: number | null;
    reservedHistoryThresholdMet?: boolean | null;
    nonStandard?: string;
  },
): FeeQuoteRecord {
  guard(ctx, 'C');
  if (!(FEE_ROUTES as readonly string[]).includes(input.route)) {
    throw new DomainError('FEE_ROUTE', `The fee route is one of ${FEE_ROUTES.join(', ')}.`, 422, [{ field: 'route', message: 'choose one' }]);
  }
  if (input.dateBasis !== 'ASSUMED' && input.dateBasis !== 'EVIDENCED') {
    throw new DomainError('FEE_DATE_BASIS', 'Say whether the made date is assumed (planning ahead) or evidenced (filed).', 422, [{ field: 'dateBasis', message: 'ASSUMED or EVIDENCED' }]);
  }
  const subject = input.proposalId ? proposal(ctx, input.proposalId) : undefined;
  const site = subject ? siteVersion(ctx, subject.siteVersionId) : siteVersions(ctx).at(-1);
  const extraReasons: string[] = [];
  let areaM2: number | null = null;
  if (input.route === 'outline') {
    if (!site) extraReasons.push('No red line is recorded.');
    else if (!site.accepted) extraReasons.push(`Red line revision ${site.revision} has not been accepted, so its area is not used for a fee.`);
    else {
      areaM2 = site.confirmedAreaM2 ?? site.calculatedAreaM2;
      const divergence = areaDivergence(site.calculatedAreaM2, site.confirmedAreaM2);
      if (divergence.material) extraReasons.push(...divergence.reasons);
    }
  }
  const dwellings = input.dwellings !== undefined ? input.dwellings : (subject?.dwellings ?? null);
  const kernelInput = {
    route: input.route as FeeRoute,
    madeOn: input.madeOn,
    dwellings,
    areaM2,
    reservedHistoryThresholdMet: input.reservedHistoryThresholdMet ?? null,
    ...(input.nonStandard?.trim() ? { nonStandard: input.nonStandard.trim() } : {}),
  };
  let result: FeeQuoteResult;
  try {
    result = quoteFee(kernelInput, publishedFeeVersions(ctx));
  } catch (error) {
    if (error instanceof FeeInputError) throw new DomainError('FEE_INPUT_INVALID', error.message, 422, [{ field: error.field, message: error.message }]);
    throw error;
  }
  if (extraReasons.length > 0 && result.status === 'CALCULATED') {
    result = { ...result, status: 'REVIEW_REQUIRED', amountMinor: null, reviewReasons: extraReasons };
  } else if (extraReasons.length > 0) {
    result = { ...result, reviewReasons: [...extraReasons, ...result.reviewReasons] };
  }
  const schedule = FEE_SCHEDULES.find((entry) => entry.version === result.ruleVersion);
  const record: FeeQuoteRecord = {
    ...result,
    id: ulid(),
    dateBasis: input.dateBasis,
    ...(subject ? { proposalId: subject.id } : {}),
    inputs: { dwellings, areaM2, reservedHistoryThresholdMet: kernelInput.reservedHistoryThresholdMet, ...(kernelInput.nonStandard ? { nonStandard: kernelInput.nonStandard } : {}) },
    scheduleHash: schedule ? scheduleHash(schedule) : null,
    quotedBy: ctx.auth.actorId,
    quotedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'PLANNING_FEE_QUOTED',
    entity: { refType: 'PlanningFeeQuote', refId: record.id },
    nextState: record,
    reason: `${record.route} made ${record.madeOn} (${record.dateBasis.toLowerCase()}): ${record.amountMinor === null ? 'review required' : `£${(record.amountMinor / 100).toFixed(2)}`}`,
  });
  return record;
}

export function feeQuotes(ctx: EngineContext): FeeQuoteRecord[] {
  return states<FeeQuoteRecord>(ctx, 'PlanningFeeQuote');
}

// =============================================================================
// Costs
// =============================================================================

export const COST_KINDS = ['ALLOWANCE', 'STATUTORY_FEE', 'LIABILITY', 'IN_KIND_OBLIGATION'] as const;
export const VAT_BASES = ['EXCLUDED', 'INCLUDED', 'NOT_APPLICABLE', 'RECOVERABLE'] as const;
export const CONFIDENCES = ['LOW', 'MEDIUM', 'HIGH'] as const;
const GATES: readonly Gate[] = ['G0', 'G1', 'G2', 'G3', 'G4', 'G5'];

export type CostLine = {
  id: string;
  label: string;
  costCode: string;
  kind: (typeof COST_KINDS)[number];
  gate: Gate;
  phase?: string;
  source: string;
  /** Pence; null is unknown, never zero. */
  lowMinor: number | null;
  baseMinor: number | null;
  highMinor: number | null;
  vatBasis: (typeof VAT_BASES)[number];
  confidence: (typeof CONFIDENCES)[number];
  estimateDate: string;
  cashTrigger: string;
  feeQuoteId?: string;
  /** Committed (ordered) and paid to date, in pence, with the order or invoice they come from. */
  committedMinor?: number | null;
  actualMinor?: number | null;
  commitmentRef?: string;
  status: 'ACTIVE' | 'WITHDRAWN';
  withdrawnReason?: string;
  recordedBy: string;
  recordedAt: string;
};

type CostInput = Partial<Omit<CostLine, 'id' | 'status' | 'recordedBy' | 'recordedAt'>>;

function checkedCost(input: CostInput, previous?: CostLine): Omit<CostLine, 'id' | 'status' | 'recordedBy' | 'recordedAt'> {
  const merged = { ...previous, ...input };
  const label = text(merged.label, 'label', 2, 'Name the cost.');
  const source = text(merged.source, 'source', 2, 'Say where the figure comes from — a quote, a schedule, an allowance.');
  const costCode = text(merged.costCode, 'costCode', 1, 'Give the cost code.');
  const cashTrigger = text(merged.cashTrigger, 'cashTrigger', 2, 'Say what triggers the payment — appointment, submission, commencement.');
  if (!COST_KINDS.includes(merged.kind as never)) throw new DomainError('COST_KIND', `The kind is one of ${COST_KINDS.join(', ')}.`, 422, [{ field: 'kind', message: 'choose one' }]);
  if (!VAT_BASES.includes(merged.vatBasis as never)) throw new DomainError('COST_VAT', `The VAT basis is one of ${VAT_BASES.join(', ')}.`, 422, [{ field: 'vatBasis', message: 'choose one' }]);
  if (!CONFIDENCES.includes(merged.confidence as never)) throw new DomainError('COST_CONFIDENCE', 'The confidence is LOW, MEDIUM or HIGH.', 422, [{ field: 'confidence', message: 'choose one' }]);
  if (!GATES.includes(merged.gate as Gate)) throw new DomainError('COST_GATE', 'The gate is G0 to G5.', 422, [{ field: 'gate', message: 'choose one' }]);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(merged.estimateDate ?? ''))) throw new DomainError('COST_DATE', 'The estimate date is YYYY-MM-DD.', 422, [{ field: 'estimateDate', message: 'date' }]);
  const amount = (value: unknown, field: string): number | null => {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || (value as number) < 0) throw new DomainError('COST_AMOUNT', 'An amount is whole pence, not negative, or left unknown.', 422, [{ field, message: 'pence' }]);
    return value as number;
  };
  const committed = amount(merged.committedMinor, 'committedMinor');
  const actual = amount(merged.actualMinor, 'actualMinor');
  if ((committed !== null || actual !== null) && !merged.commitmentRef?.trim()) {
    throw new DomainError('COST_COMMITMENT_REF', 'A committed or actual figure names the order or invoice it comes from.', 422, [{ field: 'commitmentRef', message: 'order or invoice' }]);
  }
  const low = amount(merged.lowMinor, 'lowMinor');
  const baseAmount = amount(merged.baseMinor, 'baseMinor');
  const high = amount(merged.highMinor, 'highMinor');
  const known = [low, baseAmount, high].filter((value): value is number => value !== null);
  if (known.some((value, index) => index > 0 && value < known[index - 1]!)) {
    throw new DomainError('COST_ORDER', 'Low, base and high run from lowest to highest.', 422, [{ field: 'highMinor', message: 'low ≤ base ≤ high' }]);
  }
  return {
    label,
    costCode,
    kind: merged.kind as CostLine['kind'],
    gate: merged.gate as Gate,
    ...(merged.phase?.trim() ? { phase: merged.phase.trim() } : {}),
    source,
    lowMinor: low,
    baseMinor: baseAmount,
    highMinor: high,
    vatBasis: merged.vatBasis as CostLine['vatBasis'],
    confidence: merged.confidence as CostLine['confidence'],
    estimateDate: String(merged.estimateDate),
    cashTrigger,
    ...(merged.feeQuoteId ? { feeQuoteId: merged.feeQuoteId } : {}),
    ...(committed !== null ? { committedMinor: committed } : {}),
    ...(actual !== null ? { actualMinor: actual } : {}),
    ...(merged.commitmentRef?.trim() ? { commitmentRef: merged.commitmentRef.trim() } : {}),
  };
}

export function costLines(ctx: EngineContext): Array<CostLine & { version: number }> {
  return ctx.ledger.list(ctx.projectId, 'PlanningCostLine').map((record) => ({ ...(record.state as unknown as CostLine), version: record.version }));
}

export function recordCostLine(ctx: EngineContext, input: CostInput): CostLine {
  guard(ctx, 'C');
  let fields = input;
  if (input.feeQuoteId) {
    const quote = feeQuotes(ctx).find((entry) => entry.id === input.feeQuoteId);
    if (!quote) throw new DomainError('FEE_QUOTE_NOT_FOUND', 'No such fee quote on this project.', 404);
    if (quote.amountMinor === null) {
      throw new DomainError('FEE_QUOTE_NOT_CALCULATED', 'That quote needs review and has no payable figure, so it cannot become a cost line.', 409);
    }
    if (costLines(ctx).some((line) => line.status === 'ACTIVE' && line.feeQuoteId === quote.id)) {
      throw new DomainError('FEE_QUOTE_ALREADY_COSTED', 'That quote is already a cost line.', 409);
    }
    fields = {
      ...input,
      kind: 'STATUTORY_FEE',
      lowMinor: quote.amountMinor,
      baseMinor: quote.amountMinor,
      highMinor: quote.amountMinor,
      source: input.source ?? `Fee quote ${quote.ruleVersion}, made ${quote.madeOn} (${quote.dateBasis.toLowerCase()})`,
    };
  }
  const line: CostLine = { ...checkedCost(fields), id: ulid(), status: 'ACTIVE', recordedBy: ctx.auth.actorId, recordedAt: new Date().toISOString() };
  write(ctx, { eventType: 'PLANNING_COST_LINE_RECORDED', entity: { refType: 'PlanningCostLine', refId: line.id }, nextState: line, reason: `${line.label} (${line.kind.toLowerCase()})` });
  planningChanged(ctx);
  return line;
}

/** A revision of a line is a new version of it, under If-Match; withdrawing it says why. */
export function reviseCostLine(ctx: EngineContext, id: string, input: CostInput & { withdraw?: { reason: string } }): CostLine {
  guard(ctx, 'U');
  const existing = costLines(ctx).find((line) => line.id === id);
  if (!existing) throw new DomainError('COST_LINE_NOT_FOUND', 'No such cost line on this project.', 404);
  if (existing.status === 'WITHDRAWN') throw new DomainError('COST_LINE_WITHDRAWN', 'That line has been withdrawn.', 409);
  if (existing.feeQuoteId && ['lowMinor', 'baseMinor', 'highMinor', 'kind'].some((field) => field in input)) {
    throw new DomainError('COST_LINE_FROM_QUOTE', 'A statutory fee line carries its quote’s figure; quote again for a different one.', 409);
  }
  const { version: _version, ...previous } = existing;
  const next: CostLine = input.withdraw
    ? { ...previous, status: 'WITHDRAWN', withdrawnReason: text(input.withdraw.reason, 'withdraw.reason', 5, 'Say why the line is withdrawn.') }
    : { ...previous, ...checkedCost(input, previous) };
  write(ctx, { eventType: 'PLANNING_COST_LINE_REVISED', entity: { refType: 'PlanningCostLine', refId: id }, nextState: next, reason: input.withdraw ? `${next.label} withdrawn: ${next.withdrawnReason}` : `${next.label} revised` });
  planningChanged(ctx);
  return next;
}

/**
 * The specification's illustrative full-application allowances, as a starting
 * point a person chooses to take. Each is labelled as an allowance to replace
 * with a quote, low confidence, VAT excluded, no base figure — the source gives
 * a range, not a most-likely number, and none is invented here.
 */
export const ILLUSTRATIVE_ALLOWANCES = [
  { label: 'Planning and design', costCode: 'PL-01', lowMinor: 1_500_000, highMinor: 3_500_000, cashTrigger: 'Appointment and stage payments to submission' },
  { label: 'Technical surveys', costCode: 'PL-02', lowMinor: 1_200_000, highMinor: 3_000_000, cashTrigger: 'Commission, by survey window' },
  { label: 'Ecology and BNG design', costCode: 'PL-03', lowMinor: 500_000, highMinor: 2_000_000, cashTrigger: 'Commission, by survey window' },
  { label: 'Legal and pre-application', costCode: 'PL-04', lowMinor: 300_000, highMinor: 1_500_000, cashTrigger: 'Pre-application request and title work' },
] as const;

export function seedIllustrativeAllowances(ctx: EngineContext): CostLine[] {
  guard(ctx, 'C');
  if (costLines(ctx).some((line) => line.status === 'ACTIVE' && line.kind === 'ALLOWANCE')) {
    throw new DomainError('ALLOWANCES_EXIST', 'This project already has allowances; add or revise them one by one.', 409);
  }
  const today = new Date().toISOString().slice(0, 10);
  return ILLUSTRATIVE_ALLOWANCES.map((allowance) =>
    recordCostLine(ctx, {
      ...allowance,
      kind: 'ALLOWANCE',
      gate: 'G1',
      source: 'Illustrative allowance from the CONSTRUX Planning specification — scenario assumption, replace with a quote',
      baseMinor: null,
      vatBasis: 'EXCLUDED',
      confidence: 'LOW',
      estimateDate: today,
    }),
  );
}

export type CostSummary = {
  /** Cash lines (allowances and statutory fees) whose figures are known. */
  known: { lines: number; lowMinor: number; highMinor: number; baseMinor: number | null; baseMissing: number };
  unknownCashLines: Array<{ id: string; label: string }>;
  /**
   * Forecast outturn on the cash lines: actuals, plus what is committed and not
   * yet paid, plus the base forecast on lines with nothing committed. Lines
   * with no base and nothing committed cannot be forecast and are counted.
   */
  outturn: { minor: number; actualMinor: number; committedMinor: number; uncommittedMinor: number; unforecast: number };
  /** Liabilities and in-kind obligations, never added into the cash forecast. */
  liabilities: Array<{ id: string; label: string; kind: string; lowMinor: number | null; highMinor: number | null }>;
  /** Liabilities known to exist but not yet quantified anywhere. */
  unresolved: string[];
  excludes: string[];
};

export function costSummary(ctx: EngineContext): CostSummary {
  const active = costLines(ctx).filter((line) => line.status === 'ACTIVE');
  const cash = active.filter((line) => line.kind === 'ALLOWANCE' || line.kind === 'STATUTORY_FEE');
  const knownCash = cash.filter((line) => line.lowMinor !== null && line.highMinor !== null);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const baseMissing = knownCash.filter((line) => line.baseMinor === null).length;
  const latest = evaluations(ctx).at(-1);
  const cil = latest?.findings.find((finding) => finding.code === 'CIL');
  const unresolved: string[] = [];
  if (!latest || cil?.status === 'unavailable') unresolved.push('CIL: liability unknown — no charging schedule evidence.');
  else if (cil?.status === 'review_required' && !active.some((line) => /CIL/i.test(line.label))) unresolved.push('CIL: a charging schedule is in force and no CIL line is recorded.');
  if (!active.some((line) => /106/.test(line.label))) unresolved.push('Section 106: no heads of terms recorded.');
  return {
    known: {
      lines: knownCash.length,
      lowMinor: sum(knownCash.map((line) => line.lowMinor!)),
      highMinor: sum(knownCash.map((line) => line.highMinor!)),
      baseMinor: baseMissing === 0 ? sum(knownCash.map((line) => line.baseMinor!)) : null,
      baseMissing,
    },
    unknownCashLines: cash.filter((line) => line.lowMinor === null || line.highMinor === null).map((line) => ({ id: line.id, label: line.label })),
    outturn: (() => {
      const actualMinor = sum(cash.map((line) => line.actualMinor ?? 0));
      const committedMinor = sum(cash.map((line) => Math.max((line.committedMinor ?? 0) - (line.actualMinor ?? 0), 0)));
      const uncommitted = cash.filter((line) => line.committedMinor === undefined || line.committedMinor === null);
      const forecastable = uncommitted.filter((line) => line.baseMinor !== null);
      // Paid against a line with nothing committed is already in actuals; the base is what remains.
      const uncommittedMinor = sum(forecastable.map((line) => Math.max(line.baseMinor! - (line.actualMinor ?? 0), 0)));
      return { minor: actualMinor + committedMinor + uncommittedMinor, actualMinor, committedMinor, uncommittedMinor, unforecast: uncommitted.length - forecastable.length };
    })(),
    liabilities: active
      .filter((line) => line.kind === 'LIABILITY' || line.kind === 'IN_KIND_OBLIGATION')
      .map((line) => ({ id: line.id, label: line.label, kind: line.kind, lowMinor: line.lowMinor, highMinor: line.highMinor })),
    unresolved,
    excludes: ['VAT where excluded on a line', 'contingency', 'section 106 and CIL unless recorded', 'BNG delivery', 'post-consent fees', 'the works'],
  };
}

// =============================================================================
// The overview
// =============================================================================

export type PlanningOverview = {
  site?: SiteVersion & { divergence: ReturnType<typeof areaDivergence> };
  siteRevisions: number;
  facts: Partial<Record<SiteFactKey, SiteFact>>;
  scenarios: Array<{ proposal: Proposal; evaluation?: EvaluationRecord; stale: string[] }>;
  blockers: Array<Finding & { scenario: string }>;
  quotes: FeeQuoteRecord[];
  costs: CostSummary;
  lines: Array<CostLine & { version: number }>;
  rules: RuleVersionPosition[];
  /** The closed lists the forms offer, published here so the browser holds no copy of its own. */
  vocabulary: {
    facts: typeof SITE_FACTS;
    feeRoutes: readonly string[];
    costKinds: readonly string[];
    vatBases: readonly string[];
    confidences: readonly string[];
    gates: readonly Gate[];
  };
};

export function planningOverview(ctx: EngineContext): PlanningOverview {
  guard(ctx, 'R');
  const sites = siteVersions(ctx);
  const site = sites.at(-1);
  const all = proposals(ctx);
  const latestPerScenario = [...new Map(all.map((entry) => [entry.scenarioName, entry])).values()].filter(
    (entry) => !all.some((other) => other.scenarioName === entry.scenarioName && other.version > entry.version),
  );
  const evaluated = evaluations(ctx);
  const scenarios = latestPerScenario.map((entry) => {
    const evaluation = evaluated.filter((candidate) => candidate.proposalId === entry.id).at(-1);
    return { proposal: entry, ...(evaluation ? { evaluation } : {}), stale: evaluation ? evaluationStaleness(ctx, evaluation) : [] };
  });
  const blockers = scenarios.flatMap(({ proposal: subject, evaluation }) =>
    (evaluation?.findings ?? []).filter((finding) => finding.status === 'review_required').map((finding) => ({ ...finding, scenario: subject.scenarioName })),
  );
  return {
    ...(site ? { site: { ...site, divergence: areaDivergence(site.calculatedAreaM2, site.confirmedAreaM2) } } : {}),
    siteRevisions: sites.length,
    facts: siteFacts(ctx),
    scenarios,
    blockers,
    quotes: feeQuotes(ctx).slice(-20).reverse(),
    costs: costSummary(ctx),
    lines: costLines(ctx),
    rules: ruleVersions(ctx),
    vocabulary: { facts: SITE_FACTS, feeRoutes: FEE_ROUTES, costKinds: COST_KINDS, vatBases: VAT_BASES, confidences: CONFIDENCES, gates: GATES },
  };
}
