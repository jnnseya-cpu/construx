import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { graphComplete, plan, runnable, schedule, waiting, type TaskNode } from '../src/domain/consultancy/orchestrator.ts';

/**
 * The orchestration runtime's deterministic scheduler: which tasks are runnable,
 * which wait, the concurrent waves the dependency graph resolves into, cycle
 * detection, and graph completeness. A scheduler that can deadlock or loop is
 * worse than none, so the cycle case is tested explicitly.
 */

const node = (key: string, dependsOn: string[], runState: TaskNode['runState'] = 'QUEUED', validated = false, requiredDigital = true): TaskNode =>
  ({ key, dependsOn, runState, validated, requiredDigital });

describe('runnable and waiting', () => {
  it('a task with all dependencies done is runnable; one with an unfinished dependency waits', () => {
    const tasks = [
      node('evidence', [], 'COMPLETE', true),
      node('options', ['evidence']), // deps done → runnable
      node('appraisal', ['options']), // options not done → waiting
    ];
    assert.deepEqual(runnable(tasks), ['options']);
    const w = waiting(tasks);
    assert.ok(w.some((x) => x.key === 'appraisal' && x.waitingOn.includes('options')));
  });

  it('a dependency that is complete but not validated does not unblock a downstream task', () => {
    const tasks = [node('a', [], 'COMPLETE', false), node('b', ['a'])];
    assert.deepEqual(runnable(tasks), [], 'b stays blocked until a is validated');
  });

  it('treats a dependency on a task not in the set as unmet', () => {
    const tasks = [node('b', ['missing'])];
    assert.deepEqual(runnable(tasks), []);
  });
});

describe('scheduling into concurrent waves', () => {
  it('lays a chain A→B→C into three ordered waves', () => {
    const s = schedule([node('c', ['b']), node('b', ['a']), node('a', [])]);
    assert.deepEqual(s.waves, [['a'], ['b'], ['c']]);
    assert.equal(s.cycle, undefined);
  });

  it('puts independent tasks in the same wave so they run concurrently', () => {
    const s = schedule([node('a', []), node('b', []), node('c', ['a', 'b'])]);
    assert.deepEqual(s.waves[0], ['a', 'b']);
    assert.deepEqual(s.waves[1], ['c']);
  });

  it('detects a dependency cycle instead of looping', () => {
    const s = schedule([node('a', ['b']), node('b', ['a'])]);
    assert.deepEqual(s.cycle, ['a', 'b']);
  });
});

describe('completeness and the whole plan', () => {
  it('is complete only when every required digital task is done', () => {
    assert.equal(graphComplete([node('a', [], 'COMPLETE', true), node('b', [], 'COMPLETE', true)]), true);
    assert.equal(graphComplete([node('a', [], 'COMPLETE', true), node('b', [], 'QUEUED')]), false);
    assert.equal(graphComplete([node('a', [], 'COMPLETE', true, false)]), false, 'a graph of only non-required tasks is not "complete"');
  });

  it('plan() reports runnable, waiting, waves and completeness together', () => {
    const p = plan([node('a', [], 'COMPLETE', true), node('b', ['a']), node('c', ['b'])]);
    assert.deepEqual(p.runnable, ['b']);
    assert.equal(p.complete, false);
    assert.ok(p.waves.length >= 1);
  });
});
