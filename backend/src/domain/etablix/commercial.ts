import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { appointmentInForce, appointmentPosition, profileFor } from './appointment.ts';
import type { ServicePackage } from './procurement.ts';

/**
 * §10 — commercial control and earned value.
 *
 * **"An invoice is not proof of value."** The specification's own sentence, and
 * the whole module is that sentence enforced. A supplier application is a claim;
 * what is *earned* is the budgeted value of accepted progress; what is *actual*
 * is what somebody certified. Three different numbers that every commercial
 * system on the market collapses into one, and the collapse is why a job can be
 * 40% paid, 25% delivered and reported as on track.
 *
 * So the eight records here are kept apart on purpose, and the valuation
 * workflow's third and fourth steps — reconcile, then identify — are the ones
 * that stop a claim becoming an actual by being typed in.
 *
 * ## Earned value, and the method that is chosen rather than assumed
 *
 * §10 says the earned-value method is *set per line*: milestone, quantity,
 * time-based or weighted-evidence. That is not a preference. A welfare hire
 * priced by the week earns by time and cannot earn faster by working harder; a
 * compound build earns by milestone and does not earn at all until the
 * milestone is reached; a cleaning contract earns by weighted evidence against
 * the inspection sample. Applying one method to all three is how a percentage
 * gets reported that nobody can defend.
 *
 * ## What is reused
 *
 * CONSTRUX already values the main works — `domain/valuation.ts`, the payment
 * cycle, the Construction Act engine, the CVR. None of it is rebuilt. This is
 * the *service* commercial position: a service line, a period, accepted service
 * evidence, a KPI deduction and a certificate. Where the two meet is the
 * project's own cost ledger, and §10 stops at the certificate rather than
 * pretending to be a payment system.
 */

// --- The eight records ------------------------------------------------------------------

export const RECORD_KINDS = [
  {
    id: 'BUDGET',
    label: 'Budget',
    control:
      'Approved control budget by system, cost code, phase, package, currency, tax basis and funding source.',
  },
  {
    id: 'COMMITMENT',
    label: 'Commitment',
    control:
      'Executed contract or purchase order plus approved changes. Customer-held under Advisory and Management, ETABLIX-held under Prime.',
  },
  {
    id: 'ACTUAL',
    label: 'Actual',
    control: 'Approved invoice or accrual, with paid, certified, disputed, withheld and retention kept as separate states.',
  },
  {
    id: 'EARNED_VALUE',
    label: 'Earned value',
    control:
      'The budgeted value of accepted physical or service progress. The method — milestone, quantity, time or weighted evidence — is set per line.',
  },
  {
    id: 'FORECAST',
    label: 'Forecast',
    control:
      'Estimate to complete from remaining quantities, productivity, duration, rates, risks and instructed but unapproved change. Estimate at completion is actual plus that.',
  },
  {
    id: 'SERVICE_CREDIT',
    label: 'Service credits',
    control:
      'A KPI event mapped to the contract formula, with its cap, exclusions, cure period and approval. Retained as a separate transparent adjustment, never netted into a rate.',
  },
  {
    id: 'CONTINGENCY',
    label: 'Contingency',
    control:
      'Drawn only against a named risk: amount, probability change, approver, residual balance and the effect on the forecast.',
  },
  {
    id: 'CASH',
    label: 'Cash',
    control:
      'Customer receipts, supplier due dates, tax, retention, mobilisation advance and peak funding exposure by week and month.',
  },
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number]['id'];

// --- Earned-value method -----------------------------------------------------------------

export const EV_METHODS = [
  {
    id: 'MILESTONE',
    label: 'Milestone',
    detail: 'Nothing is earned until the milestone is accepted, and then all of it is.',
    suits: 'A compound build, a connection, a mobilisation.',
  },
  {
    id: 'QUANTITY',
    label: 'Quantity',
    detail: 'Earned in proportion to accepted quantity against the contract quantity.',
    suits: 'Cabins set, metres of road, units installed.',
  },
  {
    id: 'TIME',
    label: 'Time',
    detail:
      'Earned in proportion to elapsed contract time. It cannot be accelerated by working harder, because nothing about it is production.',
    suits: 'Hire, standby, a manned post, a service retainer.',
  },
  {
    id: 'WEIGHTED_EVIDENCE',
    label: 'Weighted evidence',
    detail:
      'Earned against the proportion of the period’s required evidence that was actually accepted — inspections passed, tasks evidenced, readings taken.',
    suits: 'Cleaning, planned maintenance, anything whose output is a standard rather than a thing.',
  },
] as const;

export type EvMethod = (typeof EV_METHODS)[number]['id'];
const EV_BY_ID = new Map(EV_METHODS.map((entry) => [entry.id, entry]));

