import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
  TASK_PROFILES,
  canTransition,
  isTaskProfile,
  providerIsWired,
  type GatewayProvider,
} from '../src/ai/gateway/contract.ts';
import { POLICY_VERSION, ROUTE_POLICY, routeChain } from '../src/ai/gateway/taxonomy.ts';
import { selectRoute, routeIsEligible, type ProviderStatus } from '../src/ai/gateway/router.ts';
import { approvalRequirement, assertGrantAllowed, screenInstruction } from '../src/ai/gateway/policy.ts';
import { runGatewayTask, type ExecutorResult, type GatewayExecutor } from '../src/ai/gateway/service.ts';
import type { AITaskRequest, ValidationKind } from '../src/ai/gateway/contract.ts';
import { confidenceBand, executionDescriptor, orchestratorExecutor } from '../src/ai/gateway/executor.ts';
import { WIRED_PROVIDERS } from '../src/ai/gateway/contract.ts';
import type { ProviderAvailability } from '../src/ai/gateway/router.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { ACUWallet } from '../src/billing/acu.ts';
import type { EngineContext } from '../src/engines/context.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import {
  approveGatewayRequest,
  listGatewayRequests,
  persistGatewayRequest,
  readGatewayRequest,
  rejectGatewayRequest,
} from '../src/ai/gateway/store.ts';
import type { UserSafeResponse } from '../src/ai/gateway/contract.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * The CONSTRUX AI Gateway, Increment 1–2: the canonical contract, the versioned
 * task→route policy, the fail-closed router and the prohibited-action policy.
 * Numbered to the spec's acceptance tests (§19) where they apply at this layer.
 */

const up: ProviderStatus = { wired: true, healthy: true, cleared: true };
const allUp = () => up;
const withDown = (down: Partial<Record<GatewayProvider, Partial<ProviderStatus>>>) =>
  (p: GatewayProvider): ProviderStatus => ({ ...up, ...(down[p] ?? {}) });

describe('policy taxonomy is complete and consistent', () => {
  it('has a route policy with a non-empty chain for every task profile', () => {
    for (const profile of TASK_PROFILES) {
      assert.ok(ROUTE_POLICY[profile], `${profile} has a policy`);
      assert.ok(routeChain(profile).length >= 1, `${profile} has a route chain`);
      assert.ok(ROUTE_POLICY[profile].validations.length >= 1, `${profile} declares validations`);
    }
    assert.equal(isTaskProfile('contract.obligation_analysis'), true);
    assert.equal(isTaskProfile('not.a.profile'), false);
  });
});

describe('AT-01 — a drawing extraction task routes to the perception provider', () => {
  it('selects Gemini primary, with source anchors and a confidence floor', () => {
    const plan = selectRoute('vision.drawing_extract', allUp);
    assert.equal(plan.plan[0], 'GEMINI');
    assert.equal(plan.policyVersion, POLICY_VERSION);
    assert.deepEqual(ROUTE_POLICY['vision.drawing_extract'].validations.includes('SOURCE_ANCHORS'), true);
    assert.deepEqual(ROUTE_POLICY['vision.drawing_extract'].validations.includes('CONFIDENCE_FLOOR'), true);
  });
});

describe('AT-02 — a contract obligation task is Claude-primary and awaits human review', () => {
  it('selects Claude (Anthropic) and requires approval by the contract authority', () => {
    const plan = selectRoute('contract.obligation_analysis', allUp);
    assert.equal(plan.plan[0], 'ANTHROPIC');
    assert.deepEqual(ROUTE_POLICY['contract.obligation_analysis'].validations.includes('CLAUSE_CITATIONS'), true);
    const approval = approvalRequirement('contract.obligation_analysis', 'commercial_material_output');
    assert.equal(approval.required, true);
    assert.deepEqual(approval.authority, { area: 'CONTRACTS_CLAIMS', code: 'A' });
  });
});

describe('AT-04 — a provider outage uses policy-equivalent fallback, provider-neutral', () => {
  it('drops the unhealthy primary and records why, without exposing identity to the user', () => {
    // Claude down → contract task falls to its task-specific fallback (OpenAI), as policy, not a universal sequence.
    const plan = selectRoute('contract.obligation_analysis', withDown({ ANTHROPIC: { healthy: false } }));
    assert.equal(plan.plan[0], 'OPENAI');
    assert.ok(plan.skipped.some((s) => s.provider === 'ANTHROPIC' && s.reason === 'UNHEALTHY'));
    // The route plan is admin data; nothing here is a user-facing field.
    assert.equal(routeIsEligible(plan), true);
  });
});

