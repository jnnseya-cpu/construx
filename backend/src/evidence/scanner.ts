import { connect, type Socket } from 'node:net';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';

/**
 * Signature scanning, by talking to a scanner that has signatures.
 *
 * `ingest.ts` says plainly that it is not an antivirus: zero runtime
 * dependencies is settled, so there is no signature engine in this process and
 * there is not going to be one. What it never had was a way to *reach* one, so
 * `antivirusScanned: false` was permanent and every deployment — including one
 * with a perfectly good ClamAV beside it — carried an evidence store nothing had
 * ever scanned.
 *
 * This is the missing half. It is a client, not an engine: it speaks clamd's
 * INSTREAM protocol over a socket, which is a length-prefixed byte stream and a
 * one-line answer. That is about as much code as the SMTP client already in this
 * repository, and it holds no signatures of its own.
 *
 * ---
 *
 * **Unset means unscanned, and the record says so.** With no scanner configured
 * nothing changes: `antivirusScanned` stays false, the ingestion position keeps
 * reporting `antivirusConfigured: false`, and a count of zero quarantined still
 * cannot be read as "nothing infected".
 *
 * **Configured and unreachable is a refusal, not a shrug.** A deployment that
 * named a scanner expects it to run. Ingesting anyway and marking the file
 * unscanned would leave it in the register looking checked, and the operator who
 * configured the scanner would never know it had stopped answering. So the
 * command refuses, the file stays in the not-yet-read queue where it is visible,
 * and nobody gets a record claiming a scan that did not happen.
 *
 * **The scan is not the structural inspection.** They catch different things and
 * both are on the record. A signature engine knows about a virus in a document;
 * it does not care that a file uploaded as `image/png` is a Windows executable,
 * which is the threat that actually applies to an evidence store. Neither
 * replaces the other.
 *
 * ## The protocol
 *
 * clamd, `INSTREAM`: send `zINSTREAM\0`, then each chunk as a big-endian
 * `uint32` length followed by its bytes, then a zero length to end the stream.
 * The daemon answers one line — `stream: OK`, `stream: <signature> FOUND`, or
 * something ending `ERROR`. `zPING` answers `PONG`, and `zVERSION` names the
 * daemon and its signature database, which is worth recording beside a verdict:
 * "clean" against a database from 2019 is a different statement from "clean"
 * against today's.
 */

export type ScanOutcome =
  | { scanned: false; reason: string }
  | { scanned: true; clean: true; scanner: string; at: string }
  | { scanned: true; clean: false; signature: string; scanner: string; at: string };

/**
 * A `DomainError`, not a bare one.
 *
 * Found by running it: thrown as a plain `Error` the gateway had no mapping for
 * it and answered `500 INTERNAL_ERROR — The request could not be completed`,
 * which is precisely the outcome the message below was written to prevent. The
 * operator has to be told the scanner they configured is not answering; a 500
 * tells them the platform is broken.
 *
 * `503`: the request was fine and a dependency is down. Retrying once the
 * scanner is back is exactly the right thing for a caller to do.
 */
export class ScannerUnreachableError extends DomainError {
  constructor(message: string) {
    super('SCANNER_UNREACHABLE', message, 503);
    this.name = 'ScannerUnreachableError';
  }
}

/** 64KB, which is what clamd's own clients use and well under its stream limit. */
const CHUNK = 64 * 1024;

function target(): { host: string; port: number } | undefined {
  const host = config.antivirus.host.trim();
  if (host === '') return undefined;
  return { host, port: config.antivirus.port };
}

/** Whether this deployment has a scanner to talk to at all. */
export function scannerConfigured(): boolean {
  return target() !== undefined;
}

/** Where it is, for a screen that has to say so. Never any credential. */
export function scannerAddress(): string | undefined {
  const where = target();
  return where ? `${where.host}:${where.port}` : undefined;
}

