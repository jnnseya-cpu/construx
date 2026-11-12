import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { quoteFromEstimate } from '../src/domain/quotation.ts';
import { priceEstimate } from '../src/engines/maths/costModel.ts';
import * as structure from '../src/domain/structure.ts';
import * as tender from '../src/engines/tender.ts';
import { approveDocument, bodyBlocks, documentOf, generateRevision, issueDocument, submitForApproval } from '../src/group/issuance.ts';
import { setIssuerProfile } from '../src/group/profile.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * A drawing becomes a quotation.
 *
 * The line was built in pieces and the last piece was missing. A drawing could
 * be read, quantities measured off it and confirmed by a person, and the
 * measured lines priced across the twenty cost heads — and then it stopped.
 * Getting a quotation out meant opening the legal-document screen and retyping
 * the total into a free-text box, which is where the traceability was thrown
 * away: the offer that went to the customer was no longer connected to the
 * estimate it came from.
 *
 * The job under test is the one that prompted it — a £20,000 church wall
 * repair. Small enough that most of the twenty heads are not expected on it,
 * and large enough that getting the price wrong matters to the business.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Retender of the remaining scope following the phase 2 scope change',
  });
});

const qsCtx = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

/** The wall, measured. Three items, the way a take-off off three sheets arrives. */
const WALL_LINES = [
  { description: 'Rake out and repoint in lime mortar', unit: 'm2', quantity: 86, labourRateMinor: 8_500, materialRateMinor: 1_200 },
  { description: 'Rebuild collapsed section in reclaimed stone', unit: 'm2', quantity: 12, labourRateMinor: 24_000, materialRateMinor: 9_000 },
  { description: 'Replace coping, bed and point', unit: 'm', quantity: 34, labourRateMinor: 6_000, materialRateMinor: 4_500 },
];

/**
 * A complete estimate for the wall: every head expected at this size either
 * priced or excluded. Nothing here is a percentage of the works.
 */
function completeEstimate(over: Record<string, unknown> = {}) {
  return tender.buildEstimate(qsCtx(), {
    packageId: 'WALL',
    durationWeeks: 4,
    lines: WALL_LINES,
    quantified: [{ head: 'WASTE', description: 'Skips and gate fees', unit: 'sum', quantity: 1, rateMinor: 45_000 }],
    insurance: { policies: [{ type: 'Contract works and liability', percentOfContractValue: 0.9 }] },
    exclusions: [{ head: 'PLANT', reason: 'Access from a tower scaffold provided by the church' }],
    margin: { overheadPercent: 8, profitPercent: 6 },
    basisOfEstimate: 'Measured off drawings DR-S-1600, DR-S-1601 and DR-C-9020 at revision P01.',
    assumptions: ['Uninterrupted access to the churchyard', 'Lime mortar to the conservation officer’s specification'],
    ...over,
  } as Parameters<typeof tender.buildEstimate>[1]);
}

const QUOTE = {
  clientName: 'St Andrew’s Parochial Church Council',
  validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
  paymentTerms: '30 days from invoice',
};

