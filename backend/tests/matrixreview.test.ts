import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as itt from '../src/domain/itt.ts';
import * as matrixreview from '../src/domain/matrixreview.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Where each requirement stands, in the five words a bid review uses —
 * Confirmed, Assumed, Conflicting, Missing, Decision required — each with its
 * basis, and never a line nobody checked counted as met.
 */

let platform: Platform;
let seed: SeedResult;
let analysisId: string;

const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asPlanner = () => platform.context(seed.users.planner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const line = (reference: string) => matrixreview.matrixPosition(asQS(), analysisId).lines.find((entry) => entry.reference === reference)!;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  analysisId = itt.analyseITT(asQS(), {
    reference: 'ITT-REVIEW-01',
    clientName: 'Telford & Wrekin Council',
    returnBy: '2099-03-01',
    requirements: [
      {
        reference: 'INS',
        category: 'INSURANCE',
        requirement: 'Employers liability and public liability cover',
        mandatory: true,
        evidenceRequired: 'Certificates',
        source: { document: 'ITT.pdf', page: 4, clause: '2.4', quote: 'Employers liability and public liability cover', located: true },
      },
      {
        reference: 'DBS',
        category: 'QUALIFICATION',
        requirement: 'Enhanced DBS checks for all operatives entering occupied homes',
        mandatory: true,
        evidenceRequired: 'Confirmation of enhanced DBS',
      },
      {
        reference: 'Q1',
        category: 'TECHNICAL',
        requirement: 'Describe your approach to the works',
        mandatory: false,
        weightingPercent: 60,
        evidenceRequired: 'A written answer',
        responseLimit: { words: 1000, statedAs: '1,000 words' },
        source: { clause: 'Q1', quote: 'Describe your method', located: false },
      },
      {
        reference: 'Q2',
        category: 'COMMERCIAL',
        requirement: 'Confirm acceptance of the payment terms in Schedule 3',
        mandatory: false,
        weightingPercent: 40,
        evidenceRequired: 'Confirmation',
      },
    ],
    terms: { contractForm: 'JCT Minor Works 2016' },
  }).analysisId;
});

