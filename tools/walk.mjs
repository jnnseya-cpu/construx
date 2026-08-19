/**
 * Browser verification tool.
 *
 * `playwright-core` is deliberately NOT in package.json: dev dependencies are
 * TypeScript and @types/node only, and that is a settled decision. This is a
 * verification utility rather than part of the platform, so it asks for the
 * package when it needs one instead of making everyone carry it.
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
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const ALL = ['overview','copilot','autopilot','enterprise','pipeline','programme','field','design','commercial','procurement','contracts','control','risk','handover','audit','billing','admin','newsletter'];
const BASE = process.env.WALK_BASE ?? 'http://localhost:8123';
const ROLE = process.argv[2] ?? 'Project Manager';
const PAGES = process.argv[3] ? process.argv[3].split(',') : ALL;
const SHOT = process.argv[4] === 'shots';
/** Prefix so a second role's capture does not overwrite the first's. */
const PREFIX = process.argv[5] ? `${process.argv[5]}-` : '';

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const p = await b.newPage({ viewport: { width: 1560, height: 1000 }, deviceScaleFactor: SHOT ? 2 : 1 });
const errors = [];
p.on('pageerror', e => errors.push(`PAGEERROR ${e.message}`));
p.on('console', m => { if (m.type()==='error' && !m.text().includes('favicon')) errors.push(`CONSOLE ${m.text()}`); });

await p.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.identity', { timeout: 40000 });
if (SHOT) await p.screenshot({ path: `web/shots/${PREFIX}00-login.png` });
await p.locator('.identity', { hasText: ROLE }).first().click();
await p.waitForSelector('.sidebar', { timeout: 20000 });
await p.waitForTimeout(2200);
log(`signed in as ${ROLE}\n`);

let index = 1;
for (const page of PAGES) {
  // Navigate inside the app rather than reloading it — this is the real path a
  // user takes, and it does not rebuild the whole shell each time.
  const clicked = await p.evaluate((id) => {
    const button = document.querySelector(`[data-nav="${id}"]`);
    if (!button) return false;
    button.click();
    return true;
  }, page);

  let status = clicked ? 'ok' : 'LOCKED';
  if (clicked) {
    try { await p.waitForSelector('.view-head h1, .notice.err', { timeout: 15000 }); }
    catch { status = 'TIMEOUT'; }
    await p.waitForTimeout(page === 'copilot' ? 2200 : 1100);
  }

  // Read through count() first. `locator.textContent()` auto-waits for the
  // element and only rejects at the default 30s timeout, so probing for
  // something that is legitimately absent — an error notice on a page that
  // worked — used to cost 30 seconds per page and made a full walk look hung.
  const text = async (selector) =>
    (await p.locator(selector).count()) > 0
      ? ((await p.locator(selector).first().textContent({ timeout: 2000 }).catch(() => '')) ?? '')
      : null;

  const h1 = (await text('.view-head h1')) ?? '';
  const err = await text('.notice.err');
  const cards = await p.locator('.card').count();
  const tables = await p.locator('table').count();
  const empties = await p.locator('.empty').count();
  log(`${page.padEnd(12)} ${status.padEnd(7)} h1="${h1.trim().slice(0,26).padEnd(26)}" cards=${String(cards).padStart(2)} tables=${tables} empty=${empties}${err ? ` ERR="${err.trim().replace(/\s+/g,' ').slice(0,80)}"` : ''}`);

  if (SHOT && clicked) {
    await p.screenshot({ path: `web/shots/${PREFIX}${String(index).padStart(2,'0')}-${page}.png` });
  }
  index += 1;
}

log('\n--- js errors ---');
log(errors.length ? [...new Set(errors)].slice(0,10).join('\n') : 'none');
await b.close();