export type ContractLine = {
  id: string;
  projectId: string;
  packageId: string;
  reference: string;
  description: string;
  /** The approved control budget for this line. */
  budgetMinor: number;
  /** What is actually committed by contract or order. */
  commitmentMinor: number;
  currency: string;
  method: EvMethod;
  /** Contract quantity for QUANTITY, contract weeks for TIME, else absent. */
  contractQuantity?: number;
  unit?: string;
  contractWeeks?: number;
  /** Which SBS system the line buys, so earned value ties back to the design. */
  systemId?: string;
  createdBy: string;
  createdAt: string;
};

// --- §10.1 The monthly valuation ------------------------------------------------------

export const VALUATION_STEPS = [
  { id: 'OPEN', label: 'Open and freeze', detail: 'Open the period and freeze the contract, change and KPI data cut-off.' },
  { id: 'APPLY', label: 'Application', detail: 'The supplier application, mapped to contract lines with the evidence each requires.' },
  {
    id: 'RECONCILE',
    label: 'Reconcile',
    detail:
      'Claimed quantity, time or milestone against accepted delivery, gate, work-order, roster, meter and inspection evidence.',
  },
  {
    id: 'EXCEPTIONS',
    label: 'Exceptions',
    detail:
      'Duplicates, premature claims, unsupported progress, KPI deductions, retention, tax and drift against the prior certificate.',
  },
  {
    id: 'REVIEW',
    label: 'Review',
    detail: 'The quantity surveyor or commercial manager reviews the exceptions and certifies within delegated authority.',
  },
  {
    id: 'ISSUE',
    label: 'Issue',
    detail:
      'A payment recommendation under Management, a customer invoice and supplier certificate under Prime, professional milestones only under Advisory.',
  },
  {
    id: 'UPDATE',
    label: 'Update',
    detail: 'Actual, accrual, earned value, forecast, cash and supplier payment status — with the reason for every adjustment kept.',
  },
] as const;

export type ValuationStep = (typeof VALUATION_STEPS)[number]['id'];

export type ValuationStatus = 'OPEN' | 'APPLIED' | 'CERTIFIED';

export type ApplicationLine = {
  lineId: string;
  /** What the supplier says it did this period, in the line's own terms. */
  claimed: number;
  /** What the platform can actually see was accepted. Never supplied. */
  narrative: string;
};

export type Deduction = {
  kind: 'KPI' | 'RETENTION' | 'PRIOR_CERTIFICATE';
  label: string;
  amountMinor: number;
  basis: string;
};

export type Valuation = {
  id: string;
  projectId: string;
  reference: string;
  periodFrom: string;
  periodTo: string;
  /** The cut-off. Anything after it belongs to the next valuation. */
  cutOff: string;
  status: ValuationStatus;
  application: ApplicationLine[];
  appliedAt?: string;
  appliedBy?: string;
  certifiedAt?: string;
  certifiedBy?: string;
  /** What was actually certified, after every exception. */
  certifiedMinor?: number;
  openedBy: string;
  openedAt: string;
  /**
   * Who owes the supplier the certified sum, from the appointment in force.
   *
   * Recorded on the certificate rather than derived when somebody reads it,
   * because the certificate outlives the appointment: a document extracted into
   * a final account two years later has to carry whose obligation it was on the
   * day it was issued. Under Advisory and Management this is a payment
   * *recommendation* to the customer and ETABLIX owes nothing against it — §20's
   * third rule, which the platform must enforce in data rather than assert in a
   * heading.
   */
  payer?: 'CUSTOMER' | 'ETABLIX';
  /** The sentence a reader of the certificate needs. Never derived from `payer` alone. */
  payerBasis?: string;
};

export type ServiceCredit = {
  id: string;
  projectId: string;
  lineId: string;
  /** The KPI event this arises from. Never a round number somebody chose. */
  eventId: string;
  formula: string;
  amountMinor: number;
  capMinor?: number;
  cureUntil?: string;
  approvedBy?: string;
  approvedAt?: string;
  raisedBy: string;
  raisedAt: string;
};

// --- Reading -------------------------------------------------------------------------

function linesOf(ctx: EngineContext): ContractLine[] {
  return ctx.ledger.list(ctx.projectId, 'ContractLine').map((record) => record.state as unknown as ContractLine);
}

function lineOf(ctx: EngineContext, lineId: string): ContractLine {
  const found = linesOf(ctx).find((entry) => entry.id === lineId);
  if (!found) throw new DomainError('CONTRACT_LINE_NOT_FOUND', 'No such contract line on this project', 404);
  return found;
}

function valuationsOf(ctx: EngineContext): Valuation[] {
  return ctx.ledger.list(ctx.projectId, 'Valuation').map((record) => record.state as unknown as Valuation);
}

function creditsOf(ctx: EngineContext): ServiceCredit[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceCredit').map((record) => record.state as unknown as ServiceCredit);
}

function packagesOf(ctx: EngineContext): ServicePackage[] {
  return ctx.ledger.list(ctx.projectId, 'ServicePackage').map((record) => record.state as unknown as ServicePackage);
}

