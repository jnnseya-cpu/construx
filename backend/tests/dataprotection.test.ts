import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { config } from '../src/config.ts';
import * as envelope from '../src/evidence/envelope.ts';
import { parseVerification, VERIFICATION_SCHEME } from '../src/export/exporter.ts';
import { transportPosture } from '../src/ops/transport.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Data protection: what protects a customer's record at rest, in flight, and
 * after a document has left the platform entirely.
 *
 * The third of those is the one with no precedent elsewhere in this codebase.
 * Everything else the platform proves, it proves to somebody holding a session;
 * a verification code has to prove something to a solicitor holding a PDF and
 * nothing else, which means the test has to be written from that side — build a
 * real document, alter it the way somebody would, and check that the platform
 * refuses it.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');

/**
 * Set a master key for the duration of a block and put back whatever was there.
 *
 * `config.evidence.masterKey` is read on every call rather than cached, which is
 * what makes this possible — and is itself the reason the module reads it that
 * way rather than at import.
 */
function withKey<T>(key: string | undefined, run: () => T): T {
  const held = config.evidence.masterKey;
  (config.evidence as { masterKey?: string }).masterKey = key;
  try {
    return run();
  } finally {
    (config.evidence as { masterKey?: string }).masterKey = held;
  }
}

describe('evidence at rest', () => {
  it('turns plaintext into something that is not the plaintext', () => {
    withKey(KEY, () => {
      const plain = Buffer.from('site photograph bytes');
      const stored = envelope.encrypt('tenant-a', plain);
      assert.ok(!stored.equals(plain), 'the stored bytes are the plaintext');
      assert.ok(envelope.isEnvelope(stored));
      assert.deepEqual(envelope.decrypt('tenant-a', stored), plain);
    });
  });

  it('gives two tenancies different ciphertext for identical bytes', () => {
    withKey(KEY, () => {
      const plain = Buffer.from('the same drawing, filed by two customers');
      const a = envelope.encrypt('tenant-a', plain);
      const b = envelope.encrypt('tenant-b', plain);
      assert.ok(!a.equals(b));
      assert.deepEqual(envelope.decrypt('tenant-a', a), plain);
      assert.deepEqual(envelope.decrypt('tenant-b', b), plain);
    });
  });

  it('refuses a file moved into another tenancy’s prefix rather than decrypting it', () => {
    withKey(KEY, () => {
      // The attack the store's shape invites: it is content-addressed and the
      // paths are predictable, so moving a file between prefixes is a copy
      // command. Without the tenancy bound in as authenticated data this would
      // decrypt into the wrong customer's evidence.
      const stored = envelope.encrypt('tenant-a', Buffer.from('a payment certificate'));
      assert.throws(() => envelope.decrypt('tenant-b', stored), /EVIDENCE_DECRYPT_FAILED|did not authenticate/);
    });
  });

  it('refuses a file with a single byte altered', () => {
    withKey(KEY, () => {
      const stored = envelope.encrypt('tenant-a', Buffer.from('measured quantity: 412 m3'));
      const tampered = Buffer.from(stored);
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
      assert.throws(() => envelope.decrypt('tenant-a', tampered), /did not authenticate/);
    });
  });

  it('reads a file written before the key existed, so switching encryption on is not a migration', () => {
    const legacy = Buffer.from('written when this deployment had no master key');
    const asStored = withKey(undefined, () => envelope.encrypt('tenant-a', legacy));
    assert.deepEqual(asStored, legacy, 'without a key, encrypt must be a pass-through');
    withKey(KEY, () => assert.deepEqual(envelope.decrypt('tenant-a', asStored), legacy));
  });

  it('says the key is missing rather than pretending the file is corrupt', () => {
    const stored = withKey(KEY, () => envelope.encrypt('tenant-a', Buffer.from('x')));
    withKey(undefined, () => {
      assert.throws(() => envelope.decrypt('tenant-a', stored), (error: Error) => {
        // The distinction matters operationally: "corrupt" sends somebody to a
        // backup, "key missing" sends them to the secret manager, and only one
        // of those recovers the file.
        assert.match(error.message, /key is missing|EVIDENCE_KEY_UNAVAILABLE/);
        return true;
      });
    });
  });

  it('rotates a file to the current key version without changing what it says', () => {
    withKey(KEY, () => {
      const plain = Buffer.from('a scanned contract');
      const first = envelope.encrypt('tenant-a', plain);
      const rotated = envelope.rotate('tenant-a', first);
      assert.ok(!rotated.equals(first), 'rotation must produce fresh bytes, not the same ciphertext');
      assert.deepEqual(envelope.decrypt('tenant-a', rotated), plain);
    });
  });

  it('refuses a master key that is not 32 bytes rather than stretching it', () => {
    // Stretching would produce a working system with a weaker key than the
    // operator believes they configured, which is the worst of both.
    withKey(Buffer.alloc(16, 3).toString('base64'), () => {
      assert.throws(() => envelope.enabled(), /EVIDENCE_MASTER_KEY must be 32 bytes|decodes to 16/);
    });
  });

  it('derives a different key for each tenancy, which is what makes per-customer erasure a promise about a key', () => {
    withKey(KEY, () => {
      assert.ok(!envelope.dataKey('tenant-a', 1).equals(envelope.dataKey('tenant-b', 1)));
      // And the same one twice, or nothing written yesterday reads today.
      assert.deepEqual(envelope.dataKey('tenant-a', 1), envelope.dataKey('tenant-a', 1));
    });
  });

  it('derives a different key for each version, which is what makes rotation mean anything', () => {
    withKey(KEY, () => {
      // The version lives in the HKDF salt. Without it, moving the master to a
      // new version would produce the identical key and "rotated" would be a
      // word in a runbook rather than a different secret.
      assert.ok(!envelope.dataKey('tenant-a', 1).equals(envelope.dataKey('tenant-a', 2)));
    });
  });

  it('accepts a key as hex as well as base64, because operators paste what their secret manager gives them', () => {
    const asHex = Buffer.alloc(32, 7).toString('hex');
    const viaHex = withKey(asHex, () => envelope.encrypt('tenant-a', Buffer.from('same key, two spellings')));
    withKey(KEY, () => {
      assert.deepEqual(envelope.decrypt('tenant-a', viaHex), Buffer.from('same key, two spellings'));
    });
  });
});

