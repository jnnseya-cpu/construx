import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as cost from '../src/engines/cost.ts';
import * as integrator from '../src/domain/integrator.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Running an integrated appointment without a finance team.
 *
 * A business taking every site service under one contract pays fifteen
 * suppliers monthly and is paid by one client monthly, and nothing synchronises
 * those two facts. What decides whether it survives is not the contract value
 * but whether there is money in the account on the day the suppliers are due.
 *
 * Two controls, and these tests are about whether they actually bite: that the
 * price is defensible in parts rather than as one percentage, and that
 * contingency cannot quietly become profit.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const qs = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
const director = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
const pm = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

/** A fresh project, so one test's account is not another's. */
async function estate(): Promise<{ platform: Platform; seed: SeedResult; projectId: string }> {
  const fresh = new Platform();
  const freshSeed = await seedDemoProject(fresh);
  const project = fresh.ledger
    .listByTenant(freshSeed.tenantId, 'Project')
    .map((record) => record.state)
    .find((p) => p.phase === 'TENDER') as { id: string } | undefined;
  assert.ok(project);
  return { platform: fresh, seed: freshSeed, projectId: project.id };
}

/**
 * A fresh project that is actually paying somebody.
 *
 * Cover in days is only meaningful once money is leaving, and the outflow side
 * is measured from certificates issued down the chain — so a test about the
 * reserve has to certify a subcontract payment or it is testing the
 * unmeasured branch again. Returns the amount certified, because every
 * assertion below is against it.
 */
async function payingEstate(): Promise<{
  platform: Platform;
  seed: SeedResult;
  projectId: string;
  certifiedDownstreamMinor: number;
}> {
  const fresh = new Platform();
  const freshSeed = await seedDemoProject(fresh);
  const projectId = freshSeed.projectId;
  const asQs = fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
  const subcontract = fresh.ledger.list(projectId, 'Subcontract')[0];
  assert.ok(subcontract, 'the seed no longer carries a subcontract to certify against');

  const certifiedDownstreamMinor = 300_000_000;
  const cycle = cost.generatePaymentSchedule(asQs, {
    contractId: subcontract.refId,
    startDate: '2026-07-01',
    cycles: 6,
    direction: 'DOWNSTREAM',
    terms: { applicationDayOfMonth: 25, paymentNoticeDays: 5, payLessNoticeDaysBeforeFinal: 7, finalDateDays: 30 },
  });
  const application = cost.submitApplication(asQs, {
    cycleId: cycle.cycleId,
    cycleNumber: 1,
    grossValuationMinor: certifiedDownstreamMinor,
    variationsIncludedMinor: 0,
    previouslyCertifiedMinor: 0,
    retentionMinor: 0,
    supportingEvidenceHash: hashEvidence('integrator-subcontract-application'),
  });
  cost.certifyApplication(fresh.context(freshSeed.users.owner!.auth, projectId, { source: 'WEB' }), {
    applicationId: application.applicationId,
    certifiedMinor: application.netAppliedMinor,
    retentionMinor: 0,
    issuedDate: '2026-07-30',
    certificateHash: hashEvidence('integrator-subcontract-certificate'),
  });

  return { platform: fresh, seed: freshSeed, projectId, certifiedDownstreamMinor };
}

// ── The build-up ────────────────────────────────────────────────────────────

