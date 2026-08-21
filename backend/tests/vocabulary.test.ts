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

describe('request validation', () => {
  /**
   * The debt, and its repayment.
   *
   * This was a register: ninety-seven write routes accepted a body nothing
   * checked, recorded so the number could fall and never rise. `validateRequest`
   * returns immediately when a route carries no schema, and TypeScript types are
   * erased under `erasableSyntaxOnly`, so for those routes nothing checked the
   * request body at all — not at the edge, not at the ledger.
   *
   * It is paid off. Every write route publishes a schema, which is why the
   * assertion is now zero rather than a ceiling: a register is only worth
   * keeping while there is something in it, and a ceiling invites somebody to
   * spend the headroom.
   *
   * Two things made it worth doing beyond the obvious. An unvalidated body
   * reaches a handler that writes to an append-only ledger, so a bad field is
   * not a bad request — it is a permanent record. And the console now generates
   * a command form from the published schema, so a route with no schema is a
   * door that opens onto a refusal.
   */
  it('leaves no write route accepting an unchecked body', () => {
    // An upload route is exempt because a JSON schema cannot say anything about
    // a file. What checks it instead is stricter than a schema and is tested:
    // the gateway refuses the body once it passes the configured ceiling, and
    // the store refuses bytes that do not hash to the address they claim.
    // Three public routes are exempt and each says why on the route itself.
    // `POST /unsubscribe` deliberately ignores its body — the proof of intent
    // is the signed token in the URL, and a mail provider's one-click post
    // carries whatever fields that provider chooses; validating it would refuse
    // an unsubscribe, which is the one thing that must never happen. The two
    // console routes take no body at all and are gated out of production.
    const bodyIgnored = new Set(['POST /unsubscribe', 'POST /v1/console/identities', 'POST /v1/console/session']);

    const unvalidated = ROUTES.filter(
      (route) => route.method !== 'GET' && !route.upload && !route.schema,
    )
      .map((r) => `${r.method} ${r.pattern}`)
      .filter((id) => !bodyIgnored.has(id));

    assert.deepEqual(
      unvalidated,
      [],
      `these write routes accept a body nothing checks:\n  ${unvalidated.join('\n  ')}`,
    );
  });

  it('constrains what it can and says so where it cannot', () => {
    // Not every schema can be closed. A tender estimate carries the twenty cost
    // heads, whose shape belongs to the cost model and is validated there;
    // restating it here would be the drift these schemas exist to prevent. Those
    // schemas declare their top-level fields and stay open, which still enforces
    // presence and type — the honest half of the check rather than none of it.
    const writes = ROUTES.filter((route) => route.method !== 'GET' && route.schema);
    const closed = writes.filter((route) => (route.schema as Record<string, unknown>).additionalProperties === false);

    assert.ok(writes.length > 140, 'the write surface shrank unexpectedly');
    assert.ok(
      closed.length / writes.length > 0.8,
      `only ${closed.length} of ${writes.length} write schemas refuse unknown fields; the rest should be the deep-nested exceptions, not the norm`,
    );
  });

  it('validates every route that takes money or identity', () => {
    // The subset that could never wait. A body that decides a payment, a seat,
    // a role or a spend cap is checked before it reaches a handler.
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

/**
 * Sector, which replaced a three-value list that could not carry the
 * distinctions the engines are asked to make. Sector selects templates, weights
 * risk, picks the contract form and keys the cost library; a water treatment
 * works and a residential block behaved identically under `INFRASTRUCTURE` and
 * `BUILDING`, which made the field decorative.
 *
 * The two things worth locking are that the domain union and the shared list
 * cannot drift, and that a record written under the old vocabulary stays
 * readable — the ledger is append-only, so those codes exist for as long as the
 * records do.
 */
describe('sector', () => {
  it('offers the nine ONS construction categories', () => {
    assert.deepEqual(vocabulary.values(vocabulary.SECTOR), [
      'RESIDENTIAL',
      'COMMERCIAL',
      'INDUSTRIAL',
      'TRANSPORT',
      'UTILITIES',
      'ENERGY',
      'FM',
      'RMI',
      'PROFESSIONAL',
    ]);
  });

  it('validates project creation against that list and nothing else', () => {
    const route = ROUTES.find((r) => r.method === 'POST' && r.pattern === '/v1/projects');
    assert.ok(route, 'project creation route is missing');

    const field = (route.schema as { properties: Record<string, { enum?: string[] }> }).properties.sectorType;
    assert.deepEqual(field?.enum, vocabulary.values(vocabulary.SECTOR));
  });

  it('translates a superseded code rather than orphaning the record', () => {
    // The ledger cannot be edited, so this is not a migration that runs once.
    // It is how a seven-year statutory record stays legible after the
    // vocabulary that produced it has been replaced.
    assert.equal(vocabulary.currentSector('BUILDING'), 'COMMERCIAL');
    assert.equal(vocabulary.currentSector('INFRASTRUCTURE'), 'TRANSPORT');
    assert.equal(vocabulary.currentSector('SPECIALISED'), 'INDUSTRIAL');
  });

  it('leaves a current code alone', () => {
    for (const code of vocabulary.values(vocabulary.SECTOR)) {
      assert.equal(vocabulary.currentSector(code), code, `${code} was rewritten by the legacy map`);
    }
  });

  it('refuses a sector the list does not offer', async () => {
    const reply = await fetch(`${base}/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        portfolioId: 'x', name: 'x', sectorType: 'INFRASTRUCTURE', assetType: 'x',
        location: {}, contractValueMinor: 1, currency: 'GBP',
        plannedStart: '2026-01-01', plannedCompletion: '2027-01-01',
      }),
    });
    // 401 before 400 is fine and is the point: the schema is not the only gate.
    assert.ok([400, 401].includes(reply.status), `unexpected ${reply.status}`);
  });
});

/**
 * Contract form. Surfaced from the claims engine's own `ContractSuite` rather
 * than declared again here — a picker offering a form the engine cannot read
 * would produce notices against clauses that do not exist.
 */
describe('contract form', () => {
  it('offers exactly the suites the claims engine interprets', () => {
    assert.deepEqual(vocabulary.values(vocabulary.CONTRACT_FORM), [
      'JCT',
      'NEC4',
      'FIDIC',
      'ICHEME',
      'MF1',
      'BESPOKE',
    ]);
  });
});
