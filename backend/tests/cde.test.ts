import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import * as cde from '../src/domain/cde.ts';
import * as informationcontrol from '../src/domain/informationcontrol.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The common data environment.
 *
 * The platform could plan information, review it, issue it and store its bytes,
 * and it could not say which revision of a drawing was current — because
 * nothing held **the container**: this file, at this revision, at this state,
 * superseding that one. A deliverable is a promise a drawing will exist; a
 * transmittal is a record that one was sent. Neither is the drawing.
 *
 * So the tests below are about the four rules that make this a single source of
 * truth rather than a shared folder, and each is tested by trying to break it.
 *
 *   - one current revision of a reference, always, because publishing
 *     supersedes its predecessor in the same act rather than as a tidy-up
 *     somebody remembers;
 *   - the author cannot check and neither of them can approve;
 *   - the same revision cannot be deposited twice;
 *   - **suitability is not state.** A revision can be published, current and
 *     still not something to build from, and confusing those two is the
 *     commonest expensive mistake in design management.
 */

let platform: Platform;
let seed: SeedResult;

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

function refuses(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: Error & { code?: string }) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // The seed finishes in OPERATIONS and depositing design information is gated
  // earlier. The gate working, not a fixture problem.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
    to: 'CONSTRUCTION',
    justification: 'Reopened so the information environment can be exercised against live work',
  });
});

let reference: string;
beforeEach(() => {
  // A distinct reference each time. Supersession is per reference, so sharing
  // one across tests would make each test depend on the order of the others.
  reference = `ABC-CX-ZZ-00-DR-A-${Math.floor(Math.random() * 900000 + 100000)}`;
});

/** Deposit, check and approve one revision, which is the ordinary path. */
function publish(revision: string, suitability: cde.SuitabilityCode = 'A1'): string {
  const { containerId } = cde.depositContainer(ctx('bim'), {
    reference,
    revision,
    title: 'General arrangement — level 00',
    kind: 'DRAWING',
    discipline: 'Architecture',
    author: seed.users.bim!.id,
    fileHash: `hash-${reference}-${revision}`,
  });
  cde.shareContainer(ctx('pm'), { containerId, checker: seed.users.pm!.id, suitability: 'S3' });
  cde.publishContainer(ctx('designer'), { containerId, approver: seed.users.designer!.id, suitability });
  return containerId;
}

describe('a file goes in, and it goes in at the bottom', () => {
  it('arrives at work in progress whatever anybody wants', () => {
    // Nothing enters the environment already authorised. If it could, the
    // ladder above would be optional, and an optional ladder is a folder.
    const { containerId, state } = cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P01',
      title: 'General arrangement — level 00',
      kind: 'DRAWING',
      discipline: 'Architecture',
      author: seed.users.bim!.id,
      fileHash: 'hash-p01',
    });

    assert.equal(state, 'WIP');
    const stored = platform.ledger.require({ refType: 'InformationContainer', refId: containerId }).state;
    assert.equal(stored.suitability, 'S0', 'a container arrived carrying a suitability somebody chose');
    assert.equal(stored.state, 'WIP');
  });

  it('refuses the same revision twice', () => {
    // Two files claiming to be revision P01 of the same drawing is the exact
    // ambiguity this exists to remove, so it is refused at the door rather
    // than resolved later by whoever opens the folder.
    const deposit = (fileHash: string) =>
      cde.depositContainer(ctx('bim'), {
        reference,
        revision: 'P01',
        title: 'General arrangement — level 00',
        kind: 'DRAWING',
        discipline: 'Architecture',
        author: seed.users.bim!.id,
        fileHash,
      });

    deposit('hash-first');
    refuses(() => deposit('hash-second'), 'REVISION_ALREADY_DEPOSITED');
  });

  it('files the bytes as evidence rather than trusting a typed hash', () => {
    const { containerId } = cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P01',
      title: 'Ground floor slab layout',
      kind: 'DRAWING',
      discipline: 'Structures',
      author: seed.users.bim!.id,
      fileHash: 'hash-evidence-check',
    });

    const entry = platform.ledger.eventsForEntity({ refType: 'InformationContainer', refId: containerId })[0];
    assert.ok(entry, 'no ledger entry for the deposit');
    assert.equal(entry.evidenceRefs?.length, 1, 'a container was filed with no evidence behind it');
  });
});

