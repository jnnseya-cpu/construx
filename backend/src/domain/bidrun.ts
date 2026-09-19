import { DomainError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { ingestedFiles } from '../evidence/pipeline.ts';
import * as perception from '../engines/perception.ts';
import * as tender from '../engines/tender.ts';
import { confidenceFor, harvestRates, rateKey, type Confidence } from './costintel.ts';
import { priceEstimate, type CostModelInput, type MeasuredLine } from '../engines/maths/costModel.ts';
import { quoteFromEstimate, type QuotationInput } from './quotation.ts';
import type { AuthContext } from '../identity/auth.ts';
import type { Platform } from '../platform.ts';

/**
 * From a pack of drawings to a price, in one run.
 *
 * Every piece of this existed and a person had to carry the work between them:
 * press a button per drawing, confirm each reading, retype the package name,
 * type a rate against every measured line, type the preliminaries, the waste,
 * the insurance, the overhead and the profit, then open the quotation. Four
 * screens and perhaps forty fields for a £20,000 wall repair. Stated plainly by
 * the person paying for it: nobody will use a construction OS that way, and
 * they are right — a platform that can read a drawing and then asks you to type
 * what it read has automated the easy half.
 *
 * So this is the run. Upload the pack, and the platform:
 *
 *   1. finds every file its classifier calls a drawing,
 *   2. reads each one and measures what is dimensioned on it,
 *   3. proposes a rate for every measured line **from this business's own
 *      committed estimates**, with the confidence and the age of the evidence
 *      behind it,
 *   4. proposes the site-wide heads and the margin from this business's own
 *      last complete estimate,
 *   5. prices the whole thing and shows what it comes to.
 *
 * ## What it will not do
 *
 * **It does not commit anything.** A proposal writes the readings — they are
 * evidence and belong on the record either way — and nothing else. No bill, no
 * estimate, no quotation exists until a person accepts, which is one decision
 * on one screen instead of forty fields across four.
 *
 * That is not timidity about automation. Every quantity here came out of a
 * model and every rate came out of history, and both are wrong sometimes. The
 * platform's whole claim is that a number can be traced to where it came from
 * and that somebody took responsibility for it. An automatic quotation to a
 * customer, priced at rates nobody looked at, is the one thing that would make
 * that claim false.
 *
 * **It invents no rate.** A line the record has never priced comes back
 * unpriced and says so. A median of one observation is reported as one
 * observation. Filling a gap with a plausible number is how an estimate becomes
 * confident and wrong, which is worse than incomplete and honest.
 */

export type ProposedRate = {
  allInMinor: number;
  labourRateMinor: number;
  materialRateMinor: number;
  plantRateMinor: number;
  subcontractRateMinor: number;
  confidence: Confidence;
  observations: number;
  projects: number;
  newestOn: string;
  /** In the words an estimator would check it in. */
  basis: string;
};

export type ProposedLine = {
  /** Which reading it came from, so accepting can confirm the right draft. */
  draftId: string;
  index: number;
  description: string;
  unit: string;
  quantity: number;
  sourceSheet: string | null;
  measurementRule: string;
  rate: ProposedRate | null;
  /** Named where no rate could be proposed. */
  unpriced?: string;
};

export type PackProposal = {
  packageId: string;
  /** Each drawing the run read, and what it found. */
  read: Array<{ hash: string; filename: string; draftId: string; items: number; confidence: number | null }>;
  /** Each file it could not read, and why — never silently skipped. */
  unread: Array<{ hash: string; filename: string; reason: string }>;
  lines: ProposedLine[];
  /** What this business's last complete estimate priced these heads at. */
  basis: {
    from: string;
    durationWeeks: number | null;
    timeRelated: CostModelInput['timeRelated'];
    quantified: CostModelInput['quantified'];
    insurance: CostModelInput['insurance'];
    margin: CostModelInput['margin'] | null;
    exclusions: CostModelInput['exclusions'];
  } | null;
  /** What it comes to on the proposed rates and basis, priced but not recorded. */
  indicative: {
    totalMinor: number;
    netMeasuredMinor: number;
    omissions: string[];
    warnings: string[];
  } | null;
  /** Everything a person still has to decide. Empty means the run answered it all. */
  outstanding: string[];
  acuConsumed: number;
};

/** The rates this business has actually committed, grouped by item and unit. */
function proposedRates(ctx: EngineContext): Map<string, ProposedRate> {
  const observations = harvestRates(ctx);
  const grouped = new Map<string, ReturnType<typeof harvestRates>>();
  for (const observation of observations) {
    const bucket = grouped.get(observation.key) ?? [];
    bucket.push(observation);
    grouped.set(observation.key, bucket);
  }

  const middle = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const at = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[at - 1]! + sorted[at]!) / 2) : sorted[at]!;
  };

  const rates = new Map<string, ProposedRate>();
  for (const [key, bucket] of grouped) {
    // Each component takes its own median rather than apportioning the all-in
    // one. A line historically bought as a subcontract package and a line
    // built with own labour are different shapes of the same money, and the
    // difference decides which cost head it lands on and whether inflation
    // touches it.
    const confidence = confidenceFor(bucket.length);
    const newestOn = bucket.map((o) => o.observedOn).filter((d) => d !== 'unknown').sort().at(-1) ?? 'unknown';
    const projects = new Set(bucket.map((o) => o.projectId)).size;
    rates.set(key, {
      allInMinor: middle(bucket.map((o) => o.rateMinor)),
      labourRateMinor: middle(bucket.map((o) => o.components.labourMinor)),
      materialRateMinor: middle(bucket.map((o) => o.components.materialMinor)),
      plantRateMinor: middle(bucket.map((o) => o.components.plantMinor)),
      subcontractRateMinor: middle(bucket.map((o) => o.components.subcontractMinor)),
      confidence,
      observations: bucket.length,
      projects,
      newestOn,
      basis:
        `Median of ${bucket.length} priced line${bucket.length === 1 ? '' : 's'} across ` +
        `${projects} project${projects === 1 ? '' : 's'}, newest ${newestOn}` +
        `${confidence === 'THIN' ? ' — a data point, not a benchmark' : ''}`,
    });
  }
  return rates;
}

