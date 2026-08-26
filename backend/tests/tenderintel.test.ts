import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as tenderintel from '../src/domain/tenderintel.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Clarifications and the comparison — T-WF-06.
 *
 * Two failures are being tested for, and neither of them is a missing record.
 *
 * The first is **unequal information**. One bidder gets the answer on Tuesday
 * and the other on Friday, and the tender is no longer a competition. It is not
 * usually malice; it is a reply-all that was a reply. What makes it survivable
 * is that who was told and when is on the record, and that the platform refuses
 * the two shapes it can recognise — a confidential answer going to a competitor,
 * and an open answer going to only the firm that asked.
 *
 * The second is **the comparison that became an opinion**. Nobody sets out to
 * do it. Two quotes are on different bases, somebody normalises them, and six
 * weeks later nobody can say why the one that won had £180,000 added to the
 * other. So every adjustment must cite the return line or the issued
 * clarification behind it, and the raw return is never edited — which is the
 * only way raw, adjustments and evaluated can be three numbers that reconcile.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds PROCUREMENT_AWARD R, C, U, I, X — raises, issues, compares. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Holds R, C, U, A — the one who closes the comparison for adjudication. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const AMEY = 'party-amey';
const BALFOUR = 'party-balfour';
const CARILLON = 'party-carillon';

const bidder = (partyId: string, name: string) => ({ partyId, name, isBidder: true });
const internal = (partyId: string, name: string) => ({ partyId, name, isBidder: false });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // PROCUREMENT_AWARD is gated to TENDER and CONSTRUCTION, and the demo project
  // finishes in OPERATIONS. A governed regression puts it back where the
  // procurement acts under test are legitimately writable.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to record the clarification register and the return comparison for this package',
  });
});

// ── The register ────────────────────────────────────────────────────────────

describe('tender intelligence · a question has to be attached to something', () => {
  it('records an internal question against the clause it concerns', () => {
    const { reference } = tenderintel.raiseTenderClarification(asQS(), {
      side: 'INTERNAL',
      subject: 'Does the fluctuation provision apply to the groundworks package?',
      question: 'Clause 4.21 is struck through in the amendments but referenced in the pricing document. Which governs?',
      links: { document: 'ITT-004', clause: '4.21' },
      responseDeadline: '2027-02-19',
    });
    assert.match(reference, /^TQ-\d{3}$/);
  });

  it('refuses a question that names no document, clause, drawing, package or scope item', () => {
    const error = throwsCode(
      () =>
        tenderintel.raiseTenderClarification(asQS(), {
          side: 'INTERNAL',
          subject: 'Access',
          question: 'What are the site access arrangements?',
          links: {},
        }),
      'CLARIFICATION_UNLINKED',
    );
    assert.match(String(error.message), /document, a clause, a drawing, a package or a scope item/);
  });

  it('refuses a bidder-side question that does not name the bidder', () => {
    throwsCode(
      () =>
        tenderintel.raiseTenderClarification(asQS(), {
          side: 'BIDDER',
          subject: 'Attendances',
          question: 'Is scaffold by others?',
          links: { package: 'PKG-CLAD' },
        }),
      'BIDDER_NOT_NAMED',
    );
  });

  it('refuses commercial-in-confidence on a question that has no bidder to keep it from', () => {
    throwsCode(
      () =>
        tenderintel.raiseTenderClarification(asQS(), {
          side: 'CLIENT',
          subject: 'Sectional completion',
          question: 'Is the east wing a separate section?',
          links: { document: 'ITT-001', clause: '2.4' },
          confidentiality: 'COMMERCIAL_IN_CONFIDENCE',
        }),
      'CONFIDENTIALITY_NOT_APPLICABLE',
    );
  });

  it('refuses an empty question', () => {
    throwsCode(
      () =>
        tenderintel.raiseTenderClarification(asQS(), {
          side: 'INTERNAL',
          subject: 'Something',
          question: '   ',
          links: { document: 'ITT-001' },
        }),
      'CLARIFICATION_EMPTY',
    );
  });

  /**
   * One register, one sequence. `procurement.raiseClarification` writes the
   * RFQ-scoped supplier question against the same entity, so the numbering has
   * to continue rather than restart — otherwise there are two TQ-001s and the
   * reference on a piece of paper stops identifying anything.
   */
  it('continues the TQ sequence rather than starting a second register', () => {
    const before = asQS().ledger.list(seed.projectId, 'Clarification').length;
    const { reference } = tenderintel.raiseTenderClarification(asQS(), {
      side: 'CLIENT',
      subject: 'Base date',
      question: 'Confirm the base date for fluctuations.',
      links: { document: 'ITT-002', clause: '4.3' },
    });
    assert.equal(reference, `TQ-${String(before + 1).padStart(3, '0')}`);
  });
});

