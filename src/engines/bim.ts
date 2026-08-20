import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';

/**
 * Engine E — BIM & Digital Twin.
 *
 * Covers the whole information chain, not just the model: drawing control with
 * revision supersession, model ingestion, clash detection, and a live twin fed
 * by site reality. The 2D path matters as much as the 3D one — most projects
 * price and build from drawings long before a model is trustworthy.
 */

// --- Drawing control ---------------------------------------------------------

export type TitleBlock = {
  drawingNumber: string;
  title: string;
  revision: string;
  discipline: string;
  scale?: string;
  drawnBy?: string;
  checkedBy?: string;
  issueDate?: string;
  status?: string;
};

/**
 * Register a drawing and supersede any earlier revision automatically.
 * Someone building to a superseded drawing is a defect waiting to happen, so
 * supersession is a system rule rather than a filing convention.
 */
export async function registerDrawing(
  ctx: EngineContext,
  input: { fileHash: string; fileUri?: string; titleBlock?: TitleBlock; rawTitleBlockText?: string; packageIds?: string[] },
): Promise<{ drawingId: string; supersededId?: string; titleBlock: TitleBlock; acuConsumed: number }> {
  authorise(ctx, 'DESIGN_INFORMATION', 'I', { lifecyclePhase: currentPhase(ctx) });

  const evidence = registerEvidence(ctx, {
    type: 'DRAWING_FILE',
    hash: input.fileHash,
    uri: input.fileUri,
    description: input.titleBlock ? `Drawing ${input.titleBlock.drawingNumber} rev ${input.titleBlock.revision}` : 'Drawing file',
  });

  const drawingId = ulid();
  let titleBlock = input.titleBlock;
  let acuConsumed = 0;

  // Only spend ACUs when the title block actually needs to be read.
  if (!titleBlock) {
    if (!input.rawTitleBlockText) {
      throw new DomainError('TITLE_BLOCK_MISSING', 'Provide either a parsed title block or raw title block text');
    }

    const result = await runAI(ctx, {
      engine: 'BIM_TWIN',
      taskType: 'title_block_extraction',
      capability: 'PERCEPTION',
      inputRefs: [evidence],
      request: {
        task: 'Extract drawing number, title, revision, discipline and issue status from the title block',
        payload: { rawTitleBlockText: input.rawTitleBlockText },
        responseSchema: {
          type: 'object',
          properties: {
            drawingNumber: { type: 'string' },
            title: { type: 'string' },
            revision: { type: 'string' },
            discipline: { type: 'string' },
          },
        },
      },
      toWrites: () => [],
    });

    acuConsumed = result.acuConsumed;
    const output = result.output;
    titleBlock = {
      drawingNumber: String(output.drawingNumber ?? `UNPARSED-${drawingId.slice(-6)}`),
      title: String(output.title ?? 'Untitled'),
      revision: String(output.revision ?? 'P01'),
      discipline: String(output.discipline ?? 'GENERAL'),
    };
  }

  // Find the current revision of the same drawing number and supersede it.
  const previous = ctx.ledger
    .list(ctx.projectId, 'Drawing')
    .filter((d) => d.state.drawingNumber === titleBlock.drawingNumber && d.state.status === 'CURRENT')
    .sort((a, b) => String(a.state.revision).localeCompare(String(b.state.revision)));
  const superseded = previous[previous.length - 1];

  write(ctx, {
    eventType: 'DRAWING_REGISTERED',
    entity: { refType: 'Drawing', refId: drawingId },
    nextState: {
      id: drawingId,
      projectId: ctx.projectId,
      ...titleBlock,
      packageIds: input.packageIds ?? [],
      status: 'CURRENT',
      supersedesId: superseded?.refId,
      registeredAt: new Date().toISOString(),
      fileHash: input.fileHash,
    },
    evidenceRefs: [evidence],
  });

  if (superseded) {
    write(ctx, {
      eventType: 'DRAWING_SUPERSEDED',
      entity: { refType: 'Drawing', refId: superseded.refId },
      nextState: {
        ...superseded.state,
        status: 'SUPERSEDED',
        supersededBy: drawingId,
        supersededAt: new Date().toISOString(),
      },
      evidenceRefs: [evidence],
    });
  }

  return { drawingId, supersededId: superseded?.refId, titleBlock, acuConsumed };
}

/**
 * Markup on a drawing, convertible into an RFI or a site instruction. This is
 * the highest-frequency loop on a live job, so it is a first-class object with
 * its own trace rather than an annotation lost in a PDF.
 */
