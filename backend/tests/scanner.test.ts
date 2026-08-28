import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { after, afterEach, before, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import { ping, scan, scannerAddress, scannerConfigured, ScannerUnreachableError } from '../src/evidence/scanner.ts';

/**
 * Talking to a scanner that has signatures.
 *
 * The platform holds none and never will — zero runtime dependencies is
 * settled — so `ingest.ts` says out loud that it is not an antivirus. What it
 * never had was a way to *reach* one, which meant a deployment with a perfectly
 * good ClamAV beside it still carried an evidence store nothing had scanned.
 *
 * Verified against a clamd of this file's own, speaking the real INSTREAM
 * protocol: a null-terminated command, length-prefixed chunks, a zero length to
 * end the stream, one line back. The same approach the SMTP client already
 * takes — the protocol is the thing being tested, so a stub that answers
 * whatever it is asked would test nothing.
 *
 * The assertion that matters most is the **unreachable** one. A configured
 * scanner that stops answering must fail the ingestion, not quietly record the
 * file as unscanned: unscanned looks exactly like scanned-and-clean to anybody
 * reading the register afterwards.
 */

/** What the fake daemon should do with the next stream it is given. */
type Behaviour =
  | { kind: 'CLEAN' }
  | { kind: 'FOUND'; signature: string }
  | { kind: 'ERROR'; text: string }
  | { kind: 'SILENT' };

let behaviour: Behaviour = { kind: 'CLEAN' };
/** Every stream the daemon received, so the framing itself can be asserted. */
let received: Buffer[] = [];
let server: Server | undefined;
let port = 0;

/** clamd, as far as this client is concerned. Real framing, no signatures. */
function clamd(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((socket: Socket) => {
      const chunks: Buffer[] = [];
      // Accumulated across `data` events, not within one. A 200KB stream
      // arrives in however many reads the kernel feels like, and a payload
      // scoped to a single event loses everything but the last.
      const payload: Buffer[] = [];
      let command = '';

      socket.on('data', (data) => {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        const all = Buffer.concat(chunks);

        if (command === '') {
          const end = all.indexOf(0);
          if (end < 0) return;
          command = all.subarray(0, end).toString('utf8');
          chunks.length = 0;
          chunks.push(all.subarray(end + 1));

          if (command === 'zVERSION') {
            socket.end('ClamAV 1.0.3/27100/Fri Aug 28 2026\0');
            return;
          }
          if (command === 'zPING') {
            socket.end('PONG\0');
            return;
          }
          if (command !== 'zINSTREAM') {
            socket.end('UNKNOWN COMMAND ERROR\0');
            return;
          }
        }

        // INSTREAM: read length-prefixed chunks until a zero length arrives.
        let buffer = Buffer.concat(chunks);
        let at = 0;
        while (at + 4 <= buffer.length) {
          const length = buffer.readUInt32BE(at);
          if (length === 0) {
            received.push(Buffer.concat(payload));
            if (behaviour.kind === 'SILENT') return;
            if (behaviour.kind === 'FOUND') socket.end(`stream: ${behaviour.signature} FOUND\0`);
            else if (behaviour.kind === 'ERROR') socket.end(`${behaviour.text} ERROR\0`);
            else socket.end('stream: OK\0');
            return;
          }
          if (at + 4 + length > buffer.length) break;
          payload.push(buffer.subarray(at + 4, at + 4 + length));
          at += 4 + length;
        }
        buffer = buffer.subarray(at);
        chunks.length = 0;
        chunks.push(buffer);
      });
      socket.on('error', () => {
        /* the client hanging up mid-stream is a case under test */
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server!.address() as { port: number }).port;
      resolve();
    });
  });
}

function pointAt(host: string, at: number, timeoutMs = 1000): void {
  const writable = config.antivirus as { host: string; port: number; timeoutMs: number };
  writable.host = host;
  writable.port = at;
  writable.timeoutMs = timeoutMs;
}

const original = { ...config.antivirus };

before(async () => {
  await clamd();
});

after(() => {
  server?.close();
  Object.assign(config.antivirus as object, original);
});

afterEach(() => {
  behaviour = { kind: 'CLEAN' };
  received = [];
});

describe('with no scanner configured, nothing claims to have scanned', () => {
  it('reports the deployment rather than the file', async () => {
    pointAt('', 0);
    assert.equal(scannerConfigured(), false);
    assert.equal(scannerAddress(), undefined);

    const outcome = await scan(Buffer.from('a specification'));
    assert.equal(outcome.scanned, false);
    // The sentence is about the deployment. "Clean" would be a claim about the
    // file that nothing on this platform is entitled to make.
    assert.match(outcome.scanned === false ? outcome.reason : '', /No scanner is configured/);

    const reachable = await ping();
    assert.equal(reachable.reachable, false);
  });
});

