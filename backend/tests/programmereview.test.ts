import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as programme from '../src/domain/programme.ts';
import * as review from '../src/domain/programmereview.ts';
import * as planning from '../src/engines/planning.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Reviewing the programme.
 *
 * The two things this module exists for, and both are about what a register may
 * not claim: a comment is anchored to the *run* it was made about, and silence
 * from an invited party is never reported as agreement.
 */

async function issued(): Promise<{
  platform: Platform;
  seed: SeedResult;
  projectId: string;
  planner: () => ReturnType<Platform['context']>;
  runId: string;
  activityId: string;
}> {
  const platform = new Platform();
  const seed = await seedDemoProject(platform);
  const projectId = platform.ledger
    .listByTenant(seed.tenantId, 'Project')
    .map((record) => String(record.state.id))
    .find((id) => platform.ledger.list(id, 'Task').length === 0)!;
  const planner = () => platform.context(seed.users.planner!.auth, projectId, { source: 'WEB' });

  const [a, b] = planning.createTasks(planner(), [
    { activityCode: 'A100', name: 'Excavate', workPackageId: 'wp-1', durationDays: 5 },
    { activityCode: 'A200', name: 'Blind and pour', workPackageId: 'wp-1', durationDays: 3 },
  ]);
  planning.linkTasks(planner(), [{ predecessorId: a!, successorId: b!, type: 'FS', lag: 0 }]);
  const run = programme.runSchedule(planner(), { dataDate: '2026-06-01' });

  return { platform, seed, projectId, planner, runId: run.runId, activityId: a! };
}

/** A role that can read the programme but not change it — the point of the review. */
const readerOf = (platform: Platform, seed: SeedResult, projectId: string, who: string) => () =>
  platform.context(seed.users[who]!.auth, projectId, { source: 'WEB' });

/**
 * Two invited parties who are not identities on this platform.
 *
 * Deliberately so: an invitation carries the identity id *and* the name, and a
 * party who never signs in can still be recorded as having been asked and
 * having said nothing. What the id must do is match a comment's author, which
 * is the only way anybody is ever recorded as having responded.
 */
const STEEL = { id: 'party-steel', name: 'Tyne Structural Steel' };
const MANDE = { id: 'party-mande', name: 'Coquet M&E' };

// ── A comment is about a version ────────────────────────────────────────────

describe('a comment is anchored to the run it was made about', () => {
  it('opens against a run and records what the programme said at issue', async () => {
    const { planner, runId } = await issued();
    const opened = review.openReview(planner(), {
      runId,
      closesOn: '2026-06-15',
      invited: [STEEL, MANDE],
    });
    assert.equal(opened.runId, runId);
    assert.equal(opened.invited, 2);

    const position = review.reviewPosition(planner(), '2026-06-05');
    assert.equal(position.open?.runId, runId);
    assert.equal(position.open?.finishDateAtIssue, '2026-06-10');
    assert.equal(position.open?.daysRemaining, 10);
    assert.equal(position.open?.supersededByLaterRun, false);
  });

  it('says when the programme has moved on under an open review', async () => {
    // Re-running does not close a review — that would discard every objection
    // made to the version being replaced, which is the version somebody would
    // later want to point at. But the reader has to be told.
    const { planner, runId } = await issued();
    review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    programme.runSchedule(planner(), { dataDate: '2026-06-08' });

    const position = review.reviewPosition(planner(), '2026-06-09');
    assert.equal(position.open?.runId, runId, 'rescheduling moved the review to the new run');
    assert.equal(position.open?.supersededByLaterRun, true);
    assert.match(position.summary, /rescheduled since this went out/);
  });

  it('refuses a second open review', async () => {
    // Two would mean a party commenting on one version while another is being
    // circulated, and neither record would say which they meant.
    const { planner, runId } = await issued();
    review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    throwsCode(
      () => review.openReview(planner(), { runId, closesOn: '2026-06-20', invited: [MANDE] }),
      'REVIEW_ALREADY_OPEN',
    );
  });

  it('refuses a review against a run that does not exist', async () => {
    const { planner } = await issued();
    throwsCode(
      () => review.openReview(planner(), { runId: 'no-such-run', closesOn: '2026-06-15', invited: [STEEL] }),
      'SCHEDULE_RUN_NOT_FOUND',
    );
  });

  it('refuses a review nobody was invited to', async () => {
    // Without an invited list the register cannot tell a party who looked and
    // had no objection from one who never saw it, which is its whole value.
    const { planner, runId } = await issued();
    const error = throwsCode(
      () => review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [] }),
      'REVIEW_NOBODY_INVITED',
    );
    assert.match(String(error.message), /never saw it/);
  });

  it('refuses an invitation with a name and no identity behind it', async () => {
    // The defect this closes was visible only on screen: with invitations held
    // as free text and comments recording an actor id, the two lists were in
    // different vocabularies, so a party who had objected was still reported as
    // having said nothing. A register that reports a false silence is worse
    // than no register.
    const { planner, runId } = await issued();
    const error = throwsCode(
      () =>
        review.openReview(planner(), {
          runId,
          closesOn: '2026-06-15',
          invited: [{ id: '', name: 'Tyne Structural Steel' }],
        }),
      'REVIEW_PARTY_UNIDENTIFIED',
    );
    assert.match(String(error.message), /matched against/);
  });

  it('counts one person once however many times they are named', async () => {
    const { planner, runId } = await issued();
    const opened = review.openReview(planner(), {
      runId,
      closesOn: '2026-06-15',
      invited: [STEEL, { id: STEEL.id, name: 'Tyne Steel Ltd' }, MANDE],
    });
    assert.equal(opened.invited, 2);
  });
});

