import { SITE_OBSERVATION_CATEGORY, values } from '../../../shared/vocabulary.js';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { config } from '../config.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { findByHash } from '../evidence/registry.ts';
import type { CapabilityArea, PermissionCode } from '../identity/roles.ts';
import type { Engine } from '../ai/orchestrator.ts';
import { submitProgress } from '../domain/progressverification.ts';
import { authorise, currentPhase, runAI, write, type EngineContext } from './context.ts';
import { registerDrawing } from './bim.ts';
import { captureSiteObservation } from './planning.ts';
import { raiseNCR } from './quality.ts';
import { logSafetyObservation } from './safety.ts';
import { runTakeoff } from './tender.ts';

/**
 * Perception ingestion: reading a file the platform holds.
 *
 * Three things were treated as three problems — drawing take-off, title-block
 * reading, and voice capture — and they are one. Each takes a file, asks a model
 * that can actually look at or listen to it for a structured answer, and turns
 * that answer into something a person confirms. The differences are the prompt,
 * the schema and where a confirmed answer goes.
 *
 * This became possible only once the object store existed. Before it, the
 * platform held a hash and not the file, so there was nothing to show a model;
 * the title-block path worked from `rawTitleBlockText`, meaning somebody had
 * already read the drawing by hand.
 *
 * ---
 *
 * **Nothing here invents an extraction.** The local adapter derives its answers
 * from a hash of its inputs. It cannot read a drawing, and asking it to produces
 * a confident, deterministic, entirely fictional title block. That was not
 * hypothetical: `registerDrawing` fell back to `String(output.drawingNumber ??
 * 'UNPARSED-…')` and would write `Untitled / P01 / GENERAL` into the drawing
 * register as a governed record. So an adapter declares whether it is
 * multimodal, and a perception command against one that is not is **refused**.
 * A refusal is a true statement about the deployment; a fabricated title block
 * is a false statement about the project.
 *
 * **An extraction is a draft, never a record.** The model's answer is written as
 * a `PerceptionDraft` and goes no further until a person confirms it, with
 * whatever corrections they make. Confirmation then runs the ordinary domain
 * command — the same one a person typing the values by hand would run, with the
 * same authorisation, the same phase gate and the same events. There is no
 * second path into the register for machine-read data, which is the only way the
 * chain stays worth having.
 *
 * **The file goes to the provider as media, not as text.** A base64 string
 * stringified into a JSON prompt is the same bytes charged at text rates and
 * looked at by nothing. `ProviderRequest.media` exists so each adapter places it
 * where its own API expects it.
 *
 * **Not verified against a live provider.** The remote adapters are written to
 * both vendors' documented multimodal request shapes and are exercised in the
 * suite against a stub; no call to OpenAI or Gemini has been made from this
 * environment, and nothing here should be read as saying one has.
 *
 * ---
 *
 * ## The vision tasks
 *
 * `PROGRESS_FROM_IMAGES`, `PPE_COMPLIANCE`, `EQUIPMENT_RECOGNITION` and
 * `DEFECT_DETECTION` are the same pipeline with four more prompts. They were
 * specified as a separate "vision pipeline" and are not built as one, because
 * every rule a vision pipeline needs is already here: refuse where no provider
 * can see, send the file as media, write a draft, let a person confirm it into
 * the ordinary domain command.
 *
 * A second pipeline would have been a second way into the progress register,
 * the NCR register and the safety log — the one thing the draft/confirm
 * discipline exists to prevent.
 *
 * **What the model may not decide.** It reads the photograph; it does not choose
 * the activity being claimed against, the period being claimed for, or whether
 * an NCR is raised. Those are the confirmer's, supplied at confirmation, because
 * they are the fields a valuation is argued over and none of them is visible in
 * an image. A model that returned `taskId` would be guessing at the one number
 * that decides who gets paid.
 *
 * **`PROGRESS_EXTRACTED_FROM_IMAGES`** is written alongside the ordinary
 * `PROGRESS_REPORTED`, against the same submission. It is not a duplicate: the
 * submission event says a quantity was claimed, and this says the quantity was
 * read off a photograph by a named provider at a stated confidence, with the
 * confirmer's corrections beside it. Three years on, that is the difference
 * between a claim somebody measured and a claim somebody accepted.
 */

export type PerceptionTask =
  | 'TITLE_BLOCK'
  | 'DRAWING_TAKEOFF'
  | 'VOICE_NOTE'
  | 'PROGRESS_FROM_IMAGES'
  | 'PPE_COMPLIANCE'
  | 'EQUIPMENT_RECOGNITION'
  | 'DEFECT_DETECTION';

