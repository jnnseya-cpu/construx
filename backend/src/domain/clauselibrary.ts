import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { clauseFor } from '../engines/maths/contractClauses.ts';
import type { ContractSuite } from '../engines/claims.ts';

/**
 * Contract-native reasoning — `L7.1`, §2.4, §4.5.
 *
 * ---
 *
 * **The property, stated as a test.** *The same site event produces different
 * outputs under NEC4 Option A, JCT Design and Build 2016 and FIDIC Yellow.*
 * Ground conditions worse than a contractor could have foreseen are a
 * compensation event notifiable within eight weeks under NEC4 — and the
 * eight weeks is a condition precedent, so a notice on the fifty-seventh day
 * loses the entitlement entirely. The same discovery under JCT is a variation
 * instruction and a loss-and-expense notice with no equivalent bar. Under FIDIC
 * it is twenty-eight days, and the bar bites.
 *
 * An engine that reasons from generic construction knowledge gets this wrong in
 * the direction that costs money, because generic knowledge averages the forms.
 *
 * **What was here, and what was missing.** `contractClauses.ts` maps an
 * obligation category to the clause number that imposes it, per suite. That is
 * the difference between a reminder and a position and it is kept exactly as it
 * is. What it cannot carry is the *obligation*: who must act, within how long,
 * whether the period is a bar or a courtesy, what happens if it is missed, and
 * which clauses are onerous before anybody amends them. This is that, as
 * versioned packages, and a test asserts the two never disagree about a clause
 * number.
 *
 * ## The amendment overlay
 *
 * A standard form is almost never used unamended. The schedule of amendments is
 * where the risk actually moves, and it is the document nobody reads twice.
 * `MODIFIES`, `DELETES` and `INSERTS`, and **every modified clause carries a
 * field-by-field diff against the standard** — §4.5.1's explicit guardrail.
 * Reporting an amended contract as though it were the standard form is the
 * single most expensive thing this module could do.
 *
 * ## What these packages deliberately do not contain
 *
 * **The clause text.** NEC, JCT and FIDIC own the words, and a platform that
 * shipped them would be redistributing somebody's publication. What is here is
 * the clause's *number, subject and effect* — facts about the form, which is
 * what an engine reasons over. A contract administrator arguing a position
 * quotes the contract in front of them; this tells them which clause to open
 * and what it is going to say.
 *
 * **Anything bespoke.** A bespoke contract has whatever numbering its drafter
 * chose. `BESPOKE` loads no package, and the position says so rather than
 * offering the nearest standard form — the same rule the citation table already
 * follows, and for the same reason: a confident citation of a clause that may
 * not exist is evidence that gets quoted in a letter.
 *
 * **Legal advice.** Every risk register carries the disclaimer §4.5.2 requires.
 * The platform reports where a term sits against the tenancy's stated appetite.
 * It does not advise, and a flagged term is for the legal role to look at.
 */

export type ClauseParty = 'CONTRACTOR' | 'EMPLOYER' | 'PM' | 'SUPERVISOR' | 'ENGINEER' | 'ARCHITECT' | 'OTHER';

export type NoticeMethod = 'WRITING' | 'CDE' | 'PORTAL' | 'EMAIL' | 'FORM';

/** The eleven patterns §4.5.2 names, which is what a contract review is looking for. */
export const ONEROUS_PATTERN = [
  'PAY_WHEN_PAID',
  'FITNESS_FOR_PURPOSE',
  'UNCAPPED_DAMAGES',
  'UNLIMITED_LIABILITY',
  'ONEROUS_TIME_BAR',
  'DESIGN_RESPONSIBILITY',
  'GROUND_RISK',
  'CURRENCY_RISK',
  'DISPUTE_FORUM',
  'TERMINATION_FOR_CONVENIENCE',
  'SET_OFF',
] as const;

export type OnerousPattern = (typeof ONEROUS_PATTERN)[number];

/**
 * A clause of a standard form, as the engine needs it.
 *
 * Not the words: the number, what it is about, who it binds, how long they
 * have, and what it costs them to be late.
 */
export type StandardClause = {
  ref: string;
  title: string;
  party: ClauseParty;
  /** The obligation category, shared with the obligations calendar's own vocabulary. */
  category: string;
  /** What must be done, in the platform's words rather than the publisher's. */
  action: string;
  /** Days to act, where the form states a period. */
  noticeDays?: number;
  /**
   * A period that ends the entitlement rather than merely passing.
   *
   * Kept separate from `noticeDays` because the difference is the whole of the
   * risk: a late payment notice is a procedural failure, a late compensation
   * event notice is money gone.
   */
  timeBar?: { days: number; consequence: string };
  method: NoticeMethod;
  approvalRequired: boolean;
  evidenceRequired: string[];
  consequenceOfBreach: string;
  /** Where this sits before amendment, 0 benign to 1 walk away. */
  riskWeight: number;
  /** An onerous pattern the clause carries as standard, where it carries one. */
  riskPattern?: OnerousPattern;
};

