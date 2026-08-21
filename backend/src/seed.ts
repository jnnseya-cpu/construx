import { hashEvidence } from './core/canonical.ts';
import * as business from './domain/business.ts';
import * as control from './domain/control.ts';
import * as procurement from './domain/procurement.ts';
import * as radar from './domain/radar.ts';
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
import { issueTokens } from './identity/auth.ts';
import type { Platform } from './platform.ts';

/**
 * Seed a complete project across the entire lifecycle.
 *
 * This is the working demonstration of the platform: one asset, taken from
 * concept to operations, with every state change written through the Golden
 * Thread. It is also the fixture the tests and the console run against.
 */

export type SeedResult = {
  tenantId: string;
  projectId: string;
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

function authOf(platform: Platform, userId: string): AuthContext {
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
  const timeline: string[] = [];
  const step = (message: string): void => {
    timeline.push(message);
  };

  // --- Platform operator onboards the tenant --------------------------------
  const operator = platform.createOperator({
    name: 'Platform Operator',
    email: 'operator@construx.example',
  });
  step(`Platform operator account created: ${operator.name}`);

  const { tenant, subscription } = platform.createTenant({
    legalName: 'Meridian Infrastructure Group Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
    enterpriseName: 'Meridian Infrastructure Group',
  });
  step(`Tenant onboarded: ${tenant.legalName} on the ${subscription.tier} tier`);

  // Real AI work needs real credit; the trial grant alone will not carry a
  // whole lifecycle, and running out mid-demo is exactly what should happen
  // if it is not topped up.
  platform.topUp(tenant.id, 500_000);
  step('ACU wallet topped up with prepaid credit');

  // --- Enterprise admin creates the delivery team ---------------------------
  const admin = platform.createUser({
    tenantId: tenant.id,
    name: 'Amara Osei',
    email: 'amara.osei@meridian.example',
    roles: ['ENTERPRISE_ADMIN'],
  });
  const owner = platform.createUser({ tenantId: tenant.id, name: 'Client Representative', email: 'owner@meridian.example', roles: ['OWNER'] });
  const pm = platform.createUser({ tenantId: tenant.id, name: 'Project Manager', email: 'pm@meridian.example', roles: ['PM'] });
  const qs = platform.createUser({ tenantId: tenant.id, name: 'Quantity Surveyor', email: 'qs@meridian.example', roles: ['QS'] });
  const planner = platform.createUser({ tenantId: tenant.id, name: 'Planning Manager', email: 'planner@meridian.example', roles: ['PLANNER'] });
  const safetyLead = platform.createUser({ tenantId: tenant.id, name: 'HSE Manager', email: 'hse@meridian.example', roles: ['SAFETY'] });
  const bimLead = platform.createUser({ tenantId: tenant.id, name: 'BIM Manager', email: 'bim@meridian.example', roles: ['BIM'] });
  const qaqc = platform.createUser({ tenantId: tenant.id, name: 'QA/QC Engineer', email: 'qaqc@meridian.example', roles: ['QAQC'] });
  const fm = platform.createUser({ tenantId: tenant.id, name: 'Facilities Manager', email: 'fm@meridian.example', roles: ['FM'] });
  const regulator = platform.createUser({ tenantId: tenant.id, name: 'Building Safety Regulator', email: 'regulator@meridian.example', roles: ['REGULATOR'] });
  step('Ten named identities assigned across the delivery team');

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
      title: 'Ashworth Water Treatment Works — Phase 2',
      clientName: 'Northern Water Authority',
      sectorType: 'INFRASTRUCTURE',
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
      sectorType: 'INFRASTRUCTURE',
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
      sectorType: 'BUILDING',
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
      sectorType: 'INFRASTRUCTURE',
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
      sectorType: 'INFRASTRUCTURE',
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
    sectors: ['INFRASTRUCTURE', 'BUILDING'],
    cpvCodes: ['45232400', '45252100', '45231300'],
    valueBandMinor: { min: 500_000_00, max: 4_000_000_000 },
    insurances: [
      { type: 'Public liability', limitMinor: 1_000_000_000, expiresOn: '2027-03-31' },
      { type: 'Employers liability', limitMinor: 1_000_000_000, expiresOn: '2027-03-31' },
      { type: 'Professional indemnity', limitMinor: 500_000_000, expiresOn: '2027-03-31' },
    ],
    accreditations: ['CHAS', 'Constructionline Gold', 'ISO 9001', 'ISO 45001'],
    references: [
      { clientName: 'Northern Water Authority', projectName: 'Ashworth WTW Phase 1', sector: 'INFRASTRUCTURE', valueMinor: 1_400_000_000, completedYear: 2024, verified: true },
      { clientName: 'Coastal Drainage Board', projectName: 'Seaton pumping station', sector: 'INFRASTRUCTURE', valueMinor: 620_000_000, completedYear: 2023, verified: true },
      { clientName: 'Pennine Councils', projectName: 'Depot rationalisation', sector: 'BUILDING', valueMinor: 310_000_000, completedYear: 2023, verified: true },
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
        sector: 'INFRASTRUCTURE',
        cpvCodes: ['45232400'],
        estimatedValueMinor: 940_000_000,
        durationWeeks: 74,
        deadline: '2026-04-17',
        scope: 'Strengthening of the existing spillway chute and stilling basin, including anchor installation',
        requirements: {
          minimumTurnoverMinor: 5_000_000_000,
          insurances: [{ type: 'Public liability', minimumLimitMinor: 1_000_000_000 }],
          accreditations: ['CHAS'],
          experience: [{ sector: 'INFRASTRUCTURE', minimumProjects: 2, minimumValueMinor: 500_000_000 }],
        },
        estimatedBidders: 4,
        source: 'Find a Tender',
      },
      {
        reference: 'FTS-2026-11903',
        title: 'Secondary school refurbishment, Birmingham',
        clientName: 'Midlands Education Trust',
        region: 'Birmingham',
        sector: 'BUILDING',
        estimatedValueMinor: 38_000_000,
        durationWeeks: 14,
        deadline: '2026-03-27',
        scope: 'Refurbishment of teaching blocks including M&E replacement and fire compartmentation',
        requirements: {
          minimumTurnoverMinor: 1_000_000_000,
          accreditations: ['CHAS'],
          experience: [{ sector: 'BUILDING', minimumProjects: 3 }],
        },
        estimatedBidders: 6,
        source: 'Contracts Finder',
      },
      {
        reference: 'FTS-2026-11855',
        title: 'Trunk road widening, M62 J20-22',
        clientName: 'National Highways',
        region: 'Rochdale',
        sector: 'INFRASTRUCTURE',
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
        sector: 'INFRASTRUCTURE',
        cpvCodes: ['45252100'],
        estimatedValueMinor: 2_100_000_000,
        durationWeeks: 88,
        deadline: '2026-03-09',
        scope: 'New inlet works, screening and flow control',
        requirements: {
          minimumTurnoverMinor: 6_000_000_000,
          insurances: [{ type: 'Professional indemnity', minimumLimitMinor: 500_000_000 }],
          experience: [{ sector: 'INFRASTRUCTURE', minimumProjects: 2 }],
        },
        estimatedBidders: 12,
        source: 'Client framework',
      },
      {
        reference: 'FTS-2026-11720',
        title: 'Hospital energy centre, Norwich',
        clientName: 'East Anglia NHS Trust',
        region: 'Norwich',
        sector: 'BUILDING',
        estimatedValueMinor: 620_000_000,
        durationWeeks: 62,
        deadline: '2026-04-30',
        scope: 'New energy centre including CHP and district heating connections',
        requirements: {
          minimumTurnoverMinor: 3_000_000_000,
          accreditations: ['CHAS', 'ISO 14001'],
          experience: [{ sector: 'BUILDING', minimumProjects: 2, minimumValueMinor: 400_000_000 }],
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
    name: 'National Water Resilience Programme',
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
    name: 'Ashworth Water Treatment Works — Phase 2',
    sectorType: 'INFRASTRUCTURE',
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

  structure.transitionPhase(ownerCtx, { to: 'DESIGN', justification: 'Scope defined and funding approved at gate review' });

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
    { legalName: 'Northstone Civils Ltd', trades: ['GROUNDWORKS', 'CIVIL_ENGINEERING', 'CONCRETE_WORKS'], incorporated: '2008-03-14', riddor: 0, packagesCompleted: 6, disputes: 0, onTime: 92 },
    { legalName: 'Calder Construction Ltd', trades: ['GROUNDWORKS', 'CIVIL_ENGINEERING', 'DRAINAGE'], incorporated: '2014-09-02', riddor: 0, packagesCompleted: 1, disputes: 0, onTime: 88 },
    { legalName: 'Pennine Groundworks Ltd', trades: ['GROUNDWORKS', 'EARTHWORKS'], incorporated: '2019-06-20', riddor: 1, packagesCompleted: 2, disputes: 0, onTime: 78 },
  ].map((firm) => {
    const { supplierId } = supplychain.registerSupplier(qsCtx, {
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
    return { supplierId, name: firm.legalName, status: result.status };
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
      supplierName: 'Calder Construction Group',
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
      supplierName: 'Pennine Structures Ltd',
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
  quality.createInspectionPlan(qaqcCtx, {
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
    installedAt: '2027-11-15T00:00:00.000Z',
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

  const wallet = platform.wallet(tenant.id).snapshot();
  step(
    `AI spend for the whole lifecycle: ${(wallet.monthBilledMinor / 100).toFixed(2)} GBP billed on ` +
      `${(wallet.monthRawSpendMinor / 100).toFixed(2)} GBP of provider cost`,
  );

  return {
    tenantId: tenant.id,
    projectId,
    enterpriseName: 'Meridian Infrastructure Group',
    portfolioName: 'National Water Resilience Programme',
    projectName: 'Ashworth Water Treatment Works — Phase 2',
    users: {
      // The operator is a different account layer, not a senior tenant user.
      // It was created but never returned, which is why nothing could test the
      // separation between the operator layer and customer delivery data.
      operator: { id: operator.id, auth: authOf(platform, operator.id) },
      admin: { id: admin.id, auth: adminAuth },
      owner: { id: owner.id, auth: authOf(platform, owner.id) },
      pm: { id: pm.id, auth: authOf(platform, pm.id) },
      qs: { id: qs.id, auth: authOf(platform, qs.id) },
      planner: { id: planner.id, auth: authOf(platform, planner.id) },
      safety: { id: safetyLead.id, auth: authOf(platform, safetyLead.id) },
      bim: { id: bimLead.id, auth: authOf(platform, bimLead.id) },
      qaqc: { id: qaqc.id, auth: authOf(platform, qaqc.id) },
      fm: { id: fm.id, auth: authOf(platform, fm.id) },
      regulator: { id: regulator.id, auth: authOf(platform, regulator.id) },
    },
    timeline,
    acuConsumedMinor: wallet.monthBilledMinor,
  };
}
