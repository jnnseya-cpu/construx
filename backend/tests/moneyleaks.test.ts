import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import { assertBillablePeriod, assertCreditableAmount, normaliseReference } from '../src/billing/payments.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import * as collection from '../src/billing/collection.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Ways to take money out of this platform without paying for it.
 *
 * Each of these was reachable. They are grouped by what the attacker needed:
 * the first three needed nothing beyond an ordinary account, and the fourth
 * needed only a request whose answer was longer than its question.
 *
 *   1. `POST /v1/billing/top-up` credited the wallet with the amount in the
 *      request body. No payment provider, no ceiling. One call was unlimited
 *      AI, and every ACU spent from it bought real provider compute.
 *
 *   2. `POST /v1/billing/invoice` was tenant-callable with a client-supplied
 *      period, and issuing an invoice credits that period's AI allowance. A
 *      loop over periods minted allowance in bulk.
 *
 *   3. The idempotency cache was keyed on the client-supplied header alone —
 *      no tenant, no actor, no route — so a caller replaying somebody else's
 *      key received their cached response. Not a financial leak but a
 *      cross-tenant one, and it sat on the same code path.
 *
 *   4. `settle` capped the charge at the hold, and the hold is sized from an
 *      estimate assuming output is a quarter of input. A request whose answer
 *      is much larger than its question cost more than it was charged.
 *
 * The tests below are the receipts. They assert the closed behaviour, and each
 * one names the loss it prevents so that nobody relaxes it by accident.
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
  method: string,
  path: string,
  options: { who?: string; body?: unknown; key?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.who) headers.authorization = `Bearer ${tokenFor(options.who)}`;
  if (options.key) headers['idempotency-key'] = options.key;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

const balance = () => platform.wallet(seed.users.pm!.auth.tenantId).snapshot().balanceMinor;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetIdempotency();
});

after(() => server.close());

// ------------------------------------------------------- 1. minting credit

describe('a customer cannot credit their own wallet', () => {
  it('records a request and moves no money', async () => {
    const before = balance();
    const reply = await call('POST', '/v1/billing/top-up', { who: 'admin', body: { amountMinor: 100_000 } });

    assert.ok([200, 201].includes(reply.status), `top-up answered ${reply.status}`);
    assert.equal(reply.body.status, 'AWAITING_PAYMENT');
    assert.equal(balance(), before, 'a top-up request credited the wallet');
    assert.match(reply.body.message, /unchanged/i, 'the customer must be told the balance has not moved');
  });

  it('refuses a credit from anybody but the operator', async () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = balance();

    for (const who of ['admin', 'pm', 'qs']) {
      const reply = await call('POST', `/v1/admin/tenants/${tenantId}/credit`, {
        who,
        body: { amountMinor: 100_000, method: 'CARD', reference: `SELF-${who}` },
      });
      assert.equal(reply.status, 403, `${who} credited a wallet`);
    }
    assert.equal(balance(), before);
  });

  it('credits once when the operator records the payment', async () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = balance();

    const reply = await call('POST', `/v1/admin/tenants/${tenantId}/credit`, {
      who: 'operator',
      body: { amountMinor: 100_000, method: 'BANK_TRANSFER', reference: 'BACS-0001' },
    });

    assert.ok([200, 201].includes(reply.status));
    assert.equal(reply.body.alreadyRecorded, false);
    assert.equal(balance(), before + 100_000);
  });

  it('spends a payment reference exactly once, however many times it arrives', async () => {
    // The idempotency key for money. A webhook that fires twice, an operator
    // pressing the button again, a retry after a timeout: all the same payment.
    const tenantId = seed.users.pm!.auth.tenantId;
    const afterFirst = balance();

    for (let i = 0; i < 3; i++) {
      const reply = await call('POST', `/v1/admin/tenants/${tenantId}/credit`, {
        who: 'operator',
        body: { amountMinor: 100_000, method: 'BANK_TRANSFER', reference: 'BACS-0001' },
      });
      // Success, not an error: a provider told its payment failed keeps retrying.
      assert.ok([200, 201].includes(reply.status), 'a replay must not read as a failure');
      assert.equal(reply.body.alreadyRecorded, true);
    }

    assert.equal(balance(), afterFirst, 'a replayed payment reference credited again');
  });

  it('refuses to reuse a reference for a different amount or tenancy', () => {
    // Otherwise the uniqueness rule is decorative: reuse the reference, change
    // the number, and the guard reports "already recorded" while the money
    // differs from what the bank actually sent.
    throwsCode(
      () =>
        platform.creditFromPayment({
          tenantId: seed.users.pm!.auth.tenantId,
          amountMinor: 999_999,
          method: 'CARD',
          reference: 'BACS-0001',
          recordedBy: seed.users.operator!.id,
        }),
      'PAYMENT_REFERENCE_CONFLICT',
    );
  });

  it('bounds every amount, so a typo cannot become a balance', () => {
    assertCreditableAmount(1);
    throwsCode(() => assertCreditableAmount(0), 'PAYMENT_INVALID_AMOUNT');
    throwsCode(() => assertCreditableAmount(-100), 'PAYMENT_INVALID_AMOUNT');
    throwsCode(() => assertCreditableAmount(10.5), 'PAYMENT_INVALID_AMOUNT');
    throwsCode(() => assertCreditableAmount(Number.MAX_SAFE_INTEGER), 'PAYMENT_AMOUNT_TOO_LARGE');
    // An append-only ledger has no way to take a wrong number back out.
    throwsCode(() => assertCreditableAmount(Number.POSITIVE_INFINITY), 'PAYMENT_INVALID_AMOUNT');
  });

  it('requires a reference that can be reconciled against a statement', () => {
    assert.equal(normaliseReference('  BACS-77  '), 'BACS-77');
    throwsCode(() => normaliseReference('   '), 'PAYMENT_REFERENCE_REQUIRED');
    throwsCode(() => normaliseReference('ab'), 'PAYMENT_REFERENCE_REQUIRED');
    throwsCode(() => normaliseReference('x'.repeat(201)), 'PAYMENT_REFERENCE_TOO_LONG');
  });
});

