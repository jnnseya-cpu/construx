import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import * as vocabulary from '../../shared/vocabulary.js';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { CURRENCIES } from '../src/domain/locale.ts';
import { Platform } from '../src/platform.ts';

/**
 * The shared vocabulary, and what the API actually refuses.
 *
 * A dropdown offering a value the command will reject looks authoritative and
 * is wrong. The reverse — an API accepting a value no dropdown offers — is
 * worse, because it writes to an append-only ledger and cannot be taken back.
 *
 * Both were live. `currency` on project creation was an unconstrained string,
 * and a project created with `"not-a-currency"` was accepted against a running
 * server: the record is permanent, and every read that formats money against it
 * raises `CurrencyError`. Meanwhile the console's own currency list offered
 * three of the eighteen the platform counts in, and no page read it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let server: Server;
let base: string;

before(async () => {
  server = createGateway(new Platform());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('one list, two readers', () => {
  it('serves the vocabulary the backend imported, byte for byte', async () => {
    // Not "an equivalent list" — the same file. If the browser were served a
    // copy, the copy is the thing that drifts.
    const onDisk = await readFile(join(REPO_ROOT, 'shared', 'vocabulary.js'), 'utf8');
    const response = await fetch(`${base}/shared/vocabulary.js`);

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await response.text(), onDisk);
  });

  it('does not let a frontend file shadow it', async () => {
    // The shared mount is checked before the frontend root, so a file dropped
    // at frontend/shared/vocabulary.js cannot take over the path.
    const response = await fetch(`${base}/shared/vocabulary.js`);
    const body = await response.text();
    assert.match(body, /export const SITE_OBSERVATION_CATEGORY/);
  });

  it('refuses to walk out of the shared root', async () => {
    for (const attempt of ['/shared/../package.json', '/shared/%2e%2e/package.json', '/shared/../../etc/passwd']) {
      const response = await fetch(`${base}${attempt}`);
      assert.notEqual(response.status, 200, `${attempt} was served`);
    }
  });

  it('declares the lists in the frontend by re-export, never by re-declaration', async () => {
    const enums = await readFile(join(REPO_ROOT, 'frontend', 'lib', 'enums.js'), 'utf8');

    assert.match(enums, /from '\/shared\/vocabulary\.js'/, 'the frontend stopped reading the shared module');
    assert.ok(
      !/export const [A-Z_]+ = /.test(enums),
      'a vocabulary is being declared in the frontend again — that is the duplication this removed',
    );
  });
});

describe('what the API refuses', () => {
  /** Every `enum` array in a route schema, with the field it constrains. */
  function schemaEnums(): { field: string; values: string[] }[] {
    const found: { field: string; values: string[] }[] = [];
    const walk = (node: unknown, field: string): void => {
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.enum)) found.push({ field, values: record.enum as string[] });
      for (const [key, value] of Object.entries(record)) {
        if (key === 'properties' && value && typeof value === 'object') {
          for (const [name, child] of Object.entries(value as Record<string, unknown>)) walk(child, name);
        } else if (value && typeof value === 'object') {
          walk(value, field);
        }
      }
    };
    for (const route of ROUTES) if (route.schema) walk(route.schema, route.pattern);
    return found;
  }

  it('constrains a site observation to the categories the site walk offers', () => {
    const constraint = schemaEnums().find((e) => e.field === 'category' && e.values.includes('WORKMANSHIP'));
    assert.ok(constraint, 'the site observation category is no longer constrained');
    assert.deepEqual(
      [...constraint.values].sort(),
      vocabulary.values(vocabulary.SITE_OBSERVATION_CATEGORY).sort(),
      'the route enum and the dropdown have drifted apart',
    );
  });

  it('constrains diary weather to the conditions the diary form offers', () => {
    const constraint = schemaEnums().find((e) => e.field === 'conditions');
    assert.ok(constraint, 'diary weather is no longer constrained');
    assert.deepEqual(
      [...constraint.values].sort(),
      vocabulary.values(vocabulary.WEATHER_CONDITION).sort(),
    );
  });

  it('constrains a project currency to one the platform can count in', () => {
    // The specific defect. An unconstrained currency is a permanently broken
    // record, not a bad field: the ledger is append-only.
    const constraint = schemaEnums().find((e) => e.field === 'currency');
    assert.ok(constraint, 'project currency is an unconstrained string again');
    assert.deepEqual([...constraint.values].sort(), Object.keys(CURRENCIES).sort());
  });

  it('keeps the currency list out of the browser entirely', async () => {
    // The console used to carry its own list of three. Anybody running an AED
    // or JPY project could not select their own currency, though the platform
    // counts in eighteen and the API accepted them. There is no correct
    // hardcoded subset, so the frontend holds none: `GET /v1/localisation`
    // publishes the real set, which is the mechanism settled decision 6
    // already established for the permission matrix and phase gates.
    const shared = await readFile(join(REPO_ROOT, 'shared', 'vocabulary.js'), 'utf8');
    const enums = await readFile(join(REPO_ROOT, 'frontend', 'lib', 'enums.js'), 'utf8');

    for (const [name, source] of [['shared/vocabulary.js', shared], ['frontend/lib/enums.js', enums]] as const) {
      assert.ok(
        !/\bGBP\b/.test(source),
        `${name} has started carrying currency codes again — they belong to the platform's own table`,
      );
    }
    assert.ok(Object.keys(CURRENCIES).length > 3, 'the currency table shrank to the size of the old dropdown');
  });
});

