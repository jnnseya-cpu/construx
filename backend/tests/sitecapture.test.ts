import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { ulid } from '../src/core/ids.ts';
import { scopesForRoles } from '../src/identity/scopes.ts';
import * as sitecapture from '../src/domain/sitecapture.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Three minutes on site, and what may honestly be claimed afterwards.
 *
 * The commercial proposition is "scan for three minutes and the platform tells
 * you what to do". The danger is the same sentence: a confident site layout
 * from a three-minute walk, with no statement of how much was measured, gets
 * set out against. Every test here is about a refusal that keeps that from
 * happening.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

/** A role with no read at all on the constraints register. */
const regulator = () => platform.context(seed.users.regulator!.auth, seed.projectId, { source: 'WEB' });

/** A mission on a fresh platform, so one test's walk is not another's. */
async function walk(tier: sitecapture.DeviceTier = 'LIDAR'): Promise<{
  platform: Platform;
  seed: SeedResult;
  ctx: () => ReturnType<Platform['context']>;
  owner: () => ReturnType<Platform['context']>;
  missionId: string;
}> {
  const fresh = new Platform();
  const freshSeed = await seedDemoProject(fresh);
  const ctx = () => fresh.context(freshSeed.users.constructionManager!.auth, freshSeed.projectId, { source: 'PWA' });
  const owner = () => fresh.context(freshSeed.users.pm!.auth, freshSeed.projectId, { source: 'WEB' });
  const { missionId } = sitecapture.startMission(ctx(), { purpose: 'RECON', deviceTier: tier });
  return { platform: fresh, seed: freshSeed, ctx, owner, missionId };
}

// ── The protocol ────────────────────────────────────────────────────────────

describe('the three minutes are a protocol, not a length of video', () => {
  it('publishes four stages that account for the whole three minutes', () => {
    const protocol = sitecapture.captureProtocol();
    assert.equal(protocol.totalSeconds, 180);
    assert.equal(protocol.stages.length, 4);

    // Contiguous and complete. A protocol with a gap between stages is three
    // minutes with a hole in it, and the hole is where the coverage goes.
    let cursor = 0;
    for (const stage of protocol.stages) {
      assert.equal(stage.fromSecond, cursor, `${stage.key} does not start where the previous stage ended`);
      assert.ok(stage.toSecond > stage.fromSecond);
      cursor = stage.toSecond;
    }
    assert.equal(cursor, protocol.totalSeconds);
  });

  it('gives every stage directions and says what is unanswerable without it', () => {
    // The directions are what makes it guided rather than a timer, and the
    // unanswered sentence is what the gap register is built from.
    for (const stage of sitecapture.captureProtocol().stages) {
      assert.ok(stage.directions.length >= 3, `${stage.key} gives the manager almost nothing to do`);
      assert.ok(stage.unansweredIfSkipped.length > 60, `${stage.key} does not say what skipping it costs`);
    }
  });

  it('ships the constraint catalogue with its responses, so the picker and the rulepack cannot drift', () => {
    const { constraintTypes } = sitecapture.captureProtocol();
    assert.ok(constraintTypes.length >= 15);
    for (const type of constraintTypes) {
      assert.ok(type.responses.length >= 2, `${type.code} offers no practical response`);
    }
  });
});

// ── The product rule: every constraint carries a response ───────────────────

describe('the report answers, it does not only describe', () => {
  it('gives every constraint type at least two practical responses', () => {
    // The product rule, stated as a test over the whole catalogue rather than
    // the handful a walkthrough happens to use. A type added later with no
    // response fails here rather than reaching a site.
    const types = Object.keys(sitecapture.CONSTRAINT_TYPE) as sitecapture.ConstraintType[];
    for (const code of types) {
      const entry = sitecapture.CONSTRAINT_TYPE[code];
      assert.ok(entry.responses.length >= 2, `${code} lists a problem and no answer`);
      for (const response of entry.responses) {
        assert.ok(response.length > 25, `${code} has a response too short to act on: "${response}"`);
      }
    }
  });

  it('returns the responses at the moment the constraint is recorded', async () => {
    // Not in a report later. The manager is standing on the ground, and the
    // cheapest moment to act on a narrow entrance is before they leave.
    const site = await walk();
    const { responses } = sitecapture.recordConstraint(site.ctx(), {
      missionId: site.missionId,
      type: 'NARROW_ENTRANCE',
      description: 'Gate is 3.2m between the posts; the artic will not turn in.',
      severity: 'HARD',
      source: 'SPOKEN',
      requiredVerification: 'Swept path check against the design vehicle',
    });

    assert.ok(responses.length >= 2);
    assert.ok(responses.some((response) => /widen/i.test(response)), 'the obvious answer to a narrow gate is missing');
  });

  it('carries every constraint into the brief with its responses attached', async () => {
    const site = await walk();
    sitecapture.recordConstraint(site.ctx(), {
      missionId: site.missionId,
      type: 'WEAK_GROUND',
      description: 'Standing water and rutting across the proposed laydown after rain.',
      severity: 'HARD',
      source: 'SPOKEN',
      requiredVerification: 'Trial holes and a CBR at the laydown',
      responsibleParty: 'Geotechnical engineer',
    });
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT', 'PROPOSED_AREAS', 'CONSTRAINTS'],
      capturedSeconds: 180,
    });

    const brief = sitecapture.captureBrief(site.ctx(), site.missionId);
    assert.equal(brief.constraints.length, 1);
    const [entry] = brief.constraints;
    assert.equal(entry!.typeLabel, 'Weak or waterlogged ground');
    assert.ok(entry!.responses.length >= 2, 'a constraint reached the brief with nothing to do about it');
    assert.ok(entry!.responses.some((response) => /geotextile|stone platform/i.test(response)));
  });
});

