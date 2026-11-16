import { locateQuote, type QuoteSource, type SourceDocument } from './tendersource.ts';

/**
 * What a tender says about itself: the documents it is made of, which one wins
 * when two disagree, how the bid is evaluated, the rules for the return, and
 * its dates.
 *
 * Each is read with the requirements in the same run, then carried on the
 * matrix with the passage it came from, so the document register, the deadline
 * tracker and the evaluation rules on the matrix all cite the pack. Nothing
 * here is inferred: a field the documents do not state stays null, and "not
 * stated" is what the screen says.
 */

export type ListedDocument = { title: string; reference?: string; revision?: string; issuedOn?: string; source?: QuoteSource };
export type Milestone = { label: string; date: string; mandatory: boolean; source?: QuoteSource };

export type EvaluationRules = {
  qualityPercent?: number;
  pricePercent?: number;
  /** As the documents state it: "an overall quality score of 60%", "no question scored below 2". */
  minimumQualityScore?: string;
  scoringMethod?: string;
  consortia?: string;
  subcontracting?: string;
  relianceOnOthers?: string;
  equivalentEvidence?: string;
  qualificationsPermitted?: boolean;
  variantsPermitted?: boolean;
  source?: QuoteSource;
};

export type SubmissionRules = {
  uploadLimitMb?: number;
  namingConvention?: string;
  permittedFormats?: string[];
  signatures?: string;
  appendicesPermitted?: boolean;
  source?: QuoteSource;
};

export type TenderParticulars = {
  documentsListed: ListedDocument[];
  /** Referred to but not in the pack — on the portal only, or to follow. */
  documentsNotSupplied: Array<{ title: string; source?: QuoteSource }>;
  precedence?: { order: string[]; source?: QuoteSource };
  evaluation?: EvaluationRules;
  submission?: SubmissionRules;
  tenderValidityDays?: number;
  validitySource?: QuoteSource;
  awardOn?: string;
  worksStartOn?: string;
  worksCompletionOn?: string;
  worksPeriodDays?: number;
  milestones: Milestone[];
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
const date = (value: unknown): string | undefined => {
  const found = text(value);
  return found && DATE.test(found) ? found : undefined;
};
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const flag = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const list = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value) ? value.filter((entry) => record(entry)).map((entry) => entry as Record<string, unknown>) : [];

