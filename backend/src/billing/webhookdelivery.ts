import { config } from '../config.ts';

/**
 * What the inbound payment webhooks have actually been sent, and what a refusal
 * means.
 *
 * ---
 *
 * **The failure this exists for.** A card rail can be wired, keyed, deployed
 * and tested, and still refuse every delivery — and the only thing anybody can
 * say about it is "the Stripe webhook is not working". That sentence is true of
 * eight different causes with eight different fixes: no secret on the
 * deployment, the wrong secret, a header lost in front of the process, a clock
 * five minutes out, a test-mode event sent to a live deployment, a body over
 * the ceiling, a rate limit, or Stripe never reaching the URL at all. Each one
 * is a different afternoon's work, and picking the wrong one costs the whole
 * afternoon.
 *
 * The platform already knew which it was and never said. `verifyWebhook`
 * refuses with a specific code; the code was counted, the count was published,
 * and the code itself was not — so the console showed two integers and told the
 * operator to check the signing secret, which is the right advice for exactly
 * one of the eight.
 *
 * **Why the tally lives here and not in each rail.** Two of the eight refusals
 * never reach `verifyWebhook`: a body over `maxBytes` and a rate limit are both
 * decided in the gateway, before the handler runs. Counted inside the rail they
 * would be invisible — the tally would read 0 accepted, 0 rejected, which looks
 * like a healthy endpoint nobody has used rather than a broken one nothing can
 * get through. So the tally is one record per rail, written by the rail for
 * what it verifies and by the gateway for what never got that far.
 *
 * **What this is not.** In-process, and reset by a restart — operational
 * telemetry, not a record. The receipts are the record. On a day with frequent
 * deploys a zeroed tally means "since the last deploy", and `diagnose` says so
 * rather than letting an operator read it as "nothing has gone wrong".
 *
 * Nothing here ever holds a secret or a signature. The shape checks measure a
 * configured value without reading it out.
 */

/** The two rails money arrives on. One tally each; they fail independently. */
export type WebhookRail = 'CARD' | 'MOBILE_MONEY';

export type WebhookHealthRecord = {
  accepted: number;
  rejected: number;
  /** Every refusal code seen since boot, and how many times. A mix is visible; a single cause is obvious. */
  byCode: Record<string, number>;
  /** The failure code of the most recent rejection, never the signature itself. */
  lastRejection?: { code: string; at: string };
  /** When the refusals started, so an operator can tell "since the deploy" from "since the secret rotated". */
  firstRejectionAt?: string;
  lastAcceptedAt?: string;
};

const RECORDS: Record<WebhookRail, WebhookHealthRecord> = {
  CARD: { accepted: 0, rejected: 0, byCode: {} },
  MOBILE_MONEY: { accepted: 0, rejected: 0, byCode: {} },
};

/** A copy, so a caller cannot move the tally by holding it. */
export function deliveryHealth(rail: WebhookRail): WebhookHealthRecord {
  const record = RECORDS[rail];
  return { ...record, byCode: { ...record.byCode } };
}

export function recordAccepted(rail: WebhookRail): void {
  const record = RECORDS[rail];
  record.accepted += 1;
  record.lastAcceptedAt = new Date().toISOString();
}

export function recordRefused(rail: WebhookRail, code: string): void {
  const record = RECORDS[rail];
  const at = new Date().toISOString();
  record.rejected += 1;
  record.byCode[code] = (record.byCode[code] ?? 0) + 1;
  record.lastRejection = { code, at };
  if (!record.firstRejectionAt) record.firstRejectionAt = at;
}

export function resetDelivery(rail: WebhookRail): void {
  RECORDS[rail] = { accepted: 0, rejected: 0, byCode: {} };
}

// ------------------------------------------------------------ route ownership

/**
 * Which rail a route belongs to, so the gateway can count a refusal it decided
 * itself against the rail it was aimed at.
 *
 * Keyed by route id — `METHOD /pattern`, the same string the gateway builds for
 * metrics — rather than by path, which carries nothing here but would be one
 * more thing to keep in step.
 */
const RAIL_BY_ROUTE: Record<string, WebhookRail> = {
  'POST /v1/webhooks/stripe': 'CARD',
  'POST /v1/webhooks/koda': 'MOBILE_MONEY',
};

export function railForRoute(routeId: string | undefined): WebhookRail | undefined {
  return routeId ? RAIL_BY_ROUTE[routeId] : undefined;
}

