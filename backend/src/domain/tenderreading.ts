import { DomainError } from '../core/errors.ts';
import { authorise, currentPhase, type EngineContext } from '../engines/context.ts';
import { confirm, extractFromText, PASTED_TEXT_MAX, PERCEPTION_TASKS, requireDraft, type ConfirmInput } from '../engines/perception.ts';
import { packText } from '../evidence/pipeline.ts';
import { isDrawingNote, isEvaluationMethod } from './bidresponse.ts';
import { registerOpportunity, type OpportunityStage } from './business.ts';
import { recordInvitation, type SubmissionChannel } from './tenderintake.ts';

/**
 * The tender pack, read together in one run.
 *
 * A tender arrives as several documents — the instructions, the questionnaire
 * with the scored questions, the price list, the reports — and each says
 * something the others depend on. Reading them one file at a time cost a call,
 * a confirmation and a merge per file, and every answer that came out of it
 * had only ever seen one document. Measured on the Conwy pack: five files,
 * 108,448 characters, about 27,000 tokens — one request, not five.
 *
 * Nothing new about what a reading *is*: the same reader, prompt, response
 * schema, draft, cost confirmation and confirm path as reading one file. What
 * this adds is the assembly, the record of which documents were read, and the
 * checks below, which run in code on the reading before anybody is shown it.
 */

/** The text the reader is given: see `packText` in the evidence pipeline, its one home. */
export { packText };

export async function readTenderPack(ctx: EngineContext, options: { today?: string } = {}) {
  const { text, files } = packText(ctx);
  if (files.length === 0) {
    throw new DomainError(
      'NO_PACK',
      'No tender document on this project carries readable text yet. Upload the pack — the ITT, the questionnaire, ' +
        'the price list — and it is read on arrival; then read it here.',
      422,
    );
  }
  if (text.length > PASTED_TEXT_MAX) {
    throw new DomainError(
      'PACK_TOO_LARGE',
      `The pack is ${Math.round(text.length / 1000)}k characters across ${files.length} documents and one reading takes ` +
        `${Math.round(PASTED_TEXT_MAX / 1000)}k. Read the largest documents one at a time from their own rows: ` +
        files
          .slice()
          .sort((a, b) => b.characters - a.characters)
          .slice(0, 3)
          .map((file) => `${file.filename} (${Math.round(file.characters / 1000)}k)`)
          .join(', ') +
        '.',
      413,
    );
  }
  const today = (options.today ?? new Date().toISOString()).slice(0, 10);
  return extractFromText(ctx, {
    task: 'ITT_REQUIREMENTS',
    text,
    source: 'TENDER_PACK',
    label: `${files.length} document${files.length === 1 ? '' : 's'}: ${files.map((file) => file.filename).join(', ')}`,
    packFiles: files,
    check: (extraction) => checkTenderReading(extraction, text, { today }),
  });
}

// --- The invitation a reading is filed against ------------------------------

/** The stages after which a pursuit takes no new reading. */
const CLOSED_STAGES: readonly string[] = ['NO_BID', 'LOST', 'CONVERTED'] satisfies OpportunityStage[];

export type InvitationFromReading = {
  reference: string;
  clientName: string;
  issuedAt: string;
  returnLocal: string;
  timeZone: string;
  timeZoneStated: boolean;
  channel: SubmissionChannel;
  clarificationLocal?: string;
  siteVisitLocal?: string;
};

/**
 * The invitation for this project, recorded from the reading where there is
 * none yet.
 *
 * A reading used to be refused until somebody had registered an opportunity and
 * typed the invitation in by hand — the same reference, client and deadline the
 * reading had just found in the documents. Now the person confirms those facts
 * on the review, and this records them through the ordinary commands:
 * `registerOpportunity` for the pursuit (linked to the project, so its title and
 * value come from the project) and `recordInvitation` for the invitation, with
 * every rule both already apply — a deadline before the issue date is refused,
 * an assumed zone is a critical clarification.
 *
 * Where the project already has an invitation, that one is used and nothing is
 * recorded: an invitation is amended by addendum, never recorded twice.
 * `governance` is the tenancy's pipeline context, where pursuits live.
 */
