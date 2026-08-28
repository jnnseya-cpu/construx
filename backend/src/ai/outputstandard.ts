import { DomainError } from '../core/errors.ts';

/** One reason an answer was rejected, in the shape `DomainError` carries. */
export type FieldError = { field: string; message: string };

/**
 * The AI Output Standard.
 *
 * The specification states it as a hard requirement, and states the enforcement
 * with it: *"Responses failing schema validation are rejected and retried;
 * never shown raw to the user."* Ten fields — summary, evidence, risk level,
 * commercial impact, programme impact, contract impact, recommended action,
 * confidence, source references and whether approval is required.
 *
 * The reason it is a schema rather than a prompt instruction is that a prompt
 * instruction is a request and a schema is a refusal. A model asked politely
 * for a commercial impact will, on the occasions it has nothing to say, write a
 * paragraph that reads like an assessment and contains none — and that
 * paragraph then sits on a screen next to real ones, indistinguishable, until
 * somebody prices work off it.
 *
 * Three decisions in here are load-bearing:
 *
 * **Every impact is a number or an explicit null, and always a statement.** A
 * commercial impact of `null` with "no cost effect: the works are within the
 * existing provisional sum" is a real answer. A commercial impact of `null`
 * with an empty statement is not, and is refused. This is the field a model is
 * most likely to fill with confident-sounding nothing.
 *
 * **Source references are structured, not prose.** "As per the contract" is not
 * a source. A reference is `{refType, refId}` into the Golden Thread, which
 * means it can be resolved, and a caller can pass a resolver so that a
 * reference to a record that does not exist is a rejection rather than a link
 * to a 404. A recommendation that cannot name where it came from is an opinion.
 *
 * **Nothing raw ever escapes.** A response that fails validation twice raises
 * `AI_OUTPUT_STANDARD_FAILED` carrying *the field problems*, never the model's
 * text. The whole point of the standard is that unvalidated model prose does
 * not reach a person; leaking it inside the error message would be the same
 * failure through a different door.
 */

/** L / M / H / Critical, as the specification writes it. */
export const RISK_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * A consequence the finding carries, quantified where it can be.
 *
 * The pair is the point. `statement` is always required, so there is always
 * something a person can read; the quantity is nullable, so "none" and
 * "unknown" are sayable without inventing a figure. What is not sayable is
 * silence.
 */
export type QuantifiedImpact = {
  /** Minor units, signed — a saving is negative. Null where none is claimed. */
  amountMinor: number | null;
  /** ISO 4217, required wherever an amount is given. */
  currency?: string;
  statement: string;
};

export type ProgrammeImpact = {
  /** Calendar days, signed — an acceleration is negative. Null where none is claimed. */
  days: number | null;
  statement: string;
};

export type ContractImpact = {
  /** The clause or mechanism engaged, e.g. "NEC4 60.1(12)". Null where none is. */
  clause: string | null;
  statement: string;
};

/** A record in the Golden Thread the finding was read from. */
export type SourceReference = {
  refType: string;
  refId: string;
  /** What this record contributed. Not a restatement of its type. */
  note: string;
};

/** One AI-authored finding, in the shape the specification requires. */
export type AiOutput = {
  summary: string;
  evidence: string;
  riskLevel: RiskLevel;
  commercialImpact: QuantifiedImpact;
  programmeImpact: ProgrammeImpact;
  contractImpact: ContractImpact;
  recommendedAction: string;
  /** 0–1. The agent's own confidence floor is applied against this. */
  confidence: number;
  sourceReferences: SourceReference[];
  approvalRequired: boolean;
};

/**
 * The field list, in one place, used both to build the instruction sent to the
 * model and to check what comes back.
 *
 * Kept as data rather than two parallel hand-written lists for the ordinary
 * reason: a prompt that asks for nine fields against a validator that requires
 * ten is a retry loop that can never succeed, and it would fail at runtime on a
 * customer's project rather than here.
 */
export const AI_OUTPUT_FIELDS: Array<{ field: keyof AiOutput; asks: string }> = [
  { field: 'summary', asks: 'What you found, in one or two sentences, in the language a project person would use.' },
  { field: 'evidence', asks: 'What in the record led you to that. Not a restatement of the summary.' },
  { field: 'riskLevel', asks: `One of ${RISK_LEVELS.join(', ')}.` },
  { field: 'commercialImpact', asks: '{ amountMinor: integer minor units or null, currency: ISO 4217 where an amount is given, statement: required }. Negative is a saving.' },
  { field: 'programmeImpact', asks: '{ days: signed integer or null, statement: required }. Negative is an acceleration.' },
  { field: 'contractImpact', asks: '{ clause: the clause or mechanism engaged, or null, statement: required }.' },
  { field: 'recommendedAction', asks: 'The single next action, addressed to whoever must take it.' },
  { field: 'confidence', asks: 'A number between 0 and 1. Your own confidence, not the strength of the consequence.' },
  { field: 'sourceReferences', asks: 'A non-empty array of { refType, refId, note } naming records in this project. Never prose.' },
  { field: 'approvalRequired', asks: 'true where acting on this commits money, time or a contractual position.' },
];