type TaskDefinition = {
  engine: Engine;
  /**
   * Distinct from the text-path task of the same name on purpose.
   * `registerDrawing` runs `title_block_extraction` over text somebody already
   * typed; this reads an image. The costs differ by orders of magnitude, and
   * the platform's estimate is measured per (engine, task) from real history —
   * sharing a key would average a 4MB drawing with a paragraph of text and
   * quote both wrongly.
   */
  taskType: string;
  /**
   * The exact authority the downstream command exercises — not a gate of this
   * pipeline's own.
   *
   * The precedent is `approveProposal`: approving what a machine produced needs
   * the capability the resulting command will need, because approving *is* the
   * authorisation. The same pair governs starting an extraction, so nobody can
   * ask a model to draft something they could not have recorded themselves,
   * and confirming, so a draft is not a way round the register's own rules.
   *
   * Inventing a code here instead would have been a second permission model for
   * the same writes. It was briefly `A`, which no role holds on
   * DESIGN_INFORMATION at all — the person who may register a drawing by hand
   * could not confirm a reading of the same drawing.
   */
  area: CapabilityArea;
  code: PermissionCode;
  label: string;
  /** What the file has to be. Checked before anything is reserved or charged. */
  accepts: string[];
  acceptsLabel: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
  /** Whether the model returned enough to be worth showing anybody. */
  usable: (extraction: Record<string, unknown>) => boolean;
};

const IMAGE_OR_PDF = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];

/**
 * Site photography. Deliberately not PDF: a drawing is a document about what is
 * intended, and these four tasks report what is there. Letting a PDF through
 * would let somebody read progress off the programme.
 */
const SITE_IMAGE = ['image/png', 'image/jpeg', 'image/webp'];

