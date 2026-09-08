/**
 * External data feeds: commodity pricing, weather and credit reference.
 *
 * `docs/STATE.md` carried these under what is not built. What was missing was
 * never the HTTP call — it was everything around it, and that is what this
 * module is:
 *
 *   - **A closed catalogue.** Three feed kinds, each declaring what it answers,
 *     which variable holds its endpoint, and where its value lands in the
 *     domain. A fourth needs an entry here, not a new fetch somewhere.
 *   - **Provenance on every reading.** A feed value is somebody else's
 *     assertion, and a project record that carries it without saying whose,
 *     when, and from what response is a record that cannot be checked. Every
 *     reading is an event carrying the source, the host, the request, the
 *     response hash and the moment.
 *   - **A refusal where nothing is configured.** No endpoint means the platform
 *     says which variable turns the feed on. It does not invent a price, a
 *     forecast or a credit score — those are the three numbers on this platform
 *     that a person would act on immediately, and a plausible invented one is
 *     worse than none.
 *   - **No vendor in the code.** Every feed is a URL, a small response mapping
 *     and a credential, all configured. This platform integrates no named data
 *     vendor and hard-coding one would make the choice for a customer who has
 *     already bought a different subscription.
 *
 * ## What a reading is, and is not
 *
 * A reading is **evidence of what a source said**, not a fact about the world
 * and not a decision. `readFeed` records the observation; a person or an
 * existing domain command decides what to do with it. The commodity price does
 * not reprice an estimate on its own, the forecast does not stop work, and the
 * credit score does not suspend a supplier — each of those is an act somebody
 * takes, on the record, with the reading cited as its source.
 */

import { config } from '../config.ts';

export type FeedCode = 'COMMODITY_PRICE' | 'WEATHER_FORECAST' | 'CREDIT_REFERENCE';

/** What a reading measures, so a number is never shown without its unit. */
export type FeedUnit = 'CURRENCY_PER_UNIT' | 'DEGREES_C' | 'MILLIMETRES' | 'SCORE' | 'RATIO' | 'TEXT';

export type FeedObservation = {
  /** The measure, in the source's own vocabulary — "steel-rebar", "temp-max". */
  measure: string;
  value: number | string;
  unit: FeedUnit;
  /** The moment the source says the observation is for; not the moment it was read. */
  observedAt?: string;
  /** Whatever else the source returned for this measure, unmodified. */
  note?: string;
};

export type FeedDefinition = {
  code: FeedCode;
  label: string;
  /** The question this feed answers, in the words somebody would ask it. */
  answers: string;
  /** The environment variable holding the endpoint. Named in every refusal. */
  endpointKey: string;
  /** The variable holding its credential, where the feed needs one. */
  credentialKey?: string;
  /**
   * The capability and permission a reading is authorised under.
   *
   * Different per feed on purpose: a commercial manager may read a commodity
   * price, and reading a firm's credit file is a procurement act on a
   * different register.
   */
  area: 'BUDGET_COST' | 'FIELD_EXECUTION' | 'PROCUREMENT_AWARD';
  code_: 'R' | 'I';
  /**
   * Turn the source's body into observations.
   *
   * Deliberately per-feed and deliberately defensive. A feed is a third party's
   * JSON and its shape changes without notice; a mapper that assumes structure
   * produces `undefined` readings that then sit on a project record looking
   * like measurements. Each returns only what it could actually read.
   */
  read: (body: unknown) => FeedObservation[];
  /** Where a confirmed reading belongs, so the screen can say so before it is taken. */
  lands: string;
};

