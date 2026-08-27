import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import { assertNotFuture } from '../domain/dates.ts';
import { commissioningBlockedReason } from '../domain/completion.ts';
import { handoverAcceptanceBlockedReason } from '../domain/handoveracceptance.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';

/**
 * Engine G — Handover & O&M Intelligence.
 *
 * The point at which most construction data dies. Here the same spine carries
 * on: commissioning results, the asset register, warranties, defects and
 * maintenance all reference the events that created them, for the 30+ years the
 * asset is actually in use.
 */

// --- Commissioning -----------------------------------------------------------

export function recordCommissioningTest(
  ctx: EngineContext,
  input: {
    systemId: string;
    systemName: string;
    testType: string;
    testStandard: string;
    result: 'PASS' | 'FAIL' | 'PASS_WITH_OBSERVATIONS';
    readings: Array<{ parameter: string; expected: string; actual: string; withinTolerance: boolean }>;
    witnessedBy: string;
    certificateHash: string;
  },
): { testId: string; outstandingObservations: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  // AC-CN-WF-12-03. Binds only where the project runs turnover at all.
  const blocked = commissioningBlockedReason(ctx, input.systemId);
  if (blocked) throw new DomainError('SYSTEM_NOT_RELEASED', blocked);

  const evidence = registerEvidence(ctx, {
    type: 'COMMISSIONING_CERTIFICATE',
    hash: input.certificateHash,
    description: `${input.testType} certificate for ${input.systemName} (${input.testStandard})`,
  });

  const outOfTolerance = input.readings.filter((r) => !r.withinTolerance);
  if (input.result === 'PASS' && outOfTolerance.length > 0) {
    throw new DomainError(
      'COMMISSIONING_RESULT_INCONSISTENT',
      `Cannot record a PASS while ${outOfTolerance.length} reading(s) are outside tolerance`,
    );
  }

  const testId = ulid();
  write(ctx, {
    eventType: 'COMMISSIONING_TEST_RECORDED',
    entity: { refType: 'CommissioningTest', refId: testId },
    nextState: {
      id: testId,
      projectId: ctx.projectId,
      systemId: input.systemId,
      systemName: input.systemName,
      testType: input.testType,
      testStandard: input.testStandard,
      result: input.result,
      readings: input.readings,
      outOfToleranceCount: outOfTolerance.length,
      witnessedBy: input.witnessedBy,
      testedAt: new Date().toISOString(),
      status: input.result === 'PASS' ? 'PASSED' : 'OPEN',
    },
    evidenceRefs: [evidence],
  });

  return { testId, outstandingObservations: outOfTolerance.length };
}

export function acceptSystem(ctx: EngineContext, testId: string, acceptedBy: string, acceptanceHash: string): void {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const test = ctx.ledger.require({ refType: 'CommissioningTest', refId: testId });
  if (test.state.result === 'FAIL') {
    throw new DomainError('SYSTEM_NOT_ACCEPTABLE', 'A failed commissioning test cannot be accepted; retest is required');
  }

  const evidence = registerEvidence(ctx, {
    type: 'SYSTEM_ACCEPTANCE',
    hash: acceptanceHash,
    description: `System ${String(test.state.systemName)} accepted by ${acceptedBy}`,
    linkedEntities: [{ refType: 'CommissioningTest', refId: testId }],
  });

  write(ctx, {
    eventType: 'SYSTEM_ACCEPTED',
    entity: { refType: 'CommissioningTest', refId: testId },
    nextState: { ...test.state, status: 'ACCEPTED', acceptedBy, acceptedAt: new Date().toISOString() },
    evidenceRefs: [evidence],
  });
}

// --- Handover ----------------------------------------------------------------

/**
 * Compile the handover pack. Completeness is scored against what an operator
 * actually needs on day one, not against a document count.
 */
