import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as bidOnCostModel from '../src/domain/bidon/costmodel.ts';
import * as costintel from '../src/domain/costintel.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';

/**
 * A rate card imported for one Bid-On tender.
 *
 * Bid-On prices external customers, many of them one-off, whose rates are not
 * the firm's own. A per-tender import gives a bid the same paste/CSV convenience
 * as the permanent library, but scoped to that bid: usable to price it, and
 * deliberately never harvested into the firm's cross-tender library — so a
 * one-off customer's rates cannot quietly become a house rate.
 */

let platform: Platform;
let seed: SeedResult;
let bidId: string;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds no BID_ON-relevant write permission — the refusal the import enforces. */
const asSafety = (): EngineContext =>
  platform.context(seed.users.safety!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const ENTRIES = [
  { line: 1, code: 'E20.007', description: 'Facing-brick outer leaf', unit: 'm2', rateMinor: 14500, note: 'supply and fix' },
  { line: 2, description: 'Scaffold to single storey', unit: 'week', rateMinor: 90000 },
];

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
  const customer = customers.openCustomer(asProviderAdmin(), { legalName: 'One-Off Shopfit Ltd' });
  // The bid writer prices the bid, so they must be staff on the customer.
  customers.assignStaff(asProviderAdmin(), customer.id, { add: [asBidWriter().auth.actorId] });
  const engagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: customer.id,
    name: 'Shopfit ITT',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 150_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), engagement.id);
  const bid = bids.createBid(asProviderAdmin(), {
    engagementId: engagement.id,
    buyerName: 'A District Council',
    scheme: 'OPEN',
    deadline: '2027-06-01',
  });
  bidId = bid.id;
});

describe('a rate card imported for one Bid-On tender', () => {
  it('imports against the bid and reads back as that bid’s own set', () => {
    const result = bidOnCostModel.importTenderRateCard(asBidWriter(), bidId, { entries: ENTRIES });
    assert.equal(result.totals.imported, 2);
    assert.match(result.note, /held for this tender only/);

    const held = bidOnCostModel.tenderRateCard(asBidWriter(), bidId);
    assert.equal(held.bidId, bidId);
    assert.equal(held.rates.length, 2);
    const brick = held.rates.find((r) => r.description === 'Facing-brick outer leaf');
    assert.equal(brick?.rateMinor, 14500);
    assert.equal(brick?.unit, 'm2');
    assert.equal(brick?.confidence, 'THIN');
    assert.equal(brick?.code, 'E20.007');
  });

  it('never enters the firm’s permanent rate library', () => {
    // Imported above; assert exclusion from every permanent-library read.
    const library = costintel.costIntelligence(asBidWriter());
    assert.equal(
      library.rates.some((r) => r.description === 'Facing-brick outer leaf'),
      false,
      'a per-tender Bid-On rate leaked into the permanent library',
    );
    const harvested = costintel.harvestRates(asBidWriter());
    assert.equal(harvested.filter((o) => o.description === 'Scaffold to single storey').length, 0);
  });

  it('refuses a caller without the Bid-On write permission', () => {
    throwsCode(() => bidOnCostModel.importTenderRateCard(asSafety(), bidId, { entries: ENTRIES }), 'ACCESS_DENIED');
  });

  it('refuses an empty import', () => {
    throwsCode(() => bidOnCostModel.importTenderRateCard(asBidWriter(), bidId, { entries: [] }), 'RATE_CARD_EMPTY');
  });

  it('exposes both HTTP routes', () => {
    assert.ok(
      ROUTES.some((r) => r.method === 'POST' && r.pattern === '/v1/bid-on/bids/:bidId/rate-card/import'),
      'the per-tender import route is not registered',
    );
    assert.ok(
      ROUTES.some((r) => r.method === 'GET' && r.pattern === '/v1/bid-on/bids/:bidId/rate-card'),
      'the per-tender read route is not registered',
    );
  });
});