describe('AT-05 — no eligible route fails closed (never fabricates)', () => {
  it('returns an empty plan when nothing is healthy/cleared', () => {
    const plan = selectRoute('contract.obligation_analysis', () => ({ wired: true, healthy: false, cleared: true }));
    assert.equal(plan.plan.length, 0);
    assert.equal(routeIsEligible(plan), false);
  });
  it('fails closed when data is not cleared for any provider (residency/sensitivity)', () => {
    const plan = selectRoute('claims.entitlement_analysis', () => ({ wired: true, healthy: true, cleared: false }));
    assert.equal(routeIsEligible(plan), false);
    assert.ok(plan.skipped.every((s) => s.reason === 'NOT_CLEARED'));
  });
});

describe('AT-06 — prohibited actions are refused before any provider or tool runs', () => {
  it('rejects a tool grant that includes a consequential capability', () => {
    assert.throws(() => assertGrantAllowed(['READ', 'APPROVE']), (e) => (e as { code?: string }).code === 'AI_PROHIBITED_ACTION');
    assert.throws(() => assertGrantAllowed(['PAYMENT_RELEASE']), (e) => (e as { code?: string }).code === 'AI_PROHIBITED_ACTION');
    assert.doesNotThrow(() => assertGrantAllowed(['READ', 'DRAFT', 'ANALYSE']));
  });
  it('flags an instruction that asks the gateway to perform a consequential act', () => {
    assert.equal(screenInstruction('Approve the payment certificate for £40,000'), 'AI_PROHIBITED_ACTION');
    assert.equal(screenInstruction('Issue and serve the delay notice'), 'AI_PROHIBITED_ACTION');
    // The permitted shape — draft/analyse — is allowed through.
    assert.equal(screenInstruction('Draft a delay notice and identify the obligation'), null);
    assert.equal(screenInstruction('Analyse the contract for notice obligations'), null);
  });
});

describe('Vertex is named in policy but deferred — the router skips it cleanly', () => {
  it('routes operations.maintenance past the unwired Vertex primary to OpenAI', () => {
    assert.equal(providerIsWired('VERTEX'), false);
    const plan = selectRoute('operations.maintenance', allUp);
    assert.equal(plan.plan[0], 'OPENAI'); // VERTEX skipped as NOT_WIRED, falls to the next in policy
    assert.ok(plan.skipped.some((s) => s.provider === 'VERTEX' && s.reason === 'NOT_WIRED'));
  });
});

describe('the request state machine only permits the lifecycle transitions', () => {
  it('allows the forward path and refuses a skip', () => {
    assert.equal(canTransition('RECEIVED', 'POLICY_CHECKED'), true);
    assert.equal(canTransition('VALIDATING', 'AWAITING_APPROVAL'), true);
    assert.equal(canTransition('AWAITING_APPROVAL', 'COMPLETED'), true);
    assert.equal(canTransition('RECEIVED', 'COMPLETED'), false);
    assert.equal(canTransition('COMPLETED', 'RUNNING'), false);
  });
});

describe('consequential tasks always require approval; informational never do', () => {
  it('classifies by risk tier', () => {
    assert.equal(approvalRequirement('procurement.vendor_analysis').required, true); // CONSEQUENTIAL
    assert.equal(approvalRequirement('workflow.agent_execution').required, true); // CONSEQUENTIAL
    assert.equal(approvalRequirement('vision.drawing_extract').required, false); // INFORMATIONAL
    assert.equal(approvalRequirement('tender.compliance_matrix').required, false); // MATERIAL, no policy opted
    assert.equal(approvalRequirement('tender.compliance_matrix', 'opted').required, true); // MATERIAL + policy
  });
});

// ---- Increment 3: the lifecycle service ------------------------------------

const req = (over: Partial<AITaskRequest> = {}): AITaskRequest => ({
  taskProfile: 'tender.compliance_matrix',
  tenantId: 't1', projectId: 'p1', inputRefs: ['doc1'],
  instruction: 'Analyse the invitation and set it against our facts',
  idempotencyKey: 'idem-1', ...over,
});
const okExec = (validation: Partial<Record<ValidationKind, 'PASS' | 'FAIL'>> = {}): GatewayExecutor =>
  async ({ provider }): Promise<ExecutorResult> => ({
    provider, model: 'model-x',
    result: { summary: 'ok', findings: [], evidence: [{ sourceId: 'doc1' }], limitations: [], confidenceBand: 'HIGH' },
    usage: { tokens: 12 }, costMinor: 7, validation,
  });