export async function compileHandoverPack(
  ctx: EngineContext,
  input: { receivingPartyId: string; receivingPartyName: string },
): Promise<{ packId: string; completeness: number; gaps: string[]; acuConsumed: number }> {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  const commissioningTests = ctx.ledger.list(ctx.projectId, 'CommissioningTest');
  const asBuilts = ctx.ledger.list(ctx.projectId, 'Model').filter((m) => m.state.status === 'AS_BUILT');
  const warranties = ctx.ledger.list(ctx.projectId, 'Warranty');
  const openDefects = ctx.ledger.list(ctx.projectId, 'Defect').filter((d) => d.state.status !== 'CLOSED');
  const openSnags = ctx.ledger.list(ctx.projectId, 'Snag').filter((s) => s.state.status !== 'CLOSED');
  const drawings = ctx.ledger.list(ctx.projectId, 'Drawing').filter((d) => d.state.status === 'CURRENT');
  const ramsRecords = ctx.ledger.list(ctx.projectId, 'RAMS');

  const checklist = [
    { key: 'as_built', present: asBuilts.length > 0, label: 'As-built model or drawings' },
    { key: 'commissioning', present: commissioningTests.some((t) => t.state.status === 'ACCEPTED'), label: 'Accepted commissioning results' },
    { key: 'warranties', present: warranties.length > 0, label: 'Warranties and guarantees' },
    { key: 'drawings', present: drawings.length > 0, label: 'Current drawing register' },
    { key: 'defects_clear', present: openDefects.length === 0, label: 'Defects closed out' },
    { key: 'snags_clear', present: openSnags.length === 0, label: 'Snags closed out' },
    { key: 'safety_file', present: ramsRecords.length > 0, label: 'Health and safety file content' },
  ];

  const gaps = checklist.filter((c) => !c.present).map((c) => c.label);
  const completeness = Number((checklist.filter((c) => c.present).length / checklist.length).toFixed(3));

  const packId = ulid();
  const contents = {
    asBuiltModelIds: asBuilts.map((m) => m.refId),
    commissioningTestIds: commissioningTests.map((t) => t.refId),
    warrantyIds: warranties.map((w) => w.refId),
    drawingIds: drawings.map((d) => d.refId),
    openDefectIds: openDefects.map((d) => d.refId),
    openSnagIds: openSnags.map((s) => s.refId),
  };

  const evidence = registerEvidence(ctx, {
    type: 'HANDOVER_PACK_MANIFEST',
    hash: hashEvidence(JSON.stringify(contents)),
    description: `Handover pack manifest for ${input.receivingPartyName}`,
  });

  const result = await runAI(ctx, {
    engine: 'HANDOVER_OM',
    taskType: 'handover_readiness',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Project', refId: ctx.projectId }],
    request: {
      task: 'Assess handover readiness and set out what the receiving party should require before acceptance',
      payload: { checklist, gaps, openDefects: openDefects.length, openSnags: openSnags.length },
    },
    toWrites: (output) => [
      {
        eventType: 'HANDOVER_PACK_COMPILED',
        entity: { refType: 'HandoverPack', refId: packId },
        nextState: {
          id: packId,
          projectId: ctx.projectId,
          receivingPartyId: input.receivingPartyId,
          receivingPartyName: input.receivingPartyName,
          contents,
          checklist,
          completeness,
          gaps,
          readinessNarrative: String(output.narrative ?? ''),
          // An incomplete pack can still be compiled: the operator needs to see
          // exactly what is missing, not be blocked from seeing anything.
          status: gaps.length === 0 ? 'READY' : 'INCOMPLETE',
          compiledAt: new Date().toISOString(),
        },
        evidenceRefs: [evidence],
      },
    ],
  });

  return { packId, completeness, gaps, acuConsumed: result.acuConsumed };
}

export function acceptHandover(
  ctx: EngineContext,
  input: { packId: string; acceptedBy: string; qualifications: string[]; acceptanceHash: string },
): void {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const pack = ctx.ledger.require({ refType: 'HandoverPack', refId: input.packId });

  // H-WF-09 step 1. The eight-domain validation, which binds only where the
  // project runs those workflows: a project with no requirements matrix, no
  // completion inspection and no asset register reports nothing and this
  // passes, exactly as it did before the check existed.
  const blocked = handoverAcceptanceBlockedReason(ctx);
  if (blocked) throw new DomainError('HANDOVER_NOT_READY', blocked);

  const evidence = registerEvidence(ctx, {
    type: 'HANDOVER_ACCEPTANCE',
    hash: input.acceptanceHash,
    description: `Handover accepted by ${input.acceptedBy}${
      input.qualifications.length > 0 ? ` with ${input.qualifications.length} qualification(s)` : ' without qualification'
    }`,
    linkedEntities: [{ refType: 'HandoverPack', refId: input.packId }],
  });

  write(ctx, {
    eventType: 'HANDOVER_ACCEPTED',
    entity: { refType: 'HandoverPack', refId: input.packId },
    nextState: {
      ...pack.state,
      status: 'ACCEPTED',
      acceptedBy: input.acceptedBy,
      acceptanceQualifications: input.qualifications,
      acceptedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });
}

// --- Asset register & operations ---------------------------------------------

export function registerAsset(
  ctx: EngineContext,
  input: {
    assetTag: string;
    description: string;
    assetClass: string;
    manufacturer: string;
    modelNumber: string;
    serialNumber?: string;
    installedAt: string;
    location: string;
    expectedLifeYears: number;
    replacementCostMinor: number;
    parentAssetId?: string;
    linkedModelElementId?: string;
  },
): { assetId: string } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  // An asset is registered because it is in the ground. A future installation
  // date pushes the replacement date below out with it, and the whole thirty
  // year lifecycle plan is built off that one number.
  assertNotFuture(input.installedAt, 'installedAt');

  // The tag is the identity the maintenance system, the O&M manual, the drawing
  // link and the warranty all hang off. Registering it twice silently merges two
  // machines, and the merge is discovered years later by whoever goes looking
  // for the one that is not there. H-WF-04's exception control, applied at the
  // point the duplicate would be created rather than found afterwards.
  if (ctx.ledger.list(ctx.projectId, 'AssetRegisterItem').some((r) => r.state.assetTag === input.assetTag)) {
    throw new DomainError(
      'ASSET_TAG_TAKEN',
      `${input.assetTag} is already on the asset register. Two assets carrying one tag is not a data-quality nuisance: ` +
        'everything downstream resolves the tag to a single machine.',
    );
  }

  const assetId = ulid();
  write(ctx, {
    eventType: 'ASSET_REGISTERED',
    entity: { refType: 'AssetRegisterItem', refId: assetId },
    nextState: {
      id: assetId,
      projectId: ctx.projectId,
      ...input,
      // The end-of-life date is what drives lifecycle replacement planning.
      expectedReplacementDate: new Date(
        Date.parse(input.installedAt) + input.expectedLifeYears * 365.25 * 86_400_000,
      )
        .toISOString()
        .slice(0, 10),
      status: 'IN_SERVICE',
      registeredAt: new Date().toISOString(),
    },
  });

  return { assetId };
}