describe('the posture is written as claims and non-claims', () => {
  it('claims nothing at all while no key is configured', () => {
    withKey(undefined, () => {
      const posture = envelope.posture();
      assert.equal(posture.enabled, false);
      assert.equal(posture.keySource, 'NOT_CONFIGURED');
      assert.deepEqual(posture.protects, [], 'an unencrypted store must not claim to protect anything');
      assert.ok(posture.actions.length > 0, 'and must name what the operator has to do');
    });
  });

  it('states its limits even when it is switched on', () => {
    withKey(KEY, () => {
      const posture = envelope.posture();
      assert.equal(posture.enabled, true);
      assert.ok(posture.protects.length > 0);
      // The point of the whole shape: turning it on does not empty the
      // non-claims list. A live process still reads plaintext and a stolen
      // master key is still a stolen archive.
      assert.ok(posture.doesNotProtect.length > 0);
      assert.ok(posture.doesNotProtect.some((limit) => /live process/i.test(limit)));
      assert.ok(posture.doesNotProtect.some((limit) => /master key/i.test(limit)));
    });
  });
});

describe('transport, and what a process serving plain HTTP can honestly say', () => {
  function withTransport<T>(patch: Partial<typeof config.transport> & { publicBaseUrl?: string }, run: () => T): T {
    const heldTransport = { ...config.transport };
    const heldUrl = config.publicBaseUrl;
    Object.assign(config.transport, patch);
    if (patch.publicBaseUrl) (config as { publicBaseUrl: string }).publicBaseUrl = patch.publicBaseUrl;
    try {
      return run();
    } finally {
      Object.assign(config.transport, heldTransport);
      (config as { publicBaseUrl: string }).publicBaseUrl = heldUrl;
    }
  }

  it('calls an http public address critical, because every token travels in clear', () => {
    withTransport({ publicBaseUrl: 'http://construx.example' }, () => {
      const posture = transportPosture();
      assert.equal(posture.publicAddressIsSecure, false);
      assert.equal(posture.findings[0]!.severity, 'CRITICAL');
    });
  });

  it('does not call localhost critical, because that is the expected arrangement', () => {
    withTransport({ publicBaseUrl: 'http://localhost:8080' }, () => {
      const posture = transportPosture();
      const address = posture.findings.find((finding) => /not https/.test(finding.finding));
      assert.equal(address?.severity, 'NOTE');
    });
  });

  it('calls out a declaration that this process terminates TLS, because it does not', () => {
    withTransport({ publicBaseUrl: 'https://construx.example', termination: 'THIS_PROCESS' }, () => {
      const posture = transportPosture();
      const claim = posture.findings.find((finding) => /terminating in this process/.test(finding.finding));
      assert.equal(claim?.severity, 'CRITICAL', 'a false declaration is worse than none');
    });
  });

  it('calls a forwarded-protocol header trusted from anywhere an authentication bypass', () => {
    withTransport(
      { publicBaseUrl: 'https://construx.example', trustForwardedProto: true, trustedProxyCidrs: '' },
      () => {
        const posture = transportPosture();
        const finding = posture.findings.find((f) => /forwarded-protocol/.test(f.finding));
        assert.equal(finding?.severity, 'CRITICAL');
        assert.match(posture.forwardedProtocol.because, /any source/);
      },
    );
  });

  it('is satisfied by a correctly configured deployment, and says so without hedging', () => {
    withTransport(
      {
        publicBaseUrl: 'https://construx.example',
        termination: 'LOAD_BALANCER',
        hstsMaxAgeSeconds: 15_552_000,
        cookiesSecure: true,
        trustForwardedProto: false,
        trustedProxyCidrs: '',
      },
      () => {
        const posture = transportPosture();
        assert.deepEqual(posture.findings, []);
        assert.match(posture.summary, /load balancer terminates TLS/);
      },
    );
  });

  it('names what it cannot see rather than inventing an answer', () => {
    const posture = transportPosture();
    assert.ok(posture.notVisibleFromHere.some((limit) => /[Cc]ipher suites/.test(limit)));
    assert.ok(posture.notVisibleFromHere.some((limit) => /certificate/.test(limit)));
  });

  it('orders findings worst first, even where they were raised in the wrong order', () => {
    // Chosen so the checks *push* a NOTE before a CRITICAL: a localhost address
    // is a NOTE, and the false TLS declaration that follows it is critical. An
    // unsorted list would put the note at the top and summarise the wrong thing.
    withTransport({ publicBaseUrl: 'http://localhost:8080', termination: 'THIS_PROCESS' }, () => {
      const posture = transportPosture();
      assert.ok(posture.findings.length >= 2, 'this case must raise more than one finding to order');
      assert.equal(posture.findings[0]!.severity, 'CRITICAL');
      assert.match(posture.summary, /critical transport finding/);
    });

    withTransport({ publicBaseUrl: 'http://construx.example', termination: 'NOT_DECLARED' }, () => {
      const posture = transportPosture();
      const severities = posture.findings.map((finding) => finding.severity);
      const order = { CRITICAL: 0, WARNING: 1, NOTE: 2 };
      const sorted = [...severities].sort((a, b) => order[a] - order[b]);
      assert.deepEqual(severities, sorted);
    });
  });
});

