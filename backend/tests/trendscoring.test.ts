import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  anomalyZ,
  assessOpportunity,
  clearsCountGate,
  confidenceScore,
  corroborationScore,
  decisionBand,
  demandFromZ,
  insufficientHistory,
  logLift,
  mad,
  median,
  opportunityScore,
  vetoesOf,
} from '../src/domain/trend/scoring.ts';
import { briefInForce, validateGrowthBrief } from '../src/domain/trend/brief.ts';

/**
 * Trend Intelligence AI §5/§17 scoring and the §6 Growth Brief contract as pure logic.
 * The headline case is the spec's own worked example (§5, TI-03): component inputs that
 * must yield 86.25 opportunity and 83.5 confidence and, un-rounded, a reviewable brief.
 */

const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

describe('the opportunity and confidence scores (spec §5, TI-03)', () => {
  it('computes the worked example exactly: 86.25 opportunity, 83.5 confidence', () => {
    const score = opportunityScore({ demand: 80, fit: 95, intent: 85, timing: 90, readiness: 80 });
    const confidence = confidenceScore({ sourceQuality: 90, corroboration: 80, coverage: 70, freshness: 90 }, { singleSourceFamily: false });
    assert.ok(close(score, 86.25), `opportunity ${score} ≠ 86.25`);
    assert.ok(close(confidence, 83.5), `confidence ${confidence} ≠ 83.5`);
  });

  it('returns a reviewable brief for the example, neither score rounded before the decision', () => {
    const a = assessOpportunity({
      opportunity: { demand: 80, fit: 95, intent: 85, timing: 90, readiness: 80 },
      confidence: { sourceQuality: 90, corroboration: 80, coverage: 70, freshness: 90 },
      singleSourceFamily: false,
      autoOptIn: true, // opted in, but confidence 83.5 < 85, so still a brief not an auto action
    });
    assert.ok(close(a.score, 86.25));
    assert.ok(close(a.confidence, 83.5));
    assert.deepEqual(a.vetoes, []);
    assert.equal(a.band, 'BRIEF');
  });

  it('rejects an out-of-range component', () => {
    assert.throws(() => opportunityScore({ demand: 101, fit: 0, intent: 0, timing: 0, readiness: 0 }));
    assert.throws(() => confidenceScore({ sourceQuality: -1, corroboration: 0, coverage: 0, freshness: 0 }, { singleSourceFamily: false }));
  });
});

describe('the decision bands (spec §5 table)', () => {
  it('archives below the cutoffs, watches the middle, briefs and auto-actions at the top', () => {
    assert.equal(decisionBand(59, 90), 'ARCHIVE'); // score below 60
    assert.equal(decisionBand(90, 54), 'ARCHIVE'); // confidence below 55
    assert.equal(decisionBand(70, 60), 'WATCH'); // both above archive, below brief
    assert.equal(decisionBand(80, 80), 'BRIEF');
    assert.equal(decisionBand(90, 90, { autoOptIn: true }), 'AUTO');
    assert.equal(decisionBand(90, 90, { autoOptIn: false }), 'BRIEF'); // auto needs explicit opt-in
    assert.equal(decisionBand(90, 90), 'BRIEF'); // no opt-in given
  });

  it('never lets a veto reach a brief or an automatic action', () => {
    assert.equal(decisionBand(95, 95, { vetoed: true, autoOptIn: true }), 'WATCH');
  });
});

describe('vetoes (spec §5.4)', () => {
  it('vetoes activation when readiness is zero, and keeps a supplied veto', () => {
    assert.deepEqual(vetoesOf({ demand: 90, fit: 90, intent: 90, timing: 90, readiness: 0 }), ['MISSING_READINESS']);
    assert.deepEqual(
      vetoesOf({ demand: 90, fit: 90, intent: 90, timing: 90, readiness: 50 }, ['RESTRICTED_TOPIC']),
      ['RESTRICTED_TOPIC'],
    );
    const both = vetoesOf({ demand: 1, fit: 1, intent: 1, timing: 1, readiness: 0 }, ['OUT_OF_MARKET']);
    assert.deepEqual([...both].sort(), ['MISSING_READINESS', 'OUT_OF_MARKET']);
  });

  it('a zero-readiness opportunity is held at WATCH however high it scores', () => {
    const a = assessOpportunity({
      opportunity: { demand: 100, fit: 100, intent: 100, timing: 100, readiness: 0 },
      confidence: { sourceQuality: 100, corroboration: 100, coverage: 100, freshness: 100 },
      singleSourceFamily: false,
      autoOptIn: true,
    });
    assert.deepEqual(a.vetoes, ['MISSING_READINESS']);
    assert.equal(a.band, 'WATCH');
  });
});

describe('confidence and corroboration rules (spec §5.5, §17)', () => {
  it('caps a single source family at 69 however strong its other inputs', () => {
    assert.equal(confidenceScore({ sourceQuality: 100, corroboration: 100, coverage: 100, freshness: 100 }, { singleSourceFamily: true }), 69);
  });
  it('scores corroboration 0 / 80 / 100 by independent family count', () => {
    assert.equal(corroborationScore(1), 0);
    assert.equal(corroborationScore(2), 80);
    assert.equal(corroborationScore(3), 100);
    assert.equal(corroborationScore(7), 100);
  });
});

