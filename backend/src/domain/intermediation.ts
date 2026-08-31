import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { abbreviateMoney } from './locale.ts';

/**
 * Standing between a client and a panel, and staying there.
 *
 * `integrator.ts` answers the cash question: whose money pays the supplier, and
 * how many days sit between paying and being paid. This answers the other one,
 * which kills the same businesses more slowly.
 *
 * A business that coordinates fifteen suppliers introduces every one of them to
 * its client. They meet on site. They learn what the client wants, who signs,
 * what the site is like and what the work is worth. On the next appointment the
 * client can buy from any of them directly, and the coordinator's margin is the
 * most obvious thing to remove — it is the one line on the account that is not
 * doing any of the work.
 *
 * That is not a supplier behaving badly. It is the ordinary economics of the
 * position, and it is why `TRADING_MODEL` says the fee model carries the
 * *highest* margin risk while carrying the lowest cash risk. Those two facts
 * were stated in words and nothing measured either.
 *
 * ---
 *
 * ## What this holds
 *
 * **Five defences, and what each one does not do.** A register of things that
 * are either in place or not, each with the honest limit written next to it. A
 * non-circumvention term binds the supplier and not the client; the client may
 * buy from whoever it likes and nothing here changes that. Recording a defence
 * without its limit would be the thing this module exists to prevent — a
 * business believing it is protected by a clause that does not reach the party
 * that actually makes the decision.
 *
 * **Concentration, from committed value rather than from opinion.** The share
 * of the contract sitting with the largest single supplier, computed off the
 * subcontracts the platform already holds. A supplier carrying half the value
 * is the service, and knows it.
 *
 * **Direct approaches, on the record.** Not to threaten anybody with. A pattern
 * of approaches is the leading indicator of the appointment not being renewed,
 * and it is invisible unless somebody writes each one down at the time.
 *
 * ## What it refuses
 *
 * **A restraint between competitors.** This is the one place a margin-defence
 * feature can do a user real harm, so the distinction is built into the
 * command rather than mentioned in a note.
 *
 * A non-circumvention term between this business and its own subcontractor is a
 * **vertical** restraint: two parties at different levels of the same supply
 * chain, and ordinarily lawful.
 *
 * An arrangement with an actual or potential **competitor** not to approach each
 * other's clients is customer allocation. That is a *by object* infringement of
 * the Chapter I prohibition in the Competition Act 1998 — no effects analysis is
 * needed, the small-agreements exclusion does not apply to it, and the
 * consequences reach personal disqualification and criminal liability under the
 * cartel offence. The same is true of arranging for panel suppliers to agree
 * among *themselves* not to bid, which is the same cartel with this business in
 * the middle of it.
 *
 * So the command asks what the counterparty is, refuses the horizontal case by
 * name, and records the declared answer. It cannot stop somebody describing a
 * competitor as a supplier — nothing can — but the record then shows what was
 * declared, by whom, and when.
 */

// --- The defences ------------------------------------------------------------

/**
 * What actually keeps a coordinator in the middle, and what each thing fails to
 * do.
 *
 * `doesNotHold` is not a disclaimer. It is the more useful half: a business
 * that has three of these and believes it therefore cannot be displaced has
 * stopped doing the thing that actually keeps it there.
 */
export const DEFENCE = {
  SPECIFICATION_OWNERSHIP: {
    label: 'The client specification is this business’s document',
    holds:
      'The client buys against a requirement this business wrote. A supplier going direct has to reproduce that ' +
      'work — or the client has to write it — and neither is free. It is the only defence that gets stronger the ' +
      'longer the appointment runs, because the specification accumulates what was learned on the job.',
    doesNotHold:
      'Nothing stops the client handing the specification to somebody else and asking them to price it. What it buys ' +
      'is that the alternative is a priced comparison rather than an obvious saving.',
  },
  SINGLE_INVOICE: {
    label: 'The client receives one invoice, not fifteen',
    holds:
      'The client buys an outcome at a price rather than a list of supplier costs with a coordination fee on top. ' +
      'Without it, the client can compute exactly what this business costs, and that figure is the easiest line on ' +
      'the account to question.',
    doesNotHold:
      'It is unavailable on a fee model by definition, and open-book terms remove it on a management one. Where the ' +
      'client has bought transparency, this defence was traded away deliberately and the others have to carry more.',
  },
  FRAMEWORK_TERM: {
    label: 'A term agreement with the client, with a date on it',
    holds:
      'A stated period in which the client has agreed to buy this way. It is the only defence with a clock, which ' +
      'makes it the one that can be relied on and the one that disappears without anybody noticing.',
    doesNotHold:
      'A framework is an agreement about how work is bought, not a guarantee that any is. It also ends, and ' +
      're-procuring one takes longer than the notice most businesses give themselves.',
  },
  NON_CIRCUMVENTION: {
    label: 'A non-circumvention term in the supplier agreements',
    holds:
      'The supplier has agreed not to solicit this business’s client for the work it was introduced to. Between a ' +
      'contractor and its own subcontractor that is an ordinary vertical restraint.',
    // No markdown in a string the console prints. The asterisks around this
    // sentence rendered as literal asterisks on the panel, which is the whole
    // reason to read the output rather than the source.
    doesNotHold:
      'It binds the supplier, not the client. A client that decides to appoint the supplier directly is not a ' +
      'party to it and is not restrained by it — and a supplier responding to an approach it did not solicit is ' +
      'usually outside the term as well. It also has to be reasonable in scope and duration to be enforceable at ' +
      'all. This is the defence most often relied on and the weakest of the five.',
  },
  PERFORMANCE_EVIDENCE: {
    label: 'A record of what this business actually delivered',
    holds:
      'The Golden Thread is this: what was decided, when, on whose authority and against what evidence. It is the ' +
      'answer to "what are we paying you for", given in records rather than in assertions, and no supplier holds ' +
      'the equivalent for the coordination work because no supplier did it.',
    doesNotHold:
      'It is only a defence if somebody puts it in front of the client before the renewal conversation rather than ' +
      'after it.',
  },
} as const;

