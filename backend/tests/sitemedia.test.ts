import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { landing } from '../src/site/landing.ts';
import { MEDIA_SLOTS, mediaDir, putSlotImage, refreshMedia, removeSlotImage, slotFile } from '../src/site/media.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';
import { completeSignIn } from './helpers.ts';

/**
 * Putting a picture on the landing page.
 *
 * Five slots have been on that page since it was built and could only be filled
 * by copying a file into the checkout and restarting — a rebuild on a deployed
 * container, which meant in practice they could not be filled at all.
 *
 * The route that closes that writes a file into a directory the web server
 * serves, which is the shape of a remote code execution, so most of this file
 * is about what it refuses. Two properties carry it and both are asserted
 * below: **the caller never supplies the path**, because the slot must match one
 * of five literals; and **the caller never supplies the type**, because the
 * extension comes from the file's own first bytes and an SVG — a document that
 * can carry script, served from the platform's own origin — is refused outright.
 */

let server: Server;
let base: string;
let platform: Platform;
let directory: string;
let previousPath: string | undefined;

/** The smallest real PNG: an 8-byte signature is what the check reads. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('IHDR-and-the-rest-of-a-file-nobody-decodes-here'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF and pixels')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

before(async () => {
  previousPath = process.env.SITE_MEDIA_PATH;
  // Never the checkout: these tests write and delete, and the repository's own
  // frontend/media is not a scratch directory.
  directory = mkdtempSync(join(tmpdir(), 'construx-media-'));
  process.env.SITE_MEDIA_PATH = directory;
  refreshMedia();

  platform = new Platform();
  await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
  if (previousPath === undefined) delete process.env.SITE_MEDIA_PATH;
  else process.env.SITE_MEDIA_PATH = previousPath;
  refreshMedia();
});

beforeEach(() => {
  for (const entry of readdirSync(directory)) rmSync(join(directory, entry), { force: true });
  refreshMedia();
});

/** A GET whose path reaches the server exactly as written, `..` and all. */
function rawGet(path: string): Promise<number> {
  const { port } = server.address() as { port: number };
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('error', reject);
    request.end();
  });
}

function throwsWith(run: () => unknown, code: string): { code?: string; message?: string } {
  try {
    run();
  } catch (error) {
    const problem = error as { code?: string; message?: string };
    assert.equal(problem.code, code, `expected ${code}, got ${problem.code}: ${problem.message}`);
    return problem;
  }
  assert.fail(`expected ${code}, nothing was thrown`);
}

describe('what a landing slot accepts', () => {
  it('stores a picture under the slot name, with the extension the bytes prove', () => {
    assert.equal(putSlotImage('founder', PNG).file, 'founder.png');
    assert.equal(putSlotImage('command-centre', JPEG).file, 'command-centre.jpg');
    assert.equal(putSlotImage('broken-workflows', WEBP).file, 'broken-workflows.webp');
  });

  it('refuses a slot that is not one of the five, so no caller ever supplies a path', () => {
    throwsWith(() => putSlotImage('not-a-slot', PNG), 'NO_SUCH_SLOT');
    // The two shapes a traversal takes, both refused by the same rule: the id
    // is compared against a fixed list rather than sanitised.
    throwsWith(() => putSlotImage('../../frontend/app', PNG), 'NO_SUCH_SLOT');
    throwsWith(() => putSlotImage('founder/../../sw', PNG), 'NO_SUCH_SLOT');
    assert.deepEqual(readdirSync(directory), []);
  });

  it('refuses an SVG, because this directory is served from the platform’s own origin', () => {
    const error = throwsWith(() => putSlotImage('founder', SVG), 'NOT_AN_IMAGE');
    assert.match(String(error.message), /SVG/);
    assert.equal(slotFile('founder'), undefined);
  });

  it('refuses a file whose bytes are not an image, whatever it claims to be', () => {
    throwsWith(() => putSlotImage('founder', Buffer.from('#!/bin/sh\nrm -rf /\n')), 'NOT_AN_IMAGE');
    throwsWith(() => putSlotImage('founder', Buffer.from('<!doctype html><script>x</script>')), 'NOT_AN_IMAGE');
    throwsWith(() => putSlotImage('founder', Buffer.alloc(0)), 'EMPTY_UPLOAD');
  });

  it('refuses a picture over the ceiling, so the marketing page cannot fill the volume', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(9 * 1_048_576)]);
    const error = throwsWith(() => putSlotImage('founder', huge), 'IMAGE_TOO_LARGE');
    assert.match(String(error.message), /ceiling/);
  });

  it('leaves one file per slot when the type changes, not two', () => {
    putSlotImage('founder', PNG);
    assert.equal(slotFile('founder'), 'founder.png');

    putSlotImage('founder', JPEG);
    assert.equal(slotFile('founder'), 'founder.jpg');
    // The PNG would otherwise still be there, and the page renders whichever
    // the signature order finds first — which would be the replaced one.
    assert.deepEqual(readdirSync(directory), ['founder.jpg']);
  });

  it('empties a slot back to rendering nothing at all', () => {
    putSlotImage('founder', PNG);
    assert.equal(removeSlotImage('founder').removed, true);
    assert.equal(slotFile('founder'), undefined);
    // Removing an empty slot is not an error; it is already in the state asked for.
    assert.equal(removeSlotImage('founder').removed, false);
    throwsWith(() => removeSlotImage('not-a-slot'), 'NO_SUCH_SLOT');
  });
});

