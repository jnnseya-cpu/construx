import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import * as itt from '../src/domain/itt.ts';
import * as redteam from '../src/domain/redteam.ts';
import { ROUTES } from '../src/api/routes.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The half of a tender the platform could read and not write.
 *
 * `itt.ts` produces the register, the compliance matrix, the owner per
 * requirement and the clarifications, and stops exactly where the work starts.
 * Somebody then writes the submission by hand against a matrix on another
 * screen. This is that being written.
 *
 * Four properties are asserted, and each is the reason a design decision was
 * made rather than a feature being listed.
 *
 * **No ceiling.** One section per pass. A large ITT does not produce a longer
 * call, it produces more calls — so nothing about the size of the tender can
 * truncate the submission. A single call producing all of it does not refuse
 * when it runs out of room; it stops mid-sentence and looks finished.
 *
 * **Resume is the same code path.** A pass that dies leaves its section
 * PLANNED, and the next call writes the first section that has none. There is
 * no checkpoint, so there is no way for resuming to work less well than the
 * first run.
 *
 * **A numbered document.** `BID-nnnn` from planning, so the pack can be quoted
 * in a clarification and found afterwards.
 *
 * **It refuses.** The mirror of the tender pack's own completeness gate: it
 * will not issue a submission that leaves a deliverable unanswered or a stated
 * deadline undated, because such a submission is rejected rather than marked
 * down, and everything else in it is spent for nothing.
 */

let platform: Platform;
let seed: SeedResult;
let analysisId: string;

/**
 * Holds ESTIMATE_TENDER C/U/I — plans, drafts and issues.
 *
 * On the tenant's governance pseudo-project, which is what `tenantContext`
 * hands every route in this family. A bid happens before there is a delivery
 * project to put it on, so the pack lives where the analysis it answers does.
 */
const asQS = () =>
  platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/**
 * An analysis with a mix the pack has to handle: two requirements the platform
 * cannot evidence (which need prose), one it can (which does not), one with its
 * own earlier date, and one mandatory.
 */
const REQUIREMENTS: Parameters<typeof itt.analyseITT>[1]['requirements'] = [
  {
    reference: 'R-01',
    category: 'TECHNICAL',
    requirement: 'Describe your methodology for deep drainage in live carriageway',
    mandatory: true,
    weightingPercent: 30,
    evidenceRequired: 'Method statement, maximum four sides',
  },
  {
    reference: 'R-02',
    category: 'SOCIAL_VALUE',
    requirement: 'Set out the local employment and apprenticeship commitments you will make',
    mandatory: false,
    weightingPercent: 10,
    evidenceRequired: 'Narrative with measurable commitments',
    dueBy: '2027-02-01',
  },
  {
    reference: 'R-03',
    category: 'INSURANCE',
    requirement: 'Employers liability and public liability cover',
    mandatory: true,
    evidenceRequired: 'Certificates',
  },
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const analysis = itt.analyseITT(asQS(), {
    reference: 'ITT-BIDPACK-01',
    clientName: 'Calderdale Metropolitan Borough Council',
    returnBy: '2027-03-01',
    estimatedValueMinor: 480_000_000,
    durationWeeks: 96,
    requirements: REQUIREMENTS,
    terms: { contractForm: 'NEC4 Option A' },
  });
  analysisId = analysis.analysisId;
});

