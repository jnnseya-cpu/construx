import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { DomainError } from '../core/errors.ts';
import {
  bindMessage,
  decode,
  describeMessage,
  executeMessage,
  md5Password,
  parseMessage,
  passwordMessage,
  readDataRow,
  readRowDescription,
  readServerMessage,
  Reader,
  Scram,
  simpleQuery,
  SSL_REQUEST,
  startupMessage,
  SYNC,
  TERMINATE,
  type FieldDescription,
  type ServerMessage,
} from './wire.ts';

/**
 * A Postgres client, over a socket, with no dependencies.
 *
 * `deploy/postgres/` has carried a schema that is verified against a real
 * Postgres 16 — append-only rules, forced RLS, a chain trigger that serialises
 * two concurrent writers into exactly one winner — and `docs/STATE.md` has
 * carried the same sentence beside it since: *what is absent is the client*.
 * The design was checkable and unreachable. This is the client.
 *
 * ## Why write one
 *
 * Zero runtime dependencies is a settled decision, so `pg` is not available and
 * the alternative to writing this is not using Postgres. The wire protocol is
 * version 3.0, unchanged since 2003, and fully documented — which makes this
 * bounded, testable work rather than research. `wire.ts` holds the framing as
 * pure functions; this holds the socket, the state machine and the pool.
 *
 * ## Parameters are never interpolated
 *
 * `query()` takes the statement and the values separately and sends them in
 * separate protocol messages, so a value can never be parsed as syntax. There is
 * no string-building path into SQL anywhere in this file. `execute()` exists for
 * statements with no parameters — `BEGIN`, `SET`, a migration file — and takes
 * no values at all, so it cannot be misused as an interpolating query.
 *
 * ## What this does not do
 *
 * Named prepared statements are parsed and immediately discarded rather than
 * cached across calls. Statement caching is a real optimisation and it is also
 * how a pooled connection ends up holding a plan built for a different search
 * path; there is no measured bottleneck here to justify the risk, and rule 7
 * says not to build for one.
 *
 * Binary result format is not requested. Text costs a conversion and makes every
 * value inspectable in a log, and `numeric` in particular is never turned into a
 * float — a rounding error in a payment certificate is not a trade worth making
 * for parsing speed.
 */

export type ConnectionOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** `require` refuses a server that will not start TLS. `disable` never asks. */
  tls: 'require' | 'prefer' | 'disable';
  /** Rejects a certificate that does not verify. Only meaningful with TLS. */
  verifyCertificate: boolean;
  applicationName: string;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  /**
   * The schema search path, pinned.
   *
   * Found against a live server: the ledger tables live in the `goldenthread`
   * schema and a connection's default path is `"$user", public`, so every
   * statement answered `relation "event" does not exist` — the client had
   * connected perfectly and could see nothing.
   *
   * Sent as a **startup parameter** rather than a later `SET`, for two reasons.
   * It holds for the first statement as well as the hundredth, so there is no
   * window in which a query runs against the wrong path. And it is fixed for the
   * life of the connection, which matters because a mutable search path is how a
   * function or operator in an attacker-created schema shadows the real one — a
   * `SET` that a later statement could change would reopen exactly that.
   */
  searchPath: string;
};

export type QueryResult<Row = Record<string, unknown>> = {
  rows: Row[];
  /** Rows affected, where the command reports one. */
  rowCount: number;
  /** The server's own completion tag, e.g. `INSERT 0 1`. */
  command: string;
  fields: FieldDescription[];
};

/**
 * A server-side failure, carrying the SQLSTATE.
 *
 * A `DomainError` so the gateway maps it rather than answering 500. The code is
 * the SQLSTATE, not an invented one, because that is what an operator will look
 * up — and because the schema's own triggers raise meaningful ones:
 * `insufficient_privilege` for a tenant mismatch, a unique violation for the
 * second of two concurrent writers.
 */
export class PostgresError extends DomainError {
  readonly sqlState: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly constraint?: string;

