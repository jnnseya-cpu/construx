import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * A console page that references a name it never bound.
 *
 * Twice now. `operations.js` called `positionReport` without importing it, and
 * the screen died with `ReferenceError: positionReport is not defined` — an
 * operator's whole platform page, gone, on a build whose 3,787 tests passed.
 * Before that `design.js` read `underReview` above the line that declared it,
 * which killed Design & BIM for any role holding `A` on DESIGN_INFORMATION and
 * for nobody else.
 *
 * Neither is exotic. Both are what a linter catches in a project that has one,
 * and this one does not: zero runtime dependencies is a settled decision, and a
 * dev dependency for this would be the thin end of the same wedge. So the check
 * is here, narrow and doing one job.
 *
 * **What this is not.** It is not a JavaScript parser and must not grow into
 * one. It answers one question — is every name this file calls either imported,
 * declared, or a global — and a name it cannot classify is treated as fine. A
 * check that guesses would be turned off within a month.
 */

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend');

function pageFiles(): string[] {
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
  walk(FRONTEND);
  return files;
}

/**
 * The shared helpers a page reaches for.
 *
 * Listed rather than derived, because the failure is always the same shape: a
 * page uses one of the design system's functions and forgets the import. A name
 * outside this list is somebody's local function and none of this test's
 * business.
 */
const SHARED = [
  'badge', 'date', 'days', 'drillable', 'esc', 'exact', 'html', 'humanise', 'metric', 'modal',
  'money', 'notice', 'pct', 'positionReport', 'raw', 'render', 'resolveHtml', 'shortHash',
  'statusTone', 'table', 'time', 'toast', 'track',
  'command', 'commandBar', 'confirmCost', 'lookupPanel', 'wireLookups',
  'api', 'entities', 'entityBundle', 'insightPanel',
];

/** Every name this file binds: imported, declared, or assigned a function. */
function boundIn(source: string): Set<string> {
  const bound = new Set<string>();

  // `import { a, b as c } from '...'` and `import x from '...'`.
  for (const match of source.matchAll(/import\s+(?:\*\s+as\s+(\w+)|(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from/g)) {
    if (match[1]) bound.add(match[1]);
    if (match[2]) bound.add(match[2]);
    for (const name of (match[3] ?? '').split(',')) {
      const local = name.includes(' as ') ? name.split(' as ')[1] : name;
      const trimmed = (local ?? '').trim();
      if (trimmed) bound.add(trimmed);
    }
  }

  // Anything declared in the file, at any depth. Deliberately coarse: a local
  // shadowing a shared name is still a binding, and this test does not care
  // which one wins.
  for (const match of source.matchAll(/(?:const|let|var|function|class)\s+(\w+)/g)) bound.add(match[1]!);
  // Destructured bindings, which is how several of these arrive.
  for (const match of source.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=/g)) {
    for (const name of match[1]!.split(',')) {
      const local = (name.includes(':') ? name.split(':')[1] : name) ?? '';
      const trimmed = local.replace(/=.*$/, '').trim();
      if (trimmed) bound.add(trimmed);
    }
  }

  return bound;
}

describe('a console page binds every shared name it calls', () => {
  it('imports what it uses, on every page', () => {
    const missing: string[] = [];

    for (const file of pageFiles()) {
      const source = readFileSync(file, 'utf8');
      const bound = boundIn(source);

      for (const name of SHARED) {
        // A call, a tagged template, or a reference — not the word appearing in
        // a comment or a string, which is why this looks for the syntax rather
        // than the word.
        const used = new RegExp(`(?<![\\w.'"\`])${name}\\s*[(\`]`).test(source);
        if (used && !bound.has(name)) missing.push(`${file.replace(FRONTEND, 'frontend')} uses ${name} without binding it`);
      }
    }

    assert.deepEqual(
      missing,
      [],
      `a page references a name it never bound, which is a ReferenceError the moment somebody opens it:\n  ${missing.join('\n  ')}`,
    );
  });

  // The other half of this failure family is deliberately not checked here.
  //
  // `design.js` read `underReview` inside its render and declared it below —
  // a temporal dead zone, fatal only for the roles whose `can(...)` check
  // short-circuits far enough to reach it. Detecting that needs to know which
  // declarations are in scope at the point a template literal is evaluated,
  // and every approximation of it written for this file flagged half a dozen
  // pages that were correct.
  //
  // A check that cries wolf is one somebody deletes the week it blocks them,
  // and then neither half is covered. So this file does the one thing it can do
  // exactly, and the scope question waits for a real parser or stays a review
  // habit. Saying that is better than shipping a check that looks like cover.
});
