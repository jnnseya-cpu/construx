import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { PACKAGES } from '../src/billing/seats.ts';
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

describe('what a trial does not include', () => {
  /**
   * The commercial line, and it is the whole product minus the thing you would
   * take to a client. A trial governs, records and computes; nothing gets out.
   *
   * The gate sits inside the exporter rather than on the routes, because there
   * is more than one way to produce a document and a per-route check is one
   * somebody forgets to add to the next one.
   */
  function tenantOn(packageTier: 'FREE_TRIAL' | 'CORE_PROJECT') {
    const p = new Platform();
    const { tenant } = p.createTenant({
      legalName: 'Evaluation Contracting Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: packageTier === 'FREE_TRIAL' ? 'FREE_TRIAL' : 'TEAM',
      package: packageTier,
      enterpriseName: 'Evaluation',
    });
    p.exports.setBranding(tenant.id, {
      clientName: 'Evaluation Contracting Ltd',
      primaryColour: '#ff6600',
      documentReferencePrefix: 'EVA',
      legalFooter: 'Issued under evaluation terms.',
    });
    return { platform: p, tenantId: tenant.id };
  }

  it('refuses an export on a trial package, and says why in commercial terms', () => {
    const { platform: trial, tenantId } = tenantOn('FREE_TRIAL');

    try {
      trial.exports.projectReport(
        { ...seed.users.pm!.auth, tenantId },
        seed.projectId,
        { audience: 'CLIENT', correlationId: 'trial-export' },
      );
      assert.fail('a trial account should not be able to export');
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'EXPORT_NOT_ENTITLED');
      // The message has to be a commercial one. "Forbidden" would read as a
      // permission fault and send somebody to their administrator.
      assert.match((error as Error).message, /does not include exporting or printing/);
      assert.match((error as Error).message, /governs, records and computes/);
    }
  });

  it('checks entitlement before branding, so the message is the useful one', () => {
    // A trial account with no logo configured should be told it is not on the
    // plan, not told to upload a logo it will then still be refused for.
    const trial = new Platform();
    const { tenant } = trial.createTenant({
      legalName: 'Unbranded Trial Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'FREE_TRIAL',
      package: 'FREE_TRIAL',
      enterpriseName: 'Unbranded',
    });

    throwsCode(
      () =>
        trial.exports.projectReport(
          { ...seed.users.pm!.auth, tenantId: tenant.id },
          seed.projectId,
          { audience: 'CLIENT', correlationId: 'unbranded-trial' },
        ),
      'EXPORT_NOT_ENTITLED',
    );
  });

  it('allows it on a paid package', () => {
    const { platform: paid, tenantId } = tenantOn('CORE_PROJECT');
    // Reaches the branding and content stage rather than the entitlement gate.
    // The seeded project belongs to another tenancy, so this fails on the data
    // rather than on the plan — which is the distinction under test.
    try {
      paid.exports.projectReport(
        { ...seed.users.pm!.auth, tenantId },
        seed.projectId,
        { audience: 'CLIENT', correlationId: 'paid-export' },
      );
    } catch (error) {
      assert.notEqual((error as { code?: string }).code, 'EXPORT_NOT_ENTITLED');
    }
  });

  it('refuses a tenancy with no subscription on record rather than defaulting open', () => {
    // A lookup that fails must not open the gate.
    const bare = new Platform();
    bare.exports.setBranding('ghost-tenant', {
      clientName: 'Ghost',
      primaryColour: '#ff6600',
      documentReferencePrefix: 'GHO',
      legalFooter: 'No subscription on record.',
    });

    throwsCode(
      () =>
        bare.exports.projectReport(
          { ...seed.users.pm!.auth, tenantId: 'ghost-tenant' },
          seed.projectId,
          { audience: 'CLIENT', correlationId: 'ghost-export' },
        ),
      'EXPORT_NOT_ENTITLED',
    );
  });


  it('does not block a regulator because the contractor has not paid', () => {
    // A regulator's export is an access the asset owner is obliged to provide.
    // Refusing it on the tenant's package would be this platform enforcing a
    // commercial term against a statutory right, which is not a trade-off it
    // gets to make.
    const { platform: trial, tenantId } = tenantOn('FREE_TRIAL');

    try {
      trial.exports.projectReport(
        { ...seed.users.regulator!.auth, tenantId },
        seed.projectId,
        { audience: 'REGULATOR', correlationId: 'regulator-on-trial' },
      );
    } catch (error) {
      assert.notEqual(
        (error as { code?: string }).code,
        'EXPORT_NOT_ENTITLED',
        'a regulator was blocked by the tenant\'s subscription',
      );
    }
  });

  it('does not block the platform operator, who has no package to be limited by', () => {
    const { platform: trial, tenantId } = tenantOn('FREE_TRIAL');

    try {
      trial.exports.projectReport(
        { ...seed.users.operator!.auth, tenantId },
        seed.projectId,
        { audience: 'INTERNAL', correlationId: 'operator-on-trial' },
      );
    } catch (error) {
      assert.notEqual((error as { code?: string }).code, 'EXPORT_NOT_ENTITLED');
    }
  });

  it('states the entitlement on the package rather than in the exporter', () => {
    // One place to read what a package includes.
    assert.equal(PACKAGES.FREE_TRIAL.export, false);
    assert.equal(PACKAGES.CORE_PROJECT.export, true);
    assert.equal(PACKAGES.PROFESSIONAL_DELIVERY.export, true);
    assert.equal(PACKAGES.ENTERPRISE.export, true);
  });
});
