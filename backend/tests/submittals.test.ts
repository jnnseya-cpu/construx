import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as submittals from '../src/domain/submittals.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Material and technical approval submittals.
 *
 * The record closes a gap the corporate control standard already declared open
 * — `DEL.SUBMITTALS` carried a `notTrackedReason` saying nothing tracked a
 * product submitted for approval — so one of the tests here is that the
 * standard now reports it as tracked rather than excused.
 *
 * Everything else tests the one number that makes a submittal register worth
 * keeping: **the date the decision was actually needed**, which is the date the
 * material has to be on site minus its procurement lead time. A register that
 * tracks status alone discovers its delays after they have happened.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds DESIGN_INFORMATION R, C, U — the contractor, who submits. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds DESIGN_INFORMATION R, C, U, A — the designer, who decides. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
/** Holds DESIGN_INFORMATION R only. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

/** The concrete mix design submittal clause the seeded specification actually carries. */
let clauseId: string;

const MIX_CLAIMS: submittals.ComplianceClaim[] = [
  { requirement: 'Strength class', specified: 'C32/40', offered: 'C32/40', compliant: true },
  { requirement: 'Exposure class', specified: 'XC3/XC4', offered: 'XC4', compliant: true },
  { requirement: 'Cement type', specified: 'CEM IIIA', offered: 'CEM IIIA, 50% GGBS', compliant: true },
  { requirement: 'Maximum aggregate size', specified: '20 mm', offered: '20 mm', compliant: true },
];

