import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as business from '../src/domain/business.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as engagements from '../src/domain/bidon/engagements.ts';
import * as bids from '../src/domain/bidon/bids.ts';
import * as importing from '../src/domain/bidon/importing.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import type { CriterionScores } from '../src/domain/bidon/rubric.ts';

/**
 * Importing a tender the standard section already holds, and resyncing it.
 *
 * The specification's acceptance criteria, in its own words:
 *
 *   - *"importing a standard tender creates a parsed bid without re-uploading
 *     files"*
 *   - *"a change event from the standard section shows a 'source updated'
 *     banner in Bid-On; nothing re-parses until a user clicks resync, so
 *     approved answers are never overwritten silently"*
 *   - *"the user must already have read access to that tender in the standard
 *     section"*
 *   - and the other half of the same criterion, covered in `bidonbid.test.ts`:
 *     a bid started here never appears in the standard Tenders section
 *
 * The one this suite exists to pin down hardest is the third sentence of the
 * second: **approved answers survive a resync.** A resync that silently
 * replaced an approved answer with a draft would be a button nobody dares
 * press, and a feature nobody presses is a feature that does not exist.
 */

let platform: Platform;
let seed: SeedResult;

const asProviderAdmin = (): EngineContext =>
  platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
const asBidWriter = (): EngineContext =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/**
 * A token issued for Bid-On and nothing else.
 *
 * The reachable form of the specification's access rule. Every *role* that
 * carries `BID_SERVICES` also carries `ESTIMATE_TENDER` `R` today, so a person
 * at a seat passes both checks — but the scopes differ, and an integration
 * token scoped to this module must not become a way around the standard
 * section's own permissions.
 */
const asBidOnlyToken = (): EngineContext =>
  platform.context(
    { ...seed.users.owner!.auth, scopes: ['bidservices:read', 'bidservices:write'] },
    `${seed.tenantId}-governance`,
    { source: 'WEB' },
  );

const REASONS: Record<string, string> = {
  COMPLIANCE: 'Every part of the question is answered in the order asked',
  EVIDENCE: 'Each claim is cited to an in-date item',
  BUYER_RELEVANCE: 'Framed for a water buyer and the scheme',
  SPECIFICITY: 'Names the scheme, the figures and the dates',
  CLARITY_AND_LIMITS: 'Inside the word limit and plainly written',
};

const FULL: CriterionScores = {
  COMPLIANCE: 90,
  EVIDENCE: 90,
  BUYER_RELEVANCE: 90,
  SPECIFICITY: 90,
  CLARITY_AND_LIMITS: 90,
};

let customer: customers.CustomerAccount;
let engagement: engagements.Engagement;
/** A second customer the bid writer is deliberately not assigned to. */
let rival: customers.CustomerAccount;
let rivalEngagement: engagements.Engagement;
let tenderId: string;

/** The questionnaire itself, already in the evidence store at its own address. */
const QUESTIONNAIRE_HASH = `sha256:${'b'.repeat(64)}`;

