import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { ContractSuite } from '../engines/claims.ts';
import { clauseFor, type ClauseCitation } from '../engines/maths/contractClauses.ts';
import { reckonPeriod } from '../engines/maths/constructionAct.ts';

/**
 * Contractual correspondence: who may write it, who it has to go to, and by
 * when the other side has to answer.
 *
 * Until now the platform wrote exactly one kind of letter — a site instruction,
 * as a side effect of marking up a drawing — and nothing said what a letter was
 * for or what happened if nobody replied. On a construction project that is the
 * whole game. An early warning that reaches the wrong person is not an early
 * warning; a compensation event quotation nobody answers within two weeks is
 * *accepted*, and the party that stayed quiet has bought it.
 *
 * Three rules, and each is a fact about the contract rather than a convention.
 *
 * **The recipient is contractual, not a mailing preference.** A notice served
 * on the wrong party is not served. Every type here names the role it must go
 * to, and issuing to anybody else is refused rather than delivered with a
 * warning — a warning on a screen nobody reads is how a notice ends up invalid.
 *
 * **The response period comes from the form.** The same letter carries
 * different deadlines under NEC and JCT, and under a bespoke contract it may
 * carry none at all. Where the governing form imposes no period the answer is
 * "none", stated, rather than a default that looks like a contractual date.
 *
 * **Silence has a consequence, and it is written down.** Deemed acceptance is
 * the reason this matters: under NEC 62.6 a quotation the project manager does
 * not reply to is treated as accepted, and under 61.4 so is the event itself.
 * The position reports that as a thing that has *happened*, not as an overdue
 * item — because by then it is not outstanding, it is decided.
 */

/** Where a letter can be in its life. Answered and deemed are both closed. */
export type CorrespondenceStatus = 'ISSUED' | 'ANSWERED' | 'DEEMED_ACCEPTED' | 'CLOSED';

export type CorrespondenceType =
  | 'EARLY_WARNING'
  | 'COMPENSATION_EVENT_NOTIFICATION'
  | 'QUOTATION'
  | 'REQUEST_FOR_INFORMATION'
  | 'SITE_INSTRUCTION'
  | 'DELAY_NOTICE'
  | 'LOSS_AND_EXPENSE_NOTIFICATION'
  | 'EXTENSION_OF_TIME_APPLICATION'
  | 'DEFECT_NOTIFICATION'
  | 'GENERAL_LETTER';

/** The parties a letter can be addressed to, as the contract names them. */
export type CorrespondenceParty =
  | 'PROJECT_MANAGER'
  | 'CONTRACT_ADMINISTRATOR'
  | 'EMPLOYER'
  | 'CONTRACTOR'
  | 'DESIGNER'
  | 'SUBCONTRACTOR';

type TypeDefinition = {
  label: string;
  /** Who is entitled to send it. A site instruction from a contractor is not one. */
  senders: CorrespondenceParty[];
  /** Who it must be served on. The matrix; departing from it is refused. */
  recipients: CorrespondenceParty[];
  /**
   * Days the recipient has to answer, per governing form. `null` means the
   * form imposes no period — not that a reply is unnecessary.
   */
  responseDays: Partial<Record<ContractSuite, number | null>>;
  /** The clause category, so the letter cites the clause that imposes it. */
  clauseCategory?: string;
  /**
   * What silence means when the period runs out. `DEEMED_ACCEPTED` is the one
   * that changes the answer rather than the urgency.
   */
  onSilence: 'DEEMED_ACCEPTED' | 'OVERDUE' | 'NONE';
  /** Said in the recipient's terms, because that is who has to act on it. */
  consequence: string;
};

/**
 * The matrix.
 *
 * Deliberately narrower than "every letter a project sends". A general letter
 * exists for everything with no contractual machinery behind it, and it carries
 * no deadline precisely so that nothing here implies a contractual period the
 * contract does not impose.
 */