describe('service — a clean run completes with a user-safe, provider-free result', () => {
  it('COMPLETED, and the user response carries no provider/model/cost', async () => {
    const { user, admin } = await runGatewayTask({ request: req(), availability: allUp, execute: okExec(), requestId: 'air1', reserveAcu: () => ({ ok: true, reserved: 7 }) });
    assert.equal(user.status, 'COMPLETED');
    assert.equal(user.result?.confidenceBand, 'HIGH');
    assert.equal('selectedProvider' in (user as Record<string, unknown>), false);
    assert.equal(JSON.stringify(user).includes('ANTHROPIC'), false);
    assert.equal(JSON.stringify(user).includes('model-x'), false);
    // The admin record DOES name the provider — that is the separation.
    assert.equal(admin.selectedProvider, 'ANTHROPIC');
    assert.equal(admin.selectedModel, 'model-x');
  });
});

describe('service — AT-04 fallback walks the policy chain and records attempts', () => {
  it('fails the primary, succeeds on the next, user never sees which', async () => {
    let calls = 0;
    const flaky: GatewayExecutor = async ({ provider }) => {
      calls += 1;
      if (provider === 'ANTHROPIC') throw new Error('primary down');
      return { provider, model: 'm', result: { summary: 'ok', findings: [], evidence: [], limitations: [], confidenceBand: 'MEDIUM' }, usage: {}, costMinor: 1, validation: {} };
    };
    const { user, admin } = await runGatewayTask({ request: req(), availability: allUp, execute: flaky, requestId: 'air2' });
    assert.equal(user.status, 'COMPLETED');
    assert.equal(admin.selectedProvider, 'OPENAI'); // the task-specific fallback
    assert.ok(admin.attempts.some((a) => a.provider === 'ANTHROPIC' && a.outcome === 'FAILURE'));
    assert.ok(admin.attempts.some((a) => a.provider === 'OPENAI' && a.outcome === 'SUCCESS'));
    assert.equal(calls, 2);
  });
});

describe('service — AT-06 a prohibited instruction is refused before execution', () => {
  it('REJECTED, no provider is contacted', async () => {
    let ran = false;
    const exec: GatewayExecutor = async (x) => { ran = true; return okExec()(x); };
    const { user } = await runGatewayTask({ request: req({ instruction: 'Approve and release the payment certificate' }), availability: allUp, execute: exec, requestId: 'air3' });
    assert.equal(user.status, 'REJECTED');
    assert.equal(ran, false);
  });
});

describe('service — AT-05 no eligible route fails closed, nothing fabricated', async () => {
  it('FAILED with no result', async () => {
    let ran = false;
    const exec: GatewayExecutor = async (x) => { ran = true; return okExec()(x); };
    const { user } = await runGatewayTask({ request: req(), availability: () => ({ wired: true, healthy: false, cleared: true }), execute: exec, requestId: 'air4' });
    assert.equal(user.status, 'FAILED');
    assert.equal(user.result, undefined);
    assert.equal(ran, false);
  });
});

describe('service — AT-07 a consequential output is held for approval, not committed', () => {
  it('AWAITING_APPROVAL carries the draft but is not COMPLETED', async () => {
    const { user } = await runGatewayTask({ request: req({ taskProfile: 'procurement.vendor_analysis', instruction: 'Evaluate the three suppliers against the criteria' }), availability: allUp, execute: okExec(), requestId: 'air5' });
    assert.equal(user.status, 'AWAITING_APPROVAL');
    assert.equal(user.approval.required, true);
    assert.ok(user.result); // the draft is there to review
    assert.deepEqual(user.approval.roles, ['PROCUREMENT_AWARD:A']);
  });
});

describe('service — an empty wallet contacts no provider; a failed validator fails closed', () => {
  it('AI_WALLET_EMPTY → FAILED, nothing run', async () => {
    let ran = false;
    const exec: GatewayExecutor = async (x) => { ran = true; return okExec()(x); };
    const { user } = await runGatewayTask({ request: req(), availability: allUp, execute: exec, requestId: 'air6', reserveAcu: () => ({ ok: false, reserved: 0 }) });
    assert.equal(user.status, 'FAILED');
    assert.equal(ran, false);
  });
  it('a required validator returning FAIL → FAILED (quality floor unmet)', async () => {
    const { user } = await runGatewayTask({ request: req(), availability: allUp, execute: okExec({ COMPLETENESS: 'FAIL' }), requestId: 'air7' });
    assert.equal(user.status, 'FAILED');
  });
});

describe('service — events are emitted across the lifecycle', () => {
  it('emits received → policy → route → attempted → validated → completed', async () => {
    const events: string[] = [];
    await runGatewayTask({ request: req(), availability: allUp, execute: okExec(), requestId: 'air8', emit: (e) => events.push(e.type) });
    assert.ok(events.includes('construx.ai.request.received'));
    assert.ok(events.includes('construx.ai.route.selected'));
    assert.ok(events.includes('construx.ai.provider.attempted'));
    assert.ok(events.includes('construx.ai.request.completed'));
  });
});

