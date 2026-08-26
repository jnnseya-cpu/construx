import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as enquiry from '../src/domain/enquiry.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The enquiry pack, who holds which revision, and the workspace that closes —
 * T-WF-04.
 *
 * The failure this is built against is quiet and expensive. An addendum goes
 * out on the Tuesday; two of five bidders price the Monday pack. Nothing in the
 * returns says so. The comparison then ranks five prices for two different
 * scopes, and the cheapest is cheapest because it is pricing less work.
 *
 * The second failure is a disclosure. A bidder who can see the distribution
 * knows the size of the field, and a field of two is priced differently from a
 * field of six.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds PROCUREMENT_AWARD C, U, I, X — composes and issues, cannot approve. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Holds A — approves the pack, closes the returns, accepts a late one. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const AMEY = 'party-amey';
const BALFOUR = 'party-balfour';
const CARILLON = 'party-carillon';

const document = (kind: string, reference: string, revision = 'A'): enquiry.PackDocument => ({
  reference,
  title: kind.toLowerCase().replace(/_/g, ' '),
  revision,
  kind,
});

/** A complete pack: one document of every mandatory kind. */
const completePack = (revision = 'A') =>
  enquiry.MANDATORY_KINDS.map((kind, index) => document(kind, `DOC-${index + 1}`, revision));

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'TENDER',
    justification: 'Reopened to issue the cladding enquiry for this bid',
  });
});

// ── Composing ───────────────────────────────────────────────────────────────

describe('enquiry · a package short of a mandatory document is authorised, not blocked', () => {
  let enquiryId: string;

  before(() => {
    enquiryId = enquiry.openEnquiry(asQS(), {
      packageReference: 'PKG-CLAD',
      title: 'Rainscreen cladding and windows',
      returnDeadline: '2027-03-05T12:00:00.000Z',
    }).enquiryId;
  });

  it('refuses an enquiry with no deadline that is a date', () => {
    throwsCode(
      () => enquiry.openEnquiry(asQS(), { packageReference: 'X', title: 'Y', returnDeadline: 'next Friday' }),
      'DEADLINE_INVALID',
    );
  });

  it('refuses a pack with nothing in it', () => {
    throwsCode(() => enquiry.composeRevision(asQS(), enquiryId, { documents: [] }), 'PACK_EMPTY');
  });

  it('names what is missing, in the words a person would use', () => {
    const error = throwsCode(
      () => enquiry.composeRevision(asQS(), enquiryId, { documents: [document('SCOPE', 'DOC-1'), document('DRAWINGS', 'DOC-2')] }),
      'PACK_INCOMPLETE',
    );
    assert.match(String(error.message), /no pricing schedule, no specification, no programme, no contract terms/);
    assert.match(String(error.message), /record an authorised exception/);
  });

  /**
   * Refusing outright would be simpler and wrong. Packages go out short of a
   * document constantly, and a platform that only says no teaches people to
   * route around it — into a spreadsheet, where nothing is recorded at all.
   */
  it('lets it through when somebody names what is missing and accepts the risk', () => {
    const documents = completePack().filter((d) => d.kind !== 'PROGRAMME');
    const result = enquiry.composeRevision(asQS(), enquiryId, {
      documents,
      exception: {
        missing: ['PROGRAMME'],
        reason: 'Client programme is in preparation; the enquiry states the sectional completion dates in the scope.',
        authorisedBy: 'Commercial Manager',
      },
    });
    assert.equal(result.revision, 1);
    assert.deepEqual(result.missing, ['PROGRAMME']);
  });

  it('refuses an exception that names no reason and nobody behind it', () => {
    const other = enquiry.openEnquiry(asQS(), { packageReference: 'PKG-X', title: 'X', returnDeadline: '2027-03-05T12:00:00.000Z' }).enquiryId;
    throwsCode(
      () =>
        enquiry.composeRevision(asQS(), other, {
          documents: completePack().filter((d) => d.kind !== 'PROGRAMME'),
          exception: { missing: ['PROGRAMME'], reason: '  ', authorisedBy: '' },
        }),
      'EXCEPTION_UNAUTHORISED',
    );
  });

  /** Otherwise attaching one to every pack becomes the habit. */
  it('refuses an exception for a document that is in the pack', () => {
    const other = enquiry.openEnquiry(asQS(), { packageReference: 'PKG-Y', title: 'Y', returnDeadline: '2027-03-05T12:00:00.000Z' }).enquiryId;
    throwsCode(
      () =>
        enquiry.composeRevision(asQS(), other, {
          documents: completePack(),
          exception: { missing: ['PROGRAMME'], reason: 'Just in case', authorisedBy: 'Commercial Manager' },
        }),
      'EXCEPTION_NOT_NEEDED',
    );
  });
});