export function addMarkup(
  ctx: EngineContext,
  input: {
    drawingId: string;
    author: string;
    note: string;
    region?: { x: number; y: number; width: number; height: number };
    convertTo?: 'RFI' | 'INSTRUCTION' | 'NONE';
  },
): { markupId: string; derivedId?: string; derivedRef?: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const drawing = ctx.ledger.require({ refType: 'Drawing', refId: input.drawingId });
  if (drawing.state.status === 'SUPERSEDED') {
    throw new DomainError('DRAWING_SUPERSEDED', 'Cannot mark up a superseded drawing; use the current revision');
  }

  const markupId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'DRAWING_MARKUP',
    hash: hashEvidence(JSON.stringify({ drawingId: input.drawingId, note: input.note, region: input.region })),
    description: `Markup on ${String(drawing.state.drawingNumber)}: ${input.note.slice(0, 80)}`,
    linkedEntities: [{ refType: 'Drawing', refId: input.drawingId }],
  });

  write(ctx, {
    eventType: 'DRAWING_MARKUP_ADDED',
    entity: { refType: 'DrawingMarkup', refId: markupId },
    nextState: {
      id: markupId,
      drawingId: input.drawingId,
      drawingNumber: drawing.state.drawingNumber,
      drawingRevision: drawing.state.revision,
      author: input.author,
      note: input.note,
      region: input.region,
      createdAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  if (!input.convertTo || input.convertTo === 'NONE') return { markupId };

  const existingRfis = ctx.ledger.list(ctx.projectId, 'RFI').length;
  const derivedId = ulid();

  if (input.convertTo === 'RFI') {
    const reference = `RFI-${String(existingRfis + 1).padStart(4, '0')}`;
    write(ctx, {
      eventType: 'RFI_RAISED',
      entity: { refType: 'RFI', refId: derivedId },
      nextState: {
        id: derivedId,
        projectId: ctx.projectId,
        reference,
        question: input.note,
        discipline: drawing.state.discipline,
        raisedBy: input.author,
        raisedAt: new Date().toISOString(),
        // Answering the wrong revision is how RFI answers become disputes.
        linkedDrawingId: input.drawingId,
        linkedDrawingRevision: drawing.state.revision,
        linkedMarkupId: markupId,
        status: 'OPEN',
        dueDate: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      },
    });
    return { markupId, derivedId, derivedRef: reference };
  }

  const existingInstructions = ctx.ledger.list(ctx.projectId, 'Correspondence').length;
  const reference = `SI-${String(existingInstructions + 1).padStart(4, '0')}`;
  write(ctx, {
    eventType: 'CORRESPONDENCE_ISSUED',
    entity: { refType: 'Correspondence', refId: derivedId },
    nextState: {
      id: derivedId,
      projectId: ctx.projectId,
      reference,
      type: 'SITE_INSTRUCTION',
      body: input.note,
      issuedBy: input.author,
      issuedAt: new Date().toISOString(),
      linkedDrawingId: input.drawingId,
      linkedMarkupId: markupId,
      status: 'ISSUED',
    },
  });
  return { markupId, derivedId, derivedRef: reference };
}

// --- Model & twin ------------------------------------------------------------

export async function ingestModel(
  ctx: EngineContext,
  input: {
    fileHash: string;
    fileUri?: string;
    format: 'IFC' | 'RVT' | 'NWD' | 'DWG';
    discipline: string;
    lod: number;
    elementCount: number;
  },
): Promise<{ modelId: string; acuConsumed: number }> {
  authorise(ctx, 'BIM_TWIN', 'I', { lifecyclePhase: currentPhase(ctx) });

  const evidence = registerEvidence(ctx, {
    type: 'MODEL_FILE',
    hash: input.fileHash,
    uri: input.fileUri,
    description: `${input.format} model, ${input.discipline}, LOD ${input.lod}`,
  });

  const modelId = ulid();

  const result = await runAI(ctx, {
    engine: 'BIM_TWIN',
    taskType: 'model_ingestion',
    capability: 'PERCEPTION',
    inputRefs: [evidence],
    request: {
      task: 'Classify model content, assess information completeness against the LOD claimed',
      payload: { format: input.format, discipline: input.discipline, lod: input.lod, elementCount: input.elementCount },
    },
    toWrites: (output, confidence) => [
      {
        eventType: 'MODEL_INGESTED',
        entity: { refType: 'Model', refId: modelId },
        nextState: {
          id: modelId,
          projectId: ctx.projectId,
          format: input.format,
          discipline: input.discipline,
          lod: input.lod,
          elementCount: input.elementCount,
          fileHash: input.fileHash,
          informationCompleteness: confidence ?? 0.7,
          classification: String(output.classification ?? 'MEDIUM'),
          status: 'INGESTED',
          ingestedAt: new Date().toISOString(),
        },
        evidenceRefs: [evidence],
      },
    ],
  });

  return { modelId, acuConsumed: result.acuConsumed };
}

export type ClashInput = {
  modelAId: string;
  modelBId: string;
  clashes: Array<{
    elementA: string;
    elementB: string;
    disciplineA: string;
    disciplineB: string;
    /** Overlap volume in cubic metres — the objective severity driver. */
    overlapVolume: number;
    location: string;
  }>;
};

/**
 * Clash detection with cost-aware triage. Raw clash counts are noise; what
 * matters is which clashes are expensive to fix once built, and when they must
 * be resolved to avoid disrupting the programme.
 */
export async function detectClashes(
  ctx: EngineContext,
  input: ClashInput,
): Promise<{ clashIds: string[]; critical: number; acuConsumed: number }> {
  authorise(ctx, 'BIM_TWIN', 'X', { lifecyclePhase: currentPhase(ctx) });

  const clashIds: string[] = [];

  // Rework cost rises steeply once a discipline is installed. Structural and
  // below-ground clashes are the expensive ones, so they triage first.
  const disciplineWeight: Record<string, number> = {
    STRUCTURE: 1,
    SUBSTRUCTURE: 1,
    DRAINAGE: 0.9,
    MECHANICAL: 0.6,
    ELECTRICAL: 0.5,
    ARCHITECTURE: 0.4,
    FINISHES: 0.2,
  };

  const scored = input.clashes.map((clash) => {
    const weight = Math.max(
      disciplineWeight[clash.disciplineA.toUpperCase()] ?? 0.5,
      disciplineWeight[clash.disciplineB.toUpperCase()] ?? 0.5,
    );
    const severityScore = Math.min(1, weight * (0.4 + Math.min(1, clash.overlapVolume / 0.5) * 0.6));
    return {
      ...clash,
      severityScore: Number(severityScore.toFixed(3)),
      severity: severityScore >= 0.7 ? 'CRITICAL' : severityScore >= 0.45 ? 'HIGH' : severityScore >= 0.2 ? 'MEDIUM' : 'LOW',
    };
  });

  const result = await runAI(ctx, {
    engine: 'BIM_TWIN',
    taskType: 'clash_triage',
    capability: 'REASONING',
    inputRefs: [
      { refType: 'Model', refId: input.modelAId },
      { refType: 'Model', refId: input.modelBId },
    ],
    request: {
      task: 'Sequence clash resolution against construction order and identify the responsible discipline',
      payload: { clashes: scored.slice(0, 50), totalClashes: scored.length },
    },
    toWrites: () =>
      scored.map((clash) => {
        const clashId = ulid();
        clashIds.push(clashId);
        return {
          eventType: 'CLASH_DETECTED',
          entity: { refType: 'Clash', refId: clashId },
          nextState: {
            id: clashId,
            projectId: ctx.projectId,
            modelAId: input.modelAId,
            modelBId: input.modelBId,
            ...clash,
            status: 'OPEN',
            detectedAt: new Date().toISOString(),
          },
          evidenceRefs: [{ refType: 'Model', refId: input.modelAId }],
        };
      }),
  });

  return {
    clashIds,
    critical: scored.filter((c) => c.severity === 'CRITICAL').length,
    acuConsumed: result.acuConsumed,
  };
}

/**
 * Update the digital twin from site reality. The twin is only useful if it
 * diverges from the design model when the site does — a twin that always agrees
 * with the model is just the model.
 */
export async function updateTwinFromSite(
  ctx: EngineContext,
  input: {
    observationHash: string;
    observationUri?: string;
    source: 'DRONE' | 'CCTV' | 'MOBILE' | 'IOT' | 'LASER_SCAN';
    zone: string;
    linkedTaskIds: string[];
    observedElements: Array<{ elementId: string; expectedStatus: string; observedStatus: string }>;
  },
): Promise<{ twinStateId: string; deviations: number; acuConsumed: number }> {
  authorise(ctx, 'BIM_TWIN', 'U', { lifecyclePhase: currentPhase(ctx) });

  const evidence = registerEvidence(ctx, {
    type: 'SITE_REALITY_CAPTURE',
    hash: input.observationHash,
    uri: input.observationUri,
    description: `${input.source} capture of zone ${input.zone}`,
  });

  const deviations = input.observedElements.filter((e) => e.expectedStatus !== e.observedStatus);
  const twinStateId = ulid();

  const result = await runAI(ctx, {
    engine: 'BIM_TWIN',
    taskType: 'site_reality_comparison',
    capability: 'PERCEPTION',
    inputRefs: [evidence],
    request: {
      task: 'Compare observed site state against the model and quantify progress',
      payload: {
        zone: input.zone,
        source: input.source,
        observedElements: input.observedElements,
        deviationCount: deviations.length,
      },
    },
    toWrites: (output, confidence) => [
      {
        eventType: 'TWIN_STATE_UPDATED',
        entity: { refType: 'DigitalTwinState', refId: twinStateId },
        nextState: {
          id: twinStateId,
          projectId: ctx.projectId,
          zone: input.zone,
          source: input.source,
          observedElements: input.observedElements,
          deviations,
          deviationCount: deviations.length,
          linkedTaskIds: input.linkedTaskIds,
          observationConfidence: confidence ?? 0.7,
          narrative: String(output.narrative ?? ''),
          capturedAt: new Date().toISOString(),
        },
      },
    ],
  });

  return { twinStateId, deviations: deviations.length, acuConsumed: result.acuConsumed };
}

/** Ingest a sensor reading into the twin. High volume, so no AI call per reading. */
export function ingestSensorReading(
  ctx: EngineContext,
  input: { sensorId: string; assetId?: string; metric: string; value: number; unit: string; recordedAt: string },
): string {
  authorise(ctx, 'BIM_TWIN', 'I');

  const id = ulid();
  write(ctx, {
    eventType: 'SENSOR_READING_INGESTED',
    entity: { refType: 'SensorReading', refId: id },
    nextState: { id, projectId: ctx.projectId, ...input },
  });
  return id;
}

/** Generate the as-built record at completion, reconciling model against reality. */
export async function generateAsBuilt(
  ctx: EngineContext,
  input: { baseModelId: string },
): Promise<{ asBuiltId: string; reconciledDeviations: number; acuConsumed: number }> {
  authorise(ctx, 'BIM_TWIN', 'A', { lifecyclePhase: currentPhase(ctx) });

  const twinStates = ctx.ledger.list(ctx.projectId, 'DigitalTwinState');
  const allDeviations = twinStates.flatMap(
    (s) => (s.state.deviations as Array<Record<string, unknown>> | undefined) ?? [],
  );

  const baseModel = ctx.ledger.require({ refType: 'Model', refId: input.baseModelId });
  const asBuiltId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'AS_BUILT_RECONCILIATION',
    hash: hashEvidence(JSON.stringify(allDeviations)),
    description: `As-built reconciliation from ${twinStates.length} site captures`,
  });

  const result = await runAI(ctx, {
    engine: 'BIM_TWIN',
    taskType: 'as_built_generation',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Model', refId: input.baseModelId }],
    request: {
      task: 'Reconcile design intent against captured site reality and list the as-built departures',
      payload: { deviationCount: allDeviations.length, captures: twinStates.length },
    },
    toWrites: (output) => [
      {
        eventType: 'AS_BUILT_GENERATED',
        entity: { refType: 'Model', refId: asBuiltId },
        nextState: {
          id: asBuiltId,
          projectId: ctx.projectId,
          format: baseModel.state.format,
          discipline: baseModel.state.discipline,
          lod: 500,
          elementCount: baseModel.state.elementCount,
          fileHash: hashEvidence(`as-built:${input.baseModelId}:${allDeviations.length}`),
          derivedFromModelId: input.baseModelId,
          reconciledDeviations: allDeviations.length,
          captureCount: twinStates.length,
          narrative: String(output.narrative ?? ''),
          status: 'AS_BUILT',
          generatedAt: new Date().toISOString(),
        },
        evidenceRefs: [evidence],
      },
    ],
  });

  return { asBuiltId, reconciledDeviations: allDeviations.length, acuConsumed: result.acuConsumed };
}

