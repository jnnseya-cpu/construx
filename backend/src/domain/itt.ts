import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import type { Role } from '../identity/roles.ts';
import { companyProfile, type CompanyProfile } from './radar.ts';
import { evidenceRegister, type ClaimKind, type ClaimStanding } from './evidenceclaim.ts';

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

/**
 * The categories a requirement falls into.
 *
 * A list rather than a bare union, because a route schema and the answer
 * library both need the values at runtime. `RequirementCategory` is derived
 * from it, so the two cannot drift: adding a category here adds it everywhere
 * it is validated.
 */
export const REQUIREMENT_CATEGORIES = [
  'QUALIFICATION',
  'TECHNICAL',
  'COMMERCIAL',
  'INSURANCE',
  'HEALTH_AND_SAFETY',
  'QUALITY',
  'ENVIRONMENTAL',
  'SOCIAL_VALUE',
  'PROGRAMME',
  'SUBMISSION',
] as const;

export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

/**
 * How long the buyer said the answer may be.
 *
 * A stated limit is not a style note. An evaluator marking a 1,200-word answer
 * against a 1,000-word limit does not mark the extra 200 words down — the
 * standard instruction is that anything past the limit is not read, and on a
 * mandatory question that is a nil score on prose somebody spent a week
 * writing. It is also the one constraint that is cheap to check and almost
 * never checked, because it is discovered on the last afternoon by whoever is
 * pasting the sections into the template.
 *
 * `words` is checkable and is checked. `pages` is carried and reported and is
 * deliberately **not** turned into a word count: words per page depends on a
 * template this platform does not hold, and a limit enforced against an
 * invented conversion would refuse a submission that fits.
 *
 * `statedAs` is the buyer's own wording, so a disputed limit is settled by
 * quotation rather than by argument about what the platform extracted.
 */
export type ResponseLimit = {
  words?: number;
  pages?: number;
  statedAs: string;
};

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
  /** How long the answer may be, where the invitation says. */
  responseLimit?: ResponseLimit;
};

/** Where the platform can already prove a requirement from its own records. */
type EvidenceProbe = {
  match: RegExp;
  /**
   * Reads the profile — and the requirement, so a probe can look for the
   * specific thing the invitation named rather than only the category — and
   * returns proof, or null when there is none.
   */
  find: (profile: CompanyProfile, requirement: ITTRequirement) => string | null;
};

/**
 * Specific technical certificates and management-system standards an invitation
 * names by number or scheme, each recognised the same way whether the string is
 * the buyer's requirement or the company's own record.
 *
 * This is separate from the accreditation probe below on purpose. That one
 * answers a *category* — "an accreditation" — by returning the whole list, which
 * is right for "hold a recognised accreditation" and wrong for "hold ISO 14001":
 * a company with ISO 9001 and no ISO 14001 was marked satisfied against the one
 * it does not hold, and a satisfied line is a line nobody checks again. These
 * match the one the invitation asked for and look for that one on file; a
 * certificate named but not held is a gap, which is the safe direction to be
 * wrong in.
 *
 * Exact by design. "ISO 45001 or equivalent" is not auto-satisfied by an OHSAS
 * 18001 or an SSIP membership held instead — reading "or equivalent" is the
 * bidder's judgement, and a probe that made it would be guessing a line
 * satisfied. The unmatched case falls to a gap, which prompts the check rather
 * than hiding it.
 */
const NAMED_CERTIFICATES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'ISO 9001', pattern: /iso[\s-]?9001/i },
  { label: 'ISO 14001', pattern: /iso[\s-]?14001/i },
  { label: 'ISO 45001', pattern: /iso[\s-]?45001/i },
  { label: 'ISO 27001', pattern: /iso[\s-]?27001/i },
  { label: 'ISO 44001', pattern: /iso[\s-]?44001/i },
  { label: 'ISO 19650', pattern: /iso[\s-]?19650/i },
  { label: 'ISO 50001', pattern: /iso[\s-]?50001/i },
  { label: 'CHAS', pattern: /\bchas\b/i },
  { label: 'SafeContractor', pattern: /safe\s?contractor/i },
  { label: 'Constructionline', pattern: /constructionline/i },
  { label: 'SMAS Worksafe', pattern: /\bsmas\b/i },
  { label: 'Acclaim', pattern: /\bacclaim\b/i },
  { label: 'Achilles', pattern: /\bachilles\b|\buvdb\b/i },
  { label: 'Gas Safe', pattern: /gas\s?safe/i },
  { label: 'NICEIC', pattern: /\bniceic\b/i },
  { label: 'NAPIT', pattern: /\bnapit\b/i },
  { label: 'FORS', pattern: /\bfors\b/i },
  { label: 'BES 6001', pattern: /bes[\s-]?6001/i },
  { label: 'PAS 2080', pattern: /pas[\s-]?2080/i },
  { label: 'Considerate Constructors Scheme', pattern: /considerate\s?constructors/i },
];

/** One regex that fires when any recognised certificate is named. */
const NAMES_A_CERTIFICATE = new RegExp(NAMED_CERTIFICATES.map((cert) => `(?:${cert.pattern.source})`).join('|'), 'i');

/** The specific certificates a requirement or matrix line names, in catalogue order. */
function certificatesNamedIn(line: { requirement: string; evidenceRequired: string }): Array<{ label: string; pattern: RegExp }> {
  const text = `${line.requirement} ${line.evidenceRequired}`;
  return NAMED_CERTIFICATES.filter((cert) => cert.pattern.test(text));
}

/**
 * A compliance undertaking: a requirement answered by a statement, not a
 * document or a scored answer.
 *
 * "Comply with CDM 2015", "the tender remains open 90 days", "submit via
 * In-Tend" — there is no certificate to file and no mark to win, only a promise
 * to make. The platform bounced these back as "nothing on file — file the
 * document", which is work handed to a person for a thing no document answers.
 * The agent can draft the confirmation; the person confirms it is true.
 *
 * The test is deliberately conservative: a line is an undertaking only when it
 * names no document or credential to evidence (those are gates), carries no
 * weighting (those are scored questions answered in the submission), and reads
 * as an obligation to comply. A line that fails any of the three is left exactly
 * as it was — the safe direction, because a wrongly-drafted confirmation against
 * a line that actually needed a certificate would hide a real gap.
 */
const UNDERTAKING_EVIDENCE =
  /\b(insurance|certificate|certification|accreditation|accredited|pre-?qualif|polic(?:y|ies)|dbs|evidence of|experience|reference|case stud|track record|turnover|accounts|financial standing|cv|registered with)\b/i;
