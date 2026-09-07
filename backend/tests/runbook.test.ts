import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ROUTES } from '../src/api/routes.ts';

/**
 * The runbook, walked — Gate 1.
 *
 * A runbook is read once, at three in the morning, by somebody who did not
 * write it, while something is broken. Its failure mode is not being wrong when
 * it was written; it is being *right when it was written and wrong now*, and
 * nothing about an ordinary change tells anybody a procedure has stopped
 * describing the platform.
 *
 * So the walk is executable. What is asserted is not prose quality — that is
 * not testable and should not pretend to be — but every load-bearing *name* the
 * runbook uses: the environment variables it tells an operator to set, the
 * endpoints it tells them to curl, the scripts it tells them to run, and the
 * error codes it tells them to recognise. Each is a thing that can quietly
 * cease to exist, and each would leave an operator following an instruction
 * that does nothing.
 *
 * The same discipline as the doors invariant, pointed at documentation instead
 * of at screens. A procedure nobody can execute is the operational equivalent
 * of a capability with no door.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runbook = readFileSync(join(REPO_ROOT, 'docs', 'RUNBOOK.md'), 'utf8');
const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');
const configSource = readFileSync(join(REPO_ROOT, 'backend', 'src', 'config.ts'), 'utf8');

/**
 * Everything the deployment itself reads, and everything the platform can say.
 *
 * Two corpora rather than one because the two questions are different: a
 * setting has to be readable by something that boots the service (config.ts,
 * `.env.example`, or the compose and deploy scripts, which carry their own —
 * `CONSTRUX_HOST_PORT` is real and `config.ts` has never heard of it), and a
 * code has to be a string the running platform can actually emit.
 */
const deploySource = readdirSync(join(REPO_ROOT, 'deploy'), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => readFileSync(join(REPO_ROOT, 'deploy', entry.name), 'utf8'))
  .join('\n');

const platformSource = ((): string => {
  const parts: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) parts.push(readFileSync(path, 'utf8'));
    }
  };
  walk(join(REPO_ROOT, 'backend', 'src'));
  return parts.join('\n');
})();

/** Every `CODE_LIKE_THIS` in backticks, which is how the runbook writes a name. */
function backticked(pattern: RegExp): string[] {
  return [...new Set([...runbook.matchAll(pattern)].map((found) => found[1]!))];
}

