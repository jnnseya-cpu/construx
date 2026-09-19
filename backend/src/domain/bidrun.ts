import { DomainError } from '../core/errors.ts';
import { authorise, runAI, type EngineContext } from '../engines/context.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { ingestedFiles } from '../evidence/pipeline.ts';
import * as perception from '../engines/perception.ts';
import * as tender from '../engines/tender.ts';
import { confidenceFor, harvestRates, rateKey, type Confidence } from './costintel.ts';
import { costHead, priceEstimate, type CostHead, type CostModelInput, type MeasuredLine } from '../engines/maths/costModel.ts';
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
 * **It invents no rate.** A median of one observation is reported as one
 * observation. Where the record cannot price a line, a model is asked what the
 * market pays — and the answer is labelled a market view everywhere it appears,
 * carries a range rather than a point, is put in front of a person to keep or
 * change, and is kept out of the rate history so a guess can never come back as
 * this company's own committed rate. See `marketRates` for why that third rule
 * is the one that makes the other two safe.
 */

export type ProposedRate = {
  allInMinor: number;
  labourRateMinor: number;
  materialRateMinor: number;
  plantRateMinor: number;
  subcontractRateMinor: number;
  /**
   * Where it came from, and the two are not the same kind of fact.
   *
   * `OUR_RECORD` is a median of what this business has actually committed on
   * past estimates — evidence. `MARKET_AI` is a model's view of what the item
   * goes for in this region today, which is a starting point rather than a
   * fact, and is labelled as one everywhere it is shown.
   */
  source: 'OUR_RECORD' | 'MARKET_AI';
  /** `MODEL_VIEW` where nothing in the record supports it. */
  confidence: Confidence | 'MODEL_VIEW';
  observations: number;
  projects: number;
  newestOn: string;
  /** The range, on a market view. An estimator prices inside a range, not at a point. */
  lowMinor?: number;
  highMinor?: number;
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
  /**
   * The cost heads this job would carry and nothing has answered for.
   *
   * The reason this exists: a business with no previous complete estimate has
   * no basis for the run to inherit, so the accepted estimate carried nothing
   * against insurance or waste and the quotation refused it — correctly, and
   * after the work, with the person left holding an estimate they could not
   * send. Reported before the acceptance instead, so the form can ask the two
   * questions that settle each one: what is it, or why is it not in this offer.
   */
  headsToSettle: Array<{
    head: CostHead;
    label: string;
    /** How the model prices this head, which decides what the form asks for. */
    basis: string;
    /** In plain words, so a person knows what they are being asked about. */
    note: string;
  }>;
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
      source: 'OUR_RECORD',
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

/**
 * What the market pays for the lines our own record has never priced.
 *
 * Asked for, and the reasoning behind granting it is worth writing down,
 * because this is the one place the platform lets a model put a number into a
 * commercial document.
 *
 * The rule everywhere else is that the platform invents no rate: a line with no
 * history comes back unpriced and says so, because filling a gap with a
 * plausible number is how an estimate becomes confident and wrong. That rule
 * stands. What changes is who is being asked. A median of this business's own
 * committed estimates is **evidence**; a model's view of what an item goes for
 * in this region today is **a starting point somebody experienced can correct
 * in ten seconds**, which is worth a great deal more than an empty box — and a
 * contractor pricing a line they have never priced before does exactly this,
 * from memory or a rate book, every day.
 *
 * Three things keep it honest, and none of them is optional.
 *
 * **It is labelled, everywhere.** `source: 'MARKET_AI'` travels with the rate
 * onto the screen, into the accepted estimate line, and into the record. A
 * reader years later can see which lines were priced off a model's view and
 * which off the company's own history.
 *
 * **It never becomes history.** `harvestRates` skips `MARKET_AI` lines, so a
 * guess cannot be harvested back next month as "what this business charges".
 * Without that, one guess compounds into a confident median with nothing behind
 * it but the first guess.
 *
 * **It carries a range and a basis.** A point estimate invites acceptance; a
 * range invites judgement, which is the behaviour this is for. The model is
 * told to omit anything it cannot support rather than fill the row.
 */
async function marketRates(
  ctx: EngineContext,
  lines: ProposedLine[],
  where: string,
): Promise<{ rates: Map<string, ProposedRate>; acuConsumed: number }> {
  const rates = new Map<string, ProposedRate>();
  if (lines.length === 0) return { rates, acuConsumed: 0 };

  const today = new Date().toISOString().slice(0, 10);
  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'market_rate_estimate',
    capability: 'REASONING',
    inputRefs: [],
    request: {
      task:
        'Give a current market unit rate for each measured item, for a contractor working in the region and at the ' +
        'date stated. Split each rate into labour, materials, plant and subcontract so it can be priced to the right ' +
        'cost head, and give a low and a high for the range you would expect to see. State the basis of each in one ' +
        'sentence an estimator can argue with. Omit any item you cannot support a rate for rather than filling the ' +
        'row — an omitted line is corrected in seconds, and a confident wrong rate is not noticed until the job is ' +
        'lost or built at a loss. All money in minor units.',
      payload: {
        region: where,
        date: today,
        currency: 'GBP',
        items: lines.map((line) => ({ description: line.description, unit: line.unit, quantity: line.quantity })),
      },
      responseSchema: {
        type: 'object',
        properties: {
          rates: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                unit: { type: 'string' },
                labourMinor: { type: 'number' },
                materialMinor: { type: 'number' },
                plantMinor: { type: 'number' },
                subcontractMinor: { type: 'number' },
                lowMinor: { type: 'number' },
                highMinor: { type: 'number' },
                basis: { type: 'string' },
              },
              required: ['description', 'unit', 'basis'],
            },
          },
          omitted: { type: 'array', items: { type: 'string' } },
        },
        required: ['rates'],
      },
    },
    // A market view is a proposal on a screen, not a record. Nothing is
    // committed until a person accepts the run, and what they accept carries
    // the provenance with it.
    toWrites: () => [],
  });

  const answered = (result.output.rates as Array<Record<string, unknown>> | undefined) ?? [];
  for (const answer of answered) {
    const labour = Math.max(0, Math.round(Number(answer.labourMinor ?? 0)));
    const material = Math.max(0, Math.round(Number(answer.materialMinor ?? 0)));
    const plant = Math.max(0, Math.round(Number(answer.plantMinor ?? 0)));
    const subcontract = Math.max(0, Math.round(Number(answer.subcontractMinor ?? 0)));
    const allIn = labour + material + plant + subcontract;
    // A row with no money in it is an omission the model reported in the shape
    // of an answer, and carrying it would put a zero rate on a priced line.
    if (allIn <= 0) continue;

    const low = Number(answer.lowMinor ?? 0);
    const high = Number(answer.highMinor ?? 0);
    rates.set(rateKey(String(answer.description ?? ''), String(answer.unit ?? '')), {
      source: 'MARKET_AI',
      allInMinor: allIn,
      labourRateMinor: labour,
      materialRateMinor: material,
      plantRateMinor: plant,
      subcontractRateMinor: subcontract,
      confidence: 'MODEL_VIEW',
      observations: 0,
      projects: 0,
      newestOn: today,
      ...(low > 0 ? { lowMinor: Math.round(low) } : {}),
      ...(high > 0 ? { highMinor: Math.round(high) } : {}),
      basis: `A model\u2019s view of the ${where} market on ${today}: ${String(answer.basis ?? 'no basis given')}`,
    });
  }

  return { rates, acuConsumed: result.acuConsumed };
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
  }

  /*
   * Our own record first, the market second, and never the other way round.
   *
   * A rate this business has actually committed is evidence and beats a model's
   * view of the market every time — even a thin one, because it is what this
   * company charges rather than what somebody charges. The model is asked only
   * about the lines nothing in the record can answer, which is also what keeps
   * the call small and the charge proportionate: one request for the gaps, not
   * one per line and not one for the whole bill.
   */
  const gaps = lines.filter((line) => line.rate === null);
  let marketConsumed = 0;
  if (gaps.length > 0) {
    const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId })?.state;
    const location = project?.location as { city?: string; countryCode?: string } | undefined;
    const where = [location?.city, location?.countryCode].filter(Boolean).join(', ') || 'the United Kingdom';
    try {
      const market = await marketRates(ctx, gaps, where);
      marketConsumed = market.acuConsumed;
      for (const line of gaps) {
        const rate = market.rates.get(rateKey(line.description, line.unit));
        if (rate) line.rate = rate;
      }
    } catch (error) {
      // An unfunded wallet, an unavailable provider, a refusal. The run is not
      // lost for it: the lines stay unpriced and say so, which is where they
      // were before the market view existed.
      for (const line of gaps) {
        line.unpriced = `No rate in this business\u2019s record, and the market view could not be taken: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
  }
  acuConsumed += marketConsumed;

  for (const line of lines) {
    if (line.rate === null && !line.unpriced) {
      line.unpriced =
        'Neither this business\u2019s record nor the market view could put a rate against this item. Put one against it yourself.';
    }
  }

  const basis = lastBasis(ctx);

  // Priced, not recorded. `priceEstimate` is the same arithmetic `buildEstimate`
  // would run, so what the screen shows is what accepting would produce — not a
  // preview computed a second way that disagrees with the real thing.
  const model = (over: Partial<CostModelInput> = {}): CostModelInput => ({
    // A week, and a margin of nothing, where the record supplies neither. Both
    // are placeholders for a pricing run whose only output used here is the
    // list of omissions — which depends on the lines and the heads, not on the
    // duration or the margin.
    durationWeeks: basis?.durationWeeks ?? 1,
    lines: lines.map(toMeasuredLine),
    ...(basis?.timeRelated ? { timeRelated: basis.timeRelated } : {}),
    ...(basis?.quantified ? { quantified: basis.quantified } : {}),
    ...(basis?.insurance ? { insurance: basis.insurance } : {}),
    ...(basis?.exclusions ? { exclusions: basis.exclusions } : {}),
    margin: basis?.margin ?? { overheadPercent: 0, profitPercent: 0 },
    ...over,
  });

  let indicative: PackProposal['indicative'] = null;
  if (lines.length > 0 && basis?.margin && basis.durationWeeks) {
    const priced = priceEstimate(model());
    indicative = {
      totalMinor: priced.tenderTotalMinor,
      netMeasuredMinor: priced.subtotals.netMeasuredMinor,
      omissions: priced.omissions,
      warnings: priced.warnings,
    };
  }

  /*
   * Which heads this job would carry and nothing has answered for — computed
   * whether or not there is a basis to inherit, because the case that needs it
   * most is the business with no previous estimate at all.
   *
   * That is exactly what went wrong: the run inherited nothing, the estimate
   * carried nothing against insurance or waste, and the quotation refused it
   * after the acceptance. The refusal is right; meeting it after the work is
   * not. Asked before instead.
   */
  const headsToSettle =
    lines.length === 0
      ? []
      : priceEstimate(model()).omissions.map((head) => {
          const definition = costHead(head);
          return {
            head,
            label: definition?.label ?? head,
            basis: definition?.basis ?? 'MEASURED',
            note: definition?.note ?? '',
          };
        });

  const outstanding: string[] = [];
  if (!basis) outstanding.push('This business has no complete estimate to take a basis from, so the period, the site-wide heads and the margin are all yours to state.');
  if (basis && !basis.durationWeeks) outstanding.push('How many weeks the job runs. Every time-related head is priced by the week and nothing in a drawing says how long it takes.');
  const unratedCount = lines.filter((line) => line.rate === null).length;
  if (unratedCount > 0) {
    outstanding.push(`${unratedCount} measured line${unratedCount === 1 ? ' has' : 's have'} no rate at all and need one.`);
  }
  // Said separately, because it is a different question. An unpriced line is
  // work to do; a market-view line is priced and wants a look — it is the one
  // number on the screen that nothing in this company's record stands behind.
  const marketCount = lines.filter((line) => line.rate?.source === 'MARKET_AI').length;
  if (marketCount > 0) {
    outstanding.push(
      `${marketCount} line${marketCount === 1 ? ' is' : 's are'} priced at a model\u2019s view of the market rather than ` +
        `anything this business has committed. Keep ${marketCount === 1 ? 'it' : 'them'} or change ` +
        `${marketCount === 1 ? 'it' : 'them'} — nothing else in the run is a guess.`,
    );
  }
  if (headsToSettle.length > 0) {
    outstanding.push(
      `${headsToSettle.length} cost head${headsToSettle.length === 1 ? '' : 's'} ${
        headsToSettle.length === 1 ? 'is' : 'are'
      } neither priced nor excluded — ${headsToSettle.map((entry) => entry.label).join(', ')}. ` +
        'Price each or say it is not in this offer; a quotation cannot be drawn from an estimate that carries one.',
    );
  }
  if (unread.length > 0) outstanding.push(`${unread.length} drawing${unread.length === 1 ? '' : 's'} could not be read, so anything on ${unread.length === 1 ? 'it' : 'them'} is not in this price.`);

  return { packageId: input.packageId, read, unread, lines, basis, indicative, headsToSettle, outstanding, acuConsumed };
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
    /**
     * Where the accepted rate came from, carried onto the estimate line.
     *
     * A person who keeps a model's view of the market has accepted it, and the
     * record says so — `harvestRates` will not take it back as one of this
     * business's own rates, and a reader can see which lines it priced.
     */
    rateSource?: MeasuredLine['rateSource'];
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
        ...(line.rateSource ? { rateSource: line.rateSource } : {}),
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
