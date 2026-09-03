import { config } from './config.ts';
import type { LifecyclePhase } from './lifecycle/phases.ts';
import { hashEvidence } from './core/canonical.ts';
import * as aidisposition from './domain/aidisposition.ts';
import * as business from './domain/business.ts';
import * as tenderintake from './domain/tenderintake.ts';
import * as itt from './domain/itt.ts';
import * as conceptbrief from './domain/conceptbrief.ts';
import * as conceptcompliance from './domain/conceptcompliance.ts';
import * as conceptcontrols from './domain/conceptcontrols.ts';
import * as conceptduediligence from './domain/conceptduediligence.ts';
import * as conceptinitiation from './domain/conceptinitiation.ts';
import * as conceptoptions from './domain/conceptoptions.ts';
import * as conceptstrategy from './domain/conceptstrategy.ts';
import * as stagegate from './domain/stagegate.ts';
import * as cde from './domain/cde.ts';
import * as control from './domain/control.ts';
import * as procurement from './domain/procurement.ts';
import * as radar from './domain/radar.ts';
import * as cdm from './domain/cdm.ts';
import { DUTY_SECTIONS } from './seed/dutydocuments.ts';
import * as measurement from './domain/measurement.ts';
import * as qualitycontrol from './domain/qualitycontrol.ts';
import * as meetings from './domain/meetings.ts';
import * as submittals from './domain/submittals.ts';
import * as sitevisit from './engines/sitevisit.ts';
import * as structure from './domain/structure.ts';
import * as supplychain from './domain/supplychain.ts';
import type { EngineContext } from './engines/context.ts';
import * as bim from './engines/bim.ts';
import * as claimsEngine from './engines/claims.ts';
import * as cost from './engines/cost.ts';
import * as handover from './engines/handover.ts';
import * as planning from './engines/planning.ts';
import * as quality from './engines/quality.ts';
import * as safety from './engines/safety.ts';
import { scoreRisk } from './engines/maths/risk.ts';
import * as tender from './engines/tender.ts';
import type { AuthContext } from './identity/auth.ts';
import type { Role } from './identity/roles.ts';
import { issueTokens } from './identity/auth.ts';
import type { Platform } from './platform.ts';

/**
 * Seed a complete project across the entire lifecycle.
 *
 * This is the working demonstration of the platform: one asset, taken from
 * concept to operations, with every state change written through the Golden
 * Thread. It is also the fixture the tests and the console run against.
 */

/**
 * The names the demonstration tenancy is known by.
 *
 * Here rather than as literals in the seed body because there is now a second
 * reader: after a restart the demonstration tenancy is already on disk, and the
 * console adopts it instead of seeding a second one. Adoption has to recognise
 * what it is looking at, and a copy of these strings in `routes.ts` would be a
 * second source of truth for the same four facts — which would drift the first
 * time anyone renamed the project.
 */
export const DEMO_TENANCY = {
  legalName: 'Meridian Infrastructure Group Ltd',
  enterpriseName: 'Meridian Infrastructure Group',
  portfolioName: 'National Water Resilience Programme',
  projectName: 'Ashworth Water Treatment Works — Phase 2',
  /** The identity the console signs in as when it bootstraps itself. */
  primaryEmail: 'pm@meridian.example',
} as const;

export type SeedResult = {
  tenantId: string;
  projectId: string;
  /**
   * The sibling projects parked at Tender and Construction.
   *
   * The flagship project is in Operations, where the lifecycle gates close
   * procurement, estimating, measurement and field execution to every role.
   * These two exist so those parts of the product are reachable at all.
   */
  workingProjects: { projectId: string; name: string; phase: string }[];
  enterpriseName: string;
  portfolioName: string;
  projectName: string;
  users: Record<string, { id: string; auth: AuthContext }>;
  timeline: string[];
  acuConsumedMinor: number;
};

function contextFor(platform: Platform, auth: AuthContext, projectId: string): EngineContext {
  return platform.context(auth, projectId, { source: 'WEB' });
}

/**
 * Build an auth context for a user the way a real client would get one.
 *
 * Exported because tests that need a role the demonstration tenancy does not
 * seed — a commercial manager, a project director — must create that user and
 * then act as them. Hand-building the context instead would let the test award
 * itself whatever scopes it liked, and the scope check is part of what the
 * test is proving.
 */
export function authOf(platform: Platform, userId: string): AuthContext {
  const user = platform.user(userId);
  const tokens = issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  });
  // Decoding our own freshly-minted token keeps the seed on exactly the same
  // path a real client takes, rather than fabricating an auth context.
  const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1] as string, 'base64url').toString('utf8')) as {
    sub: string; tid: string; pid?: string; roles: AuthContext['roles']; scopes: string[]; jti: string; exp: number;
  };
  return {
    actorId: claims.sub,
    tenantId: claims.tid,
    partyId: claims.pid,
    roles: claims.roles,
    scopes: claims.scopes,
    tokenId: claims.jti,
    mfaSatisfied: true,
    regulatorAiEnabled: false,
    expiresAt: claims.exp * 1000,
  };
}

const hash = (input: string): string => hashEvidence(input);

export async function seedDemoProject(platform: Platform): Promise<SeedResult> {
  // Built against the deterministic local engines, whatever AI_MODE says.
  //
  // Two reasons, and both matter. Seeding a whole lifecycle against three live
  // providers is a real invoice for a tenancy that exists to be looked at; and
  // a fixture whose narrative text differs on every run is not a fixture — two
  // deployments of the same commit would show different words.
  //
  // This is only the *building* of it. Everything a visitor does on the seeded
  // tenancy afterwards runs against the configured providers and settles
  // against the wallet in the ordinary way.
  return platform.orchestrator.withLocalProviders(() => seedDemoProjectInner(platform));
}


/**
 * Everything the demonstration gained after the first seed ran, added to a
 * tenancy that already exists.
 *
 * **This is the reason nothing new appeared on a live deployment.** The seed is
 * all-or-nothing: `getOrCreateConsoleSession` adopts an existing demonstration
 * tenancy and returns without calling it, which is right — seeding twice would
 * build a second Meridian on every restart. But it means that on any deployment
 * whose journal was written by an earlier build, *nothing added to the seed
 * afterwards is ever created*. A laptop with a thrown-away journal sees the new
 * work on the next run; the one deployment that keeps its journal never does.
 * That is precisely backwards, and it is invisible because both paths look like
 * they worked.
 *
 * So this is separate and **idempotent by construction**: every block asks
 * whether the thing is already there, by the name or address it would have been
 * created under, and does nothing if it is. It runs on both paths — at the end
 * of a fresh seed and immediately after an adoption — so a deployment converges
 * on the same estate whichever way it got there.
 *
 * Anything added to the demonstration from now on belongs here rather than in
 * `seedDemoProjectInner`, for the same reason.
 */
export async function ensureDemonstrationExtras(platform: Platform): Promise<{ timeline: string[] }> {
  // The same rule as `seedDemoProject` above, and it was missing here.
  //
  // This function is called on every boot of a deployment that keeps its
  // journal — `getOrCreateConsoleSession` adopts the existing tenancy and runs
  // it — and it was calling the AI engines against whatever `AI_MODE` names. On
  // the live deployment that is three real providers, so building demonstration
  // data was a real invoice, and an exhausted wallet threw `ACU_EXHAUSTED` out
  // of the bootstrap and took the boot with it.
  //
  // Latent until something in here made an AI call on an already-seeded
  // tenancy, which the site record below does. Found by replaying a journal
  // written by the previous build into this one, which is the only way to see
  // an upgrade path before a customer does.
  return platform.orchestrator.withLocalProviders(() => ensureDemonstrationExtrasInner(platform));
}

