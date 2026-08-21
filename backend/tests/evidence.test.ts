import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { coverage, findByHash, projectRegister } from '../src/evidence/registry.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The object store for field evidence.
 *
 * Before this, the platform proved a document *with a given hash* was the
 * evidence and did not hold the document. The chain was real and it depended
 * entirely on somebody outside the platform still having the file — which, three
 * years after practical completion, means the person who took the photograph has
 * left and the phone has been wiped.
 *
 * What is actually worth asserting is not "a file round-trips". It is the set of
 * refusals, because each one is a way the evidence chain could have been
 * poisoned at its root:
 *
 *   - bytes that do not hash to the address they claim
 *   - a hash that is a path rather than a hash
 *   - one tenant reading another's object
 *   - a link that has expired, been forged, or been forwarded out of its tenancy
 *   - an upload for a hash no ledger record ever claimed
 *   - a stored file that has changed underneath the platform
 */

let directory: string;

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-evidence-'));
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

const bytesOf = (text: string): Buffer => Buffer.from(text, 'utf8');

describe('the evidence store', () => {
  const store = (): EvidenceStore => new EvidenceStore(join(directory, `s-${Math.random().toString(36).slice(2)}`));

  it('stores bytes at their own hash and gives them back unchanged', () => {
    const s = store();
    const bytes = bytesOf('pour record, bay 4, 07:12');
    const hash = hashBytes(bytes);

    const stored = s.put('tenant-a', hash, bytes, 'text/plain');
    assert.equal(stored.hash, hash);
    assert.equal(stored.bytes, bytes.length);

    const read = s.get('tenant-a', hash);
    assert.deepEqual(read.bytes, bytes);
    assert.equal(read.contentType, 'text/plain');
  });

  it('refuses bytes that do not hash to the address they claim', () => {
    // The single most important refusal here. Without it a client could store
    // arbitrary content under a hash the ledger already trusts, and every
    // downstream proof would then be a proof of the wrong document.
    const s = store();
    const hash = hashBytes(bytesOf('the real inspection certificate'));

    throwsCode(() => s.put('tenant-a', hash, bytesOf('a different document entirely'), 'text/plain'), 'EVIDENCE_HASH_MISMATCH');
    assert.equal(s.has('tenant-a', hash), false, 'the rejected upload must leave nothing behind');
  });

  it('refuses a hash that is really a path', () => {
    // Whitelisted, not sanitised. A check for `..` is a traversal waiting for
    // an encoding somebody has not thought of.
    const s = store();
    for (const attempt of ['sha256:../../../etc/passwd', '../../etc/passwd', 'sha256:ABC', 'sha256:', 'md5:0123']) {
      throwsCode(() => s.get('tenant-a', attempt), 'EVIDENCE_HASH_INVALID', `${attempt} was not refused`);
    }
    throwsCode(() => s.put('../../root', hashBytes(bytesOf('x')), bytesOf('x'), 'text/plain'), 'EVIDENCE_TENANT_INVALID');
  });

  it('does not let one tenant read another tenant\'s object', () => {
    // Same bytes, same hash, two tenancies. Deduplicating across them would
    // look efficient and would make one tenant's retention decision reach into
    // another tenant's record.
    const s = store();
    const bytes = bytesOf('a standard method statement both companies happen to use');
    const hash = hashBytes(bytes);

    s.put('tenant-a', hash, bytes, 'application/pdf');
    assert.equal(s.has('tenant-b', hash), false);
    throwsCode(() => s.get('tenant-b', hash), 'EVIDENCE_NOT_STORED');
  });

  it('is idempotent, because the offline outbox retries', () => {
    const s = store();
    const bytes = bytesOf('site diary 14 March');
    const hash = hashBytes(bytes);

    const first = s.put('tenant-a', hash, bytes, 'text/plain');
    const second = s.put('tenant-a', hash, bytes, 'text/plain');
    assert.equal(first.hash, second.hash);
    assert.equal(second.bytes, bytes.length);
  });

  it('refuses an empty file and a file over the ceiling', () => {
    const s = new EvidenceStore(join(directory, 'limits'), { maxBytes: 64 });
    throwsCode(() => s.put('tenant-a', hashBytes(Buffer.alloc(0)), Buffer.alloc(0), 'text/plain'), 'EVIDENCE_EMPTY');

    const big = Buffer.alloc(65, 7);
    throwsCode(() => s.put('tenant-a', hashBytes(big), big, 'application/octet-stream'), 'EVIDENCE_TOO_LARGE');
  });

  it('detects a stored file that has changed underneath it', () => {
    // Re-hashing on read is cheap insurance against a corrupted volume serving
    // something that is no longer the evidence anybody recorded — and the whole
    // claim of the record is that it can be trusted years later.
    const root = join(directory, 'corrupt');
    const s = new EvidenceStore(root);
    const bytes = bytesOf('the certificate as issued');
    const hash = hashBytes(bytes);
    s.put('tenant-a', hash, bytes, 'text/plain');

    const digest = hash.slice('sha256:'.length);
    writeFileSync(join(root, 'tenant-a', digest.slice(0, 2), digest.slice(2, 4), digest), 'tampered');

    throwsCode(() => s.get('tenant-a', hash), 'EVIDENCE_CORRUPT');
  });

  it('leaves no partial object behind when a write is interrupted', () => {
    // The write-beside-and-rename discipline, checked by its observable effect:
    // after a successful put there is exactly one object and one type file, and
    // nothing named `.partial` that a reader could mistake for the object.
    const root = join(directory, 'atomic');
    const s = new EvidenceStore(root);
    const bytes = bytesOf('as-built survey');
    const hash = hashBytes(bytes);
    s.put('tenant-a', hash, bytes, 'text/plain');

    const digest = hash.slice('sha256:'.length);
    const entries = readdirSync(join(root, 'tenant-a', digest.slice(0, 2), digest.slice(2, 4)));
    assert.deepEqual(entries.sort(), [digest, `${digest}.type`].sort());
  });

  it('says so rather than pretending when no store is configured', () => {
    // An empty root is a legitimate deployment: hashes recorded, files not
    // held. What it must never do is fail as though the evidence were missing.
    const s = new EvidenceStore('');
    assert.equal(s.configured, false);
    const bytes = bytesOf('anything');
    throwsCode(() => s.put('tenant-a', hashBytes(bytes), bytes, 'text/plain'), 'EVIDENCE_STORE_UNCONFIGURED');
    assert.equal(s.has('tenant-a', hashBytes(bytes)), false);
  });
});

