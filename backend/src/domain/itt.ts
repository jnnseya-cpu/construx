import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { Role } from '../identity/roles.ts';
import { companyProfile, type CompanyProfile } from './radar.ts';

/**
 * The ITT analyst.
 *
 * Two outputs, and the second is the one that saves money.
 *
 * The **compliance matrix** is the ordinary half: every requirement the
 * invitation makes, who owns it, what evidences it, whether it is satisfied and
 * when it is due. Small contractors lose bids they had priced correctly because
 * one certificate was missing from the upload, and a matrix with an owner
 * against every line is the cheapest possible fix for that.
 *
 * The **commercial terms** are the half that decides whether the job is worth
 * winning. An analyst that lists "liquidated damages: £5,000 per week" has
 * transcribed a document. One that says "£5,000 a week against a 30-week
 * programme is £150,000 of exposure, two and a half times the margin, and the
 * contract caps them at nothing" has done the job. So every term here is
 * assessed against the company's own position rather than reported.
 *
 * Three of these terms end companies and none of them are obvious in the price:
 *
 *   - **Fitness for purpose.** A design obligation expressed as fitness for
 *     purpose rather than reasonable skill and care is excluded by almost every
 *     professional indemnity policy in the market. The contractor carries it
 *     personally, uninsured, usually without knowing.
 *   - **Uncapped liquidated damages** on a programme the contractor does not
 *     control.
 *   - **A parent company guarantee** demanded of a business with no parent,
 *     which is not a term to negotiate but a bar to entry.
 */

// --- The matrix --------------------------------------------------------------------

export type RequirementCategory =
  | 'QUALIFICATION'
  | 'TECHNICAL'
  | 'COMMERCIAL'
  | 'INSURANCE'
  | 'HEALTH_AND_SAFETY'
  | 'QUALITY'
  | 'ENVIRONMENTAL'
  | 'SOCIAL_VALUE'
  | 'PROGRAMME'
  | 'SUBMISSION';

export type ITTRequirement = {
  reference: string;
  category: RequirementCategory;
  requirement: string;
  /** Pass/fail rather than scored. A failure here ends the bid. */
  mandatory: boolean;
  /** Marks out of the evaluation, where the ITT states them. */
  weightingPercent?: number;
  /** What the buyer wants to see. */
  evidenceRequired: string;
  /** When it must be in, if earlier than the return date. */
  dueBy?: string;
};

/** Where the platform can already prove a requirement from its own records. */
type EvidenceProbe = {
  match: RegExp;
  /** Reads the profile and returns proof, or null when there is none. */
  find: (profile: CompanyProfile) => string | null;
};

/**
 * What the platform can evidence without being asked.
 *
 * Deliberately short. A probe that guesses is worse than no probe, because a
 * matrix line marked satisfied is a line nobody checks again.
 */
const PROBES: EvidenceProbe[] = [
  {
    match: /employer'?s liability|public liability|professional indemnity|contract works/i,
    find: (p) => {
      const held = p.insurances.map((i) => `${i.type} ${(i.limitMinor / 100).toLocaleString('en-GB')}`);
      return held.length > 0 ? `Policies on file: ${held.join('; ')}` : null;
    },
  },
  {
    match: /chas|constructionline|safecontractor|iso ?9001|iso ?14001|iso ?45001|accreditation/i,
    find: (p) => (p.accreditations.length > 0 ? `Held: ${p.accreditations.join(', ')}` : null),
  },
  {
    match: /turnover|accounts|financial standing/i,
    find: (p) =>
      p.turnoverMinorByYear.length > 0
        ? `${p.turnoverMinorByYear.length} year(s) of turnover on file, latest £${(p.turnoverMinorByYear[0]! / 100).toLocaleString('en-GB')}`
        : null,
  },
  {
    match: /reference|case stud|similar (project|scheme|contract)|track record/i,
    find: (p) => {
      const verified = p.references.filter((r) => r.verified);
      return verified.length > 0 ? `${verified.length} verified reference(s) on file` : null;
    },
  },
];

export type MatrixStatus = 'SATISFIED' | 'GAP' | 'UNKNOWN';

export type MatrixLine = {
  reference: string;
  category: RequirementCategory;
  requirement: string;
  mandatory: boolean;
  weightingPercent?: number;
  /** The role that owns getting this done. */
  owner: Role;
  evidenceRequired: string;
  /** What the platform already holds, where it holds anything. */
  evidenceHeld?: string;
  status: MatrixStatus;
  dueBy?: string;
};

