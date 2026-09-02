import { config } from '../config.ts';
import { lockState } from './lockout.ts';
import { knownNetwork, networkOf, type DeviceRecord } from './devices.ts';

/**
 * Risk-based step-up: deciding when a signed-in session must prove itself again.
 *
 * ## The problem this solves
 *
 * MFA at the door and nothing afterwards is the shape almost every product has,
 * and it means the strength of a fifteen-minute-old ceremony is what stands
 * behind certifying a payment eight hours later from a different continent. The
 * alternative most products reach for — MFA on every sensitive action — trains
 * people to approve prompts without reading them, which is worse than not asking
 * at all.
 *
 * So the question is not "is this action sensitive" on its own. It is **"is this
 * combination of who, from where, on what, doing what, unusual enough to be
 * worth interrupting a person over"** — and the answer has to be arithmetic over
 * things the platform already knows, so that it is the same answer every time
 * and a person can be shown the working.
 *
 * ## The signals
 *
 * Every one is read from state this platform already holds. Nothing here calls a
 * model, nothing here calls out to a reputation service, and nothing here uses a
 * browser fingerprint — a fingerprint is a tracking identifier that would have
 * to be disclosed, retained and defended, and it buys less than the device
 * register already provides.
 *
 * Each signal contributes points and a sentence. The sentence matters as much as
 * the points: a person told "additional verification required" learns nothing
 * and resents it, and a person told "this is a device you have not used before,
 * and you are about to certify £840,000" understands immediately.
 *
 * ## What a step-up is, and what it is not
 *
 * It is a fresh MFA challenge, satisfied within a short window, recorded against
 * the session. It is **not** a lock, not a refusal, and not a thing an
 * administrator clears: a control that needs somebody else to unblock it is a
 * denial of service anybody can perform on anybody by travelling.
 *
 * And it is never the *only* control. Everything a step-up guards is already
 * behind the permission matrix and the phase gates. Step-up asks "is this really
 * you"; authorisation asks "may you". A platform that confused the two would let
 * a second factor substitute for authority.
 */

export type RiskBand = 'LOW' | 'ELEVATED' | 'HIGH';

export type RiskSignal = {
  /** Stable id, so a screen can group and a test can name one. */
  signal: RiskSignalId;
  points: number;
  /** What the person is told. A full sentence, not a code. */
  because: string;
};

export type RiskSignalId =
  | 'UNBOUND_SESSION'
  | 'UNKNOWN_NETWORK'
  | 'RECENT_FAILURES'
  | 'STALE_AUTHENTICATION'
  | 'DEVICE_FIRST_USE'
  | 'HIGH_VALUE'
  | 'IRREVERSIBLE'
  | 'GOVERNANCE'
  | 'MACHINE_CREDENTIAL';

/**
 * The weights.
 *
 * Points rather than probabilities, because nothing here is calibrated against
 * an incident set and calling an uncalibrated number a probability would be a
 * claim the platform cannot support. What they are is an ordering somebody
 * chose and can argue with, published so it can be argued with.
 *
 * The bands sit at 35 and 60, and both numbers are set by the cases they have
 * to catch and the cases they must not.
 *
 * **No single signal reaches HIGH.** The heaviest is 35, so an interruption
 * always takes a combination. A person on a new network is not a threat, and
 * interrupting them there is how people learn to click through prompts.
 *
 * **Two heavy signals do reach it.** An unbound session certifying £840,000
 * scores 65, and a governance change from an unbound session scores 60. Both
 * are exactly the case step-up exists for, and an earlier calibration at 70 let
 * the first of them through as merely "worth noting" — which is the failure
 * mode that matters, because a threshold nothing trips is a threshold nobody
 * notices is broken.
 */
export const RISK_WEIGHTS: Record<RiskSignalId, number> = {
  /** No device is bound to this session at all. */
  UNBOUND_SESSION: 30,
  /** This device has never been used from this network before. */
  UNKNOWN_NETWORK: 25,
  /** Failed verifications have been counted against this identity recently. */
  RECENT_FAILURES: 30,
  /** The MFA ceremony behind this session is older than the step-up window. */
  STALE_AUTHENTICATION: 20,
  /** The device was enrolled but has never carried a request before. */
  DEVICE_FIRST_USE: 15,
  /** The act commits money past the configured threshold. */
  HIGH_VALUE: 35,
  /** The act cannot be undone: an erasure, a revocation, a certification. */
  IRREVERSIBLE: 25,
  /** The act changes who may do what: roles, policies, module grants, keys. */
  GOVERNANCE: 30,
  /** An API key is acting, and a key never satisfies a second factor. */
  MACHINE_CREDENTIAL: 20,
};

export const BAND_AT = { ELEVATED: 35, HIGH: 60 } as const;

export type RiskAssessment = {
  score: number;
  band: RiskBand;
  signals: RiskSignal[];
  /** Whether this act may proceed on the session as it stands. */
  stepUpRequired: boolean;
  /** One sentence a person reads at the point of interruption. */
  statement: string;
};

