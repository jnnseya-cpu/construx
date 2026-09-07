import { DomainError } from '../core/errors.ts';
import {
  CAPABILITY_AREA_LIST,
  PERMISSION_CODE_LIST,
  isCapabilityArea,
  isPermissionCode,
} from '../identity/roles.ts';

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

/**
 * When the recommended action has to be done by — §16.3.
 *
 * Same shape as an impact and for the same reason. A date is a commitment and a
 * null is a legitimate answer ("no deadline: this is a standing improvement"),
 * but silence is not — a recommendation with no date at all is one nobody is
 * late on, which is how a register of AI findings becomes a list nobody works.
 */
export type RequiredBy = {
  /** ISO date, `YYYY-MM-DD`. Null where no date can honestly be given. */
  date: string | null;
  statement: string;
};

/**
 * The authority the recommended action needs — §16.3.
 *
 * Stated by the model in the *platform's* vocabulary — a capability area and a
 * permission code out of the real matrix — and refused when it names anything
 * else. That is the whole reason it is worth asking for: "needs senior sign-off"
 * is prose, `COMMERCIAL / A` resolves to the people on this estate who can
 * actually do it.
 *
 * **The model never names a person.** It says what authority is needed;
 * `attributeAccountability` turns that into who holds it, from the same
 * `ownersFor` the rest of the platform uses. A model naming an accountable
 * owner would be inventing an org chart, and the name would look checked.
 */
export type RequiredAuthority = {
  /** A capability area from the permission matrix. Null where none is needed. */
  area: string | null;
  /** A permission code — R, C, U, A, I, X. Null with the area. */
  level: string | null;
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
  /** When it must be done by. §16.3. */
  requiredBy: RequiredBy;
  /** What authority it takes to do it, in the permission matrix's own words. §16.3. */
  requiredAuthority: RequiredAuthority;
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
  { field: 'requiredBy', asks: '{ date: an ISO YYYY-MM-DD date or null, statement: required }. When the action must be done by.' },
  {
    field: 'requiredAuthority',
    asks:
      '{ area: a capability area from this platform\'s permission matrix or null, level: one of R, C, U, A, I, X or null, ' +
      'statement: required }. What authority the action takes. Never name a person — the platform resolves who holds it.',
  },
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
      requiredBy: {
        type: 'object',
        properties: { date: { type: ['string', 'null'] }, statement: { type: 'string', minLength: 1 } },
        required: ['date', 'statement'],
      },
      requiredAuthority: {
        type: 'object',
        properties: {
          area: { type: ['string', 'null'], enum: [...CAPABILITY_AREA_LIST, null] },
          level: { type: ['string', 'null'], enum: [...PERMISSION_CODE_LIST, null] },
          statement: { type: 'string', minLength: 1 },
        },
        required: ['area', 'level', 'statement'],
      },
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

/**
 * Which version of this standard an answer was held to.
 *
 * Derived from the field list the same way `promptVersion` is derived from the
 * prompt shape, and for the same reason: the standard gains fields — §16.3 has
 * just added two — and an answer recorded last month was judged against a
 * different bar. Without this the record says the answer conformed and cannot
 * say to what, which is a claim that quietly changes meaning every time the
 * list does.
 *
 * The field *names* are hashed, not the wording asked of the model: rephrasing
 * the instruction for the same field is not a new standard, and treating it as
 * one would make the version a fingerprint rather than a version — the same
 * distinction `promptVersionOf` draws about the payload.
 */
export function outputStandardVersion(): string {
  const names = AI_OUTPUT_FIELDS.map((entry) => entry.field).join(',');
  let hash = 0x811c9dc5;
  for (let index = 0; index < names.length; index += 1) {
    hash ^= names.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `aios@${hash.toString(16).padStart(8, '0')}`;
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
 * A date, or an explicit null with a reason — §16.3.
 *
 * Anchored `YYYY-MM-DD` and parseable, because a model will happily answer
 * "end of next month" and "2026-02-30", and both look like dates until
 * something tries to sort by them.
 */
function checkRequiredBy(problems: FieldError[], raw: unknown): RequiredBy | undefined {
  if (!isObject(raw)) {
    problems.push({ field: 'requiredBy', message: 'requiredBy must be an object with date and statement' });
    return undefined;
  }
  const statement = text(raw.statement);
  if (!statement) {
    problems.push({ field: 'requiredBy.statement', message: 'say when this must be done by, even where there is no date' });
  }
  const value = raw.date;
  if (value === null || value === undefined) return statement ? { date: null, statement } : undefined;

  const date = text(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    problems.push({ field: 'requiredBy.date', message: 'date must be an ISO YYYY-MM-DD date, or null' });
    return undefined;
  }
  // `2026-02-30` parses in some engines and rolls forward in others. Round-trip
  // it: a date that does not survive being read and written is not a date.
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    problems.push({ field: 'requiredBy.date', message: `${date} is not a real calendar date` });
    return undefined;
  }
  return statement ? { date, statement } : undefined;
}

/**
 * An authority out of the real permission matrix — §16.3.
 *
 * The check that makes the field worth having. A model will name
 * `SENIOR_COMMERCIAL_APPROVAL` without hesitation, and a plausible string that
 * resolves to nobody is worse than no string: it looks like it was checked.
 * Area and level stand or fall together — an area with no level says who may
 * touch the subject and not what they may do to it, which cannot be resolved to
 * a person either.
 */
function checkRequiredAuthority(problems: FieldError[], raw: unknown): RequiredAuthority | undefined {
  if (!isObject(raw)) {
    problems.push({ field: 'requiredAuthority', message: 'requiredAuthority must be an object with area, level and statement' });
    return undefined;
  }
  const statement = text(raw.statement);
  if (!statement) {
    problems.push({
      field: 'requiredAuthority.statement',
      message: 'say what authority this takes, even where it needs none',
    });
  }

  const area = raw.area === null || raw.area === undefined ? null : text(raw.area) ?? '';
  const level = raw.level === null || raw.level === undefined ? null : text(raw.level)?.toUpperCase() ?? '';

  if (area === null && level === null) return statement ? { area: null, level: null, statement } : undefined;
  if (area === null || level === null) {
    problems.push({
      field: 'requiredAuthority',
      message: 'give both an area and a level, or neither — one without the other resolves to nobody',
    });
    return undefined;
  }
  if (!isCapabilityArea(area)) {
    problems.push({
      field: 'requiredAuthority.area',
      message: `${area} is not a capability area on this platform`,
    });
    return undefined;
  }
  if (!isPermissionCode(level)) {
    problems.push({
      field: 'requiredAuthority.level',
      message: `level must be one of ${PERMISSION_CODE_LIST.join(', ')}`,
    });
    return undefined;
  }
  return statement ? { area, level, statement } : undefined;
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

  const requiredBy = checkRequiredBy(problems, raw.requiredBy);
  const requiredAuthority = checkRequiredAuthority(problems, raw.requiredAuthority);

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
      requiredBy: requiredBy!,
      requiredAuthority: requiredAuthority!,
      confidence: confidence as number,
      sourceReferences: references,
      approvalRequired: raw.approvalRequired as boolean,
    },
  };
}

