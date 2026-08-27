import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as aidisposition from '../src/domain/aidisposition.ts';
import * as safetyEngine from '../src/engines/safety.ts';
import * as stagegate from '../src/domain/stagegate.ts';
import * as structure from '../src/domain/structure.ts';
import * as tenderreview from '../src/domain/tenderreview.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The stage gate Definition of Done — 8.4.
 *
 * The lifecycle already had a gate that counts the entities a phase cannot be
 * left without. This is the seven-clause Definition of Done on top of it, and
 * the difference is the difference between "an estimate exists" and "this
 * tender is finished".
 *
 * What these tests are really about is one rule. **A clause the platform cannot
 * assess is reported as unassessable, never as passed.** A gate that quietly
 * passes what it did not check converts a gap into a signed assurance, and the
 * signature is the thing somebody relies on two years later.
 */

let platform: Platform;
let seed: SeedResult;

const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });
const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── The report ──────────────────────────────────────────────────────────────

describe('stage gate · seven clauses, each answered from the ledger', () => {
  it('answers all seven', () => {
    const report = stagegate.evaluateTenderGate(asPM());
    assert.equal(report.clauses.length, 7);
    assert.deepEqual(
      report.clauses.map((clause) => clause.clause),
      [...stagegate.GATE_CLAUSE],
    );
    for (const clause of report.clauses) {
      assert.ok(clause.title.length > 0, `${clause.clause} has no title`);
      assert.ok(clause.detail.length > 0, `${clause.clause} says nothing`);
    }
  });

  /**
   * The seeded project has never had a tender review, so the first clause fails
   * — and it says which input, not "incomplete".
   */
  it('names what is missing rather than counting it', () => {
    const report = stagegate.evaluateTenderGate(asPM());
    const inputs = report.clauses.find((c) => c.clause === 'INPUTS_COMPLETE')!;
    assert.equal(inputs.state, 'FAIL');
    assert.ok(inputs.blocking.length > 0);
    assert.match(inputs.blocking.join(' '), /No tender review exists/);
  });

  /**
   * The whole ledger re-verified against its own state and chain hashes. This
   * is the clause that makes the other six worth anything: a report nobody can
   * reproduce is an opinion about a project.
   */
  it('replays the entire event log and verifies every hash', () => {
    const replay = stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'REPLAYABLE')!;
    assert.equal(replay.state, 'PASS');
    assert.match(replay.detail, /events replayed and re-verified/);
    assert.deepEqual(replay.blocking, []);
  });

  it('re-verifies every approval rather than trusting the command that wrote it', () => {
    const approvals = stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'APPROVALS_GOVERNED')!;
    assert.equal(approvals.state, 'PASS');
    assert.match(approvals.detail, /re-verified/);
    assert.match(approvals.detail, /a different person from the one who prepared it/);
  });

  it('reports the same content hash for the same state of the world', () => {
    assert.equal(stagegate.evaluateTenderGate(asPM()).contentHash, stagegate.evaluateTenderGate(asPM()).contentHash);
  });

  it('moves the hash when a clause changes', () => {
    const before = stagegate.evaluateTenderGate(asPM()).contentHash;
    structure.transitionPhase(asOwner(), {
      to: 'TENDER',
      justification: 'Reopened to record the tender review this gate is being assessed against',
    });
    tenderreview.openReview(platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' }), {
      title: 'Ashworth Phase 2 — tender documents',
      form: { suite: 'NEC4', edition: 'Option A (2017)', amendmentsStated: false },
    });
    assert.notEqual(stagegate.evaluateTenderGate(asPM()).contentHash, before);
  });
});

// ── The honesty rule ────────────────────────────────────────────────────────