describe('nothing moves up the ladder alone', () => {
  it('refuses the author as their own checker', () => {
    const { containerId } = cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P01',
      title: 'General arrangement — level 00',
      kind: 'DRAWING',
      discipline: 'Architecture',
      author: seed.users.bim!.id,
      fileHash: 'hash-self-check',
    });

    refuses(
      () => cde.shareContainer(ctx('bim'), { containerId, checker: seed.users.bim!.id, suitability: 'S3' }),
      'AUTHOR_CANNOT_CHECK',
    );
  });

  it('refuses the checker as the approver', () => {
    // Three roles, three people. Two is a conversation between the author and
    // one other person, and calling the result "published" overstates it.
    const { containerId } = cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P01',
      title: 'General arrangement — level 00',
      kind: 'DRAWING',
      discipline: 'Architecture',
      author: seed.users.bim!.id,
      fileHash: 'hash-checker-approves',
    });
    cde.shareContainer(ctx('pm'), { containerId, checker: seed.users.pm!.id, suitability: 'S3' });

    refuses(
      () => cde.publishContainer(ctx('designer'), { containerId, approver: seed.users.pm!.id, suitability: 'A1' }),
      'APPROVER_ALREADY_INVOLVED',
    );
  });

  it('refuses to publish something nobody checked', () => {
    const { containerId } = cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P01',
      title: 'General arrangement — level 00',
      kind: 'DRAWING',
      discipline: 'Architecture',
      author: seed.users.bim!.id,
      fileHash: 'hash-unchecked',
    });

    refuses(
      () => cde.publishContainer(ctx('designer'), { containerId, approver: seed.users.designer!.id, suitability: 'A1' }),
      'CONTAINER_NOT_SHARED',
    );
  });

  it('refuses a work-in-progress code as a shared one', () => {
    // S0 means "mine, not yours". A container shared at S0 says it has been
    // issued to the project and kept to the author at the same time.
    const { containerId } = cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P01',
      title: 'General arrangement — level 00',
      kind: 'DRAWING',
      discipline: 'Architecture',
      author: seed.users.bim!.id,
      fileHash: 'hash-s0-share',
    });

    refuses(
      () => cde.shareContainer(ctx('pm'), { containerId, checker: seed.users.pm!.id, suitability: 'S0' }),
      'SUITABILITY_NOT_SHAREABLE',
    );
  });
});

describe('there is one current revision, and the platform says which', () => {
  it('supersedes the previous revision in the same act as publishing the new one', () => {
    // The whole mechanism. Not a job somebody does afterwards — at the instant
    // the publish returns, the old revision is archived and says what replaced
    // it, so there is no window in which two revisions are both current.
    const first = publish('P01');
    const second = publish('P02');

    const previous = platform.ledger.require({ refType: 'InformationContainer', refId: first }).state;
    assert.equal(previous.state, 'ARCHIVED', 'the previous revision stayed published alongside its replacement');
    assert.equal(previous.supersededBy, second);
    assert.ok(previous.supersededAt, 'a superseded revision with no date on it');

    const current = platform.ledger.require({ refType: 'InformationContainer', refId: second }).state;
    assert.equal(current.supersedes, first, 'the new revision does not say what it replaced');

    assert.equal(cde.currentRevision(ctx('pm'), reference)?.id, second);
  });

  it('prefers a published revision over a newer draft', () => {
    // Somebody asking what is current wants what they may build from. A P03 in
    // work in progress is newer and is not an answer to that question.
    const published = publish('P01');
    cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P02',
      title: 'General arrangement — level 00',
      kind: 'DRAWING',
      discipline: 'Architecture',
      author: seed.users.bim!.id,
      fileHash: 'hash-newer-draft',
    });

    assert.equal(cde.currentRevision(ctx('pm'), reference)?.id, published);
  });

  it('withdrawing takes it out of currency, and says why', () => {
    const containerId = publish('P01');
    cde.archiveContainer(ctx('designer'), {
      containerId,
      reason: 'Issued against the superseded survey; the setting-out on it is wrong',
    });

    assert.equal(cde.currentRevision(ctx('pm'), reference), undefined);
    const stored = platform.ledger.require({ refType: 'InformationContainer', refId: containerId }).state;
    assert.match(String(stored.archiveReason), /superseded survey/);
  });

  it('refuses a withdrawal with nothing said about it', () => {
    const containerId = publish('P01');
    refuses(() => cde.archiveContainer(ctx('designer'), { containerId, reason: 'wrong' }), 'WITHDRAWAL_UNEXPLAINED');
  });
});

