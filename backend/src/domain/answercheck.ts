import { DomainError } from '../core/errors.ts';
import { authorise, type EngineContext } from '../engines/context.ts';
import type { BidSection } from './bidresponse.ts';
import type { MatrixLine } from './itt.ts';
import { projectTender } from './tenderregister.ts';

/**
 * The drafted answers read against the question and against the rest of the bid.
 *
 * Two checks, both in code, both stated for what they are:
 *
 *   - **The question.** Each answer against the distinct things its question
 *     asks and the buyer's scoring criteria, as the reading recorded them: which
 *     sub-question the answer evidently addresses (its own words appear in the
 *     answer) and which it does not, and the length against the limit. This is
 *     coverage, not a mark: a sub-question can be named and answered badly. The
 *     change that would most improve an answer is the sub-question it leaves out.
 *   - **The rest of the bid.** A start date, a completion date or a duration
 *     an answer commits to, against the confirmed tender programme, the priced
 *     estimate and the contract dates in the pack; and the social-value
 *     commitments, listed for somebody to confirm are measurable, owned, costed
 *     and approved before they go to the buyer.
 */

export type SubQuestionCoverage = { text: string; addressed: boolean };

export type SectionCheck = {
  key: string;
  title: string;
  status: string;
  words: number;
  limit?: number;
  overLimit: boolean;
  scoringCriteria?: string;
  subQuestions: SubQuestionCoverage[];
  /** n of m sub-questions evidently addressed, where the question has them. */
  coverage?: string;
  improve: string[];
};

export type CommitmentKind = 'START' | 'COMPLETION' | 'DURATION' | 'SOCIAL_VALUE';

export type Commitment = {
  section: string;
  kind: CommitmentKind;
  /** The sentence it is in, as drafted. */
  statement: string;
  value: string;
  /** What it was checked against, and that thing's value; absent where there is nothing to check against. */
  against?: { what: string; value: string };
  /** true agrees, false disagrees, null nothing to check against (or a social-value commitment to confirm). */
  agrees: boolean | null;
};

export type AnswerCheck = {
  packId: string;
  sections: SectionCheck[];
  commitments: Commitment[];
  disagreements: number;
  summary: string;
};

const STOP = new Set(
  'the a an and or of to in on for with your you how will be is are as at by this that which what any all from into its their our we describe provide explain including include please set out'.split(
    ' ',
  ),
);
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));

/** Half the sub-question's own significant words appear in the answer — named, at least. */
function addressed(subQuestion: string, body: string): boolean {
  const wanted = [...new Set(words(subQuestion))];
  if (wanted.length === 0) return true;
  const have = new Set(words(body));
  const found = wanted.filter((word) => have.has(word) || have.has(word.replace(/s$/, '')) || have.has(`${word}s`)).length;
  return found / wanted.length >= 0.5;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Every date in a sentence, as YYYY-MM-DD: 18/01/2027, 18 January 2027, 2027-01-18. */
function datesIn(sentence: string): string[] {
  const found: string[] = [];
  for (const match of sentence.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    found.push(`${match[3]}-${match[2]!.padStart(2, '0')}-${match[1]!.padStart(2, '0')}`);
  }
  for (const match of sentence.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/gi)) {
    found.push(`${match[3]}-${String(MONTHS.indexOf(match[2]!.toLowerCase()) + 1).padStart(2, '0')}-${match[1]!.padStart(2, '0')}`);
  }
  for (const match of sentence.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) found.push(match[0]);
  return found;
}

const sentences = (paragraphs: string[]): string[] => paragraphs.flatMap((paragraph) => paragraph.split(/(?<=[.;!?])\s+/)).filter((entry) => entry.trim() !== '');