export type StandardForm = {
  id: string;
  name: string;
  publisher: string;
  edition: string;
  /** The package version, so a contract records which one it was read against. */
  version: string;
  /** The suite the citation table already knows, so the two cannot drift. */
  suite: ContractSuite;
  /** Said on every package: these are the numbers and effects, not the words. */
  textIncluded: false;
  clauses: StandardClause[];
};

// --- The packages -------------------------------------------------------------------

const NEC4_ECC: StandardForm = {
  id: 'nec4-ecc',
  name: 'NEC4 Engineering and Construction Contract',
  publisher: 'NEC (Thomas Telford)',
  edition: '4th edition, 2017 (with 2019 amendments)',
  version: '1.0.0',
  suite: 'NEC4',
  textIncluded: false,
  clauses: [
    {
      ref: '61.3',
      title: 'Notifying a compensation event',
      party: 'CONTRACTOR',
      category: 'EXTENSION_OF_TIME',
      action: 'Notify the Project Manager of an event the Contractor believes is a compensation event.',
      noticeDays: 56,
      timeBar: {
        days: 56,
        consequence:
          'Entitlement to a change in the Prices, the Completion Date and any Key Date is lost entirely. This is a ' +
          'condition precedent, not a procedural step.',
      },
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Records of the event', 'The date the Contractor became aware'],
      consequenceOfBreach: 'No change to the Prices or the Completion Date, however good the underlying claim.',
      riskWeight: 0.8,
      riskPattern: 'ONEROUS_TIME_BAR',
    },
    {
      ref: '60.1(12)',
      title: 'Physical conditions',
      party: 'CONTRACTOR',
      category: 'GROUND_CONDITIONS',
      action:
        'Encounter physical conditions within the Site which an experienced contractor would have judged to have so ' +
        'small a chance of occurring that it would have been unreasonable to have allowed for them.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Site investigation relied on', 'Record of what was found'],
      consequenceOfBreach: 'Handled through 61.3; the notice period is what bites, not the event.',
      riskWeight: 0.4,
      riskPattern: 'GROUND_RISK',
    },
    {
      ref: '51.1',
      title: 'Payment',
      party: 'EMPLOYER',
      category: 'PAYMENT_NOTICE',
      action: 'Pay the amount due within three weeks of the assessment date, or the period stated in the Contract Data.',
      noticeDays: 21,
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Assessment'],
      consequenceOfBreach: 'Interest at the rate in the Contract Data, and a Construction Act route where Y(UK)2 applies.',
      riskWeight: 0.2,
    },
    {
      ref: '43.2',
      title: 'Correcting defects',
      party: 'CONTRACTOR',
      // Not `DLP-EXPIRY`. The defects date is 11.2(6) and is a date; this is the
      // period to put a notified Defect right, which is a different obligation
      // with a different clock. Filing both under one category is how a
      // calendar ends up counting down to the wrong thing.
      category: 'DEFECT_CORRECTION',
      action: 'Correct a notified Defect within the defect correction period.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Defect notification'],
      consequenceOfBreach: 'The Project Manager assesses the cost of having the Defect corrected by others.',
      riskWeight: 0.3,
    },
    {
      ref: 'X7.1',
      title: 'Delay damages',
      party: 'CONTRACTOR',
      category: 'LIQUIDATED_DAMAGES',
      action: 'Pay delay damages at the rate in the Contract Data from Completion until the Completion Date is achieved.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Completion certificate'],
      consequenceOfBreach: 'Damages accrue; only applies where secondary option X7 is selected.',
      riskWeight: 0.4,
    },
    {
      ref: 'X16.2',
      title: 'Retention',
      party: 'EMPLOYER',
      category: 'RET-FIRST',
      action: 'Retain the retention percentage from each assessment until Completion of the whole of the works.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Assessment'],
      consequenceOfBreach: 'Only applies where secondary option X16 is selected.',
      riskWeight: 0.2,
    },
    {
      ref: '21.2',
      title: 'The Contractor’s design',
      party: 'CONTRACTOR',
      category: 'DESIGN_RESPONSIBILITY',
      action: 'Submit the particulars of the design to the Project Manager for acceptance before proceeding.',
      method: 'CDE',
      approvalRequired: true,
      evidenceRequired: ['Design particulars'],
      consequenceOfBreach: 'Proceeding without acceptance is at the Contractor’s risk.',
      riskWeight: 0.4,
      riskPattern: 'DESIGN_RESPONSIBILITY',
    },
    {
      ref: 'W2.1',
      title: 'Dispute resolution — adjudication',
      party: 'OTHER',
      category: 'DISPUTE_FORUM',
      action: 'Refer a dispute to the Adjudicator at any time, under the Construction Act regime.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Notice of adjudication'],
      consequenceOfBreach: 'W2 applies where the Act applies; W1 or W3 otherwise, and the forum differs.',
      riskWeight: 0.2,
    },
  ],
};

