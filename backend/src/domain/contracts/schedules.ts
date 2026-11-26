/**
 * The particulars a contract draft collects, form by form.
 *
 * A schedule is the platform's own list of the facts a form needs completing —
 * parties, dates, money, insurance, obligations and the documents it binds —
 * under **original labels**. It is not the publisher's contract particulars,
 * contract data or particular conditions, and reproduces none of their wording.
 *
 * Three forms have their own schedule, the three the Contracts Studio handoff
 * names as the first adapters: JCT Design and Build 2024, the NEC4 Engineering
 * and Construction Contract (January 2023 revision) and FIDIC Plant and
 * Design-Build (2017, 2022 reprint). Every other draftable form is completed
 * against the **general schedule**, and says so: a general schedule is a record
 * of the agreed particulars, not a completed form.
 *
 * Each schedule is pinned to the exact edition it was written for. Reusing NEC4
 * ECC's main options on another NEC form, or a 2017-original FIDIC on the 2022
 * reprint's schedule, is refused rather than assumed to be close enough.
 */

export type FieldType = 'TEXT' | 'REFERENCE' | 'MONEY' | 'DATE' | 'PERCENT' | 'DURATION' | 'CHOICE';
export type FieldGroup = 'PARTIES' | 'PROJECT' | 'DATES' | 'COMMERCIAL' | 'INSURANCE' | 'OBLIGATIONS' | 'ATTACHMENTS';

export const FIELD_GROUPS: readonly FieldGroup[] = ['PARTIES', 'PROJECT', 'DATES', 'COMMERCIAL', 'INSURANCE', 'OBLIGATIONS', 'ATTACHMENTS'];

export type FieldDef = {
  key: string;
  label: string;
  group: FieldGroup;
  type: FieldType;
  /** Must be completed before the draft can be approved. */
  required: boolean;
  /** A term that moves money or time: a value for it is never taken on trust. */
  highRisk?: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
  help?: string;
};

export type Schedule = {
  id: string;
  /** The catalogue entry it is written for, exactly; `null` for the general schedule. */
  formKey: string | null;
  title: string;
  fields: readonly FieldDef[];
};

const f = (key: string, label: string, group: FieldGroup, type: FieldType, required: boolean, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, group, type, required, ...extra });
const choice = (...pairs: Array<[string, string]>) => pairs.map(([value, label]) => ({ value, label }));

const YES_NO = choice(['YES', 'Yes'], ['NO', 'No']);
const PER = choice(['DAY', 'per day'], ['WEEK', 'per week']);
const LAW = choice(['ENGLAND_AND_WALES', 'England and Wales'], ['SCOTLAND', 'Scotland'], ['NORTHERN_IRELAND', 'Northern Ireland'], ['OTHER', 'Another jurisdiction (state it in the notes)']);

const GENERAL: Schedule = {
  id: 'general-v1',
  formKey: null,
  title: 'General contract particulars',
  fields: [
    f('employer_legal_name', 'Employer / client — registered legal name', 'PARTIES', 'TEXT', true, { help: 'As registered, not a trading or display name.' }),
    f('employer_address', 'Employer / client — address for notices', 'PARTIES', 'TEXT', true),
    f('contractor_legal_name', 'Contractor / supplier — registered legal name', 'PARTIES', 'TEXT', true),
    f('contractor_address', 'Contractor / supplier — address for notices', 'PARTIES', 'TEXT', true),
    f('contract_administrator', 'Contract administrator, agent or project manager', 'PARTIES', 'TEXT', false),
    f('works_description', 'The works or services', 'PROJECT', 'TEXT', true),
    f('site_address', 'Site', 'PROJECT', 'TEXT', true),
    f('start_date', 'Start / possession date', 'DATES', 'DATE', true, { highRisk: true }),
    f('completion_date', 'Completion date', 'DATES', 'DATE', true, { highRisk: true }),
    f('contract_sum', 'Contract sum / price', 'COMMERCIAL', 'MONEY', true, { highRisk: true }),
    f('retention_percent', 'Retention', 'COMMERCIAL', 'PERCENT', false),
    f('delay_damages', 'Delay / liquidated damages', 'COMMERCIAL', 'MONEY', false, { highRisk: true }),
    f('delay_damages_per', 'Delay damages are charged', 'COMMERCIAL', 'CHOICE', false, { options: PER }),
    f('delay_damages_cap_percent', 'Cap on delay damages — percentage of the contract sum', 'COMMERCIAL', 'PERCENT', false, { help: 'Leave blank where the damages are uncapped.' }),
    f('defects_period', 'Defects / rectification period', 'COMMERCIAL', 'DURATION', false),
    f('payment_terms', 'Payment intervals and terms', 'OBLIGATIONS', 'TEXT', true, { help: 'Statutory payment and adjudication rights apply to construction operations whatever is written here.' }),
    f('insurance_requirements', 'Insurance required', 'INSURANCE', 'TEXT', false),
    f('governing_law', 'Governing law', 'OBLIGATIONS', 'CHOICE', true, { options: LAW, help: 'The law of the contract — not necessarily where the work is.' }),
    f('dispute_nominating_body', 'Adjudicator nominating body', 'OBLIGATIONS', 'TEXT', false),
    f('requirements_reference', 'Requirements / specification — document and revision', 'ATTACHMENTS', 'REFERENCE', true),
    f('pricing_document_reference', 'Pricing document — document and revision', 'ATTACHMENTS', 'REFERENCE', false, { highRisk: true }),
  ],
};

