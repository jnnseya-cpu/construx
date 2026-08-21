import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Generates every raster asset the installed application needs.
 *
 * These are committed rather than generated at boot, because a service worker
 * precaches them and a build step is a settled no for this repository. They are
 * generated rather than drawn, so the mark on the home screen cannot drift away
 * from `frontend/favicon.svg` — regenerate with `node tools/icons.mjs` after any
 * change to the brand.
 *
 * The PNG encoder is here because the alternative was a dependency. A PNG is a
 * signature, three chunks and a zlib stream, and `node:zlib` is built in, so
 * the whole encoder is shorter than the argument for adding one.
 */

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');

// --- Brand ------------------------------------------------------------------
// Matches frontend/favicon.svg and the --core-black / --orange tokens in app.css.

const BLACK = [12, 12, 14];
const WHITE = [255, 255, 255];
const ORANGE = [255, 102, 0];

// --- PNG --------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode 8-bit RGBA pixel data as a PNG. */
function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  // compression 0, filter 0, interlace 0 — all left at their only legal values.

  // Filter type 0 on every scanline. These images are flat colour and a couple
  // of strokes, so zlib reaches a few kilobytes without per-line filtering.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Geometry ---------------------------------------------------------------

/** Shortest distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Signed distance to a rounded rectangle; negative inside. */
function distanceToRoundedRect(px, py, x, y, w, h, r) {
  const cx = Math.abs(px - (x + w / 2)) - (w / 2 - r);
  const cy = Math.abs(py - (y + h / 2)) - (h / 2 - r);
  return Math.hypot(Math.max(cx, 0), Math.max(cy, 0)) + Math.min(Math.max(cx, cy), 0) - r;
}

function blend(target, offset, colour, alpha) {
  for (let c = 0; c < 3; c += 1) {
    target[offset + c] = Math.round(target[offset + c] * (1 - alpha) + colour[c] * alpha);
  }
  target[offset + 3] = Math.round(target[offset + 3] * (1 - alpha) + 255 * alpha);
}

/**
 * Draw the CONSTRUX mark on a canvas of arbitrary size.
 *
 * Anti-aliasing is by 3x supersampled coverage rather than by a scanline
 * rasteriser: the mark is two round-capped strokes and a rounded rectangle, so
 * sampling coverage is both simpler and exact enough at every size used here.
 */
function drawMark(width, height, options = {}) {
  const { background = BLACK, plate = null, markScale = 1, transparent = false } = options;
  const rgba = Buffer.alloc(width * height * 4);

  // Background fills the whole canvas unless the caller wants transparency
  // around a plate — which is what a non-maskable icon needs.
  if (!transparent) {
    for (let i = 0; i < width * height; i += 1) {
      rgba[i * 4] = background[0];
      rgba[i * 4 + 1] = background[1];
      rgba[i * 4 + 2] = background[2];
      rgba[i * 4 + 3] = 255;
    }
  }

  const side = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;

  // Mark geometry in the 64-unit space of favicon.svg, scaled to this canvas.
  const unit = (side / 64) * markScale;
  const stroke = 7 * unit;
  const half = stroke / 2;
  const px = (x, y) => [cx + (x - 32) * unit, cy + (y - 32) * unit];

  const [l1x, l1y] = px(20, 18);
  const [l2x, l2y] = px(32, 32);
  const [l3x, l3y] = px(20, 46);
  const [r1x, r1y] = px(44, 18);
  const [r3x, r3y] = px(44, 46);

  const plateRadius = plate ? plate.radius : 0;
  const plateSize = plate ? plate.size : 0;
  const plateX = cx - plateSize / 2;
  const plateY = cy - plateSize / 2;

  const SAMPLES = 3;
  const step = 1 / SAMPLES;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let plateHits = 0;
      let whiteHits = 0;
      let orangeHits = 0;

      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const px0 = x + (sx + 0.5) * step;
          const py0 = y + (sy + 0.5) * step;

          if (plate && distanceToRoundedRect(px0, py0, plateX, plateY, plateSize, plateSize, plateRadius) <= 0) {
            plateHits += 1;
          }
          const white = Math.min(
            distanceToSegment(px0, py0, l1x, l1y, l2x, l2y),
            distanceToSegment(px0, py0, l2x, l2y, l3x, l3y),
          );
          const orange = Math.min(
            distanceToSegment(px0, py0, r1x, r1y, l2x, l2y),
            distanceToSegment(px0, py0, l2x, l2y, r3x, r3y),
          );
          // The orange stroke is drawn over the white one where they meet, the
          // same order as the SVG.
          if (orange <= half) orangeHits += 1;
          else if (white <= half) whiteHits += 1;
        }
      }

      const total = SAMPLES * SAMPLES;
      const offset = (y * width + x) * 4;
      if (plate && plateHits > 0) blend(rgba, offset, plate.colour, plateHits / total);
      if (whiteHits > 0) blend(rgba, offset, WHITE, whiteHits / total);
      if (orangeHits > 0) blend(rgba, offset, ORANGE, orangeHits / total);
    }
  }

  return rgba;
}

