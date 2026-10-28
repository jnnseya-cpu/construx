/**
 * The buyer-side rubric, and the rules that override it.
 *
 * ## Why this file is pure, and has no ledger and no context
 *
 * Every function here is a pure function of its inputs. That is not tidiness:
 * the same arithmetic has to produce the same answer in three places — the
 * scorer that writes a score, the screen that shows it, and the export gate
 * that refuses a pack — and a score computed differently in any of them is a
 * number somebody will act on that disagrees with the number somebody else is
 * looking at. `redteam.ts` makes the same choice for the same reason.
 *
 * ## The five criteria are weights, not opinions
 *
 * The weighted sum is `S = Σ wᵢ sᵢ`, each `sᵢ` in 0–100 and the weights summing
 * to 1. A rubric whose weights do not sum to 1 is refused at definition rather
 * than normalised quietly, because silently normalising means the rubric the
 * buyer published and the rubric the platform applied are two different
 * documents.
 *
 * ## The hard rules are the point
 *
 * Four of them, and each overrides the weighted score to red however well the
 * answer reads. They exist because each describes a submission that is **not
 * marked down — it is rejected**, and the whole value of scoring a pack before
 * it goes out is catching those while there is time:
 *
 *   1. a mandatory question with no answer, or a pass/fail question answered no;
 *   2. a cited certificate or insurance that expires before the deadline;
 *   3. a numeric declaration the customer's own admin has not confirmed;
 *   4. an answer more than 10% over a stated word limit.
 *
 * Rule 2 is judged **against the bid's deadline, not today**, because that is
 * the day the buyer reads it. Rule 3 cannot be satisfied by the provider at
 * all — only the customer confirms a declaration — which is why it is a hard
 * rule rather than a deduction: there is no amount of good prose that makes an
 * unconfirmed insurance value safe to send.
 *
 * ## What is deliberately not here
 *
 * No AI. Everything in this file is arithmetic and date comparison over records
 * the platform already holds. The model's contribution is the five criterion
 * scores, which arrive as inputs; turning those into a total, a band and a
 * verdict is not a judgement and must not vary between runs.
 */

export const RAG = ['RED', 'AMBER', 'GREEN'] as const;
export type Rag = (typeof RAG)[number];

/** The bands, matching the charity OS so one rubric serves both consumers. */
export const AMBER_FLOOR = 50;
export const GREEN_FLOOR = 80;

export function bandFor(score: number): Rag {
  if (score >= GREEN_FLOOR) return 'GREEN';
  if (score >= AMBER_FLOOR) return 'AMBER';
  return 'RED';
}

export const CRITERION = [
  'COMPLIANCE',
  'EVIDENCE',
  'BUYER_RELEVANCE',
  'SPECIFICITY',
  'CLARITY_AND_LIMITS',
] as const;
export type Criterion = (typeof CRITERION)[number];

/** Each criterion as a person names it, for a sentence somebody acts on. */
export const CRITERION_LABEL: Record<Criterion, string> = {
  COMPLIANCE: 'Compliance',
  EVIDENCE: 'Evidence',
  BUYER_RELEVANCE: 'Buyer relevance',
  SPECIFICITY: 'Specificity',
  CLARITY_AND_LIMITS: 'Clarity and limits',
};

/** What each criterion asks, in the words the scorer is given. */
export const CRITERION_QUESTION: Record<Criterion, string> = {
  COMPLIANCE: 'Is every part of the question answered, in the order asked?',
  EVIDENCE: 'Is every claim cited to an in-date evidence item, with no unsupported claim?',
  BUYER_RELEVANCE: 'Is it framed for this buyer’s sector, risks and scheme?',
  SPECIFICITY: 'Does it name projects, figures, dates and methods rather than generalising?',
  CLARITY_AND_LIMITS: 'Is it within the word limit, structured, and in plain English?',
};

