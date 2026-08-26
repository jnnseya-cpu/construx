import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as settlement from '../src/domain/settlement.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The settlement meeting — the last two hours before a bid goes out.
 *
 * Somebody takes £180,000 out of the preliminaries. Somebody puts the margin up
 * half a point. Somebody says the piling risk is covered and takes the allowance
 * out. All of it is right or wrong on the day, and none of it is written down —
 * so when the job is losing money eighteen months later, the estimate is what
 * gets examined and the estimate is not what was bid.
 *
 * These tests are about the five things that have to refuse rather than warn:
 * a bridge that does not reconcile to the penny, an action that simply stopped
 * being discussed, a programme belonging to a different cut-off from the price,
 * an approval above the authority held, and the person who moved the numbers
 * approving where they ended up.
 */

let platform: Platform;
let seed: SeedResult;
let estimateId: string;
let preSettlementMinor: number;

/** Runs the meeting. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Approves it — and is not the person who ran it. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });

const CUT_OFF: settlement.CutOff = { addendum: 'ADD-03', informationAt: '2027-03-05' };
const QUOTE = `sha256:${'e'.repeat(64)}`;

const AUTHORITY: settlement.ApprovalAuthority = {
  delegatedTo: 'Commercial Director',
  limitMinor: 25_000_000_00,
  reference: 'Scheme of delegation, section 6',
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // `ESTIMATE_TENDER` writes are gated to CONCEPT, DESIGN and TENDER, which is
  // right: settling a price on a job in operations is a process error. The
  // demonstration finishes in OPERATIONS, so the fixture moves it back through
  // the platform's own governed regression rather than around the gate.
  structure.transitionPhase(asOwner(), {
    to: 'TENDER',
    justification: 'Reopened to settle the tender price against the bid this project was won on',
  });

  const estimate = platform.ledger.list(seed.projectId, 'Estimate')[0];
  assert.ok(estimate, 'the seeded project no longer builds an estimate');
  estimateId = estimate.refId;
  preSettlementMinor = Number(estimate.state.totalMinor);
});

/** A fresh settlement, so a test can break exactly one thing. */
function open(): string {
  return settlement.openSettlement(asQS(), { estimateId, cutOff: CUT_OFF }).settlementId;
}

// ── Opening ────────────────────────────────────────────────────────────────

describe('settlement · freezing where the price started', () => {
  it('takes the pre-settlement snapshot off the estimate', () => {
    const { settlementId, preSettlementMinor: snapshot } = settlement.openSettlement(asQS(), {
      estimateId,
      cutOff: CUT_OFF,
      agenda: ['Preliminaries coverage', 'Piling risk allowance', 'Margin'],
    });

    assert.ok(settlementId);
    assert.equal(snapshot, preSettlementMinor);

    const position = settlement.settlementPosition(asQS());
    const row = position.settlements.find((s) => s.settlementId === settlementId)!;
    assert.equal(row.status, 'OPEN');
    assert.equal(row.bridge.preSettlementMinor, preSettlementMinor);
    assert.equal(row.bridge.postSettlementMinor, preSettlementMinor, 'nothing has moved yet');
    assert.deepEqual(row.cutOff, CUT_OFF);
  });

  it('refuses a second settlement on the same estimate', () => {
    const error = throwsCode(() => open(), 'SETTLEMENT_ALREADY_OPEN');
    assert.match(String(error.message), /Two settlements on one estimate produce two prices/);
  });

  it('refuses a cut-off it cannot measure the bid against', () => {
    throwsCode(
      () =>
        settlement.openSettlement(asQS(), {
          estimateId: 'other',
          cutOff: { informationAt: 'before the site visit' },
        }),
      'CUT_OFF_INVALID',
    );
  });
});

// ── Adjustments ────────────────────────────────────────────────────────────