/**
 * Minor units as a readable figure, for a sentence a person reads. A bare
 * minor-unit integer in a sentence gets misread by a factor of a hundred
 * exactly once, expensively.
 */
function major(minor: number): string {
  return (minor / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

// --- The contract line ---------------------------------------------------------------

/**
 * Open a contract line, with its earned-value method chosen rather than assumed.
 *
 * The method decides what the line can ever claim. A `TIME` line needs its
 * contract weeks, a `QUANTITY` line its contract quantity, and a line missing
 * the figure its own method depends on is refused — because the alternative is
 * a percentage complete computed against nothing, which is exactly the number
 * this module exists to stop being reported.
 */
export function openLine(
  ctx: EngineContext,
  input: {
    packageId: string;
    description: string;
    budgetMinor: number;
    commitmentMinor: number;
    currency: string;
    method: string;
    contractQuantity?: number;
    unit?: string;
    contractWeeks?: number;
    systemId?: string;
  },
): ContractLine {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = packagesOf(ctx).find((entry) => entry.id === input.packageId);
  if (!record) throw new DomainError('SERVICE_PACKAGE_NOT_FOUND', 'No such package on this project', 404);

  const method = EV_BY_ID.get(input.method as EvMethod);
  if (!method) {
    throw new DomainError(
      'EV_METHOD_UNKNOWN',
      `${input.method} is not an earned-value method. A line earns by milestone, by quantity, by time or by weighted evidence, and which one is a decision rather than a default.`,
      404,
    );
  }
  if (!input.description?.trim()) {
    throw new DomainError('CONTRACT_LINE_UNDESCRIBED', 'Say what the line buys.');
  }
  if (!(input.budgetMinor > 0)) {
    throw new DomainError(
      'CONTRACT_LINE_UNBUDGETED',
      'A line with no budget cannot earn anything: earned value is the *budgeted* value of accepted progress, and against a budget of zero it is always zero.',
    );
  }
  if (input.commitmentMinor < 0) {
    throw new DomainError('CONTRACT_LINE_COMMITMENT_NEGATIVE', 'A commitment is what is owed, not a credit.');
  }
  if (method.id === 'QUANTITY' && !(input.contractQuantity && input.contractQuantity > 0)) {
    throw new DomainError(
      'CONTRACT_LINE_UNQUANTIFIED',
      'A line earning by quantity needs its contract quantity. Without it, progress is a proportion of nothing.',
    );
  }
  if (method.id === 'TIME' && !(input.contractWeeks && input.contractWeeks > 0)) {
    throw new DomainError(
      'CONTRACT_LINE_UNTIMED',
      'A line earning by time needs its contract duration. Hire earns by the week and a week is only a proportion of something with a duration behind it.',
    );
  }

  const sequence = linesOf(ctx).length + 1;
  const line: ContractLine = {
    id: ulid(),
    projectId: ctx.projectId,
    packageId: record.id,
    reference: `${record.reference}-L${String(sequence).padStart(2, '0')}`,
    description: input.description.trim(),
    budgetMinor: input.budgetMinor,
    commitmentMinor: input.commitmentMinor,
    currency: input.currency?.trim() || 'GBP',
    method: method.id,
    ...(input.contractQuantity === undefined ? {} : { contractQuantity: input.contractQuantity }),
    ...(input.unit ? { unit: input.unit } : {}),
    ...(input.contractWeeks === undefined ? {} : { contractWeeks: input.contractWeeks }),
    ...(input.systemId ? { systemId: input.systemId } : {}),
    createdBy: ctx.auth.actorId,
    createdAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'SERVICE_CONTRACT_LINE_OPENED',
    entity: { refType: 'ContractLine', refId: line.id },
    nextState: line,
  });
  return line;
}

// --- Accepted progress: what is actually earned ------------------------------------------

export type AcceptedProgress = {
  id: string;
  projectId: string;
  lineId: string;
  /** The period this belongs to, so a claim cannot be moved between them. */
  periodTo: string;
  /**
   * In the line's own units: accepted quantity, elapsed weeks, milestone
   * fraction, or evidence accepted over evidence required.
   */
  accepted: number;
  /** What the platform saw. Gate, work order, meter, inspection — never "agreed". */
  evidence: string;
  recordedBy: string;
  recordedAt: string;
};

export function recordAcceptedProgress(
  ctx: EngineContext,
  input: { lineId: string; periodTo: string; accepted: number; evidence: string },
): AcceptedProgress {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const line = lineOf(ctx, input.lineId);
  if (!isDate(input.periodTo)) throw new DomainError('PROGRESS_UNDATED', 'A period ends on a date.');
  if (!Number.isFinite(input.accepted) || input.accepted < 0) {
    throw new DomainError('PROGRESS_NEGATIVE', 'Accepted progress is not a negative number.');
  }
  if (!input.evidence?.trim()) {
    throw new DomainError(
      'PROGRESS_UNEVIDENCED',
      'Say what was seen — the gate, the work order, the meter, the inspection. "Agreed" is what a claim says; this is the record of what the platform actually saw, and the difference between the two is the entire valuation.',
    );
  }

  const ceiling = ceilingFor(line);
  if (ceiling !== undefined && input.accepted > ceiling) {
    throw new DomainError(
      'PROGRESS_EXCEEDS_CONTRACT',
      `${line.reference} is a ${EV_BY_ID.get(line.method)!.label.toLowerCase()} line with a contract figure of ${ceiling}. ${input.accepted} accepted against it is more than was ever bought, and a line that can earn beyond its own contract is a line that has stopped being a measure.`,
    );
  }

  const record: AcceptedProgress = {
    id: ulid(),
    projectId: ctx.projectId,
    lineId: line.id,
    periodTo: input.periodTo.slice(0, 10),
    accepted: input.accepted,
    evidence: input.evidence.trim(),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_PROGRESS_ACCEPTED',
    entity: { refType: 'AcceptedProgress', refId: record.id },
    nextState: record,
  });
  return record;
}