/**
 * The instruction to send with the request, derived from the field list.
 *
 * Sent in addition to a JSON response schema rather than instead of one. The
 * schema is what the vendor enforces where it supports enforcement; this is
 * what carries the meaning the schema cannot — that an impact statement must
 * say something even when the number is null, and that a source reference is a
 * record and not a sentence.
 */
export function outputStandardInstruction(): string {
  const lines = AI_OUTPUT_FIELDS.map(({ field, asks }) => `- ${field}: ${asks}`);
  return [
    'Answer as a single JSON object with exactly these fields:',
    ...lines,
    'Every field is required. Where you have nothing to report for an impact, give null for the quantity and say so in the statement — do not omit the field and do not invent a figure.',
  ].join('\n');
}

/** The JSON response schema, for vendors that enforce one. */
export function outputStandardSchema(): Record<string, unknown> {
  const impact = (quantity: string, type: string) => ({
    type: 'object',
    properties: { [quantity]: { type: [type, 'null'] }, statement: { type: 'string', minLength: 1 } },
    required: [quantity, 'statement'],
  });
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', minLength: 1 },
      evidence: { type: 'string', minLength: 1 },
      riskLevel: { type: 'string', enum: [...RISK_LEVELS] },
      commercialImpact: { ...impact('amountMinor', 'number'), properties: { amountMinor: { type: ['number', 'null'] }, currency: { type: 'string' }, statement: { type: 'string', minLength: 1 } } },
      programmeImpact: impact('days', 'number'),
      contractImpact: impact('clause', 'string'),
      recommendedAction: { type: 'string', minLength: 1 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      sourceReferences: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { refType: { type: 'string' }, refId: { type: 'string' }, note: { type: 'string' } },
          required: ['refType', 'refId', 'note'],
        },
      },
      approvalRequired: { type: 'boolean' },
    },
    required: AI_OUTPUT_FIELDS.map((f) => f.field),
  };
}

export type Validation =
  | { ok: true; output: AiOutput }
  | { ok: false; problems: FieldError[] };

/** Whether a source reference points at a record that exists. */
export type ReferenceResolver = (reference: { refType: string; refId: string }) => boolean;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A string with something in it. Whitespace is not content. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function checkImpact(
  problems: FieldError[],
  raw: unknown,
  field: string,
  quantity: string,
  quantityIsNumber: boolean,
): void {
  if (!isObject(raw)) {
    problems.push({ field, message: `${field} must be an object with ${quantity} and statement` });
    return;
  }
  const statement = text(raw.statement);
  if (!statement) {
    // The field this exists for. A null quantity is a legitimate answer and an
    // unexplained one is not: "no commercial impact" and "I did not consider
    // the commercial impact" are different findings that look identical once
    // the statement is missing.
    problems.push({ field: `${field}.statement`, message: `${field} must say something even where the quantity is null` });
  }
  const value = raw[quantity];
  if (value === null || value === undefined) return;
  if (quantityIsNumber) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      problems.push({ field: `${field}.${quantity}`, message: `${quantity} must be a finite number or null` });
    }
  } else if (!text(value)) {
    problems.push({ field: `${field}.${quantity}`, message: `${quantity} must be a non-empty string or null` });
  }
}

/**
 * Check a model's answer against the standard.
 *
 * Collects every problem rather than stopping at the first, because the
 * problems are what the retry is told: a model corrected one field at a time
 * takes ten round trips and ten charges to produce one answer.
 */
