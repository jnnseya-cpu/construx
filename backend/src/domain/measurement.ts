import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * Measurement, the bill of quantities and the rate build-up — T-WF-03.
 *
 * The estimate already existed and is not rebuilt here: twenty cost heads,
 * time-related costs priced by the week, contingency drawn from the risk
 * register at P80, margin on the cost beneath it. That is where preliminaries,
 * risk and overhead-and-profit live and where they stay. What did not exist is
 * the layer underneath it — **the measured items themselves, and where each
 * quantity came from.**
 *
 * That layer is where tenders are lost, and always the same three ways.
 *
 * **A quantity nobody can trace.** Somebody measured 1,240 m² of blockwork off a
 * drawing eleven weeks ago. Which drawing, at which revision, off which sheet?
 * If the answer is not recorded it cannot be checked, and when the drawing is
 * reissued nobody knows which lines moved. `AC-T-WF-03-01`: every priced item
 * names the drawing and revision it was measured from, or the person who
 * authorised the allowance. A schedule holding one that does neither will not
 * freeze.
 *
 * **A formula that does not produce its own answer.** `12.4 × 3.85 × 2` is
 * 95.48 and the line says 94.58. It is a transposition, it happens constantly,
 * and it is invisible in a spreadsheet because the spreadsheet computed the
 * wrong cell too. The formula is held beside the quantity and re-evaluated, so
 * the two disagreeing is a refusal rather than a discovery at final account.
 *
 * **A drawing revision that quietly invalidates the price.** Rev C arrives, the
 * estimator prices on, and forty items measured off Rev B are now wrong by an
 * amount nobody has computed. `AC-T-WF-03-03`: reissuing a drawing marks every
 * item measured from it as needing remeasurement, by name, and the schedule
 * cannot freeze until each has been looked at.
 *
 * ---
 *
 * **Rates are built, not typed.** A rate is resource constants times resource
 * costs — 0.85 hours of bricklayer at £28.40, 59 blocks at £1.12 with 5% waste
 * — and holding the components rather than the answer is what makes a rate
 * arguable, reusable and repriceable when the labour rate moves. The build-up
 * produces **direct cost only**. Preliminaries, risk and OH&P are not spread
 * across item rates here, because a percentage on a rate is how a job whose
 * programme moves loses money quietly.
 *
 * **`AC-T-WF-03-02`: the totals reconcile.** Item to schedule by construction,
 * and schedule to schedule through a reconciliation that names every movement
 * — added, removed, remeasured, repriced — and refuses to report one that does
 * not add up to the difference between the two totals.
 */

// --- What a quantity is, and where it came from ------------------------------

/**
 * `MEASURED` — taken off a drawing or a model, and firm.
 * `PROVISIONAL` — the work is defined and the quantity is not; it is remeasured
 *   on site and the tender total is not the final one.
 * `APPROXIMATE` — measured, but off information the estimator does not trust.
 * `ALLOWANCE` — no measurement exists; a sum somebody authorised.
 */
export const QUANTITY_BASIS = ['MEASURED', 'PROVISIONAL', 'APPROXIMATE', 'ALLOWANCE'] as const;
export type QuantityBasis = (typeof QUANTITY_BASIS)[number];

/** Bases whose quantity is not firm, and which therefore carry uncertainty. */
export const UNCERTAIN_BASES: readonly QuantityBasis[] = ['PROVISIONAL', 'APPROXIMATE', 'ALLOWANCE'];

export type QuantitySource = {
  /** The drawing the quantity was measured from, and the revision of it. */
  drawing?: string;
  revision?: string;
  sheet?: string;
  /** A named set of model objects, where the measurement came off a model. */
  modelObjectSet?: string;
  /**
   * The document the quantity was read from — a client's bill of quantities
   * or a schedule, by its evidence hash — and the page it sits on. A tenderer
   * pricing the client's bill measures nothing; the bill is the source.
   */
  document?: string;
  page?: number;
  /** For an allowance: what it is based on. */
  allowanceBasis?: string;
  /** For an allowance: who agreed it. An allowance nobody authorised is a guess. */
  authorisedBy?: string;
};

export type MeasuredItem = {
  /** Stable within the schedule. The reference on the paper the client sees. */
  reference: string;
  /** The item this one sits under, for the bill's hierarchy. */
  parent?: string;
  description: string;
  unit: string;
  quantity: number;
  basis: QuantityBasis;
  source: QuantitySource;
  /**
   * The arithmetic the quantity came from, in the estimator's own terms:
   * `12.4 * 3.85 * 2`. Re-evaluated against the quantity, because the two
   * disagreeing is the commonest error in a bill and the least visible.
   */
  formula?: string;
  /** NRM2, CESMM4, POMI. Recorded per item because a bill can mix them. */
  measurementRule?: string;
};

