import { BRIEF_ITEMS, SERVICE_FAMILIES, briefConflicts, type BriefConflict, type ServiceFamily } from '../domain/etablix/brief.ts';
import { briefReadiness } from '../domain/etablix/brief.ts';
import { CONTROL_POINTS, profileFor } from '../domain/etablix/appointment.ts';
import type { EngineContext } from '../engines/context.ts';
import type { AgentDefinition, AgentOutput, Finding } from './types.ts';

/**
 * The sixteen ETABLIX specialists.
 *
 * §5 of the site-services specification. Sixteen named agents, each owning one
 * question, and the product mandate they exist to serve: **automate at least
 * 90% of the repeatable coordination, analysis, documentation, monitoring and
 * administration work, while retaining explicit human authority over legal
 * commitment, safety-critical acceptance, supplier award, payment certification
 * and contingency release.**
 *
 * ---
 *
 * ## Built on the fleet that already exists, not beside it
 *
 * `agents/runtime.ts` is already a governed agent framework — mandate,
 * autonomy ladder, confidence floor, ACU tier, trigger routing, proposal queue,
 * approval by a named role, and the rule that an agent never writes project
 * state. None of that is rebuilt. These are sixteen `AgentDefinition`s in the
 * same registry, so the ETABLIX fleet is governed by the same machinery as
 * everything else and appears in the same manifest, the same autopilot queue
 * and the same audit trail.
 *
 * They carry one thing no CONSTRUX agent does: `module: 'ETABLIX'`. The runtime
 * refuses to run them for a tenancy without the grant, which is the same gate
 * every module route carries, applied to the one caller that acts unattended.
 *
 * ## The automation boundary, in the ladder that already enforces it
 *
 * The specification's three classes map onto the existing `maxUnattended`
 * ladder exactly, which is why no new mechanism is needed:
 *
 * | Spec class | What it means | Ladder level |
 * |---|---|---|
 * | A — autonomous | Execute, record and notify inside an approved baseline | `ACT`, inside a granted envelope |
 * | B — supervised | Prepare the decision; a role approves; then execute | `PROPOSE` |
 * | C — human-controlled | AI advises only; a named authority decides | `OBSERVE` or `DRAFT` |
 *
 * **No agent here exceeds `PROPOSE`.** Supplier award, contract signature,
 * safety-critical energisation, payment certification, contingency draw,
 * termination and regulatory submission are Class C in the specification and
 * `neverDelegated` on every appointment profile. An agent may prepare any of
 * them and may take none.
 *
 * ## One problem, one agent
 *
 * The obvious failure of a sixteen-agent fleet is five of them reporting the
 * same contradiction from five angles, which trains everybody to stop reading
 * all five. So the cross-checks live in `domain/etablix/brief.ts`, each tagged
 * with the service families it sits between, and **each agent reports only the
 * conflicts belonging to its own family.** One source of arithmetic, sixteen
 * owners, no duplicates — and a check added there appears under its owner
 * without anybody wiring it up.
 */

const empty: AgentOutput = { findings: [], proposals: [] };

/**
 * The conflicts belonging to one family, as findings.
 *
 * Severity carries through from the check rather than being decided here: the
 * arithmetic knows whether a shortfall stops the site on day one or degrades
 * over weeks, and an agent re-grading it would be a second opinion about its
 * own input.
 */
function conflictFindings(ctx: EngineContext, family: ServiceFamily, prefix: string): Finding[] {
  let conflicts: BriefConflict[];
  try {
    conflicts = briefConflicts(ctx);
  } catch {
    // The module gate, or a project with no site-services record at all.
    // Nothing to say rather than an error: an agent that cannot read its own
    // subject has not found a problem, it has found nothing.
    return [];
  }

  return conflicts
    .filter((conflict) => conflict.families.includes(family))
    .map((conflict) => ({
      key: `${prefix}:${conflict.id}`,
      severity: conflict.severity === 'BLOCKING' ? ('URGENT' as const) : ('ATTENTION' as const),
      summary: conflict.statement,
      consequence: conflict.resolution,
      // Every figure in the statement came from a recorded fact, and the facts
      // for this family are what a reader needs to check the arithmetic.
      evidence: factEvidence(ctx, family),
    }));
}

