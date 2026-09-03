import { estateBurn } from '../billing/burn.ts';
import * as storage from '../billing/storage.ts';
import { TIERS } from '../billing/subscription.ts';
import type { Platform } from '../platform.ts';

/**
 * What is about to happen, from what has already happened.
 *
 * **This module forecasts nothing it cannot show its working for.** There is no
 * churn probability, no health score and no model. Every entry below is an
 * arithmetic projection of a rate the platform has measured, or a date already
 * written down, and each one publishes the basis it was computed from so that
 * somebody reading it can disagree with the arithmetic rather than with a
 * number that arrived from nowhere.
 *
 * That is a deliberate refusal. A "churn risk: 72%" on an estate of a dozen
 * tenancies is a number invented to look like intelligence, and the first time
 * somebody acts on one and is wrong, every other figure on the console loses its
 * credibility too. What an operator can act on is: *this tenancy stops being
 * able to use AI in nine days*, *this one renews in six and nobody has spoken to
 * them*, *this one has not written a record in five weeks*. Those are facts with
 * dates on them.
 *
 * **Each signal is a thing that will happen unless somebody acts**, ranked by
 * when. That is what makes it a queue rather than a dashboard.
 */

export type SignalSeverity = 'CRITICAL' | 'WARNING' | 'WATCH';

export type Signal = {
  id: string;
  severity: SignalSeverity;
  tenantId: string;
  legalName: string;
  /** What will happen. Written as an outcome, not a metric. */
  headline: string;
  /** The arithmetic, so the number can be argued with. */
  basis: string;
  /** When it lands, where a date can be computed. Null where it cannot. */
  dueAt: string | null;
  daysAway: number | null;
  /** What an operator would do about it. */
  action: string;
};

export type ForecastPosition = {
  windowDays: number;
  generatedAt: string;
  signals: Signal[];
  counts: { critical: number; warning: number; watch: number };
  /** Money that renews inside the window, which is the exposure if nothing is done. */
  renewalExposureMinor: number;
  /** Tenancies whose last written record is older than the quiet threshold. */
  quietTenancies: number;
  quietThresholdDays: number;
  notForecast: string[];
  note: string;
};

/** How long a tenancy goes without writing a record before it is worth asking why. */
const QUIET_DAYS = 21;

/** How far ahead the queue looks. Beyond this a date is not an action. */
const HORIZON_DAYS = 45;

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