/**
 * The default weights.
 *
 * The specification's own figures, and they are a **default** rather than a
 * constant: a rubric is per scheme and per version, and a buyer who weights
 * social value at 40% is not wrong. `defineRubric` takes its own weights and
 * this is what it falls back to.
 */
export const DEFAULT_WEIGHTS: Record<Criterion, number> = {
  COMPLIANCE: 0.3,
  EVIDENCE: 0.25,
  BUYER_RELEVANCE: 0.2,
  SPECIFICITY: 0.15,
  CLARITY_AND_LIMITS: 0.1,
};

export type Rubric = {
  id: string;
  /** The buyer's scheme this rubric is written for. */
  scheme: string;
  version: number;
  weights: Record<Criterion, number>;
  /** Who wrote it. The rubric is the module's own IP and is attributed. */
  owner: string;
  definedAt: string;
  definedBy: string;
  supersedes?: string;
};

/** A score the scorer returned, before any hard rule is applied. */
export type CriterionScores = Record<Criterion, number>;

export const HARD_RULE = [
  'MANDATORY_UNANSWERED',
  'PASS_FAIL_FAILED',
  'EVIDENCE_LAPSES_BEFORE_DEADLINE',
  'DECLARATION_UNCONFIRMED',
  'OVER_WORD_LIMIT',
] as const;
export type HardRule = (typeof HARD_RULE)[number];

/**
 * The hard rules that are a wall, not a to-do.
 *
 * A pass/fail answered "no", a certificate that lapses before the deadline, an
 * unconfirmed declaration: each means a requirement the buyer set is not met,
 * and no amount of writing or reviewing in this tool clears it — something has
 * to change in the world (the accreditation is obtained, the certificate is
 * renewed, the customer confirms the declaration). That is a different thing to
 * say to a client than "an answer is weak" or "nobody has approved it yet", and
 * the gate leads with it so a client reads the exclusion rather than inferring
 * its severity from a count.
 *
 * The others are work still to do inside the pack — a mandatory question is
 * answered, a weak answer is redrafted, an over-length one is trimmed — and
 * those are reachable without leaving the tool, so they are not walls.
 */
export const REQUIREMENT_WALL_RULES: readonly HardRule[] = [
  'PASS_FAIL_FAILED',
  'EVIDENCE_LAPSES_BEFORE_DEADLINE',
  'DECLARATION_UNCONFIRMED',
];

/** How far over a stated limit is tolerated before the rule fires. */
export const WORD_LIMIT_TOLERANCE = 0.1;

export type HardRuleHit = {
  rule: HardRule;
  /** Why it fired, in the words somebody fixing it needs. */
  detail: string;
  /** What to do about it. Never absent: a block with no remedy is a dead end. */
  remedy: string;
};

export type Verdict = {
  /** The weighted sum, 0–100, before any hard rule. Kept so a red is explainable. */
  weightedScore: number;
  /** What the weighted sum alone would have been. */
  weightedBand: Rag;
  /** The published verdict, after hard rules. */
  rag: Rag;
  hardRules: HardRuleHit[];
  /** The working, so a score is arguable rather than asserted. */
  basis: Array<{ criterion: Criterion; score: number; weight: number; contribution: number }>;
  /** What would make this green. Absent where it already is. */
  toGreen?: ToGreen;
};

/**
 * What this answer needs to clear the green floor.
 *
 * Arithmetic, not advice. The verdict already published a number and a colour
 * and left the person holding it to work out what to do — and "red 40" with a
 * 500-word limit and five weighted criteria is not something anybody works out
 * in their head on a tender week. The shortfall is exactly computable from the
 * weights, so it is computed.
 *
 * `routes` is every criterion that could close the gap **on its own** and the
 * mark it would have to reach, which is the honest way to show a weighted sum:
 * Evidence at 25% needs four points for every one that Clarity at 10% needs
 * ten. Where no single criterion can do it — the gap is wider than any one
 * criterion's remaining headroom buys — the list is empty and `note` says so,
 * because the answer then needs work in more than one place and pretending
 * otherwise would send somebody to polish the wrong thing.
 *
 * A hard rule is not a shortfall and is never expressed as one. It overrides
 * the score to red whatever the prose scores, so `blockedByHardRules` is said
 * first and separately: an expired certificate is not fixed by writing better.
 */