export type DefenceKind = keyof typeof DEFENCE;

/** Vertical is ordinarily lawful. Horizontal is a cartel. */
export type CounterpartyRelation = 'OWN_SUPPLIER' | 'COMPETITOR' | 'PANEL_TO_PANEL';

const RELATION = {
  OWN_SUPPLIER: {
    label: 'A supplier or subcontractor this business appoints',
    vertical: true,
  },
  COMPETITOR: {
    label: 'A business that competes, or could compete, for the same appointment',
    vertical: false,
  },
  PANEL_TO_PANEL: {
    label: 'An arrangement between the panel suppliers themselves',
    vertical: false,
  },
} as const;

// --- Recording the position --------------------------------------------------

type DefenceState = {
  kind: DefenceKind;
  inPlace: boolean;
  /** Where the defence lives — a clause reference, a framework, a document. */
  evidence?: string;
  /** For a non-circumvention term: what the other party is. */
  relation?: CounterpartyRelation;
  recordedBy: string;
  recordedAt: string;
};

type ApproachState = {
  id: string;
  supplierPartyId: string;
  supplierName: string;
  occurredOn: string;
  what: string;
  outcome: ApproachOutcome;
  recordedBy: string;
};

export type ApproachOutcome = 'SUPPLIER_DECLINED' | 'CLIENT_REDIRECTED' | 'PROCEEDED' | 'UNKNOWN';

const OUTCOME_LABEL: Record<ApproachOutcome, string> = {
  SUPPLIER_DECLINED: 'The supplier declined and told us',
  CLIENT_REDIRECTED: 'The client redirected it back to us',
  PROCEEDED: 'It went ahead without us',
  UNKNOWN: 'Not known what came of it',
};

/**
 * Record whether a defence is in place, and where it lives.
 *
 * One command for all five, because they are the same kind of fact and five
 * near-identical commands would be five places for the shape to drift.
 *
 * Refuses a non-circumvention term whose counterparty is a competitor or the
 * panel agreeing among itself. See the module comment: that is customer
 * allocation, an object infringement of the Chapter I prohibition, and it is
 * not something this platform will hold a record of as though it were a
 * commercial control.
 */
export function recordDefence(
  ctx: EngineContext,
  input: { kind: DefenceKind; inPlace: boolean; evidence?: string; relation?: CounterpartyRelation },
): { kind: DefenceKind; inPlace: boolean } {
  authorise(ctx, 'BUDGET_COST', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!(input.kind in DEFENCE)) {
    throw new DomainError('DEFENCE_UNKNOWN', `${input.kind} is not one of the defences this platform recognises.`);
  }

  if (input.kind === 'NON_CIRCUMVENTION' && input.inPlace) {
    if (!input.relation) {
      throw new DomainError(
        'RESTRAINT_RELATION_REQUIRED',
        'Say what the other party to the term is. Between this business and its own subcontractor a ' +
          'non-circumvention term is an ordinary vertical restraint. Between competitors, or among the panel ' +
          'itself, the same words are customer allocation and unlawful — so the answer decides whether this can be ' +
          'recorded at all, and it is not a question the platform can answer for you.',
      );
    }
    if (!RELATION[input.relation].vertical) {
      throw new DomainError(
        'RESTRAINT_UNLAWFUL',
        `${RELATION[input.relation].label}: an agreement not to approach each other’s clients is customer ` +
          'allocation. That infringes the Chapter I prohibition of the Competition Act 1998 by object — no effects ' +
          'analysis is required, the small-agreements exclusion does not apply, and it carries director ' +
          'disqualification and the cartel offence. This platform will not record it as a commercial control. A ' +
          'non-circumvention term with a business you appoint as a supplier is a different arrangement and is ' +
          'recordable.',
        409,
      );
    }
  }

  if (input.inPlace && !input.evidence?.trim()) {
    throw new DomainError(
      'DEFENCE_EVIDENCE_REQUIRED',
      'Say where the defence actually lives — the clause, the framework, the document. A defence recorded as in ' +
        'place with nothing behind it is the belief this register exists to test, written down as a fact.',
    );
  }

  const record = ctx.ledger.list(ctx.projectId, 'IntermediationPosition')[0];
  const positionId = record?.refId ?? ulid();
  const state = (record?.state as Record<string, unknown> | undefined) ?? {
    id: positionId,
    projectId: ctx.projectId,
    defences: [],
    approaches: [],
  };

  const defence: DefenceState = {
    kind: input.kind,
    inPlace: input.inPlace,
    ...(input.evidence?.trim() ? { evidence: input.evidence.trim() } : {}),
    ...(input.relation ? { relation: input.relation } : {}),
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };

  const defences = [
    ...((state.defences as DefenceState[] | undefined) ?? []).filter((entry) => entry.kind !== input.kind),
    defence,
  ];

  write(ctx, {
    eventType: 'INTERMEDIATION_DEFENCE_RECORDED',
    entity: { refType: 'IntermediationPosition', refId: positionId },
    reason: `${DEFENCE[input.kind].label}: ${input.inPlace ? 'in place' : 'not in place'}`,
    nextState: { ...state, id: positionId, projectId: ctx.projectId, defences },
  });

  return { kind: input.kind, inPlace: input.inPlace };
}

