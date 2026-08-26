import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as structure from '../src/domain/structure.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { PERCEPTION_TASKS } from '../src/engines/perception.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Voice-first capture, end to end.
 *
 * The platform could transcribe a site recording, classify it into one of its
 * own observation categories, read the location out of it and name who was said
 * to be responsible — and there was no way to make a recording. The whole path
 * existed with nothing at the front of it, and the specification calls
 * voice-first an adoption requirement rather than a convenience.
 *
 * What had to be built on the server was one thing: **a recording can be filed
 * on its own, before anything has been said about it.**
 *
 * Every other evidence file arrives attached to a command — a photograph with a
 * progress record, a survey with a measurement — and that is right, because in
 * those cases the person already knows what they are recording. A dictated site
 * note is the opposite: nobody knows the category, the location or the owner
 * until it has been listened to, and the point of walking and recording is that
 * the structuring happens afterwards. Without a way to file the audio first
 * there is nothing for the transcription to read, because the evidence store
 * refuses bytes that no ledger record names.
 *
 * The rest is capture in the browser, which is `MediaRecorder` and is tested by
 * using it.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // The seed finishes in OPERATIONS, where field creation is gated. Reopened
  // to CONSTRUCTION, which is the gate working rather than a fixture problem —
  // and the same gate `captureSiteObservation` carries, deliberately: a
  // recording that could never become the observation it feeds would be a
  // record filed into a dead end.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
    to: 'CONSTRUCTION',
    justification: 'Reopened so the site walk can be recorded against live work',
  });
});

after(() => server.close());

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

async function post(path: string, who: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

/** A plausible recording. The bytes do not matter; the hash of them does. */
const audio = Buffer.from('webm-container-bytes-standing-in-for-a-site-note');
const audioHash = `sha256:${createHash('sha256').update(audio).digest('hex')}`;

describe('a recording is filed before anything is said about it', () => {
  it('registers the audio as evidence on its own', async () => {
    const filed = await post(`/v1/projects/${seed.projectId}/field/recordings`, 'pm', {
      hash: audioHash,
      description: 'Site voice note, 84KB, captured on the north face walk',
    });

    assert.equal(filed.status, 201);
    assert.equal(filed.body.hash, audioHash);
    assert.ok(filed.body.evidenceId, 'no evidence record came back');

    const record = platform.ledger.get({ refType: 'EvidenceItem', refId: filed.body.evidenceId });
    assert.ok(record, 'the evidence record is not in the ledger');
    // Registered as what it is. An audio file of a site walk is evidence in its
    // own right whatever is subsequently made of it.
    assert.equal(record.state.type, 'SITE_RECORDING');
    assert.equal(record.state.hash, audioHash);
  });

  it('is what makes the bytes uploadable — the store refuses a hash nothing names', async () => {
    // The order is the point. Evidence bytes are refused until a ledger record
    // claims the hash, so without a way to file the recording first there is
    // nothing for a transcription to read.
    const orphan = `sha256:${createHash('sha256').update('never registered').digest('hex')}`;

    const refused = await fetch(`${base}/v1/evidence/${encodeURIComponent(orphan)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('pm')}`, 'content-type': 'audio/webm' },
      body: audio,
    });
    assert.equal(refused.status, 404);

    const accepted = await fetch(`${base}/v1/evidence/${encodeURIComponent(audioHash)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('pm')}`, 'content-type': 'audio/webm' },
      body: audio,
    });
    // 404 only where the deployment holds no store at all; never a refusal of
    // the hash itself, which is now claimed.
    assert.notEqual(accepted.status, 404, 'the store refused a hash the ledger names');
  });

  it('links the recording to an activity where the person knew one', async () => {
    const task = platform.ledger.list(seed.projectId, 'Task')[0]!;
    const other = Buffer.from('a second site note, taken at the pump house');
    const hash = `sha256:${createHash('sha256').update(other).digest('hex')}`;

    const filed = await post(`/v1/projects/${seed.projectId}/field/recordings`, 'pm', {
      hash,
      description: 'Site voice note at the pump house',
      taskId: task.refId,
    });

    const record = platform.ledger.require({ refType: 'EvidenceItem', refId: filed.body.evidenceId });
    assert.deepEqual(record.state.linkedEntities, [{ refType: 'Task', refId: task.refId }]);
  });

  it('takes no description it cannot use, and no field it did not ask for', async () => {
    const short = await post(`/v1/projects/${seed.projectId}/field/recordings`, 'pm', { hash: audioHash, description: 'x' });
    assert.equal(short.status, 400);

    const stray = await post(`/v1/projects/${seed.projectId}/field/recordings`, 'pm', {
      hash: audioHash,
      description: 'Site voice note from the walk',
      category: 'QUALITY',
    });
    // A caller supplying the category has decided what the recording says
    // before anybody has listened to it, which is the whole thing this avoids.
    assert.equal(stray.status, 400);
  });

  it('needs field authority to file one', async () => {
    const refused = await post(`/v1/projects/${seed.projectId}/field/recordings`, 'regulator', {
      hash: audioHash,
      description: 'Site voice note from the walk',
    });

    assert.equal(refused.status, 403);
  });

  it('is gated by the same phase as the observation it feeds', async () => {
    // Deliberate rather than incidental. A recording filed in a phase where the
    // observation it becomes could not be created is a record in a dead end,
    // and the person would only find out at the confirmation step — after the
    // walk, after the upload, and after paying to transcribe it.
    //
    // A project at the start of its life is the cleanest way to show it: there
    // is no site to walk yet, and the gate says so.
    const admin = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');
    const early = structure.createProject(admin, {
      portfolioId: String(portfolios[0]!.state.id),
      name: 'Not started yet',
      sectorType: 'TRANSPORT',
      assetType: 'Pumping station',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Derby' },
      contractValueMinor: 500_000_00,
      currency: 'GBP',
      plannedStart: '2027-01-04',
      plannedCompletion: '2027-10-01',
    }).projectId;

    const refused = await post(`/v1/projects/${early}/field/recordings`, 'pm', {
      hash: audioHash,
      description: 'Site voice note on a project with no site yet',
    });

    assert.equal(refused.status, 403);
    assert.match(String(refused.body.detail ?? ''), /phase|not permitted|denied/i);
  });
});