export const CORRESPONDENCE_TYPES: Record<CorrespondenceType, TypeDefinition> = {
  EARLY_WARNING: {
    label: 'Early warning',
    senders: ['CONTRACTOR', 'PROJECT_MANAGER'],
    recipients: ['PROJECT_MANAGER', 'CONTRACTOR'],
    // NEC 15.1: either party warns the other. The reply is attendance at a risk
    // reduction meeting rather than a letter, so the period is the meeting.
    responseDays: { NEC4: 14, JCT: null, FIDIC: null, ICHEME: null, MF1: null, BESPOKE: null },
    onSilence: 'OVERDUE',
    consequence:
      'Under NEC the project manager may instruct a risk reduction meeting. Failing to give an early warning a ' +
      'party could have given is assessed against the contractor under 63.5, so the register is the defence.',
  },
  COMPENSATION_EVENT_NOTIFICATION: {
    label: 'Compensation event notification',
    senders: ['CONTRACTOR', 'PROJECT_MANAGER'],
    recipients: ['PROJECT_MANAGER'],
    // NEC 61.4: one week to reply, and silence is deemed acceptance after the
    // contractor notifies the failure to reply.
    responseDays: { NEC4: 7, JCT: null, FIDIC: 28, ICHEME: null, MF1: null, BESPOKE: null },
    clauseCategory: 'VARIATION',
    onSilence: 'DEEMED_ACCEPTED',
    consequence:
      'NEC 61.4 — if the project manager does not reply within the period, the event is treated as a compensation ' +
      'event. Silence decides it, and it decides it against the party that stayed silent.',
  },
  QUOTATION: {
    label: 'Compensation event quotation',
    senders: ['CONTRACTOR'],
    recipients: ['PROJECT_MANAGER'],
    // NEC 62.3: two weeks to reply; 62.6 makes silence acceptance of the quote.
    responseDays: { NEC4: 14, JCT: null, FIDIC: null, ICHEME: null, MF1: null, BESPOKE: null },
    clauseCategory: 'VARIATION',
    onSilence: 'DEEMED_ACCEPTED',
    consequence:
      'NEC 62.6 — a quotation the project manager does not reply to is treated as accepted. The price and the time ' +
      'in it become the answer without anybody agreeing to them.',
  },
  REQUEST_FOR_INFORMATION: {
    label: 'Request for information',
    senders: ['CONTRACTOR', 'SUBCONTRACTOR'],
    recipients: ['DESIGNER', 'CONTRACT_ADMINISTRATOR', 'PROJECT_MANAGER'],
    // No standard form fixes an RFI period; it is a project protocol, and the
    // platform's own default is stated as such rather than dressed as a term.
    responseDays: { NEC4: null, JCT: null, FIDIC: null, ICHEME: null, MF1: null, BESPOKE: null },
    onSilence: 'OVERDUE',
    consequence:
      'No standard form imposes a period for an answer. What a late answer does impose is delay, and the design ' +
      'delay exposure prices it against the contract damages rate.',
  },
  SITE_INSTRUCTION: {
    label: 'Site instruction',
    senders: ['CONTRACT_ADMINISTRATOR', 'PROJECT_MANAGER'],
    recipients: ['CONTRACTOR'],
    responseDays: { NEC4: null, JCT: null, FIDIC: null, ICHEME: null, MF1: null, BESPOKE: null },
    clauseCategory: 'VARIATION',
    onSilence: 'NONE',
    consequence:
      'An instruction is complied with rather than answered. Whether it is a variation, and what it is worth, is ' +
      'the change control question rather than a correspondence one.',
  },
  DELAY_NOTICE: {
    label: 'Notice of delay',
    senders: ['CONTRACTOR'],
    recipients: ['CONTRACT_ADMINISTRATOR', 'PROJECT_MANAGER'],
    responseDays: { JCT: null, NEC4: null, FIDIC: 42, ICHEME: null, MF1: null, BESPOKE: null },
    clauseCategory: 'EXTENSION_OF_TIME',
    onSilence: 'OVERDUE',
    consequence:
      'The notice protects the claim; the assessment is a separate act. Under FIDIC the engineer responds within ' +
      'forty-two days of the fully detailed claim.',
  },
  LOSS_AND_EXPENSE_NOTIFICATION: {
    label: 'Loss and expense notification',
    senders: ['CONTRACTOR'],
    recipients: ['CONTRACT_ADMINISTRATOR', 'EMPLOYER'],
    responseDays: { JCT: 28, NEC4: null, FIDIC: null, ICHEME: null, MF1: null, BESPOKE: null },
    clauseCategory: 'LOSS_AND_EXPENSE',
    onSilence: 'OVERDUE',
    consequence:
      'JCT 4.21 — the contractor notifies as soon as the effect becomes apparent, and the ascertainment follows. ' +
      'Late notification does not extinguish the claim; it makes it harder to prove.',
  },
  EXTENSION_OF_TIME_APPLICATION: {
    label: 'Extension of time application',
    senders: ['CONTRACTOR'],
    recipients: ['CONTRACT_ADMINISTRATOR', 'PROJECT_MANAGER', 'EMPLOYER'],
    // JCT 2.28.2: twelve weeks from receipt of the required particulars.
    responseDays: { JCT: 84, NEC4: null, FIDIC: 42, ICHEME: null, MF1: null, BESPOKE: null },
    clauseCategory: 'EXTENSION_OF_TIME',
    onSilence: 'OVERDUE',
    consequence:
      'JCT 2.28.2 — the contract administrator has twelve weeks from the particulars. An unanswered application ' +
      'leaves the completion date unmoved and liquidated damages running against it.',
  },
  DEFECT_NOTIFICATION: {
    label: 'Notification of defect',
    senders: ['CONTRACT_ADMINISTRATOR', 'PROJECT_MANAGER', 'EMPLOYER'],
    recipients: ['CONTRACTOR', 'SUBCONTRACTOR'],
    responseDays: { NEC4: null, JCT: null, FIDIC: null, ICHEME: null, MF1: null, BESPOKE: null },
    clauseCategory: 'DLP-EXPIRY',
    onSilence: 'OVERDUE',
    consequence:
      'The defect correction period runs from notification, so the date on this letter is the date the clock ' +
      'started — which is the fact argued about when the period is said to have expired.',
  },
  GENERAL_LETTER: {
    label: 'General correspondence',
    senders: ['CONTRACTOR', 'PROJECT_MANAGER', 'CONTRACT_ADMINISTRATOR', 'EMPLOYER', 'DESIGNER', 'SUBCONTRACTOR'],
    recipients: ['CONTRACTOR', 'PROJECT_MANAGER', 'CONTRACT_ADMINISTRATOR', 'EMPLOYER', 'DESIGNER', 'SUBCONTRACTOR'],
    responseDays: { NEC4: null, JCT: null, FIDIC: null, ICHEME: null, MF1: null, BESPOKE: null },
    onSilence: 'NONE',
    consequence:
      'Nothing contractual turns on this letter. It exists so that ordinary correspondence sits in the same ' +
      'register as the letters that do, rather than in somebody’s inbox.',
  },
};