// ── The class is derived, never declared ────────────────────────────────────

describe('nothing here is presented as survey grade', () => {
  it('calls a video-only walk conceptual, and says nothing may be set out from it', async () => {
    const site = await walk('VIDEO_ONLY');
    const { accuracyClass } = sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT'],
      capturedSeconds: 95,
      // Control points on a device that cannot measure must not promote it.
      // This is the mistake the class exists to prevent: three markers observed
      // on video are three markers nobody measured.
      controlPoints: 6,
    });

    assert.equal(accuracyClass, 'CONCEPTUAL');
    const brief = sitecapture.captureBrief(site.ctx(), site.missionId);
    assert.match(brief.mayNotClaim, /Nothing here may be scaled or built to/);
  });

  it('calls a depth walk with no control reconnaissance, not controlled', async () => {
    const site = await walk('LIDAR');
    const { accuracyClass } = sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT', 'PROPOSED_AREAS', 'CONSTRAINTS'],
      capturedSeconds: 180,
    });
    assert.equal(accuracyClass, 'MEASURED_RECON');
    assert.match(sitecapture.captureBrief(site.ctx(), site.missionId).mayNotClaim, /Set-out/);
  });

  it('needs three control points before it will call anything project controlled', async () => {
    // Two fit a transform with nothing left over to check it against, which is
    // a transform with no residual — precisely the number that would let a bad
    // registration pass silently.
    const two = await walk('SURVEY_ASSISTED');
    assert.equal(
      sitecapture.completeMission(two.ctx(), {
        missionId: two.missionId,
        stagesCovered: ['ORIENTATION'],
        capturedSeconds: 30,
        controlPoints: 2,
      }).accuracyClass,
      'MEASURED_RECON',
    );

    const three = await walk('SURVEY_ASSISTED');
    assert.equal(
      sitecapture.completeMission(three.ctx(), {
        missionId: three.missionId,
        stagesCovered: ['ORIENTATION'],
        capturedSeconds: 30,
        controlPoints: 3,
      }).accuracyClass,
      'PROJECT_CONTROLLED',
    );
  });

  it('refuses to make an uncontrolled walk the baseline', async () => {
    // A baseline is what every later scan is measured against. Approving a
    // reconnaissance walk as one makes every future change report a comparison
    // with a guess, and the comparison is the whole reason to hold a baseline.
    const site = await walk('LIDAR');
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT', 'PROPOSED_AREAS', 'CONSTRAINTS'],
      capturedSeconds: 180,
    });

    const refusal = throwsCode(
      () => sitecapture.approveAsBaseline(site.owner(), { missionId: site.missionId }),
      'BASELINE_REQUIRES_CONTROL',
    );
    assert.match(String(refusal.message), /comparison with a guess/);
  });

  it('lets approval settle on a controlled walk, and only from approval authority', async () => {
    const site = await walk('SURVEY_ASSISTED');
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT', 'PROPOSED_AREAS', 'CONSTRAINTS'],
      capturedSeconds: 180,
      controlPoints: 4,
    });

    // The construction manager holds A on LOOKAHEAD_CONSTRAINTS and so may set
    // a baseline; the planner creates and updates but does not approve, which
    // is the specification's own authority matrix.
    throwsCode(
      () =>
        sitecapture.approveAsBaseline(
          site.platform.context(site.seed.users.planner!.auth, site.seed.projectId, { source: 'WEB' }),
          { missionId: site.missionId },
        ),
      'ACCESS_DENIED',
    );

    const approved = sitecapture.approveAsBaseline(site.ctx(), {
      missionId: site.missionId,
      conditions: 'Subject to the boundary being confirmed against the title plan.',
    });
    assert.equal(approved.accuracyClass, 'APPROVED_BASELINE');
  });
});

