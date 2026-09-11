import { DomainError } from '../core/errors.ts';
import { canonicalUnit } from '../core/units.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import type { BuiltRate, MeasuredItem, QuantitySource, RateComponentKind } from './measurement.ts';

/**
 * Why is this number — `L7.5`.
 *
 * ---
 *
 * **The question this answers.** A commercial director looks at a line in a bill
 * that says £287,400 and asks where it came from. Today the honest answer is
 * *the records are all there* — the quantity names its drawing and revision, the
 * rate names its components, the freeze names who approved it — and somebody
 * spends an afternoon assembling them. The data has always been present; what
 * has not existed is the **chain**, materialised in one place, in the order the
 * arithmetic ran.
 *
 * So this is a projection and not a new write path. Nothing here is stored, no
 * event is emitted, and the graph is rebuilt from the ledger every time it is
 * asked for. That matters twice over: a stored lineage would be a second copy
 * of the truth that could disagree with the first, and a lineage that is
 * recomputed cannot be stale.
 *
 * ## The shape
 *
 * Five node kinds, and they are the specification's own:
 *
 * - **`SOURCE`** — something outside the arithmetic that the arithmetic rests
 *   on: a drawing at a revision, a model object set, a client's bill by its
 *   hash, a supplier's cost.
 * - **`CALC`** — a step of arithmetic, with the operands named. `quantity ×
 *   rate` and `unit cost × constant × waste` are the only two here, because
 *   they are the only two the engine performs.
 * - **`ASSUMPTION`** — a figure nobody measured. An allowance, and a
 *   productivity constant, are both assumptions and are labelled as such rather
 *   than presented beside a measured quantity as though they were the same kind
 *   of thing.
 * - **`ADJUSTMENT`** — waste on a material. Separated because it is the one
 *   uplift that can be argued about line by line.
 * - **`APPROVAL`** — the freeze, with who and when. A number in an unfrozen
 *   schedule is a working figure, and saying so is the point.
 *
 * Each node names its parents, so the result is a directed acyclic graph rather
 * than a list. The root is the money; the leaves are documents and decisions.
 *
 * ## What it refuses to invent
 *
 * **A price base date it was not given.** The measurement engine records when a
 * rate was built and by whom. It does not record an index date against which
 * costs were current, and this does not pretend one — `basedOn` says *built on*
 * the day the rate was committed, which is a fact, rather than *priced at* a
 * base date, which would be a guess.
 *
 * **Currency conversion.** The schedule has one currency and every figure in it
 * is in that currency. If two currencies ever meet, that is a rate decision with
 * somebody's authority on it, and it belongs where `reconcile` already refuses
 * it rather than being quietly performed here.
 *
 * **Confidence.** The specification's lineage node carries a confidence figure.
 * This one does not, because there is nothing honest to put in it: the platform
 * knows whether a quantity is measured, provisional, approximate or an
 * allowance, and that is a statement about basis rather than a probability.
 * `basis` is reported and no number is invented from it.
 */

export const LINEAGE_KIND = ['SOURCE', 'CALC', 'ASSUMPTION', 'ADJUSTMENT', 'APPROVAL'] as const;
export type LineageKind = (typeof LINEAGE_KIND)[number];

export type LineageNode = {
  id: string;
  kind: LineageKind;
  /** What this node is, in the words a quantity surveyor would use. */
  label: string;
  /** The figure this node carries, where it carries one. Minor units for money. */
  value?: number;
  unit?: string;
  currency?: string;
  /** Where the figure came from — a drawing, a person, a formula, a record. */
  source?: string;
  /** The nodes this one was computed from. Empty on a leaf. */
  parents: string[];
  /** Anything a reader needs that is not a number. */
  note?: string;
};

export type PriceLineage = {
  scheduleId: string;
  scheduleReference: string;
  itemReference: string;
  description: string;
  currency: string;
  /** The money this line contributes to the direct cost. */
  amountMinor: number;
  /** The node the reader starts from. Always present. */
  rootId: string;
  nodes: LineageNode[];
  /** Whether the schedule the line sits in has been frozen. */
  frozen: boolean;
  /** What the chain cannot answer, said out loud rather than left blank. */
  gaps: string[];
  summary: string;
};

