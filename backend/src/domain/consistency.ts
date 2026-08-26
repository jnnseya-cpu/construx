import { formatMoney } from './locale.ts';
import { ulid } from '../core/ids.ts';
import { calculateCPM } from '../engines/maths/cpm.ts';
import { AUTHZ_OPTIONS, authorise, write, type EngineContext } from '../engines/context.ts';
import { evaluateAccess } from '../identity/abac.ts';

/**
 * Cross-consistency: what the records say against each other.
 *
 * Every module here is individually correct. The programme computes a duration
 * from its network, the contract records a completion date, the estimate prices
 * a scope, and the field record measures progress. Each is right about its own
 * subject and none of them looks at the others.
 *
 * That is where the expensive mistakes live. A programme that finishes after
 * the contract date is liquidated damages — a number the platform can compute
 * from two facts it already holds, and does not. Nobody notices, because the
 * planner is looking at a critical path and the commercial manager is looking
 * at a contract, and the two documents are never on the same screen.
 *
 * Three rules keep this from becoming noise.
 *
 * **Every finding carries the money or the days.** "Programme inconsistent with
 * contract" is a shrug. "Forecast completion is 46 days past the contract date,
 * £575,000 of liquidated damages at the contractual rate" is a decision.
 *
 * **A finding names both records it came from**, so it can be checked rather
 * than believed.
 *
 * **Where a fact is missing the check is skipped and said to be skipped**, not
 * silently passed. A project with no contract recorded has not passed the
 * contract check; it has not taken it.
 */

export type FindingSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export type ConsistencyFinding = {
  check: string;
  severity: FindingSeverity;
  /** What disagrees, stated as the disagreement rather than as a status. */
  finding: string;
  /** What it costs or what to do, with the figure behind it. */
  consequence: string;
  /** The records the finding was derived from, so it can be checked. */
  sources: Array<{ refType: string; refId: string }>;
  exposureMinor?: number;
  exposureDays?: number;
};

export type SkippedCheck = { check: string; reason: string };

export type ConsistencyReport = {
  findings: ConsistencyFinding[];
  /**
   * True where the reader may see the disagreements but not the money.
   *
   * A safety lead should know the programme is 143 days past the contract date
   * — that is a fact about the job. What they have no business reading is what
   * it costs. The same decision the audit feed makes: keep the envelope,
   * withhold the content.
   */
  commercialWithheld: boolean;
  /** Checks that could not run, and why. Not the same as checks that passed. */
  skipped: SkippedCheck[];
  /** Checks that ran and found nothing. */
  passed: string[];
  totalExposureMinor: number;
  summary: string;
};

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Math.round(days));
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

/**
 * Run every consistency check the recorded data supports.
 *
 * Reads only. A disagreement between two records is a question for a person,
 * not a fact to write down — and writing one would mean the report changed the
 * thing it was reporting on.
 */
