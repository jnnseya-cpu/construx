import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { Journal } from '../src/goldenthread/journal.ts';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * Durability.
 *
 * The ledger was an in-process array: a restart lost the entire record. For a
 * platform whose whole claim is an append-only, legally citable audit chain,
 * that is not a limitation, it is the product not existing between deploys.
 *
 * Three properties carry the weight:
 *
 *   1. **Write-ahead.** The event reaches the disk before the ledger mutates
 *      anything. If the write fails, the commit fails and no state changed —
 *      the alternative acknowledges a commit that is not durable, after the
 *      caller has already told somebody their notice was issued.
 *   2. **Restore verifies.** Replay recomputes every chain hash and state hash
 *      rather than trusting the file, so an altered journal is refused. A
 *      record that verifies against nothing is worse than no record.
 *   3. **A torn tail is not corruption.** A crash mid-append leaves an
 *      incomplete final line; that event was never acknowledged, so dropping it
 *      is correct. An unparseable line anywhere *else* is corruption and
 *      refuses to load.
 */

let directory: string;
let counter = 0;

const nextPath = () => join(directory, `ledger-${++counter}.jsonl`);

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-journal-'));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Commit a handful of real events through a journalled ledger. */
async function seededJournal(path: string): Promise<{ platform: Platform; journal: Journal; events: number }> {
  const journal = new Journal(path, { fsync: false });
  const platform = new Platform();
  platform.ledger.attachJournal(journal);
  await seedDemoProject(platform);
  journal.close();
  return { platform, journal, events: platform.ledger.events().length };
}

describe('writing', () => {
  it('appends one line per event and can read them back', async () => {
    const path = nextPath();
    const { events } = await seededJournal(path);

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, events, 'the journal does not hold one line per committed event');
    assert.ok(events > 100, `the fixture committed only ${events} events — check the seed`);

    const { events: read, stats } = new Journal(path).read();
    assert.equal(read.length, events);
    assert.equal(stats.truncated, false);
  });

  it('writes the event before the ledger changes, so a failed write commits nothing', () => {
    // Simulated by a journal that throws. The ledger must not have recorded the
    // event, because the caller is about to be told the command failed.
    const ledger = new GoldenThreadLedger();
    const exploding = {
      append() {
        throw new Error('disk full');
      },
      close() {},
      open() {},
    };
    ledger.attachJournal(exploding as unknown as Journal);

    assert.throws(
      () =>
        ledger.commit({
          tenantId: 't1',
          projectId: 'p1',
          actor: { refType: 'System', refId: 'test' },
          source: 'SYSTEM',
          eventType: 'PROJECT_CREATED',
          entity: { refType: 'Project', refId: 'proj-1' },
          nextState: { id: 'proj-1', name: 'Probe' },
          correlationId: 'c1',
        }),
      /disk full/,
    );

    assert.equal(ledger.events().length, 0, 'an event was recorded despite the journal write failing');
    assert.equal(ledger.get({ refType: 'Project', refId: 'proj-1' }), undefined, 'state changed despite the failure');
  });

  it('creates the directory, so an empty volume is not a boot failure', () => {
    const path = join(directory, 'nested', 'deeper', 'ledger.jsonl');
    const journal = new Journal(path, { fsync: false });
    journal.open();
    journal.close();
    assert.equal(new Journal(path).read().events.length, 0);
  });

  it('reports an absent journal as empty rather than throwing', () => {
    const { events, stats } = new Journal(join(directory, 'never-written.jsonl')).read();
    assert.deepEqual(events, []);
    assert.equal(stats.events, 0);
  });
});