/** Drop the keys whose value is undefined, so a stored record carries only what was stated. */
function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** The particulars a reading found, each cited to the documents where its passage is found. */
export function particularsFromReading(extraction: Record<string, unknown>, documents: SourceDocument[]): TenderParticulars {
  const cite = (quote: unknown, fallback?: unknown): QuoteSource | undefined =>
    text(quote) || text(fallback) ? locateQuote(documents, { quote, fallback }) : undefined;

  const evaluation = record(extraction.evaluation);
  const submission = record(extraction.submissionRules);
  const precedence = record(extraction.precedence);
  const order = Array.isArray(precedence?.order) ? (precedence!.order as unknown[]).map(text).filter((entry): entry is string => Boolean(entry)) : [];

  const evaluationRules = evaluation
    ? defined<EvaluationRules>({
        qualityPercent: number(evaluation.qualityPercent),
        pricePercent: number(evaluation.pricePercent),
        minimumQualityScore: text(evaluation.minimumQualityScore),
        scoringMethod: text(evaluation.scoringMethod),
        consortia: text(evaluation.consortia),
        subcontracting: text(evaluation.subcontracting),
        relianceOnOthers: text(evaluation.relianceOnOthers),
        equivalentEvidence: text(evaluation.equivalentEvidence),
        qualificationsPermitted: flag(evaluation.qualificationsPermitted),
        variantsPermitted: flag(evaluation.variantsPermitted),
        source: cite(evaluation.sourceQuote),
      })
    : undefined;
  const submissionRules = submission
    ? defined<SubmissionRules>({
        uploadLimitMb: number(submission.uploadLimitMb),
        namingConvention: text(submission.namingConvention),
        permittedFormats: Array.isArray(submission.permittedFormats)
          ? (submission.permittedFormats as unknown[]).map(text).filter((entry): entry is string => Boolean(entry))
          : undefined,
        signatures: text(submission.signatures),
        appendicesPermitted: flag(submission.appendicesPermitted),
        source: cite(submission.sourceQuote),
      })
    : undefined;
  const hasContent = (value: Record<string, unknown> | undefined): boolean =>
    Boolean(value && Object.keys(value).some((key) => key !== 'source' && !(Array.isArray(value[key]) && (value[key] as unknown[]).length === 0)));

  return defined<TenderParticulars>({
    documentsListed: list(extraction.documentsListed)
      .filter((entry) => text(entry.title))
      .map((entry) =>
        defined<ListedDocument>({
          title: text(entry.title)!,
          reference: text(entry.reference),
          revision: text(entry.revision),
          issuedOn: date(entry.issuedOn),
          source: cite(entry.sourceQuote, entry.title),
        }),
      ),
    documentsNotSupplied: list(extraction.documentsNotSupplied)
      .filter((entry) => text(entry.title))
      .map((entry) => defined({ title: text(entry.title)!, source: cite(entry.sourceQuote) })),
    precedence: order.length > 0 ? defined({ order, source: cite(precedence?.sourceQuote) }) : undefined,
    evaluation: hasContent(evaluationRules) ? evaluationRules : undefined,
    submission: hasContent(submissionRules) ? submissionRules : undefined,
    tenderValidityDays: number(extraction.tenderValidityDays) !== undefined ? Math.round(number(extraction.tenderValidityDays)!) : undefined,
    validitySource: number(extraction.tenderValidityDays) !== undefined ? cite(extraction.validitySourceQuote) : undefined,
    awardOn: date(extraction.awardOn),
    worksStartOn: date(extraction.worksStartOn),
    worksCompletionOn: date(extraction.worksCompletionOn),
    worksPeriodDays: number(extraction.worksPeriodDays),
    milestones: list(extraction.milestones)
      .filter((entry) => text(entry.label) && date(entry.date))
      .map((entry) =>
        defined<Milestone>({
          label: text(entry.label)!,
          date: date(entry.date)!,
          mandatory: entry.mandatory === true,
          source: cite(entry.sourceQuote),
        }),
      ),
  });
}

/**
 * One tender, one set of particulars: a later reading (the questionnaire after
 * the ITT) adds what it states and does not erase what it is silent on.
 */
export function mergeParticulars(prior: TenderParticulars | undefined, next: TenderParticulars): TenderParticulars {
  if (!prior) return next;
  const byKey = <T>(earlier: T[], later: T[], key: (entry: T) => string): T[] => {
    const merged = new Map<string, T>();
    for (const entry of [...earlier, ...later]) merged.set(key(entry), entry);
    return [...merged.values()];
  };
  const fields = <T extends object>(earlier: T | undefined, later: T | undefined): T | undefined =>
    earlier || later ? ({ ...(earlier ?? {}), ...(later ?? {}) } as T) : undefined;
  return defined<TenderParticulars>({
    documentsListed: byKey(prior.documentsListed, next.documentsListed, (entry) => (entry.reference ?? entry.title).toLowerCase()),
    documentsNotSupplied: byKey(prior.documentsNotSupplied, next.documentsNotSupplied, (entry) => entry.title.toLowerCase()),
    precedence: next.precedence ?? prior.precedence,
    evaluation: fields(prior.evaluation, next.evaluation),
    submission: fields(prior.submission, next.submission),
    tenderValidityDays: next.tenderValidityDays ?? prior.tenderValidityDays,
    validitySource: next.tenderValidityDays !== undefined ? next.validitySource : prior.validitySource,
    awardOn: next.awardOn ?? prior.awardOn,
    worksStartOn: next.worksStartOn ?? prior.worksStartOn,
    worksCompletionOn: next.worksCompletionOn ?? prior.worksCompletionOn,
    worksPeriodDays: next.worksPeriodDays ?? prior.worksPeriodDays,
    milestones: byKey(prior.milestones, next.milestones, (entry) => `${entry.label.toLowerCase()}|${entry.date}`),
  });
}

