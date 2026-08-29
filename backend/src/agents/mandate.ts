import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { lookupEventType } from '../goldenthread/eventTypes.ts';
import { agentByName } from './registry.ts';
import { exceeds, type AutonomyLevel } from './types.ts';

/**
 * Granting an agent the authority to act, and taking it back.
 *
 * The mandate ladder is OBSERVE → DRAFT → PROPOSE → ACT, and only the last rung
 * needs a mechanism, because only the last rung removes the human. Everything
 * below it already has one: an observation is a finding, a draft is held, a
 * proposal sits in a queue until somebody with the capability decides.
 *
 * ## Declaring is not granting
 *
 * `registry.ts` declares which agents are *eligible* for ACT and the outside
 * edge of what such a grant could ever cover — named commands, a value ceiling,
 * and a sentence saying why. That declaration confers nothing. Until a human
 * holding governance authority over the enterprise grants a live envelope
 * through this module, an ACT-eligible agent behaves exactly like a PROPOSE
 * one: it queues, and somebody decides.
 *
 * The separation is the whole safety property. If the registry alone conferred
 * autonomy then editing a source file would be how a machine acquired
 * unattended authority over a customer's project — a code review, not a
 * decision anybody made, with no record in the ledger and nobody's name on it.
 * `tests/mandate.test.ts` fails if an agent can reach ACT without a grant.
 *
 * ## What a grant cannot do
 *
 * A grant may narrow the declared envelope. Nothing widens it:
 *
 *   - a command not in the agent's declared list is refused at grant time;
 *   - a value ceiling above the declared one is refused at grant time;
 *   - a command whose event type is `aiAllowed: false` is refused at grant
 *     time *and* would fail again in `commit()` — the catalogue is the real
 *     boundary and this is the early, readable half of it. Certifying payment,
 *     approving a variation, signing a gate decision, issuing a statutory
 *     notice, closing an NCR, accepting handover and granting a role are all
 *     marked so, and none of them can be put inside an envelope;
 *   - an envelope has a window with an end. There is no open-ended grant,
 *     because the grant nobody remembers making is the one still running in
 *     three years.
 *
 * ## Revocation takes effect on the next tick
 *
 * Revoking sets an end, it does not reach into a run already in flight. An act
 * already executing completes and is recorded; the next evaluation finds no
 * live envelope. Pretending otherwise would mean claiming the platform can
 * interrupt a command mid-write, which it cannot, and a safety story that is
 * not true is worse than a narrow one that is.
 */

export type ActEnvelope = {
  id: string;
  agent: string;
  /** Exactly the commands this grant covers — never wider than the declaration. */
  commands: string[];
  /** The most one unattended act may be worth. Zero means acts carry no value. */
  valueCeilingMinor: number;
  /** Inclusive date the grant starts, `YYYY-MM-DD`. */
  from: string;
  /** Inclusive date the grant ends. Always present: no grant is open-ended. */
  until: string;
  grantedBy: string;
  grantedAt: string;
  /** Why this business wanted it, in the granter's words. */
  note: string;
  revokedBy?: string;
  revokedAt?: string;
  revokedReason?: string;
};

/** The longest window a grant may cover. A year is a decision; three is a forgotten one. */
export const MAX_ENVELOPE_DAYS = 366;

const DAY_MS = 86_400_000;

function envelopes(ctx: EngineContext): ActEnvelope[] {
  return ctx.ledger
    .list(ctx.projectId, 'AgentEnvelope')
    .map((record) => record.state as unknown as ActEnvelope);
}

/**
 * Grant an agent the authority to run named commands unattended.
 *
 * Authorised against `ENTERPRISE_STRUCTURE` `G` — governance over the
 * enterprise itself, which within a tenancy only `ENTERPRISE_ADMIN` holds. Not
 * `AI_EXECUTION`: every role that runs AI holds `X` on that area, and deciding
 * that a machine may act without asking is not the same kind of act as asking
 * it a question.
 */
