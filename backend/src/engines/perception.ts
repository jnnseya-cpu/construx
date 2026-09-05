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
import { analyseITT, type CommercialTerms, type ITTRequirement } from '../domain/itt.ts';
import { BRIEF_ITEMS, recordFact } from '../domain/etablix/brief.ts';
import { requireModule } from '../identity/modules.ts';
import { extractRequirements, type SubmissionChannel } from '../domain/tenderintake.ts';
import { recordModelReading } from '../evidence/pipeline.ts';

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
  | 'ITT_REQUIREMENTS'
  | 'VOICE_NOTE'
  | 'PROGRESS_FROM_IMAGES'
  | 'PPE_COMPLIANCE'
  | 'EQUIPMENT_RECOGNITION'
  | 'DEFECT_DETECTION'
  | 'GROUND_MATERIAL'
  | 'SITE_SERVICES_BRIEF'
  | 'DOCUMENT_TEXT';

type TaskDefinition = {
  engine: Engine;
  /** A module the tenancy must hold, where the downstream command is gated by one. */
  module?: 'ETABLIX';
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

  GROUND_MATERIAL: {
    engine: 'BIM_TWIN',
    taskType: 'ground_material_from_photograph',
    area: 'LOOKAHEAD_CONSTRAINTS',
    // What placing a zone on the site model requires. Classifying the ground is
    // an input to that decision, so it takes the same authority.
    code: 'C',
    label: 'Read what the ground is made of',
    accepts: SITE_IMAGE,
    acceptsLabel: 'a site photograph',
    // The half of the site-capture specification that geometry cannot answer.
    // `domain/segmentation.ts` classifies the *shape* of the ground exactly and
    // says on every region that it read form and not material. This is the
    // other half, and it is genuinely a vision problem: a 2% plane is level
    // ground whether it is tarmac, hardcore or wet clay, and what it is made of
    // decides whether a crane can stand on it.
    prompt:
      'Report what the ground surface in this photograph is made of. For each distinct surface visible, give ' +
      'the material, roughly what share of the frame it occupies, and whether it appears trafficable by ' +
      'tracked plant, by wheeled plant, or by neither. Report standing water, soft or rutted ground, and ' +
      'vegetation separately where present. Do not estimate bearing capacity, and do not report a material ' +
      'you cannot see — an area you are unsure of is reported as UNCERTAIN rather than guessed.',
    responseSchema: {
      type: 'object',
      properties: {
        surfaces: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              material: {
                type: 'string',
                enum: [
                  'HARDSTANDING',
                  'COMPACTED_GRANULAR',
                  'ASPHALT',
                  'CONCRETE',
                  'SOFT_GROUND',
                  'CLAY',
                  'TOPSOIL',
                  'VEGETATION',
                  'STANDING_WATER',
                  'RUTTED_OR_CHURNED',
                  'UNCERTAIN',
                ],
              },
              sharePercent: { type: 'number' },
              trafficable: { type: 'string', enum: ['TRACKED', 'WHEELED', 'NEITHER', 'UNCERTAIN'] },
              note: { type: ['string', 'null'] },
            },
            required: ['material', 'sharePercent', 'trafficable'],
          },
        },
        // Said by the model rather than assumed by the platform: a photograph
        // taken into the sun or at dusk is not a classification.
        conditionsLimiting: { type: ['string', 'null'] },
      },
      required: ['surfaces'],
    },
    // A classification with no surface in it is not one. It stays on the record
    // as a draft — it was paid for — and cannot be confirmed.
    usable: (extraction) => Array.isArray(extraction.surfaces) && extraction.surfaces.length > 0,
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

  /**
   * Read the invitation to tender itself.
   *
   * The take-off above measures the drawings that come *with* an ITT. This
   * reads the document that sent them — and until it existed the platform
   * could analyse an invitation it had never seen: `analyseITT` takes a
   * requirement list as an argument, so somebody had to sit and type out
   * ninety numbered clauses before the compliance matrix could say anything
   * about them. That is the half-day of work the bid team actually loses, and
   * it is the half where things get missed, because the requirement nobody
   * typed is the requirement nobody answers.
   *
   * Two properties this keeps, and both are the reason it is a perception task
   * rather than a new command.
   *
   * **The model reads; it does not judge.** Requirements come back as the
   * document states them — reference, category, mandatory or scored, the
   * evidence demanded, the date. Whether the business can meet one is
   * `analyseITT`'s answer, from the company profile, and whether to chase the
   * job at all is the bid/no-bid algorithm's. Asking one model to do all three
   * would produce a confident recommendation with no working behind it.
   *
   * **What the document does not state is not invented.** An ITT names its
   * return date and its contract form; it does not name what this business
   * expects to price the job at, or the margin it needs. Those are commercial
   * judgement and they are supplied by the person confirming — the same
   * division `VOICE_NOTE` draws when it refuses to let a transcript name its
   * own observer.
   */
  ITT_REQUIREMENTS: {
    engine: 'TENDER',
    taskType: 'itt_requirement_extraction',
    area: 'ESTIMATE_TENDER',
    // What `analyseITT` requires.
    code: 'C',
    label: 'Read an invitation to tender',
    accepts: IMAGE_OR_PDF,
    acceptsLabel: 'the invitation as a PDF or scan',
    prompt:
      'Read this invitation to tender. Report its reference, the client, and the return deadline exactly as ' +
      'stated. List every requirement the bidder must satisfy, each with its own reference from the document, ' +
      'its category, whether it is mandatory (pass/fail) or scored, its weighting where one is given, the ' +
      'evidence demanded, and any date earlier than the return. Separately list every deliverable that must be ' +
      'returned, with its format, page limit, whether a signature or bond is required, and the channel it goes ' +
      'back through. Report the commercial terms it states — contract form, liquidated damages, bond, ' +
      'retention, payment period, design liability. Quote the document rather than summarising it, and omit ' +
      'anything it does not state rather than inferring it; list what you omitted and why.',
    responseSchema: {
      type: 'object',
      properties: {
        reference: { type: ['string', 'null'] },
        clientName: { type: ['string', 'null'] },
        returnBy: { type: ['string', 'null'] },
        requirements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reference: { type: 'string' },
              category: {
                type: 'string',
                enum: [
                  'QUALIFICATION',
                  'TECHNICAL',
                  'COMMERCIAL',
                  'INSURANCE',
                  'HEALTH_AND_SAFETY',
                  'QUALITY',
                  'ENVIRONMENTAL',
                  'SOCIAL_VALUE',
                  'PROGRAMME',
                  'SUBMISSION',
                ],
              },
              requirement: { type: 'string' },
              mandatory: { type: 'boolean' },
              weightingPercent: { type: ['number', 'null'] },
              evidenceRequired: { type: 'string' },
              dueBy: { type: ['string', 'null'] },
            },
            required: ['reference', 'category', 'requirement', 'mandatory', 'evidenceRequired'],
          },
        },
        deliverables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reference: { type: 'string' },
              title: { type: 'string' },
              mandatory: { type: 'boolean' },
              format: { type: ['string', 'null'] },
              pageLimit: { type: ['number', 'null'] },
              fileSizeLimitMb: { type: ['number', 'null'] },
              signatureRequired: { type: ['boolean', 'null'] },
              bondRequired: { type: ['boolean', 'null'] },
              channel: { type: ['string', 'null'], enum: ['PORTAL', 'EMAIL', 'PHYSICAL', 'HAND_DELIVERY', null] },
            },
            required: ['reference', 'title', 'mandatory'],
          },
        },
        terms: {
          type: 'object',
          properties: {
            contractForm: { type: ['string', 'null'] },
            liquidatedDamagesPerWeekMinor: { type: ['number', 'null'] },
            liquidatedDamagesCapPercent: { type: ['number', 'null'] },
            performanceBondPercent: { type: ['number', 'null'] },
            parentCompanyGuaranteeRequired: { type: ['boolean', 'null'] },
            retentionPercent: { type: ['number', 'null'] },
            paymentDays: { type: ['number', 'null'] },
            designLiability: {
              type: ['string', 'null'],
              enum: ['NONE', 'REASONABLE_SKILL_AND_CARE', 'FITNESS_FOR_PURPOSE', null],
            },
            sectionalCompletions: { type: ['number', 'null'] },
            other: { type: 'array', items: { type: 'string' } },
          },
        },
        omitted: { type: 'array', items: { type: 'string' } },
      },
      required: ['requirements'],
    },
    // An invitation with no requirements has not been read. The same guard
    // `analyseITT` applies, applied before anything is shown to anybody.
    usable: (extraction) => Array.isArray(extraction.requirements) && extraction.requirements.length > 0,
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

  /**
   * ETABLIX §3 — the brief register read from a customer's document.
   *
   * A workforce curve, a welfare schedule or a compound layout carries the
   * facts a site-services system is designed from, and until this task existed
   * every one of them was typed in by hand. The model reports each fact it can
   * find with the words it read it from; nothing reaches the register until a
   * person confirms the draft, and what does reach it goes through `recordFact`
   * with the document, the provider and the confirmer all on the source. §19.10:
   * a reading below the threshold sits on the draft list with its provenance,
   * and the baseline is unchanged.
   *
   * The risk and safety adviser, because welfare provision is a CDM Schedule 2
   * duty and that engine is the one in contract in every phase a site-services
   * appointment can begin in.
   */
  SITE_SERVICES_BRIEF: {
    engine: 'RISK_SAFETY',
    module: 'ETABLIX',
    taskType: 'site_services_brief_extraction',
    area: 'SITE_SERVICES',
    // What `recordFact` requires.
    code: 'C',
    label: 'Read a site-services brief',
    accepts: IMAGE_OR_PDF,
    acceptsLabel: 'a workforce curve, welfare schedule or compound layout as a PDF or scan',
    prompt:
      'Read this document for the facts a site-services brief needs. The items, with their units, are: ' +
      BRIEF_ITEMS.map((item) => `${item.id} — ${item.label} (${item.unit})`).join('; ') +
      '. Report every item the document states, as a number in the unit given (or the text where the item is ' +
      'not numeric), with the exact words or figure it was read from and the page. Report nothing the document ' +
      'does not state — never infer, average or complete a figure — and list separately what you looked for and ' +
      'could not find.',
    responseSchema: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string', enum: BRIEF_ITEMS.map((item) => item.id) },
              value: { type: ['number', 'string'] },
              quoted: { type: 'string' },
              page: { type: ['number', 'null'] },
            },
            required: ['itemId', 'value', 'quoted'],
          },
        },
        omitted: { type: 'array', items: { type: 'string' } },
      },
      required: ['facts'],
    },
    usable: (extraction) =>
      Array.isArray(extraction.facts) &&
      extraction.facts.some((fact) => BRIEF_ITEMS.some((item) => item.id === String((fact as Record<string, unknown>).itemId))),
  },

  /**
   * Optical character recognition, as the perception pipeline's plainest task.
   *
   * Ingestion reads a PDF's own text layer without a model; a scan has none,
   * and a photograph of a page never did. For those the ingestion record says
   * `NEEDS_OCR` and stops — until this task, that was the end of the road on
   * every deployment, and with a multimodal provider it was still a road with
   * no door. The model transcribes; a person confirms; confirming writes the
   * same `FILE_EXTRACTED` event a native read writes, so the text is indexed
   * and searchable exactly as if the bytes had carried it.
   *
   * The board reporter's engine, because a document can arrive in any phase
   * and that is the one in contract in every phase. Transcription belongs to
   * no discipline.
   */
  DOCUMENT_TEXT: {
    engine: 'EXECUTIVE',
    taskType: 'document_text_transcription',
    area: 'EVIDENCE_AUDIT',
    // What `recordModelReading` requires — the same authority as ingestion.
    code: 'I',
    label: 'Transcribe a scanned document',
    accepts: IMAGE_OR_PDF,
    acceptsLabel: 'a scanned PDF or a photograph of a page',
    prompt:
      'Transcribe every legible word on this document, page by page, in reading order, preserving line breaks and ' +
      'the wording exactly as printed — including reference numbers, dates, units and figures. Mark a word or ' +
      'passage you cannot read as [illegible] rather than guessing at it. Do not summarise, correct, translate or ' +
      'complete anything. Report the language the document is written in.',
    responseSchema: {
      type: 'object',
      properties: {
        pages: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              page: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['page', 'text'],
          },
        },
        language: { type: ['string', 'null'] },
        illegiblePassages: { type: ['number', 'null'] },
      },
      required: ['pages'],
    },
    usable: (extraction) =>
      Array.isArray(extraction.pages) &&
      extraction.pages.some((page) => String((page as Record<string, unknown>).text ?? '').trim() !== ''),
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

  if (definition.module) requireModule(ctx.grantedModules, definition.module);
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
  /**
   * ITT_REQUIREMENTS — the invitation this reading belongs to, and the two
   * commercial figures no invitation states about the bidder.
   */
  invitationId?: string;
  estimatedValueMinor?: number;
  durationWeeks?: number;
  targetMarginPercent?: number;
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
  if (definition.module) requireModule(ctx.grantedModules, definition.module);
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
  } else if (draft.task === 'ITT_REQUIREMENTS') {
    if (!input.invitationId || input.estimatedValueMinor === undefined || input.durationWeeks === undefined) {
      throw new DomainError(
        'PERCEPTION_TARGET_REQUIRED',
        'A read invitation is filed against the invitation it came from, and needs the value this business ' +
          'expects to price and the duration it is priced over. Neither is stated in an ITT about the bidder, ' +
          'so neither is read from one.',
      );
    }

    const read = extraction as {
      reference?: unknown;
      clientName?: unknown;
      returnBy?: unknown;
      requirements?: Array<Record<string, unknown>>;
      deliverables?: Array<Record<string, unknown>>;
      terms?: Record<string, unknown>;
    };

    const requirements = (read.requirements ?? []).map((requirement) => ({
      reference: String(requirement.reference ?? ''),
      category: String(requirement.category ?? 'SUBMISSION') as ITTRequirement['category'],
      requirement: String(requirement.requirement ?? ''),
      mandatory: requirement.mandatory === true,
      ...(requirement.weightingPercent != null ? { weightingPercent: Number(requirement.weightingPercent) } : {}),
      evidenceRequired: String(requirement.evidenceRequired ?? ''),
      ...(requirement.dueBy ? { dueBy: String(requirement.dueBy) } : {}),
    }));

    const terms = read.terms ?? {};
    const commercial: CommercialTerms = {
      contractForm: String(terms.contractForm ?? 'Not stated in the invitation'),
      ...(terms.liquidatedDamagesPerWeekMinor != null
        ? {
            liquidatedDamages: {
              perWeekMinor: Number(terms.liquidatedDamagesPerWeekMinor),
              ...(terms.liquidatedDamagesCapPercent != null
                ? { capPercent: Number(terms.liquidatedDamagesCapPercent) }
                : {}),
            },
          }
        : {}),
      ...(terms.performanceBondPercent != null ? { performanceBondPercent: Number(terms.performanceBondPercent) } : {}),
      ...(terms.parentCompanyGuaranteeRequired != null
        ? { parentCompanyGuaranteeRequired: terms.parentCompanyGuaranteeRequired === true }
        : {}),
      ...(terms.retentionPercent != null ? { retentionPercent: Number(terms.retentionPercent) } : {}),
      ...(terms.paymentDays != null ? { paymentDays: Number(terms.paymentDays) } : {}),
      ...(terms.designLiability ? { designLiability: String(terms.designLiability) as CommercialTerms['designLiability'] } : {}),
      ...(terms.sectionalCompletions != null ? { sectionalCompletions: Number(terms.sectionalCompletions) } : {}),
      ...(Array.isArray(terms.other) ? { other: terms.other.map(String) } : {}),
    };

    // The analyst, exactly as a person typing the requirements in would reach
    // it — same authorisation, same ACU cost, same tests. The reading is what
    // changed; nothing about how a matrix is produced did.
    const analysis = analyseITT(ctx, {
      // The invitation's own reference when the document did not state one
      // legibly. It is the same record either way, so the matrix binds to it.
      reference: String(
        read.reference ??
          ctx.ledger.require({ refType: 'TenderInvitation', refId: input.invitationId }).state.reference ??
          '',
      ),
      clientName: String(read.clientName ?? 'Not stated in the invitation'),
      returnBy: String(read.returnBy ?? ''),
      estimatedValueMinor: input.estimatedValueMinor,
      durationWeeks: input.durationWeeks,
      requirements,
      terms: commercial,
      ...(input.targetMarginPercent !== undefined ? { targetMarginPercent: input.targetMarginPercent } : {}),
    });

    // Bind the deliverables and the matrix to the invitation. `extractRequirements`
    // is what raises the conflict where a deliverable's own date falls after the
    // return — which is the kind of thing a reader skims past and a register does
    // not.
    const deliverables = (read.deliverables ?? []).map((deliverable) => ({
      reference: String(deliverable.reference ?? ''),
      title: String(deliverable.title ?? ''),
      mandatory: deliverable.mandatory === true,
      ...(deliverable.format ? { format: String(deliverable.format) } : {}),
      ...(deliverable.pageLimit != null ? { pageLimit: Number(deliverable.pageLimit) } : {}),
      ...(deliverable.fileSizeLimitMb != null ? { fileSizeLimitMb: Number(deliverable.fileSizeLimitMb) } : {}),
      ...(deliverable.signatureRequired != null ? { signatureRequired: deliverable.signatureRequired === true } : {}),
      ...(deliverable.bondRequired != null ? { bondRequired: deliverable.bondRequired === true } : {}),
      ...(deliverable.channel ? { channel: String(deliverable.channel) as SubmissionChannel } : {}),
    }));

    const extracted =
      deliverables.length > 0
        ? extractRequirements(ctx, input.invitationId, { deliverables, analysisId: analysis.analysisId })
        : undefined;

    result = {
      analysisId: analysis.analysisId,
      requirements: requirements.length,
      deliverables: extracted?.deliverables ?? 0,
      // Named rather than counted. A mandatory requirement with no evidence
      // behind it ends the bid, and a barred term ends it before pricing
      // starts — those are the first two things a bid manager asks, so the
      // confirmation answers them rather than reporting that a matrix exists.
      mandatoryGaps: analysis.mandatoryGaps.map((line) => line.reference),
      bars: analysis.bars,
      quantifiedExposureMinor: analysis.quantifiedExposureMinor,
      clarifications: analysis.clarifications,
      readyToPrice: analysis.readyToPrice,
      blockers: extracted?.blockers ?? [],
    };
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
    // What plant was on site, working or standing, is a site observation —
    // the same record a walker makes by hand. The plant register
    // (`domain/plant.ts`) reads these observations as sightings of the items
    // on hire, matched by description; it is not updated here directly,
    // because a photograph says what was seen and not what was hired.
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
  } else if (draft.task === 'SITE_SERVICES_BRIEF') {
    const known = new Set<string>(BRIEF_ITEMS.map((item) => item.id));
    const read = ((extraction.facts as Array<Record<string, unknown>> | undefined) ?? []).filter((fact) => known.has(String(fact.itemId)));
    if (read.length === 0) {
      throw new DomainError(
        'PERCEPTION_NOTHING_TO_RECORD',
        'The corrected draft names no brief item the catalogue knows, so there is nothing to record.',
      );
    }
    const document = String(
      ctx.ledger.get({ refType: 'EvidenceItem', refId: draft.evidenceId })?.state.description ?? 'Document',
    );
    const provider = draft.aiProvenance?.provider ?? 'the perception provider';
    // Each fact goes through the same command a person typing it would use,
    // and the source it carries is the whole provenance: which document, which
    // page, which model read it, who confirmed it, and the words it came from.
    const recorded = read.map((fact) => {
      const value = typeof fact.value === 'number' ? fact.value : String(fact.value ?? '');
      const page = fact.page != null ? `, page ${Number(fact.page)}` : '';
      const quoted = fact.quoted ? ` — "${String(fact.quoted)}"` : '';
      const written = recordFact(ctx, {
        itemId: String(fact.itemId),
        value,
        source: `${document} (evidence ${draft.evidenceHash.slice(0, 16)}${page}), read by ${provider} and confirmed by ${ctx.auth.actorId}${quoted}`,
      });
      return { itemId: written.itemId, value: written.value, factId: written.id };
    });
    result = {
      facts: recorded,
      recorded: recorded.length,
      omitted: Array.isArray(extraction.omitted) ? (extraction.omitted as unknown[]).map(String) : [],
    };
  } else if (draft.task === 'DOCUMENT_TEXT') {
    const pages = ((extraction.pages as Array<Record<string, unknown>> | undefined) ?? [])
      .map((page, index) => ({ page: Number(page.page ?? index + 1), text: String(page.text ?? '') }))
      .filter((page) => page.text.trim() !== '');
    if (pages.length === 0) {
      throw new DomainError('PERCEPTION_NOTHING_TO_RECORD', 'The corrected draft carries no text on any page, so there is nothing to record.');
    }
    // The same event a native read writes, against the ingestion record, with
    // the provider and the confirmer on it. Refused by that command where the
    // file was never ingested, is quarantined, or already has its text.
    const recorded = recordModelReading(ctx, {
      hash: draft.evidenceHash,
      pages,
      readBy: draft.aiProvenance?.provider ?? 'the perception provider',
      draftId: draft.id,
    });
    result = {
      ingestionId: recorded.ingestionId,
      pages: recorded.pages,
      characters: recorded.characters,
      kind: recorded.kind,
      ...(extraction.language ? { language: String(extraction.language) } : {}),
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
  if (definition.module) requireModule(ctx.grantedModules, definition.module);
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
