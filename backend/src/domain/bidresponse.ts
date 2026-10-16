import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, currentPhase, runAI, write, type EngineContext } from '../engines/context.ts';
import {
  complianceMatrix,
  liveWaivers,
  type MatrixLine,
  type RequirementWaiver,
  type ResponseLimit,
  type StoredITTAnalysis,
} from './itt.ts';
import { approvedOn, standingOf, type EvidenceClaim } from './evidenceclaim.ts';
import { openImpacts, type AddendumImpact } from './addendum.ts';
// One direction only. The red team reads the pack out of the ledger itself
// rather than importing this module's readers, so the dependency between the
// two does not become a cycle.
import { assuranceStanding, latestReview } from './redteam.ts';

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

export type BidResponsePack = {
  id: string;
  reference: string;
  projectId: string;
  analysisId: string;
  clientName: string;
  returnBy: string;
  sections: BidSection[];
  deadlines: BidDeadline[];
  status: 'DRAFTING' | 'ISSUED';
  /** How many passes have run. Reported so a stall is visible as a number. */
  passes: number;
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
function needsProse(line: MatrixLine): boolean {
  return line.evidenceHeld === undefined || line.evidenceHeld === '';
}

function titleFor(line: MatrixLine): string {
  const words = line.requirement.trim().replace(/\s+/g, ' ');
  return words.length <= 70 ? words : `${words.slice(0, 67)}…`;
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
  const sections: BidSection[] = analysis.matrix
    .filter((line) => needsProse(line) && !waived.has(line.reference))
    .map((line) => ({
      key: line.reference,
      title: titleFor(line),
      deliverable: line.requirement,
      owner: String(line.owner),
      mandatory: line.mandatory,
      status: 'PLANNED' as const,
      ...(line.responseLimit ? { limit: line.responseLimit } : {}),
    }));

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
  const deadlines: BidDeadline[] = [
    ...analysis.matrix
      .filter((line) => line.dueBy !== undefined)
      .map((line) => ({ what: `${line.reference} — ${titleFor(line)}`, on: line.dueBy })),
    { what: 'Return of the completed submission', on: analysis.returnBy },
  ];

  const sequence = ctx.ledger.list(ctx.projectId, 'BidResponsePack').length + 1;
  const pack: BidResponsePack = {
    id: ulid(),
    reference: formatRef('BID', sequence),
    projectId: ctx.projectId,
    analysisId: analysis.analysisId,
    clientName: analysis.clientName,
    returnBy: analysis.returnBy,
    sections,
    deadlines,
    status: 'DRAFTING',
    passes: 0,
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

  const analysis = complianceMatrix(ctx, pack.analysisId);
  const line = analysis.matrix.find((entry) => entry.reference === next.key);

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'bid_response_section',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ITTAnalysis', refId: pack.analysisId }],
    request: {
      task:
        'Write one section of a construction tender submission, answering one stated requirement. Return JSON with ' +
        '`body`: an array of paragraph strings.',
      payload: {
        client: pack.clientName,
        requirement: next.deliverable,
        evidenceRequired: line?.evidenceRequired ?? '',
        category: line?.category ?? '',
        mandatory: next.mandatory,
        respondingRole: next.owner,
        // Given to the writer rather than only checked afterwards. A pass that
        // produces 1,400 words against a 1,000-word limit is a pass somebody
        // pays for and then has to cut by hand, and the cut is where the
        // answer loses the thing it was scoring on.
        ...(next.limit ? { limit: next.limit } : {}),
        constraint:
          'Answer the requirement and nothing else. State no figure, no completion percentage, no customer name and no ' +
          'past project you have not been given — an invented reference in a submission is a false statement to a buyer ' +
          'and grounds for disqualification. Where a number would help, describe the method instead and name what the ' +
          'bid team must insert. Write in the first person plural, in British English, as a contractor answering a ' +
          'client. Do not restate the question.' +
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
        'Configure a reasoning provider and set AI_MODE=live.',
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

  return {
    pack: next_,
    written,
    remaining: next_.sections.filter((section) => section.status === 'PLANNED').length,
    acuConsumed: result.acuConsumed,
  };
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
        'AI_MODE=live.',
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
    overLimit.length === 0;

  return {
    ready,
    unanswered,
    undated,
    waived,
    lapsedEvidence,
    staleSections,
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

export type BidResponsePosition = {
  packs: Array<
    Pick<BidResponsePack, 'id' | 'reference' | 'analysisId' | 'clientName' | 'returnBy' | 'status' | 'passes'> & {
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
      completeness: bidCompleteness(
      pack,
      liveWaivers(ctx, pack.analysisId),
      approvedOn(ctx, new Date().toISOString().slice(0, 10)),
      openImpacts(ctx, pack.analysisId),
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
    ),
  };
}
