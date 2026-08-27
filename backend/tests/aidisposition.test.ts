import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as aidisposition from '../src/domain/aidisposition.ts';
import * as safety from '../src/engines/safety.ts';
import * as stagegate from '../src/domain/stagegate.ts';
import { promptVersionOf } from '../src/engines/context.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The three things every stage gate's fifth clause asked for and the platform
 * did not record.
 *
 * Two are properties of the call and are written onto the event by `runAI`:
 * **assumptions** — `[]` where the model declared none, which is an answer
 * rather than a gap — and **prompt version**, derived from the task and
 * response schema actually sent.
 *
 * The third could never be a field. A **human disposition** is a later act by a
 * different party, and on an append-only ledger a field cannot be filled in
 * afterwards, so it is its own event merged onto the execution record.
 *
 * Until these existed, clause 5 read `NOT_ASSESSABLE` at all six gates, and it
 * said so on the screen rather than only in a document. This file is what
 * stops it silently regressing to that.
 */

let platform: Platform;
let seed: SeedResult;

const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });
const asAgent = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'AI' });

beforeEach(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

/** A genuine AI run, so the assertions are about real events. */
async function runOne(): Promise<string> {
  await safety.forecastSafetyRisk(asSafety(), {
    headcount: 40,
    highRiskActivitiesPlanned: 3,
    adverseWeatherDays: 2,
  });
  const outstanding = aidisposition.aiDispositionPosition(asPM()).outstanding;
  assert.equal(outstanding.length, 1, 'the run produced no undisposed execution');
  return outstanding[0]!.executionId;
}

describe('what the AI event now records', () => {
  it('writes assumptions on every AI event, and an empty array is an answer', () => {
    const events = platform.ledger
      .events({ tenantId: seed.tenantId, projectId: seed.projectId })
      .filter((event) => event.ai && lookupEventType(event.eventType)?.group !== 'AI_BILLING');

    assert.ok(events.length > 0, 'the seed produced no AI events to check');
    for (const event of events) {
      assert.ok(
        Array.isArray(event.ai!.assumptions),
        `${event.eventType} records no assumptions, not even that there were none`,
      );
    }
  });

  it('has the local stand-in declare the assumptions that are actually true of it', () => {
    const event = platform.ledger
      .events({ tenantId: seed.tenantId, projectId: seed.projectId })
      .find((e) => e.ai && (e.ai.assumptions ?? []).length > 0);
    assert.ok(event);
    assert.ok(
      event.ai!.assumptions!.some((a) => /No external model was called/.test(a)),
      event.ai!.assumptions!.join(' | '),
    );
  });

  it('names which prompt produced every AI event', () => {
    for (const event of platform.ledger
      .events({ tenantId: seed.tenantId, projectId: seed.projectId })
      .filter((e) => e.ai && lookupEventType(e.eventType)?.group !== 'AI_BILLING')) {
      assert.match(String(event.ai!.promptVersion), /^[a-z_]+@[0-9a-f]{8}$/, event.eventType);
    }
  });

  it('derives the prompt version from the shape of the question, not from the data', () => {
    const base = { taskType: 'wbs_generation', request: { task: 'break this down', payload: {} } };
    // Same question, different project data — the same version.
    assert.equal(
      promptVersionOf(base),
      promptVersionOf({ ...base, request: { ...base.request, payload: { anything: 'else' } } }),
      'the payload leaked into the prompt version, making it a fingerprint rather than a version',
    );
    // A different question, or a different response schema — a different version.
    assert.notEqual(promptVersionOf(base), promptVersionOf({ ...base, request: { ...base.request, task: 'other' } }));
    assert.notEqual(
      promptVersionOf(base),
      promptVersionOf({ ...base, request: { ...base.request, responseSchema: { type: 'object' } } }),
    );
  });

  it('carries a whole digest, not an algorithm prefix wearing a digest’s clothes', () => {
    // `hashEvidence` returns `sha256:<hex>`. Slicing the prefixed value gives
    // `sha256:9` — one hex character, sixteen possible versions across the
    // whole platform. Thirty-two distinct questions must therefore produce
    // thirty-two distinct versions.
    const versions = new Set(
      Array.from({ length: 32 }, (_unused, index) =>
        promptVersionOf({ taskType: 'wbs_generation', request: { task: `question ${index}`, payload: {} } }),
      ),
    );
    assert.equal(versions.size, 32, [...versions].join(' | '));
  });
});

describe('the human disposition', () => {
  it('is recorded against the execution, with who decided and when', async () => {
    const executionId = await runOne();
    assert.equal(aidisposition.dispositionOf(asPM(), executionId), undefined);

    aidisposition.disposeAIOutput(asPM(), { executionId, decision: 'ACCEPTED' });

    const disposition = aidisposition.dispositionOf(asPM(), executionId);
    assert.equal(disposition?.decision, 'ACCEPTED');
    assert.equal(disposition?.disposedBy, seed.users.pm!.id);
    assert.ok(Date.parse(String(disposition?.disposedAt)) > 0);
  });

  it('keeps the execution record whole rather than replacing it with the decision', async () => {
    const executionId = await runOne();
    const before = platform.ledger.require({ refType: 'AIExecution', refId: executionId }).state;
    aidisposition.disposeAIOutput(asPM(), { executionId, decision: 'ACCEPTED' });
    const after = platform.ledger.require({ refType: 'AIExecution', refId: executionId }).state;

    for (const key of Object.keys(before)) {
      assert.deepEqual(after[key], before[key], `approving the output dropped ${key} from the accounting record`);
    }
    assert.ok(after.disposition, 'the disposition did not land on the execution');
  });

  it('refuses a correction or a rejection with no reason', async () => {
    const executionId = await runOne();
    throwsCode(
      () => aidisposition.disposeAIOutput(asPM(), { executionId, decision: 'REJECTED' }),
      'REASON_REQUIRED',
    );
    throwsCode(
      () => aidisposition.disposeAIOutput(asPM(), { executionId, decision: 'ACCEPTED_WITH_CHANGE', reason: '  ' }),
      'REASON_REQUIRED',
    );
  });

  it('refuses a second disposition, because replacing one would erase an acceptance', async () => {
    const executionId = await runOne();
    aidisposition.disposeAIOutput(asPM(), { executionId, decision: 'ACCEPTED' });
    const error = throwsCode(
      () => aidisposition.disposeAIOutput(asPM(), { executionId, decision: 'REJECTED', reason: 'Changed my mind' }),
      'ALREADY_DISPOSED',
    );
    assert.match(String(error.message), /once accepted/);
  });

  it('lets no model dispose of its own output', async () => {
    const executionId = await runOne();
    throwsCode(
      () => aidisposition.disposeAIOutput(asAgent(), { executionId, decision: 'ACCEPTED' }),
      'AI_CANNOT_DISPOSE',
    );
    // And the catalogue says the same, so the rule holds at both layers.
    assert.equal(aidisposition.dispositionIsHumanOnly(), true);
    assert.equal(lookupEventType('AI_OUTPUT_DISPOSED')?.aiAllowed, false);
  });

  it('refuses an execution that is not on this project', () => {
    throwsCode(
      () => aidisposition.disposeAIOutput(asPM(), { executionId: 'not-an-execution', decision: 'ACCEPTED' }),
      'NO_SUCH_EXECUTION',
    );
  });

  it('counts what the project has actually stood behind', async () => {
    const executionId = await runOne();
    const before = aidisposition.aiDispositionPosition(asPM());
    assert.equal(before.outstanding.length, 1);
    assert.ok(before.disposed > 0, 'the seed disposed of nothing');

    aidisposition.disposeAIOutput(asPM(), {
      executionId,
      decision: 'ACCEPTED_WITH_CHANGE',
      reason: 'Figures adopted; the narrative was rewritten.',
    });

    const after = aidisposition.aiDispositionPosition(asPM());
    assert.equal(after.outstanding.length, 0);
    assert.equal(after.disposed, before.disposed + 1);
    assert.equal(after.acceptedWithChange, before.acceptedWithChange + 1);
  });
});

describe('what the gate now does with all three', () => {
  it('passes clause 5 at every gate on a project whose outputs have been decided about', () => {
    const ctx = asPM();
    for (const evaluate of [
      stagegate.evaluateConceptGate,
      stagegate.evaluateDesignGate,
      stagegate.evaluateTenderGate,
      stagegate.evaluateConstructionGate,
      stagegate.evaluateCommissioningGate,
      stagegate.evaluateHandoverGate,
    ]) {
      const ai = evaluate(ctx).clauses.find((c) => c.clause === 'AI_ACCOUNTED');
      assert.ok(ai);
      assert.equal(ai.state, 'PASS', ai.blocking.join('; '));
    }
  });

  it('fails clause 5 for an output nobody has decided about, and names it', async () => {
    const executionId = await runOne();

    const ai = stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'AI_ACCOUNTED');
    assert.equal(ai?.state, 'FAIL');
    assert.ok(
      ai!.blocking.some((b) => b.includes(executionId)),
      'the gate reported a count rather than naming the execution',
    );

    aidisposition.disposeAIOutput(asPM(), { executionId, decision: 'ACCEPTED' });
    assert.equal(
      stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'AI_ACCOUNTED')?.state,
      'PASS',
    );
  });
});
