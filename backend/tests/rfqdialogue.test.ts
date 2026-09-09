import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as procurement from '../src/domain/procurement.ts';
import * as structure from '../src/domain/structure.ts';
import * as supplychain from '../src/domain/supplychain.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The half of an enquiry that belongs to the firm receiving it.
 *
 * `createRFQ`, `issueRFQ`, `receiveSubmission` and `awardRFQ` were routed and
 * tested. `acknowledgeRFQ`, `raiseClarification` and `answerClarification` were
 * written in full — identity checks, invitation checks, refusals — and no route
 * and no test named any of them. So a buyer could issue an enquiry and take a
 * price for it, and the firm receiving the enquiry could not say whether it
 * meant to bid, could not ask a question about the information it had been
 * sent, and could not be answered.
 *
 * Found by asking which exported engine commands nothing anywhere calls, which
 * is a question worth asking of any codebase where the domain layer is written
 * before the surface that reaches it.
 *
 * The sharpest of the three is the last. Answering a bidder privately is how a
 * tender becomes challengeable: the other bidders priced different information,
 * so the returns are not comparable and the award cannot be defended.
 * `answerClarification` refuses it. Until these routes existed, that refusal
 * could not fire — the rule was correct, considered, written down, and
 * unreachable.
 */

let platform: Platform;
let seed: SeedResult;

/**
 * The tender-phase sibling, not the finished project.
 *
 * `answerClarification` authorises `PROCUREMENT_AWARD` `U` against the
 * lifecycle phase, and the demonstration's main project sits in OPERATIONS
 * where procurement is correctly shut. The seed carries a sibling stopped at
 * TENDER for precisely this reason — the first draft of these tests used the
 * finished project and was refused by the platform behaving as designed.
 */
let tenderProjectId: string;

/** Holds PROCUREMENT_AWARD C/U — raises the enquiry and answers questions. */
const asQS = () => platform.context(seed.users.qs!.auth, tenderProjectId, { source: 'WEB' });

/** The finished project, for the two commands that are not phase-gated. */
const asQSOnLive = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const rfqOf = (): string => {
  const rfqs = platform.ledger.list(seed.projectId, 'RFQ');
  assert.ok(rfqs.length > 0, 'the seed no longer creates an RFQ to hold this dialogue against');
  return rfqs[0]!.refId;
};

/**
 * An enquiry on the tender project, built by walking the gates rather than
 * writing round them.
 *
 * The seed leaves that project deliberately empty — the point of it is a
 * register somebody puts the first record into — so every gate on the way to an
 * RFQ has to be satisfied: the firms registered, then prequalified, then the
 * package's design maturity assessed, and only then can it go to market. Each
 * of those refused this fixture in turn, which is the platform working.
 */
let tenderRfqId: string;
let invitedSupplierId: string;

const prequalification = (reference: string) => ({
  identity: { companyNumber: '03456789', companyStatus: 'active', incorporatedOn: '2017-01-01', vatNumber: 'GB123', utr: '1234567890', cisStatus: 'GROSS' as const },
  financial: { turnoverMinorByYear: [2_000_000_00], accountsFiledUpToDate: true },
  insurances: [
    { type: 'PUBLIC_LIABILITY' as const, insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
    { type: 'EMPLOYERS_LIABILITY' as const, insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
  ],
  safetyAccreditations: ['CHAS'],
  qualityAccreditations: ['ISO 45001'],
  riddorLastThreeYears: 0,
  competenceCards: [{ scheme: 'CISRS', holders: 8 }],
  references: [{ clientName: 'C', projectName: 'P', valueMinor: 500_00, verified: true }],
  capacity: { maxPackageValueMinor: 1_000_000_00 },
  complianceConfirmed: true,
  evidenceHash: `sha256:${reference.padEnd(64, '0')}`,
});

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  const tender = seed.workingProjects.find((p) => p.phase === 'TENDER');
  assert.ok(tender, 'the seed no longer carries a project stopped at TENDER');
  tenderProjectId = tender.projectId;

  const qs = () => platform.context(seed.users.qs!.auth, tenderProjectId, { source: 'WEB' });
  const pm = () => platform.context(seed.users.pm!.auth, tenderProjectId, { source: 'WEB' });
  const designer = () => platform.context(seed.users.designer!.auth, tenderProjectId, { source: 'WEB' });

  const firms = [
    { partyId: 'party-tq-amey', legalName: 'Amey Ductwork Ltd', contactEmail: 'a@example.com' },
    { partyId: 'party-tq-balfour', legalName: 'Balfour Air Ltd', contactEmail: 'b@example.com' },
  ].map((firm, index) => {
    const { supplierId } = supplychain.registerSupplier(qs(), {
      ...firm, trades: ['MECHANICAL'], contactName: 'A person',
    });
    supplychain.prequalifySupplier(pm(), supplierId, prequalification(`tq${index}`));
    return supplierId;
  });
  invitedSupplierId = firms[0]!;

  structure.assessDesignMaturity(designer(), {
    packageId: 'pkg-tq-duct',
    disciplineScores: [{ discipline: 'MECHANICAL', ribaStage: 4, completenessPercent: 90, frozen: true }],
    informationGaps: [],
    assessorNotes: 'Frozen for pricing.',
  });

  const { rfqId } = procurement.createRFQ(qs(), {
    packageId: 'pkg-tq-duct',
    title: 'Ductwork and air handling',
    pricingBasis: 'LUMP_SUM',
    returnDeadline: '2027-01-30',
    invitedSupplierIds: firms,
    requiredInsurances: ['PUBLIC_LIABILITY'],
    contractSuite: 'NEC4',
    trade: 'MECHANICAL',
  });
  tenderRfqId = rfqId;
});