describe('restoring', () => {
  it('rebuilds every entity, and the chain head matches', async () => {
    const path = nextPath();
    const { platform: original, events } = await seededJournal(path);

    const restored = new Platform();
    const result = restored.ledger.restore(new Journal(path).read().events);

    assert.equal(result.restored, events);
    assert.ok(result.entities > 50, `only ${result.entities} entities were rebuilt — check the fixture`);

    // The strongest single assertion available: the chain head is a hash over
    // every event in order, so matching it means nothing was lost, reordered
    // or altered.
    const projectId = original.ledger.events()[0]!.projectId;
    assert.equal(
      restored.ledger.chainHead(projectId),
      original.ledger.chainHead(projectId),
      'the restored chain head differs from the original',
    );
  });

  it('rebuilds state identical to the original, entity for entity', async () => {
    const path = nextPath();
    const { platform: original } = await seededJournal(path);

    const restored = new Platform();
    restored.ledger.restore(new Journal(path).read().events);

    const projectId = original.ledger.events()[0]!.projectId;
    for (const refType of ['Project', 'Task', 'PaymentApplication', 'Risk']) {
      const before = original.ledger.list(projectId, refType);
      const after = restored.ledger.list(projectId, refType);
      assert.equal(after.length, before.length, `${refType} count differs after restore`);
      for (const [index, record] of before.entries()) {
        assert.equal(after[index]!.stateHash, record.stateHash, `${refType} ${record.refId} restored to different state`);
      }
    }
  });

  it('refuses a journal whose event has been altered', async () => {
    const path = nextPath();
    await seededJournal(path);

    // Change one byte of one event's payload. The state hash it carries no
    // longer matches the patch it carries.
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const target = JSON.parse(lines[3]!);
    target.diff = [{ op: 'add', path: '/tamperedField', value: 'injected' }];
    lines[3] = JSON.stringify(target);
    const tamperedPath = nextPath();
    writeFileSync(tamperedPath, `${lines.join('\n')}\n`);

    // The code, not the message: the platform separates the two deliberately,
    // and matching prose would let a reworded error pass.
    const platform = new Platform();
    try {
      platform.ledger.restore(new Journal(tamperedPath).read().events);
      assert.fail('an altered journal was accepted');
    } catch (error) {
      assert.match(
        String((error as { code?: string }).code),
        /^JOURNAL_(STATE_MISMATCH|CHAIN_BROKEN)$/,
        `expected a journal integrity code, got ${(error as { code?: string }).code}`,
      );
    }
  });

  it('refuses a journal with an event removed from the middle', async () => {
    const path = nextPath();
    await seededJournal(path);

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    lines.splice(5, 1);
    const gappedPath = nextPath();
    writeFileSync(gappedPath, `${lines.join('\n')}\n`);

    const platform = new Platform();
    throwsCode(() => platform.ledger.restore(new Journal(gappedPath).read().events), 'JOURNAL_CHAIN_BROKEN');
  });

  it('refuses a journal whose events have been reordered', async () => {
    const path = nextPath();
    await seededJournal(path);

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    [lines[6], lines[7]] = [lines[7]!, lines[6]!];
    const swappedPath = nextPath();
    writeFileSync(swappedPath, `${lines.join('\n')}\n`);

    const platform = new Platform();
    throwsCode(() => platform.ledger.restore(new Journal(swappedPath).read().events), 'JOURNAL_CHAIN_BROKEN');
  });
});

describe('a hard stop', () => {
  it('treats an incomplete final line as a torn write, not corruption', async () => {
    const path = nextPath();
    const { events } = await seededJournal(path);

    // A process killed between the write and the newline.
    appendFileSync(path, '{"eventId":"01ABC","tenantId":"t1","proje');

    const { events: read, stats } = new Journal(path).read();
    assert.equal(stats.truncated, true, 'the torn tail was not detected');
    assert.equal(read.length, events, 'a complete event was dropped along with the torn one');

    // And the surviving events still restore and verify.
    const platform = new Platform();
    assert.equal(platform.ledger.restore(read).restored, events);
  });

  it('refuses an unparseable line that is not the last one', async () => {
    const path = nextPath();
    await seededJournal(path);

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    lines[4] = '{ this is not json';
    const brokenPath = nextPath();
    writeFileSync(brokenPath, `${lines.join('\n')}\n`);

    // A torn write can only ever be the final line. Anywhere else it is real
    // corruption, and skipping it would leave a chain that verifies against
    // nothing.
    assert.throws(() => new Journal(brokenPath).read(), /corrupt at line 5/);
  });

  it('repairs a torn tail by rewriting, leaving the file loadable', async () => {
    const path = nextPath();
    const { events } = await seededJournal(path);
    appendFileSync(path, '{"eventId":"01TORN","partial');

    const journal = new Journal(path, { fsync: false });
    const { events: read } = journal.read();
    journal.repair(read);
    journal.close();

    const after = new Journal(path).read();
    assert.equal(after.stats.truncated, false, 'the file is still torn after repair');
    assert.equal(after.events.length, events);
  });
});