// ── Approval and issue ──────────────────────────────────────────────────────

describe('enquiry · what goes out binds everybody who prices it', () => {
  let enquiryId: string;

  before(() => {
    enquiryId = enquiry.openEnquiry(asQS(), {
      packageReference: 'PKG-MEP',
      title: 'Mechanical and electrical',
      returnDeadline: '2027-03-19T12:00:00.000Z',
    }).enquiryId;
    enquiry.composeRevision(asQS(), enquiryId, { documents: completePack() });
  });

  it('refuses to issue a revision nobody has approved', () => {
    const error = throwsCode(
      () => enquiry.issueTo(asQS(), enquiryId, { recipients: [{ partyId: AMEY, name: 'Amey' }] }),
      'REVISION_NOT_APPROVED',
    );
    assert.match(String(error.message), /nobody has taken responsibility/);
  });

  /**
   * The QS composes and cannot approve at all — the matrix already separates
   * those, and it refuses before this check is reached. The per-act rule exists
   * for the case the matrix cannot express: somebody who *does* hold the
   * approval assembling the pack themselves, which on a small commercial team
   * is the ordinary Tuesday rather than the exception.
   */
  it('refuses the composer their own approval even when they hold the authority', () => {
    const own = enquiry.openEnquiry(asPM(), {
      packageReference: 'PKG-SELF',
      title: 'Composed and approved by one person',
      returnDeadline: '2027-03-19T12:00:00.000Z',
    }).enquiryId;
    enquiry.composeRevision(asPM(), own, { documents: completePack() });
    const error = throwsCode(() => enquiry.approveRevision(asPM(), own), 'SELF_APPROVAL_REFUSED');
    assert.match(String(error.message), /not a second click by the same person/);
  });

  it('refuses approval from a role that does not hold the commercial authority', () => {
    throwsCode(() => enquiry.approveRevision(asQS(), enquiryId), 'ACCESS_DENIED');
  });

  it('approves under somebody with the commercial authority', () => {
    const result = enquiry.approveRevision(asPM(), enquiryId);
    assert.equal(result.revision, 1);
  });

  it('refuses a second approval of the same revision', () => {
    throwsCode(() => enquiry.approveRevision(asPM(), enquiryId), 'REVISION_ALREADY_APPROVED');
  });

  /** `AC-T-WF-04-01`. */
  it('records the exact revision and content hash against each firm', () => {
    const result = enquiry.issueTo(asQS(), enquiryId, {
      recipients: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    });
    assert.equal(result.revision, 1);
    assert.equal(result.issued, 2);

    const amey = enquiry.bidderView(asQS(), enquiryId, AMEY);
    const balfour = enquiry.bidderView(asQS(), enquiryId, BALFOUR);
    assert.equal(amey.revision, 1);
    assert.equal(amey.contentHash, balfour.contentHash);
    assert.equal(amey.state, 'SENT');
  });

  it('refuses an enquiry issued to nobody', () => {
    throwsCode(() => enquiry.issueTo(asQS(), enquiryId, { recipients: [] }), 'NO_RECIPIENTS');
  });
});