/**
 * Record that a panel supplier approached the client directly.
 *
 * Written down at the time, because the value is in the pattern and the pattern
 * is invisible in hindsight. One approach is a conversation; three from
 * different suppliers in a quarter is the appointment being priced by somebody
 * else, and the six months before renewal is when that can still be answered.
 *
 * The outcome is required and includes "not known", because a register where
 * the awkward ones are left blank stops being a register.
 */
export function recordDirectApproach(
  ctx: EngineContext,
  input: { supplierPartyId: string; supplierName: string; occurredOn: string; what: string; outcome: ApproachOutcome },
): { approachId: string; approaches: number } {
  authorise(ctx, 'BUDGET_COST', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!input.what.trim()) {
    throw new DomainError(
      'APPROACH_DETAIL_REQUIRED',
      'Say what happened. This is a record about a named business, and a line with no facts in it is an allegation.',
    );
  }
  if (Number.isNaN(Date.parse(input.occurredOn))) {
    throw new DomainError('APPROACH_DATE_INVALID', 'When did it happen? A pattern over time cannot be read without dates.');
  }

  const record = ctx.ledger.list(ctx.projectId, 'IntermediationPosition')[0];
  const positionId = record?.refId ?? ulid();
  const state = (record?.state as Record<string, unknown> | undefined) ?? {
    id: positionId,
    projectId: ctx.projectId,
    defences: [],
    approaches: [],
  };

  const approachId = ulid();
  const approaches = [
    ...((state.approaches as ApproachState[] | undefined) ?? []),
    {
      id: approachId,
      supplierPartyId: input.supplierPartyId,
      supplierName: input.supplierName,
      occurredOn: input.occurredOn.slice(0, 10),
      what: input.what.trim(),
      outcome: input.outcome,
      recordedBy: ctx.auth.actorId,
    } satisfies ApproachState,
  ];

  write(ctx, {
    eventType: 'DIRECT_APPROACH_RECORDED',
    entity: { refType: 'IntermediationPosition', refId: positionId },
    reason: `${input.supplierName} on ${input.occurredOn.slice(0, 10)}: ${OUTCOME_LABEL[input.outcome]}`,
    nextState: { ...state, id: positionId, projectId: ctx.projectId, approaches },
  });

  return { approachId, approaches: approaches.length };
}

// --- The position ------------------------------------------------------------

export type SupplierShare = {
  supplierPartyId: string;
  supplierName: string;
  committedMinor: number;
  sharePercent: number;
  /** True where this supplier has been recorded approaching the client. */
  hasApproachedClient: boolean;
};

export type IntermediationConcern = {
  kind:
    | 'NOT_ASSESSED'
    | 'SPECIFICATION_NOT_OWNED'
    | 'SUPPLIER_CONCENTRATION'
    | 'CONCENTRATED_AND_APPROACHING'
    | 'DIRECT_APPROACHES'
    | 'FRAMEWORK_EXPIRING'
    | 'RELYING_ON_THE_WEAKEST'
    | 'NOBODY_WHO_DECIDES'
    | 'RELATIONSHIP_HELD_BY_ONE_PERSON'
    | 'COUNTERPART_HAS_GONE';
  subject: string;
  consequence: string;
};

export type IntermediationPosition = {
  defences: Array<{
    kind: DefenceKind;
    label: string;
    inPlace: boolean;
    assessed: boolean;
    evidence?: string;
    holds: string;
    doesNotHold: string;
  }>;
  inPlaceCount: number;
  assessedCount: number;
  /** Committed value by supplier, largest first. */
  shares: SupplierShare[];
  committedMinor: number;
  largestSharePercent?: number;
  /** The threshold this is judged against, and where it came from. */
  concentrationThreshold: { percent: number; source: string };
  approaches: Array<{ supplierName: string; occurredOn: string; what: string; outcome: ApproachOutcome; outcomeLabel: string }>;
  /** A framework term with a date, where one has been set up. */
  framework?: { reference: string; name: string; endsOn: string; daysRemaining: number };
  /** Who at the client this business knows, and who here holds each one. */
  relationship: ClientRelationship;
  concerns: IntermediationConcern[];
  summary: string;
};

/**
 * Committed value by supplier, largest first.
 *
 * Separated from the ledger read so it can be tested against inputs somebody
 * chose. The demonstration seed lets exactly one package, so a test that took
 * its concentration from the seed asserted an ordering over a list of one — a
 * loop that never ran, passing for as long as the arithmetic was anything at
 * all. Two mutations proved it: reversing the sort and removing it entirely
 * both survived.
 *
 * One supplier is not a special case here. It is the *only* case the seed can
 * produce, and it is the case where every share is 100% and every ordering is
 * correct.
 */
export function sharesOf(
  subcontracts: Array<Record<string, unknown>>,
  approachedBy: ReadonlySet<string> = new Set(),
): { shares: SupplierShare[]; committedMinor: number } {
  const bySupplier = new Map<string, { name: string; committedMinor: number }>();
  for (const state of subcontracts) {
    const partyId = String(state.supplierPartyId ?? '');
    // A subcontract with no supplier on it is a record somebody has not
    // finished, not a supplier called "undefined" holding a share of the job.
    if (!partyId) continue;
    const existing = bySupplier.get(partyId);
    bySupplier.set(partyId, {
      // Later records win the name, so a supplier that changed its trading name
      // appears once under the current one rather than twice.
      name: String(state.supplierName ?? partyId),
      committedMinor: (existing?.committedMinor ?? 0) + Number(state.valueMinor ?? 0),
    });
  }

  const committedMinor = [...bySupplier.values()].reduce((sum, entry) => sum + entry.committedMinor, 0);
  const shares: SupplierShare[] = [...bySupplier.entries()]
    .map(([supplierPartyId, entry]) => ({
      supplierPartyId,
      supplierName: entry.name,
      committedMinor: entry.committedMinor,
      sharePercent: committedMinor > 0 ? Math.round((entry.committedMinor / committedMinor) * 1000) / 10 : 0,
      hasApproachedClient: approachedBy.has(supplierPartyId),
    }))
    .sort((a, b) => b.committedMinor - a.committedMinor);

  return { shares, committedMinor };
}

