import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';

/**
 * CN-WF-09 and CN-WF-10 — the two commercial controls neither had.
 *
 * Most of both workflows was already built. `engines/claims.ts` takes a change
 * request to an instructed variation, values it, reconciles what was recovered
 * upstream against what was committed downstream, records delay events with
 * their evidence, runs the obligations calendar with its clause citations and
 * builds a claim evidence pack. `engines/cost.ts` runs the payment cycle, the
 * notices, the CVR and the forward cashflow. None of that is rebuilt.
 *
 * Two things were missing, and both are asked for by name in the acceptance
 * criteria of both workflows.
 *
 * **Five values, not one.** AC-CN-WF-09-03 and AC-CN-WF-10-01: submitted,
 * assessed, certified, agreed and paid stay separate. `valueVariation` recorded
 * an *agreed* figure and nothing else, which collapses the four numbers a
 * commercial argument is actually about into the one everybody already agrees
 * on. The gap between submitted and assessed is the negotiation; between
 * certified and paid is the cashflow problem; between agreed and paid is a
 * dispute. A register that holds one number can describe none of them.
 *
 * This is the same shape as CN-WF-04's claimed-against-accepted, one layer up,
 * and for the same reason: the difference between what somebody asked for and
 * what they got is the finding, and a record that keeps only the second has
 * thrown it away.
 *
 * **A deadline nobody checked.** AC-CN-WF-09-01 and AC-CN-WF-10-02 ask a
 * deadline to show its rule source, its calculation inputs and whether a person
 * has validated it. The obligations calendar already cites the clause — and
 * correctly declines to cite one on a bespoke contract, because a confident
 * citation of a clause that may not exist is worse than none. What it could not
 * show is the arithmetic: which trigger date, which calendar, how many days,
 * and whether anybody has agreed the answer.
 *
 * That matters more than it sounds. A time bar is the one deadline where being
 * wrong is unrecoverable, and "the system said the 14th" is not a defence. So a
 * derived deadline is recorded with the inputs it was computed from, and stays
 * **unvalidated** until a person says they agree — including when they say the
 * platform got it wrong, which is recorded as the correction it is rather than
 * quietly replacing the derivation.
 */

// --- Five values ------------------------------------------------------------

export const VALUE_STAGE = ['SUBMITTED', 'ASSESSED', 'CERTIFIED', 'AGREED', 'PAID'] as const;
export type ValueStage = (typeof VALUE_STAGE)[number];

export type ValueEntry = {
  stage: ValueStage;
  amountMinor: number;
  /** Time is claimed and conceded in the same steps as money. */
  timeDays?: number;
  /** How the figure was arrived at. A value with no basis is a number. */
  basis: string;
  by: string;
  at: string;
};

type ChainState = {
  id: string;
  subjectType: string;
  subjectRef: string;
  title: string;
  values: ValueEntry[];
};

function chainFor(ctx: EngineContext, subjectRef: string): ChainState | undefined {
  const record = ctx.ledger
    .list(ctx.projectId, 'ValueChain')
    .find((entry) => entry.state.subjectRef === subjectRef);
  return record ? (record.state as unknown as ChainState) : undefined;
}

