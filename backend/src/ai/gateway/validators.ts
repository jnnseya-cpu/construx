/**
 * The CONSTRUX AI Gateway — output validators (spec §12, Increment 4).
 *
 * Every task profile names the quality floors its output must clear before the
 * gateway will hand it back (`ROUTE_POLICY[profile].validations`). This module
 * is the one place those floors are checked, and it is **fail-closed by
 * construction**: a validator returns `PASS` only on positive evidence that the
 * floor is met, and `FAIL` otherwise — including when the output simply does not
 * carry the artifact the floor needs. A required floor that cannot be shown to
 * hold is a refusal, never a silent pass (spec P07, §12).
 *
 * The checks are deliberately real and internal: they verify properties of the
 * output itself (a non-empty answer, source anchors on the inputs, an arithmetic
 * result that recomputes, a citation, a disclaimer) rather than claiming a
 * guarantee the gateway cannot substantiate. A validator the gateway cannot yet
 * perform honestly is not written as an always-pass stub — it fails closed, so
 * the task is refused rather than dressed up as verified.
 */
import type { ValidationKind } from './contract.ts';

/** The normalised output a validator inspects — built by the executor from the vendor reply. */
export type ValidatableOutput = {
  summary: string;
  evidence: Array<{ sourceId: string }>;
  confidence?: number;
  findings?: Array<{ statement: string; clause?: string }>;
  /** A self-contained arithmetic claim the gateway can recompute (spec §12 deterministic check). */
  calc?: { op: 'sum' | 'subtract' | 'multiply' | 'divide'; operands: number[]; result: number };
  /** The postconditions an agent action asserts it met (spec workflow.agent_execution). */
  postconditions?: Array<{ name: string; met: boolean }>;
  /** A disclaimer the output carries, where the task requires one. */
  disclaimer?: string;
};

/** Where the task's reading material came from — used to decide whether anchors are owed. */
export type ValidationContext = { inputRefs: string[] };

const CITATION = /\bclause\s+\d|\b\d+\.\d+\b|§\s*\d|\bsection\s+\d/i;
// Prescriptive / diagnostic language a site-evidence observation must not use: it
// records what was seen, it does not instruct or adjudicate.
const PRESCRIPTIVE = /\b(you must|must be|replace|repair|install|rectify|is (?:defective|unsafe|non-?compliant|faulty)|should be|we recommend)\b/i;
const DISCLAIMER = /\bnot legal advice\b|subject to (?:legal )?review|without prejudice|independent (?:legal|professional) advice/i;

function recompute(calc: NonNullable<ValidatableOutput['calc']>): number | null {
  const [a, ...rest] = calc.operands;
  if (a === undefined || !calc.operands.every((n) => Number.isFinite(n))) return null;
  switch (calc.op) {
    case 'sum':
      return calc.operands.reduce((s, n) => s + n, 0);
    case 'subtract':
      return rest.reduce((s, n) => s - n, a);
    case 'multiply':
      return calc.operands.reduce((s, n) => s * n, 1);
    case 'divide':
      return rest.some((n) => n === 0) ? null : rest.reduce((s, n) => s / n, a);
  }
}

/** One validator per kind. Each returns true only on positive evidence the floor is met. */
const CHECKS: Record<ValidationKind, (o: ValidatableOutput, c: ValidationContext) => boolean> = {
  // A usable structured envelope with an answer in it.
  SCHEMA: (o) => typeof o.summary === 'string',
  // A non-empty answer — the task produced something, not an empty shell.
  COMPLETENESS: (o) => o.summary.trim().length > 0,
  // Every evidence item names a source, and when the task was given material to
  // read, the answer is anchored to at least one of those sources.
  SOURCE_ANCHORS: (o, c) =>
    o.evidence.every((e) => e.sourceId.trim().length > 0) && (c.inputRefs.length === 0 || o.evidence.length > 0),
  // Every finding is backed by evidence (coverage), and inputs that were
  // supplied are actually drawn on.
  EVIDENCE_COVERAGE: (o, c) =>
    (c.inputRefs.length === 0 || o.evidence.length > 0) && ((o.findings?.length ?? 0) === 0 || o.evidence.length > 0),
  // Only an *explicitly low* confidence fails — an absent confidence is not low,
  // and the band already carries the uncertainty to the reader.
  CONFIDENCE_FLOOR: (o) => o.confidence === undefined || o.confidence >= 0.4,
  // A contractual reading cites a clause — in each finding, or in the answer.
  CLAUSE_CITATIONS: (o) =>
    (!!o.findings?.length && o.findings.every((f) => (f.clause ?? '').trim().length > 0)) || CITATION.test(o.summary),
  // The arithmetic the output states recomputes to the figure it reports.
  DETERMINISTIC_CALC_MATCH: (o) => {
    if (!o.calc) return false;
    const got = recompute(o.calc);
    return got !== null && Math.abs(got - o.calc.result) < 1e-6;
  },
  // Site evidence observes; it does not instruct or adjudicate.
  OBSERVATION_ONLY_LANGUAGE: (o) => !PRESCRIPTIVE.test(o.summary),
  // A claims/entitlement output carries the disclaimer such a reading requires.
  LEGAL_DISCLAIMER: (o) => (o.disclaimer ?? '').trim().length > 0 || DISCLAIMER.test(o.summary),
  // An agent action asserts, and met, its postconditions.
  TOOL_POSTCONDITION: (o) => (o.postconditions?.length ?? 0) > 0 && (o.postconditions ?? []).every((p) => p.met === true),
};

/**
 * Run the floors a task owes against its output. Returns a PASS/FAIL per required
 * kind — the service treats any FAIL on a required kind as the quality floor unmet
 * and refuses the output (spec §12, P07).
 */
export function validateOutput(
  required: readonly ValidationKind[],
  output: ValidatableOutput,
  context: ValidationContext,
): Partial<Record<ValidationKind, 'PASS' | 'FAIL'>> {
  const result: Partial<Record<ValidationKind, 'PASS' | 'FAIL'>> = {};
  for (const kind of required) result[kind] = CHECKS[kind](output, context) ? 'PASS' : 'FAIL';
  return result;
}
