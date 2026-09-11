import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as addendum from '../src/domain/addendum.ts';
import * as itt from '../src/domain/itt.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Targeted invalidation — `AS-02`.
 *
 * An addendum lands eleven days before return. It changes a drawing, moves a
 * date and rewrites one requirement. The bid team reads the covering email,
 * agrees it looks minor, and carries on — and the response written three weeks
 * ago against the old wording goes in unchanged, because nothing on any screen
 * distinguishes a section written against the current requirement from one
 * written against a superseded one.
 *
 * These tests are about three things: the delta is **computed** rather than
 * described, the invalidation is **targeted** so untouched work stays good, and
 * a material change **blocks the submission** until somebody has looked.
 */

let platform: Platform;
let seed: SeedResult;
let analysisId: string;

/** Holds ESTIMATE_TENDER U — assesses and reviews. */
const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const ORIGINAL = [
  {
    reference: 'A-01',
    category: 'TECHNICAL' as const,
    requirement: 'Describe your methodology for deep drainage in live carriageway',
    mandatory: true,
    weightingPercent: 40,
    evidenceRequired: 'Method statement, maximum four sides',
  },
  {
    reference: 'A-02',
    category: 'SOCIAL_VALUE' as const,
    requirement: 'Set out the local employment commitments you will make',
    mandatory: false,
    weightingPercent: 20,
    evidenceRequired: 'Narrative with measurable commitments',
  },
  {
    reference: 'A-03',
    category: 'PROGRAMME' as const,
    requirement: 'Provide a resource-loaded programme to sectional completion',
    mandatory: true,
    weightingPercent: 40,
    evidenceRequired: 'Programme in native format',
    dueBy: '2027-02-01',
  },
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  analysisId = itt.analyseITT(asQS(), {
    reference: 'ITT-ADDENDUM-01',
    clientName: 'Calderdale Metropolitan Borough Council',
    returnBy: '2027-03-01',
    estimatedValueMinor: 340_000_000,
    durationWeeks: 84,
    requirements: ORIGINAL,
    terms: { contractForm: 'NEC4 Option A' },
  }).analysisId;
});

describe('the delta is computed, not described', () => {
  it('is reachable, and both events are in the closed catalogue', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/pipeline/analyses/:analysisId/addenda'],
      ['POST', '/v1/pipeline/analyses/:analysisId/addenda'],
      ['POST', '/v1/pipeline/analyses/:analysisId/addenda/review'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }
    for (const code of ['TENDER_ADDENDUM_ASSESSED', 'TENDER_ADDENDUM_IMPACT_REVIEWED']) {
      assert.ok(lookupEventType(code), `${code} is not declared`);
    }
  });

  it('names every kind of movement, and grades each', () => {
    const before = ORIGINAL.map((line) => ({ ...line, owner: 'QS' as never, status: 'GAP' as never, evidenceRequired: line.evidenceRequired }));
    const impacts = addendum.impactsBetween('ADD-01', before as never, [
      // Reworded, and mandatory: the case a perfect answer scores nothing.
      { reference: 'A-01', requirement: 'Describe your methodology for deep drainage under traffic management', mandatory: true, weightingPercent: 40 },
      // Reweighted only. Minor: it moves where effort is worth spending, not
      // whether the submission is compliant.
      { reference: 'A-02', requirement: 'Set out the local employment commitments you will make', mandatory: false, weightingPercent: 10 },
      // Withdrawn: A-03 is absent.
      // New, and mandatory.
      { reference: 'A-04', requirement: 'Confirm your cyber essentials plus certification', mandatory: true, weightingPercent: 10 },
    ]);

    const by = new Map(impacts.map((impact) => [`${impact.reference}:${impact.kind}`, impact]));
    assert.ok(by.has('A-01:REWORDED'));
    assert.equal(by.get('A-01:REWORDED')!.material, true);
    assert.ok(by.has('A-02:WEIGHTING_CHANGED'));
    assert.equal(by.get('A-02:WEIGHTING_CHANGED')!.material, false);
    assert.ok(by.has('A-03:REMOVED'));
    assert.equal(by.get('A-03:REMOVED')!.material, true);
    assert.ok(by.has('A-04:ADDED'));
    assert.equal(by.get('A-04:ADDED')!.material, true);
  });

  it('reports nothing when nothing moved', () => {
    const before = ORIGINAL.map((line) => ({ ...line, owner: 'QS' as never, status: 'GAP' as never }));
    const impacts = addendum.impactsBetween(
      'ADD-00',
      before as never,
      ORIGINAL.map((line) => ({
        reference: line.reference,
        requirement: line.requirement,
        mandatory: line.mandatory,
        weightingPercent: line.weightingPercent,
        ...(line.dueBy ? { dueBy: line.dueBy } : {}),
      })),
    );
    // An addendum that changed nothing in the requirements is a covering letter,
    // and filling the list with noise would make the real ones read past.
    assert.deepEqual(impacts, []);
  });

  it('catches a date that moved and a requirement that became mandatory', () => {
    const before = ORIGINAL.map((line) => ({ ...line, owner: 'QS' as never, status: 'GAP' as never }));
    const impacts = addendum.impactsBetween('ADD-02', before as never, [
      { reference: 'A-01', requirement: ORIGINAL[0]!.requirement, mandatory: true, weightingPercent: 40 },
      { reference: 'A-02', requirement: ORIGINAL[1]!.requirement, mandatory: true, weightingPercent: 20 },
      { reference: 'A-03', requirement: ORIGINAL[2]!.requirement, mandatory: true, weightingPercent: 40, dueBy: '2027-01-15' },
    ]);

    const mandatory = impacts.find((impact) => impact.kind === 'MANDATORY_CHANGED')!;
    assert.equal(mandatory.reference, 'A-02');
    assert.match(mandatory.detail, /a gap on it now ends the bid/);

    const moved = impacts.find((impact) => impact.kind === 'DEADLINE_MOVED')!;
    assert.equal(moved.reference, 'A-03');
    assert.match(moved.detail, /2027-01-15 rather than 2027-02-01/);
  });
});

