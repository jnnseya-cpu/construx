import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { lookupEventType } from '../goldenthread/eventTypes.ts';

/**
 * What a person decided about an AI output.
 *
 * The third of the three things every stage gate's fifth clause asks for and
 * the platform did not record. The other two are properties of the call and are
 * written onto the event by `runAI`: `assumptions` — what the model took as
 * given, `[]` where it declared none — and `promptVersion`, derived from the
 * task and response schema actually sent.
 *
 * This one is different in kind and that is why it is a separate event. A
 * disposition is a **later act by a different party**: the model writes, and
 * afterwards a person decides whether to stand behind it. On an append-only
 * ledger a field cannot be filled in later, so the decision is its own record
 * pointing back at the execution.
 *
 * **A model cannot dispose of its own output.** `AI_OUTPUT_DISPOSED` is
 * `aiAllowed: false` in the catalogue and the command authorises against
 * `AI_EXECUTION` approve, so the act requires a human mandate. An engine
 * marking its own work as accepted is precisely the failure the clause exists
 * to catch.
 *
 * **Three answers, not two.** Accepting an output unchanged and accepting it
 * after correcting it are different facts about how much the model was worth,
 * and collapsing them would make the platform's own record of AI usefulness
 * meaningless. A rejection needs a reason; so does a change.
 */

export const AI_DISPOSITION = ['ACCEPTED', 'ACCEPTED_WITH_CHANGE', 'REJECTED'] as const;
export type AIDisposition = (typeof AI_DISPOSITION)[number];

export type AIDispositionState = {
  executionId: string;
  aiRequestId?: string;
  decision: AIDisposition;
  /** Required on anything but a clean acceptance. */
  reason?: string;
  disposedBy: string;
  disposedAt: string;
};

type ExecutionRecord = {
  id: string;
  aiRequestId?: string;
  engine?: string;
  taskType?: string;
  /** Merged onto the execution by `disposeAIOutput`, absent until then. */
  disposition?: AIDispositionState;
};

/**
 * Every AI execution on this project.
 *
 * Read from the materialised entity rather than from the event stream. The
 * disposition is merged onto the execution's own record — an execution and
 * what somebody decided about it are one thing, and splitting them across two
 * reads is how a screen ends up showing an output with no decision beside it.
 */
function executionsOf(ctx: EngineContext): ExecutionRecord[] {
  return ctx.ledger
    .list(ctx.projectId, 'AIExecution')
    .map((record) => record.state as unknown as ExecutionRecord);
}

/**
 * Record a person's decision about an AI output.
 *
 * Idempotent in the direction that matters: a second disposition of the same
 * execution is refused rather than silently overwriting the first. Somebody
 * changing their mind is a new fact and needs a new reason; quietly replacing
 * an acceptance with a rejection would erase the record that it was ever
 * accepted, which is the thing a dispute turns on.
 */
export function disposeAIOutput(
  ctx: EngineContext,
  input: { executionId: string; decision: AIDisposition; reason?: string },
): { executionId: string; decision: AIDisposition } {
  // `X`, not `A`. Nobody in the permission matrix holds approve on
  // AI_EXECUTION — it is an execute-and-read area — so authorising on approve
  // would have made the disposition permanently unfillable, which is exactly
  // the class of defect this whole clause exists to surface.
  //
  // Execute is also the right authority on its own terms: you may judge the
  // output of a task you were entitled to run, and only of that.
  authorise(ctx, 'AI_EXECUTION', 'X');

  const execution = executionsOf(ctx).find((e) => e.id === input.executionId);
  if (!execution) {
    throw new DomainError('NO_SUCH_EXECUTION', `No AI execution ${input.executionId} on this project`, 404);
  }
  if (!(AI_DISPOSITION as readonly string[]).includes(input.decision)) {
    throw new DomainError('INVALID_DISPOSITION', `Decision must be one of ${AI_DISPOSITION.join(', ')}`, 422);
  }
  if (input.decision !== 'ACCEPTED' && (input.reason ?? '').trim() === '') {
    throw new DomainError(
      'REASON_REQUIRED',
      'Say what was changed, or why it was rejected. A correction with no reason teaches nobody anything ' +
        'about where the model is weak, which is the only reason to keep the record.',
      422,
    );
  }
  if (dispositionOf(ctx, input.executionId)) {
    throw new DomainError(
      'ALREADY_DISPOSED',
      `${input.executionId} already carries a disposition. Replacing it would erase the record that the ` +
        'output was once accepted, which is the fact a dispute turns on.',
      409,
    );
  }

  // Belt and braces over the catalogue: the flag says no agent may emit this,
  // and this says no agent may reach the command either.
  if (ctx.source === 'AI') {
    throw new DomainError(
      'AI_CANNOT_DISPOSE',
      'An AI output is disposed of by a person. A model marking its own work as accepted is the failure ' +
        'this record exists to catch.',
      403,
    );
  }

  // Merged onto the execution, not written beside it. The whole existing state
  // is carried through: an UPDATE that dropped the provider, the cost and the
  // output refs would leave the accounting record hollowed out by the act of
  // approving it.
  const disposition: AIDispositionState = {
    executionId: input.executionId,
    aiRequestId: execution.aiRequestId,
    decision: input.decision,
    reason: input.reason,
    disposedBy: ctx.auth.actorId,
    disposedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'AI_OUTPUT_DISPOSED',
    entity: { refType: 'AIExecution', refId: input.executionId },
    nextState: { ...execution, disposition } as unknown as Record<string, unknown>,
  });

  return { executionId: input.executionId, decision: input.decision };
}

/** The disposition of one execution, if a person has given one. */
export function dispositionOf(ctx: EngineContext, executionId: string): AIDispositionState | undefined {
  return executionsOf(ctx).find((e) => e.id === executionId)?.disposition;
}

/** Every disposition on the project, keyed by execution. */
export function dispositions(ctx: EngineContext): Map<string, AIDispositionState> {
  const out = new Map<string, AIDispositionState>();
  for (const execution of executionsOf(ctx)) {
    if (execution.disposition) out.set(execution.id, execution.disposition);
  }
  return out;
}

export type AIDispositionPosition = {
  executions: number;
  disposed: number;
  accepted: number;
  acceptedWithChange: number;
  rejected: number;
  /** Executions nobody has decided about, by id and what produced them. */
  outstanding: Array<{ executionId: string; engine?: string; taskType?: string }>;
};

/**
 * How much of this project's AI output a person has actually stood behind.
 *
 * The number the fifth gate clause reads, and a number worth reading on its
 * own: a project where nobody has disposed of anything is one where the model
 * is writing unopposed.
 */
export function aiDispositionPosition(ctx: EngineContext): AIDispositionPosition {
  authorise(ctx, 'AI_EXECUTION', 'R');

  const decided = dispositions(ctx);
  const all = executionsOf(ctx);
  const decisions = [...decided.values()];

  return {
    executions: all.length,
    disposed: decided.size,
    accepted: decisions.filter((d) => d.decision === 'ACCEPTED').length,
    acceptedWithChange: decisions.filter((d) => d.decision === 'ACCEPTED_WITH_CHANGE').length,
    rejected: decisions.filter((d) => d.decision === 'REJECTED').length,
    outstanding: all
      .filter((e) => !decided.has(e.id))
      .map((e) => ({ executionId: e.id, engine: e.engine, taskType: e.taskType })),
  };
}

/** The catalogue's own statement that no agent may make this decision. */
export function dispositionIsHumanOnly(): boolean {
  return lookupEventType('AI_OUTPUT_DISPOSED')?.aiAllowed === false;
}