/**
 * The acts that carry their own weight regardless of the session.
 *
 * Read from the capability area and the permission code the route already
 * declares, rather than from a second list of "sensitive endpoints" that would
 * drift from the first. A governance write is a governance write whether it
 * arrives through the console, the API or an approved agent proposal.
 */
export function actWeight(input: {
  area?: string;
  code?: string;
  valueMinor?: number;
  irreversible?: boolean;
}): RiskSignal[] {
  const signals: RiskSignal[] = [];

  // `G` is the governance code: users, policies, keys, module grants, agent
  // envelopes. Everything that changes who may do what.
  if (input.code === 'G') {
    signals.push({
      signal: 'GOVERNANCE',
      points: RISK_WEIGHTS.GOVERNANCE,
      because: 'This changes who is allowed to do what, which is the one kind of change that can hide every other kind.',
    });
  }

  if (typeof input.valueMinor === 'number' && input.valueMinor >= config.auth.stepUpValueMinor) {
    signals.push({
      signal: 'HIGH_VALUE',
      points: RISK_WEIGHTS.HIGH_VALUE,
      because: `This commits ${formatMinor(input.valueMinor)}, which is past the amount this tenancy asks to be re-verified for.`,
    });
  }

  if (input.irreversible === true) {
    signals.push({
      signal: 'IRREVERSIBLE',
      points: RISK_WEIGHTS.IRREVERSIBLE,
      because: 'This cannot be undone from inside the platform. Nothing here can put it back.',
    });
  }

  return signals;
}

/** Minor units to a readable figure, without pulling in the display layer. */
function formatMinor(minor: number): string {
  const major = minor / 100;
  if (major >= 1_000_000) return `${Math.round(major / 100_000) / 10}M`;
  if (major >= 1_000) return `${Math.round(major / 100) / 10}k`;
  return String(Math.round(major));
}

export type SessionFacts = {
  actorId: string;
  /** The device this session is bound to, where it is bound to one. */
  device?: DeviceRecord;
  remote?: string;
  /** When the MFA ceremony behind this session happened. */
  authenticatedAt?: number;
  /** True where the caller is an API key rather than a person. */
  machineCredential?: boolean;
};

/**
 * Score a request.
 *
 * Pure: every input is passed in, so the same facts always produce the same
 * assessment and a screen can show a person exactly what was counted. The only
 * thing read from module state is the failure counter, which is the one signal
 * that is about the account rather than about this request.
 */
export function assessRisk(
  session: SessionFacts,
  act: Parameters<typeof actWeight>[0] = {},
  now = Date.now(),
): RiskAssessment {
  const signals: RiskSignal[] = [];

  if (session.machineCredential) {
    signals.push({
      signal: 'MACHINE_CREDENTIAL',
      points: RISK_WEIGHTS.MACHINE_CREDENTIAL,
      because: 'An API key is acting. A credential in a configuration file cannot perform a second factor, so it never satisfies one.',
    });
  } else if (!session.device) {
    signals.push({
      signal: 'UNBOUND_SESSION',
      points: RISK_WEIGHTS.UNBOUND_SESSION,
      because: 'This session is not bound to an enrolled device, so a copy of its token would work from anywhere.',
    });
  } else {
    if (!knownNetwork(session.device, session.remote)) {
      signals.push({
        signal: 'UNKNOWN_NETWORK',
        points: RISK_WEIGHTS.UNKNOWN_NETWORK,
        because: `This device has not been used from ${networkOf(session.remote)} before.`,
      });
    }
    if (session.device.lastSeenAt === undefined) {
      signals.push({
        signal: 'DEVICE_FIRST_USE',
        points: RISK_WEIGHTS.DEVICE_FIRST_USE,
        because: `"${session.device.label}" was enrolled but has not carried a request before.`,
      });
    }
  }

  // The account's own recent history. Counted even where this request looks
  // ordinary: a run of failures followed by a success is what a guessed code
  // looks like from the outside.
  const failures = lockState(session.actorId, now).failures;
  if (failures > 0) {
    signals.push({
      signal: 'RECENT_FAILURES',
      points: RISK_WEIGHTS.RECENT_FAILURES,
      because: `${failures} failed verification${failures === 1 ? '' : 's'} against this account in the last few minutes.`,
    });
  }

  const windowMs = config.auth.stepUpWindowMinutes * 60_000;
  if (session.authenticatedAt === undefined || now - session.authenticatedAt > windowMs) {
    const age = session.authenticatedAt === undefined ? undefined : Math.round((now - session.authenticatedAt) / 60_000);
    signals.push({
      signal: 'STALE_AUTHENTICATION',
      points: RISK_WEIGHTS.STALE_AUTHENTICATION,
      because:
        age === undefined
          ? 'This session carries no record of when it was verified.'
          : `The verification behind this session was ${age} minutes ago.`,
    });
  }

  signals.push(...actWeight(act));

  const score = signals.reduce((sum, signal) => sum + signal.points, 0);
  const band: RiskBand = score >= BAND_AT.HIGH ? 'HIGH' : score >= BAND_AT.ELEVATED ? 'ELEVATED' : 'LOW';

  // A machine credential can never step up, so demanding it of one would be
  // refusing the act outright under a misleading name. An integration that is
  // not allowed to do something should be told it is not allowed.
  const stepUpRequired = band === 'HIGH' && !session.machineCredential;

  return {
    score,
    band,
    signals,
    stepUpRequired,
    statement: statementFor(band, signals, session.machineCredential === true),
  };
}