/** The governing form, or undefined where the project runs more than one. */
function governingSuite(ctx: EngineContext): ContractSuite | undefined {
  const suites = new Set(
    ctx.ledger.list(ctx.projectId, 'Contract').map((record) => String(record.state.suite ?? 'BESPOKE')),
  );
  // The same rule the obligations calendar applies: a project running a JCT main
  // contract over an NEC framework would get the wrong period for half its
  // letters, so where the forms differ nothing is derived at all.
  return suites.size === 1 ? ([...suites][0] as ContractSuite) : undefined;
}

export type ResponseRule = {
  /** Days the form allows, or null where it imposes no period. */
  days: number | null;
  /** The form the period came from. Absent where none could be determined. */
  suite?: ContractSuite;
  dueBy?: string;
  onSilence: TypeDefinition['onSilence'];
  consequence: string;
  clause?: ClauseCitation;
  /** Why there is no date, where there is none. Never left to be inferred. */
  reason?: string;
};

/**
 * What the form gives the recipient, from the date the letter was issued.
 *
 * `reckonPeriod` rather than plain addition, because periods of under seven
 * days exclude Christmas Day, Good Friday and bank holidays under s.116(3) —
 * and NEC's one-week reply period is exactly such a period.
 */
export function responseRule(
  type: CorrespondenceType,
  suite: ContractSuite | undefined,
  issuedOn: string,
): ResponseRule {
  const definition = CORRESPONDENCE_TYPES[type];

  if (!suite) {
    return {
      days: null,
      onSilence: definition.onSilence,
      consequence: definition.consequence,
      reason:
        'The project runs more than one form of contract, or none is executed, so no response period can be ' +
        'derived. A date taken from the wrong form is worse than no date, because it gets relied on.',
    };
  }

  const days = definition.responseDays[suite] ?? null;
  const clause = definition.clauseCategory ? clauseFor(suite, definition.clauseCategory) : undefined;

  if (days === null) {
    return {
      days: null,
      suite,
      onSilence: definition.onSilence === 'DEEMED_ACCEPTED' ? 'OVERDUE' : definition.onSilence,
      consequence: definition.consequence,
      ...(clause ? { clause } : {}),
      reason: `${suite} imposes no period for a reply to this letter. That is not the same as no reply being needed.`,
    };
  }

  return {
    days,
    suite,
    dueBy: reckonPeriod(issuedOn, days),
    onSilence: definition.onSilence,
    consequence: definition.consequence,
    ...(clause ? { clause } : {}),
  };
}