/** What the reader is asked for, added to the tender reading's prompt. */
export const PARTICULARS_PROMPT =
  'Also report what the tender says about itself, each with a `sourceQuote` copied from the document: ' +
  '`documentsListed` — every document the pack lists as part of the tender (its schedule or index of tender ' +
  'documents), with its reference, revision and issue date where stated; `documentsNotSupplied` — documents it refers ' +
  'to that are not among those supplied (available on the portal only, to follow, or missing); `precedence` — the ' +
  'order in which the documents take precedence where it states one, highest first; `evaluation` — the quality and ' +
  'price split as percentages, any minimum quality score as stated, the scoring method, and what it says about ' +
  'consortia, subcontracting, reliance on other entities, equivalent evidence, and whether qualifications or variant ' +
  'bids are permitted; `submissionRules` — upload size limit in MB, file naming convention, permitted formats, ' +
  'signature requirements and whether appendices are permitted; `tenderValidityDays` — how long the tender must ' +
  'remain open for acceptance, in days, with `validitySourceQuote`; `awardOn` — the anticipated award date ' +
  '(YYYY-MM-DD); and `milestones` — every other dated event it states, with `mandatory` true only where the date is ' +
  'binding rather than indicative. Use null or an empty list for anything it does not state.';

const QUOTE = { type: ['string', 'null'] };
const NULLABLE_TEXT = { type: ['string', 'null'] };

/** The response schema for the particulars, merged into the tender reading's schema. */
export const PARTICULARS_SCHEMA: Record<string, unknown> = {
  documentsListed: {
    type: 'array',
    items: {
      type: 'object',
      properties: { title: { type: 'string' }, reference: NULLABLE_TEXT, revision: NULLABLE_TEXT, issuedOn: NULLABLE_TEXT, sourceQuote: QUOTE },
      required: ['title'],
    },
  },
  documentsNotSupplied: {
    type: 'array',
    items: { type: 'object', properties: { title: { type: 'string' }, sourceQuote: QUOTE }, required: ['title'] },
  },
  precedence: {
    type: ['object', 'null'],
    properties: { order: { type: 'array', items: { type: 'string' } }, sourceQuote: QUOTE },
  },
  evaluation: {
    type: ['object', 'null'],
    properties: {
      qualityPercent: { type: ['number', 'null'] },
      pricePercent: { type: ['number', 'null'] },
      minimumQualityScore: NULLABLE_TEXT,
      scoringMethod: NULLABLE_TEXT,
      consortia: NULLABLE_TEXT,
      subcontracting: NULLABLE_TEXT,
      relianceOnOthers: NULLABLE_TEXT,
      equivalentEvidence: NULLABLE_TEXT,
      qualificationsPermitted: { type: ['boolean', 'null'] },
      variantsPermitted: { type: ['boolean', 'null'] },
      sourceQuote: QUOTE,
    },
  },
  submissionRules: {
    type: ['object', 'null'],
    properties: {
      uploadLimitMb: { type: ['number', 'null'] },
      namingConvention: NULLABLE_TEXT,
      permittedFormats: { type: 'array', items: { type: 'string' } },
      signatures: NULLABLE_TEXT,
      appendicesPermitted: { type: ['boolean', 'null'] },
      sourceQuote: QUOTE,
    },
  },
  tenderValidityDays: { type: ['integer', 'null'] },
  validitySourceQuote: QUOTE,
  awardOn: NULLABLE_TEXT,
  milestones: {
    type: 'array',
    items: {
      type: 'object',
      properties: { label: { type: 'string' }, date: { type: 'string' }, mandatory: { type: 'boolean' }, sourceQuote: QUOTE },
      required: ['label', 'date', 'mandatory'],
    },
  },
};
