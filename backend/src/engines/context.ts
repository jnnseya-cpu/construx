import type { ACUWallet } from '../billing/acu.ts';
import type { AIOrchestrator, Engine } from '../ai/orchestrator.ts';
import type { ProviderCapability, ProviderRequest } from '../ai/providers/types.ts';
import { config } from '../config.ts';
import type { AuthContext } from '../identity/auth.ts';
import { assertAccess, type AccessAttributes } from '../identity/abac.ts';
import type { CapabilityArea, PermissionCode } from '../identity/roles.ts';
import type { GoldenThreadLedger, CommitInput } from '../goldenthread/ledger.ts';
import type { EntityRef, EventSource, GoldenThreadEvent } from '../goldenthread/types.ts';
import { ulid } from '../core/ids.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';

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
};

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
  // The spread comes first and the defaults after. The other way round, a
  // caller passing `actor: undefined` — which is what an optional field looks
  // like when it is absent — overwrote the default and committed an event with
  // no actor at all.
  const { actor, projectId, ...rest } = input;

  const { event, record } = ctx.ledger.commit({
    ...rest,
    tenantId: ctx.tenantId,
    projectId: projectId ?? ctx.projectId,
    actor: actor ?? { refType: 'User', refId: ctx.auth.actorId },
    source: ctx.source,
    correlationId: ctx.correlationId,
  });
  return { event, state: record.state };
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
};

export type AITaskResult = {
  aiRequestId: string;
  executionId: string;
  provider: string;
  acuConsumed: number;
  acuHeld: number;
  events: GoldenThreadEvent[];
  output: Record<string, unknown>;
};

/**
 * Run an AI task end to end: authorise, reserve, execute, persist, debit.
 *
 * The ordering matters. If persistence throws, the hold is released and the
 * customer is not charged for an execution whose output never reached the
 * Golden Thread.
 */
export async function runAI(ctx: EngineContext, task: AITaskInput): Promise<AITaskResult> {
  authorise(ctx, 'AI_EXECUTION', 'X', { lifecyclePhase: currentPhase(ctx) });

  const aiPermitted = !ctx.auth.roles.includes('REGULATOR') || ctx.auth.regulatorAiEnabled;

  const run = await ctx.orchestrator.execute(
    {
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      engine: task.engine,
      taskType: task.taskType,
      capability: task.capability,
      userId: ctx.auth.actorId,
      inputRefs: task.inputRefs,
      request: task.request,
      aiPermitted,
    },
    ctx.wallet,
  );

  const events: GoldenThreadEvent[] = [];
  const outputRefs: EntityRef[] = [];

  try {
    for (const spec of task.toWrites(run.response.output, run.response.confidence)) {
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
        nextState: spec.nextState,
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
        },
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
    acuConsumed: execution.acuConsumed,
    acuHeld: execution.acuHeld,
    events,
    output: run.response.output,
  };
}

/** Register an evidence item and return its ref, for events that require evidence. */
export function registerEvidence(
  ctx: EngineContext,
  input: { type: string; hash: string; uri?: string; description: string; linkedEntities?: EntityRef[] },
): EntityRef {
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
