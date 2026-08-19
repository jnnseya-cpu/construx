import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { qualify, type Qualification, type QualificationScores } from './business.ts';
import type { SectorType } from './structure.ts';

/**
 * Tender radar — screening opportunities against what the business actually is.
 *
 * The point is not to find more opportunities. It is to stop reading the ones
 * that were never winnable, which is where most of a small contractor's bid
 * time goes. A portal listing that requires £8m turnover, ISO 14001 and three
 * education references is a decision that takes four seconds if the company's
 * own facts are written down, and half a morning if they are not.
 *
 * Two rules hold the whole module up.
 *
 * **It never asserts anything not in the profile.** Every strength, every
 * mitigation and every eligibility judgement traces to a recorded company fact.
 * The radar can say "no education reference on file"; it cannot say "we have
 * education experience" because that would be inventing the thing a bid is won
 * or disqualified on.
 *
 * **It does not score.** There is already one scoring model — the ten-factor
 * bid/no-bid algorithm — and a radar with its own would be a second opinion
 * that quietly disagrees. The radar produces *suggested* factor scores from
 * evidence and hands them to `qualify()`. A person can move any of them, and
 * the recommendation comes from the same arithmetic every other opportunity
 * gets.
 */

// --- The verified company knowledge base -----------------------------------------

export type InsuranceCover = { type: string; limitMinor: number; expiresOn?: string };

export type CompanyReference = {
  clientName: string;
  projectName: string;
  sector: SectorType;
  valueMinor: number;
  completedYear: number;
  /** Unverified references are held but never used to claim capability. */
  verified: boolean;
};

export type CompanyProfile = {
  legalName: string;
  /** Most recent first. */
  turnoverMinorByYear: number[];
  netAssetsMinor: number;
  /** Cash the business can put behind a job — the same figure the cash model uses. */
  workingCapitalMinor: number;
  /** Towns, cities or counties the business actually operates in. */
  regions: string[];
  sectors: SectorType[];
  /** CPV codes the business is set up to deliver against. */
  cpvCodes: string[];
  valueBandMinor: { min: number; max: number };
  insurances: InsuranceCover[];
  accreditations: string[];
  references: CompanyReference[];
  /** Trades delivered in-house rather than bought. */
  selfDeliveredTrades: string[];
  targetMarginPercent: { min: number; max: number };
  /** Sites the business can run at once, and how many are already committed. */
  capacity: { concurrentProjects: number; committedProjects: number };
};

export type OpportunityRequirements = {
  minimumTurnoverMinor?: number;
  minimumNetAssetsMinor?: number;
  insurances?: Array<{ type: string; minimumLimitMinor: number }>;
  accreditations?: string[];
  /** Sector experience the buyer demands, and how much of it. */
  experience?: Array<{ sector: SectorType; minimumProjects: number; minimumValueMinor?: number }>;
  /** Anything else stated in the notice, carried verbatim. */
  other?: string[];
};

export type OpportunityNotice = {
  reference: string;
  title: string;
  clientName: string;
  region: string;
  sector: SectorType;
  cpvCodes?: string[];
  estimatedValueMinor: number;
  durationWeeks?: number;
  /** Return deadline, so a job nobody can price in time is caught first. */
  deadline: string;
  scope: string;
  requirements?: OpportunityRequirements;
  /** Bidders the buyer expects, where the notice says. */
  estimatedBidders?: number;
  source: string;
};

// --- Screening --------------------------------------------------------------------

export type EligibilityFailure = { requirement: string; reason: string };

export type ScreenedOpportunity = {
  reference: string;
  title: string;
  clientName: string;
  region: string;
  estimatedValueMinor: number;
  durationWeeks?: number;
  deadline: string;
  daysToDeadline: number;
  /**
   * Mandatory requirements the company cannot meet. Any one of these makes the
   * opportunity unwinnable regardless of how attractive it is, which is the
   * whole time saving.
   */
  eligibilityFailures: EligibilityFailure[];
  eligible: boolean;
  /** Facts from the profile that help, each traceable to a recorded fact. */
  strengths: string[];
  risks: string[];
  /** What could be done about each risk, where there is something real to do. */
  mitigations: string[];
  competition: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
  marginTargetPercent: { min: number; max: number; rationale: string };
  /** Suggested factor scores, for the one scoring model to work on. */
  suggestedScores: QualificationScores;
  qualification: Qualification;
};

