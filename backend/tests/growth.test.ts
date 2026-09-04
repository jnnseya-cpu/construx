import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as growth from '../src/growth/partners.ts';
import * as signup from '../src/identity/signup.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * The growth programme, walked the way money walks: a code is enrolled, a
 * signup arrives carrying it, the tenancy is created attributed to it, a
 * settled receipt converts it, commission or bounty is earned, a payout is
 * recorded once however many times its reference is entered.
 *
 * Nothing had tested attribution at all: the screens rendered empty states,
 * which are correct with nobody enrolled, and that was as far as anybody had
 * looked.
 */

let platform: Platform;
let actor: ReturnType<typeof authOf>;

const registerAndVerify = (organisationName: string, email: string, referralCode?: string): string => {
  const started = signup.register(platform, {
    email,
    contactName: 'Somebody',
    organisationName,
    jurisdiction: 'GB',
    currency: 'GBP',
    package: 'SOLO',
    ...(referralCode ? { referralCode } : {}),
  });
  assert.ok(started.registration && started.token, 'a new registration carries its verification token outside production');
  const activation = signup.verify(platform, {
    registrationId: started.registration.id,
    token: started.token,
    correlationId: 'growth-test',
  });
  return activation.tenantId;
};

before(() => {
  signup.resetRegistrations();
  platform = new Platform();
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  actor = authOf(platform, operator.id);
});

