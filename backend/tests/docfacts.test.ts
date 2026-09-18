import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { ENGINE_CONTRACTS } from '../src/ai/orchestrator.ts';
import { SEATS } from '../src/billing/seats.ts';
import { PERMISSION_MATRIX, ROLE_ACCOUNT_LAYER, type Role } from '../src/identity/roles.ts';
import { LIFECYCLE_ORDER } from '../src/lifecycle/phases.ts';

/**
 * The documents restate facts the code owns. They are not allowed to be wrong
 * about them.
 *
 * ## The division of labour, so this file does not become a second one
 *
 * `backend/tests/gtm.test.ts` owns `docs/go-to-market/`: the generated editions
 * and every price the commercial plan quotes. **This file owns the engineering
 * documents** — `README.md`, `docs/SPEC.md`, `docs/architecture.md` — and a
 * different class of fact: counts, the role set, and the one seat-price
 * restatement `SPEC.md` deliberately keeps. Nothing is asserted in both files.
 *
 * ## What happened
 *
 * A sweep across the documentation found the same failure repeatedly: a number
 * derived from the code, written out in prose, and then left behind when the
 * code moved.
 *
 * `SPEC.md` said "the platform's fifteen roles" and "twenty-six existing roles
 * hold both create and approve" — of twenty-two roles, so the second was not
 * merely stale, it named more roles than exist. `README.md` and
 * `architecture.md` both said seven AI engines while `ENGINE_CONTRACTS` held
 * eight, and the Executive engine — the one added — was missing from the table
 * underneath. `SPEC.md`'s authority table said "**Executive** … No role" in the
 * present tense, three hundred lines above the section describing the role
 * being built.
 *
 * None of it failed anything. A reader could not tell which sentence was the
 * current one.
 *
 * ## The rule this enforces
 *
 * **A count that a document states about the platform is derived from the
 * platform.** Where prose can avoid stating one it now does, and where the
 * count carries the argument it is asserted here.
 *
 * Every scan below asserts it *found* what it was looking for. A regex that
 * silently matches nothing reads as a passing check and is worse than no check
 * at all.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...path: string[]): string => readFileSync(join(REPO, ...path), 'utf8');

const readme = read('README.md');
const spec = read('docs', 'SPEC.md');
const architecture = read('docs', 'architecture.md');
const phases = read('backend', 'src', 'lifecycle', 'phases.ts');

/** The number words the documents actually use, so `eight` can be compared with 8. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  'twenty-one': 21,
  'twenty-two': 22,
  'twenty-three': 23,
  'twenty-four': 24,
  'twenty-five': 25,
  'twenty-six': 26,
  'twenty-seven': 27,
  'twenty-eight': 28,
  'twenty-nine': 29,
  thirty: 30,
};

const WORD_ALTERNATION = Object.keys(WORD_NUMBERS)
  // Longest first, so `twenty-two` is not read as `twenty`.
  .sort((a, b) => b.length - a.length)
  .join('|');

/**
 * Every place a document counts `noun` — "eight AI engines", "seven states".
 * Returns the numbers found, so the caller can assert both the count and that
 * the scan matched something.
 */
function statedCounts(document: string, noun: RegExp): number[] {
  // Collapsed first: prose wraps, and "the seven states in\norder" is one
  // phrase that no single-line pattern would ever see.
  const flat = document.replace(/\s+/g, ' ');
  const pattern = new RegExp(`\\b(${WORD_ALTERNATION}|[0-9]+)\\s+(?:${noun.source})`, 'gi');
  return [...flat.matchAll(pattern)].map((match) => {
    const token = String(match[1]).toLowerCase();
    return WORD_NUMBERS[token] ?? Number(token);
  });
}

