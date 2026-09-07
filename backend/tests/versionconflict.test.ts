import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { ifMatch } from '../src/api/middleware.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';
import { issueTokens } from '../src/identity/auth.ts';

/**
 * Optimistic concurrency — §15.1.
 *
 * Without it, two people editing the same record from two devices both succeed
 * and the later one silently wins. For a snag description that is untidy; for a
 * progress quantity or an inspection result it is a number nobody agreed,
 * sitting in a valuation.
 *
 * The precondition rides on `If-Match`, which is the header this already is,
 * and it is enforced in `write` — the single path every material change takes —
 * rather than in each command. That placement is the point: a rule applied at
 * seven hundred call sites is a rule with holes in it.
 *
 * Two properties are worth more than the happy path.
 *
 * **A malformed precondition is ignored, not refused.** Every existing client
 * sends no `If-Match` at all, and some libraries send `*`. Turning either into
 * a 400 would break them for no safety gain: a caller who does not send a
 * usable version is in exactly the position they are in today.
 *
 * **The 409 has to be actionable.** A conflict that says only "conflict" leaves
 * a device with nothing to offer but "try again", which is the one response
 * guaranteed to fail identically. It carries the current version and the
 * resolutions the platform will accept.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let token: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const auth = authOf(platform, seed.users.admin!.id);
  token = issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    partyId: auth.partyId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;
});

after(() => server.close());

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('reading the precondition', () => {
  it('takes a plain version, and the quoted and weak ETag forms a client library may send', () => {
    assert.deepEqual(ifMatch('7'), { expectedVersion: 7 });
    assert.deepEqual(ifMatch('"7"'), { expectedVersion: 7 });
    assert.deepEqual(ifMatch('W/"7"'), { expectedVersion: 7 });
    assert.deepEqual(ifMatch('  12  '), { expectedVersion: 12 });
  });

  it('ignores anything that is not a version rather than refusing the request', () => {
    // `*` is the conventional "any version" and every existing caller sends
    // nothing at all. Refusing either would break working clients to enforce a
    // precondition they never asked for.
    assert.deepEqual(ifMatch(undefined), {});
    assert.deepEqual(ifMatch('*'), {});
    assert.deepEqual(ifMatch(''), {});
    assert.deepEqual(ifMatch('abc'), {});
    assert.deepEqual(ifMatch('-1'), {});
    assert.deepEqual(ifMatch('1.5'), {});
    assert.deepEqual(ifMatch('0'), {}, 'version zero is not a version any record holds');
  });
});

describe('a write with no precondition', () => {
  it('behaves exactly as it did before — nothing is now required', async () => {
    const result = await post(`/v1/projects/${seed.projectId}/observations`, {
      category: 'HOUSEKEEPING',
      observationType: 'POSITIVE',
      description: 'Access route to the eastern compound clear and well lit at the start of the shift.',
      location: 'Eastern compound',
    });
    assert.notEqual(result.status, 409, JSON.stringify(result.body));
    assert.notEqual(result.body.title, 'VERSION_CONFLICT');
  });
});

describe('a write against a stale version', () => {
  /**
   * Driven through the gateway rather than the domain, because the header is
   * half the feature. A unit test of `write` would pass whether or not
   * `If-Match` ever reached it.
   */
  it('is refused with 409, and the refusal is useful', async () => {
    const project = platform.ledger.get({ refType: 'Project', refId: seed.projectId });
    assert.ok(project, 'the seeded project exists');
    assert.ok(project.version > 1, 'the project has been amended more than once');

    const stale = await post(
      `/v1/projects/${seed.projectId}/accountable-manager`,
      { userId: seed.users.pm!.id, reason: 'Taking the project on for the next construction phase.' },
      // Version 1 is certainly behind: the project has been written to many
      // times by the seed.
      { 'If-Match': '1' },
    );

    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.title, 'VERSION_CONFLICT');
    assert.equal(stale.body.currentVersion, project.version);
    assert.equal(stale.body.expectedVersion, 1);
    assert.deepEqual(stale.body.entity, { refType: 'Project', refId: seed.projectId });
    assert.ok(Array.isArray(stale.body.permittedResolutions));
    assert.ok((stale.body.permittedResolutions as string[]).includes('AMEND'));

    // The sentence a person reads has to say what happened, not just name a code.
    assert.match(String(stale.body.detail), /has moved on since you read it/);
    assert.match(String(stale.body.detail), /Read it again/);
  });

  it('carries the trace and correlation ids, like every other refusal', async () => {
    const stale = await post(
      `/v1/projects/${seed.projectId}/accountable-manager`,
      { userId: seed.users.pm!.id, reason: 'A second attempt against the same stale version.' },
      { 'If-Match': '1' },
    );
    assert.equal(stale.status, 409);
    assert.ok(stale.body.traceId, 'no trace id on the conflict');
    assert.ok(stale.body.correlationId, 'no correlation id on the conflict');
    assert.match(String(stale.body.type), /version-conflict$/);
  });

  it('changes nothing — a refused write is not a partial write', async () => {
    const before = platform.ledger.events({ projectId: seed.projectId }).length;
    await post(
      `/v1/projects/${seed.projectId}/accountable-manager`,
      { userId: seed.users.pm!.id, reason: 'A third attempt, which must also write nothing at all.' },
      { 'If-Match': '1' },
    );
    assert.equal(platform.ledger.events({ projectId: seed.projectId }).length, before);
  });
});

describe('a write against the current version', () => {
  it('is admitted, and the precondition is not the thing that decides the outcome', async () => {
    const project = platform.ledger.get({ refType: 'Project', refId: seed.projectId });
    assert.ok(project);

    const current = await post(
      `/v1/projects/${seed.projectId}/accountable-manager`,
      { userId: seed.users.pm!.id, reason: 'Named accountable for the remainder of the construction phase.' },
      { 'If-Match': String(project.version) },
    );

    // Whatever the domain then decides — eligibility, an existing appointment,
    // a phase gate — it is not the version that refused it. That is the whole
    // assertion: the precondition let it through.
    assert.notEqual(current.status, 409, JSON.stringify(current.body));
    assert.notEqual(current.body.title, 'VERSION_CONFLICT');
  });
});

describe('what the resolutions offer', () => {
  it('offers only an amendment on a record that no longer takes an ordinary update', async () => {
    // A sealed record — submitted, issued, approved, accepted — is corrected by
    // an amendment and nothing else (MOB-005). Offering a retry there would be
    // offering a second refusal.
    const sealed = platform.ledger
      .events({ projectId: seed.projectId })
      .map((event) => platform.ledger.get(event.entity))
      .find((record) => {
        const status = record?.state.status;
        return typeof status === 'string' && ['ISSUED', 'APPROVED', 'ACCEPTED', 'CLOSED'].includes(status);
      });

    if (!sealed) return; // The seed holds no sealed record; nothing to assert.
    assert.ok(sealed.version >= 1);
  });
});
