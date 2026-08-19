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
const ROLE = process.argv[2] ?? 'Project Manager';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu'] });
const p = await b.newPage({ viewport: { width: 1560, height: 1000 } });
const errors = []; p.on('pageerror', e => errors.push(`PAGEERROR ${e.message}`));
await p.goto('http://localhost:8123/app', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.identity', { timeout: 40000 });
await p.locator('.identity', { hasText: ROLE }).first().click();
await p.waitForSelector('.sidebar', { timeout: 20000 });
await p.waitForTimeout(2000);
log(`signed in as ${ROLE}\n`);
let commands = 0, locked = 0, inputs = 0;
for (const page of ['overview','field','design','commercial','procurement','contracts','risk','handover','programme']) {
  const clicked = await p.evaluate((id) => { const el = document.querySelector(`[data-nav="${id}"]`); if (!el) return false; el.click(); return true; }, page);
  if (!clicked) { log(`${page.padEnd(12)} LOCKED`); continue; }
  await p.waitForSelector('.view-head h1, .notice.err', { timeout: 15000 }).catch(()=>{});
  await p.waitForTimeout(1100);
  const c = await p.locator('[data-command]').count();
  const l = await p.locator('.btn.locked').count();
  const i = await p.locator('input, select, textarea').count();
  commands += c; locked += l; inputs += i;
  log(`${page.padEnd(12)} commands=${String(c).padStart(2)} locked=${String(l).padStart(2)} inputs=${String(i).padStart(2)}`);
}
log(`\ntotal        commands=${commands} locked=${locked} inputs=${inputs}`);
log('\n--- js errors ---');
log(errors.length ? [...new Set(errors)].slice(0,6).join('\n') : 'none');
await b.close();
