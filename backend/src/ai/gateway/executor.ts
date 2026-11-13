/**
 * The CONSTRUX AI Gateway — the production executor (spec Inc.3b, §8).
 *
 * The one place the provider-neutral gateway meets the real orchestrator. It
 * **reuses** `orchestrator.execute` (adapter selection, ACU reserve/settle,
 * provider call) rather than re-implementing any of it, and forces the gateway's
 * chosen provider by passing every *other* wired provider as `avoidProviders` —
 * a preference the orchestrator honours unless its own hard constraints
 * (clearance, health, context window) rule it out, in which case the attempt
 * throws and the gateway service walks to the next provider in policy order, or
 * fails closed.
 *
 * It normalises the vendor reply into the canonical `UserSafeResult` — a summary,
 * a confidence *band* and source-anchored evidence — and **never lets the provider
 * name or model reach the user** (that stays on the admin route record).
 *
 * Validation is intentionally left empty here: the canonical validators are
 * Increment 4. Leaving the map empty means "not yet checked" (honest), not
 * "passed" (which would be faking a guarantee that does not exist yet).
 */
import type { EntityRef } from '../../goldenthread/types.ts';
import type { EngineContext } from '../../engines/context.ts';
import type { Engine } from '../orchestrator.ts';
import type { ProviderCapability } from '../providers/types.ts';
import { WIRED_PROVIDERS, type ConfidenceBand, type GatewayProvider, type TaskProfile } from './contract.ts';
import { ROUTE_POLICY } from './taxonomy.ts';
import { validateOutput, type ValidatableOutput } from './validators.ts';
import type { ExecutorResult, GatewayExecutor } from './service.ts';

/** Which CONSTRUX engine's provider pool a task profile draws on (capability comes from modality). */
const PROFILE_ENGINE: Record<TaskProfile, Engine> = {
  'vision.drawing_extract': 'BIM_TWIN',
  'vision.site_evidence': 'RISK_SAFETY',
  'document.itt_ingest': 'TENDER',
  'contract.obligation_analysis': 'CONTRACTS_CLAIMS',
  'claims.entitlement_analysis': 'CONTRACTS_CLAIMS',
  'tender.compliance_matrix': 'TENDER',
  'planning.logic_review': 'PLANNING',
  'commercial.cvr_analysis': 'RESOURCE_COST',
  'risk.change_analysis': 'RISK_SAFETY',
  'procurement.vendor_analysis': 'RESOURCE_COST',
  'workflow.agent_execution': 'EXECUTIVE',
  'document.generate': 'EXECUTIVE',
  'executive.synthesis': 'EXECUTIVE',
  'external.watchtower': 'EXECUTIVE',
  'operations.maintenance': 'HANDOVER_OM',
};

/**
 * How a task profile maps onto the orchestrator: which engine's provider pool,
 * which capability (from the modality) and the task-type key used for costing.
 * The one source for this mapping — the executor runs it, the endpoint quotes it.
 */
export function executionDescriptor(taskProfile: TaskProfile): { engine: Engine; capability: ProviderCapability; taskType: string } {
  return {
    engine: PROFILE_ENGINE[taskProfile],
    capability: ROUTE_POLICY[taskProfile].modality === 'VISION' ? 'PERCEPTION' : 'REASONING',
    taskType: `gateway:${taskProfile}`,
  };
}

/** A model confidence (0–1) → the user-facing band (spec §12, §15.3). */
export function confidenceBand(confidence: number | undefined): ConfidenceBand {
  if (confidence === undefined) return 'MEDIUM';
  if (confidence >= 0.75) return 'HIGH';
  if (confidence >= 0.4) return 'MEDIUM';
  return 'LOW';
}

/** Loosely parse a gateway input ref ("DocumentVersion:dv_9" or a bare id) into an EntityRef. */
function toEntityRef(ref: string): EntityRef {
  const i = ref.indexOf(':');
  return i > 0 ? { refType: ref.slice(0, i), refId: ref.slice(i + 1) } : { refType: 'GatewayInput', refId: ref };
}

/**
 * Lift the structured fields a well-formed provider reply carries into the shape
 * the validators inspect. Each is optional — a provider that omits one simply
 * leaves the floor that needs it unmet, which fails closed, rather than having a
 * value invented for it here.
 */
function readFindings(value: unknown): Array<{ statement: string; clause?: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((f) => {
    const o = (f ?? {}) as Record<string, unknown>;
    const clause = typeof o.clause === 'string' ? o.clause : undefined;
    return { statement: String(o.statement ?? o.text ?? ''), ...(clause ? { clause } : {}) };
  });
}

