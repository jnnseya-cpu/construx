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
    | 'RELYING_ON_THE_WEAKEST';
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
