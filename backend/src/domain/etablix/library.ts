import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { appointmentInForce } from './appointment.ts';
import { SERVICE_FAMILIES, type ServiceFamily } from './brief.ts';
import type { ServiceSystem } from './composer.ts';
import type { ServiceDelivery } from './desk.ts';
import {
  CONTROL_STATES,
  normaliseBids,
  scheduleFor,
  type ControlStateId,
  type ServicePackage,
  type SupplierEngagement,
} from './procurement.ts';

/**
 * §6 stage 8 — the ETABLIX knowledge library.
 *
 * The module's stated advantage is that each project improves the next brief,
 * tender and operating baseline without exposing one customer's data to
 * another. Until this file existed that was a claim: §7 normalised bids inside
 * a project and nothing carried the result forward, no supplier's performance
 * was written back from the engagement that produced it, and the seven stated
 * fields of a package that had actually gone to market were typed again on the
 * next job.
 *
 * Three records, all held on the tenancy's governance project — the same place
 * the supply-chain register, the frameworks and the company profile live —
 * because they are the company's knowledge and not any one project's.
 *
 * **A supplier score** is written back from an engagement that reached
 * Contracted or was suspended: how many times the firm got to contract, how
 * many times to operation, how many suspensions, and what the gate found when
 * its lorries arrived. The score is arithmetic over those counts, published
 * beside them, and a firm that never reached contract has no performance to
 * score.
 *
 * **A price benchmark** is promoted out of a normalisation, per family and
 * per schedule item: the median compliant rate of a fully locked field, and
 * nothing else — no bidder, no project, no customer. Two promotions of the
 * same item are two samples, and the band is read across them.
 *
 * **A package template** is the seven stated fields of a package that went to
 * tender, checked word by word against the names on the appointment and on
 * the project. A field that names the customer is withheld and the withholding
 * is on the record; nothing is silently rewritten.
 *
 * **Sanitisation is a check, not a promise.** Every promotion records what it
 * was checked against. A record in the library carries no project id, no
 * contracting entity and no funding source by construction, and the test
 * proves it by searching the promoted records for them.
 */

export type LibrarySupplierScore = {
  id: string;
  tenantId: string;
  supplierId: string;
  supplierName: string;
  /** Engagements promoted into this score, across every project. */
  engagements: number;
  contracted: number;
  operational: number;
  suspensions: number;
  deliveries: { checked: number; short: number; refused: number };
  /** 0–100, from the counts above and nothing else. */
  score: number;
  basis: string;
  promotedAt: string;
  promotedBy: string;
};

export type LibraryBenchmark = {
  id: string;
  tenantId: string;
  family: ServiceFamily;
  familyLabel: string;
  /** The derivation on the design basis this item prices — `wcs`, `beds`, `kva`. */
  itemId: string;
  description: string;
  unit: string;
  /** One median compliant rate per promoted package, in minor units. */
  rates: number[];
  packages: number;
  /** Compliant returns behind every rate, summed. */
  returns: number;
  lowMinor: number;
  medianMinor: number;
  highMinor: number;
  promotedAt: string;
};

export type LibraryPackageTemplate = {
  id: string;
  tenantId: string;
  families: ServiceFamily[];
  label: string;
  /** The stated fields that passed the check, latest promotion winning per field. */
  stated: Record<string, string>;
  /** Fields the last promotion withheld because they named the customer. */
  withheldFields: string[];
  uses: number;
  promotedAt: string;
  promotedBy: string;
};

export type KnowledgePromotion = {
  id: string;
  projectId: string;
  promotedAt: string;
  promotedBy: string;
  note?: string;
  suppliers: { engagementId: string; supplierId: string; supplierName: string; score: number }[];
  benchmarks: { packageId: string; reference: string; items: number }[];
  templates: { packageId: string; templateId: string; withheldFields: string[] }[];
  withheld: { what: string; why: string }[];
  /** The names every promoted field was searched for. */
  checkedAgainst: string[];
};

const STATE_ORDER = new Map(CONTROL_STATES.map((state) => [state.id, state.order]));
const CONTRACTED_ORDER = STATE_ORDER.get('CONTRACTED')!;
const OPERATIONAL_ORDER = STATE_ORDER.get('OPERATIONAL')!;