/**
 * Compose and issue a letter.
 *
 * The refusals are the feature. A site instruction from a contractor and an
 * early warning served on a subcontractor are both things that happen on real
 * projects and are both worth nothing, and a platform that files them anyway is
 * a filing cabinet rather than a contract system.
 */
export function issueCorrespondence(
  ctx: EngineContext,
  input: {
    type: CorrespondenceType;
    from: CorrespondenceParty;
    to: CorrespondenceParty;
    subject: string;
    body: string;
    author: string;
    /** What this letter is about, where it concerns a record already on the ledger. */
    linkedEntity?: { refType: string; refId: string };
    /** The letter as sent, so the register holds the document and not a summary. */
    evidenceHash?: string;
  },
): { correspondenceId: string; reference: string; responseDueBy?: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C');

  const definition = CORRESPONDENCE_TYPES[input.type];
  if (!definition) throw new DomainError('CORRESPONDENCE_TYPE_UNKNOWN', `${input.type} is not a letter this platform writes`);

  if (!definition.senders.includes(input.from)) {
    throw new DomainError(
      'CORRESPONDENCE_SENDER_INVALID',
      `A ${definition.label.toLowerCase()} does not come from the ${input.from.toLowerCase().replace(/_/g, ' ')}. ` +
        `Under the contract it comes from: ${definition.senders.join(', ')}.`,
    );
  }
  if (!definition.recipients.includes(input.to)) {
    // The one that matters most. A notice served on the wrong party is not
    // served, and discovering that at adjudication is discovering it too late.
    throw new DomainError(
      'CORRESPONDENCE_RECIPIENT_INVALID',
      `A ${definition.label.toLowerCase()} must be served on: ${definition.recipients.join(', ')}. ` +
        `Served on the ${input.to.toLowerCase().replace(/_/g, ' ')} it is not served at all.`,
    );
  }
  if (input.from === input.to) {
    throw new DomainError('CORRESPONDENCE_SELF_ADDRESSED', 'A letter cannot be served on the party that wrote it');
  }

  const issuedOn = new Date().toISOString().slice(0, 10);
  const rule = responseRule(input.type, governingSuite(ctx), issuedOn);

  const sequence = ctx.ledger.list(ctx.projectId, 'Correspondence').length + 1;
  const reference = formatRef(input.type === 'SITE_INSTRUCTION' ? 'SI' : 'COR', sequence);
  const correspondenceId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'CORRESPONDENCE_AS_SENT',
    // Where no document is supplied the letter's own text is the evidence, and
    // hashing it here is what makes "this is what we sent" checkable later.
    hash: input.evidenceHash ?? hashEvidence(`${reference}\n${input.subject}\n${input.body}`),
    description: `${definition.label} ${reference} — ${input.subject}`,
  });

  write(ctx, {
    eventType: 'CORRESPONDENCE_ISSUED',
    entity: { refType: 'Correspondence', refId: correspondenceId },
    nextState: {
      id: correspondenceId,
      projectId: ctx.projectId,
      reference,
      type: input.type,
      typeLabel: definition.label,
      from: input.from,
      to: input.to,
      subject: input.subject,
      body: input.body,
      issuedBy: input.author,
      issuedAt: new Date().toISOString(),
      issuedOn,
      linkedEntity: input.linkedEntity,
      responseDays: rule.days,
      responseDueBy: rule.dueBy,
      responseBasisSuite: rule.suite,
      responseBasisReason: rule.reason,
      onSilence: rule.onSilence,
      consequence: rule.consequence,
      clause: rule.clause,
      status: 'ISSUED' satisfies CorrespondenceStatus,
    },
    evidenceRefs: [evidence],
  });

  return { correspondenceId, reference, responseDueBy: rule.dueBy };
}

