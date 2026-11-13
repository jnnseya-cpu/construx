import { expertBriefing } from '../ai/expertise.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, currentPhase, runAI, write, type EngineContext } from '../engines/context.ts';
import type { DocumentBlock } from '../export/exporter.ts';
import {
  complianceMatrix,
  liveWaivers,
  type MatrixLine,
  type RequirementCategory,
  type RequirementWaiver,
  type ResponseLimit,
  type StoredITTAnalysis,
} from './itt.ts';
import { approvedOn, standingOf, type EvidenceClaim } from './evidenceclaim.ts';
import { openImpacts, type AddendumImpact } from './addendum.ts';
// One direction only. The red team reads the pack out of the ledger itself
// rather than importing this module's readers, so the dependency between the
// two does not become a cycle.
import { assuranceStanding, DEFAULT_QUALITY_FLOOR_PERCENT, latestReview } from './redteam.ts';

/**
 * The bid response pack: the half of a tender the platform could read but not
 * write.
 *
 * `itt.ts` reads an invitation to tender and produces the register, the
 * compliance matrix, the owner per requirement and the clarifications. It stops
 * exactly where the work starts. Somebody then opens a word processor and
 * writes the submission by hand against a matrix on another screen, which is
 * the several days this platform exists to remove.
 *
 * This writes it. Not as one call — as a pipeline.
 *
 * **Why a pipeline and not a command.** A large ITT carries sixty or eighty
 * requirements needing a written answer. One model call producing all of them
 * hits a token ceiling, and what a ceiling produces is not a refusal: it is a
 * document that stops mid-sentence at section forty-one, looking finished. The
 * ceiling then becomes the product's limit — a bid team learns the tool works
 * for small tenders, and stops using it on the ones worth winning.
 *
 * So the unit of work is **one section**, and the pack is written by calling
 * `writeNextSection` until nothing remains. Each call is bounded by the section
 * it writes, never by the size of the tender. There is no ceiling on the pack
 * because the pack is never produced in a single act.
 *
 * **Resume is not a separate path.** A pass that dies — a provider timeout, a
 * container restart, a wallet that emptied — leaves its section exactly as it
 * was, PLANNED. The next call looks for the first section that is not written
 * and writes it. That is the same code that ran the first time. There is no
 * checkpoint to restore, no half-written state to reconcile, and no way for
 * "resume" to be a path that works less well than the first run, because it is
 * not a path at all.
 *
 * **The pack is a numbered document, not an export.** It carries `BID-nnnn`
 * from the moment it is planned, so it can be referenced in a clarification,
 * quoted in a covering letter and found afterwards. The reference is issued at
 * planning and never recomputed.
 *
 * **One machine check, and it refuses.** `issue` is the mirror of the tender
 * pack's own completeness gate: that one will not issue an enquiry whose
 * package is incomplete, because incomparable returns are worse than a late
 * enquiry. This one will not issue a submission that does not answer every
 * deliverable the buyer asked for, and will not issue one whose stated
 * deadlines carry no date. A submission missing a mandatory response is not
 * marked down; it is rejected, and the several days that went into the rest of
 * it are spent for nothing. A warning would leave that decision to whoever is
 * most tired at 4pm on the return date.
 *
 * What it does not do is decide. The pack is drafted, and a named person issues
 * it — `BID_RESPONSE_ISSUED` is not an event an agent may author, for the same
 * reason no agent mandate exceeds propose.
 */

/** What the platform can write against a requirement, and what it cannot. */
export type BidSectionStatus = 'PLANNED' | 'DRAFTED';

export type BidSection = {
  /** Stable across passes: the matrix reference the section answers. */
  key: string;
  title: string;
  /** The deliverable, in the buyer's own words, that this section responds to. */
  deliverable: string;
  /** The role that owns it, carried from the compliance matrix. */
  owner: string;
  mandatory: boolean;
  status: BidSectionStatus;
  /**
   * How long the buyer said this answer may be, carried from the matrix line.
   *
   * On the section rather than looked up at the gate, so the limit a submission
   * was written against is the limit it is checked against. An addendum that
   * changes a limit already invalidates the section through `staleSections`,
   * which is the mechanism that exists for exactly this.
   */
  limit?: ResponseLimit;
  /** Paragraphs. Absent until a pass writes it. */
  body?: string[];
  words?: number;
  /**
   * Who wrote the prose. Never removed by a later edit: a person who rewrites
   * every sentence of a draft still started from one, and the record says so.
   */
  authorship?: 'AI_DRAFTED' | 'HUMAN';
  provider?: string;
  modelClass?: string;
  writtenAt?: string;
};

/** A date the buyer stated. The check refuses an undated one. */
export type BidDeadline = {
  what: string;
  /** ISO date. Absent is the condition the issue check exists to catch. */
  on?: string;
};

/**
 * What the pack's sections were planned from.
 *
 * `SCORED_QUESTIONS`: the buyer marks a questionnaire, so the pack answers those
 * questions and nothing else. `WRITTEN_REQUIREMENTS`: no question carries a mark,
 * so every requirement needing a written answer is one. Absent on a pack planned
 * before the distinction existed, which planned the second way.
 */
export type PlanBasis = 'SCORED_QUESTIONS' | 'WRITTEN_REQUIREMENTS';

export type BidResponsePack = {
  id: string;
  reference: string;
  projectId: string;
  analysisId: string;
  clientName: string;
  returnBy: string;
  basis?: PlanBasis;
  /** Set when the sections were planned again from a matrix; the earlier plan stays on the ledger. */
  replannedAt?: string;
  replannedBy?: string;
  sections: BidSection[];
  deadlines: BidDeadline[];
  status: 'DRAFTING' | 'ISSUED';
  /** How many passes have run. Reported so a stall is visible as a number. */
  passes: number;
  /**
   * The quality floor this pack's issue is held to, as a percentage of a scored
   * requirement's findable marks — the product's "4/5".
   *
   * Set at planning so the bar is on the record, and settable per pack. Absent
   * on packs planned before the floor existed, which read as the default. The
   * gate enforces it through the red team: a scored requirement answered below
   * the floor becomes a high finding, which blocks the issue until a named
   * person records a reason — a soft block, because a genuinely unreachable
   * mark must not trap a legitimate bid.
   */
  qualityFloorPercent?: number;
  plannedAt: string;
  plannedBy: string;
  issuedAt?: string;
  issuedBy?: string;
};

/**
 * Which requirements need prose.
 *
 * A matrix line the platform can already evidence from its own records —
 * insurances on file, an accreditation held — is a document to attach, not a
 * method statement to write, and asking a model to write around evidence that
 * exists is how a submission acquires a paragraph contradicting its own
 * appendix. Those lines stay in the checklist and out of the drafting queue.
 */
/**
 * The categories whose answer an evaluator reads as written prose — the quality
 * side of a submission. A requirement outside these, and not separately scored,
 * is satisfied some other way and is not an essay: the price lives in the priced
 * schedule (Appendix B), the submission logistics are process, qualification and
 * insurance are satisfied by the company's recorded facts and its evidence, and
 * the commercial terms sit in the quotation.
 */
const NARRATIVE_CATEGORIES: ReadonlySet<RequirementCategory> = new Set([
  'QUALITY',
  'TECHNICAL',
  'SOCIAL_VALUE',
  'ENVIRONMENTAL',
  'PROGRAMME',
  'HEALTH_AND_SAFETY',
]);

/**
 * Whether this requirement needs a written answer drafted for it.
 *
 * It used to be "anything with no evidence attached", and that is what turned a
 * priced schedule and a page of submission logistics into a stack of blank essay
 * questions: a pricing-schedule line, an In-Tend-portal line and a return-deadline
 * line all have no evidence held against them, and none of them is answered by
 * prose — the price is in Appendix B, the portal is the portal, the date is a
 * date. A bidder faced with twenty-six "write an answer" sections for a schedule
 * they had already priced is a bidder who stops trusting the tool, and rightly.
 *
 * A requirement needs prose when it is a written answer an evaluator reads and
 * marks: a scored question whatever its category, or an unscored requirement in
 * one of the narrative categories above — and only when the platform does not
 * already hold a document that answers it. Everything else is satisfied by the
 * price, the evidence, the company's facts, the quotation or the portal, and is
 * not dragged into the essay pack.
 */