export function consistencyReport(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): ConsistencyReport {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  // Every role can read a project's identity, so that check alone would hand a
  // safety lead the liquidated damages exposure and the budget overruns. The
  // commercial sensitivity is evaluated separately: a reader without clearance
  // still gets the disagreements, because knowing the programme is past the
  // contract date is a fact about the job — they simply do not get the money.
  const commercialWithheld =
    evaluateAccess(
      ctx.auth,
      'BUDGET_COST',
      'R',
      { tenantId: ctx.tenantId, projectId: ctx.projectId, dataSensitivity: 'COMMERCIAL_L3' },
      AUTHZ_OPTIONS,
    ).decision !== 'ALLOW';

  const findings: ConsistencyFinding[] = [];
  const skipped: SkippedCheck[] = [];
  const passed: string[] = [];

  const project = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId });
  const contract = ctx.ledger.list(ctx.projectId, 'Contract').at(-1);
  const tasks = ctx.ledger.list(ctx.projectId, 'Task');
  const currency = String(project?.state.currency ?? 'GBP');

  // --- Contract against programme ------------------------------------------
  //
  // The one that costs money. The planner has a duration and the commercial
  // manager has a date, and nothing in a normal working week puts them side by
  // side.
  if (!contract) {
    skipped.push({ check: 'Contract against programme', reason: 'No contract is recorded on this project' });
  } else if (tasks.length === 0) {
    skipped.push({ check: 'Contract against programme', reason: 'No programme activities exist to schedule' });
  } else if (typeof project?.state.plannedStart !== 'string' || typeof contract.state.completionDate !== 'string') {
    skipped.push({
      check: 'Contract against programme',
      reason: 'A start date and a contractual completion date are both needed to compare them',
    });
  } else {
    const activities = tasks.map((record) => ({
      id: record.refId,
      name: String(record.state.name),
      duration: Number(record.state.durationDays),
    }));
    const dependencies = ctx.ledger.list(ctx.projectId, 'Dependency').map((record) => ({
      predecessorId: String(record.state.predecessorId),
      successorId: String(record.state.successorId),
      type: record.state.type as 'FS' | 'SS' | 'FF' | 'SF',
      lag: Number(record.state.lag ?? 0),
    }));

    const cpm = calculateCPM(activities, dependencies);
    const start = String(project.state.plannedStart).slice(0, 10);
    const contractDate = String(contract.state.completionDate).slice(0, 10);
    const forecastDate = addDays(start, cpm.projectDuration);
    const overrun = daysBetween(contractDate, forecastDate);

    if (overrun > 0) {
      const rate = Number(contract.state.liquidatedDamagesPerDayMinor ?? 0);
      const cap = Number(contract.state.ldCapMinor ?? 0);
      const uncapped = rate * overrun;
      // The cap is part of the contract, so the exposure is what is actually
      // payable rather than the arithmetic before the cap applies.
      const exposure = cap > 0 ? Math.min(uncapped, cap) : uncapped;

      findings.push({
        check: 'Contract against programme',
        severity: 'CRITICAL',
        finding:
          `The programme forecasts completion on ${forecastDate}, ${overrun} day${overrun === 1 ? '' : 's'} after the ` +
          `contractual date of ${contractDate}.`,
        consequence:
          rate > 0
            ? `Liquidated damages at the contractual rate come to ${formatMoney(exposure, currency)}` +
              `${cap > 0 && uncapped > cap ? ' — the contractual cap, which the overrun has already reached' : ''}. ` +
              'Either the programme recovers or an extension of time is due.'
            : 'No liquidated damages rate is recorded, so the cost cannot be stated. The overrun is real either way.',
        sources: [
          { refType: 'Contract', refId: contract.refId },
          { refType: 'Project', refId: ctx.projectId },
        ],
        exposureMinor: rate > 0 ? exposure : undefined,
        exposureDays: overrun,
      });
    } else {
      passed.push(`Contract against programme — forecast completion ${forecastDate}, ${Math.abs(overrun)} days inside the contract date`);
    }
  }

  // --- Schedule against progress -------------------------------------------
  //
  // An activity that has consumed more elapsed time than its whole duration and
  // is not finished has already overrun; the programme still shows its original
  // duration, so the network is forecasting from a date that has passed.
  const started = tasks.filter((t) => Number(t.state.elapsedDays ?? 0) > 0);
  if (started.length === 0) {
    skipped.push({ check: 'Schedule against progress', reason: 'No activity has recorded elapsed time yet' });
  } else {
    const overrunning = started.filter((t) => {
      const elapsed = Number(t.state.elapsedDays ?? 0);
      const planned = Number(t.state.durationDays ?? 0);
      const complete = Number(t.state.percentComplete ?? 0);
      return complete < 100 && elapsed > planned;
    });

    if (overrunning.length > 0) {
      const worst = overrunning
        .map((t) => ({
          name: String(t.state.name),
          over: Number(t.state.elapsedDays) - Number(t.state.durationDays),
          complete: Number(t.state.percentComplete ?? 0),
          refId: t.refId,
        }))
        .sort((a, b) => b.over - a.over);

      findings.push({
        check: 'Schedule against progress',
        severity: 'WARNING',
        finding:
          `${overrunning.length} activit${overrunning.length === 1 ? 'y has' : 'ies have'} used more time than their whole ` +
          `duration without finishing — worst is "${worst[0]!.name}", ${worst[0]!.over} days over at ${worst[0]!.complete}% complete.`,
        consequence:
          'The network is still scheduling from the original durations, so every forecast downstream of these is being ' +
          'computed from a date that has already passed. Re-baseline or update the durations.',
        sources: worst.slice(0, 3).map((w) => ({ refType: 'Task', refId: w.refId })),
        exposureDays: worst[0]!.over,
      });
    } else {
      passed.push(`Schedule against progress — ${started.length} started activities, none past their duration`);
    }
  }

  // --- Slippage the network has not absorbed --------------------------------
  //
  // An activity that finished 22 days late is finished: it drops out of the
  // overrun check above, and the network still holds its *original* duration
  // because nobody re-baselined. So the forecast completion date is optimistic
  // by the slippage that has already happened — a delay that is not a forecast
  // at all, it is history the programme has not been told about.
  const completed = tasks.filter((t) => Number(t.state.percentComplete ?? 0) >= 100);
  const slipped = completed
    .map((t) => ({ name: String(t.state.name), slippage: Number(t.state.slippageDays ?? 0), refId: t.refId }))
    .filter((t) => t.slippage > 0)
    .sort((a, b) => b.slippage - a.slippage);

  if (completed.length === 0) {
    skipped.push({ check: 'Slippage absorbed into the programme', reason: 'No activity has completed yet' });
  } else if (slipped.length > 0) {
    const total = slipped.reduce((sum, t) => sum + t.slippage, 0);
    findings.push({
      check: 'Slippage absorbed into the programme',
      severity: 'WARNING',
      finding:
        `${slipped.length} completed activit${slipped.length === 1 ? 'y' : 'ies'} finished late by ${total} days in total ` +
        `— worst "${slipped[0]!.name}" at ${slipped[0]!.slippage} days — and the network still holds their original durations.`,
      consequence:
        'The forecast completion date is optimistic by up to that much, because the programme has not been told about ' +
        'delay that has already happened. Re-baseline, or update the durations to what the work actually took.',
      sources: slipped.slice(0, 3).map((t) => ({ refType: 'Task', refId: t.refId })),
      exposureDays: total,
    });
  } else {
    passed.push(`Slippage absorbed into the programme — ${completed.length} completed activities, none finished late`);
  }

  // --- Estimate against contract sum ---------------------------------------
  const estimates = ctx.ledger.list(ctx.projectId, 'Estimate');
  if (!contract || estimates.length === 0) {
    skipped.push({
      check: 'Estimate against contract sum',
      reason: !contract ? 'No contract is recorded' : 'No estimate is recorded on this project',
    });
  } else {
    const estimate = estimates.at(-1)!;
    const estimated = Number(estimate.state.totalMinor ?? estimate.state.tenderTotalMinor ?? 0);
    const contractSum = Number(contract.state.contractSumMinor ?? 0);

    if (estimated === 0 || contractSum === 0) {
      skipped.push({ check: 'Estimate against contract sum', reason: 'One of the two totals is not recorded' });
    } else {
      const variance = contractSum - estimated;
      const variancePercent = (variance / estimated) * 100;

      // A gap either way is worth naming. Under the estimate is margin that was
      // conceded; over it usually means the contract carries scope the estimate
      // did not price.
      if (Math.abs(variancePercent) > 2) {
        findings.push({
          check: 'Estimate against contract sum',
          severity: Math.abs(variancePercent) > 10 ? 'CRITICAL' : 'WARNING',
          finding:
            `The contract sum is ${variance < 0 ? 'below' : 'above'} the estimate by ` +
            `${formatMoney(Math.abs(variance), currency)} (${Math.abs(variancePercent).toFixed(1)}%).`,
          consequence:
            variance < 0
              ? 'Signed below the priced cost. Either the estimate carried something the contract excludes, or the margin was given away at negotiation and the cost report will show it as erosion.'
              : 'Signed above the priced cost. Confirm the difference is scope the estimate did not include rather than a transcription error.',
          sources: [
            { refType: 'Estimate', refId: estimate.refId },
            { refType: 'Contract', refId: contract.refId },
          ],
          exposureMinor: Math.abs(variance),
        });
      } else {
        passed.push('Estimate against contract sum — within 2%');
      }
    }
  }

  // --- Duplicate detection --------------------------------------------------
  //
  // Two activities with the same code are not a naming preference; they are a
  // programme where progress recorded against one of them is invisible on the
  // other, and where every report double-counts.
  const byCode = new Map<string, string[]>();
  for (const task of tasks) {
    const code = String(task.state.activityCode ?? '').trim().toUpperCase();
    if (!code) continue;
    byCode.set(code, [...(byCode.get(code) ?? []), task.refId]);
  }
  const duplicates = [...byCode.entries()].filter(([, ids]) => ids.length > 1);

  if (tasks.length === 0) {
    skipped.push({ check: 'Duplicate activity codes', reason: 'No activities exist' });
  } else if (duplicates.length > 0) {
    findings.push({
      check: 'Duplicate activity codes',
      severity: 'WARNING',
      finding: `${duplicates.length} activity code${duplicates.length === 1 ? ' is' : 's are'} used more than once: ${duplicates.map(([code]) => code).slice(0, 5).join(', ')}.`,
      consequence:
        'Progress recorded against one is invisible on the other, and anything that groups by code counts the work twice.',
      sources: duplicates.flatMap(([, ids]) => ids.slice(0, 2)).slice(0, 4).map((refId) => ({ refType: 'Task', refId })),
    });
  } else {
    passed.push(`Duplicate activity codes — ${byCode.size} codes, all distinct`);
  }

  // --- Commitment against budget -------------------------------------------
  const budgets = ctx.ledger.list(ctx.projectId, 'Budget').filter((b) => b.state.status === 'APPROVED');
  const commitments = ctx.ledger.list(ctx.projectId, 'Commitment');

  if (budgets.length === 0 || commitments.length === 0) {
    skipped.push({
      check: 'Commitments against budget',
      reason: budgets.length === 0 ? 'No approved budget exists' : 'Nothing has been committed yet',
    });
  } else {
    const budget = budgets.at(-1)!;
    const lines = (budget.state.byCostCode ?? []) as Array<{ costCode: string; budgetMinor: number }>;
    const budgetByCode = new Map(lines.map((line) => [line.costCode, Number(line.budgetMinor)]));

    const committedByCode = new Map<string, number>();
    for (const commitment of commitments) {
      const code = String(commitment.state.costCode ?? '');
      if (!code) continue;
      committedByCode.set(code, (committedByCode.get(code) ?? 0) + Number(commitment.state.valueMinor ?? 0));
    }

    const over = [...committedByCode.entries()]
      .map(([code, committed]) => ({ code, committed, budget: budgetByCode.get(code) ?? 0 }))
      .filter((line) => line.budget > 0 && line.committed > line.budget)
      .sort((a, b) => b.committed - b.budget - (a.committed - a.budget));

    if (over.length > 0) {
      const total = over.reduce((sum, line) => sum + (line.committed - line.budget), 0);
      findings.push({
        check: 'Commitments against budget',
        severity: 'CRITICAL',
        finding: `${over.length} cost code${over.length === 1 ? ' is' : 's are'} committed above the approved budget, by ${formatMoney(total, currency)} in total.`,
        consequence:
          'The money is already spent contractually. This is not a forecast overrun — it is an approved budget that no longer holds.',
        sources: [{ refType: 'Budget', refId: budget.refId }],
        exposureMinor: total,
      });
    } else {
      passed.push(`Commitments against budget — ${committedByCode.size} committed cost codes, all within budget`);
    }
  }

  // --- The chain, link by link ---------------------------------------------
  //
  // Bid -> Contract -> Subcontract -> Commitment -> Application -> Ledger -> CVR
  // is one enforced flow, and the requirement is that a break anywhere raises an
  // exception. Every other check in this file compares two records that
  // *disagree*; this one looks for a record that is *unattached* — a subcontract
  // under no contract, an application against no subcontract, a CVR built from
  // no contract at all.
  //
  // An orphan is quieter than a disagreement and worse. A disagreement is two
  // numbers that do not match and somebody eventually notices. An orphan is a
  // record that looks entirely correct on its own screen and simply never
  // reaches the screen downstream: money committed against nothing, an
  // application nobody reconciles, a CVR whose contract sum came from a place
  // no longer traceable.
  //
  // Checked by reference rather than by count. "Six subcontracts and six
  // packages" proves nothing about whether they are the same six.
  //
  // The keys below are the ones the writing engines actually set, which is not
  // always the name the link would suggest — a `Commitment` names its
  // subcontract in a field called `contractId`, because a commitment can stand
  // against either. Guessing the obvious name here would have produced a check
  // that reported a total break on a perfectly connected project.
  const chain: Array<{
    link: string;
    downstream: string;
    upstream: string;
    /** The field on the downstream record that names its upstream. */
    key: string;
    /** Which downstream records this link governs, where it governs only some. */
    only?: (state: Record<string, unknown>) => boolean;
    consequence: string;
  }> = [
    {
      link: 'Contract from the winning bid',
      downstream: 'Contract',
      upstream: 'BidSubmissionPack',
      key: 'sourceBidPackId',
      consequence:
        'The contract sum cannot be traced to the bid it came from, so the exclusions and qualifications the price was given on are not attached to the obligation. That is the gap a final account is argued in.',
    },
    {
      link: 'Subcontract from the awarded enquiry',
      downstream: 'Subcontract',
      upstream: 'RFQ',
      key: 'rfqId',
      consequence:
        'A subcontract that names no enquiry cannot be checked against what was tendered, so the buyout position is unauditable and the carried exclusions have no source.',
    },
    {
      link: 'Commitment against a subcontract',
      downstream: 'Commitment',
      upstream: 'Subcontract',
      key: 'contractId',
      only: (state) => state.type === 'SUBCONTRACT',
      consequence:
        'Money is committed against nothing. It will not appear in the subcontract position and will not be reconciled when the account is settled.',
    },
    {
      link: 'Payment cycle against the contract',
      downstream: 'PaymentCycle',
      upstream: 'Contract',
      key: 'contractId',
      consequence:
        'The statutory dates were generated against a contract the cycle cannot name, so nothing can confirm they were computed from the right payment terms.',
    },
    {
      link: 'Application against a payment cycle',
      downstream: 'PaymentApplication',
      upstream: 'PaymentCycle',
      key: 'cycleId',
      consequence:
        'An application outside any cycle has no due date and no notice deadlines attached to it. Under the Construction Act the clock runs anyway, so the exposure is a payment becoming due by default.',
    },
    {
      link: 'CVR from the contract',
      downstream: 'CVR',
      upstream: 'Contract',
      key: 'contractId',
      consequence:
        'The reported margin is computed against a contract sum the report cannot name. It may be right; nothing in the record shows it.',
    },
  ];

  for (const step of chain) {
    const downstream = ctx.ledger
      .list(ctx.projectId, step.downstream)
      .filter((record) => (step.only ? step.only(record.state) : true));
    const upstream = ctx.ledger.list(ctx.projectId, step.upstream);

    if (downstream.length === 0) {
      skipped.push({ check: step.link, reason: `No ${step.downstream} record exists yet` });
      continue;
    }
    if (upstream.length === 0) {
      // Nothing upstream to attach to. A contract on a job that was never
      // tendered through this platform is negotiated or novated work, not a
      // broken chain — calling it one would flag every imported contract on
      // day one and teach people to ignore the check.
      skipped.push({
        check: step.link,
        reason: `No ${step.upstream} exists on this project, so there is nothing for the ${step.downstream} to be traced to`,
      });
      continue;
    }

    const upstreamIds = new Set(upstream.map((record) => record.refId));
    const broken = downstream.filter((record) => {
      const reference = record.state[step.key];
      // Absent and dangling are both breaks, and they are different mistakes:
      // one was never linked, the other points at something that is not there.
      return typeof reference !== 'string' || reference === '' || !upstreamIds.has(reference);
    });

    if (broken.length === 0) {
      passed.push(`${step.link} — ${downstream.length} record${downstream.length === 1 ? '' : 's'}, all traceable`);
      continue;
    }

    // The exposure is the value of what is unattached, where the record carries
    // one. A number makes this a decision rather than a housekeeping note.
    const exposure = broken.reduce(
      (sum, record) =>
        sum +
        Number(record.state.valueMinor ?? record.state.amountMinor ?? record.state.grossMinor ?? 0),
      0,
    );

    findings.push({
      check: step.link,
      severity: 'CRITICAL',
      finding:
        `${broken.length} of ${downstream.length} ${step.downstream} record${downstream.length === 1 ? '' : 's'} ` +
        `${broken.length === 1 ? 'does' : 'do'} not name the ${step.upstream} ${broken.length === 1 ? 'it' : 'they'} came from. ` +
        'The data flow is broken at this link.',
      consequence: step.consequence,
      sources: broken.slice(0, 4).map((record) => ({ refType: step.downstream, refId: record.refId })),
      ...(exposure > 0 ? { exposureMinor: exposure } : {}),
    });
  }

  const totalExposure = findings.reduce((sum, f) => sum + (f.exposureMinor ?? 0), 0);

  if (commercialWithheld) {
    for (const finding of findings) {
      if (finding.exposureMinor === undefined) continue;
      finding.exposureMinor = undefined;
      finding.consequence = 'Commercial detail withheld from this role. The disagreement itself stands.';
    }
  }
  const critical = findings.filter((f) => f.severity === 'CRITICAL').length;

  const summary =
    findings.length === 0
      ? skipped.length === 0
        ? `All ${passed.length} checks ran and agree.`
        : `${passed.length} check${passed.length === 1 ? '' : 's'} agree; ${skipped.length} could not run for want of a record.`
      : `${findings.length} record${findings.length === 1 ? '' : 's'} disagree${findings.length === 1 ? 's' : ''} with ${findings.length === 1 ? 'another' : 'others'}` +
        `${critical > 0 ? `, ${critical} of them material` : ''}` +
        `${totalExposure > 0 ? `, ${formatMoney(totalExposure, currency)} at stake` : ''}.`;

  return {
    findings,
    commercialWithheld,
    skipped,
    passed,
    totalExposureMinor: commercialWithheld ? 0 : totalExposure,
    summary: commercialWithheld ? summary.replace(/, [^,]*at stake\./, '.') : summary,
  };
}

