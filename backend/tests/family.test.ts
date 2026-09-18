import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as family from '../src/domain/family.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * AC-10 — one tender, two contracts, and no cycles.
 *
 * *One tender produces two independent contracts; the second contract is
 * onboarded; two child projects are created under the opportunity parent
 * without cycles.*
 *
 * This is the one case the in-place conversion model does not cover, and it has
 * to be covered explicitly or it is covered badly. An award converts a project
 * in place and never makes a second one — that is settled and right. But when
 * the *work* genuinely splits into two contracts, the alternative to a
 * relationship record is somebody opening a second project and typing the
 * client, the site, the team and the contract in again. That re-keying is what
 * the platform exists to remove, and without this it arrives through the one
 * door left open.
 */

let platform: Platform;
let seed: SeedResult;
let gov: ReturnType<Platform['context']>;
let portfolioId: string;

const LOCATION = { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' };

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  portfolioId = String(
    platform.ledger.entitiesOfType('Project').find((record) => record.state.id === seed.projectId)!.state.portfolioId,
  );
});

function project(name: string): string {
  return structure.createProject(gov, {
    portfolioId,
    name,
    sectorType: 'UTILITIES',
    assetType: 'Fixture',
    location: LOCATION,
    contractValueMinor: 100_000_000,
    currency: 'GBP',
    plannedStart: '2026-02-02',
    plannedCompletion: '2027-08-13',
    startingPhase: 'TENDER',
    startingPhaseReason: 'Pricing the client design against their bill of quantities.',
  } as Parameters<typeof structure.createProject>[1]).projectId;
}

const on = (projectId: string): ReturnType<Platform['context']> =>
  platform.context(seed.users.admin!.auth, projectId, { source: 'WEB' });

