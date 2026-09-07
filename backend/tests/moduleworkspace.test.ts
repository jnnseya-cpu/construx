import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { FIELD_MODULES, MODULE_TAB, moduleBySlug } from '../src/field/modules.ts';
import { moduleTab, moduleWorkspace } from '../src/field/workspace.ts';
import { draftDailyLog } from '../src/domain/dailylog.ts';
import { transitionPhase } from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The module workspace, the shell the four field modules share.
 *
 * What is worth testing here is not that a read returns an object. It is the
 * three places the specification asks for a number the platform may not
 * actually have — pack freshness, the shift, and the home indicators — because
 * each of them has an obvious wrong implementation that looks right on screen:
 * report the pack as current when nobody knows, default the shift to DAY,
 * print an unmeasured indicator as zero. Every one of those puts a confident
 * false statement in front of somebody making a site decision.
 *
 * So the assertions below are mostly about what the workspace *refuses* to say.
 */

let platform: Platform;
let seed: SeedResult;

/** The project manager reads the workspace; the field seat carries the same read. */
function ctxFor() {
  return platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
}

/** The same person, on a handset the platform has enrolled. */
function onDevice(deviceId: string) {
  return platform.context({ ...seed.users.pm!.auth, deviceId }, seed.projectId, { source: 'PWA' });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the module declarations', () => {
  it('declares records, criteria and a queue for every module, and the queue is part of the records', () => {
    for (const module of Object.values(FIELD_MODULES)) {
      assert.ok(module.records.length > 0, `${module.id} produces no records`);
      assert.ok(module.plans.length > 0, `${module.id} works to no criteria`);
      for (const type of module.queue) {
        assert.ok(
          module.records.includes(type),
          `${module.id} queues ${type}, which is not one of the records it produces`,
        );
      }
    }
  });

  it('gives every indicator either something to count or a reason it cannot be', () => {
    for (const module of Object.values(FIELD_MODULES)) {
      for (const indicator of module.indicators) {
        assert.ok(
          indicator.entities.length > 0 || indicator.pending,
          `${module.id} indicator "${indicator.label}" counts nothing and names nothing that would produce it`,
        );
      }
    }
  });
});