export async function publishOMManual(
  ctx: EngineContext,
  input: { assetIds: string[]; sourceDocumentHashes: string[]; systemName: string },
): Promise<{ manualId: string; acuConsumed: number }> {
  authorise(ctx, 'HANDOVER_OM', 'X', { lifecyclePhase: currentPhase(ctx) });

  const assets = input.assetIds.map((id) => ctx.ledger.require({ refType: 'AssetRegisterItem', refId: id }));

  const evidenceRefs = input.sourceDocumentHashes.map((hash, index) =>
    registerEvidence(ctx, {
      type: 'OM_SOURCE_DOCUMENT',
      hash,
      description: `O&M source document ${index + 1} for ${input.systemName}`,
    }),
  );

  const manualId = ulid();

  const result = await runAI(ctx, {
    engine: 'HANDOVER_OM',
    taskType: 'om_manual_generation',
    capability: 'PERCEPTION',
    inputRefs: evidenceRefs,
    request: {
      task: 'Extract maintenance tasks, intervals, spares and safety requirements from the manufacturer documentation',
      payload: {
        systemName: input.systemName,
        assets: assets.map((a) => ({
          assetTag: a.state.assetTag,
          manufacturer: a.state.manufacturer,
          modelNumber: a.state.modelNumber,
          assetClass: a.state.assetClass,
        })),
      },
    },
    toWrites: (output, confidence) => [
      {
        eventType: 'OM_MANUAL_PUBLISHED',
        entity: { refType: 'OMManual', refId: manualId },
        nextState: {
          id: manualId,
          projectId: ctx.projectId,
          systemName: input.systemName,
          assetIds: input.assetIds,
          extractionConfidence: confidence ?? 0.7,
          maintenanceNarrative: String(output.narrative ?? ''),
          sourceDocumentCount: input.sourceDocumentHashes.length,
          publishedAt: new Date().toISOString(),
        },
        evidenceRefs,
      },
    ],
  });

  return { manualId, acuConsumed: result.acuConsumed };
}

export function registerWarranty(
  ctx: EngineContext,
  input: {
    assetId: string;
    provider: string;
    startDate: string;
    durationMonths: number;
    coverage: string;
    documentHash: string;
  },
): { warrantyId: string; expiryDate: string } {
  authorise(ctx, 'HANDOVER_OM', 'C');

  const expiry = new Date(Date.parse(input.startDate));
  expiry.setUTCMonth(expiry.getUTCMonth() + input.durationMonths);
  const expiryDate = expiry.toISOString().slice(0, 10);

  const evidence = registerEvidence(ctx, {
    type: 'WARRANTY_DOCUMENT',
    hash: input.documentHash,
    description: `Warranty from ${input.provider}, expires ${expiryDate}`,
  });

  const warrantyId = ulid();
  write(ctx, {
    eventType: 'WARRANTY_REGISTERED',
    entity: { refType: 'Warranty', refId: warrantyId },
    nextState: {
      id: warrantyId,
      projectId: ctx.projectId,
      assetId: input.assetId,
      provider: input.provider,
      startDate: input.startDate,
      durationMonths: input.durationMonths,
      expiryDate,
      coverage: input.coverage,
      status: 'ACTIVE',
    },
    evidenceRefs: [evidence],
  });

  return { warrantyId, expiryDate };
}

/**
 * Raise a defect. Checks warranty cover at the point of raising, because who
 * pays is the first question and the answer is already in the data.
 */
