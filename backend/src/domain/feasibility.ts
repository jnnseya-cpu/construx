import { DomainError } from '../core/errors.ts';

/**
 * Residential feasibility — a scheme from a site and a brief.
 *
 * ---
 *
 * **The gap this closes.** The platform could read an invitation into a
 * compliance matrix, price a measured take-off and generate the construction-
 * phase documents, but it had no way to go the other direction: from a plot and
 * a one-line brief ("a council hectare, social rent, a mix of houses and flats")
 * to a schedule of accommodation, a land budget, an order-of-cost and an
 * indicative programme — the quantitative spine of a feasibility study or an
 * Employer's Requirements brief. A development manager or an employer's agent
 * did that in a spreadsheet nobody could audit.
 *
 * **Why it is deterministic, and honest about it.** Every number here is
 * computed, not judged. Dwelling areas come from the published Nationally
 * Described Space Standard; the land budget apportions the real site area and
 * balances to zero; the cost plan builds up from elemental rates with a stated
 * basis and base date; the programme scales published RIBA stage bands by the
 * size of the scheme. Nothing is invented and nothing is presented as a
 * surveyed fact: the rates are *concept allowances to be replaced by measured
 * design and QS data*, and the whole result carries that qualification. This is
 * the platform's no-fabrication rule applied to feasibility — the honest way to
 * produce a brief full of assumptions is to compute them from a transparent rule
 * and label every one, which is exactly what a good feasibility study does.
 *
 * The AI narrative that wraps these figures into prose, and the policy citations
 * that justify them, are a separate advisory layer: this module is the part that
 * has to be *right*, so it is the part with no model in it.
 */

// ---------------------------------------------------------------------------
// Dwelling archetypes and the Nationally Described Space Standard
// ---------------------------------------------------------------------------

/**
 * Minimum gross internal area (m²) by archetype, from the Nationally Described
 * Space Standard (DCLG, 2015; the figures in force in 2026). Built-in storage is
 * included within these areas per the standard. Values are the standard's own:
 * a fact, not an estimate. House figures are the two-storey column, flats the
 * single-dwelling-level column, which is what social-rent schemes build.
 */
export const DWELLING_ARCHETYPES = [
  { code: '1b2p-flat', label: '1-bed flat', form: 'FLAT', beds: 1, bedspaces: 2, storeys: 1, ndssMinM2: 50 },
  { code: '2b3p-flat', label: '2-bed flat (3p)', form: 'FLAT', beds: 2, bedspaces: 3, storeys: 1, ndssMinM2: 61 },
  { code: '2b4p-flat', label: '2-bed flat (4p)', form: 'FLAT', beds: 2, bedspaces: 4, storeys: 1, ndssMinM2: 70 },
  { code: '3b5p-flat', label: '3-bed flat (5p)', form: 'FLAT', beds: 3, bedspaces: 5, storeys: 1, ndssMinM2: 86 },
  { code: '2b4p-house', label: '2-bed house (4p)', form: 'HOUSE', beds: 2, bedspaces: 4, storeys: 2, ndssMinM2: 79 },
  { code: '3b4p-house', label: '3-bed house (4p)', form: 'HOUSE', beds: 3, bedspaces: 4, storeys: 2, ndssMinM2: 84 },
  { code: '3b5p-house', label: '3-bed house (5p)', form: 'HOUSE', beds: 3, bedspaces: 5, storeys: 2, ndssMinM2: 93 },
  { code: '4b6p-house', label: '4-bed house (6p)', form: 'HOUSE', beds: 4, bedspaces: 6, storeys: 2, ndssMinM2: 106 },
] as const;

export type ArchetypeCode = (typeof DWELLING_ARCHETYPES)[number]['code'];
export type DwellingForm = 'HOUSE' | 'FLAT';

const ARCHETYPE_BY_CODE = new Map(DWELLING_ARCHETYPES.map((a) => [a.code, a]));

// ---------------------------------------------------------------------------
// Scheme assumptions (concept controls, overridable)
// ---------------------------------------------------------------------------