export function grantEnvelope(
  ctx: EngineContext,
  input: {
    agent: string;
    commands: string[];
    valueCeilingMinor?: number;
    from: string;
    until: string;
    note: string;
  },
): ActEnvelope {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');

  const agent = agentByName(input.agent);
  if (!agent) {
    throw new DomainError('AGENT_UNKNOWN', `There is no agent named "${input.agent}"`, 404);
  }

  const declared = agent.mandate.envelope;
  if (agent.mandate.maxUnattended !== 'ACT' || !declared) {
    throw new DomainError(
      'AGENT_NOT_ACT_ELIGIBLE',
      `${agent.name} declares a ceiling of ${agent.mandate.maxUnattended}. An agent that has not been written to act ` +
        'unattended cannot be granted authority to; raising it is a change to the agent, reviewed as one.',
    );
  }

  if (input.commands.length === 0) {
    throw new DomainError('AGENT_ENVELOPE_EMPTY', 'An envelope granting no commands grants nothing. Name what it covers.');
  }

  for (const command of input.commands) {
    if (!declared.commands.includes(command)) {
      throw new DomainError(
        'AGENT_ENVELOPE_EXCEEDS_DECLARATION',
        `${agent.name} may only ever be granted ${declared.commands.join(', ')}. "${command}" is outside that, ` +
          'so it cannot be granted here — widening it is a change to the agent.',
      );
    }
    assertCommandMayBeAutomated(command);
  }

  const ceiling = input.valueCeilingMinor ?? declared.valueCeilingMinor;
  if (ceiling > declared.valueCeilingMinor) {
    throw new DomainError(
      'AGENT_ENVELOPE_EXCEEDS_DECLARATION',
      `${agent.name} declares a ceiling of ${declared.valueCeilingMinor} minor units. A grant may lower it, never raise it.`,
    );
  }
  if (ceiling < 0) {
    throw new DomainError('AGENT_ENVELOPE_INVALID', 'A value ceiling cannot be negative.');
  }

  const span = Math.round((Date.parse(input.until) - Date.parse(input.from)) / DAY_MS);
  if (Number.isNaN(span)) {
    throw new DomainError('AGENT_ENVELOPE_INVALID', 'A grant needs a start and an end, both as YYYY-MM-DD.');
  }
  if (span < 0) {
    throw new DomainError('AGENT_ENVELOPE_INVALID', 'A grant cannot end before it starts.');
  }
  if (span > MAX_ENVELOPE_DAYS) {
    throw new DomainError(
      'AGENT_ENVELOPE_TOO_LONG',
      `A grant may run for at most ${MAX_ENVELOPE_DAYS} days. Renewing is a decision somebody takes again; ` +
        'an open-ended one is a decision nobody remembers taking.',
    );
  }
  if (input.note.trim().length < 8) {
    throw new DomainError(
      'AGENT_ENVELOPE_REASON_REQUIRED',
      'Say why this business wants this agent acting unattended. The record is read by whoever asks later.',
    );
  }

  // One agent, one grant at a time.
  //
  // Two overlapping envelopes for the same agent is ambiguous authority, and
  // every way of resolving it is wrong in a different direction: taking the
  // union silently widens what somebody granted, taking the newest silently
  // narrows it, and taking the first makes a later grant do nothing. So the
  // platform refuses and says which grant is in the way — the granter withdraws
  // it, on the record, and grants what they meant.
  const clash = envelopes(ctx).find(
    (existing) =>
      existing.agent === agent.name &&
      !existing.revokedAt &&
      existing.from <= input.until &&
      existing.until >= input.from,
  );
  if (clash) {
    throw new DomainError(
      'AGENT_ENVELOPE_OVERLAPS',
      `${agent.name} already holds a grant running ${clash.from} to ${clash.until}. Withdraw it before granting another: ` +
        'two overlapping grants for one agent means nobody can say what it is authorised to do.',
      409,
    );
  }

  const envelope: ActEnvelope = {
    id: ulid(),
    agent: agent.name,
    commands: [...input.commands],
    valueCeilingMinor: ceiling,
    from: input.from,
    until: input.until,
    grantedBy: ctx.auth.actorId,
    grantedAt: new Date().toISOString(),
    note: input.note.trim(),
  };

  write(ctx, {
    eventType: 'AGENT_ENVELOPE_GRANTED',
    entity: { refType: 'AgentEnvelope', refId: envelope.id },
    nextState: envelope as unknown as Record<string, unknown>,
  });

  return envelope;
}