const JCT_DB_2024: Schedule = {
  id: 'jct-db-2024-v1',
  formKey: 'jct:2024:db',
  title: 'JCT Design and Build 2024 — contract particulars schedule',
  fields: [
    f('employer_legal_name', 'Employer — registered legal name', 'PARTIES', 'TEXT', true),
    f('employer_address', 'Employer — address for notices', 'PARTIES', 'TEXT', true),
    f('contractor_legal_name', 'Contractor — registered legal name', 'PARTIES', 'TEXT', true),
    f('contractor_address', 'Contractor — address for notices', 'PARTIES', 'TEXT', true),
    f('employers_agent', 'Employer’s Agent', 'PARTIES', 'TEXT', true),
    f('works_description', 'The works', 'PROJECT', 'TEXT', true),
    f('site_address', 'Site', 'PROJECT', 'TEXT', true),
    f('possession_date', 'Date of possession', 'DATES', 'DATE', true, { highRisk: true }),
    f('completion_date', 'Date for completion', 'DATES', 'DATE', true, { highRisk: true }),
    f('sectional_completion', 'Completed in sections', 'DATES', 'CHOICE', true, { options: YES_NO }),
    f('section_dates', 'Sections — description, possession and completion date of each', 'DATES', 'TEXT', false, { highRisk: true }),
    f('contract_sum', 'Contract sum', 'COMMERCIAL', 'MONEY', true, { highRisk: true }),
    f('retention_percent', 'Retention percentage', 'COMMERCIAL', 'PERCENT', true),
    f('liquidated_damages', 'Liquidated damages', 'COMMERCIAL', 'MONEY', true, { highRisk: true }),
    f('liquidated_damages_per', 'Liquidated damages are charged', 'COMMERCIAL', 'CHOICE', true, { options: PER }),
    f('delay_damages_cap_percent', 'Cap on delay damages — percentage of the contract sum', 'COMMERCIAL', 'PERCENT', false, { help: 'Leave blank where the damages are uncapped.' }),
    f('fluctuations', 'Fluctuations provision', 'COMMERCIAL', 'CHOICE', true, { options: choice(['A', 'Option A — contribution, levy and tax fluctuations'], ['B', 'Option B — labour and materials cost and tax fluctuations'], ['C', 'Option C — formula adjustment']) }),
    f('rectification_period', 'Rectification period', 'COMMERCIAL', 'DURATION', true),
    f('payment_interval', 'Interval between interim payments', 'OBLIGATIONS', 'DURATION', true),
    f('works_insurance_option', 'Insurance of the works', 'INSURANCE', 'CHOICE', true, { options: choice(['A', 'Option A — new buildings, by the contractor'], ['B', 'Option B — new buildings, by the employer'], ['C', 'Option C — existing structures, by the employer']) }),
    f('contractors_liability_cover', 'Contractor’s liability insurance — level of cover', 'INSURANCE', 'MONEY', true),
    f('professional_indemnity_cover', 'Professional indemnity insurance — level of cover', 'INSURANCE', 'MONEY', true),
    f('warranties', 'Collateral warranties and third-party rights required', 'OBLIGATIONS', 'TEXT', false),
    f('dispute_nominating_body', 'Adjudicator nominating body', 'OBLIGATIONS', 'TEXT', true),
    f('employers_requirements_reference', 'Employer’s Requirements — document and revision', 'ATTACHMENTS', 'REFERENCE', true, { highRisk: true }),
    f('contractors_proposals_reference', 'Contractor’s Proposals — document and revision', 'ATTACHMENTS', 'REFERENCE', true),
    f('contract_sum_analysis_reference', 'Contract Sum Analysis — document and revision', 'ATTACHMENTS', 'REFERENCE', true, { highRisk: true }),
  ],
};