// ── Issue: who was told, and when ───────────────────────────────────────────

describe('tender intelligence · issuing an answer is where a tender is lost', () => {
  let openBidderQuestion: string;
  let confidentialQuestion: string;

  before(() => {
    openBidderQuestion = tenderintel.raiseTenderClarification(asQS(), {
      side: 'BIDDER',
      subject: 'Scaffold attendance on the cladding package',
      question: 'Is common scaffold provided by the main contractor?',
      links: { package: 'PKG-CLAD' },
      bidderPartyId: AMEY,
    }).clarificationId;

    confidentialQuestion = tenderintel.raiseTenderClarification(asQS(), {
      side: 'BIDDER',
      subject: 'Amey’s own labour rate build-up',
      question: 'Our rate assumes a 46-hour week — is that acceptable against the site working hours?',
      links: { package: 'PKG-CLAD' },
      bidderPartyId: AMEY,
      confidentiality: 'COMMERCIAL_IN_CONFIDENCE',
    }).clarificationId;
  });

  /** `AC-T-WF-06-02`. */
  it('records every recipient and the time it went out', () => {
    const result = tenderintel.issueClarification(asQS(), {
      clarificationId: openBidderQuestion,
      response: 'Common scaffold is provided by the main contractor to the extents shown on drawing L-201.',
      recipients: [bidder(AMEY, 'Amey'), bidder(BALFOUR, 'Balfour'), internal('party-qs', 'Commercial team')],
      entitledBidders: [AMEY, BALFOUR],
    });
    assert.equal(result.recipients, 3);
    assert.ok(Date.parse(result.issuedAt) > 0, 'the issue time was not a real instant');
  });

  it('refuses to issue the same answer twice, because the first has been priced against', () => {
    throwsCode(
      () =>
        tenderintel.issueClarification(asQS(), {
          clarificationId: openBidderQuestion,
          response: 'Actually the scaffold is by the cladding contractor.',
          recipients: [bidder(AMEY, 'Amey'), bidder(BALFOUR, 'Balfour')],
        }),
      'CLARIFICATION_ALREADY_ISSUED',
    );
  });

  it('refuses an answer issued to nobody', () => {
    const { clarificationId } = tenderintel.raiseTenderClarification(asQS(), {
      side: 'INTERNAL',
      subject: 'Provisional sum for the lift',
      question: 'Is the lift a provisional sum or a defined package?',
      links: { document: 'ITT-005', clause: '6.1' },
    });
    throwsCode(
      () => tenderintel.issueClarification(asQS(), { clarificationId, response: 'Defined package.', recipients: [] }),
      'NO_RECIPIENTS',
    );
  });

  /**
   * The leak. One bidder's rate build-up reaching a competitor is not a process
   * defect that gets written up — it ends the tender.
   */
  it('refuses to put one bidder’s commercial position in a competitor’s hands', () => {
    const error = throwsCode(
      () =>
        tenderintel.issueClarification(asQS(), {
          clarificationId: confidentialQuestion,
          response: 'A 46-hour week is acceptable subject to the site working hours in the preliminaries.',
          recipients: [bidder(AMEY, 'Amey'), bidder(BALFOUR, 'Balfour')],
        }),
      'CONFIDENTIAL_DISCLOSURE_REFUSED',
    );
    assert.match(String(error.message), /Balfour/, 'the refusal did not name who it would have gone to');
  });

  it('lets the confidential answer go back to the firm that asked, alongside our own people', () => {
    const result = tenderintel.issueClarification(asQS(), {
      clarificationId: confidentialQuestion,
      response: 'A 46-hour week is acceptable subject to the site working hours in the preliminaries.',
      recipients: [bidder(AMEY, 'Amey'), internal('party-qs', 'Commercial team')],
    });
    assert.equal(result.recipients, 2);
  });

  /**
   * The other half of the same fence, and the more common one: an answer that
   * reaches only the firm that asked leaves everybody else pricing the old
   * information.
   */
  it('refuses an open answer that leaves an entitled bidder off the distribution', () => {
    const { clarificationId } = tenderintel.raiseTenderClarification(asQS(), {
      side: 'BIDDER',
      subject: 'Working hours',
      question: 'Are Saturday working hours permitted?',
      links: { package: 'PKG-CLAD' },
      bidderPartyId: BALFOUR,
    });
    const error = throwsCode(
      () =>
        tenderintel.issueClarification(asQS(), {
          clarificationId,
          response: 'Saturday working is permitted between 08:00 and 13:00.',
          recipients: [bidder(BALFOUR, 'Balfour')],
          entitledBidders: [AMEY, BALFOUR, CARILLON],
        }),
      'BIDDER_EXCLUDED',
    );
    assert.match(String(error.message), /not comparable/);
    assert.match(String(error.message), /party-amey/);
  });
});