export function answerCheck(ctx: EngineContext, packId: string): AnswerCheck {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const record = ctx.ledger.get({ refType: 'BidResponsePack', refId: packId });
  if (!record || record.tenantId !== ctx.tenantId) throw new DomainError('PACK_NOT_FOUND', `No response pack ${packId}`, 404);
  const pack = record.state as { analysisId?: string; sections?: BidSection[] };
  const analysis = pack.analysisId ? ctx.ledger.get({ refType: 'ITTAnalysis', refId: pack.analysisId }) : undefined;
  const lines = new Map(((analysis?.state.matrix as MatrixLine[] | undefined) ?? []).map((line) => [line.reference, line]));

  const sections = (pack.sections ?? []).map((section): SectionCheck => {
    const line = lines.get(section.key);
    const body = (section.body ?? []).join('\n');
    const count = section.words ?? (body.trim() === '' ? 0 : body.trim().split(/\s+/).length);
    const limit = section.limit?.words ?? line?.responseLimit?.words;
    const subQuestions = (line?.subQuestions ?? []).map((text) => ({ text, addressed: section.status === 'DRAFTED' && addressed(text, body) }));
    const missing = subQuestions.filter((entry) => !entry.addressed);
    const improve: string[] = [];
    if (section.status !== 'DRAFTED') improve.push('Draft the answer.');
    else {
      for (const entry of missing) improve.push(`Answer explicitly: “${entry.text}”.`);
      if (limit !== undefined && count > limit) improve.push(`Cut ${count - limit} words: past ${limit} is usually not read.`);
    }
    return {
      key: section.key,
      title: section.title,
      status: section.status,
      words: count,
      ...(limit !== undefined ? { limit } : {}),
      overLimit: limit !== undefined && count > limit,
      ...(line?.scoringCriteria ? { scoringCriteria: line.scoringCriteria } : {}),
      subQuestions,
      ...(subQuestions.length > 0 ? { coverage: `${subQuestions.length - missing.length} of ${subQuestions.length} sub-questions evidently addressed` } : {}),
      improve,
    };
  });

  // What the rest of the bid says, to check the answers against.
  const programme = ctx.ledger
    .list(ctx.projectId, 'TenderProgrammeDraft')
    .map((entry) => entry.state)
    .filter((state) => state.status === 'CONFIRMED')
    .at(-1) as { startDate?: string; forecast?: { finishDate?: string; completionBy?: string } } | undefined;
  const { particulars } = projectTender(ctx);
  const estimate = ctx.ledger
    .list(ctx.projectId, 'Estimate')
    .map((entry) => entry.state)
    .filter((state) => ((state.omissions as unknown[] | undefined) ?? []).length === 0)
    .at(-1);
  const start = programme?.startDate
    ? { what: 'the confirmed tender programme', value: programme.startDate.slice(0, 10) }
    : particulars?.worksStartOn
      ? { what: 'the works start in the pack', value: particulars.worksStartOn }
      : undefined;
  const completion = programme?.forecast?.finishDate
    ? { what: 'the confirmed tender programme', value: programme.forecast.finishDate.slice(0, 10) }
    : particulars?.worksCompletionOn
      ? { what: 'the works completion in the pack', value: particulars.worksCompletionOn }
      : undefined;
  const weeks =
    programme?.startDate && programme.forecast?.finishDate
      ? {
          what: 'the confirmed tender programme',
          value: String(Math.round((Date.parse(programme.forecast.finishDate) - Date.parse(programme.startDate)) / (7 * 86_400_000))),
        }
      : estimate?.durationWeeks !== undefined
        ? { what: 'the priced estimate', value: String(estimate.durationWeeks) }
        : undefined;

  const commitments: Commitment[] = [];
  for (const section of (pack.sections ?? []).filter((entry) => entry.status === 'DRAFTED')) {
    const socialValue = lines.get(section.key)?.category === 'SOCIAL_VALUE';
    for (const sentence of sentences(section.body ?? [])) {
      const dates = datesIn(sentence);
      const startWord = /\b(start|commenc|mobilis|begin|possession)/i.test(sentence);
      const endWord = /\b(complet|handover|hand over|finish)/i.test(sentence);
      // "Start on 18/01/2027 and complete by 2 April 2027": the first date is the start, the last the completion.
      const startDate = startWord ? dates[0] : undefined;
      const endDate = endWord ? (startWord && dates.length >= 2 ? dates.at(-1) : startWord ? undefined : dates[0]) : undefined;
      if (startDate) {
        commitments.push({ section: section.key, kind: 'START', statement: sentence, value: startDate, ...(start ? { against: start } : {}), agrees: start ? startDate === start.value : null });
      }
      if (endDate) {
        commitments.push({
          section: section.key,
          kind: 'COMPLETION',
          statement: sentence,
          value: endDate,
          ...(completion ? { against: completion } : {}),
          agrees: completion ? endDate === completion.value : null,
        });
      }
      const duration = sentence.match(/\b(\d{1,3})\s*(?:-\s*)?weeks?\b/i);
      if (duration && /\b(programme|duration|on site|construction period|contract period|build)/i.test(sentence)) {
        commitments.push({
          section: section.key,
          kind: 'DURATION',
          statement: sentence,
          value: `${duration[1]} weeks`,
          ...(weeks ? { against: { what: weeks.what, value: `${weeks.value} weeks` } } : {}),
          agrees: weeks ? Number(duration[1]) === Number(weeks.value) : null,
        });
      }
      if (socialValue && /\b\d+(?:\.\d+)?\s*(?:%|per ?cent|apprentice|jobs?|hours|placements?|weeks?)|£\s?\d/i.test(sentence)) {
        commitments.push({ section: section.key, kind: 'SOCIAL_VALUE', statement: sentence, value: sentence.match(/£\s?[\d,]+|\d+(?:\.\d+)?\s*(?:%|per ?cent|\w+)/i)?.[0] ?? '', agrees: null });
      }
    }
  }

  const disagreements = commitments.filter((entry) => entry.agrees === false).length;
  const drafted = sections.filter((section) => section.status === 'DRAFTED').length;
  const gaps = sections.reduce((sum, section) => sum + section.subQuestions.filter((entry) => !entry.addressed).length, 0);
  return {
    packId,
    sections,
    commitments,
    disagreements,
    summary:
      `${drafted} of ${sections.length} answer(s) drafted; ${gaps} sub-question(s) not evidently addressed; ` +
      `${sections.filter((section) => section.overLimit).length} over the limit. ` +
      `${commitments.length} commitment(s) found: ${disagreements} disagree with the rest of the bid` +
      (commitments.some((entry) => entry.kind === 'SOCIAL_VALUE') ? '; social-value commitments listed for confirmation.' : '.'),
  };
}