describe('the price is defensible in parts, not as one percentage', () => {
  it('names every component separately and adds up to the contract price', () => {
    // The document's own worked example: £1,000,000 of supplier cost.
    const price = integrator.quoteIntegration(qs(), 1_000_000_00);

    assert.deepEqual(
      price.components.map((component) => component.label),
      [
        'Contingency',
        'Project management and supplier integration',
        'Corporate overhead recovery',
        'Profit and principal-contractor risk',
      ],
    );

    // Each part carries a sentence it would be defended in. A component with no
    // basis is the single "overhead" figure again, with more rows.
    for (const component of price.components) {
      assert.ok(component.basis.length > 40, `${component.label} gives a client nothing to argue with`);
    }

    const summed = price.components.reduce((total, component) => total + component.amountMinor, 0);
    assert.equal(price.additionMinor, summed);
    assert.equal(price.contractPriceMinor, price.directSupplierCostMinor + summed);
  });

  it('keeps contingency out of the margin figure', () => {
    // The whole point. A business that counts unused contingency as margin has
    // mispriced every job after the first one.
    const price = integrator.quoteIntegration(qs(), 1_000_000_00);
    assert.equal(price.marginMinor, price.additionMinor - price.contingencyMinor);
    assert.ok(price.marginMinor < price.additionMinor, 'contingency is being counted as margin');
    assert.equal(
      price.contingencyMinor,
      Math.round(1_000_000_00 * (config.billing.integrationContingencyPercent / 100)),
    );
  });

  it('moves with the configured rates rather than a constant in the code', () => {
    // The split is a commercial position. A business bidding against a
    // framework rate has to be able to move it without a code change.
    const price = integrator.quoteIntegration(qs(), 1_000_000_00);
    const profit = price.components.find((component) => component.label.startsWith('Profit'))!;
    assert.equal(profit.percent, config.billing.integrationProfitPercent);
    assert.equal(profit.amountMinor, Math.round(1_000_000_00 * (config.billing.integrationProfitPercent / 100)));
  });

  it('refuses to build a price on nothing', () => {
    throwsCode(
      () => integrator.priceIntegration(qs(), { directSupplierCostMinor: 0, model: 'MANAGEMENT_INTEGRATOR' }),
      'INTEGRATION_COST_INVALID',
    );
  });

  it('refuses a second account on one appointment', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const ctx = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(ctx(), { directSupplierCostMinor: 500_000_00, model: 'MANAGEMENT_INTEGRATOR' });
    throwsCode(
      () => integrator.priceIntegration(ctx(), { directSupplierCostMinor: 600_000_00, model: 'ADVISORY' }),
      'INTEGRATION_ACCOUNT_EXISTS',
    );
  });
});

// ── Contingency is controlled, not spent ────────────────────────────────────

describe('contingency cannot quietly become profit', () => {
  it('is drawn by approval authority and not by the person keeping the budget', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    const asOwner = () => fresh.context(freshSeed.users.owner!.auth, projectId, { source: 'WEB' });

    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });

    // The QS builds the price and maintains the budget. Drawing on the
    // contingency is a decision somebody with standing answers for — a business
    // where those are the same person has no contingency, it has a slower profit.
    throwsCode(
      () => integrator.drawContingency(asQs(), { amountMinor: 10_000_00, riskReference: 'RR-01', reason: 'Ground conditions' }),
      'ACCESS_DENIED',
    );

    const drawn = integrator.drawContingency(asOwner(), {
      amountMinor: 10_000_00,
      riskReference: 'RR-01',
      reason: 'Made ground found across the compound, additional piling to the welfare block',
    });
    assert.equal(drawn.drawnMinor, 10_000_00);
    assert.equal(drawn.remainingMinor, 50_000_00 - 10_000_00);
  });

  it('refuses a draw that names no risk', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    const asOwner = () => fresh.context(freshSeed.users.owner!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });

    const refusal = throwsCode(
      () => integrator.drawContingency(asOwner(), { amountMinor: 1_000_00, riskReference: '  ', reason: 'It cost more' }),
      'CONTINGENCY_RISK_REQUIRED',
    );
    assert.match(String(refusal.message), /underestimate or a scope change/);
  });

  it('refuses a draw beyond what was priced, rather than letting it eat the margin silently', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    const asOwner = () => fresh.context(freshSeed.users.owner!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });

    const refusal = throwsCode(
      () => integrator.drawContingency(asOwner(), { amountMinor: 60_000_00, riskReference: 'RR-02', reason: 'Everything went wrong at once' }),
      'CONTINGENCY_EXHAUSTED',
    );
    assert.match(String(refusal.message), /spending the margin/);
  });
});

// ── The reserve ─────────────────────────────────────────────────────────────

