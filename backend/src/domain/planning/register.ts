import type { EngineContext } from '../../engines/context.ts';
import {
  APPLICATION_EVENTS,
  APPLICATION_ROUTES,
  applications,
  evidenceCatalogue,
  MATTERS,
  outstandingMatters,
  packs,
  packStaleness,
  requirements,
  today,
} from './applications.ts';
import { conditionRequests, conditions, consents, INSTRUMENTS, lineage, OBLIGATION_TRIGGERS, obligations, TRIGGERS } from './consents.ts';
import { gateRegister, OPERATIONS } from './gates.ts';
import { guard } from './planning.ts';
import { STUDY_TEMPLATES, studiesForRegister } from './studies.ts';

/**
 * Everything after the appraisal, in one read for the Planning screen: the
 * applications and their clocks, the requirements, the packs, the permissions
 * with their lineage, conditions and outstanding reserved matters, the
 * condition requests, the obligations, every gate where it stands, the
 * documents the reader may cite, and the closed lists the forms offer.
 */
export function planningRegister(ctx: EngineContext) {
  guard(ctx, 'R');
  const now = today();
  const days = (to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${now}T00:00:00Z`)) / 86_400_000);
  return {
    applications: applications(ctx).map((application) => {
      const due = application.extension?.agreedTo ?? application.clock?.statutoryTargetOn;
      return {
        ...application,
        clockPosition:
          application.status === 'VALID' && due
            ? { due, daysLeft: days(due), basis: application.extension ? 'agreed extension' : 'statutory period', overdue: days(due) < 0 }
            : undefined,
        landOptionDaysLeft: application.landOptionExpiresOn ? days(application.landOptionExpiresOn) : undefined,
      };
    }),
    requirements: requirements(ctx),
    packs: packs(ctx).map((pack) => ({ ...pack, stale: pack.status === 'ASSEMBLED' ? packStaleness(ctx, pack) : [] })),
    consents: consents(ctx).map((consent) => ({
      ...consent,
      lineage: lineage(ctx, consent.id).slice(1).map((entry) => ({ id: entry.id, reference: entry.reference, type: entry.type })),
      outstandingMatters:
        consent.type === 'OUTLINE' ? Object.fromEntries(consent.phases.map((phase) => [phase, outstandingMatters(ctx, consent.id, phase)])) : undefined,
      conditions: conditions(ctx, consent.id),
    })),
    conditionRequests: conditionRequests(ctx),
    obligations: obligations(ctx),
    gates: gateRegister(ctx),
    studies: studiesForRegister(ctx),
    evidence: evidenceCatalogue(ctx),
    vocabulary: {
      routes: APPLICATION_ROUTES,
      matters: MATTERS,
      events: APPLICATION_EVENTS,
      triggers: TRIGGERS,
      instruments: INSTRUMENTS,
      obligationTriggers: OBLIGATION_TRIGGERS,
      operations: OPERATIONS,
      studyTemplates: STUDY_TEMPLATES,
    },
  };
}
