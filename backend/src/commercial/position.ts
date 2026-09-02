import { PACKAGES } from '../billing/seats.ts';
import type { Platform } from '../platform.ts';
import { CONSENT_SCOPE, type BenchmarkConsent } from './benchmark.ts';
import { churnSignal, windowFrom, type ChurnSignal } from './churn.ts';
import { expansionPosition, type EntitlementUse, type ExpansionPosition } from './expansion.ts';

/**
 * One tenancy's commercial position: what they are against, whether they are
 * still using the platform, and where their benchmark consent stands.
 *
 * The three engines beside this file are pure — they take numbers and return
 * findings, which is what makes them testable without a platform. This is the
 * seam that reads the real state and hands it to them, and it is the only place
 * that knows where a seat count or an event timestamp actually lives.
 *
 * ## Why the customer sees this and not only the operator
 *
 * Every figure here is about the customer's own account. A platform that
 * computes "this customer is decaying, propose an upgrade" and shows it only to
 * its own sales team has built a file on somebody. The same reading shown to
 * the customer is a service: it tells them what they are paying for and not
 * using, and it tells them their own usage is falling — which is information
 * they have every right to and usually do not have.
 *
 * That is also why the churn signal's wording is written to be read *by* the
 * customer. There is no internal-only phrasing here to leak.
 */

/** How long a tenancy must have been running before slack means anything. */
const SETTLED_IN_DAYS = 90;

export type CommercialPosition = {
  tenantId: string;
  expansion: ExpansionPosition;
  engagement: ChurnSignal;
  benchmarkConsent: {
    granted: boolean;
    decidedAt?: string;
    decidedBy?: string;
    scope: string;
    /** What the customer gets either way, stated so consent is not extracted. */
    note: string;
  };
};

export function commercialPosition(platform: Platform, tenantId: string, now = new Date()): CommercialPosition {
  const subscription = platform.subscription(tenantId);
  const definition = PACKAGES[subscription.package];

  const seatsUsed = subscription.assignedIdentities.length;
  const uses: EntitlementUse[] = [
    { resource: 'Identities', used: seatsUsed, limit: definition.includedSeats, unit: 'seats' },
  ];

  // A package with no larger sibling changes what pressure means: it stops
  // being an upsell and becomes a fact to state. Derived from the price list
  // rather than hardcoded, so adding a tier does not leave this lying.
  const largerPackageExists = Object.values(PACKAGES).some(
    (candidate) => candidate.monthlyPriceMinor > definition.monthlyPriceMinor,
  );

  const startedAt = Date.parse(subscription.startedAt);
  const settledIn =
    Number.isFinite(startedAt) && now.getTime() - startedAt >= SETTLED_IN_DAYS * 24 * 60 * 60 * 1000;

  // Written events, which is work somebody did — not logins, which measure a
  // session opened and abandoned just as well as one used.
  const events = platform.ledger
    .events({ tenantId })
    .map((event) => ({ at: event.timestamp, actorId: event.actor.refId }));

  const consentRecord = platform.ledger
    .listByTenant(tenantId, 'BenchmarkConsent')
    .map((entity) => entity.state as unknown as BenchmarkConsent)
    .at(-1);

  return {
    tenantId,
    expansion: expansionPosition({
      tenantId,
      tier: subscription.tier,
      largerPackageExists,
      uses,
      settledIn,
    }),
    engagement: churnSignal({ tenantId, window: windowFrom(events, 28, now) }),
    benchmarkConsent: {
      // Absence is not consent, and the default is therefore false rather than
      // "not yet asked" resolving to yes anywhere downstream.
      granted: consentRecord?.granted === true,
      ...(consentRecord ? { decidedAt: consentRecord.decidedAt, decidedBy: consentRecord.decidedBy } : {}),
      scope: CONSENT_SCOPE,
      note:
        'Whether or not you contribute, you can still be shown where you stand against companies that do. Withholding ' +
        'a reading to extract a contribution would be a trick, not a product.',
    },
  };
}
