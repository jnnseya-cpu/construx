import { assertProductionSafety, config } from '../config.ts';
import { counters } from '../api/telemetry.ts';
import { ping, scannerAddress, scannerConfigured } from '../evidence/scanner.ts';
import { outboxPosition, queue } from '../notifications/outbox.ts';
import type { Platform } from '../platform.ts';

/**
 * The platform watching its own numbers, and telling somebody.
 *
 * `api/telemetry.ts` has counted requests, authentication failures, policy
 * denials, rate limits and validation rejections since the gateway was built.
 * Nothing read them. `docs/STATE.md` said so plainly — "structured JSON goes to
 * stdout and counters are exposed; nothing collects them" — and a counter nobody
 * reads is a counter that will be wrong for a week before anybody notices.
 *
 * A metrics store and an alerting stack are somebody else's infrastructure and
 * are not going to be built here. What can be built here, and is, is the part
 * that actually matters on a deployment of this size: a handful of rules over
 * the numbers the platform already has, evaluated on a timer, sent to the
 * operator through the outbox that already exists — so an alert survives a
 * process death exactly as a customer notification does.
 *
 * ---
 *
 * ## Rates, not totals
 *
 * The counters are monotonic since boot, which is correct and useless for
 * alerting: after a week, "5% of all requests since boot were 5xx" says nothing
 * about whether anything is wrong now. So each evaluation records the totals it
 * saw and the next one works on the **difference** — a rate over the interval,
 * which is the thing an on-call engineer is actually asking about.
 *
 * The first evaluation after a restart therefore judges nothing. That is
 * deliberate: the alternative is treating everything since boot as one window
 * and firing a false alarm on every deploy.
 *
 * ## A floor under every rate
 *
 * A rule that fires on "100% of requests failed" when one request was made will
 * be muted within a day, and a muted alert is worse than none. Every rate rule
 * carries a minimum sample, and below it the rule reports that it had nothing to
 * judge rather than judging it anyway.
 *
 * ## Transitions, not repetitions
 *
 * An alert fires when a rule *becomes* breached, again if it is still breached
 * after the re-notify interval, and — the part homegrown alerting always forgets
 * — once more when it **recovers**. Somebody woken at three needs to be told it
 * stopped as much as they needed to be told it started.
 *
 * ## What this is not
 *
 * It is not a metrics store: nothing is retained beyond the last observation.
 * It is not a monitor of anything outside this process — a second instance
 * cannot start anyway (`goldenthread/writerlock.ts`), so there is exactly one
 * process to watch. Shipping logs and metrics somewhere durable is still not
 * built, and `docs/STATE.md` still says so.
 */

export type WatchSeverity = 'WARNING' | 'CRITICAL';

/** The counters this evaluation is judging, as a difference from the last. */
export type Window = {
  requests: number;
  serverErrors: number;
  authFailures: number;
  rateLimited: number;
  validationRejects: number;
  /** Seconds the window covers. Zero on the first evaluation after a restart. */
  seconds: number;
};

export type Observation =
  | { judged: false; because: string }
  | { judged: true; breached: boolean; detail: string; value?: number; threshold?: number };

export type WatchRule = {
  id: string;
  /** What is being measured, in the words of somebody who has to act on it. */
  what: string;
  /** Why it is worth waking somebody for. */
  because: string;
  severity: WatchSeverity;
  observe: (platform: Platform, window: Window) => Observation | Promise<Observation>;
};

const percent = (part: number, whole: number): number => (whole === 0 ? 0 : Number(((part / whole) * 100).toFixed(1)));

