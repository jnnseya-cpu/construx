import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feasibilityScheme, type FeasibilityInput } from '../src/domain/feasibility.ts';
import { feasibilityBriefBlocks, BRIEF_AI_SECTIONS } from '../src/domain/feasibilitybrief.ts';

/**
 * The brief assembles the feasibility scheme into a document. The prose is
 * composed from the figures, so the test's job is to prove the document carries
 * the scheme's own numbers and never a different one, and that the AI layer is
 * optional — the brief is complete with or without it.
 */

const input: FeasibilityInput = {
  schemeName: 'Birmingham 1 ha test scheme',
  authority: 'Birmingham City Council',
  tenure: 'Social rent',
  siteAreaHa: 1.0,
  mix: [
    { code: '2b4p-house', count: 10 },
    { code: '3b5p-house', count: 14 },
    { code: '1b2p-flat', count: 12 },
    { code: '2b4p-flat', count: 10 },
    { code: '3b5p-flat', count: 4 },
  ],
};

const scheme = feasibilityScheme(input);
const text = (blocks: ReturnType<typeof feasibilityBriefBlocks>) =>
  blocks.map((b) => ('text' in b ? b.text : 'rows' in b ? JSON.stringify(b.rows) : '')).join('\n');

describe('the brief is a complete, structured document', () => {
  const blocks = feasibilityBriefBlocks(scheme);

  it('opens with a level-1 title and the headline key-values', () => {
    assert.equal(blocks[0]?.kind, 'HEADING');
    assert.equal((blocks[0] as { level: number }).level, 1);
    assert.ok(blocks.some((b) => b.kind === 'KEY_VALUES'));
  });

  it('carries the seven numbered sections', () => {
    const headings = blocks.filter((b) => b.kind === 'HEADING' && (b as { level: number }).level === 2).map((b) => (b as { text: string }).text);
    for (const n of ['1.', '2.', '3.', '4.', '5.', '6.', '7.']) {
      assert.ok(headings.some((h) => h.startsWith(n)), `missing section ${n}`);
    }
  });

  it('includes the schedule, cost and programme tables', () => {
    const captions = blocks.filter((b) => b.kind === 'TABLE').map((b) => (b as { caption?: string }).caption);
    assert.ok(captions.some((c) => /mix/i.test(c ?? '')));
    assert.ok(captions.some((c) => /order-of-cost/i.test(c ?? '')));
    assert.ok(captions.some((c) => /programme/i.test(c ?? '')));
  });

  it('the schedule table rows match the scheme, with a totals row', () => {
    const scheduleTable = blocks.find((b) => b.kind === 'TABLE' && /mix/i.test((b as { caption?: string }).caption ?? '')) as { rows: string[][] };
    // One row per schedule line plus a totals row.
    assert.equal(scheduleTable.rows.length, scheme.schedule.length + 1);
    const totals = scheduleTable.rows[scheduleTable.rows.length - 1]!;
    assert.equal(totals[0], 'Total');
    assert.equal(totals[1], String(scheme.totals.homes));
    assert.equal(totals[2], String(scheme.totals.bedspaces));
  });
});

describe('the prose carries the scheme figures, not invented ones', () => {
  const body = text(feasibilityBriefBlocks(scheme));

  it('states the computed home count, density and outturn', () => {
    assert.match(body, new RegExp(`${scheme.totals.homes} `));
    assert.match(body, new RegExp(`${scheme.totals.densityDph} homes per hectare`));
    const outturnM = (scheme.costPlan.forecastOutturnMinor / 100 / 1_000_000).toFixed(2);
    assert.match(body, new RegExp(`£${outturnM}m`));
  });

  it('warns rather than overflowing when the mix exceeds the site', () => {
    const dense = feasibilityScheme({ ...input, mix: [{ code: '3b5p-house', count: 120 }] });
    const body2 = text(feasibilityBriefBlocks(dense));
    assert.match(body2, /exceed the red line|OVER SITE|WARNING/i);
  });
});

describe('the AI narrative layer is optional', () => {
  it('uses the deterministic fallback prose when no narrative is supplied', () => {
    const blocks = feasibilityBriefBlocks(scheme, {});
    const body = text(blocks);
    // The vision fallback mentions how houses sit against the existing edges.
    assert.match(body, /existing residential edges/);
    // And it does NOT claim a provider wrote it.
    assert.doesNotMatch(body, /reasoning provider/);
  });

  it('uses supplied narrative and marks it as advisory provider prose', () => {
    const blocks = feasibilityBriefBlocks(scheme, { vision: 'A model-written vision sentence about the place.', strategy: 'A model-written strategy sentence.' });
    const body = text(blocks);
    assert.match(body, /A model-written vision sentence/);
    assert.match(body, /reasoning provider/);
  });

  it('defines exactly the AI sections the brief slots in', () => {
    assert.deepEqual(BRIEF_AI_SECTIONS.map((s) => s.key).sort(), ['strategy', 'vision']);
    // Each has a usable deterministic fallback.
    for (const s of BRIEF_AI_SECTIONS) assert.ok(s.fallback(scheme).length > 40);
  });
});
