import type { ACUWallet } from '../billing/acu.ts';
import { ENGINE_CONTRACTS, engineActiveIn, type AIOrchestrator, type Engine } from '../ai/orchestrator.ts';
import {
  correctionFor,
  outputStandardInstruction,
  outputStandardSchema,
  validateAiOutput,
  type AiOutput,
  type FieldError,
} from '../ai/outputstandard.ts';
import type { ProviderCapability, ProviderRequest } from '../ai/providers/types.ts';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import type { AuthContext } from '../identity/auth.ts';
import { assertAccess, type AccessAttributes } from '../identity/abac.ts';
import type { CapabilityArea, PermissionCode } from '../identity/roles.ts';
import type { GoldenThreadLedger, CommitInput } from '../goldenthread/ledger.ts';
import type { EntityRef, EventSource, GoldenThreadEvent } from '../goldenthread/types.ts';
import { hashEvidence } from '../core/canonical.ts';
import { ulid } from '../core/ids.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';
import type { TenancyStanding } from '../billing/entitlement.ts';

/**
 * Shared execution context for every engine.
 *
 * Engines never touch the ledger, the wallet or a provider directly. They go
 * through this, which is where the three platform-wide invariants are enforced
 * in one place: access is checked, every write emits an event, and every AI
 * call is funded before it runs and only billed once its output is committed.
 */

export type EngineContext = {
  ledger: GoldenThreadLedger;
  orchestrator: AIOrchestrator;
  wallet: ACUWallet;
  auth: AuthContext;
  source: EventSource;
  correlationId: string;
  tenantId: string;
  projectId: string;
  /**
   * What this tenancy may do, resolved once when the context is built.
   *
   * Carried on the context rather than looked up at each write because it is a
   * property of the request, not of the call site: a subscription cancelled
   * halfway through a command should not make the first half of that command
   * succeed and the second half fail.
   */
  standing: TenancyStanding;
};

/**
 * Refuse a state change from a tenancy that is not entitled to make one.
 *
 * Enforced here rather than route by route because this module is the choke
 * point every state change passes through, and an entitlement gate with a way
 * around it is decoration. See `billing/entitlement.ts` for what it enforces
 * and why.
 */
function assertMayWrite(ctx: EngineContext): void {
  if (ctx.standing.mayWrite) return;
  throw new DomainError(
    'SUBSCRIPTION_NOT_ACTIVE',
    ctx.standing.reason ?? 'This subscription does not permit changes',
    // 402, not 403. This is not "you are not allowed"; it is "this account owes
    // money", and a client that cannot tell the two apart will send somebody to
    // the wrong support queue.
    402,
  );
}

/** The switches every access decision is evaluated under, wherever it is made. */
export const AUTHZ_OPTIONS = {
  rbacEnabled: config.authz.rbac,
  scopesEnabled: config.authz.scopes,
  abacEnabled: config.authz.abac,
};

const authzOptions = AUTHZ_OPTIONS;

export function authorise(
  ctx: EngineContext,
  area: CapabilityArea,
  code: PermissionCode,
  attributes: Partial<AccessAttributes> = {},
): void {
  assertAccess(
    ctx.auth,
    area,
    code,
    { tenantId: ctx.tenantId, projectId: ctx.projectId, ...attributes },
    authzOptions,
  );
}

/** Current lifecycle phase of the project, for phase-gated authorisation. */
export function currentPhase(ctx: EngineContext): LifecyclePhase | undefined {
  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });
  return project?.state.phase as LifecyclePhase | undefined;
}

/** Commit a human- or system-authored state change. */
export function write(
  ctx: EngineContext,
  input: Omit<CommitInput, 'tenantId' | 'projectId' | 'actor' | 'source' | 'correlationId'> &
    Partial<Pick<CommitInput, 'actor' | 'projectId'>>,
): { event: GoldenThreadEvent; state: Record<string, unknown> } {
  assertMayWrite(ctx);

  // The spread comes first and the defaults after. The other way round, a
  // caller passing `actor: undefined` — which is what an optional field looks
  // like when it is absent — overwrote the default and committed an event with
  // no actor at all.
  const { actor, projectId, ...rest } = input;
  const target = projectId ?? ctx.projectId;

  const { event, record } = ctx.ledger.commit({
    ...rest,
    tenantId: ctx.tenantId,
    projectId: target,
    actor: actor ?? { refType: 'User', refId: ctx.auth.actorId },
    source: ctx.source,
    correlationId: ctx.correlationId,
    // Filled here rather than at each call site, because "every command
    // remembers to record who they were and where the project was" is not a
    // property a codebase can hold. There is one write path; it fills them.
    //
    // A snapshot of the roles, not a reference to them: somebody promoted or
    // removed still acted under the mandate they held at the time, and an audit
    // resolving their *current* roles reports the wrong authority for every
    // historic act.
    roleAtAction: [...ctx.auth.roles],
    // Absent rather than guessed where the write is not against the context's
    // own project — a governance act on a tenancy has no lifecycle phase, and
    // reporting the wrong project's phase is worse than reporting none.
    ...(target === ctx.projectId ? withPhase(ctx) : {}),
  });
  return { event, state: record.state };
}