/**
 * Raise the chain break as an exception to whoever owns the commercial position.
 *
 * The rule is that a break in the bid-to-CVR flow *raises an exception* — not
 * that it appears on a report somebody may open. A finding on a screen nobody
 * has loaded is not an alert, and the difference matters most exactly when it
 * matters at all: an unattached commitment is invisible precisely because
 * nobody is looking at the record it should have been attached to.
 *
 * Three things make this an exception rather than a repeated complaint.
 *
 * **It is recorded, not only sent.** An alert that exists only in an inbox
 * cannot be shown as open, cannot be shown as closed, and cannot be counted.
 * The `ChainException` record is the thing a commercial manager works from.
 *
 * **It is raised once.** A break already carrying an open exception is not
 * raised again, however many times this runs. An escalation that re-fires on
 * every sweep is one people filter to a folder, and then the one that mattered
 * goes to the folder too.
 *
 * **It closes itself.** When the link that was broken comes back clean, the
 * open exception is cleared with the same mechanism that raised it. Nobody has
 * to remember to tidy up after a fix, and an exception left open is therefore
 * evidence of a break that is still real.
 *
 * The report itself stays read-only. This is the deliberate other half: the
 * report answers "what disagrees", and this answers "who has been told".
 */

/** The chain checks, by name. An exception is only ever raised for one of these. */
const CHAIN_CHECKS = new Set([
  'Contract from the winning bid',
  'Subcontract from the awarded enquiry',
  'Commitment against a subcontract',
  'Payment cycle against the contract',
  'Application against a payment cycle',
  'CVR from the contract',
]);

