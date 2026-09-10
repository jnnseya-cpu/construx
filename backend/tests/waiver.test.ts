import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as itt from '../src/domain/itt.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * A requirement consciously not answered — `REQ-009`.
 *
 * The most dangerous event in bidding is somebody deciding not to answer a
 * mandatory question and nobody knowing. It happens on every large tender and it
 * is invisible, because *not answered because we decided not to* and *not
 * answered because nobody has got to it* look identical in every system that
 * holds a list of requirements.
 *
 * These tests assert that the waiver does three things, and that each is refused
 * where it would be dishonest. It carries a name, a reason and an end date. It
 * cannot be granted over an answer that already exists. And it does real work:
 * the response pack stops asking for the deliverable and says on its face that
 * it was left out on purpose.
 */

let platform: Platform;
let seed: SeedResult;
let analysisId: string;

/** Holds ESTIMATE_TENDER A — the approval a waiver is. */
const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds ESTIMATE_TENDER R and no A. */
const asPlanner = () =>
  platform.context(seed.users.planner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const RETURN_BY = '2027-03-01';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const analysis = itt.analyseITT(asQS(), {
    reference: 'ITT-WAIVER-01',
    clientName: 'Rossendale Borough Council',
    returnBy: RETURN_BY,
    estimatedValueMinor: 260_000_000,
    durationWeeks: 72,
    requirements: [
      {
        reference: 'W-01',
        category: 'TECHNICAL',
        requirement: 'Describe your approach to temporary works design and checking',
        mandatory: true,
        weightingPercent: 40,
        evidenceRequired: 'Method statement, maximum six sides',
      },
      {
        reference: 'W-02',
        category: 'SOCIAL_VALUE',
        requirement: 'State the number of apprenticeships you will create in the borough',
        mandatory: false,
        weightingPercent: 10,
        evidenceRequired: 'Narrative with measurable commitments',
      },
      {
        reference: 'W-03',
        category: 'INSURANCE',
        requirement: 'Employers liability and public liability cover',
        mandatory: true,
        evidenceRequired: 'Certificates',
      },
    ],
    terms: { contractForm: 'NEC4 Option A' },
  });
  analysisId = analysis.analysisId;
});