/**
 * Codes the rails count for themselves. The gateway must not count these a
 * second time — `verifyWebhook` has already recorded them by the time the error
 * reaches the gateway's handler, and counting twice would double every refusal.
 */
const COUNTED_BY_RAIL = new Set([
  'STRIPE_UNCONFIGURED',
  'STRIPE_SIGNATURE_MISSING',
  'STRIPE_SIGNATURE_MALFORMED',
  'STRIPE_SIGNATURE_STALE',
  'STRIPE_SIGNATURE_INVALID',
  'STRIPE_PAYLOAD_INVALID',
  'STRIPE_TEST_EVENT',
  'KODA_UNCONFIGURED',
  'KODA_SIGNATURE_MISSING',
  'KODA_SIGNATURE_INVALID',
  'KODA_PAYLOAD_INVALID',
]);

export function countedByRail(code: string): boolean {
  return COUNTED_BY_RAIL.has(code);
}

// --------------------------------------------------------------- what it means

export type WebhookRefusal = {
  /** What actually happened, in the operator's terms rather than the code's. */
  meaning: string;
  /** The next thing to do about it. One action, not a list of possibilities. */
  remedy: string;
  /**
   * Whether a customer may have paid and not been credited while this was
   * happening. It decides whether this is tonight's job or next week's.
   */
  moneyAtRisk: boolean;
};

/**
 * Every refusal an inbound payment webhook can produce, and what to do about it.
 *
 * Server-side because the browser holds no rule the API does not publish: the
 * console renders this table, it does not carry its own copy. A code added to a
 * rail without an entry here is caught by `webhookdelivery.test.ts`, which walks
 * the rails' refusals and requires each one to be explained.
 */
export const REFUSALS: Record<string, WebhookRefusal> = {
  STRIPE_UNCONFIGURED: {
    meaning: 'No card rail is keyed on this deployment, so the webhook refuses everything it is sent.',
    remedy: 'Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET together in the deployment environment and redeploy. Neither works alone.',
    moneyAtRisk: false,
  },
  STRIPE_SIGNATURE_MISSING: {
    meaning: 'The request carried no stripe-signature header. Either something in front of this process removed it, or the caller was not Stripe.',
    remedy: 'A handful of these is somebody probing a public URL and needs nothing. A run of them alongside deliveries failing in the Stripe dashboard means the header is being stripped between Stripe and this process.',
    moneyAtRisk: false,
  },
  STRIPE_SIGNATURE_MALFORMED: {
    meaning: 'A stripe-signature header arrived that could not be parsed into a timestamp and at least one v1 signature.',
    remedy: 'Something is rewriting the header in transit. Check anything between Stripe and this process that touches request headers.',
    moneyAtRisk: true,
  },
  STRIPE_SIGNATURE_STALE: {
    meaning: "The signature verified as well-formed but was timestamped outside the five-minute tolerance. This is almost always the host clock, not Stripe.",
    remedy: 'Check the clock on the host against real time and make sure time synchronisation is running. A container whose clock has drifted refuses every delivery while the secret is perfectly correct.',
    moneyAtRisk: true,
  },
  STRIPE_SIGNATURE_INVALID: {
    meaning: 'The signature did not match the body under the configured signing secret. Either the secret belongs to a different endpoint, or the body was altered in transit.',
    remedy: "Open the endpoint's own page in the Stripe dashboard and copy its signing secret again. Each endpoint has its own, a test-mode endpoint's secret will not verify a live delivery, and recreating an endpoint issues a new one.",
    moneyAtRisk: true,
  },
  STRIPE_PAYLOAD_INVALID: {
    meaning: 'The body verified against the signature and then did not parse as JSON.',
    remedy: 'This should not be reachable from Stripe. Capture the correlation id from the logs before changing anything.',
    moneyAtRisk: true,
  },
  STRIPE_TEST_EVENT: {
    meaning: 'A test-mode event was delivered to a deployment running as production, and was refused because test money must never credit a real account.',
    remedy: "This is the refusal a launch-day test produces. Switch the Stripe dashboard to live mode, use the live endpoint's signing secret, and pay with a real card to test the rail end to end. A test-mode delivery will always be refused here, and that is the rail working correctly.",
    moneyAtRisk: false,
  },
  UPLOAD_TOO_LARGE: {
    meaning: 'The delivery was larger than the 256KB ceiling on the webhook route and was refused before it could be verified.',
    remedy: 'A Stripe event is a few kilobytes. A delivery this size is an event type carrying an unusually large object; identify it in the Stripe dashboard before raising the ceiling.',
    moneyAtRisk: true,
  },
  RATE_LIMITED: {
    meaning: 'The delivery was refused by the rate limiter before it reached verification.',
    remedy: 'The limiter keys on the client address. If no trusted proxy is configured, every request appears to come from the gateway and shares one budget, so a busy minute can refuse Stripe. Set GATEWAY_TRUSTED_PROXIES so the real address is read.',
    moneyAtRisk: true,
  },
  KODA_UNCONFIGURED: {
    meaning: 'No mobile-money rail is keyed on this deployment, so the webhook refuses everything it is sent.',
    remedy: 'Set KODA_SECRET_KEY and KODA_WEBHOOK_SECRET together in the deployment environment and redeploy. Neither works alone.',
    moneyAtRisk: false,
  },
  KODA_SIGNATURE_MISSING: {
    meaning: 'The request carried no KODA signature header.',
    remedy: 'A handful of these is somebody probing a public URL. A run of them means the header is being stripped between KODA and this process.',
    moneyAtRisk: false,
  },
  KODA_SIGNATURE_INVALID: {
    meaning: 'The signature did not match the body under the configured KODA signing secret.',
    remedy: 'Copy the signing secret again from the KODA endpoint configuration. A secret from a different endpoint will not verify.',
    moneyAtRisk: true,
  },
  KODA_PAYLOAD_INVALID: {
    meaning: 'The body verified against the signature and then did not parse as JSON.',
    remedy: 'Capture the correlation id from the logs and raise it with KODA before changing anything here.',
    moneyAtRisk: true,
  },
};