/**
 * How exposed this appointment is to being bought around, and where the
 * exposure is.
 *
 * Derived on every read. A stored score would go on saying a business was
 * protected after the framework expired and the largest supplier doubled.
 *
 * Deliberately **not** a single number. "You are 62% protected" is the same
 * unarguable figure as the single overhead-and-profit percentage the price
 * build-up refuses to quote, and it would be acted on the same way: not at all.
 */
export function intermediationPosition(ctx: EngineContext, today?: string): IntermediationPosition {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const asAt = (today ?? new Date().toISOString()).slice(0, 10);
  const record = ctx.ledger.list(ctx.projectId, 'IntermediationPosition')[0];
  const recorded = ((record?.state.defences as DefenceState[] | undefined) ?? []);
  const approaches = ((record?.state.approaches as ApproachState[] | undefined) ?? []);
  const concerns: IntermediationConcern[] = [];

  const defences = (Object.keys(DEFENCE) as DefenceKind[]).map((kind) => {
    const held = recorded.find((entry) => entry.kind === kind);
    return {
      kind,
      label: DEFENCE[kind].label,
      // Never assessed and assessed as absent are different facts, and only one
      // of them is somebody's decision. Collapsing them would report a business
      // that has not looked at this as one that has looked and has nothing.
      inPlace: held?.inPlace === true,
      assessed: held !== undefined,
      ...(held?.evidence ? { evidence: held.evidence } : {}),
      holds: DEFENCE[kind].holds,
      doesNotHold: DEFENCE[kind].doesNotHold,
    };
  });

  const inPlaceCount = defences.filter((entry) => entry.inPlace).length;
  const assessedCount = defences.filter((entry) => entry.assessed).length;

  // --- Concentration, from the subcontracts rather than from an opinion ------
  const approachedBy = new Set(approaches.map((entry) => entry.supplierPartyId));
  const { shares, committedMinor } = sharesOf(
    ctx.ledger.list(ctx.projectId, 'Subcontract').map((record) => record.state as Record<string, unknown>),
    approachedBy,
  );

  const largest = shares[0];
  const threshold = concentrationThreshold(ctx);
  const framework = activeFramework(ctx, asAt);

  // --- The relationship -----------------------------------------------------
  const contactState = ((record?.state.contacts as ContactState[] | undefined) ?? []);
  const standing = contactState.filter((entry) => !entry.departed);
  const relationship: ClientRelationship = {
    contacts: contactState.map((entry) => ({
      contactId: entry.id,
      name: entry.name,
      role: entry.role,
      roleLabel: CLIENT_ROLE[entry.role]?.label ?? entry.role,
      ownedBy: entry.ownedBy,
      departed: entry.departed,
    })),
    // Only people still in post can decide anything. Counting a departed
    // sponsor here would report the relationship as reaching the renewal on the
    // strength of somebody who has left.
    decisionMakers: standing.filter((entry) => CLIENT_ROLE[entry.role]?.decides === true).length,
    ownerCount: new Set(standing.map((entry) => entry.ownedBy)).size,
    departedCount: contactState.filter((entry) => entry.departed).length,
  };

  if (standing.length > 0 && relationship.decisionMakers === 0) {
    concerns.push({
      kind: 'NOBODY_WHO_DECIDES',
      subject: `${standing.length} contact(s) at the client, and none of them signs off the next appointment`,
      consequence:
        'Knowing the people who run the current job and nobody who decides the next one feels like a strong ' +
        'relationship right up to the renewal, which is the point at which it turns out to have been a delivery ' +
        'relationship rather than a commercial one.',
    });
  }

  if (standing.length > 1 && relationship.ownerCount === 1) {
    concerns.push({
      kind: 'RELATIONSHIP_HELD_BY_ONE_PERSON',
      subject: `Every contact at the client is held by ${standing[0]!.ownedBy}`,
      consequence:
        'The relationship belongs to that employee rather than to this business, and it leaves when they do — ' +
        'usually to a competitor, and usually taking the renewal with it.',
    });
  }

  if (relationship.departedCount > 0) {
    const gone = contactState.filter((entry) => entry.departed);
    concerns.push({
      kind: 'COUNTERPART_HAS_GONE',
      subject: `${gone.length} contact(s) have left the client, including ${gone.map((entry) => entry.name).join(', ')}`,
      consequence:
        'Whatever this business had built with them is gone with them, and their replacement has no reason to ' +
        'prefer an incumbent they did not choose. This is the specific reason the next conversation starts colder ' +
        'than the last one.',
    });
  }

  if (assessedCount === 0) {
    concerns.push({
      kind: 'NOT_ASSESSED',
      subject: 'Nothing has been recorded about what keeps this business in the middle',
      consequence:
        'The suppliers on this appointment are being introduced to the client either way. Which of the five ' +
        'defences are actually in place is answerable now and unanswerable in the month before renewal.',
    });
  }

  const spec = defences.find((entry) => entry.kind === 'SPECIFICATION_OWNERSHIP')!;
  if (spec.assessed && !spec.inPlace) {
    concerns.push({
      kind: 'SPECIFICATION_NOT_OWNED',
      subject: 'The client buys against somebody else’s specification',
      consequence:
        'Whoever wrote the requirement owns it. If that is a panel supplier, this business is passing on a document ' +
        'the supplier could hand to the client itself, and the coordination is the only thing left to pay for.',
    });
  }

  if (largest && largest.sharePercent > threshold.percent) {
    if (largest.hasApproachedClient) {
      concerns.push({
        kind: 'CONCENTRATED_AND_APPROACHING',
        subject: `${largest.supplierName} holds ${largest.sharePercent}% of committed value and has approached the client directly`,
        consequence:
          'The acute case. A supplier large enough to be the service, that has already had the conversation. This ' +
          'is where the appointment is lost, and it is lost between two renewals rather than at one.',
      });
    } else {
      concerns.push({
        kind: 'SUPPLIER_CONCENTRATION',
        subject: `${largest.supplierName} holds ${largest.sharePercent}% of committed value, against ${threshold.percent}% (${threshold.source})`,
        consequence:
          'At this share the supplier is the service rather than part of it. The client can replace this business ' +
          'with one appointment, and the supplier can price that appointment because it knows what the work is worth.',
      });
    }
  }

  if (approaches.length > 0) {
    const proceeded = approaches.filter((entry) => entry.outcome === 'PROCEEDED').length;
    concerns.push({
      kind: 'DIRECT_APPROACHES',
      subject: `${approaches.length} direct approach(es) recorded${proceeded > 0 ? `, ${proceeded} of which went ahead without this business` : ''}`,
      consequence:
        'One is a conversation. A pattern is the appointment being priced by somebody else, and it shows up months ' +
        'before the renewal it decides.',
    });
  }

  if (framework && framework.daysRemaining <= config.billing.frameworkExpiryNoticeDays) {
    concerns.push({
      kind: 'FRAMEWORK_EXPIRING',
      subject: `${framework.reference} ends on ${framework.endsOn}, in ${framework.daysRemaining} day(s)`,
      consequence:
        'The only defence with a clock on it, and re-procuring a framework takes longer than the notice most ' +
        'businesses give themselves. After it ends the client is buying at will.',
    });
  }

  // Relying on the weakest of the five, alone.
  const nonCircumvention = defences.find((entry) => entry.kind === 'NON_CIRCUMVENTION')!;
  if (nonCircumvention.inPlace && inPlaceCount === 1) {
    concerns.push({
      kind: 'RELYING_ON_THE_WEAKEST',
      subject: 'A non-circumvention term is the only defence in place',
      consequence:
        'It binds the supplier and not the client. A client that decides to appoint the supplier directly is not a ' +
        'party to the term, so the one defence being relied on does not reach the party making the decision.',
    });
  }

  return {
    defences,
    inPlaceCount,
    assessedCount,
    shares,
    committedMinor,
    ...(largest ? { largestSharePercent: largest.sharePercent } : {}),
    concentrationThreshold: threshold,
    approaches: approaches
      .slice()
      .sort((a, b) => b.occurredOn.localeCompare(a.occurredOn))
      .map((entry) => ({
        supplierName: entry.supplierName,
        occurredOn: entry.occurredOn,
        what: entry.what,
        outcome: entry.outcome,
        outcomeLabel: OUTCOME_LABEL[entry.outcome],
      })),
    ...(framework ? { framework } : {}),
    relationship,
    concerns,
    summary: summarise({ inPlaceCount, assessedCount, largest, committedMinor, concerns: concerns.length }),
  };
}

