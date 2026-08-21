import { createHash } from 'node:crypto';

/**
 * Canonical serialisation and hashing — the legal backbone of the Golden Thread.
 *
 * Rules (non-negotiable, per the Golden Thread hashing strategy):
 *   1. Strip non-state fields (audit metadata, derived values, UI-only keys).
 *   2. Sort object keys lexicographically by UTF-8 code unit.
 *   3. Serialise as UTF-8 JSON with no whitespace.
 *   4. Arrays preserve order — order IS state.
 *   5. SHA-256, rendered as `sha256:<lowercase hex>`.
 */

/** Audit sub-keys that describe *when/who recorded*, not *what is true*. */
const AUDIT_KEYS = new Set(['createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'version']);

/**
 * Fields excluded from hashing because they are derived or transient.
 * A leading `_` marks a transient/UI-only key by convention; `derived` holds
 * cached calculations that must be recomputable from hashed state.
 */
function isNonStateKey(key: string): boolean {
  return key.startsWith('_') || key === 'derived';
}

export function stripNonState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNonState);
  if (value === null || typeof value !== 'object') return value;

  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (isNonStateKey(key)) continue;
    if (key === 'audit') {
      const audit = source[key];
      if (audit !== null && typeof audit === 'object' && !Array.isArray(audit)) {
        const kept: Record<string, unknown> = {};
        for (const auditKey of Object.keys(audit as Record<string, unknown>)) {
          if (AUDIT_KEYS.has(auditKey)) continue;
          kept[auditKey] = stripNonState((audit as Record<string, unknown>)[auditKey]);
        }
        // An audit block containing only timestamps contributes nothing to state.
        if (Object.keys(kept).length > 0) out[key] = kept;
      }
      continue;
    }
    if (source[key] === undefined) continue;
    out[key] = stripNonState(source[key]);
  }
  return out;
}

/** Deterministic JSON: sorted keys, no whitespace. Arrays keep their order. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const source = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalize(source[key])}`);
  }
  return `{${parts.join(',')}}`;
}

export function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

/** Hash of an entity's canonical state, after non-state fields are stripped. */
export function hashState(entity: unknown): string {
  return sha256(canonicalize(stripNonState(entity)));
}

/**
 * The hash of "no state yet". Every CREATE event carries this as its beforeHash,
 * which is what lets replay distinguish a genuine creation from a lost predecessor.
 */
export const EMPTY_STATE_HASH = sha256('null');

/** Hash of an evidence payload (file bytes or a serialisable record). */
export function hashEvidence(content: Buffer | string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Project state root: one attestation value for an entire project at a point in
 * time. Entities are sorted by (refType, refId) so the root is reproducible by
 * any party holding the same event log.
 */
export function stateRootHash(entities: Array<{ refType: string; refId: string; state: unknown }>): string {
  const ordered = entities
    .slice()
    .sort((a, b) => (a.refType === b.refType ? (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0) : a.refType < b.refType ? -1 : 1));
  const concatenated = ordered.map((e) => `${e.refType}:${e.refId}:${hashState(e.state)}`).join('\n');
  return sha256(concatenated);
}