// ── Read evidence ───────────────────────────────────────────────────────────

describe('tender intelligence · read evidence', () => {
  let clarificationId: string;

  before(() => {
    clarificationId = tenderintel.raiseTenderClarification(asQS(), {
      side: 'CLIENT',
      subject: 'Phasing of the north block',
      question: 'Confirm whether the north block is handed over separately.',
      links: { document: 'ITT-001', clause: '2.9' },
    }).clarificationId;

    tenderintel.issueClarification(asQS(), {
      clarificationId,
      response: 'The north block is a separate sectional completion, 12 weeks before practical completion.',
      recipients: [bidder(AMEY, 'Amey'), bidder(BALFOUR, 'Balfour')],
      entitledBidders: [AMEY, BALFOUR],
    });
  });

  it('records that a recipient has read it', () => {
    const { acknowledgedAt } = tenderintel.acknowledgeClarification(asQS(), { clarificationId, partyId: AMEY });
    assert.ok(Date.parse(acknowledgedAt) > 0);
  });

  it('is idempotent — a second acknowledgement returns the first one’s time', () => {
    const first = tenderintel.acknowledgeClarification(asQS(), { clarificationId, partyId: AMEY });
    const second = tenderintel.acknowledgeClarification(asQS(), { clarificationId, partyId: AMEY });
    assert.equal(second.acknowledgedAt, first.acknowledgedAt);
  });

  it('refuses an acknowledgement from somebody who was never sent it', () => {
    throwsCode(
      () => tenderintel.acknowledgeClarification(asQS(), { clarificationId, partyId: CARILLON }),
      'NOT_A_RECIPIENT',
    );
  });

  it('refuses to acknowledge something that has not been issued', () => {
    const fresh = tenderintel.raiseTenderClarification(asQS(), {
      side: 'INTERNAL',
      subject: 'Bond wording',
      question: 'Is the performance bond on-demand or conditional?',
      links: { document: 'ITT-006' },
    });
    throwsCode(
      () => tenderintel.acknowledgeClarification(asQS(), { clarificationId: fresh.clarificationId, partyId: AMEY }),
      'CLARIFICATION_NOT_ISSUED',
    );
  });
});

// ── The comparison ──────────────────────────────────────────────────────────

