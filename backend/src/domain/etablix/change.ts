import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';

/**
 * §11 — change, early warning and recovery.
 *
 * **The golden rule, verbatim: no change becomes forecast-neutral because it
 * lacks an approved quotation.**
 *
 * That is the whole module. Every commercial system in construction has the
 * same hole: a change is raised, priced, disputed, and while it is disputed it
 * is worth nothing in the forecast — because the forecast is built from
 * approved values and the change has none. So a job carrying three hundred
 * thousand pounds of instructed-but-unpriced work reports a forecast that says
 * it is on budget, right up until the month somebody agrees a number.
 *
 * Here a change carries **entitlement, probability and value as three separate
 * fields**, and the risk-adjusted exposure is on the forecast from the day it is
 * raised. A change with no quotation is not zero. It is an unpriced exposure
 * with a probability against it, and saying so is the difference between a
 * forecast and a hope.
 *
 * ## Six triggers, and each one is a different question
 *
 * §11's table is not a taxonomy for filing. Each trigger names what the agent
 * analyses and what a controlled result looks like, and they are genuinely
 * different: a customer instruction is a contractual notice question, a demand
 * variance is a capacity question, a supplier failure is a cure-and-replace
 * question. A single "variation" record with a free-text reason collapses all
 * six into the one that is easiest to write down.
 */

export const TRIGGERS = [
  {
    id: 'CUSTOMER_INSTRUCTION',
    label: 'Customer instruction',
    analysis:
      'Scope, date, location or quantity differing from the baseline, and whether the contract requires a notice within a period.',
    result: 'A draft instruction or notice, with the time, cost and service impact of it.',
    /** Whether the contract clock starts. Missing a notice period loses the entitlement. */
    noticeBearing: true,
  },
  {
    id: 'DEMAND_VARIANCE',
    label: 'Demand variance',
    analysis: 'Actual headcount, shift pattern or consumption outside the tolerance the system was sized against.',
    result: 'The capacity risk, and the resize, relocate or change options with what each costs.',
    noticeBearing: false,
  },
  {
    id: 'PROGRAMME_MOVEMENT',
    label: 'Programme movement',
    analysis:
      'A milestone or workface change altering hire duration, access, phasing or the demobilisation date.',
    result: 'The cost and dependency delta, and the sequence that mitigates it.',
    noticeBearing: true,
  },
  {
    id: 'SUPPLIER_FAILURE',
    label: 'Supplier failure',
    analysis: 'KPI, evidence, capacity, solvency or mobilisation slippage against what was contracted.',
    result: 'A cure notice, a recovery plan, an alternative supplier and the exposure if neither works.',
    noticeBearing: true,
  },
  {
    id: 'UNFORESEEN_CONDITION',
    label: 'Unforeseen condition',
    analysis: 'Ground, utility, ecology, contamination or a weather threshold being crossed.',
    result: 'A causation file, temporary controls, the technical options and the entitlement view.',
    noticeBearing: true,
  },
  {
    id: 'DESIGN_DEVELOPMENT',
    label: 'Design development',
    analysis: 'Permanent works or site layout development clashing with a temporary system already placed.',
    result: 'The spatial and interface impact, and a relocation or rework proposal.',
    noticeBearing: false,
  },
] as const;

export type TriggerId = (typeof TRIGGERS)[number]['id'];
const TRIGGER_BY_ID = new Map(TRIGGERS.map((entry) => [entry.id, entry]));

/**
 * What the change is worth being right about, kept as three separate fields.
 *
 * `entitlement` is whether it is recoverable at all under the contract.
 * `probability` is how likely that view is to hold. `valueMinor` is what it is
 * worth if it does. Collapsing them into one "expected value" hides which of
 * the three is the weak one, and it is always a different one.
 */
export const ENTITLEMENT_VIEWS = [
  { id: 'CLEAR', label: 'Clear', detail: 'The contract plainly provides for it, and the notice was given.' },
  { id: 'ARGUABLE', label: 'Arguable', detail: 'A view somebody would defend, and somebody else would resist.' },
  { id: 'WEAK', label: 'Weak', detail: 'Recoverable only if the other side chooses not to argue.' },
  { id: 'NONE', label: 'None', detail: 'ETABLIX’s own cost. Recorded because it is still a cost.' },
] as const;

export type EntitlementView = (typeof ENTITLEMENT_VIEWS)[number]['id'];

export type ChangeStatus = 'EARLY_WARNING' | 'NOTIFIED' | 'QUOTED' | 'INSTRUCTED' | 'AGREED' | 'REJECTED';

