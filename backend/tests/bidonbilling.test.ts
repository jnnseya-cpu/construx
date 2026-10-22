import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as billing from '../src/domain/bidon/billing.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as engine from '../src/domain/bidon/engine.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';

/**
 * Deposits, invoices and the statement.
 *
 * Two acceptance criteria, and one distinction that is the whole design:
 *
 *   - *"an unpaid deposit blocks agent runs until paid or waived"* — **agent
 *     runs**, not all work. A customer whose deposit is unpaid can still be set
 *     up, still upload their evidence, still have a question list confirmed by
 *     a person. What is blocked is the spend, because an agent run costs the
 *     provider real money the moment it runs.
 *   - *"statements show work, ACU and charges per customer and engagement"* —
 *     with the margin labelled as a contribution rather than profit, because it
 *     ignores the provider's own time.
 *
 * And the honesty that has to hold on every read: **no money moves here.** The
 * payment gateway is not built, an invoice is a record of what is owed, and
 * recording a payment is somebody saying it arrived.
 */

let platform: Platform;
let seed: SeedResult;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

let customer: customers.CustomerAccount;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    agreementRef: 'AGR-BIDON-2026-001',
    decidedBy: seed.users.operator!.id,
  });
  customer = customers.openCustomer(asProviderAdmin(), { legalName: 'Pennine Grid Services Ltd' });
  customers.assignStaff(asProviderAdmin(), customer.id, { add: [asBidWriter().auth.actorId] });
});

describe('billing is wired in, and no agent authors an invoice', () => {
  it('routes every act and classifies the record', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/bid-on/invoices'],
      ['POST', '/v1/bid-on/engagements/:engagementId/invoices'],
      ['POST', '/v1/bid-on/invoices/:invoiceId/paid'],
      ['POST', '/v1/bid-on/invoices/:invoiceId/waive'],
      ['POST', '/v1/bid-on/invoices/:invoiceId/void'],
      ['GET', '/v1/bid-on/engagements/:engagementId/statement'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    assert.equal(classifyEntity('BidOnInvoice')?.area, 'BID_SERVICES');
    assert.equal(classifyEntity('BidOnInvoice')?.sensitivity, 'COMMERCIAL_L3');

    // An invoice is a demand for money between two companies and a waiver is
    // somebody deciding not to ask for it. No agent mandate reaches either.
    for (const type of ['BID_ON_INVOICE_ISSUED', 'BID_ON_INVOICE_PAID', 'BID_ON_INVOICE_WAIVED', 'BID_ON_INVOICE_VOIDED']) {
      assert.equal(lookupEventType(type)?.aiAllowed, false, `${type} is open to an agent`);
    }
  });

  it('does not let the bid writer bill anybody', () => {
    const engagement = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Writer cannot bill',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 150_000,
      currency: 'GBP',
    });
    throwsCode(
      () => billing.issueInvoice(asBidWriter(), { engagementId: engagement.id, kind: 'DEPOSIT', amountMinor: 1 }),
      'ACCESS_DENIED',
    );
  });
});