describe('a document that has left the platform', () => {
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
  });

  after(() => server.close());

  /** A session for a seeded identity, minted directly — the sign-in ceremony
   *  is another suite's subject and a second factor here would only be noise. */
  function tokenFor(who: keyof SeedResult['users']): string {
    const user = platform.user(seed.users[who]!.id);
    return issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;
  }

  /** Generate a real branded export over HTTP, as a project manager would. */
  async function issueDocument(): Promise<{ reference: string; contentHash: string; verification: string; generatedAt: string }> {
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/exports/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('pm')}` },
      body: JSON.stringify({ audience: 'CLIENT', format: 'PDF' }),
    });
    assert.equal(response.status, 201, 'the export itself must succeed before anything can be verified');
    return (await response.json()) as { reference: string; contentHash: string; verification: string; generatedAt: string };
  }

  async function check(input: { reference: string; contentHash: string; verification: string }) {
    return (await fetch(`${base}/v1/verify/document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }).then((response) => response.json())) as Record<string, unknown>;
  }

  it('carries a verification code in the platform’s own scheme', async () => {
    const document = await issueDocument();
    assert.ok(document.verification, 'every export must carry one');
    const parts = parseVerification(document.verification);
    assert.ok(parts, 'and it must parse');
    assert.ok(document.verification.startsWith(`${VERIFICATION_SCHEME}:`));
  });

  it('verifies for somebody holding only the three printed strings and no account', async () => {
    const document = await issueDocument();
    const outcome = await check({
      reference: document.reference,
      contentHash: document.contentHash,
      verification: document.verification,
    });
    assert.equal(outcome.verified, true);
    assert.equal(outcome.reference, document.reference);
    assert.equal(outcome.recorded, true, 'the export register should hold the document just issued');
    assert.ok(String(outcome.issuedAt).length > 0);
  });

  it('reports the detail of the document being checked, not of some other export', async () => {
    const first = await issueDocument();
    const second = await issueDocument();
    assert.notEqual(first.reference, second.reference);

    const outcome = (await check({
      reference: second.reference,
      contentHash: second.contentHash,
      verification: second.verification,
    })) as { verified: boolean; issuedAt: string; recorded: boolean };

    // The reference comes back from the input, so it proves nothing on its own.
    // The issue time comes from the register, and picking the wrong row — the
    // first export in the tenancy rather than this one — would show a recipient
    // somebody else's document's date beside a "genuine" verdict.
    assert.equal(outcome.verified, true);
    assert.equal(outcome.recorded, true);
    assert.equal(outcome.issuedAt, second.generatedAt);
    assert.notEqual(outcome.issuedAt, first.generatedAt);
  });

  it('refuses a document whose content hash has been altered', async () => {
    const document = await issueDocument();
    // What a forger does: change a figure, recompute the hash, print the new
    // one in the footer. The hash agrees with the altered document — which is
    // exactly why the hash alone was never proof.
    const outcome = await check({
      reference: document.reference,
      contentHash: `${document.contentHash.slice(0, -1)}0`,
      verification: document.verification,
    });
    assert.equal(outcome.verified, false);
    assert.ok(!('issuedBy' in outcome), 'a refusal must disclose nothing');
  });

  it('refuses a code lifted from one document and printed on another', async () => {
    const first = await issueDocument();
    const second = await issueDocument();
    const outcome = await check({
      reference: second.reference,
      contentHash: second.contentHash,
      verification: first.verification,
    });
    assert.equal(outcome.verified, false);
  });

  it('refuses a code re-issued under a tenancy the caller invented', async () => {
    const document = await issueDocument();
    const parts = parseVerification(document.verification)!;
    const forged = `${VERIFICATION_SCHEME}:not-a-real-tenancy:${parts.tag}`;
    const outcome = await check({
      reference: document.reference,
      contentHash: document.contentHash,
      verification: forged,
    });
    assert.equal(outcome.verified, false);
  });

  it('gives every failure the same sentence, so no attempt is graded', async () => {
    const document = await issueDocument();
    const failures = await Promise.all([
      check({ reference: document.reference, contentHash: document.contentHash, verification: 'nonsense' }),
      check({ reference: 'MADE-UP-00001', contentHash: document.contentHash, verification: document.verification }),
      check({
        reference: document.reference,
        contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        verification: document.verification,
      }),
      check({ reference: document.reference, contentHash: document.contentHash, verification: `${VERIFICATION_SCHEME}:x:y` }),
    ]);
    const sentences = new Set(failures.map((outcome) => outcome.finding));
    assert.equal(sentences.size, 1, 'four different causes must produce one indistinguishable refusal');
    for (const outcome of failures) assert.equal(outcome.verified, false);
  });

  it('renders a page for a recipient who has a PDF and no idea what an API is', async () => {
    const document = await issueDocument();
    const page = await fetch(`${base}/verify-document`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        reference: document.reference,
        contentHash: document.contentHash,
        verification: document.verification,
      }).toString(),
    });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /This document is genuine/);
    assert.match(html, new RegExp(document.reference));
    // The page has to state its own limits, or somebody reads "verified" as
    // "current and correct".
    assert.match(html, /not.*the current revision|current revision/i);
  });

  it('renders the same refusal on the page as the API gives, for an altered document', async () => {
    const document = await issueDocument();
    const page = await fetch(`${base}/verify-document`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        reference: document.reference,
        contentHash: `${document.contentHash.slice(0, -1)}0`,
        verification: document.verification,
      }).toString(),
    });
    const html = await page.text();
    assert.match(html, /does not match an issued document/);
    assert.ok(!/is genuine/.test(html));
  });

  it('offers the empty form to somebody arriving with nothing', async () => {
    const page = await fetch(`${base}/verify-document`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Check a document you have been given/);
    assert.match(html, /name="verification"/);
  });

  it('needs no credential at all, which is the whole point', async () => {
    const document = await issueDocument();
    const response = await fetch(`${base}/v1/verify/document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        reference: document.reference,
        contentHash: document.contentHash,
        verification: document.verification,
      }),
    });
    assert.equal(response.status, 200, 'a check behind a login is a check nobody performs');
  });
});

describe('the tenancy’s data-protection position', () => {
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
  });

  after(() => server.close());

  /** A session for a seeded identity, minted directly — the sign-in ceremony
   *  is another suite's subject and a second factor here would only be noise. */
  function tokenFor(who: keyof SeedResult['users']): string {
    const user = platform.user(seed.users[who]!.id);
    return issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;
  }

  it('is readable by an enterprise admin, who is the one holding the questionnaire', async () => {
    const token = tokenFor('admin');
    const response = await fetch(`${base}/v1/admin/data-protection`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const position = (await response.json()) as Record<string, Record<string, unknown>>;
    assert.ok(position.atRest);
    assert.ok(position.inFlight);
    assert.ok(position.exportVerification);
    assert.ok(Array.isArray(position.exportVerification.proves));
    assert.ok(Array.isArray(position.exportVerification.doesNotProve));
  });

  it('refuses a site manager, who holds no enterprise structure read', async () => {
    const token = tokenFor('siteManager');
    const response = await fetch(`${base}/v1/admin/data-protection`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 403);
  });

  it('refuses an unauthenticated caller outright', async () => {
    const response = await fetch(`${base}/v1/admin/data-protection`);
    assert.equal(response.status, 401);
  });

  it('reports WEAK where evidence is not encrypted, rather than averaging the two legs', async () => {
    // A customer's data is as protected as its weakest leg. Averaging would let
    // a well-configured load balancer paper over an unencrypted archive.
    const token = tokenFor('admin');
    const position = (await fetch(`${base}/v1/admin/data-protection`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json())) as { atRest: { enabled: boolean }; standing: string };
    if (!position.atRest.enabled) assert.equal(position.standing, 'WEAK');
  });

  it('points a reader at the page rather than at the endpoint', async () => {
    const token = tokenFor('admin');
    const position = (await fetch(`${base}/v1/admin/data-protection`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((response) => response.json())) as { exportVerification: { page: string; endpoint: string } };
    assert.match(position.exportVerification.page, /\/verify-document$/);
    assert.ok(!position.exportVerification.page.endsWith('/verify'), 'that address is the signup confirmation page');
  });
});

describe('the verification code’s own shape', () => {
  beforeEach(() => undefined);

  it('refuses anything that is not three colon-separated parts', () => {
    for (const bad of ['', 'CXV1', 'CXV1:only-two', 'CXV1:a:b:c', 'OTHER:a:b', 'CXV1::b', 'CXV1:a:']) {
      assert.equal(parseVerification(bad), undefined, `${bad} should not parse`);
    }
  });

  it('is specific to the deployment, so nobody can forge one by reading this repository', () => {
    const input = { contentHash: 'sha256:abc', reference: 'REF-1', tenantId: 't-1' };
    const held = config.auth.jwtSecret;
    const first = envelope.issueTag(input);
    try {
      (config.auth as { jwtSecret: string }).jwtSecret = `${held}-other-deployment`;
      assert.notEqual(envelope.issueTag(input), first, 'the tag must depend on this deployment’s secret');
      assert.equal(envelope.verifyTag(input, first), false, 'and a tag from elsewhere must not verify here');
    } finally {
      (config.auth as { jwtSecret: string }).jwtSecret = held;
    }
  });

  it('separates its three fields with a character none of them can contain', () => {
    // Otherwise two different documents shift the boundary between fields and
    // land on one tag: reference "A" + hash "BC" and reference "AB" + hash "C".
    const shifted = envelope.issueTag({ tenantId: 't-1', reference: 'A', contentHash: 'BC' });
    const other = envelope.issueTag({ tenantId: 't-1', reference: 'AB', contentHash: 'C' });
    assert.notEqual(shifted, other);
  });

  it('compares in constant time, so a tag cannot be guessed a character at a time', () => {
    const input = { contentHash: 'sha256:abc', reference: 'REF-1', tenantId: 't-1' };
    const real = envelope.issueTag(input);
    assert.equal(envelope.verifyTag(input, real), true);
    assert.equal(envelope.verifyTag(input, `${real}x`), false, 'a longer tag must not match');
    assert.equal(envelope.verifyTag(input, real.slice(0, -1)), false);
    assert.equal(envelope.verifyTag({ ...input, tenantId: 't-2' }, real), false);
    assert.equal(envelope.verifyTag({ ...input, reference: 'REF-2' }, real), false);
    assert.equal(envelope.verifyTag({ ...input, contentHash: 'sha256:abd' }, real), false);
  });
});