describe('stage gate · a clause it cannot assess is not a clause it passed', () => {
  /**
   * The specification asks a used AI output to carry evidence, confidence,
   * assumptions, model and prompt versions, ACU settlement and human
   * disposition. Four of those are recorded. Three are not recorded anywhere in
   * the platform, so the clause cannot be assessed in full — and it says which
   * three, by name, on the screen rather than only in a document.
   */
  /**
   * This clause read `NOT_ASSESSABLE` at every gate from the first one until
   * the three missing pieces were built: assumptions and prompt version, now
   * written onto the AI event by `runAI`, and human disposition, which could
   * never be a field because it is a later act by a different party and is
   * `AI_OUTPUT_DISPOSED`.
   *
   * The tests below no longer assert the gap. They assert the two things that
   * replaced it: that a fully-accounted output passes, and — far more
   * important — that an output nobody has decided about does **not**.
   */
  it('passes the AI clause once every output is accounted for and disposed of', () => {
    const ai = stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'AI_ACCOUNTED')!;
    assert.equal(ai.state, 'PASS', ai.blocking.join('; '));
    assert.match(ai.detail, /assumptions and prompt version/);
    assert.match(ai.detail, /accepted or rejected by a named person/);
    assert.deepEqual(ai.blocking, []);
  });

  it('fails the AI clause for an output nobody has stood behind, naming it', async () => {
    // A genuine new AI output, left undisposed. This is the failure the clause
    // exists for: the model wrote and nobody looked.
    const before = stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'AI_ACCOUNTED')!;
    assert.equal(before.state, 'PASS');

    // A real AI run — `forecastSafetyRisk` goes through `runAI` — left
    // undisposed. `assessContingency` would not do: it is pure arithmetic and
    // produces no AI event at all, so it could never have failed the clause.
    await safetyEngine.forecastSafetyRisk(asSafety(), {
      headcount: 40,
      highRiskActivitiesPlanned: 3,
      adverseWeatherDays: 2,
    });

    const after = stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'AI_ACCOUNTED')!;
    assert.equal(after.state, 'FAIL', 'an undisposed AI output did not fail the clause');
    assert.ok(
      after.blocking.some((b) => /has not been accepted or rejected by a person/.test(b)),
      after.blocking.join('; '),
    );

    // And it clears the moment a person decides about it.
    const outstanding = aidisposition.aiDispositionPosition(asPM()).outstanding;
    assert.ok(outstanding.length > 0);
    for (const execution of outstanding) {
      aidisposition.disposeAIOutput(asPM(), { executionId: execution.executionId, decision: 'ACCEPTED' });
    }
    assert.equal(
      stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'AI_ACCOUNTED')!.state,
      'PASS',
    );
  });

  it('still separates what it could not see from what it checked and found wanting', () => {
    // The distinction itself, which outlives any particular gap: a clause the
    // platform cannot assess is never counted as failed, and never as passed.
    const report = stagegate.evaluateTenderGate(asPM());
    for (const clause of report.unassessable) {
      assert.equal(report.failed.includes(clause), false, `${clause} is both failed and unassessable`);
    }
    for (const clause of report.clauses) {
      if (clause.state === 'NOT_ASSESSABLE') {
        assert.ok(clause.blocking.length > 0, `${clause.clause} cannot be assessed and says nothing about why`);
      }
    }
  });

  it('says how many of the seven are met and how many it cannot answer', () => {
    const report = stagegate.evaluateTenderGate(asPM());
    if (report.passed) {
      assert.equal(report.summary, 'All seven clauses met.');
    } else {
      assert.ok(/not met|cannot assess/.test(report.summary), report.summary);
    }
  });
});

// ── The decision ────────────────────────────────────────────────────────────

describe('stage gate · the decision', () => {
  it('refuses a clean pass over an open clause', () => {
    const error = throwsCode(
      () => stagegate.decideGate(asOwner(), { decision: 'PASS', rationale: 'Looks fine' }),
      'GATE_NOT_MET',
    );
    assert.match(String(error.message), /an assurance nobody checked/);
  });

  it('refuses a decision with no rationale', () => {
    throwsCode(() => stagegate.decideGate(asOwner(), { decision: 'HOLD', rationale: '  ' }), 'RATIONALE_REQUIRED');
  });

  it('refuses a conditional pass with no conditions on it', () => {
    const error = throwsCode(
      () => stagegate.decideGate(asOwner(), { decision: 'PASS_WITH_CONDITIONS', rationale: 'Proceeding' }),
      'CONDITIONS_REQUIRED',
    );
    assert.match(String(error.message), /is a pass/);
  });

  it('refuses a conditional pass that leaves an outstanding clause uncovered', () => {
    const error = throwsCode(
      () =>
        stagegate.decideGate(asOwner(), {
          decision: 'PASS_WITH_CONDITIONS',
          rationale: 'Proceeding to construction',
          conditions: [
            { clause: 'AI_ACCOUNTED', what: 'Record prompt versions', owner: 'Head of Digital', by: '2027-06-30' },
          ],
        }),
      'CLAUSE_UNCONDITIONED',
    );
    assert.match(String(error.message), /silently covering it/);
  });

  it('refuses a condition with no date, and one with no owner', () => {
    const outstanding = stagegate.evaluateTenderGate(asOwner());
    const conditions = [...outstanding.failed, ...outstanding.unassessable].map((clause) => ({
      clause,
      what: 'Close it',
      owner: 'Project Director',
      by: '2027-06-30',
    }));

    const undated = throwsCode(
      () =>
        stagegate.decideGate(asOwner(), {
          decision: 'PASS_WITH_CONDITIONS',
          rationale: 'Proceeding',
          conditions: conditions.map((condition, index) => (index === 0 ? { ...condition, by: '' } : condition)),
        }),
      'CONDITION_UNBOUND',
    );
    assert.match(String(undated.message), /no date/);

    const unowned = throwsCode(
      () =>
        stagegate.decideGate(asOwner(), {
          decision: 'PASS_WITH_CONDITIONS',
          rationale: 'Proceeding',
          conditions: conditions.map((condition, index) => (index === 0 ? { ...condition, owner: '' } : condition)),
        }),
      'CONDITION_UNBOUND',
    );
    assert.match(String(unowned.message), /no owner/);
  });

  it('refuses a date that is not a date', () => {
    const outstanding = stagegate.evaluateTenderGate(asOwner());
    throwsCode(
      () =>
        stagegate.decideGate(asOwner(), {
          decision: 'PASS_WITH_CONDITIONS',
          rationale: 'Proceeding',
          conditions: [...outstanding.failed, ...outstanding.unassessable].map((clause) => ({
            clause,
            what: 'Close it',
            owner: 'Project Director',
            by: 'before Christmas',
          })),
        }),
      'CONDITION_UNBOUND',
    );
  });

  it('accepts a conditional pass covering every outstanding clause', () => {
    const outstanding = stagegate.evaluateTenderGate(asOwner());
    const clauses = [...outstanding.failed, ...outstanding.unassessable];
    const result = stagegate.decideGate(asOwner(), {
      decision: 'PASS_WITH_CONDITIONS',
      rationale: 'Board approved proceeding to construction on 14 May against the conditions below',
      conditions: clauses.map((clause) => ({
        clause,
        what: `Close ${clause} before the first valuation`,
        owner: 'Project Director',
        by: '2027-06-30',
      })),
    });
    assert.equal(result.decision, 'PASS_WITH_CONDITIONS');
    assert.equal(result.conditions, clauses.length);
    assert.equal(result.contentHash, outstanding.contentHash);
  });

  it('always accepts a hold, whatever the report says', () => {
    const result = stagegate.decideGate(asOwner(), {
      decision: 'HOLD',
      rationale: 'The award terms differ from what was bid and the departures are not accepted',
    });
    assert.equal(result.decision, 'HOLD');
  });

  it('does not let a role without the project authority decide it', () => {
    throwsCode(
      () =>
        stagegate.decideGate(platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' }), {
          decision: 'HOLD',
          rationale: 'Not mine to make',
        }),
      'ACCESS_DENIED',
    );
  });
});

