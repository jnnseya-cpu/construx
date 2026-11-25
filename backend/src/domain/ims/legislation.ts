import type { Standard } from './clauses.ts';

/**
 * A starting list of UK legislation a construction company commonly holds in
 * its register of legal and other requirements (ISO 14001 6.1.3, ISO 45001
 * 6.1.3).
 *
 * Titles, years and extent only — the instrument's own text is the law, and the
 * register says how each applies to this company and how it complies, in the
 * company's own words. The list is a **starting point**, not a determination: a
 * company adds whatever else applies to it, and the planning agent may propose
 * entries **only from this list**, so it cannot invent an Act.
 *
 * Extent is the jurisdiction the instrument applies in as titled. Scotland and
 * Northern Ireland have their own instruments for several of these, and the
 * main ones are listed beside the GB and England-and-Wales ones, so a company
 * working there chooses the instrument that actually binds it.
 */

export type LegislationEntry = { key: string; title: string; extent: string; standards: Standard[]; topic: string };

export const LEGISLATION: LegislationEntry[] = [
  // Occupational health and safety
  { key: 'HSWA_1974', title: 'Health and Safety at Work etc. Act 1974', extent: 'Great Britain', standards: ['ISO45001'], topic: 'General duties of employers to employees and others' },
  { key: 'MHSWR_1999', title: 'Management of Health and Safety at Work Regulations 1999', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Risk assessment, competent advice, health surveillance' },
  { key: 'CDM_2015', title: 'Construction (Design and Management) Regulations 2015', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Duty holders, construction phase plan, welfare on site' },
  { key: 'RIDDOR_2013', title: 'Reporting of Injuries, Diseases and Dangerous Occurrences Regulations 2013', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Reporting injuries, diseases and dangerous occurrences to the enforcing authority' },
  { key: 'COSHH_2002', title: 'Control of Substances Hazardous to Health Regulations 2002', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Hazardous substances, dusts including silica' },
  { key: 'CAR_2012', title: 'Control of Asbestos Regulations 2012', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Asbestos surveys, licensed and notifiable work' },
  { key: 'WAH_2005', title: 'Work at Height Regulations 2005', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Planning and equipment for work at height' },
  { key: 'LOLER_1998', title: 'Lifting Operations and Lifting Equipment Regulations 1998', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Lifting plans and thorough examination' },
  { key: 'PUWER_1998', title: 'Provision and Use of Work Equipment Regulations 1998', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Suitable, maintained and inspected work equipment' },
  { key: 'NOISE_2005', title: 'Control of Noise at Work Regulations 2005', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Noise exposure of workers' },
  { key: 'VIBRATION_2005', title: 'Control of Vibration at Work Regulations 2005', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Hand-arm and whole-body vibration' },
  { key: 'MHOR_1992', title: 'Manual Handling Operations Regulations 1992', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Manual handling assessment' },
  { key: 'PPE_1992', title: 'Personal Protective Equipment at Work Regulations 1992', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Provision of personal protective equipment' },
  { key: 'FIRSTAID_1981', title: 'Health and Safety (First-Aid) Regulations 1981', extent: 'Great Britain', standards: ['ISO45001'], topic: 'First-aid provision' },
  { key: 'WORKPLACE_1992', title: 'Workplace (Health, Safety and Welfare) Regulations 1992', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Workplace welfare and conditions' },
  { key: 'CONFINED_1997', title: 'Confined Spaces Regulations 1997', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Work in confined spaces' },
  { key: 'DSEAR_2002', title: 'Dangerous Substances and Explosive Atmospheres Regulations 2002', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Fire and explosion risks from dangerous substances' },
  { key: 'EAW_1989', title: 'Electricity at Work Regulations 1989', extent: 'Great Britain', standards: ['ISO45001'], topic: 'Electrical systems and work on or near them' },
  { key: 'FIRE_ORDER_2005', title: 'Regulatory Reform (Fire Safety) Order 2005', extent: 'England and Wales', standards: ['ISO45001'], topic: 'Fire risk assessment of premises' },
  { key: 'BSA_2022', title: 'Building Safety Act 2022', extent: 'England and Wales', standards: ['ISO45001', 'ISO9001'], topic: 'Building safety regime, duty holders and competence' },
  // Environment
  { key: 'EPA_1990', title: 'Environmental Protection Act 1990', extent: 'Great Britain', standards: ['ISO14001'], topic: 'Waste duty of care (s.34) and statutory nuisance' },
  { key: 'EPR_2016', title: 'Environmental Permitting (England and Wales) Regulations 2016', extent: 'England and Wales', standards: ['ISO14001'], topic: 'Permits and exemptions for waste and water discharge activities' },
  { key: 'HWR_2005', title: 'Hazardous Waste (England and Wales) Regulations 2005', extent: 'England', standards: ['ISO14001'], topic: 'Classifying, moving and recording hazardous waste' },
  { key: 'WASTE_2011', title: 'Waste (England and Wales) Regulations 2011', extent: 'England and Wales', standards: ['ISO14001'], topic: 'Waste hierarchy and transfer notes' },
  { key: 'COPA_1974', title: 'Control of Pollution Act 1974', extent: 'Great Britain', standards: ['ISO14001'], topic: 'Construction site noise (sections 60 and 61)' },
  { key: 'WRA_1991', title: 'Water Resources Act 1991', extent: 'England and Wales', standards: ['ISO14001'], topic: 'Pollution of controlled waters' },
  { key: 'WCA_1981', title: 'Wildlife and Countryside Act 1981', extent: 'Great Britain', standards: ['ISO14001'], topic: 'Protected species and nesting birds' },
  { key: 'HABITATS_2017', title: 'Conservation of Habitats and Species Regulations 2017', extent: 'England and Wales', standards: ['ISO14001'], topic: 'European protected species and sites' },
  { key: 'CAA_1993', title: 'Clean Air Act 1993', extent: 'Great Britain', standards: ['ISO14001'], topic: 'Dark smoke and burning on site' },
  { key: 'ENV_ACT_2021', title: 'Environment Act 2021', extent: 'England', standards: ['ISO14001'], topic: 'Biodiversity net gain and environmental targets' },
  // Scotland: where its own instruments replace the England-and-Wales ones above.
  { key: 'SC_EASR_2018', title: 'Environmental Authorisations (Scotland) Regulations 2018', extent: 'Scotland', standards: ['ISO14001'], topic: 'Authorisations for waste and discharge activities' },
  { key: 'SC_CAR_2011', title: 'Water Environment (Controlled Activities) (Scotland) Regulations 2011', extent: 'Scotland', standards: ['ISO14001'], topic: 'Discharges, abstraction and engineering in the water environment' },
  { key: 'SC_SPECIAL_WASTE_1996', title: 'Special Waste Regulations 1996', extent: 'Scotland', standards: ['ISO14001'], topic: 'Consigning special (hazardous) waste in Scotland' },
  { key: 'SC_WML_2011', title: 'Waste Management Licensing (Scotland) Regulations 2011', extent: 'Scotland', standards: ['ISO14001'], topic: 'Waste management licences and exemptions' },
  { key: 'SC_WASTE_2012', title: 'Waste (Scotland) Regulations 2012', extent: 'Scotland', standards: ['ISO14001'], topic: 'Separate collection of recyclable waste' },
  { key: 'SC_NATURE_2004', title: 'Nature Conservation (Scotland) Act 2004', extent: 'Scotland', standards: ['ISO14001'], topic: 'Protected sites and species in Scotland' },
  { key: 'SC_HABITATS_1994', title: 'Conservation (Natural Habitats, &c.) Regulations 1994', extent: 'Scotland', standards: ['ISO14001'], topic: 'European protected species and sites in Scotland' },
  { key: 'SC_FIRE_2005', title: 'Fire (Scotland) Act 2005', extent: 'Scotland', standards: ['ISO45001'], topic: 'Fire safety duties in relevant premises' },
  { key: 'SC_FIRE_REGS_2006', title: 'Fire Safety (Scotland) Regulations 2006', extent: 'Scotland', standards: ['ISO45001'], topic: 'Fire safety risk assessment' },
  { key: 'SC_BUILDING_2003', title: 'Building (Scotland) Act 2003', extent: 'Scotland', standards: ['ISO9001', 'ISO45001'], topic: 'Building warrants and completion certificates' },
  // Northern Ireland: its own health and safety and environmental instruments.
  { key: 'NI_HSW_1978', title: 'Health and Safety at Work (Northern Ireland) Order 1978', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'General duties of employers to employees and others' },
  { key: 'NI_MHSWR_2000', title: 'Management of Health and Safety at Work Regulations (Northern Ireland) 2000', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'Risk assessment and competent advice' },
  { key: 'NI_CDM_2016', title: 'Construction (Design and Management) Regulations (Northern Ireland) 2016', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'Duty holders, construction phase plan, welfare on site' },
  { key: 'NI_RIDDOR_1997', title: 'Reporting of Injuries, Diseases and Dangerous Occurrences Regulations (Northern Ireland) 1997', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'Reporting injuries, diseases and dangerous occurrences to HSENI' },
  { key: 'NI_COSHH_2003', title: 'Control of Substances Hazardous to Health Regulations (Northern Ireland) 2003', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'Hazardous substances and dusts' },
  { key: 'NI_CAR_2012', title: 'Control of Asbestos Regulations (Northern Ireland) 2012', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'Asbestos surveys and licensed work' },
  { key: 'NI_WAH_2005', title: 'Work at Height Regulations (Northern Ireland) 2005', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'Planning and equipment for work at height' },
  { key: 'NI_FIRE_2010', title: 'Fire Safety Regulations (Northern Ireland) 2010', extent: 'Northern Ireland', standards: ['ISO45001'], topic: 'Fire safety risk assessment of premises' },
  { key: 'NI_WASTE_1997', title: 'Waste and Contaminated Land (Northern Ireland) Order 1997', extent: 'Northern Ireland', standards: ['ISO14001'], topic: 'Waste duty of care and licensing' },
  { key: 'NI_HWR_2005', title: 'Hazardous Waste Regulations (Northern Ireland) 2005', extent: 'Northern Ireland', standards: ['ISO14001'], topic: 'Classifying, moving and recording hazardous waste' },
  { key: 'NI_WATER_1999', title: 'Water (Northern Ireland) Order 1999', extent: 'Northern Ireland', standards: ['ISO14001'], topic: 'Pollution of waterways and discharge consents' },
  { key: 'NI_WILDLIFE_1985', title: 'Wildlife (Northern Ireland) Order 1985', extent: 'Northern Ireland', standards: ['ISO14001'], topic: 'Protected species and nesting birds' },
];

export const REGIONS = ['ENGLAND', 'WALES', 'SCOTLAND', 'NORTHERN_IRELAND'] as const;
export type Region = (typeof REGIONS)[number];

/** The parts of the UK an instrument's extent covers. */
export function regionsOf(extent: string): Region[] {
  switch (extent) {
    case 'United Kingdom':
      return [...REGIONS];
    case 'Great Britain':
      return ['ENGLAND', 'WALES', 'SCOTLAND'];
    case 'England and Wales':
      return ['ENGLAND', 'WALES'];
    case 'England':
      return ['ENGLAND'];
    case 'Wales':
      return ['WALES'];
    case 'Scotland':
      return ['SCOTLAND'];
    case 'Northern Ireland':
      return ['NORTHERN_IRELAND'];
    default:
      return [];
  }
}

const BY_KEY = new Map(LEGISLATION.map((entry) => [entry.key, entry]));
export const legislationByKey = (key: string): LegislationEntry | undefined => BY_KEY.get(key);
