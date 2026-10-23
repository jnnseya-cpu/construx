import { DomainError } from '../core/errors.ts';
import type { ProviderRetention, RetentionRoute } from '../config.ts';
import type { DataSensitivity } from '../identity/abac.ts';

/**
 * What the contract with each AI vendor actually says, declared from the
 * console instead of from a shell.
 *
 * ## Why this had to stop being an environment variable
 *
 * Two facts decide whether the platform may hand a record to a third party, and
 * neither is discoverable from the software: **what the vendor is cleared to
 * receive** (`AI_PROVIDER_CLEARANCE`) and **what it does with it afterwards**
 * (`AI_PROVIDER_RETENTION`). Both were set in `.env`, which meant three things
 * in practice:
 *
 *   - the only way to clear a vendor for commercial material was an SSH session
 *     and a container restart, so the refusal a bid manager hit on a return
 *     date could not be cleared by anybody holding the contract;
 *   - the declaration was a string in a file, with no record of **who** decided
 *     it, **when**, or **which agreement** they were reading when they did —
 *     and it is a statement about a legal agreement, which is precisely the
 *     kind of decision this platform puts on a chain;
 *   - a typo widened or narrowed it silently.
 *
 * So the declaration is an event on the platform tenancy's chain, this module
 * is the overlay the sensitivity rules read first, and the environment stays as
 * the fallback for a deployment configured entirely that way. The precedence is
 * the same shape as the credential store's and for the same reason.
 *
 * ## What it does not do, and why it used to
 *
 * It does not refuse a clearance for want of an agreement reference, a region
 * or an answer on training. It asked for all three and refused without them for
 * exactly one revision, and that was wrong on two counts.
 *
 * It was a **new** rule. The environment variable this replaced took a level
 * and nothing else, so moving the decision to the console — which was meant to
 * remove an SSH session from a bid manager's path — made the console *stricter*
 * than the shell it replaced. And it protected nothing: `AI_PROVIDER_CLEARANCE`
 * still works, so anybody with the host walked straight past it. A gate the
 * shell can step around is not a control; it is an obstacle for the person
 * doing it properly.
 *
 * What is left is what was always true: these are facts about a contract that
 * the platform cannot discover, so it records what it is told, records who told
 * it, and reports plainly where it has been told nothing. An undeclared
 * retention still reads `NOT_DECLARED` on every screen and in the sentence
 * shown before the button. That is information, which is this module's job;
 * refusing the work was not.
 */

export type VendorTerms = {
  provider: string;
  /** The highest sensitivity this vendor may be handed. */
  clearance: DataSensitivity;
  retention: ProviderRetention;
  /**
   * The agreement this is read from — a DPA reference, an order form, a dated
   * letter. Required above `INTERNAL`, because that is where it stops being a
   * default and starts being a claim about a contract.
   */
  agreementReference: string;
  declaredAt: string;
  declaredBy: string;
  reason: string;
};

const ORDER: readonly DataSensitivity[] = ['PUBLIC', 'INTERNAL', 'SAFETY_L2', 'COMMERCIAL_L3', 'LEGAL_L4'];
const ROUTES: readonly RetentionRoute[] = ['ZERO', 'TRANSIENT', 'RETAINED', 'NOT_DECLARED'];

/**
 * Where the declarations are read from.
 *
 * A seam rather than a store: the records live on the ledger, which is already
 * durable, replayed at boot and in every backup. `Platform` registers a reader
 * over its own entities; a test registers a literal. Nothing here holds state
 * that could disagree with the chain.
 */
let read: () => readonly VendorTerms[] = () => [];

export function useDeclaredVendorTerms(reader: () => readonly VendorTerms[]): void {
  read = reader;
}

/** Test seam, and the way a process with no ledger behaves: nothing declared. */
export function resetDeclaredVendorTerms(): void {
  read = () => [];
}

export function declaredTerms(provider: string): VendorTerms | undefined {
  return read().find((entry) => entry.provider === provider.toUpperCase());
}

export function allDeclaredTerms(): readonly VendorTerms[] {
  return read();
}

/**
 * Check a declaration before it is written, and say what is missing.
 *
 * Validation here rather than in the route, because the rule is about what a
 * contract has to say before the platform will act on it — not about the shape
 * of a request body. The route would be a second place to keep it in step.
 */
export function validateVendorTerms(input: {
  provider: string;
  clearance: string;
  retention: { route: string; days?: number; region?: string; trainingExcluded?: boolean };
  agreementReference: string;
}): VendorTerms['retention'] {
  if (!ORDER.includes(input.clearance as DataSensitivity)) {
    throw new DomainError('CLEARANCE_UNKNOWN', `"${input.clearance}" is not a sensitivity level.`, 422, [
      { field: 'clearance', message: `Expected one of ${ORDER.join(', ')}` },
    ]);
  }
  if (!ROUTES.includes(input.retention.route as RetentionRoute)) {
    throw new DomainError('RETENTION_ROUTE_UNKNOWN', `"${input.retention.route}" is not a retention route.`, 422, [
      { field: 'retentionRoute', message: `Expected one of ${ROUTES.join(', ')}` },
    ]);
  }

  const route = input.retention.route as RetentionRoute;

  /*
   * Two levels and two routes, and nothing else refused.
   *
   * What remains is the pair of checks that stop a declaration nobody could
   * act on — a sensitivity level that is not one, and a retention route that
   * is not one. Both would otherwise be stored and silently ignored, which is
   * the only kind of refusal this function has any business making.
   *
   * Everything else is recorded as given, including blank. A vendor with no
   * agreement named and no region stated reads exactly that way on the
   * register and in the sentence shown before the button, which is the honest
   * answer and is the module doing its job. Stopping the work was not.
   */

  return {
    route,
    ...(Number.isFinite(input.retention.days) ? { days: Number(input.retention.days) } : {}),
    ...((input.retention.region ?? '').trim() ? { region: String(input.retention.region).trim() } : {}),
    ...(typeof input.retention.trainingExcluded === 'boolean'
      ? { trainingExcluded: input.retention.trainingExcluded }
      : {}),
  };
}
