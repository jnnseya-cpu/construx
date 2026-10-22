/**
 * Bid-On, walked end to end in a real browser.
 *
 * ## Why this exists, stated plainly
 *
 * Bid-On shipped with the domain tested thoroughly and **not one end-to-end run
 * by a person**. The first user to try it hit eight blockers in a day, and
 * every one of them sat in the path between "open a customer" and "export a
 * pack":
 *
 *   1. the module could not be allocated — the agreement reference had nowhere
 *      to go on the route that demanded it
 *   2. the engagement form offered terms it could see were not in the catalogue
 *   3. the evidence form asked for a hash and had no file picker
 *   4. the library row did not show the evidence id its own commands took
 *   5. the opened pack showed no question, answer or gap id
 *   6. no agent read a document, so passages were typed by hand
 *   7. three commands sent a document's *name* instead of the document
 *   8. every attachment was sent as an image, so PDF, Word and Excel failed
 *
 * None of those is subtle. Every one was invisible to a suite that asserts
 * refusals and invariants, because a command can be perfectly correct and
 * completely unreachable. `doors.test.ts` checks that every write route has a
 * console door; nothing checked that the door **opens**.
 *
 * This does. It performs the sequence a provider performs, through the real
 * console, and fails naming the step that could not be completed.
 *
 * ## What it deliberately does not need
 *
 * **A provider.** On `AI_MODE=local` every agent refuses by name, correctly, so
 * the walk drives the manual twin of each AI command — `Write an answer`,
 * `Type the passages myself`, `Confirm the question list` — and separately
 * asserts that each AI panel *opens and quotes*, which is where the
 * unreachable-id defects lived. A walk that needed a key would be a walk
 * nobody runs.
 *
 * ## Usage
 *
 *   npm install --no-save playwright-core
 *   PORT=8123 DEMO_TENANCY_ENABLED=true AI_MODE=local npm start &
 *   node tools/bidon-walk.mjs
 *
 * Exit 0 means a provider can get from nothing to an exported pack. Anything
 * else names the step that stopped.
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

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.WALK_BASE ?? 'http://localhost:8123';
const OPERATOR = 'operator@construx.example';
/**
 * Three identities, because the module needs three and that is the point.
 *
 * The director holds `G` and `A` on BID_SERVICES — the service catalogue, the
 * engagement and the approval are theirs. The bid writer holds authorship and
 * no approval, which is what makes the two-person check real rather than
 * advisory. The first run of this walk had the setup steps under the writer
 * and failed on the service catalogue, correctly.
 */
const DIRECTOR = 'owner@meridian.example';
const WRITER = 'qs@meridian.example';

const log = (...a) => process.stdout.write(a.join(' ') + '\n');
const failures = [];
let step = 0;

function pass(what, detail = '') {
  step += 1;
  log(`  ${String(step).padStart(2)}. ok      ${what}${detail ? ` — ${detail}` : ''}`);
}
function fail(what, why) {
  step += 1;
  failures.push({ what, why });
  log(`  ${String(step).padStart(2)}. FAILED  ${what}\n        ${String(why).replace(/\s+/g, ' ').slice(0, 300)}`);
}

// --------------------------------------------------------------- the API half

/**
 * Sign in over HTTP, for the two things that are not a provider's job: granting
 * the module and crediting the wallet. Both are the platform operator's, and
 * driving them through the browser would be testing the operator's screens
 * rather than this one.
 */
async function tokenFor(email) {
  const login = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  }).then((r) => r.json());
  const code = login.devCode ?? login.demoCode;
  if (!code) throw new Error(`no development code returned for ${email}; is this running outside production?`);
  const verified = await fetch(`${BASE}/v1/auth/mfa/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actorId: login.actorId, challengeId: login.challengeId, code }),
  }).then((r) => r.json());
  if (!verified.accessToken) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(verified).slice(0, 200)}`);
  return verified.accessToken;
}

async function asOperator(method, path, token, payload) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
}

log('\nBid-On walk\n');
log('Preparing the tenancy');

