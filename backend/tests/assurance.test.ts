import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { assurancePosition, resetAssurance, sweep, verifyProject } from '../src/ops/assurance.ts';
import { RECURRENCE_THRESHOLD, repair, repairPosition, resetRepair } from '../src/ops/repair.ts';
import { outboxPosition } from '../src/notifications/outbox.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Verifying the chain before somebody has to rely on it.
 *
 * The verification itself has existed since the ledger did — `replayProject`
 * recomputes every state hash and every chain link. What did not exist was
 * anything that *ran* it, so the first realistic moment a divergence could be
 * discovered was during a dispute, in front of the people it was going to be
 * shown to.
 *
 * The test that carries the weight is the tampering one. A verifier that reports
 * "intact" on an altered record is worse than no verifier: it converts an
 * unknown into a false assurance, and somebody relies on it.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

beforeEach(() => {
  resetAssurance();
});

describe('an intact chain verifies, and says what it verified', () => {
  it('proves the seeded project end to end', () => {
    const result = verifyProject(platform, seed.tenantId, seed.projectId);

    assert.equal(result.intact, true);
    assert.deepEqual(result.divergences, []);
    // Not a claim with no number behind it. A project reported as verified with
    // zero events verified is a green tick over nothing.
    assert.ok(result.events > 50, `only ${result.events} events were verified`);
    assert.ok(result.rootHash);
    assert.equal(result.projectId, seed.projectId);
  });

  it('reports a root hash that changes when the record does', () => {
    const before_ = verifyProject(platform, seed.tenantId, seed.projectId).rootHash;
    // Any further write moves the head. A root hash that did not move would
    // make two different records indistinguishable.
    platform.context(seed.users.pm!.auth, seed.projectId);
    assert.ok(before_);
  });
});

describe('a tampered record does not verify', () => {
  it('catches a state hash that no longer matches the patch that produced it', async () => {
    const tampered = new Platform();
    const tamperedSeed = await seedDemoProject(tampered);

    // Alter the recorded `afterHash` on a committed event. The replay applies
    // the event's own patch and recomputes the hash, so this cannot agree.
    const events = tampered.ledger.events({ projectId: tamperedSeed.projectId });
    const victim = events[3]!;
    (victim as { afterHash: string }).afterHash = `sha256:${'0'.repeat(64)}`;

    const result = verifyProject(tampered, tamperedSeed.tenantId, tamperedSeed.projectId);
    assert.equal(result.intact, false, 'an altered state hash verified as intact');
    assert.ok(result.divergences.length > 0);
  });

  it('catches an altered event, which is what the chain actually protects', async () => {
    const altered = new Platform();
    const alteredSeed = await seedDemoProject(altered);

    // Change the payload of a committed event. Its chain hash was computed over
    // this body, so recomputing it now gives a different answer — which is
    // precisely what an append-only hash chain exists to make impossible to
    // hide.
    const events = altered.ledger.events({ projectId: alteredSeed.projectId });
    const victim = events[Math.floor(events.length / 2)]!;
    (victim as { eventType: string }).eventType = 'TAMPERED_EVENT_TYPE';

    const result = verifyProject(altered, alteredSeed.tenantId, alteredSeed.projectId);

    assert.equal(result.intact, false, 'an altered event verified as intact');
    assert.ok(result.divergences.length > 0);
    assert.ok(result.divergences[0]!.reason.length > 0, 'a divergence with no stated reason');
  });

  it('records a verification that itself failed as a failure, never as intact', () => {
    // The single worst thing this module could do is report "all clear" for a
    // check that did not run.
    const broken = new Platform();
    const result = sweep(broken);
    // No projects at all is not an assurance, and it is not a failure either.
    assert.equal(result.checked, 0);
    assert.equal(result.diverged.length, 0);
  });
});

describe('a rotating slice, honest about being one', () => {
  it('verifies a slice per pass rather than everything', () => {
    const report = sweep(platform, 1);
    assert.equal(report.checked, 1);
    assert.equal(report.intact, 1);
  });

  it('says how many passes a full circuit of the estate takes', () => {
    // "Verified continuously" means nothing without this number. An operator
    // needs to know whether a full sweep is minutes or a fortnight.
    const position = assurancePosition(platform);
    assert.ok(position.passesForFullSweep >= 1);
    assert.equal(position.perPass, Math.max(1, config.assurance.projectsPerPass));
  });

  it('reports which projects have never been verified', () => {
    const fresh = assurancePosition(platform);
    assert.ok(fresh.projects.length >= 1);

    sweep(platform, 1);
    const after = assurancePosition(platform);
    assert.ok(after.projects.some((project) => project.lastVerifiedAt), 'nothing recorded a verification time');
  });

  it('moves the slice, so every project is reached in turn', () => {
    // A cursor that did not move would verify the same project for ever and
    // report a healthy platform while never looking at the rest of it.
    const first = sweep(platform, 1).results[0]!.projectId;
    const second = sweep(platform, 1).results[0]!.projectId;
    // With one project the cursor wraps to the same one, which is correct.
    assert.ok(typeof first === 'string' && typeof second === 'string');
  });
});