describe('tender intelligence · the raw return is never edited', () => {
  let comparisonId: string;

  before(() => {
    comparisonId = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-CLAD',
      returnDeadline: '2027-03-05T12:00:00.000Z',
      informationCutOff: 'Addendum 3',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;
  });

  it('refuses a comparison of one', () => {
    throwsCode(
      () =>
        tenderintel.openComparison(asQS(), {
          packageReference: 'PKG-ROOF',
          returnDeadline: '2027-03-05T12:00:00.000Z',
          informationCutOff: 'Addendum 3',
          bidders: [{ partyId: AMEY, name: 'Amey' }],
        }),
      'COMPARISON_NEEDS_TWO',
    );
  });

  it('refuses the same firm listed twice', () => {
    throwsCode(
      () =>
        tenderintel.openComparison(asQS(), {
          packageReference: 'PKG-ROOF',
          returnDeadline: '2027-03-05T12:00:00.000Z',
          informationCutOff: 'Addendum 3',
          bidders: [
            { partyId: AMEY, name: 'Amey' },
            { partyId: AMEY, name: 'Amey Building Ltd' },
          ],
        }),
      'BIDDER_LISTED_TWICE',
    );
  });

  it('totals the return from its own lines rather than trusting a figure typed beside them', () => {
    const { totalMinor } = tenderintel.recordRawReturn(asQS(), comparisonId, {
      bidderPartyId: AMEY,
      submittedAt: '2027-03-05T11:14:00.000Z',
      lines: [
        { reference: 'A1', description: 'Rainscreen cladding', amountMinor: 1_840_000_00 },
        { reference: 'A2', description: 'Windows', amountMinor: 610_000_00 },
        { reference: 'A3', description: 'Preliminaries', amountMinor: 190_000_00 },
      ],
      exclusions: ['Scaffold', 'Out-of-hours working'],
    });
    assert.equal(totalMinor, 2_640_000_00);
  });

  it('refuses to overwrite a return that has already arrived', () => {
    const error = throwsCode(
      () =>
        tenderintel.recordRawReturn(asQS(), comparisonId, {
          bidderPartyId: AMEY,
          submittedAt: '2027-03-05T11:40:00.000Z',
          lines: [{ reference: 'A1', description: 'Revised', amountMinor: 2_500_000_00 }],
        }),
      'RAW_RETURN_IMMUTABLE',
    );
    assert.match(String(error.message), /adjustment, which keeps their number visible/);
  });

  it('refuses a return from a firm that was never in the comparison', () => {
    throwsCode(
      () =>
        tenderintel.recordRawReturn(asQS(), comparisonId, {
          bidderPartyId: CARILLON,
          submittedAt: '2027-03-05T11:59:00.000Z',
          lines: [{ reference: 'C1', description: 'All in', amountMinor: 2_400_000_00 }],
        }),
      'BIDDER_NOT_IN_COMPARISON',
    );
  });

  it('refuses a return with no priced lines', () => {
    throwsCode(
      () =>
        tenderintel.recordRawReturn(asQS(), comparisonId, {
          bidderPartyId: BALFOUR,
          submittedAt: '2027-03-05T11:58:00.000Z',
          lines: [],
        }),
      'RETURN_EMPTY',
    );
  });
});

// ── Every adjustment names its source ───────────────────────────────────────