describe('settlement · every adjustment carries a reason and an owner', () => {
  let settlementId: string;

  before(() => {
    settlementId = platform.ledger.list(seed.projectId, 'Settlement')[0]!.refId;
  });

  it('refuses a line with no reason behind it', () => {
    const error = throwsCode(
      () =>
        settlement.recordAdjustment(asQS(), settlementId, {
          category: 'MARGIN',
          amountMinor: -180_000_00,
          reason: 'Prelims',
          owner: 'R. Shaw',
        }),
      'ADJUSTMENT_REASON_REQUIRED',
    );
    assert.match(String(error.message), /a hole in the price/);
  });

  it('refuses a line with nobody behind it', () => {
    throwsCode(
      () =>
        settlement.recordAdjustment(asQS(), settlementId, {
          category: 'MARGIN',
          amountMinor: 40_000_00,
          reason: 'Margin raised half a point on the strength of the client relationship',
          owner: '  ',
        }),
      'ADJUSTMENT_OWNER_REQUIRED',
    );
  });

  it('refuses an adjustment of nothing', () => {
    throwsCode(
      () =>
        settlement.recordAdjustment(asQS(), settlementId, {
          category: 'MARGIN',
          amountMinor: 0,
          reason: 'Nothing changed but we discussed it at some length in the meeting',
          owner: 'R. Shaw',
        }),
      'ADJUSTMENT_ZERO',
    );
  });

  /**
   * A supplier price points at a quotation. A margin decision points at a room.
   * Demanding a file for the second would produce a file attached to satisfy
   * the platform, which is worse than nothing because it looks like proof.
   */
  it('demands evidence where a document exists, and not where one does not', () => {
    throwsCode(
      () =>
        settlement.recordAdjustment(asQS(), settlementId, {
          category: 'SUPPLIER_PRICE',
          amountMinor: -212_000_00,
          reason: 'Groundworks re-let to Hallam at their revised quotation of 5 March',
          owner: 'R. Shaw',
        }),
      'ADJUSTMENT_EVIDENCE_REQUIRED',
    );

    const withQuote = settlement.recordAdjustment(asQS(), settlementId, {
      category: 'SUPPLIER_PRICE',
      amountMinor: -212_000_00,
      reason: 'Groundworks re-let to Hallam at their revised quotation of 5 March',
      owner: 'R. Shaw',
      evidenceHash: QUOTE,
    });
    assert.equal(withQuote.reference, 'ADJ-001');

    // A judgement taken in the room needs the reason, not a file.
    const judgement = settlement.recordAdjustment(asQS(), settlementId, {
      category: 'RISK_ALLOWANCE',
      amountMinor: -95_000_00,
      reason: 'Piling risk allowance released — the ground investigation confirms no obstructions above 4m',
      owner: 'A. Whitfield',
    });
    assert.equal(judgement.reference, 'ADJ-002');
    assert.equal(judgement.runningTotalMinor, preSettlementMinor - 212_000_00 - 95_000_00);
  });

  it('checks which categories need a document without needing a settlement', () => {
    assert.equal(settlement.needsEvidence('SUPPLIER_PRICE'), true);
    assert.equal(settlement.needsEvidence('SCOPE_CORRECTION'), true);
    assert.equal(settlement.needsEvidence('BENCHMARK_CORRECTION'), true);
    assert.equal(settlement.needsEvidence('MARGIN'), false);
    assert.equal(settlement.needsEvidence('CONTINGENCY'), false);
    assert.equal(settlement.needsEvidence('RISK_ALLOWANCE'), false);
  });

  it('groups the bridge by category, and reports nothing unevidenced', () => {
    const row = settlement.settlementPosition(asQS()).settlements.find((s) => s.settlementId === settlementId)!;

    const supplier = row.byCategory.find((c) => c.category === 'SUPPLIER_PRICE')!;
    assert.equal(supplier.countOfAdjustments, 1);
    assert.equal(supplier.totalMinor, -212_000_00);
    assert.equal(row.unevidenced, 0);
    assert.equal(row.bridge.adjustmentTotalMinor, -307_000_00);
  });
});

// ── Actions ────────────────────────────────────────────────────────────────

