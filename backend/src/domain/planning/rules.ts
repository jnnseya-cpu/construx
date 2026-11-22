import { hashEvidence } from '../../core/canonical.ts';

/**
 * The first-release planning rules for conventional new housing in England,
 * evaluated deterministically.
 *
 * Each finding carries a code, a status (`applies`, `does_not_apply`,
 * `review_required`, `unavailable`), its reason, the inputs it read, the
 * evidence it needs, the gate it bears on, its source and the rule version.
 * An unknown input is three-valued: it raises review where it could change
 * the outcome, and is reported as unavailable where it could not. Nothing is
 * ever inferred from silence — a flood zone nobody has recorded is unknown,
 * never Flood Zone 1.
 *
 * The thresholds are held in one object (`THRESHOLDS`) whose hash is the rule
 * pack's content, so a publication pins exactly these numbers.
 */

export const RULE_PACK_VERSION = 'england-housing-rules-2026-11';

export const THRESHOLDS = {
  majorDwellings: 10,
  majorUnknownCountAreaM2: 5_000,
  majorSiteAreaM2: 10_000,
  majorFloorspaceM2: 1_000,
  fraFloodZone1AreaM2: 10_000,
  eiaDwellingsOver: 150,
  eiaSiteAreaOverM2: 50_000,
  determinationWeeks: { major: 13, eia: 16, other: 8 },
  bngObjectivePercent: 10,
} as const;

export const rulePackHash = (): string => hashEvidence(JSON.stringify(THRESHOLDS));

export type FindingStatus = 'applies' | 'does_not_apply' | 'review_required' | 'unavailable';
export type SourceKind = 'LEGISLATION' | 'NATIONAL_GUIDANCE' | 'LOCAL' | 'PROJECT' | 'BEST_PRACTICE';
export type Gate = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5';

export type Finding = {
  code: string;
  title: string;
  status: FindingStatus;
  reason: string;
  inputs: Record<string, string | number | boolean | null>;
  evidenceNeeded: string[];
  gate: Gate;
  source: { kind: SourceKind; title: string; url: string };
  ruleVersion: string;
};