export function needsProse(line: MatrixLine): boolean {
  if (line.evidenceHeld !== undefined && line.evidenceHeld !== '') return false;
  if (line.weightingPercent !== undefined && line.weightingPercent > 0) return true;
  return NARRATIVE_CATEGORIES.has(line.category);
}

function titleFor(line: MatrixLine): string {
  const words = line.requirement.trim().replace(/\s+/g, ' ');
  return words.length <= 70 ? words : `${words.slice(0, 67)}…`;
}

/**
 * Wording that is a note to whoever finishes the bid, not an answer to the buyer.
 *
 * "The bid team will insert the inspection frequency", "(to be inserted)", "the
 * quantum placeholder". Each one is a gap an evaluator reads and scores as a
 * gap — and the drafter used to be told to write them. Deliberately narrow: it
 * catches a note addressed to a team or a blank waiting to be filled, and not
 * the buyer's own words quoted back ("signs and diversion to be provided", "all
 * levels to be agreed with the supervisor"), which an answer is right to quote.
 */
const UNFINISHED: readonly RegExp[] = [
  /\b(?:bid|tender) team\s+(?:will|shall|must|should|can|to|is to|are to)\s+(?:insert|populate|complete|confirm|add|provide|fill|enter|state|supply|name|define)\b/gi,
  /\bto be (?:inserted|populated|filled(?: in)?)\b/gi,
  /\bplaceholders?\b/gi,
  /\[(?:insert|tbc|tbd|tba|name|date|value|x{2,})[^\]]*\]/gi,
  /\b(?:TBC|TBD|TBA)\b/g,
];

/** Each unfinished note in a piece of prose, quoted with enough around it to find it. */
export function unfinishedPhrases(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of UNFINISHED) {
    for (const match of text.matchAll(pattern)) {
      const start = Math.max(0, (match.index ?? 0) - 40);
      const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 40);
      found.add(`${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`);
    }
  }
  return [...found];
}

/**
 * Job titles that say the firm has staff it does not.
 *
 * Only asked of a firm that has said it is one person (`singleOwnerBids`), because
 * only then does the platform know the claim is false: "our Bid Manager and
 * Planning Lead have prepared and signed the programme", from a sole director,
 * is a statement an evaluator can test at interview. Roles the owner can hold
 * himself — project manager, site manager, temporary works coordinator — are not
 * listed. A sentence that names one of the firm's own people is the owner being
 * given the title, and is left alone.
 */
const SEPARATE_STAFF =
  /\b(bid (?:manager|director|team)|tender team|planning (?:lead|manager|team)|planner|quality manager|commercial manager|quantity surveyor|estimator|(?:senior )?technical reviewer|design manager|contracts manager|health (?:and|&) safety (?:manager|advis[eo]r|lead)|h&s (?:manager|advis[eo]r|lead)|environmental (?:manager|advis[eo]r))\b/gi;

/** The separate-staff titles a sentence claims without naming one of the firm's own people. */
export function unsupportedRoles(text: string, people: readonly string[]): string[] {
  const names = people.map((person) => person.trim().toLowerCase()).filter((person) => person.length > 2);
  const found = new Set<string>();
  for (const sentence of text.split(/(?<=[.;!?])\s+|\n+/)) {
    const lower = sentence.toLowerCase();
    if (names.some((name) => lower.includes(name) || lower.includes(name.split(/\s+/).at(-1)!))) continue;
    for (const match of sentence.matchAll(SEPARATE_STAFF)) found.add(match[1]!.toLowerCase());
  }
  return [...found];
}

/**
 * A note printed on a drawing, read in as if it were a question.
 *
 * "All dimensions are in metres unless otherwise stated", "Note 4 — any
 * anomalies on this drawing…". A section answering one is an essay on a
 * drawing convention, and an evaluator reads a run of them as padding.
 */
const DRAWING_NOTE =
  /^\W*(?:note\s*\d+\b|\d+\.\s*all (?:dimensions|chainages|levels)|all (?:dimensions|chainages|levels) (?:are|shown|shall)|this drawing is to be read|any anomalies on this drawing|all dimensions shall be confirmed)/i;

export function isDrawingNote(requirement: string): boolean {
  return DRAWING_NOTE.test(requirement.replace(/\\[nrt]/g, ' ').trim());
}

/**
 * A line that states how the bid is marked rather than asking anything.
 *
 * "Selection will be on the basis of 30% quality and 70% price", "the lowest
 * bid will score the maximum points". A reading can carry the split's
 * percentage as the line's weighting, which made the marking scheme itself a
 * "scored question" with an essay planned against it. Narrow on purpose: both a
 * quality and a price percentage in one sentence, or the lowest price scoring
 * the maximum.
 */
const EVALUATION_METHOD =
  /(?=[\s\S]*\d+\s*%\s*(?:for\s+)?quality\b)(?=[\s\S]*\d+\s*%\s*(?:for\s+)?(?:price|cost)\b)|\blowest (?:bid|price|tender|cost)\b[\s\S]{0,40}\b(?:score|receive|awarded)/i;

export function isEvaluationMethod(requirement: string): boolean {
  return EVALUATION_METHOD.test(requirement.replace(/\\[nrt]/g, ' '));
}

/** A question the buyer marks from the written answer. */
function isScoredQuestion(line: MatrixLine): boolean {
  return (line.weightingPercent ?? 0) > 0 && needsProse(line);
}

/**
 * Which matrix lines the pack answers, and on what basis.
 *
 * The Conwy fault, stated so it is not repeated: the buyer scored seven
 * questions, 1,000 words each, and the pack planned ninety-six sections — one
 * per scope clause, hazard line, evaluation rule and drawing note — because the
 * rule was "every requirement in a narrative category". Sixty-nine pages of
 * answers the evaluator never marks, paid for a section at a time, with the
 * seven that are marked lost among them.
 *
 * So where the matrix holds any scored question, the pack is those questions —
 * plus any line the buyer gave a word or page limit, which is a written answer
 * however it is weighted. Everything else stays on the compliance matrix as an
 * obligation to meet, and is handed to the drafter as `context` so the answers
 * are about this job rather than generic. Only where no question carries a mark
 * does every requirement needing prose become a section, as before.
 *
 * Neither basis drafts a note printed on a drawing, or a statement of how the
 * bid is marked: neither is a question.
 */
export function planScope(
  matrix: readonly MatrixLine[],
  waived: ReadonlySet<string> = new Set(),
): { lines: MatrixLine[]; basis: PlanBasis; context: MatrixLine[] } {
  const candidates = matrix.filter(
    (line) => !waived.has(line.reference) && !isDrawingNote(line.requirement) && !isEvaluationMethod(line.requirement),
  );
  const scored = candidates.filter(isScoredQuestion);
  if (scored.length === 0) {
    return { lines: candidates.filter(needsProse), basis: 'WRITTEN_REQUIREMENTS', context: [] };
  }
  const lines = candidates.filter(
    (line) => needsProse(line) && (isScoredQuestion(line) || line.responseLimit?.words !== undefined || line.responseLimit?.pages !== undefined),
  );
  const answered = new Set(lines.map((line) => line.reference));
  const context = candidates.filter(
    (line) => !answered.has(line.reference) && NARRATIVE_CATEGORIES.has(line.category),
  );
  return { lines, basis: 'SCORED_QUESTIONS', context };
}

/**
 * The tender's other requirements, as the drafter reads them on a scored pack.
 * Bounded so a large scope cannot make every pass expensive: the first sixty,
 * each cut to 280 characters, is the job's constraints without the full text.
 */
function contextFor(lines: readonly MatrixLine[]): string[] {
  return lines.slice(0, 60).map((line) => {
    const text = line.requirement.replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim();
    return `${line.reference}: ${text.length > 280 ? `${text.slice(0, 277)}…` : text}`;
  });
}