describe('with a scanner, the bytes actually go to it', () => {
  it('sends the file whole, in the protocol clamd speaks', async () => {
    pointAt('127.0.0.1', port);
    // Larger than one 64KB chunk, so the framing is exercised rather than
    // asserted by inspection.
    const bytes = Buffer.alloc(200_000, 0x41);
    bytes.write('a drawing register export', 0);

    const outcome = await scan(bytes);
    assert.equal(outcome.scanned, true);
    assert.equal(outcome.scanned === true && outcome.clean, true);

    // Reassembled from the length prefixes, byte for byte.
    assert.equal(received.length, 1);
    assert.equal(received[0]!.length, bytes.length);
    assert.equal(received[0]!.equals(bytes), true);
  });

  it('records which daemon and which signature database answered', async () => {
    pointAt('127.0.0.1', port);
    const outcome = await scan(Buffer.from('a letter'));
    assert.equal(outcome.scanned, true);
    // "Clean" against a database from 2019 is a different statement from clean
    // against today's, so the record names the database.
    assert.match(outcome.scanned === true ? outcome.scanner : '', /ClamAV 1\.0\.3\/27100/);
  });

  it('names what was found rather than saying "infected"', async () => {
    pointAt('127.0.0.1', port);
    behaviour = { kind: 'FOUND', signature: 'Win.Test.EICAR_HDB-1' };

    const outcome = await scan(Buffer.from('something a scanner objects to'));
    assert.equal(outcome.scanned, true);
    assert.equal(outcome.scanned === true && outcome.clean, false);
    // A quarantine record that will not say what by is one nobody can act on.
    assert.equal(outcome.scanned === true && outcome.clean === false ? outcome.signature : '', 'Win.Test.EICAR_HDB-1');
  });
});

describe('a configured scanner that will not answer is a refusal', () => {
  it('surfaces as a 503 the operator can read, not a 500', async () => {
    // Found by running it against a live server. Thrown as a plain `Error` the
    // gateway had no mapping and answered "500 INTERNAL_ERROR — The request
    // could not be completed", which is exactly what the message was written to
    // prevent: the operator has to be told the scanner they configured is not
    // answering, and a 500 tells them the platform is broken.
    pointAt('127.0.0.1', 1, 300);
    try {
      await scan(Buffer.from('anything'));
      assert.fail('the scan should have been refused');
    } catch (error) {
      const refusal = error as ScannerUnreachableError & { status: number };
      assert.equal(refusal.code, 'SCANNER_UNREACHABLE');
      assert.equal(refusal.status, 503);
    }

    // The reason carries no address of its own, because every caller that
    // shows it already says where it looked. It read
    // "127.0.0.1:3310 — 127.0.0.1:3310 refused the connection" on the
    // ingestion position until this stopped repeating itself.
    const reachable = await ping();
    assert.equal(reachable.reachable, false);
    assert.equal(/^127\.0\.0\.1:1\b/.test(reachable.reason ?? ''), false, String(reachable.reason));
  });

  it('throws rather than returning an unscanned verdict', async () => {
    // The defect this prevents: recording the file as ingested with
    // `antivirusScanned: false` leaves it in the register looking checked, and
    // the operator who configured the scanner never learns it stopped.
    pointAt('127.0.0.1', 1, 300);
    await assert.rejects(
      () => scan(Buffer.from('a specification')),
      (error: ScannerUnreachableError) => {
        assert.equal(error.code, 'SCANNER_UNREACHABLE');
        assert.match(error.message, /Nothing has been recorded against this file/);
        return true;
      },
    );
  });

  it('gives up rather than hanging when the daemon goes quiet mid-stream', async () => {
    pointAt('127.0.0.1', port, 400);
    behaviour = { kind: 'SILENT' };
    await assert.rejects(() => scan(Buffer.from('a drawing')), /stopped responding/);
  });

  it('treats a protocol error as a refusal, not as a clean file', async () => {
    pointAt('127.0.0.1', port, 1000);
    behaviour = { kind: 'ERROR', text: 'INSTREAM size limit exceeded.' };
    await assert.rejects(
      () => scan(Buffer.from('a very large drawing set')),
      /answered "INSTREAM size limit exceeded\. ERROR" rather than a verdict/,
    );
  });

  it('says where it looked, without ever naming a credential', async () => {
    pointAt('127.0.0.1', port);
    assert.equal(scannerAddress(), `127.0.0.1:${port}`);
    const reachable = await ping();
    assert.equal(reachable.reachable, true);
    assert.match(reachable.version ?? '', /ClamAV/);
  });
});
