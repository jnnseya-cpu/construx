import type { LogisticsElement } from '../engines/sitevisit.ts';
import * as geo from '../domain/geometry.ts';
import type { SiteModelView } from '../domain/sitemodel.ts';
import type { DocumentBlock } from './exporter.ts';

/**
 * The controlled 2D site layout: a drawing, not a picture of one.
 *
 * Both specifications ask for a dimensioned plan at a stated scale with a title
 * block, north arrow, scale bar and a legend from the taxonomy. The difference
 * between that and a diagram is whether a scale rule laid on the paper reads
 * true, and this is built so it does: a scale is chosen from the ordinary
 * drawing scales, the renderer applies exactly that ratio, and the bar is drawn
 * at it. Nothing is squeezed to fit.
 *
 * ---
 *
 * **The scale is chosen, then the sheet is checked against it.** A plan that
 * fitted the page at 1:173 would be measurable by nobody. So the extent picks
 * the smallest standard scale that fits, and if the site is too large for A4
 * even at 1:2500 the caller is told rather than handed a drawing at a ratio it
 * invented.
 *
 * **Colour comes from the element code, not from the order zones were drawn.**
 * A legend is only useful if the same kind of thing is the same colour on every
 * sheet the business issues, and on the next revision of this one.
 *
 * **The DXF is the same geometry, layered by code.** It is a text format, so it
 * needs no library — and a layered DXF is what a client's own drawing office
 * can actually receive and overlay, which a PDF is not.
 */

/**
 * How each element is drawn. One colour per code, fixed.
 *
 * Chosen so the four that matter most read apart at a glance on a monochrome
 * print as well as in colour: the boundary is the heaviest line, exclusions are
 * dashed, ground conditions are muted, and the compound is warm.
 */
const STYLE: Record<LogisticsElement, { colour: string; outlineOnly?: boolean; dxfColour: number }> = {
  HOARDING: { colour: '#1f2933', outlineOnly: true, dxfColour: 7 },
  GATE: { colour: '#0b6e4f', dxfColour: 3 },
  SITE_OFFICE: { colour: '#c2410c', dxfColour: 30 },
  WELFARE: { colour: '#ea580c', dxfColour: 40 },
  STORAGE: { colour: '#a16207', dxfColour: 42 },
  LAYDOWN: { colour: '#ca8a04', dxfColour: 2 },
  DELIVERY_HOLDING: { colour: '#b45309', dxfColour: 41 },
  PARKING: { colour: '#4d7c0f', dxfColour: 62 },
  WHEEL_WASH: { colour: '#0e7490', dxfColour: 4 },
  WASTE: { colour: '#7c2d12', dxfColour: 33 },
  TEMPORARY_SUPPLY: { colour: '#7e22ce', dxfColour: 6 },
  PEDESTRIAN_ROUTE: { colour: '#15803d', dxfColour: 92 },
  HAUL_ROAD: { colour: '#525252', dxfColour: 8 },
  SPOIL_HEAP: { colour: '#78350f', dxfColour: 34 },
  EXCAVATION: { colour: '#92400e', dxfColour: 32 },
  CRANE_POSITION: { colour: '#b91c1c', outlineOnly: true, dxfColour: 1 },
  SCAFFOLD: { colour: '#6d28d9', dxfColour: 200 },
  EXCLUSION_ZONE: { colour: '#dc2626', outlineOnly: true, dxfColour: 1 },
  MUSTER_POINT: { colour: '#047857', dxfColour: 3 },
  EXISTING_SERVICES: { colour: '#a21caf', outlineOnly: true, dxfColour: 6 },
  STANDING_WATER: { colour: '#0369a1', dxfColour: 5 },
  VEGETATION: { colour: '#166534', dxfColour: 90 },
  PERMANENT_WORKS: { colour: '#1e3a8a', dxfColour: 5 },
  TEMPORARY_WORKS: { colour: '#4338ca', dxfColour: 170 },
  FIRE_POINT: { colour: '#e11d48', dxfColour: 1 },
};