/**
 * Increment 3b — the production executor over the real orchestrator.
 *
 * These exercise `orchestratorExecutor` for real (not the deterministic test
 * double above): a genuine `AIOrchestrator` with a funded `ACUWallet`, driven
 * through `runGatewayTask` exactly as the `POST /v1/ai/requests` endpoint does.
 * They prove the three things the endpoint relies on: the vendor reply is
 * normalised to a user-safe result, the ACU hold is actually settled, and the
 * provider identity never crosses into the user response.
 */

/** A reasoning provider that answers with a narrative + confidence, like a real adapter. */
function narratingProvider(opts: { confidence?: number; synthetic?: boolean; cost?: number } = {}): AIProviderAdapter & { calls: number } {
  const p = {
    name: 'OPENAI' as const,
    capability: 'REASONING' as const,
    multimodal: false,
    transmits: true,
    calls: 0,
    estimateCostMinor: () => opts.cost ?? 100,
    costAtTokensMinor: () => opts.cost ?? 100,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      p.calls += 1;
      return {
        provider: 'OPENAI',
        modelClass: request.modelClass ?? 'default',
        output: { narrative: 'The invitation is met on 14 of 15 clauses.' },
        rawCostMinor: opts.cost ?? 100,
        latencyMs: 9,
        ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
        ...(opts.synthetic ? { synthetic: true } : {}),
      };
    },
  };
  return p as AIProviderAdapter & { calls: number };
}

function gatewayContext(orchestrator: AIOrchestrator, wallet: ACUWallet): EngineContext {
  // The executor reads only this narrow slice of the context — the orchestrator,
  // the wallet, the ids and the actor's roles. Built directly so the test stays
  // about the gateway, not the whole platform boot.
  return {
    orchestrator,
    wallet,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    auth: { actorId: 'user-1', roles: [], regulatorAiEnabled: false },
  } as unknown as EngineContext;
}

const everyWiredUp: ProviderAvailability = (provider) => ({
  wired: (WIRED_PROVIDERS as readonly string[]).includes(provider),
  healthy: true,
  cleared: true,
});

describe('executor — confidence (0–1) maps to the user-facing band', () => {
  it('banishes the raw number for a band', () => {
    assert.equal(confidenceBand(0.9), 'HIGH');
    assert.equal(confidenceBand(0.5), 'MEDIUM');
    assert.equal(confidenceBand(0.2), 'LOW');
    assert.equal(confidenceBand(undefined), 'MEDIUM');
  });
});

describe('executor — descriptor is the one source for engine/capability/taskType', () => {
  it('a vision profile runs on PERCEPTION, a reasoning profile on REASONING', () => {
    assert.equal(executionDescriptor('vision.drawing_extract').capability, 'PERCEPTION');
    assert.equal(executionDescriptor('contract.obligation_analysis').capability, 'REASONING');
    assert.equal(executionDescriptor('tender.compliance_matrix').taskType, 'gateway:tender.compliance_matrix');
  });
});

describe('executor — a real orchestrator run through the gateway (Inc.3b)', () => {
  it('COMPLETED, ACU settled from the hold, no provider/model leak to the user', async () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.grantTrialCredit(10_000);
    const orchestrator = new AIOrchestrator({
      reasoning: narratingProvider({ confidence: 0.9 }),
      perception: narratingProvider({ confidence: 0.9 }),
    });
    const ctx = gatewayContext(orchestrator, wallet);

    const { user, admin } = await runGatewayTask({
      request: req({ inputRefs: [] }),
      availability: everyWiredUp,
      execute: orchestratorExecutor(ctx),
      requestId: 'prod-1',
      reserveAcu: () => ({ ok: true, reserved: 12 }),
    });

    assert.equal(user.status, 'COMPLETED');
    assert.equal(user.result?.confidenceBand, 'HIGH');
    assert.match(user.result?.summary ?? '', /invitation is met/);
    // The user-safe response names no vendor, model or raw cost.
    const serialised = JSON.stringify(user);
    assert.equal(serialised.includes('OPENAI'), false);
    assert.equal(serialised.includes('rawCostMinor'), false);
    assert.equal('selectedProvider' in (user as Record<string, unknown>), false);
    // The admin record does, and the hold was really settled (acu consumed > 0).
    assert.ok(admin.selectedProvider !== null);
    assert.ok((admin.providerUsage.acuConsumed ?? 0) > 0, 'ACU was settled, not left on a hold');
  });

  it('labels a deterministic stand-in as not model reasoning (never passes it off)', async () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.grantTrialCredit(10_000);
    const orchestrator = new AIOrchestrator({
      reasoning: narratingProvider({ confidence: 0.9, synthetic: true }),
      perception: narratingProvider({ confidence: 0.9, synthetic: true }),
    });
    const ctx = gatewayContext(orchestrator, wallet);

    const { user } = await runGatewayTask({
      request: req({ inputRefs: [] }),
      availability: everyWiredUp,
      execute: orchestratorExecutor(ctx),
      requestId: 'prod-2',
      reserveAcu: () => ({ ok: true, reserved: 12 }),
    });

    assert.equal(user.status, 'COMPLETED');
    assert.ok((user.result?.limitations ?? []).some((l) => /stand-in|not model reasoning/i.test(l)));
  });

  it('fails closed when an input of unknown provenance cannot be cleared (never fabricates)', async () => {
    // A ref the orchestrator cannot resolve is classified at the highest
    // sensitivity, and no provider is cleared for it — so the whole chain is
    // refused and the gateway returns FAILED rather than an invented answer.
    const wallet = new ACUWallet('tenant-1');
    wallet.grantTrialCredit(10_000);
    const orchestrator = new AIOrchestrator({
      reasoning: narratingProvider({ confidence: 0.9 }),
      perception: narratingProvider({ confidence: 0.9 }),
    });
    const ctx = gatewayContext(orchestrator, wallet);

    const { user } = await runGatewayTask({
      request: req({ inputRefs: ['opaque-handle'] }),
      availability: everyWiredUp,
      execute: orchestratorExecutor(ctx),
      requestId: 'prod-3',
      reserveAcu: () => ({ ok: true, reserved: 12 }),
    });

    assert.equal(user.status, 'FAILED');
    assert.equal(user.result, undefined, 'no result body on a fail-closed refusal');
  });
});