export type ToGreen = {
  /** Weighted points short of the green floor. Zero where only a rule blocks it. */
  shortBy: number;
  /** True where a hard rule holds it red regardless of the score. */
  blockedByHardRules: boolean;
  /** Single-criterion routes to green: the criterion, its mark now, and the mark it needs. */
  routes: Array<{ criterion: Criterion; from: number; to: number; weight: number }>;
  note: string;
};

/**
 * The shortfall, from the scores and the weights that produced it.
 *
 * Pure, and separate from `verdictFor`, so the one piece of arithmetic a person
 * acts on can be tested directly rather than inferred from a colour.
 */
export function toGreenFrom(
  scores: CriterionScores,
  score: number,
  hardRules: HardRuleHit[],
  scored: boolean,
  weights: Record<Criterion, number> = DEFAULT_WEIGHTS,
): ToGreen | undefined {
  if (hardRules.length === 0 && score >= GREEN_FLOOR) return undefined;

  const shortBy = round(Math.max(0, GREEN_FLOOR - score));
  const routes = CRITERION.map((criterion) => ({
    criterion,
    from: scores[criterion],
    to: round(scores[criterion] + shortBy / weights[criterion]),
    weight: weights[criterion],
  }))
    .filter((route) => route.to <= 100 && route.to > route.from)
    .sort((left, right) => left.to - left.from - (right.to - right.from));

  const said = (route: { criterion: Criterion; from: number; to: number }): string =>
    `${CRITERION_LABEL[route.criterion]} from ${route.from} to ${route.to}`;

  return {
    shortBy,
    blockedByHardRules: hardRules.length > 0,
    routes,
    note: !scored
      ? 'Not scored yet. An unscored answer is red because nothing has read it, not because it is bad — score it ' +
        'before judging it.'
      : hardRules.length > 0 && shortBy === 0
        ? `The prose is green at ${score}. A hard rule holds it red: ${hardRules.map((hit) => hit.remedy).join('; ')}.`
        : hardRules.length > 0
          ? `${shortBy} point(s) short of green at ${score}, and a hard rule holds it red whatever the prose ` +
            `scores: ${hardRules.map((hit) => hit.remedy).join('; ')}.`
          : routes.length === 0
            ? `${shortBy} point(s) short of green at ${score}, and no single criterion can close it — this needs ` +
              'work in more than one place, starting with the heaviest: ' +
              CRITERION.map((criterion) => `${CRITERION_LABEL[criterion]} ${scores[criterion]}`).join(', ') +
              '.'
            : `${shortBy} point(s) short of green at ${score}. Any one of these would do it: ` +
              `${routes.slice(0, 3).map(said).join('; ')}.`,
  };
}

/**
 * What the verdict is judged against.
 *
 * Deliberately a flat input rather than the records themselves. It keeps this
 * file pure and testable, and it makes the four hard rules readable as the four
 * sentences they are instead of as traversals of three entities.
 */
export type ScoreInput = {
  /** The criterion scores, where the scorer produced them. Absent means unanswered. */
  scores?: CriterionScores;
  answered: boolean;
  mandatory: boolean;
  /** A pass/fail question, and whether it was answered yes. */
  passFail: boolean;
  passFailAnswer?: boolean;
  /** Words actually written, counted from the prose. */
  words: number;
  /** The stated limit, where the buyer stated one. */
  wordLimit?: number;
  /** The day the buyer reads it. Every expiry is judged against this. */
  deadline: string;
  /** Cited evidence, with the day each stops being current. */
  citations: Array<{ reference: string; title: string; expiresOn?: string }>;
  /**
   * Declarations this answer rests on, and whether the customer's own admin has
   * confirmed each. An unconfirmed one is a hard red and the provider cannot
   * clear it.
   */
  declarations: Array<{ statement: string; confirmed: boolean }>;
};

