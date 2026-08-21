/**
 * The canonical vocabulary — one list per concept, read by both sides.
 *
 * Every value the API validates against and every option a dropdown offers
 * comes from here. Before this file the two were separate declarations that
 * happened to agree, kept in step by whoever remembered. They did agree; that
 * is not the same as being unable to disagree, and the review that prompted the
 * original list was specific about the failure mode: "Sector dropdown ≠
 * Portfolio list enum... This breaks canonical data model." A picker offering a
 * value the command will reject is worse than a free-text box, because it looks
 * authoritative.
 *
 * ---
 *
 * **Why this is `.js` and not `.ts`.** The browser has to run it unmodified and
 * the backend has to import it without a build. Plain ES modules are the only
 * form both can read — the same constraint that produced settled decisions 2
 * (no runtime dependencies) and 3 (no build step).
 *
 * **Why serving it does not contradict decision 6.** The interface never holds
 * a rule the API does not publish. The gateway serves this exact file at
 * `/shared/vocabulary.js`, so the browser is not holding a copy of the rule —
 * it is holding the rule, byte for byte, and the route schemas are validating
 * against the same bytes. That is a stronger guarantee than publishing a copy
 * over an endpoint, not a weaker one.
 *
 * **What does not belong here.** Anything that decides an outcome. This file is
 * a vocabulary — names and labels. Permission matrices, phase gates, pricing
 * and statutory periods stay server-side and are fetched, exactly as before.
 */

/** `[code, label]` pairs to the `{ value, label }` shape a `<select>` wants. */
const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

/** The codes alone, for a JSON Schema `enum`. */
export const values = (vocabulary) => vocabulary.map((option) => option.value);

export const DISCIPLINE = opts([
  ['CIVILS', 'Civils'],
  ['STRUCTURES', 'Structures'],
  ['MECHANICAL', 'Mechanical'],
  ['ELECTRICAL', 'Electrical'],
  ['ARCHITECTURAL', 'Architectural'],
  ['PROCESS', 'Process'],
  ['TEMPORARY_WORKS', 'Temporary works'],
]);

export const RISK_CATEGORY = opts([
  ['DESIGN', 'Design'],
  ['GROUND', 'Ground conditions'],
  ['WEATHER', 'Weather'],
  ['SUPPLY_CHAIN', 'Supply chain'],
  ['LABOUR', 'Labour'],
  ['REGULATORY', 'Regulatory'],
  ['COMMERCIAL', 'Commercial'],
  ['SAFETY', 'Safety'],
]);

export const CHANGE_ORIGIN = opts([
  ['CLIENT_INSTRUCTION', 'Client instruction'],
  ['DESIGN_DEVELOPMENT', 'Design development'],
  ['SITE_CONDITION', 'Site condition'],
  ['STATUTORY', 'Statutory requirement'],
  ['ERROR_OMISSION', 'Error or omission'],
  ['SUPPLY_CHAIN', 'Supply chain'],
]);

export const DELAY_CAUSE = opts([
  ['CLIENT_CHANGE', 'Client change'],
  ['DESIGN_LATE', 'Late design information'],
  ['WEATHER_EXCEPTIONAL', 'Exceptional weather'],
  ['CONTRACTOR_PRODUCTIVITY', 'Contractor productivity'],
  ['SUBCONTRACTOR_DEFAULT', 'Subcontractor default'],
  ['STATUTORY_UNDERTAKER', 'Statutory undertaker'],
  ['UNFORESEEN_GROUND', 'Unforeseen ground conditions'],
]);

export const NOTICE_TYPE = opts([
  ['EARLY_WARNING', 'Early warning'],
  ['COMPENSATION_EVENT', 'Compensation event'],
  ['EXTENSION_OF_TIME', 'Extension of time'],
  ['PAYMENT_NOTICE', 'Payment notice'],
  ['PAY_LESS_NOTICE', 'Pay-less notice'],
  ['DEFAULT', 'Notice of default'],
]);