/**
 * Increment 4 — the output validators (spec §12).
 *
 * The quality floors each task owes, checked for real and fail-closed: a floor
 * passes only on positive evidence it is met, and a required floor that cannot be
 * shown to hold refuses the output rather than letting it through.
 */
import { validateOutput, type ValidatableOutput } from '../src/ai/gateway/validators.ts';

const baseOut = (over: Partial<ValidatableOutput> = {}): ValidatableOutput => ({
  summary: 'An answer that says something.', evidence: [{ sourceId: 'doc1' }], ...over,
});

describe('validators — each floor passes only on positive evidence (Inc.4)', () => {
  it('COMPLETENESS fails on an empty answer', () => {
    assert.equal(validateOutput(['COMPLETENESS'], baseOut({ summary: '   ' }), { inputRefs: [] }).COMPLETENESS, 'FAIL');
    assert.equal(validateOutput(['COMPLETENESS'], baseOut(), { inputRefs: [] }).COMPLETENESS, 'PASS');
  });
  it('SOURCE_ANCHORS needs an anchor when inputs were supplied', () => {
    assert.equal(validateOutput(['SOURCE_ANCHORS'], baseOut({ evidence: [] }), { inputRefs: ['doc1'] }).SOURCE_ANCHORS, 'FAIL');
    assert.equal(validateOutput(['SOURCE_ANCHORS'], baseOut({ evidence: [] }), { inputRefs: [] }).SOURCE_ANCHORS, 'PASS');
    assert.equal(validateOutput(['SOURCE_ANCHORS'], baseOut({ evidence: [{ sourceId: ' ' }] }), { inputRefs: [] }).SOURCE_ANCHORS, 'FAIL');
  });
  it('CONFIDENCE_FLOOR fails only on an explicitly low confidence', () => {
    assert.equal(validateOutput(['CONFIDENCE_FLOOR'], baseOut({ confidence: 0.2 }), { inputRefs: [] }).CONFIDENCE_FLOOR, 'FAIL');
    assert.equal(validateOutput(['CONFIDENCE_FLOOR'], baseOut({ confidence: 0.9 }), { inputRefs: [] }).CONFIDENCE_FLOOR, 'PASS');
    assert.equal(validateOutput(['CONFIDENCE_FLOOR'], baseOut(), { inputRefs: [] }).CONFIDENCE_FLOOR, 'PASS');
  });
  it('DETERMINISTIC_CALC_MATCH recomputes, and fails on a mismatch or a missing calc', () => {
    assert.equal(validateOutput(['DETERMINISTIC_CALC_MATCH'], baseOut({ calc: { op: 'sum', operands: [2, 3], result: 5 } }), { inputRefs: [] }).DETERMINISTIC_CALC_MATCH, 'PASS');
    assert.equal(validateOutput(['DETERMINISTIC_CALC_MATCH'], baseOut({ calc: { op: 'sum', operands: [2, 3], result: 6 } }), { inputRefs: [] }).DETERMINISTIC_CALC_MATCH, 'FAIL');
    assert.equal(validateOutput(['DETERMINISTIC_CALC_MATCH'], baseOut(), { inputRefs: [] }).DETERMINISTIC_CALC_MATCH, 'FAIL');
    assert.equal(validateOutput(['DETERMINISTIC_CALC_MATCH'], baseOut({ calc: { op: 'divide', operands: [10, 0], result: 0 } }), { inputRefs: [] }).DETERMINISTIC_CALC_MATCH, 'FAIL');
  });
  it('CLAUSE_CITATIONS needs a cited clause', () => {
    assert.equal(validateOutput(['CLAUSE_CITATIONS'], baseOut({ summary: 'See clause 14.2 of the contract.' }), { inputRefs: [] }).CLAUSE_CITATIONS, 'PASS');
    assert.equal(validateOutput(['CLAUSE_CITATIONS'], baseOut({ findings: [{ statement: 'x', clause: '14.2' }] }), { inputRefs: [] }).CLAUSE_CITATIONS, 'PASS');
    assert.equal(validateOutput(['CLAUSE_CITATIONS'], baseOut({ summary: 'No reference at all.' }), { inputRefs: [] }).CLAUSE_CITATIONS, 'FAIL');
  });
  it('OBSERVATION_ONLY_LANGUAGE rejects prescriptive language', () => {
    assert.equal(validateOutput(['OBSERVATION_ONLY_LANGUAGE'], baseOut({ summary: 'Crack visible to the north face.' }), { inputRefs: [] }).OBSERVATION_ONLY_LANGUAGE, 'PASS');
    assert.equal(validateOutput(['OBSERVATION_ONLY_LANGUAGE'], baseOut({ summary: 'You must replace the beam.' }), { inputRefs: [] }).OBSERVATION_ONLY_LANGUAGE, 'FAIL');
  });
  it('LEGAL_DISCLAIMER needs a disclaimer', () => {
    assert.equal(validateOutput(['LEGAL_DISCLAIMER'], baseOut({ disclaimer: 'This is not legal advice.' }), { inputRefs: [] }).LEGAL_DISCLAIMER, 'PASS');
    assert.equal(validateOutput(['LEGAL_DISCLAIMER'], baseOut({ summary: 'An entitlement, subject to legal review.' }), { inputRefs: [] }).LEGAL_DISCLAIMER, 'PASS');
    assert.equal(validateOutput(['LEGAL_DISCLAIMER'], baseOut(), { inputRefs: [] }).LEGAL_DISCLAIMER, 'FAIL');
  });
  it('TOOL_POSTCONDITION needs every asserted postcondition met', () => {
    assert.equal(validateOutput(['TOOL_POSTCONDITION'], baseOut({ postconditions: [{ name: 'order-raised', met: true }] }), { inputRefs: [] }).TOOL_POSTCONDITION, 'PASS');
    assert.equal(validateOutput(['TOOL_POSTCONDITION'], baseOut({ postconditions: [{ name: 'order-raised', met: false }] }), { inputRefs: [] }).TOOL_POSTCONDITION, 'FAIL');
    assert.equal(validateOutput(['TOOL_POSTCONDITION'], baseOut(), { inputRefs: [] }).TOOL_POSTCONDITION, 'FAIL');
  });
});

