import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import type { EntityRef } from '../goldenthread/types.ts';

/**
 * The settlement meeting — T-WF-07.
 *
 * Called *commercial adjudication* in the specification, and named settlement
 * here for one reason: `adjudicate` in the tender engine already means choosing
 * a subcontractor from an evaluation, and two different acts sharing a word in
 * one codebase is how somebody eventually calls the wrong one. Settlement is
 * what the industry calls this meeting anyway.
 *
 * It is the last two hours before a bid goes out, and it is where the price
 * stops being the estimate and starts being a decision. Somebody takes £180,000
 * out of the preliminaries. Somebody puts the margin up half a point. Somebody
 * says the piling risk is covered and takes the allowance out. All of it is
 * right or wrong on the day, and none of it is written down — so when the job
 * is losing money eighteen months later, the estimate is what gets examined and
 * the estimate is not what was bid.
 *
 * ---
 *
 * **The bridge has to reconcile exactly.** `AC-T-WF-07-01`: the pre-settlement
 * snapshot, plus every adjustment, equals the post-settlement price. Not
 * approximately — exactly, to the penny. An adjustment nobody recorded is the
 * difference between two numbers that should be the same, and this refuses to
 * approve until they are.
 *
 * **Every adjustment carries a reason and an owner.** A line saying "-£180,000"
 * is a hole in the price. A line saying "-£180,000, site accommodation reduced
 * to one cabin on the strength of the client's welfare offer, R. Shaw" is a
 * decision somebody can defend or reverse.
 *
 * **Evidence where evidence exists.** A supplier price, a scope correction and
 * a benchmark correction all point at a document, and they are refused without
 * one. Margin, contingency and risk allowance are judgements taken in a room —
 * demanding a file for those would produce a file attached to satisfy the
 * platform, which is worse than nothing because it looks like proof.
 *
 * **One cut-off.** `AC-T-WF-07-03`: the price, the programme, the risk and the
 * qualifications all belong to the same scope. A price settled against addendum
 * three and a programme built against addendum two produce a bid that does not
 * hang together, and nobody finds out until the first extension-of-time claim.
 *
 * **The person who set the margin does not approve it.** And nobody approves
 * above the authority they hold. Both are refusals rather than reports, because
 * a governance control that produces a warning is a governance control that
 * produces a warning.
 */

// --- The cut-off -------------------------------------------------------------

/**
 * The scope everything in this bid belongs to.
 *
 * `addendum` is the buyer's last issue that has been taken into the price —
 * absent where the invitation was never amended. `informationAt` is the moment
 * the scope was fixed: anything issued after it is not in this bid, and saying
 * so is the point.
 */
export type CutOff = {
  addendum?: string;
  informationAt: string;
};

function sameCutOff(a: CutOff, b: CutOff): boolean {
  return a.addendum === b.addendum && a.informationAt === b.informationAt;
}

function describeCutOff(cutOff: CutOff): string {
  return cutOff.addendum ? `${cutOff.addendum} at ${cutOff.informationAt}` : `information at ${cutOff.informationAt}`;
}

// --- Adjustments -------------------------------------------------------------

export const ADJUSTMENT_CATEGORY = [
  'SUPPLIER_PRICE',
  'SCOPE_CORRECTION',
  'BENCHMARK_CORRECTION',
  'RISK_ALLOWANCE',
  'CONTINGENCY',
  'INFLATION',
  'MARGIN',
  'COMMERCIAL_OPPORTUNITY',
] as const;
export type AdjustmentCategory = (typeof ADJUSTMENT_CATEGORY)[number];

/**
 * The categories that point at a document, and are refused without one.
 *
 * The others are judgements taken in the room. A platform that demanded a file
 * for a margin decision would get a file — the agenda, re-attached eight times —
 * and the register would look evidenced while proving nothing.
 */
const EVIDENCED: readonly AdjustmentCategory[] = ['SUPPLIER_PRICE', 'SCOPE_CORRECTION', 'BENCHMARK_CORRECTION'];

export function needsEvidence(category: AdjustmentCategory): boolean {
  return EVIDENCED.includes(category);
}

