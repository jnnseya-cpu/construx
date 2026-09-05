import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { config } from '../config.ts';

/**
 * An SMTP client, spoken directly.
 *
 * Zero runtime dependencies is a settled decision for this codebase, so mail
 * delivery either speaks the protocol or does not happen. SMTP submission is a
 * small, stable, fifty-year-old conversation, and the alternative — pulling in
 * a mail library and its transitive tree for the sake of five verbs — costs
 * more than it saves.
 *
 * What this deliberately does not do: connection pooling, DKIM signing, bounce
 * parsing, or retry scheduling. DKIM in particular belongs at the relay, which
 * is where the private key should live rather than in this process. A bounce
 * that arrives after the relay's 250 lands in a mailbox this process does not
 * read; it is recorded through `recordBounce` in `newsletter.ts` when an
 * operator or a relay reports it.
 */

export type SmtpResult = {
  accepted: boolean;
  /** Final response from the server, kept verbatim for the delivery record. */
  response: string;
};

class SmtpError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
  }
}

/**
 * A line-oriented view of the socket that understands SMTP continuation.
 *
 * A multi-line reply repeats the code with a hyphen (`250-STARTTLS`) until the
 * last line, which uses a space. Reading a single chunk and assuming it is one
 * reply is the classic way to desynchronise the conversation.
 */