/**
 * Answer one.
 *
 * A reply after the period has run is recorded as a reply and as late, never
 * refused: the letter was answered, and whether the lateness matters is a
 * question about the contract rather than about the register. Where silence has
 * already decided the point the reply does not undo it — that is what deemed
 * acceptance means — so the record says both things happened.
 */
export function respondToCorrespondence(
  ctx: EngineContext,
  input: { correspondenceId: string; body: string; author: string; evidenceHash?: string },
  today = new Date().toISOString().slice(0, 10),
): { late: boolean; deemedBefore: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = ctx.ledger.require({ refType: 'Correspondence', refId: input.correspondenceId });
  if (record.state.status !== 'ISSUED') {
    throw new DomainError('CORRESPONDENCE_NOT_OPEN', `${String(record.state.reference)} has already been closed out`);
  }

  const dueBy = typeof record.state.responseDueBy === 'string' ? record.state.responseDueBy : undefined;
  const late = dueBy !== undefined && today > dueBy;
  const deemedBefore = late && record.state.onSilence === 'DEEMED_ACCEPTED';

  const evidence = registerEvidence(ctx, {
    type: 'CORRESPONDENCE_AS_SENT',
    hash: input.evidenceHash ?? hashEvidence(`${String(record.state.reference)}-reply\n${input.body}`),
    description: `Reply to ${String(record.state.reference)}`,
  });

  write(ctx, {
    eventType: 'CORRESPONDENCE_ANSWERED',
    entity: { refType: 'Correspondence', refId: input.correspondenceId },
    nextState: {
      ...record.state,
      status: (deemedBefore ? 'DEEMED_ACCEPTED' : 'ANSWERED') satisfies CorrespondenceStatus,
      responseBody: input.body,
      respondedBy: input.author,
      respondedOn: today,
      respondedLate: late,
      // Both facts, kept. A reply that arrived after the point was already
      // decided is not the same as no reply, and it is not an answer either.
      deemedAcceptedBeforeReply: deemedBefore,
    },
    evidenceRefs: [evidence],
  });

  return { late, deemedBefore };
}

