/**
 * The governed metric catalogue — what each number on a chart actually means.
 *
 * Section 8 of the Enterprise Visual Intelligence Standard: "All charts must
 * use governed semantic metrics with name, definition, formula, unit, owner and
 * refresh cadence."
 *
 * The failure this prevents is specific and common. Two screens draw "margin",
 * one of them against the tender and one against the current forecast, both
 * label the axis "Margin %", and the meeting spends twenty minutes discovering
 * that the two people looking at them are discussing different numbers. A chart
 * whose definition lives in the head of whoever wrote it is a chart that will
 * eventually be read as something it is not.
 *
 * So a metric is declared once, here, with:
 *
 * - **`label`** — what it is called on screen, everywhere.
 * - **`definition`** — a sentence a quantity surveyor would accept.
 * - **`formula`** — how it is actually computed, in the platform's own terms.
 * - **`unit`** — what the number is in. `MONEY` is always minor units.
 * - **`owner`** — the role accountable for the definition, not for the value.
 * - **`cadence`** — when the underlying record changes, so a reader knows
 *   whether "today" means today.
 * - **`source`** — the engine or route the figure is read from.
 *
 * ---
 *
 * **Why this is `.js` and not `.ts`**, and why serving it does not contradict
 * settled decision 6: the same reasons `vocabulary.js` gives. The gateway
 * serves this exact file, so the console holds the definition byte for byte
 * rather than a copy of it.
 *
 * **What does not belong here.** A value. This file says what a metric means
 * and never what it currently is — the engines compute that, against records,
 * under permission. A catalogue that carried values would be a second source of
 * truth for every number in the platform.
 *
 * **What `owner` is not.** It is not who may read the metric — that is the
 * permission matrix, and it is enforced server-side before any aggregation.
 * It is who is accountable for the definition being right.
 */

/** Units a metric can be in. `MONEY` is minor units, always. */
export const METRIC_UNITS = ['MONEY', 'PERCENT', 'DAYS', 'COUNT', 'RATIO', 'INDEX'];

/**
 * How often the number behind a metric can change.
 *
 * Not a refresh schedule — nothing here is cached or recomputed on a timer.
 * It is how often the *record* moves, which is what a reader is actually asking
 * when they ask how fresh a figure is. A metric derived from the ledger changes
 * the moment somebody writes to it; one derived from a monthly valuation does
 * not, however often the page is reloaded.
 */
export const METRIC_CADENCE = ['ON_WRITE', 'DAILY', 'WEEKLY', 'PER_CYCLE', 'PER_VALUATION', 'ON_DEMAND'];

/**
 * The catalogue. Closed, like the event and entity catalogues.
 *
 * A chart naming a metric that is not here fails `backend/tests/metrics.test.ts`,
 * which is the pressure that keeps this file the definition rather than a
 * document about the definitions.
 */