function factEvidence(ctx: EngineContext, family: ServiceFamily): Finding['evidence'] {
  return ctx.ledger
    .list(ctx.projectId, 'SiteServiceFact')
    .filter((record) => {
      const state = record.state as { family?: string; supersededBy?: string };
      return state.family === family && !state.supersededBy;
    })
    .slice(0, 6)
    .map((record) => {
      const state = record.state as { itemId: string; value: unknown; unit: string; status: string };
      return {
        refType: 'SiteServiceFact',
        refId: record.refId,
        note: `${state.itemId} = ${String(state.value)} ${state.unit}${state.status === 'PROVISIONAL' ? ' (assumed)' : ''}`,
      };
    });
}

/**
 * Has anybody started site services on this project at all?
 *
 * An appointment, or a single recorded fact. Either is somebody deciding this
 * project has a site-services position; neither is the module merely being
 * granted to the company.
 */
function doingSiteServices(ctx: EngineContext): boolean {
  return (
    ctx.ledger.list(ctx.projectId, 'SiteServicesAppointment').length > 0 ||
    ctx.ledger.list(ctx.projectId, 'SiteServiceFact').length > 0
  );
}

/** Gaps in one family that nothing is standing in for. */
function unansweredIn(ctx: EngineContext, family: ServiceFamily): number {
  try {
    return briefReadiness(ctx).families.find((entry) => entry.family === family)?.missing ?? 0;
  } catch {
    return 0;
  }
}

/**
 * The shared shape of a family specialist.
 *
 * Nine of the sixteen do the same job for a different family — read the
 * cross-checks that belong to them, and say how much of their own brief is
 * still unanswered. Written once because writing it nine times would produce
 * nine slightly different versions, and the ninth would be the one with the bug.
 */
function familySpecialist(input: {
  name: string;
  agentId: string;
  family: ServiceFamily;
  purpose: string;
  inputs: string[];
  outputs: string[];
  approvers: AgentDefinition['mandate']['approvers'];
}): AgentDefinition {
  return {
    name: input.name,
    agentId: input.agentId,
    module: 'ETABLIX',
    division: 'SITE_SERVICES',
    purpose: input.purpose,
    // Every phase. Site services start before the permanent works and finish
    // after them — the compound goes up before the first pile and comes out
    // after handover — so gating these on a construction phase would switch
    // them off during the two periods they matter most.
    activeIn: 'ANY',
    triggers: [
      { kind: 'SCHEDULE', at: '06:00' },
      { kind: 'EVENT', eventType: 'SITE_SERVICE_FACT_RECORDED' },
      { kind: 'EVENT', eventType: 'SITE_SERVICE_FACT_ASSUMED' },
    ],
    inputs: input.inputs,
    outputs: input.outputs,
    emits: [],
    hitl: 'REVIEW',
    // High, because every finding these raise is arithmetic over recorded
    // figures rather than a judgement. There is nothing to be unsure about: if
    // the numbers are there, the shortfall either exists or it does not.
    confidenceFloor: 0.9,
    acuTier: 'LOW',
    memory: { reads: ['PROJECT'], writes: [] },
    mandate: {
      reads: ['SITE_SERVICES'],
      // Nothing. These agents report; the commands that follow are somebody
      // recording a fact or placing a package, and both are acts with an
      // author. An agent proposing "record this figure" would be an agent
      // inventing the figure.
      proposes: [],
      approvers: input.approvers,
      maxUnattended: 'OBSERVE',
    },
    evaluate(ctx) {
      // Nothing at all on a project that is not doing site services.
      //
      // Without this the "N unanswered" finding fires on every project in the
      // estate the moment the module is granted, because an empty brief is
      // entirely unanswered by definition — seven agents, seven findings, on a
      // job nobody has started. An agent with nothing to read has not found a
      // problem; it has found nothing.
      if (!doingSiteServices(ctx)) return empty;

      const findings = conflictFindings(ctx, input.family, input.name);
      const missing = unansweredIn(ctx, input.family);
      if (missing > 0) {
        findings.push({
          key: `${input.name}:unanswered:${missing}`,
          severity: 'ATTENTION',
          summary: `${missing} of the facts ${SERVICE_FAMILIES[input.family].label.toLowerCase()} is designed from are unanswered.`,
          consequence:
            'The demand calculations for this family cannot run, so anything quoted for it is priced against an assumption nobody has stated.',
          evidence: factEvidence(ctx, input.family),
        });
      }
      return findings.length > 0 ? { findings, proposals: [] } : empty;
    },
  };
}

// --- 1. Orchestrator ---------------------------------------------------------