describe('the pack is planned from the matrix rather than typed again', () => {
  it('is reachable, and its three events are in the closed catalogue', () => {
    for (const [method, pattern] of [
      ['GET', '/v1/projects/:projectId/bid-responses'],
      ['GET', '/v1/projects/:projectId/bid-responses/:packId'],
      ['POST', '/v1/projects/:projectId/bid-responses'],
      ['POST', '/v1/projects/:projectId/bid-responses/:packId/sections'],
      ['POST', '/v1/projects/:projectId/bid-responses/:packId/issue'],
    ] as const) {
      assert.ok(
        ROUTES.some((route) => route.method === method && route.pattern === pattern),
        `${method} ${pattern} has no route, so the command behind it cannot be reached`,
      );
    }

    // Project-scoped, and that is the platform's own invariant rather than a
    // preference. Writing a section spends a tenancy's ACUs, the quote that
    // discloses the cost is assembled from a project, and `doors.test.ts`
    // refuses an AI route that spends a customer's credit with nothing to quote
    // against. The first draft of these hung off `/v1/pipeline` and was caught
    // by exactly that check.
    const catalogue = new Map(EVENT_TYPES.map((entry) => [entry.code, entry]));
    assert.ok(catalogue.has('BID_RESPONSE_PLANNED'));
    assert.ok(catalogue.has('BID_RESPONSE_SECTION_WRITTEN'));
    assert.ok(catalogue.has('BID_RESPONSE_ISSUED'));

    // Writing a section is an agent's work. Committing to answer the tender and
    // sending it to a buyer are not, for the same reason no mandate exceeds
    // propose.
    assert.equal(catalogue.get('BID_RESPONSE_SECTION_WRITTEN')!.aiAllowed, true);
    assert.notEqual(catalogue.get('BID_RESPONSE_PLANNED')!.aiAllowed, true);
    assert.notEqual(catalogue.get('BID_RESPONSE_ISSUED')!.aiAllowed, true);
  });

  it('carries a reference, and plans a section only where prose is actually needed', () => {
    const { pack, toWrite } = bidresponse.planBidResponse(asQS(), { analysisId });

    assert.match(pack.reference, /^BID-\d{4}$/, 'the pack is not a numbered document');
    assert.equal(pack.status, 'DRAFTING');
    assert.equal(pack.passes, 0);

    // The insurance line is evidenced from the company profile the platform
    // already holds, so it is a certificate to attach and not a method
    // statement to write. Asking a model to write around evidence that exists
    // is how a submission acquires a paragraph contradicting its own appendix.
    const keys = pack.sections.map((section) => section.key);
    assert.deepEqual(keys, ['R-01', 'R-02'], `planned ${keys.join(', ')}`);
    assert.equal(toWrite, 2);

    // The responsibility matrix is the matrix's own owner, not a second one.
    assert.ok(pack.sections.every((section) => section.owner.length > 0));

    // Every stated date, and the return date always: a submission with no
    // return date on its face is the one that goes in the day after.
    const dated = pack.deadlines.map((deadline) => deadline.on);
    assert.ok(dated.includes('2027-02-01'), 'the earlier stated date is not on the schedule');
    assert.ok(dated.includes('2027-03-01'), 'the return date is not on the schedule');
    assert.ok(pack.deadlines.every((deadline) => deadline.on), 'a deadline was planned with no date');
  });

  it('refuses a second pack against the same tender', () => {
    // Two packs answering one tender is two submissions, and the one that goes
    // out is whichever somebody opened last.
    throwsCode(() => bidresponse.planBidResponse(asQS(), { analysisId }), 'BID_RESPONSE_EXISTS');
  });
});

describe('the pipeline writes it, and refuses to issue it half done', () => {
  let packId: string;

  before(() => {
    const position = bidresponse.bidResponsePosition(asQS());
    packId = position.packs[0]!.id;
  });

  it('will not issue while a deliverable has no response, and names every one', () => {
    // Nothing has been drafted yet. This is the state the check exists for: a
    // submission missing a mandatory response is rejected, not marked down.
    const before_ = bidresponse.bidResponsePack(asQS(), packId);
    assert.equal(before_.completeness.ready, false);
    assert.equal(before_.completeness.unanswered.length, 2);

    let message = '';
    try {
      bidresponse.issueBidResponse(asQS(), { packId });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, /cannot be issued/);
    // Every outstanding one, not the first: fixing them one attempt at a time
    // is how somebody decides the check is the problem.
    assert.match(message, /R-01/);
    assert.match(message, /R-02/);
    assert.match(message, /mandatory/, 'the refusal does not distinguish a pass/fail requirement');
  });

  it('refuses to draft on the local stand-in rather than sending its sentence to a buyer', async () => {
    // The one refusal that has to happen before the charge, not after it. Prose
    // from an adapter that reasons about nothing, sent to a buyer under the
    // company's name as its answer to a mandatory requirement, is a false
    // statement — and this deployment runs the stand-in in tests.
    await assert.rejects(
      () => bidresponse.writeNextSection(asQS(), { packId }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'NO_REASONING_PROVIDER');
        return true;
      },
    );

    // And it changed nothing, so the next pass writes exactly the section this
    // one did not.
    const after = bidresponse.bidResponsePack(asQS(), packId);
    assert.equal(after.passes, 0, 'a refused pass was counted as one');
    assert.equal(after.completeness.unanswered.length, 2);
  });

  it('spends nothing when there is nothing left to write', async () => {
    // The natural way to drive this is a loop that stops on remaining === 0,
    // and the natural bug in that loop is running it once more. That must not
    // cost anything, and on a deployment with no provider it must not refuse
    // either — there is nothing to ask a provider for.
    const finished = bidresponse.planBidResponse(asQS(), {
      analysisId: itt.analyseITT(asQS(), {
        reference: 'ITT-BIDPACK-02',
        clientName: 'A client',
        returnBy: '2027-04-01',
        estimatedValueMinor: 120_000_000,
        durationWeeks: 40,
        requirements: [REQUIREMENTS[0]!],
        terms: { contractForm: 'NEC4 Option A' },
      }).analysisId,
    }).pack;

    // Drafted by hand rather than by a model, which is the state a pack reaches
    // when a bid writer has taken it over.
    const drafted = {
      ...finished,
      sections: finished.sections.map((section) => ({
        ...section,
        status: 'DRAFTED' as const,
        body: ['We would do it like this.'],
        authorship: 'HUMAN' as const,
      })),
    };
    platform.ledger.commit({
      tenantId: seed.tenantId,
      projectId: finished.projectId,
      actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
      source: 'WEB',
      correlationId: finished.id,
      eventType: 'BID_RESPONSE_SECTION_WRITTEN',
      entity: { refType: 'BidResponsePack', refId: finished.id },
      nextState: drafted as unknown as Record<string, unknown>,
    });

    const pass = await bidresponse.writeNextSection(asQS(), { packId: finished.id });
    assert.equal(pass.written, null, 'a pass ran against a pack with nothing left');
    assert.equal(pass.remaining, 0);
    assert.equal(pass.acuConsumed, 0, 'a pass with nothing to do was charged for');
  });

  it('issues once every deliverable is answered, every deadline dated and the red team clears it', async () => {
    const position = bidresponse.bidResponsePosition(asQS());
    const complete = position.packs.find((pack) => pack.completeness.ready);
    assert.ok(complete, 'the hand-drafted pack is not showing as ready');

    // Complete is not the same as clear. Nothing had attacked this pack, and a
    // submission nothing has attacked is not a submission nothing is wrong with
    // — so the issue gate refuses before it is asked about anything else.
    const unattacked = throwsCode(
      () => bidresponse.issueBidResponse(asQS(), { packId: complete.id }),
      'ASSURANCE_NOT_CLEAR',
    );
    assert.match(String(unattacked.message), /nothing has attacked/);

    const { review } = await redteam.challengeSubmission(asQS(), { packId: complete.id });
    for (const blocking of review.findings.filter((entry) => entry.severity === 'HIGH')) {
      redteam.disposeFinding(asQS(), review.id, blocking.id, {
        decision: 'ACCEPTED',
        note: `Read before issue and accepted: ${blocking.title.slice(0, 40)}`,
      });
    }
    assert.equal(
      review.findings.filter((entry) => entry.severity === 'CRITICAL').length,
      0,
      'the hand-drafted pack carries a hard block',
    );

    const { pack, completeness } = bidresponse.issueBidResponse(asQS(), { packId: complete.id });
    assert.equal(pack.status, 'ISSUED');
    assert.equal(pack.issuedBy, seed.users.qs!.auth.actorId, 'the issue names nobody');
    assert.ok(pack.issuedAt);
    assert.equal(completeness.ready, true);

    // Issued twice is sent twice.
    throwsCode(() => bidresponse.issueBidResponse(asQS(), { packId: complete.id }), 'BID_RESPONSE_ISSUED');
  });

  it('will not draft into a pack that has gone to the buyer', async () => {
    const issued = bidresponse.bidResponsePosition(asQS()).packs.find((pack) => pack.status === 'ISSUED');
    assert.ok(issued, 'nothing was issued');

    await assert.rejects(
      () => bidresponse.writeNextSection(asQS(), { packId: issued.id }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'BID_RESPONSE_ISSUED');
        return true;
      },
    );
  });
});