export function forecastPosition(platform: Platform, now = new Date()): ForecastPosition {
  // Customers only. The platform's own tenancy produced a CRITICAL "no
  // administrator" signal and a renewal on every deployment, and the
  // demonstration a renewal nobody will ever have a conversation about.
  const tenants = platform.customerTenants();
  const signals: Signal[] = [];
  let renewalExposureMinor = 0;

  const burn = estateBurn(
    tenants.map((tenant) => {
      const wallet = platform.wallet(tenant.id);
      return {
        tenantId: tenant.id,
        legalName: tenant.legalName,
        availableMinor: wallet.availableMinor(),
        entries: wallet.entries(),
      };
    }),
    30,
    now,
  );
  const burnById = new Map(burn.tenants.map((row) => [row.tenantId, row]));

  // Last written record per tenancy. Counted from the ledger's timestamps only
  // — this never reads what was written, which is the account boundary and also
  // all this signal needs.
  const lastWriteByTenant = new Map<string, string>();
  for (const event of platform.ledger.events()) {
    const held = lastWriteByTenant.get(event.tenantId);
    if (!held || event.timestamp > held) lastWriteByTenant.set(event.tenantId, event.timestamp);
  }

  let quietTenancies = 0;

  for (const tenant of tenants) {
    const subscription = platform.subscription(tenant.id);
    const definition = TIERS[subscription.tier];
    const users = platform.users(tenant.id);

    // --- AI service running out ------------------------------------------------
    const spend = burnById.get(tenant.id);
    if (spend?.runwayDays !== null && spend?.runwayDays !== undefined && spend.runwayDays <= HORIZON_DAYS) {
      const dueAt = new Date(now.getTime() + spend.runwayDays * 86_400_000).toISOString();
      signals.push({
        id: `runway:${tenant.id}`,
        severity: spend.runwayDays <= 7 ? 'CRITICAL' : spend.runwayDays <= 21 ? 'WARNING' : 'WATCH',
        tenantId: tenant.id,
        legalName: tenant.legalName,
        headline:
          spend.runwayDays <= 0
            ? 'AI is refused now — the wallet is empty'
            : `AI stops in ${spend.runwayDays} day${spend.runwayDays === 1 ? '' : 's'} at the current rate`,
        basis: `${(spend.availableMinor / 100).toFixed(2)} available ÷ ${(spend.dailyBurnMinor / 100).toFixed(2)} per day, measured over the last 30 days`,
        dueAt,
        daysAway: spend.runwayDays,
        action: 'Raise a top-up with them before it lands, or the first they know is a refusal mid-task.',
      });
    }

    // --- Renewal ---------------------------------------------------------------
    if (subscription.renewsAt) {
      const renewsIn = daysBetween(now, new Date(subscription.renewsAt));
      if (renewsIn >= 0 && renewsIn <= HORIZON_DAYS && definition.monthlyPriceUsd > 0) {
        renewalExposureMinor += definition.monthlyPriceUsd * 100;
        signals.push({
          id: `renewal:${tenant.id}`,
          severity: renewsIn <= 7 ? 'WARNING' : 'WATCH',
          tenantId: tenant.id,
          legalName: tenant.legalName,
          headline: `${subscription.tier} renews in ${renewsIn} day${renewsIn === 1 ? '' : 's'}`,
          basis: `renewal date on the subscription · $${definition.monthlyPriceUsd} per month at this tier`,
          dueAt: subscription.renewsAt,
          daysAway: renewsIn,
          action: 'A renewal nobody has spoken to before it lands is the one that does not renew.',
        });
      }
    }

    // --- A trial that ends ------------------------------------------------------
    if (subscription.tier === 'FREE_TRIAL' && subscription.renewsAt) {
      const endsIn = daysBetween(now, new Date(subscription.renewsAt));
      if (endsIn >= 0 && endsIn <= HORIZON_DAYS) {
        signals.push({
          id: `trial:${tenant.id}`,
          severity: endsIn <= 3 ? 'CRITICAL' : 'WARNING',
          tenantId: tenant.id,
          legalName: tenant.legalName,
          headline: `Trial ends in ${endsIn} day${endsIn === 1 ? '' : 's'}`,
          basis: `trial period on the subscription · ${users.length} identit${users.length === 1 ? 'y' : 'ies'} created so far`,
          dueAt: subscription.renewsAt,
          daysAway: endsIn,
          action: 'Either it converts or the tenancy goes read-only. Both need a conversation first.',
        });
      }
    }

    // --- Seats ------------------------------------------------------------------
    const seatsIncluded = definition.includedIdentities;
    const seatsUsed = subscription.assignedIdentities.length;
    if (seatsIncluded !== null && seatsIncluded > 0 && seatsUsed >= seatsIncluded) {
      signals.push({
        id: `seats:${tenant.id}`,
        severity: seatsUsed > seatsIncluded ? 'WARNING' : 'WATCH',
        tenantId: tenant.id,
        legalName: tenant.legalName,
        headline: seatsUsed > seatsIncluded ? 'Over its seat allowance' : 'Every included seat is taken',
        basis: `${seatsUsed} assigned against ${seatsIncluded} included at ${subscription.tier}`,
        dueAt: null,
        daysAway: null,
        // Expansion, not a problem. Stated as such: this is the one signal here
        // that is good news, and reading it as a fault would be exactly wrong.
        action: 'The next person they hire cannot be given a seat. That is an upgrade conversation, not a fault.',
      });
    }

    // --- Storage ----------------------------------------------------------------
    const position = storage.storagePosition({
      tier: subscription.package,
      usedBytes: platform.evidence.usage(tenant.id),
      purchasedBlocks: storage.purchasedBlocks(platform.ledger, tenant.id),
    });
    if (position.state !== 'OK') {
      signals.push({
        id: `storage:${tenant.id}`,
        severity: position.state === 'FULL' ? 'CRITICAL' : 'WARNING',
        tenantId: tenant.id,
        legalName: tenant.legalName,
        headline: position.state === 'FULL' ? 'Storage is full — the next upload is refused' : 'Storage is close to its limit',
        basis: `${(position.usedBytes / 1e9).toFixed(2)} GB held of ${(position.limitBytes / 1e9).toFixed(0)} GB`,
        dueAt: null,
        daysAway: null,
        action: 'Sell a storage block or the site stops being able to file evidence.',
      });
    }

    // --- Nobody can run it -------------------------------------------------------
    const administrators = users.filter((user) => user.roles.includes('ENTERPRISE_ADMIN'));
    if (administrators.length === 0) {
      signals.push({
        id: `unreachable:${tenant.id}`,
        severity: 'CRITICAL',
        tenantId: tenant.id,
        legalName: tenant.legalName,
        headline: 'No administrator — nobody can run this tenancy',
        basis: `${users.length} identit${users.length === 1 ? 'y' : 'ies'}, none holding ENTERPRISE_ADMIN`,
        dueAt: null,
        daysAway: null,
        action: 'Nobody can invite, configure or pay. Appoint one, or this tenancy is paying for nothing.',
      });
    }

    // --- Quiet --------------------------------------------------------------------
    const lastWrite = lastWriteByTenant.get(tenant.id);
    const quietFor = lastWrite ? daysBetween(new Date(lastWrite), now) : null;
    if (quietFor !== null && quietFor >= QUIET_DAYS) {
      quietTenancies += 1;
      signals.push({
        id: `quiet:${tenant.id}`,
        severity: quietFor >= QUIET_DAYS * 3 ? 'WARNING' : 'WATCH',
        tenantId: tenant.id,
        legalName: tenant.legalName,
        headline: `Nothing written for ${quietFor} days`,
        // Said plainly, because the honest version of this signal is weaker
        // than it looks and pretending otherwise is how a console starts
        // lying: a tenancy can be busy on site and quiet in the record.
        basis: `last event on any of its chains was ${lastWrite}. A count of events, not a measure of engagement — a tenancy between projects is quiet and perfectly healthy.`,
        dueAt: null,
        daysAway: null,
        action: 'Worth asking why before the renewal, not after it.',
      });
    }
  }

  // --- Money raised and never settled ---------------------------------------------
  for (const intent of platform.topUpIntents()) {
    if (intent.status !== 'AWAITING_PAYMENT') continue;
    const age = daysBetween(new Date(intent.requestedAt), now);
    if (age < 3) continue;
    const tenant = tenants.find((candidate) => candidate.id === intent.tenantId);
    signals.push({
      id: `unsettled:${intent.id}`,
      severity: age >= 14 ? 'WARNING' : 'WATCH',
      tenantId: intent.tenantId,
      legalName: tenant?.legalName ?? intent.tenantId,
      headline: `A top-up has been awaiting payment for ${age} days`,
      basis: `${(intent.amountMinor / 100).toFixed(2)} raised ${intent.requestedAt} and never settled`,
      dueAt: null,
      daysAway: null,
      action: 'Either the payment failed silently or they changed their mind. Both are worth knowing.',
    });
  }

  const order: Record<SignalSeverity, number> = { CRITICAL: 0, WARNING: 1, WATCH: 2 };
  signals.sort((a, b) => {
    if (order[a.severity] !== order[b.severity]) return order[a.severity] - order[b.severity];
    if (a.daysAway === null) return b.daysAway === null ? a.legalName.localeCompare(b.legalName) : 1;
    if (b.daysAway === null) return -1;
    return a.daysAway - b.daysAway;
  });

  return {
    windowDays: HORIZON_DAYS,
    generatedAt: now.toISOString(),
    signals,
    counts: {
      critical: signals.filter((signal) => signal.severity === 'CRITICAL').length,
      warning: signals.filter((signal) => signal.severity === 'WARNING').length,
      watch: signals.filter((signal) => signal.severity === 'WATCH').length,
    },
    renewalExposureMinor,
    quietTenancies,
    quietThresholdDays: QUIET_DAYS,
    /**
     * Named so that their absence is a stated position rather than an
     * omission somebody discovers by looking for them.
     */
    notForecast: [
      'A churn probability. Nothing here models one, and a percentage on an estate this size would be invented.',
      'Expansion revenue. Seat saturation is published above as the fact it is; what it converts to is not modelled.',
      'Usage-based revenue forecasting. The platform charges for AI as it is consumed and does not project consumption.',
      'Anything drawn from a customer’s delivery data. The operator layer cannot read it, so nothing here is built on it.',
    ],
    note:
      `Every signal is arithmetic over a record the platform already holds, and each one publishes the arithmetic. ` +
      `The horizon is ${HORIZON_DAYS} days — beyond that a date is not something anybody acts on today.`,
  };
}