function summarise(input: {
  inPlaceCount: number;
  assessedCount: number;
  largest?: SupplierShare;
  committedMinor: number;
  concerns: number;
}): string {
  const total = Object.keys(DEFENCE).length;

  // The concentration is stated in every branch, including this one.
  //
  // Nobody having assessed the defences says nothing about the share of the job
  // sitting with one supplier — that is measured off the committed subcontracts
  // and is true either way. An early return here dropped it, which is the same
  // failure the reserve sentence had on the cash side: a fact that *was*
  // measured, lost to a branch about something else.
  const defenceSentence =
    input.assessedCount === 0
      ? `None of the ${total} defences has been assessed, so how exposed this appointment is to being bought around is not known.`
      : `${input.inPlaceCount} of ${total} defences in place` +
        (input.assessedCount < total ? `, ${total - input.assessedCount} not yet assessed.` : '.');

  // Concentration is stated whether or not it raised a concern. A share under
  // the threshold is a measurement worth having, and "nothing to report" would
  // leave the reader unable to tell it from nothing having been measured.
  const concentrationSentence = input.largest
    ? ` The largest supplier holds ${input.largest.sharePercent}% of ${abbreviateMoney(input.committedMinor)} committed.`
    : ' Nothing has been committed to a supplier yet, so there is no concentration to measure.';

  return `${defenceSentence}${concentrationSentence}${input.concerns > 0 ? ` ${input.concerns} thing(s) need attention.` : ''}`;
}

/**
 * The share above which one supplier is the service rather than part of it.
 *
 * The business's own framework target wins where it has set one. A firm that
 * has said "no supplier above 30% of this framework" has already answered this
 * question with more care than a platform default can, and measuring it against
 * a different number would tell it it was fine while it was breaching its own
 * stated policy.
 */
function concentrationThreshold(ctx: EngineContext): { percent: number; source: string } {
  for (const state of ctx.ledger.list(`${ctx.tenantId}-governance`, 'Framework').map((r) => r.state)) {
    const target = (state.targets as { maxSharePerSupplierPercent?: number } | undefined)?.maxSharePerSupplierPercent;
    if (typeof target === 'number' && target > 0) {
      return { percent: target, source: `this business’s own target on ${String(state.reference)}` };
    }
  }
  return { percent: config.billing.supplierConcentrationPercent, source: 'the platform default' };
}

