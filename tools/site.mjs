/**
 * Public site verification tool.
 *
 * The console has `tools/walk.mjs` at the desk and `tools/handset.mjs` on the
 * scaffold. The marketing site had neither, and it is the half of the product a
 * stranger sees first.
 *
 * Two questions, both answerable without judgement:
 *
 * **Does every internal link resolve?** Collected from the rendered DOM rather
 * than the source, so a link built by a template that stopped being rendered is
 * not counted, and one built by script is. Every distinct target is fetched
 * once; anything 400 or worse is named with the pages that link to it.
 *
 * **Does anything lay out past the viewport?** `body.site` sets
 * `overflow-x: hidden`, so an overflow here does not scroll — it *clips*, which
 * is worse: the reader cannot reach what fell off and nothing tells them it is
 * there. That is how the Get started button came to be cut off on every page of
 * the site between 721 and 800 pixels wide.
 *
 * **What it deliberately ignores**, said rather than silently filtered:
 * absolutely-positioned decoration, which is oversized on purpose — the hero's
 * `.grid-plane` is `inset: 38% -50% -14% -50%` and is meant to run off both
 * edges — and anything inside a container that scrolls on its own axis, which
 * is the correct treatment for a wide table. Everything else that reaches past
 * the edge is reported.
 *
 * `playwright-core` is deliberately NOT in package.json — see `tools/walk.mjs`.
 *   npm install --no-save playwright-core
 *
 *   node tools/site.mjs                     # against localhost:8123
 *   SITE_BASE=http://localhost:8180 node tools/site.mjs
 *
 * Exit code 1 if a link is broken or anything clips.
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

const BASE = process.env.SITE_BASE ?? 'http://localhost:8123';
/**
 * The fifteen standing pages. The blog's posts are discovered rather than
 * listed: the first run of this tool checked fifteen pages and silently missed
 * seven, because a list of paths in a verification tool goes stale the first
 * time somebody publishes anything.
 */
const STANDING = ['/', '/about', '/how-it-works', '/exposure', '/industries', '/blog', '/developers',
                  '/contact', '/get-started', '/demo', '/growth', '/terms', '/privacy', '/policies', '/status'];

async function posts() {
  const html = await (await fetch(`${BASE}/blog`)).text();
  return [...new Set([...html.matchAll(/href="(\/blog\/[a-z0-9-]+)"/g)].map((m) => m[1]))];
}

const PAGES = process.argv[2] ? process.argv[2].split(',') : [...STANDING, ...(await posts())];
// The desk, a laptop, tablet portrait, a small phone, and the narrowest in real
// use. 760 and 500 are in the list because the two faults this tool has found
// so far were both in the gaps between the obvious breakpoints.
const WIDTHS = [1440, 1024, 820, 760, 500, 390];

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});

let failures = 0;

// --- links -----------------------------------------------------------------
const reader = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const targets = new Map();
for (const path of PAGES) {
  await reader.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  for (const href of await reader.$$eval('a[href]', (as) => as.map((a) => a.getAttribute('href')))) {
    if (!href || /^(https?:|mailto:|tel:|#)/.test(href)) continue;
    const target = href.split('#')[0];
    if (!target) continue;
    if (!targets.has(target)) targets.set(target, new Set());
    targets.get(target).add(path);
  }
}
const broken = [];
for (const [target, from] of targets) {
  const response = await fetch(BASE + target, { redirect: 'manual' });
  if (response.status >= 400) broken.push(`${response.status} ${target}   linked from ${[...from].join(', ')}`);
}
log(`internal links: ${targets.size} distinct targets across ${PAGES.length} pages`);
log(broken.length ? `  BROKEN:\n    ${broken.join('\n    ')}` : '  all resolve');
failures += broken.length;
await reader.close();

// --- overflow --------------------------------------------------------------
log('\nclipped content, by width');
for (const width of WIDTHS) {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    isMobile: width <= 500,
    hasTouch: width <= 500,
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(`CONSOLE ${m.text()}`);
  });

  const clipped = [];
  for (const path of PAGES) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    const worst = await page.evaluate((edge) => {
      let over = 0;
      let who = '';
      for (const el of document.querySelectorAll('body *')) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        if (box.right <= edge + 1 || box.right - edge <= over) continue;
        // Two exemptions, both checked up the ancestor chain rather than on the
        // element itself. An SVG `<path>` is never positioned — its `<svg>` is —
        // so testing the element alone reported every decorative curve in the
        // hero as clipped content, which is the sort of noise that gets a check
        // switched off.
        let node = el;
        let exempt = false;
        while (node && node !== document.body) {
          const style = getComputedStyle(node);
          // Decoration is oversized on purpose and is not content.
          if (style.position === 'fixed' || style.position === 'absolute') { exempt = true; break; }
          // Wide content inside its own scroller is the correct treatment, and
          // so is a component that clips its own contents — the hero panel's
          // breadcrumb is `overflow: hidden` with an ellipsis, so its inner
          // `<b>` legitimately measures wider than the box that shows it.
          //
          // `body` and `html` are excluded from this exemption deliberately.
          // `body.site` sets `overflow-x: hidden`, and treating that as
          // intentional clipping would exempt every element on every page and
          // leave the tool finding nothing at all. The page-level hidden is
          // what conceals these faults; a component's own is what defines it.
          if (node !== el && node !== document.documentElement) {
            const { overflowX, overflow } = style;
            if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflow === 'hidden') {
              exempt = true;
              break;
            }
          }
          node = node.parentElement;
        }
        if (exempt) continue;
        over = Math.round(box.right - edge);
        who = el.tagName.toLowerCase() +
          (typeof el.className === 'string' && el.className
            ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
            : '');
      }
      return { over, who };
    }, width);
    if (worst.over > 0) clipped.push(`${path} +${worst.over}px ${worst.who}`);
  }

  log(`  ${String(width).padStart(4)}px  ${clipped.length ? clipped.join('\n          ') : 'clean'}`);
  if (errors.length) log(`          errors: ${[...new Set(errors)].slice(0, 3).join(' | ')}`);
  failures += clipped.length + errors.length;
  await page.close();
}

await browser.close();
log(failures ? `\n${failures} finding(s)` : '\nno findings');
process.exit(failures ? 1 : 0);