export const PERCEPTION_TASKS: Record<PerceptionTask, TaskDefinition> = {
  TITLE_BLOCK: {
    engine: 'BIM_TWIN',
    taskType: 'title_block_from_image',
    area: 'DESIGN_INFORMATION',
    // What `registerDrawing` requires: importing design information.
    code: 'I',
    label: 'Read a drawing title block',
    accepts: IMAGE_OR_PDF,
    acceptsLabel: 'a drawing image or PDF',
    prompt:
      'Read the title block of this drawing. Report the drawing number, title, revision, discipline, ' +
      'issue status and issue date exactly as printed. Report a field as null if it is not legible — ' +
      'never infer or complete one.',
    responseSchema: {
      type: 'object',
      properties: {
        drawingNumber: { type: ['string', 'null'] },
        title: { type: ['string', 'null'] },
        revision: { type: ['string', 'null'] },
        discipline: { type: ['string', 'null'] },
        status: { type: ['string', 'null'] },
        issueDate: { type: ['string', 'null'] },
        drawnBy: { type: ['string', 'null'] },
        checkedBy: { type: ['string', 'null'] },
      },
      required: ['drawingNumber', 'title', 'revision', 'discipline'],
    },
    // A title block with no drawing number is not a title block. Registering it
    // would create a drawing nobody can supersede, because supersession keys on
    // the number.
    usable: (extraction) => typeof extraction.drawingNumber === 'string' && extraction.drawingNumber.trim() !== '',
  },

  DRAWING_TAKEOFF: {
    engine: 'TENDER',
    taskType: 'quantity_extraction_from_image',
    area: 'BOQ_TAKEOFF',
    // What `runTakeoff` requires.
    code: 'C',
    label: 'Measure quantities from a drawing',
    accepts: IMAGE_OR_PDF,
    acceptsLabel: 'a drawing image or PDF',
    prompt:
      'Measure the quantities shown on this drawing. For each item report a description, the unit of ' +
      'measurement, the quantity, the sheet or grid reference it was measured from, and the NRM2 ' +
      'measurement rule applied. Report only quantities that are dimensioned or scalable on the sheet; ' +
      'omit anything that would require an assumption, and say what was omitted and why.',
    responseSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              unit: { type: 'string' },
              quantity: { type: 'number' },
              sourceSheet: { type: ['string', 'null'] },
              measurementRule: { type: ['string', 'null'] },
            },
            required: ['description', 'unit', 'quantity'],
          },
        },
        omitted: { type: 'array', items: { type: 'string' } },
        scale: { type: ['string', 'null'] },
      },
      required: ['items'],
    },
    usable: (extraction) => Array.isArray(extraction.items) && extraction.items.length > 0,
  },

  VOICE_NOTE: {
    engine: 'PLANNING',
    taskType: 'voice_note_transcription',
    area: 'FIELD_EXECUTION',
    // What `captureSiteObservation` requires.
    code: 'C',
    label: 'Transcribe a site voice note',
    // Audio only. A photograph is not a voice note, and letting the task run
    // against one spends ACUs to be told so.
    accepts: ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/x-m4a'],
    acceptsLabel: 'an audio recording',
    // The category list is read from the shared vocabulary, not restated here.
    // Written out by hand it said SAFETY, which is not one of the platform's
    // observation categories at all — the model would have been asked for a
    // value the domain command then refuses.
    prompt:
      'Transcribe this site voice note verbatim. Then classify what it is about using exactly one of ' +
      `${values(SITE_OBSERVATION_CATEGORY).join(', ')}, and report the location mentioned, whether it ` +
      'describes something requiring action, and who is named as responsible. Do not summarise the ' +
      'transcript and do not add anything the speaker did not say.',
    responseSchema: {
      type: 'object',
      properties: {
        transcript: { type: 'string' },
        category: { type: 'string', enum: values(SITE_OBSERVATION_CATEGORY) },
        location: { type: ['string', 'null'] },
        requiresAction: { type: 'boolean' },
        actionOwner: { type: ['string', 'null'] },
      },
      required: ['transcript', 'category'],
    },
    usable: (extraction) => typeof extraction.transcript === 'string' && extraction.transcript.trim().length > 0,
  },

  PROGRESS_FROM_IMAGES: {
    engine: 'PLANNING',
    taskType: 'progress_estimation_from_image',
    area: 'FIELD_EXECUTION',
    // What `submitProgress` requires.
    code: 'C',
    label: 'Estimate progress from a site photograph',
    accepts: SITE_IMAGE,
    acceptsLabel: 'a site photograph',
    // The model is asked for a measurement and a basis, never a percentage on
    // its own. A percentage with no quantity behind it cannot be checked against
    // the control total, and the progress register refuses a claim it cannot
    // reconcile — so asking for one would produce a draft nobody could confirm.
    prompt:
      'Report the permanent works visible in this photograph and how much of each has been built. For each ' +
      'item give a description, the unit it is properly measured in, the quantity visibly complete, and the ' +
      'basis on which you measured it — what you counted, and against what reference. State separately ' +
      'anything obstructed, out of frame or too far away to measure, and do not estimate it. Do not report a ' +
      'percentage complete unless the whole extent of the element is in the frame.',
    responseSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              unit: { type: 'string' },
              quantity: { type: 'number' },
              basisOfMeasurement: { type: 'string' },
            },
            required: ['description', 'unit', 'quantity', 'basisOfMeasurement'],
          },
        },
        location: { type: ['string', 'null'] },
        obstructed: { type: 'array', items: { type: 'string' } },
        viewpoint: { type: ['string', 'null'] },
      },
      required: ['items'],
    },
    usable: (extraction) =>
      Array.isArray(extraction.items) &&
      extraction.items.some((item) => Number((item as { quantity?: unknown }).quantity) > 0),
  },

  PPE_COMPLIANCE: {
    engine: 'RISK_SAFETY',
    taskType: 'ppe_compliance_from_image',
    area: 'SAFETY_RAMS',
    // What `logSafetyObservation` requires.
    code: 'C',
    label: 'Check PPE compliance in a site photograph',
    accepts: SITE_IMAGE,
    acceptsLabel: 'a site photograph',
    // Nobody is named. A model identifying an operative from a photograph is a
    // disciplinary allegation produced by a machine, and the platform's safety
    // log is not the place for one. Counts and items only; who was in the frame
    // is for the person who was there.
    prompt:
      'Report the personal protective equipment visible in this photograph. List the items being worn and, ' +
      'separately, each item that appears to be missing or incorrectly worn, with how many people it affects ' +
      'and what makes it visible. Do not identify or describe any individual. State whether the photograph ' +
      'shows anything that would need stopping immediately. Where the view is too poor to judge an item, say ' +
      'so rather than reporting it as compliant.',
    responseSchema: {
      type: 'object',
      properties: {
        compliant: { type: 'boolean' },
        ppeObserved: { type: 'array', items: { type: 'string' } },
        breaches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              item: { type: 'string' },
              description: { type: 'string' },
              peopleAffected: { type: ['number', 'null'] },
            },
            required: ['item', 'description'],
          },
        },
        notJudgeable: { type: 'array', items: { type: 'string' } },
        immediateRisk: { type: 'boolean' },
        location: { type: ['string', 'null'] },
        narrative: { type: 'string' },
      },
      required: ['compliant', 'narrative'],
    },
    usable: (extraction) =>
      typeof extraction.compliant === 'boolean' &&
      typeof extraction.narrative === 'string' &&
      extraction.narrative.trim().length > 0,
  },

  EQUIPMENT_RECOGNITION: {
    engine: 'RESOURCE_COST',
    taskType: 'equipment_recognition_from_image',
    area: 'FIELD_EXECUTION',
    // What `captureSiteObservation` requires.
    code: 'C',
    label: 'Identify plant and equipment in a site photograph',
    accepts: SITE_IMAGE,
    acceptsLabel: 'a site photograph',
    prompt:
      'Identify the plant and equipment visible in this photograph. For each, give what it is in plain terms, ' +
      'the count, any plate, fleet or hire number legible in the image, and whether it appears to be working, ' +
      'standing idle or laid up — with what in the photograph shows that. Do not report a make or model you ' +
      'cannot read from the image, and do not infer ownership or hire status.',
    responseSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              count: { type: 'number' },
              identifier: { type: ['string', 'null'] },
              state: { type: 'string', enum: ['WORKING', 'IDLE', 'LAID_UP', 'UNCLEAR'] },
              basis: { type: ['string', 'null'] },
            },
            required: ['description', 'count', 'state'],
          },
        },
        location: { type: ['string', 'null'] },
        narrative: { type: 'string' },
      },
      required: ['items'],
    },
    usable: (extraction) => Array.isArray(extraction.items) && extraction.items.length > 0,
  },

  DEFECT_DETECTION: {
    engine: 'BIM_TWIN',
    taskType: 'defect_detection_from_image',
    area: 'QUALITY_COMMISSIONING',
    // What `raiseNCR` requires.
    code: 'C',
    label: 'Find workmanship defects in a site photograph',
    accepts: SITE_IMAGE,
    acceptsLabel: 'a site photograph',
    // Severity is asked for in the register's own three words, because the
    // confirmed draft becomes an NCR and `raiseNCR` accepts nothing else. A
    // model returning "HIGH" would produce a draft that fails at confirmation.
    prompt:
      'Report defects in the completed work shown in this photograph. For each, describe what is wrong and ' +
      'which element it is in, classify it as MINOR, MAJOR or CRITICAL, name the standard, specification or ' +
      'tolerance it appears to breach, and propose the corrective action. Report only what is visible — do ' +
      'not infer a defect from an incomplete element, and say where the photograph shows work still in ' +
      'progress rather than finished.',
    responseSchema: {
      type: 'object',
      properties: {
        defects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              element: { type: ['string', 'null'] },
              severity: { type: 'string', enum: ['MINOR', 'MAJOR', 'CRITICAL'] },
              standardBreached: { type: ['string', 'null'] },
              proposedAction: { type: 'string' },
            },
            required: ['description', 'severity', 'proposedAction'],
          },
        },
        workInProgress: { type: 'array', items: { type: 'string' } },
        location: { type: ['string', 'null'] },
      },
      required: ['defects'],
    },
    usable: (extraction) => Array.isArray(extraction.defects) && extraction.defects.length > 0,
  },
};

