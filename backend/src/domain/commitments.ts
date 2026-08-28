import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, runAI, write, type EngineContext } from '../engines/context.ts';
import { registerObligation } from '../engines/claims.ts';

/**
 * Reading the promises out of correspondence.
 *
 * A project's letters are full of dates nobody is tracking. "We will complete
 * the remedial works by 14 October." "The revised drawings will follow within
 * ten working days." "Unless we hear from you by 30 November we will proceed on
 * that basis." Each is a commitment somebody made or a deadline somebody
 * imposed, and none of them is in the obligation calendar — the calendar holds
 * what the *contract* says, and these are what the parties said afterwards.
 *
 * ---
 *
 * ## What was already built, and is not rebuilt here
 *
 * - **The correspondence register** holds the letter, its parties, its subject
 *   and its body, and derives the contractual response period from the suite in
 *   force. This module reads a letter the register already holds; it does not
 *   store letters.
 * - **The obligation calendar** already tracks a dated obligation against an
 *   owner, counts it down, and reports it overdue. A confirmed commitment is
 *   registered *there*, through `registerObligation`, rather than into a second
 *   list of dates that would then disagree with the first.
 *
 * So this module owns exactly one thing: turning a letter into candidate
 * obligations a person confirms.
 *
 * ## A commitment is not filed because a model found it
 *
 * The same discipline as every other AI path here: the extraction is a
 * **reading**, and it reaches the calendar only when a person confirms it with
 * the date and the owner. `COMMITMENT_REGISTERED` is the reading;
 * `DEADLINE_TRACKED` is the confirmation, and it is the moment the date starts
 * being counted down.
 *
 * ## Nothing is recorded that is not quoted
 *
 * The load-bearing rule. Every commitment the provider returns has to carry the
 * words it read it from, and those words must appear **verbatim in the letter**.
 * Anything that does not is dropped before it is written, and if nothing
 * survives the command refuses.
 *
 * This is not tidiness. The local stand-in derives its answers from a hash of
 * its inputs — it cannot read prose, and asked what a letter promised it returns
 * a confident, deterministic, entirely fictional undertaking. A verbatim quote
 * is something a provider that did not read the letter cannot produce, so the
 * check does what a `multimodal` flag does for the perception pipeline: it makes
 * fabrication impossible to file rather than merely discouraged.
 *
 * It also makes every entry arguable. A commitment in the calendar can be read
 * back against the sentence in the letter it came from, which is what somebody
 * will want three years later.
 */

export type CommitmentKind =
  /** Something the author of the letter undertook to do. */
  | 'PROMISE'
  /** A date the letter puts on the recipient. */
  | 'DEADLINE_IMPOSED';

export type CommitmentStatus = 'READ' | 'TRACKED' | 'DISCARDED';

export type CommitmentState = {
  id: string;
  projectId: string;
  correspondenceId: string;
  correspondenceReference: string;
  kind: CommitmentKind;
  /** What was undertaken, in the reading's own words. */
  description: string;
  /** Who owes it, as the letter names them — a party, not a person. */
  party: string;
  /** As stated in the letter. Absent where the letter gave a period, not a date. */
  statedDueDate?: string;
  /**
   * The sentence in the letter this was read from, verbatim. Checked against
   * the body before anything is written; a commitment without one is not
   * recorded at all.
   */
  quotedText: string;
  status: CommitmentStatus;
  readAt: string;
  readFor: string;
  /** Set on confirmation — the obligation this became. */
  obligationId?: string;
  obligationReference?: string;
  trackedDueDate?: string;
  owner?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  discardReason?: string;
  discardedBy?: string;
  discardedAt?: string;
};

/** Whitespace differs between a quote and a body; the words do not. */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function commitmentsOf(ctx: EngineContext): CommitmentState[] {
  return ctx.ledger
    .list(ctx.projectId, 'CorrespondenceCommitment')
    .map((record) => record.state as unknown as CommitmentState)
    .sort((a, b) => (a.readAt < b.readAt ? 1 : -1));
}

