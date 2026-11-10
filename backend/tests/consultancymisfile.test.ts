import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessPlacement, extractReferences, identityTokens } from '../src/domain/consultancy/misfile.ts';

/**
 * The misfile guard stops a document going into the wrong project. These prove the
 * deterministic rules: a document that clearly matches another engagement, or cites
 * a foreign reference, is a CONFLICT (blocked); a document with no tie to the
 * engagement is a REVIEW (warned); a consistent one is OK; and the guard never
 * raises a false CONFLICT on a weak signal.
 */

// Realistic identities for the live tenders in play. As targets they carry no
// reference (an engagement's internal id never appears in a client brief); as
// candidates a reference is added to label where a document belongs.
const NLC = { client: 'North Lincolnshire Council', authority: 'North Lincolnshire Council', assetOrService: 'Doncaster–Scunthorpe rail service', location: 'North Lincolnshire' };
const SYMCA = { client: 'South Yorkshire Mayoral Combined Authority', authority: 'South Yorkshire Mayoral Combined Authority', assetOrService: 'Supertram road-rail vehicles', location: 'Sheffield' };

const NLC_BRIEF =
  'Request for Quotation TM0000000265-1. North Lincolnshire Council invites tenders for a Feasibility Study and Business Case ' +
  'to assess additional rail services between Doncaster and Scunthorpe. The reinstated Doncaster to Scunthorpe service operated ' +
  'by Northern Trains would restore links for communities in North Lincolnshire. Partners include Network Rail and the South ' +
  'Yorkshire Mayoral Combined Authority. The study must be completed by June 2027.';

describe('the misfile guard (identity extraction)', () => {
  it('extracts distinctive identity words and drops generic ones', () => {
    const toks = identityTokens(NLC);
    assert.ok(toks.includes('lincolnshire'));
    assert.ok(toks.includes('doncaster') && toks.includes('scunthorpe'));
    assert.ok(!toks.includes('council'), 'a generic word is not a discriminator');
    assert.ok(!toks.includes('rail'), 'a word common to every rail scheme is not a discriminator');
  });

  it('finds reference codes of several shapes', () => {
    const refs = extractReferences('See ITT TM0000000265-1, framework CA18/5956 and project DN834055 and C-25-040.');
    assert.ok(refs.includes('TM0000000265-1'));
    assert.ok(refs.includes('CA18/5956'));
    assert.ok(refs.includes('DN834055'));
  });
});

describe('the misfile guard (placement verdicts)', () => {
  it('OK — the NLC brief filed against the NLC engagement', () => {
    const a = assessPlacement(NLC, NLC_BRIEF, [SYMCA]);
    assert.equal(a.verdict, 'OK', a.reason);
    assert.ok(a.matchedTokens.includes('lincolnshire'));
  });

  it('CONFLICT — the NLC brief filed against the SYMCA engagement, with NLC present as a candidate', () => {
    const a = assessPlacement(SYMCA, NLC_BRIEF, [{ ...NLC, reference: 'ENG-0001' }]);
    assert.equal(a.verdict, 'CONFLICT', a.reason);
    assert.equal(a.likelyBelongsTo?.reference, 'ENG-0001');
  });

  it('CONFLICT — a document citing a foreign reference when the engagement has its own', () => {
    const target = { reference: 'ITT-900 for the depot works', client: 'Acme', location: 'Leeds' };
    const a = assessPlacement(target, 'This pack concerns tender DN834055 and reference CA18/5956 only.', []);
    assert.equal(a.verdict, 'CONFLICT', a.reason);
    assert.ok(a.foreignReferences.includes('DN834055'));
  });

  it('REVIEW — a substantial document that mentions none of the engagement’s identity', () => {
    const a = assessPlacement(SYMCA, 'This is a long internal memo about catering arrangements and staff parking that names no client, authority, asset or place relevant to the engagement, repeated at length to exceed the length threshold for a substantial document that should be checked before filing.', []);
    assert.equal(a.verdict, 'REVIEW', a.reason);
  });

  it('does not raise a false CONFLICT on a short or weak signal', () => {
    assert.equal(assessPlacement(SYMCA, 'Sheffield Supertram note.', [NLC]).verdict, 'OK');
    assert.equal(assessPlacement(NLC, '', [SYMCA]).verdict, 'OK', 'an empty document is not a conflict');
  });
});
