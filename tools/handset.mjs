/**
 * Handset verification tool.
 *
 * The console and the field application are one build: the PWA is this same
 * shell installed to a home screen, at a phone's viewport, on a phone's
 * network. `tools/walk.mjs` drives it at 1560px, which is the desk. This drives
 * it at 390px, which is the scaffold.
 *
 * It answers one measurable question per screen — does the page overflow its
 * own viewport sideways — plus the same console and page-error capture the walk
 * does. A page that scrolls horizontally on a phone is the failure people
 * actually hit: a table pushes the layout wide, the sticky header slides off,
 * and every tap lands somewhere unexpected.
 *
 * **This is not an accessibility or responsive audit.** No standard is being
 * checked and none should be claimed. It measures overflow, errors, and whether
 * the primary controls are reachable without a horizontal scroll.
 *
 * `playwright-core` is deliberately NOT in package.json — see `tools/walk.mjs`.
 *   npm install --no-save playwright-core
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

// The screens somebody actually opens on a handset. Not the whole navigation:
// the operator's estate and the tender room are desk work, and the platform
// says so itself by refusing web-only controls to a field device.
const FIELD = ['overview', 'copilot', 'field', 'work', 'construction', 'risk', 'documents', 'programme', 'audit', 'account'];
const BASE = process.env.WALK_BASE ?? 'http://localhost:8123';
const ROLE = process.argv[2] ?? 'site@meridian.example';
const PAGES = process.argv[3] ? process.argv[3].split(',') : FIELD;
const SHOT = process.argv[4] === 'shots';

// iPhone 14 in portrait: the narrowest viewport in real use on a modern site
// handset, and the one the layout has least room in.
const VIEWPORT = { width: 390, height: 844 };

const b = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const p = await b.newPage({
  viewport: VIEWPORT,
  deviceScaleFactor: SHOT ? 2 : 1,
  isMobile: true,
  hasTouch: true,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});
const errors = [];
p.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
p.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`CONSOLE ${m.text()}`);
});

await p.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.identity', { timeout: 40000 });
await p.locator('.identity', { hasText: ROLE }).first().click();
await p.waitForSelector('.sidebar', { timeout: 20000 });
await p.waitForTimeout(2200);
log(`signed in as ${ROLE} at ${VIEWPORT.width}x${VIEWPORT.height}\n`);

let index = 1;
const overflowing = [];
for (const page of PAGES) {
  const clicked = await p.evaluate((id) => {
    const button = document.querySelector(`[data-nav="${id}"]`);
    if (!button) return false;
    button.click();
    return true;
  }, page);

  let status = clicked ? 'ok' : 'LOCKED';
  if (clicked) {
    try {
      await p.waitForSelector('.view-head h1, .notice.err', { timeout: 15000 });
    } catch {
      status = 'TIMEOUT';
    }
    await p.waitForTimeout(page === 'copilot' ? 2200 : 1100);
  }

  // The measurement. `scrollWidth` on the document element is the widest the
  // page actually laid out to; anything past the viewport is a sideways scroll
  // the person did not ask for. Reported with the widest offending element, so
  // the fix has somewhere to start rather than being a hunt.
  const { over, culprit } = await p.evaluate((width) => {
    const scroll = document.documentElement.scrollWidth;
    if (scroll <= width + 1) return { over: 0, culprit: '' };
    let worst = '';
    let worstRight = width;
    for (const el of document.querySelectorAll('body *')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const right = box.right + window.scrollX;
      if (right > worstRight) {
        worstRight = right;
        worst = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/).filter(Boolean).join('.')}` : ''}`;
      }
    }
    return { over: scroll - width, culprit: worst.slice(0, 70) };
  }, VIEWPORT.width);

  if (over > 0) overflowing.push(`${page}: +${over}px  ${culprit}`);

  const h1 = await p.locator('.view-head h1').count().then(async (n) =>
    n > 0 ? ((await p.locator('.view-head h1').first().textContent({ timeout: 2000 }).catch(() => '')) ?? '') : '',
  );
  const cards = await p.locator('.card').count();
  log(
    `${page.padEnd(12)} ${status.padEnd(7)} h1="${h1.trim().slice(0, 24).padEnd(24)}" cards=${String(cards).padStart(2)}` +
      `${over > 0 ? `  OVERFLOW +${over}px ${culprit}` : ''}`,
  );

  if (SHOT && clicked) {
    await p.screenshot({ path: `frontend/shots/handset-${String(index).padStart(2, '0')}-${page}.png`, fullPage: false });
  }
  index += 1;
}

log('\n--- horizontal overflow ---');
log(overflowing.length ? overflowing.join('\n') : 'none — no screen scrolls sideways at 390px');
log('\n--- js errors ---');
log(errors.length ? [...new Set(errors)].slice(0, 10).join('\n') : 'none');
await b.close();
process.exit(overflowing.length || errors.length ? 1 : 0);