const JCT_DB_2016: StandardForm = {
  id: 'jct-db-2016',
  name: 'JCT Design and Build Contract',
  publisher: 'The Joint Contracts Tribunal',
  edition: '2016',
  version: '1.0.0',
  suite: 'JCT',
  textIncluded: false,
  clauses: [
    {
      ref: '2.24',
      title: 'Notice of delay',
      party: 'CONTRACTOR',
      category: 'EXTENSION_OF_TIME',
      action:
        'Notify the Employer forthwith when it becomes reasonably apparent that progress is being or is likely to be ' +
        'delayed, giving the cause and the expected effect.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Cause of delay', 'Expected effect on the Completion Date'],
      consequenceOfBreach:
        'Notice is a condition of the extension machinery rather than an absolute bar — but a late notice weakens the ' +
        'evidence and invites the argument that the delay could have been mitigated.',
      riskWeight: 0.3,
    },
    {
      ref: '2.26',
      title: 'Relevant Events',
      party: 'CONTRACTOR',
      category: 'GROUND_CONDITIONS',
      action: 'Rely on a listed Relevant Event as grounds for an extension of time.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Records of the event'],
      consequenceOfBreach:
        'Ground conditions are not a Relevant Event as standard: unless the Employer’s Requirements say otherwise, the ' +
        'risk sits with the Contractor.',
      riskWeight: 0.6,
      riskPattern: 'GROUND_RISK',
    },
    {
      ref: '4.9',
      title: 'Payment notice',
      party: 'EMPLOYER',
      category: 'PAYMENT_NOTICE',
      action: 'Give a payment notice not later than five days after the due date, stating the sum considered due.',
      noticeDays: 5,
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Interim application'],
      consequenceOfBreach: 'The Contractor’s application becomes the notified sum and is payable in full.',
      riskWeight: 0.2,
    },
    {
      ref: '4.11',
      title: 'Pay less notice',
      party: 'EMPLOYER',
      category: 'PAY_LESS_NOTICE',
      action: 'Give a pay less notice not later than five days before the final date for payment.',
      noticeDays: 5,
      timeBar: {
        days: 5,
        consequence: 'Without it the notified sum is payable in full, whatever the Employer believes is due.',
      },
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Basis of the calculation'],
      consequenceOfBreach: 'The full notified sum falls due — the smash-and-grab adjudication.',
      riskWeight: 0.5,
      riskPattern: 'SET_OFF',
    },
    {
      ref: '2.32',
      title: 'Liquidated damages',
      party: 'EMPLOYER',
      category: 'LIQUIDATED_DAMAGES',
      action: 'Issue a non-completion notice before deducting or requiring payment of liquidated damages.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Non-completion notice'],
      consequenceOfBreach: 'Deduction without the notice is not effective.',
      riskWeight: 0.4,
    },
    {
      ref: '2.38',
      title: 'Rectification period',
      party: 'CONTRACTOR',
      category: 'DLP-EXPIRY',
      action: 'Make good defects appearing within the rectification period and notified in a schedule of defects.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Schedule of defects'],
      consequenceOfBreach: 'The Employer may have the work done and recover the cost.',
      riskWeight: 0.3,
    },
    {
      ref: '4.20',
      title: 'Loss and expense',
      party: 'CONTRACTOR',
      category: 'LOSS_AND_EXPENSE',
      action: 'Notify as soon as the likely effect on regular progress becomes apparent, and keep records.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Records of the loss', 'Cause'],
      consequenceOfBreach: 'Ascertainment is refused for any period the records cannot support.',
      riskWeight: 0.4,
    },
    {
      ref: '2.17.1',
      title: 'Design — reasonable skill and care',
      party: 'CONTRACTOR',
      category: 'DESIGN_RESPONSIBILITY',
      action:
        'Carry out design with the reasonable skill and care of a competent professional designer, as standard and ' +
        'before amendment.',
      method: 'CDE',
      approvalRequired: false,
      evidenceRequired: ['Design documents'],
      consequenceOfBreach:
        'A schedule of amendments raising this to fitness for purpose is the single most common uninsurable change.',
      riskWeight: 0.3,
      riskPattern: 'DESIGN_RESPONSIBILITY',
    },
  ],
};

