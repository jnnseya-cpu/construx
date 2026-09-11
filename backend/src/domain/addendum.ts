import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { complianceMatrix, type MatrixLine } from './itt.ts';

/**
 * Targeted invalidation — §8.2, `ITT-008`, `AS-02`.
 *
 * ---
 *
 * **The failure this stops.** An addendum arrives eleven days before return. It
 * changes a drawing, moves a completion date and rewrites one requirement. The
 * bid team reads the covering email, agrees it looks minor, and carries on —
 * and the response written three weeks ago against the old wording goes in
 * unchanged, because nothing on any screen distinguishes a section written
 * against the current requirement from one written against a superseded one.
 *
 * The whole of `AS-02` is that they should not look the same.
 *
 * ## Targeted, not a full rerun
 *
 * The naive answer is to re-analyse the invitation, which costs money, writes a
 * second analysis of one tender into the record, and — worse — resets every
 * status a person had set by hand. The right answer is the one the specification
 * names: **only nodes with an edge to a changed node are marked stale.**
 *
 * So this compares the revised requirement set against the stored matrix, names
 * exactly what moved, and touches nothing else. A requirement that did not
 * change is not re-examined, and a response written against it stays good.
 *
 * ## Material and minor, and why the line is drawn there
 *
 * A **material** change is one that can lose the bid if nobody looks: a
 * mandatory requirement added, removed or reworded; any requirement whose
 * stated deadline moved; a requirement that became mandatory or stopped being
 * mandatory. Those block the submission until somebody has looked at each.
 *
 * A **minor** change is a weighting moving on a scored question, or wording
 * tightened on one that was optional and stayed optional. Reported, not
 * blocking. Blocking on those would make the block routine, and a block nobody
 * can clear is a block everybody learns to work around.
 *
 * ## Where the staleness lives
 *
 * On the analysis, not on the pack. The pack reads the open impacts the same way
 * it reads live waivers, so a section written against a superseded requirement
 * reads as stale the moment the addendum lands and reads as current the moment
 * somebody reviews the impact — with no second copy of the decision to keep in
 * step. A pack that stored its own staleness would go out of date exactly when
 * it mattered.
 */

export const IMPACT_KIND = ['ADDED', 'REMOVED', 'REWORDED', 'DEADLINE_MOVED', 'MANDATORY_CHANGED', 'WEIGHTING_CHANGED'] as const;
export type ImpactKind = (typeof IMPACT_KIND)[number];

export type AddendumImpact = {
  /** The addendum that caused it. */
  addendum: string;
  /** The matrix reference affected. */
  reference: string;
  kind: ImpactKind;
  /** Material blocks the submission; minor is reported. */
  material: boolean;
  /** What moved, in the words somebody reviewing it needs. */
  detail: string;
  status: 'OPEN' | 'REVIEWED';
  raisedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
};

export type AddendumRecord = {
  reference: string;
  issuedOn: string;
  summary: string;
  assessedAt: string;
  assessedBy: string;
  impacts: number;
  material: number;
};

/** A requirement as the addendum restates it. The same shape the analysis took. */
export type RevisedRequirement = {
  reference: string;
  requirement: string;
  mandatory: boolean;
  weightingPercent?: number;
  dueBy?: string;
};

function impactsOf(record: EntityRecord): AddendumImpact[] {
  return ((record.state as Record<string, unknown>).addendumImpacts as AddendumImpact[] | undefined) ?? [];
}

function addendaOf(record: EntityRecord): AddendumRecord[] {
  return ((record.state as Record<string, unknown>).addenda as AddendumRecord[] | undefined) ?? [];
}

function requireAnalysis(ctx: EngineContext, analysisId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'ITTAnalysis', refId: analysisId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('ITT_ANALYSIS_NOT_FOUND', `No compliance matrix ${analysisId}`, 404);
  }
  return record;
}

/**
 * What an addendum changed, compared line by line.
 *
 * Pure, so the delta can be shown before anything is recorded — the person
 * deciding whether to accept an addendum's consequences should see them before
 * the ledger does. The same reason `departuresBetween` is pure.
 */