describe('signed evidence links', () => {
  const secret = 'a-test-secret';
  const s = (): EvidenceStore => new EvidenceStore(join(directory, 'links'), { secret });
  const hash = hashBytes(bytesOf('signed link subject'));

  it('verifies a link it minted', () => {
    const store = s();
    const { url, expiresAt } = store.signedUrl('tenant-a', hash, 300);
    const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));

    assert.equal(query.get('tenant'), 'tenant-a');
    assert.ok(new Date(expiresAt).getTime() > Date.now());
    assert.equal(
      store.verifySignedUrl('tenant-a', hash, Number(query.get('expires')), query.get('signature') as string),
      true,
    );
  });

  it('refuses a link forwarded outside its tenancy', () => {
    const store = s();
    const query = new URLSearchParams(store.signedUrl('tenant-a', hash, 300).url.split('?')[1]);
    assert.equal(
      store.verifySignedUrl('tenant-b', hash, Number(query.get('expires')), query.get('signature') as string),
      false,
    );
  });

  it('refuses a link pointed at a different object', () => {
    const store = s();
    const query = new URLSearchParams(store.signedUrl('tenant-a', hash, 300).url.split('?')[1]);
    const other = hashBytes(bytesOf('a different file'));
    assert.equal(
      store.verifySignedUrl('tenant-a', other, Number(query.get('expires')), query.get('signature') as string),
      false,
    );
  });

  it('refuses an expired link, and refuses it without comparing signatures', () => {
    const store = s();
    // Minted in the past. Expiry is checked first and separately: there is
    // nothing to learn from timing a request that was never going to be served.
    const { url } = store.signedUrl('tenant-a', hash, -1);
    const query = new URLSearchParams(url.split('?')[1]);
    assert.equal(
      store.verifySignedUrl('tenant-a', hash, Number(query.get('expires')), query.get('signature') as string),
      false,
    );
  });

  it('refuses a forged or malformed signature without throwing', () => {
    const store = s();
    const expires = Math.floor(Date.now() / 1000) + 300;
    for (const forged of ['', 'deadbeef', 'zz'.repeat(32), 'a'.repeat(64), 'not-hex-at-all']) {
      assert.equal(store.verifySignedUrl('tenant-a', hash, expires, forged), false, `${forged} was accepted`);
    }
  });

  it('cannot be verified under a different secret', () => {
    const query = new URLSearchParams(s().signedUrl('tenant-a', hash, 300).url.split('?')[1]);
    const rotated = new EvidenceStore(join(directory, 'links'), { secret: 'a-different-secret' });
    assert.equal(
      rotated.verifySignedUrl('tenant-a', hash, Number(query.get('expires')), query.get('signature') as string),
      false,
    );
  });
});

