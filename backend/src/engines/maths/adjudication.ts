import { businessDayOnOrBefore, reckonPeriod, DEFAULT_CALENDAR, type BusinessCalendar } from './constructionAct.ts';

/**
 * Statutory adjudication under HGCRA 1996 s.108, as amended by LDEDCA 2009.
 *
 * Not to be confused with tender adjudication, which this platform also has and
 * which is the commercial decision that closes a bid evaluation. They share a
 * word and nothing else. This one is the twenty-eight-day dispute procedure
 * every construction contract in the United Kingdom must contain, and which the
 * Scheme supplies in full where the contract does not.
 *
 * The reason to hold the timetable rather than trust it to a diary is that both
 * ends of it are fatal in different directions.
 *
 * **Miss the referral and there is no adjudication.** The notice starts a
 * seven-day clock to secure an appointment and serve the referral. Blow it and
 * the appointment is liable to be a nullity — the referring party can start
 * again with a fresh notice, but has paid for a procedure that produced nothing
 * and told the other side exactly what is coming.
 *
 * **Miss the decision and there is no decision.** An adjudicator who reaches a
 * decision one day outside the period has produced something unenforceable, and
 * the parties are back where they started having spent the fees. This is the
 * point of the extension mechanics being precise: fourteen days is available on
 * the referring party's consent alone, anything beyond that needs both parties,
 * and consent given *before* the referral does not count.
 *
 * Nothing here decides who is right. It decides whether the procedure is intact,
 * which is the question everybody forgets to ask until it is too late to fix.
 */

/** s.108(2): the statutory timetable, in days. */
export const ADJUDICATION_PERIODS = {
  /** s.108(2)(b): appointment secured and the dispute referred within 7 days of the notice. */
  referralDays: 7,
  /** s.108(2)(c): a decision within 28 days of referral. */
  decisionDays: 28,
  /** s.108(2)(d): up to 14 further days on the referring party's consent alone. */
  referringPartyExtensionDays: 14,
} as const;

export type DisputeTimetable = {
  noticeDate: string;
  /** The last day the referral can be served, and the day it should be served by. */
  referralDeadline: string;
  referralServeBy: string;
  referralServeByMoved: boolean;
  /** Present once the dispute has actually been referred. */
  referralDate?: string;
  referredInTime?: boolean;
  referralDaysTaken?: number;
  /** The 28-day date, and the date as extended where an extension is in force. */
  decisionDeadline?: string;
  extendedDecisionDeadline?: string;
  extensionDays?: number;
  extensionValid?: boolean;
  extensionAuthority?: string;
};

/**
 * Build the timetable from the notice, and from the referral once it exists.
 *
 * The seven- and twenty-eight-day periods are both seven days or more, so
 * s.116(3) does not reach them and they are counted plainly. `reckonPeriod`
 * decides that rather than this module assuming it — the rule turns on the
 * length of the period, and a contract free to set its own shorter period would
 * change the answer without changing this code.
 */
export function buildTimetable(
  input: {
    noticeDate: string;
    referralDate?: string;
    /** Days of extension agreed, and by whom. */
    extensionDays?: number;
    extensionAgreedBy?: 'REFERRING_PARTY' | 'BOTH_PARTIES';
    /** When the extension was agreed. Consent before referral does not count. */
    extensionAgreedDate?: string;
  },
  calendar: BusinessCalendar = DEFAULT_CALENDAR,
): DisputeTimetable {
  const referralDeadline = reckonPeriod(input.noticeDate, ADJUDICATION_PERIODS.referralDays, calendar);
  const referralServeBy = businessDayOnOrBefore(referralDeadline, calendar);

  const timetable: DisputeTimetable = {
    noticeDate: input.noticeDate,
    referralDeadline,
    referralServeBy,
    referralServeByMoved: referralServeBy !== referralDeadline,
  };

  if (!input.referralDate) return timetable;

  timetable.referralDate = input.referralDate;
  timetable.referredInTime = input.referralDate <= referralDeadline;
  timetable.referralDaysTaken = Math.round(
    (Date.parse(input.referralDate) - Date.parse(input.noticeDate)) / 86_400_000,
  );

  const decisionDeadline = reckonPeriod(input.referralDate, ADJUDICATION_PERIODS.decisionDays, calendar);
  timetable.decisionDeadline = decisionDeadline;

  if (input.extensionDays && input.extensionDays > 0) {
    const { valid, authority } = validateExtension(input, timetable);
    timetable.extensionDays = input.extensionDays;
    timetable.extensionValid = valid;
    timetable.extensionAuthority = authority;
    timetable.extendedDecisionDeadline = valid
      ? reckonPeriod(decisionDeadline, input.extensionDays, calendar)
      : decisionDeadline;
  }

  return timetable;
}

