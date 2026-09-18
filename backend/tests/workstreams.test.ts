import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as structure from '../src/domain/structure.ts';
import * as stages from '../src/lifecycle/stages.ts';
import * as workstreams from '../src/lifecycle/workstreams.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * AC-06 — a stage change is not permission to close somebody else's work.
 *
 * The primary stage is a reporting answer: where the bulk of the work is, which
 * workspace opens by default, which column of the portfolio this job sits in.
 * It is not a description of what anybody is doing, and a model that treats it
 * as one has asserted that design finished the moment the first pour went in.
 *
 * These tests are the negative of that. The interesting ones are not that a
 * workstream can be opened — they are that nothing except a person closes one.
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

/** A project at TENDER, which is where a conversion starts from. */
function bid(name: string): ReturnType<Platform['context']> {
  const created = structure.createProject(gov, {
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
  } as Parameters<typeof structure.createProject>[1]);
  return platform.context(seed.users.admin!.auth, created.projectId, { source: 'WEB' });
}

const AWARD = {
  contractAwardDate: '2026-04-20',
  contractSumMinor: 100_000_000,
  contractForm: 'NEC4 ECC Option A',
  contractedScope: 'Exactly as tendered, with no change to scope, price or programme.',
  contractStartDate: '2026-02-02',
  contractCompletionDate: '2027-08-13',
};

function statusOf(ctx: ReturnType<Platform['context']>, type: string): string | undefined {
  return workstreams.projectWorkstreams(ctx).workstreams.find((entry) => entry.type === type)?.status;
}