// --- The formula ------------------------------------------------------------

/**
 * Evaluate the small arithmetic a measurement formula actually contains.
 *
 * Numbers, `+ - * /`, and parentheses. Deliberately not a general expression
 * language and deliberately not `eval` — this parses text that arrives over an
 * API, and the only safe evaluator is one that cannot express anything but
 * arithmetic.
 *
 * Returns `undefined` where the text is not arithmetic at all, which is
 * reported as an unreadable formula rather than as a mismatch.
 */
export function evaluateFormula(expression: string): number | undefined {
  const tokens = expression.match(/\d+(?:\.\d+)?|[()+\-*/]/g);
  if (!tokens || tokens.join('').replace(/\s/g, '') !== expression.replace(/\s/g, '')) return undefined;

  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  const primary = (): number | undefined => {
    const token = take();
    if (token === undefined) return undefined;
    if (token === '(') {
      const value = additive();
      if (take() !== ')') return undefined;
      return value;
    }
    if (token === '-') {
      const value = primary();
      return value === undefined ? undefined : -value;
    }
    if (!/^\d/.test(token)) return undefined;
    return Number(token);
  };

  const multiplicative = (): number | undefined => {
    let left = primary();
    while (left !== undefined && (peek() === '*' || peek() === '/')) {
      const operator = take();
      const right = primary();
      if (right === undefined) return undefined;
      if (operator === '/' && right === 0) return undefined;
      left = operator === '*' ? left * right : left / right;
    }
    return left;
  };

  const additive = (): number | undefined => {
    let left = multiplicative();
    while (left !== undefined && (peek() === '+' || peek() === '-')) {
      const operator = take();
      const right = multiplicative();
      if (right === undefined) return undefined;
      left = operator === '+' ? left + right : left - right;
    }
    return left;
  };

  const value = additive();
  return value === undefined || at !== tokens.length || !Number.isFinite(value) ? undefined : value;
}

// --- Validation -------------------------------------------------------------

export const MEASUREMENT_FINDING_SEVERITY = ['CRITICAL', 'MAJOR'] as const;
export type MeasurementFindingSeverity = (typeof MEASUREMENT_FINDING_SEVERITY)[number];

export type MeasurementFinding = {
  severity: MeasurementFindingSeverity;
  /** The item it is about, where it is about one. */
  reference?: string;
  subject: string;
  detail: string;
};

/**
 * How close a formula has to come to its own stated quantity.
 *
 * Quantities are rounded when they are written down — 95.48 becomes 95.5, and
 * on a hundred-item bill insisting on exactness would produce a hundred
 * findings nobody reads. A tenth of one per cent catches the transposition and
 * ignores the rounding.
 */
const FORMULA_TOLERANCE = 0.001;

/**
 * Everything wrong with a set of items, in one pass.
 *
 * `CRITICAL` blocks the freeze; `MAJOR` is reported and does not. The division
 * is not severity for its own sake: a critical finding means the bill states
 * something that is not true, and a major one means it states something
 * incomplete.
 */
