import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import * as commitments from '../src/domain/commitments.ts';
import * as correspondence from '../src/domain/correspondence.ts';
import * as claims from '../src/engines/claims.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Reading the promises out of the post.
 *
 * A project's letters are full of dates nobody is tracking, and the obligation
 * calendar holds only what the contract says. This reads what the parties said
 * afterwards and offers it as a candidate obligation.
 *
 * The assertion that carries the whole feature is the **quote check**. Every
 * commitment a provider returns has to carry the sentence it read it from, and
 * that sentence has to be in the letter. The local stand-in derives its answers
 * from a hash of its inputs — asked what a letter promised it will answer, and
 * the answer is fiction. A verbatim quote is the one thing a provider that never
 * read the letter cannot produce, so the check does here what the `multimodal`
 * flag does for the perception pipeline: it makes fabrication impossible to
 * file rather than merely discouraged.
 */

const LETTER =
  'We refer to your instruction of 12 August concerning the inlet works. ' +
  'We will complete the outstanding remedial works to panels 3 and 4 by 14 October 2026. ' +
  'The revised reinforcement drawings will follow within ten working days of this letter. ' +
  'Unless we receive your comments by 30 September 2026 we will proceed on the basis set out above.';

let platform: Platform;
let seed: SeedResult;
let contractId: string;
let output: Record<string, unknown> = {};

/** A reasoning provider that answers with whatever the test set. */
const stub: AIProviderAdapter = {
  name: 'ANTHROPIC',
  capability: 'REASONING',
  multimodal: false,
  transmits: true,
  estimateCostMinor: () => 30,
  healthy: () => true,
  async execute(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      provider: 'ANTHROPIC',
      modelClass: 'reasoning-standard',
      output,
      rawCostMinor: 30,
      latencyMs: 5,
      confidence: 0.84,
    };
  },
};

function ctxFor(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId, { correlationId: 'commitments-test' });
}

/** Issue a letter with the given body and return its id. */
function issue(body: string, subject = 'Outstanding remedial works, inlet works'): string {
  return correspondence.issueCorrespondence(ctxFor('pm'), {
    type: 'GENERAL_LETTER',
    from: 'CONTRACTOR',
    to: 'EMPLOYER',
    subject,
    body,
    author: 'Project Manager',
  }).correspondenceId;
}

before(async () => {
  platform = new Platform(new AIOrchestrator({ reasoning: stub }));
  seed = await seedDemoProject(platform);
  // CONTRACTS_CLAIMS runs through OPERATIONS, so the seeded phase is fine.
  contractId = platform.ledger.list(seed.projectId, 'Contract')[0]!.refId;
});

describe('the catalogue names the two acts separately', () => {
  it('registers the reading as an AI event and the tracking as a human one', () => {
    // The reading is the machine's; putting a date into the calendar is not.
    assert.equal(lookupEventType('COMMITMENT_REGISTERED')?.aiAllowed, true);
    assert.equal(lookupEventType('DEADLINE_TRACKED')?.aiAllowed, false);
    assert.equal(lookupEventType('COMMITMENT_DISCARDED')?.aiAllowed, false);
    assert.equal(lookupEventType('DEADLINE_TRACKED')?.action, 'APPROVE');
  });
});

