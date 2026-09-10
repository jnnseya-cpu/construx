import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as evidence from '../src/domain/evidenceclaim.ts';
import * as itt from '../src/domain/itt.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The evidence registry — `L7.2`, `RSP-001`, `GE-EV-01`, `SUB-003`.
 *
 * `EvidenceItem` was already a file with a hash on it, which proves nothing was
 * altered and does not prove anything was true. A submission is a stack of
 * sentences somebody will score, and one that turns out to be untrue is not
 * marked down — it is thrown out, with everything else in the submission spent
 * for nothing.
 *
 * So a claim is its own record: what is asserted, what proves it, who checked,
 * and when it stops. These tests are about the four rules that make it worth
 * having rather than the fields that make it exist.
 */

let platform: Platform;
let seed: SeedResult;
const HASH = `sha256:${'e'.repeat(64)}`;
const OTHER = `sha256:${'f'.repeat(64)}`;

/** Holds ESTIMATE_TENDER C — asserts. */
const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds ESTIMATE_TENDER A — verifies. A different person, which is the point. */
const asOwner = () => platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const future = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('a claim is what is asserted, not what is filed', () => {
  it('is reachable, classified, and verification refuses an AI actor', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/evidence/claims'],
      ['POST', '/v1/evidence/claims'],
      ['POST', '/v1/evidence/claims/:claimId/verify'],
      ['POST', '/v1/evidence/claims/:claimId/reject'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    // A claim is authored rather than audited, so it sits with the submission it
    // backs. EVIDENCE_AUDIT carries no C or A in the matrix, and correctly:
    // nobody authors the audit trail.
    assert.equal(classifyEntity('EvidenceClaim')?.area, 'ESTIMATE_TENDER');

    // Attaching a certificate to a sentence is clerical and reversible, so an
    // agent may do it. Deciding the certificate proves the sentence is a
    // judgement somebody signs their name to.
    assert.equal(lookupEventType('EVIDENCE_CLAIM_ASSERTED')?.aiAllowed, true);
    assert.equal(lookupEventType('EVIDENCE_CLAIM_VERIFIED')?.aiAllowed, false);
    assert.equal(lookupEventType('EVIDENCE_CLAIM_REJECTED')?.aiAllowed, false);
  });

  it('refuses a claim nobody could act on', () => {
    const error = throwsCode(
      () => evidence.assertClaim(asQS(), { kind: 'INSURANCE', claim: 'insurance', sourceHash: HASH }),
      'CLAIM_REQUIRED',
    );
    assert.match(String(error.message), /evidences nothing in particular/);
  });

  it('refuses two dates that contradict each other', () => {
    throwsCode(
      () =>
        evidence.assertClaim(asQS(), {
          kind: 'CERTIFICATE',
          claim: 'We hold ISO 14001 certification for environmental management',
          sourceHash: HASH,
          issuedAt: '2026-06-01',
          expiresAt: '2025-06-01',
        }),
      'EXPIRY_BEFORE_ISSUE',
    );
  });

  it('records the sentence, the document and the day it stops', () => {
    const claim = evidence.assertClaim(asQS(), {
      kind: 'INSURANCE',
      claim: 'Our public liability cover is £10,000,000 for any one occurrence',
      sourceHash: HASH,
      issuedBy: 'Zurich Municipal',
      issuedAt: '2026-04-01',
      expiresAt: future(400),
      covers: ['R-03'],
    });

    assert.match(claim.reference, /^EVC-\d+$/);
    assert.equal(claim.status, 'PENDING');
    assert.equal(claim.assertedBy, seed.users.qs!.auth.actorId);
    assert.deepEqual(claim.covers, ['R-03']);
    // The document is registered as evidence rather than duplicated here: one
    // answer to "where is the certificate".
    assert.ok(platform.ledger.get({ refType: 'EvidenceItem', refId: claim.evidenceId }));
  });

  it('refuses the same claim against the same document twice', () => {
    const error = throwsCode(
      () =>
        evidence.assertClaim(asQS(), {
          kind: 'INSURANCE',
          claim: 'Our public liability cover is £10,000,000 for any one occurrence',
          sourceHash: HASH,
        }),
      'CLAIM_ALREADY_ASSERTED',
    );
    assert.match(String(error.message), /the stale one is whichever nobody remembers/);
  });
});