  constructor(message: ServerMessage, sql?: string) {
    // 23505 unique_violation and 40001 serialization_failure are conflicts a
    // caller can retry; 42501 insufficient_privilege is a refusal. Everything
    // else is the platform's own fault until shown otherwise.
    const status =
      message.code === '23505' || message.code === '40001'
        ? 409
        : message.code === '42501'
          ? 403
          : 500;
    super(`POSTGRES_${message.code}`, message.message, status);
    this.name = 'PostgresError';
    this.sqlState = message.code;
    this.detail = message.detail;
    this.hint = message.hint;
    this.constraint = message.constraint;
    // The statement is attached for diagnosis and never the parameters: the
    // parameters are a customer's project data and a log is not the place for it.
    if (sql) this.sqlText = sql.slice(0, 500);
  }

  sqlText?: string;
}

type Pending = {
  resolve: (result: QueryResult) => void;
  reject: (error: Error) => void;
  sql: string;
  rows: Array<Record<string, unknown>>;
  fields: FieldDescription[];
  command: string;
  rowCount: number;
  failure?: Error;
};

export class Connection {
  readonly #options: ConnectionOptions;
  #socket: Socket | undefined;
  #buffer: Buffer = Buffer.alloc(0);
  #pending: Pending | undefined;
  #ready = false;
  #closed = false;
  #scram: Scram | undefined;
  #onReady: (() => void) | undefined;
  #onFatal: ((error: Error) => void) | undefined;
  /** The parameters the server volunteers on connect, including its version. */
  readonly parameters = new Map<string, string>();
  /** `I` idle, `T` in a transaction, `E` in a failed transaction. */
  transactionStatus = 'I';

  constructor(options: ConnectionOptions) {
    this.#options = options;
  }

  get open(): boolean {
    return this.#ready && !this.#closed;
  }

  get serverVersion(): string {
    return this.parameters.get('server_version') ?? 'unknown';
  }

