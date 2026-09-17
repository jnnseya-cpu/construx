import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { METRICS, METRIC_CADENCE, METRIC_IDS, METRIC_UNITS, metricNote } from '../../shared/metrics.js';
import { CAPABILITY_AREA_LIST } from '../src/identity/roles.ts';

/**
 * The governed metric catalogue.
 *
 * Section 8: "All charts must use governed semantic metrics with name,
 * definition, formula, unit, owner and refresh cadence." A catalogue that
 * carries five of the six for most of its entries is a document about
 * governance rather than governance, so every field is required here and a
 * metric missing one fails.
 *
 * The check that earns its place is the last one: a chart naming a metric that
 * is not in the catalogue. That is the failure mode a catalogue actually has —
 * not that it is wrong, but that it quietly stops being the place definitions
 * live, because somebody passed a string that looked right.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FRONTEND = join(ROOT, 'frontend');

function frontendFiles(): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!['icons', 'shots', 'media'].includes(entry.name)) walk(path);
      } else if (entry.name.endsWith('.js')) files.push(path);
    }
  };
  walk(FRONTEND);
  return files;
}

describe('the governed metric catalogue', () => {
  it('gives every metric all six things the standard requires', () => {
    const incomplete: string[] = [];
    for (const [id, entry] of Object.entries(METRICS)) {
      for (const field of ['label', 'definition', 'formula', 'unit', 'owner', 'cadence', 'source'] as const) {
        const value = (entry as Record<string, unknown>)[field];
        if (typeof value !== 'string' || value.trim() === '') incomplete.push(`${id} has no ${field}`);
      }
    }
    assert.deepEqual(incomplete, [], `\n${incomplete.join('\n')}\n`);
  });

  it('uses only the units and cadences it declares', () => {
    for (const [id, entry] of Object.entries(METRICS)) {
      assert.ok(METRIC_UNITS.includes(entry.unit), `${id} is in "${entry.unit}", which is not a unit this catalogue has`);
      assert.ok(
        METRIC_CADENCE.includes(entry.cadence),
        `${id} refreshes "${entry.cadence}", which is not a cadence this catalogue has`,
      );
    }
  });

  it('names an owner that is a role the platform actually has', () => {
    // An owner nobody can be is an owner nobody is. Checked against the
    // permission matrix's own role list rather than a second list here.
    const roles = new Set(CAPABILITY_AREA_LIST.length > 0 ? Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) ? {} : {}) : []);
    void roles;
    const known = new Set<string>();
    const source = readFileSync(join(ROOT, 'backend', 'src', 'identity', 'roles.ts'), 'utf8');
    for (const found of source.matchAll(/^\s{2}([A-Z_]+):\s*\{/gm)) known.add(found[1] as string);
    const unknown = Object.entries(METRICS)
      .filter(([, entry]) => !known.has(entry.owner))
      .map(([id, entry]) => `${id} is owned by ${entry.owner}`);
    assert.deepEqual(unknown, [], `\n${unknown.join('\n')}\nRoles the platform has: ${[...known].sort().join(', ')}`);
  });

  it('says what a metric is, not what it currently is', () => {
    // A catalogue carrying a value would be a second source of truth for every
    // number in the platform. The engines compute values, under permission.
    for (const [id, entry] of Object.entries(METRICS)) {
      assert.ok(!('value' in entry), `${id} carries a value, which belongs in an engine`);
      assert.ok(!('current' in entry), `${id} carries a current reading`);
    }
  });

  it('does not define the same thing twice under two names', () => {
    // Two metrics with one label is exactly the confusion the catalogue exists
    // to end, arriving from inside it.
    const labels = Object.values(METRICS).map((entry) => entry.label.toLowerCase());
    const duplicated = labels.filter((label, index) => labels.indexOf(label) !== index);
    assert.deepEqual([...new Set(duplicated)], [], 'two metrics share a label');
  });

  it('keeps trial and billed AI consumption as two metrics', () => {
    // An acceptance criterion in its own right: "Trial ACU and paid ACU are
    // separated commercially and visually." One metric with a flag would let a
    // chart add them by accident.
    assert.ok(METRICS.ACU_BILLED, 'billed AI consumption has no metric');
    assert.ok(METRICS.ACU_TRIAL, 'trial AI consumption has no metric');
    assert.notEqual(METRICS.ACU_BILLED.label, METRICS.ACU_TRIAL.label);
    assert.match(METRICS.ACU_TRIAL.definition, /never/i, 'the trial metric does not say it must not be summed with billed');
  });

  it('writes a one-line note a chart can show', () => {
    const note = metricNote('FORECAST_MARGIN_PERCENT');
    assert.match(note, /Forecast margin:/);
    assert.match(note, /Computed as/);
    assert.match(note, /Owned by commercial manager/);
    assert.equal(metricNote('NOT_A_METRIC'), '', 'an unknown metric should produce nothing, not a broken sentence');
  });

  it('is named by charts that exist, and never by a name it does not have', () => {
    // The failure a catalogue actually has: not being wrong, but quietly
    // ceasing to be where definitions live because somebody passed a string
    // that looked right.
    const unknown: string[] = [];
    let referenced = 0;
    for (const path of frontendFiles()) {
      const source = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ' ');
      for (const found of source.matchAll(/\bmetric:\s*'([A-Z][A-Z0-9_]*)'/g)) {
        referenced += 1;
        const id = found[1] as string;
        if (!METRIC_IDS.includes(id)) {
          const line = source.slice(0, found.index).split('\n').length;
          unknown.push(`${relative(ROOT, path)}:${line} names "${id}", which the catalogue does not define`);
        }
      }
    }
    assert.deepEqual(unknown, [], `\n${unknown.join('\n')}\n`);
    assert.ok(referenced > 0, 'no chart names a governed metric, so the catalogue governs nothing');
  });
});