describe('the reserve answers the question that decides whether the business survives', () => {
  it('says so plainly when nothing has been priced', () => {
    const position = integrator.integratorPosition(pm());
    assert.equal(position.priced, false);
    assert.equal(position.concerns[0]?.kind, 'NOT_PRICED');
  });

  it('will not report infinite cover on a project that has paid nobody yet', async () => {
    // The most dangerous possible answer. A reserve covering an outflow of zero
    // covers nothing, and reporting a large number of days would tell a new
    // business it is safe at exactly the point it has not started paying anyone.
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });
    integrator.recordAdvance(asQs(), { amountMinor: 100_000_00, receivedOn: '2026-09-01', reference: 'ADV-001' });
    // Terms that raise nothing, so this test is about the reserve alone: the
    // client's money arrives fifteen days before the suppliers have to be paid.
    integrator.recordTradingTerms(asQs(), {
      clientPaymentDays: 30,
      supplierPaymentDays: 45,
      conditionalOnClientPayment: false,
      publicSectorClient: false,
    });

    const position = integrator.integratorPosition(asQs());
    assert.equal(position.reserve.coverDays, undefined, 'cover was reported against an outflow of zero');
    assert.match(String(position.reserve.unmeasured), /no outflow rate to measure the reserve against/);

    // And the summary must not undo it. Raising no concern is the absence of a
    // measurement, not an assurance, and "the reserve covers what is committed"
    // read off an empty concern list is the same false comfort by another route.
    assert.equal(position.concerns.length, 0, `unexpected concerns: ${position.concerns.map((c) => c.kind).join(', ')}`);
    assert.match(position.summary, /cannot be answered yet/);
    assert.doesNotMatch(position.summary, /The reserve covers \d/);
  });

  it('states the reserve position even when other things need attention', async () => {
    // The concern count used to replace the reserve sentence outright, so the
    // moment anything else was wrong the reader lost the answer to the question
    // this screen exists for. "1 thing needs attention" says nothing about
    // whether there is money in the account on the day the suppliers are due.
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });

    const position = integrator.integratorPosition(asQs());
    assert.ok(position.concerns.length > 0);
    assert.match(position.summary, /thing\(s\) need attention/);
    assert.match(position.summary, /cannot be answered yet/, 'the concern count swallowed the reserve position');
  });

  it('states money as money, not as a count of minor units', async () => {
    // Every other figure on the platform is formatted. A summary that reads
    // "priced at 125000000 minor units" is a number nobody can check at a
    // glance, on the one screen written to be read at eleven at night.
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'MANAGEMENT_INTEGRATOR' });

    const position = integrator.integratorPosition(asQs());
    assert.equal(position.priced, true);
    assert.doesNotMatch(position.summary, /minor units/);
    assert.match(position.summary, /Priced at £1\.25M on £1\.00M of supplier cost/);
    assert.match(position.summary, /£50\.0K is contingency and not margin/);

    // The refusal too — a ceiling stated in minor units is a ceiling nobody
    // can act on.
    const refusal = throwsCode(
      () =>
        integrator.drawContingency(fresh.context(freshSeed.users.owner!.auth, projectId, { source: 'WEB' }), {
          amountMinor: 60_000_00,
          riskReference: 'RR-09',
          reason: 'Everything went wrong at once',
        }),
      'CONTINGENCY_EXHAUSTED',
    );
    assert.match(String(refusal.message), /Only £50\.0K of contingency remains against £50\.0K priced/);
  });

  it('adds every advance into one reserve rather than a list of payments', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'MANAGEMENT_INTEGRATOR' });

    integrator.recordAdvance(asQs(), { amountMinor: 50_000_00, receivedOn: '2026-09-01', reference: 'ADV-001' });
    const after = integrator.recordAdvance(asQs(), { amountMinor: 25_000_00, receivedOn: '2026-10-01', reference: 'ADV-002' });

    // The mobilisation advance and every replenishment are the same thing —
    // the client funding the reserve. Two numbers would be no answer to how
    // much is actually held.
    assert.equal(after.advanceHeldMinor, 75_000_00);
    assert.equal(integrator.integratorPosition(asQs()).reserve.advanceHeldMinor, 75_000_00);
  });

  it('refuses an advance of nothing', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 500_000_00, model: 'ADVISORY' });
    throwsCode(
      () => integrator.recordAdvance(asQs(), { amountMinor: 0, receivedOn: '2026-09-01', reference: 'ADV-000' }),
      'ADVANCE_AMOUNT_INVALID',
    );
  });

  it('refuses to post against an appointment nobody has priced', () => {
    throwsCode(
      () => integrator.recordAdvance(qs(), { amountMinor: 10_000_00, receivedOn: '2026-09-01', reference: 'ADV-X' }),
      'INTEGRATION_ACCOUNT_NOT_FOUND',
    );
  });

  it('measures cover in days once money is actually going out, and says so when it is short', async () => {
    // The question the whole module exists for. £3,000,000 certified down the
    // chain in one period is £100,000 a day leaving; a £1,000,000 reserve is ten
    // days of it, against the thirty a payment cycle needs.
    const { platform: fresh, seed: freshSeed, projectId, certifiedDownstreamMinor } = await payingEstate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });
    integrator.recordAdvance(asQs(), { amountMinor: 1_000_000_00, receivedOn: '2026-09-01', reference: 'ADV-001' });

    const position = integrator.integratorPosition(asQs(), '2026-08-21');
    assert.equal(position.reserve.owedToSuppliersMinor, certifiedDownstreamMinor);
    assert.equal(position.reserve.coverDays, 10);
    assert.equal(position.reserve.unmeasured, undefined);

    const short = position.concerns.find((concern) => concern.kind === 'RESERVE_SHORT');
    assert.ok(short, 'ten days of cover against thirty required was not reported as short');
    assert.match(short.subject, /10 day\(s\)/);
    assert.match(short.subject, new RegExp(String(config.billing.integrationReserveCoverDays)));
    // And it says what happens rather than colouring a tile red.
    assert.match(short.consequence, /supply chain is the service/);

    // The client owes more than is going out, so this is a cover problem and not
    // yet the business funding the client. The two must not be conflated.
    assert.ok(
      position.reserve.owedByClientMinor + position.reserve.advanceHeldMinor > position.reserve.owedToSuppliersMinor,
    );
    assert.equal(
      position.concerns.some((concern) => concern.kind === 'PAYING_OUT_FASTER'),
      false,
      'reported as funding the client while the client still owes more than is going out',
    );
  });

  it('lifts the concern when the reserve is replenished to a full cycle', async () => {
    // The other direction. A warning that never clears is a warning nobody reads.
    const { platform: fresh, seed: freshSeed, projectId } = await payingEstate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });
    integrator.recordAdvance(asQs(), { amountMinor: 1_000_000_00, receivedOn: '2026-09-01', reference: 'ADV-001' });
    integrator.recordAdvance(asQs(), { amountMinor: 3_000_000_00, receivedOn: '2026-10-01', reference: 'ADV-002', covers: 'October supplier commitments' });

    const position = integrator.integratorPosition(asQs(), '2026-08-21');
    assert.equal(position.reserve.advanceHeldMinor, 4_000_000_00);
    assert.equal(position.reserve.coverDays, 40);
    assert.equal(
      position.concerns.some((concern) => concern.kind === 'RESERVE_SHORT'),
      false,
      'forty days of cover against thirty required was still reported as short',
    );
  });

  it('names it when more is certified down the chain than is owed up it and held', async () => {
    // The way integrators fail over three cycles rather than one: the business
    // funds the client, and the gap grows with the job instead of closing.
    const { platform: fresh, seed: freshSeed, projectId } = await payingEstate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });

    const position = integrator.integratorPosition(asQs(), '2026-08-21');
    assert.equal(position.reserve.advanceHeldMinor, 0);
    assert.ok(
      position.reserve.owedToSuppliersMinor > position.reserve.owedByClientMinor + position.reserve.advanceHeldMinor,
    );

    const funding = position.concerns.find((concern) => concern.kind === 'PAYING_OUT_FASTER');
    assert.ok(funding, 'the business is funding the client and the position did not say so');
    assert.match(funding.consequence, /funding the client/);
  });

  it('reports the build-up and what is left of the contingency on the position', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    const asOwner = () => fresh.context(freshSeed.users.owner!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });
    integrator.drawContingency(asOwner(), {
      amountMinor: 20_000_00,
      riskReference: 'RR-03',
      reason: 'Temporary power connection refused, generators hired for eight weeks',
    });

    const position = integrator.integratorPosition(asQs());
    assert.equal(position.priced, true);
    assert.equal(position.model, 'PRINCIPAL_SERVICE_CONTRACTOR');
    assert.equal(position.contingency.pricedMinor, 50_000_00);
    assert.equal(position.contingency.drawnMinor, 20_000_00);
    assert.equal(position.contingency.remainingMinor, 30_000_00);
    // The summary states the contingency separately, because a reader who takes
    // the addition as margin is the reader this whole module is written for.
    assert.match(position.summary, /is contingency and not margin/);
  });
});