/**
 * The scenario constants the scheme is computed under. Published here, with a
 * base date, so a reader two years later knows what the figures rest on. Every
 * one is overridable per run; the defaults are a Q4-2026 England social-rent
 * basis, informed by BCIS tender-price data and typical social-housing practice.
 * These are concept allowances, not quotes.
 */
export type SchemeAssumptions = {
  baseDate: string;
  /** Uplift on the NDSS minimum to a buildable design area. */
  designUpliftPercent: number;
  /** Flat common area (cores, stairs, lift, corridors, risers, plant) as a share of net flat area. */
  flatCommonPercent: number;
  /** Minimum share of homes to Part M4(2). Birmingham DM10 uses 30%. */
  m4_2MinPercent: number;
  /** Share of homes to M4(3) wheelchair standard. */
  m4_3Percent: number;
  /** Car spaces per house and per flat, plus visitor allowance per home. */
  carPerHouse: number;
  carPerFlat: number;
  visitorPerHome: number;
  /** Cycle spaces per house and per flat. */
  cyclePerHouse: number;
  cyclePerFlat: number;
  /** Elemental building rate, £/m² GIA, houses and flats (flats carry lifts and common areas). */
  houseRatePerM2: number;
  flatRatePerM2: number;
  /** External works allowances, £ per home unless noted. */
  enablingPerHome: number;
  roadsPerHome: number;
  drainagePerHome: number;
  utilitiesPerHome: number;
  landscapePerHome: number;
  externalStoresPerHome: number;
  /** On-costs. */
  prelimsPercent: number;
  overheadProfitPercent: number;
  professionalFeesPercent: number;
  statutoryLegalPerHome: number;
  planningObligationsPerHome: number;
  /** Client-held risk as a share of base construction. */
  riskPercent: number;
  /** Tender inflation to the construction mid-point, as a share of base construction. */
  inflationPercent: number;
  /** Land-budget rates (m²). */
  gardenPerHouseM2: number;
  flatAmenityPerFlatM2: number;
  streetPerHomeM2: number;
  carBayM2: number;
  openSpacePerHomeM2: number;
  sudsShareOfSiteM2Percent: number;
};

export const DEFAULT_ASSUMPTIONS: SchemeAssumptions = {
  baseDate: '2026-Q4',
  designUpliftPercent: 7,
  flatCommonPercent: 18,
  m4_2MinPercent: 30,
  m4_3Percent: 4,
  carPerHouse: 1.0,
  carPerFlat: 0.58,
  visitorPerHome: 0.12,
  cyclePerHouse: 2,
  cyclePerFlat: 1.2,
  houseRatePerM2: 2300,
  flatRatePerM2: 2650,
  enablingPerHome: 7600,
  roadsPerHome: 11200,
  drainagePerHome: 12000,
  utilitiesPerHome: 8400,
  landscapePerHome: 9000,
  externalStoresPerHome: 4200,
  prelimsPercent: 12,
  overheadProfitPercent: 6,
  professionalFeesPercent: 9,
  statutoryLegalPerHome: 4600,
  planningObligationsPerHome: 6000,
  riskPercent: 10,
  inflationPercent: 6,
  gardenPerHouseM2: 62,
  flatAmenityPerFlatM2: 9,
  streetPerHomeM2: 34,
  carBayM2: 18,
  openSpacePerHomeM2: 30,
  sudsShareOfSiteM2Percent: 11,
};

export type MixEntry = { code: ArchetypeCode; count: number };

export type FeasibilityInput = {
  /** What the scheme is called, for the record. */
  schemeName: string;
  /** Planning authority / location label. */
  authority: string;
  tenure: string;
  /** Gross site area in hectares. */
  siteAreaHa: number;
  /** The dwelling mix as explicit counts — the quantitative truth a person decides. */
  mix: MixEntry[];
  /** Partial overrides on the scenario assumptions. */
  assumptions?: Partial<SchemeAssumptions>;
};

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export type ScheduleLine = {
  code: ArchetypeCode;
  label: string;
  form: DwellingForm;
  count: number;
  bedspacesEach: number;
  ndssMinM2: number;
  designM2: number;
  totalDesignM2: number;
  totalBedspaces: number;
};

export type CostLine = { item: string; basis: string; amountMinor: number };

export type LandUse = { use: string; areaM2: number; note: string };

