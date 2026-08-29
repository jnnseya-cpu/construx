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
 * How the nine sectors group for a reader who is looking for "building".
 *
 * A frontend review found the sector picker credible in every respect except
 * that a construction professional scanning it cannot find `Building`, which is
 * how the industry names half the market. The wrong fix is to add `BUILDING`
 * back as a tenth value: it was retired to `COMMERCIAL` deliberately (see
 * `LEGACY_SECTOR`), it overlaps three of the nine, and reintroducing it would
 * give the same job two codes and break the ONS alignment that lets a figure
 * here be set against a published one.
 *
 * A grouping solves the finding without any of that. The picker shows
 * `Building` as a heading over the three sectors it contains, the stored value
 * is still one of the nine, and nothing downstream changes. `<optgroup>` is
 * what the element is for.
 */
export const SECTOR_GROUPED = [
  ['Building', ['RESIDENTIAL', 'COMMERCIAL', 'INDUSTRIAL']],
  ['Civil and infrastructure', ['TRANSPORT', 'UTILITIES', 'ENERGY']],
  ['Specialised and operational', ['FM', 'RMI', 'PROFESSIONAL']],
].map(([label, codes]) => ({
  label,
  options: codes.map((code) => SECTOR.find((option) => option.value === code)),
}));

/**
 * Where in the world the asset is.
 *
 * `continentCode` was a free string on the project command — validated as
 * `{ type: 'string' }`, offered by no picker, and in practice always `EU`
 * because that is what the seed wrote. A free string is not a region model; it
 * is a field that will hold `EU`, `Europe`, `europe` and `eu` in the same
 * tenancy within a month, and no estate view can group on it.
 *
 * The same review that asked for `Building` asked for America, and was right
 * about the symptom while being one letter out on the cause: the list did not
 * omit the Americas, there was no list. These are the six inhabited regions —
 * `AM` is the Americas, singular, because a Toronto project and a São Paulo
 * project are one commercial region for a business deciding where it operates,
 * and splitting them would be a geography lesson rather than a control.
 */
/**
 * ISO 3166-1 alpha-2, officially assigned, sorted by name.
 *
 * The country was a free-text box with the hint "Two letters, ISO 3166-1 — GB,
 * US, AE", validated server-side against `/^[A-Z]{2}$/`. That regex accepts
 * `ZZ`, `XX` and `QQ` — none of which is a country — so a portfolio could be
 * created in a jurisdiction that does not exist, and the person filling the
 * form had to already know their own country's code to fill it in at all.
 *
 * Two letters is the right thing to *store*: it is the standard, it is stable,
 * and every downstream reader already expects it. Two letters is the wrong
 * thing to *ask for*. A picker of names whose value is the code gives both.
 *
 * Here rather than in the console, so the list the dropdown offers and the list
 * the command validates against are the same bytes rather than two lists that
 * happen to agree.
 */
