import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { SERVICE_FAMILIES } from './brief.ts';
import { statutoryWcs } from '../../engines/maths/demand.ts';
import type { ServiceSystem } from './composer.ts';

/**
 * §12 — demobilisation and reinstatement.
 *
 * **"The Demobilisation Agent begins at design."** Not at the end. Every
 * temporary asset and enabling work must have an owner, a removal method, a
 * trigger, a cost, a waste route and a reinstatement criterion *before it is
 * installed*, because the moment to agree who breaks out a concrete
 * hardstanding is the moment before it is poured, when somebody still wants
 * something from you.
 *
 * Closeout is planned backwards from land, customer and permanent-works
 * acceptance. So the seven workstreams here each carry the acceptance evidence
 * they close on, and a workstream cannot be closed on a narrative.
 *
 * ## The one refusal that matters
 *
 * §12's first workstream says it plainly: *prevent premature loss of statutory
 * welfare*. Demobilisation is the phase where somebody removes the last WCs
 * because the compound is "finishing", and there are still forty people on
 * site. So a demand run-down that would take provision below the statutory
 * minimum for the people still there is **refused**, with the arithmetic in the
 * refusal — the same `statutoryWcs` table §4 sizes the welfare from, used in
 * reverse.
 *
 * That is the whole reason this is a domain module rather than a checklist.
 */

export const WORKSTREAMS = [
  {
    id: 'DEMAND_RUNDOWN',
    label: 'Demand run-down',
    controls:
      'Forecast last use by zone, consolidate facilities, and prevent premature loss of statutory welfare.',
    acceptance: 'Approved phase release and a successor service actually available.',
  },
  {
    id: 'ASSET_REMOVAL',
    label: 'Asset isolation and removal',
    controls:
      'Asset register, ownership, condition, utility isolation, lifting and transport, off-hire and return.',
    acceptance: 'Isolation and test record, collection note, return condition and financial close.',
  },
  {
    id: 'TEMPORARY_CIVILS',
    label: 'Temporary civils',
    controls:
      'Remove foundations, hardstanding, drainage and routes as required, and manage material reuse and waste.',
    acceptance: 'Survey, tickets, compaction, soil and landscape evidence, and an as-left plan.',
  },
  {
    id: 'UTILITIES_ENVIRONMENT',
    label: 'Utilities and environment',
    controls: 'Cap or remove services, clean tanks, control discharge and waste, respond to contamination.',
    acceptance: 'Permits closed, samples, consignment notes, and a meter and fuel reconciliation.',
  },
  {
    id: 'ACCOMMODATION_CLOSE',
    label: 'Accommodation close',
    controls: 'Room inventory, damage, linen and consumables, occupancy, and deposit or liability reconciliation.',
    acceptance: 'Room and block acceptance, and a dispute log.',
  },
  {
    id: 'FINAL_ACCOUNT',
    label: 'Final account',
    controls: 'Off-hire, accrual, retention, claims, credits, damages and residual obligations.',
    acceptance: 'An agreed final account, or a documented register of what is still open.',
  },
  {
    id: 'KNOWLEDGE_CLOSE',
    label: 'Knowledge close',
    controls: 'Final supplier score, benchmark, failure modes, lessons and reusable rules.',
    acceptance: 'Customer-confidential data segregated, and only approved anonymised learning promoted.',
  },
] as const;

export type WorkstreamId = (typeof WORKSTREAMS)[number]['id'];
const WORKSTREAM_BY_ID = new Map(WORKSTREAMS.map((entry) => [entry.id, entry]));

/**
 * The removal plan §12 says must exist at design.
 *
 * Six fields, and every one of them is a thing that becomes an argument if it
 * is agreed at the end instead of at the start.
 */
export type RemovalPlan = {
  id: string;
  projectId: string;
  systemId: string;
  /** Who physically does it. A firm, not a function. */
  owner: string;
  /** How. "Removed" is not a method; "broken out to 300mm and carted" is. */
  method: string;
  /** What starts it. A date, a milestone or a successor being ready. */
  trigger: string;
  /** What it costs. Agreed at design, when somebody still wants something. */
  costMinor: number;
  currency: string;
  /** Where the material goes. A licensed route, not "off site". */
  wasteRoute: string;
  /** The condition the land or the asset is returned in, against what record. */
  reinstatementCriterion: string;
  agreedBy: string;
  agreedAt: string;
};