const round = (value: number): number => Math.round(value * 10) / 10;

/** The weighted sum and its working. Hard rules are applied separately. */
export function weightedScore(
  scores: CriterionScores,
  weights: Record<Criterion, number> = DEFAULT_WEIGHTS,
): { score: number; basis: Verdict['basis'] } {
  const basis = CRITERION.map((criterion) => {
    const score = scores[criterion];
    const weight = weights[criterion];
    return { criterion, score, weight, contribution: round(score * weight) };
  });
  return { score: round(basis.reduce((sum, entry) => sum + entry.score * entry.weight, 0)), basis };
}

/**
 * Every hard rule that fires, in the order the specification lists them.
 *
 * All of them, not the first. A reviewer fixing one at a time is a reviewer
 * who finds the second one after they thought they were finished, and on the
 * return date that is the difference between a submission and a missed
 * deadline.
 */
export function hardRuleHits(input: ScoreInput): HardRuleHit[] {
  const hits: HardRuleHit[] = [];
  const deadline = input.deadline.slice(0, 10);

  if (input.mandatory && !input.answered) {
    hits.push({
      rule: 'MANDATORY_UNANSWERED',
      detail: 'A mandatory question has no answer.',
      remedy:
        'A mandatory question with no response is not marked down, it is rejected, and everything else in the pack ' +
        'is spent for nothing. Answer it.',
    });
  }

  if (input.passFail && input.passFailAnswer === false) {
    hits.push({
      rule: 'PASS_FAIL_FAILED',
      detail: 'A pass/fail question is answered "no".',
      remedy:
        'This ends the bid at the gate. Either the position changes before the deadline, or the decision is not to ' +
        'bid — and that is a decision somebody should take deliberately rather than discover.',
    });
  }

  for (const citation of input.citations) {
    if (!citation.expiresOn) continue;
    if (citation.expiresOn.slice(0, 10) >= deadline) continue;
    hits.push({
      rule: 'EVIDENCE_LAPSES_BEFORE_DEADLINE',
      detail:
        `${citation.reference} — ${citation.title} — expires ${citation.expiresOn.slice(0, 10)}, before the ` +
        `deadline of ${deadline}.`,
      remedy:
        'Evidence that is not current on the day the buyer reads it is not evidence for this submission. File the ' +
        'renewed document and cite that.',
    });
  }

  for (const declaration of input.declarations) {
    if (declaration.confirmed) continue;
    hits.push({
      rule: 'DECLARATION_UNCONFIRMED',
      detail: `"${declaration.statement.slice(0, 80)}" has not been confirmed by the customer.`,
      remedy:
        'Only the customer’s own admin can confirm a declaration — not the provider and not an agent — because ' +
        'whoever confirms it is who the buyer will hold to it. Ask them.',
    });
  }

  if (input.wordLimit !== undefined && input.words > Math.floor(input.wordLimit * (1 + WORD_LIMIT_TOLERANCE))) {
    hits.push({
      rule: 'OVER_WORD_LIMIT',
      detail:
        `${input.words} words against a limit of ${input.wordLimit} — more than ` +
        `${Math.round(WORD_LIMIT_TOLERANCE * 100)}% over.`,
      remedy:
        'The standard instruction is that anything past a stated limit is not read, so the answer is scored on ' +
        'wherever it happens to stop. Cut it to length.',
    });
  }

  return hits;
}

/**
 * The published verdict for one answer.
 *
 * An unanswered question scores zero rather than nothing. "No score yet" and
 * "scored zero" look the same on a readiness figure and mean opposite things:
 * the first is work outstanding and the second is work that failed, so an
 * unanswered question is a zero with `MANDATORY_UNANSWERED` beside it where it
 * is mandatory, and the reason is always readable.
 */
