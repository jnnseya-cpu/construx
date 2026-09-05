import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { config } from '../src/config.ts';
import * as engine from '../src/growth/engine.ts';
import * as growth from '../src/growth/partners.ts';
import { issueTokens } from '../src/identity/auth.ts';
import * as signup from '../src/identity/signup.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * The growth programme read as a whole: whether a referral can be attributed,
 * whether the codes out there are earning, and what is owed to whom — every
 * check against the served form, the route table, the page, the agreements
 * and the receipts.
 */

let platform: Platform;
let actor: ReturnType<typeof authOf>;
let operatorId = '';

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
  const activation = signup.verify(platform, { registrationId: started.registration!.id, token: started.token!, correlationId: 'growth-engine-test' });
  return activation.tenantId;
};

before(() => {
  signup.resetRegistrations();
  platform = new Platform();
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  operatorId = operator.id;
  actor = authOf(platform, operator.id);
});

describe('the sweep on an empty programme', () => {
  it('weighs to a hundred, finds the link wired and the page honest, and says nobody is enrolled', () => {
    const programme = growth.programmePosition(platform, actor);
    const findings = engine.programmeSweep(platform, programme);
    assert.equal(findings.reduce((sum, finding) => sum + finding.weight, 0), 100);
    const byCheck = new Map(findings.map((finding) => [finding.check, finding]));
    assert.equal(byCheck.get('Referral link')!.ok, true, byCheck.get('Referral link')!.detail);
    assert.equal(byCheck.get('Public programme page')!.ok, true, byCheck.get('Public programme page')!.detail);
    assert.equal(byCheck.get('Enrolled')!.ok, false);
    assert.equal(byCheck.get('Unattributed codes')!.ok, true);
    assert.equal(byCheck.get('Idle codes')!.ok, true, 'nothing enrolled means nothing idle; Enrolled carries that failure');
    assert.equal(byCheck.get('Conversion')!.ok, false);
    assert.equal(byCheck.get('Settlement')!.ok, true);
    assert.equal(byCheck.get('Fresh attribution')!.ok, false);

    const position = engine.growthPosition(platform, actor);
    // The mechanism is wired (link, page, no bad codes, nothing owed); what is
    // missing is people and results — the three checks that fail weigh 26.
    assert.equal(position.health.score, 74);
    assert.equal(position.health.band, 'WORKABLE');
    assert.match(position.health.summary, /Conversion|Enrolled|Fresh attribution/);
    assert.ok(position.recommendations.some((item) => item.action?.command === 'enrol'), 'the first door is to enrol somebody');
    assert.equal(position.results.series.length, 0);
    assert.equal(position.results.totals.conversionPercent, null);
  });
});

