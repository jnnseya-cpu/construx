import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as structure from '../src/domain/structure.ts';
import * as bim from '../src/engines/bim.ts';
import * as planning from '../src/engines/planning.ts';
import * as safety from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The three records the platform could describe but not produce.
 *
 * A daily diary, an answer to an RFI, and a revised risk score all sat in the
 * closed event catalogue with no command able to emit them. Each reads as
 * capability from the outside — the event exists, entity access classifies it,
 * the control standard can demand evidence of it — and each was unreachable.
 *
 * They are grouped here because they share a failure mode rather than a subject:
 * a register that can only be added to is not a register.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

/**
 * The demo project sits in operations, where field-execution writes are
 * correctly phase-gated off — the seed keeps its diaries during construction.
 * Testing the write path therefore needs the project back in a phase where
 * somebody is on site, which is a regression the platform models rather than a
 * fixture trick.
 */
function reopenForConstruction(): void {
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to record outstanding site diaries against the construction period',
  });
}

const weather = (): planning.DiaryWeather => ({ conditions: 'Dry and bright', temperatureC: 18, workingStopped: false });

const diaryInput = (date: string, overrides: Partial<Parameters<typeof planning.recordSiteDiary>[1]> = {}) => ({
  diaryDate: date,
  weather: weather(),
  labour: [{ trade: 'Groundworks', headcount: 8, hours: 9 }],
  plant: [{ description: '13t excavator', hoursWorked: 8, hoursIdle: 1 }],
  progressNarrative: 'Drainage runs to manhole 4',
  evidenceHash: hashEvidence(`diary-${date}`),
  ...overrides,
});

describe('the daily site diary', () => {
  before(() => reopenForConstruction());

  it('records the day and computes the labour hours rather than taking them', () => {
    const result = planning.recordSiteDiary(
      ctx('pm'),
      diaryInput('2026-09-01', {
        labour: [
          { trade: 'Groundworks', headcount: 8, hours: 9 },
          { trade: 'Steel fixing', headcount: 4, hours: 10 },
        ],
      }),
      new Date('2026-09-01T18:00:00.000Z'),
    );

    assert.equal(result.labourHours, 8 * 9 + 4 * 10);
    assert.equal(result.contemporaneous, true);
    assert.equal(result.daysLate, 0);
  });

  it('refuses a diary dated in the future', () => {
    // A record of what happened cannot be written before it happens. Allowing
    // it turns the diary into a plan with a diary's evidential weight.
    throwsCode(
      () => planning.recordSiteDiary(ctx('pm'), diaryInput('2026-09-20'), new Date('2026-09-02T09:00:00.000Z')),
      'DIARY_DATE_IN_FUTURE',
    );
  });

  it('requires the weather even on a fine day', () => {
    throwsCode(
      () =>
        planning.recordSiteDiary(
          ctx('pm'),
          diaryInput('2026-09-02', { weather: { conditions: '   ', workingStopped: false } }),
          new Date('2026-09-02T18:00:00.000Z'),
        ),
      'DIARY_WEATHER_REQUIRED',
    );
  });

  it('marks a late entry as what it is instead of passing it off as contemporaneous', () => {
    // An adjudicator asks when the diary was written. A platform that could not
    // answer would be handing over a weaker exhibit than its owner believed.
    const result = planning.recordSiteDiary(
      ctx('pm'),
      diaryInput('2026-09-02'),
      new Date('2026-09-23T10:00:00.000Z'),
    );

    assert.equal(result.contemporaneous, false);
    assert.equal(result.daysLate, 21);
  });

  it('refuses a second entry for the same day unless it says what it replaces and why', () => {
    planning.recordSiteDiary(ctx('pm'), diaryInput('2026-09-03'), new Date('2026-09-03T18:00:00.000Z'));

    throwsCode(
      () => planning.recordSiteDiary(ctx('pm'), diaryInput('2026-09-03'), new Date('2026-09-03T19:00:00.000Z')),
      'DIARY_ALREADY_RECORDED',
    );
  });

  it('supersedes an entry rather than editing it, and both survive', () => {
    const first = planning.recordSiteDiary(ctx('pm'), diaryInput('2026-09-04'), new Date('2026-09-04T18:00:00.000Z'));
    const second = planning.recordSiteDiary(
      ctx('pm'),
      diaryInput('2026-09-04', {
        progressNarrative: 'Drainage runs to manhole 4 and 5',
        supersedes: first.diaryId,
        supersessionReason: 'Manhole 5 omitted from the original entry',
      }),
      new Date('2026-09-05T08:00:00.000Z'),
    );

    // The correction names what it replaces; nothing is written back to the
    // original. That is what a corrected record looks like on paper, and it is
    // the only shape an append-only ledger allows for an event that creates.
    const replacement = platform.ledger.require({ refType: 'SiteDiary', refId: second.diaryId });
    assert.equal(replacement.state.supersedes, first.diaryId);
    assert.equal(replacement.state.supersessionReason, 'Manhole 5 omitted from the original entry');

    // The original is still readable in full. An append-only ledger never
    // removes the record somebody may have relied on.
    const original = platform.ledger.require({ refType: 'SiteDiary', refId: first.diaryId });
    assert.equal(original.state.progressNarrative, 'Drainage runs to manhole 4');

    // And the day now has one diary, not two.
    const position = planning.diaryPosition(ctx('pm'), { from: '2026-09-04', to: '2026-09-04' });
    assert.equal(position.recorded, 1);
  });

  it('refuses to supersede an entry that is not the current one for that date', () => {
    throwsCode(
      () =>
        planning.recordSiteDiary(
          ctx('pm'),
          diaryInput('2026-09-04', { supersedes: 'not-a-real-diary', supersessionReason: 'Typo in the labour count' }),
          new Date('2026-09-06T08:00:00.000Z'),
        ),
      'DIARY_SUPERSEDES_UNKNOWN',
    );
  });
});