describe('the enquiry is reachable from both sides', () => {
  it('routes all three of the commands that had no way in', () => {
    // The defect stated as an assertion. A command with no route is a feature
    // that exists in the repository and not in the product.
    for (const pattern of [
      '/v1/projects/:projectId/procurement/rfq/:rfqId/acknowledge',
      '/v1/projects/:projectId/procurement/rfq/:rfqId/clarifications',
      '/v1/projects/:projectId/procurement/clarifications/:clarificationId/answer',
    ]) {
      const route = ROUTES.find((r) => r.pattern === pattern && r.method === 'POST');
      assert.ok(route, `${pattern} has no route, so the command behind it cannot be reached`);
      assert.ok(route.schema, `${pattern} accepts a body and must declare its shape`);
    }
  });
});

describe('a firm answers the enquiry it was sent', () => {
  it('records whether it intends to bid', () => {
    const rfqId = rfqOf();
    const invited = (platform.ledger.require({ refType: 'RFQ', refId: rfqId }).state.invitedSupplierIds as string[]) ?? [];
    const supplierId = invited[0]!;

    procurement.acknowledgeRFQ(asQSOnLive(), { rfqId, supplierId, intendToBid: true });

    const state = platform.ledger.require({ refType: 'RFQ', refId: rfqId }).state;
    const rows = (state.acknowledgements as Array<Record<string, unknown>>) ?? [];
    const mine = rows.find((r) => r.supplierId === supplierId);
    assert.ok(mine, 'the acknowledgement is not on the RFQ');
    assert.equal(mine.intendToBid, true);
  });

  it('replaces its own earlier answer rather than stacking a second one', () => {
    // A firm that says yes and then withdraws has one position, not two. The
    // reconciliation counts acknowledgements, so a duplicate would report a
    // field larger than the one that exists.
    const rfqId = rfqOf();
    const invited = (platform.ledger.require({ refType: 'RFQ', refId: rfqId }).state.invitedSupplierIds as string[]) ?? [];
    const supplierId = invited[0]!;

    procurement.acknowledgeRFQ(asQSOnLive(), { rfqId, supplierId, intendToBid: false });

    const rows =
      (platform.ledger.require({ refType: 'RFQ', refId: rfqId }).state.acknowledgements as Array<
        Record<string, unknown>
      >) ?? [];
    const mine = rows.filter((r) => r.supplierId === supplierId);
    assert.equal(mine.length, 1, 'the firm is on the RFQ twice');
    assert.equal(mine[0]!.intendToBid, false, 'the withdrawal did not replace the earlier intention');
  });

  it('refuses a firm that was never invited', () => {
    const rfqId = rfqOf();
    throwsCode(
      () => procurement.acknowledgeRFQ(asQSOnLive(), { rfqId, supplierId: 'party-nobody-asked', intendToBid: true }),
      'SUPPLIER_NOT_INVITED',
    );
  });
});

describe('a bidder asks, and every bidder is answered', () => {
  it('raises the question as TQ-nnn against the RFQ', () => {
    const rfqId = rfqOf();
    const invited = (platform.ledger.require({ refType: 'RFQ', refId: rfqId }).state.invitedSupplierIds as string[]) ?? [];

    const { clarificationId, reference } = procurement.raiseClarification(asQSOnLive(), {
      rfqId,
      supplierId: invited[0]!,
      question: 'Is the ductwork insulation in this package or the mechanical package?',
    });

    assert.match(reference, /^TQ-\d+$/, 'a clarification is referenced TQ-nnn');
    const state = platform.ledger.require({ refType: 'Clarification', refId: clarificationId }).state;
    assert.equal(state.status, 'OPEN');
    assert.equal(state.rfqId, rfqId, 'the question is not tied to the enquiry it concerns');
  });

  it('refuses an answer sent to the asker alone', () => {
    // The rule the whole command exists for. A private answer means the other
    // bidders priced different information, so the returns are not comparable
    // and the award is challengeable by whoever loses.
    const { clarificationId } = procurement.raiseClarification(asQS(), {
      rfqId: tenderRfqId,
      supplierId: invitedSupplierId,
      question: 'Which revision of the layout governs?',
    });

    throwsCode(
      () =>
        procurement.answerClarification(asQS(), {
          clarificationId,
          answer: 'Revision C.',
          issueToAllBidders: false,
        }),
      'CLARIFICATION_MUST_BE_UNIVERSAL',
    );

    assert.equal(
      platform.ledger.require({ refType: 'Clarification', refId: clarificationId }).state.status,
      'OPEN',
      'the refused answer was written anyway',
    );
  });

  it('answers it to everybody, and says who answered and when', () => {
    const { clarificationId } = procurement.raiseClarification(asQS(), {
      rfqId: tenderRfqId,
      supplierId: invitedSupplierId,
      question: 'Are the builders-work holes measured?',
    });

    procurement.answerClarification(asQS(), {
      clarificationId,
      answer: 'Yes — measured in the bill, section 4.',
      issueToAllBidders: true,
    });

    const state = platform.ledger.require({ refType: 'Clarification', refId: clarificationId }).state;
    assert.equal(state.status, 'ANSWERED');
    assert.equal(state.issuedToAllBidders, true);
    assert.equal(state.answer, 'Yes — measured in the bill, section 4.');
    assert.equal(state.answeredBy, seed.users.qs!.auth.actorId, 'the answer names nobody');
    assert.ok(typeof state.answeredAt === 'string' && state.answeredAt.length > 0);
  });
});