describe('the workspace header', () => {
  it('says which phase the project is in, and whether the module belongs to it', () => {
    // Every module is readable in every phase — somebody needs to look back at
    // the tender visits from site — but a module outside its own phase must not
    // read as live work. `openNow` is what the screen says that with.
    for (const module of Object.values(FIELD_MODULES)) {
      const position = moduleWorkspace(ctxFor(), { module: module.slug });
      assert.equal(position.header.openNow, module.phases.includes(position.header.phase));
      assert.deepEqual(position.header.opensIn, module.phases);
    }

    // The seeded project has run to operations, so no field module is live on
    // it — which is itself the case worth pinning: the screen still answers.
    const tender = moduleWorkspace(ctxFor(), { module: 'tender' });
    assert.equal(tender.header.openNow, false);
    assert.deepEqual(tender.header.opensIn, ['TENDER']);
  });

  it('refuses to call a pack current when the session is bound to no device', () => {
    // The seeded session has no device. Reporting CURRENT here would tell a
    // person their handset holds everything when the platform has no idea what
    // their handset is.
    const position = moduleWorkspace(ctxFor(), { module: 'construction' });
    assert.equal(position.header.pack.freshness, 'NO_DEVICE');
    assert.match(position.header.pack.note, /cannot say what it is holding/);
  });

  it('counts what a device has yet to be given, and says the other direction is unknowable', () => {
    const ctx = ctxFor();
    const events = ctx.ledger.events({ projectId: seed.projectId });
    // A cursor part-way through the project: everything after it is waiting.
    const midpoint = events[Math.floor(events.length / 2)]!.eventId;
    const bound = onDevice('device-under-test');

    const position = moduleWorkspace(bound, { module: 'construction', deviceCursor: midpoint });
    assert.equal(position.header.pack.freshness, 'BEHIND');
    assert.equal(
      position.header.pack.recordsWaiting,
      events.filter((event) => event.eventId > midpoint).length,
    );
    assert.match(position.header.pack.note, /only known to the device/);
  });

  it('treats a device that has never pulled as holding nothing, not as up to date', () => {
    const bound = onDevice('never-pulled');
    const position = moduleWorkspace(bound, { module: 'construction' });
    assert.equal(position.header.pack.freshness, 'NEVER_PULLED');
    assert.equal(
      position.header.pack.recordsWaiting,
      bound.ledger.events({ projectId: seed.projectId }).length,
    );
  });

  it('does not invent a shift where nobody has stated one', () => {
    // A date with no daily log against it. Defaulting to DAY here would put a
    // shift on a record that nobody worked.
    const position = moduleWorkspace(ctxFor(), { module: 'construction', today: '1999-01-01' });
    assert.equal(position.header.shift.shift, undefined);
    assert.match(String(position.header.shift.unknownBecause), /only known once somebody states it/);
  });

  it('says a log names no shift rather than filling one in', () => {
    // The seeded diaries were written by a path that does not carry a shift.
    // The right answer is that the log does not name one — not DAY.
    const ctx = ctxFor();
    const dated = ctx.ledger
      .list(seed.projectId, 'SiteDiary')
      .map((record) => record.state as { diaryDate?: string; shift?: string })
      .find((state) => state.diaryDate && !state.shift);
    assert.ok(dated, 'every seeded diary names a shift, so this case is not covered');

    const position = moduleWorkspace(ctx, { module: 'construction', today: dated.diaryDate! });
    assert.equal(position.header.shift.shift, undefined);
    assert.match(String(position.header.shift.unknownBecause), /does not name a shift/);
  });

  it('reads the shift back from a daily log that states one', () => {
    // Driven through the real command rather than written into the ledger, so
    // this proves the field the workspace reads is the field the domain writes.
    //
    // The seeded project has run through to operations and field capture is
    // gated on the construction phase, so the project is moved back first — a
    // regression the platform allows, with a justification, and exactly what a
    // project that has to reopen a work face does.
    transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
      to: 'CONSTRUCTION',
      justification: 'Reopening the work face to record a night shift against the drainage run.',
    });
    // A day that has happened: the domain refuses a diary dated ahead.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const ctx = ctxFor();
    const drafted = draftDailyLog(ctx, {
      clientUuid: 'workspace-shift-test',
      deviceId: 'workspace-shift-device',
      capturedAt: new Date().toISOString(),
      diaryDate: yesterday,
      shift: 'NIGHT',
      weather: { conditions: 'DRY', temperatureC: 11, windMph: 6, workingHoursLost: 0 },
      labour: [{ trade: 'Groundworks', headcount: 4, hours: 10 }],
      plant: [{ description: 'Excavator', count: 1, hours: 8, idleHours: 0 }],
      progressNarrative: 'Night shift continued the drainage run through the eastern yard.',
      workedTaskIds: [],
      location: 'Eastern yard',
    });
    assert.equal(drafted.status, 'DRAFT');

    const position = moduleWorkspace(ctxFor(), { module: 'construction', today: yesterday });
    assert.equal(position.header.shift.shift, 'NIGHT');
    assert.equal(position.header.shift.logId, drafted.logId);
    assert.equal(position.header.shift.unknownBecause, undefined);
  });
});

describe('the home indicators', () => {
  it('publishes an unmeasured figure as unmeasured, never as zero', () => {
    const tender = moduleWorkspace(ctxFor(), { module: 'tender' });
    const acknowledgements = tender.indicators.find((entry) => entry.label === 'Pack acknowledgements');
    assert.ok(acknowledgements);
    assert.equal(acknowledgements.measured, false);
    assert.equal(acknowledgements.total, undefined, 'an unmeasured indicator must carry no number at all');
    assert.match(String(acknowledgements.pending), /T-MOB-WF-02/);
  });

  it('breaks a count down by values the records actually carry, and the parts add up', () => {
    const position = moduleWorkspace(ctxFor(), { module: 'construction' });
    for (const indicator of position.indicators) {
      if (!indicator.measured || !indicator.breakdown) continue;
      const summed = indicator.breakdown.reduce((total, entry) => total + entry.count, 0);
      assert.equal(summed, indicator.total, `"${indicator.label}" breakdown does not add up to its total`);
    }
  });

  it('counts a record that does not carry the field under a name that says so', () => {
    // The alternative is dropping it, which makes the breakdown disagree with
    // the total printed beside it.
    const position = moduleWorkspace(ctxFor(), { module: 'handover' });
    const snags = position.indicators.find((entry) => entry.label === 'Snags by severity');
    assert.ok(snags?.measured);
    if ((snags.total ?? 0) > 0) {
      assert.ok(snags.breakdown && snags.breakdown.length > 0);
      assert.equal(
        snags.breakdown.reduce((total, entry) => total + entry.count, 0),
        snags.total,
      );
    }
  });
});