/** The framework term still running, and how long is left of it. */
function activeFramework(
  ctx: EngineContext,
  asAt: string,
): { reference: string; name: string; endsOn: string; daysRemaining: number } | undefined {
  const running = ctx.ledger
    .list(`${ctx.tenantId}-governance`, 'Framework')
    .map((r) => r.state as Record<string, unknown>)
    .filter((state) => String(state.status ?? '') === 'ACTIVE' && String(state.endsOn ?? '') >= asAt)
    .sort((a, b) => String(a.endsOn).localeCompare(String(b.endsOn)))[0];
  if (!running) return undefined;

  const endsOn = String(running.endsOn).slice(0, 10);
  return {
    reference: String(running.reference ?? ''),
    name: String(running.name ?? ''),
    endsOn,
    daysRemaining: Math.round((Date.parse(endsOn) - Date.parse(asAt)) / 86_400_000),
  };
}

// --- Who at the client this business actually knows ---------------------------

/**
 * The relationship, and who is holding it.
 *
 * The defence register asks whether the specification is ours and whether the
 * invoice is single. Neither survives the only person at the client who rates
 * us moving on, and neither survives the only person here who knows them
 * leaving either. That is not a soft risk: on a renewal it is usually the
 * deciding one, and it is knowable a year in advance and almost never written
 * down.
 *
 * ## What it holds, and what it deliberately does not
 *
 * A name, a role, and who here owns the relationship. That is business-contact
 * data with an obvious purpose, and it is the minimum that answers the
 * question. There is no field for a personal telephone number, a private email,
 * or a note about what somebody is like — this is not a place to build a file
 * on a person, and a schema with nowhere to put that is a better control than a
 * policy saying not to.
 *
 * ## The three things it is looking for
 *
 * **Nobody who decides.** Knowing the four people who run the current job and
 * nobody who signs the next appointment is the commonest version of this, and
 * it feels like a strong relationship right up to the renewal.
 *
 * **One person here holding everything.** If every contact is owned by one
 * employee, the relationship is theirs rather than the business's, and it
 * leaves with them — to a competitor, usually.
 *
 * **A counterpart who has gone.** A contact marked as having left is worth more
 * on the record than off it: it is the specific reason the next conversation
 * starts colder than the last one, and deleting the row loses that.
 */
export const CLIENT_ROLE = {
  DECISION_MAKER: {
    label: 'Signs off the next appointment',
    /** Without one of these, the relationship does not reach the renewal. */
    decides: true,
  },
  BUDGET_HOLDER: { label: 'Holds the budget this is paid from', decides: true },
  OPERATIONAL: { label: 'Runs the current job day to day', decides: false },
  TECHNICAL: { label: 'Sets or approves the requirement', decides: false },
  PROCUREMENT: { label: 'Runs the buying process', decides: false },
} as const;

export type ClientRole = keyof typeof CLIENT_ROLE;

type ContactState = {
  id: string;
  name: string;
  role: ClientRole;
  /** The employee here who holds this relationship. */
  ownedBy: string;
  /** True where this person has left the client, or the post. */
  departed: boolean;
  recordedBy: string;
  recordedAt: string;
};

/**
 * Record somebody at the client, and who here knows them.
 *
 * Marking a contact as departed rather than deleting them: the fact that the
 * person who rated this business has gone is the single most useful thing on
 * this register at a renewal, and a delete would take it away at exactly the
 * moment it started to matter.
 */
