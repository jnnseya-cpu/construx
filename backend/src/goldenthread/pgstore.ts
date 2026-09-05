import { EMPTY_STATE_HASH } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { EVENT_TYPES } from './eventTypes.ts';
import type { GoldenThreadLedger } from './ledger.ts';
import type { GoldenThreadEvent } from './types.ts';

/**
 * The Golden Thread in Postgres: the ledger's durable store off the box.
 *
 * `deploy/postgres/schema.sql` has carried the design and `store/postgres.ts`
 * the client; this is the piece between them and the ledger. It does not make
 * the ledger asynchronous. `commit()` is synchronous and called from several
 * hundred places, and the in-memory record is what every read answers from;
 * rewriting that to await a round trip on every write would be a rewrite of the
 * domain layer to buy latency. Instead:
 *
 * - **The journal stays the write-ahead log.** A commit is durable on the
 *   volume before it is acknowledged, exactly as today.
 * - **Every committed event is shipped here, in commit order, one transaction
 *   each.** The database's own trigger refuses any event that does not follow
 *   the head of its project's chain, so the record here is the same chain and
 *   cannot silently fork. Shipping runs behind the commit; a database that is
 *   down does not stop the platform, it grows the queue, and the queue is
 *   reported.
 * - **A process comes up from here.** In `primary` mode boot replays the
 *   database, verifying every hash exactly as a journal replay does, then ships
 *   whatever its own journal holds beyond the database's position — the tail a
 *   crash left unshipped. A new host with an empty volume comes up with the
 *   whole record. In `mirror` mode boot still replays the journal and the
 *   database is brought up to date beside it, which is how a deployment
 *   proves the two agree before it trusts the second.
 *
 * **What this does and does not change.** Recovery no longer depends on the
 * backup interval of one file: the record is off the box within the ship lag,
 * which is reported. Failover is a boot on another host. What it does not
 * change is the writer: there is still one process extending the chain at a
 * time, because two processes would each hold a different in-memory record. The
 * writer lock is therefore still load-bearing, and the chain trigger is the
 * database catching the case where it failed — a refused event halts shipping
 * and says so, rather than being retried into a fork.
 *
 * **Ordering.** Events are stored with the platform's commit ordinal
 * (`sequence`) and replayed in that order. The ledger's read order is
 * `(timestamp, eventId)`, and an offline capture carries the device's own
 * timestamp, which can precede the event it chains from; replaying in read order
 * would break the chain on exactly those records.
 *
 * **The body is the record.** The event is stored as the JSON line the journal
 * writes, and replay parses that. The columns beside it are for querying. A
 * replay that reassembled the event from columns would be a second
 * serialisation that has to agree byte for byte with the first for ever, and
 * the chain hash is over those bytes.
 */

export type LedgerStoreMode = 'off' | 'mirror' | 'primary';

type Row = Record<string, unknown>;
type Result<R = Row> = { rows: R[]; rowCount: number };

/** One connection, inside a transaction the client has already scoped to a tenancy. */
export interface StoreConnection {
  query<R = Row>(sql: string, params?: unknown[]): Promise<Result<R>>;
}

/**
 * The slice of `store/postgres.ts`'s `Pool` this store uses. Narrow so the
 * store's ordering, retry and halt behaviour can be tested against a stand-in
 * that enforces the schema's rules without a server.
 */
export interface StoreClient {
  query<R = Row>(sql: string, params?: unknown[]): Promise<Result<R>>;
  asTenant<T>(tenantId: string, work: (connection: StoreConnection) => Promise<T>): Promise<T>;
}

export type StorePosition = {
  mode: LedgerStoreMode;
  /** The highest commit ordinal the database holds. */
  stored: number;
  /** Committed here and not yet in the database. Zero when the two agree. */
  pending: number;
  shippedThisProcess: number;
  lastShippedAt?: string;
  /** The last failure to ship, kept until a ship succeeds. Retried. */
  lastError?: string;
  /** Shipping stopped for a reason retrying cannot fix. Nothing is dropped. */
  halted?: string;
  /** Where this process's record came from at boot. */
  restoredFrom?: 'POSTGRES' | 'JOURNAL' | 'NOTHING';
};

const INSERT_EVENT = `
  INSERT INTO event (
    event_id, tenant_id, project_id, occurred_at, device_timestamp,
    actor_type, actor_id, actor_roles, source,
    event_type, entity_type, entity_id, action,
    before_hash, after_hash, diff, evidence_refs, ai, policy,
    correlation_id, causation_id, chain_hash, previous_chain_hash,
    sequence, body
  ) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, $8, $9,
    $10, $11, $12, $13,
    $14, $15, $16, $17, $18, $19,
    $20, $21, $22, $23,
    $24, $25
  )`;