export type PerceptionDraft = {
  id: string;
  task: PerceptionTask;
  evidenceHash: string;
  evidenceId: string;
  contentType: string;
  extraction: Record<string, unknown>;
  confidence: number | undefined;
  /**
   * Who read the file, stamped by `runAI` on every AI-written state.
   *
   * This was declared as `provider: string` and never written — the field was a
   * type that no code populated, so anything reading a draft to find out which
   * model produced it got `undefined`. `synthetic` is the one that matters to a
   * reader: it says no model was called and the answer is a deterministic
   * stand-in.
   */
  aiProvenance?: {
    provider: string;
    modelClass: string;
    engine: string;
    taskType: string;
    synthetic: boolean;
    at: string;
  };
  status: 'DRAFT' | 'CONFIRMED' | 'DISCARDED';
  producedAt: string;
  producedFor: string;
};

/**
 * Read a stored file and produce a draft.
 *
 * Everything that can refuse, refuses before anything is reserved or charged:
 * no such evidence record, no bytes held, wrong kind of file, file too large,
 * no provider that can see it. A caller who is going to be refused should not
 * pay for the privilege.
 */
export async function extract(
  ctx: EngineContext,
  store: EvidenceStore,
  input: { hash: string; task: PerceptionTask },
): Promise<{ draftId: string; task: PerceptionTask; extraction: Record<string, unknown>; confidence?: number; acuConsumed: number }> {
  const definition = PERCEPTION_TASKS[input.task];
  if (!definition) throw new DomainError('PERCEPTION_TASK_UNKNOWN', `No perception task "${input.task}"`);

  authorise(ctx, definition.area, definition.code, { lifecyclePhase: currentPhase(ctx) });

  const record = findByHash(ctx.ledger, ctx.tenantId, input.hash);
  if (!record) {
    throw new DomainError('PERCEPTION_EVIDENCE_UNKNOWN', 'No evidence record in this tenancy references that hash', 404);
  }

  if (!(await store.holds(ctx.tenantId, input.hash))) {
    // The distinction this whole feature turns on. The platform knows a file
    // with this hash was the evidence; it cannot read a file it does not hold.
    throw new DomainError(
      'PERCEPTION_FILE_NOT_HELD',
      'The platform holds the hash of this evidence but not the file. Supply the file before it can be read.',
      409,
    );
  }

  const file = await store.fetch(ctx.tenantId, input.hash);
  if (!definition.accepts.includes(file.contentType)) {
    throw new DomainError(
      'PERCEPTION_MEDIA_UNSUPPORTED',
      `${definition.label} needs ${definition.acceptsLabel}; this evidence is ${file.contentType}.`,
      415,
    );
  }
  if (file.bytes.length > config.ai.perceptionMaxBytes) {
    throw new DomainError(
      'PERCEPTION_FILE_TOO_LARGE',
      `A file over ${Math.round(config.ai.perceptionMaxBytes / 1_048_576)}MB cannot be sent to a provider in one request.`,
      413,
    );
  }

  // The honesty gate. An adapter that cannot be handed a file will answer
  // anyway — deterministically, confidently and fictionally — and that answer
  // would end up in the drawing register.
  const adapter = ctx.orchestrator.adapterFor('PERCEPTION');
  if (!adapter.multimodal) {
    throw new DomainError(
      'PERCEPTION_PROVIDER_UNAVAILABLE',
      'No provider configured on this deployment can read a file. ' +
        'Reading drawings and voice notes needs a multimodal provider; the local engines compute, they do not perceive.',
      503,
    );
  }

  const draftId = ulid();
  const result = await runAI(ctx, {
    engine: definition.engine,
    taskType: definition.taskType,
    capability: 'PERCEPTION',
    inputRefs: [{ refType: 'EvidenceItem', refId: record.refId }],
    request: {
      task: definition.prompt,
      // The hash travels in the payload as well as on the media, so the answer
      // is traceable to the exact bytes that produced it.
      payload: { evidenceHash: input.hash, contentType: file.contentType },
      responseSchema: definition.responseSchema,
      media: { contentType: file.contentType, base64: file.bytes.toString('base64'), hash: input.hash },
    },
    // The AI write is the draft and only the draft.
    toWrites: (output, confidence) => [
      {
        eventType: 'PERCEPTION_DRAFT_PRODUCED',
        entity: { refType: 'PerceptionDraft', refId: draftId },
        nextState: {
          id: draftId,
          projectId: ctx.projectId,
          task: input.task,
          evidenceHash: input.hash,
          evidenceId: record.refId,
          contentType: file.contentType,
          extraction: output,
          confidence,
          status: 'DRAFT',
          producedAt: new Date().toISOString(),
          producedFor: ctx.auth.actorId,
        },
        evidenceRefs: [{ refType: 'EvidenceItem', refId: record.refId }],
      },
    ],
  });

  if (!definition.usable(result.output)) {
    // The draft stays in the record — it was paid for, and what a model failed
    // to read is itself worth knowing. It simply cannot be confirmed.
    throw new DomainError(
      'PERCEPTION_NOT_LEGIBLE',
      `The provider could not read enough from this file to be worth confirming. Draft ${draftId} records what it returned.`,
      422,
    );
  }

  return {
    draftId,
    task: input.task,
    extraction: result.output,
    confidence: result.output.confidence as number | undefined,
    acuConsumed: result.acuConsumed,
  };
}