const UNDERTAKING_OBLIGATION =
  /\b(confirm|comply|complies|compliance|adhere|meet|meets|undertake|undertaking|nominate|appoint|remain open|maintain|ensure|sent via|send[^.]*via|submit|provide[^.]*(?:notice|minimum))\b/i;

function draftUndertaking(obligation: string): string {
  const clean = String(obligation ?? '').replace(/\s+/g, ' ').trim();
  return `We confirm that, if awarded this contract, we will meet this requirement in full: “${clean}”.`;
}

/**
 * Classify one requirement, and where it is an undertaking, draft the
 * confirmation. A pure function so the matrix read, the confirm command and the
 * tests all decide it the same way.
 */
export function undertakingFor(requirement: {
  requirement: string;
  evidenceRequired: string;
  weightingPercent?: number;
}): { isUndertaking: boolean; statement: string } {
  if (requirement.weightingPercent !== undefined) return { isUndertaking: false, statement: '' };
  const text = `${requirement.requirement} ${requirement.evidenceRequired}`;
  if (UNDERTAKING_EVIDENCE.test(text)) return { isUndertaking: false, statement: '' };
  if (!UNDERTAKING_OBLIGATION.test(text)) return { isUndertaking: false, statement: '' };
  return { isUndertaking: true, statement: draftUndertaking(requirement.evidenceRequired?.trim() || requirement.requirement) };
}

/** One confirmed undertaking, held on the analysis record. */
export type UndertakingGiven = {
  reference: string;
  requirement: string;
  statement: string;
  confirmedBy: string;
  confirmedAt: string;
};

function undertakingsOf(record: EntityRecord): UndertakingGiven[] {
  return ((record.state as Record<string, unknown>).undertakings as UndertakingGiven[] | undefined) ?? [];
}

/**
 * What the platform can evidence without being asked.
 *
 * Deliberately short. A probe that guesses is worse than no probe, because a
 * matrix line marked satisfied is a line nobody checks again.
 */
const PROBES: EvidenceProbe[] = [
  // The specific named certificate, ahead of the general accreditation probe, so
  // a line naming ISO 14001 is answered by ISO 14001 rather than by the list.
  {
    match: NAMES_A_CERTIFICATE,
    find: (profile, requirement) => {
      const named = certificatesNamedIn(requirement);
      if (named.length === 0) return null;
      const held = named.filter((cert) => profile.accreditations.some((entry) => cert.pattern.test(entry)));
      // Satisfied only when every certificate the line names is on file. A line
      // that names two and holds one is a gap, not a pass.
      return held.length === named.length ? `Held: ${held.map((cert) => cert.label).join(', ')}` : null;
    },
  },
  {
    match: /employer'?s liability|public liability|professional indemnity|contract works/i,
    find: (p) => {
      const held = p.insurances.map((i) => `${i.type} ${(i.limitMinor / 100).toLocaleString('en-GB')}`);
      return held.length > 0 ? `Policies on file: ${held.join('; ')}` : null;
    },
  },
  {
    // The general case — "a recognised accreditation" with no specific scheme
    // named. A named one is caught by the probe above; this answers the rest
    // from the whole list, which is the right answer to a requirement that asks
    // for any accreditation rather than a particular one.
    match: /accreditation|accredited|pre-?qualif/i,
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
  /** Carried from the requirement, so the pack that answers it inherits it. */
  responseLimit?: ResponseLimit;
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
  /**
   * A clause making payment conditional on the payer being paid by somebody
   * else — "pay when paid", "pay if paid", or the same idea written round the
   * houses as a condition precedent on an upstream certificate.
   *
   * Worth a flag of its own rather than a line in `other` because the law has
   * already decided it: section 113 of the Construction Act makes it
   * ineffective, and a bidder who prices for the risk is pricing for a risk
   * they do not carry.
   */
  paymentConditionalOnThirdParty?: boolean;
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
  /**
   * Which kind of exposure that figure is, and it is required wherever there is
   * one.
   *
   * Retention is `CASH`: money the business funds and gets back later, or does
   * not. A performance bond is `CAPACITY`: bonding facility committed, finite
   * and shared across every live job, and not cash going anywhere. They are
   * different quantities and adding them together produces a number that is
   * neither.
   *
   * This exists because the totals used to be accumulated by hand as the terms
   * were built, at two of the three places a term carries an exposure — and a
   * reader could not tell whether the third was excluded on purpose or
   * forgotten. It was on purpose. Now the rule is on the term, the totals are
   * derived from it, and a fourth term that carries a figure has to say which
   * kind it is rather than silently landing in one total or neither.
   */
  exposureKind?: 'CASH' | 'CAPACITY';
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
  /** Cash the business funds across the terms that carry a figure. */
  quantifiedExposureMinor: number;
  /**
   * Bonding and guarantee capacity committed, which is not cash and is not
   * added to it. Reported separately rather than dropped: it is finite, it is
   * shared across every live job, and a bid decision needs it.
   */
  committedCapacityMinor: number;
  /** Questions that should go to the buyer before the return date. */
  clarifications: string[];
  readyToPrice: boolean;
};

const gbp = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

/**
 * The declared evaluation weightings, per category.
 *
 * Derived from the matrix lines rather than from the requirements they were
 * built out of, so the figure a reader is shown weeks later is arrived at the
 * same way as the figure the analyst was shown on the day. The alternative —
 * computing it once at analysis and again, differently, on read — is two
 * sources of truth for whether the buyer's marking scheme adds up.
 */
function declaredWeightings(
  lines: ReadonlyArray<{ category: RequirementCategory; weightingPercent?: number }>,
): Array<{ category: RequirementCategory; percent: number }> {
  const declared = new Map<RequirementCategory, number>();
  for (const line of lines) {
    if (line.weightingPercent === undefined) continue;
    declared.set(line.category, (declared.get(line.category) ?? 0) + line.weightingPercent);
  }
  return [...declared.entries()].map(([category, percent]) => ({ category, percent }));
}

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
    const held = probe?.find(profile, requirement) ?? null;

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
      responseLimit: requirement.responseLimit,
    };
  });

  const mandatoryGaps = matrix.filter((line) => line.mandatory && line.status === 'GAP');

  // --- Weightings -----------------------------------------------------------
  const declared = declaredWeightings(matrix);
  const statedTotal = declared.reduce((sum, entry) => sum + entry.percent, 0);

  // --- Commercial terms -----------------------------------------------------
  const terms: TermAssessment[] = [];
  const bars: string[] = [];
  const clarifications: string[] = [];

  const { liquidatedDamages: lads } = input.terms;
  if (lads) {
    // The honest exposure is the cap where there is one, and the whole
    // programme where there is not — because uncapped means uncapped.
    const cappedMinor = lads.capPercent !== undefined ? Math.round(input.estimatedValueMinor * (lads.capPercent / 100)) : undefined;
    const uncappedOverRun = lads.perWeekMinor * input.durationWeeks;
    const exposure = cappedMinor ?? uncappedOverRun;

    terms.push({
      term: 'Liquidated damages',
      stated: `${gbp(lads.perWeekMinor)} per week${lads.capPercent !== undefined ? `, capped at ${lads.capPercent}%` : ', uncapped'}`,
      assessment:
        lads.capPercent === undefined
          ? `Uncapped. Ten weeks late is ${gbp(lads.perWeekMinor * 10)}, which is ${(marginMinor > 0 ? (lads.perWeekMinor * 10) / marginMinor : 0).toFixed(1)}× the expected margin. An uncapped damages clause on a programme the contractor does not fully control is the single most common way a profitable job becomes a loss.`
          : `Capped at ${gbp(cappedMinor!)}, which is ${(marginMinor > 0 ? cappedMinor! / marginMinor : 0).toFixed(1)}× the expected margin of ${gbp(marginMinor)}.`,
      severity: lads.capPercent === undefined ? 'SEVERE' : cappedMinor! > marginMinor ? 'MATERIAL' : 'ROUTINE',
      exposureMinor: exposure,
      exposureKind: 'CASH',
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
      // Facility committed, not money spent.
      exposureKind: 'CAPACITY',
    });
  }

  if (input.terms.retentionPercent !== undefined) {
    const retentionMinor = Math.round(input.estimatedValueMinor * (input.terms.retentionPercent / 100));
    terms.push({
      term: 'Retention',
      stated: `${input.terms.retentionPercent}%`,
      assessment: `${gbp(retentionMinor)} withheld, typically half released at completion and half after the defects period. This is cash the business funds, not a discount, and the second half is often years away.`,
      severity: retentionMinor > marginMinor ? 'MATERIAL' : 'ROUTINE',
      exposureMinor: retentionMinor,
      exposureKind: 'CASH',
    });
  }

  if (input.terms.paymentConditionalOnThirdParty) {
    // Section 113 of the Housing Grants, Construction and Regeneration Act
    // 1996. A clause making payment conditional on the payer receiving payment
    // from a third party is ineffective — with one exception, which is that
    // third party's insolvency.
    //
    // This is stated as a *term assessment* rather than a bar, and deliberately.
    // The clause does not stop the bid and does not need negotiating out to
    // make the job safe: it is already void. What it does is tell the bidder
    // something about the buyer, and stop them pricing a cash risk they do not
    // carry — which is the expensive mistake, because the money is priced in
    // and the competitor who read the Act does not price it.
    terms.push({
      term: 'Payment conditional on the buyer being paid',
      stated: 'Pay when paid',
      assessment:
        'Ineffective under section 113 of the Construction Act, except where the third party is insolvent. The ' +
        'obligation to pay does not depend on the buyer being paid, whatever the clause says, and it is not a cash ' +
        'risk to price for. It is worth asking why it is in the document.',
      severity: 'MATERIAL',
    });
    clarifications.push(
      'The payment clause is conditional on the buyer receiving payment from a third party. Section 113 of the ' +
        'Construction Act makes that ineffective except on that party’s insolvency — will the buyer confirm the ' +
        'clause is not relied on, or delete it?',
    );
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

  // Both totals derived from the terms rather than accumulated as they are
  // built. Cash and capacity stay apart — a bond is not money leaving the
  // business — and neither can be silently forgotten, because the term itself
  // states which it is.
  const sumOf = (kind: 'CASH' | 'CAPACITY'): number =>
    orderedTerms.reduce((total, term) => total + (term.exposureKind === kind ? (term.exposureMinor ?? 0) : 0), 0);
  const quantifiedExposureMinor = sumOf('CASH');
  const committedCapacityMinor = sumOf('CAPACITY');

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
      committedCapacityMinor,
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
    weightings: { stated: statedTotal, declared, complete: statedTotal === 100 },
    terms: orderedTerms,
    bars,
    quantifiedExposureMinor,
    committedCapacityMinor,
    clarifications,
    readyToPrice,
  };
}

