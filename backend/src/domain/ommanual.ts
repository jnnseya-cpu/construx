import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';

/**
 * H-WF-03 — O&M manuals and technical file assembly.
 *
 * `handover.publishOMManual` already drafts maintenance tasks, intervals, spares
 * and safety requirements out of manufacturer documentation, and it stays as it
 * is: extraction is a legitimate AI act. What it produces is a **draft**, and the
 * specification is explicit that AI-generated text cites its source and remains
 * draft until a person accepts it. This module is the structure, the review and
 * the acceptance around that.
 *
 * **A manual is not a folder of PDFs.** The first line of the deterministic flow
 * is "prevent generic document dumping", and the way to prevent it is to make
 * the structure the thing that exists: sections by facility, system and asset,
 * each answering a question an operator actually asks. A section with a
 * manufacturer catalogue behind it and no mapping to the installed tags has not
 * been written — it has been attached.
 *
 * **Every section shows its source, version and approval.** AC-H-WF-03-02. The
 * question an engineer asks of a maintenance interval at three in the morning is
 * "where did this come from and who agreed it", and a manual that cannot answer
 * it is a manual nobody trusts twice.
 *
 * **Searchable by tag, system, symptom and task.** AC-H-WF-03-01. Symptom is the
 * one usually missing and the one that matters: nobody looks up "AHU-01
 * maintenance" at three in the morning; they look up "no heating on level
 * three".
 *
 * **Changed asset data finds its sections.** AC-H-WF-03-03. When a pump is
 * replaced with a different model, the maintenance schedule, the spares list and
 * the troubleshooting entries that named the old one are all wrong. They are
 * flagged for revision rather than left reading as current.
 */

/**
 * The sections a manual has to contain.
 *
 * `assetSpecific` marks the ones a generic manufacturer catalogue cannot satisfy
 * without being mapped to the installed tags, and `blocker` marks the ones whose
 * absence stops acceptance outright — the specification names the emergency and
 * safety procedures, and those are the two.
 */
export const MANUAL_SECTION = [
  { key: 'SYSTEM_DESCRIPTION', what: 'What the system is and what it serves', assetSpecific: false, blocker: false },
  { key: 'OPERATION', what: 'How to operate it, including start-up and shutdown', assetSpecific: true, blocker: false },
  { key: 'CONTROLS', what: 'Control strategy, setpoints and sequences as commissioned', assetSpecific: true, blocker: false },
  { key: 'EMERGENCY_PROCEDURES', what: 'What to do when it fails, including isolation', assetSpecific: true, blocker: true },
  { key: 'SAFETY', what: 'Residual hazards, permits and safe systems of work', assetSpecific: true, blocker: true },
  { key: 'MAINTENANCE_TASKS', what: 'Tasks, frequencies, skills, tools and consumables', assetSpecific: true, blocker: false },
  { key: 'TROUBLESHOOTING', what: 'Symptoms, probable causes and the task that answers each', assetSpecific: true, blocker: false },
  { key: 'SPARES', what: 'Recommended spares with manufacturer part numbers', assetSpecific: true, blocker: false },
  { key: 'COMMISSIONING_RESULTS', what: 'The results the system was accepted on', assetSpecific: true, blocker: false },
  { key: 'WARRANTY', what: 'Warranty terms, start dates and what voids them', assetSpecific: true, blocker: false },
  { key: 'CONTACTS', what: 'Supplier, service and escalation contacts', assetSpecific: false, blocker: false },
] as const;

export type ManualSectionKey = (typeof MANUAL_SECTION)[number]['key'];

export const SOURCE_KIND = ['MANUFACTURER', 'DESIGN', 'COMMISSIONING', 'AUTHORED'] as const;
export type SourceKind = (typeof SOURCE_KIND)[number];

export type ManualSection = {
  key: ManualSectionKey;
  content: string;
  source: { kind: SourceKind; reference: string; revision: string };
  /** Which installed tags this section actually describes. */
  mappedAssetTags: string[];
  /** Symptom and task entries, which is what makes the manual searchable. */
  symptoms?: Array<{ symptom: string; probableCause: string; task: string }>;
  tasks?: Array<{ task: string; frequency: string; skill: string }>;
  authoredBy: string;
  aiDrafted: boolean;
  status: 'DRAFT' | 'CHECKED' | 'ACCEPTED' | 'REVISION_REQUIRED';
  reviews: Array<{ role: 'CHECKER' | 'OPERATOR'; decision: 'ACCEPTED' | 'REJECTED'; reviewedBy: string; comment: string; at: string }>;
  revisionRequired?: { reason: string; raisedAt: string };
};