export type WorkstreamStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'ACCEPTED';

export type DemobilisationRecord = {
  id: string;
  projectId: string;
  workstream: WorkstreamId;
  systemId?: string;
  status: WorkstreamStatus;
  /** What has actually been produced against the acceptance requirement. */
  evidence: { reference: string; description: string; recordedBy: string; recordedAt: string }[];
  acceptedBy?: string;
  acceptedAt?: string;
  acceptanceNote?: string;
  openedBy: string;
  openedAt: string;
};

/** The occupancy position a run-down is proposed against. */
export type RunDown = {
  id: string;
  projectId: string;
  systemId: string;
  /** People still on site in the zone after the run-down. */
  remainingPersons: number;
  /** WCs the zone will still have. */
  remainingWcs: number;
  effectiveFrom: string;
  /** The successor facility, where the provision moves rather than goes. */
  successor?: string;
  basis: string;
  proposedBy: string;
  proposedAt: string;
};

// --- Reading -------------------------------------------------------------------------

function systemsOf(ctx: EngineContext): ServiceSystem[] {
  return ctx.ledger.list(ctx.projectId, 'ServiceSystem').map((record) => record.state as unknown as ServiceSystem);
}

function systemOf(ctx: EngineContext, systemId: string): ServiceSystem {
  const found = systemsOf(ctx).find((entry) => entry.id === systemId);
  if (!found) throw new DomainError('SERVICE_SYSTEM_NOT_FOUND', 'No such composed system on this project', 404);
  return found;
}

function plansOf(ctx: EngineContext): RemovalPlan[] {
  return ctx.ledger.list(ctx.projectId, 'RemovalPlan').map((record) => record.state as unknown as RemovalPlan);
}

function recordsOf(ctx: EngineContext): DemobilisationRecord[] {
  return ctx.ledger
    .list(ctx.projectId, 'DemobilisationRecord')
    .map((record) => record.state as unknown as DemobilisationRecord);
}

function isDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

// --- The removal plan, agreed at design -------------------------------------------------

export function agreeRemovalPlan(
  ctx: EngineContext,
  input: {
    systemId: string;
    owner: string;
    method: string;
    trigger: string;
    costMinor: number;
    currency?: string;
    wasteRoute: string;
    reinstatementCriterion: string;
  },
): RemovalPlan {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const system = systemOf(ctx, input.systemId);
  const missing: string[] = [];
  if (!input.owner?.trim()) missing.push('an owner — a firm, not a function');
  if (!input.method?.trim()) missing.push('a removal method — "removed" is not a method');
  if (!input.trigger?.trim()) missing.push('a trigger — a date, a milestone or a successor being ready');
  if (!input.wasteRoute?.trim()) missing.push('a waste route — a licensed destination, not "off site"');
  if (!input.reinstatementCriterion?.trim()) missing.push('a reinstatement criterion, and the record it is measured against');
  if (missing.length > 0) {
    throw new DomainError(
      'REMOVAL_PLAN_INCOMPLETE',
      `${system.label} has no removal plan yet: it needs ${missing.join('; ')}. Every one of those becomes an argument if it is agreed at the end instead of now, when somebody still wants something from you.`,
    );
  }
  if (!Number.isFinite(input.costMinor) || input.costMinor < 0) {
    throw new DomainError(
      'REMOVAL_PLAN_UNPRICED',
      'Price the removal. Zero is a price and it is allowed — an asset the supplier collects at their own cost is genuinely free to remove — but absent is not, because absent becomes a cost discovered at the end when there is nothing left to negotiate with.',
    );
  }

  // A second plan supersedes the first: one system, one removal method.
  const existing = plansOf(ctx).find((entry) => entry.systemId === system.id);
  const record: RemovalPlan = {
    id: existing?.id ?? ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    owner: input.owner.trim(),
    method: input.method.trim(),
    trigger: input.trigger.trim(),
    costMinor: input.costMinor,
    currency: input.currency?.trim() || 'GBP',
    wasteRoute: input.wasteRoute.trim(),
    reinstatementCriterion: input.reinstatementCriterion.trim(),
    agreedBy: ctx.auth.actorId,
    agreedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: existing ? 'REMOVAL_PLAN_REVISED' : 'REMOVAL_PLAN_AGREED',
    entity: { refType: 'RemovalPlan', refId: record.id },
    nextState: record,
  });
  return record;
}

