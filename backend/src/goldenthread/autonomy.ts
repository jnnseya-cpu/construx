/**
 * Agent autonomy classes and refusal reason codes — the enforcement boundary
 * from the Tier-1 Agent Delivery OS specification, mapped onto the event
 * catalogue this platform already runs on rather than bolted alongside it.
 *
 * The specification's §1 draws a line: an agent interprets evidence and proposes
 * or initiates typed actions; a deterministic policy-and-command layer validates
 * and executes them, and "an agent message, model confidence, agent vote,
 * administrator override or expired timer never substitutes for verified
 * evidence or a reserved decision." CONSTRUX has enforced exactly that from the
 * start — every write goes through the closed event catalogue, `aiAllowed`
 * decides whether an AI actor may produce an event at all, and no agent mandate
 * exceeds PROPOSE. This module names that boundary in the specification's own
 * terms and lets it be asserted, so the autonomy model is one thing the OS can
 * state and test rather than a convention spread across files.
 *
 * It introduces NO new runtime behaviour: it is a typed reading of the existing
 * catalogue. The value is the invariant it makes checkable — no reserved
 * decision is executable by an AI actor — and the shared vocabulary of reason
 * codes the specification's §5 defines for a refusal.
 */

import type { EventAction, EventTypeDefinition } from './eventTypes.ts';
import { EVENT_TYPES } from './eventTypes.ts';

/**
 * The five autonomy classes (spec §1).
 *
 *  - `A0` Observe — reads. Not represented in the event catalogue at all,
 *    because a read writes no event; it is gated by `authorise(ctx, area, 'R')`.
 *  - `A1` Internal reversible — a draft, a calculation, an internal record.
 *    Event-logged and reversible or superseded. An AI actor may produce one
 *    where the catalogue allows it.
 *  - `A2` Delegated execution — a bounded outward action under a versioned
 *    delegation (publish an approved report, send an RFQ). External connectors
 *    start disabled; the platform treats these as A3 until a delegation exists.
 *  - `A3` Reserved decision — bind a tender or contract, issue a formal notice,
 *    certify completion, accept a regulated declaration. The agent prepares and
 *    routes; a verified human authority decides. Never executable by an AI actor.
 *  - `A4` Prohibited execution — impersonate a dutyholder, fabricate evidence,
 *    self-authorise a reserved decision, control live plant. Denied at the
 *    gateway; by construction no such event exists in the catalogue.
 */
export type ActionClass = 'A0' | 'A1' | 'A2' | 'A3' | 'A4';

export const ACTION_CLASS_META: Record<ActionClass, { title: string; rule: string }> = {
  A0: { title: 'Observe', rule: 'Autonomous within project and data permissions. Reads, not catalogue events.' },
  A1: { title: 'Internal reversible', rule: 'Autonomous where the catalogue allows an AI actor; event-logged and reversible or superseded.' },
  A2: { title: 'Delegated execution', rule: 'Autonomous only under a versioned delegation; external connectors start disabled.' },
  A3: { title: 'Reserved decision', rule: 'Agent prepares and routes; a verified authority decides. Never produced by an AI actor.' },
  A4: { title: 'Prohibited execution', rule: 'Denied at the gateway; no such event exists in the catalogue.' },
};

/**
 * The autonomy class of a catalogue event, derived from the attributes the
 * catalogue already carries — never stored a second time, so it cannot drift
 * from the catalogue it describes.
 *
 *  - Accepting or refusing a thing (`APPROVE`, `REJECT`) is a decision that binds
 *    the tenant to it. A decision is always reserved (A3): a verified human
 *    authority takes it, never an AI actor.
 *  - Formally issuing a thing (`ISSUE`) puts it before a third party. Where the
 *    catalogue permits an AI actor to produce it, it is a delegated outbound
 *    action (A2) — an RFQ or a piece of correspondence sent under a versioned
 *    delegation. Where it does not, it is a reserved issue (A3) — a formal
 *    contract notice a human sends.
 *  - Everything else — creating, updating, importing, freezing an internal
 *    baseline, running a calculation — is an internal reversible record (A1).
 */
export function actionClassOf(definition: EventTypeDefinition): Exclude<ActionClass, 'A0' | 'A4'> {
  if (definition.action === 'APPROVE' || definition.action === 'REJECT') return 'A3';
  if (definition.action === 'ISSUE') return definition.aiAllowed ? 'A2' : 'A3';
  return 'A1';
}

/** The reserved-decision events in the catalogue — the acts a human authority must take. */
export function reservedDecisionEvents(catalog: readonly EventTypeDefinition[] = EVENT_TYPES): EventTypeDefinition[] {
  return catalog.filter((definition) => actionClassOf(definition) === 'A3');
}

/** The delegated outbound events — automatable only under a versioned delegation (spec A2). */
export function delegatedExecutionEvents(catalog: readonly EventTypeDefinition[] = EVENT_TYPES): EventTypeDefinition[] {
  return catalog.filter((definition) => actionClassOf(definition) === 'A2');
}

/**
 * The specification's §5 reason codes for a refused or held action. CONSTRUX
 * refuses through typed `DomainError` codes already; this is the specification's
 * canonical set, so a refusal on a reserved or externally-dispatched action can
 * speak the agreed vocabulary and name the object and the next evidence or
 * authority needed.
 */
export const REASON_CODES = [
  'SOURCE_MISSING',
  'SOURCE_CONFLICT',
  'REGIME_UNDETERMINED',
  'SCOPE_MISMATCH',
  'REVISION_STALE',
  'REQUIRED_INSPECTION_MISSING',
  'REGULATORY_HOLD',
  'SAFETY_HOLD',
  'AUTHORITY_MISSING',
  'DELEGATION_EXPIRED',
  'LIMIT_EXCEEDED',
  'CONFIG_CHANGED',
  'CLOCK_UNVERIFIED',
  'RECEIPT_UNCONFIRMED',
  'CONNECTOR_DISABLED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES);

export function isReasonCode(code: string): code is ReasonCode {
  return REASON_CODE_SET.has(code);
}

/**
 * The enforcement invariant, as a function so it can be asserted at test time
 * and, if ever wanted, at boot: no reserved decision (A3) may be producible by
 * an AI actor. This is the specification's A4 prohibition — "self-authorise a
 * reserved decision" — read against the live catalogue. It returns the offending
 * events, so an empty result is the proof.
 */
export function aiExecutableReservedDecisions(
  catalog: readonly EventTypeDefinition[] = EVENT_TYPES,
): EventTypeDefinition[] {
  return reservedDecisionEvents(catalog).filter((definition) => definition.aiAllowed);
}
