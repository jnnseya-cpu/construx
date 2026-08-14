import { EMPTY_STATE_HASH, hashState, sha256, canonicalize, stateRootHash } from '../core/canonical.ts';
import { applyPatch } from '../core/jsonpatch.ts';
import { validate } from '../core/validate.ts';
import { lookupEventType } from './eventTypes.ts';
import { getEntitySchema, type GoldenThreadLedger } from './ledger.ts';
import type { EntityRef, EventVerification, GoldenThreadEvent, VerificationStatus } from './types.ts';

/**
 * Canonical event replay — the court / regulator / insurer surface.
 *
 * Replay reconstructs project state at time T purely from the event log, and
 * independently verifies every event as it goes. A passing replay is the
 * platform's evidence that its records have not been altered; a failing one
 * names the first event that broke the chain.
 */

export type ReplayEntity = {
  refType: string;
  refId: string;
  state: Record<string, unknown>;
  stateHash: string;
  lastEventId: string;
};

export type ReplayReport = {
  tenantId: string;
  projectId: string;
  asAt: string;
  rootHash: string;
  chainHead: string;
  verificationStatus: 'VERIFIED' | 'FAILED';
  summary: Record<VerificationStatus, number>;
  eventsReplayed: number;
  failures: EventVerification[];
  entities: ReplayEntity[];
  evidenceIndex: Array<{ refType: string; refId: string; firstSeen: string; linkedEvents: string[] }>;
  redactionLog: Array<{ refType: string; refId: string; reason: string }>;
  baselinesInForce: Record<string, string | undefined>;
};

export type ReplayOptions = {
  /** Restrict the returned entity set (verification still covers every event). */
  scope?: string[];
  /**
   * Audience drives redaction. A regulator sees governance and safety, but
   * commercial detail is withheld unless explicitly granted.
   */
  audience?: 'INTERNAL' | 'REGULATOR' | 'INSURER' | 'COURT';
};

/** Entity types withheld from a regulator audience unless explicitly granted. */
const COMMERCIAL_SENSITIVE = new Set([
  'Estimate',
  'MasterPricing',
  'Adjudication',
  'BidSubmissionPack',
  'SupplierSubmission',
  'CVR',
  'Invoice',
]);

function emptySummary(): Record<VerificationStatus, number> {
  return {
    VERIFIED: 0,
    FAILED_HASH: 0,
    FAILED_SCHEMA: 0,
    FAILED_PATCH: 0,
    FAILED_CHAIN: 0,
    FAILED_CATALOG: 0,
    MISSING_EVIDENCE: 0,
  };
}

function verifyOne(
  event: GoldenThreadEvent,
  currentState: Record<string, unknown> | undefined,
  currentHash: string,
  previousChainHash: string,
): { status: VerificationStatus; detail?: string; nextState?: Record<string, unknown> } {
  const definition = lookupEventType(event.eventType);
  if (!definition) return { status: 'FAILED_CATALOG', detail: `Unknown event type "${event.eventType}"` };

  if (definition.requiresEvidence && (event.evidenceRefs ?? []).length === 0) {
    return { status: 'MISSING_EVIDENCE', detail: `"${event.eventType}" requires evidence` };
  }

  // Chain first: a broken chain means events were removed or reordered, which
  // would make every downstream hash comparison meaningless.
  if (event.chainHash) {
    const { chainHash: _c, previousChainHash: _p, ...body } = event;
    const expectedChain = sha256(`${previousChainHash}\n${canonicalize(body)}`);
    if (expectedChain !== event.chainHash) {
      return { status: 'FAILED_CHAIN', detail: 'Chain hash does not match recomputed value' };
    }
    if ((event.previousChainHash ?? EMPTY_STATE_HASH) !== previousChainHash) {
      return { status: 'FAILED_CHAIN', detail: 'Previous chain hash does not match ledger position' };
    }
  }

  if (event.beforeHash !== currentHash) {
    return {
      status: 'FAILED_HASH',
      detail: `beforeHash ${event.beforeHash} does not match state hash ${currentHash}`,
    };
  }

  let nextState: Record<string, unknown>;
  try {
    nextState = applyPatch<Record<string, unknown>>((currentState ?? {}) as Record<string, unknown>, event.diff);
  } catch (error) {
    return { status: 'FAILED_PATCH', detail: error instanceof Error ? error.message : 'patch failed' };
  }

  const schema = getEntitySchema(event.entity.refType);
  if (schema) {
    const failures = validate(nextState, schema);
    if (failures.length > 0) {
      return { status: 'FAILED_SCHEMA', detail: failures.map((f) => `${f.field} ${f.message}`).join('; ') };
    }
  }

  const recomputed = hashState(nextState);
  if (recomputed !== event.afterHash) {
    return { status: 'FAILED_HASH', detail: `Recomputed afterHash ${recomputed} != stored ${event.afterHash}` };
  }

  return { status: 'VERIFIED', nextState };
}