function sectionFor(line: MatrixLine): BidSection {
  return {
    key: line.reference,
    title: titleFor(line),
    deliverable: line.requirement,
    owner: String(line.owner),
    mandatory: line.mandatory,
    status: 'PLANNED',
    ...(line.responseLimit ? { limit: line.responseLimit } : {}),
  };
}

/** The dated schedule: every date the matrix states, and the return date always. */
function deadlinesFor(analysis: StoredITTAnalysis): BidDeadline[] {
  return [
    ...analysis.matrix
      .filter((line) => line.dueBy !== undefined)
      .map((line) => ({ what: `${line.reference} — ${titleFor(line)}`, on: line.dueBy })),
    { what: 'Return of the completed submission', on: analysis.returnBy },
  ];
}

/** What the review needs to know beyond the pack: who the firm is, and the contract. */
export type SubmissionReviewContext = { singleOwner?: boolean; people?: string[]; contractForm?: string };

function reviewContextFor(ctx: EngineContext, pack: BidResponsePack): SubmissionReviewContext {
  const firm = firmFacts(ctx);
  const terms = ctx.ledger.get({ refType: 'ITTAnalysis', refId: pack.analysisId })?.state.commercialTerms as
    | { contractForm?: string }
    | undefined;
  return {
    singleOwner: firm.singleOwnerBids === true,
    people: firm.people as string[],
    ...(terms?.contractForm ? { contractForm: terms.contractForm } : {}),
  };
}

/**
 * The pack as the document the buyer reads.
 *
 * Every heading carries the requirement in full. The stored `title` is cut at 67
 * characters for screens, and printing it put "…/ Che…" in front of an evaluator
 * as the question being answered. A requirement short enough to be a heading is
 * one; a longer one is headed by its reference and stated in full beneath it, so
 * nothing the buyer asked is shortened. Read from `deliverable`, which every pack
 * already holds, so packs planned before this print correctly too.
 */
export function submissionBlocks(pack: Pick<BidResponsePack, 'sections'>): DocumentBlock[] {
  const blocks: DocumentBlock[] = [];
  for (const section of pack.sections) {
    // A requirement read out of a document can carry its line breaks as literal
    // "\n" text, which printed as `"Q7\n\n•\n\nThe Contractor's…` in front of an
    // evaluator. They are line breaks, so they are spaced like line breaks.
    const question = (section.deliverable || section.title)
      .replace(/\\[nrt]/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
    if (question.length <= 120) {
      blocks.push({ kind: 'HEADING', level: 2, text: `${section.key} — ${question}` });
    } else {
      blocks.push({ kind: 'HEADING', level: 2, text: section.key });
      blocks.push({ kind: 'KEY_VALUES', rows: [{ label: 'Requirement', value: question }] });
    }
    const paras = section.body ?? [];
    if (paras.length > 0) for (const paragraph of paras) blocks.push({ kind: 'PARAGRAPH', text: String(paragraph) });
    else blocks.push({ kind: 'PARAGRAPH', text: '[Not written yet]' });
  }
  return blocks;
}

/**
 * Plan the pack from a stored analysis.
 *
 * Derived, never typed twice. The checklist is the compliance matrix, the
 * responsibility matrix is the owner already on each line, and the deadline
 * schedule is each line's own date with the return date at the end of it. A
 * second register keyed by hand would be a second answer to what the buyer
 * asked for.
 */
export function planBidResponse(
  ctx: EngineContext,
  input: { analysisId: string },
): { pack: BidResponsePack; toWrite: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { lifecyclePhase: currentPhase(ctx) });

  const analysis: StoredITTAnalysis = complianceMatrix(ctx, input.analysisId);

  // One pack per analysis. Two packs answering one tender is two submissions,
  // and the one that goes out is whichever somebody opened last.
  const existing = ctx.ledger
    .list(ctx.projectId, 'BidResponsePack')
    .map((row) => row.state as unknown as BidResponsePack)
    .find((pack) => pack.analysisId === input.analysisId);
  if (existing) {
    throw new DomainError(
      'BID_RESPONSE_EXISTS',
      `${existing.reference} already answers ${analysis.reference}. Continue that pack rather than starting a second one — ` +
        'two packs answering one tender is two submissions, and the one that goes out is whichever somebody opened last.',
      409,
    );
  }

  // A requirement somebody has waived is not drafted. It leaves the queue and is
  // named on the pack instead, with its reason, so whoever signs the submission
  // sees what was left out on purpose rather than a checklist that quietly got
  // shorter.
  const waived = new Set(liveWaivers(ctx, input.analysisId).map((waiver) => waiver.reference));
  const scope = planScope(analysis.matrix, waived);
  const sections: BidSection[] = scope.lines.map(sectionFor);

  if (sections.length === 0) {
    throw new DomainError(
      'NOTHING_TO_WRITE',
      waived.size > 0
        ? `Every requirement on ${analysis.reference} is either evidenced from records the platform holds or waived, so ` +
          'there is no prose to draft. A submission that is entirely waivers and attachments is a decision worth making ' +
          'deliberately rather than arriving at.'
        : `Every requirement on ${analysis.reference} is already evidenced from records the platform holds, so there is no ` +
          'prose to draft. Attach the evidence and issue the submission from the matrix.',
      422,
    );
  }

  // The dated schedule. Each line's own date where the ITT stated one, and the
  // return date always, because a submission with no return date on its face is
  // the one that goes in the day after.
  const deadlines = deadlinesFor(analysis);

  const sequence = ctx.ledger.list(ctx.projectId, 'BidResponsePack').length + 1;
  const pack: BidResponsePack = {
    id: ulid(),
    reference: formatRef('BID', sequence),
    projectId: ctx.projectId,
    analysisId: analysis.analysisId,
    clientName: analysis.clientName,
    returnBy: analysis.returnBy,
    basis: scope.basis,
    sections,
    deadlines,
    status: 'DRAFTING',
    passes: 0,
    qualityFloorPercent: DEFAULT_QUALITY_FLOOR_PERCENT,
    plannedAt: new Date().toISOString(),
    plannedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_RESPONSE_PLANNED',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: pack as unknown as Record<string, unknown>,
  });

  return { pack, toWrite: sections.length };
}

/**
 * Plan a drafting pack's sections again, from its matrix or the tender's newer one.
 *
 * The way out for a pack planned under the old rule — ninety-six sections where
 * the buyer marks seven — and for a pack whose tender has since had its
 * questionnaire read. Same rule as planning (`planScope`), so a re-plan and a
 * fresh plan cannot disagree.
 *
 * Nothing written is thrown away twice over: a section whose requirement is
 * still planned, word for word, keeps its prose, its authorship and its status;
 * a section dropped from the plan stays on the ledger in the pack's earlier
 * state, so the record of what was written remains. Refused on an issued pack,
 * and refused where another pack already answers the target matrix — two packs
 * answering one tender is two submissions.
 */