export type CorrespondencePosition = {
  suite?: ContractSuite;
  suiteReason?: string;
  total: number;
  awaitingReply: number;
  overdue: number;
  /** Letters the contract has already decided by silence. Not a backlog. */
  deemedAccepted: Array<{
    reference: string;
    type: CorrespondenceType;
    subject: string;
    dueBy: string;
    daysSince: number;
    consequence: string;
  }>;
  outstanding: Array<{
    /** The record's own id, because a console has to address it to reply to it. */
    id: string;
    reference: string;
    type: CorrespondenceType;
    typeLabel: string;
    subject: string;
    to: CorrespondenceParty;
    issuedOn: string;
    dueBy?: string;
    daysRemaining?: number;
    overdue: boolean;
    onSilence: TypeDefinition['onSilence'];
    clause?: ClauseCitation;
  }>;
  summary: string;
};

/**
 * What is outstanding, what is late, and what silence has already decided.
 *
 * The separation is the point. A deemed-accepted quotation is not an overdue
 * item to chase — it is a decided one, and putting it in the same list as
 * letters that can still be answered is how the decided ones get chased and the
 * chaseable ones get missed.
 */
export function correspondencePosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): CorrespondencePosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const suite = governingSuite(ctx);
  const records = ctx.ledger.list(ctx.projectId, 'Correspondence');
  const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

  const open = records.filter((record) => record.state.status === 'ISSUED');
  const deemedAccepted: CorrespondencePosition['deemedAccepted'] = [];
  const outstanding: CorrespondencePosition['outstanding'] = [];

  for (const record of open) {
    const state = record.state;
    const dueBy = typeof state.responseDueBy === 'string' ? state.responseDueBy : undefined;
    const overdue = dueBy !== undefined && today > dueBy;

    if (overdue && state.onSilence === 'DEEMED_ACCEPTED') {
      deemedAccepted.push({
        reference: String(state.reference),
        type: state.type as CorrespondenceType,
        subject: String(state.subject),
        dueBy: dueBy!,
        daysSince: days(dueBy!, today),
        consequence: String(state.consequence),
      });
      continue;
    }

    outstanding.push({
      id: record.refId,
      reference: String(state.reference),
      type: state.type as CorrespondenceType,
      typeLabel: String(state.typeLabel),
      subject: String(state.subject),
      to: state.to as CorrespondenceParty,
      issuedOn: String(state.issuedOn),
      dueBy,
      daysRemaining: dueBy ? days(today, dueBy) : undefined,
      overdue,
      onSilence: state.onSilence as TypeDefinition['onSilence'],
      clause: state.clause as ClauseCitation | undefined,
    });
  }

  // Soonest first, and a letter with no deadline sorts last rather than first:
  // an absent date is not an urgent one.
  outstanding.sort((a, b) => {
    if (a.dueBy === b.dueBy) return a.reference < b.reference ? -1 : 1;
    if (!a.dueBy) return 1;
    if (!b.dueBy) return -1;
    return a.dueBy < b.dueBy ? -1 : 1;
  });

  const overdueCount = outstanding.filter((entry) => entry.overdue).length;

  return {
    suite,
    suiteReason: suite
      ? undefined
      : 'The project runs more than one form of contract, or none is executed, so no response periods are derived.',
    total: records.length,
    awaitingReply: outstanding.length,
    overdue: overdueCount,
    deemedAccepted,
    outstanding,
    summary:
      records.length === 0
        ? 'No contractual correspondence has been issued on this project.'
        : `${outstanding.length} letter${outstanding.length === 1 ? '' : 's'} awaiting a reply` +
          (overdueCount > 0 ? `, ${overdueCount} of them past the period the contract allows` : '') +
          '. ' +
          (deemedAccepted.length > 0
            ? `${deemedAccepted.length} ${deemedAccepted.length === 1 ? 'has' : 'have'} passed into deemed acceptance — ` +
              'those are decided rather than outstanding, and chasing them is not the remedy.'
            : 'Nothing has passed into deemed acceptance.'),
  };
}
