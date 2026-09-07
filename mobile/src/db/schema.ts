import { appSchema, tableSchema } from '@nozbe/watermelondb';

/**
 * The local store — §13.2's local entity catalogue, and §A4's two-layer model.
 *
 * Two layers, exactly as §A4 specifies and for the reason it gives:
 *
 *   1. **An append-only operations log** (`outbox_commands`). Every material
 *      create or update is an op with a client-minted id, the entity it
 *      touches, the version it expected, and its payload. Ops are immutable
 *      once written; an edit appends another. The log is both the sync unit and
 *      the local audit trail.
 *   2. **Materialised read models** (everything else) for instant UI. These are
 *      derived and disposable: a corrupted read model is rebuilt from the log
 *      plus the server, and losing one loses nothing that was not sent.
 *
 * The split matters because it decides what a crash costs. A design that writes
 * only read models and posts them opportunistically loses whatever was in
 * flight; this one cannot, because the op is committed locally before anything
 * is attempted over the network.
 *
 * ## Every material row carries the same envelope
 *
 * §13's modelling rule: `tenant_id`, `project_id`, a stable client id, schema
 * version, entity version, state, owner, scope and a server reference. It is
 * repeated on every table rather than normalised into one, because a row that
 * has lost its tenancy is a row that cannot be safely purged on revocation —
 * and revocation is the case this has to be right for.
 *
 * ## Migrations are forward-only
 *
 * §14.1 requires it. There is no down-migration in this schema and there should
 * never be one: a device that has already written ops under version N cannot be
 * safely walked back to N-1, and the honest recovery from a bad migration is a
 * re-enrolment that keeps the outbox and rebuilds the read models.
 */

export const SCHEMA_VERSION = 1;

/**
 * Columns every material table carries.
 *
 * `server_id` is null until the platform has acknowledged the record. The
 * client id never changes after that — §13.5's invariant, and the reason is
 * practical: re-keying a linked object means rewriting every local reference to
 * it, on a device, possibly offline, which is exactly when it will go wrong.
 */
const envelope = [
  { name: 'tenant_id', type: 'string' as const, isIndexed: true },
  { name: 'project_id', type: 'string' as const, isIndexed: true },
  { name: 'server_id', type: 'string' as const, isOptional: true, isIndexed: true },
  { name: 'schema_version', type: 'number' as const },
  { name: 'entity_version', type: 'number' as const },
  { name: 'sync_state', type: 'string' as const, isIndexed: true },
  { name: 'owner_id', type: 'string' as const, isOptional: true },
  { name: 'package_id', type: 'string' as const, isOptional: true, isIndexed: true },
  { name: 'location_id', type: 'string' as const, isOptional: true },
  { name: 'system_id', type: 'string' as const, isOptional: true },
  { name: 'sensitivity', type: 'string' as const },
  // Both clocks, never one. §13.5 and MOB-013: the device's time is contractual
  // evidence and is never rewritten; the server's receipt time is recorded
  // beside it. Ordering uses neither — it uses the stream version.
  { name: 'device_time', type: 'number' as const },
  { name: 'server_time', type: 'number' as const, isOptional: true },
  { name: 'utc_offset_minutes', type: 'number' as const },
  { name: 'created_at', type: 'number' as const },
  { name: 'updated_at', type: 'number' as const },
];