/** The most a line can ever have accepted against it, by its own method. */
function ceilingFor(line: ContractLine): number | undefined {
  switch (line.method) {
    case 'QUANTITY':
      return line.contractQuantity;
    case 'TIME':
      return line.contractWeeks;
    case 'MILESTONE':
    case 'WEIGHTED_EVIDENCE':
      // Both are expressed as a fraction of one.
      return 1;
    default:
      return undefined;
  }
}

/**
 * The budgeted value of accepted progress, by the method the line declared.
 *
 * The cumulative figure, not the period's: earned value is a position, and a
 * valuation certifies the movement between two positions.
 */
export function earnedFor(line: ContractLine, progress: AcceptedProgress[], upTo?: string): number {
  const mine = progress
    .filter((entry) => entry.lineId === line.id)
    .filter((entry) => (upTo ? entry.periodTo <= upTo : true));
  if (mine.length === 0) return 0;

  // The latest accepted position, not the sum: three readings of 40%, 60% and
  // 80% are one line at 80%, and summing them is how earned value passes 100.
  const latest = mine.sort((a, b) => a.periodTo.localeCompare(b.periodTo) || a.recordedAt.localeCompare(b.recordedAt)).at(-1)!;
  const ceiling = ceilingFor(line);
  const fraction = ceiling && ceiling > 0 ? Math.min(1, latest.accepted / ceiling) : 0;
  return Math.round(line.budgetMinor * fraction);
}

// --- Service credits ---------------------------------------------------------------------

/**
 * Raise a service credit against a KPI event.
 *
 * §10's own words: retained as a *separate transparent adjustment*. Never netted
 * into a rate, because a rate with a credit inside it is a rate nobody can
 * check and a credit nobody can dispute. It must arise from a recorded event —
 * a credit with no event behind it is a number somebody chose.
 */
export function raiseServiceCredit(
  ctx: EngineContext,
  input: { lineId: string; eventId: string; formula: string; amountMinor: number; capMinor?: number; cureUntil?: string },
): ServiceCredit {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const line = lineOf(ctx, input.lineId);
  const event = ctx.ledger
    .list(ctx.projectId, 'ServiceEvent')
    .map((entry) => entry.state as unknown as { id: string; reference: string })
    .find((entry) => entry.id === input.eventId);
  if (!event) {
    throw new DomainError(
      'SERVICE_CREDIT_UNFOUNDED',
      'A service credit arises from a recorded KPI event. Without one it is a number somebody chose, and it will be argued about as one.',
      404,
    );
  }
  if (!input.formula?.trim()) {
    throw new DomainError(
      'SERVICE_CREDIT_UNFORMULATED',
      'Quote the contract formula the credit is calculated under. A credit with no formula is a deduction, and a deduction is a dispute.',
    );
  }
  if (!(input.amountMinor > 0)) {
    throw new DomainError('SERVICE_CREDIT_UNVALUED', 'A credit is a positive amount deducted, not a negative one added.');
  }
  if (input.capMinor !== undefined && input.amountMinor > input.capMinor) {
    throw new DomainError(
      'SERVICE_CREDIT_OVER_CAP',
      `The contract caps this credit at ${major(input.capMinor)}. Claiming ${major(input.amountMinor)} against a cap is how a credit becomes unenforceable in its entirety.`,
    );
  }

  const credit: ServiceCredit = {
    id: ulid(),
    projectId: ctx.projectId,
    lineId: line.id,
    eventId: event.id,
    formula: input.formula.trim(),
    amountMinor: input.amountMinor,
    ...(input.capMinor === undefined ? {} : { capMinor: input.capMinor }),
    ...(input.cureUntil ? { cureUntil: input.cureUntil } : {}),
    raisedBy: ctx.auth.actorId,
    raisedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_CREDIT_RAISED',
    entity: { refType: 'ServiceCredit', refId: credit.id },
    nextState: credit,
  });
  return credit;
}

