import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { PERMISSION_MATRIX, type CapabilityArea, type PermissionCode } from '../src/identity/roles.ts';

/**
 * A command gated on a permission nobody holds.
 *
 * `authorise(ctx, area, code)` refuses unless some role in the matrix holds that
 * code on that area. Pick a pair no role holds and the command is not strict —
 * it is **unreachable**, by everybody, for ever, and the refusal blames the
 * caller's role. An owner holding every capability there is gets told to ask
 * somebody for permission.
 *
 * It is easy to do. The codes read like English — `I` for issue, `X` for
 * execute, `A` for approve — so the natural way to write a new command is to
 * pick the letter that fits the sentence rather than the letter the matrix
 * carries for that area. `issueBidResponse` was written that way on the day
 * this check was added: `ESTIMATE_TENDER` `I`, which reads perfectly and which
 * no role on the platform holds. The estimate side expresses a decision as an
 * approval.
 *
 * Both sides are checked, because the same mistake has two faces. On the server
 * it is a route that always 403s. In the console it is `can(area, code)` reading
 * the published matrix and returning false for every role, which renders as a
 * locked button under a tooltip that is not true.
 *
 * The check is exact rather than clever. It reads the literal pairs at the call
 * sites and asks the published matrix whether anybody holds them. A pair built
 * from a variable is skipped rather than guessed at — a check that guessed
 * would fail on working code, which is how a test gets deleted.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(HERE, '..', 'src');
const FRONTEND = join(HERE, '..', '..', 'frontend');

function sourceFiles(root: string, extension: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['icons', 'shots', 'media'].includes(entry.name)) walk(join(directory, entry.name));
      } else if (entry.name.endsWith(extension)) {
        files.push(join(directory, entry.name));
      }
    }
  };
  walk(root);
  return files;
}

/** Which roles hold this pair. Empty is the failure. */
function holders(area: string, code: string): string[] {
  return Object.entries(PERMISSION_MATRIX)
    .filter(([, areas]) => ((areas as Partial<Record<CapabilityArea, PermissionCode[]>>)[area as CapabilityArea] ?? []).includes(code as PermissionCode))
    .map(([role]) => role);
}

function scan(files: string[], pattern: RegExp, label: string): { checked: number; unreachable: string[] } {
  const unreachable: string[] = [];
  let checked = 0;

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const area = match[1]!;
      const code = match[2]!;
      checked += 1;
      if (holders(area, code).length > 0) continue;
      const line = source.slice(0, match.index).split('\n').length;
      unreachable.push(`${file.replace(join(HERE, '..', '..'), '')}:${line}: ${label} ${area} "${code}" — no role holds it`);
    }
  }

  return { checked, unreachable };
}

describe('every command is one that somebody can actually run', () => {
  it('authorises against pairs the permission matrix carries', () => {
    const { checked, unreachable } = scan(
      sourceFiles(BACKEND, '.ts'),
      /\bauthorise\(\s*ctx\s*,\s*'([A-Z_]+)'\s*,\s*'([A-Z])'/g,
      'authorise',
    );

    // A floor, so this cannot pass by finding nothing. If the call shape
    // changes the check must fail loudly rather than go quiet.
    assert.ok(checked > 500, `only ${checked} authorise call sites found; the scan is no longer reading them`);
    assert.deepEqual(
      unreachable,
      [],
      `commands gated on a permission no role holds, so nobody can ever run them and the refusal blames their role:\n  ${unreachable.join('\n  ')}`,
    );
  });

  it('gates the console on pairs the permission matrix carries', () => {
    const { checked, unreachable } = scan(
      sourceFiles(FRONTEND, '.js'),
      /\b(?:can|blockedReason)\(\s*'([A-Z_]+)'\s*,\s*'([A-Z])'/g,
      'console gate',
    );

    assert.ok(checked > 300, `only ${checked} console gate call sites found; the scan is no longer reading them`);
    assert.deepEqual(
      unreachable,
      [],
      `console gates no role can ever satisfy, so the control is a lock for everybody under a tooltip that is not true:\n  ${unreachable.join('\n  ')}`,
    );
  });
});
