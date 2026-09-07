import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as aidisposition from '../src/domain/aidisposition.ts';
import * as claims from '../src/engines/claims.ts';
import { hashEvidence } from '../src/core/canonical.ts';
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

/**
 * The field-level record of an edit — §16.3.
 *
 * `ACCEPTED_WITH_CHANGE` with a prose reason says the model needed correcting
 * and cannot say where. "Corrected the commercial figure" is a sentence
 * somebody has to read and nobody can count; `/commercialImpact/amountMinor
 * 4200000 → 0` is a fact, and forty of them are a measurement of exactly where
 * this model is weak — which is the only reason to keep the record at all.
 *
 * The diff is computed here, never accepted from the caller. A list of changes
 * typed alongside the edit is a second account of the same act, and two
 * accounts eventually disagree.
 *
 * Two refusals matter as much as the record. An acceptance "with change" whose
 * answer is identical to the model's, and an acceptance "unchanged" whose
 * answer differs, are both contradictions — and both are the shape of thing a
 * screen produces when its buttons are wired to the wrong decision.
 */
describe('what a person changed before standing behind it', () => {
  /**
   * A run that is actually held to the output standard.
   *
   * `runOne` above uses the safety forecast, which is not — so it has no
   * standard answer on its record and nothing to diff against. An impact
   * assessment is, which is why this block drives that instead of reusing the
   * helper: a test of a diff has to run against a task that produces the thing
   * being diffed.
   */
  async function runStandardOne(): Promise<string> {
    const ctx = platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
    const change = claims.submitChangeRequest(ctx, {
      description: 'Ground conditions require a second run of temporary works to the trunk main diversion.',
      origin: 'CLIENT',
      noticeType: 'CCI',
      reason: 'Instructed following the ground investigation review',
      impactedPackageIds: [],
      affectedSubcontractIds: [],
      supportingEvidenceHash: hashEvidence(`second sheet-pile run ${Math.random()}`),
    });
    await claims.assessImpact(ctx, {
      changeRequestId: change.changeRequestId,
      costImpactMinor: 4_200_000,
      timeImpactDays: 14,
      affectedTaskIds: [],
      qualityImpact: 'None.',
      safetyImpact: 'Additional plant movements in the compound.',
    });
    const outstanding = aidisposition
      .aiDispositionPosition(asPM())
      .outstanding.filter((entry) => {
        const state = platform.ledger.require({ refType: 'AIExecution', refId: entry.executionId }).state as {
          standardOutput?: unknown;
        };
        return state.standardOutput !== undefined;
      });
    assert.ok(outstanding.length > 0, 'the run produced no undisposed execution held to the standard');
    return outstanding[outstanding.length - 1]!.executionId;
  }

  /** The model's own answer, off the execution record. */
  function modelAnswer(executionId: string): Record<string, unknown> {
    const state = platform.ledger.require({ refType: 'AIExecution', refId: executionId }).state as {
      standardOutput?: Record<string, unknown>;
    };
    assert.ok(state.standardOutput, 'the execution did not keep the answer it produced');
    return state.standardOutput;
  }

  it('keeps the answer the model gave, which is what there is to diff against', async () => {
    const executionId = await runStandardOne();
    const state = platform.ledger.require({ refType: 'AIExecution', refId: executionId }).state as {
      standardOutput?: Record<string, unknown>;
      standardVersion?: string;
    };
    // An audit record of an AI execution that does not contain what the model
    // said is missing its subject.
    assert.ok(state.standardOutput, 'the answer is not on the execution record');
    assert.match(String(state.standardVersion), /^aios@[0-9a-f]{8}$/);
  });

  it('records which fields were changed, and what they were changed from', async () => {
    const executionId = await runStandardOne();
    const edited = { ...modelAnswer(executionId), riskLevel: 'CRITICAL', recommendedAction: 'Stop the lift and re-plan it.' };

    const result = aidisposition.disposeAIOutput(asPM(), {
      executionId,
      decision: 'ACCEPTED_WITH_CHANGE',
      reason: 'The model under-read the lift over the live carriageway.',
      edited,
    });

    const changes = result.changes ?? [];
    assert.equal(changes.length, 2, JSON.stringify(changes));
    const risk = changes.find((change) => change.field === '/riskLevel');
    assert.ok(risk, JSON.stringify(changes));
    assert.equal(risk.to, 'CRITICAL');
    assert.equal(risk.from, modelAnswer(executionId).riskLevel, 'the original value was not carried');

    // And it is on the record, not only in the reply.
    const stored = aidisposition.dispositionOf(asPM(), executionId);
    assert.equal(stored?.changes?.length, 2);
  });

  it('refuses an acceptance with change whose answer is identical to the model’s', async () => {
    const executionId = await runStandardOne();
    throwsCode(
      () =>
        aidisposition.disposeAIOutput(asPM(), {
          executionId,
          decision: 'ACCEPTED_WITH_CHANGE',
          reason: 'Corrected it.',
          edited: modelAnswer(executionId),
        }),
      'NO_CHANGE_MADE',
    );
    assert.equal(aidisposition.dispositionOf(asPM(), executionId), undefined, 'a refused disposition was still written');
  });

  it('refuses a clean acceptance whose answer differs from the model’s', async () => {
    const executionId = await runStandardOne();
    throwsCode(
      () =>
        aidisposition.disposeAIOutput(asPM(), {
          executionId,
          decision: 'ACCEPTED',
          edited: { ...modelAnswer(executionId), riskLevel: 'CRITICAL' },
        }),
      'CHANGE_WITHOUT_DECISION',
    );
  });

  it('still records a decision from a screen that does not hold the edited answer', async () => {
    // Losing the decision to gain the detail would be the wrong trade: a
    // disposition with no field-level record is still the fact the fifth gate
    // clause reads.
    const executionId = await runOne();
    const result = aidisposition.disposeAIOutput(asPM(), {
      executionId,
      decision: 'ACCEPTED_WITH_CHANGE',
      reason: 'Amended on paper at the pre-start.',
    });
    assert.equal(result.changes, undefined);
    assert.equal(aidisposition.dispositionOf(asPM(), executionId)?.decision, 'ACCEPTED_WITH_CHANGE');
  });

  it('counts where the model is corrected, most-corrected first', async () => {
    const first = await runStandardOne();
    aidisposition.disposeAIOutput(asPM(), {
      executionId: first,
      decision: 'ACCEPTED_WITH_CHANGE',
      reason: 'Risk under-read.',
      edited: { ...modelAnswer(first), riskLevel: 'CRITICAL' },
    });

    const second = await runStandardOne();
    aidisposition.disposeAIOutput(asPM(), {
      executionId: second,
      decision: 'ACCEPTED_WITH_CHANGE',
      reason: 'Risk under-read again, and the action was too vague.',
      edited: { ...modelAnswer(second), riskLevel: 'CRITICAL', recommendedAction: 'Brief the gang before the lift.' },
    });

    const position = aidisposition.aiDispositionPosition(asPM());
    assert.equal(position.correctionsRecorded, 2);
    // Risk twice, the action once — most-corrected first, which is the ordering
    // that makes the list worth reading.
    assert.equal(position.correctedFields[0]?.field, '/riskLevel');
    assert.equal(position.correctedFields[0]?.times, 2);
    assert.equal(position.correctedFields[1]?.field, '/recommendedAction');
    assert.equal(position.correctedFields[1]?.times, 1);
  });
});
