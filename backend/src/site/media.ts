import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';

/**
 * The pictures on the landing page, and the only way to put one there.
 *
 * Five slots have existed since the public site was built, and the only way to
 * fill one was to drop a file into `frontend/media/` and restart the process.
 * On a laptop that is a copy and a restart. On a deployed container it is a
 * rebuild — the directory is inside the image — so in practice the slots could
 * not be filled at all by the person whose pictures they are.
 *
 * Three things had to change together, and none of them works alone:
 *
 * 1. **Somewhere to write that survives a redeploy.** `SITE_MEDIA_PATH` points
 *    at the same kind of volume the ledger journal already uses. Unset, it
 *    falls back to `frontend/media/` so a checkout still behaves as it did.
 * 2. **Presence that does not need a restart.** It was read once at module
 *    load. It is now a cache this module owns and invalidates on write — still
 *    no filesystem call per visit, which was the reason for reading it once.
 * 3. **A door.** An upload route, and the console screen behind it.
 *
 * ---
 *
 * **Why this file is the registry and `landing.ts` is not.** The slots are now
 * named in three places — the page that renders them, the route that accepts
 * them and the screen that manages them — and three lists of five filenames is
 * three chances to disagree. The alt text moved here with them, because alt
 * text belongs to the slot rather than to the paragraph it sits next to.
 *
 * **Why the filename is never the caller's.** A route that writes a file into
 * a directory the web server serves is the shape of a remote code execution,
 * and the two usual holes are a caller-supplied path and a caller-supplied
 * extension. Neither exists here: the slot id must match one of five literals,
 * and the extension comes from the file's own magic bytes, which is also what
 * decides whether the upload is accepted at all. A declared content type is a
 * claim by the uploader and is not trusted for anything.
 */

/** Where a slot appears and what shape the picture has to be. */
export type MediaSlot = {
  /** Stable id: the route parameter, and the base of the stored filename. */
  id: string;
  /** Where on the page it lands, in words, for whoever is supplying it. */
  where: string;
  /** What the picture has to show. Read by the page as the `alt` attribute. */
  alt: string;
  /** Declared to the browser so the page does not reflow as the bytes land. */
  width: number;
  height: number;
  /** The class the page renders it under. */
  className: string;
};

/**
 * The five, in the order they appear down the page.
 *
 * Dimensions are the export size, not the display size: the landscape slots
 * display at up to 1200px and the portrait ones at up to 560px, and shipping
 * twice that is what keeps them sharp on a retina screen.
 */
export const MEDIA_SLOTS: readonly MediaSlot[] = [
  {
    id: 'command-centre',
    where: 'Full-width plate, immediately after the hero',
    alt:
      'The CONSTRUX project command centre: cost performance against budget, schedule performance against plan, ' +
      'forecast at completion, and open risk by severity, above a progress S-curve and a cost breakdown.',
    width: 2400,
    height: 1600,
    className: 'plate wide',
  },
  {
    id: 'broken-workflows',
    where: 'Full-width band opening the proof section',
    alt:
      'A construction manager on site. Three failures named: projects losing money silently, models that do not ' +
      'build, and claims treated as the problem rather than the symptom.',
    width: 2400,
    height: 1600,
    className: 'band',
  },
  {
    id: 'visibility-control',
    where: 'Column figure beside the engine grid',
    alt: 'One platform connecting people, process and data across every stage of construction.',
    width: 1120,
    height: 1400,
    className: 'column',
  },
  {
    id: 'control-every-variable',
    where: 'Column figure beside the statute passage',
    alt: 'Control every variable, deliver every time: the outcomes CONSTRUX is measured against.',
    width: 1120,
    height: 1400,
    className: 'column right',
  },
  {
    id: 'founder',
    where: 'Portrait plate above the closing call to action',
    alt: 'Justin Nseya MCIOB, construction and project management leader, on site.',
    width: 1120,
    height: 1400,
    className: 'portrait-plate',
  },
];