describe('every SHOUTED_NAME the runbook uses', () => {
  it('is a setting the deployment reads, or a code the platform raises — never neither', () => {
    // Classified rather than exempted, which is the difference between a check
    // and a list of things somebody once decided not to look at. A name in
    // backticks is one of two things: a setting an operator is told to set, or
    // a code they are told to recognise. Either is fine. Neither means the
    // runbook sends somebody to do something with no effect and then tells them
    // the job is done — and *that* is the failure this walk exists to catch.
    const named = backticked(/`([A-Z][A-Z0-9_]{4,})`/g)
      // Words that are shouted rather than named. Six of them, and a fixed
      // list rather than a pattern: a regex exemption grows silently.
      .filter((name) => !['NOTE', 'SIGTERM', 'SIGINT', 'FOLLOWER', 'PRIMARY', 'BROKEN'].includes(name));

    assert.ok(named.length > 20, `the runbook names only ${named.length} things; that is not this runbook`);

    const isSetting = (name: string): boolean =>
      configSource.includes(`'${name}'`) || envExample.includes(name) || deploySource.includes(name);
    const isCode = (name: string): boolean => platformSource.includes(name);

    const orphaned = named.filter((name) => !isSetting(name) && !isCode(name));

    assert.deepEqual(
      orphaned,
      [],
      `the runbook names ${orphaned.length} thing(s) that are neither a setting this deployment reads nor a code ` +
        `this platform raises:\n  ${orphaned.join('\n  ')}`,
    );
  });

  it('documents in .env.example every variable the production table demands', () => {
    // The table an operator works down before going live. Every row of it has
    // to be a variable they can actually find in the example file, or the
    // instruction "set this" has nowhere to be carried out.
    const table = runbook.slice(runbook.indexOf('## Configuration that decides whether this is production'));
    const rows = [...table.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((found) => found[1]!);
    assert.ok(rows.length >= 7, `the production configuration table has shrunk to ${rows.length} rows`);

    for (const name of rows) {
      assert.ok(
        envExample.includes(name),
        `${name} is in the production table and not in .env.example, so nobody can see what to set`,
      );
      assert.ok(configSource.includes(`'${name}'`), `${name} is in the production table and config.ts never reads it`);
    }
  });
});

describe('every endpoint the runbook tells an operator to call', () => {
  it('resolves to a route the gateway actually serves', () => {
    // Paths the runbook puts in a curl. A procedure whose first step is a 404
    // is worse than no procedure: it reads as the platform being broken in a
    // second way.
    const gateway = readFileSync(join(REPO_ROOT, 'backend', 'src', 'api', 'gateway.ts'), 'utf8');
    const servedDirectly = new Set(
      [...gateway.matchAll(/ctx\.path === '([^']+)'/g)].map((found) => found[1]!),
    );
    // `/readyz`, `/livez` and friends are answered before the route table.
    for (const probe of ['/readyz', '/livez', '/healthz']) {
      if (gateway.includes(probe)) servedDirectly.add(probe);
    }

    const declared = ROUTES.map(
      (route) =>
        new RegExp(
          `^${route.pattern
            .split('/')
            .filter(Boolean)
            .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
            .map((segment) => `/${segment}`)
            .join('')}$`,
        ),
    );

    const called = [...new Set([...runbook.matchAll(/(?:curl[^\n]*?|`)(\/(?:v1|readyz|livez|healthz)[A-Za-z0-9/_:-]*)/g)].map((f) => f[1]!))]
      // A trailing punctuation mark the prose put there, not part of the path.
      .map((path) => path.replace(/[.,:]$/, ''))
      // Placeholders the operator substitutes. `:id` is matched by the route
      // patterns above; `<something>` is prose and cannot be resolved.
      .filter((path) => !path.includes('<'));

    assert.ok(called.length > 0, 'the runbook tells an operator to call nothing at all');

    const unrouted = called.filter(
      (path) => !servedDirectly.has(path) && !declared.some((matcher) => matcher.test(path)),
    );

    assert.deepEqual(
      unrouted,
      [],
      `the runbook tells an operator to call ${unrouted.length} path(s) the gateway does not serve:\n  ${unrouted.join('\n  ')}`,
    );
  });
});

describe('every script and file the runbook tells an operator to run', () => {
  it('exists in the repository', () => {
    const referenced = [...new Set([...runbook.matchAll(/`(deploy\/[A-Za-z0-9._/-]+)`/g)].map((found) => found[1]!))];
    assert.ok(referenced.length >= 3, `the runbook references only ${referenced.length} deploy files`);

    const missing = referenced.filter((path) => !existsSync(join(REPO_ROOT, path)));
    assert.deepEqual(missing, [], `the runbook names files that are not in the repository:\n  ${missing.join('\n  ')}`);
  });
});

describe('every failure the runbook teaches an operator to recognise', () => {
  it('is a code the platform can actually produce', () => {
    // The boot refusals and follower refusal the runbook tabulates. A code that
    // has been renamed leaves an operator searching a log for a string that no
    // longer appears, and concluding the failure is something else.
    const codes = ['JOURNAL_CHAIN_BROKEN', 'LEDGER_FOLLOWER'];
    for (const code of codes) {
      assert.ok(runbook.includes(code), `${code} has fallen out of the runbook`);
      assert.ok(platformSource.includes(code), `the runbook teaches ${code} and nothing in the platform raises it`);
    }

    // The state-hash discrepancy is a *message*, not a code, and the runbook
    // now says so. It was tabled as `JOURNAL_STATE_MISMATCH` — a string nothing
    // raises — beside two genuine boot refusals, which got both the name and
    // the severity wrong. Pinned so it cannot drift back.
    assert.ok(
      !/`JOURNAL_STATE_MISMATCH`/.test(runbook),
      'JOURNAL_STATE_MISMATCH is back in the runbook as a code; nothing in the platform raises that string',
    );
    assert.ok(
      runbook.includes('records state hash'),
      'the runbook no longer shows the state-hash discrepancy in the words it actually appears in',
    );
  });
});

describe('the failover path names a real secret', () => {
  it('tells an operator standing up a follower to share GATEWAY_JWT_SECRET', () => {
    // The Gate 1 finding. It read `AUTH_JWT_SECRET` — a variable the platform
    // has never read — so an operator following it would have stood the standby
    // up on a different signing key, and every session token minted by the
    // primary would have been refused on it. Discovered during a failover,
    // which is the worst possible moment to discover it.
    const passage = runbook.slice(runbook.indexOf('A warm standby: follower mode'));
    assert.ok(passage.length > 0, 'the follower-mode passage has gone');
    assert.ok(
      /token minted by the primary works on it because the two share `GATEWAY_JWT_SECRET`/.test(passage),
      'the follower passage no longer names GATEWAY_JWT_SECRET as the shared signing key',
    );
  });
});

describe('what the runbook says this deployment does not have', () => {
  it('still says it, because that section is the honest half', () => {
    // The section that stops the runbook becoming marketing. It has been
    // shortened by real work more than once and it must never be shortened by
    // forgetting.
    const absent = runbook.slice(runbook.indexOf('## What this deployment does not have'));
    assert.ok(absent.length > 200, 'the "what this deployment does not have" section has gone or been emptied');
  });

  it('does not claim the restore drill has been rehearsed in a container, because it has not', () => {
    // The drill in `restoredrill.test.ts` rehearses the backup, the reassembly,
    // the hash check and the replay — everything that decides whether the
    // record survives. It does not rehearse Docker, and the runbook must go on
    // saying so until somebody runs the script on the host.
    assert.match(
      runbook,
      /has not been run in the build sandbox|first run on the host is the first drill/,
      'the runbook has stopped saying the container drill is unrun; it is either untrue or the note was lost',
    );
  });
});
