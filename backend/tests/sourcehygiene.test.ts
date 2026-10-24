import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Whether the repository is actually made of text.
 *
 * ## The defect that produced this file
 *
 * Three source files — `identity/secrets.ts`, `evidence/pdftext.ts` and
 * `domain/cde.ts` — contained a **raw NUL byte** written straight into a
 * string literal, where the escape `\0` was meant:
 *
 *     const cacheKey = `${purpose}<the byte>${keyId(secret)}`;
 *
 * It runs correctly. It is also invisible in a review, and it makes the file
 * binary as far as every text tool is concerned. `grep` skips such a file with
 * a one-line notice that scrolls past; `sed`, `diff`, and a good many editors
 * treat it the same way. The way it was found is the point: a repository-wide
 * search during an audit silently covered 363 files instead of 366, and said
 * so in a line nobody would have read.
 *
 * A separator nobody can see is one nobody can verify, and a file three of the
 * tools in this repository will not read is a file that quietly falls out of
 * every scan built on them — including several of the invariants in this very
 * directory, which are source scans.
 *
 * ## What this file decides
 *
 * Three things an audit should not have to re-establish by hand, and which a
 * reviewer cannot see at all:
 *
 *   - source is text, with no control characters but tab and newline;
 *   - no file opens with a byte-order mark, which breaks a shebang and shows
 *     up as a stray character at the top of a diff;
 *   - no two files in the repository are byte-for-byte identical, which is the
 *     "one source of truth per concept" rule as something decided rather than
 *     asserted.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directories that are not this repository's source. */
const SKIP = new Set(['node_modules', '.git', 'dist', 'data', 'shots']);

function sourceFiles(from: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(path);
    }
  };
  for (const start of from) walk(join(REPO_ROOT, start));
  return found;
}

/**
 * Where text is the whole point.
 *
 * Code, configuration, scripts and prose. Binary fixtures are excluded by
 * extension rather than by directory, so a new PNG in a new folder does not
 * need this list changed — and a new `.ts` anywhere cannot escape it.
 */
const TEXT = /\.(ts|mts|js|mjs|json|css|html|md|yaml|yml|sh|sql|service|timer|Caddyfile)$/;

/** Tab, newline, carriage return. Everything else below 0x20 is not text. */
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

describe('the repository is made of text', () => {
  const files = sourceFiles(['backend/src', 'backend/tests', 'frontend', 'shared', 'tools', 'deploy', 'audit']).filter(
    (file) => TEXT.test(file),
  );

  it('is reading enough files for a pass to mean anything', () => {
    // A glob that silently matched nothing would make every assertion below
    // pass. This is the floor the repository was already well above when the
    // file was written.
    assert.ok(files.length > 400, `only ${files.length} files matched; the scan is broken`);
  });

  it('has no control characters outside tab and newline', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const at = text.search(CONTROL);
      if (at === -1) continue;
      const line = text.slice(0, at).split('\n').length;
      const code = text.charCodeAt(at).toString(16).padStart(2, '0');
      offenders.push(`${relative(REPO_ROOT, file)}:${line} contains 0x${code}`);
    }

    assert.deepEqual(
      offenders,
      [],
      'A raw control byte in source runs correctly and is invisible in review, and it makes the file binary to ' +
        'grep, sed and diff — so it drops out of every source scan in this directory. Write the escape (\\0, \\x1b) ' +
        `instead of the byte:\n  ${offenders.join('\n  ')}`,
    );
  });

  it('has no byte-order marks', () => {
    const offenders = files
      .filter((file) => readFileSync(file).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
      .map((file) => relative(REPO_ROOT, file));

    assert.deepEqual(offenders, [], `a BOM breaks a shebang and shows as a stray character at the top of a diff`);
  });

  it('holds no two files with identical contents', () => {
    /*
     * The duplicate-file rule, decided rather than asserted.
     *
     * Two byte-identical files are two places one thing can be changed, and
     * the second is the one that gets missed. Identical *content* rather than
     * similar names, because the pair that causes the damage is the one whose
     * names look unrelated.
     *
     * Empty files are excluded: several empty markers are not a duplication of
     * anything.
     */
    const byDigest = new Map<string, string[]>();
    for (const file of files) {
      const bytes = readFileSync(file);
      if (bytes.length === 0) continue;
      const digest = createHash('sha256').update(bytes).digest('hex');
      byDigest.set(digest, [...(byDigest.get(digest) ?? []), relative(REPO_ROOT, file)]);
    }

    const duplicated = [...byDigest.values()]
      .filter((paths) => paths.length > 1)
      .map((paths) => paths.join(' == '));

    assert.deepEqual(duplicated, [], `identical files are two places to change one thing:\n  ${duplicated.join('\n  ')}`);
  });
});

/**
 * One runtime version, declared in three places that must agree.
 *
 * `package.json` states the floor, `deploy/Dockerfile` runs the image, and CI
 * installs a Node to test against. They are necessarily three statements, and
 * three statements about one fact drift.
 *
 * The drift found in an audit was quieter than a disagreement: the floor was
 * right, the image was right, CI was right — and **nothing enforced the
 * floor**, so the development container ran v22.22.0, below the very advisory
 * the floor exists to clear, and every command in the repository ran without a
 * word. A requirement that is only observed where somebody happens to be
 * current is not a requirement.
 */
describe('the runtime floor is a requirement rather than a preference', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };

  it('declares a floor at or above the release the advisory needs', () => {
    const floor = manifest.engines?.node;
    assert.ok(floor, 'package.json states the Node version the platform requires');
    const [major, minor, patch] = (/(\d+)\.(\d+)\.(\d+)/.exec(floor) ?? []).slice(1).map(Number);
    assert.equal(major, 22, 'Node 22 is the LTS line this platform runs on');
    // 22.23.4 carries the October 2026 fix. `deploy/Dockerfile` explains at
    // length why the image tracks the line rather than a minor, so that it
    // cannot be capped below this.
    assert.ok(
      (minor ?? 0) > 23 || ((minor ?? 0) === 23 && (patch ?? 0) >= 4),
      `the floor is ${floor}, below the 22.23.4 the advisory needs`,
    );
  });

  it('enforces it, rather than stating it and installing anyway', () => {
    const npmrc = readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8');
    assert.match(
      npmrc,
      /^engine-strict=true$/m,
      'without engine-strict, `engines` is a comment: npm installs on any runtime and the floor is observed only ' +
        'by whoever is already current',
    );
  });

  it('tests on a runtime that satisfies it', () => {
    // CI installs Node 22 — the line, so the current patch, which is at or
    // above the floor by construction. Asserted because a pin to an older
    // minor here would put CI below the floor while every other file still
    // said the right thing.
    const ci = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yaml'), 'utf8');
    const pinned = /node-version:\s*'([^']+)'/.exec(ci)?.[1];
    assert.equal(pinned, '22', 'CI follows the LTS line, as the image does');
  });

  it('runs the image on the same line', () => {
    const dockerfile = readFileSync(join(REPO_ROOT, 'deploy/Dockerfile'), 'utf8');
    assert.match(dockerfile, /^FROM node:22-/m, 'the image tracks the line, not a capped minor');
  });
});