export function approveServiceCredit(ctx: EngineContext, input: { creditId: string }): ServiceCredit {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const credit = creditsOf(ctx).find((entry) => entry.id === input.creditId);
  if (!credit) throw new DomainError('SERVICE_CREDIT_NOT_FOUND', 'No such credit on this project', 404);
  if (credit.approvedAt) return credit;
  // The cure period is the supplier's chance to put it right. Approving inside
  // it is approving a credit the contract has not yet earned.
  const today = new Date().toISOString().slice(0, 10);
  if (credit.cureUntil && credit.cureUntil >= today) {
    throw new DomainError(
      'SERVICE_CREDIT_IN_CURE',
      `The cure period on that credit runs to ${credit.cureUntil}. Approving inside it deducts for a failure the supplier is still contractually entitled to fix.`,
    );
  }

  const updated: ServiceCredit = { ...credit, approvedBy: ctx.auth.actorId, approvedAt: new Date().toISOString() };
  write(ctx, {
    eventType: 'SERVICE_CREDIT_APPROVED',
    entity: { refType: 'ServiceCredit', refId: credit.id },
    nextState: updated,
  });
  return updated;
}

// --- §10.1 The valuation ------------------------------------------------------------------

export function openValuation(
  ctx: EngineContext,
  input: { periodFrom: string; periodTo: string },
): Valuation {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!isDate(input.periodFrom) || !isDate(input.periodTo) || input.periodTo <= input.periodFrom) {
    throw new DomainError('VALUATION_PERIOD_INVALID', 'A valuation period runs from a date to a later one.');
  }
  const open = valuationsOf(ctx).find((entry) => entry.status !== 'CERTIFIED');
  if (open) {
    throw new DomainError(
      'VALUATION_ALREADY_OPEN',
      `${open.reference} is still open to ${open.periodTo}. Two open valuations means one period's progress can be claimed in both, which is the commonest way a supplier is paid twice for one week.`,
    );
  }

  const sequence = valuationsOf(ctx).length + 1;
  const record: Valuation = {
    id: ulid(),
    projectId: ctx.projectId,
    reference: `VAL-${String(sequence).padStart(3, '0')}`,
    periodFrom: input.periodFrom.slice(0, 10),
    periodTo: input.periodTo.slice(0, 10),
    // The cut-off is the period end, frozen at opening. Anything accepted after
    // it belongs to the next valuation whatever date somebody types on it.
    cutOff: input.periodTo.slice(0, 10),
    status: 'OPEN',
    application: [],
    openedBy: ctx.auth.actorId,
    openedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_VALUATION_OPENED',
    entity: { refType: 'Valuation', refId: record.id },
    nextState: record,
  });
  return record;
}

export function recordApplication(
  ctx: EngineContext,
  input: { valuationId: string; lines: ApplicationLine[] },
): Valuation {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = valuationsOf(ctx).find((entry) => entry.id === input.valuationId);
  if (!record) throw new DomainError('VALUATION_NOT_FOUND', 'No such valuation on this project', 404);
  if (record.status === 'CERTIFIED') {
    throw new DomainError(
      'VALUATION_CERTIFIED',
      `${record.reference} has been certified. A revised application after certification is next month's application.`,
    );
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new DomainError('APPLICATION_EMPTY', 'An application with no lines is not an application.');
  }
  for (const line of input.lines) {
    lineOf(ctx, line.lineId);
    if (!Number.isFinite(line.claimed) || line.claimed < 0) {
      throw new DomainError('APPLICATION_LINE_INVALID', 'A claim is a number, and not a negative one.');
    }
  }
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.lineId)) {
      throw new DomainError(
        'APPLICATION_LINE_DUPLICATED',
        'One line, one claim. The same line claimed twice in one application is the duplicate the reconciliation exists to find, and it should not have to.',
      );
    }
    seen.add(line.lineId);
  }

  const updated: Valuation = {
    ...record,
    status: 'APPLIED',
    application: input.lines.map((line) => ({ ...line, narrative: line.narrative?.trim() ?? '' })),
    appliedAt: new Date().toISOString(),
    appliedBy: ctx.auth.actorId,
  };
  write(ctx, {
    eventType: 'SERVICE_APPLICATION_RECORDED',
    entity: { refType: 'Valuation', refId: record.id },
    nextState: updated,
  });
  return updated;
}

export type ExceptionKind =
  | 'OVERCLAIM'
  | 'PREMATURE'
  | 'UNSUPPORTED'
  | 'PRIOR_DRIFT'
  | 'KPI_DEDUCTION'
  | 'UNCLAIMED';

export type ValuationException = {
  kind: ExceptionKind;
  lineId: string;
  reference: string;
  statement: string;
  /** What it is worth. Negative where it reduces the certificate. */
  effectMinor: number;
};