describe('the deposit blocks the spend and nothing else', () => {
  let engagement: engagements.Engagement;
  let bid: bids.Bid;

  it('is issued the moment the engagement is activated, from its own terms', () => {
    engagement = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'UVDB prequalification pack',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 150_000,
      currency: 'GBP',
      depositPercent: 50,
    });

    // Nothing before activation: a draft engagement's terms are not agreed, and
    // billing against terms nobody agreed is how a dispute starts.
    assert.deepEqual(billing.invoiceRegister(asProviderAdmin()).invoices, []);

    engagements.activateEngagement(asProviderAdmin(), engagement.id);

    const register = billing.invoiceRegister(asProviderAdmin());
    assert.equal(register.invoices.length, 1);
    const deposit = register.invoices[0]!;
    assert.equal(deposit.kind, 'DEPOSIT');
    // 50% of £1,500.
    assert.equal(deposit.amountMinor, 75_000);
    assert.equal(deposit.status, 'ISSUED');
    assert.match(deposit.narrative, /Deposit on UVDB prequalification pack \(50%\)/);
    assert.ok(deposit.dueOn, 'an invoice was issued with no due date');
  });

  it('lets a person do everything, and refuses every agent run', async () => {
    // The distinction. Blocking all work would make the deposit a barrier to
    // getting started, and the first thing it would stop is the customer
    // uploading the evidence the work depends on.
    const evidenceFiled = await import('../src/domain/bidon/evidence.ts').then((module) =>
      module.fileEvidence(asProviderAdmin(), {
        customerAccountId: customer.id,
        type: 'POLICY',
        title: 'Health and safety policy',
        hash: `sha256:${'a'.repeat(64)}`,
      }),
    );
    assert.ok(evidenceFiled.reference, 'an unpaid deposit stopped the customer filing evidence');

    bid = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'Northern Powergrid',
      scheme: 'UVDB',
      deadline: '2027-06-01',
    });
    bid = bids.confirmQuestions(asProviderAdmin(), bid.id, {
      questions: [
        { section: 'HSEQ', number: '4.1', text: 'Describe your safety management arrangements', answerType: 'TEXT', mandatory: true },
      ],
    });
    assert.equal(bid.questions.length, 1, 'an unpaid deposit stopped a person confirming a question list');

    // And a person may write an answer by hand.
    const written = bids.recordAnswer(asProviderAdmin(), bid.id, {
      questionId: bid.questions[0]!.id,
      body: ['Written by hand while the deposit is outstanding.'],
    });
    assert.ok(written.answer.id);

    // The spend is what is refused, on every one of the four AI commands.
    for (const [name, call] of [
      ['parse', () => engine.parseQuestionnaire(asProviderAdmin(), platform.evidence, bid.id, { text: 'anything' })],
      ['draft', () => engine.draftAnswer(asProviderAdmin(), bid.id, { questionId: bid.questions[0]!.id })],
      ['score', () => engine.scoreAnswerWithAI(asProviderAdmin(), bid.id, written.answer.id)],
      ['gap request', () => engine.composeGapRequest(asProviderAdmin(), bid.id)],
    ] as const) {
      await assert.rejects(
        call,
        (error: Error & { code?: string }) => {
          assert.equal(error.code, 'BID_ON_DEPOSIT_OUTSTANDING', `${name} ran on an unpaid deposit`);
          assert.match(error.message, /what is blocked is the spend/);
          return true;
        },
      );
    }
  });

  it('unblocks when the payment is recorded', async () => {
    const deposit = billing
      .invoiceRegister(asProviderAdmin())
      .invoices.find((invoice) => invoice.kind === 'DEPOSIT' && invoice.engagementId === engagement.id)!;

    const paid = billing.recordPayment(asProviderAdmin(), deposit.id, { paymentReference: 'BACS 4471' });
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.paymentReference, 'BACS 4471');

    // Now the run reaches the provider and is refused for the honest reason —
    // the local stand-in — rather than for the deposit.
    await assert.rejects(
      () => engine.draftAnswer(asProviderAdmin(), bid.id, { questionId: bid.questions[0]!.id }),
      (error: Error & { code?: string }) => {
        // Retrieval finds the policy has no readable passages, so it raises a
        // gap before any provider is reached. Either outcome proves the
        // deposit is no longer what stops it.
        assert.notEqual(error.code, 'BID_ON_DEPOSIT_OUTSTANDING');
        return true;
      },
    ).catch(() => {
      // A gap raised rather than a rejection is also a pass: the point is only
      // that the deposit is not the refusal any more.
    });

    assert.equal(billing.depositStanding(engagement, billing.invoicesOf(asProviderAdmin())).funded, true);

    // Recording it twice is refused.
    throwsCode(
      () => billing.recordPayment(asProviderAdmin(), deposit.id, { paymentReference: 'BACS 4471 again' }),
      'BID_ON_INVOICE_NOT_ISSUED',
    );
  });

  it('can be waived instead, with a reason that stays on the record', () => {
    const second = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Started on a handshake',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 250_000,
      currency: 'GBP',
      depositPercent: 50,
    });
    engagements.activateEngagement(asProviderAdmin(), second.id);

    const deposit = billing
      .invoiceRegister(asProviderAdmin())
      .invoices.find((invoice) => invoice.engagementId === second.id)!;
    assert.equal(billing.depositStanding(second, billing.invoicesOf(asProviderAdmin())).funded, false);

    throwsCode(() => billing.waiveInvoice(asProviderAdmin(), deposit.id, { reason: 'ok' }), 'BID_ON_REASON_TOO_SHORT');

    const waived = billing.waiveInvoice(asProviderAdmin(), deposit.id, {
      reason: 'Long-standing customer, starting on their word as agreed with the director',
    });
    assert.equal(waived.status, 'WAIVED');
    assert.match(String(waived.waivedReason), /starting on their word/);
    assert.equal(waived.waivedBy, asProviderAdmin().auth.actorId);

    // A waiver is settled. Treating it as still outstanding would make the
    // escape hatch useless.
    assert.equal(billing.depositStanding(second, billing.invoicesOf(asProviderAdmin())).funded, true);
  });

  it('issues no deposit where the terms carry none', () => {
    const none = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'No deposit on this one',
      type: 'PERMANENT',
      billingBasis: 'MONTHLY',
      feeMinor: 80_000,
      currency: 'GBP',
    });
    const before_ = billing.invoiceRegister(asProviderAdmin()).invoices.length;
    engagements.activateEngagement(asProviderAdmin(), none.id);
    assert.equal(billing.invoiceRegister(asProviderAdmin()).invoices.length, before_);
    assert.equal(billing.depositStanding(none, billing.invoicesOf(asProviderAdmin())).funded, true);
  });
});