describe('which of the three ways of trading this is', () => {
  /**
   * The model was a label that changed nothing.
   *
   * `ADVISORY`, `MANAGEMENT_INTEGRATOR` and `PRINCIPAL_SERVICE_CONTRACTOR` were
   * stored on the account and never read, so a pure fee appointment was priced
   * as a percentage on top of supplier cost — reporting a contract price that
   * included five million pounds of turnover the business would never see —
   * and then measured against a reserve for supplier payments it does not make.
   *
   * Both answers were wrong in the same direction: they described a business
   * carrying an exposure it had deliberately arranged not to carry.
   */
  it('prices a fee appointment as the fee, not as cost plus the fee', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });

    const { price } = integrator.priceIntegration(asQs(), {
      directSupplierCostMinor: 5_000_000_00,
      model: 'ADVISORY',
    });

    // The suppliers invoice the client. Nothing passes through this business.
    assert.equal(price.passThroughMinor, 0);
    assert.equal(price.contractPriceMinor, price.additionMinor);
    assert.ok(
      price.contractPriceMinor < 5_000_000_00,
      `a fee appointment reported ${price.contractPriceMinor} of turnover against £5m of somebody else's cost`,
    );

    // And no contingency: the supplier contracts are the client's, so the risk
    // allowance against them is the client's too.
    assert.equal(price.contingencyMinor, 0);
    assert.equal(price.marginMinor, price.additionMinor);
    assert.match(price.components[0]!.basis, /Nil on a fee appointment/);
  });

  it('prices a principal appointment as cost plus the addition, as before', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });

    const { price } = integrator.priceIntegration(asQs(), {
      directSupplierCostMinor: 5_000_000_00,
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    });

    assert.equal(price.passThroughMinor, 5_000_000_00);
    assert.equal(price.contractPriceMinor, 5_000_000_00 + price.additionMinor);
    // Contingency is priced, and it is still not margin.
    assert.ok(price.contingencyMinor > 0);
    assert.equal(price.marginMinor, price.additionMinor - price.contingencyMinor);
  });

  it('raises no supplier-payment concern against a business that pays no suppliers', async () => {
    // The failure this guards is a false alarm, which costs the same as a
    // missed one: a screen that warns about an outflow the business does not
    // have teaches whoever reads it to ignore the warning on the appointment
    // where the outflow is real.
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 5_000_000_00, model: 'ADVISORY' });

    const position = integrator.integratorPosition(asQs());
    assert.equal(position.trading?.fundsSupplierCost, false);
    assert.deepEqual(
      position.concerns.filter((c) => ['RESERVE_SHORT', 'PAYING_OUT_FASTER', 'FUNDING_GAP', 'TERMS_NOT_RECORDED'].includes(c.kind)),
      [],
      'a fee appointment was warned about supplier cash it does not carry',
    );
    assert.match(position.summary, /no supplier payment gap to hold a reserve against/);
    assert.match(position.summary, /^A fee of /);
  });

  it('says the fee model trades cash risk for margin risk, rather than removing risk', async () => {
    // The honest half of the answer. Never funding supplier cost is a real
    // mitigation and it has a price: every supplier holds its own contract and
    // its own invoice line with the client, which is the position a supplier
    // needs to be in to take the appointment next time.
    assert.match(integrator.TRADING_MODEL.ADVISORY.cashRisk, /no supplier cost in this business’s account/);
    assert.match(integrator.TRADING_MODEL.ADVISORY.marginRisk, /highest of the three/);
    assert.match(integrator.TRADING_MODEL.PRINCIPAL_SERVICE_CONTRACTOR.marginRisk, /lowest of the three/);
  });
});