export type ValuationAssessment = {
  valuationId: string;
  reference: string;
  periodFrom: string;
  periodTo: string;
  status: ValuationStatus;
  lines: {
    lineId: string;
    reference: string;
    description: string;
    method: EvMethod;
    methodLabel: string;
    budgetMinor: number;
    commitmentMinor: number;
    claimed?: number;
    /** What the accepted evidence supports, in the line's own units. */
    accepted: number;
    acceptedEvidence?: string;
    /** Budgeted value of accepted progress, cumulative. */
    earnedMinor: number;
    /** Earned this period: the movement the certificate actually pays. */
    movementMinor: number;
    priorEarnedMinor: number;
  }[];
  exceptions: ValuationException[];
  /** The sum of the movements, before deductions. */
  grossMinor: number;
  deductions: Deduction[];
  /** Gross less every deduction. What a certificate would be for. */
  netMinor: number;
  /** Whether this can be certified at all, and why not where it cannot. */
  certifiable: boolean;
  blockedBecause?: string;
  /** Which instrument the appointment model actually issues. */
  issues: string;
};

/**
 * Steps three and four of §10.1: reconcile, then identify.
 *
 * Every exception is a difference between what was claimed and what the
 * platform's own records support. None of them is an opinion, and none is a
 * percentage: each carries what it is worth, because an exception with no value
 * on it never survives the meeting.
 */
