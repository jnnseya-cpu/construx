import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
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
  it('reports the AI clause as unassessable and names exactly what is missing', () => {
    const ai = stagegate.evaluateTenderGate(asPM()).clauses.find((c) => c.clause === 'AI_ACCOUNTED')!;
    assert.equal(ai.state, 'NOT_ASSESSABLE');
    assert.match(ai.detail, /assumptions, prompt version, human disposition/);
    assert.match(ai.detail, /reported as unassessable rather than passed/);
    assert.equal(ai.blocking.length, 3);
  });

  it('separates what it could not see from what it checked and found wanting', () => {
    const report = stagegate.evaluateTenderGate(asPM());
    assert.ok(report.unassessable.includes('AI_ACCOUNTED'));
    assert.equal(report.failed.includes('AI_ACCOUNTED'), false);
    assert.equal(report.passed, false);
  });

  it('says how many of the seven are met and how many it cannot answer', () => {
    const report = stagegate.evaluateTenderGate(asPM());
    assert.match(report.summary, /not met/);
    assert.match(report.summary, /cannot assess/);
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
