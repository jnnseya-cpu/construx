import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import * as itt from '../src/domain/itt.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The limit the buyer stated, and what happens past it.
 *
 * The platform already read page limits off an invitation and recorded them on
 * the deliverable, where nothing checked them — which is the failure that
 * type's own comment describes: *"conflating them is why the page limit is
 * discovered on the last afternoon."* It was discovered on the last afternoon
 * by whoever was pasting sections into the template.
 *
 * A stated word limit is not a style note. The standard instruction is that
 * anything past it is not read, so a 1,300-word answer to a 1,000-word question
 * is not marked down by 30% — it is marked on 1,000 words that now end
 * mid-argument, and on a pass/fail question that is the bid.
 *
 * Four properties:
 *
 *   - **a word limit is checked exactly, and refuses the issue.** Same class of
 *     gate as a missing mandatory response, for the same reason.
 *   - **a page limit is carried and reported and never enforced.** Words per
 *     page depends on a template this platform does not hold, and a limit
 *     enforced against an invented conversion would refuse a submission that
 *     fits. Recorded in `docs/STATE.md` as not built rather than approximated.
 *   - **the gate has a way forward.** `shortenSection` rewrites one section to
 *     fit; a gate with nothing on the screen that can clear it is a dead end on
 *     the return date, and a dead end is how somebody decides to go round it.
 *   - **a failed cut saves nothing.** The section is left exactly as it was.
 */

let platform: Platform;
let seed: SeedResult;

const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/** Prose of an exact length, so the boundary can be asserted rather than approached. */
const wordsOfLength = (count: number): string[] => [Array.from({ length: count }, (_, i) => `w${i}`).join(' ')];

const REQUIREMENTS: Parameters<typeof itt.analyseITT>[1]['requirements'] = [
  {
    reference: 'L-01',
    category: 'SOCIAL_VALUE',
    requirement: 'Set out the local employment and apprenticeship commitments you will make',
    mandatory: true,
    weightingPercent: 20,
    evidenceRequired: 'Narrative with measurable commitments',
    responseLimit: { words: 100, statedAs: 'Maximum 100 words per social value question' },
  },
  {
    reference: 'L-02',
    category: 'TECHNICAL',
    requirement: 'Describe your methodology for deep drainage in live carriageway',
    mandatory: true,
    weightingPercent: 30,
    evidenceRequired: 'Method statement',
    responseLimit: { pages: 4, statedAs: 'Method statement, maximum four sides of A4' },
  },
  {
    reference: 'L-03',
    category: 'QUALITY',
    requirement: 'Describe the inspection and test regime you will operate',
    mandatory: false,
    weightingPercent: 10,
    evidenceRequired: 'ITP and hold points',
  },
];

/** Puts a pack into a hand-drafted state, which is how a bid writer leaves it. */
const draft = (pack: bidresponse.BidResponsePack, bodies: Record<string, string[]>): void => {
  const drafted = {
    ...pack,
    sections: pack.sections.map((section) =>
      bodies[section.key]
        ? {
            ...section,
            status: 'DRAFTED' as const,
            body: bodies[section.key]!,
            words: bodies[section.key]!.join(' ').split(/\s+/).filter(Boolean).length,
            authorship: 'HUMAN' as const,
          }
        : section,
    ),
  };
  platform.ledger.commit({
    tenantId: seed.tenantId,
    projectId: pack.projectId,
    actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
    source: 'WEB',
    correlationId: pack.id,
    eventType: 'BID_RESPONSE_SECTION_WRITTEN',
    entity: { refType: 'BidResponsePack', refId: pack.id },
    nextState: drafted as unknown as Record<string, unknown>,
  });
};