describe('attribution, earnings and what the engine makes of them', () => {
  let partner: growth.Partner;
  let influencer: growth.Partner;
  let referredId = '';

  it('sees an unattributed code and offers to enrol under exactly that code', () => {
    registerAndVerify('Typo Ltd', 'typo@example.test', 'nqs-2062');
    const position = engine.growthPosition(platform, actor);
    const finding = position.sweep.find((entry) => entry.check === 'Unattributed codes')!;
    assert.equal(finding.ok, false);
    assert.match(finding.detail, /NQS-2062/);
    const door = position.recommendations.find((item) => item.action?.command === 'enrol' && item.action.code === 'NQS-2062');
    assert.ok(door, 'a door that enrols under the arriving code');
  });

  it('enrols, attributes and earns, and the position reads it', () => {
    partner = growth.enrol(platform, actor, { kind: 'PARTNER', name: 'Northern QS Partners', email: 'partners@nqs.example', code: 'NQS-2062', commissionBps: 1000 });
    influencer = growth.enrol(platform, actor, { kind: 'INFLUENCER', name: 'Site Diaries', email: 'hello@sitediaries.example', code: 'SITEDIARIES', bountyMinor: 5_000 });
    referredId = registerAndVerify('Referred Build Ltd', 'ref@referredbuild.example', 'NQS-2062');
    registerAndVerify('Diary Readers Ltd', 'ref@diaryreaders.example', 'sitediaries');

    let position = engine.growthPosition(platform, actor);
    assert.equal(position.sweep.find((entry) => entry.check === 'Unattributed codes')!.ok, true, 'the typo tenancy is now attributed by the record');
    assert.equal(position.results.totals.referredTenancies, 3);
    assert.equal(position.results.totals.conversionPercent, 0);

    platform.creditFromPayment({ tenantId: referredId, amountMinor: 20_000, method: 'BANK_TRANSFER', reference: 'BACS-1', recordedBy: actor.actorId, source: 'OPERATOR' });
    platform.creditFromPayment({ tenantId: referredId, amountMinor: 10_000, method: 'CARD', reference: 'CARD-2', recordedBy: actor.actorId, source: 'OPERATOR' });

    position = engine.growthPosition(platform, actor);
    assert.equal(position.results.totals.attributedRevenueMinor, 30_000);
    assert.equal(position.results.totals.earnedMinor, 3_000);
    assert.equal(position.results.series.length, 1, 'both receipts land in this month');
    assert.equal(position.results.series[0]!.revenueMinor, 30_000);
    assert.equal(position.results.series[0]!.earnedMinor, 3_000);
    assert.equal(position.results.series[0]!.receipts, 2);
    const settlement = position.sweep.find((entry) => entry.check === 'Settlement')!;
    assert.equal(settlement.ok, true, 'owed, but earned inside the settlement window');
    assert.match(settlement.detail, /30\.00 owed/);
    assert.equal(position.sweep.find((entry) => entry.check === 'Fresh attribution')!.ok, true);
  });

  it('gives every agreement a kit whose links carry the code and whose copy discloses the relationship', () => {
    const kit = engine.referralKit(partner);
    const link = kit.find((entry) => entry.channel === 'link')!;
    assert.equal(link.url, `${config.publicBaseUrl}/app/signup?ref=NQS-2062`);
    assert.ok(kit.some((entry) => entry.channel.startsWith('package:') && entry.url!.includes('package=') && entry.url!.includes('ref=NQS-2062')));
    assert.match(kit.find((entry) => entry.channel === 'email')!.text, /I am a CONSTRUX partner/);
    assert.match(engine.referralKit(influencer).find((entry) => entry.channel === 'linkedin')!.text, /Creator link/);
    assert.ok(!/\d+%|£\d/.test(kit.find((entry) => entry.channel === 'email')!.text), 'no figure the platform does not measure');
  });

  it('writes a statement of every receipt the earnings rest on, with the bounty on the first receipt only', () => {
    const diary = platform.customerTenants().find((tenant) => tenant.referralCode === 'SITEDIARIES')!;
    platform.creditFromPayment({ tenantId: diary.id, amountMinor: 3_000, method: 'CARD', reference: 'CARD-3', recordedBy: actor.actorId, source: 'OPERATOR' });
    platform.creditFromPayment({ tenantId: diary.id, amountMinor: 3_000, method: 'CARD', reference: 'CARD-4', recordedBy: actor.actorId, source: 'OPERATOR' });

    const { partner: entry, csv } = engine.partnerStatementFor(platform, actor, influencer.id);
    const statement = engine.partnerStatement(platform, entry);
    assert.equal(statement.rows.length, 2);
    assert.deepEqual(statement.rows.map((row) => row.earnedMinor), [5_000, 0], 'the bounty once, on the first receipt');
    assert.equal(statement.earnedMinor, 5_000);
    assert.match(csv, /^Partner,Site Diaries,Code,SITEDIARIES,Terms,50\.00 per paying tenancy\r\n/);
    assert.match(csv, /CARD-3,CARD,30\.00,50\.00\r\n/);
    assert.match(csv, /\r\nOwed,50\.00\r\n/);

    const partnerCsv = engine.partnerStatementFor(platform, actor, partner.id).csv;
    assert.match(partnerCsv, /BACS-1,BANK_TRANSFER,200\.00,20\.00\r\n/);
    assert.match(partnerCsv, /\r\nEarned,30\.00\r\n/);
  });

  it('calls an unpaid earning overdue only once its receipt is older than the settlement window, and offers the payout door', () => {
    const programme = growth.programmePosition(platform, actor);
    const later = new Date(Date.now() + (engine.SETTLEMENT_DAYS + 1) * 86_400_000);
    const findings = engine.programmeSweep(platform, programme, later);
    const settlement = findings.find((entry) => entry.check === 'Settlement')!;
    assert.equal(settlement.ok, false);
    assert.match(settlement.detail, /Northern QS Partners 30\.00/);
    const doors = engine.recommendations(platform, programme, findings, later);
    assert.ok(doors.some((item) => item.action?.command === 'payout' && item.action.partnerId === partner.id));

    growth.recordPayout(platform, actor, partner.id, { amountMinor: 3_000, reference: 'BACS-PAY-1' });
    growth.recordPayout(platform, actor, influencer.id, { amountMinor: 5_000, reference: 'BACS-PAY-2' });
    const paid = engine.programmeSweep(platform, growth.programmePosition(platform, actor), later);
    assert.equal(paid.find((entry) => entry.check === 'Settlement')!.ok, true);
    assert.equal(paid.find((entry) => entry.check === 'Payouts reconciled')!.ok, true);
  });

  it('calls a code idle after thirty days with nothing attributed, and a bounty above the cheapest month uneconomic', () => {
    const idle = growth.enrol(platform, actor, { kind: 'INFLUENCER', name: 'Quiet Channel', email: 'quiet@example.test', code: 'QUIET', bountyMinor: 900_000 });
    const later = new Date(Date.now() + (engine.IDLE_DAYS + 1) * 86_400_000);
    const programme = growth.programmePosition(platform, actor);
    const findings = engine.programmeSweep(platform, programme, later);
    const idleFinding = findings.find((entry) => entry.check === 'Idle codes')!;
    assert.equal(idleFinding.ok, false);
    assert.match(idleFinding.detail, /QUIET \(Quiet Channel\)/);
    const economics = findings.find((entry) => entry.check === 'Bounty economics')!;
    assert.equal(economics.ok, false);
    assert.match(economics.detail, /Quiet Channel 9000\.00/);
    const doors = engine.recommendations(platform, programme, findings, later);
    assert.ok(doors.some((item) => item.action?.command === 'kit' && item.action.partnerId === idle.id));
    growth.setStatus(platform, actor, idle.id, 'ENDED', 'Test agreement, ended to leave the register clean.');
  });
});