describe('workstreams run across stages, not inside one', () => {
  it('AC-06 — design and procurement stay active when the primary stage moves to construction', () => {
    const ctx = bid('AC-06 overlap');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; the contractor develops the concept design it priced.',
    });

    // §3.3's design-and-build row: four things are running, not one.
    assert.equal(statusOf(ctx, 'DESIGN'), 'ACTIVE');
    assert.equal(statusOf(ctx, 'PROCUREMENT'), 'ACTIVE');
    assert.equal(statusOf(ctx, 'TENDER_RECONCILIATION'), 'ACTIVE');
    assert.equal(statusOf(ctx, 'MOBILISATION'), 'ACTIVE');

    // The primary stage moves. This is the whole of AC-06.
    stages.applyPhaseChange(ctx, {
      from: 'DESIGN',
      to: 'CONSTRUCTION',
      direction: 'FORWARD',
      justification: 'Ground works have started; the bulk of the work is now on site.',
      gateEvaluation: [],
    });
    assert.equal(
      (platform.ledger.require({ refType: 'Project', refId: ctx.projectId }).state as { phase?: string }).phase,
      'CONSTRUCTION',
    );

    // And nothing closed.
    assert.equal(statusOf(ctx, 'DESIGN'), 'ACTIVE', 'the stage change closed design');
    assert.equal(statusOf(ctx, 'PROCUREMENT'), 'ACTIVE', 'the stage change closed procurement');
    assert.equal(statusOf(ctx, 'TENDER_RECONCILIATION'), 'ACTIVE');
    assert.equal(workstreams.activeWorkstreams(ctx).length, 4);
  });

  it('AC-06 — “unless explicitly closed”: a person closes one, with a reason', () => {
    const ctx = bid('AC-06 close');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; delivery opens at design.',
    });

    const design = workstreams.projectWorkstreams(ctx).workstreams.find((entry) => entry.type === 'DESIGN')!;

    // A close is a statement that somebody else's work is finished, so it
    // carries the sentence saying so.
    throwsCode(
      () => workstreams.setWorkstreamStatus(ctx, { workstreamId: design.id, status: 'COMPLETE', reason: 'done' }),
      'WORKSTREAM_REASON_REQUIRED',
    );

    workstreams.setWorkstreamStatus(ctx, {
      workstreamId: design.id,
      status: 'COMPLETE',
      reason: 'Every package is issued for construction and the designer has signed the completion certificate.',
    });
    assert.equal(statusOf(ctx, 'DESIGN'), 'COMPLETE');
    assert.equal(workstreams.activeWorkstreams(ctx).length, 3);

    // And it does not come back to life. Work that restarts is a new record
    // with its own history, or the register cannot say it stopped and started.
    throwsCode(
      () =>
        workstreams.setWorkstreamStatus(ctx, {
          workstreamId: design.id,
          status: 'ACTIVE',
          reason: 'The client changed the cladding, so design is running again.',
        }),
      'WORKSTREAM_CLOSED',
    );

    const restarted = workstreams.activateWorkstream(ctx, {
      type: 'DESIGN',
      reason: 'Cladding redesign instructed after practical completion of the original package.',
    });
    assert.equal(restarted.alreadyOpen, false);
    assert.notEqual(restarted.workstreamId, design.id);
    assert.equal(workstreams.activeWorkstreams(ctx).length, 4);
  });

  it('counts a blocked workstream as active, because it is work that has stopped moving', () => {
    const ctx = bid('AC-06 blocked');
    const opened = workstreams.activateWorkstream(ctx, { type: 'PROCUREMENT' });
    workstreams.setWorkstreamStatus(ctx, {
      workstreamId: opened.workstreamId,
      status: 'BLOCKED',
      reason: 'Waiting on the client to confirm the cladding specification before any enquiry can go out.',
    });

    assert.equal(statusOf(ctx, 'PROCUREMENT'), 'BLOCKED');
    // The point: a blocked workstream stays in the active count. Counting it as
    // inactive is how it disappears from the report that would unblock it.
    assert.equal(workstreams.activeWorkstreams(ctx).length, 1);
    const position = workstreams.projectWorkstreams(ctx);
    assert.equal(position.blocked, 1);
    assert.match(position.summary, /blocked/);
  });

  it('opens one live workstream per type, so the dimension has one answer', () => {
    const ctx = bid('AC-06 duplicate');
    const first = workstreams.activateWorkstream(ctx, { type: 'DESIGN' });
    const second = workstreams.activateWorkstream(ctx, { type: 'DESIGN' });

    assert.equal(second.alreadyOpen, true);
    assert.equal(second.workstreamId, first.workstreamId);
    assert.equal(workstreams.projectWorkstreams(ctx).workstreams.length, 1);
  });

  it('opens the workstreams §3.3 says are running, by where delivery starts', () => {
    const design = bid('AC-06 entry design');
    const designReceipt = structure.convertToDelivery(design, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Design and build: the contractor develops the concept it priced.',
    });
    assert.deepEqual(designReceipt.workstreams.slice().sort(), [
      'DESIGN',
      'MOBILISATION',
      'PROCUREMENT',
      'TENDER_RECONCILIATION',
    ]);

    const construction = bid('AC-06 entry construction');
    const constructionReceipt = structure.convertToDelivery(construction, {
      award: AWARD,
      deliveryEntry: 'CONSTRUCTION',
      justification: 'Traditional contract: the design is novated and complete, so the work starts on site.',
    });
    // No design workstream: this contractor did not take design responsibility,
    // and opening one would put a register in front of somebody with nothing to
    // put in it.
    assert.deepEqual(constructionReceipt.workstreams.slice().sort(), [
      'CONSTRUCTION',
      'MOBILISATION',
      'TENDER_RECONCILIATION',
    ]);
    assert.equal(statusOf(construction, 'DESIGN'), undefined);
  });

  it('does not open a second set on a replayed conversion', () => {
    // A retry is one commercial act arriving twice. Two Design workstreams on
    // one project is two answers to whether design has finished.
    const ctx = bid('AC-06 replay');
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; delivery opens at design.',
      idempotencyKey: 'ws-replay-1',
    });
    const replay = structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'DESIGN',
      justification: 'Awarded; delivery opens at design.',
      idempotencyKey: 'ws-replay-1',
    });
    assert.equal(replay.replayed, true);
    assert.equal(workstreams.projectWorkstreams(ctx).workstreams.length, 4);
  });

  it('refuses a type and a status that are not in the catalogue', () => {
    const ctx = bid('AC-06 vocabulary');
    throwsCode(() => workstreams.activateWorkstream(ctx, { type: 'SNAGGING' }), 'WORKSTREAM_TYPE_UNKNOWN');

    const opened = workstreams.activateWorkstream(ctx, { type: 'DESIGN' });
    throwsCode(
      () => workstreams.setWorkstreamStatus(ctx, { workstreamId: opened.workstreamId, status: 'PAUSED', reason: 'For a bit' }),
      'WORKSTREAM_STATUS_UNKNOWN',
    );
    throwsCode(
      () => workstreams.setWorkstreamStatus(ctx, { workstreamId: opened.workstreamId, status: 'ACTIVE', reason: 'Still going' }),
      'WORKSTREAM_NO_CHANGE',
    );
  });

  it('records the stage the workstream was opened at, separately from where the project is now', () => {
    // §10.1's `stage_context`. A design workstream opened at tender and still
    // running in construction is the exact situation the dimension exists for,
    // and a record that only knows "now" cannot describe it.
    const ctx = bid('AC-06 context');
    const opened = workstreams.activateWorkstream(ctx, { type: 'DESIGN' });
    structure.convertToDelivery(ctx, {
      award: AWARD,
      deliveryEntry: 'CONSTRUCTION',
      justification: 'Awarded; the works start on site while the design workstream is still open.',
    });

    const record = workstreams.projectWorkstreams(ctx).workstreams.find((entry) => entry.id === opened.workstreamId)!;
    assert.equal(record.stageContext, 'TENDER');
    assert.equal(record.status, 'ACTIVE');
    assert.equal(
      (platform.ledger.require({ refType: 'Project', refId: ctx.projectId }).state as { phase?: string }).phase,
      'CONSTRUCTION',
    );
  });

  it('publishes the catalogue with the register, rather than making a screen keep its own copy', () => {
    const position = workstreams.projectWorkstreams(bid('AC-06 catalogue'));
    assert.deepEqual(
      position.types.map((entry) => entry.code).sort(),
      workstreams.WORKSTREAM_TYPE_CODES.slice().sort(),
    );
    assert.deepEqual(
      position.statuses.map((entry) => entry.code).sort(),
      workstreams.WORKSTREAM_STATUS_CODES.slice().sort(),
    );
    for (const entry of position.types) assert.ok(entry.what.length >= 10, `${entry.code} has no description`);
    // The blocked-is-active rule, asserted where a screen reads it from.
    assert.equal(position.statuses.find((entry) => entry.code === 'BLOCKED')!.active, true);
    assert.equal(position.statuses.find((entry) => entry.code === 'COMPLETE')!.active, false);
  });
});