export const METRICS = {
  // ---------------------------------------------------------------- commercial
  CONTRACT_VALUE: {
    label: 'Contract value',
    definition: 'The sum the contract is currently worth, including every agreed variation and excluding everything not yet agreed.',
    formula: 'original contract sum + agreed variations',
    unit: 'MONEY',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'ON_WRITE',
    source: 'engines/claims.variationRegister + the contract record',
  },
  FORECAST_FINAL_COST: {
    label: 'Forecast final cost',
    definition: 'What the works are expected to cost at completion on the current information, not what was tendered.',
    formula: 'actual cost to date + committed cost + risk-adjusted uncommitted',
    unit: 'MONEY',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'PER_VALUATION',
    source: 'engines/cvr',
  },
  FORECAST_MARGIN_PERCENT: {
    label: 'Forecast margin',
    definition:
      'Margin at completion on the current forecast. Against the forecast final cost, never against the tender — the tender figure is a separate metric so the two cannot be confused.',
    formula: '(forecast final value − forecast final cost) ÷ forecast final value',
    unit: 'PERCENT',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'PER_VALUATION',
    source: 'engines/cvr',
  },
  MARGIN_EROSION_POINTS: {
    label: 'Margin erosion',
    definition: 'How far the forecast margin has moved from the margin tendered, in percentage points.',
    formula: 'tender margin % − forecast margin %',
    unit: 'PERCENT',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'PER_VALUATION',
    source: 'engines/cvr',
  },
  CERTIFIED_TO_DATE: {
    label: 'Certified to date',
    definition: 'Value certified by the client across every payment cycle. Certified is not paid and is not earned.',
    formula: 'sum of certified amounts on issued payment certificates',
    unit: 'MONEY',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'PER_CYCLE',
    source: 'engines/payments',
  },
  CUMULATIVE_RECEIPTS: {
    label: 'Cumulative receipts',
    definition:
      'Cash in, cumulatively, by payment period. This is what comes in and not what is left — subcontract commitments draw against it and the outflow side is unmeasured until something is certified down the chain.',
    formula: 'running sum of net certified per period',
    unit: 'MONEY',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'PER_CYCLE',
    source: 'cost/forward-cashflow',
  },
  CHANGE_EXPOSURE: {
    label: 'Change exposure',
    definition:
      'Downstream cost carried with nothing claimed upstream. The direction money is lost quietly on change, and invisible from either register alone.',
    formula: 'sum of downstream captured where no upstream variation is linked',
    unit: 'MONEY',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'ON_WRITE',
    source: 'engines/claims.variationRegister',
  },

  // ------------------------------------------------------------------ programme
  PROGRAMME_COMPLETE_PERCENT: {
    label: 'Programme complete',
    definition:
      'Share of the programme complete, weighted by activity duration rather than by activity count — a twenty-day activity and a one-day activity are not both one per cent.',
    formula: 'Σ(duration × percent complete) ÷ Σ(duration)',
    unit: 'PERCENT',
    owner: 'PLANNER',
    cadence: 'ON_WRITE',
    source: 'programme/schedule',
  },
  DELAY_EXPOSURE_DAYS: {
    label: 'Delay exposure',
    definition: 'Expected delay against the contractual completion date, forecast from the critical path rather than reported from a status.',
    formula: 'expected project duration − contractual duration',
    unit: 'DAYS',
    owner: 'PLANNER',
    cadence: 'ON_WRITE',
    source: 'engines/maths/cpm + delay forecast',
  },
  TOTAL_FLOAT_DAYS: {
    label: 'Total float',
    definition: 'How long an activity can slip before the project completion date moves. Zero or less is on the critical path.',
    formula: 'late start − early start',
    unit: 'DAYS',
    owner: 'PLANNER',
    cadence: 'ON_WRITE',
    source: 'engines/maths/cpm',
  },
  PPC_PERCENT: {
    label: 'Percent plan complete',
    definition: 'Of the tasks committed to in the lookahead, the share actually completed in that period. A production reliability measure, not a progress one.',
    formula: 'tasks completed ÷ tasks committed, per week',
    unit: 'PERCENT',
    owner: 'CONSTRUCTION_MANAGER',
    cadence: 'WEEKLY',
    source: 'lookahead/ppc',
  },
  CPI: {
    label: 'Cost performance index',
    definition: 'Earned value against actual cost. Below 1.00 is spending faster than the plan said for the work done.',
    formula: 'earned value ÷ actual cost',
    unit: 'INDEX',
    owner: 'COMMERCIAL_MANAGER',
    cadence: 'PER_VALUATION',
    source: 'engines/earnedvalue',
  },
  SPI: {
    label: 'Schedule performance index',
    definition: 'Earned value against planned value. Below 1.00 is earning slower than the plan said.',
    formula: 'earned value ÷ planned value',
    unit: 'INDEX',
    owner: 'PLANNER',
    cadence: 'PER_VALUATION',
    source: 'engines/earnedvalue',
  },

  // ----------------------------------------------------------------------- risk
  RISK_EXPECTED_COST: {
    label: 'Expected cost',
    definition:
      'Probability times impact across the open register. The figure risks are worth on average — not the figure to hold, which is the P80, and not what happens if everything lands, which is the worst case.',
    formula: 'Σ(probability × most likely cost impact)',
    unit: 'MONEY',
    owner: 'PROJECT_DIRECTOR',
    cadence: 'ON_WRITE',
    source: 'risk/contingency',
  },
  RISK_P80: {
    label: 'P80 contingency',
    definition: 'The contingency at which there is an eighty per cent chance of not being exceeded. The figure to hold.',
    formula: '80th percentile of the simulated risk cost distribution',
    unit: 'MONEY',
    owner: 'PROJECT_DIRECTOR',
    cadence: 'ON_WRITE',
    source: 'risk/contingency',
  },
  CONTROL_COVERAGE_PERCENT: {
    label: 'Control coverage',
    definition: 'Share of registered risks in a category carrying at least one mitigation. Coverage, not effectiveness — a mitigation nobody has done still counts.',
    formula: 'risks with ≥1 mitigation ÷ risks in category',
    unit: 'PERCENT',
    owner: 'PROJECT_DIRECTOR',
    cadence: 'ON_WRITE',
    source: 'entities/RiskRegisterItem',
  },

  // ------------------------------------------------------------------- assurance
  CHAIN_EVENTS_VERIFIED: {
    label: 'Chain events verified',
    definition: 'Events proved intact on the last verification pass of that chain. Verification rotates, so this is per chain and not per estate.',
    formula: 'count of events in the verified chain segment',
    unit: 'COUNT',
    owner: 'PLATFORM_ADMIN',
    cadence: 'ON_DEMAND',
    source: 'ops/assurance',
  },
  EVIDENCE_COVERAGE_PERCENT: {
    label: 'Evidence coverage',
    definition:
      'Share of evidence entries whose file is actually held, not merely hashed. A document generates either way; what a low figure costs is producing the original later.',
    formula: 'entries with a held file ÷ entries recorded',
    unit: 'PERCENT',
    owner: 'QAQC',
    cadence: 'ON_WRITE',
    source: 'projects/:id/evidence',
  },
  DEFECT_AGE_DAYS: {
    label: 'Defect age',
    definition: 'Days since a defect was reported, open or closed. Age, not count — four raised this week and four raised in March are different situations.',
    formula: 'today − reported date',
    unit: 'DAYS',
    owner: 'QAQC',
    cadence: 'ON_WRITE',
    source: 'entities/Defect',
  },

  // -------------------------------------------------------------------- account
  ACU_BILLED: {
    label: 'AI spend, billed',
    definition:
      'Paid AI consumption charged to a wallet. Trial consumption is a separate metric and is never added to this one — the standard requires the two to be commercially and visually separate.',
    formula: 'sum of billed ACU value on settled AI executions',
    unit: 'MONEY',
    owner: 'ENTERPRISE_ADMIN',
    cadence: 'ON_WRITE',
    source: 'billing/acu',
  },
  ACU_TRIAL: {
    label: 'AI spend, trial',
    definition: 'Non-billable AI consumption under a trial allowance. Never shown as invoiced consumption and never summed with billed spend.',
    formula: 'sum of trial ACU value on settled AI executions',
    unit: 'MONEY',
    owner: 'ENTERPRISE_ADMIN',
    cadence: 'ON_WRITE',
    source: 'billing/acu',
  },
  SEATS_ACTIVE: {
    label: 'Active seats',
    definition: 'Identities holding a seat and not deactivated. A seat is charged whether or not the person signs in.',
    formula: 'count of active identities with an assigned seat',
    unit: 'COUNT',
    owner: 'ENTERPRISE_ADMIN',
    cadence: 'ON_WRITE',
    source: 'billing/seats',
  },
};

/** Every metric id, for a picker or a check. */
export const METRIC_IDS = Object.keys(METRICS);

/** A metric by id, or undefined. Never throws — a caller may be probing. */
export function metric(id) {
  return METRICS[id];
}

/**
 * The sentence a chart shows when a reader asks what a number means.
 *
 * One line, because it sits in a footnote or a tooltip. The full definition is
 * in the catalogue and the console serves the catalogue.
 */
export function metricNote(id) {
  const found = METRICS[id];
  if (!found) return '';
  return `${found.label}: ${found.definition} Computed as ${found.formula}. Owned by ${found.owner
    .toLowerCase()
    .replace(/_/g, ' ')}.`;
}