export function recordClientContact(
  ctx: EngineContext,
  input: { name: string; role: ClientRole; ownedBy: string; departed?: boolean; contactId?: string },
): { contactId: string; contacts: number } {
  authorise(ctx, 'BUDGET_COST', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  if (!(input.role in CLIENT_ROLE)) {
    throw new DomainError('CLIENT_ROLE_UNKNOWN', `${input.role} is not one of the client roles this platform recognises.`);
  }
  if (!input.name.trim()) {
    throw new DomainError('CONTACT_NAME_REQUIRED', 'A relationship is with a person. Name them.');
  }
  if (!input.ownedBy.trim()) {
    throw new DomainError(
      'CONTACT_OWNER_REQUIRED',
      'Say who here holds this relationship. A contact nobody owns is a name in a list, and the whole point of the ' +
        'register is to find out how much of the relationship rests on one person.',
    );
  }

  const record = ctx.ledger.list(ctx.projectId, 'IntermediationPosition')[0];
  const positionId = record?.refId ?? ulid();
  const state = (record?.state as Record<string, unknown> | undefined) ?? {
    id: positionId,
    projectId: ctx.projectId,
    defences: [],
    approaches: [],
    contacts: [],
  };

  const existing = ((state.contacts as ContactState[] | undefined) ?? []);
  const contactId = input.contactId ?? ulid();

  // The same person, twice.
  //
  // Recording a contact is the kind of command somebody runs again because they
  // are not sure it took the first time, and two rows for one person is not a
  // cosmetic duplicate here: the contact count and the owner count both drive
  // findings, so a register that quietly accumulates duplicates reports a
  // business as knowing six people at a client when it knows three.
  //
  // Two people at one client can share a name, so this is a refusal rather than
  // a silent merge, and it names the way to correct the existing row.
  const clash = existing.find(
    (entry) => entry.id !== contactId && entry.name.toLowerCase() === input.name.trim().toLowerCase(),
  );
  if (clash) {
    throw new DomainError(
      'CONTACT_ALREADY_RECORDED',
      `${clash.name} is already on this register, held by ${clash.ownedBy}. To change their part in the decision, ` +
        'who holds them, or to mark them as having left, update that entry rather than adding a second one — two ' +
        'rows for one person overstate how many people this business actually knows.',
      409,
    );
  }
  const contact: ContactState = {
    id: contactId,
    name: input.name.trim(),
    role: input.role,
    ownedBy: input.ownedBy.trim(),
    departed: input.departed === true,
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };

  const contacts = [...existing.filter((entry) => entry.id !== contactId), contact];

  write(ctx, {
    eventType: 'CLIENT_CONTACT_RECORDED',
    entity: { refType: 'IntermediationPosition', refId: positionId },
    reason: `${contact.name}, ${CLIENT_ROLE[input.role].label.toLowerCase()}${contact.departed ? ' (departed)' : ''}`,
    nextState: { ...state, id: positionId, projectId: ctx.projectId, contacts },
  });

  return { contactId, contacts: contacts.length };
}

export type ClientRelationship = {
  contacts: Array<{ contactId: string; name: string; role: ClientRole; roleLabel: string; ownedBy: string; departed: boolean }>;
  /** People still in post who can decide or fund the next appointment. */
  decisionMakers: number;
  /** How many employees here hold the relationship between them. */
  ownerCount: number;
  departedCount: number;
};

// --- The same supplier, seen across every job ---------------------------------

/**
 * What one supplier is worth to this business, rather than to one appointment.
 *
 * `intermediationPosition` measures concentration on the job it is asked about,
 * and that is the wrong denominator for the question a director actually has.
 * A supplier holding twenty per cent of five appointments is under every
 * project-level threshold on every one of them, and is the largest single
 * dependency the business has. Read one project at a time it is invisible;
 * there is no reading order that makes it appear.
 *
 * So this uses the tenancy as the denominator, and reports both numbers side by
 * side. The pair is the point: a supplier whose tenancy share is over the
 * threshold while its largest project share is under it is the case that only
 * exists across projects, and it is named as its own finding rather than left
 * for somebody to spot.
 *
 * Two more things only this scope can see. **How many projects** a supplier is
 * on — one at eighty per cent is a package, five at twenty per cent is the
 * business. And **approaches on more than one job**: a supplier that has gone to
 * two different clients directly is telling you something about the supplier,
 * which no single project's register can say.
 */
export type SupplierExposure = {
  supplierPartyId: string;
  supplierName: string;
  committedMinor: number;
  /** Share of everything this business has committed to anybody. */
  tenantSharePercent: number;
  /** The largest share this supplier holds on any single appointment. */
  largestProjectSharePercent: number;
  projects: Array<{ projectId: string; projectName: string; committedMinor: number; projectSharePercent: number }>;
  /** Projects on which this supplier has been recorded approaching the client. */
  approachedOnProjects: number;
  /**
   * The largest counterparty this business has, on more than one appointment,
   * and under the project threshold on every one of them.
   *
   * The finding the per-project view cannot produce — not because the numbers
   * are hidden but because no single project's review has anything to compare
   * against. Every job says "twenty per cent, unremarkable"; nobody is asked
   * whether the same firm said that five times.
   *
   * The first attempt at this defined it as a tenancy share above the threshold
   * with every project share below it, which is impossible: a tenancy share is
   * the value-weighted mean of the project shares, and a mean is never above
   * the maximum. That condition could not fire, and a mutation that switched
   * the whole finding off passed every test — which is what a dead branch looks
   * like from the outside.
   */
  hiddenByProjectView: boolean;
};

export type ExposureConcern = {
  kind: 'HIDDEN_CONCENTRATION' | 'TENANT_CONCENTRATION' | 'ON_EVERY_PROJECT' | 'APPROACHING_MORE_THAN_ONE_CLIENT';
  supplierName: string;
  subject: string;
  consequence: string;
};

export type SupplierExposureView = {
  committedMinor: number;
  projectCount: number;
  suppliers: SupplierExposure[];
  threshold: { percent: number; source: string };
  concerns: ExposureConcern[];
  summary: string;
};

/**
 * Every supplier this business buys from, across every appointment.
 *
 * Tenant-scoped, so it reads `listByTenant` rather than one project. That is
 * the whole reason it exists and it is also the reason it is authorised the
 * same way as the commercial position: this is the shape of the business's
 * dependency on its supply chain, and it is not a project team's to read.
 */
export function supplierExposure(ctx: EngineContext): SupplierExposureView {
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const projectNames = new Map(
    ctx.ledger.listByTenant(ctx.tenantId, 'Project').map((record) => [record.refId, String(record.state.name ?? record.refId)]),
  );

  // Approaches are recorded per project, so the set of (supplier, project)
  // pairs has to be built across all of them before any supplier is counted.
  const approachedOn = new Map<string, Set<string>>();
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'IntermediationPosition')) {
    for (const approach of (record.state.approaches as Array<{ supplierPartyId: string }> | undefined) ?? []) {
      const seen = approachedOn.get(approach.supplierPartyId) ?? new Set<string>();
      seen.add(record.projectId);
      approachedOn.set(approach.supplierPartyId, seen);
    }
  }

  return exposureOf({
    subcontracts: ctx.ledger
      .listByTenant(ctx.tenantId, 'Subcontract')
      .map((record) => ({ projectId: record.projectId, state: record.state })),
    projectNames,
    approachedOn,
    threshold: concentrationThreshold(ctx),
  });
}

/**
 * The exposure arithmetic, separated from the ledger read.
 *
 * For the same reason `sharesOf` is: the demonstration seed lets one package on
 * one project, so nothing built from it can exercise the case this whole view
 * exists for — a supplier under the threshold on every job and over it across
 * the business. Three mutations proved it, including one that switched off the
 * headline finding entirely and passed.
 *
 * A test that cannot construct the case it is about is not testing it.
 */