describe('tender intelligence · an adjustment with no source is a preference', () => {
  let comparisonId: string;
  let issuedReference: string;

  before(() => {
    comparisonId = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-M&E',
      returnDeadline: '2027-03-19T12:00:00.000Z',
      informationCutOff: 'Addendum 4',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;

    tenderintel.recordRawReturn(asQS(), comparisonId, {
      bidderPartyId: AMEY,
      submittedAt: '2027-03-19T10:02:00.000Z',
      lines: [
        { reference: 'M1', description: 'Mechanical', amountMinor: 3_100_000_00 },
        { reference: 'M2', description: 'Electrical', amountMinor: 2_400_000_00 },
      ],
      exclusions: ['Builders work in connection'],
    });

    tenderintel.recordRawReturn(asQS(), comparisonId, {
      bidderPartyId: BALFOUR,
      submittedAt: '2027-03-19T11:31:00.000Z',
      lines: [
        { reference: 'B1', description: 'Mechanical and electrical', amountMinor: 5_700_000_00 },
      ],
    });

    const raised = tenderintel.raiseTenderClarification(asQS(), {
      side: 'BIDDER',
      subject: 'Builders work in connection',
      question: 'Is BWIC included in the M&E package or by the main contractor?',
      links: { package: 'PKG-M&E' },
      bidderPartyId: AMEY,
    });
    issuedReference = raised.reference;
    tenderintel.issueClarification(asQS(), {
      clarificationId: raised.clarificationId,
      response: 'Builders work in connection is included in the M&E package.',
      recipients: [bidder(AMEY, 'Amey'), bidder(BALFOUR, 'Balfour')],
      entitledBidders: [AMEY, BALFOUR],
    });
  });

  /** `AC-T-WF-06-01`, as a refusal rather than a report. */
  it('refuses an adjustment that cites neither a return line nor a clarification', () => {
    const error = throwsCode(
      () =>
        tenderintel.adjustComparison(asQS(), comparisonId, {
          bidderPartyId: AMEY,
          category: 'SCOPE_ADDED',
          amountMinor: 180_000_00,
          reason: 'Feels light on containment',
        }),
      'ADJUSTMENT_UNSOURCED',
    );
    assert.match(String(error.message), /cannot be told apart from a preference/);
  });

  it('accepts an adjustment against an issued clarification', () => {
    const { reference } = tenderintel.adjustComparison(asQS(), comparisonId, {
      bidderPartyId: AMEY,
      category: 'EXCLUSION_PRICED',
      amountMinor: 180_000_00,
      reason: `BWIC excluded by Amey and confirmed in-package by ${issuedReference}`,
      fromClarification: issuedReference,
    });
    assert.match(reference, /^ADJ-\d{3}$/);
  });

  it('accepts an adjustment against a line in that firm’s own return', () => {
    tenderintel.adjustComparison(asQS(), comparisonId, {
      bidderPartyId: BALFOUR,
      category: 'ARITHMETIC_CORRECTION',
      amountMinor: 12_000_00,
      reason: 'Line B1 casts £12,000 short of the sum of its sub-lines',
      fromReturnLine: 'B1',
    });
  });

  it('refuses a citation of a line that firm did not price', () => {
    throwsCode(
      () =>
        tenderintel.adjustComparison(asQS(), comparisonId, {
          bidderPartyId: BALFOUR,
          category: 'SCOPE_REMOVED',
          amountMinor: -40_000_00,
          reason: 'Removing the mechanical line',
          fromReturnLine: 'M1',
        }),
      'UNKNOWN_RETURN_LINE',
    );
  });

  it('refuses a citation of a clarification that does not exist', () => {
    throwsCode(
      () =>
        tenderintel.adjustComparison(asQS(), comparisonId, {
          bidderPartyId: AMEY,
          category: 'SCOPE_ADDED',
          amountMinor: 25_000_00,
          reason: 'Per the clarification',
          fromClarification: 'TQ-999',
        }),
      'UNKNOWN_CLARIFICATION',
    );
  });

  /**
   * The subtle one. A clarification that has been *raised* but not answered
   * carries no information, so an adjustment resting on it rests on nothing.
   */
  it('refuses a citation of a clarification nobody has answered yet', () => {
    const unanswered = tenderintel.raiseTenderClarification(asQS(), {
      side: 'CLIENT',
      subject: 'Standby generator',
      question: 'Is the standby generator in this package?',
      links: { package: 'PKG-M&E' },
    });
    throwsCode(
      () =>
        tenderintel.adjustComparison(asQS(), comparisonId, {
          bidderPartyId: AMEY,
          category: 'SCOPE_ADDED',
          amountMinor: 90_000_00,
          reason: 'Generator added pending the answer',
          fromClarification: unanswered.reference,
        }),
      'CLARIFICATION_NOT_ISSUED',
    );
  });

  it('refuses an adjustment against a firm that has not returned', () => {
    const empty = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-LIFT',
      returnDeadline: '2027-03-26T12:00:00.000Z',
      informationCutOff: 'Addendum 4',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;
    throwsCode(
      () =>
        tenderintel.adjustComparison(asQS(), empty, {
          bidderPartyId: AMEY,
          category: 'SCOPE_ADDED',
          amountMinor: 1_000_00,
          reason: 'Anything',
          fromReturnLine: 'X1',
        }),
      'NO_RETURN_TO_ADJUST',
    );
  });

  it('reconciles raw plus adjustments to evaluated, for every firm', () => {
    const result = tenderintel.compareReturns(asQS(), comparisonId);
    for (const b of result.bidders) {
      assert.equal(
        b.evaluatedMinor,
        b.rawMinor + b.adjustmentsMinor,
        `${b.name}: raw plus adjustments did not reconcile to evaluated`,
      );
    }
    const amey = result.bidders.find((b) => b.partyId === AMEY)!;
    assert.equal(amey.rawMinor, 5_500_000_00);
    assert.equal(amey.adjustmentsMinor, 180_000_00);
    assert.equal(amey.evaluatedMinor, 5_680_000_00);
  });

  /**
   * The person who adjudicates has to be able to see what they are
   * adjudicating. Reading a comparison was `X` — which the QS holds and the
   * commercial roles who decide on it do not — until the pricing route needed
   * it. It computes and writes nothing, so it is a read.
   */
  it('lets the roles who decide on a comparison read it', () => {
    for (const who of ['pm', 'owner'] as const) {
      const auth = platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
      assert.equal(tenderintel.compareReturns(auth, comparisonId).reference.startsWith('TC-'), true);
    }
  });

  it('ranks when nothing is outstanding, cheapest evaluated first', () => {
    const result = tenderintel.compareReturns(asQS(), comparisonId);
    assert.equal(result.rankingSuppressed, false);
    assert.equal(result.completeness, 100);
    assert.equal(result.confidence, 'HIGH');
    // Amey £5,680,000 evaluated against Balfour £5,712,000: Amey looked
    // £200,000 cheaper raw and is £32,000 cheaper once the exclusion they
    // priced around is put back, which is the whole point of the exercise.
    assert.deepEqual(result.ranking, ['Amey', 'Balfour']);
  });
});