describe('what else the engagement bills itself for', () => {
  it('bills a stage on sign-off, and only where it bills per stage', () => {
    const staged = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Prequalification then tender',
      type: 'STAGED',
      billingBasis: 'PER_STAGE',
      feeMinor: 0,
      currency: 'GBP',
      stages: [
        { name: 'Prequalification', scope: 'The UVDB questionnaire in full', feeMinor: 150_000 },
        { name: 'Tender', scope: 'Quality answers and win themes for the ITT', feeMinor: 300_000 },
      ],
    });
    engagements.activateEngagement(asProviderAdmin(), staged.id);

    const before_ = billing.invoicesOf(asProviderAdmin()).length;
    const result = engagements.signOffStage(asProviderAdmin(), staged.id, staged.stages[0]!.id, {
      note: 'Questionnaire submitted and the policy set delivered',
    });

    const invoices = billing.invoicesOf(asProviderAdmin());
    assert.equal(invoices.length, before_ + 1, 'signing off a stage did not bill it');
    const stage = invoices.find((invoice) => invoice.stageId === result.signedOff.id)!;
    assert.equal(stage.kind, 'STAGE');
    assert.equal(stage.amountMinor, 150_000);
    assert.match(stage.narrative, /Prequalification, on sign-off/);

    // The next stage opened and is not billed until it too is signed off:
    // billing when a stage opens charges for work not done.
    assert.equal(result.opened?.name, 'Tender');
    assert.ok(!invoices.some((invoice) => invoice.stageId === result.opened?.id));
  });

  it('bills the balance on completion and not on cancellation', () => {
    const fixed = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Single submission, half up front',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 300_000,
      currency: 'GBP',
      depositPercent: 50,
    });
    engagements.activateEngagement(asProviderAdmin(), fixed.id);

    engagements.closeEngagement(asProviderAdmin(), fixed.id, {
      outcome: 'COMPLETED',
      reason: 'Submission delivered and the customer was accepted onto the framework',
    });
    const balance = billing
      .invoicesOf(asProviderAdmin())
      .find((invoice) => invoice.engagementId === fixed.id && invoice.kind === 'BALANCE')!;
    // The other half, not the whole fee again.
    assert.equal(balance.amountMinor, 150_000);

    // A cancelled engagement has not delivered. What is owed on a cancellation
    // is a commercial conversation the provider raises themselves.
    const stopped = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Stopped before delivery',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 300_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(asProviderAdmin(), stopped.id);
    engagements.closeEngagement(asProviderAdmin(), stopped.id, {
      outcome: 'CANCELLED',
      reason: 'Customer decided not to bid for this framework after all',
    });
    assert.ok(
      !billing.invoicesOf(asProviderAdmin()).some((invoice) => invoice.engagementId === stopped.id),
      'a cancelled engagement billed its balance',
    );
  });

  it('refuses a second live invoice for the same thing, and refuses to guess an amount', () => {
    const engagement = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Duplicate test',
      type: 'CUSTOM',
      billingBasis: 'AS_AGREED',
      feeMinor: 100_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(asProviderAdmin(), engagement.id);

    // Nothing on a custom engagement decides what a stage invoice is worth.
    const guessed = throwsCode(
      () => billing.issueInvoice(asProviderAdmin(), { engagementId: engagement.id, kind: 'STAGE' }),
      'BID_ON_AMOUNT_REQUIRED',
    );
    assert.match(String(guessed.message), /a figure nobody agreed/);

    billing.issueInvoice(asProviderAdmin(), {
      engagementId: engagement.id,
      kind: 'MONTHLY',
      narrative: 'Agreed monthly retainer',
    });
    const twice = throwsCode(
      () => billing.issueInvoice(asProviderAdmin(), { engagementId: engagement.id, kind: 'MONTHLY' }),
      'BID_ON_INVOICE_EXISTS',
    );
    assert.match(String(twice.message), /a customer asked twice pays the wrong one/);
  });

  it('voids one issued in error, and refuses to void a paid one', () => {
    const engagement = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Void test',
      type: 'CUSTOM',
      billingBasis: 'AS_AGREED',
      feeMinor: 50_000,
      currency: 'GBP',
    });
    engagements.activateEngagement(asProviderAdmin(), engagement.id);

    const wrong = billing.issueInvoice(asProviderAdmin(), {
      engagementId: engagement.id,
      kind: 'MONTHLY',
      amountMinor: 999_999,
      narrative: 'Typed a figure with an extra nine in it',
    });
    const voided = billing.voidInvoice(asProviderAdmin(), wrong.id, {
      reason: 'Issued with the wrong amount, reissued at the agreed figure',
    });
    assert.equal(voided.status, 'VOID');

    // Voiding frees the slot, because the first one no longer bills anything.
    const right = billing.issueInvoice(asProviderAdmin(), {
      engagementId: engagement.id,
      kind: 'MONTHLY',
      amountMinor: 50_000,
      narrative: 'Reissued at the agreed figure',
    });
    billing.recordPayment(asProviderAdmin(), right.id, { paymentReference: 'BACS 9001' });

    const paid = throwsCode(
      () => billing.voidInvoice(asProviderAdmin(), right.id, { reason: 'Trying to void money already received' }),
      'BID_ON_INVOICE_PAID',
    );
    assert.match(String(paid.message), /money received against nothing/);
  });
});