export type OMManualState = {
  manualId: string;
  reference: string;
  systemTag: string;
  assetTags: string[];
  title: string;
  sections: ManualSection[];
  status: 'DRAFT' | 'ACCEPTED' | 'REJECTED';
  acceptance?: { acceptedBy: string; forOperator: string; acceptedAt: string };
  rejection?: { reasons: string[]; rejectedBy: string; rejectedAt: string };
};

function requireManual(ctx: EngineContext, manualId: string) {
  const record = ctx.ledger.get({ refType: 'OMManualStructure', refId: manualId });
  if (!record) throw new DomainError('MANUAL_NOT_FOUND', `No O&M manual ${manualId}`, 404);
  return record;
}

function stateOf(record: { state: Record<string, unknown> }): OMManualState {
  return record.state as unknown as OMManualState;
}

function manuals(ctx: EngineContext): OMManualState[] {
  return ctx.ledger.list(ctx.projectId, 'OMManualStructure').map(stateOf);
}

/** Create the manual structure for a system and the assets it contains. */
export function createManual(
  ctx: EngineContext,
  input: { reference: string; systemTag: string; assetTags: string[]; title: string; author: string },
): { manualId: string; sectionsRequired: number } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.title.trim()) {
    throw new DomainError('MANUAL_UNIDENTIFIED', 'A manual carries a reference and a title.');
  }
  if (input.assetTags.length === 0) {
    throw new DomainError(
      'ASSETS_REQUIRED',
      'Name the installed assets this manual covers. A manual structured by nothing is a folder of PDFs, which is exactly ' +
        'what the structure exists to prevent.',
    );
  }
  if (!input.author.trim()) throw new DomainError('AUTHOR_REQUIRED', 'Name the technical author.');
  if (manuals(ctx).some((manual) => manual.reference === input.reference)) {
    throw new DomainError('REFERENCE_TAKEN', `${input.reference} already exists.`);
  }

  const manualId = ulid();

  write(ctx, {
    eventType: 'OM_MANUAL_DRAFTED',
    entity: { refType: 'OMManualStructure', refId: manualId },
    nextState: {
      manualId,
      projectId: ctx.projectId,
      reference: input.reference,
      systemTag: input.systemTag,
      assetTags: input.assetTags,
      title: input.title,
      author: input.author,
      sections: [],
      status: 'DRAFT',
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    },
  });

  return { manualId, sectionsRequired: MANUAL_SECTION.length };
}

/**
 * Write or replace a section.
 *
 * The exception control lives here: a manufacturer catalogue cannot satisfy an
 * asset-specific section unless it is mapped to the installed tags. A generic
 * pump manual covering forty models tells an operator nothing about the two in
 * the plant room.
 */
