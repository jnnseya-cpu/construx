import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { issueTokens, verifyToken } from '../src/identity/auth.ts';
import type { AuthContext } from '../src/identity/auth.ts';

/**
 * What a device is allowed to pull down.
 *
 * `SyncEngine.pull` filtered on tenancy and nothing else, so a device received
 * every event in the project with its full patch — the cost patch, the claim
 * patch, the contract patch — whatever the person holding the phone was
 * entitled to read.
 *
 * On the web that was survivable: the console has no screen that shows a raw
 * event feed to a supplier. The field app changes it entirely. The £25
 * subcontractor seat is sold on exactly one promise — "my snags, filtered, and
 * nothing else exists" — and the specification is explicit that it is "enforced
 * in queries and sync scoping, not in the UI". A pull that hands over the whole
 * project and trusts the client to hide it is the UI enforcement it forbids.
 *
 * The audit feed had been doing this correctly since it was written. What it did
 * not have was a second caller, and the moment one appeared the decision needed
 * to live somewhere both could reach. It does now, and its own comment said why
 * before either of us: one place where an event's content is authorised,
 * because a second path is a second chance to get it wrong.
 */

let platform: Platform;
let seed: SeedResult;

const authOf = (userId: string): AuthContext => {
  const person = platform.user(userId);
  return verifyToken(
    issueTokens({
      actorId: person.id,
      tenantId: person.tenantId,
      partyId: person.partyId,
      roles: person.roles,
      mfaSatisfied: true,
    }).accessToken,
  );
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('a device pulls only what its holder may read', () => {
  it('gives a supplier the envelope of a commercial event and not its content', () => {
    const supplier = platform.createUser({
      tenantId: seed.tenantId,
      name: 'Pennine Groundworks',
      email: `sub-${Math.random().toString(36).slice(2)}@pennine.test`,
      roles: ['SUPPLIER'],
    });

    const pulled = platform.sync.pull(authOf(supplier.id), seed.projectId, 'sub-device', undefined, 2000);

    // There is commercial and contractual traffic on this project — a CVR, a
    // payment cycle, contracts — and none of it belongs to a trade.
    assert.ok(pulled.withheldCount > 0, 'a supplier was shown every event in full');

    const readable = pulled.events.filter((event) => !('contentWithheld' in event));
    const commercial = new Set(['CVR', 'Budget', 'PaymentApplication', 'PaymentCertificate', 'Contract', 'Claim']);
    const leaked = readable.filter((event) => commercial.has(event.entity.refType));
    assert.deepEqual(
      leaked.map((event) => `${event.entity.refType} ${event.eventType}`),
      [],
      'commercial content reached a subcontractor seat',
    );

    // The envelope survives, and that is the point of withholding rather than
    // dropping: the device can still verify the chain is unbroken over events
    // whose content it may not read.
    const withheld = pulled.events.filter((event) => 'contentWithheld' in event);
    assert.ok(withheld.length > 0);
    for (const event of withheld.slice(0, 5)) {
      assert.equal(event.diff, undefined, 'a withheld event still carried its patch');
      assert.ok(event.eventId && event.timestamp && event.chainHash, 'the envelope was withheld along with the content');
    }
  });

  it('gives the project manager the same events with their content', () => {
    // The other half. A rule that withheld from everybody would pass the test
    // above and break the product.
    const pulled = platform.sync.pull(seed.users.pm!.auth, seed.projectId, 'pm-device', undefined, 2000);
    const readable = pulled.events.filter((event) => !('contentWithheld' in event));
    assert.ok(readable.length > 0, 'the project manager was shown nothing');
    assert.ok(
      readable.some((event) => (event.diff?.length ?? 0) > 0),
      'no event came back with a patch on it',
    );
  });

  it('counts what it withheld, so a device that shows fewer records can say why', () => {
    const supplier = platform.createUser({
      tenantId: seed.tenantId,
      name: 'Counting Trade',
      email: `count-${Math.random().toString(36).slice(2)}@pennine.test`,
      roles: ['SUPPLIER'],
    });
    const pulled = platform.sync.pull(authOf(supplier.id), seed.projectId, 'count-device', undefined, 2000);
    assert.equal(
      pulled.withheldCount,
      pulled.events.filter((event) => 'contentWithheld' in event).length,
      'the reported count does not reconcile with the page',
    );
  });

  it('advances the cursor over withheld events rather than re-offering them forever', () => {
    // They happened, the device is entitled to know they happened, and a cursor
    // that stalled on the first unreadable event would never move again.
    const supplier = platform.createUser({
      tenantId: seed.tenantId,
      name: 'Cursor Trade',
      email: `cursor-${Math.random().toString(36).slice(2)}@pennine.test`,
      roles: ['SUPPLIER'],
    });
    const auth = authOf(supplier.id);
    const first = platform.sync.pull(auth, seed.projectId, 'cursor-device', undefined, 5);
    assert.equal(first.events.length, 5);

    const second = platform.sync.pull(auth, seed.projectId, 'cursor-device', first.cursor, 5);
    assert.notEqual(second.cursor, first.cursor, 'the cursor did not move past events it could not read');
  });
});

/**
 * Several projects, one round trip.
 *
 * A supervisor's phone holds three jobs. On a site gate's signal, three requests
 * is three chances to fail rather than one — and cursors in a body rather than a
 * query string keeps them out of access logs and away from URL length limits.
 *
 * It composes the per-project pull rather than reimplementing it, so the cursor
 * rule and the classification pass have one home each.
 */
describe('a device pulls its whole day in one request', () => {
  it('answers every project it can reach, each from its own cursor', () => {
    const others = seed.workingProjects.map((project) => project.projectId);
    const wanted = [seed.projectId, ...others].slice(0, 3).map((projectId) => ({ projectId }));

    const answer = platform.sync.pullMany(seed.users.pm!.auth, 'many-device', wanted);
    assert.equal(answer.projects.length, wanted.length, JSON.stringify(answer.unavailable));
    for (const project of answer.projects) {
      assert.ok(project.cursor, `${project.projectId} came back with no cursor`);
      assert.equal(typeof project.withheldCount, 'number');
    }
  });

  it('names a project it cannot reach rather than leaving it silently absent', () => {
    // The answer a device needs in order to purge: an empty result that could
    // mean "nothing changed" or "you are off that job" is the one that generates
    // a support call, and a device cannot purge what it was never told about.
    const answer = platform.sync.pullMany(seed.users.pm!.auth, 'many-device-2', [
      { projectId: seed.projectId },
      { projectId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
    ]);

    assert.equal(answer.projects.length, 1);
    assert.equal(answer.unavailable.length, 1);
    assert.equal(answer.unavailable[0]!.projectId, '01ZZZZZZZZZZZZZZZZZZZZZZZZ');
    assert.match(answer.unavailable[0]!.because, /Purge/);
  });

  it('does not let one stale cursor cost the device its other projects', () => {
    const device = 'many-device-3';
    // Move the cursor on the first project, then ask again from before it.
    const first = platform.sync.pull(seed.users.pm!.auth, seed.projectId, device, undefined, 5);
    assert.ok(first.cursor);

    const answer = platform.sync.pullMany(seed.users.pm!.auth, device, [
      { projectId: seed.projectId, cursor: '2000-01-01T00:00:00.000Z' },
      { projectId: seed.workingProjects[0]!.projectId },
    ]);

    assert.equal(answer.unavailable.length, 1, 'the stale cursor was not reported');
    assert.match(answer.unavailable[0]!.because, /older than the one this device already holds/);
    assert.equal(answer.projects.length, 1, 'one project’s refusal took the others with it');
  });

  it('withholds inside a multi-project pull exactly as it does in a single one', () => {
    const supplier = platform.createUser({
      tenantId: seed.tenantId,
      name: 'Many Trade',
      email: `many-${Math.random().toString(36).slice(2)}@pennine.test`,
      roles: ['SUPPLIER'],
    });
    const answer = platform.sync.pullMany(authOf(supplier.id), 'many-sub-device', [{ projectId: seed.projectId }], 2000);
    const project = answer.projects[0]!;
    assert.ok(project.withheldCount > 0, 'the multi-project path is a way round the classification');
  });
});
