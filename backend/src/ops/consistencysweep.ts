import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import * as consistency from '../domain/consistency.ts';
import type { AuthContext } from '../identity/auth.ts';
import { scopesForRoles } from '../identity/scopes.ts';
import * as notifyEngine from '../notifications/notify.ts';
import { PLATFORM_TENANT_ID, type Platform } from '../platform.ts';

/**
 * The chain-break sweep: escalation for projects nobody opens.
 *
 * `consistency.escalateChainBreaks` raises an exception to the Commercial
 * Manager when the bid-to-CVR data flow breaks — a commitment against a
 * subcontract that does not exist, an application against no payment cycle.
 * It ran when somebody asked: from the console, or by calling the route. A
 * break on a project nobody had open was detected the next time somebody
 * looked, which on a quiet project is never.
 *
 * This runs the same escalation on a timer, for every open project of every
 * customer tenancy, under a system actor that holds the read authority the
 * escalation demands and nothing more. The escalation itself is idempotent —
 * a break already carrying an open exception is not raised again, and a
 * cleared link closes its exception — so the sweep can run hourly without a
 * project accumulating duplicate alarms. Every exception it raises is notified
 * to the roles that own the commercial position exactly as the route does,
 * and is recorded on the project's chain under the sweep's own name.
 *
 * What the sweep deliberately does not do: touch the platform's own tenancy
 * (it has no commercial chain), a closed tenancy (the record is read-only), or
 * a tenancy whose standing refuses writes — those are skipped and the skip is
 * named on the position, never silently.
 */

export const SWEEP_ACTOR = 'system:consistency-sweep';

export type SweepRaised = { tenantId: string; projectId: string; check: string; exposureMinor?: number };
export type SweepSkip = { tenantId: string; projectId: string; because: string };

export type SweepOutcome = {
  at: string;
  durationMs: number;
  projectsChecked: number;
  raised: SweepRaised[];
  alreadyOpen: number;
  cleared: number;
  notified: number;
  skipped: SweepSkip[];
};

export type SweepPosition = {
  enabled: boolean;
  intervalMinutes: number;
  last?: SweepOutcome;
  /** Every open exception on the estate right now, from the record. */
  openExceptions: number;
};

let timer: NodeJS.Timeout | undefined;
let last: SweepOutcome | undefined;

/** Open projects on customer tenancies. Platform machinery, so a boot-style read. */
function customerProjects(platform: Platform): Array<{ projectId: string; tenantId: string }> {
  return platform.ledger
    .entitiesOfType('Project')
    .filter((record) => record.tenantId !== PLATFORM_TENANT_ID)
    .map((record) => ({ projectId: record.projectId, tenantId: record.tenantId }))
    .sort((a, b) => (a.projectId < b.projectId ? -1 : 1));
}

/**
 * The sweep's own identity on a tenancy.
 *
 * A Commercial Manager's read authority, because that is what the escalation
 * authorises against, and the role the exception exists for. No party, no
 * device, no refresh: it is not a session and cannot become one.
 */
function sweepAuth(tenantId: string): AuthContext {
  return {
    actorId: SWEEP_ACTOR,
    tenantId,
    roles: ['COMMERCIAL_MANAGER'],
    // The scopes that role's own token would carry, and no others: the scope
    // gate is enforced on the sweep exactly as on a session.
    scopes: scopesForRoles(['COMMERCIAL_MANAGER']),
    tokenId: `sweep-${ulid()}`,
    mfaSatisfied: true,
    regulatorAiEnabled: false,
    expiresAt: Math.floor(Date.now() / 1000) + 60,
  };
}

/** Run the escalation over every customer project once. */
export async function sweepChainBreaks(platform: Platform): Promise<SweepOutcome> {
  const started = Date.now();
  const outcome: SweepOutcome = {
    at: new Date().toISOString(),
    durationMs: 0,
    projectsChecked: 0,
    raised: [],
    alreadyOpen: 0,
    cleared: 0,
    notified: 0,
    skipped: [],
  };

  for (const { projectId, tenantId } of customerProjects(platform)) {
    const tenant = platform.tenants().find((candidate) => candidate.id === tenantId);
    if (!tenant) continue;
    if (tenant.closedAt) {
      outcome.skipped.push({ tenantId, projectId, because: 'tenancy closed — the record is read-only' });
      continue;
    }

    try {
      const base = platform.context(sweepAuth(tenantId), projectId, { source: 'SYSTEM', correlationId: `sweep-${outcome.at}` });
      // Recorded as the sweep, not as a person: an exception raised at 03:00 by
      // nobody must say so on the chain.
      const ctx = { ...base, actingAs: { refType: 'System', refId: SWEEP_ACTOR } as const };
      const escalation = consistency.escalateChainBreaks(ctx);
      outcome.projectsChecked += 1;
      outcome.alreadyOpen += escalation.alreadyOpen.length;
      outcome.cleared += escalation.cleared.length;

      for (const exception of escalation.raised) {
        outcome.raised.push({ tenantId, projectId, check: exception.check, exposureMinor: exception.exposureMinor });
        const recipients = platform
          .users(tenantId)
          .filter((user) => user.roles.some((role) => (consistency.CHAIN_EXCEPTION_ROLES as readonly string[]).includes(role)))
          .map((user) => ({ id: user.id, name: user.name, email: user.email, tenantId: user.tenantId }));
        if (recipients.length === 0) continue;

        await notifyEngine.notify(platform, {
          code: 'commercial.chain_broken',
          recipients,
          payload: {
            project: projectId,
            item: exception.check,
            actionUrl: `/app/#/projects/${projectId}/consistency`,
            actionLabel: 'Open the commercial position',
            detail: `${exception.finding} ${exception.consequence}`,
          },
          branding: platform.exports.branding(tenantId, projectId),
          actorId: SWEEP_ACTOR,
          correlationId: ctx.correlationId,
        });
        outcome.notified += recipients.length;
      }
    } catch (error) {
      // A tenancy whose standing refuses writes, a project with no commercial
      // record yet: named, not hidden, and the next project is still checked.
      const because = error instanceof DomainError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : String(error);
      outcome.skipped.push({ tenantId, projectId, because });
    }
  }

  outcome.durationMs = Date.now() - started;
  last = outcome;
  return outcome;
}

export function sweepPosition(platform: Platform): SweepPosition {
  const openExceptions = platform.ledger
    .entitiesOfType('ChainException')
    .filter((record) => record.state.status === 'OPEN').length;
  return {
    enabled: config.ops.consistencySweepMinutes > 0,
    intervalMinutes: config.ops.consistencySweepMinutes,
    ...(last ? { last } : {}),
    openExceptions,
  };
}

/** Test isolation only. A deployment never forgets its last pass. */
export function resetSweep(): void {
  last = undefined;
}

export function startConsistencySweep(platform: Platform): NodeJS.Timeout | undefined {
  if (config.ops.consistencySweepMinutes <= 0 || timer) return timer;
  timer = setInterval(() => {
    void sweepChainBreaks(platform).catch(() => undefined);
  }, config.ops.consistencySweepMinutes * 60_000);
  timer.unref();
  return timer;
}

export function stopConsistencySweep(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