function requireDraft(ctx: EngineContext, draftId: string): PerceptionDraft {
  const record = ctx.ledger.get({ refType: 'PerceptionDraft', refId: draftId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('PERCEPTION_DRAFT_NOT_FOUND', `No perception draft ${draftId}`, 404);
  }
  const draft = record.state as unknown as PerceptionDraft;
  if (draft.status !== 'DRAFT') {
    throw new DomainError('PERCEPTION_DRAFT_SETTLED', `Draft ${draftId} was already ${draft.status.toLowerCase()}`, 409);
  }
  return draft;
}

/**
 * Confirm a draft, with corrections, and let the ordinary domain command run.
 *
 * `corrections` replaces fields rather than merging deeply: a person who edited
 * one line of a take-off is submitting the take-off they mean, and a merge would
 * leave them arguing with a model about a field they thought they had removed.
 *
 * The downstream command is the *same* one a person typing the values by hand
 * would run. It authorises again, gates on the phase again, and writes the same
 * events. Machine-read data gets no private door into the register.
 */
export type ConfirmInput = {
  draftId: string;
  corrections?: Record<string, unknown>;
  /** DRAWING_TAKEOFF. */
  packageId?: string;
  costCodePrefix?: string;
  /** VOICE_NOTE, EQUIPMENT_RECOGNITION. */
  observedBy?: string;
  actionByDate?: string;
  /** EQUIPMENT_RECOGNITION — which of the platform's observation categories. */
  category?: string;
  /**
   * PROGRESS_FROM_IMAGES. None of these is visible in a photograph, so none is
   * asked of the model: the activity the claim is against, the period it falls
   * in, and which of the read items is being claimed.
   */
  taskId?: string;
  periodFrom?: string;
  periodTo?: string;
  costCode?: string;
  itemIndex?: number;
  rework?: boolean;
  /** PPE_COMPLIANCE — overrides the mapping from the model's own reading. */
  observationType?: 'UNSAFE_ACT' | 'UNSAFE_CONDITION' | 'NEAR_MISS' | 'GOOD_PRACTICE';
  /** DEFECT_DETECTION. */
  workPackageId?: string;
  inspectionId?: string;
};

export async function confirm(
  ctx: EngineContext,
  input: ConfirmInput,
): Promise<{ draftId: string; task: PerceptionTask; result: Record<string, unknown> }> {
  const draft = requireDraft(ctx, input.draftId);
  const definition = PERCEPTION_TASKS[draft.task];
  authorise(ctx, definition.area, definition.code, { lifecyclePhase: currentPhase(ctx) });

  const extraction = { ...draft.extraction, ...(input.corrections ?? {}) };
  let result: Record<string, unknown>;

  if (draft.task === 'TITLE_BLOCK') {
    const registered = await registerDrawing(ctx, {
      fileHash: draft.evidenceHash,
      titleBlock: {
        drawingNumber: String(extraction.drawingNumber ?? ''),
        title: String(extraction.title ?? ''),
        revision: String(extraction.revision ?? ''),
        discipline: String(extraction.discipline ?? ''),
        drawnBy: extraction.drawnBy ? String(extraction.drawnBy) : undefined,
        checkedBy: extraction.checkedBy ? String(extraction.checkedBy) : undefined,
        issueDate: extraction.issueDate ? String(extraction.issueDate) : undefined,
        status: extraction.status ? String(extraction.status) : undefined,
      },
    });
    result = { drawingId: registered.drawingId, supersededId: registered.supersededId, titleBlock: registered.titleBlock };
  } else if (draft.task === 'DRAWING_TAKEOFF') {
    if (!input.packageId || !input.costCodePrefix) {
      throw new DomainError(
        'PERCEPTION_TARGET_REQUIRED',
        'A confirmed take-off has to be filed against a package, under a cost code prefix.',
      );
    }
    const items = (extraction.items as Array<Record<string, unknown>>).map((item) => ({
      description: String(item.description ?? ''),
      unit: String(item.unit ?? ''),
      quantity: Number(item.quantity ?? 0),
      sourceSheet: item.sourceSheet ? String(item.sourceSheet) : undefined,
      measurementRule: item.measurementRule ? String(item.measurementRule) : undefined,
    }));
    const takeoff = await runTakeoff(ctx, {
      packageId: input.packageId,
      // The drawing itself is the source, named by the hash the draft was read
      // from — which is what makes the quantity traceable to a sheet rather
      // than to somebody's spreadsheet.
      sources: [{ discipline: String(extraction.discipline ?? 'GENERAL'), sheetId: draft.evidenceHash }],
      items,
      costCodePrefix: input.costCodePrefix,
    });
    result = { takeoffId: takeoff.takeoffId, boqItemIds: takeoff.boqItemIds };
  } else if (draft.task === 'VOICE_NOTE') {
    // The model's category is checked against the platform's own list before it
    // reaches a command that would refuse it. A person confirming a transcript
    // should be told which value to correct, not shown a schema error.
    const category = String(extraction.category ?? '');
    if (!values(SITE_OBSERVATION_CATEGORY).includes(category)) {
      throw new DomainError(
        'PERCEPTION_CATEGORY_INVALID',
        `"${category}" is not an observation category. Correct it to one of ${values(SITE_OBSERVATION_CATEGORY).join(', ')}.`,
      );
    }

    const observation = captureSiteObservation(ctx, {
      category: category as Parameters<typeof captureSiteObservation>[1]['category'],
      description: String(extraction.transcript ?? ''),
      location: String(extraction.location ?? 'Not stated in the recording'),
      // The person confirming, not the model. A transcript naming somebody is
      // not that person recording an observation.
      observedBy: input.observedBy ?? ctx.auth.actorId,
      requiresAction: extraction.requiresAction === true,
      actionOwner: extraction.actionOwner ? String(extraction.actionOwner) : undefined,
      // The register requires a date on anything that requires action, and it
      // was never passed: a voice note the model read as actionable could not be
      // confirmed at all without first correcting `requiresAction` to false —
      // which is the confirmer overwriting what the speaker said in order to
      // file it. The date is the confirmer's, because a deadline is not audible.
      actionByDate: input.actionByDate,
      evidenceHash: draft.evidenceHash,
    });
    result = { observationId: observation.observationId, reference: observation.reference };
  } else if (draft.task === 'PROGRESS_FROM_IMAGES') {
    if (!input.taskId || !input.periodFrom || !input.periodTo) {
      throw new DomainError(
        'PERCEPTION_TARGET_REQUIRED',
        'A progress claim read from a photograph still has to name the activity it is against and the period it ' +
          'falls in. Neither is visible in an image, and a claim without them cannot be valued.',
      );
    }

    const items = (extraction.items as Array<Record<string, unknown>> | undefined) ?? [];
    const index = input.itemIndex ?? 0;
    const item = items[index];
    if (!item) {
      throw new DomainError(
        'PERCEPTION_ITEM_UNKNOWN',
        `The draft read ${items.length} measurable item${items.length === 1 ? '' : 's'} from this photograph; there is ` +
          `no item ${index}. One claim is made against one activity, so say which item is being claimed.`,
      );
    }

    // The unit and the control total are the progress register's own rules and
    // they run unchanged here — a quantity a model read is checked against the
    // measurement basis exactly as a quantity somebody typed would be.
    const submitted = submitProgress(ctx, {
      taskId: input.taskId,
      quantity: Number(item.quantity ?? 0),
      unit: String(item.unit ?? ''),
      location: String(extraction.location ?? item.description ?? ''),
      periodFrom: input.periodFrom,
      periodTo: input.periodTo,
      costCode: input.costCode,
      rework: input.rework,
      evidenceDescription: `Progress read from site photography: ${String(item.description ?? '')}`.slice(0, 200),
      evidenceHash: draft.evidenceHash,
    });

    // Written against the submission, beside `PROGRESS_REPORTED`. The claim and
    // the provenance of the claim are two facts, and only one of them is in the
    // submission.
    //
    // The submission's own state is carried forward rather than replaced. An
    // event names an entity and the ledger holds one state per entity, so
    // writing the provenance alone here would have overwritten the claim with a
    // record of where the claim came from — deleting the quantity a valuation
    // is built on.
    const submission = ctx.ledger.require({ refType: 'ProgressSubmission', refId: submitted.submissionId });
    write(ctx, {
      eventType: 'PROGRESS_EXTRACTED_FROM_IMAGES',
      entity: { refType: 'ProgressSubmission', refId: submitted.submissionId },
      nextState: {
        ...submission.state,
        extractedFromImages: {
          draftId: draft.id,
          evidenceHash: draft.evidenceHash,
          provider: draft.aiProvenance?.provider,
          // Said out loud rather than inferred from a provider name: a claim
          // whose quantity came from the local stand-in is not a claim anybody
          // should value.
          synthetic: draft.aiProvenance?.synthetic === true,
          confidence: draft.confidence,
          readQuantity: Number(item.quantity ?? 0),
          readUnit: String(item.unit ?? ''),
          basisOfMeasurement: String(item.basisOfMeasurement ?? ''),
          // What the model said it could not see. A claim argued over later is
          // answered as much by this as by the quantity.
          obstructed: Array.isArray(extraction.obstructed) ? extraction.obstructed : [],
          corrections: input.corrections ?? {},
          confirmedBy: ctx.auth.actorId,
          confirmedAt: new Date().toISOString(),
        },
      },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: draft.evidenceId }],
    });

    result = {
      submissionId: submitted.submissionId,
      reference: submitted.reference,
      cumulativeIfAccepted: submitted.cumulativeIfAccepted,
      exceedsControlTotal: submitted.exceedsControlTotal,
    };
  } else if (draft.task === 'PPE_COMPLIANCE') {
    const breaches = (extraction.breaches as Array<Record<string, unknown>> | undefined) ?? [];
    const compliant = extraction.compliant === true && breaches.length === 0;

    const observation = await logSafetyObservation(ctx, {
      description: String(extraction.narrative ?? ''),
      location: String(extraction.location ?? 'Not stated'),
      mediaHash: draft.evidenceHash,
      // Somebody not wearing what the method statement requires is an act, not a
      // condition — the distinction the safety log is analysed on. The confirmer
      // may say otherwise; they were there.
      observationType: input.observationType ?? (compliant ? 'GOOD_PRACTICE' : 'UNSAFE_ACT'),
      // The person confirming. Nobody in the photograph is named by anything
      // here, including this field.
      reportedBy: input.observedBy ?? ctx.auth.actorId,
    });

    result = {
      observationId: observation.observationId,
      severity: observation.severity,
      compliant,
      breaches: breaches.length,
      acuConsumed: observation.acuConsumed,
    };
  } else if (draft.task === 'EQUIPMENT_RECOGNITION') {
    const items = (extraction.items as Array<Record<string, unknown>> | undefined) ?? [];
    // There is no plant register on this platform, so this does not pretend to
    // update one. What plant was on site, working or standing, is a site
    // observation — the same record a walker makes by hand.
    const category = input.category ?? 'PROGRESS';
    if (!values(SITE_OBSERVATION_CATEGORY).includes(category)) {
      throw new DomainError(
        'PERCEPTION_CATEGORY_INVALID',
        `"${category}" is not an observation category. Use one of ${values(SITE_OBSERVATION_CATEGORY).join(', ')}.`,
      );
    }

    const lines = items.map((item) => {
      const identifier = item.identifier ? ` (${String(item.identifier)})` : '';
      return `${Number(item.count ?? 1)} × ${String(item.description ?? 'unidentified plant')}${identifier} — ${String(item.state ?? 'UNCLEAR')}`;
    });

    const observation = captureSiteObservation(ctx, {
      category: category as Parameters<typeof captureSiteObservation>[1]['category'],
      description: `Plant and equipment read from site photography: ${lines.join('; ')}`,
      location: String(extraction.location ?? 'Not stated'),
      observedBy: input.observedBy ?? ctx.auth.actorId,
      // Standing plant costs money whether or not anybody logs it, but a
      // photograph is not an instruction. Whether it needs acting on is the
      // confirmer's judgement, expressed by supplying an owner and a date.
      requiresAction: Boolean(input.actionByDate),
      actionOwner: input.actionByDate ? (input.observedBy ?? ctx.auth.actorId) : undefined,
      actionByDate: input.actionByDate,
      evidenceHash: draft.evidenceHash,
    });

    result = {
      observationId: observation.observationId,
      reference: observation.reference,
      itemsRecorded: items.length,
      idle: items.filter((item) => item.state === 'IDLE' || item.state === 'LAID_UP').length,
    };
  } else {
    const defects = (extraction.defects as Array<Record<string, unknown>> | undefined) ?? [];
    if (defects.length === 0) {
      throw new DomainError('PERCEPTION_NOTHING_TO_RAISE', 'The corrected draft records no defect, so there is nothing to raise.');
    }

    // One NCR per defect, not one per photograph. Each is closed out separately,
    // against its own corrective action, and a single record covering three
    // faults cannot be closed when two of them are fixed.
    const raised = defects.map((defect, position) => {
      const severity = String(defect.severity ?? '');
      if (severity !== 'MINOR' && severity !== 'MAJOR' && severity !== 'CRITICAL') {
        throw new DomainError(
          'PERCEPTION_SEVERITY_INVALID',
          `Defect ${position + 1} is classified "${severity}". The register records MINOR, MAJOR or CRITICAL — correct it before confirming.`,
        );
      }
      const element = defect.element ? `${String(defect.element)}: ` : '';
      const standard = defect.standardBreached ? ` Against ${String(defect.standardBreached)}.` : '';
      const ncr = raiseNCR(ctx, {
        description: `${element}${String(defect.description ?? '')}${standard}`,
        severity,
        proposedAction: String(defect.proposedAction ?? ''),
        inspectionId: input.inspectionId,
        workPackageId: input.workPackageId,
        evidenceHash: draft.evidenceHash,
      });
      return { ncrId: ncr.ncrId, reference: ncr.reference, severity };
    });

    result = { ncrs: raised, raised: raised.length };
  }

  write(ctx, {
    eventType: 'PERCEPTION_DRAFT_CONFIRMED',
    entity: { refType: 'PerceptionDraft', refId: draft.id },
    nextState: {
      ...draft,
      extraction,
      status: 'CONFIRMED',
      // What the person changed, kept separately from what the model returned.
      // A take-off argued over in three years is answered by this field.
      corrections: input.corrections ?? {},
      confirmedBy: ctx.auth.actorId,
      confirmedAt: new Date().toISOString(),
      result,
    },
    evidenceRefs: [{ refType: 'EvidenceItem', refId: draft.evidenceId }],
  });

  return { draftId: draft.id, task: draft.task, result };
}