describe('a partner and an influencer', () => {
  let partnerId = '';
  let influencerId = '';

  it('are enrolled with codes that are never reused', () => {
    const partner = growth.enrol(platform, actor, {
      kind: 'PARTNER',
      name: 'Northern QS Partners',
      email: 'partners@nqs.example',
      code: 'nqs-2026',
      commissionBps: 1000,
    });
    partnerId = partner.id;
    assert.equal(partner.code, 'NQS-2026', 'the code is normalised');
    const influencer = growth.enrol(platform, actor, {
      kind: 'INFLUENCER',
      name: 'Site Diaries',
      email: 'hello@sitediaries.example',
      code: 'SITEDIARIES',
      bountyMinor: 5000,
    });
    influencerId = influencer.id;
    throwsCode(
      () => growth.enrol(platform, actor, { kind: 'PARTNER', name: 'Somebody else', email: 'x@y.example', code: 'NQS-2026', commissionBps: 500 }),
      'CODE_IN_USE',
    );
    const position = growth.programmePosition(platform, actor);
    assert.equal(position.partners.length, 1);
    assert.equal(position.influencers.length, 1);
    assert.equal(position.totals.referredTenancies, 0);
  });

  it('are credited with a tenancy whose signup carried their code, fixed at signup', () => {
    const referredByPartner = registerAndVerify('Referred Build Ltd', 'ref@referredbuild.example', 'NQS-2026');
    const referredByInfluencer = registerAndVerify('Diary Readers Ltd', 'ref@diaryreaders.example', 'sitediaries');
    assert.equal(platform.tenant(referredByPartner).referralCode, 'NQS-2026');
    assert.equal(platform.tenant(referredByInfluencer).referralCode, 'SITEDIARIES', 'the code on the tenancy is normalised the way the programme normalises it');

    const position = growth.programmePosition(platform, actor);
    assert.equal(position.totals.referredTenancies, 2);
    assert.equal(position.totals.convertedTenancies, 0, 'a signup is not a conversion');
    assert.equal(position.totals.attributedRevenueMinor, 0);
    assert.equal(position.totals.owedMinor, 0, 'nothing is owed against money that has not arrived');
    assert.deepEqual(position.unattributed, []);
  });

  it('list a signup carrying a code nobody holds as unattributed rather than dropping it', () => {
    const tenantId = registerAndVerify('Typo Ltd', 'ref@typo.example', 'NQS-2062');
    const position = growth.programmePosition(platform, actor);
    assert.equal(position.unattributed.length, 1);
    assert.equal(position.unattributed[0]!.tenantId, tenantId);
    assert.equal(position.unattributed[0]!.code, 'NQS-2062');
    assert.equal(position.totals.referredTenancies, 2, 'the typo credits nobody');
  });

  it('earn from settled receipts: a share for the partner, a bounty once for the influencer', () => {
    const [byPartner, byInfluencer] = platform
      .customerTenants()
      .filter((tenant) => tenant.referralCode === 'NQS-2026' || tenant.referralCode === 'SITEDIARIES')
      .sort((a, b) => (a.referralCode === 'NQS-2026' ? -1 : 1) - (b.referralCode === 'NQS-2026' ? -1 : 1));
    platform.creditFromPayment({ tenantId: byPartner!.id, amountMinor: 20_000, method: 'BANK_TRANSFER', reference: 'BACS-REF-1', recordedBy: actor.actorId, source: 'OPERATOR' });
    platform.creditFromPayment({ tenantId: byPartner!.id, amountMinor: 10_000, method: 'CARD', reference: 'CARD-REF-2', recordedBy: actor.actorId, source: 'OPERATOR' });
    platform.creditFromPayment({ tenantId: byInfluencer!.id, amountMinor: 3_000, method: 'CARD', reference: 'CARD-REF-3', recordedBy: actor.actorId, source: 'OPERATOR' });
    platform.creditFromPayment({ tenantId: byInfluencer!.id, amountMinor: 3_000, method: 'CARD', reference: 'CARD-REF-4', recordedBy: actor.actorId, source: 'OPERATOR' });

    const position = growth.programmePosition(platform, actor);
    const partner = position.partners[0]!;
    const influencer = position.influencers[0]!;
    assert.equal(partner.attributedRevenueMinor, 30_000);
    assert.equal(partner.earnedMinor, 3_000, '10% of everything the referred tenancy has paid');
    assert.equal(partner.owedMinor, 3_000);
    assert.equal(influencer.attributedRevenueMinor, 6_000);
    assert.equal(influencer.convertedCount, 1);
    assert.equal(influencer.earnedMinor, 5_000, 'the bounty is paid once, not per receipt');
    assert.equal(position.totals.convertedTenancies, 2);
    assert.equal(position.totals.owedMinor, 8_000);
  });

  it('record a payout once, however many times the bank reference is entered', () => {
    const first = growth.recordPayout(platform, actor, partnerId, { amountMinor: 3_000, reference: 'BACS-77120-NQS' });
    assert.equal(first.alreadyRecorded, false);
    const again = growth.recordPayout(platform, actor, partnerId, { amountMinor: 3_000, reference: 'BACS-77120-NQS' });
    assert.equal(again.alreadyRecorded, true);
    const partner = growth.programmePosition(platform, actor).partners[0]!;
    assert.equal(partner.paidMinor, 3_000);
    assert.equal(partner.owedMinor, 0);
    throwsCode(() => growth.recordPayout(platform, actor, partnerId, { amountMinor: 0, reference: 'BACS-0' }), 'AMOUNT_REQUIRED');
  });

  it('keep attribution when the agreement ends, and still never reuse the code', () => {
    const ended = growth.setStatus(platform, actor, influencerId, 'ENDED', 'Agreement concluded at the end of the campaign.');
    assert.equal(ended.status, 'ENDED');
    const position = growth.programmePosition(platform, actor);
    assert.equal(position.totals.active, 1);
    assert.equal(position.influencers[0]!.referredCount, 1, 'what was attributed stays attributed');
    throwsCode(
      () => growth.enrol(platform, actor, { kind: 'INFLUENCER', name: 'Another', email: 'a@b.example', code: 'SITEDIARIES', bountyMinor: 100 }),
      'CODE_IN_USE',
    );
  });

  it('survive a restart', () => {
    const restored = new Platform();
    restored.ledger.restore(platform.ledger.events());
    restored.rehydrate();
    const before = growth.programmePosition(platform, actor);
    const after = growth.programmePosition(restored, actor);
    assert.deepEqual(after.totals, before.totals);
    assert.deepEqual(after.unattributed.map((entry) => entry.code), before.unattributed.map((entry) => entry.code));
    // The receipts came back with the record, so the reference is still the
    // idempotency key it was before the restart: the same payment entered
    // again credits nothing a second time.
    const referred = restored.customerTenants().find((tenant) => tenant.referralCode === 'NQS-2026')!;
    assert.ok(referred.createdAt, 'the joining date is on the restored tenancy');
    const repeated = restored.creditFromPayment({ tenantId: referred.id, amountMinor: 20_000, method: 'BANK_TRANSFER', reference: 'BACS-REF-1', recordedBy: actor.actorId, source: 'OPERATOR' });
    assert.equal(repeated.alreadyRecorded, true);
    assert.equal(restored.paymentReceipts(referred.id).length, 2);
  });
});
