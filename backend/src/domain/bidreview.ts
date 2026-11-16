import { authorise, type EngineContext } from '../engines/context.ts';
import type { Role } from '../identity/roles.ts';
import { contractReviewForProject } from './contractreview.ts';
import { matrixPosition } from './matrixreview.ts';
import { companyProfile } from './radar.ts';
import { deadlineInForce, type ZonedInstant } from './tenderintake.ts';
import { projectTender, tenderRegister } from './tenderregister.ts';

/**
 * The bid recommendation, and the risks the tender carries.
 *
 * Everything this reads is already on the record: the matrix's pass/fail lines
 * and reviews, the document register, the contract review, the open
 * clarifications, the priced estimate and the funding model. It reads them
 * together and says BID, CONDITIONAL BID, HOLD or NO BID, with the decisive
 * factors, and every condition with an owner, a deadline and what the decision
 * becomes if it is not resolved.
 *
 * It recommends; it never decides. The decision is the existing bid/no-bid
 * decision, taken by a person with the authority named — a recommendation the
 * person goes against is recorded as such there. Thresholds come from the
 * company's own records (its minimum margin, its working capital); where one is
 * not set, it is listed as a decision for management rather than assumed.
 */

export type Recommendation = 'BID' | 'CONDITIONAL_BID' | 'HOLD' | 'NO_BID';
export type FactorArea = 'ELIGIBILITY' | 'SCOPE_CERTAINTY' | 'DELIVERY' | 'CONTRACT' | 'MARGIN' | 'WORKING_CAPITAL';

export type Factor = {
  area: FactorArea;
  finding: string;
  /** What it does to the recommendation. */
  bearing: 'NO_BID' | 'HOLD' | 'CONDITION' | 'CLEAR' | 'NOT_KNOWN';
};

export type Condition = {
  /** Stable across reads, so it can be tracked across the outputs. */
  id: string;
  condition: string;
  owner: Role;
  deadline: string;
  ifUnresolved: string;
};

export type RiskProposal = {
  /** Stable across reads; matched against the register by the source it cites. */
  id: string;
  title: string;
  cause: string;
  category: 'COMMERCIAL' | 'PROGRAMME' | 'REGULATORY' | 'DESIGN';
  allocation: 'CLIENT' | 'CONTRACTOR' | 'SHARED';
  source: string;
  decisionDue?: string;
  /** Already on the risk register, citing the same source. */
  registered: boolean;
};

export type BidReview = {
  recommendation: Recommendation;
  factors: Factor[];
  conditions: Condition[];
  /** Thresholds and inputs the business has not set, which a decision needs. */
  managementDecisions: string[];
  risks: RiskProposal[];
  read: boolean;
  summary: string;
};

const LABEL: Record<Recommendation, string> = {
  BID: 'Bid',
  CONDITIONAL_BID: 'Conditional bid',
  HOLD: 'Hold',
  NO_BID: 'No bid',
};

const slug = (text: string): string =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