// ------------------------------------------------- 2. minting the allowance

describe('a customer cannot mint their own AI allowance', () => {
  it('refuses to issue an invoice at all', async () => {
    const reply = await call('POST', '/v1/billing/invoice', {
      who: 'admin',
      body: { tenantId: seed.users.pm!.auth.tenantId, period: '2026-01' },
    });
    assert.equal(reply.status, 403, 'a tenant issued their own invoice');
    assert.match(String(reply.body.detail), /operator/i);
  });

  it('lets them read the position without crediting anything', async () => {
    const before = balance();
    const reply = await call('GET', '/v1/billing/invoice', { who: 'admin' });

    assert.equal(reply.status, 200);
    assert.ok(reply.body.lines.length > 0);
    assert.equal(balance(), before, 'reading a statement credited an allowance');
  });

  it('refuses a period that has not happened', () => {
    const nextYear = String(new Date().getUTCFullYear() + 1);
    throwsCode(
      () => platform.issueInvoice(seed.users.pm!.auth.tenantId, `${nextYear}-06`),
      'INVOICE_PERIOD_FUTURE',
    );
  });

  it('refuses a period that predates the subscription', () => {
    throwsCode(() => platform.issueInvoice(seed.users.pm!.auth.tenantId, '2019-01'), 'INVOICE_PERIOD_BEFORE_SUBSCRIPTION');
  });

  it('refuses a period that is not a period', () => {
    for (const period of ['2026-13', '2026-00', 'nonsense', '2026']) {
      throwsCode(
        () => assertBillablePeriod(period, '2020-01-01T00:00:00.000Z'),
        'INVOICE_PERIOD_INVALID',
        `${period} was accepted as a billing period`,
      );
    }
  });

  it('cannot be looped over periods to accumulate credit', () => {
    // The exploit, run: a decade of months, one at a time.
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = balance();
    let refused = 0;

    for (let year = 2020; year <= 2030; year++) {
      for (let month = 1; month <= 12; month++) {
        try {
          platform.issueInvoice(tenantId, `${year}-${String(month).padStart(2, '0')}`);
        } catch {
          refused += 1;
        }
      }
    }

    assert.ok(refused > 100, 'the period guard let most of a decade through');
    assert.equal(balance(), before, 'looping periods minted allowance');
  });
});

// ------------------------------------------- 3. reading another tenant's reply

describe('an idempotency key cannot be used to read somebody else', () => {
  it('does not serve one actor the cached response of another', async () => {
    // The cache was keyed on the client-supplied header alone. Whoever sent
    // `Idempotency-Key: abc` next received whatever the previous `abc` returned,
    // before any handler ran and therefore before any authorisation.
    const first = await call('GET', '/v1/billing/wallet', { who: 'admin', key: 'shared-key' });
    assert.equal(first.status, 200);

    const second = await call('GET', '/v1/projects', { who: 'qs', key: 'shared-key' });
    assert.equal(second.status, 200);
    assert.equal(second.body.balanceMinor, undefined, 'a wallet was served to a request for projects');
    assert.ok(Array.isArray(second.body.projects), 'the second caller did not get their own answer');
  });

  it('still replays a genuine retry by the same actor on the same route', async () => {
    // The feature has to keep working: a retried command must not perform the
    // state change twice.
    const key = `retry-${Date.now()}`;
    const first = await call('POST', '/v1/billing/top-up', {
      who: 'admin',
      body: { amountMinor: 5_000 },
      key,
    });
    const second = await call('POST', '/v1/billing/top-up', {
      who: 'admin',
      body: { amountMinor: 5_000 },
      key,
    });

    assert.equal(second.status, first.status);
    assert.equal(second.body.id, first.body.id, 'a retry created a second request rather than replaying the first');
  });

  it('does not cache a failure, so a corrected retry is not stuck with it', async () => {
    const key = `fix-${Date.now()}`;
    const bad = await call('POST', '/v1/billing/top-up', { who: 'admin', body: { amountMinor: 0 }, key });
    assert.ok(bad.status >= 400);

    const good = await call('POST', '/v1/billing/top-up', { who: 'admin', body: { amountMinor: 5_000 }, key });
    assert.ok([200, 201].includes(good.status), 'a corrected retry was served the cached error');
  });
});

