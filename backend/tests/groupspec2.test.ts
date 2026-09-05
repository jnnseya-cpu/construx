import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { ACUWallet } from '../src/billing/acu.ts';
import { resetWebhookHealth, type StripeEvent } from '../src/billing/stripe.ts';
import { config } from '../src/config.ts';
import { DomainError } from '../src/core/errors.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { watchPosition } from '../src/ops/watch.ts';
import { Platform, type PlatformUser } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * Enterprise / Group v1.0 §10.2 and §17, where they had been recorded rather
 * than built.
 *
 * AT-25: a refund or chargeback creates an explicit reversing entry; consumed
 * disputed funding becomes a finance exception, never a negative balance or a
 * sibling charge. AT-22: a provider call with unknown completion is held for
 * reconciliation; a stale outcome cannot charge after the operator releases.
 * §17: the figures the specification names are read from the record.
 */

const SECRET = 'whsec_groupspec2_suite_only';
type MutableStripeConfig = { secretKey: string; webhookSecret: string };
const stripeConfig = config.stripe as unknown as MutableStripeConfig;

let platform: Platform;
let server: Server;
let base: string;
let operator: PlatformUser;
let tenantId: string;
let admin: PlatformUser;

function tokenFor(user: PlatformUser): string {
  const auth = authOf(platform, user.id);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function call(method: string, path: string, token: string, payload?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

function sign(body: string): string {
  const at = Math.floor(Date.now() / 1000);
  return `t=${at},v1=${createHmac('sha256', SECRET).update(`${at}.${body}`).digest('hex')}`;
}

async function webhook(event: StripeEvent) {
  const body = JSON.stringify(event);
  const res = await fetch(`${base}/v1/webhooks/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) }, body });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const refundEvent = (id: string, paymentIntent: string, amountRefunded: number): StripeEvent => ({
  id,
  type: 'charge.refunded',
  livemode: true,
  data: { object: { id: `ch_${id}`, object: 'charge', payment_intent: paymentIntent, amount: 20_000, amount_refunded: amountRefunded, currency: 'gbp' } },
});
const disputeEvent = (id: string, paymentIntent: string, amount: number): StripeEvent => ({
  id,
  type: 'charge.dispute.created',
  livemode: true,
  data: { object: { id: `dp_${id}`, object: 'dispute', payment_intent: paymentIntent, amount, currency: 'gbp', status: 'needs_response' } },
});

const wallet = () => platform.wallet(tenantId);

before(async () => {
  stripeConfig.secretKey = 'sk_test_groupspec2';
  stripeConfig.webhookSecret = SECRET;
  platform = new Platform();
  operator = platform.createOperator({ name: 'Ruth Okafor', email: 'ops@construx.example' });
  const created = platform.createTenant({ legalName: 'Disputed Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Disputed', trialGrant: false });
  tenantId = created.tenant.id;
  admin = platform.createUser({ tenantId, name: 'Kemi Adeyemi', email: 'kemi@disputed.example', roles: ['ENTERPRISE_ADMIN'] });
  platform.recordSubscriptionPayment({ tenantId, chargeId: created.openingCharge!.id, method: 'BANK_TRANSFER', reference: 'BACS-DISPUTED-SUB', recordedBy: operator.id });
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  resetIdempotency();
  resetWebhookHealth();
});

after(() => server.close());

describe('AT-25 — a refund is an explicit reversing entry, and consumed funding is an exception', () => {
  it('debits what is still available, once, however many times Stripe says so', async () => {
    // £200 paid in by card, £50 of it already spent on AI.
    platform.creditFromPayment({ tenantId, amountMinor: 20_000, method: 'CARD', reference: 'pi_refund_1', recordedBy: 'stripe', source: 'PROVIDER' });
    const before = wallet().snapshot().availableMinor;
    const hold = wallet().reserve({ aiRequestId: 'spend', estimatedRawCostMinor: 1_000 });
    wallet().settle(hold.holdId, 1_000, 'OPENAI'); // 5,000 billed
    const afterSpend = wallet().snapshot().availableMinor;
    assert.equal(afterSpend, before - 5_000);

    // Stripe refunds £60 of the £200: all of it is still available, so all of it goes back.
    const first = await webhook(refundEvent('evt_refund_1', 'pi_refund_1', 6_000));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.acted, true);
    assert.equal(first.body.kind, 'REFUND');
    assert.equal(first.body.reversedMinor, 6_000);
    assert.equal(first.body.shortfallMinor, 0);
    assert.equal(first.body.exceptionId, null);
    assert.equal(wallet().snapshot().availableMinor, afterSpend - 6_000);
    const reversals = platform.ledger.events().filter((event) => event.tenantId === tenantId && event.eventType === 'PAYMENT_REVERSED');
    assert.equal(reversals.length, 1);
    // The receipt is untouched: history is not rewritten.
    assert.equal(platform.paymentReceipts(tenantId).find((receipt) => receipt.reference === 'pi_refund_1')?.amountMinor, 20_000);

    const again = await webhook(refundEvent('evt_refund_1', 'pi_refund_1', 6_000));
    assert.equal(again.body.alreadyRecorded, true);
    assert.equal(wallet().snapshot().availableMinor, afterSpend - 6_000, 'a redelivered refund debited twice');
  });

  it('raises a finance exception for what was already consumed, and never goes negative', async () => {
    // Most of the wallet is spent on AI, then Stripe reports the whole £200
    // refunded (a running total: £60 already reversed, £140 new). Only what is
    // still available goes back; the rest is consumed funding — an exception.
    const available = wallet().snapshot().availableMinor;
    const drain = wallet().reserve({ aiRequestId: 'drain', estimatedRawCostMinor: Math.floor((available - 3_000) / 5) });
    wallet().settle(drain.holdId, Math.floor((available - 3_000) / 5), 'OPENAI');
    const left = wallet().snapshot().availableMinor;
    assert.ok(left > 0 && left <= 3_000, `expected a little left, got ${left}`);
    const big = await webhook(refundEvent('evt_refund_2', 'pi_refund_1', 20_000));
    assert.equal(big.status, 201, JSON.stringify(big.body));
    assert.equal(big.body.reversedMinor, left);
    assert.equal(big.body.shortfallMinor, 14_000 - left, 'the new part of the running total, less what the wallet could give back');
    assert.ok(big.body.exceptionId, 'consumed funding that went back must become an exception');
    assert.equal(wallet().snapshot().availableMinor, 0);
    assert.ok(wallet().snapshot().balanceMinor >= 0, 'the balance went negative');
    // The same running total again, under a new event: nothing further to reverse.
    const same = await webhook(refundEvent('evt_refund_3', 'pi_refund_1', 20_000));
    assert.equal(same.body.alreadyRecorded, true);

    const listed = await call('GET', '/v1/admin/payments/exceptions', tokenFor(operator));
    assert.equal(listed.status, 200);
    const exception = listed.body.exceptions.find((e: { id: string }) => e.id === big.body.exceptionId);
    assert.equal(exception.status, 'OPEN');
    assert.equal(exception.shortfallMinor, big.body.shortfallMinor);
    assert.equal(exception.legalName, 'Disputed Ltd');
  });

  it('acknowledges a refund of a payment it never recorded, and does nothing', async () => {
    const stranger = await webhook(refundEvent('evt_refund_x', 'pi_never_here', 1_000));
    assert.equal(stranger.status, 201);
    assert.equal(stranger.body.acted, false);
    assert.equal(stranger.body.reason, 'PAYMENT_UNKNOWN');
  });

  it('refuses more than was paid, and lets the operator record a reversal by hand', async () => {
    const token = tokenFor(operator);
    platform.creditFromPayment({ tenantId, amountMinor: 5_000, method: 'BANK_TRANSFER', reference: 'BACS-MANUAL-1', recordedBy: operator.id });
    const tooMuch = await call('POST', `/v1/admin/tenants/${tenantId}/payments/reverse`, token, { reference: 'BACS-MANUAL-1', amountMinor: 6_000, kind: 'REFUND', eventId: 'BANK-RET-1' });
    assert.equal(tooMuch.status, 422);
    assert.equal(tooMuch.body.title, 'PAYMENT_REVERSAL_EXCEEDS');
    const recorded = await call('POST', `/v1/admin/tenants/${tenantId}/payments/reverse`, token, { reference: 'BACS-MANUAL-1', amountMinor: 5_000, kind: 'REFUND', eventId: 'BANK-RET-1', note: 'Returned by the bank' });
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    assert.equal(recorded.body.reversal.reversedMinor, 5_000);
    assert.equal(recorded.body.reversal.source, 'OPERATOR');
  });
});

describe('AT-25 — a dispute freezes the wallet; nothing but AI is affected; the operator lifts it', () => {
  it('freezes on the dispute and refuses AI while frozen', async () => {
    platform.creditFromPayment({ tenantId, amountMinor: 10_000, method: 'CARD', reference: 'pi_dispute_1', recordedBy: 'stripe', source: 'PROVIDER' });
    const disputed = await webhook(disputeEvent('evt_dispute_1', 'pi_dispute_1', 10_000));
    assert.equal(disputed.status, 201, JSON.stringify(disputed.body));
    assert.equal(disputed.body.kind, 'DISPUTE');
    assert.equal(disputed.body.frozen, true);
    assert.ok(wallet().frozen(), 'the wallet was not frozen');
    assert.equal(platform.ledger.events().filter((event) => event.tenantId === tenantId && event.eventType === 'ACU_WALLET_FROZEN').length, 1);

    assert.throws(() => wallet().reserve({ aiRequestId: 'frozen', estimatedRawCostMinor: 10 }), (error: { code?: string }) => error.code === 'WALLET_FROZEN');

    // Everything but AI continues: a write on the record.
    const enterprise = platform.ledger.listByTenant(tenantId, 'Enterprise')[0]!;
    const created = await call('POST', '/v1/portfolios', tokenFor(admin), { name: 'Still working', enterpriseId: enterprise.refId, governanceModel: 'CENTRALISED', continentCode: 'EU', countryCode: 'GB' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  });

  it('stays frozen across a restart, until the operator lifts it with a reason', async () => {
    const restarted = new Platform();
    restarted.ledger.restore(platform.ledger.events());
    restarted.rehydrate();
    assert.ok(restarted.wallet(tenantId).frozen(), 'a restart forgot the dispute');

    const token = tokenFor(operator);
    const noReason = await call('POST', `/v1/admin/tenants/${tenantId}/wallet/unfreeze`, token, { reason: 'ok' });
    assert.equal(noReason.status, 400);
    const lifted = await call('POST', `/v1/admin/tenants/${tenantId}/wallet/unfreeze`, token, { reason: 'Dispute withdrawn by the cardholder on 5 September' });
    assert.equal(lifted.status, 201, JSON.stringify(lifted.body));
    assert.equal(lifted.body.frozen, null);
    assert.equal(wallet().frozen(), null);
    const twice = await call('POST', `/v1/admin/tenants/${tenantId}/wallet/unfreeze`, token, { reason: 'Dispute withdrawn by the cardholder on 5 September' });
    assert.equal(twice.status, 409);

    // The credit the dispute concerned is what the reversal took: recorded, not invented.
    const listed = await call('GET', '/v1/admin/payments/exceptions', token);
    assert.equal(listed.body.frozenWallets.length, 0);
    const open = listed.body.exceptions.filter((e: { status: string }) => e.status === 'OPEN');
    assert.ok(open.length >= 1);
    const resolved = await call('POST', `/v1/admin/payments/exceptions/${open[0].id}/resolve`, token, { note: 'Recovered from the customer by invoice CX-INV-77' });
    assert.equal(resolved.status, 201, JSON.stringify(resolved.body));
    assert.equal(resolved.body.status, 'RESOLVED');
  });
});

function timingOutProvider(): AIProviderAdapter & { calls: number } {
  const provider = {
    name: 'OPENAI' as const,
    capability: 'REASONING' as const,
    multimodal: false,
    transmits: true,
    calls: 0,
    healthy: () => true,
    estimateCostMinor: () => 100,
    async execute(_request: ProviderRequest): Promise<ProviderResponse> {
      provider.calls += 1;
      throw new DomainError('AI_PROVIDER_TIMEOUT', 'OPENAI did not answer within the deadline; the call may have completed', 504);
    },
  };
  return provider;
}

describe('AT-22 — a provider call with unknown completion is held for reconciliation', () => {
  let orchestrator: AIOrchestrator;
  let aiWallet: ACUWallet;
  let executionId: string;

  before(async () => {
    orchestrator = new AIOrchestrator({ reasoning: timingOutProvider(), perception: timingOutProvider() });
    aiWallet = new ACUWallet('tenant-x');
    aiWallet.topUp(10_000, 'test funding');
    await assert.rejects(
      orchestrator.execute(
        { tenantId: 'tenant-x', projectId: 'project-x', engine: 'PLANNING', taskType: 'forecast', inputRefs: [], userId: 'user-x', aiPermitted: true, capability: 'REASONING', request: { task: 'forecast-delay', payload: {}, modelClass: 'default' } },
        aiWallet,
      ),
      (error: { code?: string }) => error.code === 'AI_PROVIDER_TIMEOUT',
    );
    executionId = orchestrator.unresolved()[0]!.id;
  });

  it('keeps the hold reserved rather than releasing or charging it', () => {
    const unresolved = orchestrator.unresolved();
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0]!.status, 'UNRESOLVED');
    assert.equal(aiWallet.snapshot().heldMinor, 500, 'the estimate at 5× stays held');
    assert.equal(aiWallet.snapshot().availableMinor, 9_500);
    assert.equal(aiWallet.snapshot().unresolvedHolds, 1);
    assert.equal(aiWallet.unresolvedHolds()[0]!.reason.includes('may have completed'), true);
  });

  it('charges what the provider’s account shows, once, and a stale outcome cannot charge again', () => {
    assert.throws(() => orchestrator.reconcile(executionId, { kind: 'CHARGE', actualRawCostMinor: 80 }, { note: '', by: 'ops' }), (error: { code?: string }) => error.code === 'EVIDENCE_REQUIRED');
    const charged = orchestrator.reconcile(executionId, { kind: 'CHARGE', actualRawCostMinor: 80 }, { note: 'Provider dashboard shows the completion at 12:01', by: 'ops' });
    assert.equal(charged.status, 'SUCCEEDED');
    assert.equal(charged.acuConsumed, 400, '80 raw at 5×');
    assert.equal(aiWallet.snapshot().heldMinor, 0);
    assert.equal(aiWallet.snapshot().availableMinor, 9_600);
    assert.equal(orchestrator.unresolved().length, 0);
    // The stale worker: settling or reconciling again does nothing.
    assert.throws(() => orchestrator.reconcile(executionId, { kind: 'RELEASE' }, { note: 'again', by: 'ops' }), (error: { code?: string }) => error.code === 'AI_EXECUTION_NOT_UNRESOLVED');
    // A stale worker settling the same hold again: the wallet answers the same
    // settlement and moves nothing — commit once, replay-safe.
    const replay = aiWallet.settle(charged.unresolved!.holdId, 80, 'OPENAI');
    assert.equal(replay.billedMinor, 400);
    assert.equal(aiWallet.snapshot().availableMinor, 9_600, 'a replayed settlement charged again');
  });

  it('releases when the provider shows nothing, and the operator’s doors answer', async () => {
    const funded = platform.wallet(tenantId);
    platform.creditFromPayment({ tenantId, amountMinor: 20_000, method: 'BANK_TRANSFER', reference: 'BACS-AI-FUND', recordedBy: operator.id });
    const before = funded.snapshot().availableMinor;
    // The same wallet path the timeout takes, parked by hand: the orchestrator
    // above proved the parking; this proves the release gives everything back.
    const hold = funded.reserve({ aiRequestId: 'manual-park', estimatedRawCostMinor: 100 });
    funded.parkHold(hold.holdId, 'Provider did not answer');
    assert.equal(funded.snapshot().availableMinor, before - 500);
    funded.reconcileHold(hold.holdId, { kind: 'RELEASE', note: 'Nothing on the provider account' });
    assert.equal(funded.snapshot().availableMinor, before, 'a released unknown outcome gives the reservation back in full');
    assert.throws(() => funded.reconcileHold(hold.holdId, { kind: 'RELEASE', note: 'again' }), (error: { code?: string }) => error.code === 'ACU_HOLD_NOT_UNRESOLVED');

    const list = await call('GET', '/v1/admin/ai/unreconciled', tokenFor(operator));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.executions, []);
    const unknown = await call('POST', '/v1/admin/ai/executions/nope/reconcile', tokenFor(operator), { outcome: 'RELEASE', note: 'Nothing on the account' });
    assert.equal(unknown.status, 404);
    const forbidden = await call('GET', '/v1/admin/ai/unreconciled', tokenFor(admin));
    assert.equal(forbidden.status, 403);
  });
});

describe('§17 — the operational figures are read from the record', () => {
  it('counts frozen wallets, open exceptions, holds and denials without modelling any of them', async () => {
    const position = watchPosition(platform);
    assert.ok(position.operational, 'no operational figures');
    assert.equal(typeof position.operational.openPaymentExceptions, 'number');
    assert.equal(position.operational.frozenWallets, 0, 'the wallet was unfrozen above');
    assert.equal(position.operational.webhookSignatureFailures, 0);
    assert.equal(position.operational.ledgerDiscrepancies, 0);
    assert.ok(Array.isArray(position.operational.authorisationDenialsByReason));

    // A forbidden read is counted by its reason.
    const refused = await call('GET', '/v1/admin/payments/exceptions', tokenFor(admin));
    assert.equal(refused.status, 403);
    const after = watchPosition(platform);
    assert.ok(after.operational.authorisationDenialsByReason.some((entry) => entry.count >= 1), 'the denial was not counted');

    const viewed = await call('GET', '/v1/admin/watch', tokenFor(operator));
    assert.equal(viewed.status, 200);
    assert.equal(viewed.body.operational.frozenWallets, 0);
  });
});
