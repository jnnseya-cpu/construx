import { config } from '../config.ts';
import { queue } from '../notifications/outbox.ts';
import { replayProject } from '../goldenthread/replay.ts';
import type { Platform } from '../platform.ts';

/**
 * Verifying the chain before somebody has to rely on it.
 *
 * The Golden Thread's whole promise is that the record can be proved years
 * later. `replayProject` already recomputes every state hash and every chain
 * link and reports what does not verify — the verification has existed since the
 * ledger did.
 *
 * What did not exist was anything that **runs** it. Verification happened at
 * boot, on restore, and on demand when somebody opened an audit export. So the
 * moment a divergence could realistically be discovered was during a dispute,
 * by the person least able to do anything about it, in front of the people it
 * was going to be shown to.
 *
 * This runs it in the background, continuously, and raises a **critical** alert
 * on the first divergence rather than the first query.
 *
 * ## Why a sample, and why it is honest about being one
 *
 * A full verification of every project on every pass is O(all events) and grows
 * without bound; on a mature estate it would consume the process. So each pass
 * verifies a slice, and the slice moves — every project is reached in turn, and
 * the position is reported so an operator can see how long a full sweep takes
 * rather than assuming it is instant.
 *
 * The number that matters is therefore **coverage over time**, not per pass, and
 * `assurancePosition` reports exactly that: when each project was last verified,
 * and which have never been.
 *
 * ## What it does not do
 *
 * It does not repair. A divergence in an append-only hash chain cannot be
 * repaired — that is the point of it — and a process that "fixed" a chain would
 * be indistinguishable from the tampering it exists to detect. It records, it
 * alerts, and it stops.
 */

export type ProjectAssurance = {
  projectId: string;
  tenantId: string;
  verifiedAt: string;
  events: number;
  /**
   * Events the chain vouches for whose recorded state hash is not the hash of
   * their own patched state. Not a divergence: the event is the one written,
   * and its writer's arithmetic is what disagrees. Counted so the screen can
   * say so rather than hide it inside "intact".
   */
  discrepancies?: number;
  /** Every event verified against its own hashes and its predecessor. */
  intact: boolean;
  /** What failed, where anything did. Empty on an intact chain. */
  divergences: Array<{ eventId: string; reason: string }>;
  /** The head of the chain at the moment it was verified. */
  rootHash?: string;
  durationMs: number;
};

export type AssuranceReport = {
  at: string;
  /** Projects looked at on this pass. */
  checked: number;
  intact: number;
  diverged: string[];
  /** Projects that exist and have never been verified. */
  neverVerified: number;
  results: ProjectAssurance[];
};

export type AssurancePosition = {
  enabled: boolean;
  intervalSeconds: number;
  perPass: number;
  /** Every project, and when its chain was last proved. */
  projects: Array<{
    projectId: string;
    tenantId: string;
    lastVerifiedAt?: string;
    intact?: boolean;
    events?: number;
    rootHash?: string;
  }>;
  /** Projects whose chain has diverged. Non-empty is a platform emergency. */
  diverged: ProjectAssurance[];
  /** How long a full sweep of the estate takes at this rate, in passes. */
  passesForFullSweep: number;
  lastPassAt?: string;
};

/** Last known state per project. Rebuilt naturally; nothing depends on it surviving. */
const verified = new Map<string, ProjectAssurance>();
/** Where the rotating slice starts next. */
let cursor = 0;
let lastPassAt: string | undefined;
let timer: NodeJS.Timeout | undefined;

function allProjects(platform: Platform): Array<{ projectId: string; tenantId: string }> {
  // Boot-style read: this is platform machinery reasoning about every tenancy's
  // chain, not a request serving one of them.
  return platform.ledger
    .entitiesOfType('Project')
    .map((record) => ({ projectId: record.projectId, tenantId: record.tenantId }))
    .sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
}

/**
 * Verify one project's chain, end to end.
 *
 * Uses `replayProject` rather than a second verification of its own. Two
 * implementations of "is this chain intact" would eventually disagree, and the
 * one that disagreed quietly would be this one.
 */
export function verifyProject(platform: Platform, tenantId: string, projectId: string): ProjectAssurance {
  const started = Date.now();
  const asAt = new Date().toISOString();

  const report = replayProject(platform.ledger, tenantId, projectId, asAt);
  const divergences = (report.failures ?? []).map((failure) => ({
    eventId: failure.eventId,
    reason: failure.detail ?? `${failure.status} on ${failure.entity.refType} ${failure.entity.refId}`,
  }));

  const result: ProjectAssurance = {
    projectId,
    tenantId,
    verifiedAt: asAt,
    events: report.eventsReplayed,
    intact: divergences.length === 0,
    discrepancies: report.discrepancies.length,
    divergences,
    rootHash: report.rootHash,
    durationMs: Date.now() - started,
  };

  verified.set(projectId, result);
  return result;
}

