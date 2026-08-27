import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { networkFloat } from '../engines/planning.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * CN-WF-08 — construction information, RFI, submittal and instruction control.
 *
 * The drawing register, its supersession, the markup that becomes an RFI, the
 * answer recorded against the revision it was given for, and the material
 * submittal are all built. Four things were not, and three of them are the same
 * failure seen from different sides: **the site is working to a revision the
 * office has already replaced.**
 *
 * **Nobody recorded who was sent what.** Superseding a drawing changes the
 * register; it does not reach the person holding the old one in a site cabin.
 * A transmittal is the controlled issue: named documents at named revisions to
 * named recipients, for a stated purpose, and each recipient acknowledges. Until
 * they do, the platform can say exactly who is still holding superseded
 * information — which is the only useful form of that question.
 *
 * **"Which revision am I building to?"** AC-CN-WF-08-01 asks for two taps.
 * `currentInformationFor` is the answer as one call: what is current for a
 * package, what it replaced, and who has not acknowledged the replacement.
 *
 * **An instruction that was a conversation.** The third exception control and
 * the expensive one. Somebody senior tells a foreman to move a wall. Nobody
 * writes it down, the wall moves, and six months later there is no instruction,
 * no variation and a contractor who did the work. An **unconfirmed direction**
 * is recorded as exactly that — a thing that was said, by whom, to whom, and
 * what was done about it — and it stays visible as exposure until a formal
 * instruction confirms it or somebody records that it was withdrawn. The
 * platform does not turn it into an instruction; that is the guardrail the
 * specification names, because an instruction is a contractual communication
 * and only a person with the authority issues one.
 *
 * **An instruction with no authority on it.** AC-CN-WF-08-03: authority, clause,
 * recipients, issue evidence and implementation status, all five. Sequentially
 * numbered, because a gap in an instruction sequence is a question somebody will
 * ask and an unnumbered instruction is one nobody can prove was issued.
 *
 * And AC-CN-WF-08-02, which the platform could nearly answer already: an RFI's
 * *due* date is contractual and its *required-by* is when the work actually
 * needs it. They are different dates and the gap between them is the float.
 * The required-by is derived from the programme through the activity the RFI
 * blocks rather than typed twice — a second typed date is a second date to be
 * wrong.
 */

// --- Transmittals -----------------------------------------------------------

export type TransmittedDocument = {
  reference: string;
  title: string;
  revision: string;
  /** What the recipient may do with it — for construction, for comment, for information. */
  purpose: string;
  /** The revision this replaces, where it replaces one. */
  supersedes?: string;
};

type TransmittalState = {
  id: string;
  reference: string;
  packageReference?: string;
  documents: TransmittedDocument[];
  recipients: Array<{ party: string; acknowledgedAt?: string; acknowledgedBy?: string }>;
  issuedAt: string;
  issuedBy: string;
};

const stateOf = <T>(record: EntityRecord): T => record.state as unknown as T;