// --- Reading one back --------------------------------------------------------

/**
 * A matrix produced, and then unreachable.
 *
 * `analyseITT` wrote a full compliance matrix to the ledger and handed it back
 * in the response body, and that was the only time anybody could see it. Close
 * the tab and the analysis existed, was hashed into the chain, woke the tender
 * agents — and had no screen. The bid manager who wants to know on the Monday
 * which mandatory requirement has nothing behind it had to run the analysis
 * again, which spends ACUs to re-derive a record the platform already holds and
 * writes a second `ITT_ANALYSED` event saying the same thing.
 *
 * So the analysis is readable. Two shapes, matching the tender board it sits
 * beside: a summary per analysis for the list, and the whole thing for the one
 * a person opens.
 */

/** What the stored record carries beyond the analysis itself. */
export type StoredITTAnalysis = ITTAnalysis & {
  /** The value and duration the exposure figures were computed against. */
  estimatedValueMinor: number;
  durationWeeks: number;
  analysedAt: string;
  analysedBy: string;
  /** The project the analysis was run on, which is the tender's own project. */
  projectId: string;
};

export type ITTAnalysisSummary = {
  analysisId: string;
  reference: string;
  clientName: string;
  returnBy: string;
  requirements: number;
  mandatoryGaps: number;
  bars: number;
  clarifications: number;
  quantifiedExposureMinor: number;
  /** The worst severity anywhere in the terms, so a list can be read at a glance. */
  worstTerm?: TermAssessment['severity'];
  readyToPrice: boolean;
  analysedAt: string;
  projectId: string;
};

/**
 * Rebuild the analysis from what was committed.
 *
 * The stored state is not quite the returned shape: `mandatoryGaps` is written
 * as references rather than whole lines, and `weightings.declared` is not
 * written at all. Both are re-derived here from the matrix, which is the record
 * that carries them — rather than widening the event, which would change the
 * shape of a record that already verifies and would not help the analyses
 * already written.
 */
