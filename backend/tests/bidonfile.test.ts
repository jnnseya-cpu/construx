import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { rejectsCode, throwsCode } from './helpers.ts';
import * as customers from '../src/domain/bidon/customers.ts';
import * as bidEngine from '../src/domain/bidon/engine.ts';
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
    assert.match(page, /data-copy-what="document hash"/, 'nothing in the library offers a document’s hash to the two commands that ask for one');
    // And every id a Bid-On command takes by hand is readable where the command
    // says it is. The forms ask for these "from the opened pack above", and the
    // questions table printed neither a question id nor an answer id — so
    // drafting, scoring, approving and raising a gap had no reachable subject.
    for (const what of ['question id', 'answer id', 'gap id', 'returnable id', 'clarification id', 'evidence id']) {
      assert.match(page, new RegExp(`data-copy-what="${what}"`), `the opened pack never shows a ${what}, which a command asks to be typed`);
    }
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

/**
 * The Reader, and the one place a stand-in would become a citation.
 *
 * Every other agent in the module was reachable and this one did not exist, so
 * the passages a drafter cites had to be typed by hand — nine documents of
 * prose transcribed by a bid writer before anything could be drafted, which is
 * the bulk of the labour the module exists to remove.
 *
 * What is asserted is the refusal, because the refusal is the feature. A
 * stand-in reading returns a hash-derived narrative; filed as this customer's
 * evidence it would be retrieved against their questions, cited by the drafter
 * and read by a buyer as the company's own words. Elsewhere a stand-in is
 * visibly a stand-in. Here it becomes a citation.
 */
describe('reading a filed document', () => {
  it('refuses the local stand-in before anything is charged', async () => {
    const bytes = Buffer.from('Assessments shall be completed within ten working days of instruction.', 'utf8');
    const hash = hashBytes(bytes);
    const item = bidEvidence.fileEvidence(asProvider(), {
      customerAccountId: customerId,
      type: 'OTHER',
      title: 'RFX1000209 App 6 — EPC Specification',
      hash,
    });

    const before = platform.wallet(seed.tenantId).snapshot().balanceMinor;
    const error = await rejectsCode(
      () => bidEngine.readEvidence(asProvider(), item.id),
      'NO_PERCEPTION_PROVIDER',
    );
    assert.match(String(error.message), /reads nothing/);
    assert.match(String(error.message), /read by a buyer as the company’s own words/);

    // Nothing charged, and nothing filed. A refusal that had already spent the
    // customer's balance would be the worse half of both outcomes.
    assert.equal(platform.wallet(seed.tenantId).snapshot().balanceMinor, before, 'the wallet moved on a refused read');
    const unchanged = bidEvidence.evidenceOf(asProvider()).find((entry) => entry.id === item.id)!;
    assert.equal(unchanged.chunks.length, 0, 'passages were filed by a provider that was refused');
  });

  it('is offered in the console, and so is typing them by hand', () => {
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'pages', 'bidon.js'), 'utf8');
    // Both doors, deliberately. The agent is what somebody should reach for;
    // the recorder stays for a correction and for a document no provider reads.
    assert.match(page, /'read-evidence': \{/, 'the Reader has no console door');
    assert.match(page, /label: 'Read it for me'/);
    assert.match(page, /label: 'Type the passages myself'/, 'the hand-typed route was replaced rather than kept');
  });
});

/**
 * Correcting what a filed document says about itself.
 *
 * Reported from use, from a real tender: nine appendices filed in a batch, two
 * of them titled "Appendix 1", and no way to fix it. The platform had
 * withdrawal and nothing else — so the only route was to withdraw the item and
 * file it again, which breaks every citation already made against it and
 * leaves two records of one document for a reviewer to reconcile.
 *
 * The title is not cosmetic here: it is how a reviewer finds the document, how
 * the export names it, and — on this particular tender — the difference
 * between the amendments reading reading the schedule of amendments and reading
 * the contract particulars and reporting no amendments.
 */
describe('correcting a filed document', () => {
  const bytes = Buffer.from('Appendix 3. Amendment 14: the liability cap at clause 7.2 is deleted.', 'utf8');
  const hash = hashBytes(bytes);
  let id: string;

  it('fixes a title and keeps what it used to say', () => {
    id = bidEvidence.fileEvidence(asProvider(), {
      customerAccountId: customerId,
      type: 'OTHER',
      // The mistake, exactly as it happened.
      title: 'Appendix 1 - JCT MTC 2024 Recitals, Articles & Contract Particulars',
      hash,
    }).id;

    const corrected = bidEvidence.correctEvidence(asProvider(), id, {
      title: 'Appendix 3 - JCT MTC 2024 Schedule of Amendments',
      reason: 'Filed under the wrong appendix number in the batch upload',
    });

    assert.equal(corrected.title, 'Appendix 3 - JCT MTC 2024 Schedule of Amendments');
    assert.equal(corrected.hash, hash, 'the correction changed which document this is');
    assert.equal(corrected.corrections?.length, 1);
    const [entry] = corrected.corrections!;
    assert.equal(entry!.reason, 'Filed under the wrong appendix number in the batch upload');
    assert.equal(entry!.changed.title!.from, 'Appendix 1 - JCT MTC 2024 Recitals, Articles & Contract Particulars');
    assert.equal(entry!.changed.title!.to, 'Appendix 3 - JCT MTC 2024 Schedule of Amendments');
  });

  it('refuses a correction that corrects nothing', () => {
    throwsCode(
      () =>
        bidEvidence.correctEvidence(asProvider(), id, {
          title: 'Appendix 3 - JCT MTC 2024 Schedule of Amendments',
          reason: 'Pressing the button again changes nothing',
        }),
      'BID_ON_NOTHING_CORRECTED',
    );
  });

  it('holds the filing rules on the way through', () => {
    // Reclassifying to a kind that always lapses, without the day it lapses, is
    // the same safety check switched off — arrived at by a different route.
    throwsCode(
      () => bidEvidence.correctEvidence(asProvider(), id, { type: 'INSURANCE', reason: 'Reclassifying it wrongly' }),
      'BID_ON_EXPIRY_REQUIRED',
    );
  });

  it('refuses to correct a withdrawn item', () => {
    const spare = bidEvidence.fileEvidence(asProvider(), {
      customerAccountId: customerId,
      type: 'OTHER',
      title: 'Appendix 8 - Contractor No Access Process',
      hash: hashBytes(Buffer.from('No access process, notionally.', 'utf8')),
    });
    bidEvidence.withdrawEvidence(asProvider(), spare.id, { reason: 'Superseded by the reissued appendix' });

    throwsCode(
      () => bidEvidence.correctEvidence(asProvider(), spare.id, { title: 'Appendix 8 - reissued', reason: 'Trying to rename a withdrawn item' }),
      'BID_ON_EVIDENCE_WITHDRAWN',
    );
  });

  it('is offered in the console', () => {
    const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'pages', 'bidon.js'), 'utf8');
    assert.match(page, /'correct-evidence': \{/, 'a mistyped title can still only be fixed by withdrawing the item');
    assert.match(page, /label: 'Correct a title or a date'/);
  });
});