// ── Conditions afterwards ───────────────────────────────────────────────────

describe('stage gate · a condition with a date is a condition that can go past it', () => {
  it('lists every decision with the report hash it was made against', () => {
    const position = stagegate.stageGatePosition(asPM());
    assert.ok(position.decisions.length >= 2);
    for (const decision of position.decisions) {
      assert.match(decision.reportHash, /^sha256:|^[0-9a-f]{64}$/);
      assert.ok(Date.parse(decision.decidedAt) > 0);
    }
  });

  it('reports nothing overdue while the dates are ahead', () => {
    const position = stagegate.stageGatePosition(asPM(), '2027-01-01');
    assert.equal(
      position.decisions.reduce((n, decision) => n + decision.overdue.length, 0),
      0,
    );
    assert.doesNotMatch(position.summary, /past its date/);
  });

  /**
   * The point of a time-bound condition. On the day after, the conditional pass
   * stops being a pass and starts being a list of things somebody promised.
   */
  it('reports them overdue once the date has gone', () => {
    const position = stagegate.stageGatePosition(asPM(), '2027-07-01');
    const overdue = position.decisions.reduce((n, decision) => n + decision.overdue.length, 0);
    assert.ok(overdue > 0, 'a condition dated 2027-06-30 was not overdue on 2027-07-01');
    assert.match(position.summary, /past its date/);
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('stage gate · what the catalogue says', () => {
  /**
   * A gate decision is the assurance somebody relies on two years later, and
   * the whole point of the record is that a person put their name to it.
   */
  it('lets no agent decide a gate', () => {
    assert.equal(lookupEventType('STAGE_GATE_DECIDED')?.aiAllowed, false);
    assert.equal(lookupEventType('STAGE_GATE_DECIDED')?.action, 'APPROVE');
  });

  it('requires the report itself as evidence of the decision', () => {
    assert.equal(lookupEventType('STAGE_GATE_DECIDED')?.requiresEvidence, true);
  });

  /**
   * Not commercial. A regulator asking whether the gate was cleared is asking a
   * question they are entitled to an answer to.
   */
  it('classifies the decision as project governance rather than commercial', () => {
    const classification = classifyEntity('StageGateDecision');
    assert.equal(classification?.area, 'PROJECT_SETUP');
    assert.equal(classification?.sensitivity, undefined);
  });

  /**
   * The coarse lifecycle gate is untouched and still governs the phase move.
   * Two gates would be two answers to one question; this one sits on top.
   */
  it('leaves the lifecycle phase gate exactly as it was', () => {
    const evaluation = structure.evaluateCurrentGate(asPM());
    assert.ok(Array.isArray(evaluation.criteria));
    assert.equal(typeof evaluation.passed, 'boolean');
    // Every criterion is still the coarse entity check it always was — the
    // Definition of Done sits above it rather than replacing it, so a phase
    // move is still governed by the same rule it was yesterday.
    for (const criterion of evaluation.criteria) {
      assert.equal(typeof criterion.found, 'number');
      assert.equal(typeof criterion.required, 'number');
    }
  });
});