describe('a priced estimate becomes a quotation', () => {
  it('composes the offer from the estimate rather than from anybody’s memory of it', () => {
    const estimate = completeEstimate();
    const quoted = quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: estimate.estimateId, ...QUOTE });

    assert.equal(quoted.document.documentType, 'quotation');
    assert.equal(quoted.document.status, 'DRAFT');
    assert.equal(quoted.lines, 3);
    // The source record is the estimate, so generation freezes the estimate's
    // version alongside the rows: the offer can be shown to have come from a
    // particular state of a particular estimate.
    assert.deepEqual(quoted.document.source, { refType: 'Estimate', refId: estimate.estimateId });

    const body = quoted.document.body;
    assert.equal(body.Client, QUOTE.clientName);
    assert.equal(body['Payment terms'], '30 days from invoice');
    assert.match(String(body['Basis of this price']), /DR-S-1600/);
    // Every measured line is on the offer, in order, with its quantity — the
    // item number as the label and the works in the value, because a document
    // label holds 80 characters and a measured item is routinely longer.
    assert.match(String(body['Item 1']), /Rake out and repoint in lime mortar — 86 m2/);
    // The assumptions and the exclusion travel with the price as qualifications.
    assert.equal(body['Assumed 1'], 'Uninterrupted access to the churchyard');
    assert.match(
      String(Object.entries(body).find(([label]) => label.startsWith('Not included'))?.[1]),
      /tower scaffold/,
    );
  });

  it('groups excluded heads that share a reason into one qualification, not a row each', () => {
    // A professional-services fee excludes a dozen construction heads for the
    // same reason. Printing one near-identical "Not included N — HEAD" row per
    // head read as a data dump on the issued quotation; they collapse to one row
    // per distinct reason, listing the heads it covers.
    const reason = 'By others under a separate contract';
    const estimate = completeEstimate({
      exclusions: [
        { head: 'PLANT', reason },
        { head: 'TEMPORARY_WORKS', reason },
        { head: 'TESTING', reason },
        { head: 'COMMISSIONING', reason },
      ],
    });
    const quoted = quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: estimate.estimateId, ...QUOTE });
    const body = quoted.document.body;

    const notIncluded = Object.keys(body).filter((key) => key.startsWith('Not included'));
    assert.equal(notIncluded.length, 1, 'four heads sharing one reason should be one row, not four');
    const value = String(body[notIncluded[0]!]);
    assert.match(value, /By others under a separate contract/);
    // The one row names every head it covers, comma-separated, before the reason.
    assert.ok(value.split('—')[0]!.includes(','), 'the grouped row should list the heads it covers');
    // The period reads as English, not "1 weeks".
    assert.equal(body['Period on site'], '4 weeks');
  });

  it('shows the customer a price and never the margin under it', () => {
    const estimate = completeEstimate();
    const quoted = quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: estimate.estimateId, ...QUOTE });

    // The rule the billing screen was corrected for, applied where it matters
    // most: what a customer is sent. Not the overhead, not the profit, not the
    // percentage, and not the cost the price was built on.
    const printed = JSON.stringify(quoted.document.body).toLowerCase();
    for (const forbidden of ['overhead', 'profit', 'margin', 'cost']) {
      assert.ok(!printed.includes(forbidden), `the quotation prints "${forbidden}" to the customer`);
    }
  });

  it('apportions the total across the lines so the offer adds up to itself', () => {
    const estimate = completeEstimate();
    const quoted = quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: estimate.estimateId, ...QUOTE });

    // The money is the last field of the row, after the works and the quantity.
    // Parsing the whole string would pick up the quantity and the dimensions in
    // the description, which is exactly the mistake a client's surveyor makes
    // when a bill is laid out badly.
    const asMinor = (value: unknown): number =>
      Math.round(Number(String(value).split('—').at(-1)!.replace(/[^0-9.]/g, '')) * 100);
    const lineRows = Object.entries(quoted.document.body).filter(([label]) => /^Item \d+$/.test(label));
    const summed = lineRows.reduce((total, [, value]) => total + asMinor(value), 0);

    assert.equal(lineRows.length, 3);
    // Exactly, not nearly. The rounding remainder is carried onto the last
    // line; a quotation whose lines do not sum to its own total is the first
    // thing a client's surveyor finds.
    assert.equal(summed, quoted.totalMinor);
    assert.equal(asMinor(quoted.document.body['Total, excluding VAT']), quoted.totalMinor);
    // And the biggest line by cost is the biggest line by price, because the
    // apportionment is by cost share rather than by order.
    const rebuild = lineRows.find(([, value]) => String(value).includes('Rebuild'))!;
    const coping = lineRows.find(([, value]) => String(value).includes('coping'))!;
    assert.ok(asMinor(rebuild[1]) > asMinor(coping[1]));
  });

  it('carries a measured item longer than a document label, rather than shortening what is offered', () => {
    /*
     * `DOCUMENT_BODY_INVALID … is too long`, on the first real bill. A document
     * label holds 80 characters and a measured item is routinely longer —
     * "Excavation for two number pad foundations, commencing from existing
     * ground level, maximum depth not exceeding 2.0m." is 108. Truncating was
     * never an option: the description is what the customer is being offered,
     * and a quotation that shortens it offers something else.
     */
    const long = 'Excavation for two number pad foundations, commencing from existing ground level, maximum depth not exceeding 2.0m.';
    assert.ok(long.length > 80, 'the fixture is not long enough to exercise the limit');

    const estimate = completeEstimate({
      lines: [{ description: long, unit: 'm3', quantity: 1.69, labourRateMinor: 9_000, materialRateMinor: 2_000 }],
    });
    const quoted = quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: estimate.estimateId, ...QUOTE });

    assert.ok(String(quoted.document.body['Item 1']).includes(long), 'the description was shortened or dropped');
    assert.match(String(quoted.document.body['Item 1']), /1\.69 m3/);
  });

  it('refuses a row longer than a document row holds, rather than cutting it off mid-sentence', () => {
    const estimate = completeEstimate({ basisOfEstimate: 'x'.repeat(2_500) });
    throwsCode(
      () => quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: estimate.estimateId, ...QUOTE }),
      'QUOTATION_FIELD_TOO_LONG',
    );
  });

  it('refuses to quote an estimate carrying a head that is neither priced nor excluded', () => {
    // The same estimate with the plant exclusion removed: plant is expected on
    // a job of any size, so it becomes an omission and the estimate is
    // incomplete. Sending that as a price is how a contractor discovers at
    // final account that nobody priced it.
    const incomplete = completeEstimate({ exclusions: [] });
    assert.ok(incomplete.priced.omissions.includes('PLANT'));

    throwsCode(
      () => quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: incomplete.estimateId, ...QUOTE }),
      'ESTIMATE_INCOMPLETE',
    );
  });

  it('refuses a validity date that has already passed, and an estimate from another project', () => {
    const estimate = completeEstimate();
    throwsCode(
      () =>
        quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, {
          estimateId: estimate.estimateId,
          ...QUOTE,
          validUntil: '2020-01-01',
        }),
      'VALID_UNTIL_PAST',
    );
    // A record id from somewhere else is answered exactly as a record that does
    // not exist.
    assert.throws(
      () => quoteFromEstimate(platform, qsCtx(), seed.users.qs!.auth, { estimateId: 'not-an-estimate', ...QUOTE }),
      /No estimate not-an-estimate on this project/,
    );
  });

  it('goes on through the lifecycle that already existed, to numbered branded bytes', () => {
    const actor = seed.users.qs!.auth;
    const approver = seed.users.admin!.auth;

    // The company's registered details, recorded before anything is drafted.
    // A revision is frozen against the issuer profile version it was generated
    // under, so a company that records its details halfway through has to
    // generate again — which is the lifecycle protecting the manifest, not an
    // obstacle to work around here.
    setIssuerProfile(platform, approver, {
      issuer: {
        registrationNo: '08442119',
        registeredAddress: { line1: '14 Bury Road', line2: '', city: 'Rawtenstall', postcode: 'BB4 6AA', country: 'United Kingdom' },
      },
      // The prefix once. This fixture carried it twice — `prefix: 'QUO'` with
      // `pattern: 'QUO-…'` — and numbered the quotation **QUOQUO-2026-0001**,
      // which nothing caught because the assertion below only asked whether a
      // number came back at all. It now asks what the number is.
      numberingRules: { quotation: { prefix: 'QUO-', pattern: '{YYYY}-{seq:4}', seqScope: 'year' } },
    });

    const estimate = completeEstimate();
    const quoted = quoteFromEstimate(platform, qsCtx(), actor, { estimateId: estimate.estimateId, ...QUOTE });

    // Nothing new is built here. The quotation is a legal instrument like any
    // other from the moment it is drafted: frozen into a hashed manifest,
    // approved by that hash, issued once under a reserved number.
    const generated = generateRevision(platform, actor, quoted.document.id, {});
    submitForApproval(platform, actor, quoted.document.id);
    const hash = generated.revisions.at(-1)!.hash;

    // The surveyor who priced it does not approve it. Where the company has
    // named no signatory for a quotation, a company administrator does — which
    // is the existing rule, met by a document that arrived from the estimating
    // line rather than by one somebody typed.
    throwsCode(() => approveDocument(platform, actor, quoted.document.id, { revision: 1, hash }), 'SIGNATORY_REQUIRED');

    approveDocument(platform, approver, quoted.document.id, { revision: 1, hash });
    const issued = issueDocument(platform, approver, quoted.document.id, { idempotencyKey: `quote-${quoted.document.id}` });

    assert.equal(issued.document.status, 'ISSUED');
    assert.match(
      String(issued.issuance.number),
      /^QUO-\d{4}-\d{4}$/,
      `the quotation went out numbered ${issued.issuance.number}`,
    );
    // What was approved is what was issued.
    assert.equal(documentOf(platform, actor.tenantId, quoted.document.id).revisions.at(-1)!.approval?.hash, hash);

    // And once it is issued, a second priced offer for the same job supersedes
    // it rather than taking a second number — the mess the first real bidder
    // hit, five numbered quotations for one job. A fresh estimate on the same
    // project is refused with the reason, not silently given its own number.
    const reprice = completeEstimate();
    throwsCode(
      () => quoteFromEstimate(platform, qsCtx(), actor, { estimateId: reprice.estimateId, ...QUOTE }),
      'QUOTATION_ALREADY_ISSUED',
    );
  });
});