function raiseMixSubmittal(overrides: Partial<Parameters<typeof submittals.raiseSubmittal>[1]> = {}) {
  return submittals.raiseSubmittal(asPM(), {
    kind: 'MATERIAL',
    title: 'Concrete mix design — substructure',
    clauseId,
    manufacturer: 'Aggregate Industries',
    productReference: 'AI-C3240-XC4-GGBS50',
    claims: MIX_CLAIMS,
    procurementLeadTimeDays: 28,
    requiredOnSiteBy: '2027-09-01',
    reviewPeriodDays: 14,
    ...overrides,
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const clause = platform.ledger
    .list(seed.projectId, 'SpecClause')
    .find((record) => record.state.clauseRef === 'E10/3.2');
  assert.ok(clause, 'the seeded specification no longer carries the E10/3.2 submittal clause');
  clauseId = clause.refId;
});

// ── The record ──────────────────────────────────────────────────────────────

describe('submittal · the record', () => {
  it('is registered in the closed event catalogue against one entity', () => {
    for (const code of [
      'SUBMITTAL_RAISED',
      'SUBMITTAL_ISSUED',
      'SUBMITTAL_REVIEWED',
      'SUBMITTAL_RESUBMITTED',
      'SUBMITTAL_ORDERED',
    ]) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'MaterialSubmittal');
      // An agent may read a specification. It may not declare a product
      // compliant with one, because that declaration is what the contractor is
      // liable for.
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('sits with the clause it answers, not with quality, because quality is phase-gated', () => {
    // A fourteen-week item can only usefully be raised in design, and
    // QUALITY_COMMISSIONING does not open until CONSTRUCTION.
    assert.equal(classifyEntity('MaterialSubmittal')?.area, 'DESIGN_INFORMATION');
  });

  it('closes the gap the corporate control standard declared open', async () => {
    const control = await import('../src/lifecycle/control.ts');
    const item = control.controlItem('DEL.SUBMITTALS');
    assert.ok(item);
    assert.equal(item.notTrackedReason, undefined, 'DEL.SUBMITTALS is still excused rather than tracked');
    assert.equal(item.evidence?.refType, 'MaterialSubmittal');
  });
});

// ── The date the decision was actually needed ───────────────────────────────

describe('submittal · the approval date is derived from the lead time, not asked for', () => {
  it('works back from when the material is needed on site', () => {
    const raised = raiseMixSubmittal();
    // 1 September less 28 days. Nobody types this date; typing it is how it ends
    // up agreeing with nothing.
    assert.equal(raised.approvalNeededBy, '2027-08-04');
  });

  it('refuses a submittal with no lead time, and says why zero is different from absent', () => {
    const refusal = throwsCode(
      () => raiseMixSubmittal({ procurementLeadTimeDays: Number.NaN }),
      'LEAD_TIME_REQUIRED',
    );
    assert.match(String(refusal.message), /Zero is a legitimate answer/);
  });

  it('refuses a review period of nothing, because a review with no period is never late', () => {
    throwsCode(() => raiseMixSubmittal({ reviewPeriodDays: 0 }), 'REVIEW_PERIOD_REQUIRED');
  });

  it('reports negative slack where the contractual review period outruns the ordering date', () => {
    // Needed on site in seven weeks, six-week lead time, ten-day review. The
    // reviewer can answer entirely within the contract and the material still
    // cannot arrive — a fact no status field can express.
    //
    // Dated relative to now rather than fixed, because the review clock starts
    // when `submitForReview` is called and a hardcoded date would test the
    // calendar rather than the arithmetic.
    const inWeeks = (weeks: number) => new Date(Date.now() + weeks * 7 * 86_400_000).toISOString().slice(0, 10);
    const raised = raiseMixSubmittal({
      title: 'Post-tensioning anchorages',
      productReference: 'PT-ANC-19S15',
      requiredOnSiteBy: inWeeks(7),
      procurementLeadTimeDays: 42,
      reviewPeriodDays: 10,
    });
    const submitted = submittals.submitForReview(asPM(), raised.submittalId);
    assert.ok(submitted.slackDays < 0, `expected negative slack, got ${submitted.slackDays}`);
  });
});

// ── A compliance claim with one side of it ──────────────────────────────────

describe('submittal · refuses an assertion dressed as a comparison', () => {
  it('refuses a submittal that compares nothing', () => {
    throwsCode(() => raiseMixSubmittal({ claims: [] }), 'NOTHING_CLAIMED');
  });

  it('refuses a claim with the specified value missing', () => {
    throwsCode(
      () =>
        raiseMixSubmittal({
          claims: [{ requirement: 'Strength class', specified: '', offered: 'C32/40', compliant: true }],
        }),
      'CLAIM_ONE_SIDED',
    );
  });

  it('refuses a claim with the offered value missing', () => {
    throwsCode(
      () =>
        raiseMixSubmittal({
          claims: [{ requirement: 'Strength class', specified: 'C32/40', offered: '   ', compliant: true }],
        }),
      'CLAIM_ONE_SIDED',
    );
  });

  it('refuses a departure offered with no reason for it', () => {
    throwsCode(
      () =>
        raiseMixSubmittal({
          claims: [
            ...MIX_CLAIMS,
            { requirement: 'Chloride class', specified: 'Cl 0,10', offered: 'Cl 0,20', compliant: false },
          ],
        }),
      'DEPARTURE_UNJUSTIFIED',
    );
  });

  it('accepts a departure that says why it is being offered anyway', () => {
    const raised = raiseMixSubmittal({
      claims: [
        ...MIX_CLAIMS,
        {
          requirement: 'Chloride class',
          specified: 'Cl 0,10',
          offered: 'Cl 0,20',
          compliant: false,
          justification:
            'No prestressing steel in the substructure pours; Cl 0,20 is the class BS 8500-1 permits for reinforced ' +
            'concrete without prestressing tendons.',
        },
      ],
    });
    const row = submittals
      .submittalPosition(asQS())
      .submittals.find((entry) => entry.submittalId === raised.submittalId);
    // Counted and shown rather than swallowed. A reviewer scanning the register
    // should be able to see which submittals ask for something.
    assert.equal(row?.departures, 1);
  });
});

// ── Substitutions ───────────────────────────────────────────────────────────

describe('submittal · a substitution names what it substitutes', () => {
  it('refuses an alternative that does not say what it is an alternative to', () => {
    throwsCode(
      () => raiseMixSubmittal({ substitution: { differsFrom: '', whyProposed: 'Cheaper' } }),
      'SUBSTITUTION_UNSTATED',
    );
  });

  it('flags the accepted substitution in the register', () => {
    const raised = raiseMixSubmittal({
      substitution: {
        differsFrom: 'The specified CEM I mix with 25% PFA',
        whyProposed:
          'GGBS at 50% gives the required sulfate resistance for DS-3 ground and is available from the local plant; ' +
          'the PFA source named in the specification closed in March 2027.',
      },
    });
    const row = submittals
      .submittalPosition(asQS())
      .submittals.find((entry) => entry.submittalId === raised.submittalId);
    assert.equal(row?.isSubstitution, true);
  });
});

// ── The citation has to resolve ─────────────────────────────────────────────

describe('submittal · cites a clause that exists', () => {
  it('refuses a citation that resolves to nothing on this project', () => {
    const refusal = throwsCode(
      () => raiseMixSubmittal({ clauseId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' }),
      'CLAUSE_NOT_FOUND',
    );
    assert.match(String(refusal.message), /approving a product rather than a\s+compliance/);
  });

  it('refuses a product nobody could order or check on delivery', () => {
    throwsCode(() => raiseMixSubmittal({ productReference: '  ' }), 'PRODUCT_UNIDENTIFIED');
  });

  it('carries the clause reference through onto the register', () => {
    const raised = raiseMixSubmittal();
    const row = submittals
      .submittalPosition(asQS())
      .submittals.find((entry) => entry.submittalId === raised.submittalId);
    assert.equal(row?.clauseRef, 'E10/3.2');
    assert.equal(row?.specificationRef, 'E10');
  });
});

// ── Review, and who may do it ───────────────────────────────────────────────

describe('submittal · the decision', () => {
  it('refuses a decision on something never submitted', () => {
    const raised = raiseMixSubmittal();
    throwsCode(
      () => submittals.reviewSubmittal(asDesigner(), raised.submittalId, { outcome: 'APPROVED', comments: '' }),
      'NOT_UNDER_REVIEW',
    );
  });

  it('refuses the person who submitted it as the person who approves it', () => {
    // Tested through the designer, who holds C, U *and* A on this area and is
    // therefore the only role that can reach the refusal at all. The matrix can
    // say "may approve"; it cannot say "not the same person".
    const raised = submittals.raiseSubmittal(asDesigner(), {
      kind: 'CALCULATION',
      title: 'Pile cap design calculations',
      clauseId,
      manufacturer: 'Meridian Design',
      productReference: 'MD-CALC-PC-07',
      claims: [{ requirement: 'Design code', specified: 'BS EN 1992-1-1', offered: 'BS EN 1992-1-1', compliant: true }],
      procurementLeadTimeDays: 0,
      requiredOnSiteBy: '2027-08-01',
      reviewPeriodDays: 10,
    });
    submittals.submitForReview(asDesigner(), raised.submittalId);
    throwsCode(
      () =>
        submittals.reviewSubmittal(asDesigner(), raised.submittalId, {
          outcome: 'APPROVED',
          comments: 'Fine',
        }),
      'SELF_REVIEW_REFUSED',
    );
  });

  it('refuses a rejection with nothing said about what is wrong with it', () => {
    const raised = raiseMixSubmittal();
    submittals.submitForReview(asPM(), raised.submittalId);
    throwsCode(
      () =>
        submittals.reviewSubmittal(asDesigner(), raised.submittalId, { outcome: 'REVISE_AND_RESUBMIT', comments: '' }),
      'DECISION_UNEXPLAINED',
    );
  });

  it('separates how late the decision is from how late the reviewer is', () => {
    // Two different questions with two different answers, and on most contracts
    // a different party's problem. A register reporting one number for both is
    // reporting the wrong one to somebody.
    const raised = raiseMixSubmittal({
      title: 'Curtain walling system',
      productReference: 'SCH-FW50-SG',
      // Needed on site long ago, so the decision is late by any measure.
      requiredOnSiteBy: '2025-01-01',
      procurementLeadTimeDays: 30,
      // A review period the reviewer is comfortably inside.
      reviewPeriodDays: 60,
    });
    submittals.submitForReview(asPM(), raised.submittalId);
    const decided = submittals.reviewSubmittal(asDesigner(), raised.submittalId, {
      outcome: 'APPROVED',
      comments: 'Approved as submitted.',
    });
    assert.ok(decided.daysLate > 0, 'the decision is past the date the material had to be ordered');
    assert.equal(decided.reviewOverdueByDays, 0, 'the reviewer is still inside the contractual period');
    assert.equal(decided.mayOrder, true);
  });

  it('treats approved-with-comments as permitting the order, and revise-and-resubmit as not', () => {
    const approved = raiseMixSubmittal({ productReference: 'AI-C3240-A' });
    submittals.submitForReview(asPM(), approved.submittalId);
    assert.equal(
      submittals.reviewSubmittal(asDesigner(), approved.submittalId, {
        outcome: 'APPROVED_WITH_COMMENTS',
        comments: 'Proceed. Confirm the plant’s current conformity certificate before the first delivery.',
      }).mayOrder,
      true,
    );

    const returned = raiseMixSubmittal({ productReference: 'AI-C3240-B' });
    submittals.submitForReview(asPM(), returned.submittalId);
    assert.equal(
      submittals.reviewSubmittal(asDesigner(), returned.submittalId, {
        outcome: 'REVISE_AND_RESUBMIT',
        comments: 'The 20-working-day notice period in E10/3.2 is not met by this submission date.',
      }).mayOrder,
      false,
    );
  });

  it('refuses resubmission of something that was not asked for', () => {
    const raised = raiseMixSubmittal();
    throwsCode(
      () => submittals.resubmit(asPM(), raised.submittalId, { claims: MIX_CLAIMS, whatChanged: 'Nothing' }),
      'NOT_RETURNED',
    );
  });
});

// ── Cycles ──────────────────────────────────────────────────────────────────

describe('submittal · a product going round in circles stays one record', () => {
  let submittalId: string;

  before(() => {
    submittalId = raiseMixSubmittal({ productReference: 'AI-CIRCLING' }).submittalId;
  });

  function bounce(comments: string): void {
    submittals.submitForReview(asPM(), submittalId);
    submittals.reviewSubmittal(asDesigner(), submittalId, { outcome: 'REVISE_AND_RESUBMIT', comments });
    submittals.resubmit(asPM(), submittalId, {
      claims: MIX_CLAIMS,
      whatChanged: comments,
    });
  }

  it('refuses a resubmission that does not say what changed', () => {
    submittals.submitForReview(asPM(), submittalId);
    submittals.reviewSubmittal(asDesigner(), submittalId, {
      outcome: 'REVISE_AND_RESUBMIT',
      comments: 'Confirm the GGBS replacement level against the DS-3 sulfate class.',
    });
    throwsCode(
      () => submittals.resubmit(asPM(), submittalId, { claims: MIX_CLAIMS, whatChanged: '  ' }),
      'CHANGE_UNSTATED',
    );
    submittals.resubmit(asPM(), submittalId, {
      claims: MIX_CLAIMS,
      whatChanged: 'GGBS replacement raised to 50% and the sulfate class confirmed as DS-3.',
    });
  });

  it('advances the revision letter on the same record rather than opening a new row', () => {
    bounce('Aggregate source not named.');
    bounce('Third-party conformity certificate not attached.');

    const rows = submittals.submittalPosition(asQS()).submittals.filter((row) => row.reference !== undefined);
    const circling = rows.filter((row) => row.productReference === 'AI-CIRCLING');
    // One row, not three. Splitting each cycle into its own record is how a
    // product that has been round three times becomes invisible.
    assert.equal(circling.length, 1);
    assert.equal(circling[0]?.revision, 'D');
    assert.equal(circling[0]?.cycles, 3);
  });

  it('reports it as circling, and clears the previous decision off the new revision', () => {
    const position = submittals.submittalPosition(asQS());
    assert.ok(position.circling >= 1);
    assert.match(position.summary, /on a third cycle or worse/);

    const record = platform.ledger.get({ refType: 'MaterialSubmittal', refId: submittalId });
    const state = record!.state as { reviewedBy?: string; reviewComments?: string; status: string };
    // Carrying the previous decision forward would show revision D as reviewed
    // on the strength of a review of revision C.
    assert.equal(state.reviewedBy, undefined);
    assert.equal(state.reviewComments, undefined);
    assert.equal(state.status, 'DRAFT');
  });

  it('keeps the date it was first submitted, so the argument shows its true age', () => {
    const record = platform.ledger.get({ refType: 'MaterialSubmittal', refId: submittalId });
    const state = record!.state as { firstSubmittedAt?: string; submittedAt?: string };
    assert.ok(state.firstSubmittedAt);
    assert.ok(state.submittedAt);
    assert.ok(state.firstSubmittedAt <= state.submittedAt);
  });
});

// ── Ordering, at risk and otherwise ─────────────────────────────────────────

describe('submittal · ordering before approval is recorded, not refused', () => {
  it('refuses to record an unapproved order as an ordinary one', () => {
    const raised = raiseMixSubmittal({ productReference: 'AI-EARLY-1' });
    const refusal = throwsCode(
      () => submittals.recordOrdered(asPM(), raised.submittalId, { orderReference: 'PO-88412' }),
      'ORDERED_WITHOUT_APPROVAL',
    );
    // The refusal is about *how* it is recorded, and says so. A platform that
    // refused the act outright would push it into an inbox, which is the one
    // outcome that makes the register worse than useless.
    assert.match(String(refusal.message), /the platform will record it/);
  });

  it('refuses an at-risk order with no reason it was worth taking', () => {
    const raised = raiseMixSubmittal({ productReference: 'AI-EARLY-2' });
    throwsCode(
      () => submittals.recordOrdered(asPM(), raised.submittalId, { orderReference: 'PO-88413', atRisk: true }),
      'RISK_UNJUSTIFIED',
    );
  });

  it('records it as placed at risk, with the person who took the risk', () => {
    const raised = raiseMixSubmittal({ productReference: 'AI-EARLY-3' });
    const ordered = submittals.recordOrdered(asPM(), raised.submittalId, {
      orderReference: 'PO-88414',
      atRisk: true,
      justification:
        'Sixteen-week lead time against a piling start in October. If the submittal is returned, the order is cancellable ' +
        'to 5% within 14 days under the supplier framework, against a four-week programme loss if we wait.',
    });
    assert.equal(ordered.atRisk, true);

    const position = submittals.submittalPosition(asQS());
    assert.ok(position.atRisk >= 1);
    assert.match(position.summary, /ordered at risk/);
  });

  it('records an approved order as an ordinary one', () => {
    const raised = raiseMixSubmittal({ productReference: 'AI-CLEAN' });
    submittals.submitForReview(asPM(), raised.submittalId);
    submittals.reviewSubmittal(asDesigner(), raised.submittalId, {
      outcome: 'APPROVED',
      comments: 'Approved as submitted.',
    });
    assert.equal(
      submittals.recordOrdered(asPM(), raised.submittalId, { orderReference: 'PO-88415' }).atRisk,
      false,
    );
  });

  it('refuses a second order against the same submittal', () => {
    const raised = raiseMixSubmittal({ productReference: 'AI-TWICE' });
    submittals.submitForReview(asPM(), raised.submittalId);
    submittals.reviewSubmittal(asDesigner(), raised.submittalId, { outcome: 'APPROVED', comments: 'Approved.' });
    submittals.recordOrdered(asPM(), raised.submittalId, { orderReference: 'PO-88416' });
    throwsCode(
      () => submittals.recordOrdered(asPM(), raised.submittalId, { orderReference: 'PO-88417' }),
      'ALREADY_ORDERED',
    );
  });

  it('refuses to reuse an approval for a different product', () => {
    const raised = raiseMixSubmittal({ productReference: 'AI-REUSE' });
    submittals.submitForReview(asPM(), raised.submittalId);
    submittals.reviewSubmittal(asDesigner(), raised.submittalId, { outcome: 'APPROVED', comments: 'Approved.' });
    throwsCode(() => submittals.submitForReview(asPM(), raised.submittalId), 'ALREADY_APPROVED');
  });
});

// ── The register ────────────────────────────────────────────────────────────

describe('submittal · the register', () => {
  it('is ordered by when the decision is needed, not by when it was raised', () => {
    const dates = submittals.submittalPosition(asQS()).submittals.map((row) => row.approvalNeededBy);
    assert.deepEqual([...dates].sort(), dates);
  });

  it('counts what is past the ordering date and still undecided', () => {
    const position = submittals.submittalPosition(asQS(), '2027-12-31');
    assert.ok(position.pastOrderingDate > 0);
    assert.match(position.summary, /past the date the material had to be ordered/);
  });

  it('does not count an approved submittal as past its ordering date', () => {
    // Approved is settled. Continuing to report it as overdue would bury the
    // ones that still need answering under a permanent backlog nobody can clear.
    const position = submittals.submittalPosition(asQS(), '2027-12-31');
    const approved = position.submittals.find((row) => row.productReference === 'AI-CLEAN');
    assert.ok(approved);
    assert.equal(approved.status, 'APPROVED');
    assert.ok(approved.daysToDecision < 0, 'this one is past its ordering date on the date being asked about');
  });

  it('refuses a submittal from a role that may read the specification but not answer it', () => {
    // The QS reads every clause on the project and holds nothing but R on the
    // area. Reading what is specified and declaring a product compliant with it
    // are two different acts, and only one of them carries liability.
    assert.throws(
      () =>
        submittals.raiseSubmittal(asQS(), {
          kind: 'MATERIAL',
          title: 'Concrete mix design — substructure',
          clauseId,
          manufacturer: 'Aggregate Industries',
          productReference: 'AI-QS',
          claims: MIX_CLAIMS,
          procurementLeadTimeDays: 28,
          requiredOnSiteBy: '2027-09-01',
          reviewPeriodDays: 14,
        }),
      /ACCESS_DENIED|No role/,
    );

    // ...but reads the whole register, which is the half of the split that
    // matters commercially: a long-lead item stuck in review is a cost.
    assert.ok(submittals.submittalPosition(asQS()).submittals.length > 0);
  });
});