export function validateItems(items: MeasuredItem[]): MeasurementFinding[] {
  const findings: MeasurementFinding[] = [];
  const byReference = new Map<string, MeasuredItem[]>();
  for (const item of items) {
    byReference.set(item.reference, [...(byReference.get(item.reference) ?? []), item]);
  }

  for (const [reference, group] of byReference) {
    if (group.length < 2) continue;
    findings.push({
      severity: 'CRITICAL',
      reference,
      subject: `${reference} appears ${group.length} times`,
      detail:
        'An item reference identifies one item. Two lines under one reference means a client pricing document and an internal ' +
        'bill that disagree about what was asked for.',
    });
    const units = [...new Set(group.map((item) => item.unit))];
    if (units.length > 1) {
      findings.push({
        severity: 'CRITICAL',
        reference,
        subject: `${reference} is measured in ${units.join(' and ')}`,
        detail: 'The same item at two units cannot be totalled and cannot be priced.',
      });
    }
  }

  const references = new Set(items.map((item) => item.reference));

  for (const item of items) {
    // AC-T-WF-03-01. A quantity nobody can trace cannot be checked, and cannot
    // be corrected when the information it came from moves.
    if (item.basis === 'ALLOWANCE') {
      if (!item.source.allowanceBasis?.trim() || !item.source.authorisedBy?.trim()) {
        findings.push({
          severity: 'CRITICAL',
          reference: item.reference,
          subject: `${item.reference} is an allowance with no authorised basis`,
          detail:
            'An allowance is a sum in the bid that nobody measured. Say what it is based on and who agreed it, or it is a guess ' +
            'that will be defended by somebody who was not there.',
        });
      }
    } else if (!item.source.drawing?.trim() && !item.source.modelObjectSet?.trim() && !item.source.document?.trim()) {
      findings.push({
        severity: 'CRITICAL',
        reference: item.reference,
        subject: `${item.reference} names no drawing, model or document it was measured from`,
        detail:
          'A measured quantity comes off something. Without it the line cannot be checked, and a reissued drawing cannot say ' +
          'whether this line moved.',
      });
    } else if (item.source.drawing?.trim() && !item.source.revision?.trim()) {
      findings.push({
        severity: 'CRITICAL',
        reference: item.reference,
        subject: `${item.reference} names ${item.source.drawing} without a revision`,
        detail:
          'A drawing without its revision is not a source. Rev A and Rev D are different drawings and the whole point of ' +
          'recording it is to know which one this quantity belongs to.',
      });
    }

    if (item.formula?.trim()) {
      const computed = evaluateFormula(item.formula);
      if (computed === undefined) {
        findings.push({
          severity: 'MAJOR',
          reference: item.reference,
          subject: `${item.reference} has a formula that cannot be read`,
          detail: `"${item.formula}" is not arithmetic this can re-evaluate, so the quantity beside it is unchecked.`,
        });
      } else if (Math.abs(computed - item.quantity) > Math.max(Math.abs(computed) * FORMULA_TOLERANCE, 1e-9)) {
        findings.push({
          severity: 'CRITICAL',
          reference: item.reference,
          subject: `${item.reference} states ${item.quantity} ${item.unit} and its formula gives ${Number(computed.toFixed(4))}`,
          detail:
            `"${item.formula}" does not produce the quantity beside it. This is the commonest error in a bill and the least ` +
            'visible, because whatever computed the wrong number computed it consistently.',
        });
      }
    }

    if (item.quantity < 0) {
      findings.push({
        severity: 'CRITICAL',
        reference: item.reference,
        subject: `${item.reference} has a negative quantity`,
        detail: 'A negative measured quantity is an omission entered as a correction. Take the item out instead.',
      });
    } else if (item.quantity === 0 && item.basis === 'MEASURED') {
      findings.push({
        severity: 'MAJOR',
        reference: item.reference,
        subject: `${item.reference} is measured at zero`,
        detail:
          'A zero against a measured item is not a measurement. Either the work is not there, in which case remove it, or it ' +
          'has not been measured yet, in which case say so.',
      });
    }

    if (item.parent && !references.has(item.parent)) {
      findings.push({
        severity: 'MAJOR',
        reference: item.reference,
        subject: `${item.reference} sits under ${item.parent}, which is not in the schedule`,
        detail: 'The hierarchy is broken here, so the section totals this item belongs to cannot be built.',
      });
    }
  }

  return findings;
}

// --- The rate build-up ------------------------------------------------------

export const RATE_COMPONENT_KIND = ['LABOUR', 'MATERIAL', 'PLANT', 'SUBCONTRACT'] as const;
export type RateComponentKind = (typeof RATE_COMPONENT_KIND)[number];

export type RateComponent = {
  kind: RateComponentKind;
  description: string;
  /** What one unit of the resource costs. */
  unitCostMinor: number;
  /** How much of the resource one unit of the item takes — hours per m², blocks per m². */
  constant: number;
  /** Added to materials for cutting, breakage and over-order. */
  wastePercent?: number;
};

export type BuiltRate = {
  reference: string;
  components: RateComponent[];
  /** Direct cost per unit of the item. Preliminaries, risk and OH&P are not in here. */
  rateMinor: number;
  byKind: Record<RateComponentKind, number>;
  builtBy: string;
  builtAt: string;
};

/**
 * The rate, from its components.
 *
 * Rounded once at the end rather than per component: rounding each of four
 * components and adding them is a different number from adding and rounding
 * once, and on ten thousand square metres the difference is real money.
 */
export function buildRate(reference: string, components: RateComponent[], builtBy: string): BuiltRate {
  const byKind: Record<RateComponentKind, number> = { LABOUR: 0, MATERIAL: 0, PLANT: 0, SUBCONTRACT: 0 };
  let exact = 0;

  for (const component of components) {
    const waste = component.kind === 'MATERIAL' ? 1 + (component.wastePercent ?? 0) / 100 : 1;
    const amount = component.unitCostMinor * component.constant * waste;
    byKind[component.kind] += amount;
    exact += amount;
  }

  for (const kind of RATE_COMPONENT_KIND) byKind[kind] = Math.round(byKind[kind]);

  return {
    reference,
    components,
    rateMinor: Math.round(exact),
    byKind,
    builtBy,
    builtAt: new Date().toISOString(),
  };
}

// --- The schedule -----------------------------------------------------------

type ScheduleState = {
  id: string;
  reference: string;
  packageReference: string;
  title: string;
  currency: string;
  measurementRule: string;
  items: MeasuredItem[];
  rates: BuiltRate[];
  remeasure: RemeasureFlag[];
  status: 'OPEN' | 'FROZEN';
};