/**
 * The one agent that looks across all seven families.
 *
 * Its job in the specification is to plan, delegate, resolve dependencies and
 * maintain project state, and to produce a task graph, an exception queue and a
 * **decision agenda**. The last is the one that matters to a person: not a list
 * of everything wrong, but the shortest list of decisions that would unblock the
 * most.
 */
const orchestrator: AgentDefinition = {
  name: 'etablix-orchestrator',
  agentId: 'AGT-ETX-ORCHESTRATOR',
  module: 'ETABLIX',
  division: 'SITE_SERVICES',
  purpose:
    'Holds the site-services position across all seven families and produces the decision agenda: what has to be decided next, by whom, and what stops if it is not.',
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '06:00' },
    { kind: 'EVENT', eventType: 'SITE_SERVICES_APPOINTED' },
    { kind: 'EVENT', eventType: 'SITE_SERVICES_APPOINTMENT_TRANSITIONED' },
    { kind: 'EVENT', eventType: 'SITE_SERVICE_FACT_ASSUMED' },
  ],
  inputs: ['Appointment in force', 'Brief readiness by family', 'Cross-family conflicts', 'Provisional values and their decision dates'],
  outputs: ['Decision agenda', 'Exception queue', 'Blocking-conflict count by family'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.9,
  acuTier: 'MED',
  memory: { reads: ['PROJECT'], writes: [] },
  mandate: {
    reads: ['SITE_SERVICES'],
    proposes: [],
    approvers: ['PROJECT_DIRECTOR', 'PM', 'COMMERCIAL_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    let readiness: ReturnType<typeof briefReadiness>;
    try {
      readiness = briefReadiness(ctx);
    } catch {
      return empty;
    }

    const findings: Finding[] = [];

    // The appointment first, because nothing else can be decided under an
    // appointment nobody has chosen — and every control point differs.
    const appointment = ctx.ledger.list(ctx.projectId, 'SiteServicesAppointment').at(0)?.state as
      | { model?: string; baselined?: boolean }
      | undefined;

    if (!appointment) {
      // Only worth saying once there is something to lose. On a project with no
      // site-services record at all this would fire on every job in the
      // estate — which is the classic way an agent becomes noise.
      if (readiness.facts.length > 0) {
        findings.push({
          key: 'etablix-orchestrator:no-appointment',
          severity: 'URGENT',
          summary: `${readiness.facts.length} site-services facts are recorded and no appointment model has been chosen.`,
          consequence: `Which of the ${CONTROL_POINTS.length} control points applies is undecided — including who holds the supplier contracts and who pays them. Everything priced before that is priced against a guess.`,
          evidence: [],
        });
      }
      return findings.length > 0 ? { findings, proposals: [] } : empty;
    }

    // Overdue assumptions. The specification's rule made operational: a
    // provisional value past its decision date has stopped being provisional.
    if (readiness.overdue.length > 0) {
      findings.push({
        key: `etablix-orchestrator:overdue:${readiness.overdue.length}`,
        severity: 'URGENT',
        summary: `${readiness.overdue.length} provisional value${
          readiness.overdue.length === 1 ? ' is' : 's are'
        } past the date they had to be decided by: ${readiness.overdue
          .map((gap) => `${gap.label} (${gap.owner ?? 'unowned'})`)
          .join(', ')}.`,
        consequence:
          'Each of these is now the design basis by default. Nobody chose it, and the person named against it has not been asked again.',
        evidence: [],
      });
    }

    const blocking = readiness.conflicts.filter((conflict) => conflict.severity === 'BLOCKING');
    if (blocking.length > 0) {
      findings.push({
        key: `etablix-orchestrator:blocking:${blocking.length}`,
        severity: 'URGENT',
        summary: `${blocking.length} blocking contradiction${blocking.length === 1 ? '' : 's'} across ${
          new Set(blocking.flatMap((conflict) => conflict.families)).size
        } service famil${new Set(blocking.flatMap((conflict) => conflict.families)).size === 1 ? 'y' : 'ies'}.`,
        consequence: `Each is between two figures both recorded on this project. The specialists own them: ${blocking
          .map((conflict) => conflict.id.toLowerCase().replaceAll('_', ' '))
          .join(', ')}.`,
        evidence: [],
      });
    }

    // The decision agenda: the questions whose answers are already late, or
    // which more than one family is waiting on. Not everything unanswered —
    // that is the readiness screen, and repeating it here would make this
    // agent a second copy of a table.
    const soonest = readiness.interview.filter((gap) => gap.latestAnswer !== undefined).slice(0, 3);
    if (soonest.length > 0) {
      findings.push({
        key: `etablix-orchestrator:agenda:${soonest.map((gap) => gap.itemId).join('-')}`,
        severity: 'ATTENTION',
        summary: `Next decisions, soonest first: ${soonest
          .map((gap) => `${gap.label} by ${gap.latestAnswer} (${gap.owner ?? 'unowned'})`)
          .join('; ')}.`,
        consequence: soonest.map((gap) => gap.decides).join(' '),
        evidence: [],
      });
    }

    if (!appointment.baselined && readiness.percentKnown >= 80) {
      findings.push({
        key: 'etablix-orchestrator:baseline-ready',
        severity: 'ATTENTION',
        summary: `${readiness.percentKnown}% of the brief is settled and no requirements baseline has been agreed.`,
        consequence:
          'Until it is, a change of appointment model is an ordinary correction rather than a governed commercial transition — so the moment ETABLIX takes on a supply chain there is no record of what was agreed commercially.',
        evidence: [],
      });
    }

    return findings.length > 0 ? { findings, proposals: [] } : empty;
  },
};

// --- 2. Brief Intelligence ---------------------------------------------------

const briefIntelligence: AgentDefinition = {
  name: 'etablix-brief',
  agentId: 'AGT-ETX-BRIEF',
  module: 'ETABLIX',
  division: 'SITE_SERVICES',
  purpose:
    'Extracts, challenges and versions the customer brief: what is settled, what is assumed, what is missing and what a stated figure would cost if it is wrong.',
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '06:00' },
    { kind: 'EVENT', eventType: 'SITE_SERVICE_FACT_RECORDED' },
    { kind: 'EVENT', eventType: 'REQUIREMENT_ACCEPTED' },
  ],
  inputs: ['Recorded site-service facts', 'Accepted brief requirements', 'Provisional values and their owners'],
  outputs: ['Unsourced-figure challenges', 'Assumptions with no owner', 'Facts that no requirement supports'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.9,
  acuTier: 'MED',
  memory: { reads: ['PROJECT'], writes: [] },
  mandate: {
    reads: ['SITE_SERVICES', 'PROJECT_SETUP'],
    proposes: [],
    approvers: ['PM', 'PROJECT_DIRECTOR', 'EPC'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    let readiness: ReturnType<typeof briefReadiness>;
    try {
      readiness = briefReadiness(ctx);
    } catch {
      return empty;
    }
    if (readiness.facts.length === 0) return empty;

    const findings: Finding[] = [];

    // A fact with no accepted requirement behind it. Not an error — plenty of
    // figures come from a survey or a conversation rather than a requirement —
    // but it is the set somebody should be able to see, because a number with
    // no requirement behind it is a number nobody has agreed to design to.
    const unsupported = readiness.facts.filter(
      (entry) => entry.status === 'KNOWN' && entry.requirementId === undefined,
    );
    if (unsupported.length >= 3) {
      findings.push({
        key: `etablix-brief:unsupported:${unsupported.length}`,
        severity: 'ATTENTION',
        summary: `${unsupported.length} settled figures have no accepted requirement behind them.`,
        consequence:
          'Each is traceable to a source, which is what makes it defensible, and to no obligation, which is what makes it changeable without anybody being told.',
        evidence: unsupported.slice(0, 6).map((entry) => ({
          refType: 'SiteServiceFact',
          refId: entry.id,
          note: `${entry.itemId} = ${String(entry.value)} ${entry.unit} — ${entry.source}`,
        })),
      });
    }

    // The whole brief still assumed. Distinct from the family agents' "N
    // unanswered": this is the shape where nothing is missing and nothing is
    // real, which reads as complete on any percentage that counts assumptions.
    const provisional = readiness.facts.filter((entry) => entry.status === 'PROVISIONAL');
    if (provisional.length > 0 && provisional.length >= readiness.facts.length / 2) {
      findings.push({
        key: `etablix-brief:mostly-assumed:${provisional.length}`,
        severity: 'URGENT',
        summary: `${provisional.length} of the ${readiness.facts.length} figures on this brief are assumptions rather than facts.`,
        consequence:
          'A design carried on assumptions is not a design with a margin of error — it is one whose error is unknown, because no two of these were assumed against the same evidence.',
        evidence: provisional.slice(0, 6).map((entry) => ({
          refType: 'SiteServiceFact',
          refId: entry.id,
          note: `${entry.itemId} assumed at ${String(entry.value)} ${entry.unit} — ${entry.owner ?? 'unowned'} by ${entry.decideBy ?? 'no date'}`,
        })),
      });
    }

    return findings.length > 0 ? { findings, proposals: [] } : empty;
  },
};

// --- 10. Commercial ----------------------------------------------------------

/**
 * The commercial specialist, and the only one that reads the appointment rather
 * than a service family.
 *
 * What it watches is the mismatch the specification is most worried about: an
 * appointment whose exposure and whose fee logic have come apart. A management
 * fee against principal risk is how a business is lost, and the platform knows
 * both halves.
 */
const commercial: AgentDefinition = {
  name: 'etablix-commercial',
  agentId: 'AGT-ETX-COMMERCIAL',
  module: 'ETABLIX',
  division: 'SITE_SERVICES',
  purpose:
    'Watches whether the appointment ETABLIX holds still matches the exposure it is carrying, and whether the insurance and approval limits the model requires are actually in place.',
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '07:00' },
    { kind: 'EVENT', eventType: 'SITE_SERVICES_APPOINTMENT_TRANSITIONED' },
    { kind: 'EVENT', eventType: 'SITE_SERVICES_APPOINTED' },
  ],
  inputs: ['Appointment in force', 'Model fit assessment', 'Integration price and reserve position'],
  outputs: ['Exposure-against-fee check', 'Insurance the model requires', 'Transitions with no commercial basis'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.9,
  acuTier: 'MED',
  memory: { reads: ['PROJECT', 'ORGANISATION'], writes: [] },
  mandate: {
    reads: ['SITE_SERVICES', 'BUDGET_COST'],
    proposes: [],
    approvers: ['COMMERCIAL_MANAGER', 'PROJECT_DIRECTOR', 'QS'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const record = ctx.ledger.list(ctx.projectId, 'SiteServicesAppointment').at(0);
    if (!record) return empty;
    const appointment = record.state as unknown as {
      model: 'ADVISORY' | 'MANAGEMENT_INTEGRATOR' | 'PRINCIPAL_SERVICE_CONTRACTOR';
      baselined: boolean;
    };

    const profile = profileFor(appointment.model);
    const findings: Finding[] = [];

    // The most recent assessment, if one was ever run, and whether it agrees
    // with the appointment actually held. A model taken against the advice is
    // a legitimate commercial decision and an illegitimate accident, and the
    // difference is whether anybody knows.
    const assessment = ctx.ledger
      .list(ctx.projectId, 'ModelFitAssessment')
      .map((entry) => entry.state as unknown as { id: string; recommended?: string; viability: { model: string; viable: boolean; blockers: string[] }[] })
      .at(-1);

    if (assessment) {
      const held = assessment.viability.find((entry) => entry.model === appointment.model);
      if (held && !held.viable) {
        findings.push({
          key: `etablix-commercial:appointed-blocked:${appointment.model}`,
          severity: 'URGENT',
          summary: `ETABLIX is appointed as ${profile.label.split(' — ')[0]} and the last model-fit assessment found that model not viable.`,
          consequence: `The gates it failed: ${held.blockers.join(' ')} These are the conditions that decide whether the appointment can be funded and insured, not preferences.`,
          evidence: [{ refType: 'ModelFitAssessment', refId: assessment.id, note: 'Most recent assessment' }],
        });
      } else if (assessment.recommended && assessment.recommended !== appointment.model) {
        findings.push({
          key: `etablix-commercial:against-advice:${appointment.model}`,
          severity: 'ATTENTION',
          summary: `Appointed as ${profile.label.split(' — ')[0]}; the assessment recommended ${assessment.recommended
            .toLowerCase()
            .replaceAll('_', ' ')}.`,
          consequence:
            'A legitimate decision, and one worth being on the record as a decision rather than as a difference nobody noticed.',
          evidence: [{ refType: 'ModelFitAssessment', refId: assessment.id, note: 'Most recent assessment' }],
        });
      }
    } else {
      findings.push({
        key: 'etablix-commercial:unassessed',
        severity: 'ATTENTION',
        summary: `Appointed as ${profile.label.split(' — ')[0]} with no model-fit assessment on the record.`,
        consequence: `Nothing has tested whether the ${
          profile.model === 'PRINCIPAL_SERVICE_CONTRACTOR' ? 'treasury, liability and mobilisation' : 'viability'
        } gates for this model pass. ${profile.cashRisk}`,
        evidence: [{ refType: 'SiteServicesAppointment', refId: record.refId, note: 'Appointment in force' }],
      });
    }

    return findings.length > 0 ? { findings, proposals: [] } : empty;
  },
};

// --- The family specialists --------------------------------------------------

const siteLayout: AgentDefinition = familySpecialist({
  name: 'etablix-layout',
  agentId: 'AGT-ETX-LAYOUT',
  family: 'TEMPORARY_INFRASTRUCTURE',
  purpose:
    'Sizes the compound against what is actually available: zoning, cabins, stores, parking, laydown and the phasing if it does not all fit at once.',
  inputs: ['Compound area available', 'Peak workforce', 'Survey and layout drawings'],
  outputs: ['Compound capacity check', 'Zoning options', 'Phasing where the area is short'],
  approvers: ['PM', 'CONSTRUCTION_MANAGER', 'PROJECT_DIRECTOR'],
});

const temporaryCivils: AgentDefinition = familySpecialist({
  name: 'etablix-civils',
  agentId: 'AGT-ETX-CIVILS',
  family: 'ENABLING_CIVILS',
  purpose:
    'Sizes the enabling works and the reinstatement obligation together, because what is built determines what has to be taken out.',
  inputs: ['Ground bearing capacity', 'Reinstatement standard', 'Compound area', 'Condition survey'],
  outputs: ['Platform and haul-road scope', 'Reinstatement obligation', 'Hold points before occupation'],
  approvers: ['CONSTRUCTION_MANAGER', 'PM', 'DESIGNER'],
});

const temporaryMep: AgentDefinition = familySpecialist({
  name: 'etablix-mep',
  agentId: 'AGT-ETX-MEP',
  family: 'TEMPORARY_MEP',
  purpose:
    'Watches maximum demand against secured supply, and water storage against the tanker interval — the two shortfalls that stop a site rather than costing it money.',
  inputs: ['Maximum demand after diversity', 'Secured supply', 'Potable storage autonomy', 'Tanker interval'],
  outputs: ['Supply shortfall with its lead time', 'Water autonomy check', 'Load-schedule gaps'],
  approvers: ['EPC', 'PM', 'CONSTRUCTION_MANAGER'],
});

const welfareVillage: AgentDefinition = familySpecialist({
  name: 'etablix-welfare',
  agentId: 'AGT-ETX-WELFARE',
  family: 'WELFARE_ACCOMMODATION',
  purpose:
    'Sizes welfare on concurrent occupancy rather than headcount, and checks the statutory minimum under Schedule 1 of the Workplace Regulations 1992.',
  inputs: ['Peak workforce', 'Shift changeover occupancy', 'Visitors', 'WCs provided', 'Rooms and occupancy policy'],
  outputs: ['Statutory sanitary check', 'Bed-night demand against beds', 'Concurrent-occupancy design basis'],
  approvers: ['PM', 'SAFETY', 'FM'],
});

const fmLivingServices: AgentDefinition = familySpecialist({
  name: 'etablix-fm',
  agentId: 'AGT-ETX-FM',
  family: 'CLEANING_FM',
  purpose:
    'Builds the service regime from cleanable area and occupancy, and checks that waste leaves the site at least as fast as it arrives.',
  inputs: ['Cleanable area', 'Waste volume by stream', 'Container capacity', 'Collection frequency'],
  outputs: ['Cleaning productive hours', 'Waste balance', 'PPM and reactive cover'],
  approvers: ['FM', 'PM', 'CONSTRUCTION_MANAGER'],
});

const securityLogistics: AgentDefinition = familySpecialist({
  name: 'etablix-security',
  agentId: 'AGT-ETX-SECURITY',
  family: 'SECURITY_LOGISTICS',
  purpose:
    'Checks that the site is guarded while it is live, that the gate can pass a shift before it starts, and that everybody who needs transport has a seat.',
  inputs: ['Operating hours', 'Security cover', 'Gate throughput', 'Travelling workforce', 'Bus seats'],
  outputs: ['Unguarded hours', 'Gate queue in minutes', 'Transport shortfall'],
  approvers: ['CONSTRUCTION_MANAGER', 'SAFETY', 'PM'],
});

const procurement: AgentDefinition = familySpecialist({
  name: 'etablix-procurement',
  agentId: 'AGT-ETX-PROCUREMENT',
  family: 'PROCUREMENT_CONTROL',
  purpose:
    'Watches the package strategy and the first mobilisation date, which together decide whether a tender can be run at all before the first service is needed.',
  inputs: ['Package count', 'First mobilisation date', 'Appointment model', 'Approved supplier list'],
  outputs: ['Tender programme feasibility', 'Package boundary gaps', 'Market depth by package'],
  approvers: ['COMMERCIAL_MANAGER', 'PROJECT_DIRECTOR', 'QS'],
});

/**
 * HSE and compliance, which reads across families rather than owning one.
 *
 * The welfare shortfall is a statutory matter as well as a capacity one, and it
 * belongs on both desks — but stated differently, because the two readers act
 * on different things. The welfare agent says *seven WCs are needed and five
 * exist*; this one says *the site cannot be occupied at this headcount*.
 */
const hseCompliance: AgentDefinition = {
  name: 'etablix-hse',
  agentId: 'AGT-ETX-HSE',
  module: 'ETABLIX',
  division: 'SITE_SERVICES',
  purpose:
    'Reads the site-services position for the statutory exposures in it: welfare provision below the legal minimum, and a site operating unguarded.',
  activeIn: 'ANY',
  triggers: [
    { kind: 'SCHEDULE', at: '06:30' },
    { kind: 'EVENT', eventType: 'SITE_SERVICE_FACT_RECORDED' },
  ],
  inputs: ['Concurrent occupancy', 'Sanitary provision', 'Operating hours', 'Security cover'],
  outputs: ['Statutory welfare exposure', 'Unguarded operating hours', 'Evidence a regulator would ask for'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.9,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: [] },
  mandate: {
    reads: ['SITE_SERVICES', 'SAFETY_RAMS'],
    proposes: [],
    approvers: ['SAFETY', 'PRINCIPAL_DESIGNER', 'PROJECT_DIRECTOR'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    let conflicts: BriefConflict[];
    try {
      conflicts = briefConflicts(ctx);
    } catch {
      return empty;
    }

    // Only the two that carry a statutory consequence. Restating every
    // shortfall here would make this agent a second copy of the other six.
    const statutory = conflicts.filter((conflict) =>
      ['WELFARE_BELOW_STATUTORY', 'SECURITY_BELOW_OPERATING_HOURS'].includes(conflict.id),
    );
    if (statutory.length === 0) return empty;

    return {
      findings: statutory.map((conflict) => ({
        key: `etablix-hse:${conflict.id}`,
        severity: 'URGENT' as const,
        summary:
          conflict.id === 'WELFARE_BELOW_STATUTORY'
            ? `Welfare provision is below the statutory minimum for the occupancy recorded. ${conflict.statement}`
            : `The site operates while unguarded. ${conflict.statement}`,
        consequence:
          conflict.id === 'WELFARE_BELOW_STATUTORY'
            ? 'Regulation 20 of the Workplace (Health, Safety and Welfare) Regulations 1992 is not met at this occupancy. This is an enforcement matter before it is a capacity one, and the figures are already on this project’s record.'
            : 'Unauthorised access, plant theft and an unwitnessed incident all become materially more likely, and the hours are recorded here for anybody who asks afterwards.',
        evidence: factEvidence(ctx, conflict.id === 'WELFARE_BELOW_STATUTORY' ? 'WELFARE_ACCOMMODATION' : 'SECURITY_LOGISTICS'),
      })),
      proposals: [],
    };
  },
};

// --- The six waiting on work that is not built yet ---------------------------
//
// `DECLARED`, with what each is waiting on named exactly. A fleet manifest that
// listed sixteen running agents when six of them read from records that do not
// exist would be a lie told in a table — and the whole point of the declared
// state is that the org chart and the blast radius are visible before the
// capability is.

const declared = (input: {
  name: string;
  agentId: string;
  purpose: string;
  inputs: string[];
  outputs: string[];
  needs: string;
  approvers: AgentDefinition['mandate']['approvers'];
  reads: AgentDefinition['mandate']['reads'];
}): AgentDefinition => ({
  name: input.name,
  agentId: input.agentId,
  module: 'ETABLIX',
  division: 'SITE_SERVICES',
  purpose: input.purpose,
  activeIn: 'ANY',
  triggers: [{ kind: 'SCHEDULE', at: '06:00' }],
  inputs: input.inputs,
  outputs: input.outputs,
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.9,
  acuTier: 'MED',
  memory: { reads: ['PROJECT'], writes: [] },
  deployment: 'DECLARED',
  needs: input.needs,
  mandate: {
    reads: input.reads,
    proposes: [],
    approvers: input.approvers,
    maxUnattended: 'OBSERVE',
  },
});

const supplierAssurance = declared({
  name: 'etablix-supplier-assurance',
  agentId: 'AGT-ETX-SUPPLIER',
  purpose: 'Validates supplier competence, evidence currency and operational performance, and escalates before an expiry bites.',
  inputs: ['PQQ returns', 'Insurance and accreditation expiry dates', 'KPI returns', 'Inspection results'],
  outputs: ['Supplier status', 'Corrective actions', 'Escalations'],
  needs: '§7.3 supplier control states — the register of supplier status and evidence expiry is not built.',
  approvers: ['COMMERCIAL_MANAGER', 'QAQC', 'PROJECT_DIRECTOR'],
  reads: ['SITE_SERVICES', 'PROCUREMENT_AWARD'],
});

const mobilisation = declared({
  name: 'etablix-mobilisation',
  agentId: 'AGT-ETX-MOBILISATION',
  purpose: 'Runs the readiness gates package by package and for the integrated system, and scores what is blocking release.',
  inputs: ['Submittals', 'Permits', 'Delivery and install status', 'Test results', 'Site readiness'],
  outputs: ['Gate score by package', 'Blockers', 'Release recommendation'],
  needs: '§8 Mobilisation Control Tower — the gate model and its evidence requirements are not built.',
  approvers: ['PM', 'CONSTRUCTION_MANAGER', 'PROJECT_DIRECTOR'],
  reads: ['SITE_SERVICES', 'QUALITY_COMMISSIONING'],
});

const operationsSentinel = declared({
  name: 'etablix-sentinel',
  agentId: 'AGT-ETX-SENTINEL',
  purpose: 'Monitors live service health against the KPI contract and predicts a failure before the helpdesk hears about it.',
  inputs: ['Meter data', 'Helpdesk tickets', 'Inspections', 'Access events', 'Occupancy'],
  outputs: ['Service alerts', 'Work orders', 'Recovery plans'],
  needs: '§9 Live Operations — the daily control loop, the KPI contract and the work-order record are not built.',
  approvers: ['FM', 'CONSTRUCTION_MANAGER', 'PM'],
  reads: ['SITE_SERVICES', 'FIELD_EXECUTION'],
});

const changeClaims = declared({
  name: 'etablix-change',
  agentId: 'AGT-ETX-CHANGE',
  purpose: 'Detects scope drift against the agreed service baseline and preserves the cause-and-effect evidence while it is still fresh.',
  inputs: ['Instructions', 'Service baseline', 'Events and early warnings', 'Occupancy and demand actuals'],
  outputs: ['Early warning', 'Change file with cause and effect', 'Time and cost impact'],
  needs: '§11 change and early warning — the service baseline this compares against does not exist until §4 composes one.',
  approvers: ['COMMERCIAL_MANAGER', 'QS', 'PROJECT_DIRECTOR'],
  reads: ['SITE_SERVICES', 'CHANGE_VARIATION'],
});

const demobilisation = declared({
  name: 'etablix-demob',
  agentId: 'AGT-ETX-DEMOB',
  purpose: 'Plans removal and reinstatement in the order the site can actually release, and assembles the acceptance dossier as it goes.',
  inputs: ['Asset register', 'Lease and hire end dates', 'Condition survey', 'Waste records'],
  outputs: ['Removal sequence', 'Waste and consignment records', 'Reinstatement acceptance dossier'],
  needs: '§12 demobilisation — the asset register and the condition-survey record are not built.',
  approvers: ['PM', 'CONSTRUCTION_MANAGER', 'FM'],
  reads: ['SITE_SERVICES', 'HANDOVER_OM'],
});


/**
 * The sixteen, in the order the specification lists them.
 *
 * Eleven run. Five are declared and name exactly which section of the
 * specification has to exist before they have anything to read — a manifest
 * that listed sixteen running agents when five of them read from records that
 * do not exist would be a lie told in a table.
 *
 * §4's System Composer is deliberately not here. It is a system rather than one
 * of the sixteen, and adding a seventeenth agent to a list the specification
 * numbers at sixteen is how a fleet stops matching the document it came from.
 */
export const ETABLIX_AGENTS: AgentDefinition[] = [
  orchestrator,
  briefIntelligence,
  siteLayout,
  temporaryCivils,
  temporaryMep,
  welfareVillage,
  fmLivingServices,
  securityLogistics,
  procurement,
  commercial,
  supplierAssurance,
  hseCompliance,
  mobilisation,
  operationsSentinel,
  changeClaims,
  demobilisation,
];