export function replanBidResponse(
  ctx: EngineContext,
  input: { packId: string; analysisId?: string },
): { pack: BidResponsePack; kept: number; added: number; dropped: string[]; toWrite: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError(
      'BID_RESPONSE_ISSUED',
      `${pack.reference} has been issued. What was sent must stay what was sent — plan a new pack for a new submission.`,
      409,
    );
  }
  const analysisId = input.analysisId ?? pack.analysisId;
  const analysis = complianceMatrix(ctx, analysisId);
  if (analysisId !== pack.analysisId) {
    const other = ctx.ledger
      .list(ctx.projectId, 'BidResponsePack')
      .map((row) => row.state as unknown as BidResponsePack)
      .find((entry) => entry.id !== pack.id && entry.analysisId === analysisId);
    if (other) {
      throw new DomainError(
        'BID_RESPONSE_EXISTS',
        `${other.reference} already answers ${analysis.reference}. Re-plan that pack instead — two packs answering one ` +
          'tender is two submissions.',
        409,
      );
    }
  }

  const waived = new Set(liveWaivers(ctx, analysisId).map((waiver) => waiver.reference));
  const scope = planScope(analysis.matrix, waived);
  if (scope.lines.length === 0) {
    throw new DomainError(
      'NOTHING_TO_WRITE',
      `Nothing on ${analysis.reference} needs a written answer — every requirement is evidenced from records, waived, ` +
        `a drawing note or the marking scheme. ${pack.reference} is left as it was.`,
      422,
    );
  }

  const previous = new Map(pack.sections.map((section) => [section.key, section]));
  let kept = 0;
  const sections = scope.lines.map((line) => {
    const fresh = sectionFor(line);
    const before = previous.get(line.reference);
    if (before && before.deliverable === line.requirement && (before.body ?? []).length > 0) {
      kept += 1;
      // The prose stays; the line's current owner, flag and limit replace the old.
      const carried: BidSection = { ...before, title: fresh.title, owner: fresh.owner, mandatory: fresh.mandatory };
      delete carried.limit;
      if (fresh.limit) carried.limit = fresh.limit;
      return carried;
    }
    return fresh;
  });
  const planned = new Set(sections.map((section) => section.key));
  const dropped = pack.sections.filter((section) => !planned.has(section.key)).map((section) => section.key);

  const next: BidResponsePack = {
    ...pack,
    analysisId,
    clientName: analysis.clientName,
    returnBy: analysis.returnBy,
    basis: scope.basis,
    sections,
    deadlines: deadlinesFor(analysis),
    replannedAt: new Date().toISOString(),
    replannedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_RESPONSE_REPLANNED',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: next as unknown as Record<string, unknown>,
    reason:
      `Re-planned from ${analysis.reference} on ${scope.basis === 'SCORED_QUESTIONS' ? 'its scored questions' : 'its written requirements'}: ` +
      `${sections.length} section(s), ${kept} kept with their prose, ${dropped.length} dropped`,
  });

  return {
    pack: next,
    kept,
    added: sections.length - kept,
    dropped,
    toWrite: sections.filter((section) => section.status === 'PLANNED').length,
  };
}

function requirePack(ctx: EngineContext, packId: string): BidResponsePack {
  const record = ctx.ledger.get({ refType: 'BidResponsePack', refId: packId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_RESPONSE_NOT_FOUND', `No bid response pack ${packId}`, 404);
  }
  return record.state as unknown as BidResponsePack;
}

/**
 * One pass: write the next section that has none.
 *
 * The whole pipeline is this function called until `remaining` is zero. It
 * spends nothing when there is nothing left, so a caller that loops one time
 * too many is not charged for the privilege — which matters, because the
 * natural way to drive this is a loop that stops on `remaining === 0` and the
 * natural bug in that loop is running it once more.
 */
export async function writeNextSection(
  ctx: EngineContext,
  input: { packId: string },
): Promise<{
  pack: BidResponsePack;
  /** The section this pass wrote, or null when there was nothing to write. */
  written: BidSection | null;
  remaining: number;
  acuConsumed: number;
}> {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError(
      'BID_RESPONSE_ISSUED',
      `${pack.reference} has been issued. Editing a submission after it has gone to the buyer is not a draft change, ` +
        'and the record of what was sent must stay what was sent.',
      409,
    );
  }

  const next = pack.sections.find((section) => section.status === 'PLANNED');
  if (!next) return { pack, written: null, remaining: 0, acuConsumed: 0 };

  const drafted = await draftSection(ctx, pack, next);
  return {
    ...drafted,
    remaining: drafted.pack.sections.filter((section) => section.status === 'PLANNED').length,
  };
}

/**
 * Write one section again, from the requirement, with the drafter as it now is.
 *
 * The way forward from the unfinished-text check. A section the drafter left
 * holding a note to the bid team is answered again rather than edited around —
 * the note is where the answer should have been, and a person filling sixty of
 * them by hand on the last afternoon is how one is missed.
 *
 * Only a section the drafter wrote. One a person has rewritten is theirs, and a
 * model overwriting it would take the words out of somebody's mouth; they edit
 * it instead. Refused on an issued pack for the same reason every write is.
 */
export async function redraftSection(
  ctx: EngineContext,
  input: { packId: string; key: string },
): Promise<{ pack: BidResponsePack; written: BidSection; acuConsumed: number }> {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError(
      'BID_RESPONSE_ISSUED',
      `${pack.reference} has been issued. Editing a submission after it has gone to the buyer is not a draft change, ` +
        'and the record of what was sent must stay what was sent.',
      409,
    );
  }
  const section = pack.sections.find((entry) => entry.key === input.key);
  if (!section) {
    throw new DomainError('BID_SECTION_NOT_FOUND', `${pack.reference} has no section ${input.key}`, 404);
  }
  if (section.authorship === 'HUMAN') {
    throw new DomainError(
      'BID_SECTION_HUMAN_WRITTEN',
      `${input.key} was rewritten by a person, so it is theirs to change — edit it rather than have the drafter ` +
        'replace their words.',
      409,
    );
  }
  // Its own task type, as the shortener has: a quote identifies a route by the
  // task it declares, and one task on two routes is one the quote cannot price.
  const drafted = await draftSection(ctx, pack, section, 'bid_response_redraft');
  return { pack: drafted.pack, written: drafted.written!, acuConsumed: drafted.acuConsumed };
}

/** The firm's own facts, so the drafter names its real people and claims no team it does not have. */
function firmFacts(ctx: EngineContext): Record<string, unknown> {
  const profile = ctx.ledger.get({ refType: 'CompanyProfile', refId: `${ctx.tenantId}-profile` })?.state;
  const people = [
    ...new Set(
      ctx.ledger
        .list(`${ctx.tenantId}-governance`, 'User')
        .map((record) => String(record.state.name ?? '').trim())
        .filter((name) => name.length > 0),
    ),
  ].slice(0, 12);
  return {
    ...(profile?.legalName ? { name: String(profile.legalName) } : {}),
    people,
    singleOwnerBids: profile?.singleOwnerBids === true,
    accreditations: Array.isArray(profile?.accreditations) ? profile.accreditations : [],
    selfDeliveredTrades: Array.isArray(profile?.selfDeliveredTrades) ? profile.selfDeliveredTrades : [],
  };
}