function open(): Promise<Socket> {
  const where = target();
  if (!where) throw new ScannerUnreachableError('No scanner is configured');

  return new Promise((resolve, reject) => {
    const socket = connect({ host: where.host, port: where.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ScannerUnreachableError(`no connection within ${config.antivirus.timeoutMs}ms`));
    }, config.antivirus.timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      // The daemon can go quiet mid-stream on a large file; without this the
      // scan hangs for ever and takes the request with it.
      socket.setTimeout(config.antivirus.timeoutMs);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(new ScannerUnreachableError(`the connection was refused (${error.message})`));
    });
  });
}

/** One request, one reply, one connection. clamd closes after answering. */
function converse(socket: Socket, write: (socket: Socket) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\0/g, '').trim()));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new ScannerUnreachableError(`The scanner stopped responding after ${config.antivirus.timeoutMs}ms`));
    });
    socket.once('error', (error) => reject(new ScannerUnreachableError(`The scanner connection failed: ${error.message}`)));
    write(socket);
  });
}

/** Is it there, and what is it? Used by the position endpoint, not by a scan. */
export async function ping(): Promise<{ reachable: boolean; version?: string; reason?: string }> {
  if (!scannerConfigured()) return { reachable: false, reason: 'No scanner is configured on this deployment' };
  try {
    const socket = await open();
    const reply = await converse(socket, (s) => s.write('zVERSION\0'));
    return { reachable: true, version: reply === '' ? 'unnamed scanner' : reply };
  } catch (error) {
    return { reachable: false, reason: (error as Error).message };
  }
}

/**
 * Scan the bytes, or say honestly that nothing did.
 *
 * Throws `ScannerUnreachableError` where a scanner is configured and cannot be
 * reached — the caller must refuse rather than record an unscanned file as
 * checked. Returns `{ scanned: false }` only where none is configured, which is
 * a statement about the deployment rather than about the file.
 */
export async function scan(bytes: Buffer): Promise<ScanOutcome> {
  if (!scannerConfigured()) {
    return { scanned: false, reason: 'No scanner is configured on this deployment, so nothing looked for a signature.' };
  }

  const version = await ping();
  if (!version.reachable) {
    throw new ScannerUnreachableError(
      `A scanner is configured at ${scannerAddress()} and did not answer: ${version.reason}. Nothing has been ` +
        'recorded against this file — a record saying it was ingested would read as a file that was checked.',
    );
  }

  const socket = await open();
  const reply = await converse(socket, (s) => {
    s.write('zINSTREAM\0');
    for (let at = 0; at < bytes.length; at += CHUNK) {
      const slice = bytes.subarray(at, Math.min(at + CHUNK, bytes.length));
      const header = Buffer.alloc(4);
      header.writeUInt32BE(slice.length, 0);
      s.write(header);
      s.write(slice);
    }
    // A zero-length chunk ends the stream and asks for the verdict.
    s.write(Buffer.from([0, 0, 0, 0]));
  });

  const at = new Date().toISOString();
  const scanner = version.version ?? 'unnamed scanner';

  if (/\bFOUND\b/.test(reply)) {
    // "stream: Eicar-Test-Signature FOUND" — the middle is what was found, and
    // it is recorded verbatim. A quarantine record that says "infected" and not
    // what by is one nobody can act on or argue with.
    const signature = reply.replace(/^.*?:\s*/, '').replace(/\s*FOUND\s*$/, '').trim();
    return { scanned: true, clean: false, signature: signature === '' ? 'an unnamed signature' : signature, scanner, at };
  }
  if (/\bERROR\b/.test(reply) || reply === '') {
    throw new ScannerUnreachableError(
      `The scanner at ${scannerAddress()} answered "${reply === '' ? '(nothing)' : reply}" rather than a verdict. ` +
        'Nothing has been recorded against this file.',
    );
  }
  return { scanned: true, clean: true, scanner, at };
}