export function invitationForReading(
  governance: EngineContext,
  input: { projectId: string; invitation: InvitationFromReading },
): { invitationId: string; created: boolean } {
  const opportunities = governance.ledger
    .listByTenant(governance.tenantId, 'Opportunity')
    .map((record) => record.state)
    .filter(
      (state) =>
        String(state.projectId ?? '') === input.projectId || String(state.convertedProjectId ?? '') === input.projectId,
    );
  const invitations = governance.ledger.listByTenant(governance.tenantId, 'TenderInvitation').map((record) => record.state);
  const closed = (state: Record<string, unknown>): boolean => CLOSED_STAGES.includes(String(state.stage ?? ''));
  for (const opportunity of opportunities) {
    const held = invitations.filter((state) => String(state.opportunityId ?? '') === String(opportunity.id)).at(-1);
    if (!held) continue;
    // A reading filed onto a closed tender is how an old matrix came back to
    // life under a new bid. Said, rather than quietly reused.
    if (closed(opportunity)) {
      throw new DomainError(
        'TENDER_CLOSED',
        `The tender on this project, ${String(held.reference ?? '')}, is ${String(opportunity.stage).toLowerCase().replace('_', ' ')}. ` +
          'A reading is filed against a live tender; a new tender for the same job is opened as a new project.',
        409,
      );
    }
    return { invitationId: String(held.id), created: false };
  }

  const live = opportunities.filter((state) => !closed(state)).at(-1);
  const opportunityId = live
    ? String(live.id)
    : registerOpportunity(governance, {
        clientName: input.invitation.clientName,
        source: 'Read from the tender pack',
        projectId: input.projectId,
        submissionDueAt: input.invitation.returnLocal.slice(0, 10),
      }).opportunityId;
  const recorded = recordInvitation(governance, opportunityId, {
    reference: input.invitation.reference,
    issuedAt: input.invitation.issuedAt,
    returnLocal: input.invitation.returnLocal,
    timeZone: input.invitation.timeZone,
    timeZoneStated: input.invitation.timeZoneStated,
    channel: input.invitation.channel,
    ...(input.invitation.clarificationLocal ? { clarificationLocal: input.invitation.clarificationLocal } : {}),
    ...(input.invitation.siteVisitLocal ? { siteVisitLocal: input.invitation.siteVisitLocal } : {}),
  });
  return { invitationId: recorded.invitationId, created: true };
}

/**
 * Confirm a reading of the pack, recording the invitation from it where the
 * project has none.
 *
 * The draft is checked to be a tender reading the person may confirm *before*
 * anything is recorded, so a refusal leaves no invitation behind. Where the
 * confirmation itself then fails — a matrix the analyst refuses — the
 * invitation stays, and confirming again finds and uses it rather than
 * recording a second.
 */
export async function confirmReading(
  ctx: EngineContext,
  governance: () => EngineContext,
  input: ConfirmInput & { invitation?: InvitationFromReading },
): Promise<{ draftId: string; task: string; result: Record<string, unknown> }> {
  const { invitation, ...rest } = input;
  if (!invitation) return confirm(ctx, rest);
  if (rest.invitationId) {
    throw new DomainError(
      'INVITATION_TWICE',
      'Either file the reading against an invitation already recorded, or record the invitation it read — not both.',
      400,
      [{ field: 'invitation', message: 'leave out when an invitation is chosen' }],
    );
  }
  const draft = requireDraft(ctx, rest.draftId);
  if (draft.task !== 'ITT_REQUIREMENTS') {
    throw new DomainError('NOT_A_TENDER_READING', 'Only a reading of a tender records an invitation.', 400, [
      { field: 'invitation', message: 'only for a tender reading' },
    ]);
  }
  const definition = PERCEPTION_TASKS[draft.task];
  authorise(ctx, definition.area, definition.code, { lifecyclePhase: currentPhase(ctx) });

  const filed = invitationForReading(governance(), { projectId: ctx.projectId, invitation });
  const confirmed = await confirm(ctx, { ...rest, invitationId: filed.invitationId });
  return { ...confirmed, result: { ...confirmed.result, invitationId: filed.invitationId, invitationRecorded: filed.created } };
}

// --- The checks ---------------------------------------------------------------

export type ReadingCheck = {
  id: string;
  /** ATTENTION: look before confirming. NOTE: worth knowing, not wrong. */
  severity: 'ATTENTION' | 'NOTE';
  title: string;
  detail: string;
  references: string[];
};

