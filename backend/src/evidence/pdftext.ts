import { inflateSync } from 'node:zlib';
import { standardWidth } from '../export/pdf.ts';

/**
 * The text a PDF carries, read from its own bytes.
 *
 * A PDF is not a picture of a document unless it was scanned. A PDF written by
 * a word processor, a CAD package or this platform's own renderer carries every
 * word as text inside its content streams, and reading that text needs no model
 * that can see — it needs a parser. Until this existed every PDF was routed to
 * the perception pipeline, which on a deployment without a multimodal provider
 * refused, so a specification that was already text sat unread beside a letter
 * in `.txt` that was.
 *
 * What is read: every page reachable from the page tree, its content streams
 * (uncompressed or Flate), the text-showing operators (`Tj`, `TJ`, `'`, `"`),
 * with each string decoded through the font it is set in — a `ToUnicode` map
 * where the font carries one, WinAnsi, MacRoman or Standard encoding with a
 * `Differences` array otherwise. Form XObjects are followed, because a
 * generator that puts each page's body in one is common.
 *
 * What is refused, by name: an encrypted file, which cannot be read without its
 * password by anything; a string set in a composite font with no `ToUnicode`
 * map, which is glyph indices and not characters; a stream under a filter this
 * does not decode. Each is counted and reported rather than guessed at, and a
 * page that draws images and no text is reported as what a scan looks like —
 * the case that still needs a model that can see.
 *
 * Tables are recovered from where the text sits, not from what it says. Every
 * shown string is also kept as a run with its position and advance — the text
 * matrix and the current transformation are tracked, and each glyph's width is
 * taken from the font's own `Widths` or `W` array, or from the standard-font
 * metrics the platform's renderer uses when the font carries none. Runs on one
 * baseline are cells; cells whose horizontal extents never cross across three
 * or more consecutive lines are columns. See `recoverTables` for the rules and
 * what they refuse.
 *
 * Zero dependencies, as settled. Node's own `zlib` inflates the streams.
 */

/** A single inflated stream may not exceed this; a bomb is refused, not read. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
/** Across the whole file. */
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Form XObjects calling form XObjects. Deeper than this is a cycle or a joke. */
const MAX_FORM_DEPTH = 8;
/** A kerning adjustment wider than this, in thousandths of an em, is a space. */
const WORD_GAP = -180;

export type PdfReading = {
  /** Pages found on the page tree, or by scanning where the tree is broken. */
  pages: number;
  /** Pages that yielded at least one character. */
  textPages: number;
  /** Pages that drew an image and yielded no text: what a scan looks like. */
  imageOnlyPages: number;
  /** Strings skipped because their font has no readable encoding. */
  undecodableStrings: number;
  /** Streams skipped because their filter is not decoded here, or they would not inflate. */
  unreadableStreams: number;
  encrypted: boolean;
  /** Pages separated by a blank line. Empty where nothing was read. */
  text: string;
  /**
   * Tables recovered from the positions of the text, page by page, each as its
   * rows with the header row first. Empty where the text lines up into none.
   */
  tables: PdfTable[];
};

export type PdfTable = {
  /** 1-based, in the page order the file reads in. */
  page: number;
  rows: string[][];
};

type PdfObject = { dict: string; stream?: Buffer };

type Decoder = {
  bytesPerCode: 1 | 2;
  /** From ToUnicode. */
  map?: Map<number, string>;
  /** For a simple font: the base encoding, overridden by Differences. */
  simple?: string[];
  /** A composite font with no ToUnicode: glyph indices, not characters. */
  undecodable: boolean;
  /** Glyph advances by code in 1/1000 em, from `Widths` or `W`. */
  widths?: Map<number, number>;
  /** The advance for a code the font gives none: `MissingWidth`, `DW`, or the standard metrics. */
  fallbackWidth: (code: number) => number;
};

/** A shown string with where it sits on the page, in device points. */
type Run = {
  x: number;
  y: number;
  /** Where the advance left the pen: the run's right edge. */
  end: number;
  /** The font size as it appears on the page. */
  size: number;
  text: string;
};

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m × n` in PDF's row-vector convention: apply `m`, then `n`. */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function matrixOf(tokens: string[]): Matrix | undefined {
  if (tokens.length < 6) return undefined;
  const numbers = tokens.slice(-6).map(Number);
  return numbers.some((n) => !Number.isFinite(n)) ? undefined : (numbers as Matrix);
}

// --- Encodings ---------------------------------------------------------------

/** Windows-1252, which is what `/WinAnsiEncoding` is. */
const WIN_ANSI_HIGH: Record<number, string> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡', 0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š',
  0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ', 0xa0: ' ', 0xad: '-',
};

const MAC_ROMAN_HIGH: Record<number, string> = {
  0x80: 'Ä', 0x81: 'Å', 0x82: 'Ç', 0x83: 'É', 0x84: 'Ñ', 0x85: 'Ö', 0x86: 'Ü', 0x87: 'á', 0x88: 'à', 0x89: 'â',
  0x8a: 'ä', 0x8b: 'ã', 0x8c: 'å', 0x8d: 'ç', 0x8e: 'é', 0x8f: 'è', 0x90: 'ê', 0x91: 'ë', 0x92: 'í', 0x93: 'ì',
  0x94: 'î', 0x95: 'ï', 0x96: 'ñ', 0x97: 'ó', 0x98: 'ò', 0x99: 'ô', 0x9a: 'ö', 0x9b: 'õ', 0x9c: 'ú', 0x9d: 'ù',
  0x9e: 'û', 0x9f: 'ü', 0xa0: '†', 0xa1: '°', 0xa2: '¢', 0xa3: '£', 0xa4: '§', 0xa5: '•', 0xa6: '¶', 0xa7: 'ß',
  0xa8: '®', 0xa9: '©', 0xaa: '™', 0xab: '´', 0xac: '¨', 0xae: 'Æ', 0xaf: 'Ø', 0xb1: '±', 0xb4: '¥', 0xb5: 'µ',
  0xbb: 'ª', 0xbc: 'º', 0xbe: 'æ', 0xbf: 'ø', 0xc0: '¿', 0xc1: '¡', 0xc2: '¬', 0xc7: '«', 0xc8: '»', 0xc9: '…',
  0xca: ' ', 0xcb: 'À', 0xcc: 'Ã', 0xcd: 'Õ', 0xce: 'Œ', 0xcf: 'œ', 0xd0: '–', 0xd1: '—', 0xd2: '“', 0xd3: '”',
  0xd4: '‘', 0xd5: '’', 0xd6: '÷', 0xd8: 'ÿ', 0xd9: 'Ÿ', 0xdb: '€', 0xde: 'ﬁ', 0xdf: 'ﬂ', 0xe1: '·', 0xe2: '‚',
  0xe3: '„', 0xe4: '‰', 0xe5: 'Â', 0xe6: 'Ê', 0xe7: 'Á', 0xe8: 'Ë', 0xe9: 'È', 0xea: 'Í', 0xeb: 'Î', 0xec: 'Ï',
  0xed: 'Ì', 0xee: 'Ó', 0xef: 'Ô', 0xf1: 'Ò', 0xf2: 'Ú', 0xf3: 'Û', 0xf4: 'Ù',
};

/** Adobe StandardEncoding where it differs from ASCII and Latin-1. */
const STANDARD_DIFFERENCES: Record<number, string> = {
  0x27: '’', 0x60: '‘', 0xa1: '¡', 0xa2: '¢', 0xa3: '£', 0xa4: '⁄', 0xa5: '¥', 0xa6: 'ƒ', 0xa7: '§', 0xa8: '¤',
  0xa9: "'", 0xaa: '“', 0xab: '«', 0xac: '‹', 0xad: '›', 0xae: 'ﬁ', 0xaf: 'ﬂ', 0xb1: '–', 0xb2: '†', 0xb3: '‡',
  0xb4: '·', 0xb6: '¶', 0xb7: '•', 0xb8: '‚', 0xb9: '„', 0xba: '”', 0xbb: '»', 0xbc: '…', 0xbd: '‰', 0xbf: '¿',
  0xc1: '`', 0xc2: '´', 0xc3: 'ˆ', 0xc4: '˜', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸',
  0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ', 0xd0: '—', 0xe1: 'Æ', 0xe3: 'ª', 0xe8: 'Ł', 0xe9: 'Ø', 0xea: 'Œ', 0xeb: 'º',
  0xf1: 'æ', 0xf5: 'ı', 0xf8: 'ł', 0xf9: 'ø', 0xfa: 'œ', 0xfb: 'ß',
};