let packId: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const analysis = itt.analyseITT(asQS(), {
    reference: 'ITT-LIMIT-01',
    clientName: 'Calderdale Metropolitan Borough Council',
    returnBy: '2027-03-01',
    estimatedValueMinor: 480_000_000,
    durationWeeks: 96,
    requirements: REQUIREMENTS,
    terms: { contractForm: 'NEC4 Option A' },
  });

  // The limit survives the analysis, which is the only reason the pack can
  // inherit it. A matrix that dropped it would leave the check reading nothing.
  const line = analysis.matrix.find((entry) => entry.reference === 'L-01')!;
  assert.deepEqual(line.responseLimit, { words: 100, statedAs: 'Maximum 100 words per social value question' });

  packId = bidresponse.planBidResponse(asQS(), { analysisId: analysis.analysisId }).pack.id;
});

describe('the limit reaches the section that has to respect it', () => {
  it('is routed, and planned onto the section from the matrix line', () => {
    assert.ok(
      ROUTES.some(
        (route) =>
          route.method === 'POST' &&
          route.pattern === '/v1/projects/:projectId/bid-responses/:packId/sections/:key/shorten',
      ),
      'there is no door that cuts a section to length, so the issue gate is a dead end',
    );

    const pack = bidresponse.bidResponsePack(asQS(), packId);
    const byKey = new Map(pack.sections.map((section) => [section.key, section]));

    assert.equal(byKey.get('L-01')?.limit?.words, 100);
    assert.equal(byKey.get('L-02')?.limit?.pages, 4);
    assert.equal(byKey.get('L-02')?.limit?.words, undefined, 'a page limit was converted into a word count');
    assert.equal(byKey.get('L-03')?.limit, undefined, 'a limit appeared where the buyer stated none');
  });
});

describe('a word limit is a gate', () => {
  it('passes a section at the limit and refuses one word past it', () => {
    const pack = bidresponse.bidResponsePack(asQS(), packId);

    // Exactly at the limit. The buyer said "maximum 100", so 100 is within it
    // and an off-by-one here refuses a submission that complies.
    draft(pack, { 'L-01': wordsOfLength(100), 'L-02': wordsOfLength(900), 'L-03': wordsOfLength(50) });
    const at = bidresponse.bidResponsePack(asQS(), packId);
    assert.deepEqual(at.completeness.overLimit, [], 'a section exactly at the limit was refused');

    draft(at, { 'L-01': wordsOfLength(101) });
    const over = bidresponse.bidResponsePack(asQS(), packId);
    assert.equal(over.completeness.overLimit.length, 1);

    const entry = over.completeness.overLimit[0]!;
    assert.equal(entry.key, 'L-01');
    assert.equal(entry.words, 101);
    assert.equal(entry.limitWords, 100);
    assert.equal(entry.overBy, 1);
    assert.equal(entry.mandatory, true);
    // The buyer's own wording, so a disputed limit is settled by quotation.
    assert.match(entry.statedAs, /Maximum 100 words/);

    assert.equal(over.completeness.ready, false, 'a pack over a stated limit reported itself ready to issue');
    assert.match(over.completeness.summary, /longer than the buyer allows/);
  });

  it('refuses the issue, and the refusal says what to do rather than only that it is wrong', () => {
    const error = throwsCode(() => bidresponse.issueBidResponse(asQS(), { packId }), 'BID_RESPONSE_INCOMPLETE');
    const message = String(error.message);

    assert.match(message, /L-01 is 101 words against 100/);
    assert.match(message, /Maximum 100 words/);
    assert.match(message, /not read/, 'the refusal does not say why the extra words matter');
    assert.match(message, /Cut it to length/);
  });

  it('counts the prose rather than trusting the number stored beside it', () => {
    /*
     * The stored `words` is written by whichever pass last touched the section.
     * A check that trusted it would be checking a record rather than an answer,
     * and the record is the thing a hand edit gets wrong. So: a section whose
     * stored count claims to fit, with 400 words of prose in it.
     */
    const pack = bidresponse.bidResponsePack(asQS(), packId);
    const lying = {
      ...pack,
      sections: pack.sections.map((section) =>
        section.key === 'L-01'
          ? { ...section, status: 'DRAFTED' as const, body: wordsOfLength(400), words: 40 }
          : section,
      ),
    };
    platform.ledger.commit({
      tenantId: seed.tenantId,
      projectId: pack.projectId,
      actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
      source: 'WEB',
      correlationId: pack.id,
      eventType: 'BID_RESPONSE_SECTION_WRITTEN',
      entity: { refType: 'BidResponsePack', refId: pack.id },
      nextState: lying as unknown as Record<string, unknown>,
    });

    const checked = bidresponse.bidResponsePack(asQS(), packId);
    assert.equal(checked.completeness.overLimit[0]?.words, 400, 'the gate believed the stored count');
  });
});