describe('back-to-back terms, and which half of the phrase works', () => {
  /**
   * The phrase covers two arrangements that behave completely differently.
   *
   * **Conditional** — pay the supplier when the client pays — is of no effect
   * under HGCRA 1996 s.113 except on the third party's insolvency. A business
   * relying on it has no mitigation at all, and the platform already said so
   * about *incoming* invitations in `itt.ts` while saying nothing about the
   * subcontracts this business issues, which is the one place it would matter.
   *
   * **Timing** — pay the supplier later than the client pays this business — is
   * a payment period, which s.110 requires the contract to state and nothing
   * prohibits. That is the mitigation, and it is arithmetic.
   */
  const terms = (over: Partial<Parameters<typeof integrator.assessTerms>[0]> = {}) =>
    integrator.assessTerms({
      clientPaymentDays: 30,
      supplierPaymentDays: 45,
      conditionalOnClientPayment: false,
      publicSectorClient: false,
      recordedBy: 'test',
      recordedAt: '2026-09-01T00:00:00.000Z',
      ...over,
    });

  it('closes the gap by the payment period, which is the lawful half', () => {
    const gap = terms();
    // Paid at 30, pays at 45: the money is in the account fifteen days before
    // it has to leave. That is the position the whole arrangement is for.
    assert.equal(gap.gapDays, -15);
    assert.equal(gap.lawful, true);
    assert.ok(gap.findings.some((f) => /arrives 15 day\(s\) before/.test(f.finding)));
  });

  it('refuses to treat a pay-when-paid clause as protection', () => {
    const gap = terms({ conditionalOnClientPayment: true });
    assert.equal(gap.lawful, false, 'a void clause was reported as a lawful arrangement');

    const finding = gap.findings.find((f) => f.authority === 'HGCRA 1996 s.113');
    assert.ok(finding, 'nothing said the conditional term is ineffective');
    assert.equal(finding.severity, 'BAR');
    assert.match(finding.finding, /no effect except on the client’s insolvency/);
    // And it points at the thing that does work, rather than only refusing.
    assert.match(finding.finding, /payment period/);
  });

  it('names the funding gap in days, and prices it where there is a rate to price it against', () => {
    // Paid at 60, pays at 14: this business funds the chain for 46 days on
    // every cycle. At £300,000 of supplier spend a month that is £460,000
    // standing out — 46 × (300,000 / 30).
    const gap = terms({ clientPaymentDays: 60, supplierPaymentDays: 14 });
    assert.equal(gap.gapDays, 46);

    const priced = integrator.assessTerms(
      { clientPaymentDays: 60, supplierPaymentDays: 14, conditionalOnClientPayment: false, publicSectorClient: false, recordedBy: 't', recordedAt: 'x' },
      300_000_00,
    );
    assert.equal(priced.exposureMinor, 460_000_00);
    assert.equal(priced.unmeasured, undefined);
    // With no rate of spend it says so rather than reporting an exposure of nil.
    assert.equal(gap.exposureMinor, undefined);
    assert.match(String(gap.unmeasured), /no rate of supplier spend/);
  });

  it('prices no gap as nil rather than as unmeasured', () => {
    // The three cases are not two. No gap at all *is* a measurement — the money
    // arrives before it leaves, so there is nothing to price whatever the rate
    // of spend turns out to be. Reporting it as "not yet priced" put a caveat
    // on the one arrangement that does not need one, and the rendered panel
    // showed a business that had got its terms right being told the answer was
    // still pending.
    const covered = terms({ clientPaymentDays: 30, supplierPaymentDays: 45 });
    assert.equal(covered.gapDays, -15);
    assert.equal(covered.exposureMinor, 0);
    assert.equal(covered.unmeasured, undefined, 'a covered position was reported as unmeasured');

    // Exactly level is the same answer, not a boundary case that slips through.
    const level = terms({ clientPaymentDays: 30, supplierPaymentDays: 30 });
    assert.equal(level.gapDays, 0);
    assert.equal(level.exposureMinor, 0);
    assert.equal(level.unmeasured, undefined);
  });

  it('will not let a public contract buy a gap the regulations forbid', () => {
    // Regulation 113 requires 30-day terms to be passed down the whole chain.
    // Ninety-day subcontract terms on public work are not a commercial choice.
    const gap = terms({ publicSectorClient: true, clientPaymentDays: 30, supplierPaymentDays: 90 });
    const finding = gap.findings.find((f) => f.authority.startsWith('Public Contracts Regulations'));
    assert.ok(finding, 'a 90-day subcontract on public work raised nothing');
    assert.equal(finding.severity, 'BAR');
    assert.equal(gap.lawful, false);

    // The same terms on a private client are lawful, and still flagged as
    // open to challenge rather than waved through.
    const priv = terms({ publicSectorClient: false, clientPaymentDays: 30, supplierPaymentDays: 90 });
    assert.equal(priv.lawful, true);
    assert.ok(priv.findings.some((f) => f.authority.startsWith('Late Payment')));
  });

  it('leaves an ordinary period alone', () => {
    // A rule that fires on everything is a rule nobody reads.
    const gap = terms({ clientPaymentDays: 30, supplierPaymentDays: 45 });
    assert.equal(gap.findings.filter((f) => f.severity === 'BAR').length, 0);
    assert.equal(gap.findings.filter((f) => f.authority.startsWith('Late Payment')).length, 0);
  });
});