function libraryProject(ctx: EngineContext): string {
  return `${ctx.tenantId}-governance`;
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function systemsOf(ctx: EngineContext): ServiceSystem[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceSystem').map((record) => record.state as unknown as ServiceSystem);
}

function packagesOf(ctx: EngineContext): ServicePackage[] {
  return ctx.ledger.list(ctx.projectId, 'ServicePackage').map((record) => record.state as unknown as ServicePackage);
}

function engagementsOf(ctx: EngineContext): SupplierEngagement[] {
  return ctx.ledger.list(ctx.projectId, 'SupplierEngagement').map((record) => record.state as unknown as SupplierEngagement);
}

function deliveriesOf(ctx: EngineContext): ServiceDelivery[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceDelivery').map((record) => record.state as unknown as ServiceDelivery);
}

export function promotionsOf(ctx: EngineContext): KnowledgePromotion[] {
  return ctx.ledger.list(ctx.projectId, 'KnowledgePromotion').map((record) => record.state as unknown as KnowledgePromotion);
}

function supplierScores(ctx: EngineContext): LibrarySupplierScore[] {
  return ctx.ledger.list(libraryProject(ctx), 'LibrarySupplierScore').map((record) => record.state as unknown as LibrarySupplierScore);
}

function benchmarks(ctx: EngineContext): LibraryBenchmark[] {
  return ctx.ledger.list(libraryProject(ctx), 'LibraryBenchmark').map((record) => record.state as unknown as LibraryBenchmark);
}

function templates(ctx: EngineContext): LibraryPackageTemplate[] {
  return ctx.ledger.list(libraryProject(ctx), 'LibraryPackageTemplate').map((record) => record.state as unknown as LibraryPackageTemplate);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** The score, from the counts and nothing else. Published beside them. */
function scoreOf(counts: Pick<LibrarySupplierScore, 'suspensions' | 'deliveries'>): { score: number; basis: string } {
  const deductions = counts.suspensions * 25 + counts.deliveries.refused * 10 + counts.deliveries.short * 5;
  return {
    score: Math.max(0, 100 - deductions),
    basis: `100, less 25 per suspension (${counts.suspensions}), 10 per delivery refused at the gate (${counts.deliveries.refused}) and 5 per delivery checked in short (${counts.deliveries.short}).`,
  };
}

/** The names a promoted field is searched for. The customer's, never the firm's own. */
function forbiddenNames(ctx: EngineContext): string[] {
  const appointment = appointmentInForce(ctx);
  const project = ctx.ledger.listByTenant(ctx.tenantId, 'Project').find((record) => String(record.state.id ?? record.refId) === ctx.projectId);
  return [String(project?.state.name ?? ''), appointment?.contractingEntity ?? '', appointment?.fundingSource ?? '']
    .map((name) => name.trim())
    .filter((name) => name.length >= 3);
}

function mentions(value: string, names: string[]): string | undefined {
  const haystack = normaliseName(value);
  return names.find((name) => haystack.includes(normaliseName(name)));
}

function reached(engagement: SupplierEngagement, order: number): boolean {
  return engagement.history.some((entry) => entry.state !== 'SUSPENDED_RECOVERY' && (STATE_ORDER.get(entry.state) ?? -1) >= order);
}

// --- Promotion ------------------------------------------------------------------------

export type PromotionResult = {
  promotion: KnowledgePromotion;
  suppliers: LibrarySupplierScore[];
  benchmarks: LibraryBenchmark[];
  templates: LibraryPackageTemplate[];
};

/**
 * Promote what this project has learned into the library.
 *
 * Idempotent per record: an engagement, a package's prices and a package's
 * template each go up once, and a second promotion carries only what is new.
 * Refused, with the reason, when there is nothing new to carry.
 */
export function promoteKnowledge(ctx: EngineContext, input: { note?: string } = {}): PromotionResult {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });
  if (!appointmentInForce(ctx)) {
    throw new DomainError('SITE_SERVICES_NOT_APPOINTED', 'Nothing is appointed on this project, so there is nothing it can have learned as ETABLIX');
  }

  const earlier = promotionsOf(ctx);
  const promotedEngagements = new Set(earlier.flatMap((entry) => entry.suppliers.map((supplier) => supplier.engagementId)));
  const promotedSuppliers = new Set(earlier.flatMap((entry) => entry.suppliers.map((supplier) => supplier.supplierId)));
  const promotedBenchmarks = new Set(earlier.flatMap((entry) => entry.benchmarks.map((benchmark) => benchmark.packageId)));
  const promotedTemplates = new Set(earlier.flatMap((entry) => entry.templates.map((template) => template.packageId)));

  const withheld: KnowledgePromotion['withheld'] = [];
  const names = forbiddenNames(ctx);
  const at = new Date().toISOString();
  const by = ctx.auth.actorId;
  const target = libraryProject(ctx);

  // --- Supplier scores
  const engagements = engagementsOf(ctx).filter((entry) => !promotedEngagements.has(entry.id));
  const scorable = engagements.filter((entry) => reached(entry, CONTRACTED_ORDER) || entry.history.some((step) => step.state === 'SUSPENDED_RECOVERY'));
  for (const entry of engagements.filter((candidate) => !scorable.includes(candidate))) {
    withheld.push({ what: `${entry.supplierName} on ${entry.packageId}`, why: 'The engagement never reached Contracted and was never suspended; a firm that did not get to contract has no performance to score.' });
  }
  const deliveries = deliveriesOf(ctx);
  const scored: LibrarySupplierScore[] = [];
  const supplierEntries: KnowledgePromotion['suppliers'] = [];
  for (const engagement of scorable) {
    const existing = supplierScores(ctx).find((entry) => entry.supplierId === engagement.supplierId);
    // Deliveries are the project's, not the engagement's: counted the first
    // time a supplier is promoted from this project, never again for a second
    // package on the same job.
    const countDeliveries = !promotedSuppliers.has(engagement.supplierId) && !supplierEntries.some((entry) => entry.supplierId === engagement.supplierId);
    const own = countDeliveries
      ? deliveries.filter((entry) => entry.status !== 'EXPECTED' && normaliseName(entry.supplier) === normaliseName(engagement.supplierName))
      : [];
    const counts = {
      engagements: (existing?.engagements ?? 0) + 1,
      contracted: (existing?.contracted ?? 0) + (reached(engagement, CONTRACTED_ORDER) ? 1 : 0),
      operational: (existing?.operational ?? 0) + (reached(engagement, OPERATIONAL_ORDER) ? 1 : 0),
      suspensions: (existing?.suspensions ?? 0) + engagement.history.filter((step) => step.state === 'SUSPENDED_RECOVERY').length,
      deliveries: {
        checked: (existing?.deliveries.checked ?? 0) + own.length,
        short: (existing?.deliveries.short ?? 0) + own.filter((entry) => entry.status === 'SHORT').length,
        refused: (existing?.deliveries.refused ?? 0) + own.filter((entry) => entry.status === 'REFUSED').length,
      },
    };
    const record: LibrarySupplierScore = {
      id: existing?.id ?? `${ctx.tenantId}-library-supplier-${engagement.supplierId}`,
      tenantId: ctx.tenantId,
      supplierId: engagement.supplierId,
      supplierName: engagement.supplierName,
      ...counts,
      ...scoreOf(counts),
      promotedAt: at,
      promotedBy: by,
    };
    write(ctx, {
      projectId: target,
      eventType: 'LIBRARY_SUPPLIER_SCORED',
      entity: { refType: 'LibrarySupplierScore', refId: record.id },
      nextState: record,
    });
    scored.push(record);
    supplierEntries.push({ engagementId: engagement.id, supplierId: engagement.supplierId, supplierName: engagement.supplierName, score: record.score });
  }

  // --- Benchmarks and templates, from packages that went to market
  const systems = systemsOf(ctx);
  const tendered = packagesOf(ctx).filter((entry) => entry.tenderedAt);
  const promotedBenchmarkRecords: LibraryBenchmark[] = [];
  const benchmarkEntries: KnowledgePromotion['benchmarks'] = [];
  const templateRecords: LibraryPackageTemplate[] = [];
  const templateEntries: KnowledgePromotion['templates'] = [];

  for (const record of tendered) {
    if (!promotedBenchmarks.has(record.id)) {
      const result = normaliseBids(ctx, record.id);
      if (result.received < 2) {
        withheld.push({ what: `Prices on ${record.reference}`, why: `${result.received === 0 ? 'No return' : 'One return'} is not a market; a benchmark needs at least two compliant returns.` });
      } else if (result.locked < result.received) {
        withheld.push({ what: `Prices on ${record.reference}`, why: `${result.received - result.locked} of ${result.received} returns are not locked, and a price that can still change is not a benchmark.` });
      } else {
        const schedule = scheduleFor(ctx, record);
        let items = 0;
        for (const entry of result.medians.filter((candidate) => candidate.compliantBids >= 2)) {
          const item = schedule.find((candidate) => candidate.itemId === entry.itemId);
          const [systemId, derivationId] = entry.itemId.split(':', 2);
          const system = systems.find((candidate) => candidate.id === systemId);
          if (!item || !system || !derivationId) continue;
          const existing = benchmarks(ctx).find((candidate) => candidate.family === system.family && candidate.itemId === derivationId);
          const rates = [...(existing?.rates ?? []), entry.medianRateMinor];
          const sorted = [...rates].sort((a, b) => a - b);
          const benchmark: LibraryBenchmark = {
            id: existing?.id ?? `${ctx.tenantId}-library-benchmark-${system.family}-${derivationId}`,
            tenantId: ctx.tenantId,
            family: system.family,
            familyLabel: SERVICE_FAMILIES[system.family].label,
            itemId: derivationId,
            // The design-basis label, never the system's own label: "Welfare
            // and accommodation — WCs" says nothing about whose compound.
            description: item.description.split(' — ').slice(1).join(' — ') || item.description,
            unit: item.unit,
            rates,
            packages: (existing?.packages ?? 0) + 1,
            returns: (existing?.returns ?? 0) + entry.compliantBids,
            lowMinor: sorted[0]!,
            medianMinor: median(rates),
            highMinor: sorted[sorted.length - 1]!,
            promotedAt: at,
          };
          write(ctx, {
            projectId: target,
            eventType: 'LIBRARY_BENCHMARK_PROMOTED',
            entity: { refType: 'LibraryBenchmark', refId: benchmark.id },
            nextState: benchmark,
          });
          promotedBenchmarkRecords.push(benchmark);
          items += 1;
        }
        if (items > 0) benchmarkEntries.push({ packageId: record.id, reference: record.reference, items });
        else withheld.push({ what: `Prices on ${record.reference}`, why: 'No schedule item was priced by two compliant returns.' });
      }
    }

    if (!promotedTemplates.has(record.id)) {
      const stated: Record<string, string> = {};
      const withheldFields: string[] = [];
      for (const [field, value] of Object.entries(record.stated)) {
        const named = mentions(value, names);
        if (named) withheldFields.push(field);
        else stated[field] = value;
      }
      if (Object.keys(stated).length === 0) {
        withheld.push({ what: `Template from ${record.reference}`, why: 'Every stated field named the customer, and a template that names the customer is the customer’s data.' });
      } else {
        const families = [...record.families].sort();
        const existing = templates(ctx).find((candidate) => candidate.families.join('+') === families.join('+'));
        const template: LibraryPackageTemplate = {
          id: existing?.id ?? `${ctx.tenantId}-library-template-${families.join('+')}`,
          tenantId: ctx.tenantId,
          families,
          label: families.map((family) => SERVICE_FAMILIES[family].label).join(' and '),
          stated: { ...(existing?.stated ?? {}), ...stated },
          withheldFields,
          uses: (existing?.uses ?? 0) + 1,
          promotedAt: at,
          promotedBy: by,
        };
        write(ctx, {
          projectId: target,
          eventType: 'LIBRARY_TEMPLATE_PROMOTED',
          entity: { refType: 'LibraryPackageTemplate', refId: template.id },
          nextState: template,
        });
        templateRecords.push(template);
        templateEntries.push({ packageId: record.id, templateId: template.id, withheldFields });
      }
    }
  }

  if (supplierEntries.length === 0 && benchmarkEntries.length === 0 && templateEntries.length === 0) {
    throw new DomainError(
      'NOTHING_TO_PROMOTE',
      withheld.length > 0
        ? `Nothing new reached the library. ${withheld.map((entry) => `${entry.what}: ${entry.why}`).join(' ')}`
        : earlier.length > 0
          ? 'Everything this project has learned is already in the library.'
          : 'No engagement has reached Contracted and no package has gone to market, so there is nothing to promote yet.',
      409,
    );
  }

  const promotion: KnowledgePromotion = {
    id: ulid(),
    projectId: ctx.projectId,
    promotedAt: at,
    promotedBy: by,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    suppliers: supplierEntries,
    benchmarks: benchmarkEntries,
    templates: templateEntries,
    withheld,
    checkedAgainst: names,
  };
  write(ctx, {
    eventType: 'KNOWLEDGE_PROMOTED',
    entity: { refType: 'KnowledgePromotion', refId: promotion.id },
    nextState: promotion,
  });

  return { promotion, suppliers: scored, benchmarks: promotedBenchmarkRecords, templates: templateRecords };
}