describe('settlement · an action is closed or carried, never abandoned', () => {
  let settlementId: string;

  before(() => {
    settlementId = platform.ledger.list(seed.projectId, 'Settlement')[0]!.refId;
  });

  it('refuses an action nobody owns, and one that says nothing', () => {
    throwsCode(
      () => settlement.raiseAction(asQS(), settlementId, { description: 'Check', owner: 'R. Shaw' }),
      'ACTION_INSUBSTANTIAL',
    );
    throwsCode(
      () =>
        settlement.raiseAction(asQS(), settlementId, {
          description: 'Confirm the temporary works design fee with Corbett',
          owner: '',
        }),
      'ACTION_OWNER_REQUIRED',
    );
  });

  it('closes one with what closed it, and carries one as a condition', () => {
    const first = settlement.raiseAction(asQS(), settlementId, {
      description: 'Confirm the temporary works design fee with Corbett before the return',
      owner: 'A. Whitfield',
      dueBy: '2027-03-10',
    });
    const second = settlement.raiseAction(asQS(), settlementId, {
      description: 'Establish whether the client will fund the diversion of the 11kV cable',
      owner: 'R. Shaw',
    });

    throwsCode(
      () => settlement.settleAction(asQS(), settlementId, first.reference, { ending: 'CLOSED', outcome: 'Done' }),
      'ACTION_OUTCOME_REQUIRED',
    );

    const closed = settlement.settleAction(asQS(), settlementId, first.reference, {
      ending: 'CLOSED',
      outcome: 'Corbett confirmed £48,000 fixed; the allowance is unchanged',
    });
    assert.equal(closed.open, 1);

    // The second one is not resolved and the bid says so out loud.
    const carried = settlement.settleAction(asQS(), settlementId, second.reference, {
      ending: 'CARRIED',
      outcome: 'The price excludes diversion of the 11kV cable, which is assumed to be the client’s cost',
    });
    assert.equal(carried.open, 0);

    throwsCode(
      () =>
        settlement.settleAction(asQS(), settlementId, second.reference, {
          ending: 'CLOSED',
          outcome: 'Trying to close a carried action after the fact',
        }),
      'ACTION_NOT_OPEN',
    );
    throwsCode(
      () =>
        settlement.settleAction(asQS(), settlementId, 'ACT-99', {
          ending: 'CLOSED',
          outcome: 'There is no such action on this settlement',
        }),
      'ACTION_NOT_FOUND',
    );
  });
});

// ── The cut-off ────────────────────────────────────────────────────────────

describe('settlement · the price and the programme belong to one scope', () => {
  let settlementId: string;

  before(() => {
    settlementId = platform.ledger.list(seed.projectId, 'Settlement')[0]!.refId;
  });

  /**
   * `AC-T-WF-07-03`. A price settled against addendum three and a programme
   * built against addendum two produce a bid that does not hang together, and
   * nobody finds out until the first extension-of-time claim.
   */
  it('refuses a programme built against a different addendum', () => {
    const error = throwsCode(
      () =>
        settlement.approveBidProgramme(asPlanner(), settlementId, {
          programmeRef: { refType: 'ProgrammeBaseline', refId: 'baseline-1' },
          cutOff: { addendum: 'ADD-02', informationAt: '2027-03-05' },
          durationWeeks: 78,
        }),
      'CUT_OFF_MISMATCH',
    );
    assert.match(String(error.message), /does not hang together/);
  });

  it('refuses one built against a different information date', () => {
    throwsCode(
      () =>
        settlement.approveBidProgramme(asPlanner(), settlementId, {
          programmeRef: { refType: 'ProgrammeBaseline', refId: 'baseline-1' },
          cutOff: { addendum: 'ADD-03', informationAt: '2027-02-19' },
          durationWeeks: 78,
        }),
      'CUT_OFF_MISMATCH',
    );
  });

  it('approves one at the price’s own cut-off', () => {
    const approved = settlement.approveBidProgramme(asPlanner(), settlementId, {
      programmeRef: { refType: 'ProgrammeBaseline', refId: 'baseline-1' },
      cutOff: CUT_OFF,
      durationWeeks: 78,
      note: 'Settlement programme, 78 weeks, priced against ADD-03',
    });
    assert.equal(approved.aligned, true);

    const row = settlement.settlementPosition(asQS()).settlements.find((s) => s.settlementId === settlementId)!;
    assert.equal(row.programmeAligned, true);
  });
});