describe('per-source movement maths (spec §5.3, §17)', () => {
  it('computes the log lift', () => {
    assert.ok(close(logLift(0, 0), 0));
    assert.ok(close(logLift(99, 9), Math.log(100 / 10)));
  });
  it('computes a robust anomaly z against a flat history with the 0.2 floor', () => {
    // A flat history has MAD 0, so the floor of 0.2 is the denominator.
    const z = anomalyZ(20, [3, 3, 3, 3, 3, 3]);
    assert.ok(close(z, (Math.log1p(20) - Math.log1p(3)) / 0.2));
    // A spike against its own prior level scores high; the baseline level scores ~0.
    assert.ok(anomalyZ(20, [3, 3, 3, 3]) > 2);
    assert.ok(Math.abs(anomalyZ(3, [3, 3, 3, 3])) < 1e-9);
  });
  it('gates a count feed on both volume and anomaly, and flags thin history', () => {
    assert.equal(clearsCountGate(20, 2), true);
    assert.equal(clearsCountGate(19, 5), false); // volume too low
    assert.equal(clearsCountGate(50, 1.9), false); // anomaly too low
    assert.equal(insufficientHistory([1, 2, 3]), true);
    assert.equal(insufficientHistory([1, 2, 3, 4]), false);
  });
  it('maps the anomaly z to a clamped demand score', () => {
    assert.equal(demandFromZ(0), 50);
    assert.equal(demandFromZ(3), 80);
    assert.equal(demandFromZ(100), 100); // clamped
    assert.equal(demandFromZ(-100), 0); // clamped
  });
  it('median and MAD', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(mad([1, 2, 3, 4, 5]), 1); // median 3; deviations 2,1,0,1,2 → median 1
  });
});

describe('the Growth Brief v1 contract (spec §6, Appendix A)', () => {
  const fixture = {
    schema_version: 1,
    brief_id: 'gb_104',
    brief_version: 3,
    tenant_id: 'tenant_demo',
    platform_id: 'fixture_platform_a',
    market: 'CA',
    locale: 'en-CA',
    topic_id: 'simpler-team-onboarding',
    opportunity_score: 86.25,
    confidence: 83.5,
    valid_from: '2026-11-10T10:00:00Z',
    expires_at: '2026-11-17T10:00:00Z',
    evidence_ids: ['ev_341', 'ev_342'],
    audience: 'Small teams comparing onboarding options',
    intent: 'evaluate how to onboard a small team',
    approved_claim_ids: ['claim_onboarding_01'],
    cta_id: 'cta_view_onboarding_guide',
    allowed_channels: ['seo', 'organic_social'],
    prohibited_claims: ['guaranteed onboarding time', 'unsupported third-party endorsements'],
    objective: 'qualified trial starts per eligible session',
    experiment_id: 'exp_91',
    policy_version: 5,
  };

  it('accepts the canonical §6 fixture', () => {
    const brief = validateGrowthBrief(fixture);
    assert.equal(brief.brief_id, 'gb_104');
    assert.equal(brief.market, 'CA');
    assert.deepEqual(brief.allowed_channels, ['seo', 'organic_social']);
    assert.equal(brief.experiment_id, 'exp_91');
  });

  it('is a closed object — an unknown field is refused', () => {
    assert.throws(
      () => validateGrowthBrief({ ...fixture, publish_now: true }),
      (e) => (e as { code?: string }).code === 'BRIEF_INVALID',
    );
  });

  it('refuses a malformed market, an unknown channel, a reversed window and a wrong schema version', () => {
    assert.throws(() => validateGrowthBrief({ ...fixture, market: 'Canada' }), (e) => (e as { code?: string }).code === 'BRIEF_INVALID');
    assert.throws(() => validateGrowthBrief({ ...fixture, allowed_channels: ['seo', 'tiktok'] }), (e) => (e as { code?: string }).code === 'BRIEF_INVALID');
    assert.throws(() => validateGrowthBrief({ ...fixture, expires_at: '2026-11-03T10:00:00Z' }), (e) => (e as { code?: string }).code === 'BRIEF_INVALID');
    assert.throws(() => validateGrowthBrief({ ...fixture, schema_version: 2 }), (e) => (e as { code?: string }).code === 'BRIEF_INVALID');
    assert.throws(() => validateGrowthBrief({ ...fixture, opportunity_score: 140 }), (e) => (e as { code?: string }).code === 'BRIEF_INVALID');
  });

  it('allows ZZ for a global brief and a bare two-letter locale', () => {
    const brief = validateGrowthBrief({ ...fixture, market: 'ZZ', locale: 'en' });
    assert.equal(brief.market, 'ZZ');
    assert.equal(brief.locale, 'en');
  });

  it('checks whether a brief is in force against the clock', () => {
    assert.equal(briefInForce(fixture, '2026-11-12T00:00:00Z'), true);
    assert.equal(briefInForce(fixture, '2026-11-20T00:00:00Z'), false); // expired
    assert.equal(briefInForce(fixture, '2026-11-09T00:00:00Z'), false); // not yet valid
  });
});