export function bidReview(ctx: EngineContext): BidReview {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const { invitation, analysisId, particulars } = projectTender(ctx);
  if (!invitation || !analysisId) {
    return {
      recommendation: 'HOLD',
      factors: [{ area: 'SCOPE_CERTAINTY', finding: 'The tender pack has not been read and confirmed on this project.', bearing: 'HOLD' }],
      conditions: [],
      managementDecisions: [],
      risks: [],
      read: false,
      summary: 'Hold: read the tender pack and confirm it before a recommendation can be made.',
    };
  }

  const profile = companyProfile(ctx);
  const single = profile.singleOwnerBids === true;
  const who = (role: Role): Role => (single ? 'OWNER' : role);
  const issue = invitation.issue as { clarificationDeadline?: ZonedInstant } | undefined;
  const returnDay = deadlineInForce(invitation).local.slice(0, 10);
  const questionsDay = issue?.clarificationDeadline?.local.slice(0, 10) ?? returnDay;
  const qualificationsBarred = particulars?.evaluation?.qualificationsPermitted === false;

  const factors: Factor[] = [];
  const conditions: Condition[] = [];
  const managementDecisions: string[] = [];
  const risks: RiskProposal[] = [];

  // --- Eligibility: the pass/fail lines ---------------------------------------
  const position = matrixPosition(ctx, analysisId);
  const lineOf = new Map(position.lines.map((line) => [line.reference, line]));
  for (const reference of position.gates.cannotMeet) {
    const line = lineOf.get(reference)!;
    factors.push({ area: 'ELIGIBILITY', finding: `${reference} is pass/fail and appears not to be obtainable: ${line.basis}`, bearing: 'NO_BID' });
    risks.push({
      id: `RISK-ELIG-${slug(reference)}`,
      title: `Pass/fail requirement ${reference} cannot be met`,
      cause: line.requirement,
      category: 'REGULATORY',
      allocation: 'CONTRACTOR',
      source: `Matrix ${reference} — ${line.sourceText}`,
      decisionDue: questionsDay,
      registered: false,
    });
  }
  for (const reference of position.gates.needEvidence) {
    const line = lineOf.get(reference)!;
    conditions.push({
      id: `COND-ELIG-${slug(reference)}`,
      condition: `${reference}: ${line.action}`,
      owner: who(line.owner),
      deadline: line.due && line.due < returnDay ? line.due : returnDay,
      ifUnresolved: 'No bid — a pass/fail requirement left unmet fails the bid.',
    });
  }
  if (position.gates.cannotMeet.length === 0 && position.gates.needEvidence.length === 0) {
    factors.push({ area: 'ELIGIBILITY', finding: `Every pass/fail line is met (${position.gates.met.length}).`, bearing: 'CLEAR' });
  } else if (position.gates.cannotMeet.length === 0) {
    factors.push({ area: 'ELIGIBILITY', finding: `${position.gates.needEvidence.length} pass/fail line(s) still need evidence.`, bearing: 'CONDITION' });
  }
  for (const line of position.lines.filter((entry) => !entry.mandatory || !position.gates.needEvidence.includes(entry.reference))) {
    if (line.status === 'CONFLICTING' || line.status === 'ASSUMED' || line.status === 'DECISION_REQUIRED') {
      conditions.push({
        id: `COND-${line.status === 'DECISION_REQUIRED' ? 'DECIDE' : 'REQ'}-${slug(line.reference)}`,
        condition: `${line.reference} (${line.status.toLowerCase().replace('_', ' ')}): ${line.action}`,
        owner: who(line.owner),
        deadline: line.due ?? questionsDay,
        ifUnresolved:
          line.status === 'CONFLICTING'
            ? 'Price and answer on the stricter reading, and record it as an assumption.'
            : line.status === 'ASSUMED'
              ? 'Proceed on the assumption, stated in the bid where qualifications are permitted.'
              : 'The recommendation stands as Hold until it is decided.',
      });
      if (line.status === 'CONFLICTING') {
        risks.push({
          id: `RISK-CONFLICT-${slug(line.reference)}`,
          title: `The documents disagree on ${line.reference}`,
          cause: line.basis,
          category: 'COMMERCIAL',
          allocation: 'SHARED',
          source: `Matrix ${line.reference} — ${line.sourceText}`,
          decisionDue: questionsDay,
          registered: false,
        });
      }
    }
  }

  // --- Scope certainty: the documents and the dates -----------------------------
  const register = tenderRegister(ctx);
  const missingDocuments = [
    ...register.notSupplied.map((entry) => ({ ...entry, why: 'referred to but not supplied' })),
    ...register.listedNotUploaded.map((entry) => ({ ...entry, why: 'listed in the pack but not uploaded' })),
  ];
  for (const document of missingDocuments) {
    factors.push({ area: 'SCOPE_CERTAINTY', finding: `${document.title} is ${document.why}.`, bearing: 'HOLD' });
    conditions.push({
      id: `COND-DOC-${slug(document.title)}`,
      condition: `Obtain ${document.title} from the portal or the buyer, and read it with the pack.`,
      owner: who('QS'),
      deadline: questionsDay,
      ifUnresolved: 'Price on stated assumptions about what it would have said, and record them; ask for it as a clarification.',
    });
    risks.push({
      id: `RISK-DOC-${slug(document.title)}`,
      title: `Priced without ${document.title}`,
      cause: `${document.title} is ${document.why}, so what it says is not in the price or the answers.`,
      category: 'DESIGN',
      allocation: 'CONTRACTOR',
      // Named, not only cited: two missing documents cited to the same ITT are two risks.
      source: `${document.title}, ${document.why} — ${document.source}`,
      decisionDue: questionsDay,
      registered: false,
    });
  }
  for (const conflict of register.conflicts) {
    factors.push({ area: 'SCOPE_CERTAINTY', finding: conflict, bearing: 'HOLD' });
    conditions.push({
      id: `COND-DATE-${slug(conflict)}`,
      condition: `Clarify the dates with the buyer: ${conflict}`,
      owner: who('PLANNER'),
      deadline: questionsDay,
      ifUnresolved: 'Programme to the stricter date and state it.',
    });
  }
  if (position.untraced.length > 0) {
    factors.push({
      area: 'SCOPE_CERTAINTY',
      finding: `${position.untraced.length} requirement(s) could not be found in the documents (${position.untraced.join(', ')}).`,
      bearing: 'CONDITION',
    });
  }
  if (missingDocuments.length === 0 && register.conflicts.length === 0 && position.untraced.length === 0) {
    factors.push({ area: 'SCOPE_CERTAINTY', finding: 'Every listed document is held and read, and the dates agree.', bearing: 'CLEAR' });
  }

  // --- The contract -----------------------------------------------------------
  const contract = contractReviewForProject(ctx);
  for (const row of contract.rows.filter((entry) => entry.severity === 'SEVERE')) {
    factors.push({ area: 'CONTRACT', finding: `${row.title}: ${row.effect}`, bearing: 'CONDITION' });
    conditions.push({
      id: `COND-CONTRACT-${row.topic}`,
      condition: `${row.title} (${row.clause ?? 'clause not numbered'}): ${row.review.map((review) => review.toLowerCase()).join(' and ') || 'commercial'} review accepts it, or the buyer clarifies it.`,
      owner: who(row.review.includes('LEGAL') ? 'OWNER' : 'COMMERCIAL_MANAGER'),
      deadline: questionsDay,
      ifUnresolved: qualificationsBarred
        ? 'No bid, or accept the clause as written: qualified bids are not permitted.'
        : 'Price the risk, or qualify the bid against the clause.',
    });
    risks.push({
      id: `RISK-CONTRACT-${row.topic}`,
      title: `${row.title}: ${row.stated}`,
      cause: row.effect,
      category: 'COMMERCIAL',
      allocation: 'CONTRACTOR',
      source: `Contract ${row.clause ?? row.title} — ${row.sourceText}`,
      decisionDue: questionsDay,
      registered: false,
    });
  }
  const keyNotStated = contract.notStated.filter((entry) => /Check the standard form or ask the buyer/.test(entry.why));
  if (contract.rows.length > 0 && keyNotStated.length > 0) {
    factors.push({
      area: 'CONTRACT',
      finding: `Not stated in the pack: ${keyNotStated.map((entry) => entry.title.toLowerCase()).join(', ')}.`,
      bearing: 'CONDITION',
    });
  }
  if (contract.rows.length === 0) {
    factors.push({ area: 'CONTRACT', finding: 'No contract clause has been read; the contractual exposure is not known.', bearing: 'NOT_KNOWN' });
  } else if (contract.counts.severe === 0) {
    factors.push({ area: 'CONTRACT', finding: `${contract.rows.length} clause(s) read; none severe.`, bearing: 'CLEAR' });
  }

  // --- Open questions to the buyer ---------------------------------------------
  const open = ctx.ledger
    .list(ctx.projectId, 'Clarification')
    .map((record) => record.state)
    .filter((state) => state.side === 'CLIENT' && state.status === 'OPEN');
  for (const question of open) {
    conditions.push({
      id: `COND-${String(question.reference)}`,
      condition: `${String(question.reference)} answered by the buyer: ${String(question.subject)}`,
      owner: who((question.owner as Role | undefined) ?? 'QS'),
      deadline: String(question.responseDeadline ?? questionsDay).slice(0, 10),
      ifUnresolved: question.interimTreatment ? `As priced meanwhile: ${String(question.interimTreatment)}` : 'Proceed on a stated assumption, recorded on the matrix.',
    });
  }

  // --- Margin --------------------------------------------------------------------
  const estimates = ctx.ledger.list(ctx.projectId, 'Estimate').map((record) => record.state);
  const priced = estimates.filter((estimate) => ((estimate.omissions as unknown[] | undefined) ?? []).length === 0).at(-1);
  const minimum = profile.targetMarginPercent?.min;
  if (!priced) {
    factors.push({ area: 'MARGIN', finding: 'The job has not been priced, so the margin cannot be tested.', bearing: 'NOT_KNOWN' });
  } else if (typeof priced.marginPercent !== 'number') {
    factors.push({ area: 'MARGIN', finding: 'The estimate carries no margin figure.', bearing: 'NOT_KNOWN' });
  } else if (minimum === undefined) {
    managementDecisions.push('Set the minimum margin the business will bid at (company facts), so the price can be tested against it.');
    factors.push({ area: 'MARGIN', finding: `Priced at ${priced.marginPercent}% margin; no minimum is set to test it against.`, bearing: 'NOT_KNOWN' });
  } else if (priced.marginPercent < minimum) {
    factors.push({ area: 'MARGIN', finding: `Priced at ${priced.marginPercent}% margin, below the business's minimum of ${minimum}%.`, bearing: 'NO_BID' });
  } else {
    factors.push({ area: 'MARGIN', finding: `Priced at ${priced.marginPercent}% margin, at or above the minimum of ${minimum}%.`, bearing: 'CLEAR' });
  }

  // --- Working capital -------------------------------------------------------------
  const funding = ctx.ledger.list(ctx.projectId, 'FundingModel').map((record) => record.state).at(-1);
  if (!funding) {
    factors.push({ area: 'WORKING_CAPITAL', finding: 'The cash this job needs before it earns has not been modelled.', bearing: 'NOT_KNOWN' });
  } else if (funding.availableWorkingCapitalMinor === undefined || funding.availableWorkingCapitalMinor === null) {
    managementDecisions.push('State the working capital available to this job, so the peak funding requirement can be tested against it.');
    factors.push({
      area: 'WORKING_CAPITAL',
      finding: `Peak funding £${(Number(funding.peakFundingRequirementMinor) / 100).toLocaleString('en-GB')}; available working capital not stated.`,
      bearing: 'NOT_KNOWN',
    });
  } else if (Number(funding.headroomMinor) < 0) {
    factors.push({
      area: 'WORKING_CAPITAL',
      finding: `Peak funding £${(Number(funding.peakFundingRequirementMinor) / 100).toLocaleString('en-GB')} exceeds the working capital available by £${(Math.abs(Number(funding.headroomMinor)) / 100).toLocaleString('en-GB')}.`,
      bearing: 'NO_BID',
    });
  } else {
    factors.push({ area: 'WORKING_CAPITAL', finding: `Peak funding is within the working capital available.`, bearing: 'CLEAR' });
  }

  // --- Delivery capacity: the business's own assessment on qualification ------------
  const opportunity = ctx.ledger
    .listByTenant(ctx.tenantId, 'Opportunity')
    .map((record) => record.state)
    .find((state) => String(state.id) === String(invitation.opportunityId ?? ''));
  const qualification = opportunity?.qualification as { recommendation?: string; score?: number } | undefined;
  if (!qualification) {
    managementDecisions.push('Qualify the opportunity — capacity, relationship, strategic fit — so delivery capacity is assessed, not assumed.');
    factors.push({ area: 'DELIVERY', finding: 'The opportunity has not been qualified, so capacity to deliver is not assessed.', bearing: 'NOT_KNOWN' });
  } else {
    factors.push({
      area: 'DELIVERY',
      finding: `Qualified at ${qualification.score ?? '—'}: ${String(qualification.recommendation ?? '').toLowerCase().replace(/_/g, ' ')}.`,
      bearing: qualification.recommendation === 'NO_BID' ? 'NO_BID' : 'CLEAR',
    });
  }

  // --- The risks already on the register --------------------------------------------
  const registeredSources = new Set(
    ctx.ledger
      .list(ctx.projectId, 'RiskRegisterItem')
      .map((record) => String(record.state.source ?? ''))
      .filter(Boolean),
  );
  for (const risk of risks) risk.registered = registeredSources.has(risk.source);

  const recommendation: Recommendation = factors.some((factor) => factor.bearing === 'NO_BID')
    ? 'NO_BID'
    : factors.some((factor) => factor.bearing === 'HOLD')
      ? 'HOLD'
      : conditions.length > 0 || factors.some((factor) => factor.bearing === 'CONDITION')
        ? 'CONDITIONAL_BID'
        : 'BID';
  const decisive = factors.filter((factor) => factor.bearing === recommendation || (recommendation === 'CONDITIONAL_BID' && factor.bearing === 'CONDITION'));
  const unknown = factors.filter((factor) => factor.bearing === 'NOT_KNOWN').length;

  return {
    recommendation,
    factors,
    conditions,
    managementDecisions,
    risks,
    read: true,
    summary:
      `${LABEL[recommendation]}` +
      (decisive.length > 0 ? `: ${decisive.slice(0, 3).map((factor) => factor.finding).join(' ')}` : '.') +
      (conditions.length > 0 ? ` ${conditions.length} condition(s), each with an owner and a deadline.` : '') +
      (unknown > 0 ? ` ${unknown} factor(s) not yet known.` : ''),
  };
}