function encodingTable(name: string): string[] {
  const table: string[] = [];
  for (let code = 0; code < 256; code += 1) {
    if (name === 'MacRomanEncoding') {
      table[code] = code < 0x80 ? String.fromCharCode(code) : (MAC_ROMAN_HIGH[code] ?? '');
    } else if (name === 'StandardEncoding') {
      table[code] = STANDARD_DIFFERENCES[code] ?? (code < 0x80 ? String.fromCharCode(code) : '');
    } else {
      table[code] = WIN_ANSI_HIGH[code] ?? String.fromCharCode(code);
    }
  }
  // Control characters carry nothing but a tab or a newline.
  for (let code = 0; code < 0x20; code += 1) if (code !== 0x09 && code !== 0x0a && code !== 0x0d) table[code] = '';
  table[0x7f] = '';
  return table;
}

/**
 * Glyph names to characters, for a `Differences` array.
 *
 * The Adobe Glyph List has 4,000 entries; these are the ones a document set in
 * a subset font actually uses. A name not here decodes to nothing and is
 * counted, rather than to a guess.
 */
const GLYPH_NAMES: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-',
  period: '.', slash: '/', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
  bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{',
  bar: '|', braceright: '}', asciitilde: '~', quotedblleft: '“', quotedblright: '”', quotesinglbase: '‚',
  quotedblbase: '„', endash: '–', emdash: '—', bullet: '•', ellipsis: '…', fi: 'ﬁ', fl: 'ﬂ', ff: 'ﬀ', ffi: 'ﬃ',
  ffl: 'ﬄ', sterling: '£', Euro: '€', dollar_: '$', yen: '¥', cent: '¢', degree: '°', multiply: '×', minus: '−',
  plusminus: '±', divide: '÷', copyright: '©', registered: '®', trademark: '™', section: '§', paragraph: '¶',
  periodcentered: '·', guillemotleft: '«', guillemotright: '»', onehalf: '½', onequarter: '¼', threequarters: '¾',
  fraction: '⁄', dagger: '†', daggerdbl: '‡', mu: 'µ', nbspace: ' ', sfthyphen: '-', ordmasculine: 'º',
  ordfeminine: 'ª', exclamdown: '¡', questiondown: '¿', eacute: 'é', egrave: 'è', ecircumflex: 'ê', edieresis: 'ë',
  aacute: 'á', agrave: 'à', acircumflex: 'â', adieresis: 'ä', atilde: 'ã', aring: 'å', ccedilla: 'ç', iacute: 'í',
  igrave: 'ì', icircumflex: 'î', idieresis: 'ï', ntilde: 'ñ', oacute: 'ó', ograve: 'ò', ocircumflex: 'ô',
  odieresis: 'ö', otilde: 'õ', oslash: 'ø', uacute: 'ú', ugrave: 'ù', ucircumflex: 'û', udieresis: 'ü', yacute: 'ý',
  ydieresis: 'ÿ', Eacute: 'É', Egrave: 'È', Ecircumflex: 'Ê', Edieresis: 'Ë', Aacute: 'Á', Agrave: 'À',
  Acircumflex: 'Â', Adieresis: 'Ä', Atilde: 'Ã', Aring: 'Å', Ccedilla: 'Ç', Iacute: 'Í', Igrave: 'Ì',
  Icircumflex: 'Î', Idieresis: 'Ï', Ntilde: 'Ñ', Oacute: 'Ó', Ograve: 'Ò', Ocircumflex: 'Ô', Odieresis: 'Ö',
  Otilde: 'Õ', Oslash: 'Ø', Uacute: 'Ú', Ugrave: 'Ù', Ucircumflex: 'Û', Udieresis: 'Ü', germandbls: 'ß', AE: 'Æ',
  ae: 'æ', OE: 'Œ', oe: 'œ',
};

function glyphChar(name: string): string | undefined {
  if (name.length === 1) return name;
  const known = GLYPH_NAMES[name];
  if (known !== undefined) return known;
  const uni = /^uni([0-9A-Fa-f]{4})/.exec(name) ?? /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (uni) return String.fromCodePoint(Number.parseInt(uni[1]!, 16));
  return undefined;
}

// --- The object syntax ---------------------------------------------------------

const WHITESPACE = /\s/;
const DELIMITER = /[\s()<>[\]{}/%]/;