// ── Silence is not agreement ────────────────────────────────────────────────

describe('what the register may not claim', () => {
  it('keeps objected, reviewed-without-objection and did-not-respond apart', async () => {
    const { platform, seed, projectId, planner, runId } = await issued();
    review.openReview(planner(), {
      runId,
      closesOn: '2026-06-15',
      invited: [{ id: seed.users.constructionManager!.id, name: 'Ade Fowler' }, STEEL, MANDE],
    });

    const cm = readerOf(platform, seed, projectId, 'constructionManager');
    review.comment(cm(), {
      reviewId: review.reviewPosition(cm()).open!.reviewId,
      kind: 'ACCESS',
      body: 'The east compound is not handed over until week 6, so the excavation cannot start when shown.',
    });

    const position = review.reviewPosition(planner(), '2026-06-05');
    // Matched on the identity id — the reason an invitation carries one. Named
    // from the invitation, so the register reads as people rather than ULIDs.
    assert.deepEqual(position.participation.objected, [
      { id: seed.users.constructionManager!.id, name: 'Ade Fowler' },
    ]);
    assert.deepEqual(
      position.participation.didNotRespond.map((party) => party.name).sort(),
      ['Coquet M&E', 'Tyne Structural Steel'],
    );
    assert.equal(position.open!.invitedCount, 3);
    assert.equal(position.comments[0]!.raisedByName, 'Ade Fowler');
    // Nobody is placed in the middle bucket for having been invited. Filling it
    // from the invitation list is the deeming this module exists to refuse.
    assert.deepEqual(position.participation.reviewedWithoutObjection, []);
  });

  it('counts an objection from somebody who was never invited, without inventing an invitation', async () => {
    // A review is open to anybody who can read the programme, so objectors are
    // not a subset of the invited and the two lists cannot be added together to
    // get the number asked. Getting that wrong understates nothing and
    // overstates the invitation list, which is the number a party would later
    // point at to say they were never asked.
    const { platform, seed, projectId, planner, runId } = await issued();
    review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL, MANDE] });

    const cm = readerOf(platform, seed, projectId, 'constructionManager');
    review.comment(cm(), {
      reviewId: review.reviewPosition(cm()).open!.reviewId,
      kind: 'SEQUENCE',
      body: 'Nobody asked us, and the order shown does not match how the shaft has to be sunk.',
    });

    const position = review.reviewPosition(planner(), '2026-06-05');
    assert.equal(position.open!.invitedCount, 2);
    assert.equal(position.participation.objected.length, 1);
    assert.equal(position.participation.didNotRespond.length, 2, 'an uninvited objector cancelled an invitation');
    // Named by their id, because the invitation list is the only place a name
    // was ever given and this person is not on it. An id is honest; a blank is
    // not, and a made-up name is worse.
    assert.equal(position.participation.objected[0]!.name, seed.users.constructionManager!.id);
  });

  it('never reports silence as agreement, in as many words', async () => {
    const { planner, runId } = await issued();
    review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL, MANDE] });
    const position = review.reviewPosition(planner(), '2026-06-05');

    assert.match(position.summary, /2 invited party\(ies\) have not responded/);
    assert.match(position.summary, /That is not agreement/);
    assert.match(position.summary, /question about the contract/);
    assert.doesNotMatch(position.summary, /deemed accepted|no objections received/i);
  });

  it('says when the closing date has passed and the review is still open', async () => {
    const { planner, runId } = await issued();
    review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    const position = review.reviewPosition(planner(), '2026-06-20');
    assert.ok(position.open!.daysRemaining < 0);
    assert.match(position.summary, /closing date has passed/);
  });
});

