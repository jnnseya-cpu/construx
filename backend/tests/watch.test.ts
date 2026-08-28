import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { counters } from '../src/api/telemetry.ts';
import { outboxPosition } from '../src/notifications/outbox.ts';
import { evaluate, resetWatch, watchPosition, WATCH_RULES } from '../src/ops/watch.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The platform watching its own numbers.
 *
 * The counters have existed since the gateway was built and nothing read them.
 * `docs/STATE.md` said so — "counters are exposed; nothing collects them" — and
 * a counter nobody reads is one that will be wrong for a week before anybody
 * notices.
 *
 * The three properties worth testing are the ones that decide whether an alert
 * is trusted or muted:
 *
 * - It measures a **rate over an interval**, not a total since boot. A total is
 *   useless after a day and would fire on a number that can only go up.
 * - It **declines to judge** below a minimum sample. "100% of requests failed"
 *   over one request is the alert that gets a system muted.
 * - It tells somebody when a condition **recovers**, which homegrown alerting
 *   always forgets.
 */

let platform: Platform;
let seed: SeedResult;

const original = { ...config.ops };

function tune(over: Partial<typeof config.ops>): void {
  Object.assign(config.ops as object, original, over);
}

/** Drive the request counter directly, as the gateway does. */
function requests(count: number, status = '200'): void {
  for (let index = 0; index < count; index += 1) {
    counters.increment('requests_total', { route: 'GET /v1/x', status });
  }
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  assert.ok(seed.projectId);
});

beforeEach(() => {
  counters.reset();
  resetWatch();
  tune({ minimumSample: 20, serverErrorPercent: 5, authFailurePercent: 20, rateLimitedThreshold: 50, renotifyMinutes: 30 });
});

describe('every rule says what it measures and why it is worth waking somebody', () => {
  it('carries a sentence for both, on every rule', () => {
    for (const rule of WATCH_RULES) {
      // A rule that cannot say why it matters produces an alert nobody can act
      // on, which is the alert that gets the whole system muted.
      assert.ok(rule.what.length > 20, `${rule.id} does not say what it measures`);
      assert.ok(rule.because.length > 40, `${rule.id} does not say why it matters`);
      assert.ok(rule.severity === 'WARNING' || rule.severity === 'CRITICAL');
    }
  });
});

describe('it measures a rate over an interval, not a total since boot', () => {
  it('judges no rate on the first evaluation after a restart', async () => {
    requests(500, '500');
    const first = await evaluate(platform, new Date('2026-08-28T09:00:00Z'));

    // Five hundred failures and nothing fires, because there is nothing to
    // difference against yet. The alternative treats everything since boot as
    // one window and fires a false alarm on every deploy.
    assert.equal(first.started.includes('server_errors'), false);
    assert.equal(
      first.notJudged.some((entry) => entry.ruleId === 'server_errors'),
      true,
    );
  });

  it('fires on what happened in the interval, not on the accumulated total', async () => {
    requests(500, '500');
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));

    // A clean minute after a bad one. The totals still say 500 failures; the
    // interval says none, and the interval is what an on-call engineer asks
    // about.
    requests(100, '200');
    const second = await evaluate(platform, new Date('2026-08-28T09:01:00Z'));
    assert.equal(second.started.includes('server_errors'), false);
    assert.equal(second.window.requests, 100);
    assert.equal(second.window.serverErrors, 0);
  });

  it('derives the 5xx count from the status label rather than a second counter', async () => {
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    requests(90, '200');
    requests(10, '503');
    const report = await evaluate(platform, new Date('2026-08-28T09:01:00Z'));
    // Two counters for one quantity is two numbers that eventually disagree.
    assert.equal(report.window.requests, 100);
    assert.equal(report.window.serverErrors, 10);
    assert.equal(report.started.includes('server_errors'), true);
  });

  it('does not count a refusal as a failure', async () => {
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    // Denials, validation failures and rate limits are the platform working.
    requests(60, '403');
    requests(40, '422');
    const report = await evaluate(platform, new Date('2026-08-28T09:01:00Z'));
    assert.equal(report.window.serverErrors, 0);
    assert.equal(report.started.includes('server_errors'), false);
  });
});

describe('it declines to judge rather than judging a sample of one', () => {
  it('says why it had nothing to judge', async () => {
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    requests(1, '500');
    const report = await evaluate(platform, new Date('2026-08-28T09:01:00Z'));

    // 100% of requests failed. One request. Firing here is how an alert gets
    // muted within a day, and a muted alert is worse than none.
    assert.equal(report.started.includes('server_errors'), false);
    const declined = report.notJudged.find((entry) => entry.ruleId === 'server_errors');
    assert.match(declined?.because ?? '', /only 1 requests/);
  });

  it('judges once there is enough to judge', async () => {
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    requests(19, '500');
    let report = await evaluate(platform, new Date('2026-08-28T09:01:00Z'));
    assert.equal(report.started.includes('server_errors'), false);

    requests(30, '500');
    report = await evaluate(platform, new Date('2026-08-28T09:02:00Z'));
    assert.equal(report.started.includes('server_errors'), true);
  });
});