/** A reasoning provider that returns a fixed structured output, like a real adapter would. */
function structuredProvider(output: Record<string, unknown>): AIProviderAdapter {
  const p: AIProviderAdapter = {
    name: 'OPENAI', capability: 'REASONING', multimodal: false, transmits: true,
    estimateCostMinor: () => 100, costAtTokensMinor: () => 100, healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      return { provider: 'OPENAI', modelClass: request.modelClass ?? 'default', output, rawCostMinor: 100, latencyMs: 9, confidence: 0.9 };
    },
  } as AIProviderAdapter;
  return p;
}

describe('executor — a required floor failing refuses the whole task (Inc.4 end to end)', () => {
  const run = async (output: Record<string, unknown>) => {
    const wallet = new ACUWallet('tenant-1');
    wallet.grantTrialCredit(10_000);
    const orchestrator = new AIOrchestrator({ reasoning: structuredProvider(output), perception: structuredProvider(output) });
    const ctx = gatewayContext(orchestrator, wallet);
    return runGatewayTask({
      request: req({ taskProfile: 'commercial.cvr_analysis', instruction: 'Reconcile the cost/value report', inputRefs: [] }),
      availability: everyWiredUp, execute: orchestratorExecutor(ctx), requestId: 'cvr', reserveAcu: () => ({ ok: true, reserved: 12 }),
    });
  };

  it('a CVR whose arithmetic does not recompute is refused, not shown', async () => {
    const { user } = await run({ narrative: 'Forecast final cost reconciled.', calc: { op: 'sum', operands: [100, 200], result: 999 } });
    assert.equal(user.status, 'FAILED');
    assert.equal(user.result, undefined);
  });
  it('a CVR with no verifiable calculation fails closed (never an unverified number)', async () => {
    const { user } = await run({ narrative: 'Forecast final cost reconciled.' });
    assert.equal(user.status, 'FAILED');
  });
  it('a CVR whose arithmetic recomputes completes and is returned', async () => {
    const { user } = await run({ narrative: 'Forecast final cost reconciled.', calc: { op: 'sum', operands: [100, 200], result: 300 } });
    assert.equal(user.status, 'COMPLETED');
    assert.match(user.result?.summary ?? '', /reconciled/);
  });
});

