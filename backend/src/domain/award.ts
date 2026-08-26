import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { approveBudget } from '../engines/cost.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * Submission, award, and the conversion that must not re-key anything.
 *
 * The bid pack was already compiled and locked with a content hash, and a
 * contract could already be converted from it carrying the qualifications and
 * exclusions forward. What sat either side of that was missing, and both halves
 * are where money is lost.
 *
 * **Before**: a submission went out and nothing recorded that it arrived. The
 * portal receipt — the one piece of paper that proves the bid was in before the
 * clock stopped — lived in somebody's inbox. `AC-T-WF-08-01` asks the receipt to
 * identify the exact immutable pack hash, and that is the whole point: a receipt
 * that names a time but not *what* was submitted proves you sent something.
 *
 * **After**: an award arrived and was signed. Nobody compared what the client
 * awarded against what was actually bid. That comparison is where a contract
 * sum quietly differs by £40,000, where a completion date has moved three weeks,
 * where the qualification the price depended on has been struck out — and the
 * moment for it is before execution, not during the first payment cycle.
 *
 * ---
 *
 * **A departure is a difference, not an opinion.** Every one is computed by
 * comparing two recorded values, and every one names both. There is no
 * judgement in this module about whether a departure is acceptable — that is a
 * person's decision, recorded as an acceptance with a reason. What the module
 * refuses is executing a contract while one is neither resolved nor accepted.
 *
 * **The lock means what it says.** Any change to the pack after it is locked
 * invalidates the lock rather than editing it. `BID_PACK_LOCKED` was already a
 * `FREEZE`; what was missing was anything that noticed the freeze had been
 * broken, so a re-lock is recorded as a new lock superseding the old and the
 * submission has to be made again.
 *
 * **A lost bid is not a dead end.** The market intelligence in a losing bid is
 * the only thing that pays for the bid, and `AC-T-WF-08-03`'s counterpart in the
 * exception controls says so. A loss records who won and at what, where that is
 * known, and the opportunity stays searchable.
 */

// --- Submission --------------------------------------------------------------

export const SUBMISSION_CHANNEL = ['PORTAL', 'EMAIL', 'PHYSICAL', 'HAND_DELIVERY'] as const;
export type SubmissionChannel = (typeof SUBMISSION_CHANNEL)[number];

function requirePack(ctx: EngineContext, packId: string): EntityRecord {
  const pack = ctx.ledger.get({ refType: 'BidSubmissionPack', refId: packId });
  if (!pack) throw new DomainError('BID_PACK_NOT_FOUND', `No bid submission pack ${packId}`, 404);
  return pack;
}

export type SubmissionReceipt = {
  /** The reference the buyer's portal or acknowledgement gave back. */
  reference: string;
  channel: SubmissionChannel;
  /** When the buyer says it arrived, not when we pressed send. */
  receivedAt: string;
  /** The acknowledgement itself. */
  evidenceHash: string;
};

/**
 * Record that the submission went in, and what arrived.
 *
 * `AC-T-WF-08-01`. The receipt is bound to the pack's content hash at the point
 * it is recorded, so the record does not say "a bid was submitted at 11:52" — it
 * says *this* bid, these bytes, was submitted at 11:52 and the buyer
 * acknowledged it. A dispute about whether the priced schedule that arrived is
 * the one that was sent is unanswerable without that binding, and it is the
 * argument that follows every disqualification.
 */