export type ProgrammeStage = { stage: string; label: string; months: number; cumulativeMonths: number };

export type FeasibilityScheme = {
  schemeName: string;
  authority: string;
  tenure: string;
  siteAreaM2: number;
  siteAreaHa: number;
  assumptions: SchemeAssumptions;
  schedule: ScheduleLine[];
  totals: {
    homes: number;
    houses: number;
    flats: number;
    bedspaces: number;
    familyHomes: number;
    familyHomePercent: number;
    netDwellingGiaM2: number;
    houseBuildingGiaM2: number;
    flatBuildingGiaM2: number;
    costedBuildingGiaM2: number;
    densityDph: number;
  };
  accessibility: { m4_2: number; m4_2Percent: number; m4_3: number; m4_1: number; meetsPolicy: boolean };
  parking: { houseSpaces: number; flatSpaces: number; visitorSpaces: number; totalSpaces: number; cycleSpaces: number };
  landBudget: { uses: LandUse[]; allocatedM2: number; balanceM2: number; overSite: boolean };
  costPlan: {
    lines: CostLine[];
    directWorksMinor: number;
    baseConstructionMinor: number;
    baseInclRiskMinor: number;
    forecastOutturnMinor: number;
    perHomeMinor: number;
    perM2Minor: number;
  };
  programme: { stages: ProgrammeStage[]; totalMonths: number; onSiteMonths: number };
  assumptionsNarrative: string[];
  sources: Array<{ ref: string; title: string }>;
  limits: string[];
};

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

const round = (n: number, dp = 0): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};
const poundsToMinor = (pounds: number): number => Math.round(pounds * 100);

/**
 * A deterministic mix suggestion for an empty brief, so a short instruction can
 * reach a first schedule to adjust. A transparent rule, never a hidden one: it
 * fills the site to a target density with a family-weighted social-rent mix and
 * states that it is a starting point. The person then edits the counts, which is
 * where the real decision lives.
 */
export function suggestMix(siteAreaHa: number, densityDph = 50, familyWeighted = true): MixEntry[] {
  if (siteAreaHa <= 0) throw new DomainError('SITE_AREA_REQUIRED', 'A site area in hectares is needed to suggest a mix', 422);
  const homes = Math.max(1, Math.round(siteAreaHa * densityDph));
  // Half houses, half flats; family-weighted shares within each.
  const houses = Math.round(homes * (familyWeighted ? 0.48 : 0.4));
  const flats = homes - houses;
  const h3 = Math.round(houses * 0.58);
  const h2 = houses - h3;
  const f1 = Math.round(flats * 0.46);
  const f3 = Math.round(flats * 0.16);
  const f2 = flats - f1 - f3;
  return [
    { code: '2b4p-house', count: h2 },
    { code: '3b5p-house', count: h3 },
    { code: '1b2p-flat', count: f1 },
    { code: '2b4p-flat', count: f2 },
    { code: '3b5p-flat', count: f3 },
  ].filter((e) => e.count > 0) as MixEntry[];
}