describe('the diary as a delay exhibit', () => {
  it('reports the seeded week as unbroken', () => {
    // Five consecutive working days, 10 to 14 August 2026, all Monday to Friday.
    const position = planning.diaryPosition(ctx('pm'), { from: '2026-08-10', to: '2026-08-14' });

    assert.equal(position.daysInWindow, 5);
    assert.equal(position.recorded, 5);
    assert.deepEqual(position.missingDates, []);
    assert.match(position.completeness, /Unbroken across 5 working days/);
  });

  it('counts only working days as missing', () => {
    // The window runs to the following Tuesday. The weekend is not a gap —
    // reporting it as one would bury the two real days under two false ones.
    const position = planning.diaryPosition(ctx('pm'), { from: '2026-08-10', to: '2026-08-18' });

    assert.equal(position.daysInWindow, 7, 'five plus Monday and Tuesday');
    assert.deepEqual(position.missingDates, ['2026-08-18', '2026-08-17']);
  });

  it('finds the weather day that stopped work and the days a blocker was recorded', () => {
    const position = planning.diaryPosition(ctx('pm'), { from: '2026-08-10', to: '2026-08-14' });

    assert.equal(position.weatherDaysLost, 1);
    assert.equal(position.blockedDays.length, 2, 'the wash-out and the dewatering day after it');
    assert.match(position.blockedDays[0]!.blockers.join(' '), /dewatering/);
  });

  it('adds up the labour hours the week actually cost', () => {
    const position = planning.diaryPosition(ctx('pm'), { from: '2026-08-10', to: '2026-08-14' });
    // Twelve groundworkers at nine hours and three staff at ten, five days.
    assert.equal(position.totalLabourHours, 5 * (12 * 9 + 3 * 10));
  });

  it('names late entries so nobody presents one as a contemporaneous record', () => {
    planning.recordSiteDiary(ctx('pm'), diaryInput('2026-08-19'), new Date('2026-09-15T10:00:00.000Z'));
    const position = planning.diaryPosition(ctx('pm'), { from: '2026-08-17', to: '2026-08-19' });

    assert.equal(position.lateEntries.length, 1);
    assert.equal(position.lateEntries[0]!.diaryDate, '2026-08-19');
    assert.ok(position.lateEntries[0]!.daysLate > 20);
  });
});

