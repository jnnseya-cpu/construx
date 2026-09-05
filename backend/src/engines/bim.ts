import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import { findByHash } from '../evidence/registry.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { diffIfc, IfcParseError, parseIfc, type IfcDiff, type IfcSummary } from './ifc.ts';
import { networkFloat } from './planning.ts';
import {
  assessCoverage,
  extractClauses,
  type ExtractedClause,
  type SpecificationCoverage,
} from './maths/specification.ts';

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

    // Refused rather than filled in. This used to fall back to
    // `UNPARSED-<id> / Untitled / P01 / GENERAL`, which put a title block into
    // the drawing register that no drawing has ever carried — and against a
    // provider that cannot read a title block at all, that fabrication was the
    // *only* outcome. A drawing with an invented number is also a drawing
    // nothing can supersede, because supersession keys on the number.
    if (typeof output.drawingNumber !== 'string' || output.drawingNumber.trim() === '') {
      throw new DomainError(
        'TITLE_BLOCK_NOT_READ',
        'The title block could not be read. Supply a parsed title block rather than registering a drawing without one.',
        422,
      );
    }

    titleBlock = {
      drawingNumber: output.drawingNumber.trim(),
      title: typeof output.title === 'string' && output.title.trim() !== '' ? output.title.trim() : 'Untitled',
      revision: typeof output.revision === 'string' && output.revision.trim() !== '' ? output.revision.trim() : 'P01',
      discipline:
        typeof output.discipline === 'string' && output.discipline.trim() !== '' ? output.discipline.trim() : 'GENERAL',
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
    /**
     * The activity the answer is holding up.
     *
     * One field, and it is the difference between a delay exposure that is
     * conditional and one that is computed. An RFI carried a discipline and a
     * drawing, which says what the question is about and not what it is
     * stopping — so the exposure could only ever say "if the worst overdue RFI
     * happens to sit on the critical path". With the activity named, the
     * platform reads that activity's own float off the network and knows
     * whether it is on the critical chain.
     *
     * Optional, because a question can genuinely precede the programme and
     * refusing it would push people back to email. What it costs to leave out
     * is stated on the exposure rather than hidden.
     */
    taskId?: string;
  },
): { markupId: string; derivedId?: string; derivedRef?: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const drawing = ctx.ledger.require({ refType: 'Drawing', refId: input.drawingId });
  if (drawing.state.status === 'SUPERSEDED') {
    throw new DomainError('DRAWING_SUPERSEDED', 'Cannot mark up a superseded drawing; use the current revision');
  }

  // Checked when given. An activity reference that names nothing would put a
  // dead link into a record the exposure calculation then reads as fact.
  const blockedTask = input.taskId
    ? ctx.ledger.require({ refType: 'Task', refId: input.taskId })
    : undefined;

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
        // What the answer is holding up, where it is known.
        linkedTaskId: blockedTask?.refId,
        linkedTaskName: blockedTask ? String(blockedTask.state.name) : undefined,
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

/** What a read of the held file records on the model: the summary, without the per-element list. */
export type ModelReading = Omit<IfcSummary, 'elements'> & { readAt: string; readBy: string };

async function heldIfc(
  ctx: EngineContext,
  store: EvidenceStore,
  modelId: string,
): Promise<{ record: ReturnType<EngineContext['ledger']['require']>; parsed: IfcSummary }> {
  const record = ctx.ledger.get({ refType: 'Model', refId: modelId });
  if (!record || record.state.projectId !== ctx.projectId) {
    throw new DomainError('MODEL_NOT_FOUND', `No model ${modelId} on this project`, 404);
  }
  if (record.state.format !== 'IFC') {
    throw new DomainError(
      'MODEL_FORMAT_OPAQUE',
      `${String(record.state.format)} is a proprietary binary format; nothing here reads it. Export the model as IFC — every ` +
        'authoring tool can — and register that.',
      415,
    );
  }
  const hash = String(record.state.fileHash);
  if (!(await store.holds(ctx.tenantId, hash))) {
    throw new DomainError(
      'MODEL_FILE_NOT_HELD',
      'The platform holds the hash of this model and not the file. Supply the file behind the evidence hash first; the ' +
        'element count on the record is what was declared, not what was read.',
      409,
    );
  }
  const { bytes } = await store.fetch(ctx.tenantId, hash);
  try {
    return { record, parsed: parseIfc(bytes) };
  } catch (error) {
    if (error instanceof IfcParseError) throw new DomainError(error.code, error.message, 422);
    throw error;
  }
}

/**
 * Read the held IFC and put what it says on the model record.
 *
 * `ingestModel` records what the person said the model was: its format, its
 * discipline, the LOD claimed and an element count typed in. The file itself
 * cannot be read at that moment — the evidence record has to exist before the
 * store will take the bytes — so this is the second step, once the file is
 * held: parse it, and record the schema, the view definition, the authoring
 * application, the spatial structure, the length unit, the element count by
 * class, and a geometry hash per element so a later revision can be compared.
 *
 * Where the count read disagrees with the count declared, both are kept: the
 * declared figure is what the model was accepted on, and the read figure is
 * what it is. Deterministic — no model in the loop and nothing charged.
 */
export async function readModel(
  ctx: EngineContext,
  store: EvidenceStore,
  input: { modelId: string },
): Promise<{ modelId: string; reading: ModelReading; declaredElementCount?: number }> {
  authorise(ctx, 'BIM_TWIN', 'I', { lifecyclePhase: currentPhase(ctx) });
  const { record, parsed } = await heldIfc(ctx, store, input.modelId);
  const { elements: _elements, ...summary } = parsed;
  const reading: ModelReading = { ...summary, readAt: new Date().toISOString(), readBy: ctx.auth.actorId };
  const declared = Number(record.state.elementCount);
  const disagrees = Number.isFinite(declared) && declared !== parsed.elementCount;

  const evidence = findByHash(ctx.ledger, ctx.tenantId, String(record.state.fileHash));
  write(ctx, {
    eventType: 'MODEL_READ',
    entity: { refType: 'Model', refId: input.modelId },
    nextState: {
      ...record.state,
      elementCount: parsed.elementCount,
      ...(disagrees ? { declaredElementCount: declared } : {}),
      read: reading,
    },
    evidenceRefs: evidence ? [{ refType: 'EvidenceItem', refId: evidence.refId }] : [],
  });

  return { modelId: input.modelId, reading, ...(disagrees ? { declaredElementCount: declared } : {}) };
}

/**
 * What changed between two revisions of a model, element by element.
 *
 * Both files are parsed from the store when asked, rather than a per-element
 * index being kept on the ledger: a fifty-thousand-element model would put
 * megabytes of hashes into an append-only record on every read, and the
 * comparison is a question somebody asks occasionally of files the platform
 * already holds. `base` is the earlier revision; the diff reads as what the
 * later one did to it.
 */
export async function compareModels(
  ctx: EngineContext,
  store: EvidenceStore,
  input: { modelId: string; baseModelId: string },
): Promise<{
  base: { modelId: string; discipline: string; elementCount: number; geometryHash: string };
  model: { modelId: string; discipline: string; elementCount: number; geometryHash: string };
  diff: IfcDiff;
}> {
  authorise(ctx, 'BIM_TWIN', 'R', { lifecyclePhase: currentPhase(ctx) });
  if (input.modelId === input.baseModelId) {
    throw new DomainError('MODEL_SAME', 'A model compared with itself is unchanged by construction. Name the earlier revision.');
  }
  const [base, model] = await Promise.all([heldIfc(ctx, store, input.baseModelId), heldIfc(ctx, store, input.modelId)]);
  const brief = (entry: { record: { refId: string; state: Record<string, unknown> }; parsed: IfcSummary }) => ({
    modelId: entry.record.refId,
    discipline: String(entry.record.state.discipline ?? ''),
    elementCount: entry.parsed.elementCount,
    geometryHash: entry.parsed.geometryHash,
  });
  return { base: brief(base), model: brief(model), diff: diffIfc(base.parsed, model.parsed) };
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
 * How expensive each clash is to fix once it is built.
 *
 * Rework cost rises steeply once a discipline is installed, so structural and
 * below-ground clashes triage first. Extracted from `detectClashes` when
 * `domain/coordination.ts` needed the same answer: two severity scales over one
 * set of clashes would let the same overlap read CRITICAL on one screen and
 * MEDIUM on another, and nobody could say which was the platform's view.
 *
 * Pure, so it is the arithmetic and nothing else — no ledger, no authorisation,
 * no provider.
 */
export type ScoredClash<T extends { disciplineA: string; disciplineB: string; overlapVolume: number }> = T & {
  severityScore: number;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
};

const DISCIPLINE_WEIGHT: Record<string, number> = {
  STRUCTURE: 1,
  SUBSTRUCTURE: 1,
  DRAINAGE: 0.9,
  MECHANICAL: 0.6,
  ELECTRICAL: 0.5,
  ARCHITECTURE: 0.4,
  FINISHES: 0.2,
};

export function scoreClashes<T extends { disciplineA: string; disciplineB: string; overlapVolume: number }>(
  clashes: T[],
): Array<ScoredClash<T>> {
  return clashes.map((clash) => {
    const weight = Math.max(
      DISCIPLINE_WEIGHT[clash.disciplineA.toUpperCase()] ?? 0.5,
      DISCIPLINE_WEIGHT[clash.disciplineB.toUpperCase()] ?? 0.5,
    );
    const severityScore = Math.min(1, weight * (0.4 + Math.min(1, clash.overlapVolume / 0.5) * 0.6));
    return {
      ...clash,
      severityScore: Number(severityScore.toFixed(3)),
      severity: severityScore >= 0.7 ? 'CRITICAL' : severityScore >= 0.45 ? 'HIGH' : severityScore >= 0.2 ? 'MEDIUM' : 'LOW',
    };
  });
}

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
  const scored = scoreClashes(input.clashes);

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
 * How a clash stopped being a clash.
 *
 * The distinction between these is the whole point of recording it. A register
 * that says "resolved" and nothing else cannot tell design work from a
 * detection artefact, and the two mean opposite things about the model.
 */
export type ClashResolutionMethod =
  /** A discipline moved. The one that moved bears the cost, so it is named. */
  | 'MODEL_REVISED'
  /** Real geometry, acceptable overlap — insulation, tolerance, a permitted penetration. */
  | 'WITHIN_TOLERANCE'
  /** The detection run was wrong. No design work happened. */
  | 'NOT_A_CLASH'
  /** Built around on site. The model no longer describes what was built. */
  | 'RESOLVED_ON_SITE';

/**
 * Close a clash out.
 *
 * Detection without closeout gives a register that only ever grows, which is
 * worse than no register: a number that only rises stops being read, and the
 * critical clash sitting in it goes to site.
 *
 * The commercially significant fact is not that a clash was resolved but *how*,
 * and for a model revision *which discipline moved* — that is who pays for the
 * rework, and it is the fact everybody stops being able to establish about six
 * months later. So it is required at the point where somebody still knows it,
 * rather than reconstructed from a model diff that this build cannot perform.
 */
export function resolveClash(
  ctx: EngineContext,
  input: {
    clashId: string;
    method: ClashResolutionMethod;
    /** Which of the two clashing disciplines moved. Required for a model revision. */
    movedDiscipline?: string;
    /** The model the resolution now lives in. Required for a model revision. */
    resolvedInModelId?: string;
    justification: string;
    resolvedBy: string;
    evidenceHash: string;
  },
  now = new Date(),
): {
  clashId: string;
  severity: string;
  daysOpen: number;
  method: ClashResolutionMethod;
  /** True where closing this way left the model describing something that was not built. */
  modelNowOutOfDate: boolean;
} {
  authorise(ctx, 'BIM_TWIN', 'A', { lifecyclePhase: currentPhase(ctx) });

  const clash = ctx.ledger.require({ refType: 'Clash', refId: input.clashId });
  if (clash.state.status === 'RESOLVED') {
    throw new DomainError('CLASH_ALREADY_RESOLVED', `Clash ${input.clashId} has already been closed out`);
  }

  const severity = String(clash.state.severity ?? 'LOW');
  const disciplineA = String(clash.state.disciplineA ?? '');
  const disciplineB = String(clash.state.disciplineB ?? '');

  if (input.justification.trim().length < 15) {
    throw new DomainError('CLASH_JUSTIFICATION_INSUBSTANTIAL', 'Say what was done about it, in terms a coordinator can check');
  }

  if (input.method === 'MODEL_REVISED') {
    if (!input.resolvedInModelId) {
      throw new DomainError('CLASH_RESOLUTION_UNANCHORED', 'A model revision has to name the model the fix is in');
    }
    ctx.ledger.require({ refType: 'Model', refId: input.resolvedInModelId });

    // The clash is between two disciplines. If neither moved, this is not the
    // clash that was fixed, and the register would carry a resolution that
    // points at the wrong work.
    const moved = (input.movedDiscipline ?? '').toUpperCase();
    if (moved !== disciplineA.toUpperCase() && moved !== disciplineB.toUpperCase()) {
      throw new DomainError(
        'CLASH_DISCIPLINE_NOT_IN_CLASH',
        `${input.movedDiscipline ?? 'No discipline'} is not party to this clash — it is between ${disciplineA} and ${disciplineB}`,
      );
    }
  }

  // Dismissing a critical clash as a detection artefact is the cheapest way to
  // make a register look healthy, and the one that puts a real clash on site.
  // It is allowed — false positives are common and real — but it costs an
  // explanation proportionate to what is being waved through.
  if (input.method === 'NOT_A_CLASH' && severity === 'CRITICAL' && input.justification.trim().length < 60) {
    throw new DomainError(
      'CRITICAL_CLASH_DISMISSAL_UNEXPLAINED',
      'Dismissing a critical clash as a false positive needs the reason set out in full, not a note',
    );
  }

  const detectedAt = String(clash.state.detectedAt ?? now.toISOString());
  const daysOpen = Math.max(0, Math.round((now.getTime() - Date.parse(detectedAt)) / 86_400_000));
  const modelNowOutOfDate = input.method === 'RESOLVED_ON_SITE';

  const evidence = registerEvidence(ctx, {
    type: 'CLASH_RESOLUTION',
    hash: input.evidenceHash,
    description: `Resolution of ${severity} clash between ${disciplineA} and ${disciplineB}`,
    linkedEntities: [{ refType: 'Clash', refId: input.clashId }],
  });

  write(ctx, {
    eventType: 'CLASH_RESOLVED',
    entity: { refType: 'Clash', refId: input.clashId },
    nextState: {
      ...clash.state,
      status: 'RESOLVED',
      resolutionMethod: input.method,
      movedDiscipline: input.method === 'MODEL_REVISED' ? input.movedDiscipline : undefined,
      resolvedInModelId: input.resolvedInModelId,
      resolutionJustification: input.justification,
      resolvedBy: input.resolvedBy,
      resolvedAt: now.toISOString(),
      daysOpen,
      // Carried on the record rather than derived later: as-built generation
      // needs to know the model was left behind, and by then nobody will
      // remember which closeouts happened on site.
      modelNowOutOfDate,
    },
    evidenceRefs: [evidence],
  });

  return { clashId: input.clashId, severity, daysOpen, method: input.method, modelNowOutOfDate };
}

/**
 * The clash register as a coordination position rather than a count.
 *
 * Two figures matter and neither is the total. **Critical clashes still open**
 * is what goes to site if nothing happens. **Closeouts that left the model
 * behind** is the as-built liability nobody is looking at, because each one is
 * a place where the record and the building have quietly parted company.
 */
export function clashPosition(
  ctx: EngineContext,
  now = new Date(),
): {
  total: number;
  open: number;
  openCritical: number;
  resolved: number;
  byMethod: Record<string, number>;
  /** Critical clashes closed as detection artefacts. The metric people game. */
  dismissedCritical: number;
  /** Closeouts that left the model describing something that was not built. */
  modelOutOfDate: number;
  averageDaysToResolve?: number;
  oldestOpenDays?: number;
  summary: string;
} {
  authorise(ctx, 'BIM_TWIN', 'R');

  const clashes = ctx.ledger.list(ctx.projectId, 'Clash').map((record) => record.state);
  const open = clashes.filter((c) => c.status !== 'RESOLVED');
  const resolved = clashes.filter((c) => c.status === 'RESOLVED');

  const byMethod: Record<string, number> = {};
  for (const clash of resolved) {
    const method = String(clash.resolutionMethod ?? 'UNRECORDED');
    byMethod[method] = (byMethod[method] ?? 0) + 1;
  }

  const openCritical = open.filter((c) => c.severity === 'CRITICAL').length;
  const dismissedCritical = resolved.filter((c) => c.severity === 'CRITICAL' && c.resolutionMethod === 'NOT_A_CLASH').length;
  const modelOutOfDate = resolved.filter((c) => c.modelNowOutOfDate === true).length;

  const averageDaysToResolve =
    resolved.length === 0
      ? undefined
      : Number((resolved.reduce((sum, c) => sum + Number(c.daysOpen ?? 0), 0) / resolved.length).toFixed(1));

  const openAges = open
    .map((c) => Math.max(0, Math.round((now.getTime() - Date.parse(String(c.detectedAt ?? now.toISOString()))) / 86_400_000)))
    .sort((a, b) => b - a);

  const summary =
    clashes.length === 0
      ? 'No clash detection has been run.'
      : openCritical > 0
        ? `${openCritical} critical clash${openCritical === 1 ? '' : 'es'} still open. A critical clash that reaches site is rework at installed cost.`
        : modelOutOfDate > 0
          ? `All critical clashes closed, but ${modelOutOfDate} ${modelOutOfDate === 1 ? 'was' : 'were'} resolved on site — the model no longer describes what was built there.`
          : `${open.length} open, none critical.`;

  return {
    total: clashes.length,
    open: open.length,
    openCritical,
    resolved: resolved.length,
    byMethod,
    dismissedCritical,
    modelOutOfDate,
    averageDaysToResolve,
    oldestOpenDays: openAges[0],
    summary,
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

/** Why an RFI stopped being open. */
export const RFI_CLOSURE_OUTCOMES = ['ANSWER_ACCEPTED', 'NO_LONGER_REQUIRED', 'SUPERSEDED_BY_CHANGE'] as const;
export type RfiClosureOutcome = (typeof RFI_CLOSURE_OUTCOMES)[number];

/**
 * Close an RFI, which only the person who raised it can do.
 *
 * `answerRFI` moved an RFI to ANSWERED and there it stopped, so the register
 * could say a question had been answered and never whether the asker got what
 * they needed. Those are different facts and the gap between them is where the
 * argument lives: an answer that referred the site back to a drawing it had
 * already queried sat in exactly the same state as one that resolved the
 * problem, and the register showed both as dealt with.
 *
 * **The closer may not be the answerer.** A design team that could close its
 * own answers could clear the register without anybody agreeing the answers
 * were usable, which is the same separation of duties the rest of the platform
 * enforces and the same reason it exists here.
 *
 * `daysToClose` is recorded beside `daysOpen` deliberately. Time-to-answer is
 * the design team's performance; time-to-close is what site actually waited,
 * and only the second one is the delay.
 */
export function closeRFI(
  ctx: EngineContext,
  input: {
    rfiId: string;
    outcome: RfiClosureOutcome;
    /** Why this closes it. An accepted answer still needs a sentence saying so. */
    note: string;
    closedBy: string;
    evidenceHash: string;
  },
  now = new Date(),
): { rfiId: string; reference: string; daysToClose: number; answeredLate: boolean } {
  // `U` rather than `A`, and deliberately the same capability that answering
  // needs. Approve on design information is held by the designers — the people
  // who answer — so requiring it here would have meant only the answering
  // discipline could close, which is the opposite of what closure is for. The
  // separation is done by identity below: whoever answered may not close.
  authorise(ctx, 'DESIGN_INFORMATION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const rfi = ctx.ledger.require({ refType: 'RFI', refId: input.rfiId });
  const status = String(rfi.state.status);

  if (status === 'CLOSED') {
    throw new DomainError('RFI_ALREADY_CLOSED', `${String(rfi.state.reference)} is already closed`);
  }

  // An unanswered RFI can still be closed — the question can stop mattering, or
  // be overtaken by an instruction — but only for a reason that says so. Closing
  // an unanswered question as "answer accepted" would record an answer that
  // does not exist.
  if (status !== 'ANSWERED' && input.outcome === 'ANSWER_ACCEPTED') {
    throw new DomainError(
      'RFI_NOT_ANSWERED',
      `${String(rfi.state.reference)} has not been answered, so there is no answer to accept`,
      422,
      [{ field: 'outcome', message: 'Close it as no longer required or superseded, or wait for the answer' }],
    );
  }

  if (String(rfi.state.answeredBy ?? '') === input.closedBy) {
    throw new DomainError(
      'RFI_ANSWERER_CANNOT_CLOSE',
      'The person who answered an RFI cannot also close it. Closure is the asker agreeing the answer is usable.',
      403,
      [{ field: 'closedBy', message: 'This is the identity that answered the RFI' }],
    );
  }

  if (input.note.trim().length < 10) {
    throw new DomainError('RFI_CLOSURE_UNEXPLAINED', 'Say why this RFI is closed, in a sentence a reader will understand later');
  }

  const raisedAt = String(rfi.state.raisedAt);
  const daysToClose = Math.max(0, Math.round((now.getTime() - Date.parse(raisedAt)) / 86_400_000));

  const evidence = registerEvidence(ctx, {
    type: 'RFI_CLOSURE',
    hash: input.evidenceHash,
    description: `Closure of ${String(rfi.state.reference)}: ${input.outcome}`,
    linkedEntities: [{ refType: 'RFI', refId: input.rfiId }],
  });

  write(ctx, {
    eventType: 'RFI_CLOSED',
    entity: { refType: 'RFI', refId: input.rfiId },
    nextState: {
      ...rfi.state,
      status: 'CLOSED',
      closureOutcome: input.outcome,
      closureNote: input.note,
      closedBy: input.closedBy,
      closedAt: now.toISOString(),
      // What site waited, as opposed to what the design team took to answer.
      daysToClose,
    },
    evidenceRefs: [evidence],
  });

  return {
    rfiId: input.rfiId,
    reference: String(rfi.state.reference),
    daysToClose,
    answeredLate: rfi.state.answeredLate === true,
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
  /** Answered and not yet accepted by whoever asked. This is what site is waiting on. */
  awaitingClosure: number;
  closed: number;
  overdue: Array<{ reference: string; question: string; daysOpen: number; dueDate?: string }>;
  answeredLate: number;
  averageDaysToAnswer?: number;
  averageDaysToClose?: number;
  designChanges: number;
  summary: string;
} {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const rfis = ctx.ledger.list(ctx.projectId, 'RFI').map((record) => record.state);
  // Open means nobody has answered it. A closed RFI is not open, and this used
  // to say `status !== 'ANSWERED'`, which counted every closed one as still
  // outstanding the moment closure existed.
  const open = rfis.filter((r) => r.status !== 'ANSWERED' && r.status !== 'CLOSED');
  const closed = rfis.filter((r) => r.status === 'CLOSED');

  const overdue = open
    .filter((r) => typeof r.dueDate === 'string' && today > String(r.dueDate))
    .map((r) => ({
      reference: String(r.reference),
      question: String(r.question ?? ''),
      daysOpen: Math.max(0, Math.round((Date.parse(today) - Date.parse(String(r.raisedAt))) / 86_400_000)),
      dueDate: String(r.dueDate),
    }))
    .sort((a, b) => b.daysOpen - a.daysOpen);

  // Answered, whether or not it has since been closed — the design team's
  // response time does not stop counting because somebody accepted the answer.
  const answered = rfis.filter((r) => r.answeredAt !== undefined);
  const answeredLate = answered.filter((r) => r.answeredLate === true).length;
  // Stated only where something has been answered. An average over nothing is
  // zero, and zero days to answer reads as excellent rather than as no data.
  const averageDaysToAnswer =
    answered.length === 0
      ? undefined
      : Number((answered.reduce((sum, r) => sum + Number(r.daysOpen ?? 0), 0) / answered.length).toFixed(1));

  const designChanges = answered.filter((r) => r.changesDesign === true).length;

  // What site actually waited, as distinct from what the design team took.
  const averageDaysToClose =
    closed.length === 0
      ? undefined
      : Number((closed.reduce((sum, r) => sum + Number(r.daysToClose ?? 0), 0) / closed.length).toFixed(1));

  const summary =
    rfis.length === 0
      ? 'No RFIs raised.'
      : overdue.length === 0
        ? `${open.length} open, none overdue.`
        : `${overdue.length} overdue, the oldest ${overdue[0]!.daysOpen} days. Unanswered information is the most common ground for a design-delay claim.`;

  return {
    total: rfis.length,
    open: open.length,
    awaitingClosure: rfis.filter((r) => r.status === 'ANSWERED').length,
    closed: closed.length,
    overdue,
    answeredLate,
    averageDaysToAnswer,
    averageDaysToClose,
    designChanges,
    summary,
  };
}

// --- Specification -----------------------------------------------------------

/**
 * Ingest a specification and extract what it requires.
 *
 * The specification decides whether work is acceptable, and it is the document
 * nobody reads until there is an argument. The clauses that cost money are not
 * the ones describing a material — those get priced — but the ones imposing a
 * step *before or during* the work: a sample to be approved, a test to be
 * passed, a hold point nobody may build through. Miss one and the work is
 * built, and then it is a non-conformance, a delay, and an argument about who
 * should have known.
 *
 * Extraction is deterministic and the classification comes from the words the
 * clause uses, so the same document produces the same clauses twice and anybody
 * can see why a clause was classified as it was. The model characterises the
 * section; it does not decide what any clause requires.
 *
 * **This reads supplied text.** Table extraction is not built. A specification
 * arriving as a PDF is read into text by ingestion where it carries a text
 * layer, and by a confirmed model transcription (`DOCUMENT_TEXT`) where it is a
 * scan; either way the text is supplied here rather than the file — the same
 * terms contract clause extraction already works on, stated rather than implied.
 */
export async function ingestSpecification(
  ctx: EngineContext,
  input: {
    /** The work section, as the specification numbers it — E10, A12, "Section 5". */
    sectionRef: string;
    title: string;
    revision: string;
    specificationText: string;
    documentHash: string;
  },
): Promise<{
  specificationId: string;
  clauseIds: string[];
  clauses: number;
  requiringVerification: number;
  acuConsumed: number;
}> {
  // Import, as drawing registration is and as the event action says. Reading a
  // document into the platform is the same act whichever document it is.
  authorise(ctx, 'DESIGN_INFORMATION', 'I', { lifecyclePhase: currentPhase(ctx) });

  if (input.specificationText.trim().length < 100) {
    throw new DomainError(
      'SPECIFICATION_TOO_SHORT',
      'There is not enough text here to be a specification section. A scanned specification is transcribed first on the ' +
        'Documents screen — a PDF with a text layer is read from its bytes, a scan by a model that can see, confirmed by a ' +
        'person — and the text supplied here.',
    );
  }

  const extracted = extractClauses(input.specificationText, input.sectionRef);
  if (extracted.length === 0) {
    throw new DomainError(
      'NO_CLAUSES_FOUND',
      'No clause in this text states a requirement. Check it is the specification rather than a contents page or a covering letter.',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'SPECIFICATION_DOCUMENT',
    hash: input.documentHash,
    description: `${input.sectionRef} ${input.title} revision ${input.revision}`,
  });

  const specificationId = ulid();
  const clauseIds: string[] = [];
  const requiringVerification = extracted.filter((c) => c.requiresVerification).length;

  const result = await runAI(ctx, {
    engine: 'BIM_TWIN',
    taskType: 'specification_reading',
    capability: 'REASONING',
    inputRefs: [evidence],
    request: {
      task: 'Characterise what this specification section demands of the contractor and where the risk in it sits',
      payload: {
        sectionRef: input.sectionRef,
        title: input.title,
        clauses: extracted.slice(0, 40).map((c) => ({ clauseRef: c.clauseRef, kind: c.kind, mandatory: c.mandatory })),
        totalClauses: extracted.length,
      },
    },
    toWrites: (output) => {
      const writes: Array<{ eventType: string; entity: EntityRef; nextState: Record<string, unknown>; evidenceRefs?: EntityRef[] }> = [
        {
          eventType: 'SPECIFICATION_INGESTED',
          entity: { refType: 'Specification', refId: specificationId },
          nextState: {
            id: specificationId,
            projectId: ctx.projectId,
            sectionRef: input.sectionRef,
            title: input.title,
            revision: input.revision,
            documentHash: input.documentHash,
            clauseCount: extracted.length,
            requiringVerification,
            narrative: String(output.narrative ?? ''),
            ingestedAt: new Date().toISOString(),
            // The source is text somebody supplied, not a document the platform
            // read. Anyone relying on this needs to know which.
            source: 'SUPPLIED_TEXT',
          },
          evidenceRefs: [evidence],
        },
      ];

      for (const clause of extracted) {
        const clauseId = ulid();
        clauseIds.push(clauseId);
        writes.push({
          eventType: 'SPEC_CLAUSE_EXTRACTED',
          entity: { refType: 'SpecClause', refId: clauseId },
          nextState: {
            id: clauseId,
            projectId: ctx.projectId,
            specificationId,
            specificationRef: input.sectionRef,
            ...clause,
          },
          evidenceRefs: [evidence],
        });
      }

      return writes;
    },
  });

  return {
    specificationId,
    clauseIds,
    clauses: extracted.length,
    requiringVerification,
    acuConsumed: result.acuConsumed,
  };
}

/**
 * Which specified verification steps have an inspection stage against them.
 *
 * The join that makes the extraction worth doing. A clause requiring a test,
 * with no ITP stage naming it, is work that will be built and then argued
 * about — and neither the quality manager reading the ITP nor the engineer
 * reading the specification can see it, because it only exists between the two.
 */
export function specificationCoverage(ctx: EngineContext): SpecificationCoverage {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const clauses = ctx.ledger.list(ctx.projectId, 'SpecClause').map((record) => ({
    clauseRef: String(record.state.clauseRef),
    text: String(record.state.text),
    kind: record.state.kind as ExtractedClause['kind'],
    mandatory: record.state.mandatory === true,
    standards: (record.state.standards ?? []) as string[],
    requiresVerification: record.state.requiresVerification === true,
    triggers: (record.state.triggers ?? []) as string[],
    specificationRef: String(record.state.specificationRef),
  }));

  // Every acceptance criterion across every plan. The ITP template already asks
  // for "the specification or drawing clause the inspection is against", so
  // this is the field that was put there for exactly this join.
  const criteria = ctx.ledger.list(ctx.projectId, 'InspectionPlan').flatMap((plan) => {
    const stages = (plan.state.stages ?? []) as Array<{ acceptanceCriteria?: string }>;
    const planRef = plan.state.specificationRef === undefined ? [] : [String(plan.state.specificationRef)];
    return [...planRef, ...stages.map((stage) => String(stage.acceptanceCriteria ?? ''))];
  });

  return assessCoverage(clauses, criteria, ctx.ledger.list(ctx.projectId, 'Specification').length);
}

/**
 * What late design information is costing.
 *
 * The design command centre could say how many RFIs were overdue and by how
 * long. It could not say what that was worth, which is the only form in which
 * the number reaches a commercial conversation — "eleven RFIs overdue" gets
 * noted, "£412,500 of exposure" gets acted on.
 *
 * ---
 *
 * **What this refuses to fabricate.** An RFI carries a discipline and a linked
 * drawing; it carries no activity reference. So nothing in the record proves
 * which RFI sits on the critical path, and a figure that assumed every overdue
 * RFI delays completion would be a large confident number built on an
 * assumption the data does not support.
 *
 * The exposure is therefore reported as **conditional and bounded**: this is
 * what the worst overdue RFI costs *if* it sits on the critical chain, at the
 * contract's own damages rate, and the response says so in the same breath as
 * the figure. Float is subtracted first, because days absorbed by float cost
 * nothing — that is what float is for, and a model that charged for them would
 * overstate every project with slack in it.
 *
 * **And it names what would make it exact.** An activity reference on an RFI
 * turns every figure here from conditional into computed. That is a one-field
 * change to the capture command and it is worth more than any refinement of the
 * arithmetic, so it is reported rather than left as a comment nobody reads.
 */
/**
 * Design readiness against the work about to start.
 *
 * The design command centre answered "what will happen next" with nothing at
 * all: there was no way to say whether the information needed for the next six
 * weeks of work is going to be there. It is answerable now for the same reason
 * the delay exposure is computed — an RFI names the activity it is holding up.
 *
 * The question is deliberately narrow. Not "is the design finished", which no
 * project can answer, but: **of the activities in the published lookahead, which
 * are waiting on a question nobody has answered, and how late is the answer?**
 * That is a fortnight's worth of foresight from records that already exist, and
 * it is the difference between finding out on the Monday and finding out three
 * weeks earlier.
 *
 * An activity with no open question is reported as ready rather than silently
 * omitted, because "nine of eleven are ready" and "nine are ready" are different
 * statements and only one of them is checkable.
 */
export type DesignReadiness = {
  /** Whether a lookahead has been published at all. Nothing is inferred without one. */
  hasLookahead: boolean;
  weekStarting?: string;
  weeks?: number;
  plannedActivities: number;
  ready: number;
  waiting: Array<{
    taskId: string;
    taskName: string;
    onCriticalPath: boolean;
    /** Promised in the lookahead, or merely planned in it. */
    committed: boolean;
    openRfis: Array<{ reference: string; question: string; dueDate: string; daysOverdue: number }>;
  }>;
  /** Committed work waiting on information — the promises most likely to break. */
  committedAtRisk: number;
  summary: string;
  /** What would make the answer better, where anything would. */
  toMakeExact?: string;
};

export function designReadiness(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): DesignReadiness {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const lookahead = ctx.ledger
    .list(ctx.projectId, 'LookaheadPlan')
    .filter((record) => record.state.status !== 'SUPERSEDED')
    .sort((a, b) => String(a.state.weekStarting).localeCompare(String(b.state.weekStarting)))
    .at(-1);

  if (!lookahead) {
    return {
      hasLookahead: false,
      plannedActivities: 0,
      ready: 0,
      waiting: [],
      committedAtRisk: 0,
      summary:
        'No lookahead is published, so there is no window of work to check the design information against.',
      toMakeExact: 'Publish a lookahead. Design readiness is a question about the work that is about to start.',
    };
  }

  const plannedTaskIds = (lookahead.state.plannedTaskIds as string[]) ?? [];
  const commitments = (lookahead.state.commitments as Array<{ taskId: string }>) ?? [];
  const committedTaskIds = new Set(commitments.map((commitment) => commitment.taskId));

  const openByTask = new Map<string, DesignReadiness['waiting'][number]['openRfis']>();
  let unlinkedOpen = 0;

  for (const record of ctx.ledger.list(ctx.projectId, 'RFI')) {
    const rfi = record.state;
    if (rfi.status === 'ANSWERED') continue;

    const taskId = typeof rfi.linkedTaskId === 'string' ? rfi.linkedTaskId : undefined;
    if (!taskId) {
      unlinkedOpen += 1;
      continue;
    }
    if (!plannedTaskIds.includes(taskId)) continue;

    const due = String(rfi.dueDate ?? '');
    const list = openByTask.get(taskId) ?? [];
    list.push({
      reference: String(rfi.reference),
      question: String(rfi.question ?? ''),
      dueDate: due,
      daysOverdue: due !== '' && today > due
        ? Math.max(0, Math.round((Date.parse(today) - Date.parse(due)) / 86_400_000))
        : 0,
    });
    openByTask.set(taskId, list);
  }

  const network = networkFloat(ctx);
  const names = new Map(
    ctx.ledger.list(ctx.projectId, 'Task').map((record) => [record.refId, String(record.state.name)]),
  );

  const waiting = [...openByTask.entries()]
    .map(([taskId, openRfis]) => ({
      taskId,
      taskName: names.get(taskId) ?? network.activityNames.get(taskId) ?? taskId,
      onCriticalPath: network.critical.has(taskId),
      committed: committedTaskIds.has(taskId),
      openRfis: openRfis.sort((a, b) => b.daysOverdue - a.daysOverdue),
    }))
    // Committed and critical first: those are the promises that break.
    .sort((a, b) =>
      Number(b.committed) - Number(a.committed) ||
      Number(b.onCriticalPath) - Number(a.onCriticalPath) ||
      (b.openRfis[0]?.daysOverdue ?? 0) - (a.openRfis[0]?.daysOverdue ?? 0),
    );

  const committedAtRisk = waiting.filter((entry) => entry.committed).length;

  return {
    hasLookahead: true,
    weekStarting: String(lookahead.state.weekStarting),
    weeks: Number(lookahead.state.weeks ?? 6),
    plannedActivities: plannedTaskIds.length,
    ready: plannedTaskIds.length - waiting.length,
    waiting,
    committedAtRisk,
    summary:
      waiting.length === 0
        ? `All ${plannedTaskIds.length} activities in the lookahead from ${String(lookahead.state.weekStarting)} have their design information. Nothing in the window is waiting on an answer.`
        : `${waiting.length} of ${plannedTaskIds.length} activities in the lookahead are waiting on a question nobody has answered${
            committedAtRisk > 0
              ? `, and ${committedAtRisk} of those ${committedAtRisk === 1 ? 'carries a promise' : 'carry promises'} against ${committedAtRisk === 1 ? 'it' : 'them'}`
              : ''
          }.`,
    // Only worth saying where a question exists that this could have counted.
    ...(unlinkedOpen > 0
      ? {
          toMakeExact:
            `${unlinkedOpen} open RFI${unlinkedOpen === 1 ? '' : 's'} name no activity, so ${
              unlinkedOpen === 1 ? 'it is' : 'they are'
            } invisible to this answer. Naming the activity on the markup is what brings ${unlinkedOpen === 1 ? 'it' : 'them'} in.`,
        }
      : {}),
  };
}

export type DesignDelayExposure = {
  /** Overdue RFIs, and the total days of information owed. */
  overdueCount: number;
  totalDaysOverdue: number;
  /** The single worst, which is what sets the conditional exposure. */
  worstDaysOverdue: number;
  /**
   * Days of programme slack before any delay reaches completion — the minimum
   * total float across the critical and near-critical activities.
   */
  floatDays: number;
  /** Days by which the worst RFI exceeds the float. Zero while float absorbs it. */
  daysBeyondFloatIfCritical: number;
  /** Damages per day under the contract. The anchor for the money. */
  dailyDamagesMinor: number;
  /** `daysBeyondFloatIfCritical` at the damages rate. Conditional, and labelled so. */
  exposureIfCriticalMinor: number;

  /**
   * How much of the figure is computed rather than assumed.
   *
   * `CONDITIONAL` — no overdue RFI names an activity, so the only honest
   * statement is the old one: *if* the worst one is on the critical path.
   * `PARTLY_COMPUTED` — some name an activity and some do not; the computed
   * part is real and the rest is still conditional, and both are reported.
   * `COMPUTED` — every overdue RFI names an activity, so the exposure is read
   * off the network rather than supposed.
   */
  basis: 'CONDITIONAL' | 'PARTLY_COMPUTED' | 'COMPUTED';
  /** Overdue RFIs that name the activity they are holding up. */
  linkedCount: number;
  /** Overdue RFIs that do not, and therefore cannot be priced. */
  unlinkedCount: number;
  /**
   * The activities actually blocked, worst first, each with its own float.
   *
   * Per activity rather than per RFI: two questions against the same activity
   * delay it once, and totalling them would invent a delay nobody has suffered.
   */
  blockedActivities: Array<{
    taskId: string;
    taskName: string;
    onCriticalPath: boolean;
    totalFloat: number;
    daysOverdue: number;
    daysBeyondFloat: number;
    rfiReferences: string[];
  }>;
  /** What the record supports, at the damages rate. Zero where nothing is proven. */
  computedExposureMinor: number;
  /** Why the figure is what it is, in the words the console should print. */
  qualification: string;
  /** The one change that would make it exact, where one remains. */
  toMakeExact?: string;
};

export function designDelayExposure(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): DesignDelayExposure {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const daysLate = (dueDate: unknown): number =>
    Math.max(0, Math.round((Date.parse(today) - Date.parse(String(dueDate))) / 86_400_000));

  const overdueRfis = ctx.ledger
    .list(ctx.projectId, 'RFI')
    .map((record) => record.state)
    .filter((r) => r.status !== 'ANSWERED' && typeof r.dueDate === 'string' && today > String(r.dueDate));

  const overdue = overdueRfis.map((r) => daysLate(r.dueDate));
  const totalDaysOverdue = overdue.reduce((sum, days) => sum + days, 0);
  const worstDaysOverdue = overdue.reduce((most, days) => Math.max(most, days), 0);

  // Float from the programme rather than from an assumption. Where no baseline
  // exists there is no float to spend, and treating that as zero float is the
  // conservative reading — it is also the true one: a project with no baseline
  // cannot demonstrate slack.
  const baseline = ctx.ledger.list(ctx.projectId, 'ProgrammeBaseline').at(-1);
  const nearCritical = (baseline?.state.nearCritical ?? []) as Array<{ totalFloat?: number }>;
  const floatDays = nearCritical.length > 0
    ? Math.max(0, Math.min(...nearCritical.map((a) => Number(a.totalFloat ?? 0))))
    : 0;

  const contract = ctx.ledger.list(ctx.projectId, 'Contract').at(-1);
  const dailyDamagesMinor = Number(contract?.state.liquidatedDamagesPerDayMinor ?? 0);

  const daysBeyondFloatIfCritical = Math.max(0, worstDaysOverdue - floatDays);

  // --- the computed half ------------------------------------------------------
  //
  // An RFI that names the activity it blocks can be priced against that
  // activity's own float and its own place on the network, rather than against
  // a project-wide minimum and a supposition.
  const network = networkFloat(ctx);
  const byTask = new Map<string, { taskId: string; taskName: string; daysOverdue: number; rfiReferences: string[] }>();

  for (const rfi of overdueRfis) {
    const taskId = typeof rfi.linkedTaskId === 'string' ? rfi.linkedTaskId : undefined;
    if (!taskId) continue;
    const late = daysLate(rfi.dueDate);
    const existing = byTask.get(taskId);
    if (existing) {
      // The worst question against an activity is what holds it up; the second
      // one does not hold it up again.
      existing.daysOverdue = Math.max(existing.daysOverdue, late);
      existing.rfiReferences.push(String(rfi.reference));
    } else {
      byTask.set(taskId, {
        taskId,
        taskName: String(rfi.linkedTaskName ?? network.activityNames.get(taskId) ?? taskId),
        daysOverdue: late,
        rfiReferences: [String(rfi.reference)],
      });
    }
  }

  const blockedActivities = [...byTask.values()]
    .map((entry) => {
      const onCriticalPath = network.critical.has(entry.taskId);
      // An activity the network does not know carries no demonstrable float,
      // which is the same conservative reading applied to a project with no
      // baseline at all.
      const totalFloat = network.floatByTask.get(entry.taskId) ?? 0;
      return {
        ...entry,
        onCriticalPath,
        totalFloat,
        daysBeyondFloat: Math.max(0, entry.daysOverdue - totalFloat),
      };
    })
    .sort((a, b) => b.daysBeyondFloat - a.daysBeyondFloat || b.daysOverdue - a.daysOverdue);

  // The worst affected critical activity, not the sum of them.
  //
  // Two critical activities each a week late do not make the project a
  // fortnight late — they are concurrent, and the job finishes late by the
  // worse of the two. Adding them would produce a number that reads as rigour
  // and would be thrown out by the first person who checked it. A proper
  // time-impact analysis is the only thing that beats this, and it is not built.
  const criticalDelay = blockedActivities
    .filter((a) => a.onCriticalPath)
    .reduce((worst, a) => Math.max(worst, a.daysBeyondFloat), 0);
  const computedExposureMinor = criticalDelay * dailyDamagesMinor;

  const linkedCount = overdueRfis.filter((r) => typeof r.linkedTaskId === 'string').length;
  const unlinkedCount = overdueRfis.length - linkedCount;
  const basis: DesignDelayExposure['basis'] =
    overdueRfis.length === 0 || linkedCount === 0
      ? 'CONDITIONAL'
      : unlinkedCount === 0
        ? 'COMPUTED'
        : 'PARTLY_COMPUTED';

  return {
    overdueCount: overdue.length,
    totalDaysOverdue,
    worstDaysOverdue,
    floatDays,
    daysBeyondFloatIfCritical,
    dailyDamagesMinor,
    exposureIfCriticalMinor: daysBeyondFloatIfCritical * dailyDamagesMinor,
    basis,
    linkedCount,
    unlinkedCount,
    blockedActivities,
    computedExposureMinor,
    qualification:
      // Four states now. "Float absorbs the delay: 0 days of slack against 0
      // days overdue" is what the first version printed when nothing was
      // overdue at all — technically true, and it reads as a project running on
      // empty float, which is close to the opposite of the truth.
      overdue.length === 0
        ? 'No design information is overdue. Nothing is being consumed.'
        : basis === 'CONDITIONAL'
          ? daysBeyondFloatIfCritical === 0
            ? `Float absorbs it: ${floatDays} days of slack against ${worstDaysOverdue} days overdue.`
            : `If the worst overdue RFI sits on the critical path. ${floatDays} days of float absorb the first part; the remaining ${daysBeyondFloatIfCritical} are priced at the contract damages rate.`
          : criticalDelay === 0
            ? `${linkedCount} overdue question${linkedCount === 1 ? '' : 's'} name the activity held up, and none of those activities is on the critical path with its float spent. Nothing is demonstrably reaching completion.`
            : `${criticalDelay} day${criticalDelay === 1 ? '' : 's'} beyond float on the critical path, read off the network rather than supposed — driven by ${
                blockedActivities.find((a) => a.onCriticalPath && a.daysBeyondFloat === criticalDelay)?.taskName ?? 'a critical activity'
              }. Concurrent critical delays are not added: the job finishes late by the worst of them.`,
    // Only worth saying where something is still left to be exact about.
    ...(unlinkedCount > 0
      ? {
          toMakeExact:
            `${unlinkedCount} overdue RFI${unlinkedCount === 1 ? ' does' : 's do'} not name the activity held up, so ${
              unlinkedCount === 1 ? 'it stays' : 'they stay'
            } conditional. Naming the activity on the markup is what prices ${unlinkedCount === 1 ? 'it' : 'them'}.`,
        }
      : network.hasNetwork
        ? {}
        : {
            toMakeExact:
              'There is no programme network to read float from, so every activity is treated as having none. A baseline makes the same figure defensible.',
          }),
  };
}