/** Draft `next` into the pack and record it — shared by the first pass and a redraft. */
async function draftSection(
  ctx: EngineContext,
  pack: BidResponsePack,
  next: BidSection,
  taskType: 'bid_response_section' | 'bid_response_redraft' = 'bid_response_section',
): Promise<{ pack: BidResponsePack; written: BidSection | null; acuConsumed: number }> {
  const analysis = complianceMatrix(ctx, pack.analysisId);
  const line = analysis.matrix.find((entry) => entry.reference === next.key);
  // On a scored pack the rest of the tender — scope, hazards, constraints — is
  // not answered section by section, so the drafter is given it to make each
  // scored answer about this job. Marked down as generic is the alternative.
  const tenderContext =
    pack.basis === 'SCORED_QUESTIONS'
      ? contextFor(
          planScope(analysis.matrix, new Set(liveWaivers(ctx, pack.analysisId).map((waiver) => waiver.reference))).context,
        )
      : [];

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType,
    capability: 'REASONING',
    inputRefs: [{ refType: 'ITTAnalysis', refId: pack.analysisId }],
    request: {
      task:
        `${expertBriefing('BID_MANAGER')} ` +
        'Now write one section of a construction tender submission, answering one stated requirement — in the voice of ' +
        'that bid manager: answer every element the requirement names, in the buyer’s own words, with the method and ' +
        'the measurable commitments it asks for, and nothing it does not. Return JSON with `body`: an array of ' +
        'paragraph strings.',
      payload: {
        client: pack.clientName,
        requirement: next.deliverable,
        evidenceRequired: line?.evidenceRequired ?? '',
        category: line?.category ?? '',
        mandatory: next.mandatory,
        // Who the firm is and who is in it. Without this the drafter wrote "our
        // Bid Manager and Planning Lead have prepared and signed the programme"
        // for a one-person firm — a claim about staff an evaluator can test at
        // interview, made from nothing but the routing label below.
        firm: firmFacts(ctx),
        ...(tenderContext.length > 0
          ? {
              tenderContext,
              tenderContextUse:
                'The buyer’s other requirements for these works. They are not questions to answer one by one; use ' +
                'the ones this question touches so the answer is specific to this site and job.',
            }
          : {}),
        // Given to the writer rather than only checked afterwards. A pass that
        // produces 1,400 words against a 1,000-word limit is a pass somebody
        // pays for and then has to cut by hand, and the cut is where the
        // answer loses the thing it was scoring on.
        ...(next.limit ? { limit: next.limit } : {}),
        // The bar the red team will hold this to, stated so the draft aims at
        // it. Best-effort and honest: this is the findable mark the platform's
        // own evaluator can measure in the prose, not the buyer's actual mark,
        // which no drafter can guarantee. Aiming at it is what a drafter can do.
        qualityTarget:
          `Write so a scorer can find and award at least ${pack.qualityFloorPercent ?? DEFAULT_QUALITY_FLOOR_PERCENT}% ` +
          'of this requirement’s marks without inferring anything: answer every element it names, in the buyer’s own ' +
          'words, with the method and the measurable commitments it asks for. That bar is the findable mark, not a ' +
          'promise of the buyer’s own mark.',
        constraint:
          'Answer the requirement and nothing else. State no figure, no completion percentage, no customer name and no ' +
          'past project you have not been given — an invented reference in a submission is a false statement to a buyer ' +
          'and grounds for disqualification. Name only the people in `firm.people`, and claim no team, department or ' +
          'job title the firm does not have; where `firm.singleOwnerBids` is true the firm is one person, so every ' +
          'responsibility rests with that named person, with specialist subcontractors (by trade, not by name) for ' +
          'work the firm buys in. This text goes to the buyer exactly as written: never leave a gap, a bracket, or a ' +
          'note to a bid team, tender team or anyone else to insert, populate, confirm or complete something later — ' +
          'an evaluator reads that as an unfinished answer and scores it so. Where a value depends on facts not yet ' +
          'known (a start date, a design output, an award date), commit to how and when it will be fixed and who ' +
          'fixes it — for example "confirmed in the construction phase plan before start on site" — rather than ' +
          'leaving a blank. Where the buyer asks for an operational commitment (an inspection frequency, a response ' +
          'time), commit to one that is normal UK practice for the work; the person reviewing this draft can change ' +
          'it. Write in the first person plural, in British English, as a contractor answering a client. Do not ' +
          'restate the question.' +
          (next.limit?.words
            ? ` The buyer states a limit of ${next.limit.words} words (${next.limit.statedAs}); anything past it is ` +
              'not read, so answer within it rather than writing long and leaving somebody to cut it.'
            : '') +
          (next.limit?.pages && !next.limit.words
            ? ` The buyer states a limit of ${next.limit.pages} page(s) (${next.limit.statedAs}); write to fit it.`
            : ''),
      },
    },
    // The draft is state and is written below under its own event. Returning
    // writes here would commit the section twice.
    toWrites: () => [],
    // Refused before it is paid for. The local adapter answers every request
    // with the same sentence, and a submission carrying it would be prose
    // attributed to reasoning that never happened — sent to a buyer, under the
    // company's name, as its answer to a mandatory requirement.
    requireModel: {
      code: 'NO_REASONING_PROVIDER',
      message:
        'This deployment is running the local stand-in, which reasons about nothing. It cannot write a tender ' +
        'submission, and sending what it returns to a buyer would be a false statement under the company name. ' +
        'Configure a reasoning provider and set AI_MODE=production.',
    },
  });

  const output = result.output as { body?: unknown };
  const body = Array.isArray(output.body) ? output.body.map((line_) => String(line_).trim()).filter(Boolean) : [];
  if (body.length === 0) {
    throw new DomainError(
      'BID_SECTION_UNUSABLE',
      `The model returned no prose for ${next.key}. The section is unchanged and the next pass will try it again.`,
      502,
    );
  }

  const written: BidSection = {
    ...next,
    status: 'DRAFTED',
    body,
    words: body.join(' ').split(/\s+/).filter(Boolean).length,
    authorship: 'AI_DRAFTED',
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.modelClass ? { modelClass: result.modelClass } : {}),
    writtenAt: new Date().toISOString(),
  };

  const next_: BidResponsePack = {
    ...pack,
    sections: pack.sections.map((section) => (section.key === next.key ? written : section)),
    passes: pack.passes + 1,
  };

  write(ctx, {
    eventType: 'BID_RESPONSE_SECTION_WRITTEN',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: next_ as unknown as Record<string, unknown>,
  });

  return { pack: next_, written, acuConsumed: result.acuConsumed };
}

/**
 * Replace a section's prose with what a person wrote or edited.
 *
 * The drafter writes a first version and the shortener cuts one to length, but
 * until this existed there was no way to *read back and refine* a drafted
 * answer — to put the real project names into an experience answer, or the named
 * site manager into a team answer, both of which the drafter deliberately leaves
 * for a person because it will not invent them. A submission nobody can edit is
 * a submission nobody can make their own.
 *
 * The result is marked `HUMAN`, and the AI attribution is dropped, because once
 * a person has rewritten it the prose is theirs and the record should not claim a
 * model wrote what a person did.
 */
export function reviseSection(
  ctx: EngineContext,
  input: { packId: string; key: string; body: string[] },
): { pack: BidResponsePack; written: BidSection } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError(
      'BID_RESPONSE_ISSUED',
      `${pack.reference} has been issued. Editing a submission after it has gone to the buyer is not a draft change, ` +
        'and the record of what was sent must stay what was sent.',
      409,
    );
  }

  const section = pack.sections.find((entry) => entry.key === input.key);
  if (!section) {
    throw new DomainError('BID_SECTION_NOT_FOUND', `${pack.reference} has no section ${input.key}`, 404);
  }

  const body = (Array.isArray(input.body) ? input.body : []).map((line) => String(line).trim()).filter(Boolean);
  if (body.length === 0) {
    throw new DomainError('BID_SECTION_EMPTY', 'A section needs at least one line of text. Clearing it is not editing it.', 422);
  }

  // Drop the AI attribution: a person has rewritten it, so the record must not
  // say a model did.
  const { provider: _provider, modelClass: _modelClass, ...base } = section;
  const written: BidSection = {
    ...base,
    status: 'DRAFTED',
    body,
    words: body.join(' ').split(/\s+/).filter(Boolean).length,
    authorship: 'HUMAN',
    writtenAt: new Date().toISOString(),
  };

  const next_: BidResponsePack = {
    ...pack,
    sections: pack.sections.map((entry) => (entry.key === input.key ? written : entry)),
  };

  write(ctx, {
    eventType: 'BID_RESPONSE_SECTION_WRITTEN',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: next_ as unknown as Record<string, unknown>,
  });

  return { pack: next_, written };
}

/**
 * Cut one section to the length the buyer stated.
 *
 * This exists because the gate below needs a way forward. A check that refuses
 * a submission for being 300 words long with nothing on the screen that can
 * shorten it is not a gate, it is a dead end — and a dead end on the return
 * date is how somebody decides the check is the problem and goes round it.
 *
 * It rewrites rather than truncates. Cutting the last 300 words off an answer
 * leaves it ending mid-argument, which is precisely the damage the limit does
 * when it is ignored; what has to go is whichever 300 words carry least of the
 * answer, and deciding that is the work.
 *
 * Refuses rather than saves when the rewrite comes back still over: the section
 * is left exactly as it was, so a failed cut cannot quietly make the submission
 * worse. The pass is charged either way, because the provider did the work —
 * and saying so is better than a silent retry loop somebody pays for anyway.
 */
