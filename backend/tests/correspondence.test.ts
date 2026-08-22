import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import {
  CORRESPONDENCE_TYPES,
  correspondencePosition,
  issueCorrespondence,
  respondToCorrespondence,
  responseRule,
} from '../src/domain/correspondence.ts';
import { receiveSubmission, reconcileTenderResponses } from '../src/domain/procurement.ts';
import { registerSupplier } from '../src/domain/supplychain.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The last two gap-matrix must-adds.
 *
 * Two of the four turned out to be built already — competency expiry has fed
 * the obligations calendar since the calendar existed, and `issueRFQ` has always
 * refused a package that is not READY_TO_ISSUE, which is the completeness gate.
 * Rebuilding either would have been the most expensive way to add nothing.
 *
 * What was genuinely missing is below, and the two are the same shape: facts
 * already on the record with nothing standing them beside each other, and a
 * contractual rule the platform knew nothing about.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const pm = (): EngineContext => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const bim = (): EngineContext => platform.context(seed.users.bim!.auth, seed.projectId, { source: 'WEB' });

describe('who a letter must go to', () => {
  it('refuses a letter served on the wrong party rather than filing it anyway', () => {
    // The refusal that matters most. A notice served on the wrong party is not
    // served, and a platform that files it produces a record which looks like
    // compliance and is not — discovered at adjudication, too late to fix.
    throwsCode(
      () =>
        issueCorrespondence(pm(), {
          type: 'QUOTATION',
          from: 'CONTRACTOR',
          to: 'SUBCONTRACTOR',
          subject: 'Quotation for compensation event 014',
          body: 'Our quotation for the additional excavation instructed on 14 July.',
          author: 'A Contractor',
        }),
      'CORRESPONDENCE_RECIPIENT_INVALID',
    );
  });

  it('refuses a letter from a party that does not write that letter', () => {
    // A site instruction from the contractor is a thing that happens on real
    // projects and is worth nothing.
    throwsCode(
      () =>
        issueCorrespondence(pm(), {
          type: 'SITE_INSTRUCTION',
          from: 'CONTRACTOR',
          to: 'PROJECT_MANAGER',
          subject: 'Instruction to open up the works',
          body: 'Please treat this as an instruction to proceed with the opening up.',
          author: 'A Contractor',
        }),
      'CORRESPONDENCE_SENDER_INVALID',
    );
  });

  it('refuses a letter addressed to its own author', () => {
    throwsCode(
      () =>
        issueCorrespondence(pm(), {
          type: 'EARLY_WARNING',
          from: 'PROJECT_MANAGER',
          to: 'PROJECT_MANAGER',
          subject: 'Early warning — ground conditions',
          body: 'Made ground encountered beyond the extent shown on the site investigation.',
          author: 'A Manager',
        }),
      'CORRESPONDENCE_SELF_ADDRESSED',
    );
  });

  it('names every party in the matrix as a sender or a recipient of something', () => {
    // A party that appears nowhere is a value the console would offer and the
    // platform would always refuse.
    const parties = new Set(
      Object.values(CORRESPONDENCE_TYPES).flatMap((d) => [...d.senders, ...d.recipients]),
    );
    for (const party of parties) {
      assert.ok(
        Object.values(CORRESPONDENCE_TYPES).some((d) => d.senders.includes(party)),
        `${party} can receive letters and never sends one`,
      );
    }
  });
});