// ------------------------------------------------------- the shape of a secret

/**
 * What can be said about a configured secret without reading it out.
 *
 * The two commonest deployment mistakes are both shape mistakes and both
 * invisible to every other check: the API key pasted where the signing secret
 * belongs, and a value carried into the environment still wrapped in the quotes
 * it was copied with. Both leave a secret that is present, plausible and wrong,
 * and both are obvious from a prefix and a length.
 */
export type SecretShape = {
  present: boolean;
  /**
   * Whether the value begins as the provider's signing secrets do. Absent when
   * the provider publishes no prefix to check against — asserted, never guessed.
   */
  prefixOk?: boolean;
  /** Character count. Enough to spot a truncated paste; nothing of the value itself. */
  length: number;
  /** Leading or trailing whitespace, which survives an .env file and breaks the HMAC. */
  padded: boolean;
  /** Wrapped in quotes that were copied along with it and are now part of the secret. */
  quoted: boolean;
};

export function secretShape(value: string, expectedPrefix?: string): SecretShape {
  const trimmed = value.trim();
  const quoted = trimmed.length >= 2 && /^(".*"|'.*')$/s.test(trimmed);
  // The prefix is read inside the quotes. A quoted but otherwise correct secret
  // has one fault, not two, and reporting it as both wrapped in quotes *and*
  // not a signing secret sends somebody looking for a second mistake that is
  // not there.
  const inner = quoted ? trimmed.slice(1, -1) : trimmed;
  return {
    present: value !== '',
    ...(expectedPrefix ? { prefixOk: inner.startsWith(expectedPrefix) } : {}),
    length: value.length,
    padded: value !== trimmed,
    quoted,
  };
}

// ------------------------------------------------------------------- the verdict

export type WebhookState =
  /** Deliveries are arriving and verifying. */
  | 'HEALTHY'
  /** Keyed, and nothing has ever reached the endpoint since this process started. */
  | 'NEVER_DELIVERED'
  /** Everything sent has been refused. Whatever is wrong, it is wrong for every delivery. */
  | 'ALL_REFUSED'
  /** Some verify and some do not. */
  | 'SOME_REFUSED'
  /** Not keyed, so no delivery can be accepted and no checkout can be opened. */
  | 'NOT_CONFIGURED'
  /** The configured secret is the wrong shape, whatever the deliveries say. */
  | 'SECRET_MALFORMED';

export type WebhookDiagnosis = {
  state: WebhookState;
  /** One sentence naming what is happening. */
  because: string;
  /** The next thing to do. */
  remedy: string;
  /** Whether a customer may have paid without being credited. */
  moneyAtRisk: boolean;
  /**
   * True where the deployment refuses test-mode events. Said plainly because a
   * launch-day test in Stripe's test mode is refused here by design, and that
   * looks identical to a broken rail from the dashboard.
   */
  liveOnly: boolean;
};