/**
 * Increment 5 — the persisted request + human approval gate (spec §6, §11, §16).
 *
 * The pure service drives a task to a terminal state in memory; this increment
 * makes that outcome a durable Golden-Thread record that can be read back by id
 * and, where the output is consequential, held until a named, authorised person
 * releases it. These run against a real platform, ledger and identity model —
 * the same `persistGatewayRequest` / `readGatewayRequest` / `approve…` / `reject…`
 * the endpoint calls — so the scope, the authority and the provider-hiding are
 * proven end to end rather than asserted about a double.
 */
describe('gateway store — a request is persisted, read back, and held for a human (Inc.5)', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  // The requester is any delivery user who may write; the approver must hold the
  // task's approval authority. A tender compliance task is released by the bid
  // authority (ESTIMATE_TENDER:A) — the owner holds it, the QS does not.
  const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
  const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

  const held = (id: string): UserSafeResponse => ({
    requestId: id,
    status: 'AWAITING_APPROVAL',
    taskProfile: 'tender.compliance_matrix',
    result: { summary: 'The invitation is met on 14 of 15 clauses.', findings: [], evidence: [{ sourceId: 'itt-1' }], limitations: [], confidenceBand: 'HIGH' },
    approval: { required: true, roles: ['ESTIMATE_TENDER:A'] },
    acu: { reserved: 12, settled: 0 },
  });
  const AUTH = { area: 'ESTIMATE_TENDER', code: 'A' } as const;

  it('is reachable, classified, and the decision events refuse an AI author', () => {
    for (const [method, pattern] of [
      ['POST', '/v1/ai/requests'],
      ['GET', '/v1/projects/:projectId/ai/requests'],
      ['GET', '/v1/projects/:projectId/ai/requests/:requestId'],
      ['POST', '/v1/projects/:projectId/ai/requests/:requestId/approvals'],
    ] as const) {
      assert.ok(ROUTES.some((r) => r.method === method && r.pattern === pattern), `${method} ${pattern} has no route`);
    }
    // The persisted request is an AI-execution entity (operator-blind, tenant-read).
    assert.deepEqual(classifyEntity('AIGatewayRequest'), { area: 'AI_EXECUTION' });
    // Releasing or rejecting a held output is a human decision — no AI actor may author it.
    assert.equal(lookupEventType('AI_GATEWAY_APPROVED')?.aiAllowed, false);
    assert.equal(lookupEventType('AI_GATEWAY_REJECTED')?.aiAllowed, false);
    // The run that produced the output may be AI-authored; the entity is created by it.
    assert.equal(lookupEventType('AI_GATEWAY_REQUESTED')?.aiAllowed, true);
    assert.equal(lookupEventType('AI_GATEWAY_REQUESTED')?.creates, true);
  });

  it('persists a held request and reads it back, with no provider/model/cost on it', () => {
    const { response, reused } = persistGatewayRequest(asQS(), { response: held('g-read'), authority: AUTH });
    assert.equal(reused, false);
    assert.equal(response.status, 'AWAITING_APPROVAL');

    const back = readGatewayRequest(asQS(), 'g-read');
    assert.ok(back);
    assert.equal(back!.status, 'AWAITING_APPROVAL');
    assert.equal(back!.approval.required, true);
    assert.match(back!.result?.summary ?? '', /14 of 15/);
    // Nothing the operator keeps ever crossed into the persisted customer record.
    const serialised = JSON.stringify(back);
    for (const leak of ['OPENAI', 'ANTHROPIC', 'GEMINI', 'rawCost', 'providerCost', 'selectedModel', 'selectedProvider']) {
      assert.equal(serialised.includes(leak), false, `persisted request leaked ${leak}`);
    }
  });

  it('is idempotent on the request id — a repeat returns the stored request unchanged', () => {
    const first = persistGatewayRequest(asQS(), { response: held('g-idem'), authority: AUTH });
    assert.equal(first.reused, false);
    // A second persist under the same id (e.g. an idempotent replay) does not duplicate.
    const second = persistGatewayRequest(asQS(), { response: { ...held('g-idem'), status: 'COMPLETED' }, authority: AUTH });
    assert.equal(second.reused, true);
    assert.equal(second.response.status, 'AWAITING_APPROVAL', 'the stored state wins, not the replayed one');
  });

  it('a request is read back only inside its own project, not a sibling in the same tenant', () => {
    persistGatewayRequest(asQS(), { response: held('g-scope'), authority: AUTH });
    // The governance scope is a different project ledger in the same tenant.
    const governance = platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    assert.equal(readGatewayRequest(governance, 'g-scope'), undefined);
  });

  it('the bid authority releases a held output; the result stays, the gate closes', () => {
    persistGatewayRequest(asQS(), { response: held('g-approve'), authority: AUTH });
    const out = approveGatewayRequest(asOwner(), 'g-approve');
    assert.equal(out.status, 'COMPLETED');
    assert.equal(out.approval.required, false);
    assert.match(out.result?.summary ?? '', /14 of 15/);
    // And the read-back reflects the decision.
    assert.equal(readGatewayRequest(asQS(), 'g-approve')?.status, 'COMPLETED');
  });

  it('a user without the task authority cannot release the output', () => {
    // A contract-obligation output is released by the contract authority
    // (CONTRACTS_CLAIMS:A). The QS authors commercial documents but holds no
    // approve right there — by construction, so one person is never both ends.
    const contractHeld: UserSafeResponse = {
      requestId: 'g-denied',
      status: 'AWAITING_APPROVAL',
      taskProfile: 'contract.obligation_analysis',
      result: { summary: 'Clause 60.1(12) carries the risk.', findings: [], evidence: [{ sourceId: 'c-1' }], limitations: [], confidenceBand: 'HIGH' },
      approval: { required: true, roles: ['CONTRACTS_CLAIMS:A'] },
      acu: { reserved: 12, settled: 0 },
    };
    persistGatewayRequest(asQS(), { response: contractHeld, authority: { area: 'CONTRACTS_CLAIMS', code: 'A' } });
    assert.throws(() => approveGatewayRequest(asQS(), 'g-denied'));
    // Still held — a refused approval changes nothing.
    assert.equal(readGatewayRequest(asQS(), 'g-denied')?.status, 'AWAITING_APPROVAL');
    // And the proper authority can still release it.
    assert.equal(approveGatewayRequest(asOwner(), 'g-denied').status, 'COMPLETED');
  });

  it('rejecting a held output withholds the result and records the reason', () => {
    persistGatewayRequest(asQS(), { response: held('g-reject'), authority: AUTH });
    const out = rejectGatewayRequest(asOwner(), 'g-reject', { reason: 'Clause 14 reading is wrong; re-run against the addendum.' });
    assert.equal(out.status, 'REJECTED');
    assert.equal(out.result, undefined, 'a rejected output is not released');
    assert.equal(out.approval.required, false);
  });

  it('a decision on a request that is not awaiting approval is refused', () => {
    persistGatewayRequest(asQS(), { response: { ...held('g-done'), status: 'COMPLETED', approval: { required: false, roles: [] } }, authority: AUTH });
    throwsCode(() => approveGatewayRequest(asOwner(), 'g-done'), 'AI_GATEWAY_NOT_AWAITING_APPROVAL');
    throwsCode(() => rejectGatewayRequest(asOwner(), 'g-done', { reason: 'too late' }), 'AI_GATEWAY_NOT_AWAITING_APPROVAL');
  });

  it('a rejection needs a reason; an empty one is refused', () => {
    persistGatewayRequest(asQS(), { response: held('g-noreason'), authority: AUTH });
    throwsCode(() => rejectGatewayRequest(asOwner(), 'g-noreason', { reason: '  ' }), 'AI_GATEWAY_REJECT_REASON');
  });

  it('reading an unknown id returns nothing (and the endpoint turns that into a 404)', () => {
    assert.equal(readGatewayRequest(asQS(), 'no-such-request'), undefined);
    throwsCode(() => approveGatewayRequest(asOwner(), 'no-such-request'), 'AI_GATEWAY_REQUEST_NOT_FOUND');
  });

  it('lists a project\'s requests newest-first with the awaiting count, for the review panel', () => {
    persistGatewayRequest(asQS(), { response: held('g-list-1'), authority: AUTH });
    persistGatewayRequest(asQS(), { response: { ...held('g-list-2'), status: 'COMPLETED', approval: { required: false, roles: [] } }, authority: AUTH });

    const listed = listGatewayRequests(asQS());
    const ids = listed.requests.map((r) => r.requestId);
    assert.ok(ids.includes('g-list-1') && ids.includes('g-list-2'), 'both requests are listed');
    assert.ok(listed.awaiting >= 1, 'the held one is counted as awaiting');
    // The list carries no provider identity either.
    assert.equal(JSON.stringify(listed).includes('OPENAI'), false);
  });
});