/**
 * Who owns each kind of requirement.
 *
 * A matrix without an owner is a list, and a list is what gets to the day
 * before return with three items nobody claimed.
 */
const OWNER_BY_CATEGORY: Record<RequirementCategory, Role> = {
  QUALIFICATION: 'OWNER',
  TECHNICAL: 'EPC',
  COMMERCIAL: 'QS',
  INSURANCE: 'OWNER',
  HEALTH_AND_SAFETY: 'SAFETY',
  QUALITY: 'QAQC',
  ENVIRONMENTAL: 'SAFETY',
  SOCIAL_VALUE: 'OWNER',
  PROGRAMME: 'PLANNER',
  SUBMISSION: 'QS',
};

// --- Commercial terms ---------------------------------------------------------------

export type DesignLiability = 'NONE' | 'REASONABLE_SKILL_AND_CARE' | 'FITNESS_FOR_PURPOSE';

export type CommercialTerms = {
  contractForm: string;
  /** Liquidated damages, per week, and whether they are capped. */
  liquidatedDamages?: { perWeekMinor: number; capPercent?: number };
  /** Performance bond as a percentage of contract value. */
  performanceBondPercent?: number;
  /** Whether a parent company guarantee is demanded. */
  parentCompanyGuaranteeRequired?: boolean;
  retentionPercent?: number;
  /** Days from application to payment, as the contract states them. */
  paymentDays?: number;
  designLiability?: DesignLiability;
  /** Sectional completion dates the contractor is tied to. */
  sectionalCompletions?: number;
  /** Anything else stated, carried verbatim rather than interpreted. */
  other?: string[];
};

export type TermAssessment = {
  term: string;
  stated: string;
  /** What it means for this business, with the arithmetic. */
  assessment: string;
  severity: 'BAR' | 'SEVERE' | 'MATERIAL' | 'ROUTINE';
  /** Exposure in money, where it can be computed. */
  exposureMinor?: number;
};

export type ITTAnalysis = {
  analysisId: string;
  reference: string;
  clientName: string;
  returnBy: string;
  /** Every requirement, with an owner and a status. */
  matrix: MatrixLine[];
  /** Mandatory requirements with no evidence. These end the bid. */
  mandatoryGaps: MatrixLine[];
  /** How the evaluation is weighted, and whether it adds up. */
  weightings: { stated: number; declared: Array<{ category: RequirementCategory; percent: number }>; complete: boolean };
  terms: TermAssessment[];
  /** Terms that are a bar rather than a negotiation. */
  bars: string[];
  /** Total quantified exposure across the terms that carry a number. */
  quantifiedExposureMinor: number;
  /** Questions that should go to the buyer before the return date. */
  clarifications: string[];
  readyToPrice: boolean;
};

const gbp = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

/**
 * Analyse an invitation to tender.
 *
 * Reads the company profile so every judgement is against what this business
 * actually is — the same rule the radar follows. A term is not severe in the
 * abstract; it is severe relative to a margin, a PI limit or a balance sheet.
 */