/**
 * The catalogue and its palette, for anything that draws the site.
 *
 * One table behind the PDF, the DXF and the browser's 3D view. A viewer with
 * its own colours would put a laydown in one colour on the drawing and another
 * on the screen, for the same site, on the same day.
 */
export function elementStyles(): Array<{ code: LogisticsElement; label: string; colour: string; outlineOnly: boolean }> {
  return (Object.keys(STYLE) as LogisticsElement[]).map((code) => ({
    code,
    label: humanise(code),
    colour: STYLE[code]!.colour,
    outlineOnly: STYLE[code]!.outlineOnly === true,
  }));
}

/** The scales a drawing office actually plots at. */
const STANDARD_SCALES = [50, 100, 200, 250, 500, 1000, 1250, 2500];

/** A4 portrait, less the document margins, in millimetres of drawable plan. */
const PLOT_MM = { width: 165, height: 200 };

export type SitePlanSheet = {
  scaleDenominator: number;
  blocks: DocumentBlock[];
};

/**
 * Choose the scale, then build the sheet.
 *
 * Returns `undefined` for a site that will not fit at any standard scale, so
 * the caller refuses rather than issuing a drawing at a ratio nobody can
 * measure against.
 */
export function chooseScale(extent: { minX: number; minY: number; maxX: number; maxY: number }): number | undefined {
  // A margin inside the plot area, so a boundary line is not on the sheet edge.
  const widthMetres = (extent.maxX - extent.minX) * 1.06;
  const heightMetres = (extent.maxY - extent.minY) * 1.06;

  for (const scale of STANDARD_SCALES) {
    const widthMm = (widthMetres * 1000) / scale;
    const heightMm = (heightMetres * 1000) / scale;
    if (widthMm <= PLOT_MM.width && heightMm <= PLOT_MM.height) return scale;
  }
  return undefined;
}

/**
 * The drawing, the zone schedule and the findings, as document blocks.
 *
 * Blocks rather than a rendered page, so the site plan goes through the same
 * exporter as every other document and inherits the branding, the audience
 * redaction, the content hash and the attestation. A parallel renderer would
 * have been a second document engine with none of that.
 */
export function sitePlanBlocks(view: SiteModelView, options: { title: string }): SitePlanSheet | undefined {
  if (!view.boundary) return undefined;

  const extent = geo.bounds(view.boundary.ring);
  const scaleDenominator = chooseScale(extent);
  if (scaleDenominator === undefined) return undefined;

  const drawn = view.zones.filter((zone) => STYLE[zone.code]);
  const codesUsed = [...new Set(drawn.map((zone) => zone.code))];

  // No heading of its own: the exporter already prints `options.title` at the
  // head of the sheet, and the drawing carries its own caption. A third copy
  // between them said nothing the other two had not.
  const blocks: DocumentBlock[] = [
    {
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Site area', value: `${view.boundary.areaSquareMetres.toLocaleString()} m²` },
        { label: 'Boundary length', value: `${view.boundary.perimeterMetres.toLocaleString()} m` },
        { label: 'Zones shown', value: String(drawn.length) },
        { label: 'Plotted at', value: `1:${scaleDenominator} on A4` },
        {
          label: 'Ground survey',
          value: view.surface
            ? `${view.surface.triangles} triangles, steepest ${view.surface.steepestPercent}%`
            : 'None captured — no levels, slopes or volumes are shown',
        },
      ],
    },
    {
      kind: 'DRAWING',
      caption: options.title,
      scaleDenominator,
      extent,
      shapes: [
        // The boundary first, so every zone draws over it.
        { label: '', ring: view.boundary.ring, colour: '#1f2933', outlineOnly: true },
        ...drawn.map((zone) => ({
          label: zone.instanceName,
          ring: zone.ring,
          colour: STYLE[zone.code]!.colour,
          ...(STYLE[zone.code]!.outlineOnly ? { outlineOnly: true } : {}),
        })),
      ].filter((shape) => shape.ring.length >= 3),
      legend: codesUsed.map((code) => ({ label: humanise(code), colour: STYLE[code]!.colour })),
    },
  ];

  if (drawn.length > 0) {
    blocks.push({
      kind: 'TABLE',
      caption: 'Zone schedule',
      headers: ['Zone', 'Type', 'Source', 'Area (m²)', 'Perimeter (m)'],
      rows: drawn.map((zone) => [
        zone.instanceName,
        humanise(zone.code),
        zone.source === 'OBSERVED' ? 'Observed on the walk' : 'Proposed',
        zone.areaSquareMetres.toLocaleString(),
        zone.perimeterMetres.toLocaleString(),
      ]),
    });
  }

  blocks.push({ kind: 'HEADING', level: 2, text: 'What the geometry found' });
  if (view.findings.length === 0) {
    blocks.push({ kind: 'PARAGRAPH', text: 'Nothing on this layout conflicts with anything else on it.' });
  } else {
    blocks.push({
      kind: 'TABLE',
      headers: ['Severity', 'Finding', 'What it means'],
      rows: view.findings.map((finding) => [finding.severity, finding.subject, finding.detail]),
    });
  }

  // Said on the drawing, not only in the platform. A sheet that leaves the
  // system is read by somebody who cannot see the accuracy class beside it.
  blocks.push({
    kind: 'PARAGRAPH',
    text:
      'This layout is derived from a handheld site capture. Positions and areas are as captured and are not a survey. ' +
      'Nothing on this sheet may be used for setting out without verification by competent survey and design.',
  });

  return { scaleDenominator, blocks };
}