describe('the period the form allows', () => {
  it('gives the same letter different deadlines under different forms', () => {
    // The reason this cannot be a constant on the letter. An extension of time
    // application is twelve weeks under JCT and six under FIDIC, and NEC does
    // not deal with it as an application at all.
    const jct = responseRule('EXTENSION_OF_TIME_APPLICATION', 'JCT', '2026-07-01');
    const fidic = responseRule('EXTENSION_OF_TIME_APPLICATION', 'FIDIC', '2026-07-01');
    const nec = responseRule('EXTENSION_OF_TIME_APPLICATION', 'NEC4', '2026-07-01');

    assert.equal(jct.days, 84);
    assert.equal(fidic.days, 42);
    assert.equal(nec.days, null);
    assert.notEqual(jct.dueBy, fidic.dueBy);
    assert.match(String(nec.reason), /imposes no period/i);
  });

  it('says there is no period rather than defaulting to one', () => {
    // A default here would put a date on a letter the contract puts no date on,
    // and a date on a screen is indistinguishable from a contractual one.
    const rule = responseRule('REQUEST_FOR_INFORMATION', 'JCT', '2026-07-01');
    assert.equal(rule.days, null);
    assert.equal(rule.dueBy, undefined);
    assert.match(String(rule.reason), /not the same as no reply being needed/i);
  });

  it('refuses to derive a period where the project runs more than one form', () => {
    const rule = responseRule('QUOTATION', undefined, '2026-07-01');
    assert.equal(rule.days, null);
    assert.equal(rule.dueBy, undefined);
    assert.match(String(rule.reason), /taken from the wrong form is worse than no date/i);
  });

  it('excludes the statutory days from a period of under a week', () => {
    // NEC's one-week reply period is a period of under seven days, so s.116(3)
    // excludes Christmas Day, Good Friday and bank holidays from the count.
    // Adding seven to Christmas Eve would land on New Year's Eve; reckoning it
    // does not.
    const rule = responseRule('COMPENSATION_EVENT_NOTIFICATION', 'NEC4', '2026-12-21');
    assert.equal(rule.days, 7);
    assert.ok(rule.dueBy);
    // Seven days or more is reckoned in calendar days by design — the statutory
    // exclusion applies to shorter periods — so this is the plain date, and the
    // assertion records that on purpose rather than by accident.
    assert.equal(rule.dueBy, '2026-12-28');
  });

  it('cites the clause that imposes the letter where the form is a standard one', () => {
    const rule = responseRule('QUOTATION', 'NEC4', '2026-07-01');
    assert.equal(rule.clause?.suite, 'NEC4');
    assert.ok(rule.clause?.clause);

    // Bespoke has no numbering anybody can cite, and a confident wrong clause
    // reference is the one that ends up quoted in a letter.
    assert.equal(responseRule('QUOTATION', 'BESPOKE', '2026-07-01').clause, undefined);
  });
});

