/**
 * Canonical enumerations.
 *
 * Every dropdown in the application reads from here, and every value matches
 * the enum the API validates against. The review that prompted this was
 * specific: "Sector dropdown ≠ Portfolio list enum... This breaks canonical
 * data model." A picker that offers a value the command will reject is worse
 * than a free-text box, because it looks authoritative.
 *
 * If a value here drifts from the API schema the command fails loudly with a
 * validation error naming the field, rather than writing something the engines
 * cannot read.
 */

const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

export const SECTOR_TYPE = opts([
  ['BUILDING', 'Building — residential, commercial, industrial, public'],
  ['INFRASTRUCTURE', 'Civil and infrastructure — transport, utilities, energy'],
  ['SPECIALISED', 'Specialised and operational — demolition, MEP, fit-out, FM'],
]);

export const LIFECYCLE_PHASE = opts([
  ['CONCEPT', 'Concept'],
  ['DESIGN', 'Design'],
  ['TENDER', 'Tender'],
  ['CONSTRUCTION', 'Construction'],
  ['COMMISSIONING', 'Commissioning'],
  ['HANDOVER', 'Handover'],
  ['OPERATIONS', 'Operations and O&M'],
]);

export const CONTRACT_SUITE = opts([
  ['NEC4', 'NEC4'],
  ['JCT', 'JCT'],
  ['FIDIC', 'FIDIC'],
  ['ICHEME', 'IChemE'],
  ['MF1', 'MF/1'],
  ['BESPOKE', 'Bespoke'],
]);

export const PROCUREMENT_ROUTE = opts([
  ['TRADITIONAL', 'Traditional'],
  ['DESIGN_AND_BUILD', 'Design and build'],
  ['CONSTRUCTION_MANAGEMENT', 'Construction management'],
  ['MANAGEMENT_CONTRACTING', 'Management contracting'],
  ['FRAMEWORK', 'Framework call-off'],
  ['TWO_STAGE', 'Two-stage'],
]);

export const COMMERCIAL_MODEL = opts([
  ['LUMP_SUM', 'Lump sum'],
  ['REMEASURABLE', 'Remeasurable'],
  ['TARGET_COST', 'Target cost with pain/gain'],
  ['COST_PLUS', 'Cost plus fee'],
  ['GMP', 'Guaranteed maximum price'],
]);

export const CURRENCY = opts([
  ['GBP', 'GBP — pound sterling'],
  ['EUR', 'EUR — euro'],
  ['USD', 'USD — US dollar'],
]);

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

export const CAPTURE_SOURCE = opts([
  ['DRONE', 'Drone'],
  ['SITE_PHOTO', 'Site photograph'],
  ['LASER_SCAN', 'Laser scan'],
  ['MANUAL_SURVEY', 'Manual survey'],
]);

/** Today as an ISO date, for defaulting date pickers without a clock in markup. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}
