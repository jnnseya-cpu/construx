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
      };
    })
    .sort((a, b) => (a.capturedAt === b.capturedAt ? (a.id < b.id ? -1 : 1) : a.capturedAt < b.capturedAt ? 1 : -1));
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