export function raiseDefect(
  ctx: EngineContext,
  input: {
    assetId?: string;
    location: string;
    description: string;
    severity: 'MINOR' | 'MAJOR' | 'CRITICAL';
    reportedBy: string;
    evidenceHash: string;
  },
): { defectId: string; reference: string; warrantyCovered: boolean; warrantyId?: string } {
  authorise(ctx, 'HANDOVER_OM', 'C');

  const today = new Date().toISOString().slice(0, 10);
  const warranty = input.assetId
    ? ctx.ledger
        .list(ctx.projectId, 'Warranty')
        .find((w) => w.state.assetId === input.assetId && w.state.status === 'ACTIVE' && String(w.state.expiryDate) >= today)
    : undefined;

  const evidence = registerEvidence(ctx, {
    type: 'DEFECT_EVIDENCE',
    hash: input.evidenceHash,
    description: `Defect evidence: ${input.description.slice(0, 80)}`,
  });

  const sequence = ctx.ledger.list(ctx.projectId, 'Defect').length + 1;
  const reference = formatRef('DEF', sequence);
  const defectId = ulid();

  write(ctx, {
    eventType: 'DEFECT_RAISED',
    entity: { refType: 'Defect', refId: defectId },
    nextState: {
      id: defectId,
      projectId: ctx.projectId,
      reference,
      assetId: input.assetId,
      location: input.location,
      description: input.description,
      severity: input.severity,
      reportedBy: input.reportedBy,
      reportedAt: new Date().toISOString(),
      warrantyCovered: warranty !== undefined,
      warrantyId: warranty?.refId,
      warrantyProvider: warranty?.state.provider,
      status: 'OPEN',
      // Critical defects get a same-day response; the rest follow the standard cycle.
      targetCloseDate: new Date(Date.now() + (input.severity === 'CRITICAL' ? 1 : 28) * 86_400_000)
        .toISOString()
        .slice(0, 10),
    },
    evidenceRefs: [evidence],
  });

  return { defectId, reference, warrantyCovered: warranty !== undefined, warrantyId: warranty?.refId };
}

export function raiseWorkOrder(
  ctx: EngineContext,
  input: {
    assetId: string;
    type: 'PLANNED' | 'REACTIVE' | 'CORRECTIVE' | 'STATUTORY';
    description: string;
    priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'EMERGENCY';
    dueDate: string;
    linkedDefectId?: string;
    estimatedCostMinor?: number;
  },
): { workOrderId: string; reference: string } {
  authorise(ctx, 'HANDOVER_OM', 'C');

  const sequence = ctx.ledger.list(ctx.projectId, 'WorkOrder').length + 1;
  const reference = formatRef('WO', sequence, 5);
  const workOrderId = ulid();

  write(ctx, {
    eventType: 'WORK_ORDER_RAISED',
    entity: { refType: 'WorkOrder', refId: workOrderId },
    nextState: {
      id: workOrderId,
      projectId: ctx.projectId,
      reference,
      ...input,
      status: 'OPEN',
      raisedAt: new Date().toISOString(),
      raisedBy: ctx.auth.actorId,
    },
  });

  return { workOrderId, reference };
}

