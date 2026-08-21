import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { ACUWallet } from '../src/billing/acu.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The cost quote.
 *
 * The commercial model states one rule about the interface: *no AI action runs
 * without showing its estimated ACU cost first*. A prepaid balance that moves
 * for reasons the customer could not see beforehand is a meter running, however
 * fair the arithmetic behind it, and that is a trust problem rather than a
 * billing one.
 *
 * Two things have to hold for the quote to be worth showing. It must agree with
 * the reservation that follows it — a quote and a charge computed separately
 * would eventually disagree, and the number the user remembers is the one they
 * were shown. And it must be honest about where it came from: measured from
 * this account's own settled executions where there are any, and plainly marked
 * as a floor where there are none.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

async function call(
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? {}),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

function wallet(balanceMinor = 100_000): ACUWallet {
  const w = new ACUWallet('tenant-quote');
  w.topUp(balanceMinor);
  return w;
}

describe('the quote agrees with the reservation it precedes', () => {
  it('names the same charge the hold will ring-fence', () => {
    const w = wallet();
    const quoted = w.quote(400);
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 400 });

    assert.equal(quoted.chargeMinor, hold.heldMinor);
  });

  it('writes nothing, holds nothing and moves no balance', () => {
    const w = wallet();
    const before = w.snapshot();

    w.quote(400);
    w.quote(4_000);
    w.quote(40_000);

    const after = w.snapshot();
    assert.equal(after.balanceMinor, before.balanceMinor);
    assert.equal(after.heldMinor, 0);
    assert.equal(after.availableMinor, before.availableMinor);
    assert.equal(w.entries().length, 1, 'the top-up, and nothing the quotes added');
  });

  it('refuses in advance exactly what the reservation would refuse', () => {
    const w = wallet(300);
    const quoted = w.quote(1_000);

    assert.ok(quoted.blockedReason, 'a quote nobody can afford has to say so');
    assert.match(quoted.blockedReason, /Insufficient ACU balance/);
    throwsCode(() => w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 1_000 }), 'ACU_EXHAUSTED');
  });

  it('sees a cap the balance alone would not reveal', () => {
    // Money in the account and still blocked: the budget ceiling is the answer,
    // and finding it out after the click is finding it out too late.
    const w = wallet(100_000);
    w.setCaps({ perModuleMinor: { PLANNING: 500 } });

    const quoted = w.quote(1_000, undefined, 'PLANNING');

    assert.ok(quoted.availableMinor > quoted.chargeMinor, 'the balance is not the constraint');
    assert.ok(quoted.blockedReason);
    assert.match(quoted.blockedReason, /cap/i);
  });

  it('says which of the two stopped it, as facts rather than as a sentence', () => {
    // A screen has to word this in the customer's currency. Handing it a string
    // written in minor units for a log leaves it parsing prose to do so.
    const broke = wallet(100);
    const balanceBlock = broke.quote(1_000);
    assert.equal(balanceBlock.blockedBy, 'BALANCE');
    assert.equal(balanceBlock.capBreach, undefined);

    const capped = wallet(100_000);
    capped.setCaps({ monthlyMinor: 400 });
    const capBlock = capped.quote(1_000);

    assert.equal(capBlock.blockedBy, 'CAP');
    assert.equal(capBlock.capBreach?.scope, 'MONTHLY');
    assert.equal(capBlock.capBreach?.capMinor, 400);
    assert.equal(capBlock.capBreach?.spentMinor, 0, 'nothing spent yet — the first call already exceeds it');

    // Both still carry the message, because the caller may not word it itself.
    assert.ok(balanceBlock.blockedReason && capBlock.blockedReason);
  });

  it('names the project or module a cap belongs to', () => {
    const w = wallet(100_000);
    w.setCaps({ perProjectMinor: { 'proj-1': 500 } });

    const breach = w.quote(1_000, 'proj-1').capBreach;
    assert.equal(breach?.scope, 'PROJECT');
    assert.equal(breach?.scopeId, 'proj-1');
  });

  it('leaves an unblocked quote with nothing to explain', () => {
    const quoted = wallet().quote(100);
    assert.equal(quoted.blockedBy, undefined);
    assert.equal(quoted.blockedReason, undefined);
    assert.equal(quoted.capBreach, undefined);
  });

  it('accounts for funds already held by a call in flight', () => {
    const w = wallet(2_400);
    w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 300 });

    // 900 held of 2,400 leaves 1,500. A second action at 500 raw costs exactly
    // that and is affordable; at 501 it is not, and the quote has to know
    // before it is offered rather than after the click.
    assert.equal(w.snapshot().availableMinor, 1_500);
    assert.equal(w.quote(500).blockedReason, undefined);
    assert.ok(w.quote(501).blockedReason);
  });
});