/** One object token starting at `pos`, and where it ends. */
function readValue(text: string, pos: number): { value: string; end: number } {
  let at = pos;
  while (at < text.length && (WHITESPACE.test(text[at]!) || text[at] === '%')) {
    if (text[at] === '%') {
      while (at < text.length && text[at] !== '\n' && text[at] !== '\r') at += 1;
    } else at += 1;
  }
  const start = at;
  if (at >= text.length) return { value: '', end: at };
  const char = text[at]!;

  if (text.startsWith('<<', at)) {
    let depth = 0;
    while (at < text.length) {
      if (text.startsWith('<<', at)) {
        depth += 1;
        at += 2;
      } else if (text.startsWith('>>', at)) {
        depth -= 1;
        at += 2;
        if (depth === 0) break;
      } else if (text[at] === '(') {
        at = readValue(text, at).end;
      } else if (text[at] === '<') {
        at = text.indexOf('>', at) + 1 || text.length;
      } else at += 1;
    }
    return { value: text.slice(start, at), end: at };
  }
  if (char === '[') {
    let depth = 0;
    while (at < text.length) {
      const here = text[at]!;
      if (here === '[') depth += 1;
      else if (here === ']') {
        depth -= 1;
        if (depth === 0) {
          at += 1;
          break;
        }
      } else if (here === '(') {
        at = readValue(text, at).end;
        continue;
      } else if (text.startsWith('<<', at)) {
        at = readValue(text, at).end;
        continue;
      }
      at += 1;
    }
    return { value: text.slice(start, at), end: at };
  }
  if (char === '(') {
    let depth = 0;
    while (at < text.length) {
      const here = text[at]!;
      if (here === '\\') at += 2;
      else {
        if (here === '(') depth += 1;
        else if (here === ')') {
          depth -= 1;
          if (depth === 0) {
            at += 1;
            break;
          }
        }
        at += 1;
      }
    }
    return { value: text.slice(start, at), end: at };
  }
  if (char === '<') {
    const close = text.indexOf('>', at);
    at = close < 0 ? text.length : close + 1;
    return { value: text.slice(start, at), end: at };
  }
  if (char === '/') {
    at += 1;
    while (at < text.length && !DELIMITER.test(text[at]!)) at += 1;
    return { value: text.slice(start, at), end: at };
  }
  if (/[0-9+\-.]/.test(char)) {
    while (at < text.length && /[0-9+\-.]/.test(text[at]!)) at += 1;
    const reference = /^\s+(\d+)\s+R(?![^\s()<>[\]{}/%])/.exec(text.slice(at, at + 24));
    if (reference && /^\d+$/.test(text.slice(start, at))) {
      at += reference[0].length;
    }
    return { value: text.slice(start, at), end: at };
  }
  while (at < text.length && !DELIMITER.test(text[at]!)) at += 1;
  if (at === start) at += 1;
  return { value: text.slice(start, at), end: at };
}

/** The key/value pairs of a dictionary, in order. */
function entries(dict: string): Array<[string, string]> {
  const trimmed = dict.trim();
  if (!trimmed.startsWith('<<')) return [];
  const inner = trimmed.slice(2, trimmed.endsWith('>>') ? -2 : undefined);
  const pairs: Array<[string, string]> = [];
  let at = 0;
  while (at < inner.length) {
    const key = readValue(inner, at);
    if (key.value === '') break;
    at = key.end;
    if (!key.value.startsWith('/')) continue;
    const value = readValue(inner, at);
    at = value.end;
    pairs.push([key.value.slice(1), value.value]);
  }
  return pairs;
}

function get(dict: string, key: string): string | undefined {
  return entries(dict).find(([name]) => name === key)?.[1];
}

/** Elements of an array value. */
function elements(array: string): string[] {
  const trimmed = array.trim();
  if (!trimmed.startsWith('[')) return trimmed === '' ? [] : [trimmed];
  const inner = trimmed.slice(1, trimmed.endsWith(']') ? -1 : undefined);
  const out: string[] = [];
  let at = 0;
  while (at < inner.length) {
    const next = readValue(inner, at);
    if (next.value === '') break;
    out.push(next.value);
    at = next.end;
  }
  return out;
}

/** The bytes of a literal or hex string token, as a latin1 string. */
function stringBytes(token: string): string {
  if (token.startsWith('<')) {
    const hex = token.slice(1, -1).replace(/[^0-9a-fA-F]/g, '');
    return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex').toString('latin1');
  }
  const inner = token.slice(1, token.endsWith(')') ? -1 : undefined);
  let out = '';
  for (let at = 0; at < inner.length; at += 1) {
    const char = inner[at]!;
    if (char !== '\\') {
      out += char;
      continue;
    }
    at += 1;
    const next = inner[at];
    if (next === undefined) break;
    if (next === 'n') out += '\n';
    else if (next === 'r') out += '\r';
    else if (next === 't') out += '\t';
    else if (next === 'b') out += '\b';
    else if (next === 'f') out += '\f';
    else if (next === '\n') continue;
    else if (next === '\r') {
      if (inner[at + 1] === '\n') at += 1;
    } else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(inner[at + 1] ?? '')) {
        at += 1;
        octal += inner[at];
      }
      out += String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
    } else out += next;
  }
  return out;
}

// --- The file ----------------------------------------------------------------------

class PdfFile {
  readonly objects = new Map<number, PdfObject>();
  /**
   * Where in the file each object was defined. Without parsing the xref the
   * rule is the one an incremental update relies on: the later definition
   * wins, whether it sits at top level or inside an object stream.
   */
  readonly #positions = new Map<number, number>();
  unreadableStreams = 0;
  #inflated = 0;
  readonly #decoded = new Map<number, Buffer | undefined>();
  readonly raw: string;

  constructor(raw: string) {
    this.raw = raw;
    this.#loadObjects();
    this.#expandObjectStreams();
  }

