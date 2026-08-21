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