describe('the check has to be done by somebody else', () => {
  let claimId: string;

  before(() => {
    claimId = evidence.evidenceRegister(asQS()).claims[0]!.id;
  });

  it('refuses the asserter verifying their own claim', () => {
    const error = throwsCode(() => evidence.verifyClaim(asQS(), claimId, { method: 'Read it and it looks right' }), 'SELF_VERIFICATION_REFUSED');
    assert.match(String(error.message), /a check done by the person being checked is not a check/);
  });

  it('refuses a method that is a signature on nothing', () => {
    throwsCode(() => evidence.verifyClaim(asOwner(), claimId, { method: 'yes' }), 'VERIFICATION_METHOD_REQUIRED');
  });

  it('records who checked and how', () => {
    const verified = evidence.verifyClaim(asOwner(), claimId, {
      method: 'Compared against the insurer’s schedule of cover and the broker’s confirmation of premium paid',
    });
    assert.equal(verified.status, 'APPROVED');
    assert.equal(verified.verifiedBy, seed.users.owner!.auth.actorId);
    assert.match(verified.verificationMethod!, /insurer/);
  });

  it('refuses a second verification', () => {
    throwsCode(
      () => evidence.verifyClaim(asOwner(), claimId, { method: 'Checked it a second time for no reason' }),
      'CLAIM_ALREADY_VERIFIED',
    );
  });

  it('refuses verifying something that has already lapsed', () => {
    const lapsed = evidence.assertClaim(asQS(), {
      kind: 'ACCREDITATION',
      claim: 'We held CHAS accreditation throughout the 2024 financial year',
      sourceHash: OTHER,
      expiresAt: '2024-12-31',
    });

    const error = throwsCode(
      () => evidence.verifyClaim(asOwner(), lapsed.id, { method: 'Compared against the certificate on file' }),
      'EVIDENCE_EXPIRED',
    );
    // An approved claim nobody can stand behind is worse than no claim.
    assert.match(String(error.message), /worse than no claim at all/);
  });
});

describe('the register is judged against a day, not against today', () => {
  it('reports a claim as expired on a date after it lapses', () => {
    const claim = evidence.evidenceRegister(asQS()).claims.find((entry) => entry.kind === 'INSURANCE')!;
    assert.equal(claim.standing, 'APPROVED');
    assert.equal(evidence.standingOf(claim, future(900)), 'EXPIRED');
    assert.equal(evidence.standingOf(claim, future(10)), 'APPROVED');
  });

  it('counts each standing and lists what lapses soon', () => {
    const register = evidence.evidenceRegister(asQS(), future(380));
    assert.ok(register.approved >= 1);
    assert.ok(register.lapsingSoon.some((entry) => entry.daysLeft <= 60));
    assert.match(register.summary, /lapse within 60 days/);
  });

  it('keeps a refusal on the record and will not verify over it', () => {
    const doomed = evidence.assertClaim(asQS(), {
      kind: 'CASE_STUDY',
      claim: 'We delivered the Rossendale scheme six weeks ahead of programme',
      sourceHash: `sha256:${'a'.repeat(64)}`,
    });

    throwsCode(() => evidence.rejectClaim(asOwner(), doomed.id, { reason: '   ' }), 'REJECTION_REASON_REQUIRED');

    const rejected = evidence.rejectClaim(asOwner(), doomed.id, {
      reason: 'The completion certificate shows two weeks ahead, not six',
    });
    assert.equal(rejected.status, 'REJECTED');

    const error = throwsCode(
      () => evidence.verifyClaim(asOwner(), doomed.id, { method: 'Reversing the refusal after the fact' }),
      'CLAIM_REJECTED',
    );
    assert.match(String(error.message), /part of the history of the bid/);
  });

  it('leaves an expired or rejected claim out of what is approved on a day', () => {
    const approved = evidence.approvedOn(asQS(), new Date().toISOString().slice(0, 10));
    assert.ok(approved.every((claim) => claim.status === 'APPROVED'));
    assert.ok(!approved.some((claim) => claim.kind === 'CASE_STUDY'), 'a rejected claim is not approved');
    assert.ok(
      !approved.some((claim) => claim.expiresAt !== undefined && claim.expiresAt < new Date().toISOString().slice(0, 10)),
    );
  });
});

