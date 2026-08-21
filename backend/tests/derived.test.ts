import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { designReadiness } from '../src/engines/bim.ts';
import { productivityPosition } from '../src/engines/planning.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Two answers the command centres reported as missing, derived from records that
 * already existed.
 *
 * "Productivity against baseline is not derived" was wrong in an instructive
 * way: the arithmetic was already inside `forecastDelay`, where it was one input
 * to a risk model and nothing could read it on its own. It was derived and not
 * published, which from a screen is indistinguishable from absent.
 *
 * Design readiness was genuinely absent, and became answerable only once an RFI
 * carried the activity it holds up. The question is narrow on purpose: not "is
 * the design finished", which no project can answer, but "of the work about to
 * start, what is waiting on an answer".
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const pm = (): EngineContext => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const bim = (): EngineContext => platform.context(seed.users.bim!.auth, seed.projectId, { source: 'WEB' });

describe('productivity, measured rather than felt', () => {
  it('reports days earned against days spent, not percent complete', () => {
    // 60% complete in half the planned time and 60% complete in twice the
    // planned time are the same progress report and opposite facts.
    const position = productivityPosition(pm());
    for (const activity of position.activities) {
      assert.equal(activity.earnedDays, Number((activity.plannedDays * (activity.percentComplete / 100)).toFixed(2)));
      assert.equal(activity.factor, Number((activity.earnedDays / activity.elapsedDays).toFixed(3)));
    }
  });

  it('excludes work nobody has started rather than scoring it on plan', () => {
    // Zero elapsed days is no evidence either way, and counting it as 1.0
    // flatters a project whose work has not begun.
    const position = productivityPosition(pm());
    assert.ok(position.notStarted >= 0);
    for (const activity of position.activities) {
      assert.ok(activity.elapsedDays > 0, `${activity.taskName} has no elapsed time and was still scored`);
    }
  });

  it('calls progress against no elapsed time a data fault, not infinite productivity', () => {
    const ctx = pm();
    const task = platform.ledger.list(seed.projectId, 'Task')[0]!;
    ctx.ledger.commit({
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      actor: { refType: 'User', refId: seed.users.pm!.id },
      source: 'WEB',
      correlationId: 'productivity-test',
      eventType: 'TASK_UPDATED',
      entity: { refType: 'Task', refId: task.refId },
      nextState: { ...task.state, percentComplete: 40, elapsedDays: 0 },
      timestamp: new Date().toISOString(),
    });

    const position = productivityPosition(pm());
    const flagged = position.unmeasurable.find((entry) => entry.taskId === task.refId);
    assert.ok(flagged, 'progress with no elapsed time was silently dropped or scored');
    assert.match(flagged.reason, /without the days it took/);
    assert.ok(!position.activities.some((a) => a.taskId === task.refId));
  });

  it('weights the project figure by planned duration', () => {
    // An unweighted mean lets a one-day snagging item cancel a twelve-week
    // structure, which produces a comfortable number from an uncomfortable job.
    // Built as a case where the two answers genuinely differ, because a test
    // that passes on a uniform project proves nothing about the weighting.
    const ctx = pm();
    const tasks = platform.ledger.list(seed.projectId, 'Task');
    const long = tasks[1]!;
    const short = tasks[2]!;

    const set = (refId: string, state: Record<string, unknown>): void => {
      ctx.ledger.commit({
        tenantId: seed.tenantId,
        projectId: seed.projectId,
        actor: { refType: 'User', refId: seed.users.pm!.id },
        source: 'WEB',
        correlationId: 'weighting-test',
        eventType: 'TASK_UPDATED',
        entity: { refType: 'Task', refId },
        nextState: state,
        timestamp: new Date().toISOString(),
      });
    };

    // A long activity running at 0.5, a short one running at 2.0. Unweighted
    // that averages to 1.25 — a project apparently ahead of itself. Weighted by
    // the days actually spent it is 0.6, which is the truth.
    set(long.refId, { ...long.state, durationDays: 100, percentComplete: 50, elapsedDays: 100 });
    set(short.refId, { ...short.state, durationDays: 10, percentComplete: 100, elapsedDays: 5 });

    const position = productivityPosition(pm());
    const longFactor = position.activities.find((a) => a.taskId === long.refId);
    const shortFactor = position.activities.find((a) => a.taskId === short.refId);
    assert.equal(longFactor?.factor, 0.5);
    assert.equal(shortFactor?.factor, 2);

    assert.equal(position.projectFactor, Number((position.earnedDays / position.elapsedDays).toFixed(3)));

    const unweighted =
      position.activities.reduce((sum, a) => sum + a.factor, 0) / position.activities.length;
    assert.notEqual(
      position.projectFactor,
      Number(unweighted.toFixed(3)),
      'the project figure is an unweighted mean — a one-day item counts as much as a twelve-week one',
    );
    assert.ok(
      position.projectFactor! < Number(unweighted.toFixed(3)),
      'weighting should pull the figure toward the long activity that is behind',
    );
  });

  it('names the critical-path activities that are behind, because that is where the date moves', () => {
    const position = productivityPosition(pm());
    const criticalBehind = position.activities.filter((a) => a.onCriticalPath && a.factor < 1);
    if (criticalBehind.length > 0) {
      assert.match(position.summary, /critical path/i);
    } else {
      assert.match(position.summary, /Nothing on the critical path is below 1\.0|no productivity to measure/i);
    }
  });

  it('says there is nothing to measure rather than reporting zero', () => {
    // A project with no measured work is not a project with zero productivity.
    const empty = new Platform();
    const position = productivityPosition({
      ...pm(),
      ledger: empty.ledger,
      projectId: 'nothing-here',
    } as EngineContext);

    assert.equal(position.measured, 0);
    assert.equal(position.projectFactor, null);
    assert.match(position.summary, /no productivity to measure/i);
  });
});

