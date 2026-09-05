/**
 * Reading a specification for what it *requires*, not what it says.
 *
 * A specification is the document that decides whether work is acceptable, and
 * it is the one nobody reads until there is an argument. The expensive clauses
 * are not the ones describing the material — those get priced. They are the ones
 * imposing a step before or during the work: a sample to be approved, a test to
 * be passed, a hold point the contractor must not build through. Miss one of
 * those and the work is built, and then it is a non-conformance, a delay, and a
 * dispute about who should have known.
 *
 * So the extraction is scoped to that question. What this produces is a list of
 * clauses that impose a verification step, which can then be checked against the
 * inspection and test plans — because a clause requiring a test with no ITP
 * stage against it is work that will be built and argued about later.
 *
 * **What this is and is not.** It reads supplied text, on the same terms as
 * contract clause extraction: table extraction is not built, and a
 * specification arriving as a file is read into text first — by ingestion where
 * the PDF carries a text layer, by a confirmed model transcription where it is
 * a scan — and the text is what arrives here. What it does do
 * is deterministic — the classification below comes from the words the clause
 * uses, not from a model's opinion — so the same document produces the same
 * clauses twice and anybody can check why a clause was classified as it was.
 * The model characterises the result; it does not decide it.
 */

export type SpecRequirementKind =
  /** A product or material must comply with a standard. Priced, not policed. */
  | 'MATERIAL_STANDARD'
  /** How the work must be done. Judged on the finished article. */
  | 'WORKMANSHIP'
  /** A test must be carried out and passed. */
  | 'TESTING'
  /** Something must be submitted, usually for approval, usually before work. */
  | 'SUBMITTAL'
  /** Work must not proceed until it has been seen. */
  | 'HOLD_POINT'
  /** A sample or benchmark must be approved before the main work. */
  | 'SAMPLE_APPROVAL';

/** The kinds that put a step in front of the work, and so belong in an ITP. */
export const VERIFICATION_KINDS: readonly SpecRequirementKind[] = [
  'TESTING',
  'SUBMITTAL',
  'HOLD_POINT',
  'SAMPLE_APPROVAL',
];

export type ExtractedClause = {
  /** The clause number as written, where the document numbers its clauses. */
  clauseRef: string;
  text: string;
  kind: SpecRequirementKind;
  /**
   * Mandatory where the clause says shall or must; advisory where it says
   * should. The distinction decides whether a departure is a non-conformance or
   * a conversation, and specifications are drafted knowing it.
   */
  mandatory: boolean;
  /** Standards cited in the clause — BS EN 206, ISO 9001 and so on. */
  standards: string[];
  /** True where this clause needs an inspection or test stage against it. */
  requiresVerification: boolean;
  /** The words that produced the classification, so it can be checked. */
  triggers: string[];
};

/**
 * Markers in the order they are tested. Order matters: a clause that says both
 * "submit samples for approval" and "shall not proceed" is a hold point, and
 * classifying it as a submittal would lose the fact that work stops.
 */
const MARKERS: Array<{ kind: SpecRequirementKind; patterns: RegExp[] }> = [
  {
    kind: 'HOLD_POINT',
    patterns: [
      /\bhold point\b/i,
      /shall not (?:proceed|continue|commence|be covered)/i,
      /(?:not|never) (?:be )?covered (?:up )?until/i,
      /before (?:any )?(?:further work|proceeding|concreting|covering)/i,
      /prior (?:written )?approval (?:of|from|by)/i,
    ],
  },
  {
    kind: 'SAMPLE_APPROVAL',
    patterns: [/\b(?:sample|benchmark|mock[- ]?up|trial panel)s?\b/i, /reference panel/i],
  },
  {
    kind: 'TESTING',
    patterns: [
      /\btest(?:ing|ed|s)?\b/i,
      /\bcubes?\b/i,
      /\bcores?\b/i,
      /non[- ]destructive/i,
      /\bNDT\b/,
      /pressure test/i,
      /\bslump\b/i,
      /\bcalibrat(?:e|ed|ion)\b/i,
    ],
  },
  {
    kind: 'SUBMITTAL',
    patterns: [/\bsubmit(?:ted|tal|s)?\b/i, /\bfor (?:the )?approval\b/i, /provide (?:certificates|documentation|records)/i],
  },
  {
    kind: 'WORKMANSHIP',
    patterns: [/\bworkmanship\b/i, /\btolerance/i, /\bfinish(?:ed|es)?\b/i, /shall be (?:laid|placed|installed|fixed|applied)/i],
  },
];

/** A specification section as they are labelled: E10, A12, M60. */
const SECTION_PATTERN = /\b[a-z]\d{2}\b/gi;

const STANDARD_PATTERN = /\b(?:BS\s?EN\s?ISO|BS\s?EN|BS|EN|ISO|ASTM|prEN)\s?\d+(?:[-–]\d+)*(?::\d{4})?/gi;