export function impactsBetween(
  addendum: string,
  before: MatrixLine[],
  after: RevisedRequirement[],
): Array<Omit<AddendumImpact, 'status' | 'raisedAt'>> {
  const impacts: Array<Omit<AddendumImpact, 'status' | 'raisedAt'>> = [];
  const beforeBy = new Map(before.map((line) => [line.reference, line]));
  const afterBy = new Map(after.map((line) => [line.reference, line]));

  for (const line of after) {
    const previous = beforeBy.get(line.reference);
    if (!previous) {
      impacts.push({
        addendum,
        reference: line.reference,
        kind: 'ADDED',
        material: true,
        detail:
          `${line.reference} is new: "${line.requirement}"` +
          (line.mandatory ? ' — and it is mandatory, so a submission without it is rejected.' : '.'),
      });
      continue;
    }

    if (previous.requirement.trim() !== line.requirement.trim()) {
      impacts.push({
        addendum,
        reference: line.reference,
        kind: 'REWORDED',
        // A reworded mandatory question is the case a response answers
        // perfectly and scores nothing, because it answers the old one.
        material: previous.mandatory || line.mandatory,
        detail: `${line.reference} was reworded. It now reads "${line.requirement}".`,
      });
    }

    if (previous.mandatory !== line.mandatory) {
      impacts.push({
        addendum,
        reference: line.reference,
        kind: 'MANDATORY_CHANGED',
        material: true,
        detail: line.mandatory
          ? `${line.reference} is now mandatory. It was scored, and a gap on it now ends the bid.`
          : `${line.reference} is no longer mandatory. Effort priced against a pass/fail question can be reconsidered.`,
      });
    }

    if ((previous.dueBy ?? '') !== (line.dueBy ?? '')) {
      impacts.push({
        addendum,
        reference: line.reference,
        kind: 'DEADLINE_MOVED',
        material: true,
        detail: line.dueBy
          ? `${line.reference} is now due ${line.dueBy}${previous.dueBy ? ` rather than ${previous.dueBy}` : ', where it carried no date before'}.`
          : `${line.reference} no longer states a date. It carried ${previous.dueBy}.`,
      });
    }

    if ((previous.weightingPercent ?? 0) !== (line.weightingPercent ?? 0)) {
      impacts.push({
        addendum,
        reference: line.reference,
        kind: 'WEIGHTING_CHANGED',
        // Minor: it changes where effort is worth spending and not whether the
        // submission is compliant. Blocking on it would make the block routine.
        material: false,
        detail:
          `${line.reference} is now worth ${line.weightingPercent ?? 0}% rather than ${previous.weightingPercent ?? 0}%. ` +
          'Where the effort is worth spending has moved.',
      });
    }
  }

  for (const line of before) {
    if (afterBy.has(line.reference)) continue;
    impacts.push({
      addendum,
      reference: line.reference,
      kind: 'REMOVED',
      material: true,
      detail:
        `${line.reference} has been withdrawn: "${line.requirement}". Anything written or priced against it is now effort ` +
        'spent on a question nobody asked.',
    });
  }

  return impacts;
}

/**
 * Record an addendum and what it changed.
 *
 * `ESTIMATE_TENDER` `U`. Assessing an addendum is work rather than a decision —
 * the decision is whether to issue the submission afterwards, and that stays an
 * approval.
 */
