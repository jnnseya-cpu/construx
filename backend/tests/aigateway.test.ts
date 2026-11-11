import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