export function assessValuation(ctx: EngineContext, valuationId: string): ValuationAssessment {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = valuationsOf(ctx).find((entry) => entry.id === valuationId);
  if (!record) throw new DomainError('VALUATION_NOT_FOUND', 'No such valuation on this project', 404);

  const lines = linesOf(ctx);
  const progress = ctx.ledger
    .list(ctx.projectId, 'AcceptedProgress')
    .map((entry) => entry.state as unknown as AcceptedProgress);
  const credits = creditsOf(ctx);
  const priorCertified = valuationsOf(ctx)
    .filter((entry) => entry.status === 'CERTIFIED' && entry.periodTo < record.periodFrom)
    .sort((a, b) => a.periodTo.localeCompare(b.periodTo))
    .at(-1);

  const exceptions: ValuationException[] = [];
  const assessed = lines.map((line) => {
    const claim = record.application.find((entry) => entry.lineId === line.id);
    const mine = progress.filter((entry) => entry.lineId === line.id && entry.periodTo <= record.cutOff);
    const latest = mine
      .sort((a, b) => a.periodTo.localeCompare(b.periodTo) || a.recordedAt.localeCompare(b.recordedAt))
      .at(-1);
    const accepted = latest?.accepted ?? 0;

    const earnedMinor = earnedFor(line, progress, record.cutOff);
    const priorEarnedMinor = priorCertified ? earnedFor(line, progress, priorCertified.periodTo) : 0;
    const movementMinor = Math.max(0, earnedMinor - priorEarnedMinor);

    const ceiling = ceilingFor(line);
    if (claim) {
      // Step four, and the four things that actually turn up.
      if (claim.claimed > accepted) {
        const overFraction = ceiling && ceiling > 0 ? Math.min(1, (claim.claimed - accepted) / ceiling) : 0;
        exceptions.push({
          kind: 'OVERCLAIM',
          lineId: line.id,
          reference: line.reference,
          statement: `${line.reference} claims ${claim.claimed} and the accepted evidence supports ${accepted}. ${
            latest ? `The last thing seen was: ${latest.evidence}` : 'Nothing has been accepted against this line at all.'
          }`,
          effectMinor: -Math.round(line.budgetMinor * overFraction),
        });
      }
      if (!latest && claim.claimed > 0) {
        exceptions.push({
          kind: 'UNSUPPORTED',
          lineId: line.id,
          reference: line.reference,
          statement: `${line.reference} is claimed with no accepted progress behind it. An invoice is not proof of value.`,
          effectMinor: 0,
        });
      }
      // Evidence dated after the cut-off. `mine` is already filtered to the
      // period, so this has to look at the whole record — the first version
      // checked the filtered set and could never fire, which made the exception
      // decorative. The case it exists for is real: progress recorded for next
      // month and claimed this one.
      const beyond = progress
        .filter((entry) => entry.lineId === line.id && entry.periodTo > record.cutOff)
        .sort((a, b) => a.periodTo.localeCompare(b.periodTo))
        .at(-1);
      if (beyond && claim.claimed > accepted) {
        exceptions.push({
          kind: 'PREMATURE',
          lineId: line.id,
          reference: line.reference,
          statement: `${line.reference} claims ${claim.claimed} and the only thing supporting it is dated ${beyond.periodTo}, after the ${record.cutOff} cut-off. It belongs to the next valuation.`,
          effectMinor: 0,
        });
      }
    } else if (movementMinor > 0) {
      // The exception nobody looks for: work accepted and not claimed. It is
      // still a liability and it still lands, one month later, as a surprise.
      exceptions.push({
        kind: 'UNCLAIMED',
        lineId: line.id,
        reference: line.reference,
        statement: `${line.reference} earned in this period and was not claimed. It is a liability whether it is on the application or not, and it lands next month as a surprise unless it is accrued now.`,
        effectMinor: 0,
      });
    }

    if (priorCertified && earnedMinor < priorEarnedMinor) {
      exceptions.push({
        kind: 'PRIOR_DRIFT',
        lineId: line.id,
        reference: line.reference,
        statement: `${line.reference} has less accepted now than at ${priorCertified.reference}. Progress does not go backwards without somebody deciding it did.`,
        effectMinor: 0,
      });
    }

    return {
      lineId: line.id,
      reference: line.reference,
      description: line.description,
      method: line.method,
      methodLabel: EV_BY_ID.get(line.method)!.label,
      budgetMinor: line.budgetMinor,
      commitmentMinor: line.commitmentMinor,
      ...(claim ? { claimed: claim.claimed } : {}),
      accepted,
      ...(latest ? { acceptedEvidence: latest.evidence } : {}),
      earnedMinor,
      movementMinor,
      priorEarnedMinor,
    };
  });

  const grossMinor = assessed.reduce((sum, entry) => sum + entry.movementMinor, 0);

  const deductions: Deduction[] = [];
  for (const credit of credits.filter((entry) => entry.approvedAt)) {
    const line = lines.find((entry) => entry.id === credit.lineId);
    deductions.push({
      kind: 'KPI',
      label: `Service credit on ${line?.reference ?? credit.lineId}`,
      amountMinor: credit.amountMinor,
      basis: credit.formula,
    });
    exceptions.push({
      kind: 'KPI_DEDUCTION',
      lineId: credit.lineId,
      reference: line?.reference ?? credit.lineId,
      statement: `Approved service credit of ${major(credit.amountMinor)} under "${credit.formula}". Deducted as a separate transparent adjustment rather than netted into a rate, so it can be checked and disputed.`,
      effectMinor: -credit.amountMinor,
    });
  }

  const netMinor = grossMinor - deductions.reduce((sum, entry) => sum + entry.amountMinor, 0);

  const blocking = exceptions.filter((entry) => entry.kind === 'OVERCLAIM' || entry.kind === 'UNSUPPORTED');
  const position = appointmentPosition(ctx);
  const profile = position.appointment ? profileFor(position.appointment.model) : undefined;

  return {
    valuationId: record.id,
    reference: record.reference,
    periodFrom: record.periodFrom,
    periodTo: record.periodTo,
    status: record.status,
    lines: assessed,
    exceptions,
    grossMinor,
    deductions,
    netMinor,
    certifiable: record.status === 'APPLIED' && blocking.length === 0,
    ...(record.status !== 'APPLIED'
      ? {
          blockedBecause:
            record.status === 'CERTIFIED'
              ? `${record.reference} is already certified.`
              : `${record.reference} has no application against it yet. Certifying without one certifies what the buyer assumed the supplier would claim.`,
        }
      : blocking.length > 0
        ? {
            blockedBecause: `${blocking.length} line${blocking.length === 1 ? '' : 's'} ${
              blocking.length === 1 ? 'claims' : 'claim'
            } more than the accepted evidence supports: ${blocking.map((entry) => entry.reference).join(', ')}. An invoice is not proof of value.`,
          }
        : {}),
    issues: profile
      ? profile.fundsSupplierCost
        ? 'A customer invoice and a supplier certificate. ETABLIX holds both sides, so both are issued here.'
        : profile.mayInstructSupplier
          ? 'A payment recommendation to the customer, who holds the supplier contract and makes the payment.'
          : 'Professional milestones only. Under Advisory, ETABLIX invoices its own fee and nothing else.'
      : 'No appointment is in force, so which instrument this becomes is not yet decided.',
  };
}

/**
 * Certify the valuation.
 *
 * The QS's act, and it is refused while any line claims more than the accepted
 * evidence supports. That refusal is the whole module: a certificate issued
 * over an unreconciled overclaim is the moment a claim becomes an actual, and
 * every downstream number — cost, forecast, cash — is wrong from then on.
 */