function write(name, width, height, options) {
  const png = encodePng(width, height, drawMark(width, height, options));
  writeFileSync(join(OUT, name), png);
  return { name, bytes: png.length };
}

// --- Assets -----------------------------------------------------------------

/**
 * Every iOS launch image, by device pixel size.
 *
 * iOS shows nothing at all unless the exact dimensions match, so this is a list
 * of real device resolutions rather than a set of convenient sizes. Portrait
 * only: the application is used one-handed on site far more than in landscape,
 * and doubling the asset count for the other orientation earns little.
 */
export const IOS_LAUNCH = [
  { w: 1290, h: 2796, cssW: 430, cssH: 932, ratio: 3 },
  { w: 1179, h: 2556, cssW: 393, cssH: 852, ratio: 3 },
  { w: 1284, h: 2778, cssW: 428, cssH: 926, ratio: 3 },
  { w: 1170, h: 2532, cssW: 390, cssH: 844, ratio: 3 },
  { w: 1125, h: 2436, cssW: 375, cssH: 812, ratio: 3 },
  { w: 1242, h: 2688, cssW: 414, cssH: 896, ratio: 3 },
  { w: 828, h: 1792, cssW: 414, cssH: 896, ratio: 2 },
  { w: 750, h: 1334, cssW: 375, cssH: 667, ratio: 2 },
  { w: 2048, h: 2732, cssW: 1024, cssH: 1366, ratio: 2 },
  { w: 1668, h: 2388, cssW: 834, cssH: 1194, ratio: 2 },
  { w: 1668, h: 2224, cssW: 834, cssH: 1112, ratio: 2 },
  { w: 1536, h: 2048, cssW: 768, cssH: 1024, ratio: 2 },
];

export function launchImageName(entry) {
  return `launch-${entry.w}x${entry.h}.png`;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const written = [];

  // Standard icons: the mark on a rounded plate, transparent beyond it, so a
  // launcher that applies its own shape does not double the corner radius.
  for (const size of [192, 512]) {
    written.push(
      write(`icon-${size}.png`, size, size, {
        transparent: true,
        plate: { colour: BLACK, size, radius: size * 0.22 },
      }),
    );
  }

  // Maskable icons: background to every edge and the mark inside the 80% safe
  // zone, because the launcher crops this to whatever shape it likes.
  for (const size of [192, 512]) {
    written.push(write(`maskable-${size}.png`, size, size, { markScale: 0.62 }));
  }

  // iOS home-screen icon: opaque and square. iOS applies the mask itself and
  // composites transparency onto black, which would show as a dark halo.
  written.push(write('apple-touch-icon.png', 180, 180, { markScale: 0.82 }));

  for (const entry of IOS_LAUNCH) {
    // The launch image must match the in-app splash or the handover from one to
    // the other visibly jumps. `drawMark` sizes the mark off the narrow edge, so
    // one scale gives the same proportion on a phone and on a 12.9" iPad; 0.5
    // puts the mark at roughly a fifth of the narrow edge, which is what
    // `.splash-mark` renders at in the CSS.
    written.push(write(launchImageName(entry), entry.w, entry.h, { markScale: 0.5 }));
  }

  const total = written.reduce((sum, file) => sum + file.bytes, 0);
  for (const file of written) process.stdout.write(`${file.name.padEnd(24)} ${String(file.bytes).padStart(7)} bytes\n`);
  process.stdout.write(`\n${written.length} files, ${(total / 1024).toFixed(1)} kB total\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
