/**
 * The field outbox, driven in a real browser.
 *
 * `frontend/lib/outbox.js` is the one load-bearing path with no executable
 * coverage. The backend suite proves the *server* half of resumable upload
 * thoroughly — parts, checksums, resume, abandon, sweep — and reads the
 * frontend only as text, for the doors and bindings invariants. Nothing runs
 * it. So the code that decides whether a supervisor's photograph survives a
 * dropped connection was, until this tool, reasoned about rather than observed.
 *
 * It cannot be a `node --test` file. The outbox is IndexedDB, `Blob.slice`,
 * `crypto.subtle` and `fetch` against a live session — four things that exist
 * in a browser and not in Node — and a stubbed version of any of them would be
 * testing the stub. So this drives Chromium against a real gateway, imports the
 * real module, and asserts on what the server ends up holding.
 *
 * `playwright-core` is deliberately NOT in package.json — dev dependencies are
 * TypeScript and @types/node only, and that is a settled decision. Same
 * arrangement as `tools/walk.mjs`: a verification utility asks for its driver
 * rather than making everyone carry it.
 *
 *   npm install --no-save playwright-core
 *   node tools/outbox.mjs
 *
 * Exit 0 means the path works end to end. Anything else names what failed.
 */

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  process.stderr.write(
    'This tool needs a browser driver, which is not a project dependency.\n' +
      '  npm install --no-save playwright-core\n' +
      'Chromium itself is already present at /opt/pw-browsers.\n',
  );
  process.exit(1);
}

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from 'node:net';

/**
 * A port the kernel says is free, rather than a fixed one.
 *
 * A fixed port means a stray server from a previous run answers the readiness
 * probe, the drill believes it is up, and then talks to the wrong process — or
 * to nothing, once the orphan is reaped. Asking for port 0 and reading back
 * what was allocated removes the whole class.
 */
const PORT = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), 'construx-outbox-drill-'));

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);
const failures = [];
function check(condition, what) {
  if (condition) log(`  ok   ${what}`);
  else {
    log(`  FAIL ${what}`);
    failures.push(what);
  }
}

// ---------------------------------------------------------------- the server

log(`booting the gateway on ${PORT}`);
const server = spawn(process.execPath, ['backend/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: 'development',
    DEMO_TENANCY_ENABLED: 'true',
    // A real volume, so evidence and its parts are stored the way a deployment
    // stores them rather than through a path that only exists in a test.
    LEDGER_JOURNAL_PATH: join(scratch, 'ledger.jsonl'),
    EVIDENCE_STORE_PATH: join(scratch, 'evidence'),
    SITE_MEDIA_PATH: join(scratch, 'site-media'),
    GATEWAY_JWT_SECRET: 'outbox-drill-secret-not-a-real-one',
    AI_MODE: 'local',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLog = '';
server.stdout.on('data', (chunk) => {
  bootLog += chunk;
});
server.stderr.on('data', (chunk) => {
  bootLog += chunk;
});

async function waitForReady(seconds = 120) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${BASE}/readyz`);
      if (response.ok || response.status === 503) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  server.kill('SIGTERM');
  rmSync(scratch, { recursive: true, force: true });
};
// Whatever happens below — a timeout, a selector that no longer matches, an
// assertion that throws — the gateway is not left running. The first version of
// this tool left one behind on its first failure, and the next run then probed
// the orphan, believed it was up, and failed somewhere far from the cause.
process.on('exit', stop);
process.on('uncaughtException', (error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  stop();
  process.exit(1);
});

if (!(await waitForReady())) {
  process.stderr.write(`the gateway did not come up:\n${bootLog.slice(-3000)}\n`);
  stop();
  process.exit(1);
}
log('gateway up\n');

// --------------------------------------------------------------- the browser

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(`PAGEERROR ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) {
    pageErrors.push(`CONSOLE ${message.text()}`);
  }
});

if (server.exitCode !== null) {
  process.stderr.write(`the gateway exited with ${server.exitCode}:\n${bootLog.slice(-3000)}\n`);
  await browser.close();
  stop();
  process.exit(1);
}