describe('what the landing page does with them', () => {
  it('renders nothing for an empty slot — no frame, no broken icon', () => {
    const page = landing();
    assert.ok(!page.includes('<figure'), 'an empty slot reserved space on the page');
  });

  it('renders the picture the moment it is uploaded, with no restart', () => {
    // The bug this replaced: presence was read once at module load, so a file
    // added to a running deployment never appeared.
    putSlotImage('founder', PNG);
    const page = landing();
    assert.ok(page.includes('src="/media/founder.png"'), page.slice(0, 200));
    assert.ok(page.includes('Justin Nseya'), 'the slot’s alt text did not follow the picture');
  });

  it('carries the declared dimensions, so the page does not reflow as the bytes land', () => {
    putSlotImage('command-centre', JPEG);
    const slot = MEDIA_SLOTS.find((candidate) => candidate.id === 'command-centre')!;
    const page = landing();
    assert.ok(page.includes(`width="${slot.width}" height="${slot.height}"`));
  });

  it('takes the picture off the page when the slot is emptied', () => {
    putSlotImage('founder', PNG);
    assert.ok(landing().includes('/media/founder.png'));
    removeSlotImage('founder');
    assert.ok(!landing().includes('/media/founder.png'));
  });
});

describe('who may change them', () => {
  async function token(email: string): Promise<string> {
    const login = (await (
      await fetch(`${base}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    ).json()) as { devCode: string; challengeId: string; actorId: string };

    const verified = (await (
      await fetch(`${base}/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actorId: login.actorId, challengeId: login.challengeId, code: login.devCode }),
      })
    ).json()) as Record<string, unknown>;

    return completeSignIn(base, verified);
  }

  it('refuses a customer, because the marketing site is not their tenancy’s', async () => {
    const bearer = await token('amara.osei@meridian.example');
    for (const [method, path] of [
      ['GET', '/v1/site/media'],
      ['POST', '/v1/site/media/founder'],
      ['DELETE', '/v1/site/media/founder'],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'image/png' },
        ...(method === 'POST' ? { body: PNG } : {}),
      });
      assert.equal(response.status, 403, `${method} ${path}`);
      const problem = (await response.json()) as { title?: string };
      assert.equal(problem.title, 'PLATFORM_ADMIN_REQUIRED', `${method} ${path}`);
    }
  });

  it('refuses an anonymous caller outright', async () => {
    const response = await fetch(`${base}/v1/site/media/founder`, { method: 'POST', body: PNG });
    assert.equal(response.status, 401);
    assert.equal(slotFile('founder'), undefined);
  });

  it('lets the operator put a picture up, and the site serves it back', async () => {
    const bearer = await token('operator@construx.example');

    const put = await fetch(`${base}/v1/site/media/founder`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'image/png' },
      body: PNG,
    });
    const body = await put.json();
    assert.equal(put.status, 201, JSON.stringify(body));
    assert.deepEqual(body, {
      slot: 'founder',
      file: 'founder.png',
      contentType: 'image/png',
      bytes: PNG.length,
    });

    // The whole point: served back over HTTP, from wherever it was configured
    // to live, without a restart in between.
    const served = await fetch(`${base}/media/founder.png`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);

    const state = (await (
      await fetch(`${base}/v1/site/media`, { headers: { authorization: `Bearer ${bearer}` } })
    ).json()) as { directory: string; slots: Array<{ id: string; held: boolean }> };
    assert.equal(state.directory, mediaDir());
    assert.equal(state.slots.length, MEDIA_SLOTS.length);
    assert.equal(state.slots.find((slot) => slot.id === 'founder')?.held, true);
    assert.equal(state.slots.find((slot) => slot.id === 'command-centre')?.held, false);
  });

  it('will not read a file from outside the roots it serves', async () => {
    // Raw requests, not `fetch`: `fetch` collapses `..` in the URL before the
    // bytes leave the process, so a traversal written that way tests the client
    // rather than the server. These go on the wire exactly as written.
    //
    // What is asserted is containment, not a 404 for anything containing `..`.
    // `/media/../app.js` resolves to the console's own JavaScript inside the web
    // root and is served, which is correct — it is a public asset either way.
    // Escaping the roots is the thing that must never work.
    for (const path of [
      '/media/../../package.json',
      '/media/../../backend/src/config.ts',
      '/media/../../../etc/passwd',
      '/media/%2e%2e%2f%2e%2e%2fpackage.json',
      '/media/..%2F..%2F.env',
    ]) {
      assert.notEqual(await rawGet(path), 200, path);
    }
  });

  it('serves nothing for a slot with no picture, rather than an empty body', async () => {
    const response = await fetch(`${base}/media/founder.png`);
    assert.equal(response.status, 404);
  });
});

describe('the registry itself', () => {
  it('is the only list of slots, so the page and the route cannot disagree', () => {
    assert.equal(MEDIA_SLOTS.length, 5);
    for (const slot of MEDIA_SLOTS) {
      assert.match(slot.id, /^[a-z][a-z-]*[a-z]$/, `${slot.id} is not a safe filename base`);
      assert.ok(slot.alt.length > 20, `${slot.id} has no usable alt text`);
      assert.ok(slot.where.length > 10, `${slot.id} does not say where it lands`);
      assert.ok(slot.width > 0 && slot.height > 0);
    }
  });

  it('picks up a file put there by hand, which is how it used to be done', () => {
    // The old way still works — this is a widening, not a replacement, and a
    // deployment that already has files in the directory keeps them.
    writeFileSync(join(directory, 'visibility-control.png'), PNG);
    refreshMedia();
    assert.equal(slotFile('visibility-control'), 'visibility-control.png');
  });
});