export function writeSection(
  ctx: EngineContext,
  manualId: string,
  input: {
    key: ManualSectionKey;
    content: string;
    source: { kind: SourceKind; reference: string; revision: string };
    mappedAssetTags: string[];
    symptoms?: Array<{ symptom: string; probableCause: string; task: string }>;
    tasks?: Array<{ task: string; frequency: string; skill: string }>;
    authoredBy: string;
    aiDrafted: boolean;
  },
): { key: ManualSectionKey; status: string } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireManual(ctx, manualId);
  const state = stateOf(record);
  const definition = MANUAL_SECTION.find((entry) => entry.key === input.key);
  if (!definition) throw new DomainError('SECTION_UNKNOWN', `${input.key} is not a manual section.`);

  if (state.status === 'ACCEPTED') {
    throw new DomainError(
      'MANUAL_ACCEPTED',
      'This manual has been accepted. A section rewritten afterwards changes what the operator agreed to run the building ' +
        'on; raise it as a revision instead.',
    );
  }
  if (input.content.trim().length < 20) {
    throw new DomainError('SECTION_EMPTY', `${input.key} has no content. A heading is not a section.`);
  }
  if (!input.source.reference.trim() || !input.source.revision.trim()) {
    throw new DomainError(
      'SOURCE_REQUIRED',
      `${input.key} cites no source and revision. The question asked of a maintenance interval at three in the morning is ` +
        'where it came from, and a manual that cannot answer it is one nobody trusts twice.',
    );
  }
  if (!input.authoredBy.trim()) throw new DomainError('AUTHOR_REQUIRED', 'Name who wrote it.');

  if (definition.assetSpecific) {
    if (input.mappedAssetTags.length === 0) {
      throw new DomainError(
        'SECTION_UNMAPPED',
        `${input.key} describes specific equipment and is mapped to none. A generic manufacturer catalogue covering forty ` +
          'models tells an operator nothing about the two in the plant room.',
      );
    }
    const outside = input.mappedAssetTags.filter((tag) => !state.assetTags.includes(tag));
    if (outside.length > 0) {
      throw new DomainError(
        'ASSET_OUTSIDE_MANUAL',
        `${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not covered by this manual.`,
      );
    }
  }

  if (input.key === 'TROUBLESHOOTING' && (input.symptoms ?? []).length === 0) {
    throw new DomainError(
      'SYMPTOMS_REQUIRED',
      'A troubleshooting section lists symptoms with the task that answers each. Nobody looks up "AHU-01 maintenance" at ' +
        'three in the morning; they look up "no heating on level three".',
    );
  }
  if (input.key === 'MAINTENANCE_TASKS' && (input.tasks ?? []).length === 0) {
    throw new DomainError(
      'TASKS_REQUIRED',
      'A maintenance section lists the tasks with their frequency and the skill each needs. Prose describing maintenance is ' +
        'not a schedule anybody can plan from.',
    );
  }

  const section: ManualSection = {
    key: input.key,
    content: input.content,
    source: input.source,
    mappedAssetTags: input.mappedAssetTags,
    symptoms: input.symptoms,
    tasks: input.tasks,
    authoredBy: input.authoredBy,
    aiDrafted: input.aiDrafted,
    status: 'DRAFT',
    reviews: [],
  };

  write(ctx, {
    eventType: 'OM_SECTION_WRITTEN',
    entity: { refType: 'OMManualStructure', refId: manualId },
    nextState: {
      ...record.state,
      sections: [...state.sections.filter((entry) => entry.key !== input.key), section],
    },
  });

  return { key: input.key, status: 'DRAFT' };
}

/** Review a section — the technical checker, then the operator who has to use it. */
export function reviewSection(
  ctx: EngineContext,
  manualId: string,
  input: {
    key: ManualSectionKey;
    role: 'CHECKER' | 'OPERATOR';
    decision: 'ACCEPTED' | 'REJECTED';
    reviewedBy: string;
    comment: string;
  },
): { status: string } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireManual(ctx, manualId);
  const state = stateOf(record);
  const section = state.sections.find((entry) => entry.key === input.key);
  if (!section) throw new DomainError('SECTION_NOT_WRITTEN', `${input.key} has not been written.`, 404);

  if (!input.reviewedBy.trim()) throw new DomainError('REVIEW_UNSIGNED', 'Name the reviewer.');
  if (input.decision === 'REJECTED' && input.comment.trim().length < 10) {
    throw new DomainError('COMMENT_REQUIRED', 'A rejection says what is wrong with it.');
  }
  if (section.authoredBy === input.reviewedBy) {
    throw new DomainError(
      'SELF_REVIEW',
      `${input.reviewedBy} wrote ${input.key}. A section checked by the person who wrote it has been checked by nobody.`,
    );
  }

  const reviews = [
    ...section.reviews,
    {
      role: input.role,
      decision: input.decision,
      reviewedBy: input.reviewedBy,
      comment: input.comment,
      at: new Date().toISOString(),
    },
  ];

  // A section is accepted when the checker and the operator have both accepted
  // it. The technical author's word and the operator's are different assurances
  // and the specification asks for both.
  const accepted =
    reviews.some((review) => review.role === 'CHECKER' && review.decision === 'ACCEPTED') &&
    reviews.some((review) => review.role === 'OPERATOR' && review.decision === 'ACCEPTED');
  const rejected = reviews[reviews.length - 1]!.decision === 'REJECTED';
  const status: ManualSection['status'] = rejected ? 'DRAFT' : accepted ? 'ACCEPTED' : 'CHECKED';

  write(ctx, {
    eventType: 'OM_SECTION_REVIEWED',
    entity: { refType: 'OMManualStructure', refId: manualId },
    nextState: {
      ...record.state,
      sections: state.sections.map((entry) => (entry.key === input.key ? { ...entry, reviews, status } : entry)),
    },
  });

  return { status };
}