/**
 * The project's lifecycle phase, or nothing.
 *
 * Read from materialised project state, so it is the phase as the ledger knows
 * it at this instant rather than a value carried on the request — which a caller
 * could otherwise be wrong about, or lie about.
 */
function withPhase(ctx: EngineContext): { lifecyclePhase?: string } {
  const phase = currentPhase(ctx);
  return phase ? { lifecyclePhase: phase } : {};
}

export type AIWriteSpec = {
  eventType: string;
  entity: EntityRef;
  nextState: Record<string, unknown>;
  evidenceRefs?: EntityRef[];
};

export type AITaskInput = {
  engine: Engine;
  taskType: string;
  capability: ProviderCapability;
  inputRefs: EntityRef[];
  request: ProviderRequest;
  /**
   * Turn the provider's structured output into the state to commit. This is
   * where the engine's own deterministic maths is combined with the model's
   * judgement — the model never writes state on its own.
   */
  toWrites: (output: Record<string, unknown>, confidence: number | undefined) => AIWriteSpec[];
  /**
   * Hold this task's answer to the AI Output Standard.
   *
   * Declared per task rather than applied to everything, and the distinction is
   * real. The standard's ten fields describe a *judgement* — a finding with a
   * commercial, programme and contractual consequence and a recommended action.
   * A drawing title block has none of those, and requiring them would make a
   * model invent an impact for a revision letter, which is precisely the
   * failure the standard exists to prevent.
   *
   * So extraction tasks stay as they are, governed by the draft-then-confirm
   * discipline they already have, and every task that produces advice a person
   * will act on sets this. What it buys: the answer is checked, a failing
   * answer is rejected and retried once with the specific fields named, and a
   * second failure refuses rather than writing unvalidated model prose into an
   * append-only ledger.
   */
  outputStandard?: true;
};

/**
 * Which prompt produced an output, and which version of it.
 *
 * `${taskType}@${hash}` over the task string and the response schema the
 * engine actually sent — the two things that define what was asked. Derived
 * rather than declared because a hand-maintained version string is one
 * somebody forgets to bump on exactly the change that mattered, and because a
 * derived one cannot disagree with what was sent.
 *
 * The payload is deliberately *not* in the hash. The payload is this
 * project's data and differs on every call; including it would give every
 * single execution its own "version", which is a fingerprint rather than a
 * version. What is hashed is the shape of the question.
 *
 * Eight hex characters of the digest. Enough to distinguish the prompts one
 * platform has, short enough to read in a table. `hashEvidence` returns an
 * algorithm-prefixed value (`sha256:…`), so the prefix is dropped first —
 * slicing the prefixed string would yield `sha256:` plus one hex character,
 * which is four bits of entropy wearing a version's clothes.
 */
export function promptVersionOf(task: { taskType: string; request: ProviderRequest }): string {
  const shape = JSON.stringify({ task: task.request.task, schema: task.request.responseSchema ?? null });
  const digest = hashEvidence(shape).split(':').pop() ?? '';
  return `${task.taskType}@${digest.slice(0, 8)}`;
}

export type AITaskResult = {
  aiRequestId: string;
  executionId: string;
  provider: string;
  /**
   * The model the provider actually ran.
   *
   * Exposed because a caller putting the output in front of a person has to be
   * able to attribute it. `provider` alone says OPENAI whether a live model
   * answered or the local deterministic adapter did.
   */
  modelClass?: string;
  /**
   * True where no model was called and the output is a deterministic stand-in.
   *
   * A caller putting this in front of a person must not present it as
   * reasoning: a document attributing a synthetic paragraph to "the platform's
   * reasoning engine" claims a section was reasoned when nothing reasoned about
   * anything.
   */
  synthetic?: boolean;
  acuConsumed: number;
  acuHeld: number;
  events: GoldenThreadEvent[];
  output: Record<string, unknown>;
  /**
   * The answer, checked against the AI Output Standard.
   *
   * Present only where the task declared `outputStandard`. A caller putting AI
   * advice in front of a person should read this rather than `output`: it is
   * the same answer with every field established — an impact statement that
   * says something, a confidence inside 0–1, and source references that
   * resolve to records on this project.
   */
  standard?: AiOutput;
  /**
   * What was wrong with the first answer, where a correction was needed.
   *
   * Kept rather than discarded because a model that has to be corrected on the
   * same field across many runs is a prompt defect, and the only place that
   * shows up is here.
   */
  standardRejected?: FieldError[];
};