  #loadObjects(): void {
    const header = /(\d+)\s+(\d+)\s+obj\b/g;
    let match: RegExpExecArray | null;
    while ((match = header.exec(this.raw))) {
      const number = Number(match[1]);
      const bodyStart = match.index + match[0].length;
      let end = this.raw.indexOf('endobj', bodyStart);
      if (end < 0) end = this.raw.length;
      const body = this.raw.slice(bodyStart, end);
      const streamAt = body.search(/(?<![a-z])stream\r?\n/);
      this.#positions.set(number, match.index);
      if (streamAt < 0) {
        this.objects.set(number, { dict: body.trim() });
        continue;
      }
      const dict = body.slice(0, streamAt).trim();
      const dataStart = bodyStart + streamAt + (body[streamAt + 6] === '\r' ? 8 : 7);
      let dataEnd = -1;
      const declared = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      if (declared) {
        const candidate = dataStart + Number(declared[1]);
        if (/^\s*endstream/.test(this.raw.slice(candidate, candidate + 12))) dataEnd = candidate;
      }
      if (dataEnd < 0) {
        const at = this.raw.indexOf('endstream', dataStart);
        if (at < 0) break;
        dataEnd = at;
        if (this.raw[dataEnd - 1] === '\n') dataEnd -= 1;
        if (this.raw[dataEnd - 1] === '\r') dataEnd -= 1;
      }
      this.objects.set(number, { dict, stream: Buffer.from(this.raw.slice(dataStart, dataEnd), 'latin1') });
      const after = this.raw.indexOf('endobj', dataEnd);
      header.lastIndex = after < 0 ? this.raw.length : after + 6;
    }
  }

  /** Objects packed inside object streams (PDF 1.5 onwards), where most modern files keep them. */
  #expandObjectStreams(): void {
    for (const [number, object] of [...this.objects]) {
      if (!object.stream || !/\/Type\s*\/ObjStm\b/.test(object.dict)) continue;
      const data = this.decoded(number);
      if (!data) continue;
      const count = Number(get(object.dict, 'N') ?? 0);
      const first = Number(get(object.dict, 'First') ?? 0);
      const text = data.toString('latin1');
      const offsets = text.slice(0, first).trim().split(/\s+/).map(Number);
      for (let index = 0; index < count; index += 1) {
        const objectNumber = offsets[index * 2];
        const offset = offsets[index * 2 + 1];
        if (objectNumber === undefined || offset === undefined || Number.isNaN(objectNumber)) break;
        const next = index + 1 < count ? offsets[index * 2 + 3] : undefined;
        const body = text.slice(first + offset, next === undefined ? undefined : first + next).trim();
        const existing = this.#positions.get(objectNumber);
        const here = this.#positions.get(number) ?? 0;
        if (existing === undefined || existing < here) {
          this.objects.set(objectNumber, { dict: body });
          this.#positions.set(objectNumber, here);
        }
      }
    }
  }

  /** The value a token refers to: the object's dictionary for a reference, the token itself otherwise. */
  resolve(token: string | undefined): string | undefined {
    if (token === undefined) return undefined;
    const reference = /^(\d+)\s+\d+\s+R$/.exec(token.trim());
    if (!reference) return token;
    return this.objects.get(Number(reference[1]))?.dict;
  }

  objectOf(token: string | undefined): { number?: number; object?: PdfObject } {
    if (token === undefined) return {};
    const reference = /^(\d+)\s+\d+\s+R$/.exec(token.trim());
    if (!reference) return {};
    const number = Number(reference[1]);
    return { number, object: this.objects.get(number) };
  }

  /** A stream's bytes after its filter, or nothing where the filter is not one decoded here. */
  decoded(number: number): Buffer | undefined {
    if (this.#decoded.has(number)) return this.#decoded.get(number);
    const object = this.objects.get(number);
    let out: Buffer | undefined;
    if (object?.stream) {
      const filters = (this.resolve(get(object.dict, 'Filter')) ?? '').match(/\/[A-Za-z0-9]+/g) ?? [];
      if (filters.length === 0) out = object.stream;
      else if (filters.length === 1 && (filters[0] === '/FlateDecode' || filters[0] === '/Fl')) {
        out = this.#inflate(object.stream);
        const parms = this.resolve(get(object.dict, 'DecodeParms'));
        const predictor = Number(parms ? get(parms, 'Predictor') ?? 1 : 1);
        if (out && predictor >= 10) {
          const columns = Number(parms ? get(parms, 'Columns') ?? 1 : 1);
          const colors = Number(parms ? get(parms, 'Colors') ?? 1 : 1);
          const bits = Number(parms ? get(parms, 'BitsPerComponent') ?? 8 : 8);
          out = unpredict(out, columns, colors, bits);
        } else if (out && predictor > 1) {
          out = undefined;
        }
      }
      if (!out) this.unreadableStreams += 1;
    }
    this.#decoded.set(number, out);
    return out;
  }

  #inflate(bytes: Buffer): Buffer | undefined {
    if (this.#inflated >= MAX_TOTAL_BYTES) return undefined;
    // A leading newline before the zlib header is a known generator fault.
    let start = 0;
    while (start < bytes.length && (bytes[start] === 0x0a || bytes[start] === 0x0d || bytes[start] === 0x20)) start += 1;
    try {
      const out = inflateSync(start === 0 ? bytes : bytes.subarray(start), { maxOutputLength: MAX_STREAM_BYTES });
      this.#inflated += out.length;
      return out;
    } catch {
      return undefined;
    }
  }

  /** The pages in reading order, each with the resources it inherits. */
  pages(): Array<{ dict: string; resources: string | undefined }> {
    const found: Array<{ dict: string; resources: string | undefined }> = [];
    const seen = new Set<number>();
    const walk = (token: string, inherited: string | undefined, depth: number): void => {
      const { number, object } = this.objectOf(token);
      if (number === undefined || !object || seen.has(number) || depth > 64) return;
      seen.add(number);
      const own = get(object.dict, 'Resources');
      const resources = own === undefined ? inherited : (this.resolve(own) ?? inherited);
      if (/\/Type\s*\/Pages\b/.test(object.dict)) {
        for (const kid of elements(this.resolve(get(object.dict, 'Kids')) ?? '')) walk(kid, resources, depth + 1);
      } else if (/\/Type\s*\/Page\b/.test(object.dict) || get(object.dict, 'Contents') !== undefined) {
        found.push({ dict: object.dict, resources });
      }
    };
    const catalog = [...this.objects].find(([, object]) => /\/Type\s*\/Catalog\b/.test(object.dict));
    const root = catalog ? get(catalog[1].dict, 'Pages') : undefined;
    if (root) walk(root, undefined, 0);
    if (found.length === 0) {
      // No usable tree: every page object in number order is better than none.
      for (const [number, object] of [...this.objects].sort((a, b) => a[0] - b[0])) {
        if (seen.has(number) || !/\/Type\s*\/Page\b/.test(object.dict)) continue;
        found.push({ dict: object.dict, resources: this.resolve(get(object.dict, 'Resources')) });
      }
    }
    return found;
  }
}

/** PNG predictors, which xref and object streams commonly carry. */
function unpredict(data: Buffer, columns: number, colors: number, bits: number): Buffer {
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLength = Math.ceil((columns * colors * bits) / 8);
  const rows = Math.floor(data.length / (rowLength + 1));
  const out = Buffer.alloc(rows * rowLength);
  let previous = Buffer.alloc(rowLength);
  for (let row = 0; row < rows; row += 1) {
    const type = data[row * (rowLength + 1)]!;
    const line = Buffer.from(data.subarray(row * (rowLength + 1) + 1, (row + 1) * (rowLength + 1)));
    for (let index = 0; index < rowLength; index += 1) {
      const left = index >= bpp ? line[index - bpp]! : 0;
      const up = previous[index]!;
      const upLeft = index >= bpp ? previous[index - bpp]! : 0;
      let value = line[index]!;
      if (type === 1) value += left;
      else if (type === 2) value += up;
      else if (type === 3) value += Math.floor((left + up) / 2);
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[index] = value & 0xff;
    }
    line.copy(out, row * rowLength);
    previous = line;
  }
  return out;
}

// --- Fonts ---------------------------------------------------------------------------

