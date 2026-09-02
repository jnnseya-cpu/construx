import { authorise, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { appointmentInForce, profileFor } from './appointment.ts';
import { BRIEF_ITEMS, briefReadiness } from './brief.ts';
import { sbs } from './composer.ts';
import { mobilisationPosition } from './mobilisation.ts';
import { procurementPosition } from './procurement.ts';
import { operationsPosition } from './operations.ts';
import { changePosition } from './change.ts';
import { demobilisationPosition } from './demobilisation.ts';

/**
 * §6 — the end-to-end workflow engine.
 *
 * Nine stages, each with an entry gate, agent-driven work and an exit gate that
 * names an authoritative record. The table is in the specification; what makes
 * it an engine rather than a diagram is the one rule this module exists to
 * enforce:
 *
 * **A gate is derived, never set.** There is no command anywhere in this file to
 * move a project to a stage, and there is no stage field on any record. Every
 * gate is a question asked of the records §2–§12 already hold, answered fresh
 * on every read. That is the same discipline as §8's mobilisation tower, and it
 * is here for the same reason: a stage somebody types is a stage that is true
 * because it was typed, and the first serious argument on a job is about
 * whether something had actually been done or merely marked done.
 *
 * It follows that this module has no `write` call in it, and it never will. The
 * only way to move through §6 is to make the underlying records true.
 *
 * ## What a gate is allowed to say
 *
 * Three answers, not two. A condition is **satisfied**, **outstanding**, or
 * **not derivable** — and the third is the one that keeps this honest. Stage 8's
 * exit is "sanitised knowledge promoted to the ETABLIX library", and there is no
 * library. Reporting that as outstanding would say somebody has work to do;
 * reporting it as not derivable says the platform cannot answer the question at
 * all, which is a different and more useful statement. Every condition carries
 * the sentence that explains which of the three it is.
 *
 * ## Stage 6 is a loop, not a step
 *
 * The specification numbers Change/Recover between Operate and Demobilise, and
 * on a real job it is neither before nor after either: it runs whenever a
 * variance is detected, alongside whatever else is happening. Treating it as a
 * sequential step would mean a project in Operate with three live changes
 * reported itself as being *in* Change, having left Operate, which is not what
 * anybody means. It is marked `concurrent` and excluded from the furthest-stage
 * calculation.
 */

export type GateOutcome = 'SATISFIED' | 'OUTSTANDING' | 'NOT_DERIVABLE';

export type GateCondition = {
  id: string;
  /** What has to be true, in the words it would be asked in. */
  label: string;
  /** The failure it prevents. Never a restatement of the label. */
  matters: string;
  outcome: GateOutcome;
  /** What was actually read, or precisely what is missing. Never omitted. */
  detail: string;
};

export type StageDefinition = {
  id: string;
  order: number;
  label: string;
  /** §6's own "agent-driven work" column, verbatim in substance. */
  work: string;
  /** The record that exists once the exit gate passes. */
  authoritativeRecord: string;
  /** True for Change/Recover, which runs alongside rather than after. */
  concurrent: boolean;
};

export const STAGES: readonly StageDefinition[] = [
  {
    id: 'OPPORTUNITY',
    order: 0,
    label: 'Opportunity',
    work: 'Scope triage, model fit, risk screen, ROM effort and the data request.',
    authoritativeRecord: 'An approved pursue decision and the engagement basis it was taken on.',
    concurrent: false,
  },
  {
    id: 'DISCOVER',
    order: 1,
    label: 'Discover',
    work: 'Ingest the brief, interview, capture the site, record the constraints and measure completeness.',
    authoritativeRecord: 'A customer-accepted problem statement, with the data gaps named rather than absent.',
    concurrent: false,
  },
  {
    id: 'DEFINE',
    order: 2,
    label: 'Define',
    work: 'Requirement baseline, demand curves, system options, the package and SBS breakdown and its interfaces.',
    authoritativeRecord: 'Baseline v1.0 and the chosen delivery architecture.',
    concurrent: false,
  },
  {
    id: 'PROCURE',
    order: 3,
    label: 'Procure',
    work: 'Market map, PQQ and ITT, bid queries, normalisation, risk and the award paper.',
    authoritativeRecord: 'An approved award, with the contracts placed by the correct entity.',
    concurrent: false,
  },
  {
    id: 'MOBILISE',
    order: 4,
    label: 'Mobilise',
    work: 'Submittals, design, permits, manufacturing, delivery, install, test and integrated readiness.',
    authoritativeRecord: 'A Mobilisation Acceptance Certificate per package and system.',
    concurrent: false,
  },
  {
    id: 'OPERATE',
    order: 5,
    label: 'Operate',
    work: 'Daily control, service assurance, helpdesk, inspections, KPI, earned value, change and forecast.',
    authoritativeRecord: 'Monthly service and commercial acceptance.',
    concurrent: false,
  },
  {
    id: 'CHANGE_RECOVER',
    order: 6,
    label: 'Change and recover',
    work: 'Causation, options, the time, cost and service impact, the instruction and recovery monitoring.',
    authoritativeRecord: 'An approved change, or a documented rejection and its mitigation.',
    concurrent: true,
  },
  {
    id: 'DEMOBILISE',
    order: 7,
    label: 'Demobilise',
    work: 'Occupancy run-down, asset isolation and removal, waste, survey and civils restoration.',
    authoritativeRecord: 'Reinstatement Acceptance, with the liabilities closed.',
    concurrent: false,
  },
  {
    id: 'LEARN',
    order: 8,
    label: 'Learn',
    work: 'Supplier score, benchmark normalisation, failure patterns and reusable templates.',
    authoritativeRecord: 'Sanitised knowledge promoted to the ETABLIX library.',
    concurrent: false,
  },
];

export type StageId = (typeof STAGES)[number]['id'];

export type StageView = StageDefinition & {
  entry: GateCondition[];
  exit: GateCondition[];
  /** True where every entry condition is satisfied. */
  entered: boolean;
  /** True where every exit condition is satisfied. */
  complete: boolean;
  /** Everything standing between here and the exit, in one list. */
  blocking: string[];
};

export type WorkflowPosition = {
  stages: StageView[];
  /**
   * The furthest sequential stage the project has actually entered.
   *
   * Derived, and absent where nothing has been entered at all. Stage 6 is
   * excluded because it is concurrent: a project running three changes has not
   * left Operate.
   */
  at?: StageId;
  /** Stage 6, separately, because it runs alongside whatever `at` says. */
  changeRunning: boolean;
  statement: string;
};

function condition(
  id: string,
  label: string,
  matters: string,
  outcome: GateOutcome,
  detail: string,
): GateCondition {
  return { id, label, matters, outcome, detail };
}

/** Satisfied or outstanding, from one boolean and the two sentences either way. */
function derived(
  id: string,
  label: string,
  matters: string,
  satisfied: boolean,
  detail: string,
): GateCondition {
  return condition(id, label, matters, satisfied ? 'SATISFIED' : 'OUTSTANDING', detail);
}

/**
 * The whole of §6, answered from the records.
 *
 * Reads every position once and asks the gates of them. The positions are read
 * unconditionally rather than per stage: unlike §13's workspaces, a workflow
 * position is a statement about the whole job and there is no version of it that
 * legitimately omits a stage. Where a position needs commercial standing the
 * caller needs it too, which is stated on the route rather than worked around.
 */
export function workflowPosition(ctx: EngineContext, today?: string): WorkflowPosition {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const asAt = today ?? new Date().toISOString().slice(0, 10);
  const appointment = appointmentInForce(ctx);
  const brief = briefReadiness(ctx, asAt);
  const design = sbs(ctx, asAt);
  const tower = mobilisationPosition(ctx, asAt);
  const factory = procurementPosition(ctx, asAt);
  const live = operationsPosition(ctx, asAt);
  const closeout = demobilisationPosition(ctx);

  // §11 and §10 authorise at COMMERCIAL_L3. A reader without commercial
  // standing gets the workflow with those two gates reported as withheld, which
  // is a true statement about what they may see rather than a refusal of the
  // whole screen or, worse, a gate silently reported as passed.
  const commercialRoles = ['OWNER', 'EPC', 'QS', 'PM', 'ENTERPRISE_ADMIN', 'COMMERCIAL_MANAGER'];
  const mayReadCommercial = ctx.auth.roles.some((role) => commercialRoles.includes(role));
  const changes = mayReadCommercial ? changePosition(ctx, asAt) : undefined;

  const fitAssessments = ctx.ledger.list(ctx.projectId, 'ModelFitAssessment');
  const composed = design.systems;
  const packages = factory.packages;

  // --- 0 Opportunity --------------------------------------------------------
  const opportunityEntry = [
    derived(
      'customerAndEntity',
      'The customer need and the contracting entity are both identified',
      'A pursuit against an unnamed entity is a pursuit nobody can price the liability of, because which of the three appointments is on offer decides what the liability is.',
      fitAssessments.length > 0 || appointment !== undefined,
      fitAssessments.length > 0
        ? `${fitAssessments.length} model-fit assessment${fitAssessments.length === 1 ? '' : 's'} on the record.`
        : appointment
          ? `Appointed to ${appointment.contractingEntity}, funded from ${appointment.fundingSource}.`
          : 'No model-fit assessment and no appointment. Nothing names the customer or the entity.',
    ),
  ];
  const opportunityExit = [
    derived(
      'engagementBasis',
      'The engagement basis is recorded and the model is chosen',
      'The basis is what the whole engagement is later argued against. Recorded at the start it is a decision; reconstructed at the end it is an assertion.',
      appointment !== undefined,
      appointment
        ? `${profileFor(appointment.model).label.split(' — ')[0]}, on the basis: ${appointment.basis}`
        : 'No appointment is in force, so no engagement basis exists.',
    ),
  ];

  // --- 1 Discover -----------------------------------------------------------
  const discoverEntry = [
    derived(
      'engagementAuthorised',
      'The engagement is authorised',
      'Ingesting a customer’s brief before there is an engagement is work nobody has agreed to pay for and data nobody has agreed to hold.',
      appointment !== undefined,
      appointment ? `Appointed ${appointment.setAt.slice(0, 10)}.` : 'Nothing is appointed.',
    ),
  ];
  // "Data gaps named rather than absent" is the exit, and it is exactly
  // checkable: no brief item may simply be missing. Known, or provisional with
  // an owner and a date. A gap nobody owns is the one that is still open in
  // month four.
  const unnamed = brief.families.flatMap((family) =>
    family.gaps.filter((gap) => gap.provisionalValue === undefined && gap.owner === undefined),
  );
  const discoverExit = [
    derived(
      'problemStatement',
      'Every figure the brief needs is known, or provisional with an owner',
      'A brief with silent gaps reads as complete. Every one of them is a number somebody will assume, and the assumptions will not agree.',
      unnamed.length === 0 && brief.percentKnown > 0,
      brief.percentKnown === 0
        ? 'No brief fact has been recorded at all.'
        : unnamed.length === 0
          ? `${brief.percentKnown}% of the ${BRIEF_ITEMS.length} items are known, and every remaining gap carries an owner.`
          : `${unnamed.length} item${unnamed.length === 1 ? '' : 's'} are neither known nor owned: ${unnamed
              .slice(0, 6)
              .map((gap) => gap.itemId)
              .join(', ')}${unnamed.length > 6 ? ` and ${unnamed.length - 6} more` : ''}.`,
    ),
  ];

  // --- 2 Define -------------------------------------------------------------
  const defineEntry = [
    derived(
      'minimumData',
      'The demand engine can derive every figure it is asked for',
      'A system composed against a derivation the engine could not perform is a system sized against nothing, and it will be sized again on site.',
      design.demand.notDerivable.length === 0,
      design.demand.notDerivable.length === 0
        ? `All ${design.demand.derivations.length} derivations resolve.`
        : `${design.demand.notDerivable.length} cannot be derived: ${design.demand.notDerivable
            .map((entry) => `${entry.label} (missing ${entry.missing.join(', ')})`)
            .join('; ')}.`,
    ),
  ];
  const unownedInterfaces = design.interfaceMatrix.reduce((sum, row) => sum + row.unowned, 0);
  const defineExit = [
    derived(
      'baselineAgreed',
      'The requirements baseline is agreed',
      'After the baseline a change of appointment model is a governed commercial transition rather than an edit. Before it, everything is still a draft nobody has signed.',
      appointment?.baselined === true,
      appointment?.baselined === true
        ? `Baseline agreed ${appointment.baselinedAt?.slice(0, 10) ?? 'on the record'}.`
        : 'No baseline has been agreed.',
    ),
    derived(
      'architectureChosen',
      'A delivery architecture exists: systems composed and their interfaces owned',
      'The architecture is the list of things that have to arrive and the list of people they have to arrive from. An interface with nobody on the other side is a dependency somebody discovers on the day it fails.',
      composed.length > 0 && unownedInterfaces === 0,
      composed.length === 0
        ? 'Nothing is composed.'
        : unownedInterfaces === 0
          ? `${composed.length} system${composed.length === 1 ? '' : 's'} composed, every interface owned.`
          : `${composed.length} composed, but ${unownedInterfaces} interface${unownedInterfaces === 1 ? ' has' : 's have'} no counterparty named.`,
    ),
  ];

  // --- 3 Procure ------------------------------------------------------------
  const unpackaged = factory.unpackaged;
  const incomplete = packages.filter((pack) => pack.outstanding > 0);
  const procureEntry = [
    derived(
      'scopeFrozen',
      'Every composed system is inside a package, and every package is complete',
      'The moment of issue is the last moment a package field is free to fix. Issued with one silent, it is fixed by a variation.',
      composed.length > 0 && unpackaged.length === 0 && incomplete.length === 0,
      composed.length === 0
        ? 'Nothing is composed, so there is nothing to package.'
        : unpackaged.length > 0
          ? `${unpackaged.length} composed system${unpackaged.length === 1 ? '' : 's'} no package buys: ${unpackaged
              .map((entry) => entry.label)
              .join(', ')}.`
          : incomplete.length > 0
            ? `${incomplete.length} package${incomplete.length === 1 ? '' : 's'} with fields outstanding: ${incomplete
                .map((pack) => `${pack.reference} (${pack.outstanding})`)
                .join(', ')}.`
            : `${packages.length} package${packages.length === 1 ? '' : 's'}, every field stated, every system bought.`,
    ),
  ];
  const contracted = packages.filter((pack) =>
    pack.engagements.some((entry) => ['CONTRACTED', 'MOBILISING', 'OPERATIONAL'].includes(entry.state)),
  );
  const procureExit = [
    derived(
      'awardPlaced',
      'Every package has a contract placed by the entity the appointment names',
      'A package let by the wrong entity is unenforceable by whoever thinks they hold it, and nobody finds out until they try to enforce it.',
      packages.length > 0 && contracted.length === packages.length,
      packages.length === 0
        ? 'No package exists.'
        : contracted.length === packages.length
          ? `${contracted.length} of ${packages.length} packages contracted${
              appointment ? ` under ${profileFor(appointment.model).label.split(' — ')[0]}` : ''
            }.`
          : `${packages.length - contracted.length} of ${packages.length} packages have no contracted supplier.`,
    ),
  ];

  // --- 4 Mobilise -----------------------------------------------------------
  const mobilising = tower.systems.filter((system) => system.gates.some((gate) => gate.approval !== undefined));
  const mobiliseEntry = [
    derived(
      'contractAndAccess',
      'A contract is placed and the first gate has passed on something',
      'Mobilising against no contract is mobilising at ETABLIX’s risk whichever appointment is in force, and the first gate is where the contracting party is checked.',
      contracted.length > 0 && mobilising.length > 0,
      contracted.length === 0
        ? 'No supplier is contracted on any package.'
        : mobilising.length === 0
          ? 'No gate has been approved on any system, so nothing has started.'
          : `${mobilising.length} system${mobilising.length === 1 ? '' : 's'} past their first gate.`,
    ),
  ];
  const accepted = tower.systems.filter((system) => system.accepted);
  const mobiliseExit = [
    derived(
      'acceptanceCertificates',
      'Every composed system holds a Mobilisation Acceptance Certificate',
      'Without it there is no operational-ready state, and a supplier declaring a hundred per cent moves nothing.',
      tower.systems.length > 0 && accepted.length === tower.systems.length,
      tower.systems.length === 0
        ? 'Nothing is composed, so nothing can be accepted.'
        : accepted.length === tower.systems.length
          ? `All ${accepted.length} systems accepted.`
          : `${accepted.length} of ${tower.systems.length} accepted. ${tower.systems
              .filter((system) => !system.accepted)
              .map((system) => `${system.label} at ${system.atGate}`)
              .join('; ')}.`,
    ),
  ];

  // --- 5 Operate ------------------------------------------------------------
  const operateEntry = [
    derived(
      'readinessAccepted',
      'Mobilisation acceptance is in place',
      'Operating a service nobody accepted means the first KPI period is measured against a readiness state that was never agreed.',
      tower.systems.length > 0 && accepted.length === tower.systems.length,
      accepted.length === tower.systems.length && tower.systems.length > 0
        ? 'Readiness accepted across every system.'
        : `${tower.systems.length - accepted.length} system${tower.systems.length - accepted.length === 1 ? '' : 's'} not yet accepted.`,
    ),
  ];
  const measured = live.availability.filter((view) => view.periods > 0);
  const operateExit = mayReadCommercial
    ? [
        derived(
          'serviceAccepted',
          'A service period is measured',
          'A month with no recorded period is a month whose availability is an argument rather than a figure.',
          measured.length > 0,
          measured.length > 0
            ? `${measured.length} system${measured.length === 1 ? '' : 's'} with a measured period.`
            : 'No service period has been recorded.',
        ),
        certifiedCondition(ctx, asAt),
      ]
    : [
        derived(
          'serviceAccepted',
          'A service period is measured',
          'A month with no recorded period is a month whose availability is an argument rather than a figure.',
          measured.length > 0,
          measured.length > 0
            ? `${measured.length} system${measured.length === 1 ? '' : 's'} with a measured period.`
            : 'No service period has been recorded.',
        ),
        condition(
          'commercialAccepted',
          'The month is commercially accepted',
          'Service acceptance and commercial acceptance are two different acceptances by two different people, and a month is not closed until both.',
          'NOT_DERIVABLE',
          'Withheld: whether a valuation has been certified is commercial-in-confidence and this session does not hold commercial standing.',
        ),
      ];

  // --- 6 Change and recover -------------------------------------------------
  const variances =
    live.events.filter((event) => event.status !== 'CLOSED').length +
    design.deployment.length +
    design.systems.reduce((sum, system) => sum + system.drift.length, 0);
  const changeEntry = [
    derived(
      'varianceDetected',
      'A variance, event or instruction has been detected',
      'This stage is entered by something happening, not by somebody deciding to enter it. A variance nobody recorded is a variance nobody is recovering from.',
      variances > 0 || (changes?.changes.length ?? 0) > 0,
      // Counted apart rather than summed into one plural, because "2 open
      // events, deployment exceptions and drift records" reads as two of each.
      [
        `${live.events.filter((event) => event.status !== 'CLOSED').length} open event${
          live.events.filter((event) => event.status !== 'CLOSED').length === 1 ? '' : 's'
        }`,
        `${design.deployment.length} deployment exception${design.deployment.length === 1 ? '' : 's'}`,
        `${design.systems.reduce((sum, system) => sum + system.drift.length, 0)} drift record${
          design.systems.reduce((sum, system) => sum + system.drift.length, 0) === 1 ? '' : 's'
        }`,
        ...(changes ? [`${changes.changes.length} change${changes.changes.length === 1 ? '' : 's'} raised`] : []),
      ].join(', ') + '.',
    ),
  ];
  const changeExit = changes
    ? [
        derived(
          'changeResolved',
          'Every change is agreed or rejected, and every notice that was due was given',
          'No change becomes forecast-neutral because it lacks an approved quotation, and no entitlement survives a notice period that passed with nothing sent.',
          changes.changes.every((entry) => entry.status === 'AGREED' || entry.status === 'REJECTED') &&
            changes.changes.every((entry) => !entry.noticeLapsed),
          changes.changes.length === 0
            ? 'No change has been raised.'
            : `${changes.changes.filter((entry) => entry.status === 'AGREED' || entry.status === 'REJECTED').length} of ${
                changes.changes.length
              } resolved; ${changes.changes.filter((entry) => entry.noticeLapsed).length} with a lapsed notice. ${changes.statement}`,
        ),
      ]
    : [
        condition(
          'changeResolved',
          'Every change is agreed or rejected, and every notice that was due was given',
          'No change becomes forecast-neutral because it lacks an approved quotation, and no entitlement survives a notice period that passed with nothing sent.',
          'NOT_DERIVABLE',
          'Withheld: the change register carries entitlement values and this session does not hold commercial standing.',
        ),
      ];

  // --- 7 Demobilise ---------------------------------------------------------
  const demobiliseEntry = [
    derived(
      'removalPlanned',
      'Every system has an agreed removal plan',
      'Demobilisation begins at design. A plan agreed while somebody still wants something costs what it costs; one agreed at the end costs whatever the last firm on site asks.',
      closeout.plans.length > 0 && closeout.unplanned === 0,
      closeout.plans.length === 0
        ? 'Nothing is composed, so there is nothing to remove.'
        : closeout.unplanned === 0
          ? `All ${closeout.plans.length} systems have a removal plan.`
          : `${closeout.unplanned} of ${closeout.plans.length} system${closeout.plans.length === 1 ? '' : 's'} ${
              closeout.unplanned === 1 ? 'has' : 'have'
            } no removal plan.`,
    ),
    derived(
      'welfareProtected',
      'No run-down leaves welfare below the statutory minimum',
      'This is the phase where the last WCs go back because the compound is finishing and there are still forty people working.',
      closeout.runDowns.every((entry) => !entry.belowStatutory),
      closeout.runDowns.length === 0
        ? 'No run-down has been proposed.'
        : `${closeout.runDowns.filter((entry) => entry.belowStatutory).length} of ${
            closeout.runDowns.length
          } run-downs sit below the statutory minimum.`,
    ),
  ];
  const streamsOpen = closeout.workstreams.filter((stream) => stream.open > 0);
  const demobiliseExit = [
    derived(
      'reinstatementAccepted',
      'All seven workstreams are accepted',
      'A liability nobody closed is a liability that turns up at the land handover, when the compound has gone and nobody is left who knows what was under it.',
      closeout.workstreams.some((stream) => stream.accepted + stream.open > 0) && streamsOpen.length === 0,
      closeout.workstreams.every((stream) => stream.accepted + stream.open === 0)
        ? 'No workstream has been opened.'
        : streamsOpen.length === 0
          ? 'Every opened workstream is accepted.'
          : `${streamsOpen.length} workstream${streamsOpen.length === 1 ? '' : 's'} open: ${streamsOpen
              .map((stream) => `${stream.label} (${stream.open})`)
              .join(', ')}.`,
    ),
  ];

  // --- 8 Learn --------------------------------------------------------------
  const learnEntry = [
    derived(
      'finalRecords',
      'The closeout record is complete',
      'A lesson drawn before the account is closed is a lesson drawn from half the story, and the expensive half is usually the second.',
      streamsOpen.length === 0 && closeout.workstreams.some((stream) => stream.accepted > 0),
      streamsOpen.length === 0 && closeout.workstreams.some((stream) => stream.accepted > 0)
        ? 'Every opened workstream is accepted.'
        : 'The closeout is not complete.',
    ),
  ];
  const learnExit = [
    condition(
      'knowledgePromoted',
      'Sanitised knowledge is promoted to the ETABLIX library',
      'The module’s stated advantage is that each project improves the next brief, tender and operating baseline without exposing one customer’s data to another. Without the library that is a claim rather than a mechanism.',
      'NOT_DERIVABLE',
      'Not built. There is no ETABLIX knowledge library: no site-services supplier score is written back from an engagement, no price benchmark is promoted out of a normalisation, and no reusable package template exists. §7 normalises bids within a project and nothing carries the result forward. This is the one stage of the nine with no authoritative record behind it.',
    ),
  ];

  const gates: Record<string, { entry: GateCondition[]; exit: GateCondition[] }> = {
    OPPORTUNITY: { entry: opportunityEntry, exit: opportunityExit },
    DISCOVER: { entry: discoverEntry, exit: discoverExit },
    DEFINE: { entry: defineEntry, exit: defineExit },
    PROCURE: { entry: procureEntry, exit: procureExit },
    MOBILISE: { entry: mobiliseEntry, exit: mobiliseExit },
    OPERATE: { entry: operateEntry, exit: operateExit },
    CHANGE_RECOVER: { entry: changeEntry, exit: changeExit },
    DEMOBILISE: { entry: demobiliseEntry, exit: demobiliseExit },
    LEARN: { entry: learnEntry, exit: learnExit },
  };

  const stages: StageView[] = STAGES.map((stage) => {
    const { entry, exit } = gates[stage.id]!;
    const entered = entry.every((item) => item.outcome === 'SATISFIED');
    const complete = exit.every((item) => item.outcome === 'SATISFIED');
    return {
      ...stage,
      entry,
      exit,
      entered,
      complete,
      blocking: [...entry, ...exit].filter((item) => item.outcome !== 'SATISFIED').map((item) => item.detail),
    };
  });

  // The furthest sequential stage actually entered. Sequential means what it
  // says: a later stage whose entry happens to be satisfied while an earlier one
  // is not does not move the project forward, because the earlier gate is what
  // the later stage's records were supposed to be built on.
  let at: StageId | undefined;
  for (const stage of stages) {
    if (stage.concurrent) continue;
    if (!stage.entered) break;
    at = stage.id as StageId;
  }
  const changeRunning = stages.find((stage) => stage.id === 'CHANGE_RECOVER')!.entered;
  const here = stages.find((stage) => stage.id === at);

  const statement =
    at === undefined
      ? 'Nothing has been entered. The first gate asks for the customer, the contracting entity and a model-fit assessment, and none of the three is on the record.'
      : `At ${here!.label.toLowerCase()}${
          here!.complete ? ', complete' : `, with ${here!.blocking.length} thing${here!.blocking.length === 1 ? '' : 's'} outstanding`
        }.${changeRunning ? ' Change and recovery is running alongside it.' : ''}`;

  return { stages, ...(at === undefined ? {} : { at }), changeRunning, statement };
}

/**
 * Whether a valuation has been certified, read behind commercial standing.
 *
 * Split out because it is the one gate in §6 that needs a position the reader
 * may not be entitled to, and reading it inline would have meant either an
 * unconditional call that refuses the whole workflow or a boolean derived from
 * nothing.
 */
function certifiedCondition(ctx: EngineContext, asAt: string): GateCondition {
  const valuations = ctx.ledger
    .list(ctx.projectId, 'Valuation')
    .map((record) => record.state as unknown as { reference: string; status: string; certifiedAt?: string })
    .filter((entry) => entry.status === 'CERTIFIED' && (entry.certifiedAt ?? '') <= `${asAt}T23:59:59.999Z`);
  return derived(
    'commercialAccepted',
    'The month is commercially accepted',
    'Service acceptance and commercial acceptance are two different acceptances by two different people, and a month is not closed until both.',
    valuations.length > 0,
    valuations.length > 0
      ? `${valuations.length} valuation${valuations.length === 1 ? '' : 's'} certified: ${valuations
          .map((entry) => entry.reference)
          .join(', ')}.`
      : 'No valuation has been certified.',
  );
}