export async function shortenSection(
  ctx: EngineContext,
  input: { packId: string; key: string },
): Promise<{ pack: BidResponsePack; section: BidSection; wordsRemoved: number; acuConsumed: number }> {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError(
      'BID_RESPONSE_ISSUED',
      `${pack.reference} has been issued. The record of what was sent must stay what was sent.`,
      409,
    );
  }

  const section = pack.sections.find((entry) => entry.key === input.key);
  if (!section) {
    throw new DomainError('BID_SECTION_NOT_FOUND', `${pack.reference} has no section ${input.key}`, 404);
  }
  const limit = section.limit?.words;
  if (limit === undefined) {
    throw new DomainError(
      'BID_SECTION_NO_LIMIT',
      `${input.key} carries no stated word limit, so there is nothing to cut it to. Shortening prose nobody ` +
        'constrained is an editorial decision, not a check.',
      422,
    );
  }
  const body = section.body ?? [];
  const words = body.join(' ').split(/\s+/).filter(Boolean).length;
  if (body.length === 0) {
    throw new DomainError('BID_SECTION_UNWRITTEN', `${input.key} has not been written yet.`, 409);
  }
  if (words <= limit) {
    throw new DomainError(
      'BID_SECTION_WITHIN_LIMIT',
      `${input.key} is ${words} words against a limit of ${limit}. It already fits, and a pass that cut it further ` +
        'would be spending money to throw away an answer that scores.',
      409,
    );
  }

  const result = await runAI(ctx, {
    engine: 'TENDER',
    // Not the drafting task type. The prompt, the input and what a quote is
    // being asked to price are all different from writing a section.
    taskType: 'bid_response_shorten',
    capability: 'REASONING',
    inputRefs: [{ refType: 'BidResponsePack', refId: pack.id }],
    request: {
      task:
        'Cut one section of a construction tender submission to a stated word limit. Return JSON with `body`: an ' +
        'array of paragraph strings.',
      payload: {
        requirement: section.deliverable,
        limitWords: limit,
        statedAs: section.limit!.statedAs,
        currentWords: words,
        body,
        constraint:
          `This answer is ${words} words and the buyer allows ${limit}. Return it at or under ${limit} words. Keep ` +
          'every commitment, figure, name and date exactly as written — none of them may be changed, softened or ' +
          'dropped, because they are what the submission is promising. Remove restatement of the question, ' +
          'generalities and anything the answer does not need. Do not truncate: the answer must still end where it ' +
          'means to. Add nothing that is not already there.',
      },
    },
    toWrites: () => [],
    requireModel: {
      code: 'NO_REASONING_PROVIDER',
      message:
        'This deployment is running the local stand-in, which reasons about nothing. It cannot cut a tender ' +
        'submission to length without deciding what the answer can lose. Configure a reasoning provider and set ' +
        'AI_MODE=production.',
    },
  });

  const output = result.output as { body?: unknown };
  const cut = Array.isArray(output.body) ? output.body.map((line) => String(line).trim()).filter(Boolean) : [];
  const cutWords = cut.join(' ').split(/\s+/).filter(Boolean).length;

  if (cut.length === 0) {
    throw new DomainError(
      'BID_SECTION_UNUSABLE',
      `The model returned no prose for ${input.key}. The section is unchanged.`,
      502,
    );
  }
  if (cutWords > limit) {
    throw new DomainError(
      'BID_SECTION_STILL_OVER',
      `The rewrite came back at ${cutWords} words against a limit of ${limit}. ${input.key} is unchanged — a cut ` +
        'that does not fit is not an improvement, and overwriting the answer with it would lose the version that at ' +
        'least reads properly. Run it again, or cut it by hand.',
      502,
    );
  }

  const shortened: BidSection = {
    ...section,
    body: cut,
    words: cutWords,
    // Not reset to HUMAN and not left as it was found: the prose that goes to
    // the buyer is now what this pass produced, and the record says so.
    authorship: 'AI_DRAFTED',
    ...(result.provider ? { provider: result.provider } : {}),
    ...(result.modelClass ? { modelClass: result.modelClass } : {}),
    writtenAt: new Date().toISOString(),
  };

  const next: BidResponsePack = {
    ...pack,
    sections: pack.sections.map((entry) => (entry.key === input.key ? shortened : entry)),
    passes: pack.passes + 1,
  };

  write(ctx, {
    eventType: 'BID_RESPONSE_SECTION_WRITTEN',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: next as unknown as Record<string, unknown>,
  });

  return { pack: next, section: shortened, wordsRemoved: words - cutWords, acuConsumed: result.acuConsumed };
}

export type BidCompleteness = {
  ready: boolean;
  /** Deliverables with no written response. Each one is a rejection. */
  unanswered: Array<{ key: string; deliverable: string; mandatory: boolean }>;
  /** Stated deadlines carrying no date. */
  undated: string[];
  /**
   * Deliverables nobody is answering, on purpose.
   *
   * Reported separately from `unanswered` and never folded into `written`. A
   * waived deliverable is not an answered one, and a pack that counted it as
   * answered would tell the person signing the submission that it is complete.
   */
  waived: Array<{ key: string; deliverable: string; mandatory: boolean; reason: string; expiresOn: string }>;
  /**
   * Evidence the submission leans on that will not be current when it is read.
   *
   * `SUB-003`'s last hard gate: **no expired mandatory evidence at the
   * submission deadline.** A certificate valid on the day somebody attaches it
   * and lapsed on the return date is not evidence for that submission, and
   * checking it against today answers the wrong question.
   */
  lapsedEvidence: Array<{ reference: string; claim: string; expiresAt: string; covers: string[] }>;
  /**
   * Sections written against a requirement an addendum has since changed.
   *
   * Targeted invalidation: only a section whose own requirement moved is stale,
   * and every other section stays good. A full re-plan would reset statuses
   * somebody set by hand and would cost a re-analysis nobody needs.
   */
  staleSections: Array<{ key: string; deliverable: string; addendum: string; detail: string }>;
  /**
   * Written sections still carrying a note to the bid team instead of an answer.
   *
   * A hard gate. "The bid team will insert the response time" is read by the
   * evaluator as exactly what it is, and on a scored question it is the mark.
   * Each comes with the phrases found, so the person can see where they are.
   */
  unfinished: Array<{ key: string; deliverable: string; mandatory: boolean; phrases: string[] }>;
  /**
   * Sections claiming staff a one-person firm does not have.
   *
   * A hard gate, and only asked when the firm has said it is one person — the
   * one case where the platform knows the claim is false. Empty otherwise.
   */
  unsupportedStaff: Array<{ key: string; deliverable: string; roles: string[] }>;
  /**
   * What a reviewer would raise and the pack can still go out with: a section
   * answering a drawing note rather than a question, or "our Project Manager"
   * on an NEC contract where the Project Manager is the client's.
   */
  advisories: Array<{ key: string; kind: 'DRAWING_NOTE' | 'NEC_PROJECT_MANAGER'; detail: string }>;
  /**
   * Sections longer than the buyer said they may be.
   *
   * A hard gate, for the same reason a missing mandatory response is one. The
   * standard instruction on a stated word limit is that anything past it is not
   * read — so a 1,300-word answer to a 1,000-word question is not marked down by
   * 30%, it is marked on 1,000 words that now end mid-argument, and on a
   * pass/fail question that is the bid. It is also the cheapest check on this
   * list and the one most reliably discovered too late, by whoever is pasting
   * sections into the template on the last afternoon.
   */
  overLimit: Array<{
    key: string;
    deliverable: string;
    mandatory: boolean;
    words: number;
    limitWords: number;
    overBy: number;
    statedAs: string;
  }>;
  /**
   * Sections carrying a page limit, reported rather than checked.
   *
   * Words per page depends on a template this platform does not hold. A limit
   * enforced against an invented conversion would refuse a submission that
   * fits, which is worse than not checking — so the limit is put in front of
   * whoever lays the pack out, and the pack says plainly that nothing verified
   * it. This is named in `docs/STATE.md` under what is not built.
   */
  pageLimited: Array<{ key: string; deliverable: string; pages: number; words: number; statedAs: string }>;
  written: number;
  total: number;
  summary: string;
};

/**
 * The check that runs before issue, and the same one the screen shows.
 *
 * Read rather than stored, so the answer on the screen and the answer at the
 * gate cannot disagree — a completeness figure computed twice is two figures,
 * and the one somebody trusts is whichever is on screen at the time.
 */
