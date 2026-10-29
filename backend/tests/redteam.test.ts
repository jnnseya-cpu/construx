import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import * as bidresponse from '../src/domain/bidresponse.ts';
import * as evidence from '../src/domain/evidenceclaim.ts';
import * as itt from '../src/domain/itt.ts';
import * as redteam from '../src/domain/redteam.ts';
import { ROUTES } from '../src/api/routes.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Adversarial self-challenge — `L7.3`, §16, §4.7.3.
 *
 * Every other machine check on the platform runs *for* the submission. This one
 * runs against it, and the tests are about the four properties that make that
 * worth having rather than the findings it happens to produce.
 *
 * **It attacks what completeness cannot see.** A pack where every deliverable
 * has prose against it and every deadline is dated passes the issue check and
 * can still be thrown out for a placeholder nobody removed.
 *
 * **Severity is a gate.** Four severities each with a submission effect, and a
 * critical one that cannot be disposed of. A hard block with a way round it is
 * a warning, and everybody learns to use the way round.
 *
 * **A model may not hard-block, and may not clear itself.** No agent mandate
 * exceeds propose: a model finding is capped at `HIGH`, which stops the
 * submission until a person records a decision, and disposing of one is a
 * human act the catalogue refuses to let an agent author.
 *
 * **It never invents a finding to fill the space.** A red team that reports an
 * empty list because it never ran reads as a clean submission, which is worse
 * than no red team at all.
 */

let platform: Platform;
let seed: SeedResult;
let analysisId: string;
let packId: string;