export type ServiceChange = {
  id: string;
  projectId: string;
  reference: string;
  trigger: TriggerId;
  summary: string;
  /** What is actually different from the baseline. Never "as discussed". */
  difference: string;
  status: ChangeStatus;
  entitlement: EntitlementView;
  /** 0 to 100. The probability the entitlement view holds. */
  probabilityPercent: number;
  /** What it is worth if it does. Zero is a value; absent is not. */
  valueMinor: number;
  currency: string;
  /** Set where the trigger bears a notice period and one has been given. */
  noticeGivenAt?: string;
  noticeReference?: string;
  /** The date by which a notice must be given, where the contract sets one. */
  noticeDueBy?: string;
  systemId?: string;
  raisedBy: string;
  raisedAt: string;
  history: { status: ChangeStatus; at: string; by: string; basis: string }[];
};

function changesOf(ctx: EngineContext): ServiceChange[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceChange').map((record) => record.state as unknown as ServiceChange);
}

function changeOf(ctx: EngineContext, changeId: string): ServiceChange {
  const found = changesOf(ctx).find((entry) => entry.id === changeId);
  if (!found) throw new DomainError('SERVICE_CHANGE_NOT_FOUND', 'No such change on this project', 404);
  return found;
}

/**
 * Minor units as a readable figure, for a sentence a person reads.
 *
 * A bare minor-unit integer in a sentence gets misread by a factor of a hundred
 * exactly once, expensively. The currency is on the record and is not guessed
 * here — the screen has it, and this is the magnitude.
 */