// ── Confidence falls while a material query is open ─────────────────────────

describe('tender intelligence · an open question lowers the confidence', () => {
  let comparisonId: string;

  before(() => {
    comparisonId = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-GROUND',
      returnDeadline: '2027-04-02T12:00:00.000Z',
      informationCutOff: 'Addendum 5',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;

    tenderintel.recordRawReturn(asQS(), comparisonId, {
      bidderPartyId: AMEY,
      submittedAt: '2027-04-02T09:00:00.000Z',
      lines: [{ reference: 'G1', description: 'Groundworks', amountMinor: 1_200_000_00 }],
    });
  });

  /** `AC-T-WF-06-03`, first half: a firm that has not returned. */
  it('falls, and suppresses the ranking, while a firm has not returned', () => {
    const result = tenderintel.compareReturns(asQS(), comparisonId);
    assert.equal(result.completeness, 50, 'one return of the two the comparison needs');
    assert.equal(result.confidence, 'LOW');
    assert.equal(result.rankingSuppressed, true);
    assert.equal(result.ranking, undefined, 'a ranking was published while a firm had not returned');
    assert.match(String(result.suppressionReason), /1 of 2 firms have not returned/);
  });

  it('recovers to complete once the second return arrives', () => {
    tenderintel.recordRawReturn(asQS(), comparisonId, {
      bidderPartyId: BALFOUR,
      submittedAt: '2027-04-02T11:20:00.000Z',
      lines: [{ reference: 'B1', description: 'Groundworks', amountMinor: 1_310_000_00 }],
    });
    const result = tenderintel.compareReturns(asQS(), comparisonId);
    assert.equal(result.completeness, 100);
    assert.equal(result.rankingSuppressed, false);
  });

  /** `AC-T-WF-06-03`, second half, and the exception control that follows it. */
  it('falls again on a material query, and carries what it is worth', () => {
    tenderintel.raiseComparisonQuery(asQS(), comparisonId, {
      bidderPartyId: AMEY,
      subject: 'No rate stated for rock excavation below 3m',
      material: true,
      valueAtRiskMinor: 240_000_00,
    });
    const result = tenderintel.compareReturns(asQS(), comparisonId);
    // Two returns in and one of three things still unknown. Deliberately not
    // zero: a comparison holding two complete priced returns is not a
    // comparison about which nothing is known.
    assert.equal(result.completeness, 67);
    assert.equal(result.confidence, 'MEDIUM');
    assert.equal(result.rankingSuppressed, true);
    assert.equal(result.carriedRiskMinor, 240_000_00);
    assert.equal(result.bidders.find((b) => b.partyId === AMEY)!.carriedRiskMinor, 240_000_00);
  });

  /**
   * An immaterial query is worth recording and does not move the number. If it
   * did, nobody would ever mark one immaterial, and the distinction would stop
   * meaning anything.
   */
  it('does not let an immaterial query move the completeness', () => {
    const before = tenderintel.compareReturns(asQS(), comparisonId).completeness;
    tenderintel.raiseComparisonQuery(asQS(), comparisonId, {
      bidderPartyId: BALFOUR,
      subject: 'Contact name for the site visit is out of date',
      material: false,
      valueAtRiskMinor: 0,
    });
    assert.equal(tenderintel.compareReturns(asQS(), comparisonId).completeness, before);
  });

  it('refuses a material query with nothing at stake', () => {
    const error = throwsCode(
      () =>
        tenderintel.raiseComparisonQuery(asQS(), comparisonId, {
          bidderPartyId: BALFOUR,
          subject: 'Something serious',
          material: true,
          valueAtRiskMinor: 0,
        }),
      'MATERIAL_QUERY_NEEDS_A_VALUE',
    );
    assert.match(String(error.message), /carried to adjudication/);
  });

  it('restores the ranking when the material query is answered', () => {
    tenderintel.resolveComparisonQuery(asQS(), comparisonId, {
      reference: 'CQ-001',
      resolution: 'Amey confirmed a rate of £84/m³ for rock below 3m; no adjustment required.',
    });
    const result = tenderintel.compareReturns(asQS(), comparisonId);
    assert.equal(result.completeness, 100);
    assert.equal(result.confidence, 'HIGH');
    assert.equal(result.carriedRiskMinor, 0);
    assert.deepEqual(result.ranking, ['Amey', 'Balfour']);
  });

  it('refuses to resolve the same query twice', () => {
    throwsCode(
      () => tenderintel.resolveComparisonQuery(asQS(), comparisonId, { reference: 'CQ-001', resolution: 'Again' }),
      'QUERY_ALREADY_RESOLVED',
    );
  });

  it('refuses a query against a firm that is not in the comparison', () => {
    throwsCode(
      () =>
        tenderintel.raiseComparisonQuery(asQS(), comparisonId, {
          bidderPartyId: CARILLON,
          subject: 'Anything',
          material: false,
          valueAtRiskMinor: 0,
        }),
      'BIDDER_NOT_IN_COMPARISON',
    );
  });
});

