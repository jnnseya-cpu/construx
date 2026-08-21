import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import { assertNotFuture } from '../domain/dates.ts';
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
