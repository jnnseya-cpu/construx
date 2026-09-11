import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as lineage from '../src/domain/pricelineage.ts';
import * as measurement from '../src/domain/measurement.ts';
import * as structure from '../src/domain/structure.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Why is this number — `L7.5`.
 *
 * A commercial director looks at a line that says £287,400 and asks where it
 * came from. Every part of the answer was already on the record — the quantity
 * names its drawing and revision, the rate names its components, the freeze
 * names who approved it — and assembling them took somebody an afternoon.
 *
 * These tests are about the three properties that make the chain worth having:
 * it is **derived** and therefore cannot be stale, it **separates an assumption
 * from a measurement** rather than presenting both as facts, and it **says what
 * it cannot answer** instead of leaving a blank that reads as good news.
 */

let platform: Platform;
let seed: SeedResult;
let scheduleId: string;

/** Holds BOQ_TAKEOFF C/U and ESTIMATE_TENDER R/U — measures, prices, reads. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Holds ESTIMATE_TENDER A — the freeze. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // BOQ_TAKEOFF and ESTIMATE_TENDER are gated to CONCEPT, DESIGN and TENDER;
  // the demo project finishes in OPERATIONS. Moved back through the platform's
  // own governed regression rather than around the gate.
  structure.transitionPhase(asOwner(), {
    to: 'TENDER',
    justification: 'Reopened to trace the blockwork package priced for this bid',
  });

  scheduleId = measurement.openSchedule(asQS(), {
    packageReference: 'PKG-LINEAGE',
    title: 'Blockwork, for tracing',
  }).scheduleId;

  measurement.recordItems(asQS(), scheduleId, [
    {
      reference: 'B.10.1',
      description: 'Blockwork, 140mm dense concrete block, in cement mortar',
      unit: 'm2',
      quantity: 1_240,
      basis: 'MEASURED',
      source: { drawing: 'ASH-ST-2104', revision: 'C', sheet: '2 of 6' },
      formula: '400 * 3.1',
    },
    {
      reference: 'B.20.1',
      description: 'Builder’s work in connection with mechanical services',
      unit: 'sum',
      quantity: 1,
      basis: 'ALLOWANCE',
      source: { allowanceBasis: 'Two per cent of the mechanical package, on the last three schemes', authorisedBy: 'R Whitaker' },
    },
  ]);

  measurement.priceItem(asQS(), scheduleId, {
    reference: 'B.10.1',
    components: [
      { kind: 'LABOUR', description: 'Bricklayer and labourer gang', unitCostMinor: 4_280, constant: 0.85 },
      { kind: 'MATERIAL', description: 'Dense concrete block, 140mm', unitCostMinor: 1_920, constant: 10.2, wastePercent: 5 },
      { kind: 'PLANT', description: 'Telehandler, shared', unitCostMinor: 900, constant: 0.06 },
    ],
  });
});

describe('the chain behind one figure', () => {
  it('is reachable, and both reads are declared read-only', () => {
    for (const pattern of [
      '/v1/projects/:projectId/measurement/:scheduleId/lineage',
      '/v1/projects/:projectId/measurement/:scheduleId/lineage/:itemReference',
    ]) {
      const route = ROUTES.find((candidate) => candidate.method === 'GET' && candidate.pattern === pattern);
      assert.ok(route, `${pattern} has no route`);
      // A projection that could write would be a second copy of the truth.
      assert.equal(route.readOnly, true, `${pattern} must be read-only`);
    }
  });

  it('runs from the money back to the drawing', () => {
    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.10.1');

    // Quantity × rate, and the rate is the sum of three components rounded once.
    const expectedRate = Math.round(4_280 * 0.85 + 1_920 * 10.2 * 1.05 + 900 * 0.06);
    assert.equal(chain.amountMinor, Math.round(expectedRate * 1_240));

    const by = new Map(chain.nodes.map((node) => [node.id, node]));
    const root = by.get(chain.rootId)!;
    assert.equal(root.kind, 'CALC');
    assert.equal(root.value, chain.amountMinor);
    assert.deepEqual(root.parents, ['val.quantity', 'calc.rate']);

    // Every parent named by a node exists, or the graph has a dangling edge and
    // the click-through this exists for would end nowhere.
    for (const node of chain.nodes) {
      for (const parent of node.parents) {
        assert.ok(by.has(parent), `${node.id} names a parent ${parent} that is not in the graph`);
      }
    }

    // And it is acyclic, walked from the root.
    const seen = new Set<string>();
    const walk = (id: string, path: string[]): void => {
      assert.ok(!path.includes(id), `cycle through ${id}: ${path.join(' → ')}`);
      seen.add(id);
      for (const parent of by.get(id)!.parents) walk(parent, [...path, id]);
    };
    walk(chain.rootId, []);
    assert.ok(seen.has('src.quantity'), 'the drawing is reachable from the money');
  });

  it('names the drawing at the revision the quantity belongs to', () => {
    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.10.1');
    const source = chain.nodes.find((node) => node.id === 'src.quantity')!;
    assert.match(source.source!, /ASH-ST-2104 rev C, sheet 2 of 6/);
    assert.equal(source.kind, 'SOURCE');
  });

  it('carries the formula as a step rather than as a note beside the number', () => {
    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.10.1');
    const formula = chain.nodes.find((node) => node.id === 'calc.formula')!;
    assert.equal(formula.kind, 'CALC');
    assert.equal(formula.source, '400 * 3.1');
    assert.deepEqual(formula.parents, ['src.quantity']);
  });
});

describe('an assumption is not a measurement', () => {
  it('calls a productivity constant an assumption, whatever the estimator thinks of it', () => {
    const grouped = lineage.byKind(lineage.priceLineage(asQS(), scheduleId, 'B.10.1'));
    // Three components, three constants. Putting them under SOURCE would set
    // them beside a measured quantity as though the two were the same kind of
    // thing, which is how an optimistic output becomes a fact.
    assert.equal(grouped.ASSUMPTION.length, 3);
    for (const node of grouped.ASSUMPTION) assert.equal(node.label, 'Productivity constant');
  });

  it('separates waste from the cost it uplifts', () => {
    const grouped = lineage.byKind(lineage.priceLineage(asQS(), scheduleId, 'B.10.1'));
    assert.equal(grouped.ADJUSTMENT.length, 1);
    assert.equal(grouped.ADJUSTMENT[0]!.value, 5);
    assert.equal(grouped.ADJUSTMENT[0]!.unit, '%');

    // Only the material component carries it. Waste on labour would be lost
    // time wearing a material's clothes.
    const material = grouped.CALC.find((node) => node.label.includes('Dense concrete block'))!;
    assert.ok(material.parents.includes('adj.waste.1'));
    const labour = grouped.CALC.find((node) => node.label.includes('Bricklayer'))!;
    assert.ok(!labour.parents.some((parent) => parent.startsWith('adj.waste')));
  });

  it('treats an allowance as an assumption on both sides', () => {
    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.20.1');
    const source = chain.nodes.find((node) => node.id === 'src.quantity')!;
    const quantity = chain.nodes.find((node) => node.id === 'val.quantity')!;
    assert.equal(source.kind, 'ASSUMPTION');
    assert.equal(quantity.kind, 'ASSUMPTION');
    assert.match(source.source!, /authorised by R Whitaker/);
  });
});

describe('what it says it cannot answer', () => {
  it('says a working figure is a working figure until the schedule is frozen', () => {
    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.10.1');
    assert.equal(chain.frozen, false);
    assert.ok(chain.gaps.some((gap) => gap.includes('not frozen')));
    assert.equal(lineage.byKind(chain).APPROVAL.length, 0);
  });

  it('refuses to invent a price base date', () => {
    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.10.1');
    // The engine records when a rate was entered, not the index date its costs
    // were current at. Presenting the first as the second would be the kind of
    // confident wrong answer the chain exists to prevent.
    assert.ok(chain.gaps.some((gap) => gap.includes('No price base date is recorded')));
  });

  it('stops at the measurement when there is no rate, and says so', () => {
    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.20.1');
    assert.equal(chain.amountMinor, 0);
    assert.equal(chain.rootId, 'val.quantity');
    assert.ok(chain.gaps.some((gap) => gap.includes('carries no rate')));
    assert.match(chain.summary, /the honest place for it to stop/);
  });

  it('records the approval once the schedule is frozen', () => {
    measurement.priceItem(asQS(), scheduleId, {
      reference: 'B.20.1',
      components: [{ kind: 'SUBCONTRACT', description: 'Builder’s work, provisional', unitCostMinor: 18_400_00, constant: 1 }],
    });
    measurement.freezeSchedule(asOwner(), scheduleId, { reason: 'Priced for the Ashworth return' });

    const chain = lineage.priceLineage(asQS(), scheduleId, 'B.10.1');
    assert.equal(chain.frozen, true);
    const approval = lineage.byKind(chain).APPROVAL[0]!;
    assert.equal(approval.kind, 'APPROVAL');
    assert.match(approval.source!, /Priced for the Ashworth return/);
    assert.ok(!chain.gaps.some((gap) => gap.includes('not frozen')));
  });
});

describe('the same question over a whole schedule', () => {
  it('reports every line and which chains cannot answer something', () => {
    const sweep = lineage.scheduleLineage(asQS(), scheduleId);
    assert.equal(sweep.lines.length, 2);
    assert.ok(sweep.lines.every((line) => line.depth > 2), 'a line traced by two nodes is barely traced');
    // Every line still carries the price-base-date gap, which is the honest
    // answer rather than an empty list.
    assert.equal(sweep.incomplete.length, 2);
    assert.match(sweep.summary, /2 line\(s\), 2 with something the chain cannot answer/);
  });

  it('refuses a line that is not in the bill', () => {
    const error = throwsCode(() => lineage.priceLineage(asQS(), scheduleId, 'B.99.9'), 'ITEM_NOT_FOUND');
    assert.match(String(error.message), /a chain ending in nothing/);
  });

  it('refuses a schedule in another tenancy', () => {
    throwsCode(() => lineage.priceLineage(asQS(), 'not-a-schedule', 'B.10.1'), 'SCHEDULE_NOT_FOUND');
  });

  it('publishes what each kind of node means, so the console names them the same way', () => {
    const kinds = lineage.lineageKinds();
    assert.equal(kinds.length, lineage.LINEAGE_KIND.length);
    for (const kind of lineage.LINEAGE_KIND) {
      assert.ok(kinds.some((entry) => entry.kind === kind), `${kind} is not described`);
    }
  });
});