export type Adjustment = {
  reference: string;
  category: AdjustmentCategory;
  /** Signed. Negative takes money out of the price. */
  amountMinor: number;
  reason: string;
  /** Who took the decision. Not who typed it in. */
  owner: string;
  evidenceHash?: string;
  recordedAt: string;
  recordedBy: string;
};

// --- Actions -----------------------------------------------------------------

/**
 * Something the meeting decided somebody would do.
 *
 * `AC-T-WF-07-02` says every action is either closed or explicitly carried as a
 * submission condition. Those are the only two honest endings: it was done, or
 * it was not done and the bid says so out loud. An action still open at
 * submission is a third thing — a promise nobody kept and nobody declared — and
 * approval refuses over it.
 */
export type SettlementAction = {
  reference: string;
  description: string;
  owner: string;
  dueBy?: string;
  status: 'OPEN' | 'CLOSED' | 'CARRIED';
  /** What closed it, or the condition the submission now carries. */
  outcome?: string;
  settledAt?: string;
  settledBy?: string;
};

// --- Opening -----------------------------------------------------------------

function requireSettlement(ctx: EngineContext, settlementId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'Settlement', refId: settlementId });
  if (!record) throw new DomainError('SETTLEMENT_NOT_FOUND', `No settlement ${settlementId}`, 404);
  return record;
}

function assertOpen(record: EntityRecord): void {
  if (record.state.status === 'APPROVED') {
    throw new DomainError(
      'SETTLEMENT_APPROVED',
      'This settlement is approved. A price that moves after approval is a different price, and it needs a new settlement rather than an edit to this one.',
    );
  }
}

/**
 * Freeze the pre-settlement position and open the meeting.
 *
 * The snapshot is taken here rather than reconstructed later, because "what did
 * the estimate say before we started moving numbers" is exactly the figure that
 * cannot be recovered afterwards — the estimate has been repriced twice by then.
 */