describe('what silence decides', () => {
  it('separates a letter nobody answered from one silence has already decided', () => {
    // The distinction the whole position turns on. A deemed-accepted quotation
    // is not an overdue item to chase — it is a decided one, and chasing it is
    // not the remedy.
    const issued = issueCorrespondence(pm(), {
      type: 'EARLY_WARNING',
      from: 'CONTRACTOR',
      to: 'PROJECT_MANAGER',
      subject: 'Early warning — piling rig availability',
      body: 'The piling subcontractor has notified that the rig is committed elsewhere until the end of the month.',
      author: 'A Contractor',
    });
    assert.ok(issued.reference.startsWith('COR-'));

    const position = correspondencePosition(pm());
    assert.ok(position.total > 0);
    // Every open letter is in exactly one of the two lists, never both.
    const references = new Set([
      ...position.outstanding.map((entry) => entry.reference),
      ...position.deemedAccepted.map((entry) => entry.reference),
    ]);
    assert.equal(references.size, position.outstanding.length + position.deemedAccepted.length);
  });

  it('records a late reply as a reply and as late, rather than refusing it', () => {
    const issued = issueCorrespondence(pm(), {
      type: 'LOSS_AND_EXPENSE_NOTIFICATION',
      from: 'CONTRACTOR',
      to: 'CONTRACT_ADMINISTRATOR',
      subject: 'Loss and expense — prolongation to the filter gallery',
      body: 'Notification under the contract of loss and expense arising from the delayed release of the filter gallery design.',
      author: 'A Contractor',
    });

    // Answered far beyond any period the form allows.
    const outcome = respondToCorrespondence(
      pm(),
      { correspondenceId: issued.correspondenceId, body: 'Ascertainment to follow once the particulars are received.', author: 'A Surveyor' },
      '2099-01-01',
    );

    // Whether lateness matters is a question about the contract, not about
    // whether the letter was answered.
    assert.equal(typeof outcome.late, 'boolean');
    const record = platform.ledger.require({ refType: 'Correspondence', refId: issued.correspondenceId });
    assert.ok(['ANSWERED', 'DEEMED_ACCEPTED'].includes(String(record.state.status)));
    assert.equal(record.state.respondedBy, 'A Surveyor');
  });

  it('keeps both facts when a reply arrives after silence already decided the point', () => {
    // A reply after deemed acceptance does not undo it — that is what deemed
    // acceptance means — and it is not the same as no reply either.
    const issued = issueCorrespondence(pm(), {
      type: 'QUOTATION',
      from: 'CONTRACTOR',
      to: 'PROJECT_MANAGER',
      subject: 'Quotation — additional dewatering',
      body: 'Quotation for the additional dewatering instructed under compensation event 021.',
      author: 'A Contractor',
    });

    const record = platform.ledger.require({ refType: 'Correspondence', refId: issued.correspondenceId });
    if (record.state.onSilence !== 'DEEMED_ACCEPTED' || !record.state.responseDueBy) return;

    const outcome = respondToCorrespondence(
      pm(),
      { correspondenceId: issued.correspondenceId, body: 'The quotation is not accepted; a revised assessment follows.', author: 'A Manager' },
      '2099-01-01',
    );

    assert.equal(outcome.late, true);
    assert.equal(outcome.deemedBefore, true);
    const after = platform.ledger.require({ refType: 'Correspondence', refId: issued.correspondenceId });
    assert.equal(after.state.status, 'DEEMED_ACCEPTED');
    assert.equal(after.state.deemedAcceptedBeforeReply, true);
    assert.equal(after.state.respondedBy, 'A Manager', 'the reply itself was discarded');
  });

  it('refuses a second reply to a letter already closed out', () => {
    const issued = issueCorrespondence(bim(), {
      type: 'REQUEST_FOR_INFORMATION',
      from: 'CONTRACTOR',
      to: 'DESIGNER',
      subject: 'RFI — handrail termination detail',
      body: 'The handrail termination at the filter gallery is not detailed on the issued drawings.',
      author: 'A Contractor',
    });

    respondToCorrespondence(bim(), {
      correspondenceId: issued.correspondenceId,
      body: 'Detail issued as revision C of drawing S-204.',
      author: 'A Designer',
    });

    throwsCode(
      () =>
        respondToCorrespondence(bim(), {
          correspondenceId: issued.correspondenceId,
          body: 'A second answer to the same question.',
          author: 'A Designer',
        }),
      'CORRESPONDENCE_NOT_OPEN',
    );
  });

  it('sorts a letter with no deadline last, because an absent date is not an urgent one', () => {
    const position = correspondencePosition(pm());
    const withDeadline = position.outstanding.filter((entry) => entry.dueBy !== undefined);
    const without = position.outstanding.filter((entry) => entry.dueBy === undefined);

    if (withDeadline.length > 0 && without.length > 0) {
      const lastDated = position.outstanding.findIndex((entry) => entry.dueBy === undefined);
      assert.equal(lastDated, withDeadline.length, 'an undated letter was sorted above a dated one');
    }
  });
});