// ------------------------------------------------------- 4. selling at a loss

describe('no execution is ever sold below cost', () => {
  it('charges the profit floor when an execution overruns its estimate', () => {
    // Held from an estimate of 100 raw; the call actually cost 500. Capping at
    // the hold charged 400 for something that cost 500 — a loss on every call
    // whose answer was much larger than its question, which is a shape anybody
    // can produce on purpose.
    const wallet = platform.wallet(seed.users.pm!.auth.tenantId);
    const hold = wallet.reserve({ aiRequestId: 'overrun-probe', estimatedRawCostMinor: 100 });
    const entry = wallet.settle(hold.holdId, 500, 'OPENAI');

    assert.ok(entry.billedMinor >= entry.rawCostMinor, 'the platform paid more than it charged');
    assert.ok(entry.billedMinor > hold.heldMinor, 'the cap was honoured at the platform\'s expense');
  });

  it('reports a lifetime margin at or above the required profit', () => {
    // The rolled-up version of the same invariant, over everything this wallet
    // has ever settled — including the overrun above.
    const snapshot = platform.wallet(seed.users.pm!.auth.tenantId).snapshot();
    assert.ok(snapshot.lifetimeRawCostMinor > 0, 'nothing was spent, so this proves nothing');
    assert.ok(
      snapshot.lifetimeProfitMinor >= 0,
      `lifetime profit is ${snapshot.lifetimeProfitMinor}: the account has cost more than it made`,
    );
  });
});

// --------------------------------------------------- 5. holding free storage

describe('storage that is held is charged for', () => {
  it('puts held blocks on the invoice', () => {
    // Blocks could be bought and never appeared on any invoice: real disk,
    // recurring for as long as the customer kept the data, against no revenue.
    const tenantId = seed.users.pm!.auth.tenantId;
    const period = new Date().toISOString().slice(0, 7);
    const statement = platform.previewInvoice(tenantId, period);

    assert.equal(typeof statement.storageMinor, 'number', 'the invoice has no storage figure at all');
    assert.equal(
      statement.totalMinor,
      statement.subscriptionMinor + statement.storageMinor,
      'the payable total does not account for storage',
    );
  });
});

// ------------------------------------------------ 6. being billed for AI twice

describe('prepaid AI is not billed a second time', () => {
  it('leaves AI usage off the payable total', async () => {
    // The wallet is prepaid — credit is bought before it is spent and an
    // execution draws it down. Adding consumption to the invoice total charged
    // for it again: once to buy the credit, once for having used it.
    const statement = platform.previewInvoice(
      seed.users.pm!.auth.tenantId,
      new Date().toISOString().slice(0, 7),
    );

    assert.ok(statement.aiUsageMinor > 0, 'no AI was consumed, so this proves nothing');
    assert.equal(statement.totalMinor, statement.subscriptionMinor + statement.storageMinor);
    assert.equal(statement.aiUsageDrawnFromCredit, true);
    assert.ok(
      statement.commercialTerms.some((term) => /already been paid for/i.test(term)),
      'the invoice must explain why the lines exceed the total',
    );
  });
});

// ------------------------------------------------------ what still has to work

describe('the money paths that must keep working', () => {
  it('still refuses AI when the balance genuinely runs out', async () => {
    const { tenant } = platform.createTenant({
      legalName: 'Skint Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      package: 'CORE_PROJECT',
      enterpriseName: 'Skint',
    });
    // Nothing is free unless the package is: a paid tenancy's wallet is empty
    // until its first month is paid, and the allowance arrives with the payment.
    const opening = collection.chargesFor(platform, tenant.id)[0];
    assert.ok(opening, 'a paid tenancy was not charged its first month');
    platform.recordSubscriptionPayment({ tenantId: tenant.id, chargeId: opening.id, method: 'BANK_TRANSFER', reference: 'BACS-SKINT-1', recordedBy: 'ops' });
    const wallet = platform.wallet(tenant.id);
    const available = wallet.snapshot().availableMinor;
    assert.ok(available > 0, 'the paid month credited no allowance, so this proves nothing');

    // Spend it all, then ask for more. The raw cost that exhausts the balance is
    // derived from the rate rather than written as `/ 4`: a fixture pinned to
    // an old multiplier stops testing the refusal and starts failing on the
    // price.
    const drain = Math.floor(available / config.billing.markupMultiplier);
    const hold = wallet.reserve({ aiRequestId: 'drain', estimatedRawCostMinor: drain });
    wallet.settle(hold.holdId, drain, 'OPENAI');

    await rejectsCode(
      async () => wallet.reserve({ aiRequestId: 'after', estimatedRawCostMinor: available }),
      'ACU_EXHAUSTED',
    );
  });

  it('never lets a balance go negative', () => {
    const wallet = platform.wallet(seed.users.pm!.auth.tenantId);
    assert.ok(wallet.snapshot().balanceMinor >= 0);
    assert.ok(wallet.snapshot().availableMinor >= 0 || wallet.snapshot().heldMinor > 0);
  });
});