export function closeWorkOrder(
  ctx: EngineContext,
  input: { workOrderId: string; actualCostMinor: number; completionNotes: string; completionEvidenceHash: string },
): void {
  authorise(ctx, 'HANDOVER_OM', 'A');

  const workOrder = ctx.ledger.require({ refType: 'WorkOrder', refId: input.workOrderId });

  const evidence = registerEvidence(ctx, {
    type: 'WORK_ORDER_COMPLETION',
    hash: input.completionEvidenceHash,
    description: `Completion evidence for ${String(workOrder.state.reference)}`,
    linkedEntities: [{ refType: 'WorkOrder', refId: input.workOrderId }],
  });

  write(ctx, {
    eventType: 'WORK_ORDER_CLOSED',
    entity: { refType: 'WorkOrder', refId: input.workOrderId },
    nextState: {
      ...workOrder.state,
      status: 'CLOSED',
      actualCostMinor: input.actualCostMinor,
      completionNotes: input.completionNotes,
      closedAt: new Date().toISOString(),
      closedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });
}

/**
 * Predictive maintenance forecast. Combines asset age against expected life
 * with observed failure history, so an asset that keeps failing is prioritised
 * ahead of one that is merely old.
 */
export async function forecastMaintenance(
  ctx: EngineContext,
  input: { horizonMonths: number; annualBudgetMinor: number },
): Promise<{
  forecastId: string;
  schedule: Array<{ assetId: string; assetTag: string; action: string; dueDate: string; estimatedCostMinor: number; priority: string }>;
  totalForecastMinor: number;
  budgetPressure: number;
  acuConsumed: number;
}> {
  authorise(ctx, 'HANDOVER_OM', 'X');

  const assets = ctx.ledger.list(ctx.projectId, 'AssetRegisterItem').filter((a) => a.state.status === 'IN_SERVICE');
  const defects = ctx.ledger.list(ctx.projectId, 'Defect');
  const workOrders = ctx.ledger.list(ctx.projectId, 'WorkOrder');
  const horizonEnd = new Date(Date.now() + input.horizonMonths * 30.44 * 86_400_000);

  const schedule = assets.flatMap((asset) => {
    const installedAt = Date.parse(String(asset.state.installedAt));
    const expectedLifeMs = Number(asset.state.expectedLifeYears) * 365.25 * 86_400_000;
    const ageRatio = (Date.now() - installedAt) / expectedLifeMs;

    const failures = defects.filter((d) => d.state.assetId === asset.refId).length;
    const reactiveOrders = workOrders.filter((w) => w.state.assetId === asset.refId && w.state.type === 'REACTIVE').length;

    // Failure history pulls the effective end of life forward: an asset with a
    // record of problems will not reach its nominal life.
    const reliabilityPenalty = Math.min(0.4, (failures + reactiveOrders) * 0.08);
    const effectiveAgeRatio = ageRatio + reliabilityPenalty;

    const entries: Array<{ assetId: string; assetTag: string; action: string; dueDate: string; estimatedCostMinor: number; priority: string }> = [];

    if (effectiveAgeRatio >= 0.85) {
      const replacementDate = new Date(installedAt + expectedLifeMs * (1 - reliabilityPenalty));
      if (replacementDate <= horizonEnd) {
        entries.push({
          assetId: asset.refId,
          assetTag: String(asset.state.assetTag),
          action: `Replace ${String(asset.state.description)}`,
          dueDate: replacementDate.toISOString().slice(0, 10),
          estimatedCostMinor: Number(asset.state.replacementCostMinor),
          priority: effectiveAgeRatio >= 1 ? 'HIGH' : 'MEDIUM',
        });
      }
    } else if (effectiveAgeRatio >= 0.5) {
      entries.push({
        assetId: asset.refId,
        assetTag: String(asset.state.assetTag),
        action: `Major service and condition survey — ${String(asset.state.description)}`,
        dueDate: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10),
        // Mid-life intervention is typically a small fraction of replacement.
        estimatedCostMinor: Math.round(Number(asset.state.replacementCostMinor) * 0.12),
        priority: failures > 1 ? 'HIGH' : 'MEDIUM',
      });
    }

    return entries;
  });

  const totalForecast = schedule.reduce((s, e) => s + e.estimatedCostMinor, 0);
  const budgetPressure =
    input.annualBudgetMinor === 0
      ? 0
      : Number((totalForecast / (input.annualBudgetMinor * (input.horizonMonths / 12))).toFixed(3));

  const forecastId = ulid();

  const result = await runAI(ctx, {
    engine: 'HANDOVER_OM',
    taskType: 'maintenance_forecast',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Project', refId: ctx.projectId }],
    request: {
      task: 'Prioritise the maintenance schedule against the available budget and identify deferrals',
      payload: { schedule: schedule.slice(0, 50), totalForecast, annualBudgetMinor: input.annualBudgetMinor, budgetPressure },
    },
    toWrites: (output) => [
      {
        eventType: 'MAINTENANCE_FORECAST_PRODUCED',
        entity: { refType: 'MaintenanceForecast', refId: forecastId },
        nextState: {
          id: forecastId,
          projectId: ctx.projectId,
          horizonMonths: input.horizonMonths,
          schedule,
          totalForecastMinor: totalForecast,
          annualBudgetMinor: input.annualBudgetMinor,
          budgetPressure,
          assetsAssessed: assets.length,
          prioritisationNarrative: String(output.narrative ?? ''),
          producedAt: new Date().toISOString(),
        },
      },
    ],
  });

  return { forecastId, schedule, totalForecastMinor: totalForecast, budgetPressure, acuConsumed: result.acuConsumed };
}

/** Snag with trade dispatch by cost code — the routing that gets it actually fixed. */
/**
 * What it costs to run the asset.
 *
 * The one genuinely absent panel on the FM centre: nothing captured energy or
 * reactive-maintenance spend, so "what is costing money" had no record to read.
 * Everything else in that centre was derivable from records that existed; this
 * was not, and deriving it would have meant inventing it.
 *
 * Recorded per period against the whole facility or one asset. Per asset where
 * it can be attributed, because "the building used £40,000 of electricity" is a
 * bill and "chiller 2 used £9,000 of it" is a decision about whether to replace
 * it — and lifecycle replacement is the question this register exists to answer.
 */
export type OperatingCostCategory = 'ENERGY' | 'WATER' | 'REACTIVE_MAINTENANCE' | 'PLANNED_MAINTENANCE' | 'CONSUMABLES' | 'STATUTORY_INSPECTION' | 'CLEANING' | 'SECURITY';