export function assessAddendum(
  ctx: EngineContext,
  analysisId: string,
  input: { reference: string; issuedOn: string; summary: string; requirements: RevisedRequirement[] },
): { addendum: AddendumRecord; impacts: AddendumImpact[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnalysis(ctx, analysisId);
  const analysis = complianceMatrix(ctx, analysisId);

  const reference = input.reference.trim();
  if (!reference) {
    throw new DomainError('ADDENDUM_REFERENCE_REQUIRED', 'An addendum is identified by the reference the buyer gave it.');
  }
  const held = addendaOf(record);
  if (held.some((entry) => entry.reference === reference)) {
    throw new DomainError(
      'ADDENDUM_ALREADY_ASSESSED',
      `${reference} has already been assessed against ${analysis.reference}. Assessing it twice would raise a second set ` +
        'of impacts over the first, and somebody would clear the wrong ones.',
      409,
    );
  }

  const summary = input.summary.trim();
  if (!summary) {
    throw new DomainError(
      'ADDENDUM_SUMMARY_REQUIRED',
      'Say what the addendum changed, in the buyer’s terms. The impact list below says what it changed in ours.',
    );
  }

  if (input.requirements.length === 0) {
    throw new DomainError(
      'REVISED_REQUIREMENTS_REQUIRED',
      'An addendum assessment compares the revised requirement set against the matrix on file. An empty set would read as ' +
        'every requirement having been withdrawn.',
    );
  }

  const raisedAt = new Date().toISOString();
  const fresh: AddendumImpact[] = impactsBetween(reference, analysis.matrix, input.requirements).map((impact) => ({
    ...impact,
    status: 'OPEN' as const,
    raisedAt,
  }));

  const entry: AddendumRecord = {
    reference,
    issuedOn: input.issuedOn.slice(0, 10),
    summary,
    assessedAt: raisedAt,
    assessedBy: ctx.auth.actorId,
    impacts: fresh.length,
    material: fresh.filter((impact) => impact.material).length,
  };

  write(ctx, {
    eventType: 'TENDER_ADDENDUM_ASSESSED',
    entity: { refType: 'ITTAnalysis', refId: analysisId },
    nextState: {
      ...(record.state as Record<string, unknown>),
      // The matrix itself is not rewritten. The analysis is what was read on the
      // day and stays that; the impacts are what has happened to it since.
      addenda: [...held, entry],
      addendumImpacts: [...impactsOf(record), ...fresh],
    },
  });

  return { addendum: entry, impacts: fresh };
}

/**
 * Look at one impact and say what was done about it.
 *
 * Not "dismiss" and not "close": the question three weeks later is never
 * whether the addendum changed something, it is who looked and what they
 * concluded.
 */
export function reviewImpact(
  ctx: EngineContext,
  analysisId: string,
  input: { addendum: string; reference: string; note: string },
): { reviewed: AddendumImpact; openMaterial: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnalysis(ctx, analysisId);
  const impacts = impactsOf(record);
  const index = impacts.findIndex(
    (impact) => impact.addendum === input.addendum && impact.reference === input.reference && impact.status === 'OPEN',
  );
  if (index < 0) {
    throw new DomainError(
      'IMPACT_NOT_FOUND',
      `No open impact on ${input.reference} from ${input.addendum}`,
      404,
    );
  }

  const note = input.note.trim();
  if (note.length < 10) {
    throw new DomainError(
      'REVIEW_NOTE_REQUIRED',
      'Say what was done about it — the section rewritten, the price revisited, or why neither was needed. A tick is not a ' +
        'review, and the question three weeks later is what somebody concluded.',
      422,
      [{ field: 'note', message: 'At least 10 characters' }],
    );
  }

  const reviewed: AddendumImpact = {
    ...impacts[index]!,
    status: 'REVIEWED',
    reviewedBy: ctx.auth.actorId,
    reviewedAt: new Date().toISOString(),
    reviewNote: note,
  };
  const next = impacts.map((impact, at) => (at === index ? reviewed : impact));

  write(ctx, {
    eventType: 'TENDER_ADDENDUM_IMPACT_REVIEWED',
    entity: { refType: 'ITTAnalysis', refId: analysisId },
    nextState: { ...(record.state as Record<string, unknown>), addendumImpacts: next },
  });

  return {
    reviewed,
    openMaterial: next.filter((impact) => impact.status === 'OPEN' && impact.material).length,
  };
}

/**
 * The impacts still open on an analysis.
 *
 * Read by the response pack, which is what makes the invalidation targeted: a
 * section whose requirement is in this list is stale, and every other section is
 * untouched.
 */
export function openImpacts(ctx: EngineContext, analysisId: string): AddendumImpact[] {
  const record = ctx.ledger.get({ refType: 'ITTAnalysis', refId: analysisId });
  if (!record || record.tenantId !== ctx.tenantId) return [];
  return impactsOf(record).filter((impact) => impact.status === 'OPEN');
}

export type AddendumRegister = {
  analysisId: string;
  reference: string;
  addenda: AddendumRecord[];
  impacts: AddendumImpact[];
  openMaterial: number;
  openMinor: number;
  /** Whether a submission may be issued at all, and why not where it may not. */
  submissionBlocked: boolean;
  summary: string;
};

/** Every addendum assessed against one matrix, and what is still open. */
export function addendumRegister(ctx: EngineContext, analysisId: string): AddendumRegister {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireAnalysis(ctx, analysisId);
  const analysis = complianceMatrix(ctx, analysisId);
  const impacts = impactsOf(record);
  const open = impacts.filter((impact) => impact.status === 'OPEN');
  const openMaterial = open.filter((impact) => impact.material).length;
  const openMinor = open.length - openMaterial;

  return {
    analysisId,
    reference: analysis.reference,
    addenda: addendaOf(record),
    impacts,
    openMaterial,
    openMinor,
    submissionBlocked: openMaterial > 0,
    summary:
      impacts.length === 0
        ? 'No addendum has been assessed against this matrix.'
        : `${addendaOf(record).length} addend${addendaOf(record).length === 1 ? 'um' : 'a'}, ` +
          `${openMaterial} material change${openMaterial === 1 ? '' : 's'} nobody has looked at` +
          (openMinor > 0 ? ` and ${openMinor} minor one${openMinor === 1 ? '' : 's'}` : '') +
          `. ${openMaterial > 0 ? 'The submission is blocked until each is reviewed.' : 'Nothing blocks the submission.'}`,
  };
}
