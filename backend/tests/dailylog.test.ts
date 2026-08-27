import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as dailylog from '../src/domain/dailylog.ts';
import * as structure from '../src/domain/structure.ts';
import * as planning from '../src/engines/planning.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-03 — offline daily diary and voice field capture.
 *
 * The offline path, the device timestamps, the idempotent sync and the voice
 * capture a person confirms were all already built. What is tested here is the
 * lifecycle that was missing: a draft that survives a restart, a submission
 * that happens once, and an amendment that shows what changed without
 * destroying what it changed.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds FIELD_EXECUTION C and U — captures the shift and submits it. */
const asSiteManager = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'PWA' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds no field execution at all. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let sequence = 0;
let taskId: string;

/**
 * Dates with no diary against them.
 *
 * The seeded project already carries a run of diaries, so a test that picked a
 * fixed offset would collide with one and fail for a reason that has nothing to
 * do with what it is testing. These are claimed once, in order, from days the
 * seed left alone.
 */
const FREE: Record<string, string> = {};

function claimFreeDays(keys: string[]): void {
  const taken = new Set(
    platform.ledger.list(seed.projectId, 'SiteDiary').map((record) => String(record.state.diaryDate)),
  );
  let offset = 20;
  for (const key of keys) {
    while (taken.has(day(-offset))) offset += 1;
    FREE[key] = day(-offset);
    taken.add(day(-offset));
    offset += 1;
  }
}

function content(overrides: Partial<dailylog.DailyLogContent> = {}): dailylog.DailyLogContent {
  return {
    diaryDate: day(0),
    shift: 'DAY',
    weather: { conditions: 'Dry, 14°C, light westerly', workingStopped: false },
    labour: [{ trade: 'Groundworks', headcount: 6, hours: 9 }],
    plant: [{ description: '13t excavator', hoursWorked: 7, hoursIdle: 1 }],
    progressNarrative: 'Excavated to formation between grids A1 and B3; blinding starts tomorrow.',
    workedTaskIds: [taskId],
    location: 'Inlet works, north compound',
    ...overrides,
  };
}

function draft(overrides: Partial<dailylog.DailyLogContent> = {}, uuid?: string) {
  sequence += 1;
  return dailylog.draftDailyLog(asSiteManager(), {
    ...content(overrides),
    clientUuid: uuid ?? `capture-${sequence}`,
    deviceId: 'handset-04',
    capturedAt: new Date().toISOString(),
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Recording the shift',
  });
  const { workPackageId } = planning.createWorkPackage(asPM(), {
    wbsCode: 'DL-001',
    title: 'Inlet works civils',
    indicativeDurationDays: 30,
  });
  taskId = planning.createTasks(asPM(), [
    { activityCode: 'DL-A', name: 'Excavate to formation', workPackageId, durationDays: 10 },
  ])[0]!;

  claimFreeDays(['d3', 'd4', 'd5', 'd6', 'd7', 'd9', 'd12', 'd13', 'd14', 'd15']);
});