function readAnalysis(record: EntityRecord): StoredITTAnalysis {
  const state = record.state as Record<string, unknown>;
  const matrix = (state.matrix as MatrixLine[] | undefined) ?? [];
  const declared = declaredWeightings(matrix);
  const stated = declared.reduce((sum, entry) => sum + entry.percent, 0);

  return {
    analysisId: String(state.id ?? record.refId),
    reference: String(state.reference ?? ''),
    clientName: String(state.clientName ?? ''),
    returnBy: String(state.returnBy ?? ''),
    matrix,
    // Derived from the matrix by the same rule `analyseITT` applies, so a line
    // that is a mandatory gap on the day is a mandatory gap on the read.
    mandatoryGaps: matrix.filter((line) => line.mandatory && line.status === 'GAP'),
    weightings: { stated, declared, complete: stated === 100 },
    terms: (state.terms as TermAssessment[] | undefined) ?? [],
    bars: (state.bars as string[] | undefined) ?? [],
    quantifiedExposureMinor: Number(state.quantifiedExposureMinor ?? 0),
    // Re-derived for an analysis written before capacity was reported
    // separately, rather than defaulting to zero — a stored record from that
    // era carries the bond on its term and would otherwise read as no bonding
    // committed at all.
    committedCapacityMinor:
      state.committedCapacityMinor === undefined
        ? ((state.terms as TermAssessment[] | undefined) ?? []).reduce(
            (total, term) => total + (term.exposureKind === 'CAPACITY' ? (term.exposureMinor ?? 0) : 0),
            0,
          )
        : Number(state.committedCapacityMinor),
    clarifications: (state.clarifications as string[] | undefined) ?? [],
    readyToPrice: Boolean(state.readyToPrice),
    estimatedValueMinor: Number(state.estimatedValueMinor ?? 0),
    durationWeeks: Number(state.durationWeeks ?? 0),
    analysedAt: String(state.analysedAt ?? ''),
    analysedBy: String(state.analysedBy ?? ''),
    projectId: record.projectId,
  };
}

const SEVERITY_RANK: Record<TermAssessment['severity'], number> = { BAR: 0, SEVERE: 1, MATERIAL: 2, ROUTINE: 3 };

/** Every compliance matrix this tenancy holds, most recent first. */
export function analysisBoard(ctx: EngineContext): { analyses: ITTAnalysisSummary[]; summary: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  // Analyses are written against the tender's own project rather than the
  // governance scope, so this crosses projects within the tenancy — which is
  // what a bid manager holding four live tenders is asking for.
  const analyses = ctx.ledger
    .listByTenant(ctx.tenantId, 'ITTAnalysis')
    .map((record) => readAnalysis(record))
    .map((analysis): ITTAnalysisSummary => {
      const worst = [...analysis.terms].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])[0];
      return {
        analysisId: analysis.analysisId,
        reference: analysis.reference,
        clientName: analysis.clientName,
        returnBy: analysis.returnBy,
        requirements: analysis.matrix.length,
        mandatoryGaps: analysis.mandatoryGaps.length,
        bars: analysis.bars.length,
        clarifications: analysis.clarifications.length,
        quantifiedExposureMinor: analysis.quantifiedExposureMinor,
        ...(worst ? { worstTerm: worst.severity } : {}),
        readyToPrice: analysis.readyToPrice,
        analysedAt: analysis.analysedAt,
        projectId: analysis.projectId,
      };
    })
    .sort((a, b) => b.analysedAt.localeCompare(a.analysedAt));

  const blocked = analyses.filter((a) => !a.readyToPrice).length;
  const summary =
    analyses.length === 0
      ? 'No invitation has been analysed yet. Record an ITT and run the analysis to build a compliance matrix.'
      : `${analyses.length} compliance matri${analyses.length === 1 ? 'x' : 'ces'} on file` +
        `${blocked > 0 ? `, ${blocked} not ready to price` : ', all ready to price'}.`;

  return { analyses, summary };
}