export const COUNTRY = opts([
  ['AF', 'Afghanistan'],
  ['AX', 'Åland Islands'],
  ['AL', 'Albania'],
  ['DZ', 'Algeria'],
  ['AS', 'American Samoa'],
  ['AD', 'Andorra'],
  ['AO', 'Angola'],
  ['AI', 'Anguilla'],
  ['AQ', 'Antarctica'],
  ['AG', 'Antigua and Barbuda'],
  ['AR', 'Argentina'],
  ['AM', 'Armenia'],
  ['AW', 'Aruba'],
  ['AU', 'Australia'],
  ['AT', 'Austria'],
  ['AZ', 'Azerbaijan'],
  ['BS', 'Bahamas'],
  ['BH', 'Bahrain'],
  ['BD', 'Bangladesh'],
  ['BB', 'Barbados'],
  ['BY', 'Belarus'],
  ['BE', 'Belgium'],
  ['BZ', 'Belize'],
  ['BJ', 'Benin'],
  ['BM', 'Bermuda'],
  ['BT', 'Bhutan'],
  ['BO', 'Bolivia'],
  ['BQ', 'Bonaire, Sint Eustatius and Saba'],
  ['BA', 'Bosnia and Herzegovina'],
  ['BW', 'Botswana'],
  ['BV', 'Bouvet Island'],
  ['BR', 'Brazil'],
  ['IO', 'British Indian Ocean Territory'],
  ['BN', 'Brunei Darussalam'],
  ['BG', 'Bulgaria'],
  ['BF', 'Burkina Faso'],
  ['BI', 'Burundi'],
  ['CV', 'Cabo Verde'],
  ['KH', 'Cambodia'],
  ['CM', 'Cameroon'],
  ['CA', 'Canada'],
  ['KY', 'Cayman Islands'],
  ['CF', 'Central African Republic'],
  ['TD', 'Chad'],
  ['CL', 'Chile'],
  ['CN', 'China'],
  ['CX', 'Christmas Island'],
  ['CC', 'Cocos (Keeling) Islands'],
  ['CO', 'Colombia'],
  ['KM', 'Comoros'],
  ['CG', 'Congo'],
  ['CD', 'Congo, Democratic Republic of the'],
  ['CK', 'Cook Islands'],
  ['CR', 'Costa Rica'],
  ['CI', "Côte d'Ivoire"],
  ['HR', 'Croatia'],
  ['CU', 'Cuba'],
  ['CW', 'Curaçao'],
  ['CY', 'Cyprus'],
  ['CZ', 'Czechia'],
  ['DK', 'Denmark'],
  ['DJ', 'Djibouti'],
  ['DM', 'Dominica'],
  ['DO', 'Dominican Republic'],
  ['EC', 'Ecuador'],
  ['EG', 'Egypt'],
  ['SV', 'El Salvador'],
  ['GQ', 'Equatorial Guinea'],
  ['ER', 'Eritrea'],
  ['EE', 'Estonia'],
  ['SZ', 'Eswatini'],
  ['ET', 'Ethiopia'],
  ['FK', 'Falkland Islands (Malvinas)'],
  ['FO', 'Faroe Islands'],
  ['FJ', 'Fiji'],
  ['FI', 'Finland'],
  ['FR', 'France'],
  ['GF', 'French Guiana'],
  ['PF', 'French Polynesia'],
  ['TF', 'French Southern Territories'],
  ['GA', 'Gabon'],
  ['GM', 'Gambia'],
  ['GE', 'Georgia'],
  ['DE', 'Germany'],
  ['GH', 'Ghana'],
  ['GI', 'Gibraltar'],
  ['GR', 'Greece'],
  ['GL', 'Greenland'],
  ['GD', 'Grenada'],
  ['GP', 'Guadeloupe'],
  ['GU', 'Guam'],
  ['GT', 'Guatemala'],
  ['GG', 'Guernsey'],
  ['GN', 'Guinea'],
  ['GW', 'Guinea-Bissau'],
  ['GY', 'Guyana'],
  ['HT', 'Haiti'],
  ['HM', 'Heard Island and McDonald Islands'],
  ['VA', 'Holy See'],
  ['HN', 'Honduras'],
  ['HK', 'Hong Kong'],
  ['HU', 'Hungary'],
  ['IS', 'Iceland'],
  ['IN', 'India'],
  ['ID', 'Indonesia'],
  ['IR', 'Iran'],
  ['IQ', 'Iraq'],
  ['IE', 'Ireland'],
  ['IM', 'Isle of Man'],
  ['IL', 'Israel'],
  ['IT', 'Italy'],
  ['JM', 'Jamaica'],
  ['JP', 'Japan'],
  ['JE', 'Jersey'],
  ['JO', 'Jordan'],
  ['KZ', 'Kazakhstan'],
  ['KE', 'Kenya'],
  ['KI', 'Kiribati'],
  ['KP', "Korea, Democratic People's Republic of"],
  ['KR', 'Korea, Republic of'],
  ['KW', 'Kuwait'],
  ['KG', 'Kyrgyzstan'],
  ['LA', "Lao People's Democratic Republic"],
  ['LV', 'Latvia'],
  ['LB', 'Lebanon'],
  ['LS', 'Lesotho'],
  ['LR', 'Liberia'],
  ['LY', 'Libya'],
  ['LI', 'Liechtenstein'],
  ['LT', 'Lithuania'],
  ['LU', 'Luxembourg'],
  ['MO', 'Macao'],
  ['MG', 'Madagascar'],
  ['MW', 'Malawi'],
  ['MY', 'Malaysia'],
  ['MV', 'Maldives'],
  ['ML', 'Mali'],
  ['MT', 'Malta'],
  ['MH', 'Marshall Islands'],
  ['MQ', 'Martinique'],
  ['MR', 'Mauritania'],
  ['MU', 'Mauritius'],
  ['YT', 'Mayotte'],
  ['MX', 'Mexico'],
  ['FM', 'Micronesia'],
  ['MD', 'Moldova'],
  ['MC', 'Monaco'],
  ['MN', 'Mongolia'],
  ['ME', 'Montenegro'],
  ['MS', 'Montserrat'],
  ['MA', 'Morocco'],
  ['MZ', 'Mozambique'],
  ['MM', 'Myanmar'],
  ['NA', 'Namibia'],
  ['NR', 'Nauru'],
  ['NP', 'Nepal'],
  ['NL', 'Netherlands'],
  ['NC', 'New Caledonia'],
  ['NZ', 'New Zealand'],
  ['NI', 'Nicaragua'],
  ['NE', 'Niger'],
  ['NG', 'Nigeria'],
  ['NU', 'Niue'],
  ['NF', 'Norfolk Island'],
  ['MK', 'North Macedonia'],
  ['MP', 'Northern Mariana Islands'],
  ['NO', 'Norway'],
  ['OM', 'Oman'],
  ['PK', 'Pakistan'],
  ['PW', 'Palau'],
  ['PS', 'Palestine, State of'],
  ['PA', 'Panama'],
  ['PG', 'Papua New Guinea'],
  ['PY', 'Paraguay'],
  ['PE', 'Peru'],
  ['PH', 'Philippines'],
  ['PN', 'Pitcairn'],
  ['PL', 'Poland'],
  ['PT', 'Portugal'],
  ['PR', 'Puerto Rico'],
  ['QA', 'Qatar'],
  ['RE', 'Réunion'],
  ['RO', 'Romania'],
  ['RU', 'Russian Federation'],
  ['RW', 'Rwanda'],
  ['BL', 'Saint Barthélemy'],
  ['SH', 'Saint Helena, Ascension and Tristan da Cunha'],
  ['KN', 'Saint Kitts and Nevis'],
  ['LC', 'Saint Lucia'],
  ['MF', 'Saint Martin (French part)'],
  ['PM', 'Saint Pierre and Miquelon'],
  ['VC', 'Saint Vincent and the Grenadines'],
  ['WS', 'Samoa'],
  ['SM', 'San Marino'],
  ['ST', 'Sao Tome and Principe'],
  ['SA', 'Saudi Arabia'],
  ['SN', 'Senegal'],
  ['RS', 'Serbia'],
  ['SC', 'Seychelles'],
  ['SL', 'Sierra Leone'],
  ['SG', 'Singapore'],
  ['SX', 'Sint Maarten (Dutch part)'],
  ['SK', 'Slovakia'],
  ['SI', 'Slovenia'],
  ['SB', 'Solomon Islands'],
  ['SO', 'Somalia'],
  ['ZA', 'South Africa'],
  ['GS', 'South Georgia and the South Sandwich Islands'],
  ['SS', 'South Sudan'],
  ['ES', 'Spain'],
  ['LK', 'Sri Lanka'],
  ['SD', 'Sudan'],
  ['SR', 'Suriname'],
  ['SJ', 'Svalbard and Jan Mayen'],
  ['SE', 'Sweden'],
  ['CH', 'Switzerland'],
  ['SY', 'Syrian Arab Republic'],
  ['TW', 'Taiwan'],
  ['TJ', 'Tajikistan'],
  ['TZ', 'Tanzania'],
  ['TH', 'Thailand'],
  ['TL', 'Timor-Leste'],
  ['TG', 'Togo'],
  ['TK', 'Tokelau'],
  ['TO', 'Tonga'],
  ['TT', 'Trinidad and Tobago'],
  ['TN', 'Tunisia'],
  ['TR', 'Türkiye'],
  ['TM', 'Turkmenistan'],
  ['TC', 'Turks and Caicos Islands'],
  ['TV', 'Tuvalu'],
  ['UG', 'Uganda'],
  ['UA', 'Ukraine'],
  ['AE', 'United Arab Emirates'],
  ['GB', 'United Kingdom'],
  ['UM', 'United States Minor Outlying Islands'],
  ['US', 'United States of America'],
  ['UY', 'Uruguay'],
  ['UZ', 'Uzbekistan'],
  ['VU', 'Vanuatu'],
  ['VE', 'Venezuela'],
  ['VN', 'Viet Nam'],
  ['VG', 'Virgin Islands (British)'],
  ['VI', 'Virgin Islands (U.S.)'],
  ['WF', 'Wallis and Futuna'],
  ['EH', 'Western Sahara'],
  ['YE', 'Yemen'],
  ['ZM', 'Zambia'],
  ['ZW', 'Zimbabwe'],
]);

export const CONTINENT = opts([
  ['EU', 'Europe'],
  ['AM', 'Americas'],
  ['AF', 'Africa'],
  ['AS', 'Asia'],
  ['OC', 'Oceania'],
  ['AN', 'Antarctica'],
]);

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

/**
 * How a package is priced. The choice changes what a submission means: a lump
 * sum is a fixed offer, a remeasurable price is a rate against quantities
 * nobody has finalised, and a target cost shares the pain and gain. Comparing
 * two submissions on different bases without saying so is the classic way an
 * award gets challenged.
 */
export const PRICING_BASIS = opts([
  ['LUMP_SUM', 'Lump sum'],
  ['REMEASURABLE', 'Remeasurable'],
  ['TARGET_COST', 'Target cost'],
  ['COST_REIMBURSABLE', 'Cost reimbursable'],
]);
