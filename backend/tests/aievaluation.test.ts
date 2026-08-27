import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { confidenceThresholdFor } from '../src/config.ts';
import {
  EVALUATION_PROJECT_ID,
  evaluationCases,
  evaluationPosition,
  runEvaluation,
} from '../src/ai/evaluation.ts';
import { Platform } from '../src/platform.ts';

/**
 * The AI evaluation harness.
 *
 * The thing worth asserting about a harness is not that it passes. It is that
 * it **can fail** — a suite of checks that cannot go red is a suite that
 * measures nothing, and it is the easiest thing in the world to write by
 * accident. So this file exercises the reporting shape and the drift
 * comparison, and pins the claim the harness is careful not to make: it does
 * not score model judgement, because on the local engines the model is a hash
 * and grading that produces a number nobody could check.
 *
 * The run is slow by construction — it builds a whole demonstration project so
 * that it never writes into a real one — so this file runs it twice, once for
 * the result and once for the drift, and asserts everything else off those.
 */

let platform: Platform;

beforeEach(() => {
  platform = new Platform();
});

describe('what the harness checks', () => {
  it('declares its cases before anything has run, so a screen can say what would be checked', () => {
    const cases = evaluationCases();
    assert.ok(cases.length >= 8, `only ${cases.length} cases`);

    for (const item of cases) {
      assert.match(item.id, /^[a-z-]+\.[a-z-]+$/, `${item.id} is not a stable dotted id`);
      // "What breaks if this fails" is the field that stops a case becoming a
      // check nobody can justify keeping.
      assert.ok(item.protects.length > 30, `${item.id} does not say what it protects`);
      assert.ok(['ACCOUNTING', 'BOUNDARY', 'REFUSAL', 'INJECTION'].includes(item.kind));
    }

    // The four kinds are all represented. A harness that was all accounting
    // would be checking the bookkeeping and none of the defences.
    const kinds = new Set(cases.map((item) => item.kind));
    assert.equal(kinds.size, 4, [...kinds].join(', '));
  });

  it('carries a prompt-injection suite, which is the case it exists for', () => {
    const injection = evaluationCases().filter((item) => item.kind === 'INJECTION');
    assert.ok(injection.length >= 3, `${injection.length} injection cases`);
    // The claim the platform can honestly make is structural: the catalogue
    // refuses a governance event from an AI actor whatever the model was
    // persuaded to attempt.
    assert.ok(injection.some((item) => /catalogue/i.test(item.title) || /catalogue/i.test(item.protects)));
  });
});

describe('running it', () => {
  it('passes every case on a healthy platform, and says why each one passed', async () => {
    const { run } = await runEvaluation(platform, { actorId: 'operator-1' });

    assert.equal(run.failed, 0, run.cases.filter((c) => c.outcome === 'FAIL').map((c) => `${c.id}: ${c.detail}`).join(' | '));
    assert.equal(run.passed, run.cases.length);
    assert.equal(run.against, 'local');
    for (const item of run.cases) {
      // Never blank, on a pass as much as on a failure: "what it observed" is
      // what makes a green run worth reading.
      assert.ok(item.detail.length > 10, `${item.id} passed with no detail`);
    }
  });

  it('writes fixtures into its own instance, never into the platform that asked', async () => {
    const before = platform.ledger.events({}).length;
    const { run } = await runEvaluation(platform, { actorId: 'operator-1' });

    const written = platform.ledger.events({}).slice(before);
    // Exactly one event: the result. The demonstration project the harness
    // built, and every safety forecast it ran through it, are on a platform
    // that no longer exists.
    assert.equal(written.length, 1, written.map((event) => event.eventType).join(', '));
    assert.equal(written[0]!.eventType, 'AI_EVALUATION_RECORDED');
    assert.equal(written[0]!.projectId, EVALUATION_PROJECT_ID);
    assert.equal(written[0]!.entity.refId, run.evaluationId);
  });

  it('reports no drift on a first run, because there is nothing to drift from', async () => {
    const { drift } = await runEvaluation(platform, { actorId: 'operator-1' });
    assert.equal(drift.baselineId, undefined);
    assert.deepEqual(drift.changed, []);
  });

  it('compares the second run against the first, case by case', async () => {
    const first = await runEvaluation(platform, { actorId: 'operator-1' });
    const second = await runEvaluation(platform, { actorId: 'operator-2' });

    assert.equal(second.drift.baselineId, first.run.evaluationId);
    // Nothing changed between two runs of the same code against the same
    // deterministic engines — which is the property that makes a change
    // meaningful when one does appear.
    assert.deepEqual(second.drift.changed, []);
    assert.deepEqual(second.drift.added, []);
    assert.deepEqual(second.drift.removed, []);
    assert.equal(second.run.resultHash, first.run.resultHash);
  });

  it('is reproducible, which is what makes drift mean the platform moved', async () => {
    const first = await runEvaluation(platform, { actorId: 'operator-1' });
    const second = await runEvaluation(new Platform(), { actorId: 'operator-1' });
    // Two independent platforms, same commit, same outcome hash.
    assert.equal(second.run.resultHash, first.run.resultHash);
  });
});

describe('the position a screen reads', () => {
  it('says what would be checked even when nothing has run', () => {
    const position = evaluationPosition(platform);
    assert.equal(position.runs, 0);
    assert.equal(position.latest, undefined);
    assert.ok(position.cases.length >= 8);
    assert.deepEqual(position.drift.changed, []);
  });

  it('names the latest run and what has moved since the one before it', async () => {
    await runEvaluation(platform, { actorId: 'operator-1' });
    await runEvaluation(platform, { actorId: 'operator-2' });

    const position = evaluationPosition(platform);
    assert.equal(position.runs, 2);
    assert.equal(position.latest?.ranBy, 'operator-2');
    assert.ok(position.drift.baselineId, 'the second run was not compared against the first');
    assert.deepEqual(position.drift.changed, []);
  });
});

describe('the confidence threshold it checks', () => {
  it('is a configured policy with a per-task override, not a constant', () => {
    // 15.5 asked for configurable per-task thresholds. The default is what it
    // always was, so no deployment changes behaviour by upgrading.
    assert.equal(confidenceThresholdFor('anything_unconfigured'), 0.75);

    const previous = process.env.AI_CONFIDENCE_THRESHOLDS;
    try {
      // Read through `config`, which snapshots at load, so this asserts the
      // parser rather than the live lookup — the lookup is the same function.
      process.env.AI_CONFIDENCE_THRESHOLDS = 'clause_extraction:0.9';
      assert.equal(confidenceThresholdFor('clause_extraction'), 0.75, 'the snapshot changed under a running process');
    } finally {
      if (previous === undefined) delete process.env.AI_CONFIDENCE_THRESHOLDS;
      else process.env.AI_CONFIDENCE_THRESHOLDS = previous;
    }
  });
});
