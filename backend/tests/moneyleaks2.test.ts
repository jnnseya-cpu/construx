import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import { config } from '../src/config.ts';
import { BILLING_CURRENCY } from '../src/billing/payments.ts';
import { issueTokens } from '../src/identity/auth.ts';
import {
  OPERATOR_ONLY_ROLES,
  TENANT_GRANTABLE_ROLES,
  assertTenantGrantable,
} from '../src/identity/roles.ts';
import { resetRegistrations, trialGrantAllowed, trialKey, recordTrialTaken } from '../src/identity/signup.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The second money audit. Four more ways to end up financially worse off, none
 * of which needed anything the first audit closed.
 *
 *   1. **Privilege escalation into the operator role.** `POST /v1/users` and
 *      `POST /v1/users/:userId/roles` took an unconstrained array of strings
 *      and passed it through. An enterprise admin — which is what every
 *      self-serve signup gets — could grant themselves `PLATFORM_ADMIN`, and
 *      the operator role can credit any wallet with any amount. Every control
 *      in the first audit sits behind that one word.
 *
 *   2. **Currency arbitrage.** Tenancies choose a display currency and money
 *      was recorded in minor units without one. A tenancy on JPY paying an
 *      invoice denominated in "minor units" would settle roughly a hundredth
 *      of what a GBP tenancy paid for the same thing.
 *
 *   3. **A provider reporting a negative cost.** `settle` multiplied the raw
 *      provider cost by the markup. A zero or negative figure — a provider
 *      bug, a malformed usage block, a mocked response — produced a zero or
 *      negative charge, and the compute had still been bought.
 *
 *   4. **Trial farming.** The free grant was handed out per tenancy, and a
 *      tenancy is one signup form. `rowan+1@`, `rowan+2@`, `r.owan@gmail.com`
 *      — all the same mailbox, all separate grants, all real provider spend.
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
  options: { who?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.who) headers.authorization = `Bearer ${tokenFor(options.who)}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => resetIdempotency());

after(() => server.close());

// ----------------------------------------------- 1. escalation into the operator role

describe('a tenant administrator cannot grant themselves the operator role', () => {
  it('refuses PLATFORM_ADMIN and REGULATOR from inside a tenancy', () => {
    for (const role of OPERATOR_ONLY_ROLES) {
      throwsCode(
        () => assertTenantGrantable(['PM', role]),
        'ROLE_NOT_GRANTABLE',
        `${role} was grantable from inside a tenancy`,
      );
    }
  });

  it('tells a typo apart from an escalation', () => {
    // Different codes on purpose. A misspelt role is a mistake worth a helpful
    // message; an attempt at the operator role is a security event, and the
    // operator's audit stream should be able to see which happened.
    throwsCode(() => assertTenantGrantable(['PROJECT_MANGER']), 'ROLE_UNKNOWN');
  });

  it('leaves every ordinary role grantable', () => {
    const granted = assertTenantGrantable(TENANT_GRANTABLE_ROLES);
    assert.equal(granted.length, TENANT_GRANTABLE_ROLES.length);
    assert.ok(!TENANT_GRANTABLE_ROLES.some((role) => OPERATOR_ONLY_ROLES.includes(role)));
  });

  it('refuses the escalation over HTTP, at the schema before the handler', async () => {
    const reply = await call('POST', '/v1/users', {
      who: 'admin',
      body: { name: 'Mallory', email: 'mallory@acme.test', roles: ['PLATFORM_ADMIN'] },
    });

    assert.equal(reply.status, 400, 'an enterprise admin minted a platform operator');
  });

  it('refuses the escalation when it is smuggled in beside a legitimate role', async () => {
    const reply = await call('POST', '/v1/users', {
      who: 'admin',
      body: {
        name: 'Mallory',
        email: 'mallory2@acme.test',
        roles: ['PM', 'PLATFORM_ADMIN'],
      },
    });

    assert.equal(reply.status, 400);
  });

  it('refuses the escalation on the role-assignment route as well', async () => {
    // Two doors to the same room. Closing one and leaving the other is the
    // usual way a fix like this fails.
    const created = await call('POST', '/v1/users', {
      who: 'admin',
      body: { name: 'Robin', email: 'robin@acme.test', roles: ['PM'] },
    });
    assert.ok([200, 201].includes(created.status), `user creation answered ${created.status}`);

    const escalated = await call('POST', `/v1/users/${created.body.id}/roles`, {
      who: 'admin',
      body: { roles: ['PM', 'PLATFORM_ADMIN'] },
    });
    assert.equal(escalated.status, 400);

    const after = platform.user(created.body.id);
    assert.ok(!after.roles.includes('PLATFORM_ADMIN'), 'the role was assigned despite the refusal');
  });
});

// --------------------------------------------------------- 2. currency arbitrage

describe('money carries the currency it was denominated in', () => {
  it('denominates a top-up request in the billing currency', async () => {
    const reply = await call('POST', '/v1/billing/top-up', {
      who: 'admin',
      body: { amountMinor: 50_000 },
    });

    assert.ok([200, 201].includes(reply.status));
    assert.equal(reply.body.currency, BILLING_CURRENCY);
  });

  it('denominates a receipt in the billing currency, not the tenancy display currency', () => {
    // The display currency is a presentation choice. Minor units are not
    // comparable across currencies, so recording a payment without naming one
    // is how a JPY tenancy pays a hundredth of a GBP tenancy for the same
    // thing and the ledger cannot tell.
    const tenantId = seed.users.pm!.auth.tenantId;
    const { receipt } = platform.creditFromPayment({
      tenantId,
      amountMinor: 1_000,
      method: 'BANK_TRANSFER',
      reference: 'CURRENCY-DENOMINATION-TEST',
      recordedBy: 'test',
      source: 'OPERATOR',
    });

    assert.equal(receipt.currency, BILLING_CURRENCY);
  });

  it('denominates an invoice in the billing currency', () => {
    const tenantId = seed.users.pm!.auth.tenantId;
    const invoice = platform.previewInvoice(tenantId, new Date().toISOString().slice(0, 7));
    assert.equal(invoice.currency, BILLING_CURRENCY);
  });
});

// ------------------------------------------------ 3. a provider that reports nonsense

describe('a provider cannot report a cost that charges nothing', () => {
  it('refuses a zero or negative raw cost rather than charging zero', () => {
    // The compute was bought either way. A charge derived from a cost of zero
    // is a free execution, and a negative one would *credit* the customer for
    // running an engine.
    const wallet = platform.wallet(seed.users.pm!.auth.tenantId);
    for (const cost of [0, -1, -100_000]) {
      const hold = wallet.reserve({ aiRequestId: `probe-${cost}`, estimatedRawCostMinor: 1_000 });
      throwsCode(
        () => wallet.settle(hold.holdId, cost, 'test-provider'),
        'ACU_COST_INVALID',
        `a raw provider cost of ${cost} was accepted`,
      );
      wallet.release(hold.holdId, 'probe complete');
    }
  });

  it('refuses a cost that is not a finite number', () => {
    const wallet = platform.wallet(seed.users.pm!.auth.tenantId);
    for (const cost of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const hold = wallet.reserve({ aiRequestId: `probe-${String(cost)}`, estimatedRawCostMinor: 1_000 });
      throwsCode(
        () => wallet.settle(hold.holdId, cost, 'test-provider'),
        'ACU_COST_INVALID',
        `${String(cost)} was accepted as a cost`,
      );
      wallet.release(hold.holdId, 'probe complete');
    }
  });
});

// ------------------------------------------------------------ 4. trial farming

describe('one free trial per mailbox, not per signup form', () => {
  beforeEach(() => resetRegistrations());

  it('treats plus-addressed variants of one mailbox as one', () => {
    // The cheapest farm there is. Every major provider delivers `a+1@` and
    // `a+2@` to the same inbox, so this is one person taking two grants of
    // real provider compute.
    assert.equal(trialKey('rowan+one@gmail.com'), trialKey('rowan+two@gmail.com'));
  });

  it('treats dotted Gmail variants as one', () => {
    // Gmail ignores dots in the local part. `r.owan@`, `ro.wan@` and `rowan@`
    // are one mailbox and, before this, three free trials.
    assert.equal(trialKey('r.o.w.a.n@gmail.com'), trialKey('rowan@gmail.com'));
    assert.equal(trialKey('rowan@googlemail.com'), trialKey('rowan@googlemail.com'));
  });

  it('counts a company domain once, however many addresses it has', () => {
    // A company is one customer. Twelve staff signing up individually is not
    // twelve trials, it is one organisation twelve times over.
    assert.equal(trialKey('rowan@acme.co.uk'), trialKey('jo@acme.co.uk'));
    assert.equal(trialKey('rowan@acme.co.uk'), 'acme.co.uk');
  });

  it('does not count a whole free-mail domain as one organisation', () => {
    // The opposite failure, and it would be worse: one trial for every sole
    // trader on Gmail, which is most of them. A trial per mailbox is right
    // here; a trial per domain would refuse the second real customer.
    assert.notEqual(trialKey('rowan@gmail.com'), trialKey('jo@gmail.com'));
  });

  it('allows the first grant and refuses the second from the same mailbox', () => {
    assert.equal(trialGrantAllowed('rowan+a@gmail.com'), true);
    recordTrialTaken('rowan+a@gmail.com');

    assert.equal(trialGrantAllowed('rowan+b@gmail.com'), false, 'a second grant went to the same mailbox');
    assert.equal(trialGrantAllowed('r.owan@gmail.com'), false, 'a dotted variant took a second grant');
    assert.equal(trialGrantAllowed('someone.else@gmail.com'), true, 'an unrelated mailbox was refused');
  });

  it('withholds the grant and nothing else', () => {
    // Two identical tenancies, one refused the grant. The difference between
    // their opening balances is exactly the free credit, which is the figure
    // the farm was harvesting — and what remains is the subscription's own AI
    // allowance, which is paid for and must still be there.
    const spec = {
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM' as const,
    };

    const first = platform.createTenant({
      ...spec,
      legalName: 'Acme First Attempt',
      enterpriseName: 'Acme First Attempt',
    });
    const second = platform.createTenant({
      ...spec,
      trialGrant: false,
      legalName: 'Acme Second Attempt',
      enterpriseName: 'Acme Second Attempt',
    });

    const granted = platform.wallet(first.tenant.id).snapshot().balanceMinor;
    const withheld = platform.wallet(second.tenant.id).snapshot().balanceMinor;

    assert.ok(granted > withheld, 'refusing the trial grant changed nothing');
    // The account is real and the customer may pay for credit. Refusing the
    // free grant must not refuse the signup — that would turn a spend control
    // into a lost sale — and the paid allowance is untouched.
    assert.ok(second.tenant.id);
    assert.equal(
      withheld,
      granted - config.billing.freeTrialGrantMinor,
      'more than the trial grant was withheld',
    );
  });
});