export type ManualValidation = {
  reference: string;
  missing: ManualSectionKey[];
  missingBlockers: ManualSectionKey[];
  unaccepted: ManualSectionKey[];
  /** AI-drafted text nobody has accepted, which the specification says stays draft. */
  aiDraftsOutstanding: ManualSectionKey[];
  revisionRequired: ManualSectionKey[];
  /** The same task named at two different frequencies, which is the commonest contradiction. */
  contradictions: string[];
  assetsWithNoSection: string[];
  completenessPercent: number;
  acceptable: boolean;
};

/** Validate the manual. Derived on read, so it cannot go stale against its sections. */
export function validateManual(ctx: EngineContext, manualId: string): ManualValidation {
  authorise(ctx, 'HANDOVER_OM', 'R');
  return validationOf(stateOf(requireManual(ctx, manualId)));
}

function validationOf(state: OMManualState): ManualValidation {
  const written = new Map(state.sections.map((section) => [section.key, section]));
  const missing = MANUAL_SECTION.filter((entry) => !written.has(entry.key)).map((entry) => entry.key);
  const missingBlockers = MANUAL_SECTION.filter((entry) => entry.blocker && !written.has(entry.key)).map(
    (entry) => entry.key,
  );
  const unaccepted = state.sections.filter((section) => section.status !== 'ACCEPTED').map((section) => section.key);
  const aiDraftsOutstanding = state.sections
    .filter((section) => section.aiDrafted && section.status !== 'ACCEPTED')
    .map((section) => section.key);
  const revisionRequired = state.sections
    .filter((section) => section.status === 'REVISION_REQUIRED')
    .map((section) => section.key);

  // One task at two frequencies is the commonest contradiction in an assembled
  // manual, and it comes from two source documents neither of which was wrong.
  const frequencies = new Map<string, Set<string>>();
  for (const section of state.sections) {
    for (const task of section.tasks ?? []) {
      const seen = frequencies.get(task.task) ?? new Set<string>();
      seen.add(task.frequency);
      frequencies.set(task.task, seen);
    }
  }
  const contradictions = [...frequencies.entries()]
    .filter(([, seen]) => seen.size > 1)
    .map(([task, seen]) => `"${task}" is given as ${[...seen].join(' and ')}`);

  const mapped = new Set(state.sections.flatMap((section) => section.mappedAssetTags));
  const assetsWithNoSection = state.assetTags.filter((tag) => !mapped.has(tag));

  return {
    reference: state.reference,
    missing,
    missingBlockers,
    unaccepted,
    aiDraftsOutstanding,
    revisionRequired,
    contradictions,
    assetsWithNoSection,
    completenessPercent: Math.round(((MANUAL_SECTION.length - missing.length) / MANUAL_SECTION.length) * 100),
    acceptable:
      missing.length === 0 &&
      unaccepted.length === 0 &&
      contradictions.length === 0 &&
      assetsWithNoSection.length === 0,
  };
}