export function recordSubmission(
  ctx: EngineContext,
  packId: string,
  receipt: SubmissionReceipt,
): { packId: string; contentHash: string; receivedAt: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'I', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const pack = requirePack(ctx, packId);

  // Already-submitted is checked first, and deliberately. A submitted pack is
  // no longer LOCKED, so the status check would otherwise answer a second
  // receipt with "only a locked pack can be submitted" — true, useless, and
  // hiding the thing the person needs to know, which is that it already went.
  if (pack.state.submission) {
    throw new DomainError(
      'ALREADY_SUBMITTED',
      `This pack was already submitted on ${String((pack.state.submission as SubmissionReceipt).receivedAt)}. A resubmission is a new pack, not a second receipt on this one.`,
    );
  }
  if (pack.state.status !== 'LOCKED') {
    throw new DomainError(
      'BID_PACK_NOT_LOCKED',
      `This pack is ${String(pack.state.status).toLowerCase()}. Only a locked pack can be submitted, because only a locked pack has a hash the receipt can name.`,
    );
  }
  if (!receipt.reference.trim()) {
    throw new DomainError(
      'RECEIPT_REFERENCE_REQUIRED',
      'A submission needs the reference the buyer gave back. "Sent" is not a receipt.',
    );
  }

  const contentHash = String(pack.state.contentHash);

  const evidence = registerEvidence(ctx, {
    type: 'SUBMISSION_RECEIPT',
    hash: receipt.evidenceHash,
    // The pack hash is in the description as well as on the state, so the
    // evidence register on its own answers what was submitted.
    description: `Submission receipt ${receipt.reference} for pack ${contentHash}`,
    linkedEntities: [{ refType: 'BidSubmissionPack', refId: packId }],
  });

  write(ctx, {
    eventType: 'TENDER_SUBMITTED',
    entity: { refType: 'BidSubmissionPack', refId: packId },
    nextState: {
      ...pack.state,
      status: 'SUBMITTED',
      submission: { ...receipt, submittedPackHash: contentHash },
      submittedAt: new Date().toISOString(),
      submittedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { packId, contentHash, receivedAt: receipt.receivedAt };
}

// --- Award -------------------------------------------------------------------

export const AWARD_OUTCOME = ['WON', 'LOST', 'WITHDRAWN'] as const;
export type AwardOutcome = (typeof AWARD_OUTCOME)[number];

/**
 * The terms the client actually awarded on.
 *
 * Deliberately the same shape as the terms that were bid, so the comparison is
 * field against field rather than prose against prose. Everything is optional
 * because a letter of intent often names two of them and nothing else, and a
 * term the award is silent on has not changed — it has not been stated, which
 * is a different thing and is reported as such.
 */
export type AwardedTerms = {
  contractSumMinor?: number;
  commencementDate?: string;
  completionDate?: string;
  liquidatedDamagesPerDayMinor?: number;
  ldCapPercent?: number;
  retentionPercent?: number;
  defectsLiabilityMonths?: number;
  /** Qualifications the client has accepted. Anything bid and not listed here is struck out. */
  acceptedQualifications?: string[];
};

export type Departure = {
  field: string;
  /** What we bid. */
  submitted: string;
  /** What they awarded. */
  awarded: string;
  /** Money, where the difference is money. Negative means worse for us. */
  differenceMinor?: number;
  severity: 'CRITICAL' | 'MAJOR';
  detail: string;
};

const money = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

/**
 * What the client awarded that is not what was bid.
 *
 * Pure, so the comparison can be run and shown before anything is recorded —
 * the person deciding whether to accept a departure should see it before the
 * ledger does.
 *
 * A term the award is silent on is **not** a departure. Reporting silence as a
 * change would fill the list with noise on every letter of intent, and the real
 * departures would be read past.
 */
export function departuresBetween(
  submitted: {
    contractSumMinor: number;
    commencementDate?: string;
    completionDate?: string;
    liquidatedDamagesPerDayMinor?: number;
    ldCapPercent?: number;
    retentionPercent?: number;
    defectsLiabilityMonths?: number;
    qualifications: string[];
  },
  awarded: AwardedTerms,
): Departure[] {
  const departures: Departure[] = [];

  if (awarded.contractSumMinor !== undefined && awarded.contractSumMinor !== submitted.contractSumMinor) {
    const difference = awarded.contractSumMinor - submitted.contractSumMinor;
    departures.push({
      field: 'Contract sum',
      submitted: money(submitted.contractSumMinor),
      awarded: money(awarded.contractSumMinor),
      differenceMinor: difference,
      severity: 'CRITICAL',
      detail:
        difference < 0
          ? `The award is ${money(Math.abs(difference))} below the price bid. Nothing in the submission supports that figure, and signing it accepts the reduction.`
          : `The award is ${money(difference)} above the price bid, which is as much a departure as being under: it means the client has priced something we did not.`,
    });
  }

  if (awarded.completionDate !== undefined && submitted.completionDate && awarded.completionDate !== submitted.completionDate) {
    const days = Math.round(
      (Date.parse(`${awarded.completionDate}T00:00:00Z`) - Date.parse(`${submitted.completionDate}T00:00:00Z`)) / 86_400_000,
    );
    departures.push({
      field: 'Completion date',
      submitted: submitted.completionDate,
      awarded: awarded.completionDate,
      severity: 'CRITICAL',
      detail:
        days < 0
          ? `${Math.abs(days)} days earlier than the programme the price was built on. The price assumed the longer period.`
          : `${days} days later than bid. Preliminaries were priced against the shorter period.`,
    });
  }

  if (
    awarded.commencementDate !== undefined &&
    submitted.commencementDate &&
    awarded.commencementDate !== submitted.commencementDate
  ) {
    departures.push({
      field: 'Commencement date',
      submitted: submitted.commencementDate,
      awarded: awarded.commencementDate,
      severity: 'MAJOR',
      detail: 'The start has moved. Resource, long leads and inflation were all priced from the bid start.',
    });
  }

  const numeric: Array<{ key: keyof AwardedTerms; field: string; unit: string; severity: Departure['severity']; worse: 'HIGHER' | 'LOWER' }> = [
    { key: 'liquidatedDamagesPerDayMinor', field: 'Liquidated damages', unit: 'per day', severity: 'CRITICAL', worse: 'HIGHER' },
    { key: 'ldCapPercent', field: 'Damages cap', unit: '%', severity: 'CRITICAL', worse: 'HIGHER' },
    { key: 'retentionPercent', field: 'Retention', unit: '%', severity: 'MAJOR', worse: 'HIGHER' },
    { key: 'defectsLiabilityMonths', field: 'Defects liability', unit: ' months', severity: 'MAJOR', worse: 'HIGHER' },
  ];

  for (const term of numeric) {
    const awardedValue = awarded[term.key] as number | undefined;
    const submittedValue = submitted[term.key as keyof typeof submitted] as number | undefined;
    if (awardedValue === undefined || submittedValue === undefined || awardedValue === submittedValue) continue;

    const worse = term.worse === 'HIGHER' ? awardedValue > submittedValue : awardedValue < submittedValue;
    const render = (value: number): string =>
      term.key === 'liquidatedDamagesPerDayMinor' ? `${money(value)} ${term.unit}` : `${value}${term.unit}`;

    departures.push({
      field: term.field,
      submitted: render(submittedValue),
      awarded: render(awardedValue),
      severity: term.severity,
      detail: worse
        ? `Harder than the terms the price was given on. The bid carried the risk at ${render(submittedValue)}, and it now carries it at ${render(awardedValue)}.`
        : `Different from the terms bid, in our favour. Still a departure, because the contract does not say what the submission said.`,
    });
  }

  // A qualification the price depended on, struck out without anybody noticing,
  // is the single most expensive thing on this list.
  if (awarded.acceptedQualifications !== undefined) {
    const accepted = new Set(awarded.acceptedQualifications);
    for (const qualification of submitted.qualifications) {
      if (accepted.has(qualification)) continue;
      departures.push({
        field: 'Qualification struck out',
        submitted: qualification,
        awarded: 'Not accepted',
        severity: 'CRITICAL',
        detail:
          'The price was given on this basis and the award does not carry it. Whatever it excluded is now inside the contract sum.',
      });
    }
  }

  return departures;
}

/**
 * Record the client's award, and compute what departs from the bid.
 *
 * The departures are computed here rather than supplied, because a departure
 * somebody typed in is a departure somebody noticed. The whole value is in the
 * ones nobody noticed.
 */
export function recordAward(
  ctx: EngineContext,
  packId: string,
  input: {
    outcome: AwardOutcome;
    /** The client's letter, award notice or standstill notification. */
    reference: string;
    receivedOn: string;
    terms?: AwardedTerms;
    /** For a loss: who won and at what, where the buyer disclosed it. */
    winner?: { name?: string; sumMinor?: number };
    notes?: string;
    evidenceHash?: string;
  },
): { outcome: AwardOutcome; departures: Departure[] } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const pack = requirePack(ctx, packId);

  if (!pack.state.submission) {
    throw new DomainError(
      'NOT_SUBMITTED',
      'An award cannot be recorded against a pack that was never submitted. Record the submission and its receipt first.',
    );
  }
  if (pack.state.award) {
    throw new DomainError('ALREADY_AWARDED', 'This pack already carries an award outcome');
  }
  if (input.outcome === 'WON' && !input.terms) {
    throw new DomainError(
      'AWARDED_TERMS_REQUIRED',
      'A win has to record the terms awarded, or nothing can compare them against what was bid — which is the only moment that comparison is cheap.',
    );
  }

  const assembly = (pack.state.assembly ?? {}) as {
    estimateTotalMinor?: number;
    qualifications?: string[];
    commencementDate?: string;
    completionDate?: string;
  };
  const submittedTerms = (pack.state.submittedTerms ?? {}) as Record<string, number | string | undefined>;

  const departures =
    input.outcome === 'WON'
      ? departuresBetween(
          {
            contractSumMinor: Number(assembly.estimateTotalMinor ?? 0),
            qualifications: assembly.qualifications ?? [],
            commencementDate: submittedTerms.commencementDate as string | undefined,
            completionDate: submittedTerms.completionDate as string | undefined,
            liquidatedDamagesPerDayMinor: submittedTerms.liquidatedDamagesPerDayMinor as number | undefined,
            ldCapPercent: submittedTerms.ldCapPercent as number | undefined,
            retentionPercent: submittedTerms.retentionPercent as number | undefined,
            defectsLiabilityMonths: submittedTerms.defectsLiabilityMonths as number | undefined,
          },
          input.terms!,
        )
      : [];

  const evidenceRefs = input.evidenceHash
    ? [
        registerEvidence(ctx, {
          type: 'AWARD_NOTIFICATION',
          hash: input.evidenceHash,
          description: `${input.outcome} — ${input.reference}`,
          linkedEntities: [{ refType: 'BidSubmissionPack', refId: packId }],
        }),
      ]
    : [];

  write(ctx, {
    eventType: 'AWARD_RECEIVED',
    entity: { refType: 'BidSubmissionPack', refId: packId },
    nextState: {
      ...pack.state,
      status: input.outcome === 'WON' ? 'AWARDED' : input.outcome,
      award: {
        outcome: input.outcome,
        reference: input.reference,
        receivedOn: input.receivedOn,
        terms: input.terms,
        // A loss is the only thing that pays for a losing bid. Kept whatever
        // the outcome, because the register is read across jobs.
        winner: input.winner,
        notes: input.notes,
        recordedAt: new Date().toISOString(),
        recordedBy: ctx.auth.actorId,
      },
      departures: departures.map((departure, index) => ({
        ...departure,
        id: `DEP-${String(index + 1).padStart(2, '0')}`,
        status: 'OPEN' as const,
      })),
    },
    evidenceRefs,
  });

  // One event per departure would put the same information on the thread twice.
  // A single event saying how many there are, and what they are, is what a
  // reader needs — and it is the one an alert is raised from.
  if (departures.length > 0) {
    write(ctx, {
      eventType: 'AWARD_DEPARTURE_IDENTIFIED',
      entity: { refType: 'BidSubmissionPack', refId: packId },
      nextState: {
        ...ctx.ledger.require({ refType: 'BidSubmissionPack', refId: packId }).state,
        departuresOutstanding: departures.length,
      },
    });
  }

  return { outcome: input.outcome, departures };
}

/**
 * Accept a departure, with the reason it is acceptable.
 *
 * Not "close" and not "resolve": a departure is not made to go away, it is
 * taken on knowingly by somebody with the authority to take it on. The record
 * says who, and on what basis, because the question a year later is never
 * whether the sum differed — it is who agreed that it could.
 */
export function acceptDeparture(
  ctx: EngineContext,
  packId: string,
  departureId: string,
  reason: string,
): { accepted: string; outstanding: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const pack = requirePack(ctx, packId);
  const departures = (pack.state.departures as Array<Departure & { id: string; status: string }>) ?? [];
  const departure = departures.find((d) => d.id === departureId);

  if (!departure) throw new DomainError('DEPARTURE_NOT_FOUND', `No departure ${departureId} on this award`, 404);
  if (departure.status !== 'OPEN') throw new DomainError('DEPARTURE_NOT_OPEN', `${departureId} is already ${departure.status.toLowerCase()}`);
  if (reason.trim().length < 15) {
    throw new DomainError(
      'ACCEPTANCE_REASON_REQUIRED',
      'Say why the departure is acceptable. This is the sentence that answers "who agreed to this" when the job is losing money on it.',
    );
  }

  const updated = departures.map((d) =>
    d.id === departureId
      ? { ...d, status: 'ACCEPTED', acceptedReason: reason.trim(), acceptedBy: ctx.auth.actorId, acceptedAt: new Date().toISOString() }
      : d,
  );
  const outstanding = updated.filter((d) => d.status === 'OPEN').length;

  write(ctx, {
    eventType: 'AWARD_DEPARTURE_IDENTIFIED',
    entity: { refType: 'BidSubmissionPack', refId: packId },
    nextState: { ...pack.state, departures: updated, departuresOutstanding: outstanding },
  });

  return { accepted: departureId, outstanding };
}

// --- Conversion --------------------------------------------------------------

export type ConversionResult = {
  budgetId: string;
  budgetTotalMinor: number;
  contractSumMinor: number;
  buyoutTargets: Array<{ costCode: string; description: string; targetMinor: number }>;
};

/**
 * Turn the awarded submission into the budget and the buyout targets.
 *
 * `AC-T-WF-08-02`: the contract sum, the budget and the buyout targets all
 * reconcile to the awarded submission **without re-entry**. So none of the three
 * is typed here. The cost breakdown comes off the estimate the pack was
 * compiled from, the sum comes off the award, and the buyout target for each
 * package is the estimate figure — which is the number the commercial team is
 * held to, and the only one that makes "bought below the estimate" mean
 * anything.
 *
 * `AC-T-WF-08-03`: refused while a departure is neither accepted nor resolved.
 * The whole reason to compare the award against the bid is to do something
 * about it before the money starts moving, and a conversion that proceeds over
 * an open departure has thrown the comparison away.
 */
export function convertAward(
  ctx: EngineContext,
  packId: string,
  input: { budgetVersion: string; contingencyMinor: number; managementReserveMinor: number; tenderMarginPercent: number },
): ConversionResult {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });
  // Two authorities, checked here rather than discovered halfway through.
  // Converting approves a cost baseline, and approving one is a commercial
  // authority in its own right — a project manager can accept an award and
  // still not be the person who sets the budget the job is measured against.
  // Asserting it up front means the refusal arrives before anything is written
  // rather than after the departures have been read.
  authorise(ctx, 'BUDGET_COST', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const pack = requirePack(ctx, packId);
  const award = pack.state.award as { outcome?: AwardOutcome; terms?: AwardedTerms } | undefined;

  if (!award) throw new DomainError('NOT_AWARDED', 'Nothing has been awarded against this pack');
  if (award.outcome !== 'WON') {
    throw new DomainError(
      'NOT_WON',
      `This bid was recorded as ${String(award.outcome).toLowerCase()}. Only a win converts, and the market data on a loss stays searchable either way.`,
    );
  }

  const departures = (pack.state.departures as Array<Departure & { id: string; status: string }>) ?? [];
  const open = departures.filter((d) => d.status === 'OPEN');
  if (open.length > 0) {
    throw new DomainError(
      'DEPARTURES_OUTSTANDING',
      `${open.length} departure${open.length === 1 ? '' : 's'} between the award and the bid ${open.length === 1 ? 'is' : 'are'} still open: ` +
        `${open.map((d) => `${d.id} ${d.field}`).join(', ')}. Accept them with a reason, or resolve them with the client, before the money starts moving.`,
    );
  }

  const estimateId = pack.state.estimateId as string | undefined;
  if (!estimateId) {
    throw new DomainError('NO_ESTIMATE', 'The pack does not name the estimate it was compiled from, so nothing can be carried forward');
  }
  const estimate = ctx.ledger.require({ refType: 'Estimate', refId: estimateId });

  // The cost breakdown, read off the estimate rather than re-entered. This is
  // the join `AC-T-WF-08-02` is about: a budget typed in from a spreadsheet is
  // a budget that agrees with the tender until the first person makes a typo.
  //
  // The estimate's own twenty cost heads become the budget's cost codes, which
  // is what makes the two reconcile by construction rather than by somebody
  // checking. A head the estimator excluded carries no money and no budget
  // line — a zero-value code in the budget reads as "priced at nothing", which
  // is a different statement from "not in this contract".
  const heads = (estimate.state.heads ?? []) as Array<{
    head: string;
    label: string;
    amountMinor: number;
    status: string;
  }>;

  const priced = heads.filter((head) => head.status === 'PRICED' && head.amountMinor > 0);
  if (priced.length === 0) {
    throw new DomainError(
      'ESTIMATE_HAS_NO_BREAKDOWN',
      'The estimate carries no priced cost heads, so a budget built from it would be a single number with nothing behind it',
    );
  }

  const byCostCode = priced.map((head) => ({
    costCode: head.head,
    description: head.label,
    budgetMinor: head.amountMinor,
  }));

  const { budgetId, totalMinor } = approveBudget(ctx, {
    version: input.budgetVersion,
    byCostCode,
    contingencyMinor: input.contingencyMinor,
    managementReserveMinor: input.managementReserveMinor,
    tenderMarginPercent: input.tenderMarginPercent,
  });

  // The buyout target is the estimate figure, not the budget figure. Budget
  // carries contingency and reserve; a package bought at budget has spent the
  // contingency for it, which is exactly the drift this number exists to catch.
  const buyoutTargets = byCostCode.map((line) => ({
    costCode: line.costCode,
    description: line.description,
    targetMinor: line.budgetMinor,
  }));

  const contractSumMinor = Number(award.terms?.contractSumMinor ?? (pack.state.assembly as { estimateTotalMinor?: number })?.estimateTotalMinor ?? 0);

  const evidence = registerEvidence(ctx, {
    type: 'AWARD_CONVERSION',
    hash: hashEvidence(JSON.stringify({ packId, contractSumMinor, byCostCode, buyoutTargets })),
    description: `Award converted: budget ${input.budgetVersion} and ${buyoutTargets.length} buyout targets from pack ${String(pack.state.contentHash)}`,
    linkedEntities: [
      { refType: 'BidSubmissionPack', refId: packId },
      { refType: 'Budget', refId: budgetId },
    ],
  });

  write(ctx, {
    eventType: 'BID_CONVERTED_TO_CONTRACT',
    entity: { refType: 'BidSubmissionPack', refId: packId },
    nextState: {
      ...ctx.ledger.require({ refType: 'BidSubmissionPack', refId: packId }).state,
      status: 'CONVERTED',
      conversion: {
        budgetId,
        budgetTotalMinor: totalMinor,
        contractSumMinor,
        buyoutTargets,
        convertedAt: new Date().toISOString(),
        convertedBy: ctx.auth.actorId,
      },
    },
    evidenceRefs: [evidence],
  });

  return { budgetId, budgetTotalMinor: totalMinor, contractSumMinor, buyoutTargets };
}

// --- The position ------------------------------------------------------------

export type AwardPosition = {
  packs: Array<{
    packId: string;
    contentHash: string;
    status: string;
    submitted?: { reference: string; receivedAt: string; hashMatches: boolean };
    outcome?: AwardOutcome;
    departures: Array<Departure & { id: string; status: string }>;
    departuresOutstanding: number;
    converted: boolean;
    contractSumMinor?: number;
  }>;
  summary: string;
};

export function awardPosition(ctx: EngineContext): AwardPosition {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const packs = ctx.ledger.list(ctx.projectId, 'BidSubmissionPack').map((record) => {
    const state = record.state;
    const submission = state.submission as (SubmissionReceipt & { submittedPackHash?: string }) | undefined;
    const award = state.award as { outcome?: AwardOutcome; terms?: AwardedTerms } | undefined;
    const departures = (state.departures as Array<Departure & { id: string; status: string }>) ?? [];

    return {
      packId: String(state.id),
      contentHash: String(state.contentHash),
      status: String(state.status),
      submitted: submission
        ? {
            reference: submission.reference,
            receivedAt: submission.receivedAt,
            // The check `AC-T-WF-08-01` exists for: the receipt names a hash,
            // and that hash is still the pack's. A false here means the pack
            // was re-locked after it was submitted, and the receipt proves the
            // arrival of something other than what is now on the record.
            hashMatches: submission.submittedPackHash === String(state.contentHash),
          }
        : undefined,
      outcome: award?.outcome,
      departures,
      departuresOutstanding: departures.filter((d) => d.status === 'OPEN').length,
      converted: state.status === 'CONVERTED',
      contractSumMinor: award?.terms?.contractSumMinor,
    };
  });

  const outstanding = packs.reduce((sum, p) => sum + p.departuresOutstanding, 0);
  const mismatched = packs.filter((p) => p.submitted && !p.submitted.hashMatches).length;

  const parts = [`${packs.length} submission pack${packs.length === 1 ? '' : 's'}`];
  const won = packs.filter((p) => p.outcome === 'WON').length;
  const lost = packs.filter((p) => p.outcome === 'LOST').length;
  if (won > 0 || lost > 0) parts.push(`${won} won, ${lost} lost`);
  if (outstanding > 0) parts.push(`${outstanding} award departure${outstanding === 1 ? '' : 's'} still open`);
  if (mismatched > 0) parts.push(`${mismatched} receipt${mismatched === 1 ? '' : 's'} naming a pack hash that has since changed`);
  if (parts.length === 1) parts.push('nothing outstanding');

  return { packs, summary: `${parts.join(', ')}.` };
}
