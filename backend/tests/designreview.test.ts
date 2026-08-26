import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, describe, it } from 'node:test';
import * as designreview from '../src/engines/designreview.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EntityRef } from '../src/goldenthread/types.ts';

/**
 * The design review cycle.
 *
 * The design stage could hold documents and answer questions about them, and it
 * had no way to **review** one. A deliverable went from registered to used with
 * nothing in between — no submission, no comment, no disposition, no
 * acceptance — which is the gap an uncoordinated package is built through. The
 * argument three years later is about who should have said something, and the
 * record could not answer it because there was nowhere to say anything.
 *
 * Four rules carry the whole thing, and each is tested by trying to break it:
 *
 *   - the author cannot check, answer-and-close, or accept their own work;
 *   - a comment cannot disappear, and every state it passed through is readable;
 *   - **publication is impossible while a blocking comment is open**, including
 *     — especially — under `ACCEPTED_WITH_COMMENTS`, which is the status that
 *     looks like completion while something material is unresolved;
 *   - lateness is a fact on the record with a name against it, not a nag.
 */

let platform: Platform;
let seed: SeedResult;
let deliverable: EntityRef;

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

/**
 * A refusal, identified by its code.
 *
 * `DomainError` carries the machine code in `.code` and the sentence a person
 * reads in `.message`. Matching the message would pass on any error whose prose
 * happened to contain the word, and would break the day somebody improves the
 * wording — which is a change that should not break a test about behaviour.
 */
function refuses(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // The seed finishes in OPERATIONS; design work belongs earlier. The gate
  // working, not a fixture problem.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
    to: 'CONSTRUCTION',
    justification: 'Reopened so design deliverables can be reviewed against live work',
  });

  const drawing = platform.ledger.list(seed.projectId, 'Drawing')[0];
  assert.ok(drawing, 'the seed produced no drawing to review');
  deliverable = { refType: 'Drawing', refId: drawing.refId };
});

/** A fresh cycle over a deliverable nobody else is reviewing. */
function submit(who = 'pm', over: Partial<{ dueBy: string }> = {}): string {
  // A distinct deliverable each time, because one deliverable may only be in
  // one open cycle — which is itself the rule tested below.
  const id = `DWG-TEST-${Math.random().toString(36).slice(2, 10)}`;
  platform.ledger.commit({
    eventType: 'DRAWING_REGISTERED',
    entity: { refType: 'Drawing', refId: id },
    nextState: { id, projectId: seed.projectId, drawingNumber: id, revision: 'P01', status: 'CURRENT' },
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    actor: { refType: 'User', refId: seed.users.admin!.auth.actorId },
    source: 'WEB',
    correlationId: 'designreview-test',
    evidenceRefs: [{ refType: 'EvidenceItem', refId: 'seeded' }],
  });

  return designreview.submitForReview(ctx(who), {
    deliverable: { refType: 'Drawing', refId: id },
    selfCheck: 'Checked against the structural grid, the services zone and the current architectural layout.',
    checkerId: seed.users.bim!.id,
    dueBy: over.dueBy ?? '2027-01-01',
  }).cycleId;
}

describe('a deliverable is submitted, not simply used', () => {
  it('records what the author checked before asking somebody else to', () => {
    const cycleId = designreview.submitForReview(ctx('pm'), {
      deliverable,
      selfCheck: 'Coordinated against the structural model and the current MEP layout; levels checked to survey.',
      checkerId: seed.users.bim!.id,
      dueBy: '2027-01-01',
    }).cycleId;

    const cycle = platform.ledger.require({ refType: 'DesignReviewCycle', refId: cycleId });
    assert.match(String(cycle.state.selfCheck), /Coordinated against the structural model/);
    assert.equal(cycle.state.status, 'IN_REVIEW');
    // Submission shares it. It does not publish it.
    assert.equal(cycle.state.cdeState, 'SHARED');
    assert.equal(cycle.state.submittedBy, seed.users.pm!.id);
  });

  it('refuses a submission with no real self-check', () => {
    // A tick box is not a declaration. If the author has nothing to say about
    // what they checked, nobody has checked anything.
    refuses(
      () =>
        designreview.submitForReview(ctx('pm'), {
          deliverable,
          selfCheck: 'checked',
          checkerId: seed.users.bim!.id,
          dueBy: '2027-01-01',
        }),
      'SELF_CHECK_REQUIRED',
    );
  });

  it('refuses a second open cycle over the same deliverable', () => {
    // Two open cycles over one thing means two sets of comments nobody
    // reconciles, and a decision taken against half of them.
    refuses(
      () =>
        designreview.submitForReview(ctx('pm'), {
          deliverable,
          selfCheck: 'Coordinated again against the structural model and the current MEP layout.',
          checkerId: seed.users.bim!.id,
          dueBy: '2027-01-01',
        }),
      'REVIEW_ALREADY_OPEN',
    );
  });

  it('counts revisions, so a third cycle over one deliverable is readable', () => {
    const first = submit();
    const cycle = platform.ledger.require({ refType: 'DesignReviewCycle', refId: first });
    assert.equal(cycle.state.revision, 1);
    assert.match(String(cycle.state.reference), /^DR-001-/);
  });
});