describe('recording one, and what it refuses', () => {
  it('refuses an assessment with no summary and one with no revised set', () => {
    throwsCode(
      () => addendum.assessAddendum(asQS(), analysisId, { reference: 'ADD-01', issuedOn: '2027-02-10', summary: '  ', requirements: [{ reference: 'A-01', requirement: 'x', mandatory: true }] }),
      'ADDENDUM_SUMMARY_REQUIRED',
    );
    const error = throwsCode(
      () => addendum.assessAddendum(asQS(), analysisId, { reference: 'ADD-01', issuedOn: '2027-02-10', summary: 'Drainage reworded', requirements: [] }),
      'REVISED_REQUIREMENTS_REQUIRED',
    );
    // An empty set is not "nothing changed", it is "everything was withdrawn".
    assert.match(String(error.message), /every requirement having been withdrawn/);
  });

  it('records the addendum and raises one impact per movement', () => {
    const { addendum: entry, impacts } = addendum.assessAddendum(asQS(), analysisId, {
      reference: 'ADD-01',
      issuedOn: '2027-02-10',
      summary: 'Drainage question reworded, social value reweighted, programme question withdrawn',
      requirements: [
        { reference: 'A-01', requirement: 'Describe your methodology for deep drainage under traffic management', mandatory: true, weightingPercent: 40 },
        { reference: 'A-02', requirement: ORIGINAL[1]!.requirement, mandatory: false, weightingPercent: 10 },
      ],
    });

    assert.equal(entry.reference, 'ADD-01');
    assert.equal(entry.assessedBy, seed.users.qs!.auth.actorId);
    assert.equal(impacts.length, entry.impacts);
    assert.ok(entry.material >= 2, 'a reword and a withdrawal are both material');
    assert.ok(impacts.every((impact) => impact.status === 'OPEN'));
  });

  it('refuses the same addendum twice', () => {
    const error = throwsCode(
      () =>
        addendum.assessAddendum(asQS(), analysisId, {
          reference: 'ADD-01',
          issuedOn: '2027-02-10',
          summary: 'The same one again',
          requirements: [{ reference: 'A-01', requirement: 'x', mandatory: true }],
        }),
      'ADDENDUM_ALREADY_ASSESSED',
    );
    assert.match(String(error.message), /somebody would clear the wrong ones/);
  });

  it('does not rewrite the matrix it was assessed against', () => {
    // The analysis is what was read on the day and stays that. Rewriting it
    // would destroy the position a clarification or a claim is argued from.
    const analysis = itt.complianceMatrix(asQS(), analysisId);
    assert.equal(analysis.matrix.length, ORIGINAL.length);
    assert.equal(analysis.matrix.find((line) => line.reference === 'A-01')!.requirement, ORIGINAL[0]!.requirement);
  });

  it('blocks the submission while a material change is unreviewed, and says so', () => {
    const register = addendum.addendumRegister(asQS(), analysisId);
    assert.equal(register.submissionBlocked, true);
    assert.ok(register.openMaterial >= 2);
    assert.match(register.summary, /The submission is blocked until each is reviewed/);
  });

  it('refuses a review that is a tick rather than a conclusion', () => {
    const error = throwsCode(
      () => addendum.reviewImpact(asQS(), analysisId, { addendum: 'ADD-01', reference: 'A-01', note: 'ok' }),
      'REVIEW_NOTE_REQUIRED',
    );
    assert.match(String(error.message), /A tick is not a review/);
  });

  it('clears one at a time, and counts what is left', () => {
    const open = addendum.openImpacts(asQS(), analysisId);
    const material = open.filter((impact) => impact.material);
    let remaining = material.length;

    for (const impact of material) {
      const { openMaterial } = addendum.reviewImpact(asQS(), analysisId, {
        addendum: impact.addendum,
        reference: impact.reference,
        note: 'Section rewritten against the new wording and the price checked against the revised scope',
      });
      remaining -= 1;
      assert.equal(openMaterial, remaining);
    }

    const register = addendum.addendumRegister(asQS(), analysisId);
    assert.equal(register.submissionBlocked, false);
    // The minor one is still open and does not block, which is the point of
    // grading them: a block nobody can clear is a block everybody works around.
    assert.ok(register.openMinor > 0);
    assert.match(register.summary, /Nothing blocks the submission/);
  });

  it('refuses to review something already reviewed', () => {
    throwsCode(
      () =>
        addendum.reviewImpact(asQS(), analysisId, {
          addendum: 'ADD-01',
          reference: 'A-01',
          note: 'Reviewing it a second time for no reason at all',
        }),
      'IMPACT_NOT_FOUND',
    );
  });
});