function parseCMap(text: string): { map: Map<number, string>; bytesPerCode?: 1 | 2 } {
  const map = new Map<number, string>();
  let bytesPerCode: 1 | 2 | undefined;
  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  const first = codespace ? /<([0-9a-fA-F]+)>/.exec(codespace[1]!) : undefined;
  if (first) bytesPerCode = first[1]!.length <= 2 ? 1 : 2;

  const utf16 = (hex: string): string => {
    const clean = hex.length % 4 === 0 ? hex : hex.padStart(Math.ceil(hex.length / 4) * 4, '0');
    const bytes = Buffer.from(clean, 'hex');
    if (bytes.length === 0) return '';
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const high = bytes[index]!;
      bytes[index] = bytes[index + 1]!;
      bytes[index + 1] = high;
    }
    return bytes.toString('utf16le');
  };

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (bytesPerCode === undefined) bytesPerCode = pair[1]!.length <= 2 ? 1 : 2;
      map.set(Number.parseInt(pair[1]!, 16), utf16(pair[2]!));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const range of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      if (bytesPerCode === undefined) bytesPerCode = range[1]!.length <= 2 ? 1 : 2;
      const low = Number.parseInt(range[1]!, 16);
      const high = Math.min(Number.parseInt(range[2]!, 16), low + 65535);
      const target = range[3]!;
      if (target.startsWith('[')) {
        const items = [...target.matchAll(/<([0-9a-fA-F]*)>/g)].map((item) => utf16(item[1]!));
        for (let code = low; code <= high && code - low < items.length; code += 1) map.set(code, items[code - low]!);
      } else {
        const base = utf16(target.slice(1, -1));
        const last = base.codePointAt(base.length - 1) ?? 0;
        const prefix = base.slice(0, -1);
        for (let code = low; code <= high; code += 1) map.set(code, prefix + String.fromCodePoint(last + (code - low)));
      }
    }
  }
  return { map, ...(bytesPerCode ? { bytesPerCode } : {}) };
}

/**
 * Glyph advances, so the reader knows where a run ends.
 *
 * A simple font lists `Widths` from `FirstChar`; a composite font's descendant
 * lists `W` as runs and ranges with `DW` for the rest. A standard font embeds
 * neither and is measured with the metrics the platform's own renderer uses —
 * Helvetica and Courier exactly, anything else at an average that is wrong by
 * a few percent, which is enough to find a column and not enough to typeset.
 */
function widthsFor(file: PdfFile, fontDict: string, subtype: string | undefined): Pick<Decoder, 'widths' | 'fallbackWidth'> {
  const base = (get(fontDict, 'BaseFont') ?? '').replace(/^\/[A-Z]{6}\+/, '/');
  const bold = /bold/i.test(base);
  const standard = /courier|mono/i.test(base)
    ? (): number => 600
    : /helvetica|arial/i.test(base)
      ? (code: number): number => standardWidth(code, bold ? 'Helvetica-Bold' : 'Helvetica')
      : (): number => 500;

  if (subtype === '/Type0') {
    const descendant = file.resolve(elements(file.resolve(get(fontDict, 'DescendantFonts')) ?? '')[0]);
    const defaultWidth = Number(descendant ? get(descendant, 'DW') ?? 1000 : 1000);
    const widths = new Map<number, number>();
    const items = elements(file.resolve(descendant ? get(descendant, 'W') : undefined) ?? '');
    for (let at = 0; at < items.length; ) {
      const first = Number(items[at]);
      const next = items[at + 1];
      if (next === undefined || !Number.isFinite(first)) break;
      if (next.startsWith('[')) {
        elements(next).forEach((w, index) => widths.set(first + index, Number(w)));
        at += 2;
      } else {
        const last = Math.min(Number(next), first + 65535);
        const w = Number(items[at + 2]);
        for (let code = first; code <= last; code += 1) widths.set(code, w);
        at += 3;
      }
    }
    return { ...(widths.size > 0 ? { widths } : {}), fallbackWidth: () => defaultWidth };
  }

  const firstChar = Number(file.resolve(get(fontDict, 'FirstChar')) ?? 0);
  const listed = elements(file.resolve(get(fontDict, 'Widths')) ?? '').map((token) => Number(file.resolve(token) ?? token));
  const descriptor = file.resolve(get(fontDict, 'FontDescriptor'));
  const missing = Number(descriptor ? get(descriptor, 'MissingWidth') ?? Number.NaN : Number.NaN);
  if (listed.length === 0) return { fallbackWidth: standard };
  const widths = new Map<number, number>();
  listed.forEach((w, index) => {
    if (Number.isFinite(w)) widths.set(firstChar + index, w);
  });
  return { widths, fallbackWidth: Number.isFinite(missing) ? () => missing : standard };
}

function decoderFor(file: PdfFile, fontDict: string): Decoder {
  const subtype = get(fontDict, 'Subtype');
  const toUnicode = file.objectOf(get(fontDict, 'ToUnicode'));
  const cmapBytes = toUnicode.number === undefined ? undefined : file.decoded(toUnicode.number);
  const cmap = cmapBytes ? parseCMap(cmapBytes.toString('latin1')) : undefined;
  const metrics = widthsFor(file, fontDict, subtype);

  if (subtype === '/Type0') {
    if (cmap && cmap.map.size > 0) return { bytesPerCode: cmap.bytesPerCode ?? 2, map: cmap.map, undecodable: false, ...metrics };
    return { bytesPerCode: 2, undecodable: true, ...metrics };
  }

  const encoding = get(fontDict, 'Encoding');
  const resolvedEncoding = file.resolve(encoding);
  let base = 'WinAnsiEncoding';
  const differences = new Map<number, string>();
  if (resolvedEncoding?.startsWith('/')) base = resolvedEncoding.slice(1);
  else if (resolvedEncoding?.startsWith('<<')) {
    const named = get(resolvedEncoding, 'BaseEncoding');
    if (named?.startsWith('/')) base = named.slice(1);
    let code = 0;
    for (const item of elements(file.resolve(get(resolvedEncoding, 'Differences')) ?? '')) {
      if (/^\d+$/.test(item)) code = Number(item);
      else if (item.startsWith('/')) {
        differences.set(code, glyphChar(item.slice(1)) ?? ' ');
        code += 1;
      }
    }
  } else if (!cmap) {
    // No encoding named and no map: a symbolic font's built-in encoding is
    // its own, and reading it as WinAnsi would be a guess dressed as text.
    const descriptor = file.resolve(get(fontDict, 'FontDescriptor'));
    const flags = Number(descriptor ? get(descriptor, 'Flags') ?? 0 : 0);
    if ((flags & 4) !== 0 && (flags & 32) === 0 && subtype !== '/Type3') return { bytesPerCode: 1, undecodable: true, ...metrics };
  }
  const simple = encodingTable(base);
  for (const [code, char] of differences) simple[code] = char;
  return { bytesPerCode: 1, ...(cmap && cmap.map.size > 0 ? { map: cmap.map } : {}), simple, undecodable: false, ...metrics };
}