describe('the transcription task accepts what a browser actually records', () => {
  it('accepts every container MediaRecorder produces', () => {
    // Chromium records webm/opus, Safari records mp4. Both must be on the
    // accepted list or the capture would upload and then be refused, which is
    // the worst place to find out.
    const accepted = PERCEPTION_TASKS.VOICE_NOTE.accepts;

    for (const container of ['audio/webm', 'audio/mp4', 'audio/ogg']) {
      assert.ok(accepted.includes(container), `${container} is not accepted, and browsers record it`);
    }
  });

  it('matches the container exactly, which is why the codec parameter is dropped', () => {
    // `accepts.includes(contentType)` is an exact string match. A file typed
    // `audio/webm;codecs=opus` — which is what MediaRecorder reports — would be
    // refused, so the capture normalises to the base type before naming the
    // file. Pinned here because it is invisible from either side alone.
    const accepted = PERCEPTION_TASKS.VOICE_NOTE.accepts;

    assert.ok(!accepted.includes('audio/webm;codecs=opus'));
    assert.ok(accepted.includes('audio/webm'));
  });

  it('classifies into the platform\'s own observation categories, not a list of its own', () => {
    const schema = PERCEPTION_TASKS.VOICE_NOTE.responseSchema as {
      properties: { category: { enum: string[] } };
    };

    // The confirm path refuses a category the domain does not know, so a
    // divergence here is a transcription that always fails at the last step.
    assert.ok(schema.properties.category.enum.includes('QUALITY'));
    assert.ok(!schema.properties.category.enum.includes('SAFETY'), 'SAFETY is not a site observation category');
  });

  it('will not be called on a photograph', () => {
    assert.ok(!PERCEPTION_TASKS.VOICE_NOTE.accepts.some((type) => type.startsWith('image/')));
  });
});