/** Withdraw a grant. Takes effect on the next evaluation, not mid-flight. */
export function revokeEnvelope(ctx: EngineContext, input: { envelopeId: string; reason: string }): ActEnvelope {
  authorise(ctx, 'ENTERPRISE_STRUCTURE', 'G');

  const record = ctx.ledger.get({ refType: 'AgentEnvelope', refId: input.envelopeId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('AGENT_ENVELOPE_NOT_FOUND', `No envelope ${input.envelopeId}`, 404);
  }
  const envelope = record.state as unknown as ActEnvelope;
  if (envelope.revokedAt) {
    throw new DomainError('AGENT_ENVELOPE_ALREADY_REVOKED', `That grant was already withdrawn on ${envelope.revokedAt}`, 409);
  }
  if (input.reason.trim().length < 4) {
    throw new DomainError('AGENT_ENVELOPE_REASON_REQUIRED', 'Say why the grant is being withdrawn.');
  }

  const revoked: ActEnvelope = {
    ...envelope,
    revokedBy: ctx.auth.actorId,
    revokedAt: new Date().toISOString(),
    revokedReason: input.reason.trim(),
  };

  write(ctx, {
    eventType: 'AGENT_ENVELOPE_REVOKED',
    entity: { refType: 'AgentEnvelope', refId: envelope.id },
    nextState: revoked as unknown as Record<string, unknown>,
  });

  return revoked;
}

/**
 * The live grant for an agent, if there is one.
 *
 * "Live" means granted, not revoked, and inside its window on the day asked
 * about. A revoked grant and an expired one are both simply absent — the
 * distinction is in the record, not in what an agent may do.
 */
export function liveEnvelope(ctx: EngineContext, agent: string, today?: string): ActEnvelope | undefined {
  const day = today ?? new Date().toISOString().slice(0, 10);
  return envelopes(ctx)
    .filter(
      (envelope) =>
        envelope.agent === agent &&
        !envelope.revokedAt &&
        envelope.from <= day &&
        envelope.until >= day,
    )
    .at(-1);
}

/** Every grant ever made, newest last, for the screen that shows who gave what to whom. */
export function envelopeRegister(ctx: EngineContext, today?: string): Array<ActEnvelope & { live: boolean }> {
  const day = today ?? new Date().toISOString().slice(0, 10);
  return envelopes(ctx).map((envelope) => ({
    ...envelope,
    live: !envelope.revokedAt && envelope.from <= day && envelope.until >= day,
  }));
}

/**
 * Refuse a command the event catalogue has closed to machines.
 *
 * The catalogue is the boundary and `commit()` is where it bites — an AI actor
 * committing an `aiAllowed: false` type is a hard failure there, not a rejected
 * request. This is the early half: refusing at grant time means the answer
 * arrives while somebody is reading a screen about authority, rather than as a
 * failed run at two in the morning.
 *
 * Commands are named `module:function` and carry no event type, so what is
 * checked is the set of types the command's own name maps to. Where a command
 * is not in the map it is refused: an unknown command cannot be shown to be
 * safe, and "not listed" is not "harmless".
 */
export function assertCommandMayBeAutomated(command: string): void {
  const entry = AUTOMATABLE_COMMANDS[command];
  if (!entry) {
    throw new DomainError(
      'AGENT_COMMAND_UNKNOWN',
      `"${command}" is not a command this platform can reason about, so it cannot be shown to be safe to automate. ` +
        'Add it to AUTOMATABLE_COMMANDS with the event types it writes.',
    );
  }
  for (const type of entry.writes) {
    const definition = lookupEventType(type);
    if (!definition) {
      throw new DomainError(
        'AGENT_COMMAND_UNKNOWN',
        `"${command}" is declared as writing ${type}, which is not in the event catalogue.`,
      );
    }
    if (!definition.aiAllowed) {
      throw new DomainError(
        'AGENT_COMMAND_NOT_AUTOMATABLE',
        `"${command}" writes ${type}, which the event catalogue marks as a decision a person takes. ` +
          'No envelope can cover it, and an AI actor committing it fails in the ledger.',
      );
    }
  }
}

/**
 * Every command an envelope may name, and what each one writes.
 *
 * Deliberately small and explicit rather than derived. Deriving it would mean
 * running the command to find out, and the whole point is to answer "could this
 * be automated" *without* running anything. Each entry is reversible, bounded in
 * value and creates no liability — the three tests set for ACT eligibility.
 *
 * `writes: []` is a real answer, not an omission: it says the command changes no
 * governed state at all. The health agent's acts are of that kind — a queued
 * notice is not an event in a project's chain, and writing one there would put
 * platform operations inside a customer's evidential record.
 */
export const AUTOMATABLE_COMMANDS: Record<string, { writes: string[]; note: string }> = {
  'ops:alert': {
    writes: [],
    // The narrowest possible envelope, and the only one granted anywhere today.
    // Telling somebody the platform is unwell cannot damage a project, cannot
    // be undone wrongly, and costs nothing.
    note: 'Queues a platform alert through the outbox. Writes no governed state and carries no value.',
  },
  'ops:resolve': {
    writes: [],
    note: 'Queues the recovery notice for an alert that has cleared. Writes no governed state.',
  },
  /**
   * The return register off an invitation the platform has already read.
   *
   * The first entry here that writes governed state, and it earns that against
   * the three tests set for ACT eligibility.
   *
   * **Reversible.** The register is a list of what must go back — references,
   * formats, page limits, internal dates, owners. Every line is editable
   * afterwards through the same commands a person uses, and the event is an
   * UPDATE on an invitation that already exists.
   *
   * **Bounded in value.** It carries no money. Filing it commits nobody to a
   * price, a programme or a term.
   *
   * **Creates no liability.** This is the clerical half of reading an ITT:
   * transcribing forty return items with their dates and formats. The half
   * that carries judgement — is this requirement really mandatory, is fitness
   * for purpose acceptable, is the job worth chasing — is `ITT_ANALYSED`,
   * which the catalogue marks as a decision a person takes and which therefore
   * no envelope can ever cover. The split is the point: the machine does the
   * transcription, the human keeps the judgement.
   *
   * The worst case if the reading is wrong is a register with a wrong due date
   * in it, on a screen the bid team works from daily, against a document they
   * hold. That is a bad afternoon. It is not a bid submitted on terms nobody
   * checked, which is what automating the analysis would risk.
   */
  'tenderintake:extractRequirements': {
    writes: ['TENDER_REQUIREMENTS_EXTRACTED'],
    note:
      'Files the return register read off an invitation: what must go back, in what format, by when and to whom. ' +
      'Carries no value, changes no commercial position, and every line stays editable. The compliance matrix and ' +
      'the commercial assessment are not part of it and cannot be.',
  },
};

/**
 * Whether an agent may take this act unattended right now, and if not, why not.
 *
 * Returns a reason rather than throwing, because the caller's correct response
 * is to fall back to a proposal — the work still needs surfacing. A refusal
 * that lost the finding would trade a small safety gain for a large one.
 */
export function mayActUnattended(
  ctx: EngineContext,
  agentName: string,
  input: { command: string; valueMinor?: number; today?: string },
): { permitted: true; envelope: ActEnvelope } | { permitted: false; because: string } {
  const agent = agentByName(agentName);
  if (!agent) return { permitted: false, because: `There is no agent named "${agentName}".` };

  if (exceeds('ACT', agent.mandate.maxUnattended)) {
    return {
      permitted: false,
      because: `${agentName} has a ceiling of ${agent.mandate.maxUnattended}, so it proposes and a person decides.`,
    };
  }

  const envelope = liveEnvelope(ctx, agentName, input.today);
  if (!envelope) {
    return {
      permitted: false,
      because:
        `${agentName} is eligible to act but holds no live grant. Eligibility is declared in code; ` +
        'authority is granted by a person, and none has been.',
    };
  }
  if (!envelope.commands.includes(input.command)) {
    return { permitted: false, because: `The live grant for ${agentName} does not cover "${input.command}".` };
  }
  const value = input.valueMinor ?? 0;
  if (value > envelope.valueCeilingMinor) {
    return {
      permitted: false,
      because: `This act is worth ${value} minor units and the grant stops at ${envelope.valueCeilingMinor}.`,
    };
  }

  try {
    assertCommandMayBeAutomated(input.command);
  } catch (error) {
    return { permitted: false, because: (error as DomainError).message };
  }

  return { permitted: true, envelope };
}

/** The ladder, described once, for the screen and the documentation both. */
export const LADDER: Array<{ level: AutonomyLevel; what: string; humanInTheLoop: string }> = [
  {
    level: 'OBSERVE',
    what: 'Reads and reports. Produces findings, never a command.',
    humanInTheLoop: 'Nothing happens without one. The finding is the whole output.',
  },
  {
    level: 'DRAFT',
    what: 'Prepares a complete, valid command and holds it. Nothing reaches the ledger.',
    humanInTheLoop: 'A person reads the exact body that would be submitted, and submits it.',
  },
  {
    level: 'PROPOSE',
    what: 'Places the command in the approval queue scoped to its capability area.',
    humanInTheLoop: 'A named role with that capability approves, rejects or mitigates, and the platform executes as them.',
  },
  {
    level: 'ACT',
    what: 'Executes unattended inside a granted envelope: named commands, a value ceiling and an end date.',
    humanInTheLoop:
      'One, earlier: an enterprise administrator granted the envelope, on the record, and can withdraw it. ' +
      'No agent can grant one to itself.',
  },
];
