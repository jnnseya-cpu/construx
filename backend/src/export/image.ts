import { inflateSync, deflateSync } from 'node:zlib';

/**
 * A customer's logo, decoded into something a PDF can carry.
 *
 * The exporter already put the client's *colour* on every document and never
 * put their *mark* on one: the HTML export emitted an `<img>` and the PDF —
 * which is the artefact that actually goes to a client, a regulator or an
 * adjudicator — drew the name in the accent colour and stopped there. A
 * document that claims to be prepared for a company and carries nothing of
 * theirs is the weakest form of branding there is.
 *
 * Two formats, because those are the two a logo actually arrives in.
 *
 * **JPEG passes straight through.** PDF's `DCTDecode` filter *is* JPEG, so the
 * bytes are embedded verbatim. Nothing is re-encoded, so nothing is degraded.
 *
 * **PNG is inflated, un-filtered and re-deflated.** PDF cannot read a PNG
 * container, only a raw sample stream, so the pixels have to be recovered.
 * Transparency is composited onto white rather than carried as a soft mask: the
 * page is white, the result is identical to what a reader would see, and it
 * avoids a second stream that some readers handle badly.
 *
 * Anything else is refused by name. A logo silently dropped is worse than one
 * refused, because the document still goes out — looking finished, and missing
 * the thing somebody asked for.
 */

export type DecodedImage = {
  width: number;
  height: number;
  /** The stream bytes, ready to embed. */
  data: Buffer;
  /** The PDF filter that reads them. */
  filter: 'DCTDecode' | 'FlateDecode';
  /** Samples per pixel in the stream: 1 for greyscale, 3 for RGB. */
  components: 1 | 3;
  bitsPerComponent: 8;
};

export class UnsupportedImageError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UnsupportedImageError';
  }
}

/** Split `data:image/png;base64,...` into its type and bytes. */
export function parseDataUri(uri: string): { mime: string; bytes: Buffer } | undefined {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(uri.trim());
  if (!match) return undefined;
  const [, mime, base64, payload] = match as unknown as [string, string, string | undefined, string];
  return {
    mime: mime.toLowerCase(),
    bytes: base64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'latin1'),
  };
}

/**
 * JPEG dimensions, read from the frame header rather than guessed.
 *
 * Walks the marker segments to the first SOF. Every SOF variant carries the
 * same five bytes in the same order, so the baseline/progressive distinction
 * does not matter here — both are `DCTDecode` to a PDF reader.
 */
function readJpeg(bytes: Buffer): DecodedImage {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new UnsupportedImageError('Not a JPEG: the file does not start with the JPEG marker');
  }

  let offset = 2;
  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    // Standalone markers carry no length and must not be stepped over as if
    // they did — doing so walks the parser into the entropy-coded data.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;

    const length = bytes.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      const components = bytes[offset + 9]!;
      if (components !== 1 && components !== 3) {
        // CMYK JPEGs invert in most readers without an explicit Decode array,
        // and a logo that renders as its own negative is worse than none.
        throw new UnsupportedImageError(
          `This JPEG has ${components} colour components; the exporter carries greyscale and RGB only`,
        );
      }
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
        data: bytes,
        filter: 'DCTDecode',
        components: components as 1 | 3,
        bitsPerComponent: 8,
      };
    }
    offset += 2 + length;
  }

  throw new UnsupportedImageError('This JPEG has no frame header, so its dimensions cannot be read');
}

/** Reverse one PNG scanline filter. Defined by the format; the names are its own. */
function unfilter(
  type: number,
  line: Buffer,
  previous: Buffer | undefined,
  bytesPerPixel: number,
): Buffer {
  const out = Buffer.alloc(line.length);
  for (let i = 0; i < line.length; i += 1) {
    const raw = line[i]!;
    const a = i >= bytesPerPixel ? out[i - bytesPerPixel]! : 0;
    const b = previous ? previous[i]! : 0;
    const c = previous && i >= bytesPerPixel ? previous[i - bytesPerPixel]! : 0;

    switch (type) {
      case 0:
        out[i] = raw;
        break;
      case 1:
        out[i] = (raw + a) & 0xff;
        break;
      case 2:
        out[i] = (raw + b) & 0xff;
        break;
      case 3:
        out[i] = (raw + ((a + b) >> 1)) & 0xff;
        break;
      case 4: {
        // Paeth: pick whichever neighbour the gradient predicts.
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[i] = (raw + predictor) & 0xff;
        break;
      }
      default:
        throw new UnsupportedImageError(`This PNG uses filter type ${type}, which is not one of the five defined`);
    }
  }
  return out;
}