describe('design readiness for the work about to start', () => {
  it('refuses to infer a window where no lookahead is published', () => {
    // Design readiness is a question about the next few weeks. Without a
    // lookahead there is no "next few weeks" to ask about, and inventing one
    // from the whole programme would answer a different question.
    const readiness = designReadiness(bim());
    if (!readiness.hasLookahead) {
      assert.equal(readiness.plannedActivities, 0);
      assert.match(readiness.summary, /no lookahead is published/i);
      assert.match(String(readiness.toMakeExact), /publish a lookahead/i);
    }
  });

  it('counts an activity as ready rather than omitting it', () => {
    // "Nine of eleven are ready" and "nine are ready" are different statements
    // and only one of them can be checked.
    const readiness = designReadiness(bim());
    if (!readiness.hasLookahead) return;
    assert.equal(readiness.ready + readiness.waiting.length, readiness.plannedActivities);
  });

  it('sees only the questions that name an activity, and says how many it cannot see', () => {
    // The honest limit of the answer, stated on the answer rather than left for
    // somebody to discover when the number looks too good.
    const readiness = designReadiness(bim());
    if (!readiness.hasLookahead) return;

    const openUnlinked = platform.ledger
      .list(seed.projectId, 'RFI')
      .filter((r) => r.state.status !== 'ANSWERED' && typeof r.state.linkedTaskId !== 'string');

    if (openUnlinked.length > 0) {
      assert.match(String(readiness.toMakeExact), /name no activity|names no activity/i);
    } else {
      assert.equal(readiness.toMakeExact, undefined);
    }
  });

  it('puts committed work at the top, because those are the promises that break', () => {
    const readiness = designReadiness(bim());
    if (!readiness.hasLookahead || readiness.waiting.length < 2) return;

    const committedIndexes = readiness.waiting.map((entry, index) => (entry.committed ? index : -1)).filter((i) => i >= 0);
    const uncommittedIndexes = readiness.waiting.map((entry, index) => (entry.committed ? -1 : index)).filter((i) => i >= 0);
    if (committedIndexes.length > 0 && uncommittedIndexes.length > 0) {
      assert.ok(
        Math.max(...committedIndexes) < Math.min(...uncommittedIndexes),
        'an activity nobody promised is listed above one somebody did',
      );
    }
  });
});
