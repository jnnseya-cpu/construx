import { inflateRawSync } from 'node:zlib';

/**
 * Reading a ZIP container, and nothing else about it.
 *
 * Two callers, one reader. Ingestion reads the entry names an archive declares
 * without expanding a byte, because the archive might be a bomb and the names
 * are enough to see a spreadsheet carrying an executable. The IFC reader
 * expands exactly one entry — the `.ifc` inside an `.ifczip` — under a size
 * cap. Both used to be impossible or hand-rolled where they were needed; the
 * format is one format, so this is one module.
 *
 * The central directory is read where the file has one, because a local
 * header may carry zero sizes and defer them to a data descriptor after the
 * data. A file with no readable directory — truncated, or still being written
 * — falls back to walking the local headers, which is what the name check
 * always did. Zero dependencies, as settled: `zlib` inflates.
 */

export type ZipEntry = {
  name: string;
  /** 0 stored, 8 deflate. Anything else is not expanded here. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Where the entry's local header begins. */
  offset: number;
};

/** The local header signature, `PK\x03\x04`, as the bytes it is. */
const LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
/** A legitimate xlsx has tens of entries; a file with thousands is telling you something on its own. */
const MAX_ENTRIES = 512;

/** Every entry the archive declares, sizes included, without expanding anything. */
export function zipEntries(bytes: Buffer): ZipEntry[] {
  return fromCentralDirectory(bytes) ?? fromLocalHeaders(bytes);
}

function fromCentralDirectory(bytes: Buffer): ZipEntry[] | undefined {
  // The end record is the last thing in the file, followed only by a comment
  // of at most 65,535 bytes.
  const floor = Math.max(0, bytes.length - 22 - 65_535);
  let at = -1;
  for (let index = bytes.length - 22; index >= floor; index -= 1) {
    if (bytes.readUInt32LE(index) === END_OF_DIRECTORY) {
      at = index;
      break;
    }
  }
  if (at < 0) return undefined;
  const count = bytes.readUInt16LE(at + 10);
  const directoryOffset = bytes.readUInt32LE(at + 16);
  if (directoryOffset >= bytes.length) return undefined;

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < Math.min(count, MAX_ENTRIES); index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== CENTRAL_HEADER) return undefined;
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42);
    if (cursor + 46 + nameLength > bytes.length) return undefined;
    entries.push({
      name: bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'),
      method,
      compressedSize,
      uncompressedSize,
      offset,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function fromLocalHeaders(bytes: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let at = 0;
  while (at >= 0 && entries.length < MAX_ENTRIES) {
    const found = bytes.indexOf(LOCAL_HEADER, at);
    if (found < 0 || found + 30 > bytes.length) break;
    const method = bytes.readUInt16LE(found + 8);
    const compressedSize = bytes.readUInt32LE(found + 18);
    const uncompressedSize = bytes.readUInt32LE(found + 22);
    const nameLength = bytes.readUInt16LE(found + 26);
    const extraLength = bytes.readUInt16LE(found + 28);
    if (found + 30 + nameLength > bytes.length) break;
    entries.push({
      name: bytes.subarray(found + 30, found + 30 + nameLength).toString('utf8'),
      method,
      compressedSize,
      uncompressedSize,
      offset: found,
    });
    at = found + 30 + nameLength + extraLength;
  }
  return entries;
}

export class ZipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * One entry's bytes, expanded, never beyond `maxBytes`.
 *
 * The cap is applied twice: to what the directory declares, before anything is
 * expanded, and to the inflater, so a directory that lies is caught by the
 * second. A method other than stored or deflate is refused by name rather than
 * guessed at.
 */
export function zipEntryBytes(bytes: Buffer, entry: ZipEntry, maxBytes: number): Buffer {
  if (entry.uncompressedSize > maxBytes) {
    throw new ZipError('ZIP_ENTRY_TOO_LARGE', `${entry.name} declares ${entry.uncompressedSize} bytes; nothing over ${maxBytes} is expanded.`);
  }
  if (entry.offset + 30 > bytes.length || !bytes.subarray(entry.offset, entry.offset + 4).equals(LOCAL_HEADER)) {
    throw new ZipError('ZIP_ENTRY_UNREADABLE', `${entry.name} has no local header where the directory says it is.`);
  }
  const nameLength = bytes.readUInt16LE(entry.offset + 26);
  const extraLength = bytes.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  // A local header with sizes deferred to a data descriptor has zeros here;
  // the directory's figure is the one to trust.
  const compressedSize = entry.compressedSize || bytes.readUInt32LE(entry.offset + 18);
  const data = bytes.subarray(start, Math.min(bytes.length, start + compressedSize));
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch (error) {
      throw new ZipError('ZIP_ENTRY_UNREADABLE', `${entry.name} would not inflate: ${(error as Error).message}`);
    }
  }
  throw new ZipError('ZIP_METHOD_UNSUPPORTED', `${entry.name} is compressed with method ${entry.method}; only stored and deflate are read.`);
}