export function issueTransmittal(
  ctx: EngineContext,
  input: {
    documents: TransmittedDocument[];
    recipients: string[];
    packageReference?: string;
    note: string;
  },
): { transmittalId: string; reference: string; supersedes: string[] } {
  authorise(ctx, 'DESIGN_INFORMATION', 'I', { lifecyclePhase: currentPhase(ctx) });

  if (input.documents.length === 0) {
    throw new DomainError('TRANSMITTAL_EMPTY', 'A transmittal issuing nothing tells nobody anything.');
  }
  if (input.recipients.length === 0) {
    throw new DomainError(
      'RECIPIENTS_REQUIRED',
      'Name who this is issued to. A transmittal to nobody is a file copy, and the whole point of the record is being able ' +
        'to say afterwards who was holding what.',
    );
  }
  for (const document of input.documents) {
    if (!document.reference.trim() || !document.revision.trim()) {
      throw new DomainError(
        'DOCUMENT_UNIDENTIFIED',
        'Every document on a transmittal carries its reference and its revision. "The latest drawings" is what the site ' +
          'says when nobody knows.',
      );
    }
    if (!document.purpose.trim()) {
      throw new DomainError(
        'PURPOSE_REQUIRED',
        `Say what ${document.reference} is issued for. A drawing issued for comment and built from is the commonest way a ` +
          'preliminary revision ends up in the ground.',
      );
    }
  }
  if (!input.note.trim()) {
    throw new DomainError('TRANSMITTAL_UNEXPLAINED', 'Say what this issue is for.');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Transmittal').length + 1;
  const reference = `TR-${String(sequence).padStart(4, '0')}`;
  const transmittalId = ulid();

  write(ctx, {
    eventType: 'INFORMATION_PUBLISHED',
    entity: { refType: 'Transmittal', refId: transmittalId },
    nextState: {
      id: transmittalId,
      projectId: ctx.projectId,
      reference,
      ...(input.packageReference ? { packageReference: input.packageReference } : {}),
      documents: input.documents,
      recipients: input.recipients.map((party) => ({ party })),
      note: input.note,
      issuedAt: new Date().toISOString(),
      issuedBy: ctx.auth.actorId,
    },
  });

  return {
    transmittalId,
    reference,
    supersedes: input.documents.map((document) => document.supersedes).filter((value): value is string => !!value),
  };
}

export function acknowledgeTransmittal(
  ctx: EngineContext,
  transmittalId: string,
  input: { party: string; acknowledgedBy: string },
): { reference: string; outstanding: string[] } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'Transmittal', refId: transmittalId });
  if (!record) throw new DomainError('TRANSMITTAL_NOT_FOUND', `No transmittal ${transmittalId}`, 404);
  const state = stateOf<TransmittalState>(record);

  const recipient = state.recipients.find((entry) => entry.party === input.party);
  if (!recipient) {
    throw new DomainError(
      'NOT_A_RECIPIENT',
      `${state.reference} was not issued to ${input.party}. An acknowledgement from somebody who was never sent it says ` +
        'nothing about whether the people who were sent it have read it.',
      404,
    );
  }
  if (recipient.acknowledgedAt) {
    throw new DomainError('ALREADY_ACKNOWLEDGED', `${input.party} acknowledged ${state.reference} already.`);
  }
  if (!input.acknowledgedBy.trim()) {
    throw new DomainError('ACKNOWLEDGEMENT_UNSIGNED', 'Name who acknowledged it.');
  }

  const recipients = state.recipients.map((entry) =>
    entry.party === input.party
      ? { ...entry, acknowledgedAt: new Date().toISOString(), acknowledgedBy: input.acknowledgedBy }
      : entry,
  );

  write(ctx, {
    eventType: 'INFORMATION_ACKNOWLEDGED',
    entity: { refType: 'Transmittal', refId: transmittalId },
    nextState: { ...record.state, recipients },
  });

  return {
    reference: state.reference,
    outstanding: recipients.filter((entry) => !entry.acknowledgedAt).map((entry) => entry.party),
  };
}

/**
 * What is current, what it replaced, and who is still holding the old one.
 *
 * AC-CN-WF-08-01, in one call. The site's question is never "list the drawing
 * register" — it is "am I building to the right thing", and the answer has to
 * include the people who have not yet said they have the replacement, because
 * those are the ones who are not.
 */
