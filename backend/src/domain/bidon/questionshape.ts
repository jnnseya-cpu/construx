/**
 * Whether a document has anything question-shaped in it at all.
 *
 * ## What this stops
 *
 * Somebody with nine filed documents looking for the questionnaire, one paid
 * model call at a time: the schedule of amendments (8,301 characters, no
 * questions), then the insurance certificates (972 characters, no questions),
 * then the next one. Each attempt reads the document, calls a vendor, is
 * charged, and comes back empty — and the platform could see for nothing that
 * there was nothing to find.
 *
 * ## What it looks for, and why these three
 *
 * A question set announces itself three ways, and a document needs **none** of
 * them to be refused — so this is a floor, not a judgement about quality:
 *
 *   - **Numbered lines.** `4.1`, `SQ 6.2`, `AW 2.4`, `3)`, `C12.` A buyer
 *     numbers questions because the response has to map onto them, which is the
 *     same reason this module refuses to renumber anything.
 *   - **Question marks.** The obvious one, and not sufficient on its own: a
 *     specification's covering letter has one.
 *   - **The imperatives a questionnaire is actually written in.** "Describe
 *     your…", "Set out…", "Confirm that…", "Provide details of…". Half the
 *     questions in a real PQQ carry no question mark at all.
 *
 * ## It can be overridden, and says so
 *
 * A heuristic that cannot be argued with is the kind of invented rule that
 * stops work. `anyway` sends the document regardless — the refusal names the
 * flag, the console offers it as a checkbox, and anybody who knows their
 * document better than a regular expression does gets their way at the cost of
 * one call. Nothing here is applied to the scan path either: a scanned
 * questionnaire has no text for this to read, so it is sent as it always was.
 */
export function questionShape(text: string): { numbered: number; questionMarks: number; imperatives: number } {
  const NUMBERED = /^[\s>*·-]*(?:[A-Z]{1,4}[\s.]?)?\d{1,3}(?:[.)]\d{1,3}[a-z]?)*[\s).:\t-]/gm;
  const IMPERATIVE =
    /\b(?:describe|set out|confirm|provide|state|explain|outline|detail|demonstrate|how (?:do|does|will|many|much)|what (?:is|are|steps)|please (?:provide|describe|confirm|state))\b/gi;

  return {
    numbered: [...text.matchAll(NUMBERED)].length,
    questionMarks: (text.match(/\?/g) ?? []).length,
    imperatives: [...text.matchAll(IMPERATIVE)].length,
  };
}
