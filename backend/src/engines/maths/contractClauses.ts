import type { ContractSuite } from '../claims.ts';

/**
 * Which clause of which contract created an obligation.
 *
 * The obligations calendar knew *what* was due and *when*, and cited the
 * contract as a whole. That is enough to work from and not enough to argue
 * from: a contract administrator challenged on a retention release does not
 * answer "the system said so", they answer "clause 4.20.3". The clause
 * reference is the difference between a reminder and a position.
 *
 * ---
 *
 * **Why this is a table rather than extraction.** The clause extractor reads
 * supplied text and finds numbered clauses; it cannot tell you that the
 * paragraph it found *is* the retention provision, because that is a fact about
 * the standard form and not about the words on the page. A JCT contract with an
 * amended clause 4.20 is still JCT: the amendment changes the terms, not the
 * numbering, and the register has to point at the clause the parties would
 * turn to.
 *
 * **Why BESPOKE is empty rather than guessed.** A bespoke contract has whatever
 * numbering its drafter chose. Returning JCT's numbers for it would be a
 * confident citation of a clause that may not exist or, worse, may exist and
 * say something else. An absent reference is honest; a wrong one is evidence
 * that gets quoted in a letter.
 *
 * **Scope.** These are the standard editions in current UK use — JCT 2016,
 * NEC4, FIDIC 2017 Red Book, IChemE and MF/1. Where an obligation has no clause
 * in a form (NEC has no defects liability period as such; it has a defects date
 * and a defect correction period) the entry is deliberately absent rather than
 * mapped to the nearest thing.
 */

/** Obligation reference or category, to the clause that imposes it. */
type ClauseMap = Partial<Record<string, { clause: string; note?: string }>>;

const CLAUSES: Record<ContractSuite, ClauseMap> = {
  JCT: {
    'DLP-EXPIRY': { clause: '2.38', note: 'Rectification period — schedule of defects within the period' },
    'RET-FIRST': { clause: '4.20.3', note: 'Half of retention released on practical completion' },
    'RET-SECOND': { clause: '4.20.4', note: 'Balance released on the certificate of making good' },
    EXTENSION_OF_TIME: { clause: '2.27', note: 'Notice of delay — forthwith upon it becoming apparent' },
    PAYMENT_NOTICE: { clause: '4.9', note: 'Payment notice not later than five days after the due date' },
    PAY_LESS_NOTICE: { clause: '4.11', note: 'Pay less notice not later than five days before the final date' },
    LIQUIDATED_DAMAGES: { clause: '2.32', note: 'Requires a non-completion notice before deduction' },
    VARIATION: { clause: '3.14', note: 'Architect/contract administrator instructions requiring a variation' },
    LOSS_AND_EXPENSE: { clause: '4.20', note: 'Notification and ascertainment of loss and expense' },
  },
  NEC4: {
    'DLP-EXPIRY': { clause: '11.2(6)', note: 'Defects date, with the defect correction period under 43.2' },
    'RET-FIRST': { clause: 'X16.2', note: 'Retention only where secondary option X16 is used' },
    'RET-SECOND': { clause: 'X16.3', note: 'Balance released after the defects certificate' },
    EXTENSION_OF_TIME: { clause: '61.3', note: 'Eight weeks from awareness — a condition precedent, not a formality' },
    PAYMENT_NOTICE: { clause: '51.1', note: 'Payment within three weeks of the assessment date' },
    PAY_LESS_NOTICE: { clause: 'Y2.3', note: 'Only where option Y(UK)2 applies the Construction Act' },
    LIQUIDATED_DAMAGES: { clause: 'X7.1', note: 'Delay damages only where secondary option X7 is used' },
    VARIATION: { clause: '60.1(1)', note: 'A compensation event, assessed prospectively' },
    LOSS_AND_EXPENSE: { clause: '63.1', note: 'Assessed as a change to Defined Cost, not as a separate claim' },
  },
  FIDIC: {
    'DLP-EXPIRY': { clause: '11.1', note: 'Defects notification period, completed by the 11.9 performance certificate' },
    'RET-FIRST': { clause: '14.9', note: 'Half on the taking-over certificate' },
    'RET-SECOND': { clause: '14.9', note: 'Balance on expiry of the defects notification period' },
    EXTENSION_OF_TIME: { clause: '20.2.1', note: 'Twenty-eight days from awareness — time-barred if missed' },
    PAYMENT_NOTICE: { clause: '14.6', note: 'Interim payment certificate by the engineer' },
    PAY_LESS_NOTICE: { clause: '14.6.2', note: 'Withholding must be itemised in the certificate' },
    LIQUIDATED_DAMAGES: { clause: '8.8', note: 'Delay damages, subject to the 8.8 cap' },
    VARIATION: { clause: '13.3', note: 'Variation by instruction or by request for proposal' },
    LOSS_AND_EXPENSE: { clause: '20.2', note: 'Claims for payment follow the same notice regime as time' },
  },
  ICHEME: {
    'DLP-EXPIRY': { clause: '37', note: 'Defects liability period from the take-over certificate' },
    EXTENSION_OF_TIME: { clause: '14', note: 'Notice of circumstances delaying completion' },
    LIQUIDATED_DAMAGES: { clause: '15', note: 'Liquidated damages for delay' },
    VARIATION: { clause: '16', note: 'Variations ordered by the project manager' },
  },
  MF1: {
    'DLP-EXPIRY': { clause: '36', note: 'Defects liability period' },
    EXTENSION_OF_TIME: { clause: '33', note: 'Notice of delay to the engineer' },
    LIQUIDATED_DAMAGES: { clause: '34', note: 'Damages for delay, capped by the special conditions' },
    VARIATION: { clause: '27', note: 'Variations to the works' },
  },
  // Deliberately empty. See the note above: a wrong citation is worse than none.
  BESPOKE: {},
};

export type ClauseCitation = {
  suite: ContractSuite;
  clause: string;
  note?: string;
};

/**
 * The clause that imposes an obligation under a given form, or undefined.
 *
 * Tried against the obligation's own reference first (`RET-FIRST`), then its
 * category (`RETENTION`), because the calendar carries both and the reference
 * is the more specific of the two — retention has two releases under different
 * clauses and a category-only lookup would cite the same one for both.
 */
export function clauseFor(
  suite: ContractSuite,
  reference: string,
  category?: string,
): ClauseCitation | undefined {
  const map = CLAUSES[suite];
  const hit = map[reference] ?? (category ? map[category] : undefined);
  return hit ? { suite, clause: hit.clause, note: hit.note } : undefined;
}

/** Every obligation this form has a clause for. Published so a console can show coverage. */
export function clauseRegister(suite: ContractSuite): Array<{ obligation: string } & ClauseCitation> {
  return Object.entries(CLAUSES[suite]).map(([obligation, entry]) => ({
    obligation,
    suite,
    clause: entry!.clause,
    ...(entry!.note === undefined ? {} : { note: entry!.note }),
  }));
}