export function verdictFor(input: ScoreInput, weights: Record<Criterion, number> = DEFAULT_WEIGHTS): Verdict {
  const scores = input.scores ?? (Object.fromEntries(CRITERION.map((c) => [c, 0])) as CriterionScores);
  const { score, basis } = weightedScore(scores, weights);
  const hardRules = hardRuleHits(input);

  return {
    weightedScore: score,
    weightedBand: bandFor(score),
    // The override, and it only ever goes one way. A hard rule cannot raise a
    // score, which is why `weightedBand` is kept beside the verdict: "this
    // would have been green" is what tells a reviewer the prose is fine and the
    // problem is a certificate.
    rag: hardRules.length > 0 ? 'RED' : bandFor(score),
    hardRules,
    basis,
    // What it would take, where it is not there yet. Computed beside the
    // verdict rather than left to whoever reads the colour.
    ...(() => {
      const lift = toGreenFrom(scores, score, hardRules, input.scores !== undefined, weights);
      return lift ? { toGreen: lift } : {};
    })(),
  };
}

export type ReadinessInput = Array<{
  /** The question's own weighting in the buyer's evaluation, where stated. */
  weighting?: number;
  /** The buyer's own number for the question, e.g. "1.1", so a block can name it. */
  reference?: string;
  mandatory: boolean;
  approved: boolean;
  verdict: Verdict;
}>;

/**
 * A returnable, as readiness needs to see one.
 *
 * Deliberately narrow: this file decides whether a pack may go, and for that it
 * needs to know only whether something mandatory is still outstanding. Format,
 * page limit, signature and owner are the register's business, not the gate's.
 */
export type ReturnableInput = Array<{
  reference: string;
  title: string;
  mandatory: boolean;
  outstanding: boolean;
  /** Why it is still outstanding, in the words the gate will refuse with. */
  reason?: string;
}>;

export type PackReadiness = {
  /** The weighted mean of answer scores, using each question's own weighting. */
  readinessPercent: number | null;
  answered: number;
  total: number;
  approved: number;
  red: number;
  amber: number;
  green: number;
  /**
   * Mandatory answers that are red or unapproved. Each one blocks the export.
   *
   * `reason` is why it is blocked; `remedy` is what to do about it — never
   * absent, because a block with no way out is a dead end. `requirementUnmet`
   * marks the ones that are a wall rather than a to-do (see
   * `REQUIREMENT_WALL_RULES`): a client reads those as "this cannot be
   * submitted", not "this needs more work".
   */
  blocking: Array<{
    index: number;
    reference?: string;
    reason: string;
    remedy: string;
    requirementUnmet: boolean;
    hardRule?: HardRule;
  }>;
  /**
   * Mandatory returnables nobody has supplied. Each one blocks the export too.
   *
   * Kept in its own list rather than merged into `blocking`, because that one is
   * indexed into the question array and a returnable has no question. Keyed by
   * the buyer's own reference, which is what a reviewer will look for.
   */
  returnablesOutstanding: Array<{ reference: string; title: string; reason: string }>;
  exportable: boolean;
  /**
   * The one thing a client should read first: can this be submitted, and if
   * not, the plainest statement of why — leading with a requirement that is not
   * met where there is one. See `SubmissionGate`.
   */
  gate: SubmissionGate;
  summary: string;
};

/**
 * The submission verdict in plain words, so a client is told it rather than
 * left to infer it from a readiness percentage and a severity count.
 *
 * `requirementUnmet` is the distinction that matters: a pack can be blocked
 * because there is still work to do (answer a question, approve a draft, supply
 * a document) or because a requirement the buyer set is simply not met (a
 * pass/fail answered no, evidence that has lapsed, a declaration the customer
 * has not confirmed). The first is a to-do list; the second is a wall, and a
 * client needs to see which one they are facing before they spend a week
 * polishing answers for a bid that will be excluded at the gate regardless.
 */
