import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as claims from '../src/engines/claims.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The variation control matrix.
 *
 * Change is where money leaves a construction contract quietly, and it leaves
 * in exactly two directions. A subcontractor's claim the business will pay and
 * never charged on. And a price agreed with the client before anybody knew what
 * the packages would cost — which reads as a win on the day and as an
 * unexplained margin drop at final account.
 *
 * Neither is visible from either register alone. That is the whole reason for
 * insisting the two sides of one change are linked.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

const change = () => platform.ledger.list(seed.projectId, 'ChangeRequest')[0]!;
const upstreamVariation = () =>
  platform.ledger.list(seed.projectId, 'Variation').find((v) => v.state.isDomestic !== true)!;

/** Walk a change through submission, assessment and instruction. */
async function instructedChange(
  description: string,
  affectedSubcontractIds: string[],
): Promise<{ changeRequestId: string; variationId: string }> {
  const request = claims.submitChangeRequest(ctx('pm'), {
    description,
    origin: 'CLIENT',
    noticeType: 'CCI',
    reason: 'Client instruction following review',
    impactedPackageIds: [],
    affectedSubcontractIds,
    supportingEvidenceHash: hashEvidence(description),
  });

  await claims.assessImpact(ctx('pm'), {
    changeRequestId: request.changeRequestId,
    costImpactMinor: 1_400_000,
    timeImpactDays: 2,
    affectedTaskIds: [],
    qualityImpact: 'None',
    safetyImpact: 'None',
  });

  const variation = claims.instructVariation(ctx('pm'), {
    changeRequestId: request.changeRequestId,
    contractId: String(platform.ledger.list(seed.projectId, 'Contract')[0]!.refId),
    valuationMethod: 'LUMP_SUM',
    valuedAmountMinor: 1_400_000,
    timeImpactDays: 2,
  });

  return { changeRequestId: request.changeRequestId, variationId: variation.variationId };
}

describe('valuing a variation upstream', () => {
  it('agreed the seeded variation only after the downstream cost was captured', () => {
    const variation = upstreamVariation();

    assert.equal(variation.state.status, 'VALUED');
    assert.equal(variation.state.instructedAmountMinor, 34_500_000);
    assert.equal(variation.state.valuedAmountMinor, 36_900_000);
    // The subcontractor's quotation for the same change, captured first.
    assert.equal(variation.state.downstreamCapturedMinor, 26_800_000);
  });

  it('refuses a valuation with no basis behind the figure', async () => {
    // Against a fresh variation, because the already-valued check comes first
    // and would mask this one.
    const fresh = await instructedChange('Kerb line realignment to the tanker turning circle', []);

    throwsCode(
      () =>
        claims.valueVariation(ctx('pm'), {
          variationId: fresh.variationId,
          valuationMethod: 'LUMP_SUM',
          agreedAmountMinor: 1_000,
          agreedTimeDays: 0,
          basis: 'Agreed',
          agreedWith: 'Client',
        }),
      'VARIATION_BASIS_REQUIRED',
    );
  });

  it('values a change with no subcontract behind it without objection', async () => {
    // Self-delivered work has no downstream cost to capture, so there is
    // nothing for the rule to protect and it does not fire.
    const fresh = await instructedChange('Additional handrail to the west walkway, self-delivered', []);

    const result = claims.valueVariation(ctx('pm'), {
      variationId: fresh.variationId,
      valuationMethod: 'DAYWORK',
      agreedAmountMinor: 1_400_000,
      agreedTimeDays: 2,
      basis: 'Daywork sheets for two operatives over three shifts plus materials at invoice',
      agreedWith: 'Ashworth Water Authority — project manager',
    });

    assert.equal(result.downstreamCapturedMinor, 0);
    assert.equal(result.marginOnChangeMinor, 1_400_000);
  });

  it('refuses to agree a client figure while a named package has not priced it', async () => {
    // The rule that saves the money. A main contractor agreeing upstream before
    // its subcontractor has priced is guessing at its own cost, and the guess is
    // always low because the claim has not arrived yet.
    const subcontractId = String(platform.ledger.list(seed.projectId, 'Subcontract')[0]!.refId);
    const fresh = await instructedChange('Additional ductwork to the odour control building', [subcontractId]);

    throwsCode(
      () =>
        claims.valueVariation(ctx('pm'), {
          variationId: fresh.variationId,
          valuationMethod: 'LUMP_SUM',
          agreedAmountMinor: 4_000_000,
          agreedTimeDays: 3,
          basis: 'Lump sum offered by the client against the specialist quotation not yet received',
          agreedWith: 'Ashworth Water Authority — project manager',
        }),
      'DOWNSTREAM_COST_NOT_CAPTURED',
    );
  });

  it('refuses to value the same variation twice', () => {
    throwsCode(
      () =>
        claims.valueVariation(ctx('pm'), {
          variationId: upstreamVariation().refId,
          valuationMethod: 'LUMP_SUM',
          agreedAmountMinor: 40_000_000,
          agreedTimeDays: 20,
          basis: 'Second attempt at the same valuation on a different basis',
          agreedWith: 'Client',
        }),
      'VARIATION_ALREADY_VALUED',
    );
  });
});