// ── Tracking ────────────────────────────────────────────────────────────────

describe('enquiry · sent, delivered, opened, acknowledged, declined', () => {
  let enquiryId: string;

  before(() => {
    enquiryId = enquiry.openEnquiry(asQS(), {
      packageReference: 'PKG-GND',
      title: 'Groundworks',
      returnDeadline: '2027-04-02T12:00:00.000Z',
    }).enquiryId;
    enquiry.composeRevision(asQS(), enquiryId, { documents: completePack() });
    enquiry.approveRevision(asPM(), enquiryId);
    enquiry.issueTo(asQS(), enquiryId, {
      recipients: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
        { partyId: CARILLON, name: 'Carillon' },
      ],
    });
  });

  it('moves a firm along the ladder', () => {
    for (const state of ['DELIVERED', 'OPENED', 'ACKNOWLEDGED'] as const) {
      assert.equal(enquiry.recordIssueState(asQS(), enquiryId, { partyId: AMEY, state }).moved, true);
    }
    assert.equal(enquiry.bidderView(asQS(), enquiryId, AMEY).state, 'ACKNOWLEDGED');
  });

  /**
   * A delivery receipt arriving after an acknowledgement is an out-of-order
   * webhook, not a firm un-acknowledging — and treating it as the latter would
   * lose the acknowledgement that matters.
   */
  it('does not let a late-arriving earlier state undo a later one', () => {
    const result = enquiry.recordIssueState(asQS(), enquiryId, { partyId: AMEY, state: 'DELIVERED' });
    assert.equal(result.moved, false);
    assert.equal(result.state, 'ACKNOWLEDGED');
  });

  it('takes a decline from anywhere in the ladder', () => {
    enquiry.recordIssueState(asQS(), enquiryId, { partyId: CARILLON, state: 'DELIVERED' });
    assert.equal(enquiry.recordIssueState(asQS(), enquiryId, { partyId: CARILLON, state: 'DECLINED' }).moved, true);
    assert.equal(enquiry.bidderView(asQS(), enquiryId, CARILLON).state, 'DECLINED');
  });

  it('keeps the whole history, so a dispute about timing has an answer', () => {
    const position = enquiry.enquiryPosition(asQS());
    const row = position.enquiries.find((e) => e.packageReference === 'PKG-GND')!;
    assert.equal(row.acknowledged, 1);
    assert.equal(row.declined, 1);
    assert.equal(row.issued, 3);
  });

  it('refuses a state for a firm that was never issued the enquiry', () => {
    throwsCode(
      () => enquiry.recordIssueState(asQS(), enquiryId, { partyId: 'party-nobody', state: 'OPENED' }),
      'NOT_A_RECIPIENT',
    );
  });

  // ── The addendum ──────────────────────────────────────────────────────────

  /**
   * The whole point. A new revision makes every acknowledgement stale, by name,
   * so a firm holding the Monday pack is a fact on the screen rather than
   * something the comparison discovers by being wrong.
   */
  it('a new revision makes every live firm’s acknowledgement stale', () => {
    const result = enquiry.composeRevision(asQS(), enquiryId, {
      documents: completePack('B'),
      note: 'Addendum 1 — revised drainage layout',
    });
    assert.equal(result.revision, 2);
    assert.deepEqual(result.requiresReacknowledgement.sort(), [AMEY, BALFOUR, CARILLON].sort());

    const position = enquiry.enquiryPosition(asQS());
    const row = position.enquiries.find((e) => e.packageReference === 'PKG-GND')!;
    assert.deepEqual(row.stale, ['Amey', 'Balfour', 'Carillon']);
  });

  it('tells the firm itself that it is holding a superseded pack', () => {
    assert.equal(enquiry.bidderView(asQS(), enquiryId, AMEY).reacknowledgementDue, true);
    // And still shows them revision 1, because that is what they actually hold.
    assert.equal(enquiry.bidderView(asQS(), enquiryId, AMEY).revision, 1);
  });

  it('clears the debt only when the firm acknowledges the revision it now holds', () => {
    enquiry.approveRevision(asPM(), enquiryId);
    enquiry.issueTo(asQS(), enquiryId, { recipients: [{ partyId: AMEY, name: 'Amey' }] });
    assert.equal(enquiry.bidderView(asQS(), enquiryId, AMEY).revision, 2);

    // Opening the addendum is not agreeing to it.
    enquiry.recordIssueState(asQS(), enquiryId, { partyId: AMEY, state: 'OPENED' });
    assert.equal(enquiry.bidderView(asQS(), enquiryId, AMEY).reacknowledgementDue, true);

    enquiry.recordIssueState(asQS(), enquiryId, { partyId: AMEY, state: 'ACKNOWLEDGED' });
    assert.equal(enquiry.bidderView(asQS(), enquiryId, AMEY).reacknowledgementDue, false);

    const row = enquiry.enquiryPosition(asQS()).enquiries.find((e) => e.packageReference === 'PKG-GND')!;
    assert.deepEqual(row.stale, ['Balfour', 'Carillon']);
  });
});