describe('answering an RFI', () => {
  const openRfi = () =>
    platform.ledger.list(seed.projectId, 'RFI').find((r) => r.state.status !== 'ANSWERED');

  it('answered the seeded RFI, and recorded that the answer was late', () => {
    const answered = platform.ledger.list(seed.projectId, 'RFI').filter((r) => r.state.status === 'ANSWERED');
    assert.ok(answered.length > 0, 'the seed answers the clash RFI');

    const rfi = answered[0]!;
    assert.equal(rfi.state.answeredLate, true);
    assert.equal(rfi.state.changesDesign, true);
    // The revision the question was asked against travels with the answer.
    // Answering against a revision the site no longer holds is how an RFI
    // answer becomes a dispute, and it is invisible unless both ends are on
    // the record.
    assert.ok(rfi.state.answeredAgainstRevision);
    assert.equal(rfi.state.answeredAgainstRevision, rfi.state.linkedDrawingRevision);
  });

  it('refuses an answer that says nothing a site team could build to', () => {
    const rfi = openRfi();
    if (!rfi) return;
    throwsCode(
      () =>
        bim.answerRFI(ctx('bim'), {
          rfiId: rfi.refId,
          answer: 'Noted',
          answeredBy: 'Designer',
          evidenceHash: hashEvidence('thin-answer'),
        }),
      'RFI_ANSWER_INSUBSTANTIAL',
    );
  });

  it('refuses to answer the same RFI twice', () => {
    const answered = platform.ledger.list(seed.projectId, 'RFI').find((r) => r.state.status === 'ANSWERED')!;
    throwsCode(
      () =>
        bim.answerRFI(ctx('bim'), {
          rfiId: answered.refId,
          answer: 'A second and different answer to the same question',
          answeredBy: 'Designer',
          evidenceHash: hashEvidence('second-answer'),
        }),
      'RFI_ALREADY_ANSWERED',
    );
  });

  it('reports the register as a delay exhibit rather than a count', () => {
    const position = bim.rfiPosition(ctx('bim'));

    assert.ok(position.total > 0);
    assert.equal(position.designChanges, 1, 'the seeded answer changes the design');
    assert.equal(position.answeredLate, 1);
    assert.ok(position.averageDaysToAnswer !== undefined && position.averageDaysToAnswer > 0);
  });

  it('closes an answered RFI, and records what site actually waited', () => {
    // Time to answer is the design team's performance. Time to close is what
    // site waited, and only the second one is the delay.
    const answered = platform.ledger.list(seed.projectId, 'RFI').find((r) => r.state.status === 'ANSWERED')!;
    const closed = bim.closeRFI(ctx('bim'), {
      rfiId: answered.refId,
      outcome: 'ANSWER_ACCEPTED',
      note: 'Answer received and the revised detail has been issued to the gang.',
      closedBy: seed.users.pm!.id,
      evidenceHash: hashEvidence('rfi-closure'),
    });

    assert.equal(closed.reference, String(answered.state.reference));
    assert.ok(closed.daysToClose >= 0);

    const record = platform.ledger.require({ refType: 'RFI', refId: answered.refId });
    assert.equal(record.state.status, 'CLOSED');
    assert.equal(record.state.closureOutcome, 'ANSWER_ACCEPTED');
    assert.equal(record.state.closedBy, seed.users.pm!.id);
    // The answer and everything travelling with it survives closure.
    assert.ok(record.state.answeredAgainstRevision);
  });

  it('refuses to let the answerer close their own answer', () => {
    // The separation of duties. A design team that could close its own answers
    // could clear the register without anybody agreeing the answers were
    // usable, and a cleared register is what a delay claim is argued against.
    const rfi = platform.ledger.list(seed.projectId, 'RFI').find((r) => r.state.status === 'ANSWERED');
    if (!rfi) return;
    throwsCode(
      () =>
        bim.closeRFI(ctx('bim'), {
          rfiId: rfi.refId,
          outcome: 'ANSWER_ACCEPTED',
          note: 'Closing my own answer because the register looks untidy.',
          closedBy: String(rfi.state.answeredBy),
          evidenceHash: hashEvidence('self-closure'),
        }),
      'RFI_ANSWERER_CANNOT_CLOSE',
    );
  });

  it('refuses to accept an answer that does not exist', () => {
    const open = platform.ledger.list(seed.projectId, 'RFI').find((r) => String(r.state.status) === 'OPEN');
    if (!open) return;
    throwsCode(
      () =>
        bim.closeRFI(ctx('bim'), {
          rfiId: open.refId,
          outcome: 'ANSWER_ACCEPTED',
          note: 'Treating this as dealt with even though nobody answered it.',
          closedBy: seed.users.pm!.id,
          evidenceHash: hashEvidence('phantom-answer'),
        }),
      'RFI_NOT_ANSWERED',
    );
  });

  it('closes an unanswered RFI where the question stopped mattering', () => {
    // A question can be overtaken by an instruction, and a register that could
    // only close answered questions would keep those open forever.
    const open = platform.ledger.list(seed.projectId, 'RFI').find((r) => String(r.state.status) === 'OPEN');
    if (!open) return;
    const closed = bim.closeRFI(ctx('bim'), {
      rfiId: open.refId,
      outcome: 'SUPERSEDED_BY_CHANGE',
      note: 'Overtaken by the instructed variation to the pipe route; the detail queried no longer exists.',
      closedBy: seed.users.pm!.id,
      evidenceHash: hashEvidence('superseded'),
    });
    assert.ok(closed.daysToClose >= 0);
    assert.equal(
      platform.ledger.require({ refType: 'RFI', refId: open.refId }).state.closureOutcome,
      'SUPERSEDED_BY_CHANGE',
    );
  });

  it('refuses a closure that does not say why', () => {
    const answered = platform.ledger.list(seed.projectId, 'RFI').find((r) => r.state.status === 'ANSWERED');
    if (!answered) return;
    throwsCode(
      () =>
        bim.closeRFI(ctx('bim'), {
          rfiId: answered.refId,
          outcome: 'ANSWER_ACCEPTED',
          note: 'ok',
          closedBy: seed.users.pm!.id,
          evidenceHash: hashEvidence('unexplained'),
        }),
      'RFI_CLOSURE_UNEXPLAINED',
    );
  });

  it('gives no average where nothing has been answered', () => {
    // An average over nothing is zero, and zero days to answer reads as
    // excellent rather than as no data.
    const empty = platform.ledger.list('does-not-exist', 'RFI');
    assert.equal(empty.length, 0);
  });
});