export const NEC_MAIN_OPTIONS = choice(
  ['A', 'Option A — priced contract with activity schedule'],
  ['B', 'Option B — priced contract with bill of quantities'],
  ['C', 'Option C — target contract with activity schedule'],
  ['D', 'Option D — target contract with bill of quantities'],
  ['E', 'Option E — cost reimbursable contract'],
  ['F', 'Option F — management contract'],
);

const NEC4_ECC: Schedule = {
  id: 'nec4-ecc-2023-v1',
  formKey: 'nec:nec4-jan-2023-revision:ecc',
  title: 'NEC4 ECC (January 2023 revision) — contract data schedule',
  fields: [
    f('client_legal_name', 'Client — registered legal name', 'PARTIES', 'TEXT', true),
    f('client_address', 'Client — address for communications', 'PARTIES', 'TEXT', true),
    f('contractor_legal_name', 'Contractor — registered legal name', 'PARTIES', 'TEXT', true),
    f('contractor_address', 'Contractor — address for communications', 'PARTIES', 'TEXT', true),
    f('project_manager', 'Project Manager', 'PARTIES', 'TEXT', true),
    f('supervisor', 'Supervisor', 'PARTIES', 'TEXT', true),
    f('works_description', 'The works', 'PROJECT', 'TEXT', true),
    f('site_address', 'Site', 'PROJECT', 'TEXT', true),
    f('starting_date', 'Starting date', 'DATES', 'DATE', true, { highRisk: true }),
    f('access_date', 'Access date(s)', 'DATES', 'TEXT', true),
    f('completion_date', 'Completion date', 'DATES', 'DATE', true, { highRisk: true }),
    f('key_dates', 'Key dates and the conditions to be met by each', 'DATES', 'TEXT', false),
    f('main_option', 'Main option', 'COMMERCIAL', 'CHOICE', true, { highRisk: true, options: NEC_MAIN_OPTIONS }),
    f('secondary_options', 'Secondary options chosen (X, W and Y)', 'COMMERCIAL', 'TEXT', true, { help: 'For example: X2, X7, X18, W2, Y(UK)2. W2 is the dispute option used where the Construction Act applies.' }),
    f('pricing_document_kind', 'Pricing document', 'COMMERCIAL', 'CHOICE', true, { highRisk: true, options: choice(['ACTIVITY_SCHEDULE', 'Activity schedule'], ['BILL_OF_QUANTITIES', 'Bill of quantities'], ['NONE', 'None (options E and F)']) }),
    f('pricing_document_reference', 'Pricing document — document and revision', 'ATTACHMENTS', 'REFERENCE', false, { highRisk: true }),
    f('fee_percentage', 'Fee percentage', 'COMMERCIAL', 'PERCENT', false, { help: 'Needed for options C to F.' }),
    f('delay_damages', 'Delay damages (option X7)', 'COMMERCIAL', 'MONEY', false, { highRisk: true }),
    f('delay_damages_per', 'Delay damages are charged', 'COMMERCIAL', 'CHOICE', false, { options: PER }),
    f('delay_damages_cap_percent', 'Cap on delay damages — percentage of the contract sum', 'COMMERCIAL', 'PERCENT', false, { help: 'Leave blank where the damages are uncapped.' }),
    f('defects_date', 'Defects date — period after completion', 'COMMERCIAL', 'DURATION', true),
    f('assessment_interval', 'Assessment interval', 'OBLIGATIONS', 'DURATION', true),
    f('insurance_table_reference', 'Insurance table and any additional insurances — document and revision', 'INSURANCE', 'REFERENCE', true),
    f('dispute_nominating_body', 'Adjudicator nominating body', 'OBLIGATIONS', 'TEXT', true),
    f('z_clauses_reference', 'Additional conditions (Z clauses) — document and revision', 'OBLIGATIONS', 'REFERENCE', false, { help: 'Every Z clause is a change to the standard form and goes to legal review.' }),
    f('scope_reference', 'Scope — document and revision', 'ATTACHMENTS', 'REFERENCE', true, { highRisk: true }),
    f('site_information_reference', 'Site Information — document and revision', 'ATTACHMENTS', 'REFERENCE', true),
  ],
};

