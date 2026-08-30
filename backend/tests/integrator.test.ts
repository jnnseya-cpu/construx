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

    const position = integrator.integratorPosition(asQs());
    assert.equal(position.reserve.coverDays, undefined, 'cover was reported against an outflow of zero');
    assert.match(String(position.reserve.unmeasured), /no outflow rate to measure the reserve against/);

    // And the summary must not undo it. Raising no concern is the absence of a
    // measurement, not an assurance, and "the reserve covers what is committed"
    // read off an empty concern list is the same false comfort by another route.
    assert.equal(position.concerns.length, 0);
    assert.match(position.summary, /cannot be answered yet/);
    assert.doesNotMatch(position.summary, /The reserve covers \d/);
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