/**
 * Answer an RFI.
 *
 * `RFI_ANSWERED` was in the catalogue with nothing able to emit it: a question
 * could be raised from a drawing markup and never closed. An RFI register that
 * only grows is the most common cause of a design-delay claim nobody can
 * evidence, because the register cannot show which questions went unanswered
 * or for how long.
 *
 * The answer records the drawing revision it was given against. A design team
 * answering against a revision the site no longer holds is how an RFI answer
 * turns into an argument, and it is invisible unless the revision is on the
 * record at both ends.
 */
export function answerRFI(
  ctx: EngineContext,
  input: {
    rfiId: string;
    answer: string;
    answeredBy: string;
    /** Set where the answer changes the design rather than explaining it. */
    changesDesign?: boolean;
    /** Where the answer supersedes a drawing, the revision it now points at. */
    supersedingDrawingId?: string;
    evidenceHash: string;
  },
  now = new Date(),
): { rfiId: string; reference: string; daysOpen: number; overdue: boolean; changeRequestSuggested: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const rfi = ctx.ledger.require({ refType: 'RFI', refId: input.rfiId });
  if (rfi.state.status === 'ANSWERED') {
    throw new DomainError('RFI_ALREADY_ANSWERED', `${String(rfi.state.reference)} has already been answered`);
  }

  if (input.answer.trim().length < 10) {
    throw new DomainError('RFI_ANSWER_INSUBSTANTIAL', 'An RFI answer must say something a site team can build to');
  }

  const raisedAt = String(rfi.state.raisedAt);
  const daysOpen = Math.max(0, Math.round((now.getTime() - Date.parse(raisedAt)) / 86_400_000));
  const dueDate = typeof rfi.state.dueDate === 'string' ? rfi.state.dueDate : undefined;
  const overdue = dueDate !== undefined && now.toISOString().slice(0, 10) > dueDate;

  const evidence = registerEvidence(ctx, {
    type: 'RFI_ANSWER',
    hash: input.evidenceHash,
    description: `Answer to ${String(rfi.state.reference)}`,
    linkedEntities: [{ refType: 'RFI', refId: input.rfiId }],
  });

  write(ctx, {
    eventType: 'RFI_ANSWERED',
    entity: { refType: 'RFI', refId: input.rfiId },
    nextState: {
      ...rfi.state,
      status: 'ANSWERED',
      answer: input.answer,
      answeredBy: input.answeredBy,
      answeredAt: now.toISOString(),
      // The revision the question was asked against, kept alongside the answer,
      // so a later dispute can see whether both ends were looking at the same
      // drawing.
      answeredAgainstRevision: rfi.state.linkedDrawingRevision,
      supersedingDrawingId: input.supersedingDrawingId,
      changesDesign: input.changesDesign === true,
      daysOpen,
      answeredLate: overdue,
    },
    evidenceRefs: [evidence],
  });

  // An answer that changes the design is a change event whether or not anybody
  // calls it one. Saying so is not the same as raising it — the platform does
  // not instruct a change on the design team's behalf — but a change that goes
  // unrecognised at this point is a change nobody gets paid for.
  return {
    rfiId: input.rfiId,
    reference: String(rfi.state.reference),
    daysOpen,
    overdue,
    changeRequestSuggested: input.changesDesign === true,
  };
}