/** One compliance matrix, whole. */
export function complianceMatrix(ctx: EngineContext, analysisId: string): StoredITTAnalysis {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.get({ refType: 'ITTAnalysis', refId: analysisId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('ITT_ANALYSIS_NOT_FOUND', `No compliance matrix ${analysisId}`, 404);
  }
  return readAnalysis(record);
}

/**
 * A question the analysis raised, in the structured form the clarification
 * register needs — so the AI's own questions can be put to the client in one
 * act, rather than retyped into a delimited box by a person who has no way to
 * know the format.
 */
export type TenderClarificationDraft = {
  side: 'CLIENT';
  subject: string;
  question: string;
  links: { scopeItem?: string; document?: string };
};

const truncate = (text: string, n = 80): string => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/**
 * Turn the "Questions for the buyer" an analysis produced into raisable
 * clarifications. It invents nothing — the questions are the analysis's own:
 *  - every mandatory requirement nothing on file satisfies, linked to that
 *    requirement so the answer is findable against it;
 *  - the commercial-term and weighting questions, carried verbatim and linked
 *    to the invitation.
 * Each carries a link, which is what the register requires and what a plain
 * paste into the batch box never had.
 */
export function tenderClarificationDrafts(analysis: StoredITTAnalysis): TenderClarificationDraft[] {
  const drafts: TenderClarificationDraft[] = [];
  const seen = new Set<string>();

  for (const gap of analysis.mandatoryGaps) {
    const question = `Please confirm the requirement "${gap.requirement}" and the evidence or limit that will satisfy it — nothing on file currently does.`;
    if (seen.has(question)) continue;
    seen.add(question);
    drafts.push({ side: 'CLIENT', subject: truncate(gap.requirement), question, links: { scopeItem: gap.reference } });
  }

  for (const clarification of analysis.clarifications) {
    // The gap questions above are the ones that end this way; do not raise them twice.
    if (/nothing on file to satisfy this\.?$/i.test(clarification)) continue;
    if (seen.has(clarification)) continue;
    seen.add(clarification);
    const subject = clarification.includes(':') ? truncate(clarification.slice(0, clarification.indexOf(':'))) : truncate(clarification);
    drafts.push({ side: 'CLIENT', subject, question: clarification, links: { document: `${analysis.reference || 'Invitation'}` } });
  }

  return drafts;
}

// --- Matching held evidence to the requirements -------------------------------
//
// The matrix says what the buyer wants and what the company profile proves. It
// does not read the evidence register — the documents and claims the business
// has actually filed — so a certificate on file that answers a requirement was
// invisible to the matrix, and linking a claim to the requirement it covers was
// a job somebody did by memory. This reads the register against the matrix and
// says, per requirement, what already covers it and what held evidence could.
//
// It proposes; it never links and never invents. A suggestion is "you hold this,
// consider linking it" — the link itself is still an authored act (`assertClaim`
// with `covers`), because a claim answering a requirement is a sentence the
// business puts to a buyer, not a match a function makes on its behalf.

/** Which kinds of claim can plausibly answer which category of requirement. */
const CATEGORY_CLAIM_KINDS: Record<RequirementCategory, ClaimKind[]> = {
  QUALIFICATION: ['ACCREDITATION', 'CERTIFICATE', 'FINANCIAL', 'REFERENCE'],
  TECHNICAL: ['METHOD', 'CASE_STUDY', 'CV', 'CALCULATION', 'TEST_RESULT'],
  COMMERCIAL: ['FINANCIAL'],
  INSURANCE: ['INSURANCE'],
  HEALTH_AND_SAFETY: ['ACCREDITATION', 'CERTIFICATE', 'POLICY', 'METHOD'],
  QUALITY: ['ACCREDITATION', 'CERTIFICATE', 'TEST_RESULT', 'POLICY'],
  ENVIRONMENTAL: ['ACCREDITATION', 'CERTIFICATE', 'POLICY'],
  SOCIAL_VALUE: ['KPI', 'CASE_STUDY', 'POLICY'],
  PROGRAMME: ['METHOD', 'CASE_STUDY'],
  SUBMISSION: [],
};

export type EvidenceMatch = {
  claimId: string;
  reference: string;
  kind: ClaimKind;
  claim: string;
  standing: ClaimStanding;
  expiresAt?: string;
  /** Why it was suggested: the claim's kind fits the category, or it names the same certificate. */
  because: 'KIND' | 'NAMED_CERTIFICATE' | 'LINKED';
};

export type RequirementCoverage = {
  reference: string;
  requirement: string;
  category: RequirementCategory;
  evidenceRequired: string;
  mandatory: boolean;
  /** The mark at stake where the requirement is scored rather than pass/fail. */
  weightingPercent?: number;
  /** The stored matrix status, from the company-profile probes. */
  matrixStatus: MatrixStatus;
  /** Claims the business has explicitly linked to this requirement. */
  linked: EvidenceMatch[];
  /** Held claims that could cover it but are not linked yet. */
  suggested: EvidenceMatch[];
  /** Where the requirement is a compliance undertaking, the drafted confirmation. */
  undertaking?: string;
  /**
   * What to do about this line:
   *  COVERED           — a current, approved linked claim answers it (or an undertaking confirmed)
   *  PROFILE           — proven from the company profile, no document needed here
   *  ATTENTION         — a linked claim is pending or has lapsed
   *  LINK_SUGGESTED    — nothing linked, but held evidence could be
   *  UNDERTAKING       — a compliance statement to confirm, drafted and awaiting confirmation
   *  MISSING           — the buyer asked for evidence and nothing held answers it
   *  NO_EVIDENCE_ASKED — the requirement names no evidence to hold
   */
  disposition: 'COVERED' | 'PROFILE' | 'ATTENTION' | 'LINK_SUGGESTED' | 'UNDERTAKING' | 'MISSING' | 'NO_EVIDENCE_ASKED';
};

/**
 * One document to attach when submitting to the client portal.
 *
 * De-duplicated across the matrix: a single certificate that answers three
 * requirements is one line here, carrying all three references — the submission
 * is a set of files, not a file per requirement.
 */
export type AttachItem = {
  claimId: string;
  reference: string;
  kind: ClaimKind;
  claim: string;
  standing: ClaimStanding;
  expiresAt?: string;
  /** Every requirement this document answers, linked or proposed. */
  covers: string[];
  /** Of `covers`, the references already linked to this claim. */
  linkedRefs: string[];
  /** Of `covers`, the references only proposed — confirm the match before relying on it. */
  suggestedRefs: string[];
};

/**
 * One requirement to resolve in the library before the bid can be submitted.
 * `MISSING` — nothing on file answers it; `LAPSED` — the only evidence has
 * expired or was rejected, so a current one must be obtained.
 */
export type ObtainItem = {
  reference: string;
  requirement: string;
  category: RequirementCategory;
  evidenceRequired: string;
  mandatory: boolean;
  reason: 'MISSING' | 'LAPSED';
};

export type EvidenceCoverage = {
  analysisId: string;
  reference: string;
  asAt: string;
  requirements: RequirementCoverage[];
  covered: number;
  /** Requirements with nothing linked but at least one suggestion. */
  linkSuggested: number;
  /** Requirements that ask for evidence and have nothing held to answer them. */
  missing: number;
  /** Linked claims that are pending or lapsed. */
  attention: number;
  /**
   * The two action lists the register and matrix together imply — a projection
   * of `requirements`, inventing nothing.
   *  toAttach — distinct documents to upload to the portal, deduped.
   *  toObtain — requirements nothing current answers, mandatory first.
   */
  toAttach: AttachItem[];
  toObtain: ObtainItem[];
  /**
   * Compliance undertakings — the lines answered by a statement rather than a
   * document. Each carries the drafted confirmation and whether it is confirmed.
   */
  undertakings: Array<{ reference: string; requirement: string; statement: string; confirmed: boolean }>;
  summary: string;
};

/**
 * Read the evidence register against a compliance matrix and say, per
 * requirement, what covers it and what held evidence could.
 */
export function evidenceCoverage(ctx: EngineContext, analysisId: string, asAt?: string): EvidenceCoverage {
  // `complianceMatrix` and `evidenceRegister` both authorise ESTIMATE_TENDER R
  // at COMMERCIAL_L3; reusing them keeps one authorisation rule, not a third.
  const analysis = complianceMatrix(ctx, analysisId);
  const day = asAt ?? new Date().toISOString().slice(0, 10);
  const register = evidenceRegister(ctx, day);
  const current = register.claims.filter((claim) => claim.standing !== 'REJECTED' && claim.standing !== 'EXPIRED');
  // Compliance undertakings confirmed on this analysis, read the same way the
  // waiver register reads waivers — off the analysis record's own state.
  const confirmedUndertakings = new Set(undertakingsOf(requireAnalysis(ctx, analysisId)).map((u) => u.reference));

  const requirements: RequirementCoverage[] = analysis.matrix.map((line) => {
    const undertaking = undertakingFor(line);
    const linked: EvidenceMatch[] = register.claims
      .filter((claim) => claim.covers.includes(line.reference))
      .map((claim) => ({
        claimId: claim.id,
        reference: claim.reference,
        kind: claim.kind,
        claim: claim.claim,
        standing: claim.standing,
        expiresAt: claim.expiresAt,
        because: 'LINKED' as const,
      }));

    const linkedIds = new Set(linked.map((entry) => entry.claimId));
    const kinds = CATEGORY_CLAIM_KINDS[line.category] ?? [];
    const namedCerts = certificatesNamedIn(line);

    const suggested: EvidenceMatch[] = [];
    if (line.evidenceRequired) {
      for (const claim of current) {
        if (linkedIds.has(claim.id)) continue;
        const namesSameCert =
          namedCerts.length > 0 &&
          namedCerts.some((cert) => cert.pattern.test(`${claim.reference} ${claim.claim}`));
        const kindFits = kinds.includes(claim.kind);
        if (!namesSameCert && !kindFits) continue;
        suggested.push({
          claimId: claim.id,
          reference: claim.reference,
          kind: claim.kind,
          claim: claim.claim,
          standing: claim.standing,
          expiresAt: claim.expiresAt,
          // A shared certificate name is the stronger reason, so it wins the label.
          because: namesSameCert ? 'NAMED_CERTIFICATE' : 'KIND',
        });
      }
    }

    const hasCurrentLink = linked.some((entry) => entry.standing === 'APPROVED');
    const hasStaleLink = linked.length > 0 && !hasCurrentLink;
    // An undertaking is answered by a confirmed statement, not a document: a
    // confirmed one is covered, an unconfirmed one is a drafted statement
    // awaiting confirmation — ahead of the profile/claim dispositions, which do
    // not apply to it. A held claim or profile match still wins first, so an
    // undertaking line that somehow also has evidence is not hidden.
    const disposition: RequirementCoverage['disposition'] = !line.evidenceRequired
      ? 'NO_EVIDENCE_ASKED'
      : hasCurrentLink
        ? 'COVERED'
        : hasStaleLink
          ? 'ATTENTION'
          : line.status === 'SATISFIED'
            ? 'PROFILE'
            : undertaking.isUndertaking
              ? confirmedUndertakings.has(line.reference)
                ? 'COVERED'
                : 'UNDERTAKING'
              : suggested.length > 0
                ? 'LINK_SUGGESTED'
                : 'MISSING';

    return {
      reference: line.reference,
      requirement: line.requirement,
      category: line.category,
      evidenceRequired: line.evidenceRequired,
      mandatory: line.mandatory,
      weightingPercent: line.weightingPercent,
      matrixStatus: line.status,
      linked,
      suggested,
      ...(undertaking.isUndertaking ? { undertaking: undertaking.statement } : {}),
      disposition,
    };
  });

  const covered = requirements.filter((r) => r.disposition === 'COVERED' || r.disposition === 'PROFILE').length;
  const linkSuggested = requirements.filter((r) => r.disposition === 'LINK_SUGGESTED').length;
  const missing = requirements.filter((r) => r.disposition === 'MISSING').length;
  const attention = requirements.filter((r) => r.disposition === 'ATTENTION').length;

  // The two action lists, derived from the requirements above. A document is
  // attachable when it exists on the register and is not spent — APPROVED
  // (ready) or PENDING (filed, still to verify); an EXPIRED or REJECTED claim is
  // not something to send. A requirement nothing attachable answers is one to
  // resolve in the library first. A PROFILE line needs no document here.
  const attach = new Map<string, AttachItem>();
  const toObtain: ObtainItem[] = [];
  for (const r of requirements) {
    // An undertaking is confirmed with a statement, not a document, so it sits
    // in neither list — it belongs to the undertakings section below.
    if (!r.evidenceRequired || r.disposition === 'PROFILE' || r.disposition === 'UNDERTAKING') continue;
    const answering = [...r.linked, ...r.suggested];
    const attachable = answering.filter((c) => c.standing === 'APPROVED' || c.standing === 'PENDING');
    for (const c of attachable) {
      let item = attach.get(c.claimId);
      if (!item) {
        item = {
          claimId: c.claimId,
          reference: c.reference,
          kind: c.kind,
          claim: c.claim,
          standing: c.standing,
          expiresAt: c.expiresAt,
          covers: [],
          linkedRefs: [],
          suggestedRefs: [],
        };
        attach.set(c.claimId, item);
      }
      if (!item.covers.includes(r.reference)) item.covers.push(r.reference);
      const linkedHere = r.linked.some((l) => l.claimId === c.claimId);
      if (linkedHere) {
        if (!item.linkedRefs.includes(r.reference)) item.linkedRefs.push(r.reference);
      } else if (!item.suggestedRefs.includes(r.reference)) {
        item.suggestedRefs.push(r.reference);
      }
    }
    // "Add to the library" is for the pass/fail evidence gates a document
    // answers — insurances, accreditations, DBS, policies, references. A scored
    // question (a weighting at stake) is answered in the submission itself, not
    // filed as library evidence, and a SUBMISSION-category line is a process
    // instruction to follow, not a document to obtain. Both are excluded so the
    // list is the evidence to go and get, not the questions to go and answer.
    const isEvidenceGate = r.category !== 'SUBMISSION' && r.weightingPercent === undefined;
    if (attachable.length === 0 && isEvidenceGate) {
      // Nothing usable answers it: either nothing was ever held (MISSING) or
      // what was held is expired/rejected and must be replaced (LAPSED).
      toObtain.push({
        reference: r.reference,
        requirement: r.requirement,
        category: r.category,
        evidenceRequired: r.evidenceRequired,
        mandatory: r.mandatory,
        reason: answering.length === 0 ? 'MISSING' : 'LAPSED',
      });
    }
  }
  const toAttach = [...attach.values()].sort((a, b) => a.reference.localeCompare(b.reference));
  // Mandatory first — those end the bid if still open on the day — then by ref.
  toObtain.sort((a, b) => (a.mandatory === b.mandatory ? a.reference.localeCompare(b.reference) : a.mandatory ? -1 : 1));

  // The compliance undertakings — drafted by the platform, confirmed by a person.
  const undertakings = requirements
    .filter((r) => r.undertaking)
    .map((r) => ({
      reference: r.reference,
      requirement: r.requirement,
      statement: r.undertaking!,
      confirmed: confirmedUndertakings.has(r.reference),
    }));
  const undertakingsPending = undertakings.filter((u) => !u.confirmed).length;

  const summary =
    `${covered} of ${requirements.length} requirement(s) covered` +
    (linkSuggested > 0 ? `, ${linkSuggested} with held evidence to link` : '') +
    (attention > 0 ? `, ${attention} with evidence pending or lapsed` : '') +
    (undertakingsPending > 0 ? `, ${undertakingsPending} undertaking(s) to confirm` : '') +
    (missing > 0 ? `, ${missing} with nothing on file` : '') +
    '.';

  return {
    analysisId,
    reference: analysis.reference,
    asAt: day,
    requirements,
    covered,
    linkSuggested,
    missing,
    attention,
    toAttach,
    toObtain,
    undertakings,
    summary,
  };
}

/**
 * Confirm the compliance undertakings on an analysis — the lines answered by a
 * statement, not a document.
 *
 * The agent drafts each confirmation (`undertakingFor`); this records that a
 * person has confirmed it is true, which is the act that turns a drafted
 * statement into a commitment the business stands behind. It is the 95/5 split
 * the platform exists for: the drafting is the agent's, the truth of it is a
 * person's, and the platform never confirms on the company's behalf.
 *
 * Idempotent by reference, like the waiver register: an undertaking already
 * confirmed is left as it is, not written twice. With no `references` it
 * confirms every undertaking on the matrix; with a subset it confirms only
 * those. It refuses on a line that is not an undertaking — one that needs a
 * document or carries a weighting is not a thing to confirm with a sentence.
 */
export function confirmUndertakings(
  ctx: EngineContext,
  analysisId: string,
  input: { references?: string[] },
): { confirmed: UndertakingGiven[]; already: number; total: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnalysis(ctx, analysisId);
  const analysis = readAnalysis(record);
  const wanted = input.references && input.references.length > 0 ? new Set(input.references) : null;

  const candidates = analysis.matrix.filter((line) => {
    if (wanted && !wanted.has(line.reference)) return false;
    return undertakingFor(line).isUndertaking;
  });
  if (candidates.length === 0) {
    throw new DomainError(
      'NO_UNDERTAKINGS',
      wanted
        ? 'None of those references is a compliance undertaking — a line that needs a document or carries a weighting is not confirmed with a statement.'
        : 'This matrix has no compliance undertaking to confirm — every line is answered by a document or a scored answer.',
    );
  }

  const held = undertakingsOf(record);
  const heldRefs = new Set(held.map((u) => u.reference));
  const fresh = candidates.filter((line) => !heldRefs.has(line.reference));
  const already = candidates.length - fresh.length;
  if (fresh.length === 0) return { confirmed: [], already, total: candidates.length };

  const now = new Date().toISOString();
  const confirmed: UndertakingGiven[] = fresh.map((line) => ({
    reference: line.reference,
    requirement: line.requirement,
    statement: undertakingFor(line).statement,
    confirmedBy: ctx.auth.actorId,
    confirmedAt: now,
  }));

  // Written against the project the analysis actually lives on, not the caller's
  // current project. The matrix is looked up tenant-wide (requireAnalysis guards
  // the tenant, not the project), so an analysis produced under one project and
  // confirmed from another — which is exactly what happens when the invitation,
  // the matrix and the working project are separate records — would otherwise
  // commit the event under the wrong project and be refused by the ledger's
  // tenant-isolation guard as "Entity belongs to a different tenant or project".
  write(ctx, {
    eventType: 'REQUIREMENT_UNDERTAKEN',
    entity: { refType: 'ITTAnalysis', refId: analysisId },
    projectId: record.projectId,
    nextState: { ...(record.state as Record<string, unknown>), undertakings: [...held, ...confirmed] },
  });

  return { confirmed, already, total: candidates.length };
}

// --- A requirement consciously not answered -----------------------------------------

/**
 * The waiver.
 *
 * ---
 *
 * **The silent event this exists to end.** On every large tender somebody
 * decides not to answer something. The certificate cannot be got in time, the
 * question asks for a reference the business will not give, the schedule wants a
 * figure nobody will commit to. The decision is real, it is made by somebody
 * senior, and it leaves no trace — because *not answered because we decided not
 * to* and *not answered because nobody has got to it* look identical in every
 * system that holds a list of requirements.
 *
 * That is the difference between a considered risk and a missed requirement, and
 * it is invisible right up to the moment the submission is marked down or thrown
 * out. A waiver makes it a record: who decided, why, and until when.
 *
 * ## Four rules, and what each one is for
 *
 * **It is an approval, not an edit.** `ESTIMATE_TENDER` `A` — the same authority
 * that issues the response pack. Deciding a bid will go in without something the
 * buyer asked for is a judgement about what this business is prepared to lose
 * the job over, and it belongs with the person who owns that.
 *
 * **It carries a reason somebody will read in a review.** Not a checkbox. The
 * question after a lost tender is always *why did we not answer question 14*,
 * and "waived" is not an answer to it.
 *
 * **It expires, and never later than the return date.** A waiver is scoped to
 * one submission. An open-ended one is a permanent hole in the compliance matrix
 * that outlives everybody who agreed to it, and a waiver still running after the
 * tender returns is governing nothing.
 *
 * **It cannot be granted over evidence the platform already holds.** A waiver on
 * a satisfied line hides that the line was satisfied, which is worse than the
 * gap it pretends to cover: the next person reads a deliberate omission where
 * there was a complete answer.
 *
 * ## What it deliberately does not do
 *
 * It does not make the bid response pack complete by hiding a section. The pack
 * reads live waivers when it is planned and when it is issued, so a waived
 * deliverable leaves the drafting queue **and is named on the pack as waived**,
 * with its reason. Somebody signing the submission sees what was left out on
 * purpose rather than a checklist that quietly got shorter.
 */
export type RequirementWaiver = {
  /** The matrix line reference this covers. */
  reference: string;
  /** The deliverable, carried so the record reads without the matrix beside it. */
  requirement: string;
  mandatory: boolean;
  reason: string;
  /** Inclusive last day the waiver holds, `YYYY-MM-DD`. Never after the return date. */
  expiresOn: string;
  grantedBy: string;
  grantedAt: string;
  revokedBy?: string;
  revokedAt?: string;
  revokedReason?: string;
};

/** The shortest reason worth reading in a post-tender review. */
const WAIVER_REASON_MIN = 20;

function waiversOf(record: EntityRecord): RequirementWaiver[] {
  return ((record.state as Record<string, unknown>).waivers as RequirementWaiver[] | undefined) ?? [];
}

/** Whether a waiver is in force on a given day. Revoked is never in force. */
export function waiverLive(waiver: RequirementWaiver, asAt: string): boolean {
  if (waiver.revokedAt) return false;
  return waiver.expiresOn >= asAt;
}

/**
 * The references waived on an analysis today.
 *
 * Read by the bid response pack, which is the whole point: a waiver granted
 * after a pack was planned still takes a deliverable out of the outstanding
 * list, and a waiver revoked or expired puts it straight back.
 */
export function liveWaivers(ctx: EngineContext, analysisId: string, asAt?: string): RequirementWaiver[] {
  const record = ctx.ledger.get({ refType: 'ITTAnalysis', refId: analysisId });
  if (!record || record.tenantId !== ctx.tenantId) return [];
  const day = asAt ?? new Date().toISOString().slice(0, 10);
  return waiversOf(record).filter((waiver) => waiverLive(waiver, day));
}

function requireAnalysis(ctx: EngineContext, analysisId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'ITTAnalysis', refId: analysisId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('ITT_ANALYSIS_NOT_FOUND', `No compliance matrix ${analysisId}`, 404);
  }
  return record;
}