export function recordOperatingCost(
  ctx: EngineContext,
  input: {
    period: string;
    category: OperatingCostCategory;
    amountMinor: number;
    /** Attributed to one asset where it can be. Absent means the whole facility. */
    assetId?: string;
    /** Consumption in the category's own unit — kWh, m³. Money alone hides a tariff rise. */
    quantity?: number;
    unit?: string;
    narrative: string;
    evidenceHash: string;
  },
): { costId: string } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (input.assetId) ctx.ledger.require({ refType: 'AssetRegisterItem', refId: input.assetId });
  if (input.amountMinor < 0) {
    throw new DomainError('OPERATING_COST_NEGATIVE', 'A negative operating cost is a credit note, and belongs on the invoice it corrects');
  }

  const evidence = registerEvidence(ctx, {
    type: 'OPERATING_COST_EVIDENCE',
    hash: input.evidenceHash,
    description: `${input.category} for ${input.period}: ${input.narrative.slice(0, 60)}`,
    linkedEntities: input.assetId ? [{ refType: 'AssetRegisterItem', refId: input.assetId }] : [],
  });

  const costId = ulid();
  write(ctx, {
    eventType: 'OPERATING_COST_RECORDED',
    entity: { refType: 'OperatingCost', refId: costId },
    nextState: {
      id: costId,
      projectId: ctx.projectId,
      ...input,
      recordedBy: ctx.auth.actorId,
      recordedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  return { costId };
}

/**
 * The operating position: what is happening, what is at risk, what it costs.
 *
 * Four of the FM centre's nine panels were partial for one reason — the asset
 * register was listable and nothing aggregated it. A list of assets is not an
 * operating position any more than a list of events is an audit.
 *
 * Two judgements are worth stating because they decide what the numbers mean.
 *
 * **Reactive against planned is the headline, not total spend.** A facility
 * spending more in total but less of it reactively is being run better, and a
 * total alone cannot tell those apart. Where the split cannot be computed — no
 * cost recorded at all — the ratio is null rather than zero, because zero
 * reactive spend and no records are opposite facts.
 *
 * **An asset past its expected life is reported as due rather than failed.**
 * Plenty of plant runs long past its design life; what the register can honestly
 * say is that its replacement is no longer a surprise, and what that would cost.
 */
export type OperatingPosition = {
  assets: { total: number; byClass: Array<{ assetClass: string; count: number; replacementCostMinor: number }> };
  /** Replacement value of everything at or past its expected life. */
  lifeExpired: { count: number; replacementCostMinor: number; assets: Array<{ assetTag: string; description: string; installedAt: string; expectedLifeYears: number; replacementCostMinor: number }> };
  warranties: { active: number; expiringWithin90Days: number; expired: number };
  workOrders: { open: number; overdue: number; byPriority: Array<{ priority: string; open: number; overdue: number }> };
  defects: { open: number; underWarranty: number; notCovered: number };
  cost: {
    recorded: boolean;
    totalMinor: number;
    byCategory: Array<{ category: string; amountMinor: number }>;
    reactiveMinor: number;
    plannedMinor: number;
    /** Reactive as a share of maintenance spend. Null where nothing is recorded. */
    reactiveShare: number | null;
  };
  summary: string;
  /** What is absent from the answer, where anything is. */
  notRecorded?: string;
};

export function operatingPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): OperatingPosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const assets = ctx.ledger.list(ctx.projectId, 'AssetRegisterItem').map((record) => record.state);
  const byClass = new Map<string, { count: number; replacementCostMinor: number }>();
  const lifeExpired: OperatingPosition['lifeExpired']['assets'] = [];

  for (const asset of assets) {
    const assetClass = String(asset.assetClass ?? 'Unclassified');
    const entry = byClass.get(assetClass) ?? { count: 0, replacementCostMinor: 0 };
    entry.count += 1;
    entry.replacementCostMinor += Number(asset.replacementCostMinor ?? 0);
    byClass.set(assetClass, entry);

    const installed = String(asset.installedAt ?? '').slice(0, 10);
    const life = Number(asset.expectedLifeYears ?? 0);
    if (installed !== '' && life > 0) {
      const due = new Date(Date.parse(installed));
      due.setUTCFullYear(due.getUTCFullYear() + life);
      if (due.toISOString().slice(0, 10) <= today) {
        lifeExpired.push({
          assetTag: String(asset.assetTag),
          description: String(asset.description),
          installedAt: installed,
          expectedLifeYears: life,
          replacementCostMinor: Number(asset.replacementCostMinor ?? 0),
        });
      }
    }
  }

  const inNinetyDays = new Date(Date.parse(today) + 90 * 86_400_000).toISOString().slice(0, 10);
  const warrantyRecords = ctx.ledger.list(ctx.projectId, 'Warranty').map((record) => record.state);
  const warranties = {
    active: warrantyRecords.filter((w) => String(w.expiryDate) > today).length,
    expiringWithin90Days: warrantyRecords.filter((w) => String(w.expiryDate) > today && String(w.expiryDate) <= inNinetyDays).length,
    expired: warrantyRecords.filter((w) => String(w.expiryDate) <= today).length,
  };

  const orders = ctx.ledger.list(ctx.projectId, 'WorkOrder').map((record) => record.state);
  const open = orders.filter((o) => o.status !== 'CLOSED');
  const priorities = ['EMERGENCY', 'HIGH', 'MEDIUM', 'LOW'];
  const workOrders = {
    open: open.length,
    overdue: open.filter((o) => String(o.dueDate ?? '') !== '' && String(o.dueDate) < today).length,
    byPriority: priorities.map((priority) => ({
      priority,
      open: open.filter((o) => o.priority === priority).length,
      overdue: open.filter((o) => o.priority === priority && String(o.dueDate ?? '') !== '' && String(o.dueDate) < today).length,
    })),
  };

  const defectRecords = ctx.ledger.list(ctx.projectId, 'Defect').map((record) => record.state);
  const openDefects = defectRecords.filter((d) => d.status !== 'CLOSED');
  const defects = {
    open: openDefects.length,
    underWarranty: openDefects.filter((d) => d.warrantyCovered === true).length,
    notCovered: openDefects.filter((d) => d.warrantyCovered !== true).length,
  };

  const costs = ctx.ledger.list(ctx.projectId, 'OperatingCost').map((record) => record.state);
  const byCategory = new Map<string, number>();
  for (const cost of costs) {
    const category = String(cost.category);
    byCategory.set(category, (byCategory.get(category) ?? 0) + Number(cost.amountMinor ?? 0));
  }
  const reactiveMinor = byCategory.get('REACTIVE_MAINTENANCE') ?? 0;
  const plannedMinor = byCategory.get('PLANNED_MAINTENANCE') ?? 0;
  const maintenanceMinor = reactiveMinor + plannedMinor;

  const cost = {
    recorded: costs.length > 0,
    totalMinor: [...byCategory.values()].reduce((sum, amount) => sum + amount, 0),
    byCategory: [...byCategory.entries()]
      .map(([category, amountMinor]) => ({ category, amountMinor }))
      .sort((a, b) => b.amountMinor - a.amountMinor),
    reactiveMinor,
    plannedMinor,
    // Null rather than zero. No records and no reactive spend are opposite facts.
    reactiveShare: maintenanceMinor > 0 ? Number((reactiveMinor / maintenanceMinor).toFixed(3)) : null,
  };

  return {
    assets: {
      total: assets.length,
      byClass: [...byClass.entries()]
        .map(([assetClass, entry]) => ({ assetClass, ...entry }))
        .sort((a, b) => b.replacementCostMinor - a.replacementCostMinor),
    },
    lifeExpired: {
      count: lifeExpired.length,
      replacementCostMinor: lifeExpired.reduce((sum, a) => sum + a.replacementCostMinor, 0),
      assets: lifeExpired.sort((a, b) => b.replacementCostMinor - a.replacementCostMinor),
    },
    warranties,
    workOrders,
    defects,
    cost,
    summary:
      assets.length === 0
        ? 'No assets are registered, so there is nothing to operate yet.'
        : `${assets.length} assets, ${workOrders.open} open work order${workOrders.open === 1 ? '' : 's'} of which ${workOrders.overdue} ${
            workOrders.overdue === 1 ? 'is' : 'are'
          } overdue. ${
            defects.notCovered > 0
              ? `${defects.notCovered} open defect${defects.notCovered === 1 ? '' : 's'} ${defects.notCovered === 1 ? 'is' : 'are'} outside warranty and will be paid for here.`
              : 'Every open defect is under warranty.'
          }`,
    ...(cost.recorded
      ? {}
      : {
          notRecorded:
            'No operating cost has been recorded, so what the asset costs to run is unknown rather than zero. ' +
            'Energy, water and maintenance spend are captured per period against the facility or one asset.',
        }),
  };
}