/** The event as a row. `previousChainHash` of the empty hash is the schema's NULL: the first event of a project. */
function rowOf(event: GoldenThreadEvent, sequence: number): unknown[] {
  return [
    event.eventId,
    event.tenantId,
    event.projectId,
    event.timestamp,
    event.deviceTimestamp ?? null,
    event.actor.refType,
    event.actor.refId,
    event.roleAtAction ?? [],
    event.source,
    event.eventType,
    event.entity.refType,
    event.entity.refId,
    event.action,
    event.beforeHash,
    event.afterHash,
    // The jsonb columns, as JSON text. The client renders a JavaScript array as
    // a Postgres array literal — right for `actor_roles`, which is `text[]`,
    // and wrong for a patch, which is a JSON document that happens to be a
    // list. Found on the first live boot: every event was refused with
    // `invalid input syntax for type json` and retried for ever.
    JSON.stringify(event.diff),
    JSON.stringify(event.evidenceRefs ?? []),
    event.ai === undefined ? null : JSON.stringify(event.ai),
    event.policy === undefined ? null : JSON.stringify(event.policy),
    event.correlationId,
    event.causationId ?? null,
    event.chainHash,
    event.previousChainHash === undefined || event.previousChainHash === EMPTY_STATE_HASH ? null : event.previousChainHash,
    sequence,
    JSON.stringify(event),
  ];
}

/** SQLSTATE classes the database raises for a fact about the record rather than about the connection. */
function unretryable(error: unknown): string | undefined {
  const state = (error as { sqlState?: string }).sqlState;
  if (!state) return undefined;
  // 22xxx data (a value the column will not take), 23xxx integrity (the chain
  // trigger, the unique chain index, the evidence trigger), 42501 insufficient
  // privilege (the tenant trigger), 42xxx syntax or undefined table (the schema
  // is not applied). None of these changes on a retry; retrying would be
  // hammering the same refusal.
  if (state.startsWith('22') || state.startsWith('23') || state.startsWith('42')) return state;
  return undefined;
}

export class PostgresLedgerStore {
  readonly #client: StoreClient;
  readonly #mode: LedgerStoreMode;
  readonly #log: (line: string) => void;
  readonly #retryMs: number;
  readonly #maxRetryMs: number;
  readonly #queue: Array<{ sequence: number; event: GoldenThreadEvent }> = [];
  #stored = 0;
  #sequence = 0;
  #shipped = 0;
  #lastShippedAt: string | undefined;
  #lastError: string | undefined;
  #halted: string | undefined;
  #restoredFrom: StorePosition['restoredFrom'];
  #draining = false;
  #retryDelay: number;
  #timer: NodeJS.Timeout | undefined;
  #idle: Array<() => void> = [];
  #closed = false;

  constructor(
    client: StoreClient,
    mode: Exclude<LedgerStoreMode, 'off'>,
    options: { retryMs?: number; maxRetryMs?: number; log?: (line: string) => void } = {},
  ) {
    this.#client = client;
    this.#mode = mode;
    this.#retryMs = options.retryMs ?? 1_000;
    this.#maxRetryMs = options.maxRetryMs ?? 30_000;
    this.#retryDelay = this.#retryMs;
    this.#log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  get mode(): LedgerStoreMode {
    return this.#mode;
  }