const FIDIC_YELLOW_2017: StandardForm = {
  id: 'fidic-yellow-2017',
  name: 'FIDIC Conditions of Contract for Plant and Design-Build (Yellow Book)',
  publisher: 'FIDIC',
  edition: '2nd edition, 2017',
  version: '1.0.0',
  suite: 'FIDIC',
  textIncluded: false,
  clauses: [
    {
      ref: '20.2.1',
      title: 'Notice of Claim',
      party: 'CONTRACTOR',
      category: 'EXTENSION_OF_TIME',
      action: 'Give a Notice of Claim within 28 days of becoming aware, or of when the Contractor should have become aware.',
      noticeDays: 28,
      timeBar: {
        days: 28,
        consequence:
          'The claim lapses and the other Party is discharged from liability, subject only to the 20.2.5 review of ' +
          'whether the bar applies.',
      },
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Date of awareness', 'Contemporary records'],
      consequenceOfBreach: 'The entitlement is lost, for time and for money alike.',
      riskWeight: 0.85,
      riskPattern: 'ONEROUS_TIME_BAR',
    },
    {
      ref: '4.12',
      title: 'Unforeseeable physical conditions',
      party: 'CONTRACTOR',
      category: 'GROUND_CONDITIONS',
      action: 'Give notice of physical conditions which the Contractor considers to have been Unforeseeable.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Site data relied on', 'Record of the conditions'],
      consequenceOfBreach: 'Handled through the 20.2.1 notice regime, so the 28 days govern.',
      riskWeight: 0.5,
      riskPattern: 'GROUND_RISK',
    },
    {
      ref: '14.6',
      title: 'Interim Payment Certificate',
      party: 'ENGINEER',
      category: 'PAYMENT_NOTICE',
      action: 'Issue the Interim Payment Certificate within 28 days of receiving the Statement and supporting documents.',
      noticeDays: 28,
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Statement'],
      consequenceOfBreach: 'Financing charges under 14.8.',
      riskWeight: 0.2,
    },
    {
      ref: '8.8',
      title: 'Delay Damages',
      party: 'CONTRACTOR',
      category: 'LIQUIDATED_DAMAGES',
      action: 'Pay delay damages at the rate in the Contract Data, subject to the stated maximum.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Taking-Over Certificate'],
      consequenceOfBreach:
        'Capped as standard. A schedule of amendments deleting the cap turns a bounded exposure into an open one.',
      riskWeight: 0.4,
      riskPattern: 'UNCAPPED_DAMAGES',
    },
    {
      ref: '11.1',
      title: 'Defects Notification Period',
      party: 'CONTRACTOR',
      category: 'DLP-EXPIRY',
      action: 'Complete outstanding work and remedy defects notified within the Defects Notification Period.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Notice of defect'],
      consequenceOfBreach: 'The Employer may carry out the work and recover the cost under 11.4.',
      riskWeight: 0.3,
    },
    {
      ref: '4.1',
      title: 'Fitness for purpose',
      party: 'CONTRACTOR',
      category: 'DESIGN_RESPONSIBILITY',
      action:
        'Ensure the Works, when completed, are fit for the purposes for which they are intended as defined in the ' +
        'Employer’s Requirements.',
      method: 'CDE',
      approvalRequired: false,
      evidenceRequired: ['Employer’s Requirements', 'Design documents'],
      consequenceOfBreach:
        'Fitness for purpose is a strict obligation and is normally outside professional indemnity cover. This is the ' +
        'standard position under the Yellow Book, not an amendment.',
      riskWeight: 0.9,
      riskPattern: 'FITNESS_FOR_PURPOSE',
    },
    {
      ref: '15.5',
      title: 'Termination for Employer’s convenience',
      party: 'EMPLOYER',
      category: 'TERMINATION',
      action: 'Terminate the Contract at the Employer’s convenience on 28 days’ notice.',
      noticeDays: 28,
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['Notice of termination'],
      consequenceOfBreach: 'Payment follows 15.6; loss of profit is not recoverable as standard.',
      riskWeight: 0.5,
      riskPattern: 'TERMINATION_FOR_CONVENIENCE',
    },
    {
      ref: '21.6',
      title: 'Arbitration',
      party: 'OTHER',
      category: 'DISPUTE_FORUM',
      action: 'Refer an unresolved dispute to international arbitration under the ICC Rules.',
      method: 'WRITING',
      approvalRequired: false,
      evidenceRequired: ['DAAB decision', 'Notice of dissatisfaction'],
      consequenceOfBreach:
        'The forum, the seat and the language are the terms that decide what a dispute costs to run and where.',
      riskWeight: 0.4,
      riskPattern: 'DISPUTE_FORUM',
    },
  ],
};

