import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * A chart asked for with a key its function does not take.
 *
 * Every chart in `frontend/lib/charts.js` is called with one options object and
 * destructures the keys it knows. JavaScript does not mind an unknown key. So
 * `funnelChart({ data: stages })` — where the parameter is `stages` — binds
 * `stages` to its default `[]`, the function takes its empty path, and the
 * screen renders one card fewer than it was written to render. Nothing throws,
 * nothing logs, the tests pass, and the panel is simply not there.
 *
 * It has happened twice: `funnelChart({ data })` on the contracts screen and
 * `treemap({ data })` on the team screen. Both were found by counting rendered
 * `figure.chart` elements in a browser, which is not a thing a test suite does.
 *
 * The check is a spelling check and nothing more. It reads the destructuring
 * pattern of each exported chart function, reads the top-level keys of each
 * call to one, and fails on a key that is not in the pattern. It does not check
 * types, values, or whether the chart is any good.
 *
 * **What this is not.** Not a JavaScript parser, and it must not become one. It
 * matches a call whose argument opens with `{` immediately, tracks brackets and
 * string literals to find the matching `}`, and splits the top level on commas.
 * A call it cannot read this way — an options object built in a variable, a
 * spread — is skipped rather than guessed at. A check that guesses gets turned
 * off, and then the blank card comes back.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRONTEND = join(ROOT, 'frontend');
const CHARTS = join(FRONTEND, 'lib', 'charts.js');

/** Functions that forward their whole options object to another chart. */
const FORWARDS: Record<string, { to: string; adds: string[] }> = {
  areaChart: { to: 'lineChart', adds: ['area'] },
  donutChart: { to: 'pieChart', adds: ['donut'] },
};

/**
 * The index of the bracket closing the one at `open`.
 *
 * Counts `{([` against `})]` and steps over string and template literals, so a
 * brace inside a label — `${value} people` — does not close the object early.
 * Returns -1 when nothing closes it, which the callers treat as unreadable.
 */
function closingBracket(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index] as string;
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') index += 1;
        index += 1;
      }
      continue;
    }
    if (character === '{' || character === '(' || character === '[') depth += 1;
    else if (character === '}' || character === ')' || character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The top-level comma-separated parts of an object body, strings kept whole. */
function topLevelParts(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index] as string;
    if (character === '\\') {
      current += character + (body[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      let literal = character;
      index += 1;
      while (index < body.length && body[index] !== quote) {
        if (body[index] === '\\') {
          literal += body[index];
          index += 1;
        }
        literal += body[index] ?? '';
        index += 1;
      }
      current += literal + quote;
      continue;
    }
    if (character === '{' || character === '(' || character === '[') depth += 1;
    else if (character === '}' || character === ')' || character === ']') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

/** Block comments removed, so a `/** @param {{data: …}} *\/` note is not read as code. */
function withoutBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** Every key each exported chart function destructures from its options object. */
function acceptedKeys(): Map<string, Set<string>> {
  const source = readFileSync(CHARTS, 'utf8');
  const accepted = new Map<string, Set<string>>();

  for (const match of source.matchAll(/export function (\w+)\(\s*\{/g)) {
    const name = match[1] as string;
    const open = source.indexOf('{', match.index + match[0].length - 1);
    const close = closingBracket(source, open);
    if (close < 0) continue;
    const keys = new Set<string>();
    for (const part of topLevelParts(withoutBlockComments(source.slice(open + 1, close)))) {
      const key = part.trim().split('=')[0]?.split(':')[0]?.trim() ?? '';
      if (/^[A-Za-z_$][\w$]*$/.test(key)) keys.add(key);
    }
    accepted.set(name, keys);
  }

  for (const [name, forward] of Object.entries(FORWARDS)) {
    const target = accepted.get(forward.to);
    assert.ok(target, `${name} forwards to ${forward.to}, which is not an exported chart`);
    accepted.set(name, new Set([...target, ...forward.adds]));
  }

  return accepted;
}

/** Every `.js` under `frontend/` other than the chart library itself. */
function frontendFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['icons', 'shots', 'media'].includes(entry.name)) walk(path);
      } else if (entry.name.endsWith('.js') && path !== CHARTS) {
        files.push(path);
      }
    }
  };
  walk(FRONTEND);
  return files;
}

describe('chart call sites', () => {
  const accepted = acceptedKeys();

  it('reads every chart function out of the library', () => {
    for (const name of ['barChart', 'lineChart', 'pieChart', 'funnelChart', 'treemap', 'ganttChart', 'radarChart', 'sankeyDiagram', 'flowChart']) {
      assert.ok(accepted.get(name)?.size, `${name} has no readable options pattern`);
    }
    assert.equal(accepted.get('funnelChart')?.has('stages'), true);
    assert.equal(accepted.get('funnelChart')?.has('data'), false);
    assert.equal(accepted.get('treemap')?.has('items'), true);
    assert.equal(accepted.get('donutChart')?.has('donut'), true);
  });

  it('never asks a chart for a key it does not take', () => {
    const wrong: string[] = [];
    let calls = 0;

    for (const path of frontendFiles()) {
      const source = withoutBlockComments(readFileSync(path, 'utf8'));
      for (const [name, keys] of accepted) {
        for (const match of source.matchAll(new RegExp(`\\b${name}\\(\\s*\\{`, 'g'))) {
          const open = source.indexOf('{', match.index + match[0].length - 1);
          const close = closingBracket(source, open);
          if (close < 0) continue;
          calls += 1;
          const line = source.slice(0, open).split('\n').length;
          for (const part of topLevelParts(source.slice(open + 1, close))) {
            const trimmed = part.trim();
            if (trimmed === '' || trimmed.startsWith('...') || trimmed.startsWith('//')) continue;
            const key = trimmed.split(':')[0]?.trim() ?? '';
            if (!/^[A-Za-z_$][\w$]*$/.test(key)) continue;
            if (!keys.has(key)) {
              wrong.push(
                `${relative(ROOT, path)}:${line} — ${name} was given "${key}", which it does not take. ` +
                  `It takes: ${[...keys].sort().join(', ')}`,
              );
            }
          }
        }
      }
    }

    assert.ok(calls > 60, `only ${calls} chart calls found — the scan stopped reading the console`);
    assert.deepEqual(wrong, [], `\n${wrong.join('\n')}\n`);
  });
});