describe('the trading terms on the record', () => {
  it('records them, derives the gap and raises it on the position', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'PRINCIPAL_SERVICE_CONTRACTOR' });

    const { gap } = integrator.recordTradingTerms(asQs(), {
      clientPaymentDays: 60,
      supplierPaymentDays: 30,
      conditionalOnClientPayment: true,
      publicSectorClient: false,
    });
    assert.equal(gap.gapDays, 30);
    assert.equal(gap.lawful, false);

    const position = integrator.integratorPosition(asQs());
    assert.equal(position.fundingGap?.gapDays, 30);
    const kinds = position.concerns.map((c) => c.kind);
    assert.ok(kinds.includes('VOID_PAYMENT_CONDITION'), `expected the void clause to be raised, got ${kinds.join(', ')}`);
    assert.ok(kinds.includes('FUNDING_GAP'), `expected the funding gap to be raised, got ${kinds.join(', ')}`);
    assert.ok(!kinds.includes('TERMS_NOT_RECORDED'));
  });

  it('asks for the terms when a business carrying supplier cash has not stated them', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'MANAGEMENT_INTEGRATOR' });

    const position = integrator.integratorPosition(asQs());
    assert.ok(position.concerns.some((c) => c.kind === 'TERMS_NOT_RECORDED'));
    assert.equal(position.fundingGap, undefined);
  });

  it('refuses a payment period that is not a whole number of days', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    integrator.priceIntegration(asQs(), { directSupplierCostMinor: 1_000_000_00, model: 'MANAGEMENT_INTEGRATOR' });

    throwsCode(
      () =>
        integrator.recordTradingTerms(asQs(), {
          clientPaymentDays: -5,
          supplierPaymentDays: 30,
          conditionalOnClientPayment: false,
          publicSectorClient: false,
        }),
      'PAYMENT_DAYS_INVALID',
    );
  });

  it('refuses to record terms against an appointment nobody has priced', async () => {
    const { platform: fresh, seed: freshSeed, projectId } = await estate();
    const asQs = () => fresh.context(freshSeed.users.qs!.auth, projectId, { source: 'WEB' });
    throwsCode(
      () =>
        integrator.recordTradingTerms(asQs(), {
          clientPaymentDays: 30,
          supplierPaymentDays: 45,
          conditionalOnClientPayment: false,
          publicSectorClient: false,
        }),
      'INTEGRATION_ACCOUNT_NOT_FOUND',
    );
  });
});
