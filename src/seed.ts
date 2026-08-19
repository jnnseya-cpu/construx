import { hashEvidence } from './core/canonical.ts';
import * as procurement from './domain/procurement.ts';
import * as structure from './domain/structure.ts';
import * as supplychain from './domain/supplychain.ts';
import type { EngineContext } from './engines/context.ts';
import * as bim from './engines/bim.ts';
import * as claimsEngine from './engines/claims.ts';
import * as cost from './engines/cost.ts';
import * as handover from './engines/handover.ts';
import * as planning from './engines/planning.ts';
import * as safety from './engines/safety.ts';
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

  bim.addMarkup(bimCtx, {
    drawingId: drawing.drawingId,
    author: bimLead.name,
    note: 'Wall penetration at grid C4 conflicts with DN450 process main. Confirm required builder\'s work opening and structural adequacy.',
    region: { x: 0.42, y: 0.31, width: 0.1, height: 0.08 },
    convertTo: 'RFI',
  });
  step('Clash converted into a numbered RFI, linked to the drawing revision');

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

  const estimate = tender.buildEstimate(qsCtx, {
    packageId,
    lines: [
      { boqItemId: takeoff.boqItemIds[0] as string, description: 'Bulk excavation', unit: 'm3', quantity: 18_400, labourMinor: 40_000_000, plantMinor: 64_000_000, materialMinor: 0, subcontractMinor: 0 },
      { boqItemId: takeoff.boqItemIds[1] as string, description: 'RC to walls', unit: 'm3', quantity: 3_260, labourMinor: 212_600_000, plantMinor: 42_500_000, materialMinor: 170_000_000, subcontractMinor: 0 },
      { boqItemId: takeoff.boqItemIds[2] as string, description: 'Reinforcement', unit: 't', quantity: 412, labourMinor: 89_500_000, plantMinor: 17_900_000, materialMinor: 197_000_000, subcontractMinor: 0 },
      { boqItemId: takeoff.boqItemIds[3] as string, description: 'Formwork', unit: 'm2', quantity: 9_800, labourMinor: 170_400_000, plantMinor: 34_100_000, materialMinor: 63_900_000, subcontractMinor: 0 },
      { boqItemId: takeoff.boqItemIds[4] as string, description: 'Process pipework', unit: 'm', quantity: 640, labourMinor: 55_600_000, plantMinor: 13_900_000, materialMinor: 139_100_000, subcontractMinor: 0 },
    ],
    prelimsPercent: 14,
    overheadPercent: 6,
    profitPercent: 8,
    riskAllowanceMinor: 121_000_000,
    basisOfEstimate: 'Bottom-up from measured quantities against regional rate library, Q2 2026 prices',
    assumptions: [
      'Continuous access to the works area from commencement',
      'Groundwater controlled by sump pumping; no wellpoint dewatering allowed for',
      'Made ground classified as non-hazardous based on preliminary GI',
    ],
  });
  step(`Estimate built: ${(estimate.totalMinor / 100).toLocaleString()} GBP with risk priced explicitly`);

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
  safety.registerRisk(safetyCtx, {
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