/** Accept the manual for operational use. */
export function acceptManual(
  ctx: EngineContext,
  manualId: string,
  input: { acceptedBy: string; forOperator: string },
): { reference: string; completenessPercent: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireManual(ctx, manualId);
  const state = stateOf(record);

  if (state.status === 'ACCEPTED') throw new DomainError('MANUAL_ACCEPTED', `${state.reference} is already accepted.`);
  if (!input.acceptedBy.trim() || !input.forOperator.trim()) {
    throw new DomainError('ACCEPTANCE_UNSIGNED', 'Name the person accepting it and the operator they act for.');
  }

  const validation = validationOf(state);

  if (validation.missingBlockers.length > 0) {
    throw new DomainError(
      'BLOCKER_SECTION_MISSING',
      `${validation.missingBlockers.join(', ')} ${validation.missingBlockers.length === 1 ? 'is' : 'are'} missing. An ` +
        'operator can run a building without a spares list; they cannot run one without knowing what to do when it fails.',
    );
  }
  if (validation.aiDraftsOutstanding.length > 0) {
    throw new DomainError(
      'AI_DRAFT_UNACCEPTED',
      `${validation.aiDraftsOutstanding.join(', ')} ${validation.aiDraftsOutstanding.length === 1 ? 'is' : 'are'} ` +
        'AI-drafted and nobody has accepted the text. Extraction is a draft until a person stands behind it.',
    );
  }
  if (validation.unaccepted.length > 0) {
    throw new DomainError(
      'SECTIONS_UNACCEPTED',
      `${validation.unaccepted.join(', ')} ${validation.unaccepted.length === 1 ? 'has' : 'have'} not been accepted by ` +
        'both the checker and the operator.',
    );
  }
  if (validation.missing.length > 0) {
    throw new DomainError('SECTIONS_MISSING', `${validation.missing.join(', ')} not written.`);
  }
  if (validation.contradictions.length > 0) {
    throw new DomainError(
      'CONTRADICTORY_CONTENT',
      `${validation.contradictions.join('; ')}. Two sources neither of which was wrong produce one manual that is.`,
    );
  }
  if (validation.assetsWithNoSection.length > 0) {
    throw new DomainError(
      'ASSET_UNCOVERED',
      `${validation.assetsWithNoSection.join(', ')} appears in no section. An asset the manual names and never describes ` +
        'is the one nobody can maintain.',
    );
  }

  write(ctx, {
    eventType: 'OM_MANUAL_ACCEPTED',
    entity: { refType: 'OMManualStructure', refId: manualId },
    nextState: {
      ...record.state,
      status: 'ACCEPTED',
      acceptance: {
        acceptedBy: input.acceptedBy,
        forOperator: input.forOperator,
        acceptedAt: new Date().toISOString(),
      },
    },
  });

  return { reference: state.reference, completenessPercent: validation.completenessPercent };
}

/** Reject the manual, naming what is wrong with it. */
export function rejectManual(
  ctx: EngineContext,
  manualId: string,
  input: { reasons: string[]; rejectedBy: string },
): { reference: string } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireManual(ctx, manualId);
  const state = stateOf(record);

  if (input.reasons.length === 0 || input.reasons.some((reason) => reason.trim().length < 10)) {
    throw new DomainError(
      'REASONS_REQUIRED',
      'Say what is wrong with it. A manual rejected with no reasons comes back unchanged.',
    );
  }
  if (!input.rejectedBy.trim()) throw new DomainError('REJECTION_UNSIGNED', 'Name who rejected it.');

  write(ctx, {
    eventType: 'OM_MANUAL_REJECTED',
    entity: { refType: 'OMManualStructure', refId: manualId },
    nextState: {
      ...record.state,
      status: 'REJECTED',
      rejection: { reasons: input.reasons, rejectedBy: input.rejectedBy, rejectedAt: new Date().toISOString() },
    },
  });

  return { reference: state.reference };
}

/**
 * An asset has changed. Find the sections that described the old one.
 *
 * AC-H-WF-03-03. When a pump is replaced with a different model, the maintenance
 * schedule, the spares list and the troubleshooting entries that named the old
 * one are all wrong — and they read as current until somebody notices.
 */
export function flagAssetDataChange(
  ctx: EngineContext,
  input: { assetTag: string; what: string; changedBy: string },
): { flagged: Array<{ manualReference: string; section: ManualSectionKey }> } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  if (input.what.trim().length < 10) {
    throw new DomainError('CHANGE_UNDESCRIBED', 'Say what changed about the asset. It is what the revision is scoped from.');
  }
  if (!input.changedBy.trim()) throw new DomainError('CHANGE_UNSIGNED', 'Name who recorded it.');

  const flagged: Array<{ manualReference: string; section: ManualSectionKey }> = [];
  const raisedAt = new Date().toISOString();

  for (const state of manuals(ctx)) {
    const affected = state.sections.filter(
      (section) => section.mappedAssetTags.includes(input.assetTag) && section.status !== 'REVISION_REQUIRED',
    );
    if (affected.length === 0) continue;

    const record = requireManual(ctx, state.manualId);
    write(ctx, {
      eventType: 'OM_SECTION_REVISION_REQUIRED',
      entity: { refType: 'OMManualStructure', refId: state.manualId },
      nextState: {
        ...record.state,
        sections: state.sections.map((section) =>
          affected.some((entry) => entry.key === section.key)
            ? { ...section, status: 'REVISION_REQUIRED', revisionRequired: { reason: input.what, raisedAt } }
            : section,
        ),
      },
    });

    for (const section of affected) flagged.push({ manualReference: state.reference, section: section.key });
  }

  return { flagged };
}