describe('transitions, not repetitions', () => {
  it('fires once on the way in, and not again on the next interval', async () => {
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    requests(100, '500');
    const first = await evaluate(platform, new Date('2026-08-28T09:01:00Z'));
    assert.deepEqual(first.started, ['server_errors']);

    requests(100, '500');
    const second = await evaluate(platform, new Date('2026-08-28T09:02:00Z'));
    // Still broken, and the operator has already been told. A two-hour incident
    // must not arrive as 120 emails.
    assert.deepEqual(second.started, []);
    assert.equal(second.stillFiring.includes('server_errors'), true);
    assert.equal(second.notified, 0);
  });

  it('tells somebody again once the re-notify interval has passed', async () => {
    tune({ renotifyMinutes: 30 });
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    requests(100, '500');
    await evaluate(platform, new Date('2026-08-28T09:01:00Z'));

    requests(100, '500');
    const later = await evaluate(platform, new Date('2026-08-28T09:35:00Z'));
    assert.equal(later.stillFiring.includes('server_errors'), true);
    assert.ok(later.notified >= 1);
  });

  it('says when it recovers, which is the half homegrown alerting forgets', async () => {
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    requests(100, '500');
    await evaluate(platform, new Date('2026-08-28T09:01:00Z'));

    requests(100, '200');
    const recovered = await evaluate(platform, new Date('2026-08-28T09:02:00Z'));
    assert.deepEqual(recovered.resolved, ['server_errors']);
    // Somebody woken at three needs to be told it stopped.
    assert.ok(recovered.notified >= 1);
    assert.equal(
      watchPosition(platform).firing.some((state) => state.ruleId === 'server_errors'),
      false,
    );
  });

  it('counts how often a rule has fired, so a flapping one is visible', async () => {
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    for (let cycle = 0; cycle < 3; cycle += 1) {
      requests(100, '500');
      await evaluate(platform, new Date(`2026-08-28T09:${String(cycle * 2 + 1).padStart(2, '0')}:00Z`));
      requests(100, '200');
      await evaluate(platform, new Date(`2026-08-28T09:${String(cycle * 2 + 2).padStart(2, '0')}:00Z`));
    }
    const state = watchPosition(platform).clear.find((entry) => entry.ruleId === 'server_errors')!;
    assert.equal(state.firedCount, 3);
  });
});

describe('the alert reaches somebody, through the outbox', () => {
  it('queues rather than sending, so an alert survives the process dying', async () => {
    const before_ = outboxPosition(platform).queued;
    await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    requests(100, '500');
    await evaluate(platform, new Date('2026-08-28T09:01:00Z'));

    // Written down before anything is transmitted — which is exactly the
    // circumstance an alert is most likely to be written in.
    assert.ok(outboxPosition(platform).queued > before_);
  });

  it('says plainly when there is nobody to tell', () => {
    const empty = new Platform();
    const position = watchPosition(empty);
    // A deployment with no operator is watching itself in silence, and the
    // screen has to say so rather than showing a healthy green.
    assert.equal(position.operators, 0);
  });
});

describe('a rule that throws is itself a finding', () => {
  it('never reports all clear for a check that did not run', async () => {
    const broken = {
      id: 'deliberately_broken',
      what: 'A rule written to throw, to prove the handler',
      because: 'A check that fails silently leaves the platform reporting all clear for something nobody ran.',
      severity: 'WARNING' as const,
      observe: () => {
        throw new Error('the check itself is broken');
      },
    };
    WATCH_RULES.push(broken);
    try {
      const report = await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
      assert.equal(report.started.includes('deliberately_broken'), true);
      const state = watchPosition(platform).firing.find((entry) => entry.ruleId === 'deliberately_broken')!;
      assert.match(state.lastDetail, /The check itself failed/);
    } finally {
      WATCH_RULES.splice(WATCH_RULES.indexOf(broken), 1);
    }
  });
});

describe('the configuration rule reuses the boot check rather than restating it', () => {
  it('reads clean on a development deployment, where nothing is claimed', async () => {
    const report = await evaluate(platform, new Date('2026-08-28T09:00:00Z'));
    // `assertProductionSafety` only warns in production, so a development run
    // is genuinely clear rather than being silenced here. One source of truth
    // for what "unsafe" means, read by the boot banner and by this.
    assert.equal(report.started.includes('configuration'), false);
  });
});