// --- The run-down, and the refusal that matters ------------------------------------------

/**
 * Propose a demand run-down.
 *
 * **Refused where it would take welfare below the statutory minimum for the
 * people still on site.** This is the failure §12's first workstream names, and
 * it is the one that actually happens: the compound is "finishing", the units
 * go back, and there are still forty people working.
 *
 * The arithmetic is `statutoryWcs` from §4's demand engine — the same Schedule 1
 * Table 1 the welfare was sized from, read in reverse. One table, one answer,
 * whichever direction the question is asked from.
 */
export function proposeRunDown(
  ctx: EngineContext,
  input: {
    systemId: string;
    remainingPersons: number;
    remainingWcs: number;
    effectiveFrom: string;
    successor?: string;
    basis: string;
  },
): RunDown {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const system = systemOf(ctx, input.systemId);
  if (!isDate(input.effectiveFrom)) throw new DomainError('RUNDOWN_UNDATED', 'A run-down starts on a date.');
  if (!Number.isFinite(input.remainingPersons) || input.remainingPersons < 0) {
    throw new DomainError('RUNDOWN_UNCOUNTED', 'Say how many people are still on site after this.');
  }
  if (!Number.isFinite(input.remainingWcs) || input.remainingWcs < 0) {
    throw new DomainError('RUNDOWN_UNPROVIDED', 'Say what provision remains.');
  }
  if (!input.basis?.trim()) {
    throw new DomainError(
      'RUNDOWN_UNBASED',
      'Say what the remaining headcount comes from. A run-down against a number nobody sourced is how the last WCs leave while forty people are still working.',
    );
  }

  // The one refusal that matters, and only where the family actually provides
  // welfare. Cleaning and security run down on different arithmetic.
  if (system.family === 'WELFARE_ACCOMMODATION' || system.family === 'TEMPORARY_INFRASTRUCTURE') {
    const required = statutoryWcs(input.remainingPersons);
    if (input.remainingWcs < required && !input.successor?.trim()) {
      throw new DomainError(
        'RUNDOWN_BELOW_STATUTORY',
        `${input.remainingPersons} people still on site require ${required} WCs under Schedule 1 Table 1, and this run-down leaves ${input.remainingWcs}. Demobilisation is the phase where the last units go back because the compound is "finishing" and there are still people working. Name the successor facility, or leave the provision where it is.`,
      );
    }
  }

  const record: RunDown = {
    id: ulid(),
    projectId: ctx.projectId,
    systemId: system.id,
    remainingPersons: input.remainingPersons,
    remainingWcs: input.remainingWcs,
    effectiveFrom: input.effectiveFrom.slice(0, 10),
    ...(input.successor?.trim() ? { successor: input.successor.trim() } : {}),
    basis: input.basis.trim(),
    proposedBy: ctx.auth.actorId,
    proposedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'SERVICE_RUNDOWN_PROPOSED',
    entity: { refType: 'RunDown', refId: record.id },
    nextState: record,
  });
  return record;
}

// --- The workstreams ----------------------------------------------------------------------

