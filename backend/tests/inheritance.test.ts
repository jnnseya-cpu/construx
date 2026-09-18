import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as inheritance from '../src/domain/inheritance.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * AC-02: a Proposed tender drawing does not become approved for construction
 * because the project was won.
 *
 * ## Why this is a safety test and not a data test
 *
 * A drawing issued during a tender is a proposal. It was produced to price the
 * work, by a designer who may not have been appointed, against information that
 * may not have been complete, and nobody checked it against the contract
 * because there was no contract.
 *
 * Winning does not change any of that. But at the moment of conversion that
 * drawing sits in the same project as the construction information — same
 * register, same search, same "latest revision" — and before this register
 * existed the only thing between a tender proposal and a gang building from it
 * was that somebody happened to remember which was which.
 *
 * So these tests assert the negative far more than the positive: that
 * conversion grants nothing, that seven of the eight dispositions confer no
 * authority, that a start-work authorisation is refused while items are
 * undecided, and that accepting one into the contract requires a named person,
 * a reason and the clause it entered by.
 */

let platform: Platform;
let seed: SeedResult;
let gov: ReturnType<Platform['context']>;
let portfolioId: string;

const AWARD = {
  contractAwardDate: '2026-04-20',
  contractSumMinor: 142_500_000,
  contractForm: 'NEC4 ECC Option A',
  contractedScope: 'As tendered, less the access road.',
  contractStartDate: '2026-05-05',
  contractCompletionDate: '2027-11-30',
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const source = platform.ledger.entitiesOfType('Project').find((r) => r.state.id === seed.projectId)!;
  portfolioId = String(source.state.portfolioId);
});

/** A bid with one tender drawing on it, at the revision a tender drawing has. */
function bidWithTenderDrawing(name: string): { projectId: string; ctx: ReturnType<Platform['context']>; drawingId: string } {
  const { projectId } = structure.createProject(gov, {
    portfolioId,
    name,
    sectorType: 'UTILITIES',
    assetType: 'Treatment works',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
    contractValueMinor: 138_000_000,
    currency: 'GBP',
    plannedStart: '2026-03-01',
    plannedCompletion: '2027-03-01',
    startingPhase: 'TENDER',
    startingPhaseReason: 'Pricing the client design against their bill of quantities.',
  } as Parameters<typeof structure.createProject>[1]);

  const ctx = platform.context(seed.users.admin!.auth, projectId, { source: 'WEB' });

  // A tender drawing, written straight to the ledger at the suitability a
  // tender drawing carries. `P` codes are preliminary — priced from, not built
  // from — which is exactly the thing this register has to keep true.
  const drawingId = 'drw-' + name.replace(/\W/g, '').slice(0, 10);
  platform.ledger.commit({
    tenantId: ctx.tenantId,
    projectId,
    eventType: 'DRAWING_REGISTERED',
    entity: { refType: 'Drawing', refId: drawingId },
    nextState: {
      id: drawingId,
      projectId,
      drawingNumber: 'C-1001',
      title: 'General arrangement — inlet works',
      revision: 'P02',
      discipline: 'CIVILS',
      status: 'CURRENT',
      registeredAt: '2026-02-10T09:00:00.000Z',
    },
    actor: { refType: 'User', refId: seed.users.admin!.auth.actorId },
    source: 'WEB',
    correlationId: 'test',
    // The catalogue requires evidence on a drawing registration, and it is
    // right to: a drawing in the register with no file behind it is a claim.
    evidenceRefs: [{ refType: 'EvidenceItem', refId: `ev-${drawingId}` }],
  });

  return { projectId, ctx, drawingId };
}

function convert(ctx: ReturnType<Platform['context']>): ReturnType<typeof structure.convertToDelivery> {
  return structure.convertToDelivery(ctx, {
    award: AWARD,
    deliveryEntry: 'DESIGN',
    justification: 'Awarded under LOI-4471; conversion approved by the commercial director.',
  });
}