/**
 * Waive a requirement, with a name and an end date on it.
 */
export function waiveRequirement(
  ctx: EngineContext,
  analysisId: string,
  input: { reference: string; reason: string; expiresOn: string },
): RequirementWaiver {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnalysis(ctx, analysisId);
  const analysis = readAnalysis(record);
  const line = analysis.matrix.find((entry) => entry.reference === input.reference);
  if (!line) {
    throw new DomainError(
      'REQUIREMENT_NOT_FOUND',
      `${analysis.reference} has no requirement ${input.reference}. A waiver against a reference that is not in the matrix ` +
        'covers nothing and reads as though it covers something.',
      404,
    );
  }

  if (line.status === 'SATISFIED') {
    throw new DomainError(
      'REQUIREMENT_ALREADY_SATISFIED',
      `${input.reference} is already satisfied${line.evidenceHeld ? ` — ${line.evidenceHeld}` : ''}. Waiving it would record a ` +
        'deliberate omission where there is a complete answer, and the next person to read the matrix would believe it.',
    );
  }

  const reason = input.reason.trim();
  if (reason.length < WAIVER_REASON_MIN) {
    throw new DomainError(
      'WAIVER_REASON_REQUIRED',
      `A waiver needs a reason of at least ${WAIVER_REASON_MIN} characters. The question after a lost tender is always why ` +
        'question 14 was not answered, and "waived" is not an answer to it.',
      422,
      [{ field: 'reason', message: `At least ${WAIVER_REASON_MIN} characters` }],
    );
  }

  if (!/^\d{4}-\d{2}-\d{2}/.test(input.expiresOn)) {
    throw new DomainError(
      'WAIVER_EXPIRY_REQUIRED',
      'A waiver needs a date it stops. An open-ended one is a permanent hole in the compliance matrix that outlives ' +
        'everybody who agreed to it.',
      422,
      [{ field: 'expiresOn', message: 'A date, YYYY-MM-DD' }],
    );
  }
  const expiresOn = input.expiresOn.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  if (expiresOn < today) {
    throw new DomainError(
      'WAIVER_EXPIRY_PAST',
      `A waiver expiring ${expiresOn} was over before it was granted.`,
      422,
      [{ field: 'expiresOn', message: `On or after ${today}` }],
    );
  }
  const returnBy = analysis.returnBy.slice(0, 10);
  if (returnBy && expiresOn > returnBy) {
    throw new DomainError(
      'WAIVER_OUTLIVES_TENDER',
      `${analysis.reference} returns on ${returnBy} and this waiver would run to ${expiresOn}. A waiver is scoped to one ` +
        'submission; one still running after the tender returns is governing nothing and will be read as covering the next bid.',
      422,
      [{ field: 'expiresOn', message: `On or before ${returnBy}` }],
    );
  }

  const held = waiversOf(record);
  if (held.some((waiver) => waiver.reference === input.reference && waiverLive(waiver, today))) {
    throw new DomainError(
      'WAIVER_ALREADY_HELD',
      `${input.reference} already carries a live waiver. Revoke it and grant another rather than stacking two, which would ` +
        'leave two reasons on the record and no way to tell which one the decision was made on.',
    );
  }

  const waiver: RequirementWaiver = {
    reference: input.reference,
    requirement: line.requirement,
    mandatory: line.mandatory,
    reason,
    expiresOn,
    grantedBy: ctx.auth.actorId,
    grantedAt: new Date().toISOString(),
  };

  // The analysis's own project, not the caller's — same reason as confirmUndertakings.
  write(ctx, {
    eventType: 'REQUIREMENT_WAIVED',
    entity: { refType: 'ITTAnalysis', refId: analysisId },
    projectId: record.projectId,
    nextState: { ...(record.state as Record<string, unknown>), waivers: [...held, waiver] },
  });

  return waiver;
}