function fontsOf(file: PdfFile, resources: string | undefined, cache: Map<string, Decoder>): Map<string, Decoder> {
  const fonts = new Map<string, Decoder>();
  if (!resources) return fonts;
  const fontDict = file.resolve(get(resources, 'Font'));
  if (!fontDict) return fonts;
  for (const [name, token] of entries(fontDict)) {
    const key = /R$/.test(token.trim()) ? token.trim() : `${name}:${token}`;
    let decoder = cache.get(key);
    if (!decoder) {
      const dict = file.resolve(token);
      decoder = dict ? decoderFor(file, dict) : DEFAULT_DECODER;
      cache.set(key, decoder);
    }
    fonts.set(name, decoder);
  }
  return fonts;
}

// --- Content streams ---------------------------------------------------------------

type PageState = {
  out: string[];
  pending: '' | ' ' | '\n';
  undecodable: number;
  images: number;
  /** Every shown string with where it sits, for `recoverTables`. */
  runs: Run[];
  /** The run the next string continues, if it lands beside it. */
  current?: Run;
};

/** Text state inside a content stream: the matrices and the parameters that move the pen. */
type TextState = {
  ctm: Matrix;
  tm: Matrix;
  tlm: Matrix;
  size: number;
  charSpacing: number;
  wordSpacing: number;
  hscale: number;
  leading: number;
  rise: number;
};

const DEFAULT_DECODER: Decoder = {
  bytesPerCode: 1,
  simple: encodingTable('WinAnsiEncoding'),
  undecodable: false,
  fallbackWidth: (code) => standardWidth(code, 'Helvetica'),
};

function decodeString(bytes: string, font: Decoder | undefined, state: PageState): string {
  const decoder = font ?? DEFAULT_DECODER;
  if (decoder.undecodable) {
    state.undecodable += 1;
    return '';
  }
  let out = '';
  let missed = false;
  if (decoder.bytesPerCode === 2) {
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const code = (bytes.charCodeAt(index) << 8) | bytes.charCodeAt(index + 1);
      const char = decoder.map?.get(code);
      if (char === undefined) missed = true;
      else out += char;
    }
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      const code = bytes.charCodeAt(index);
      const mapped = decoder.map?.get(code);
      const char = mapped ?? decoder.simple?.[code];
      if (char === undefined || char === ' ') missed = true;
      else out += char;
    }
  }
  if (missed && out === '') state.undecodable += 1;
  return out;
}

function emit(state: PageState, text: string): void {
  if (text === '') return;
  state.out.push(state.pending + text);
  state.pending = '';
}

/** How far a string moves the pen, in unscaled text space (before `Tm` and the CTM). */
function advanceOf(bytes: string, font: Decoder | undefined, text: TextState): number {
  const decoder = font ?? DEFAULT_DECODER;
  let advance = 0;
  const step = decoder.bytesPerCode;
  for (let index = 0; index + step <= bytes.length; index += step) {
    const code = step === 2 ? (bytes.charCodeAt(index) << 8) | bytes.charCodeAt(index + 1) : bytes.charCodeAt(index);
    const width = decoder.widths?.get(code) ?? decoder.fallbackWidth(code);
    advance += (width / 1000) * text.size + text.charSpacing + (step === 1 && code === 32 ? text.wordSpacing : 0);
  }
  return advance * text.hscale;
}

/**
 * Show a string: emit it for the text, keep it as a run for the tables, and
 * move the pen by what it measured.
 *
 * A string that lands where the last one left off continues that run — it is
 * the rest of the same cell, or the same word set in pieces for kerning. One
 * that lands further along the same baseline than half a font size, or on
 * another baseline, starts a new run: another cell, or another line.
 */
function show(bytes: string, font: Decoder | undefined, state: PageState, text: TextState): void {
  const decoded = decodeString(bytes, font, state);
  emit(state, decoded);
  const advance = advanceOf(bytes, font, text);
  const device = multiply(text.tm, text.ctm);
  const rendered = multiply(multiply([text.size * text.hscale, 0, 0, text.size, 0, text.rise], text.tm), text.ctm);
  const size = Math.hypot(rendered[2], rendered[3]) || text.size;
  const x = device[4];
  const y = device[5] + text.rise * Math.hypot(device[2], device[3]);
  text.tm = multiply([1, 0, 0, 1, advance, 0], text.tm);
  const end = multiply(text.tm, text.ctm)[4];
  const current = state.current;
  const gap = current ? x - current.end : Number.POSITIVE_INFINITY;
  // Within two-thirds of a font size is a word space, Courier's included; a
  // column's padding is wider than that in every layout this has met.
  const beside = current !== undefined && Math.abs(y - current.y) <= 0.35 * Math.max(size, current.size) && gap > -0.2 * size && gap < 0.65 * size;
  if (decoded === '') {
    // An empty string moves nothing but the pen. Beside the current run it
    // widens it (a space set on its own); anywhere else — an empty cell drawn
    // at its own column — it is not part of any run.
    if (beside) current.end = Math.max(current.end, end);
    return;
  }
  if (beside) {
    current.text += (gap > 0.13 * size && !/\s$/.test(current.text) && !/^\s/.test(decoded) ? ' ' : '') + decoded;
    current.end = Math.max(current.end, end);
    current.size = Math.max(current.size, size);
  } else {
    const run: Run = { x, y, end, size, text: decoded };
    state.runs.push(run);
    state.current = run;
  }
}

