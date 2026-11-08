import { expertBriefing } from '../ai/expertise.ts';
import type { DocumentBlock } from '../export/exporter.ts';
import { runAI, type EngineContext } from '../engines/context.ts';
import type { FeasibilityScheme } from './feasibility.ts';

/**
 * The narrative feasibility brief — the feasibility scheme assembled into a
 * readable project description / Employer's Requirements document.
 *
 * ---
 *
 * **Two layers, and the honesty rule runs between them.** The scheme engine
 * (`feasibility.ts`) produces the numbers; this turns them into a document with
 * prose, headings and tables that a client can read.
 *
 * - The **prose is composed deterministically from the figures** — a sentence
 *   that says "50 homes on one hectare at 50 per hectare" is built from the
 *   computed totals, so it cannot drift from the tables beside it. This is not
 *   AI text and is never presented as reasoning; it is the figures, written out.
 * - An **optional AI layer** adds advisory prose for the few judgement sections
 *   (vision, placemaking, delivery strategy) where a model earns its place.
 *   Where no reasoning provider answers — or the local stand-in does — that
 *   layer is simply absent and the section says so, exactly as the document
 *   generator already does for its narrative. Nothing a model returns becomes a
 *   figure on the page; it is placed in its own marked paragraph and nowhere
 *   else.
 *
 * Every figure is a concept control to be replaced by measured design and QS
 * data before tender, and the document carries that qualification on its face.
 */

/** Minor units to a readable pound string: "£19.85m" for large sums, full otherwise. */
function gbp(minor: number, { compact = false } = {}): string {
  const pounds = minor / 100;
  if (compact && Math.abs(pounds) >= 100_000) return `£${(pounds / 1_000_000).toFixed(2)}m`;
  return `£${Math.round(pounds).toLocaleString('en-GB')}`;
}
const m2 = (n: number): string => `${n.toLocaleString('en-GB')} m²`;

/**
 * The judgement sections an AI layer may write, with the brief put to the model.
 * Deterministic prose fills them when no model answers.
 */
export const BRIEF_AI_SECTIONS: Array<{ key: string; heading: string; brief: string; fallback: (s: FeasibilityScheme) => string }> = [
  {
    key: 'vision',
    heading: 'Vision and placemaking',
    brief:
      'Write the vision for this council social-housing scheme. In two or three sentences, describe the placemaking ' +
      'intent — how the homes sit in their context, overlooking and active frontages, a safe and tenure-blind ' +
      'neighbourhood. No headings, no lists; state no figure, name or date not in the scheme figures supplied.',
    fallback: (s) =>
      `The scheme places ${s.totals.houses} two-storey houses against the existing residential edges and ${s.totals.flats} ` +
      `flats in lower blocks toward the arrival street, so scale steps down into the neighbourhood. Entrances and ` +
      `habitable rooms face the street and the public open space, gardens and amenity are defensible and overlooked, and ` +
      `the result reads as a safe, tenure-blind extension of the existing network rather than an estate apart.`,
  },
  {
    key: 'strategy',
    heading: 'Delivery and infrastructure strategy',
    brief:
      'In two or three sentences, summarise the delivery and infrastructure strategy for this social-housing scheme: ' +
      'all-electric low-carbon homes, an adoptable street, sustainable drainage, utility connections and biodiversity ' +
      'net gain, procured to secure cost and programme certainty. No headings, no lists; reason only about the figures supplied.',
    fallback: (s) =>
      `Every home is all-electric to the emerging Future Homes Standard, served by an adoptable street, sustainable ` +
      `drainage, new or reinforced utility connections and on-site biodiversity net gain. The ${s.programme.totalMonths}-month ` +
      `programme (${s.programme.onSiteMonths} on site) and the £${(s.costPlan.forecastOutturnMinor / 100 / 1_000_000).toFixed(2)}m ` +
      `forecast outturn are to be firmed up through two-stage procurement, with infrastructure positions proven before start on site.`,
  },
];

/**
 * Assemble the brief into export blocks.
 *
 * `narrative` carries any AI-written prose keyed by section; where a key is
 * absent the deterministic fallback prose is used instead, so the document is
 * complete with or without a model.
 */