/**
 * What a picture has to actually be, by its own first bytes.
 *
 * Every raster format a current browser renders, and no more. SVG is
 * deliberately absent and always will be: an SVG is a document that can carry
 * script, and this directory is served from the platform's own origin, so
 * accepting one would be storing cross-site scripting on the marketing site.
 *
 * AVIF and GIF were absent for no reason at all, which was a defect rather
 * than a decision — every browser renders both, and AVIF is what an export
 * dialogue now offers by default in several tools. An operator exporting a
 * plate the way their software suggested had it refused as "not an image".
 *
 * Exported so an account picture is typed the same way a landing picture is.
 * Two magic-byte tables would be two answers to "is this really a PNG", and the
 * one that drifts is the one an upload gets past.
 */
export const SIGNATURES: ReadonlyArray<{ extension: string; contentType: string; label: string; matches: (bytes: Buffer) => boolean }> = [
  {
    extension: '.png',
    contentType: 'image/png',
    label: 'PNG',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    extension: '.jpg',
    contentType: 'image/jpeg',
    label: 'JPEG',
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    extension: '.webp',
    contentType: 'image/webp',
    label: 'WebP',
    // RIFF····WEBP. The four bytes between are the length and are not checked.
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    extension: '.avif',
    contentType: 'image/avif',
    label: 'AVIF',
    // An ISO base media file whose brand is `avif` or `avis`. The brand sits
    // at bytes 8-12, after the box length and `ftyp`; the same container
    // carries HEIC, which is why the brand rather than the container decides.
    matches: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp' && ['avif', 'avis'].includes(b.subarray(8, 12).toString('latin1')),
  },
  {
    extension: '.gif',
    contentType: 'image/gif',
    label: 'GIF',
    matches: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  },
];

/**
 * Formats that are recognisably pictures and are still refused, each with the
 * reason and what to do instead.
 *
 * Without this every refusal read "that file is not a PNG, JPEG or WebP",
 * which is true, unhelpful, and the same sentence whether somebody uploaded a
 * spreadsheet or a photograph straight off their phone. The phone is the case
 * that matters: an iPhone shoots HEIC by default, no browser renders it, and
 * an operator whose every photograph bounced had no way to learn that the fix
 * is one setting in the export dialogue.
 *
 * A refusal is still a refusal — nothing here is stored. The difference is
 * that the person is told which format they have and what to do about it.
 */
const REFUSED: ReadonlyArray<{ label: string; article: 'a' | 'an'; because: string; matches: (bytes: Buffer) => boolean }> = [
  {
    label: 'HEIC/HEIF',
    // Carried rather than derived from the first letter: "an SVG" and "a PDF"
    // both begin with a consonant, and it is how the letter is *said* that
    // decides. A rule that guesses gets one of them wrong.
    article: 'a',
    because:
      'the format an iPhone shoots by default, which no browser can display. In Settings › Camera › Formats choose ' +
      '"Most Compatible" to shoot JPEG from now on, or export this one as JPEG and upload that.',
    matches: (b) =>
      b.subarray(4, 8).toString('latin1') === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'mif1', 'msf1'].includes(b.subarray(8, 12).toString('latin1')),
  },
  {
    label: 'TIFF',
    article: 'a',
    because: 'a format no browser displays. Export as JPEG for a photograph or PNG for a screenshot.',
    matches: (b) => b.subarray(0, 4).equals(Buffer.from([0x49, 0x49, 0x2a, 0x00])) || b.subarray(0, 4).equals(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])),
  },
  {
    label: 'BMP',
    article: 'a',
    because: 'a bitmap, which is enormous for what it shows. Export as PNG — the same picture at a fraction of the size.',
    matches: (b) => b.subarray(0, 2).toString('latin1') === 'BM',
  },
  {
    label: 'PDF',
    article: 'a',
    because: 'a document rather than a picture. Export the page, or the image inside it, as PNG or JPEG.',
    matches: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  },
  {
    label: 'SVG',
    article: 'an',
    because:
      'a document that can carry script, and this directory is served from the platform’s own origin — storing one ' +
      'would be storing cross-site scripting on the marketing site. Export it as PNG at the size the slot asks for.',
    // Some SVGs open with an XML declaration or a comment, so the test is
    // whether an `<svg` tag appears near the start rather than at byte zero.
    matches: (b) => b.subarray(0, 1024).toString('latin1').toLowerCase().includes('<svg'),
  },
];

