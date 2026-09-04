import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { canonicalize, EMPTY_STATE_HASH, sha256 } from '../src/core/canonical.ts';
import { Journal } from '../src/goldenthread/journal.ts';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
import { replayProject } from '../src/goldenthread/replay.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { packageForTier } from '../src/billing/subscription.ts';
import { allowanceBytes } from '../src/billing/storage.ts';

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

describe('the state hash is taken over what is written', () => {
  it('a Date or a Buffer in a proposal is hashed as the JSON it becomes, so the journal replays', async () => {
    const path = nextPath();
    const journal = new Journal(path, { fsync: false });
    const platform = new Platform();
    platform.ledger.attachJournal(journal);
    await seedDemoProject(platform);
    const projectId = platform.ledger.events()[0]!.projectId;
    // What a caller can hand the ledger without noticing: a Date where an ISO
    // string was meant, bytes where a hash was meant.
    platform.ledger.commit({
      tenantId: platform.ledger.events()[0]!.tenantId,
      projectId,
      actor: { refType: 'System', refId: 'test' },
      source: 'SYSTEM',
      correlationId: 'date-in-state',
      eventType: 'EVIDENCE_REGISTERED',
      entity: { refType: 'EvidenceItem', refId: 'ev-date' },
      nextState: { id: 'ev-date', type: 'PHOTO', hash: 'sha256:0', capturedAt: new Date('2026-09-04T15:39:36.796Z') as unknown as string, capturedBy: 'x', bytes: Buffer.from('abc') as unknown as string, linkedEntities: [] },
    });
    journal.close();
    const stored = platform.ledger.get({ refType: 'EvidenceItem', refId: 'ev-date' })!;
    assert.equal(typeof stored.state.capturedAt, 'string', 'the state the ledger holds is the state it wrote');

    const restored = new Platform();
    const result = restored.ledger.restore(new Journal(path).read().events);
    assert.deepEqual(result.discrepancies, []);
    assert.equal(restored.ledger.chainHead(projectId), platform.ledger.chainHead(projectId));
  });

  it('replays an event whose recorded state hash was computed over a value JSON changed, reports it, and refuses a tampered one', async () => {
    const path = nextPath();
    const { platform: original } = await seededJournal(path);
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

    // Reproduce what an earlier build wrote: the state hash taken over an
    // object holding a Date, the patch holding the string it serialised to.
    const target = 5;
    const event = events[target]!;
    const key = `${(event.entity as { refType: string }).refType}:${(event.entity as { refId: string }).refId}`;
    const wrongHash = sha256('the hash of the object in memory, not of the JSON');
    event.afterHash = wrongHash;
    // The process carried on from the object it had: the next event it wrote
    // for that entity chains from the hash it recorded.
    const next = events.slice(target + 1).find((candidate) => `${(candidate.entity as { refType: string }).refType}:${(candidate.entity as { refId: string }).refId}` === key);
    if (next) next.beforeHash = wrongHash;
    // Re-seal the chain as that process would have: every chain hash is over
    // the body as written, including the recorded state hashes.
    const heads = new Map<string, string>();
    for (const held of events) {
      const previous = heads.get(held.projectId as string) ?? EMPTY_STATE_HASH;
      const { chainHash: _c, previousChainHash: _p, ...body } = held;
      held.previousChainHash = previous;
      held.chainHash = sha256(`${previous}\n${canonicalize(body)}`);
      heads.set(held.projectId as string, held.chainHash as string);
    }
    const resealed = nextPath();
    writeFileSync(resealed, `${events.map((held) => JSON.stringify(held)).join('\n')}\n`);

    const platform = new Platform();
    const result = platform.ledger.restore(new Journal(resealed).read().events);
    assert.equal(result.restored, events.length, 'every event replayed');
    assert.equal(result.discrepancies.length, 1);
    assert.equal(result.discrepancies[0]!.eventId, event.eventId);
    assert.equal(result.discrepancies[0]!.recorded, wrongHash);
    assert.deepEqual(platform.ledger.discrepancies(), result.discrepancies);
    // The state is what the patches produce, the same as the original process held.
    const [refType, refId] = key.split(':') as [string, string];
    assert.deepEqual(platform.ledger.get({ refType, refId })!.state, original.ledger.get({ refType, refId })!.state);

    // Work continues from the replayed state, and the whole record — the old
    // discrepancy and the new event — replays again on the next restart.
    platform.ledger.commit({
      tenantId: event.tenantId as string,
      projectId: event.projectId as string,
      actor: { refType: 'System', refId: 'test' },
      source: 'SYSTEM',
      correlationId: 'after-discrepancy',
      eventType: 'EVIDENCE_REGISTERED',
      entity: { refType: 'EvidenceItem', refId: 'ev-after' },
      nextState: { id: 'ev-after', type: 'PHOTO', hash: 'sha256:1', capturedAt: '2026-09-04T16:00:00.000Z', capturedBy: 'x', linkedEntities: [] },
    });
    const again = new Platform().ledger.restore(platform.ledger.events());
    assert.equal(again.discrepancies.length, 1, 'the discrepancy is reported on every replay; nothing is rewritten');

    // The replay engine — what the audit screens and the assurance sweep walk
    // — judges the same event the same way: verified against the chain, with
    // the discrepancy named, not a broken chain. The Audit logs screen used to
    // say "Chain BROKEN — 4 events altered" over exactly this record.
    const report = replayProject(platform.ledger, event.tenantId as string, event.projectId as string, new Date().toISOString());
    assert.equal(report.verificationStatus, 'VERIFIED');
    assert.deepEqual(report.failures, []);
    assert.equal(report.discrepancies.length, 1);
    assert.equal(report.discrepancies[0]!.eventId, event.eventId);
    assert.equal(report.discrepancies[0]!.status, 'STATE_HASH_DISCREPANCY');
    assert.equal(report.summary.STATE_HASH_DISCREPANCY, 1);
    // And the entity it belongs to is reconstructed — replay did not stop
    // advancing it at the discrepancy.
    assert.ok(report.entities.some((entity) => entity.refType === refType && entity.refId === refId));

    // A genuinely altered event is still refused: change the patch and leave
    // the chain hash as it was.
    const tampered = events.map((held) => ({ ...held }));
    tampered[target]!.diff = [{ op: 'add', path: '/tamperedField', value: 'injected' }];
    const tamperedPath = nextPath();
    writeFileSync(tamperedPath, `${tampered.map((held) => JSON.stringify(held)).join('\n')}\n`);
    throwsCode(() => new Platform().ledger.restore(new Journal(tamperedPath).read().events), 'JOURNAL_CHAIN_BROKEN');
  });
});