// ── Approval ───────────────────────────────────────────────────────────────

describe('settlement · five refusals, not five warnings', () => {
  let settlementId: string;
  let expected: number;

  before(() => {
    settlementId = platform.ledger.list(seed.projectId, 'Settlement')[0]!.refId;
    expected = preSettlementMinor - 307_000_00;
  });

  /** `AC-T-WF-07-01`: to the penny, or the difference is an unrecorded adjustment. */
  it('refuses a price the bridge does not reach, and shows the arithmetic', () => {
    const error = throwsCode(
      () =>
        settlement.approveSettlement(asOwner(), settlementId, {
          finalPriceMinor: expected - 25_000_00,
          authority: AUTHORITY,
          summary: 'Approved at the settled figure after the preliminaries review',
        }),
      'BRIDGE_DOES_NOT_RECONCILE',
    );
    assert.match(String(error.message), /£25,000(\.00)? less/);
    assert.match(String(error.message), /an adjustment nobody recorded/);
  });

  it('refuses an approval above the authority held', () => {
    const error = throwsCode(
      () =>
        settlement.approveSettlement(asOwner(), settlementId, {
          finalPriceMinor: expected,
          authority: { delegatedTo: 'Bid Manager', limitMinor: 5_000_000_00 },
          summary: 'Approved at the settled figure after the preliminaries review',
        }),
      'ABOVE_AUTHORITY',
    );
    assert.match(String(error.message), /Bid Manager holds £5,000,000/);
    assert.match(String(error.message), /somebody who holds the value/);
  });

  /** The person moving the numbers does not sign off where they ended up. */
  it('refuses the person who ran the settlement', () => {
    const error = throwsCode(
      () =>
        settlement.approveSettlement(asQS(), settlementId, {
          finalPriceMinor: expected,
          authority: AUTHORITY,
          summary: 'Approving my own settlement, which is the thing this refuses',
        }),
      'SELF_APPROVAL_REFUSED',
    );
    assert.match(String(error.message), /not moving the numbers/);
  });

  it('approves, and carries the conditions onto the submission', () => {
    const approved = settlement.approveSettlement(asOwner(), settlementId, {
      finalPriceMinor: expected,
      authority: AUTHORITY,
      summary:
        'Settled at £307,000 below the estimate on the Hallam re-let and the released piling allowance. ' +
        'Bid carries one condition on the 11kV diversion.',
    });

    assert.equal(approved.postSettlementMinor, expected);
    // `AC-T-WF-07-02`: the carried action is now a condition on the bid rather
    // than a line in the minutes.
    assert.equal(approved.conditions.length, 1);
    assert.match(approved.conditions[0]!, /11kV cable/);

    const row = settlement.settlementPosition(asQS()).settlements.find((s) => s.settlementId === settlementId)!;
    assert.equal(row.status, 'APPROVED');
    assert.equal(row.finalPriceMinor, expected);
    assert.equal(row.actions.carried, 1);
    assert.equal(row.actions.closed, 1);
    assert.match(settlement.settlementPosition(asQS()).summary, /condition on the submission/);
  });

  it('refuses to move the price after approval', () => {
    const error = throwsCode(
      () =>
        settlement.recordAdjustment(asQS(), settlementId, {
          category: 'MARGIN',
          amountMinor: 50_000_00,
          reason: 'Putting the margin back up after the price has already been approved',
          owner: 'R. Shaw',
        }),
      'SETTLEMENT_APPROVED',
    );
    assert.match(String(error.message), /a different price, and it needs a new settlement/);
  });
});

