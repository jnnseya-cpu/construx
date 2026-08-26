import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as review from '../src/domain/tenderreview.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Reading the tender documents — T-WF-02.
 *
 * The estimator finds the drawing that contradicts the specification, remembers
 * it for a fortnight, and prices around it. Nobody else ever knows. These tests
 * are about the four things that reading has to leave behind:
 *
 *   - what is missing, and which packages it stops being priced;
 *   - what nobody owns, and what two people own;
 *   - what the contract actually says, verbatim, with somebody's name on the
 *     reading of it;
 *   - and where every exclusion came from.
 */

let platform: Platform;
let seed: SeedResult;

const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
/**
 * The QS holds create and update on `CONTRACTS_CLAIMS` and not approval, and
 * the Owner holds approval and not create. So the matrix already separates
 * extracting a reading from signing it, which is exactly what the specification
 * asks for: legal and commercial owners accept or reject.
 */

const FORM: review.ContractForm = {
  suite: 'JCT Design and Build',
  edition: '2016',
  amendmentsStated: true,
  amendmentDocument: 'AMD-01',
};

const documents = (over: Partial<review.TenderDocument>[] = []): review.TenderDocument[] => [
  { reference: 'AMD-01', title: 'Schedule of amendments', revision: 'A', readable: true, informsPackages: [] },
  {
    reference: 'SPEC-01',
    title: 'Employer’s requirements',
    revision: 'C',
    readable: true,
    informsPackages: ['Groundworks', 'Structure'],
    cites: ['GI-01'],
  },
  { reference: 'GI-01', title: 'Ground investigation report', revision: 'A', readable: true, informsPackages: ['Groundworks'] },
  ...(over as review.TenderDocument[]),
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(asOwner(), {
    to: 'TENDER',
    justification: 'Reopened to read the tender documents the price was built on',
  });
});

function open(form: review.ContractForm = FORM): string {
  return review.openReview(asQS(), { title: 'Ashworth Phase 2 tender documents', form }).reviewId;
}

// ── The document register ──────────────────────────────────────────────────

describe('tender review · what is missing stops a package being priced', () => {
  it('passes a complete pack', () => {
    const findings = review.validateDocuments(documents(), FORM);
    assert.deepEqual(findings, []);
  });

  /**
   * A specification citing a soil report that is not in the pack is not a note
   * to chase. It is a package that cannot be priced, and it says which one.
   */
  it('blocks the packages that depend on a document nobody sent', () => {
    const withoutGI = documents().filter((d) => d.reference !== 'GI-01');
    const findings = review.validateDocuments(withoutGI, FORM);

    const missing = findings.find((f) => /cites GI-01/.test(f.subject))!;
    assert.equal(missing.severity, 'CRITICAL');
    assert.deepEqual(missing.blocksPackages, ['Groundworks', 'Structure']);
    assert.match(missing.detail, /the document itself says is needed/);
  });

  it('blocks the packages that depend on a document nobody can open', () => {
    const unreadable = documents().map((d) => (d.reference === 'GI-01' ? { ...d, readable: false } : d));
    const findings = review.validateDocuments(unreadable, FORM);

    const broken = findings.find((f) => /cannot be read/.test(f.subject))!;
    assert.equal(broken.severity, 'CRITICAL');
    assert.deepEqual(broken.blocksPackages, ['Groundworks']);
    assert.match(broken.detail, /priced against a guess/);
  });

  /**
   * "As amended" with no schedule is not a contract form. The amendments are
   * where the liabilities live, so this blocks everything.
   */
  it('treats an unstated schedule of amendments as critical, and blocks everything', () => {
    const findings = review.validateDocuments(documents(), { ...FORM, amendmentDocument: undefined });

    const ambiguity = findings.find((f) => /stated as amended/.test(f.subject))!;
    assert.equal(ambiguity.severity, 'CRITICAL');
    assert.deepEqual([...ambiguity.blocksPackages].sort(), ['Groundworks', 'Structure']);
    assert.match(ambiguity.detail, /prices a different contract/);
  });

  it('catches a schedule of amendments that is named and not in the pack', () => {
    const withoutSchedule = documents().filter((d) => d.reference !== 'AMD-01');
    const findings = review.validateDocuments(withoutSchedule, FORM);
    assert.ok(findings.some((f) => /AMD-01 is named and not in the register/.test(f.subject)));
  });

  it('names a document that appears at two revisions', () => {
    const twice = [...documents(), { reference: 'SPEC-01', title: 'Employer’s requirements', revision: 'D', readable: true, informsPackages: [] }];
    const findings = review.validateDocuments(twice, FORM);

    const duplicated = findings.find((f) => /appears at 2 revisions/.test(f.subject))!;
    assert.equal(duplicated.severity, 'MAJOR');
    assert.match(duplicated.detail, /not answerable from the register/);
    // Not blocking. A pack often carries a superseded sheet, and refusing over
    // it would train people to strip the register.
    assert.deepEqual(duplicated.blocksPackages, []);
  });

  it('records the register and reports the blocked packages', () => {
    const reviewId = open();
    const { blockedPackages } = review.recordDocuments(
      asQS(),
      reviewId,
      documents().map((d) => (d.reference === 'GI-01' ? { ...d, readable: false } : d)),
    );
    assert.deepEqual(blockedPackages, ['Groundworks']);

    const position = review.tenderReviewPosition(asQS());
    assert.match(position.summary, /1 package blocked from pricing/);
  });

  it('refuses a contract form with no edition', () => {
    const error = throwsCode(
      () => review.openReview(asQS(), { title: 'x', form: { suite: 'JCT', edition: '', amendmentsStated: false } }),
      'CONTRACT_FORM_REQUIRED',
    );
    assert.match(String(error.message), /"JCT" is a publisher, not a contract/);
  });
});

