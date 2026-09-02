import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { exposurePosition, readExposureInput } from '../src/site/exposure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * The exposure page's arithmetic, and the one property that makes it worth
 * having on a marketing site: every figure comes from what the visitor typed.
 *
 * The test that matters most here is the last one in the first block — that no
 * output moves unless an input moved. A hidden constant, an assumed miss rate or
 * a benchmark smuggled into the sums would make the biggest number on the page
 * the least trustworthy one, and would be invisible to a reader.
 */

const ORDINARY = {
  turnover: 40_000_000,
  liveContracts: 8,
  applicationsPerMonth: 1,
  gapPercent: 8,
  retentionPercent: 5,
};

/** Pull the numeric part back out of a formatted money string. */
function amount(value: string): number {
  return Number(value.replace(/[^0-9.]/g, ''));
}

describe('the exposure arithmetic', () => {
  it('counts one payment window per contract per month', () => {
    const position = exposurePosition({ ...ORDINARY, liveContracts: 8, applicationsPerMonth: 1 });
    assert.equal(position.lines[0]!.value, '96');
  });

  it('divides turnover across the windows to size a single application', () => {
    const position = exposurePosition({ ...ORDINARY });
    // £40m over 96 windows.
    assert.equal(Math.round(amount(position.lines[1]!.value)), Math.round(40_000_000 / 96));
  });

  it('prices one missed pay less notice at the applied-to-certified gap on one application', () => {
    const position = exposurePosition({ ...ORDINARY, gapPercent: 10 });
    const application = amount(position.lines[1]!.value);
    assert.equal(Math.round(amount(position.lines[2]!.value)), Math.round(application * 0.1));
  });

  it('puts the accent on that one figure and no other', () => {
    const position = exposurePosition(ORDINARY);
    const emphasised = position.lines.filter((line) => line.emphasis);
    assert.equal(emphasised.length, 1, 'five emphasised figures would be none');
    assert.match(emphasised[0]!.label, /missed pay less notice/);
  });

  it('shows the working for every line, so no number stands on its own authority', () => {
    for (const line of exposurePosition(ORDINARY).lines) {
      assert.ok(line.working.length > 0, `${line.label} shows no working`);
      assert.ok(line.meaning.length > 0, `${line.label} states no meaning`);
    }
  });

  it('moves no output unless an input moved, so nothing is smuggled into the sums', () => {
    // The whole claim of the page. If any figure here were part invented — an
    // assumed miss rate, an industry average, a "typical recovery" — doubling
    // one input would move an output by something other than the arithmetic,
    // and a reader could never tell.
    const base = exposurePosition(ORDINARY);
    const doubled = exposurePosition({ ...ORDINARY, turnover: 80_000_000 });

    // Windows depend on contracts, not turnover: unchanged.
    assert.equal(doubled.lines[0]!.value, base.lines[0]!.value);
    // Everything denominated in money doubles exactly.
    for (const index of [1, 2, 3, 4]) {
      assert.equal(
        Math.round(amount(doubled.lines[index]!.value)),
        Math.round(amount(base.lines[index]!.value) * 2),
        `line ${index} did not scale with turnover`,
      );
    }
  });

  it('reaches zero exposure where the visitor applies for exactly what is certified', () => {
    const position = exposurePosition({ ...ORDINARY, gapPercent: 0 });
    assert.equal(amount(position.lines[2]!.value), 0);
  });

  it('says in the response itself what it will not claim', () => {
    const position = exposurePosition(ORDINARY);
    assert.ok(position.notClaimed.length >= 3);
    assert.ok(position.notClaimed.some((limit) => /how many notices you miss/i.test(limit)));
    assert.ok(position.notClaimed.some((limit) => /industry average|benchmark/i.test(limit)));
  });
});

describe('what the form is allowed to submit', () => {
  it('reads an ordinary submission unchanged', () => {
    const input = readExposureInput({
      turnover: '40000000',
      liveContracts: '8',
      applicationsPerMonth: '1',
      gapPercent: '8',
      retentionPercent: '5',
    });
    assert.deepEqual(input, ORDINARY);
  });

  it('accepts the figures the way a person types them', () => {
    // "£40,000,000" is what somebody pastes out of a spreadsheet, and refusing
    // it would read as the calculator being broken.
    assert.equal(readExposureInput({ turnover: '£40,000,000' }).turnover, 40_000_000);
    assert.equal(readExposureInput({ turnover: ' 40000000 ' }).turnover, 40_000_000);
  });

  it('falls back rather than producing nonsense from a blank or a word', () => {
    const input = readExposureInput({ turnover: '', gapPercent: 'lots' });
    assert.ok(input.turnover > 0);
    assert.ok(Number.isFinite(input.gapPercent));
  });

  it('bounds a percentage, so a stray keystroke cannot invent a 900% gap', () => {
    assert.equal(readExposureInput({ gapPercent: '900' }).gapPercent, 100);
    assert.equal(readExposureInput({ gapPercent: '-5' }).gapPercent, 0);
    assert.equal(readExposureInput({ retentionPercent: '95' }).retentionPercent, 20);
  });

  it('never divides by zero, whatever is submitted', () => {
    const position = exposurePosition(readExposureInput({ liveContracts: '0', applicationsPerMonth: '0' }));
    for (const line of position.lines) assert.ok(!/NaN|Infinity/.test(line.value), line.value);
  });
});

describe('the page, over HTTP', () => {
  let server: Server;
  let base: string;

  before(async () => {
    const platform = new Platform();
    await seedDemoProject(platform);
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => server.close());

  it('is reachable by anybody, because a page that argues with your own numbers needs no account', async () => {
    const response = await fetch(`${base}/exposure`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /name="turnover"/);
    assert.match(html, /name="gapPercent"/);
  });

  it('computes and renders a position from a submitted form', async () => {
    const response = await fetch(`${base}/exposure`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        turnover: '40000000',
        liveContracts: '8',
        applicationsPerMonth: '1',
        gapPercent: '10',
        retentionPercent: '5',
      }).toString(),
    });
    assert.equal(response.status, 200, 'nothing is created, so this is not a 201');
    const html = await response.text();
    assert.match(html, /Your position/);
    assert.match(html, /missed pay less notice/);
    // £40m ÷ 96 windows × 10% = £41,666.
    assert.match(html, /£41,66/);
  });

  it('states its non-claims on the rendered page, not only in the type', async () => {
    const response = await fetch(`${base}/exposure`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ turnover: '10000000' }).toString(),
    });
    const html = await response.text();
    assert.match(html, /What this page does not claim/);
    assert.match(html, /industry average/);
  });

  it('keeps the submitted figures in the form, so a visitor can adjust one and resubmit', async () => {
    const response = await fetch(`${base}/exposure`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ turnover: '123456789', gapPercent: '12' }).toString(),
    });
    const html = await response.text();
    assert.match(html, /value="123456789"/);
    assert.match(html, /value="12"/);
  });
});