/**
 * Run an AI task end to end: authorise, reserve, execute, persist, debit.
 *
 * The ordering matters. If persistence throws, the hold is released and the
 * customer is not charged for an execution whose output never reached the
 * Golden Thread.
 */
export async function runAI(ctx: EngineContext, task: AITaskInput): Promise<AITaskResult> {
  // Before authorisation, before the phase check, and long before anything is
  // reserved: a wallet full of credit does not entitle anybody to run engines
  // on a platform they have stopped paying for. ACU credit buys AI; it does not
  // buy the platform. Checking the balance alone was the whole loophole — a
  // customer could cancel, keep topping up, and carry on.
  if (!ctx.standing.mayRunAI) {
    throw new DomainError(
      'SUBSCRIPTION_NOT_ACTIVE',
      ctx.standing.reason ?? 'This subscription does not permit AI execution',
      402,
    );
  }

  const phase = currentPhase(ctx);
  authorise(ctx, 'AI_EXECUTION', 'X', { lifecyclePhase: phase });

  // Each engine declares the phases it is applicable in, and this is where that
  // declaration is enforced — before anything is reserved or charged. Without
  // it every engine was reachable in every phase: a handover engine would
  // assemble an O&M manual for a project still at CONCEPT, spend the ACUs, and
  // write a worthless answer to a ledger that cannot be edited.
  // `phase` is undefined on a context that is not a delivery project — the
  // tenant governance pseudo-project, for instance. There is no lifecycle to
  // check against there, and inventing one would block portfolio reasoning.
  if (phase !== undefined && !engineActiveIn(task.engine, phase)) {
    const contract = ENGINE_CONTRACTS[task.engine];
    throw new DomainError(
      'ENGINE_NOT_APPLICABLE',
      `The ${task.engine} engine does not run during ${phase}. It is active in ${contract.activeInPhases.join(', ')}.`,
      409,
    );
  }

  const aiPermitted = !ctx.auth.roles.includes('REGULATOR') || ctx.auth.regulatorAiEnabled;

  const execute = (request: ProviderRequest) =>
    ctx.orchestrator.execute(
      {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        engine: task.engine,
        taskType: task.taskType,
        capability: task.capability,
        userId: ctx.auth.actorId,
        inputRefs: task.inputRefs,
        request,
        aiPermitted,
      },
      ctx.wallet,
    );

  // A task held to the standard asks for the standard. The instruction and the
  // schema are derived from the same field list the validator reads, so a
  // prompt asking for nine fields against a validator requiring ten — a retry
  // loop that can never terminate — is not expressible.
  const firstRequest: ProviderRequest = task.outputStandard
    ? {
        ...task.request,
        task: `${task.request.task}\n\n${outputStandardInstruction()}`,
        responseSchema: outputStandardSchema(),
        standardSources: task.inputRefs.map((reference) => ({ refType: reference.refType, refId: reference.refId })),
      }
    : task.request;

  let run = await execute(firstRequest);

  // --- the AI Output Standard ---------------------------------------------
  //
  // "Responses failing schema validation are rejected and retried; never shown
  // raw to the user." Enforced here, at the choke point every AI write already
  // passes through, for the same reason provenance is stamped here: there is
  // one place for it to be right, and the next engine gets it without being
  // told.
  let standard: AiOutput | undefined;
  let rejectedFirst: FieldError[] | undefined;

  if (task.outputStandard) {
    // A source reference is only traceable if it resolves. The resolver is
    // scoped to this project's ledger, so a citation of a record on another
    // job — or one that does not exist at all — is a rejection rather than a
    // link somebody follows to nothing.
    const resolve = (reference: { refType: string; refId: string }) => {
      const record = ctx.ledger.get(reference);
      return record !== undefined && record.tenantId === ctx.tenantId;
    };

    let checked = validateAiOutput(run.response.output, { resolve });
    if (!checked.ok) {
      rejectedFirst = checked.problems;
      // Released without charge. The customer did not get an answer they can
      // use, and the retry below is what they are paying for.
      run.abandon('AI_OUTPUT_STANDARD_REJECTED');

      run = await execute({
        ...firstRequest,
        task: `${firstRequest.task}\n\n${correctionFor(rejectedFirst)}`,
      });
      checked = validateAiOutput(run.response.output, { resolve });

      if (!checked.ok) {
        run.abandon('AI_OUTPUT_STANDARD_FAILED');
        // The field problems, never the model's text. Leaking the raw answer
        // inside the refusal would be the same failure through another door.
        throw new DomainError(
          'AI_OUTPUT_STANDARD_FAILED',
          'The model did not answer in the required form twice, so nothing was recorded and nothing was charged.',
          502,
          checked.problems,
        );
      }
    }
    standard = checked.output;
  }

  const events: GoldenThreadEvent[] = [];
  const outputRefs: EntityRef[] = [];

  /**
   * Who produced the judgement in the records below.
   *
   * `synthetic` is the one that matters to a reader: it says no model was
   * called and the output is a deterministic stand-in. Anything putting this
   * record in front of a person must not present it as reasoning.
   */
  const provenance = {
    provider: run.response.provider,
    modelClass: run.response.modelClass,
    engine: task.engine,
    taskType: task.taskType,
    synthetic: run.response.synthetic === true,
    at: new Date().toISOString(),
    // Recorded on the record itself, not only in the request log. A reader
    // holding a materialised state needs to be able to tell an answer that was
    // held to the standard from one that was never checked against it, and
    // whether it took a correction to get there.
    ...(task.outputStandard
      ? { outputStandard: true as const, standardAttempts: rejectedFirst ? 2 : 1 }
      : {}),
  };

  try {
    // Where the task was held to the standard, the engine is handed the
    // *validated* answer rather than the raw one: same content, every field
    // established, quantities normalised to a number or an explicit null. An
    // engine reading `output.confidence` should not have to re-check whether
    // it is a number.
    const answer = standard ? { ...standard } : run.response.output;
    for (const spec of task.toWrites(answer, run.response.confidence)) {
      const { event } = ctx.ledger.commit({
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        // AI-authored changes are attributed to an AI actor, never to the human
        // who pressed the button. Liability follows attribution.
        actor: { refType: 'AI', refId: `${task.engine}:${task.taskType}` },
        source: 'AI',
        correlationId: ctx.correlationId,
        causationId: run.aiRequest.id,
        eventType: spec.eventType,
        entity: spec.entity,
        // Stamped here rather than at each engine's call site.
        //
        // Eighteen `toWrites` callbacks across seven engines put a provider's
        // prose into ledger state — `narrative`, `reviewNotes`,
        // `entitlementNarrative`, `maintenanceNarrative` and the rest — and
        // none of them recorded which model produced it. The event already
        // carried the answer in its `ai` block, but a *reader* holding the
        // materialised record could not see it, and the O&M manual duly
        // presented the local stand-in's sentence as a maintenance regime
        // somebody had extracted.
        //
        // Doing it here rather than in each engine is the whole point: the
        // nineteenth engine gets it without being told, and there is one place
        // for it to be right. `runAI` is already the choke point every AI write
        // passes through, which is where the other two platform-wide invariants
        // are enforced for the same reason.
        nextState: { ...spec.nextState, aiProvenance: provenance },
        evidenceRefs: spec.evidenceRefs,
        ai: {
          aiRequestId: run.aiRequest.id,
          aiExecutionId: run.execution.id,
          provider: run.response.provider,
          modelClass: run.response.modelClass,
          acuHeld: run.execution.acuHeld,
          // Settlement has not happened yet; the settled figure lands on the
          // AI_EXECUTION_COMPLETED event below.
          acuConsumed: 0,
          inputRefs: task.inputRefs,
          // Recorded beside the change it justified. The engine already had
          // this figure and used it to decide what to write; until now it was
          // discarded at the moment it became evidence.
          ...(run.response.confidence === undefined ? {} : { confidence: run.response.confidence }),
          // Which prompt, and which version of it. Derived from what was
          // actually sent rather than declared by hand — see `promptVersion`.
          promptVersion: promptVersionOf(task),
          // Always written, `[]` included. An empty array says the model
          // declared no assumptions; an absent field would say nobody
          // recorded whether it did, and those are different facts.
          assumptions: run.response.assumptions ?? [],
          // Same rule as assumptions: `[]` is "none declared", and an absent
          // field means the event predates it. The gate distinguishes the two.
          knownGaps: run.response.knownGaps ?? [],
          alternativesConsidered: run.response.alternativesConsidered ?? [],
        },
        // The human who pressed the button, and the phase the project was in.
        // The actor on an AI-authored event is the engine — liability follows
        // attribution — so the roles recorded are those of the person who
        // authorised the run, which is the mandate the act was performed under.
        roleAtAction: [...ctx.auth.roles],
        ...withPhase(ctx),
        timestamp: new Date().toISOString(),
      });
      events.push(event);
      outputRefs.push(spec.entity);
    }
  } catch (error) {
    run.abandon(`Persistence failed: ${String(error)}`);
    throw error;
  }

  const execution = run.settle(outputRefs);

  // The execution record itself is part of the Golden Thread: an auditor can
  // reconcile every ACU debited against an event that justifies it.
  const { event: executionEvent } = ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'AI', refId: `${task.engine}:${task.taskType}` },
    source: 'AI',
    correlationId: ctx.correlationId,
    causationId: run.aiRequest.id,
    eventType: 'AI_EXECUTION_COMPLETED',
    entity: { refType: 'AIExecution', refId: execution.id },
    nextState: {
      id: execution.id,
      aiRequestId: execution.aiRequestId,
      engine: task.engine,
      taskType: task.taskType,
      provider: execution.provider,
      status: execution.status,
      acuHeld: execution.acuHeld,
      acuConsumed: execution.acuConsumed,
      outputRefs: execution.outputRefs,
      inputRefs: task.inputRefs,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
    },
    ai: {
      aiRequestId: run.aiRequest.id,
      aiExecutionId: execution.id,
      provider: run.response.provider,
      modelClass: run.response.modelClass,
      acuHeld: execution.acuHeld,
      acuConsumed: execution.acuConsumed,
    },
  });
  events.push(executionEvent);

  return {
    aiRequestId: run.aiRequest.id,
    executionId: execution.id,
    provider: run.response.provider,
    modelClass: run.response.modelClass,
    synthetic: run.response.synthetic,
    acuConsumed: execution.acuConsumed,
    acuHeld: execution.acuHeld,
    events,
    output: run.response.output,
    ...(standard ? { standard } : {}),
    ...(rejectedFirst ? { standardRejected: rejectedFirst } : {}),
  };
}