describe('a restart, end to end', () => {
  it('loses nothing across a stop and a start, and keeps writing afterwards', async () => {
    const path = nextPath();

    // First process: seed, then stop.
    const first = new Platform();
    const journalOne = new Journal(path, { fsync: false });
    first.ledger.attachJournal(journalOne);
    const seed = await seedDemoProject(first);
    const beforeCount = first.ledger.events().length;
    const beforeHead = first.ledger.chainHead(seed.projectId);
    journalOne.close();

    // Second process: restore, then commit something new.
    const second = new Platform();
    second.ledger.restore(new Journal(path).read().events);
    assert.equal(second.ledger.chainHead(seed.projectId), beforeHead, 'the chain did not survive the restart');

    const journalTwo = new Journal(path, { fsync: false });
    journalTwo.open();
    second.ledger.attachJournal(journalTwo);
    second.ledger.commit({
      tenantId: 'platform',
      projectId: seed.projectId,
      actor: { refType: 'System', refId: 'restart-test' },
      source: 'SYSTEM',
      eventType: 'PROGRESS_RECORDED',
      entity: { refType: 'ProgressMeasurement', refId: 'after-restart' },
      nextState: { id: 'after-restart', percent: 12 },
      evidenceRefs: [{ refType: 'Evidence', refId: 'ev-1' }],
      correlationId: 'restart-1',
    });
    journalTwo.close();

    // Third process: the new event is there too, and the whole chain verifies.
    const third = new Platform();
    const result = third.ledger.restore(new Journal(path).read().events);
    assert.equal(result.restored, beforeCount + 1, 'the post-restart commit was not journalled');
    assert.ok(
      third.ledger.get({ refType: 'ProgressMeasurement', refId: 'after-restart' }),
      'the event committed after the restart did not survive the next one',
    );
  });
});

describe('the people who can reach the record', () => {
  /**
   * The ledger restores projects. It does not, on its own, restore anybody able
   * to open them: tenants, users, subscriptions and wallets live in the
   * platform's own maps rather than in the chain.
   *
   * Found by restarting a real process against a real journal. It reported
   * "363 events restored into 293 entities" and then answered
   * "No user with that email address" to every sign-in — a complete record,
   * fully verified, and orphaned.
   */
  it('restores the identities, so somebody can sign in after a restart', async () => {
    const path = nextPath();
    const { platform: original } = await seededJournal(path);
    const email = 'pm@meridian.example';
    assert.ok(original.userByEmail(email), 'the fixture has no user to restore');

    const restored = new Platform();
    restored.ledger.restore(new Journal(path).read().events);
    assert.equal(restored.userByEmail(email), undefined, 'the ledger alone should not populate the identity model');

    const counts = restored.rehydrate();
    assert.ok(counts.users > 5, `only ${counts.users} users were rehydrated`);

    const user = restored.userByEmail(email);
    assert.ok(user, 'nobody could sign in after the restart');
    assert.deepEqual(user.roles, original.userByEmail(email)!.roles, 'roles changed across the restart');
    assert.equal(user.tenantId, original.userByEmail(email)!.tenantId);
  });

  it('restores the subscription with its seat assignments intact', async () => {
    const path = nextPath();
    const { platform: original } = await seededJournal(path);
    const tenantId = original.userByEmail('pm@meridian.example')!.tenantId;
    const before = original.subscription(tenantId);

    const restored = new Platform();
    restored.ledger.restore(new Journal(path).read().events);
    restored.rehydrate();

    const after = restored.subscription(tenantId);
    assert.equal(after.package, before.package);
    assert.equal(after.tier, before.tier);
    assert.deepEqual(
      [...after.assignedIdentities].sort(),
      [...before.assignedIdentities].sort(),
      'seat assignments were lost, so the next hire would be charged against a stale count',
    );
  });
});