/** Record an invitation in the standard section, the way that section does. */
function recordTender(input: {
  title: string;
  clientName: string;
  reference: string;
  returnLocal: string;
  documents: string[];
}): string {
  const opportunity = business.registerOpportunity(asProviderAdmin(), {
    title: input.title,
    clientName: input.clientName,
    sectorType: 'UTILITIES',
    estimatedValueMinor: 48_000_000,
    source: 'AMP8 framework',
    submissionDueAt: input.returnLocal.slice(0, 10),
    countryCode: 'GB',
    city: 'Halifax',
  });
  const invitation = tenderintake.recordInvitation(asProviderAdmin(), opportunity.opportunityId, {
    reference: input.reference,
    issuedAt: '2027-01-04T09:00:00Z',
    returnLocal: input.returnLocal,
    timeZone: 'Europe/London',
    timeZoneStated: true,
    channel: 'PORTAL',
    documents: input.documents,
  });
  return invitation.invitationId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    agreementRef: 'AGR-BIDON-2026-001',
    decidedBy: seed.users.operator!.id,
  });

  customer = customers.openCustomer(asProviderAdmin(), { legalName: 'Thornhill Electrical Services Ltd' });
  customers.assignStaff(asProviderAdmin(), customer.id, { add: [asBidWriter().auth.actorId] });
  engagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: customer.id,
    name: 'Spillway ITT support',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 250_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), engagement.id);

  rival = customers.openCustomer(asProviderAdmin(), { legalName: 'Calder Civils Ltd' });
  rivalEngagement = engagements.openEngagement(asProviderAdmin(), {
    customerAccountId: rival.id,
    name: 'Same framework, other side',
    type: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    feeMinor: 250_000,
    currency: 'GBP',
  });
  engagements.activateEngagement(asProviderAdmin(), rivalEngagement.id);

  tenderId = recordTender({
    title: 'Hebden flood alleviation, phase two',
    clientName: 'Yorkshire Water Services Limited',
    reference: 'YW/AMP8/L3/2027/HEB-002',
    returnLocal: '2027-06-01T12:00',
    documents: ['Selection questionnaire, rev A', 'Instructions to tenderers', 'Pricing schedule'],
  });

  // The pack as a file, filed against the invitation the way the standard
  // section files one. This is what the import can actually carry — the
  // `documents` list above is the transmittal's own wording and nothing a
  // parser could read.
  tenderintake.recordTenderDocument(asProviderAdmin(), {
    hash: QUESTIONNAIRE_HASH,
    filename: 'selection-questionnaire-rev-a.pdf',
    invitationId: tenderId,
  });
});