// ── A stage not walked is not a lower-confidence answer ─────────────────────

describe('the brief says what the three minutes did not reach', () => {
  it('names every uncovered stage, what is unanswered, and the directions to close it', async () => {
    // The walk never reached the compound area or the constraints. A brief that
    // quietly proposed a compound anyway is the failure mode this whole module
    // is built against.
    const site = await walk();
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT'],
      capturedSeconds: 90,
    });

    const brief = sitecapture.captureBrief(site.ctx(), site.missionId);
    assert.equal(brief.gaps.length, 2);
    const stages = brief.gaps.map((gap) => gap.stage);
    assert.deepEqual(stages, ['PROPOSED_AREAS', 'CONSTRAINTS']);

    for (const gap of brief.gaps) {
      assert.ok(gap.unanswered.length > 60, `${gap.stage} was reported as a gap with no consequence`);
      assert.ok(gap.nextBurstDirections.length >= 3, `${gap.stage} gives nothing to do on the next burst`);
    }
    assert.match(brief.summary, /2 stage\(s\) were not reached/);
  });

  it('reports no gaps when the protocol was walked in full', async () => {
    // The other direction. A gap register that always finds something is not
    // read, and the four-stage claim has to be provable.
    const site = await walk();
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT', 'PROPOSED_AREAS', 'CONSTRAINTS'],
      capturedSeconds: 178,
    });
    const brief = sitecapture.captureBrief(site.ctx(), site.missionId);
    assert.equal(brief.gaps.length, 0);
    assert.match(brief.summary, /covered in full/);
  });

  it('says in the brief that no model or layout was produced', async () => {
    // Stated rather than omitted. A brief that simply did not mention the site
    // model would be read as "there wasn't one worth showing" rather than "the
    // platform does not make one".
    const site = await walk();
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION'],
      capturedSeconds: 30,
    });
    const brief = sitecapture.captureBrief(site.ctx(), site.missionId);
    assert.ok(brief.notProduced.length >= 2);
    // Anchored, so a line that merely contains the words does not pass. A
    // disclosure buried mid-sentence is not a disclosure.
    assert.ok(brief.notProduced.some((line) => /^No 3D model, orthomosaic or dimensioned drawing is produced here/.test(line)));
    assert.ok(brief.notProduced.some((line) => /^No site layout is positioned/.test(line)));
  });
});

// ── Refusals that keep the record honest ────────────────────────────────────