describe('one pursuit can produce more than one contract', () => {
  it('AC-10 — two contracts sit under the opportunity, and the opportunity keeps its id', () => {
    const opportunity = project('Ribble catchment framework tender');
    const first = project('Ribble catchment — Cawley WTW');
    const second = project('Ribble catchment — Ashworth pumping station');

    const parentCtx = on(opportunity);
    family.linkChildProject(parentCtx, {
      childProjectId: first,
      relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
      reason: 'The client split the award; this is the treatment works contract, priced from the same tender.',
    });
    family.linkChildProject(parentCtx, {
      childProjectId: second,
      relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
      reason: 'The second contract off the same tender — separate sum, separate programme, separate account.',
    });

    const position = family.projectFamily(parentCtx);
    assert.equal(position.projectId, opportunity, 'the opportunity changed id');
    assert.equal(position.children.length, 2);
    assert.deepEqual(position.children.map((child) => child.projectId).sort(), [first, second].sort());
    assert.equal(position.parent, null);
    assert.match(position.summary, /2 separate contracts/);

    // And from the child's side, which is where somebody delivering actually is.
    const childPosition = family.projectFamily(on(first));
    assert.equal(childPosition.parent?.projectId, opportunity);
    assert.equal(childPosition.parent?.relationshipType, 'CONTRACT_FROM_OPPORTUNITY');
    assert.match(childPosition.parent?.reason ?? '', /treatment works contract/);
    assert.equal(childPosition.children.length, 0);
  });

  it('AC-10 — refuses a cycle, both the direct one and the round trip', () => {
    const a = project('Cycle A');
    const b = project('Cycle B');
    const c = project('Cycle C');

    throwsCode(
      () =>
        family.linkChildProject(on(a), {
          childProjectId: a,
          relationshipType: 'SCHEME_PHASE',
          reason: 'A project that is its own phase, somehow.',
        }),
      'PROJECT_RELATIONSHIP_CYCLE',
    );

    family.linkChildProject(on(a), {
      childProjectId: b,
      relationshipType: 'SCHEME_PHASE',
      reason: 'Phase two of the same scheme, let eighteen months after phase one.',
    });
    family.linkChildProject(on(b), {
      childProjectId: c,
      relationshipType: 'SCHEME_PHASE',
      reason: 'Phase three, let off the back of phase two.',
    });

    // C is below A. Putting A below C closes the loop, and a loop is not a
    // wrong answer — it is a rollup that never finishes.
    throwsCode(
      () =>
        family.linkChildProject(on(c), {
          childProjectId: a,
          relationshipType: 'SCHEME_PHASE',
          reason: 'And phase one is a phase of phase three, which cannot be true.',
        }),
      'PROJECT_RELATIONSHIP_CYCLE',
    );

    // The walk terminated rather than hanging, which is the property that
    // matters. If it had not, this assertion would never be reached.
    assert.equal(family.projectFamily(on(a)).children.length, 1);
    assert.equal(family.projectFamily(on(c)).parent?.projectId, b);
  });

  it('gives a job one parent, so a rollup cannot count it twice', () => {
    const pursuitOne = project('Pursuit one');
    const pursuitTwo = project('Pursuit two');
    const job = project('Contested job');

    family.linkChildProject(on(pursuitOne), {
      childProjectId: job,
      relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
      reason: 'Won off the first tender, which is where this job came from.',
    });
    throwsCode(
      () =>
        family.linkChildProject(on(pursuitTwo), {
          childProjectId: job,
          relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
          reason: 'And also off the second tender, which cannot also be true.',
        }),
      'PROJECT_RELATIONSHIP_EXISTS',
    );
    throwsCode(
      () =>
        family.linkChildProject(on(pursuitOne), {
          childProjectId: job,
          relationshipType: 'SCHEME_PHASE',
          reason: 'The same link a second time, under a different name.',
        }),
      'PROJECT_RELATIONSHIP_EXISTS',
    );
  });

  it('§11.2 — a retried creation returns the relationship it already made', () => {
    // The request that creates the second contract is the one a person
    // double-clicks, and two identical relationships is a rollup that counts
    // the same job twice.
    const pursuit = project('Idempotent pursuit');
    const job = project('Idempotent job');
    const ctx = on(pursuit);

    const first = family.linkChildProject(ctx, {
      childProjectId: job,
      relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
      reason: 'The second contract off this tender, submitted once.',
      idempotencyKey: 'child-create-1',
    });
    const replay = family.linkChildProject(ctx, {
      childProjectId: job,
      relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
      reason: 'The second contract off this tender, submitted once.',
      idempotencyKey: 'child-create-1',
    });

    assert.equal(replay.id, first.id);
    assert.equal(family.projectFamily(ctx).children.length, 1);
  });

  it('demands the sentence saying why these are two jobs', () => {
    const pursuit = project('Unexplained pursuit');
    const job = project('Unexplained job');
    throwsCode(
      () =>
        family.linkChildProject(on(pursuit), {
          childProjectId: job,
          relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
          reason: 'split',
        }),
      'RELATIONSHIP_UNJUSTIFIED',
    );
    throwsCode(
      () =>
        family.linkChildProject(on(pursuit), {
          childProjectId: job,
          relationshipType: 'SUBSIDIARY',
          reason: 'A relationship type that is not one of the three.',
        }),
      'RELATIONSHIP_TYPE_UNKNOWN',
    );
  });

  it('says so plainly when a project stands on its own', () => {
    // A blank family panel reads as a link somebody forgot to make. The answer
    // is a sentence, not an empty list.
    const alone = project('Stands alone');
    const position = family.projectFamily(on(alone));
    assert.equal(position.parent, null);
    assert.deepEqual(position.children, []);
    assert.match(position.summary, /stands on its own/);
    // And the catalogue travels with it, so a chooser offers the three types
    // the engine validates against rather than a copy of them.
    assert.deepEqual(
      position.types.map((entry) => entry.code).sort(),
      family.RELATIONSHIP_TYPE_CODES.slice().sort(),
    );
  });

  it('carries the child’s live state, so the parent screen is worth opening', () => {
    // A family panel listing names and nothing else sends somebody to three
    // other screens to find out how the jobs are doing.
    const pursuit = project('Reporting pursuit');
    const job = project('Reporting job');
    structure.convertToDelivery(on(job), {
      award: {
        contractAwardDate: '2026-04-20',
        contractSumMinor: 100_000_000,
        contractForm: 'NEC4 ECC Option A',
        contractedScope: 'Exactly as tendered.',
        contractStartDate: '2026-02-02',
        contractCompletionDate: '2027-08-13',
      },
      deliveryEntry: 'CONSTRUCTION',
      justification: 'Awarded; this contract is live while the pursuit continues on the rest.',
    });
    family.linkChildProject(on(pursuit), {
      childProjectId: job,
      relationshipType: 'CONTRACT_FROM_OPPORTUNITY',
      reason: 'First of the contracts off this tender, awarded and now live.',
    });

    const child = family.projectFamily(on(pursuit)).children[0]!;
    assert.equal(child.lifecycleState, 'LIVE_MOBILISING');
    assert.equal(child.contractValueMinor, 100_000_000);
  });
});