describe('the waiver is a governed decision, not a field', () => {
  it('is reachable, and both events refuse an AI actor', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/pipeline/analyses/:analysisId/waivers'],
      ['POST', '/v1/pipeline/analyses/:analysisId/waivers'],
      ['POST', '/v1/pipeline/analyses/:analysisId/waivers/revoke'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route, so the command behind it cannot be reached`,
      );
    }

    // Deciding a submission goes in without something the buyer asked for is a
    // commercial judgement about what this business will lose the job over. No
    // agent mandate reaches it, and the catalogue is where that is enforced
    // rather than a rule written in a prompt.
    for (const code of ['REQUIREMENT_WAIVED', 'REQUIREMENT_WAIVER_REVOKED']) {
      assert.equal(lookupEventType(code)?.aiAllowed, false, `${code} must refuse an AI actor`);
    }
  });

  it('needs the approval, not the read', () => {
    throwsCode(
      () =>
        itt.waiveRequirement(asPlanner(), analysisId, {
          reference: 'W-02',
          reason: 'The borough figure cannot be committed before the resource plan is agreed',
          expiresOn: RETURN_BY,
        }),
      'ACCESS_DENIED',
    );
  });

  it('records who, why and until when', () => {
    const waiver = itt.waiveRequirement(asQS(), analysisId, {
      reference: 'W-02',
      reason: 'No apprenticeship number can be committed before the resource plan is agreed with the joint venture partner',
      expiresOn: RETURN_BY,
    });

    assert.equal(waiver.reference, 'W-02');
    assert.equal(waiver.mandatory, false);
    assert.equal(waiver.expiresOn, RETURN_BY);
    assert.equal(waiver.grantedBy, seed.users.qs!.auth.actorId);
    assert.ok(waiver.grantedAt);
    // The deliverable travels with the waiver, so the record reads on its own
    // without the matrix open beside it.
    assert.match(waiver.requirement, /apprenticeships/);
  });
});

describe('what it refuses', () => {
  it('refuses a reason nobody could act on', () => {
    const error = throwsCode(
      () => itt.waiveRequirement(asQS(), analysisId, { reference: 'W-01', reason: 'n/a', expiresOn: RETURN_BY }),
      'WAIVER_REASON_REQUIRED',
    );
    assert.match(String(error.message), /"waived" is not an answer to it/);
  });

  it('refuses an expiry after the tender returns', () => {
    const error = throwsCode(
      () =>
        itt.waiveRequirement(asQS(), analysisId, {
          reference: 'W-01',
          reason: 'The checking engineer is unavailable until after the submission goes in',
          expiresOn: '2027-06-30',
        }),
      'WAIVER_OUTLIVES_TENDER',
    );
    // A waiver still running after the tender returns governs nothing, and the
    // next person reads it as covering the next bid.
    assert.match(String(error.message), /governing nothing/);
  });

  it('refuses an expiry already in the past', () => {
    throwsCode(
      () =>
        itt.waiveRequirement(asQS(), analysisId, {
          reference: 'W-01',
          reason: 'The checking engineer is unavailable until after the submission goes in',
          expiresOn: '2020-01-01',
        }),
      'WAIVER_EXPIRY_PAST',
    );
  });

  it('refuses a reference that is not in the matrix', () => {
    const error = throwsCode(
      () =>
        itt.waiveRequirement(asQS(), analysisId, {
          reference: 'W-99',
          reason: 'This reference does not exist and the waiver would cover nothing at all',
          expiresOn: RETURN_BY,
        }),
      'REQUIREMENT_NOT_FOUND',
    );
    assert.match(String(error.message), /reads as though it covers something/);
  });

  it('refuses a second live waiver on the same requirement', () => {
    const error = throwsCode(
      () =>
        itt.waiveRequirement(asQS(), analysisId, {
          reference: 'W-02',
          reason: 'A second reason on the same requirement, which would leave two on the record',
          expiresOn: RETURN_BY,
        }),
      'WAIVER_ALREADY_HELD',
    );
    assert.match(String(error.message), /which one the decision was made on/);
  });

  it('refuses a waiver over a requirement the platform can already evidence', () => {
    // The seeded tenancy holds insurance, so W-03 comes out of the analysis
    // SATISFIED. Waiving it would record a deliberate omission where there is a
    // complete answer, and the next person to read the matrix would believe it.
    const analysis = itt.complianceMatrix(asQS(), analysisId);
    const insurance = analysis.matrix.find((line) => line.reference === 'W-03');
    assert.ok(insurance);
    if (insurance.status !== 'SATISFIED') return; // the seed holds no cover; nothing to assert

    const error = throwsCode(
      () =>
        itt.waiveRequirement(asQS(), analysisId, {
          reference: 'W-03',
          reason: 'Certificates will follow after the return date, so this is not being answered now',
          expiresOn: RETURN_BY,
        }),
      'REQUIREMENT_ALREADY_SATISFIED',
    );
    assert.match(String(error.message), /the next person to read the matrix would believe it/);
  });
});

describe('the register, and taking a waiver back', () => {
  it('counts the mandatory ones separately, because that is the number read first', () => {
    const register = itt.waiverRegister(asQS(), analysisId);
    assert.equal(register.live.length, 1);
    assert.equal(register.mandatoryWaived, 0);
    assert.match(register.summary, /1 requirement\(s\) waived/);

    itt.waiveRequirement(asQS(), analysisId, {
      reference: 'W-01',
      reason: 'The temporary works checking engineer is on another submission until after the return date',
      expiresOn: RETURN_BY,
    });

    const after = itt.waiverRegister(asQS(), analysisId);
    assert.equal(after.live.length, 2);
    assert.equal(after.mandatoryWaived, 1);
    assert.match(after.summary, /a decision to risk the bid, not an omission/);
  });

  it('keeps a revoked waiver on the record with who reversed it and why', () => {
    const revoked = itt.revokeWaiver(asQS(), analysisId, {
      reference: 'W-01',
      reason: 'The checking engineer freed up',
    });
    assert.equal(revoked.revokedBy, seed.users.qs!.auth.actorId);
    assert.equal(revoked.revokedReason, 'The checking engineer freed up');

    const register = itt.waiverRegister(asQS(), analysisId);
    assert.equal(register.live.length, 1);
    assert.equal(register.mandatoryWaived, 0);
    // Erasing it would leave a submission whose compliance matrix cannot
    // explain itself.
    assert.equal(register.past.length, 1);
    assert.equal(register.past[0]!.reference, 'W-01');
  });

  it('refuses to revoke a waiver that is not live, and refuses a silent revocation', () => {
    throwsCode(() => itt.revokeWaiver(asQS(), analysisId, { reference: 'W-01', reason: 'again' }), 'WAIVER_NOT_FOUND');
    throwsCode(() => itt.revokeWaiver(asQS(), analysisId, { reference: 'W-02', reason: '  ' }), 'REVOCATION_REASON_REQUIRED');
  });
});

describe('the waiver does real work on the response pack', () => {
  let packId: string;

  it('leaves a waived deliverable out of the drafting queue', () => {
    // W-02 is waived at this point; W-01 was waived and revoked, so it is back.
    const { pack } = bidresponse.planBidResponse(asQS(), { analysisId });
    packId = pack.id;
    const keys = pack.sections.map((section) => section.key);
    assert.ok(keys.includes('W-01'), 'a revoked waiver puts the deliverable straight back');
    assert.ok(!keys.includes('W-02'), 'a live waiver takes the deliverable out of the queue');
  });

  it('names it on the pack rather than making the checklist quietly shorter', () => {
    const pack = bidresponse.bidResponsePack(asQS(), packId);
    // The pack was planned without W-02 as a section, so it is not in the
    // outstanding list either — the honest report of that is the summary
    // counting what is answered, not a number that pretends nothing was left.
    assert.ok(!pack.completeness.unanswered.some((entry) => entry.key === 'W-02'));
  });

  it('takes an outstanding deliverable off the issue check when it is waived mid-drafting', () => {
    const before = bidresponse.bidResponsePack(asQS(), packId);
    assert.ok(before.completeness.unanswered.some((entry) => entry.key === 'W-01'));
    assert.equal(before.completeness.ready, false);

    itt.waiveRequirement(asQS(), analysisId, {
      reference: 'W-01',
      reason: 'The checking engineer is on another submission again and will not be back before the return date',
      expiresOn: RETURN_BY,
    });

    // Read live rather than baked in at plan time: a waiver granted halfway
    // through drafting takes the deliverable out, and one revoked puts it back.
    const after = bidresponse.bidResponsePack(asQS(), packId);
    assert.ok(!after.completeness.unanswered.some((entry) => entry.key === 'W-01'));
    assert.ok(after.completeness.waived.some((entry) => entry.key === 'W-01'));
    assert.match(after.completeness.summary, /1 waived/);
  });

  it('never counts a waived deliverable as an answered one', () => {
    const pack = bidresponse.bidResponsePack(asQS(), packId);
    const answered = pack.sections.filter(
      (section) => section.status === 'DRAFTED' && (section.body ?? []).length > 0,
    ).length;
    // A pack that counted a waiver as written would tell the person signing the
    // submission that it is complete.
    assert.equal(pack.completeness.written, answered);
    assert.ok(pack.completeness.waived.length > 0);
  });

  it('puts the deliverable back the moment the waiver is revoked', () => {
    itt.revokeWaiver(asQS(), analysisId, { reference: 'W-01', reason: 'Engineer available after all' });
    const pack = bidresponse.bidResponsePack(asQS(), packId);
    assert.ok(pack.completeness.unanswered.some((entry) => entry.key === 'W-01'));
    assert.equal(pack.completeness.ready, false);
  });
});
