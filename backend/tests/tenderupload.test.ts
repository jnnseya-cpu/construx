import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { ingestedFiles } from '../src/evidence/pipeline.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import * as structure from '../src/domain/structure.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * A tender document is read the moment its bytes arrive.
 *
 * Found in a browser run with the real Conwy tender: five files uploaded, and
 * none of them read until somebody pressed "Look at the file first" on each
 * row — a button the screen only shows where a perception provider is
 * configured. With no provider the files sat there unread, and the matrix,
 * the returns and the plan all said "read the invitation first". Reading a
 * file (`ingestFile`) is the free, deterministic stage — inspection,
 * classification, text — so it now runs on arrival for a TENDER_DOCUMENT.
 * Other evidence is untouched, and a refusal to read never fails the upload.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
const directory = mkdtempSync(join(tmpdir(), 'construx-tender-upload-'));

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({ actorId: user.id, tenantId: user.tenantId, partyId: user.partyId, roles: user.roles, mfaSatisfied: true }).accessToken;
}

/** The project a tender sits on — the sibling parked at Tender. */
const tenderProject = () => seed.workingProjects.find((project) => project.phase === 'TENDER')!.projectId;

function register(hash: string, type: string, description: string): void {
  const ctx = platform.context(seed.users.owner!.auth, tenderProject(), { source: 'WEB' });
  ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: 'WEB',
    correlationId: ctx.correlationId,
    eventType: 'EVIDENCE_REGISTERED',
    entity: { refType: 'EvidenceItem', refId: `ev-${hash.slice(-12)}` },
    nextState: { id: `ev-${hash.slice(-12)}`, type, hash, description, linkedEntities: [], capturedAt: new Date().toISOString() },
  });
}

async function upload(bytes: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(hashBytes(bytes))}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor('owner')}`, 'content-type': 'text/plain' },
    body: bytes,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
  platform = new Platform(undefined, new EvidenceStore(join(directory, 'store')));
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('a tender document is read when it is uploaded', () => {
  const itt = Buffer.from(
    'INVITATION TO TENDER\nERCF2509N 05 Waterloo Cottage Retaining Wall\nTenders must be returned by 12:00 on 19 November 2026.\n' +
      'Quality 40% Price 60%.\nQ1 Methodology (10%) maximum 1,000 words.\n',
    'utf8',
  );

  it('reads a TENDER_DOCUMENT on arrival and says so in the upload response', async () => {
    register(hashBytes(itt), 'TENDER_DOCUMENT', 'Tender document: ITT Waterloo Cottage.txt');
    const stored = await upload(itt);
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    const reading = stored.body.reading as Record<string, unknown> | undefined;
    assert.ok(reading, `the upload did not read the file: ${JSON.stringify(stored.body)}`);
    assert.equal(typeof reading.ingestionId, 'string');

    const ctx = platform.context(seed.users.owner!.auth, tenderProject(), { source: 'WEB' });
    const file = ingestedFiles(ctx).find((held) => held.hash === hashBytes(itt));
    assert.ok(file, 'the reading is not on the file register');
    assert.equal(file.filename, 'ITT Waterloo Cottage.txt', 'the filename comes from the registration, without its "Tender document:" prefix');
  });

  it('leaves other evidence unread — the stage runs for tender documents only', async () => {
    const photo = Buffer.from('site diary note, not a tender document', 'utf8');
    register(hashBytes(photo), 'SITE_DIARY', 'Diary note');
    const stored = await upload(photo);
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    assert.equal(stored.body.reading, undefined);
    assert.equal(stored.body.readingRefused, undefined);
  });

  it('a refusal to read is reported beside a stored upload, never in place of it', async () => {
    // The same bytes again: stored (content-addressed, idempotent), and the
    // reading refuses because those bytes were read already.
    const again = await upload(itt);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const refused = again.body.readingRefused as Record<string, unknown> | undefined;
    assert.ok(refused, JSON.stringify(again.body));
    assert.equal(refused.code, 'ALREADY_INGESTED');
  });

  it('reads the same file on a second project that files it, not only on the first', async () => {
    // The same pack going to a second lot. The upload's record is found by
    // hash across the tenancy, which is the first project's; the reading used
    // to run there, be refused as already read, and leave the second project
    // with the file stored and never read.
    const admin = seed.users.admin!.auth;
    const portfolioId = platform.ledger.listByTenant(seed.tenantId, 'Portfolio')[0]!.refId;
    const second = structure.createProject(platform.context(admin, `${seed.tenantId}-governance`), {
      portfolioId,
      name: 'Waterloo Cottage — lot 2',
      sectorType: 'TRANSPORT',
      assetType: 'Retaining wall',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Conwy' },
      contractValueMinor: 0,
      currency: 'GBP',
      plannedStart: '2027-01-18',
      plannedCompletion: '2027-04-09',
      startingPhase: 'TENDER',
      startingPhaseReason: 'Same pack, second lot',
    }).projectId;
    const onSecond = platform.context(seed.users.owner!.auth, second, { source: 'WEB' });
    tenderintake.recordTenderDocument(onSecond, { hash: hashBytes(itt), filename: 'ITT Waterloo Cottage.txt' });

    const stored = await upload(itt);
    assert.equal(stored.status, 201, JSON.stringify(stored.body));
    assert.ok(stored.body.reading, `the second project's filing was not read: ${JSON.stringify(stored.body)}`);
    assert.ok(ingestedFiles(onSecond).some((held) => held.hash === hashBytes(itt)), 'read on the second project');
    const first = platform.context(seed.users.owner!.auth, tenderProject(), { source: 'WEB' });
    assert.equal(ingestedFiles(first).filter((held) => held.hash === hashBytes(itt)).length, 1, 'the first project still holds one reading');
  });
});