describe('CN-WF-03 the register', () => {
  it('registers its four event types', () => {
    for (const [code, entity] of [
      ['DAILY_LOG_DRAFTED', 'SiteDiary'],
      ['DAILY_LOG_SUBMITTED', 'SiteDiary'],
      ['DAILY_LOG_AMENDED', 'SiteDiary'],
      ['OFFLINE_SYNC_COMPLETED', 'SyncSession'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // The agent may clean dictation and categorise; it may not file a record.
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('keeps the log on the same entity as the diary it becomes', () => {
    // One record for a day, not a device record and a governed record that can
    // disagree with each other.
    assert.equal(lookupEventType('DAILY_LOG_SUBMITTED')?.entity, lookupEventType('SITE_DIARY_RECORDED')?.entity);
    assert.equal(classifyEntity('SyncSession')?.area, 'FIELD_EXECUTION');
  });

  it('refuses a capture from a role with no field execution', () => {
    throwsCode(
      () =>
        dailylog.draftDailyLog(asQS(), {
          ...content(),
          clientUuid: 'denied',
          deviceId: 'handset-04',
          capturedAt: new Date().toISOString(),
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('AC-CN-WF-03-01 a capture survives a restart and syncs exactly once', () => {
  it('returns the same log for the same client id rather than writing a second', () => {
    const first = draft({ diaryDate: day(-1) }, 'stable-uuid-1');
    const second = dailylog.draftDailyLog(asSiteManager(), {
      ...content({ diaryDate: day(-1) }),
      clientUuid: 'stable-uuid-1',
      deviceId: 'handset-04',
      capturedAt: new Date().toISOString(),
    });
    assert.equal(second.logId, first.logId);
    assert.equal(second.alreadyHeld, true);
    assert.equal(first.alreadyHeld, false);

    const position = dailylog.dailyLogPosition(asSiteManager());
    assert.equal(position.drafts.filter((entry) => entry.logId === first.logId).length, 1);
  });

  it('refuses a capture with no client id or device behind it', () => {
    throwsCode(
      () =>
        dailylog.draftDailyLog(asSiteManager(), {
          ...content(),
          clientUuid: '  ',
          deviceId: 'handset-04',
          capturedAt: new Date().toISOString(),
        }),
      'CLIENT_IDENTITY_REQUIRED',
    );
    throwsCode(
      () =>
        dailylog.draftDailyLog(asSiteManager(), {
          ...content(),
          clientUuid: 'x',
          deviceId: '',
          capturedAt: new Date().toISOString(),
        }),
      'CLIENT_IDENTITY_REQUIRED',
    );
  });
});

describe('CN-WF-03 the device clock is kept, and its error with it', () => {
  it('stores the variance rather than correcting the capture time', () => {
    // A handset eleven minutes fast is a fact about the evidence.
    const capturedAt = new Date(Date.now() + 11 * 60_000).toISOString();
    sequence += 1;
    const result = dailylog.draftDailyLog(asSiteManager(), {
      ...content({ diaryDate: day(-2) }),
      clientUuid: `fast-clock-${sequence}`,
      deviceId: 'handset-fast',
      capturedAt,
    });
    assert.ok(result.deviceTimeVarianceSeconds > 600);

    const position = dailylog.dailyLogPosition(asSiteManager());
    assert.ok(position.clockDrift.some((entry) => entry.deviceId === 'handset-fast'));
    assert.match(position.summary, /device clock/);
  });

  it('records a sync receipt with the device clock at the time of the batch', () => {
    const result = dailylog.recordSyncCompleted(asSiteManager(), {
      deviceId: 'handset-07',
      syncSessionId: 'sync-001',
      accepted: 12,
      duplicates: 3,
      conflicts: 0,
      deviceTimestamp: new Date(Date.now() - 4 * 60_000).toISOString(),
    });
    assert.ok(result.deviceTimeVarianceSeconds < -200);
  });

  it('refuses a sync receipt that names no device or session', () => {
    throwsCode(
      () =>
        dailylog.recordSyncCompleted(asSiteManager(), {
          deviceId: '',
          syncSessionId: 'sync-002',
          accepted: 0,
          duplicates: 0,
          conflicts: 0,
          deviceTimestamp: new Date().toISOString(),
        }),
      'SYNC_UNIDENTIFIED',
    );
  });
});

describe('CN-WF-03 anomalous totals are reported, not refused', () => {
  it('refuses what is impossible', () => {
    throwsCode(() => draft({ labour: [{ trade: 'Groundworks', headcount: 6, hours: 26 }] }), 'DIARY_TOTALS_IMPOSSIBLE');
    throwsCode(
      () => draft({ plant: [{ description: 'Crane', hoursWorked: 20, hoursIdle: 8 }] }),
      'DIARY_TOTALS_IMPOSSIBLE',
    );
  });

  it('reports what is merely unusual, and will not let it be submitted unseen', () => {
    // Refusing the unlikely teaches people to enter the number the form will
    // accept instead of the one they measured.
    const result = draft({ diaryDate: FREE.d3!, labour: [{ trade: 'Groundworks', headcount: 6, hours: 14 }] });
    assert.ok(result.anomalies.length > 0);
    assert.match(result.anomalies[0]!, /long shift/);

    throwsCode(
      () => dailylog.submitDailyLog(asSiteManager(), result.logId, { evidenceHash: 'ev-1' }),
      'ANOMALIES_UNCONFIRMED',
    );

    // Confirmed, it goes through.
    const submitted = dailylog.submitDailyLog(asSiteManager(), result.logId, {
      evidenceHash: 'ev-1',
      confirmedAnomalies: result.anomalies,
    });
    assert.equal(submitted.contemporaneous, false);
    assert.ok(submitted.daysLate > 1);
  });
});

describe('CN-WF-03 submitted once', () => {
  it('needs an activity and a location before it can be submitted', () => {
    // AC-CN-WF-03-02.
    const noTask = draft({ diaryDate: FREE.d4!, workedTaskIds: [] });
    throwsCode(() => dailylog.submitDailyLog(asSiteManager(), noTask.logId, { evidenceHash: 'ev' }), 'WBS_REQUIRED');

    const noPlace = draft({ diaryDate: FREE.d5!, location: '  ' });
    throwsCode(() => dailylog.submitDailyLog(asSiteManager(), noPlace.logId, { evidenceHash: 'ev' }), 'LOCATION_REQUIRED');
  });

  it('needs its evidence', () => {
    const captured = draft({ diaryDate: FREE.d6! });
    throwsCode(() => dailylog.submitDailyLog(asSiteManager(), captured.logId, { evidenceHash: '' }), 'EVIDENCE_REQUIRED');
  });

  it('records the day, contemporaneously when it was written on it', () => {
    const captured = draft({ diaryDate: day(0) });
    const result = dailylog.submitDailyLog(asSiteManager(), captured.logId, { evidenceHash: 'ev-today' });
    assert.equal(result.contemporaneous, true);
    assert.equal(result.labourHours, 54);

    const position = dailylog.dailyLogPosition(asSiteManager());
    assert.ok(position.submitted.some((entry) => entry.logId === captured.logId));
    assert.ok(!position.drafts.some((entry) => entry.logId === captured.logId));
  });

  it('refuses a second submission of the same log', () => {
    const captured = draft({ diaryDate: FREE.d7! });
    dailylog.submitDailyLog(asSiteManager(), captured.logId, { evidenceHash: 'ev-7' });
    throwsCode(
      () => dailylog.submitDailyLog(asSiteManager(), captured.logId, { evidenceHash: 'ev-7' }),
      'DAILY_LOG_ALREADY_SUBMITTED',
    );
  });

  it('refuses a second diary for a day that already has one', () => {
    const other = draft({ diaryDate: FREE.d7! });
    throwsCode(
      () => dailylog.submitDailyLog(asSiteManager(), other.logId, { evidenceHash: 'ev-7b' }),
      'DIARY_ALREADY_RECORDED',
    );
  });

  it('leaves a draft out of the diary position, so the gap stays visible', () => {
    // A day captured but not submitted is not yet evidence for that day.
    const captured = draft({ diaryDate: FREE.d9! });
    // The window is exactly that one day. A draft on it must not count as the
    // day's record, whether or not the day is one the gap report counts.
    const diary = planning.diaryPosition(asSiteManager(), { from: FREE.d9!, to: FREE.d9! });
    assert.equal(diary.recorded, 0);
    assert.ok(dailylog.dailyLogPosition(asSiteManager()).drafts.some((entry) => entry.logId === captured.logId));
  });
});

describe('AC-CN-WF-03-03 an amendment shows before and after', () => {
  let logId: string;

  before(() => {
    const captured = draft({ diaryDate: FREE.d12! });
    logId = captured.logId;
    dailylog.submitDailyLog(asSiteManager(), logId, { evidenceHash: 'ev-12' });
  });

  it('computes the change on every field that moved, and only those', () => {
    const result = dailylog.amendDailyLog(asSiteManager(), logId, {
      content: {
        labour: [{ trade: 'Groundworks', headcount: 8, hours: 9 }],
        progressNarrative: 'Excavated to formation between grids A1 and C4; two extra operatives from the night shift.',
      },
      reason: 'Two operatives transferred from the night gang were left off the original entry.',
      evidenceHash: 'ev-12-amend',
    });

    const fields = result.changes.map((change) => change.field).sort();
    assert.deepEqual(fields, ['labour', 'progressNarrative']);
    const labour = result.changes.find((change) => change.field === 'labour')!;
    assert.match(labour.before, /"headcount":6/);
    assert.match(labour.after, /"headcount":8/);
  });

  it('does not destroy the original', () => {
    const original = platform.ledger.get({ refType: 'SiteDiary', refId: logId })!;
    // Still there, still saying six.
    assert.match(JSON.stringify(original.state.labour), /"headcount":6/);

    const position = dailylog.dailyLogPosition(asSiteManager());
    assert.ok(position.submitted.find((entry) => entry.logId === logId)?.amended);
    assert.ok(position.amendments.some((entry) => entry.reason.includes('night gang')));
  });

  it('refuses an amendment with no reason on it', () => {
    const captured = draft({ diaryDate: FREE.d13! });
    dailylog.submitDailyLog(asSiteManager(), captured.logId, { evidenceHash: 'ev-13' });
    throwsCode(
      () =>
        dailylog.amendDailyLog(asSiteManager(), captured.logId, {
          content: { location: 'Somewhere else' },
          reason: '  ',
          evidenceHash: 'ev-13a',
        }),
      'AMENDMENT_UNEXPLAINED',
    );
  });

  it('refuses an amendment that changes nothing', () => {
    const captured = draft({ diaryDate: FREE.d14! });
    dailylog.submitDailyLog(asSiteManager(), captured.logId, { evidenceHash: 'ev-14' });
    throwsCode(
      () =>
        dailylog.amendDailyLog(asSiteManager(), captured.logId, {
          content: {},
          reason: 'Tidying up.',
          evidenceHash: 'ev-14a',
        }),
      'AMENDMENT_CHANGES_NOTHING',
    );
  });

  it('refuses amending a draft, which is edited rather than amended', () => {
    const captured = draft({ diaryDate: FREE.d15! });
    throwsCode(
      () =>
        dailylog.amendDailyLog(asSiteManager(), captured.logId, {
          content: { location: 'Elsewhere' },
          reason: 'Wrong place.',
          evidenceHash: 'ev-15',
        }),
      'DAILY_LOG_NOT_SUBMITTED',
    );
  });

  it('refuses amending an entry something has already superseded', () => {
    // Otherwise the register carries two corrections of one day with no way to
    // tell which is current.
    throwsCode(
      () =>
        dailylog.amendDailyLog(asSiteManager(), logId, {
          content: { location: 'Third version' },
          reason: 'Again.',
          evidenceHash: 'ev-12-again',
        }),
      'DAILY_LOG_SUPERSEDED',
    );
  });
});
