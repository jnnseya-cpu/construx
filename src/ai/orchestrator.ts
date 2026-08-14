import { config } from '../config.ts';
import { DomainError, ForbiddenError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { ACUWallet } from '../billing/acu.ts';
import type { AIProvider, EntityRef } from '../goldenthread/types.ts';
import { mockPerception, mockReasoning } from './providers/mock.ts';
import { remotePerception, remoteReasoning } from './providers/remote.ts';
import type { AIProviderAdapter, ProviderCapability, ProviderRequest, ProviderResponse } from './providers/types.ts';

/**
 * The AI control plane.
 *
 * Every AI execution in the platform passes through here, and the sequence is
 * always the same:
 *
 *   route -> reserve ACUs -> execute -> persist to Golden Thread -> debit
 *
 * If the wallet cannot fund the call, no provider is contacted. If the call
 * fails, the hold is released and nothing is charged. If the call succeeds but
 * the caller cannot persist the result, the debit does not happen — there is no
 * billing without a ledger write.
 *
 * Users never see tokens, compute metrics or model identifiers. They see ACUs.
 */

export type Engine =
  | 'TENDER'
  | 'PLANNING'
  | 'RESOURCE_COST'
  | 'RISK_SAFETY'
  | 'BIM_TWIN'
  | 'CONTRACTS_CLAIMS'
  | 'HANDOVER_OM'
  | 'EXECUTIVE';

/**
 * The routing matrix. Perception observes the physical world; reasoning decides
 * what it means. Hybrid tasks call both, in that order.
 */
export const ROUTING_MATRIX: Record<Engine, { perception: string[]; reasoning: string[] }> = {
  TENDER: {
    perception: ['Drawing, BIM and PDF interpretation', 'Quantity extraction from 2D and models'],
    reasoning: ['Risk pricing', 'Value engineering', 'Commercial assumptions'],
  },
  PLANNING: {
    perception: ['Progress recognition from site imagery'],
    reasoning: ['CPM logic', 'Delay attribution', 'Recovery scenarios'],
  },
  RESOURCE_COST: {
    perception: ['Quantity and resource observation'],
    reasoning: ['Earned value', 'Margin and cost-to-complete'],
  },
  RISK_SAFETY: {
    perception: ['Hazard detection in imagery', 'PPE and exclusion-zone compliance'],
    reasoning: ['Regulatory compliance reasoning', 'Control adequacy'],
  },
  BIM_TWIN: {
    perception: ['IFC and model ingestion', 'Clash geometry'],
    reasoning: ['Design decision impact', 'Resolution sequencing'],
  },
  CONTRACTS_CLAIMS: {
    perception: ['Evidence extraction from documents and correspondence'],
    reasoning: ['Contract interpretation', 'Entitlement and liability'],
  },
  HANDOVER_OM: {
    perception: ['O&M manual and datasheet parsing'],
    reasoning: ['Lifecycle optimisation', 'Maintenance strategy'],
  },
  EXECUTIVE: {
    perception: [],
    reasoning: ['Portfolio scenario modelling', 'Executive briefing'],
  },
};

export type AIRequestStatus = 'QUEUED' | 'HELD' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'REJECTED';

export type AIRequestRecord = {
  id: string;
  tenantId: string;
  projectId: string;
  engine: Engine;
  taskType: string;
  inputRefs: EntityRef[];
  userId: string;
  status: AIRequestStatus;
  createdAt: string;
};

export type AIExecutionRecord = {
  id: string;
  aiRequestId: string;
  provider: AIProvider;
  modelClass: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  startedAt: string;
  endedAt?: string;
  rawCostMinor: number;
  acuHeld: number;
  acuConsumed: number;
  outputRefs: EntityRef[];
};

export type ExecuteInput = {
  tenantId: string;
  projectId: string;
  engine: Engine;
  taskType: string;
  capability: ProviderCapability;
  userId: string;
  inputRefs: EntityRef[];
  request: ProviderRequest;
  /** Regulators get no AI unless the asset owner has explicitly enabled it. */
  aiPermitted: boolean;
};

export type ExecuteResult = {
  aiRequest: AIRequestRecord;
  execution: AIExecutionRecord;
  response: ProviderResponse;
  /**
   * Settlement is deferred: the caller must persist the output to the Golden
   * Thread and then call this. Until then nothing is debited.
   */
  settle: (outputRefs: EntityRef[]) => AIExecutionRecord;
  /** Abandon the execution, releasing the hold without charge. */
  abandon: (reason: string) => void;
};

export class AIOrchestrator {
  readonly #requests = new Map<string, AIRequestRecord>();
  readonly #executions = new Map<string, AIExecutionRecord>();
  #reasoning: AIProviderAdapter;
  #perception: AIProviderAdapter;

  constructor(overrides: { reasoning?: AIProviderAdapter; perception?: AIProviderAdapter } = {}) {
    const live = config.ai.mode !== 'local';
    this.#reasoning = overrides.reasoning ?? (live ? remoteReasoning : mockReasoning);
    this.#perception = overrides.perception ?? (live ? remotePerception : mockPerception);
  }

  adapterFor(capability: ProviderCapability): AIProviderAdapter {
    const primary = capability === 'PERCEPTION' ? this.#perception : this.#reasoning;
    if (primary.healthy()) return primary;

    // Failover: a perception outage should degrade the platform, not stop it.
    const fallback = capability === 'PERCEPTION' ? this.#reasoning : this.#perception;
    if (fallback.healthy()) return fallback;

    throw new DomainError('AI_UNAVAILABLE', 'No healthy AI provider is available for this capability', 503);
  }

  /**
   * Run an engine task under full commercial and governance enforcement.
   * Returns before settlement so the caller can write to the Golden Thread first.
   */
  async execute(input: ExecuteInput, wallet: ACUWallet): Promise<ExecuteResult> {
    if (!input.aiPermitted) {
      throw new ForbiddenError('AI execution is not enabled for this actor', 'AI_NOT_ENABLED');
    }

    const aiRequest: AIRequestRecord = {
      id: ulid(),
      tenantId: input.tenantId,
      projectId: input.projectId,
      engine: input.engine,
      taskType: input.taskType,
      inputRefs: input.inputRefs,
      userId: input.userId,
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
    };
    this.#requests.set(aiRequest.id, aiRequest);

    const adapter = this.adapterFor(input.capability);
    const estimate = adapter.estimateCostMinor(input.request);

    // Reserve first. If this throws, the provider is never called and no spend occurs.
    const hold = wallet.reserve({
      aiRequestId: aiRequest.id,
      estimatedRawCostMinor: estimate,
      projectId: input.projectId,
      userId: input.userId,
      module: input.engine,
      feature: input.taskType,
    });
    aiRequest.status = 'HELD';

    const execution: AIExecutionRecord = {
      id: ulid(),
      aiRequestId: aiRequest.id,
      provider: adapter.name,
      modelClass: input.request.modelClass ?? 'default',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      rawCostMinor: 0,
      acuHeld: hold.heldMinor,
      acuConsumed: 0,
      outputRefs: [],
    };
    this.#executions.set(execution.id, execution);
    aiRequest.status = 'RUNNING';

    let response: ProviderResponse;
    try {
      response = await adapter.execute(input.request);
    } catch (error) {
      wallet.release(hold.holdId, 'AI execution failed');
      execution.status = 'FAILED';
      execution.endedAt = new Date().toISOString();
      aiRequest.status = 'FAILED';
      throw error;
    }

    execution.modelClass = response.modelClass;
    execution.rawCostMinor = response.rawCostMinor;

    let settled = false;

    return {
      aiRequest,
      execution,
      response,
      settle: (outputRefs: EntityRef[]): AIExecutionRecord => {
        if (settled) throw new DomainError('AI_ALREADY_SETTLED', 'This execution has already been settled');
        settled = true;
        const entry = wallet.settle(hold.holdId, response.rawCostMinor, response.provider);
        execution.status = 'SUCCEEDED';
        execution.endedAt = new Date().toISOString();
        execution.acuConsumed = entry.billedMinor;
        execution.outputRefs = outputRefs;
        aiRequest.status = 'SUCCEEDED';
        return execution;
      },
      abandon: (reason: string): void => {
        if (settled) return;
        settled = true;
        wallet.release(hold.holdId, reason);
        execution.status = 'FAILED';
        execution.endedAt = new Date().toISOString();
        aiRequest.status = 'FAILED';
      },
    };
  }

  requests(): AIRequestRecord[] {
    return [...this.#requests.values()];
  }

  executions(): AIExecutionRecord[] {
    return [...this.#executions.values()];
  }

  /** Operator view of the control plane. Deliberately excludes model identifiers for end users. */
  controlPlaneStatus(): {
    mode: string;
    reasoning: { provider: AIProvider; healthy: boolean };
    perception: { provider: AIProvider; healthy: boolean };
    routingMatrix: typeof ROUTING_MATRIX;
  } {
    return {
      mode: config.ai.mode,
      reasoning: { provider: this.#reasoning.name, healthy: this.#reasoning.healthy() },
      perception: { provider: this.#perception.name, healthy: this.#perception.healthy() },
      routingMatrix: ROUTING_MATRIX,
    };
  }
}
