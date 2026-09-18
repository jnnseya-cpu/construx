import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import * as engine from '../src/billing/estateengine.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { monthlySubscriptionCharge } from '../src/billing/subscription.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * A package granted free of charge owes nothing — not the first month, not a
 * renewal — and the wallet is still the tenancy's own to top up.
 *
 * Reported as: one account is exempt from any monthly cost but buys its ACUs by
 * topping up. The operator's door for that existed and recorded the decision on
 * the event; nothing read it. The response said £0 a month, `raiseCharge` read
 * the list price at every renewal, and a signup waiting for its first month
 * stayed waiting with the charge still due.
 */

const DAY = 86_400_000;
let platform: Platform;
let server: Server;
let base: string;
let operatorToken: string;
let operatorId = '';
let tenantId = '';
let adminToken = '';

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function send(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  operatorId = operator.id;
  operatorToken = tokenFor(operator.id);
  // A stranger's paid signup: waiting for its first month, nothing in the wallet.
  const created = platform.createTenant({ legalName: 'JNN Global Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'JNN Global', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
  tenantId = created.tenant.id;
  const admin = platform.createUser({ tenantId, name: 'Jean Nseya', email: 'jean@jnnglobal.example', roles: ['ENTERPRISE_ADMIN'] });
  adminToken = tokenFor(admin.id);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('granting the package free of charge', () => {
  it('starts as a paid signup waiting for its first month', () => {
    assert.equal(platform.subscription(tenantId).status, 'AWAITING_PAYMENT');
    assert.equal(collection.outstanding(platform, tenantId).length, 1);
    assert.equal(platform.wallet(tenantId).snapshot().balanceMinor, 0);
  });

  it('opens the tenancy, writes off the first month, and leaves the wallet at nothing', async () => {
    const granted = await send('POST', `/v1/admin/tenants/${tenantId}/package`, operatorToken, {
      package: 'CORE_PROJECT',
      reason: 'JNN Global Ltd is exempt from the monthly subscription; it buys ACUs by topping up',
      grantFree: true,
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    assert.equal(granted.body.grantedFree, true);
    assert.equal(granted.body.status, 'ACTIVE');
    assert.equal(granted.body.monthlyPriceMinor, 0);
    assert.ok(Number(granted.body.listPriceMinor) > 0);

    const subscription = platform.subscription(tenantId);
    assert.equal(subscription.status, 'ACTIVE');
    assert.equal(subscription.grantedFree, true);
    assert.equal(monthlySubscriptionCharge(subscription), 0);
    assert.equal(collection.outstanding(platform, tenantId).length, 0, 'the first month is no longer owed');
    assert.ok(collection.chargesFor(platform, tenantId).some((charge) => charge.status === 'WRITTEN_OFF'));
    assert.equal(platform.wallet(tenantId).snapshot().balanceMinor, 0, 'a free package credits no AI');
  });

  it('raises nothing at renewal', () => {
    const subscription = platform.subscription(tenantId);
    const raised = collection.raiseCharge(platform, tenantId, new Date(Date.parse(subscription.renewsAt) + DAY));
    assert.equal(raised, undefined);
    assert.equal(collection.outstanding(platform, tenantId).length, 0);
    assert.equal(collection.raiseOpeningCharge(platform, tenantId), undefined, 'and no opening charge either');
  });

  it('the customer sees no monthly price and the operator sees the grant', async () => {
    const own = await send('GET', '/v1/billing/subscription', adminToken);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const summary = own.body.subscription as Record<string, unknown>;
    assert.equal(summary.grantedFree, true);
    assert.equal(summary.monthlyPriceMinor, 0);
    assert.equal(summary.listPriceMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(summary.status, 'ACTIVE');

    const estate = await send('GET', '/v1/admin/tenants', operatorToken);
    const row = (estate.body.tenants as Array<Record<string, unknown>>).find((entry) => entry.id === tenantId)!;
    assert.equal(row.grantedFree, true);
    assert.equal(row.monthlyPriceMinor, 0);
    assert.equal(row.outstandingMinor, 0);
    assert.equal(row.status, 'ACTIVE');

    const position = engine.estatePosition(platform, new Date(Date.now() + 40 * DAY));
    const checks = new Map(position.sweep.map((finding) => [finding.check, finding]));
    assert.equal(checks.get('First payment')!.ok, true);
    assert.equal(checks.get('Collection')!.ok, true, checks.get('Collection')!.detail);
  });

  it('still buys its AI by topping up', async () => {
    const credited = await send('POST', `/v1/admin/tenants/${tenantId}/credit`, operatorToken, { amountMinor: 10_000, method: 'BANK_TRANSFER', reference: 'FPS-JNN-0001' });
    assert.equal(credited.status, 201, JSON.stringify(credited.body));
    assert.equal(platform.wallet(tenantId).snapshot().availableMinor, 10_000);
    // A top-up is a receipt, not a subscription payment: nothing about the grant moves.
    assert.equal(platform.subscription(tenantId).grantedFree, true);
    assert.equal(collection.outstanding(platform, tenantId).length, 0);
  });

  it('the operator can write the credit down to nothing, with the reason on the record', async () => {
    const refused = await send('POST', `/v1/admin/tenants/${tenantId}/wallet/write-off`, adminToken, { reason: 'Not mine to do' });
    assert.equal(refused.status, 403);
    const short = await send('POST', `/v1/admin/tenants/${tenantId}/wallet/write-off`, operatorToken, { reason: 'x' });
    assert.equal(short.status, 400);
    const written = await send('POST', `/v1/admin/tenants/${tenantId}/wallet/write-off`, operatorToken, { reason: 'Seeded allowance, never money' });
    assert.equal(written.status, 201, JSON.stringify(written.body));
    assert.equal(written.body.writtenOffMinor, 10_000);
    assert.equal((written.body.wallet as { availableMinor: number }).availableMinor, 0);
    const entries = platform.wallet(tenantId).entries();
    assert.match(String(entries.at(-1)!.note), /written off by the operator/);
    // A second write-off of nothing is nothing.
    const nothing = await send('POST', `/v1/admin/tenants/${tenantId}/wallet/write-off`, operatorToken, { reason: 'Nothing left to take' });
    assert.equal(nothing.body.writtenOffMinor, 0);
    // Topping up again works as before.
    await send('POST', `/v1/admin/tenants/${tenantId}/credit`, operatorToken, { amountMinor: 2_500, method: 'BANK_TRANSFER', reference: 'FPS-JNN-0002' });
    assert.equal(platform.wallet(tenantId).snapshot().availableMinor, 2_500);
  });

  it('survives a seat change and a restart', () => {
    platform.createUser({ tenantId, name: 'Esi Mensah', email: 'esi@jnnglobal.example', roles: ['PLANNER'] });
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    const restored = rebuilt.subscription(tenantId);
    assert.equal(restored.grantedFree, true, 'the grant is on the record, not in memory');
    assert.equal(restored.assignedIdentities.length, 2);
    assert.equal(collection.raiseCharge(rebuilt, tenantId, new Date(Date.parse(restored.renewsAt) + DAY)), undefined);
  });

  it('granting the same package free again changes nothing', () => {
    const before = platform.ledger.events().length;
    platform.setSubscriptionPackage({ tenantId, package: 'CORE_PROJECT', reason: 'Said twice', decidedBy: operatorId, grantFree: true });
    assert.equal(platform.ledger.events().length, before);
  });

  it('can be withdrawn: the same package, paid again from the next renewal', () => {
    const paid = platform.setSubscriptionPackage({ tenantId, package: 'CORE_PROJECT', reason: 'Exemption ended by agreement', decidedBy: operatorId, grantFree: false });
    assert.equal(paid.grantedFree, false);
    assert.equal(monthlySubscriptionCharge(paid), PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    const raised = collection.raiseCharge(platform, tenantId, new Date(Date.parse(paid.renewsAt) + DAY));
    assert.ok(raised && !raised.alreadyRaised, 'a paid package is charged at renewal');
    assert.equal(raised!.charge.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
  });
});

// ── A grant with a term ─────────────────────────────────────────────────────

describe('a free grant can be given for a fixed period', () => {
  /*
   * ## What happened
   *
   * Reported as: a group and its enterprises were still being asked for money
   * while they were exempt for twelve months.
   *
   * Two things were missing and neither failed anything.
   *
   * **A grant had no end.** `grantFree` was a boolean. "Exempt for twelve
   * months" could only be recorded as "free forever, and somebody diarise it",
   * which is how a tenancy is still exempt in year three — and, from the other
   * side, why an operator wary of that grants nothing at all and the customer
   * is billed through a term they were promised.
   *
   * **A grant was per company, with nothing above it.** A group of eight
   * companies was eight separate operator acts, and an exemption agreed with
   * the group held only for whichever ones somebody remembered. Missing one is
   * invisible: the symptom is a single company being charged correctly
   * according to its own record.
   *
   * ## Where the term is applied
   *
   * Once, in `Platform.subscription`, which every reader goes through —
   * `raiseCharge`, `raiseOpeningCharge`, the activation position, the group
   * billing directory, the invoice item, the shared-wallet decision. An
   * exemption that expired everywhere except one of them leaks money in the
   * direction nothing fails in, because nobody reports not being charged.
   */
  const YEAR = 365 * DAY;

  function exempt(until?: Date) {
    const platform = new Platform();
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    const { tenant } = platform.createTenant({
      legalName: 'Exempt Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      package: 'CORE_PROJECT',
      enterpriseName: 'Exempt',
      deferOpeningCharge: true,
    });
    platform.setSubscriptionPackage({
      tenantId: tenant.id,
      package: 'CORE_PROJECT',
      reason: 'Twelve months free, as agreed',
      decidedBy: operator.id,
      grantFree: true,
      ...(until ? { grantFreeUntil: until.toISOString() } : {}),
    });
    return { platform, tenantId: tenant.id };
  }

  it('charges nothing while the term runs', () => {
    const { platform, tenantId } = exempt(new Date(Date.now() + YEAR));
    const subscription = platform.subscription(tenantId);
    assert.equal(subscription.grantedFree, true, 'the grant is not in force during its own term');
    assert.equal(monthlySubscriptionCharge(subscription), 0, 'a tenancy inside its exempt term was priced at the list rate');
    assert.equal(
      collection.raiseOpeningCharge(platform, tenantId, new Date()),
      undefined,
      'a first month was raised against a tenancy that is exempt',
    );
  });

  it('charges again the day the term ends, with nobody having to remember', () => {
    // The behaviour the whole field exists for. Read at a date past the term:
    // the same stored record, a different answer.
    const { platform, tenantId } = exempt(new Date(Date.now() + YEAR));
    const afterTheTerm = new Date(Date.now() + YEAR + DAY);

    const during = platform.subscription(tenantId);
    const after = platform.subscription(tenantId, afterTheTerm);

    assert.equal(during.grantedFree, true);
    assert.equal(after.grantedFree, false, 'the exemption outlived its own end date');
    assert.equal(
      monthlySubscriptionCharge(after),
      PACKAGES.CORE_PROJECT.monthlyPriceMinor,
      'a tenancy past its exempt term is still priced at nothing',
    );
  });

  it('does not charge for AI either, and says so on the wallet', () => {
    /*
     * Reported as: a group holding twelve months of free ACUs watched its
     * prepaid balance fall anyway, with a runway counting down beside it.
     *
     * The exemption was real and was applied everywhere it was looked for —
     * but everywhere it was looked for was the *subscription*, the monthly
     * platform fee. The AI wallet knew nothing about it, so the customer was
     * told their AI was free and then metered. One grant, both halves.
     */
    const { platform, tenantId } = exempt(new Date(Date.now() + YEAR));
    const wallet = platform.wallet(tenantId);
    assert.ok(wallet.unmetered(), 'an exempt tenancy was still being metered for AI');

    const hold = wallet.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 43 });
    const entry = wallet.settle(hold.holdId, 43, 'OPENAI');
    assert.equal(entry.billedMinor, 0, 'an exempt tenancy was charged for an AI run');
    assert.equal(entry.rawCostMinor, 43, 'what the providers cost this platform must stay on the record');

    const snapshot = platform.wallet(tenantId).snapshot();
    assert.equal(snapshot.balanceMinor, 0, 'the balance moved for a charge that was not made');
    assert.equal(snapshot.aiHalted, false, 'an empty balance halted AI that is not billed to it');
    assert.ok(snapshot.unmetered, 'the screen has no way to say why the balance is not falling');
  });

  it('meters AI again the day the term ends', () => {
    // The wallet reads the term through the same accessor as the charge cycle,
    // so neither can outlive the other.
    const { platform, tenantId } = exempt(new Date(Date.now() + YEAR));
    const wallet = platform.wallet(tenantId);
    const afterTheTerm = new Date(Date.now() + YEAR + DAY).toISOString();
    assert.ok(wallet.unmetered(), 'the grant is not in force during its own term');
    assert.equal(wallet.unmetered(afterTheTerm), null, 'the AI exemption outlived its own end date');
  });

  it('keeps the term on the record after it expires, so the past stays answerable', () => {
    // "Was this month paid for" is a question a revenue reconciliation asks
    // about a month that has gone. An expiry that erased the grant would make
    // it unanswerable.
    const { platform, tenantId } = exempt(new Date(Date.now() + YEAR));
    const after = platform.subscription(tenantId, new Date(Date.now() + YEAR + DAY));
    assert.ok(after.grantedFreeUntil, 'the term was erased when it expired');
  });

  it('leaves an open-ended grant open-ended', () => {
    // Every grant made before the term existed has no date, and must go on
    // behaving exactly as it did.
    const { platform, tenantId } = exempt();
    const inTenYears = new Date(Date.now() + 10 * YEAR);
    assert.equal(platform.subscription(tenantId, inTenYears).grantedFree, true, 'an open-ended grant expired on its own');
  });

  it('refuses a term that has already run out', () => {
    // An operator typing last year's date would otherwise see "granted free of
    // charge" in the response and a full charge on the next renewal.
    const platform = new Platform();
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    const { tenant } = platform.createTenant({
      legalName: 'Backdated Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP',
      tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Backdated', deferOpeningCharge: true,
    });
    assert.throws(
      () => platform.setSubscriptionPackage({
        tenantId: tenant.id, package: 'CORE_PROJECT', reason: 'Backdated by mistake',
        decidedBy: operator.id, grantFree: true, grantFreeUntil: new Date(Date.now() - DAY).toISOString(),
      }),
      /already passed/,
    );
  });

  it('refuses a term on a package that is not being granted free', () => {
    const platform = new Platform();
    const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    const { tenant } = platform.createTenant({
      legalName: 'Paying Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP',
      tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Paying', deferOpeningCharge: true,
    });
    assert.throws(
      () => platform.setSubscriptionPackage({
        tenantId: tenant.id, package: 'CORE_PROJECT', reason: 'A term with no grant',
        decidedBy: operator.id, grantFree: false, grantFreeUntil: new Date(Date.now() + YEAR).toISOString(),
      }),
      /not being granted free/,
    );
  });

  it('clears the term when the grant is withdrawn', () => {
    // Otherwise a paid package carries a date that reads as an exemption.
    const { platform, tenantId } = exempt(new Date(Date.now() + YEAR));
    const operator = platform.operators()[0]!;
    const withdrawn = platform.setSubscriptionPackage({
      tenantId, package: 'CORE_PROJECT', reason: 'Withdrawn early by agreement',
      decidedBy: operator.id, grantFree: false,
    });
    assert.equal(withdrawn.grantedFree, false);
    assert.equal(withdrawn.grantedFreeUntil, undefined, 'a paid package still carries a free-until date');
  });
});
