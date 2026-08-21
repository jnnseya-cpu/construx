import { DomainError } from '../core/errors.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import type { EntityRecord, GoldenThreadLedger } from '../goldenthread/ledger.ts';
import type { EvidenceStore } from './store.ts';

/**
 * The bridge between the ledger's evidence records and the bytes on disk.
 *
 * `EVIDENCE_REGISTERED` records that a document *with a given hash* was the
 * evidence for something. The object store holds bytes. This is the only place
 * that joins the two, and the join is deliberately one-directional: a hash may
 * exist with no bytes behind it, and that is a legitimate state the platform
 * reports rather than hides. Bytes with no hash cannot exist at all, because an
 * upload is refused unless a ledger record already names its hash.
 *
 * That ordering is the load-bearing rule. Without it the upload endpoint is an
 * open blob store with an authentication check on it — anyone in the tenancy
 * could park arbitrary files on the platform's disk under any address they
 * liked. With it, every stored object is something a domain command already
 * committed to the record.
 */

/** An evidence record as the register publishes it, with whether bytes exist. */
export type EvidenceRegisterEntry = {
  id: string;
  projectId: string;
  type: string;
  hash: string;
  description: string;
  capturedAt: string;
  capturedBy: string;
  linkedEntities: EntityRef[];
  /** Whether the platform holds the file, or only the assertion about it. */
  held: boolean;
  /** What the held file is. Absent when the platform holds no file. */
  contentType?: string;
};

type EvidenceState = {
  id: string;
  type: string;
  hash: string;
  description: string;
  linkedEntities?: EntityRef[];
  capturedAt: string;
  capturedBy: string;
};

/**
 * The evidence record a hash belongs to, within one tenancy.
 *
 * Scoped by tenant rather than by project on purpose: the same file legitimately
 * evidences things in more than one project of the same tenancy — a supplier's
 * test certificate, a site induction record — and the store's address is the
 * hash, so a per-project lookup would refuse the second use of a file the
 * tenancy already owns. It never crosses the tenancy, which is the boundary
 * that matters.
 */
export function findByHash(
  ledger: GoldenThreadLedger,
  tenantId: string,
  hash: string,
): EntityRecord | undefined {
  return ledger
    .listByTenant(tenantId, 'EvidenceItem')
    .find((record) => (record.state as EvidenceState).hash === hash);
}

/**
 * Every evidence record in a project, and whether the file behind it exists.
 *
 * `held: false` is the honest answer and the reason this endpoint is worth
 * having: it names exactly which parts of the chain depend on somebody outside
 * the platform still having the original. A screen that showed only the count
 * of evidence records would imply a completeness the platform does not have.
 */
export function projectRegister(
  ledger: GoldenThreadLedger,
  store: EvidenceStore,
  tenantId: string,
  projectId: string,
): EvidenceRegisterEntry[] {
  return ledger
    .list(projectId, 'EvidenceItem')
    .map((record) => {
      const state = record.state as EvidenceState;
      return {
        id: state.id,
        projectId: record.projectId,
        type: state.type,
        hash: state.hash,
        description: state.description,
        capturedAt: state.capturedAt,
        capturedBy: state.capturedBy,
        linkedEntities: state.linkedEntities ?? [],
        held: store.has(tenantId, state.hash),
        // Only for what is held. A media type against a file nobody has would
        // be a guess presented as a fact about a document.
        contentType: store.contentTypeOf(tenantId, state.hash),
      };
    })
    .sort((a, b) => (a.capturedAt === b.capturedAt ? (a.id < b.id ? -1 : 1) : a.capturedAt < b.capturedAt ? 1 : -1));
}

/**
 * Retention, which on this platform is mostly a policy about *not* deleting.
 *
 * The ordinary retention question — "what is old enough to remove" — has the
 * wrong shape here. The ledger is append-only and an evidence record proves
 * something about a project that may be argued over twelve years after practical
 * completion, so age is not a reason to delete and never becomes one. There is
 * no expiry sweep because there is nothing that expires.
 *
 * What retention *can* honestly report is the disagreement between the volume
 * and the record, in both directions:
 *
 * - **Recorded, not held.** A hash in the ledger with no bytes behind it. The
 *   chain still stands and depends on somebody outside the platform still having
 *   the file. Already reported by `projectRegister`; counted here across the
 *   tenancy.
 * - **Held, not recorded.** Bytes at an address no evidence record names. The
 *   upload path cannot produce one — an upload is refused unless a record
 *   already names its hash — so an orphan means a restored volume, a copy
 *   between environments, or an interrupted write. These are the only objects
 *   that may be removed, and removing them is a housekeeping action rather than
 *   a retention one.
 *
 * `discardOrphan` refuses anything the ledger names, which is the whole policy
 * in one guard. It lives here rather than in the store because the store holds
 * bytes and knows nothing about what they prove.
 */