export function feasibilityBriefBlocks(
  scheme: FeasibilityScheme,
  narrative: Record<string, string> = {},
): DocumentBlock[] {
  const s = scheme;
  const blocks: DocumentBlock[] = [];
  const para = (text: string): void => { blocks.push({ kind: 'PARAGRAPH', text }); };
  const h = (level: 1 | 2 | 3, text: string): void => { blocks.push({ kind: 'HEADING', level, text }); };

  // --- Executive summary (prose composed from the figures) ---
  h(1, `${s.schemeName} — Feasibility Brief`);
  para(
    `This feasibility brief develops ${s.totals.homes} ${s.tenure.toLowerCase()} homes on ${m2(s.siteAreaM2)} ` +
    `(${s.siteAreaHa} ha) for ${s.authority} — ${s.totals.houses} two-storey houses and ${s.totals.flats} flats, at a ` +
    `density of ${s.totals.densityDph} homes per hectare. ${s.totals.familyHomePercent}% of the homes are family-sized ` +
    `(three bedrooms or more), ${s.accessibility.m4_2} are to Part M4(2) accessible standard (${s.accessibility.m4_2Percent}%) ` +
    `and ${s.accessibility.m4_3} are wheelchair-adaptable to M4(3).`,
  );
  para(
    `The forecast outturn is ${gbp(s.costPlan.forecastOutturnMinor, { compact: true })} excluding VAT, land and financing ` +
    `— about ${gbp(s.costPlan.perHomeMinor)} per home — and the scheme is delivered over approximately ` +
    `${s.programme.totalMonths} months, with ${s.programme.onSiteMonths} on site. Every quantity and rate below is a ` +
    `concept control for RIBA Stages 0–2, to be replaced by measured design and QS package data before tender.`,
  );
  blocks.push({
    kind: 'KEY_VALUES',
    rows: [
      { label: 'Homes', value: `${s.totals.homes} (${s.totals.houses} houses, ${s.totals.flats} flats)` },
      { label: 'Bedspaces', value: String(s.totals.bedspaces) },
      { label: 'Net dwelling GIA', value: m2(s.totals.netDwellingGiaM2) },
      { label: 'Costed building GIA', value: m2(s.totals.costedBuildingGiaM2) },
      { label: 'Density', value: `${s.totals.densityDph} dph (gross)` },
      { label: 'Accessibility', value: `${s.accessibility.m4_2} × M4(2), ${s.accessibility.m4_3} × M4(3)` },
      { label: 'Parking / cycle', value: `${s.parking.totalSpaces} car, ${s.parking.cycleSpaces} cycle` },
      { label: 'Forecast outturn', value: `${gbp(s.costPlan.forecastOutturnMinor, { compact: true })} (ex VAT, land, finance)` },
      { label: 'Programme', value: `≈ ${s.programme.totalMonths} months` },
    ],
  });

  // --- Vision (AI or deterministic) ---
  const vision = BRIEF_AI_SECTIONS.find((x) => x.key === 'vision')!;
  h(2, `1. ${vision.heading}`);
  para(narrative.vision ?? vision.fallback(s));
  if (narrative.vision) para('The paragraph above is advisory prose written by the platform’s reasoning provider over the scheme figures; it states no figure not computed below.');

  // --- Schedule of accommodation ---
  h(2, '2. Schedule of accommodation');
  blocks.push({
    kind: 'TABLE',
    caption: 'Dwelling mix, NDSS areas and total GIA',
    headers: ['Type', 'No.', 'Bedspaces', 'NDSS m²', 'Design m²', 'Total GIA'],
    rows: [
      ...s.schedule.map((l) => [l.label, String(l.count), String(l.bedspacesEach), String(l.ndssMinM2), String(l.designM2), m2(l.totalDesignM2)]),
      ['Total', String(s.totals.homes), String(s.totals.bedspaces), '', '', `${m2(s.totals.netDwellingGiaM2)} net`],
    ],
  });
  para(
    `Areas are the Nationally Described Space Standard minimum plus a ${s.assumptions.designUpliftPercent}% design uplift; ` +
    `verify each independently. Costed building GIA of ${m2(s.totals.costedBuildingGiaM2)} adds ${s.assumptions.flatCommonPercent}% ` +
    `flat common area (cores, stairs, the lift, corridors, risers and plant). Parking is ${s.parking.totalSpaces} spaces ` +
    `(${s.parking.houseSpaces} house, ${s.parking.flatSpaces} flat-resident, ${s.parking.visitorSpaces} visitor) and ${s.parking.cycleSpaces} cycle spaces.`,
  );

  // --- Site and land budget ---
  h(2, '3. Site and land budget');
  blocks.push({
    kind: 'TABLE',
    caption: 'Land use apportionment across the red line',
    headers: ['Land use', 'Area', 'Note'],
    rows: s.landBudget.uses.map((u) => [u.use, m2(u.areaM2), u.note]),
  });
  if (s.landBudget.overSite) para('WARNING: the land uses exceed the red line — the density or the unit count must be reduced before this scheme is viable on the site.');

  // --- Infrastructure and delivery strategy (AI or deterministic) ---
  const strategy = BRIEF_AI_SECTIONS.find((x) => x.key === 'strategy')!;
  h(2, '4. Infrastructure and delivery strategy');
  para(narrative.strategy ?? strategy.fallback(s));
  if (narrative.strategy) para('The paragraph above is advisory prose written by the platform’s reasoning provider over the scheme figures.');
  blocks.push({
    kind: 'LIST',
    ordered: false,
    items: [
      'External: an adoptable priority-access street and footways (Section 38/278), ' +
        `parking and cycle provision, foul drainage to a public sewer, sustainable drainage with attenuation and a lawful outfall, ` +
        'metered water and hydrants, a new or reinforced electricity connection with a substation reserve, fibre to every home, and refuse provision agreed with the authority.',
      'Internal: all-electric heat by individual air-source heat pumps with cylinders, roof photovoltaics, continuous ' +
        'ventilation, fabric to the Future Homes Standard with airtightness tested, Part O overheating, Part E acoustics, ' +
        'an Approved Document B fire strategy, Part M accessibility and Part S electric-vehicle charging.',
      'Landscape: private gardens and amenity to the local standard, a public green and equipped play, climate-resilient ' +
        'planting and statutory 10% biodiversity net gain secured for at least 30 years.',
    ],
  });

  // --- Cost plan ---
  h(2, '5. Order-of-cost plan');
  para(
    `${s.assumptions.baseDate} concept allowances, GBP excluding VAT — £${s.assumptions.houseRatePerM2}/m² houses and ` +
    `£${s.assumptions.flatRatePerM2}/m² flats, with common areas and the lift carried in the flat rate. External works are ` +
    `priced separately. Obtain QS package data at Stage 2.`,
  );
  blocks.push({
    kind: 'TABLE',
    caption: 'Elemental order-of-cost to forecast outturn',
    headers: ['Item', 'Basis', 'Amount'],
    rows: s.costPlan.lines.map((l) => [l.item, l.basis, gbp(l.amountMinor)]),
  });
  para(
    `The scheme equates to about ${gbp(s.costPlan.perHomeMinor)} per home at outturn and ${gbp(s.costPlan.perM2Minor)} per m² ` +
    `of building GIA at base construction. Re-index to BCIS tender-price data at award.`,
  );

  // --- Programme ---
  h(2, '6. Indicative programme');
  blocks.push({
    kind: 'TABLE',
    caption: 'RIBA stage programme',
    headers: ['RIBA stage', 'Work', 'Months', 'Cumulative'],
    rows: s.programme.stages.map((st) => [st.stage, st.label, String(st.months), `${st.cumulativeMonths} mo`]),
  });
  para(`Approximately ${s.programme.totalMonths} months from mobilisation to completion, ${s.programme.onSiteMonths} on site.`);

  // --- Assumptions, limits and sources ---
  h(2, '7. Assumptions, limits and sources');
  blocks.push({ kind: 'LIST', ordered: false, items: [...s.assumptionsNarrative, ...s.limits] });
  blocks.push({
    kind: 'TABLE',
    caption: 'Standards and sources',
    headers: ['Ref', 'Title'],
    rows: s.sources.map((src) => [src.ref, src.title]),
  });

  return blocks;
}

