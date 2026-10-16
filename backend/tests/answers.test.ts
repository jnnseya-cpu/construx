import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as answers from '../src/domain/answers.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The answer library.
 *
 * The qualitative half of a public bid carries 40–60% of the score, and the
 * answers that earned it are thrown away after every submission. The next bid
 * writes the same social-value commitment from nothing, and nobody can say
 * which version of it scored.
 *
 * What is worth asserting here is not that an answer round-trips. It is the
 * refusals, because each one is a way the library could become the thing it was
 * built to replace:
 *
 *   - **it does not paste.** No function in the module writes a library answer
 *     into a bid section, and no route offers to. An answer pasted unchanged
 *     into forty bids is boilerplate, a buyer reading their fourth identical
 *     submission marks it as such, and the library converges on a permanent
 *     3/5 — which is the failure it exists to fix.
 *   - **one person is not both ends.** What sits in the library is what this
 *     business claims on every bid that takes it.
 *   - **a draft is offered to nobody.**
 *   - **nothing is overwritten.** The version a buyer read is a promise that
 *     was made, and it stays readable after somebody improves it.
 *   - **a new version has not earned the old one's marks.**
 *   - **no median is invented.** Most buyers disclose no mark, and the library
 *     says so rather than reporting a number built from the ones that did.
 */

let platform: Platform;
let seed: SeedResult;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Holds ESTIMATE_TENDER C — captures and revises. */
const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds ESTIMATE_TENDER A — approves and retires. A different person, which is the point. */
const asOwner = () => platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const BODY = [
  'We employ and train locally. On every scheme over £1m we take two apprentices through a level 3 NVQ with the',
  'college nearest the site, and we report starts and completions to the client quarterly rather than at handover,',
  'so an apprenticeship that is not happening is visible while there is still time to fix it.',
];