/**
 * Take a waiver back.
 *
 * The waiver stays on the record with who revoked it and why. A decision
 * somebody reversed is part of the history of the bid, and erasing it would
 * leave a submission whose compliance matrix cannot explain itself.
 */
export function revokeWaiver(
  ctx: EngineContext,
  analysisId: string,
  input: { reference: string; reason: string },
): RequirementWaiver {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnalysis(ctx, analysisId);
  const held = waiversOf(record);
  const today = new Date().toISOString().slice(0, 10);
  const index = held.findIndex((waiver) => waiver.reference === input.reference && waiverLive(waiver, today));
  if (index < 0) {
    throw new DomainError('WAIVER_NOT_FOUND', `No live waiver on ${input.reference}`, 404);
  }

  const reason = input.reason.trim();
  if (!reason) {
    throw new DomainError(
      'REVOCATION_REASON_REQUIRED',
      'Say why the waiver is being taken back. The deliverable becomes outstanding again and whoever owns it needs to know ' +
        'what changed.',
      422,
      [{ field: 'reason', message: 'Required' }],
    );
  }

  const revoked: RequirementWaiver = {
    ...held[index]!,
    revokedBy: ctx.auth.actorId,
    revokedAt: new Date().toISOString(),
    revokedReason: reason,
  };
  const waivers = held.map((waiver, at) => (at === index ? revoked : waiver));

  // The analysis's own project, not the caller's — same reason as confirmUndertakings.
  write(ctx, {
    eventType: 'REQUIREMENT_WAIVER_REVOKED',
    entity: { refType: 'ITTAnalysis', refId: analysisId },
    projectId: record.projectId,
    nextState: { ...(record.state as Record<string, unknown>), waivers },
  });

  return revoked;
}

