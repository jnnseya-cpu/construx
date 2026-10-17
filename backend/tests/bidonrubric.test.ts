import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  AMBER_FLOOR,
  CRITERION,
  DEFAULT_WEIGHTS,
  GREEN_FLOOR,
  HARD_RULE,
  WORD_LIMIT_TOLERANCE,
  bandFor,
  hardRuleHits,
  packReadiness,
  verdictFor,
  weightedScore,
  type CriterionScores,
  type ScoreInput,
} from '../src/domain/bidon/rubric.ts';

/**
 * The Bid-On rubric, its four hard rules, and pack readiness.
 *
 * The specification's acceptance criteria name two of these explicitly —
 * *"every hard rule forces red, verified by unit tests for each rule"* and
 * *"export is blocked until every mandatory answer is approved"* — so there is
 * a test per rule rather than one test that happens to trip several.
 *
 * Everything here is a pure function. That is what lets the scorer, the screen
 * and the export gate agree: a score computed three ways is three numbers, and
 * the one somebody acts on is whichever screen they had open.
 */

const DEADLINE = '2026-12-01';

const scores = (value = 90): CriterionScores =>
  Object.fromEntries(CRITERION.map((criterion) => [criterion, value])) as CriterionScores;

const input = (overrides: Partial<ScoreInput> = {}): ScoreInput => ({
  scores: scores(),
  answered: true,
  mandatory: true,
  passFail: false,
  words: 400,
  deadline: DEADLINE,
  citations: [],
  declarations: [],
  ...overrides,
});

describe('the weighted score is the buyer’s arithmetic', () => {
  it('weights the five criteria to one, and shows its working', () => {
    assert.equal(
      Object.values(DEFAULT_WEIGHTS).reduce((sum, weight) => sum + weight, 0),
      1,
      'the default weights do not sum to 1, so the rubric applied is not the rubric published',
    );

    const { score, basis } = weightedScore(scores(100));
    assert.equal(score, 100);
    assert.equal(basis.length, 5);
    // The working, so a score is arguable rather than asserted.
    assert.deepEqual(
      basis.map((entry) => entry.criterion),
      [...CRITERION],
    );
    assert.equal(basis.find((entry) => entry.criterion === 'COMPLIANCE')!.weight, 0.3);
  });

  it('computes the specification’s own example rather than an average', () => {
    // Compliance is worth three times clarity. An answer that is complete and
    // badly written scores well above one that reads beautifully and misses
    // half the question, and the weights are the only thing that says so.
    const complete = weightedScore({
      COMPLIANCE: 100,
      EVIDENCE: 100,
      BUYER_RELEVANCE: 100,
      SPECIFICITY: 100,
      CLARITY_AND_LIMITS: 0,
    }).score;
    const eloquent = weightedScore({
      COMPLIANCE: 0,
      EVIDENCE: 0,
      BUYER_RELEVANCE: 100,
      SPECIFICITY: 100,
      CLARITY_AND_LIMITS: 100,
    }).score;

    assert.equal(complete, 90);
    assert.equal(eloquent, 45);
    assert.ok(complete > eloquent);
  });

  it('bands on the charity OS boundaries, inclusive at the floor', () => {
    assert.equal(bandFor(GREEN_FLOOR), 'GREEN');
    assert.equal(bandFor(GREEN_FLOOR - 0.1), 'AMBER');
    assert.equal(bandFor(AMBER_FLOOR), 'AMBER');
    assert.equal(bandFor(AMBER_FLOOR - 0.1), 'RED');
    assert.equal(bandFor(0), 'RED');
  });
});