/** The writer's user id, for the assignment that makes the workspace visible to them. */
const identities = await fetch(`${BASE}/v1/console/identities`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((r) => r.json());
const writerId = (identities.identities ?? []).find((entry) => entry.email === WRITER)?.id ?? '';

let operatorToken;
let tenantId;
try {
  operatorToken = await tokenFor(OPERATOR);
  const estate = await asOperator('GET', '/v1/admin/tenants', operatorToken);
  const demo = (estate.body?.tenants ?? []).find((row) => row.demonstration) ?? estate.body?.tenants?.[0];
  if (!demo) throw new Error('no tenancy on the estate to walk');
  tenantId = demo.id;
  pass('signed in as the platform operator', demo.legalName);
} catch (error) {
  fail('sign in as the platform operator', error.message);
  process.exit(1);
}

{
  // The allocation that could not be made at all until today: a module whose
  // registry demands an agreement reference, through a route that had none.
  const granted = await asOperator('POST', `/v1/admin/tenants/${tenantId}/modules/BID_ON`, operatorToken, {
    status: 'ACTIVE',
    reason: 'Walked end to end by tools/bidon-walk.mjs',
    agreementRef: 'WALK-AGREEMENT-0001',
  });
  if (granted.status === 201) pass('allocated Bid-On under an agreement', granted.body.agreementRef);
  else fail('allocate Bid-On', `${granted.status} ${granted.text.slice(0, 200)}`);

  const credited = await asOperator('POST', `/v1/admin/tenants/${tenantId}/credit`, operatorToken, {
    amountMinor: 500_00,
    method: 'MANUAL_ADJUSTMENT',
    reference: `walk-${Date.now()}`,
    note: 'Opening credit so an agent run is not refused on an empty wallet',
  });
  if (credited.status === 201) pass('credited the wallet');
  else fail('credit the wallet', `${credited.status} ${credited.text.slice(0, 200)}`);
}

// ----------------------------------------------------------- the browser half

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(`CONSOLE ${m.text()}`);
});

async function signIn(email) {
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  // Sign the previous identity out first. The session token lives in storage
  // rather than a cookie, so clearing it is the sign-out — and without this the
  // second visit lands on the app rather than the picker, which reads as the
  // picker having disappeared.
  const picker = await page.locator('.identity').count();
  if (picker === 0) {
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* a browser with storage blocked is not a case this tool runs in */
      }
    });
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('.identity', { timeout: 40000 });
  await page.locator('.identity', { hasText: email }).first().click();
  await page.waitForSelector('.sidebar', { timeout: 25000 });
  await page.waitForTimeout(1200);
}

