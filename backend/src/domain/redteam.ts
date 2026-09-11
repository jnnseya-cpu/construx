import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, currentPhase, runAI, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { openImpacts } from './addendum.ts';
import type { BidResponsePack, BidSection } from './bidresponse.ts';
import { evidenceRegister } from './evidenceclaim.ts';
import { complianceMatrix, liveWaivers, type MatrixLine } from './itt.ts';

/**
 * Adversarial self-challenge — `L7.3`, §16, §4.7.3.
 *
 * ---
 *
 * **The failure this stops.** Every machine check the platform had ran *for*
 * the submission: is each deliverable answered, is each deadline dated, is each
 * claim still evidenced. None of them ran *against* it. A pack that satisfies
 * every completeness rule can still lose, because completeness is not the
 * question a scorer asks. They ask whether they can find the answer and award
 * the mark without inferring anything, and a section that answers a different
 * question at length passes every check the platform had and scores nothing.
 *
 * So this attacks the pack. It is the evaluator simulation of §4.7.3 — the one
 * red-team agent whose accuracy can eventually be measured against real
 * feedback, which is why the specification names it as the one to build first.
 *
 * ## Independence, and what it actually costs
 *
 * §16.1: *the same agent run that authored content shall not provide the final
 * automated assurance result*. Two mechanisms, and the second is honest about
 * its limits.
 *
 * - **The deterministic lenses always run**, and they are the gate. They are not
 *   a second opinion from the same mind because they are not a mind: they read
 *   the drafted prose against the requirement it answers and the record the
 *   platform holds. §16.1's own last clause names a deterministic validator as
 *   sufficient independence, and for everything mechanical it is.
 * - **The model challenge runs when a reasoning provider answers**, under a
 *   different prompt lineage from the drafting prompt. Where the router lands on
 *   the same provider that wrote the sections, the review says so rather than
 *   claiming an independence it does not have. Where no model answers, the
 *   review records that the judgement lens did not run. **It never invents a
 *   finding to fill the space** — a red team that reports nothing when it was
 *   not run is worse than no red team, because somebody reads the empty list as
 *   a clean bill.
 *
 * ## Severity is a gate, not a label
 *
 * §16.3 gives four severities each with a submission effect, and that is the
 * whole point of them. `CRITICAL` is a hard block nobody can dispose of.
 * `HIGH` blocks until a named person records what they decided. `MEDIUM` and
 * `LOW` are reported. A severity with no consequence is a list, and a list is
 * what gets scrolled past at 4pm on the return date.
 *
 * **A model-raised finding is capped at `HIGH`.** No agent mandate exceeds
 * propose, and a hard block nobody can clear is a decision. Capped at `HIGH`, a
 * model finding stops the submission until a person looks at it and says what
 * they decided — which is exactly what propose means.
 *
 * ## The score, and what it is not
 *
 * `findableScorePercent` is the weighted proportion of the marks an evaluator
 * **can find and award without inference**, computed from the findings against
 * each scored requirement. Every component of it is traceable to a finding, and
 * `scoreBasis` carries the working.
 *
 * It is **not a predicted mark**. §4.7.3 asks for one and for the correlation
 * between it and real feedback to be tracked; that correlation is the learning
 * loop (`L7.6`), which is not built. Presenting a coverage figure as a predicted
 * score would put a number in front of a bid director that looks like a
 * forecast and is not one. The limit is stated on every review rather than left
 * for somebody to discover.
 */

/** §16.2's nine review lenses. Every finding names the one it came from. */
export const ASSURANCE_LENS = [
  'COMPLIANCE',
  'EVALUATOR',
  'COMMERCIAL',
  'TECHNICAL',
  'PROGRAMME',
  'CONTRACT',
  'EVIDENCE',
  'ADVERSARIAL',
  'EXECUTIVE',
] as const;

export type AssuranceLens = (typeof ASSURANCE_LENS)[number];

export const FINDING_SEVERITY = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;

export type FindingSeverity = (typeof FINDING_SEVERITY)[number];

/** §16.3. Each severity's effect on the submission, published so the console says the same thing. */
export const SUBMISSION_EFFECT: Record<FindingSeverity, string> = {
  CRITICAL: 'Hard block. The submission cannot be issued and this cannot be disposed of.',
  HIGH: 'Blocks until a named person records what they decided about it.',
  MEDIUM: 'Review required. Reported, and does not block.',
  LOW: 'May proceed. Reported, and does not block.',
};

/** How much of a requirement's weighted marks survive a finding of each severity. */
const SEVERITY_RETAINS: Record<FindingSeverity, number> = {
  CRITICAL: 0,
  HIGH: 0.5,
  MEDIUM: 0.75,
  LOW: 0.95,
};

export type FindingDisposition = {
  decision: 'FIXED' | 'ACCEPTED' | 'WAIVED';
  /** What was decided and why. A tick is not a disposition. */
  note: string;
  by: string;
  at: string;
};

