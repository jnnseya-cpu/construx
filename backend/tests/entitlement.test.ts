import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { standing } from '../src/billing/entitlement.ts';
import { runAI, write } from '../src/engines/context.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * What a tenancy may do when it stops paying.
 *
 * `Subscription.status` carried `ACTIVE | SUSPENDED | CANCELLED` and exactly
 * one function read it — `monthlySubscriptionCharge`, which returns zero when
 * it is not ACTIVE. Every other gate read `subscription.package`, which does
 * not change when a subscription ends. Nothing anywhere could *set* the status
 * to either of the values meaning "stopped paying".
 *
 * So a customer could stop paying and carry on: writing to the ledger, running
 * engines against a topped-up wallet, and buying more credit. The platform kept
 * carrying their storage and a thirty-year retention obligation. That is not
 * lost revenue — it is an unbounded permanent liability acquired at the moment
 * somebody stops paying.
 *
 * The principle these enforce: **ACU credit buys AI. It does not buy the
 * platform.** Separate purchases, separately gated.
 *
 * What must keep working matters as much as what stops. A suspended customer
 * can still read their record; a regulator's access does not depend on a
 * contractor's invoice; and an erasure request is a statutory right that cannot
 * be gated on payment. Each has its own test below, because a gate that catches
 * those too is worse than the leak.
 */

let platform: Platform;
let seed: SeedResult;

const as = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

function suspend(reason = 'Payment failed on renewal'): void {
  platform.setSubscriptionStatus({
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'SUSPENDED',
    reason,
    decidedBy: seed.users.operator!.id,
  });
}

/** Credit a wallet the only way there is: against a recorded payment. */
function credit(tenantId: string, amountMinor: number, reference: string): void {
  platform.creditFromPayment({
    tenantId,
    amountMinor,
    method: 'BANK_TRANSFER',
    reference,
    recordedBy: seed.users.operator!.id,
  });
}

function reactivate(): void {
  platform.setSubscriptionStatus({
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'ACTIVE',
    reason: 'Payment settled',
    decidedBy: seed.users.operator!.id,
  });
}

/** A minimal state change, standing in for every command in the platform. */
function attemptWrite(who: string) {
  return () =>
    write(as(who), {
      eventType: 'PACKAGE_CREATED',
      entity: { refType: 'ScopePackage', refId: `probe-${Math.trunc(performance.now() * 1000)}` },
      nextState: { id: 'probe', name: 'Entitlement probe' },
    });
}