/** Discard a draft, saying why. The record of what the model read is kept. */
export function discard(ctx: EngineContext, input: { draftId: string; reason: string }): { draftId: string } {
  const draft = requireDraft(ctx, input.draftId);
  const definition = PERCEPTION_TASKS[draft.task];
  // Rejecting is deciding, so it takes the same authority as accepting.
  authorise(ctx, definition.area, definition.code, { lifecyclePhase: currentPhase(ctx) });

  if (input.reason.trim().length < 4) {
    throw new DomainError('PERCEPTION_REASON_REQUIRED', 'Say why the extraction was rejected');
  }

  write(ctx, {
    eventType: 'PERCEPTION_DRAFT_DISCARDED',
    entity: { refType: 'PerceptionDraft', refId: draft.id },
    nextState: {
      ...draft,
      status: 'DISCARDED',
      discardReason: input.reason,
      discardedBy: ctx.auth.actorId,
      discardedAt: new Date().toISOString(),
    },
    evidenceRefs: [{ refType: 'EvidenceItem', refId: draft.evidenceId }],
  });

  return { draftId: draft.id };
}

/** Every draft in a project, newest first. */
export function drafts(ctx: EngineContext): PerceptionDraft[] {
  return ctx.ledger
    .list(ctx.projectId, 'PerceptionDraft')
    .map((record) => record.state as unknown as PerceptionDraft)
    .sort((a, b) => (a.producedAt < b.producedAt ? 1 : -1));
}