describe('money across a restart', () => {
  /**
   * The wallet is a fold over its entries, so it restores exactly — provided
   * the entries are durable. They are journalled separately from the Golden
   * Thread because ACU spend is deliberately its own double-entry ledger;
   * folding it into the chain would create a second source of truth for money.
   *
   * The failure this guards against is specific and one-directional: a wallet
   * that replays its top-ups but not its debits comes back richer than it
   * should be, and the platform gives away AI it already paid a provider for.
   */
  async function walletFixture() {
    const path = nextPath();
    const entries: import('../src/billing/acu.ts').ACUEntry[] = [];

    const platform = new Platform();
    platform.attachWalletSink((entry) => entries.push(entry));
    const journal = new Journal(path, { fsync: false });
    platform.ledger.attachJournal(journal);
    const seed = await seedDemoProject(platform);
    journal.close();

    return { path, entries, platform, seed };
  }

  it('restores the balance exactly, debits included', async () => {
    const { path, entries, platform } = await walletFixture();
    const tenantId = platform.userByEmail('pm@meridian.example')!.tenantId;
    const before = platform.wallet(tenantId).snapshot();

    assert.ok(before.lifetimeBilledMinor > 0, 'the fixture spent nothing — a debit-losing bug would pass silently');

    const byTenant = new Map<string, typeof entries>();
    for (const entry of entries) {
      const list = byTenant.get(entry.tenantId) ?? [];
      list.push(entry);
      byTenant.set(entry.tenantId, list);
    }

    const restored = new Platform();
    restored.ledger.restore(new Journal(path).read().events);
    restored.rehydrate(byTenant);

    const after = restored.wallet(tenantId).snapshot();
    assert.equal(after.balanceMinor, before.balanceMinor, 'the balance changed across the restart');
    assert.equal(after.lifetimeBilledMinor, before.lifetimeBilledMinor, 'spend history was lost');
  });

  it('does not reinstate holds, which belong to calls that died with the process', async () => {
    const { path, entries, platform } = await walletFixture();
    const tenantId = platform.userByEmail('pm@meridian.example')!.tenantId;

    const byTenant = new Map([[tenantId, entries.filter((e) => e.tenantId === tenantId)]]);
    const restored = new Platform();
    restored.ledger.restore(new Journal(path).read().events);
    restored.rehydrate(byTenant);

    const wallet = restored.wallet(tenantId);
    // Available equals the balance: nothing is reserved, because reinstating a
    // hold would reserve money against work that will never run.
    assert.equal(wallet.heldMinor(), 0, "a hold was reinstated for a call that died with the process");
    assert.equal(wallet.availableMinor(), wallet.snapshot().balanceMinor);
  });

  it('journals a wallet created after boot, not only those present at start', async () => {
    // The failure this catches: attaching the sink only to wallets that existed
    // when the process started, so a tenancy provisioned at 10am is durable and
    // one provisioned at 11am is not.
    const captured: Array<{ tenantId: string }> = [];
    const platform = new Platform();
    platform.attachWalletSink((entry) => captured.push(entry));

    const { tenant } = platform.createTenant({
      legalName: 'Late Arrival Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      enterpriseName: 'Late Arrival',
    });

    assert.ok(
      captured.some((entry) => entry.tenantId === tenant.id),
      'a tenancy created after boot was not journalled',
    );
  });
});
