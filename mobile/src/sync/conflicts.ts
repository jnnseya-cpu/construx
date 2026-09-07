import type { SyncState } from './state';

/**
 * Conflict classification — §14.5's matrix, as a decision table.
 *
 * The rule that shapes everything else: **no material field is ever resolved by
 * last-write-wins.** §14.5 says so for quantities, progress, safety and test
 * results, and the reason is not fastidiousness — a progress claim silently
 * overwritten by a later edit is a quantity nobody agreed, sitting in a
 * valuation.
 *
 * The build specification's own §A4 table does allow last-write-wins with role
 * priority for a plain same-field edit. Both are in this table, and which one
 * applies is decided by `materiality`, not by the field's type. That is the
 * distinction worth being careful about: two people editing a snag's
 * *description* is an ordinary edit; two people editing its *severity* changes
 * what happens on site.
 */

/** How much is riding on the field. It decides whether a machine may pick a winner. */
export const MATERIALITY = ['INCIDENTAL', 'OPERATIONAL', 'MATERIAL'] as const;
export type Materiality = (typeof MATERIALITY)[number];

export const RESOLUTION = [
  'BOTH_RETAINED',
  'AUTO_MERGE',
  'USER_CHOICE',
  'AMENDMENT_ONLY',
  'SERVER_AUTHORITATIVE',
  'ORPHAN_REVIEW',
  'QUARANTINE',
] as const;
export type Resolution = (typeof RESOLUTION)[number];

export type ConflictClass = {
  id: string;
  /** What happened, in the words a person reading the Sync Centre would use. */
  describes: string;
  materiality: Materiality;
  resolution: Resolution;
  /** The rule that must not be broken, quoted close to §14.5's wording. */
  guardrail: string;
  /** Where the losing side goes. Never nowhere. */
  losingSide: string;
  nextState: SyncState;
};

export const CONFLICT_CLASSES: ConflictClass[] = [
  {
    id: 'APPEND_ONLY',
    describes: 'Two diary segments, photos or comments added at once',
    materiality: 'INCIDENTAL',
    resolution: 'BOTH_RETAINED',
    guardrail:
      'These cannot conflict. Both are kept and ordered by device time then server order; only an exact ' +
      'duplicate client hash collapses, and only into itself.',
    losingSide: 'There is no losing side.',
    nextState: 'SYNCED',
  },
  {
    id: 'DISJOINT_FIELDS_DRAFT',
    describes: 'Two editors changed different fields of an unsubmitted draft',
    materiality: 'OPERATIONAL',
    resolution: 'AUTO_MERGE',
    guardrail:
      'Merged only where the schema marks the fields independent, and the merged result is previewed with ' +
      'its provenance before it is accepted. A merge nobody saw is a merge nobody agreed.',
    losingSide: 'Nothing is lost; both changes are in the merge.',
    nextState: 'QUEUED',
  },
  {
    id: 'SAME_FIELD_DRAFT',
    describes: 'Two editors changed the same field of an unsubmitted draft',
    materiality: 'OPERATIONAL',
    resolution: 'USER_CHOICE',
    guardrail: 'Mine, theirs, or a merge where the datatype allows one. Not decided by arrival order.',
    losingSide: 'Kept as a superseded version, visible in the record history.',
    nextState: 'CONFLICT',
  },
  {
    id: 'SUBMITTED_RECORD',
    describes: 'A record that was already submitted, approved, issued or witnessed',
    materiality: 'MATERIAL',
    resolution: 'AMENDMENT_ONLY',
    guardrail:
      'No merge into a locked version, ever. The change becomes an amendment or a superseding revision ' +
      'carrying its own reason and authority. MOB-005.',
    losingSide: 'The edit becomes an amendment; the original stands unaltered.',
    nextState: 'REJECTED',
  },
  {
    id: 'QUANTITY_OR_PROGRESS',
    describes: 'Two readings of the same quantity, progress or measurement',
    materiality: 'MATERIAL',
    resolution: 'USER_CHOICE',
    guardrail:
      'Never last-write-wins. Both claims are preserved and a verifier decides; claimed, verified and ' +
      'corrected stay separate fields, so agreeing one does not erase what was originally claimed.',
    losingSide: 'Both claims are retained on the record.',
    nextState: 'CONFLICT',
  },
  {
    id: 'SAFETY_OR_TEST_RESULT',
    describes: 'Two safety, quality or test results for the same check',
    materiality: 'MATERIAL',
    resolution: 'USER_CHOICE',
    guardrail:
      'Cannot be averaged and cannot be selected by timestamp. An authorised person reviews both. ' +
      'A machine picking between two test results is a machine deciding whether something is safe.',
    losingSide: 'Both results are retained; the review records which stands and why.',
    nextState: 'CONFLICT',
  },
  {
    id: 'ASSIGNMENT',
    describes: 'The owner changed on the server while the device held a different one',
    materiality: 'OPERATIONAL',
    resolution: 'SERVER_AUTHORITATIVE',
    guardrail: 'The server assignment stands. The device shows who it is now rather than silently swapping it.',
    losingSide: 'The local assignment is dropped, with a notice naming the new owner.',
    nextState: 'SYNCED',
  },
  {
    id: 'DELETED_PARENT',
    describes: 'The parent record was deleted or superseded while this was edited offline',
    materiality: 'MATERIAL',
    resolution: 'ORPHAN_REVIEW',
    guardrail:
      'The edit is not discarded. It becomes a new version flagged for review, and a deletion needs explicit ' +
      're-confirmation once somebody has seen what was attached to it.',
    losingSide: 'Evidence and draft are both preserved pending the review.',
    nextState: 'CONFLICT',
  },
  {
    id: 'ACCESS_REVOKED',
    describes: 'Project access was withdrawn while the device held unsent work',
    materiality: 'MATERIAL',
    resolution: 'QUARANTINE',
    guardrail:
      'No background upload. The local scope is quarantined and keys rotate; unsynced work is recovered ' +
      'only through an approved process, and never by the device pushing it anyway.',
    losingSide: 'Held, not deleted, until somebody with authority decides.',
    nextState: 'QUARANTINED',
  },
];

const BY_ID = new Map(CONFLICT_CLASSES.map((entry) => [entry.id, entry]));

export function conflictClass(id: string): ConflictClass | undefined {
  return BY_ID.get(id);
}

/**
 * Whether this class may be resolved without a person.
 *
 * One line, and it is the line the whole file exists to draw. Anything MATERIAL
 * needs a human; the machine's job is to preserve both sides and present them.
 */
export function resolvableWithoutAPerson(entry: ConflictClass): boolean {
  return entry.materiality !== 'MATERIAL' && entry.resolution !== 'USER_CHOICE';
}