async function ensureDemonstrationExtrasInner(platform: Platform): Promise<{ timeline: string[] }> {
  const timeline: string[] = [];
  const note = (message: string): void => {
    timeline.push(message);
  };

  const tenant = platform.tenants().find((t) => t.legalName === DEMO_TENANCY.legalName);
  if (!tenant) return { timeline };

  const users = platform.users(tenant.id);
  const byEmail = (email: string) => users.find((u) => u.email === email);
  const owner = byEmail('owner@meridian.example');
  const pm = byEmail(DEMO_TENANCY.primaryEmail);
  const qs = byEmail('qs@meridian.example');
  const bimLead = byEmail('bim@meridian.example');
  const admin = users.find((u) => u.roles.includes('ENTERPRISE_ADMIN'));
  if (!owner || !pm || !qs || !bimLead || !admin) return { timeline };

  // The seats the site record is actually written by. Separated from the four
  // above because the delivery record below has to be authored by whoever holds
  // the authority for each act — the planner baselines, the safety lead
  // approves method statements, the QA engineer inspects — and writing it all
  // as the project manager would produce a record that passes every check and
  // describes a project nobody could run.
  const planner = byEmail('planner@meridian.example');
  const safetyLead = byEmail('hse@meridian.example');
  const qaqc = byEmail('qaqc@meridian.example');

  const ownerAuth = authOf(platform, owner.id);
  const pmAuth = authOf(platform, pm.id);
  const qsAuth = authOf(platform, qs.id);
  const bimAuth = authOf(platform, bimLead.id);
  const gov = platform.context(authOf(platform, admin.id), `${tenant.id}-governance`, { source: 'WEB' });

  const enterpriseId = String(platform.ledger.listByTenant(tenant.id, 'Enterprise')[0]?.state.id ?? '');
  const portfolios = () => platform.ledger.listByTenant(tenant.id, 'Portfolio');
  const euPortfolio = portfolios().find((r) => r.state.name === DEMO_TENANCY.portfolioName);
  if (!euPortfolio) return { timeline };
  const euPortfolioId = String(euPortfolio.state.id);
  const euProgrammeId = String(
    platform.ledger.listByTenant(tenant.id, 'Programme').find((r) => r.state.name === 'Northern Treatment Upgrades')?.state.id ?? '',
  );

  /** Is a project with this name already on the chain? */
  const projectNamed = (name: string): boolean =>
    platform.ledger.entitiesOfType('Project').some((r) => r.tenantId === tenant.id && r.state.name === name);

  // The seat that runs a site. Added after the first seed, so on a deployment
  // that adopted an older tenancy it would otherwise never exist — and the
  // Construction screen would stay shut to everybody senior, which is exactly
  // the symptom this whole function exists to stop.
  if (!byEmail('construction@meridian.example')) {
    platform.createUser({
      tenantId: tenant.id,
      name: 'Construction Manager',
      email: 'construction@meridian.example',
      roles: ['CONSTRUCTION_MANAGER'],
      demonstration: true,
    });
    note('Construction Manager seat added to the demonstration tenancy');
  }

  // --- A project on site -----------------------------------------------------
  //
  // The third project, and the one that makes construction and site management
  // reachable at all. Field execution, quality and the whole safety file are
  // gated to CONSTRUCTION and COMMISSIONING, so with Ashworth in Operations and
  // Calderdale at Tender there was no project on which a site manager could
  // issue a permit, approve a method statement or record a diary — for any
  // role, however senior.
  //
  // Walked there through the gates rather than placed there. TENDER demands a
  // frozen estimate and an executed contract, so this builds both: a real
  // take-off against a real drawing, an estimate frozen at settlement, and a
  // negotiated contract signed. Nothing is asserted that the platform would not
  // have refused.
  //
  // It now carries a delivery record, and that is a reversal worth writing
  // down. It was deliberately left empty — "the empty diary, the empty permit
  // register and the empty inspection log are what somebody walking in has come
  // to fill" — and on a live deployment that reasoning did not survive contact
  // with a person.
  //
  // What it produced was a project at CONSTRUCTION with 31 events on it: a
  // contract, a drawing, a frozen estimate and four phase transitions, and
  // nothing operational at all. Every construction screen then reported the
  // truth about it — Programme "0 activities, 0 logic links", Field "64 of 64
  // working days have no diary", Risk "£0 across 0 open risks", Project Control
  // 13.0% with 20 gaps — and the whole console read as unbuilt rather than as
  // empty. A screen that is correct and looks broken is a screen that has
  // failed, and no amount of accurate emptiness fixes it.
  //
  // So the site history below is real: written through the same domain commands
  // the API exposes, in an order the platform would accept from a person, with
  // every gate and refusal in force. Nothing here asserts a figure. The
  // programme duration, the P80, the PPC, the productivity, the earned value
  // and the contingency are all computed from these records by the same engines
  // that would compute them for a customer.
  if (!projectNamed('Calderdale Reservoir Renewal')) {
    // --- A second project, parked where the work actually happens --------------
    //
    // The project above is the whole record: concept to thirty-year operations,
    // every stage gate passed. It proves what a finished Golden Thread looks
    // like, and it cannot prove anything else — because **writes are gated by
    // lifecycle phase**, and it sits in OPERATIONS.
    //
    // Measured in a browser across five roles, that meant Tender & Procurement
    // offered 1 open input out of 32 to *everybody*, the enterprise administrator
    // included; measurement and estimating were the same. Somebody evaluating the
    // product opened the bidding screens, found thirty-one padlocked buttons and
    // reasonably concluded there was nothing there. The enforcement was right and
    // the demonstration was wrong: one project at the end of the lifecycle can
    // show the record, but it cannot show the work.
    //
    // So a sibling on the same portfolio, stopped at TENDER — the phase that
    // opens measurement, estimating, enquiries, comparison and award. It carries
    // no seeded commercial history on purpose: the point of it is the empty
    // register somebody can put the first record into, and a second finished
    // project would only be more to read.
    //
    // It is walked forward through the real gates rather than set. The transition
    // out of CONCEPT demands a scope package and the one out of DESIGN demands a
    // maturity assessment, so both are created — and the first attempt at this
    // was refused by `PHASE_GATE_FAILED`, which is the platform behaving exactly
    // as it should against a seed trying to skip its own rules.
    const tenderProject = structure.createProject(gov, {
      portfolioId: euPortfolioId,
      programmeId: euProgrammeId,
      name: 'Calderdale Reservoir Renewal',
      sectorType: 'UTILITIES',
      assetType: 'Impounding reservoir',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Halifax' },
      contractValueMinor: 940_000_000,
      currency: 'GBP',
      plannedStart: '2027-01-11',
      plannedCompletion: '2029-06-29',
    });

    const tenderPmCtx = contextFor(platform, pmAuth, tenderProject.projectId);
    const tenderOwnerCtx = contextFor(platform, ownerAuth, tenderProject.projectId);

    const { packageId: renewalPackageId } = structure.createScopePackage(tenderPmCtx, {
      name: 'Spillway and embankment works',
      discipline: 'CIVILS',
      scopeOfWorks:
        'Reconstruction of the auxiliary spillway, embankment crest raising to current freeboard standards, and ' +
        'replacement of the draw-off tower valve gallery, including all temporary works and reservoir drawdown.',
      inclusions: ['Embankment earthworks', 'Reinforced concrete spillway', 'Valve gallery mechanical replacement'],
      exclusions: ['Permanent instrumentation supply', 'Access road adoption'],
      acceptanceCriteria: ['Reservoirs Act 1975 panel engineer sign-off', 'Compaction testing to specification', 'Drawdown test to design rate'],
      estimatedValueMinor: 640_000_000,
      designResponsibility: 'CONTRACTOR',
    });
    structure.transitionPhase(tenderOwnerCtx, { to: 'DESIGN', justification: 'Scope package defined and the brief accepted' });

    structure.assessDesignMaturity(tenderPmCtx, {
      packageId: renewalPackageId,
      disciplineScores: [
        { discipline: 'CIVILS', ribaStage: 4, completenessPercent: 82, frozen: true },
        { discipline: 'MECHANICAL', ribaStage: 3, completenessPercent: 61, frozen: false },
      ],
      informationGaps: ['Draw-off tower condition survey outstanding', 'Freeboard study awaiting panel engineer comment'],
      assessorNotes: 'Civils priceable; the valve gallery carries real definition risk and should be a provisional sum.',
    });
    structure.transitionPhase(tenderOwnerCtx, { to: 'TENDER', justification: 'Design matured to a priceable state for the civils package' });

    // --- The invitation this tender exists because of -------------------------
    //
    // The registers above stay empty on purpose — that is the whole point of
    // this project, and the note below says so. What was missing is different:
    // a project sitting in TENDER with **no invitation behind it** is a tender
    // nobody was invited to. The estimating and procurement screens were
    // rightly blank; the reason for opening them at all was blank too.
    //
    // So the front half is seeded and the back half is not. An opportunity, its
    // ten-factor qualification, the bid decision, the invitation as it arrived,
    // and the compliance matrix read off it. Everything a bid team does
    // *before* anybody measures anything — which is also the half that gives
    // the tender agents something to wake on, because `AGT-TENDER-INTEL`
    // triggers on `ITT_ANALYSED` and had never seen one.
    const tenderQsCtx = contextFor(platform, qsAuth, tenderProject.projectId);

    const spillway = business.registerOpportunity(tenderQsCtx, {
      title: 'Calderdale spillway reconstruction and crest raising',
      clientName: 'Yorkshire Water Services Limited',
      sectorType: 'UTILITIES',
      estimatedValueMinor: 640_000_000,
      source: 'AMP8 civils framework, lot 3 — invited off the framework rather than open tender',
      submissionDueAt: '2027-01-08',
      countryCode: 'GB',
      city: 'Halifax',
    });

    // Scored honestly rather than to a flattering total: strong experience and
    // an attractive client, against real competition and a cash-flow profile
    // that funds the client through a long payment period.
    const qualification = business.qualifyOpportunity(tenderQsCtx, spillway.opportunityId, {
      relevantExperience: 5,
      clientAttractiveness: 5,
      contractSize: 4,
      geography: 5,
      supplyChainCapacity: 3,
      competition: 3,
      marginOpportunity: 3,
      cashflowRisk: 2,
      strategicValue: 4,
      winProbability: 4,
    });

    business.decideBidNoBid(tenderOwnerCtx, spillway.opportunityId, {
      bid: true,
      rationale:
        'Framework lot we hold and have delivered twice. The reservoir drawdown is the risk that decides this — ' +
        'it is a Reservoirs Act operation on a live impounding reservoir and the outage window is the client’s to ' +
        'give. Bid, and price the drawdown as a provisional sum rather than carrying the programme risk.',
      conditions: [
        'Drawdown window confirmed in writing before the return',
        'Valve gallery mechanical scope carried as a provisional sum',
      ],
    });

    const invitation = tenderintake.recordInvitation(tenderQsCtx, spillway.opportunityId, {
      reference: 'YW/AMP8/L3/2026/SPW-014',
      issuedAt: '2026-11-06T09:00:00Z',
      returnLocal: '2027-01-08T12:00',
      timeZone: 'Europe/London',
      timeZoneStated: true,
      channel: 'PORTAL',
      clarificationLocal: '2026-12-11T17:00',
      siteVisitLocal: '2026-11-27T10:00',
      documents: [
        'Instructions to tenderers, rev B',
        'NEC4 Option A contract data parts one and two',
        'Pricing schedule, native spreadsheet',
        'Drawing pack C-1000 to C-1042',
        'Reservoir panel engineer’s report, 2025 inspection',
      ],
      notes: 'Issued under the AMP8 civils framework. Three bidders invited off lot 3.',
    });

    // The compliance matrix, read off the instructions to tenderers.
    //
    // Every line is one the invitation actually imposes on a Reservoirs Act
    // job: the panel engineer's supervision, the drawdown consent, the CDM
    // duty, the social value weighting the framework carries. The analyst
    // probes the company profile for evidence it already holds, so what comes
    // back is a genuine mix of SATISFIED, GAP and UNKNOWN rather than a screen
    // of green ticks.
    const matrix = itt.analyseITT(tenderQsCtx, {
      reference: 'YW/AMP8/L3/2026/SPW-014',
      clientName: 'Yorkshire Water Services Limited',
      returnBy: '2027-01-08',
      estimatedValueMinor: 640_000_000,
      durationWeeks: 86,
      targetMarginPercent: 6,
      requirements: [
        {
          reference: 'ITT-3.1',
          category: 'QUALIFICATION',
          requirement:
            'Two reservoir or dam projects of comparable value completed in the last six years, each on a live impounding reservoir',
          mandatory: true,
          weightingPercent: 15,
          evidenceRequired: 'Project references with client contact, contract value and completion certificate',
        },
        {
          reference: 'ITT-3.4',
          category: 'TECHNICAL',
          requirement:
            'Method statement for spillway reconstruction under partial drawdown, including the flood contingency during the works',
          mandatory: true,
          weightingPercent: 25,
          evidenceRequired: 'Technical submission, 20 pages, with an outline construction programme',
        },
        {
          reference: 'ITT-3.7',
          category: 'TECHNICAL',
          requirement:
            'Named all-reservoirs panel engineer engaged for the duration, and a construction engineer appointed under the Reservoirs Act 1975',
          mandatory: true,
          weightingPercent: 10,
          evidenceRequired: 'Letter of engagement and panel appointment reference',
        },
        {
          reference: 'ITT-4.2',
          category: 'INSURANCE',
          requirement: 'Employers liability insurance of £10m and public liability of £10m for each and every claim',
          mandatory: true,
          evidenceRequired: 'Certificate of employers liability insurance',
        },
        {
          reference: 'ITT-4.3',
          category: 'INSURANCE',
          requirement: 'Professional indemnity of £5m in the aggregate, held for twelve years from completion',
          mandatory: true,
          evidenceRequired: 'Professional indemnity certificate showing limit and basis',
        },
        {
          reference: 'ITT-5.1',
          category: 'HEALTH_AND_SAFETY',
          requirement: 'Principal Contractor competence under CDM 2015, with the last three years of RIDDOR statistics',
          mandatory: true,
          weightingPercent: 10,
          evidenceRequired: 'Accident frequency rate and enforcement history, signed by a director',
        },
        {
          reference: 'ITT-5.6',
          category: 'QUALITY',
          requirement: 'Certified quality management system covering civil engineering works',
          mandatory: true,
          evidenceRequired: 'ISO 9001 certificate with scope covering water infrastructure',
        },
        {
          reference: 'ITT-6.2',
          category: 'ENVIRONMENTAL',
          requirement:
            'Certified environmental management system, and a method for protecting the downstream SSSI watercourse during drawdown',
          mandatory: true,
          weightingPercent: 10,
          evidenceRequired: 'ISO 14001 certificate and an outline environmental management plan',
        },
        {
          reference: 'ITT-6.5',
          category: 'SOCIAL_VALUE',
          requirement:
            'Social value commitment against the framework model: local labour, apprenticeships and spend within the Calderdale travel-to-work area',
          mandatory: false,
          weightingPercent: 10,
          evidenceRequired: 'Completed social value schedule with measurable commitments',
        },
        {
          reference: 'ITT-7.3',
          category: 'PROGRAMME',
          requirement:
            'Programme showing the works completed within the single drawdown window of 1 April to 31 October 2027, with the flood contingency identified',
          mandatory: true,
          weightingPercent: 15,
          evidenceRequired: 'Outline programme to activity level with critical path marked',
        },
        {
          reference: 'ITT-8.1',
          category: 'COMMERCIAL',
          requirement: 'Fully priced activity schedule under NEC4 Option A, with no qualifications to the contract data',
          mandatory: true,
          weightingPercent: 5,
          evidenceRequired: 'Completed pricing schedule in the native spreadsheet issued',
        },
        {
          reference: 'ITT-9.4',
          category: 'SUBMISSION',
          requirement: 'Submission through the buyer portal only. Late or emailed returns are not opened.',
          mandatory: true,
          evidenceRequired: 'Portal submission receipt',
          dueBy: '2027-01-08',
        },
      ],
      terms: {
        contractForm: 'NEC4 ECC Option A with Z-clauses, as issued',
        liquidatedDamages: { perWeekMinor: 4_500_000, capPercent: 10 },
        performanceBondPercent: 10,
        parentCompanyGuaranteeRequired: false,
        retentionPercent: 5,
        paymentDays: 60,
        designLiability: 'FITNESS_FOR_PURPOSE',
        sectionalCompletions: 2,
        other: [
          'Collateral warranties to the Environment Agency and to the reservoir undertaker',
          'Drawdown window is the undertaker’s to grant and may be withdrawn on 28 days’ notice',
        ],
      },
    });

    // What has to go back, and who owns producing it. The internal dates are
    // the ones that bind — a bond that takes three weeks to broker is a lead
    // time, not a task, and the register is where that becomes visible.
    tenderintake.extractRequirements(tenderQsCtx, invitation.invitationId, {
      analysisId: matrix.analysisId,
      deliverables: [
        {
          reference: 'D-01',
          title: 'Technical submission — spillway reconstruction under partial drawdown',
          mandatory: true,
          format: 'PDF',
          pageLimit: 20,
          fileSizeLimitMb: 25,
          channel: 'PORTAL',
          owner: 'DESIGNER',
          internalDueBy: '2026-12-18',
          source: { document: 'Instructions to tenderers, rev B', clause: '3.4', page: 11 },
        },
        {
          reference: 'D-02',
          title: 'Priced activity schedule, native spreadsheet as issued',
          mandatory: true,
          format: 'XLSX',
          channel: 'PORTAL',
          owner: 'COMMERCIAL_MANAGER',
          internalDueBy: '2027-01-04',
          source: { document: 'Pricing schedule, native spreadsheet', clause: '8.1' },
        },
        {
          reference: 'D-03',
          title: 'Outline programme to activity level, critical path marked',
          mandatory: true,
          format: 'PDF',
          channel: 'PORTAL',
          owner: 'PLANNER',
          internalDueBy: '2026-12-18',
          source: { document: 'Instructions to tenderers, rev B', clause: '7.3', page: 19 },
        },
        {
          reference: 'D-04',
          title: 'Bond agreement in principle from the surety, 10% of contract value',
          mandatory: true,
          bondRequired: true,
          format: 'PDF',
          channel: 'PORTAL',
          owner: 'COMMERCIAL_MANAGER',
          internalDueBy: '2026-12-11',
          source: { document: 'NEC4 Option A contract data parts one and two', clause: 'Z12' },
        },
        {
          reference: 'D-05',
          title: 'Form of tender, signed by a director',
          mandatory: true,
          signatureRequired: true,
          format: 'PDF',
          channel: 'PORTAL',
          owner: 'COMMERCIAL_MANAGER',
          internalDueBy: '2027-01-06',
          source: { document: 'Instructions to tenderers, rev B', clause: '9.1', page: 24 },
        },
        {
          reference: 'D-06',
          title: 'Social value schedule with measurable local commitments',
          mandatory: false,
          format: 'PDF',
          pageLimit: 8,
          channel: 'PORTAL',
          owner: 'QS',
          internalDueBy: '2026-12-18',
          source: { document: 'Instructions to tenderers, rev B', clause: '6.5', page: 17 },
        },
      ],
    });

    note(
      `Invitation received on Calderdale: ${'YW/AMP8/L3/2026/SPW-014'} from Yorkshire Water, returning 2027-01-08 — ` +
        `qualified at ${qualification.score}% (${qualification.recommendation}), a bid decision taken, and the ` +
        `compliance matrix read off the instructions: ${matrix.mandatoryGaps.length} mandatory gap(s), ` +
        `${matrix.clarifications.length} clarification(s) to raise and ${matrix.terms.length} commercial terms ` +
        `assessed${matrix.readyToPrice ? '' : ' — not ready to price'}. Measurement and pricing are deliberately empty.`,
    );

    note(
      `Working project at TENDER: Calderdale Reservoir Renewal (${tenderProject.projectId}) — ` +
        'the invitation, its compliance matrix and the bid decision are here; measurement, estimating and ' +
        'procurement are writable and deliberately empty',
    );
  }

  if (!projectNamed('Rossendale Trunk Main Diversion')) {
    const siteProject = structure.createProject(gov, {
      portfolioId: euPortfolioId,
      programmeId: euProgrammeId,
      name: 'Rossendale Trunk Main Diversion',
      sectorType: 'UTILITIES',
      assetType: 'Potable trunk main',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
      contractValueMinor: 410_000_000,
      currency: 'GBP',
      plannedStart: '2026-02-02',
      plannedCompletion: '2027-08-13',
    });

    const siteOwnerCtx = contextFor(platform, ownerAuth, siteProject.projectId);
    const sitePmCtx = contextFor(platform, pmAuth, siteProject.projectId);
    const siteQsCtx = contextFor(platform, qsAuth, siteProject.projectId);
    const siteBimCtx = contextFor(platform, bimAuth, siteProject.projectId);

    const { packageId: diversionPackageId } = structure.createScopePackage(sitePmCtx, {
      name: 'Trunk main diversion and tie-ins',
      discipline: 'CIVILS',
      scopeOfWorks:
        'Diversion of 1.2km of DN600 potable trunk main around the proposed highway realignment, including two live ' +
        'tie-ins under night-time shutdown, chamber construction and reinstatement of the carriageway.',
      inclusions: ['Open-cut pipelaying', 'Two live tie-ins', 'Carriageway reinstatement'],
      exclusions: ['Permanent traffic signals', 'Third-party service diversions'],
      acceptanceCriteria: ['Pressure testing to WIS 4-01-01', 'Chlorination and bacteriological clearance', 'Highway reinstatement to HAUC standards'],
      estimatedValueMinor: 340_000_000,
      designResponsibility: 'CONTRACTOR',
    });
    structure.transitionPhase(siteOwnerCtx, { to: 'DESIGN', justification: 'Diversion scope defined and funding released' });

    structure.assessDesignMaturity(sitePmCtx, {
      packageId: diversionPackageId,
      disciplineScores: [{ discipline: 'CIVILS', ribaStage: 5, completenessPercent: 94, frozen: true }],
      informationGaps: ['Statutory undertaker records for the western verge not yet returned'],
      assessorNotes: 'Fully priceable. The outstanding utility records are a construction risk, not a pricing one.',
    });
    structure.transitionPhase(siteOwnerCtx, { to: 'TENDER', justification: 'Design frozen and the package released for pricing' });

    const siteDrawing = await bim.registerDrawing(siteBimCtx, {
      fileHash: hash('R-2100-C02.pdf'),
      titleBlock: {
        drawingNumber: 'R-2100',
        title: 'Trunk Main Diversion — Plan and Long Section',
        revision: 'C02',
        discipline: 'CIVILS',
        issueDate: '2025-11-18',
        status: 'FOR CONSTRUCTION',
      },
      packageIds: [diversionPackageId],
    });

    const siteTakeoff = await tender.runTakeoff(siteQsCtx, {
      packageId: diversionPackageId,
      sources: [{ drawingRef: { refType: 'Drawing', refId: siteDrawing.drawingId }, discipline: 'CIVILS', sheetId: 'R-2100' }],
      costCodePrefix: 'DIV',
      items: [
        { description: 'Excavate trench in carriageway, average 1.8m deep', unit: 'm', quantity: 1_240, sourceSheet: 'R-2100', measurementRule: 'NRM2' },
        { description: 'Lay DN600 ductile iron main including bedding', unit: 'm', quantity: 1_240, sourceSheet: 'R-2100' },
        { description: 'Reinstate carriageway to HAUC standard', unit: 'm2', quantity: 3_720, sourceSheet: 'R-2100' },
      ],
    });

    const siteEstimate = tender.buildEstimate(siteQsCtx, {
      packageId: diversionPackageId,
      durationWeeks: 46,
      lines: [
        { boqItemId: siteTakeoff.boqItemIds[0] as string, description: 'Excavate trench in carriageway', unit: 'm', quantity: 1_240, labourRateMinor: 8_400, plantRateMinor: 11_200 },
        { boqItemId: siteTakeoff.boqItemIds[1] as string, description: 'Lay DN600 ductile iron main', unit: 'm', quantity: 1_240, labourRateMinor: 14_600, plantRateMinor: 6_300, materialRateMinor: 78_400, materialWastePercent: 3 },
        { boqItemId: siteTakeoff.boqItemIds[2] as string, description: 'Carriageway reinstatement', unit: 'm2', quantity: 3_720, labourRateMinor: 4_100, plantRateMinor: 2_700, materialRateMinor: 5_900, materialWastePercent: 5 },
      ],
      timeRelated: [
        { head: 'SITE_MANAGEMENT', description: 'Construction manager', weeklyRateMinor: 210_000, quantity: 1 },
        { head: 'SITE_MANAGEMENT', description: 'Site engineer', weeklyRateMinor: 160_000, quantity: 1 },
        // Named because this job is in a live carriageway: the traffic management
        // is a preliminary that is priced weekly and is the first thing to grow
        // when the works overrun.
        { head: 'LOGISTICS', description: 'Traffic management and marshalling', weeklyRateMinor: 165_000, quantity: 1 },
        { head: 'HEALTH_AND_SAFETY', description: 'Safety adviser attendance', weeklyRateMinor: 68_000, quantity: 1 },
      ],
      quantified: [{ head: 'TEMPORARY_WORKS', description: 'Trench support design and hire', unit: 'week', quantity: 34, rateMinor: 186_000 }],
      margin: { overheadPercent: 6, profitPercent: 7 },
      basisOfEstimate: 'Measured from R-2100 rev C02 with rates from the 2026 civils library.',
      assumptions: ['Continuous night-time possession for both tie-ins', 'No rock encountered above formation'],
    });
    // No transition here: the project is already at TENDER, and asking for the
    // phase it is in is refused with PHASE_NO_CHANGE rather than accepted as a
    // no-op — correctly, because a transition is a governance event and one that
    // moves nothing is a record of a decision nobody took.
    tender.freezeEstimate(siteQsCtx, siteEstimate.estimateId, 'Frozen at settlement before the negotiated offer was given');

    // Negotiated, not tendered — which is why `executeContract` had to exist. A
    // contract could previously only reach EXECUTED by conversion from a locked
    // bid pack, so this whole route through the platform was closed.
    const siteContract = claimsEngine.createContract(siteQsCtx, {
      suite: 'NEC4',
      form: 'NEC4 ECC Option A',
      parties: [
        { role: 'CLIENT', partyId: 'CLIENT-AWA', name: 'Ashworth Water Authority' },
        { role: 'CONTRACTOR', partyId: 'CONTRACTOR-MERIDIAN', name: 'Meridian Infrastructure Group Ltd' },
      ],
      contractSumMinor: siteEstimate.totalMinor,
      commencementDate: '2026-02-02',
      completionDate: '2027-08-13',
      liquidatedDamagesPerDayMinor: 420_000,
      ldCapPercent: 8,
      retentionPercent: 3,
      defectsLiabilityMonths: 12,
    });
    claimsEngine.executeContract(siteOwnerCtx, {
      contractId: siteContract.contractId,
      signedDocumentHash: hash('rossendale-executed-main-contract'),
      signatureMethod: 'DEED',
      executedOn: '2026-01-19',
    });
    structure.transitionPhase(siteOwnerCtx, {
      to: 'CONSTRUCTION',
      justification: 'Contract executed and estimate frozen; works may commence',
    });
    note(
      `Project on site: Rossendale Trunk Main Diversion (${siteProject.projectId}) at CONSTRUCTION`,
    );
  }


  // --- The delivery record on the project that is on site ---------------------
  //
  // Outside the creation block above, and that placement is the whole point.
  //
  // Written inside it first, which meant it only ever ran on a ledger that had
  // never seen this project. Every existing deployment already holds Rossendale
  // — it was created in August — so the guard was false, none of this executed,
  // and a deploy of the change would have altered precisely nothing on the live
  // site while every test passed. `ensureDemonstrationExtras` exists to be
  // additive on a tenancy that is already running, and a block that can only
  // run on a fresh one is not additive.
  //
  // So the guard is on the record rather than on the project: the site history
  // is written where the project exists and carries no programme yet. It is
  // idempotent for the same reason — a second pass finds activities and does
  // nothing.
  const siteRecord = platform.ledger
    .entitiesOfType('Project')
    .find((r) => r.tenantId === tenant.id && r.state.name === 'Rossendale Trunk Main Diversion');
  const siteId = siteRecord ? String(siteRecord.state.id) : '';
  const sitePackageId = String(
    (siteId ? platform.ledger.list(siteId, 'ScopePackage')[0]?.state.id : undefined) ?? '',
  );
  const siteDrawingId = String(
    (siteId ? platform.ledger.list(siteId, 'Drawing')[0]?.state.id : undefined) ?? '',
  );

  // Wrapped, because this is demonstration data and it runs inside the boot
  // sequence of a live platform. A refusal here — an exhausted wallet, a gate
  // that moved, a record shape that changed under it — must leave the project
  // exactly as it was and let the deployment come up. The alternative is a
  // container that fails its health check and rolls back a release over a
  // fixture, which is a bad trade at any hour and a worse one at three in the
  // morning.
  //
  // The reason is put on the timeline rather than swallowed: the operator
  // screen prints it, so a demonstration that silently stopped improving is
  // visible instead of mysterious.
  try {
  if (siteId && sitePackageId && siteDrawingId && platform.ledger.list(siteId, 'Task').length === 0) {
    const siteOwnerCtx = contextFor(platform, ownerAuth, siteId);
    const sitePmCtx = contextFor(platform, pmAuth, siteId);
    const siteQsCtx = contextFor(platform, qsAuth, siteId);
    const siteBimCtx = contextFor(platform, bimAuth, siteId);

    // Each act belongs to the authority that holds it: there is no honest way
    // to write a safety file as a commercial manager, so nothing is written
    // unless the three delivery seats exist.
  if (planner && safetyLead && qaqc) {
    const sitePlannerCtx = contextFor(platform, authOf(platform, planner.id), siteId);
    const siteSafetyCtx = contextFor(platform, authOf(platform, safetyLead.id), siteId);
    const siteQaqcCtx = contextFor(platform, authOf(platform, qaqc.id), siteId);

    // The one AI call in this record, made first and deliberately so.
    //
    // The ledger is append-only: there is no rolling back a half-written site
    // history. So the step that can refuse for a reason outside this function —
    // an exhausted wallet, an unreachable provider — runs before anything has
    // been committed. If it throws, the catch below finds the project exactly
    // as it was, and the note it writes is true.
    //
    // Written the other way round first. The wallet ran out at the RAMS draft
    // with eleven activities and both baselines already on the chain, and the
    // note said the project was unchanged, which it was not.
    const siteRams = await safety.draftRAMS(siteSafetyCtx, {
      workPackageId: sitePackageId,
      activityDescription: 'Open-cut excavation and DN600 pipelaying in a live carriageway',
      location: 'Bacup Road, chainage 0 to 1240',
      steps: [
        { description: 'Set out and scan for buried services ahead of the face', activityType: 'EXCAVATION' },
        { description: 'Break out carriageway and excavate in supported stages', activityType: 'EXCAVATION' },
        { description: 'Install trench support before any person enters', activityType: 'EXCAVATION' },
        { description: 'Lift and lower DN600 pipe lengths into the trench', activityType: 'LIFTING' },
        { description: 'Joint, bed and surround the main', activityType: 'GENERAL' },
      ],
      companyHazardLibrary: [
        {
          activityType: 'EXCAVATION',
          hazards: ['Unrecorded statutory services in the western verge'],
          controls: ['Service location record no older than seven days before breaking ground at any new chainage'],
        },
      ],
    });

    // The programme. A linear job in a live carriageway, so the logic is
    // mostly finish-to-start with one overlap: reinstatement follows the
    // pipelaying gang down the trench rather than waiting for all of it.
    const siteTasks = planning.createTasks(sitePlannerCtx, [
      { activityCode: 'R100', name: 'Site establishment and traffic management', workPackageId: sitePackageId, durationDays: 15, costCode: 'DIV.001' },
      { activityCode: 'R200', name: 'Service location and trial holes', workPackageId: sitePackageId, durationDays: 20, costCode: 'DIV.001', optimisticDays: 15, pessimisticDays: 45 },
      { activityCode: 'R300', name: 'Open-cut trench — chainage 0 to 620', workPackageId: sitePackageId, durationDays: 55, costCode: 'DIV.002', optimisticDays: 48, pessimisticDays: 85 },
      { activityCode: 'R400', name: 'Lay DN600 main — chainage 0 to 620', workPackageId: sitePackageId, durationDays: 50, costCode: 'DIV.002' },
      { activityCode: 'R500', name: 'Open-cut trench — chainage 620 to 1240', workPackageId: sitePackageId, durationDays: 55, costCode: 'DIV.002' },
      { activityCode: 'R600', name: 'Lay DN600 main — chainage 620 to 1240', workPackageId: sitePackageId, durationDays: 50, costCode: 'DIV.002' },
      { activityCode: 'R700', name: 'Chamber construction and valve installation', workPackageId: sitePackageId, durationDays: 35, costCode: 'DIV.003' },
      { activityCode: 'R800', name: 'Pressure test, swab and chlorinate', workPackageId: sitePackageId, durationDays: 18, costCode: 'DIV.004', optimisticDays: 12, pessimisticDays: 40 },
      { activityCode: 'R900', name: 'Live tie-in — north, night shutdown', workPackageId: sitePackageId, durationDays: 4, costCode: 'DIV.004', optimisticDays: 3, pessimisticDays: 14 },
      { activityCode: 'R950', name: 'Live tie-in — south, night shutdown', workPackageId: sitePackageId, durationDays: 4, costCode: 'DIV.004', optimisticDays: 3, pessimisticDays: 14 },
      { activityCode: 'R980', name: 'Carriageway reinstatement to HAUC', workPackageId: sitePackageId, durationDays: 40, costCode: 'DIV.005' },
    ]);

    planning.linkTasks(sitePlannerCtx, [
      { predecessorId: siteTasks[0] as string, successorId: siteTasks[1] as string, type: 'FS', lag: 0 },
      { predecessorId: siteTasks[1] as string, successorId: siteTasks[2] as string, type: 'FS', lag: 0 },
      // Pipelaying starts fifteen days behind the excavation rather than
      // after it. This is the overlap that makes the trench the driver.
      { predecessorId: siteTasks[2] as string, successorId: siteTasks[3] as string, type: 'SS', lag: 15 },
      { predecessorId: siteTasks[2] as string, successorId: siteTasks[4] as string, type: 'FS', lag: 0 },
      { predecessorId: siteTasks[4] as string, successorId: siteTasks[5] as string, type: 'SS', lag: 15 },
      { predecessorId: siteTasks[3] as string, successorId: siteTasks[6] as string, type: 'FS', lag: 0 },
      { predecessorId: siteTasks[5] as string, successorId: siteTasks[6] as string, type: 'FS', lag: 0 },
      { predecessorId: siteTasks[6] as string, successorId: siteTasks[7] as string, type: 'FS', lag: 0 },
      { predecessorId: siteTasks[7] as string, successorId: siteTasks[8] as string, type: 'FS', lag: 0 },
      { predecessorId: siteTasks[8] as string, successorId: siteTasks[9] as string, type: 'FS', lag: 5 },
      { predecessorId: siteTasks[9] as string, successorId: siteTasks[10] as string, type: 'FS', lag: 0 },
    ]);

    const siteProgramme = planning.recalculateProgramme(sitePlannerCtx, { contractualDurationDays: 557 });
    planning.approveBaseline(sitePlannerCtx, {
      version: 'BL-01',
      reason: 'Baseline agreed with the client at the pre-start meeting',
      contractualCompletionDate: '2027-08-13',
    });

    cost.approveBudget(siteOwnerCtx, {
      version: 'CB-01',
      byCostCode: [
        { costCode: 'DIV.001', description: 'Establishment and traffic management', budgetMinor: 48_000_000 },
        { costCode: 'DIV.002', description: 'Excavation and pipelaying', budgetMinor: 189_000_000 },
        { costCode: 'DIV.003', description: 'Chambers and valves', budgetMinor: 41_000_000 },
        { costCode: 'DIV.004', description: 'Testing and tie-ins', budgetMinor: 33_000_000 },
        { costCode: 'DIV.005', description: 'Carriageway reinstatement', budgetMinor: 62_000_000 },
      ],
      contingencyMinor: 21_000_000,
      managementReserveMinor: 9_000_000,
      tenderMarginPercent: 7,
    });

    // The two gates that were blocking this project are now met, which is the
    // point: the stage gate refused it for a reason and the reason is gone.
    const siteCpp = cdm.draftDocument(siteSafetyCtx, {
      type: 'CONSTRUCTION_PHASE_PLAN',
      title: 'Construction Phase Plan — Rossendale Trunk Main Diversion',
      workPackageId: sitePackageId,
      // All twelve sections the regulation requires, written for this job.
      // The engine refuses an approval with any of them unfilled, and it
      // refused this plan the first time it was written with three — which is
      // the rule doing exactly what it is for. A CPP with nine headings and no
      // content is the document that gets a site shut down.
      sections: [
        {
          heading: 'Project description and programme',
          body:
            'Diversion of 1.2km of DN600 potable trunk main around the proposed Bacup Road realignment, comprising ' +
            'open-cut pipelaying in a live carriageway, two chamber constructions, two live tie-ins under night-time ' +
            'shutdown, and full-width carriageway reinstatement to HAUC standards. Commencement 2 February 2026, ' +
            'contractual completion 13 August 2027. The works are sequenced in two halves either side of chainage 620 ' +
            'so that one running lane is maintained at all times.',
        },
        {
          heading: 'Management of the work',
          body:
            'Meridian Infrastructure Group is Principal Contractor. The works run in a live carriageway under a ' +
            'permanent traffic management arrangement, and no activity is released outside the signed limits of that ' +
            'arrangement. Day-to-day control sits with the site manager, who holds the authority to stop any activity. ' +
            'Work is released package by package against an approved method statement, and no activity starts until ' +
            'its RAMS has been briefed and acknowledged by the people carrying it out. Both live tie-ins are carried ' +
            'out under a night-time shutdown agreed with Ashworth Water Authority and are permitted separately from ' +
            'the open-cut works.',
        },
        {
          heading: 'Duty holders and organisational structure',
          body:
            'Client: Ashworth Water Authority. Principal Designer: Meridian Design. Principal Contractor: Meridian ' +
            'Infrastructure Group Ltd. On site the construction manager holds overall control, supported by a site ' +
            'manager for the works corridor, a site engineer for setting out and service location, and a streetworks ' +
            'supervisor holding the NRSWA qualification the highway authority requires. The HSE lead reports outside ' +
            'the delivery line, directly to the project director, so a stop-work decision is never taken by the person ' +
            'carrying the programme.',
        },
        {
          heading: 'Health and safety aims',
          body:
            'No person is to enter an unsupported excavation, and no excavation is to be broken out against a service ' +
            'record older than seven days. Those two are stated as absolutes rather than as targets because they are ' +
            'the two ways this particular job kills somebody. Beyond them: every operative inducted before first ' +
            'shift, every high-risk activity permitted, every incident and near miss investigated to root cause, and ' +
            'no reliance on a verbal instruction for anything that changes a method.',
        },
        {
          heading: 'Site rules',
          body:
            'Hi-visibility clothing to the traffic management standard, safety footwear, helmet and gloves at all ' +
            'times within the corridor. No pedestrian movement between the working corridor and the live lane except ' +
            'at the two signed crossing points. Plant movements are banksman controlled. Mobile telephones are not to ' +
            'be used by anyone on foot inside the corridor. Any person may stop the work; nobody is required to ' +
            'explain a stop before it is taken.',
        },
        {
          heading: 'Arrangements for controlling significant site risks',
          body:
            'Excavation deeper than 1.2m is supported and no person enters an unsupported trench. Lifting pipe ' +
            'lengths into the trench is planned by an appointed person against a lift plan. Buried services are ' +
            'located and proved by trial hole ahead of the face at 30m centres; the western verge records were never ' +
            'returned by the statutory undertaker, so the ground there is treated as unknown and hand-dug to prove ' +
            'each new chainage. The night shutdown tie-ins are confined-space adjacent and carry their own rescue ' +
            'arrangement, briefed at the shift start rather than assumed from the daytime plan.',
        },
        {
          heading: 'Welfare facilities',
          body:
            'A welfare unit for 20 persons is established at the compound at chainage 40, providing heated ' +
            'accommodation, hot and cold running water, drying facilities, and separate toilets. It is within 250m of ' +
            'the working face for the first half of the works; a second unit is established at chainage 700 before ' +
            'excavation crosses that chainage, because a walk longer than five minutes is a welfare facility people ' +
            'stop using.',
        },
        {
          heading: 'Fire and emergency procedures',
          body:
            'The muster point is the compound gate at chainage 40, with a second at chainage 700 once that compound ' +
            'opens. Emergency vehicle access is maintained along the running lane at all times and is the reason the ' +
            'corridor is never fully closed without a signed diversion. Hot work requires a permit and a one-hour ' +
            'fire watch. In an emergency in the trench, nobody enters to recover a casualty until the trench support ' +
            'has been confirmed by the site manager or the streetworks supervisor.',
        },
        {
          heading: 'Site induction arrangements',
          body:
            'Every person is inducted before first shift by the HSE lead or the site manager. The induction covers ' +
            'the traffic management layout and the crossing points, the buried services regime and the western verge ' +
            'condition, the trench support rule, the muster points, and who may stop the work. Attendance is recorded ' +
            'against the person and their employer, and no permit names an operative with no induction recorded.',
        },
        {
          heading: 'Consultation with workers',
          body:
            'A daily briefing is held at the compound before each shift and covers the day’s method, what changed ' +
            'from the day before, and anything raised the previous day. A weekly safety meeting is held with the ' +
            'gangs, minuted, with actions carried against a named owner and a date. Any operative may raise a concern ' +
            'directly with the HSE lead, and the record of what was raised and what was done about it is kept whether ' +
            'or not the concern was upheld.',
        },
        {
          heading: 'Site security',
          body:
            'The working corridor is separated from the live carriageway by rigid barrier for its full length, and ' +
            'from the footway by pedestrian barrier with tapping rail. Open excavations are covered or barriered and ' +
            'lit outside working hours. The compound is fenced and locked, with plant keys held in the site office. ' +
            'The site is in a residential area and the trench is an attraction to children, which is why open ' +
            'excavation is not left overnight beyond the length that can be barriered and lit.',
        },
        {
          heading: 'Existing site conditions and pre-construction information',
          body:
            'Bacup Road is a live single-carriageway A road with a bus route and residential frontage. Records show ' +
            'gas, electricity, water and telecommunications within the highway. Statutory undertaker records for the ' +
            'western verge between chainage 620 and 1240 were requested and never returned, and that is carried as a ' +
            'live risk on the register rather than closed out on an assumption. An unrecorded disused BT subduct was ' +
            'struck at chainage 362 on 10 August 2026 and removed under supervision, which is treated as evidence ' +
            'that the records for the whole route are incomplete rather than as an isolated find.',
        },
      ],
    });
    cdm.approveDocument(siteSafetyCtx, siteCpp.documentId, {
      comments: 'Approved. The unknown-services condition on the western verge is carried into every excavation permit.',
    });

    safety.approveRAMS(siteSafetyCtx, siteRams.ramsId, 'Approved against the unknown-services condition on the western verge.');
    safety.acknowledgeRAMS(siteSafetyCtx, siteRams.ramsId, ['RD-001', 'RD-002', 'RD-003', 'RD-004', 'RD-005'], hash('rossendale-rams-briefing'));

    for (const person of [
      { personId: 'RD-001', personName: 'Gareth Whitworth', employer: 'Meridian Civils' },
      { personId: 'RD-002', personName: 'Ana Bujor', employer: 'Meridian Civils' },
      { personId: 'RD-003', personName: 'Tomasz Nowicki', employer: 'Pennine Groundworks' },
      { personId: 'RD-004', personName: 'Sean Duffy', employer: 'Pennine Groundworks' },
      { personId: 'RD-005', personName: 'Marcus Hale', employer: 'Meridian Civils' },
    ]) {
      cdm.recordInduction(siteSafetyCtx, {
        ...person,
        inductedBy: safetyLead.name,
        competenciesChecked: ['CSCS', 'Traffic management layout', 'Buried services regime'],
      });
    }

    safety.recordCompetency(siteSafetyCtx, {
      operativeId: 'RD-001',
      qualification: 'CPCS 360 excavator (above 10t)',
      issuedAt: '2023-06-14',
      expiresAt: '2028-06-14',
      certificateHash: hash('rd001-cpcs-360'),
    });
    safety.recordCompetency(siteSafetyCtx, {
      operativeId: 'RD-003',
      qualification: 'NRSWA Streetworks Supervisor',
      issuedAt: '2022-11-02',
      // Expires inside the works, which is the case the permit check exists
      // to catch: it is checked against the permit's end date, not today's.
      expiresAt: '2027-02-02',
      certificateHash: hash('rd003-nrswa'),
    });

    // The risk register, quantified in money and days so contingency is
    // computed rather than chosen. The first two are the ones this job
    // actually turns on.
    safety.registerRisk(siteSafetyCtx, {
      id: '',
      title: 'Unrecorded services in the western verge',
      category: 'GROUND_CONDITIONS',
      probability: 0.55,
      costImpact: { optimistic: 1_200_000, mostLikely: 4_800_000, pessimistic: 16_000_000 },
      scheduleImpactDays: { optimistic: 3, mostLikely: 12, pessimistic: 35 },
      projectValueMinor: 410_000_000,
      projectDurationDays: 557,
      mitigations: [
        { description: 'Trial holes at 30m centres ahead of the face', costMinor: 900_000, probabilityReduction: 0.45, impactReduction: 0.35 },
      ],
    });
    const shutdownRisk = safety.registerRisk(siteSafetyCtx, {
      id: '',
      title: 'Night shutdown withdrawn or shortened by the water authority',
      // A programme risk rather than a commercial one: the money in it is
      // the standing time, and what it actually threatens is the tie-in
      // dates that everything after them hangs on.
      category: 'PROGRAMME',
      probability: 0.4,
      costImpact: { optimistic: 800_000, mostLikely: 3_600_000, pessimistic: 12_000_000 },
      scheduleImpactDays: { optimistic: 7, mostLikely: 21, pessimistic: 56 },
      projectValueMinor: 410_000_000,
      projectDurationDays: 557,
      mitigations: [
        { description: 'Confirm both shutdown windows in writing 8 weeks ahead', costMinor: 0, probabilityReduction: 0.5, impactReduction: 0.2 },
      ],
    });
    safety.registerRisk(siteSafetyCtx, {
      id: '',
      title: 'Highway authority refuses the reinstatement and requires full-width resurfacing',
      category: 'REGULATORY',
      probability: 0.25,
      costImpact: { optimistic: 2_000_000, mostLikely: 9_000_000, pessimistic: 24_000_000 },
      scheduleImpactDays: { optimistic: 4, mostLikely: 10, pessimistic: 25 },
      projectValueMinor: 410_000_000,
      projectDurationDays: 557,
    });

    // Progress, against evidence. The trench is ahead of the pipe, which is
    // what makes the productivity figure worth reading.
    planning.recordProgress(sitePmCtx, {
      taskId: siteTasks[0] as string,
      percentComplete: 100,
      elapsedDays: 15,
      evidenceDescription: 'Compound established, traffic management signed off by the highway authority',
      evidenceHash: hash('rossendale-establishment'),
    });
    planning.recordProgress(sitePmCtx, {
      taskId: siteTasks[1] as string,
      percentComplete: 100,
      elapsedDays: 26,
      evidenceDescription: 'Trial holes complete to chainage 620; western verge remains unproven',
      evidenceHash: hash('rossendale-trial-holes'),
    });
    planning.recordProgress(sitePmCtx, {
      taskId: siteTasks[2] as string,
      percentComplete: 62,
      elapsedDays: 41,
      evidenceDescription: 'Trench open to chainage 384, weekly survey',
      evidenceHash: hash('rossendale-trench-survey-w8'),
    });
    planning.recordProgress(sitePmCtx, {
      taskId: siteTasks[3] as string,
      percentComplete: 40,
      elapsedDays: 26,
      evidenceDescription: 'DN600 laid and jointed to chainage 248',
      evidenceHash: hash('rossendale-pipelaying-w8'),
    });

    // Ten working days of diary, unbroken. Two of them lost to weather and
    // one to the thing that is actually holding the job up.
    const siteDiary: Array<{ date: string; weather: planning.DiaryWeather; narrative: string; blockers?: string[] }> = [
      { date: '2026-08-03', weather: { conditions: 'Dry, bright', temperatureC: 21, workingStopped: false }, narrative: 'Trench progressed to chainage 296. Pipe jointing following at chainage 210.' },
      { date: '2026-08-04', weather: { conditions: 'Dry', temperatureC: 20, workingStopped: false }, narrative: 'Trench to chainage 318. Two pipe lengths lowered and jointed.' },
      { date: '2026-08-05', weather: { conditions: 'Heavy rain from 07:00', temperatureC: 14, workingStopped: true }, narrative: 'Trench flooded overnight. Dewatering only; no excavation or jointing.', blockers: ['Standing water in the open trench — pumps run from 07:00'] },
      { date: '2026-08-06', weather: { conditions: 'Showers, drying', temperatureC: 16, workingStopped: false }, narrative: 'Dewatering complete by 10:00. Trench resumed to chainage 334.' },
      { date: '2026-08-07', weather: { conditions: 'Dry', temperatureC: 19, workingStopped: false }, narrative: 'Trench to chainage 358. Jointing to chainage 232.' },
      { date: '2026-08-10', weather: { conditions: 'Dry, warm', temperatureC: 24, workingStopped: false }, narrative: 'Unrecorded duct struck at chainage 362. Excavation halted at the face pending the utility record.', blockers: ['Unrecorded duct at chainage 362 — statutory undertaker attending'] },
      { date: '2026-08-11', weather: { conditions: 'Dry', temperatureC: 22, workingStopped: false }, narrative: 'Duct identified as a disused BT subduct and removed under supervision. Excavation resumed after 14:00.' },
      { date: '2026-08-12', weather: { conditions: 'Dry', temperatureC: 21, workingStopped: false }, narrative: 'Trench to chainage 372. Chamber base blinded at chainage 300.' },
      { date: '2026-08-13', weather: { conditions: 'Persistent rain', temperatureC: 15, workingStopped: true }, narrative: 'No work in the trench. Gang stood down at 09:00 after the morning briefing.', blockers: ['Rainfall exceeded the working limit for open trench operations'] },
      { date: '2026-08-14', weather: { conditions: 'Dry, cloud', temperatureC: 18, workingStopped: false }, narrative: 'Trench to chainage 384. Jointing to chainage 248. Weekly survey taken.' },
    ];

    for (const day of siteDiary) {
      planning.recordSiteDiary(
        sitePmCtx,
        {
          diaryDate: day.date,
          weather: day.weather,
          labour: [
            { trade: 'Groundworks', headcount: 8, hours: day.weather.workingStopped ? 3 : 9 },
            { trade: 'Pipelaying', headcount: 5, hours: day.weather.workingStopped ? 3 : 9 },
            { trade: 'Traffic management', headcount: 2, hours: 10 },
            { trade: 'Site management', headcount: 2, hours: 10 },
          ],
          plant: [
            { description: '13t excavator', hoursWorked: day.weather.workingStopped ? 2 : 9, hoursIdle: day.weather.workingStopped ? 7 : 0, downtimeReason: day.weather.workingStopped ? 'Weather' : undefined },
            { description: 'Pipe handler', hoursWorked: day.weather.workingStopped ? 0 : 8, hoursIdle: day.weather.workingStopped ? 9 : 1 },
            { description: 'Dewatering pumps x2', hoursWorked: day.weather.workingStopped ? 9 : 2, hoursIdle: 0 },
          ],
          progressNarrative: day.narrative,
          workedTaskIds: [siteTasks[2] as string, siteTasks[3] as string],
          deliveries: ['DN600 ductile iron — 6 lengths to the laydown'],
          blockers: day.blockers,
          visitors: day.date === '2026-08-10' ? ['Statutory undertaker — buried services engineer'] : [],
          evidenceHash: hash(`rossendale-diary-${day.date}`),
        },
        new Date(`${day.date}T17:45:00.000Z`),
      );
    }

    // The constraint the fleet found: the western verge records. Raised
    // against the activity it actually holds up, and still open.
    planning.raiseConstraint(
      sitePlannerCtx,
      {
        taskId: siteTasks[4] as string,
        category: 'INFORMATION',
        description: 'Statutory undertaker records for the western verge not returned; chainage 620 to 1240 cannot be excavated to the approved method',
        owner: 'Meridian Design — utilities coordinator',
        needByDate: '2026-09-04',
      },
      new Date('2026-08-06T09:00:00.000Z'),
    );
    const tmConstraint = planning.raiseConstraint(
      sitePlannerCtx,
      {
        taskId: siteTasks[10] as string,
        category: 'ACCESS',
        description: 'Full-width carriageway closure for reinstatement not yet granted by the highway authority',
        owner: 'Meridian — site manager',
        needByDate: '2027-04-19',
      },
      new Date('2026-08-11T09:00:00.000Z'),
    );
    planning.closeConstraint(sitePlannerCtx, {
      constraintId: tmConstraint.constraintId,
      resolution: 'Closure permit granted for the April 2027 window, reference RBC/TM/2027/0118',
    });

    // Three weeks of Last Planner, so PPC is a trend and the recurring reason
    // is visible. It is the same reason as the open constraint above.
    //
    // The second half of the trench is never promised, because the platform
    // refuses a commitment against constrained work — COMMITMENT_CONSTRAINED,
    // naming the open information constraint. That refusal is the whole point
    // of a constraint log: the work stays in the lookahead, visible, with no
    // promise against it, rather than being promised and missed every week
    // while the PPC quietly records somebody else's failure.
    const siteWeeks: Array<{ start: string; commit: number[]; outcomes: Array<{ i: number; done: boolean; reason?: planning.NonCompletionReason }> }> = [
      { start: '2026-08-03', commit: [2, 3], outcomes: [{ i: 2, done: true }, { i: 3, done: true }] },
      // The duct strike on the 10th. Promised, not delivered, and the reason
      // is the one the diary records rather than a tidier one.
      { start: '2026-08-10', commit: [2, 3, 6], outcomes: [{ i: 2, done: false, reason: 'ACCESS' }, { i: 3, done: true }, { i: 6, done: true }] },
      // Two days lost to rain in the same week.
      { start: '2026-08-17', commit: [2, 3, 6], outcomes: [{ i: 2, done: false, reason: 'WEATHER' }, { i: 3, done: true }, { i: 6, done: false, reason: 'WEATHER' }] },
    ];
    let sitePpc = 0;
    for (const week of siteWeeks) {
      const plan = planning.publishLookahead(sitePlannerCtx, {
        weekStarting: week.start,
        plannedTaskIds: siteTasks.slice(0, 7) as string[],
        commitments: week.commit.map((i) => ({
          taskId: siteTasks[i] as string,
          promise: `Complete the planned quantity on ${String(platform.ledger.require({ refType: 'Task', refId: siteTasks[i] as string }).state.name)}`,
          promisedBy: 'Site manager',
          dueDate: week.start,
        })),
      });
      sitePpc = planning.reviewLookahead(sitePlannerCtx, {
        lookaheadId: plan.lookaheadId,
        outcomes: week.outcomes.map((o) => ({ taskId: siteTasks[o.i] as string, completed: o.done, reason: o.reason })),
      }).ppcPercent;
    }

    // Quality. An ITP agreed by both sides, then inspected against — one
    // pass, one failure that raises its own non-conformance.
    const sitePlan = quality.createInspectionPlan(siteQaqcCtx, {
      workPackageId: sitePackageId,
      title: 'DN600 trunk main — bedding, jointing and pressure test',
      discipline: 'CIVILS',
      specificationRef: 'WIS 4-01-01',
      stages: [
        { reference: 'T1', description: 'Trench formation and bedding before pipe is lowered', acceptanceCriteria: 'Formation firm, bedding 150mm Class S to WIS 4-08-02', type: 'HOLD', responsible: 'Engineer' },
        { reference: 'T2', description: 'Joint inspection before surround', acceptanceCriteria: 'Push-fit joints witnessed home to the witness mark', type: 'WITNESS', responsible: 'QA engineer' },
        { reference: 'T3', description: 'Pressure test to WIS 4-01-01', acceptanceCriteria: 'Hold 1.5x working pressure for 60 minutes with no measurable loss', type: 'HOLD', responsible: 'Engineer' },
        { reference: 'T4', description: 'Reinstatement layer check', acceptanceCriteria: 'HAUC specification, layer depths to the approved detail', type: 'REVIEW', responsible: 'QA engineer' },
      ],
    });
    quality.approveInspectionPlan(sitePmCtx, {
      planId: sitePlan.planId,
      approvedBy: pm.id,
      approvingRole: "Employer's Representative",
      note: 'Approved. Pressure test to be witnessed by the water authority as well as the Engineer.',
      evidenceHash: hashEvidence('rossendale-itp-approval'),
    });
    quality.recordInspection(siteQaqcCtx, {
      planId: sitePlan.planId,
      stageReference: 'T1',
      outcome: 'PASS',
      inspectedBy: qaqc.name,
      comments: 'Formation firm to chainage 248. Bedding depth checked at five points, all within tolerance.',
      evidenceHash: hash('rossendale-t1-chainage-248'),
    });
    // The release, which is a different act from the inspection and a
    // different authority. `recordInspection` refuses T2 outright while T1 is
    // passed but unreleased — "a hold point is a witness point with a
    // stronger word on it" otherwise — and the QA engineer who inspected it
    // cannot release it, so this is the project manager.
    qualitycontrol.releaseHoldPoint(sitePmCtx, {
      planId: sitePlan.planId,
      stageReference: 'T1',
      basis: 'Formation and bedding accepted to chainage 248; pipe may be lowered over this length.',
      evidenceHash: hash('rossendale-t1-release'),
    });

    quality.recordInspection(siteQaqcCtx, {
      planId: sitePlan.planId,
      stageReference: 'T2',
      outcome: 'FAIL',
      inspectedBy: qaqc.name,
      comments: 'Two joints at chainage 214 and 220 not home to the witness mark.',
      evidenceHash: hash('rossendale-t2-chainage-214'),
      nonConformance: {
        description: 'Two DN600 push-fit joints not fully home to the witness mark at chainage 214 and 220',
        severity: 'MAJOR',
        proposedAction: 'Excavate the surround, re-make both joints and re-witness before the section is pressure tested',
      },
    });

    // An RFI off the drawing, raised and answered late — which is what makes
    // the register worth keeping rather than a list of questions.
    const siteMarkup = bim.addMarkup(siteBimCtx, {
      drawingId: siteDrawingId,
      author: bimLead.name,
      note: 'Long section shows the main passing 300mm below the surface water sewer at chainage 596. Confirm clearance and whether a concrete surround is required.',
      region: { x: 0.55, y: 0.4, width: 0.09, height: 0.07 },
      convertTo: 'RFI',
    });
    if (siteMarkup.derivedId) {
      bim.answerRFI(
        siteBimCtx,
        {
          rfiId: siteMarkup.derivedId,
          answer:
            'Clearance is 300mm and is acceptable. Provide a full concrete surround to the trunk main for 3m either side of the crossing, detail per SK-118.',
          answeredBy: 'Meridian Design — lead civil engineer',
          changesDesign: true,
          evidenceHash: hash('rossendale-rfi-596-answer'),
        },
        new Date(Date.now() + 9 * 86_400_000),
      );
    }

    // Cost, against the baseline above. Two applications through the
    // statutory cycle so the certified-against-applied position is real.
    cost.postActualCost(siteQsCtx, { costCode: 'DIV.001', amountMinor: 44_600_000, date: '2026-08-31', sourceSystem: 'ERP', description: 'Establishment and traffic management to date' });
    cost.postActualCost(siteQsCtx, { costCode: 'DIV.002', amountMinor: 71_200_000, date: '2026-08-31', sourceSystem: 'ERP', description: 'Excavation and pipelaying to date' });
    cost.takeEVMSnapshot(siteQsCtx, { period: '2026-08', plannedValueMinor: 104_000_000 });

    // The weather risk rescored against what the diary actually recorded.
    // Two stopped days in ten is the evidence, and the contingency moves with
    // it rather than staying at the tender figure.
    safety.rescoreRisk(siteSafetyCtx, {
      riskId: shutdownRisk.riskId,
      probability: 0.3,
      // The impact ranges are restated rather than inherited, because a
      // rescore that carried them forward silently would let a probability
      // move while the exposure behind it was never looked at again.
      costImpact: { optimistic: 800_000, mostLikely: 3_600_000, pessimistic: 12_000_000 },
      scheduleImpactDays: { optimistic: 7, mostLikely: 18, pessimistic: 42 },
      reason: 'Both shutdown windows confirmed in writing by the water authority on 2026-08-12',
      projectValueMinor: 410_000_000,
      projectDurationDays: 557,
    });

    note(
      `Rossendale delivery record: ${siteTasks.length} activities on an approved baseline ` +
        `(${siteProgramme.projectDurationDays}d, P80 ${siteProgramme.p80DurationDays}d), cost baseline CB-01, ` +
        `CPP and RAMS approved, 5 inductions, 3 risks quantified, 10 diaries, PPC ${sitePpc}% ` +
        'in the latest week, an ITP with a failed stage and its NCR, and an RFI answered late',
    );
  }
  }

  } catch (error) {
    note(
      `Rossendale delivery record was not written: ${(error as Error).message}. The site history is written after ` +
        'the one step that can refuse, so nothing partial is on the chain, and the platform has started normally.',
    );
  }

  // --- A second region -------------------------------------------------------
  //
  // CONSTRUX is a worldwide platform and the demonstration estate was one
  // portfolio in one country, which makes every regional view a view of a
  // single row. A portfolio now has to name the region it operates in, and the
  // interesting thing about that model is not that the field exists — it is
  // what it refuses. This portfolio is regional rather than national: no
  // `countryCode`, because East Africa spans several jurisdictions and a
  // portfolio scoped to one country is a promise that contract law, tax and the
  // working calendar are common to everything inside it.
  //
  // `createProject` holds a project to its portfolio's region, so filing the
  // Nairobi project under the European portfolio is now refused rather than
  // silently producing a European rollup with a Kenyan job inside it.
  if (!portfolios().some((r) => r.state.name === 'East Africa Water Security')) {
    const { portfolioId: eastAfricaPortfolioId } = structure.createPortfolio(gov, {
      name: 'East Africa Water Security',
      enterpriseId: enterpriseId,
      governanceModel: 'Multilateral-funded, quarterly gate review with in-country oversight',
      continentCode: 'AF',
      city: 'Nairobi',
      targets: { budgetMinor: 2_400_000_000 },
      riskAppetite: { costTolerancePercent: 7, scheduleToleranceDays: 45 },
      reportingCadence: 'MONTHLY',
    });

    const { programmeId: eastAfricaProgrammeId } = structure.createProgramme(gov, {
      portfolioId: eastAfricaPortfolioId,
      name: 'Nairobi Bulk Water Resilience',
      objective: 'Secure dry-season supply for 4.2 million people across the Nairobi metropolitan area',
    });

    const nairobiProject = structure.createProject(gov, {
      portfolioId: eastAfricaPortfolioId,
      programmeId: eastAfricaProgrammeId,
      name: 'Northern Collector Tunnel — Phase 3',
      sectorType: 'UTILITIES',
      assetType: 'Raw water transfer tunnel',
      location: { continentCode: 'AF', countryCode: 'KE', city: 'Nairobi' },
      contractValueMinor: 1_260_000_000,
      currency: 'GBP',
      plannedStart: '2027-05-04',
      plannedCompletion: '2030-11-29',
    });
    note(
      `Second region: East Africa Water Security (AF) → Northern Collector Tunnel — Phase 3 ` +
        `(${nairobiProject.projectId}), at CONCEPT`,
    );
  }

  return { timeline };
}