/**
 * Best-effort AI narrative for the brief's judgement sections. Returns prose
 * keyed by section, or an empty object where no reasoning provider answers (the
 * local stand-in is dropped, exactly as the document generator drops it). Never
 * throws out to the caller mid-document: a failure leaves the deterministic
 * prose in place.
 */
export async function feasibilityNarrative(
  ctx: EngineContext,
  scheme: FeasibilityScheme,
): Promise<{ narrative: Record<string, string>; acuConsumed: number }> {
  const narrative: Record<string, string> = {};
  let acuConsumed = 0;
  const payload = {
    scheme: {
      authority: scheme.authority, tenure: scheme.tenure, siteAreaHa: scheme.siteAreaHa,
      totals: scheme.totals, accessibility: scheme.accessibility, parking: scheme.parking,
      programme: { totalMonths: scheme.programme.totalMonths, onSiteMonths: scheme.programme.onSiteMonths },
      forecastOutturnMinor: scheme.costPlan.forecastOutturnMinor,
    },
  };
  for (const section of BRIEF_AI_SECTIONS) {
    try {
      const result = await runAI(ctx, {
        engine: 'EXECUTIVE',
        taskType: `feasibility_brief_narrative:${section.key}`,
        capability: 'REASONING',
        inputRefs: [],
        request: {
          task: `${expertBriefing('DEVELOPMENT_MANAGER', { stage: 2 })} ${section.brief}`,
          payload: {
            ...payload,
            constraint:
              'Reason only about the scheme figures supplied. State no figure, date, name, reference or quantity that is ' +
              'not in them. Two or three sentences of plain prose; no headings, no lists.',
          },
        },
        toWrites: () => [],
      });
      acuConsumed += result.acuConsumed;
      if (result.synthetic) continue; // the local stand-in reasons about nothing; drop it.
      const text = String((result.output as { narrative?: unknown; text?: unknown }).narrative ?? (result.output as { text?: unknown }).text ?? '').trim();
      if (text.length > 0) narrative[section.key] = text;
    } catch {
      // A provider outage, an empty wallet or a refused engine: the deterministic
      // prose stands. The brief is never blocked on the AI layer.
    }
  }
  return { narrative, acuConsumed };
}