export const WATCH_RULES: WatchRule[] = [
  {
    id: 'server_errors',
    what: 'The share of requests answered with a 5xx in the last interval',
    because:
      'A 5xx is the platform failing, not a caller being refused. Denials, validation failures and rate limits are ' +
      '4xx and are the platform working; those are counted separately and do not fire this.',
    severity: 'CRITICAL',
    observe: (_platform, window) => {
      if (window.requests < config.ops.minimumSample) {
        return { judged: false, because: `only ${window.requests} requests in the interval` };
      }
      const value = percent(window.serverErrors, window.requests);
      return {
        judged: true,
        breached: value >= config.ops.serverErrorPercent,
        value,
        threshold: config.ops.serverErrorPercent,
        detail: `${window.serverErrors} of ${window.requests} requests failed (${value}%)`,
      };
    },
  },
  {
    id: 'auth_failures',
    what: 'The share of requests that failed authentication in the last interval',
    because:
      'A sustained rate is somebody working through a credential list. One person mistyping a password is not, ' +
      'which is why this is a rate over an interval rather than a count.',
    severity: 'WARNING',
    observe: (_platform, window) => {
      if (window.requests < config.ops.minimumSample) {
        return { judged: false, because: `only ${window.requests} requests in the interval` };
      }
      const value = percent(window.authFailures, window.requests);
      return {
        judged: true,
        breached: value >= config.ops.authFailurePercent,
        value,
        threshold: config.ops.authFailurePercent,
        detail: `${window.authFailures} of ${window.requests} requests failed authentication (${value}%)`,
      };
    },
  },
  {
    id: 'rate_limiting',
    what: 'How often the rate limiter refused a caller in the last interval',
    because:
      'A burst is normal. A sustained one is either an integration in a retry loop or somebody enumerating, and ' +
      'both are worth looking at before the limits are raised to make the symptom go away.',
    severity: 'WARNING',
    observe: (_platform, window) => ({
      judged: true,
      breached: window.rateLimited >= config.ops.rateLimitedThreshold,
      value: window.rateLimited,
      threshold: config.ops.rateLimitedThreshold,
      detail: `${window.rateLimited} request(s) were rate limited`,
    }),
  },
  {
    id: 'outbox_abandoned',
    what: 'Notices the platform owes somebody and has given up sending',
    because:
      'An abandoned entry is a person who was told they would be told and was not — a payment notice, a permit ' +
      'expiry, a verification code. It is the one failure in this list a customer feels directly.',
    severity: 'CRITICAL',
    observe: (platform) => {
      const position = outboxPosition(platform);
      return {
        judged: true,
        breached: position.abandoned > 0,
        value: position.abandoned,
        threshold: 0,
        detail:
          position.abandoned === 0
            ? 'Nothing abandoned'
            : `${position.abandoned} notice(s) abandoned after ${config.notifications.maxAttempts} attempts, and ` +
              `${position.queued} still queued`,
      };
    },
  },
  {
    id: 'scanner_unreachable',
    what: 'Whether the configured signature scanner is answering',
    because:
      'With a scanner configured, ingestion refuses rather than recording an unscanned file as checked — so a ' +
      'scanner that has stopped answering does not corrupt anything, it stops evidence being read at all, and ' +
      'nobody finds out from a screen they were not looking at.',
    severity: 'CRITICAL',
    observe: async () => {
      if (!scannerConfigured()) {
        return { judged: false, because: 'no signature scanner is configured on this deployment' };
      }
      const reachable = await ping();
      return {
        judged: true,
        breached: !reachable.reachable,
        detail: reachable.reachable
          ? `${scannerAddress()} answered — ${reachable.version}`
          : `${scannerAddress()} did not answer: ${reachable.reason}`,
      };
    },
  },
  {
    id: 'configuration',
    what: 'Settings that make this deployment less safe than it looks',
    because:
      'The same checks the boot banner prints, asked again every interval. A warning printed once at boot is a ' +
      'warning nobody reads three weeks later, and the loudest of them — an in-memory ledger — loses the entire ' +
      'record on the next restart.',
    severity: 'CRITICAL',
    // Reuses `assertProductionSafety` rather than restating its rules. One
    // source of truth for what "unsafe" means, read by the boot banner and by
    // this; a second copy here would drift and the drift would be silent.
    observe: () => {
      const warnings = assertProductionSafety();
      return {
        judged: true,
        breached: warnings.length > 0,
        value: warnings.length,
        threshold: 0,
        detail: warnings.length === 0 ? 'Nothing unsafe' : warnings.join('; '),
      };
    },
  },
];

export type RuleState = {
  ruleId: string;
  firing: boolean;
  /** When it last changed state. */
  since: string;
  lastDetail: string;
  lastNotifiedAt?: string;
  /** How many times it has fired since boot. A flapping rule is its own finding. */
  firedCount: number;
};

