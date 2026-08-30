import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as geo from '../src/domain/geometry.ts';
import type { SiteModelView } from '../src/domain/sitemodel.ts';
import * as siteplan from '../src/export/siteplan.ts';

/**
 * The 2D layout: a drawing, not a picture of one.
 *
 * The claim being tested is that a scale rule laid on the paper reads true. So
 * the scale has to be a standard one, it has to be honestly reachable from the
 * extent, and the geometry that reaches the sheet has to be the geometry the
 * schedule quotes.
 */

const box = (x: number, y: number, w: number, h: number): geo.Ring => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

function view(over: Partial<SiteModelView> = {}): SiteModelView {
  const boundary = box(0, 0, 60, 40);
  return {
    modelId: 'MODEL-1',
    missionId: 'MISSION-1',
    boundary: {
      ring: boundary,
      areaSquareMetres: geo.area(boundary),
      perimeterMetres: geo.perimeter(boundary),
    },
    zones: [
      {
        zoneId: 'Z1',
        code: 'LAYDOWN',
        instanceName: 'Laydown A',
        source: 'PLANNED',
        ring: box(5, 5, 20, 10),
        areaSquareMetres: 200,
        perimeterMetres: 60,
        labelPoint: { x: 15, y: 10 },
      },
      {
        zoneId: 'Z2',
        code: 'EXCLUSION_ZONE',
        instanceName: 'Overhead line',
        source: 'OBSERVED',
        ring: box(40, 0, 10, 40),
        areaSquareMetres: 400,
        perimeterMetres: 100,
        labelPoint: { x: 45, y: 20 },
      },
    ],
    findings: [],
    summary: 'test',
    ...over,
  };
}

describe('the scale is a standard one, and it is honest', () => {
  it('picks the tightest standard scale the site fits at', () => {
    // 60m × 40m with a 6% margin is 63.6m × 42.4m. At 1:250 that is 254mm ×
    // 170mm, which is wider than the 165mm plot. At 1:500 it is 127mm × 85mm,
    // which fits. 1:250 and everything tighter must therefore be rejected.
    assert.equal(siteplan.chooseScale({ minX: 0, minY: 0, maxX: 60, maxY: 40 }), 500);
  });

  it('picks a tighter scale for a smaller site', () => {
    // 15m × 10m at 1:100 is 159mm × 106mm — fits. At 1:50 it would be 318mm.
    assert.equal(siteplan.chooseScale({ minX: 0, minY: 0, maxX: 15, maxY: 10 }), 100);
  });

  it('refuses a site too large for A4 rather than inventing a ratio', () => {
    // Two kilometres across. Squeezing it to fit would produce a sheet whose
    // printed scale is a lie, and nobody could measure anything off it.
    assert.equal(siteplan.chooseScale({ minX: 0, minY: 0, maxX: 2000, maxY: 1500 }), undefined);
  });

  it('only ever returns a scale a drawing office plots at', () => {
    const standard = new Set([50, 100, 200, 250, 500, 1000, 1250, 2500]);
    for (let size = 5; size <= 400; size += 5) {
      const scale = siteplan.chooseScale({ minX: 0, minY: 0, maxX: size, maxY: size * 0.7 });
      if (scale === undefined) continue;
      assert.ok(standard.has(scale), `${size}m produced 1:${scale}, which is not a drawing scale`);
    }
  });
});