type ScheduleState = {
  id: string;
  reference: string;
  currency: string;
  items: MeasuredItem[];
  rates: BuiltRate[];
  status: 'OPEN' | 'FROZEN';
  frozenAt?: string;
  frozenBy?: string;
  freezeReason?: string;
};

const money = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The source, rendered as the sentence a reader needs. */
function describeSource(source: QuantitySource): { text: string; kind: LineageKind } {
  if (source.drawing) {
    return {
      text: `${source.drawing}${source.revision ? ` rev ${source.revision}` : ''}${source.sheet ? `, sheet ${source.sheet}` : ''}`,
      kind: 'SOURCE',
    };
  }
  if (source.modelObjectSet) return { text: `Model object set ${source.modelObjectSet}`, kind: 'SOURCE' };
  if (source.document) {
    return {
      text: `Document ${source.document}${source.page !== undefined ? `, page ${source.page}` : ''}`,
      kind: 'SOURCE',
    };
  }
  if (source.allowanceBasis) {
    return {
      text: `${source.allowanceBasis}${source.authorisedBy ? `, authorised by ${source.authorisedBy}` : ''}`,
      kind: 'ASSUMPTION',
    };
  }
  return { text: 'No source recorded', kind: 'SOURCE' };
}

/**
 * The chain behind one priced line.
 *
 * Read-only and derived. `ESTIMATE_TENDER` `R` at `COMMERCIAL_L3`, the same
 * authority that reads the schedule it projects — a lineage that could be read
 * by somebody who may not read the bill would be a way around the bill.
 */