// --- Search -----------------------------------------------------------------

export type ManualSearchHit = {
  manualReference: string;
  systemTag: string;
  section: ManualSectionKey;
  matchedOn: 'ASSET' | 'SYSTEM' | 'SYMPTOM' | 'TASK';
  detail: string;
  source: string;
  status: string;
};

/**
 * Search the manuals.
 *
 * AC-H-WF-03-01, and the four ways it names are four genuinely different
 * questions. Symptom is the one usually missing from an O&M and the one an
 * operator actually starts from.
 */
export function searchManuals(
  ctx: EngineContext,
  query: { assetTag?: string; systemTag?: string; symptom?: string; task?: string },
): ManualSearchHit[] {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const hits: ManualSearchHit[] = [];
  const needle = (value: string | undefined) => value?.trim().toLowerCase();
  const symptom = needle(query.symptom);
  const task = needle(query.task);

  for (const state of manuals(ctx)) {
    if (query.systemTag && state.systemTag !== query.systemTag) continue;

    for (const section of state.sections) {
      const base = {
        manualReference: state.reference,
        systemTag: state.systemTag,
        section: section.key,
        source: `${section.source.reference} rev ${section.source.revision}`,
        status: section.status,
      };

      if (query.assetTag && section.mappedAssetTags.includes(query.assetTag)) {
        hits.push({ ...base, matchedOn: 'ASSET', detail: section.content });
      }
      if (symptom) {
        for (const entry of section.symptoms ?? []) {
          if (!entry.symptom.toLowerCase().includes(symptom)) continue;
          hits.push({ ...base, matchedOn: 'SYMPTOM', detail: `${entry.symptom} → ${entry.probableCause} → ${entry.task}` });
        }
      }
      if (task) {
        for (const entry of section.tasks ?? []) {
          if (!entry.task.toLowerCase().includes(task)) continue;
          hits.push({ ...base, matchedOn: 'TASK', detail: `${entry.task}, ${entry.frequency}, ${entry.skill}` });
        }
      }
      if (query.systemTag && !query.assetTag && !symptom && !task) {
        hits.push({ ...base, matchedOn: 'SYSTEM', detail: section.content });
      }
    }
  }

  return hits;
}

// --- The position -----------------------------------------------------------

export type OMManualPosition = {
  manuals: Array<{
    manualId: string;
    reference: string;
    systemTag: string;
    status: string;
    completenessPercent: number;
    missingBlockers: string[];
    aiDraftsOutstanding: string[];
    revisionRequired: string[];
    contradictions: string[];
  }>;
  summary: string;
};

export function omManualPosition(ctx: EngineContext): OMManualPosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const rows = manuals(ctx).map((state) => {
    const validation = validationOf(state);
    return {
      manualId: state.manualId,
      reference: state.reference,
      systemTag: state.systemTag,
      status: state.status,
      completenessPercent: validation.completenessPercent,
      missingBlockers: validation.missingBlockers,
      aiDraftsOutstanding: validation.aiDraftsOutstanding,
      revisionRequired: validation.revisionRequired,
      contradictions: validation.contradictions,
    };
  });

  const accepted = rows.filter((row) => row.status === 'ACCEPTED').length;
  const parts = [`${rows.length} manual${rows.length === 1 ? '' : 's'}`, `${accepted} accepted`];
  const revision = rows.filter((row) => row.revisionRequired.length > 0).length;
  if (revision > 0) parts.push(`${revision} with a section the asset data has overtaken`);
  const drafts = rows.filter((row) => row.aiDraftsOutstanding.length > 0).length;
  if (drafts > 0) parts.push(`${drafts} carrying AI-drafted text nobody has accepted`);

  return { manuals: rows, summary: parts.join(', ') + '.' };
}