  /**
   * Whether the schema is applied and where the record stands. Refuses, by
   * name, a database that has the client's tables but not the store's columns.
   */
  async probe(): Promise<{ stored: number; tenancies: number }> {
    let position: Result<{ sequence: unknown }>;
    let tenancies: Result<{ count: unknown }>;
    try {
      position = await this.#client.query<{ sequence: unknown }>('SELECT sequence FROM ledger_position WHERE id = 1');
      tenancies = await this.#client.query<{ count: unknown }>('SELECT count(*)::int AS count FROM tenancy');
      await this.#client.query('SELECT sequence, body FROM event WHERE false');
    } catch (error) {
      const state = (error as { sqlState?: string }).sqlState;
      if (state === '42P01' || state === '42703') {
        throw new DomainError(
          'LEDGER_STORE_SCHEMA_MISSING',
          `The database at hand does not carry the ledger store's schema (${(error as Error).message}). Apply ` +
            'deploy/postgres/schema.sql — it is idempotent, and adds the store’s columns and tables to a database that ' +
            'already holds the log.',
          503,
        );
      }
      throw error;
    }
    this.#stored = Number(position.rows[0]?.sequence ?? 0);
    return { stored: this.#stored, tenancies: Number(tenancies.rows[0]?.count ?? 0) };
  }

  /**
   * Tell the database which event types require evidence, from the catalogue.
   * The trigger enforcing it reads this table; without the list it enforces
   * nothing, and the list belongs to the platform.
   */
  async declareEvidenceTypes(): Promise<number> {
    const types = EVENT_TYPES.filter((definition) => definition.requiresEvidence).map((definition) => definition.code);
    let declared = 0;
    for (const code of types) {
      const result = await this.#client.query('INSERT INTO event_type_requiring_evidence (event_type) VALUES ($1) ON CONFLICT DO NOTHING', [code]);
      declared += result.rowCount;
    }
    return declared;
  }

  /**
   * Every event the database holds, in commit order, ready for `ledger.restore`.
   *
   * Read one tenancy at a time, because row-level security shows a connection
   * one tenancy; merged by sequence, and refused where the sequence has a gap —
   * a row written without a body (by hand, or by a build before this store)
   * cannot be replayed, and skipping it would leave a chain that verifies
   * against nothing.
   */
  async load(): Promise<GoldenThreadEvent[]> {
    const tenancies = await this.#client.query<{ tenant_id: string }>('SELECT tenant_id FROM tenancy ORDER BY first_sequence');
    const loaded: Array<{ sequence: number; event: GoldenThreadEvent }> = [];
    for (const { tenant_id } of tenancies.rows) {
      const rows = await this.#client.asTenant(tenant_id, (connection) =>
        connection.query<{ sequence: unknown; body: string | null }>('SELECT sequence, body FROM event WHERE sequence IS NOT NULL ORDER BY sequence'),
      );
      for (const row of rows.rows) {
        if (row.body === null) {
          throw new DomainError(
            'LEDGER_STORE_UNREPLAYABLE',
            `Event at sequence ${String(row.sequence)} in tenancy ${tenant_id} has no body and cannot be replayed. It was written ` +
              'by something other than this store.',
          );
        }
        loaded.push({ sequence: Number(row.sequence), event: JSON.parse(row.body) as GoldenThreadEvent });
      }
    }
    loaded.sort((a, b) => a.sequence - b.sequence);
    for (const [index, entry] of loaded.entries()) {
      if (entry.sequence !== index + 1) {
        throw new DomainError(
          'LEDGER_STORE_GAP',
          `The database holds event ${entry.sequence} where ${index + 1} was expected. A gap in the record cannot be replayed; ` +
            'restore refused rather than loaded around it.',
        );
      }
    }
    if (loaded.length !== this.#stored) {
      throw new DomainError(
        'LEDGER_STORE_POSITION_DISAGREES',
        `ledger_position says ${this.#stored} events are stored and ${loaded.length} were read. The record and its position ` +
          'were written in the same transaction, so this is a database somebody has edited.',
      );
    }
    this.#restoredFrom = loaded.length > 0 ? 'POSTGRES' : 'NOTHING';
    return loaded.map((entry) => entry.event);
  }

  /**
   * Follow a ledger. `history` is what the ledger holds now, in commit order —
   * the journal's contents — and everything beyond the database's position is
   * queued first, so a crash between a commit and its ship loses nothing.
   */
  attach(ledger: GoldenThreadLedger, history: readonly GoldenThreadEvent[], restoredFrom?: StorePosition['restoredFrom']): { queued: number } {
    if (restoredFrom) this.#restoredFrom = restoredFrom;
    if (history.length < this.#stored) {
      throw new DomainError(
        'LEDGER_STORE_AHEAD',
        `The database holds ${this.#stored} events and this process holds ${history.length}. A process cannot follow a record ` +
          'longer than its own — in primary mode it replays the database first; in mirror mode the journal is behind the ' +
          'database, which means another process has been shipping to it.',
      );
    }
    let queued = 0;
    for (let index = this.#stored; index < history.length; index += 1) {
      this.#queue.push({ sequence: index + 1, event: history[index]! });
      queued += 1;
    }
    this.#sequence = history.length;
    ledger.subscribe((event) => {
      this.#sequence += 1;
      this.#queue.push({ sequence: this.#sequence, event });
      this.#kick();
    });
    this.#kick();
    return { queued };
  }

  /** Wait until the queue is empty, or the time is up. Returns what is still pending. */
  async flush(timeoutMs: number): Promise<number> {
    if (this.#queue.length === 0 || this.#halted) return this.#queue.length;
    this.#kick();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.#idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    return this.#queue.length;
  }

  /** Stop shipping. Anything pending stays in the journal for the next boot. */
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
  }