export type SubmissionGate = {
  /** The same truth as `exportable`, named for what a client asks: can we send it? */
  canSubmit: boolean;
  /** A requirement the buyer set is not met, and no work in this tool clears it. */
  requirementUnmet: boolean;
  /** The sentence to put at the top of the screen. Always set. */
  headline: string;
  /**
   * Everything standing between this pack and a submission, worst-first and in
   * one list — answers and returnables together, because a client should not
   * have to assemble the picture from two tables. Each carries what it is and
   * what to do about it; `requirementUnmet` flags the walls.
   */
  blockers: Array<{ reference?: string; what: string; remedy: string; requirementUnmet: boolean }>;
};

/**
 * Pack readiness, and whether it may be exported.
 *
 * The weighted mean uses each **question's** weighting rather than treating
 * every answer as equal, because a 30% question scoring 40 and a 2% question
 * scoring 40 are not the same problem. Where no question carries a weighting
 * the mean is unweighted and says so, rather than inventing weights that would
 * make the figure look more precise than it is.
 *
 * Export is blocked while any mandatory answer is red or unapproved — both, not
 * either. An approved red is still a rejection at the gate, and an unapproved
 * green has had no person's name on it.
 *
 * ## Returnables count too, and that is the second half of a submission
 *
 * An ITT is rarely only questions. A signed order form, a priced cost model, a
 * schedule of amendments accepted or qualified — a submission missing one of
 * those is rejected exactly as completely as one missing an answer, and a
 * readiness figure that read 100% while the order form was unsigned would be
 * the most expensive kind of wrong this module could be.
 *
 * `returnables` is optional, so a pack that has none behaves precisely as it
 * did before they existed: the figure, the blocking list and the gate are all
 * unchanged. A pack that has them cannot go while a mandatory one is
 * outstanding.
 */