export function recordValue(
  ctx: EngineContext,
  input: {
    /** What is being valued — a variation, a claim, an application. */
    subjectType: string;
    subjectRef: string;
    title: string;
    stage: ValueStage;
    amountMinor: number;
    timeDays?: number;
    basis: string;
    by: string;
  },
): {
  subjectRef: string;
  stage: ValueStage;
  amountMinor: number;
  /** Movement from the stage before it. The number the argument is about. */
  movementMinor: number;
} {
  // Certifying and agreeing are approvals; submitting and assessing are not.
  // The area's split already expresses that, so the authority follows the stage
  // rather than being one blanket permission for five different acts.
  const approving = input.stage === 'CERTIFIED' || input.stage === 'AGREED' || input.stage === 'PAID';
  authorise(ctx, 'CHANGE_VARIATION', approving ? 'A' : 'C', {
    lifecyclePhase: currentPhase(ctx),
    dataSensitivity: 'COMMERCIAL_L3',
  });

  if (!input.subjectRef.trim() || !input.title.trim()) {
    throw new DomainError('SUBJECT_REQUIRED', 'Name what is being valued and what it is.');
  }
  if (input.basis.trim().length < 10) {
    throw new DomainError(
      'BASIS_REQUIRED',
      'Say how the figure was arrived at. A value with no basis is a number, and the number is the only part anybody ' +
        'disagrees with later.',
    );
  }
  if (!input.by.trim()) {
    throw new DomainError('VALUER_REQUIRED', 'Name who put the figure forward.');
  }
  if (!Number.isFinite(input.amountMinor)) {
    throw new DomainError('AMOUNT_REQUIRED', 'A value is an amount.');
  }

  const existing = chainFor(ctx, input.subjectRef);
  const values = existing?.values ?? [];

  if (values.some((entry) => entry.stage === input.stage)) {
    throw new DomainError(
      'STAGE_ALREADY_RECORDED',
      `${input.subjectRef} already carries a ${input.stage.toLowerCase()} value. Recording a second would overwrite the ` +
        'first, and the whole point of holding five is that none of them replaces another.',
      409,
    );
  }

  // You cannot assess what nobody claimed. Every other order is legitimate —
  // contracts differ about whether agreement precedes certification, and a
  // platform that insisted on one order would be wrong on half of them.
  if (input.stage !== 'SUBMITTED' && !values.some((entry) => entry.stage === 'SUBMITTED')) {
    throw new DomainError(
      'NOTHING_SUBMITTED',
      `${input.subjectRef} has no submitted value, so there is nothing for a ${input.stage.toLowerCase()} figure to be a ` +
        'response to. Record what was claimed first, even where the claim was made verbally and the figure is your best ' +
        'record of it.',
      409,
    );
  }

  // The one financial control worth enforcing here: nobody pays more than was
  // certified. Paying less is a cashflow position and is recorded as one.
  if (input.stage === 'PAID') {
    const certified = values.find((entry) => entry.stage === 'CERTIFIED');
    if (certified && input.amountMinor > certified.amountMinor) {
      throw new DomainError(
        'PAID_ABOVE_CERTIFIED',
        `${input.subjectRef} was certified at ${certified.amountMinor} and this records ${input.amountMinor} paid. Paying ` +
          'above the certificate is either a certificate nobody recorded or a payment nobody should have made, and both ' +
          'need resolving before the ledger says otherwise.',
        409,
      );
    }
  }

  const entry: ValueEntry = {
    stage: input.stage,
    amountMinor: input.amountMinor,
    ...(input.timeDays === undefined ? {} : { timeDays: input.timeDays }),
    basis: input.basis,
    by: input.by,
    at: new Date().toISOString(),
  };

  const previous = [...values].sort(
    (a, b) => VALUE_STAGE.indexOf(a.stage) - VALUE_STAGE.indexOf(b.stage),
  ).filter((held) => VALUE_STAGE.indexOf(held.stage) < VALUE_STAGE.indexOf(input.stage)).at(-1);

  const chainId = existing?.id ?? ulid();

  write(ctx, {
    eventType: 'VALUE_STAGE_RECORDED',
    entity: { refType: 'ValueChain', refId: chainId },
    nextState: {
      id: chainId,
      projectId: ctx.projectId,
      subjectType: input.subjectType,
      subjectRef: input.subjectRef,
      title: input.title,
      values: [...values, entry],
    },
  });

  return {
    subjectRef: input.subjectRef,
    stage: input.stage,
    amountMinor: input.amountMinor,
    movementMinor: previous ? input.amountMinor - previous.amountMinor : 0,
  };
}

export type ValueChain = {
  subjectRef: string;
  subjectType: string;
  title: string;
  submittedMinor?: number;
  assessedMinor?: number;
  certifiedMinor?: number;
  agreedMinor?: number;
  paidMinor?: number;
  /** Submitted against assessed: the negotiation. */
  negotiationMinor?: number;
  /** Certified against paid: the cashflow. */
  unpaidMinor?: number;
  /** Agreed against paid: the dispute. */
  outstandingMinor?: number;
  stages: ValueEntry[];
};