describe('the author cannot check their own work', () => {
  it('refuses a comment from the person who submitted it', () => {
    // Per act, not per role. Twenty-six roles hold both authorship and approval
    // in an area deliberately, and separation is a rule about two acts by one
    // person — so it is checked against this deliverable, not against a matrix.
    const cycleId = submit('pm');

    refuses(
      () =>
        designreview.raiseComment(ctx('pm'), {
          cycleId,
          severity: 'MAJOR',
          location: 'Grid C/4',
          comment: 'Marking my own homework',
        }),
      'REVIEW_SELF_CHECK',
    );
  });

  it('refuses an acceptance from the person who submitted it', () => {
    // The design manager authors and approves in the matrix — `DESIGNER` holds
    // both C and A on design information, deliberately. That is exactly the case
    // this rule exists for: the capability is theirs, and doing both to the same
    // deliverable is not.
    const cycleId = submit('designer');

    refuses(
      () => designreview.decideReview(ctx('designer'), { cycleId, decision: 'ACCEPTED', reason: 'Looks fine to me' }),
      'REVIEW_SELF_APPROVAL',
    );
  });

  it('refuses the author closing a comment on their own deliverable', () => {
    // The gap this closes: an author could otherwise answer a critical comment
    // "disagree", close it, and publish. Whether a response settles a comment
    // is for the person who raised it.
    const cycleId = submit('pm');
    const { commentId } = designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'CRITICAL',
      location: 'Grid C/4',
      comment: 'The riser clashes with the primary beam.',
    });
    designreview.dispositionComment(ctx('pm'), {
      commentId,
      disposition: 'REJECTED',
      response: 'The beam is being moved under a separate instruction.',
    });

    refuses(() => designreview.closeComment(ctx('pm'), { commentId }), 'REVIEW_SELF_CHECK');
  });

  it('refuses a disposition from anybody but the author', () => {
    const cycleId = submit('pm');
    const { commentId } = designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'MINOR',
      location: 'Note 4',
      comment: 'The note references a superseded standard.',
    });

    refuses(
      () => designreview.dispositionComment(ctx('bim'), { commentId, disposition: 'ACCEPTED', response: 'I will fix this' }),
      'NOT_THE_AUTHOR',
    );
  });
});

