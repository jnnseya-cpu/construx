/**
 * Canonical enumerations — re-exported, not declared.
 *
 * The lists themselves live in `/shared/vocabulary.js`, which the gateway
 * serves and the API's route schemas validate against. This module exists so
 * the pages keep one import path, and so there is somewhere to put the
 * browser-only helper below.
 *
 * Seven vocabularies were removed here rather than moved: `SECTOR_TYPE`,
 * `LIFECYCLE_PHASE`, `CONTRACT_SUITE`, `PROCUREMENT_ROUTE`, `COMMERCIAL_MODEL`,
 * `CURRENCY` and `CAPTURE_SOURCE` were exported and read by no page. A dead
 * list is worse than no list once it is the declared source of truth for a
 * value — it goes stale silently and is then trusted by whoever finds it.
 * `CURRENCY` had already gone wrong that way: it offered three currencies while
 * the platform counts in eighteen, and `GET /v1/localisation` publishes the
 * real set.
 */

export {
  CHANGE_ORIGIN,
  DELAY_CAUSE,
  DISCIPLINE,
  NOTICE_TYPE,
  OBSERVATION_TYPE,
  RISK_CATEGORY,
  SITE_OBSERVATION_CATEGORY,
  WEATHER_CONDITION,
} from '/shared/vocabulary.js';

/** Today as an ISO date, for defaulting date pickers without a clock in markup. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}