describe('nothing is recorded that the letter does not say', () => {
  it('records the commitment that quotes the letter and drops the one that does not', async () => {
    const correspondenceId = issue(LETTER);
    output = {
      commitments: [
        {
          kind: 'PROMISE',
          description: 'Complete the outstanding remedial works to panels 3 and 4',
          party: 'CONTRACTOR',
          dueDate: '2026-10-14',
          quotedText: 'We will complete the outstanding remedial works to panels 3 and 4 by 14 October 2026.',
        },
        {
          kind: 'DEADLINE_IMPOSED',
          description: 'Comment on the proposed basis',
          party: 'EMPLOYER',
          dueDate: '2026-09-30',
          quotedText: 'Unless we receive your comments by 30 September 2026 we will proceed on the basis set out above.',
        },
        {
          // Plausible, contractually significant, and nowhere in the letter.
          kind: 'PROMISE',
          description: 'Pay liquidated damages of £4,000 per day from 1 November',
          party: 'CONTRACTOR',
          dueDate: '2026-11-01',
          quotedText: 'We accept liability for liquidated damages of £4,000 per day from 1 November 2026.',
        },
      ],
    };

    const result = await commitments.readCommitments(ctxFor('qs'), { correspondenceId });
    assert.equal(result.found, 2);
    assert.equal(result.dropped, 1);

    const position = commitments.commitmentPosition(ctxFor('qs'));
    const recorded = position.awaitingDecision.map((entry) => entry.description);
    assert.equal(recorded.includes('Complete the outstanding remedial works to panels 3 and 4'), true);
    // The invented one is not on the record at all — not as rejected, not as
    // low confidence. It was never a finding.
    assert.equal(
      recorded.some((description) => description.includes('liquidated damages')),
      false,
    );
  });

  it('keeps the sentence beside the reading, so it can be argued with', () => {
    const entry = commitments
      .commitmentPosition(ctxFor('qs'))
      .awaitingDecision.find((candidate) => candidate.kind === 'DEADLINE_IMPOSED')!;
    assert.match(entry.quotedText, /30 September 2026/);
    assert.equal(LETTER.includes(entry.quotedText), true);
  });

  it('matches on words rather than on whitespace', async () => {
    const correspondenceId = issue(
      'We confirm that the temporary works design will be issued to you\nby 5 October 2026, and that no further ' +
        'access to the compound is required before that date.',
      'Temporary works design',
    );
    output = {
      commitments: [
        {
          kind: 'PROMISE',
          description: 'Issue the temporary works design',
          party: 'CONTRACTOR',
          dueDate: '2026-10-05',
          // The same words, re-wrapped. A letter reflowed by an email client
          // must not lose its own commitment.
          quotedText: 'the temporary works design will be issued to you by 5 October 2026',
        },
      ],
    };
    const result = await commitments.readCommitments(ctxFor('qs'), { correspondenceId });
    assert.equal(result.found, 1);
  });

  it('refuses outright where every finding was invented, and says which failure it is', async () => {
    // The local stand-in's behaviour, and the whole reason the check exists.
    const correspondenceId = issue(
      'We acknowledge receipt of your letter and have nothing further to add at this stage of the works.',
      'Acknowledgement',
    );
    output = {
      commitments: [
        {
          kind: 'PROMISE',
          description: 'Complete the works',
          party: 'CONTRACTOR',
          dueDate: '2026-12-01',
          quotedText: 'We undertake to complete the whole of the works by 1 December 2026.',
        },
      ],
    };
    const error = await rejectsCode(
      () => commitments.readCommitments(ctxFor('qs'), { correspondenceId }),
      'NOTHING_QUOTED',
    );
    assert.match(String(error.message), /cannot read the text will answer anyway/);
  });

  it('does not report a provider that answered nothing as a letter that promised nothing', async () => {
    // Found against a running server. The local stand-in returns no
    // `commitments` key at all, and the platform told the operator "nothing in
    // COR-0001 undertakes to do anything by a date" about a letter that plainly
    // did. An empty list is an answer; no list is a provider that cannot do it.
    const correspondenceId = issue(LETTER, 'Provider returned nothing');
    output = { narrative: 'A deterministic stand-in that never read the letter.' };
    const error = await rejectsCode(
      () => commitments.readCommitments(ctxFor('qs'), { correspondenceId }),
      'PROVIDER_CANNOT_READ',
    );
    assert.match(String(error.message), /not the same as finding none/);
  });

  it('says a letter that promises nothing promises nothing, which is a different answer', async () => {
    const correspondenceId = issue(
      'We write to confirm that the site was closed for the bank holiday and that no work was carried out.',
      'Bank holiday closure',
    );
    output = { commitments: [] };
    const error = await rejectsCode(
      () => commitments.readCommitments(ctxFor('qs'), { correspondenceId }),
      'NOTHING_PROMISED',
    );
    assert.match(String(error.message), /an answer, not a failure/);
  });

  it('refuses to read the same letter twice', async () => {
    const correspondenceId = issue(LETTER, 'Repeat reading');
    output = {
      commitments: [
        {
          kind: 'PROMISE',
          description: 'Complete the remedial works',
          party: 'CONTRACTOR',
          dueDate: '2026-10-14',
          quotedText: 'We will complete the outstanding remedial works to panels 3 and 4 by 14 October 2026.',
        },
      ],
    };
    await commitments.readCommitments(ctxFor('qs'), { correspondenceId });
    const error = await rejectsCode(() => commitments.readCommitments(ctxFor('qs'), { correspondenceId }), 'ALREADY_READ');
    assert.match(String(error.message), /same words cannot/);
  });

  it('refuses a letter it has not got', async () => {
    await rejectsCode(
      () => commitments.readCommitments(ctxFor('qs'), { correspondenceId: 'not-a-letter' }),
      'NO_SUCH_CORRESPONDENCE',
    );
  });
});