/**
 * What needs doing, in the order it needs doing.
 *
 * The FM centre had no maintenance queue at all, which meant "what needs action
 * today" had nothing behind it. This is not a new record — it is the work orders
 * and the defects already in the ledger, ordered by the only thing that decides
 * order on a live asset: whether it is a statutory obligation, then whether it is
 * an emergency, then how late it is.
 *
 * A statutory inspection outranks an emergency repair, which looks wrong for a
 * day and is right for a year: missing a statutory date is an offence, and the
 * emergency will still be an emergency an hour later.
 */
export type MaintenanceQueueItem = {
  kind: 'WORK_ORDER' | 'DEFECT';
  id: string;
  reference: string;
  description: string;
  assetTag?: string;
  priority: string;
  dueDate?: string;
  daysOverdue: number;
  statutory: boolean;
  /** Who pays: a defect under warranty is somebody else's cost. */
  warrantyCovered?: boolean;
};

export function maintenanceQueue(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): { items: MaintenanceQueueItem[]; overdue: number; statutoryOverdue: number; summary: string } {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const assetTags = new Map(
    ctx.ledger.list(ctx.projectId, 'AssetRegisterItem').map((record) => [record.refId, String(record.state.assetTag)]),
  );
  const lateBy = (due: unknown): number => {
    const date = String(due ?? '');
    if (date === '' || date >= today) return 0;
    return Math.max(0, Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000));
  };

  const items: MaintenanceQueueItem[] = [
    ...ctx.ledger
      .list(ctx.projectId, 'WorkOrder')
      .filter((record) => record.state.status !== 'CLOSED')
      .map((record) => ({
        kind: 'WORK_ORDER' as const,
        id: record.refId,
        reference: String(record.state.reference),
        description: String(record.state.description),
        assetTag: assetTags.get(String(record.state.assetId)),
        priority: String(record.state.priority),
        dueDate: String(record.state.dueDate ?? ''),
        daysOverdue: lateBy(record.state.dueDate),
        statutory: record.state.type === 'STATUTORY',
      })),
    ...ctx.ledger
      .list(ctx.projectId, 'Defect')
      .filter((record) => record.state.status !== 'CLOSED')
      .map((record) => ({
        kind: 'DEFECT' as const,
        id: record.refId,
        reference: String(record.state.reference),
        description: String(record.state.description),
        assetTag: assetTags.get(String(record.state.assetId)),
        priority: String(record.state.severity),
        daysOverdue: 0,
        statutory: false,
        warrantyCovered: record.state.warrantyCovered === true,
      })),
  ];

  const rank = (item: MaintenanceQueueItem): number => {
    if (item.statutory) return 0;
    return { EMERGENCY: 1, CRITICAL: 1, HIGH: 2, MAJOR: 2, MEDIUM: 3, MINOR: 4, LOW: 4 }[item.priority] ?? 3;
  };

  items.sort((a, b) => rank(a) - rank(b) || b.daysOverdue - a.daysOverdue);

  const overdue = items.filter((item) => item.daysOverdue > 0).length;
  const statutoryOverdue = items.filter((item) => item.statutory && item.daysOverdue > 0).length;

  return {
    items,
    overdue,
    statutoryOverdue,
    summary:
      items.length === 0
        ? 'Nothing is outstanding against the asset register.'
        : `${items.length} outstanding, ${overdue} overdue${
            statutoryOverdue > 0
              ? `. ${statutoryOverdue} of those ${statutoryOverdue === 1 ? 'is a statutory inspection' : 'are statutory inspections'}, which is an offence rather than a backlog.`
              : '. Nothing statutory is late.'
          }`,
  };
}

