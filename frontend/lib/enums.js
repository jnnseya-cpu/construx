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
  CONTINENT,
  CONTRACT_FORM,
  DELAY_CAUSE,
  DISCIPLINE,
  NOTICE_TYPE,
  OBSERVATION_TYPE,
  PRICING_BASIS,
  RISK_CATEGORY,
  SECTOR,
  SECTOR_GROUPED,
  SITE_OBSERVATION_CATEGORY,
  WEATHER_CONDITION,
} from '/shared/vocabulary.js';

import { SECTOR as SECTOR_LIST, currentSector } from '/shared/vocabulary.js';

/**
 * The display name for a sector code, including one written under the previous
 * vocabulary.
 *
 * `humanise()` cannot do this job. It title-cases a token, so `RMI` renders as
 * "Rmi" and `FM` as "Fm", and it has no idea that `INFRASTRUCTURE` is a code
 * this list no longer contains. The label belongs to the vocabulary that owns
 * the code.
 */
export function sectorLabel(code) {
  const current = currentSector(code);
  return SECTOR_LIST.find((option) => option.value === current)?.label ?? String(code ?? '');
}

/** Today as an ISO date, for defaulting date pickers without a clock in markup. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}
