import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';

/** Anchored to this file, not to the working directory: the suite must give the
 * same answer run from the repository root, from `backend/`, or from a CI step
 * that sets its own cwd. */
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * The closed catalogue, checked against what the platform can actually do.
 *
 * An event type in the catalogue with no command able to emit it is a specific
 * and dangerous kind of hole. It reads as capability — it appears in the
 * catalogue, entity access classifies it, the control standard can require
 * evidence of it — while nothing in the platform can ever produce one. The
 * project control standard asked for a daily site diary and reported it missing
 * on every project, and it would have gone on reporting that forever, because
 * there was no command that could write one.
 *
 * It is the same defect that was found twice before by hand: a snag that could
 * be raised and never closed, and a pay less notice the platform said was
 * overdue while offering no way to give one. Finding it by hand a third time is
 * not a plan, so it is an invariant now.
 *
 * The rule: every event is either emitted somewhere, or named below with the
 * reason it is not. Silence is not an option — an unlisted dead event fails.
 */

/**
 * Events with nothing emitting them, and why.
 *
 * Every line here is a debt. Removing one means the capability was built, not
 * that the entry was deleted.
 */
const NOT_EMITTED: Record<string, string> = {
  // --- Design and specification: waiting on ingestion that is not built -----

  // --- The AI and ACU lifecycle --------------------------------------------
  //
  // These describe a Golden Thread record of AI spend. The ACU ledger is a
  // separate double-entry ledger in src/billing/acu.ts, and it is the one the
  // money is enforced from. Writing the same facts into the project ledger
  // would create a second source of truth for spend that could disagree with
  // the first, so these stay unemitted until there is a reason to reconcile
  // them deliberately rather than by accident.
  AI_REQUEST_QUEUED: 'AI execution is synchronous; nothing queues. AI_EXECUTION_COMPLETED carries the record.',
  AI_EXECUTION_FAILED: 'A failed call releases its ACU hold and raises to the caller; no project-state fact is created.',
  ACU_HELD: 'Held in the ACU ledger, which is the single source of truth for spend.',
  ACU_CONSUMED: 'Debited in the ACU ledger.',
  ACU_RELEASED: 'Released in the ACU ledger.',
  ACU_CAP_BREACHED: 'Enforced in the ACU ledger.',
  ACU_ALERT_RAISED: 'Raised from the ACU ledger.',

  // --- Platform internals ---------------------------------------------------
  REPLAY_SNAPSHOT_TAKEN:
    'Replay recomputes from the head of the chain rather than from a snapshot. Snapshotting is a performance measure with no measured bottleneck behind it.',

  // --- Not yet built --------------------------------------------------------
  POLICY_UPDATED:
    'The permission matrix is code, not data, so there is no PermissionPolicy record to change. The settings that genuinely are data — the AI spend caps — are recorded under ACU_CAPS_SET, which says what it is rather than borrowing this.',
};

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith('.ts') && entry.name !== 'eventTypes.ts') files.push(path);
  }
  return files;
}

/**
 * Every event type a command can emit.
 *
 * Reads the whole `eventType:` expression rather than only a literal directly
 * after the colon. A name written inside a ternary —
 * `eventType: recurred ? 'A' : 'B'` — is a real emission that the narrower
 * pattern could not see, which made both branches read as dead events. That is
 * exactly the silent hole this file exists to close, so the detector has to be
 * at least as clever as the code it audits.
 */
function emittedIn(corpus: string): Set<string> {
  const emitted = new Set<string>();
  // Up to the end of the line, so a ternary is covered and the next property is
  // not: an event name three lines further down belongs to a different write.
  for (const match of corpus.matchAll(/eventType:([^\n]*)/g)) {
    for (const literal of match[1]!.matchAll(/'([A-Z][A-Z0-9_]{3,})'/g)) emitted.add(literal[1]!);
  }
  return emitted;
}

describe('the closed event catalogue', () => {
  it('has a command behind every event, or a stated reason it has none', async () => {
    const files = await sourceFiles(SRC_ROOT);
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const corpus = sources.join('\n');

    const emitted = emittedIn(corpus);

    const dead = EVENT_TYPES.map((event) => event.code).filter((type) => !emitted.has(type));
    const undocumented = dead.filter((type) => !(type in NOT_EMITTED));

    assert.deepEqual(
      undocumented,
      [],
      `these event types are in the catalogue with nothing able to emit them, and are not named in NOT_EMITTED:\n  ${undocumented.join('\n  ')}\n` +
        'Either build the command, or record why it does not exist. A silent dead event reads as capability.',
    );
  });

  it('does not carry an excuse for an event that is in fact emitted', async () => {
    // The other direction. A stale entry here understates the platform, and the
    // list stops being a reliable statement of what is missing.
    const files = await sourceFiles(SRC_ROOT);
    const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const corpus = sources.join('\n');

    const emitted = emittedIn(corpus);

    const stale = Object.keys(NOT_EMITTED).filter((type) => emitted.has(type));
    assert.deepEqual(stale, [], `these are listed as not emitted but something emits them: ${stale.join(', ')}`);
  });

  it('names only real event types', async () => {
    const known = new Set(EVENT_TYPES.map((event) => event.code));
    const unknown = Object.keys(NOT_EMITTED).filter((type) => !known.has(type));
    assert.deepEqual(unknown, [], `NOT_EMITTED names event types that are not in the catalogue: ${unknown.join(', ')}`);
  });
});
