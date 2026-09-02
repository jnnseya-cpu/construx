/**
 * The engagement-decay churn signal.
 *
 * ## What this measures, and what it does not
 *
 * It measures whether a tenancy is still *using* the platform, from the only
 * evidence that cannot be gamed: events they wrote to the ledger. Not logins —
 * a session opened and abandoned is a login. Not page views, which this
 * platform does not collect. Written events are work somebody actually did.
 *
 * It does **not** predict churn. There is no model here, no trained weights and
 * no probability, because there is no cohort of past churn to have trained on —
 * this platform has not been running long enough, and a percentage produced
 * without one is a number with a decimal point and nothing behind it. What it
 * produces is a *decay measurement* and a plain statement of what changed,
 * which is what somebody would act on anyway.
 *
 * ## Why decay rather than a threshold
 *
 * "Fewer than ten events this week" flags every small customer for ever and
 * every large one never. The signal that matters is a tenancy doing markedly
 * less than **it** used to, which is scale-free: a company that wrote 400
 * events a week and now writes 40 is in trouble at a volume another company
 * would be thriving at.
 *
 * ## The failure this is written against
 *
 * A silent customer is not necessarily leaving — the site could be between
 * projects, which in construction is normal and seasonal. Reporting that as
 * "churn risk 78%" sends an account manager to ask a customer why they are
 * unhappy when they are not, which is itself a reason to leave. So the output
 * separates **what is measured** from **what it might mean**, and never
 * collapses the two into a score.
 */

export type ActivityWindow = {
  /** Events written in the most recent period. */
  recent: number;
  /** Events written in the equivalent period before it. */
  prior: number;
  /** Distinct identities that wrote anything recently. */
  recentActors: number;
  priorActors: number;
  /** Days since the last event of any kind. */
  daysSinceLastEvent: number | null;
  /** Days of the recent period that saw at least one event. */
  activeDays: number;
  periodDays: number;
};

export type ChurnBand = 'ENGAGED' | 'SOFTENING' | 'DECAYING' | 'DORMANT' | 'TOO_NEW_TO_SAY';

export type ChurnSignal = {
  tenantId: string;
  band: ChurnBand;
  /** The decay in written events, as a proportion. Null where there is no prior period. */
  decay: number | null;
  /** The same for the number of people using it, which moves before volume does. */
  actorDecay: number | null;
  window: ActivityWindow;
  /** What was measured. Facts only. */
  measurements: string[];
  /** What it might mean, and what would distinguish the readings. Never a score. */
  interpretations: string[];
  /** The next thing a human should do, or that nothing is needed. */
  action: string;
};

/** Below this share of the prior period, activity has meaningfully fallen. */
export const SOFTENING_BELOW = 0.7;
export const DECAYING_BELOW = 0.4;
/** No event at all for this long is dormancy rather than decay. */
export const DORMANT_AFTER_DAYS = 30;
/** Under this many events in the prior period, a ratio is noise. */
export const MINIMUM_PRIOR = 20;

function proportion(recent: number, prior: number): number | null {
  if (prior <= 0) return null;
  return recent / prior;
}

