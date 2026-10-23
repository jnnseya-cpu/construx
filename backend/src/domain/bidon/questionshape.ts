/**
 * Whether a document asks the reader anything.
 *
 * ## What this is for
 *
 * Somebody with nine filed documents looking for the questionnaire, one paid
 * model call at a time: the schedule of amendments, the insurance certificates,
 * the order form, a 382,691-character stock list, the cost model. Each attempt
 * read the document, called a vendor, was charged, and came back empty — and
 * the platform had already read all five, so it could have answered for
 * nothing.
 *
 * ## The first cut of this was wrong, and wrong in the instructive direction
 *
 * It counted the imperatives a questionnaire is written in — "describe",
 * "provide", "confirm", "state" — **anywhere in the text**. So a schedule of
 * amendments scored 131, a cost model 32, a specification 12, and nine
 * documents out of ten were labelled "looks like a question set". A label that
 * fires on everything is worse than no label: it costs the reader the one thing
 * it was added to give them.
 *
 * The mistake was counting the vocabulary instead of the **shape**. Contract
 * and specification prose is full of those verbs — *"the Contractor shall
 * provide"*, *"the Employer shall confirm"* — because that is how obligations
 * are written. A question is different in two visible ways, and both are
 * cheap to check:
 *
 *   - **It starts the line.** A questionnaire asks at the beginning of a line,
 *     after its number if it has one: `4.1 Describe your approach…`,
 *     `Please provide details of…`. A specification's "provide" sits in the
 *     middle of a sentence whose subject is the Contractor.
 *   - **It addresses the reader.** *Your* approach, *your* company, what *you*
 *     will do. A specification addresses a party in the third person, and a
 *     stock list addresses nobody.
 *
 * So `asking` is lines that *begin* by asking, and `addressed` counts the
 * second person. Numbered lines are kept but demoted to a tie-breaker: a stock
 * list of two thousand addresses is full of house numbers.
 *
 * ## It is a floor, not a judgement
 *
 * `parseQuestionnaire` refuses before calling a vendor only when a document
 * asks **nothing at all** — no question mark anywhere, no line that begins by
 * asking. One of either is enough to pass. Above that floor the counts are used
 * to *order* a chooser and to label it, never to stop anything, and `anyway`
 * overrides the floor itself: a heuristic that cannot be argued with is the
 * kind of invented rule that stops work.
 */

export type QuestionShape = {
  /** Lines that begin by asking the reader something, or end in a question mark. */
  asking: number;
  /** Lines ending in a question mark. The strongest single signal there is. */
  questions: number;
  /** Numbered lines. A tie-breaker only — a stock list is full of house numbers. */
  numbered: number;
  /** How often it addresses the reader: "your approach", "you must". */
  addressed: number;
  chars: number;
};

/** A number or reference at the start of a line: `4.1`, `SQ 6.2`, `3)`, `C12.` */
const LEADING_NUMBER = String.raw`(?:[A-Z]{1,4}[\s.]?)?\d{1,3}(?:[.)]\d{1,3}[a-z]?)*[\s).:\t-]+`;

/** The verbs a question opens with. Matched at the start of a line and nowhere else. */
const OPENS_A_QUESTION = String.raw`(?:please\b|describe\b|set\s+out\b|outline\b|explain\b|state\b|confirm\b|provide\b|detail\b|give\b|list\b|demonstrate\b|summaris[ei]\b|tell\s+us\b|how\b|what\b|why\b|when\b|which\b|who\b|do\s+you\b|have\s+you\b|are\s+you\b|can\s+you\b|will\s+you\b)`;

const ASKING_LINE = new RegExp(String.raw`^[\s>*·•-]*(?:${LEADING_NUMBER})?${OPENS_A_QUESTION}`, 'i');
const NUMBERED_LINE = new RegExp(String.raw`^[\s>*·•-]*${LEADING_NUMBER}`);
const SECOND_PERSON = /\b(?:your|yourself|you)\b/gi;

export function questionShape(text: string): QuestionShape {
  const lines = text.split(/\r?\n/);
  let asking = 0;
  let questions = 0;
  let numbered = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const isQuestion = trimmed.endsWith('?');
    if (isQuestion) questions += 1;
    if (isQuestion || ASKING_LINE.test(trimmed)) asking += 1;
    if (NUMBERED_LINE.test(trimmed)) numbered += 1;
  }

  return {
    asking,
    questions,
    numbered,
    addressed: (text.match(SECOND_PERSON) ?? []).length,
    chars: text.length,
  };
}

/**
 * Whether this reads as a set of questions put to a bidder.
 *
 * Question marks carry it on their own: three of them is a questionnaire and
 * not a contract. Without them it takes both halves — lines that begin by
 * asking **and** a document that addresses the reader — because either alone is
 * satisfied by a specification.
 */
export function looksLikeQuestionSet(shape: QuestionShape): boolean {
  if (shape.questions >= 3) return true;
  return shape.asking >= 3 && shape.addressed >= 3;
}

/** Nothing in it asks anything. The one case refused before a vendor is called. */
export function asksNothing(shape: QuestionShape): boolean {
  return shape.asking === 0 && shape.questions === 0;
}

/** The counts in a phrase a person can act on, for a chooser and for a refusal. */
export function describeShape(shape: QuestionShape): string {
  if (shape.questions > 0 && shape.asking > shape.questions) {
    return `${shape.asking} question-shaped lines, ${shape.questions} of them ending in a question mark`;
  }
  if (shape.questions > 0) return `${shape.questions} question${shape.questions === 1 ? '' : 's'}`;
  return `${shape.asking} line${shape.asking === 1 ? '' : 's'} that begin by asking something`;
}