export function analyseITT(
  ctx: EngineContext,
  input: {
    reference: string;
    clientName: string;
    returnBy: string;
    /** Value the contractor expects to price, for exposure arithmetic. */
    estimatedValueMinor: number;
    durationWeeks: number;
    requirements: ITTRequirement[];
    terms: CommercialTerms;
    /** Expected margin percentage, so exposure can be set against it. */
    targetMarginPercent?: number;
  },
): ITTAnalysis {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  if (input.requirements.length === 0) {
    throw new DomainError('ITT_EMPTY', 'An invitation with no requirements has not been read properly');
  }

  const profile = companyProfile(ctx);
  const marginMinor = Math.round(input.estimatedValueMinor * ((input.targetMarginPercent ?? profile.targetMarginPercent.min) / 100));

  // --- The matrix -----------------------------------------------------------
  const matrix: MatrixLine[] = input.requirements.map((requirement) => {
    const probe = PROBES.find((p) => p.match.test(requirement.requirement) || p.match.test(requirement.evidenceRequired));
    const held = probe?.find(profile) ?? null;

    return {
      reference: requirement.reference,
      category: requirement.category,
      requirement: requirement.requirement,
      mandatory: requirement.mandatory,
      weightingPercent: requirement.weightingPercent,
      owner: OWNER_BY_CATEGORY[requirement.category],
      evidenceRequired: requirement.evidenceRequired,
      evidenceHeld: held ?? undefined,
      // A requirement the platform cannot probe is UNKNOWN, not a gap. Marking
      // it a gap would bury the real gaps under everything nobody automated.
      status: held ? 'SATISFIED' : probe ? 'GAP' : 'UNKNOWN',
      dueBy: requirement.dueBy,
    };
  });

  const mandatoryGaps = matrix.filter((line) => line.mandatory && line.status === 'GAP');

  // --- Weightings -----------------------------------------------------------
  const declared = new Map<RequirementCategory, number>();
  for (const requirement of input.requirements) {
    if (requirement.weightingPercent === undefined) continue;
    declared.set(requirement.category, (declared.get(requirement.category) ?? 0) + requirement.weightingPercent);
  }
  const statedTotal = [...declared.values()].reduce((sum, v) => sum + v, 0);

  // --- Commercial terms -----------------------------------------------------
  const terms: TermAssessment[] = [];
  const bars: string[] = [];
  const clarifications: string[] = [];
  let quantifiedExposureMinor = 0;

  const { liquidatedDamages: lads } = input.terms;
  if (lads) {
    // The honest exposure is the cap where there is one, and the whole
    // programme where there is not — because uncapped means uncapped.
    const cappedMinor = lads.capPercent !== undefined ? Math.round(input.estimatedValueMinor * (lads.capPercent / 100)) : undefined;
    const uncappedOverRun = lads.perWeekMinor * input.durationWeeks;
    const exposure = cappedMinor ?? uncappedOverRun;
    quantifiedExposureMinor += exposure;

    terms.push({
      term: 'Liquidated damages',
      stated: `${gbp(lads.perWeekMinor)} per week${lads.capPercent !== undefined ? `, capped at ${lads.capPercent}%` : ', uncapped'}`,
      assessment:
        lads.capPercent === undefined
          ? `Uncapped. Ten weeks late is ${gbp(lads.perWeekMinor * 10)}, which is ${(marginMinor > 0 ? (lads.perWeekMinor * 10) / marginMinor : 0).toFixed(1)}× the expected margin. An uncapped damages clause on a programme the contractor does not fully control is the single most common way a profitable job becomes a loss.`
          : `Capped at ${gbp(cappedMinor!)}, which is ${(marginMinor > 0 ? cappedMinor! / marginMinor : 0).toFixed(1)}× the expected margin of ${gbp(marginMinor)}.`,
      severity: lads.capPercent === undefined ? 'SEVERE' : cappedMinor! > marginMinor ? 'MATERIAL' : 'ROUTINE',
      exposureMinor: exposure,
    });
    if (lads.capPercent === undefined) {
      clarifications.push('Will the buyer accept a cap on liquidated damages, expressed as a percentage of the contract sum?');
    }
  }

  if (input.terms.designLiability === 'FITNESS_FOR_PURPOSE') {
    // This is the one that catches people. It is not a pricing question.
    const pi = profile.insurances.find((i) => /professional indemnity/i.test(i.type));
    terms.push({
      term: 'Design liability',
      stated: 'Fitness for purpose',
      assessment: `Fitness for purpose is excluded by almost every professional indemnity policy in the market, including the ${pi ? `${gbp(pi.limitMinor)} policy on file` : 'cover this business holds'}. The obligation would sit with the company uninsured, for the statutory limitation period.`,
      severity: 'SEVERE',
    });
    clarifications.push(
      'Will the buyer amend the design obligation to reasonable skill and care? Fitness for purpose is uninsurable under standard professional indemnity cover.',
    );
  } else if (input.terms.designLiability === 'REASONABLE_SKILL_AND_CARE') {
    terms.push({
      term: 'Design liability',
      stated: 'Reasonable skill and care',
      assessment: 'The insurable standard. Professional indemnity cover responds to it.',
      severity: 'ROUTINE',
    });
  }

  if (input.terms.parentCompanyGuaranteeRequired) {
    // An SME with no parent cannot provide one at any price.
    terms.push({
      term: 'Parent company guarantee',
      stated: 'Required',
      assessment:
        'A parent company guarantee can only be given by a parent. For a business without one this is a bar to entry rather than a term to negotiate, and the alternative the buyer will accept is usually a bond at a cost.',
      severity: 'BAR',
    });
    bars.push('Parent company guarantee required');
    clarifications.push('Will the buyer accept a performance bond in place of a parent company guarantee, and at what percentage?');
  }

  if (input.terms.performanceBondPercent !== undefined) {
    const bondMinor = Math.round(input.estimatedValueMinor * (input.terms.performanceBondPercent / 100));
    terms.push({
      term: 'Performance bond',
      stated: `${input.terms.performanceBondPercent}% of contract value`,
      assessment: `${gbp(bondMinor)} of bonding facility committed for the contract period and usually beyond it. Bonding capacity is finite and shared across every live job, so this is capacity taken from the next bid as well as this one.`,
      severity: bondMinor > profile.netAssetsMinor * 0.5 ? 'SEVERE' : 'MATERIAL',
      exposureMinor: bondMinor,
    });
  }

  if (input.terms.retentionPercent !== undefined) {
    const retentionMinor = Math.round(input.estimatedValueMinor * (input.terms.retentionPercent / 100));
    quantifiedExposureMinor += retentionMinor;
    terms.push({
      term: 'Retention',
      stated: `${input.terms.retentionPercent}%`,
      assessment: `${gbp(retentionMinor)} withheld, typically half released at completion and half after the defects period. This is cash the business funds, not a discount, and the second half is often years away.`,
      severity: retentionMinor > marginMinor ? 'MATERIAL' : 'ROUTINE',
      exposureMinor: retentionMinor,
    });
  }

  if (input.terms.paymentDays !== undefined) {
    terms.push({
      term: 'Payment terms',
      stated: `${input.terms.paymentDays} days`,
      assessment:
        input.terms.paymentDays > 45
          ? `${input.terms.paymentDays} days is materially longer than the 30 days most subcontractors expect. The difference is funded by this business, and the cash model should be run before the price is committed.`
          : `${input.terms.paymentDays} days. Run the cash model against subcontract terms before committing to it.`,
      severity: input.terms.paymentDays > 45 ? 'MATERIAL' : 'ROUTINE',
    });
  }

  if (input.terms.sectionalCompletions !== undefined && input.terms.sectionalCompletions > 0) {
    terms.push({
      term: 'Sectional completion',
      stated: `${input.terms.sectionalCompletions} section${input.terms.sectionalCompletions === 1 ? '' : 's'}`,
      assessment: `Each section carries its own completion date and, usually, its own damages. ${input.terms.sectionalCompletions} sections means ${input.terms.sectionalCompletions} separate chances to be late rather than one.`,
      severity: 'MATERIAL',
    });
  }

  for (const other of input.terms.other ?? []) {
    terms.push({ term: 'Stated in the invitation', stated: other, assessment: 'Carried verbatim; not assessed by the platform.', severity: 'ROUTINE' });
  }

  // --- Submission readiness -------------------------------------------------
  for (const gap of mandatoryGaps) {
    clarifications.push(`${gap.reference}: ${gap.evidenceRequired} — nothing on file to satisfy this.`);
  }
  if (statedTotal > 0 && statedTotal !== 100) {
    clarifications.push(`The stated evaluation weightings total ${statedTotal}%, not 100%. Ask the buyer to confirm the full breakdown before pricing.`);
  }

  const analysisId = ulid();
  const readyToPrice = mandatoryGaps.length === 0 && bars.length === 0;

  // Worst first, and ordered before the record is written rather than after it.
  //
  // A bid manager reads three lines and stops, so the bar and the uninsurable
  // obligation have to be the three lines. Ordering it here means the record
  // and the returned assessment are the same document in the same order — the
  // stored matrix is what the analyst was shown, which is the thing that gets
  // argued about later.
  const SEVERITY_ORDER = { BAR: 0, SEVERE: 1, MATERIAL: 2, ROUTINE: 3 } as const;
  const orderedTerms = [...terms].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  write(ctx, {
    eventType: 'ITT_ANALYSED',
    entity: { refType: 'ITTAnalysis', refId: analysisId },
    nextState: {
      id: analysisId,
      reference: input.reference,
      clientName: input.clientName,
      returnBy: input.returnBy,
      estimatedValueMinor: input.estimatedValueMinor,
      durationWeeks: input.durationWeeks,
      matrix,
      mandatoryGaps: mandatoryGaps.map((g) => g.reference),
      weightings: { stated: statedTotal, complete: statedTotal === 100 },
      terms: orderedTerms,
      bars,
      quantifiedExposureMinor,
      clarifications,
      readyToPrice,
      analysedAt: new Date().toISOString(),
      analysedBy: ctx.auth.actorId,
    },
  });

  return {
    analysisId,
    reference: input.reference,
    clientName: input.clientName,
    returnBy: input.returnBy,
    matrix,
    mandatoryGaps,
    weightings: {
      stated: statedTotal,
      declared: [...declared.entries()].map(([category, percent]) => ({ category, percent })),
      complete: statedTotal === 100,
    },
    terms: orderedTerms,
    bars,
    quantifiedExposureMinor,
    clarifications,
    readyToPrice,
  };
}
