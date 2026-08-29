import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * A screen about a project, and no project to be about.
 *
 * A new tenancy has no project. The sign-in path knows this and sends them to
 * Enterprise & Portfolio, which is where one is created — but that only covers
 * arriving by signing in. Arriving any other way, which is to say a reload, a
 * bookmark, a link or a browser restoring the tab, put the router on a
 * project-scoped screen with `state.project` still null, the page dereferenced
 * it, and the first thing a customer saw on their own platform was
 *
 *     Error
 *     TypeError: Cannot read properties of null (reading 'phase')
 *
 * The shell now refuses those screens with an empty state that points at where
 * a project comes from. That refusal is driven by one flag per navigation
 * entry, `tenantScoped`, and a flag is only as good as its agreement with what
 * the screen actually does — so this file checks that agreement rather than
 * trusting it.
 *
 * The rule, stated once: **a screen may call `/v1/projects/${…}/…` only if it
 * is project-scoped, or if every such call it makes is guarded.** Marking a
 * screen tenant-scoped while it reaches unguarded for the project id is
 * precisely how the crash comes back, and it is the one thing a reviewer would
 * not notice.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const shell = readFileSync(join(REPO_ROOT, 'frontend', 'app.js'), 'utf8');

/** The customer navigation, read out of the shell rather than restated here. */
function customerNav(): Array<{ id: string; label: string; tenantScoped: boolean }> {
  const start = shell.indexOf('export const NAV = [');
  const end = shell.indexOf('export const OPERATOR_NAV', start);
  assert.ok(start >= 0 && end > start, 'the customer navigation has moved or been renamed');

  const block = shell.slice(start, end);
  return [...block.matchAll(/\{ id: '([a-z]+)', label: '([^']+)'([^}]*)\}/g)].map((match) => ({
    id: match[1]!,
    label: match[2]!,
    tenantScoped: /tenantScoped:\s*true/.test(match[3]!),
  }));
}

/** Every project-scoped call a screen makes, and whether each one is guarded. */
function projectCalls(page: string): { total: number; unguarded: number } {
  const source = readFileSync(join(REPO_ROOT, 'frontend', 'pages', `${page}.js`), 'utf8');
  // `api.get(...)` / `api.post(...)` against a project path, up to the end of
  // that call. A guarded one carries `.catch(` before the statement ends.
  const lines = source.split('\n');
  const calls: Array<{ text: string; index: number }> = [];
  for (const [index, line] of lines.entries()) {
    if (/api\.\w+\(\s*`\/v1\/projects\/\$\{/.test(line)) calls.push({ text: line, index });
  }

  // Two idioms handle a failed call, and both count.
  //
  // `.catch(` on the call itself is the one a page load uses, because a panel
  // that cannot answer degrades to an empty state. A `try` opened immediately
  // above is the one a button uses, because there the refusal has to be shown
  // to the person who pressed it — `.catch(() => null)` would swallow the
  // sentence the platform wrote for them. Recognising only the first would
  // report the better-handled of the two as unguarded.
  const guarded = (call: { text: string; index: number }): boolean =>
    call.text.includes('.catch(') || (lines[call.index - 1] ?? '').trim() === 'try {';

  return { total: calls.length, unguarded: calls.filter((call) => !guarded(call)).length };
}

describe('the navigation agrees with what the screens actually read', () => {
  it('marks Enterprise & Portfolio first, because it is where a project comes from', () => {
    // Everything below it is about a project and a new tenancy has none, so the
    // four screens a customer used to meet first were the four that could not
    // answer anything yet.
    const nav = customerNav();
    assert.equal(nav[0]!.id, 'enterprise', `the first entry is now "${nav[0]!.id}"`);
    assert.equal(nav[0]!.tenantScoped, true, 'the screen that creates a project cannot itself need one');
  });

  it('lets no tenant-scoped screen reach for the project id unguarded', () => {
    // The flag says "this screen works without a project". An unguarded
    // project-scoped call in it makes that a lie, and the shell will have
    // rendered the screen on the strength of the flag.
    const offenders = customerNav()
      .filter((entry) => entry.tenantScoped)
      .map((entry) => ({ entry, calls: projectCalls(entry.id) }))
      .filter(({ calls }) => calls.unguarded > 0);

    assert.deepEqual(
      offenders.map((o) => `${o.entry.id} (${o.calls.unguarded} unguarded)`),
      [],
      'a screen marked tenant-scoped reads a project without handling its absence',
    );
  });

  it('marks every screen that needs a project as needing one', () => {
    // The other direction. A screen making project-scoped calls and *not*
    // marked is correct — that is the default — so what this catches is a
    // screen marked tenant-scoped that plainly is not, which the check above
    // only catches if the call happens to be unguarded.
    const wrongly = customerNav()
      .filter((entry) => entry.tenantScoped)
      .filter((entry) => {
        // Enterprise reads the seat position for the project in hand and
        // degrades when there is none — that is the one screen that is
        // legitimately both. Named, so a second entry has to be argued for.
        if (entry.id === 'enterprise') return false;

        // The second entry, argued. Pipeline & Bids is where a tender is
        // worked before there is a project to work it on — that is the whole
        // reason its commands are tenant-scoped, and it has to keep rendering
        // for a tenancy with nothing built yet.
        //
        // One panel on it is project-scoped and cannot be anywhere else: the AI
        // reading of an invitation is filed against a project, costs that
        // project's tenancy, and is gated by that project's lifecycle phase.
        // Putting it on a project screen instead would put it away from the
        // people who hold the invitation, which is how it came to have no door
        // at all for as long as it did.
        //
        // It is admitted here because it degrades rather than crashes: with no
        // project the panel renders a card saying so and makes no call, and
        // every other call on the screen is tenant-scoped.
        if (entry.id === 'pipeline') return false;
        return projectCalls(entry.id).total > 0;
      });

    assert.deepEqual(wrongly.map((entry) => entry.id), []);
  });

  it('guards the project-scoped screens in the shell rather than in each page', () => {
    // Twenty null checks is nineteen chances to forget the twentieth. The
    // condition is a fact about the session, so it is answered once.
    assert.match(
      shell,
      /!navEntry\.tenantScoped && !isOperator\(\) && !state\.project/,
      'the shell no longer refuses a project screen when there is no project',
    );
  });
});

describe('the interface tells the browser it is dark', () => {
  it('declares a colour scheme, so native controls are not painted light', () => {
    // Without this the `<select>` popup, the date and datetime pickers and the
    // scrollbars are drawn from the light system palette while their text
    // inherits the near-white `--text`. An open dropdown was white on white:
    // not low contrast, unreadable, on every form with a select in it.
    // Comments stripped first. The first version of this assertion matched the
    // whole file, and passed on the prose in the comment *explaining* the
    // declaration — so deleting the declaration itself left it green. Caught by
    // mutation; a test that passes when the thing it guards is removed is worse
    // than no test, because it reports that somebody checked.
    const css = readFileSync(join(REPO_ROOT, 'frontend', 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    assert.match(css, /color-scheme:\s*dark\s*;/, 'the dark colour scheme declaration has gone');
    assert.match(css, /select option[^{]*\{[^}]*color:/, 'the dropdown options no longer set their own colour');
  });
});