/**
 * The RFI register as a delay exhibit rather than a list.
 *
 * What matters is not how many are open but how long they have been open and
 * whether the answers arrived after they were needed. That is the shape of a
 * design-information delay claim, and it is the shape the register has to be in
 * before anybody can argue it.
 */
export function rfiPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): {
  total: number;
  open: number;
  overdue: Array<{ reference: string; question: string; daysOpen: number; dueDate?: string }>;
  answeredLate: number;
  averageDaysToAnswer?: number;
  designChanges: number;
  summary: string;
} {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const rfis = ctx.ledger.list(ctx.projectId, 'RFI').map((record) => record.state);
  const open = rfis.filter((r) => r.status !== 'ANSWERED');

  const overdue = open
    .filter((r) => typeof r.dueDate === 'string' && today > String(r.dueDate))
    .map((r) => ({
      reference: String(r.reference),
      question: String(r.question ?? ''),
      daysOpen: Math.max(0, Math.round((Date.parse(today) - Date.parse(String(r.raisedAt))) / 86_400_000)),
      dueDate: String(r.dueDate),
    }))
    .sort((a, b) => b.daysOpen - a.daysOpen);

  const answered = rfis.filter((r) => r.status === 'ANSWERED');
  const answeredLate = answered.filter((r) => r.answeredLate === true).length;
  // Stated only where something has been answered. An average over nothing is
  // zero, and zero days to answer reads as excellent rather than as no data.
  const averageDaysToAnswer =
    answered.length === 0
      ? undefined
      : Number((answered.reduce((sum, r) => sum + Number(r.daysOpen ?? 0), 0) / answered.length).toFixed(1));

  const designChanges = answered.filter((r) => r.changesDesign === true).length;

  const summary =
    rfis.length === 0
      ? 'No RFIs raised.'
      : overdue.length === 0
        ? `${open.length} open, none overdue.`
        : `${overdue.length} overdue, the oldest ${overdue[0]!.daysOpen} days. Unanswered information is the most common ground for a design-delay claim.`;

  return { total: rfis.length, open: open.length, overdue, answeredLate, averageDaysToAnswer, designChanges, summary };
}
