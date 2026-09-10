import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { CAPABILITY_AREA_LIST } from '../src/identity/roles.ts';

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

/**
 * The file with its comments taken out.
 *
 * Necessary, and narrow. These files carry long explanatory comments that name
 * the very helpers they are explaining — "`humanise` would render `OPENAI` as
 * Openai" reads as a call to `render` to a regex, and the check failed on prose
 * that was correct. A check that fails on comments is a check somebody weakens
 * or deletes, and then the ReferenceError it exists to catch comes back.
 *
 * Deliberately not a tokeniser. Block comments go, and so do lines that *begin*
 * with `//` or `*` — which is every comment these files actually contain. A
 * trailing `//` after code is left alone on purpose: stripping to end-of-line
 * would eat the rest of any line holding a `https://` URL, and hiding a real
 * usage is a worse failure than the one this fixes.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

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
      const raw = readFileSync(file, 'utf8');
      // Bindings are read from the whole file and usages only from the code:
      // a name imported inside a comment does not exist, but a name declared
      // in code and only mentioned in a comment is still bound.
      const source = withoutComments(raw);
      const bound = boundIn(raw);

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

/**
 * Every console module parses.
 *
 * This exists because the same call has now broken a page twice in one working
 * session, both times invisibly to every other check. Once with a *missing*
 * comma in a `Promise.all`, which is a syntax error — the module failed to
 * load, the view stayed empty, and the only trace was one line in a browser
 * console nobody was reading. Once with a *doubled* comma in the same call,
 * which leaves an array hole.
 *
 * Neither is reachable from the rest of the suite. The doors invariant greps
 * the console as text, the type checker never sees it, and the pages are only
 * exercised by driving a browser — which is exactly what gets skipped when the
 * change looked like adding one line to a fetch list.
 *
 * `node --check` rather than a regex and `new Function`: it is the same parser
 * the browser uses, with real module semantics, so a multi-line import or a
 * re-export is not a false positive. It parses and does not execute, so no
 * module runs and no import has to resolve.
 *
 * **It catches the first defect and not the second**, and the difference is
 * worth stating rather than glossing. `[a, , b]` is valid JavaScript, so no
 * parser will ever object to it; the hole is caught by the separate text check
 * below, and by driving the page — which is why the browser walkthrough is not
 * optional however green this file is.
 */
describe('the console is loadable', () => {
  it('parses every module the browser will be asked to load', () => {
    const broken: string[] = [];
    for (const file of pageFiles()) {
      const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (check.status !== 0) {
        const reason = (check.stderr ?? '').split('\n').find((line) => /Error|error/.test(line)) ?? 'did not parse';
        broken.push(`${file.replace(FRONTEND, 'frontend')}: ${reason.trim()}`);
      }
    }
    assert.deepEqual(broken, [], `console modules that will not load in a browser:\n  ${broken.join('\n  ')}`);
  });
});

/**
 * A hole in an array literal, which no parser will object to.
 *
 * `[a, , b]` is legal and evaluates to a three-element array whose middle
 * element is `undefined`. In a `Promise.all` destructured into named results
 * that shifts everything after it by one, so a page renders another endpoint's
 * answer under this endpoint's heading — or, as happened here, its own defaults
 * under both. It fails silently, in the output, at run time.
 *
 * A text check rather than a parse, because a parse cannot see it. The false
 * positive it risks is a deliberate sparse array, which this console has none
 * of and has no reason to have.
 */