const DAY_MS = 86_400_000;

/** Case-insensitive containment, because portals and profiles never agree on case. */
const has = (haystack: string[], needle: string): boolean =>
  haystack.some((item) => item.trim().toLowerCase() === needle.trim().toLowerCase());

/** Map a 1–5 judgement onto the scale, clamped, so no branch can produce a 0 or a 6. */
const score = (value: number): number => Math.max(1, Math.min(5, Math.round(value)));

/** Minor units are how the platform stores money and not how anybody reads it. */
const gbp = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Screen one notice against the profile.
 *
 * Pure: no ledger, no clock beyond the date passed in. The whole assessment is
 * a function of two recorded things, so it can be re-run and audited.
 */
export function screenOpportunity(
  profile: CompanyProfile,
  notice: OpportunityNotice,
  today = new Date().toISOString().slice(0, 10),
): ScreenedOpportunity {
  const requirements = notice.requirements ?? {};
  const failures: EligibilityFailure[] = [];
  const strengths: string[] = [];
  const risks: string[] = [];
  const mitigations: string[] = [];

  const latestTurnover = profile.turnoverMinorByYear[0] ?? 0;

  // --- Mandatory pass/fail ---------------------------------------------------
  if (requirements.minimumTurnoverMinor !== undefined && latestTurnover < requirements.minimumTurnoverMinor) {
    failures.push({
      requirement: 'Minimum turnover',
      reason: `Requires ${gbp(requirements.minimumTurnoverMinor)} against our last filed ${gbp(latestTurnover)}`,
    });
  }
  if (requirements.minimumNetAssetsMinor !== undefined && profile.netAssetsMinor < requirements.minimumNetAssetsMinor) {
    failures.push({
      requirement: 'Minimum net assets',
      reason: `Requires ${gbp(requirements.minimumNetAssetsMinor)} against our ${gbp(profile.netAssetsMinor)}`,
    });
  }
  for (const required of requirements.insurances ?? []) {
    const held = profile.insurances.find((i) => i.type.toLowerCase() === required.type.toLowerCase());
    if (!held) {
      failures.push({ requirement: `${required.type} insurance`, reason: 'No policy of this type on file' });
    } else if (held.limitMinor < required.minimumLimitMinor) {
      failures.push({
        requirement: `${required.type} insurance`,
        reason: `Requires ${gbp(required.minimumLimitMinor)} of cover against our ${gbp(held.limitMinor)}`,
      });
    }
  }
  for (const accreditation of requirements.accreditations ?? []) {
    if (!has(profile.accreditations, accreditation)) {
      failures.push({ requirement: accreditation, reason: 'Not held' });
      mitigations.push(
        `${accreditation} is not held. Check whether the buyer accepts an equivalent or a commitment to certify before contract award — many do, and it is worth one email before walking away.`,
      );
    }
  }

  // --- Experience: usually the thing that decides it -------------------------
  const verifiedInSector = profile.references.filter((r) => r.verified && r.sector === notice.sector);
  for (const required of requirements.experience ?? []) {
    const matching = profile.references.filter(
      (r) =>
        r.verified &&
        r.sector === required.sector &&
        (required.minimumValueMinor === undefined || r.valueMinor >= required.minimumValueMinor),
    );
    if (matching.length < required.minimumProjects) {
      // A missing reference is usually a hard fail on a public framework and a
      // soft one on a negotiated job, so it is reported as a failure with a
      // real route round it rather than as a shrug.
      const inSector = profile.references.filter((r) => r.verified && r.sector === required.sector);
      const largest = [...inSector].sort((a, b) => b.valueMinor - a.valueMinor)[0];
      failures.push({
        requirement: `${required.minimumProjects} × ${required.sector} experience${required.minimumValueMinor ? ` at ${gbp(required.minimumValueMinor)}+` : ''}`,
        // Stating the threshold matters: without it this reads as a flat
        // contradiction of the strength line, which counts sector references
        // without applying one.
        reason: required.minimumValueMinor
          ? `${plural(matching.length, 'reference', 'references')} at that value; ${plural(inSector.length, 'verified reference', 'verified references')} in sector, largest ${largest ? gbp(largest.valueMinor) : 'none'}`
          : `${plural(matching.length, 'verified reference', 'verified references')} on file`,
      });
      mitigations.push(
        `Partner or subcontract the ${required.sector.toLowerCase()} package to a firm that holds the reference, and offer named personnel experience separately where the ITT permits it.`,
      );
    }
  }

  // --- Fit, as strengths and risks -------------------------------------------
  const local = has(profile.regions, notice.region);
  if (local) strengths.push(`${notice.region} is inside our operating patch — staff and supply chain travel to it already`);
  else {
    risks.push(`${notice.region} is outside our recorded operating regions`);
    mitigations.push('Price accommodation and travel explicitly, and check the local supply chain before committing.');
  }

  if (profile.sectors.includes(notice.sector)) strengths.push(`${notice.sector} is a sector we deliver in`);
  else risks.push(`${notice.sector} is not a sector on our profile`);

  if (verifiedInSector.length > 0) {
    const best = [...verifiedInSector].sort((a, b) => b.valueMinor - a.valueMinor)[0]!;
    strengths.push(
      `${plural(verifiedInSector.length, 'verified', 'verified')} ${notice.sector} reference${verifiedInSector.length === 1 ? '' : 's'}, largest ${best.projectName} for ${best.clientName} at ${gbp(best.valueMinor)}`,
    );
  } else {
    risks.push(`No verified corporate reference in ${notice.sector}`);
  }

  const inValueBand =
    notice.estimatedValueMinor >= profile.valueBandMinor.min && notice.estimatedValueMinor <= profile.valueBandMinor.max;
  if (inValueBand) strengths.push('Contract value is inside the range we deliver well');
  else if (notice.estimatedValueMinor > profile.valueBandMinor.max) {
    risks.push('Larger than anything on our profile — one job would carry the business');
    mitigations.push('Consider a joint venture, or bid a section of the works if the buyer will split it.');
  } else {
    risks.push('Smaller than our normal range, so the bid cost may not be recovered');
  }

  const cpvMatch = (notice.cpvCodes ?? []).some((code) => has(profile.cpvCodes, code));
  if (cpvMatch) strengths.push('CPV classification matches codes we are set up for');

  const selfDelivered = profile.selfDeliveredTrades.length;
  if (selfDelivered > 0) strengths.push(`${plural(selfDelivered, 'trade', 'trades')} self-delivered rather than bought`);

  const spare = profile.capacity.concurrentProjects - profile.capacity.committedProjects;
  if (spare <= 0) {
    risks.push('No spare delivery capacity — every slot is committed');
    mitigations.push('Check the start date against the projects finishing, and be honest about who would run it.');
  } else if (spare === 1) {
    risks.push('One delivery slot left, so this would take the last of our capacity');
  }

  const daysToDeadline = Math.ceil((Date.parse(notice.deadline) - Date.parse(today)) / DAY_MS);
  if (daysToDeadline < 0) {
    failures.push({ requirement: 'Return deadline', reason: `Closed on ${notice.deadline}` });
  } else if (daysToDeadline < 14) {
    risks.push(`${daysToDeadline} days to the deadline — a compressed bid, with the errors that come with one`);
  }

  // --- Competition and margin ------------------------------------------------
  const competition: ScreenedOpportunity['competition'] =
    notice.estimatedBidders === undefined
      ? 'UNKNOWN'
      : notice.estimatedBidders <= 4
        ? 'LOW'
        : notice.estimatedBidders <= 8
          ? 'MEDIUM'
          : 'HIGH';

  // A crowded field takes margin off the top; a short list and a strong fit
  // carries it. This adjusts the profile's own target rather than inventing one.
  const marginShift = competition === 'HIGH' ? -2 : competition === 'LOW' ? 1 : 0;
  const marginTargetPercent = {
    min: Math.max(0, profile.targetMarginPercent.min + marginShift),
    max: Math.max(0, profile.targetMarginPercent.max + marginShift),
    rationale:
      competition === 'UNKNOWN'
        ? 'The notice does not say how many are bidding, so the standard target stands'
        : `${notice.estimatedBidders} bidders expected — ${competition.toLowerCase()} competition against our standard target`,
  };

  // --- Suggested scores for the one scoring model ----------------------------
  const suggestedScores: QualificationScores = {
    relevantExperience: score(verifiedInSector.length >= 3 ? 5 : verifiedInSector.length === 0 ? 1 : 2 + verifiedInSector.length),
    // Nothing on the profile describes this client, so it is left neutral for a
    // person to set rather than guessed from the client's name.
    clientAttractiveness: 3,
    contractSize: score(inValueBand ? 5 : notice.estimatedValueMinor > profile.valueBandMinor.max ? 2 : 3),
    geography: score(local ? 5 : 2),
    supplyChainCapacity: score(profile.selfDeliveredTrades.length >= 3 ? 4 : 3),
    competition: score(competition === 'LOW' ? 5 : competition === 'MEDIUM' ? 3 : competition === 'HIGH' ? 2 : 3),
    marginOpportunity: score(marginTargetPercent.max >= profile.targetMarginPercent.max ? 4 : 3),
    // Payment terms are not in a portal notice; the cash model answers this
    // properly once there is an estimate, so it is left neutral here.
    cashflowRisk: 3,
    strategicValue: score(profile.sectors.includes(notice.sector) ? 3 : 4),
    winProbability: score(
      (failures.length > 0 ? 1 : 3) + (local ? 1 : 0) + (verifiedInSector.length > 0 ? 1 : 0),
    ),
  };

  return {
    reference: notice.reference,
    title: notice.title,
    clientName: notice.clientName,
    region: notice.region,
    estimatedValueMinor: notice.estimatedValueMinor,
    durationWeeks: notice.durationWeeks,
    deadline: notice.deadline,
    daysToDeadline,
    eligibilityFailures: failures,
    eligible: failures.length === 0,
    strengths,
    risks,
    mitigations,
    competition,
    marginTargetPercent,
    suggestedScores,
    qualification: qualify(suggestedScores),
  };
}

