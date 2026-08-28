import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The Postgres frontend/backend protocol, version 3.0 — messages only.
 *
 * Split from the connection so the framing can be tested without a socket and
 * the socket can be tested without re-deriving the framing. Everything here is
 * pure: bytes in, bytes out.
 *
 * Zero runtime dependencies is a settled decision, so `pg` is not an option and
 * this is what "speak to Postgres" means. The protocol is stable and documented
 * — it has not changed since 2003 — which is why writing it is bounded work
 * rather than research.
 *
 * ## The one rule that matters
 *
 * **Only the extended query protocol carries values.** Simple query (`Q`) sends
 * a string the server parses as SQL, and there is no such thing as a safely
 * interpolated one; extended query sends the statement and the parameters in
 * separate messages, so a parameter can never be read as syntax. `Connection`
 * below exposes `query(text, params)` on the extended path and reserves the
 * simple path for statements with no parameters at all — `BEGIN`, `SET`, DDL
 * from a migration file — where there is nothing to interpolate.
 */

// --------------------------------------------------------------- reading

/** A cursor over a received buffer. Bounds-checked, because a short read here is a hang. */
export class Reader {
  #buffer: Buffer;
  #at: number;

  constructor(buffer: Buffer, at = 0) {
    this.#buffer = buffer;
    this.#at = at;
  }

  get offset(): number {
    return this.#at;
  }

  get remaining(): number {
    return this.#buffer.length - this.#at;
  }

  int32(): number {
    this.#need(4);
    const value = this.#buffer.readInt32BE(this.#at);
    this.#at += 4;
    return value;
  }

  int16(): number {
    this.#need(2);
    const value = this.#buffer.readInt16BE(this.#at);
    this.#at += 2;
    return value;
  }

  byte(): number {
    this.#need(1);
    return this.#buffer[this.#at++]!;
  }

  /** A null-terminated string, as every identifier in this protocol is. */
  cstring(): string {
    const end = this.#buffer.indexOf(0, this.#at);
    if (end < 0) throw new Error('protocol: unterminated string');
    const value = this.#buffer.toString('utf8', this.#at, end);
    this.#at = end + 1;
    return value;
  }

  bytes(length: number): Buffer {
    this.#need(length);
    const value = this.#buffer.subarray(this.#at, this.#at + length);
    this.#at += length;
    return value;
  }

  #need(length: number): void {
    if (this.#at + length > this.#buffer.length) {
      throw new Error(`protocol: wanted ${length} bytes and ${this.remaining} remain`);
    }
  }
}

// --------------------------------------------------------------- writing

/** Builds one frontend message. Length is filled in once the body is known. */
export class Writer {
  #chunks: Buffer[] = [];

  int32(value: number): this {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32BE(value, 0);
    this.#chunks.push(buffer);
    return this;
  }

  int16(value: number): this {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeInt16BE(value, 0);
    this.#chunks.push(buffer);
    return this;
  }

  byte(value: number): this {
    this.#chunks.push(Buffer.from([value]));
    return this;
  }

  cstring(value: string): this {
    this.#chunks.push(Buffer.from(value, 'utf8'), Buffer.from([0]));
    return this;
  }

  raw(value: Buffer): this {
    this.#chunks.push(value);
    return this;
  }