// --- accountability -------------------------------------------------------
//
// §16.3's third field, and the one the model must not supply. It says what
// authority the action takes; this turns that into who on this estate holds it,
// through the same `ownersFor` every other owner on the platform is resolved
// by. A model naming a person would be inventing an org chart, and the name
// would look checked.

/** Who holds an authority here. Injected, exactly as the reference resolver is. */
export type OwnerResolver = (authority: {
  area: string;
  level: string;
}) => { userId: string; name: string; role: string } | undefined;

/**
 * Who is accountable for acting on a finding.
 *
 * Three answers, and the third is why this is a union rather than an optional
 * name. `NONE_NEEDED` is a finding that takes no authority to act on.
 * `UNRESOLVED` is a finding whose authority nobody on this estate holds — a
 * real and reportable state, and the one a screen must show as a gap rather
 * than as a blank.
 */
export type AccountableOwner =
  | { resolved: true; userId: string; name: string; role: string }
  | { resolved: false; because: 'NONE_NEEDED' | 'UNRESOLVED'; statement: string };

export type AttributedAiOutput = AiOutput & { accountableOwner: AccountableOwner };

/** Name the person who holds the authority the finding says it needs. */
export function attributeAccountability(output: AiOutput, resolve: OwnerResolver): AttributedAiOutput {
  const { area, level, statement } = output.requiredAuthority;
  if (area === null || level === null) {
    return {
      ...output,
      accountableOwner: { resolved: false, because: 'NONE_NEEDED', statement },
    };
  }
  const owner = resolve({ area, level });
  return {
    ...output,
    accountableOwner: owner
      ? { resolved: true, ...owner }
      : {
          resolved: false,
          because: 'UNRESOLVED',
          // Said plainly. A finding nobody on the estate can act on is a
          // finding about the estate as much as about the project, and hiding
          // it behind an empty name would lose both.
          statement: `Nobody on this estate holds ${area} ${level}, which is what acting on this would take.`,
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