  async connect(): Promise<void> {
    const socket = await this.#openSocket();
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('the database closed the connection')));

    const ready = new Promise<void>((resolve, reject) => {
      this.#onReady = resolve;
      this.#onFatal = reject;
    });

    socket.write(
      startupMessage({
        user: this.#options.user,
        database: this.#options.database,
        application_name: this.#options.applicationName,
        // Sent at startup so it applies to every statement on this connection
        // including the first, rather than needing a SET that could be missed.
        statement_timeout: String(this.#options.statementTimeoutMs),
        // Pinned here rather than SET later. See `searchPath` above: this is
        // both a correctness fix and the thing that stops a hostile schema
        // shadowing a function the triggers rely on.
        search_path: this.#options.searchPath,
        // The platform stores every timestamp in UTC and the ledger's hashes
        // cover the text form. A connection inheriting a server-side zone would
        // read back a different string from the one that was hashed.
        TimeZone: 'UTC',
      }),
    );

    const timer = setTimeout(() => {
      this.#fail(new Error(`the database did not answer within ${this.#options.connectTimeoutMs}ms`));
    }, this.#options.connectTimeoutMs);
    try {
      await ready;
    } finally {
      clearTimeout(timer);
    }
  }

  /** TCP, then TLS if the server agrees to it. */
  async #openSocket(): Promise<Socket> {
    const plain = await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host: this.#options.host, port: this.#options.port });
      socket.setNoDelay(true);
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });

    if (this.#options.tls === 'disable') return plain;

    // One byte answers this: `S` to proceed, `N` to refuse. Sent before any
    // credential, which is the point — nothing secret has crossed the wire yet.
    const answer = await new Promise<string>((resolve, reject) => {
      plain.once('data', (chunk: Buffer) => resolve(String.fromCharCode(chunk[0]!)));
      plain.once('error', reject);
      plain.write(SSL_REQUEST);
    });

    if (answer !== 'S') {
      if (this.#options.tls === 'require') {
        plain.destroy();
        throw new DomainError(
          'POSTGRES_TLS_REFUSED',
          `${this.#options.host}:${this.#options.port} will not start TLS and this deployment requires it. ` +
            'Nothing has been sent to it.',
          503,
        );
      }
      return plain;
    }

    return new Promise<Socket>((resolve, reject) => {
      const secure = tlsConnect(
        {
          socket: plain,
          servername: this.#options.host,
          // Verification is a setting because a self-signed certificate on a
          // private network is a real deployment, and silently accepting one in
          // production is not. The default is on.
          rejectUnauthorized: this.#options.verifyCertificate,
        },
        () => resolve(secure as unknown as Socket),
      );
      secure.once('error', reject);
    });
  }

  /**
   * Run a parameterised statement.
   *
   * The values travel in their own protocol message. There is no code path here
   * that puts a value into the SQL text.
   */
  query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    if (this.#closed) return Promise.reject(new Error('this connection is closed'));
    if (this.#pending) {
      // One statement at a time per connection: the protocol is a single stream
      // with no request ids, so a second concurrent query would read the first
      // one's rows. Concurrency belongs to the pool.
      return Promise.reject(new Error('this connection is already running a statement'));
    }

    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error('this connection is not open'));

    return new Promise<QueryResult<Row>>((resolve, reject) => {
      this.#pending = {
        resolve: resolve as (result: QueryResult) => void,
        reject,
        sql,
        rows: [],
        fields: [],
        command: '',
        rowCount: 0,
      };

      socket.write(
        Buffer.concat([
          parseMessage('', sql),
          bindMessage('', '', params.map(asText)),
          describeMessage('P', ''),
          executeMessage(''),
          SYNC,
        ]),
      );
    });
  }

  /**
   * Run statements with no parameters, on the simple path.
   *
   * Takes no values, deliberately: there is nothing to interpolate and therefore
   * no way to misuse this as a query. For `BEGIN`, `SET`, and applying a
   * migration file — which is the one legitimate reason to send several
   * statements at once.
   */
  execute(sql: string): Promise<QueryResult> {
    if (this.#pending) return Promise.reject(new Error('this connection is already running a statement'));
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error('this connection is not open'));

    return new Promise<QueryResult>((resolve, reject) => {
      this.#pending = { resolve, reject, sql, rows: [], fields: [], command: '', rowCount: 0 };
      socket.write(simpleQuery(sql));
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#socket?.write(TERMINATE);
    } catch {
      // Already gone. Terminate is a courtesy, not a requirement.
    }
    this.#socket?.end();
  }

  // ------------------------------------------------------- the read loop

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buffer, chunk]);

    // Messages arrive in whatever sizes the kernel felt like. Consume only
    // complete ones and keep the remainder — a partial message read as a whole
    // one is the classic protocol bug, and it shows up as a hang.
    for (;;) {
      if (this.#buffer.length < 5) return;
      const length = this.#buffer.readInt32BE(1);
      if (this.#buffer.length < length + 1) return;

      const type = String.fromCharCode(this.#buffer[0]!);
      const body = this.#buffer.subarray(5, length + 1);
      this.#buffer = this.#buffer.subarray(length + 1);

      try {
        this.#handle(type, new Reader(body));
      } catch (error) {
        this.#fail(error as Error);
        return;
      }
    }
  }

  #handle(type: string, reader: Reader): void {
    switch (type) {
      case 'R':
        this.#authenticate(reader);
        return;

      case 'S': {
        // ParameterStatus. Arrives at startup and again whenever a setting
        // changes, so the map is kept current rather than read once.
        const name = reader.cstring();
        this.parameters.set(name, reader.cstring());
        return;
      }

      case 'K':
        // BackendKeyData — the cancellation key. Read and not kept: cancelling a
        // statement needs a second connection, and nothing here does.
        return;

      case 'Z': {
        this.transactionStatus = String.fromCharCode(reader.byte());
        if (!this.#ready) {
          this.#ready = true;
          this.#onReady?.();
          this.#onReady = undefined;
          this.#onFatal = undefined;
          return;
        }
        this.#settle();
        return;
      }

      case 'T':
        if (this.#pending) this.#pending.fields = readRowDescription(reader);
        return;

      case 'D': {
        const pending = this.#pending;
        if (!pending) return;
        const values = readDataRow(reader);
        const row: Record<string, unknown> = {};
        for (let at = 0; at < pending.fields.length; at += 1) {
          const field = pending.fields[at]!;
          row[field.name] = decode(values[at] ?? null, field.typeOid);
        }
        pending.rows.push(row);
        return;
      }

      case 'C': {
        // CommandComplete: `INSERT 0 1`, `SELECT 3`, `UPDATE 2`.
        const tag = reader.cstring();
        if (!this.#pending) return;
        this.#pending.command = tag;
        const parts = tag.split(' ');
        const last = Number(parts[parts.length - 1]);
        if (Number.isFinite(last)) this.#pending.rowCount = last;
        return;
      }

      case 'E': {
        const failure = new PostgresError(readServerMessage(reader), this.#pending?.sql);
        if (this.#pending) {
          // Recorded and not thrown yet. The server still owes a ReadyForQuery,
          // and rejecting before it arrives leaves the next statement reading
          // this one's trailing messages.
          this.#pending.failure = failure;
        } else if (!this.#ready) {
          this.#onFatal?.(failure);
          this.#onFatal = undefined;
        }
        return;
      }

      case 'N':
        // NoticeResponse. Not an error and not this layer's to print.
        readServerMessage(reader);
        return;

      case '1': // ParseComplete
      case '2': // BindComplete
      case '3': // CloseComplete
      case 'n': // NoData
      case 's': // PortalSuspended
        return;

      default:
        // An unknown message type is not fatal — the protocol reserves room for
        // ones this client does not need — but the length was already consumed,
        // so the stream stays aligned.
        return;
    }
  }

  #authenticate(reader: Reader): void {
    const method = reader.int32();
    const socket = this.#socket;
    if (!socket) return;

    switch (method) {
      case 0: // AuthenticationOk
        return;

      case 3: // cleartext
        socket.write(passwordMessage(this.#options.password));
        return;

      case 5: // MD5
        socket.write(md5Password(this.#options.user, this.#options.password, reader.bytes(4)));
        return;

      case 10: {
        // SASL. The server lists mechanisms; take SCRAM-SHA-256 and refuse the
        // rest rather than falling back to something weaker.
        const mechanisms: string[] = [];
        for (;;) {
          const name = reader.cstring();
          if (name === '') break;
          mechanisms.push(name);
        }
        if (!mechanisms.includes('SCRAM-SHA-256')) {
          throw new Error(`the server offered only ${mechanisms.join(', ')}, and this client speaks SCRAM-SHA-256`);
        }
        this.#scram = new Scram(this.#options.password);
        socket.write(this.#scram.initial());
        return;
      }

      case 11: {
        // SASLContinue
        const serverFirst = reader.bytes(reader.remaining).toString('utf8');
        if (!this.#scram) throw new Error('the server continued a SASL exchange that never started');
        socket.write(this.#scram.final(serverFirst));
        return;
      }

      case 12: {
        // SASLFinal. Verified rather than accepted — without this the exchange
        // proves the client to the server and not the server to the client.
        const serverFinal = reader.bytes(reader.remaining).toString('utf8');
        this.#scram?.verify(serverFinal);
        return;
      }

      default:
        throw new Error(`the server asked for authentication method ${method}, which this client does not implement`);
    }
  }

  #settle(): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = undefined;
    if (pending.failure) {
      pending.reject(pending.failure);
      return;
    }
    pending.resolve({
      rows: pending.rows,
      rowCount: pending.rowCount,
      command: pending.command,
      fields: pending.fields,
    });
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
    this.#onFatal?.(error);
    this.#onFatal = undefined;
  }
}

/**
 * Values as text, with the conversions that matter stated rather than implied.
 *
 * `undefined` and `null` both become SQL NULL. A `Date` becomes an ISO string in
 * UTC. An object becomes JSON, which is what every `jsonb` column here wants.
 * Everything else is `String(value)` — and a number never goes near a locale.
 */
function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    // A text[] literal. Every element is quoted and escaped, so a role
    // containing a comma or a quote survives the round trip.
    return `{${value.map((item) => `"${String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 't' : 'f';
  return String(value);
}

/**
 * A pool of connections, and the reason there is one.
 *
 * The protocol is a single stream per socket with no request identifiers, so
 * one connection runs one statement at a time. Concurrency is therefore a
 * property of how many sockets are held, which is what this is for.
 *
 * Deliberately simple: acquire waits for a free connection, release returns it,
 * and a connection that has failed is discarded rather than reused. There is no
 * idle reaper, no health-check interval and no exponential backoff, because
 * there is no measured behaviour here to tune against and inventing one would
 * be guessing in a file that holds a customer's record.
 */
export class Pool {
  readonly #options: ConnectionOptions;
  readonly #size: number;
  readonly #idle: Connection[] = [];
  readonly #waiting: Array<(connection: Connection) => void> = [];
  #open = 0;
  #closed = false;

  constructor(options: ConnectionOptions, size = 8) {
    this.#options = options;
    this.#size = Math.max(1, size);
  }

  get statistics(): { open: number; idle: number; waiting: number; size: number } {
    return { open: this.#open, idle: this.#idle.length, waiting: this.#waiting.length, size: this.#size };
  }

  async acquire(): Promise<Connection> {
    if (this.#closed) throw new Error('this pool is closed');

    for (;;) {
      const free = this.#idle.pop();
      if (!free) break;
      // A connection the server closed while it sat idle looks fine until it is
      // used. Discard rather than hand it out.
      if (free.open) return free;
      this.#open -= 1;
    }

    if (this.#open < this.#size) {
      this.#open += 1;
      try {
        const connection = new Connection(this.#options);
        await connection.connect();
        return connection;
      } catch (error) {
        this.#open -= 1;
        throw error;
      }
    }

    return new Promise<Connection>((resolve) => this.#waiting.push(resolve));
  }

  release(connection: Connection): void {
    if (!connection.open || this.#closed) {
      this.#open -= 1;
      void connection.close();
      // Somebody may be waiting on a connection that just died; let them open a
      // new one rather than wait for a release that will never come.
      const waiter = this.#waiting.shift();
      if (waiter) void this.acquire().then(waiter);
      return;
    }
    const waiter = this.#waiting.shift();
    if (waiter) {
      waiter(connection);
      return;
    }
    this.#idle.push(connection);
  }

  /** Run one statement on a pooled connection. The common case. */
  async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    const connection = await this.acquire();
    try {
      return await connection.query<Row>(sql, params);
    } finally {
      this.release(connection);
    }
  }

  /**
   * Run a unit of work inside one transaction, on one connection.
   *
   * Committed on return, rolled back on throw. The rollback is attempted even
   * when the connection is already unhealthy, and a failure to roll back is
   * swallowed *in favour of the original error* — the caller needs to know what
   * their work did wrong, not that the cleanup after it also failed.
   */
  async transaction<T>(work: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    try {
      await connection.execute('BEGIN');
      let result: T;
      try {
        result = await work(connection);
      } catch (error) {
        try {
          await connection.execute('ROLLBACK');
        } catch {
          /* the original failure is the one that matters */
        }
        throw error;
      }
      await connection.execute('COMMIT');
      return result;
    } finally {
      this.release(connection);
    }
  }

  /**
   * Run work as a tenancy, so row-level security applies to it.
   *
   * The schema's policies read `current_setting('construx.tenant_id')`, and a
   * connection that has not set it sees nothing — which is the correct failure,
   * and an easy one to cause by accident. This is the only supported way to
   * reach tenant data, and it sets the value with a *parameter* rather than by
   * building a `SET` string, so a tenant id can never be read as SQL.
   *
   * `set_config(..., true)` scopes it to the transaction, so the setting cannot
   * outlive the work and leak onto the next borrower of this connection.
   */
  async asTenant<T>(tenantId: string, work: (connection: Connection) => Promise<T>): Promise<T> {
    return this.transaction(async (connection) => {
      await connection.query('SELECT set_config($1, $2, true)', ['construx.tenant_id', tenantId]);
      return work(connection);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const all = this.#idle.splice(0, this.#idle.length);
    await Promise.all(all.map((connection) => connection.close()));
    this.#open = 0;
  }
}
