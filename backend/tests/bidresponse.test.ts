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

  it('catches every square-bracketed blank the Telford pack carried, and leaves citations alone', () => {
    for (const text of [
      'Our Modern Slavery & Ethical Labour Policy [ref, date] covers our own workforce.',
      'Our H&S adviser inspects each site at least [fortnightly] and the reports go to progress meetings.',
      'We will deliver [project] as principal contractor under CDM 2015.',
      'Tailor the [site] details per job.',
      'Spend with Telford-based sub-contractors: target [x]% of sub-contract value.',
      'Works were [result].',
      'Applicant legal name JNN Global Ltd [confirm exact Companies House name + company no. — must match the',
      'Contract works cover [quote per job].',
    ]) {
      assert.ok(bidresponse.unfinishedPhrases(text).length > 0, `missed a blank: ${text}`);
    }
    for (const text of [
      'As set out in the Safe Working document [3], every operative is inducted.',
      'Clauses [10–12] apply to payment.',
      'The buyer wrote "contractors [sic] must attend".',
    ]) {
      assert.deepEqual(bidresponse.unfinishedPhrases(text), [], `flagged a citation: ${text}`);
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

describe('the review a one-person firm needs before a bid goes out', () => {
  const PEOPLE = ['Justin Nseya'];
  const pack = (sections: Array<{ key: string; deliverable: string; body: string[] }>) =>
    ({
      id: 'p',
      reference: 'BID-0001',
      analysisId: 'a',
      clientName: 'Conwy County Borough Council',
      returnBy: '2027-03-01',
      status: 'DRAFTING',
      passes: 1,
      deadlines: [],
      sections: sections.map((section) => ({
        ...section,
        title: section.deliverable,
        owner: 'OWNER',
        mandatory: true,
        status: 'DRAFTED' as const,
      })),
    }) as unknown as Parameters<typeof bidresponse.bidCompleteness>[0];

  it('names the staff a sole director’s answer claims, and leaves the owner’s own titles alone', () => {
    assert.deepEqual(
      bidresponse
        .unsupportedRoles('Our Bid Manager and Planning Lead have prepared and signed the programme.', PEOPLE)
        .sort(),
      ['bid manager', 'planning lead'],
    );
    assert.deepEqual(bidresponse.unsupportedRoles('Our Quality Manager will operate a pre-issue checklist.', PEOPLE), [
      'quality manager',
    ]);
    // The owner given a title is the owner, not a claimed employee.
    assert.deepEqual(
      bidresponse.unsupportedRoles('Justin Nseya MCIOB, our quality manager, signs every record.', PEOPLE),
      [],
    );
    // Roles a sole director holds himself are not flagged.
    assert.deepEqual(
      bidresponse.unsupportedRoles('Our Site Manager and Temporary Works Coordinator will inspect daily.', PEOPLE),
      [],
    );
  });

  it('blocks issue on a claimed team only when the firm has said it is one person', () => {
    const claimed = pack([
      { key: '1.9', deliverable: 'Submit a programme', body: ['Our Bid Manager and Planning Lead have signed it.'] },
    ]);
    const sole = bidresponse.bidCompleteness(claimed, [], [], [], { singleOwner: true, people: PEOPLE });
    assert.equal(sole.ready, false);
    assert.deepEqual(sole.unsupportedStaff[0]!.roles.sort(), ['bid manager', 'planning lead']);
    assert.match(sole.summary, /claiming staff the firm does not have/);

    // A firm that has not said so may well have a bid manager; nothing is known to be false.
    const firm = bidresponse.bidCompleteness(claimed, [], [], [], { singleOwner: false, people: PEOPLE });
    assert.equal(firm.unsupportedStaff.length, 0);
    assert.equal(firm.ready, true);
  });

  it('raises drawing notes answered as questions, and "our Project Manager" under NEC, without blocking', () => {
    const review = bidresponse.bidCompleteness(
      pack([
        { key: 'Note 1', deliverable: '1. All dimensions are in metres unless otherwise stated.', body: ['We will…'] },
        {
          key: 'Drawing',
          deliverable: 'All levels shown on this drawing are nominal and must be checked prior to construction.',
          body: ['We will check.'],
        },
        { key: '2.3', deliverable: 'Outline programme', body: ['Our Project Manager will issue the programme.'] },
      ]),
      [],
      [],
      [],
      { singleOwner: true, people: PEOPLE, contractForm: 'NEC4 ECC Option A' },
    );
    assert.equal(review.ready, true, 'an advisory must not block issue');
    assert.deepEqual(
      review.advisories.map((entry) => `${entry.key}:${entry.kind}`).sort(),
      ['2.3:NEC_PROJECT_MANAGER', 'Drawing:DRAWING_NOTE', 'Note 1:DRAWING_NOTE'],
    );
    assert.equal(bidresponse.isDrawingNote('Describe your methodology for the soil nails'), false);
    assert.equal(bidresponse.isDrawingNote('Note 4 — Any anomalies on this drawing should be brought to the attention'), true);
  });
});

/*
 * The pack answers what the buyer marks.
 *
 * Conwy scored seven questions, 1,000 words each; the pack planned ninety-six
 * sections — scope clauses, hazard lines, the marking scheme and the notes on
 * the drawings — and the seven that were marked were lost among them.
 */
describe('a tender with a scored questionnaire is answered question by question', () => {
  const SCOPE: Parameters<typeof itt.analyseITT>[1]['requirements'] = [
    {
      reference: '4.1 Pedestrians',
      category: 'HEALTH_AND_SAFETY',
      requirement: 'Pedestrian access to be maintained along Waterloo Hill',
      mandatory: true,
      evidenceRequired: 'Method',
    },
    {
      reference: 'Scope - Testing',
      category: 'TECHNICAL',
      requirement: 'At commencement of site works, 3No suitability tests to 209 kN before production nails',
      mandatory: true,
      evidenceRequired: 'Test reports',
    },
    {
      reference: 'Note 1',
      category: 'TECHNICAL',
      requirement: '1. All dimensions are in metres unless otherwise stated.',
      mandatory: false,
      evidenceRequired: '',
    },
    {
      reference: '2.1 Selection',
      category: 'QUALITY',
      requirement: 'The selection of the Contractor will be on the basis of 30% Quality and 70% Price.',
      mandatory: false,
      weightingPercent: 30,
      evidenceRequired: '',
    },
    {
      reference: '2.4 Price',
      category: 'COMMERCIAL',
      requirement: 'The lowest bid will score the maximum points of 100.',
      mandatory: false,
      weightingPercent: 70,
      evidenceRequired: '',
    },
  ];
  const QUESTIONS: Parameters<typeof itt.analyseITT>[1]['requirements'] = [
    {
      reference: 'Q1',
      category: 'TECHNICAL',
      requirement: 'The Contractors proposed approach and methodology for the delivery of the proposed work.',
      mandatory: true,
      weightingPercent: 30,
      evidenceRequired: 'Written answer',
      responseLimit: { words: 1000, statedAs: 'No more than 1000 words are required per answer' },
    },
    {
      reference: 'Q3',
      category: 'HEALTH_AND_SAFETY',
      requirement: 'The Contractor’s proposed approach to managing Health and Safety for the works.',
      mandatory: true,
      weightingPercent: 15,
      evidenceRequired: 'Written answer',
    },
  ];

  let own: Platform;
  let mine: SeedResult;
  const seen: Array<Record<string, unknown>> = [];
  const asOwnQS = () => own.context(mine.users.qs!.auth, `${mine.tenantId}-governance`, { source: 'WEB' });
  const analyse = (reference: string, requirements: typeof SCOPE) =>
    itt.analyseITT(asOwnQS(), {
      reference,
      clientName: 'Conwy County Borough Council',
      returnBy: '2026-11-19',
      requirements,
      terms: { contractForm: 'NEC4 Engineering and Construction Short Contract' },
    }).analysisId;

  before(async () => {
    const adapter: AIProviderAdapter = {
      name: 'OPENAI',
      capability: 'REASONING',
      multimodal: false,
      transmits: false,
      estimateCostMinor: () => 40,
      healthy: () => true,
      async execute(request: ProviderRequest): Promise<ProviderResponse> {
        seen.push({ ...(request.payload as Record<string, unknown>) });
        return {
          provider: 'OPENAI',
          modelClass: 'test',
          output: { body: ['We maintain the Waterloo Hill footway behind barriers throughout.'] },
          rawCostMinor: 40,
          latencyMs: 5,
        };
      },
    };
    own = new Platform(new AIOrchestrator({ reasoning: adapter, perception: adapter }));
    mine = await seedDemoProject(own);
    own.wallet(mine.tenantId).topUp(1_000_000, 'Drafting top-up');
  });

  it('plans only the scored questions, and never the marking scheme or a drawing note', () => {
    const analysisId = analyse('ERCF2509N 05', [...SCOPE, ...QUESTIONS]);
    const { pack, toWrite } = bidresponse.planBidResponse(asOwnQS(), { analysisId });
    assert.equal(pack.basis, 'SCORED_QUESTIONS');
    assert.deepEqual(pack.sections.map((section) => section.key), ['Q1', 'Q3']);
    assert.equal(toWrite, 2);
    assert.equal(pack.sections[0]!.limit?.words, 1000, 'the per-answer limit is not carried to the section');
  });

  it('gives the drafter the rest of the tender, so a scored answer is about this job', async () => {
    const summary = bidresponse.bidResponsePosition(asOwnQS()).packs.find((p) => p.basis === 'SCORED_QUESTIONS')!;
    await bidresponse.writeNextSection(asOwnQS(), { packId: summary.id });
    const context = seen.at(-1)!.tenderContext as string[];
    assert.ok(Array.isArray(context), 'the drafter is not given the tender’s other requirements');
    assert.ok(context.some((entry) => /Waterloo Hill/.test(entry)));
    assert.ok(context.some((entry) => /209 kN/.test(entry)));
    assert.ok(!context.some((entry) => /dimensions are in metres|lowest bid|30% Quality/.test(entry)));
  });

  it('plans every written requirement where nothing is scored — less the drawing notes', () => {
    const scope = bidresponse.planScope(
      SCOPE.filter((line) => line.weightingPercent === undefined).map((line) => ({
        ...line,
        owner: 'OWNER',
        status: 'UNKNOWN',
      })),
    );
    assert.equal(scope.basis, 'WRITTEN_REQUIREMENTS');
    assert.deepEqual(scope.lines.map((line) => line.reference), ['4.1 Pedestrians', 'Scope - Testing']);
    assert.deepEqual(scope.context, []);
  });

  it('re-plans a pack read the old way onto the questionnaire, keeping prose still asked for', () => {
    // The Conwy position: a first reading with no scored questions planned every
    // line, and the questionnaire was read afterwards.
    const firstReading = analyse('ERCF2509N 05 A', SCOPE.filter((line) => line.weightingPercent === undefined));
    const old = bidresponse.planBidResponse(asOwnQS(), { analysisId: firstReading }).pack;
    assert.equal(old.basis, 'WRITTEN_REQUIREMENTS');
    bidresponse.reviseSection(asOwnQS(), { packId: old.id, key: '4.1 Pedestrians', body: ['Footway kept open.'] });

    const reread = analyse('ERCF2509N 05 A', [
      // Still a word-limited written answer, and already written word for word.
      { ...SCOPE[0]!, responseLimit: { words: 300, statedAs: '300 words' } },
      ...SCOPE.slice(1),
      ...QUESTIONS,
    ]);
    const result = bidresponse.replanBidResponse(asOwnQS(), { packId: old.id, analysisId: reread });
    assert.equal(result.pack.basis, 'SCORED_QUESTIONS');
    assert.equal(result.pack.analysisId, reread);
    assert.deepEqual(result.pack.sections.map((section) => section.key), ['4.1 Pedestrians', 'Q1', 'Q3']);
    assert.equal(result.kept, 1);
    assert.deepEqual(result.pack.sections[0]!.body, ['Footway kept open.'], 'written prose was thrown away');
    assert.equal(result.pack.sections[0]!.authorship, 'HUMAN');
    assert.equal(result.pack.sections[0]!.limit?.words, 300);
    assert.deepEqual(result.dropped, ['Scope - Testing']);
    assert.equal(result.toWrite, 2);
    assert.ok(result.pack.replannedAt);

    // The earlier plan is still on the ledger, not overwritten out of existence.
    const history = own.ledger.eventsForEntity({ refType: 'BidResponsePack', refId: old.id });
    assert.ok(history.some((event) => event.eventType === 'BID_RESPONSE_PLANNED'));
    assert.ok(history.some((event) => event.eventType === 'BID_RESPONSE_REPLANNED'));
  });

  it('refuses to re-plan onto a matrix another pack answers, or a pack already issued', () => {
    const position = bidresponse.bidResponsePosition(asOwnQS()).packs;
    const scored = position.find((p) => p.analysisId !== position[0]!.analysisId && p.basis === 'SCORED_QUESTIONS')!;
    const other = position.find((p) => p.id !== scored.id)!;
    throwsCode(
      () => bidresponse.replanBidResponse(asOwnQS(), { packId: other.id, analysisId: scored.analysisId }),
      'BID_RESPONSE_EXISTS',
    );

    const catalogue = new Map(EVENT_TYPES.map((entry) => [entry.code, entry]));
    assert.ok(catalogue.has('BID_RESPONSE_REPLANNED'));
    assert.notEqual(catalogue.get('BID_RESPONSE_REPLANNED')!.aiAllowed, true, 'an agent may not decide what is answered');
    assert.ok(
      ROUTES.some((r) => r.method === 'POST' && r.pattern === '/v1/projects/:projectId/bid-responses/:packId/replan'),
    );
  });

  it('reads the marking scheme as a rule, not a question', () => {
    assert.equal(bidresponse.isEvaluationMethod('Selection will be on the basis of 30% Quality and 70% Price'), true);
    assert.equal(bidresponse.isEvaluationMethod('The lowest bid will score the maximum points'), true);
    assert.equal(bidresponse.isEvaluationMethod('Q1 (30%) The Contractors proposed approach and methodology'), false);
    assert.equal(bidresponse.isEvaluationMethod('Describe how you will control cost and price changes'), false);
  });
});

/*
 * The same question, read from two documents of one tender.
 *
 * Wording copied from the real Conwy documents (ERCF2509N 05): Table 1 of
 * Volume 1 carries the weightings, Volume 2 Appendix 1 carries Q1–Q7 and the
 * 1,000-word limit. Read separately, they arrive as fourteen lines under
 * fourteen references. The pack must answer seven questions, each with its
 * weighting and its limit.
 */
describe('one question stated in two documents is answered once', () => {
  const TABLE_1: Array<[string, number]> = [
    ['The Contractors proposed approach and methodology for the delivery of the proposed work.', 30],
    ['The Contractor’s proposed approach to Project Management during execution of the works including key staff, duties and management and co-ordination of sub-contractors.', 10],
    ['The Contractor’s proposed approach to managing Health and Safety for the works and protecting the environment.', 15],
    ['The Contractor’s proposed approach to progress reporting and communication with Conwy County Borough Council during execution of the works, including the approach to reporting commercial issues.', 15],
    ['The Contractor’s approach to managing the quality of output on site, checking and supervision of the works.', 10],
    ['The Contractor’s perceived key risks in undertaking the works and the outline mitigation measures.', 10],
    ['The Contractor’s outline programme for the works including details of:  Start date, access dates, key dates and completion date.  Order and sequencing of the works.  Provisions for risk allowance.  Details of each planned operation including any resourcing and sub-contractor requirements.', 10],
  ];
  const APPENDIX_1 = [
    'The Contractors proposed approach and methodology for the delivery of the proposed work.',
    'The Contractor’s proposed approach to Project Management during execution of the works including key staff, duties and management and co-ordination of sub-contractors.',
    'The Contractor’s proposed approach to managing Health and Safety for the works and protecting the environment.',
    'The Contractor’s proposed approach to progress reporting and communication with Conwy County Borough Council during execution of the works, including the approach to reporting commercial issues.',
    'The Contractor’s approach to managing the quality of output on site, checking and supervision of the works.',
    'The Contractor’s perceived key risks in undertaking the works and the outline mitigation measures.',
    'The Contractor’s outline programme for the works including details of: Start date, access dates, key dates and completion date. Order and sequencing of the works. Provisions for risk allowance. Details of each planned operation including any resourcing and sub-contractor requirements.',
  ];
  const line = (over: Partial<import('../src/domain/itt.ts').MatrixLine>): import('../src/domain/itt.ts').MatrixLine => ({
    reference: 'X',
    category: 'QUALITY',
    requirement: '',
    mandatory: true,
    owner: 'OWNER',
    evidenceRequired: 'Written answer',
    status: 'UNKNOWN',
    ...over,
  });
  const LIMIT = { words: 1000, statedAs: 'No more than 1000 words are required per answer' };
  const matrix = [
    ...TABLE_1.map(([text, weight], i) => line({ reference: `2.3 Table 1 row ${i + 1}`, requirement: text, weightingPercent: weight })),
    ...APPENDIX_1.map((text, i) => line({ reference: `Q${i + 1}`, requirement: text, responseLimit: LIMIT })),
  ];

  it('plans seven sections, each with its weighting and its word limit', () => {
    const scope = bidresponse.planScope(matrix);
    assert.equal(scope.basis, 'SCORED_QUESTIONS');
    assert.equal(scope.lines.length, 7, `planned ${scope.lines.map((l) => l.reference).join(', ')}`);
    assert.deepEqual(scope.lines.map((l) => l.weightingPercent), [30, 10, 15, 15, 10, 10, 10]);
    assert.ok(scope.lines.every((l) => l.responseLimit?.words === 1000), 'a section lost the 1,000-word limit');
    assert.deepEqual(scope.lines.map((l) => l.alsoAnswers), APPENDIX_1.map((_, i) => [`Q${i + 1}`]));
  });

  it('folds a hazard read twice, and keeps two different drawing conventions apart', () => {
    const folded = bidresponse.foldDuplicates([
      line({ reference: '4.1 Road traffic', category: 'HEALTH_AND_SAFETY', requirement: 'Road traffic – road closure signs and diversion to be provided – road closure to vehicles arranged from 18/01/2027' }),
      line({ reference: '4.1 Hazards identified by the Client - road traffic', category: 'HEALTH_AND_SAFETY', requirement: 'Road traffic – road closure signs and diversion to be provided – road closure to vehicles arranged from 18/01/2027' }),
      line({ reference: 'N1', category: 'TECHNICAL', requirement: 'All dimensions are in metres unless otherwise stated.' }),
      line({ reference: 'N2', category: 'TECHNICAL', requirement: 'All chainages are in metres unless otherwise stated.' }),
    ]);
    assert.deepEqual(folded.map((l) => l.reference), ['4.1 Road traffic', 'N1', 'N2']);
    assert.deepEqual(folded[0]!.alsoAnswers, ['4.1 Hazards identified by the Client - road traffic']);
  });

  it('marks a folded section stale when an addendum changes the other document’s line', () => {
    const scope = bidresponse.planScope(matrix);
    const pack = {
      sections: [{ ...scope.lines[0]!, key: scope.lines[0]!.reference, title: 'Q1', deliverable: scope.lines[0]!.requirement, owner: 'OWNER', status: 'DRAFTED' as const, body: ['Answer.'], alsoAnswers: scope.lines[0]!.alsoAnswers }],
      deadlines: [{ what: 'Return', on: '2026-11-19' }],
      returnBy: '2026-11-19',
    } as unknown as Parameters<typeof bidresponse.bidCompleteness>[0];
    const stale = bidresponse.bidCompleteness(pack, [], [], [
      { reference: 'Q1', material: true, addendum: 'ADD-01', detail: 'Word limit changed' } as unknown as import('../src/domain/addendum.ts').AddendumImpact,
    ]).staleSections;
    assert.deepEqual(stale.map((s) => s.key), ['2.3 Table 1 row 1']);
  });
});

/*
 * A section's key is the buyer's own reference, and buyers write anything:
 * "Amlinelliad o Ofynion y Cytundeb:⏎Outline of Contract Requirements:". Put in
 * a URL path unencoded, the line break is stripped by the browser, a "/" splits
 * the path and a "\" becomes "/" — and the server answers "has no section" for a
 * section that exists. That is what the Redraft button did on BID-0001.
 */
describe('a section key travels in a URL encoded', () => {
  it('every section route the screen calls encodes the key', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const pages = readdirSync('frontend/pages').filter((file) => file.endsWith('.js'));
    const unencoded: string[] = [];
    for (const file of pages) {
      const source = readFileSync(`frontend/pages/${file}`, 'utf8');
      for (const match of source.matchAll(/\/sections\/\$\{([^}]*)\}/g)) {
        if (!match[1]!.startsWith('encodeURIComponent(')) unencoded.push(`${file}: /sections/\${${match[1]}}`);
      }
    }
    assert.deepEqual(unencoded, [], 'a section key is put in a URL without encoding');
  });
});