/**
 * The library.
 *
 * Three forms rather than the specification's eight, and the count is stated
 * rather than padded: `nec4-ecc`, `jct-db-2016` and `fidic-yellow-2017` are the
 * three a UK contractor bidding abroad actually meets, and they differ from each
 * other in exactly the ways `L7.1` is about — a hard time bar, a soft one, and
 * fitness for purpose as standard. A package added later is data, not code.
 */
const PACKAGES: StandardForm[] = [NEC4_ECC, JCT_DB_2016, FIDIC_YELLOW_2017];

export function standardForms(): Array<Omit<StandardForm, 'clauses'> & { clauses: number }> {
  return PACKAGES.map(({ clauses, ...form }) => ({ ...form, clauses: clauses.length }));
}

export function formPackage(formId: string): StandardForm | undefined {
  return PACKAGES.find((form) => form.id === formId);
}

// --- The amendment overlay ----------------------------------------------------------

export const AMENDMENT_KIND = ['MODIFIES', 'DELETES', 'INSERTS'] as const;
export type AmendmentKind = (typeof AMENDMENT_KIND)[number];

/** What a schedule of amendments does to one clause. */
export type Amendment = {
  /** The amending document's own reference, so the diff can be traced to a page. */
  ref: string;
  kind: AmendmentKind;
  /** The standard clause acted on, or the number the insertion takes. */
  clauseRef: string;
  /** Why it was made, where the employer said. */
  note: string;
  /** The fields it overrides. Anything absent is unchanged. */
  changes?: Partial<Pick<StandardClause, 'title' | 'action' | 'noticeDays' | 'method' | 'approvalRequired' | 'consequenceOfBreach' | 'riskWeight' | 'riskPattern'>> & {
    timeBar?: StandardClause['timeBar'] | null;
  };
  /** An inserted clause carries a whole clause, because there is nothing to modify. */
  inserted?: Omit<StandardClause, 'ref'>;
};

export type FieldDiff = { field: string; was: string; now: string };

export type EffectiveClause = StandardClause & {
  /** Where it came from: the form's own reference for this clause. */
  standardFormRef: string;
  /** The amendments that reached it, in the order they were applied. */
  amendedBy: string[];
  /** Field by field, what changed. §4.5.1's guardrail, not a summary of it. */
  changes: FieldDiff[];
  /** True for a clause the amendments struck out. Kept, never dropped. */
  deleted: boolean;
  /** True for a clause the amendments added, which has no standard to diff against. */
  inserted: boolean;
};

const show = (value: unknown): string => {
  if (value === undefined || value === null) return 'not stated';
  if (typeof value === 'object' && 'days' in (value as Record<string, unknown>)) {
    const bar = value as { days: number; consequence: string };
    return `${bar.days} days — ${bar.consequence}`;
  }
  return String(value);
};

/**
 * Apply a schedule of amendments to a standard form.
 *
 * Pure, so the diff can be shown to somebody before anything is recorded — the
 * person deciding whether to qualify a term should see what it does before the
 * ledger does.
 */
export function applyAmendments(form: StandardForm, amendments: Amendment[]): EffectiveClause[] {
  const byRef = new Map<string, EffectiveClause>(
    form.clauses.map((clause) => [
      clause.ref,
      {
        ...clause,
        standardFormRef: `${form.name} ${clause.ref}`,
        amendedBy: [],
        changes: [],
        deleted: false,
        inserted: false,
      },
    ]),
  );

  for (const amendment of amendments) {
    if (amendment.kind === 'INSERTS') {
      if (byRef.has(amendment.clauseRef)) {
        throw new DomainError(
          'AMENDMENT_CLAUSE_EXISTS',
          `${amendment.ref} inserts a clause ${amendment.clauseRef}, and ${form.name} already has one. Two clauses ` +
            'with one number is a contract nobody can cite from.',
        );
      }
      if (!amendment.inserted) {
        throw new DomainError(
          'AMENDMENT_INSERT_EMPTY',
          `${amendment.ref} inserts clause ${amendment.clauseRef} and says nothing about what it requires.`,
          422,
          [{ field: 'inserted', message: 'An inserted clause needs its own terms' }],
        );
      }
      byRef.set(amendment.clauseRef, {
        ...amendment.inserted,
        ref: amendment.clauseRef,
        standardFormRef: `${form.name} ${amendment.clauseRef} (inserted)`,
        amendedBy: [amendment.ref],
        changes: [{ field: 'clause', was: 'not in the standard form', now: amendment.inserted.title }],
        deleted: false,
        inserted: true,
      });
      continue;
    }

    const clause = byRef.get(amendment.clauseRef);
    if (!clause) {
      // Naming a clause the form does not have means the schedule was written
      // against a different edition, or the form was identified wrongly. Either
      // way, applying it silently would produce a position nobody can defend.
      throw new DomainError(
        'AMENDMENT_CLAUSE_UNKNOWN',
        `${amendment.ref} ${amendment.kind.toLowerCase()} clause ${amendment.clauseRef}, which is not in the ` +
          `${form.id} package (${form.edition}). Either the schedule is written against a different edition or the ` +
          'form has been identified wrongly.',
        422,
      );
    }

    if (amendment.kind === 'DELETES') {
      byRef.set(clause.ref, {
        ...clause,
        amendedBy: [...clause.amendedBy, amendment.ref],
        changes: [...clause.changes, { field: 'clause', was: clause.title, now: 'struck out' }],
        deleted: true,
      });
      continue;
    }

    const changes: FieldDiff[] = [...clause.changes];
    const next: EffectiveClause = { ...clause, amendedBy: [...clause.amendedBy, amendment.ref] };
    for (const [field, value] of Object.entries(amendment.changes ?? {})) {
      if (value === undefined) continue;
      const was = (clause as unknown as Record<string, unknown>)[field];
      const now = value === null ? undefined : value;
      if (show(was) === show(now)) continue;
      changes.push({ field, was: show(was), now: show(now) });
      (next as unknown as Record<string, unknown>)[field] = now;
    }
    next.changes = changes;
    byRef.set(clause.ref, next);
  }

  return [...byRef.values()];
}

