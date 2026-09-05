import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import * as collection from '../src/billing/collection.ts';
import { PACKAGES, seatForRole } from '../src/billing/seats.ts';
import { usageAlertRecipients } from '../src/billing/usagealerts.ts';
import { approveAgreement, setAgreement, subscriptionPriceMinor } from '../src/group/agreement.ts';
import { addMembership, attachCompany, createGroup, grantGroupRole, groupStatement, setCostCentre } from '../src/group/directory.ts';
import { addCompany } from '../src/group/onboarding.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { PERMISSION_MATRIX, TENANT_GRANTABLE_ROLES } from '../src/identity/roles.ts';
import { deliveries } from '../src/notifications/notify.ts';
import { Platform, type PlatformUser } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * The group specifications, clause by clause, where a clause had been
 * recorded rather than built.
 *
 * GN-SPEC-TENANCY-001 §9.3: at a threshold of the monthly limit, notify the
 * company's administrators and the group's finance; at the hard limit, AI
 * stops and everything else continues. §6: least privilege — a new membership
 * is a viewer until an administrator names more. §9.4: rate cards are
 * approved pricing, and they change what a company pays. Enterprise / Group
 * v1.0 §9.3: a subscription is past_due before it is suspended, and says so.
 */

let platform: Platform;
let server: Server;
let base: string;
let operator: PlatformUser;
let holdingId: string;
let admin: PlatformUser;
let finance: PlatformUser;
let groupId: string;

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

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

before(async () => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  operator = platform.createOperator({ name: 'Ruth Okafor', email: 'ops@construx.example' });

  const created = platform.createTenant({
    legalName: 'Nseya Holdings Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'TEAM',
    package: 'CORE_PROJECT',
    enterpriseName: 'Nseya Holdings',
    trialGrant: false,
  });
  holdingId = created.tenant.id;
  admin = platform.createUser({ tenantId: holdingId, name: 'Justin Nseya', email: 'justin@nseya.example', roles: ['ENTERPRISE_ADMIN'] });
  finance = platform.createUser({ tenantId: holdingId, name: 'Amara Finance', email: 'amara@nseya.example', roles: ['QS'] });
  // The first month paid, so the holding company is open and its wallet holds
  // the month's allowance and nothing else.
  platform.recordSubscriptionPayment({ tenantId: holdingId, chargeId: created.openingCharge!.id, method: 'BANK_TRANSFER', reference: 'BACS-NSEYA-1', recordedBy: operator.id });

  const group = createGroup(platform, authOf(platform, admin.id), { displayName: 'Groupe Nseya', currency: 'GBP' });
  groupId = group.id;
  attachCompany(platform, authOf(platform, admin.id), groupId, { tenantId: holdingId, code: 'NSY' });
  grantGroupRole(platform, authOf(platform, admin.id), groupId, { email: admin.email, role: 'GROUP_ADMIN' });
  grantGroupRole(platform, authOf(platform, admin.id), groupId, { email: finance.email, role: 'GROUP_FINANCE' });

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetIdempotency();
});

after(() => server.close());