function requireCommitment(ctx: EngineContext, commitmentId: string): CommitmentState {
  const record = ctx.ledger.get({ refType: 'CorrespondenceCommitment', refId: commitmentId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('COMMITMENT_NOT_FOUND', `No commitment ${commitmentId}`, 404);
  }
  const commitment = record.state as unknown as CommitmentState;
  if (commitment.status !== 'READ') {
    throw new DomainError(
      'COMMITMENT_SETTLED',
      `${commitment.correspondenceReference} — this reading was already ${commitment.status.toLowerCase()}.`,
      409,
    );
  }
  return commitment;
}

/**
 * Read one letter for what it promises and what it demands.
 *
 * `X` on contracts, the same authority clause extraction takes: this spends
 * ACUs reading a legal document. Confirming what it finds takes `C`, because
 * that is what registering the obligation takes.
 */
export async function readCommitments(
  ctx: EngineContext,
  input: { correspondenceId: string },
): Promise<{ commitmentIds: string[]; found: number; dropped: number; acuConsumed: number }> {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'X', { dataSensitivity: 'LEGAL_L4', lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'Correspondence', refId: input.correspondenceId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('NO_SUCH_CORRESPONDENCE', `No letter ${input.correspondenceId} on this project`, 404);
  }

  const letter = record.state as {
    reference?: string;
    body?: string;
    subject?: string;
    from?: string;
    to?: string;
    issuedOn?: string;
    typeLabel?: string;
  };
  const body = String(letter.body ?? '');
  const reference = String(letter.reference ?? input.correspondenceId);

  if (normalise(body).length < 40) {
    throw new DomainError(
      'LETTER_TOO_SHORT',
      `${reference} carries no body worth reading. A commitment is read from what the letter says, not from its subject line.`,
    );
  }

  const already = commitmentsOf(ctx).filter((entry) => entry.correspondenceId === input.correspondenceId);
  if (already.length > 0) {
    throw new DomainError(
      'ALREADY_READ',
      `${reference} has already been read — ${already.length} commitment(s) came out of it. The same words cannot ` +
        'promise something different, so reading it again would either repeat the answer or quietly replace one ' +
        'somebody has already acted on.',
      409,
    );
  }

  const found: string[] = [];
  let dropped = 0;
  /**
   * Whether the provider answered the question at all.
   *
   * An empty list is a real answer — plenty of letters promise nothing. No list
   * is a different thing entirely: it is a provider that did not understand what
   * it was asked, which on this deployment means the local stand-in. Collapsing
   * the two would have the platform tell somebody "nothing in COR-0001
   * undertakes to do anything by a date" about a letter that plainly does.
   */
  let answered = false;

  const result = await runAI(ctx, {
    engine: 'CONTRACTS_CLAIMS',
    taskType: 'commitment_extraction',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Correspondence', refId: input.correspondenceId }],
    request: {
      task:
        'Find every undertaking and every deadline in this letter. For each, say whether the author is promising ' +
        'to do something (PROMISE) or requiring the recipient to do something by a date (DEADLINE_IMPOSED), what ' +
        'exactly is owed, which party owes it, and the date it is owed by if the letter states one. Quote the ' +
        'sentence you read it from word for word — a quote that is not in the letter is not a finding. Report ' +
        'nothing where the letter promises nothing.',
      payload: {
        reference,
        type: letter.typeLabel,
        from: letter.from,
        to: letter.to,
        issuedOn: letter.issuedOn,
        subject: letter.subject,
        body: body.slice(0, 40_000),
      },
      responseSchema: {
        type: 'object',
        properties: {
          commitments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['PROMISE', 'DEADLINE_IMPOSED'] },
                description: { type: 'string' },
                party: { type: 'string' },
                dueDate: { type: ['string', 'null'] },
                quotedText: { type: 'string' },
              },
              required: ['kind', 'description', 'party', 'quotedText'],
            },
          },
        },
        required: ['commitments'],
      },
    },
    toWrites: (output) => {
      const haystack = normalise(body);
      const readAt = new Date().toISOString();
      const writes: Array<{ eventType: string; entity: { refType: string; refId: string }; nextState: Record<string, unknown> }> = [];

      answered = Array.isArray(output.commitments);

      for (const raw of (output.commitments as Array<Record<string, unknown>> | undefined) ?? []) {
        const quotedText = String(raw.quotedText ?? '').trim();
        const description = String(raw.description ?? '').trim();
        const party = String(raw.party ?? '').trim();

        // The grounding check. A quote the letter does not contain is a
        // sentence the provider wrote, and this platform does not file those
        // against a party as something they undertook.
        if (quotedText.length < 12 || !haystack.includes(normalise(quotedText))) {
          dropped += 1;
          continue;
        }
        if (description === '' || party === '') {
          dropped += 1;
          continue;
        }

        const commitmentId = ulid();
        found.push(commitmentId);
        const state: CommitmentState = {
          id: commitmentId,
          projectId: ctx.projectId,
          correspondenceId: input.correspondenceId,
          correspondenceReference: reference,
          kind: raw.kind === 'DEADLINE_IMPOSED' ? 'DEADLINE_IMPOSED' : 'PROMISE',
          description,
          party,
          ...(typeof raw.dueDate === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.dueDate)
            ? { statedDueDate: raw.dueDate.slice(0, 10) }
            : {}),
          quotedText,
          status: 'READ',
          readAt,
          readFor: ctx.auth.actorId,
        };
        writes.push({
          eventType: 'COMMITMENT_REGISTERED',
          entity: { refType: 'CorrespondenceCommitment', refId: commitmentId },
          nextState: state as unknown as Record<string, unknown>,
        });
      }

      return writes;
    },
  });

  if (found.length === 0) {
    // Three different facts, and the refusal says which. Only the first is a
    // statement about the letter; the other two are statements about the
    // provider, and telling somebody a letter promises nothing when the truth
    // is that nothing read it would be the worst answer of the three.
    if (dropped > 0) {
      throw new DomainError(
        'NOTHING_QUOTED',
        `Every one of the ${dropped} finding(s) returned for ${reference} quoted words that are not in the letter, ` +
          'so none was recorded. A provider that cannot read the text will answer anyway — the quote is what ' +
          'catches it, and on this deployment it caught all of them.',
        503,
      );
    }
    if (!answered) {
      throw new DomainError(
        'PROVIDER_CANNOT_READ',
        'The provider returned no list of commitments at all, which is not the same as finding none. Reading a ' +
          'letter needs a model that reads prose; the local engines compute, and nothing has been recorded ' +
          `against ${reference} rather than a reading being invented for it.`,
        503,
      );
    }
    throw new DomainError(
      'NOTHING_PROMISED',
      `Nothing in ${reference} undertakes to do anything by a date. That is an answer, not a failure.`,
      404,
    );
  }

  return { commitmentIds: found, found: found.length, dropped, acuConsumed: result.acuConsumed };
}