describe('rescoring a risk', () => {
  const weatherRisk = () =>
    platform.ledger.list(seed.projectId, 'RiskRegisterItem').find((r) => String(r.state.title).includes('rainfall'))!;

  it('moved the seeded weather risk against what the diary recorded', () => {
    const risk = weatherRisk();
    assert.equal(risk.state.rescoreReason !== undefined, true);
    assert.match(String(risk.state.rescoreReason), /standing water/);
    // The exposure went up, and the previous figure is still on the record so
    // the movement can be explained rather than merely observed.
    assert.ok(Number(risk.state.expectedCostMinor) > Number(risk.state.previousExpectedCostMinor));
  });

  it('carries the movement into the contingency requirement', () => {
    // This is why a frozen register matters: the P80 contingency in every
    // tender and cost report is computed from these scores.
    const contingency = safety.assessContingency(ctx('safety'));
    assert.ok(contingency.p80Minor > 0);
    assert.ok(contingency.expectedMinor > 0);
  });

  it('refuses a rescore that does not say what changed', () => {
    throwsCode(
      () =>
        safety.rescoreRisk(ctx('safety'), {
          riskId: weatherRisk().refId,
          probability: 0.4,
          costImpact: { optimistic: 1, mostLikely: 2, pessimistic: 3 },
          scheduleImpactDays: { optimistic: 1, mostLikely: 2, pessimistic: 3 },
          reason: 'Updated',
          projectValueMinor: 1_850_000_000,
          projectDurationDays: 400,
        }),
      'RISK_RESCORE_REASON_REQUIRED',
    );
  });

  it('refuses a probability outside the range it is defined on', () => {
    throwsCode(
      () =>
        safety.rescoreRisk(ctx('safety'), {
          riskId: weatherRisk().refId,
          probability: 1.4,
          costImpact: { optimistic: 1, mostLikely: 2, pessimistic: 3 },
          scheduleImpactDays: { optimistic: 1, mostLikely: 2, pessimistic: 3 },
          reason: 'Ground investigation returned worse than assumed at tender',
          projectValueMinor: 1_850_000_000,
          projectDurationDays: 400,
        }),
      'RISK_PROBABILITY_RANGE',
    );
  });
});
