import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * The register has to be true, and nothing was checking that it was.
 *
 * `docs/traceability.md` is what somebody reads to find out what CONSTRUX
 * actually contains. It had drifted badly in one direction — **understating**
 * the build. Ten rows were audited against the code and every one of them was
 * wrong the same way:
 *
 * | Row | Said | Actually |
 * |---|---|---|
 * | PDF export | "a downstream concern" | `export/pdf.ts`, 898 lines, two routes, tested |
 * | Last Planner PPC | "not computed" | `reviewWeek()` computes it |
 * | Webhooks | "no broker wired" | `developer/webhooks.ts` |
 * | Evidence bytes | "no object store" | `evidence/store.ts` + an S3 driver |
 * | Project creation form | "not built" | a schema-generated door on the estate screen |
 * | Lineage traversal | "no traversal API" | a route that walks the chain both ways |
 * | Seat prices | "carry no role price" | every seat carries one |
 * | Packages | "the earlier prices" | the specified three |
 * | ACU bundles | "not a bundle" | the specified three |
 * | Shared status enums | "not consolidated" | `shared/vocabulary.js`, tested |
 *
 * Understatement is not the harmless direction. A register that says a finished
 * thing is unbuilt gets the work commissioned twice, and it tells whoever is
 * deciding whether to trust the product that most of it is a plan.
 *
 * A document cannot be asserted the way code can. What *is* assertable is that
 * every source file the register points at exists — which is what catches the
 * commonest way it rots, a row citing a module that has since moved, and what
 * makes a "Built" claim cost something to write.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const REGISTER = resolve(ROOT, 'docs/traceability.md');

/**
 * Paths in backticks that look like a source file in this repository.
 *
 * Deliberately narrow. The register also names bare modules by their engine
 * (`engines/planning.ts`) and identifiers with dots in them, and demanding that
 * every one of those resolve would turn a citation into a filing convention.
 * A path is only checked when it starts at one of the three roots, which is the
 * form that makes a definite claim about where something lives.
 */
const ROOTS = ['backend/', 'frontend/', 'shared/', 'docs/', 'deploy/'];

async function citedPaths(): Promise<string[]> {
  const text = await readFile(REGISTER, 'utf8');
  const cited = new Set<string>();
  for (const match of text.matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|js|md|json|yaml|yml|sh))`/g)) {
    const path = match[1] as string;
    if (ROOTS.some((root) => path.startsWith(root))) cited.add(path);
  }
  return [...cited].sort();
}

describe('the traceability register points at code that exists', () => {
  it('cites at least a working sample of the build', async () => {
    // A guard on the guard. If the citation format ever changes, the assertion
    // below would pass on an empty list and report a healthy register while
    // checking nothing at all.
    const paths = await citedPaths();
    assert.ok(paths.length >= 20, `only ${paths.length} rooted paths cited — has the citation format changed?`);
  });

  it('names no file that is not there', async () => {
    const paths = await citedPaths();
    const missing = paths.filter((path) => !existsSync(resolve(ROOT, path)));
    assert.deepEqual(
      missing,
      [],
      `the register cites files that do not exist:\n  ${missing.join('\n  ')}\n` +
        'Either the file moved and the row needs the new path, or the row is describing something that was ' +
        'never built and should not be citing a module for it.',
    );
  });

  it('keeps the status vocabulary closed', async () => {
    // The register's own legend publishes four statuses. A row inventing a
    // fifth — "Mostly", "In progress", "Planned" — is how a document stops
    // being answerable: each new word is a shade of done that nobody agreed
    // the meaning of, and the reader has to guess.
    const text = await readFile(REGISTER, 'utf8');
    const allowed = new Set(['Built', 'Partial', 'Design only', 'Not built', 'Not adopted']);
    const seen = new Set<string>();
    for (const line of text.split('\n')) {
      if (!line.startsWith('|')) continue;
      const cells = line.split('|').map((cell) => cell.trim().replace(/\*\*/g, ''));
      // A header row names its columns; it does not carry a status. Detected by
      // the column heading itself rather than by listing the first-column names
      // — the tables head that column Requirement, Engine, Clause and more, and
      // enumerating them here is a list that goes stale the next time one is
      // added. Without this the legend was the first thing to fail its own
      // assertion, reporting `Status` and `Meaning` as two invented statuses.
      if (cells[2] === 'Status' || cells[2] === 'Meaning') continue;
      // Column two is the status on every table in this document.
      const status = cells[2];
      if (!status || status.startsWith('---') || status === '') continue;
      // Long cells are prose, not a status: the tables that carry a status put
      // one word or two in that column.
      if (status.length > 14) continue;
      seen.add(status);
    }
    const unknown = [...seen].filter((status) => !allowed.has(status)).sort();
    assert.deepEqual(
      unknown,
      [],
      `statuses outside the published legend: ${unknown.join(', ')}. ` +
        'Add the word to the legend at the top of the document with what it means, or use one that is already there.',
    );
  });
});