// ── Closing for adjudication ────────────────────────────────────────────────

describe('tender intelligence · closing carries the risk forward rather than losing it', () => {
  let comparisonId: string;

  before(() => {
    comparisonId = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-FIT',
      returnDeadline: '2027-04-16T12:00:00.000Z',
      informationCutOff: 'Addendum 6',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;

    tenderintel.recordRawReturn(asQS(), comparisonId, {
      bidderPartyId: AMEY,
      submittedAt: '2027-04-16T10:00:00.000Z',
      lines: [{ reference: 'F1', description: 'Fit-out', amountMinor: 900_000_00 }],
    });
    tenderintel.recordRawReturn(asQS(), comparisonId, {
      bidderPartyId: BALFOUR,
      submittedAt: '2027-04-16T10:30:00.000Z',
      lines: [{ reference: 'F1', description: 'Fit-out', amountMinor: 940_000_00 }],
    });
    tenderintel.raiseComparisonQuery(asQS(), comparisonId, {
      bidderPartyId: BALFOUR,
      subject: 'Joinery specification not confirmed against the finishes schedule',
      material: true,
      valueAtRiskMinor: 55_000_00,
    });
  });

  /**
   * Deliberately not refused while a query is open. A bid deadline does not
   * wait, and a refusal here would only teach people to mark queries
   * immaterial — which would destroy the one signal that matters.
   */
  it('closes with an open material query, and states what is being carried', () => {
    const result = tenderintel.closeComparison(asPM(), comparisonId, {
      rationale: 'Deadline is 17:00 today. The joinery query is carried to adjudication as a priced risk.',
    });
    assert.equal(result.carriedRiskMinor, 55_000_00);
    // Two returns of two, one material query of one still open: two of three.
    assert.equal(result.completeness, 67);
  });

  it('refuses a close with no rationale', () => {
    const other = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-EXT',
      returnDeadline: '2027-04-23T12:00:00.000Z',
      informationCutOff: 'Addendum 6',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;
    tenderintel.recordRawReturn(asQS(), other, {
      bidderPartyId: AMEY,
      submittedAt: '2027-04-23T09:00:00.000Z',
      lines: [{ reference: 'E1', description: 'External works', amountMinor: 400_000_00 }],
    });
    throwsCode(() => tenderintel.closeComparison(asPM(), other, { rationale: '  ' }), 'RATIONALE_REQUIRED');
  });

  it('refuses to close a comparison nobody has returned against', () => {
    const empty = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-SIGN',
      returnDeadline: '2027-04-30T12:00:00.000Z',
      informationCutOff: 'Addendum 6',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;
    throwsCode(() => tenderintel.closeComparison(asPM(), empty, { rationale: 'Nobody bid' }), 'NOTHING_TO_ADJUDICATE');
  });

  it('refuses every change after the close', () => {
    throwsCode(
      () =>
        tenderintel.adjustComparison(asQS(), comparisonId, {
          bidderPartyId: AMEY,
          category: 'SCOPE_ADDED',
          amountMinor: 10_000_00,
          reason: 'One more thing',
          fromReturnLine: 'F1',
        }),
      'COMPARISON_CLOSED',
    );
    throwsCode(
      () =>
        tenderintel.recordRawReturn(asQS(), comparisonId, {
          bidderPartyId: BALFOUR,
          submittedAt: '2027-04-17T09:00:00.000Z',
          lines: [{ reference: 'F1', description: 'Late', amountMinor: 800_000_00 }],
        }),
      'COMPARISON_CLOSED',
    );
  });

  /**
   * The QS runs the comparison and the commercial manager closes it. The matrix
   * already says so — the QS holds `X` and not `A` — and the test is here
   * because the arithmetic is shared between the two acts and it would have
   * been easy to demand both rights from one person.
   */
  it('does not let the person who ran the comparison close it on their own authority', () => {
    const other = tenderintel.openComparison(asQS(), {
      packageReference: 'PKG-ROOFING',
      returnDeadline: '2027-05-07T12:00:00.000Z',
      informationCutOff: 'Addendum 7',
      bidders: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    }).comparisonId;
    tenderintel.recordRawReturn(asQS(), other, {
      bidderPartyId: AMEY,
      submittedAt: '2027-05-07T09:00:00.000Z',
      lines: [{ reference: 'R1', description: 'Roofing', amountMinor: 300_000_00 }],
    });
    // The QS holds X and not A, which the matrix already says. The close was
    // performed above by the PM, who holds A and not X — so the two acts must
    // not have been made to demand each other's right.
    throwsCode(
      () => tenderintel.closeComparison(asQS(), other, { rationale: 'Closing my own comparison' }),
      'ACCESS_DENIED',
    );
    tenderintel.closeComparison(asPM(), other, { rationale: 'Reviewed and closed for adjudication' });
  });
});