describe('the sheet', () => {
  it('carries the drawing in site metres, so the sheet and the schedule cannot disagree', () => {
    const sheet = siteplan.sitePlanBlocks(view(), { title: 'Site layout' })!;
    assert.ok(sheet);

    const drawing = sheet.blocks.find((b) => b.kind === 'DRAWING');
    assert.ok(drawing && drawing.kind === 'DRAWING');
    assert.equal(drawing.scaleDenominator, sheet.scaleDenominator);
    // The boundary plus both zones.
    assert.equal(drawing.shapes.length, 3);
    // Real coordinates, not page units — the extent is the site's own.
    assert.deepEqual(drawing.extent, { minX: 0, minY: 0, maxX: 60, maxY: 40 });

    const laydown = drawing.shapes.find((s) => s.label === 'Laydown A');
    assert.ok(laydown);
    assert.equal(geo.area(laydown.ring), 200, 'the drawn ring is not the ring the schedule quotes');
  });

  it('draws an exclusion as an outline and a laydown as a filled zone', () => {
    // The distinction is not decoration: a hatched outline says nothing may be
    // there, and a wash says something is.
    const drawing = siteplan.sitePlanBlocks(view(), { title: 'x' })!.blocks.find((b) => b.kind === 'DRAWING');
    assert.ok(drawing && drawing.kind === 'DRAWING');
    assert.equal(drawing.shapes.find((s) => s.label === 'Overhead line')?.outlineOnly, true);
    assert.equal(drawing.shapes.find((s) => s.label === 'Laydown A')?.outlineOnly, undefined);
  });

  it('gives the same element the same colour every time', () => {
    // A legend is only useful if a laydown is the same colour on every sheet
    // the business issues, and on the next revision of this one.
    // Two *different* sheets, with the laydown in a different position on each.
    // Comparing one view against an identical copy proves only that the
    // function is deterministic, which colouring by draw order also is.
    const asIs = view();
    const reordered = view({ zones: [...view().zones].reverse() });
    const first = siteplan.sitePlanBlocks(asIs, { title: 'x' })!.blocks.find((b) => b.kind === 'DRAWING');
    const second = siteplan.sitePlanBlocks(reordered, { title: 'x' })!.blocks.find((b) => b.kind === 'DRAWING');
    assert.ok(first?.kind === 'DRAWING' && second?.kind === 'DRAWING');
    assert.equal(
      first.shapes.find((s) => s.label === 'Laydown A')?.colour,
      second.shapes.find((s) => s.label === 'Laydown A')?.colour,
      'a laydown changed colour because it was drawn in a different order',
    );
    assert.equal(
      first.shapes.find((s) => s.label === 'Overhead line')?.colour,
      second.shapes.find((s) => s.label === 'Overhead line')?.colour,
    );
    // And the two codes are not the same colour as each other, or the legend
    // distinguishes nothing.
    assert.notEqual(
      first.shapes.find((s) => s.label === 'Laydown A')?.colour,
      first.shapes.find((s) => s.label === 'Overhead line')?.colour,
    );
    // And the legend names every code actually drawn, once each.
    assert.equal(first.legend.length, 2);
    assert.equal(new Set(first.legend.map((l) => l.label)).size, 2);
  });

  it('schedules every zone with the area the drawing shows', () => {
    const sheet = siteplan.sitePlanBlocks(view(), { title: 'x' })!;
    const schedule = sheet.blocks.find((b) => b.kind === 'TABLE' && b.caption === 'Zone schedule');
    assert.ok(schedule && schedule.kind === 'TABLE');
    assert.equal(schedule.rows.length, 2);
    assert.deepEqual(schedule.rows[0], ['Laydown A', 'Laydown', 'Proposed', '200', '60']);
  });

  it('says on the sheet itself that it is not a survey', () => {
    // The drawing leaves the platform. Whoever opens it cannot see the accuracy
    // class beside it, so the sheet has to carry the warning.
    const sheet = siteplan.sitePlanBlocks(view(), { title: 'x' })!;
    const text = sheet.blocks
      .filter((b) => b.kind === 'PARAGRAPH')
      .map((b) => (b.kind === 'PARAGRAPH' ? b.text : ''))
      .join(' ');
    assert.match(text, /not a survey/);
    assert.match(text, /may be used for setting out without verification/);
  });

  it('says there were no levels rather than implying a flat site', () => {
    const sheet = siteplan.sitePlanBlocks(view(), { title: 'x' })!;
    const facts = sheet.blocks.find((b) => b.kind === 'KEY_VALUES');
    assert.ok(facts && facts.kind === 'KEY_VALUES');
    assert.match(facts.rows.find((r) => r.label === 'Ground survey')!.value, /None captured/);
  });

  it('produces nothing at all without a boundary', () => {
    assert.equal(siteplan.sitePlanBlocks(view({ boundary: undefined }), { title: 'x' }), undefined);
  });
});

describe('the DXF a drawing office can open', () => {
  it('writes a closed polyline per zone, on its own layer', () => {
    const dxf = siteplan.sitePlanDxf(view());

    // Structure: an ENTITIES section that terminates properly. A DXF missing
    // its EOF is a file every CAD package refuses.
    assert.match(dxf, /^0\nSECTION\n2\nENTITIES\n/);
    assert.match(dxf, /0\nENDSEC\n0\nEOF$/);

    // One layer per element code, plus the boundary.
    assert.match(dxf, /8\nSITE-BOUNDARY\n/);
    assert.match(dxf, /8\nSITE-LAYDOWN\n/);
    assert.match(dxf, /8\nSITE-EXCLUSION_ZONE\n/);

    // Closed: 70/1 on every polyline. An open one is a fence, not an area.
    const polylines = dxf.split('\n0\nPOLYLINE\n').length - 1;
    assert.equal(polylines, 3);
    assert.equal(dxf.split('\n70\n1\n').length - 1, 3);
    assert.equal(dxf.split('\n0\nSEQEND\n').length - 1, 3);
  });

  it('writes real site coordinates, so it overlays on the client’s own drawing', () => {
    const dxf = siteplan.sitePlanDxf(view());
    // The laydown's corner at (5, 5) and the boundary's at (60, 40).
    assert.match(dxf, /10\n5\.000\n20\n5\.000\n/);
    assert.match(dxf, /10\n60\.000\n20\n40\.000\n/);
  });

  it('labels each zone at a point inside it', () => {
    const dxf = siteplan.sitePlanDxf(view());
    assert.match(dxf, /1\nLaydown A/);
    assert.match(dxf, /1\nOverhead line/);
    // Text height in site metres, so it reads at plotting scale.
    assert.match(dxf, /40\n1\.5\n/);
  });

  it('has one vertex per corner and no more', () => {
    // A ring closed by repeating its first vertex would double-count a corner
    // and, on a measured drawing, show a zero-length edge.
    const dxf = siteplan.sitePlanDxf(view());
    // Three rectangles: 4 vertices each.
    assert.equal(dxf.split('\n0\nVERTEX\n').length - 1, 12);
  });
});