// ── Commenting ──────────────────────────────────────────────────────────────

describe('anybody who can read the programme may comment on it', () => {
  it('lets a role that cannot change the programme raise an objection', async () => {
    // The value of a review is the objection from the person who has to do the
    // work. Requiring the permission to edit a programme in order to say
    // something about it would leave only the planner able to comment.
    const { platform, seed, projectId, planner, runId, activityId } = await issued();
    review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [{ id: seed.users.qs!.id, name: 'Priya Raman' }] });

    const qs = readerOf(platform, seed, projectId, 'qs');
    const reviewId = review.reviewPosition(qs()).open!.reviewId;
    const raised = review.comment(qs(), {
      reviewId,
      activityId,
      kind: 'DURATION',
      body: 'Five days assumes two gangs. We have priced one, so this is ten.',
    });
    assert.equal(raised.kind, 'DURATION');

    const position = review.reviewPosition(planner());
    assert.equal(position.comments.length, 1);
    assert.equal(position.comments[0]!.activityName, 'Excavate');
    assert.equal(position.comments[0]!.answered, false);
    assert.equal(position.comments[0]!.kindLabel, 'How long an activity is allowed');
    assert.deepEqual(position.byKind, [
      { kind: 'DURATION', label: 'How long an activity is allowed', count: 1, unanswered: 1 },
    ]);
  });

  it('refuses a comment with no point in it', async () => {
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    const error = throwsCode(
      () => review.comment(planner(), { reviewId, kind: 'SEQUENCE', body: 'no' }),
      'COMMENT_BODY_REQUIRED',
    );
    assert.match(String(error.message), /reading back in an adjudication/);
  });

  it('refuses a comment on an activity that is not on this project', async () => {
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    throwsCode(
      () =>
        review.comment(planner(), {
          reviewId,
          activityId: 'no-such-activity',
          kind: 'SEQUENCE',
          body: 'This sequence cannot be built in that order.',
        }),
      'TASK_NOT_FOUND',
    );
  });
});

// ── Answering ───────────────────────────────────────────────────────────────

describe('every answer but a plain acceptance carries a reason', () => {
  it('refuses a rejection with nothing behind it, and a bare "noted" too', async () => {
    // A party told their objection is noted and nothing is changing is entitled
    // to know why. A register full of unexplained "noted" is the email thread
    // this exists to replace.
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    const { commentId } = review.comment(planner(), {
      reviewId,
      kind: 'SEQUENCE',
      body: 'The pour cannot follow the excavation without the blinding in between.',
    });

    throwsCode(() => review.respond(planner(), { commentId, disposition: 'REJECTED' }), 'DISPOSITION_REASON_REQUIRED');
    throwsCode(() => review.respond(planner(), { commentId, disposition: 'NOTED' }), 'DISPOSITION_REASON_REQUIRED');

    // A plain acceptance needs none: the programme changing is the answer.
    const accepted = review.respond(planner(), { commentId, disposition: 'ACCEPTED' });
    assert.equal(accepted.disposition, 'ACCEPTED');
  });

  it('will not let an answer be rewritten', async () => {
    // Changing it would rewrite what the party was told, which is the one thing
    // this record exists to hold still.
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    const { commentId } = review.comment(planner(), {
      reviewId,
      kind: 'ACCESS',
      body: 'The compound is not available until the week after.',
    });
    review.respond(planner(), { commentId, disposition: 'REJECTED', reason: 'Access was confirmed by the client on 12 May.' });

    const error = throwsCode(
      () => review.respond(planner(), { commentId, disposition: 'ACCEPTED' }),
      'COMMENT_ALREADY_ANSWERED',
    );
    assert.match(String(error.message), /hold still/);
  });

  it('carries the reason through to the register', async () => {
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    const { commentId } = review.comment(planner(), {
      reviewId,
      kind: 'RESOURCE',
      body: 'Two gangs are assumed and one is available in that window.',
    });
    review.respond(planner(), {
      commentId,
      disposition: 'ACCEPTED_IN_PART',
      reason: 'The second gang moves to week 9; the duration is extended by three days rather than five.',
    });

    const entry = review.reviewPosition(planner()).comments[0]!;
    assert.equal(entry.answered, true);
    assert.equal(entry.disposition, 'ACCEPTED_IN_PART');
    assert.equal(entry.dispositionLabel, 'Accepted in part');
    assert.match(String(entry.reason), /second gang moves to week 9/);
    assert.equal(review.reviewPosition(planner()).unanswered, 0);
  });
});