function readPng(bytes: Buffer): DecodedImage {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) {
    throw new UnsupportedImageError('Not a PNG: the file does not start with the PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = -1;
  const idat: Buffer[] = [];
  let palette: Buffer | undefined;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colourType = body[9]!;
      if (body[12] !== 0) {
        // Interlaced PNGs store seven reduced images and would need the whole
        // Adam7 pass reconstructed. Refused by name rather than half-decoded.
        throw new UnsupportedImageError('This PNG is interlaced; save it without interlacing and upload it again');
      }
    } else if (type === 'PLTE') {
      palette = Buffer.from(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (width === 0 || height === 0) throw new UnsupportedImageError('This PNG has no image header');
  if (bitDepth !== 8) {
    throw new UnsupportedImageError(`This PNG is ${bitDepth}-bit; the exporter carries 8-bit images only`);
  }

  // Greyscale, RGB, palette, greyscale+alpha, RGBA — the five colour types.
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const sourceChannels = channels[colourType];
  if (sourceChannels === undefined) {
    throw new UnsupportedImageError(`This PNG uses colour type ${colourType}, which is not one of the five defined`);
  }
  if (colourType === 3 && !palette) throw new UnsupportedImageError('This PNG is indexed and carries no palette');

  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = sourceChannels;
  const stride = width * bytesPerPixel;

  // Un-filter into scanlines, then flatten to the samples PDF wants.
  const outputChannels = colourType === 0 || colourType === 4 ? 1 : 3;
  const out = Buffer.alloc(width * height * outputChannels);
  let previous: Buffer | undefined;
  let cursor = 0;

  for (let y = 0; y < height; y += 1) {
    const filterType = raw[cursor]!;
    const line = raw.subarray(cursor + 1, cursor + 1 + stride);
    cursor += 1 + stride;
    const decoded = unfilter(filterType, Buffer.from(line), previous, bytesPerPixel);
    previous = decoded;

    for (let x = 0; x < width; x += 1) {
      const source = x * bytesPerPixel;
      const target = (y * width + x) * outputChannels;

      if (colourType === 3) {
        const entry = decoded[source]! * 3;
        out[target] = palette![entry]!;
        out[target + 1] = palette![entry + 1]!;
        out[target + 2] = palette![entry + 2]!;
        continue;
      }

      // Alpha is composited onto white rather than carried as a soft mask. The
      // page is white, so the result is what a reader sees either way, and it
      // avoids a second stream that some readers get wrong.
      const alpha = colourType === 4 ? decoded[source + 1]! : colourType === 6 ? decoded[source + 3]! : 255;
      const blend = (value: number): number => Math.round(value * (alpha / 255) + 255 * (1 - alpha / 255));

      if (outputChannels === 1) {
        out[target] = blend(decoded[source]!);
      } else {
        out[target] = blend(decoded[source]!);
        out[target + 1] = blend(decoded[source + 1]!);
        out[target + 2] = blend(decoded[source + 2]!);
      }
    }
  }

  return {
    width,
    height,
    data: deflateSync(out),
    filter: 'FlateDecode',
    components: outputChannels as 1 | 3,
    bitsPerComponent: 8,
  };
}

/**
 * Decode a logo for embedding, or say why it cannot be.
 *
 * Returns `undefined` for an absent logo — that is not an error, it is a client
 * who did not supply one — and throws for a logo that is present and unusable,
 * because that is a mistake somebody needs to hear about.
 */
export function decodeLogo(logoRef: string | undefined): DecodedImage | undefined {
  if (!logoRef) return undefined;

  const parsed = parseDataUri(logoRef);
  if (!parsed) {
    // A storage reference rather than an inline image. Nothing to embed here;
    // the caller resolves it or leaves the logo off.
    return undefined;
  }

  if (parsed.mime === 'image/jpeg' || parsed.mime === 'image/jpg') return readJpeg(parsed.bytes);
  if (parsed.mime === 'image/png') return readPng(parsed.bytes);

  throw new UnsupportedImageError(
    `A logo of type ${parsed.mime} cannot be placed on a PDF. Supply a PNG or a JPEG.`,
  );
}