export function bidCompleteness(
  pack: BidResponsePack,
  waivers: RequirementWaiver[] = [],
  claims: EvidenceClaim[] = [],
  impacts: AddendumImpact[] = [],
  review: SubmissionReviewContext = {},
): BidCompleteness {
  // Waivers are read live rather than baked into the pack at plan time, so a
  // waiver granted halfway through drafting takes a deliverable out of the
  // outstanding list, and one revoked or expired puts it straight back. A pack
  // that froze the decision at planning would let an expired waiver carry a
  // submission through the issue check weeks after it stopped applying.
  const waivedBy = new Map(waivers.map((waiver) => [waiver.reference, waiver]));

  const outstanding = pack.sections.filter(
    (section) => section.status !== 'DRAFTED' || (section.body ?? []).length === 0,
  );
  const unanswered = outstanding
    .filter((section) => !waivedBy.has(section.key))
    .map((section) => ({ key: section.key, deliverable: section.deliverable, mandatory: section.mandatory }));
  const waived = outstanding
    .filter((section) => waivedBy.has(section.key))
    .map((section) => ({
      key: section.key,
      deliverable: section.deliverable,
      mandatory: section.mandatory,
      reason: waivedBy.get(section.key)!.reason,
      expiresOn: waivedBy.get(section.key)!.expiresOn,
    }));
  const undated = pack.deadlines.filter((deadline) => !deadline.on).map((deadline) => deadline.what);
  const written = pack.sections.length - outstanding.length;

  // Judged against the return date rather than against today, because that is
  // the day the buyer reads it. A claim approved this morning and lapsing the
  // week before return is not evidence for this submission.
  const returnBy = pack.returnBy.slice(0, 10);
  const lapsedEvidence = claims
    .filter((claim) => claim.status === 'APPROVED' && standingOf(claim, returnBy) === 'EXPIRED')
    .map((claim) => ({
      reference: claim.reference,
      claim: claim.claim,
      expiresAt: claim.expiresAt!,
      covers: claim.covers,
    }));

  // Only a drafted section can be stale: one nobody has written yet is already
  // outstanding, and reporting it twice would double-count the same work.
  const materialBy = new Map(impacts.filter((impact) => impact.material).map((impact) => [impact.reference, impact]));
  const staleSections = pack.sections
    .filter((section) => section.status === 'DRAFTED' && (section.body ?? []).length > 0)
    .filter((section) => materialBy.has(section.key))
    .map((section) => ({
      key: section.key,
      deliverable: section.deliverable,
      addendum: materialBy.get(section.key)!.addendum,
      detail: materialBy.get(section.key)!.detail,
    }));

  /*
   * The stated limit, against what is actually written.
   *
   * Counted from the prose rather than trusted from `section.words`, because a
   * section edited by hand through the sections route sets its own count and a
   * check that trusted the stored number would be checking whatever was last
   * written into the record rather than the answer. Same split rule as the
   * model's own counter: whitespace-separated tokens.
   *
   * Every drafted section, waived or not — unlike `unanswered`, which excludes
   * a waived one. The difference is real. An unanswered waived requirement is
   * prose nobody is writing; a written one whose requirement was waived
   * afterwards is prose that is still in the pack, still counted in `written`,
   * and still read by the buyer. Excluding it would make the waiver a way of
   * carrying an over-length answer through the gate.
   */
  const drafted = pack.sections.filter(
    (section) => section.status === 'DRAFTED' && (section.body ?? []).length > 0,
  );
  const lengthOf = (section: BidSection): number =>
    (section.body ?? []).join(' ').split(/\s+/).filter(Boolean).length;

  const overLimit = drafted
    .filter((section) => section.limit?.words !== undefined && lengthOf(section) > section.limit.words)
    .map((section) => ({
      key: section.key,
      deliverable: section.deliverable,
      mandatory: section.mandatory,
      words: lengthOf(section),
      limitWords: section.limit!.words!,
      overBy: lengthOf(section) - section.limit!.words!,
      statedAs: section.limit!.statedAs,
    }));

  // Every drafted section, waived or not, for the reason `overLimit` gives: the
  // prose is still in the pack and still read.
  const unfinished = drafted
    .map((section) => ({
      key: section.key,
      deliverable: section.deliverable,
      mandatory: section.mandatory,
      phrases: unfinishedPhrases((section.body ?? []).join('\n')),
    }))
    .filter((entry) => entry.phrases.length > 0);

  const unsupportedStaff = review.singleOwner
    ? drafted
        .map((section) => ({
          key: section.key,
          deliverable: section.deliverable,
          roles: unsupportedRoles((section.body ?? []).join('\n'), review.people ?? []),
        }))
        .filter((entry) => entry.roles.length > 0)
    : [];

  const nec = /\bNEC(?:\d|\b)/i.test(review.contractForm ?? '');
  const advisories: BidCompleteness['advisories'] = [
    ...pack.sections
      .filter((section) => !waivedBy.has(section.key) && isDrawingNote(section.deliverable))
      .map((section) => ({
        key: section.key,
        kind: 'DRAWING_NOTE' as const,
        detail:
          'This is a note on a drawing, not a question. Waive it on the compliance matrix so it leaves the pack — an ' +
          'essay answering a drawing convention reads as padding.',
      })),
    ...(nec
      ? drafted
          .filter((section) => /\bour project manager\b/i.test((section.body ?? []).join(' ')))
          .map((section) => ({
            key: section.key,
            kind: 'NEC_PROJECT_MANAGER' as const,
            detail:
              'Under an NEC contract the Project Manager is the client’s role. Calling our own person that confuses ' +
              'the evaluator — call them our contract manager, by name.',
          }))
      : []),
  ];

  const pageLimited = drafted
    .filter((section) => section.limit?.pages !== undefined)
    .map((section) => ({
      key: section.key,
      deliverable: section.deliverable,
      pages: section.limit!.pages!,
      words: lengthOf(section),
      statedAs: section.limit!.statedAs,
    }));

  const ready =
    unanswered.length === 0 &&
    undated.length === 0 &&
    lapsedEvidence.length === 0 &&
    staleSections.length === 0 &&
    overLimit.length === 0 &&
    unfinished.length === 0 &&
    unsupportedStaff.length === 0;

  return {
    ready,
    unanswered,
    undated,
    waived,
    lapsedEvidence,
    staleSections,
    unfinished,
    unsupportedStaff,
    advisories,
    overLimit,
    pageLimited,
    written,
    total: pack.sections.length,
    summary:
      ready
        ? `${written} of ${pack.sections.length} deliverables answered` +
          (waived.length > 0 ? `, ${waived.length} waived` : '') +
          ', every stated deadline dated, every claim still evidenced on the return date' +
          (pageLimited.length > 0
            ? `, and ${pageLimited.length} section(s) carrying a page limit nothing here can count`
            : ', and every stated word limit respected') +
          '.'
        : `${written} of ${pack.sections.length} answered` +
          (unanswered.length > 0 ? `, ${unanswered.length} outstanding` : '') +
          (waived.length > 0 ? `, ${waived.length} waived` : '') +
          (undated.length > 0 ? `, ${undated.length} deadline(s) undated` : '') +
          (lapsedEvidence.length > 0 ? `, ${lapsedEvidence.length} claim(s) evidenced by something that lapses first` : '') +
          (staleSections.length > 0 ? `, ${staleSections.length} answering a requirement an addendum has changed` : '') +
          (overLimit.length > 0 ? `, ${overLimit.length} longer than the buyer allows` : '') +
          (unfinished.length > 0 ? `, ${unfinished.length} still carrying a note to the bid team instead of an answer` : '') +
          (unsupportedStaff.length > 0 ? `, ${unsupportedStaff.length} claiming staff the firm does not have` : '') +
          '.',
  };
}

/**
 * Issue the pack, or refuse it.
 *
 * The refusal names every outstanding deliverable rather than the first,
 * because fixing them one attempt at a time is how somebody decides at 4pm that
 * the check is the problem.
 */