describe('what the account has actually paid', () => {
  it('reports settled raw costs for one action, ascending', () => {
    const w = wallet();
    for (const [i, raw] of [90, 30, 60].entries()) {
      const hold = w.reserve({
        aiRequestId: `req-${i}`,
        estimatedRawCostMinor: 200,
        module: 'PLANNING',
        feature: 'delay_risk_forecast',
      });
      w.settle(hold.holdId, raw, 'OPENAI');
    }

    assert.deepEqual(w.observedRawCosts('PLANNING', 'delay_risk_forecast'), [30, 60, 90]);
  });

  it('does not mix one action with another, nor debits with holds', () => {
    const w = wallet();
    const held = w.reserve({
      aiRequestId: 'req-open',
      estimatedRawCostMinor: 500,
      module: 'PLANNING',
      feature: 'delay_risk_forecast',
    });
    const other = w.reserve({
      aiRequestId: 'req-other',
      estimatedRawCostMinor: 200,
      module: 'PLANNING',
      feature: 'wbs_generation',
    });
    w.settle(other.holdId, 40, 'OPENAI');

    // The open hold has no settled cost yet, so it is not evidence of anything.
    assert.deepEqual(w.observedRawCosts('PLANNING', 'delay_risk_forecast'), []);
    assert.deepEqual(w.observedRawCosts('PLANNING', 'wbs_generation'), [40]);

    w.release(held.holdId, 'abandoned');
    assert.deepEqual(w.observedRawCosts('PLANNING', 'delay_risk_forecast'), [], 'a release is not a cost');
  });
});

describe('the estimate says where it came from', () => {
  const orchestrator = new AIOrchestrator();

  it('marks a first run as a floor, not a prediction', () => {
    const quote = orchestrator.quote({
      capability: 'REASONING',
      engine: 'PLANNING',
      taskType: 'delay_risk_forecast',
      wallet: wallet(),
    });

    assert.equal(quote.basis, 'FLOOR');
    assert.equal(quote.observations, 0);
    assert.equal(quote.highChargeMinor, undefined, 'nothing has been measured, so there is no upper figure');
    assert.equal(quote.lowChargeMinor, quote.estimatedChargeMinor);
    assert.ok(quote.estimatedChargeMinor > 0);
  });

  it('measures once the action has run here, and says how many times', () => {
    const w = wallet();
    for (const [i, raw] of [50, 200, 80].entries()) {
      const hold = w.reserve({
        aiRequestId: `req-${i}`,
        estimatedRawCostMinor: 300,
        module: 'PLANNING',
        feature: 'delay_risk_forecast',
      });
      w.settle(hold.holdId, raw, 'OPENAI');
    }

    const quote = orchestrator.quote({
      capability: 'REASONING',
      engine: 'PLANNING',
      taskType: 'delay_risk_forecast',
      wallet: w,
    });

    assert.equal(quote.basis, 'MEASURED');
    assert.equal(quote.observations, 3);
    // The median of 50, 80 and 200 — not the mean, which one expensive run
    // would drag away from anything typical.
    assert.equal(quote.estimatedRawCostMinor, 80);
    assert.equal(quote.estimatedChargeMinor, Math.ceil(80 * quote.multiplier));
    assert.equal(quote.lowChargeMinor, Math.ceil(50 * quote.multiplier));
    assert.equal(quote.highChargeMinor, Math.ceil(200 * quote.multiplier));
  });

  it('prices history at today’s multiplier rather than the one it was charged at', () => {
    // The volume incentive lowers the multiplier as monthly spend rises. A
    // charge settled at 3.0x says nothing about what the same work costs at
    // 2.5x, so the history is kept raw and repriced.
    const w = wallet(10_000_000);
    const hold = w.reserve({
      aiRequestId: 'req-1',
      // Above the first volume band, so enabling the incentive actually moves
      // the rate rather than landing back on the standard multiplier.
      estimatedRawCostMinor: 250_000,
      module: 'PLANNING',
      feature: 'delay_risk_forecast',
    });
    w.settle(hold.holdId, 250_000, 'OPENAI');

    const before = orchestrator.quote({
      capability: 'REASONING',
      engine: 'PLANNING',
      taskType: 'delay_risk_forecast',
      wallet: w,
    });

    w.setVolumeIncentive(true);
    const after = orchestrator.quote({
      capability: 'REASONING',
      engine: 'PLANNING',
      taskType: 'delay_risk_forecast',
      wallet: w,
    });

    assert.equal(before.estimatedRawCostMinor, after.estimatedRawCostMinor, 'the same measurement');
    assert.ok(after.multiplier < before.multiplier, 'at a better rate');
    assert.ok(after.estimatedChargeMinor < before.estimatedChargeMinor);
  });

  it('shows what the balance would be afterwards, and refuses to show a negative one', () => {
    const w = wallet(300);
    const quote = orchestrator.quote({
      capability: 'REASONING',
      engine: 'PLANNING',
      taskType: 'delay_risk_forecast',
      wallet: w,
    });

    assert.equal(quote.affordable, quote.blockedReason === undefined);
    assert.ok(quote.balanceAfterMinor >= 0);
  });

  it('charges perception more than reasoning for the same absence of history', () => {
    // Images and models are large inputs and the floor reflects it. A single
    // floor for both would understate every perception action.
    const perception = orchestrator.quote({
      capability: 'PERCEPTION',
      engine: 'BIM_TWIN',
      taskType: 'model_ingestion',
      wallet: wallet(),
    });
    const reasoning = orchestrator.quote({
      capability: 'REASONING',
      engine: 'BIM_TWIN',
      taskType: 'clash_triage',
      wallet: wallet(),
    });

    assert.ok(perception.estimatedChargeMinor > reasoning.estimatedChargeMinor);
  });
});