// --- The profile, on the ledger ---------------------------------------------------

function profileProject(ctx: EngineContext): string {
  return `${ctx.tenantId}-governance`;
}

/**
 * Record the company's own facts.
 *
 * Everything the radar and the bid library assert comes from here, so this is
 * the one place a claim about the business can enter the system — and it enters
 * as a governed event with an author, not as a prompt somebody typed.
 */
export function setCompanyProfile(ctx: EngineContext, profile: CompanyProfile): { profileId: string } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U');

  if (profile.turnoverMinorByYear.length === 0) {
    throw new DomainError('PROFILE_INCOMPLETE', 'A company profile needs at least one year of turnover');
  }
  if (profile.valueBandMinor.min > profile.valueBandMinor.max) {
    throw new DomainError('VALUE_BAND_INVALID', 'The minimum contract value is above the maximum');
  }

  const profileId = `${ctx.tenantId}-profile`;
  write(ctx, {
    projectId: profileProject(ctx),
    eventType: 'COMPANY_PROFILE_SET',
    entity: { refType: 'CompanyProfile', refId: profileId },
    nextState: { id: profileId, tenantId: ctx.tenantId, ...profile, recordedBy: ctx.auth.actorId, recordedAt: new Date().toISOString() },
  });

  return { profileId };
}