/**
 * What this deployment can actually read, and what it would refuse.
 *
 * Published so the console can say "no provider here can read a drawing" at the
 * point of the control rather than after somebody has tried, and so the reason
 * is the platform's own rather than a message the browser invented.
 */
export function perceptionCapability(ctx: EngineContext): {
  available: boolean;
  reason?: string;
  tasks: Array<{
    task: PerceptionTask;
    label: string;
    accepts: string[];
    acceptsLabel: string;
    area: CapabilityArea;
    code: PermissionCode;
  }>;
} {
  let available = false;
  let reason: string | undefined;
  try {
    available = ctx.orchestrator.adapterFor('PERCEPTION').multimodal;
    if (!available) {
      reason = 'The provider configured for perception on this deployment computes rather than perceives — it cannot be shown a file.';
    }
  } catch {
    reason = 'No healthy perception provider is available.';
  }

  return {
    available,
    reason,
    tasks: Object.entries(PERCEPTION_TASKS).map(([task, definition]) => ({
      task: task as PerceptionTask,
      label: definition.label,
      accepts: definition.accepts,
      acceptsLabel: definition.acceptsLabel,
      // Published so a screen can hide a control the reader could never use,
      // rather than offering it and explaining the refusal afterwards.
      area: definition.area,
      code: definition.code,
    })),
  };
}