/** A clause number as specifications write them: 3.4.2, A12/110, E10/220. */
const CLAUSE_PATTERN = /^\s*((?:\d+(?:\.\d+)+)|(?:[A-Z]\d{2}\/\d{2,3})|(?:\d+\.))\s+(.*)$/;

/**
 * Mandatory or advisory.
 *
 * "Shall" and "must" are the obvious half. The other half is the imperative:
 * NBS-style specifications write contractor obligations as instructions —
 * *Submit the mix design*, *Provide certificates* — and reading those as
 * advisory would let the most common form of requirement in British
 * specification writing through as optional.
 *
 * "Should" is the word that makes a clause advisory, and it is used
 * deliberately by the people who draft these. A departure from a should is a
 * conversation; from a shall it is a non-conformance.
 */
function isMandatory(text: string): boolean {
  if (/\b(?:shall|must|is to be|are to be|is required to)\b/i.test(text)) return true;
  return /^(?:submit|provide|supply|ensure|carry out|obtain|give|allow|maintain|record|notify|comply)\b/i.test(text);
}

function classify(text: string): { kind: SpecRequirementKind; triggers: string[] } {
  for (const marker of MARKERS) {
    const hits = marker.patterns.map((p) => text.match(p)?.[0]).filter((m): m is string => m !== undefined);
    if (hits.length > 0) return { kind: marker.kind, triggers: [...new Set(hits.map((h) => h.toLowerCase()))] };
  }
  // Everything left that cites a standard is a material requirement; the rest
  // is workmanship by elimination, which is what a specification mostly is.
  return { kind: STANDARD_PATTERN.test(text) ? 'MATERIAL_STANDARD' : 'WORKMANSHIP', triggers: [] };
}

/**
 * Split a specification into clauses and say what each one requires.
 *
 * Numbered clauses are taken as written. Unnumbered paragraphs still count —
 * plenty of specifications are prose, and a requirement is a requirement
 * whether or not somebody gave it a number — and are referenced by position so
 * they can still be pointed at.
 */
export function extractClauses(specificationText: string, sectionRef: string): ExtractedClause[] {
  const clauses: ExtractedClause[] = [];

  // A clause runs until the next clause number or a blank line. Specifications
  // wrap, and splitting on newlines would make every continuation line its own
  // clause — which does not merely produce noise: a clause reading "shall not be
  // covered until it has been inspected" splits so that half of it says
  // "inspected" and the other half "hold point", and the register gains a
  // requirement the specification never imposed.
  const blocks: Array<{ ref?: string; lines: string[] }> = [];
  let current: { ref?: string; lines: string[] } | undefined;

  for (const raw of specificationText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) {
      current = undefined;
      continue;
    }

    const numbered = line.match(CLAUSE_PATTERN);
    if (numbered) {
      current = { ref: numbered[1]!.replace(/\.$/, ''), lines: [numbered[2]!.trim()] };
      blocks.push(current);
      continue;
    }

    if (current) current.lines.push(line);
    else {
      current = { lines: [line] };
      blocks.push(current);
    }
  }

  let unnumbered = 0;

  for (const block of blocks) {
    const text = block.lines.join(' ').replace(/\s+/g, ' ').trim();
    // Too short to be a requirement — a heading, a page number, a table cell.
    if (text.length < 25) continue;
    // Long enough but not language: a rule of dashes, a row of dots, a border.
    // Length alone let those through as clauses, which put furniture in the
    // register and made the count meaningless.
    if ((text.match(/[A-Za-z]{2,}/g) ?? []).length < 5) continue;

    const clauseRef = block.ref ? `${sectionRef}/${block.ref}` : `${sectionRef}/¶${++unnumbered}`;
    const { kind, triggers } = classify(text);
    const standards = [...new Set((text.match(STANDARD_PATTERN) ?? []).map((s) => s.replace(/\s+/g, ' ').toUpperCase()))];

    clauses.push({
      clauseRef,
      text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
      kind,
      mandatory: isMandatory(text),
      standards,
      requiresVerification: VERIFICATION_KINDS.includes(kind),
      triggers,
    });
  }

  return clauses;
}

export type CoverageGap = {
  clauseRef: string;
  kind: SpecRequirementKind;
  text: string;
  mandatory: boolean;
  consequence: string;
};

export type SpecificationCoverage = {
  specifications: number;
  clauses: number;
  requiringVerification: number;
  covered: number;
  gaps: CoverageGap[];
  /** Verification clauses that are advisory rather than mandatory. */
  advisoryGaps: number;
  coveragePercent: number;
  summary: string;
};

/**
 * Which verification clauses have an inspection stage against them.
 *
 * Matching is on the clause reference appearing in a stage's acceptance
 * criteria, because that is what an acceptance criterion is *for* — the ITP
 * template in this platform already asks for "the specification or drawing
 * clause the inspection is against". Where somebody has filled that in properly
 * the join is exact; where they have written prose, it is not, and the report
 * says a clause is uncovered rather than guessing that it might be.
 */