export type WatchReport = {
  at: string;
  window: Window;
  started: string[];
  resolved: string[];
  stillFiring: string[];
  notJudged: Array<{ ruleId: string; because: string }>;
  notified: number;
};

type Totals = { requests: number; serverErrors: number; authFailures: number; rateLimited: number; validationRejects: number };

/** Counter totals right now. `requests_total` is labelled by status. */
function totals(): Totals {
  const requests = counters.read('requests_total');
  return {
    requests: requests.reduce((sum, series) => sum + series.value, 0),
    // Derived from the status label rather than from a second counter, so the
    // two can never disagree about how many requests there were.
    serverErrors: requests
      .filter((series) => String(series.labels.status ?? '').startsWith('5'))
      .reduce((sum, series) => sum + series.value, 0),
    authFailures: counters.total('auth_failures_total'),
    rateLimited: counters.total('rate_limited_total'),
    validationRejects: counters.total('validation_reject_total'),
  };
}

const states = new Map<string, RuleState>();
let previous: { at: number; totals: Totals } | undefined;

/** Test isolation only. A deployment never forgets what is firing. */
export function resetWatch(): void {
  states.clear();
  previous = undefined;
}

export function watchStates(): RuleState[] {
  return WATCH_RULES.map(
    (rule) =>
      states.get(rule.id) ?? {
        ruleId: rule.id,
        firing: false,
        since: 'never',
        lastDetail: 'not yet evaluated',
        firedCount: 0,
      },
  );
}

/**
 * Look at everything once, and tell somebody about what changed.
 *
 * Every rule is evaluated even after one has fired: an alert about the outbox
 * must not hide a configuration warning behind it, and a report that stops at
 * the first problem is a report somebody has to run twice.
 */
export async function evaluate(platform: Platform, now = new Date()): Promise<WatchReport> {
  const current = totals();
  const at = now.toISOString();

  // The first evaluation after a restart has nothing to compare against. Rate
  // rules see a zero window and decline to judge rather than treating
  // everything since boot as one interval and firing on every deploy.
  const window: Window = previous
    ? {
        requests: current.requests - previous.totals.requests,
        serverErrors: current.serverErrors - previous.totals.serverErrors,
        authFailures: current.authFailures - previous.totals.authFailures,
        rateLimited: current.rateLimited - previous.totals.rateLimited,
        validationRejects: current.validationRejects - previous.totals.validationRejects,
        seconds: Math.max(1, Math.round((now.getTime() - previous.at) / 1000)),
      }
    : { requests: 0, serverErrors: 0, authFailures: 0, rateLimited: 0, validationRejects: 0, seconds: 0 };
  previous = { at: now.getTime(), totals: current };

  const started: string[] = [];
  const resolved: string[] = [];
  const stillFiring: string[] = [];
  const notJudged: Array<{ ruleId: string; because: string }> = [];
  let notified = 0;

  for (const rule of WATCH_RULES) {
    let observation: Observation;
    try {
      observation = await rule.observe(platform, window);
    } catch (error) {
      // A rule that throws is itself a finding, and a silent one would leave
      // the platform reporting "all clear" for a check that never ran.
      observation = { judged: true, breached: true, detail: `The check itself failed: ${(error as Error).message}` };
    }

    if (!observation.judged) {
      notJudged.push({ ruleId: rule.id, because: observation.because });
      continue;
    }

    const was = states.get(rule.id);
    const wasFiring = was?.firing === true;

    if (observation.breached && !wasFiring) {
      states.set(rule.id, {
        ruleId: rule.id,
        firing: true,
        since: at,
        lastDetail: observation.detail,
        lastNotifiedAt: at,
        firedCount: (was?.firedCount ?? 0) + 1,
      });
      started.push(rule.id);
      notified += send(platform, rule, observation, 'STARTED', at) ? 1 : 0;
      continue;
    }

    if (observation.breached && wasFiring) {
      stillFiring.push(rule.id);
      const since = Date.parse(was?.lastNotifiedAt ?? at);
      const dueAgain = now.getTime() - since >= config.ops.renotifyMinutes * 60_000;
      states.set(rule.id, {
        ...was!,
        lastDetail: observation.detail,
        ...(dueAgain ? { lastNotifiedAt: at } : {}),
      });
      if (dueAgain) notified += send(platform, rule, observation, 'STILL_FIRING', at) ? 1 : 0;
      continue;
    }

    if (!observation.breached && wasFiring) {
      states.set(rule.id, {
        ...was!,
        firing: false,
        since: at,
        lastDetail: observation.detail,
        lastNotifiedAt: at,
      });
      resolved.push(rule.id);
      // The part homegrown alerting forgets. Somebody woken at three needs to
      // be told it stopped as much as they needed to be told it started.
      notified += send(platform, rule, observation, 'RESOLVED', at) ? 1 : 0;
      continue;
    }

    states.set(rule.id, {
      ruleId: rule.id,
      firing: false,
      since: was?.since ?? at,
      lastDetail: observation.detail,
      ...(was?.lastNotifiedAt ? { lastNotifiedAt: was.lastNotifiedAt } : {}),
      firedCount: was?.firedCount ?? 0,
    });
  }

  return { at, window, started, resolved, stillFiring, notJudged, notified };
}

