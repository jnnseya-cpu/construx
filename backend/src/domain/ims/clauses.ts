/**
 * The clause structure of the three standards an integrated management system
 * is certified against: ISO 9001:2015 (quality), ISO 14001:2015 (environment)
 * and ISO 45001:2018 (occupational health and safety).
 *
 * Only the clause numbers and their headings are held — the structure a
 * procedure, an audit finding or a management review input is mapped to. The
 * requirement text of each clause is the standard itself, which the company
 * holds under its own licence; nothing here restates it.
 *
 * The three share the harmonised structure (clauses 4 to 10), so a clause such
 * as 7.5 "Documented information" exists in all three and one procedure can
 * meet it for all three at once.
 */

export const STANDARDS = {
  ISO9001: { label: 'ISO 9001:2015', topic: 'Quality' },
  ISO14001: { label: 'ISO 14001:2015', topic: 'Environment' },
  ISO45001: { label: 'ISO 45001:2018', topic: 'Occupational health and safety' },
} as const;

export type Standard = keyof typeof STANDARDS;
export const STANDARD_IDS = Object.keys(STANDARDS) as Standard[];
export const isStandard = (value: unknown): value is Standard => typeof value === 'string' && value in STANDARDS;

export type Clause = { id: string; standard: Standard; clause: string; title: string };

/** The headings shared by all three standards. A standard's own heading overrides where it differs. */
const SHARED: Array<[string, string]> = [
  ['4.1', 'Understanding the organization and its context'],
  ['4.2', 'Understanding the needs and expectations of interested parties'],
  ['4.3', 'Determining the scope of the management system'],
  ['4.4', 'The management system'],
  ['5.1', 'Leadership and commitment'],
  ['5.2', 'Policy'],
  ['5.3', 'Organizational roles, responsibilities and authorities'],
  ['6.1', 'Actions to address risks and opportunities'],
  ['6.2', 'Objectives and planning to achieve them'],
  ['7.1', 'Resources'],
  ['7.2', 'Competence'],
  ['7.3', 'Awareness'],
  ['7.4', 'Communication'],
  ['7.5', 'Documented information'],
  ['8.1', 'Operational planning and control'],
  ['9.1', 'Monitoring, measurement, analysis and evaluation'],
  ['9.2', 'Internal audit'],
  ['9.3', 'Management review'],
  ['10.1', 'Improvement: general'],
  ['10.2', 'Nonconformity and corrective action'],
  ['10.3', 'Continual improvement'],
];

/** Each standard's own clauses and headings, beyond and over the shared ones. */
const OWN: Record<Standard, Array<[string, string]>> = {
  ISO9001: [
    ['5.2', 'Quality policy'],
    ['6.2', 'Quality objectives and planning to achieve them'],
    ['6.3', 'Planning of changes'],
    ['7.1.5', 'Monitoring and measuring resources'],
    ['7.1.6', 'Organizational knowledge'],
    ['8.2', 'Requirements for products and services'],
    ['8.3', 'Design and development of products and services'],
    ['8.4', 'Control of externally provided processes, products and services'],
    ['8.5', 'Production and service provision'],
    ['8.6', 'Release of products and services'],
    ['8.7', 'Control of nonconforming outputs'],
    ['9.1.2', 'Customer satisfaction'],
    ['9.1.3', 'Analysis and evaluation'],
  ],
  ISO14001: [
    ['5.2', 'Environmental policy'],
    ['6.1.2', 'Environmental aspects'],
    ['6.1.3', 'Compliance obligations'],
    ['6.1.4', 'Planning action'],
    ['6.2', 'Environmental objectives and planning to achieve them'],
    ['8.2', 'Emergency preparedness and response'],
    ['9.1.2', 'Evaluation of compliance'],
  ],
  ISO45001: [
    ['4.2', 'Understanding the needs and expectations of workers and other interested parties'],
    ['5.2', 'OH&S policy'],
    ['5.4', 'Consultation and participation of workers'],
    ['6.1.2', 'Hazard identification and assessment of risks and opportunities'],
    ['6.1.3', 'Determination of legal requirements and other requirements'],
    ['6.1.4', 'Planning action'],
    ['6.2', 'OH&S objectives and planning to achieve them'],
    ['8.1.2', 'Eliminating hazards and reducing OH&S risks'],
    ['8.1.3', 'Management of change'],
    ['8.1.4', 'Procurement, including contractors and outsourcing'],
    ['8.2', 'Emergency preparedness and response'],
    ['9.1.2', 'Evaluation of compliance'],
    ['10.2', 'Incident, nonconformity and corrective action'],
  ],
};

const order = (clause: string) => clause.split('.').map((part) => part.padStart(3, '0')).join('.');

export const CLAUSES: Clause[] = STANDARD_IDS.flatMap((standard) => {
  const merged = new Map<string, string>(SHARED);
  for (const [clause, title] of OWN[standard]) merged.set(clause, title);
  return [...merged.entries()]
    .sort((a, b) => order(a[0]).localeCompare(order(b[0])))
    .map(([clause, title]) => ({ id: `${standard}:${clause}`, standard, clause, title }));
});

const BY_ID = new Map(CLAUSES.map((clause) => [clause.id, clause]));

export const clauseById = (id: string): Clause | undefined => BY_ID.get(id);
export const isClauseId = (value: unknown): value is string => typeof value === 'string' && BY_ID.has(value);
export const clauseLabel = (id: string): string => {
  const clause = BY_ID.get(id);
  return clause ? `${STANDARDS[clause.standard].label} ${clause.clause} ${clause.title}` : id;
};

/** The clause a record of this kind is evidence against, in every standard it applies to. */
export const clausesFor = (clause: string, standards: readonly Standard[] = STANDARD_IDS): string[] =>
  standards.map((standard) => `${standard}:${clause}`).filter((id) => BY_ID.has(id));