await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.identity', { timeout: 60_000 });
// By email, not by the role label beside it. `PM` today was `Project Manager`
// when `tools/walk.mjs` was written, and that default has been silently
// selecting nothing ever since — a display string is not an identifier.
await page.locator('.identity', { hasText: 'pm@meridian.example' }).first().click();
await page.waitForSelector('.sidebar', { timeout: 30_000 });
log('signed in\n');

/**
 * Everything below runs *in the page*, against the real module.
 *
 * The blobs are built in the browser so `Blob.slice` is the browser's own, and
 * the transports handed to `flushFiles` are the same two the application hands
 * it in `app.js` — a wrapper that changes either would be testing the wrapper.
 */
const result = await page.evaluate(async () => {
  const { api, hashFile } = await import('/lib/api.js');
  const outbox = await import('/lib/outbox.js');

  const out = { steps: [], chunkBytes: outbox.CHUNK_BYTES };
  const say = (name, value) => out.steps.push({ name, value });

  // The project in CONSTRUCTION, chosen by phase rather than by position.
  //
  // Field capture is phase-gated: the seed's first project has reached
  // OPERATIONS and the platform correctly refuses `FIELD_EXECUTION cannot be
  // written during the OPERATIONS phase`. Taking `[0]` made this drill depend
  // on the order the seed happens to build in, which is exactly the kind of
  // accident that makes a verification tool fail for a reason unrelated to what
  // it verifies.
  const all = await api.get('/v1/projects');
  const projects = all.projects ?? all;
  const onSite = projects.find((project) => (project.phase ?? project.currentPhase) === 'CONSTRUCTION');
  if (!onSite) throw new Error(`no project is in CONSTRUCTION: ${projects.map((p) => p.phase).join(', ')}`);
  const projectId = onSite.id;
  say('projectId', projectId);
  say('projectName', onSite.name);

  /**
   * Bytes that compress badly, so the part count is honest.
   *
   * The seed is a parameter and not a constant, which the first version of this
   * got wrong: two files generated from the same seed are byte-identical, hash
   * to the same address, and the second one is therefore *already stored*. The
   * resume case then reported nothing held, nothing missing and a complete
   * upload — four confusing failures that were all one mistake in the fixture.
   */
  const noisy = (size, seedValue) => {
    const bytes = new Uint8Array(size);
    let seed = seedValue;
    for (let index = 0; index < size; index += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      bytes[index] = seed & 0xff;
    }
    return new Blob([bytes], { type: 'audio/webm' });
  };

  const upload = (path, blob) => api.upload(path, blob);
  const state = (path) => api.get(path);

  /** Register the hash the way the field screen does, then hold the bytes. */
  const fileIt = async (blob) => {
    const hash = await hashFile(blob);
    await api.post(`/v1/projects/${projectId}/field/recordings`, {
      hash,
      description: 'Outbox verification recording, captured with no signal at the work face.',
    });
    await outbox.queueFile(blob, projectId);
    return hash;
  };

  // --- 1. a large file goes up in parts and completes ----------------------
  const big = noisy(5 * 1024 * 1024, 0x2545f491);
  const bigHash = await fileIt(big);
  say('bigBytes', big.size);
  say('queued', (await outbox.pendingFiles()).length);

  const flushed = await outbox.flushFiles(upload, { state });
  say('flush', flushed);

  const afterBig = await api.get(`/v1/evidence/${encodeURIComponent(bigHash)}/chunks`);
  say('bigComplete', afterBig.complete);
  say('bigLeftQueued', (await outbox.pendingFiles()).length);

  // The register is what a person reads, so assert on that too and not only on
  // the upload's own answer.
  const register = await api.get(`/v1/projects/${projectId}/evidence`);
  const entry = (register.entries ?? []).find((row) => row.hash === bigHash);
  say('bigHeldInRegister', Boolean(entry && entry.held));

  // --- 2. a connection that dies mid-upload resumes ------------------------
  const second = noisy(5 * 1024 * 1024, 0x9e3779b9);
  const secondHash = await fileIt(second);
  say('distinctFromFirst', secondHash !== bigHash);

  // Fail after the first part has landed: exactly a phone losing signal
  // between chunks. The failure is thrown from the transport, so the outbox
  // sees what it would see on a real drop.
  let sent = 0;
  const dropsAfterOne = async (path, blob) => {
    if (sent >= 1) throw Object.assign(new Error('Network unreachable'), { status: 0 });
    sent += 1;
    return upload(path, blob);
  };

  let dropped;
  try {
    dropped = await outbox.flushFiles(dropsAfterOne, { state });
  } catch (error) {
    dropped = { threw: String(error) };
  }
  say('afterDrop', dropped);

  const mid = await api.get(`/v1/evidence/${encodeURIComponent(secondHash)}/chunks`);
  say('midHeld', mid.held);
  say('midMissing', mid.missing);
  say('midComplete', mid.complete);
  say('midStillQueued', (await outbox.pendingFiles()).length);

  // --- 3. the next flush resumes rather than restarting --------------------
  let secondRunUploads = 0;
  const counting = async (path, blob) => {
    secondRunUploads += 1;
    return upload(path, blob);
  };
  const resumed = await outbox.flushFiles(counting, { state });
  say('resumed', resumed);
  say('partsSentOnResume', secondRunUploads);
  say('partsHeldBeforeResume', (mid.held ?? []).length);

  const afterResume = await api.get(`/v1/evidence/${encodeURIComponent(secondHash)}/chunks`);
  say('secondComplete', afterResume.complete);
  say('secondLeftQueued', (await outbox.pendingFiles()).length);

  // --- 4. a small file still goes whole ------------------------------------
  const small = noisy(64 * 1024, 0x85ebca6b);
  const smallHash = await fileIt(small);
  const smallFlush = await outbox.flushFiles(upload, { state });
  say('smallFlush', smallFlush);
  const smallState = await api.get(`/v1/evidence/${encodeURIComponent(smallHash)}/chunks`);
  say('smallComplete', smallState.complete);

  return out;
});

