import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as costintel from '../src/domain/costintel.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Importing a rate card into the cost-intelligence library.
 *
 * The feature exists so a firm with no committed history — a one-person firm
 * pricing its first bid most of all — can seed the library from its own rate
 * card in one paste instead of building every rate by hand. The point of these
 * tests is the honesty of it: an imported rate is the firm's own number, loaded
 * under its own name, and it must never read as more than a THIN starting point
 * until a committed bid proves the item. No amount of re-importing may inflate
 * it; only real committed observations lift a key.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds ESTIMATE_TENDER C — may import a rate card. Tenant-scoped, like the library. */
const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds no ESTIMATE_TENDER at all — the authorisation this command refuses. */
const asSafety = () => platform.context(seed.users.safety!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/** The library as it stands for this tenancy. */
const library = () => costintel.costIntelligence(asQS());

/** A summary for a description/unit, by the same key the library groups on. */
function rateFor(description: string, unit: string) {
  const key = costintel.rateKey(description, unit);
  return library().rates.find((rate) => rate.key === key);
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// --- The honesty guard, at the unit it is enforced ---------------------------

describe('confidenceCap keeps an imported rate from buying confidence', () => {
  const observation = (source: 'ESTIMATE' | 'IMPORTED'): costintel.RateObservation => ({
    key: 'k',
    description: 'x',
    unit: 'm',
    rateMinor: 1000,
    quantity: 1,
    components: { labourMinor: 0, materialMinor: 0, plantMinor: 0, subcontractMinor: 0 },
    projectId: source === 'IMPORTED' ? '' : 'p',
    projectName: 'x',
    estimateId: 'e',
    observedOn: '2026-01-01',
    source,
  });
  const bucket = (committed: number, imported: number) => [
    ...Array.from({ length: committed }, () => observation('ESTIMATE')),
    ...Array.from({ length: imported }, () => observation('IMPORTED')),
  ];

  it('lifts an empty key to exactly THIN, and no higher however many imported', () => {
    assert.equal(costintel.confidenceCap(bucket(0, 1)), 'THIN');
    // Even if the replace guard ever failed and a key held many imported
    // entries, the count of them cannot push confidence past THIN: only
    // committed observations are counted toward it.
    assert.equal(costintel.confidenceCap(bucket(0, 9)), 'THIN');
  });

  it('lets committed observations raise confidence as they always did', () => {
    assert.equal(costintel.confidenceCap(bucket(1, 0)), 'THIN');
    assert.equal(costintel.confidenceCap(bucket(3, 0)), 'USABLE');
    assert.equal(costintel.confidenceCap(bucket(8, 0)), 'STRONG');
  });

  it('counts only the committed observations when the two are mixed', () => {
    // An imported rate alongside committed ones changes the provenance, never
    // the number: the confidence is whatever the committed observations alone
    // would give.
    assert.equal(costintel.confidenceCap(bucket(2, 5)), 'THIN');
    assert.equal(costintel.confidenceCap(bucket(3, 4)), 'USABLE');
    assert.equal(costintel.confidenceCap(bucket(8, 1)), 'STRONG');
  });

  it('is identical to confidenceFor when nothing is imported, so nothing regresses', () => {
    for (const n of [0, 1, 2, 3, 5, 8, 20]) {
      assert.equal(costintel.confidenceCap(bucket(n, 0)), costintel.confidenceFor(n));
    }
  });
});

// --- (a) an imported rate reaches the library, keyed, THIN and imported ------

describe('an imported rate card seeds the library', () => {
  it('appears in cost intelligence keyed correctly, at THIN, tagged imported', () => {
    const result = costintel.importRateCard(asQS(), {
      entries: [{ line: 1, code: 'E20.007', description: 'Facing-brick outer leaf', unit: 'm2', rateMinor: 14_500, raw: 'E20.007, Facing-brick outer leaf, m2, 145' }],
    });
    assert.equal(result.totals.imported, 1);
    assert.equal(result.imported[0]!.status, 'NEW');

    const rate = rateFor('Facing-brick outer leaf', 'm2');
    assert.ok(rate, 'the imported rate is not in the library');
    assert.equal(rate!.confidence, 'THIN');
    assert.equal(rate!.provenance, 'IMPORTED');
    assert.equal(rate!.importedObservations, 1);
    assert.equal(rate!.committedObservations, 0);
    assert.equal(rate!.medianMinor, 14_500);
    assert.equal(rate!.projects, 0, 'an imported rate belongs to no project');
    assert.match(rate!.caveat ?? '', /rate card/i);
  });

  it('stores the firm’s own reference and takes the code-less form too', () => {
    costintel.importRateCard(asQS(), {
      entries: [{ line: 1, description: 'Blockwork inner leaf 100mm', unit: 'm2', rateMinor: 6_200, raw: 'Blockwork inner leaf 100mm, m2, 62' }],
    });
    const rate = rateFor('Blockwork inner leaf 100mm', 'm2');
    assert.ok(rate);
    assert.equal(rate!.provenance, 'IMPORTED');
    assert.equal(rate!.medianMinor, 6_200);
  });
});

// --- (b) a malformed line is reported, not silently dropped ------------------

describe('a malformed line is reported rather than dropped', () => {
  it('names which line failed and why, and imports the rest', () => {
    const result = costintel.importRateCard(asQS(), {
      entries: [
        { line: 1, description: 'Topsoil strip 300mm', unit: 'm2', rateMinor: 310, raw: 'Topsoil strip 300mm, m2, 3.10' },
        { line: 2, description: 'Half a line, no rate', unit: 'm', raw: 'Half a line, no rate, m' },
        { line: 3, description: 'No unit here', rateMinor: 500, raw: 'No unit here, , 5' },
        { line: 4, unit: 'm3', rateMinor: 900, raw: ', , m3, 9' },
      ],
    });

    assert.equal(result.totals.imported, 1, 'only the one valid line should import');
    assert.equal(result.totals.skipped, 3);
    const lines = result.skipped.map((s) => s.line).sort();
    assert.deepEqual(lines, [2, 3, 4]);
    assert.ok(result.skipped.every((s) => typeof s.reason === 'string' && s.reason.length > 0));
    // The reasons name the actual fault, not a generic failure.
    assert.match(result.skipped.find((s) => s.line === 2)!.reason, /rate/i);
    assert.match(result.skipped.find((s) => s.line === 3)!.reason, /unit/i);
    assert.match(result.skipped.find((s) => s.line === 4)!.reason, /description/i);

    // The dropped lines are nowhere in the library.
    assert.equal(rateFor('No unit here', ''), undefined);
  });

  it('refuses an empty import outright', () => {
    throwsCode(() => costintel.importRateCard(asQS(), { entries: [] }), 'RATE_CARD_EMPTY');
  });
});

// --- (c) re-importing a key cannot push it past THIN -------------------------

describe('re-importing the same key does not manufacture confidence', () => {
  it('replaces the entry rather than stacking, and stays THIN with one observation', () => {
    const entry = (rateMinor: number) => ({
      entries: [{ line: 1, description: 'Precast concrete kerb', unit: 'm', rateMinor, raw: `Precast concrete kerb, m, ${rateMinor / 100}` }],
    });

    const first = costintel.importRateCard(asQS(), entry(2_600));
    assert.equal(first.imported[0]!.status, 'NEW');

    // Three more imports of the same item at different rates.
    costintel.importRateCard(asQS(), entry(2_700));
    costintel.importRateCard(asQS(), entry(2_800));
    const last = costintel.importRateCard(asQS(), entry(2_900));
    assert.equal(last.imported[0]!.status, 'REPLACED');

    // One entry on the ledger for this key, not four.
    const key = costintel.rateKey('Precast concrete kerb', 'm');
    const entries = platform.ledger
      .listByTenant(seed.tenantId, 'RateCardEntry')
      .filter((record) => (record.state as { key?: string }).key === key);
    assert.equal(entries.length, 1, 're-importing a key must replace, not stack');

    const rate = rateFor('Precast concrete kerb', 'm');
    assert.ok(rate);
    assert.equal(rate!.confidence, 'THIN', 'imported rates can never climb past THIN');
    assert.equal(rate!.importedObservations, 1);
    assert.equal(rate!.observations, 1);
    // The last rate imported is the one that stands.
    assert.equal(rate!.medianMinor, 2_900);
  });

  it('keeps only the last line when the same item appears twice in one paste', () => {
    const result = costintel.importRateCard(asQS(), {
      entries: [
        { line: 1, description: 'Geotextile separation layer', unit: 'm2', rateMinor: 180, raw: 'Geotextile separation layer, m2, 1.80' },
        { line: 2, description: 'Geotextile separation layer', unit: 'm2', rateMinor: 195, raw: 'Geotextile separation layer, m2, 1.95' },
      ],
    });
    assert.equal(result.totals.imported, 1);
    assert.equal(result.totals.skipped, 1);
    assert.equal(result.skipped[0]!.line, 1);
    const rate = rateFor('Geotextile separation layer', 'm2');
    assert.equal(rate!.medianMinor, 195);
    assert.equal(rate!.importedObservations, 1);
  });
});

// --- (d) a committed observation still raises and combines correctly ---------

describe('a committed-bid observation outweighs an imported one', () => {
  it('combines them into a MIXED rate whose confidence the committed side drives', () => {
    // A rate the demonstration estate already committed on a frozen estimate.
    const description = 'Bulk excavation in made ground';
    const unit = 'm3';
    const before_ = rateFor(description, unit);
    assert.ok(before_, 'the seed no longer carries this committed rate — pick another');
    assert.equal(before_!.provenance, 'COMMITTED');
    const committedConfidence = before_!.confidence;
    const committedCount = before_!.committedObservations;

    // Import the very same item at a deliberately different figure.
    costintel.importRateCard(asQS(), {
      entries: [{ line: 1, description, unit, rateMinor: before_!.medianMinor + 5_000, raw: `${description}, ${unit}, x` }],
    });

    const after = rateFor(description, unit);
    assert.ok(after);
    assert.equal(after!.provenance, 'MIXED');
    assert.equal(after!.committedObservations, committedCount, 'the committed count must not change');
    assert.equal(after!.importedObservations, 1);
    assert.equal(after!.observations, committedCount + 1);
    // The imported figure did not inflate confidence: the committed side drives it.
    assert.equal(after!.confidence, committedConfidence);
    // And the imported figure is a real data point in the spread.
    assert.ok(after!.highMinor >= before_!.medianMinor + 5_000);
    assert.match(after!.caveat ?? '', /imported/i);
  });
});

// --- (e) authorisation is enforced, and the record is governed human-only ----

describe('importing a rate card is an authorised, human act', () => {
  it('refuses a role without ESTIMATE_TENDER create', () => {
    throwsCode(
      () => costintel.importRateCard(asSafety(), { entries: [{ line: 1, description: 'Anything at all', unit: 'm', rateMinor: 100 }] }),
      'ACCESS_DENIED',
    );
  });

  it('is in the catalogue as a human-authored import, and the entity is classified commercial', () => {
    const definition = lookupEventType('RATE_CARD_IMPORTED');
    assert.ok(definition, 'RATE_CARD_IMPORTED is not in the catalogue');
    assert.equal(definition!.aiAllowed, false, 'what a firm says its own rates are is not a model’s to assert');
    assert.equal(definition!.entity, 'RateCardEntry');

    const classification = classifyEntity('RateCardEntry');
    assert.ok(classification, 'RateCardEntry is not classified, so the generic entity read would refuse it to everyone');
    assert.equal(classification!.area, 'ESTIMATE_TENDER');
    assert.equal(classification!.sensitivity, 'COMMERCIAL_L3');
  });
});

describe('a per-tender rate is held for its bid and kept out of the permanent library', () => {
  /*
   * Bid-On prices one-off external customers whose rates are not the firm's own.
   * A per-tender import is scoped to one bid: available to price that bid, and
   * never harvested into the cross-tender library, so a one-off job's rates
   * cannot become a house rate. Re-importing the tender replaces its own rates
   * and never touches the permanent ones; two bids hold the same key apart.
   */
  const BID = 'bid-tender-scope-1';
  const OTHER = 'bid-tender-scope-2';

  it('imports against a bid, reads back per bid, and never enters the firm library', () => {
    // A permanent library rate, the control: it IS in the library.
    costintel.importRateCard(asQS(), {
      entries: [{ line: 1, description: 'Permanent library item', unit: 'm2', rateMinor: 5000 }],
    });
    assert.ok(rateFor('Permanent library item', 'm2'), 'the firm’s own imported rate should be in the library');

    // A per-tender rate for one bid.
    const result = costintel.runRateCardImport(
      asQS(),
      [{ line: 1, description: 'One-off customer rate', unit: 'nr', rateMinor: 42000 }],
      { bidId: BID },
    );
    assert.equal(result.totals.imported, 1);
    assert.match(result.note, /held for this tender only/);

    // Readable as this bid's own set.
    const held = costintel.tenderRateEntries(asQS(), BID);
    assert.equal(held.length, 1);
    assert.equal(held[0]!.description, 'One-off customer rate');
    assert.equal(held[0]!.bidId, BID);

    // But NOT in the permanent library, by any of its reads.
    assert.equal(rateFor('One-off customer rate', 'nr'), undefined, 'a per-tender rate leaked into the permanent library');
    const harvested = costintel.harvestRates(asQS());
    assert.equal(
      harvested.filter((o) => o.description === 'One-off customer rate').length,
      0,
      'a per-tender rate was harvested into the firm’s own rate history',
    );
  });

  it('keeps each bid’s rates apart and replaces only within a bid on re-import', () => {
    costintel.runRateCardImport(asQS(), [{ line: 1, description: 'Shared key item', unit: 'nr', rateMinor: 10000 }], { bidId: BID });
    costintel.runRateCardImport(asQS(), [{ line: 1, description: 'Shared key item', unit: 'nr', rateMinor: 20000 }], { bidId: OTHER });

    // Same key, two bids, two independent rates.
    assert.equal(costintel.tenderRateEntries(asQS(), BID).find((e) => e.description === 'Shared key item')?.rateMinor, 10000);
    assert.equal(costintel.tenderRateEntries(asQS(), OTHER).find((e) => e.description === 'Shared key item')?.rateMinor, 20000);

    // Re-importing one bid replaces that bid's rate and leaves the other's alone.
    costintel.runRateCardImport(asQS(), [{ line: 1, description: 'Shared key item', unit: 'nr', rateMinor: 15000 }], { bidId: BID });
    assert.equal(costintel.tenderRateEntries(asQS(), BID).find((e) => e.description === 'Shared key item')?.rateMinor, 15000);
    assert.equal(costintel.tenderRateEntries(asQS(), OTHER).find((e) => e.description === 'Shared key item')?.rateMinor, 20000);
    // And neither is in the permanent library.
    assert.equal(rateFor('Shared key item', 'nr'), undefined);
  });

  it('an empty per-tender import is refused like any other', () => {
    throwsCode(() => costintel.runRateCardImport(asQS(), [], { bidId: BID }), 'RATE_CARD_EMPTY');
  });
});