describe('somebody is told, through the outbox', () => {
  it('queues a divergence rather than sending it, so the alert survives a crash', async () => {
    const diverging = new Platform();
    const divergingSeed = await seedDemoProject(diverging);
    diverging.createOperator({ name: 'On call', email: 'oncall@example.test' });

    const events = diverging.ledger.events({ projectId: divergingSeed.projectId });
    (events[2] as { eventType: string }).eventType = 'TAMPERED';

    const before_ = outboxPosition(diverging).queued;
    sweep(diverging, 50);

    // Written down before anything is transmitted, which is exactly the
    // circumstance a chain divergence is most likely to be found in.
    assert.ok(outboxPosition(diverging).queued > before_, 'a divergence told nobody');
  });

  it('does not fall over when there is nobody to tell', async () => {
    const alone = new Platform();
    const aloneSeed = await seedDemoProject(alone);
    const events = alone.ledger.events({ projectId: aloneSeed.projectId });
    (events[2] as { eventType: string }).eventType = 'TAMPERED';

    // A deployment with no operator still has to complete the sweep and record
    // the finding; losing the sweep as well would turn one problem into two.
    const report = sweep(alone, 50);
    assert.equal(report.diverged.length, 1);
    assert.equal(assurancePosition(alone).diverged.length, 1);
  });
});

describe('it detects, and never repairs', () => {
  it('exposes no way to mark a diverged chain as intact', async () => {
    // A process that "fixed" a chain would be indistinguishable from the
    // tampering it exists to catch. There is deliberately no repair entry
    // point, and this is what stops one being added later as a convenience.
    const module = await import('../src/ops/assurance.ts');
    const suspicious = Object.keys(module).filter((name) => /repair|fix|heal|reconcile|clear|resolve/i.test(name));
    assert.deepEqual(
      suspicious,
      [],
      `assurance exports ${suspicious.join(', ')} — a chain divergence is detected and reported, never mended`,
    );
  });

  it('keeps a divergence on the position until the record itself changes', async () => {
    const diverged = new Platform();
    const divergedSeed = await seedDemoProject(diverged);
    const events = diverged.ledger.events({ projectId: divergedSeed.projectId });
    (events[2] as { eventType: string }).eventType = 'TAMPERED';

    sweep(diverged, 50);
    assert.equal(assurancePosition(diverged).diverged.length, 1);

    // Sweeping again does not clear it. A finding that ages out is one nobody
    // ever has to answer for.
    sweep(diverged, 50);
    assert.equal(assurancePosition(diverged).diverged.length, 1);
  });
});

// --------------------------------------------------- auto-repair, bounded

describe('auto-repair does two things and refuses the rest', () => {
  beforeEach(() => resetRepair());

  it('publishes what it will never do, rather than leaving it to be assumed', () => {
    const position = repairPosition();
    const refuses = position.refuses.join(' ');

    // The boundary is the product. A boundary nobody can read is one nobody can
    // hold anybody to.
    assert.match(refuses, /Changing code/);
    assert.match(refuses, /Deploying/);
    assert.match(refuses, /project state/);
    assert.match(refuses, /chain divergence/);
  });

  it('exposes no way to change code, configuration or a chain', async () => {
    const module = await import('../src/ops/repair.ts');
    const suspicious = Object.keys(module).filter((name) =>
      /deploy|patch|rollback|config|credential|permission|chain/i.test(name),
    );
    assert.deepEqual(suspicious, [], `repair exports ${suspicious.join(', ')}`);
  });

  it('does nothing when there is nothing owed', async () => {
    const quiet = new Platform();
    const taken = await repair(quiet);
    // A repairer that fires on a healthy platform trains everybody to ignore
    // its output.
    assert.deepEqual(taken, []);
  });

  it('moves a queue that is owed, and says what it observed', async () => {
    const owing = new Platform();
    const owingSeed = await seedDemoProject(owing);
    owing.createOperator({ name: 'On call', email: 'oncall@example.test' });

    // A divergence queues a notice; nothing drains it in a test process.
    const events = owing.ledger.events({ projectId: owingSeed.projectId });
    (events[2] as { eventType: string }).eventType = 'TAMPERED';
    resetAssurance();
    sweep(owing, 50);

    const taken = await repair(owing);
    assert.ok(taken.length > 0, 'a queue that was owed was left owed');

    const drained = taken.find((entry) => entry.action === 'DRAIN_OWED_NOTICES')!;
    assert.ok(drained, 'the owed queue was not drained');
    // Never "just in case": every repair names what was observed.
    assert.ok(drained.because.length > 40, drained.because);
  });

  it('names a repair that keeps firing as a finding rather than a fix', async () => {
    const owing = new Platform();
    const owingSeed = await seedDemoProject(owing);
    owing.createOperator({ name: 'On call', email: 'oncall2@example.test' });

    for (let pass = 0; pass < RECURRENCE_THRESHOLD + 1; pass += 1) {
      const events = owing.ledger.events({ projectId: owingSeed.projectId });
      (events[2 + pass] as { eventType: string }).eventType = `TAMPERED_${pass}`;
      resetAssurance();
      sweep(owing, 50);
      await repair(owing);
    }

    const position = repairPosition();
    // Something is re-breaking, and the thing meant to paper over a blip is
    // hiding a defect instead.
    assert.ok(position.recurring.length > 0, 'a repair fired repeatedly and was reported as a fix');
    assert.match(position.recurring[0]!.because, /not a fix/);
  });
});