/**
 * Verify the next slice.
 *
 * Exported so an operator can force a pass rather than waiting for the
 * interval, and so a test can drive it without a timer.
 */
export function sweep(platform: Platform, perPass = config.assurance.projectsPerPass): AssuranceReport {
  const projects = allProjects(platform);
  const at = new Date().toISOString();
  lastPassAt = at;

  if (projects.length === 0) {
    return { at, checked: 0, intact: 0, diverged: [], neverVerified: 0, results: [] };
  }

  const results: ProjectAssurance[] = [];
  const take = Math.max(1, Math.min(perPass, projects.length));

  for (let index = 0; index < take; index += 1) {
    const project = projects[(cursor + index) % projects.length]!;
    try {
      results.push(verifyProject(platform, project.tenantId, project.projectId));
    } catch (error) {
      // A verification that itself throws is a finding, not a skip. Recording
      // it as intact would be the single worst thing this module could do.
      results.push({
        projectId: project.projectId,
        tenantId: project.tenantId,
        verifiedAt: at,
        events: 0,
        intact: false,
        divergences: [
          {
            eventId: 'n/a',
            reason: `The verification itself failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        durationMs: 0,
      });
    }
  }

  cursor = (cursor + take) % projects.length;

  const diverged = results.filter((result) => !result.intact);

  // Told once per divergence, through the outbox, so an alert survives the
  // process dying — which is exactly the circumstance a chain divergence is
  // most likely to be found in.
  for (const failure of diverged) {
    notify(platform, failure);
  }

  return {
    at,
    checked: results.length,
    intact: results.filter((result) => result.intact).length,
    diverged: diverged.map((result) => result.projectId),
    neverVerified: projects.filter((project) => !verified.has(project.projectId)).length,
    results,
  };
}

function notify(platform: Platform, failure: ProjectAssurance): void {
  const operators = platform.operators();
  if (operators.length === 0) return;

  try {
    queue(platform, {
      code: 'system.chain_divergence',
      // `platform` rather than the operator's own tenancy, matching the watch
      // alerts: this is the platform speaking about itself, not a record
      // belonging to any customer.
      recipients: operators.map((operator) => ({
        id: operator.id,
        tenantId: 'platform',
        name: operator.name,
        email: operator.email,
      })),
      payload: {
        projectId: failure.projectId,
        events: failure.events,
        divergences: failure.divergences.length,
        first: failure.divergences[0]?.reason ?? '',
      },
      // The platform's own branding, as the watch alerts use. A chain
      // divergence notice carrying a customer's logo would read as their
      // problem when it is the platform's.
      branding: {
        clientName: 'CONSTRUX',
        primaryColour: '#ff6600',
        documentReferencePrefix: 'CXA',
        legalFooter: 'CONSTRUX — platform operations',
      },
      actorId: 'system:assurance',
      correlationId: `assurance-${failure.projectId}-${failure.verifiedAt}`,
    });
  } catch {
    // A notification that cannot be queued must not stop the sweep. The
    // divergence is already recorded in `verified` and shown on the position;
    // losing the sweep as well would turn one problem into two.
  }
}

export function assurancePosition(platform: Platform): AssurancePosition {
  const projects = allProjects(platform);
  const perPass = Math.max(1, config.assurance.projectsPerPass);

  return {
    enabled: config.assurance.enabled,
    intervalSeconds: config.assurance.intervalSeconds,
    perPass,
    projects: projects.map((project) => {
      const last = verified.get(project.projectId);
      return {
        projectId: project.projectId,
        tenantId: project.tenantId,
        lastVerifiedAt: last?.verifiedAt,
        intact: last?.intact,
        events: last?.events,
        rootHash: last?.rootHash,
      };
    }),
    diverged: [...verified.values()].filter((result) => !result.intact),
    // Stated rather than left to be worked out. "Verified continuously" means
    // nothing without knowing how long a full circuit takes.
    passesForFullSweep: Math.ceil(projects.length / perPass),
    lastPassAt,
  };
}

export function startAssurance(platform: Platform): NodeJS.Timeout | undefined {
  if (!config.assurance.enabled || timer) return timer;

  timer = setInterval(() => {
    try {
      sweep(platform);
    } catch {
      // The interval must survive a pass that failed, or one bad project stops
      // the platform verifying anything ever again.
    }
  }, config.assurance.intervalSeconds * 1_000);

  timer.unref();
  return timer;
}

export function stopAssurance(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** Test isolation only. */
export function resetAssurance(): void {
  verified.clear();
  cursor = 0;
  lastPassAt = undefined;
  stopAssurance();
}