/** A number the source stated, or undefined — never NaN, and never a coerced string. */
function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A source that sends "1284.50" is common and unambiguous; one that sends
  // "about 1284" is not, and Number() would answer NaN for it rather than
  // guessing, which is the behaviour wanted.
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export const FEEDS: Record<FeedCode, FeedDefinition> = {
  COMMODITY_PRICE: {
    code: 'COMMODITY_PRICE',
    label: 'Commodity price',
    answers: 'What is a tonne of this material trading at today, and on what date was that quoted?',
    endpointKey: 'FEED_COMMODITY_URL',
    credentialKey: 'FEED_COMMODITY_KEY',
    area: 'BUDGET_COST',
    code_: 'R',
    lands: 'A market price observation on this project, citable by an estimate or a variation as the basis of a rate',
    read: (body) => {
      // Two shapes are accepted because both are what price APIs actually
      // send: a flat `{ rates: { "steel-rebar": 1284.5 } }` map, and a list of
      // rows. Neither is guessed at — anything else reads as no observations,
      // and the caller is told the body was not readable rather than given an
      // empty success.
      const out: FeedObservation[] = [];
      const b = body as { rates?: Record<string, unknown>; date?: unknown; base?: unknown; prices?: unknown[] };
      const observedAt = text(b.date);
      if (b.rates && typeof b.rates === 'object') {
        for (const [measure, raw] of Object.entries(b.rates)) {
          const value = num(raw);
          if (value === undefined) continue;
          out.push({
            measure,
            value,
            unit: 'CURRENCY_PER_UNIT',
            ...(observedAt ? { observedAt } : {}),
            ...(text(b.base) ? { note: `quoted in ${text(b.base)}` } : {}),
          });
        }
      }
      for (const row of Array.isArray(b.prices) ? b.prices : []) {
        const r = row as Record<string, unknown>;
        const measure = text(r.commodity) ?? text(r.symbol) ?? text(r.name);
        const value = num(r.price) ?? num(r.value);
        if (!measure || value === undefined) continue;
        out.push({
          measure,
          value,
          unit: 'CURRENCY_PER_UNIT',
          ...(text(r.date) ?? observedAt ? { observedAt: text(r.date) ?? observedAt! } : {}),
          ...(text(r.unit) ? { note: `per ${text(r.unit)}` } : {}),
        });
      }
      return out;
    },
  },

  WEATHER_FORECAST: {
    code: 'WEATHER_FORECAST',
    label: 'Weather',
    answers: 'What was, or will be, the weather at this site — and is it the kind that stops work?',
    endpointKey: 'FEED_WEATHER_URL',
    credentialKey: 'FEED_WEATHER_KEY',
    area: 'FIELD_EXECUTION',
    code_: 'R',
    lands: 'Beside the site diary for that day, as the source’s account of the weather next to the site’s own',
    read: (body) => {
      const out: FeedObservation[] = [];
      const b = body as {
        daily?: { time?: unknown[]; temperature_2m_max?: unknown[]; temperature_2m_min?: unknown[]; precipitation_sum?: unknown[]; wind_speed_10m_max?: unknown[] };
        current?: Record<string, unknown>;
      };
      // The daily-array shape, which is what open forecast APIs send: parallel
      // arrays indexed by date. Read by index against `time`, so a short array
      // drops its own rows rather than pairing a temperature with the wrong day.
      const days = Array.isArray(b.daily?.time) ? b.daily!.time : [];
      const series: Array<[string, FeedUnit, unknown[] | undefined]> = [
        ['temperature-max', 'DEGREES_C', b.daily?.temperature_2m_max],
        ['temperature-min', 'DEGREES_C', b.daily?.temperature_2m_min],
        ['precipitation', 'MILLIMETRES', b.daily?.precipitation_sum],
        ['wind-max', 'RATIO', b.daily?.wind_speed_10m_max],
      ];
      days.forEach((day, at) => {
        const observedAt = text(day);
        if (!observedAt) return;
        for (const [measure, unit, values] of series) {
          const value = num(Array.isArray(values) ? values[at] : undefined);
          if (value === undefined) continue;
          out.push({ measure, value, unit, observedAt });
        }
      });
      if (b.current && typeof b.current === 'object') {
        const value = num(b.current.temperature_2m) ?? num(b.current.temperature);
        if (value !== undefined) {
          out.push({
            measure: 'temperature-now',
            value,
            unit: 'DEGREES_C',
            ...(text(b.current.time) ? { observedAt: text(b.current.time)! } : {}),
          });
        }
      }
      return out;
    },
  },

  CREDIT_REFERENCE: {
    code: 'CREDIT_REFERENCE',
    label: 'Credit reference',
    answers: 'What does the agency say about this firm’s ability to carry the package it is being offered?',
    endpointKey: 'FEED_CREDIT_URL',
    credentialKey: 'FEED_CREDIT_KEY',
    area: 'PROCUREMENT_AWARD',
    code_: 'I',
    lands: 'The financial record on the supply-chain register, with the agency named beside the score',
    read: (body) => {
      const out: FeedObservation[] = [];
      const b = body as Record<string, unknown>;
      const observedAt = text(b.date) ?? text(b.asAt) ?? text(b.reportDate);
      const score = num(b.score) ?? num(b.creditScore) ?? num((b.credit as Record<string, unknown>)?.score);
      if (score !== undefined) {
        out.push({
          measure: 'credit-score',
          value: score,
          unit: 'SCORE',
          ...(observedAt ? { observedAt } : {}),
          // The scale is the agency's and it is not comparable between
          // agencies. Carried through rather than normalised, because a
          // normalisation this platform invented would be a number nobody
          // could check against the report it came from.
          ...(text(b.agency) ?? text(b.provider) ? { note: `scale of ${text(b.agency) ?? text(b.provider)}` } : {}),
        });
      }
      const limit = num(b.creditLimit) ?? num(b.limit);
      if (limit !== undefined) out.push({ measure: 'credit-limit', value: limit, unit: 'CURRENCY_PER_UNIT', ...(observedAt ? { observedAt } : {}) });
      const turnover = num(b.turnover) ?? num(b.annualTurnover);
      if (turnover !== undefined) out.push({ measure: 'turnover', value: turnover, unit: 'CURRENCY_PER_UNIT', ...(observedAt ? { observedAt } : {}) });
      const status = text(b.status) ?? text(b.companyStatus);
      if (status) out.push({ measure: 'company-status', value: status, unit: 'TEXT', ...(observedAt ? { observedAt } : {}) });
      const filed = b.accountsFiledUpToDate ?? b.accountsUpToDate;
      if (typeof filed === 'boolean') out.push({ measure: 'accounts-up-to-date', value: filed ? 1 : 0, unit: 'RATIO', ...(observedAt ? { observedAt } : {}) });
      return out;
    },
  },
};

export const FEED_CODES = Object.keys(FEEDS) as FeedCode[];

export function isFeedCode(value: string): value is FeedCode {
  return value in FEEDS;
}

/** Where a feed's endpoint and credential are read from, in one place. */
export function feedSettings(code: FeedCode): { endpoint: string; credential: string } {
  const feed = config.feeds[code];
  return { endpoint: feed.url, credential: feed.key };
}

/** Whether this deployment can read this feed at all. */
export function feedConfigured(code: FeedCode): boolean {
  return feedSettings(code).endpoint !== '';
}

/**
 * The reason a feed cannot be read, naming the variable that turns it on.
 *
 * A message rather than a boolean because every screen and every route that
 * reports this needs the same sentence, and three of them writing their own is
 * how "not configured" becomes three different explanations.
 */
export function feedUnavailable(code: FeedCode): string | undefined {
  if (feedConfigured(code)) return undefined;
  const feed = FEEDS[code];
  return (
    `${feed.label} is not configured on this deployment. Set ${feed.endpointKey} to the endpoint your ` +
    `subscription publishes${feed.credentialKey ? `, and ${feed.credentialKey} to its credential` : ''}. ` +
    'Nothing is invented in the meantime: the platform reads no value rather than a plausible one.'
  );
}