describe('the request-validation debt', () => {
  /**
   * A register, in the same spirit as `NOT_EMITTED` in catalogue.test.ts: the
   * number is allowed to fall and never to rise. `validateRequest` returns
   * immediately when a route carries no schema, and no entity schema is
   * registered on the ledger either, so for these routes nothing checks the
   * request body at runtime — TypeScript types are erased under
   * `erasableSyntaxOnly` and check nothing at all.
   *
   * This is recorded rather than fixed here because writing the missing schemas
   * is a separate, larger piece of work. What must not happen is that it grows
   * quietly while nobody is counting.
   */
  const UNVALIDATED_WRITE_ROUTES = 97;

  it('has no more unvalidated write routes than it did', () => {
    const writes = ROUTES.filter((route) => route.method !== 'GET');
    const unvalidated = writes.filter((route) => !route.schema);

    assert.ok(
      unvalidated.length <= UNVALIDATED_WRITE_ROUTES,
      `${unvalidated.length} write routes accept an unvalidated body, up from ${UNVALIDATED_WRITE_ROUTES}. ` +
        `New routes need a schema:\n  ${unvalidated.map((r) => `${r.method} ${r.pattern}`).join('\n  ')}`,
    );

    assert.equal(
      unvalidated.length,
      UNVALIDATED_WRITE_ROUTES,
      `${unvalidated.length} write routes are unvalidated, fewer than the recorded ${UNVALIDATED_WRITE_ROUTES}. ` +
        'Lower the number in this test — the register is only useful while it is accurate.',
    );
  });

  it('validates every route that takes money or identity', () => {
    // The subset that cannot wait for the rest. A body that decides a payment,
    // a seat, a role or a spend cap is checked before it reaches a handler.
    const critical = ROUTES.filter(
      (route) =>
        route.method !== 'GET' &&
        /payment|invoice|topup|top-up|seats|subscription|caps|roles|certif/i.test(route.pattern),
    );

    assert.ok(critical.length > 0, 'the filter matched nothing — check the patterns');
    const missing = critical.filter((route) => !route.schema).map((r) => `${r.method} ${r.pattern}`);
    assert.deepEqual(missing, [], `these decide money or identity and take an unvalidated body:\n  ${missing.join('\n  ')}`);
  });
});