const capture = (overrides: Partial<Parameters<typeof answers.captureAnswer>[1]> = {}) =>
  answers.captureAnswer(asQS(), {
    title: 'Social value: local labour and apprenticeships',
    category: 'SOCIAL_VALUE',
    body: BODY,
    ...overrides,
  });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the library is wired into the platform it belongs to', () => {
  it('routes every act, classifies the entity, and lets no agent author one', () => {
    for (const [method, pattern] of [
      ['POST', '/v1/pipeline/answers'],
      ['POST', '/v1/pipeline/answers/:answerId/approve'],
      ['POST', '/v1/pipeline/answers/:answerId/revise'],
      ['POST', '/v1/pipeline/answers/:answerId/retire'],
      ['POST', '/v1/pipeline/answers/:answerId/used'],
      ['GET', '/v1/pipeline/answers'],
      ['GET', '/v1/pipeline/answers/offer/:category'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    // An answer is authored beside the submission it goes into, and it is
    // commercially sensitive: it is this company's own method, priced into a
    // bid, readable by whoever can read the bid and nobody else.
    assert.equal(classifyEntity('BidAnswer')?.area, 'ESTIMATE_TENDER');
    assert.equal(classifyEntity('BidAnswer')?.sensitivity, 'COMMERCIAL_L3');

    // Every one is a human act. An agent may draft prose into a bid section —
    // that is already built and metered — but what this business permanently
    // claims about itself is not something an agent commits to on its behalf.
    for (const type of [
      'BID_ANSWER_CAPTURED',
      'BID_ANSWER_APPROVED',
      'BID_ANSWER_REVISED',
      'BID_ANSWER_RETIRED',
      'BID_ANSWER_USED',
    ]) {
      assert.equal(lookupEventType(type)?.aiAllowed, false, `${type} is open to an agent`);
    }
  });

  it('offers no way to paste an answer into a bid, anywhere', () => {
    /*
     * The assertion the whole module exists for, made against the source
     * rather than against behaviour — because what is being asserted is an
     * absence, and an absence cannot be exercised.
     *
     * Two things are checked. No route mentions the library in a path that
     * writes a section, and no name in the module suggests one. If somebody
     * later adds `applyAnswerToSection`, this fails and they have to argue for
     * it in a review rather than discover it in a buyer's scoring sheet.
     */
    const source = readFileSync(join(REPO_ROOT, 'backend', 'src', 'domain', 'answers.ts'), 'utf8');

    for (const forbidden of [/\bapply\w*Answer/i, /\bpasteAnswer/i, /\binsertAnswer/i, /\bfillSection/i]) {
      assert.ok(!forbidden.test(source), `answers.ts has grown a paste: ${forbidden}`);
    }

    // And nothing in the module writes a bid section's state. The library has
    // one entity and it is its own.
    assert.ok(
      !/refType:\s*'BidResponsePack'/.test(source),
      'the answer library has started writing to the bid response pack',
    );

    const writes = ROUTES.filter(
      (route) => route.method !== 'GET' && /answers/.test(route.pattern) && /section/i.test(route.pattern),
    );
    assert.deepEqual(writes, [], 'a route now writes a library answer into a section');
  });
});

describe('what the library refuses', () => {
  it('refuses a stub nobody would ever open', () => {
    const error = throwsCode(
      () => capture({ body: ['We take social value seriously.'] }),
      'ANSWER_TOO_SHORT',
    );
    assert.match(String(error.message), /at least 25 words/);

    throwsCode(() => capture({ title: 'SV' }), 'ANSWER_TITLE_TOO_SHORT');
  });

  it('refuses to let the person who captured an answer approve it', () => {
    const answer = capture();
    const error = throwsCode(
      () => answers.approveAnswer(asQS(), answer.id, { note: 'Checked it against the 2026 return' }),
      'ANSWER_SELF_APPROVAL',
    );
    assert.match(String(error.message), /cannot approve it for reuse/);

    // The second person can, and the record says who and what they checked.
    const approved = answers.approveAnswer(asOwner(), answer.id, {
      note: 'Apprenticeship figures reconciled to the 2026 training return',
    });
    assert.equal(approved.status, 'APPROVED');
    assert.notEqual(approved.approvedBy, approved.capturedBy);
    assert.equal(approved.version, 1);
  });

  it('refuses a signature on nothing', () => {
    const answer = capture();
    throwsCode(() => answers.approveAnswer(asOwner(), answer.id, { note: 'ok' }), 'ANSWER_NOTE_TOO_SHORT');
  });

  it('offers a draft to nobody', () => {
    const answer = capture({ title: 'Quality: ITP and hold points', category: 'QUALITY' });

    const offer = answers.offerAnswers(asQS(), 'QUALITY');
    assert.ok(
      !offer.candidates.some((candidate) => candidate.id === answer.id),
      'a draft was offered before anybody approved it',
    );

    // And it is visible in the register, because the register is what somebody
    // reads to find out there is an answer waiting for them.
    const library = answers.answerLibrary(asQS());
    assert.ok(library.answers.some((row) => row.id === answer.id));
    assert.ok(
      library.limits.some((line) => /not approved/.test(line)),
      'the library did not say that something is waiting for approval',
    );
  });

  it('says on every offer that it is a starting point rather than a section', () => {
    const answer = capture({ title: 'Programme: sequencing and float', category: 'PROGRAMME' });
    answers.approveAnswer(asOwner(), answer.id, { note: 'Sequencing matches the last two schemes' });

    const offer = answers.offerAnswers(asQS(), 'PROGRAMME');
    assert.ok(offer.candidates.some((candidate) => candidate.id === answer.id));
    assert.match(offer.note, /not a section/);
    assert.match(offer.note, /fourth identical/);

    // The body comes back — the point is to read it, not to be told it exists.
    const candidate = offer.candidates.find((c) => c.id === answer.id)!;
    assert.deepEqual(candidate.body, BODY);
  });
});

describe('a version is not an edit', () => {
  it('supersedes the old answer rather than overwriting it, and carries no marks forward', () => {
    const first = capture({ title: 'Environmental: carbon on site', category: 'ENVIRONMENTAL' });
    answers.approveAnswer(asOwner(), first.id, { note: 'Figures match the 2026 carbon statement' });
    answers.recordAnswerUse(asQS(), first.id, { packId: 'pack-1', sectionKey: 'R-07', scorePercent: 88 });

    const second = answers.reviseAnswer(asQS(), first.id, {
      body: [...BODY, 'We now report scope 3 against the 2026 baseline rather than the 2024 one.'],
      reason: 'The 2024 baseline was superseded by the 2026 statement',
    });

    assert.equal(second.version, 2);
    assert.equal(second.supersedes, first.id);
    assert.equal(second.status, 'DRAFT', 'a revision went live without its own approval');
    assert.deepEqual(second.uses, [], 'the new version inherited marks it has not earned');
    assert.equal(second.category, first.category, 'a revision changed the category it is filed under');

    // The version a buyer read is still on the record, with its use and its
    // mark, and it is no longer offered.
    const register = answers.answerLibrary(asQS());
    const old = register.answers.find((row) => row.id === first.id)!;
    assert.equal(old.status, 'SUPERSEDED');
    assert.equal(old.supersededBy, second.id);
    assert.equal(old.useCount, 1);
    assert.equal(old.medianScorePercent, 88);

    const offer = answers.offerAnswers(asQS(), 'ENVIRONMENTAL');
    assert.ok(!offer.candidates.some((c) => c.id === first.id), 'a superseded answer is still being offered');
    assert.ok(!offer.candidates.some((c) => c.id === second.id), 'an unapproved revision is being offered');

    // Revising the superseded one is refused, and the refusal names what to
    // revise instead rather than leaving somebody to find it.
    const error = throwsCode(
      () => answers.reviseAnswer(asQS(), first.id, { body: BODY, reason: 'Trying the old one again' }),
      'ANSWER_ALREADY_SUPERSEDED',
    );
    assert.match(String(error.message), /Revise that one/);
  });

  it('refuses a revision nobody explained', () => {
    const answer = capture({ title: 'Insurance: cover and excess', category: 'INSURANCE' });
    throwsCode(
      () => answers.reviseAnswer(asQS(), answer.id, { body: BODY, reason: 'better' }),
      'ANSWER_REASON_TOO_SHORT',
    );
  });
});

describe('the record of what went out', () => {
  it('refuses a use of an answer nobody approved', () => {
    const answer = capture({ title: 'Health and safety: RAMS regime', category: 'HEALTH_AND_SAFETY' });
    const error = throwsCode(
      () => answers.recordAnswerUse(asQS(), answer.id, { packId: 'pack-2', sectionKey: 'R-11' }),
      'ANSWER_NOT_APPROVED',
    );
    assert.match(String(error.message), /should not have gone out on a bid/);
  });

  it('reports no median where no buyer disclosed a mark, rather than inventing one', () => {
    const answer = capture({ title: 'Technical: temporary works approach', category: 'TECHNICAL' });
    answers.approveAnswer(asOwner(), answer.id, { note: 'Approach matches the TWC design we hold' });
    answers.recordAnswerUse(asQS(), answer.id, { packId: 'pack-3', sectionKey: 'R-02' });
    answers.recordAnswerUse(asQS(), answer.id, { packId: 'pack-4', sectionKey: 'R-03' });

    const row = answers.answerLibrary(asQS()).answers.find((entry) => entry.id === answer.id)!;
    assert.equal(row.useCount, 2);
    assert.equal(row.medianScorePercent, null, 'a median appeared out of two undisclosed marks');

    const library = answers.answerLibrary(asQS());
    assert.ok(
      library.limits.some((line) => /no disclosed mark/.test(line)),
      'the library did not say that nothing can be concluded about how those uses scored',
    );
  });

  it('takes the median of the marks that were disclosed', () => {
    const answer = capture({ title: 'Commercial: change control approach', category: 'COMMERCIAL' });
    answers.approveAnswer(asOwner(), answer.id, { note: 'Matches the NEC4 change procedure we run' });
    for (const score of [60, 80, 100]) {
      answers.recordAnswerUse(asQS(), answer.id, { packId: `pack-${score}`, sectionKey: 'R-04', scorePercent: score });
    }

    const row = answers.answerLibrary(asQS()).answers.find((entry) => entry.id === answer.id)!;
    assert.equal(row.medianScorePercent, 80);

    throwsCode(
      () => answers.recordAnswerUse(asQS(), answer.id, { packId: 'pack-x', sectionKey: 'R-05', scorePercent: 140 }),
      'ANSWER_SCORE_RANGE',
    );
  });

  it('sorts the offer by what has actually scored', () => {
    // The reason the uses are recorded at all. An answer that has scored 90
    // twice and one nobody has ever sent are not equally good starting points,
    // and the order is the only place that judgement is expressed — the library
    // does not choose for anybody.
    const weak = capture({ title: 'Qualification: turnover and accounts', category: 'QUALIFICATION' });
    answers.approveAnswer(asOwner(), weak.id, { note: 'Figures agree with the filed accounts' });
    answers.recordAnswerUse(asQS(), weak.id, { packId: 'pack-w', sectionKey: 'R-01', scorePercent: 40 });

    const strong = capture({ title: 'Qualification: financial standing narrative', category: 'QUALIFICATION' });
    answers.approveAnswer(asOwner(), strong.id, { note: 'Reconciled to the 2026 filed accounts' });
    answers.recordAnswerUse(asQS(), strong.id, { packId: 'pack-s', sectionKey: 'R-01', scorePercent: 95 });

    const offer = answers.offerAnswers(asQS(), 'QUALIFICATION');
    assert.equal(offer.candidates[0]?.id, strong.id, 'the better-scoring answer is not offered first');
  });
});

describe('retirement is not deletion', () => {
  it('stops offering it, keeps it readable, and keeps the reason', () => {
    const answer = capture({ title: 'Submission: portal and format compliance', category: 'SUBMISSION' });
    answers.approveAnswer(asOwner(), answer.id, { note: 'Matches the portal requirements we have met' });

    const retired = answers.retireAnswer(asOwner(), answer.id, {
      reason: 'The portal it describes was replaced by the new framework system',
    });
    assert.equal(retired.status, 'RETIRED');
    assert.match(String(retired.retiredReason), /replaced by the new framework system/);

    assert.ok(
      !answers.offerAnswers(asQS(), 'SUBMISSION').candidates.some((c) => c.id === answer.id),
      'a retired answer is still being offered',
    );
    assert.ok(
      answers.answerLibrary(asQS()).answers.some((row) => row.id === answer.id),
      'a retired answer vanished from the register',
    );

    throwsCode(
      () => answers.retireAnswer(asOwner(), answer.id, { reason: 'Retiring it a second time' }),
      'ANSWER_RETIRED',
    );
    throwsCode(
      () => answers.reviseAnswer(asQS(), answer.id, { body: BODY, reason: 'Reviving a retired answer' }),
      'ANSWER_RETIRED',
    );
  });
});

describe('the library belongs to one tenancy', () => {
  it('does not answer across a tenancy boundary', async () => {
    // A competitor's social-value answer is precisely the thing nobody may
    // read. The platform's own isolation does this; the assertion is that the
    // library goes through it rather than around it.
    const other = new Platform();
    const otherSeed = await seedDemoProject(other);
    const mine = capture({ title: 'Technical: piling and ground risk', category: 'TECHNICAL' });

    const theirs = other.context(otherSeed.users.qs!.auth, `${otherSeed.tenantId}-governance`, { source: 'WEB' });
    assert.ok(
      !answers.answerLibrary(theirs).answers.some((row) => row.id === mine.id),
      'one tenancy can read another tenancy’s answers',
    );
  });
});