export type RetentionPosition = {
  configured: boolean;
  heldObjects: number;
  heldBytes: number;
  /** Recorded as evidence with no file behind it. The chain depends on someone else. */
  recordedNotHeld: number;
  /** Bytes at an address no record names. Removable; nothing else is. */
  orphans: Array<{ hash: string; bytes: number; storedAt: string; partial: boolean }>;
  orphanBytes: number;
  oldestStoredAt?: string;
  policy: string;
  summary: string;
};

const RETENTION_POLICY =
  'Nothing the ledger names is deletable. An evidence record can be argued over for as long as the ' +
  'contract can be sued on, so age is not a reason to remove a file and does not become one. Only bytes ' +
  'no record names may be discarded, and those cannot arise through the platform at all.';

export function retentionPosition(
  ledger: GoldenThreadLedger,
  store: EvidenceStore,
  tenantId: string,
): RetentionPosition {
  if (!store.configured) {
    return {
      configured: false,
      heldObjects: 0,
      heldBytes: 0,
      recordedNotHeld: ledger.listByTenant(tenantId, 'EvidenceItem').length,
      orphans: [],
      orphanBytes: 0,
      policy: RETENTION_POLICY,
      summary:
        'No object store is configured, so the platform holds no files at all. Every evidence record is a ' +
        'hash whose original is somewhere else, and retention is that other party’s problem rather than this ' +
        'platform’s.',
    };
  }

  const recorded = new Set(
    ledger.listByTenant(tenantId, 'EvidenceItem').map((record) => (record.state as EvidenceState).hash),
  );
  const objects = store.list(tenantId);
  const orphans = objects.filter((object) => object.partial || !recorded.has(object.hash));

  const held = objects.filter((object) => !object.partial && recorded.has(object.hash));
  const heldHashes = new Set(held.map((object) => object.hash));
  const recordedNotHeld = [...recorded].filter((hash) => !heldHashes.has(hash)).length;

  return {
    configured: true,
    heldObjects: held.length,
    heldBytes: held.reduce((sum, object) => sum + object.bytes, 0),
    recordedNotHeld,
    orphans,
    orphanBytes: orphans.reduce((sum, object) => sum + object.bytes, 0),
    oldestStoredAt: held[0]?.storedAt,
    policy: RETENTION_POLICY,
    summary:
      orphans.length === 0
        ? `${held.length} object${held.length === 1 ? '' : 's'} held, every one of them named by a record. ` +
          `${recordedNotHeld} evidence record${recordedNotHeld === 1 ? '' : 's'} the platform holds no file for.`
        : `${orphans.length} object${orphans.length === 1 ? '' : 's'} on the volume that no record names. ` +
          'The upload path cannot create one, so these came from a restore, a copy between environments, or an ' +
          'interrupted write — and they are the only bytes here that may be removed.',
  };
}

/**
 * Remove one object nothing names.
 *
 * The refusal is the point. A caller asking to delete a file the ledger names is
 * asking to break the chain the ledger exists to keep, and it is refused whoever
 * they are — there is no override, because an override is what somebody reaches
 * for on the day the evidence is inconvenient.
 */
export function discardOrphan(
  ledger: GoldenThreadLedger,
  store: EvidenceStore,
  tenantId: string,
  hash: string,
): { discarded: boolean } {
  if (findByHash(ledger, tenantId, hash)) {
    throw new DomainError(
      'EVIDENCE_RECORDED',
      'This file is named by an evidence record and cannot be removed. The ledger is append-only and the file is what the record proves.',
      409,
    );
  }
  return { discarded: store.discard(tenantId, hash) };
}

/** How complete the project's evidence is, as a number a screen can lead with. */
export function coverage(entries: EvidenceRegisterEntry[]): {
  total: number;
  held: number;
  missing: number;
} {
  const held = entries.filter((entry) => entry.held).length;
  return { total: entries.length, held, missing: entries.length - held };
}