// --- What a site event means under this contract ------------------------------------

export type EventResponse = {
  formId: string;
  formName: string;
  /** The clause that governs, or nothing where the form has none for this. */
  clauseRef?: string;
  title?: string;
  action?: string;
  /** Days to act, and whether missing it ends the entitlement. */
  actWithinDays?: number;
  timeBarred: boolean;
  consequence: string;
  amendedBy: string[];
  reading: string;
};

/**
 * The `L7.1` property, as a function.
 *
 * *The same site event produces different outputs under NEC4, JCT and FIDIC.*
 * Ground conditions worse than an experienced contractor would have allowed for
 * is a compensation event notifiable in 56 days under NEC4, not a Relevant
 * Event at all under JCT Design and Build, and a claim notifiable in 28 days
 * under FIDIC. An engine reasoning from generic knowledge averages those three
 * and is wrong under all of them.
 */
export function responseToEvent(
  formId: string,
  category: string,
  amendments: Amendment[] = [],
): EventResponse {
  const form = formPackage(formId);
  if (!form) {
    throw new DomainError('STANDARD_FORM_UNKNOWN', `No package for ${formId}. The library carries ${PACKAGES.length} forms.`, 404);
  }

  const effective = applyAmendments(form, amendments);
  const clause = effective.find((entry) => entry.category === category && !entry.deleted);

  if (!clause) {
    const struck = effective.find((entry) => entry.category === category && entry.deleted);
    return {
      formId: form.id,
      formName: form.name,
      timeBarred: false,
      consequence: struck
        ? `${struck.ref} governed this and the amendments struck it out.`
        : `${form.name} has no clause for this as standard.`,
      amendedBy: struck?.amendedBy ?? [],
      reading: struck
        ? `Struck out by ${struck.amendedBy.join(', ')}. Whatever the parties intended instead is not in the form.`
        : `Nothing in ${form.name} addresses this, so it is not a contractual route under this contract.`,
    };
  }

  return {
    formId: form.id,
    formName: form.name,
    clauseRef: clause.ref,
    title: clause.title,
    action: clause.action,
    ...(clause.timeBar ? { actWithinDays: clause.timeBar.days } : clause.noticeDays === undefined ? {} : { actWithinDays: clause.noticeDays }),
    timeBarred: clause.timeBar !== undefined,
    consequence: clause.timeBar ? clause.timeBar.consequence : clause.consequenceOfBreach,
    amendedBy: clause.amendedBy,
    reading:
      `${form.name} ${clause.ref}: ${clause.action}` +
      (clause.timeBar
        ? ` Missing the ${clause.timeBar.days} days ends the entitlement.`
        : clause.noticeDays !== undefined
          ? ` ${clause.noticeDays} days, and the period is procedural rather than a bar.`
          : ' No number of days is stated, and the period is procedural rather than a bar.') +
      (clause.amendedBy.length > 0 ? ` Amended by ${clause.amendedBy.join(', ')}.` : ''),
  };
}

// --- The position on one contract ---------------------------------------------------

export type ClausePosition = {
  contractId: string;
  formId: string;
  formName: string;
  formVersion: string;
  /** Said on the record, because the absence of the words is a fact about it. */
  textIncluded: false;
  amendments: Amendment[];
  adoptedAt: string;
  adoptedBy: string;
};