export function companyProfile(ctx: EngineContext): CompanyProfile {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');

  const record = ctx.ledger.get({ refType: 'CompanyProfile', refId: `${ctx.tenantId}-profile` });
  if (!record) {
    throw new DomainError(
      'COMPANY_PROFILE_NOT_SET',
      'The radar cannot screen anything until the company records its own facts — it will not invent them',
      404,
    );
  }
  return record.state as unknown as CompanyProfile;
}

// --- The morning run ---------------------------------------------------------------

export type RadarRun = {
  runId: string;
  screened: number;
  /** Worth a person's time, best first. */
  shortlist: ScreenedOpportunity[];
  /** Failed a mandatory requirement. Named, because "why not" is the useful part. */
  ineligible: ScreenedOpportunity[];
  /** Eligible but scored below the no-bid threshold. */
  belowThreshold: ScreenedOpportunity[];
  /** Time the run saved, in opportunities nobody has to read. */
  filteredOut: number;
  observations: string[];
};

/**
 * Screen a batch of notices — the morning run.
 *
 * Nothing is registered as an opportunity automatically. The radar decides what
 * is worth reading; a person decides what is worth chasing, and registering an
 * opportunity is the act of deciding to look at it properly.
 */
export function runRadar(
  ctx: EngineContext,
  input: { notices: OpportunityNotice[]; today?: string },
): RadarRun {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');

  const profile = companyProfile(ctx);
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const screened = input.notices.map((notice) => screenOpportunity(profile, notice, today));

  const ineligible = screened.filter((s) => !s.eligible);
  const eligible = screened.filter((s) => s.eligible);
  const belowThreshold = eligible.filter((s) => s.qualification.recommendation === 'NO_BID');
  const shortlist = eligible
    .filter((s) => s.qualification.recommendation !== 'NO_BID')
    .sort((a, b) => b.qualification.score - a.qualification.score || a.daysToDeadline - b.daysToDeadline);

  const runId = ulid();
  const observations: string[] = [];

  if (screened.length === 0) {
    observations.push('Nothing to screen.');
  } else {
    observations.push(
      `${shortlist.length} of ${screened.length} worth reading. ${ineligible.length + belowThreshold.length} filtered out before anybody opened them.`,
    );
  }

  // The most common reason for failing is worth knowing: if every notice fails
  // on the same accreditation, that is a business decision, not a bid decision.
  const reasons = new Map<string, number>();
  for (const item of ineligible) {
    for (const failure of item.eligibilityFailures) {
      reasons.set(failure.requirement, (reasons.get(failure.requirement) ?? 0) + 1);
    }
  }
  const worst = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0];
  if (worst && worst[1] > 1) {
    observations.push(
      `${worst[0]} disqualified us from ${worst[1]} opportunities. That is a decision about the business rather than about any one bid.`,
    );
  }

  const urgent = shortlist.filter((s) => s.daysToDeadline <= 14);
  if (urgent.length > 0) {
    observations.push(`${urgent.length} on the shortlist close within a fortnight: ${urgent.map((u) => u.reference).join(', ')}.`);
  }

  write(ctx, {
    projectId: profileProject(ctx),
    eventType: 'RADAR_RUN_COMPLETED',
    entity: { refType: 'RadarRun', refId: runId },
    nextState: {
      id: runId,
      ranOn: today,
      screened: screened.length,
      shortlisted: shortlist.length,
      ineligible: ineligible.length,
      belowThreshold: belowThreshold.length,
      // The whole assessment is kept: "why did we not bid that" is asked months
      // later, and a run that kept only the shortlist could not answer it.
      results: screened,
      observations,
      ranBy: ctx.auth.actorId,
    },
  });

  return {
    runId,
    screened: screened.length,
    shortlist,
    ineligible,
    belowThreshold,
    filteredOut: ineligible.length + belowThreshold.length,
    observations,
  };
}

export function latestRadarRun(ctx: EngineContext): Record<string, unknown> | undefined {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R');
  const runs = ctx.ledger
    .list(profileProject(ctx), 'RadarRun')
    .filter((r) => r.tenantId === ctx.tenantId)
    .map((r) => r.state)
    .sort((a, b) => String(a.ranOn).localeCompare(String(b.ranOn)));
  return runs.at(-1);
}
