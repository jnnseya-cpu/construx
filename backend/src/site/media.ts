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
 * The three types a browser renders and the site's `img-src 'self'` policy
 * admits. SVG is deliberately absent: an SVG is a document that can carry
 * script, and this directory is served from the platform's own origin, so
 * accepting one would be storing cross-site scripting on the marketing site.
 */
/**
 * Exported so an account picture is typed the same way a landing picture is.
 * Two magic-byte tables would be two answers to "is this really a PNG", and the
 * one that drifts is the one an upload gets past.
 */
export const SIGNATURES: ReadonlyArray<{ extension: string; contentType: string; matches: (bytes: Buffer) => boolean }> = [
  {
    extension: '.png',
    contentType: 'image/png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    extension: '.jpg',
    contentType: 'image/jpeg',
    matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    extension: '.webp',
    contentType: 'image/webp',
    // RIFF····WEBP. The four bytes between are the length and are not checked.
    matches: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

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

  const signature = SIGNATURES.find((candidate) => candidate.matches(bytes));
  if (!signature) {
    throw new DomainError(
      'NOT_AN_IMAGE',
      'That file is not a PNG, JPEG or WebP. It is read from the file itself rather than from what the upload ' +
        'claimed, and an SVG is refused outright because this directory is served from the platform’s own origin.',
      415,
    );
  }

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