/**
 * Turn a tally, a configuration and a secret's shape into the one thing an
 * operator needs: what is wrong and what to do next.
 *
 * The order is deliberate. A malformed secret is decided before the deliveries,
 * because it explains them; an empty tally is decided before "healthy", because
 * zero refusals out of zero deliveries is not health.
 */
export function diagnose(input: {
  rail: WebhookRail;
  configured: boolean;
  shape: SecretShape;
  health: WebhookHealthRecord;
}): WebhookDiagnosis {
  const { rail, configured, shape, health } = input;
  const liveOnly = rail === 'CARD' && config.env === 'production';
  const rider = liveOnly
    ? ' This deployment runs as production and refuses test-mode events, so test the rail in live mode with a real card.'
    : '';

  if (!configured) {
    const refusal = REFUSALS[rail === 'CARD' ? 'STRIPE_UNCONFIGURED' : 'KODA_UNCONFIGURED'];
    return {
      state: 'NOT_CONFIGURED',
      because: refusal?.meaning ?? 'The rail is not keyed on this deployment.',
      remedy: refusal?.remedy ?? 'Key the rail in the deployment environment and redeploy.',
      moneyAtRisk: false,
      liveOnly,
    };
  }

  if (shape.quoted || shape.padded || shape.prefixOk === false) {
    const fault = shape.quoted
      ? 'is wrapped in the quotes it was copied with, which are now part of the secret'
      : shape.padded
        ? 'carries leading or trailing whitespace, which is part of the secret and breaks every signature'
        : 'does not begin with whsec_, so it is not a signing secret — an API key pasted into the wrong variable looks exactly like this';
    return {
      state: 'SECRET_MALFORMED',
      because: `The configured signing secret ${fault}.`,
      remedy: 'Copy the signing secret again from the endpoint page, paste it unquoted with no surrounding spaces, and redeploy.',
      // A rail nothing has been sent to is not money at risk — it is a rail
      // that will fail when it is used. The distinction matters: everything
      // marked at risk is somebody who may have paid and not been credited, and
      // a badge that overstates that is a badge people stop reading.
      moneyAtRisk: health.accepted === 0 && health.rejected > 0,
      liveOnly,
    };
  }

  if (health.accepted === 0 && health.rejected === 0) {
    return {
      state: 'NEVER_DELIVERED',
      because:
        'Nothing has reached this endpoint since the process started. A deploy resets this tally, so on a day with frequent deploys it means "since the last one" rather than "never".',
      remedy:
        `Check the endpoint URL in the provider's dashboard against ${config.publicBaseUrl || 'this deployment'}` +
        `, and that the endpoint is subscribed to the events this platform acts on.${rider}`,
      moneyAtRisk: false,
      liveOnly,
    };
  }

  const dominant = dominantCode(health);
  const refusal = dominant ? REFUSALS[dominant] : undefined;

  if (health.rejected > 0 && health.accepted === 0) {
    return {
      state: 'ALL_REFUSED',
      because:
        `Every one of the ${health.rejected} deliveries since the process started has been refused.` +
        (refusal ? ` ${refusal.meaning}` : dominant ? ` The refusal is ${dominant}.` : ''),
      remedy: (refusal?.remedy ?? 'Read the refusal code in the logs against the correlation id.') + rider,
      moneyAtRisk: refusal?.moneyAtRisk ?? true,
      liveOnly,
    };
  }

  if (health.rejected > 0) {
    return {
      state: 'SOME_REFUSED',
      because:
        `${health.accepted} deliveries verified and ${health.rejected} were refused.` +
        (refusal ? ` The commonest refusal: ${refusal.meaning}` : dominant ? ` The commonest refusal is ${dominant}.` : ''),
      remedy:
        (refusal?.remedy ?? 'Read the refusal codes in the logs.') +
        ' A public URL attracts probes, so a small number of signature refusals beside a working rail is expected.',
      moneyAtRisk: refusal?.moneyAtRisk ?? false,
      liveOnly,
    };
  }

  return {
    state: 'HEALTHY',
    because: `${health.accepted} deliveries have verified and none have been refused since the process started.`,
    remedy: 'Nothing to do.',
    moneyAtRisk: false,
    liveOnly,
  };
}

/** The code refused most often, which is the one worth explaining first. */
export function dominantCode(health: WebhookHealthRecord): string | undefined {
  let winner: string | undefined;
  let best = 0;
  for (const [code, count] of Object.entries(health.byCode)) {
    if (count > best) {
      best = count;
      winner = code;
    }
  }
  return winner;
}
