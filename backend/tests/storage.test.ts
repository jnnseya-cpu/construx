import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import { registerEvidence } from '../src/engines/context.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import {
  allowanceBytes,
  assertCapacity,
  purchasedBlocks,
  storagePosition,
  STORAGE_BLOCK_GB,
  STORAGE_WARN_AT,
} from '../src/billing/storage.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Storage as a metered entitlement.
 *
 * `storageGb` was on every package from the first day, printed on the pricing
 * page and on the billing screen, and enforced nowhere — the same shape of
 * defect as the ACU bundle that advertised a third more credit than the
 * multiplier would ever yield. A tenant on the hundred-gigabyte plan could
 * upload a terabyte.
 *
 * The thing that makes this different from an ordinary quota is that usage only
 * ever goes up. Nothing the ledger names is deletable, so there is no state an
 * over-quota tenant can return to, and "bill them for the overage" is a bill
 * that grows for ever against storage the platform can never reclaim. That is
 * why the hundred-per-cent case has to stop the write.
 */

const GB = 1024 * 1024 * 1024;

describe('what a plan allows', () => {
  it('adds bought blocks to what the package includes', () => {
    const included = PACKAGES.CORE_PROJECT.storageGb!;
    assert.equal(allowanceBytes('CORE_PROJECT', 0), included * GB);
    assert.equal(allowanceBytes('CORE_PROJECT', 2), (included + 2 * STORAGE_BLOCK_GB) * GB);
  });

  it('reports an uncapped package as uncapped rather than as a very large number', () => {
    // A sentinel would be a cap somebody eventually reaches, and reaching it
    // would look like a defect rather than a decision.
    assert.equal(allowanceBytes('ENTERPRISE', 0), null);
    assert.equal(PACKAGES.ENTERPRISE.storageGb, null);

    const position = storagePosition({ tier: 'ENTERPRISE', usedBytes: 900 * GB, purchasedBlocks: 0 });
    assert.equal(position.limitBytes, null);
    assert.equal(position.percentUsed, null, 'a percentage of no limit is undefined, not zero');
    assert.equal(position.state, 'OK');
    // Still measured, because storage nobody is watching is how a volume fills.
    assert.equal(position.usedBytes, 900 * GB);
  });

  it('flags at seventy per cent and not before', () => {
    const limit = PACKAGES.CORE_PROJECT.storageGb! * GB;

    const under = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit * 0.69, purchasedBlocks: 0 });
    const at = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit * STORAGE_WARN_AT, purchasedBlocks: 0 });

    assert.equal(under.state, 'OK');
    assert.equal(at.state, 'WARNING');
    assert.equal(under.nextBlock, undefined, 'a plan with room offered capacity nobody needs yet');
    assert.ok(at.nextBlock, 'a warning that does not say what to do about it is a nag');
    assert.equal(at.nextBlock.gb, STORAGE_BLOCK_GB);
    assert.equal(at.nextBlock.priceMinor, config.billing.storageBlockPriceMinor);
  });

  it('says the only way down is more capacity, because deletion is not on the table', () => {
    const limit = PACKAGES.CORE_PROJECT.storageGb! * GB;
    const warning = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit * 0.8, purchasedBlocks: 0 });
    assert.match(warning.summary, /Nothing already stored can be deleted/i);
  });

  it('is full at the limit, and says what still works', () => {
    // A full disk must not stop a contract being administered. What stops is
    // supplying files — the record, the approvals and the signatures continue.
    const limit = PACKAGES.CORE_PROJECT.storageGb! * GB;
    const full = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit, purchasedBlocks: 0 });

    assert.equal(full.state, 'FULL');
    assert.equal(full.remainingBytes, 0);
    assert.match(full.summary, /Records, approvals and signatures are unaffected/i);
  });

  it('comes back under the line when a block is bought', () => {
    const limit = PACKAGES.CORE_PROJECT.storageGb! * GB;
    const full = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit, purchasedBlocks: 0 });
    const bought = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit, purchasedBlocks: 1 });

    assert.equal(full.state, 'FULL');
    assert.equal(bought.state, 'OK');
    assert.equal(bought.purchasedGb, STORAGE_BLOCK_GB);
    assert.equal(bought.limitBytes, limit + STORAGE_BLOCK_GB * GB);
  });
});

