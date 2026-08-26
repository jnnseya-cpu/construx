import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as measurement from '../src/domain/measurement.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Measurement and the bill — T-WF-03.
 *
 * The estimate above this already worked: twenty cost heads, time-related costs
 * by the week, contingency from the risk register. What these tests are about is
 * the layer underneath, where a bid is actually lost — the measured items, and
 * whether anybody can say where each quantity came from.
 *
 * Three failures, and all three are silent at the time and expensive later. A
 * quantity nobody can trace back to a drawing. A formula that does not produce
 * the number written beside it. And a drawing reissued mid-tender, after which
 * nobody knows which lines are now wrong.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds BOQ_TAKEOFF C/U and ESTIMATE_TENDER U — measures and builds rates. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Holds ESTIMATE_TENDER A — the freeze. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

const measured = (over: Partial<measurement.MeasuredItem> = {}): measurement.MeasuredItem => ({
  reference: 'F.10.1',
  description: 'Reinforced concrete foundations, 40 N/mm²',
  unit: 'm3',
  quantity: 96,
  basis: 'MEASURED',
  source: { drawing: 'ASH-ST-1001', revision: 'B', sheet: '1 of 4' },
  ...over,
});

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // BOQ_TAKEOFF and ESTIMATE_TENDER are gated to CONCEPT, DESIGN and TENDER;
  // the demo project finishes in OPERATIONS.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to measure the substructure package for this bid',
  });
});

// ── The formula, on its own ─────────────────────────────────────────────────