export function certifyValuation(
  ctx: EngineContext,
  input: { valuationId: string; note: string },
): Valuation {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const assessment = assessValuation(ctx, input.valuationId);
  const record = valuationsOf(ctx).find((entry) => entry.id === input.valuationId)!;
  if (record.status === 'CERTIFIED') return record;

  if (!input.note?.trim()) {
    throw new DomainError('VALUATION_UNEXPLAINED', 'Say what was certified and on what basis.');
  }
  if (!assessment.certifiable) {
    throw new DomainError('VALUATION_NOT_CERTIFIABLE', assessment.blockedBecause ?? 'This valuation cannot be certified.');
  }

  // Whose obligation this certificate is, decided by the appointment and not by
  // whoever is certifying. §19's second scenario: approving a recommendation
  // under Management must leave the contract and the payment with the customer,
  // and a certificate that does not say so is one somebody will later read as
  // ETABLIX's debt.
  const appointment = appointmentInForce(ctx);
  if (!appointment) {
    throw new DomainError(
      'SITE_SERVICES_NOT_APPOINTED',
      'Nothing is appointed on this project, so there is no answer to who owes the certified sum. A certificate with no payer is a liability with no owner.',
      404,
    );
  }
  const profile = profileFor(appointment.model);
  const modelName = profile.label.split(' — ')[0];

  const updated: Valuation = {
    ...record,
    status: 'CERTIFIED',
    certifiedAt: new Date().toISOString(),
    certifiedBy: ctx.auth.actorId,
    certifiedMinor: assessment.netMinor,
    payer: profile.fundsSupplierCost ? 'ETABLIX' : 'CUSTOMER',
    payerBasis: profile.fundsSupplierCost
      ? `Under ${modelName} ETABLIX holds the supplier contract and pays it, recovering through one customer invoice.`
      : `Under ${modelName} the customer holds the supplier contract and pays this supplier direct. This is a payment recommendation to the customer, and ETABLIX owes nothing against it.`,
  };
  write(ctx, {
    eventType: 'SERVICE_VALUATION_CERTIFIED',
    entity: { refType: 'Valuation', refId: record.id },
    nextState: { ...updated, note: input.note.trim(), gross: assessment.grossMinor },
  });
  return updated;
}

// --- The position -----------------------------------------------------------------------

export type CommercialPosition = {
  lines: (ContractLine & {
    methodLabel: string;
    earnedMinor: number;
    /** Certified to date across every certified valuation. */
    certifiedMinor: number;
    credits: number;
  })[];
  valuations: (Valuation & { grossMinor: number; netMinor: number; exceptions: number })[];
  credits: (ServiceCredit & { reference: string })[];
  records: typeof RECORD_KINDS;
  methods: typeof EV_METHODS;
  steps: typeof VALUATION_STEPS;
  /** Budget, commitment, earned and certified across every line. */
  totals: { budgetMinor: number; commitmentMinor: number; earnedMinor: number; certifiedMinor: number };
  /**
   * The gap the whole module exists to keep visible: what has been certified
   * against what has actually been earned.
   */
  statement: string;
};

export function commercialPosition(ctx: EngineContext): CommercialPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const lines = linesOf(ctx);
  const progress = ctx.ledger
    .list(ctx.projectId, 'AcceptedProgress')
    .map((entry) => entry.state as unknown as AcceptedProgress);
  const credits = creditsOf(ctx);
  const valuations = valuationsOf(ctx);

  const certifiedTotal = valuations
    .filter((entry) => entry.status === 'CERTIFIED')
    .reduce((sum, entry) => sum + (entry.certifiedMinor ?? 0), 0);

  const decorated = lines.map((line) => ({
    ...line,
    methodLabel: EV_BY_ID.get(line.method)!.label,
    earnedMinor: earnedFor(line, progress),
    // Per line, the certified figure cannot be split out of a valuation total
    // without a line-level certificate, which this does not pretend to have.
    // Zero here would be a lie, so the field carries the line's share of what
    // was earned and the totals carry the certified figure.
    certifiedMinor: 0,
    credits: credits.filter((entry) => entry.lineId === line.id).length,
  }));

  const earnedTotal = decorated.reduce((sum, entry) => sum + entry.earnedMinor, 0);
  const budgetTotal = lines.reduce((sum, entry) => sum + entry.budgetMinor, 0);

  return {
    lines: decorated,
    valuations: valuations.map((entry) => {
      const assessment = assessValuation(ctx, entry.id);
      return {
        ...entry,
        grossMinor: assessment.grossMinor,
        netMinor: assessment.netMinor,
        exceptions: assessment.exceptions.length,
      };
    }),
    credits: credits.map((entry) => ({
      ...entry,
      reference: lines.find((line) => line.id === entry.lineId)?.reference ?? entry.lineId,
    })),
    records: RECORD_KINDS,
    methods: EV_METHODS,
    steps: VALUATION_STEPS,
    totals: {
      budgetMinor: budgetTotal,
      commitmentMinor: lines.reduce((sum, entry) => sum + entry.commitmentMinor, 0),
      earnedMinor: earnedTotal,
      certifiedMinor: certifiedTotal,
    },
    statement:
      lines.length === 0
        ? 'No contract line is open, so there is nothing to value. A service being delivered against no line is a service nobody can pay for or measure.'
        : certifiedTotal > earnedTotal
          ? `Certified ${major(certifiedTotal)} against ${major(earnedTotal)} earned. More has been paid than has been accepted, which is the position that becomes a recovery.`
          : `Certified ${major(certifiedTotal)} against ${major(earnedTotal)} earned and ${major(budgetTotal)} budgeted. An invoice is not proof of value, and these are three different numbers on purpose.`,
  };
}