export function priceLineage(ctx: EngineContext, scheduleId: string, itemReference: string): PriceLineage {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record: EntityRecord | undefined = ctx.ledger.get({ refType: 'MeasurementSchedule', refId: scheduleId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('SCHEDULE_NOT_FOUND', `No measurement schedule ${scheduleId}`, 404);
  }
  const state = record.state as unknown as ScheduleState;

  const item = state.items.find((candidate) => candidate.reference === itemReference);
  if (!item) {
    throw new DomainError(
      'ITEM_NOT_FOUND',
      `${state.reference} has no item ${itemReference}. A lineage for a line that is not in the bill would be a chain ` +
        'ending in nothing.',
      404,
    );
  }

  const rate = state.rates.find((candidate) => candidate.reference === itemReference);
  const nodes: LineageNode[] = [];
  const gaps: string[] = [];
  const push = (node: LineageNode): string => {
    nodes.push(node);
    return node.id;
  };

  // --- The quantity side ----------------------------------------------------

  const described = describeSource(item.source);
  const sourceId = push({
    id: 'src.quantity',
    kind: described.kind,
    label: described.kind === 'ASSUMPTION' ? 'Allowance basis' : 'Measured from',
    source: described.text,
    parents: [],
    ...(item.source.drawing && !item.source.revision
      ? { note: 'No revision recorded, so this cannot say which issue of the drawing the quantity belongs to.' }
      : {}),
  });
  if (described.text === 'No source recorded') {
    gaps.push(`${itemReference} names no drawing, model or document, so the quantity cannot be traced back to anything.`);
  }

  const quantityParents = [sourceId];
  if (item.formula?.trim()) {
    quantityParents.push(
      push({
        id: 'calc.formula',
        kind: 'CALC',
        label: 'Formula',
        source: item.formula,
        parents: [sourceId],
        note: 'Re-evaluated against the quantity beside it. The two disagreeing is the commonest error in a bill.',
      }),
    );
  }

  const canonical = canonicalUnit(item.unit);
  const quantityId = push({
    id: 'val.quantity',
    kind: item.basis === 'ALLOWANCE' ? 'ASSUMPTION' : 'SOURCE',
    label: `Quantity, ${item.basis.toLowerCase()}`,
    value: item.quantity,
    unit: canonical?.symbol ?? item.unit,
    parents: quantityParents,
    ...(canonical
      ? {}
      : { note: `"${item.unit}" is not a unit this platform reads, so nothing downstream of it has been dimension-checked.` }),
  });
  if (!canonical) {
    gaps.push(`The unit "${item.unit}" is unreadable, so the arithmetic below it is unchecked.`);
  }

  // --- The rate side --------------------------------------------------------

  if (!rate) {
    gaps.push(`${itemReference} carries no rate, so this line contributes nothing and is priced at zero by everybody who reads it.`);
    return {
      scheduleId,
      scheduleReference: state.reference,
      itemReference,
      description: item.description,
      currency: state.currency,
      amountMinor: 0,
      rootId: quantityId,
      nodes,
      frozen: state.status === 'FROZEN',
      gaps,
      summary:
        `${itemReference} has a quantity and no rate. The chain stops at the measurement, which is the honest place for it ` +
        'to stop.',
    };
  }

  const componentIds: string[] = [];
  for (const [index, component] of rate.components.entries()) {
    const costId = push({
      id: `src.cost.${index}`,
      kind: 'SOURCE',
      label: `${component.kind.toLowerCase()} cost`,
      value: component.unitCostMinor,
      currency: state.currency,
      source: component.description,
      parents: [],
    });

    // The constant is the productivity assumption: how much of the resource one
    // unit of the item takes. It is an assumption whatever the estimator's
    // confidence in it, and labelling it as a source would put it beside a
    // measured quantity as though the two were the same kind of thing.
    const constantId = push({
      id: `asm.constant.${index}`,
      kind: 'ASSUMPTION',
      label: 'Productivity constant',
      value: component.constant,
      unit: `per ${canonical?.symbol ?? item.unit}`,
      source: component.description,
      parents: [],
    });

    const parents = [costId, constantId];
    if (component.kind === 'MATERIAL' && component.wastePercent !== undefined) {
      parents.push(
        push({
          id: `adj.waste.${index}`,
          kind: 'ADJUSTMENT',
          label: 'Waste',
          value: component.wastePercent,
          unit: '%',
          source: component.description,
          parents: [],
          note: 'Cutting, breakage and over-order. The one uplift that is argued line by line.',
        }),
      );
    }

    const waste = component.kind === 'MATERIAL' ? 1 + (component.wastePercent ?? 0) / 100 : 1;
    componentIds.push(
      push({
        id: `calc.component.${index}`,
        kind: 'CALC',
        label: `${component.description} — contribution to the rate`,
        value: Math.round(component.unitCostMinor * component.constant * waste),
        currency: state.currency,
        parents,
        note:
          component.kind === 'MATERIAL' && component.wastePercent !== undefined
            ? 'Unit cost × constant × waste.'
            : 'Unit cost × constant.',
      }),
    );
  }

  const rateId = push({
    id: 'calc.rate',
    kind: 'CALC',
    label: 'Rate, per unit of the item',
    value: rate.rateMinor,
    currency: state.currency,
    parents: componentIds,
    source: `Built by ${rate.builtBy} on ${rate.builtAt.slice(0, 10)}`,
    // Rounded once at the end rather than per component: rounding four
    // components and adding them is a different number from adding and rounding
    // once, and on ten thousand square metres the difference is real money.
    note: 'The components are summed exactly and rounded once, not rounded individually and then summed.',
  });

  const amountMinor = Math.round(rate.rateMinor * item.quantity);
  const rootId = push({
    id: 'calc.amount',
    kind: 'CALC',
    label: 'Amount',
    value: amountMinor,
    currency: state.currency,
    parents: [quantityId, rateId],
    note: 'Quantity × rate.',
  });

  if (state.status === 'FROZEN' && state.frozenBy) {
    push({
      id: 'apr.freeze',
      kind: 'APPROVAL',
      label: 'Schedule frozen',
      source: `${state.frozenBy} on ${(state.frozenAt ?? '').slice(0, 10)}${state.freezeReason ? ` — ${state.freezeReason}` : ''}`,
      parents: [rootId],
    });
  } else {
    gaps.push('This schedule is not frozen, so every figure in this chain is a working figure and can still move.');
  }

  // Said rather than invented. The specification's lineage node carries a price
  // base date; the measurement engine records when a rate was built and not the
  // index date its costs were current at, and a date assembled from the first
  // would be presented as the second.
  gaps.push(
    `No price base date is recorded. The rate was built on ${rate.builtAt.slice(0, 10)}, which is when somebody entered ` +
      'it rather than the date its costs were current at.',
  );

  return {
    scheduleId,
    scheduleReference: state.reference,
    itemReference,
    description: item.description,
    currency: state.currency,
    amountMinor,
    rootId,
    nodes,
    frozen: state.status === 'FROZEN',
    gaps,
    summary:
      `${money(amountMinor, state.currency)} is ${item.quantity} ${canonical?.symbol ?? item.unit} at ` +
      `${money(rate.rateMinor, state.currency)} each, built from ${rate.components.length} component` +
      `${rate.components.length === 1 ? '' : 's'} and measured from ${described.text}.`,
  };
}

export type ScheduleLineage = {
  scheduleId: string;
  reference: string;
  currency: string;
  lines: Array<{
    itemReference: string;
    description: string;
    amountMinor: number;
    /** How many nodes stand behind this figure. A line with two is barely traced. */
    depth: number;
    gaps: number;
  }>;
  /** Every line whose chain cannot answer something. The list somebody works through. */
  incomplete: Array<{ itemReference: string; gaps: string[] }>;
  summary: string;
};

/**
 * The same question asked of a whole schedule.
 *
 * Built so the answer to *which of these numbers cannot be defended* is one read
 * rather than one read per line. A line whose chain has a gap is not wrong; it
 * is a line somebody will have to explain from memory.
 */
export function scheduleLineage(ctx: EngineContext, scheduleId: string): ScheduleLineage {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.get({ refType: 'MeasurementSchedule', refId: scheduleId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('SCHEDULE_NOT_FOUND', `No measurement schedule ${scheduleId}`, 404);
  }
  const state = record.state as unknown as ScheduleState;

  const lines = state.items.map((item) => {
    const chain = priceLineage(ctx, scheduleId, item.reference);
    return {
      itemReference: item.reference,
      description: item.description,
      amountMinor: chain.amountMinor,
      depth: chain.nodes.length,
      gaps: chain.gaps.length,
    };
  });

  const incomplete = state.items
    .map((item) => ({ itemReference: item.reference, gaps: priceLineage(ctx, scheduleId, item.reference).gaps }))
    .filter((entry) => entry.gaps.length > 0);

  return {
    scheduleId,
    reference: state.reference,
    currency: state.currency,
    lines,
    incomplete,
    summary:
      lines.length === 0
        ? `${state.reference} carries no items, so there is nothing to trace.`
        : `${lines.length} line(s), ${incomplete.length} with something the chain cannot answer.`,
  };
}

/** Which kinds of node the reader will meet, published so the console names them the same way. */
export function lineageKinds(): Array<{ kind: LineageKind; means: string }> {
  return [
    { kind: 'SOURCE', means: 'Something outside the arithmetic that the arithmetic rests on' },
    { kind: 'CALC', means: 'A step of arithmetic, with its operands named' },
    { kind: 'ASSUMPTION', means: 'A figure nobody measured — an allowance, or a productivity constant' },
    { kind: 'ADJUSTMENT', means: 'Waste on a material, the one uplift argued line by line' },
    { kind: 'APPROVAL', means: 'Who froze the schedule this figure sits in, and when' },
  ];
}

/** Group by kind, for a reader who wants the assumptions rather than the graph. */
export function byKind(lineage: PriceLineage): Record<LineageKind, LineageNode[]> {
  const grouped = { SOURCE: [], CALC: [], ASSUMPTION: [], ADJUSTMENT: [], APPROVAL: [] } as Record<
    LineageKind,
    LineageNode[]
  >;
  for (const node of lineage.nodes) grouped[node.kind].push(node);
  return grouped;
}

export type { RateComponentKind };
