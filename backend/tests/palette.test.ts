import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { DASHES, SERIES, SERIES_SEPARABLE, TONES } from '../../frontend/lib/charts.js';

/**
 * The palette, measured.
 *
 * The Enterprise Visual Intelligence Standard asks for two things colour can
 * fail at silently: WCAG AA contrast in dark mode, and a palette that stays
 * readable to a reader with a colour-vision deficiency. Neither is visible by
 * looking, both are arithmetic, and the comment in `charts.js` claimed both for
 * a year without either having been computed.
 *
 * So they are computed here. A colour added to `SERIES` that collapses against
 * one already in it fails this file rather than shipping and being discovered
 * by somebody who cannot tell two lines apart.
 *
 * **What this is not.** Not a judgement about whether the palette is any good.
 * It answers two measurable questions — is there enough contrast, and do any
 * two series become the same colour under the common deficiencies — and says
 * nothing about the third, which is whether the chart was worth drawing.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(join(ROOT, 'frontend', 'app.css'), 'utf8');

type Rgb = [number, number, number];

/** The surfaces a chart is ever painted on, darkest to lightest. */
const SURFACES: Record<string, Rgb> = {
  'core-black': [9, 10, 13],
  carbon: [17, 19, 23],
  slate: [24, 27, 33],
  grey: [32, 36, 43],
  raised: [41, 46, 55],
};

/** WCAG 1.4.11: a graphical object needs 3:1. 1.4.3: text needs 4.5:1. */
const GRAPHICAL = 3;
const TEXT = 4.5;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

function parseRgb(value: string): Rgb {
  const found = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(value);
  if (found) return [Number(found[1]), Number(found[2]), Number(found[3])];
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  assert.ok(hex, `${value} is neither an rgb() nor a six-digit hex`);
  const digits = hex![1] as string;
  return [0, 2, 4].map((at) => Number.parseInt(digits.slice(at, at + 2), 16)) as Rgb;
}

/** A custom property's literal value out of `app.css`'s `:root` block. */
function token(name: string): string {
  const found = new RegExp(`--${name}:\\s*([^;]+);`).exec(CSS);
  assert.ok(found, `--${name} is not defined in app.css`);
  return (found![1] as string).trim();
}

/**
 * A colour as one of the three common dichromacies sees it.
 *
 * Brettel–Viénot–Mollon projection onto the plane the missing cone leaves,
 * which is the standard construction and the one the simulators people check
 * against are built on. It is applied in linear light, not on the sRGB values,
 * because doing it on the encoded values exaggerates separation in the darks
 * and this palette lives in the darks.
 */
function dichromat(rgb: Rgb, kind: 'protan' | 'deutan' | 'tritan'): Rgb {
  const [r, g, b] = rgb.map(channel) as Rgb;
  // sRGB linear to LMS.
  const l = 0.31399022 * r + 0.63951294 * g + 0.04649755 * b;
  const m = 0.15537241 * r + 0.75789446 * g + 0.08670142 * b;
  const s = 0.01775239 * r + 0.10944209 * g + 0.87256922 * b;

  let l2 = l;
  let m2 = m;
  let s2 = s;
  if (kind === 'protan') l2 = 1.05118294 * m - 0.05116099 * s;
  else if (kind === 'deutan') m2 = 0.9513092 * l + 0.04866992 * s;
  else s2 = -0.86744736 * l + 1.86727089 * m;

  // LMS back to sRGB linear.
  const lr = 5.47221206 * l2 - 4.6419601 * m2 + 0.16963708 * s2;
  const lg = -1.1252419 * l2 + 2.29317094 * m2 - 0.1678952 * s2;
  const lb = 0.02980165 * l2 - 0.19318073 * m2 + 1.16364789 * s2;

  const encode = (value: number): number => {
    const clamped = Math.max(0, Math.min(1, value));
    const out = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
    return Math.round(out * 255);
  };
  return [encode(lr), encode(lg), encode(lb)];
}