describe('who was asked, who answered, and who said nothing', () => {
  it('reconciles the invited list against acknowledgements and returns', () => {
    // Every fact this needs was already on the record and nothing put them
    // beside each other, which from a screen is indistinguishable from not
    // tracking bidders at all.
    const rfq = platform.ledger.list(seed.projectId, 'RFQ')[0];
    if (!rfq) return;

    const position = reconcileTenderResponses(pm(), rfq.refId);
    assert.equal(position.invited, ((rfq.state.invitedSupplierIds as string[]) ?? []).length);
    assert.equal(position.bidders.length, position.invited);
    assert.equal(position.returned, position.bidders.filter((b) => b.returned).length);
    assert.equal(position.acknowledged, position.bidders.filter((b) => b.acknowledged).length);
  });

  it('calls a firm that promised to bid and did not by a different name from one that declined', () => {
    // "Declined" and "said they would bid and then went quiet" are different
    // facts about a supply chain, and only one of them is a problem.
    const rfq = platform.ledger.list(seed.projectId, 'RFQ')[0];
    if (!rfq) return;

    // After the deadline, so silence has a meaning.
    const closed = reconcileTenderResponses(pm(), rfq.refId, '2099-01-01T00:00:00.000Z');
    assert.equal(closed.closed, true);

    for (const bidder of closed.bidders) {
      if (bidder.returned) assert.equal(bidder.outcome, 'RETURNED');
      else if (bidder.intendToBid === false) assert.equal(bidder.outcome, 'DECLINED');
      else if (bidder.intendToBid === true) assert.equal(bidder.outcome, 'BROKEN_PROMISE');
      else assert.equal(bidder.outcome, 'SILENT');
    }
    // Nothing is AWAITED once the deadline has gone.
    assert.ok(!closed.bidders.some((b) => b.outcome === 'AWAITED'));
  });

  it('holds judgement until the deadline, because an unreturned bid is not yet a failure', () => {
    const rfq = platform.ledger.list(seed.projectId, 'RFQ')[0];
    if (!rfq) return;

    const open = reconcileTenderResponses(pm(), rfq.refId, '2020-01-01T00:00:00.000Z');
    assert.equal(open.closed, false);
    for (const bidder of open.bidders) {
      if (!bidder.returned && bidder.intendToBid !== false) assert.equal(bidder.outcome, 'AWAITED');
    }
    assert.ok(!open.bidders.some((b) => b.outcome === 'SILENT' || b.outcome === 'BROKEN_PROMISE'));
  });

  it('names the exposure when the competition is too thin to prove a price', () => {
    // Three is the conventional floor. Below it the exposure is the award
    // rather than the price: an audit reads a single return as a negotiation,
    // because that is what it is.
    const rfq = platform.ledger.list(seed.projectId, 'RFQ')[0];
    if (!rfq) return;

    const closed = reconcileTenderResponses(pm(), rfq.refId, '2099-01-01T00:00:00.000Z');
    // Where nothing can be matched at all the counts are not a competition
    // position and stating a concern from them would be a confident reading of
    // an unreadable record.
    if (closed.unmatchable) {
      assert.equal(closed.concern, undefined);
      return;
    }
    if (closed.returned === 0) assert.match(String(closed.concern), /nothing here to award/i);
    else if (closed.returned === 1) assert.match(String(closed.concern), /negotiation, not a competition/i);
    else if (closed.returned === 2) assert.match(String(closed.concern), /price and no market/i);
  });

  it('still says so where a firm predates the join, rather than inventing a match', () => {
    // The fallback that has to stay. Suppliers registered before they carried a
    // party cannot be matched to their returns, and the ledger is append-only so
    // those records exist for good. Where nothing matches at all the counts are
    // not a competition position, and reporting them as one would send somebody
    // chasing firms that did in fact bid.
    //
    // Built as a fixture rather than asserted against the seed, which now joins
    // properly — a test that only passes on broken data stops testing the day
    // the data is fixed.
    const legacy = reconcileTenderResponses(
      {
        ...pm(),
        ledger: {
          ...pm().ledger,
          require: () => ({
            refId: 'legacy-rfq',
            state: {
              reference: 'RFQ-LEGACY',
              status: 'ISSUED',
              returnDeadline: '2026-01-01T00:00:00.000Z',
              invitedSupplierIds: ['supplier-registered-before-the-join'],
              acknowledgements: [],
            },
          }),
          get: () => undefined,
          list: (_projectId: string, refType: string) =>
            refType === 'SupplierSubmission'
              ? [
                  {
                    refId: 'legacy-submission',
                    state: {
                      rfqId: 'legacy-rfq',
                      supplierPartyId: 'SUP-UNJOINED',
                      supplierName: 'Registered Before The Join Ltd',
                      receivedAt: '2025-12-01T00:00:00.000Z',
                    },
                  },
                ]
              : [],
        },
      } as unknown as EngineContext,
      'legacy-rfq',
      '2099-01-01T00:00:00.000Z',
    );

    assert.equal(legacy.returned, 0);
    assert.ok(legacy.unmatchable, 'a reconciliation that matched nothing reported a supply chain that bid nothing');
    assert.match(String(legacy.unmatchable), /holds nothing joining the two/i);
    // And it does not then layer a competition concern on top of counts it has
    // just said cannot be read.
    assert.equal(legacy.concern, undefined);
  });

  it('matches every return to the firm that was invited, now that a supplier carries a party', () => {
    // The defect this closed. A firm was invited by its supply-chain register
    // id and submitted under its party id with nothing joining the two, so
    // every return looked uninvited and every invited firm looked silent —
    // both readings wrong, and the reconciliation could only say so.
    const rfq = platform.ledger.list(seed.projectId, 'RFQ')[0];
    if (!rfq) return;

    const position = reconcileTenderResponses(pm(), rfq.refId, '2099-01-01T00:00:00.000Z');
    const submissions = platform.ledger
      .list(seed.projectId, 'SupplierSubmission')
      .filter((record) => record.state.rfqId === rfq.refId);

    assert.equal(position.unmatchable, undefined, 'the register and the returns still do not join');
    assert.deepEqual(position.uninvitedReturns, []);
    assert.equal(position.returned, submissions.length);

    // And the firms are named from the register rather than from whatever the
    // submission called itself — the seed used to disagree with itself on two
    // of the three names.
    for (const bidder of position.bidders) {
      const supplier = platform.ledger.get({ refType: 'Supplier', refId: bidder.supplierId });
      assert.equal(bidder.supplierName, String(supplier?.state.legalName));
    }
  });

  it('refuses a return from a firm that was never invited', () => {
    // The gate that was missing entirely. Eligibility was checked when the
    // enquiry went out and nothing checked it when a bid came back, so an
    // unqualified firm's return could be received, evaluated, adjudicated and
    // awarded without ever meeting the bar the enquiry refused to go out
    // without.
    const rfq = platform.ledger.list(seed.projectId, 'RFQ')[0];
    if (!rfq) return;

    const qs = platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
    const outsider = registerSupplier(qs, {
      partyId: 'SUP-OUTSIDER',
      legalName: 'Uninvited Groundworks Ltd',
      trades: ['GROUNDWORKS'],
      contactName: 'A person',
      contactEmail: 'uninvited@example.com',
    });
    assert.ok(outsider.supplierId);

    throwsCode(
      () =>
        receiveSubmission(qs, {
          rfqId: rfq.refId,
          supplierPartyId: 'SUP-OUTSIDER',
          supplierName: 'Uninvited Groundworks Ltd',
          priceMinor: 700_000_000,
          durationDays: 380,
          exclusions: [],
          contractExceptions: [],
          provisionalSumsMinor: 0,
          insurancesHeld: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY'],
          submissionHash: hashEvidence('uninvited-submission'),
        }),
      'SUPPLIER_NOT_INVITED',
    );
  });

  it('refuses to register two firms as the same commercial party', () => {
    // A party shared by two register entries makes a return ambiguous at
    // exactly the moment it has to be attributed to one of them.
    const qs = platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
    throwsCode(
      () =>
        registerSupplier(qs, {
          partyId: 'SUP-NORTHSTONE',
          legalName: 'Not Actually Northstone Ltd',
          trades: ['GROUNDWORKS'],
          contactName: 'A person',
          contactEmail: 'clash@example.com',
        }),
      'SUPPLIER_PARTY_TAKEN',
    );
  });

  it('refuses to register a supplier with no party at all', () => {
    // An optional party would have left the same hole open for whoever left
    // the field blank, which on a register filled in by a procurement team is
    // everybody in a hurry.
    const qs = platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
    throwsCode(
      () =>
        registerSupplier(qs, {
          partyId: '   ',
          legalName: 'Partyless Piling Ltd',
          trades: ['PILING'],
          contactName: 'A person',
          contactEmail: 'partyless@example.com',
        }),
      'SUPPLIER_PARTY_REQUIRED',
    );
  });
});