// ── The scope matrix ───────────────────────────────────────────────────────

describe('tender review · what nobody owns and what two people own', () => {
  const items: review.ScopeItem[] = [
    {
      reference: 'S-01',
      description: 'Break out and dispose of the existing slab',
      source: { document: 'SPEC-01', clause: '2.4' },
      packages: ['Groundworks'],
    },
    {
      reference: 'S-02',
      description: 'Temporary propping to the retained façade',
      source: { document: 'SPEC-01', clause: '2.9' },
      packages: [],
    },
    {
      reference: 'S-03',
      description: 'Builder’s work in connection with the mechanical installation',
      source: { document: 'SPEC-01', clause: '5.1' },
      packages: ['Structure', 'Mechanical'],
    },
  ];

  it('finds the gap and the overlap, and says why each is expensive', () => {
    const findings = review.scopeFindings(items);
    assert.equal(findings.length, 2);

    const gap = findings.find((f) => f.reference === 'S-02')!;
    assert.equal(gap.kind, 'GAP');
    assert.match(gap.detail, /built and nobody priced it/);

    const overlap = findings.find((f) => f.reference === 'S-03')!;
    assert.equal(overlap.kind, 'OVERLAP');
    assert.deepEqual(overlap.packages, ['Structure', 'Mechanical']);
    assert.match(overlap.detail, /loses the bid rather than the job/);
  });

  it('refuses a scope item that does not say which document imposes it', () => {
    const reviewId = open();
    throwsCode(
      () =>
        review.mapScope(asQS(), reviewId, [
          { reference: 'S-01', description: 'Something', source: { document: '  ' }, packages: ['Groundworks'] },
        ]),
      'SCOPE_SOURCE_REQUIRED',
    );
  });

  it('records the matrix and surfaces both on the position', () => {
    const reviewId = open();
    review.recordDocuments(asQS(), reviewId, documents());
    const { gaps, overlaps } = review.mapScope(asQS(), reviewId, items);

    assert.equal(gaps.length, 1);
    assert.equal(overlaps.length, 1);

    const row = review.tenderReviewPosition(asQS()).reviews.find((r) => r.reviewId === reviewId)!;
    assert.equal(row.gaps.length, 1);
    assert.equal(row.overlaps.length, 1);
  });
});

// ── The contract ───────────────────────────────────────────────────────────

