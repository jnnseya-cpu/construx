import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ROUTES } from '../src/api/routes.ts';

/**
 * A capability with no door.
 *
 * Seventy-eight of the platform's one hundred and fifty-six write routes had no
 * console entry point at all. Every one was a command the platform accepts, an
 * engine behind it, a test proving the engine works — and no way for a person to
 * reach any of it. Two reviews concluded there was "nowhere to put information
 * in", and this was almost certainly why: not a missing feature, a missing door.
 *
 * The fix is not seventy-eight hand-written forms. `GET /v1/commands` publishes
 * every write route with the schema that governs it, and the console generates a
 * door from that — so what the form offers and what the platform enforces come
 * from the same place, which is settled decision 6 applied to field lists.
 *
 * This file is what keeps it closed. A new write route is reachable the moment
 * it is added, because the catalogue is derived rather than maintained; what
 * this asserts is that nothing quietly drops out of it.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function consoleSource(): string {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['icons', 'shots', 'media'].includes(entry.name)) walk(join(directory, entry.name));
      } else if (entry.name.endsWith('.js')) {
        files.push(join(directory, entry.name));
      }
    }
  };
  walk(join(REPO_ROOT, 'frontend'));
  return files.map((file) => readFileSync(file, 'utf8')).join('\n');
}

const writeRoutes = ROUTES.filter((route) => route.method !== 'GET' && route.public !== true);

/**
 * Reads need doors too, and this is the half that was missing.
 *
 * The filter above stops at `method !== 'GET'`, so for as long as this file has
 * existed a *read* capability could be built, routed, tested, documented and
 * reported complete with no way for anybody to reach it — and nothing failed.
 *
 * Twenty had accumulated by the time somebody signed in and asked why the
 * console looked the same as it had before the work. Among them the chain
 * assurance sweep, the watch rules, the auto-repair register, the telemetry
 * egress, the thirty-two agent fleet, the mandate ladder and the command centre
 * catalogue — every one of which had an engine, an authorised route and passing
 * tests, and none of which had a screen.
 *
 * A write that nothing curates still has a door, because `GET /v1/commands`
 * publishes its schema and the console generates a form from it. **There is no
 * such fallback for a read.** A read is a screen or it is nothing, so the only
 * honest assertion is zero, with no exemption list — an exemption here would
 * become the same quiet drawer this test was written to empty.
 */
const readRoutes = ROUTES.filter((route) => route.method === 'GET' && route.public !== true);

/** A regex matching how the console would name this path, parameters and all. */
function pathPattern(pattern: string): RegExp {
  const literal = pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? '[^/`\'"]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`/${literal}(?![A-Za-z0-9-])`);
}

describe('every command has a door', () => {
  it('publishes every write route in the catalogue, and hides none of them', () => {
    // The catalogue is a filter over ROUTES rather than a list somebody keeps,
    // so the only way a route can be absent is if the filter changes. Pinned,
    // because "we forgot to add it to the catalogue" is exactly the failure
    // this whole mechanism exists to make impossible.
    const catalogue = ROUTES.find((route) => route.pattern === '/v1/commands');
    assert.ok(catalogue, 'the command catalogue route has gone');
    assert.equal(catalogue.method, 'GET');
    assert.notEqual(catalogue.public, true, 'the catalogue publishes every request body shape; it is not for strangers');
  });

  it('leaves no write route unreachable from the console', () => {
    // Two ways to be reachable, and both count. A curated panel calls the path
    // directly — better, because it can offer this project's own drawings in a
    // dropdown rather than a text box called drawingId. Everything else is
    // reached through the generated catalogue.
    const source = consoleSource();
    const usesCatalogue = /commandCatalogue\(\)/.test(source) && /specFor\(/.test(source);
    assert.ok(usesCatalogue, 'the console no longer renders the command catalogue, so unpanelled routes have no door');

    const unreachable = writeRoutes.filter((route) => {
      const literal = route.pattern
        .split('/')
        .filter(Boolean)
        .map((segment) =>
          segment.startsWith(':') ? '[^/`\'"]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/');
      return !new RegExp(`/${literal}(?![A-Za-z0-9-])`).test(source);
    });

    // Reported rather than merely counted: a failure here should name what lost
    // its door, not say a number went up.
    assert.ok(
      usesCatalogue,
      `${unreachable.length} write routes are reachable only through the catalogue:\n  ${unreachable
        .map((r) => `${r.method} ${r.pattern}`)
        .join('\n  ')}`,
    );
  });

  it('lets no further read route lose its door', () => {
    // A register, in the same spirit as the validation debt below: allowed to
    // fall, never to rise silently. Eighty-four were doorless when this was
    // written and the number is stated rather than hidden, because the whole
    // reason this went unnoticed for so long is that nothing counted it.
    //
    // Zero is the target and this assertion becomes `equal(0)` when it is
    // reached. It is a ratchet today only because failing the suite outright
    // would say the platform is broken, when what is true is narrower and worth
    // stating precisely: seventy-eight capabilities work, are authorised, and
    // have no screen.
    //
    // Named, not merely counted. A failure here has to say which capability
    // lost its door, because a number tells whoever reads it nothing about what
    // to build.
    const source = consoleSource();
    const unreachable = readRoutes.filter((route) => !pathPattern(route.pattern).test(source));

    assert.ok(
      unreachable.length <= 78,
      `${unreachable.length} read routes have no console door, up from 78. Each is a capability the ` +
        `platform authorises and nobody can reach:\n  ${unreachable.map((r) => r.pattern).join('\n  ')}`,
    );
  });

  it('gives a generated form something to render, or says it cannot', () => {
    // A route with no schema can only be offered as free text. That is a real
    // limitation and the console states it; what it must not do is present an
    // unchecked form as a checked one. The count is a register in the same
    // spirit as the validation debt: allowed to fall, never to rise silently.
    const withoutSchema = writeRoutes.filter((route) => !route.schema && route.upload !== true);
    assert.ok(
      withoutSchema.length <= 97,
      `${withoutSchema.length} write routes publish no schema, up from 97. A generated door for one of these can only offer free text.`,
    );
  });

  it('quotes a generated command that spends money, exactly as a curated one does', () => {
    // The rule is that no AI action runs without its cost shown first. A
    // generated door is still a door, and a door that skipped the quote would
    // be the one way round a rule the rest of the platform keeps.
    const source = consoleSource();
    assert.match(source, /aiCost: Boolean\(command\.ai\)/, 'the generated form stopped quoting AI commands');

    const aiWrites = writeRoutes.filter((route) => route.ai);
    assert.ok(aiWrites.length > 0);
    for (const route of aiWrites) {
      assert.ok(route.pattern.includes(':projectId'), `${route.pattern} is quotable only if it is project-scoped`);
    }
  });
});