// ── Revocation ──────────────────────────────────────────────────────────────

describe('enquiry · removing a firm does not remove what happened', () => {
  let enquiryId: string;

  before(() => {
    enquiryId = enquiry.openEnquiry(asQS(), {
      packageReference: 'PKG-ROOF',
      title: 'Roofing',
      returnDeadline: '2027-04-16T12:00:00.000Z',
    }).enquiryId;
    enquiry.composeRevision(asQS(), enquiryId, { documents: completePack() });
    enquiry.approveRevision(asPM(), enquiryId);
    enquiry.issueTo(asQS(), enquiryId, {
      recipients: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
      ],
    });
    enquiry.recordIssueState(asQS(), enquiryId, { partyId: BALFOUR, state: 'OPENED' });
  });

  it('refuses a revocation with no reason', () => {
    throwsCode(() => enquiry.revokeAccess(asPM(), enquiryId, { partyId: BALFOUR, reason: ' ' }), 'REASON_REQUIRED');
  });

  it('revokes under an approval authority', () => {
    const result = enquiry.revokeAccess(asPM(), enquiryId, {
      partyId: BALFOUR,
      reason: 'Prequalification lapsed — employers liability cover expired on 12 March',
    });
    assert.ok(Date.parse(result.revokedAt) > 0);
  });

  /**
   * The specification's exception control, and the whole of it. That firm did
   * receive revision 1 and did open it, and the revocation is an additional
   * fact rather than a correction of the earlier one.
   */
  it('preserves the issue evidence in the ledger', () => {
    const record = asQS().ledger.get({ refType: 'Enquiry', refId: enquiryId })!;
    const issues = record.state.issues as Array<Record<string, unknown>>;
    const balfour = issues.find((issue) => issue.partyId === BALFOUR)!;
    assert.equal(balfour.revision, 1);
    assert.equal(balfour.state, 'OPENED');
    assert.ok(Array.isArray(balfour.history) && balfour.history.length === 2);
    assert.ok(balfour.revoked, 'the revocation was not recorded alongside');
  });

  it('shows the removed firm nothing afterwards', () => {
    throwsCode(() => enquiry.bidderView(asQS(), enquiryId, BALFOUR), 'NO_ENQUIRY');
  });

  it('refuses to move a revoked firm’s state', () => {
    throwsCode(
      () => enquiry.recordIssueState(asQS(), enquiryId, { partyId: BALFOUR, state: 'ACKNOWLEDGED' }),
      'ACCESS_REVOKED',
    );
  });

  it('refuses to re-invite a removed firm as a side effect of a distribution list', () => {
    const error = throwsCode(
      () =>
        enquiry.issueTo(asQS(), enquiryId, {
          recipients: [
            { partyId: AMEY, name: 'Amey' },
            { partyId: BALFOUR, name: 'Balfour' },
          ],
        }),
      'ACCESS_REVOKED',
    );
    assert.match(String(error.message), /a decision somebody has to make deliberately/);
  });

  it('counts the revocation in the position without losing the firm', () => {
    const row = enquiry.enquiryPosition(asQS()).enquiries.find((e) => e.packageReference === 'PKG-ROOF')!;
    assert.equal(row.issued, 1);
    assert.equal(row.revoked, 1);
  });
});