describe('refusing the write', () => {
  it('measures the incoming file, not the total on its own', () => {
    // A tenant 1 MB under the line uploading a 40 MB drawing set would otherwise
    // be allowed to cross it, and the next upload would fail for a file that had
    // nothing to do with it.
    const limit = PACKAGES.CORE_PROJECT.storageGb! * GB;
    const nearly = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit - 1_048_576, purchasedBlocks: 0 });

    assert.equal(nearly.state, 'WARNING', 'not yet full');
    assert.doesNotThrow(() => assertCapacity(nearly, 500_000));
    throwsCode(() => assertCapacity(nearly, 40 * 1_048_576), 'STORAGE_LIMIT_REACHED');
  });

  it('refuses with 507, because the request was fine and the server cannot hold it', () => {
    const limit = PACKAGES.CORE_PROJECT.storageGb! * GB;
    const full = storagePosition({ tier: 'CORE_PROJECT', usedBytes: limit, purchasedBlocks: 0 });

    try {
      assertCapacity(full, 1);
      assert.fail('a full plan accepted another byte');
    } catch (error) {
      assert.equal((error as { status?: number }).status, 507);
      // The message has to name the way out, or the person reads it as a fault.
      assert.match((error as Error).message, /100 GB block/);
      assert.match((error as Error).message, /hash is still on the record/i);
    }
  });

  it('never refuses an uncapped package', () => {
    const uncapped = storagePosition({ tier: 'ENTERPRISE', usedBytes: 40_000 * GB, purchasedBlocks: 0 });
    assert.doesNotThrow(() => assertCapacity(uncapped, 50 * 1_048_576));
  });
});

describe('measuring what is held', () => {
  let directory: string;
  let platform: Platform;
  let seed: SeedResult;
  let store: EvidenceStore;

  before(async () => {
    directory = mkdtempSync(join(tmpdir(), 'construx-storage-'));
    store = new EvidenceStore(directory);
    platform = new Platform(undefined, store);
    seed = await seedDemoProject(platform);
  });

  after(() => rmSync(directory, { recursive: true, force: true }));

  /** Register the hash the way a domain command does, then supply the bytes. */
  function store_(content: string): number {
    const bytes = Buffer.from(content, 'utf8');
    const hash = hashBytes(bytes);
    const ctx = platform.context(seed.users.pm!.auth, seed.projectId, { correlationId: 'storage-test' });
    registerEvidence(ctx, { type: 'SITE_PHOTOGRAPH', hash, description: 'Uploaded in a test' });
    store.put(seed.tenantId, hash, bytes, 'image/jpeg');
    return bytes.length;
  }

  it('counts bytes as they are stored', () => {
    const before = store.usage(seed.tenantId);
    const added = store_('a photograph of the filter gallery pour');
    assert.equal(store.usage(seed.tenantId), before + added);
  });

  it('counts a file stored twice once, because the outbox retries', () => {
    // The offline outbox re-uploads what it could not confirm. Counting the
    // retry would bill a tenant for a file the store deduplicated away.
    const before = store.usage(seed.tenantId);
    const added = store_('a rebar cover check, uploaded twice');
    const afterFirst = store.usage(seed.tenantId);
    assert.equal(afterFirst, before + added);

    store_('a rebar cover check, uploaded twice');
    assert.equal(store.usage(seed.tenantId), afterFirst, 'the retry was counted a second time');
  });

  it('gives the bytes back when an orphan is discarded', () => {
    const bytes = Buffer.from('an object no record names', 'utf8');
    const hash = hashBytes(bytes);
    // Planted the way a restore does, so it is an orphan the register can remove.
    const digest = hash.slice('sha256:'.length);
    const dir = join(directory, seed.tenantId, digest.slice(0, 2), digest.slice(2, 4));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, digest), bytes);

    // Warm the cache from the volume so the planted object is counted.
    const withOrphan = new EvidenceStore(directory).usage(seed.tenantId);
    const fresh = new EvidenceStore(directory);
    assert.equal(fresh.usage(seed.tenantId), withOrphan);

    fresh.discard(seed.tenantId, hash);
    assert.equal(fresh.usage(seed.tenantId), withOrphan - bytes.length);
  });

  it('does not count another tenancy against this one', () => {
    const mine = store.usage(seed.tenantId);
    assert.equal(store.usage('some-other-tenant'), 0);
    assert.equal(store.usage(seed.tenantId), mine);
  });

  it('reads bought blocks off the ledger rather than a counter', () => {
    // A counter is a second place the truth can live, and the one that
    // disagrees is always the one nobody is looking at.
    assert.equal(purchasedBlocks(platform.ledger, seed.tenantId), 0);

    const ctx = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, {
      correlationId: 'storage-test',
    });
    for (const blocks of [1, 2]) {
      ctx.ledger.commit({
        tenantId: seed.tenantId,
        projectId: `${seed.tenantId}-governance`,
        actor: { refType: 'User', refId: seed.users.admin!.id },
        source: 'WEB',
        correlationId: 'storage-test',
        eventType: 'STORAGE_CAPACITY_PURCHASED',
        entity: { refType: 'StorageEntitlement', refId: `ent-${blocks}` },
        nextState: { id: `ent-${blocks}`, tenantId: seed.tenantId, blocks },
        timestamp: new Date().toISOString(),
      });
    }

    assert.equal(purchasedBlocks(platform.ledger, seed.tenantId), 3, 'purchases accumulate rather than replace');
  });
});
