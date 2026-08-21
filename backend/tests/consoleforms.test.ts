import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { matchRoute, ROUTES } from '../src/api/routes.ts';

/**
 * Every input form in the console posts to a route that exists.
 *
 * A form wired to a path with a typo, or to an endpoint that was renamed, looks
 * completely normal until somebody fills it in and presses submit. Nothing in
 * the type system catches it: the console is plain JavaScript by design, and
 * the path is a template string.
 *
 * This was not hypothetical. The procurement form was written against
 * `/v1/supply-chain/suppliers` to populate its supplier list; the route is
 * `/v1/supply-chain`. The fetch was wrapped in a `.catch(() => [])`, so the
 * page rendered perfectly with an empty picker and no error — a dead form that
 * looked finished.
 *
 * Anchored to this module rather than the working directory, so it holds
 * wherever the suite is run from.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PAGES_DIR = join(REPO_ROOT, 'frontend', 'pages');

/** Every `path:` a command spec declares, and every `api.get/post/put/delete`. */
function pathsIn(source: string): string[] {
  const found: string[] = [];

  // `path: '/v1/...'` and `path: \`/v1/...\`` on a command spec, including the
  // function form `path: (collected) => \`/v1/...\``.
  for (const match of source.matchAll(/path:\s*(?:\([^)]*\)\s*=>\s*)?[`'"]([^`'"]+)[`'"]/g)) {
    found.push(match[1]!);
  }
  // Direct client calls.
  for (const match of source.matchAll(/api\.(?:get|post|put|delete)\(\s*[`'"]([^`'"]+)[`'"]/g)) {
    found.push(match[1]!);
  }
  return found;
}

/**
 * Turn a console path into something the router can match.
 *
 * The console builds paths with interpolation, so `${projectId}` stands where a
 * route declares `:projectId`. Substituting a placeholder segment is enough for
 * `matchRoute` to resolve the pattern, which is what is being checked — not the
 * id itself.
 */
function concrete(path: string): string {
  return path
    .replace(/\$\{[^}]*\}/g, 'x')
    .split('?')[0]!;
}

/**
 * Endpoints the gateway answers before it consults the route table, so
 * `matchRoute` will never resolve them however correct they are.
 *
 * `/v1/routes` publishes the route table itself and is handled in
 * `gateway.ts` — it cannot be a row in the table it prints without describing
 * itself. Keep this list to routes that genuinely bypass the table; anything
 * else added here is a dead path being waved through.
 */
const GATEWAY_HANDLED = new Set(['/v1/routes']);

const PAGE_FILES = readdirSync(PAGES_DIR).filter((file) => file.endsWith('.js') && file !== 'index.js');

describe('every path the console calls resolves to a route', () => {
  it('reads more than a handful of pages, so a broken glob cannot pass this quietly', () => {
    assert.ok(PAGE_FILES.length >= 15, `only found ${PAGE_FILES.length} page modules — check the path`);
  });

  for (const file of PAGE_FILES) {
    it(`${file} calls only endpoints that exist`, () => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      const dead: string[] = [];

      for (const declared of pathsIn(source)) {
        // Only the API surface. Client-side routes and asset paths are not
        // gateway routes and have no pattern to match.
        if (!declared.startsWith('/v1/')) continue;

        const path = concrete(declared);
        if (GATEWAY_HANDLED.has(path)) continue;
        // A command spec does not say which verb it uses, and most are POST.
        // Matching against any verb is the right check: the question is whether
        // the *endpoint* exists, and a wrong verb fails loudly at runtime with
        // a 404 the person can see, unlike an empty picker.
        const resolved = ['GET', 'POST', 'PUT', 'DELETE'].some((method) => matchRoute(method, path));
        if (!resolved) dead.push(declared);
      }

      assert.deepEqual(dead, [], `these paths match no route:\n  ${dead.join('\n  ')}`);
    });
  }
});

describe('the input surface', () => {
  /**
   * A register, like the validation-debt one. The number is allowed to rise as
   * modules gain input surfaces and must not silently fall — a form removed by
   * accident is a module that quietly stops accepting work.
   */
  const MINIMUM_INPUT_FORMS = 38;

  it('has at least as many input forms as it did', () => {
    const forms = PAGE_FILES.reduce((total, file) => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      return total + [...source.matchAll(/^\s*fields:\s*\[/gm)].length;
    }, 0);

    assert.ok(
      forms >= MINIMUM_INPUT_FORMS,
      `${forms} input forms, down from ${MINIMUM_INPUT_FORMS}. A module has stopped accepting work.`,
    );
  });

  it('offers evidence upload where the record needs proof', () => {
    const uploads = PAGE_FILES.reduce((total, file) => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      return total + [...source.matchAll(/type:\s*'file'/g)].length;
    }, 0);

    // An observation without a photograph is an assertion; a notice without the
    // document is a claim about a document.
    assert.ok(uploads >= 18, `${uploads} evidence fields, fewer than the 18 recorded`);
  });
});

describe('the route table itself', () => {
  it('has no duplicate method and pattern', () => {
    // Two routes with the same pattern means the second is unreachable, and
    // which one wins depends on declaration order rather than intent.
    const seen = new Map<string, number>();
    for (const route of ROUTES) {
      const key = `${route.method} ${route.pattern}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    assert.deepEqual(duplicated, [], `duplicate routes:\n  ${duplicated.join('\n  ')}`);
  });
});