describe('the completeness answer is read, never stored', () => {
  it('gives the screen and the gate the same figure', () => {
    // A completeness figure computed twice is two figures, and the one somebody
    // trusts is whichever is on the screen at the time.
    const position = bidresponse.bidResponsePosition(asQS());
    for (const summary of position.packs) {
      const full = bidresponse.bidResponsePack(asQS(), summary.id);
      assert.deepEqual(summary.completeness, full.completeness, `${summary.reference} disagrees with itself`);
    }
  });

  it('counts an empty body as unanswered, not as written', () => {
    // The failure a status field alone would miss: a section marked DRAFTED
    // carrying nothing is a heading in a submission, and a heading with no
    // answer under it is the deliverable being unanswered.
    const hollow = bidresponse.bidCompleteness({
      id: 'x',
      reference: 'BID-0009',
      projectId: 'p',
      analysisId: 'a',
      clientName: 'c',
      returnBy: '2027-01-01',
      sections: [
        { key: 'R-01', title: 't', deliverable: 'd', owner: 'QS', mandatory: true, status: 'DRAFTED', body: [] },
      ],
      deadlines: [{ what: 'Return', on: '2027-01-01' }],
      status: 'DRAFTING',
      passes: 1,
      plannedAt: '2026-01-01T00:00:00.000Z',
      plannedBy: 'u',
    });
    assert.equal(hollow.ready, false);
    assert.equal(hollow.unanswered.length, 1);
  });

  it('refuses an undated deadline even when every section is written', () => {
    const undated = bidresponse.bidCompleteness({
      id: 'x',
      reference: 'BID-0010',
      projectId: 'p',
      analysisId: 'a',
      clientName: 'c',
      returnBy: '2027-01-01',
      sections: [
        { key: 'R-01', title: 't', deliverable: 'd', owner: 'QS', mandatory: true, status: 'DRAFTED', body: ['Written.'] },
      ],
      deadlines: [{ what: 'Site visit' }],
      status: 'DRAFTING',
      passes: 1,
      plannedAt: '2026-01-01T00:00:00.000Z',
      plannedBy: 'u',
    });
    assert.equal(undated.ready, false);
    assert.deepEqual(undated.undated, ['Site visit']);
  });
});