export function validateAiOutput(raw: unknown, options: { resolve?: ReferenceResolver } = {}): Validation {
  const problems: FieldError[] = [];

  if (!isObject(raw)) {
    return { ok: false, problems: [{ field: 'output', message: 'the answer was not a JSON object' }] };
  }

  const summary = text(raw.summary);
  if (!summary) problems.push({ field: 'summary', message: 'summary is required' });

  const evidence = text(raw.evidence);
  if (!evidence) problems.push({ field: 'evidence', message: 'evidence is required' });

  const riskLevel = typeof raw.riskLevel === 'string' ? raw.riskLevel.toUpperCase() : undefined;
  if (!riskLevel || !RISK_LEVELS.includes(riskLevel as RiskLevel)) {
    problems.push({ field: 'riskLevel', message: `riskLevel must be one of ${RISK_LEVELS.join(', ')}` });
  }

  checkImpact(problems, raw.commercialImpact, 'commercialImpact', 'amountMinor', true);
  checkImpact(problems, raw.programmeImpact, 'programmeImpact', 'days', true);
  checkImpact(problems, raw.contractImpact, 'contractImpact', 'clause', false);

  // A figure with no currency is a number nobody can add up. Minor units differ
  // by three decimal places across currencies this platform already supports,
  // so the amount alone is not enough to know what was meant.
  const commercial = isObject(raw.commercialImpact) ? raw.commercialImpact : undefined;
  if (commercial && typeof commercial.amountMinor === 'number' && !text(commercial.currency)) {
    problems.push({ field: 'commercialImpact.currency', message: 'a commercial amount must name its currency' });
  }

  const recommendedAction = text(raw.recommendedAction);
  if (!recommendedAction) problems.push({ field: 'recommendedAction', message: 'recommendedAction is required' });

  const confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    problems.push({ field: 'confidence', message: 'confidence must be a number between 0 and 1' });
  }

  const references: SourceReference[] = [];
  if (!Array.isArray(raw.sourceReferences) || raw.sourceReferences.length === 0) {
    problems.push({ field: 'sourceReferences', message: 'at least one source reference is required' });
  } else {
    raw.sourceReferences.forEach((entry, index) => {
      const at = `sourceReferences[${index}]`;
      if (!isObject(entry)) {
        problems.push({ field: at, message: 'a source reference must be an object, not prose' });
        return;
      }
      const refType = text(entry.refType);
      const refId = text(entry.refId);
      const note = text(entry.note);
      if (!refType || !refId) {
        problems.push({ field: at, message: 'a source reference needs refType and refId' });
        return;
      }
      if (!note) problems.push({ field: `${at}.note`, message: 'say what this record contributed' });
      // The check that makes a reference traceable rather than merely
      // well-formed. A model will cite `Contract:the-main-contract` quite
      // happily, and a link that resolves to nothing is worse than no link:
      // it looks checked.
      if (options.resolve && !options.resolve({ refType, refId })) {
        problems.push({ field: at, message: `${refType}:${refId} is not a record on this project` });
        return;
      }
      if (note) references.push({ refType, refId, note });
    });
  }

  if (typeof raw.approvalRequired !== 'boolean') {
    problems.push({ field: 'approvalRequired', message: 'approvalRequired must be true or false' });
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    output: {
      summary: summary!,
      evidence: evidence!,
      riskLevel: riskLevel as RiskLevel,
      commercialImpact: {
        amountMinor: typeof commercial!.amountMinor === 'number' ? commercial!.amountMinor : null,
        ...(text(commercial!.currency) ? { currency: text(commercial!.currency)! } : {}),
        statement: text((commercial as Record<string, unknown>).statement)!,
      },
      programmeImpact: {
        days: typeof (raw.programmeImpact as Record<string, unknown>).days === 'number'
          ? Number((raw.programmeImpact as Record<string, unknown>).days)
          : null,
        statement: text((raw.programmeImpact as Record<string, unknown>).statement)!,
      },
      contractImpact: {
        clause: text((raw.contractImpact as Record<string, unknown>).clause) ?? null,
        statement: text((raw.contractImpact as Record<string, unknown>).statement)!,
      },
      recommendedAction: recommendedAction!,
      confidence: confidence as number,
      sourceReferences: references,
      approvalRequired: raw.approvalRequired as boolean,
    },
  };
}

/** How the answer was arrived at, for the audit record and for the caller. */
export type StandardResult = {
  output: AiOutput;
  /** 1 where the first answer conformed, 2 where the correction did. */
  attempts: number;
  /** What was wrong with the first answer, where there was a second. */
  rejected?: FieldError[];
};

/**
 * Ask, validate, and on failure ask once more with the problems named.
 *
 * One retry, not a loop. A model that has been told exactly which fields were
 * wrong and returns the same shape again is not going to be corrected by being
 * told a third time, and each attempt is a charge against a customer's wallet.
 * Two attempts then a refusal is the honest bound.
 *
 * `ask` receives the correction text on the second call so the caller can put
 * it wherever its provider wants it, which differs between vendors.
 */
export async function conformToOutputStandard(
  ask: (correction?: string) => Promise<unknown>,
  options: { resolve?: ReferenceResolver } = {},
): Promise<StandardResult> {
  const first = validateAiOutput(await ask(), options);
  if (first.ok) return { output: first.output, attempts: 1 };

  const second = validateAiOutput(await ask(correctionFor(first.problems)), options);
  if (second.ok) return { output: second.output, attempts: 2, rejected: first.problems };

  // Both attempts failed. The refusal carries the field problems and never the
  // model's text — "never shown raw to the user" includes inside an error.
  throw new DomainError(
    'AI_OUTPUT_STANDARD_FAILED',
    'The model did not answer in the required form twice, so nothing was recorded. No charge was made for an answer that could not be used.',
    502,
    second.problems,
  );
}

/** The correction sent with the second attempt. */
export function correctionFor(problems: FieldError[]): string {
  const lines = problems.map((problem) => `- ${problem.field}: ${problem.message}`);
  return [
    'Your previous answer was rejected. Fix exactly these and answer again in full:',
    ...lines,
    outputStandardInstruction(),
  ].join('\n');
}