/**
 * The provenance `runAI` stamps on every record it writes.
 *
 * Read it rather than the shape of the state: an engine's field names differ —
 * `narrative`, `reviewNotes`, `maintenanceNarrative` — and a consumer that
 * matched on those would need updating each time one was added.
 */
export type AIProvenance = {
  provider: string;
  modelClass?: string;
  engine: string;
  taskType: string;
  /** No model was called; the output is a deterministic stand-in. */
  synthetic: boolean;
  at: string;
};

export function aiProvenanceOf(state: Record<string, unknown> | undefined): AIProvenance | undefined {
  const provenance = state?.aiProvenance;
  if (!provenance || typeof provenance !== 'object') return undefined;
  return provenance as AIProvenance;
}

/**
 * Whether the model-derived content on a record came from a stand-in.
 *
 * The answer anything showing that content to a person has to ask before
 * presenting it as reasoning. `true` for a record written with no provider
 * configured; `false` for one a model actually answered.
 *
 * A record carrying no provenance at all answers `false` — it was not written
 * by `runAI`, so there is no model-derived content on it to misrepresent.
 */
export function wasSynthetic(state: Record<string, unknown> | undefined): boolean {
  return aiProvenanceOf(state)?.synthetic === true;
}

/** Register an evidence item and return its ref, for events that require evidence. */
export function registerEvidence(
  ctx: EngineContext,
  input: { type: string; hash: string; uri?: string; description: string; linkedEntities?: EntityRef[] },
): EntityRef {
  // Gated too, not only `write`. Evidence is registered *before* the event that
  // needs it, so leaving this open would let a read-only tenancy append evidence
  // records that no event ever references — writes that failed, littering an
  // append-only ledger that cannot be tidied.
  assertMayWrite(ctx);

  const refId = ulid();
  const ref: EntityRef = { refType: 'EvidenceItem', refId };
  ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: ctx.source,
    correlationId: ctx.correlationId,
    eventType: 'EVIDENCE_REGISTERED',
    entity: ref,
    nextState: {
      id: refId,
      type: input.type,
      hash: input.hash,
      uri: input.uri,
      description: input.description,
      linkedEntities: input.linkedEntities ?? [],
      capturedAt: new Date().toISOString(),
      capturedBy: ctx.auth.actorId,
    },
  });
  return ref;
}