/** A minimal engine run, standing in for every AI path. */
function attemptAI(who: string) {
  return () =>
    runAI(as(who), {
      engine: 'TENDER',
      taskType: 'entitlement-probe',
      capability: 'REASONING',
      inputRefs: [],
      request: { task: 'entitlement-probe', payload: {} },
      toWrites: () => [],
    });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ------------------------------------------------------------- the rules alone

describe('what the entitlement rules decide', () => {
  const active = {
    id: 's',
    tenantId: 't',
    tier: 'BUSINESS',
    package: 'PROFESSIONAL_DELIVERY',
    status: 'ACTIVE',
    assignedIdentities: [],
    startedAt: '2026-01-01T00:00:00.000Z',
    renewsAt: '2026-02-01T00:00:00.000Z',
  } as never;

  it('permits everything on an active paid subscription', () => {
    const position = standing(active, ['PM']);
    assert.deepEqual(
      { w: position.mayWrite, a: position.mayRunAI, t: position.mayTopUp, e: position.mayExport },
      { w: true, a: true, t: true, e: true },
    );
  });

  it('closes all four on a subscription that has stopped', () => {
    for (const status of ['SUSPENDED', 'CANCELLED'] as const) {
      const position = standing({ ...(active as object), status } as never, ['PM']);
      assert.deepEqual(
        { w: position.mayWrite, a: position.mayRunAI, t: position.mayTopUp, e: position.mayExport },
        { w: false, a: false, t: false, e: false },
        `${status} left something open`,
      );
      assert.match(position.reason ?? '', /read-only/i, 'the customer must be told what changed');
    }
  });

  it('fails closed when no subscription is recorded at all', () => {
    // Either a tenancy that was never provisioned or one whose record did not
    // restore. Writing to an immutable ledger is the wrong answer in both.
    const position = standing(undefined, ['PM']);
    assert.equal(position.status, 'NONE');
    assert.equal(position.mayWrite, false);
    assert.equal(position.mayRunAI, false);
  });

  it('exempts the operator and the regulator, whatever the subscription says', () => {
    // The operator is not a customer and has no package to be limited by. A
    // regulator's access is one the asset owner is obliged to provide —
    // refusing it because the contractor has not paid would be this platform
    // enforcing a commercial term against a statutory right.
    for (const role of ['PLATFORM_ADMIN', 'REGULATOR']) {
      const position = standing({ ...(active as object), status: 'CANCELLED' } as never, [role]);
      assert.equal(position.mayWrite, true, `${role} was gated by a commercial term`);
      assert.equal(position.mayExport, true, `${role} was refused an export`);
    }
    // And when there is no subscription to read at all.
    assert.equal(standing(undefined, ['REGULATOR']).mayExport, true);
  });

  it('still refuses export on a trial, which is a package limit rather than a payment one', () => {
    const trial = { ...(active as object), package: 'FREE_TRIAL' } as never;
    const position = standing(trial, ['PM']);
    assert.equal(position.mayWrite, true, 'a trial is a paying relationship and may write');
    assert.equal(position.mayExport, false);
    assert.match(position.reason ?? '', /does not include exporting/i);
  });
});

// --------------------------------------------------------------- leak 1: writes

describe('a stopped subscription cannot write', () => {
  it('permits the write while active', () => {
    reactivate();
    assert.doesNotThrow(attemptWrite('pm'));
  });

  it('refuses it once suspended, and says why', () => {
    suspend();
    throwsCode(attemptWrite('pm'), 'SUBSCRIPTION_NOT_ACTIVE');
  });

  it('answers 402, not 403 — this is a bill, not a permission', () => {
    // A client that cannot tell the two apart sends somebody to the wrong
    // support queue: one is "ask your administrator", the other is "pay us".
    suspend();
    try {
      attemptWrite('pm')();
      assert.fail('the write was permitted');
    } catch (error) {
      assert.equal((error as { status?: number }).status, 402);
    }
  });

  it('refuses through a real domain command, not only the primitive', () => {
    suspend();
    throwsCode(
      () =>
        structure.createScopePackage(as('pm'), {
          name: 'Late works',
          discipline: 'CIVILS',
          scopeOfWorks: 'Anything at all, which is the point — no command may write.',
          inclusions: [],
          exclusions: [],
          acceptanceCriteria: ['n/a'],
          estimatedValueMinor: 1_000_00,
          designResponsibility: 'CLIENT',
        }),
      'SUBSCRIPTION_NOT_ACTIVE',
    );
  });

  it('refuses evidence registration too, so no orphans are left behind', () => {
    // Evidence is registered *before* the event that needs it. Leaving that
    // open would let a read-only tenancy append evidence records no event ever
    // references — writes that failed, littering a ledger nothing can tidy.
    suspend();
    throwsCode(
      () =>
        structure.assessDesignMaturity(as('pm'), {
          packageId: 'anything',
          disciplineScores: [{ discipline: 'CIVILS', ribaStage: 4, completenessPercent: 80, frozen: true }],
          informationGaps: [],
          assessorNotes: 'probe',
        }),
      'SUBSCRIPTION_NOT_ACTIVE',
    );
  });

  it('lets the writes through again once reactivated', () => {
    suspend();
    reactivate();
    assert.doesNotThrow(attemptWrite('pm'));
  });
});

// ------------------------------------------------------------------ leak 2: AI

describe('a stopped subscription cannot run AI, however full the wallet', () => {
  it('refuses the run and does not touch the wallet', async () => {
    // The specific loophole: cancel the subscription, keep topping up, carry on
    // using the engines. `runAI` checked the balance and nothing else.
    reactivate();
    const tenantId = seed.users.pm!.auth.tenantId;
    credit(tenantId, 100_000, 'ENTITLEMENT-AI-1');

    suspend();
    const before = platform.wallet(tenantId).snapshot();

    await rejectsCode(attemptAI('pm'), 'SUBSCRIPTION_NOT_ACTIVE');

    const after = platform.wallet(tenantId).snapshot();
    assert.deepEqual(
      { available: after.availableMinor, balance: after.balanceMinor },
      { available: before.availableMinor, balance: before.balanceMinor },
      'a refused run reserved or spent credit',
    );
  });

  it('refuses before anything is reserved, not after', async () => {
    // Ordering is the whole point. Refusing after the reservation would still
    // put a hold on a customer's credit for work that never ran.
    suspend();
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = platform.wallet(tenantId).snapshot();

    await rejectsCode(attemptAI('pm'), 'SUBSCRIPTION_NOT_ACTIVE');

    assert.equal(platform.wallet(tenantId).snapshot().heldMinor, before.heldMinor, 'credit was held for a refused run');
  });

  it('is refused for a cancelled subscription as well as a suspended one', async () => {
    platform.setSubscriptionStatus({
      tenantId: seed.users.pm!.auth.tenantId,
      status: 'CANCELLED',
      reason: 'Customer cancelled',
      decidedBy: seed.users.operator!.id,
    });
    await rejectsCode(attemptAI('pm'), 'SUBSCRIPTION_NOT_ACTIVE');
  });
});

// ------------------------------------------------------------- leak 3: top-ups

describe('a stopped subscription cannot buy more credit', () => {
  it('refuses the top-up and leaves the balance alone', () => {
    // Taking the money would be worse than the loophole: the credit is
    // unspendable because `runAI` refuses it, so it is a charge for nothing.
    suspend();
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = platform.wallet(tenantId).snapshot().balanceMinor;

    throwsCode(
      () => platform.requestTopUp({ tenantId, amountMinor: 50_000, requestedBy: seed.users.admin!.id }),
      'SUBSCRIPTION_NOT_ACTIVE',
    );
    assert.equal(platform.wallet(tenantId).snapshot().balanceMinor, before, 'money was taken');
  });

  it('accepts it again once reactivated', () => {
    reactivate();
    const tenantId = seed.users.pm!.auth.tenantId;
    const before = platform.wallet(tenantId).snapshot().balanceMinor;
    // The request alone moves nothing — that is the point of splitting it from
    // the receipt — so the assertion is on the credit, not on the ask.
    platform.requestTopUp({ tenantId, amountMinor: 50_000, requestedBy: seed.users.admin!.id });
    assert.equal(platform.wallet(tenantId).snapshot().balanceMinor, before, 'a request is not money');

    credit(tenantId, 50_000, 'ENTITLEMENT-REACTIVATED');
    assert.ok(platform.wallet(tenantId).snapshot().balanceMinor > before);
  });
});

// -------------------------------------------------------- what must keep working

describe('what a stopped subscription must not break', () => {
  it('still lets the customer read their own record', () => {
    // Read-only, not unreachable. Somebody who has stopped paying must still be
    // able to open the platform and see what is there — otherwise the first
    // thing a billing failure does is hide the evidence somebody needs to
    // resolve it.
    suspend();
    const project = platform.ledger.require({ refType: 'Project', refId: seed.projectId });
    assert.ok(project.state.name, 'the record became unreadable');
    assert.ok(platform.ledger.list(seed.projectId, 'ScopePackage').length >= 0);
  });

  it('keeps the operator out of every customer engine context, which is stronger', () => {
    // This used to hold for a reason nobody chose. `platform.context` needs a
    // wallet, the operator tenancy had none, and so an operator could not hold
    // an engine context for anything at all. That was the right outcome from an
    // accident, and this test pinned it.
    //
    // The platform now has its own wallet, because it runs AI of its own — it
    // drafts articles for its own marketing site — and that spend has to be
    // metered like everybody else's rather than sitting outside the meter. So
    // the accident is gone and the property is a check: `context` refuses any
    // project that is not the platform's own.
    //
    // Asserted on the refusal code rather than a wallet message, because the
    // point was never the wallet. Without this, a caller could pass a
    // customer's project id with an operator's token and get an engine context
    // over their record, charged to the platform's wallet.
    suspend();
    assert.throws(() => as('operator'), /ACCOUNT_LAYER_SEPARATION|barred from customer delivery data/);
  });

  it('lets the operator hold a context for the platform\u2019s own surface, and only that', () => {
    // The other half of the same boundary, and the reason the blog can exist:
    // an operator drafting an article acts on `platform-marketing`, which is
    // not a customer's anything.
    const operator = platform.operators()[0];
    assert.ok(operator, 'no operator to test with');
    const auth = { actorId: operator.id, tenantId: operator.tenantId, roles: operator.roles, scopes: [] } as never;
    assert.doesNotThrow(() => platform.context(auth, 'platform-marketing'));
    assert.throws(() => platform.context(auth, seed.projectId), /barred from customer delivery data/);
  });

  it('does not gate a regulator', () => {
    suspend();
    assert.equal(as('regulator').standing.mayExport, true, 'a statutory access was refused over an unpaid invoice');
  });

  it('still honours an erasure request', () => {
    // A data-subject right cannot depend on an invoice. Erasure commits through
    // the platform rather than through `write`, which is what keeps it outside
    // the commercial gate — asserted here so a later refactor cannot quietly
    // route it through and make a statutory obligation billable.
    suspend();
    assert.doesNotThrow(() =>
      platform.requestErasure(seed.users.admin!.auth, {
        userId: seed.users.qaqc!.id,
        reason: 'Data subject request received while the account was suspended',
      }),
    );
  });
});

// ----------------------------------------------------------- the record of it

describe('changing a subscription status is itself governed', () => {
  it('refuses a change with no stated reason', () => {
    throwsCode(
      () =>
        platform.setSubscriptionStatus({
          tenantId: seed.users.pm!.auth.tenantId,
          status: 'SUSPENDED',
          reason: '   ',
          decidedBy: seed.users.operator!.id,
        }),
      'SUBSCRIPTION_REASON_REQUIRED',
    );
  });

  it('records who decided, when, and on what basis', () => {
    reactivate();
    suspend('Card declined twice; dunning exhausted');

    const tenantId = seed.users.pm!.auth.tenantId;
    const record = platform.ledger
      .listByTenant(tenantId, 'Subscription')
      .map((r) => r.state)
      .find((s) => s.statusReason === 'Card declined twice; dunning exhausted');

    assert.ok(record, 'the suspension left no record');
    assert.equal(record.status, 'SUSPENDED');
    assert.equal(record.previousStatus, 'ACTIVE');
    assert.equal(record.statusChangedBy, seed.users.operator!.id);
    assert.ok(record.statusChangedAt, 'a decision with no timestamp cannot be reconstructed');
  });

  it('is a no-op when the status is already what is asked for', () => {
    reactivate();
    const before = platform.ledger.listByTenant(seed.users.pm!.auth.tenantId, 'Subscription').length;
    platform.setSubscriptionStatus({
      tenantId: seed.users.pm!.auth.tenantId,
      status: 'ACTIVE',
      reason: 'Already active',
      decidedBy: seed.users.operator!.id,
    });
    assert.equal(
      platform.ledger.listByTenant(seed.users.pm!.auth.tenantId, 'Subscription').length,
      before,
      'a no-op change wrote an event',
    );
  });
});