export function feasibilityScheme(input: FeasibilityInput): FeasibilityScheme {
  if (!input.schemeName?.trim()) throw new DomainError('SCHEME_NAME_REQUIRED', 'Name the scheme', 422);
  if (!(input.siteAreaHa > 0)) throw new DomainError('SITE_AREA_REQUIRED', 'A positive site area in hectares is required', 422);
  if (!input.mix || input.mix.length === 0) {
    throw new DomainError('MIX_REQUIRED', 'A dwelling mix is required. Call suggestMix for a starting point, then adjust the counts.', 422);
  }
  const a: SchemeAssumptions = { ...DEFAULT_ASSUMPTIONS, ...(input.assumptions ?? {}) };
  const siteAreaM2 = round(input.siteAreaHa * 10000);

  // --- Schedule of accommodation ---
  const schedule: ScheduleLine[] = input.mix.map((entry) => {
    const arch = ARCHETYPE_BY_CODE.get(entry.code);
    if (!arch) throw new DomainError('ARCHETYPE_UNKNOWN', `No dwelling archetype "${entry.code}"`, 422);
    if (!Number.isInteger(entry.count) || entry.count < 0) {
      throw new DomainError('MIX_COUNT_INVALID', `Count for ${entry.code} must be a non-negative whole number`, 422);
    }
    const designM2 = round(arch.ndssMinM2 * (1 + a.designUpliftPercent / 100), 1);
    return {
      code: arch.code, label: arch.label, form: arch.form, count: entry.count,
      bedspacesEach: arch.bedspaces, ndssMinM2: arch.ndssMinM2, designM2,
      totalDesignM2: round(designM2 * entry.count, 1),
      totalBedspaces: arch.bedspaces * entry.count,
    };
  }).filter((l) => l.count > 0);

  const homes = schedule.reduce((s, l) => s + l.count, 0);
  if (homes === 0) throw new DomainError('MIX_EMPTY', 'The mix totals zero homes', 422);
  const houses = schedule.filter((l) => l.form === 'HOUSE').reduce((s, l) => s + l.count, 0);
  const flats = homes - houses;
  const bedspaces = schedule.reduce((s, l) => s + l.totalBedspaces, 0);
  const familyHomes = schedule.filter((l) => l.bedspacesEach >= 4).reduce((s, l) => s + l.count, 0);
  const netDwellingGia = round(schedule.reduce((s, l) => s + l.totalDesignM2, 0), 1);
  const houseGia = round(schedule.filter((l) => l.form === 'HOUSE').reduce((s, l) => s + l.totalDesignM2, 0), 1);
  const flatNetGia = round(netDwellingGia - houseGia, 1);
  const flatBuildingGia = round(flatNetGia * (1 + a.flatCommonPercent / 100), 1);
  const costedBuildingGia = round(houseGia + flatBuildingGia, 1);
  const densityDph = round(homes / input.siteAreaHa, 1);

  // --- Accessibility ---
  const m4_2 = Math.ceil(homes * (a.m4_2MinPercent / 100));
  const m4_3 = Math.max(flats > 0 ? 1 : 0, Math.round(homes * (a.m4_3Percent / 100)));
  const accessibility = {
    m4_2, m4_2Percent: round((m4_2 / homes) * 100, 1), m4_3,
    m4_1: Math.max(0, homes - m4_2 - m4_3),
    meetsPolicy: (m4_2 / homes) * 100 >= a.m4_2MinPercent - 0.05,
  };

  // --- Parking & cycle ---
  const houseSpaces = Math.round(houses * a.carPerHouse);
  const flatSpaces = Math.round(flats * a.carPerFlat);
  const visitorSpaces = Math.round(homes * a.visitorPerHome);
  const parking = {
    houseSpaces, flatSpaces, visitorSpaces,
    totalSpaces: houseSpaces + flatSpaces + visitorSpaces,
    cycleSpaces: Math.round(houses * a.cyclePerHouse + flats * a.cyclePerFlat),
  };

  // --- Cost plan (minor units) ---
  const housesCost = poundsToMinor(houseGia * a.houseRatePerM2);
  const flatsCost = poundsToMinor(flatBuildingGia * a.flatRatePerM2);
  const enabling = poundsToMinor(homes * a.enablingPerHome);
  const roads = poundsToMinor(homes * a.roadsPerHome);
  const drainage = poundsToMinor(homes * a.drainagePerHome);
  const utilities = poundsToMinor(homes * a.utilitiesPerHome);
  const landscape = poundsToMinor(homes * a.landscapePerHome);
  const stores = poundsToMinor(homes * a.externalStoresPerHome);
  const directWorks = housesCost + flatsCost + enabling + roads + drainage + utilities + landscape + stores;
  const prelims = Math.round(directWorks * (a.prelimsPercent / 100));
  const ohp = Math.round((directWorks + prelims) * (a.overheadProfitPercent / 100));
  const baseConstruction = directWorks + prelims + ohp;
  const worksForFees = housesCost + flatsCost + enabling + roads + drainage + utilities + landscape + stores;
  const fees = Math.round(worksForFees * (a.professionalFeesPercent / 100));
  const statutory = poundsToMinor(homes * a.statutoryLegalPerHome);
  const planningObligations = poundsToMinor(homes * a.planningObligationsPerHome);
  const risk = Math.round(baseConstruction * (a.riskPercent / 100));
  const baseInclRisk = baseConstruction + fees + statutory + planningObligations + risk;
  const inflation = Math.round(baseConstruction * (a.inflationPercent / 100));
  const forecastOutturn = baseInclRisk + inflation;

  const costLines: CostLine[] = [
    { item: 'Houses', basis: `${houseGia.toLocaleString('en-GB')} m² × £${a.houseRatePerM2}/m²`, amountMinor: housesCost },
    { item: 'Flats', basis: `${flatBuildingGia.toLocaleString('en-GB')} m² × £${a.flatRatePerM2}/m²`, amountMinor: flatsCost },
    { item: 'Clearance, earthworks & enabling', basis: `${homes} homes × £${a.enablingPerHome}`, amountMinor: enabling },
    { item: 'Roads, footways, parking & S278', basis: `${homes} homes × £${a.roadsPerHome}`, amountMinor: roads },
    { item: 'Foul, surface drainage & SuDS', basis: `${homes} homes × £${a.drainagePerHome}`, amountMinor: drainage },
    { item: 'Utilities & site lighting', basis: `${homes} homes × £${a.utilitiesPerHome}`, amountMinor: utilities },
    { item: 'Landscape, gardens, play & BNG', basis: `${homes} homes × £${a.landscapePerHome}`, amountMinor: landscape },
    { item: 'External stores & ancillary', basis: `${homes} homes × £${a.externalStoresPerHome}`, amountMinor: stores },
    { item: 'Direct works', basis: 'Buildings + external + enabling', amountMinor: directWorks },
    { item: 'Main contractor preliminaries', basis: `${a.prelimsPercent}% of direct works`, amountMinor: prelims },
    { item: 'Overhead & profit', basis: `${a.overheadProfitPercent}% of works + preliminaries`, amountMinor: ohp },
    { item: 'Base construction cost', basis: `${a.baseDate} contractor scope`, amountMinor: baseConstruction },
    { item: 'Client professional & surveys', basis: `${a.professionalFeesPercent}% of works`, amountMinor: fees },
    { item: 'Statutory, legal & warranties', basis: `${homes} homes × £${a.statutoryLegalPerHome}`, amountMinor: statutory },
    { item: 'Planning obligations (provisional)', basis: `${homes} homes × £${a.planningObligationsPerHome}`, amountMinor: planningObligations },
    { item: 'Client-held risk', basis: `${a.riskPercent}% of base construction`, amountMinor: risk },
    { item: 'Base total including risk', basis: 'Before escalation', amountMinor: baseInclRisk },
    { item: 'Inflation allowance', basis: `${a.inflationPercent}% of contractor scope to mid-point`, amountMinor: inflation },
    { item: 'Forecast outturn', basis: 'Nominal total before excluded items', amountMinor: forecastOutturn },
  ];

  // --- Land budget (apportioned, then balanced) ---
  const houseFootprint = round(houseGia / 2, 0);
  const flatFootprint = round(flatBuildingGia / 3, 0);
  const gardens = round(houses * a.gardenPerHouseM2 + flats * a.flatAmenityPerFlatM2, 0);
  const street = round(homes * a.streetPerHomeM2, 0);
  const parkingArea = round(parking.totalSpaces * a.carBayM2, 0);
  const openSpace = round(homes * a.openSpacePerHomeM2, 0);
  const suds = round(siteAreaM2 * (a.sudsShareOfSiteM2Percent / 100), 0);
  const allocated = houseFootprint + flatFootprint + gardens + street + parkingArea + openSpace + suds;
  const balance = round(siteAreaM2 - allocated, 0);
  const landUses: LandUse[] = [
    { use: 'House footprints', areaM2: houseFootprint, note: 'House GIA over two storeys' },
    { use: 'Flat block footprints', areaM2: flatFootprint, note: 'Flat building GIA over three storeys' },
    { use: 'Gardens & private amenity', areaM2: gardens, note: 'LW-13 house gardens plus flat amenity' },
    { use: 'Internal street & footways', areaM2: street, note: `${a.streetPerHomeM2} m²/home allowance` },
    { use: 'Parking & margins', areaM2: parkingArea, note: `${parking.totalSpaces} spaces × ${a.carBayM2} m²` },
    { use: 'Public open space & play', areaM2: openSpace, note: `${a.openSpacePerHomeM2} m²/home benchmark` },
    { use: 'SuDS & habitat corridor', areaM2: suds, note: `${a.sudsShareOfSiteM2Percent}% of site` },
    { use: balance >= 0 ? 'Undeveloped / flexibility' : 'OVER SITE — reduce density', areaM2: balance, note: balance >= 0 ? 'Balancing line against the red line' : 'Allocated uses exceed the site; reduce the mix or density' },
  ];

  // --- Programme (RIBA bands scaled by scheme size) ---
  const onSiteMonths = Math.max(14, Math.round(12 + homes * 0.16));
  const programmeBands: Array<{ stage: string; label: string; months: number }> = [
    { stage: '0–1', label: 'Mobilise, brief & feasibility', months: 3 },
    { stage: '2', label: 'Concept design & options', months: 4 },
    { stage: '3', label: 'Spatial coordination & planning', months: 4 },
    { stage: 'Planning', label: 'Determination, S106 & conditions', months: 7 },
    { stage: '4', label: 'Technical design, pre-construction & award', months: 5 },
    { stage: '5', label: 'Construction', months: onSiteMonths },
    { stage: '6–7', label: 'Handover, defects & aftercare', months: 12 },
  ];
  let cum = 0;
  const stages: ProgrammeStage[] = programmeBands.map((b) => {
    cum += b.months;
    return { stage: b.stage, label: b.label, months: b.months, cumulativeMonths: cum };
  });
  // Time to completion excludes the post-completion defects/aftercare tail.
  const totalMonths = cum - 12;

  return {
    schemeName: input.schemeName, authority: input.authority, tenure: input.tenure,
    siteAreaM2, siteAreaHa: input.siteAreaHa, assumptions: a, schedule,
    totals: {
      homes, houses, flats, bedspaces, familyHomes,
      familyHomePercent: round((familyHomes / homes) * 100, 1),
      netDwellingGiaM2: netDwellingGia, houseBuildingGiaM2: houseGia,
      flatBuildingGiaM2: flatBuildingGia, costedBuildingGiaM2: costedBuildingGia, densityDph,
    },
    accessibility, parking,
    landBudget: { uses: landUses, allocatedM2: allocated, balanceM2: balance, overSite: balance < 0 },
    costPlan: {
      lines: costLines, directWorksMinor: directWorks, baseConstructionMinor: baseConstruction,
      baseInclRiskMinor: baseInclRisk, forecastOutturnMinor: forecastOutturn,
      perHomeMinor: Math.round(forecastOutturn / homes),
      perM2Minor: Math.round(baseConstruction / costedBuildingGia),
    },
    programme: { stages, totalMonths, onSiteMonths },
    assumptionsNarrative: [
      `Dwelling areas are the NDSS minimum plus a ${a.designUpliftPercent}% design uplift; verify each independently.`,
      `Costs are ${a.baseDate} concept allowances (£${a.houseRatePerM2}/m² houses, £${a.flatRatePerM2}/m² flats), to be replaced by QS package data at Stage 2.`,
      `The land budget apportions the ${siteAreaM2.toLocaleString('en-GB')} m² red line and balances to a flexibility line; it is not a surveyed layout.`,
      'Site conditions, network capacity, outfall, contamination and planning position are all unverified at this stage.',
    ],
    sources: [
      { ref: 'NDSS', title: 'Nationally Described Space Standard (dwelling areas)' },
      { ref: 'ADM', title: 'Approved Document M — M4(1)/M4(2)/M4(3) accessibility' },
      { ref: 'FHS', title: 'Future Homes Standard — fabric, low-carbon heat and solar' },
      { ref: 'BNG', title: 'Statutory biodiversity net gain (10%)' },
      { ref: 'BCIS', title: 'BCIS tender-price basis for the cost rates' },
      { ref: 'RIBA', title: 'RIBA Plan of Work stages for the programme' },
    ],
    limits: [
      'This is a concept-stage feasibility output, not a design, a quotation or a planning position.',
      'Every quantity and rate is a control to be replaced by measured design and written statutory and QS responses before tender.',
    ],
  };
}