describe('the invalidation is targeted', () => {
  let packId: string;
  let freshAnalysisId: string;

  before(() => {
    freshAnalysisId = itt.analyseITT(asQS(), {
      reference: 'ITT-ADDENDUM-02',
      clientName: 'Pendle Borough Council',
      returnBy: '2027-04-01',
      estimatedValueMinor: 180_000_000,
      durationWeeks: 60,
      requirements: ORIGINAL,
      terms: { contractForm: 'NEC4 Option A' },
    }).analysisId;

    packId = bidresponse.planBidResponse(asQS(), { analysisId: freshAnalysisId }).pack.id;
  });

  it('marks only the section whose own requirement moved', () => {
    // Draft every section by hand: the platform in this test has no reasoning
    // provider, and what is being asserted is the invalidation rather than the
    // drafting.
    const pack = bidresponse.bidResponsePack(asQS(), packId);
    const drafted = {
      ...pack,
      sections: pack.sections.map((section) => ({ ...section, status: 'DRAFTED' as const, body: ['Written.'] })),
    };

    const { impacts } = addendum.assessAddendum(asQS(), freshAnalysisId, {
      reference: 'ADD-09',
      issuedOn: '2027-03-10',
      summary: 'Drainage question reworded',
      requirements: [
        { reference: 'A-01', requirement: 'Describe your methodology for deep drainage under a live railway', mandatory: true, weightingPercent: 40 },
        { reference: 'A-02', requirement: ORIGINAL[1]!.requirement, mandatory: false, weightingPercent: 20 },
        { reference: 'A-03', requirement: ORIGINAL[2]!.requirement, mandatory: true, weightingPercent: 40, dueBy: '2027-02-01' },
      ],
    });
    assert.equal(impacts.length, 1, 'exactly one requirement moved');

    const complete = bidresponse.bidCompleteness(drafted, [], [], addendum.openImpacts(asQS(), freshAnalysisId));

    assert.equal(complete.staleSections.length, 1);
    assert.equal(complete.staleSections[0]!.key, 'A-01');
    assert.equal(complete.staleSections[0]!.addendum, 'ADD-09');
    // Every other section is untouched. A full re-plan would have reset them.
    assert.ok(complete.staleSections.every((entry) => entry.key !== 'A-02'));
    assert.equal(complete.unanswered.length, 0);
    assert.equal(complete.ready, false);
    assert.match(complete.summary, /answering a requirement an addendum has changed/);
  });

  it('does not report a section nobody has written yet as stale', () => {
    // It is already outstanding. Counting it twice would say the same work
    // needs doing in two places.
    const pack = bidresponse.bidResponsePack(asQS(), packId);
    const complete = bidresponse.bidCompleteness(pack, [], [], addendum.openImpacts(asQS(), freshAnalysisId));
    assert.equal(complete.staleSections.length, 0);
    assert.ok(complete.unanswered.some((entry) => entry.key === 'A-01'));
  });

  it('stops marking it stale the moment somebody records what was done', () => {
    addendum.reviewImpact(asQS(), freshAnalysisId, {
      addendum: 'ADD-09',
      reference: 'A-01',
      note: 'Rewritten against the railway wording and re-reviewed by the technical lead',
    });

    const pack = bidresponse.bidResponsePack(asQS(), packId);
    const drafted = {
      ...pack,
      sections: pack.sections.map((section) => ({ ...section, status: 'DRAFTED' as const, body: ['Written.'] })),
    };
    const complete = bidresponse.bidCompleteness(drafted, [], [], addendum.openImpacts(asQS(), freshAnalysisId));
    assert.equal(complete.staleSections.length, 0);
    assert.equal(complete.ready, true);
  });
});