  position(): StorePosition {
    return {
      mode: this.#mode,
      stored: this.#stored,
      pending: this.#queue.length,
      shippedThisProcess: this.#shipped,
      ...(this.#lastShippedAt ? { lastShippedAt: this.#lastShippedAt } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      ...(this.#halted ? { halted: this.#halted } : {}),
      ...(this.#restoredFrom ? { restoredFrom: this.#restoredFrom } : {}),
    };
  }

  /**
   * The database's chain heads against the ledger's, project by project. The
   * check a deployment in mirror mode runs before it switches to primary, and
   * the one an operator runs when the two counts disagree.
   */
  async compareHeads(ledger: GoldenThreadLedger): Promise<{ projects: number; agreeing: number; differing: string[]; missing: string[] }> {
    const tenancies = await this.#client.query<{ tenant_id: string }>('SELECT tenant_id FROM tenancy');
    const stored = new Map<string, string>();
    for (const { tenant_id } of tenancies.rows) {
      const heads = await this.#client.asTenant(tenant_id, (connection) =>
        connection.query<{ project_id: string; chain_hash: string }>('SELECT project_id, chain_hash FROM chain_head'),
      );
      for (const head of heads.rows) stored.set(head.project_id, head.chain_hash);
    }
    const projects = new Set(ledger.events().map((event) => event.projectId));
    const differing: string[] = [];
    const missing: string[] = [];
    for (const projectId of projects) {
      const here = ledger.chainHead(projectId);
      const there = stored.get(projectId);
      if (there === undefined) missing.push(projectId);
      else if (there !== here) differing.push(projectId);
    }
    return { projects: projects.size, agreeing: projects.size - differing.length - missing.length, differing, missing };
  }

  // ------------------------------------------------------------ shipping

  #kick(): void {
    if (this.#draining || this.#closed || this.#halted || this.#queue.length === 0) return;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#draining = true;
    void this.#drain();
  }

  async #drain(): Promise<void> {
    try {
      while (this.#queue.length > 0 && !this.#closed && !this.#halted) {
        const head = this.#queue[0]!;
        try {
          await this.#ship(head.sequence, head.event);
        } catch (error) {
          const state = unretryable(error);
          if (state) {
            // The database refused the event on a fact about the record: it
            // does not follow the head it holds, or it belongs to a tenancy
            // this connection is not acting for. Retrying cannot change that,
            // and shipping past it would put later events on a fork. Stop, keep
            // everything, say so.
            this.#halted =
              `event ${head.event.eventId} (sequence ${head.sequence}, ${head.event.eventType} on ${head.event.projectId}) was refused by the ` +
              `database with SQLSTATE ${state}: ${(error as Error).message}. Shipping has stopped with ${this.#queue.length} event(s) ` +
              'held in the journal. Another process has extended this chain, or the database has been edited. See docs/RUNBOOK.md, ' +
              '"The ledger store halted".';
            this.#log(`[ledger-store] ${this.#halted}`);
            return;
          }
          // Said once per distinct failure rather than once per retry, so a
          // database that is down for an hour is one line and not thousands —
          // and a database that is down at all is at least one line.
          if (!this.#lastError?.endsWith((error as Error).message)) {
            this.#log(`[ledger-store] shipping failed and will be retried: ${(error as Error).message} (${this.#queue.length} pending)`);
          }
          this.#lastError = `${new Date().toISOString()} ${(error as Error).message}`;
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            this.#kick();
          }, this.#retryDelay);
          this.#retryDelay = Math.min(this.#maxRetryMs, this.#retryDelay * 2);
          return;
        }
        this.#queue.shift();
        this.#stored = head.sequence;
        this.#shipped += 1;
        this.#lastShippedAt = new Date().toISOString();
        this.#lastError = undefined;
        this.#retryDelay = this.#retryMs;
      }
    } finally {
      this.#draining = false;
      if (this.#queue.length === 0 || this.#halted) {
        const waiting = this.#idle.splice(0, this.#idle.length);
        for (const resolve of waiting) resolve();
      }
    }
  }

  /**
   * One event, one transaction, as its tenancy. Idempotent: a crash between the
   * insert committing and the process noting it re-ships the same event, and
   * the database already holding it is the success case, not a chain break.
   */
  async #ship(sequence: number, event: GoldenThreadEvent): Promise<void> {
    await this.#client.asTenant(event.tenantId, async (connection) => {
      const present = await connection.query<{ event_id: string }>('SELECT event_id FROM event WHERE event_id = $1', [event.eventId]);
      if (present.rows.length === 0) {
        await connection.query('INSERT INTO tenancy (tenant_id, first_sequence) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING', [
          event.tenantId,
          sequence,
        ]);
        await connection.query(INSERT_EVENT, rowOf(event, sequence));
      }
      await connection.query(
        'INSERT INTO ledger_position (id, sequence) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET sequence = EXCLUDED.sequence, updated_at = now() WHERE ledger_position.sequence < EXCLUDED.sequence',
        [sequence],
      );
    });
  }
}