export function packReadiness(answers: ReadinessInput, returnables: ReturnableInput = []): PackReadiness {
  const total = answers.length;
  const weighted = answers.filter((entry) => (entry.weighting ?? 0) > 0);
  const basis = weighted.length > 0 ? weighted : answers.map((entry) => ({ ...entry, weighting: 1 }));
  const weightTotal = basis.reduce((sum, entry) => sum + (entry.weighting ?? 1), 0);

  const readinessPercent =
    total === 0 || weightTotal === 0
      ? null
      : round(
          basis.reduce((sum, entry) => sum + entry.verdict.weightedScore * (entry.weighting ?? 1), 0) / weightTotal,
        );

  const blocking: PackReadiness['blocking'] = [];
  answers.forEach((entry, index) => {
    if (!entry.mandatory) return;
    const reference = entry.reference;
    if (entry.verdict.rag === 'RED') {
      const hardRules = entry.verdict.hardRules;
      const wall = hardRules.find((hit) => REQUIREMENT_WALL_RULES.includes(hit.rule));
      blocking.push({
        index,
        ...(reference ? { reference } : {}),
        reason:
          hardRules.length > 0
            ? hardRules.map((hit) => hit.detail).join(' ')
            : `Scored ${entry.verdict.weightedScore}, below the amber floor of ${AMBER_FLOOR}.`,
        remedy:
          hardRules.length > 0
            ? hardRules.map((hit) => hit.remedy).join(' ')
            : `Redraft it and score it again until it clears the amber floor of ${AMBER_FLOOR}.`,
        requirementUnmet: wall !== undefined,
        ...(hardRules[0] ? { hardRule: (wall ?? hardRules[0]).rule } : {}),
      });
      return;
    }
    if (!entry.approved) {
      blocking.push({
        index,
        ...(reference ? { reference } : {}),
        reason: 'Nobody has approved it, so no person has put their name to it.',
        remedy: 'A reviewer reads it and approves it — approval is what puts a person’s name to the answer.',
        requirementUnmet: false,
      });
    }
  });

  const red = answers.filter((entry) => entry.verdict.rag === 'RED').length;
  const amber = answers.filter((entry) => entry.verdict.rag === 'AMBER').length;
  const green = answers.filter((entry) => entry.verdict.rag === 'GREEN').length;
  const approved = answers.filter((entry) => entry.approved).length;
  const answeredCount = answers.filter((entry) => entry.verdict.weightedScore > 0 || entry.approved).length;

  // The returnables half. Only the mandatory outstanding ones gate; an optional
  // one that nobody supplied is a decision, not a defect.
  const returnablesOutstanding = returnables
    .filter((entry) => entry.mandatory && entry.outstanding)
    .map((entry) => ({
      reference: entry.reference,
      title: entry.title,
      reason: entry.reason ?? 'Nobody has supplied it, and the buyer asked for it.',
    }));

  const answersDone = total > 0 && blocking.length === 0;
  const canSubmit = answersDone && returnablesOutstanding.length === 0;

  // One list of everything in the way, walls first, answers and returnables
  // together — so a client reads a single "what is stopping this" rather than
  // reconciling two tables and a percentage.
  const answerBlockers = blocking
    .map((entry) => ({
      ...(entry.reference ? { reference: entry.reference } : {}),
      what: entry.reference ? `Question ${entry.reference}: ${entry.reason}` : entry.reason,
      remedy: entry.remedy,
      requirementUnmet: entry.requirementUnmet,
    }))
    .sort((left, right) => Number(right.requirementUnmet) - Number(left.requirementUnmet));
  const returnableBlockers = returnablesOutstanding.map((entry) => ({
    reference: entry.reference,
    what: `${entry.title} — ${entry.reason}`,
    remedy: 'Supply it and mark it done, or waive it with a reason that would stand if the submission came back.',
    requirementUnmet: false,
  }));
  const blockers = [...answerBlockers, ...returnableBlockers];
  const wall = answerBlockers.find((entry) => entry.requirementUnmet);
  const requirementUnmet = wall !== undefined;
  const wallCount = answerBlockers.filter((entry) => entry.requirementUnmet).length;

  const headline =
    total === 0
      ? 'No questions have been confirmed for this pack yet, so there is nothing to submit.'
      : canSubmit
        ? 'This pack can be submitted: every mandatory answer is approved and out of red' +
          (returnables.length > 0 ? ', and every mandatory document is accounted for.' : '.')
        : requirementUnmet
          ? 'This bid cannot be submitted as it stands: a requirement the buyer set is not met. ' +
            `${wall?.what}` +
            (wallCount > 1 ? ` (and ${wallCount - 1} other requirement(s) like it).` : '') +
            ' No amount of work on the other answers clears this — it changes only if the requirement itself is ' +
            'met before the deadline, or the deliberate decision is not to bid.'
          : `This pack is not ready to submit yet: ${blockers.length} item(s) still to complete before it can go, ` +
            'and until the last one is done the pack cannot be exported.';

  const gate: SubmissionGate = { canSubmit, requirementUnmet, headline, blockers };

  return {
    readinessPercent,
    answered: answeredCount,
    total,
    approved,
    red,
    amber,
    green,
    blocking,
    returnablesOutstanding,
    exportable: canSubmit,
    gate,
    summary:
      total === 0
        ? 'Nothing parsed yet.'
        : `${green} green, ${amber} amber, ${red} red of ${total}; ${approved} approved` +
          (readinessPercent === null ? '' : `, readiness ${readinessPercent}%`) +
          (blocking.length > 0
            ? `. ${blocking.length} mandatory answer(s) are red or unapproved, so the pack cannot be exported.`
            : '. Every mandatory answer is approved and out of red.') +
          (returnablesOutstanding.length > 0
            ? ` ${returnablesOutstanding.length} mandatory returnable(s) are outstanding — ` +
              `${returnablesOutstanding.map((entry) => entry.reference).join(', ')} — and a submission missing one ` +
              'is rejected as completely as one missing an answer.'
            : returnables.length > 0
              ? ` All ${returnables.length} returnable(s) are accounted for.`
              : '') +
          (weighted.length === 0 && total > 0
            ? ' No question carries a stated weighting, so the readiness figure is an unweighted mean.'
            : ''),
  };
}