describe('the submission refuses evidence that lapses before it is read', () => {
  let packId: string;

  before(() => {
    const analysis = itt.analyseITT(asQS(), {
      reference: 'ITT-EVIDENCE-01',
      clientName: 'Pendle Borough Council',
      returnBy: future(120),
      estimatedValueMinor: 120_000_000,
      durationWeeks: 48,
      requirements: [
        {
          reference: 'E-01',
          category: 'TECHNICAL',
          requirement: 'Describe your approach to working adjacent to a live railway',
          mandatory: true,
          weightingPercent: 100,
          evidenceRequired: 'Method statement',
        },
      ],
      terms: { contractForm: 'NEC4 Option A' },
    });

    const { pack } = bidresponse.planBidResponse(asQS(), { analysisId: analysis.analysisId });
    packId = pack.id;
  });

  it('names the claim, its expiry and the day the buyer reads it', () => {
    // Current today, and gone before the return date. This is the case checking
    // against "now" answers wrongly, and the one the buyer will notice.
    const lapsing = evidence.assertClaim(asQS(), {
      kind: 'CERTIFICATE',
      claim: 'Our Network Rail principal contractor licence is current',
      sourceHash: `sha256:${'b'.repeat(64)}`,
      expiresAt: future(30),
    });
    evidence.verifyClaim(asOwner(), lapsing.id, {
      method: 'Compared against the licence certificate issued by Network Rail',
    });

    const pack = bidresponse.bidResponsePack(asQS(), packId);
    assert.equal(pack.completeness.lapsedEvidence.length, 1);
    assert.equal(pack.completeness.lapsedEvidence[0]!.reference, lapsing.reference);
    assert.equal(pack.completeness.ready, false);
    assert.match(pack.completeness.summary, /lapses first/);
  });

  it('refuses the issue and says which document, and by when', () => {
    // The drafting pass needs a reasoning provider and this platform has none,
    // so the section stays outstanding. That is the more useful shape of the
    // test anyway: the refusal has to name *both* reasons rather than stopping
    // at the first, because fixing them one attempt at a time is how somebody
    // decides at 4pm that the check is the problem.
    const error = throwsCode(() => bidresponse.issueBidResponse(asQS(), { packId }), 'BID_RESPONSE_INCOMPLETE');
    assert.match(String(error.message), /have no response/);
    assert.match(String(error.message), /expires before/);
    assert.match(String(error.message), /File the current document and assert against that/);
  });

  it('is not ready on the evidence alone, with every deliverable answered', () => {
    // `bidCompleteness` is pure, so the case where the only thing wrong is the
    // evidence can be stated exactly rather than approximated around a pack
    // that also needs a model to finish.
    const pack = bidresponse.bidResponsePack(asQS(), packId);
    const answered = {
      ...pack,
      sections: pack.sections.map((section) => ({
        ...section,
        status: 'DRAFTED' as const,
        body: ['Written.'],
      })),
    };

    const claims = evidence.approvedOn(asQS(), new Date().toISOString().slice(0, 10));
    const complete = bidresponse.bidCompleteness(answered, [], claims);

    assert.equal(complete.unanswered.length, 0);
    assert.equal(complete.undated.length, 0);
    assert.equal(complete.written, pack.sections.length);
    // Every deliverable answered, every deadline dated, and still not ready.
    assert.equal(complete.ready, false);
    assert.equal(complete.lapsedEvidence.length, 1);

    // And ready once the evidence is out of the way, so the refusal above is
    // this one thing rather than a check that never passes.
    assert.equal(bidresponse.bidCompleteness(answered, [], []).ready, true);
  });
});
