import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { EvidenceStore } from '../src/evidence/store.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * An account picture, through a store that actually holds bytes.
 *
 * Every deployment with a volume — which is every production deployment —
 * refused every account picture, cover image and project branding cover with
 * `EVIDENCE_HASH_MISMATCH`. The upload was read as a PNG, sized, hashed and
 * handed to the store under a bare hex digest, and the store checks the bytes
 * against the `sha256:…` address form it records everything else under. The
 * existing tests ran with no store configured, where the refusal is
 * `EVIDENCE_STORE_UNCONFIGURED` before the hash is ever compared, so the
 * mismatch was never seen. This suite runs against a real store on disk and
 * drives the round trip: upload, the hash on the identity, the bytes back.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let directory: string;

const tokenFor = (userId: string): string => {
  const user = platform.user(userId);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
};

/** A real, decodable PNG: one 4×4 block of a single colour. */
function png(): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(typed));
    return Buffer.concat([length, typed, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const raw = Buffer.concat(Array.from({ length: 4 }, () => Buffer.from([0, ...Array(4).fill([200, 90, 40]).flat()])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const upload = (path: string, userId: string, bytes: Buffer) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(userId)}`, 'content-type': 'image/png' },
    body: bytes,
  });

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-pictures-'));
  platform = new Platform(new AIOrchestrator(), new EvidenceStore(directory));
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(directory, { recursive: true, force: true });
});

describe('an account picture through a store that holds bytes', () => {
  it('is stored, named on the identity and served back as the image that was sent', async () => {
    const pm = seed.users.pm!.id;
    const bytes = png();

    const set = await upload('/v1/me/picture', pm, bytes);
    assert.equal(set.status, 201, JSON.stringify(await set.clone().json()));
    const { pictureHash } = (await set.json()) as { pictureHash: string };
    assert.match(pictureHash, /^sha256:[0-9a-f]{64}$/, 'the hash is in the store’s own address form');

    // The account page renders the picture from this payload.
    const erasure = await fetch(`${base}/v1/me/erasure`, { headers: { authorization: `Bearer ${tokenFor(pm)}` } });
    assert.equal(erasure.status, 200);
    const { identity } = (await erasure.json()) as { identity: { pictureHash?: string; coverHash?: string } };
    assert.equal(identity.pictureHash, pictureHash);
    assert.equal(identity.coverHash, undefined);

    // A colleague in the same tenancy reads it back; the bytes are the bytes.
    const read = await fetch(`${base}/v1/users/${pm}/picture`, {
      headers: { authorization: `Bearer ${tokenFor(seed.users.admin!.id)}` },
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);

    // The same request the browser makes for an <img>: no credential, refused.
    const anonymous = await fetch(`${base}/v1/users/${pm}/picture`);
    assert.equal(anonymous.status, 401);
  });

  it('keeps the cover image separate from the picture', async () => {
    const pm = seed.users.pm!.id;
    const set = await upload('/v1/me/cover', pm, png());
    assert.equal(set.status, 201, JSON.stringify(await set.clone().json()));
    const { coverHash } = (await set.json()) as { coverHash: string };
    assert.match(coverHash, /^sha256:[0-9a-f]{64}$/);

    const erasure = await fetch(`${base}/v1/me/erasure`, { headers: { authorization: `Bearer ${tokenFor(pm)}` } });
    const { identity } = (await erasure.json()) as { identity: { pictureHash?: string; coverHash?: string } };
    assert.equal(identity.coverHash, coverHash);
    assert.ok(identity.pictureHash, 'setting the cover did not unset the picture');

    const read = await fetch(`${base}/v1/users/${pm}/cover`, { headers: { authorization: `Bearer ${tokenFor(pm)}` } });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('content-type'), 'image/png');
  });

  it('stores a project branding cover the same way', async () => {
    const response = await upload('/v1/branding/cover', seed.users.admin!.id, png());
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
    const { hash } = (await response.json()) as { hash: string };
    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(await platform.evidence.holds(seed.tenantId, hash), true);
  });

  it('survives a restart: the picture is on the identity after replay', () => {
    const restored = new Platform(new AIOrchestrator(), new EvidenceStore(directory));
    restored.ledger.restore(platform.ledger.events());
    restored.rehydrate();
    const before = platform.user(seed.users.pm!.id);
    const after = restored.user(seed.users.pm!.id);
    assert.equal(after.pictureHash, before.pictureHash);
    assert.equal(after.coverHash, before.coverHash);
  });
});