export function replayProject(
  ledger: GoldenThreadLedger,
  tenantId: string,
  projectId: string,
  asAt: string,
  options: ReplayOptions = {},
): ReplayReport {
  const events = ledger.events({ tenantId, projectId, until: asAt });
  const summary = emptySummary();
  const failures: EventVerification[] = [];

  const states = new Map<string, { state: Record<string, unknown>; hash: string; lastEventId: string }>();
  const evidence = new Map<string, { refType: string; refId: string; firstSeen: string; linkedEvents: string[] }>();

  let previousChainHash = EMPTY_STATE_HASH;

  for (const event of events) {
    const key = `${event.entity.refType}:${event.entity.refId}`;
    const current = states.get(key);
    const result = verifyOne(event, current?.state, current?.hash ?? EMPTY_STATE_HASH, previousChainHash);

    summary[result.status] += 1;
    if (result.status !== 'VERIFIED') {
      failures.push({
        eventId: event.eventId,
        eventType: event.eventType,
        entity: event.entity,
        status: result.status,
        detail: result.detail,
      });
      // Stop advancing this entity, but keep verifying the rest of the log so the
      // report shows the full blast radius rather than only the first break.
    } else if (result.nextState) {
      states.set(key, { state: result.nextState, hash: event.afterHash, lastEventId: event.eventId });
    }

    if (event.chainHash) previousChainHash = event.chainHash;

    for (const ref of event.evidenceRefs ?? []) {
      const evidenceKey = `${ref.refType}:${ref.refId}`;
      const found = evidence.get(evidenceKey);
      if (found) {
        found.linkedEvents.push(event.eventId);
      } else {
        evidence.set(evidenceKey, {
          refType: ref.refType,
          refId: ref.refId,
          firstSeen: event.timestamp,
          linkedEvents: [event.eventId],
        });
      }
    }
  }

  const redactionLog: ReplayReport['redactionLog'] = [];
  const entities: ReplayEntity[] = [];

  for (const [key, value] of [...states.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const [refType = '', refId = ''] = key.split(':');
    if (options.scope && !options.scope.includes(refType)) continue;
    if (options.audience === 'REGULATOR' && COMMERCIAL_SENSITIVE.has(refType)) {
      redactionLog.push({ refType, refId, reason: 'Commercial-sensitive: withheld from regulator audience' });
      continue;
    }
    entities.push({ refType, refId, state: value.state, stateHash: value.hash, lastEventId: value.lastEventId });
  }

  // The root covers the full verified state, not the redacted view — otherwise
  // two audiences would compute different attestations for the same project.
  const rootHash = stateRootHash(
    [...states.entries()].map(([key, value]) => {
      const [refType = '', refId = ''] = key.split(':');
      return { refType, refId, state: value.state };
    }),
  );

  const baselinesInForce: Record<string, string | undefined> = {};
  for (const [key, value] of states.entries()) {
    const [refType = '', refId = ''] = key.split(':');
    if (refType === 'ProgrammeBaseline' && value.state.status === 'APPROVED') baselinesInForce.programmeBaselineId = refId;
    if (refType === 'Budget' && value.state.status === 'APPROVED') baselinesInForce.budgetBaselineId = refId;
    if (refType === 'Contract' && value.state.status === 'EXECUTED') baselinesInForce.contractId = refId;
  }

  return {
    tenantId,
    projectId,
    asAt,
    rootHash,
    chainHead: previousChainHash,
    verificationStatus: failures.length === 0 ? 'VERIFIED' : 'FAILED',
    summary,
    eventsReplayed: events.length,
    failures,
    entities,
    evidenceIndex: [...evidence.values()].sort((a, b) => (a.refId < b.refId ? -1 : 1)),
    redactionLog,
    baselinesInForce,
  };
}

/** Narrative timeline for a range — the human-readable half of an evidence pack. */
export function replayTimeline(
  ledger: GoldenThreadLedger,
  tenantId: string,
  projectId: string,
  from: string,
  to: string,
  entityFilter?: EntityRef[],
): Array<{
  timestamp: string;
  eventId: string;
  eventType: string;
  entity: EntityRef;
  actor: string;
  narrative: string;
  evidenceRefs: EntityRef[];
  chainHash?: string;
}> {
  const wanted = entityFilter ? new Set(entityFilter.map((r) => `${r.refType}:${r.refId}`)) : undefined;

  return ledger
    .events({ tenantId, projectId, from, until: to })
    .filter((e) => !wanted || wanted.has(`${e.entity.refType}:${e.entity.refId}`))
    .map((e) => ({
      timestamp: e.timestamp,
      eventId: e.eventId,
      eventType: e.eventType,
      entity: e.entity,
      actor: `${e.actor.refType}:${e.actor.refId}`,
      narrative: narrate(e),
      evidenceRefs: e.evidenceRefs ?? [],
      chainHash: e.chainHash,
    }));
}

function narrate(event: GoldenThreadEvent): string {
  const who = event.actor.refType === 'AI' ? `AI engine (${event.ai?.provider ?? 'unknown provider'})` : event.actor.refId;
  const what = event.eventType.toLowerCase().replace(/_/g, ' ');
  const subject = `${event.entity.refType} ${event.entity.refId}`;
  const changed = event.diff.length === 1 ? '1 field changed' : `${event.diff.length} fields changed`;
  return `${who} — ${what} on ${subject} (${changed})`;
}
