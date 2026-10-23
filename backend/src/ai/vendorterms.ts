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
 * ## What it is not
 *
 * It is not a way to assert a contract that does not exist. `declareVendorTerms`
 * refuses a clearance above `INTERNAL` without the agreement named, the
 * processing region stated and the training question answered — because the
 * three categories that gate on it are safety, commercial and legal material,
 * and a promise on a screen with no contract behind it is worse than the
 * refusal it replaces.
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

  const clearance = input.clearance as DataSensitivity;
  const route = input.retention.route as RetentionRoute;
  const above = ORDER.indexOf(clearance) > ORDER.indexOf('INTERNAL');

  /*
   * The three things a commercial clearance has to come with.
   *
   * Above `INTERNAL` the platform starts handing a vendor safety, commercial
   * and legally privileged material. Each of these is a question somebody has
   * to have answered out of the agreement in front of them, and a declaration
   * that skipped any one of them would put a reassurance on the screen that
   * nothing stands behind — which is worse than the refusal it replaced.
   */
  if (above) {
    const missing: Array<{ field: string; message: string }> = [];
    if (input.agreementReference.trim().length < 4) {
      missing.push({ field: 'agreementReference', message: 'Name the agreement this is read from' });
    }
    if (route === 'NOT_DECLARED') {
      missing.push({ field: 'retentionRoute', message: 'Say what the vendor does with it' });
    }
    if (!(input.retention.region ?? '').trim()) {
      missing.push({ field: 'region', message: 'Say where it is processed — "eu-west", "uk-south"' });
    }
    if (typeof input.retention.trainingExcluded !== 'boolean') {
      missing.push({ field: 'trainingExcluded', message: 'Say whether the contract excludes it from model training' });
    }
    if (missing.length > 0) {
      throw new DomainError(
        'AGREEMENT_REQUIRED',
        `Clearing ${input.provider} for ${clearance.replace(/_/g, ' ').toLowerCase()} material is a statement about a ` +
          'contract, so the platform asks what the contract says: which agreement, where it is processed, and ' +
          'whether it is excluded from training. Nothing above internal is cleared on an unanswered question.',
        422,
        missing,
      );
    }
  }

  if ((route === 'TRANSIENT' || route === 'RETAINED') && !Number.isFinite(input.retention.days)) {
    throw new DomainError(
      'RETENTION_DAYS_REQUIRED',
      `A ${route.toLowerCase()} route keeps it for a period, so the period has to be stated. "They keep it for a ` +
        'while" is not a retention term anybody can rely on.',
      422,
      [{ field: 'days', message: 'How many days the vendor keeps it' }],
    );
  }

  return {
    route,
    ...(Number.isFinite(input.retention.days) ? { days: Number(input.retention.days) } : {}),
    ...((input.retention.region ?? '').trim() ? { region: String(input.retention.region).trim() } : {}),
    ...(typeof input.retention.trainingExcluded === 'boolean'
      ? { trainingExcluded: input.retention.trainingExcluded }
      : {}),
  };
}