describe('confirming a reading puts it in the calendar that already exists', () => {
  let commitmentId: string;

  before(async () => {
    const correspondenceId = issue(LETTER, 'Confirmation path');
    output = {
      commitments: [
        {
          kind: 'PROMISE',
          description: 'Complete the outstanding remedial works to panels 3 and 4',
          party: 'CONTRACTOR',
          dueDate: '2026-10-14',
          quotedText: 'We will complete the outstanding remedial works to panels 3 and 4 by 14 October 2026.',
        },
      ],
    };
    commitmentId = (await commitments.readCommitments(ctxFor('qs'), { correspondenceId })).commitmentIds[0]!;
  });

  it('registers an obligation rather than a second list of dates', () => {
    const before_ = claims.obligationCalendar(ctxFor('qs')).entries.length;

    const tracked = commitments.trackCommitment(ctxFor('qs'), {
      commitmentId,
      contractId,
      owner: 'Commercial Manager',
      dueDate: '2026-10-14',
    });
    assert.ok(tracked.obligationReference.startsWith('OBL'));

    const after = claims.obligationCalendar(ctxFor('qs'));
    assert.equal(after.entries.length, before_ + 1);
    // Registered through the ordinary command, so it counts down and reports
    // overdue with everything else rather than in a register of its own.
    const entry = after.entries.find((candidate) => candidate.reference === tracked.obligationReference)!;
    assert.match(entry.description, /COR-/);
    assert.match(entry.description, /CONTRACTOR/);
  });

  it('will not be confirmed twice', () => {
    throwsCode(
      () =>
        commitments.trackCommitment(ctxFor('qs'), {
          commitmentId,
          contractId,
          owner: 'Commercial Manager',
          dueDate: '2026-10-14',
        }),
      'COMMITMENT_SETTLED',
    );
  });

  it('refuses a commitment with no date, because a promise with no date is a sentiment', async () => {
    const correspondenceId = issue(LETTER, 'Period not a date');
    output = {
      commitments: [
        {
          kind: 'PROMISE',
          description: 'Issue the revised reinforcement drawings',
          party: 'CONTRACTOR',
          // The letter said "within ten working days" — a period, not a day.
          dueDate: null,
          quotedText: 'The revised reinforcement drawings will follow within ten working days of this letter.',
        },
      ],
    };
    const read = await commitments.readCommitments(ctxFor('qs'), { correspondenceId });
    const candidate = commitments
      .commitmentPosition(ctxFor('qs'))
      .awaitingDecision.find((entry) => entry.commitmentId === read.commitmentIds[0]!)!;
    // The reading did not invent a date, and the screen has none to offer.
    assert.equal(candidate.statedDueDate, undefined);

    const error = throwsCode(
      () =>
        commitments.trackCommitment(ctxFor('qs'), {
          commitmentId: read.commitmentIds[0]!,
          contractId,
          owner: 'Commercial Manager',
          dueDate: 'ten working days',
        }),
      'COMMITMENT_DATE_REQUIRED',
    );
    assert.match(String(error.message), /period rather than a day/);
  });
});

