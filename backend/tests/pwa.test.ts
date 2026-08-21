import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { FIELD_FORBIDDEN_EVENTS } from '../src/field/sync.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The installed field application.
 *
 * The manifest and service worker made the console installable. What made it a
 * *field* application is the outbox: a supervisor at the bottom of a shaft with
 * no signal needs the record made now, at the time the work happened, and
 * reconciled later. The sync engine was built for exactly that and until now
 * nothing in the browser fed it.
 *
 * These tests cover the two things that go wrong quietly.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

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

describe('installability', () => {
  it('declares a manifest scoped to the application, not the marketing site', () => {
    const manifest = JSON.parse(read('frontend', 'manifest.webmanifest'));

    assert.equal(manifest.scope, '/app', 'a manifest scoped to / would install the public site');
    assert.equal(manifest.start_url, '/app');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.length >= 2, 'an installed application needs an icon at both sizes');
    assert.ok(
      manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable'),
      'without a maskable icon Android crops the logo into its own shape',
    );
  });

  it('ships every icon the manifest promises', () => {
    // A manifest listing a file that is not there installs with a blank tile,
    // and nothing warns you — the install simply looks wrong on the home screen.
    const manifest = JSON.parse(read('frontend', 'manifest.webmanifest'));
    for (const icon of manifest.icons as Array<{ src: string }>) {
      assert.doesNotThrow(
        () => readFileSync(join(REPO_ROOT, 'frontend', icon.src)),
        `${icon.src} is in the manifest and not in the build`,
      );
    }
  });
});

describe('the service worker never caches a response that belongs to one identity', () => {
  const worker = read('frontend', 'sw.js');

  it('refuses the whole API surface', () => {
    // The failure this prevents: one person's commercial position served to
    // whoever opens the application on that handset next. There is no partial
    // version of this rule that is safe.
    assert.match(worker, /pathname\.startsWith\('\/v1\/'\)/);
  });

  it('precaches only files that are identical for every user', () => {
    const shell = [...worker.matchAll(/^\s*'(\/[^']*)',$/gm)].map((m) => m[1]!);
    assert.ok(shell.length > 0, 'the shell list could not be read — check the pattern, not the worker');
    for (const path of shell) {
      assert.ok(!path.startsWith('/v1/'), `${path} is precached and is API data`);
    }
  });

  it('prefers the network for navigations, so a deployed fix reaches a handset', () => {
    assert.match(worker, /request\.mode === 'navigate'/);
  });
});

describe('the outbox', () => {
  const outbox = read('frontend', 'lib', 'outbox.js');

  it('does not declare which events are forbidden offline — it is told', () => {
    // The first version of this file hardcoded eight plausible-looking event
    // names and every one was wrong. Settled decision 6: the interface holds no
    // rule the API does not publish.
    assert.ok(
      !/PROGRAMME_BASELINE_APPROVED|RFQ_AWARDED|INVOICE_ISSUED/.test(outbox),
      'the forbidden-event list has been copied into the browser again',
    );
    assert.match(outbox, /useNeverOffline/);
  });

  it('is fed the server’s own list, over HTTP, so the two cannot drift', async () => {
    // Read the way the browser reads it rather than by importing the constant.
    // The failure this catches is the endpoint quietly ceasing to publish the
    // field — which importing the constant would hide completely.
    const pm = platform.user(seed.users.pm!.id);
    const token = issueTokens({
      actorId: pm.id,
      tenantId: pm.tenantId,
      partyId: pm.partyId,
      roles: pm.roles,
      mfaSatisfied: true,
    }).accessToken;

    const response = await fetch(`${base}/v1/permissions/matrix`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);

    const { neverOffline } = (await response.json()) as { neverOffline: string[] };
    assert.ok(Array.isArray(neverOffline), 'the matrix stopped publishing neverOffline');
    assert.deepEqual(
      [...neverOffline].sort(),
      [...FIELD_FORBIDDEN_EVENTS].sort(),
      'what is published and what is enforced have diverged',
    );
    assert.ok(neverOffline.includes('PROGRAMME_BASELINE_APPROVED'));
  });

  it('stamps PWA, never a native source it is not', () => {
    // A browser claiming ANDROID would put a false provenance into a ledger
    // that cannot afterwards be corrected.
    assert.match(outbox, /source: 'PWA'/);
    assert.ok(!/source: '(ANDROID|IOS)'/.test(outbox), 'the outbox claims to be a native client');
  });

  it('keeps an operation the server did not decide about', () => {
    // A transport failure is not a verdict. Dropping an operation because the
    // request failed is how a site record silently loses a day.
    assert.match(outbox, /unsent \+= operations\.length/);
  });

  it('clears on sign-out, because a site handset changes hands', () => {
    assert.match(outbox, /export async function clear/);
    // Including the held files. A photograph captured under one operative's
    // session must not flush under the next person's token.
    assert.match(outbox, /store\.clear\(\), FILES/);
  });

  it('holds the file, not only the hash it computed from it', () => {
    // Queuing the operation without the bytes leaves the field app exactly
    // where the platform was before the object store existed: a hash captured
    // at a work face, and the photograph on a handset that may not survive to
    // see signal again.
    assert.match(outbox, /export async function queueFile/);
    assert.match(outbox, /export async function flushFiles/);
    // The Blob itself. Base64 in a data URL is a third larger for no gain.
    assert.match(outbox, /blob: file/);
  });

  it('keeps a file whose record has not landed yet, and drops one that can never match', () => {
    // A 404 means no ledger record names this hash *yet* — the record may be in
    // the next batch, so the file waits. A 422 means the bytes do not hash to
    // the address they claim, which cannot become true later.
    assert.match(outbox, /error\?\.status === 422/);
    assert.match(outbox, /waiting \+= 1/);
  });
});

describe('PWA as a first-class event source', () => {
  it('is a source the ledger will accept', () => {
    const context = platform.context(seed.users.pm!.auth, seed.projectId, { source: 'PWA' });
    assert.equal(context.source, 'PWA');
  });

  it('is separate from WEB, because a desk and a work face are different evidence', () => {
    const types = read('backend', 'src', 'goldenthread', 'types.ts');
    assert.match(types, /'WEB' \| 'PWA'/);
  });

  it('is accepted for an offline batch, and WEB is not', () => {
    // Typed rather than runtime-checked: `SyncOperation.source` excludes WEB, so
    // this asserts the type surface rather than a branch. Allowing WEB would let
    // an online client backdate work through deviceTimestamp with none of the
    // offline provenance that justifies the backdating.
    const sync = read('backend', 'src', 'field', 'sync.ts');
    assert.match(sync, /Extract<EventSource, 'PWA' \| 'ANDROID' \| 'IOS'>/);
  });
});