describe('every hard rule forces red', () => {
  it('declares all five and leaves none untested here', () => {
    // Enumerated from the type rather than listed again, so a rule added later
    // fails this test instead of being added with nothing exercising it.
    assert.deepEqual(
      [...HARD_RULE],
      [
        'MANDATORY_UNANSWERED',
        'PASS_FAIL_FAILED',
        'EVIDENCE_LAPSES_BEFORE_DEADLINE',
        'DECLARATION_UNCONFIRMED',
        'OVER_WORD_LIMIT',
      ],
    );
  });

  it('a mandatory question with no answer', () => {
    const verdict = verdictFor(input({ answered: false, scores: undefined }));
    assert.equal(verdict.rag, 'RED');
    assert.deepEqual(
      verdict.hardRules.map((hit) => hit.rule),
      ['MANDATORY_UNANSWERED'],
    );
    assert.match(verdict.hardRules[0]!.remedy, /not marked down, it is rejected/);

    // Not mandatory: it scores zero and is not a block. The distinction is the
    // difference between a bid that is rejected and a bid that concedes marks.
    const optional = verdictFor(input({ answered: false, scores: undefined, mandatory: false }));
    assert.deepEqual(optional.hardRules, []);
    assert.equal(optional.rag, 'RED', 'a zero should still band red');
  });

  it('a pass/fail question answered "no"', () => {
    const verdict = verdictFor(input({ passFail: true, passFailAnswer: false }));
    assert.equal(verdict.rag, 'RED');
    assert.deepEqual(
      verdict.hardRules.map((hit) => hit.rule),
      ['PASS_FAIL_FAILED'],
    );
    assert.match(verdict.hardRules[0]!.remedy, /ends the bid at the gate/);

    // Answered yes, and a pass/fail question with no answer recorded yet is not
    // a failure — it is unanswered, which is a different rule.
    assert.deepEqual(verdictFor(input({ passFail: true, passFailAnswer: true })).hardRules, []);
    assert.deepEqual(verdictFor(input({ passFail: true })).hardRules, []);
  });

  it('a cited certificate that expires before the deadline, judged against the deadline not today', () => {
    const lapsing = verdictFor(
      input({
        citations: [{ reference: 'EV-0004', title: 'Employers liability certificate', expiresOn: '2026-11-15' }],
      }),
    );
    assert.equal(lapsing.rag, 'RED');
    assert.deepEqual(
      lapsing.hardRules.map((hit) => hit.rule),
      ['EVIDENCE_LAPSES_BEFORE_DEADLINE'],
    );
    assert.match(lapsing.hardRules[0]!.detail, /expires 2026-11-15, before the deadline of 2026-12-01/);

    // Current on the day the buyer reads it, which is the only day that
    // matters. A certificate expiring *on* the deadline is still current.
    assert.deepEqual(
      verdictFor(input({ citations: [{ reference: 'EV-1', title: 'Cert', expiresOn: DEADLINE }] })).hardRules,
      [],
    );
    // And evidence that does not lapse at all.
    assert.deepEqual(verdictFor(input({ citations: [{ reference: 'EV-2', title: 'Policy' }] })).hardRules, []);
  });

  it('a declaration the customer has not confirmed', () => {
    const verdict = verdictFor(
      input({
        declarations: [{ statement: 'Employers liability cover of £10m each and every claim', confirmed: false }],
      }),
    );
    assert.equal(verdict.rag, 'RED');
    assert.deepEqual(
      verdict.hardRules.map((hit) => hit.rule),
      ['DECLARATION_UNCONFIRMED'],
    );
    // The remedy has to name who can clear it, because the provider cannot.
    assert.match(verdict.hardRules[0]!.remedy, /Only the customer’s own admin/);
    assert.match(verdict.hardRules[0]!.remedy, /not the provider and not an agent/);

    assert.deepEqual(
      verdictFor(input({ declarations: [{ statement: 'Cover of £10m', confirmed: true }] })).hardRules,
      [],
    );
  });

  it('an answer more than 10% over a stated word limit, and not one inside the tolerance', () => {
    assert.equal(WORD_LIMIT_TOLERANCE, 0.1);

    // 1,100 of 1,000 is exactly at the tolerance and passes; 1,101 does not.
    assert.deepEqual(verdictFor(input({ words: 1_100, wordLimit: 1_000 })).hardRules, []);
    const over = verdictFor(input({ words: 1_101, wordLimit: 1_000 }));
    assert.deepEqual(
      over.hardRules.map((hit) => hit.rule),
      ['OVER_WORD_LIMIT'],
    );
    assert.match(over.hardRules[0]!.detail, /1101 words against a limit of 1000/);
    assert.match(over.hardRules[0]!.remedy, /anything past a stated limit is not read/);

    // No stated limit is not an unlimited answer scoring badly — it is a
    // question the buyer put no limit on, and the rule has nothing to apply.
    assert.deepEqual(verdictFor(input({ words: 9_000 })).hardRules, []);
  });

  it('reports every rule that fired rather than the first', () => {
    // A reviewer fixing one at a time finds the second after they thought they
    // were finished, and on the return date that is a missed deadline.
    const verdict = verdictFor(
      input({
        passFail: true,
        passFailAnswer: false,
        words: 2_000,
        wordLimit: 500,
        citations: [{ reference: 'EV-9', title: 'Lapsed insurance', expiresOn: '2026-01-01' }],
        declarations: [{ statement: 'An accident rate nobody has confirmed', confirmed: false }],
      }),
    );
    assert.deepEqual(
      verdict.hardRules.map((hit) => hit.rule).sort(),
      [
        'DECLARATION_UNCONFIRMED',
        'EVIDENCE_LAPSES_BEFORE_DEADLINE',
        'OVER_WORD_LIMIT',
        'PASS_FAIL_FAILED',
      ].sort(),
    );
    assert.ok(verdict.hardRules.every((hit) => hit.remedy.length > 20), 'a hard rule fired with no remedy');
  });

  it('keeps the weighted band beside the verdict, so a red is explainable', () => {
    // "This would have been green" is what tells a reviewer the prose is fine
    // and the problem is a certificate. A hard rule can only lower the verdict.
    const verdict = verdictFor(
      input({ scores: scores(95), citations: [{ reference: 'EV-3', title: 'Cert', expiresOn: '2026-01-01' }] }),
    );
    assert.equal(verdict.weightedBand, 'GREEN');
    assert.equal(verdict.rag, 'RED');
    assert.equal(verdict.weightedScore, 95);

    // And it never raises one.
    const weak = verdictFor(input({ scores: scores(10) }));
    assert.equal(weak.rag, 'RED');
    assert.deepEqual(weak.hardRules, []);
  });

  it('declares a hard rule fired on a question nobody made mandatory, where the rule is about the answer', () => {
    // An expired certificate cited on a scored question is still an expired
    // certificate. Only `MANDATORY_UNANSWERED` depends on the question being
    // mandatory, and conflating them would let a lapsed insurance certificate
    // through on every scored question in the pack.
    const verdict = verdictFor(
      input({ mandatory: false, citations: [{ reference: 'EV-5', title: 'Cert', expiresOn: '2026-02-01' }] }),
    );
    assert.deepEqual(
      verdict.hardRules.map((hit) => hit.rule),
      ['EVIDENCE_LAPSES_BEFORE_DEADLINE'],
    );
  });
});