describe('tender review · the executed wording, and somebody’s name on the reading', () => {
  const obligation = {
    reference: 'O-01',
    clause: '4.9.2',
    page: 34,
    wording:
      'The final date for payment of an interim payment shall be 28 days from the due date, subject to the Employer having received a valid VAT invoice.',
    interpretation: 'Payment is 28 days from the due date and the clock does not start without a VAT invoice.',
    category: 'PAYMENT' as const,
    response: 'PRICED' as const,
    owner: 'Commercial Manager',
  };

  it('refuses an interpretation with no clause behind it', () => {
    const reviewId = open();
    throwsCode(() => review.interpretContract(asQS(), reviewId, [{ ...obligation, clause: '' }]), 'CLAUSE_REQUIRED');
  });

  /**
   * The exception control is explicit that an AI clause summary never replaces
   * the executed wording — and the same is true of a human summary. The
   * difference between "payment within 30 days" and what clause 4.9.2 actually
   * provides is where the argument is.
   */
  it('refuses an interpretation carrying no verbatim wording', () => {
    const reviewId = open();
    const error = throwsCode(
      () => review.interpretContract(asQS(), reviewId, [{ ...obligation, wording: '  ' }]),
      'WORDING_REQUIRED',
    );
    assert.match(String(error.message), /a summary never replaces it/);
  });

  it('records it as draft until somebody signs the reading', () => {
    const reviewId = open();
    const recorded = review.interpretContract(asQS(), reviewId, [obligation]);
    assert.equal(recorded.recorded, 1);
    assert.equal(recorded.unreviewed, 1);

    const accepted = review.reviewObligation(asOwner(), reviewId, 'O-01', {
      status: 'ACCEPTED',
      note: 'Agreed. The VAT invoice condition is priced into the cash model.',
    });
    assert.equal(accepted.unreviewed, 0);

    throwsCode(() => review.reviewObligation(asOwner(), reviewId, 'O-01', { status: 'REJECTED' }), 'OBLIGATION_REVIEWED');
    throwsCode(() => review.reviewObligation(asOwner(), reviewId, 'O-99', { status: 'ACCEPTED' }), 'OBLIGATION_NOT_FOUND');
  });
});

// ── Qualifications ─────────────────────────────────────────────────────────

describe('tender review · an exclusion has to come from somewhere', () => {
  let reviewId: string;

  before(() => {
    reviewId = open();
    review.recordDocuments(asQS(), reviewId, documents());
    review.mapScope(asQS(), reviewId, [
      {
        reference: 'S-02',
        description: 'Temporary propping to the retained façade',
        source: { document: 'SPEC-01', clause: '2.9' },
        packages: [],
      },
    ]);
  });

  /** `AC-T-WF-02-02`. */
  it('refuses one that answers nothing found in the documents', () => {
    const error = throwsCode(
      () =>
        review.recordQualification(asQS(), reviewId, {
          kind: 'EXCLUSION',
          text: 'The price excludes any works to the existing substation',
          tracesTo: 'S-99',
        }),
      'QUALIFICATION_UNTRACEABLE',
    );
    assert.match(String(error.message), /added on the last afternoon/);
  });

  it('takes one that answers a scope gap', () => {
    const recorded = review.recordQualification(asQS(), reviewId, {
      kind: 'EXCLUSION',
      text: 'The price excludes temporary propping to the retained façade, which no package carries',
      tracesTo: 'S-02',
    });
    assert.equal(recorded.reference, 'Q-001');

    const row = review.tenderReviewPosition(asQS()).reviews.find((r) => r.reviewId === reviewId)!;
    assert.equal(row.qualifications[0]!.tracesTo, 'S-02');
  });

  it('refuses one that says nothing the client could read', () => {
    throwsCode(
      () => review.recordQualification(asQS(), reviewId, { kind: 'ASSUMPTION', text: 'As discussed', tracesTo: 'S-02' }),
      'QUALIFICATION_INSUBSTANTIAL',
    );
  });
});

// ── The freeze, and what an addendum touches ───────────────────────────────