export function openSettlement(
  ctx: EngineContext,
  input: { estimateId: string; cutOff: CutOff; agenda?: string[] },
): { settlementId: string; preSettlementMinor: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  // The shape of the request before the state of the world: a malformed cut-off
  // is a caller error and does not need a ledger lookup to diagnose.
  if (!/^\d{4}-\d{2}-\d{2}/.test(input.cutOff.informationAt)) {
    throw new DomainError('CUT_OFF_INVALID', 'The information cut-off has to be a date the whole bid can be measured against');
  }

  const estimate = ctx.ledger.require({ refType: 'Estimate', refId: input.estimateId });

  const open = ctx.ledger
    .list(ctx.projectId, 'Settlement')
    .find((record) => record.state.estimateId === input.estimateId && record.state.status === 'OPEN');
  if (open) {
    throw new DomainError(
      'SETTLEMENT_ALREADY_OPEN',
      `${String(open.state.reference)} is still open against this estimate. Two settlements on one estimate produce two prices.`,
    );
  }

  const preSettlementMinor = Number(estimate.state.totalMinor);
  const sequence = ctx.ledger.list(ctx.projectId, 'Settlement').length + 1;
  const reference = `SET-${String(sequence).padStart(3, '0')}`;
  const settlementId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'PRE_SETTLEMENT_SNAPSHOT',
    hash: hashEvidence(JSON.stringify({ estimateId: input.estimateId, preSettlementMinor, cutOff: input.cutOff })),
    description: `${reference} opened at ${preSettlementMinor} against ${describeCutOff(input.cutOff)}`,
    linkedEntities: [{ refType: 'Estimate', refId: input.estimateId }],
  });

  write(ctx, {
    eventType: 'ADJUDICATION_STARTED',
    entity: { refType: 'Settlement', refId: settlementId },
    nextState: {
      id: settlementId,
      projectId: ctx.projectId,
      reference,
      estimateId: input.estimateId,
      cutOff: input.cutOff,
      agenda: input.agenda ?? [],
      preSettlementMinor,
      adjustments: [],
      actions: [],
      status: 'OPEN',
      // The person who runs the settlement is recorded so the approval can
      // refuse to be the same person. Separation of duties at the act.
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { settlementId, preSettlementMinor };
}

// --- Adjustments -------------------------------------------------------------

export function recordAdjustment(
  ctx: EngineContext,
  settlementId: string,
  input: {
    category: AdjustmentCategory;
    amountMinor: number;
    reason: string;
    owner: string;
    evidenceHash?: string;
  },
): { reference: string; runningTotalMinor: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireSettlement(ctx, settlementId);
  assertOpen(record);

  if (input.amountMinor === 0) {
    throw new DomainError('ADJUSTMENT_ZERO', 'An adjustment of nothing is a note. Record it as an action instead.');
  }
  if (input.reason.trim().length < 20) {
    throw new DomainError(
      'ADJUSTMENT_REASON_REQUIRED',
      'Say what the adjustment is for. A line reading "-£180,000" is a hole in the price; one that says what came out of it is a decision somebody can defend or reverse.',
    );
  }
  if (!input.owner.trim()) {
    throw new DomainError('ADJUSTMENT_OWNER_REQUIRED', 'Name who took the decision. Not who typed it in.');
  }
  if (needsEvidence(input.category) && !input.evidenceHash) {
    throw new DomainError(
      'ADJUSTMENT_EVIDENCE_REQUIRED',
      `A ${input.category.toLowerCase().replace(/_/g, ' ')} adjustment points at a document — the quotation, the revised scope, the benchmark. Attach it. ` +
        'Margin, contingency and risk allowances are judgements and do not need one.',
    );
  }

  const adjustments = (record.state.adjustments as Adjustment[]) ?? [];
  const adjustment: Adjustment = {
    reference: `ADJ-${String(adjustments.length + 1).padStart(3, '0')}`,
    category: input.category,
    amountMinor: input.amountMinor,
    reason: input.reason.trim(),
    owner: input.owner.trim(),
    evidenceHash: input.evidenceHash,
    recordedAt: new Date().toISOString(),
    recordedBy: ctx.auth.actorId,
  };

  const evidenceRefs = input.evidenceHash
    ? [
        registerEvidence(ctx, {
          type: 'SETTLEMENT_ADJUSTMENT',
          hash: input.evidenceHash,
          description: `${adjustment.reference} ${input.category}: ${adjustment.reason}`,
          linkedEntities: [{ refType: 'Settlement', refId: settlementId }],
        }),
      ]
    : [];

  const next = [...adjustments, adjustment];
  const runningTotalMinor = Number(record.state.preSettlementMinor) + next.reduce((sum, a) => sum + a.amountMinor, 0);

  write(ctx, {
    eventType: 'PRICE_ADJUSTMENT_RECORDED',
    entity: { refType: 'Settlement', refId: settlementId },
    nextState: { ...record.state, adjustments: next, runningTotalMinor },
    evidenceRefs,
  });

  return { reference: adjustment.reference, runningTotalMinor };
}

// --- Actions -----------------------------------------------------------------

export function raiseAction(
  ctx: EngineContext,
  settlementId: string,
  input: { description: string; owner: string; dueBy?: string },
): { reference: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireSettlement(ctx, settlementId);
  assertOpen(record);

  if (input.description.trim().length < 10) {
    throw new DomainError('ACTION_INSUBSTANTIAL', 'Say what somebody is actually going to do');
  }
  if (!input.owner.trim()) throw new DomainError('ACTION_OWNER_REQUIRED', 'An action with no owner is a wish');

  const actions = (record.state.actions as SettlementAction[]) ?? [];
  const action: SettlementAction = {
    reference: `ACT-${String(actions.length + 1).padStart(2, '0')}`,
    description: input.description.trim(),
    owner: input.owner.trim(),
    dueBy: input.dueBy,
    status: 'OPEN',
  };

  write(ctx, {
    eventType: 'SETTLEMENT_ACTION_RECORDED',
    entity: { refType: 'Settlement', refId: settlementId },
    nextState: { ...record.state, actions: [...actions, action] },
  });

  return { reference: action.reference };
}

/**
 * Close an action, or carry it as a condition the submission declares.
 *
 * Two endings, both honest. What there is no way to record is an action that
 * simply stopped being discussed, which is what happens to most of them.
 */
export function settleAction(
  ctx: EngineContext,
  settlementId: string,
  actionReference: string,
  input: { ending: 'CLOSED' | 'CARRIED'; outcome: string },
): { reference: string; open: number } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireSettlement(ctx, settlementId);
  assertOpen(record);

  const actions = (record.state.actions as SettlementAction[]) ?? [];
  const action = actions.find((a) => a.reference === actionReference);
  if (!action) throw new DomainError('ACTION_NOT_FOUND', `No action ${actionReference} on this settlement`, 404);
  if (action.status !== 'OPEN') throw new DomainError('ACTION_NOT_OPEN', `${actionReference} is already ${action.status.toLowerCase()}`);
  if (input.outcome.trim().length < 10) {
    throw new DomainError(
      'ACTION_OUTCOME_REQUIRED',
      input.ending === 'CARRIED'
        ? 'A carried action becomes a condition on the submission, so say what the condition is — the client is going to read it.'
        : 'Say what closed it.',
    );
  }

  const next = actions.map((a) =>
    a.reference === actionReference
      ? { ...a, status: input.ending, outcome: input.outcome.trim(), settledAt: new Date().toISOString(), settledBy: ctx.auth.actorId }
      : a,
  );

  write(ctx, {
    eventType: 'SETTLEMENT_ACTION_RECORDED',
    entity: { refType: 'Settlement', refId: settlementId },
    nextState: { ...record.state, actions: next },
  });

  return { reference: actionReference, open: next.filter((a) => a.status === 'OPEN').length };
}

// --- The programme -----------------------------------------------------------

/**
 * Approve the programme the price was built on, at the price's own cut-off.
 *
 * The cut-off is passed rather than assumed, so a programme prepared against an
 * earlier issue is caught here instead of at the first extension-of-time claim.
 */
export function approveBidProgramme(
  ctx: EngineContext,
  settlementId: string,
  input: { programmeRef: EntityRef; cutOff: CutOff; durationWeeks: number; note?: string },
): { aligned: true } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireSettlement(ctx, settlementId);
  assertOpen(record);

  const priceCutOff = record.state.cutOff as CutOff;
  if (!sameCutOff(priceCutOff, input.cutOff)) {
    throw new DomainError(
      'CUT_OFF_MISMATCH',
      `The price was settled against ${describeCutOff(priceCutOff)} and this programme was built against ${describeCutOff(input.cutOff)}. ` +
        'A bid whose price and programme belong to different scopes does not hang together, and nobody finds out until the first delay.',
    );
  }
  if (input.durationWeeks <= 0) {
    throw new DomainError('DURATION_INVALID', 'A programme of no weeks is not a programme');
  }

  write(ctx, {
    eventType: 'BID_PROGRAMME_APPROVED',
    entity: { refType: 'Settlement', refId: settlementId },
    nextState: {
      ...record.state,
      programme: {
        ref: input.programmeRef,
        cutOff: input.cutOff,
        durationWeeks: input.durationWeeks,
        note: input.note,
        approvedAt: new Date().toISOString(),
        approvedBy: ctx.auth.actorId,
      },
    },
  });

  return { aligned: true };
}