export function exposureOf(input: {
  subcontracts: Array<{ projectId: string; state: Record<string, unknown> }>;
  projectNames: ReadonlyMap<string, string>;
  approachedOn: ReadonlyMap<string, ReadonlySet<string>>;
  threshold: { percent: number; source: string };
}): SupplierExposureView {
  const { projectNames, approachedOn, threshold } = input;

  const byProject = new Map<string, Array<Record<string, unknown>>>();
  for (const record of input.subcontracts) {
    byProject.set(record.projectId, [...(byProject.get(record.projectId) ?? []), record.state]);
  }

  // Each project's own shares, computed by the same function the per-project
  // view uses. Two ways of working out a share would be two answers.
  const projectShares = new Map<string, SupplierShare[]>();
  for (const [projectId, states] of byProject) {
    projectShares.set(projectId, sharesOf(states).shares);
  }

  const tenant = sharesOf(input.subcontracts.map((record) => record.state));

  const suppliers: SupplierExposure[] = tenant.shares.map((share) => {
    const projects = [...projectShares.entries()]
      .map(([projectId, shares]) => ({ projectId, entry: shares.find((s) => s.supplierPartyId === share.supplierPartyId) }))
      .filter((row): row is { projectId: string; entry: SupplierShare } => row.entry !== undefined)
      .map((row) => ({
        projectId: row.projectId,
        projectName: projectNames.get(row.projectId) ?? row.projectId,
        committedMinor: row.entry.committedMinor,
        projectSharePercent: row.entry.sharePercent,
      }))
      .sort((a, b) => b.committedMinor - a.committedMinor);

    const largestProjectSharePercent = projects.reduce((worst, entry) => Math.max(worst, entry.projectSharePercent), 0);

    return {
      supplierPartyId: share.supplierPartyId,
      supplierName: share.supplierName,
      committedMinor: share.committedMinor,
      tenantSharePercent: share.sharePercent,
      largestProjectSharePercent,
      projects,
      approachedOnProjects: approachedOn.get(share.supplierPartyId)?.size ?? 0,
      // Filled in below: it needs every supplier's tenancy share to know which
      // one is largest, so it cannot be decided while building the list.
      hiddenByProjectView: false,
    };
  });

  // The largest counterparty in the business. `sharesOf` returns largest first,
  // so it is the head of the list — and it is only *hidden* if it spans more
  // than one appointment and breaches nothing on any of them. On one job it is
  // not hidden at all: that job's own review sees it.
  const biggest = suppliers[0];
  if (biggest && biggest.projects.length > 1 && biggest.largestProjectSharePercent <= threshold.percent) {
    biggest.hiddenByProjectView = true;
  }

  const projectCount = byProject.size;
  const concerns: ExposureConcern[] = [];

  for (const supplier of suppliers) {
    if (supplier.hiddenByProjectView) {
      concerns.push({
        kind: 'HIDDEN_CONCENTRATION',
        supplierName: supplier.supplierName,
        subject:
          `${supplier.supplierName} is the largest counterparty this business has — ${supplier.tenantSharePercent}% ` +
          `across ${supplier.projects.length} appointments — and breaches nothing on any of them, at no more than ` +
          `${supplier.largestProjectSharePercent}% of a single job`,
        consequence:
          'Every project review says "unremarkable" and none of them is asked whether the same firm said that five ' +
          'times. Losing this supplier disrupts every one of those appointments on the same day, which is a bigger ' +
          'event than losing a larger share of one job.',
      });
    }
    if (!supplier.hiddenByProjectView && supplier.tenantSharePercent > threshold.percent) {
      concerns.push({
        kind: 'TENANT_CONCENTRATION',
        supplierName: supplier.supplierName,
        subject: `${supplier.supplierName} is ${supplier.tenantSharePercent}% of everything this business has committed`,
        consequence:
          'At this share the supply chain is one firm. Their insolvency, their price rise and their decision to work ' +
          'for somebody else are all the same event for this business.',
      });
    }

    // On every job the business is running. A different fact from a large
    // share: it is about how replaceable the relationship is rather than how
    // much of it there is.
    if (projectCount > 1 && supplier.projects.length === projectCount) {
      concerns.push({
        kind: 'ON_EVERY_PROJECT',
        supplierName: supplier.supplierName,
        subject: `${supplier.supplierName} is on all ${projectCount} appointments`,
        consequence:
          'Every client this business has now knows this supplier. That is a reference the supplier can use, and it ' +
          'is a single point of failure across the whole book rather than on one job.',
      });
    }

    if (supplier.approachedOnProjects > 1) {
      concerns.push({
        kind: 'APPROACHING_MORE_THAN_ONE_CLIENT',
        supplierName: supplier.supplierName,
        subject: `${supplier.supplierName} has approached the client directly on ${supplier.approachedOnProjects} different appointments`,
        consequence:
          'Twice with two different clients is not a misunderstanding about one job. It is how this supplier ' +
          'intends to grow, and the next approach is already priced into their planning if not into this ' +
          'business’s.',
      });
    }
  }

  return {
    committedMinor: tenant.committedMinor,
    projectCount,
    suppliers,
    threshold,
    concerns,
    summary: exposureSummary(suppliers, tenant.committedMinor, projectCount, concerns.length),
  };
}

function exposureSummary(
  suppliers: SupplierExposure[],
  committedMinor: number,
  projectCount: number,
  concerns: number,
): string {
  if (suppliers.length === 0) {
    return 'Nothing has been committed to a supplier on any appointment, so there is no exposure to measure yet.';
  }
  const largest = suppliers[0]!;
  return (
    `${suppliers.length} supplier(s) across ${projectCount} appointment(s), ${abbreviateMoney(committedMinor)} committed. ` +
    `The largest is ${largest.supplierName} at ${largest.tenantSharePercent}%.` +
    (concerns > 0 ? ` ${concerns} thing(s) need attention.` : '')
  );
}