function walkContent(
  file: PdfFile,
  content: string,
  resources: string | undefined,
  state: PageState,
  cache: Map<string, Decoder>,
  depth: number,
  ctm: Matrix = IDENTITY,
): void {
  const fonts = fontsOf(file, resources, cache);
  const xobjects = file.resolve(get(resources ?? '', 'XObject'));
  let font: Decoder | undefined;
  const text: TextState = { ctm, tm: IDENTITY, tlm: IDENTITY, size: 0, charSpacing: 0, wordSpacing: 0, hscale: 1, leading: 0, rise: 0 };
  const saved: Array<{ font: Decoder | undefined; ctm: Matrix }> = [];
  const operands: string[] = [];
  let lastY: number | undefined;
  let at = 0;
  const number = (index: number): number => {
    const value = Number(operands[operands.length - index] ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const newline = (leading = text.leading): void => {
    text.tlm = multiply([1, 0, 0, 1, 0, -leading], text.tlm);
    text.tm = text.tlm;
  };

  while (at < content.length) {
    const token = readValue(content, at);
    if (token.value === '') break;
    at = token.end;
    const value = token.value;
    const first = value[0]!;

    if (first === '(' || first === '<' || first === '[' || first === '/' || /[0-9+\-.]/.test(first)) {
      operands.push(value);
      continue;
    }

    // An operator.
    switch (value) {
      case 'BT':
        text.tm = IDENTITY;
        text.tlm = IDENTITY;
        break;
      case 'Tf':
        font = fonts.get((operands[operands.length - 2] ?? '').slice(1));
        text.size = number(1);
        break;
      case 'Tc':
        text.charSpacing = number(1);
        break;
      case 'Tw':
        text.wordSpacing = number(1);
        break;
      case 'Tz':
        text.hscale = number(1) / 100 || 1;
        break;
      case 'TL':
        text.leading = number(1);
        break;
      case 'Ts':
        text.rise = number(1);
        break;
      case 'Tj':
        show(stringBytes(operands[operands.length - 1] ?? '()'), font, state, text);
        break;
      case "'":
        state.pending = '\n';
        newline();
        show(stringBytes(operands[operands.length - 1] ?? '()'), font, state, text);
        break;
      case '"':
        state.pending = '\n';
        text.wordSpacing = number(3);
        text.charSpacing = number(2);
        newline();
        show(stringBytes(operands[operands.length - 1] ?? '()'), font, state, text);
        break;
      case 'TJ': {
        for (const item of elements(operands[operands.length - 1] ?? '[]')) {
          if (item.startsWith('(') || item.startsWith('<')) show(stringBytes(item), font, state, text);
          else {
            const adjustment = Number(item);
            if (!Number.isFinite(adjustment)) continue;
            if (adjustment < WORD_GAP && state.pending === '') state.pending = ' ';
            text.tm = multiply([1, 0, 0, 1, (-adjustment / 1000) * text.size * text.hscale, 0], text.tm);
          }
        }
        break;
      }
      case 'T*':
        state.pending = '\n';
        newline();
        break;
      case 'Td':
      case 'TD': {
        const ty = number(1);
        const tx = number(2);
        if (ty !== 0) state.pending = '\n';
        else if (tx > 0 && state.pending === '') state.pending = ' ';
        if (value === 'TD') text.leading = -ty;
        text.tlm = multiply([1, 0, 0, 1, tx, ty], text.tlm);
        text.tm = text.tlm;
        break;
      }
      case 'Tm': {
        const y = number(1);
        if (lastY !== undefined && Math.abs(y - lastY) > 0.5) state.pending = '\n';
        else if (state.pending === '') state.pending = ' ';
        lastY = y;
        const matrix = matrixOf(operands);
        if (matrix) {
          text.tlm = matrix;
          text.tm = matrix;
        }
        break;
      }
      case 'ET':
        state.pending = '\n';
        break;
      case 'cm': {
        const matrix = matrixOf(operands);
        if (matrix) text.ctm = multiply(matrix, text.ctm);
        break;
      }
      case 'q':
        saved.push({ font, ctm: text.ctm });
        break;
      case 'Q': {
        const restored = saved.pop();
        if (restored) {
          font = restored.font;
          text.ctm = restored.ctm;
        }
        break;
      }
      case 'Do': {
        const name = (operands[operands.length - 1] ?? '').slice(1);
        const { number: objectNumber, object } = file.objectOf(get(xobjects ?? '', name));
        if (object && /\/Subtype\s*\/Image\b/.test(object.dict)) state.images += 1;
        else if (objectNumber !== undefined && object && /\/Subtype\s*\/Form\b/.test(object.dict) && depth < MAX_FORM_DEPTH) {
          const data = file.decoded(objectNumber);
          if (data) {
            const own = file.resolve(get(object.dict, 'Resources'));
            const formMatrix = matrixOf(elements(file.resolve(get(object.dict, 'Matrix')) ?? ''));
            walkContent(file, data.toString('latin1'), own ?? resources, state, cache, depth + 1, formMatrix ? multiply(formMatrix, text.ctm) : text.ctm);
          }
        }
        break;
      }
      case 'BI': {
        // An inline image: binary until EI. Counted as an image, skipped as bytes.
        const end = /\sEI(?=\s|$)/.exec(content.slice(at));
        at = end ? at + end.index + end[0].length : content.length;
        state.images += 1;
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

function pageContent(file: PdfFile, page: { dict: string }): string | undefined {
  const contents = get(page.dict, 'Contents');
  if (contents === undefined) return undefined;
  const parts: string[] = [];
  const list = contents.trim().startsWith('[') ? elements(contents) : [contents];
  for (const token of list) {
    const { number } = file.objectOf(token);
    if (number === undefined) continue;
    const data = file.decoded(number);
    if (data) parts.push(data.toString('latin1'));
  }
  return parts.length === 0 ? undefined : parts.join('\n');
}

function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Tables -----------------------------------------------------------------------

/** A full stop that ends a sentence. Column headings do not contain one. Shared with the delimited parser. */
export const SENTENCE_END = /\.(\s|$)/;
/** Rows in one recovered table. A bill runs to hundreds; a record has to end somewhere. */
const MAX_TABLE_ROWS = 500;
/**
 * A wrapped line sits this many font sizes under the one above, at most. Text
 * is leaded at 1.15 to 1.35; a table row carries padding on top of that.
 */
const LINE_HEIGHT = 1.35;

type Cell = { start: number; end: number; text: string };
type Line = { y: number; size: number; cells: Cell[] };

/** Runs grouped onto baselines, top of the page first, each line's cells left to right. */
function linesOf(runs: Run[]): Line[] {
  const lines: Line[] = [];
  for (const run of [...runs].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - run.y) <= 0.35 * Math.max(line.size, run.size)) {
      line.cells.push({ start: run.x, end: run.end, text: run.text.trim() });
      line.size = Math.max(line.size, run.size);
    } else {
      lines.push({ y: run.y, size: run.size, cells: [{ start: run.x, end: run.end, text: run.text.trim() }] });
    }
  }
  for (const line of lines) {
    line.cells.sort((a, b) => a.start - b.start);
    // Two runs that abut on one baseline are one cell: a word set in pieces
    // across a font change, or a figure and its unit.
    const merged: Cell[] = [];
    for (const cell of line.cells) {
      const last = merged[merged.length - 1];
      if (last && cell.start - last.end < 0.65 * line.size) {
        last.text = `${last.text}${cell.start - last.end > 0.13 * line.size ? ' ' : ''}${cell.text}`.trim();
        last.end = Math.max(last.end, cell.end);
      } else merged.push({ ...cell });
    }
    line.cells = merged.filter((cell) => cell.text !== '');
  }
  return lines.filter((line) => line.cells.length > 0);
}

/** Column extents: the horizontal spans no cell in the block crosses, merged where cells overlap. */
function columnsOf(lines: Line[]): Array<{ start: number; end: number }> {
  const spans = lines
    .flatMap((line) => line.cells.map((cell) => ({ start: cell.start, end: cell.end })))
    .sort((a, b) => a.start - b.start);
  const columns: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const last = columns[columns.length - 1];
    if (last && span.start <= last.end + 1) last.end = Math.max(last.end, span.end);
    else columns.push({ ...span });
  }
  return columns;
}

function columnIndex(columns: Array<{ start: number; end: number }>, cell: Cell): number {
  return columns.findIndex((column) => cell.start >= column.start - 1 && cell.end <= column.end + 1);
}

/** A column heading: `Item`, `Unit`, `Rate`. Not a sentence, and not a paragraph's first line. */
function headingLike(text: string): boolean {
  return text !== '' && !SENTENCE_END.test(text) && text.length <= 80;
}

/** Short enough to be a unit, a quantity, a clause number or a date rather than prose. */
function shortCell(text: string): boolean {
  return text.length <= 16 || text.split(/\s+/).length <= 3;
}

/**
 * A block of consecutive lines as a table, or nothing.
 *
 * Deliberately conservative, for the same reason the delimited parser is: a
 * table with the wrong columns is read as a bill of quantities by somebody who
 * did not build it. The rules, and what each refuses:
 *
 * 1. At least three lines, each with at least two cells. One line of two
 *    things side by side is a heading and a date.
 * 2. Columns are the horizontal spans no cell crosses. Prose set word by word
 *    has words at every position, so its lines merge into one span and there
 *    is no table. Left-, right- and centre-aligned columns all qualify, since
 *    the rule is about extents rather than starting points.
 * 3. No line has two cells in one column, and the header row has a cell in
 *    every column with no sentence in it. A block where the header fills two
 *    columns and the body five is a paragraph beside a list, not a table.
 * 4. At least one column is short cells — a unit, a quantity, a clause number.
 *    Two columns of wrapped prose line up perfectly and are not a table.
 * 5. Every column carries text on at least two lines.
 *
 * A line set one line-height beneath a row, with cells only where that row
 * already has text, is the rest of those cells — a wrapped description — and
 * is joined to them rather than read as a row of blanks.
 */
function tableOf(block: Line[]): string[][] | undefined {
  if (block.length < 3) return undefined;
  const columns = columnsOf(block);
  if (columns.length < 2) return undefined;

  const rows: string[][] = [];
  let previousY = Number.NaN;
  for (const line of block) {
    const row = new Array<string>(columns.length).fill('');
    for (const cell of line.cells) {
      const index = columnIndex(columns, cell);
      if (index < 0 || row[index] !== '') return undefined;
      row[index] = cell.text;
    }
    // The rest of a wrapped cell: one line-height down, in fewer columns than
    // the row above, and only in columns that row already fills. A line that
    // fills as many columns as the row above is the next row however close.
    const last = rows[rows.length - 1];
    const continuation =
      last !== undefined &&
      rows.length > 1 &&
      Number.isFinite(previousY) &&
      previousY - line.y <= LINE_HEIGHT * line.size &&
      line.cells.length < last.filter((text) => text !== '').length &&
      row.every((text, index) => text === '' || last[index] !== '');
    if (continuation) {
      row.forEach((text, index) => {
        if (text !== '') last![index] = `${last![index]} ${text}`;
      });
    } else rows.push(row);
    previousY = line.y;
  }

  if (rows.length < 3) return undefined;
  const header = rows[0]!;
  if (!header.every(headingLike)) return undefined;
  if (!columns.some((_column, index) => rows.slice(1).every((row) => row[index] === '' || shortCell(row[index]!)))) return undefined;
  if (!columns.every((_column, index) => rows.filter((row) => row[index] !== '').length >= 2)) return undefined;
  return rows.slice(0, MAX_TABLE_ROWS);
}

/**
 * The tables on one page, from where its text sits.
 *
 * Lines with two or more cells, consecutive and no further apart than three
 * font sizes, form a block; a line with one cell that is not the continuation
 * of a wrapped cell ends it. Each block is a table on `tableOf`'s terms or it
 * is nothing.
 */
export function recoverTables(runs: Run[]): string[][][] {
  const lines = linesOf(runs);
  const tables: string[][][] = [];
  let block: Line[] = [];
  const close = (): void => {
    const table = tableOf(block);
    if (table) tables.push(table);
    block = [];
  };
  for (const line of lines) {
    const previous = block[block.length - 1];
    if (previous && previous.y - line.y > 3 * Math.max(previous.size, line.size)) close();
    if (line.cells.length >= 2) {
      block.push(line);
      continue;
    }
    // One cell. The rest of a wrapped cell, if it sits one line-height under
    // the line above and inside a column the last full row fills; otherwise
    // the block ends here. A description wrapped over three lines is two
    // such lines in a row, each measured against the one above it.
    const above = block[block.length - 1];
    const row = [...block].reverse().find((entry) => entry.cells.length >= 2);
    const columns = row ? columnsOf(block.filter((entry) => entry.cells.length >= 2)) : [];
    const index = columnIndex(columns, line.cells[0]!);
    if (above && row && index >= 0 && above.y - line.y <= LINE_HEIGHT * line.size && row.cells.some((c) => columnIndex(columns, c) === index)) {
      block.push(line);
    } else {
      close();
    }
  }
  close();
  return tables;
}

/** Read what a PDF says. Never throws: a file this cannot parse reads as no pages. */
export function readPdfText(bytes: Buffer): PdfReading {
  const empty: PdfReading = { pages: 0, textPages: 0, imageOnlyPages: 0, undecodableStrings: 0, unreadableStreams: 0, encrypted: false, text: '', tables: [] };
  try {
    const raw = bytes.toString('latin1');
    if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(raw)) return { ...empty, encrypted: true };
    const file = new PdfFile(raw);
    const pages = file.pages();
    const cache = new Map<string, Decoder>();
    const texts: string[] = [];
    const tables: PdfTable[] = [];
    let textPages = 0;
    let imageOnlyPages = 0;
    let undecodable = 0;
    pages.forEach((page, index) => {
      const state: PageState = { out: [], pending: '', undecodable: 0, images: 0, runs: [] };
      const content = pageContent(file, page);
      if (content !== undefined) walkContent(file, content, page.resources, state, cache, 0);
      const text = tidy(state.out.join(''));
      undecodable += state.undecodable;
      if (text !== '') {
        textPages += 1;
        texts.push(text);
        for (const rows of recoverTables(state.runs)) tables.push({ page: index + 1, rows });
      } else if (state.images > 0) imageOnlyPages += 1;
    });
    return {
      pages: pages.length,
      textPages,
      imageOnlyPages,
      undecodableStrings: undecodable,
      unreadableStreams: file.unreadableStreams,
      encrypted: false,
      text: texts.join('\n\n'),
      tables,
    };
  } catch {
    return empty;
  }
}