export type RemeasureFlag = {
  reference: string;
  drawing: string;
  fromRevision: string;
  toRevision: string;
  raisedAt: string;
  status: 'OPEN' | 'CONFIRMED';
  /** What the remeasurement found, once somebody has looked. */
  outcome?: string;
};

function requireSchedule(ctx: EngineContext, scheduleId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'MeasurementSchedule', refId: scheduleId });
  if (!record) throw new DomainError('SCHEDULE_NOT_FOUND', `No measurement schedule ${scheduleId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): ScheduleState {
  return record.state as unknown as ScheduleState;
}

function assertOpen(record: EntityRecord): void {
  if (record.state.status === 'FROZEN') {
    throw new DomainError(
      'SCHEDULE_FROZEN',
      `${String(record.state.reference)} is frozen and the price is built on it. A change after the freeze is a new version, ` +
        'not an edit — otherwise the number that went out is no longer reproducible.',
    );
  }
}

export function openSchedule(
  ctx: EngineContext,
  input: { packageReference: string; title: string; measurementRule?: string; currency?: string },
): { scheduleId: string; reference: string } {
  authorise(ctx, 'BOQ_TAKEOFF', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.packageReference.trim() || !input.title.trim()) {
    throw new DomainError('SCHEDULE_UNNAMED', 'A measurement schedule names the package it measures and what it is.');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'MeasurementSchedule').length + 1;
  const reference = `MS-${String(sequence).padStart(3, '0')}`;
  const scheduleId = ulid();

  write(ctx, {
    eventType: 'BOQ_IMPORTED',
    entity: { refType: 'MeasurementSchedule', refId: scheduleId },
    nextState: {
      id: scheduleId,
      projectId: ctx.projectId,
      reference,
      packageReference: input.packageReference,
      title: input.title,
      currency: input.currency ?? 'GBP',
      measurementRule: input.measurementRule ?? 'NRM2',
      items: [],
      rates: [],
      remeasure: [],
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
  });

  return { scheduleId, reference };
}

/**
 * Record measured items. Appends, and replaces an item at the same reference.
 *
 * Replacing rather than refusing is deliberate: measurement is iterative, and a
 * remeasured line is the ordinary case rather than an error. What is not
 * ordinary — and is refused at the freeze — is the schedule ending up in a
 * state that says something untrue.
 */
export function recordItems(
  ctx: EngineContext,
  scheduleId: string,
  items: MeasuredItem[],
): { total: number; findings: MeasurementFinding[] } {
  authorise(ctx, 'BOQ_TAKEOFF', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSchedule(ctx, scheduleId);
  assertOpen(record);

  if (items.length === 0) {
    throw new DomainError('NO_ITEMS', 'There is nothing to record.');
  }

  const existing = stateOf(record).items;
  const incoming = new Set(items.map((item) => item.reference));
  const merged = [...existing.filter((item) => !incoming.has(item.reference)), ...items];

  const findings = validateItems(merged);

  write(ctx, {
    eventType: 'BOQ_IMPORTED',
    entity: { refType: 'MeasurementSchedule', refId: scheduleId },
    nextState: { ...record.state, items: merged, findings },
  });

  return { total: merged.length, findings };
}

/** Build the rate for one item from its resource components. */
export function priceItem(
  ctx: EngineContext,
  scheduleId: string,
  input: { reference: string; components: RateComponent[] },
): BuiltRate {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireSchedule(ctx, scheduleId);
  assertOpen(record);

  const state = stateOf(record);
  const item = state.items.find((i) => i.reference === input.reference);
  if (!item) throw new DomainError('ITEM_NOT_FOUND', `No item ${input.reference} in ${state.reference}`, 404);

  if (input.components.length === 0) {
    throw new DomainError(
      'RATE_HAS_NO_COMPONENTS',
      'A rate is built from what it costs to do the work. A number typed straight in cannot be argued, reused, or repriced ' +
        'when the labour rate moves.',
    );
  }

  for (const component of input.components) {
    if (component.constant <= 0) {
      throw new DomainError(
        'CONSTANT_INVALID',
        `${component.description} uses ${component.constant} of the resource per ${item.unit}. A constant of zero or less prices nothing.`,
      );
    }
    if (component.unitCostMinor < 0) {
      throw new DomainError('COST_INVALID', `${component.description} has a negative unit cost.`);
    }
    if (component.kind !== 'MATERIAL' && component.wastePercent !== undefined) {
      throw new DomainError(
        'WASTE_NOT_APPLICABLE',
        `Waste is what is cut off, broken and over-ordered. ${component.description} is ${component.kind.toLowerCase()}, which is not wasted — ` +
          'if the intent is lost time, that belongs in the labour constant where somebody can see it.',
      );
    }
  }

  const rate = buildRate(input.reference, input.components, ctx.auth.actorId);
  const rates = [...state.rates.filter((r) => r.reference !== input.reference), rate];

  write(ctx, {
    eventType: 'RATE_BUILDUP_CREATED',
    entity: { refType: 'MeasurementSchedule', refId: scheduleId },
    nextState: { ...record.state, rates },
  });

  return rate;
}

// --- A drawing moves --------------------------------------------------------

/**
 * A drawing is reissued.
 *
 * `AC-T-WF-03-03`. Every item measured from that drawing at the superseded
 * revision is named as needing remeasurement, and the schedule will not freeze
 * until each has been looked at. Not because every one of them has changed —
 * most will not have — but because *which* ones changed is exactly the question
 * nobody can answer three weeks later, and pricing on through a reissue is how
 * a bid goes out against a drawing that no longer exists.
 */
export function reviseDrawing(
  ctx: EngineContext,
  scheduleId: string,
  input: { drawing: string; fromRevision: string; toRevision: string },
): { affected: string[]; summary: string } {
  authorise(ctx, 'BOQ_TAKEOFF', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSchedule(ctx, scheduleId);
  assertOpen(record);

  if (input.fromRevision === input.toRevision) {
    throw new DomainError('REVISION_UNCHANGED', `${input.drawing} is already at revision ${input.toRevision}.`);
  }

  const state = stateOf(record);
  // Sorted, because this list is read out loud and checked off. Item order in
  // the schedule follows whatever order things were recorded in, which reads as
  // no order at all on a bill whose references are the reader's index.
  const affected = state.items
    .filter((item) => item.source.drawing === input.drawing && item.source.revision === input.fromRevision)
    .map((item) => item.reference)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  const raisedAt = new Date().toISOString();
  const existing = state.remeasure;
  const flags: RemeasureFlag[] = affected
    .filter((reference) => !existing.some((f) => f.reference === reference && f.drawing === input.drawing && f.status === 'OPEN'))
    .map((reference) => ({
      reference,
      drawing: input.drawing,
      fromRevision: input.fromRevision,
      toRevision: input.toRevision,
      raisedAt,
      status: 'OPEN' as const,
    }));

  // Nothing is written where nothing is affected. A drawing this schedule never
  // measured from is not a fact about this schedule, and the ledger is right to
  // refuse an event that changes no state — the answer is still returned,
  // because "nothing here came off rev B" is what the person asked.
  if (flags.length === 0) {
    return {
      affected,
      summary:
        affected.length === 0
          ? `${input.drawing} rev ${input.toRevision}: nothing in ${state.reference} was measured from rev ${input.fromRevision}.`
          : `${input.drawing} rev ${input.toRevision}: ${affected.length} item${affected.length === 1 ? '' : 's'} ` +
            'are already flagged for remeasurement against this drawing.',
    };
  }

  write(ctx, {
    eventType: 'QUANTITY_REMEASURE_REQUIRED',
    entity: { refType: 'MeasurementSchedule', refId: scheduleId },
    nextState: { ...record.state, remeasure: [...existing, ...flags] },
  });

  return {
    affected,
    summary:
      `${input.drawing} rev ${input.fromRevision} → ${input.toRevision}: ${affected.length} item${affected.length === 1 ? '' : 's'} ` +
      `measured from it and needing remeasurement — ${affected.join(', ')}.`,
  };
}

/**
 * Somebody has looked at a flagged item against the new revision.
 *
 * The quantity is optional, because "unchanged" is a real and common answer —
 * and one that has to be recorded rather than inferred from silence.
 */
export function confirmRemeasure(
  ctx: EngineContext,
  scheduleId: string,
  input: { reference: string; quantity?: number; revision: string; outcome: string },
): { quantity: number; changed: boolean } {
  authorise(ctx, 'BOQ_TAKEOFF', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSchedule(ctx, scheduleId);
  assertOpen(record);

  const state = stateOf(record);
  const flag = state.remeasure.find((f) => f.reference === input.reference && f.status === 'OPEN');
  if (!flag) {
    throw new DomainError('NOTHING_TO_REMEASURE', `${input.reference} is not flagged for remeasurement in ${state.reference}.`);
  }
  if (!input.outcome.trim()) {
    throw new DomainError('OUTCOME_REQUIRED', 'Say what the remeasurement found, even where it found nothing.');
  }

  const item = state.items.find((i) => i.reference === input.reference)!;
  const quantity = input.quantity ?? item.quantity;
  const changed = quantity !== item.quantity;

  const items = state.items.map((i) =>
    i.reference === input.reference ? { ...i, quantity, source: { ...i.source, revision: input.revision } } : i,
  );

  write(ctx, {
    eventType: 'QUANTITY_REMEASURE_REQUIRED',
    entity: { refType: 'MeasurementSchedule', refId: scheduleId },
    nextState: {
      ...record.state,
      items,
      findings: validateItems(items),
      remeasure: state.remeasure.map((f) =>
        f === flag ? { ...f, status: 'CONFIRMED' as const, outcome: input.outcome } : f,
      ),
    },
  });

  return { quantity, changed };
}

// --- Totals and uncertainty -------------------------------------------------

export type PricedItem = {
  reference: string;
  description: string;
  unit: string;
  quantity: number;
  basis: QuantityBasis;
  rateMinor?: number;
  amountMinor: number;
  priced: boolean;
};

export type ScheduleTotals = {
  reference: string;
  currency: string;
  items: PricedItem[];
  /** Direct cost only. Preliminaries, risk and OH&P are the estimate's, not this. */
  directCostMinor: number;
  byKind: Record<RateComponentKind, number>;
  unpriced: string[];
  /** What sits on a quantity that is not firm, and what share of the total that is. */
  uncertainMinor: number;
  uncertainPercent: number;
  findings: MeasurementFinding[];
  openRemeasure: string[];
  status: string;
};

function totalsOf(record: EntityRecord): ScheduleTotals {
  const state = stateOf(record);
  const rateFor = new Map(state.rates.map((rate) => [rate.reference, rate]));

  const items: PricedItem[] = state.items.map((item) => {
    const rate = rateFor.get(item.reference);
    return {
      reference: item.reference,
      description: item.description,
      unit: item.unit,
      quantity: item.quantity,
      basis: item.basis,
      rateMinor: rate?.rateMinor,
      amountMinor: rate ? Math.round(rate.rateMinor * item.quantity) : 0,
      priced: Boolean(rate),
    };
  });

  const byKind: Record<RateComponentKind, number> = { LABOUR: 0, MATERIAL: 0, PLANT: 0, SUBCONTRACT: 0 };
  for (const item of state.items) {
    const rate = rateFor.get(item.reference);
    if (!rate) continue;
    for (const kind of RATE_COMPONENT_KIND) byKind[kind] += Math.round(rate.byKind[kind] * item.quantity);
  }

  const directCostMinor = items.reduce((sum, item) => sum + item.amountMinor, 0);
  const uncertainMinor = items
    .filter((item) => UNCERTAIN_BASES.includes(item.basis))
    .reduce((sum, item) => sum + item.amountMinor, 0);

  return {
    reference: state.reference,
    currency: state.currency,
    items,
    directCostMinor,
    byKind,
    unpriced: items
      .filter((item) => !item.priced)
      .map((item) => item.reference)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    uncertainMinor,
    uncertainPercent: directCostMinor === 0 ? 0 : Number(((100 * uncertainMinor) / directCostMinor).toFixed(2)),
    findings: validateItems(state.items),
    openRemeasure: state.remeasure
      .filter((f) => f.status === 'OPEN')
      .map((f) => f.reference)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    status: state.status,
  };
}

export function scheduleTotals(ctx: EngineContext, scheduleId: string): ScheduleTotals {
  authorise(ctx, 'BOQ_TAKEOFF', 'R');
  return totalsOf(requireSchedule(ctx, scheduleId));
}

/**
 * The uncertainty report — the exception control the specification asks for.
 *
 * A tender total containing 18% provisional quantity is a different commercial
 * position from one containing none, and the difference is invisible in the
 * total. This says how much, on which lines, and why each one is not firm.
 */
export function uncertaintyReport(
  ctx: EngineContext,
  scheduleId: string,
): {
  reference: string;
  lines: Array<{ reference: string; description: string; basis: QuantityBasis; amountMinor: number; why: string }>;
  uncertainMinor: number;
  uncertainPercent: number;
  summary: string;
} {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireSchedule(ctx, scheduleId);
  const state = stateOf(record);
  const totals = totalsOf(record);

  const why: Record<QuantityBasis, string> = {
    MEASURED: '',
    PROVISIONAL: 'The work is defined and the quantity is not. It is remeasured on site, so the tender figure is not the final one.',
    APPROXIMATE: 'Measured off information the estimator did not trust enough to call firm.',
    ALLOWANCE: 'Nobody measured this. It is a sum somebody authorised.',
  };

  const lines = totals.items
    .filter((item) => UNCERTAIN_BASES.includes(item.basis))
    .map((item) => {
      const source = state.items.find((i) => i.reference === item.reference)!.source;
      return {
        reference: item.reference,
        description: item.description,
        basis: item.basis,
        amountMinor: item.amountMinor,
        why: item.basis === 'ALLOWANCE' && source.allowanceBasis ? `${why[item.basis]} Basis: ${source.allowanceBasis}.` : why[item.basis],
      };
    })
    .sort((a, b) => b.amountMinor - a.amountMinor);

  const summary =
    lines.length === 0
      ? `${totals.reference}: every quantity in it is firm.`
      : `${totals.reference}: ${totals.uncertainPercent}% of the direct cost sits on ${lines.length} ` +
        `${lines.length === 1 ? 'quantity that is' : 'quantities that are'} not firm. ` +
        'That part of the tender total is not the final figure.';

  return {
    reference: totals.reference,
    lines,
    uncertainMinor: totals.uncertainMinor,
    uncertainPercent: totals.uncertainPercent,
    summary,
  };
}

// --- The freeze -------------------------------------------------------------

/**
 * Freeze the schedule the price is built on.
 *
 * Three refusals, and each of them is a thing the schedule would otherwise be
 * asserting untruthfully: an error in the bill itself, an item nobody priced,
 * and a drawing revision nobody looked at.
 */
export function freezeSchedule(
  ctx: EngineContext,
  scheduleId: string,
  input: { reason: string },
): { contentHash: string; directCostMinor: number; frozenAt: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireSchedule(ctx, scheduleId);
  assertOpen(record);

  const state = stateOf(record);
  const totals = totalsOf(record);

  const critical = totals.findings.filter((finding) => finding.severity === 'CRITICAL');
  if (critical.length > 0) {
    throw new DomainError(
      'SCHEDULE_HAS_ERRORS',
      `${critical.length} error${critical.length === 1 ? '' : 's'} in ${state.reference}: ` +
        `${critical.map((finding) => finding.subject).join('; ')}. ` +
        'Freezing would build the price on a bill that states something untrue.',
    );
  }

  if (totals.unpriced.length > 0) {
    throw new DomainError(
      'ITEMS_UNPRICED',
      `${totals.unpriced.length} item${totals.unpriced.length === 1 ? '' : 's'} in ${state.reference} carry no rate: ` +
        `${totals.unpriced.join(', ')}. An unpriced line in a frozen schedule is priced at zero by everybody who reads it afterwards.`,
    );
  }

  if (totals.openRemeasure.length > 0) {
    throw new DomainError(
      'REMEASUREMENT_OUTSTANDING',
      `${totals.openRemeasure.length} item${totals.openRemeasure.length === 1 ? '' : 's'} were measured from a drawing that has since ` +
        `been reissued and nobody has looked at them: ${totals.openRemeasure.join(', ')}.`,
    );
  }

  if (!input.reason.trim()) {
    throw new DomainError('REASON_REQUIRED', 'Say what this schedule is being frozen for.');
  }

  const contentHash = hashEvidence(JSON.stringify({ items: state.items, rates: state.rates, currency: state.currency }));
  const frozenAt = new Date().toISOString();

  const evidence = registerEvidence(ctx, {
    type: 'MEASUREMENT_SNAPSHOT',
    hash: contentHash,
    description: `${state.reference} frozen — ${state.items.length} items, ${totals.directCostMinor / 100} direct cost`,
    linkedEntities: [{ refType: 'MeasurementSchedule', refId: scheduleId }],
  });

  write(ctx, {
    eventType: 'MEASUREMENT_FROZEN',
    entity: { refType: 'MeasurementSchedule', refId: scheduleId },
    nextState: {
      ...record.state,
      status: 'FROZEN',
      contentHash,
      frozenAt,
      frozenBy: ctx.auth.actorId,
      freezeReason: input.reason,
      directCostMinor: totals.directCostMinor,
    },
    evidenceRefs: [evidence],
  });

  return { contentHash, directCostMinor: totals.directCostMinor, frozenAt };
}

// --- Reconciliation ---------------------------------------------------------

export const MOVEMENT_KIND = ['ADDED', 'REMOVED', 'REMEASURED', 'REPRICED', 'BOTH'] as const;
export type MovementKind = (typeof MOVEMENT_KIND)[number];

export type Movement = {
  reference: string;
  description: string;
  kind: MovementKind;
  fromQuantity?: number;
  toQuantity?: number;
  fromRateMinor?: number;
  toRateMinor?: number;
  /** Signed. The effect of this movement on the direct cost. */
  deltaMinor: number;
};

export type Reconciliation = {
  from: { reference: string; directCostMinor: number };
  to: { reference: string; directCostMinor: number };
  movements: Movement[];
  deltaMinor: number;
  /** Whether the movements account for the whole difference. */
  reconciles: boolean;
  summary: string;
};

/**
 * Where the money went between two versions.
 *
 * `AC-T-WF-03-02`. The question after every reissue is *"why is it £240,000
 * more"* and the answer is normally a fortnight of somebody's time. Each
 * movement names the item, whether the quantity or the rate moved, and what it
 * did to the total — and the movements have to sum to the difference or the
 * reconciliation says so rather than presenting a list that nearly explains it.
 */
export function reconcile(ctx: EngineContext, fromScheduleId: string, toScheduleId: string): Reconciliation {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const fromRecord = requireSchedule(ctx, fromScheduleId);
  const toRecord = requireSchedule(ctx, toScheduleId);

  if (stateOf(fromRecord).currency !== stateOf(toRecord).currency) {
    throw new DomainError(
      'CURRENCY_MISMATCH',
      `${stateOf(fromRecord).reference} is in ${stateOf(fromRecord).currency} and ${stateOf(toRecord).reference} is in ` +
        `${stateOf(toRecord).currency}. A movement between two currencies is a rate decision, not a measurement one.`,
    );
  }

  const before = totalsOf(fromRecord);
  const after = totalsOf(toRecord);
  const beforeBy = new Map(before.items.map((item) => [item.reference, item]));
  const afterBy = new Map(after.items.map((item) => [item.reference, item]));

  const movements: Movement[] = [];

  for (const item of after.items) {
    const previous = beforeBy.get(item.reference);
    if (!previous) {
      movements.push({
        reference: item.reference,
        description: item.description,
        kind: 'ADDED',
        toQuantity: item.quantity,
        toRateMinor: item.rateMinor,
        deltaMinor: item.amountMinor,
      });
      continue;
    }
    const quantityMoved = previous.quantity !== item.quantity;
    const rateMoved = previous.rateMinor !== item.rateMinor;
    if (!quantityMoved && !rateMoved) continue;
    movements.push({
      reference: item.reference,
      description: item.description,
      kind: quantityMoved && rateMoved ? 'BOTH' : quantityMoved ? 'REMEASURED' : 'REPRICED',
      fromQuantity: previous.quantity,
      toQuantity: item.quantity,
      fromRateMinor: previous.rateMinor,
      toRateMinor: item.rateMinor,
      deltaMinor: item.amountMinor - previous.amountMinor,
    });
  }

  for (const item of before.items) {
    if (afterBy.has(item.reference)) continue;
    movements.push({
      reference: item.reference,
      description: item.description,
      kind: 'REMOVED',
      fromQuantity: item.quantity,
      fromRateMinor: item.rateMinor,
      deltaMinor: -item.amountMinor,
    });
  }

  const deltaMinor = after.directCostMinor - before.directCostMinor;
  const accounted = movements.reduce((sum, movement) => sum + movement.deltaMinor, 0);
  const reconciles = accounted === deltaMinor;

  movements.sort((a, b) => Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor));

  const direction = deltaMinor === 0 ? 'unchanged' : deltaMinor > 0 ? 'up' : 'down';
  const summary = reconciles
    ? `${before.reference} → ${after.reference}: ${direction === 'unchanged' ? 'no movement' : `${direction} ${Math.abs(deltaMinor) / 100}`} ` +
      `across ${movements.length} item${movements.length === 1 ? '' : 's'}, fully accounted for.`
    : `${before.reference} → ${after.reference}: the movements account for ${accounted / 100} of a ${deltaMinor / 100} difference. ` +
      `${Math.abs(deltaMinor - accounted) / 100} is unexplained, so this reconciliation cannot be relied on.`;

  return {
    from: { reference: before.reference, directCostMinor: before.directCostMinor },
    to: { reference: after.reference, directCostMinor: after.directCostMinor },
    movements,
    deltaMinor,
    reconciles,
    summary,
  };
}

// --- The position -----------------------------------------------------------

export type MeasurementPosition = {
  schedules: Array<{
    scheduleId: string;
    reference: string;
    packageReference: string;
    title: string;
    status: string;
    items: number;
    unpriced: number;
    directCostMinor: number;
    uncertainPercent: number;
    critical: number;
    openRemeasure: number;
  }>;
  summary: string;
};

export function measurementPosition(ctx: EngineContext): MeasurementPosition {
  authorise(ctx, 'BOQ_TAKEOFF', 'R');

  const schedules = ctx.ledger.list(ctx.projectId, 'MeasurementSchedule').map((record) => {
    const state = stateOf(record);
    const totals = totalsOf(record);
    return {
      scheduleId: state.id,
      reference: state.reference,
      packageReference: state.packageReference,
      title: state.title,
      status: state.status,
      items: state.items.length,
      unpriced: totals.unpriced.length,
      directCostMinor: totals.directCostMinor,
      uncertainPercent: totals.uncertainPercent,
      critical: totals.findings.filter((finding) => finding.severity === 'CRITICAL').length,
      openRemeasure: totals.openRemeasure.length,
    };
  });

  const blocked = schedules.filter((s) => s.critical > 0 || s.unpriced > 0 || s.openRemeasure > 0).length;
  const parts = [`${schedules.length} schedule${schedules.length === 1 ? '' : 's'}`];
  if (blocked > 0) parts.push(`${blocked} that cannot be frozen yet`);

  return { schedules, summary: parts.join(', ') + '.' };
}
