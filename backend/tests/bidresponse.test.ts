import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import * as itt from '../src/domain/itt.ts';
import * as redteam from '../src/domain/redteam.ts';
import { ROUTES } from '../src/api/routes.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
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

// The last mile: a person reads a drafted section back and rewrites it in their
// own words — putting the real project names and team in, which the drafter
// leaves for them. No model is called, so this works even on a deployment with no
// reasoning provider, and the result is recorded as the person's, not the model's.
describe('a person can write a section in their own words, without the model', () => {
  it('writes the body, marks it theirs, drops the AI attribution, and refuses an empty or unknown section', () => {
    const analysisId = itt.analyseITT(asQS(), {
      reference: 'ITT-BIDPACK-REVISE',
      clientName: 'South Holland District Council',
      returnBy: '2026-11-20',
      estimatedValueMinor: 7_200_000,
      durationWeeks: 12,
      requirements: [REQUIREMENTS[0]!],
      terms: { contractForm: 'JCT Minor Works' },
    }).analysisId;
    const pack = bidresponse.planBidResponse(asQS(), { analysisId }).pack;
    const key = pack.sections[0]!.key;

    const result = bidresponse.reviseSection(asQS(), {
      packId: pack.id,
      key,
      body: [
        'We completed a comparable single-storey extension at Perry Barr in 2025 for £64,000.',
        'It was handed over on time and to budget, the resident remaining in occupation throughout.',
      ],
    });
    assert.equal(result.written.status, 'DRAFTED');
    assert.equal(result.written.authorship, 'HUMAN');
    assert.equal(result.written.body!.length, 2);
    assert.equal(result.written.provider, undefined, 'a person-written section must not claim a model wrote it');
    assert.ok(result.written.words! > 0);

    const after = bidresponse.bidResponsePack(asQS(), pack.id);
    assert.equal(after.sections.find((s) => s.key === key)!.authorship, 'HUMAN');

    throwsCode(() => bidresponse.reviseSection(asQS(), { packId: pack.id, key, body: [' ', ''] }), 'BID_SECTION_EMPTY');
    throwsCode(() => bidresponse.reviseSection(asQS(), { packId: pack.id, key: 'NOPE', body: ['x'] }), 'BID_SECTION_NOT_FOUND');
  });
});

/**
 * Which requirements become a written answer, and which do not.
 *
 * The defect a first bidder hit: a pack planned from the whole ITT demanded a
 * written answer for every line with no evidence attached — so a priced schedule
 * (flat roof, provisional sums), the submission logistics (the portal, file
 * formats), the dates and the payment terms all arrived as blank essay
 * questions. None of those is answered by prose. These pin the rule that an
 * essay section is drawn only for a written answer an evaluator reads and marks.
 */
describe('needsProse — only the written answers become sections', () => {
  const line = (over: Partial<itt.MatrixLine>): itt.MatrixLine => ({
    reference: 'X1',
    category: 'QUALITY',
    requirement: 'A requirement',
    mandatory: true,
    owner: 'QS',
    evidenceRequired: '',
    status: 'GAP',
    ...over,
  });

  it('draws an essay for a scored question, whatever its category', () => {
    assert.equal(bidresponse.needsProse(line({ category: 'QUALITY', weightingPercent: 20 })), true);
    // A scored commercial question is still a written answer — the weighting wins.
    assert.equal(bidresponse.needsProse(line({ category: 'COMMERCIAL', weightingPercent: 10 })), true);
  });

  it('draws an essay for an unscored narrative requirement', () => {
    assert.equal(bidresponse.needsProse(line({ category: 'TECHNICAL', weightingPercent: undefined })), true);
    assert.equal(bidresponse.needsProse(line({ category: 'SOCIAL_VALUE', weightingPercent: undefined })), true);
    assert.equal(bidresponse.needsProse(line({ category: 'HEALTH_AND_SAFETY', weightingPercent: undefined })), true);
  });

  it('does not draw an essay for a priced, logistical, commercial or qualification line', () => {
    // A pricing-schedule item the AI filed as COMMERCIAL — the price is in Appendix B.
    assert.equal(bidresponse.needsProse(line({ category: 'COMMERCIAL', requirement: 'SECTION 3: PRICING SCHEDULE - flat roof' })), false);
    // Submission logistics — the portal, the file formats, the return deadline.
    assert.equal(bidresponse.needsProse(line({ category: 'SUBMISSION', requirement: 'Submission requirement - In-Tend portal' })), false);
    // Qualification and insurance — satisfied by the company's facts and evidence.
    assert.equal(bidresponse.needsProse(line({ category: 'QUALIFICATION' })), false);
    assert.equal(bidresponse.needsProse(line({ category: 'INSURANCE' })), false);
  });

  it('never draws an essay where the platform already holds the document', () => {
    assert.equal(bidresponse.needsProse(line({ category: 'QUALITY', weightingPercent: 20, evidenceHeld: 'ISO 9001 certificate on file' })), false);
    assert.equal(bidresponse.needsProse(line({ category: 'TECHNICAL', evidenceHeld: 'Method statement attached' })), false);
  });
});

