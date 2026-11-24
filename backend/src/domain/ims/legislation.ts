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
 * Extent is the jurisdiction the instrument applies in as titled; Scotland and
 * Northern Ireland have their own instruments for several of these.
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
];

const BY_KEY = new Map(LEGISLATION.map((entry) => [entry.key, entry]));
export const legislationByKey = (key: string): LegislationEntry | undefined => BY_KEY.get(key);