describe('what the capture refuses to record', () => {
  it('refuses a hard constraint with nothing that would verify it', async () => {
    // "The ground is weak" with no way to settle it is an opinion that gets
    // treated as a fact later, and the moment to name the trial hole is while
    // somebody is standing on the ground.
    const site = await walk();
    const refusal = throwsCode(
      () =>
        sitecapture.recordConstraint(site.ctx(), {
          missionId: site.missionId,
          type: 'UNDERGROUND_SERVICES',
          description: 'Something is running under the access road, unmarked.',
          severity: 'HARD',
          source: 'SPOKEN',
        }),
      'CONSTRAINT_VERIFICATION_REQUIRED',
    );
    assert.match(String(refusal.message), /standing on the ground/);
  });

  it('accepts an optimisable constraint without one, because nothing is blocked by it', async () => {
    const site = await walk();
    const { constraintId } = sitecapture.recordConstraint(site.ctx(), {
      missionId: site.missionId,
      type: 'WELFARE_DISTANCE',
      description: 'Compound would be a four minute walk from the working face.',
      severity: 'OPTIMISABLE',
      source: 'SPOKEN',
    });
    assert.ok(constraintId);
  });

  it('puts everything needing verification on one schedule', async () => {
    const site = await walk();
    sitecapture.recordConstraint(site.ctx(), {
      missionId: site.missionId,
      type: 'OVERHEAD_LINES',
      description: 'Line crosses the north of the site over the proposed laydown.',
      severity: 'HARD',
      source: 'SPOKEN',
      requiredVerification: 'Written clearance distance from the network operator',
      responsibleParty: 'Temporary works coordinator',
    });
    sitecapture.recordConstraint(site.ctx(), {
      missionId: site.missionId,
      type: 'LIMITED_LAYDOWN',
      description: 'Usable laydown is about a third of what the sequence assumes.',
      severity: 'OPTIMISABLE',
      source: 'SPOKEN',
    });
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION', 'SITE_CONTEXT', 'PROPOSED_AREAS', 'CONSTRAINTS'],
      capturedSeconds: 180,
    });

    const brief = sitecapture.captureBrief(site.ctx(), site.missionId);
    assert.equal(brief.hardConstraints, 1);
    assert.equal(brief.verificationSchedule.length, 1);
    assert.equal(brief.verificationSchedule[0]!.responsibleParty, 'Temporary works coordinator');
    assert.match(brief.summary, /1 thing\(s\) need verifying/);
  });

  it('refuses a capture longer than the protocol', async () => {
    // A longer session did not follow this protocol, and the brief is scored
    // against this one. Accepting it quietly would make the constraint
    // decorative.
    const site = await walk();
    throwsCode(
      () =>
        sitecapture.completeMission(site.ctx(), {
          missionId: site.missionId,
          stagesCovered: ['ORIENTATION'],
          capturedSeconds: 240,
        }),
      'CAPTURE_DURATION_INVALID',
    );
  });

  it('refuses a constraint remembered after the walk was closed', async () => {
    const site = await walk();
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION'],
      capturedSeconds: 30,
    });
    throwsCode(
      () =>
        sitecapture.recordConstraint(site.ctx(), {
          missionId: site.missionId,
          type: 'NO_REVERSING',
          description: 'Client operates a no-reversing policy across the estate.',
          severity: 'OPTIMISABLE',
          source: 'SPOKEN',
        }),
      'MISSION_ALREADY_COMPLETE',
    );
  });

  it('refuses a stage that is not part of the protocol', async () => {
    const site = await walk();
    throwsCode(
      () =>
        sitecapture.completeMission(site.ctx(), {
          missionId: site.missionId,
          stagesCovered: ['ORIENTATION', 'DRONE_SWEEP' as never],
          capturedSeconds: 60,
        }),
      'UNKNOWN_CAPTURE_STAGE',
    );
  });

  it('refuses a mission id belonging to another tenant, from inside a project of your own', async () => {
    // The shape that actually reaches the guard. Asking for another tenant's
    // *project* is refused upstream by the ABAC layer, so a test written that
    // way proves the platform's isolation and nothing about this module. This
    // one is a legitimate user, on their own project, quoting a mission id they
    // were given — which is how a stale link or a copied reference arrives, and
    // the only path where `requireMission`'s own tenancy check is what stands
    // between them and another firm's site constraints.
    // Both tenancies on ONE platform, which is the whole point. Two `Platform`
    // instances are two ledgers, the record is simply absent, and the test
    // passes with the tenancy check deleted — proving nothing.
    const mine = await walk();
    const { tenant } = mine.platform.createTenant({
      legalName: 'Other Contractor Ltd',
      enterpriseName: 'Other Contractor Group',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'ENTERPRISE',
    });
    const theirManager = mine.platform.createUser({
      tenantId: tenant.id,
      name: 'Their Construction Manager',
      email: 'cm@othercontractor.example',
      roles: ['CONSTRUCTION_MANAGER'],
    });
    const theirAuth = {
      actorId: theirManager.id,
      tenantId: theirManager.tenantId,
      roles: theirManager.roles,
      scopes: scopesForRoles(theirManager.roles),
      tokenId: 'test-token',
      mfaSatisfied: true,
      regulatorAiEnabled: false,
      expiresAt: Date.now() + 60_000,
    };
    const theirProjectId = ulid();
    const theirCtx = () => mine.platform.context(theirAuth, theirProjectId, { source: 'PWA' });
    const { missionId: strayId } = sitecapture.startMission(theirCtx(), { purpose: 'RECON', deviceTier: 'LIDAR' });

    // Same ledger, real record, different tenant. Only `requireMission`'s own
    // check stands between this manager and another firm's site constraints.
    throwsCode(() => sitecapture.captureBrief(mine.ctx(), strayId), 'CAPTURE_MISSION_NOT_FOUND');
    // And it is a real id, not a typo: it reads perfectly well from its own home.
    assert.equal(sitecapture.captureBrief(theirCtx(), strayId).missionId, strayId);
  });

});

// ── The board ───────────────────────────────────────────────────────────────

describe('the board', () => {
  it('says what each walk may be called without opening it', async () => {
    const site = await walk('VIDEO_ONLY');
    sitecapture.completeMission(site.ctx(), {
      missionId: site.missionId,
      stagesCovered: ['ORIENTATION'],
      capturedSeconds: 30,
    });

    const board = sitecapture.missionBoard(site.ctx());
    assert.equal(board.length, 1);
    assert.equal(board[0]!.accuracyClass, 'CONCEPTUAL');
  });

  it('is closed to a role with no read on the constraints register', () => {
    // The regulator reads the safety record and nothing about how the site is
    // laid out commercially. A capture is what this business has and has not
    // accepted about the ground, which is a negotiating position first.
    throwsCode(() => sitecapture.missionBoard(regulator()), 'ACCESS_DENIED');
  });
});