function statementFor(band: RiskBand, signals: RiskSignal[], machine: boolean): string {
  if (band === 'LOW') {
    return signals.length === 0
      ? 'Nothing unusual about this session or this action.'
      : `Nothing here needs re-verifying: ${signals.length} minor signal${signals.length === 1 ? '' : 's'}, none of them serious on its own.`;
  }
  const worst = signals.slice().sort((a, b) => b.points - a.points)[0];
  if (band === 'ELEVATED') {
    return `Worth noting rather than interrupting: ${worst?.because ?? 'several small signals together.'}`;
  }
  if (machine) {
    return (
      `This combination would ask a person to verify again, and an API key cannot. ${worst?.because ?? ''} ` +
      'If an integration genuinely needs to do this, it needs a person to do it or a narrower way to ask.'
    ).trim();
  }
  return `Verify again before this goes through. ${worst?.because ?? ''}`.trim();
}

// --- Step-up state -----------------------------------------------------------

/**
 * Sessions that have re-verified, and when.
 *
 * In-process, and correctly so — unlike a device revocation, this is state about
 * the last few minutes rather than a fact about the business, and the failure
 * mode of losing it on restart is that somebody is asked to verify once more.
 * That is the right way round: a restart makes the platform *more* cautious, not
 * less.
 */
const steppedUp = new Map<string, number>();

/** Record that a session satisfied a step-up. */
export function recordStepUp(tokenId: string, now = Date.now()): void {
  steppedUp.set(tokenId, now);
}

/** Whether a session's step-up is still inside its window. */
export function stepUpSatisfied(tokenId: string, now = Date.now()): boolean {
  const at = steppedUp.get(tokenId);
  if (at === undefined) return false;
  if (now - at > config.auth.stepUpWindowMinutes * 60_000) {
    steppedUp.delete(tokenId);
    return false;
  }
  return true;
}

/** Drop every step-up. Tests only. */
export function resetStepUps(): void {
  steppedUp.clear();
}

/**
 * The whole model, for the screen that explains it.
 *
 * Published rather than described, for the same reason the permission matrix is:
 * a rule a person can only learn by tripping over it is a rule they experience
 * as the platform being arbitrary.
 */
export function riskModel(): {
  weights: typeof RISK_WEIGHTS;
  bands: typeof BAND_AT;
  windowMinutes: number;
  valueThresholdMinor: number;
  signals: Array<{ signal: RiskSignalId; points: number; meaning: string }>;
} {
  return {
    weights: RISK_WEIGHTS,
    bands: BAND_AT,
    windowMinutes: config.auth.stepUpWindowMinutes,
    valueThresholdMinor: config.auth.stepUpValueMinor,
    signals: [
      { signal: 'UNBOUND_SESSION', points: RISK_WEIGHTS.UNBOUND_SESSION, meaning: 'The session is not tied to an enrolled device' },
      { signal: 'UNKNOWN_NETWORK', points: RISK_WEIGHTS.UNKNOWN_NETWORK, meaning: 'This device has not been used from this network before' },
      { signal: 'RECENT_FAILURES', points: RISK_WEIGHTS.RECENT_FAILURES, meaning: 'Failed verifications against this account recently' },
      { signal: 'STALE_AUTHENTICATION', points: RISK_WEIGHTS.STALE_AUTHENTICATION, meaning: 'The verification behind this session is old' },
      { signal: 'DEVICE_FIRST_USE', points: RISK_WEIGHTS.DEVICE_FIRST_USE, meaning: 'The device is enrolled but has never carried a request' },
      { signal: 'HIGH_VALUE', points: RISK_WEIGHTS.HIGH_VALUE, meaning: 'The act commits money past the tenancy threshold' },
      { signal: 'IRREVERSIBLE', points: RISK_WEIGHTS.IRREVERSIBLE, meaning: 'The act cannot be undone from inside the platform' },
      { signal: 'GOVERNANCE', points: RISK_WEIGHTS.GOVERNANCE, meaning: 'The act changes who may do what' },
      { signal: 'MACHINE_CREDENTIAL', points: RISK_WEIGHTS.MACHINE_CREDENTIAL, meaning: 'An API key is acting, and cannot perform a second factor' },
    ],
  };
}
