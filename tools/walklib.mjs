/**
 * Driving the console the way a person does.
 *
 * Shared by every walk, because the mechanics are one concept: sign in, press a
 * command, fill its panel, submit, and wait for the panel to close or to say
 * why it will not. A second copy of this would be a second opinion about what
 * "the command was accepted" means, and the two would drift on the first
 * timeout anybody tuned.
 *
 * What a walk adds on top is the sequence and the assertions. What this holds
 * is the part that is the same whichever screen is being walked.
 */

import { strict as assert } from 'node:assert';

export const log = (...parts) => process.stdout.write(parts.join(' ') + '\n');

/** A walk's running tally, so the summary is the same shape for every tool. */
export function tally() {
  const failures = [];
  let step = 0;
  return {
    failures,
    pass(what, detail = '') {
      step += 1;
      log(`  ${String(step).padStart(2)}. ok      ${what}${detail ? ` — ${detail}` : ''}`);
    },
    fail(what, why) {
      step += 1;
      failures.push({ what, why });
      log(`  ${String(step).padStart(2)}. FAILED  ${what}\n        ${String(why).replace(/\s+/g, ' ').slice(0, 300)}`);
    },
    /** Exit the way a check should: 0 when a person could complete the path. */
    finish(success) {
      log('');
      if (failures.length === 0) {
        log(`${success}\n`);
        return 0;
      }
      log(`${failures.length} step(s) a person could not complete:\n`);
      for (const entry of failures) log(`  - ${entry.what}: ${String(entry.why).replace(/\s+/g, ' ').slice(0, 220)}`);
      log('');
      return 1;
    },
  };
}

/**
 * Sign in through the demonstration picker, signing the previous identity out.
 *
 * The session token lives in storage rather than a cookie, so clearing storage
 * is the sign-out. Without it a second visit lands on the app rather than the
 * picker, which reads as the picker having disappeared.
 */
export async function signIn(page, base, email) {
  await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded' });
  if ((await page.locator('.identity').count()) === 0) {
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* a browser with storage blocked is not a case these tools run in */
      }
    });
    await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('.identity', { timeout: 40000 });
  await page.locator('.identity', { hasText: email }).first().click();
  await page.waitForSelector('.sidebar', { timeout: 25000 });
  await page.waitForTimeout(1200);
}

/** Open a screen by its navigation id, and wait for its own heading. */
export async function openScreen(page, navId, heading) {
  const clicked = await page.evaluate((id) => {
    const button = document.querySelector(`[data-nav="${id}"]`);
    if (!button) return false;
    button.click();
    return true;
  }, navId);
  if (!clicked) throw new Error(`the "${navId}" navigation entry is absent — the screen is not reachable for this identity`);
  await page.waitForFunction(
    (text) => [...document.querySelectorAll('h1')].some((h) => h.textContent.trim().includes(text)),
    heading,
    { timeout: 25000 },
  );
  await page.waitForTimeout(900);
}

/**
 * Run one console command.
 *
 * Returns `{ refused }` where the platform said no and the caller expected it,
 * so a walk can assert a gate as well as a success — a walk that only proved
 * the happy path would miss a gate that stopped gating.
 */
