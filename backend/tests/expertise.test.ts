import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DISCIPLINES, expertBriefing, expertRole } from '../src/ai/expertise.ts';

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
