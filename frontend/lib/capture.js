/**
 * Reducing a photograph to evidence size, before it becomes an address.
 *
 * Photographs are 88–89% of everything this platform stores, on every size of
 * project. A modern handset shoots 3–12 MB a frame, and a site record does not
 * need any of it: a defect, a pour, a rebar cover check or a delivery ticket is
 * completely legible at 1920px on the long edge, and the extra pixels prove
 * nothing that the smaller image does not. Re-encoding at capture takes a mid
 * project's photography from about 46 GB to about 9 GB, which is the single
 * largest lever on storage cost anywhere in the system.
 *
 * ---
 *
 * **This runs before the hash, and that is not negotiable.** The hash is the
 * address the bytes are stored at and the value written into an append-only
 * event, so it has to be taken over the bytes that are actually kept. Compress
 * after hashing and the platform refuses its own upload — correctly, because
 * the bytes would no longer be the evidence the record names.
 *
 * **Only images, and only large ones.** A PDF, a drawing, an IFC or a signed
 * document passes through untouched: re-encoding those is lossy in ways that
 * matter, and a drawing is exactly the document somebody will zoom into three
 * years from now. A photograph already under the threshold is left alone too —
 * there is nothing to win and a re-encode can only lose.
 *
 * **It can never make a file bigger.** A small or already-optimised image can
 * come out of a JPEG encoder larger than it went in. Where that happens the
 * original is kept, so this is a floor rather than a gamble.
 *
 * **It can never lose the capture.** Every failure path returns the original
 * file. A browser without `createImageBitmap`, a corrupt image, a canvas the
 * platform refuses to read — none of them are worth a lost site photograph, and
 * an uncompressed photograph is a completely acceptable outcome.
 *
 * **What is given up: EXIF.** Canvas re-encoding drops it, including the GPS
 * fix and the capture timestamp. Neither is read anywhere in this platform
 * today — the event carries its own `deviceTimestamp` and its own author, which
 * is what a delay claim is argued from — so nothing regresses. But if location
 * ever becomes evidence here, it has to be extracted *before* this runs, and
 * this comment is the warning that it cannot be recovered afterwards.
 *
 * Orientation is the exception and is handled: `imageOrientation: 'from-image'`
 * applies the EXIF rotation while decoding, so a portrait photograph stays
 * portrait. Without it every phone photo taken sideways is stored sideways,
 * which is the kind of defect that is noticed a week after a thousand of them.
 */

/** Long edge, in pixels. Site evidence is legible well below this. */
const MAX_EDGE = 1920;

/** JPEG quality. 0.8 is the usual knee — visible loss starts below it. */
const QUALITY = 0.8;

/**
 * Files under this are left alone.
 *
 * 600 KB is roughly what this function produces, so anything already at or
 * below it has nothing to gain from a round trip through the encoder.
 */
const FLOOR_BYTES = 600 * 1024;

/** Image types worth re-encoding. Anything else is passed through. */
const COMPRESSIBLE = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);

/**
 * The blob that should become evidence.
 *
 * Returns the original file unchanged unless it is a large photograph, in which
 * case it returns a resized JPEG carrying the original's name. The caller hashes
 * whatever comes back — never the input.
 */
export async function forEvidence(file) {
  if (!file || !COMPRESSIBLE.has(file.type) || file.size <= FLOOR_BYTES) return file;
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return file;

  try {
    // `from-image` applies the EXIF rotation during decode. Without it a
    // portrait photograph is decoded as landscape and stored that way.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });

    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });

    // The floor. An already-optimised image can come out larger, and keeping
    // the larger one would make this a cost rather than a saving.
    if (!blob || blob.size >= file.size) return file;

    // A File rather than a Blob, so the name survives into the record and into
    // the offline outbox — which shows people what their handset is carrying by
    // filename, and "blob" is not a filename.
    return new File([blob], renameToJpeg(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    // Corrupt image, unsupported codec, a canvas the browser refuses to read
    // back. None of these are worth losing a site photograph over.
    return file;
  }
}

/** The original name with a .jpg extension, because the bytes are now a JPEG. */
function renameToJpeg(name) {
  if (!name) return 'capture.jpg';
  return /\.jpe?g$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, '')}.jpg`;
}