/**
 * Queue the alert. Through the outbox, so it survives this process dying —
 * which is exactly the circumstance an alert is most likely to be written in.
 *
 * Returns false where there is nobody to tell. A deployment with no operator
 * cannot be alerted, and pretending otherwise would leave the platform
 * reporting alerts sent to nobody.
 */
function send(
  platform: Platform,
  rule: WatchRule,
  observation: Extract<Observation, { judged: true }>,
  transition: 'STARTED' | 'STILL_FIRING' | 'RESOLVED',
  at: string,
): boolean {
  const operators = platform.operators();
  if (operators.length === 0) return false;

  queue(platform, {
    code: transition === 'RESOLVED' ? 'system.watch_resolved' : 'system.watch_alert',
    recipients: operators.map((operator) => ({
      id: operator.id,
      tenantId: 'platform',
      name: operator.name,
      email: operator.email,
    })),
    payload: {
      // `what` and `severity` fill the subject line the catalogue declares, so
      // the alert says what fired in the header rather than only in the body.
      what: rule.what,
      severity: rule.severity,
      rule: rule.id,
      because: rule.because,
      transition,
      detail: observation.detail,
      ...(observation.value !== undefined ? { value: observation.value } : {}),
      ...(observation.threshold !== undefined ? { threshold: observation.threshold } : {}),
      observedAt: at,
    },
    branding: {
      clientName: 'CONSTRUX',
      primaryColour: '#ff6600',
      documentReferencePrefix: 'CXA',
      legalFooter: 'CONSTRUX — platform operations',
    },
    actorId: 'system:watch',
    correlationId: `watch-${rule.id}-${at}`,
  });
  return true;
}

export type WatchPosition = {
  enabled: boolean;
  intervalSeconds: number;
  /** Nobody to alert. A deployment in this state is watching itself in silence. */
  operators: number;
  firing: RuleState[];
  clear: RuleState[];
  rules: Array<{ id: string; what: string; because: string; severity: WatchSeverity }>;
};

/** What is firing, what is clear, and whether anybody would be told. */
export function watchPosition(platform: Platform): WatchPosition {
  const all = watchStates();
  return {
    enabled: config.ops.watchEnabled,
    intervalSeconds: config.ops.watchIntervalSeconds,
    operators: platform.operators().length,
    firing: all.filter((state) => state.firing),
    clear: all.filter((state) => !state.firing),
    rules: WATCH_RULES.map((rule) => ({
      id: rule.id,
      what: rule.what,
      because: rule.because,
      severity: rule.severity,
    })),
  };
}

/** Start evaluating on a timer. Returns the stop, for the shutdown path. */
export function startWatch(platform: Platform): () => void {
  if (!config.ops.watchEnabled) return () => {};
  const timer = setInterval(() => {
    void evaluate(platform).catch((error: unknown) => {
      process.stderr.write(`[watch] evaluation failed: ${(error as Error).message}\n`);
    });
  }, config.ops.watchIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
