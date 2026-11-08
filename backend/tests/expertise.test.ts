import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DISCIPLINES,
  RIBA_STAGE_NUMBERS,
  expertBriefing,
  expertRole,
  ribaStage,
  stageBriefing,
} from '../src/ai/expertise.ts';

/**
 * The construction-expertise framing shared by the AI engines. What matters is
 * that every discipline is a real professional working to real UK standards, and
 * that the discipline which separates a professional from a plausible guess —
 * reason from the documents, quote the basis, never invent, propose not decide —
 * is in every briefing.
 */

describe('construction expertise framing', () => {
  it('names a real professional and real standards for every discipline', () => {
    assert.ok(DISCIPLINES.length >= 8, 'the core construction disciplines are covered');
    for (const discipline of DISCIPLINES) {
      const role = expertRole(discipline);
      assert.ok(role.title.length > 10, `${discipline} names a professional`);
      assert.ok(role.judgement.length > 20, `${discipline} states the judgement it brings`);
      assert.ok(role.standards.length >= 2, `${discipline} works to at least two real standards`);
    }
  });

  it('carries the no-fabrication, propose-not-decide discipline in every briefing', () => {
    for (const discipline of DISCIPLINES) {
      const briefing = expertBriefing(discipline);
      assert.ok(/only from the documents/i.test(briefing), `${discipline}: reasons only from the documents`);
      assert.ok(/quote the exact passage/i.test(briefing), `${discipline}: quotes its basis`);
      assert.ok(/never\s+invent/i.test(briefing), `${discipline}: never invents`);
      assert.ok(/propose|decides/i.test(briefing), `${discipline}: proposes, a person decides`);
      // The named professional appears in the opening.
      assert.ok(briefing.startsWith('You are a '), `${discipline}: opens as the professional`);
    }
  });

  it('frames each discipline with the standards that profession actually works to', () => {
    assert.match(expertBriefing('HEALTH_AND_SAFETY'), /CDM 2015/);
    assert.match(expertBriefing('QUANTITY_SURVEYOR'), /NRM/);
    assert.match(expertBriefing('PLANNER'), /critical-path/i);
    assert.match(expertBriefing('COMMISSIONING'), /Code M/);
    assert.match(expertBriefing('SITE_MANAGER'), /BS 5975|temporary works/i);
    assert.match(expertBriefing('BID_MANAGER'), /Procurement Act 2023/);
  });
});

/**
 * The lifecycle framing: the same reasoning must be able to stand at any point
 * from strategic definition to use, not only at tender. Every RIBA stage names a
 * real stage, carries the canonical stage outcome, says what an experienced
 * contractor's team actually does there, and flags the judgement call that
 * decides whether the stage goes well.
 */
describe('RIBA lifecycle framing', () => {
  it('covers every stage 0 to 7 with a named stage, outcome, focus and watch-for', () => {
    assert.deepEqual(RIBA_STAGE_NUMBERS, [0, 1, 2, 3, 4, 5, 6, 7]);
    for (const stage of RIBA_STAGE_NUMBERS) {
      const meta = ribaStage(stage);
      assert.ok(meta.name.length >= 3, `stage ${stage} is named`);
      assert.ok(meta.outcome.length > 20, `stage ${stage} states its outcome`);
      assert.ok(meta.contractorFocus.length > 40, `stage ${stage} says what the contractor's team does`);
      assert.ok(meta.watchFor.length > 20, `stage ${stage} flags the judgement call`);
    }
  });

  it('names the canonical RIBA 2020 stages', () => {
    assert.match(ribaStage(0).name, /Strategic Definition/i);
    assert.match(ribaStage(2).name, /Concept Design/i);
    assert.match(ribaStage(5).name, /Manufacturing and Construction/i);
    assert.match(ribaStage(6).name, /Handover/i);
    assert.match(ribaStage(7).name, /Use/i);
  });

  it('writes a stage briefing that names the stage, its outcome and the contractor focus', () => {
    const briefing = stageBriefing(5);
    assert.match(briefing, /RIBA Stage 5/);
    assert.match(briefing, /Manufacturing and Construction/);
    assert.match(briefing, /practical completion/i);
    assert.match(briefing, /Watch for:/);
  });

  it('composes a discipline with a stage so the professional and the stage context are both present', () => {
    const briefing = expertBriefing('SITE_MANAGER', { stage: 5 });
    // The named professional still opens the briefing.
    assert.ok(briefing.startsWith('You are a '), 'opens as the professional');
    assert.match(briefing, /site manager/i);
    // The stage context is woven in.
    assert.match(briefing, /RIBA Stage 5/);
    assert.match(briefing, /Manufacturing and Construction/);
    // The honesty discipline is still carried.
    assert.match(briefing, /never\s+invent/i);
    assert.match(briefing, /propose/i);
  });

  it('omits stage context when no stage is given, so tender-time reasoning is unchanged', () => {
    const briefing = expertBriefing('BID_MANAGER');
    assert.doesNotMatch(briefing, /RIBA Stage/);
  });
});