class SmtpConnection {
  #socket: Socket;
  #buffer = '';
  #pending: Array<{ resolve: (reply: string) => void; reject: (error: Error) => void }> = [];
  #failure?: Error;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#consume(chunk));
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#fail(new SmtpError('Connection closed by the server', 'SMTP_CLOSED')));
  }

  get socket(): Socket {
    return this.#socket;
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    while (this.#pending.length > 0) this.#pending.shift()?.reject(error);
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;

    for (;;) {
      const end = this.#completeReplyLength();
      if (end === 0) return;
      const reply = this.#buffer.slice(0, end).trimEnd();
      this.#buffer = this.#buffer.slice(end);
      this.#pending.shift()?.resolve(reply);
    }
  }

  /** Length of the buffered text if it holds a complete reply, else 0. */
  #completeReplyLength(): number {
    let offset = 0;
    for (;;) {
      const breakAt = this.#buffer.indexOf('\r\n', offset);
      if (breakAt === -1) return 0;
      const line = this.#buffer.slice(offset, breakAt);
      offset = breakAt + 2;
      // A space in the fourth position marks the final line of the reply.
      if (line.length < 4 || line[3] !== '-') return offset;
    }
  }

  read(): Promise<string> {
    if (this.#failure) return Promise.reject(this.#failure);
    return new Promise((resolve, reject) => this.#pending.push({ resolve, reject }));
  }

  write(line: string): void {
    this.#socket.write(`${line}\r\n`);
  }

  /** Send a command and return its reply, refusing anything but the expected codes. */
  async command(line: string, expect: number[], redact = false): Promise<string> {
    this.write(line);
    const reply = await this.read();
    const code = Number(reply.slice(0, 3));
    if (!expect.includes(code)) {
      throw new SmtpError(
        `SMTP ${redact ? '<credential>' : line.split(' ')[0]} rejected: ${reply}`,
        code >= 500 ? 'SMTP_PERMANENT' : 'SMTP_TRANSIENT',
      );
    }
    return reply;
  }

  /** Replace the socket after STARTTLS, keeping the same reply machinery. */
  upgrade(socket: Socket): void {
    this.#socket.removeAllListeners();
    this.#socket = socket;
    this.#buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#consume(chunk));
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#fail(new SmtpError('Connection closed by the server', 'SMTP_CLOSED')));
  }

  close(): void {
    this.#socket.removeAllListeners();
    this.#socket.destroy();
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SmtpError(`${label} timed out after ${ms}ms`, 'SMTP_TIMEOUT')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function openSocket(options: { host: string; port: number; secure: boolean; timeoutMs: number }): Promise<Socket> {
  return withTimeout(
    new Promise<Socket>((resolve, reject) => {
      const socket = options.secure
        ? tlsConnect({ host: options.host, port: options.port, servername: options.host }, () => resolve(socket))
        : netConnect({ host: options.host, port: options.port }, () => resolve(socket));
      socket.once('error', reject);
    }),
    options.timeoutMs,
    'Connection',
  );
}

export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string;
  pass: string;
  timeoutMs: number;
};

/**
 * Deliver one message.
 *
 * One connection per message. That is the wrong shape for a million-recipient
 * blast and exactly right for a weekly issue to a customer base, where the
 * failure of one recipient must not take the rest of the run with it.
 */
export async function sendMail(
  message: { from: string; to: string; raw: string },
  options: SmtpOptions = { ...config.smtp },
): Promise<SmtpResult> {
  const socket = await openSocket(options);
  const connection = new SmtpConnection(socket);
  const deadline = options.timeoutMs;

  try {
    const greeting = await withTimeout(connection.read(), deadline, 'Greeting');
    if (!greeting.startsWith('220')) throw new SmtpError(`Unexpected greeting: ${greeting}`, 'SMTP_PROTOCOL');

    const ehloHost = config.publicBaseUrl.replace(/^https?:\/\//, '').split(':')[0] || 'localhost';
    let capabilities = await withTimeout(connection.command(`EHLO ${ehloHost}`, [250]), deadline, 'EHLO');

    if (!options.secure && /\bSTARTTLS\b/i.test(capabilities)) {
      await withTimeout(connection.command('STARTTLS', [220]), deadline, 'STARTTLS');
      const secured = await withTimeout(
        new Promise<Socket>((resolve, reject) => {
          const upgraded = tlsConnect({ socket, servername: options.host }, () => resolve(upgraded));
          upgraded.once('error', reject);
        }),
        deadline,
        'TLS handshake',
      );
      connection.upgrade(secured);
      // The capability list before and after STARTTLS are different documents;
      // AUTH in particular is usually only advertised once the channel is safe.
      capabilities = await withTimeout(connection.command(`EHLO ${ehloHost}`, [250]), deadline, 'EHLO');
    } else if (!options.secure && options.requireTls) {
      throw new SmtpError(
        'Server does not offer STARTTLS and SMTP_REQUIRE_TLS is set — refusing to send credentials in cleartext',
        'SMTP_NO_TLS',
      );
    }

    if (options.user) {
      if (/\bAUTH\b.*\bPLAIN\b/i.test(capabilities)) {
        const payload = Buffer.from(`\0${options.user}\0${options.pass}`, 'utf8').toString('base64');
        await withTimeout(connection.command(`AUTH PLAIN ${payload}`, [235], true), deadline, 'AUTH');
      } else if (/\bAUTH\b.*\bLOGIN\b/i.test(capabilities)) {
        await withTimeout(connection.command('AUTH LOGIN', [334], true), deadline, 'AUTH');
        await withTimeout(
          connection.command(Buffer.from(options.user, 'utf8').toString('base64'), [334], true),
          deadline,
          'AUTH user',
        );
        await withTimeout(
          connection.command(Buffer.from(options.pass, 'utf8').toString('base64'), [235], true),
          deadline,
          'AUTH pass',
        );
      } else {
        throw new SmtpError('Server advertises no supported AUTH mechanism', 'SMTP_NO_AUTH');
      }
    }

    await withTimeout(connection.command(`MAIL FROM:<${message.from}>`, [250]), deadline, 'MAIL FROM');
    await withTimeout(connection.command(`RCPT TO:<${message.to}>`, [250, 251]), deadline, 'RCPT TO');
    await withTimeout(connection.command('DATA', [354]), deadline, 'DATA');

    // Dot-stuffing: a line consisting of a single dot ends the message, so any
    // line in the body that begins with one must be escaped or the message is
    // truncated exactly where an attacker — or a bullet list — chose.
    const body = message.raw.replaceAll('\r\n.', '\r\n..');
    connection.socket.write(body.endsWith('\r\n') ? `${body}.\r\n` : `${body}\r\n.\r\n`);

    const accepted = await withTimeout(connection.read(), deadline, 'Message acceptance');
    if (!accepted.startsWith('250')) throw new SmtpError(`Message rejected: ${accepted}`, 'SMTP_REJECTED');

    try {
      await withTimeout(connection.command('QUIT', [221]), 2_000, 'QUIT');
    } catch {
      // The message is already accepted. A server that hangs up rudely on QUIT
      // has not undelivered it, so this must not turn a success into a failure.
    }

    return { accepted: true, response: accepted };
  } finally {
    connection.close();
  }
}
