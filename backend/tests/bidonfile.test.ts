import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as bidEvidence from '../src/domain/bidon/evidence.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { findByHash } from '../src/evidence/registry.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The file behind a Bid-On evidence item.
 *
 * Bid-On's whole document-reading half depends on this one path: the
 * questionnaire parser takes a *hash* for a PDF, the amendments reading takes a
 * hash for a schedule of amendments, and extraction reads a hash. If bytes
 * cannot be supplied for a hash a Bid-On record names, then every one of those
 * is reachable only by pasting text, and a tender that arrives as nine PDFs —
 * which is how they arrive — cannot be read by the module at all.
 *
 * It was reported as broken from exactly that direction, and asserting it
 * either way is the point of this file. `POST /v1/evidence/:hash` refuses bytes
 * unless a ledger record already names the hash, and it resolves that record
 * through `EvidenceItem`. A Bid-On evidence item is a `BidOnEvidence` record,
 * so the question is whether one of those puts an `EvidenceItem` on the chain
 * as well.
 *
 * It does — `fileEvidence` calls `registerEvidence` deliberately, "so the file
 * is not in a second register beside the one the audit trail already reads" —
 * and that is what makes the upload resolve. That is a load-bearing
 * consequence of a decision made for a different reason, which is precisely the
 * kind of thing that holds until somebody refactors it with no test watching.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let customerId: string;
const directory = mkdtempSync(join(tmpdir(), 'construx-bidon-file-'));

/** The provider's director, on the tenancy's governance context. */
const asProvider = () => platform.context(seed.users.owner!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

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

before(async () => {
  platform = new Platform(undefined, new EvidenceStore(join(directory, 'store')));
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'BID_ON',
    tenantId: seed.tenantId,
    status: 'ACTIVE',
    reason: 'Allocated under the signed Bid-On agreement',
    agreementRef: 'AGR-BIDON-2026-001',
    decidedBy: seed.users.operator!.id,
  });
  customerId = customers.openCustomer(asProvider(), { legalName: 'Thornhill Electrical Services Ltd' }).id;

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('a Bid-On evidence item can hold its file', () => {
  const bytes = Buffer.from('Appendix 3 — JCT MTC 2024 Schedule of Amendments, notionally.', 'utf8');
  const hash = hashBytes(bytes);

  it('puts the hash on the platform evidence chain when the item is filed', () => {
    const item = bidEvidence.fileEvidence(asProvider(), {
      customerAccountId: customerId,
      type: 'POLICY',
      title: 'Schedule of amendments as issued',
      hash,
    });

    assert.equal(item.hash, hash);
    // The record the upload route resolves. Not an implementation detail: it is
    // what makes the file supplyable at all, and the reason `fileEvidence`
    // registers one is that a second evidence register beside the audit trail's
    // own would be a second source of truth about the same document.
    assert.ok(item.evidenceItemId, 'the Bid-On item names no platform evidence record');
    const registered = findByHash(platform.ledger, seed.tenantId, hash);
    assert.ok(registered, 'nothing on the chain names this hash, so no bytes could ever be stored for it');
    assert.equal(registered.refId, item.evidenceItemId);
    assert.equal((registered.state as { type: string }).type, 'BID_ON_POLICY');
  });

  it('accepts the bytes over the wire and serves them back', async () => {
    const stored = await fetch(`${base}/v1/evidence/${encodeURIComponent(hash)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('owner')}`, 'content-type': 'application/pdf' },
      body: bytes,
    });
    assert.equal(stored.status, 201, `the file behind a Bid-On evidence item was refused: ${await stored.text()}`);
    assert.equal(platform.evidence.has(seed.tenantId, hash), true);

    const served = await fetch(`${base}/v1/evidence/${encodeURIComponent(hash)}`, {
      headers: { authorization: `Bearer ${tokenFor('owner')}` },
    });
    assert.equal(served.status, 200);
    assert.equal(await served.text(), bytes.toString('utf8'));
    assert.equal(served.headers.get('content-type'), 'application/pdf');
  });

  it('still refuses bytes that do not hash to the address they claim', async () => {
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(hash)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('owner')}`, 'content-type': 'application/pdf' },
      body: Buffer.from('a different appendix entirely', 'utf8'),
    });
    assert.equal(response.status, 422);
    assert.equal(((await response.json()) as { title?: string }).title, 'EVIDENCE_HASH_MISMATCH');
  });

  it('offers the file itself in the console, not a hash to be obtained elsewhere', () => {
    // Read as text, which is how every console invariant in this suite is
    // checked: the pages are plain JavaScript by design and nothing in the type
    // system can see a field declared with the wrong type.
    //
    // The backend path above worked all along. What did not exist was any way
    // to use it from a browser — the form asked for a hash as text, so filing
    // the nine PDFs of a real tender meant a shell and `sha256sum`. The field
    // type is the fix, because `command.js` already hashes, files and uploads.
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'pages', 'bidon.js'), 'utf8');
    const form = page.slice(page.indexOf("'file-evidence': {"), page.indexOf("'record-extraction': {"));
    assert.ok(form.length > 0, 'the evidence form moved; this assertion is reading nothing');
    assert.match(form, /name: 'hash', label: '[^']*', type: 'file'/, 'the evidence form asks for a hash rather than for the file');
    // And the hash a filed document already has is obtainable, because the
    // parser and the amendments reading both take one.
    assert.match(page, /data-copy-hash=/, 'nothing in the library offers a document’s hash to the two commands that ask for one');
  });

  it('refuses bytes for a hash no Bid-On item has filed', async () => {
    const orphan = hashBytes(Buffer.from('Appendix 9, which does not exist', 'utf8'));
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(orphan)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('owner')}`, 'content-type': 'application/pdf' },
      body: Buffer.from('Appendix 9, which does not exist', 'utf8'),
    });
    assert.equal(response.status, 404);
  });
});