/** The heads and the margin this business last priced a job at. */
function lastBasis(ctx: EngineContext): PackProposal['basis'] {
  const estimates = ctx.ledger
    .listByTenant(ctx.tenantId, 'Estimate')
    .map((record) => record.state)
    .filter((state) => state.model && (state.omissions as string[] | undefined)?.length === 0)
    .sort((a, b) => String(a.createdAt ?? a.id).localeCompare(String(b.createdAt ?? b.id)));

  const latest = estimates.at(-1);
  if (!latest) return null;
  const model = latest.model as CostModelInput;
  return {
    from: `your last complete estimate, on package ${String(latest.packageId ?? '—')}`,
    durationWeeks: model.durationWeeks ?? null,
    timeRelated: model.timeRelated ?? [],
    quantified: model.quantified ?? [],
    insurance: model.insurance,
    margin: model.margin ?? null,
    exclusions: model.exclusions ?? [],
  };
}

/**
 * Read every drawing in the pack, measure it, and price what was measured
 * against this business's own record. Writes the readings and nothing else.
 */
export async function proposePackPrice(
  ctx: EngineContext,
  store: EvidenceStore,
  input: { packageId: string },
): Promise<PackProposal> {
  authorise(ctx, 'BOQ_TAKEOFF', 'C');
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const drawings = ingestedFiles(ctx).filter(
    (file) => file.classification.kind === 'DRAWING' && file.status !== 'QUARANTINED',
  );
  if (drawings.length === 0) {
    throw new DomainError(
      'PACK_HAS_NO_DRAWING',
      'No file on this project is classified as a drawing. File the drawings first — the run measures what it can see, and it cannot see a pack that is not here.',
      409,
    );
  }

  const read: PackProposal['read'] = [];
  const unread: PackProposal['unread'] = [];
  const lines: ProposedLine[] = [];
  let acuConsumed = 0;

  for (const drawing of drawings) {
    const filename = drawing.filename ?? drawing.hash.slice(0, 12);
    try {
      const extracted = await perception.extract(ctx, store, { hash: drawing.hash, task: 'DRAWING_TAKEOFF' });
      acuConsumed += extracted.acuConsumed;
      const items = (extracted.extraction.items as Array<Record<string, unknown>> | undefined) ?? [];
      read.push({
        hash: drawing.hash,
        filename,
        draftId: extracted.draftId,
        items: items.length,
        confidence: extracted.confidence ?? null,
      });
      items.forEach((item, index) => {
        lines.push({
          draftId: extracted.draftId,
          index,
          description: String(item.description ?? ''),
          unit: String(item.unit ?? ''),
          quantity: Number(item.quantity ?? 0),
          sourceSheet: item.sourceSheet ? String(item.sourceSheet) : null,
          measurementRule: String(item.measurementRule ?? 'NRM2'),
          rate: null,
        });
      });
    } catch (error) {
      // Named, never skipped. A pack of five where one was unreadable and the
      // screen shows four is a pack silently mispriced.
      unread.push({ hash: drawing.hash, filename, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  const rates = proposedRates(ctx);
  for (const line of lines) {
    const rate = rates.get(rateKey(line.description, line.unit));
    if (rate && rate.allInMinor > 0) line.rate = rate;
    else line.unpriced = 'This business has never priced this item, so there is no rate to propose. Put one against it.';
  }

  const basis = lastBasis(ctx);

  // Priced, not recorded. `priceEstimate` is the same arithmetic `buildEstimate`
  // would run, so what the screen shows is what accepting would produce — not a
  // preview computed a second way that disagrees with the real thing.
  let indicative: PackProposal['indicative'] = null;
  if (lines.length > 0 && basis?.margin && basis.durationWeeks) {
    const priced = priceEstimate({
      durationWeeks: basis.durationWeeks,
      lines: lines.map(toMeasuredLine),
      ...(basis.timeRelated ? { timeRelated: basis.timeRelated } : {}),
      ...(basis.quantified ? { quantified: basis.quantified } : {}),
      ...(basis.insurance ? { insurance: basis.insurance } : {}),
      ...(basis.exclusions ? { exclusions: basis.exclusions } : {}),
      margin: basis.margin,
    });
    indicative = {
      totalMinor: priced.tenderTotalMinor,
      netMeasuredMinor: priced.subtotals.netMeasuredMinor,
      omissions: priced.omissions,
      warnings: priced.warnings,
    };
  }

  const outstanding: string[] = [];
  if (!basis) outstanding.push('This business has no complete estimate to take a basis from, so the period, the site-wide heads and the margin are all yours to state.');
  if (basis && !basis.durationWeeks) outstanding.push('How many weeks the job runs. Every time-related head is priced by the week and nothing in a drawing says how long it takes.');
  if (lines.some((line) => line.rate === null)) {
    const count = lines.filter((line) => line.rate === null).length;
    outstanding.push(`${count} measured line${count === 1 ? ' has' : 's have'} no rate in this business's record and need one.`);
  }
  if (indicative && indicative.omissions.length > 0) {
    outstanding.push(`${indicative.omissions.length} cost head${indicative.omissions.length === 1 ? '' : 's'} would be neither priced nor excluded: ${indicative.omissions.join(', ')}.`);
  }
  if (unread.length > 0) outstanding.push(`${unread.length} drawing${unread.length === 1 ? '' : 's'} could not be read, so anything on ${unread.length === 1 ? 'it' : 'them'} is not in this price.`);

  return { packageId: input.packageId, read, unread, lines, basis, indicative, outstanding, acuConsumed };
}

function toMeasuredLine(line: ProposedLine): MeasuredLine {
  return {
    description: line.description,
    unit: line.unit,
    quantity: line.quantity,
    ...(line.rate
      ? {
          labourRateMinor: line.rate.labourRateMinor,
          materialRateMinor: line.rate.materialRateMinor,
          plantRateMinor: line.rate.plantRateMinor,
          subcontractRateMinor: line.rate.subcontractRateMinor,
        }
      : {}),
  };
}

export type AcceptInput = {
  packageId: string;
  costCodePrefix: string;
  /** The lines as the person left them: every rate looked at, some corrected. */
  lines: Array<{
    draftId: string;
    index: number;
    labourRateMinor?: number;
    materialRateMinor?: number;
    plantRateMinor?: number;
    subcontractRateMinor?: number;
  }>;
  estimate: {
    durationWeeks: number;
    basisOfEstimate: string;
    assumptions?: string[];
    timeRelated?: CostModelInput['timeRelated'];
    quantified?: CostModelInput['quantified'];
    insurance?: CostModelInput['insurance'];
    exclusions?: CostModelInput['exclusions'];
    margin: CostModelInput['margin'];
  };
  /** Present to go all the way to a quotation; absent stops at the estimate. */
  quotation?: Omit<QuotationInput, 'estimateId'>;
};

/**
 * One decision, taken once: confirm every reading, write the bill, price it,
 * and draw up the quotation.
 *
 * The ordering matters and is the reason this is one function rather than three
 * calls from a screen. A confirmation that succeeded followed by an estimate
 * that failed would leave a bill nobody asked for and a person with no way to
 * tell how far the run got.
 */
export async function acceptPackProposal(
  platform: Platform,
  ctx: EngineContext,
  actor: AuthContext,
  input: AcceptInput,
): Promise<{
  boqItemIds: string[];
  estimateId: string;
  totalMinor: number;
  quotationId: string | null;
  quotationNumberPending: boolean;
}> {
  if (input.lines.length === 0) {
    throw new DomainError('PROPOSAL_EMPTY', 'There is nothing to accept: no measured line was included', 422);
  }

  // Confirm each reading once, in draft order, and keep the bill item each
  // measured line became. `confirm` is the existing door — the same one a
  // person uses when they confirm a single drawing — so a run leaves exactly
  // the record a hand-driven confirmation would.
  const byDraft = new Map<string, AcceptInput['lines']>();
  for (const line of input.lines) {
    byDraft.set(line.draftId, [...(byDraft.get(line.draftId) ?? []), line]);
  }

  const boqItemIds: string[] = [];
  const estimateLines: MeasuredLine[] = [];

  for (const [draftId, drafted] of byDraft) {
    const confirmed = await perception.confirm(ctx, {
      draftId,
      packageId: input.packageId,
      costCodePrefix: input.costCodePrefix,
    });
    const written = (confirmed.result.boqItemIds as string[] | undefined) ?? [];
    const items = platform.ledger
      .list(ctx.projectId, 'BoQItem')
      .filter((record) => written.includes(record.refId))
      .map((record) => record.state);

    for (const line of drafted) {
      // `runTakeoff` writes one bill item per read item, in order, so the index
      // the proposal carried is the index of the item it became.
      const id = written[line.index];
      const item = items.find((candidate) => String(candidate.id) === id);
      if (!id || !item) {
        throw new DomainError(
          'PROPOSAL_STALE',
          'The reading this proposal was built from has changed. Run it again rather than pricing against a bill that moved.',
          409,
        );
      }
      boqItemIds.push(id);
      estimateLines.push({
        boqItemId: id,
        description: String(item.description ?? ''),
        unit: String(item.unit ?? ''),
        quantity: Number(item.quantity ?? 0),
        ...(line.labourRateMinor ? { labourRateMinor: line.labourRateMinor } : {}),
        ...(line.materialRateMinor ? { materialRateMinor: line.materialRateMinor } : {}),
        ...(line.plantRateMinor ? { plantRateMinor: line.plantRateMinor } : {}),
        ...(line.subcontractRateMinor ? { subcontractRateMinor: line.subcontractRateMinor } : {}),
      });
    }
  }

  const built = tender.buildEstimate(ctx, {
    packageId: input.packageId,
    durationWeeks: input.estimate.durationWeeks,
    lines: estimateLines,
    basisOfEstimate: input.estimate.basisOfEstimate,
    assumptions: input.estimate.assumptions ?? [],
    margin: input.estimate.margin,
    ...(input.estimate.timeRelated ? { timeRelated: input.estimate.timeRelated } : {}),
    ...(input.estimate.quantified ? { quantified: input.estimate.quantified } : {}),
    ...(input.estimate.insurance ? { insurance: input.estimate.insurance } : {}),
    ...(input.estimate.exclusions ? { exclusions: input.estimate.exclusions } : {}),
  });

  // The quotation refuses an incomplete estimate by itself, which is where that
  // rule belongs. Nothing is caught here: an estimate that cannot be quoted has
  // still been built, and the refusal names the heads to go and price.
  const quoted = input.quotation
    ? quoteFromEstimate(platform, ctx, actor, { estimateId: built.estimateId, ...input.quotation })
    : null;

  return {
    boqItemIds,
    estimateId: built.estimateId,
    totalMinor: built.totalMinor,
    quotationId: quoted?.document.id ?? null,
    // It is a draft. A number is reserved at issue, by a person, under the
    // company's own numbering rule — which is the one step of this that is a
    // legal act rather than arithmetic.
    quotationNumberPending: quoted !== null,
  };
}