export const OBSERVATION_TYPE = opts([
  ['UNSAFE_ACT', 'Unsafe act'],
  ['UNSAFE_CONDITION', 'Unsafe condition'],
  ['NEAR_MISS', 'Near miss'],
  ['GOOD_PRACTICE', 'Good practice'],
]);

/** A site walk, deliberately not a safety observation — that has its own list. */
export const SITE_OBSERVATION_CATEGORY = opts([
  ['QUALITY', 'Quality'],
  ['WORKMANSHIP', 'Workmanship'],
  ['PROGRESS', 'Progress'],
  ['ACCESS', 'Access'],
  ['MATERIALS', 'Materials'],
  ['HOUSEKEEPING', 'Housekeeping'],
  ['ENVIRONMENTAL', 'Environmental'],
]);

export const WEATHER_CONDITION = opts([
  ['DRY', 'Dry'],
  ['LIGHT_RAIN', 'Light rain'],
  ['HEAVY_RAIN', 'Heavy rain'],
  ['HIGH_WIND', 'High wind'],
  ['FROST', 'Frost'],
  ['SNOW', 'Snow'],
  ['HEAT', 'Excessive heat'],
]);

/**
 * Sector, on the classification the industry and its statistics already use.
 *
 * It replaces a three-value list — `BUILDING | INFRASTRUCTURE | SPECIALISED` —
 * that could not carry the distinctions the platform is asked to reason about.
 * Sector drives template selection, risk weighting, contract form and the cost
 * library, and none of those behave the same way for a water treatment works
 * and a residential block. Calling both `INFRASTRUCTURE` or both `BUILDING`
 * makes the sector field decorative.
 *
 * The nine are the ONS construction-output categories, so a figure produced
 * here can be set against a published one without a mapping table in between.
 * `RMI` is repair, maintenance and improvement — existing-asset work, which
 * prices and programmes unlike new build and is why it is its own category
 * rather than a flag on the others.
 */
export const SECTOR = opts([
  ['RESIDENTIAL', 'Residential'],
  ['COMMERCIAL', 'Commercial'],
  ['INDUSTRIAL', 'Industrial'],
  ['TRANSPORT', 'Transport'],
  ['UTILITIES', 'Utilities'],
  ['ENERGY', 'Energy'],
  ['FM', 'Facilities management'],
  ['RMI', 'Repair, maintenance and improvement'],
  ['PROFESSIONAL', 'Professional services'],
]);

/**
 * Sector codes that predate the list above, and what each becomes on read.
 *
 * The ledger is append-only, so a record committed under the old vocabulary
 * keeps the code it was written with — it cannot be edited and should not be.
 * Reading is where the translation belongs. `SPECIALISED` has no honest single
 * answer, so it goes to `INDUSTRIAL`, the category it was used for in practice.
 *
 * This map is not a migration that will one day be run and deleted. It is how
 * old records stay readable for as long as they exist, which for a seven-year
 * statutory record is longer than the vocabulary that replaced them.
 */
export const LEGACY_SECTOR = {
  BUILDING: 'COMMERCIAL',
  INFRASTRUCTURE: 'TRANSPORT',
  SPECIALISED: 'INDUSTRIAL',
};

/** Resolve any sector code — current or superseded — to a current one. */
export const currentSector = (code) => LEGACY_SECTOR[code] ?? code;

/**
 * Standard forms of contract. The same list the claims engine reasons about:
 * a picker offering a form the engine cannot interpret would produce notices
 * against clauses that do not exist.
 */
export const CONTRACT_FORM = opts([
  ['JCT', 'JCT'],
  ['NEC4', 'NEC4'],
  ['FIDIC', 'FIDIC'],
  ['ICHEME', 'IChemE'],
  ['MF1', 'MF/1'],
  ['BESPOKE', 'Bespoke'],
]);