describe('tender review · the freeze is what pricing is built on', () => {
  let reviewId: string;

  before(() => {
    reviewId = open();
  });

  it('refuses to freeze while a package cannot be priced', () => {
    review.recordDocuments(
      asQS(),
      reviewId,
      documents().map((d) => (d.reference === 'GI-01' ? { ...d, readable: false } : d)),
    );

    const error = throwsCode(() => review.freezeReview(asOwner(), reviewId), 'PACKAGES_BLOCKED');
    assert.match(String(error.message), /Groundworks/);
    assert.match(String(error.message), /declare the pack complete while the register says it is not/);
  });

  it('refuses to freeze while an interpretation is unsigned', () => {
    // The report arrives and is readable, so nothing is blocked any more.
    review.recordDocuments(asQS(), reviewId, documents());
    review.interpretContract(asQS(), reviewId, [
      {
        reference: 'O-01',
        clause: '2.26',
        wording: 'The Contractor shall notify the Employer of any Relevant Event forthwith upon becoming aware of it.',
        interpretation: 'Delay notices are immediate, not monthly.',
        category: 'DELAY',
        response: 'PROGRAMMED',
        owner: 'Commercial Manager',
      },
    ]);

    const error = throwsCode(() => review.freezeReview(asOwner(), reviewId), 'OBLIGATIONS_UNREVIEWED');
    assert.match(String(error.message), /O-01 \(cl\. 2\.26\)/);
    assert.match(String(error.message), /opinion of a contract/);
  });

  it('freezes, and hashes what the price is built on', () => {
    review.mapScope(asQS(), reviewId, [
      {
        reference: 'S-01',
        description: 'Break out and dispose of the existing slab',
        source: { document: 'SPEC-01', clause: '2.4' },
        packages: ['Groundworks'],
      },
    ]);
    review.reviewObligation(asOwner(), reviewId, 'O-01', { status: 'ACCEPTED' });
    review.recordQualification(asQS(), reviewId, {
      kind: 'ASSUMPTION',
      text: 'The price assumes the slab is unreinforced below 300mm, per the ground investigation',
      tracesTo: 'S-01',
    });

    const frozen = review.freezeReview(asOwner(), reviewId);
    assert.match(frozen.contentHash, /^sha256:/);

    // And nothing moves after it.
    throwsCode(
      () =>
        review.recordQualification(asQS(), reviewId, {
          kind: 'EXCLUSION',
          text: 'Something added after the price was built on the frozen review',
          tracesTo: 'S-01',
        }),
      'REVIEW_FROZEN',
    );
  });

  /**
   * `AC-T-WF-02-03`. Derived from the frozen review rather than asserted:
   * asking somebody to list the affected packages is asking them to remember a
   * mapping they built a fortnight ago.
   */
  it('works out what an addendum touched, rather than asking', () => {
    const impact = review.assessAddendum(asQS(), reviewId, {
      addendum: 'ADD-04',
      changedDocuments: ['SPEC-01'],
      changedClauses: ['2.26'],
    });

    assert.deepEqual(impact.affectedPackages, ['Groundworks', 'Structure']);
    assert.deepEqual(impact.affectedScopeItems, ['S-01']);
    assert.deepEqual(impact.voidedObligations, ['O-01']);
    // The assumption rested on S-01, whose source document moved.
    assert.deepEqual(impact.affectedQualifications, ['Q-001']);
    assert.match(impact.summary, /2 packages to reprice/);
    assert.match(impact.summary, /1 contract interpretation void/);
  });

  it('says plainly when an addendum touches nothing the review depends on', () => {
    const impact = review.assessAddendum(asQS(), reviewId, {
      addendum: 'ADD-05',
      changedDocuments: ['FORM-07'],
    });
    assert.deepEqual(impact.affectedPackages, []);
    assert.match(impact.summary, /nothing in the frozen review depends on what it changed/);
  });

  it('refuses to measure an addendum against a review that is not frozen', () => {
    const other = open();
    throwsCode(
      () => review.assessAddendum(asQS(), other, { addendum: 'ADD-01', changedDocuments: ['SPEC-01'] }),
      'REVIEW_NOT_FROZEN',
    );
  });
});

// ── The catalogue ──────────────────────────────────────────────────────────

describe('tender review · the event catalogue', () => {
  it('lets an agent extract and read, and never freeze', () => {
    for (const code of ['TENDER_DOCUMENT_VALIDATED', 'SCOPE_GAP_IDENTIFIED', 'CONTRACT_INTERPRETED']) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      // The specification gives an agent clause and scope extraction with
      // citations and confidence.
      assert.equal(definition!.aiAllowed, true, `${code} bars the extraction the specification allows`);
    }

    // The freeze declares the information the price is built on. An agent that
    // could declare it could declare a pack complete.
    const frozen = lookupEventType('TENDER_REVIEW_FROZEN')!;
    assert.equal(frozen.aiAllowed, false);
    assert.equal(frozen.requiresEvidence, true);
    assert.equal(frozen.action, 'FREEZE');

    // The impact of an addendum takes the name the specification gives it under
    // T-WF-06 rather than a second one meaning the same thing.
    assert.ok(lookupEventType('ADDENDUM_IMPACT_ASSESSED'));
  });
});