export type AssuranceFinding = {
  id: string;
  lens: AssuranceLens;
  severity: FindingSeverity;
  /** The pack section it attacks, where it attacks one. */
  sectionKey?: string;
  /** The matrix reference behind that section. */
  reference?: string;
  title: string;
  /** What is wrong, in the words somebody fixing it needs. */
  detail: string;
  /** What to do about it. A finding with no remedy is a complaint. */
  remedy: string;
  /** Whether a deterministic lens or the model challenge raised it. */
  raisedBy: 'CHECK' | 'MODEL';
  disposition?: FindingDisposition;
};

export type ScoreBasisLine = {
  reference: string;
  weightingPercent: number;
  /** What proportion of this requirement's marks the evaluator can award. */
  awardedFraction: number;
  why: string;
};

export type ModelChallenge = {
  ran: boolean;
  provider?: string;
  modelClass?: string;
  /**
   * Whether the challenge landed on a different provider from the one that
   * drafted the prose. Absent where nothing was drafted by a model.
   */
  independent?: boolean;
  /** Why it did not run, or why it is not independent. Said, never implied. */
  reason?: string;
  findings: number;
};

export type AssuranceReview = {
  id: string;
  reference: string;
  packId: string;
  analysisId: string;
  /**
   * The pack's pass count when this ran.
   *
   * A review of a pack that has since been written to is a review of something
   * else. Carried so the issue gate can refuse a stale one rather than treat it
   * as current.
   */
  packPasses: number;
  runAt: string;
  runBy: string;
  findings: AssuranceFinding[];
  findableScorePercent: number;
  scoreBasis: ScoreBasisLine[];
  modelChallenge: ModelChallenge;
  /** What this review cannot tell you. Stated on the record, not in a footnote. */
  limits: string[];
  summary: string;
};

/** The most a model challenge may raise. No agent mandate exceeds propose. */
const MODEL_SEVERITY_CEILING: FindingSeverity = 'HIGH';

/** Findings the model may add in one pass. A review nobody reads is not a gate. */
const MODEL_FINDING_CAP = 12;

const NOTE_MIN = 12;

/**
 * Words too common to prove a scorer can find the answer.
 *
 * Deliberately short. A long stop list starts deciding what a requirement is
 * about, and the check only has to establish that the response uses the
 * buyer's own vocabulary rather than its own.
 */
const COMMON = new Set([
  'shall',
  'should',
  'would',
  'will',
  'must',
  'provide',
  'please',
  'detail',
  'details',
  'describe',
  'including',
  'include',
  'which',
  'their',
  'there',
  'these',
  'those',
  'about',
  'above',
  'other',
  'where',
  'within',
  'being',
  'having',
  'tenderer',
  'tenderers',
  'bidder',
  'bidders',
  'contractor',
  'contractors',
  'project',
  'works',
  'work',
  'company',
  'organisation',
  'organization',
  'evidence',
  'submission',
  'response',
  'approach',
  'proposed',
]);

/** A figure the drafting constraint forbade the model from stating. */
const FIGURE = /(?:£|\$|€)\s?\d|(?:\b\d[\d,]*\s?(?:%|per\s?cent\b))|\b\d[\d,]*\s?(?:million|billion|k\b)/i;

/** What a draft leaves behind when the model was told to name what the bid team must insert. */
const PLACEHOLDER =
  /\bTBC\b|\bTBA\b|\bXX+\b|\bN\/A\b|\[[^\]]{0,60}\]|<[^>]{0,60}>|\bbid team must (?:insert|supply|confirm)\b|\binsert\b\s+(?:the\s+)?(?:figure|number|name|date)\b|\blorem ipsum\b/i;

function reviewsOf(ctx: EngineContext): AssuranceReview[] {
  return ctx.ledger.list(ctx.projectId, 'AssuranceReview').map((record) => record.state as unknown as AssuranceReview);
}

function requireReview(ctx: EngineContext, reviewId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'AssuranceReview', refId: reviewId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('ASSURANCE_REVIEW_NOT_FOUND', `No assurance review ${reviewId}`, 404);
  }
  return record;
}