export const schema = appSchema({
  version: SCHEMA_VERSION,
  tables: [
    /**
     * A project as the server sees it. Read-only locally — §13.2 says server
     * projection — so nothing in the app writes here except the sync engine.
     */
    tableSchema({
      name: 'local_projects',
      columns: [
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'tenant_id', type: 'string', isIndexed: true },
        { name: 'name', type: 'string' },
        { name: 'phase', type: 'string' },
        { name: 'time_zone', type: 'string' },
        { name: 'role_scopes', type: 'string' },
        { name: 'stream_cursor', type: 'number' },
        { name: 'pack_version', type: 'number', isOptional: true },
        { name: 'pack_expires_at', type: 'number', isOptional: true },
        { name: 'updated_at', type: 'number' },
      ],
    }),

    /**
     * The appointment a policy check is evaluated against, effective-dated.
     *
     * Held locally **only so the interface can grey a control**. §2.3 is
     * explicit and it is worth repeating wherever this table is read: no
     * client-side check is an authorisation control. The server re-evaluates
     * every command against the appointment effective at `occurredAt`.
     */
    tableSchema({
      name: 'local_appointments',
      columns: [
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'role', type: 'string' },
        { name: 'package_scope', type: 'string' },
        { name: 'location_scope', type: 'string' },
        { name: 'effective_from', type: 'number' },
        { name: 'effective_to', type: 'number', isOptional: true },
        { name: 'authority_flags', type: 'string' },
        { name: 'sensitivity', type: 'string' },
        { name: 'updated_at', type: 'number' },
      ],
    }),

    /**
     * The signed offline pack, mirroring what the server issued.
     *
     * `activated_at` is set only after every required hash verifies — §14.6's
     * atomic activation. A partially verified pack stays inactive and the
     * previous one keeps serving, which is why `supersedes` is kept: the app
     * must be able to fall back to it if this one never completes.
     */
    tableSchema({
      name: 'offline_manifests',
      columns: [
        { name: 'manifest_id', type: 'string', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'device_id', type: 'string' },
        { name: 'version', type: 'number' },
        { name: 'signature_kid', type: 'string' },
        { name: 'signature_value', type: 'string' },
        { name: 'stream_cursor', type: 'number' },
        { name: 'expires_at', type: 'number' },
        { name: 'body_json', type: 'string' },
        { name: 'entities_total', type: 'number' },
        { name: 'entities_verified', type: 'number' },
        { name: 'files_total', type: 'number' },
        { name: 'files_verified', type: 'number' },
        { name: 'activated_at', type: 'number', isOptional: true },
        { name: 'supersedes', type: 'string', isOptional: true },
        { name: 'revoked_at', type: 'number', isOptional: true },
        { name: 'updated_at', type: 'number' },
      ],
    }),

    /**
     * A draft the user is still editing. Never leaves the device.
     *
     * Separate from the outbox on purpose: a draft is mutable and a queued
     * command is not. Submitting a draft *creates* a command; it does not
     * promote the draft, so the draft's own history stays local and the command
     * is a clean, immutable statement of intent.
     */
    tableSchema({
      name: 'domain_drafts',
      columns: [
        ...envelope,
        { name: 'entity_type', type: 'string', isIndexed: true },
        { name: 'payload_json', type: 'string' },
        { name: 'base_version', type: 'number', isOptional: true },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'autosaved_at', type: 'number' },
      ],
    }),

    /**
     * The outbox. Append-only until a durable receipt or a terminal failure.
     *
     * `idempotency_key` is minted with the command and never regenerated on
     * retry — that is the whole mechanism: a retried batch after a dropped
     * connection changes nothing the second time. `expected_version` carries
     * §15.1's optimistic concurrency, so a stale edit conflicts rather than
     * silently overwriting.
     *
     * `depends_on` holds ids of commands that must land first — evidence before
     * the record that links it, a parent before its child. §14.4 step 3 sends
     * dependency-free commands first for exactly this reason.
     */
    tableSchema({
      name: 'outbox_commands',
      columns: [
        { name: 'command_id', type: 'string', isIndexed: true },
        { name: 'idempotency_key', type: 'string', isIndexed: true },
        { name: 'command_type', type: 'string', isIndexed: true },
        { name: 'schema_version', type: 'string' },
        { name: 'tenant_id', type: 'string', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'entity_type', type: 'string' },
        { name: 'entity_client_id', type: 'string', isIndexed: true },
        { name: 'entity_server_id', type: 'string', isOptional: true },
        { name: 'expected_version', type: 'number', isOptional: true },
        { name: 'payload_json', type: 'string' },
        { name: 'evidence_refs', type: 'string' },
        { name: 'depends_on', type: 'string' },
        { name: 'occurred_at', type: 'number' },
        { name: 'device_time', type: 'number' },
        { name: 'project_time_zone', type: 'string' },
        { name: 'pack_manifest_id', type: 'string', isOptional: true },
        { name: 'pack_version', type: 'number', isOptional: true },
        { name: 'stream_cursor', type: 'number', isOptional: true },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'attempts', type: 'number' },
        { name: 'last_error', type: 'string', isOptional: true },
        { name: 'last_attempt_at', type: 'number', isOptional: true },
        { name: 'receipt_event_id', type: 'string', isOptional: true },
        { name: 'receipt_stream_version', type: 'number', isOptional: true },
        { name: 'created_at', type: 'number' },
      ],
    }),

    /**
     * Deltas pulled from the server, applied in one transaction per §14.4.
     *
     * Kept as a table rather than applied straight into read models because the
     * cursor must advance **last**: if the process dies mid-apply, the inbox
     * still holds what was received and the cursor has not moved, so the batch
     * is re-pulled rather than half-lost.
     */
    tableSchema({
      name: 'inbox_deltas',
      columns: [
        { name: 'event_id', type: 'string', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'stream_version', type: 'number', isIndexed: true },
        { name: 'entity_type', type: 'string' },
        { name: 'entity_id', type: 'string' },
        { name: 'entity_version', type: 'number' },
        { name: 'operation', type: 'string' },
        { name: 'payload_json', type: 'string' },
        { name: 'after_hash', type: 'string', isOptional: true },
        { name: 'received_at', type: 'number' },
        { name: 'applied_at', type: 'number', isOptional: true },
      ],
    }),

    /**
     * Evidence held on the device.
     *
     * The original is immutable and hashed before anything else happens —
     * §A2 RULE F4 and §13.4. `purge_locked` is the flag that stops the LRU
     * cache eviction touching anything unsynced or still referenced; §14.6 and
     * §16.5's low-storage scenario both turn on it.
     */
    tableSchema({
      name: 'evidence_local',
      columns: [
        ...envelope,
        { name: 'evidence_id', type: 'string', isIndexed: true },
        { name: 'source_record_id', type: 'string', isOptional: true, isIndexed: true },
        { name: 'capture_purpose', type: 'string' },
        { name: 'original_path', type: 'string' },
        { name: 'sha256', type: 'string', isIndexed: true },
        { name: 'mime_type', type: 'string' },
        { name: 'bytes', type: 'number' },
        { name: 'width', type: 'number', isOptional: true },
        { name: 'height', type: 'number', isOptional: true },
        { name: 'duration_ms', type: 'number', isOptional: true },
        { name: 'location_source', type: 'string', isOptional: true },
        { name: 'latitude', type: 'number', isOptional: true },
        { name: 'longitude', type: 'number', isOptional: true },
        { name: 'accuracy_m', type: 'number', isOptional: true },
        { name: 'time_confidence', type: 'string' },
        { name: 'upload_state', type: 'string', isIndexed: true },
        { name: 'upload_receipt', type: 'string', isOptional: true },
        { name: 'purge_locked', type: 'boolean', isIndexed: true },
      ],
    }),

    /** A resumable upload part. Idempotent by (upload_id, part_number) — §15.2. */
    tableSchema({
      name: 'upload_parts',
      columns: [
        { name: 'upload_id', type: 'string', isIndexed: true },
        { name: 'evidence_id', type: 'string', isIndexed: true },
        { name: 'part_number', type: 'number' },
        { name: 'offset_bytes', type: 'number' },
        { name: 'size_bytes', type: 'number' },
        { name: 'checksum', type: 'string' },
        { name: 'receipt', type: 'string', isOptional: true },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'attempts', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),

    /**
     * A conflict, with all three sides kept.
     *
     * §14.5: no auto-resolution for material fields. Base, local and server are
     * all retained so a person can see what they are choosing between — a
     * conflict record showing only the winner is a record of a decision nobody
     * can review.
     */
    tableSchema({
      name: 'conflicts_local',
      columns: [
        { name: 'conflict_id', type: 'string', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'entity_type', type: 'string' },
        { name: 'entity_id', type: 'string', isIndexed: true },
        { name: 'field_path', type: 'string', isOptional: true },
        { name: 'base_json', type: 'string', isOptional: true },
        { name: 'local_json', type: 'string' },
        { name: 'server_json', type: 'string', isOptional: true },
        { name: 'base_version', type: 'number', isOptional: true },
        { name: 'server_version', type: 'number', isOptional: true },
        { name: 'permitted_resolutions', type: 'string' },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'raised_at', type: 'number' },
        { name: 'resolved_at', type: 'number', isOptional: true },
        { name: 'resolution', type: 'string', isOptional: true },
      ],
    }),

    /** The Action Queue's rows — a projection, rebuilt from records and deltas. */
    tableSchema({
      name: 'actions_local',
      columns: [
        { name: 'action_id', type: 'string', isIndexed: true },
        { name: 'project_id', type: 'string', isIndexed: true },
        { name: 'source_type', type: 'string' },
        { name: 'source_id', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'owner_id', type: 'string', isOptional: true, isIndexed: true },
        { name: 'priority', type: 'string', isIndexed: true },
        { name: 'due_at', type: 'number', isOptional: true, isIndexed: true },
        { name: 'blocked_reason', type: 'string', isOptional: true },
        { name: 'state', type: 'string', isIndexed: true },
        { name: 'freshness_at', type: 'number' },
      ],
    }),

    /**
     * Controlled vocabulary from the pack. **The client never invents a row
     * here** — §13.2. A unit, a cost code or a trade the platform does not know
     * is a value that will be rejected on sync, and offering it in a picker is
     * how a person spends a shift filling in a form that cannot be accepted.
     */
    tableSchema({
      name: 'reference_data',
      columns: [
        { name: 'ref_type', type: 'string', isIndexed: true },
        { name: 'code', type: 'string', isIndexed: true },
        { name: 'label', type: 'string' },
        { name: 'unit', type: 'string', isOptional: true },
        { name: 'effective_from', type: 'number', isOptional: true },
        { name: 'effective_to', type: 'number', isOptional: true },
        { name: 'version', type: 'number' },
        { name: 'applicability', type: 'string', isOptional: true },
        { name: 'project_id', type: 'string', isOptional: true, isIndexed: true },
      ],
    }),

    /** Append-only local audit, privacy-filtered before any diagnostic export. */
    tableSchema({
      name: 'audit_local',
      columns: [
        { name: 'audit_id', type: 'string', isIndexed: true },
        { name: 'user_id', type: 'string' },
        { name: 'installation_id', type: 'string' },
        { name: 'session_id', type: 'string' },
        { name: 'action', type: 'string', isIndexed: true },
        { name: 'object_type', type: 'string', isOptional: true },
        { name: 'object_id', type: 'string', isOptional: true },
        { name: 'object_version', type: 'number', isOptional: true },
        { name: 'result', type: 'string' },
        { name: 'correlation_id', type: 'string', isOptional: true },
        { name: 'device_time', type: 'number' },
        { name: 'server_time', type: 'number', isOptional: true },
      ],
    }),
  ],
});