export function issueBidResponse(
  ctx: EngineContext,
  input: { packId: string },
): { pack: BidResponsePack; completeness: BidCompleteness } {
  // Approve, not issue. No role holds "I" on this area — the estimate side of
  // the platform expresses a decision as an approval, and picking the code that
  // reads best in a sentence rather than the one the matrix carries produces a
  // command nobody can ever run, refused with a message about their role.
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError('BID_RESPONSE_ISSUED', `${pack.reference} is already issued.`, 409);
  }

  const completeness = bidCompleteness(
      pack,
      liveWaivers(ctx, pack.analysisId),
      approvedOn(ctx, new Date().toISOString().slice(0, 10)),
      openImpacts(ctx, pack.analysisId),
      reviewContextFor(ctx, pack),
    );
  if (!completeness.ready) {
    throw new DomainError(
      'BID_RESPONSE_INCOMPLETE',
      `${pack.reference} cannot be issued. ` +
        (completeness.unanswered.length > 0
          ? `${completeness.unanswered.length} deliverable(s) have no response: ` +
            `${completeness.unanswered.map((entry) => `${entry.key}${entry.mandatory ? ' (mandatory)' : ''}`).join(', ')}. `
          : '') +
        (completeness.undated.length > 0 ? `Undated: ${completeness.undated.join('; ')}. ` : '') +
        (completeness.staleSections.length > 0
          ? `${completeness.staleSections.length} section(s) answer a requirement an addendum has since changed: ` +
            `${completeness.staleSections.map((entry) => `${entry.key} (${entry.addendum})`).join(', ')}. ` +
            'A response that answers the old wording perfectly scores nothing. '
          : '') +
        (completeness.overLimit.length > 0
          ? `${completeness.overLimit.length} section(s) are longer than the buyer allows: ` +
            `${completeness.overLimit
              .map(
                (entry) =>
                  `${entry.key} is ${entry.words} words against ${entry.limitWords} (${entry.statedAs}), ` +
                  `${entry.overBy} over`,
              )
              .join('; ')}. ` +
            'An evaluator does not mark the extra words down — the instruction is that anything past the limit is ' +
            'not read, so the answer is scored on where it happens to stop. Cut it to length. '
          : '') +
        (completeness.unfinished.length > 0
          ? `${completeness.unfinished.length} section(s) still hold a note to the bid team instead of an answer: ` +
            `${completeness.unfinished.map((entry) => entry.key).join(', ')}. The buyer reads that note as written ` +
            'and scores the gap. Redraft the section, or edit it, so it commits to what the note left blank. '
          : '') +
        (completeness.unsupportedStaff.length > 0
          ? `${completeness.unsupportedStaff.length} section(s) claim staff a one-person firm does not have: ` +
            `${completeness.unsupportedStaff.map((entry) => `${entry.key} (${entry.roles.join(', ')})`).join('; ')}. ` +
            'An evaluator can test that at interview. Redraft the section so it names who actually does the work. '
          : '') +
        (completeness.lapsedEvidence.length > 0
          ? `${completeness.lapsedEvidence.length} claim(s) rest on evidence that expires before ${pack.returnBy.slice(0, 10)}, ` +
            'when this is read: ' +
            `${completeness.lapsedEvidence.map((entry) => `${entry.reference} (${entry.expiresAt})`).join(', ')}. ` +
            'File the current document and assert against that. '
          : '') +
        'A submission missing a mandatory response is not marked down, it is rejected, and everything else in it is ' +
        'spent for nothing.',
      422,
    );
  }

  // The red team, and it is a gate rather than a report — §16.3.
  //
  // Completeness answers whether every deliverable has prose against it. It
  // cannot answer whether the prose scores, and a pack that satisfies every
  // completeness rule can still be rejected for a placeholder nobody removed or
  // an unverified certificate. Refusing here rather than warning is deliberate:
  // a warning leaves that decision to whoever is most tired on the return date.
  const standing = assuranceStanding(latestReview(ctx, pack.id), pack);
  if (!standing.clear) {
    throw new DomainError(
      'ASSURANCE_NOT_CLEAR',
      `${pack.reference} cannot be issued. ${standing.reason}` +
        (standing.current
          ? ' A critical finding must be fixed and the review run again; a high one needs a named decision recorded ' +
            'against it.'
          : ''),
      422,
    );
  }

  const issued: BidResponsePack = {
    ...pack,
    status: 'ISSUED',
    issuedAt: new Date().toISOString(),
    issuedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_RESPONSE_ISSUED',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: issued as unknown as Record<string, unknown>,
  });

  return { pack: issued, completeness };
}

/**
 * Set the quality floor this pack's issue is held to. `U` on `ESTIMATE_TENDER`.
 *
 * A per-pack bar, so a flagship tender can be held higher and one whose
 * requirement no honest answer reaches 4/5 on can be set lower rather than
 * trapped. The floor is enforced through the red team — a review run under the
 * old floor is stale once it moves — so changing it is a reason to run the
 * review again, which the issue gate insists on rather than passing a pack
 * attacked under a floor that no longer applies.
 */
export function setBidResponseQualityFloor(
  ctx: EngineContext,
  input: { packId: string; floorPercent: number },
): BidResponsePack {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError(
      'BID_RESPONSE_ISSUED',
      `${pack.reference} has been issued. The bar it was judged against must stay what it was judged against.`,
      409,
    );
  }
  if (
    typeof input.floorPercent !== 'number' ||
    Number.isNaN(input.floorPercent) ||
    input.floorPercent < 0 ||
    input.floorPercent > 100
  ) {
    throw new DomainError('BID_RESPONSE_FLOOR_RANGE', 'A quality floor is a percentage between 0 and 100', 400);
  }

  const next: BidResponsePack = { ...pack, qualityFloorPercent: input.floorPercent };

  write(ctx, {
    eventType: 'BID_RESPONSE_QUALITY_FLOOR_SET',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: next as unknown as Record<string, unknown>,
    reason: `Quality floor set to ${input.floorPercent}%`,
  });

  return next;
}

export type BidResponsePosition = {
  packs: Array<
    Pick<
      BidResponsePack,
      'id' | 'reference' | 'analysisId' | 'clientName' | 'returnBy' | 'status' | 'passes' | 'qualityFloorPercent'
    > & {
      basis: PlanBasis;
      completeness: BidCompleteness;
    }
  >;
  summary: string;
};

/** Every pack on this project, with what is stopping each one. */
export function bidResponsePosition(ctx: EngineContext): BidResponsePosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const packs = ctx.ledger
    .list(ctx.projectId, 'BidResponsePack')
    .map((row) => row.state as unknown as BidResponsePack)
    .sort((a, b) => (b.plannedAt ?? '').localeCompare(a.plannedAt ?? ''))
    .map((pack) => ({
      id: pack.id,
      reference: pack.reference,
      analysisId: pack.analysisId,
      clientName: pack.clientName,
      returnBy: pack.returnBy,
      status: pack.status,
      passes: pack.passes,
      qualityFloorPercent: pack.qualityFloorPercent ?? DEFAULT_QUALITY_FLOOR_PERCENT,
      basis: pack.basis ?? 'WRITTEN_REQUIREMENTS',
      completeness: bidCompleteness(
      pack,
      liveWaivers(ctx, pack.analysisId),
      approvedOn(ctx, new Date().toISOString().slice(0, 10)),
      openImpacts(ctx, pack.analysisId),
      reviewContextFor(ctx, pack),
    ),
    }));

  const drafting = packs.filter((pack) => pack.status === 'DRAFTING').length;
  const outstanding = packs.reduce((sum, pack) => sum + pack.completeness.unanswered.length, 0);
  const waived = packs.reduce((sum, pack) => sum + pack.completeness.waived.length, 0);

  return {
    packs,
    summary:
      packs.length === 0
        ? 'No bid response pack has been planned on this project.'
        : `${packs.length} pack(s), ${drafting} still drafting, ${outstanding} deliverable(s) with no response yet` +
          (waived > 0 ? `, ${waived} waived` : '') +
          '.',
  };
}

/** One pack in full, for the screen that shows the sections. */
export function bidResponsePack(
  ctx: EngineContext,
  packId: string,
): BidResponsePack & { completeness: BidCompleteness } {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const pack = requirePack(ctx, packId);
  return {
    ...pack,
    completeness: bidCompleteness(
      pack,
      liveWaivers(ctx, pack.analysisId),
      approvedOn(ctx, new Date().toISOString().slice(0, 10)),
      openImpacts(ctx, pack.analysisId),
      reviewContextFor(ctx, pack),
    ),
  };
}