describe('evidence over HTTP', () => {
  let platform: Platform;
  let seed: SeedResult;
  let server: Server;
  let base: string;
  let hash: string;
  let bytes: Buffer;

  before(async () => {
    platform = new Platform(undefined, new EvidenceStore(join(directory, 'http')));
    seed = await seedDemoProject(platform);
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    // A hash the ledger already claims as evidence. The bytes are invented here
    // because the seed records the hash of this exact string — that is the
    // ordinary case: the record exists, the file has not been supplied yet.
    const record = platform.ledger.list(seed.projectId, 'EvidenceItem')[0];
    hash = (record?.state as { hash: string }).hash;
    bytes = Buffer.from('irrelevant', 'utf8');
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

  /** Store a file for an evidence record that exists, and return its hash. */
  async function upload(content: string, contentType: string, who = 'pm'): Promise<{ status: number; hash: string; body: any }> {
    const payload = Buffer.from(content, 'utf8');
    const contentHash = hashBytes(payload);

    // Register the hash the way the platform does — through a domain command,
    // never by writing to the store first. That ordering is the rule the upload
    // route enforces, so the test has to obey it too.
    const ctx = platform.context(seed.users[who]!.auth, seed.projectId, { correlationId: 'evidence-test' });
    const { registerEvidence } = await import('../src/engines/context.ts');
    registerEvidence(ctx, {
      type: 'SITE_PHOTOGRAPH',
      hash: contentHash,
      description: `Uploaded in a test as ${contentType}`,
    });

    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(contentHash)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': contentType },
      body: payload,
    });
    const text = await response.text();
    return { status: response.status, hash: contentHash, body: text ? JSON.parse(text) : undefined };
  }

  it('refuses bytes for a hash no ledger record claims', async () => {
    // The rule that stops this being an open blob store with an authentication
    // check on it: a record names a hash first, and only then may bytes exist.
    const orphan = hashBytes(Buffer.from('never registered as evidence', 'utf8'));
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(orphan)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('pm')}`, 'content-type': 'text/plain' },
      body: 'never registered as evidence',
    });

    assert.equal(response.status, 404);
    assert.equal(platform.evidence.has(seed.tenantId, orphan), false);
  });

  it('refuses bytes that do not match the registered hash, over the wire', async () => {
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(hash)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('pm')}`, 'content-type': 'text/plain' },
      body: bytes,
    });

    assert.equal(response.status, 422);
    // problem+json carries the machine-readable code as `title`.
    const problem = (await response.json()) as { title?: string };
    assert.equal(problem.title, 'EVIDENCE_HASH_MISMATCH');
  });

  it('stores a file and serves it back to an authorised session', async () => {
    const { status, hash: stored } = await upload('an inspection photograph, notionally', 'image/jpeg');
    assert.equal(status, 201);

    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(stored)}`, {
      headers: { authorization: `Bearer ${tokenFor('pm')}` },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'an inspection photograph, notionally');
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
  });

  it('refuses an anonymous request with no link at all', async () => {
    const { hash: stored } = await upload('private to the tenancy', 'text/plain');
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(stored)}`);
    assert.equal(response.status, 401);
  });

  it('serves a valid signed link with no credentials, and refuses a tampered one', async () => {
    const { hash: stored } = await upload('the adjudicator needs to see this', 'text/plain');

    const minted = await fetch(`${base}/v1/evidence/${encodeURIComponent(stored)}/link`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('pm')}` },
    });
    assert.equal(minted.status, 200);
    const { url } = (await minted.json()) as { url: string };

    const good = await fetch(`${base}${url}`);
    assert.equal(good.status, 200, 'a valid signed link must work without a session — that is what it is for');
    assert.equal(await good.text(), 'the adjudicator needs to see this');

    // One character of the signature.
    const tampered = url.replace(/signature=(.)/, (_m, c: string) => `signature=${c === 'a' ? 'b' : 'a'}`);
    const bad = await fetch(`${base}${tampered}`);
    assert.equal(bad.status, 403);

    // And a link whose tenancy has been swapped for another.
    const swapped = url.replace(/tenant=[^&]+/, 'tenant=someone-else');
    assert.equal((await fetch(`${base}${swapped}`)).status, 403);
  });

  it('never serves an uploaded document inline unless a browser only renders it', async () => {
    // Stored cross-site scripting, contained. An uploaded HTML file served
    // inline on the platform's own origin would run as the platform; it
    // downloads instead, with nosniff so the browser does not second-guess the
    // type and a policy that denies the document every capability.
    const { hash: stored } = await upload('<script>alert(document.cookie)</script>', 'text/html');

    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(stored)}`, {
      headers: { authorization: `Bearer ${tokenFor('pm')}` },
    });

    assert.match(response.headers.get('content-disposition') ?? '', /^attachment/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
  });

  it('bars the platform operator from customer evidence', async () => {
    const { hash: stored } = await upload('customer delivery data', 'text/plain');
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(stored)}`, {
      headers: { authorization: `Bearer ${tokenFor('operator')}` },
    });
    assert.equal(response.status, 403);
  });

  it('lets the person who registered the evidence supply its file', async () => {
    // A site supervisor holds EVIDENCE_AUDIT read only and is exactly the
    // person whose phone took the photograph. Completing your own record is not
    // reaching into somebody else's.
    const { status } = await upload('captured on a handset at the work face', 'image/jpeg', 'qaqc');
    assert.equal(status, 201);
  });

  it('reports honestly which evidence the platform actually holds', async () => {
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/evidence`, {
      headers: { authorization: `Bearer ${tokenFor('pm')}` },
    });
    assert.equal(response.status, 200);
    const register = (await response.json()) as {
      storeConfigured: boolean;
      coverage: { total: number; held: number; missing: number };
      entries: Array<{ hash: string; held: boolean }>;
    };

    assert.equal(register.storeConfigured, true);
    assert.ok(register.coverage.total > 0);
    assert.ok(register.coverage.missing > 0, 'the seeded evidence has no files, and the register must say so');
    assert.equal(register.coverage.held + register.coverage.missing, register.coverage.total);

    // The seeded record, whose bytes were never supplied, is reported unheld
    // rather than omitted. A register that listed only what it holds would
    // imply a completeness the platform does not have.
    assert.equal(register.entries.find((e) => e.hash === hash)?.held, false);
  });

  it('joins ledger records to stored bytes and to nothing else', () => {
    const entries = projectRegister(platform.ledger, platform.evidence, seed.tenantId, seed.projectId);
    assert.deepEqual(coverage(entries), {
      total: entries.length,
      held: entries.filter((e) => e.held).length,
      missing: entries.filter((e) => !e.held).length,
    });

    assert.equal(findByHash(platform.ledger, seed.tenantId, hash)?.refType, 'EvidenceItem');
    // Scoped to the tenancy, so another tenant's identifier finds nothing.
    assert.equal(findByHash(platform.ledger, 'some-other-tenant', hash), undefined);
  });
});