function major(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Raise a change, at whatever certainty it actually has.
 *
 * An early warning with a range and a probability is worth more than a precise
 * number nobody has yet. What is refused is silence: a change with no value and
 * no probability is a change that will sit at zero in the forecast, which is
 * the golden rule's failure exactly.
 */
export function raiseChange(
  ctx: EngineContext,
  input: {
    trigger: string;
    summary: string;
    difference: string;
    entitlement: string;
    probabilityPercent: number;
    valueMinor: number;
    currency?: string;
    noticeDueBy?: string;
    systemId?: string;
  },
): ServiceChange {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const trigger = TRIGGER_BY_ID.get(input.trigger as TriggerId);
  if (!trigger) {
    throw new DomainError(
      'SERVICE_CHANGE_TRIGGER_UNKNOWN',
      `${input.trigger} is not one of the six triggers. Each asks a different question — a customer instruction is a notice question, a demand variance is a capacity one, a supplier failure is a cure-and-replace one — and a single free-text reason collapses all six into whichever is easiest to write down.`,
      404,
    );
  }
  if (!input.summary?.trim()) {
    throw new DomainError('SERVICE_CHANGE_UNDESCRIBED', 'Say what the change is.');
  }
  if (!input.difference?.trim()) {
    throw new DomainError(
      'SERVICE_CHANGE_UNBASELINED',
      'Say what is different from the baseline. "As discussed" is not a difference, and a change that cannot name what moved cannot be valued, defended or refused.',
    );
  }
  if (!ENTITLEMENT_VIEWS.some((entry) => entry.id === input.entitlement)) {
    throw new DomainError('SERVICE_CHANGE_ENTITLEMENT_UNKNOWN', `${input.entitlement} is not an entitlement view`, 404);
  }
  if (!Number.isFinite(input.probabilityPercent) || input.probabilityPercent < 0 || input.probabilityPercent > 100) {
    throw new DomainError(
      'SERVICE_CHANGE_UNLIKELY',
      'Give the probability the entitlement view holds, between 0 and 100. A change with no probability is a change that sits at zero in the forecast until somebody agrees a number, which is the one thing this must never do.',
    );
  }
  if (!Number.isFinite(input.valueMinor) || input.valueMinor < 0) {
    throw new DomainError(
      'SERVICE_CHANGE_UNVALUED',
      'Give what it is worth if the entitlement holds. Zero is a value and it is allowed; absent is not, because absent becomes zero silently.',
    );
  }
  if (input.noticeDueBy !== undefined && !isDate(input.noticeDueBy)) {
    throw new DomainError('SERVICE_CHANGE_NOTICE_UNDATED', 'A notice period ends on a date.');
  }

  const at = new Date().toISOString();
  const record: ServiceChange = {
    id: ulid(),
    projectId: ctx.projectId,
    reference: `SCH-${String(changesOf(ctx).length + 1).padStart(3, '0')}`,
    trigger: trigger.id,
    summary: input.summary.trim(),
    difference: input.difference.trim(),
    status: 'EARLY_WARNING',
    entitlement: input.entitlement as EntitlementView,
    probabilityPercent: input.probabilityPercent,
    valueMinor: input.valueMinor,
    currency: input.currency?.trim() || 'GBP',
    ...(input.noticeDueBy ? { noticeDueBy: input.noticeDueBy.slice(0, 10) } : {}),
    ...(input.systemId ? { systemId: input.systemId } : {}),
    raisedBy: ctx.auth.actorId,
    raisedAt: at,
    history: [{ status: 'EARLY_WARNING', at, by: ctx.auth.actorId, basis: input.difference.trim() }],
  };

  write(ctx, {
    eventType: 'SERVICE_CHANGE_RAISED',
    entity: { refType: 'ServiceChange', refId: record.id },
    nextState: record,
  });
  return record;
}

/**
 * Give the contract notice.
 *
 * Separate from moving the status, because a notice is a contractual act with a
 * reference and a date, and the commonest way an entitlement is lost is that
 * everybody assumed somebody had sent one.
 */
export function giveNotice(
  ctx: EngineContext,
  input: { changeId: string; reference: string },
): ServiceChange {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = changeOf(ctx, input.changeId);
  const trigger = TRIGGER_BY_ID.get(record.trigger)!;
  if (!trigger.noticeBearing) {
    throw new DomainError(
      'SERVICE_CHANGE_NOT_NOTIFIABLE',
      `${trigger.label} does not start a contract clock. Recording a notice against it would put a formality on the file that the contract never asked for.`,
    );
  }
  if (!input.reference?.trim()) {
    throw new DomainError(
      'SERVICE_CHANGE_NOTICE_UNREFERENCED',
      'A notice has a reference — the letter, the portal entry, the email. Without one, "we notified them" is a recollection.',
    );
  }
  if (record.noticeGivenAt) return record;

  const at = new Date().toISOString();
  const updated: ServiceChange = {
    ...record,
    status: record.status === 'EARLY_WARNING' ? 'NOTIFIED' : record.status,
    noticeGivenAt: at,
    noticeReference: input.reference.trim(),
    history: [...record.history, { status: 'NOTIFIED', at, by: ctx.auth.actorId, basis: `Notice ${input.reference.trim()}` }],
  };
  write(ctx, {
    eventType: 'SERVICE_CHANGE_NOTIFIED',
    entity: { refType: 'ServiceChange', refId: record.id },
    nextState: updated,
  });
  return updated;
}

/**
 * Move the change on, and re-state what it is worth while doing it.
 *
 * The value and the probability come with the transition rather than being
 * edited separately, because a change that has moved from quoted to instructed
 * and is still carrying the early-warning guess is a change nobody re-thought.
 */
export function progressChange(
  ctx: EngineContext,
  input: {
    changeId: string;
    to: string;
    basis: string;
    valueMinor?: number;
    probabilityPercent?: number;
    entitlement?: string;
  },
): ServiceChange {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = changeOf(ctx, input.changeId);
  const order: ChangeStatus[] = ['EARLY_WARNING', 'NOTIFIED', 'QUOTED', 'INSTRUCTED', 'AGREED'];
  const target = input.to as ChangeStatus;

  if (record.status === 'AGREED' || record.status === 'REJECTED') {
    throw new DomainError(
      'SERVICE_CHANGE_CLOSED',
      `${record.reference} is ${record.status.toLowerCase()}. A change that moves after it is settled is a new change with a reference to this one.`,
    );
  }
  if (target !== 'REJECTED' && !order.includes(target)) {
    throw new DomainError('SERVICE_CHANGE_STATUS_UNKNOWN', `${input.to} is not a state a change can be in`, 404);
  }
  if (target !== 'REJECTED' && order.indexOf(target) <= order.indexOf(record.status)) {
    throw new DomainError(
      'SERVICE_CHANGE_BACKWARDS',
      `${record.reference} is already ${record.status.toLowerCase().replaceAll('_', ' ')}. A change does not go backwards without somebody deciding it did, and that decision is a rejection.`,
    );
  }
  if (!input.basis?.trim()) {
    throw new DomainError('SERVICE_CHANGE_UNREASONED', 'Say what moved it.');
  }
  // The golden rule at the point it would be broken: agreeing a change is the
  // moment its value stops being an estimate, and agreeing one still carrying
  // a probability below certainty means the number was never re-thought.
  if (target === 'AGREED' && input.probabilityPercent !== undefined && input.probabilityPercent !== 100) {
    throw new DomainError(
      'SERVICE_CHANGE_AGREED_UNCERTAIN',
      'An agreed change is certain by definition. If the probability is still below 100 it has not been agreed — it has been quoted, and the forecast should carry it as exposure rather than as value.',
    );
  }

  const at = new Date().toISOString();
  const updated: ServiceChange = {
    ...record,
    status: target,
    ...(input.valueMinor === undefined ? {} : { valueMinor: input.valueMinor }),
    ...(input.probabilityPercent === undefined
      ? target === 'AGREED'
        ? { probabilityPercent: 100 }
        : {}
      : { probabilityPercent: input.probabilityPercent }),
    ...(input.entitlement && ENTITLEMENT_VIEWS.some((entry) => entry.id === input.entitlement)
      ? { entitlement: input.entitlement as EntitlementView }
      : {}),
    history: [...record.history, { status: target, at, by: ctx.auth.actorId, basis: input.basis.trim() }],
  };

  write(ctx, {
    eventType: target === 'REJECTED' ? 'SERVICE_CHANGE_REJECTED' : 'SERVICE_CHANGE_PROGRESSED',
    entity: { refType: 'ServiceChange', refId: record.id },
    nextState: updated,
  });
  return updated;
}

// --- The position ------------------------------------------------------------------------

export type ChangeView = ServiceChange & {
  triggerLabel: string;
  analysis: string;
  result: string;
  entitlementLabel: string;
  /** Value times probability. What the forecast actually carries. */
  exposureMinor: number;
  /** True where the contract clock is running and no notice has been given. */
  noticeOutstanding: boolean;
  /** True where the notice period has already passed with nothing sent. */
  noticeLapsed: boolean;
};

export type ChangePosition = {
  changes: ChangeView[];
  triggers: typeof TRIGGERS;
  entitlements: typeof ENTITLEMENT_VIEWS;
  /** Agreed value: certain, and in the forecast at face value. */
  agreedMinor: number;
  /**
   * Everything not yet agreed, risk-adjusted. The number the golden rule exists
   * to keep on the page.
   */
  exposureMinor: number;
  /** The same exposure at face value, so the discount is visible. */
  exposureAtFaceMinor: number;
  goldenRule: string;
  statement: string;
};

export function changePosition(ctx: EngineContext, today?: string): ChangePosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const asAt = today ?? new Date().toISOString().slice(0, 10);
  const changes = changesOf(ctx).map((record): ChangeView => {
    const trigger = TRIGGER_BY_ID.get(record.trigger)!;
    const outstanding = trigger.noticeBearing && !record.noticeGivenAt;
    return {
      ...record,
      triggerLabel: trigger.label,
      analysis: trigger.analysis,
      result: trigger.result,
      entitlementLabel: ENTITLEMENT_VIEWS.find((entry) => entry.id === record.entitlement)!.label,
      exposureMinor: Math.round((record.valueMinor * record.probabilityPercent) / 100),
      noticeOutstanding: outstanding,
      noticeLapsed: Boolean(outstanding && record.noticeDueBy && record.noticeDueBy < asAt),
    };
  });

  const agreed = changes.filter((entry) => entry.status === 'AGREED');
  const live = changes.filter((entry) => entry.status !== 'AGREED' && entry.status !== 'REJECTED');

  const agreedMinor = agreed.reduce((sum, entry) => sum + entry.valueMinor, 0);
  const exposureMinor = live.reduce((sum, entry) => sum + entry.exposureMinor, 0);
  const exposureAtFaceMinor = live.reduce((sum, entry) => sum + entry.valueMinor, 0);

  return {
    changes: changes.sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)),
    triggers: TRIGGERS,
    entitlements: ENTITLEMENT_VIEWS,
    agreedMinor,
    exposureMinor,
    exposureAtFaceMinor,
    goldenRule:
      'No change becomes forecast-neutral because it lacks an approved quotation. Pending and disputed change stays visible as risk-adjusted exposure, with entitlement, probability and value kept as three separate fields.',
    statement:
      live.length === 0
        ? agreed.length === 0
          ? 'Nothing has been raised. On a live site-services operation that is unusual rather than good — a change register with nothing in it is normally a change register nobody is using.'
          : `${agreed.length} change${agreed.length === 1 ? '' : 's'} agreed and nothing pending.`
        : `${live.length} change${live.length === 1 ? '' : 's'} not yet agreed, worth ${major(exposureAtFaceMinor)} at face and ${major(exposureMinor)} risk-adjusted. None of it is zero in the forecast, whatever the quotation position is.`,
  };
}