function readCalc(value: unknown): ValidatableOutput['calc'] | undefined {
  const o = (value ?? {}) as Record<string, unknown>;
  const ops = ['sum', 'subtract', 'multiply', 'divide'] as const;
  if (!ops.includes(o.op as (typeof ops)[number]) || !Array.isArray(o.operands) || typeof o.result !== 'number') return undefined;
  if (!o.operands.every((n) => typeof n === 'number')) return undefined;
  return { op: o.op as (typeof ops)[number], operands: o.operands as number[], result: o.result };
}

function readPostconditions(value: unknown): ValidatableOutput['postconditions'] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((p) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return { name: String(o.name ?? ''), met: o.met === true };
  });
}

function readEvidence(value: unknown): Array<{ sourceId: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((e) => {
      const o = (e ?? {}) as Record<string, unknown>;
      const sourceId = o.sourceId ?? o.source ?? o.ref;
      return typeof sourceId === 'string' ? { sourceId } : null;
    })
    .filter((e): e is { sourceId: string } => e !== null);
}

/**
 * Build a gateway executor bound to a project context. It runs the gateway's
 * chosen provider through the orchestrator and settles the ACU hold on success.
 */
export function orchestratorExecutor(ctx: EngineContext): GatewayExecutor {
  const executor: GatewayExecutor = async ({ provider, request }): Promise<ExecutorResult> => {
    const policy = ROUTE_POLICY[request.taskProfile];
    const { engine, capability, taskType } = executionDescriptor(request.taskProfile);
    // Force this provider: every other wired provider is "already had a turn".
    const avoidProviders = WIRED_PROVIDERS.filter((p) => p !== provider) as readonly GatewayProvider[] as readonly string[];
    const aiPermitted = !ctx.auth.roles.includes('REGULATOR') || ctx.auth.regulatorAiEnabled === true;

    const run = await ctx.orchestrator.execute(
      {
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        engine,
        taskType: `gateway:${request.taskProfile}`,
        capability,
        userId: ctx.auth.actorId,
        inputRefs: request.inputRefs.map(toEntityRef),
        request: {
          task: request.instruction,
          payload: { taskProfile: request.taskProfile, purpose: policy.purpose, inputRefs: request.inputRefs },
        },
        aiPermitted,
        avoidProviders,
      },
      ctx.wallet,
    );

    // Settle the hold — this execution persists nothing to the Golden Thread of
    // its own (the construx.ai.* audit is Increment 6), so it settles with no
    // output refs. Settlement debits the real provider cost.
    const execution = run.settle([]);
    const resp = run.response;
    const out = resp.output as Record<string, unknown>;
    const summary = String(out.narrative ?? out.text ?? out.summary ?? '').trim().slice(0, 8000);
    const findings = readFindings(out.findings);
    const calc = readCalc(out.calc);
    const postconditions = readPostconditions(out.postconditions);
    const disclaimer = typeof out.disclaimer === 'string' ? out.disclaimer : undefined;

    // The input refs anchor the reading material; any evidence the model itself
    // cited is merged in beside them.
    const evidence = [...request.inputRefs.map((sourceId) => ({ sourceId })), ...readEvidence(out.evidence)];

    // The normalised view the quality floors are checked against (spec §12).
    const validatable: ValidatableOutput = {
      summary,
      evidence,
      ...(resp.confidence !== undefined ? { confidence: resp.confidence } : {}),
      ...(findings ? { findings } : {}),
      ...(calc ? { calc } : {}),
      ...(postconditions ? { postconditions } : {}),
      ...(disclaimer ? { disclaimer } : {}),
    };
    const validation = validateOutput(policy.validations, validatable, { inputRefs: request.inputRefs });

    return {
      provider: resp.provider,
      model: resp.modelClass,
      result: {
        summary,
        findings: (findings ?? []).map((f) => f.statement).filter((s) => s.length > 0),
        evidence,
        limitations: resp.synthetic === true ? ['Produced by the deterministic stand-in — not model reasoning.'] : [],
        confidenceBand: confidenceBand(resp.confidence),
      },
      usage: { rawCostMinor: resp.rawCostMinor, latencyMs: resp.latencyMs, acuConsumed: execution.acuConsumed },
      costMinor: resp.rawCostMinor,
      validation,
    };
  };
  return executor;
}