async function seedDemoProjectInner(platform: Platform): Promise<SeedResult> {
  const timeline: string[] = [];
  const step = (message: string): void => {
    timeline.push(message);
  };

  // --- Platform operator onboards the tenant --------------------------------
  //
  // An existing operator is adopted rather than a second one invented. On a
  // fresh platform — every test, and a developer's laptop — there is none and
  // this creates the demonstration one exactly as before. On a deployment that
  // has already bootstrapped its real operator from `PLATFORM_OPERATOR_EMAIL`,
  // seeding the demonstration must not add `operator@construx.example` to the
  // platform's governance records beside them.
  const operator =
    platform.operators()[0] ??
    platform.createOperator({
      name: 'Ruth Okafor',
      email: 'operator@construx.example',
    });
  step(`Platform operator account: ${operator.name}`);

  const { tenant, subscription } = platform.createTenant({
    legalName: DEMO_TENANCY.legalName,
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
    enterpriseName: DEMO_TENANCY.enterpriseName,
  });
  step(`Tenant onboarded: ${tenant.legalName} on the ${subscription.tier} tier`);

  // Real AI work needs real credit; the trial grant alone will not carry a
  // whole lifecycle, and running out mid-demo is exactly what should happen
  // if it is not topped up.
  // Through the payment path, not a bare credit: the demonstration should show
  // the same route a real payment takes, and there is no longer any other.
  // The amount is configuration, not a constant. On a live deployment this
  // wallet is spendable by anyone who opens the demonstration, so the operator
  // decides how much of their AI budget that is worth.
  platform.creditFromPayment({
    tenantId: tenant.id,
    amountMinor: config.demo.acuCreditMinor,
    method: 'BANK_TRANSFER',
    reference: `SEED-${tenant.id}`,
    recordedBy: 'seed',
    note: 'Opening credit for the demonstration tenancy',
  });
  step('ACU wallet topped up with prepaid credit');

  // --- Enterprise admin creates the delivery team ---------------------------
  //
  // Every identity below is created through `demoUser`, which marks it as a
  // demonstration account. That mark is what the login route reads before it
  // will return a one-time code in a response rather than emailing it, and it
  // is the only thing separating an address anybody may sign in as from a
  // customer's. It is set here, in the seed, and nowhere else in the platform.
  const demoUser = (input: { name: string; email: string; roles: Role[] }) =>
    platform.createUser({ ...input, tenantId: tenant.id, demonstration: true });

  // People have names, and the demonstration team used to be called after its
  // own job titles: `Project Manager`, `Quantity Surveyor`, `Site Manager`.
  //
  // That is not a cosmetic point. The role is already carried separately on
  // every identity and rendered beside the name wherever the console shows one,
  // so a name that repeats it says nothing twice and leaves every screen —
  // owner of a decision, author of a comment, who signed the permit — reading
  // like a org chart with nobody in it. The morning briefing made it plainest:
  // it greeted the signed-in user by their first name and said
  // "Good morning, Project."
  //
  // These are ordinary names for an ordinary UK infrastructure team. Nothing
  // else about the seed changed; the roles, permissions and every assertion
  // that turns on them are untouched.

  const admin = demoUser({
    name: 'Amara Osei',
    email: 'amara.osei@meridian.example',
    roles: ['ENTERPRISE_ADMIN'],
  });
  const owner = demoUser({ name: 'Priya Raghunathan', email: 'owner@meridian.example', roles: ['OWNER'] });
  const pm = demoUser({ name: 'Tom Bramall', email: DEMO_TENANCY.primaryEmail, roles: ['PM'] });
  const qs = demoUser({ name: 'Nadia Hussain', email: 'qs@meridian.example', roles: ['QS'] });
  const planner = demoUser({ name: 'Gareth Lloyd', email: 'planner@meridian.example', roles: ['PLANNER'] });
  const safetyLead = demoUser({ name: 'Marie Okonkwo', email: 'hse@meridian.example', roles: ['SAFETY'] });
  const bimLead = demoUser({ name: 'Callum Frazer', email: 'bim@meridian.example', roles: ['BIM'] });
  // The demonstration had no design approver at all. `DESIGNER` and
  // `PRINCIPAL_DESIGNER` both hold approve on design information and neither was
  // on the project, so a design could be authored, marked up and questioned —
  // and never accepted by anybody. The review cycle made that visible; it was
  // true before it.
  const designLead = demoUser({
    name: 'Elena Vasquez',
    email: 'design@meridian.example',
    roles: ['DESIGNER'],
  });
  const qaqc = demoUser({ name: 'Rob Whitfield', email: 'qaqc@meridian.example', roles: ['QAQC'] });
  // The person who runs the site.
  //
  // Missing, and its absence was the reason the Construction screen looked shut
  // to anybody senior: the PM holds read-only on SAFETY_RAMS, so on a live
  // project a Project Manager could see the permit register and issue nothing
  // into it, and there was no seat between them and the Supervisor that could.
  // This is the seat that approves the method statement, issues the permit and
  // sequences the week — and answers for the site to an inspector who walks on.
  const constructionManager = demoUser({
    name: 'Ade Fowler',
    email: 'construction@meridian.example',
    roles: ['CONSTRUCTION_MANAGER'],
  });
  // The site manager. Absent until the Construction screen was built, and the
  // absence mattered: SUPERVISOR is the role that holds C and U on SAFETY_RAMS,
  // QUALITY_COMMISSIONING and FIELD_EXECUTION — it issues the permits, records
  // the inductions, creates the inspection plans and raises the
  // non-conformances. Every one of those paths existed in the matrix and could
  // not be walked by anybody on the demonstration project.
  const siteManager = demoUser({
    name: 'Steve Mullen',
    email: 'site@meridian.example',
    roles: ['SUPERVISOR'],
  });
  const fm = demoUser({ name: 'Janet Kirkbride', email: 'fm@meridian.example', roles: ['FM'] });
  const regulator = demoUser({ name: 'Helen Marsh', email: 'regulator@meridian.example', roles: ['REGULATOR'] });
  step('Eleven named identities assigned across the delivery team');

  const adminAuth = authOf(platform, admin.id);
  const governanceCtx = contextFor(platform, adminAuth, `${tenant.id}-governance`);

  // --- BUSINESS DEVELOPMENT --------------------------------------------------
  // The head of the chain. Before there is a project to run there is a decision
  // about whether to chase the job at all, and that decision is where money is
  // made or lost long before anybody prices anything.
  const opportunities: Array<{
    title: string;
    clientName: string;
    sectorType: structure.SectorType;
    valueMinor: number;
    source: string;
    scores: business.QualificationScores;
    bid: boolean;
    rationale: string;
  }> = [
    {
      title: DEMO_TENANCY.projectName,
      clientName: 'Northern Water Authority',
      sectorType: 'UTILITIES',
      valueMinor: 1_850_000_000,
      source: 'Framework mini-competition',
      scores: {
        relevantExperience: 5, clientAttractiveness: 5, contractSize: 4, geography: 5, supplyChainCapacity: 4,
        competition: 4, marginOpportunity: 4, cashflowRisk: 4, strategicValue: 5, winProbability: 4,
      },
      bid: true,
      rationale: 'Phase 1 delivered for the same client; framework position and local supply chain both strong',
    },
    {
      title: 'Coastal outfall renewal, Whitby',
      clientName: 'Coastal Drainage Board',
      sectorType: 'UTILITIES',
      valueMinor: 620_000_000,
      source: 'Tender portal',
      scores: {
        relevantExperience: 3, clientAttractiveness: 3, contractSize: 3, geography: 1, supplyChainCapacity: 2,
        competition: 2, marginOpportunity: 3, cashflowRisk: 3, strategicValue: 2, winProbability: 2,
      },
      bid: false,
      rationale: 'Two hours outside the operating patch with no local supply chain, in an open field of eight',
    },
    {
      title: 'Speculative office fit-out, Leeds',
      clientName: 'Aldgate Developments',
      sectorType: 'COMMERCIAL',
      valueMinor: 84_000_000,
      source: 'Cold approach',
      scores: {
        relevantExperience: 2, clientAttractiveness: 1, contractSize: 2, geography: 3, supplyChainCapacity: 2,
        competition: 2, marginOpportunity: 2, cashflowRisk: 1, strategicValue: 2, winProbability: 2,
      },
      bid: false,
      rationale: 'Unknown developer, 60-day payment terms and 10% retention on a job we would be funding throughout',
    },
    {
      title: 'Reservoir spillway strengthening, Kielder',
      clientName: 'Northern Water Authority',
      sectorType: 'UTILITIES',
      valueMinor: 940_000_000,
      source: 'Repeat client',
      scores: {
        relevantExperience: 3, clientAttractiveness: 4, contractSize: 4, geography: 3, supplyChainCapacity: 3,
        competition: 3, marginOpportunity: 2, cashflowRisk: 4, strategicValue: 4, winProbability: 3,
      },
      bid: true,
      rationale: 'Director review cleared it: repeat client and a programme that fits the gap after Ashworth',
    },
    {
      title: 'Marine berth reconstruction, Immingham',
      clientName: 'Humber Ports Group',
      sectorType: 'TRANSPORT',
      valueMinor: 2_300_000_000,
      source: 'Invitation',
      scores: {
        relevantExperience: 1, clientAttractiveness: 4, contractSize: 2, geography: 2, supplyChainCapacity: 2,
        competition: 3, marginOpportunity: 4, cashflowRisk: 3, strategicValue: 4, winProbability: 2,
      },
      // Against the recommendation, deliberately — so the override report has
      // something real in it and the decision carries the name of whoever made it.
      bid: true,
      rationale: 'Entry into marine works accepted as a strategic loss-leader; board minute 2026-03-11',
    },
  ];

  let declined = 0;
  for (const opportunity of opportunities) {
    const { opportunityId } = business.registerOpportunity(governanceCtx, {
      title: opportunity.title,
      clientName: opportunity.clientName,
      sectorType: opportunity.sectorType,
      estimatedValueMinor: opportunity.valueMinor,
      source: opportunity.source,
      countryCode: 'GB',
    });
    business.qualifyOpportunity(governanceCtx, opportunityId, opportunity.scores);
    const decision = business.decideBidNoBid(governanceCtx, opportunityId, {
      bid: opportunity.bid,
      rationale: opportunity.rationale,
      // An override needs the authority it was taken under named. The demo
      // carries one deliberate override, so it carries one delegated authority
      // — which is what the record is supposed to look like, not an exception.
      authority: { delegatedTo: 'Managing Director', reference: 'Scheme of delegation, section 4 — bid approval' },
    });
    if (!opportunity.bid) declined += 1;
    if (decision.againstRecommendation) {
      step(`  ${opportunity.title} was bid against the algorithm's recommendation — recorded as an override`);
    }
  }
  const discipline = business.bidDiscipline(governanceCtx);
  step(
    `Pipeline qualified: ${opportunities.length} opportunities scored, ${declined} declined ` +
      `(${discipline.noBidRatePercent}%), ${discipline.overrides.length} override recorded`,
  );

  // --- THE COMPANY'S OWN FACTS -----------------------------------------------
  // Everything the radar asserts traces here. Without it the radar refuses to
  // screen anything rather than inventing what the business can claim.
  radar.setCompanyProfile(governanceCtx, {
    legalName: 'Meridian Infrastructure Group Ltd',
    turnoverMinorByYear: [8_400_000_000, 7_100_000_000, 6_300_000_000],
    netAssetsMinor: 1_950_000_000,
    workingCapitalMinor: 900_000_000,
    regions: ['Manchester', 'Leeds', 'Liverpool', 'Sheffield', 'Hexham'],
    sectors: ['UTILITIES', 'TRANSPORT', 'COMMERCIAL'],
    cpvCodes: ['45232400', '45252100', '45231300'],
    valueBandMinor: { min: 500_000_00, max: 4_000_000_000 },
    insurances: [
      { type: 'Public liability', limitMinor: 1_000_000_000, expiresOn: '2027-03-31' },
      { type: 'Employers liability', limitMinor: 1_000_000_000, expiresOn: '2027-03-31' },
      { type: 'Professional indemnity', limitMinor: 500_000_000, expiresOn: '2027-03-31' },
    ],
    accreditations: ['CHAS', 'Constructionline Gold', 'ISO 9001', 'ISO 45001'],
    references: [
      { clientName: 'Northern Water Authority', projectName: 'Ashworth WTW Phase 1', sector: 'TRANSPORT', valueMinor: 1_400_000_000, completedYear: 2024, verified: true },
      { clientName: 'Coastal Drainage Board', projectName: 'Seaton pumping station', sector: 'TRANSPORT', valueMinor: 620_000_000, completedYear: 2023, verified: true },
      { clientName: 'Pennine Councils', projectName: 'Depot rationalisation', sector: 'COMMERCIAL', valueMinor: 310_000_000, completedYear: 2023, verified: true },
    ],
    selfDeliveredTrades: ['GROUNDWORKS', 'CONCRETE', 'DRAINAGE'],
    targetMarginPercent: { min: 8, max: 12 },
    capacity: { concurrentProjects: 8, committedProjects: 6 },
  });

  const radarRun = radar.runRadar(governanceCtx, {
    today: '2026-03-02',
    notices: [
      {
        reference: 'FTS-2026-11842',
        title: 'Reservoir spillway strengthening, Kielder',
        clientName: 'Northern Water Authority',
        region: 'Hexham',
        sector: 'TRANSPORT',
        cpvCodes: ['45232400'],
        estimatedValueMinor: 940_000_000,
        durationWeeks: 74,
        deadline: '2026-04-17',
        scope: 'Strengthening of the existing spillway chute and stilling basin, including anchor installation',
        requirements: {
          minimumTurnoverMinor: 5_000_000_000,
          insurances: [{ type: 'Public liability', minimumLimitMinor: 1_000_000_000 }],
          accreditations: ['CHAS'],
          experience: [{ sector: 'TRANSPORT', minimumProjects: 2, minimumValueMinor: 500_000_000 }],
        },
        estimatedBidders: 4,
        source: 'Find a Tender',
      },
      {
        reference: 'FTS-2026-11903',
        title: 'Secondary school refurbishment, Birmingham',
        clientName: 'Midlands Education Trust',
        region: 'Birmingham',
        sector: 'COMMERCIAL',
        estimatedValueMinor: 38_000_000,
        durationWeeks: 14,
        deadline: '2026-03-27',
        scope: 'Refurbishment of teaching blocks including M&E replacement and fire compartmentation',
        requirements: {
          minimumTurnoverMinor: 1_000_000_000,
          accreditations: ['CHAS'],
          experience: [{ sector: 'COMMERCIAL', minimumProjects: 3 }],
        },
        estimatedBidders: 6,
        source: 'Contracts Finder',
      },
      {
        reference: 'FTS-2026-11855',
        title: 'Trunk road widening, M62 J20-22',
        clientName: 'National Highways',
        region: 'Rochdale',
        sector: 'TRANSPORT',
        estimatedValueMinor: 18_000_000_000,
        durationWeeks: 156,
        deadline: '2026-05-08',
        scope: 'Widening and structures renewal across three junctions',
        requirements: {
          minimumTurnoverMinor: 40_000_000_000,
          accreditations: ['CHAS', 'ISO 14001'],
        },
        estimatedBidders: 5,
        source: 'Find a Tender',
      },
      {
        reference: 'LOC-2026-0442',
        title: 'Water treatment inlet works, Liverpool',
        clientName: 'Mersey Water',
        region: 'Liverpool',
        sector: 'TRANSPORT',
        cpvCodes: ['45252100'],
        estimatedValueMinor: 2_100_000_000,
        durationWeeks: 88,
        deadline: '2026-03-09',
        scope: 'New inlet works, screening and flow control',
        requirements: {
          minimumTurnoverMinor: 6_000_000_000,
          insurances: [{ type: 'Professional indemnity', minimumLimitMinor: 500_000_000 }],
          experience: [{ sector: 'TRANSPORT', minimumProjects: 2 }],
        },
        estimatedBidders: 12,
        source: 'Client framework',
      },
      {
        reference: 'FTS-2026-11720',
        title: 'Hospital energy centre, Norwich',
        clientName: 'East Anglia NHS Trust',
        region: 'Norwich',
        sector: 'COMMERCIAL',
        estimatedValueMinor: 620_000_000,
        durationWeeks: 62,
        deadline: '2026-04-30',
        scope: 'New energy centre including CHP and district heating connections',
        requirements: {
          minimumTurnoverMinor: 3_000_000_000,
          accreditations: ['CHAS', 'ISO 14001'],
          experience: [{ sector: 'COMMERCIAL', minimumProjects: 2, minimumValueMinor: 400_000_000 }],
        },
        estimatedBidders: 8,
        source: 'Find a Tender',
      },
    ],
  });
  step(
    `Radar screened ${radarRun.screened} notices: ${radarRun.shortlist.length} worth reading, ` +
      `${radarRun.filteredOut} filtered out before anybody opened them`,
  );
  for (const observation of radarRun.observations.slice(1)) step(`  ${observation}`);

  // --- CONCEPT ---------------------------------------------------------------
  const { portfolioId } = structure.createPortfolio(governanceCtx, {
    name: DEMO_TENANCY.portfolioName,
    enterpriseId: tenant.enterpriseId as string,
    governanceModel: 'DFI-funded, quarterly gate review',
    continentCode: 'EU',
    countryCode: 'GB',
    city: 'Manchester',
    targets: { budgetMinor: 4_500_000_000, targetCompletionDate: '2029-03-31' },
    riskAppetite: { costTolerancePercent: 4, scheduleToleranceDays: 21 },
    reportingCadence: 'MONTHLY',
  });

  const { programmeId } = structure.createProgramme(governanceCtx, {
    portfolioId,
    name: 'Northern Treatment Upgrades',
    objective: 'Raise treatment capacity by 40% across three catchments',
  });

  const { projectId } = structure.createProject(governanceCtx, {
    portfolioId,
    programmeId,
    name: DEMO_TENANCY.projectName,
    sectorType: 'UTILITIES',
    assetType: 'Water treatment facility',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Manchester' },
    contractValueMinor: 1_850_000_000,
    currency: 'GBP',
    plannedStart: '2026-04-01',
    plannedCompletion: '2028-09-30',
  });
  step(`Portfolio → programme → project created (project ${projectId})`);

  const pmCtx = contextFor(platform, authOf(platform, pm.id), projectId);
  const qsCtx = contextFor(platform, authOf(platform, qs.id), projectId);
  const plannerCtx = contextFor(platform, authOf(platform, planner.id), projectId);
  const safetyCtx = contextFor(platform, authOf(platform, safetyLead.id), projectId);
  const bimCtx = contextFor(platform, authOf(platform, bimLead.id), projectId);
  const qaqcCtx = contextFor(platform, authOf(platform, qaqc.id), projectId);
  const fmCtx = contextFor(platform, authOf(platform, fm.id), projectId);
  const ownerCtx = contextFor(platform, authOf(platform, owner.id), projectId);

  const { packageId } = structure.createScopePackage(pmCtx, {
    name: 'Civils and process structures',
    discipline: 'CIVILS',
    scopeOfWorks:
      'Construction of inlet works, two 40m diameter clarifiers, filter gallery substructure and associated process pipework, including all temporary works, dewatering and reinstatement.',
    inclusions: ['Bulk excavation', 'Reinforced concrete structures', 'Process pipework to interface points', 'Reinstatement'],
    exclusions: ['Mechanical plant supply', 'Permanent power supply', 'Off-site diversions'],
    acceptanceCriteria: ['Watertightness testing to BS EN 1992-3', 'Concrete cube results at 28 days', 'As-built survey within tolerance'],
    estimatedValueMinor: 920_000_000,
    designResponsibility: 'SHARED',
  });
  step('Scope package defined — CONCEPT gate satisfied');

  // --- CONCEPT, stage 6: C-WF-01 to C-WF-08 ---------------------------------
  //
  // The stage walked properly rather than skipped. Before this, the seed created
  // a project, defined one scope package and moved straight to design — which
  // satisfied the coarse lifecycle gate and left the whole of stage 6 empty, so
  // the Concept screen showed seven blank panels and a failing 6.4 gate on a
  // project that had reached operations.
  //
  // Every command below runs under a role that actually holds the authority for
  // it, so the walk exercises the permission matrix rather than bypassing it.
  // The party separation the gate checks is real: the brief is baselined by the
  // enterprise admin, the option is selected by the client representative, and
  // the controls are approved by the admin again — three acts, not one person
  // signing their own homework.

  const adminProjectCtx = contextFor(platform, adminAuth, projectId);
  const designCtx = contextFor(platform, authOf(platform, designLead.id), projectId);

  /** A date `days` from now, as an ISO day. Relative so a re-seed never goes stale. */
  const relative = (days: number): string =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  /**
   * The design freeze, named once.
   *
   * Two things depend on it: the milestone on the concept programme, and the
   * date the gate's conditions fall due. They are the same date because the
   * condition text says so — "before the design gate" — and a second literal
   * would let them drift.
   */
  const designFreezeDate = relative(190);

  // C-WF-01 — configuration and delegated authority.
  conceptinitiation.versionConfiguration(adminProjectCtx, {
    projectCode: 'AWT-P2',
    jurisdiction: 'GB',
    jurisdictionPack: 'GB-2026.1',
    classificationPack: 'UNICLASS-2015',
    contractCalendarPack: 'NEC4-2017',
    calendar: {
      timeZone: 'Europe/London',
      workingDays: [1, 2, 3, 4, 5],
      holidays: ['2026-12-25', '2026-12-26', '2027-01-01'],
    },
    reportingCurrency: 'GBP',
    measurementSystem: 'METRIC',
    sponsorId: owner.id,
    projectDirectorId: pm.id,
    dataResidency: 'UK',
    retentionYears: 12,
    defaultSensitivity: 'INTERNAL',
    reason: 'Project set up under the client’s water-sector governance model',
  });
  conceptinitiation.approveAuthorityMatrix(ownerCtx, {
    delegations: [
      { decision: 'Approve the concept baseline and the stage gate', holderId: owner.id },
      {
        decision: 'Commit expenditure against the approved cost plan',
        holderId: pm.id,
        limitMinor: 25_000_000,
        escalatesToId: owner.id,
      },
      {
        decision: 'Accept a design deliverable',
        holderId: designLead.id,
        limitMinor: 5_000_000,
        escalatesToId: pm.id,
      },
      { decision: 'Confirm statutory applicability', holderId: safetyLead.id },
    ],
  });
  step('C-WF-01 — project configured (AWT-P2, Europe/London, GBP) and authority delegated');

  // C-WF-02 — the brief. Six requirements, one of them superseded before the
  // baseline because the client consolidated two of their own.
  const briefRequirement = (input: {
    reference: string;
    category: Parameters<typeof conceptbrief.extractRequirement>[1]['category'];
    statement: string;
    sourceAnchor: string;
    priority: Parameters<typeof conceptbrief.extractRequirement>[1]['priority'];
    method: string;
    stage: string;
    acceptanceCriteria: string;
    ownerId: string;
    origin?: 'AI' | 'HUMAN';
    confidence?: number;
  }) =>
    conceptbrief.extractRequirement(adminProjectCtx, {
      reference: input.reference,
      category: input.category,
      statement: input.statement,
      source: 'Northern Water Authority outline business case, rev C',
      sourceAnchor: input.sourceAnchor,
      ownerId: input.ownerId,
      priority: input.priority,
      verification: { method: input.method, stage: input.stage },
      acceptanceCriteria: input.acceptanceCriteria,
      origin: input.origin ?? 'HUMAN',
      confidence: input.confidence,
    });

  const reqCapacity = briefRequirement({
    reference: 'REQ-001',
    category: 'CAPACITY',
    statement: 'The works shall treat a peak flow of 1,150 l/s to the consented discharge standard.',
    sourceAnchor: 'p12, §2.1',
    priority: 'MANDATORY',
    method: 'Witnessed 72-hour performance test at peak flow',
    stage: 'COMMISSIONING',
    acceptanceCriteria: 'Measured throughput at or above 1,150 l/s with consent parameters met throughout',
    ownerId: pm.id,
  });
  const reqAvailability = briefRequirement({
    reference: 'REQ-002',
    category: 'RESILIENCE',
    statement: 'The treatment stream shall remain available with any single clarifier out of service.',
    sourceAnchor: 'p14, §2.6',
    priority: 'MANDATORY',
    method: 'Design review against N-1 loading, re-verified on the as-built hydraulic model',
    stage: 'DESIGN',
    acceptanceCriteria: 'Hydraulic model shows consent compliance at peak flow with one clarifier isolated',
    ownerId: designLead.id,
  });
  const reqCarbon = briefRequirement({
    reference: 'REQ-003',
    category: 'CARBON',
    statement: 'Capital carbon shall be at least 20% below the PAS 2080 baseline for a scheme of this type.',
    sourceAnchor: 'p21, §4.3',
    priority: 'HIGH',
    method: 'PAS 2080 assessment at design freeze and again from as-built quantities',
    stage: 'HANDOVER',
    acceptanceCriteria: 'Assessed capital carbon at or below 80% of the stated baseline',
    ownerId: designLead.id,
  });
  const reqMaintain = briefRequirement({
    reference: 'REQ-004',
    category: 'MAINTAINABILITY',
    statement: 'Every item of rotating plant shall be removable without breaking into a process structure.',
    sourceAnchor: 'p18, §3.4',
    priority: 'HIGH',
    method: 'Maintenance access review with the operator, walked on site before practical completion',
    stage: 'HANDOVER',
    acceptanceCriteria: 'Operator signs the access review with no unresolved item',
    ownerId: fm.id,
  });
  // Extracted by the document agent from the business case, at high confidence,
  // and still accepted by a person before it counts.
  const reqAccess = briefRequirement({
    reference: 'REQ-005',
    category: 'ACCESSIBILITY',
    statement: 'Operational walkways and control rooms shall meet Part M and the client’s own access standard.',
    sourceAnchor: 'p26, §5.2',
    priority: 'MANDATORY',
    method: 'Access audit against Part M by a competent assessor',
    stage: 'CONSTRUCTION',
    acceptanceCriteria: 'Audit closed with no category A finding',
    ownerId: designLead.id,
    origin: 'AI',
    confidence: 0.91,
  });
  const reqDuplicate = briefRequirement({
    reference: 'REQ-006',
    category: 'CAPACITY',
    statement: 'The works shall handle peak storm flow without discharge to the watercourse.',
    sourceAnchor: 'p13, §2.3',
    priority: 'MANDATORY',
    method: 'Witnessed performance test',
    stage: 'COMMISSIONING',
    acceptanceCriteria: 'No discharge recorded at peak storm flow',
    ownerId: pm.id,
  });

  for (const created of [reqCapacity, reqAvailability, reqCarbon, reqMaintain, reqAccess]) {
    conceptbrief.acceptRequirement(ownerCtx, { requirementId: created.requirementId });
  }
  // Superseded rather than deleted, and before the baseline so the frozen set is
  // clean. The reason is the record that it was dropped on purpose.
  conceptbrief.supersedeRequirement(ownerCtx, {
    requirementId: reqDuplicate.requirementId,
    reason:
      'Consolidated into REQ-001 after the client confirmed the storm case is bounded by the same peak flow figure.',
    replacedByRequirementId: reqCapacity.requirementId,
  });
  const brief = conceptbrief.baselineBrief(adminProjectCtx, { evidenceHash: hashEvidence('awt-p2-brief-rev-c') });
  step(`C-WF-02 — brief baselined: ${brief.requirements} requirements frozen with their hashes`);

  // C-WF-03 — due diligence. Coverage is measured over impact categories, so
  // four surveys between them establish what is known; heritage is left
  // deliberately open with an investigation against it, which is the honest
  // state of a concept-stage site.
  const giSurvey = conceptduediligence.registerSurvey(adminProjectCtx, {
    reference: 'GI-2026-01',
    discipline: 'Geotechnical',
    author: 'Pennine Ground Engineering Ltd',
    surveyedOn: relative(-120),
    coverage: ['GROUND', 'CONTAMINATION', 'STRUCTURAL'],
    coordinateSystem: 'EPSG:27700',
    limitations:
      'Twelve boreholes to 18m across the western two-thirds of the site. No access east of the existing filter gallery while it remained in service; no rotary coring below 18m.',
    evidenceHash: hashEvidence('awt-p2-gi-2026-01'),
  });
  const topoSurvey = conceptduediligence.registerSurvey(adminProjectCtx, {
    reference: 'TOPO-2026-01',
    discipline: 'Topographic and utility',
    author: 'Meridian Survey Services',
    surveyedOn: relative(-95),
    coverage: ['ACCESS', 'UTILITIES', 'OPERATIONAL'],
    coordinateSystem: 'EPSG:27700',
    limitations:
      'Above-ground detail and PAS 128 quality level B for buried services. No excavation; QL-A verification not carried out.',
    evidenceHash: hashEvidence('awt-p2-topo-2026-01'),
  });
  const ecoSurvey = conceptduediligence.registerSurvey(adminProjectCtx, {
    reference: 'ECO-2026-01',
    discipline: 'Ecology and flood risk',
    author: 'Calder Environmental',
    surveyedOn: relative(-70),
    coverage: ['ECOLOGY', 'FLOOD', 'AIR_QUALITY'],
    coordinateSystem: 'EPSG:27700',
    limitations:
      'Single-season walkover. Bat and great crested newt surveys are seasonally constrained and must be repeated before works start.',
    // Ecology expires: a protected-species survey is a statement about a season.
    validUntil: relative(300),
    evidenceHash: hashEvidence('awt-p2-eco-2026-01'),
  });
  const planningSurvey = conceptduediligence.registerSurvey(adminProjectCtx, {
    reference: 'PLAN-2026-01',
    discipline: 'Planning and neighbour context',
    author: 'Meridian Infrastructure Group',
    surveyedOn: relative(-60),
    coverage: ['PLANNING', 'NEIGHBOUR'],
    coordinateSystem: 'NONE',
    limitations: 'Desk study of the local plan and pre-application correspondence only. No formal consultation held.',
    evidenceHash: hashEvidence('awt-p2-planning-2026-01'),
  });

  const conMadeGround = conceptduediligence.identifyConstraint(adminProjectCtx, {
    reference: 'CON-001',
    description:
      'Made ground with obstructions to 4.5m across the northern half of the site, on the footprint of the two new clarifiers.',
    constraintClass: 'HARD',
    severity: 'CRITICAL',
    impacts: ['GROUND', 'STRUCTURAL'],
    spatialScope: 'Northern half, clarifier footprint',
    geometryRef: 'AWT-P2/ZONE/NORTH',
    surveyId: giSurvey.surveyId,
    ownerId: designLead.id,
  });
  const conServices = conceptduediligence.identifyConstraint(adminProjectCtx, {
    reference: 'CON-002',
    description:
      'A 33kV feed and the site’s only potable main cross the proposed access road on the alignment shown at PAS 128 QL-B.',
    constraintClass: 'HARD',
    severity: 'MAJOR',
    impacts: ['UTILITIES', 'ACCESS'],
    spatialScope: 'Proposed site access, chainage 0 to 120m',
    geometryRef: 'AWT-P2/SERVICES/ACCESS',
    surveyId: topoSurvey.surveyId,
    ownerId: pm.id,
  });
  const conDeepGround = conceptduediligence.identifyConstraint(adminProjectCtx, {
    reference: 'CON-003',
    description:
      'Ground below 18m is unproven. The boreholes stopped there and the clarifier piles are expected to bear at 22m.',
    constraintClass: 'ASSUMPTION',
    severity: 'MAJOR',
    impacts: ['GROUND'],
    spatialScope: 'Clarifier pile founding stratum',
    surveyId: giSurvey.surveyId,
    ownerId: designLead.id,
  });
  const conOutage = conceptduediligence.identifyConstraint(adminProjectCtx, {
    reference: 'CON-004',
    description:
      'The existing works cannot be taken out of service. All tie-ins must be made within two 12-hour outages agreed a season in advance.',
    constraintClass: 'HARD',
    severity: 'CRITICAL',
    impacts: ['OPERATIONAL', 'ACCESS'],
    spatialScope: 'Existing inlet and filter gallery interfaces',
    surveyId: topoSurvey.surveyId,
    ownerId: fm.id,
  });

  conceptduediligence.assessConstraint(ownerCtx, {
    constraintId: conMadeGround.constraintId,
    assessment:
      'Piled foundations assumed throughout the northern half; obstruction removal priced in the substructure line. The alternative — dig and replace — was rejected on programme.',
  });
  conceptduediligence.assessConstraint(ownerCtx, {
    constraintId: conServices.constraintId,
    assessment:
      'Access road realigned 18m south to clear both services. Diversion avoided; a QL-A verification is required before the road is set out.',
  });
  conceptduediligence.assessConstraint(ownerCtx, {
    constraintId: conDeepGround.constraintId,
    assessment:
      'Carried as a quantified allowance pending rotary coring to 30m in the design stage. If the founding stratum is deeper the pile lengths change, not the concept.',
    allowanceMinor: 18_000_000,
  });
  conceptduediligence.assessConstraint(ownerCtx, {
    constraintId: conOutage.constraintId,
    assessment:
      'Two outages secured in principle with the operator for weeks 61 and 78. Sequence built around them, and the milestone programme carries them as fixed dates.',
  });

  // Heritage is uncovered and the register says so, rather than the readiness
  // figure quietly averaging it away.
  const heritageAction = conceptduediligence.assignInvestigation(adminProjectCtx, {
    reference: 'INV-001',
    description:
      'Commission an archaeological desk-based assessment. The site adjoins a scheduled monument buffer and no heritage evidence exists.',
    coverageGap: 'HERITAGE',
    ownerId: pm.id,
    dueDate: relative(75),
  });
  conceptduediligence.assignInvestigation(adminProjectCtx, {
    reference: 'INV-002',
    description: 'Rotary coring to 30m at four clarifier pile positions to close CON-003.',
    constraintId: conDeepGround.constraintId,
    ownerId: designLead.id,
    dueDate: relative(110),
  });
  conceptduediligence.reviewDueDiligence(ownerCtx, {
    note:
      'Coverage is sufficient to select an option. Heritage and the deep founding stratum are both carried as open investigations with named owners; neither changes the choice between the options assessed.',
  });
  step(
    `C-WF-03 — 4 surveys, 4 constraints assessed, 2 investigations open; readiness ` +
      `${conceptduediligence.dueDiligenceReadiness(adminProjectCtx).percent}% by evidence coverage`,
  );

  // C-WF-04 — three options on one evaluation template, one common base date.
  const optionCriteria = (capital: number, operability: number, carbon: number, deliverability: number) => [
    { criterion: 'CAPITAL_COST', rawValue: capital, weight: 0.35, basis: 'Benchmarked against three comparable AMP8 schemes, normalised to this base date' },
    { criterion: 'OPERABILITY', rawValue: operability, weight: 0.25, basis: 'Written assessment by the client’s operations team' },
    { criterion: 'CAPITAL_CARBON', rawValue: carbon, weight: 0.2, basis: 'PAS 2080 desktop estimate at concept quantities' },
    { criterion: 'DELIVERABILITY', rawValue: deliverability, weight: 0.2, basis: 'Assessed against the outage constraint and the market’s capacity in the region' },
  ];
  const conceptBaseDate = relative(-30);

  const optRefurb = conceptoptions.createOption(adminProjectCtx, {
    reference: 'OPT-A',
    name: 'Refurbish and extend in place',
    description: 'Retain the existing inlet and filter gallery, add two clarifiers on the northern plot.',
    scopeStatement:
      'IN: two new clarifiers, inlet refurbishment, filter gallery refurbishment, process pipework, access road. OUT: permanent power upgrade, off-site network reinforcement.',
    assumptions: [
      'The existing filter gallery structure is serviceable for a further 30 years',
      'Two 12-hour outages are obtainable in the programmed weeks',
      'Piles bear at 22m',
    ],
    exclusions: ['Permanent power upgrade', 'Off-site network reinforcement', 'Land acquisition'],
    dependencies: ['Outage agreement with the operator', 'Discharge consent variation'],
    baseDate: conceptBaseDate,
    currency: 'GBP',
    orderOfCostMinor: 1_850_000_000,
    costLowMinor: 1_620_000_000,
    costHighMinor: 2_240_000_000,
    durationDaysLow: 760,
    durationDaysMostLikely: 880,
    durationDaysHigh: 1_090,
  });
  const optNewBuild = conceptoptions.createOption(adminProjectCtx, {
    reference: 'OPT-B',
    name: 'New treatment stream on the eastern plot',
    description: 'Build a complete new stream alongside, decommission the existing works on completion.',
    scopeStatement:
      'IN: complete new treatment stream, new inlet, new outfall, demolition of the existing works. OUT: land acquisition, off-site network reinforcement.',
    assumptions: ['The eastern plot is available and developable', 'Planning consent obtainable within 9 months'],
    exclusions: ['Land acquisition', 'Off-site network reinforcement'],
    dependencies: ['Planning consent', 'Land availability'],
    baseDate: conceptBaseDate,
    currency: 'GBP',
    orderOfCostMinor: 2_640_000_000,
    costLowMinor: 2_310_000_000,
    costHighMinor: 3_300_000_000,
    durationDaysLow: 980,
    durationDaysMostLikely: 1_150,
    durationDaysHigh: 1_420,
  });
  const optModular = conceptoptions.createOption(adminProjectCtx, {
    reference: 'OPT-C',
    name: 'Modular package plant',
    description: 'Proprietary packaged treatment units on a prepared slab, retaining the existing inlet.',
    scopeStatement:
      'IN: packaged treatment units, slab and containment, inlet refurbishment, connections. OUT: filter gallery refurbishment, permanent power upgrade.',
    assumptions: ['A single supplier can meet the consent standard at this flow', 'The 30-year whole-life case holds'],
    exclusions: ['Filter gallery refurbishment', 'Permanent power upgrade'],
    dependencies: ['Supplier capacity', 'Consent authority acceptance of a proprietary process'],
    baseDate: conceptBaseDate,
    currency: 'GBP',
    orderOfCostMinor: 1_540_000_000,
    costLowMinor: 1_290_000_000,
    costHighMinor: 2_100_000_000,
    durationDaysLow: 620,
    durationDaysMostLikely: 740,
    durationDaysHigh: 980,
  });

  conceptoptions.analyseOption(pmCtx, { optionId: optRefurb.optionId, scores: optionCriteria(7, 8, 7, 8) });
  conceptoptions.analyseOption(pmCtx, { optionId: optNewBuild.optionId, scores: optionCriteria(3, 9, 5, 5) });
  conceptoptions.analyseOption(pmCtx, { optionId: optModular.optionId, scores: optionCriteria(9, 5, 6, 6) });

  conceptoptions.selectOption(ownerCtx, {
    optionId: optRefurb.optionId,
    rationale:
      'Highest weighted score and the only option that satisfies REQ-002 without a second consent variation. It is not the cheapest — OPT-C is — and that is the trade the sponsor accepted: the packaged plant scored two points lower on operability and the operations team would not carry it for thirty years.',
    evidenceHash: hashEvidence('awt-p2-option-review-minutes'),
  });
  conceptoptions.rejectOption(ownerCtx, {
    optionId: optNewBuild.optionId,
    rationale:
      'Lowest capital score by a wide margin and depends on land that is not secured. The operability advantage is real but does not pay for a 43% cost premium.',
  });
  conceptoptions.rejectOption(ownerCtx, {
    optionId: optModular.optionId,
    rationale:
      'Cheapest and fastest, and rejected on operability: a proprietary process the operator cannot maintain with its own people, on a site it must run for thirty years. Recorded here so it is not proposed again without that answer.',
  });
  step('C-WF-04 — three options compared on one template; OPT-A selected, two rejected with reasons');

  // C-WF-05 — cost, programme and cashflow, approved together under one cut-off.
  conceptcontrols.createCostPlan(qsCtx, {
    baseDate: conceptBaseDate,
    rangeMethod: 'PERT',
    budgetCapMinor: 1_900_000_000,
    tolerancePercent: 5,
  });
  const costLines: Array<{
    wbs: string;
    category: Parameters<typeof conceptcontrols.addCostLine>[1]['category'];
    description: string;
    rate: number;
    low: number;
    high: number;
    source?: string;
  }> = [
    { wbs: '1.1', category: 'SUBSTRUCTURE', description: 'Piled foundations, obstruction removal and clarifier bases', rate: 420_000_000, low: 380_000_000, high: 520_000_000, source: 'SPONS Civil 2026 + Ashworth Phase 1 outturn' },
    { wbs: '2.1', category: 'SUPERSTRUCTURE', description: 'Clarifier structures, filter gallery refurbishment', rate: 510_000_000, low: 470_000_000, high: 610_000_000, source: 'Ashworth Phase 1 outturn, rebased' },
    { wbs: '4.1', category: 'SERVICES', description: 'Process mechanical, electrical and ICA', rate: 390_000_000, low: 350_000_000, high: 470_000_000, source: 'Framework schedule of rates, 2026 review' },
    { wbs: '5.1', category: 'EXTERNAL_WORKS', description: 'Access road realignment, hardstanding, reinstatement', rate: 120_000_000, low: 105_000_000, high: 150_000_000, source: 'SPONS External Works 2026' },
    { wbs: '6.1', category: 'PRELIMINARIES', description: 'Site establishment, management, temporary works, outage working', rate: 185_000_000, low: 170_000_000, high: 215_000_000, source: '10% of works, benchmarked against two comparable outage schemes' },
    { wbs: '7.1', category: 'DESIGN_FEES', description: 'Detailed design, CDM principal designer, surveys', rate: 95_000_000, low: 88_000_000, high: 112_000_000, source: 'Framework fee scale' },
    // No source and no base date: provisional by derivation, and excluded from
    // the high-confidence total rather than carried with a footnote.
    { wbs: '8.1', category: 'CLIENT_COSTS', description: 'Client project management, legal and consent fees', rate: 92_000_000, low: 75_000_000, high: 130_000_000 },
    { wbs: '9.1', category: 'RISK_ALLOWANCE', description: 'Quantified risk allowance, from the concept risk register', rate: 38_000_000, low: 20_000_000, high: 70_000_000, source: 'Expected value across the concept risk register' },
  ];
  for (const line of costLines) {
    conceptcontrols.addCostLine(qsCtx, {
      wbsCode: line.wbs,
      category: line.category,
      description: line.description,
      quantity: 1,
      unit: 'sum',
      rateMinor: line.rate,
      rateSource: line.source,
      rateBaseDate: line.source ? conceptBaseDate : undefined,
      lowMinor: line.low,
      highMinor: line.high,
    });
  }

  conceptcontrols.createMilestoneProgramme(plannerCtx, {
    dataDate: relative(0),
    milestones: [
      {
        reference: 'M-CONCEPT',
        name: 'Concept gate approved',
        plannedDate: relative(14),
        openStartReason: 'The first milestone of the project. Nothing on this programme precedes it.',
      },
      {
        reference: 'M-F10',
        name: 'F10 notification to HSE',
        plannedDate: relative(45),
        predecessors: ['M-CONCEPT'],
        statutory: true,
      },
      // Each applicable statutory regime gets its own milestone, marked
      // statutory so a resequence cannot move past it. Pointing three regimes
      // at the design freeze — which is what this seed did first — is exactly
      // what C-WF-07's gateway check refuses, and it was right to: a permit
      // determination and a planning determination are dates the regulator
      // controls, not dates the design team can move.
      { reference: 'M-PLANNING', name: 'Planning determination', plannedDate: relative(150), predecessors: ['M-CONCEPT'], statutory: true },
      { reference: 'M-PERMIT', name: 'Environmental permit variation determined', plannedDate: relative(175), predecessors: ['M-CONCEPT'], statutory: true },
      {
        reference: 'M-DESIGN-FREEZE',
        name: 'Design frozen for the civils package',
        plannedDate: designFreezeDate,
        predecessors: ['M-F10', 'M-PLANNING', 'M-PERMIT'],
      },
      { reference: 'M-CIVILS-AWARD', name: 'Civils package awarded', plannedDate: relative(230), predecessors: ['M-DESIGN-FREEZE'] },
      { reference: 'M-MEP-AWARD', name: 'MEP package awarded', plannedDate: relative(275), predecessors: ['M-DESIGN-FREEZE'] },
      { reference: 'M-CIVILS-SITE', name: 'Civils required on site', plannedDate: relative(360), predecessors: ['M-CIVILS-AWARD'] },
      { reference: 'M-MEP-SITE', name: 'MEP plant required on site', plannedDate: relative(560), predecessors: ['M-MEP-AWARD', 'M-CIVILS-SITE'] },
      { reference: 'M-OUTAGE-1', name: 'First tie-in outage', plannedDate: relative(620), predecessors: ['M-MEP-SITE'] },
      {
        reference: 'M-PC',
        name: 'Practical completion',
        plannedDate: relative(880),
        predecessors: ['M-OUTAGE-1'],
        openFinishReason: 'The end of the concept programme. What follows is the defects period, not a construction activity.',
      },
    ],
  });

  // Phased from the plan itself rather than a second set of figures, so the
  // reconciliation the command enforces is satisfied by construction.
  const conceptTotals = conceptcontrols.costTotals(conceptcontrols.currentCostPlan(qsCtx)!);
  const spendCurve = [0.06, 0.14, 0.22, 0.24, 0.18, 0.1];
  const phased = spendCurve.map((share) => Math.round(conceptTotals.totalMinor * share));
  phased[phased.length - 1] =
    conceptTotals.totalMinor - phased.slice(0, -1).reduce((sum, value) => sum + value, 0);
  conceptcontrols.generateCashflow(qsCtx, {
    periods: phased.map((spendMinor, index) => ({
      period: `2026-Q${index + 1}`,
      spendMinor,
      // The client draws down half-yearly, so funding lands ahead of two
      // quarters and behind the others. The peak exposure figure is the point.
      fundingMinor: index % 2 === 0 ? Math.round(spendMinor * 1.9) : 0,
    })),
  });

  const conceptControls = conceptcontrols.approveConceptControls(adminProjectCtx, {
    cutOffDate: relative(0),
    affordabilityActions: [
      'Sponsor to seek an additional £0.5m of AMP8 contingency at the March board',
      'Value engineering workshop on the filter gallery scope before design freeze',
      'Convert the client-costs line from provisional to a benchmarked rate before the design gate',
    ],
    evidenceHash: hashEvidence('awt-p2-concept-controls-pack'),
  });
  step(
    `C-WF-05 — cost, programme and cashflow approved under one cut-off: ` +
      `P50 ${conceptControls.totalMinor}, P80 ${conceptControls.p80Minor}, gap ${conceptControls.affordabilityGapMinor}`,
  );

  // C-WF-06 — how it will be bought.
  conceptstrategy.createProcurementStrategy(pmCtx, {
    weights: { SCOPE_CERTAINTY: 0.25, TIME: 0.2, PRICE_CERTAINTY: 0.25, DESIGN_CONTROL: 0.15, MARKET_CAPACITY: 0.15 },
    assessments: [
      {
        route: 'TRADITIONAL',
        scores: { SCOPE_CERTAINTY: 8, TIME: 4, PRICE_CERTAINTY: 7, DESIGN_CONTROL: 9, MARKET_CAPACITY: 7 },
        note: 'Full design before tender. Highest design control, and the programme cannot carry it against the outage dates.',
      },
      {
        route: 'DESIGN_AND_BUILD',
        scores: { SCOPE_CERTAINTY: 6, TIME: 8, PRICE_CERTAINTY: 8, DESIGN_CONTROL: 5, MARKET_CAPACITY: 8 },
        note: 'Contractor completes the design to employer’s requirements. Faster and firmer, with less control over how REQ-004 is met.',
      },
      {
        route: 'FRAMEWORK_CALL_OFF',
        scores: { SCOPE_CERTAINTY: 7, TIME: 9, PRICE_CERTAINTY: 6, DESIGN_CONTROL: 6, MARKET_CAPACITY: 5 },
        note: 'Fastest to contract. The regional framework has two members with the capacity for this value, which is thin.',
      },
    ],
    selectedRoute: 'DESIGN_AND_BUILD',
    rationale:
      'The outage dates are fixed by the operator and bind the programme, so time and price certainty carry half the weight between them. Design control is given up deliberately and bought back through the employer’s requirements, which carry REQ-002 and REQ-004 verbatim.',
    designResponsibility: 'Contractor, to employer’s requirements retaining client-side process design',
    riskAppetite: 'Low on time and on the outage dates; moderate on cost within the approved allowance',
    socialValueObligations: [
      '20% of the workforce from within the combined authority area',
      'Two apprenticeships for the duration of the works',
      'Local supply-chain spend reported quarterly',
    ],
  });
  conceptstrategy.approvePackageStrategy(pmCtx, {
    worksScopeElements: ['CIVILS', 'PROCESS_MECHANICAL', 'ELECTRICAL_ICA', 'EXTERNAL_WORKS'],
    packages: [
      {
        reference: 'PKG-CIV',
        name: 'Civils and process structures',
        scopeElements: ['CIVILS', 'EXTERNAL_WORKS'],
        interfaces: [
          'Hands over clarifier bases and pipe plinths to PKG-MEP at agreed setting-out',
          'Takes the realigned access road alignment from the QL-A service verification',
        ],
        ownerId: pm.id,
        requiredOnSiteMilestoneRef: 'M-CIVILS-SITE',
        enquiryDate: relative(200),
        awardDate: relative(230),
        leadTimeWeeks: 16,
        retainedRisks: ['Obstruction quantity beyond the allowance', 'Archaeology, pending INV-001'],
      },
      {
        reference: 'PKG-MEP',
        name: 'Process mechanical, electrical and ICA',
        scopeElements: ['PROCESS_MECHANICAL', 'ELECTRICAL_ICA'],
        interfaces: [
          'Takes bases and plinths from PKG-CIV',
          'Owns both tie-in outages and the commissioning interface with the existing works',
        ],
        ownerId: pm.id,
        requiredOnSiteMilestoneRef: 'M-MEP-SITE',
        enquiryDate: relative(200),
        awardDate: relative(275),
        leadTimeWeeks: 38,
        retainedRisks: ['Switchgear lead time', 'Consent variation timing'],
      },
    ],
  });
  conceptstrategy.selectContractStrategy(ownerCtx, {
    contractFamily: 'NEC4',
    contractOption: 'Option C — target contract with activity schedule',
    paymentTerms: 'Monthly assessment, payment 21 days from assessment date, Construction Act compliant',
    insuranceRequirements: [
      'Contract works, full reinstatement value',
      'Public liability GBP 10m any one occurrence',
      'Professional indemnity GBP 5m for the design portion',
    ],
    bondsAndGuarantees: ['Performance bond at 10% of the contract sum', 'Parent company guarantee'],
    provisionalNotices: [
      'Early warning (cl. 15)',
      'Compensation event notification (cl. 61.3)',
      'Programme submission and acceptance (cl. 31/32)',
      'Defects notification (cl. 43)',
    ],
  });
  step('C-WF-06 — Design and Build selected over three assessed routes; two packages, no scope gap or overlap');

  // C-WF-07 — the risks identified at concept, with owners and responses, and
  // the statutory position confirmed by a named competent person.
  const conceptRisks = [
    {
      title: 'Obstructions in the made ground exceed the allowance',
      category: 'GROUND_CONDITIONS' as const,
      probability: 0.4,
      costImpact: { optimistic: 6_000_000, mostLikely: 22_000_000, pessimistic: 58_000_000 },
      scheduleImpactDays: { optimistic: 5, mostLikely: 20, pessimistic: 55 },
      ownerPartyId: designLead.id,
      mitigations: [
        { description: 'Trial pits across the clarifier footprint before design freeze', costMinor: 2_800_000, probabilityReduction: 0.4, impactReduction: 0.3 },
      ],
    },
    {
      title: 'A tie-in outage is withdrawn or moved by the operator',
      category: 'PROGRAMME' as const,
      probability: 0.3,
      costImpact: { optimistic: 4_000_000, mostLikely: 18_000_000, pessimistic: 70_000_000 },
      scheduleImpactDays: { optimistic: 20, mostLikely: 60, pessimistic: 180 },
      ownerPartyId: fm.id,
      mitigations: [
        { description: 'Outage dates written into the contract as key dates with a compensation mechanism', costMinor: 0, probabilityReduction: 0.35, impactReduction: 0.4 },
      ],
    },
    {
      title: 'Discharge consent variation is refused or conditioned',
      category: 'REGULATORY' as const,
      probability: 0.2,
      costImpact: { optimistic: 10_000_000, mostLikely: 45_000_000, pessimistic: 160_000_000 },
      scheduleImpactDays: { optimistic: 30, mostLikely: 90, pessimistic: 240 },
      ownerPartyId: pm.id,
      mitigations: [
        { description: 'Pre-application engagement with the regulator before the design gate', costMinor: 1_500_000, probabilityReduction: 0.4, impactReduction: 0.2 },
      ],
    },
    {
      title: 'Long-lead switchgear cannot be delivered inside the 38-week window',
      category: 'SUPPLY_CHAIN' as const,
      probability: 0.35,
      costImpact: { optimistic: 2_000_000, mostLikely: 9_000_000, pessimistic: 26_000_000 },
      scheduleImpactDays: { optimistic: 10, mostLikely: 30, pessimistic: 90 },
      ownerPartyId: pm.id,
      mitigations: [
        { description: 'Advance-order the switchgear under a pre-construction services agreement', costMinor: 4_000_000, probabilityReduction: 0.5, impactReduction: 0.5 },
      ],
    },
  ];
  for (const risk of conceptRisks) {
    safety.registerRisk(safetyCtx, {
      id: '',
      title: risk.title,
      category: risk.category,
      probability: risk.probability,
      costImpact: risk.costImpact,
      scheduleImpactDays: risk.scheduleImpactDays,
      ownerPartyId: risk.ownerPartyId,
      projectValueMinor: 1_850_000_000,
      projectDurationDays: 880,
      mitigations: risk.mitigations,
    });
  }

  conceptcompliance.confirmComplianceApplicability(safetyCtx, {
    regimes: [
      {
        regime: 'CDM_2015',
        applicable: true,
        basis:
          'Construction work in Great Britain lasting more than 30 working days with more than 20 workers simultaneously. Notifiable; F10 required before construction starts.',
        milestoneRef: 'M-F10',
      },
      {
        regime: 'ENVIRONMENTAL_PERMIT',
        applicable: true,
        basis: 'Discharge to a controlled water. The existing permit requires a variation for the revised consent standard.',
        milestoneRef: 'M-PERMIT',
      },
      {
        regime: 'PLANNING_CONSENT',
        applicable: true,
        basis: 'New above-ground structures exceeding permitted development for statutory undertakers on this site.',
        milestoneRef: 'M-PLANNING',
      },
      {
        regime: 'HIGHER_RISK_BUILDING',
        applicable: false,
        basis: 'Not a building containing dwellings, and below 18m. The Building Safety Act gateway regime does not apply.',
      },
      {
        regime: 'BUILDING_SAFETY_ACT_GATEWAY_2',
        applicable: false,
        basis: 'Follows from the higher-risk-building screening above.',
      },
      {
        regime: 'COMAH',
        applicable: false,
        basis:
          'Sodium hypochlorite and ferric sulphate holdings are below the lower-tier threshold in Schedule 1. Re-screen if the dosing strategy changes.',
      },
      {
        regime: 'LISTED_BUILDING_CONSENT',
        applicable: false,
        basis: 'No listed structure on or adjoining the site. The scheduled monument buffer is a planning matter, covered by INV-001.',
      },
    ],
    confirmedByName: 'Helen Okafor',
    confirmedByRole: 'HSE Manager, Meridian Infrastructure Group',
    competenceBasis:
      'CMIOSH, NEBOSH Construction Certificate, fifteen years on notifiable water infrastructure including two AMP7 treatment upgrades.',
    evidenceHash: hashEvidence('awt-p2-statutory-screening'),
  });

  const conceptRiskReview = conceptcompliance.approveRiskReview(pmCtx, {
    // Reconciles to the RISK_ALLOWANCE line in the cost plan, to the penny.
    declaredAllowanceMinor: 38_000_000,
    retainedExposureNote:
      'The client retains ground and consent risk to the value of the allowance. The outage risk is transferred to the contractor through key dates, and the switchgear risk is bought down by advance ordering rather than carried.',
    escalated: ['Discharge consent variation — escalated to the sponsor for regulator engagement before the design gate'],
    evidenceHash: hashEvidence('awt-p2-concept-risk-review'),
  });
  step(
    `C-WF-07 — statutory applicability confirmed by a named competent person; risk review approved, ` +
      `residual exposure ${conceptRiskReview.residualExposureMinor}, reconciled to the cost plan`,
  );

  // Every AI output produced so far, decided about by a person.
  //
  // The fifth clause of every stage gate asks for a human disposition on each
  // one, and until this existed there was nothing to ask. A demonstration that
  // left forty-odd model outputs undecided would show the clause failing for a
  // real reason — the model wrote and nobody looked.
  //
  // Run at each gate rather than once at the end, which is what a project
  // actually does: the outputs are reviewed before the decision that relies on
  // them, not afterwards. Idempotent by construction — an execution that
  // already carries a disposition is skipped, because replacing one would
  // erase the record that the output was once accepted.
  //
  // Not all accepted. A demonstration in which every AI output was perfect
  // teaches the wrong thing about what the record is for, so a deterministic
  // slice is corrected and one is rejected outright.
  let disposedCount = 0;
  const disposeOutstandingAIOutputs = (): number => {
    const outstanding = aidisposition.aiDispositionPosition(pmCtx).outstanding;
    for (const [index, execution] of outstanding.entries()) {
      const decision =
        index % 9 === 4 ? 'ACCEPTED_WITH_CHANGE' : index % 17 === 11 ? 'REJECTED' : 'ACCEPTED';
      aidisposition.disposeAIOutput(pmCtx, {
        executionId: execution.executionId,
        decision,
        reason:
          decision === 'ACCEPTED_WITH_CHANGE'
            ? 'Figures adopted; the narrative was rewritten to name the constraint the model described only in general terms.'
            : decision === 'REJECTED'
              ? 'Rejected — the output assumed an outage window the operator has not agreed. Redone by hand against the agreed dates.'
              : undefined,
      });
      disposedCount += 1;
    }
    return outstanding.length;
  };
  step(`AI outputs reviewed before the concept gate: ${disposeOutstandingAIOutputs()} decided`);

  // C-WF-08 — the 6.4 gate, then the baseline it produces.
  const conceptGate = stagegate.evaluateConceptGate(ownerCtx);
  const conceptOutstanding = [...conceptGate.failed, ...conceptGate.unassessable];
  stagegate.decideGate(ownerCtx, {
    decision: conceptOutstanding.length === 0 ? 'PASS' : 'PASS_WITH_CONDITIONS',
    rationale:
      'Concept stage complete. The brief is baselined, the option is selected against it, cost and programme are approved under one cut-off, and the statutory position is confirmed. The clauses the platform cannot assess are platform gaps rather than project gaps and are carried as conditions into design.',
    conditions: conceptOutstanding.map((clause) => ({
      clause,
      what:
        clause === 'AI_ACCOUNTED'
          ? 'Record assumptions, prompt version and human disposition against every AI output before the design gate'
          : 'Produce the design mobilisation worklist from the package strategy at design stage start',
      owner: pm.id,
      // Due at the design freeze, which is the milestone the condition text
      // actually names. An arbitrary date here would be exactly the "condition
      // with no real date" the gate exists to prevent.
      by: designFreezeDate,
    })),
  });
  const conceptBaseline = stagegate.approveConceptBaseline(ownerCtx, {
    evidenceHash: hashEvidence('awt-p2-concept-gate-pack'),
    note: 'Frozen at the concept gate. Design cites these versions.',
  });
  step(
    `C-WF-08 — 6.4 gate decided and concept baseline frozen: ${conceptBaseline.components} components, ` +
      `each with the hash of its state`,
  );

  structure.transitionPhase(ownerCtx, { to: 'DESIGN', justification: 'Concept baseline approved at the 6.4 gate' });

  // --- DESIGN ----------------------------------------------------------------
  const drawing = await bim.registerDrawing(bimCtx, {
    fileHash: hash('C-1001-P03.pdf'),
    titleBlock: {
      drawingNumber: 'C-1001',
      title: 'Clarifier No.1 — General Arrangement',
      revision: 'P03',
      discipline: 'CIVILS',
      issueDate: '2026-05-12',
      status: 'FOR CONSTRUCTION',
    },
    packageIds: [packageId],
  });

  // --- The common data environment -------------------------------------------
  //
  // Three documents, deliberately in three different positions, because a
  // register where everything is published demonstrates nothing. C-1001 is at
  // P02 superseded by P03; M-2100 is published at S3, which is the trap the
  // whole suitability model exists to catch — current, approved, and not
  // something to build from; S-3000 is still with its checker.
  const deposit = async (input: {
    reference: string;
    revision: string;
    title: string;
    kind: cde.ContainerKind;
    discipline: string;
  }) =>
    cde.depositContainer(bimCtx, {
      ...input,
      author: bimLead.id,
      fileHash: hash(`${input.reference}-${input.revision}`),
    }).containerId;

  // The superseded predecessor, published first so P03 has something to replace.
  const ga02 = await deposit({
    reference: 'C-1001',
    revision: 'P02',
    title: 'Clarifier No.1 — General Arrangement',
    kind: 'DRAWING',
    discipline: 'CIVILS',
  });
  cde.shareContainer(pmCtx, { containerId: ga02, checker: pm.id, suitability: 'S4' });
  cde.publishContainer(designCtx, { containerId: ga02, approver: designLead.id, suitability: 'A1' });

  const ga03 = await deposit({
    reference: 'C-1001',
    revision: 'P03',
    title: 'Clarifier No.1 — General Arrangement',
    kind: 'DRAWING',
    discipline: 'CIVILS',
  });
  cde.shareContainer(pmCtx, { containerId: ga03, checker: pm.id, suitability: 'S4' });
  // Supersedes P02 in this same call, which is the rule the whole environment
  // rests on rather than a tidy-up somebody does afterwards.
  cde.publishContainer(designCtx, { containerId: ga03, approver: designLead.id, suitability: 'A1' });

  const mep = await deposit({
    reference: 'M-2100',
    revision: 'P01',
    title: 'Filter gallery — pipework layout',
    kind: 'DRAWING',
    discipline: 'MECHANICAL',
  });
  cde.shareContainer(pmCtx, { containerId: mep, checker: pm.id, suitability: 'S3' });
  cde.publishContainer(designCtx, { containerId: mep, approver: designLead.id, suitability: 'S3' });

  const struct = await deposit({
    reference: 'S-3000',
    revision: 'P01',
    title: 'Clarifier No.1 — reinforcement arrangement',
    kind: 'DRAWING',
    discipline: 'STRUCTURES',
  });
  cde.shareContainer(pmCtx, { containerId: struct, checker: pm.id, suitability: 'S2' });

  step(
    'Common data environment: C-1001 P03 published at A1 and P02 superseded in the same act; M-2100 published at S3, ' +
      'which is current and still not something to build from; S-3000 shared and awaiting approval',
  );

  const model = await bim.ingestModel(bimCtx, {
    fileHash: hash('ashworth-civils.ifc'),
    format: 'IFC',
    discipline: 'CIVILS',
    lod: 350,
    elementCount: 14_820,
  });

  const mepModel = await bim.ingestModel(bimCtx, {
    fileHash: hash('ashworth-mep.ifc'),
    format: 'IFC',
    discipline: 'MECHANICAL',
    lod: 300,
    elementCount: 9_140,
  });

  const clashes = await bim.detectClashes(bimCtx, {
    modelAId: model.modelId,
    modelBId: mepModel.modelId,
    clashes: [
      { elementA: 'RC-WALL-104', elementB: 'DN450-PIPE-22', disciplineA: 'STRUCTURE', disciplineB: 'MECHANICAL', overlapVolume: 0.62, location: 'Filter gallery, grid C4' },
      { elementA: 'RC-SLAB-021', elementB: 'CABLE-TRAY-9', disciplineA: 'STRUCTURE', disciplineB: 'ELECTRICAL', overlapVolume: 0.09, location: 'MCC room, grid B2' },
      { elementA: 'DUCT-14', elementB: 'CEILING-GRID-3', disciplineA: 'MECHANICAL', disciplineB: 'FINISHES', overlapVolume: 0.04, location: 'Admin block' },
    ],
  });
  step(`BIM: 2 models ingested, ${clashes.clashIds.length} clashes triaged (${clashes.critical} critical)`);

  // Two of the three closed out, by different routes, because the distinction
  // is the point: one cost design work and named the discipline that moved, the
  // other was built around on site and left the model describing something that
  // was not built. The critical one stays open — that is the register doing its
  // job rather than the demo looking tidy.
  bim.resolveClash(bimCtx, {
    clashId: clashes.clashIds[1]!,
    method: 'MODEL_REVISED',
    movedDiscipline: 'ELECTRICAL',
    resolvedInModelId: mepModel.modelId,
    justification: 'Cable tray dropped to 2,750mm soffit and rerouted clear of the slab downstand; MEP model reissued.',
    resolvedBy: bimLead.name,
    evidenceHash: hash('clash-002-resolution-mep-rev-c'),
  });
  bim.resolveClash(bimCtx, {
    clashId: clashes.clashIds[2]!,
    method: 'RESOLVED_ON_SITE',
    justification: 'Duct offset 120mm below the ceiling grid on site to clear the hanger; model not updated to suit.',
    resolvedBy: 'Meridian — mechanical supervisor',
    evidenceHash: hash('clash-003-site-resolution-photo'),
  });
  step('2 clashes closed out — one by model revision, one on site with the model left behind');

  // The specification, read for what it demands rather than what it says. Four
  // clauses impose a step before or during the work; the inspection plan below
  // covers two of them, which is the finding the demo is supposed to show.
  const concreteSpec = await bim.ingestSpecification(bimCtx, {
    sectionRef: 'E10',
    title: 'In situ concrete',
    revision: 'C',
    specificationText: [
      'E10 IN SITU CONCRETE',
      '',
      '3.1  Concrete shall comply with BS EN 206 and BS 8500-2, and shall be supplied',
      '     by a plant holding current third party product conformity certification.',
      '',
      '3.2  Submit the concrete mix design to the Engineer for approval not less than',
      '     20 working days before the first pour is scheduled to take place.',
      '',
      '3.3  A trial panel of the fair faced finish shall be constructed and approved',
      '     before any permanent fair faced concrete is placed on the works.',
      '',
      '3.4  Reinforcement shall not be covered until it has been inspected and released',
      '     by the Engineer. This is a hold point.',
      '',
      '3.5  Cube testing shall be carried out in accordance with BS EN 12390-3 at a',
      '     rate of one set per 50 cubic metres or part thereof placed in any one day.',
      '',
      '3.6  Formwork should be struck in a manner that avoids shock loading, having',
      '     regard to the ambient temperature at the time of striking.',
      '',
      '3.7  The finished surface tolerance shall be Class H20 measured in accordance',
      '     with the National Structural Concrete Specification.',
    ].join('\n'),
    documentHash: hash('specification-e10-rev-c'),
  });
  step(
    `Specification E10 read: ${concreteSpec.clauses} clauses, ${concreteSpec.requiringVerification} imposing a test, submittal or hold point`,
  );

  const clashRfi = bim.addMarkup(bimCtx, {
    drawingId: drawing.drawingId,
    author: bimLead.name,
    note: 'Wall penetration at grid C4 conflicts with DN450 process main. Confirm required builder\'s work opening and structural adequacy.',
    region: { x: 0.42, y: 0.31, width: 0.1, height: 0.08 },
    convertTo: 'RFI',
  });
  step('Clash converted into a numbered RFI, linked to the drawing revision');

  // Answered, and answered late. An RFI register that only ever grows cannot
  // show which questions held the job up, which is the exhibit a design-delay
  // claim is built from.
  if (clashRfi.derivedId) {
    bim.answerRFI(
      bimCtx,
      {
        rfiId: clashRfi.derivedId,
        answer:
          'Form a 600x600 builder\'s work opening at grid C4, lintel over per SK-041. The DN450 main is to be re-routed at high level; revised MEP layout to follow.',
        answeredBy: 'Meridian Design — lead structural engineer',
        changesDesign: true,
        evidenceHash: hash('rfi-answer-c4-penetration'),
      },
      // Eleven days after it was raised, against a seven-day return. Late is
      // the normal case and the record has to be able to show it.
      new Date(Date.now() + 11 * 86_400_000),
    );
    step('RFI answered eleven days after it was raised — recorded as late, against the drawing revision it was asked on');
  }

  const maturity = structure.assessDesignMaturity(pmCtx, {
    packageId,
    disciplineScores: [
      { discipline: 'CIVILS', ribaStage: 4, completenessPercent: 88, frozen: true },
      { discipline: 'MECHANICAL', ribaStage: 3, completenessPercent: 72, frozen: false },
      { discipline: 'ELECTRICAL', ribaStage: 3, completenessPercent: 68, frozen: false },
    ],
    informationGaps: ['Final pump selection outstanding', 'Ground investigation report for zone 3 pending'],
    assessorNotes: 'Civils sufficiently mature to price; MEP carries residual definition risk.',
  });
  step(`Design maturity assessed at ${maturity.score} → pricing basis ${maturity.recommendedPricingBasis}`);

  structure.transitionPhase(ownerCtx, { to: 'TENDER', justification: 'Design matured to a priceable state for the civils package' });

  // --- TENDER ----------------------------------------------------------------
  const takeoff = await tender.runTakeoff(qsCtx, {
    packageId,
    sources: [{ drawingRef: { refType: 'Drawing', refId: drawing.drawingId }, discipline: 'CIVILS', sheetId: 'C-1001' }],
    costCodePrefix: 'CIV',
    items: [
      { description: 'Bulk excavation in made ground', unit: 'm3', quantity: 18_400, sourceSheet: 'C-1001', measurementRule: 'NRM2' },
      { description: 'Reinforced concrete to clarifier walls (C40/50)', unit: 'm3', quantity: 3_260, sourceSheet: 'C-1001' },
      { description: 'High yield reinforcement', unit: 't', quantity: 412, sourceSheet: 'C-1001' },
      { description: 'Formwork to vertical faces', unit: 'm2', quantity: 9_800, sourceSheet: 'C-1001' },
      { description: 'Process pipework DN450 including fittings', unit: 'm', quantity: 640, sourceSheet: 'C-1001' },
    ],
  });
  step(`Take-off produced ${takeoff.boqItemIds.length} BoQ items, traced to sheet C-1001 rev P03`);

  // Eighteen months on site. Every time-related head below is priced against
  // this number, which is why a programme movement re-prices the tender rather
  // than quietly eroding the margin.
  const durationWeeks = 78;

  // Contingency comes from the register, at P80. Four risks, quantified
  // three-point, scored against the value and duration of this job.
  const risks = [
    scoreRisk(
      {
        id: 'RSK-GC-01',
        title: 'Made ground deeper and more variable than the preliminary GI indicates',
        category: 'GROUND_CONDITIONS',
        probability: 0.35,
        costImpact: { optimistic: 8_000_000, mostLikely: 32_000_000, pessimistic: 95_000_000 },
        scheduleImpactDays: { optimistic: 5, mostLikely: 18, pessimistic: 45 },
      },
      1_600_000_000,
      546,
    ),
    scoreRisk(
      {
        id: 'RSK-GC-02',
        title: 'Groundwater requires wellpoint dewatering rather than sump pumping',
        category: 'GROUND_CONDITIONS',
        probability: 0.25,
        costImpact: { optimistic: 12_000_000, mostLikely: 45_000_000, pessimistic: 120_000_000 },
        scheduleImpactDays: { optimistic: 0, mostLikely: 10, pessimistic: 28 },
      },
      1_600_000_000,
      546,
    ),
    scoreRisk(
      {
        id: 'RSK-SC-01',
        title: 'Concrete supply disruption during the continuous clarifier pours',
        category: 'SUPPLY_CHAIN',
        probability: 0.2,
        costImpact: { optimistic: 5_000_000, mostLikely: 18_000_000, pessimistic: 62_000_000 },
        scheduleImpactDays: { optimistic: 3, mostLikely: 12, pessimistic: 35 },
      },
      1_600_000_000,
      546,
    ),
    scoreRisk(
      {
        id: 'RSK-DE-01',
        title: 'Process pipework design released later than the procurement programme requires',
        category: 'DESIGN',
        probability: 0.4,
        costImpact: { optimistic: 4_000_000, mostLikely: 22_000_000, pessimistic: 68_000_000 },
        scheduleImpactDays: { optimistic: 8, mostLikely: 20, pessimistic: 50 },
      },
      1_600_000_000,
      546,
    ),
  ];

  const estimate = tender.buildEstimate(qsCtx, {
    packageId,
    durationWeeks,
    // Rates, not totals. An estimate held as line totals cannot be checked
    // against a rate library and cannot be re-measured.
    lines: [
      { boqItemId: takeoff.boqItemIds[0] as string, description: 'Bulk excavation in made ground', unit: 'm3', quantity: 18_400, labourRateMinor: 2_174, plantRateMinor: 3_478 },
      { boqItemId: takeoff.boqItemIds[1] as string, description: 'RC to clarifier walls (C40/50)', unit: 'm3', quantity: 3_260, labourRateMinor: 65_215, plantRateMinor: 13_037, materialRateMinor: 52_147, materialWastePercent: 4 },
      { boqItemId: takeoff.boqItemIds[2] as string, description: 'High yield reinforcement', unit: 't', quantity: 412, labourRateMinor: 217_233, plantRateMinor: 43_447, materialRateMinor: 478_155, materialWastePercent: 5 },
      { boqItemId: takeoff.boqItemIds[3] as string, description: 'Formwork to vertical faces', unit: 'm2', quantity: 9_800, labourRateMinor: 17_388, plantRateMinor: 3_479, materialRateMinor: 6_520, materialWastePercent: 8 },
      // Specialist package, let firm price — so it carries no inflation.
      { boqItemId: takeoff.boqItemIds[4] as string, description: 'Process pipework DN450 including fittings', unit: 'm', quantity: 640, subcontractRateMinor: 325_937, subcontractFixedPrice: true },
    ],
    timeRelated: [
      { head: 'SITE_MANAGEMENT', description: 'Project manager', weeklyRateMinor: 240_000, quantity: 1 },
      { head: 'SITE_MANAGEMENT', description: 'Site manager', weeklyRateMinor: 190_000, quantity: 2 },
      { head: 'SITE_MANAGEMENT', description: 'Site engineer', weeklyRateMinor: 160_000, quantity: 2 },
      { head: 'SITE_MANAGEMENT', description: 'Quantity surveyor', weeklyRateMinor: 180_000, quantity: 1, weeks: 52 },
      { head: 'PRELIMINARIES', description: 'Site accommodation and welfare', weeklyRateMinor: 185_000, quantity: 1 },
      { head: 'PRELIMINARIES', description: 'Temporary utilities and consumables', weeklyRateMinor: 95_000, quantity: 1 },
      { head: 'PRELIMINARIES', description: 'Site security and hoarding maintenance', weeklyRateMinor: 120_000, quantity: 1 },
      { head: 'LOGISTICS', description: 'Traffic marshal and gate control', weeklyRateMinor: 110_000, quantity: 2 },
      { head: 'LOGISTICS', description: 'Crawler crane and lifting attendance', weeklyRateMinor: 320_000, quantity: 1, weeks: 40 },
      { head: 'HEALTH_AND_SAFETY', description: 'Safety adviser', weeklyRateMinor: 145_000, quantity: 1 },
      { head: 'HEALTH_AND_SAFETY', description: 'PPE, inductions and monitoring', weeklyRateMinor: 32_000, quantity: 1 },
      { head: 'QUALITY', description: 'Quality engineer', weeklyRateMinor: 170_000, quantity: 1 },
      { head: 'QUALITY', description: 'ITP administration and handover evidence', weeklyRateMinor: 40_000, quantity: 1 },
    ],
    quantified: [
      { head: 'TEMPORARY_WORKS', description: 'Temporary works design (Cat 2 and 3 checks)', unit: 'item', quantity: 1, rateMinor: 4_800_000 },
      { head: 'TEMPORARY_WORKS', description: 'Sheet pile cofferdam hire', unit: 'week', quantity: 34, rateMinor: 420_000 },
      { head: 'TEMPORARY_WORKS', description: 'Propping and falsework hire', unit: 'week', quantity: 22, rateMinor: 185_000 },
      { head: 'TESTING', description: 'Concrete cube testing', unit: 'set', quantity: 640, rateMinor: 4_800 },
      { head: 'TESTING', description: 'Compaction testing', unit: 'test', quantity: 180, rateMinor: 16_500 },
      { head: 'TESTING', description: 'Weld inspection and NDT', unit: 'test', quantity: 220, rateMinor: 21_000 },
      { head: 'COMMISSIONING', description: 'Process commissioning support', unit: 'day', quantity: 24, rateMinor: 185_000 },
      { head: 'COMMISSIONING', description: 'Witness testing and demonstration', unit: 'day', quantity: 9, rateMinor: 240_000 },
      { head: 'WASTE', description: 'Muck away, non-hazardous', unit: 'm3', quantity: 22_400, rateMinor: 2_800 },
      { head: 'WASTE', description: 'General skips', unit: 'no', quantity: 140, rateMinor: 31_000 },
      { head: 'WASTE', description: 'Hazardous waste disposal and gate fees', unit: 't', quantity: 340, rateMinor: 18_600 },
    ],
    fees: [
      { head: 'DESIGN', description: 'Contractor-designed portion per the design responsibility matrix', percentOfWorks: 1.2 },
      { head: 'PROFESSIONAL_FEES', description: 'Topographic and intrusive ground investigation', lumpSumMinor: 6_400_000 },
      { head: 'PROFESSIONAL_FEES', description: 'Statutory, planning and discharge fees', lumpSumMinor: 2_850_000 },
    ],
    insurance: {
      policies: [
        { type: 'Contract works', percentOfContractValue: 0.55 },
        { type: 'Public liability', percentOfContractValue: 0.22 },
        { type: 'Professional indemnity', percentOfContractValue: 0.18 },
      ],
    },
    risks,
    contingencyBasis: 'P80',
    inflation: { baseDate: '2026-04-01', annualRate: 0.035, startOnSite: '2026-09-01' },
    margin: { overheadPercent: 6, profitPercent: 8 },
    basisOfEstimate: 'Bottom-up from measured quantities against regional rate library, Q2 2026 base date',
    assumptions: [
      'Continuous access to the works area from commencement',
      'Groundwater controlled by sump pumping; no wellpoint dewatering allowed for',
      'Made ground classified as non-hazardous based on preliminary GI',
      'Process pipework package let firm price against the issued specification',
    ],
  });
  step(
    `Estimate built: ${(estimate.totalMinor / 100).toLocaleString()} GBP across ${estimate.priced.heads.filter((h) => h.status === 'PRICED').length} priced cost heads, ` +
      `contingency ${(estimate.priced.subtotals.riskMinor / 100).toLocaleString()} GBP at P80, prelims ${estimate.priced.benchmarks.prelimsPercentOfWorks}% of works`,
  );

  // Never bid without a cash model. The margin is a statement about cost; this
  // is a statement about cash, and it is the one that closes companies.
  const funding = tender.modelTenderFunding(qsCtx, estimate.estimateId, {
    payment: {
      applicationIntervalDays: 30,
      certificationDays: 14,
      paymentDays: 28,
      retentionPercent: 3,
      retentionReleasedAtCompletionPercent: 50,
      defectsLiabilityWeeks: 52,
    },
    supply: {
      subcontractorPaymentDays: 35,
      materialSupplierPaymentDays: 45,
      materialsDepositPercent: 20,
      materialsDepositLeadWeeks: 6,
      plantPaymentDays: 30,
    },
    // Construction services between VAT-registered businesses carry the
    // domestic reverse charge, so there is no VAT on the sale to fund the job.
    vat: { ratePercent: 20, reverseCharge: true, returnIntervalWeeks: 13, settlementLagWeeks: 5 },
    mobilisationMinor: 42_000_000,
    availableWorkingCapitalMinor: 900_000_000,
  });
  step(
    `Cash model: peak funding ${(funding.peakFundingRequirementMinor / 100).toLocaleString()} GBP at week ${funding.peakWeek}, ` +
      `${funding.weeksNegative} weeks cash-negative, verdict ${funding.verdict}`,
  );

  tender.freezeEstimate(qsCtx, estimate.estimateId, 'Approved at tender settlement meeting');

  const tenderPackage = await tender.composeTenderPackage(qsCtx, {
    rfqId: 'pending',
    packageId,
    scopeNarrative:
      'The subcontractor shall carry out all civils and process structure works described in the scope package, including temporary works design, dewatering, and reinstatement, in accordance with the issued drawings and specification.',
    designResponsibilityMatrix: [
      { element: 'Permanent works design', responsibleParty: 'CLIENT_CONSULTANT' },
      { element: 'Temporary works design', responsibleParty: 'SUBCONTRACTOR' },
      { element: 'Formwork and falsework', responsibleParty: 'SUBCONTRACTOR' },
    ],
    attendances: ['Welfare facilities', 'Site-wide power distribution', 'Crane access by arrangement', 'Waste segregation compounds'],
    paymentTerms: 'Monthly application, 30 days from due date, 5% retention',
    programmeRef: { refType: 'Project', refId: projectId },
    documents: [{ name: 'C-1001 rev P03', ref: { refType: 'Drawing', refId: drawing.drawingId } }],
  });
  step(`Tender package composed, completeness ${(tenderPackage.completenessScore * 100).toFixed(0)}%`);

  // The supply chain comes before the enquiry. Three civils firms are
  // registered and prequalified; the RFQ can then only go to them.
  const supplyChain = [
    // Three firms, three outcomes. Northstone has delivered for this business
    // before and comes out strategic; Calder is clean but unproven here;
    // Pennine carries a RIDDOR and lands conditional.
    { partyId: 'SUP-NORTHSTONE', legalName: 'Northstone Civils Ltd', trades: ['GROUNDWORKS', 'CIVIL_ENGINEERING', 'CONCRETE_WORKS'], incorporated: '2008-03-14', riddor: 0, packagesCompleted: 6, disputes: 0, onTime: 92 },
    { partyId: 'SUP-CALDER', legalName: 'Calder Construction Ltd', trades: ['GROUNDWORKS', 'CIVIL_ENGINEERING', 'DRAINAGE'], incorporated: '2014-09-02', riddor: 0, packagesCompleted: 1, disputes: 0, onTime: 88 },
    { partyId: 'SUP-PENNINE', legalName: 'Pennine Groundworks Ltd', trades: ['GROUNDWORKS', 'EARTHWORKS'], incorporated: '2019-06-20', riddor: 1, packagesCompleted: 2, disputes: 0, onTime: 78 },
  ].map((firm) => {
    const { supplierId } = supplychain.registerSupplier(qsCtx, {
      // The party this firm trades as. Registered here so the enquiry and the
      // return name the same firm — without it the eligibility check at the
      // enquiry never reaches the party that actually submits.
      partyId: firm.partyId,
      legalName: firm.legalName,
      trades: firm.trades,
      contactName: 'Commercial Manager',
      contactEmail: `enquiries@${firm.legalName.split(' ')[0]!.toLowerCase()}.example`,
      countryCode: 'GB',
      regionsCovered: ['North West', 'Yorkshire'],
    });
    // The QS puts a firm forward; approving it is somebody else's signature.
    // The permission matrix enforces that split, so the seed follows it.
    const result = supplychain.prequalifySupplier(pmCtx, supplierId, {
      packageValueMinor: 8_000_000_00,
      identity: {
        companyNumber: `0${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
        companyStatus: 'active',
        incorporatedOn: firm.incorporated,
        registeredAddress: 'Manchester, United Kingdom',
        sicCodes: ['42990'],
        vatNumber: `GB${Math.floor(100_000_000 + Math.random() * 899_999_999)}`,
        utr: `${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`,
        cisStatus: 'GROSS',
      },
      financial: {
        turnoverMinorByYear: [24_000_000_00, 22_000_000_00, 20_500_000_00],
        netAssetsMinor: 6_400_000_00,
        creditScore: 78,
        creditAgency: 'Creditsafe',
        accountsFiledUpToDate: true,
        accountsMadeUpTo: '2026-03-31',
      },
      insurances: [
        { type: 'PUBLIC_LIABILITY', insurer: 'Aviva', limitMinor: 1_000_000_000, expiresOn: '2027-06-30' },
        { type: 'EMPLOYERS_LIABILITY', insurer: 'Aviva', limitMinor: 1_000_000_000, expiresOn: '2027-06-30' },
        { type: 'PROFESSIONAL_INDEMNITY', insurer: 'Hiscox', limitMinor: 500_000_000, expiresOn: '2027-06-30' },
      ],
      safetyAccreditations: ['CHAS', 'Constructionline Gold'],
      qualityAccreditations: ['ISO 9001', 'ISO 14001', 'ISO 45001'],
      riddorLastThreeYears: firm.riddor,
      ramsCapability: { producesInHouse: true, sampleReviewed: true, sampleAcceptable: true },
      competenceCards: [
        { scheme: 'CSCS', holders: 42, earliestExpiry: '2028-01-31' },
        { scheme: 'CPCS', holders: 11, earliestExpiry: '2027-11-30' },
      ],
      training: [
        { qualification: 'SMSTS', holders: 4, earliestExpiry: '2029-04-30' },
        { qualification: 'First Aid at Work', holders: 6, earliestExpiry: '2028-08-31' },
      ],
      references: [
        { clientName: 'United Utilities', projectName: 'Davyhulme inlet works', valueMinor: 6_400_000_00, verified: true, rating: 5, completedOn: '2025-11-14' },
        { clientName: 'Manchester City Council', projectName: 'Ancoats public realm', valueMinor: 2_100_000_00, verified: true, rating: 4, completedOn: '2025-06-02' },
      ],
      capacity: {
        maxPackageValueMinor: 9_000_000_00,
        maxConcurrentPackages: 4,
        labourByTrade: { GROUNDWORKS: 38, CONCRETE_WORKS: 12 },
        subcontractedLabourPercent: 15,
        plant: [
          { description: '13t excavator', quantity: 4, ownedOrHired: 'OWNED' },
          { description: 'Dumper 9t', quantity: 6, ownedOrHired: 'OWNED' },
        ],
        mobilisationDays: 10,
      },
      dayRates: [
        { role: 'Groundworker', rateMinor: 220_00, quotedOn: '2026-07-01', basis: 'DAY' },
        { role: 'Ganger', rateMinor: 285_00, quotedOn: '2026-07-01', basis: 'DAY' },
        { role: '360 operator (CPCS)', rateMinor: 310_00, quotedOn: '2026-07-01', basis: 'DAY', inclusions: ['Machine'] },
      ],
      coverage: { regions: ['North West', 'Yorkshire'], countryCodes: ['GB'], maxTravelMiles: 60, officeLocations: ['Manchester'] },
      performance: { packagesCompleted: firm.packagesCompleted, onTimePercent: firm.onTime, defectsPerPackage: 0.4, disputes: firm.disputes },
      complianceConfirmed: true,
      evidenceHash: hashEvidence(`pqq-${firm.legalName}`),
    });
    return { supplierId, partyId: firm.partyId, name: firm.legalName, status: result.status };
  });
  step(`Supply chain prequalified: ${supplyChain.map((s) => `${s.name} (${s.status})`).join(', ')}`);

  const rfq = procurement.createRFQ(qsCtx, {
    packageId,
    title: 'Civils and process structures — Ashworth WTW Phase 2',
    pricingBasis: 'REMEASURABLE',
    returnDeadline: new Date(Date.now() + 21 * 86_400_000).toISOString(),
    invitedSupplierIds: supplyChain.map((s) => s.supplierId),
    trade: 'GROUNDWORKS',
    packageValueMinor: 8_000_000_00,
    requiredInsurances: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY', 'PROFESSIONAL_INDEMNITY'],
    contractSuite: 'NEC4',
  });

  procurement.issueRFQ(qsCtx, { rfqId: rfq.rfqId, tenderPackageId: tenderPackage.packageRefId });
  step(`RFQ ${rfq.reference} issued to three suppliers`);

  const submissions = [
    {
      supplierPartyId: 'SUP-NORTHSTONE',
      supplierName: 'Northstone Civils Ltd',
      priceMinor: 872_000_000,
      durationDays: 420,
      exclusions: ['Rock excavation', 'Contaminated material disposal'],
      contractExceptions: ['Cap on delay damages at 5%'],
      provisionalSumsMinor: 41_000_000,
      insurancesHeld: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY', 'PROFESSIONAL_INDEMNITY'],
      peakLabour: 85,
      submissionHash: hash('northstone-submission'),
    },
    {
      supplierPartyId: 'SUP-CALDER',
      supplierName: 'Calder Construction Ltd',
      priceMinor: 798_000_000,
      durationDays: 365,
      exclusions: ['Rock excavation', 'Dewatering beyond sump pumping', 'Out of hours working', 'Winter working measures', 'Temporary works design', 'Reinstatement'],
      contractExceptions: ['Payment terms 45 days', 'No fitness for purpose', 'Exclusion of consequential loss', 'Cap on total liability at 10%'],
      provisionalSumsMinor: 96_000_000,
      insurancesHeld: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY'],
      peakLabour: 60,
      submissionHash: hash('calder-submission'),
    },
    {
      supplierPartyId: 'SUP-PENNINE',
      supplierName: 'Pennine Groundworks Ltd',
      priceMinor: 915_000_000,
      durationDays: 400,
      exclusions: ['Rock excavation'],
      contractExceptions: [],
      provisionalSumsMinor: 22_000_000,
      insurancesHeld: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY', 'PROFESSIONAL_INDEMNITY'],
      peakLabour: 95,
      submissionHash: hash('pennine-submission'),
    },
  ];

  const received = submissions.map((submission) => procurement.receiveSubmission(qsCtx, { ...submission, rfqId: rfq.rfqId }));
  step('Three returns received');

  const evaluation = tender.evaluateSubmissions(qsCtx, {
    rfqId: rfq.rfqId,
    designMaturityScore: maturity.score,
    packageLabourDemand: 80,
    submissions: submissions.map((submission, index) => ({
      submissionId: received[index]?.submissionId as string,
      supplierPartyId: submission.supplierPartyId,
      supplierName: submission.supplierName,
      priceMinor: submission.priceMinor,
      durationDays: submission.durationDays,
      exclusions: submission.exclusions,
      contractExceptions: submission.contractExceptions,
      provisionalSumsMinor: submission.provisionalSumsMinor,
      insurancesHeld: submission.insurancesHeld,
      peakLabour: submission.peakLabour,
    })),
  });

  const winner = evaluation.result.scores[0];
  step(
    `Bids evaluated deterministically — cheapest bid (Calder) is NOT recommended: ` +
      `${evaluation.result.recommendation}`,
  );

  const adjudication = tender.adjudicate(pmCtx, {
    evaluationId: evaluation.evaluationId,
    selectedSubmissionId: winner?.submissionId as string,
    buyoutTargetMinor: 860_000_000,
    rationale: 'Highest evaluated score with complete insurance cover and realistic resourcing against package demand.',
  });

  const bidPack = tender.compileBidPack(qsCtx, {
    rfqId: rfq.rfqId,
    estimateId: estimate.estimateId,
    submissionLetter: 'We are pleased to submit our tender for the Ashworth WTW Phase 2 civils package.',
    qualifications: ['Programme assumes continuous access from week 1', 'Rock excavation excluded pending GI zone 3'],
    exclusions: ['Off-site diversions', 'Permanent power supply'],
    prelimsNarrative: 'Full-time site management, shared welfare, 24-month preliminaries period.',
    attachments: [{ name: 'C-1001 rev P03', ref: { refType: 'Drawing', refId: drawing.drawingId } }],
  });

  procurement.awardRFQ(pmCtx, {
    rfqId: rfq.rfqId,
    adjudicationId: adjudication.adjudicationId,
    governanceApprovalRef: 'BOARD-2026-Q2-014',
    conditions: winner?.conditions ?? [],
  });

  // Stage six. The civils package went to the market and is carried at what
  // Northstone agreed to do it for; the routes converge and the sum that goes
  // out is assembled from them rather than from whichever number was to hand.
  tender.assignScheduleRoute(qsCtx, {
    scheduleId: `sched-${packageId}`,
    packageId,
    route: 'SUPPLY_CHAIN',
    lines: [],
    rationale: 'Civils and process structures let to the supply chain — no self-perform capability for the process elements.',
  });
  const masterPricing = tender.consolidateMasterPricing(qsCtx, {
    estimateId: estimate.estimateId,
    note: 'Stage 6 consolidation before the tender was submitted',
  });
  step(
    `Master pricing consolidated: ${masterPricing.pricing.packages} package(s), ${masterPricing.pricing.unpricedPackages} carrying no price`,
  );

  const subcontract = procurement.assembleSubcontract(qsCtx, {
    rfqId: rfq.rfqId,
    contractSuite: 'NEC4',
    form: 'NEC4 ECS Option B',
    negotiatedValueMinor: 858_000_000,
    negotiationNotes: 'Provisional sums capped and two exclusions withdrawn during negotiation.',
    startDate: '2026-07-01',
    completionDate: '2027-11-30',
    retentionPercent: 5,
    paymentTermsDays: 30,
  });
  procurement.executeSubcontract(pmCtx, {
    subcontractId: subcontract.subcontractId,
    signedDocumentHash: hash('northstone-executed-subcontract'),
    signatureMethod: 'E_SIGNATURE',
    budgetCheckPassed: true,
  });
  step(`Subcontract ${subcontract.reference} executed, buyout ${(subcontract.buyoutDeltaMinor / 100).toLocaleString()} GBP against target`);

  const mainContract = claimsEngine.convertBidToContract(qsCtx, {
    bidPackId: bidPack.packId,
    suite: 'NEC4',
    form: 'NEC4 ECC Option C',
    parties: [
      { role: 'CLIENT', partyId: 'CLIENT-AWA', name: 'Ashworth Water Authority' },
      { role: 'CONTRACTOR', partyId: 'CONTRACTOR-MERIDIAN', name: 'Meridian Infrastructure Group Ltd' },
    ],
    commencementDate: '2026-07-01',
    completionDate: '2028-09-30',
    liquidatedDamagesPerDayMinor: 1_250_000,
    ldCapPercent: 10,
    retentionPercent: 3,
    defectsLiabilityMonths: 24,
  });
  step('Bid converted straight into the main contract — no re-keying of the commercial position');

  await claimsEngine.extractContractIntelligence(qsCtx, {
    contractId: mainContract.contractId,
    contractText: 'NEC4 ECC Option C with Z-clauses covering early warning, compensation events and payment.',
    documentHash: hash('main-contract-executed'),
  });
  step('Contract clauses extracted and time-barred obligations registered');

  // Dated obligations — the kind nothing triggers and nobody watches for.
  // Clause extraction finds the time bars; these are the diary entries that
  // get missed because no event reminds anybody they exist.
  claimsEngine.registerObligation(qsCtx, {
    contractId: mainContract.contractId,
    category: 'INSURANCE',
    description: 'Contractor all-risks and public liability renewal — £10m limit required under the contract',
    dueDate: '2026-09-15',
    owner: 'Commercial director',
    recurrenceMonths: 12,
  });
  claimsEngine.registerObligation(qsCtx, {
    contractId: mainContract.contractId,
    category: 'PERFORMANCE_BOND',
    description: 'Performance bond at 10% of the contract sum expires and must be extended to cover the revised completion date',
    dueDate: '2026-10-31',
    owner: 'Finance director',
  });
  claimsEngine.registerObligation(qsCtx, {
    contractId: mainContract.contractId,
    category: 'REVIEW_CYCLE',
    description: 'Quarterly contract review with the client project manager under the Z-clauses',
    dueDate: '2026-08-01',
    owner: 'Project manager',
    recurrenceMonths: 3,
  });
  step('Dated obligations registered — insurance renewal, bond expiry and the quarterly review cycle');

  // The measurement schedule the bill of quantities is composed from, with
  // items whose formulae are re-evaluated when the bill is built. One is
  // deliberately provisional, because a bill of entirely firm quantities is not
  // one anybody has ever seen.
  //
  // Here rather than with the other seven records below, and the reason is the
  // platform's own: `BOQ_TAKEOFF` cannot be written during construction, and it
  // is right about that — a bill measured after the works started is a bill
  // measured against what was built rather than against what was priced.
  const schedule = measurement.openSchedule(qsCtx, {
    packageReference: 'CIV-01',
    title: 'Civils and process structures — measured works',
    measurementRule: 'NRM2',
  });
  measurement.recordItems(qsCtx, schedule.scheduleId, [
    {
      reference: 'C.10.1',
      description: 'Excavate to reduce levels, depth not exceeding 2m, disposal off site',
      unit: 'm3',
      quantity: 4620,
      basis: 'MEASURED',
      source: { drawing: 'C-1001', revision: 'P03', sheet: '1 of 4' },
      formula: '55 * 28 * 3',
    },
    {
      reference: 'C.20.1',
      description: 'In situ concrete, C32/40, to clarifier base slab',
      unit: 'm3',
      quantity: 812,
      basis: 'MEASURED',
      source: { drawing: 'C-1001', revision: 'P03', sheet: '2 of 4' },
      formula: '29 * 28 * 1',
    },
    {
      reference: 'C.20.2',
      description: 'Reinforcement, high yield bar, to base slab and walls',
      unit: 't',
      quantity: 97.4,
      basis: 'MEASURED',
      source: { drawing: 'C-1002', revision: 'P02' },
    },
    {
      reference: 'C.30.1',
      description: 'Break out and remove historic culvert where encountered',
      unit: 'm',
      quantity: 60,
      basis: 'PROVISIONAL',
      source: { allowanceBasis: 'Culvert survey indicates a run of unknown construction across zone 3' },
    },
  ]);
  step('Measurement schedule opened with four items, one provisional against the culvert of unknown location');

  structure.transitionPhase(ownerCtx, { to: 'CONSTRUCTION', justification: 'Contract executed and estimate frozen; works may commence' });

  // --- CONSTRUCTION ----------------------------------------------------------
  const taskIds = planning.createTasks(plannerCtx, [
    { activityCode: 'A100', name: 'Site establishment', workPackageId: packageId, durationDays: 20, costCode: 'CIV.001' },
    { activityCode: 'A200', name: 'Bulk excavation', workPackageId: packageId, durationDays: 60, costCode: 'CIV.001', optimisticDays: 50, pessimisticDays: 95 },
    { activityCode: 'A300', name: 'Blinding and base slabs', workPackageId: packageId, durationDays: 45, costCode: 'CIV.002' },
    { activityCode: 'A400', name: 'Clarifier walls — pour sequence', workPackageId: packageId, durationDays: 90, costCode: 'CIV.002', optimisticDays: 80, pessimisticDays: 140 },
    { activityCode: 'A500', name: 'Filter gallery substructure', workPackageId: packageId, durationDays: 70, costCode: 'CIV.003' },
    { activityCode: 'A600', name: 'Process pipework installation', workPackageId: packageId, durationDays: 55, costCode: 'CIV.004' },
    { activityCode: 'A700', name: 'Watertightness testing', workPackageId: packageId, durationDays: 21, costCode: 'CIV.005' },
    { activityCode: 'A800', name: 'Reinstatement and handover', workPackageId: packageId, durationDays: 30, costCode: 'CIV.006' },
  ]);

  planning.linkTasks(plannerCtx, [
    { predecessorId: taskIds[0] as string, successorId: taskIds[1] as string, type: 'FS', lag: 0 },
    { predecessorId: taskIds[1] as string, successorId: taskIds[2] as string, type: 'FS', lag: 0 },
    { predecessorId: taskIds[2] as string, successorId: taskIds[3] as string, type: 'FS', lag: 5 },
    { predecessorId: taskIds[2] as string, successorId: taskIds[4] as string, type: 'SS', lag: 20 },
    { predecessorId: taskIds[3] as string, successorId: taskIds[5] as string, type: 'FS', lag: 0 },
    { predecessorId: taskIds[4] as string, successorId: taskIds[5] as string, type: 'FS', lag: 0 },
    { predecessorId: taskIds[5] as string, successorId: taskIds[6] as string, type: 'FS', lag: 0 },
    { predecessorId: taskIds[6] as string, successorId: taskIds[7] as string, type: 'FS', lag: 0 },
  ]);

  const programme = planning.recalculateProgramme(plannerCtx, { contractualDurationDays: 400 });
  planning.approveBaseline(plannerCtx, {
    version: 'BL-01',
    reason: 'Contract baseline agreed at kick-off',
    contractualCompletionDate: '2028-09-30',
  });
  step(
    `Programme calculated: ${programme.projectDurationDays}d duration, ${programme.criticalPath.length} critical activities, ` +
      `P80 ${programme.p80DurationDays}d, P(on time) ${programme.probabilityOnTime}`,
  );

  cost.approveBudget(ownerCtx, {
    version: 'CB-01',
    byCostCode: [
      { costCode: 'CIV.001', description: 'Enabling and earthworks', budgetMinor: 216_000_000 },
      { costCode: 'CIV.002', description: 'Concrete structures', budgetMinor: 684_000_000 },
      { costCode: 'CIV.003', description: 'Filter gallery', budgetMinor: 261_000_000 },
      { costCode: 'CIV.004', description: 'Process pipework', budgetMinor: 166_000_000 },
      { costCode: 'CIV.005', description: 'Testing and commissioning', budgetMinor: 61_000_000 },
      { costCode: 'CIV.006', description: 'Reinstatement', budgetMinor: 74_000_000 },
    ],
    contingencyMinor: 104_000_000,
    managementReserveMinor: 54_000_000,
    tenderMarginPercent: 8,
  });
  step('Cost baseline approved — CONSTRUCTION gate satisfied');

  // Safety controls before work starts.
  const rams = await safety.draftRAMS(safetyCtx, {
    workPackageId: packageId,
    activityDescription: 'Bulk excavation and clarifier base construction',
    location: 'Zone 2, Ashworth WTW',
    steps: [
      { description: 'Set out and scan for buried services', activityType: 'EXCAVATION' },
      { description: 'Excavate in benched stages to formation level', activityType: 'EXCAVATION' },
      { description: 'Install trench support to deep sections', activityType: 'EXCAVATION' },
      { description: 'Lift and place reinforcement cages', activityType: 'LIFTING' },
      { description: 'Concrete pour to base slab', activityType: 'GENERAL' },
    ],
    companyHazardLibrary: [
      {
        activityType: 'EXCAVATION',
        hazards: ['Historic culvert of unknown location on this site'],
        controls: ['Site-specific culvert survey completed before any breaking ground'],
      },
    ],
  });
  safety.approveRAMS(safetyCtx, rams.ramsId, 'Reviewed against site conditions; culvert survey condition added.');
  safety.acknowledgeRAMS(safetyCtx, rams.ramsId, ['OP-001', 'OP-002', 'OP-003', 'OP-004'], hash('rams-briefing-register'));
  step('RAMS drafted from fused company and platform hazard libraries, approved and briefed out');

  safety.recordCompetency(safetyCtx, {
    operativeId: 'OP-001',
    qualification: 'CPCS 360 excavator (above 10t)',
    issuedAt: '2024-03-01',
    expiresAt: '2029-03-01',
    certificateHash: hash('op001-cpcs'),
  });

  /*
   * The eight records the document set is composed from.
   *
   * The Site Documents screen showed **7 of 15 types generatable**, and the
   * document engine was entirely right about the other eight: each declares the
   * records it is composed from, and refuses by name where one is absent rather
   * than filling the section in from an assumption. What was missing was the
   * records, not the engine.
   *
   * They are created **here**, at the point in this project's history where they
   * would really have been created, and through the ordinary domain commands.
   * That matters twice over. A record written directly into the ledger would
   * skip every rule the command enforces — a permit checks each operative's
   * ticket against the permit's own end date, an induction refuses without an
   * approved Construction Phase Plan behind it — so the demonstration would show
   * documents composed from records the platform would never have accepted. And
   * several of these commands are phase-gated: creating them once the project
   * had reached Operations would be refused, correctly, which is why they sit in
   * the construction stretch of the seed rather than at the end of it.
   */

  // The Construction Phase Plan comes first, because two of the others depend
  // on it: an induction is refused without one, and a permit is a formality if
  // there are no site rules to brief.
  //
  // Twelve required sections. `draftDocument` fills what project state can
  // answer — the description, the programme, the significant risks, the duty
  // holders — and reports the rest as gaps rather than inventing them. The ones
  // supplied here are the ones no record can answer, because they are decisions
  // somebody makes about how this site will be run, not facts the platform
  // holds. Approval is refused while any gap remains, which is why they are
  // written out rather than left for the engine to guess at.
  const cpp = cdm.draftDocument(safetyCtx, {
    type: 'CONSTRUCTION_PHASE_PLAN',
    title: 'Construction Phase Plan — Ashworth WTW Phase 2',
    workPackageId: packageId,
    sections: [
      {
        heading: 'Management of the work',
        body:
          'Meridian Infrastructure Group is Principal Contractor. Day-to-day control sits with the site manager, who holds ' +
          'the authority to stop any activity. Work is released package by package against an approved method statement, ' +
          'and no activity starts until its RAMS has been briefed and acknowledged by the people carrying it out. ' +
          'High-risk activities — excavation, lifting, hot work, confined space — additionally require a permit issued ' +
          'against that method statement, and the permit checks each named operative’s ticket against the permit’s own end ' +
          'date rather than against the day it is issued.',
      },
      {
        heading: 'Duty holders and organisational structure',
        body:
          'Client: Meridian Infrastructure Group. Principal Designer and Principal Contractor: Meridian Infrastructure ' +
          'Group. Project Manager: Tom Bramall, accountable for delivery and the single point of contact for the client. ' +
          'Safety lead: accountable for the health and safety arrangements in this plan and the approver of every document ' +
          'in the CDM set. Site manager: day-to-day control of the site and the person who signs the daily closing walk. ' +
          'Designers issue information through the CDE; no design reaches site outside it.',
      },
      {
        heading: 'Health and safety aims',
        body:
          'No person is injured on this project. Every activity is carried out under an approved method statement that has ' +
          'been briefed to the people doing the work. Where a control cannot be maintained, work stops until it can.',
      },
      {
        heading: 'Site rules',
        body:
          'Full site induction before first entry, no exceptions and no visitors unaccompanied. Hard hat, boots and hi-vis ' +
          'across the whole site; eye and hearing protection in the plant exclusion zones. Speed limit 5mph. All plant ' +
          'movements within 5m of an open excavation under a banksman. No lone working after 18:00. Report every near miss ' +
          'the same day — a near miss reported is the one that does not become the next incident.',
      },
      {
        heading: 'Welfare facilities',
        body:
          'A 40-person welfare unit adjacent to the site office (W1 on the logistics plan): heated drying room, mess room ' +
          'with hot water and means of heating food, and separate WC provision. Cleaned daily and inspected weekly by the ' +
          'site manager. Located inside the pedestrian route so nobody crosses a haul road to reach it.',
      },
      {
        heading: 'Fire and emergency procedures',
        body:
          'Muster point at the main gate (G1), with G2 as the emergency egress to the north lane and kept clear at all ' +
          'times. Continuous alarm sounded from the site office. Roll call against the induction register and the daily ' +
          'signing-in sheet. Nearest emergency department: Calderdale Royal Hospital, 11 minutes. Hot work under permit ' +
          'only, with a one-hour fire watch after the work finishes.',
      },
      {
        heading: 'Site induction arrangements',
        body:
          'Delivered by the site manager or the safety lead before first entry, and recorded against the person rather than ' +
          'against a signature sheet. Covers these site rules, the logistics plan, the emergency arrangements and the ' +
          'site-specific culvert briefing. Competencies are checked and recorded at induction, not asserted.',
      },
      {
        heading: 'Consultation with workers',
        body:
          'Weekly point-of-work briefing at the start of each shift, and a monthly safety meeting open to every operative ' +
          'on site including subcontractors. Anybody may stop work on safety grounds without needing to justify it first; ' +
          'the justification comes afterwards and the stop stands until it is resolved.',
      },
      {
        heading: 'Site security',
        body:
          'Perimeter hoarding to the full boundary with the two controlled gates on the logistics plan. Out-of-hours ' +
          'monitored alarm on the office and the container store. Excavations covered or fenced at the end of every shift ' +
          'and checked on the closing walk — the site adjoins a public footpath and a school route.',
      },
    ],
  });
  if (cpp.gaps.length > 0) {
    // Loud rather than silent. A plan with an unfilled section cannot be
    // approved, an induction cannot be recorded without an approved plan, and
    // the failure that follows would otherwise surface three commands later as
    // something unrelated.
    throw new Error(
      `The Construction Phase Plan has ${cpp.gaps.length} unfilled section(s) and cannot be approved: ${cpp.gaps.join('; ')}`,
    );
  }
  cdm.approveDocument(safetyCtx, cpp.documentId, {
    comments: 'Reviewed against the site-specific culvert survey condition and the approved RAMS.',
  });
  step('Construction Phase Plan drafted from project state, its seven judgement sections written, and approved');

  // The rest of the CDM duty set. Sixteen types are declared and one was real,
  // which made the catalogue on the screen a list of things that did not exist.
  // Every one is drafted from the same state the plan above was.
  //
  // Drafted *and completed*, not drafted empty. `principalContractorPosition`
  // reports an unfilled section as a named breach, so fifteen skeleton
  // documents would have produced ninety-three breaches on a project whose
  // paperwork is meant to be in order — an accurate report of a demonstration
  // set up badly. The sections a record cannot answer are in
  // `seed/dutydocuments.ts`, written for this site rather than in general.
  //
  // RAMS is excluded because it is already held as its own richer entity —
  // `safety.draftRAMS` above produces steps, hazards and controls. Two records
  // for one method statement would leave a reader asking which is the one.
  const dutySet = cdm.CDM_DOCUMENTS.filter((spec) => spec.type !== 'CONSTRUCTION_PHASE_PLAN' && spec.type !== 'RAMS');
  let approvedDuties = 0;
  for (const spec of dutySet) {
    const drafted = cdm.draftDocument(safetyCtx, {
      type: spec.type,
      title: `${spec.label} — Ashworth WTW Phase 2`,
      workPackageId: packageId,
      sections: DUTY_SECTIONS[spec.type] ?? [],
    });
    if (drafted.gaps.length > 0) {
      throw new Error(`${spec.label} has ${drafted.gaps.length} unfilled section(s): ${drafted.gaps.join('; ')}`);
    }

    /*
     * Approved only where somebody on this project holds the role the document
     * type requires.
     *
     * Six of the sixteen are signed off by EPC rather than by SAFETY —
     * temporary works, lifting, logistics, underground services, excavation and
     * the equipment register — and `approveDocument` refuses an approver who
     * does not hold that role. Competence under CDM is a legal requirement, not
     * a routing preference, and this demonstration tenancy has no EPC
     * representative.
     *
     * So those six are left **complete and awaiting signature**, which is a
     * real state a real project is in for most of its life, and the position
     * screen shows them as such. They are not breaches: a breach is an
     * *unfilled* section, and there are none. Approving them under the safety
     * lead's name to make the demonstration look tidier would have been
     * recording a signature the platform had just refused.
     */
    if (safetyLead.roles.includes(spec.approver as never)) {
      cdm.approveDocument(safetyCtx, drafted.documentId, {
        comments: 'Reviewed against the site conditions at Ashworth and the approved Construction Phase Plan.',
      });
      approvedDuties += 1;
    }
  }
  step(
    `CDM duty set: all ${dutySet.length + 1} of ${cdm.CDM_DOCUMENTS.length} types drafted complete, ` +
      `${approvedDuties + 1} approved and ${dutySet.length - approvedDuties} awaiting the EPC signature they require`,
  );

  // A permit, under the approved RAMS, for the operative whose ticket is on
  // record above. The command checks that ticket against the permit's end date.
  safety.issuePermit(safetyCtx, {
    activity: 'EXCAVATION',
    location: 'Zone 2, clarifier base, grid C3–D5',
    operativeIds: ['OP-001'],
    validFrom: '2026-08-17T07:00:00.000Z',
    validTo: '2026-08-21T17:00:00.000Z',
    ramsId: rams.ramsId,
    precautions:
      'Culvert survey complete and marked out. Trench support to any face over 1.2m. Edge protection to the full perimeter. ' +
      'Banksman present for every plant movement within 5m of an open face.',
    evidenceHash: hash('permit-excavation-zone2'),
  });
  step('Permit to work issued for excavation, checked against the operative’s CPCS expiry');

  // Two inductions, so the register has somebody on it and the document has a
  // gap to name — the people the platform knows about with no induction.
  for (const person of [
    { personId: 'OP-001', personName: 'Danny Whitworth', employer: 'Northstone Civils Ltd' },
    { personId: 'OP-002', personName: 'Karen Ferris', employer: 'Northstone Civils Ltd' },
  ]) {
    cdm.recordInduction(safetyCtx, {
      ...person,
      inductedBy: safetyLead.name,
      competenciesChecked: ['CSCS', 'Site-specific culvert briefing'],
    });
  }
  step('Site inductions recorded against the approved Construction Phase Plan');

  // The logistics plan the traffic management document is made of. The routes
  // and the largest delivery are what the plan's arithmetic runs against.
  sitevisit.setLogisticsPlan(plannerCtx, {
    elements: [
      { type: 'GATE', reference: 'G1', description: 'Main site entrance from Ashworth Road, banksman controlled' },
      { type: 'GATE', reference: 'G2', description: 'Emergency egress to the north lane, kept clear at all times' },
      { type: 'WELFARE', reference: 'W1', description: 'Welfare unit, 40 person, adjacent to the site office' },
      { type: 'SITE_OFFICE', reference: 'O1', description: 'Site office and meeting room' },
      { type: 'STORAGE', reference: 'S1', description: 'Secure container store for plant and small tools' },
      { type: 'LAYDOWN', reference: 'L1', description: 'Reinforcement and formwork laydown, hard standing' },
      { type: 'WHEEL_WASH', reference: 'WW1', description: 'Wheel wash on the exit leg of G1' },
      { type: 'PEDESTRIAN_ROUTE', reference: 'P1', description: 'Segregated pedestrian route from the car park to the welfare unit' },
    ],
    routes: [
      { reference: 'R1', description: 'Delivery route, G1 to the laydown area', maxVehicleLengthMetres: 16.5, maxHeightMetres: 4.8, maxWeightTonnes: 44 },
      { reference: 'R2', description: 'Haul road, laydown to the clarifier base', maxVehicleLengthMetres: 12, maxWeightTonnes: 32 },
    ],
    largestDelivery: {
      description: 'Reinforcement cage delivery, articulated flatbed',
      lengthMetres: 16.5,
      heightMetres: 4.2,
      weightTonnes: 44,
    },
    notes: 'Deliveries booked in through the site office. No delivery movements during the school run, 08:15 to 08:45.',
  });
  step('Site logistics plan set — gates, routes, welfare and the largest delivery the routes have to take');

  // The progress meeting the minutes are written from, with an action carried
  // from an earlier one so the document has an overdue item to age properly.
  const meeting = meetings.openMeeting(plannerCtx, {
    type: 'PROGRESS',
    title: 'Monthly progress meeting no. 4',
    heldAt: '2026-08-12T10:00:00.000Z',
    location: 'Site office, Ashworth WTW',
    chair: pm.name,
    attendees: [
      { name: pm.name, organisation: 'Meridian Infrastructure Group', role: 'Project Manager', attended: true },
      { name: qs.name, organisation: 'Meridian Infrastructure Group', role: 'Quantity Surveyor', attended: true },
      { name: siteManager.name, organisation: 'Meridian Infrastructure Group', role: 'Site Manager', attended: true },
      { name: designLead.name, organisation: 'Meridian Infrastructure Group', role: 'Lead Designer', attended: false },
    ],
  });
  meetings.recordAgendaItem(plannerCtx, meeting.meetingId, {
    subject: 'Progress against the approved baseline',
    discussion:
      'Zone 2 excavation complete to formation. The clarifier base pour is held pending release of the reinforcement ' +
      'inspection hold point. Zone 3 remains behind the culvert survey.',
  });
  meetings.recordAgendaItem(plannerCtx, meeting.meetingId, {
    subject: 'Design information',
    discussion: 'The builder’s work opening at grid C4 is still unresolved. The RFI has been open beyond its response period.',
  });
  meetings.recordAction(plannerCtx, meeting.meetingId, {
    what: 'Issue the culvert survey report and the revised zone 3 sequence',
    owner: siteManager.name,
    ownerOrganisation: 'Meridian Infrastructure Group',
    by: '2026-08-26',
    // Given at the meeting before this one. `originallyDue` is why the minutes
    // age it from the date it was first given rather than from the date it was
    // last restated — an action raised in July and restated monthly is months
    // overdue, not due next week.
    originallyDue: '2026-07-24',
  });
  meetings.recordAction(plannerCtx, meeting.meetingId, {
    what: 'Close the grid C4 builder’s work opening with the structural engineer',
    owner: designLead.name,
    ownerOrganisation: 'Meridian Infrastructure Group',
    by: '2026-08-26',
  });
  step('Progress meeting minuted with two actions, one carried from the previous meeting and overdue');

  // A material submittal against a clause the specification ingestion produced,
  // with a real departure on it so the document has something to state.
  const mixClause = concreteSpec.clauseIds[1] ?? concreteSpec.clauseIds[0];
  if (mixClause) {
    submittals.raiseSubmittal(designCtx, {
      kind: 'MATERIAL',
      title: 'Concrete mix design, C32/40 to clarifier base',
      clauseId: mixClause,
      manufacturer: 'Pennine Readymix Ltd',
      productReference: 'PRM-C3240-GGBS50',
      claims: [
        { requirement: 'Strength class', specified: 'C32/40', offered: 'C32/40', compliant: true },
        { requirement: 'Conformity certification', specified: 'Third party product conformity', offered: 'BSI Kitemark, plant AS-114', compliant: true },
        {
          requirement: 'Cement replacement',
          specified: 'Not stated',
          offered: '50% GGBS',
          compliant: false,
          justification:
            'Offered to reduce early heat of hydration in a 1m base pour. Slower strength gain extends the striking time, ' +
            'which is accepted in the pour sequence.',
        },
      ],
      procurementLeadTimeDays: 20,
      requiredOnSiteBy: '2026-09-28',
      reviewPeriodDays: 10,
    });
    step('Material submittal raised against specification clause E10, with one departure justified');
  }

  // A non-conformance, raised the way most of them are: found by an inspection
  // rather than reported by anybody.
  quality.raiseNCR(qaqcCtx, {
    description: 'Cover to reinforcement measured at 32mm against a specified 40mm over a 3m2 area of the north wall kicker',
    severity: 'MAJOR',
    proposedAction: 'Break out and recast the affected section of kicker before the wall pour proceeds',
    workPackageId: packageId,
    evidenceHash: hash('ncr-cover-north-kicker'),
  });
  step('Non-conformance raised against the reinforcement cover on the north wall kicker');



  // Risks, quantified.
  safety.registerRisk(safetyCtx, {
    id: '',
    title: 'Unforeseen ground conditions in zone 3',
    category: 'GROUND_CONDITIONS',
    probability: 0.45,
    costImpact: { optimistic: 8_000_000, mostLikely: 24_000_000, pessimistic: 62_000_000 },
    scheduleImpactDays: { optimistic: 5, mostLikely: 18, pessimistic: 45 },
    projectValueMinor: 1_850_000_000,
    projectDurationDays: 400,
    mitigations: [
      { description: 'Complete GI in zone 3 before excavation reaches it', costMinor: 3_500_000, probabilityReduction: 0.5, impactReduction: 0.3 },
    ],
  });
  safety.registerRisk(safetyCtx, {
    id: '',
    title: 'Late MEP design freeze delays pipework interfaces',
    category: 'DESIGN',
    probability: 0.6,
    costImpact: { optimistic: 4_000_000, mostLikely: 15_000_000, pessimistic: 38_000_000 },
    scheduleImpactDays: { optimistic: 10, mostLikely: 25, pessimistic: 60 },
    projectValueMinor: 1_850_000_000,
    projectDurationDays: 400,
    mitigations: [{ description: 'Weekly interface workshop with MEP designer', costMinor: 1_200_000, probabilityReduction: 0.3, impactReduction: 0.25 }],
  });
  const weatherRisk = safety.registerRisk(safetyCtx, {
    id: '',
    title: 'Exceptional rainfall halting concrete pours',
    category: 'WEATHER',
    probability: 0.35,
    costImpact: { optimistic: 2_000_000, mostLikely: 7_000_000, pessimistic: 20_000_000 },
    scheduleImpactDays: { optimistic: 3, mostLikely: 12, pessimistic: 30 },
    projectValueMinor: 1_850_000_000,
    projectDurationDays: 400,
  });
  step('Risk register quantified in money and days');

  // Site execution.
  planning.recordProgress(pmCtx, {
    taskId: taskIds[0] as string,
    percentComplete: 100,
    elapsedDays: 20,
    evidenceDescription: 'Site establishment complete — compound and welfare in place',
    evidenceHash: hash('site-establishment-photos'),
  });
  planning.recordProgress(pmCtx, {
    taskId: taskIds[1] as string,
    percentComplete: 55,
    elapsedDays: 48,
    evidenceDescription: 'Bulk excavation progress survey, week 10',
    evidenceHash: hash('excavation-survey-w10'),
  });
  step('Progress recorded against evidence — productivity below plan on bulk excavation');

  // The daily record. Five consecutive working days rather than one entry,
  // because a diary's evidential value is in being unbroken — a single record
  // proves the command works and proves nothing about the project.
  const diaryDays: Array<{ date: string; weather: planning.DiaryWeather; narrative: string; blockers?: string[] }> = [
    {
      date: '2026-08-10',
      weather: { conditions: 'Dry, light cloud', temperatureC: 19, workingStopped: false },
      narrative: 'Bulk excavation zone 2 continuing. Formation level reached in the north half.',
    },
    {
      date: '2026-08-11',
      weather: { conditions: 'Heavy rain from 11:00, standing water in excavation', temperatureC: 14, workingStopped: true, hoursLost: 5 },
      narrative: 'Excavation stopped late morning. Pumps mobilised to zone 2.',
      blockers: ['Excavation suspended — standing water, formation unworkable'],
    },
    {
      date: '2026-08-12',
      weather: { conditions: 'Overcast, drying', temperatureC: 16, workingStopped: false },
      narrative: 'Dewatering through the morning. Excavation resumed after lunch at reduced output.',
      blockers: ['Half day lost to dewatering before formation could be re-inspected'],
    },
    {
      date: '2026-08-13',
      weather: { conditions: 'Dry and bright', temperatureC: 21, workingStopped: false },
      narrative: 'Formation re-inspected and accepted. Blinding to the north half.',
    },
    {
      date: '2026-08-14',
      weather: { conditions: 'Dry, warm', temperatureC: 23, workingStopped: false },
      narrative: 'Blinding complete. Reinforcement fixing started to bases B1 to B4.',
    },
  ];

  for (const day of diaryDays) {
    planning.recordSiteDiary(
      pmCtx,
      {
        diaryDate: day.date,
        weather: day.weather,
        labour: [
          { trade: 'Groundworks', headcount: 12, hours: 9 },
          { trade: 'Site management', headcount: 3, hours: 10 },
        ],
        plant: [
          { description: '30t excavator', hoursWorked: day.weather.workingStopped ? 3 : 9, hoursIdle: day.weather.workingStopped ? 6 : 0, downtimeReason: day.weather.workingStopped ? 'Weather' : undefined },
          { description: 'Dumper x2', hoursWorked: day.weather.workingStopped ? 3 : 9, hoursIdle: day.weather.workingStopped ? 6 : 0 },
        ],
        progressNarrative: day.narrative,
        workedTaskIds: [taskIds[1] as string],
        deliveries: ['Reinforcement — 8t, delivered to laydown'],
        blockers: day.blockers,
        visitors: ['Client representative, morning walkround'],
        evidenceHash: hash(`site-diary-${day.date}`),
      },
      // Written on the day. The seed models a site that keeps its records,
      // which is the point of comparison for one that does not.
      new Date(`${day.date}T17:30:00.000Z`),
    );
  }
  step('Five consecutive site diaries recorded, including a weather day that stopped work');

  // Last Planner. Three weeks so PPC has a trend rather than a number, and a
  // recurring reason to find — one week's figure says almost nothing.
  const designConstraint = planning.raiseConstraint(
    plannerCtx,
    {
      taskId: taskIds[3] as string,
      category: 'DESIGN',
      description: 'Clarifier wall reinforcement details not issued for construction',
      owner: 'Meridian Design — lead structural engineer',
      needByDate: '2026-08-14',
    },
    new Date('2026-07-20T09:00:00.000Z'),
  );
  planning.raiseConstraint(
    plannerCtx,
    {
      taskId: taskIds[4] as string,
      category: 'MATERIALS',
      description: 'Precast channel units on a 14-week lead time, order not placed',
      owner: 'Procurement manager',
      needByDate: '2026-09-04',
    },
    new Date('2026-07-27T09:00:00.000Z'),
  );

  planning.closeConstraint(
    plannerCtx,
    {
      constraintId: designConstraint.constraintId,
      resolution: 'Reinforcement details issued at revision C following the wall thickness instruction',
    },
    new Date('2026-08-18T09:00:00.000Z'),
  );
  step('Constraints log opened — one design constraint cleared four days late, one long-lead material still open');

  // A site walk. Deliberately mixed: one closed on time, one closed late, one
  // still open and past the date somebody agreed to — which is the only one
  // that matters and the one a list sorted by date would bury.
  const walk: Array<{
    category: planning.SiteObservationCategory;
    description: string;
    location: string;
    taskIndex?: number;
    requiresAction: boolean;
    actionOwner?: string;
    actionByDate?: string;
    observedOn: string;
    closed?: { actionTaken: string; on: string };
  }> = [
    {
      category: 'WORKMANSHIP',
      description: 'Blockwork to the east elevation is out of plumb by roughly 15mm over three courses.',
      location: 'Inlet works, east elevation',
      taskIndex: 2,
      requiresAction: true,
      actionOwner: 'Groundworks foreman',
      actionByDate: '2026-08-14',
      observedOn: '2026-08-10T07:40:00.000Z',
      closed: { actionTaken: 'Three courses taken down and rebuilt to line; re-checked and accepted.', on: '2026-08-13T16:00:00.000Z' },
    },
    {
      category: 'MATERIALS',
      description: 'Cement delivery left unsheeted overnight next to the batching area.',
      location: 'Laydown area',
      requiresAction: true,
      actionOwner: 'Materials controller',
      actionByDate: '2026-08-12',
      observedOn: '2026-08-11T07:20:00.000Z',
      closed: { actionTaken: 'Affected bags quarantined and returned to supplier; remaining stock palletised and sheeted.', on: '2026-08-17T09:00:00.000Z' },
    },
    {
      category: 'ACCESS',
      description: 'Scaffold access to the south face is obstructed by stacked shutter panels.',
      location: 'Filter gallery, south face',
      taskIndex: 3,
      requiresAction: true,
      actionOwner: 'Site manager',
      actionByDate: '2026-08-18',
      observedOn: '2026-08-14T07:30:00.000Z',
    },
    {
      category: 'HOUSEKEEPING',
      description: 'Offcuts and banding accumulating around the rebar stack; noted to the gang at the briefing.',
      location: 'Rebar laydown',
      requiresAction: false,
      observedOn: '2026-08-14T07:35:00.000Z',
    },
  ];

  for (const observation of walk) {
    const captured = planning.captureSiteObservation(
      qaqcCtx,
      {
        category: observation.category,
        description: observation.description,
        location: observation.location,
        taskId: observation.taskIndex === undefined ? undefined : (taskIds[observation.taskIndex] as string),
        observedBy: qaqc.name,
        requiresAction: observation.requiresAction,
        actionOwner: observation.actionOwner,
        actionByDate: observation.actionByDate,
        evidenceHash: hash(`observation-${observation.location}-${observation.observedOn}`),
      },
      new Date(observation.observedOn),
    );

    if (observation.closed) {
      planning.closeSiteObservation(
        qaqcCtx,
        {
          observationId: captured.observationId,
          actionTaken: observation.closed.actionTaken,
          closedBy: observation.actionOwner ?? qaqc.name,
          evidenceHash: hash(`observation-closeout-${captured.reference}`),
        },
        new Date(observation.closed.on),
      );
    }
  }
  step('Site walk: 4 observations, 2 closed (one late), 1 access obstruction still open past its date');

  // The inspection plan written against that specification. Two of the four
  // verification clauses are covered; the mix design submittal and the fair
  // faced trial panel are not, which is the gap the coverage report finds and
  // which neither the ITP nor the specification shows on its own.
  const inspectionPlan = quality.createInspectionPlan(qaqcCtx, {
    workPackageId: packageId,
    title: 'In situ concrete — clarifier walls',
    discipline: 'CIVILS',
    specificationRef: 'E10',
    stages: [
      {
        reference: 'S1',
        description: 'Reinforcement inspection before covering',
        acceptanceCriteria: 'E10/3.4 — reinforcement inspected and released by the Engineer',
        type: 'HOLD',
        responsible: 'Engineer',
      },
      {
        reference: 'S2',
        description: 'Cube sampling at the specified rate',
        acceptanceCriteria: 'E10/3.5 — one set per 50m3 to BS EN 12390-3',
        type: 'WITNESS',
        responsible: 'QA engineer',
      },
      {
        reference: 'S3',
        description: 'Surface finish check after striking',
        acceptanceCriteria: 'E10/3.7 — Class H20 to the NSCS',
        type: 'REVIEW',
        responsible: 'QA engineer',
      },
    ],
  });
  step('ITP written against E10 — 2 of 4 verification clauses covered, the mix design and trial panel are not');

  // The other side agreeing the criteria. Until this happens nothing can be
  // inspected against the plan, because an inspection against criteria only one
  // party has agreed proves nothing at handover.
  quality.approveInspectionPlan(pmCtx, {
    planId: inspectionPlan.planId,
    approvedBy: pm.id,
    approvingRole: "Employer's Representative",
    note: 'Approved. Cube sampling rate to be confirmed against the final pour sequence.',
    evidenceHash: hashEvidence('itp-e10-approval'),
  });
  step('ITP approved by the Employer\u2019s Representative — inspections may now be recorded against it');

  // A work package somebody typed in, alongside the generated ones. Temporary
  // works never come out of a generator — they come out of the contract and a
  // temporary works coordinator.
  planning.createWorkPackage(plannerCtx, {
    wbsCode: 'TW-100',
    title: 'Temporary works — north cofferdam',
    indicativeDurationDays: 24,
    scopeNarrative: 'Design, install, monitor and remove the sheet-piled cofferdam to the north inlet chamber.',
    responsibleParty: 'Temporary works coordinator',
  });

  const weeks: Array<{ start: string; commit: number[]; outcomes: Array<{ i: number; done: boolean; reason?: planning.NonCompletionReason }> }> = [
    {
      start: '2026-08-03',
      commit: [0, 1, 2],
      outcomes: [{ i: 0, done: true }, { i: 1, done: true }, { i: 2, done: true }],
    },
    {
      start: '2026-08-10',
      commit: [1, 2, 5],
      outcomes: [{ i: 1, done: true }, { i: 2, done: false, reason: 'WEATHER' }, { i: 5, done: false, reason: 'DESIGN_INFORMATION' }],
    },
    {
      start: '2026-08-17',
      commit: [1, 5, 6],
      outcomes: [{ i: 1, done: true }, { i: 5, done: false, reason: 'DESIGN_INFORMATION' }, { i: 6, done: true }],
    },
  ];

  let lastPpc = 0;
  for (const week of weeks) {
    const plan = planning.publishLookahead(plannerCtx, {
      weekStarting: week.start,
      plannedTaskIds: taskIds.slice(0, 7) as string[],
      commitments: week.commit.map((i) => ({
        taskId: taskIds[i] as string,
        promise: `Complete the planned quantity on ${String(platform.ledger.require({ refType: 'Task', refId: taskIds[i] as string }).state.name)}`,
        promisedBy: 'Site manager',
        dueDate: week.start,
      })),
    });

    const review = planning.reviewLookahead(plannerCtx, {
      lookaheadId: plan.lookaheadId,
      outcomes: week.outcomes.map((o) => ({ taskId: taskIds[o.i] as string, completed: o.done, reason: o.reason })),
    });
    lastPpc = review.ppcPercent;
  }
  step(`Three weeks of Last Planner run — PPC ${lastPpc}% in the latest week, design information the recurring reason`);

  // The diary feeding the register. A weather risk scored before anybody was on
  // site, then rescored against what the diary actually recorded, is the whole
  // argument for keeping one — and the P80 contingency moves with it rather
  // than staying at the number somebody wrote at tender.
  const rescored = safety.rescoreRisk(safetyCtx, {
    riskId: weatherRisk.riskId,
    probability: 0.55,
    costImpact: { optimistic: 4_000_000, mostLikely: 11_000_000, pessimistic: 26_000_000 },
    scheduleImpactDays: { optimistic: 5, mostLikely: 16, pessimistic: 34 },
    reason: 'One full and one half day lost to standing water in the first week of August; wetter than the tender assumption',
    projectValueMinor: 1_850_000_000,
    projectDurationDays: 400,
  });
  step(`Weather risk rescored against the diary — expected cost moves by ${(rescored.expectedCostMovementMinor / 100).toFixed(0)} pounds`);

  await bim.updateTwinFromSite(bimCtx, {
    observationHash: hash('drone-flight-w10'),
    source: 'DRONE',
    zone: 'Zone 2',
    linkedTaskIds: [taskIds[1] as string],
    observedElements: [
      { elementId: 'EXC-Z2-A', expectedStatus: 'COMPLETE', observedStatus: 'IN_PROGRESS' },
      { elementId: 'EXC-Z2-B', expectedStatus: 'IN_PROGRESS', observedStatus: 'IN_PROGRESS' },
      { elementId: 'BASE-SLAB-01', expectedStatus: 'NOT_STARTED', observedStatus: 'NOT_STARTED' },
    ],
  });

  await safety.logSafetyObservation(safetyCtx, {
    description: 'Operative working within 2m of unsupported excavation edge without edge protection',
    location: 'Zone 2, north face',
    mediaHash: hash('safety-obs-042'),
    observationType: 'UNSAFE_ACT',
    reportedBy: safetyLead.name,
  });

  const safetyForecast = await safety.forecastSafetyRisk(safetyCtx, {
    headcount: 74,
    highRiskActivitiesPlanned: 4,
    adverseWeatherDays: 6,
  });
  step(`Safety forecast: index ${safetyForecast.forecast.riskIndex} (${safetyForecast.forecast.severity})`);

  // Change, delay and claim.
  const change = claimsEngine.submitChangeRequest(pmCtx, {
    description: 'Client instruction to increase clarifier wall thickness from 400mm to 500mm following revised process loading',
    origin: 'CLIENT',
    noticeType: 'CCI',
    reason: 'Revised process design loading issued by the client\'s designer',
    impactedPackageIds: [packageId],
    affectedSubcontractIds: [subcontract.subcontractId],
    supportingEvidenceHash: hash('client-instruction-cci-004'),
  });

  await claimsEngine.assessImpact(pmCtx, {
    changeRequestId: change.changeRequestId,
    costImpactMinor: 34_500_000,
    timeImpactDays: 18,
    affectedTaskIds: [taskIds[3] as string],
    qualityImpact: 'No adverse effect; increased cover to reinforcement',
    safetyImpact: 'Heavier lifts required — lift plan to be revised',
  });

  const variation = claimsEngine.instructVariation(pmCtx, {
    changeRequestId: change.changeRequestId,
    contractId: mainContract.contractId,
    valuationMethod: 'BOQ_RATES',
    valuedAmountMinor: 34_500_000,
    timeImpactDays: 18,
  });
  step(`Change ${change.reference} assessed and instructed as variation ${variation.reference}`);

  // The downstream side of the same change. Capturing it before the client
  // figure is agreed is the whole discipline: agree upstream first and you are
  // agreeing a price without knowing your own cost, and there is no route back.
  claimsEngine.flagDomesticVariation(qsCtx, {
    applicationId: 'SUB-APP-004',
    subcontractId: subcontract.subcontractId,
    changeRequestId: change.changeRequestId,
    description: 'Thicker clarifier walls — additional reinforcement, formwork and pour sequence',
    claimedAmountMinor: 26_800_000,
    claimedTimeDays: 14,
    supportingEvidenceHash: hash('subcontractor-wall-thickness-quotation'),
  });

  const valued = claimsEngine.valueVariation(pmCtx, {
    variationId: variation.variationId,
    valuationMethod: 'BOQ_RATES',
    agreedAmountMinor: 36_900_000,
    agreedTimeDays: 18,
    basis: 'Remeasured against contract rates for C40 concrete and reinforcement, formwork by daywork record',
    agreedWith: 'Ashworth Water Authority — project manager',
  });
  step(
    `Variation ${valued.reference} agreed at ${(valued.agreedAmountMinor / 100).toFixed(0)} pounds against ` +
      `${(valued.downstreamCapturedMinor / 100).toFixed(0)} captured downstream`,
  );

  claimsEngine.issueNotice(qsCtx, {
    contractId: mainContract.contractId,
    type: 'COMPENSATION_EVENT',
    servedTo: 'Ashworth Water Authority',
    content: 'Notification of a compensation event arising from the instruction to increase wall thickness.',
    triggerEventDate: new Date(Date.now() - 6 * 86_400_000).toISOString(),
    relatedEntityRef: { refType: 'Variation', refId: variation.variationId },
  });

  claimsEngine.recordDelayEvent(pmCtx, {
    cause: 'CLIENT_CHANGE',
    description: 'Wall thickness instruction required re-design of formwork and re-sequencing of pours',
    start: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    end: new Date(Date.now() - 22 * 86_400_000).toISOString(),
    criticalDelayDays: 18,
    affectedTaskIds: [taskIds[3] as string],
    noticeServed: true,
    noticeDate: new Date(Date.now() - 38 * 86_400_000).toISOString(),
    evidenceHashes: [hash('cci-004'), hash('revised-formwork-design'), hash('pour-sequence-revision')],
  });

  claimsEngine.recordDelayEvent(pmCtx, {
    cause: 'CONTRACTOR_PRODUCTIVITY',
    description: 'Excavation output below planned rate due to plant availability',
    start: new Date(Date.now() - 35 * 86_400_000).toISOString(),
    end: new Date(Date.now() - 20 * 86_400_000).toISOString(),
    criticalDelayDays: 9,
    affectedTaskIds: [taskIds[1] as string],
    noticeServed: false,
    evidenceHashes: [hash('plant-availability-log')],
  });

  claimsEngine.recordDelayEvent(pmCtx, {
    cause: 'EXCEPTIONAL_WEATHER',
    description: 'Rainfall exceeding 1-in-10-year return period halted pours',
    start: new Date(Date.now() - 18 * 86_400_000).toISOString(),
    end: new Date(Date.now() - 12 * 86_400_000).toISOString(),
    criticalDelayDays: 6,
    affectedTaskIds: [taskIds[3] as string],
    noticeServed: true,
    noticeDate: new Date(Date.now() - 16 * 86_400_000).toISOString(),
    evidenceHashes: [hash('met-office-records'), hash('site-diary-rainfall')],
  });
  step('Three delay events recorded, including one overlapping contractor-risk event');

  const delayForecast = await planning.forecastDelay(plannerCtx, {
    dailyPreliminariesMinor: 1_850_000,
    contractualDurationDays: 400,
  });
  step(
    `Delay forecast: ${delayForecast.snapshot.expectedDelayDays}d expected (${delayForecast.snapshot.severity}), ` +
      `cheapest recovery ${delayForecast.snapshot.correctiveMeasures[0]?.code ?? 'none available'}`,
  );

  const claim = await claimsEngine.assessDelayClaim(qsCtx, {
    contractId: mainContract.contractId,
    claimType: 'EOT',
    claimedDays: 33,
    claimedAmountMinor: 61_050_000,
    dailyProlongationMinor: 1_850_000,
  });
  step(
    `Claim assessed: ${claim.assessment.assessedDays}d supportable against ${claim.assessment.claimedDays}d claimed, ` +
      `entitlement score ${claim.assessment.entitlementScore}`,
  );

  await claimsEngine.buildEvidencePack(qsCtx, {
    claimId: claim.claimId,
    from: '2026-01-01T00:00:00.000Z',
    to: new Date().toISOString(),
    audience: 'ADJUDICATOR',
  });
  step('Court-ready evidence pack built from the hash-chained record');

  // Commercial cycle.
  cost.postActualCost(qsCtx, { costCode: 'CIV.001', amountMinor: 168_000_000, date: '2026-09-30', sourceSystem: 'ERP', description: 'Enabling and earthworks to date' });
  cost.postActualCost(qsCtx, { costCode: 'CIV.002', amountMinor: 66_000_000, date: '2026-09-30', sourceSystem: 'ERP', description: 'Concrete structures to date' });

  const paymentCycle = cost.generatePaymentSchedule(qsCtx, {
    contractId: mainContract.contractId,
    startDate: '2026-07-01',
    cycles: 12,
    direction: 'UPSTREAM',
    terms: { applicationDayOfMonth: 25, paymentNoticeDays: 5, payLessNoticeDaysBeforeFinal: 7, finalDateDays: 30 },
  });

  // Three cycles, so the commercial ledger has a real certified and paid
  // position rather than an application asserting a certification history that
  // nothing in the record supports.
  const application1 = cost.submitApplication(qsCtx, {
    cycleId: paymentCycle.cycleId,
    cycleNumber: 1,
    grossValuationMinor: 180_000_000,
    variationsIncludedMinor: 0,
    previouslyCertifiedMinor: 0,
    retentionMinor: 5_400_000,
    supportingEvidenceHash: hash('application-1-valuation'),
  });
  const certificate1 = cost.certifyApplication(ownerCtx, {
    applicationId: application1.applicationId,
    certifiedMinor: application1.netAppliedMinor,
    retentionMinor: 5_400_000,
    issuedDate: '2026-07-30',
    certificateHash: hash('certificate-1'),
  });
  cost.postPayment(ownerCtx, {
    certificateId: certificate1.certificateId,
    amountMinor: certificate1.certifiedMinor,
    paidDate: '2026-08-24',
    reference: 'BACS-2026-08-0417',
  });

  const application2 = cost.submitApplication(qsCtx, {
    cycleId: paymentCycle.cycleId,
    cycleNumber: 2,
    grossValuationMinor: 410_000_000,
    variationsIncludedMinor: 15_000_000,
    previouslyCertifiedMinor: 180_000_000,
    retentionMinor: 12_750_000,
    supportingEvidenceHash: hash('application-2-valuation'),
  });
  const certificate2 = cost.certifyApplication(ownerCtx, {
    applicationId: application2.applicationId,
    certifiedMinor: application2.netAppliedMinor,
    retentionMinor: 12_750_000,
    issuedDate: '2026-08-29',
    certificateHash: hash('certificate-2'),
  });
  cost.postPayment(ownerCtx, {
    certificateId: certificate2.certificateId,
    amountMinor: certificate2.certifiedMinor,
    paidDate: '2026-09-23',
    reference: 'BACS-2026-09-0562',
  });

  const application3 = cost.submitApplication(qsCtx, {
    cycleId: paymentCycle.cycleId,
    cycleNumber: 3,
    grossValuationMinor: 620_000_000,
    variationsIncludedMinor: 34_500_000,
    previouslyCertifiedMinor: 410_000_000,
    retentionMinor: 19_635_000,
    supportingEvidenceHash: hash('application-3-valuation'),
  });
  // Certified short and left unpaid, so the ledger bridge has something real to
  // report: a withheld sum with a stated reason, and an unpaid certificate in
  // the exception queue.
  cost.certifyApplication(ownerCtx, {
    applicationId: application3.applicationId,
    certifiedMinor: 212_900_000,
    retentionMinor: 19_635_000,
    issuedDate: '2026-10-29',
    certificateHash: hash('certificate-3'),
    reason: 'Handrail terminations not to detail and dewatering rates not agreed',
  });
  step('Three payment cycles run: two certified and paid, the third certified short and outstanding');

  // The dispute that follows from the certificate above, referred to statutory
  // adjudication. Live rather than concluded: the referral is in, the twenty-
  // eight days are running, and the demo shows a clock nobody can afford to
  // stop watching rather than a closed file.
  // Named for what it is. The platform has a tender `adjudication` too — the
  // commercial decision closing a bid evaluation — and they share a word and
  // nothing else.
  const statutoryAdjudication = claimsEngine.openDispute(qsCtx, {
    contractId: mainContract.contractId,
    natureOfDispute:
      'The valuation of the increased wall thickness instruction, and the contractor\'s entitlement to an extension of time for the design information that followed it.',
    redressSought:
      'A decision that the variation is valued at £3,266,500 and that the completion date is extended by 18 days.',
    disputedAmountMinor: 326_650_000,
    referringParty: 'Meridian Infrastructure Group',
    respondingParty: 'Ashworth Water Authority',
    noticeDate: '2026-08-10',
    relatedApplicationId: application3.applicationId,
    evidenceHash: hash('notice-of-adjudication-app-3'),
  });
  claimsEngine.referDispute(qsCtx, {
    disputeId: statutoryAdjudication.disputeId,
    adjudicatorName: 'H. Vance FRICS FCIArb',
    nominatingBody: 'RICS Dispute Resolution Service',
    referralDate: '2026-08-17',
    evidenceHash: hash('referral-app-3'),
  });
  step(`${statutoryAdjudication.reference} referred to adjudication — 28 days to a decision from 17 August`);

  claimsEngine.flagDomesticVariation(qsCtx, {
    applicationId: 'SUB-APP-003',
    subcontractId: subcontract.subcontractId,
    description: 'Additional dewatering claimed by subcontractor within payment application',
    claimedAmountMinor: 22_400_000,
    claimedTimeDays: 7,
    supportingEvidenceHash: hash('subcontractor-dewatering-claim'),
  });
  step('Domestic variation caught inside a trade application — early warning raised');

  // Planned value at the September data date. Physical progress is 13.6% of
  // the baselined duration against 15.5% planned, which is where the schedule
  // performance index below comes from.
  cost.takeEVMSnapshot(qsCtx, { period: '2026-09', plannedValueMinor: 226_600_000 });
  const cvr = await cost.publishCVR(qsCtx, {
    period: '2026-09',
    costToCompleteMinor: 1_512_000_000,
    accrualsMinor: 47_000_000,
  });
  step(`CVR published: forecast margin ${cvr.cvr.forecastMarginPercent}% (${cvr.cvr.marginErosionPercent} points against tender)`);

  cost.forecastCashflow(qsCtx, { totalValueMinor: 1_760_000_000, periods: 27, paymentLagDays: 30, retentionPercent: 3 });

  // --- COMMISSIONING ---------------------------------------------------------
  // Each activity closes out against its own planned duration, some over and
  // some under. A flat number here would produce nonsense slippage — a 21-day
  // test showing 39 days late and a 90-day pour finishing a month early.
  const CLOSE_OUT_DAYS: Record<string, number> = {
    A200: 82, // bulk excavation — 60d planned, the productivity problem carried through
    A300: 52, // blinding and base slabs — 45d planned, late off the back of excavation
    A400: 96, // clarifier walls — 90d planned
    A500: 68, // filter gallery substructure — 70d planned, recovered two days
    A600: 61, // process pipework — 55d planned
    A700: 24, // watertightness testing — 21d planned
    A800: 30, // reinstatement and handover — 30d planned, to plan
  };

  for (const [index, taskId] of taskIds.slice(1).entries()) {
    const activityCode = `A${index + 2}00`;
    planning.recordProgress(pmCtx, {
      taskId,
      percentComplete: 100,
      elapsedDays: CLOSE_OUT_DAYS[activityCode] ?? 60,
      evidenceDescription: 'Works complete and inspected',
      evidenceHash: hash(`completion-${taskId}`),
    });
  }

  const commissioning = handover.recordCommissioningTest(qaqcCtx, {
    systemId: 'SYS-CLARIFIER-01',
    systemName: 'Clarifier No.1 watertightness',
    testType: 'Watertightness test',
    testStandard: 'BS EN 1992-3',
    result: 'PASS',
    readings: [
      { parameter: 'Drop over 7 days', expected: '<= 10mm', actual: '6mm', withinTolerance: true },
      { parameter: 'Visible seepage', expected: 'None', actual: 'None', withinTolerance: true },
    ],
    witnessedBy: 'Client engineer',
    certificateHash: hash('watertightness-cert-01'),
  });
  handover.acceptSystem(qaqcCtx, commissioning.testId, 'Ashworth Water Authority', hash('system-acceptance-01'));

  handover.raiseSnag(qaqcCtx, {
    location: 'Filter gallery, grid B3',
    description: 'Handrail termination not compliant with detail',
    costCode: 'CIV.003',
    responsibleTrade: 'Metalwork',
    responsibleSubcontractId: subcontract.subcontractId,
    photoHash: hash('snag-001'),
  });
  handover.dispatchSnags(qaqcCtx, 'CIV.003');

  await bim.generateAsBuilt(bimCtx, { baseModelId: model.modelId });
  step('Commissioning passed, snags dispatched by cost code, as-built generated from site captures');

  structure.transitionPhase(ownerCtx, { to: 'COMMISSIONING', justification: 'Physical works complete; systems testing underway' });
  structure.transitionPhase(ownerCtx, { to: 'HANDOVER', justification: 'All systems tested and accepted' });

  // --- HANDOVER --------------------------------------------------------------
  const asset = handover.registerAsset(fmCtx, {
    assetTag: 'AST-CLR-001',
    description: 'Clarifier No.1 scraper bridge drive unit',
    assetClass: 'ROTATING_PLANT',
    manufacturer: 'Hydrotech',
    modelNumber: 'SB-4000',
    serialNumber: 'SN-88213',
    // Relative to the run, not a fixed date. It was '2027-11-15' — an
    // installation date in the future, on a project the seed has already taken
    // through to HANDOVER, with a fifteen-year replacement plan counted from
    // it. A literal here is wrong twice: it was wrong when written, and any
    // replacement literal goes stale the moment the clock passes it.
    installedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
    location: 'Clarifier No.1',
    expectedLifeYears: 15,
    replacementCostMinor: 4_200_000,
  });
  handover.registerAsset(fmCtx, {
    assetTag: 'AST-PMP-004',
    description: 'Raw water transfer pump',
    assetClass: 'PUMP',
    manufacturer: 'Flowserve',
    modelNumber: 'FS-220',
    installedAt: '2019-06-01T00:00:00.000Z',
    location: 'Inlet works',
    expectedLifeYears: 10,
    replacementCostMinor: 2_800_000,
  });

  handover.registerWarranty(fmCtx, {
    assetId: asset.assetId,
    provider: 'Hydrotech Ltd',
    startDate: '2027-11-15T00:00:00.000Z',
    durationMonths: 24,
    coverage: 'Parts and labour, excluding consumables',
    documentHash: hash('hydrotech-warranty'),
  });

  await handover.publishOMManual(fmCtx, {
    assetIds: [asset.assetId],
    sourceDocumentHashes: [hash('hydrotech-om-manual'), hash('hydrotech-spares-list')],
    systemName: 'Clarifier scraper bridge',
  });

  const handoverPack = await handover.compileHandoverPack(pmCtx, {
    receivingPartyId: 'CLIENT-AWA',
    receivingPartyName: 'Ashworth Water Authority',
  });
  handover.acceptHandover(ownerCtx, {
    packId: handoverPack.packId,
    acceptedBy: 'Ashworth Water Authority',
    qualifications: handoverPack.gaps,
    acceptanceHash: hash('handover-acceptance'),
  });
  step(`Handover pack compiled at ${(handoverPack.completeness * 100).toFixed(0)}% completeness and accepted`);

  structure.transitionPhase(ownerCtx, { to: 'OPERATIONS', justification: 'Asset handed over and accepted into operation' });

  // --- OPERATIONS ------------------------------------------------------------
  const defect = handover.raiseDefect(fmCtx, {
    assetId: asset.assetId,
    location: 'Clarifier No.1',
    description: 'Scraper bridge drive showing intermittent overload trip',
    severity: 'MAJOR',
    reportedBy: 'Operations technician',
    evidenceHash: hash('defect-photo-001'),
  });
  const workOrder = handover.raiseWorkOrder(fmCtx, {
    assetId: asset.assetId,
    type: 'CORRECTIVE',
    description: 'Investigate and rectify drive overload trip',
    priority: 'HIGH',
    dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    linkedDefectId: defect.defectId,
    estimatedCostMinor: 180_000,
  });
  handover.closeWorkOrder(fmCtx, {
    workOrderId: workOrder.workOrderId,
    actualCostMinor: 145_000,
    completionNotes: 'Drive coupling realigned and overload relay reset; monitored over 72 hours.',
    completionEvidenceHash: hash('wo-completion-001'),
  });
  step(
    `Defect ${defect.reference} raised${defect.warrantyCovered ? ' — covered under warranty, recharged to the manufacturer' : ''}`,
  );

  const maintenance = await handover.forecastMaintenance(fmCtx, { horizonMonths: 60, annualBudgetMinor: 12_000_000 });
  step(
    `Maintenance forecast over 5 years: ${maintenance.schedule.length} interventions, ` +
      `${(maintenance.totalForecastMinor / 100).toLocaleString()} GBP, budget pressure ${maintenance.budgetPressure}`,
  );

  // Everything the tender, construction, commissioning and handover stages
  // produced, reviewed the same way. The concept-gate sweep above covered what
  // existed then; this covers the rest, so no stage gate reports an AI output
  // nobody stood behind.
  step(`AI outputs reviewed across the remaining stages: ${disposeOutstandingAIOutputs()} decided`);

  // --- CORPORATE MEMORY ------------------------------------------------------
  // What this job taught the business, in a form the next one can find. Each
  // carries what it cost, because a lesson with no impact is an anecdote.
  for (const lesson of [
    {
      title: 'Made ground was deeper and more variable than the preliminary GI indicated',
      category: 'GROUND_CONDITIONS' as const,
      kind: 'WENT_WRONG' as const,
      stage: 'PRECONSTRUCTION' as const,
      whatHappened:
        'The preliminary ground investigation sampled on a 40m grid across the clarifier footprint. Made ground ran 1.8m deeper than logged across roughly a third of the area, and the additional excavation and disposal was not in the tender.',
      recommendation:
        'On brownfield water treatment sites, price an intrusive GI at 20m centres across the structural footprint before the tender is submitted, or qualify the bid against the depth of made ground explicitly.',
      costImpactMinor: 31_400_000,
      scheduleImpactDays: 16,
      relatedControlItemId: 'PRE.SURVEYS',
    },
    {
      title: 'Process pipework design was released after the procurement programme required it',
      category: 'DESIGN' as const,
      kind: 'WENT_WRONG' as const,
      stage: 'PRECONSTRUCTION' as const,
      whatHappened:
        'The specialist pipework package could not be enquired until the process design was issued, which arrived eleven weeks after the date the procurement schedule assumed. The package was let on a compressed tender period with two returns rather than four.',
      recommendation:
        'Tie the procurement schedule to the design release programme at tender stage and raise a constraint the moment a design release date moves, rather than discovering it when the enquiry is due out.',
      costImpactMinor: 18_900_000,
      scheduleImpactDays: 11,
      relatedControlItemId: 'PRE.PROCUREMENT_SCHEDULE',
    },
    {
      title: 'Prequalification caught a supplier whose employers liability had lapsed',
      category: 'SUPPLY_CHAIN' as const,
      kind: 'WENT_WELL' as const,
      stage: 'MOBILISATION' as const,
      whatHappened:
        'A firm invited to the groundworks enquiry had let its employers liability policy expire between registration and enquiry. The register refused the enquiry rather than deducting points, so the gap was closed before anybody was on site.',
      recommendation:
        'Keep insurance expiry as a hard bar rather than a scored criterion. Continue re-checking at the point of enquiry as well as at prequalification, because the gap opens between the two.',
      scheduleImpactDays: 0,
    },
  ]) {
    control.captureLesson(pmCtx, lesson);
  }

  const library = control.lessonsLibrary(pmCtx);
  const position = control.projectControl(pmCtx);
  step(
    `Lessons captured: ${library.lessons.length} across ${library.contributingProjects} project, ` +
      `${(library.recurring.reduce((s, r) => s + r.costImpactMinor, 0) / 100).toLocaleString()} GBP of quantified impact`,
  );
  step(
    `Project control: ${position.completenessPercent}% of due and trackable items in place, ` +
      `${position.gaps.length} gaps, ${position.notTracked.length} items the platform does not yet track`,
  );

  const extras = await ensureDemonstrationExtras(platform);
  for (const line of extras.timeline) step(line);

  const wallet = platform.wallet(tenant.id).snapshot();
  step(
    `AI spend for the whole lifecycle: ${(wallet.monthBilledMinor / 100).toFixed(2)} GBP billed on ` +
      `${(wallet.monthRawSpendMinor / 100).toFixed(2)} GBP of provider cost`,
  );

  return {
    tenantId: tenant.id,
    projectId,
    // Read back from the chain rather than carried out of the block that made
    // them: they are created by `ensureDemonstrationExtras`, which also runs on
    // a tenancy this call did not build.
    workingProjects: platform.ledger
      .entitiesOfType('Project')
      .filter((r) => r.tenantId === tenant.id && r.state.name !== DEMO_TENANCY.projectName)
      .map((r) => ({ projectId: r.refId, name: String(r.state.name), phase: String(r.state.phase) })),
    enterpriseName: DEMO_TENANCY.enterpriseName,
    portfolioName: DEMO_TENANCY.portfolioName,
    projectName: DEMO_TENANCY.projectName,
    users: {
      // The operator is a different account layer, not a senior tenant user.
      // It was created but never returned, which is why nothing could test the
      // separation between the operator layer and customer delivery data.
      operator: { id: operator.id, auth: authOf(platform, operator.id) },
      admin: { id: admin.id, auth: adminAuth },
      owner: { id: owner.id, auth: authOf(platform, owner.id) },
      pm: { id: pm.id, auth: authOf(platform, pm.id) },
      qs: { id: qs.id, auth: authOf(platform, qs.id) },
      constructionManager: { id: constructionManager.id, auth: authOf(platform, constructionManager.id) },
      planner: { id: planner.id, auth: authOf(platform, planner.id) },
      safety: { id: safetyLead.id, auth: authOf(platform, safetyLead.id) },
      bim: { id: bimLead.id, auth: authOf(platform, bimLead.id) },
      designer: { id: designLead.id, auth: authOf(platform, designLead.id) },
      qaqc: { id: qaqc.id, auth: authOf(platform, qaqc.id) },
      siteManager: { id: siteManager.id, auth: authOf(platform, siteManager.id) },
      fm: { id: fm.id, auth: authOf(platform, fm.id) },
      regulator: { id: regulator.id, auth: authOf(platform, regulator.id) },
    },
    timeline,
    acuConsumedMinor: wallet.monthBilledMinor,
  };
}