export function openWorkstream(
  ctx: EngineContext,
  input: { workstream: string; systemId?: string },
): DemobilisationRecord {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const workstream = WORKSTREAM_BY_ID.get(input.workstream as WorkstreamId);
  if (!workstream) {
    throw new DomainError('DEMOB_WORKSTREAM_UNKNOWN', `${input.workstream} is not one of the seven workstreams`, 404);
  }
  if (input.systemId) systemOf(ctx, input.systemId);

  const existing = recordsOf(ctx).find(
    (entry) => entry.workstream === workstream.id && entry.systemId === input.systemId,
  );
  if (existing) return existing;

  const at = new Date().toISOString();
  const record: DemobilisationRecord = {
    id: ulid(),
    projectId: ctx.projectId,
    workstream: workstream.id,
    ...(input.systemId ? { systemId: input.systemId } : {}),
    status: 'IN_PROGRESS',
    evidence: [],
    openedBy: ctx.auth.actorId,
    openedAt: at,
  };
  write(ctx, {
    eventType: 'DEMOBILISATION_OPENED',
    entity: { refType: 'DemobilisationRecord', refId: record.id },
    nextState: record,
  });
  return record;
}

export function recordDemobEvidence(
  ctx: EngineContext,
  input: { recordId: string; reference: string; description: string },
): DemobilisationRecord {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'C');

  const record = recordsOf(ctx).find((entry) => entry.id === input.recordId);
  if (!record) throw new DomainError('DEMOB_RECORD_NOT_FOUND', 'No such demobilisation record', 404);
  if (record.status === 'ACCEPTED') {
    throw new DomainError(
      'DEMOB_ALREADY_ACCEPTED',
      'That workstream is accepted. Evidence added afterwards is evidence for a dispute rather than for the acceptance.',
    );
  }
  if (!input.reference?.trim() || !input.description?.trim()) {
    throw new DomainError(
      'DEMOB_EVIDENCE_UNREFERENCED',
      'Evidence is a reference and what it shows — the consignment note number and what it consigned, the survey and what it surveyed.',
    );
  }

  const updated: DemobilisationRecord = {
    ...record,
    evidence: [
      ...record.evidence,
      {
        reference: input.reference.trim(),
        description: input.description.trim(),
        recordedBy: ctx.auth.actorId,
        recordedAt: new Date().toISOString(),
      },
    ],
  };
  write(ctx, {
    eventType: 'DEMOBILISATION_EVIDENCED',
    entity: { refType: 'DemobilisationRecord', refId: record.id },
    nextState: updated,
  });
  return updated;
}

/**
 * Accept a workstream.
 *
 * Refused on a narrative. Each workstream declares the acceptance evidence it
 * closes on, and a closeout accepted without it is a closeout that reopens when
 * the landowner walks the site.
 *
 * The demand run-down additionally refuses acceptance while no run-down has
 * been proposed at all — closing that workstream on nothing is closing it on
 * the assumption that everybody left.
 */
export function acceptWorkstream(
  ctx: EngineContext,
  input: { recordId: string; note: string },
): DemobilisationRecord {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'A');

  const record = recordsOf(ctx).find((entry) => entry.id === input.recordId);
  if (!record) throw new DomainError('DEMOB_RECORD_NOT_FOUND', 'No such demobilisation record', 404);
  if (record.status === 'ACCEPTED') return record;

  const workstream = WORKSTREAM_BY_ID.get(record.workstream)!;
  if (!input.note?.trim()) {
    throw new DomainError('DEMOB_ACCEPTANCE_UNEXPLAINED', 'Say what is being accepted.');
  }
  if (record.evidence.length === 0) {
    throw new DomainError(
      'DEMOB_ACCEPTANCE_UNEVIDENCED',
      `${workstream.label} closes on: ${workstream.acceptance} Nothing has been recorded against it, and a closeout accepted on a narrative reopens the day the landowner walks the site.`,
    );
  }
  if (record.workstream === 'DEMAND_RUNDOWN') {
    const rundowns = ctx.ledger.list(ctx.projectId, 'RunDown');
    if (rundowns.length === 0) {
      throw new DomainError(
        'DEMOB_RUNDOWN_UNPLANNED',
        'No run-down has been proposed. Accepting the demand run-down on nothing accepts the assumption that everybody left, which is the assumption that removes the last WCs from under forty people.',
      );
    }
  }
  if (record.workstream === 'ASSET_REMOVAL' && record.systemId) {
    const plan = plansOf(ctx).find((entry) => entry.systemId === record.systemId);
    if (!plan) {
      throw new DomainError(
        'DEMOB_REMOVAL_UNPLANNED',
        'No removal plan was ever agreed for this system. Accepting its removal now accepts whatever was done, at whatever cost, to whatever standard — which is the position the plan exists to avoid.',
      );
    }
  }

  const updated: DemobilisationRecord = {
    ...record,
    status: 'ACCEPTED',
    acceptedBy: ctx.auth.actorId,
    acceptedAt: new Date().toISOString(),
    acceptanceNote: input.note.trim(),
  };
  write(ctx, {
    eventType: 'DEMOBILISATION_ACCEPTED',
    entity: { refType: 'DemobilisationRecord', refId: record.id },
    nextState: updated,
  });
  return updated;
}