// ── What a bidder may see ───────────────────────────────────────────────────

describe('enquiry · a bidder cannot see the size of the field', () => {
  let enquiryId: string;

  before(() => {
    enquiryId = enquiry.openEnquiry(asQS(), {
      packageReference: 'PKG-FIT',
      title: 'Fit-out',
      returnDeadline: '2027-05-07T12:00:00.000Z',
    }).enquiryId;
    enquiry.composeRevision(asQS(), enquiryId, { documents: completePack() });
    enquiry.approveRevision(asPM(), enquiryId);
    enquiry.issueTo(asQS(), enquiryId, {
      recipients: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
        { partyId: CARILLON, name: 'Carillon' },
      ],
    });
  });

  /** `AC-T-WF-04-02`. */
  it('returns one firm’s own pack and no trace of any other', () => {
    const view = enquiry.bidderView(asQS(), enquiryId, AMEY);
    const serialised = JSON.stringify(view);
    assert.equal(view.documents.length, enquiry.MANDATORY_KINDS.length);
    for (const other of ['Balfour', 'Carillon', BALFOUR, CARILLON]) {
      assert.doesNotMatch(serialised, new RegExp(other), `the bidder view leaked ${other}`);
    }
    // Not even a count. A field of two is priced differently from a field of six.
    assert.doesNotMatch(serialised, /"issued"|"acknowledged"|"declined"/);
  });

  it('answers the same way for a firm never invited and one removed', () => {
    const never = throwsCode(() => enquiry.bidderView(asQS(), enquiryId, 'party-nobody'), 'NO_ENQUIRY');
    enquiry.revokeAccess(asPM(), enquiryId, { partyId: CARILLON, reason: 'Withdrawn at their request' });
    const removed = throwsCode(() => enquiry.bidderView(asQS(), enquiryId, CARILLON), 'NO_ENQUIRY');
    assert.equal(never.message, removed.message);
  });
});

// ── The return workspace ────────────────────────────────────────────────────