// ----------------------------------------------------------------- assertions

const step = (name) => result.steps.find((entry) => entry.name === name)?.value;

log('a file larger than the chunk threshold');
check(step('queued') === 1, 'it is held on the device before any upload');
check(step('flush')?.stored === 1, 'the flush reports it stored');
check(step('bigComplete') === true, 'the platform holds every part and the object');
check(step('bigLeftQueued') === 0, 'it is cleared off the device');
check(step('bigHeldInRegister') === true, 'the evidence register shows the file as held');

log('\na connection that dies between parts');
check(step('distinctFromFirst') === true, 'the second file is a different file from the first');
const midHeld = step('midHeld') ?? [];
const midMissing = step('midMissing') ?? [];
check(step('midComplete') === false, 'the upload is not complete');
check(midHeld.length >= 1, `the parts that did arrive are still held (${midHeld.length})`);
check(midMissing.length >= 1, `the platform names the parts still to come (${midMissing.join(', ')})`);
check(step('midStillQueued') === 1, 'the file is KEPT on the device, not discarded');

log('\nthe next flush resumes rather than restarting');
const sentOnResume = step('partsSentOnResume') ?? 0;
const heldBefore = step('partsHeldBeforeResume') ?? 0;
check(step('secondComplete') === true, 'the upload completes');
check(step('secondLeftQueued') === 0, 'the file is cleared off the device');
check(
  sentOnResume === midMissing.length,
  `only the missing parts were sent (${sentOnResume} sent, ${midMissing.length} missing, ${heldBefore} already held)`,
);

log('\na file below the threshold');
check(step('smallFlush')?.stored === 1, 'it is stored');
check(step('smallComplete') === true, 'the platform holds it');

log('\nthe page itself');
check(pageErrors.length === 0, `no console or page errors${pageErrors.length ? `:\n    ${pageErrors.join('\n    ')}` : ''}`);

await browser.close();
stop();

log('');
if (failures.length > 0) {
  log(`${failures.length} failed:`);
  for (const failure of failures) log(`  - ${failure}`);
  process.exit(1);
}
log('outbox verified end to end in a real browser');