  /**
   * Frame the body under a message type.
   *
   * The length covers itself and the body but not the type byte — the one
   * off-by-one in this protocol that everybody writes wrong the first time.
   */
  frame(type: string): Buffer {
    const body = Buffer.concat(this.#chunks);
    const header = Buffer.allocUnsafe(5);
    header.write(type, 0, 'latin1');
    header.writeInt32BE(body.length + 4, 1);
    return Buffer.concat([header, body]);
  }

  /** Startup and SSLRequest carry a length and no type byte. */
  frameUntyped(): Buffer {
    const body = Buffer.concat(this.#chunks);
    const header = Buffer.allocUnsafe(4);
    header.writeInt32BE(body.length + 4, 0);
    return Buffer.concat([header, body]);
  }
}

/** The magic number that asks a server to start TLS before anything else. */
export const SSL_REQUEST = new Writer().int32(80877103).frameUntyped();

export function startupMessage(parameters: Record<string, string>): Buffer {
  // 196608 is protocol 3.0 as a packed major/minor.
  const writer = new Writer().int32(196608);
  for (const [key, value] of Object.entries(parameters)) {
    if (value === '') continue;
    writer.cstring(key).cstring(value);
  }
  return writer.cstring('').frameUntyped();
}

export function passwordMessage(password: string): Buffer {
  return new Writer().cstring(password).frame('p');
}

/**
 * MD5 password authentication.
 *
 * Long superseded and still what a default Debian cluster offers, so it is here
 * rather than absent. The digest is `md5(md5(password + user) + salt)` — the
 * concatenation order is the part that is easy to get backwards, and getting it
 * backwards produces an authentication failure that looks exactly like a wrong
 * password.
 */
export function md5Password(user: string, password: string, salt: Buffer): Buffer {
  const inner = createHash('md5').update(password + user, 'utf8').digest('hex');
  const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
  return passwordMessage(`md5${outer}`);
}

// ------------------------------------------------------- SCRAM-SHA-256

/**
 * SCRAM-SHA-256, which is what a modern Postgres actually asks for.
 *
 * Implemented rather than skipped because `scram-sha-256` is the default
 * `password_encryption` from Postgres 14 onward: a client that only speaks MD5
 * cannot connect to a default modern cluster at all.
 *
 * The exchange is three round trips:
 *   1. client-first  — `n,,n=,r=<nonce>`
 *   2. server-first  — `r=<combined nonce>,s=<salt>,i=<iterations>`
 *   3. client-final  — `c=biws,r=<combined>,p=<proof>`
 *   4. server-final  — `v=<signature>`, which the client **must** verify.
 *
 * Step 4 is the one implementations skip, and skipping it removes the mutual
 * half of mutual authentication: without it a machine-in-the-middle that cannot
 * read the password can still convince this client it is the database.
 */
export class Scram {
  readonly #password: string;
  readonly #clientNonce: string;
  #clientFirstBare = '';
  #serverSignature: Buffer | undefined;

  readonly #username: string;

  /**
   * `username` is empty for Postgres and settable for the RFC's test vector.
   *
   * SCRAM carries a username in `n=`; Postgres ignores it, because the username
   * already travelled in the startup packet, and every Postgres client sends it
   * empty. RFC 7677's published vector uses `n=user`, and the username is part
   * of the signed auth message — so a class that hard-coded the empty form
   * could not be checked against the one external authority on whether this
   * implementation is correct. It is a parameter for exactly that reason, and
   * it defaults to what Postgres wants.
   */
  constructor(password: string, nonce = randomBytes(18).toString('base64'), username = '') {
    this.#password = password;
    this.#clientNonce = nonce;
    this.#username = username;
  }

  /** `SASLInitialResponse`, naming the mechanism and carrying client-first. */
  initial(): Buffer {
    this.#clientFirstBare = `n=${this.#username},r=${this.#clientNonce}`;
    const message = Buffer.from(`n,,${this.#clientFirstBare}`, 'utf8');
    return new Writer()
      .cstring('SCRAM-SHA-256')
      .int32(message.length)
      .raw(message)
      .frame('p');
  }

  /** `SASLResponse` carrying client-final, computed from the server's challenge. */
  final(serverFirst: string): Buffer {
    const fields = new Map<string, string>();
    for (const part of serverFirst.split(',')) {
      const eq = part.indexOf('=');
      if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
    }

    const combinedNonce = fields.get('r') ?? '';
    const salt = Buffer.from(fields.get('s') ?? '', 'base64');
    const iterations = Number(fields.get('i') ?? 0);

    if (!combinedNonce.startsWith(this.#clientNonce)) {
      // The server must echo our nonce as a prefix. If it does not, this is not
      // a reply to the message we sent.
      throw new Error('scram: the server did not echo the client nonce');
    }
    if (iterations < 1 || salt.length === 0) {
      throw new Error('scram: the server sent no usable salt or iteration count');
    }

    const saltedPassword = pbkdf2Sync(this.#password, salt, iterations, 32, 'sha256');
    const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
    const storedKey = createHash('sha256').update(clientKey).digest();

    // `c=biws` is base64("n,,") — the GS2 header, unchanged, proving the
    // channel-binding choice was not tampered with in flight.
    const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`;
    const authMessage = `${this.#clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;

    const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = Buffer.alloc(clientKey.length);
    for (let at = 0; at < clientKey.length; at += 1) {
      proof[at] = clientKey[at]! ^ clientSignature[at]!;
    }

    const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
    this.#serverSignature = createHmac('sha256', serverKey).update(authMessage).digest();

    const message = Buffer.from(`${clientFinalWithoutProof},p=${proof.toString('base64')}`, 'utf8');
    return new Writer().raw(message).frame('p');
  }

  /**
   * Verify the server's own proof.
   *
   * Throws rather than returning false: a failure here means the thing at the
   * other end of the socket does not hold the password, and continuing to send
   * it a customer's evidence would be the whole problem.
   */
  verify(serverFinal: string): void {
    if (!this.#serverSignature) throw new Error('scram: verify before final');
    const sent = serverFinal
      .split(',')
      .find((part) => part.startsWith('v='))
      ?.slice(2);
    if (!sent) throw new Error('scram: the server sent no signature to verify');

    const theirs = Buffer.from(sent, 'base64');
    if (
      theirs.length !== this.#serverSignature.length ||
      !timingSafeEqual(theirs, this.#serverSignature)
    ) {
      throw new Error(
        'scram: the server could not prove it holds this password. ' +
          'Something is answering for the database that is not the database.',
      );
    }
  }
}

// ------------------------------------------------------ extended query

/** Parse: name the statement (empty for unnamed) and hand over the SQL. */
export function parseMessage(name: string, sql: string): Buffer {
  // Zero parameter types: the server infers them. Declaring them would mean
  // this client deciding what `$1` is, which it has no business knowing.
  return new Writer().cstring(name).cstring(sql).int16(0).frame('P');
}

/**
 * Bind: attach the values.
 *
 * Everything is sent in text format, and `null` is sent as length -1 rather than
 * an empty string. Those are different values in SQL and conflating them is how
 * a nullable column quietly fills with empty strings.
 */
export function bindMessage(portal: string, statement: string, values: Array<string | null>): Buffer {
  const writer = new Writer().cstring(portal).cstring(statement).int16(0).int16(values.length);
  for (const value of values) {
    if (value === null) {
      writer.int32(-1);
    } else {
      const bytes = Buffer.from(value, 'utf8');
      writer.int32(bytes.length).raw(bytes);
    }
  }
  // One result format code, 0, meaning "text for every column".
  return writer.int16(1).int16(0).frame('B');
}

export function describeMessage(kind: 'S' | 'P', name: string): Buffer {
  return new Writer().byte(kind.charCodeAt(0)).cstring(name).frame('D');
}

export function executeMessage(portal: string, maxRows = 0): Buffer {
  return new Writer().cstring(portal).int32(maxRows).frame('E');
}

export const SYNC = new Writer().frame('S');
export const TERMINATE = new Writer().frame('X');

export function simpleQuery(sql: string): Buffer {
  return new Writer().cstring(sql).frame('Q');
}

// ------------------------------------------------------------ decoding

export type FieldDescription = { name: string; typeOid: number };

/** A backend error or notice, with the fields worth surfacing. */
export type ServerMessage = {
  severity: string;
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  constraint?: string;
  column?: string;
  table?: string;
};

export function readServerMessage(reader: Reader): ServerMessage {
  const fields: Record<string, string> = {};
  for (;;) {
    const type = reader.byte();
    if (type === 0) break;
    fields[String.fromCharCode(type)] = reader.cstring();
  }
  return {
    severity: fields.S ?? fields.V ?? 'ERROR',
    code: fields.C ?? 'XX000',
    message: fields.M ?? 'the server sent an error with no message',
    detail: fields.D,
    hint: fields.H,
    constraint: fields.n,
    column: fields.c,
    table: fields.t,
  };
}

export function readRowDescription(reader: Reader): FieldDescription[] {
  const count = reader.int16();
  const fields: FieldDescription[] = [];
  for (let at = 0; at < count; at += 1) {
    const name = reader.cstring();
    reader.int32(); // table oid
    reader.int16(); // column attribute number
    const typeOid = reader.int32();
    reader.int16(); // type size
    reader.int32(); // type modifier
    reader.int16(); // format code
    fields.push({ name, typeOid });
  }
  return fields;
}

/** Raw column text, or null. Conversion to a JavaScript value happens above. */
export function readDataRow(reader: Reader): Array<string | null> {
  const count = reader.int16();
  const values: Array<string | null> = [];
  for (let at = 0; at < count; at += 1) {
    const length = reader.int32();
    values.push(length === -1 ? null : reader.bytes(length).toString('utf8'));
  }
  return values;
}

/**
 * Postgres type oids this client converts, and how.
 *
 * Deliberately short. Every other type arrives as the string Postgres sent,
 * which is lossless and obviously unconverted — far better than a clever
 * coercion that silently turns a numeric into a float and loses pennies.
 */
const BOOL = 16;
const INT8 = 20;
const INT2 = 21;
const INT4 = 23;
const JSON_ = 114;
const JSONB = 3802;
const TEXT_ARRAY = 1009;

export function decode(value: string | null, typeOid: number): unknown {
  if (value === null) return null;
  switch (typeOid) {
    case BOOL:
      return value === 't';
    case INT2:
    case INT4:
      return Number(value);
    case INT8: {
      // A bigint that fits stays a number, because every caller here treats
      // counts as numbers. One that does not fit is returned as the string
      // rather than silently losing precision.
      const asNumber = Number(value);
      return Number.isSafeInteger(asNumber) ? asNumber : value;
    }
    case JSON_:
    case JSONB:
      try {
        return JSON.parse(value);
      } catch {
        // A jsonb column that will not parse is a fact worth surfacing, not one
        // to swallow: return what the server actually sent.
        return value;
      }
    case TEXT_ARRAY:
      return parseTextArray(value);
    default:
      // timestamptz, uuid, numeric and everything else: the server's own text.
      // `numeric` in particular must never become a float.
      return value;
  }
}

/**
 * Postgres array literal → string[].
 *
 * `{a,b}` mostly, but an element containing a comma, a brace or a quote arrives
 * quoted and escaped — `{"PM,QS","say \\"no\\""}` — and a naive split on comma
 * corrupts exactly the roles list this schema stores.
 */
export function parseTextArray(literal: string): string[] {
  if (!literal.startsWith('{') || !literal.endsWith('}')) return [];
  const body = literal.slice(1, -1);
  if (body === '') return [];

  const items: string[] = [];
  let current = '';
  let quoted = false;
  let escaped = false;

  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ',' && !quoted) {
      items.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  items.push(current);
  return items;
}