describe('the latest file and a file to build from are different things', () => {
  it('says no when the current revision is published at a review code', () => {
    // The substitution that gets work built off a review issue: S3 and A1 look
    // identical on a title block. Published, current, and not an instruction.
    publish('P01', 'S3');

    const answer = cde.buildableFrom(ctx('pm'), reference);
    assert.equal(answer.mayBuild, false);
    assert.match(answer.because, /S3/);
    assert.match(answer.because, /not an instruction to build it/);
  });

  it('says yes when it is published at an authorised code', () => {
    publish('P01', 'A1');

    const answer = cde.buildableFrom(ctx('pm'), reference);
    assert.equal(answer.mayBuild, true);
    assert.equal(answer.container?.revision, 'P01');
  });

  it('says no, and says which, when the current revision was only shared', () => {
    const { containerId } = cde.depositContainer(ctx('bim'), {
      reference,
      revision: 'P01',
      title: 'General arrangement — level 00',
      kind: 'DRAWING',
      discipline: 'Architecture',
      author: seed.users.bim!.id,
      fileHash: 'hash-shared-only',
    });
    cde.shareContainer(ctx('pm'), { containerId, checker: seed.users.pm!.id, suitability: 'S4' });

    const answer = cde.buildableFrom(ctx('pm'), reference);
    assert.equal(answer.mayBuild, false);
    assert.match(answer.because, /not published/);
  });

  it('says no about a document that does not exist, rather than nothing', () => {
    // An empty answer to "may I build from this" reads as a yes to anybody in
    // a hurry.
    const answer = cde.buildableFrom(ctx('pm'), 'ABC-CX-ZZ-00-DR-A-NOTHING');
    assert.equal(answer.mayBuild, false);
    assert.match(answer.because, /Nothing has been deposited/);
  });
});

describe('the register, and the two things it is asked', () => {
  it('names the documents with no revision authorised for construction', () => {
    publish('P01', 'S3');

    const register = cde.register(ctx('pm'));
    assert.ok(register.nothingToBuildFrom.includes(reference));
    assert.match(register.summary, /authorised for construction/);
  });

  it('names what was published here and never sent to anybody', () => {
    // Publishing changes this register; a transmittal is what reaches the
    // person in the cabin. A revision approved and never issued appears in
    // neither register on its own — the transmittal record has no row for a
    // document nobody sent — so it is the join that finds it.
    publish('P01', 'A1');

    const before = cde.register(ctx('pm'));
    assert.deepEqual(
      before.publishedButNeverIssued.filter((c) => c.reference === reference).map((c) => c.revision),
      ['P01'],
      'a published revision nobody was sent went unreported',
    );

    // Issuing is `I` on DESIGN_INFORMATION, which the design lead holds and the
    // project manager does not — the same separation the ladder above uses.
    informationcontrol.issueTransmittal(ctx('designer'), {
      documents: [{ reference, title: 'General arrangement — level 00', revision: 'P01', purpose: 'FOR_CONSTRUCTION' }],
      recipients: ['Groundworks subcontractor'],
      note: 'Issued for construction following approval in the environment',
    });

    const after = cde.register(ctx('pm'));
    assert.equal(
      after.publishedButNeverIssued.filter((c) => c.reference === reference).length,
      0,
      'issuing it did not clear it',
    );
  });

  it('counts every state, so a register that looks empty says so', () => {
    const register = cde.register(ctx('pm'));
    for (const state of cde.CDE_STATE) {
      assert.equal(typeof register.byState[state], 'number', `${state} is not counted`);
    }
  });
});

describe('who may touch it', () => {
  it('refuses a deposit from somebody with no design authority', () => {
    // The QS holds nothing on DESIGN_INFORMATION. The environment is not a
    // shared drive; putting a drawing in it is a design act.
    assert.throws(() =>
      cde.depositContainer(ctx('qs'), {
        reference,
        revision: 'P01',
        title: 'General arrangement — level 00',
        kind: 'DRAWING',
        discipline: 'Architecture',
        author: seed.users.qs!.id,
        fileHash: 'hash-unauthorised',
      }),
    );
  });
});
