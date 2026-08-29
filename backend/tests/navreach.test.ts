import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PERMISSION_MATRIX, type CapabilityArea, type Role } from '../src/identity/roles.ts';

/**
 * A screen that refuses the person whose records it holds.
 *
 * Each navigation entry declares the capability area it is gated on, and the
 * shell refuses the whole screen to anybody without read on it. That is right
 * as far as it goes, and it went one area too far: a screen almost always
 * serves several, and the gate only ever asked about one of them.
 *
 * The instance that proved it: the Construction screen holds the five registers
 * a site runs on — permits, method statements, inductions, inspection plans,
 * non-conformances — and was gated on `SAFETY_RAMS`. The **QA/QC engineer**
 * owns the quality half of that screen and holds create, update *and approve*
 * on `QUALITY_COMMISSIONING`. They were refused the entire page, and the reason
 * on screen named an area they have no business holding. Every test passed.
 *
 * This is that class of defect made checkable. For every role and every screen:
 * if the reader holds a **write** on an area the screen actually offers actions
 * in, the gate must let them in. Reachability is a floor, not an authority —
 * each panel and each action still authorises itself, which is what makes
 * widening the gate safe rather than a way round the permission model.
 *
 * The areas a screen offers are read from the screen's own source (`can('AREA'`)
 * rather than from a list maintained beside it, because a hand-maintained list
 * is exactly what would drift back into the bug.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type NavItem = { id: string; label: string; gate: string[] };

/** The navigation model, parsed from the shell that owns it. */
function navItems(): NavItem[] {
  const source = readFileSync(join(REPO_ROOT, 'frontend', 'app.js'), 'utf8');
  const start = source.indexOf('export const NAV = [');
  assert.ok(start > 0, 'NAV is no longer declared in frontend/app.js');
  const body = source.slice(start, source.indexOf('\n];', start));

  const items = [...body.matchAll(
    /\{ id: '([a-z-]+)', label: '([^']+)', area: '([A-Z_]+)'(?:, alsoArea: \[([^\]]+)\])?/g,
  )].map((match) => ({
    id: match[1]!,
    label: match[2]!,
    gate: [match[3]!, ...(match[4] ? match[4].split(',').map((part) => part.trim().replace(/'/g, '')) : [])],
  }));

  assert.ok(items.length > 10, `only ${items.length} navigation entries parsed — the shape of NAV has changed`);
  return items;
}

/** The areas each page actually gates its own panels and actions on. */
function areasOffered(): Record<string, string[]> {
  const dir = join(REPO_ROOT, 'frontend', 'pages');
  const offered: Record<string, string[]> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.js'))) {
    const source = readFileSync(join(dir, file), 'utf8');
    offered[file.replace('.js', '')] = [...new Set([...source.matchAll(/can\('([A-Z_]+)'/g)].map((m) => m[1]!))];
  }
  return offered;
}

const WRITE_CODES = ['C', 'U', 'A', 'X'];

/**
 * Screens an operator reaches through their own navigation.
 *
 * Platform operators are barred from customer delivery data by construction, so
 * they hold `AI_EXECUTION` on the platform's own tenancy and are correctly
 * refused the project Autopilot. That is the permission model working, not a
 * screen with the wrong gate, and it is named here rather than left to weaken
 * the assertion for everybody else.
 */
const BARRED_FROM_DELIVERY: Role[] = ['PLATFORM_ADMIN'];

describe('a screen is reachable by everyone who can act on it', () => {
  it('never gates a screen on an area that shuts out one of its own writers', () => {
    const items = navItems();
    const offered = areasOffered();
    const problems: string[] = [];

    for (const [role, row] of Object.entries(PERMISSION_MATRIX) as Array<[Role, Partial<Record<CapabilityArea, string[]>>]>) {
      if (BARRED_FROM_DELIVERY.includes(role)) continue;

      for (const item of items) {
        const reachable = item.gate.some((area) => (row[area as CapabilityArea] ?? []).includes('R'));
        if (reachable) continue;

        const writes = (offered[item.id] ?? []).filter((area) =>
          (row[area as CapabilityArea] ?? []).some((code) => WRITE_CODES.includes(code)),
        );
        if (writes.length === 0) continue;

        problems.push(
          `${role} cannot open "${item.label}" (gated on ${item.gate.join(' or ')}) ` +
            `but holds writes on ${writes.join(', ')}, which that screen offers`,
        );
      }
    }

    assert.deepEqual(problems, [], `screens refusing their own writers:\n  ${problems.join('\n  ')}`);
  });

  it('gates every screen on an area the matrix actually has', () => {
    // A gate naming an area no role holds is a screen nobody can open, and it
    // reads as a permission problem rather than the typo it is.
    const known = new Set<string>();
    for (const row of Object.values(PERMISSION_MATRIX)) for (const area of Object.keys(row)) known.add(area);
    // Not in the delivery matrix by design: the platform's own administration
    // area, which customer accounts never hold and the shell refuses by name.
    known.add('PLATFORM_ADMINISTRATION');

    for (const item of navItems()) {
      for (const area of item.gate) {
        assert.ok(known.has(area), `"${item.label}" is gated on ${area}, which is not an area any role holds`);
      }
    }
  });
});
