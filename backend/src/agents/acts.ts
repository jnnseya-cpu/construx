import { DomainError } from '../core/errors.ts';
import type { EngineContext } from '../engines/context.ts';
import * as tenderintake from '../domain/tenderintake.ts';
import { AUTOMATABLE_COMMANDS } from './mandate.ts';

/**
 * Running an act, as opposed to being allowed to run one.
 *
 * The mandate ladder is OBSERVE → DRAFT → PROPOSE → ACT, and until now the top
 * rung was a declaration with nothing under it. `registry.ts` could declare an
 * agent eligible, `mandate.ts` could grant an envelope, `runtime.ts` checked the
 * grant and degraded to a proposal when there was none — and when there *was*
 * one it raised a proposal anyway. Every part of the authority story was built
 * and nothing ever executed. An envelope granted an agent permission to do
 * something the platform had no way to do.
 *
 * This is that missing half, and it is deliberately the smallest thing that can
 * be one.
 *
 * ## Why a hand-written map and not a dispatcher
 *
 * The obvious implementation is a lookup from `module:function` to the export
 * of that name, and it would be a hole straight through the safety model: any
 * function that ever gains that name becomes reachable by a machine, and
 * whether it was safe to automate would be decided by a naming convention. So
 * the map is written out. Adding an entry is a deliberate act with a reviewer
 * on it, which is the same reasoning `AUTOMATABLE_COMMANDS` is written out for.
 *
 * Every executor here must also be declared in `AUTOMATABLE_COMMANDS` — the two
 * answer different questions, "could this be automated" and "how", and a
 * command that can be run but was never shown to be safe is the dangerous half
 * of the pair. `tests/mandate.test.ts` fails if one exists without the other.
 *
 * ## What an act is attributed to
 *
 * The agent, through `ctx.actingAs`. Authority is a separate question and is
 * unchanged: the act runs under the permissions of the identity whose session
 * ran the fleet, so an agent can never reach further than the person it ran
 * for, and the ledger refuses an AI author outright on any event the catalogue
 * marks as a decision a person takes.
 */

/** Runs the command and returns a sentence saying what it did. */
type Executor = (ctx: EngineContext, input: Record<string, unknown>) => string;

const EXECUTORS: Record<string, Executor> = {
  /**
   * File the return register read off an invitation.
   *
   * No `analysisId`: the register is filed ahead of the compliance matrix, on
   * purpose. The matrix is `ITT_ANALYSED`, which the catalogue marks as a
   * decision a person takes, and coupling the two would have meant either
   * automating the judgement or automating nothing. The analysis links itself
   * to the register when a person confirms it.
   */
  'tenderintake:extractRequirements': (ctx, input) => {
    const invitationId = String(input.invitationId ?? '');
    if (invitationId === '') {
      throw new DomainError('AGENT_ACT_INPUT_INVALID', 'A return register has to be filed against an invitation');
    }

    const deliverables = input.deliverables as tenderintake.TenderDeliverable[] | undefined;
    if (!Array.isArray(deliverables) || deliverables.length === 0) {
      throw new DomainError('AGENT_ACT_INPUT_INVALID', 'A return register with nothing in it is not a reading');
    }

    const filed = tenderintake.extractRequirements(ctx, invitationId, { deliverables });
    const mandatory = deliverables.filter((deliverable) => deliverable.mandatory).length;
    return (
      `Filed ${filed.deliverables} return item(s), ${mandatory} of them mandatory` +
      `${filed.blockers.length > 0 ? `, with ${filed.blockers.length} still blocking the bid` : ''}.`
    );
  },
};

/** Whether the platform knows how to run this command unattended. */
export function actIsExecutable(command: string): boolean {
  return command in EXECUTORS;
}

/** Every command an agent can actually run, for the register that publishes them. */
export function executableCommands(): string[] {
  return Object.keys(EXECUTORS).sort();
}

/**
 * Run one act.
 *
 * Refuses rather than guesses. A command with a grant behind it and no executor
 * is a real state — an envelope names what an agent *may* do, and this file
 * names what it *can* — and the honest answer is a refusal the caller turns
 * back into a proposal, not a silent success that changed nothing.
 */
export function executeAct(ctx: EngineContext, command: string, input: Record<string, unknown>): string {
  if (!AUTOMATABLE_COMMANDS[command]) {
    throw new DomainError(
      'AGENT_COMMAND_NOT_AUTOMATABLE',
      `"${command}" is not declared automatable, so it cannot be run unattended whatever an envelope says.`,
    );
  }

  const executor = EXECUTORS[command];
  if (!executor) {
    throw new DomainError(
      'AGENT_ACT_NOT_EXECUTABLE',
      `"${command}" may be granted to an agent but this platform has no way to run it unattended. ` +
        'It has to be approved and carried out by a person.',
    );
  }

  return executor(ctx, input);
}