/**
 * The same geometry as a layered DXF.
 *
 * A text format, so it needs no library, and a layered drawing is what a
 * client's drawing office can overlay on their own — which a PDF is not. R12
 * ASCII deliberately: it is the dialect every CAD package on a construction
 * project can open, including the twenty-year-old one somebody still uses.
 */
export function sitePlanDxf(view: SiteModelView): string {
  const out: string[] = [];
  const pair = (code: number, value: string | number): void => {
    out.push(String(code), String(value));
  };

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');

  const polyline = (ring: geo.Ring, layer: string, colour: number): void => {
    pair(0, 'POLYLINE');
    pair(8, layer);
    pair(62, colour);
    // 1 = closed. A site zone that did not close would be a fence, not an area.
    pair(70, 1);
    pair(66, 1);
    for (const point of ring) {
      pair(0, 'VERTEX');
      pair(8, layer);
      pair(10, point.x.toFixed(3));
      pair(20, point.y.toFixed(3));
      pair(30, '0.0');
    }
    pair(0, 'SEQEND');
    pair(8, layer);
  };

  if (view.boundary) polyline(view.boundary.ring, 'SITE-BOUNDARY', 7);

  for (const zone of view.zones) {
    const style = STYLE[zone.code];
    if (!style || zone.ring.length < 3) continue;
    const layer = `SITE-${zone.code}`;
    polyline(zone.ring, layer, style.dxfColour);

    // The name, at a point that is inside even a concave zone.
    const label = interior(zone.ring);
    pair(0, 'TEXT');
    pair(8, `${layer}-TEXT`);
    pair(62, style.dxfColour);
    pair(10, label.x.toFixed(3));
    pair(20, label.y.toFixed(3));
    pair(30, '0.0');
    // 1.5m tall, which reads at the scales a site plan is plotted at.
    pair(40, '1.5');
    pair(1, zone.instanceName);
  }

  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return out.join('\n');
}

function interior(ring: geo.Ring): geo.Point {
  const middle = geo.centroid(ring);
  if (geo.containsPoint(ring, middle)) return middle;
  let best: { point: geo.Point; area: number } | undefined;
  for (const triangle of geo.triangulate(ring)) {
    const size = geo.area(triangle);
    if (!best || size > best.area) best = { point: geo.centroid(triangle), area: size };
  }
  return best?.point ?? middle;
}

function humanise(code: string): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