describe('the counts the documents state are the counts the code has', () => {
  it('counts AI engines the way `ENGINE_CONTRACTS` does', () => {
    const engines = Object.keys(ENGINE_CONTRACTS).length;
    const stated = [
      ...statedCounts(readme, /AI engines/),
      ...statedCounts(architecture, /AI engines/),
      ...statedCounts(spec, /AI engines/),
    ];
    assert.ok(stated.length >= 2, `the documents state ${stated.length} engine counts — this check matched nothing`);
    for (const value of stated) {
      assert.equal(value, engines, `a document states ${value} AI engines; ENGINE_CONTRACTS holds ${engines}`);
    }
  });

  it('lists every engine it counts, so the count and the table cannot disagree', () => {
    // The failure this exists for: the count said seven, the table listed seven,
    // and the Executive engine existed in code and appeared in neither.
    for (const engine of Object.keys(ENGINE_CONTRACTS)) {
      const human = engine.replace(/_/g, ' ').toLowerCase();
      const first = human.split(' ')[0]!;
      assert.match(
        readme.toLowerCase(),
        new RegExp(`\\b${first}\\b`),
        `README.md never mentions the ${engine} engine, which ENGINE_CONTRACTS holds`,
      );
    }
  });

  it('counts lifecycle phases the way `LIFECYCLE_ORDER` does', () => {
    /*
     * `states` alone is too broad — `SPEC.md` also counts the five states an
     * RFQ invitation moves through, which is a different finite set. The scan
     * is pinned to the two shapes the lifecycle is actually written in.
     */
    const stated = [
      ...statedCounts(spec, /states in order\b/),
      ...statedCounts(spec, /states, ordered\b/),
      ...statedCounts(spec, /states, and the real exit criteria/),
      ...statedCounts(readme, /lifecycle phases\b/),
    ];
    assert.ok(stated.length > 0, 'no document states a lifecycle phase count — this check matched nothing');
    for (const value of stated) {
      assert.equal(value, LIFECYCLE_ORDER.length, `a document states ${value} lifecycle states`);
    }
  });

  it('states no role count in prose that disagrees with the role set', () => {
    /*
     * Both known failures were here. This does not require a document to state
     * the count — the prose was rewritten to avoid it — but if one does, it has
     * to be right.
     */
    const roles = Object.keys(ROLE_ACCOUNT_LAYER).length;
    for (const [name, document] of [
      ['README.md', readme],
      ['docs/SPEC.md', spec],
      ['docs/architecture.md', architecture],
    ] as const) {
      for (const value of statedCounts(document, /(?:existing |platform )?roles\b/)) {
        assert.equal(value, roles, `${name} states ${value} roles; the platform has ${roles}`);
      }
    }
  });
});

describe('the authority gap SPEC.md records was actually closed', () => {
  /*
   * `SPEC.md` keeps the finding — five authority levels the specification named
   * and the platform had no role for — and then says all five were built. The
   * table is history and reads as history; this asserts the conclusion under it
   * is still true, so the section cannot quietly become a description of
   * something that was removed.
   */
  const RESOLVED: ReadonlyArray<readonly [Role, string]> = [
    ['EXECUTIVE', 'EXECUTIVE'],
    ['DEVELOPMENT_MANAGER', 'EXECUTIVE'],
    ['PROJECT_DIRECTOR', 'CONSTRUCTION_MANAGER'],
    ['COMMERCIAL_MANAGER', 'COMMERCIAL_MANAGER'],
    ['PRINCIPAL_DESIGNER', 'PRINCIPAL_DESIGNER'],
  ];

  it('holds all five as real roles with permissions and an account layer', () => {
    for (const [role] of RESOLVED) {
      assert.ok(ROLE_ACCOUNT_LAYER[role], `${role} is named as built in SPEC.md but has no account layer`);
      assert.ok(PERMISSION_MATRIX[role], `${role} is named as built in SPEC.md but is not in the permission matrix`);
      assert.match(spec, new RegExp(`\`${role}\``), `SPEC.md no longer names ${role}`);
    }
  });

  it('sells each of them on the seat SPEC.md says carries it', () => {
    // A role with no seat is a role nobody can be assigned — the reason the
    // seat column is in that table at all.
    for (const [role, seat] of RESOLVED) {
      assert.ok(
        SEATS[seat as keyof typeof SEATS]?.roles.includes(role),
        `SPEC.md sells ${role} on the ${seat} seat; that seat does not grant it`,
      );
    }
  });

  it('keeps the section in the past tense, so the finding is not read as the state', () => {
    // The table says "No role" five times. That was true when it was written
    // and is not true now, which is only safe while the framing says so.
    const heading = spec.indexOf('the authority vocabulary');
    assert.ok(heading > 0, 'the authority section is gone from SPEC.md');
    const section = spec.slice(heading, heading + 4_000);
    assert.match(
      section,
      /records a gap and its closure|at the time of the finding/i,
      'SPEC.md states "No role" for roles that exist, without saying the table is history',
    );
  });
});