export function currentInformationFor(
  ctx: EngineContext,
  packageReference?: string,
): {
  current: Array<{ reference: string; revision: string; purpose: string; issuedOn: string; supersedes?: string }>;
  /** Recipients who were sent a superseding revision and never acknowledged it. */
  holdingSuperseded: Array<{ party: string; document: string; supersededRevision: string; nowAt: string }>;
} {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const transmittals = ctx.ledger
    .list(ctx.projectId, 'Transmittal')
    .map((record) => stateOf<TransmittalState>(record))
    .filter((state) => packageReference === undefined || state.packageReference === packageReference);

  // Latest issue wins per document reference: a transmittal is the act of
  // issuing, so the most recent one is what the recipients were last sent.
  const latest = new Map<string, { document: TransmittedDocument; issuedAt: string }>();
  for (const state of transmittals) {
    for (const document of state.documents) {
      const held = latest.get(document.reference);
      // `<=` rather than `<`: two issues inside one clock tick should resolve to
      // the later ledger entry, not the earlier one. The list is in insertion
      // order, so the last write of a tie is the last issue.
      if (!held || held.issuedAt <= state.issuedAt) {
        latest.set(document.reference, { document, issuedAt: state.issuedAt });
      }
    }
  }

  const holdingSuperseded: ReturnType<typeof currentInformationFor>['holdingSuperseded'] = [];
  for (const state of transmittals) {
    for (const document of state.documents) {
      if (!document.supersedes) continue;
      for (const recipient of state.recipients) {
        if (recipient.acknowledgedAt) continue;
        holdingSuperseded.push({
          party: recipient.party,
          document: document.reference,
          supersededRevision: document.supersedes,
          nowAt: document.revision,
        });
      }
    }
  }

  return {
    current: [...latest.values()].map(({ document, issuedAt }) => ({
      reference: document.reference,
      revision: document.revision,
      purpose: document.purpose,
      issuedOn: issuedAt.slice(0, 10),
      ...(document.supersedes ? { supersedes: document.supersedes } : {}),
    })),
    holdingSuperseded,
  };
}

// --- Instructions -----------------------------------------------------------