describe('enquiry · the workspace closes, and the late return goes through a person', () => {
  let enquiryId: string;

  before(() => {
    enquiryId = enquiry.openEnquiry(asQS(), {
      packageReference: 'PKG-EXT',
      title: 'External works',
      returnDeadline: '2027-05-21T12:00:00.000Z',
    }).enquiryId;
  });

  it('refuses to close an enquiry that was never issued', () => {
    enquiry.composeRevision(asQS(), enquiryId, { documents: completePack() });
    throwsCode(() => enquiry.closeReturns(asPM(), enquiryId), 'NEVER_ISSUED');
  });

  it('closes, and says who returned and who went silent', () => {
    enquiry.approveRevision(asPM(), enquiryId);
    enquiry.issueTo(asQS(), enquiryId, {
      recipients: [
        { partyId: AMEY, name: 'Amey' },
        { partyId: BALFOUR, name: 'Balfour' },
        { partyId: CARILLON, name: 'Carillon' },
      ],
    });
    enquiry.recordIssueState(asQS(), enquiryId, { partyId: AMEY, state: 'ACKNOWLEDGED' });
    enquiry.recordIssueState(asQS(), enquiryId, { partyId: CARILLON, state: 'DECLINED' });

    const result = enquiry.closeReturns(asPM(), enquiryId);
    assert.deepEqual(result.returned, ['Amey']);
    // Declined is a different fact from silent, and a supply chain is read from
    // the difference between them.
    assert.deepEqual(result.silent, ['Balfour']);
  });

  it('refuses a second close', () => {
    throwsCode(() => enquiry.closeReturns(asPM(), enquiryId), 'ALREADY_CLOSED');
  });

  it('refuses a new revision after the deadline, because nobody has time to use one', () => {
    const error = throwsCode(
      () => enquiry.composeRevision(asQS(), enquiryId, { documents: completePack('C') }),
      'ENQUIRY_CLOSED',
    );
    assert.match(String(error.message), /nobody still pricing it has time to use one/);
  });

  /** `AC-T-WF-04-03`. Not refused — refusing only moves the decision into an email. */
  it('accepts a late return under a named authority', () => {
    const result = enquiry.acceptLateReturn(asPM(), enquiryId, {
      partyId: BALFOUR,
      reason: 'Portal outage between 11:40 and 12:20 confirmed by the client’s IT',
      authority: 'Commercial Manager under delegated authority DA-04',
    });
    const row = enquiry.enquiryPosition(asQS()).enquiries.find((e) => e.packageReference === 'PKG-EXT')!;
    assert.equal(row.lateReturns, 1);
    // Measured against the stated deadline and deliberately not clamped. The
    // demo deadline is in the future, so this is negative — which is the honest
    // reading: the return period was closed before the date it published, and
    // clamping it to zero would report the return as exactly on time.
    assert.ok(result.minutesAfterDeadline < 0, 'the figure was clamped, hiding an early close');
  });

  it('refuses a late return with no reason and no authority', () => {
    const error = throwsCode(
      () => enquiry.acceptLateReturn(asPM(), enquiryId, { partyId: AMEY, reason: '', authority: '' }),
      'AUTHORITY_REQUIRED',
    );
    assert.match(String(error.message), /who decided this one did not have to/);
  });

  it('refuses the same late return twice', () => {
    throwsCode(
      () => enquiry.acceptLateReturn(asPM(), enquiryId, { partyId: BALFOUR, reason: 'again', authority: 'again' }),
      'ALREADY_ACCEPTED',
    );
  });

  it('has nothing to accept while the returns are still open', () => {
    const open = enquiry.openEnquiry(asQS(), {
      packageReference: 'PKG-OPEN',
      title: 'Still open',
      returnDeadline: '2027-06-04T12:00:00.000Z',
    }).enquiryId;
    enquiry.composeRevision(asQS(), open, { documents: completePack() });
    enquiry.approveRevision(asPM(), open);
    enquiry.issueTo(asQS(), open, { recipients: [{ partyId: AMEY, name: 'Amey' }] });
    throwsCode(
      () => enquiry.acceptLateReturn(asPM(), open, { partyId: AMEY, reason: 'x', authority: 'y' }),
      'RETURNS_STILL_OPEN',
    );
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('enquiry · what the catalogue says', () => {
  it('lets an agent assemble a pack and never lets one approve or issue it', () => {
    assert.equal(lookupEventType('ENQUIRY_PACK_REVISED')?.aiAllowed, true);
    assert.equal(lookupEventType('ENQUIRY_PACK_APPROVED')?.aiAllowed, false);
    assert.equal(lookupEventType('ENQUIRY_ISSUED')?.aiAllowed, false);
    assert.equal(lookupEventType('LATE_RETURN_ACCEPTED')?.aiAllowed, false);
  });

  it('requires evidence of what went out and to whom', () => {
    assert.equal(lookupEventType('ENQUIRY_ISSUED')?.requiresEvidence, true);
    assert.equal(lookupEventType('ENQUIRY_ISSUED')?.action, 'ISSUE');
  });

  it('classifies the enquiry as commercial, because the distribution is the field', () => {
    const classification = classifyEntity('Enquiry');
    assert.equal(classification?.area, 'PROCUREMENT_AWARD');
    assert.equal(classification?.sensitivity, 'COMMERCIAL_L3');
  });
});