/** Every format the slots accept, named the way a person would say it. */
export function acceptedFormats(): string {
  const labels = SIGNATURES.map((signature) => signature.label);
  return `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`;
}

/**
 * The refusal, for bytes that matched no accepted signature.
 *
 * Shared because there are three places that store a picture — a landing
 * slot, a customer's branding logo and a person's account picture — and all
 * three were carrying their own copy of the sentence "that file is not a PNG,
 * JPEG or WebP". Adding AVIF and GIF to the table made all three copies wrong
 * at once, which is what a duplicated sentence is for.
 */
export function notAnImage(bytes: Buffer): DomainError {
  const known = REFUSED.find((candidate) => candidate.matches(bytes));
  return new DomainError(
    'NOT_AN_IMAGE',
    known
      ? `That is ${known.article} ${known.label} file — ${known.because} ${acceptedFormats()} are accepted.`
      : `That file is not ${acceptedFormats()}. The format is read from the file's own first bytes rather than from ` +
        'what the upload claimed, so renaming it changes nothing.',
    415,
  );
}

/** The content types the file picker should offer, from the same table. */
export const ACCEPTED_CONTENT_TYPES = SIGNATURES.map((signature) => signature.contentType).join(',');

/** Every extension a slot can be stored under, for the presence sweep. */
const EXTENSIONS = SIGNATURES.map((signature) => signature.extension);

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'frontend', 'media');

/**
 * Where the pictures live. `SITE_MEDIA_PATH` when set, the checkout when not.
 *
 * Read from the environment on each call rather than from the `config`
 * snapshot, for the same reason `demonstrationEnabled()` is: this decides which
 * directory an upload route writes into, and a destination no test can move is
 * one whose tests would be writing into the repository to check it. The
 * snapshot is still the value a deployment sets; nothing else changes it.
 */
export function mediaDir(): string {
  const configured = process.env.SITE_MEDIA_PATH ?? config.site.mediaPath;
  return configured === '' ? DEFAULT_DIR : configured;
}

/**
 * Which slots have a file, and which file.
 *
 * The cache exists for one reason: the landing page renders on every visit and
 * a `stat` per slot per visit buys the reader nothing. It is filled on first
 * read and invalidated by every write through this module, so a picture appears
 * the moment it is uploaded rather than at the next restart.
 */
let cache: Map<string, string> | undefined;

function scan(): Map<string, string> {
  const found = new Map<string, string>();
  const directory = mediaDir();
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    // No directory is a legitimate state: it means no picture has been put
    // anywhere yet, and every slot renders as absent.
    return found;
  }
  for (const slot of MEDIA_SLOTS) {
    // First match wins, in signature order, so a slot replaced from PNG to
    // JPEG cannot end up with the page pointing at whichever the filesystem
    // happened to list first.
    for (const extension of EXTENSIONS) {
      const file = `${slot.id}${extension}`;
      if (entries.includes(file)) {
        found.set(slot.id, file);
        break;
      }
    }
  }
  return found;
}

function present(): Map<string, string> {
  if (!cache) cache = scan();
  return cache;
}

/** Drop the cache. Called after every write, and by tests that move files. */
export function refreshMedia(): void {
  cache = undefined;
}

/** The stored filename for a slot, or undefined where there is no picture. */
export function slotFile(id: string): string | undefined {
  return present().get(id);
}