export function issueInstruction(
  ctx: EngineContext,
  input: {
    subject: string;
    /** What is instructed, in terms a site team can act on. */
    instruction: string;
    /** The clause it is issued under. An instruction with no clause is a letter. */
    contractClause: string;
    recipients: string[];
    /** Where it arises from a direction that was given verbally. */
    confirmsDirectionId?: string;
    evidenceHash: string;
  },
): { instructionId: string; reference: string; number: number } {
  // Approve on the commercial area. An instruction binds the contract, and the
  // specification is explicit that the agent may draft one and never issue it.
  authorise(ctx, 'CHANGE_VARIATION', 'A', { lifecyclePhase: currentPhase(ctx) });

  // A floor, not a judgement of clarity: no rule can tell "proceed as
  // discussed" from a real instruction, and pretending otherwise would be worse
  // than a floor everybody understands. What it stops is the one-word
  // instruction, which is common and always a dispute.
  if (!input.subject.trim() || input.instruction.trim().length < 20) {
    throw new DomainError(
      'INSTRUCTION_UNCLEAR',
      'An instruction says what to do in terms a site team can act on. "Proceed as discussed" is the sentence that becomes ' +
        'a dispute, and anything shorter than a sentence is that with fewer words.',
    );
  }
  if (!input.contractClause.trim()) {
    throw new DomainError(
      'CLAUSE_REQUIRED',
      'Name the clause it is issued under. An instruction with no clause behind it is a letter, and the difference decides ' +
        'whether it carries an entitlement.',
    );
  }
  if (input.recipients.length === 0) {
    throw new DomainError('RECIPIENTS_REQUIRED', 'Name who it is issued to.');
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('EVIDENCE_REQUIRED', 'An instruction carries the document that was issued.');
  }

  // Sequential and gapless. A gap in an instruction sequence is a question
  // somebody will ask, and an unnumbered instruction is one nobody can prove
  // was issued.
  const number = ctx.ledger.list(ctx.projectId, 'Instruction').length + 1;
  const reference = `INS-${String(number).padStart(4, '0')}`;
  const instructionId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'CONTRACT_INSTRUCTION',
    hash: input.evidenceHash,
    description: `${reference}: ${input.subject}`,
  });

  write(ctx, {
    eventType: 'INSTRUCTION_ISSUED',
    entity: { refType: 'Instruction', refId: instructionId },
    nextState: {
      id: instructionId,
      projectId: ctx.projectId,
      reference,
      number,
      subject: input.subject,
      instruction: input.instruction,
      contractClause: input.contractClause,
      recipients: input.recipients,
      ...(input.confirmsDirectionId ? { confirmsDirectionId: input.confirmsDirectionId } : {}),
      status: 'ISSUED',
      issuedAt: new Date().toISOString(),
      issuedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  // The verbal direction it confirms stops being exposure at the moment the
  // instruction exists, and the link is written on both.
  if (input.confirmsDirectionId) {
    const direction = ctx.ledger.get({ refType: 'UnconfirmedDirection', refId: input.confirmsDirectionId });
    if (direction) {
      write(ctx, {
        eventType: 'DIRECTION_CONFIRMED',
        entity: { refType: 'UnconfirmedDirection', refId: input.confirmsDirectionId },
        nextState: {
          ...direction.state,
          status: 'CONFIRMED',
          confirmedByInstruction: reference,
          confirmedAt: new Date().toISOString(),
        },
      });
    }
  }

  return { instructionId, reference, number };
}

export function recordInstructionImplementation(
  ctx: EngineContext,
  instructionId: string,
  input: { what: string; verifiedBy: string; evidenceHash: string },
): { reference: string; implemented: true } {
  authorise(ctx, 'CHANGE_VARIATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'Instruction', refId: instructionId });
  if (!record) throw new DomainError('INSTRUCTION_NOT_FOUND', `No instruction ${instructionId}`, 404);
  if (record.state.status === 'IMPLEMENTED') {
    throw new DomainError('ALREADY_IMPLEMENTED', `${String(record.state.reference)} is already recorded as implemented.`);
  }
  if (!input.what.trim() || !input.verifiedBy.trim()) {
    throw new DomainError(
      'IMPLEMENTATION_UNVERIFIED',
      'Say what was actually done on site and who checked it. AC-CN-WF-08-03 asks for implementation status, and a status ' +
        'nobody verified is the instruction being marked complete by the person who issued it.',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'CONTRACT_INSTRUCTION',
    hash: input.evidenceHash,
    description: `${String(record.state.reference)} implemented: ${input.what}`,
    linkedEntities: [{ refType: 'Instruction', refId: instructionId }],
  });

  write(ctx, {
    eventType: 'INSTRUCTION_IMPLEMENTED',
    entity: { refType: 'Instruction', refId: instructionId },
    nextState: {
      ...record.state,
      status: 'IMPLEMENTED',
      implementation: {
        what: input.what,
        verifiedBy: input.verifiedBy,
        at: new Date().toISOString(),
        recordedBy: ctx.auth.actorId,
      },
    },
    evidenceRefs: [evidence],
  });

  return { reference: String(record.state.reference), implemented: true };
}

// --- The thing that was said ------------------------------------------------

/**
 * Record a verbal direction as what it is.
 *
 * The first exception control. Somebody senior tells a foreman to move a wall;
 * nobody writes it down; the wall moves; six months later there is no
 * instruction, no variation and a contractor who did the work. Recording it
 * does not make it an instruction — the platform never converts one — but it
 * makes it **visible exposure** with a name, a date and what was done about it,
 * which is the difference between a claim and a conversation.
 */
export function recordUnconfirmedDirection(
  ctx: EngineContext,
  input: {
    givenBy: string;
    givenTo: string;
    givenAt: string;
    whatWasSaid: string;
    /** What the site did in response. Often the answer is "started". */
    actionTaken: string;
    estimatedCostMinor?: number;
  },
): { directionId: string; reference: string } {
  // Create, not approve. Anybody on site who was told something can record that
  // they were told it — a control that only the person with authority can
  // operate would record none of the directions that matter.
  authorise(ctx, 'CHANGE_VARIATION', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.givenBy.trim() || !input.givenTo.trim()) {
    throw new DomainError(
      'DIRECTION_UNATTRIBUTED',
      'Name who gave the direction and who received it. Both, because the argument afterwards is always about one of them.',
    );
  }
  if (input.whatWasSaid.trim().length < 10) {
    throw new DomainError(
      'DIRECTION_UNRECORDED',
      'Write down what was actually said, in the words it was said in. A paraphrase written six weeks later is worth much ' +
        'less than an imperfect note written the same day.',
    );
  }
  if (!input.actionTaken.trim()) {
    throw new DomainError(
      'ACTION_UNRECORDED',
      'Say what the site did about it. "Nothing yet" is a complete answer and a different exposure from "started".',
    );
  }
  if (Number.isNaN(Date.parse(input.givenAt))) {
    throw new DomainError('DIRECTION_UNDATED', 'A direction was given on a date.');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'UnconfirmedDirection').length + 1;
  const reference = `UD-${String(sequence).padStart(4, '0')}`;
  const directionId = ulid();

  write(ctx, {
    eventType: 'UNCONFIRMED_DIRECTION_RECORDED',
    entity: { refType: 'UnconfirmedDirection', refId: directionId },
    nextState: {
      id: directionId,
      projectId: ctx.projectId,
      reference,
      givenBy: input.givenBy,
      givenTo: input.givenTo,
      givenAt: input.givenAt,
      whatWasSaid: input.whatWasSaid,
      actionTaken: input.actionTaken,
      ...(input.estimatedCostMinor === undefined ? {} : { estimatedCostMinor: input.estimatedCostMinor }),
      status: 'UNCONFIRMED',
      recordedAt: new Date().toISOString(),
      recordedBy: ctx.auth.actorId,
    },
  });

  return { directionId, reference };
}

export function withdrawDirection(
  ctx: EngineContext,
  directionId: string,
  input: { reason: string },
): { reference: string; withdrawn: true } {
  authorise(ctx, 'CHANGE_VARIATION', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'UnconfirmedDirection', refId: directionId });
  if (!record) throw new DomainError('DIRECTION_NOT_FOUND', `No direction ${directionId}`, 404);
  if (record.state.status !== 'UNCONFIRMED') {
    throw new DomainError('DIRECTION_RESOLVED', `${String(record.state.reference)} is already resolved.`);
  }
  if (!input.reason.trim()) {
    throw new DomainError(
      'WITHDRAWAL_UNEXPLAINED',
      'Say what happened to it — withdrawn, superseded, or never actually said. Work may already have been done on the ' +
        'strength of it, and that is what the record has to answer.',
    );
  }

  write(ctx, {
    eventType: 'DIRECTION_CONFIRMED',
    entity: { refType: 'UnconfirmedDirection', refId: directionId },
    nextState: {
      ...record.state,
      status: 'WITHDRAWN',
      withdrawalReason: input.reason,
      withdrawnAt: new Date().toISOString(),
      withdrawnBy: ctx.auth.actorId,
    },
  });

  return { reference: String(record.state.reference), withdrawn: true };
}

// --- The position -----------------------------------------------------------

export type InformationPosition = {
  /** Who is still holding a revision the office has replaced. */
  holdingSuperseded: Array<{ party: string; document: string; supersededRevision: string; nowAt: string }>;
  transmittals: Array<{ reference: string; documents: number; outstanding: string[] }>;
  instructions: Array<{
    reference: string;
    subject: string;
    contractClause: string;
    recipients: string[];
    status: string;
    confirmsDirection?: string;
  }>;
  /** Verbal directions nobody has confirmed. Visible exposure. */
  unconfirmedDirections: Array<{
    reference: string;
    givenBy: string;
    givenTo: string;
    givenAt: string;
    whatWasSaid: string;
    actionTaken: string;
    daysOutstanding: number;
  }>;
  /**
   * Open RFIs with their contractual due date beside the date the work needs
   * them. AC-CN-WF-08-02: two different dates, and the gap is the float.
   */
  rfiPressure: Array<{
    reference: string;
    dueDate?: string;
    /** From the programme, through the activity the answer is holding up. */
    blocksActivity?: string;
    floatDays?: number;
    daysOpen: number;
  }>;
  summary: string;
};

export function informationPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): InformationPosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const { holdingSuperseded } = currentInformationFor(ctx);

  const transmittals = ctx.ledger.list(ctx.projectId, 'Transmittal').map((record) => {
    const state = stateOf<TransmittalState>(record);
    return {
      reference: state.reference,
      documents: state.documents.length,
      outstanding: state.recipients.filter((entry) => !entry.acknowledgedAt).map((entry) => entry.party),
    };
  });

  const instructions = ctx.ledger.list(ctx.projectId, 'Instruction').map((record) => ({
    reference: String(record.state.reference),
    subject: String(record.state.subject),
    contractClause: String(record.state.contractClause),
    recipients: (record.state.recipients as string[]) ?? [],
    status: String(record.state.status),
    ...(record.state.confirmsDirectionId ? { confirmsDirection: String(record.state.confirmsDirectionId) } : {}),
  }));

  const unconfirmedDirections = ctx.ledger
    .list(ctx.projectId, 'UnconfirmedDirection')
    .filter((record) => record.state.status === 'UNCONFIRMED')
    .map((record) => ({
      reference: String(record.state.reference),
      givenBy: String(record.state.givenBy),
      givenTo: String(record.state.givenTo),
      givenAt: String(record.state.givenAt).slice(0, 10),
      whatWasSaid: String(record.state.whatWasSaid),
      actionTaken: String(record.state.actionTaken),
      daysOutstanding: Math.max(
        0,
        Math.round((Date.parse(today) - Date.parse(String(record.state.givenAt).slice(0, 10))) / 86_400_000),
      ),
    }));

  // The required-by comes off the programme rather than being typed a second
  // time. A second typed date is a second date to be wrong.
  const { floatByTask, activityNames } = networkFloat(ctx);

  const rfiPressure = ctx.ledger
    .list(ctx.projectId, 'RFI')
    .filter((record) => record.state.status !== 'ANSWERED')
    .map((record) => {
      const taskId = typeof record.state.linkedTaskId === 'string' ? record.state.linkedTaskId : undefined;
      const raisedAt = String(record.state.raisedAt ?? today).slice(0, 10);
      return {
        reference: String(record.state.reference),
        ...(typeof record.state.dueDate === 'string' ? { dueDate: record.state.dueDate } : {}),
        ...(taskId && activityNames.has(taskId) ? { blocksActivity: activityNames.get(taskId) } : {}),
        ...(taskId && floatByTask.has(taskId) ? { floatDays: floatByTask.get(taskId) } : {}),
        daysOpen: Math.max(0, Math.round((Date.parse(today) - Date.parse(raisedAt)) / 86_400_000)),
      };
    });

  const parts: string[] = [];
  if (holdingSuperseded.length > 0) parts.push(`${holdingSuperseded.length} recipient(s) still holding superseded information`);
  if (unconfirmedDirections.length > 0) parts.push(`${unconfirmedDirections.length} verbal direction(s) unconfirmed`);
  const openOnCritical = rfiPressure.filter((entry) => (entry.floatDays ?? 99) <= 0).length;
  if (openOnCritical > 0) parts.push(`${openOnCritical} open RFI(s) on activities with no float`);
  if (instructions.length > 0) parts.push(`${instructions.length} instruction(s) issued`);
  if (parts.length === 0) parts.push('Everything issued has been acknowledged and nothing is running on a verbal direction');

  return {
    holdingSuperseded,
    transmittals,
    instructions,
    unconfirmedDirections,
    rfiPressure,
    summary: parts.join(', ') + '.',
  };
}