export async function runCommand(page, id, values, { expectRefusal = false, timeout = 25000 } = {}) {
  const button = page.locator(`[data-command="${id}"]`).first();
  if ((await button.count()) === 0) throw new Error(`no console control for "${id}" — the command is unreachable`);
  if (await button.isDisabled().catch(() => false)) {
    throw new Error(`the control for "${id}" is locked: ${(await button.getAttribute('title')) ?? 'no reason given'}`);
  }
  await button.click();
  await page.waitForSelector('form.modal', { timeout: 15000 });

  for (const [name, value] of Object.entries(values)) {
    const field = page.locator(`form.modal [name="${name}"]`).first();
    if ((await field.count()) === 0) throw new Error(`the panel for "${id}" has no field "${name}"`);
    const tag = await field.evaluate((element) => element.tagName.toLowerCase());
    const type = await field.getAttribute('type');
    if (tag === 'select') {
      // A walk cannot know a ULID minted during its own run, so a picker is
      // addressed by what its option says. Index 0 on these is usually the
      // "leave it" option, so `{ index: 1 }` is the first real choice.
      if (value && typeof value === 'object' && 'labelContains' in value) {
        const option = await field.evaluate(
          (element, needle) => [...element.options].find((o) => o.textContent.includes(needle))?.value ?? '',
          value.labelContains,
        );
        if (!option) throw new Error(`the picker "${name}" on "${id}" has no option naming "${value.labelContains}"`);
        await field.selectOption(option);
      } else if (value && typeof value === 'object' && 'index' in value) {
        const option = await field.evaluate((element, index) => element.options[index]?.value ?? '', value.index);
        if (!option) throw new Error(`the picker "${name}" on "${id}" has no option ${value.index} — nothing to choose`);
        await field.selectOption(option);
      } else {
        await field.selectOption(String(value));
      }
    } else if (type === 'file') {
      await field.setInputFiles(value);
    } else if (type === 'checkbox') {
      // Set, not typed. `fill` on a checkbox throws, and an unticked box is an
      // answer the panel sends rather than a field left blank — so a walk has
      // to be able to say "no" as deliberately as it says "yes".
      if (value) await field.check();
      else await field.uncheck();
    } else {
      await field.fill(String(value));
    }
  }

  await page.locator('form.modal [data-submit]').first().click();

  /*
   * Either the panel closes, or it says why not — in one of two places.
   *
   * A refusal about the command goes in `.cmd-error`; a refusal the platform
   * attached to a field goes in that field's own `.field-error` and the box at
   * the top stays hidden, which is the better UI and was invisible to this
   * function. A walk then reported "the panel neither closed nor said why not",
   * which reads as a hang in the product when the product had answered
   * precisely. Both are watched, and the field's label is carried into the
   * message so the reason names where it landed.
   */
  const outcome = await Promise.race([
    page.waitForSelector('form.modal', { state: 'detached', timeout }).then(() => ({ ok: true })),
    page
      .waitForFunction(
        () => {
          const visible = (box) => box && !box.hasAttribute('hidden') && box.textContent.trim().length > 0;
          if (visible(document.querySelector('form.modal .cmd-error'))) return true;
          return [...document.querySelectorAll('form.modal .field-error')].some(visible);
        },
        { timeout },
      )
      .then(async () => ({
        ok: false,
        error: await page.evaluate(() => {
          const visible = (box) => box && !box.hasAttribute('hidden') && box.textContent.trim().length > 0;
          const top = document.querySelector('form.modal .cmd-error');
          if (visible(top)) return top.textContent.trim();
          return [...document.querySelectorAll('form.modal .field-error')]
            .filter(visible)
            .map((box) => {
              const field = box.closest('[data-field]');
              const label = field?.querySelector('label')?.textContent?.trim() ?? field?.dataset.field ?? 'a field';
              return `${label}: ${box.textContent.trim()}`;
            })
            .join('; ');
        }),
      })),
  ]).catch(() => ({ ok: false, error: `the panel neither closed nor said why not within ${Math.round(timeout / 1000)} seconds` }));

  if (!outcome.ok) {
    if (expectRefusal) {
      await page.locator('form.modal [data-close]').first().click().catch(() => {});
      await page.waitForTimeout(400);
      return { refused: outcome.error.trim() };
    }
    throw new Error(outcome.error.trim());
  }
  if (expectRefusal) throw new Error(`"${id}" was accepted where a refusal was expected`);
  await page.waitForTimeout(1400);
  return {};
}

/**
 * Change the project the console is looking at, through the shell's own picker.
 *
 * The same control a person uses, so the walk cannot reach a state the console
 * will not put somebody in. The picker renders as plain text where the tenancy
 * has one project, which is a deliberate decision in `app.js` — so this says
 * so rather than failing on a missing select.
 */
export async function chooseProject(page, labelContains, { timeout = 20000 } = {}) {
  const picker = page.locator('select.project-pick').first();
  if ((await picker.count()) === 0) {
    throw new Error('the shell offers no project picker — this tenancy has fewer than two projects');
  }
  /*
   * Waited for rather than read once.
   *
   * A project created a moment ago appears in the picker when the shell next
   * redraws, and the redraw is started by the page's own handler after the
   * command panel has already closed — so a single read races it and the walk
   * reports a missing project that arrives a second later. The wait is on the
   * option, which is the thing being asked about.
   */
  await page
    .waitForFunction(
      (needle) =>
        [...(document.querySelector('select.project-pick')?.options ?? [])].some((option) =>
          option.textContent.includes(needle),
        ),
      labelContains,
      { timeout },
    )
    .catch(() => {
      throw new Error(`no project on the picker names "${labelContains}" within ${Math.round(timeout / 1000)} seconds`);
    });
  const value = await picker.evaluate(
    (element, needle) => [...element.options].find((option) => option.textContent.includes(needle))?.value ?? '',
    labelContains,
  );
  await picker.selectOption(value);
  await page.waitForTimeout(1800);
}

/** Assert a command is not offered at all — stronger than its being refused. */
export async function assertNoControl(page, id, why) {
  const count = await page.locator(`[data-command="${id}"]`).count();
  assert.equal(count, 0, why);
}

/** Sign in over HTTP, for the operator-only steps a walk has to arrange. */
export async function apiToken(base, email) {
  const login = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  }).then((r) => r.json());
  const code = login.devCode ?? login.demoCode;
  if (!code) throw new Error(`no development code returned for ${email}; is this running outside production?`);
  const verified = await fetch(`${base}/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorId: login.actorId, challengeId: login.challengeId, code }),
  }).then((r) => r.json());
  if (!verified.accessToken) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(verified).slice(0, 200)}`);
  return verified.accessToken;
}

export async function apiCall(base, method, path, token, payload) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

/** A browser, configured the way every walk needs it. */
export async function openBrowser() {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    // Said rather than thrown. The driver is deliberately not a project
    // dependency — zero runtime dependencies is a settled decision and a walk
    // is a development check — so a missing driver is a setup step, not a
    // defect, and a stack trace would read as the latter.
    process.stderr.write(
      'This tool needs a browser driver, which is not a project dependency.\n' +
        '  npm install --no-save playwright-core\n' +
        'Chromium itself is already present at /opt/pw-browsers.\n',
    );
    process.exit(1);
  }
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const notices = [];
  page.on('pageerror', (e) => notices.push(`PAGEERROR ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) notices.push(`CONSOLE ${m.text()}`);
  });
  return { browser, page, notices };
}