// ── Closing ─────────────────────────────────────────────────────────────────

describe('closing the review', () => {
  it('is refused while a comment has no answer', async () => {
    // Closing over an open objection puts on the record that it was never dealt
    // with, at the moment that becomes hardest to see.
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    review.comment(planner(), {
      reviewId,
      kind: 'OMISSION',
      body: 'There is no activity for the temporary works design at all.',
    });

    const error = throwsCode(
      () => review.closeReview(planner(), { reviewId, note: 'Closed after the comment period.' }),
      'REVIEW_HAS_UNANSWERED_COMMENTS',
    );
    assert.match(String(error.message), /"noted, and the programme is not changing" is an answer/);
  });

  it('records who did not respond, and refuses to close with no conclusion', async () => {
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), {
      runId,
      closesOn: '2026-06-15',
      invited: [STEEL, MANDE],
    });

    throwsCode(() => review.closeReview(planner(), { reviewId, note: '  ' }), 'REVIEW_CLOSING_NOTE_REQUIRED');

    const closed = review.closeReview(planner(), {
      reviewId,
      note: 'No comments received. The programme is issued as the working version; acceptance is not implied.',
    });
    assert.equal(closed.comments, 0);
    assert.deepEqual(closed.didNotRespond.map((party) => party.id).sort(), ['party-mande', 'party-steel']);

    const position = review.reviewPosition(planner());
    assert.equal(position.open, undefined);
    assert.equal(position.closedReviews, 1);
    assert.match(position.summary, /No review of the programme is open/);
  });

  it('refuses a comment after the review has closed', async () => {
    // A closed review is the record of what was said by its closing date.
    const { planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    review.closeReview(planner(), { reviewId, note: 'Closed with no comments received.' });

    const error = throwsCode(
      () => review.comment(planner(), { reviewId, kind: 'SEQUENCE', body: 'This should have been raised sooner.' }),
      'REVIEW_CLOSED',
    );
    assert.match(String(error.message), /Raise it against the next issue/);
  });
});

// ── Authorisation ───────────────────────────────────────────────────────────

describe('who may issue and who may answer', () => {
  it('lets a reader comment and refuses them the issue and the answer', async () => {
    const { platform, seed, projectId, planner, runId } = await issued();
    const { reviewId } = review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [{ id: seed.users.qs!.id, name: 'Priya Raman' }] });

    const qs = readerOf(platform, seed, projectId, 'qs');
    const { commentId } = review.comment(qs(), {
      reviewId,
      kind: 'SEQUENCE',
      body: 'The order shown does not match the method statement.',
    });

    // A QS holds R and not A: they may say it and not decide it.
    throwsCode(() => review.respond(qs(), { commentId, disposition: 'ACCEPTED' }), 'ACCESS_DENIED');
    throwsCode(() => review.closeReview(qs(), { reviewId, note: 'Closing this.' }), 'ACCESS_DENIED');
    throwsCode(
      () => review.openReview(qs(), { runId, closesOn: '2026-07-01', invited: [STEEL] }),
      'ACCESS_DENIED',
    );
  });

  it('refuses a role with no programme read entirely', async () => {
    const { platform, seed, projectId, planner, runId } = await issued();
    review.openReview(planner(), { runId, closesOn: '2026-06-15', invited: [STEEL] });
    const bim = platform.context(seed.users.bim!.auth, projectId, { source: 'WEB' });
    throwsCode(() => review.reviewPosition(bim), 'ACCESS_DENIED');
  });
});