describe('AC-02 — a tender drawing is not approved for construction by winning', () => {
  it('opens every pre-award item at REQUIRES_VALIDATION, never at accepted', () => {
    const { ctx, drawingId } = bidWithTenderDrawing('AC-02 base');
    const receipt = convert(ctx);

    assert.ok(receipt.inheritanceRegisterId, 'conversion opened no inheritance register');
    assert.ok(receipt.inheritedItemsAwaitingValidation > 0, 'the register is empty');

    const register = inheritance.inheritanceRegister(ctx)!;
    const drawing = register.records.find((record) => record.sourceItemId === drawingId)!;

    assert.ok(drawing, 'the tender drawing was not inherited at all');
    assert.equal(drawing.disposition, 'REQUIRES_VALIDATION');
    // The assertion the whole module exists for.
    assert.notEqual(drawing.disposition, 'ACCEPTED_CONTRACT', 'conversion granted contract authority');
    assert.equal(drawing.decidedBy, undefined, 'conversion recorded a decider for a decision nobody made');
    assert.equal(register.authoritative, 0, 'something was authoritative the moment the project converted');
  });

  it('refuses to let anybody build from it while it is undecided', () => {
    const { ctx, drawingId } = bidWithTenderDrawing('AC-02 authority');
    convert(ctx);

    const answer = inheritance.constructionAuthority(ctx, { refType: 'Drawing', refId: drawingId });
    assert.equal(answer.permitted, false);
    assert.equal(answer.disposition, 'REQUIRES_VALIDATION');
    assert.match(answer.reason, /Requires validation/);

    throwsCode(
      () => inheritance.assertConstructionAuthority(ctx, { refType: 'Drawing', refId: drawingId }),
      'INHERITANCE_UNDECIDED',
    );
  });

  it('keeps the drawing itself untouched — inherited by reference, not copied', () => {
    const { ctx, projectId, drawingId } = bidWithTenderDrawing('AC-02 byref');
    const before = platform.ledger.list(projectId, 'Drawing').length;
    convert(ctx);

    assert.equal(platform.ledger.list(projectId, 'Drawing').length, before, 'conversion copied the drawing');
    const drawing = platform.ledger.get({ refType: 'Drawing', refId: drawingId })!;
    // Same revision, same status. The tender record has to stay readable as
    // what was actually tendered — that is why the tender baseline is frozen.
    assert.equal(drawing.state.revision, 'P02');
    assert.equal(drawing.state.status, 'CURRENT');
  });

  it('carries the provenance §6.1 requires', () => {
    const { ctx, drawingId } = bidWithTenderDrawing('AC-02 provenance');
    convert(ctx);
    const record = inheritance.inheritanceRegister(ctx)!.records.find((r) => r.sourceItemId === drawingId)!;

    assert.equal(record.sourceRefType, 'Drawing');
    assert.equal(record.sourceItemId, drawingId);
    assert.ok(record.sourceVersion >= 1, 'no source version recorded');
    assert.equal(record.sourceStage, 'TENDER', 'the stage it came from was not recorded');
    assert.equal(record.sourceWorkstream, 'TENDER');
    assert.equal(record.receivedAt, '2026-02-10T09:00:00.000Z');
    // Readable without resolving ids, which is what makes a register usable.
    assert.match(record.label, /C-1001 rev P02/);
  });

  it('is not the enterprise administrator\u2019s decision to make', () => {
    /*
     * §9 gives design-information acceptance to the design manager, not to
     * whoever can administer the tenancy. Deciding that a tender drawing may be
     * built from is an engineering judgement, and the permission matrix already
     * draws that line — this asserts the module reads it rather than inventing
     * a second, looser one.
     */
    const { ctx, drawingId } = bidWithTenderDrawing('AC-02 wrong role');
    const { inheritanceRegisterId } = convert(ctx);
    const recordId = inheritance.inheritanceRegister(ctx)!.records.find((r) => r.sourceItemId === drawingId)!.id;
    throwsCode(
      () =>
        inheritance.decideInheritance(ctx, {
          registerId: inheritanceRegisterId,
          recordId,
          disposition: 'ACCEPTED_CONTRACT',
          rationale: 'The administrator would like this to be buildable.',
          contractIncorporationReference: 'Appendix C',
        }),
      'ACCESS_DENIED',
    );
  });

  it('only ACCEPTED_CONTRACT confers authority, and it needs a reason and a clause', () => {
    const { projectId, ctx, drawingId } = bidWithTenderDrawing('AC-02 accept');
    const { inheritanceRegisterId } = convert(ctx);
    const recordId = inheritance.inheritanceRegister(ctx)!.records.find((r) => r.sourceItemId === drawingId)!.id;
    // The design approver, who is who §9 says decides this.
    const designer = platform.context(seed.users.designer!.auth, projectId, { source: 'WEB' });

    // No rationale.
    throwsCode(
      () => inheritance.decideInheritance(designer, { registerId: inheritanceRegisterId, recordId, disposition: 'ACCEPTED_CONTRACT', rationale: 'ok' }),
      'INHERITANCE_RATIONALE_REQUIRED',
    );
    // A rationale, but nothing saying where in the contract it landed.
    throwsCode(
      () =>
        inheritance.decideInheritance(designer, {
          registerId: inheritanceRegisterId,
          recordId,
          disposition: 'ACCEPTED_CONTRACT',
          rationale: 'Checked against the Employer’s Requirements and found to match.',
        }),
      'CONTRACT_REFERENCE_REQUIRED',
    );

    const decided = inheritance.decideInheritance(designer, {
      registerId: inheritanceRegisterId,
      recordId,
      disposition: 'ACCEPTED_CONTRACT',
      rationale: 'Checked against the Employer’s Requirements and incorporated without change.',
      contractIncorporationReference: 'Contract Appendix C, item 14',
    });
    assert.equal(decided.authority, true);

    const after = inheritance.constructionAuthority(ctx, { refType: 'Drawing', refId: drawingId });
    assert.equal(after.permitted, true);
    assert.match(after.reason, /Appendix C/);
  });

  it('confers no authority on the other seven dispositions', () => {
    // The table is the rule, so the table is what is asserted. A ninth
    // disposition added carelessly would have to declare `authority` and would
    // fail here if it declared it true.
    const permissive = inheritance.DISPOSITION_CODES.filter((code) => inheritance.DISPOSITION[code].authority);
    assert.deepEqual(permissive, ['ACCEPTED_CONTRACT'], 'more than one disposition confers construction authority');
    assert.equal(inheritance.DISPOSITION_CODES.length, 8, 'the disposition table has changed size');
  });

  it('blocks a start-work authorisation while items are undecided', () => {
    // The last point before people are on site, which is the whole reason that
    // gate exists. `REJECTED` and `NOT_APPLICABLE` are decided and do not block;
    // only an item nobody has looked at does.
    const { ctx } = bidWithTenderDrawing('AC-02 mobilisation');
    convert(ctx);
    const open = inheritance.unvalidatedTenderInformation(ctx);
    assert.ok(open.length > 0, 'nothing is holding a start-work authorisation');
    assert.ok(open.every((record) => inheritance.DISPOSITION[record.disposition].open));
  });

  it('says nothing about information produced after award', () => {
    // The register governs what came from the tender, not everything that
    // exists. A drawing issued under the contract is the contract's business.
    const { ctx } = bidWithTenderDrawing('AC-02 postaward');
    convert(ctx);
    const answer = inheritance.constructionAuthority(ctx, { refType: 'Drawing', refId: 'issued-after-award' });
    assert.equal(answer.permitted, true);
    assert.match(answer.reason, /after award/);
  });

  it('says nothing about a project that never came through an award', () => {
    const { projectId } = structure.createProject(gov, {
      portfolioId,
      name: 'AC-02 never converted',
      sectorType: 'UTILITIES',
      assetType: 'Works',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
      contractValueMinor: 1_000_000,
      currency: 'GBP',
      plannedStart: '2026-03-01',
      plannedCompletion: '2027-03-01',
    } as Parameters<typeof structure.createProject>[1]);
    const ctx = platform.context(seed.users.admin!.auth, projectId, { source: 'WEB' });
    assert.equal(inheritance.inheritanceRegister(ctx), null);
    assert.equal(inheritance.constructionAuthority(ctx, { refType: 'Drawing', refId: 'x' }).permitted, true);
  });
});