describe('through the gateway', () => {
  let server: Server;
  let base: string;
  let operatorToken: string;
  let customerToken: string;

  async function call(method: string, path: string, bearer?: string) {
    const response = await fetch(`${base}${path}`, { method, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    return { status: response.status, type: response.headers.get('content-type') ?? '', text: await response.text() };
  }

  before(async () => {
    const operator = platform.user(operatorId);
    operatorToken = issueTokens({ actorId: operator.id, tenantId: operator.tenantId, partyId: operator.partyId, roles: operator.roles, mfaSatisfied: true }).accessToken;
    // A tenancy with room for a second person: the referred ones are on Solo,
    // whose one seat their founder holds.
    const other = platform.createTenant({ legalName: 'Customer Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', enterpriseName: 'Customer', trialGrant: false });
    const customer = platform.createUser({ tenantId: other.tenant.id, name: 'Cara', email: 'cara@customer.example', roles: ['ENTERPRISE_ADMIN'] });
    customerToken = issueTokens({ actorId: customer.id, tenantId: customer.tenantId, partyId: customer.partyId, roles: customer.roles, mfaSatisfied: true }).accessToken;
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('is the operator’s and nobody else’s', async () => {
    assert.equal((await call('GET', '/v1/admin/growth/position')).status, 401);
    assert.equal((await call('GET', '/v1/admin/growth/position', customerToken)).status, 403);
    const partner = growth.partners(platform)[0]!;
    assert.equal((await call('GET', `/v1/admin/growth/${partner.id}/statement`, customerToken)).status, 403);
  });

  it('reads the position and downloads a statement as CSV', async () => {
    const position = await call('GET', '/v1/admin/growth/position', operatorToken);
    assert.equal(position.status, 200, position.text);
    const parsed = JSON.parse(position.text) as { sweep: unknown[]; people: Array<{ kit: unknown[] }>; health: { score: number } };
    assert.equal(parsed.sweep.length, 11);
    assert.ok(parsed.people.every((entry) => entry.kit.length >= 3));

    const partner = growth.partners(platform).find((entry) => entry.code === 'NQS-2062')!;
    const statement = await call('GET', `/v1/admin/growth/${partner.id}/statement`, operatorToken);
    assert.equal(statement.status, 200, statement.text);
    assert.match(statement.type, /text\/csv/);
    assert.match(statement.text, /^Partner,Northern QS Partners,Code,NQS-2062/);
    assert.equal((await call('GET', '/v1/admin/growth/nobody/statement', operatorToken)).status, 404);
  });
});