export type ReadingChecks = { checks: ReadingCheck[]; attention: number; summary: string };

/** Lower case, one kind of quote and dash, whitespace collapsed — how a quote is matched to the pack. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/;

function readLocal(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  return LOCAL_DATE_TIME.test(text) ? text.replace(' ', 'T') : undefined;
}

/**
 * Where a reading needs a person's eye, found by code rather than by trust.
 *
 * Every check is something a wrong reading actually does: a deadline that is
 * not a date, a zone nobody stated, weightings that do not add up, a word limit
 * that is not a number, a requirement whose words appear nowhere in the pack, a
 * drawing note read as a requirement, the marking scheme read as a question.
 * None of them blocks the confirmation — a person may know better — but each is
 * shown first, with the references it concerns.
 */
export function checkTenderReading(
  extraction: Record<string, unknown>,
  packTextValue: string,
  options: { today: string },
): ReadingChecks {
  const checks: ReadingCheck[] = [];
  const add = (check: ReadingCheck): void => {
    checks.push(check);
  };
  const pack = normalise(packTextValue);
  const found = (value: unknown): boolean => {
    const quote = typeof value === 'string' ? normalise(value) : '';
    return quote.length >= 8 && pack.includes(quote);
  };

  const requirements = (Array.isArray(extraction.requirements) ? extraction.requirements : []) as Array<Record<string, unknown>>;
  const deliverables = (Array.isArray(extraction.deliverables) ? extraction.deliverables : []) as Array<Record<string, unknown>>;
  const ref = (line: Record<string, unknown>, index: number): string => String(line.reference ?? '').trim() || `line ${index + 1}`;

  // The deadline, as a date the platform can hold.
  const returnLocal = readLocal(extraction.returnByLocal);
  if (!returnLocal) {
    add({
      id: 'DEADLINE_UNREAD',
      severity: 'ATTENTION',
      title: 'The return deadline was not read as a date and time',
      detail:
        `The reading gives "${String(extraction.returnByLocal ?? extraction.returnBy ?? 'nothing')}". Enter the deadline ` +
        'exactly as the invitation prints it before confirming.',
      references: [],
    });
  } else if (returnLocal.slice(0, 10) < options.today) {
    add({
      id: 'DEADLINE_PAST',
      severity: 'ATTENTION',
      title: 'The return deadline read is in the past',
      detail: `${returnLocal.replace('T', ' ')} is before today. Either the invitation has closed or the date was misread.`,
      references: [],
    });
  }
  if (!extraction.returnTimeZone) {
    add({
      id: 'ZONE_NOT_STATED',
      severity: 'NOTE',
      title: 'The invitation does not state a time zone',
      detail:
        'The deadline is held in Europe/London unless you choose otherwise, and an assumed zone is raised as a ' +
        'critical clarification to put to the buyer.',
      references: [],
    });
  }
  const questionsBy = readLocal(extraction.clarificationLocal);
  if (questionsBy && returnLocal && questionsBy >= returnLocal) {
    add({
      id: 'QUESTIONS_AFTER_RETURN',
      severity: 'ATTENTION',
      title: 'The last date for questions is not before the return deadline',
      detail: `Questions close ${questionsBy.replace('T', ' ')} and returns are due ${returnLocal.replace('T', ' ')}. One of the two was misread.`,
      references: [],
    });
  }

  // Weightings: the scored questions' marks.
  const weighted = requirements
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.mandatory !== true && typeof line.weightingPercent === 'number' && Number.isFinite(line.weightingPercent));
  if (weighted.length > 0) {
    const total = weighted.reduce((sum, { line }) => sum + Number(line.weightingPercent), 0);
    if (Math.abs(total - 100) > 0.5) {
      add({
        id: 'WEIGHTS_TOTAL',
        severity: 'ATTENTION',
        title: `The weightings add to ${Math.round(total * 10) / 10}%, not 100%`,
        detail:
          'Either a scored question was missed or merged, or the weightings are shares of the whole bid rather than ' +
          'of the quality mark. Check them against the evaluation section before confirming.',
        references: weighted.map(({ line, index }) => ref(line, index)),
      });
    }
    const unweighted = requirements
      .map((line, index) => ({ line, index }))
      .filter(
        ({ line }) =>
          line.mandatory !== true &&
          (line.weightingPercent === null || line.weightingPercent === undefined) &&
          (line.wordLimit != null || line.pageLimit != null),
      );
    if (unweighted.length > 0) {
      add({
        id: 'LIMIT_WITHOUT_WEIGHT',
        severity: 'NOTE',
        title: `${unweighted.length} answered question(s) carry a limit but no weighting`,
        detail: 'Where the other questions are weighted, one with a word limit and no marks is usually a weighting missed.',
        references: unweighted.map(({ line, index }) => ref(line, index)),
      });
    }
  }

  // Limits that are not counts.
  const badLimits = requirements
    .map((line, index) => ({ line, index }))
    .filter(({ line }) =>
      [line.wordLimit, line.pageLimit].some((value) => value !== null && value !== undefined && (!Number.isInteger(value) || Number(value) <= 0)),
    );
  if (badLimits.length > 0) {
    add({
      id: 'LIMIT_UNREADABLE',
      severity: 'ATTENTION',
      title: 'A word or page limit is not a whole number',
      detail: 'A limit is a count. Correct it from the document; anything past a stated limit is usually not read.',
      references: badLimits.map(({ line, index }) => ref(line, index)),
    });
  }

  // References that appear twice.
  const seen = new Map<string, number>();
  for (const [index, line] of requirements.entries()) {
    const key = ref(line, index).toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
  if (repeated.length > 0) {
    add({
      id: 'REFERENCE_REPEATED',
      severity: 'ATTENTION',
      title: 'Two requirements carry the same reference',
      detail: 'The matrix keeps one line per reference, so one of these would be lost. Give each its own or merge them.',
      references: repeated,
    });
  }

  // Lines that are not requirements at all.
  const drawingNotes = requirements
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isDrawingNote(String(line.requirement ?? '')));
  if (drawingNotes.length > 0) {
    add({
      id: 'DRAWING_NOTE',
      severity: 'ATTENTION',
      title: `${drawingNotes.length} line(s) are notes printed on a drawing`,
      detail: 'A drawing note is not something the bidder must satisfy. Remove these before confirming.',
      references: drawingNotes.map(({ line, index }) => ref(line, index)),
    });
  }
  const markingScheme = requirements
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isEvaluationMethod(String(line.requirement ?? '')));
  if (markingScheme.length > 0) {
    add({
      id: 'MARKING_SCHEME',
      severity: 'NOTE',
      title: 'The marking scheme was read as a requirement',
      detail: 'How the bid is marked is not a question to answer; no response is planned against it.',
      references: markingScheme.map(({ line, index }) => ref(line, index)),
    });
  }

  // Traceability: every line's words are somewhere in the pack.
  const untraced = requirements
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => !found(line.sourceQuote) && !found(line.requirement));
  if (untraced.length > 0) {
    add({
      id: 'NOT_IN_PACK',
      severity: 'ATTENTION',
      title: `${untraced.length} requirement(s) could not be found in the documents`,
      detail:
        'Neither the quoted passage nor the requirement’s own words appear in the pack. It may be paraphrased, or ' +
        'it may not be there at all. Check each against the documents before confirming.',
      references: untraced.map(({ line, index }) => ref(line, index)),
    });
  }
  if (deliverables.length === 0) {
    add({
      id: 'NO_RETURNS',
      severity: 'ATTENTION',
      title: 'Nothing was read as a document to return',
      detail: 'Every tender asks for something back — at least the priced schedule and a form of tender. Check the instructions.',
      references: [],
    });
  } else {
    const untracedReturns = deliverables
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => !found(line.sourceQuote) && !found(line.title));
    if (untracedReturns.length > 0) {
      add({
        id: 'RETURN_NOT_IN_PACK',
        severity: 'ATTENTION',
        title: `${untracedReturns.length} return item(s) could not be found in the documents`,
        detail: 'Neither the quoted passage nor the item’s title appears in the pack. Check it before confirming.',
        references: untracedReturns.map(({ line, index }) => ref(line, index)),
      });
    }
  }

  const attention = checks.filter((check) => check.severity === 'ATTENTION').length;
  return {
    checks,
    attention,
    summary:
      checks.length === 0
        ? 'Every check passed: dates read, weightings add to 100%, every line found in the documents.'
        : `${attention} to look at before confirming, ${checks.length - attention} to note.`,
  };
}