describe('a measured line with no rate against it', () => {
  it('is named rather than priced at nothing', () => {
    // The failure this closes. A take-off hands over descriptions, units and
    // quantities; the rates are the estimator's. A line that arrived without
    // one contributed nothing to the total and said nothing about it, which is
    // the same silence the model refuses one level up where a head with no
    // basis is reported as unpriced rather than as zero.
    const priced = priceEstimate({
      durationWeeks: 4,
      lines: [...WALL_LINES, { description: 'Replace two gate piers', unit: 'nr', quantity: 2 }],
      margin: { overheadPercent: 8, profitPercent: 6 },
    });

    const warning = priced.warnings.find((w) => w.includes('no rate'));
    assert.ok(warning, `nothing said that a line was unrated: ${priced.warnings.join(' | ')}`);
    assert.match(warning, /Replace two gate piers \(2 nr\)/);
  });

  it('says nothing where every line carries one', () => {
    const priced = priceEstimate({
      durationWeeks: 4,
      lines: WALL_LINES,
      margin: { overheadPercent: 8, profitPercent: 6 },
    });
    assert.equal(priced.warnings.filter((w) => w.includes('no rate')).length, 0);
  });
});

describe('a take-off a surveyor did by hand', () => {
  it('creates the bill without calling a provider or spending anything', async () => {
    /*
     * The blocker this closes. `runTakeoff` always ran a perception model, so
     * the only route to a bill of quantities went through a provider — and a
     * company with no AI credit could not price a job it had already measured
     * with a scale rule. It was also charging for a reading nobody performed.
     */
    const ctx = qsCtx();
    const before = platform.wallet(ctx.tenantId).availableMinor();

    const taken = await tender.runTakeoff(ctx, {
      packageId: 'WALL-MANUAL',
      sources: [{ discipline: 'STRUCTURES', sheetId: '25133-TDC-FN-ZZ-DR-S-1600' }],
      costCodePrefix: 'WALL',
      measuredBy: 'PERSON',
      items: WALL_LINES.map((line) => ({ description: line.description, unit: line.unit, quantity: line.quantity })),
    });

    assert.equal(taken.acuConsumed, 0, 'a hand measurement was charged for');
    assert.equal(platform.wallet(ctx.tenantId).availableMinor(), before, 'the wallet moved on a measurement nobody read');
    assert.equal(taken.boqItemIds.length, 3);

    const item = platform.ledger.require({ refType: 'BoQItem', refId: taken.boqItemIds[0]! });
    assert.equal(item.state.measuredBy, 'PERSON');
    assert.equal(item.state.costCode, 'WALL.001');
    assert.equal(item.state.sourceSheet, undefined);
    assert.equal(item.state.measurementRule, 'NRM2');
    // No confidence score. A number here would be a score for a reading that
    // did not happen, and the estimator reads this field to decide how far to
    // trust the quantity.
    assert.equal(item.state.confidenceScore, null);
  });
});

