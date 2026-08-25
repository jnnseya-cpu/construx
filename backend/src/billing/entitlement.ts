import { PACKAGES, UNCHARGED_ROLES } from './seats.ts';
import type { Subscription } from './subscription.ts';

/**
 * What a tenancy may do right now.
 *
 * This exists because the answer was scattered and, for the part that mattered
 * most, absent. `Subscription.status` carries `ACTIVE | SUSPENDED | CANCELLED`
 * and exactly one function in the platform read it — `monthlySubscriptionCharge`,
 * which returns zero when it is not ACTIVE. Everything else gated on
 * `subscription.package`, which does not change when a subscription ends.
 *
 * So cancelling stopped the invoice and took nothing away. Export still worked,
 * the seats stayed, the storage stayed, and the ACU wallet — credited by a
 * top-up that referenced no subscription at all — kept the AI running. The
 * customer stopped paying for the platform and carried on using it, while the
 * platform kept carrying their storage and a thirty-year retention obligation.
 * That is not lost revenue; it is an unbounded permanent liability acquired at
 * the moment somebody stops paying.
 *
 * ---
 *
 * **The principle: ACU credit buys AI. It does not buy the platform.** They are
 * separate purchases and are separately gated. A wallet full of credit does not
 * entitle anybody to a platform they are not paying for, and a paid
 * subscription still buys no AI — that half was already true and is stated in
 * `subscription.ts`.
 *
 * **Ending a subscription makes the record read-only, never unreadable.** A
 * customer may always see and take their own data; refusing that is hostile,
 * and under the portability right it is unlawful. What stops is adding to it.
 *
 * **Two roles are never gated.** The platform operator is not a customer and
 * has no package to be limited by, and a regulator's access is one the asset
 * owner is obliged to provide — refusing it because the contractor has not paid
 * would be this platform enforcing a commercial term against a statutory right.
 * The export gate already carved these out; every other gate now follows it,
 * because a carve-out that applies to one entitlement and not the others is the
 * kind of inconsistency somebody eventually has to litigate.
 */

export type StandingStatus = Subscription['status'] | 'NONE';

export type TenancyStanding = {
  status: StandingStatus;
  /** Append to the Golden Thread: any state change at all. */
  mayWrite: boolean;
  /** Spend ACUs on an engine run, however full the wallet is. */
  mayRunAI: boolean;
  /** Buy more ACU credit. */
  mayTopUp: boolean;
  /** Take a document out of the platform. */
  mayExport: boolean;
  /** Why, in the words a customer should be shown. Absent when everything is permitted. */
  reason?: string;
};

/** Everything permitted, for the roles no commercial term applies to. */
const UNGATED: TenancyStanding = {
  status: 'ACTIVE',
  mayWrite: true,
  mayRunAI: true,
  mayTopUp: true,
  mayExport: true,
};

/**
 * Resolve what this tenancy may do, for these roles.
 *
 * Fail-closed on an absent subscription. A context with no subscription is
 * either a tenancy that was never provisioned or one whose record did not
 * restore, and both are states in which writing to an immutable ledger is the
 * wrong answer. The platform operator is exempt, which is what leaves a way to
 * repair it.
 */
export function standing(
  subscription: Subscription | undefined,
  roles: readonly string[] = [],
): TenancyStanding {
  if (roles.some((role) => (UNCHARGED_ROLES as readonly string[]).includes(role))) return UNGATED;

  if (!subscription) {
    return {
      status: 'NONE',
      mayWrite: false,
      mayRunAI: false,
      mayTopUp: false,
      mayExport: false,
      reason: 'No subscription is recorded for this tenancy',
    };
  }

  const definition = PACKAGES[subscription.package];

  if (subscription.status !== 'ACTIVE') {
    const ended = subscription.status === 'CANCELLED' ? 'cancelled' : 'suspended';
    return {
      status: subscription.status,
      mayWrite: false,
      mayRunAI: false,
      mayTopUp: false,
      // False, matching what the export gate already did before this module
      // existed — deliberately not loosened here.
      //
      // There is a real tension and it is a commercial decision rather than an
      // engineering one. Taking your own data with you is a portability right
      // and should not depend on having settled an invoice. But an export is
      // not a data dump: it is a branded, client-facing document, which is the
      // product's actual output. Leaving it open would let somebody cancel and
      // keep producing deliverables for ever — the precise leak the trial gate
      // exists to prevent, arriving through a different door.
      //
      // Resolving it properly means separating "take my records" from "generate
      // a report", which does not exist yet. Until it does, the stricter
      // behaviour stands, because loosening a live gate on an assumption is the
      // more expensive mistake.
      mayExport: false,
      reason:
        `This subscription is ${ended}, so the record is read-only. ` +
        'Existing data can still be read. Reactivate the subscription to make changes or export.',
    };
  }

  return {
    status: 'ACTIVE',
    mayWrite: true,
    mayRunAI: true,
    mayTopUp: true,
    mayExport: definition.export,
    ...(definition.export
      ? {}
      : {
          reason:
            `The ${definition.label} package does not include exporting or printing. ` +
            'Everything else is available — the platform governs, records and computes on a trial; ' +
            'what it will not do is let the output leave.',
        }),
  };
}