describe('a page limit is reported and never enforced', () => {
  it('names it, says nothing checked it, and lets the pack through', () => {
    const pack = bidresponse.bidResponsePack(asQS(), packId);

    // 900 words against four sides. Whether that fits depends on a template
    // this platform does not hold, so it is not the platform's call.
    const paged = pack.completeness.pageLimited.find((entry) => entry.key === 'L-02');
    assert.ok(paged, 'a stated page limit vanished instead of reaching whoever lays the pack out');
    assert.equal(paged.pages, 4);
    assert.equal(paged.words, 900);
    assert.match(paged.statedAs, /four sides/);

    assert.ok(
      !pack.completeness.overLimit.some((entry) => entry.key === 'L-02'),
      'a page limit was enforced against a word count nobody could derive it from',
    );
  });
});

describe('the gate has a way forward', () => {
  it('refuses to cut a section the buyer did not constrain', async () => {
    await assert.rejects(
      () => bidresponse.shortenSection(asQS(), { packId, key: 'L-03' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_SECTION_NO_LIMIT');
        assert.match(error.message, /editorial decision, not a check/);
        return true;
      },
    );

    // A page limit is not something to cut to either, because the cut would be
    // to a word count nobody could derive the page limit from.
    await assert.rejects(
      () => bidresponse.shortenSection(asQS(), { packId, key: 'L-02' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_SECTION_NO_LIMIT');
        return true;
      },
    );
  });

  it('refuses to cut one that already fits', async () => {
    // Spending a customer's AI budget to throw away an answer that scores.
    draft(bidresponse.bidResponsePack(asQS(), packId), { 'L-01': wordsOfLength(50) });
    await assert.rejects(
      () => bidresponse.shortenSection(asQS(), { packId, key: 'L-01' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_SECTION_WITHIN_LIMIT');
        assert.match(error.message, /already fits/);
        return true;
      },
    );
    // Back over the limit, for the refusals that follow.
    draft(bidresponse.bidResponsePack(asQS(), packId), { 'L-01': wordsOfLength(400) });
  });

  it('refuses a section that does not exist, in the pack it was asked about', async () => {
    await assert.rejects(
      () => bidresponse.shortenSection(asQS(), { packId, key: 'L-99' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_SECTION_NOT_FOUND');
        return true;
      },
    );
  });

  it('will not cut on the local stand-in, and changes nothing when it refuses', async () => {
    // Deciding what an answer can lose is the work. An adapter that reasons
    // about nothing cannot do it, and a cut it produced would be prose sent to
    // a buyer under the company's name — the same refusal drafting makes, for
    // the same reason. This deployment runs the stand-in in tests.
    const before_ = bidresponse.bidResponsePack(asQS(), packId);

    await assert.rejects(
      () => bidresponse.shortenSection(asQS(), { packId, key: 'L-01' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'NO_REASONING_PROVIDER');
        return true;
      },
    );

    const after = bidresponse.bidResponsePack(asQS(), packId);
    assert.equal(after.passes, before_.passes, 'a refused cut was counted as a pass');
    assert.deepEqual(
      after.sections.find((section) => section.key === 'L-01')?.body,
      before_.sections.find((section) => section.key === 'L-01')?.body,
      'a refused cut changed the answer',
    );
  });

  it('refuses to cut a pack that has gone to the buyer', async () => {
    const issued = {
      ...bidresponse.bidResponsePack(asQS(), packId),
      status: 'ISSUED' as const,
      issuedAt: new Date().toISOString(),
      issuedBy: seed.users.qs!.auth.actorId,
    };
    platform.ledger.commit({
      tenantId: seed.tenantId,
      projectId: issued.projectId,
      actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
      source: 'WEB',
      correlationId: issued.id,
      eventType: 'BID_RESPONSE_ISSUED',
      entity: { refType: 'BidResponsePack', refId: issued.id },
      nextState: issued as unknown as Record<string, unknown>,
    });

    await assert.rejects(
      () => bidresponse.shortenSection(asQS(), { packId, key: 'L-01' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_RESPONSE_ISSUED');
        return true;
      },
    );
  });
});

describe('a waiver is not a way through the gate', () => {
  it('still checks a written section whose requirement was waived afterwards', () => {
    /*
     * `unanswered` excludes a waived requirement, and it should: nobody is
     * writing it. The length check does not, and that is the distinction.
     * Prose already written is still in the pack, still counted in `written`,
     * and still read by the buyer — so a waiver granted over it cannot be the
     * thing that carries an over-length answer through.
     */
    const analysis = itt.analyseITT(asQS(), {
      reference: 'ITT-LIMIT-02',
      clientName: 'A client',
      returnBy: '2027-04-01',
      estimatedValueMinor: 120_000_000,
      durationWeeks: 40,
      requirements: [REQUIREMENTS[0]!, REQUIREMENTS[2]!],
      terms: { contractForm: 'NEC4 Option A' },
    });
    const pack = bidresponse.planBidResponse(asQS(), { analysisId: analysis.analysisId }).pack;
    draft(pack, { 'L-01': wordsOfLength(400), 'L-03': wordsOfLength(50) });

    assert.equal(bidresponse.bidResponsePack(asQS(), pack.id).completeness.overLimit.length, 1);

    itt.waiveRequirement(asQS(), analysis.analysisId, {
      reference: 'L-01',
      reason: 'The social value question was withdrawn by addendum and is not being answered',
      expiresOn: '2027-04-01',
    });

    const waived = bidresponse.bidResponsePack(asQS(), pack.id);
    assert.equal(
      waived.completeness.overLimit.length,
      1,
      'a waiver over an already-written section let an over-length answer through the gate',
    );
    assert.equal(waived.completeness.ready, false);
  });

  it('does not refuse on a waived requirement nobody wrote', () => {
    const analysis = itt.analyseITT(asQS(), {
      reference: 'ITT-LIMIT-03',
      clientName: 'A client',
      returnBy: '2027-05-01',
      estimatedValueMinor: 90_000_000,
      durationWeeks: 30,
      requirements: [REQUIREMENTS[0]!, REQUIREMENTS[2]!],
      terms: { contractForm: 'NEC4 Option A' },
    });
    const pack = bidresponse.planBidResponse(asQS(), { analysisId: analysis.analysisId }).pack;
    draft(pack, { 'L-03': wordsOfLength(50) });

    itt.waiveRequirement(asQS(), analysis.analysisId, {
      reference: 'L-01',
      reason: 'The social value question was withdrawn by addendum and is not being answered',
      expiresOn: '2027-05-01',
    });

    const waived = bidresponse.bidResponsePack(asQS(), pack.id);
    assert.deepEqual(waived.completeness.overLimit, []);
    assert.deepEqual(waived.completeness.unanswered, [], 'a waived requirement is being reported as outstanding');
    assert.ok(
      waived.completeness.waived.some((entry) => entry.key === 'L-01'),
      'the waiver is not being reported to whoever signs the submission',
    );
  });
});