// ── The issued quotation reads as a priced schedule, not a data dump ──────────
describe('a quotation body renders its priced lines as a table', () => {
  it('lifts the "Item N" rows into a table and keeps the rest as key/values, in order', () => {
    const blocks = bodyBlocks({
      Client: 'Telford and Wrekin Council',
      'Period on site': '1 week',
      'Item 1': 'Senior Project Manager — Review brief, confirm deliverables, lead mobilisation — 1.5 person-day — £1,087.50',
      'Item 2': 'Project Director — Review final submission before issue — 0.5 person-day — £437.50',
      'Item 3': 'Travel — £250.00',
      'Total, excluding VAT': '£10,750.00',
      'Payment terms': '28 days from the invoice',
    });

    // Header, then the item table, then the summary — three blocks, in order.
    assert.equal(blocks.length, 3);
    assert.equal(blocks[0]!.kind, 'KEY_VALUES');
    assert.equal(blocks[1]!.kind, 'TABLE');
    assert.equal(blocks[2]!.kind, 'KEY_VALUES');

    const table = blocks[1] as { kind: 'TABLE'; headers: string[]; rows: string[][] };
    assert.deepEqual(table.headers, ['#', 'Description', 'Quantity', 'Amount']);
    // The description keeps its own em-dash; quantity and amount split off the end.
    assert.deepEqual(table.rows[0], ['1', 'Senior Project Manager — Review brief, confirm deliverables, lead mobilisation', '1.5 person-day', '£1,087.50']);
    assert.deepEqual(table.rows[1], ['2', 'Project Director — Review final submission before issue', '0.5 person-day', '£437.50']);
    // A fixed sum with no quantity still lands in the table, quantity column empty.
    assert.deepEqual(table.rows[2], ['3', 'Travel', '', '£250.00']);

    // The summary rows the client reads below the table.
    const summary = blocks[2] as { kind: 'KEY_VALUES'; rows: Array<{ label: string; value: string }> };
    assert.ok(summary.rows.some((r) => r.label === 'Total, excluding VAT' && r.value === '£10,750.00'));
  });

  it('leaves a body with no priced lines exactly as it was — one key/value block', () => {
    const blocks = bodyBlocks({ Client: 'Acme', Reference: 'INV-1', Amount: '£100.00' });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.kind, 'KEY_VALUES');
  });
});