describe('pack readiness and the export gate', () => {
  const answer = (overrides: Partial<{ weighting: number; mandatory: boolean; approved: boolean; score: number }> = {}) => {
    const { weighting, mandatory = true, approved = true, score = 90 } = overrides;
    return {
      ...(weighting === undefined ? {} : { weighting }),
      mandatory,
      approved,
      verdict: verdictFor(input({ scores: scores(score) })),
    };
  };

  it('weights the mean by each question’s own weighting', () => {
    // A 30% question scoring 40 and a 2% question scoring 40 are not the same
    // problem, and an unweighted mean says they are.
    const readiness = packReadiness([
      answer({ weighting: 30, score: 40 }),
      answer({ weighting: 2, score: 100 }),
    ]);
    // (40×30 + 100×2) / 32 = 43.75
    assert.equal(readiness.readinessPercent, 43.8);
    assert.ok(!readiness.summary.includes('unweighted'));
  });

  it('says so when it falls back to an unweighted mean', () => {
    const readiness = packReadiness([answer({ score: 40 }), answer({ score: 100 })]);
    assert.equal(readiness.readinessPercent, 70);
    assert.match(readiness.summary, /unweighted mean/);
  });

  it('blocks the export while a mandatory answer is red', () => {
    const readiness = packReadiness([
      answer({ score: 90 }),
      { mandatory: true, approved: true, verdict: verdictFor(input({ answered: false, scores: undefined })) },
    ]);
    assert.equal(readiness.exportable, false);
    assert.equal(readiness.blocking.length, 1);
    assert.match(readiness.blocking[0]!.reason, /mandatory question has no answer/);
    assert.match(readiness.summary, /cannot be exported/);
  });

  it('blocks the export while a mandatory answer is unapproved, however green', () => {
    // An unapproved green has had no person's name on it, and a person must
    // approve every answer before anything leaves the platform.
    const readiness = packReadiness([answer({ score: 100, approved: false })]);
    assert.equal(readiness.exportable, false);
    assert.match(readiness.blocking[0]!.reason, /Nobody has approved it/);
  });

  it('does not block on an optional answer that is red or unapproved', () => {
    // Conceded marks, not a rejection. A gate that refused here would stop a
    // pack going out over a question the buyer scores rather than fails.
    const readiness = packReadiness([
      answer({ score: 100 }),
      { mandatory: false, approved: false, verdict: verdictFor(input({ scores: scores(10), mandatory: false })) },
    ]);
    assert.equal(readiness.exportable, true);
    assert.deepEqual(readiness.blocking, []);
  });

  it('refuses to call an empty pack exportable', () => {
    const readiness = packReadiness([]);
    assert.equal(readiness.exportable, false);
    assert.equal(readiness.readinessPercent, null);
    assert.match(readiness.summary, /Nothing parsed yet/);
  });

  it('counts the bands, so a screen can show the shape of the pack', () => {
    const readiness = packReadiness([
      answer({ score: 90 }),
      answer({ score: 60 }),
      { mandatory: false, approved: true, verdict: verdictFor(input({ scores: scores(20), mandatory: false })) },
    ]);
    assert.equal(readiness.green, 1);
    assert.equal(readiness.amber, 1);
    assert.equal(readiness.red, 1);
    assert.equal(readiness.total, 3);
    assert.equal(readiness.approved, 3);
  });
});