describe('a comment keeps everything about itself', () => {
  it('carries creator, location, evidence, response, disposition and timestamps', () => {
    // AC-D-WF-03-01, checked field by field. A register missing any one of them
    // cannot answer the question it exists to answer.
    const cycleId = submit('pm');
    const hash = `sha256:${createHash('sha256').update('a marked-up section').digest('hex')}`;

    const { commentId } = designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'MAJOR',
      location: 'Section B-B, grid 7',
      comment: 'The duct route has no maintenance access.',
      evidenceHash: hash,
    });
    designreview.dispositionComment(ctx('pm'), {
      commentId,
      disposition: 'ALTERNATIVE_PROPOSED',
      response: 'Access panel added at high level rather than re-routing; see revision P02.',
    });
    designreview.closeComment(ctx('bim'), { commentId, note: 'Panel is acceptable' });

    const comment = platform.ledger.require({ refType: 'DesignReviewComment', refId: commentId }).state;

    assert.equal(comment.raisedBy, seed.users.bim!.id);
    assert.equal(comment.location, 'Section B-B, grid 7');
    assert.ok(comment.evidenceRef, 'no evidence reference');
    assert.equal(comment.disposition, 'ALTERNATIVE_PROPOSED');
    assert.match(String(comment.response), /Access panel added/);
    assert.equal(comment.respondedBy, seed.users.pm!.id);
    assert.equal(comment.closedBy, seed.users.bim!.id);
    for (const field of ['raisedAt', 'respondedAt', 'closedAt']) {
      assert.match(String(comment[field]), /^\d{4}-\d{2}-\d{2}T/, `${field} is not a timestamp`);
    }
  });

  it('keeps every state it passed through, because nothing is overwritten', () => {
    const cycleId = submit('pm');
    const { commentId } = designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'CRITICAL',
      location: 'Grid A/1',
      comment: 'The foundation depth conflicts with the drainage invert.',
    });
    designreview.dispositionComment(ctx('pm'), {
      commentId,
      disposition: 'ACCEPTED',
      response: 'Foundation lowered by 300mm; drainage unchanged.',
    });

    // The ledger is append-only, so the history is the events rather than a
    // field somebody remembered to keep.
    const events = platform.ledger
      .events({ tenantId: seed.tenantId, projectId: seed.projectId })
      .filter((event) => event.entity.refId === commentId);

    assert.equal(events.length, 2);
    assert.equal(events[0]!.eventType, 'REVIEW_COMMENT_RAISED');
    assert.equal(events[1]!.eventType, 'COMMENT_DISPOSITIONED');
  });

  it('refuses a comment with no location, because nobody can action it', () => {
    const cycleId = submit('pm');
    refuses(
      () => designreview.raiseComment(ctx('bim'), { cycleId, severity: 'MINOR', location: '   ', comment: 'Something is wrong' }),
      'COMMENT_LOCATION_REQUIRED',
    );
  });

  it('refuses a disposition with nothing behind it', () => {
    const cycleId = submit('pm');
    const { commentId } = designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'MINOR',
      location: 'Note 2',
      comment: 'Dimension is missing.',
    });

    refuses(
      () => designreview.dispositionComment(ctx('pm'), { commentId, disposition: 'ACCEPTED', response: 'Noted' }),
      'RESPONSE_REQUIRED',
    );
  });

  it('orders the register so what blocks publication is read first', () => {
    const cycleId = submit('pm');
    designreview.raiseComment(ctx('bim'), { cycleId, severity: 'OBSERVATION', location: 'Note 9', comment: 'Typo in the title block.' });
    designreview.raiseComment(ctx('bim'), { cycleId, severity: 'CRITICAL', location: 'Grid D/2', comment: 'No fire stopping shown at the compartment wall.' });
    designreview.raiseComment(ctx('bim'), { cycleId, severity: 'MINOR', location: 'Note 3', comment: 'Reference an updated standard.' });

    const register = designreview.commentsFor(ctx('bim'), cycleId);
    assert.equal(register[0]!.severity, 'CRITICAL');
    assert.equal(register.at(-1)!.severity, 'OBSERVATION');
  });
});

describe('publication is impossible with a blocking comment open', () => {
  it('refuses acceptance, and names the comments rather than saying "there are blockers"', () => {
    const cycleId = submit('pm');
    designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'CRITICAL',
      location: 'Grid D/2',
      comment: 'No fire stopping shown at the compartment wall.',
    });

    assert.throws(
      () => designreview.decideReview(ctx('designer'), { cycleId, decision: 'ACCEPTED', reason: 'Programme needs it out today' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BLOCKING_COMMENTS_OPEN');
        // Naming them matters: "there are blockers" sends somebody hunting.
        assert.match(error.message, /CRITICAL at Grid D\/2/);
        return true;
      },
    );
  });

  it('refuses accepted-with-comments too, which is the status the rule exists for', () => {
    // This is the one that gets used on a real project to keep a programme
    // moving, and a deliverable accepted with three open critical comments is a
    // deliverable somebody will build from.
    const cycleId = submit('pm');
    designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'MAJOR',
      location: 'Sheet 3',
      comment: 'The lintel schedule does not match the openings.',
    });

    refuses(
      () =>
        designreview.decideReview(ctx('designer'), {
          cycleId,
          decision: 'ACCEPTED_WITH_COMMENTS',
          reason: 'Accepting so procurement is not held up',
        }),
      'BLOCKING_COMMENTS_OPEN',
    );
  });

  it('is not settled by the author answering — only by the checker agreeing', () => {
    const cycleId = submit('pm');
    const { commentId } = designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'CRITICAL',
      location: 'Grid B/3',
      comment: 'The beam depth exceeds the available zone.',
    });
    designreview.dispositionComment(ctx('pm'), {
      commentId,
      disposition: 'REJECTED',
      response: 'The zone allows 600mm; the beam is 550mm and fits.',
    });

    // Still blocked. An author's opinion that they have dealt with something is
    // not the same as the person who raised it agreeing.
    refuses(
      () => designreview.decideReview(ctx('designer'), { cycleId, decision: 'ACCEPTED', reason: 'Author has answered it' }),
      'BLOCKING_COMMENTS_OPEN',
    );

    designreview.closeComment(ctx('bim'), { commentId });
    const decided = designreview.decideReview(ctx('designer'), {
      cycleId,
      decision: 'ACCEPTED',
      reason: 'Zone confirmed at 600mm; comment agreed as settled',
    });
    assert.equal(decided.decision, 'ACCEPTED');
    assert.equal(decided.cdeState, 'PUBLISHED');
  });

  it('lets a minor comment through, because not everything is a blocker', () => {
    // The rule has to be worth something. If everything blocked, the status
    // would mean nothing and people would stop raising comments.
    const cycleId = submit('pm');
    designreview.raiseComment(ctx('bim'), { cycleId, severity: 'MINOR', location: 'Note 6', comment: 'Update the standard reference.' });

    const decided = designreview.decideReview(ctx('designer'), {
      cycleId,
      decision: 'ACCEPTED_WITH_COMMENTS',
      reason: 'Minor comment to be picked up on the next revision',
    });
    assert.equal(decided.cdeState, 'PUBLISHED');
    assert.equal(decided.openBlocking, 0);
  });

  it('sends it back without publishing, and records what was open at that moment', () => {
    const cycleId = submit('pm');
    designreview.raiseComment(ctx('bim'), { cycleId, severity: 'CRITICAL', location: 'Grid A/5', comment: 'Column omitted at the transfer level.' });

    designreview.decideReview(ctx('designer'), {
      cycleId,
      decision: 'REVISE_AND_RESUBMIT',
      reason: 'The transfer level needs resolving before this can be issued',
    });

    const cycle = platform.ledger.require({ refType: 'DesignReviewCycle', refId: cycleId }).state;
    assert.equal(cycle.cdeState, 'WORK_IN_PROGRESS', 'a rejected deliverable was published');
    // Frozen at the decision. Reading the register later shows today's comments;
    // this shows what the decision was actually taken against.
    assert.equal(cycle.openBlockingAtDecision, 1);
  });

  it('cannot be decided twice', () => {
    const cycleId = submit('pm');
    designreview.decideReview(ctx('designer'), { cycleId, decision: 'ACCEPTED', reason: 'No comments raised against it' });

    refuses(
      () => designreview.decideReview(ctx('designer'), { cycleId, decision: 'REJECTED', reason: 'Changed my mind about it' }),
      'REVIEW_NOT_OPEN',
    );
  });
});