describe('§9.3 — the company and the group are told as AI spend approaches its limit', () => {
  it('names the company’s administrators and the group’s finance, each once', () => {
    const recipients = usageAlertRecipients(platform, holdingId);
    assert.deepEqual(
      recipients.map((r) => [r.email, r.because]).sort(),
      [
        ['amara@nseya.example', 'GROUP_FINANCE'],
        ['justin@nseya.example', 'COMPANY_ADMIN'],
      ],
      'the administrator is told once although they also hold a group role',
    );
  });

  it('records each threshold on the chain and tells them, once per threshold', async () => {
    const wallet = platform.wallet(holdingId);
    assert.equal(wallet.snapshot().availableMinor, Math.round(PACKAGES.CORE_PROJECT.monthlyPriceMinor * 0.2), 'the allowance of the paid month, and nothing else');
    platform.setAcuCapsFor(holdingId, admin.id, { monthlyMinor: 10_000 }, 'A hard limit for the test');

    // 1,000 raw at 5× is 5,000 billed — half the limit.
    const first = wallet.reserve({ aiRequestId: 'run-1', estimatedRawCostMinor: 1_000 });
    wallet.settle(first.holdId, 1_000, 'OPENAI');
    // 600 raw is 3,000 billed — 8,000 of 10,000.
    const second = wallet.reserve({ aiRequestId: 'run-2', estimatedRawCostMinor: 600 });
    wallet.settle(second.holdId, 600, 'OPENAI');
    await settle();

    const raised = platform.ledger.events().filter((event) => event.tenantId === holdingId && event.eventType === 'ACU_ALERT_RAISED');
    assert.equal(raised.length, 2, 'fifty and eighty per cent, each once');
    const told = deliveries(platform, holdingId).filter((delivery) => delivery.code === 'acu.threshold');
    assert.ok(told.length >= 2, `nobody was told: ${JSON.stringify(told)}`);
    const recipients = new Set(told.map((delivery) => delivery.recipientId));
    assert.ok(recipients.has(admin.id), 'the administrator was not told');
    assert.ok(recipients.has(finance.id), 'group finance was not told');
  });

  it('stops AI at the limit, says so once, and leaves everything else alone', async () => {
    const wallet = platform.wallet(holdingId);
    // 1,000 raw would be 5,000 billed: 13,000 against a limit of 10,000.
    assert.throws(() => wallet.reserve({ aiRequestId: 'run-3', estimatedRawCostMinor: 1_000 }), (error: { code?: string }) => error.code === 'ACU_EXHAUSTED');
    assert.throws(() => wallet.reserve({ aiRequestId: 'run-4', estimatedRawCostMinor: 1_000 }), (error: { code?: string }) => error.code === 'ACU_EXHAUSTED');
    await settle();

    const breached = platform.ledger.events().filter((event) => event.tenantId === holdingId && event.eventType === 'ACU_CAP_BREACHED');
    assert.equal(breached.length, 1, 'the limit reached is said once per month, however many requests it refuses');
    const told = deliveries(platform, holdingId).filter((delivery) => delivery.code === 'acu.limit_reached');
    assert.ok(told.length >= 1, 'nobody was told the limit was reached');

    // Non-AI functionality continues: the record is still written to.
    const token = tokenFor(admin);
    const enterprise = platform.ledger.listByTenant(holdingId, 'Enterprise')[0]!;
    const created = await call('POST', '/v1/portfolios', token, { name: 'Still working', enterpriseId: enterprise.refId, governanceModel: 'CENTRALISED', continentCode: 'EU', countryCode: 'GB' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
  });
});

describe('§6 — least privilege: a viewer, and a viewer by default', () => {
  let civilsId: string;
  let kemi: PlatformUser;

  before(() => {
    const added = addCompany(platform, authOf(platform, admin.id), groupId, {
      displayName: 'Nseya Civils Ltd',
      jurisdiction: 'GB',
      currency: 'GBP',
      package: 'CORE_PROJECT',
      administrators: [{ name: 'Kemi Adeyemi', email: 'kemi@nseya.example' }],
    });
    civilsId = added.company.tenantId;
    kemi = platform.user(added.administrators[0]!.id);
  });

  it('reads the company’s record and changes nothing — never the money, the AI or the platform', () => {
    const viewer = PERMISSION_MATRIX.VIEWER;
    assert.ok(Object.keys(viewer).length >= 20, 'a viewer sees the whole record');
    for (const [area, codes] of Object.entries(viewer)) {
      assert.deepEqual(codes, ['R'], `${area} is not read-only for a viewer`);
    }
    assert.equal(viewer.PLATFORM_ADMINISTRATION, undefined);
    assert.equal(viewer.AI_EXECUTION, undefined);
    assert.equal(viewer.BILLING_ACU, undefined);
    assert.ok(TENANT_GRANTABLE_ROLES.includes('VIEWER'), 'an administrator cannot grant it');
    assert.ok(seatForRole('VIEWER'), 'a viewer is a licensed person and takes a priced seat');
  });

  it('is what a membership holds when nothing is named', async () => {
    // Justin, administrator of the holding company, joins Civils with no roles
    // named: he is a viewer there until Kemi says otherwise.
    const membership = addMembership(platform, authOf(platform, kemi.id), { email: admin.email });
    assert.deepEqual(membership.roles, ['VIEWER']);
    assert.equal(membership.tenantId, civilsId);

    // And through the door the console uses, for the finance person.
    const reply = await call('POST', '/v1/users/memberships', tokenFor(kemi), { email: finance.email });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.deepEqual(reply.body.roles, ['VIEWER']);
  });
});

describe('§9.4 — rate cards are approved pricing, and they price the subscription', () => {
  let discountedId: string;

  it('is a term of the agreement the group approves, bounded to a whole percentage', async () => {
    const bad = await call('PUT', `/v1/admin/groups/${groupId}/agreement`, tokenFor(operator), {
      mode: 'INTERNAL_COST_ALLOCATION',
      seller: { legalName: 'CONSTRUX', tenantId: 'platform' },
      payer: { legalName: 'Nseya Holdings Ltd', tenantId: holdingId },
      rateCards: { GROUP_INTERNAL: { discountPercent: 120 } },
    });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));

    const draft = await call('PUT', `/v1/admin/groups/${groupId}/agreement`, tokenFor(operator), {
      mode: 'INTERNAL_COST_ALLOCATION',
      seller: { legalName: 'CONSTRUX', tenantId: 'platform' },
      payer: { legalName: 'Nseya Holdings Ltd', tenantId: holdingId },
      rateCards: { GROUP_INTERNAL: { discountPercent: 25 } },
    });
    assert.equal(draft.status, 200, JSON.stringify(draft.body));
    const version = draft.body.versions.at(-1);
    assert.deepEqual(version.rateCards, { GROUP_INTERNAL: { discountPercent: 25 }, ENTERPRISE_GROUP: { discountPercent: 0 }, RETAIL: { discountPercent: 0 } });

    // Not in force until the group approves it: the holding company still pays list.
    assert.equal(subscriptionPriceMinor(platform, holdingId, PACKAGES.CORE_PROJECT.monthlyPriceMinor).discountPercent, 0);
    approveAgreement(platform, authOf(platform, admin.id), groupId, version.version);
    const priced = subscriptionPriceMinor(platform, holdingId, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(priced.rateCard, 'GROUP_INTERNAL');
    assert.equal(priced.discountPercent, 25);
    assert.equal(priced.amountMinor, Math.floor(PACKAGES.CORE_PROJECT.monthlyPriceMinor * 0.75));
  });

  it('prices a new company’s first month, its allowance and the statement through the card', () => {
    const added = addCompany(platform, authOf(platform, admin.id), groupId, {
      displayName: 'Nseya Homes Ltd',
      jurisdiction: 'GB',
      currency: 'GBP',
      package: 'CORE_PROJECT',
      administrators: [{ name: 'Rowan Blake', email: 'rowan@nseyahomes.example' }],
    });
    discountedId = added.company.tenantId;
    const expected = Math.floor(PACKAGES.CORE_PROJECT.monthlyPriceMinor * 0.75);
    assert.ok(added.openingCharge, 'no first month was charged');
    assert.equal(added.openingCharge.amountMinor, expected, 'the first month is at the group’s approved price, not the list price');

    platform.recordSubscriptionPayment({ tenantId: discountedId, chargeId: added.openingCharge.id, method: 'BANK_TRANSFER', reference: 'BACS-HOMES-1', recordedBy: operator.id });
    assert.equal(platform.subscription(discountedId).status, 'ACTIVE');
    assert.equal(platform.wallet(discountedId).snapshot().balanceMinor, Math.round(expected * 0.2), 'twenty per cent of what was paid, not of the list price');

    const month = new Date().toISOString().slice(0, 7);
    const section = groupStatement(platform, groupId, month).sections.find((entry) => entry.tenantId === discountedId)!;
    assert.equal(section.plan.listPriceMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(section.plan.chargedMinor, expected);
  });

  it('charges list price on a card the agreement leaves undiscounted', () => {
    setCostCentre(platform, authOf(platform, operator.id), groupId, discountedId, { rateCard: 'RETAIL' });
    const priced = subscriptionPriceMinor(platform, discountedId, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(priced.rateCard, 'RETAIL');
    assert.equal(priced.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
  });
});

describe('Enterprise / Group v1.0 §9.3 — past_due is a state the customer is shown', () => {
  const charge = (over: Partial<collection.SubscriptionCharge>): collection.SubscriptionCharge => ({
    id: 'c1',
    tenantId: 't',
    subscriptionId: 's',
    package: 'CORE_PROJECT',
    amountMinor: 95_000,
    currency: 'GBP',
    periodStart: '2026-09-01T00:00:00.000Z',
    dueAt: '2026-09-01T00:00:00.000Z',
    graceEndsAt: '2026-09-15T00:00:00.000Z',
    status: 'DUE',
    raisedAt: '2026-09-01T00:00:00.000Z',
    attempts: [],
    ...over,
  });

  it('is the oldest period due and unpaid while its grace runs, with the day the platform stops', () => {
    const now = new Date('2026-09-04T12:00:00.000Z');
    assert.equal(collection.pastDue([charge({ dueAt: '2026-09-10T00:00:00.000Z' })], now), null, 'not yet due is not past due');
    assert.equal(collection.pastDue([charge({ graceEndsAt: '2026-09-03T00:00:00.000Z' })], now), null, 'past its grace is a suspension, not a warning');
    assert.equal(collection.pastDue([charge({ status: 'SETTLED' })], now), null);
    const late = collection.pastDue([charge({ id: 'newer', dueAt: '2026-09-03T00:00:00.000Z' }), charge({ id: 'older' })], now);
    assert.equal(late?.chargeId, 'older');
    assert.equal(late?.daysLate, 3);
    assert.equal(late?.graceEndsAt, '2026-09-15T00:00:00.000Z');
  });

  it('is on the customer’s subscription view', async () => {
    const view = await call('GET', '/v1/billing/subscription', tokenFor(admin));
    assert.equal(view.status, 200);
    assert.equal(view.body.pastDue, null, 'the holding company has paid its month');
    assert.equal(view.body.subscription.status, 'ACTIVE');
  });
});

describe('Enterprise / Group v1.0 §7 — an entitlement is scheduled, active, expired or revoked', () => {
  let civilsId: string;
  before(() => {
    const group = platform.ledger.get({ refType: 'Group', refId: groupId })!.state as unknown as { costCentres: Array<{ tenantId: string; code: string }> };
    civilsId = group.costCentres.find((centre) => centre.code !== 'NSY')!.tenantId;
  });

  it('holds nothing before it starts, everything while it runs, and nothing once it has expired', async () => {
    const token = tokenFor(operator);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const nextWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();

    const scheduled = await call('POST', `/v1/admin/tenants/${civilsId}/modules/ETABLIX`, token, { status: 'ACTIVE', reason: 'Contract starts tomorrow', validFrom: tomorrow, validTo: nextWeek });
    assert.equal(scheduled.status, 201, JSON.stringify(scheduled.body));
    assert.equal(scheduled.body.lifecycle, 'SCHEDULED');
    assert.deepEqual(platform.grantedModules(civilsId), [], 'a scheduled entitlement grants nothing yet');
    assert.deepEqual(platform.grantedModules(civilsId, new Date(Date.now() + 2 * 86_400_000).toISOString()), ['ETABLIX'], 'and everything once its day comes');
    assert.deepEqual(platform.grantedModules(civilsId, new Date(Date.now() + 8 * 86_400_000).toISOString()), [], 'and nothing again once it has expired');

    const directory = await call('GET', `/v1/groups/${groupId}/companies/${civilsId}/entitlements`, tokenFor(admin));
    assert.equal(directory.status, 200, JSON.stringify(directory.body));
    assert.deepEqual(directory.body.modules, []);
    assert.equal(directory.body.pendingModules[0].moduleKey, 'ETABLIX');
    assert.equal(directory.body.pendingModules[0].lifecycle, 'SCHEDULED');

    const backwards = await call('POST', `/v1/admin/tenants/${civilsId}/modules/ETABLIX`, token, { status: 'ACTIVE', reason: 'Ends before it starts', validFrom: nextWeek, validTo: tomorrow });
    assert.equal(backwards.status, 422);
    assert.equal(backwards.body.title, 'MODULE_DATES_INVALID');

    const now = await call('POST', `/v1/admin/tenants/${civilsId}/modules/ETABLIX`, token, { status: 'ACTIVE', reason: 'Brought forward: starts today' });
    assert.equal(now.body.lifecycle, 'ACTIVE');
    assert.deepEqual(platform.grantedModules(civilsId), ['ETABLIX']);
  });
});

describe('Enterprise / Group v1.0 §10.1 — group money funds company wallets by explicit allocation', () => {
  let companies: Array<{ tenantId: string; code: string }>;
  before(() => {
    const group = platform.ledger.get({ refType: 'Group', refId: groupId })!.state as unknown as { costCentres: Array<{ tenantId: string; code: string }> };
    companies = group.costCentres;
  });

  it('credits each company exactly what was allocated, under the group’s reference, once', async () => {
    const token = tokenFor(operator);
    const [first, second] = companies;
    const before = companies.map((c) => platform.wallet(c.tenantId).snapshot().availableMinor);
    const recorded = await call('POST', `/v1/admin/groups/${groupId}/credit`, token, {
      amountMinor: 50_000,
      method: 'BANK_TRANSFER',
      reference: 'BACS-GROUP-2026-09',
      allocations: [
        { tenantId: first!.tenantId, amountMinor: 30_000 },
        { tenantId: second!.tenantId, amountMinor: 20_000 },
      ],
    });
    assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
    assert.equal(recorded.body.alreadyRecorded, false);
    assert.equal(platform.wallet(first!.tenantId).snapshot().availableMinor, before[0]! + 30_000);
    assert.equal(platform.wallet(second!.tenantId).snapshot().availableMinor, before[1]! + 20_000);
    const receipts = platform.paymentReceipts(first!.tenantId);
    assert.ok(receipts.some((receipt) => receipt.reference === `BACS-GROUP-2026-09/${first!.code}`), 'the company’s receipt carries the group reference and its cost centre');

    const again = await call('POST', `/v1/admin/groups/${groupId}/credit`, token, {
      amountMinor: 50_000,
      method: 'BANK_TRANSFER',
      reference: 'BACS-GROUP-2026-09',
      allocations: [{ tenantId: first!.tenantId, amountMinor: 50_000 }],
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.alreadyRecorded, true, 'the same reference again is the same purchase, whatever the body says');
    assert.equal(platform.wallet(first!.tenantId).snapshot().availableMinor, before[0]! + 30_000, 'nothing was credited twice');
  });

  it('refuses allocations that do not total the purchase, and moves nothing', async () => {
    const token = tokenFor(operator);
    const [first, second] = companies;
    const before = platform.wallet(first!.tenantId).snapshot().availableMinor;
    const short = await call('POST', `/v1/admin/groups/${groupId}/credit`, token, {
      amountMinor: 50_000,
      method: 'BANK_TRANSFER',
      reference: 'BACS-GROUP-SHORT',
      allocations: [{ tenantId: first!.tenantId, amountMinor: 20_000 }, { tenantId: second!.tenantId, amountMinor: 20_000 }],
    });
    assert.equal(short.status, 422, JSON.stringify(short.body));
    assert.equal(short.body.title, 'ALLOCATIONS_MUST_TOTAL');
    assert.equal(platform.wallet(first!.tenantId).snapshot().availableMinor, before);

    const outsider = platform.createTenant({ legalName: 'Unrelated Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', enterpriseName: 'Unrelated', trialGrant: false });
    const foreign = await call('POST', `/v1/admin/groups/${groupId}/credit`, token, {
      amountMinor: 1_000,
      method: 'BANK_TRANSFER',
      reference: 'BACS-GROUP-FOREIGN',
      allocations: [{ tenantId: outsider.tenant.id, amountMinor: 1_000 }],
    });
    assert.equal(foreign.status, 422);
    assert.equal(foreign.body.title, 'ALLOCATION_NOT_IN_GROUP');
    assert.equal(platform.wallet(outsider.tenant.id).snapshot().availableMinor, 0, 'group money never reaches a company outside the group');
  });
});
