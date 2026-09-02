import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { matchRoute, ROUTES } from '../src/api/routes.ts';
import { WRITE_PHASE_GATES } from '../src/identity/abac.ts';
import { Platform } from '../src/platform.ts';

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

/**
 * The console must not phase-gate a command that runs before a project exists.
 *
 * This one shipped. Every command on the pipeline screen rendered locked —
 * "Estimate tender cannot be written during the Operations phase" — while the
 * API accepted the identical command without complaint. The bid pipeline runs
 * against the tenant governance scope, which has no `Project` record and
 * therefore no lifecycle phase; the server gates only when
 * `attributes.lifecyclePhase` is present, so it never gated these at all. The
 * browser was applying the phase of whatever delivery project the console
 * happened to have selected.
 *
 * That is the browser holding a rule the server does not, which is precisely
 * the drift `blockedReason` exists to prevent — and it is invisible from the
 * server side, because nothing is refused. The person just sees a padlock and
 * assumes they lack the permission.
 *
 * The invariant, stated so a regression fails here rather than in front of a
 * bid manager: **a page that phase-gates a capability area must declare at
 * least one project-scoped path.** A page whose every endpoint is tenant-scoped
 * has no project to take a phase from, so gating on one is always wrong.
 */
describe('the console never phase-gates a command that has no project', () => {
  /** Areas whose writes the server gates by phase. Anything else cannot drift. */
  const GATED = new Set(Object.keys(WRITE_PHASE_GATES));
  const WRITE_CODES = new Set(['C', 'U', 'A', 'I', 'G']);

  /** `can('AREA', 'C')` / `blockedReason('AREA', 'U', OPTS)` — with any options. */
  const GATE_CALL = /\b(?:can|blockedReason)\(\s*'([A-Z_]+)'\s*,\s*'([A-Z])'\s*(,[^)]*)?\)/g;

  /**
   * Names bound to an options object that sets `tenantScoped: true`.
   *
   * A screen where every command is tenant-scoped declares the option once and
   * passes it by name, which reads far better at four call sites than the
   * literal repeated four times. The check has to understand that idiom rather
   * than force the worse-reading version to satisfy a regular expression.
   */
  function tenantScopedNames(source: string): Set<string> {
    const names = new Set(['tenantScoped']);
    for (const [, name, body] of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(\{[^}]*\})/g)) {
      if (/tenantScoped:\s*true/.test(body!)) names.add(name!);
    }
    return names;
  }

  for (const file of PAGE_FILES) {
    const source = readFileSync(join(PAGES_DIR, file), 'utf8');

    // Project-scoped is the server's own test: the route carries :projectId.
    const hasProjectScopedPath = pathsIn(source).some(
      (declared) => declared.includes('${projectId}') || declared.includes('/v1/projects/'),
    );
    if (hasProjectScopedPath) continue;

    const exempt = tenantScopedNames(source);
    const phaseGated = [...source.matchAll(GATE_CALL)]
      .filter(([, area, code, options]) => {
        if (!GATED.has(area!) || !WRITE_CODES.has(code!)) return false;
        return ![...exempt].some((name) => (options ?? '').includes(name));
      })
      .map(([, area, code]) => `${area}/${code}`);

    it(`${file} gates nothing on a phase it does not have`, () => {
      assert.deepEqual(
        [...new Set(phaseGated)],
        [],
        `${file} calls no project-scoped endpoint, so it has no lifecycle phase to gate on — ` +
          'yet it phase-gates these. Pass { tenantScoped: true }, or the commands render locked ' +
          'while the API accepts them.',
      );
    });
  }

  it('is actually looking at the screen this defect was found on', () => {
    // Without this, deleting the pipeline screen — or renaming the helper —
    // turns the whole block above into a loop over nothing that passes.
    const source = readFileSync(join(PAGES_DIR, 'pipeline.js'), 'utf8');
    assert.match(source, /tenantScoped:\s*true/, 'the pipeline screen no longer declares its commands tenant-scoped');
    assert.ok(tenantScopedNames(source).size > 1, 'the tenant-scoped options object is no longer resolvable by name');
    assert.ok(
      [...source.matchAll(GATE_CALL)].some(([, area]) => GATED.has(area!)),
      'the pipeline screen no longer gates a phase-gated area — this test has stopped checking anything',
    );
  });
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

describe('an HTML route must declare a policy its own page can live under', () => {
  /**
   * The defect this exists for, in full, because it shipped and nothing caught
   * it.
   *
   * `POST /exposure` returns a complete site page — header, footer and a
   * `<link>` to `/site.css`. It declared no `htmlPolicy`, so `sendHtml` used
   * its default of `SELF_CONTAINED`, whose `default-src 'none'` forbids an
   * external stylesheet. The browser blocked the stylesheet and rendered the
   * page as bare markup: every label, hint and input running together in one
   * paragraph, in the browser's default serif.
   *
   * Nothing failed anywhere. The route answered 200 with the correct
   * arithmetic in it, the markup assertions in `exposure.test.ts` all passed
   * because they read the HTML rather than the rendering, and the only person
   * who ever saw the broken version was a visitor who actually used the
   * calculator — the GET renders fine.
   *
   * So the check is on the pair, not on either half: a route that emits a link
   * or a script tag must declare a policy that permits it. A genuinely
   * self-contained page — `/verify`, `/verify-document`, `/unsubscribe` —
   * emits neither and stays under the tight default, which is the point of
   * having a tight default.
   */
  const platform = new Platform();

  const htmlRoutes = ROUTES.filter((route) => route.html === true);

  it('has HTML routes to check', () => {
    assert.ok(htmlRoutes.length >= 8, `${htmlRoutes.length} html routes found — the filter has stopped matching`);
  });

  for (const route of htmlRoutes) {
    it(`${route.method} ${route.pattern} declares a policy that permits what it emits`, async () => {
      let markup: string;
      try {
        markup = String(
          await route.handler(platform, {
            method: route.method,
            path: route.pattern,
            params: {},
            query: {},
            body: {},
            headers: {},
            correlationId: 'test',
            traceId: 'test',
          } as never),
        );
      } catch {
        // A handler that needs real state to render is out of scope here: this
        // asserts a property of the pairing, not that every page can be built
        // from an empty platform.
        return;
      }

      const policy = route.htmlPolicy ?? 'SELF_CONTAINED';
      const linksStylesheet = /<link\b[^>]*rel=["']?stylesheet/i.test(markup);
      const loadsScript = /<script\b[^>]*\bsrc=/i.test(markup);

      if (linksStylesheet || loadsScript) {
        assert.notEqual(
          policy,
          'SELF_CONTAINED',
          `${route.method} ${route.pattern} emits ${linksStylesheet ? 'a stylesheet link' : ''}` +
            `${linksStylesheet && loadsScript ? ' and ' : ''}${loadsScript ? 'a script src' : ''} ` +
            'under SELF_CONTAINED, whose `default-src \'none\'` blocks both. The page will render unstyled ' +
            "in a browser and pass every markup assertion. Set `htmlPolicy: 'PUBLIC_SITE'`.",
        );
      }
    });
  }
});