const FIDIC_YELLOW_2017_R2022: Schedule = {
  id: 'fidic-yellow-2017r2022-v1',
  formKey: 'fidic:2017-2022-reprint:yellow',
  title: 'FIDIC Plant and Design-Build (2017, 2022 reprint) — contract data schedule',
  fields: [
    f('employer_legal_name', 'Employer — registered legal name', 'PARTIES', 'TEXT', true),
    f('employer_address', 'Employer — address for notices', 'PARTIES', 'TEXT', true),
    f('contractor_legal_name', 'Contractor — registered legal name', 'PARTIES', 'TEXT', true),
    f('contractor_address', 'Contractor — address for notices', 'PARTIES', 'TEXT', true),
    f('engineer', 'Engineer', 'PARTIES', 'TEXT', true),
    f('works_description', 'The works', 'PROJECT', 'TEXT', true),
    f('site_address', 'Site', 'PROJECT', 'TEXT', true),
    f('country_of_site', 'Country where the works are executed', 'PROJECT', 'TEXT', true),
    f('commencement_date', 'Commencement date (if fixed)', 'DATES', 'DATE', false, { highRisk: true }),
    f('time_for_completion', 'Time for completion', 'DATES', 'DURATION', true, { highRisk: true }),
    f('accepted_contract_amount', 'Accepted contract amount', 'COMMERCIAL', 'MONEY', true, { highRisk: true }),
    f('currencies', 'Currencies of payment', 'COMMERCIAL', 'TEXT', true),
    f('retention_percent', 'Retention percentage', 'COMMERCIAL', 'PERCENT', true),
    f('delay_damages', 'Delay damages', 'COMMERCIAL', 'MONEY', true, { highRisk: true }),
    f('delay_damages_per', 'Delay damages are charged', 'COMMERCIAL', 'CHOICE', true, { options: PER }),
    f('delay_damages_cap_percent', 'Cap on delay damages — percentage of the contract sum', 'COMMERCIAL', 'PERCENT', false, { help: 'Leave blank where the damages are uncapped.' }),
    f('performance_security_percent', 'Performance security — percentage of the accepted contract amount', 'COMMERCIAL', 'PERCENT', true),
    f('defects_notification_period', 'Defects notification period', 'COMMERCIAL', 'DURATION', true),
    f('insurance_requirements', 'Insurances required', 'INSURANCE', 'TEXT', true),
    f('governing_law', 'Governing law', 'OBLIGATIONS', 'TEXT', true, { help: 'The law of the contract — distinct from the country of the site.' }),
    f('daab_configuration', 'Dispute avoidance / adjudication board', 'OBLIGATIONS', 'CHOICE', true, { options: choice(['SOLE', 'One member'], ['THREE', 'Three members']) }),
    f('tests_on_completion', 'Tests on completion and after completion', 'OBLIGATIONS', 'TEXT', false),
    f('employers_requirements_reference', 'Employer’s Requirements — document and revision', 'ATTACHMENTS', 'REFERENCE', true, { highRisk: true }),
    f('special_provisions_reference', 'Particular conditions / special provisions — document and revision', 'ATTACHMENTS', 'REFERENCE', false, { help: 'Every special provision is a change to the general conditions and goes to legal review.' }),
  ],
};

const SCHEDULES: readonly Schedule[] = [JCT_DB_2024, NEC4_ECC, FIDIC_YELLOW_2017_R2022];

/** The schedule for a catalogue entry: its own if it has one, the general schedule otherwise. */
export function scheduleFor(formKey: string): Schedule {
  return SCHEDULES.find((schedule) => schedule.formKey === formKey) ?? GENERAL;
}

export function scheduleById(id: string): Schedule | undefined {
  return [GENERAL, ...SCHEDULES].find((schedule) => schedule.id === id);
}

/** Whether a form has a schedule written for it, as opposed to the general one. */
export const hasOwnSchedule = (formKey: string): boolean => SCHEDULES.some((schedule) => schedule.formKey === formKey);

