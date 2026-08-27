import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { ClientBranding } from '../src/export/exporter.ts';
import { config } from '../src/config.ts';
import { notify } from '../src/notifications/notify.ts';
import * as outbox from '../src/notifications/outbox.ts';
import { NOTIFICATIONS_PROJECT_ID } from '../src/notifications/preferences.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The outbox.
 *
 * A notification used to be transmitted first and recorded afterwards, which
 * has one failure and it is the worst one: a process that dies between deciding
 * to tell somebody and telling them leaves nothing at all. No notice, no
 * record, and nobody who could know a notice was owed — the payment-failure
 * email that never went is indistinguishable from the payment that never
 * failed.
 *
 * The property under test is therefore not "notifications are sent". It is
 * **what remains when a send does not happen**, which is the case the whole
 * mechanism exists for and the one that never happens in a passing test unless
 * a test arranges it. So the crash is simulated: an entry is queued and the
 * delivery never runs, exactly as it would not have if the process had died,
 * and the next drain picks it up.
 */

const BRANDING: ClientBranding = {
  clientName: 'Meridian Infrastructure Group Ltd',
  primaryColour: '#e2571e',
  legalFooter: 'Meridian Infrastructure Group Ltd · registered in GB',
  documentReferencePrefix: 'MIGL',
};

let platform: Platform;
let seed: SeedResult;

