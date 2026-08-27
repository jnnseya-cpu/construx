import { DomainError } from '../core/errors.ts';
import type { Engine } from '../ai/orchestrator.ts';
import { authorise, runAI, type EngineContext } from '../engines/context.ts';
import type { DocumentBlock, ExportAudience, ExportDocument, ExportFormat, ExportService } from '../export/exporter.ts';
import { documentReference, frontMatter, nextRevision, provenance, type DocumentControl } from './control.ts';
import {
  assertGenerable,
  people,
  resolveSources,
  type ComposeInput,
  type DocumentDefinition,
  type MissingSource,
  type Row,
} from './engine.ts';
import { PLANNING_DOCUMENTS } from './planning.ts';
import { QUALITY_DOCUMENTS } from './quality.ts';
import { SAFETY_DOCUMENTS } from './safety.ts';

/**
 * The catalogue, and the one command that generates from it.
 *
 * Fifteen document types, one generation path. A second path would be a second
 * place where branding, the refusal, the AI marking and the content hash could
 * each be got wrong independently.
 */
export const DOCUMENT_TYPES: DocumentDefinition[] = [...SAFETY_DOCUMENTS, ...PLANNING_DOCUMENTS, ...QUALITY_DOCUMENTS];

const BY_CODE = new Map(DOCUMENT_TYPES.map((definition) => [definition.code, definition]));

export function documentType(code: string): DocumentDefinition {
  const definition = BY_CODE.get(code);
  if (!definition) throw new DomainError('DOCUMENT_TYPE_UNKNOWN', `There is no document type "${code}".`, 404);
  return definition;
}

/**
 * Which engine reasons about which document.
 *
 * Not a single general-purpose call: the engine determines the model class, the
 * ACU rate and the phases the task is permitted in, and a safety document
 * reasoned about by the estimating engine would be charged and routed as
 * estimating work. It would also read like it.
 */
const ENGINE_FOR: Record<string, Engine> = {
  SAFETY_AND_HEALTH: 'RISK_SAFETY',
  PROJECT_MANAGEMENT: 'PLANNING',
  QUALITY_AND_COMPLIANCE: 'HANDOVER_OM',
};

// --- What the console asks before offering the command ----------------------

export type DocumentAvailability = {
  code: string;
  title: string;
  category: string;
  purpose: string;
  scope: string;
  subject?: string;
  generable: boolean;
  /** Named, so the screen can say what to do rather than only that it cannot. */
  missing: MissingSource[];
  /** For record-scoped types: what there is to generate one against. */
  subjects: Array<{ id: string; label: string }>;
};

export function documentCatalogue(ctx: EngineContext): { documents: DocumentAvailability[]; summary: string } {
  authorise(ctx, 'EVIDENCE_AUDIT', 'R');

  const documents = DOCUMENT_TYPES.map((definition) => {
    const subjects =
      definition.scope === 'RECORD' && definition.subject
        ? ctx.ledger.list(ctx.projectId, definition.subject).map((record) => ({
            id: String(record.state.id ?? record.refId),
            label: subjectLabel(record.state as Row),
          }))
        : [];

    // For a record-scoped type, availability is judged against the first
    // subject: the shared sources are the same whichever one is chosen, and a
    // catalogue that reported "generable" only after somebody picked a record
    // would be useless for deciding whether to offer the command.
    const probe = definition.scope === 'RECORD' ? (ctx.ledger.list(ctx.projectId, definition.subject!)[0]?.state as Row | undefined) : undefined;
    const { missing } = resolveSources(ctx, definition, probe);

    return {
      code: definition.code,
      title: definition.title,
      category: definition.category,
      purpose: definition.purpose,
      scope: definition.scope,
      subject: definition.subject,
      generable: missing.length === 0,
      missing,
      subjects,
    };
  });

  const generable = documents.filter((document) => document.generable).length;
  return {
    documents,
    summary: `${generable} of ${documents.length} document types can be generated from what this project holds.`,
  };
}