function validateExtension(
  input: { extensionDays?: number; extensionAgreedBy?: 'REFERRING_PARTY' | 'BOTH_PARTIES'; extensionAgreedDate?: string },
  timetable: DisputeTimetable,
): { valid: boolean; authority: string } {
  const days = input.extensionDays ?? 0;

  // s.108(2)(e): an agreement to a longer period is only effective if made
  // *after the dispute has been referred*. A clause in the contract agreeing in
  // advance to whatever the adjudicator asks for is not consent under the Act.
  if (input.extensionAgreedDate && timetable.referralDate && input.extensionAgreedDate < timetable.referralDate) {
    return {
      valid: false,
      authority: 's.108(2)(e) — consent to an extension has no effect unless given after the dispute was referred',
    };
  }

  if (input.extensionAgreedBy === 'BOTH_PARTIES') {
    return { valid: true, authority: 's.108(2)(e) — agreed by both parties after referral' };
  }

  if (days <= ADJUDICATION_PERIODS.referringPartyExtensionDays) {
    return { valid: true, authority: `s.108(2)(d) — up to ${ADJUDICATION_PERIODS.referringPartyExtensionDays} days on the referring party's consent` };
  }

  return {
    valid: false,
    authority: `s.108(2)(d) allows ${ADJUDICATION_PERIODS.referringPartyExtensionDays} days on the referring party's consent alone; ${days} needs both parties`,
  };
}

export type ProcedureFinding = {
  authority: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  finding: string;
  consequence: string;
};

/**
 * Is the procedure intact?
 *
 * Deliberately silent on the merits. Whether a party should win is a matter for
 * the adjudicator; whether there is anything for them to decide is a matter of
 * dates, and dates are the part a platform can be sure about.
 */