describe('the ledger\'s own state is nobody else\'s to change', () => {
  it('a restarted process closing a tenancy — the sequence that broke production — replays cleanly', async () => {
    const path = nextPath();
    const first = new Platform();
    const journal = new Journal(path, { fsync: false });
    first.ledger.attachJournal(journal);
    const operator = first.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
    const created = first.createTenant({ legalName: 'Etablix', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'ENTERPRISE', package: 'ENTERPRISE', enterpriseName: 'Etablix' });
    first.createUser({ tenantId: created.tenant.id, name: 'Justin', email: 'justin@etablix.example', roles: ['ENTERPRISE_ADMIN'] });
    first.createUser({ tenantId: created.tenant.id, name: 'Amara', email: 'amara@etablix.example', roles: ['PM'] });
    journal.close();

    // Restart: the platform's maps are rebuilt from the chain.
    const second = new Platform();
    const secondJournal = new Journal(path, { fsync: false });
    second.ledger.restore(secondJournal.read().events);
    second.rehydrate();
    secondJournal.open();
    second.ledger.attachJournal(secondJournal);
    const ops = second.userByEmail('ops@construx.example')!;
    // Closing the tenancy deactivates and requests erasure for every person,
    // and the seat revocation marks the user record suspended in place. When
    // that record was the ledger's own object, the ledger's before-state moved
    // with it and the next commit recorded a hash its patch could not reproduce.
    const { authOf } = await import('../src/seed.ts');
    second.closeTenant(authOf(second, ops.id), { tenantId: created.tenant.id, reason: 'change of structure is coming' });
    secondJournal.close();

    const third = new Platform();
    const result = third.ledger.restore(new Journal(path).read().events);
    assert.deepEqual(result.discrepancies, [], 'every event replays to the hash it recorded');
    third.rehydrate();
    assert.equal(third.userByEmail('amara@etablix.example')!.status, 'SUSPENDED');

    // The seat revocation used to write the subscription without its package,
    // so a restart after a closure rehydrated `package: undefined` and every
    // estate read that looked up `PACKAGES[subscription.package]` answered 500.
    const subscription = third.subscription(created.tenant.id);
    assert.equal(subscription.package, 'ENTERPRISE');
    assert.ok(PACKAGES[subscription.package].label);
    assert.equal(subscription.assignedIdentities.length, 0);
    assert.equal(allowanceBytes(subscription.package, 0) > 0, true);
    void operator;
  });

  it('derives the package from the tier for a journal written before the seat event carried it', () => {
    const platform = new Platform();
    const created = platform.createTenant({ legalName: 'Legacy Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'BUSINESS', enterpriseName: 'Legacy' });
    const before = platform.subscription(created.tenant.id);
    // Exactly the shape the old `IDENTITY_SEAT_REVOKED` wrote: tier, the
    // legacy price fields, and no package — so the diff removes the package.
    platform.ledger.commit({
      tenantId: created.tenant.id,
      projectId: `${created.tenant.id}-governance`,
      actor: { refType: 'System', refId: 'platform' },
      source: 'SYSTEM',
      correlationId: 'legacy-seat-event',
      eventType: 'IDENTITY_SEAT_REVOKED',
      entity: { refType: 'Subscription', refId: before.id },
      nextState: {
        id: before.id,
        tenantId: created.tenant.id,
        tier: before.tier,
        includedIdentities: 25,
        monthlyPriceUsd: 499,
        status: before.status,
        assignedIdentities: [],
      },
    });
    assert.equal(platform.ledger.require({ refType: 'Subscription', refId: before.id }).state.package, undefined);

    const restored = new Platform();
    assert.deepEqual(restored.ledger.restore(platform.ledger.events()).discrepancies, []);
    restored.rehydrate();
    const subscription = restored.subscription(created.tenant.id);
    assert.equal(subscription.package, packageForTier('BUSINESS'));
    assert.ok(PACKAGES[subscription.package].label);
  });

  it('refuses an in-place change to a record it holds', () => {
    const platform = new Platform();
    const created = platform.createTenant({ legalName: 'Frozen Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Frozen' });
    const record = platform.ledger.get({ refType: 'Tenant', refId: created.tenant.id })!;
    assert.throws(() => {
      (record.state as { legalName: string }).legalName = 'Changed in place';
    }, TypeError);
    assert.equal(platform.ledger.get({ refType: 'Tenant', refId: created.tenant.id })!.state.legalName, 'Frozen Ltd');
  });
});