// --- Reading the library --------------------------------------------------------------

export type LibraryPosition = {
  suppliers: LibrarySupplierScore[];
  /** Absent, with the reason, for a reader without commercial standing. */
  benchmarks?: LibraryBenchmark[];
  benchmarksWithheld?: string;
  templates: LibraryPackageTemplate[];
  /** This project's own promotions, oldest first. */
  promotions: KnowledgePromotion[];
  /** What the library says about this project's own market and firms. */
  applied: {
    packages: {
      packageId: string;
      reference: string;
      items: { itemId: string; description: string; unit: string; fieldMedianMinor: number; libraryMedianMinor: number; samples: number; variancePercent: number }[];
    }[];
    suppliers: { engagementId: string; supplierName: string; state: ControlStateId; score?: number; engagements?: number }[];
  };
  statement: string;
};

export function libraryPosition(ctx: EngineContext): LibraryPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  let commercial = true;
  let benchmarksWithheld: string | undefined;
  try {
    authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  } catch (error) {
    commercial = false;
    benchmarksWithheld = `Withheld: a benchmark is a price, and this session does not hold commercial standing${error instanceof Error && error.message ? ` (${error.message})` : ''}.`;
  }

  const suppliers = supplierScores(ctx).sort((a, b) => b.score - a.score || a.supplierName.localeCompare(b.supplierName));
  const held = benchmarks(ctx);
  const known = templates(ctx);
  const own = promotionsOf(ctx);

  const systems = systemsOf(ctx);
  const applied: LibraryPosition['applied'] = { packages: [], suppliers: [] };
  if (commercial && held.length > 0) {
    for (const record of packagesOf(ctx).filter((entry) => entry.tenderedAt)) {
      const result = normaliseBids(ctx, record.id);
      if (result.received === 0) continue;
      const schedule = scheduleFor(ctx, record);
      const items: LibraryPosition['applied']['packages'][number]['items'] = [];
      for (const entry of result.medians.filter((candidate) => candidate.compliantBids > 0)) {
        const [systemId, derivationId] = entry.itemId.split(':', 2);
        const system = systems.find((candidate) => candidate.id === systemId);
        const item = schedule.find((candidate) => candidate.itemId === entry.itemId);
        const benchmark = held.find((candidate) => system && candidate.family === system.family && candidate.itemId === derivationId);
        if (!benchmark || !item) continue;
        items.push({
          itemId: entry.itemId,
          description: item.description,
          unit: item.unit,
          fieldMedianMinor: entry.medianRateMinor,
          libraryMedianMinor: benchmark.medianMinor,
          samples: benchmark.packages,
          variancePercent: benchmark.medianMinor === 0 ? 0 : Math.round(((entry.medianRateMinor - benchmark.medianMinor) / benchmark.medianMinor) * 100),
        });
      }
      if (items.length > 0) applied.packages.push({ packageId: record.id, reference: record.reference, items });
    }
  }
  for (const engagement of engagementsOf(ctx)) {
    const score = suppliers.find((entry) => entry.supplierId === engagement.supplierId);
    applied.suppliers.push({
      engagementId: engagement.id,
      supplierName: engagement.supplierName,
      state: engagement.state,
      ...(score ? { score: score.score, engagements: score.engagements } : {}),
    });
  }

  const parts = [
    `${suppliers.length} supplier${suppliers.length === 1 ? '' : 's'} scored`,
    commercial ? `${held.length} price benchmark${held.length === 1 ? '' : 's'}` : 'benchmarks withheld',
    `${known.length} package template${known.length === 1 ? '' : 's'}`,
  ];
  const statement =
    suppliers.length + held.length + known.length === 0
      ? 'The library is empty. It fills from projects that promote what they learned, and nothing has yet.'
      : `${parts.join(', ')} in the library.${own.length > 0 ? ` This project has promoted ${own.length} time${own.length === 1 ? '' : 's'}.` : ' This project has promoted nothing yet.'}${
          applied.packages.length > 0 ? ` ${applied.packages.length} package${applied.packages.length === 1 ? '' : 's'} here can be read against the benchmark.` : ''
        }`;

  return {
    suppliers,
    ...(commercial ? { benchmarks: held.sort((a, b) => a.familyLabel.localeCompare(b.familyLabel) || a.description.localeCompare(b.description)) } : { benchmarksWithheld }),
    templates: known,
    promotions: own.sort((a, b) => a.promotedAt.localeCompare(b.promotedAt)),
    applied,
    statement,
  };
}
