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

function consoleFiles(): string[] {
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
  return files;
}

function consoleSource(): string {
  return consoleFiles().map((file) => readFileSync(file, 'utf8')).join('\n');
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

  it('leaves no read route unreachable from the console', () => {
    // Zero, with no exemption list.
    //
    // Eighty-four were doorless when this assertion was first written — every
    // one an engine with an authorised route, passing tests and no screen. It
    // ran as a ratchet while they were closed (84 → 33 → 0) and is now the
    // plain assertion it was always meant to be.
    //
    // Two kinds of read had to be built to get here. A **position** answers on
    // load and became a panel. A **lookup** cannot answer until somebody
    // chooses what to ask about — one manifest, two schedules, an asset tag —
    // and became a chooser whose options come from records the page already
    // holds, so it can never offer an id the platform does not have.
    //
    // No exemption list, deliberately. A write with no curated panel still has
    // a generated door from `GET /v1/commands`; a read has no such fallback, so
    // an exemption here would be a permanent hiding place for exactly the thing
    // this test exists to prevent.
    //
    // Named, not merely counted. A failure has to say which capability lost its
    // door, because a number tells whoever reads it nothing about what to build.
    const source = consoleSource();
    const unreachable = readRoutes.filter((route) => !pathPattern(route.pattern).test(source));

    assert.equal(
      unreachable.length,
      0,
      `${unreachable.length} read routes have no console door. Each is a capability the platform ` +
        `authorises and nobody can reach:\n  ${unreachable.map((r) => r.pattern).join('\n  ')}`,
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
      // Project-scoped, or the platform's own marketing surface.
      //
      // The rule exists so nobody spends a tenancy's ACUs without seeing the
      // cost, and the quote is assembled from a project. `/v1/site/posts/draft`
      // has no project because it acts on the company's own website — the spend
      // lands on the platform's own metered wallet, and the operator pressing
      // the button is the person who owns that wallet.
      //
      // Named as an exception rather than the check being loosened to "most
      // routes". A second entry here should be argued for, not appended.
      //
      // The second entry, argued. `/v1/site/posts/audit` reads the company's
      // own published posts and returns what is wrong with them and what to
      // write next. It is the same surface as the draft, the same wallet, the
      // same operator, and it is refused to anybody else — so it belongs to the
      // same exception and not to a widened rule.
      //
      // What would *not* belong here is a route that spends a customer's ACUs
      // with no project to quote against. That is the failure this check exists
      // to prevent and no entry may be added for it.
      const PLATFORM_OWN = ['/v1/site/posts/draft', '/v1/site/posts/audit'];
      const platformOwn = PLATFORM_OWN.includes(route.pattern);
      assert.ok(
        route.pattern.includes(':projectId') || platformOwn,
        `${route.pattern} is quotable only if it is project-scoped, or spends the platform's own wallet`,
      );
    }
  });
});

/**
 * A perception task with no curated door.
 *
 * The write-door test above is satisfied by the generated command catalogue,
 * and for most writes that is the right answer: `GET /v1/commands` publishes
 * the schema and the console renders a form from it, so the door and the rule
 * come from one place.
 *
 * It is the wrong answer for perception. Every one of these routes takes a
 * single field — `hash` — which is the sha256 of a file the platform already
 * holds. A generated form asks for it in a text box. Nobody has an evidence
 * hash to hand, so the catalogue's door is a door in the sense that a bricked-up
 * arch is a door.
 *
 * That is not hypothetical. `ITT_REQUIREMENTS` was built end to end — the
 * prompt, the response schema, the route, a confirm branch running `analyseITT`
 * and `extractRequirements`, tests over all of it — and no page in the console
 * ever called it. The whole of "an ITT arrived, read it" was present in the
 * platform and absent from the product, and every existing invariant passed.
 *
 * So a perception task needs a page that lists the files it can read and offers
 * a button against each. No exemption list: an entry here would be the drawer
 * this test exists to empty.
 */
describe('every AI reading has a door somebody can open', () => {
  const perceptionRoutes = ROUTES.filter((route) => /\/perception\/[a-z-]+$/.test(route.pattern));

  it('has a route per published task, so this cannot pass by matching nothing', () => {
    // The guard on the guard. Were the route shape to change, the filter above
    // would quietly select zero routes and the assertion below would pass
    // while every reader was doorless.
    assert.ok(
      perceptionRoutes.length >= 8,
      `only ${perceptionRoutes.length} perception task routes matched — the filter no longer selects them`,
    );
  });

  it('offers each one from a page that knows which files it can read', () => {
    const source = consoleSource();
    const doorless = perceptionRoutes.filter((route) => !pathPattern(route.pattern).test(source));

    assert.equal(
      doorless.length,
      0,
      `${doorless.length} AI readings can only be reached by pasting an evidence hash into a generated form:\n  ` +
        doorless.map((r) => r.pattern).join('\n  '),
    );
  });

  it('offers the reading beside the work it belongs to, not on one page for all of them', () => {
    // A single "AI readings" screen would be the tidy answer and the wrong one.
    // A drawing is read where drawings are managed, a site photograph where the
    // field is, an invitation where the bid team works — because the person who
    // has the document is the person on that screen, and a reading filed from
    // somewhere else is a reading nobody checks against the document.
    const pages = new Map<string, string[]>();
    for (const file of consoleFiles()) {
      const text = readFileSync(file, 'utf8');
      const hits = perceptionRoutes.filter((route) => pathPattern(route.pattern).test(text));
      if (hits.length > 0) pages.set(file, hits.map((r) => r.pattern));
    }

    assert.ok(pages.size >= 3, `AI readings are offered from ${pages.size} page(s); they belong beside their own work`);

    // The invitation reader specifically, because it is the one that was
    // missing and the one a bid team asks for by name.
    const ittPage = [...pages.entries()].find(([, patterns]) => patterns.some((p) => p.endsWith('/perception/itt')));
    assert.ok(ittPage, 'no console page reads an invitation to tender');
    assert.match(ittPage[0], /pipeline\.js$/, 'the invitation reader belongs on the screen the bid team works from');
  });
});