/** What each slot is for, and whether a picture is in it. Read by the console. */
export function mediaState(): Array<
  MediaSlot & { file?: string; held: boolean; contentType?: string; bytes?: number; updatedAt?: string }
> {
  const held = present();
  return MEDIA_SLOTS.map((slot) => {
    const file = held.get(slot.id);
    if (!file) return { ...slot, held: false };

    const signature = SIGNATURES.find((candidate) => file.endsWith(candidate.extension));
    let bytes: number | undefined;
    let updatedAt: string | undefined;
    try {
      const info = statSync(join(mediaDir(), file));
      bytes = info.size;
      updatedAt = new Date(info.mtimeMs).toISOString();
    } catch {
      // Removed between the scan and the stat. Reported as held with no size
      // rather than crashing the screen that is trying to show it.
    }
    return { ...slot, file, held: true, contentType: signature?.contentType, bytes, updatedAt };
  });
}

/**
 * Put a picture in a slot.
 *
 * Refuses an unknown slot, an empty body, anything over the ceiling, and
 * anything whose first bytes are not one of the three image types. The
 * declared content type is not consulted — it is the uploader's claim about a
 * file the platform is about to serve from its own origin.
 */
export function putSlotImage(id: string, bytes: Buffer): { slot: string; file: string; contentType: string; bytes: number } {
  const slot = MEDIA_SLOTS.find((candidate) => candidate.id === id);
  if (!slot) {
    throw new DomainError('NO_SUCH_SLOT', `There is no landing slot called "${id}"`, 404);
  }
  if (bytes.length === 0) {
    throw new DomainError('EMPTY_UPLOAD', 'No bytes were received', 400);
  }
  if (bytes.length > config.site.mediaMaxBytes) {
    throw new DomainError(
      'IMAGE_TOO_LARGE',
      `That picture is ${Math.round(bytes.length / 1024)}KB. The ceiling is ` +
        `${Math.round(config.site.mediaMaxBytes / 1024)}KB — export at ${slot.width}px wide and compress.`,
      413,
    );
  }

  // Named where it can be named. "Not a PNG, JPEG or WebP" is true of a
  // photograph off a phone and of a spreadsheet alike, and the person holding
  // the photograph has no way to tell which of the two they are.
  const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
  if (!signature) throw notAnImage(bytes);

  const directory = mediaDir();
  mkdirSync(directory, { recursive: true });

  // Written beside the target and renamed, so a reader never sees a partial
  // file — the landing page reads this directory on the same process.
  const file = `${slot.id}${signature.extension}`;
  const temporary = join(directory, `.${file}.incoming`);
  writeFileSync(temporary, bytes);
  renameSync(temporary, join(directory, file));

  // Replacing a PNG with a JPEG would otherwise leave both, and the page would
  // keep rendering whichever the signature order found first.
  for (const extension of EXTENSIONS) {
    if (extension === signature.extension) continue;
    const stale = join(directory, `${slot.id}${extension}`);
    if (existsSync(stale)) unlinkSync(stale);
  }

  refreshMedia();
  return { slot: slot.id, file, contentType: signature.contentType, bytes: bytes.length };
}

/**
 * Take the picture out of a slot.
 *
 * The slot goes back to rendering nothing at all, which is the state the page
 * was designed around — no broken icon and no empty frame.
 */
export function removeSlotImage(id: string): { slot: string; removed: boolean } {
  const slot = MEDIA_SLOTS.find((candidate) => candidate.id === id);
  if (!slot) {
    throw new DomainError('NO_SUCH_SLOT', `There is no landing slot called "${id}"`, 404);
  }

  let removed = false;
  for (const extension of EXTENSIONS) {
    const target = join(mediaDir(), `${slot.id}${extension}`);
    if (existsSync(target)) {
      unlinkSync(target);
      removed = true;
    }
  }
  refreshMedia();
  return { slot: slot.id, removed };
}