/**
 * Perceptual distance in CIE Lab, which is the space distance means something
 * in. RGB distance would call two dark colours close and two light ones far
 * apart for no reason a reader would recognise.
 */
function lab([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(channel) as Rgb;
  let x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  let y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  let z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (value: number): number => (value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe('the visual intelligence palette', () => {
  const series = SERIES.map(parseRgb);

  it('carries the standard’s eight series colours, blue first', () => {
    assert.equal(SERIES.length, 8, 'more than eight categorical series is a table somebody drew');
    assert.equal(new Set(SERIES).size, 8, 'a series colour appears twice');
    // CONSTRUX Blue is primary data, so a single-series chart is blue.
    const first = series[0] as Rgb;
    assert.ok(first[2] > first[0] && first[2] > first[1], `the first series is ${SERIES[0]}, which is not a blue`);
  });

  it('clears WCAG AA on every surface a chart is painted on', () => {
    const failures: string[] = [];
    for (const [index, colour] of series.entries()) {
      for (const [surface, ground] of Object.entries(SURFACES)) {
        const measured = contrast(colour, ground);
        if (measured < GRAPHICAL) {
          failures.push(`${SERIES[index]} on --${surface} is ${measured.toFixed(2)}:1, under the ${GRAPHICAL}:1 a mark needs`);
        }
      }
    }
    assert.deepEqual(failures, [], `\n${failures.join('\n')}\n`);
  });

  it('clears the text threshold too, so a series colour can label its own line', () => {
    // A value printed in its series colour is text, not a mark, and the whole
    // reason four of these were lifted off their published hex.
    const weak = series
      .map((colour, index) => ({ name: SERIES[index] as string, ratio: contrast(colour, SURFACES.raised as Rgb) }))
      .filter((entry) => entry.ratio < TEXT);
    assert.deepEqual(weak, [], `${weak.map((entry) => `${entry.name} is ${entry.ratio.toFixed(2)}:1 on --raised`).join(', ')}`);
  });

  /** The worst pair, in Lab, across all three dichromacies, among these colours. */
  const worstPair = (colours: Rgb[]): { distance: number; detail: string } => {
    let worst = { distance: Number.POSITIVE_INFINITY, detail: '' };
    for (const kind of ['protan', 'deutan', 'tritan'] as const) {
      const seen = colours.map((colour) => dichromat(colour, kind));
      for (let i = 0; i < seen.length; i += 1) {
        for (let j = i + 1; j < seen.length; j += 1) {
          const distance = deltaE(seen[i] as Rgb, seen[j] as Rgb);
          if (distance < worst.distance) {
            worst = { distance, detail: `${kind}: series ${i + 1} and ${j + 1} are ΔE ${distance.toFixed(1)} apart` };
          }
        }
      }
    }
    return worst;
  };

  /** Below this, two swatches on a screen read as one colour to most people. */
  const FLOOR = 11;

  it('keeps the first five separable under protanopia, deuteranopia and tritanopia', () => {
    // Five is the most this palette admits, and that is a fact about human
    // vision rather than about these eight hues: of every five-colour subset
    // containing CONSTRUX Blue, exactly two hold together, and no six-colour
    // subset does. The order in SERIES is what that measurement produced.
    const worst = worstPair(series.slice(0, SERIES_SEPARABLE));
    assert.ok(
      worst.distance >= FLOOR,
      `the separable prefix is not separable — ${worst.detail}, under the ΔE ${FLOOR} two colours need`,
    );
  });

  it('states honestly that hue stops carrying the distinction past the fifth', () => {
    // The point is not that the full set passes. It is that the full set is
    // *known* not to, that SERIES_SEPARABLE says where the line is, and that
    // nobody can quietly move a sixth colour up the list and present it as
    // safe. If a future palette does separate further this fails and the
    // constant gets raised, which is the outcome to want.
    const whole = worstPair(series);
    assert.ok(
      whole.distance < FLOOR,
      `the whole palette now separates (${whole.detail}); raise SERIES_SEPARABLE to ${SERIES.length}`,
    );
    assert.ok(SERIES_SEPARABLE < SERIES.length, 'SERIES_SEPARABLE claims the whole palette is safe');
    assert.equal(SERIES_SEPARABLE, 5);
  });

  it('defines the four plan-against-reality states, each with a stroke pattern as well as a colour', () => {
    // The standard's rule, and the reason it is a rule: a reader who cannot
    // separate blue from purple still has to tell a forecast from a fact.
    for (const state of ['actual', 'baseline', 'forecast', 'target', 'threshold']) {
      assert.ok(TONES[state as keyof typeof TONES], `the tone "${state}" is not defined`);
    }
    assert.equal(DASHES.baseline, '6 4', 'a baseline must be dashed');
    assert.equal(DASHES.forecast, '2 4', 'a forecast must be dotted');
    assert.equal(DASHES.threshold, '10 5', 'a threshold must be long-dashed');
    assert.equal(DASHES.actual, undefined, 'the measured line is the solid one');
    // The three patterned states must differ from one another, or the pattern
    // carries nothing that the colour was not already carrying.
    const patterns = [DASHES.baseline, DASHES.forecast, DASHES.threshold];
    assert.equal(new Set(patterns).size, 3, 'two states share a stroke pattern');
  });

  it('resolves every tone to a token app.css actually defines', () => {
    const missing: string[] = [];
    for (const [name, value] of Object.entries(TONES)) {
      const found = /^var\(--([a-z0-9-]+)\)$/.exec(value);
      assert.ok(found, `tone "${name}" is ${value}, which is not a custom property`);
      const property = (found as RegExpExecArray)[1] as string;
      if (!new RegExp(`--${property}:`).test(CSS)) missing.push(`${name} -> --${property}`);
    }
    assert.deepEqual(missing, [], `tones pointing at properties app.css does not define: ${missing.join(', ')}`);
  });

  it('keeps the published brand values intact beside the lifted ones', () => {
    // The lift is what dark mode costs, and it must not quietly become the
    // brand. Anywhere the colour is reproduced rather than read — an export, a
    // swatch, print — takes the standard's own hex.
    const published: Record<string, string> = {
      'blue-spec': '#146cff',
      'cyan-spec': '#16c7d9',
      'green-spec': '#18a957',
      'amber-spec': '#f2a900',
      'red-spec': '#d9363e',
      'purple-spec': '#7b61ff',
      'slate-spec': '#66788a',
      navy: '#0b1f33',
    };
    for (const [name, hex] of Object.entries(published)) {
      assert.equal(token(name).toLowerCase(), hex, `--${name} has drifted off the standard's published value`);
    }
  });

  it('lifted a mark only where the published value failed, and kept its hue', () => {
    // Hue is the brand; lightness is the accommodation. A "lift" that rotated
    // the hue would be a different colour wearing the same name.
    const lifted: Array<[string, string]> = [
      ['brand-blue', 'blue-spec'],
      ['brand-red', 'red-spec'],
      ['brand-purple', 'purple-spec'],
      ['brand-slate', 'slate-spec'],
    ];
    for (const [ink, spec] of lifted) {
      const lit = parseRgb(token(ink));
      const original = parseRgb(token(spec));
      assert.ok(
        contrast(original, SURFACES.raised as Rgb) < TEXT,
        `--${ink} was lifted off --${spec}, which already cleared ${TEXT}:1 and did not need it`,
      );
      assert.ok(contrast(lit, SURFACES.raised as Rgb) >= TEXT, `--${ink} still does not clear ${TEXT}:1 on --raised`);
      // Same hue family: the lift must not have crossed into another colour.
      const drift = Math.abs(Math.atan2(lab(lit)[2], lab(lit)[1]) - Math.atan2(lab(original)[2], lab(original)[1]));
      assert.ok(drift < 0.35, `--${ink} sits ${drift.toFixed(2)} rad off --${spec}; the lift changed the hue, not the lightness`);
    }
  });
});