describe('the six tabs', () => {
  it('are the six the specification names, in its order, on every module', () => {
    for (const module of Object.values(FIELD_MODULES)) {
      const position = moduleWorkspace(ctxFor(), { module: module.slug });
      assert.deepEqual(position.tabs.map((tab) => tab.id), [...MODULE_TAB]);
      for (const tab of position.tabs) assert.ok(tab.basis.length > 0, `${tab.id} does not say what it counts`);
    }
  });

  it('each carry a count that matches the rows the tab actually returns', () => {
    const position = moduleWorkspace(ctxFor(), { module: 'construction' });
    for (const tab of position.tabs) {
      const contents = moduleTab(ctxFor(), { module: 'construction', tab: tab.id });
      assert.equal(contents.rows.length, tab.count, `${tab.id} count and rows disagree`);
    }
  });

  it('offers only filter values the rows hold, so no filter matches nothing', () => {
    const contents = moduleTab(ctxFor(), { module: 'construction', tab: 'RECORDS' });
    for (const status of contents.filters.status) {
      assert.ok(
        contents.rows.some((row) => row.status === status),
        `status "${status}" is offered and held by no row`,
      );
    }
    for (const owner of contents.filters.owner) {
      assert.ok(contents.rows.some((row) => row.owner === owner));
    }
  });

  it('filters on the server, and the filtered rows all match', () => {
    const all = moduleTab(ctxFor(), { module: 'construction', tab: 'RECORDS' });
    const status = all.filters.status[0];
    if (!status) return;
    const filtered = moduleTab(ctxFor(), { module: 'construction', tab: 'RECORDS', status });
    assert.ok(filtered.rows.length > 0);
    assert.ok(filtered.rows.every((row) => row.status === status));
    assert.ok(filtered.rows.length <= all.rows.length);
  });

  it('puts only records with a named owner in the action queue', () => {
    // A queue is what somebody has to do. An item nobody owns is not in
    // anybody's queue and pretending otherwise makes the queue meaningless.
    const queue = moduleTab(ctxFor(), { module: 'construction', tab: 'ACTION_QUEUE' });
    assert.ok(queue.rows.every((row) => row.owner !== undefined));
  });

  it('shows evidence filed against this module and not the project’s whole evidence store', () => {
    const ctx = ctxFor();
    const all = ctx.ledger.list(seed.projectId, 'EvidenceItem').length;
    const construction = moduleTab(ctxFor(), { module: 'construction', tab: 'EVIDENCE' });
    assert.ok(all > 0, 'the seed files no evidence, so this test proves nothing');
    assert.ok(
      construction.rows.length < all,
      'every evidence item on the project appeared under one module, so nothing is being scoped',
    );
  });
});

describe('what the workspace refuses', () => {
  it('does not answer for a module that does not exist, and names the ones that do', () => {
    assert.throws(
      () => moduleWorkspace(ctxFor(), { module: 'finance' }),
      (error: Error & { code?: string; detail?: string }) => {
        assert.equal(error.code, 'NO_SUCH_MODULE');
        assert.match(String(error.message), /tender, construction, commissioning, handover/);
        return true;
      },
    );
  });

  it('does not answer for a tab that does not exist', () => {
    assert.throws(
      () => moduleTab(ctxFor(), { module: 'construction', tab: 'BILLING' }),
      (error: Error & { code?: string }) => error.code === 'NO_SUCH_TAB',
    );
  });

  it('resolves a module by its slug only, so a path segment cannot be an id', () => {
    assert.equal(moduleBySlug('handover')?.id, 'HANDOVER');
    assert.equal(moduleBySlug('HANDOVER'), undefined);
  });
});