async function openBidOn() {
  const clicked = await page.evaluate(() => {
    const button = document.querySelector('[data-nav="bidon"]');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error('the Bid-On navigation entry is absent — the module is not reachable for this identity');
  // The Bid-On page renders a bare <h1> rather than the estate screens'
  // `.view-head`, so the wait is on the heading's text rather than on a class
  // this page does not use.
  await page.waitForFunction(
    () => [...document.querySelectorAll('h1')].some((h) => h.textContent.trim() === 'Bid-On'),
    { timeout: 25000 },
  );
  await page.waitForTimeout(900);
}

/**
 * Run one console command, as a person does: press the button, fill the panel,
 * submit, and wait for the panel to close or for it to say why it will not.
 *
 * Returns the error text where the platform refused, so a step can assert a
 * refusal as well as a success — a walk that only proved the happy path would
 * miss a gate that stopped gating.
 */
async function runCommand(id, values, { expectRefusal = false } = {}) {
  const button = page.locator(`[data-command="${id}"]`).first();
  if ((await button.count()) === 0) throw new Error(`no console control for "${id}" — the command is unreachable`);
  if (await button.isDisabled().catch(() => false)) {
    const why = await button.getAttribute('title');
    throw new Error(`the control for "${id}" is locked: ${why ?? 'no reason given'}`);
  }
  await button.click();
  await page.waitForSelector('form.modal', { timeout: 15000 });

  for (const [name, value] of Object.entries(values)) {
    const field = page.locator(`form.modal [name="${name}"]`).first();
    if ((await field.count()) === 0) throw new Error(`the panel for "${id}" has no field "${name}"`);
    const tag = await field.evaluate((element) => element.tagName.toLowerCase());
    const type = await field.getAttribute('type');
    if (tag === 'select') {
      // `{ index: n }` picks the nth option where the walk cannot know the
      // value — a service id, a customer id, an engagement id are all ULIDs
      // minted during the run. Index 0 on these pickers is the "leave it"
      // option, so index 1 is the first real choice.
      if (value && typeof value === 'object' && 'labelContains' in value) {
        // Pick the record this run created, not whatever the picker defaulted
        // to. Every panel's first option is the oldest row, so a second run
        // filed its document against the first run's customer and was refused
        // for a duplicate — which read as a defect in the dedupe rather than
        // as the walk choosing the wrong customer.
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
    }
    else if (type === 'file') await field.setInputFiles(value);
    else await field.fill(String(value));
  }

  await page.locator('form.modal [data-submit]').first().click();

  // Either the panel closes, or it shows why not. Both are answers; a panel
  // that does neither is the failure this tool exists to catch.
  const outcome = await Promise.race([
    page
      .waitForSelector('form.modal', { state: 'detached', timeout: 25000 })
      .then(() => ({ ok: true })),
    page
      .waitForFunction(() => {
        const box = document.querySelector('form.modal .cmd-error');
        return box && !box.hasAttribute('hidden') && box.textContent.trim().length > 0;
      }, { timeout: 25000 })
      .then(async () => ({ ok: false, error: (await page.locator('form.modal .cmd-error').first().textContent()) ?? '' })),
  ]).catch(() => ({ ok: false, error: 'the panel neither closed nor said why not within 25 seconds' }));

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

/** Pull a value out of the opened pack or the library, the way a person copies it. */
async function readText(selector) {
  return (await page.locator(selector).count()) > 0
    ? ((await page.locator(selector).first().textContent({ timeout: 3000 }).catch(() => '')) ?? '').trim()
    : '';
}

const scratch = mkdtempSync(join(tmpdir(), 'bidon-walk-'));
const appendix = join(scratch, 'appendix-6-specification.txt');
writeFileSync(
  appendix,
  'Appendix 6. The Contractor shall complete each assessment within ten working days of instruction, and shall ' +
    'lodge the certificate on the central register within five working days of completion. All assessors shall hold ' +
    'current accreditation with an approved scheme.',
  'utf8',
);

const stamp = Date.now().toString().slice(-6);
let evidenceId = '';
let questionId = '';
let answerId = '';
let returnableId = '';
/** The platform's own reference for this run's bid, e.g. `BID-0003`. */
let bidReference = '';

try {
  log('\nAs the provider’s director');
  await signIn(DIRECTOR);
  await openBidOn();
  pass('opened Bid-On');

  await runCommand('define-offering', {
    name: `Measured term tender ${stamp}`,
    engagementType: 'ONE_OFF',
    billingBasis: 'FIXED_FEE',
    defaultFee: '3500',
    currency: 'GBP',
    deliverables: 'Question list confirmed against the source\nAnswers drafted, scored and signed off',
  });
  pass('defined a service');

  await openBidOn();
  await runCommand('open-customer', { legalName: `Thornhill Electrical ${stamp} Ltd` });
  pass('opened a customer workspace');

  // Restrictive by default: a workspace is visible to whoever opened it and to
  // nobody else. The first run of this walk had the writer unable to see the
  // customer at all, which is the module behaving exactly as designed and the
  // walk skipping a step a provider performs.
  await openBidOn();
  await runCommand('assign-staff', { customerId: { labelContains: stamp }, add: writerId });
  pass('assigned the bid writer to the customer');

  await openBidOn();
  await runCommand('open-engagement', {
    customerId: { labelContains: stamp },
    name: `Platform Housing EPC ${stamp}`,
    // The service just defined. Left on its default this refuses
    // BID_ON_TERMS_INCOMPLETE — which is exactly what the first user hit, and
    // what this walk reproduced on its first run.
    offeringId: { index: 1 },
    type: 'ONE_OFF',
  });
  pass('opened an engagement from the catalogue');

  await openBidOn();
  await runCommand('activate-engagement', { engagementId: { labelContains: stamp } });
  pass('activated it');

  await openBidOn();
  await runCommand('create-bid', {
    engagementId: { labelContains: stamp },
    // Stamped, so every bid picker in the run can name this bid. The pickers
    // label a bid `reference — buyer`, and the reference is the platform's own
    // (`BID-0001`), which the walk cannot know before it exists.
    buyerName: `Platform Housing Group ${stamp}`,
    scheme: 'ITT',
    deadline: '2027-11-02',
    buyerReference: `RFX${stamp}`,
  });
  pass('opened a bid');

  await openBidOn();
  await runCommand('file-evidence', {
    customerId: { labelContains: stamp },
    type: 'OTHER',
    title: `RFX${stamp} App 6 — EPC Specification`,
    hash: appendix,
  });
  pass('filed a document through the file picker');

  // The library, and the two values its own commands ask to be typed. Blocker
  // #4 was exactly this: the row carried the reference and not the id.
  await openBidOn();
  // Whose library. The chooser defaults to the oldest customer, so a second
  // run read a previous run's row and carried its evidence id into every step
  // after — the walk agreeing with itself about the wrong document.
  await page.evaluate((needle) => {
    const select = document.querySelector('#ev-customer');
    const option = [...select.options].find((o) => o.textContent.includes(needle));
    if (option) select.value = option.value;
  }, stamp);
  await page.locator('#ev-open').click();
  await page.waitForTimeout(1500);
  evidenceId = await page.evaluate(() => {
    const cell = document.querySelector('#evidence-detail [data-copy-what="evidence id"]');
    return cell ? cell.getAttribute('data-copy') : '';
  });
  if (!evidenceId) throw new Error('the library row carries no evidence id, so every command that takes one is unreachable');
  const hashOnRow = await page.evaluate(() => {
    const control = document.querySelector('#evidence-detail [data-copy-what="document hash"]');
    return control ? control.getAttribute('data-copy') : '';
  });
  if (!hashOnRow) throw new Error('the library row offers no document hash, which the parser and the amendments reading take');
  pass('read the id and the hash off the library row', evidenceId.slice(-8));

  // The Reader's panel must open and quote even where it will refuse: an
  // unreachable AI command was blocker #5, and it looked exactly like this.
  const reader = await runCommand('read-evidence', { evidenceId }, { expectRefusal: true });
  pass('the Reader opens and refuses by name', reader.refused.slice(0, 60));

  await openBidOn();
  await runCommand('record-extraction', {
    evidenceId,
    chunks:
      'page 3 | The Contractor shall complete each assessment within ten working days of instruction.\n' +
      'page 4 | The certificate shall be lodged on the central register within five working days.',
  });
  pass('recorded the passages by hand');

  await openBidOn();
  await runCommand('confirm-questions', {
    bidId: { labelContains: stamp },
    questions: 'Quality | 4.1 | Describe your EPC assessment process from instruction to lodgement | text | 500 | 25 | M |',
  });
  pass('confirmed the question list');

  await openBidOn();
  await runCommand('record-returnables', {
    bidId: { labelContains: stamp },
    returnables: 'APP5 | EPC Cost Model, fully priced | M | PROVIDER | XLSX | | | | 2027-10-29',
  });
  pass('recorded what has to be returned');

  // The opened pack, and the ids every answer command takes. Blocker #5.
  await openBidOn();
  // The pack opens from the bid row's own control, not from clicking a row:
  // the first table on this screen is the importable tenders, and a walk that
  // clicked "the first row" was reading an empty detail panel and blaming the
  // ids for being absent.
  await page.locator(`tr:has-text("${stamp}") [data-bid]`).first().click();
  await page.waitForTimeout(2000);
  questionId = await page.evaluate(() => {
    const cell = document.querySelector('[data-copy-what="question id"]');
    return cell ? cell.getAttribute('data-copy') : '';
  });
  returnableId = await page.evaluate(() => {
    const cell = document.querySelector('[data-copy-what="returnable id"]');
    return cell ? cell.getAttribute('data-copy') : '';
  });
  // The platform's own reference for this bid, read off the opened pack. The
  // export picker labels a bid `reference — ready|blocked` with no buyer on it,
  // so this is the only handle the walk has on its own bid there.
  bidReference = await page.evaluate(() => {
    const match = (document.querySelector('#bid-detail')?.textContent ?? '').match(/[A-Z]{2,4}-\d{3,}/);
    return match ? match[0] : '';
  });
  if (!bidReference) throw new Error('the opened pack does not show the bid’s own reference, so nothing can name it on another screen');
  if (!questionId) throw new Error('the opened pack shows no question id, so drafting and writing an answer are unreachable');
  if (!returnableId) throw new Error('the opened pack shows no returnable id, so a returnable cannot be marked done');
  pass('read the question and returnable ids off the pack', questionId.slice(-8));

  log('\nAs the bid writer');
  await signIn(WRITER);
  await openBidOn();
  await runCommand('record-answer', {
    bidId: { labelContains: stamp },
    questionId,
    body:
      'We complete each assessment within ten working days of instruction and lodge the certificate on the central ' +
      'register within five working days of completion, in line with the specification.',
  });
  pass('wrote an answer');

  await openBidOn();
  await page.locator(`tr:has-text("${stamp}") [data-bid]`).first().click();
  await page.waitForTimeout(2000);
  answerId = await page.evaluate(() => {
    const cell = document.querySelector('[data-copy-what="answer id"]');
    return cell ? cell.getAttribute('data-copy') : '';
  });
  if (!answerId) throw new Error('the pack shows no answer id, so scoring and approval are unreachable');
  pass('read the answer id off the pack', answerId.slice(-8));

  await openBidOn();
  await runCommand('score-answer', {
    bidId: { labelContains: stamp },
    answerId,
    compliance: '85',
    complianceWhy: 'Answers every part of 4.1 in the order asked',
    evidence: '80',
    evidenceWhy: 'Cites the lodgement passage from the specification',
    relevance: '80',
    relevanceWhy: 'Uses the buyer’s own response-time language',
    specificity: '75',
    specificityWhy: 'Names the ten and five working-day commitments',
    clarity: '90',
    clarityWhy: 'Inside the stated word limit',
  });
  pass('scored it');

  /*
   * The two-person check, and it is stronger than a refusal.
   *
   * The writer has no approval control at all: `commandBar` hides a
   * role-denied command rather than disabling it, so the screen does not offer
   * an act this identity could never complete. The domain refuses
   * `BID_ON_SELF_APPROVAL` behind it — `bidonbid.test.ts` asserts that — and
   * what this asserts is the half a test cannot see, which is that a bid
   * writer is never shown the button.
   */
  await openBidOn();
  const approveControls = await page.locator('[data-command="approve-answer"]').count();
  if (approveControls > 0) {
    throw new Error('the bid writer is offered an approval control; the two-person check is advisory rather than enforced at the screen');
  }
  pass('the writer is never offered approval');

  log('\nAs the director again');
  await signIn(DIRECTOR);
  await openBidOn();

  await runCommand('approve-answer', {
    bidId: { labelContains: stamp },
    answerId,
    note: 'Read against 4.1; citations check out; inside the word limit',
  });
  pass('approved it as a second person');

  await openBidOn();
  const blocked = await runCommand('export-bid', { bidId: { labelContains: bidReference } }, { expectRefusal: true });
  pass('export refused while a mandatory document is outstanding', blocked.refused.slice(0, 70));

  await openBidOn();
  await runCommand('supply-returnable', { bidId: { labelContains: stamp }, returnableId, note: 'Priced and returned with the submission' });
  pass('marked the returnable done');

  await openBidOn();
  await runCommand('export-bid', { bidId: { labelContains: bidReference } });
  pass('exported the pack');
} catch (error) {
  fail('complete the walk', error.message);
}

await browser.close();

log('');
if (consoleErrors.length > 0) {
  // Named as what they are. The Reader's refusal is a 503 and the export gate
  // is a 422; both are steps this walk asserts, so a bare "errors" heading
  // would make a passing run look like a failing one.
  log(`Browser console notices (${consoleErrors.length}) — the refusals this walk asserts appear here as 4xx and 503:`);
  for (const line of consoleErrors.slice(0, 10)) log(`  ${line.slice(0, 160)}`);
  log('');
}

if (failures.length === 0) {
  log('A provider can get from nothing to an exported pack.\n');
  process.exit(0);
}
log(`${failures.length} step(s) a provider could not complete:\n`);
for (const entry of failures) log(`  - ${entry.what}: ${String(entry.why).replace(/\s+/g, ' ').slice(0, 220)}`);
log('');
process.exit(1);