// --- Approval ----------------------------------------------------------------

export type ApprovalAuthority = {
  /** The person or office the authority sits with. */
  delegatedTo: string;
  /** The ceiling that authority carries. */
  limitMinor: number;
  /** The scheme of delegation it comes from. */
  reference?: string;
};

export type SettlementBridge = {
  preSettlementMinor: number;
  adjustments: Adjustment[];
  adjustmentTotalMinor: number;
  postSettlementMinor: number;
  reconciles: boolean;
};

/**
 * The bridge, computed from the record.
 *
 * `AC-T-WF-07-01` asks the pre and post snapshots and the adjustment bridge to
 * reconcile *exactly*. Computed rather than stored so it cannot drift from the
 * adjustments it is supposed to be the sum of.
 */
export function bridgeOf(record: EntityRecord): SettlementBridge {
  const preSettlementMinor = Number(record.state.preSettlementMinor);
  const adjustments = (record.state.adjustments as Adjustment[]) ?? [];
  const adjustmentTotalMinor = adjustments.reduce((sum, a) => sum + a.amountMinor, 0);
  const postSettlementMinor = preSettlementMinor + adjustmentTotalMinor;

  return {
    preSettlementMinor,
    adjustments,
    adjustmentTotalMinor,
    postSettlementMinor,
    reconciles: preSettlementMinor + adjustmentTotalMinor === postSettlementMinor,
  };
}