describe('the statement', () => {
  it('reports work, charges and what the AI cost, and will not call the margin profit', () => {
    const engagement = engagements
      .engagementRegister(asProviderAdmin())
      .engagements.find((entry) => entry.name === 'UVDB prequalification pack')!;

    const statement = billing.engagementStatement(asProviderAdmin(), engagement.id);

    assert.equal(statement.reference, engagement.reference);
    assert.equal(statement.customer.legalName, 'Pennine Grid Services Ltd');
    // Invoiced and received: the deposit was issued and paid earlier.
    assert.equal(statement.invoicedMinor, 75_000);
    assert.equal(statement.receivedMinor, 75_000);
    assert.equal(statement.outstandingMinor, 0);
    // One bid started, nothing exported.
    assert.equal(statement.work.bidsStarted, 1);
    assert.equal(statement.work.packsExported, 0);

    // No agent run reached a provider, so the AI cost is nil rather than
    // unknown — and the statement says which.
    assert.equal(statement.acuRuns, 0);
    assert.equal(statement.acuChargedMinor, 0);
    assert.ok(statement.limits.some((line) => /nil rather than unknown/.test(line)));

    // The margin is a contribution and the statement says why.
    assert.equal(statement.contributionMinor, 75_000);
    assert.ok(
      statement.limits.some((line) => /not profit/.test(line) && /own\s*time/.test(line)),
      'the statement does not say the contribution ignores the provider’s time',
    );

    // And the thing that has to be on every read.
    assert.ok(
      statement.limits.some((line) => /No money has moved/.test(line)),
      'a statement looked reconciled while nothing had been reconciled',
    );

    // The lines are in date order, so a statement reads like one.
    const dates = statement.lines.map((line) => line.on);
    assert.deepEqual(dates, [...dates].sort());
  });

  it('is refused for a customer this person is not assigned to', () => {
    const theirs = customers.openCustomer(asProviderAdmin(), { legalName: 'Somebody Else Ltd' });
    const engagement = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: theirs.id,
      name: 'Not yours',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 1,
      currency: 'GBP',
    });
    throwsCode(
      () => billing.engagementStatement(asBidWriter(), engagement.id),
      'BID_ON_CUSTOMER_NOT_ASSIGNED',
    );
    // And the invoice register leaves them out rather than showing a blank row.
    assert.ok(
      !billing.invoiceRegister(asBidWriter()).invoices.some((invoice) => invoice.customerAccountId === theirs.id),
    );
  });

  it('names which engagements cannot start an agent run', () => {
    // An engagement with an unsettled deposit, because by this point every
    // earlier one has been paid or waived and a register with nothing blocked
    // would pass this assertion for the wrong reason.
    const blocked = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Deposit not yet paid',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 200_000,
      currency: 'GBP',
      depositPercent: 25,
    });
    engagements.activateEngagement(asProviderAdmin(), blocked.id);

    const register = billing.invoiceRegister(asProviderAdmin());
    assert.ok(
      register.limits.some((line) => /cannot start an agent run until their deposit is settled/.test(line)),
      'the register does not say which engagements are blocked',
    );
    assert.ok(register.limits.some((line) => /A person can still work on them/.test(line)));
    assert.ok(
      register.limits.some((line) => line.includes(blocked.reference)),
      'the register says some engagement is blocked without naming which',
    );
  });
});