/**
 * Confirm a reading, and start counting the date down.
 *
 * The obligation is registered through the ordinary command, so it lands in the
 * calendar that already exists, is owned by somebody, and is reported overdue by
 * the machinery that already reports overdue. There is no second list of dates.
 *
 * The date and the owner are the confirmer's. A letter that says "within ten
 * working days" states a period and not a date, and working out which day that
 * lands on — which holidays, from which receipt — is not something to infer from
 * prose and file against a party.
 */
export function trackCommitment(
  ctx: EngineContext,
  input: {
    commitmentId: string;
    contractId: string;
    /** Who inside this business answers for it. */
    owner: string;
    /** Required. The letter's own date is offered as the default, not assumed. */
    dueDate: string;
    /** Corrected wording, where the reading got it slightly wrong. */
    description?: string;
  },
): { commitmentId: string; obligationId: string; obligationReference: string } {
  const commitment = requireCommitment(ctx, input.commitmentId);
  // What `registerObligation` requires. Nobody may confirm a reading into a
  // register they could not have written to by hand.
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { dataSensitivity: 'LEGAL_L4' });

  if (!/^\d{4}-\d{2}-\d{2}/.test(input.dueDate)) {
    throw new DomainError(
      'COMMITMENT_DATE_REQUIRED',
      'A commitment with no date is a sentiment. The letter may have stated a period rather than a day — say which ' +
        'day it falls on.',
    );
  }

  const description = (input.description ?? commitment.description).trim();
  const obligation = registerObligation(ctx, {
    contractId: input.contractId,
    // Distinct from the contract's own categories, and deliberately: this is
    // not something the contract requires, it is something a party said in a
    // letter afterwards.
    category: commitment.kind === 'PROMISE' ? 'UNDERTAKING_GIVEN' : 'DEADLINE_IMPOSED',
    description: `${description} (${commitment.correspondenceReference}, ${commitment.party})`,
    dueDate: input.dueDate.slice(0, 10),
    owner: input.owner,
  });

  write(ctx, {
    eventType: 'DEADLINE_TRACKED',
    entity: { refType: 'CorrespondenceCommitment', refId: commitment.id },
    nextState: {
      ...commitment,
      status: 'TRACKED',
      description,
      obligationId: obligation.obligationId,
      obligationReference: obligation.reference,
      trackedDueDate: input.dueDate.slice(0, 10),
      owner: input.owner,
      confirmedBy: ctx.auth.actorId,
      confirmedAt: new Date().toISOString(),
    } satisfies CommitmentState as unknown as Record<string, unknown>,
  });

  return { commitmentId: commitment.id, obligationId: obligation.obligationId, obligationReference: obligation.reference };
}