const money = (minor: number): string => `£${(minor / 100).toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;

/**
 * Approve the settled price.
 *
 * Five refusals, and every one of them is a control that produces a refusal
 * rather than a warning:
 *
 *   - the bridge must reconcile to the penny against the price being approved;
 *   - every action is closed or carried;
 *   - the programme is approved, at the same cut-off as the price;
 *   - nobody approves above the authority they hold;
 *   - the person who ran the settlement does not approve it.
 */
export function approveSettlement(
  ctx: EngineContext,
  settlementId: string,
  input: { finalPriceMinor: number; authority: ApprovalAuthority; summary: string },
): { postSettlementMinor: number; conditions: string[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireSettlement(ctx, settlementId);
  assertOpen(record);

  if (record.state.openedBy === ctx.auth.actorId) {
    throw new DomainError(
      'SELF_APPROVAL_REFUSED',
      'The person who ran the settlement cannot approve it. Somebody who was not moving the numbers has to look at where they ended up.',
    );
  }

  const bridge = bridgeOf(record);
  if (bridge.postSettlementMinor !== input.finalPriceMinor) {
    const difference = input.finalPriceMinor - bridge.postSettlementMinor;
    throw new DomainError(
      'BRIDGE_DOES_NOT_RECONCILE',
      `The price being approved is ${money(input.finalPriceMinor)} and the bridge comes to ${money(bridge.postSettlementMinor)} — ` +
        `${money(Math.abs(difference))} ${difference > 0 ? 'more' : 'less'}. ` +
        `${money(bridge.preSettlementMinor)} plus ${bridge.adjustments.length} adjustment${bridge.adjustments.length === 1 ? '' : 's'} ` +
        `totalling ${money(bridge.adjustmentTotalMinor)}. The difference is an adjustment nobody recorded.`,
    );
  }

  const actions = (record.state.actions as SettlementAction[]) ?? [];
  const open = actions.filter((a) => a.status === 'OPEN');
  if (open.length > 0) {
    throw new DomainError(
      'ACTIONS_OPEN',
      `${open.length} action${open.length === 1 ? '' : 's'} still open: ${open.map((a) => `${a.reference} (${a.owner})`).join(', ')}. ` +
        'Close them, or carry them as conditions the submission declares. An action that simply stopped being discussed is neither.',
    );
  }

  const programme = record.state.programme as { cutOff: CutOff } | undefined;
  if (!programme) {
    throw new DomainError(
      'PROGRAMME_NOT_APPROVED',
      'The programme has not been approved. A price approved without one is a number with no delivery behind it.',
    );
  }
  if (!sameCutOff(record.state.cutOff as CutOff, programme.cutOff)) {
    throw new DomainError('CUT_OFF_MISMATCH', 'The approved programme belongs to a different cut-off from the price');
  }

  if (input.finalPriceMinor > input.authority.limitMinor) {
    throw new DomainError(
      'ABOVE_AUTHORITY',
      `${input.authority.delegatedTo} holds ${money(input.authority.limitMinor)}, and this bid is ${money(input.finalPriceMinor)}. ` +
        'It has to go to somebody who holds the value.',
    );
  }
  if (input.summary.trim().length < 20) {
    throw new DomainError('SUMMARY_REQUIRED', 'The approval carries a summary of what was decided and why');
  }

  const conditions = actions.filter((a) => a.status === 'CARRIED').map((a) => a.outcome ?? a.description);

  const evidence = registerEvidence(ctx, {
    type: 'POST_SETTLEMENT_SNAPSHOT',
    hash: hashEvidence(
      JSON.stringify({
        settlementId,
        pre: bridge.preSettlementMinor,
        adjustments: bridge.adjustments,
        post: bridge.postSettlementMinor,
        cutOff: record.state.cutOff,
      }),
    ),
    description: `${String(record.state.reference)} approved at ${money(input.finalPriceMinor)} by ${input.authority.delegatedTo}`,
    linkedEntities: [{ refType: 'Settlement', refId: settlementId }],
  });

  write(ctx, {
    eventType: 'ADJUDICATION_APPROVED',
    entity: { refType: 'Settlement', refId: settlementId },
    nextState: {
      ...record.state,
      status: 'APPROVED',
      postSettlementMinor: bridge.postSettlementMinor,
      finalPriceMinor: input.finalPriceMinor,
      // The conditions the submission now has to declare. `AC-T-WF-07-02`'s
      // second ending, carried onto the bid rather than left in the minutes.
      conditions,
      authority: input.authority,
      summary: input.summary.trim(),
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { postSettlementMinor: bridge.postSettlementMinor, conditions };
}

// --- The position ------------------------------------------------------------

export type SettlementPosition = {
  settlements: Array<{
    settlementId: string;
    reference: string;
    status: string;
    cutOff: CutOff;
    bridge: SettlementBridge;
    byCategory: Array<{ category: AdjustmentCategory; countOfAdjustments: number; totalMinor: number }>;
    unevidenced: number;
    actions: { open: number; closed: number; carried: number };
    programmeAligned: boolean | null;
    conditions: string[];
    finalPriceMinor?: number;
  }>;
  summary: string;
};

export function settlementPosition(ctx: EngineContext): SettlementPosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const settlements = ctx.ledger.list(ctx.projectId, 'Settlement').map((record) => {
    const bridge = bridgeOf(record);
    const actions = (record.state.actions as SettlementAction[]) ?? [];
    const programme = record.state.programme as { cutOff: CutOff } | undefined;
    const cutOff = record.state.cutOff as CutOff;

    const byCategory = ADJUSTMENT_CATEGORY.map((category) => {
      const matching = bridge.adjustments.filter((a) => a.category === category);
      return {
        category,
        countOfAdjustments: matching.length,
        totalMinor: matching.reduce((sum, a) => sum + a.amountMinor, 0),
      };
    }).filter((row) => row.countOfAdjustments > 0);

    return {
      settlementId: String(record.state.id),
      reference: String(record.state.reference),
      status: String(record.state.status),
      cutOff,
      bridge,
      byCategory,
      // Adjustments in an evidenced category that somehow carry none. Zero by
      // construction today; reported so that stays true if the rule is relaxed.
      unevidenced: bridge.adjustments.filter((a) => needsEvidence(a.category) && !a.evidenceHash).length,
      actions: {
        open: actions.filter((a) => a.status === 'OPEN').length,
        closed: actions.filter((a) => a.status === 'CLOSED').length,
        carried: actions.filter((a) => a.status === 'CARRIED').length,
      },
      programmeAligned: programme ? sameCutOff(cutOff, programme.cutOff) : null,
      conditions: (record.state.conditions as string[]) ?? [],
      finalPriceMinor: record.state.finalPriceMinor as number | undefined,
    };
  });

  const openSettlements = settlements.filter((s) => s.status === 'OPEN');
  const openActions = settlements.reduce((sum, s) => sum + s.actions.open, 0);
  const carried = settlements.reduce((sum, s) => sum + s.actions.carried, 0);

  const parts = [`${settlements.length} settlement${settlements.length === 1 ? '' : 's'}`];
  if (openSettlements.length > 0) parts.push(`${openSettlements.length} still open`);
  if (openActions > 0) parts.push(`${openActions} action${openActions === 1 ? '' : 's'} to close or carry`);
  if (carried > 0) parts.push(`${carried} condition${carried === 1 ? '' : 's'} on the submission`);
  if (parts.length === 1) parts.push('nothing outstanding');

  return { settlements, summary: `${parts.join(', ')}.` };
}