export type Finding = { severity: 'BLOCKING' | 'WARNING'; fieldKey?: string; code: string; message: string };

/**
 * What stops the particulars being approved, from the values alone.
 *
 * Missing required fields, dates in the wrong order, and the form-specific
 * combinations that cannot both be true — an NEC target contract with a priced
 * activity schedule's pricing document, delay damages charged without the
 * secondary option that provides for them, sections with no dates.
 */
export function findings(schedule: Schedule, values: Readonly<Record<string, string>>): Finding[] {
  const out: Finding[] = [];
  const has = (key: string) => typeof values[key] === 'string' && values[key] !== '';
  for (const field of schedule.fields) {
    if (field.required && !has(field.key)) out.push({ severity: 'BLOCKING', fieldKey: field.key, code: 'FIELD_MISSING', message: `${field.label} is not completed.` });
  }
  const start = values.start_date ?? values.possession_date ?? values.starting_date ?? values.commencement_date;
  if (start && values.completion_date && values.completion_date <= start) {
    out.push({ severity: 'BLOCKING', fieldKey: 'completion_date', code: 'DATES_OUT_OF_ORDER', message: `Completion (${values.completion_date}) is not after the start (${start}).` });
  }
  if (has('delay_damages') && schedule.fields.some((field) => field.key === 'delay_damages_per') && !has('delay_damages_per')) {
    out.push({ severity: 'BLOCKING', fieldKey: 'delay_damages_per', code: 'FIELD_MISSING', message: 'Say whether delay damages are charged per day or per week.' });
  }
  if (schedule.id === JCT_DB_2024.id && values.sectional_completion === 'YES' && !has('section_dates')) {
    out.push({ severity: 'BLOCKING', fieldKey: 'section_dates', code: 'SECTIONS_UNDATED', message: 'Sectional completion is chosen but the sections and their dates are not given.' });
  }
  if (schedule.id === NEC4_ECC.id) {
    const option = values.main_option;
    const expected = option === 'A' || option === 'C' ? 'ACTIVITY_SCHEDULE' : option === 'B' || option === 'D' ? 'BILL_OF_QUANTITIES' : option === 'E' || option === 'F' ? 'NONE' : undefined;
    if (expected && has('pricing_document_kind') && values.pricing_document_kind !== expected) {
      out.push({ severity: 'BLOCKING', fieldKey: 'pricing_document_kind', code: 'NEC_PRICING_DOCUMENT_MISMATCH', message: `Main option ${option} is priced by ${expected === 'NONE' ? 'no activity schedule or bill' : expected === 'ACTIVITY_SCHEDULE' ? 'an activity schedule' : 'a bill of quantities'}, not by the pricing document chosen.` });
    }
    if (expected && expected !== 'NONE' && !has('pricing_document_reference')) {
      out.push({ severity: 'BLOCKING', fieldKey: 'pricing_document_reference', code: 'FIELD_MISSING', message: `Main option ${option} needs its ${expected === 'ACTIVITY_SCHEDULE' ? 'activity schedule' : 'bill of quantities'} named.` });
    }
    if (option && 'CDEF'.includes(option) && !has('fee_percentage')) {
      out.push({ severity: 'BLOCKING', fieldKey: 'fee_percentage', code: 'FIELD_MISSING', message: `Main option ${option} needs the fee percentage.` });
    }
    const secondary = (values.secondary_options ?? '').toUpperCase();
    if (/\bX7\b/.test(secondary) && !has('delay_damages')) {
      out.push({ severity: 'BLOCKING', fieldKey: 'delay_damages', code: 'FIELD_MISSING', message: 'Option X7 is chosen but the delay damages are not given.' });
    }
    if (has('delay_damages') && !/\bX7\b/.test(secondary)) {
      out.push({ severity: 'BLOCKING', fieldKey: 'secondary_options', code: 'NEC_X7_NOT_CHOSEN', message: 'Delay damages are given but option X7, which provides for them, is not among the secondary options.' });
    }
  }
  for (const key of ['z_clauses_reference', 'special_provisions_reference']) {
    if (has(key)) out.push({ severity: 'WARNING', fieldKey: key, code: 'AMENDMENTS_NEED_LEGAL_REVIEW', message: 'The standard form is amended; the amendments go to legal review before approval.' });
  }
  return out;
}
