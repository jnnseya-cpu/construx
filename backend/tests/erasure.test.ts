import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import type { AuthContext } from '../src/identity/auth.ts';
import { dueAt, graceDays, isDue, pseudonym, retentionBasis } from '../src/identity/erasure.ts';
import { replayProject } from '../src/goldenthread/replay.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * The right to erasure, against a ledger that cannot be erased.
 *
 * The two obligations only look contradictory. Art. 17(3)(b) and (e) withdraw
 * the right where retention is required by law or to defend legal claims, and a
 * construction record is inside both. So the ledger is untouched and the
 * identity is pseudonymised instead — which is only an honest answer if the
 * chain still verifies afterwards and the name is genuinely gone from the
 * places a person would look. Both are asserted below.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const actorFor = (who: 'pm' | 'admin') => seed.users[who]!.auth;

describe('the grace period', () => {
  it('is configured, not hard-coded, and defaults to thirty days', () => {
    assert.equal(graceDays(), config.privacy.erasureGraceDays);
    assert.equal(config.privacy.erasureGraceDays, 30);
  });

  it('puts the due date a grace period after the request', () => {
    const requested = '2026-08-21T09:00:00.000Z';
    assert.equal(dueAt(requested), '2026-09-20T09:00:00.000Z');
  });

  it('is not due before its date, and is due on it', () => {
    const state = { requestedAt: '2026-08-21T09:00:00.000Z', dueAt: '2026-09-20T09:00:00.000Z' };
    assert.equal(isDue(state, new Date('2026-09-19T23:59:00.000Z')), false);
    assert.equal(isDue(state, new Date('2026-09-20T09:00:00.000Z')), true);
  });

  it('never reports an already-erased identity as due again', () => {
    const state = { dueAt: '2020-01-01T00:00:00.000Z', erasedAt: '2020-01-02T00:00:00.000Z' };
    assert.equal(isDue(state, new Date('2026-09-20T09:00:00.000Z')), false);
  });
});

describe('the pseudonym', () => {
  it('carries nothing of the name or address it replaces', () => {
    const replacement = pseudonym('01J8ZQK7WQ9ABCDEF');
    assert.doesNotMatch(replacement.email, /meridian/i);
    // Not a hash of the address either: somebody who suspects an address could
    // confirm the guess by hashing it.
    assert.match(replacement.email, /@erased\.invalid$/);
  });

  it('is stable, so one erased identity does not read as several', () => {
    assert.deepEqual(pseudonym('01J8ZQK7WQ9ABCDEF'), pseudonym('01J8ZQK7WQ9ABCDEF'));
  });

  it('distinguishes two erased identities from each other', () => {
    assert.notDeepEqual(pseudonym('01J8ZQK7WQ9AAAAAA'), pseudonym('01J8ZQK7WQ9BBBBBB'));
  });

  it('uses a domain that can never be delivered to', () => {
    // RFC 2606 reserves .invalid precisely so this cannot become real by
    // accident or be mistaken for a live address by an operator.
    assert.match(pseudonym('x'.repeat(26)).email, /\.invalid$/);
  });
});

describe('what the record says was kept', () => {
  it('names the lawful basis rather than leaving it implied', () => {
    const basis = retentionBasis();
    assert.match(basis.lawfulBasis, /Art\. 17\(3\)/);
    assert.match(basis.lawfulBasis, /CDM 2015|Building Safety Act/);
    assert.deepEqual(basis.removed, ['name', 'email', 'mobile']);
    assert.ok(basis.retained.length > 0);
  });
});

describe('requesting erasure', () => {
  it('suspends the account immediately but erases nothing yet', () => {
    const local = new Platform();
    const actor = seedUserOn(local);

    const requested = local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });

    const user = local.user(actor.userId);
    assert.equal(user.status, 'SUSPENDED', 'the account should stop working straight away');
    assert.equal(user.erasedAt, undefined, 'nothing should be erased during the grace period');
    assert.equal(user.name, actor.name, 'the name is still there until the erasure runs');
    assert.equal(requested.dueAt, dueAt(String(user.erasureRequestedAt)));
  });

  it('refuses a second request while one is outstanding', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving' });

    throwsCode(
      () => local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving again' }),
      'ERASURE_ALREADY_REQUESTED',
    );
  });

  it('will not reach into another tenancy', () => {
    const local = new Platform();
    const a = seedUserOn(local);
    const b = seedUserOn(local);

    // Reported as absent rather than forbidden: confirming that a user id
    // exists in some other tenancy is itself a disclosure.
    throwsCode(() => local.requestErasure(a.auth, { userId: b.userId, reason: 'Not mine to ask' }), 'NOT_FOUND');
  });
});

describe('cancelling', () => {
  it('restores the identity and puts the account back', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Changed my mind shortly' });

    local.cancelErasure(actor.auth, { userId: actor.userId, reason: 'Cancelled by the account holder' });

    const user = local.user(actor.userId);
    assert.equal(user.status, 'ACTIVE');
    assert.equal(user.erasureRequestedAt, undefined);
    assert.equal(user.name, actor.name);
  });

  it('refuses when nothing is outstanding', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    throwsCode(() => local.cancelErasure(actor.auth, { userId: actor.userId, reason: 'Nothing to cancel' }), 'NO_ERASURE_REQUEST');
  });
});