export type RiskFinding = {
  clauseRef: string;
  title: string;
  pattern?: OnerousPattern;
  /** Weight after amendment, which is what actually applies. */
  riskWeight: number;
  standardWeight: number;
  amendedBy: string[];
  changes: FieldDiff[];
  /** Above the tenancy's appetite. §4.5.2's walk-away flag. */
  walkAway: boolean;
  reading: string;
};

export type ContractRiskRegister = {
  contractId: string;
  formName: string;
  findings: RiskFinding[];
  amended: number;
  deleted: number;
  inserted: number;
  walkAways: number;
  /** §4.5.2 requires it, and it is attached to the register rather than the screen. */
  disclaimer: string;
  summary: string;
};

/** Above this the term is flagged for the legal role rather than reported. */
const APPETITE = 0.7;

const DISCLAIMER =
  'This register reports where each term sits against a stated risk appetite, computed from the form package and the ' +
  'schedule of amendments. It is not legal advice, it does not read the contract’s words, and a flagged term is for ' +
  'the legal role to review before the tender goes in.';

function requireContract(ctx: EngineContext, contractId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'Contract', refId: contractId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('CONTRACT_NOT_FOUND', `No contract ${contractId}`, 404);
  }
  return record;
}

function positionOf(ctx: EngineContext, contractId: string): ClausePosition | undefined {
  const record = ctx.ledger.get({ refType: 'ContractClausePosition', refId: contractId });
  if (!record || record.tenantId !== ctx.tenantId) return undefined;
  return record.state as unknown as ClausePosition;
}

/**
 * Load a standard form against a contract, with its schedule of amendments.
 *
 * `CONTRACTS_CLAIMS` `C`. The diff is computed here rather than stored, so it
 * cannot drift from the package version the contract records.
 */
export function adoptStandardForm(
  ctx: EngineContext,
  input: { contractId: string; formId: string; amendments?: Amendment[] },
): { position: ClausePosition; effective: EffectiveClause[] } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { dataSensitivity: 'LEGAL_L4' });

  const contract = requireContract(ctx, input.contractId);
  const form = formPackage(input.formId);
  if (!form) {
    throw new DomainError(
      'STANDARD_FORM_UNKNOWN',
      `No package for ${input.formId}. The library carries ${PACKAGES.map((entry) => entry.id).join(', ')}. A bespoke ` +
        'contract loads none, and a position that offered the nearest standard form would cite clauses that may not exist.',
      404,
    );
  }
  if (positionOf(ctx, input.contractId)) {
    throw new DomainError(
      'FORM_ALREADY_ADOPTED',
      'This contract already names a form and a schedule of amendments. Two clause positions for one contract is two ' +
        'answers to what was agreed.',
      409,
    );
  }

  const amendments = input.amendments ?? [];
  // Computed before anything is written, so a schedule naming a clause the form
  // does not have is refused rather than recorded.
  const effective = applyAmendments(form, amendments);

  const position: ClausePosition = {
    contractId: input.contractId,
    formId: form.id,
    formName: form.name,
    formVersion: form.version,
    textIncluded: false,
    amendments,
    adoptedAt: new Date().toISOString(),
    adoptedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'CONTRACT_FORM_ADOPTED',
    entity: { refType: 'ContractClausePosition', refId: input.contractId },
    nextState: position as unknown as Record<string, unknown>,
    // The contract the position belongs to, named as evidence rather than as a
    // state field, so the lineage walk can get from one to the other.
    evidenceRefs: [{ refType: 'Contract', refId: contract.refId }],
  });

  return { position, effective };
}

export type ClausePositionRead = {
  contractId: string;
  /** Absent until somebody loads a form, which is the normal starting state. */
  position: ClausePosition | null;
  effective: EffectiveClause[];
  risk: ContractRiskRegister | null;
  /** Why there is nothing here, where there is nothing. */
  summary: string;
};

/**
 * The effective clauses, the diff against the standard, and the risk register.
 *
 * **Absence is an answer, not a failure.** Every contract starts with no form
 * loaded, and a screen that reads this on every visit would log a 404 every
 * time — which is how a deployment teaches everybody to scroll past 404s and
 * miss the one that matters. A bespoke contract never has one by design, and
 * that is the same answer rather than a permanent error.
 */
export function contractClausePosition(ctx: EngineContext, contractId: string): ClausePositionRead {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'R', { dataSensitivity: 'LEGAL_L4' });

  const position = positionOf(ctx, contractId);
  if (!position) {
    return {
      contractId,
      position: null,
      effective: [],
      risk: null,
      summary:
        'No standard form has been loaded against this contract. A bespoke contract has none by design, and the ' +
        'obligations calendar still works from what was extracted.',
    };
  }
  const form = formPackage(position.formId)!;
  const effective = applyAmendments(form, position.amendments);
  const risk = riskFrom(contractId, form, effective);

  return { contractId, position, effective, risk, summary: risk.summary };
}