export type WaiverRegister = {
  analysisId: string;
  reference: string;
  returnBy: string;
  live: RequirementWaiver[];
  /** Expired and revoked, kept because the history of a bid is part of the bid. */
  past: RequirementWaiver[];
  /** Live waivers over mandatory requirements. The number a bid director reads first. */
  mandatoryWaived: number;
  summary: string;
};

/** Every waiver on one matrix, live and past. */
export function waiverRegister(ctx: EngineContext, analysisId: string): WaiverRegister {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnalysis(ctx, analysisId);
  const analysis = readAnalysis(record);
  const today = new Date().toISOString().slice(0, 10);
  const all = waiversOf(record);
  const live = all.filter((waiver) => waiverLive(waiver, today));
  const past = all.filter((waiver) => !waiverLive(waiver, today));
  const mandatoryWaived = live.filter((waiver) => waiver.mandatory).length;

  return {
    analysisId,
    reference: analysis.reference,
    returnBy: analysis.returnBy,
    live,
    past,
    mandatoryWaived,
    summary:
      live.length === 0
        ? past.length === 0
          ? 'Every requirement on this matrix is being answered.'
          : `Nothing waived now. ${past.length} waiver(s) expired or revoked.`
        : `${live.length} requirement(s) waived` +
          (mandatoryWaived > 0 ? `, ${mandatoryWaived} of them mandatory` : '') +
          '. A waived mandatory requirement is a decision to risk the bid, not an omission.',
  };
}