export function raiseSnag(
  ctx: EngineContext,
  input: {
    location: string;
    description: string;
    costCode: string;
    responsibleTrade: string;
    responsibleSubcontractId?: string;
    photoHash: string;
  },
): { snagId: string; reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  const evidence = registerEvidence(ctx, {
    type: 'SNAG_PHOTO',
    hash: input.photoHash,
    description: `Snag photo: ${input.description.slice(0, 80)}`,
  });

  const sequence = ctx.ledger.list(ctx.projectId, 'Snag').length + 1;
  const reference = formatRef('SNG', sequence, 5);
  const snagId = ulid();

  write(ctx, {
    eventType: 'SNAG_RAISED',
    entity: { refType: 'Snag', refId: snagId },
    nextState: {
      id: snagId,
      projectId: ctx.projectId,
      reference,
      ...input,
      status: 'OPEN',
      raisedAt: new Date().toISOString(),
      raisedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { snagId, reference };
}

/** Dispatch open snags to the trades responsible, grouped by cost code. */
export function dispatchSnags(
  ctx: EngineContext,
  costCode: string,
): { dispatched: number; trade: string | undefined; references: string[] } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const snags = ctx.ledger
    .list(ctx.projectId, 'Snag')
    .filter((s) => s.state.costCode === costCode && s.state.status === 'OPEN');

  const references: string[] = [];
  for (const snag of snags) {
    write(ctx, {
      eventType: 'SNAG_DISPATCHED',
      entity: { refType: 'Snag', refId: snag.refId },
      nextState: { ...snag.state, status: 'DISPATCHED', dispatchedAt: new Date().toISOString() },
    });
    references.push(String(snag.state.reference));
  }

  return {
    dispatched: snags.length,
    trade: snags[0] ? String(snags[0].state.responsibleTrade) : undefined,
    references,
  };
}
