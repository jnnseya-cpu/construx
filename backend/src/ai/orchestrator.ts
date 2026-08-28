import { config } from '../config.ts';
import type { DataSensitivity } from '../identity/abac.ts';
import { clearanceFor, mayReceive, sensitivityOf } from './sensitivity.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';
import { DomainError, ForbiddenError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { ACUWallet, CapBreach } from '../billing/acu.ts';
import type { AIProvider, EntityRef } from '../goldenthread/types.ts';
import { mockPerception, mockReasoning } from './providers/mock.ts';
import { remotePerception, remoteReasoning, spareAdapters } from './providers/remote.ts';
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
    perception: ['Quantity and resource observation', 'Plant and equipment recognition from site imagery'],
    reasoning: ['Earned value', 'Margin and cost-to-complete'],
  },
  RISK_SAFETY: {
    perception: ['Hazard detection in imagery', 'PPE and exclusion-zone compliance'],
    reasoning: ['Regulatory compliance reasoning', 'Control adequacy'],
  },
  BIM_TWIN: {
    perception: ['IFC and model ingestion', 'Clash geometry', 'Workmanship defect detection in site imagery'],
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

/**
 * When each engine may run, and what it is for.
 *
 * The routing matrix above says *which provider* an engine reaches. It says
 * nothing about *when* the engine is applicable, so every engine was reachable
 * in every phase: a handover engine could be asked to assemble an O&M manual
 * for a project still at CONCEPT, and a tender engine could price a job three
 * years after it was handed over. Both would produce an answer, spend ACUs and
 * write it to the ledger, and the answer would be worthless.
 *
 * So each engine declares the phases it is active in. This is a contract, not
 * documentation — `runAI` refuses an engine outside its phases before anything
 * is reserved or charged, and `/v1/ai/control-plane` publishes it so the
 * console can grey out what is not applicable rather than offering it and
 * failing.
 *
 * `EXECUTIVE` is active everywhere by design: portfolio reasoning spans
 * projects that are in different phases from each other, so binding it to one
 * would be binding it to whichever project was asked about.
 */
export type EngineContract = {
  /** What the engine is asked to decide, in the language of the person asking. */
  purpose: string;
  /** The lifecycle phases in which this engine may run. */
  /**
   * What to call this engine to a person.
   *
   * The engine codes are the platform's, not the industry's. A QS asked to
   * trust `RESOURCE_COST` is being asked to trust a database column; told they
   * are talking to a commercial analyst, they know what it is for and what it
   * is not. Held here rather than in the console so the name, the purpose and
   * the phases it runs in cannot drift apart.
   */
  name: string;
  activeInPhases: LifecyclePhase[];
  /** What it reads. Named so a reviewer can see the provenance of an answer. */
  inputs: string[];
  /** What it produces, and therefore what a person is being asked to act on. */
  outputs: string[];
};

const ALL_PHASES: LifecyclePhase[] = [
  'CONCEPT',
  'DESIGN',
  'TENDER',
  'CONSTRUCTION',
  'COMMISSIONING',
  'HANDOVER',
  'OPERATIONS',
];

export const ENGINE_CONTRACTS: Record<Engine, EngineContract> = {
  TENDER: {
    name: 'Estimator',
    purpose: 'Price the work and say what the commercial risk in it is',
    activeInPhases: ['CONCEPT', 'DESIGN', 'TENDER'],
    inputs: ['Scope packages', 'Drawings and models', 'Cost intelligence from settled projects'],
    outputs: ['Estimate by cost head', 'Priced risk allowances', 'Bid/no-bid factors'],
  },
  PLANNING: {
    name: 'Planner',
    purpose: 'Say when the work will finish and what would recover it',
    // Not in CONCEPT: there is no programme to reason about before a scope
    // exists, and a critical path computed from nothing reads as a forecast.
    activeInPhases: ['DESIGN', 'TENDER', 'CONSTRUCTION', 'COMMISSIONING'],
    inputs: ['Approved baseline', 'Progress measurements', 'Delay events'],
    outputs: ['Delay forecast with confidence', 'Critical path', 'Costed recovery options'],
  },
  RESOURCE_COST: {
    name: 'Commercial analyst',
    purpose: 'Say where the margin is going and what it will cost to complete',
    activeInPhases: ['TENDER', 'CONSTRUCTION', 'COMMISSIONING'],
    inputs: ['Budget and cost codes', 'Committed and actual cost', 'Progress measurements'],
    outputs: ['Earned value position', 'Cost to complete', 'Margin erosion by cause'],
  },
  RISK_SAFETY: {
    name: 'Risk and safety adviser',
    purpose: 'Say what is likely to go wrong and whether the controls are adequate',
    activeInPhases: ALL_PHASES,
    inputs: ['Risk register', 'Incidents and observations', 'RAMS and method statements'],
    outputs: ['Exposure by category', 'Control adequacy findings', 'Mitigation proposals'],
  },
  BIM_TWIN: {
    name: 'Design coordinator',
    purpose: 'Say where the design conflicts with itself or with what was built',
    activeInPhases: ['DESIGN', 'TENDER', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER'],
    inputs: ['Models and drawing register', 'Clash records', 'Site observations'],
    outputs: ['Clash severity and sequencing', 'Design-to-as-built deltas'],
  },
  CONTRACTS_CLAIMS: {
    name: 'Contracts adviser',
    purpose: 'Say what the contract entitles and what the evidence supports',
    // From TENDER, because the form of contract is chosen before it is signed
    // and the notice regime it imposes starts mattering immediately.
    activeInPhases: ['TENDER', 'CONSTRUCTION', 'COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
    inputs: ['Contract and its clauses', 'Notices and correspondence', 'Delay events and evidence'],
    outputs: ['Entitlement assessment', 'Time-bar position', 'Claim pack with references'],
  },
  HANDOVER_OM: {
    name: 'Asset manager',
    purpose: 'Say whether the asset can be operated and what it will need',
    activeInPhases: ['COMMISSIONING', 'HANDOVER', 'OPERATIONS'],
    inputs: ['Asset register', 'Commissioning results', 'Warranties and defects'],
    outputs: ['Handover readiness and gaps', 'Maintenance strategy', 'Lifecycle replacement plan'],
  },
  EXECUTIVE: {
    name: 'Board reporter',
    purpose: 'Say what across the portfolio needs a decision this week',
    // Everywhere, deliberately: a portfolio spans projects in different phases,
    // so binding this would bind it to whichever project was asked about.
    activeInPhases: ALL_PHASES,
    inputs: ['Every project position', 'Agent findings', 'Wallet and commercial state'],
    outputs: ['Ranked actions with reasons', 'Portfolio exposure'],
  },
};

/** Whether an engine may run in a phase. */
export function engineActiveIn(engine: Engine, phase: LifecyclePhase): boolean {
  return ENGINE_CONTRACTS[engine].activeInPhases.includes(phase);
}

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
  /**
   * The routing decision, recorded with the input it was made on.
   *
   * "All routing decisions are logged" is not satisfied by recording which
   * vendor served the call. That is the *outcome*; without the input, the
   * choice cannot be re-derived from the record, and re-deriving it is the
   * whole point the day somebody asks why a particular document went to a
   * particular company.
   */
  routing: {
    /** Derived from `inputRefs`, as the highest classification among them. */
    sensitivity: DataSensitivity;
    /** The vendor chosen, and the ceiling it was cleared to at that moment. */
    provider: AIProvider;
    clearance: DataSensitivity;
    /** Vendors excluded because they were not cleared for this material. */
    excluded: Array<{ provider: AIProvider; clearance: DataSensitivity }>;
  };
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

/**
 * Where the estimate came from. Shown, not hidden: a number carries a different
 * weight depending on whether it was measured or assumed, and the user is the
 * one deciding whether to spend against it.
 */
export type QuoteBasis = 'MEASURED' | 'FLOOR';

export type CostQuote = {
  engine: string;
  taskType: string;
  capability: ProviderCapability;
  provider: string;
  basis: QuoteBasis;
  /** How many settled runs the estimate is drawn from. Zero where the basis is FLOOR. */
  observations: number;
  estimatedRawCostMinor: number;
  estimatedChargeMinor: number;
  /** The cheapest this action has been. On a FLOOR basis, the floor itself. */
  lowChargeMinor: number;
  /** The dearest it has been. Absent where nothing has been measured. */
  highChargeMinor?: number;
  multiplier: number;
  availableMinor: number;
  balanceAfterMinor: number;
  affordable: boolean;
  /** Present where the action cannot proceed, with the reason it cannot. */
  blockedReason?: string;
  /**
   * The same refusal as facts. A screen can then say "£42.00 needed, £20.00
   * available" in the customer's own currency rather than repeating a message
   * written in minor units for a log.
   */
  blockedBy?: 'BALANCE' | 'CAP';
  capBreach?: CapBreach;
};

function median(sortedAscending: number[]): number {
  const middle = Math.floor(sortedAscending.length / 2);
  return sortedAscending.length % 2 === 1
    ? sortedAscending[middle]!
    : Math.ceil((sortedAscending[middle - 1]! + sortedAscending[middle]!) / 2);
}

export class AIOrchestrator {
  readonly #requests = new Map<string, AIRequestRecord>();
  readonly #executions = new Map<string, AIExecutionRecord>();
  #reasoning: AIProviderAdapter;
  #perception: AIProviderAdapter;

  /**
   * Providers beyond the two primaries, available when both are failing.
   *
   * Empty in local mode and empty when the overrides are supplied, so a test
   * that hands in two adapters gets exactly those two and nothing reaches the
   * network behind its back.
   */
  readonly #spares: AIProviderAdapter[];

  constructor(overrides: { reasoning?: AIProviderAdapter; perception?: AIProviderAdapter } = {}) {
    const live = config.ai.mode !== 'local';
    this.#reasoning = overrides.reasoning ?? (live ? remoteReasoning : mockReasoning);
    this.#perception = overrides.perception ?? (live ? remotePerception : mockPerception);
    this.#spares = live && !overrides.reasoning && !overrides.perception ? spareAdapters('REASONING') : [];
  }

  /**
   * Run a block against the deterministic local engines, whatever `AI_MODE`
   * says, and restore the configured providers afterwards.
   *
   * There is exactly one caller and one reason: the demonstration seed.
   *
   * A fixture that calls live models is a bad fixture twice over. It **costs
   * money** — seeding a whole lifecycle against three live providers is a real
   * invoice for a tenancy that exists to be looked at — and it is **not
   * reproducible**, because the narrative text differs on every run, so two
   * deployments of the same commit show different words and no two seeds hash
   * alike. Neither is acceptable for the one tenancy whose whole job is to be
   * the same thing every time.
   *
   * This is not a way to avoid paying for AI. Everything a *visitor* does on
   * the seeded tenancy afterwards runs against whatever `AI_MODE` selects and
   * settles against the wallet in the ordinary way. Only the building of the
   * fixture is local.
   *
   * `finally` rather than a plain restore: a seed that throws part-way must not
   * leave the platform pointing at the mocks, or every later call on that
   * process would silently be answered by a stand-in.
   */
  async withLocalProviders<T>(run: () => Promise<T>): Promise<T> {
    const reasoning = this.#reasoning;
    const perception = this.#perception;
    this.#reasoning = mockReasoning;
    this.#perception = mockPerception;
    try {
      return await run();
    } finally {
      this.#reasoning = reasoning;
      this.#perception = perception;
    }
  }

  /**
   * Vendors that could have served this call and were not cleared for it.
   *
   * Recorded rather than merely acted on. An audit that shows only the vendor
   * chosen cannot distinguish "the others were down" from "the others were not
   * allowed to see this", and those are entirely different facts.
   */
  #uncleared(
    capability: ProviderCapability,
    sensitivity: DataSensitivity,
  ): Array<{ provider: AIProvider; clearance: DataSensitivity }> {
    const primary = capability === 'PERCEPTION' ? this.#perception : this.#reasoning;
    const fallback = capability === 'PERCEPTION' ? this.#reasoning : this.#perception;
    return [primary, fallback, ...this.#spares]
      .filter((adapter, index, all) => all.findIndex((other) => other.name === adapter.name) === index)
      .filter((adapter) => !mayReceive(adapter, sensitivity))
      .map((adapter) => ({ provider: adapter.name, clearance: clearanceFor(adapter.name) }));
  }

  /**
   * Which vendor serves this call.
   *
   * Two things decide it, and the order matters: a vendor must be *cleared* for
   * the material before its health is even asked about. Failing over from a
   * cleared vendor to an uncleared one because the first was down would turn an
   * outage into a disclosure — the platform would silently send privileged
   * material somewhere it may not go, at exactly the moment nobody is watching.
   *
   * So clearance filters the candidates, and health picks among what is left.
   * When nothing is left the call is refused and says which level was refused
   * and to whom, because "no provider is cleared for LEGAL_L4" is actionable and
   * "AI unavailable" is not.
   */
  adapterFor(capability: ProviderCapability, sensitivity: DataSensitivity = 'INTERNAL'): AIProviderAdapter {
    const primary = capability === 'PERCEPTION' ? this.#perception : this.#reasoning;
    const fallback = capability === 'PERCEPTION' ? this.#reasoning : this.#perception;

    // The order the chain is tried in, unchanged. What changes is that an
    // uncleared vendor is not in it at all.
    const chain = [primary, fallback, ...this.#spares].filter(
      (adapter, index, all) => all.findIndex((other) => other.name === adapter.name) === index,
    );
    const cleared = chain.filter((adapter) => mayReceive(adapter, sensitivity));

    if (cleared.length === 0) {
      throw new DomainError(
        'AI_CLEARANCE_REQUIRED',
        `This request carries ${sensitivity} material and no configured AI provider is cleared to receive it. ` +
          `Clear a provider in AI_PROVIDER_CLEARANCE once the contract with that vendor permits it.`,
        // 403, not 503. Nothing is broken and retrying will not help: the
        // platform is refusing on purpose, and a client that reads this as an
        // outage will keep trying.
        403,
      );
    }

    const healthy = cleared.find((adapter) => adapter.healthy());
    if (healthy) return healthy;

    throw new DomainError('AI_UNAVAILABLE', 'No healthy AI provider is available for this capability', 503);
  }

  /**
   * What an AI action would cost, before anybody commits to it.
   *
   * The commercial model's own rule: *no AI action runs without showing its
   * estimated cost first*. It is the cheapest trust the platform can buy — a
   * prepaid wallet whose balance moves for reasons the user could not see
   * beforehand feels like a meter running, however fair the arithmetic.
   *
   * The hard part is not the pricing, it is the estimate. The real charge scales
   * with the size of the payload the engine assembles, and that payload does not
   * exist until the command runs — half of these commands register evidence
   * before they reach the provider, so there is no way to dry-run one without
   * leaving records behind.
   *
   * So the estimate is measured rather than modelled. Every settled execution
   * records its raw provider cost against the engine and task that caused it,
   * which is a direct answer to "what does this action normally cost on this
   * account", and it improves with use instead of drifting. Today's multiplier
   * is applied to a raw history so the figure is comparable with the charge the
   * next reservation will compute.
   *
   * Where the action has never run here there is no measurement, and the quote
   * says so: the provider's floor cost is a lower bound, not a prediction, and
   * presenting it as one would be the exact deception this rule exists to
   * prevent. Nothing is written and no provider is contacted either way.
   */
  quote(input: {
    capability: ProviderCapability;
    engine: string;
    taskType: string;
    wallet: ACUWallet;
    projectId?: string;
    /**
     * What the priced call would carry. Quoting against a vendor the real call
     * could not use would show a price nobody can transact at — and, worse, would
     * hide a refusal until after the user had committed to it.
     */
    inputRefs?: readonly EntityRef[];
  }): CostQuote {
    const adapter = this.adapterFor(input.capability, sensitivityOf(input.inputRefs ?? []));
    const observed = input.wallet.observedRawCosts(input.engine, input.taskType);

    // The floor: what the adapter charges for this capability with nothing to
    // read. Every real call costs at least this and almost always more.
    const floorRawMinor = adapter.estimateCostMinor({ task: input.taskType, payload: {} });

    const basis: QuoteBasis = observed.length > 0 ? 'MEASURED' : 'FLOOR';
    const estimatedRawCostMinor = basis === 'MEASURED' ? median(observed) : floorRawMinor;

    const priced = input.wallet.quote(estimatedRawCostMinor, input.projectId, input.engine);
    const charge = (rawMinor: number): number => Math.ceil(rawMinor * priced.multiplier);

    return {
      engine: input.engine,
      taskType: input.taskType,
      capability: input.capability,
      provider: adapter.name,
      basis,
      observations: observed.length,
      estimatedRawCostMinor,
      estimatedChargeMinor: priced.chargeMinor,
      lowChargeMinor: basis === 'MEASURED' ? charge(observed[0]!) : charge(floorRawMinor),
      highChargeMinor: basis === 'MEASURED' ? charge(observed[observed.length - 1]!) : undefined,
      multiplier: priced.multiplier,
      availableMinor: priced.availableMinor,
      balanceAfterMinor: Math.max(0, priced.availableMinor - priced.chargeMinor),
      affordable: priced.blockedReason === undefined,
      blockedReason: priced.blockedReason,
      blockedBy: priced.blockedBy,
      capBreach: priced.capBreach,
    };
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
      routing: { sensitivity: 'INTERNAL', provider: 'OPENAI', clearance: 'INTERNAL', excluded: [] },
    };

    // Derived from the records being sent, not declared by the caller. An
    // engine cannot understate what it is about to transmit, because it does
    // not get to say — the classification comes from the same table the generic
    // entity read already enforces.
    //
    // Resolved *before* the request is filed, so a refusal on clearance grounds
    // leaves no queued request behind claiming a routing that never happened.
    const sensitivity = sensitivityOf(input.inputRefs);
    const adapter = this.adapterFor(input.capability, sensitivity);
    aiRequest.routing = {
      sensitivity,
      provider: adapter.name,
      clearance: clearanceFor(adapter.name),
      excluded: this.#uncleared(input.capability, sensitivity),
    };
    this.#requests.set(aiRequest.id, aiRequest);
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
    /**
     * Every provider that could serve a request, primary or not.
     *
     * Reporting only the two primaries described the platform as
     * "OPENAI + GEMINI" while a configured Anthropic key sat in the failover
     * chain — accurate about what runs first, and misleading about what the
     * platform can actually fall back to. A third vendor that nothing mentions
     * is a third vendor nobody knows they are paying for.
     */
    available: Array<{ provider: AIProvider; healthy: boolean; role: 'REASONING' | 'PERCEPTION' | 'FAILOVER' }>;
    routingMatrix: typeof ROUTING_MATRIX;
    engineContracts: typeof ENGINE_CONTRACTS;
  } {
    const available: Array<{ provider: AIProvider; healthy: boolean; role: 'REASONING' | 'PERCEPTION' | 'FAILOVER' }> = [
      { provider: this.#reasoning.name, healthy: this.#reasoning.healthy(), role: 'REASONING' },
    ];
    if (this.#perception.name !== this.#reasoning.name) {
      available.push({ provider: this.#perception.name, healthy: this.#perception.healthy(), role: 'PERCEPTION' });
    }
    for (const spare of this.#spares) {
      if (available.some((entry) => entry.provider === spare.name)) continue;
      available.push({ provider: spare.name, healthy: spare.healthy(), role: 'FAILOVER' });
    }

    return {
      mode: config.ai.mode,
      reasoning: { provider: this.#reasoning.name, healthy: this.#reasoning.healthy() },
      perception: { provider: this.#perception.name, healthy: this.#perception.healthy() },
      available,
      routingMatrix: ROUTING_MATRIX,
      // Published so the console can grey out an engine that is not applicable
      // to the phase rather than offering it and failing. `runAI` enforces the
      // same table, so the interface holds no rule the API does not publish.
      engineContracts: ENGINE_CONTRACTS,
    };
  }
}