export function assessProcedure(
  timetable: DisputeTimetable,
  input: { decisionDate?: string; status: string },
  today: string,
): ProcedureFinding[] {
  const findings: ProcedureFinding[] = [];
  const effectiveDeadline = timetable.extendedDecisionDeadline ?? timetable.decisionDeadline;

  if (timetable.referralDate === undefined) {
    const overdue = today > timetable.referralDeadline;
    findings.push({
      authority: 'HGCRA 1996 s.108(2)(b)',
      severity: overdue ? 'CRITICAL' : 'WARNING',
      finding: overdue
        ? `The seven-day referral period expired on ${timetable.referralDeadline} and no referral is recorded.`
        : `The referral must be served by ${timetable.referralDeadline}.`,
      consequence: overdue
        ? 'An appointment secured outside the period is liable to be a nullity. A fresh notice of adjudication can be served — the right arises at any time — but the costs of this attempt are lost and the responding party has had sight of the case.'
        : 'The adjudicator must be appointed and the referral served within the period. The right to adjudicate is not lost by missing it, but this reference is.',
    });

    if (timetable.referralServeByMoved && !overdue) {
      findings.push({
        authority: 'Service',
        severity: 'INFO',
        finding: `The referral deadline of ${timetable.referralDeadline} is not a business day.`,
        consequence: `The statutory date does not move. Serve by ${timetable.referralServeBy} so the referral is received in time.`,
      });
    }
    return findings;
  }

  if (timetable.referredInTime === false) {
    findings.push({
      authority: 'HGCRA 1996 s.108(2)(b)',
      severity: 'CRITICAL',
      finding: `The dispute was referred on ${timetable.referralDate}, ${timetable.referralDaysTaken} days after the notice — outside the seven-day period.`,
      consequence:
        'The adjudicator’s jurisdiction is open to challenge on that ground alone. Expect the point to be taken, and reserve position rather than proceeding as though it were not there.',
    });
  }

  if (timetable.extensionValid === false) {
    findings.push({
      authority: 'HGCRA 1996 s.108(2)(d)–(e)',
      severity: 'CRITICAL',
      finding: `The ${timetable.extensionDays}-day extension is not validly agreed. ${timetable.extensionAuthority}`,
      consequence:
        'A decision reached in reliance on an extension that was not validly agreed is out of time and unenforceable. The deadline remains the unextended one.',
    });
  }

  if (input.decisionDate && effectiveDeadline) {
    const late = input.decisionDate > effectiveDeadline;
    findings.push({
      authority: 'HGCRA 1996 s.108(2)(c)',
      severity: late ? 'CRITICAL' : 'INFO',
      finding: late
        ? `The decision is dated ${input.decisionDate}, after the deadline of ${effectiveDeadline}.`
        : `The decision was reached on ${input.decisionDate}, within the period ending ${effectiveDeadline}.`,
      consequence: late
        ? 'A decision reached outside the period is a nullity and cannot be enforced. The parties are where they started, having paid the adjudicator’s fees. The dispute may be referred again.'
        : 'The decision binds the parties until the dispute is finally determined by legal proceedings, by arbitration, or by agreement. It must be complied with in the meantime, whatever either party thinks of it.',
    });
    return findings;
  }

  if (effectiveDeadline) {
    const daysRemaining = Math.round((Date.parse(effectiveDeadline) - Date.parse(today)) / 86_400_000);
    findings.push({
      authority: 'HGCRA 1996 s.108(2)(c)',
      severity: daysRemaining < 0 ? 'CRITICAL' : daysRemaining <= 7 ? 'WARNING' : 'INFO',
      finding:
        daysRemaining < 0
          ? `The decision period expired on ${effectiveDeadline} and no decision is recorded.`
          : `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remain of the decision period, which ends on ${effectiveDeadline}.`,
      consequence:
        daysRemaining < 0
          ? 'Any decision now is out of time unless an extension was validly agreed before the period expired. Establish whether one was.'
          : 'The adjudicator must reach a decision within the period. An extension of up to 14 days is available on the referring party’s consent alone; anything longer needs both parties, agreed after referral.',
    });
  }

  return findings;
}

/**
 * s.108A: who pays for the adjudication.
 *
 * Inserted by LDEDCA 2009 to kill the Tolent clause — a term making the
 * referring party bear both sides' costs whatever the outcome, which made the
 * statutory right too expensive to use and so defeated it. Such a term is
 * ineffective unless it is made *in writing after the notice of adjudication*,
 * which in practice means it is ineffective.
 *
 * The exception is the adjudicator's own fees, which the parties may agree to
 * apportion, and which the adjudicator may apportion in the decision.
 */
export function assessCostsProvision(input: {
  contractAllocatesPartiesCosts: boolean;
  agreedInWritingAfterNotice?: boolean;
}): ProcedureFinding[] {
  if (!input.contractAllocatesPartiesCosts) return [];

  if (input.agreedInWritingAfterNotice === true) {
    return [
      {
        authority: 'HGCRA 1996 s.108A(2)(b)',
        severity: 'INFO',
        finding: 'The costs allocation was agreed in writing after the notice of adjudication.',
        consequence: 'It is effective. This is the only route by which such an agreement binds.',
      },
    ];
  }

  return [
    {
      authority: 'HGCRA 1996 s.108A',
      severity: 'CRITICAL',
      finding: 'The contract allocates the parties’ costs of an adjudication in advance.',
      consequence:
        'Ineffective. A term allocating the costs of adjudication binds only if made in writing after the notice of adjudication was given. Each party bears its own costs, and the fear of this clause is not a reason to leave a dispute unreferred.',
    },
  ];
}