/**
 * What reaches the buyer is an answer, not a note to finish one.
 *
 * A real Conwy County Borough Council submission went out of this pack with
 * sixty-odd "the bid team will insert…" notes, headings cut to "…/ Che…", and
 * "our Bid Manager and Planning Lead have prepared and signed the programme"
 * from a one-person firm. The drafter had been told to name what the bid team
 * must insert, and was handed the matrix's internal routing role and nothing
 * about who the firm is. These pin the fix: the drafter is given the firm and
 * told never to leave a note; a section that still holds one blocks issue; a
 * redraft is the way forward; and the document prints every question in full.
 */
describe('a submission with a note to the bid team in it does not issue', () => {
  const PLACEHOLDER = [
    'We will inspect the traffic management daily. The bid team will insert the inspection frequency and the ' +
      'response time (to be inserted) before submission.',
  ];
  const ANSWER = [
    'We will inspect the traffic management at the start of every shift and after any incident, and respond to a ' +
      'defect within one hour; Justin Nseya MCIOB, our project manager, signs every inspection record.',
  ];

  let own: Platform;
  let mine: SeedResult;
  const seen: Array<Record<string, unknown>> = [];
  let replies: string[][] = [];

  const asOwnQS = () => own.context(mine.users.qs!.auth, `${mine.tenantId}-governance`, { source: 'WEB' });

  before(async () => {
    const adapter: AIProviderAdapter = {
      name: 'OPENAI',
      capability: 'REASONING',
      multimodal: false,
      transmits: false,
      estimateCostMinor: () => 40,
      healthy: () => true,
      async execute(request: ProviderRequest): Promise<ProviderResponse> {
        seen.push({ task: request.task, ...(request.payload as Record<string, unknown>) });
        const body = replies.shift() ?? ANSWER;
        return { provider: 'OPENAI', modelClass: 'test', output: { body }, rawCostMinor: 40, latencyMs: 5 };
      },
    };
    own = new Platform(new AIOrchestrator({ reasoning: adapter, perception: adapter }));
    mine = await seedDemoProject(own);
    own.wallet(mine.tenantId).topUp(1_000_000, 'Drafting top-up');
  });

  it('tells the drafter who the firm is, and never to leave a note for anyone to insert', async () => {
    const analysisId = itt.analyseITT(asOwnQS(), {
      reference: 'ITT-NOTES-01',
      clientName: 'Conwy County Borough Council',
      returnBy: '2027-03-01',
      estimatedValueMinor: 50_000_000,
      durationWeeks: 12,
      requirements: [REQUIREMENTS[0]!],
      terms: { contractForm: 'NEC4 ECC Option A' },
    }).analysisId;
    const pack = bidresponse.planBidResponse(asOwnQS(), { analysisId }).pack;
    replies = [PLACEHOLDER];
    await bidresponse.writeNextSection(asOwnQS(), { packId: pack.id });

    const asked = seen.at(-1)!;
    const firm = asked.firm as { people: string[]; singleOwnerBids: boolean };
    assert.ok(Array.isArray(firm.people) && firm.people.length > 0, 'the drafter is not told who is in the firm');
    assert.equal(typeof firm.singleOwnerBids, 'boolean');
    assert.equal(asked.respondingRole, undefined, 'the internal routing role is handed over as if it were staff');
    const constraint = String(asked.constraint);
    assert.doesNotMatch(constraint, /name what the bid team must insert/, 'the drafter is still told to leave notes');
    assert.match(constraint, /never leave a gap/);
    assert.match(constraint, /claim no team, department or job title the firm does not have/);
  });

  it('refuses to issue while a section holds a note, names it, and a redraft clears it', async () => {
    const summary = bidresponse.bidResponsePosition(asOwnQS()).packs.find((p) => p.clientName === 'Conwy County Borough Council')!;
    const pack = bidresponse.bidResponsePack(asOwnQS(), summary.id);
    const key = pack.sections[0]!.key;

    const held = bidresponse.bidResponsePack(asOwnQS(), pack.id).completeness;
    assert.equal(held.ready, false);
    assert.equal(held.unfinished.length, 1);
    assert.equal(held.unfinished[0]!.key, key);
    assert.ok(held.unfinished[0]!.phrases.some((p) => /bid team will insert/i.test(p)));
    assert.ok(held.unfinished[0]!.phrases.some((p) => /to be inserted/i.test(p)));
    assert.match(held.summary, /note to the bid team/);

    let message = '';
    try {
      bidresponse.issueBidResponse(asOwnQS(), { packId: pack.id });
    } catch (error) {
      message = (error as Error).message;
    }
    assert.match(message, new RegExp(`note to the bid team instead of an answer: ${key}`));

    replies = [ANSWER];
    const redrafted = await bidresponse.redraftSection(asOwnQS(), { packId: pack.id, key });
    assert.deepEqual(redrafted.written.body, ANSWER);
    assert.equal(redrafted.written.authorship, 'AI_DRAFTED');
    assert.equal(bidresponse.bidResponsePack(asOwnQS(), pack.id).completeness.unfinished.length, 0);
  });

  it('will not let the drafter overwrite a section a person rewrote', async () => {
    const summary = bidresponse.bidResponsePosition(asOwnQS()).packs.find((p) => p.clientName === 'Conwy County Borough Council')!;
    const pack = bidresponse.bidResponsePack(asOwnQS(), summary.id);
    const key = pack.sections[0]!.key;
    bidresponse.reviseSection(asOwnQS(), { packId: pack.id, key, body: ['Our own words.'] });
    await assert.rejects(
      () => bidresponse.redraftSection(asOwnQS(), { packId: pack.id, key }),
      (error: Error & { code?: string }) => error.code === 'BID_SECTION_HUMAN_WRITTEN',
    );
    assert.ok(
      ROUTES.some((r) => r.method === 'POST' && r.pattern === '/v1/projects/:projectId/bid-responses/:packId/sections/:key/redraft'),
      'the redraft has no route, so the refusal has no way forward',
    );
  });
});