describe('the platform’s own test, in the review’s words', () => {
  it('confirms what the company’s records hold, with the record as its basis', () => {
    const ins = line('INS');
    assert.equal(ins.status, 'CONFIRMED');
    assert.equal(ins.setBy, 'PLATFORM');
    assert.match(ins.basis, /On the company's records: Policies on file/);
    assert.equal(ins.threshold, 'Pass/fail');
    assert.equal(ins.sourceText, 'ITT.pdf, p. 4, 2.4');
  });

  it('calls a gap missing, and a line it cannot test missing too — never met', () => {
    assert.equal(line('DBS').status, 'MISSING');
    assert.match(line('DBS').basis, /Nothing on the company's records meets it/);
    assert.match(line('DBS').action, /Obtain and record the evidence/);
    const q1 = line('Q1');
    assert.equal(q1.status, 'MISSING');
    assert.match(q1.basis, /not treated as met/);
    assert.equal(q1.threshold, '60% of the marks · 1,000 words');
    assert.equal(q1.action, 'Write and approve the answer');
  });

  it('says where a line’s wording could not be found in the documents', () => {
    const position = matrixreview.matrixPosition(asQS(), analysisId);
    assert.deepEqual(position.untraced, ['Q1']);
    assert.match(line('Q1').sourceText, /not found in the documents/);
  });

  it('splits the pass/fail lines into met and needing evidence', () => {
    const position = matrixreview.matrixPosition(asQS(), analysisId);
    assert.deepEqual(position.gates, { met: ['INS'], needEvidence: ['DBS'], cannotMeet: [] });
    assert.equal(position.counts.CONFIRMED, 1);
    assert.equal(position.counts.MISSING, 3);
  });
});

describe('a person’s review of a line', () => {
  it('records an assumption with what it rests on, and it stands', () => {
    const reviewed = matrixreview.reviewRequirement(asQS(), analysisId, {
      reference: 'Q2',
      status: 'ASSUMED',
      basis: 'Schedule 3 is not in the pack; assumed 30-day payment as in the ITT 4.2.',
    });
    assert.equal(reviewed.status, 'ASSUMED');
    assert.equal(reviewed.setBy, seed.users.qs!.auth.actorId);
    assert.match(reviewed.action, /put it to the buyer as a clarification/);
  });

  it('requires a basis, and names the references for a conflict', () => {
    throwsCode(
      () => matrixreview.reviewRequirement(asQS(), analysisId, { reference: 'Q2', status: 'CONFLICTING', basis: 'differs' }),
      'REVIEW_BASIS_REQUIRED',
    );
  });

  it('refuses to confirm a gap the company’s records show — the evidence is recorded there', () => {
    throwsCode(
      () => matrixreview.reviewRequirement(asQS(), analysisId, { reference: 'DBS', status: 'CONFIRMED', basis: 'We have the checks done.' }),
      'RECORD_THE_EVIDENCE',
    );
  });

  it('needs an owner and a date, on or before the return, for a decision', () => {
    throwsCode(
      () => matrixreview.reviewRequirement(asQS(), analysisId, { reference: 'Q2', status: 'DECISION_REQUIRED', basis: 'Accept the terms or qualify.' }),
      'DECISION_NEEDS_OWNER_AND_DATE',
    );
    throwsCode(
      () =>
        matrixreview.reviewRequirement(asQS(), analysisId, {
          reference: 'Q2',
          status: 'DECISION_REQUIRED',
          basis: 'Accept the terms or qualify.',
          owner: 'OWNER',
          decisionDue: '2099-04-01',
        }),
      'DECISION_NEEDS_OWNER_AND_DATE',
    );
    const decided = matrixreview.reviewRequirement(asQS(), analysisId, {
      reference: 'Q2',
      status: 'DECISION_REQUIRED',
      basis: 'Accept the 30-day terms or qualify the bid.',
      action: 'Director to decide whether the payment terms are acceptable',
      owner: 'OWNER',
      decisionDue: '2099-02-20',
    });
    assert.equal(decided.owner, 'OWNER');
    assert.equal(decided.due, '2099-02-20');
    assert.equal(decided.action, 'Director to decide whether the payment terms are acceptable');
  });

  it('marks a pass/fail line that cannot be obtained, and the gates say so', () => {
    matrixreview.reviewRequirement(asQS(), analysisId, {
      reference: 'DBS',
      status: 'MISSING',
      basis: 'No operatives hold enhanced DBS and checks take eight weeks.',
      obtainable: false,
    });
    const position = matrixreview.matrixPosition(asQS(), analysisId);
    assert.deepEqual(position.gates.cannotMeet, ['DBS']);
    assert.match(line('DBS').action, /Decide whether to bid/);
    throwsCode(
      () => matrixreview.reviewRequirement(asQS(), analysisId, { reference: 'Q1', status: 'MISSING', basis: 'Not yet drafted at all.', obtainable: false }),
      'OBTAINABLE_ONLY_FOR_MISSING_GATE',
    );
  });

  it('follows the records: evidence recorded after a missing review confirms the line', () => {
    matrixreview.reviewRequirement(asQS(), analysisId, { reference: 'INS', status: 'MISSING', basis: 'Certificates not yet seen by the bid team.' });
    const ins = line('INS');
    assert.equal(ins.status, 'CONFIRMED', 'the records hold the policies, so the line is confirmed from them');
    assert.match(ins.basis, /Recorded since the line was reviewed as missing/);
  });

  it('is refused to someone who may only read the tender, and recorded as a human act', () => {
    throwsCode(
      () => matrixreview.reviewRequirement(asPlanner(), analysisId, { reference: 'Q1', status: 'ASSUMED', basis: 'Assumed a 1,000 word limit.' }),
      'ACCESS_DENIED',
    );
    assert.equal(lookupEventType('REQUIREMENT_REVIEWED')?.aiAllowed, false);
    for (const [method, pattern] of [
      ['GET', '/v1/pipeline/analyses/:analysisId/position'],
      ['POST', '/v1/pipeline/analyses/:analysisId/reviews'],
    ] as const) {
      assert.ok(ROUTES.some((route) => route.method === method && route.pattern === pattern), `${method} ${pattern}`);
    }
  });
});