// ── The open actions and the missing programme ─────────────────────────────

describe('settlement · what approval will not step over', () => {
  let settlementId: string;

  before(() => {
    // A second estimate would be needed for a second settlement on this
    // project, so this one runs on its own seeded tenancy.
    const other = new Platform();
    return seedDemoProject(other).then((otherSeed) => {
      const owner = other.context(otherSeed.users.owner!.auth, otherSeed.projectId, { source: 'WEB' });
      structure.transitionPhase(owner, { to: 'TENDER', justification: 'Reopened to settle the tender price' });

      const qs = other.context(otherSeed.users.qs!.auth, otherSeed.projectId, { source: 'WEB' });
      settlementId = settlement.openSettlement(qs, {
        estimateId: other.ledger.list(otherSeed.projectId, 'Estimate')[0]!.refId,
        cutOff: CUT_OFF,
      }).settlementId;

      settlement.raiseAction(qs, settlementId, {
        description: 'Establish whether the client will fund the 11kV diversion',
        owner: 'R. Shaw',
      });

      platform = other;
      seed = otherSeed;
      preSettlementMinor = Number(other.ledger.list(otherSeed.projectId, 'Estimate')[0]!.state.totalMinor);
    });
  });

  it('refuses while an action is neither closed nor carried, and names it', () => {
    const error = throwsCode(
      () =>
        settlement.approveSettlement(asOwner(), settlementId, {
          finalPriceMinor: preSettlementMinor,
          authority: AUTHORITY,
          summary: 'Approving with an action still open, which is the thing this refuses',
        }),
      'ACTIONS_OPEN',
    );
    assert.match(String(error.message), /ACT-01 \(R\. Shaw\)/);
    assert.match(String(error.message), /simply stopped being discussed is neither/);
  });

  it('refuses a price with no approved programme behind it', () => {
    settlement.settleAction(asQS(), settlementId, 'ACT-01', {
      ending: 'CARRIED',
      outcome: 'The price excludes the 11kV diversion',
    });

    const error = throwsCode(
      () =>
        settlement.approveSettlement(asOwner(), settlementId, {
          finalPriceMinor: preSettlementMinor,
          authority: AUTHORITY,
          summary: 'Approving with no programme behind it, which is the thing this refuses',
        }),
      'PROGRAMME_NOT_APPROVED',
    );
    assert.match(String(error.message), /a number with no delivery behind it/);
  });
});

// ── The catalogue ──────────────────────────────────────────────────────────

describe('settlement · the event catalogue', () => {
  it('registers the events, and none of them may be authored by an agent', () => {
    for (const code of [
      'ADJUDICATION_STARTED',
      'PRICE_ADJUSTMENT_RECORDED',
      'SETTLEMENT_ACTION_RECORDED',
      'BID_PROGRAMME_APPROVED',
      'ADJUDICATION_APPROVED',
    ]) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      // The specification is explicit: an agent may identify margin exposure
      // and draft the risk summary, and may not set the margin, the contingency
      // or the final price.
      assert.equal(definition!.aiAllowed, false, `${code} may be authored by an agent`);
    }

    // Both snapshots are evidenced, because the bridge is only worth anything
    // if the two ends of it are provable.
    assert.equal(lookupEventType('ADJUDICATION_STARTED')!.requiresEvidence, true);
    assert.equal(lookupEventType('ADJUDICATION_APPROVED')!.requiresEvidence, true);
  });

  /**
   * Two different acts, two different words. `ADJUDICATION_COMPLETED` chooses a
   * subcontractor from an evaluation; the settlement sets the price we are
   * giving. Sharing a name is how somebody eventually calls the wrong one.
   */
  it('leaves supplier adjudication exactly where it was', () => {
    assert.equal(lookupEventType('ADJUDICATION_COMPLETED')!.entity, 'Adjudication');
    assert.equal(lookupEventType('ADJUDICATION_APPROVED')!.entity, 'Settlement');
  });
});