describe('unfinishedPhrases — a note to the team, never the buyer’s own words', () => {
  it('catches every form the Conwy submission carried', () => {
    for (const text of [
      'a planned start event and planned finish event (to be populated in the programme by our Bid Team);',
      'the quantum placeholder (to be filled by the bid team or the Contract sum reconciliation)',
      'the bid team shall insert those values in the fields titled Risk Allowance',
      'planned duration (bid team to insert duration values);',
      'the tender team must insert the Contract Award Date',
      'Procurement lead time (to be inserted); Risk Allowance activity linkage',
      'The Bid Team will insert the planned TMP submission lead time',
      '(Bid team to insert Security Lead name and contact at award.)',
      'Response within [insert hours] of notification',
      'Programme period TBC',
    ]) {
      assert.ok(bidresponse.unfinishedPhrases(text).length > 0, `not caught: ${text}`);
    }
  });

  it('leaves the buyer’s requirements quoted back alone', () => {
    for (const text of [
      'Evidence: "Road traffic – road closure signs and diversion to be provided – road closure to vehicles arranged from 18/01/2027".',
      'All levels shown on this drawing are nominal and must be checked/agreed prior to construction. All levels to be agreed with the supervisor.',
      'We will issue programme updates at intervals to be agreed with the client.',
      'Our bid team reviewed every drawing before pricing.',
    ]) {
      assert.deepEqual(bidresponse.unfinishedPhrases(text), [], `flagged a legitimate sentence: ${text}`);
    }
  });
});

describe('submissionBlocks — the question is printed in full', () => {
  const section = (deliverable: string) => ({
    key: '1.9 & Checklist (1.34)',
    title: `${deliverable.slice(0, 67)}…`,
    deliverable,
    owner: 'OWNER',
    mandatory: true,
    status: 'DRAFTED' as const,
    body: ['We confirm submission of the tender programme.'],
  });

  it('heads a short requirement with the requirement itself', () => {
    const blocks = bidresponse.submissionBlocks({ sections: [section('Tenderers are to submit a programme with the tender return.')] });
    assert.deepEqual(blocks[0], {
      kind: 'HEADING',
      level: 2,
      text: '1.9 & Checklist (1.34) — Tenderers are to submit a programme with the tender return.',
    });
  });

  it('heads a long one by its reference and states every word of it beneath — no ellipsis anywhere', () => {
    const long =
      '"Tenderers are to submit a programme with the tender return." / Checklist item 1.34: a programme showing the ' +
      'order of stages, compliant with contract format (for Tender purposes only), with key dates and completion.';
    const blocks = bidresponse.submissionBlocks({ sections: [section(long)] });
    assert.deepEqual(blocks[0], { kind: 'HEADING', level: 2, text: '1.9 & Checklist (1.34)' });
    assert.deepEqual(blocks[1], { kind: 'KEY_VALUES', rows: [{ label: 'Requirement', value: long }] });
    assert.ok(!JSON.stringify(blocks).includes('…'), 'something in the document is still cut short');
  });

  it('prints a requirement’s line breaks as spaces, not as literal "\\n"', () => {
    const blocks = bidresponse.submissionBlocks({ sections: [section('"Q7\\n\\n•\\n\\nThe Contractor’s method statement"')] });
    assert.equal((blocks[0] as { text: string }).text, '1.9 & Checklist (1.34) — "Q7 • The Contractor’s method statement"');
  });
});