describe('no array holes in the console', () => {
  it('leaves no doubled comma in an array or an argument list', () => {
    const found: string[] = [];
    for (const file of pageFiles()) {
      const source = readFileSync(file, 'utf8');
      source.split('\n').forEach((line, index) => {
        // A comma, then only whitespace, then another comma or a closing
        // bracket. Both forms are a hole.
        if (/,\s*,/.test(line) || /,\s*\]/.test(line)) {
          found.push(`${file.replace(FRONTEND, 'frontend')}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    assert.deepEqual(found, [], `array holes, which are valid JavaScript and shift every element after them:\n  ${found.join('\n  ')}`);
  });
});

/**
 * A layout class the design system never defined.
 *
 * `enterprise.js` rendered its refused-estate branch inside
 * `<div class="page-head">`. Every other header in the console is `view-head`,
 * `app.css` styles `view-head` and has never heard of `page-head`, and the one
 * occurrence in the whole console was on the branch a Supervisor, a QS or an
 * HSE manager sees when they open Enterprise & Portfolio — so those three roles
 * got an unstyled header: no flex, no h1 sizing, no margin, no subtitle colour.
 * It had been shipping.
 *
 * Nothing caught it because a class name is a string. The bindings check above
 * proves every *name* a page calls exists; this proves every structural class a
 * page paints exists too, which is the same question asked of the stylesheet.
 *
 * **Deliberately narrow.** Only the structural families the design system owns
 * — a header, a card, a notice, a metric, a table wrapper. State and utility
 * classes are generated, composed and toggled at run time, and a check that
 * tried to follow them would guess. `frontend/app.css` and `frontend/lib/ui.js`
 * are the two places a class may be defined, because those are the two places
 * the design system lives.
 */
describe('no console class the design system never defined', () => {
  it('paints only structural classes app.css or ui.js actually carries', () => {
    const css = readFileSync(join(FRONTEND, 'app.css'), 'utf8');
    const ui = readFileSync(join(FRONTEND, 'lib', 'ui.js'), 'utf8');

    // The families worth policing: each is a layout decision the stylesheet has
    // to make, so a name outside it renders as an unstyled div.
    //
    // `grid` joined the list after `security.js` was found painting
    // `class="grid-4"` twice. The design system's name is `grid g4`; `grid-4`
    // is defined nowhere, so those two rows had no `display: grid` and no gap
    // at all — four KPI cards that should have sat across the top of the
    // screen were stacked full-width down it, on every viewport, for every
    // role. A class name is a string, and this is the second defect of exactly
    // that shape.
    //
    // The suffix takes a digit as well as letters, because the whole point of
    // the grid family is that the number is in the name — `[a-z]+` alone would
    // have skipped `grid-4` even with `grid` in the list.
    const structural = /^(?:[a-z]+-)?(?:head|card|notice|metric|split-list|table-wrap|view|page|grid)(?:-[a-z0-9]+)?$/;

    const found: string[] = [];
    for (const file of pageFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/class="([^"$`]+)"/g)) {
        for (const name of match[1]!.split(/\s+/).filter(Boolean)) {
          if (!structural.test(name)) continue;
          if (css.includes(`.${name}`) || ui.includes(name)) continue;
          const line = source.slice(0, match.index).split('\n').length;
          found.push(`${file.replace(FRONTEND, 'frontend')}:${line}: class="${name}"`);
        }
      }
    }

    assert.deepEqual(
      found,
      [],
      `structural classes the design system never defined, so they render unstyled:\n  ${found.join('\n  ')}`,
    );
  });
});

/**
 * A capability area a page names that the permission matrix has never heard of.
 *
 * `api.read(path, area, sensitivity)` exists so a screen does not fire a read
 * its role will certainly be refused: the shell answers from the published
 * matrix and the request is never sent. That decision is
 * `matrix[role]?.[area] ?? []`, so a misspelt area is not a loud failure — it
 * is an empty permission list, which reads as "no role holds R here", which
 * withholds the panel from *every* role for ever, with no request in the
 * network tab to explain it. The screen simply has a hole in it.
 *
 * The same string is a plain data attribute in the navigation model, where the
 * consequence is a menu entry nobody can ever reach.
 *
 * Checked against `CAPABILITY_AREA_LIST` — the same closed list the API
 * publishes — rather than a copy, so an area added or renamed on the server
 * moves this check with it.
 */