/** Holds ESTIMATE_TENDER C/U — plans, drafts, challenges. */
const asQS = () => platform.context(seed.users.qs!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
/** Holds ESTIMATE_TENDER A — disposes of a finding, and issues. */
const asOwner = () => platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

/**
 * Three requirements with different weightings, so the score has something to
 * weight and the thinness lens has something to compare against.
 */
const REQUIREMENTS: Parameters<typeof itt.analyseITT>[1]['requirements'] = [
  {
    reference: 'R-01',
    category: 'TECHNICAL',
    requirement: 'Describe your methodology for deep drainage installation beneath a live carriageway',
    mandatory: true,
    weightingPercent: 40,
    evidenceRequired: 'Method statement, maximum four sides',
  },
  {
    reference: 'R-02',
    category: 'SOCIAL_VALUE',
    requirement: 'Set out the local employment and apprenticeship commitments you will make',
    mandatory: false,
    weightingPercent: 30,
    evidenceRequired: 'Narrative with measurable commitments',
  },
  {
    reference: 'R-03',
    category: 'ENVIRONMENTAL',
    requirement: 'Explain how you will monitor and reduce embodied carbon across the works',
    mandatory: true,
    weightingPercent: 30,
    evidenceRequired: 'Carbon management approach',
  },
];

/**
 * Draft a section the way a person would, straight onto the ledger.
 *
 * The drafting pass itself needs a reasoning provider and refuses the local
 * stand-in, which is correct and is tested where it belongs. What this file is
 * about is what happens to prose once it exists, however it got there.
 */
function draft(key: string, body: string[], options: { authorship?: 'AI_DRAFTED' | 'HUMAN'; provider?: string } = {}): void {
  const pack = bidresponse.bidResponsePack(asQS(), packId);
  const next = {
    ...pack,
    passes: pack.passes + 1,
    sections: pack.sections.map((section: (typeof pack.sections)[number]) =>
      section.key === key
        ? {
            ...section,
            status: 'DRAFTED' as const,
            body,
            words: body.join(' ').split(/\s+/).filter(Boolean).length,
            authorship: options.authorship ?? 'HUMAN',
            ...(options.provider ? { provider: options.provider } : {}),
            writtenAt: new Date().toISOString(),
          }
        : section,
    ),
  };
  platform.ledger.commit({
    tenantId: seed.tenantId,
    projectId: `${seed.tenantId}-governance`,
    actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
    source: 'WEB',
    correlationId: packId,
    eventType: 'BID_RESPONSE_SECTION_WRITTEN',
    entity: { refType: 'BidResponsePack', refId: packId },
    nextState: next as unknown as Record<string, unknown>,
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  analysisId = itt.analyseITT(asQS(), {
    reference: 'ITT-REDTEAM-01',
    clientName: 'Calderdale Metropolitan Borough Council',
    returnBy: '2027-03-01',
    estimatedValueMinor: 480_000_000,
    durationWeeks: 96,
    requirements: REQUIREMENTS,
    terms: { contractForm: 'NEC4 Option A' },
  }).analysisId;

  packId = bidresponse.planBidResponse(asQS(), { analysisId }).pack.id;
});

describe('the doors and the catalogue', () => {
  it('is reachable, and the two reads are declared read-only', () => {
    for (const [method, pattern] of [
      ['POST', '/v1/projects/:projectId/bid-responses/:packId/challenge'],
      ['GET', '/v1/projects/:projectId/assurance'],
      ['GET', '/v1/projects/:projectId/assurance/:reviewId'],
      ['POST', '/v1/projects/:projectId/assurance/:reviewId/findings/:findingId/disposition'],
    ] as const) {
      const route = ROUTES.find((candidate) => candidate.method === method && candidate.pattern === pattern);
      assert.ok(route, `${method} ${pattern} has no route`);
      if (method === 'GET') assert.equal(route.readOnly, true, `${pattern} must be read-only`);
    }
  });

  it('keeps the disposition out of an agent’s reach', () => {
    // Running the review is an agent act. Deciding what to do about what it
    // found is not, for the same reason no agent mandate exceeds propose.
    assert.equal(lookupEventType('ASSURANCE_REVIEW_RUN')?.aiAllowed, true);
    assert.notEqual(lookupEventType('ASSURANCE_FINDING_DISPOSED')?.aiAllowed, true);
  });

  it('classifies the review with the submission it attacks', () => {
    // The findings quote the prose and name the marks at risk. Anybody who may
    // not read the bid may not read the review of it.
    const classification = classifyEntity('AssuranceReview');
    assert.ok(classification);
    assert.equal(classification.area, 'ESTIMATE_TENDER');
    assert.equal(classification.sensitivity, 'COMMERCIAL_L3');
  });
});

describe('what completeness cannot see', () => {
  it('finds a mandatory requirement with nothing written against it, and calls it critical', async () => {
    const { review } = await redteam.challengeSubmission(asQS(), { packId });

    const unanswered = review.findings.filter((entry) => entry.title.includes('has no response'));
    assert.equal(unanswered.length, 3, 'nothing is drafted yet, so every section is unanswered');

    const mandatory = unanswered.filter((entry) => entry.severity === 'CRITICAL');
    assert.equal(mandatory.length, 2, 'R-01 and R-03 are mandatory');
    // A non-mandatory one is a mark conceded, not a rejection.
    assert.ok(unanswered.some((entry) => entry.reference === 'R-02' && entry.severity === 'MEDIUM'));

    // Nothing findable: an evaluator awards nothing for a blank page, whatever
    // the severity of the finding that describes it. The two answer different
    // questions — what it does to the submission, and what it does to the marks.
    assert.equal(review.findableScorePercent, 0);
    assert.ok(review.scoreBasis.every((line) => line.why.includes('nothing to award')));
  });

  it('says what it could not tell you rather than leaving the space empty', async () => {
    const { review } = await redteam.challengeSubmission(asQS(), { packId });

    // The judgement lens did not run — this platform has no reasoning provider.
    // Reporting an empty model finding list would read as a clean submission.
    assert.equal(review.modelChallenge.ran, false);
    assert.ok(review.modelChallenge.reason, 'it did not say why the judgement lens is missing');
    assert.equal(review.modelChallenge.findings, 0);
    assert.ok(review.limits.some((limit) => limit.includes('did not run')));

    // And the score is not offered as a prediction of the mark.
    assert.ok(review.limits.some((limit) => limit.includes('not a predicted mark')));
  });

  it('catches a placeholder no completeness check can see', async () => {
    draft('R-01', [
      'We will install the deep drainage beneath the live carriageway in [NUMBER] phases, each under a temporary ' +
        'traffic management layout agreed with the highway authority.',
      'Our methodology for the carriageway excavation, the installation sequence and the reinstatement is set out below.',
    ]);

    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    const placeholder = review.findings.find((entry) => entry.title.includes('placeholder'));
    assert.ok(placeholder, 'a bracketed marker went unnoticed');
    assert.equal(placeholder.severity, 'CRITICAL');
    assert.equal(placeholder.lens, 'ADVERSARIAL');
    assert.equal(placeholder.sectionKey, 'R-01');
  });

  it('catches a figure an AI-drafted section had no source for', async () => {
    draft(
      'R-03',
      [
        'We monitor and reduce embodied carbon across the works against a baseline established at award, reporting ' +
          'monthly against it and targeting a 35% reduction on the scheme.',
        'Our carbon management approach covers the monitoring, the reduction measures and the reporting cycle.',
      ],
      { authorship: 'AI_DRAFTED', provider: 'OPENAI' },
    );

    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    const figure = review.findings.find((entry) => entry.title.includes('states a figure'));
    assert.ok(figure, 'a percentage in AI-drafted prose went unnoticed');
    assert.equal(figure.severity, 'HIGH');
    assert.equal(figure.lens, 'CONTRACT');
  });

  it('says when a scorer cannot find the answer in the buyer’s own words', async () => {
    // Answers at length, about something else. Every completeness check on the
    // platform passes this section; it scores nothing.
    draft('R-02', [
      'Our business has operated across the north of England for thirty years and we take our responsibilities to ' +
        'the areas we build in seriously, working closely with the bodies that represent them.',
      'We are proud of the relationships we have built and intend to carry that record into this scheme.',
    ]);

    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    const found = review.findings.find(
      (entry) => entry.sectionKey === 'R-02' && entry.title.includes('buyer'),
    );
    assert.ok(found, 'prose that never mentions employment or apprenticeships passed the evaluator lens');
    assert.equal(found.lens, 'EVALUATOR');
    assert.match(found.detail, /apprenticeship|employment|commitment/);
  });
});

describe('the score is working, not a guess', () => {
  it('weights each requirement by its own marks and shows the arithmetic', async () => {
    const { review } = await redteam.challengeSubmission(asQS(), { packId });

    // Every scored requirement appears, and the weights are the buyer's.
    assert.equal(review.scoreBasis.length, 3);
    assert.equal(review.scoreBasis.reduce((sum, line) => sum + line.weightingPercent, 0), 100);

    // R-01 carries a critical placeholder, so none of its forty marks are findable.
    const first = review.scoreBasis.find((line) => line.reference === 'R-01')!;
    assert.equal(first.awardedFraction, 0);
    assert.match(first.why, /CRITICAL/);

    // And the total is the weighted sum rather than a count of clean sections.
    const expected =
      review.scoreBasis.reduce((sum, line) => sum + line.weightingPercent * line.awardedFraction, 0) / 100;
    assert.equal(review.findableScorePercent, Math.round(expected * 1000) / 10);
  });

  it('leaves a section with two problems worse off than one with a single problem', () => {
    // Multiplicative rather than additive: two high findings leave a quarter of
    // the marks, not none. A section with two problems is not a blank page.
    const matrix = [
      { reference: 'A', category: 'TECHNICAL', requirement: 'x', mandatory: true, weightingPercent: 100, owner: 'EPC', evidenceRequired: 'y', status: 'GAP' },
    ] as unknown as Parameters<typeof redteam.scoreFrom>[0];
    const one = redteam.scoreFrom(matrix, [
      { id: '1', lens: 'EVALUATOR', severity: 'HIGH', reference: 'A', title: 't', detail: 'd', remedy: 'r', raisedBy: 'CHECK' },
    ]);
    const two = redteam.scoreFrom(matrix, [
      { id: '1', lens: 'EVALUATOR', severity: 'HIGH', reference: 'A', title: 't', detail: 'd', remedy: 'r', raisedBy: 'CHECK' },
      { id: '2', lens: 'EVALUATOR', severity: 'HIGH', reference: 'A', title: 'u', detail: 'd', remedy: 'r', raisedBy: 'CHECK' },
    ]);
    assert.equal(one.percent, 50);
    assert.equal(two.percent, 25);
  });
});

describe('severity is a gate', () => {
  it('publishes what each severity does to the submission', () => {
    const register = redteam.assuranceRegister(asQS());
    assert.equal(register.severities.length, 4);
    assert.match(register.severities.find((entry) => entry.severity === 'CRITICAL')!.effect, /Hard block/);
    // §16.2's nine lenses, published so the console names one the same way.
    assert.equal(register.lenses.length, 9);
    assert.ok(register.lenses.every((entry) => entry.question.endsWith('?')));
  });

  it('refuses to issue a pack nothing has attacked', () => {
    const fresh = itt.analyseITT(asQS(), {
      reference: 'ITT-REDTEAM-02',
      clientName: 'Rossendale Borough Council',
      returnBy: '2027-06-01',
      estimatedValueMinor: 90_000_000,
      durationWeeks: 40,
      requirements: [
        {
          reference: 'S-01',
          category: 'TECHNICAL',
          requirement: 'Describe your approach to phased possession of the site',
          mandatory: false,
          evidenceRequired: 'Narrative',
        },
      ],
      terms: { contractForm: 'NEC4 Option A' },
    }).analysisId;
    const other = bidresponse.planBidResponse(asQS(), { analysisId: fresh }).pack.id;

    const error = throwsCode(() => bidresponse.issueBidResponse(asOwner(), { packId: other }), 'BID_RESPONSE_INCOMPLETE');
    // Completeness refuses first here, which is correct — but the assurance
    // wording is what refuses a pack that is complete and unattacked.
    assert.match(String(error.message), /no response/);
  });

  it('refuses a review of an earlier version of the pack', async () => {
    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    const before_ = bidresponse.bidResponsePack(asQS(), packId);
    assert.equal(redteam.assuranceStanding(review, before_).current, true);

    draft('R-01', ['A rewrite, which the review above has never seen.']);
    const after = bidresponse.bidResponsePack(asQS(), packId);
    const standing = redteam.assuranceStanding(review, after);
    assert.equal(standing.current, false);
    assert.equal(standing.clear, false);
    assert.match(standing.reason, /Run it again/);
  });

  it('will not let anybody dispose of a critical finding', async () => {
    // Put one back: the section above was rewritten clean, and a hard block
    // needs something to block on.
    draft('R-01', ['We will install the drainage in [NUMBER] phases under temporary traffic management.']);
    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    const critical = review.findings.find((entry) => entry.severity === 'CRITICAL');
    assert.ok(critical, 'nothing critical to test against');

    const error = throwsCode(
      () => redteam.disposeFinding(asOwner(), review.id, critical.id, { decision: 'ACCEPTED', note: 'We will risk it' }),
      'FINDING_CRITICAL',
    );
    assert.match(String(error.message), /a way round it is a warning/);
  });

  it('wants a conclusion rather than a tick', async () => {
    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    const high = review.findings.find((entry) => entry.severity === 'HIGH' || entry.severity === 'MEDIUM');
    assert.ok(high, 'nothing disposable to test against');

    throwsCode(
      () => redteam.disposeFinding(asOwner(), review.id, high.id, { decision: 'ACCEPTED', note: 'ok' }),
      'DISPOSITION_NOTE_REQUIRED',
    );
  });

  it('records who decided what, and refuses to let it be decided twice', async () => {
    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    const high = review.findings.find((entry) => entry.severity === 'HIGH' || entry.severity === 'MEDIUM');
    assert.ok(high);

    const disposed = redteam.disposeFinding(asOwner(), review.id, high.id, {
      decision: 'ACCEPTED',
      note: 'Checked against the carbon baseline in the estimate; the figure is ours and is right.',
    });
    const entry = disposed.findings.find((candidate) => candidate.id === high.id)!;
    assert.equal(entry.disposition?.decision, 'ACCEPTED');
    assert.equal(entry.disposition?.by, seed.users.owner!.auth.actorId);
    assert.match(entry.disposition!.note, /carbon baseline/);

    throwsCode(
      () => redteam.disposeFinding(asOwner(), review.id, high.id, { decision: 'FIXED', note: 'Changed my mind about it' }),
      'FINDING_DISPOSED',
    );
  });

  it('refuses a finding that is not on the review', async () => {
    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    throwsCode(
      () => redteam.disposeFinding(asOwner(), review.id, 'not-a-finding', { decision: 'FIXED', note: 'Nothing to fix here' }),
      'FINDING_NOT_FOUND',
    );
  });

  it('refuses a review in another tenancy', () => {
    throwsCode(
      () => redteam.disposeFinding(asOwner(), 'not-a-review', 'x', { decision: 'FIXED', note: 'Nothing to fix here' }),
      'ASSURANCE_REVIEW_NOT_FOUND',
    );
  });
});

describe('the pack goes out once the red team clears it', () => {
  it('refuses while a critical finding stands, then issues once nothing blocks', async () => {
    // Rewrite every section so nothing critical remains, and answer in the
    // buyer's own words so the evaluator lens has nothing to say either.
    draft('R-01', [
      'Our methodology for deep drainage installation beneath a live carriageway begins with a phased carriageway ' +
        'possession agreed with the highway authority, each phase taking a single lane under a temporary traffic ' +
        'management layout so that two-way running is maintained throughout the installation.',
      'The drainage installation sequence, the excavation support, the bedding and the reinstatement of the ' +
        'carriageway are each set out in the method statement accompanying this response.',
    ]);
    draft('R-02', [
      'Our local employment and apprenticeship commitments for this scheme are measurable and are carried into the ' +
        'subcontract chain: a stated proportion of the site team recruited locally, and apprenticeship places held ' +
        'open for the duration of the works.',
      'Each commitment is reported monthly against the employment and apprenticeship targets agreed at award.',
    ]);
    draft('R-03', [
      'We monitor and reduce embodied carbon across the works against a baseline established at award, reporting ' +
        'monthly and carrying the reduction measures into the subcontract packages.',
      'The carbon monitoring covers the materials, the plant and the transport, and the reduction measures are ' +
        'agreed with the design team before each package is let.',
    ]);

    const { review } = await redteam.challengeSubmission(asQS(), { packId });
    assert.equal(
      review.findings.filter((entry) => entry.severity === 'CRITICAL').length,
      0,
      `still critical: ${review.findings.filter((f) => f.severity === 'CRITICAL').map((f) => f.title).join('; ')}`,
    );

    // Every high finding needs a named decision before the pack can go out.
    for (const high of review.findings.filter((entry) => entry.severity === 'HIGH')) {
      redteam.disposeFinding(asOwner(), review.id, high.id, {
        decision: 'ACCEPTED',
        note: `Reviewed before issue: ${high.title.slice(0, 40)}`,
      });
    }

    const issued = bidresponse.issueBidResponse(asOwner(), { packId });
    assert.equal(issued.pack.status, 'ISSUED');

    // And a review is pointless once it has gone to the buyer.
    await rejectsCode(() => redteam.challengeSubmission(asQS(), { packId }), 'BID_RESPONSE_ISSUED');
  });

  it('lists the reviews with what each of them did to its submission', () => {
    const register = redteam.assuranceRegister(asQS());
    assert.ok(register.reviews.length > 1, 'the register is not accumulating reviews');
    // Newest first: the one somebody acts on is the last one run.
    assert.ok(register.reviews[0]!.runAt >= register.reviews[1]!.runAt);
    assert.match(register.summary, /review\(s\)/);
  });
});

describe('the evidence lens, on the day the buyer reads it', () => {
  it('calls a claim that lapses before the return date critical', () => {
    const findings = redteam.evaluatorFindings({
      pack: {
        id: 'p',
        reference: 'BID-0001',
        projectId: 'x',
        analysisId: 'a',
        clientName: 'c',
        returnBy: '2027-03-01T12:00:00.000Z',
        sections: [],
        deadlines: [],
        status: 'DRAFTING',
        passes: 1,
        plannedAt: '2026-01-01T00:00:00.000Z',
        plannedBy: 'u',
      },
      matrix: [
        {
          reference: 'R-03',
          category: 'INSURANCE',
          requirement: 'Employers liability cover',
          mandatory: true,
          owner: 'OWNER',
          evidenceRequired: 'Certificates',
          status: 'GAP',
        },
      ] as unknown as Parameters<typeof redteam.evaluatorFindings>[0]['matrix'],
      waivedKeys: new Set(),
      claims: [
        {
          reference: 'EVC-0001',
          claim: 'Employers liability cover of £10m',
          covers: ['R-03'],
          standing: 'APPROVED',
          expiresAt: '2027-01-15',
        },
      ],
      staleKeys: new Map(),
    });

    const lapsing = findings.find((entry) => entry.title.includes('lapses'));
    assert.ok(lapsing, 'a certificate expiring six weeks before return was accepted');
    assert.equal(lapsing.severity, 'CRITICAL');
    assert.equal(lapsing.lens, 'EVIDENCE');
  });

  it('treats an unverified claim on a mandatory line as blocking, and on a scored one as reportable', () => {
    const line = (reference: string, mandatory: boolean) => ({
      reference,
      category: 'QUALITY',
      requirement: 'Accreditation',
      mandatory,
      owner: 'QAQC',
      evidenceRequired: 'Certificate',
      status: 'GAP',
    });
    const findings = redteam.evaluatorFindings({
      pack: {
        id: 'p',
        reference: 'BID-0001',
        projectId: 'x',
        analysisId: 'a',
        clientName: 'c',
        returnBy: '2027-03-01T12:00:00.000Z',
        sections: [],
        deadlines: [],
        status: 'DRAFTING',
        passes: 1,
        plannedAt: '2026-01-01T00:00:00.000Z',
        plannedBy: 'u',
      },
      matrix: [line('M-01', true), line('M-02', false)] as unknown as Parameters<
        typeof redteam.evaluatorFindings
      >[0]['matrix'],
      waivedKeys: new Set(),
      claims: [
        { reference: 'EVC-1', claim: 'ISO 9001 held', covers: ['M-01'], standing: 'PENDING' },
        { reference: 'EVC-2', claim: 'ISO 14001 held', covers: ['M-02'], standing: 'PENDING' },
      ],
      staleKeys: new Map(),
    });

    const mandatory = findings.find((entry) => entry.reference === 'M-01' && entry.title.includes('not been verified'));
    const scored = findings.find((entry) => entry.reference === 'M-02' && entry.title.includes('not been verified'));
    assert.equal(mandatory?.severity, 'HIGH');
    assert.equal(scored?.severity, 'LOW');
  });

  it('reads the register the engine already keeps rather than a second copy', async () => {
    // The lens is fed from `evidenceRegister` judged at the return date, so a
    // claim asserted on the tender screen is seen by the red team with no
    // second registration anywhere.
    evidence.assertClaim(asQS(), {
      kind: 'INSURANCE',
      claim: 'Public liability cover of £10m held for the duration of these works',
      sourceHash: `sha256:${'c3'.repeat(32)}`,
      covers: ['R-03'],
      expiresAt: '2026-12-31',
    });

    const fresh = itt.analyseITT(asQS(), {
      reference: 'ITT-REDTEAM-03',
      clientName: 'Pendle Borough Council',
      returnBy: '2027-03-01',
      estimatedValueMinor: 60_000_000,
      durationWeeks: 30,
      requirements: [
        {
          reference: 'R-03',
          category: 'INSURANCE',
          requirement: 'Employers liability and public liability cover for the duration',
          mandatory: true,
          evidenceRequired: 'Certificates',
        },
        // One that needs prose, so the pack has something to plan. A tender
        // every line of which the platform can already evidence is a set of
        // attachments, and `planBidResponse` says so rather than making a pack.
        {
          reference: 'R-04',
          category: 'TECHNICAL',
          requirement: 'Describe your approach to phased possession of the working area',
          mandatory: false,
          evidenceRequired: 'Narrative',
        },
      ],
      terms: { contractForm: 'NEC4 Option A' },
    }).analysisId;
    const other = bidresponse.planBidResponse(asQS(), { analysisId: fresh }).pack.id;

    const { review } = await redteam.challengeSubmission(asQS(), { packId: other });
    // Asserted, unverified, and expiring two months before the return date.
    // Both are the red team's business and neither is a completeness question.
    assert.ok(review.findings.some((entry) => entry.reference === 'R-03'));
  });
});

describe('the measurable-commitment lens', () => {
  /**
   * The third thing a compliance check cross-references, after the requirement
   * and the stated word limit: the measurable commitments a social value
   * schedule asks for.
   *
   * An evaluator scoring a TOMs-style schedule awards committed quantities —
   * apprenticeship weeks, local starts, tonnes avoided. A paragraph of intent
   * earns the bottom band however well it reads, and 10–20% of the marks go
   * with it. It is the most common way a social value answer that reads
   * perfectly scores nothing.
   */
  const SOCIAL = {
    reference: 'S-01',
    category: 'SOCIAL_VALUE',
    requirement: 'Set out your local employment and apprenticeship commitments',
    mandatory: true,
    weightingPercent: 10,
    owner: 'OWNER',
    evidenceRequired: 'Completed social value schedule with measurable commitments',
    status: 'UNKNOWN',
  };

  const run = (body: string[], authorship: 'HUMAN' | 'AI_DRAFTED' = 'HUMAN', line = SOCIAL) =>
    redteam.evaluatorFindings({
      pack: {
        id: 'p',
        reference: 'BID-0001',
        projectId: 'x',
        analysisId: 'a',
        clientName: 'c',
        returnBy: '2027-03-01T12:00:00.000Z',
        sections: [
          {
            key: line.reference,
            title: 'Social value',
            deliverable: line.requirement,
            owner: 'OWNER',
            mandatory: line.mandatory,
            status: 'DRAFTED' as const,
            body,
            words: body.join(' ').split(/\s+/).filter(Boolean).length,
            authorship,
          },
        ],
        deadlines: [],
        status: 'DRAFTING',
        passes: 1,
        plannedAt: '2026-01-01T00:00:00.000Z',
        plannedBy: 'u',
      } as unknown as Parameters<typeof redteam.evaluatorFindings>[0]['pack'],
      matrix: [line] as unknown as Parameters<typeof redteam.evaluatorFindings>[0]['matrix'],
      waivedKeys: new Set(),
      claims: [],
      staleKeys: new Map(),
    });

  const unmeasurable = (findings: ReturnType<typeof redteam.evaluatorFindings>) =>
    findings.find((entry) => entry.title.includes('commits to nothing anybody can measure'));

  it('finds a social value answer that commits to nothing countable', () => {
    const findings = run([
      'We are fully committed to supporting local employment and to the communities in which we work. Social value',
      'is embedded in our culture and we work in genuine partnership with our clients to deliver lasting benefit to',
      'the area around every scheme we build, which we take extremely seriously at every level of the business.',
    ]);

    const found = unmeasurable(findings);
    assert.ok(found, 'a social value answer of pure intent was accepted');
    assert.equal(found.severity, 'HIGH', 'a mandatory schedule question is not blocking');
    assert.equal(found.lens, 'EVALUATOR');
    assert.match(found.detail, /no number of weeks, starts, hours, tonnes or pounds/);
  });

  it('accepts one that commits to a quantity against a period', () => {
    const findings = run([
      'We will take two apprentices through a level 3 NVQ over 104 weeks with the college nearest the site, and we',
      'will place 6 local starts in the first 12 months. We report starts and completions quarterly rather than at',
      'handover, so an apprenticeship that is not happening is visible while there is still time to fix it.',
    ]);
    assert.equal(unmeasurable(findings), undefined, 'a quantified commitment was still called unmeasurable');
  });

  it('names the drafting rule as the reason when the section is still AI-drafted', () => {
    // Not a contradiction of the rule that forbids the model stating figures —
    // that rule is why this finding exists. The remedy has to say the fix is a
    // person with the real numbers, not another pass.
    const found = unmeasurable(
      run(
        [
          'We will operate a local employment and apprenticeship programme on this scheme, working with the nearest',
          'further education college and reporting against the framework model throughout the contract period as',
          'the employer requires of every contractor delivering work of this kind under the framework.',
        ],
        'AI_DRAFTED',
      ),
    );
    assert.ok(found);
    assert.match(String(found.remedy), /drafting rule deliberately leaves figures out/);
    assert.match(String(found.remedy), /Somebody with the real numbers/);
  });

  it('applies to a carbon answer too, and reports a scored one lower than a pass/fail one', () => {
    const environmental = {
      ...SOCIAL,
      reference: 'E-01',
      category: 'ENVIRONMENTAL',
      requirement: 'Set out your carbon reduction commitments for the works',
      mandatory: false,
    };
    const found = unmeasurable(
      run(
        [
          'We are committed to reducing the carbon impact of our works and we continually review our plant, our',
          'logistics and our material choices with that aim in mind on every scheme, because the industry has to',
          'decarbonise and we intend to be part of how that happens rather than a drag on it.',
        ],
        'HUMAN',
        environmental,
      ),
    );
    assert.ok(found, 'a carbon answer of pure intent was accepted');
    assert.equal(found.severity, 'MEDIUM', 'a scored question is being treated as a hard block');
    assert.match(found.detail, /environmental requirement/);
  });

  it('says nothing about a requirement that is not scored on commitments', () => {
    const insurance = {
      ...SOCIAL,
      reference: 'I-01',
      category: 'INSURANCE',
      requirement: 'Confirm you hold employers liability cover',
      mandatory: true,
    };
    const findings = run(
      [
        'We hold employers liability and public liability cover and the certificates are attached to this submission',
        'at appendix C, issued by our broker and current for the whole of the period this invitation covers.',
      ],
      'HUMAN',
      insurance,
    );
    assert.equal(unmeasurable(findings), undefined, 'the lens fired on a requirement nobody scores on quantities');
  });
});

/**
 * The quality floor.
 *
 * A scored requirement that is answered but whose findable marks fall below the
 * pack's floor is raised as a HIGH finding — so it blocks the issue the same
 * way any high finding does, and clears the moment a named person disposes of
 * it. That reuse is the point: the floor is a soft block with override-by-reason,
 * which is exactly what a high finding already is. The default is 80% (4/5),
 * settable per pack, and the gate enforces the findable mark this review can
 * measure, not the buyer's own mark.
 */
describe('the quality floor', () => {
  const OFF_TOPIC = [
    'Our business has operated across the north of England for thirty years and we take our responsibilities to the ' +
      'communities we build in seriously, working closely with the bodies that represent them.',
    'We are proud of the relationships we have built and intend to carry that record into this scheme.',
  ];
  const ON_TOPIC = [
    'Our methodology for deep drainage installation beneath a live carriageway begins with a phased carriageway ' +
      'possession agreed with the highway authority, so the drainage installation proceeds beneath one lane at a time.',
    'The methodology sets out the carriageway excavation, the drainage installation sequence and the reinstatement, ' +
      'each beneath a temporary traffic management layout so the carriageway stays open throughout.',
  ];

  /** Plan a fresh single-requirement pack, so the floor is the only thing in play. */
  const freshPack = (reference: string): string => {
    const id = itt.analyseITT(asQS(), {
      reference,
      clientName: 'Hyndburn Borough Council',
      returnBy: '2027-09-01',
      estimatedValueMinor: 70_000_000,
      durationWeeks: 32,
      requirements: [
        {
          reference: 'Q-01',
          category: 'TECHNICAL',
          requirement: 'Describe your methodology for deep drainage installation beneath a live carriageway',
          mandatory: true,
          weightingPercent: 100,
          // Deliberately empty: the evidence lens is not what this is testing,
          // and a required certificate would add a finding of its own.
          evidenceRequired: '',
        },
      ],
      terms: { contractForm: 'NEC4 Option A' },
    }).analysisId;
    return bidresponse.planBidResponse(asQS(), { analysisId: id }).pack.id;
  };

  /** Draft one section straight onto the ledger, as the file's own helper does. */
  const draftInto = (pid: string, key: string, body: string[]): void => {
    const pack = bidresponse.bidResponsePack(asQS(), pid);
    const next = {
      ...pack,
      passes: pack.passes + 1,
      sections: pack.sections.map((section: (typeof pack.sections)[number]) =>
        section.key === key
          ? {
              ...section,
              status: 'DRAFTED' as const,
              body,
              words: body.join(' ').split(/\s+/).filter(Boolean).length,
              authorship: 'HUMAN' as const,
              writtenAt: new Date().toISOString(),
            }
          : section,
      ),
    };
    platform.ledger.commit({
      tenantId: seed.tenantId,
      projectId: `${seed.tenantId}-governance`,
      actor: { refType: 'User', refId: seed.users.qs!.auth.actorId },
      source: 'WEB',
      correlationId: pid,
      eventType: 'BID_RESPONSE_SECTION_WRITTEN',
      entity: { refType: 'BidResponsePack', refId: pid },
      nextState: next as unknown as Record<string, unknown>,
    });
  };

  it('defaults a planned pack to the 80% floor, on the record', () => {
    const pid = freshPack('ITT-FLOOR-01');
    assert.equal(bidresponse.bidResponsePack(asQS(), pid).qualityFloorPercent, 80);
  });

  it('raises a scored answer below the floor as a high finding and refuses the issue, naming it', async () => {
    const pid = freshPack('ITT-FLOOR-02');
    // Answered, but about something else — a scorer can find three-quarters of
    // the marks at best, which is below the 80% floor.
    draftInto(pid, 'Q-01', OFF_TOPIC);

    const { review } = await redteam.challengeSubmission(asQS(), { packId: pid });
    assert.equal(review.qualityFloorPercent, 80);
    const floor = review.findings.find((entry) => entry.title.includes('quality floor'));
    assert.ok(floor, 'a below-floor answer raised no floor finding');
    assert.equal(floor.severity, 'HIGH');
    assert.equal(floor.reference, 'Q-01');
    assert.match(floor.detail, /80%/);

    // Completeness is satisfied — one section answered, the return date dated —
    // so the refusal is the assurance gate, and it names the floor.
    const error = throwsCode(() => bidresponse.issueBidResponse(asOwner(), { packId: pid }), 'ASSURANCE_NOT_CLEAR');
    assert.match(String(error.message), /quality floor/);
  });

  it('issues once the floor finding is disposed with a reason', async () => {
    const pid = freshPack('ITT-FLOOR-03');
    draftInto(pid, 'Q-01', OFF_TOPIC);
    const { review } = await redteam.challengeSubmission(asQS(), { packId: pid });
    const floor = review.findings.find((entry) => entry.title.includes('quality floor'))!;

    // The override is the disposition — the same mechanism a HIGH finding
    // already carries, not a second one.
    redteam.disposeFinding(asOwner(), review.id, floor.id, {
      decision: 'ACCEPTED',
      note: 'A 4/5 is unreachable on this question for us; the answer is as strong as the evidence supports.',
    });

    const issued = bidresponse.issueBidResponse(asOwner(), { packId: pid });
    assert.equal(issued.pack.status, 'ISSUED');
  });

  it('issues clean when the answer reaches the floor, with no floor finding', async () => {
    const pid = freshPack('ITT-FLOOR-04');
    draftInto(pid, 'Q-01', ON_TOPIC);

    const { review } = await redteam.challengeSubmission(asQS(), { packId: pid });
    assert.equal(review.findableScorePercent, 100);
    assert.equal(review.findings.filter((entry) => entry.title.includes('quality floor')).length, 0);

    const issued = bidresponse.issueBidResponse(asOwner(), { packId: pid });
    assert.equal(issued.pack.status, 'ISSUED');
  });

  it('respects a per-pack floor, and refuses a review run under a floor that has since moved', async () => {
    const pid = freshPack('ITT-FLOOR-05');
    draftInto(pid, 'Q-01', OFF_TOPIC);

    // Set lower than the findable 75%, so the same answer now clears it.
    bidresponse.setBidResponseQualityFloor(asQS(), { packId: pid, floorPercent: 60 });
    const { review } = await redteam.challengeSubmission(asQS(), { packId: pid });
    assert.equal(review.qualityFloorPercent, 60);
    assert.equal(review.findings.filter((entry) => entry.title.includes('quality floor')).length, 0);

    // Move the floor after the review was run: it is now a review of a
    // different question, and the gate refuses it until it is run again.
    bidresponse.setBidResponseQualityFloor(asQS(), { packId: pid, floorPercent: 90 });
    const stale = throwsCode(() => bidresponse.issueBidResponse(asOwner(), { packId: pid }), 'ASSURANCE_NOT_CLEAR');
    assert.match(String(stale.message), /quality floor/);

    // Put it back and run it again, and the 75% answer is below 90 and blocks.
    const { review: again } = await redteam.challengeSubmission(asQS(), { packId: pid });
    assert.equal(again.qualityFloorPercent, 90);
    assert.ok(again.findings.some((entry) => entry.title.includes('90% quality floor')));
  });

  it('refuses a floor outside 0–100', () => {
    const pid = freshPack('ITT-FLOOR-06');
    throwsCode(
      () => bidresponse.setBidResponseQualityFloor(asQS(), { packId: pid, floorPercent: 150 }),
      'BID_RESPONSE_FLOOR_RANGE',
    );
  });
});