function chainOf(state: ChainState): ValueChain {
  const at = (stage: ValueStage) => state.values.find((entry) => entry.stage === stage)?.amountMinor;
  const submitted = at('SUBMITTED');
  const assessed = at('ASSESSED');
  const certified = at('CERTIFIED');
  const agreed = at('AGREED');
  const paid = at('PAID');

  return {
    subjectRef: state.subjectRef,
    subjectType: state.subjectType,
    title: state.title,
    ...(submitted === undefined ? {} : { submittedMinor: submitted }),
    ...(assessed === undefined ? {} : { assessedMinor: assessed }),
    ...(certified === undefined ? {} : { certifiedMinor: certified }),
    ...(agreed === undefined ? {} : { agreedMinor: agreed }),
    ...(paid === undefined ? {} : { paidMinor: paid }),
    ...(submitted !== undefined && assessed !== undefined ? { negotiationMinor: submitted - assessed } : {}),
    ...(certified !== undefined && paid !== undefined ? { unpaidMinor: certified - paid } : {}),
    ...(agreed !== undefined && paid !== undefined ? { outstandingMinor: agreed - paid } : {}),
    stages: [...state.values].sort((a, b) => VALUE_STAGE.indexOf(a.stage) - VALUE_STAGE.indexOf(b.stage)),
  };
}

export function valueChainFor(ctx: EngineContext, subjectRef: string): ValueChain | null {
  authorise(ctx, 'CHANGE_VARIATION', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const state = chainFor(ctx, subjectRef);
  return state ? chainOf(state) : null;
}

// --- A deadline somebody checked --------------------------------------------

export type DeadlineInputs = {
  /** What started the clock. */
  triggerEvent: string;
  triggerDate: string;
  /** The period the rule allows, in the units the rule uses. */
  periodDays: number;
  /** Which calendar was counted in — the difference is often the deadline. */
  calendar: 'CALENDAR_DAYS' | 'BUSINESS_DAYS';
};

export function deriveDeadline(
  ctx: EngineContext,
  input: {
    reference: string;
    category: string;
    description: string;
    /** The clause or statute that imposes it, or the words if there is no number. */
    ruleSource: string;
    inputs: DeadlineInputs;
    dueDate: string;
    /** Whether missing it is unrecoverable. A time bar is; a renewal is not. */
    timeBarred: boolean;
  },
): { deadlineId: string; reference: string; dueDate: string; validated: false } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.ruleSource.trim()) {
    throw new DomainError(
      'RULE_SOURCE_REQUIRED',
      'Name what imposes the deadline — the clause, the statute, or the words of a bespoke term. A contract administrator ' +
        'challenged on a date answers with a clause, not with "the system said so".',
    );
  }
  if (Number.isNaN(Date.parse(input.inputs.triggerDate)) || Number.isNaN(Date.parse(input.dueDate))) {
    throw new DomainError('DEADLINE_DATES_REQUIRED', 'A derived deadline carries the date it ran from and the date it falls.');
  }
  if (!(input.inputs.periodDays > 0)) {
    throw new DomainError('PERIOD_REQUIRED', 'A period of zero days is not a period.');
  }
  if (!input.inputs.triggerEvent.trim()) {
    throw new DomainError('TRIGGER_REQUIRED', 'Say what started the clock.');
  }

  const deadlineId = ulid();

  write(ctx, {
    eventType: 'NOTICE_DEADLINE_DERIVED',
    entity: { refType: 'NoticeDeadline', refId: deadlineId },
    nextState: {
      id: deadlineId,
      projectId: ctx.projectId,
      reference: input.reference,
      category: input.category,
      description: input.description,
      ruleSource: input.ruleSource,
      inputs: input.inputs,
      dueDate: input.dueDate.slice(0, 10),
      timeBarred: input.timeBarred,
      // Unvalidated until a person says otherwise. A time bar is the one
      // deadline where being wrong is unrecoverable.
      validated: false,
      derivedAt: new Date().toISOString(),
      derivedBy: ctx.auth.actorId,
    },
  });

  return { deadlineId, reference: input.reference, dueDate: input.dueDate.slice(0, 10), validated: false };
}