function requirePack(ctx: EngineContext, packId: string): BidResponsePack {
  const record = ctx.ledger.get({ refType: 'BidResponsePack', refId: packId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_RESPONSE_NOT_FOUND', `No bid response pack ${packId}`, 404);
  }
  return record.state as unknown as BidResponsePack;
}

/** The distinctive words of a requirement — the ones a scorer looks for. */
function keyTerms(requirement: string): string[] {
  const seen = new Set<string>();
  for (const raw of requirement.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 5 || COMMON.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/**
 * Whether the prose uses the buyer's own word, allowing for how it inflects.
 *
 * Prefix matching on the first five characters rather than a stemmer: "manage"
 * against "management" and "resource" against "resourcing" is the whole of what
 * is needed here, and a real stemmer would be a dependency and a new source of
 * surprise.
 */
function usesTerm(body: string, term: string): boolean {
  return body.includes(term.slice(0, Math.max(5, Math.min(term.length, 7))));
}

/** The section's prose as one lower-case string, or empty where nothing is written. */
function proseOf(section: BidSection): string {
  return (section.body ?? []).join(' ').toLowerCase();
}

function finding(input: Omit<AssuranceFinding, 'id' | 'raisedBy'> & { raisedBy?: 'CHECK' | 'MODEL' }): AssuranceFinding {
  return { id: ulid(), raisedBy: 'CHECK', ...input };
}

/**
 * Every deterministic lens, run over the pack as it stands.
 *
 * Pure: no ledger, no context, no clock beyond the return date it is given. That
 * is what makes each lens testable on its own and what stops the gate and the
 * screen ever disagreeing about what the pack looks like.
 */
export function evaluatorFindings(input: {
  pack: BidResponsePack;
  matrix: MatrixLine[];
  waivedKeys: Set<string>;
  claims: Array<{ reference: string; claim: string; covers: string[]; standing: string; expiresAt?: string }>;
  staleKeys: Map<string, string>;
}): AssuranceFinding[] {
  const { pack, matrix, waivedKeys, claims, staleKeys } = input;
  const lineOf = new Map(matrix.map((line) => [line.reference, line]));
  const findings: AssuranceFinding[] = [];
  const returnBy = pack.returnBy.slice(0, 10);

  // Words per weighting point, taken from the pack's own drafted sections.
  // Self-referential on purpose: an industry constant for "how long a 20%
  // question should be" would be invented, and this asks the only question
  // that can be answered honestly — is this section thin *compared with the
  // rest of this submission*.
  const scored = pack.sections.filter(
    (section) => (lineOf.get(section.key)?.weightingPercent ?? 0) > 0 && (section.words ?? 0) > 0,
  );
  const densities = scored
    .map((section) => (section.words ?? 0) / lineOf.get(section.key)!.weightingPercent!)
    .sort((a, b) => a - b);
  const median = densities.length > 0 ? densities[Math.floor(densities.length / 2)]! : 0;

  for (const section of pack.sections) {
    const line = lineOf.get(section.key);
    const written = section.status === 'DRAFTED' && (section.body ?? []).length > 0;
    const prose = proseOf(section);

    if (!written) {
      if (waivedKeys.has(section.key)) {
        // Authorised, and still a blank page where the evaluator expects an
        // answer. The waiver says somebody decided; it does not say the scorer
        // will award the mark.
        findings.push(
          finding({
            lens: 'COMPLIANCE',
            severity: section.mandatory ? 'HIGH' : 'LOW',
            sectionKey: section.key,
            reference: section.key,
            title: `${section.key} is answered by a waiver, not by a response`,
            detail:
              `The waiver records a decision not to answer "${section.deliverable}". An evaluator sees an unanswered ` +
              'requirement and awards it nothing, whatever the internal reason was.',
            remedy: 'Write the section, or confirm with the bid director that the marks are being conceded.',
          }),
        );
        continue;
      }
      findings.push(
        finding({
          lens: 'COMPLIANCE',
          severity: section.mandatory ? 'CRITICAL' : 'MEDIUM',
          sectionKey: section.key,
          reference: section.key,
          title: `${section.key} has no response`,
          detail: `Nothing is written against "${section.deliverable}".`,
          remedy: section.mandatory
            ? 'A mandatory requirement with no response is not marked down, it is rejected. Write it or waive it.'
            : 'Write it, or accept the marks are conceded.',
        }),
      );
      continue;
    }

    // Stale: the requirement moved after this was written.
    const stale = staleKeys.get(section.key);
    if (stale) {
      findings.push(
        finding({
          lens: 'COMPLIANCE',
          severity: 'HIGH',
          sectionKey: section.key,
          reference: section.key,
          title: `${section.key} answers a requirement that has since changed`,
          detail: stale,
          remedy: 'Rewrite the section against the current wording, or record why the existing answer still stands.',
        }),
      );
    }

    // A placeholder in a submission is the classic disqualification.
    if (PLACEHOLDER.test((section.body ?? []).join(' '))) {
      findings.push(
        finding({
          lens: 'ADVERSARIAL',
          severity: 'CRITICAL',
          sectionKey: section.key,
          reference: section.key,
          title: `${section.key} still carries a placeholder`,
          detail:
            'The prose contains an unresolved marker — a bracket, a TBC or an instruction to the bid team. Sent as it ' +
            'stands it tells the buyer the submission was not finished.',
          remedy: 'Replace the marker with the real content, or delete the sentence.',
        }),
      );
    }

    // A figure the drafting constraint forbade: the model cannot know it, so
    // wherever one appears it was either invented or inserted without a source.
    if (section.authorship === 'AI_DRAFTED' && FIGURE.test((section.body ?? []).join(' '))) {
      findings.push(
        finding({
          lens: 'CONTRACT',
          severity: 'HIGH',
          sectionKey: section.key,
          reference: section.key,
          title: `${section.key} states a figure the drafting rule forbade`,
          detail:
            'An AI-drafted section carries a sum or a percentage. The drafting constraint forbids stated figures ' +
            'precisely because the model has no source for one, and a number in a submission is a representation to ' +
            'the buyer.',
          remedy: 'Check the figure against the record it should come from, or take it out.',
        }),
      );
    }

    // Can a scorer find the answer without inference?
    if (line) {
      const terms = keyTerms(line.requirement);
      if (terms.length >= 4) {
        const found = terms.filter((term) => usesTerm(prose, term));
        if (found.length * 2 < terms.length) {
          const missing = terms.filter((term) => !usesTerm(prose, term)).slice(0, 6);
          findings.push(
            finding({
              lens: 'EVALUATOR',
              severity: 'MEDIUM',
              sectionKey: section.key,
              reference: section.key,
              title: `${section.key} does not use the buyer's own words`,
              detail:
                `The requirement turns on ${terms.length} distinctive terms and the response uses ${found.length} of ` +
                `them. Missing: ${missing.join(', ')}. A scorer working through a matrix looks for the term and ` +
                'awards what they can find.',
              remedy: 'Answer in the buyer’s vocabulary, and name each element they asked for explicitly.',
            }),
          );
        }
      }

      const weighting = line.weightingPercent ?? 0;
      if (weighting > 0 && median > 0 && (section.words ?? 0) > 0) {
        const density = (section.words ?? 0) / weighting;
        if (density < median / 2) {
          findings.push(
            finding({
              lens: 'EVALUATOR',
              severity: 'MEDIUM',
              sectionKey: section.key,
              reference: section.key,
              title: `${section.key} is thin for its weighting`,
              detail:
                `It carries ${weighting}% of the marks and ${section.words} words — under half the words per mark of ` +
                'the rest of this submission.',
              remedy: 'Either it needs more, or the effort elsewhere is going where the marks are not.',
            }),
          );
        } else if (density > median * 3) {
          findings.push(
            finding({
              lens: 'EVALUATOR',
              severity: 'LOW',
              sectionKey: section.key,
              reference: section.key,
              title: `${section.key} is long for its weighting`,
              detail:
                `It carries ${weighting}% of the marks and ${section.words} words — over three times the words per ` +
                'mark of the rest of this submission. Length is not marked; answers are.',
              remedy: 'Cut it back to what answers the question, or move the effort to a heavier requirement.',
            }),
          );
        }
      }
    }
  }

  // Evidence, against the day the buyer reads it rather than against today.
  for (const line of matrix) {
    if (!line.evidenceRequired) continue;
    const covering = claims.filter((claim) => claim.covers.includes(line.reference));
    const held = line.evidenceHeld !== undefined && line.evidenceHeld !== '';

    if (covering.length === 0 && !held) {
      findings.push(
        finding({
          lens: 'EVIDENCE',
          severity: line.mandatory ? 'HIGH' : 'MEDIUM',
          reference: line.reference,
          title: `${line.reference} asks for evidence nothing answers`,
          detail: `The buyer asked for ${line.evidenceRequired}, and no claim in the register covers this reference.`,
          remedy: 'Assert a claim against the document that proves it, and have somebody verify it.',
        }),
      );
      continue;
    }

    for (const claim of covering) {
      if (claim.standing === 'EXPIRED' || (claim.expiresAt !== undefined && claim.expiresAt < returnBy)) {
        findings.push(
          finding({
            lens: 'EVIDENCE',
            severity: 'CRITICAL',
            reference: line.reference,
            title: `${claim.reference} lapses before this is read`,
            detail:
              `"${claim.claim}" rests on a document that expires ${claim.expiresAt ?? 'already'} and the return date ` +
              `is ${returnBy}. Evidence that is not current on the day it is read is not evidence.`,
            remedy: 'File the current document and assert against that.',
          }),
        );
      } else if (claim.standing === 'PENDING') {
        findings.push(
          finding({
            lens: 'EVIDENCE',
            severity: line.mandatory ? 'HIGH' : 'LOW',
            reference: line.reference,
            title: `${claim.reference} has not been verified`,
            detail: `"${claim.claim}" is asserted and nobody has checked the document says it.`,
            remedy: 'Have somebody other than the asserter verify it before the pack is issued.',
          }),
        );
      } else if (claim.standing === 'REJECTED') {
        findings.push(
          finding({
            lens: 'EVIDENCE',
            severity: line.mandatory ? 'CRITICAL' : 'HIGH',
            reference: line.reference,
            title: `${claim.reference} was rejected`,
            detail: `"${claim.claim}" was refused by a reviewer and still stands against ${line.reference}.`,
            remedy: 'Assert a new claim against better evidence.',
          }),
        );
      }
    }
  }

  // A stated deadline with no date is a commitment nobody can meet on purpose.
  for (const deadline of pack.deadlines) {
    if (deadline.on) continue;
    findings.push(
      finding({
        lens: 'PROGRAMME',
        severity: 'HIGH',
        title: 'A stated deadline carries no date',
        detail: `"${deadline.what}" is in the submission schedule with nothing to meet.`,
        remedy: 'Read the date out of the invitation and record it, or ask the buyer in a clarification.',
      }),
    );
  }

  return findings;
}

/**
 * What an evaluator can find and award, weighted by the marks each requirement carries.
 *
 * Multiplicative rather than additive: two `HIGH` findings against one section
 * leave a quarter of its marks, not none, because a section with two problems is
 * worse than a section with one and is not the same as a blank page.
 */
export function scoreFrom(
  matrix: MatrixLine[],
  findings: AssuranceFinding[],
  /**
   * References that have prose written against them.
   *
   * Separate from severity on purpose, because the two answer different
   * questions. A severity says what a finding does to the *submission*; this
   * says what it does to the *marks*. An unanswered requirement that is not
   * mandatory is only a `MEDIUM` — the submission is not rejected for it — and
   * it still scores nothing, because there is nothing on the page to award.
   */
  answered?: Set<string>,
): { percent: number; basis: ScoreBasisLine[] } {
  const scored = matrix.filter((line) => (line.weightingPercent ?? 0) > 0);
  if (scored.length === 0) return { percent: 0, basis: [] };

  const basis: ScoreBasisLine[] = scored.map((line) => {
    const against = findings.filter((entry) => entry.reference === line.reference);
    const blank = answered !== undefined && !answered.has(line.reference);
    const fraction = blank ? 0 : against.reduce((carried, entry) => carried * SEVERITY_RETAINS[entry.severity], 1);
    return {
      reference: line.reference,
      weightingPercent: line.weightingPercent!,
      awardedFraction: Math.round(fraction * 100) / 100,
      why: blank
        ? 'Nothing is written against it, so there is nothing to award.'
        : against.length === 0
          ? 'Nothing found against it.'
          : against.map((entry) => `${entry.severity}: ${entry.title}`).join('; '),
    };
  });

  const weight = basis.reduce((sum, line) => sum + line.weightingPercent, 0);
  const awarded = basis.reduce((sum, line) => sum + line.weightingPercent * line.awardedFraction, 0);
  return { percent: Math.round((awarded / weight) * 1000) / 10, basis };
}

/**
 * Attack the pack.
 *
 * `ESTIMATE_TENDER` `C`: a review is a record somebody authors, not an approval.
 * Disposing of a finding is the approval, and that is `A`.
 */
export async function challengeSubmission(
  ctx: EngineContext,
  input: { packId: string },
): Promise<{ review: AssuranceReview; acuConsumed: number }> {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3', lifecyclePhase: currentPhase(ctx) });

  const pack = requirePack(ctx, input.packId);
  if (pack.status === 'ISSUED') {
    throw new DomainError(
      'BID_RESPONSE_ISSUED',
      `${pack.reference} has been issued. Reviewing it now changes nothing about what the buyer received.`,
      409,
    );
  }

  const analysis = complianceMatrix(ctx, pack.analysisId);
  const waivedKeys = new Set(liveWaivers(ctx, pack.analysisId).map((waiver) => waiver.reference));
  const register = evidenceRegister(ctx, pack.returnBy.slice(0, 10));
  const staleKeys = new Map(
    openImpacts(ctx, pack.analysisId)
      .filter((impact) => impact.material)
      .map((impact) => [impact.reference, `${impact.addendum}: ${impact.detail}`] as const),
  );

  const findings = evaluatorFindings({
    pack,
    matrix: analysis.matrix,
    waivedKeys,
    claims: register.claims.map((claim) => ({
      reference: claim.reference,
      claim: claim.claim,
      covers: claim.covers,
      standing: claim.standing,
      ...(claim.expiresAt === undefined ? {} : { expiresAt: claim.expiresAt }),
    })),
    staleKeys,
  });

  const { challenge, added, acuConsumed } = await modelChallenge(ctx, pack, analysis.matrix);
  findings.push(...added);

  // Everything except a section with no prose on it. A requirement the platform
  // evidences from its own records has no section at all and is answered by the
  // attachment, so it is not a blank page; a waived one is, whatever the
  // internal reason was, because a scorer awards what is in front of them.
  const blank = new Set(
    pack.sections
      .filter((section) => section.status !== 'DRAFTED' || (section.body ?? []).length === 0)
      .map((section) => section.key),
  );
  const answered = new Set(analysis.matrix.map((line) => line.reference).filter((reference) => !blank.has(reference)));
  const { percent, basis } = scoreFrom(analysis.matrix, findings, answered);

  const limits = [
    'This is the weighted proportion of marks an evaluator can find and award, not a predicted mark. Nothing here is ' +
      'calibrated against real feedback, because the learning loop that would calibrate it is not built.',
    ...(challenge.ran
      ? []
      : [`The judgement lens did not run: ${challenge.reason ?? 'no reasoning provider answered'}. Only the ` +
          'deterministic lenses are represented below.']),
    ...(challenge.ran && challenge.independent === false
      ? [`The model challenge ran on ${challenge.provider}, the same provider that drafted the prose. It is a second ` +
          'pass, not an independent one.']
      : []),
  ];

  const id = ulid();
  const counts = (severity: FindingSeverity): number => findings.filter((entry) => entry.severity === severity).length;
  const review: AssuranceReview = {
    id,
    reference: formatRef('ASR', reviewsOf(ctx).length + 1),
    packId: pack.id,
    analysisId: pack.analysisId,
    packPasses: pack.passes,
    runAt: new Date().toISOString(),
    runBy: ctx.auth.actorId,
    findings,
    findableScorePercent: percent,
    scoreBasis: basis,
    modelChallenge: challenge,
    limits,
    summary:
      findings.length === 0
        ? `Nothing found against ${pack.reference}. ${percent}% of the weighted marks are findable.`
        : `${findings.length} finding(s) against ${pack.reference} — ${counts('CRITICAL')} critical, ${counts('HIGH')} high, ` +
          `${counts('MEDIUM')} medium, ${counts('LOW')} low. ${percent}% of the weighted marks are findable as it stands.`,
  };

  write(ctx, {
    eventType: 'ASSURANCE_REVIEW_RUN',
    entity: { refType: 'AssuranceReview', refId: id },
    nextState: review as unknown as Record<string, unknown>,
  });

  return { review, acuConsumed };
}

/**
 * The judgement lens.
 *
 * Runs without `requireModel`, because a deployment with no reasoning provider
 * must still be able to run the deterministic gate — refusing the whole review
 * would leave the submission with no red team at all rather than with a partial
 * one that says what it is. A synthetic answer is discarded and recorded as not
 * run; it is never read as findings.
 */
async function modelChallenge(
  ctx: EngineContext,
  pack: BidResponsePack,
  matrix: MatrixLine[],
): Promise<{ challenge: ModelChallenge; added: AssuranceFinding[]; acuConsumed: number }> {
  const drafted = pack.sections.filter((section) => section.status === 'DRAFTED' && (section.body ?? []).length > 0);
  if (drafted.length === 0) {
    return {
      challenge: { ran: false, reason: 'Nothing is drafted yet, so there is nothing to challenge.', findings: 0 },
      added: [],
      acuConsumed: 0,
    };
  }

  const authors = new Set(drafted.map((section) => section.provider).filter((name): name is string => Boolean(name)));
  const lineOf = new Map(matrix.map((line) => [line.reference, line]));

  let result;
  try {
    result = await runAI(ctx, {
      engine: 'TENDER',
      // A different task type from `bid_response_section`, which is what makes
      // the prompt lineage different rather than the same prompt asked twice.
      taskType: 'evaluator_simulation',
      capability: 'REASONING',
      inputRefs: [{ refType: 'BidResponsePack', refId: pack.id }],
      request: {
        task:
          'You are the employer’s evaluator, scoring a construction tender submission against the published ' +
          'requirements. You did not write this and you are not trying to help it. For each response, find what a ' +
          'scorer cannot award: a sub-question left unanswered, an assertion with nothing behind it, a claim that ' +
          'contradicts another section, wording that concedes a departure. Return JSON with `findings`: an array of ' +
          '{ sectionKey, lens, severity, title, detail, remedy }. `lens` is one of COMPLIANCE, EVALUATOR, COMMERCIAL, ' +
          'TECHNICAL, PROGRAMME, CONTRACT, EVIDENCE, ADVERSARIAL, EXECUTIVE. `severity` is HIGH, MEDIUM or LOW.',
        payload: {
          client: pack.clientName,
          returnBy: pack.returnBy,
          sections: drafted.map((section) => ({
            sectionKey: section.key,
            requirement: section.deliverable,
            weightingPercent: lineOf.get(section.key)?.weightingPercent ?? null,
            mandatory: section.mandatory,
            response: (section.body ?? []).join('\n\n'),
          })),
          constraint:
            'Raise nothing you cannot point at in the text in front of you. An invented weakness costs the bid team ' +
            'the time to disprove it and teaches them to ignore the next one. Return an empty array if the ' +
            'submission answers what was asked.',
        },
      },
      toWrites: () => [],
    });
  } catch (error) {
    // A provider outage, an empty wallet, a refused engine: the deterministic
    // gate still stands, and the review says the judgement lens is missing.
    return {
      challenge: { ran: false, reason: (error as { message?: string }).message ?? 'The model challenge failed.', findings: 0 },
      added: [],
      acuConsumed: 0,
    };
  }

  if (result.synthetic) {
    return {
      challenge: {
        ran: false,
        provider: result.provider,
        reason:
          'This deployment is running the local stand-in, which reasons about nothing. A red team that reports an ' +
          'empty list because it never ran reads as a clean submission, so nothing it returned was used.',
        findings: 0,
      },
      added: [],
      acuConsumed: result.acuConsumed,
    };
  }

  const keys = new Set(drafted.map((section) => section.key));
  const raw = (result.output as { findings?: unknown }).findings;
  const added: AssuranceFinding[] = (Array.isArray(raw) ? raw : [])
    .slice(0, MODEL_FINDING_CAP)
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => typeof entry.title === 'string' && String(entry.title).trim().length > 0)
    // A finding against a section that is not in the pack is a finding about
    // something else. Dropped rather than renamed, because guessing which
    // section was meant is how a red team starts inventing.
    .filter((entry) => entry.sectionKey === undefined || keys.has(String(entry.sectionKey)))
    .map((entry) => {
      const lens = ASSURANCE_LENS.includes(entry.lens as AssuranceLens) ? (entry.lens as AssuranceLens) : 'ADVERSARIAL';
      const claimed = String(entry.severity ?? '').toUpperCase() as FindingSeverity;
      // Capped, not trusted. A model may not raise a hard block.
      const severity: FindingSeverity =
        claimed === 'HIGH' || claimed === 'CRITICAL'
          ? MODEL_SEVERITY_CEILING
          : FINDING_SEVERITY.includes(claimed)
            ? claimed
            : 'MEDIUM';
      const sectionKey = entry.sectionKey === undefined ? undefined : String(entry.sectionKey);
      return {
        id: ulid(),
        lens,
        severity,
        ...(sectionKey === undefined ? {} : { sectionKey, reference: sectionKey }),
        title: String(entry.title).trim(),
        detail: String(entry.detail ?? '').trim() || 'The challenge gave no detail beyond the title.',
        remedy: String(entry.remedy ?? '').trim() || 'Read the section against the requirement and decide.',
        raisedBy: 'MODEL' as const,
      };
    });

  const independent = authors.size === 0 ? undefined : !authors.has(result.provider);

  return {
    challenge: {
      ran: true,
      provider: result.provider,
      ...(result.modelClass === undefined ? {} : { modelClass: result.modelClass }),
      ...(independent === undefined ? {} : { independent }),
      ...(independent === false
        ? { reason: `Routed to ${result.provider}, which also drafted the prose. A second pass, not an independent one.` }
        : {}),
      findings: added.length,
    },
    added,
    acuConsumed: result.acuConsumed,
  };
}

/**
 * Record what somebody decided about a finding.
 *
 * `ESTIMATE_TENDER` `A`, because this is the act of accepting a risk on the
 * submission's behalf. A `CRITICAL` finding cannot be disposed of: §16.3 calls
 * it a hard block, and a hard block with a way round it is a warning.
 */
export function disposeFinding(
  ctx: EngineContext,
  reviewId: string,
  findingId: string,
  input: { decision: FindingDisposition['decision']; note: string },
): AssuranceReview {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireReview(ctx, reviewId);
  const review = record.state as unknown as AssuranceReview;

  const entry = review.findings.find((candidate) => candidate.id === findingId);
  if (!entry) {
    throw new DomainError('FINDING_NOT_FOUND', `${review.reference} carries no finding ${findingId}`, 404);
  }
  if (entry.severity === 'CRITICAL') {
    throw new DomainError(
      'FINDING_CRITICAL',
      `"${entry.title}" is critical: ${SUBMISSION_EFFECT.CRITICAL} Fix it and run the review again — a hard block ` +
        'with a way round it is a warning, and everybody learns to use the way round.',
      409,
    );
  }
  if (entry.disposition) {
    throw new DomainError(
      'FINDING_DISPOSED',
      `${entry.disposition.by} already recorded "${entry.disposition.decision}" against this on ` +
        `${entry.disposition.at.slice(0, 10)}.`,
      409,
    );
  }

  const note = input.note.trim();
  if (note.length < NOTE_MIN) {
    throw new DomainError(
      'DISPOSITION_NOTE_REQUIRED',
      `Write what was decided, in at least ${NOTE_MIN} characters. The question three weeks later is never whether ` +
        'somebody clicked it — it is what they concluded and on what basis.',
      422,
      [{ field: 'note', message: `At least ${NOTE_MIN} characters` }],
    );
  }

  const disposed: AssuranceReview = {
    ...review,
    findings: review.findings.map((candidate) =>
      candidate.id === findingId
        ? {
            ...candidate,
            disposition: { decision: input.decision, note, by: ctx.auth.actorId, at: new Date().toISOString() },
          }
        : candidate,
    ),
  };

  write(ctx, {
    eventType: 'ASSURANCE_FINDING_DISPOSED',
    entity: { refType: 'AssuranceReview', refId: review.id },
    nextState: disposed as unknown as Record<string, unknown>,
    reason: `${input.decision}: ${note}`,
  });

  return disposed;
}

/** The most recent review of one pack, or nothing. */
export function latestReview(ctx: EngineContext, packId: string): AssuranceReview | undefined {
  return reviewsOf(ctx)
    .filter((review) => review.packId === packId)
    .sort((a, b) => b.runAt.localeCompare(a.runAt))[0];
}

export type AssuranceStanding = {
  clear: boolean;
  /** Why not. Empty where it is clear. */
  blocking: AssuranceFinding[];
  /** Whether a review has been run against the pack as it stands. */
  current: boolean;
  reason: string;
};

/**
 * Whether the red team clears the submission.
 *
 * Three ways it does not: no review has been run, the review is of an earlier
 * version of the pack, or findings are open that block. **A review that was
 * never run and a review that found nothing must not look the same**, which is
 * the whole reason this returns `current` separately from `clear`.
 */
export function assuranceStanding(
  review: AssuranceReview | undefined,
  pack: BidResponsePack,
): AssuranceStanding {
  if (!review) {
    return {
      clear: false,
      blocking: [],
      current: false,
      reason:
        `No assurance review has been run against ${pack.reference}. A submission nothing has attacked is not a ` +
        'submission nothing is wrong with.',
    };
  }
  if (review.packPasses !== pack.passes) {
    return {
      clear: false,
      blocking: [],
      current: false,
      reason:
        `${review.reference} reviewed this pack after ${review.packPasses} pass(es) and it has had ${pack.passes}. ` +
        'Sections written since have not been attacked. Run it again.',
    };
  }

  const blocking = review.findings.filter(
    (entry) => entry.severity === 'CRITICAL' || (entry.severity === 'HIGH' && !entry.disposition),
  );

  return {
    clear: blocking.length === 0,
    blocking,
    current: true,
    reason:
      blocking.length === 0
        ? `${review.reference} is clear: nothing critical, and every high finding has a recorded decision.`
        : `${review.reference} blocks the submission — ` +
          blocking.map((entry) => `${entry.severity}: ${entry.title}`).join('; ') +
          '.',
  };
}

export type AssuranceRegister = {
  reviews: Array<{
    reference: string;
    id: string;
    packId: string;
    runAt: string;
    findableScorePercent: number;
    critical: number;
    high: number;
    openHigh: number;
    modelRan: boolean;
    summary: string;
  }>;
  lenses: Array<{ lens: AssuranceLens; question: string }>;
  severities: Array<{ severity: FindingSeverity; effect: string }>;
  summary: string;
};

/** §16.2, published so the console names a lens the same way the engine does. */
const LENS_QUESTION: Record<AssuranceLens, string> = {
  COMPLIANCE: 'Did the response answer every requested element and attach the required evidence?',
  EVALUATOR: 'Can a scorer find the answer and award marks without inference?',
  COMMERCIAL: 'Do the commitments create unpriced scope or conflict with the qualifications?',
  TECHNICAL: 'Is the method feasible, coordinated and consistent with design maturity?',
  PROGRAMME: 'Can the sequence achieve the milestones using the stated resources and access?',
  CONTRACT: 'Does the wording concede a departure, create a warranty or waive a right?',
  EVIDENCE: 'Are the claims current, valid, permitted and traceable?',
  ADVERSARIAL: 'What would a competitor, a client reviewer or a claims specialist attack?',
  EXECUTIVE: 'Is the risk-adjusted return within authority and appetite?',
};

export function assuranceRegister(ctx: EngineContext): AssuranceRegister {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const reviews = reviewsOf(ctx)
    .sort((a, b) => b.runAt.localeCompare(a.runAt))
    .map((review) => {
      const count = (severity: FindingSeverity): number =>
        review.findings.filter((entry) => entry.severity === severity).length;
      return {
        reference: review.reference,
        id: review.id,
        packId: review.packId,
        runAt: review.runAt,
        findableScorePercent: review.findableScorePercent,
        critical: count('CRITICAL'),
        high: count('HIGH'),
        openHigh: review.findings.filter((entry) => entry.severity === 'HIGH' && !entry.disposition).length,
        modelRan: review.modelChallenge.ran,
        summary: review.summary,
      };
    });

  const blocked = reviews.filter((review) => review.critical > 0 || review.openHigh > 0).length;

  return {
    reviews,
    lenses: ASSURANCE_LENS.map((lens) => ({ lens, question: LENS_QUESTION[lens] })),
    severities: FINDING_SEVERITY.map((severity) => ({ severity, effect: SUBMISSION_EFFECT[severity] })),
    summary:
      reviews.length === 0
        ? 'No submission has been attacked yet.'
        : `${reviews.length} review(s), ${blocked} of which block the submission they belong to.`,
  };
}

/** One review, in full. */
export function assuranceReview(ctx: EngineContext, reviewId: string): AssuranceReview {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  return requireReview(ctx, reviewId).state as unknown as AssuranceReview;
}