describe('measurement · the formula is re-evaluated, not trusted', () => {
  it('evaluates the arithmetic a take-off sheet actually contains', () => {
    assert.equal(measurement.evaluateFormula('12.4 * 3.85 * 2'), 95.48);
    assert.equal(measurement.evaluateFormula('(4.2 + 3.8) * 6'), 48);
    assert.equal(measurement.evaluateFormula('120 - 18.5'), 101.5);
    assert.equal(measurement.evaluateFormula('96'), 96);
  });

  it('respects precedence, because a bill full of mixed operators depends on it', () => {
    assert.equal(measurement.evaluateFormula('2 + 3 * 4'), 14);
    assert.equal(measurement.evaluateFormula('(2 + 3) * 4'), 20);
  });

  /**
   * This parses text arriving over an API. The only safe evaluator for that is
   * one that cannot express anything but arithmetic, so anything else has to
   * come back as unreadable rather than being run.
   */
  it('refuses anything that is not arithmetic', () => {
    assert.equal(measurement.evaluateFormula('process.exit(1)'), undefined);
    assert.equal(measurement.evaluateFormula('length * width'), undefined);
    assert.equal(measurement.evaluateFormula('12 *'), undefined);
    assert.equal(measurement.evaluateFormula('((4 + 2)'), undefined);
    assert.equal(measurement.evaluateFormula(''), undefined);
  });

  it('refuses a division by zero rather than returning infinity', () => {
    assert.equal(measurement.evaluateFormula('12 / 0'), undefined);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('measurement · what the bill says has to be true', () => {
  const codes = (findings: measurement.MeasurementFinding[]) => findings.map((f) => f.subject);

  it('passes a clean set of items', () => {
    assert.deepEqual(measurement.validateItems([measured(), measured({ reference: 'F.10.2', quantity: 12 })]), []);
  });

  /** `AC-T-WF-03-01`. */
  it('refuses a measured quantity that names no drawing or model', () => {
    const findings = measurement.validateItems([measured({ source: {} })]);
    assert.equal(findings[0]?.severity, 'CRITICAL');
    assert.match(findings[0]!.subject, /names no drawing or model/);
  });

  it('refuses a drawing named without its revision', () => {
    const findings = measurement.validateItems([measured({ source: { drawing: 'ASH-ST-1001' } })]);
    assert.equal(findings[0]?.severity, 'CRITICAL');
    assert.match(findings[0]!.detail, /Rev A and Rev D are different drawings/);
  });

  it('accepts a model object set as a source in place of a drawing', () => {
    assert.deepEqual(measurement.validateItems([measured({ source: { modelObjectSet: 'IFC:Substructure:Slabs' } })]), []);
  });

  /** `AC-T-WF-03-01`'s other half: an allowance has no drawing, so it needs a person. */
  it('refuses an allowance with no basis and nobody behind it', () => {
    const findings = measurement.validateItems([measured({ basis: 'ALLOWANCE', source: {} })]);
    assert.match(findings[0]!.subject, /allowance with no authorised basis/);
  });

  it('accepts an allowance that names its basis and who agreed it', () => {
    assert.deepEqual(
      measurement.validateItems([
        measured({ basis: 'ALLOWANCE', source: { allowanceBasis: 'Ashworth Phase 1 outturn, £84/m³', authorisedBy: 'Commercial Manager' } }),
      ]),
      [],
    );
  });

  it('catches the transposition between a formula and the quantity beside it', () => {
    const findings = measurement.validateItems([measured({ quantity: 94.58, formula: '12.4 * 3.85 * 2' })]);
    assert.equal(findings[0]?.severity, 'CRITICAL');
    assert.match(findings[0]!.subject, /states 94\.58 m3 and its formula gives 95\.48/);
  });

  /**
   * Quantities are rounded when they are written down. Insisting on exactness
   * would produce a finding on every line of a hundred-item bill, and a report
   * nobody reads catches nothing.
   */
  it('tolerates the rounding a written-down quantity carries', () => {
    assert.deepEqual(measurement.validateItems([measured({ quantity: 95.5, formula: '12.4 * 3.85 * 2' })]), []);
  });

  it('reports an unreadable formula without claiming the quantity is wrong', () => {
    const findings = measurement.validateItems([measured({ formula: 'length x width' })]);
    assert.equal(findings[0]?.severity, 'MAJOR');
    assert.match(findings[0]!.subject, /cannot be read/);
  });

  it('refuses the same reference twice', () => {
    const findings = measurement.validateItems([measured(), measured({ quantity: 40 })]);
    assert.ok(codes(findings).some((s) => /appears 2 times/.test(s)));
  });

  it('refuses the same reference measured in two units', () => {
    const findings = measurement.validateItems([measured(), measured({ unit: 'm2', quantity: 400 })]);
    assert.ok(codes(findings).some((s) => /measured in m3 and m2/.test(s)));
  });

  it('refuses a negative quantity, which is an omission dressed as a correction', () => {
    const findings = measurement.validateItems([measured({ quantity: -12 })]);
    assert.equal(findings[0]?.severity, 'CRITICAL');
  });

  it('reports a measured zero without blocking, because it may be a line still to measure', () => {
    const findings = measurement.validateItems([measured({ quantity: 0 })]);
    assert.equal(findings[0]?.severity, 'MAJOR');
    assert.match(findings[0]!.detail, /not a measurement/);
  });

  it('reports a broken hierarchy', () => {
    const findings = measurement.validateItems([measured({ parent: 'F.10' })]);
    assert.equal(findings[0]?.severity, 'MAJOR');
    assert.match(findings[0]!.subject, /which is not in the schedule/);
  });
});

// ── The rate build-up ───────────────────────────────────────────────────────

describe('measurement · a rate is built from what the work costs', () => {
  it('multiplies constants by costs and rounds once at the end', () => {
    const rate = measurement.buildRate(
      'F.10.1',
      [
        { kind: 'LABOUR', description: 'Concretor', unitCostMinor: 28_40, constant: 0.85 },
        { kind: 'MATERIAL', description: 'C40 ready-mix', unitCostMinor: 118_00, constant: 1.02, wastePercent: 5 },
        { kind: 'PLANT', description: 'Poker vibrator', unitCostMinor: 6_20, constant: 0.4 },
      ],
      'actor-1',
    );
    // 2840×0.85 = 2414; 11800×1.02×1.05 = 12637.8; 620×0.4 = 248. Total 15299.8.
    assert.equal(rate.rateMinor, 15_300);
    assert.equal(rate.byKind.LABOUR, 2_414);
    assert.equal(rate.byKind.MATERIAL, 12_638);
    assert.equal(rate.byKind.PLANT, 248);
    assert.equal(rate.byKind.SUBCONTRACT, 0);
  });

  /**
   * Rounding four components and adding them is a different number from adding
   * and rounding once, and on ten thousand square metres the difference is real
   * money. This is the case where they differ.
   */
  it('rounds the total once rather than per component', () => {
    const rate = measurement.buildRate(
      'X',
      [
        { kind: 'LABOUR', description: 'a', unitCostMinor: 100, constant: 0.004 },
        { kind: 'PLANT', description: 'b', unitCostMinor: 100, constant: 0.004 },
      ],
      'actor-1',
    );
    // 0.4 + 0.4 = 0.8 → 1. Rounding each first would give 0 + 0 = 0.
    assert.equal(rate.rateMinor, 1);
  });
});

// ── Through the schedule ────────────────────────────────────────────────────

describe('measurement · the schedule', () => {
  let scheduleId: string;

  before(() => {
    scheduleId = measurement.openSchedule(asQS(), {
      packageReference: 'PKG-SUB',
      title: 'Substructure — measured works',
    }).scheduleId;
  });

  it('opens with a reference and no items', () => {
    const totals = measurement.scheduleTotals(asQS(), scheduleId);
    assert.match(totals.reference, /^MS-\d{3}$/);
    assert.equal(totals.items.length, 0);
    assert.equal(totals.directCostMinor, 0);
  });

  it('refuses a schedule that names neither a package nor what it is', () => {
    throwsCode(() => measurement.openSchedule(asQS(), { packageReference: '  ', title: 'x' }), 'SCHEDULE_UNNAMED');
  });

  it('records items and reports what is wrong with them without refusing the record', () => {
    const { total, findings } = measurement.recordItems(asQS(), scheduleId, [
      measured(),
      measured({ reference: 'F.10.2', description: 'Blinding, 50mm', unit: 'm2', quantity: 240, formula: '20 * 12' }),
      measured({ reference: 'F.20.1', description: 'Disposal of arisings', unit: 'm3', quantity: 130, source: {} }),
    ]);
    assert.equal(total, 3);
    // Measurement is iterative; a half-finished bill is the ordinary state and
    // refusing to record it would push the work back into a spreadsheet.
    assert.equal(findings.length, 1);
    assert.match(findings[0]!.subject, /F\.20\.1 names no drawing/);
  });

  it('replaces an item at the same reference rather than duplicating it', () => {
    measurement.recordItems(asQS(), scheduleId, [
      measured({ reference: 'F.20.1', description: 'Disposal of arisings', unit: 'm3', quantity: 130, source: { drawing: 'ASH-ST-1002', revision: 'A' } }),
    ]);
    const totals = measurement.scheduleTotals(asQS(), scheduleId);
    assert.equal(totals.items.filter((item) => item.reference === 'F.20.1').length, 1);
    assert.deepEqual(totals.findings, []);
  });

  it('builds a rate and totals the item from it', () => {
    measurement.priceItem(asQS(), scheduleId, {
      reference: 'F.10.1',
      components: [
        { kind: 'LABOUR', description: 'Concretor', unitCostMinor: 28_40, constant: 0.85 },
        { kind: 'MATERIAL', description: 'C40 ready-mix', unitCostMinor: 118_00, constant: 1.02, wastePercent: 5 },
      ],
    });
    const totals = measurement.scheduleTotals(asQS(), scheduleId);
    const item = totals.items.find((i) => i.reference === 'F.10.1')!;
    assert.equal(item.rateMinor, 15_052);
    assert.equal(item.amountMinor, 15_052 * 96);
  });

  it('refuses a rate typed straight in with no components behind it', () => {
    const error = throwsCode(
      () => measurement.priceItem(asQS(), scheduleId, { reference: 'F.10.2', components: [] }),
      'RATE_HAS_NO_COMPONENTS',
    );
    assert.match(String(error.message), /cannot be argued, reused, or repriced/);
  });

  /**
   * Waste is what is cut off, broken and over-ordered. Putting it on labour is
   * somebody meaning "lost time" and hiding it where nobody will look for it.
   */
  it('refuses waste on anything that is not a material', () => {
    throwsCode(
      () =>
        measurement.priceItem(asQS(), scheduleId, {
          reference: 'F.10.2',
          components: [{ kind: 'LABOUR', description: 'Concretor', unitCostMinor: 28_40, constant: 0.85, wastePercent: 10 }],
        }),
      'WASTE_NOT_APPLICABLE',
    );
  });

  it('refuses a constant of zero, which prices nothing', () => {
    throwsCode(
      () =>
        measurement.priceItem(asQS(), scheduleId, {
          reference: 'F.10.2',
          components: [{ kind: 'LABOUR', description: 'Concretor', unitCostMinor: 28_40, constant: 0 }],
        }),
      'CONSTANT_INVALID',
    );
  });

  it('refuses a rate against an item that is not in the schedule', () => {
    throwsCode(
      () =>
        measurement.priceItem(asQS(), scheduleId, {
          reference: 'Z.99.9',
          components: [{ kind: 'LABOUR', description: 'x', unitCostMinor: 100, constant: 1 }],
        }),
      'ITEM_NOT_FOUND',
    );
  });
});

// ── A drawing moves ─────────────────────────────────────────────────────────

describe('measurement · a reissued drawing invalidates what was measured from it', () => {
  let scheduleId: string;

  before(() => {
    scheduleId = measurement.openSchedule(asQS(), { packageReference: 'PKG-FRAME', title: 'Frame' }).scheduleId;
    measurement.recordItems(asQS(), scheduleId, [
      measured({ reference: 'S.10.1', description: 'Steel columns', unit: 't', quantity: 42 }),
      measured({ reference: 'S.10.2', description: 'Steel beams', unit: 't', quantity: 68 }),
      measured({ reference: 'S.20.1', description: 'Metal decking', unit: 'm2', quantity: 3_100, source: { drawing: 'ASH-ST-2001', revision: 'C' } }),
    ]);
  });

  /** `AC-T-WF-03-03`. */
  it('names every item measured from the superseded revision', () => {
    const { affected, summary } = measurement.reviseDrawing(asQS(), scheduleId, {
      drawing: 'ASH-ST-1001',
      fromRevision: 'B',
      toRevision: 'C',
    });
    assert.deepEqual(affected, ['S.10.1', 'S.10.2']);
    assert.match(summary, /2 items measured from it and needing remeasurement — S\.10\.1, S\.10\.2/);
  });

  /**
   * The affected list is read out loud and checked off. Recording order is
   * whatever order somebody typed things in, which reads as no order at all on
   * a bill whose references are the reader's index.
   */
  it('lists the affected items in the order the bill is read in', () => {
    const scrambled = measurement.openSchedule(asQS(), { packageReference: 'PKG-ORD', title: 'Ordering' }).scheduleId;
    measurement.recordItems(asQS(), scrambled, [
      measured({ reference: 'S.10.12' }),
      measured({ reference: 'S.10.2' }),
      measured({ reference: 'S.10.1' }),
    ]);
    const { affected } = measurement.reviseDrawing(asQS(), scrambled, {
      drawing: 'ASH-ST-1001',
      fromRevision: 'B',
      toRevision: 'C',
    });
    assert.deepEqual(affected, ['S.10.1', 'S.10.2', 'S.10.12']);
  });

  it('leaves items measured from a different drawing alone', () => {
    const totals = measurement.scheduleTotals(asQS(), scheduleId);
    assert.equal(totals.openRemeasure.includes('S.20.1'), false);
  });

  it('says plainly when a reissue affects nothing, rather than saying nothing', () => {
    const { affected, summary } = measurement.reviseDrawing(asQS(), scheduleId, {
      drawing: 'ASH-ST-9999',
      fromRevision: 'A',
      toRevision: 'B',
    });
    assert.deepEqual(affected, []);
    assert.match(summary, /nothing in MS-\d{3} was measured from rev A/);
  });

  it('refuses a reissue to the revision it is already at', () => {
    throwsCode(
      () => measurement.reviseDrawing(asQS(), scheduleId, { drawing: 'ASH-ST-1001', fromRevision: 'C', toRevision: 'C' }),
      'REVISION_UNCHANGED',
    );
  });

  /**
   * "Unchanged" is a real and common answer, and one that has to be recorded
   * rather than inferred from silence — otherwise there is no way to tell an
   * item somebody checked from one nobody opened.
   */
  it('accepts a remeasurement that found no change, and records that it found none', () => {
    const { quantity, changed } = measurement.confirmRemeasure(asQS(), scheduleId, {
      reference: 'S.10.1',
      revision: 'C',
      outcome: 'Column schedule unchanged between rev B and rev C; grid F only affected the base plates.',
    });
    assert.equal(quantity, 42);
    assert.equal(changed, false);
  });

  it('takes the new quantity where the remeasurement found one', () => {
    const { quantity, changed } = measurement.confirmRemeasure(asQS(), scheduleId, {
      reference: 'S.10.2',
      revision: 'C',
      quantity: 74,
      outcome: 'Rev C added two transfer beams at grid 4; 6 tonnes.',
    });
    assert.equal(quantity, 74);
    assert.equal(changed, true);
    assert.equal(measurement.scheduleTotals(asQS(), scheduleId).items.find((i) => i.reference === 'S.10.2')!.quantity, 74);
  });

  it('moves the item onto the new revision, so a second reissue is measured from the right place', () => {
    const second = measurement.reviseDrawing(asQS(), scheduleId, {
      drawing: 'ASH-ST-1001',
      fromRevision: 'C',
      toRevision: 'D',
    });
    assert.deepEqual(second.affected, ['S.10.1', 'S.10.2']);
  });

  it('refuses a remeasurement of something nobody flagged', () => {
    throwsCode(
      () => measurement.confirmRemeasure(asQS(), scheduleId, { reference: 'S.20.1', revision: 'D', outcome: 'fine' }),
      'NOTHING_TO_REMEASURE',
    );
  });

  it('refuses a remeasurement that does not say what it found', () => {
    throwsCode(
      () => measurement.confirmRemeasure(asQS(), scheduleId, { reference: 'S.10.1', revision: 'D', outcome: '  ' }),
      'OUTCOME_REQUIRED',
    );
  });
});

// ── The freeze ──────────────────────────────────────────────────────────────

describe('measurement · the freeze refuses three things a schedule would otherwise assert', () => {
  let scheduleId: string;

  const price = (reference: string) =>
    measurement.priceItem(asQS(), scheduleId, {
      reference,
      components: [{ kind: 'SUBCONTRACT', description: 'Groundworks subcontractor', unitCostMinor: 84_00, constant: 1 }],
    });

  before(() => {
    scheduleId = measurement.openSchedule(asQS(), { packageReference: 'PKG-EXT', title: 'External works' }).scheduleId;
    measurement.recordItems(asQS(), scheduleId, [
      measured({ reference: 'E.10.1', description: 'Excavate to reduce level', unit: 'm3', quantity: 1_400 }),
      measured({ reference: 'E.10.2', description: 'Fill and compact', unit: 'm3', quantity: 900 }),
    ]);
  });

  it('refuses while an item carries no rate', () => {
    price('E.10.1');
    const error = throwsCode(
      () => measurement.freezeSchedule(asOwner(), scheduleId, { reason: 'Bid due Friday' }),
      'ITEMS_UNPRICED',
    );
    assert.match(String(error.message), /E\.10\.2/);
    assert.match(String(error.message), /priced at zero by everybody who reads it afterwards/);
  });

  it('refuses while the bill states something untrue', () => {
    price('E.10.2');
    measurement.recordItems(asQS(), scheduleId, [
      measured({ reference: 'E.10.2', description: 'Fill and compact', unit: 'm3', quantity: 900, formula: '30 * 20' }),
    ]);
    const error = throwsCode(
      () => measurement.freezeSchedule(asOwner(), scheduleId, { reason: 'Bid due Friday' }),
      'SCHEDULE_HAS_ERRORS',
    );
    assert.match(String(error.message), /states 900 m3 and its formula gives 600/);
  });

  it('refuses while a reissued drawing has not been looked at', () => {
    measurement.recordItems(asQS(), scheduleId, [
      measured({ reference: 'E.10.2', description: 'Fill and compact', unit: 'm3', quantity: 600, formula: '30 * 20' }),
    ]);
    measurement.reviseDrawing(asQS(), scheduleId, { drawing: 'ASH-ST-1001', fromRevision: 'B', toRevision: 'C' });
    const error = throwsCode(
      () => measurement.freezeSchedule(asOwner(), scheduleId, { reason: 'Bid due Friday' }),
      'REMEASUREMENT_OUTSTANDING',
    );
    assert.match(String(error.message), /E\.10\.1, E\.10\.2/);
  });

  it('freezes once all three are answered, and commits to what it froze', () => {
    for (const reference of ['E.10.1', 'E.10.2']) {
      measurement.confirmRemeasure(asQS(), scheduleId, { reference, revision: 'C', outcome: 'Rev C did not change the earthworks.' });
    }
    const result = measurement.freezeSchedule(asOwner(), scheduleId, { reason: 'Bid due Friday; external works basis agreed' });
    assert.match(result.contentHash, /^[0-9a-f]{64}$|^sha256:/);
    // 1,400 × £84 + 600 × £84
    assert.equal(result.directCostMinor, 84_00 * 2_000);
  });

  it('refuses every change after the freeze', () => {
    throwsCode(() => measurement.recordItems(asQS(), scheduleId, [measured({ reference: 'E.20.1' })]), 'SCHEDULE_FROZEN');
    throwsCode(
      () =>
        measurement.priceItem(asQS(), scheduleId, {
          reference: 'E.10.1',
          components: [{ kind: 'SUBCONTRACT', description: 'x', unitCostMinor: 100, constant: 1 }],
        }),
      'SCHEDULE_FROZEN',
    );
  });

  /**
   * The freeze is an approval act, and the QS holds it — the estimator freezing
   * their own estimate is what `freezeEstimate` has always permitted, and this
   * does not invent a separation the matrix deliberately does not make. What it
   * does check is that the gate is a real one: a role without the approval is
   * refused, so the freeze cannot be reached by anybody who can read the bill.
   */
  it('gates the freeze on the estimating approval, not on being able to see the schedule', () => {
    const other = measurement.openSchedule(asQS(), { packageReference: 'PKG-DR', title: 'Drainage' }).scheduleId;
    measurement.recordItems(asQS(), other, [measured({ reference: 'D.10.1', unit: 'm', quantity: 220 })]);
    measurement.priceItem(asQS(), other, {
      reference: 'D.10.1',
      components: [{ kind: 'SUBCONTRACT', description: 'Drainage subcontractor', unitCostMinor: 62_00, constant: 1 }],
    });

    // The planner holds BOQ_TAKEOFF read and nothing on ESTIMATE_TENDER.
    const asPlanner = platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
    throwsCode(() => measurement.freezeSchedule(asPlanner, other, { reason: 'Looks done' }), 'ACCESS_DENIED');

    measurement.freezeSchedule(asQS(), other, { reason: 'Drainage basis agreed at the settlement meeting' });
  });
});

// ── Uncertainty ─────────────────────────────────────────────────────────────

describe('measurement · what is not firm is said out loud', () => {
  let scheduleId: string;

  before(() => {
    scheduleId = measurement.openSchedule(asQS(), { packageReference: 'PKG-DEM', title: 'Demolition' }).scheduleId;
    measurement.recordItems(asQS(), scheduleId, [
      measured({ reference: 'D.10.1', description: 'Demolish existing structure', unit: 'm3', quantity: 4_000 }),
      measured({
        reference: 'D.20.1',
        description: 'Removal of contaminated material',
        unit: 't',
        quantity: 300,
        basis: 'PROVISIONAL',
      }),
      measured({
        reference: 'D.30.1',
        description: 'Asbestos survey and removal',
        unit: 'item',
        quantity: 1,
        basis: 'ALLOWANCE',
        source: { allowanceBasis: 'Ashworth Phase 1 outturn plus 12% for the larger footprint', authorisedBy: 'Commercial Manager' },
      }),
    ]);
    measurement.priceItem(asQS(), scheduleId, {
      reference: 'D.10.1',
      components: [{ kind: 'SUBCONTRACT', description: 'Demolition contractor', unitCostMinor: 22_00, constant: 1 }],
    });
    measurement.priceItem(asQS(), scheduleId, {
      reference: 'D.20.1',
      components: [{ kind: 'SUBCONTRACT', description: 'Licensed disposal', unitCostMinor: 180_00, constant: 1 }],
    });
    measurement.priceItem(asQS(), scheduleId, {
      reference: 'D.30.1',
      components: [{ kind: 'SUBCONTRACT', description: 'Licensed asbestos contractor', unitCostMinor: 46_000_00, constant: 1 }],
    });
  });

  it('reports the share of the direct cost that sits on a quantity nobody measured firm', () => {
    const report = measurement.uncertaintyReport(asQS(), scheduleId);
    // Firm 4,000 × £22 = £88,000. Provisional 300 × £180 = £54,000. Allowance £46,000.
    assert.equal(report.uncertainMinor, 54_000_00 + 46_000_00);
    assert.equal(report.uncertainPercent, 53.19);
    assert.match(report.summary, /53\.19% of the direct cost sits on 2 quantities that are not firm/);
  });

  it('puts the largest exposure first and says why each one is not firm', () => {
    const report = measurement.uncertaintyReport(asQS(), scheduleId);
    assert.equal(report.lines[0]!.reference, 'D.20.1');
    assert.match(report.lines[0]!.why, /remeasured on site, so the tender figure is not the final one/);
    assert.match(report.lines[1]!.why, /Basis: Ashworth Phase 1 outturn plus 12%/);
  });

  /**
   * The sentence is read out loud in a settlement meeting. "1 quantity that are
   * not firm" is the kind of thing that makes a reader stop trusting the rest
   * of the page.
   */
  it('agrees its verb with the count', () => {
    const one = measurement.openSchedule(asQS(), { packageReference: 'PKG-ONE', title: 'One provisional line' }).scheduleId;
    measurement.recordItems(asQS(), one, [
      measured({ reference: 'P.1' }),
      measured({ reference: 'P.2', basis: 'PROVISIONAL', quantity: 10 }),
    ]);
    for (const reference of ['P.1', 'P.2']) {
      measurement.priceItem(asQS(), one, {
        reference,
        components: [{ kind: 'SUBCONTRACT', description: 'x', unitCostMinor: 100_00, constant: 1 }],
      });
    }
    assert.match(measurement.uncertaintyReport(asQS(), one).summary, /1 quantity that is not firm/);
    assert.match(measurement.uncertaintyReport(asQS(), scheduleId).summary, /2 quantities that are not firm/);
  });

  it('says so plainly when everything in the schedule is firm', () => {
    const firm = measurement.openSchedule(asQS(), { packageReference: 'PKG-FIRM', title: 'Firm works' }).scheduleId;
    measurement.recordItems(asQS(), firm, [measured({ reference: 'A.1' })]);
    measurement.priceItem(asQS(), firm, {
      reference: 'A.1',
      components: [{ kind: 'SUBCONTRACT', description: 'x', unitCostMinor: 100_00, constant: 1 }],
    });
    assert.match(measurement.uncertaintyReport(asQS(), firm).summary, /every quantity in it is firm/);
  });
});

// ── Reconciliation ──────────────────────────────────────────────────────────

describe('measurement · where the money went between two versions', () => {
  let first: string;
  let second: string;

  const build = (reference: string, quantity: number, rateMinor: number, scheduleId: string) => {
    measurement.recordItems(asQS(), scheduleId, [measured({ reference, quantity, unit: 'm2' })]);
    measurement.priceItem(asQS(), scheduleId, {
      reference,
      components: [{ kind: 'SUBCONTRACT', description: 'Trade contractor', unitCostMinor: rateMinor, constant: 1 }],
    });
  };

  before(() => {
    first = measurement.openSchedule(asQS(), { packageReference: 'PKG-CLAD', title: 'Cladding rev 1' }).scheduleId;
    build('C.10.1', 1_000, 240_00, first);
    build('C.10.2', 400, 180_00, first);
    build('C.20.1', 60, 90_00, first);

    second = measurement.openSchedule(asQS(), { packageReference: 'PKG-CLAD', title: 'Cladding rev 2' }).scheduleId;
    build('C.10.1', 1_120, 240_00, second); // remeasured
    build('C.10.2', 400, 195_00, second); // repriced
    build('C.30.1', 25, 400_00, second); // added
    // C.20.1 removed
  });

  /** `AC-T-WF-03-02`. */
  it('accounts for the whole difference, item by item', () => {
    const result = measurement.reconcile(asQS(), first, second);
    assert.equal(result.reconciles, true);
    assert.equal(result.from.directCostMinor, 1_000 * 240_00 + 400 * 180_00 + 60 * 90_00);
    assert.equal(result.to.directCostMinor, 1_120 * 240_00 + 400 * 195_00 + 25 * 400_00);
    assert.equal(
      result.movements.reduce((sum, movement) => sum + movement.deltaMinor, 0),
      result.deltaMinor,
    );
  });

  it('names what each movement was', () => {
    const result = measurement.reconcile(asQS(), first, second);
    const by = new Map(result.movements.map((movement) => [movement.reference, movement]));
    assert.equal(by.get('C.10.1')!.kind, 'REMEASURED');
    assert.equal(by.get('C.10.2')!.kind, 'REPRICED');
    assert.equal(by.get('C.30.1')!.kind, 'ADDED');
    assert.equal(by.get('C.20.1')!.kind, 'REMOVED');
    assert.equal(by.get('C.20.1')!.deltaMinor, -(60 * 90_00));
  });

  it('puts the biggest movement first, whichever way it went', () => {
    const result = measurement.reconcile(asQS(), first, second);
    assert.equal(result.movements[0]!.reference, 'C.10.1');
    assert.match(result.summary, /fully accounted for/);
  });

  it('reports no movement between a schedule and itself', () => {
    const result = measurement.reconcile(asQS(), first, first);
    assert.deepEqual(result.movements, []);
    assert.equal(result.deltaMinor, 0);
    assert.match(result.summary, /no movement/);
  });

  it('refuses to reconcile across two currencies', () => {
    const euro = measurement.openSchedule(asQS(), { packageReference: 'PKG-EU', title: 'Imported facade', currency: 'EUR' }).scheduleId;
    const error = throwsCode(() => measurement.reconcile(asQS(), first, euro), 'CURRENCY_MISMATCH');
    assert.match(String(error.message), /a rate decision, not a measurement one/);
  });
});

// ── The position, and the catalogue ─────────────────────────────────────────

describe('measurement · the position and the catalogue', () => {
  it('says which schedules cannot be frozen yet', () => {
    const position = measurement.measurementPosition(asQS());
    assert.ok(position.schedules.length >= 6);
    assert.match(position.summary, /schedules/);
    const blocked = position.schedules.filter((s) => s.unpriced > 0 || s.critical > 0 || s.openRemeasure > 0);
    assert.ok(blocked.length >= 1, 'no schedule reported as blocked, though several are');
  });

  /**
   * The specification's own guardrail: an agent may assist a take-off and
   * suggest what a rate build-up is missing, and may never approve a quantity
   * or a rate.
   */
  it('lets an agent bring items in and never lets one set a rate', () => {
    assert.equal(lookupEventType('BOQ_IMPORTED')?.aiAllowed, true);
    assert.equal(lookupEventType('RATE_BUILDUP_CREATED')?.aiAllowed, false);
    assert.equal(lookupEventType('MEASUREMENT_FROZEN')?.aiAllowed, false);
  });

  it('requires evidence of what was frozen', () => {
    assert.equal(lookupEventType('MEASUREMENT_FROZEN')?.requiresEvidence, true);
    assert.equal(lookupEventType('MEASUREMENT_FROZEN')?.action, 'FREEZE');
  });

  it('classifies the schedule as commercial, because the build-ups are what we cost', () => {
    const classification = classifyEntity('MeasurementSchedule');
    assert.equal(classification?.area, 'BOQ_TAKEOFF');
    assert.equal(classification?.sensitivity, 'COMMERCIAL_L3');
  });
});