export function churnSignal(input: { tenantId: string; window: ActivityWindow }): ChurnSignal {
  const { window } = input;
  const ratio = proportion(window.recent, window.prior);
  const actorRatio = proportion(window.recentActors, window.priorActors);

  const measurements: string[] = [
    `${window.recent} events written in the last ${window.periodDays} days, against ${window.prior} in the ${window.periodDays} before.`,
    `${window.recentActors} people wrote something, against ${window.priorActors} before.`,
    `Work happened on ${window.activeDays} of the last ${window.periodDays} days.`,
    window.daysSinceLastEvent === null
      ? 'Nothing has ever been written by this tenancy.'
      : `Last event ${window.daysSinceLastEvent} day${window.daysSinceLastEvent === 1 ? '' : 's'} ago.`,
  ];

  // Dormancy first: it is a fact, not a ratio, and it outranks everything.
  if (window.daysSinceLastEvent === null || window.daysSinceLastEvent >= DORMANT_AFTER_DAYS) {
    return {
      tenantId: input.tenantId,
      band: 'DORMANT',
      decay: ratio === null ? null : 1 - ratio,
      actorDecay: actorRatio === null ? null : 1 - actorRatio,
      window,
      measurements,
      interpretations: [
        'Nothing has been written for a month or more. That is either a customer who has stopped, or a company ' +
          'between projects — which in construction is ordinary and seasonal.',
        'The two look identical from here and are told apart by asking, not by measuring.',
      ],
      action: 'Ask. Nothing in the data distinguishes a lost customer from a quiet quarter.',
    };
  }

  // Not enough history for a ratio to mean anything.
  if (window.prior < MINIMUM_PRIOR) {
    return {
      tenantId: input.tenantId,
      band: 'TOO_NEW_TO_SAY',
      decay: null,
      actorDecay: null,
      window,
      measurements,
      interpretations: [
        `The previous period holds ${window.prior} events, which is too few for a change to be distinguishable from ` +
          'ordinary variation. A ratio computed on this would move wildly on one busy afternoon.',
      ],
      action: 'Nothing. Let another period pass before reading anything into it.',
    };
  }

  const share = ratio!;
  const band: ChurnBand = share < DECAYING_BELOW ? 'DECAYING' : share < SOFTENING_BELOW ? 'SOFTENING' : 'ENGAGED';

  const interpretations: string[] = [];
  if (band === 'ENGAGED') {
    interpretations.push('Activity is holding or growing. Nothing here suggests a customer going quiet.');
  } else {
    interpretations.push(
      `Written work is down ${Math.round((1 - share) * 100)}% against the previous period. That is a real fall in ` +
        'use, and not a prediction of anything.',
    );
    if (actorRatio !== null && actorRatio < share) {
      // People leaving before volume falls is the earlier and more reliable
      // signal: the last few users work harder for a while and volume lags.
      interpretations.push(
        'The number of people using it has fallen further than the volume of work has. People stopping is the earlier ' +
          'signal — those left carry on for a while and the volume follows.',
      );
    }
    if (window.activeDays <= Math.ceil(window.periodDays / 4)) {
      interpretations.push(
        `Work happened on only ${window.activeDays} days out of ${window.periodDays}, so the remaining activity is ` +
          'coming in bursts rather than as part of anybody’s week.',
      );
    }
    interpretations.push(
      'A seasonal gap between projects looks exactly like this. What separates them is whether the company has work ' +
        'on, which this platform does not know unless they tell it.',
    );
  }

  return {
    tenantId: input.tenantId,
    band,
    decay: 1 - share,
    actorDecay: actorRatio === null ? null : 1 - actorRatio,
    window,
    measurements,
    interpretations,
    action:
      band === 'ENGAGED'
        ? 'Nothing.'
        : band === 'SOFTENING'
          ? 'Worth noticing at the next review. Not worth a phone call yet.'
          : 'Worth a conversation. Ask what changed rather than presenting them with this.',
  };
}

/** Build a window from raw event timestamps. One place, so the periods cannot disagree. */
export function windowFrom(
  events: ReadonlyArray<{ at: string; actorId: string }>,
  periodDays = 28,
  now = new Date(),
): ActivityWindow {
  const day = 24 * 60 * 60 * 1000;
  const recentFrom = now.getTime() - periodDays * day;
  const priorFrom = now.getTime() - 2 * periodDays * day;

  const recent = events.filter((event) => Date.parse(event.at) >= recentFrom);
  const prior = events.filter((event) => {
    const at = Date.parse(event.at);
    return at >= priorFrom && at < recentFrom;
  });

  const latest = events.reduce<number | null>((newest, event) => {
    const at = Date.parse(event.at);
    return newest === null || at > newest ? at : newest;
  }, null);

  return {
    recent: recent.length,
    prior: prior.length,
    recentActors: new Set(recent.map((event) => event.actorId)).size,
    priorActors: new Set(prior.map((event) => event.actorId)).size,
    daysSinceLastEvent: latest === null ? null : Math.floor((now.getTime() - latest) / day),
    activeDays: new Set(recent.map((event) => event.at.slice(0, 10))).size,
    periodDays,
  };
}