beforeEach(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

function recipient() {
  const pm = platform.user(seed.users.pm!.id);
  return { id: pm.id, name: pm.name, email: pm.email, tenantId: pm.tenantId };
}

function queueOne(code = 'account.verification.successful') {
  return outbox.queue(platform, {
    code,
    recipients: [recipient()],
    payload: { enterprise: 'Meridian', detail: 'Queued but never delivered' },
    branding: BRANDING,
    actorId: 'test',
    correlationId: 'corr-outbox',
  });
}

/** Every outbox entry as the ledger holds it, newest state per id. */
function entries(): Array<Record<string, unknown>> {
  return platform.ledger.list(NOTIFICATIONS_PROJECT_ID, 'NotificationOutbox').map((record) => record.state);
}

describe('the intent is written down before anything is transmitted', () => {
  it('queues, then delivers, and settles the entry it queued', async () => {
    const dispatch = await notify(platform, {
      code: 'account.verification.successful',
      recipients: [recipient()],
      payload: { enterprise: 'Meridian', detail: 'Signed up' },
      branding: BRANDING,
      actorId: 'test',
      correlationId: 'corr-1',
    });

    const settled = entries().filter((entry) => entry.dispatchId === dispatch.id);
    assert.equal(settled.length, 1, 'the dispatch did not come from an outbox entry');
    assert.equal(settled[0]!.status, 'SENT');
    assert.equal(settled[0]!.attempts, 1);
    // Settled, so nothing will try it again.
    assert.equal(outbox.due(platform).length, 0);
  });

  it('carries everything a later process would need to deliver it', () => {
    const entry = queueOne();
    const stored = entries().find((item) => item.outboxId === entry.outboxId)!;

    // The point of the queue is that the process that delivers it may not be
    // the one that decided to. Nothing may be left behind in a closure.
    for (const key of ['code', 'recipients', 'payload', 'branding', 'actorId', 'correlationId']) {
      assert.ok(stored[key] !== undefined, `${key} is not on the queued entry`);
    }
    assert.equal(stored.status, 'QUEUED');
    assert.equal(stored.attempts, 0);
  });

  it('refuses to queue a code that is not in the closed catalogue', () => {
    // Checked here rather than at delivery: an unknown code would park an entry
    // that fails identically on every retry until it is abandoned five attempts
    // later, which is a slow way of reporting a typo.
    assert.throws(() => queueOne('account.nonsense.invented'), /catalogue is closed/);
  });
});

describe('what survives a process that died mid-send', () => {
  it('delivers on the next drain what a dead process queued and never sent', async () => {
    // The crash: queued, and the delivery never ran.
    const entry = queueOne();
    assert.equal(outbox.due(platform).length, 1, 'the queued notice is not owed');

    const report = await outbox.drain(platform);
    assert.equal(report.attempted, 1);
    assert.equal(report.sent, 1, JSON.stringify(report));

    const settled = entries().find((item) => item.outboxId === entry.outboxId)!;
    assert.equal(settled.status, 'SENT');
    assert.equal(outbox.due(platform).length, 0);
  });

  it('does not deliver the same notice twice', async () => {
    queueOne();
    await outbox.drain(platform);
    const second = await outbox.drain(platform);
    // At-least-once, and once is enough: a settled entry is never due again.
    assert.equal(second.attempted, 0);
  });

  it('reports what is owed and how old the oldest is', () => {
    queueOne();
    queueOne();
    const position = outbox.outboxPosition(platform);
    assert.equal(position.queued, 2);
    assert.equal(position.due, 2);
    assert.ok(position.oldestQueuedAt, 'nothing said how long a notice has been owed');
  });
});

describe('retry, and knowing when to stop', () => {
  /** An entry whose delivery always fails: no address to send to. */
  function undeliverable() {
    return outbox.queue(platform, {
      code: 'account.verification.successful',
      recipients: [{ id: seed.users.pm!.id, name: 'No Address', email: '', tenantId: seed.tenantId }],
      channels: ['EMAIL'],
      payload: { enterprise: 'Meridian' },
      branding: BRANDING,
      actorId: 'test',
      correlationId: 'corr-fail',
    });
  }

  it('keeps a failed notice owed, and backs off before trying again', async () => {
    const entry = undeliverable();
    const report = await outbox.drain(platform);
    assert.equal(report.retrying, 1, JSON.stringify(report));

    const settled = entries().find((item) => item.outboxId === entry.outboxId)!;
    assert.equal(settled.status, 'QUEUED');
    assert.equal(settled.attempts, 1);
    assert.ok(settled.lastError, 'nothing recorded why it failed');
    // Not due again immediately: a relay that refused because it was overloaded
    // is not helped by being asked again in the same millisecond.
    assert.ok(String(settled.nextAttemptAt) > new Date().toISOString());
    assert.equal(outbox.due(platform).length, 0);
  });

  it('gives up after the configured attempts rather than retrying for ever', async () => {
    const entry = undeliverable();

    // The clock is wound forward rather than waited out — a test that actually
    // sat through four minutes of backoff is a test nobody runs. Everything
    // else is the real drain, so this exercises the policy rather than a second
    // copy of it.
    const later = '2999-01-01T00:00:00.000Z';
    for (let attempt = 0; attempt < config.notifications.maxAttempts; attempt += 1) {
      await outbox.drain(platform, { at: later });
    }

    const final = entries().find((item) => item.outboxId === entry.outboxId)!;
    assert.equal(final.status, 'ABANDONED', `attempts: ${String(final.attempts)}`);
    assert.equal(final.attempts, config.notifications.maxAttempts);
    // An abandoned entry is settled, not owed. Nobody will try it again without
    // being asked, which is the honest end state for a bad address.
    assert.equal(outbox.due(platform, later).length, 0);

    const position = outbox.outboxPosition(platform);
    assert.equal(position.abandoned, 1);
    assert.equal(position.abandonedEntries[0]?.outboxId, entry.outboxId);
    assert.ok(position.abandonedEntries[0]?.lastError, 'the operator is told it failed but not why');
  });
});

describe('the ordering that makes it an outbox', () => {
  it('records the queue before the dispatch, in the ledger’s own order', async () => {
    const before = platform.ledger.events({ tenantId: seed.tenantId, projectId: NOTIFICATIONS_PROJECT_ID }).length;

    await notify(platform, {
      code: 'account.verification.successful',
      recipients: [recipient()],
      payload: { enterprise: 'Meridian' },
      branding: BRANDING,
      actorId: 'test',
      correlationId: 'corr-order',
    });

    const written = platform.ledger
      .events({ tenantId: seed.tenantId, projectId: NOTIFICATIONS_PROJECT_ID })
      .slice(before)
      .map((event) => event.eventType);

    // The intent first. Everything else in this file depends on this ordering:
    // reverse it and a crash mid-send leaves nothing behind again.
    assert.equal(written[0], 'NOTIFICATION_QUEUED', written.join(' → '));
    assert.ok(written.includes('NOTIFICATION_DISPATCHED'), written.join(' → '));
    assert.equal(written.at(-1), 'NOTIFICATION_QUEUE_SETTLED', written.join(' → '));
  });

  it('is durable because it is a ledger write, not a second store to keep in step', () => {
    const entry = queueOne();
    // Replayed from the event log like everything else — there is no separate
    // queue file that could disagree with the record.
    const replayed = platform.ledger.require({ refType: 'NotificationOutbox', refId: entry.outboxId });
    assert.equal(replayed.state.status, 'QUEUED');
    assert.equal(replayed.state.code, 'account.verification.successful');
  });
});