// --- The position ---------------------------------------------------------------------------

export type DemobilisationPosition = {
  workstreams: {
    id: WorkstreamId;
    label: string;
    controls: string;
    acceptance: string;
    records: (DemobilisationRecord & { systemLabel?: string })[];
    accepted: number;
    open: number;
  }[];
  /** Every composed system, and whether it has a removal plan yet. */
  plans: {
    systemId: string;
    label: string;
    zone: string;
    family: string;
    familyLabel: string;
    plan?: RemovalPlan;
    /** What §4 said the removal obligation was, from the composed system. */
    obligation: string;
  }[];
  runDowns: (RunDown & { label: string; requiredWcs: number; belowStatutory: boolean })[];
  /** Total agreed removal cost. Known at design rather than discovered at the end. */
  removalCostMinor: number;
  unplanned: number;
  statement: string;
};

export function demobilisationPosition(ctx: EngineContext): DemobilisationPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const systems = systemsOf(ctx);
  const plans = plansOf(ctx);
  const records = recordsOf(ctx);
  const runDowns = ctx.ledger.list(ctx.projectId, 'RunDown').map((entry) => entry.state as unknown as RunDown);

  const planned = systems.map((system) => {
    const plan = plans.find((entry) => entry.systemId === system.id);
    return {
      systemId: system.id,
      label: system.label,
      zone: system.zone,
      family: system.family as string,
      familyLabel: SERVICE_FAMILIES[system.family].label,
      ...(plan ? { plan } : {}),
      obligation: system.removalObligation,
    };
  });

  const unplanned = planned.filter((entry) => !entry.plan).length;

  return {
    workstreams: WORKSTREAMS.map((workstream) => {
      const mine = records
        .filter((entry) => entry.workstream === workstream.id)
        .map((entry) => ({
          ...entry,
          ...(entry.systemId
            ? { systemLabel: systems.find((system) => system.id === entry.systemId)?.label }
            : {}),
        }));
      return {
        id: workstream.id,
        label: workstream.label,
        controls: workstream.controls,
        acceptance: workstream.acceptance,
        records: mine,
        accepted: mine.filter((entry) => entry.status === 'ACCEPTED').length,
        open: mine.filter((entry) => entry.status !== 'ACCEPTED').length,
      };
    }),
    plans: planned,
    runDowns: runDowns.map((entry) => {
      const required = statutoryWcs(entry.remainingPersons);
      return {
        ...entry,
        label: systems.find((system) => system.id === entry.systemId)?.label ?? entry.systemId,
        requiredWcs: required,
        belowStatutory: entry.remainingWcs < required,
      };
    }),
    removalCostMinor: plans.reduce((sum, entry) => sum + entry.costMinor, 0),
    unplanned,
    statement:
      systems.length === 0
        ? 'Nothing is composed, so there is nothing to remove. Demobilisation begins at design, and the design has not started.'
        : unplanned > 0
          ? `${unplanned} of ${systems.length} composed systems have no removal plan. Every one of the six fields a plan carries becomes an argument if it is agreed at the end instead of now, when somebody still wants something from you.`
          : `Every composed system has a removal plan, at an agreed ${(
              plans.reduce((sum, entry) => sum + entry.costMinor, 0) / 100
            ).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} to remove. Known at design rather than discovered at the end.`,
  };
}