function riskFrom(contractId: string, form: StandardForm, effective: EffectiveClause[]): ContractRiskRegister {
  const standardWeight = new Map(form.clauses.map((clause) => [clause.ref, clause.riskWeight]));

  const findings: RiskFinding[] = effective
    .filter((clause) => clause.riskPattern !== undefined || clause.changes.length > 0 || clause.riskWeight >= APPETITE)
    .map((clause) => {
      const before = standardWeight.get(clause.ref) ?? clause.riskWeight;
      const walkAway = !clause.deleted && clause.riskWeight >= APPETITE;
      return {
        clauseRef: clause.ref,
        title: clause.title,
        ...(clause.riskPattern === undefined ? {} : { pattern: clause.riskPattern }),
        riskWeight: clause.riskWeight,
        standardWeight: before,
        amendedBy: clause.amendedBy,
        changes: clause.changes,
        walkAway,
        reading: clause.deleted
          ? `Struck out by ${clause.amendedBy.join(', ')}. What the parties rely on instead is not in the form.`
          : clause.inserted
            ? `Added by ${clause.amendedBy.join(', ')}, so there is no standard position to compare it against.`
            : clause.changes.length === 0
              ? `Standard, and onerous as standard: ${clause.consequenceOfBreach}`
              : `${clause.changes.length} change(s) from the standard form` +
                (clause.riskWeight > before ? `, moving it from ${before} to ${clause.riskWeight}.` : '.'),
      };
    })
    .sort((a, b) => b.riskWeight - a.riskWeight);

  const walkAways = findings.filter((finding) => finding.walkAway).length;
  const amended = effective.filter((clause) => clause.changes.length > 0 && !clause.inserted && !clause.deleted).length;
  const deleted = effective.filter((clause) => clause.deleted).length;
  const inserted = effective.filter((clause) => clause.inserted).length;

  return {
    contractId,
    formName: form.name,
    findings,
    amended,
    deleted,
    inserted,
    walkAways,
    disclaimer: DISCLAIMER,
    summary:
      `${form.name}: ${amended} clause(s) amended, ${deleted} struck out, ${inserted} inserted. ` +
      (walkAways === 0
        ? 'Nothing sits above the stated appetite.'
        : `${walkAways} term(s) sit above the stated appetite and need the legal role before this is priced.`),
  };
}

/**
 * Where the library and the citation table must agree.
 *
 * Two tables describing the same forms is exactly how a second source of truth
 * starts. This is the reconciliation, published so a test can assert it and the
 * console can show it rather than either table quietly drifting.
 */
export type CitationRow = {
  formId: string;
  category: string;
  library: string;
  citation: string;
  agrees: boolean;
  /** Why the two differ, where the difference is understood rather than a bug. */
  reason?: string;
};

/**
 * Where the citation table is right about the suite and wrong about the form.
 *
 * `contractClauses.ts` is keyed by **suite**, and a suite has more than one
 * form. Its JCT numbering is the Standard Building Contract's: in SBC 2016 the
 * contractor's notice of delay is 2.27, and in Design and Build 2016 the same
 * obligation is 2.24. Neither number is wrong; they belong to different books.
 *
 * Recorded here rather than silently exempted, because the reconciliation's
 * whole job is to fail when the two tables drift — and an unexplained
 * divergence is drift. A contractor on Design and Build who cites 2.27 is
 * citing another contract, so the package's number is the one to use where a
 * form is known.
 */
const KNOWN_DIVERGENCE: Record<string, string> = {
  'jct-db-2016::EXTENSION_OF_TIME':
    'The citation table is keyed by suite and carries JCT Standard Building Contract numbering, where the notice of ' +
    'delay is 2.27. In Design and Build 2016 the same obligation is 2.24. Where the form is known, the package’s ' +
    'number is the one to cite.',
};

export function citationAgreement(): CitationRow[] {
  const rows: CitationRow[] = [];
  for (const form of PACKAGES) {
    for (const clause of form.clauses) {
      const cited = clauseFor(form.suite, clause.category);
      if (!cited) continue;
      const agrees = cited.clause === clause.ref;
      const reason = KNOWN_DIVERGENCE[`${form.id}::${clause.category}`];
      rows.push({
        formId: form.id,
        category: clause.category,
        library: clause.ref,
        citation: cited.clause,
        agrees,
        ...(agrees || reason === undefined ? {} : { reason }),
      });
    }
  }
  return rows;
}