describe('every AI route can be quoted, and only those', () => {
  it('declares an engine and task on each route that reaches a provider', () => {
    // The declaration is what makes the action quotable. A new AI route added
    // without one is an action that would spend money with no price shown, so
    // the pairing is pinned here rather than left to whoever adds the next one.
    const declared = ROUTES.filter((r) => r.ai);
    assert.ok(declared.length >= 22, `expected every AI route declared, found ${declared.length}`);

    for (const route of declared) {
      assert.equal(route.method, 'POST');
      assert.ok(route.pattern.includes(':projectId'), `${route.pattern} must be project-scoped to be quoted`);
      assert.match(route.ai!.taskType, /^[a-z_]+$/);
    }
  });

  it('pairs each declared task with exactly one route', () => {
    const seen = new Set<string>();
    for (const route of ROUTES.filter((r) => r.ai)) {
      const key = `${route.ai!.engine}:${route.ai!.taskType}`;
      assert.ok(!seen.has(key), `${key} is declared on two routes — a quote could not tell them apart`);
      seen.add(key);
    }
  });

  it('quotes a real action over HTTP without spending anything', async () => {
    const walletBefore = platform.wallet(seed.tenantId).snapshot();

    const reply = await call('/v1/ai/quote', {
      token: tokenFor('pm'),
      body: { method: 'POST', path: `/v1/projects/${seed.projectId}/programme/delay-forecast` },
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.body.engine, 'PLANNING');
    assert.equal(reply.body.taskType, 'delay_risk_forecast');
    assert.ok(reply.body.estimatedChargeMinor > 0);
    assert.ok(['MEASURED', 'FLOOR'].includes(reply.body.basis));

    const walletAfter = platform.wallet(seed.tenantId).snapshot();
    assert.equal(walletAfter.balanceMinor, walletBefore.balanceMinor);
    assert.equal(walletAfter.heldMinor, walletBefore.heldMinor);
  });

  it('quotes the seeded actions as measured, because the demo has already run them', async () => {
    // The seed runs a delay forecast, so by the time anyone opens the console
    // the estimate for that action is drawn from what it actually cost.
    const reply = await call('/v1/ai/quote', {
      token: tokenFor('pm'),
      body: { method: 'POST', path: `/v1/projects/${seed.projectId}/programme/delay-forecast` },
    });

    assert.equal(reply.body.basis, 'MEASURED');
    assert.ok(reply.body.observations >= 1);
    assert.ok(reply.body.lowChargeMinor <= reply.body.estimatedChargeMinor);
  });

  it('says plainly that a non-AI action has no AI cost, rather than quoting zero', async () => {
    const reply = await call('/v1/ai/quote', {
      token: tokenFor('pm'),
      body: { method: 'POST', path: `/v1/projects/${seed.projectId}/cost/actuals` },
    });

    assert.equal(reply.status, 400);
    assert.equal(reply.body.title, 'NOT_AN_AI_ACTION');
    assert.match(reply.body.detail, /does not call an AI provider/);
  });

  it('does not invent a quote for a path that does not exist', async () => {
    const reply = await call('/v1/ai/quote', {
      token: tokenFor('pm'),
      body: { method: 'POST', path: `/v1/projects/${seed.projectId}/programme/telepathy` },
    });

    assert.equal(reply.status, 404);
  });

  it('refuses the price to an actor who would be refused the action', async () => {
    // A regulator has no AI mandate unless the asset owner grants one. Quoting
    // for them would disclose a capability they cannot use.
    const reply = await call('/v1/ai/quote', {
      token: tokenFor('regulator'),
      body: { method: 'POST', path: `/v1/projects/${seed.projectId}/programme/delay-forecast` },
    });

    assert.equal(reply.status, 403);
  });

  it('will not quote across a tenant boundary', async () => {
    const reply = await call('/v1/ai/quote', {
      token: tokenFor('pm'),
      body: { method: 'POST', path: '/v1/projects/some-other-tenants-project/programme/delay-forecast' },
    });

    assert.ok(reply.status === 403 || reply.status === 404, `got ${reply.status}`);
  });
});
