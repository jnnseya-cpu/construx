import { DomainError } from '../core/errors.ts';
import { diffState } from '../core/jsonpatch.ts';
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

/**
 * One field a person changed before standing behind the answer — §16.3.
 *
 * The reason a prose reason is not enough. "Corrected the commercial figure" is
 * a sentence somebody has to read and cannot count; `commercialImpact.amountMinor
 * 240000 → 0` is a fact about where this model is weak, and forty of them are a
 * measurement. The platform's own record of AI usefulness is only as good as the
 * granularity it keeps, and prose has none.
 */
export type OutputChange = {
  /** A JSON pointer into the output, e.g. `/commercialImpact/amountMinor`. */
  field: string;
  /** What the model said. Absent where the person added a field the model omitted. */
  from?: unknown;
  /** What the person put. Absent where they removed what the model said. */
  to?: unknown;
};

export type AIDispositionState = {
  executionId: string;
  aiRequestId?: string;
  decision: AIDisposition;
  /** Required on anything but a clean acceptance. */
  reason?: string;
  /**
   * What was changed, field by field — §16.3.
   *
   * Present only where the caller supplied the edited answer, and computed here
   * rather than accepted from the caller: a list of changes somebody types is a
   * second account of the edit, and the two would disagree.
   */
  changes?: OutputChange[];
  disposedBy: string;
  disposedAt: string;
};

type ExecutionRecord = {
  id: string;
  aiRequestId?: string;
  engine?: string;
  taskType?: string;
  /**
   * The answer as the model gave it, where the task was held to the output
   * standard. Absent on an execution that predates it, and on a task with no
   * standard answer — a perception run, say.
   */
  standardOutput?: Record<string, unknown>;
  standardVersion?: string;
  /** Merged onto the execution by `disposeAIOutput`, absent until then. */
  disposition?: AIDispositionState;
};

/**
 * What a person changed, field by field.
 *
 * Computed from the two answers rather than taken from the caller: a list of
 * changes somebody types alongside the edit is a second account of it, and two
 * accounts of the same act eventually disagree.
 *
 * JSON Patch is the platform's own diff and produces exactly this — the paths
 * are pointers into the answer, and `replace` carries the new value. The old
 * value is read back out of the original, which the patch does not carry and a
 * person reading "what did the model get wrong" certainly needs.
 */
function changesBetween(before: Record<string, unknown>, after: Record<string, unknown>): OutputChange[] {
  return diffState(before, after).map((op) => {
    const at = valueAt(before, op.path);
    return {
      field: op.path,
      ...(op.op === 'add' ? {} : { from: at }),
      ...(op.op === 'remove' ? {} : { to: (op as { value?: unknown }).value }),
    };
  });
}

/** Read a JSON-pointer path out of the original answer, for the `from` side. */
function valueAt(source: unknown, pointer: string): unknown {
  let at: unknown = source;
  for (const raw of pointer.split('/').slice(1)) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string, unknown>)[token];
  }
  return at;
}

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
  input: {
    executionId: string;
    decision: AIDisposition;
    reason?: string;
    /**
     * The answer as the person is standing behind it, where they edited it.
     *
     * Optional, because a disposition recorded from a screen that does not hold
     * the edited answer is still a real disposition and refusing it would lose
     * the decision to gain a detail. Where it is given, the diff against what
     * the model produced is computed and kept.
     */
    edited?: Record<string, unknown>;
  },
): { executionId: string; decision: AIDisposition; changes?: OutputChange[] } {
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

  // The field-level record of the edit — §16.3.
  //
  // Only where both halves exist: an execution with no standard answer has
  // nothing to diff against, and a caller that did not send the edited answer
  // is recording a decision rather than a correction. Neither is refused —
  // losing the decision to gain the detail would be the wrong trade — but a
  // caller who *does* send an edit that changes nothing is refused, because
  // "accepted with change" and "changed nothing" cannot both be true.
  let changes: OutputChange[] | undefined;
  if (input.edited && execution.standardOutput) {
    changes = changesBetween(execution.standardOutput, input.edited);
    if (input.decision === 'ACCEPTED_WITH_CHANGE' && changes.length === 0) {
      throw new DomainError(
        'NO_CHANGE_MADE',
        'This is recorded as accepted with change and the answer supplied is identical to the model\'s. ' +
          'Record it as accepted, or send the answer as you actually amended it.',
        422,
      );
    }
    if (input.decision === 'ACCEPTED' && changes.length > 0) {
      throw new DomainError(
        'CHANGE_WITHOUT_DECISION',
        `This is recorded as accepted unchanged and the answer supplied differs in ${changes.length} ` +
          `field${changes.length === 1 ? '' : 's'}. Record it as accepted with change, and say what was wrong.`,
        422,
      );
    }
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
    ...(changes ? { changes } : {}),
    disposedBy: ctx.auth.actorId,
    disposedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'AI_OUTPUT_DISPOSED',
    entity: { refType: 'AIExecution', refId: input.executionId },
    nextState: { ...execution, disposition } as unknown as Record<string, unknown>,
  });

  return { executionId: input.executionId, decision: input.decision, ...(changes ? { changes } : {}) };
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
  /**
   * Which fields people actually correct, most-corrected first — §16.3.
   *
   * The reason the field-level diff is kept at all. "Twelve outputs accepted
   * with change" says the model needs watching; "the commercial amount was
   * corrected in nine of them and the summary in one" says where, and that is
   * a thing somebody can act on — a prompt to fix, a task type to stop running,
   * a figure to stop trusting.
   *
   * Empty where no disposition carried an edited answer, which is not the same
   * as a model nothing is corrected in and is why `correctionsRecorded` sits
   * beside it.
   */
  correctedFields: Array<{ field: string; times: number }>;
  /** How many of the accepted-with-change dispositions carried a field-level record. */
  correctionsRecorded: number;
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

  const corrected = new Map<string, number>();
  for (const decision of decisions) {
    for (const change of decision.changes ?? []) {
      corrected.set(change.field, (corrected.get(change.field) ?? 0) + 1);
    }
  }

  return {
    executions: all.length,
    disposed: decided.size,
    accepted: decisions.filter((d) => d.decision === 'ACCEPTED').length,
    acceptedWithChange: decisions.filter((d) => d.decision === 'ACCEPTED_WITH_CHANGE').length,
    rejected: decisions.filter((d) => d.decision === 'REJECTED').length,
    outstanding: all
      .filter((e) => !decided.has(e.id))
      .map((e) => ({ executionId: e.id, engine: e.engine, taskType: e.taskType })),
    correctedFields: [...corrected.entries()]
      .map(([field, times]) => ({ field, times }))
      // Most-corrected first, then by name so the order is stable between two
      // fields corrected the same number of times.
      .sort((a, b) => b.times - a.times || a.field.localeCompare(b.field)),
    correctionsRecorded: decisions.filter((d) => (d.changes?.length ?? 0) > 0).length,
  };
}

/** The catalogue's own statement that no agent may make this decision. */
export function dispositionIsHumanOnly(): boolean {
  return lookupEventType('AI_OUTPUT_DISPOSED')?.aiAllowed === false;
}