describe('the one price SPEC.md restates is the price the platform charges', () => {
  it('reads the seat column out of the role table and checks it against the catalogue', () => {
    /*
     * `| ... | Executive, £120 |` — the last cell of each row in the authority
     * table. The document writes the seat by its short name; the catalogue
     * labels it in full ("Director / Executive"), so the seat is found by the
     * one label that contains the name. An ambiguous name fails rather than
     * being guessed at.
     */
    const quoted = [...spec.matchAll(/\|\s*([A-Z][A-Za-z ]+?), £([0-9,]+)\s*\|/g)];
    assert.ok(quoted.length >= 4, `SPEC.md quotes ${quoted.length} seat prices — this check matched nothing`);

    for (const [, name, pounds] of quoted) {
      const needle = String(name).trim().toLowerCase();
      const matches = Object.values(SEATS).filter((seat) => seat.label.toLowerCase().includes(needle));
      assert.equal(matches.length, 1, `SPEC.md names the "${name}" seat; the catalogue has ${matches.length} of them`);
      assert.equal(
        Math.round(Number(String(pounds).replace(/,/g, '')) * 100),
        matches[0]!.monthlyPriceMinor,
        `SPEC.md prices the ${name} seat at £${pounds}; the catalogue charges ${matches[0]!.monthlyPriceMinor} minor units`,
      );
    }
  });
});

describe('the rules the documents describe are the rules the code enforces', () => {
  it('backs SPEC.md on create and approve overlapping across most of the matrix', () => {
    /*
     * SPEC.md argues the permission matrix is not the separation-of-duties
     * mechanism, because roles routinely hold create and approve in one area.
     * The argument fails if that stops being true, so it is asserted rather
     * than counted in prose — an earlier draft counted it and got it wrong.
     */
    const overlapping = Object.entries(PERMISSION_MATRIX).filter(([, areas]) =>
      Object.values(areas).some((codes) => {
        const held = String(codes);
        return held.includes('C') && held.includes('A');
      }),
    );
    const total = Object.keys(PERMISSION_MATRIX).length;
    assert.ok(
      overlapping.length * 2 > total,
      `SPEC.md says create and approve overlap routinely; only ${overlapping.length} of ${total} roles hold both`,
    );
  });

  it('backs README.md on a forward step being allowed only over a phase already traversed', () => {
    // README describes the rule; `assertTransitionAllowed` is where it lives.
    // This pins the description to the implementation existing, not to its
    // wording — `startingphase.test.ts` and `stages.test.ts` prove the behaviour.
    assert.match(
      phases,
      /assertTransitionAllowed\([^)]*traversed/s,
      'README.md describes a traversed-phase forward step; phases.ts has no such parameter',
    );
    assert.match(
      readme,
      /forward step over a phase/i,
      'README.md no longer describes the forward-step rule that phases.ts implements',
    );
  });

  it('points at the gate criteria rather than restating them', () => {
    // The criteria are `PHASE_GATES`, published by the API. README names the
    // file so there is one place to read what a gate requires.
    assert.match(readme, /PHASE_GATES/, 'README.md no longer points at the gate catalogue it declines to restate');
    assert.ok(LIFECYCLE_ORDER.length > 0, 'the lifecycle is empty');
  });
});