export function validateDeadline(
  ctx: EngineContext,
  deadlineId: string,
  input: {
    agrees: boolean;
    /** Required where the person disagrees: the date they say it is. */
    correctedDueDate?: string;
    note: string;
    validatedBy: string;
  },
): { reference: string; dueDate: string; corrected: boolean } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'NoticeDeadline', refId: deadlineId });
  if (!record) throw new DomainError('DEADLINE_NOT_FOUND', `No deadline ${deadlineId}`, 404);
  if (record.state.validated === true) {
    throw new DomainError('ALREADY_VALIDATED', `${String(record.state.reference)} has already been validated.`);
  }
  if (!input.note.trim() || !input.validatedBy.trim()) {
    throw new DomainError(
      'VALIDATION_UNSIGNED',
      'Say who checked it and what they checked it against. A validation with no name on it is the derivation with a tick.',
    );
  }

  if (!input.agrees) {
    if (!input.correctedDueDate || Number.isNaN(Date.parse(input.correctedDueDate))) {
      throw new DomainError(
        'CORRECTION_REQUIRED',
        'If the derived date is wrong, say what the right one is. Marking it wrong and leaving it there is worse than the ' +
          'derivation, because now nobody knows which date to work to.',
      );
    }
  }

  const derived = String(record.state.dueDate);
  const dueDate = input.agrees ? derived : input.correctedDueDate!.slice(0, 10);

  write(ctx, {
    eventType: 'NOTICE_DEADLINE_VALIDATED',
    entity: { refType: 'NoticeDeadline', refId: deadlineId },
    nextState: {
      ...record.state,
      validated: true,
      // The derivation is kept whatever the person decided: a correction is a
      // fact about the platform's rule as well as about the date, and the
      // pattern of corrections is how a wrong rule gets found.
      derivedDueDate: derived,
      dueDate,
      validation: {
        agrees: input.agrees,
        note: input.note,
        validatedBy: input.validatedBy,
        at: new Date().toISOString(),
        recordedBy: ctx.auth.actorId,
      },
    },
  });

  return { reference: String(record.state.reference), dueDate, corrected: !input.agrees };
}

// --- The position -----------------------------------------------------------

export type CommercialControlPosition = {
  chains: ValueChain[];
  /** Where what was claimed and what was assessed are furthest apart. */
  largestNegotiations: Array<{ subjectRef: string; title: string; submittedMinor: number; assessedMinor: number; gapMinor: number }>;
  /** Certified and not paid. The cashflow position, by subject. */
  unpaid: Array<{ subjectRef: string; title: string; unpaidMinor: number }>;
  deadlines: Array<{
    reference: string;
    category: string;
    dueDate: string;
    ruleSource: string;
    timeBarred: boolean;
    validated: boolean;
    /** Set where a person disagreed with the platform's arithmetic. */
    derivedDueDate?: string;
  }>;
  /** Time-barred deadlines nobody has checked. The ones that cannot be recovered. */
  unvalidatedTimeBars: string[];
  summary: string;
};

export function commercialControlPosition(ctx: EngineContext): CommercialControlPosition {
  authorise(ctx, 'CHANGE_VARIATION', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const chains = ctx.ledger
    .list(ctx.projectId, 'ValueChain')
    .map((record) => chainOf(record.state as unknown as ChainState));

  const largestNegotiations = chains
    .filter((chain) => chain.submittedMinor !== undefined && chain.assessedMinor !== undefined)
    .map((chain) => ({
      subjectRef: chain.subjectRef,
      title: chain.title,
      submittedMinor: chain.submittedMinor!,
      assessedMinor: chain.assessedMinor!,
      gapMinor: chain.submittedMinor! - chain.assessedMinor!,
    }))
    .sort((a, b) => Math.abs(b.gapMinor) - Math.abs(a.gapMinor));

  const unpaid = chains
    .filter((chain) => (chain.unpaidMinor ?? 0) > 0)
    .map((chain) => ({ subjectRef: chain.subjectRef, title: chain.title, unpaidMinor: chain.unpaidMinor! }));

  const unvalidatedTimeBars: string[] = [];
  const deadlines = ctx.ledger.list(ctx.projectId, 'NoticeDeadline').map((record) => {
    const validated = record.state.validated === true;
    const timeBarred = record.state.timeBarred === true;
    if (timeBarred && !validated) unvalidatedTimeBars.push(String(record.state.reference));
    return {
      reference: String(record.state.reference),
      category: String(record.state.category),
      dueDate: String(record.state.dueDate),
      ruleSource: String(record.state.ruleSource),
      timeBarred,
      validated,
      ...(record.state.derivedDueDate && record.state.derivedDueDate !== record.state.dueDate
        ? { derivedDueDate: String(record.state.derivedDueDate) }
        : {}),
    };
  });

  const parts: string[] = [];
  if (chains.length > 0) parts.push(`${chains.length} valued item${chains.length === 1 ? '' : 's'}`);
  if (unpaid.length > 0) parts.push(`${unpaid.length} certified and unpaid`);
  if (unvalidatedTimeBars.length > 0) {
    parts.push(`${unvalidatedTimeBars.length} time-barred deadline(s) nobody has checked`);
  }
  if (parts.length === 0) parts.push('Nothing valued and no deadline derived');

  return { chains, largestNegotiations, unpaid, deadlines, unvalidatedTimeBars, summary: parts.join(', ') + '.' };
}
