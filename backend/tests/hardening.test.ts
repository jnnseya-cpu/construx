import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createGateway, startGateway } from '../src/api/gateway.ts';
import { pruneIdempotency, rateLimiter } from '../src/api/middleware.ts';
import { readiness } from '../src/api/readiness.ts';
import { RecordJournal } from '../src/goldenthread/journal.ts';
import {
  attachRevocationJournal,
  createMfaChallenge,
  detachRevocationJournal,
  issueTokens,
  revocationCount,
  revokeToken,
  verifyToken,
  type RevocationRecord,
} from '../src/identity/auth.ts';
import { resetTrials, trialsTakenBy } from '../src/identity/trials.ts';
import { sweep, sweepYielding } from '../src/ops/assurance.ts';
import { sweepHygiene } from '../src/ops/hygiene.ts';
import { Platform } from '../src/platform.ts';

/**
 * The week-one hardening the launch deep dive asked for: state that must
 * survive a restart survives it, state that must not grow is swept, the
 * readiness probe can say no, and the process refuses the two configurations
 * it must never run in.
 */

const scratch = mkdtempSync(join(tmpdir(), 'construx-hardening-'));

after(() => {
  detachRevocationJournal();
  rmSync(scratch, { recursive: true, force: true });
});

describe('a revoked session stays revoked across a restart', () => {
  const path = join(scratch, 'ledger.jsonl.revoked');

  it('writes each revocation through, reads it back, and drops the expired ones', () => {
    detachRevocationJournal();
    attachRevocationJournal(new RecordJournal<RevocationRecord>(path, { fsync: false }));
    const live = issueTokens({ actorId: 'u1', tenantId: 't1', partyId: undefined, roles: ['PM'], mfaSatisfied: true });
    const liveClaims = verifyToken(live.accessToken);
    revokeToken(liveClaims.tokenId, Date.now() + 60_000);
    assert.throws(() => verifyToken(live.accessToken), /revoked/);
    // One that lapsed already: remembered now, dropped at the next boot.
    revokeToken('lapsed-token', Date.now() - 1);
    assert.equal(revocationCount(), 2);

    // The restart: a fresh process attaches the same file.
    detachRevocationJournal();
    assert.equal(revocationCount(), 0);
    assert.doesNotThrow(() => verifyToken(live.accessToken), 'forgotten in memory, which is the defect');
    const restored = attachRevocationJournal(new RecordJournal<RevocationRecord>(path, { fsync: false }));
    assert.equal(restored.restored, 1);
    assert.equal(restored.expired, 1);
    assert.throws(() => verifyToken(live.accessToken), /revoked/, 'still revoked after the restart');
    detachRevocationJournal();
  });
});

describe('the hygiene sweep drops what has expired and nothing else', () => {
  it('sweeps one-time codes, buckets, idempotent replies and revocations past their time', () => {
    detachRevocationJournal();
    createMfaChallenge('sweep-actor');
    revokeToken('old', Date.now() + 1_000);
    revokeToken('new', Date.now() + 3_600_000);
    const now = Date.now() + 6 * 60_000;
    const report = sweepHygiene(now);
    assert.equal(report.challenges, 1, 'the five-minute code is gone');
    assert.equal(report.revocations, 1, 'the lapsed revocation is gone');
    assert.equal(revocationCount(), 1, 'the live one is kept');
    assert.equal(sweepHygiene(now).challenges, 0, 'nothing left to drop');
    assert.equal(rateLimiter.prune(now), 0);
    assert.equal(pruneIdempotency(now), 0);
    detachRevocationJournal();
  });
});

describe('the readiness probe can say no', () => {
  let platform: Platform;
  let server: Server;
  let base: string;

  before(async () => {
    platform = new Platform();
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers 200 while the process can extend the record and 503 with the reasons once it is shutting down', async () => {
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal(((await ready.json()) as { status: string }).status, 'ok');
    platform.beginShutdown();
    const stopping = await fetch(`${base}/readyz`);
    assert.equal(stopping.status, 503);
    const body = (await stopping.json()) as { title: string; detail: string };
    assert.equal(body.title, 'NOT_READY');
    assert.match(body.detail, /shutting down/);
    assert.equal(platform.health().status, 'not-ready');
  });
});

describe('the gateway sets its own timeouts', () => {
  it('does not run on Node’s defaults', async () => {
    const server = await startGateway(new Platform(), 0);
    try {
      assert.equal(server.headersTimeout, 30_000);
      assert.equal(server.requestTimeout, 120_000);
      assert.equal(server.keepAliveTimeout, 65_000);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('the free-trial count survives a restart', () => {
  it('is rebuilt from the grants on the wallets', () => {
    resetTrials();
    const first = new Platform();
    const created = first.createTenant({ legalName: 'Trialled Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'FREE_TRIAL', package: 'FREE_TRIAL', enterpriseName: 'Trialled', trialGrant: true, opensOn: 'CREATION' });
    first.createUser({ tenantId: created.tenant.id, name: 'Founder', email: 'founder@trialled.example', roles: ['OWNER', 'ENTERPRISE_ADMIN'] });
    assert.ok(created.trialGrantMinor > 0, 'the free package carries the grant');
    assert.equal(trialsTakenBy('anybody@trialled.example'), 0, 'nothing counted yet: signup counts, createTenant does not');

    // The restart: replay the record and the wallet file into a fresh process.
    const second = new Platform();
    second.ledger.restore(first.ledger.events());
    second.rehydrate(new Map([[created.tenant.id, first.wallet(created.tenant.id).entries()]]));
    assert.equal(trialsTakenBy('anybody@trialled.example'), 1, 'the grant on the wallet is the count');
    assert.equal(trialsTakenBy('someone@elsewhere.example'), 0);
    resetTrials();
  });
});

describe('readiness names encryption at rest and the demonstration tenancy', () => {
  it('lists the evidence master key as a critical capability', () => {
    const report = readiness();
    const encryption = report.capabilities.find((capability) => capability.key === 'evidence.encryption');
    assert.ok(encryption);
    assert.equal(encryption.critical, true);
    assert.deepEqual(encryption.env, ['EVIDENCE_MASTER_KEY']);
    assert.ok(report.capabilities.some((capability) => capability.key === 'demo.tenancy'));
  });
});

describe('the assurance pass yields between projects', () => {
  it('reports the same shape as the synchronous pass', async () => {
    const platform = new Platform();
    const synchronous = sweep(platform);
    const yielding = await sweepYielding(platform);
    assert.deepEqual(Object.keys(yielding).sort(), Object.keys(synchronous).sort());
    assert.equal(yielding.checked, 0);
  });
});