/** The facts a person records about the site, each with its own source. */
export const SITE_FACTS = {
  FLOOD_ZONE: { label: 'Flood zone (Flood Map for Planning)', values: ['1', '2', '3a', '3b'] },
  CRITICAL_DRAINAGE_AREA: { label: 'In a critical drainage area', values: ['YES', 'NO'] },
  SURFACE_WATER_RISK: { label: 'Surface water flood risk', values: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
  FUTURE_FLOOD_RISK: { label: 'Increased flood risk in future (SFRA)', values: ['YES', 'NO'] },
  EIA_SENSITIVE_AREA: { label: 'In or near a sensitive area (EIA Regulations reg. 2)', values: ['YES', 'NO'] },
  EIA_CUMULATIVE: { label: 'Cumulative or linked development', values: ['FOUND', 'NONE_FOUND'] },
  EIA_SCREENING_OPINION: { label: 'Formal EIA screening opinion', values: ['ES_REQUIRED', 'ES_NOT_REQUIRED'] },
  HRA_SCREENING: { label: 'Habitats Regulations screening', values: ['NO_LIKELY_SIGNIFICANT_EFFECT', 'APPROPRIATE_ASSESSMENT'] },
  PROTECTED_SPECIES: { label: 'Protected species survey', values: ['NONE_FOUND', 'PRESENT'] },
  BNG_APPLICABILITY: { label: 'Biodiversity net gain applicability', values: ['APPLIES', 'EXEMPT'] },
  LOCAL_VALIDATION_LIST: { label: 'Authority’s local validation list', values: ['VERIFIED_CURRENT', 'UNAVAILABLE_OR_DISPUTED'] },
  CIL_CHARGING_SCHEDULE: { label: 'CIL charging schedule', values: ['IN_FORCE', 'NONE_ADOPTED'] },
} as const;
export type SiteFactKey = keyof typeof SITE_FACTS;

export type RuleInput = {
  use: 'HOUSING' | 'MIXED' | 'OTHER';
  /** The area rules use: the confirmed red-line area where there is one, otherwise the calculated one. */
  siteAreaM2: number | null;
  areaBasis: 'CONFIRMED' | 'CALCULATED' | 'NONE';
  areaReviewReasons: string[];
  authorityConfirmed: boolean;
  dwellings: number | null;
  createdGiaM2: number | null;
  facts: Partial<Record<SiteFactKey, string>>;
};

const SOURCES = {
  dmpo: { kind: 'LEGISLATION' as const, title: 'DMPO 2015, article 2 (major development)', url: 'https://www.legislation.gov.uk/uksi/2015/595/article/2' },
  fra: { kind: 'NATIONAL_GUIDANCE' as const, title: 'Environment Agency: flood risk assessment in flood zones 1, 2, 3 and 3b', url: 'https://www.gov.uk/guidance/flood-risk-assessment-flood-zones-1-2-3-and-3b' },
  eia: { kind: 'LEGISLATION' as const, title: 'EIA Regulations 2017, Schedule 2 (10(b) urban development)', url: 'https://www.legislation.gov.uk/uksi/2017/571/schedule/2' },
  bng: { kind: 'NATIONAL_GUIDANCE' as const, title: 'Biodiversity net gain', url: 'https://www.gov.uk/guidance/biodiversity-net-gain' },
  application: { kind: 'NATIONAL_GUIDANCE' as const, title: 'Making an application', url: 'https://www.gov.uk/guidance/making-an-application' },
  determination: { kind: 'NATIONAL_GUIDANCE' as const, title: 'Determining a planning application', url: 'https://www.gov.uk/guidance/determining-a-planning-application' },
  cil: { kind: 'LEGISLATION' as const, title: 'Community Infrastructure Levy Regulations 2010', url: 'https://www.legislation.gov.uk/uksi/2010/948' },
  hra: { kind: 'NATIONAL_GUIDANCE' as const, title: 'Habitats regulations assessments', url: 'https://www.gov.uk/guidance/appropriate-assessment' },
  project: { kind: 'PROJECT' as const, title: 'The project’s own record', url: '' },
};

const ha = (m2: number): string => `${(m2 / 10_000).toFixed(4)} ha`;

export type Evaluation = {
  ruleVersion: string;
  major: 'MAJOR' | 'NOT_MAJOR' | 'UNRESOLVED';
  findings: Finding[];
};

export function evaluateRules(input: RuleInput): Evaluation {
  const findings: Finding[] = [];
  const add = (finding: Omit<Finding, 'ruleVersion'>) => findings.push({ ...finding, ruleVersion: RULE_PACK_VERSION });
  const area = input.siteAreaM2;
  const housing = input.use === 'HOUSING';
  const fact = (key: SiteFactKey) => input.facts[key];

  // --- The site itself ---------------------------------------------------------
  if (area === null) {
    add({
      code: 'SITE_BOUNDARY', title: 'Site boundary', status: 'review_required', gate: 'G0', source: SOURCES.project,
      reason: 'No red line is recorded, so no area-based rule can be evaluated.', inputs: {}, evidenceNeeded: ['A red-line boundary'],
    });
  }
  if (input.areaReviewReasons.length > 0) {
    add({
      code: 'SITE_AREA_DIVERGENCE', title: 'Drawn and confirmed area', status: 'review_required', gate: 'G0', source: SOURCES.project,
      reason: input.areaReviewReasons.join(' '), inputs: { siteAreaM2: area, areaBasis: input.areaBasis }, evidenceNeeded: ['The confirmed legal red-line area, reconciled to the drawn boundary'],
    });
  }
  if (!input.authorityConfirmed) {
    add({
      code: 'AUTHORITY', title: 'Determining authority', status: 'review_required', gate: 'G0', source: SOURCES.project,
      reason: 'The local planning authority is not confirmed. First release supports a single determining authority; a cross-boundary site goes to manual review.',
      inputs: {}, evidenceNeeded: ['The authority, confirmed against the boundary'],
    });
  }
  if (!housing) {
    add({
      code: 'USE_SCOPE', title: 'Supported use', status: 'review_required', gate: 'G0', source: SOURCES.project,
      reason: `${input.use === 'MIXED' ? 'Mixed use' : 'A non-housing use'} is outside the first release's automated rules; every finding below needs a planner's review.`,
      inputs: { use: input.use }, evidenceNeeded: ['A planner’s classification of the proposal'],
    });
  }

  // --- Major development: each reason preserved independently -------------------
  const majorReasons: Array<{ code: string; status: FindingStatus; reason: string; inputs: Finding['inputs'] }> = [];
  {
    const n = input.dwellings;
    majorReasons.push(
      n === null
        ? { code: 'MAJOR_DWELLINGS', status: 'review_required', reason: 'The dwelling count is not known.', inputs: { dwellings: null } }
        : n >= THRESHOLDS.majorDwellings
          ? { code: 'MAJOR_DWELLINGS', status: 'applies', reason: `${n} dwellings is ${THRESHOLDS.majorDwellings} or more.`, inputs: { dwellings: n } }
          : { code: 'MAJOR_DWELLINGS', status: 'does_not_apply', reason: `${n} dwellings is fewer than ${THRESHOLDS.majorDwellings}.`, inputs: { dwellings: n } },
    );
    // The unknown-count branch is for a housing site whose number is not known; a known count never uses it.
    majorReasons.push(
      n !== null || !housing
        ? { code: 'MAJOR_UNKNOWN_COUNT_AREA', status: 'does_not_apply', reason: n !== null ? 'The dwelling count is known, so the unknown-count branch does not apply.' : 'Not a housing proposal.', inputs: { dwellings: n } }
        : area === null
          ? { code: 'MAJOR_UNKNOWN_COUNT_AREA', status: 'review_required', reason: 'The count is unknown and the site area is not recorded.', inputs: { dwellings: null, siteAreaM2: null } }
          : area >= THRESHOLDS.majorUnknownCountAreaM2
            ? { code: 'MAJOR_UNKNOWN_COUNT_AREA', status: 'applies', reason: `The count is unknown and the site is ${ha(area)}, 0.5 ha or more.`, inputs: { dwellings: null, siteAreaM2: area } }
            : { code: 'MAJOR_UNKNOWN_COUNT_AREA', status: 'does_not_apply', reason: `The site is ${ha(area)}, under 0.5 ha.`, inputs: { dwellings: null, siteAreaM2: area } },
    );
    majorReasons.push(
      area === null
        ? { code: 'MAJOR_SITE_AREA', status: 'review_required', reason: 'The site area is not recorded.', inputs: { siteAreaM2: null } }
        : area >= THRESHOLDS.majorSiteAreaM2
          ? { code: 'MAJOR_SITE_AREA', status: 'applies', reason: `The site is ${ha(area)}, 1 ha or more.`, inputs: { siteAreaM2: area } }
          : { code: 'MAJOR_SITE_AREA', status: 'does_not_apply', reason: `The site is ${ha(area)}, under 1 ha.`, inputs: { siteAreaM2: area } },
    );
    const gia = input.createdGiaM2;
    majorReasons.push(
      gia === null
        ? { code: 'MAJOR_FLOORSPACE', status: 'review_required', reason: 'The floorspace to be created is not known.', inputs: { createdGiaM2: null } }
        : gia >= THRESHOLDS.majorFloorspaceM2
          ? { code: 'MAJOR_FLOORSPACE', status: 'applies', reason: `${gia} m² created is 1,000 m² or more.`, inputs: { createdGiaM2: gia } }
          : { code: 'MAJOR_FLOORSPACE', status: 'does_not_apply', reason: `${gia} m² created is under 1,000 m².`, inputs: { createdGiaM2: gia } },
    );
  }
  const isMajor = majorReasons.some((entry) => entry.status === 'applies');
  const major: Evaluation['major'] = isMajor ? 'MAJOR' : majorReasons.every((entry) => entry.status === 'does_not_apply') ? 'NOT_MAJOR' : 'UNRESOLVED';
  for (const entry of majorReasons) {
    // An unknown that cannot change the outcome is reported, not sent for review.
    const status = entry.status === 'review_required' && isMajor ? 'unavailable' : entry.status;
    add({
      code: entry.code,
      title: 'Major development',
      status: housing ? status : 'review_required',
      reason: status === 'unavailable' ? `${entry.reason} It does not change the outcome: the proposal is major on another reason.` : entry.reason,
      inputs: entry.inputs,
      evidenceNeeded: status === 'review_required' ? ['The missing input, or a planner’s classification'] : [],
      gate: 'G0',
      source: SOURCES.dmpo,
    });
  }

  // --- Flood risk assessment -------------------------------------------------------
  {
    const zone = fact('FLOOD_ZONE');
    const inputs = { floodZone: zone ?? null, siteAreaM2: area };
    if (!zone) {
      add({ code: 'FRA', title: 'Flood risk assessment', status: 'review_required', gate: 'G1', source: SOURCES.fra, inputs,
        reason: 'The flood zone is not recorded. A blank map response is never read as Flood Zone 1.', evidenceNeeded: ['Flood Map for Planning result for the red line, with its date'] });
    } else if (zone !== '1') {
      add({ code: 'FRA', title: 'Flood risk assessment', status: 'applies', gate: 'G2', source: SOURCES.fra, inputs,
        reason: `The site is in Flood Zone ${zone}: a site-specific FRA is required, with the sequential and, where needed, exception tests.`, evidenceNeeded: ['Site-specific FRA', 'Sequential test', 'SuDS strategy'] });
    } else if (area !== null && area >= THRESHOLDS.fraFloodZone1AreaM2) {
      add({ code: 'FRA', title: 'Flood risk assessment', status: 'applies', gate: 'G2', source: SOURCES.fra, inputs,
        reason: `Flood Zone 1 and ${ha(area)}: 1 ha or more requires a site-specific FRA by area alone.`, evidenceNeeded: ['Site-specific FRA', 'SuDS strategy: exceedance, outfall rights, adoption and maintenance'] });
    } else {
      const clear = fact('CRITICAL_DRAINAGE_AREA') === 'NO' && ['NONE', 'LOW'].includes(fact('SURFACE_WATER_RISK') ?? '') && fact('FUTURE_FLOOD_RISK') === 'NO';
      const triggered = fact('CRITICAL_DRAINAGE_AREA') === 'YES' || ['MEDIUM', 'HIGH'].includes(fact('SURFACE_WATER_RISK') ?? '') || fact('FUTURE_FLOOD_RISK') === 'YES';
      add({
        code: 'FRA', title: 'Flood risk assessment', gate: 'G2', source: SOURCES.fra,
        inputs: { ...inputs, criticalDrainageArea: fact('CRITICAL_DRAINAGE_AREA') ?? null, surfaceWaterRisk: fact('SURFACE_WATER_RISK') ?? null, futureFloodRisk: fact('FUTURE_FLOOD_RISK') ?? null },
        status: triggered ? 'applies' : clear ? 'does_not_apply' : 'review_required',
        reason: triggered
          ? 'Flood Zone 1 under 1 ha, but another source of risk is recorded: a site-specific FRA is required.'
          : clear
            ? 'Flood Zone 1 under 1 ha, outside a critical drainage area, with low surface-water and no recorded future risk.'
            : 'Flood Zone 1 under 1 ha: check critical drainage area, surface water and future risk before ruling an FRA out.',
        evidenceNeeded: triggered ? ['Site-specific FRA'] : clear ? [] : ['Critical drainage area', 'Surface water risk', 'Future flood risk (SFRA)'],
      });
    }
  }

  // --- EIA screening -------------------------------------------------------------
  {
    const opinion = fact('EIA_SCREENING_OPINION');
    const n = input.dwellings;
    const inputs = { dwellings: n, siteAreaM2: area, sensitiveArea: fact('EIA_SENSITIVE_AREA') ?? null, cumulative: fact('EIA_CUMULATIVE') ?? null, screeningOpinion: opinion ?? null };
    const exceeded: string[] = [];
    if (n !== null && n > THRESHOLDS.eiaDwellingsOver) exceeded.push(`more than ${THRESHOLDS.eiaDwellingsOver} dwellings`);
    if (area !== null && area > THRESHOLDS.eiaSiteAreaOverM2) exceeded.push(`over 5 ha in total`);
    const unknownNumbers = (n === null && (area === null || area <= THRESHOLDS.eiaSiteAreaOverM2)) || area === null;
    if (opinion) {
      add({ code: 'EIA_SCREENING', title: 'Environmental impact assessment', gate: 'G1', source: SOURCES.eia, inputs,
        status: opinion === 'ES_REQUIRED' ? 'applies' : 'does_not_apply',
        reason: opinion === 'ES_REQUIRED' ? 'The formal screening opinion requires an Environmental Statement.' : 'The formal screening opinion is that an Environmental Statement is not required.',
        evidenceNeeded: opinion === 'ES_REQUIRED' ? ['Scoping opinion', 'Environmental Statement'] : [] });
    } else if (exceeded.length > 0) {
      add({ code: 'EIA_SCREENING', title: 'Environmental impact assessment', status: 'review_required', gate: 'G1', source: SOURCES.eia, inputs,
        reason: `Schedule 2 urban development threshold exceeded (${exceeded.join('; ')}): screening is required.`, evidenceNeeded: ['Formal screening opinion'] });
    } else {
      const checked = fact('EIA_SENSITIVE_AREA') === 'NO' && fact('EIA_CUMULATIVE') === 'NONE_FOUND' && !unknownNumbers;
      add({ code: 'EIA_SCREENING', title: 'Environmental impact assessment', gate: 'G1', source: SOURCES.eia, inputs,
        status: checked ? 'does_not_apply' : 'review_required',
        reason: checked
          ? 'Below the numerical urban-development thresholds, outside a sensitive area, with no cumulative or linked development found.'
          : unknownNumbers
            ? 'The dwelling count or site area is not known, so the thresholds cannot be tested.'
            : fact('EIA_SENSITIVE_AREA') === 'YES'
              ? 'In or near a sensitive area: Schedule 2 screening applies whatever the size.'
              : 'Below the numerical thresholds; screening review stays open until the sensitive-area and cumulative-development checks are complete.',
        evidenceNeeded: checked ? [] : ['Sensitive-area check', 'Cumulative and linked development check'] });
    }
  }

  // --- Habitats and protected species: independent of EIA ---------------------------
  {
    const hra = fact('HRA_SCREENING');
    add({ code: 'HRA', title: 'Habitats Regulations assessment', gate: 'G1', source: SOURCES.hra, inputs: { hraScreening: hra ?? null },
      status: !hra ? 'review_required' : hra === 'APPROPRIATE_ASSESSMENT' ? 'applies' : 'does_not_apply',
      reason: !hra ? 'Not screened. Kept independent of EIA screening.' : hra === 'APPROPRIATE_ASSESSMENT' ? 'Likely significant effect: appropriate assessment is required.' : 'Screened: no likely significant effect on a habitats site.',
      evidenceNeeded: !hra ? ['HRA screening'] : hra === 'APPROPRIATE_ASSESSMENT' ? ['Information to inform appropriate assessment'] : [] });
    const species = fact('PROTECTED_SPECIES');
    add({ code: 'PROTECTED_SPECIES', title: 'Protected species', gate: 'G1', source: SOURCES.bng, inputs: { protectedSpecies: species ?? null },
      status: !species ? 'review_required' : species === 'PRESENT' ? 'applies' : 'does_not_apply',
      reason: !species ? 'No survey recorded. Survey windows are seasonal; schedule early.' : species === 'PRESENT' ? 'Protected species present: mitigation and, where needed, a licence.' : 'Surveyed: none found.',
      evidenceNeeded: !species ? ['Preliminary ecological appraisal and any follow-up surveys'] : species === 'PRESENT' ? ['Mitigation strategy', 'Licence where required'] : [] });
  }

  // --- Biodiversity net gain ----------------------------------------------------------
  {
    const bng = fact('BNG_APPLICABILITY');
    add({ code: 'BNG', title: 'Biodiversity net gain', gate: 'G2', source: SOURCES.bng, inputs: { applicability: bng ?? null },
      status: !bng ? 'review_required' : bng === 'APPLIES' ? 'applies' : 'does_not_apply',
      reason: !bng
        ? 'New housing defaults to an applicability review; an exemption is claimed with evidence and a reviewer.'
        : bng === 'APPLIES'
          ? `The statutory objective is generally at least ${THRESHOLDS.bngObjectivePercent}%, with a Biodiversity Gain Plan approved before commencement.`
          : 'An exemption is recorded with its source.',
      evidenceNeeded: !bng
        ? ['Applicability review, or a claimed exemption with evidence']
        : bng === 'APPLIES'
          ? ['Baseline (date, metric version, plans, irreplaceable habitats)', 'Qualified ecologist sign-off', 'Biodiversity Gain Plan before commencement']
          : [] });
  }

  // --- Validation -----------------------------------------------------------------------
  {
    const list = fact('LOCAL_VALIDATION_LIST');
    add({ code: 'LOCAL_VALIDATION', title: 'Local validation requirements', gate: 'G2', source: { ...SOURCES.application, kind: 'LOCAL' }, inputs: { localList: list ?? null },
      status: list === 'VERIFIED_CURRENT' ? 'applies' : 'review_required',
      reason: list === 'VERIFIED_CURRENT'
        ? 'The authority’s current local list is verified; its items join the national requirements.'
        : list === 'UNAVAILABLE_OR_DISPUTED'
          ? 'The local list is unavailable or disputed: the planning lead reviews it with authority correspondence.'
          : 'The local validation list has not been verified, so validation policy is unresolved.',
      evidenceNeeded: list === 'VERIFIED_CURRENT' ? ['Each local item, against current local evidence'] : ['The current local list, or authority correspondence'] });
  }

  // --- CIL ------------------------------------------------------------------------------
  {
    const schedule = fact('CIL_CHARGING_SCHEDULE');
    add({ code: 'CIL', title: 'Community Infrastructure Levy', gate: 'G1', source: SOURCES.cil, inputs: { chargingSchedule: schedule ?? null },
      status: !schedule ? 'unavailable' : schedule === 'IN_FORCE' ? 'review_required' : 'does_not_apply',
      reason: !schedule
        ? 'No charging schedule evidence: the liability is unknown and stays unknown in the forecast.'
        : schedule === 'IN_FORCE'
          ? 'A charging schedule is in force: resolve the zone, use, index year and net chargeable area. Floorspace credit, relief and phasing go to a specialist.'
          : 'No charging schedule is adopted, recorded with its own source.',
      evidenceNeeded: !schedule ? ['The charging schedule, or a sourced confirmation that none is adopted'] : schedule === 'IN_FORCE' ? ['Charging schedule and zone', 'Net chargeable GIA'] : [] });
  }

  // --- Determination period ----------------------------------------------------------------
  {
    const eia = findings.find((finding) => finding.code === 'EIA_SCREENING')!;
    const weeks =
      eia.status === 'applies' ? THRESHOLDS.determinationWeeks.eia : major === 'MAJOR' ? THRESHOLDS.determinationWeeks.major : major === 'NOT_MAJOR' ? THRESHOLDS.determinationWeeks.other : null;
    add({ code: 'DETERMINATION_PERIOD', title: 'Statutory determination period', gate: 'G2', source: SOURCES.determination,
      inputs: { major, environmentalStatement: eia.status === 'applies' },
      status: weeks === null ? 'review_required' : 'applies',
      reason: weeks === null
        ? 'Whether the proposal is major is not resolved, so the statutory period is not known.'
        : `${weeks} weeks from the validated date the authority records${eia.status === 'applies' ? ' (EIA development)' : major === 'MAJOR' ? ' (major development)' : ''}.`,
      evidenceNeeded: [] });
  }

  return { ruleVersion: RULE_PACK_VERSION, major, findings };
}