describe('refusing a change', () => {
  it('refuses a rejection that does not say why', () => {
    const fresh = claims.submitChangeRequest(ctx('pm'), {
      description: 'Upgrade the site cabin heating',
      origin: 'SITE',
      noticeType: 'RFC',
      reason: 'Requested by the site team',
      impactedPackageIds: [],
      affectedSubcontractIds: [],
      supportingEvidenceHash: hashEvidence('cabin-heating'),
    });

    throwsCode(() => claims.rejectChangeRequest(ctx('pm'), { changeRequestId: fresh.changeRequestId, reason: 'No' }), 'CHANGE_REJECTION_REASON_REQUIRED');
  });

  it('records the refusal with its grounds, so it stays refused', () => {
    const fresh = claims.submitChangeRequest(ctx('pm'), {
      description: 'Second access road to the north compound',
      origin: 'INTERNAL_DISCOVERY',
      noticeType: 'RFC',
      reason: 'Suggested to shorten haulage',
      impactedPackageIds: [],
      affectedSubcontractIds: [],
      supportingEvidenceHash: hashEvidence('second-access'),
    });

    const result = claims.rejectChangeRequest(ctx('pm'), {
      changeRequestId: fresh.changeRequestId,
      reason: 'Outside the contract scope and no client instruction; the haulage saving does not cover the works',
    });

    const record = platform.ledger.require({ refType: 'ChangeRequest', refId: fresh.changeRequestId });
    assert.equal(record.state.status, 'REJECTED');
    assert.match(String(record.state.rejectionReason), /Outside the contract scope/);
    assert.ok(result.reference);

    throwsCode(
      () =>
        claims.rejectChangeRequest(ctx('pm'), {
          changeRequestId: fresh.changeRequestId,
          reason: 'Refusing it a second time for the same stated reason',
        }),
      'CHANGE_ALREADY_REJECTED',
    );
  });

  it('will not let an instructed change be refused', () => {
    throwsCode(
      () =>
        claims.rejectChangeRequest(ctx('pm'), {
          changeRequestId: change().refId,
          reason: 'Changed our mind about the wall thickness after it was built',
        }),
      'CHANGE_ALREADY_INSTRUCTED',
    );
  });
});

describe('the register, both sides of every change', () => {
  it('finds the subcontractor claim nobody charged on', () => {
    // The dewatering claim arrived inside a payment application and is linked
    // to no upstream change. That is money the business will pay with nothing
    // claimed against it, and it is the commonest leak on a contract.
    const register = claims.variationRegister(ctx('qs'));

    assert.equal(register.downstreamNotRecoveredMinor, 22_400_000);
    const leak = register.lines.find((l) => l.mismatch?.kind === 'DOWNSTREAM_NOT_RECOVERED');
    assert.ok(leak);
    assert.match(leak.mismatch!.detail, /not linked to any upstream change/);
  });

  it('does not treat two unrelated changes on one package as each other', () => {
    // The dewatering claim and the wall thickness variation hit the same
    // subcontract. Matching on the package would report the leak as recovered,
    // and a false all-clear is worse than a false alarm — nobody rechecks it.
    const register = claims.variationRegister(ctx('qs'));
    const valued = register.lines.find((l) => l.status === 'VALUED')!;

    assert.equal(valued.downstreamCapturedMinor, 26_800_000, 'only the quotation for this change');
    assert.equal(valued.mismatch, undefined);
  });

  it('reports the margin on change rather than the turnover on it', () => {
    const register = claims.variationRegister(ctx('qs'));

    // The seeded change: £369,000 agreed against £268,000 of subcontract cost.
    const seeded = register.lines.find((l) => l.agreedMinor === 36_900_000)!;
    assert.equal(seeded.agreedMinor - seeded.downstreamCapturedMinor, 10_100_000);

    // And the total is the sum over everything valued, so it cannot drift from
    // the lines it claims to summarise.
    const fromLines = register.lines
      .filter((l) => l.status === 'VALUED')
      .reduce((sum, l) => sum + l.agreedMinor - l.downstreamCapturedMinor, 0);
    assert.equal(register.marginOnChangeMinor, fromLines);
  });

  it('says which direction the exposure runs', () => {
    const register = claims.variationRegister(ctx('qs'));
    assert.match(register.summary, /nothing claimed upstream/);
  });

  it('carries every change, including the ones refused and the ones left open', () => {
    const register = claims.variationRegister(ctx('qs'));
    assert.ok(register.lines.some((l) => l.status === 'REJECTED'));
    assert.ok(register.lines.length >= 4);
  });

  it('will not show the register to a role with no commercial read', () => {
    assert.throws(() => claims.variationRegister(platform.context(seed.users.safety!.auth, seed.projectId)));
  });
});