describe('import and resync are wired into the platform', () => {
  it('routes every act, and neither act is open to an agent', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/bid-on/importable-tenders'],
      ['POST', '/v1/bid-on/bids/import'],
      ['GET', '/v1/bid-on/bids/:bidId/source'],
      ['POST', '/v1/bid-on/bids/:bidId/resync'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route`,
      );
    }

    // An import decides that a tender is this customer's work, and a resync
    // decides that a buyer's reworded question invalidates an answer somebody
    // approved. Neither is clerical, so neither carries an agent mandate.
    for (const type of ['BID_ON_BID_IMPORTED', 'BID_ON_BID_RESYNCED']) {
      assert.equal(lookupEventType(type)?.aiAllowed, false, `${type} is open to an agent`);
      assert.equal(lookupEventType(type)?.entity, 'BidOnBid');
    }
  });

  it('declares the import POST before the :bidId patterns, so the router reaches it', () => {
    // The router is first match wins on segment count with no preference for a
    // literal segment. `POST /v1/bid-on/bids/import` and a future
    // `POST /v1/bid-on/bids/:bidId` are the same shape, so order decides which
    // one answers — and the failure mode is an import silently handled as
    // something else.
    const patterns = ROUTES.filter(
      (route) => route.method === 'POST' && route.pattern.startsWith('/v1/bid-on/bids/'),
    ).map((route) => route.pattern);
    const importAt = patterns.indexOf('/v1/bid-on/bids/import');
    assert.ok(importAt >= 0);
    const shadowed = patterns.findIndex(
      (pattern) => pattern.split('/').length === 5 && pattern.endsWith('/:bidId'),
    );
    assert.ok(shadowed === -1 || shadowed > importAt, 'a :bidId pattern is declared ahead of the import path');
  });
});

describe('the tender section’s own permissions still apply', () => {
  it('refuses a token scoped to Bid-On, because the tenders are not this module’s records', () => {
    const listing = throwsCode(() => importing.importableTenders(asBidOnlyToken()), 'ACCESS_DENIED');
    // Named, so the refusal is answerable: the tender register is read under
    // `commercial:read`, which a token issued for Bid-On does not carry.
    assert.match(String(listing.message), /commercial:read/);
    throwsCode(
      () => importing.importBid(asBidOnlyToken(), { tenderId, engagementId: engagement.id }),
      'ACCESS_DENIED',
    );
  });

  it('is a 404 rather than a denial for a tender that is not in this tenancy', () => {
    const refusal = throwsCode(
      () => importing.importBid(asProviderAdmin(), { tenderId: 'not-a-tender', engagementId: engagement.id }),
      'BID_ON_TENDER_NOT_FOUND',
    );
    assert.match(String(refusal.message), /tenancy/i);
  });

  it('refuses the whole screen to a tenancy that was never allocated the module', () => {
    const ungranted = (): EngineContext => ({ ...asProviderAdmin(), grantedModules: [], heldModules: [] });
    throwsCode(() => importing.importableTenders(ungranted()), 'MODULE_NOT_GRANTED');
  });
});

describe('importing a standard tender creates a bid without re-uploading files', () => {
  it('lists the invitation, and says importing is a shortcut rather than a requirement', () => {
    const position = importing.importableTenders(asProviderAdmin());
    const tender = position.tenders.find((entry) => entry.tenderId === tenderId);
    assert.ok(tender, 'the recorded invitation is not importable');
    assert.equal(tender.reference, 'YW/AMP8/L3/2027/HEB-002');
    assert.equal(tender.clientName, 'Yorkshire Water Services Limited');
    assert.equal(tender.deadline, '2027-06-01');
    assert.equal(tender.documents.length, 3);
    // Three descriptions and one file: the transmittal's list is words, and a
    // description is not something a parser can read.
    assert.equal(tender.files, 1);
    assert.deepEqual(tender.importedAs, []);
    assert.ok(position.limits.some((line) => /never writes to the tender/i.test(line)));
  });

  it('says plainly when a tender has only a list of names and no file', () => {
    const paperOnly = recordTender({
      title: 'Todmorden pumping station, emailed pack',
      clientName: 'Yorkshire Water Services Limited',
      reference: 'YW/AMP8/L3/2027/TOD-003',
      returnLocal: '2027-11-02T12:00',
      documents: ['Selection questionnaire, as pasted into the email'],
    });

    const position = importing.importableTenders(asProviderAdmin());
    assert.equal(position.tenders.find((entry) => entry.tenderId === paperOnly)!.files, 0);
    assert.ok(
      position.limits.some((line) => /still has to be given to the parser/i.test(line)),
      'the screen implies a file came over when none did',
    );

    const result = importing.importBid(asProviderAdmin(), {
      tenderId: paperOnly,
      engagementId: engagement.id,
    });
    assert.deepEqual(result.files, []);
    assert.equal(result.bid.sourceFiles, undefined);
    // Said at the moment somebody imports, rather than discovered when the
    // parse refuses for having nothing to read.
    assert.match(result.note, /still has to be given to the parser/i);
  });

  it('copies the fields and the documents, and carries the deadline over', () => {
    const { bid, copied, files, note } = importing.importBid(asProviderAdmin(), {
      tenderId,
      engagementId: engagement.id,
    });

    // The point of importing: a hash the evidence store already holds, which
    // `parseQuestionnaire` takes, so nothing is uploaded a second time.
    assert.equal(files.length, 1);
    assert.equal(files[0]!.hash, QUESTIONNAIRE_HASH);
    assert.deepEqual(bid.sourceFiles, files);
    assert.match(note, /nothing has to be uploaded again/i);

    assert.equal(bid.sourceTenderId, tenderId);
    assert.equal(bid.buyerName, 'Yorkshire Water Services Limited');
    assert.equal(bid.buyerReference, 'YW/AMP8/L3/2027/HEB-002');
    // The buyer reads it on the day the invitation says, and every
    // certificate-expiry verdict in the pack is judged against that date.
    assert.equal(bid.deadline, '2027-06-01');
    assert.equal(bid.scheme, 'ITT');

    // Carried over by the names the transmittal recorded — nothing was asked
    // for a second time.
    assert.equal(copied.length, 3);
    assert.deepEqual(bid.sourceDocuments, copied);
    assert.equal(bid.sourceDigest?.addenda, 0);
    assert.equal(bid.sourceDigest?.files, 1);
    assert.ok(bid.sourceDigest?.takenAt);

    // The question list is still empty and still has to be confirmed by a
    // person. Importing is not parsing: it moves the documents, and the parse
    // is an agent run with a cost and a confirmation of its own.
    assert.equal(bid.questions.length, 0);
    assert.equal(bid.status, 'CREATED');
  });

  it('never writes to the source tender', () => {
    // Read before and after, by version and state hash, because "one-way" is
    // the load-bearing decision and the only honest way to check it is to show
    // the record did not move.
    const before = platform.ledger.require({ refType: 'TenderInvitation', refId: tenderId });
    const bid = importing.importBid(asProviderAdmin(), { tenderId, engagementId: engagement.id }).bid;
    importing.resyncBid(asProviderAdmin(), bid.id);
    const after = platform.ledger.require({ refType: 'TenderInvitation', refId: tenderId });

    assert.equal(after.version, before.version);
    assert.equal(after.stateHash, before.stateHash);
  });

  it('allows a second import off one invitation, and says what already exists', () => {
    const position = importing.importableTenders(asProviderAdmin());
    const tender = position.tenders.find((entry) => entry.tenderId === tenderId)!;
    // A prequalification stage and a later ITT stage are two bids off one
    // invitation, so a duplicate is not refused — it is shown.
    assert.ok(tender.importedAs.length >= 2);
    assert.ok(
      position.limits.some((line) => /already been imported/i.test(line)),
      'the screen does not say a tender is already imported',
    );
  });

  it('refuses an import against an engagement that is not open for work', () => {
    const paused = engagements.openEngagement(asProviderAdmin(), {
      customerAccountId: customer.id,
      name: 'Never activated',
      type: 'ONE_OFF',
      billingBasis: 'FIXED_FEE',
      feeMinor: 100_000,
      currency: 'GBP',
    });
    throwsCode(
      () => importing.importBid(asProviderAdmin(), { tenderId, engagementId: paused.id }),
      'BID_ON_ENGAGEMENT_NOT_OPEN',
    );
  });

  it('refuses an import that would carry nothing over', () => {
    throwsCode(
      () =>
        importing.importBid(asProviderAdmin(), {
          tenderId,
          engagementId: engagement.id,
          documentIds: ['A document this invitation does not have'],
        }),
      'BID_ON_DOCUMENTS_NOT_FOUND',
    );
  });

  it('carries over only the named documents where some are named', () => {
    const { bid, copied } = importing.importBid(asProviderAdmin(), {
      tenderId,
      engagementId: engagement.id,
      documentIds: ['Pricing schedule'],
      scheme: 'SQ_PA23',
    });
    assert.deepEqual(copied, ['Pricing schedule']);
    assert.deepEqual(bid.sourceDigest?.documents, ['Pricing schedule']);
    assert.equal(bid.scheme, 'SQ_PA23');
  });
});

describe('a bid started here has no source to drift from', () => {
  it('says so rather than reporting drift against nothing', () => {
    const standalone = bids.createBid(asProviderAdmin(), {
      engagementId: engagement.id,
      buyerName: 'National Grid Electricity Transmission',
      scheme: 'UVDB',
      deadline: '2027-07-01',
    });
    const standing = importing.sourceStanding(asProviderAdmin(), standalone.id);
    assert.equal(standing.linked, false);
    assert.match(standing.note, /never appears in the standard Tenders section/i);

    throwsCode(() => importing.resyncBid(asProviderAdmin(), standalone.id), 'BID_ON_NOT_IMPORTED');
  });
});

describe('a change at source is a banner, not a re-parse', () => {
  let bid: bids.Bid;
  let movedTender: string;

  before(() => {
    movedTender = recordTender({
      title: 'Ryburn valve house refurbishment',
      clientName: 'Yorkshire Water Services Limited',
      reference: 'YW/AMP8/L3/2027/RYB-009',
      returnLocal: '2027-08-02T12:00',
      documents: ['Selection questionnaire, rev A', 'Instructions to tenderers'],
    });
    bid = importing.importBid(asProviderAdmin(), {
      tenderId: movedTender,
      engagementId: engagement.id,
    }).bid;
  });

  it('reads as unchanged while the tender has not moved', () => {
    const standing = importing.sourceStanding(asProviderAdmin(), bid.id);
    assert.equal(standing.linked, true);
    assert.equal(standing.changed, undefined);
    assert.match(standing.note, /Unchanged since it was imported/);
  });

  it('shows what moved, and re-parses nothing', () => {
    tenderintake.issueAddendum(asProviderAdmin(), movedTender, {
      reference: 'ADD-01',
      issuedAt: '2027-02-01T09:00:00Z',
      summary: 'Return deadline extended by two weeks following bidder questions on the drawdown window.',
      returnLocal: '2027-08-16T12:00',
    });

    const standing = importing.sourceStanding(asProviderAdmin(), bid.id);
    assert.equal(standing.linked, true);
    const moved = standing.changed ?? [];
    assert.ok(moved.some((entry) => entry.field === 'deadline' && entry.now === '2027-08-16'));
    assert.ok(moved.some((entry) => entry.field === 'addenda' && entry.now === '1'));
    assert.match(standing.note, /Nothing has re-parsed/);

    // The bid itself has not moved. That is the whole point of the banner: a
    // bid in progress must not change underneath somebody.
    const stored = bids.requireBid(asProviderAdmin(), bid.id);
    assert.equal(stored.deadline, '2027-08-02');
    assert.equal(stored.sourceDigest?.deadline, '2027-08-02');
  });

  it('puts the banner on the module screen, so it is not found by accident', () => {
    const position = importing.importableTenders(asProviderAdmin());
    const tender = position.tenders.find((entry) => entry.tenderId === movedTender)!;
    const entry = tender.importedAs.find((row) => row.bidId === bid.id)!;
    assert.equal(entry.sourceChanged, true);
    assert.ok(entry.changed.some((move) => move.field === 'deadline'));
    assert.ok(
      position.limits.some((line) => /has since changed/i.test(line)),
      'the register does not say a reading is out of date',
    );
  });

  it('treats a file registered after the import as a reason to resync, and carries it', () => {
    const late = `sha256:${'c'.repeat(64)}`;
    tenderintake.recordTenderDocument(asProviderAdmin(), {
      hash: late,
      filename: 'questionnaire-as-issued.pdf',
      invitationId: movedTender,
    });

    // A hash the store already holds is the whole reason an import is worth
    // doing, and one that arrived a week later is worth exactly as much —
    // nothing else would ever tell somebody it had turned up.
    const standing = importing.sourceStanding(asProviderAdmin(), bid.id);
    assert.ok((standing.changed ?? []).some((entry) => entry.field === 'files'));

    const resynced = importing.resyncBid(asProviderAdmin(), bid.id);
    assert.deepEqual(resynced.bid.sourceFiles?.map((file) => file.hash), [late]);
    assert.equal(resynced.bid.sourceDigest?.files, 1);
    assert.equal(importing.sourceStanding(asProviderAdmin(), bid.id).changed, undefined);
  });
});

describe('a resync keeps approved answers and redrafts only what the buyer reworded', () => {
  let bid: bids.Bid;
  let resyncTender: string;

  const approve = (bidId: string, questionId: string, body: string[]) => {
    const written = bids.recordAnswer(asBidWriter(), bidId, { questionId, body });
    bids.scoreAnswer(asProviderAdmin(), bidId, written.answer.id, { scores: FULL, reasons: REASONS });
    bids.approveAnswer(asProviderAdmin(), bidId, written.answer.id, {
      note: 'Read against the question and the cited evidence; it answers what was asked.',
    });
    return written.answer.id;
  };

  before(() => {
    resyncTender = recordTender({
      title: 'Walshaw intake screens replacement',
      clientName: 'Yorkshire Water Services Limited',
      reference: 'YW/AMP8/L3/2027/WAL-021',
      returnLocal: '2027-09-01T12:00',
      documents: ['Selection questionnaire, rev A'],
    });
    bid = importing.importBid(asProviderAdmin(), {
      tenderId: resyncTender,
      engagementId: engagement.id,
    }).bid;

    bids.confirmQuestions(asProviderAdmin(), bid.id, {
      questions: [
        {
          section: 'Health and safety',
          number: 'Q1',
          text: 'Describe your health and safety management arrangements.',
          answerType: 'TEXT',
          mandatory: true,
          passFail: false,
        },
        {
          section: 'Social value',
          number: 'Q2',
          text: 'Describe your approach to local employment.',
          answerType: 'TEXT',
          mandatory: true,
          passFail: false,
        },
      ],
    });

    const questions = bids.requireBid(asProviderAdmin(), bid.id).questions;
    approve(bid.id, questions[0]!.id, ['Our arrangements are reviewed annually by the board.']);
    approve(bid.id, questions[1]!.id, ['We take two apprentices on every scheme over one million pounds.']);
  });

  it('reopens the reworded question only, and keeps every version', () => {
    const before = bids.requireBid(asProviderAdmin(), bid.id);
    assert.equal(before.answers.filter((answer) => answer.status === 'APPROVED').length, 2);

    const result = importing.resyncBid(asProviderAdmin(), bid.id, {
      questions: [
        // Byte-for-byte what the buyer already asked. A question whose number
        // moved or whose heading was retyped is the same question.
        { number: 'Q1', text: 'Describe your health and safety management arrangements.' },
        // Genuinely reworded, and now asks for something the approved answer
        // does not contain.
        {
          number: 'Q2',
          text: 'Describe your approach to local employment, with the figures for the last three years.',
        },
      ],
    });

    assert.deepEqual(result.rewordedQuestions, ['Q2']);
    assert.equal(result.answersReopened, 1);

    const after = bids.requireBid(asProviderAdmin(), bid.id);
    // Nothing deleted: the answer approved against the old wording is what a
    // dispute about the old wording would turn on.
    assert.equal(after.answers.length, before.answers.length);

    const q1 = after.questions.find((question) => question.number === 'Q1')!;
    const q2 = after.questions.find((question) => question.number === 'Q2')!;
    assert.equal(bids.latestAnswer(after, q1.id)?.status, 'APPROVED');
    assert.equal(bids.latestAnswer(after, q2.id)?.status, 'IN_REVIEW');
    assert.match(String(bids.latestAnswer(after, q2.id)?.reviewNote), /reworded this question after it was approved/);

    // The new wording is what a reviewer now reads it against.
    assert.match(q2.text, /figures for the last three years/);
    assert.equal(after.status, 'DRAFTING');
  });

  it('takes the deadline and the document list with nothing reworded', () => {
    tenderintake.issueAddendum(asProviderAdmin(), resyncTender, {
      reference: 'ADD-01',
      issuedAt: '2027-03-01T09:00:00Z',
      summary: 'Return deadline brought forward one week at the client’s request.',
      returnLocal: '2027-08-25T12:00',
    });

    const result = importing.resyncBid(asProviderAdmin(), bid.id);
    assert.deepEqual(result.rewordedQuestions, []);
    assert.equal(result.answersReopened, 0);
    assert.match(result.note, /Nothing was reworded/);

    // The deadline follows the source, because a stale one scores every
    // certificate in the pack against a date the buyer has moved.
    const after = bids.requireBid(asProviderAdmin(), bid.id);
    assert.equal(after.deadline, '2027-08-25');
    assert.equal(after.sourceDigest?.deadline, '2027-08-25');
    // And the approved answer is still approved.
    const q1 = after.questions.find((question) => question.number === 'Q1')!;
    assert.equal(bids.latestAnswer(after, q1.id)?.status, 'APPROVED');

    // Nothing is outstanding any more, so the banner is gone.
    assert.equal(importing.sourceStanding(asProviderAdmin(), bid.id).changed, undefined);
  });

  it('refuses a resync while the engagement is paused', () => {
    // A pause means every bid stays exactly where it was. A resync moves the
    // deadline and reopens answers, so it is a change to the work rather than
    // record-keeping about it.
    engagements.pauseEngagement(asProviderAdmin(), engagement.id, {
      reason: 'The customer has asked us to hold while they decide on the framework.',
    });
    throwsCode(() => importing.resyncBid(asProviderAdmin(), bid.id), 'BID_ON_ENGAGEMENT_NOT_OPEN');
    engagements.resumeEngagement(asProviderAdmin(), engagement.id);
    // And it works again once the engagement is open, so the pause is a pause
    // rather than a one-way door.
    assert.deepEqual(importing.resyncBid(asProviderAdmin(), bid.id).rewordedQuestions, []);
  });

  it('refuses a resync on a pack that has gone to a buyer', () => {
    const sent = importing.importBid(asProviderAdmin(), {
      tenderId: resyncTender,
      engagementId: engagement.id,
    }).bid;
    bids.confirmQuestions(asProviderAdmin(), sent.id, {
      questions: [
        {
          section: 'Health and safety',
          number: 'Q1',
          text: 'Describe your health and safety management arrangements.',
          answerType: 'TEXT',
          mandatory: true,
          passFail: false,
        },
      ],
    });
    const question = bids.requireBid(asProviderAdmin(), sent.id).questions[0]!;
    approve(sent.id, question.id, ['Our arrangements are reviewed annually by the board.']);
    bids.exportBid(asProviderAdmin(), sent.id);

    const refusal = throwsCode(() => importing.resyncBid(asProviderAdmin(), sent.id), 'BID_ON_BID_SENT');
    assert.match(String(refusal.message), /what was sent/i);
  });
});

describe('the imported column respects the wall between customers', () => {
  it('does not name a bid belonging to a customer this person is not assigned to', () => {
    const wallTender = recordTender({
      title: 'Elland washlands culvert',
      clientName: 'Calderdale Council',
      reference: 'CMBC/2027/ELL-004',
      returnLocal: '2027-10-01T12:00',
      documents: ['Selection questionnaire'],
    });

    // Both providers' customers chase the same framework, which is the whole
    // reason the wall exists.
    const mine = importing.importBid(asProviderAdmin(), {
      tenderId: wallTender,
      engagementId: engagement.id,
    }).bid;
    const theirs = importing.importBid(asProviderAdmin(), {
      tenderId: wallTender,
      engagementId: rivalEngagement.id,
    }).bid;

    const writerView = importing.importableTenders(asBidWriter());
    const tender = writerView.tenders.find((entry) => entry.tenderId === wallTender)!;
    const named = tender.importedAs.map((entry) => entry.bidId);
    assert.ok(named.includes(mine.id), 'the writer cannot see their own customer’s bid');
    assert.ok(
      !named.includes(theirs.id),
      'a bid for a customer the writer is not assigned to is named in the imported column',
    );

    // Said rather than hidden. "Already imported" reading as empty when it is
    // not would send somebody into a duplicate they cannot see.
    assert.ok(
      writerView.limits.some((line) => /not assigned to/i.test(line)),
      'the screen does not say what it is leaving out',
    );

    // The director, who opened both, sees both.
    const adminView = importing.importableTenders(asProviderAdmin());
    const adminTender = adminView.tenders.find((entry) => entry.tenderId === wallTender)!;
    assert.equal(adminTender.importedAs.length, 2);
  });
});