export type ChainExceptionRecord = {
  id: string;
  check: string;
  finding: string;
  consequence: string;
  exposureMinor?: number;
  sources: Array<{ refType: string; refId: string }>;
};

export type ChainEscalation = {
  /** Exceptions raised by this run — breaks nobody had been told about. */
  raised: ChainExceptionRecord[];
  /** Breaks that already carry an open exception. Not re-raised, and not hidden. */
  alreadyOpen: string[];
  /** Exceptions closed because the link they were about is now clean. */
  cleared: string[];
  /**
   * Who the exception is for, by role. Named here rather than at the transport
   * so that the record says who was owed the alert even where no mail was sent.
   */
  owedTo: readonly string[];
  /** Every open exception after this run, raised now or still standing. */
  open: ChainExceptionRecord[];
};

/**
 * The role that owns a broken commercial chain.
 *
 * `COMMERCIAL_MANAGER` is the holder the requirement names. The project
 * director is included because a commercial manager is not guaranteed to exist
 * on a small job, and an exception with no recipient is not an exception.
 */
export const CHAIN_EXCEPTION_ROLES = ['COMMERCIAL_MANAGER', 'PROJECT_DIRECTOR'] as const;

export function escalateChainBreaks(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): ChainEscalation {
  // Read authority over the commercial position, not authorship of it. Raising
  // the alarm about a break is detection; gating it behind 'C' would lock out
  // the Commercial Manager, who holds approval rather than authorship in this
  // area and is the person the exception exists for.
  authorise(ctx, 'BUDGET_COST', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const report = consistencyReport(ctx, today);
  const breaks = new Map(
    report.findings.filter((finding) => CHAIN_CHECKS.has(finding.check)).map((finding) => [finding.check, finding]),
  );

  const existing = ctx.ledger.list(ctx.projectId, 'ChainException');
  const openByCheck = new Map(
    existing.filter((record) => record.state.status === 'OPEN').map((record) => [String(record.state.check), record]),
  );

  const raised: ChainExceptionRecord[] = [];
  const alreadyOpen: string[] = [];
  const cleared: string[] = [];

  for (const [check, finding] of breaks) {
    if (openByCheck.has(check)) {
      alreadyOpen.push(check);
      continue;
    }

    const exceptionId = ulid();
    write(ctx, {
      eventType: 'CHAIN_EXCEPTION_RAISED',
      entity: { refType: 'ChainException', refId: exceptionId },
      // The finding is copied into the record rather than referenced. The
      // report is recomputed from live data every time it runs, so a reference
      // would describe today's state and not the state that caused the alert.
      nextState: {
        id: exceptionId,
        projectId: ctx.projectId,
        check,
        finding: finding.finding,
        consequence: finding.consequence,
        exposureMinor: finding.exposureMinor,
        sources: finding.sources,
        owedTo: [...CHAIN_EXCEPTION_ROLES],
        status: 'OPEN',
        raisedAt: new Date().toISOString(),
      },
    });

    raised.push({
      id: exceptionId,
      check,
      finding: finding.finding,
      consequence: finding.consequence,
      exposureMinor: finding.exposureMinor,
      sources: finding.sources,
    });
  }

  // Anything open whose link no longer breaks. Closed here rather than left for
  // somebody to tidy, so that an exception still open is evidence of a break
  // that is still real.
  for (const [check, record] of openByCheck) {
    if (breaks.has(check)) continue;
    write(ctx, {
      eventType: 'CHAIN_EXCEPTION_CLEARED',
      entity: { refType: 'ChainException', refId: record.refId },
      nextState: {
        ...record.state,
        status: 'CLEARED',
        clearedAt: new Date().toISOString(),
        clearedBecause: 'The link this exception was raised about now traces end to end',
      },
    });
    cleared.push(check);
  }

  const open = ctx.ledger
    .list(ctx.projectId, 'ChainException')
    .filter((record) => record.state.status === 'OPEN')
    .map((record) => ({
      id: record.refId,
      check: String(record.state.check),
      finding: String(record.state.finding),
      consequence: String(record.state.consequence),
      exposureMinor: record.state.exposureMinor as number | undefined,
      sources: (record.state.sources ?? []) as Array<{ refType: string; refId: string }>,
    }));

  return { raised, alreadyOpen, cleared, owedTo: CHAIN_EXCEPTION_ROLES, open };
}