describe('lateness is a fact on the record, with a name against it', () => {
  it('reports duration, what is overdue and by how long', () => {
    // AC-D-WF-03-03. Computed here rather than in the console: the screen gets
    // the answer, not the arithmetic.
    const cycleId = submit('pm', { dueBy: '2026-01-10' });

    // Asked as of today, against a review that was due back in January.
    const position = designreview.reviewPosition(ctx('designer'));
    const cycle = position.cycles.find((entry) => entry.cycleId === cycleId)!;

    assert.ok(cycle.daysOverdue !== undefined && cycle.daysOverdue > 20, 'a long-overdue review is not reported as overdue');
    // Submitted today, so it has been open for zero days — which is the honest
    // answer and not a bug. Duration is checked properly on a decided cycle
    // below, where there are two real dates to measure between.
    assert.ok(cycle.durationDays >= 0);
    assert.equal(cycle.checkerId, seed.users.bim!.id, 'the review does not name who it is with');
    assert.match(position.summary, /past the date it was due back/);
  });

  it('says whose it is now, which is the field that makes the list usable', () => {
    // A list of open reviews tells a design manager nothing they did not know.
    // A list saying which are with the checker, which are back with the author
    // and which await a decision is a morning's work in order.
    const cycleId = submit('pm');
    const waiting = () => designreview.reviewPosition(ctx('designer')).cycles.find((c) => c.cycleId === cycleId)!.waitingOn;

    assert.match(waiting(), /checker, to review it/);

    const { commentId } = designreview.raiseComment(ctx('bim'), {
      cycleId,
      severity: 'MAJOR',
      location: 'Grid F/1',
      comment: 'The slab edge detail is missing.',
    });
    assert.match(waiting(), /author, to answer/);

    designreview.dispositionComment(ctx('pm'), {
      commentId,
      disposition: 'ACCEPTED',
      response: 'Slab edge detail added on revision P02.',
    });
    assert.match(waiting(), /checker, to agree/);

    designreview.closeComment(ctx('bim'), { commentId });
    assert.match(waiting(), /accepting party, to decide/);
  });

  it('stops counting a review as overdue once it has been decided', () => {
    const cycleId = submit('pm', { dueBy: '2026-01-10' });
    designreview.decideReview(ctx('designer'), { cycleId, decision: 'ACCEPTED', reason: 'Reviewed and found acceptable' });

    const cycle = designreview.reviewPosition(ctx('designer')).cycles.find((c) => c.cycleId === cycleId)!;
    assert.equal(cycle.daysOverdue, undefined, 'a decided review is still being counted as late');
    assert.equal(cycle.waitingOn, 'Decided');
  });

  it('counts what cannot be published, separately from what is merely open', () => {
    const position = designreview.reviewPosition(ctx('designer'));
    assert.ok(position.openCycles >= 0);
    assert.ok(position.blockedFromPublication <= position.openCycles);
  });
});