describe('carrying it out', () => {
  it('refuses before the grace period expires, and says until when', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });

    // The window is the only thing standing between a stolen session and an
    // irreversible act. Skipping it has to be a deliberate, recorded choice.
    throwsCode(() => local.eraseUser(actor.auth, { userId: actor.userId }), 'ERASURE_NOT_DUE');
  });

  it('erases once due, replacing the name and address', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });

    const afterGrace = new Date(Date.now() + (graceDays() + 1) * 86_400_000);
    local.eraseUser(actor.auth, { userId: actor.userId, now: afterGrace });

    const user = local.user(actor.userId);
    assert.notEqual(user.name, actor.name);
    assert.notEqual(user.email, actor.email);
    assert.match(user.email, /@erased\.invalid$/);
    assert.ok(user.erasedAt);
  });

  it('leaves the hash chain intact, which is the whole point', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });
    local.eraseUser(actor.auth, {
      userId: actor.userId,
      now: new Date(Date.now() + (graceDays() + 1) * 86_400_000),
    });

    // If erasure had deleted or rewritten events, this is what would fail —
    // and the record would stop being evidence for everybody, not just for the
    // person who asked to leave.
    const report = replayProject(
      local.ledger,
      actor.tenantId,
      `${actor.tenantId}-governance`,
      new Date(Date.now() + (graceDays() + 2) * 86_400_000).toISOString(),
    );
    assert.equal(report.verificationStatus, 'VERIFIED', 'erasure broke the chain');
    assert.deepEqual(report.failures, []);
  });

  it('does not write the erased name into the event that records the erasure', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });
    local.eraseUser(actor.auth, {
      userId: actor.userId,
      now: new Date(Date.now() + (graceDays() + 1) * 86_400_000),
    });

    const erased = local.ledger
      .listByTenant(actor.tenantId, 'User')
      .find((record) => record.refId === actor.userId);

    assert.ok(erased, 'no User record for the erased identity');
    // The obvious way to get this wrong is to snapshot the identity "before"
    // into the erasure event, which puts the data straight back into the ledger
    // it was just removed from.
    assert.notEqual(erased.state.name, actor.name);
    assert.notEqual(erased.state.email, actor.email);
    assert.equal(erased.state.graceServed, true);
    assert.ok(String(erased.state.lawfulBasis).includes('Art. 17(3)'));
  });

  it('will not erase twice', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });
    const now = new Date(Date.now() + (graceDays() + 1) * 86_400_000);
    local.eraseUser(actor.auth, { userId: actor.userId, now });

    throwsCode(() => local.eraseUser(actor.auth, { userId: actor.userId, now }), 'ALREADY_ERASED');
  });

  it('cannot be undone by cancelling afterwards', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });
    local.eraseUser(actor.auth, {
      userId: actor.userId,
      now: new Date(Date.now() + (graceDays() + 1) * 86_400_000),
    });

    throwsCode(() => local.cancelErasure(actor.auth, { userId: actor.userId, reason: 'Too late' }), 'ALREADY_ERASED');
  });
});

describe('the due list', () => {
  it('is empty until a grace period expires, then names the identity', () => {
    const local = new Platform();
    const actor = seedUserOn(local);
    local.requestErasure(actor.auth, { userId: actor.userId, reason: 'Leaving the company' });

    assert.deepEqual(local.dueErasures().map((u) => u.id), []);
    const afterGrace = new Date(Date.now() + (graceDays() + 1) * 86_400_000);
    assert.deepEqual(local.dueErasures(afterGrace).map((u) => u.id), [actor.userId]);
  });
});

describe('the signed-in identity, through the platform', () => {
  it('reports no outstanding request for somebody who has not asked', () => {
    const pm = platform.user(actorFor('pm').actorId);
    assert.equal(pm.erasureRequestedAt, undefined);
    assert.equal(pm.erasedAt, undefined);
  });
});

/**
 * A tenancy with one administrator, for tests that need to erase somebody
 * without disturbing the seeded project every other test reads.
 */
function seedUserOn(local: Platform): {
  userId: string;
  tenantId: string;
  name: string;
  email: string;
  auth: AuthContext;
} {
  const { tenant } = local.createTenant({
    legalName: 'Ashcombe Civil Engineering Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
    enterpriseName: 'Ashcombe',
  });

  const name = 'Rowan Ellis';
  const email = `rowan.ellis.${tenant.id.slice(-6)}@ashcombe.example`;
  const created = local.createUser({ name, email, roles: ['ENTERPRISE_ADMIN'], tenantId: tenant.id });

  return {
    userId: created.id,
    tenantId: tenant.id,
    name,
    email,
    auth: {
      actorId: created.id,
      tenantId: tenant.id,
      roles: ['ENTERPRISE_ADMIN'],
      scopes: ['*'],
      tokenId: `tok-${created.id}`,
      mfaSatisfied: true,
      regulatorAiEnabled: false,
      expiresAt: Date.now() + 900_000,
    },
  };
}