/** Reject a reading, saying why. What was read is kept. */
export function discardCommitment(
  ctx: EngineContext,
  input: { commitmentId: string; reason: string },
): { commitmentId: string } {
  const commitment = requireCommitment(ctx, input.commitmentId);
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { dataSensitivity: 'LEGAL_L4' });

  if (input.reason.trim().length < 4) {
    throw new DomainError('COMMITMENT_REASON_REQUIRED', 'Say why this is not a commitment worth tracking');
  }

  write(ctx, {
    eventType: 'COMMITMENT_DISCARDED',
    entity: { refType: 'CorrespondenceCommitment', refId: commitment.id },
    nextState: {
      ...commitment,
      status: 'DISCARDED',
      discardReason: input.reason,
      discardedBy: ctx.auth.actorId,
      discardedAt: new Date().toISOString(),
    } satisfies CommitmentState as unknown as Record<string, unknown>,
  });

  return { commitmentId: commitment.id };
}

export type CommitmentPosition = {
  read: number;
  tracked: number;
  discarded: number;
  /**
   * Letters nobody has read for commitments. The number that matters on a
   * project part way through adopting this: correspondence the platform holds
   * and has never looked at for a date.
   */
  unread: number;
  /**
   * Which ones, so a screen can offer them without working out for itself what
   * "unread" means. Newest first, and capped — a project with four hundred
   * unread letters needs the count, not four hundred rows.
   */
  unreadLetters: Array<{ correspondenceId: string; reference: string; subject: string; issuedOn?: string }>;
  awaitingDecision: Array<{
    commitmentId: string;
    correspondenceReference: string;
    kind: CommitmentKind;
    description: string;
    party: string;
    statedDueDate?: string;
    quotedText: string;
  }>;
};

/** What has been read out of the post, and what is still sitting in it. */
export function commitmentPosition(ctx: EngineContext): CommitmentPosition {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'R', { dataSensitivity: 'LEGAL_L4' });

  const all = commitmentsOf(ctx);
  const readLetters = new Set(all.map((entry) => entry.correspondenceId));
  const unread = ctx.ledger
    .list(ctx.projectId, 'Correspondence')
    .filter((record) => !readLetters.has(record.refId))
    .map((record) => {
      const state = record.state as { reference?: string; subject?: string; issuedOn?: string };
      return {
        correspondenceId: record.refId,
        reference: String(state.reference ?? record.refId),
        subject: String(state.subject ?? ''),
        ...(state.issuedOn ? { issuedOn: state.issuedOn } : {}),
      };
    })
    .sort((a, b) => (a.reference < b.reference ? 1 : -1));

  return {
    read: all.filter((entry) => entry.status === 'READ').length,
    tracked: all.filter((entry) => entry.status === 'TRACKED').length,
    discarded: all.filter((entry) => entry.status === 'DISCARDED').length,
    unread: unread.length,
    // Capped. A project with four hundred unread letters needs the count on the
    // screen, not four hundred rows below it.
    unreadLetters: unread.slice(0, 25),
    awaitingDecision: all
      .filter((entry) => entry.status === 'READ')
      .map((entry) => ({
        commitmentId: entry.id,
        correspondenceReference: entry.correspondenceReference,
        kind: entry.kind,
        description: entry.description,
        party: entry.party,
        ...(entry.statedDueDate ? { statedDueDate: entry.statedDueDate } : {}),
        quotedText: entry.quotedText,
      })),
  };
}