describe('every capability area the console names is a real one', () => {
  it('reads and navigates against areas the permission matrix carries', () => {
    const known = new Set<string>(CAPABILITY_AREA_LIST);
    const found: string[] = [];

    for (const file of pageFiles()) {
      const source = readFileSync(file, 'utf8');
      const patterns = [
        // api.read('/v1/…', 'AREA') — the second argument, where it is a literal.
        /\bapi\.read\(\s*[^,)]+,\s*'([A-Z_]+)'/g,
        // The navigation model and every `blockedReason`/`can` call site.
        /\barea:\s*'([A-Z_]+)'/g,
        /\b(?:blockedReason|can)\(\s*'([A-Z_]+)'/g,
      ];
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const area = match[1]!;
          if (known.has(area)) continue;
          const line = source.slice(0, match.index).split('\n').length;
          found.push(`${file.replace(FRONTEND, 'frontend')}:${line}: ${area}`);
        }
      }
    }

    assert.deepEqual(
      found,
      [],
      `capability areas no role can ever hold, so the panel is withheld from everybody:\n  ${found.join('\n  ')}`,
    );
  });
});

/**
 * A command button that never says what it needs.
 *
 * `commandBar` renders an entry as a working button when `permitted` is true and
 * as a lock when it is anything else — and `undefined` is anything else. So an
 * entry written without a capability is not "unguarded", which would at least be
 * loud. It is **locked for everybody, permanently**, under the fallback tooltip
 * "Not permitted for your role" — a sentence that is false, because the command
 * is not outside anybody's role and the screen simply never asked.
 *
 * That is worse than the failure it looks like. A role problem sends somebody to
 * Team & Access, where an administrator finds nothing wrong, because nothing is.
 * The four doors on the Offline packs panel shipped this way: an owner, who
 * holds everything, saw four locks and a sentence telling them to ask
 * themselves for permission.
 *
 * The check is deliberately narrow. It does not judge *which* capability an
 * entry declares — that is a question about the server's own rules, and the
 * capability-area check above already refuses an area no role can hold. It
 * answers one question: does every entry declare one at all.
 *
 * Entries are found by brace-matching from `commandBar(`, rather than by a
 * regular expression over the whole call, because these lists run to twenty
 * entries carrying nested ternaries and object literals of their own, and a
 * pattern that tried to read them would either miss entries or invent them.
 */
describe('every command button declares the capability it needs', () => {
  it('has no entry that renders as a lock for every role including the owner', () => {
    const found: string[] = [];
    let entries = 0;

    for (const file of pageFiles()) {
      const source = readFileSync(file, 'utf8');
      let at = 0;

      while ((at = source.indexOf('commandBar(', at)) !== -1) {
        const open = source.indexOf('[', at);
        if (open === -1) break;

        // The bounds of the array literal.
        let depth = 0;
        let close = open;
        for (; close < source.length; close += 1) {
          if (source[close] === '[') depth += 1;
          else if (source[close] === ']') {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const block = source.slice(open, close + 1);

        // Each entry is an object literal at the top level of that array.
        let inside = 0;
        let start = -1;
        for (let i = 0; i < block.length; i += 1) {
          if (block[i] === '{') {
            if (inside === 0) start = i;
            inside += 1;
          } else if (block[i] === '}') {
            inside -= 1;
            if (inside === 0 && start !== -1) {
              const entry = block.slice(start, i + 1);
              entries += 1;
              if (!/\bpermitted\s*:/.test(entry)) {
                const line = source.slice(0, open + start).split('\n').length;
                const label = /\blabel\s*:\s*'([^']*)'/.exec(entry)?.[1] ?? entry.slice(0, 40);
                found.push(`${file.replace(FRONTEND, 'frontend')}:${line}: "${label}"`);
              }
              start = -1;
            }
          }
        }
        at = close;
      }
    }

    // A guard on the guard. If the brace matching above ever stops finding
    // entries, this check would pass by finding nothing rather than by
    // everything being right, which is the quietest way for a test to die.
    assert.ok(entries > 100, `only ${entries} command entries found; the scan is no longer reading the command bars`);

    assert.deepEqual(
      found,
      [],
      `command buttons that declare no capability, so they render as a lock for every role — including the ` +
        `owner — under a tooltip saying it is outside their role:\n  ${found.join('\n  ')}`,
    );
  });
});