function subjectLabel(state: Row): string {
  for (const key of ['reference', 'title', 'activityDescription', 'name', 'subject']) {
    const value = state[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return String(state.id ?? '');
}

// --- Generation -------------------------------------------------------------

export type GenerateInput = {
  code: string;
  /** For record-scoped types. */
  subjectId?: string;
  control: Omit<DocumentControl, 'reference' | 'revision'> & { revision?: string };
  audience?: ExportAudience;
  format?: ExportFormat;
  /**
   * Whether to run the reasoning engine for the narrative sections.
   *
   * Off is a legitimate choice — an empty wallet, a document wanted in a hurry,
   * a customer who does not want machine-written prose on a safety document at
   * all. The document is still complete: every fact is on it either way, and
   * the narrative heading states plainly that the section was not produced.
   */
  withNarrative?: boolean;
  correlationId: string;
};

/**
 * The exporter is passed in rather than read off the context.
 *
 * `EngineContext` carries the ledger, the orchestrator and the wallet — the
 * things every domain command needs. Adding the exporter to it would give every
 * command in the platform the ability to emit a branded document, which is a
 * capability that belongs to exactly one seam: the domain composes the blocks,
 * and the exporter brands, redacts, hashes and records them.
 */
export async function generateDocument(
  ctx: EngineContext,
  exports: ExportService,
  input: GenerateInput,
): Promise<{
  document: ExportDocument;
  /**
   * The document's own reference and revision, returned rather than left to be
   * read back out of the subtitle.
   *
   * `ExportDocument.reference` is the export's id — what the platform calls the
   * act of exporting. It is not what the site calls the document, and the
   * console was showing it as though it were.
   */
  control: { reference: string; revision: string; status: string };
  acuConsumed: number;
  narrativeSections: number;
}> {
  const definition = documentType(input.code);

  // Read authority on the records, plus export authority on the way out. The
  // exporter checks entitlement and redacts for the audience; this checks that
  // the caller may see the records the document is composed from at all.
  authorise(ctx, 'EVIDENCE_AUDIT', 'R');

  const subject =
    definition.scope === 'RECORD'
      ? (ctx.ledger.get({ refType: definition.subject!, refId: input.subjectId ?? '' })?.state as Row | undefined)
      : undefined;

  if (definition.scope === 'RECORD' && !subject) {
    throw new DomainError(
      'DOCUMENT_SUBJECT_NOT_FOUND',
      `A ${definition.title} is generated against one ${definition.subject}. ${
        input.subjectId ? `There is no ${definition.subject} ${input.subjectId} on this project.` : 'Name which one.'
      }`,
      404,
    );
  }

  const { sources, missing } = resolveSources(ctx, definition, subject);
  assertGenerable(definition, missing);

  const project = ctx.ledger.require({ refType: 'Project', refId: ctx.projectId }).state as Row;
  const today = new Date().toISOString().slice(0, 10);

  // The narrative, before composing, because the composer places it.
  const narrative = new Map<string, { text: string; confidence?: number }>();
  let acuConsumed = 0;

  if (input.withNarrative !== false) {
    for (const section of definition.narrative) {
      const written = await reason(ctx, definition, section.heading, section.brief, sources, subject);
      if (written) {
        narrative.set(section.heading, { text: written.text, confidence: written.confidence });
        acuConsumed += written.acuConsumed;
      }
    }
  }

  const composeInput: ComposeInput = { ctx, project, sources, subject, narrative, today };

  // Refuses when branding is not configured, and that refusal is part of the
  // requirement rather than an obstacle to it: an unbranded document sent to a
  // client is worse than no document.
  const branding = exports.branding(ctx.tenantId, ctx.projectId);
  const sequence = ctx.ledger.list(ctx.projectId, 'Export').length + 1;
  const control: DocumentControl = {
    ...input.control,
    reference: documentReference(branding, definition, sequence, definition.reference?.(composeInput) || undefined),
    revision: input.control.revision ?? nextRevision(undefined),
  };

  const blocks: DocumentBlock[] = [
    ...frontMatter({ branding, definition, project, control, today, who: people(ctx) }),
    ...definition.compose(composeInput),
    ...provenance({
      definition,
      counted: definition.sources.map((binding) => ({
        refType: binding.refType,
        count: (sources.get(binding.refType) ?? []).length,
        qualifier: binding.qualifier,
      })),
      today,
    }),
  ];

  const document = exports.document(ctx.auth, ctx.projectId, {
    title: definition.title,
    subtitle: `${control.reference} · revision ${control.revision} · ${control.status.replace(/_/g, ' ').toLowerCase()}`,
    blocks,
    audience: input.audience ?? definition.audience,
    format: input.format ?? 'PDF',
    correlationId: input.correlationId,
    suppressHeader: true,
  });

  return {
    document,
    control: { reference: control.reference, revision: control.revision, status: control.status },
    acuConsumed,
    narrativeSections: narrative.size,
  };
}

/**
 * Ask the reasoning engine for one section.
 *
 * The model is given the records and a question about them. It is not given a
 * blank page and a document title, which is the request that produces the
 * excellent, entirely invented method statement.
 *
 * A failure here is caught rather than propagated. Losing a narrative paragraph
 * must not lose the document: everything factual on the page is already
 * composed, the section states that it could not be produced, and a person can
 * still issue a permit to work on a Friday afternoon when the provider is down.
 */
async function reason(
  ctx: EngineContext,
  definition: DocumentDefinition,
  heading: string,
  brief: string,
  sources: Map<string, Row[]>,
  subject: Row | undefined,
): Promise<{ text: string; confidence?: number; acuConsumed: number } | undefined> {
  try {
    const result = await runAI(ctx, {
      engine: ENGINE_FOR[definition.category] ?? 'EXECUTIVE',
      taskType: `document_narrative:${definition.code}`,
      capability: 'REASONING',
      inputRefs:
        definition.scope === 'RECORD' && subject?.id
          ? [{ refType: definition.subject!, refId: String(subject.id) }]
          : [{ refType: 'Project', refId: ctx.projectId }],
      request: {
        task: brief,
        payload: {
          document: definition.title,
          section: heading,
          subject,
          records: Object.fromEntries(sources),
          // Stated to the model as well as enforced by the composer. The
          // enforcement is that nothing it returns becomes a figure on the
          // page — its text is placed in one marked section and nowhere else.
          constraint:
            'Reason only about the records supplied. Do not state any figure, date, name, reference or quantity that is not ' +
            'in them. Where something is absent, say it is absent rather than supplying it.',
        },
      },
      // The narrative is not state. It is composed into a document that is
      // itself recorded by the exporter, with its own content hash — writing it
      // to the ledger separately would put the same prose in two places.
      toWrites: () => [],
    });

    const text = String(result.output.narrative ?? result.output.text ?? '').trim();
    if (text.length === 0) return undefined;

    const confidence = typeof result.output.confidence === 'number' ? result.output.confidence : undefined;
    return { text, confidence, acuConsumed: result.acuConsumed };
  } catch {
    // Deliberately swallowed. See the note above: a provider outage must not
    // stop a site issuing a permit.
    return undefined;
  }
}