export function assessCoverage(
  clauses: Array<ExtractedClause & { specificationRef: string }>,
  stageCriteria: string[],
  specificationCount: number,
): SpecificationCoverage {
  const criteria = stageCriteria.map((c) => c.toLowerCase());
  const needsVerification = clauses.filter((c) => c.requiresVerification);

  const covered: typeof needsVerification = [];
  const gaps: CoverageGap[] = [];

  for (const clause of needsVerification) {
    // The reference as written, and the bare number, because a spec clause is
    // quoted both ways and an ITP author will use whichever is to hand.
    const section = clause.clauseRef.split('/')[0]!.toLowerCase();
    const bare = clause.clauseRef.split('/').slice(1).join('/').toLowerCase();
    const full = clause.clauseRef.toLowerCase();

    const isCovered = criteria.some((criterion) => {
      if (criterion.includes(full)) return true;
      if (bare.length < 3 || !criterion.includes(bare)) return false;

      // The bare number alone is not enough where the criterion names a
      // different section. Specifications number 3.4 in every section they
      // have, so matching on the number would report a dozen sections as
      // covered by one plan — a false all-clear, which is worse than a false
      // alarm because nobody looks again.
      const named = criterion.match(SECTION_PATTERN) ?? [];
      return named.every((token) => token.toLowerCase() === section);
    });

    if (isCovered) {
      covered.push(clause);
      continue;
    }

    gaps.push({
      clauseRef: clause.clauseRef,
      kind: clause.kind,
      text: clause.text,
      mandatory: clause.mandatory,
      consequence: consequenceOf(clause.kind, clause.mandatory),
    });
  }

  const coveragePercent =
    needsVerification.length === 0 ? 100 : Number(((covered.length / needsVerification.length) * 100).toFixed(1));

  // Ranked by what happens if nobody notices. A missed hold point means work
  // opened up again; a missed submittal means an email. Sorting by "mandatory"
  // alone put them in the order the clauses happened to be written in.
  const SEVERITY: Record<SpecRequirementKind, number> = {
    HOLD_POINT: 0,
    TESTING: 1,
    SAMPLE_APPROVAL: 2,
    SUBMITTAL: 3,
    WORKMANSHIP: 4,
    MATERIAL_STANDARD: 5,
  };
  gaps.sort((a, b) => Number(b.mandatory) - Number(a.mandatory) || SEVERITY[a.kind] - SEVERITY[b.kind]);

  const mandatoryGaps = gaps.filter((g) => g.mandatory);
  const holdPointGaps = gaps.filter((g) => g.kind === 'HOLD_POINT' && g.mandatory).length;

  const summary =
    specificationCount === 0
      ? 'No specification has been ingested.'
      : needsVerification.length === 0
        ? `${clauses.length} clauses read, none of which impose a test, submittal or hold point.`
        : holdPointGaps > 0
          ? `${holdPointGaps} mandatory hold point${holdPointGaps === 1 ? '' : 's'} with no inspection stage against ${holdPointGaps === 1 ? 'it' : 'them'}. Work built through a hold point is a non-conformance whatever the finished quality.`
          : mandatoryGaps.length > 0
            ? `${mandatoryGaps.length} mandatory verification clause${mandatoryGaps.length === 1 ? '' : 's'} with no inspection stage. Each one is work that gets built and then argued about.`
            : `${coveragePercent}% of verification clauses have an inspection stage against them.`;

  return {
    specifications: specificationCount,
    clauses: clauses.length,
    requiringVerification: needsVerification.length,
    covered: covered.length,
    gaps,
    advisoryGaps: gaps.length - mandatoryGaps.length,
    coveragePercent,
    summary,
  };
}

function consequenceOf(kind: SpecRequirementKind, mandatory: boolean): string {
  if (!mandatory) {
    return 'Advisory rather than mandatory — the clause says should. A departure is a conversation, not a non-conformance.';
  }
  switch (kind) {
    case 'HOLD_POINT':
      return 'Work must not proceed past this until it has been seen. Built through, it is a non-conformance whatever the finished quality, and opening it up again is at the contractor’s cost.';
    case 'TESTING':
      return 'A test is required and no stage will call for it. Untested work is unaccepted work, and the test usually cannot be done retrospectively without opening up.';
    case 'SAMPLE_APPROVAL':
      return 'A sample or benchmark must be approved before the main work. Producing the whole of it first and asking afterwards is how a specification argument starts.';
    case 'SUBMITTAL':
      return 'Something must be submitted, usually before work. A missing submittal is the cheapest of these to fix and the easiest to forget.';
    default:
      return 'No inspection stage refers to this clause.';
  }
}
