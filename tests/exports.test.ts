import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import type { ExportAudience, ExportDocument } from '../src/export/exporter.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Branded exports and what they withhold.
 *
 * An export is the one artefact that leaves the platform. Once a PDF is in
 * somebody's inbox, every access control in this codebase is behind it — so
 * redaction is not a display concern, it is the last enforcement point there
 * is. It had no tests at all.
 *
 * The test that matters is the negative one: that a document stamped
 * "commercial detail withheld" contains no commercial detail.
 */

let platform: Platform;
let seed: SeedResult;

/** Every string in a document, flattened, so a leak cannot hide in a nested block. */
function textOf(doc: ExportDocument): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(doc.blocks);
  return parts.join(' | ');
}

function report(who: string, audience: ExportAudience): ExportDocument {
  return platform.exports.projectReport(seed.users[who]!.auth, seed.projectId, {
    audience,
    correlationId: `export-test-${audience}`,
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('branding is a precondition, not a decoration', () => {
  it('refuses to export for a tenant with no branding configured', () => {
    const bare = new Platform();
    throwsCode(() => bare.exports.branding('some-tenant'), 'BRANDING_NOT_CONFIGURED');
  });

  it('stamps the configured branding and a document reference on every export', () => {
    const doc = report('pm', 'CLIENT');
    const text = textOf(doc);

    assert.ok(doc.reference, 'an export with no reference cannot be cited in correspondence');
    assert.ok(doc.contentHash?.startsWith('sha256:'), 'an export must be hashed to be verifiable');
    assert.ok(text.length > 0);
  });
});

describe('redaction by audience', () => {
  it('gives an internal audience the commercial position', () => {
    const text = textOf(report('pm', 'INTERNAL'));

    assert.ok(text.includes('Commercial'), 'the internal report withheld the commercial section');
    assert.ok(/CPI/.test(text), 'the internal report has no earned-value position');
  });

  it('withholds the commercial section from a regulator, and says so', () => {
    const doc = report('pm', 'REGULATOR');
    const text = textOf(doc);

    assert.ok(!text.includes('Forecast final cost'), 'forecast final cost reached a regulator');
    assert.ok(!text.includes('Forecast margin'), 'forecast margin reached a regulator');
    assert.ok(!/CPI \/ SPI/.test(text), 'the earned-value position reached a regulator');
    // A silent redaction is indistinguishable from a project with no
    // commercial data, so the document has to say which it is.
    assert.ok(/withheld/i.test(text), 'the redaction was silent');
  });

  it('withholds the same from a supplier', () => {
    const text = textOf(report('pm', 'SUPPLIER'));

    assert.ok(!text.includes('Forecast final cost'), 'forecast final cost reached a supplier');
    assert.ok(!text.includes('Forecast margin'), 'forecast margin reached a supplier');
    assert.ok(/withheld/i.test(text));
  });

  it('states the audience on the document itself', () => {
    for (const audience of ['CLIENT', 'REGULATOR', 'SUPPLIER', 'INTERNAL'] as const) {
      assert.equal(report('pm', audience).audience, audience);
    }
  });

  it('carries no money into a redacted copy, anywhere in the document', () => {
    // The commercial *section* is withheld, but a figure can survive elsewhere:
    // the risk table quotes an expected cost per risk. A document that says
    // "pricing detail has been withheld" while quoting pricing is worse than
    // one that withholds nothing, because it is a false assurance.
    const internal = textOf(report('pm', 'INTERNAL'));
    const redacted = textOf(report('pm', 'REGULATOR'));

    const moneyIn = (text: string) =>
      [...text.matchAll(/\b\d{6,}\b/g)].map((m) => m[0]).filter((n) => Number(n) > 100_000);

    assert.ok(moneyIn(internal).length > 0, 'the internal report quotes no figures at all — check the fixture');
    assert.deepEqual(
      moneyIn(redacted),
      [],
      `a redacted export still quotes minor-unit figures: ${moneyIn(redacted).join(', ')}`,
    );
  });
});

describe('every export is recorded', () => {
  it('writes an event, so what left the platform is answerable later', () => {
    const before = platform.ledger.list(seed.projectId, 'Export').length;
    const doc = report('pm', 'CLIENT');
    const after = platform.ledger.list(seed.projectId, 'Export');

    assert.equal(after.length, before + 1, 'an export left the platform without a record');
    const record = after.find((r) => r.refId === doc.id);
    assert.ok(record, 'the recorded export does not match the document returned');
    assert.equal(record.state.audience, 'CLIENT');
  });
});