// ── The position, and the catalogue ─────────────────────────────────────────

describe('tender intelligence · the position', () => {
  it('lists the register and every comparison with its confidence', () => {
    const position = tenderintel.tenderIntelPosition(asQS());
    assert.ok(position.clarifications.length >= 8);
    assert.ok(position.comparisons.length >= 4);
    assert.match(position.summary, /clarifications/);

    const confidential = position.clarifications.find((c) => c.confidentiality === 'COMMERCIAL_IN_CONFIDENCE');
    assert.ok(confidential, 'the confidential clarification was not in the register');
    assert.equal(confidential.side, 'BIDDER');

    const suppressed = position.comparisons.filter((c) => c.rankingSuppressed);
    assert.ok(suppressed.length >= 1, 'no comparison reported a suppressed ranking');
  });

  it('counts the acknowledgements against the distribution', () => {
    const position = tenderintel.tenderIntelPosition(asQS());
    const acknowledged = position.clarifications.filter((c) => c.acknowledged > 0);
    assert.ok(acknowledged.length >= 1);
    for (const c of acknowledged) assert.ok(c.recipients >= c.acknowledged, `${c.reference} has more reads than recipients`);
  });
});

describe('tender intelligence · what the catalogue says', () => {
  /**
   * The specification puts issue and commercial interpretation on the person.
   * An agent that could release a clarification could release it unequally, and
   * an agent that could adjust a comparison could decide a package.
   */
  it('lets no agent issue a clarification or move a comparison', () => {
    assert.equal(lookupEventType('CLARIFICATION_ISSUED')?.aiAllowed, false);
    assert.equal(lookupEventType('RETURN_COMPARISON_UPDATED')?.aiAllowed, false);
  });

  it('requires evidence of the issue itself', () => {
    assert.equal(lookupEventType('CLARIFICATION_ISSUED')?.requiresEvidence, true);
  });

  /**
   * The comparison opens and updates under the same event, so it has to be able
   * to bring its own entity into existence.
   */
  it('lets the comparison event create the record it updates', () => {
    assert.equal(lookupEventType('RETURN_COMPARISON_UPDATED')?.creates, true);
  });

  /**
   * The register was classified as design information with no sensitivity —
   * wrong before T-WF-06 and a leak after it, because it now carries
   * commercial-in-confidence bidder questions.
   */
  it('classifies the clarification register as commercial procurement data', () => {
    const classification = classifyEntity('Clarification');
    assert.equal(classification?.area, 'PROCUREMENT_AWARD');
    assert.equal(classification?.sensitivity, 'COMMERCIAL_L3');
  });

  it('classifies the comparison, which holds every bidder’s price, the same way', () => {
    const classification = classifyEntity('ReturnComparison');
    assert.equal(classification?.area, 'PROCUREMENT_AWARD');
    assert.equal(classification?.sensitivity, 'COMMERCIAL_L3');
  });
});
