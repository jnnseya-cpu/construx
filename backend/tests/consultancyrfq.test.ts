import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  composeRfqBlocks,
  validateBidPack,
  validateRfqInput,
  type BidPack,
  type RfqInput,
} from '../src/domain/consultancy/rfq.ts';

/**
 * RFQ and bid packs against the spec's §7 machine-checkable acceptance contracts:
 * an RFQ whose evaluation weights reconcile to 100% and which carries mandate,
 * scope, priced core and deliverable acceptance; and a bid where every mandatory
 * requirement is answered or blockered and the price total reconciles including
 * tax, disbursements and optional items.
 */

const VALID_RFQ: RfqInput = {
  title: 'Doncaster–Scunthorpe feasibility',
  organisation: 'North Lincolnshire Council',
  mandate: 'Appoint a consultant to produce a feasibility study and business case.',
  scope: 'Hourly reinstatement and a Sunday service appraisal.',
  deadline: '18 November 2026, 17:00',
  evaluation: [
    { name: 'Methodology', weightPct: 20, type: 'QUALITY' },
    { name: 'Outputs & compliance', weightPct: 20, type: 'QUALITY' },
    { name: 'Experience', weightPct: 20, type: 'QUALITY' },
    { name: 'Team', weightPct: 10, type: 'QUALITY' },
    { name: 'Price', weightPct: 30, type: 'PRICE' },
  ],
  deliverables: [
    { deliverable: 'Options Assessment Report', acceptanceTest: 'Preferred option with constraint disposition and source references' },
    { deliverable: 'Business case', acceptanceTest: 'Five Case Model; economic value and funding separate; scenarios reproduce' },
  ],
  priceLines: [
    { item: 'Core study fee', basis: 'CORE', amountMinor: 2_975_000 },
    { item: 'Additional stakeholder workshop', basis: 'OPTION', amountMinor: 150_000 },
  ],
};

describe('the RFQ issue-pack contract (spec §7)', () => {
  it('passes a complete RFQ whose evaluation weights reconcile to 100%', () => {
    assert.deepEqual(validateRfqInput(VALID_RFQ), []);
  });

  it('flags evaluation weights that do not sum to 100%', () => {
    const bad = { ...VALID_RFQ, evaluation: [{ name: 'Quality', weightPct: 60 }, { name: 'Price', weightPct: 30 }] };
    const issues = validateRfqInput(bad);
    assert.ok(issues.some((i) => i.code === 'WEIGHTS_UNRECONCILED'), 'weights 90% are flagged');
  });

  it('flags a missing mandate, scope, deadline, scoring, acceptance and priced core', () => {
    const empty = { ...VALID_RFQ, mandate: '', scope: '', deadline: '', evaluation: [], deliverables: [], priceLines: [] };
    const codes = validateRfqInput(empty).map((i) => i.code);
    for (const code of ['NO_MANDATE', 'NO_SCOPE', 'NO_DEADLINE', 'NO_SCORING', 'NO_ACCEPTANCE', 'NO_PRICED_CORE']) {
      assert.ok(codes.includes(code), `missing piece flagged: ${code}`);
    }
  });

  it('flags a deliverable with no acceptance test', () => {
    const bad = { ...VALID_RFQ, deliverables: [{ deliverable: 'Report', acceptanceTest: '' }] };
    assert.ok(validateRfqInput(bad).some((i) => i.code === 'DELIVERABLE_NO_ACCEPTANCE'));
  });

  it('composes a pack carrying mandate, scope, evaluation, acceptance and pricing', () => {
    const blocks = composeRfqBlocks(VALID_RFQ);
    const headings = blocks.filter((b) => b.kind === 'HEADING').map((b) => (b as { text: string }).text);
    for (const h of ['Mandate', 'Scope', 'Evaluation', 'Deliverables and acceptance', 'Pricing schedule']) {
      assert.ok(headings.some((x) => x.includes(h)), `pack has a ${h} section`);
    }
    const text = JSON.stringify(blocks);
    assert.ok(text.includes('£29,750.00'), 'the core fee is priced in the schedule');
  });
});

describe('the bid issue-pack contract (spec §7)', () => {
  const PACK: BidPack = {
    requirements: [
      { ref: 'MS1', mandatory: true, response: 'Our methodology…' },
      { ref: 'MS2', mandatory: true, response: 'Outputs mapped…' },
      { ref: 'C1', mandatory: false },
    ],
    priceLines: [
      { item: 'Core fee', amountMinor: 2_480_000, kind: 'CORE' },
      { item: 'Option: workshop', amountMinor: 150_000, kind: 'OPTION' },
      { item: 'Disbursements', amountMinor: 70_000, kind: 'DISBURSEMENT' },
      { item: 'VAT', amountMinor: 540_000, kind: 'TAX' },
    ],
    statedTotalMinor: 3_240_000,
  };

  it('passes a bid where every mandatory requirement is addressed and the total reconciles including tax and disbursements', () => {
    const r = validateBidPack(PACK);
    assert.deepEqual(r.issues, []);
    assert.equal(r.computedTotalMinor, 3_240_000);
    assert.equal(r.reconciles, true);
  });

  it('flags a mandatory requirement with neither a response nor a blocker', () => {
    const bad = { ...PACK, requirements: [{ ref: 'MS1', mandatory: true }] };
    assert.ok(validateBidPack(bad).issues.some((i) => i.code === 'MANDATORY_UNADDRESSED'));
  });

  it('accepts a mandatory requirement addressed by a named blocker', () => {
    const blocked = { ...PACK, requirements: [{ ref: 'MS1', mandatory: true, blocker: 'Awaiting operator confirmation' }] };
    assert.ok(!validateBidPack(blocked).issues.some((i) => i.code === 'MANDATORY_UNADDRESSED'));
  });

  it('flags a price schedule whose stated total does not reconcile with its lines', () => {
    const bad = { ...PACK, statedTotalMinor: 3_000_000 };
    const r = validateBidPack(bad);
    assert.equal(r.reconciles, false);
    assert.ok(r.issues.some((i) => i.code === 'PRICE_UNRECONCILED'));
  });
});
