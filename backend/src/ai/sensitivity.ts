import { config } from '../config.ts';
import type { DataSensitivity } from '../identity/abac.ts';
import { ENTITY_ACCESS } from '../identity/entityAccess.ts';
import type { AIProvider } from '../goldenthread/types.ts';
import type { EntityRef } from '../goldenthread/types.ts';

/**
 * Which vendor a record may be sent to.
 *
 * `DataSensitivity` has been a first-class concept since the access model was
 * built, and it governed exactly one thing: **who may read a record.** It said
 * nothing about who the platform may *hand the record to* — so a `LEGAL_L4`
 * contract clause, which a safety manager inside the customer's own company is
 * barred from opening, could be posted verbatim to any configured AI vendor by
 * an engine that happened to include it in its inputs.
 *
 * That is a data-protection control, not a performance one, and it is the gap
 * that made the routing requirement worth doing first.
 *
 * Three properties hold it up.
 *
 * **The sensitivity is derived, not declared.** It is read from
 * `ENTITY_ACCESS` — the same classification the generic entity read already
 * enforces — and taken as the *highest* among everything being sent. An engine
 * cannot understate what it is about to transmit, because it does not get to
 * say.
 *
 * **An unknown entity type is treated as the most sensitive thing there is.**
 * `ENTITY_ACCESS` already refuses to serve an unmapped type, on the reasoning
 * that a new entity should have to declare where it belongs. The same reasoning
 * applies harder here: an unclassified record is one nobody has thought about,
 * and the safe reading of "nobody has thought about it" is not "send it".
 *
 * **Clearance is configured, never assumed.** Whether a vendor may hold
 * commercial-in-confidence or legally privileged material is a fact about the
 * contract signed with them — a data processing agreement, a retention promise,
 * a processing region. The platform cannot know it, so it must be told, and in
 * the absence of being told it assumes the least.
 */

/** Ascending. Everything here compares by index, never by string. */
const ORDER: DataSensitivity[] = ['PUBLIC', 'INTERNAL', 'SAFETY_L2', 'COMMERCIAL_L3', 'LEGAL_L4'];

const RANK = new Map(ORDER.map((level, index) => [level, index]));

/** The most sensitive of two levels. */
export function higher(a: DataSensitivity, b: DataSensitivity): DataSensitivity {
  return (RANK.get(a) ?? 0) >= (RANK.get(b) ?? 0) ? a : b;
}

export function atLeast(level: DataSensitivity, floor: DataSensitivity): boolean {
  return (RANK.get(level) ?? 0) >= (RANK.get(floor) ?? 0);
}

/** Whether `level` sits within `ceiling`. */
export function within(level: DataSensitivity, ceiling: DataSensitivity): boolean {
  return (RANK.get(level) ?? Number.MAX_SAFE_INTEGER) <= (RANK.get(ceiling) ?? -1);
}

/**
 * How sensitive one entity type is.
 *
 * A classified type with no explicit level is ordinary project information —
 * `INTERNAL`. An *unmapped* type is `LEGAL_L4`, which is the fail-closed
 * reading: it will only be sent to a vendor explicitly cleared for the most
 * sensitive material the platform holds, and otherwise the call is refused and
 * says why.
 */
export function sensitivityOfType(refType: string): DataSensitivity {
  const classification = ENTITY_ACCESS[refType];
  if (!classification) return 'LEGAL_L4';
  return classification.sensitivity ?? 'INTERNAL';
}

/**
 * How sensitive a set of inputs is, taken as its most sensitive member.
 *
 * A request carrying one privileged clause among twenty ordinary records is a
 * privileged request. Averaging, or taking the commonest, would let a single
 * sensitive record ride along inside a batch that looks routine.
 *
 * An empty input set is `INTERNAL` rather than `PUBLIC`: a request that names no
 * records still carries whatever the caller put in its prompt, and the platform
 * has no way to inspect that.
 */
export function sensitivityOf(refs: readonly EntityRef[]): DataSensitivity {
  return refs.reduce<DataSensitivity>((worst, ref) => higher(worst, sensitivityOfType(ref.refType)), 'INTERNAL');
}

/**
 * The highest sensitivity each vendor is cleared to receive.
 *
 * Configured as `OPENAI:INTERNAL,ANTHROPIC:LEGAL_L4,GEMINI:PUBLIC`. A provider
 * absent from the list gets `defaultClearance`, which is `INTERNAL` unless the
 * operator has said otherwise.
 *
 * `INTERNAL` as the default is a deliberate middle. Clearing everything by
 * default would leave the hole exactly where it was and call it fixed; clearing
 * nothing would refuse every AI call on every existing deployment the moment
 * this shipped. `INTERNAL` keeps ordinary project work running and stops the
 * three categories that actually matter — safety, commercial and legal — until
 * somebody states, per vendor, that the contract with them permits it.
 */
export function clearanceFor(provider: AIProvider | string): DataSensitivity {
  const configured = config.ai.providerClearance[provider];
  return configured ?? config.ai.defaultClearance;
}

/**
 * Whether this adapter may be handed material at this level.
 *
 * An adapter that does not transmit is always permitted. The deterministic
 * engine answers from a hash of its inputs and opens no socket, so there is no
 * disclosure to protect against however privileged the material is — refusing it
 * would be guarding data against a journey it never takes, and would take the
 * platform's only always-available engine away from exactly the work that most
 * needs to stay in-house.
 *
 * Clearance is a statement about a *vendor contract*. Where there is no vendor,
 * there is nothing for it to be a statement about.
 */
export function mayReceive(adapter: { name: AIProvider | string; transmits: boolean }, level: DataSensitivity): boolean {
  if (!adapter.transmits) return true;
  return within(level, clearanceFor(adapter.name));
}

/** The levels, in order, for anything that needs to publish or validate them. */
export const SENSITIVITY_ORDER: readonly DataSensitivity[] = ORDER;