describe('a rejected reading is kept as a rejected reading', () => {
  let commitmentId: string;

  before(async () => {
    const correspondenceId = issue(LETTER, 'Rejection path');
    output = {
      commitments: [
        {
          kind: 'DEADLINE_IMPOSED',
          description: 'Comment on the proposed basis',
          party: 'EMPLOYER',
          dueDate: '2026-09-30',
          quotedText: 'Unless we receive your comments by 30 September 2026 we will proceed on the basis set out above.',
        },
      ],
    };
    commitmentId = (await commitments.readCommitments(ctxFor('qs'), { correspondenceId })).commitmentIds[0]!;
  });

  it('needs a reason', () => {
    throwsCode(() => commitments.discardCommitment(ctxFor('qs'), { commitmentId, reason: 'no' }), 'COMMITMENT_REASON_REQUIRED');
  });

  it('records the rejection rather than losing the reading', () => {
    commitments.discardCommitment(ctxFor('qs'), {
      commitmentId,
      reason: 'Already covered by the response period the register derives from the contract.',
    });

    const position = commitments.commitmentPosition(ctxFor('qs'));
    assert.ok(position.discarded >= 1);
    assert.equal(
      position.awaitingDecision.some((entry) => entry.commitmentId === commitmentId),
      false,
    );

    const state = platform.ledger.require({ refType: 'CorrespondenceCommitment', refId: commitmentId }).state as Record<
      string,
      unknown
    >;
    assert.equal(state.status, 'DISCARDED');
    // The words the model read are still there. A machine's finding that
    // quietly vanishes is the one thing nobody can audit.
    assert.match(String(state.quotedText), /30 September 2026/);
  });

  it('cannot then be tracked', () => {
    throwsCode(
      () => commitments.trackCommitment(ctxFor('qs'), { commitmentId, contractId, owner: 'x', dueDate: '2026-09-30' }),
      'COMMITMENT_SETTLED',
    );
  });
});

describe('the position says what is still sitting in the post', () => {
  it('counts letters nobody has read for a date', () => {
    issue(LETTER, 'Never read for commitments');
    const position = commitments.commitmentPosition(ctxFor('qs'));
    assert.ok(position.unread >= 1);
    assert.ok(position.tracked >= 1);
    assert.ok(position.discarded >= 1);
  });
});

describe('reading takes the authority to spend, confirming takes the authority to record', () => {
  it('refuses a reader who cannot execute against the contract', async () => {
    const correspondenceId = issue(LETTER, 'Authority check');
    // The site manager can read the correspondence register and cannot spend
    // ACUs interpreting a contract.
    await rejectsCode(() => commitments.readCommitments(ctxFor('siteManager'), { correspondenceId }), 'ACCESS_DENIED');
  });

  it('refuses a confirmer who could not have registered the obligation by hand', async () => {
    const correspondenceId = issue(LETTER, 'Confirmer authority');
    output = {
      commitments: [
        {
          kind: 'PROMISE',
          description: 'Complete the outstanding remedial works',
          party: 'CONTRACTOR',
          dueDate: '2026-10-14',
          quotedText: 'We will complete the outstanding remedial works to panels 3 and 4 by 14 October 2026.',
        },
      ],
    };
    const read = await commitments.readCommitments(ctxFor('qs'), { correspondenceId });
    throwsCode(
      () =>
        commitments.trackCommitment(ctxFor('siteManager'), {
          commitmentId: read.commitmentIds[0]!,
          contractId,
          owner: 'Commercial Manager',
          dueDate: '2026-10-14',
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('a project in a phase where the contracts engine does not run', () => {
  it('is refused before anything is charged', async () => {
    const scratch = new Platform(new AIOrchestrator({ reasoning: stub }));
    const scratchSeed = await seedDemoProject(scratch);
    const admin = scratch.context(scratchSeed.users.admin!.auth, scratchSeed.projectId);
    // CONCEPT is before the contracts engine's own active phases.
    structure.transitionPhase(scratch.context(scratchSeed.users.owner!.auth, scratchSeed.projectId), {
      to: 'CONCEPT',
      justification: 'Regressed for this check.',
    });
    const letters = scratch.ledger.list(scratchSeed.projectId, 'Correspondence');
    if (letters.length === 0) return;
    await rejectsCode(
      () =>
        commitments.readCommitments(scratch.context(scratchSeed.users.qs!.auth, scratchSeed.projectId), {
          correspondenceId: letters[0]!.refId,
        }),
      'ACCESS_DENIED',
    );
    assert.ok(admin);
  });
});
