import { DomainError } from '../../core/errors.ts';
import { authorise, type EngineContext } from '../../engines/context.ts';
import { requireModule } from '../../identity/modules.ts';
import { classifyEntity } from '../../identity/entityAccess.ts';
import { ownersByRole, type DecisionOwner, type Identity } from '../../identity/ownership.ts';
import type { EntityRef, GoldenThreadEvent } from '../../goldenthread/types.ts';
import { appointmentPosition } from './appointment.ts';
import { briefReadiness } from './brief.ts';
import { sbs } from './composer.ts';
import { mobilisationPosition } from './mobilisation.ts';
import { procurementPosition } from './procurement.ts';
import { operationsPosition } from './operations.ts';
import { commercialPosition } from './commercial.ts';
import { changePosition } from './change.ts';
import { demobilisationPosition } from './demobilisation.ts';

/**
 * §13 — the command centres — and §17 — the automation measure.
 *
 * Two sections in one module because they are the same idea seen twice. §13 is
 * what a person is shown; §17 is the honest arithmetic about how much of it the
 * machine did. Both are read-only views over records eight other modules
 * already own, and neither writes anything: this file has no `write` call in
 * it, by construction, because a screen that can quietly change state is a
 * screen nobody can audit.
 *
 * ## What §13 is not
 *
 * §13's table is eight *questions*, not eight route names. "Which projects are
 * unsafe, late, under-capacity, overspending or cash-exposed?" is a question a
 * dashboard either answers or does not, and a wall of coloured tiles that looks
 * like an answer is worse than an empty screen — an empty screen sends somebody
 * to find out.
 *
 * So each workspace here decomposes its §13 sentence into the individual
 * questions it contains, and each question declares either the position it is
 * answered from or exactly what is not built. `answered: false` is a first-class
 * result. A workspace reporting six of eight questions answerable is telling the
 * truth; the same workspace showing eight green tiles would not be.
 *
 * ## §13.1 read properly
 *
 * "NOW / NEXT / WHY / ACTION" reads at a glance like four lists. It is not.
 * NOW and NEXT are the two lists — what is true today, and what falls due in
 * the next 2, 7 or 30 days. WHY and ACTION are **required fields on every
 * entry in both**: the rule and the record that produced the status, and the
 * owner, decision, deadline and consequence attached to it.
 *
 * That reading is the one that costs something to implement, which is why it is
 * the right one. It makes it impossible to add a signal to this panel without
 * saying which rule produced it, which record it can be opened at, and who has
 * to do something about it. §13.1's own words — "users can open the source, not
 * merely trust a coloured tile" — are an instruction to the person building the
 * panel, not a feature to list.
 *
 * ## One derivation, eight views
 *
 * Every entry is derived once, from the positions §2–§12 already publish, and
 * tagged with the workspaces it belongs on. Eight separate assemblers would be
 * eight places for the same signal to be phrased differently, and the first
 * time the control tower and the customer project disagreed about whether a
 * gate was blocked, both would be believed by somebody.
 *
 * ## Least privilege drives which positions are even read
 *
 * A workspace declares its sources, and only those positions are called. This
 * is not tidiness: `commercialPosition` and `changePosition` authorise at
 * `COMMERCIAL_L3`, so calling them to assemble a site manager's control tower
 * would refuse the whole screen. Declaring sources per workspace means the
 * control tower asks only for what a control tower is entitled to see, and the
 * money workspaces refuse cleanly to somebody without commercial standing.
 *
 * The module gate and the commercial gate at the top of each function are
 * deliberately the same checks the positions underneath make. They sit here so
 * a refusal happens before any position is read rather than partway through
 * assembling a screen, and so a workspace's own `commercial` declaration is
 * what refuses — not whichever position it happens to reach first. Removing
 * either still refuses today, because every position repeats them: that is
 * what defence in depth looks like from the outside, and it is said here
 * rather than left looking like a guard nobody tested.
 */

// --- §1.2 The automation boundary ----------------------------------------------------
//
// Three classes, and the boundary between them is authority rather than
// difficulty. Class A is not "the easy work" — extracting a workforce curve off
// a drawing is harder than signing a certificate. It is the work where being
// wrong is correctable, because the record is a draft until somebody uses it.

export const AUTOMATION_CLASSES = [
  {
    id: 'A',
    label: 'Autonomous',
    authority: 'Execute, record and notify within an approved baseline.',
    examples:
      'Extract brief data; chase documents; calculate demand; draft scopes; schedule inspections; classify defects; update forecasts.',
    /**
     * An agent must be able to author these, or the class is a fiction. Pinned
     * against the event catalogue's own `aiAllowed` by test.
     */
    requiresAiAllowed: true,
  },
  {
    id: 'B',
    label: 'Supervised',
    authority: 'Prepare the decision and execute after role-based approval.',
    examples: 'Issue RFQ; accept a mobilisation gate; instruct low-value change; recommend valuation; apply service credit.',
    requiresAiAllowed: false,
  },
  {
    id: 'C',
    label: 'Human-controlled',
    authority: 'AI advises only. A two-person or named-authority decision.',
    examples:
      'Supplier award; contract signature; safety-critical energisation; payment certificate; contingency draw; termination; regulatory submission.',
    /**
     * The inverse invariant: an agent must be *unable* to author these. The
     * ledger enforces it from `aiAllowed: false`, and the test proves the two
     * declarations agree rather than trusting that they do.
     */
    requiresAiForbidden: true,
  },
] as const;

export type AutomationClassId = (typeof AUTOMATION_CLASSES)[number]['id'];

/**
 * The workflows §17 insists the measure is reported by.
 *
 * "Target by workflow, not one blended vanity metric" is the whole instruction.
 * A platform that is 99% automated at recording brief facts and 20% automated
 * at valuation reports 90% blended, and the 20% is where the money is.
 */
export const AUTOMATION_WORKFLOWS = [
  { id: 'APPOINTMENT', label: 'Appointment', section: '§2' },
  { id: 'BRIEF', label: 'Brief gateway', section: '§3' },
  { id: 'DESIGN', label: 'System composition', section: '§4' },
  { id: 'PROCUREMENT', label: 'Procurement', section: '§7' },
  { id: 'MOBILISATION', label: 'Mobilisation', section: '§8' },
  { id: 'OPERATIONS', label: 'Live operations', section: '§9' },
  { id: 'COMMERCIAL', label: 'Commercial control', section: '§10' },
  { id: 'CHANGE', label: 'Change and recovery', section: '§11' },
  { id: 'DEMOBILISATION', label: 'Demobilisation', section: '§12' },
] as const;

export type AutomationWorkflowId = (typeof AUTOMATION_WORKFLOWS)[number]['id'];

type ActivityDefinition = { class: AutomationClassId; workflow: AutomationWorkflowId };

/**
 * Every ETABLIX activity, classified once.
 *
 * The key is the event type, because an activity in this platform *is* a ledger
 * event — there is no second register of "things that happened" to disagree
 * with the chain. `catalogue`-level tests prove this map covers the ETABLIX
 * block exactly: a §6 event added later with no class here fails the build
 * rather than quietly falling out of the denominator, which is the failure mode
 * that turns an automation metric into marketing.
 */
export const ACTIVITIES: Record<string, ActivityDefinition> = {
  // §2 — who ETABLIX is. Commercial identity, so nothing here is autonomous.
  SITE_SERVICES_APPOINTED: { class: 'C', workflow: 'APPOINTMENT' },
  SITE_SERVICES_BASELINE_AGREED: { class: 'C', workflow: 'APPOINTMENT' },
  SITE_SERVICES_APPOINTMENT_TRANSITIONED: { class: 'C', workflow: 'APPOINTMENT' },
  SITE_SERVICES_AUTHORITY_RECORDED: { class: 'C', workflow: 'APPOINTMENT' },
  // The paper, not the decision. Producing it is exactly an agent's job.
  SITE_SERVICES_MODEL_FIT_ASSESSED: { class: 'A', workflow: 'APPOINTMENT' },

  // §3 — the brief gateway. §1.2's first Class A example, verbatim.
  SITE_SERVICE_FACT_RECORDED: { class: 'A', workflow: 'BRIEF' },
  SITE_SERVICE_FACT_ASSUMED: { class: 'A', workflow: 'BRIEF' },
  SITE_SERVICE_FACT_SUPERSEDED: { class: 'A', workflow: 'BRIEF' },

  // §4 — composition and demand. Calculating demand and drafting scope is Class
  // A; re-composing a system already in the ground is a supervised decision,
  // because something is already standing on the answer.
  SERVICE_SYSTEM_COMPOSED: { class: 'A', workflow: 'DESIGN' },
  SERVICE_SYSTEM_RECOMPOSED: { class: 'B', workflow: 'DESIGN' },
  SERVICE_INTERFACE_RAISED: { class: 'A', workflow: 'DESIGN' },
  SERVICE_INTERFACE_ASSIGNED: { class: 'B', workflow: 'DESIGN' },
  SERVICE_INTERFACE_ACCEPTED: { class: 'B', workflow: 'DESIGN' },
  SERVICE_OBSERVATION_RECORDED: { class: 'A', workflow: 'DESIGN' },

  // §8 — mobilisation. Attesting and withdrawing evidence is recording; passing
  // a gate is §1.2's own Class B example; the acceptance certificate is the
  // named-authority act the whole tower exists to protect.
  MOBILISATION_EVIDENCE_ATTESTED: { class: 'A', workflow: 'MOBILISATION' },
  MOBILISATION_EVIDENCE_WITHDRAWN: { class: 'A', workflow: 'MOBILISATION' },
  MOBILISATION_GATE_APPROVED: { class: 'B', workflow: 'MOBILISATION' },
  MOBILISATION_ACCEPTED: { class: 'C', workflow: 'MOBILISATION' },
  SUPPLIER_PROGRESS_DECLARED: { class: 'A', workflow: 'MOBILISATION' },

  // §7 — procurement. Issuing the RFQ is §1.2's Class B example; the award is
  // its Class C example. The recommendation is the award: it names the winner.
  PACKAGING_STRATEGY_ASSESSED: { class: 'A', workflow: 'PROCUREMENT' },
  SERVICE_PACKAGE_CREATED: { class: 'A', workflow: 'PROCUREMENT' },
  SERVICE_PACKAGE_SPECIFIED: { class: 'A', workflow: 'PROCUREMENT' },
  SERVICE_PACKAGE_TENDERED: { class: 'B', workflow: 'PROCUREMENT' },
  SERVICE_BID_RECEIVED: { class: 'A', workflow: 'PROCUREMENT' },
  SERVICE_BID_CLARIFIED: { class: 'A', workflow: 'PROCUREMENT' },
  SERVICE_BID_LOCKED: { class: 'B', workflow: 'PROCUREMENT' },
  SERVICE_AWARD_RECOMMENDED: { class: 'C', workflow: 'PROCUREMENT' },
  SUPPLIER_ENGAGEMENT_OPENED: { class: 'A', workflow: 'PROCUREMENT' },
  SUPPLIER_ENGAGEMENT_ADVANCED: { class: 'B', workflow: 'PROCUREMENT' },
  // Suspension stops a firm working and stops its money. Termination-adjacent.
  SUPPLIER_ENGAGEMENT_SUSPENDED: { class: 'C', workflow: 'PROCUREMENT' },

  // §9 — live operations. Classifying a defect is §1.2's Class A example;
  // closing one against its evidence contract is the supervised act.
  SERVICE_EVENT_RAISED: { class: 'A', workflow: 'OPERATIONS' },
  SERVICE_EVENT_PROGRESSED: { class: 'A', workflow: 'OPERATIONS' },
  SERVICE_EVIDENCE_RECORDED: { class: 'A', workflow: 'OPERATIONS' },
  SERVICE_EVENT_CLOSED: { class: 'B', workflow: 'OPERATIONS' },
  SERVICE_EVENT_ROUTED: { class: 'A', workflow: 'OPERATIONS' },
  // Pausing a clock changes what the contract says happened. Resuming one only
  // restores the default, which is why the two sit on different rungs.
  SERVICE_CLOCK_PAUSED: { class: 'B', workflow: 'OPERATIONS' },
  SERVICE_CLOCK_RESUMED: { class: 'A', workflow: 'OPERATIONS' },
  SERVICE_PERIOD_RECORDED: { class: 'A', workflow: 'OPERATIONS' },

  // §10 — commercial. The certificate is §1.2's Class C example by name.
  SERVICE_CONTRACT_LINE_OPENED: { class: 'B', workflow: 'COMMERCIAL' },
  SERVICE_PROGRESS_ACCEPTED: { class: 'A', workflow: 'COMMERCIAL' },
  SERVICE_VALUATION_OPENED: { class: 'A', workflow: 'COMMERCIAL' },
  SERVICE_APPLICATION_RECORDED: { class: 'A', workflow: 'COMMERCIAL' },
  SERVICE_VALUATION_CERTIFIED: { class: 'C', workflow: 'COMMERCIAL' },
  SERVICE_CREDIT_RAISED: { class: 'B', workflow: 'COMMERCIAL' },
  SERVICE_CREDIT_APPROVED: { class: 'B', workflow: 'COMMERCIAL' },
  // §13 — paid, accrual and cash; contingency and the estimate at completion.
  // Money that has moved is recorded under the bank's reference by a person
  // who saw it move; the pot is a commercial authority; a draw is supervised.
  SERVICE_PAYMENT_RECORDED: { class: 'B', workflow: 'COMMERCIAL' },
  SERVICE_CONTINGENCY_SET: { class: 'C', workflow: 'COMMERCIAL' },
  SERVICE_CONTINGENCY_RESET: { class: 'C', workflow: 'COMMERCIAL' },
  SERVICE_CONTINGENCY_DRAWN: { class: 'B', workflow: 'COMMERCIAL' },

  // §13 — the record families beneath a running system. Scanning a code,
  // checking a delivery, putting a name in a bed and a seat on a bus are
  // recording; taking a room out of service changes what the site can house.
  SERVICE_ASSET_REGISTERED: { class: 'A', workflow: 'OPERATIONS' },
  SERVICE_ASSET_SCANNED: { class: 'A', workflow: 'OPERATIONS' },
  SERVICE_DELIVERY_SCHEDULED: { class: 'A', workflow: 'OPERATIONS' },
  SERVICE_DELIVERY_CHECKED: { class: 'A', workflow: 'OPERATIONS' },
  ACCOMMODATION_ROOM_REGISTERED: { class: 'A', workflow: 'OPERATIONS' },
  ACCOMMODATION_ROOM_STATUS_SET: { class: 'B', workflow: 'OPERATIONS' },
  BED_ALLOCATED: { class: 'A', workflow: 'OPERATIONS' },
  BED_CHECKED_IN: { class: 'A', workflow: 'OPERATIONS' },
  BED_CHECKED_OUT: { class: 'A', workflow: 'OPERATIONS' },
  TRANSPORT_JOURNEY_SCHEDULED: { class: 'A', workflow: 'OPERATIONS' },
  TRANSPORT_SEAT_BOOKED: { class: 'A', workflow: 'OPERATIONS' },
  TRANSPORT_JOURNEY_UPDATED: { class: 'A', workflow: 'OPERATIONS' },

  // §11 — change. Raising an early warning is autonomous and should be: the
  // whole failure this module addresses is nobody raising one.
  SERVICE_CHANGE_RAISED: { class: 'A', workflow: 'CHANGE' },
  SERVICE_CHANGE_NOTIFIED: { class: 'B', workflow: 'CHANGE' },
  SERVICE_CHANGE_PROGRESSED: { class: 'B', workflow: 'CHANGE' },
  SERVICE_CHANGE_REJECTED: { class: 'B', workflow: 'CHANGE' },

  // §12 — demobilisation. Acceptance closes land liabilities permanently, and
  // there is no version of that which an agent signs.
  REMOVAL_PLAN_AGREED: { class: 'B', workflow: 'DEMOBILISATION' },
  REMOVAL_PLAN_REVISED: { class: 'A', workflow: 'DEMOBILISATION' },
  SERVICE_RUNDOWN_PROPOSED: { class: 'A', workflow: 'DEMOBILISATION' },
  DEMOBILISATION_OPENED: { class: 'A', workflow: 'DEMOBILISATION' },
  DEMOBILISATION_EVIDENCED: { class: 'A', workflow: 'DEMOBILISATION' },
  DEMOBILISATION_ACCEPTED: { class: 'C', workflow: 'DEMOBILISATION' },

  // §6 stage 8 — the library. Deciding that what a job learned may leave it
  // is supervised; the three records the decision derives are recording, and
  // they feed the next procurement, which is where they are counted.
  KNOWLEDGE_PROMOTED: { class: 'B', workflow: 'PROCUREMENT' },
  LIBRARY_SUPPLIER_SCORED: { class: 'A', workflow: 'PROCUREMENT' },
  LIBRARY_BENCHMARK_PROMOTED: { class: 'A', workflow: 'PROCUREMENT' },
  LIBRARY_TEMPLATE_PROMOTED: { class: 'A', workflow: 'PROCUREMENT' },
};

/** §17's stabilised target for the agent-driven activity ratio. */
export const AUTOMATION_TARGET_PERCENT = 90;

// --- §17 The ten metrics -------------------------------------------------------------

/**
 * How an activity came to be recorded.
 *
 * §17's numerator is "autonomously completed **plus** agent-prepared/approved",
 * and the two are genuinely different: one is the machine working unattended,
 * the other is a person pressing go on something the machine wrote. Collapsing
 * them would let a platform where every act is human-initiated report itself as
 * fully automated on the strength of an AI block nobody read.
 */
export type Preparation = 'AUTONOMOUS' | 'AGENT_PREPARED' | 'HUMAN';

export const AUTOMATION_METRICS = [
  {
    id: 'AGENT_DRIVEN_RATIO',
    label: 'Agent-driven activity ratio',
    definition:
      'Autonomously completed plus agent-prepared or approved activities, over all eligible repeatable activities. Class C is excluded from the denominator: it is human-controlled by design, and counting it would make the target unreachable by construction rather than by performance.',
    target: '≥90% after stabilisation',
    unit: 'percent',
  },
  {
    id: 'STRAIGHT_THROUGH',
    label: 'Straight-through processing',
    definition:
      'Class A activities an agent completed which no person subsequently corrected on the same record. Reported per workflow, never blended.',
    target: 'Set per workflow, not one blended figure',
    unit: 'percent',
  },
  {
    id: 'HUMAN_EXCEPTION_RATE',
    label: 'Human exception rate',
    definition:
      'Agent outputs a person had to rework, weighted by what the record decides — a corrected commercial record counts double a corrected observation.',
    target: 'Trending downward',
    unit: 'weighted percent',
  },
  {
    id: 'BRIEF_TO_BASELINE',
    label: 'Brief-to-baseline cycle',
    definition:
      'Elapsed days from the first brief fact to the baseline being agreed, with days spent waiting on a customer decision measured separately rather than buried in the total.',
    target: 'Hours rather than weeks, data-wait excluded',
    unit: 'days',
  },
  {
    id: 'TENDER_PRODUCTION',
    label: 'Tender production cycle',
    definition:
      'Baseline agreed to first package issued, and package issued to award recommended. Two legs, because they fail for different reasons.',
    target: 'Measured per package',
    unit: 'days',
  },
  {
    id: 'MOBILISATION_PREDICTABILITY',
    label: 'Mobilisation predictability',
    definition:
      'Gates achieved before the system was due on site, and blocked days attributed to a root cause and an accountable party.',
    target: 'Gates achieved on the committed date',
    unit: 'percent',
  },
  {
    id: 'EVIDENCE_BACKED_VALUATION',
    label: 'Evidence-backed valuation',
    definition: 'Certified value supported by linked accepted progress, over total certified value.',
    target: '100%',
    unit: 'percent',
  },
  {
    id: 'SERVICE_RESTORATION',
    label: 'Service restoration',
    definition:
      'P1 and P2 acknowledgement within the severity window, and the age of temporary fixes still standing in for a permanent repair.',
    target: 'Within the severity window, no ageing temporary fix',
    unit: 'percent',
  },
  {
    id: 'FORECAST_ACCURACY',
    label: 'Forecast accuracy',
    definition:
      'Prior estimate at completion against final outturn, separated into approved change and customer-driven change.',
    target: 'Narrowing across projects',
    unit: 'percent',
  },
  {
    id: 'REINSTATEMENT_CLOSURE',
    label: 'Reinstatement closure',
    definition: 'Demobilisation workstreams accepted without a second attempt, and liabilities still open.',
    target: 'Accepted first time',
    unit: 'percent',
  },
] as const;

export type AutomationMetricId = (typeof AUTOMATION_METRICS)[number]['id'];

export type MetricResult = {
  id: AutomationMetricId;
  label: string;
  definition: string;
  target: string;
  unit: string;
  /**
   * The measured figure, where there is one.
   *
   * Absent means the records this metric reads have not been made yet — which
   * is a different statement from zero, and reported as a different statement.
   * A metric showing 0% because nothing has happened is the single easiest way
   * to make a working platform look broken, or a broken one look measured.
   */
  value?: number;
  /** How the figure was arrived at, or what is missing. Never omitted. */
  basis: string;
};

export type AutomationMeasure = {
  classes: typeof AUTOMATION_CLASSES;
  workflows: typeof AUTOMATION_WORKFLOWS;
  metrics: MetricResult[];
  target: number;
  /** Eligible activities, by workflow, with the ratio each achieved. */
  byWorkflow: {
    workflow: AutomationWorkflowId;
    label: string;
    section: string;
    eligible: number;
    autonomous: number;
    agentPrepared: number;
    human: number;
    ratioPercent?: number;
    straightThroughPercent?: number;
  }[];
  /** Every activity that has actually happened, with how it was done. */
  activities: {
    code: string;
    class: AutomationClassId;
    workflow: AutomationWorkflowId;
    count: number;
    autonomous: number;
    agentPrepared: number;
  }[];
  totals: { recorded: number; eligible: number; humanControlled: number; agentDriven: number };
  statement: string;
};

/**
 * Which of the three preparations an event was.
 *
 * `causationId` is followed one hop rather than transitively. A human act
 * caused by an agent proposal is agent-prepared; a human act caused by another
 * human act that was itself caused by an agent finding three weeks earlier is
 * not, and a transitive walk would eventually attribute the whole project to
 * the first agent that noticed anything.
 */
function preparationOf(event: GoldenThreadEvent, byId: Map<string, GoldenThreadEvent>): Preparation {
  if (event.actor.refType === 'AI') return 'AUTONOMOUS';
  if (event.ai !== undefined) return 'AGENT_PREPARED';
  if (event.causationId !== undefined) {
    const cause = byId.get(event.causationId);
    if (cause && (cause.actor.refType === 'AI' || cause.ai !== undefined)) return 'AGENT_PREPARED';
  }
  return 'HUMAN';
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

function percent(part: number, whole: number): number | undefined {
  if (whole <= 0) return undefined;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * §17, measured from the chain.
 *
 * Reads events rather than entities on purpose. An entity says what is true
 * now; the events say who did each thing and in what order, and "90% AI-driven"
 * is a claim about the second. It is also the only version that cannot be
 * improved by editing a record.
 */
export function automationMeasure(ctx: EngineContext, today?: string): AutomationMeasure {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const asAt = today ?? new Date().toISOString().slice(0, 10);
  // Elapsed time is measured against the instant, not against midnight of the
  // day. `daysBetween` against a bare date put the reference point *before*
  // events recorded earlier the same morning, so a cycle that had been running
  // two hours reported as "-1 days ago" — a negative elapsed time, which reads
  // as a broken clock rather than as a new project.
  const instant = today ? `${today}T23:59:59.999Z` : new Date().toISOString();
  const all = ctx.ledger.events({ projectId: ctx.projectId });
  const byId = new Map(all.map((event) => [event.eventId, event]));
  const etablix = all.filter((event) => ACTIVITIES[event.eventType] !== undefined);

  // Per activity code.
  const counts = new Map<string, { count: number; autonomous: number; agentPrepared: number }>();
  // Per entity, so a correction can be told from an original.
  const touches = new Map<string, { at: string; preparation: Preparation; code: string }[]>();

  for (const event of etablix) {
    const preparation = preparationOf(event, byId);
    const tally = counts.get(event.eventType) ?? { count: 0, autonomous: 0, agentPrepared: 0 };
    tally.count += 1;
    if (preparation === 'AUTONOMOUS') tally.autonomous += 1;
    if (preparation === 'AGENT_PREPARED') tally.agentPrepared += 1;
    counts.set(event.eventType, tally);

    const key = `${event.entity.refType}:${event.entity.refId}`;
    const list = touches.get(key) ?? [];
    list.push({ at: event.timestamp, preparation, code: event.eventType });
    touches.set(key, list);
  }

  const activities = [...counts.entries()]
    .map(([code, tally]) => ({
      code,
      class: ACTIVITIES[code]!.class,
      workflow: ACTIVITIES[code]!.workflow,
      ...tally,
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  // --- Straight-through: a Class A act an agent completed that nobody redid ---
  //
  // "Without human correction" is measured on the record, not on the activity.
  // A person recording a *different* fact is not a correction; a person writing
  // over the same entity after an agent wrote it is.
  let straightEligible = 0;
  let straightClean = 0;
  let correctedWeighted = 0;
  let agentOutputWeighted = 0;
  const perWorkflowStraight = new Map<AutomationWorkflowId, { eligible: number; clean: number }>();

  for (const [key, entries] of touches) {
    const refType = key.slice(0, key.indexOf(':'));
    // A commercial record being redone costs more than an observation being
    // redone, and §17 asks for severity weighting rather than a flat count.
    const weight = classifyEntity(refType)?.sensitivity === 'COMMERCIAL_L3' ? 2 : 1;
    const ordered = [...entries].sort((a, b) => a.at.localeCompare(b.at));

    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index]!;
      if (ACTIVITIES[entry.code]!.class !== 'A') continue;
      if (entry.preparation === 'HUMAN') continue;

      straightEligible += 1;
      agentOutputWeighted += weight;
      const corrected = ordered.slice(index + 1).some((later) => later.preparation === 'HUMAN');
      if (corrected) correctedWeighted += weight;
      else straightClean += 1;

      const workflow = ACTIVITIES[entry.code]!.workflow;
      const bucket = perWorkflowStraight.get(workflow) ?? { eligible: 0, clean: 0 };
      bucket.eligible += 1;
      if (!corrected) bucket.clean += 1;
      perWorkflowStraight.set(workflow, bucket);
    }
  }

  const byWorkflow = AUTOMATION_WORKFLOWS.map((workflow) => {
    const mine = activities.filter((entry) => entry.workflow === workflow.id);
    const eligibleEntries = mine.filter((entry) => entry.class !== 'C');
    const eligible = eligibleEntries.reduce((sum, entry) => sum + entry.count, 0);
    const autonomous = eligibleEntries.reduce((sum, entry) => sum + entry.autonomous, 0);
    const agentPrepared = eligibleEntries.reduce((sum, entry) => sum + entry.agentPrepared, 0);
    const straight = perWorkflowStraight.get(workflow.id);
    return {
      workflow: workflow.id,
      label: workflow.label,
      section: workflow.section,
      eligible,
      autonomous,
      agentPrepared,
      human: eligible - autonomous - agentPrepared,
      ...(percent(autonomous + agentPrepared, eligible) === undefined
        ? {}
        : { ratioPercent: percent(autonomous + agentPrepared, eligible)! }),
      ...(straight === undefined || percent(straight.clean, straight.eligible) === undefined
        ? {}
        : { straightThroughPercent: percent(straight.clean, straight.eligible)! }),
    };
  });

  const recorded = etablix.length;
  const eligibleTotal = activities.filter((e) => e.class !== 'C').reduce((sum, e) => sum + e.count, 0);
  const humanControlled = recorded - eligibleTotal;
  const agentDriven = activities
    .filter((e) => e.class !== 'C')
    .reduce((sum, e) => sum + e.autonomous + e.agentPrepared, 0);

  // --- The remaining metrics, each from the module that owns the record ------

  const first = (code: string): GoldenThreadEvent | undefined => etablix.find((e) => e.eventType === code);
  const last = (code: string): GoldenThreadEvent | undefined =>
    [...etablix].reverse().find((e) => e.eventType === code);

  const metrics: MetricResult[] = AUTOMATION_METRICS.map((metric): MetricResult => {
    const base = { id: metric.id, label: metric.label, definition: metric.definition, target: metric.target, unit: metric.unit };

    switch (metric.id) {
      case 'AGENT_DRIVEN_RATIO': {
        const value = percent(agentDriven, eligibleTotal);
        return {
          ...base,
          ...(value === undefined ? {} : { value }),
          basis:
            eligibleTotal === 0
              ? 'No eligible activity has been recorded on this project yet, so there is nothing to take a ratio of.'
              : `${agentDriven} of ${eligibleTotal} eligible activities were agent-driven. ${humanControlled} further ${
                  humanControlled === 1 ? 'activity is' : 'activities are'
                } Class C and excluded.`,
        };
      }
      case 'STRAIGHT_THROUGH': {
        const value = percent(straightClean, straightEligible);
        return {
          ...base,
          ...(value === undefined ? {} : { value }),
          basis:
            straightEligible === 0
              ? 'No Class A activity has been completed by an agent yet, so nothing can have gone straight through.'
              : `${straightClean} of ${straightEligible} agent-completed Class A activities were never written over by a person. The per-workflow split is the figure to act on.`,
        };
      }
      case 'HUMAN_EXCEPTION_RATE': {
        const value = percent(correctedWeighted, agentOutputWeighted);
        return {
          ...base,
          ...(value === undefined ? {} : { value }),
          basis:
            agentOutputWeighted === 0
              ? 'No agent output exists to have been reworked.'
              : `${correctedWeighted} of ${agentOutputWeighted} weighted agent outputs were later corrected by a person. Commercial records carry double weight.`,
        };
      }
      case 'BRIEF_TO_BASELINE': {
        const opened = first('SITE_SERVICE_FACT_RECORDED') ?? first('SITE_SERVICE_FACT_ASSUMED');
        const baseline = last('SITE_SERVICES_BASELINE_AGREED');
        if (!opened) return { ...base, basis: 'No brief fact has been recorded, so the clock has not started.' };
        if (!baseline) {
          return {
            ...base,
            basis: `The brief opened ${Math.max(0, daysBetween(opened.timestamp, instant))} days ago and no baseline has been agreed. The cycle is still running, so it has no elapsed figure yet.`,
          };
        }
        const elapsed = daysBetween(opened.timestamp, baseline.timestamp);
        const assumed = etablix.filter(
          (e) => e.eventType === 'SITE_SERVICE_FACT_ASSUMED' && e.timestamp <= baseline.timestamp,
        ).length;
        return {
          ...base,
          value: elapsed,
          basis: `${elapsed} days from the first brief fact to baseline. ${assumed} values were provisional at that point, which is the data-wait carried into the baseline rather than spent before it.`,
        };
      }
      case 'TENDER_PRODUCTION': {
        const baseline = first('SITE_SERVICES_BASELINE_AGREED');
        const issued = first('SERVICE_PACKAGE_TENDERED');
        const recommended = first('SERVICE_AWARD_RECOMMENDED');
        if (!issued) {
          return { ...base, basis: 'No package has been issued to tender, so neither leg of the cycle has run.' };
        }
        const legs: string[] = [];
        let value: number | undefined;
        if (baseline) {
          value = daysBetween(baseline.timestamp, issued.timestamp);
          legs.push(`${value} days from baseline to first issue`);
        } else {
          legs.push('no baseline event, so the first leg cannot be timed');
        }
        if (recommended) legs.push(`${daysBetween(issued.timestamp, recommended.timestamp)} days from issue to recommendation`);
        else legs.push('no award recommended yet, so the second leg is still running');
        return { ...base, ...(value === undefined ? {} : { value }), basis: `${legs[0]}; ${legs[1]}.` };
      }
      case 'MOBILISATION_PREDICTABILITY': {
        const position = mobilisationPosition(ctx, asAt);
        const due = position.systems.filter((system) => system.gates.length > 0);
        if (due.length === 0) return { ...base, basis: 'Nothing is composed, so no gate has a date to be measured against.' };
        const accepted = due.filter((system) => system.accepted).length;
        const blocked = due.filter((system) => !system.accepted);
        const value = percent(accepted, due.length);
        return {
          ...base,
          ...(value === undefined ? {} : { value }),
          basis:
            blocked.length === 0
              ? `All ${due.length} systems have a mobilisation acceptance certificate.`
              : `${accepted} of ${due.length} systems are accepted. ${blocked.map((system) => `${system.label} is at ${system.atGate}`).join('; ')}.`,
        };
      }
      case 'EVIDENCE_BACKED_VALUATION': {
        // Reading money needs commercial standing. A metric a site manager may
        // not see is reported as withheld rather than as zero.
        if (!mayReadCommercial(ctx)) {
          return { ...base, basis: 'Withheld: certified value is commercial-in-confidence and this session does not hold commercial standing.' };
        }
        const commercial = commercialPosition(ctx);
        const certified = commercial.totals.certifiedMinor;
        if (certified === 0) return { ...base, basis: 'Nothing has been certified, so there is no certified value to support.' };
        const supported = Math.min(commercial.totals.earnedMinor, certified);
        const value = percent(supported, certified);
        return {
          ...base,
          ...(value === undefined ? {} : { value }),
          basis:
            supported === certified
              ? 'Every certified pound is covered by accepted progress.'
              : `Certified value exceeds accepted progress. ${commercial.statement}`,
        };
      }
      case 'SERVICE_RESTORATION': {
        const operations = operationsPosition(ctx, asAt);
        const urgent = operations.events.filter((event) => event.severity === 'P1' || event.severity === 'P2');
        if (urgent.length === 0) return { ...base, basis: 'No P1 or P2 event has been raised on this project.' };
        const withinWindow = urgent.filter((event) => !event.acknowledgementBreached).length;
        const ageing = urgent.filter((event) => event.temporaryControl !== undefined && event.status !== 'CLOSED');
        const value = percent(withinWindow, urgent.length);
        return {
          ...base,
          ...(value === undefined ? {} : { value }),
          basis: `${withinWindow} of ${urgent.length} P1/P2 events were acknowledged inside the severity window. ${
            ageing.length === 0
              ? 'No temporary fix is still standing in for a permanent repair.'
              : `${ageing.length} temporary ${ageing.length === 1 ? 'control is' : 'controls are'} still standing in for a permanent repair.`
          }`,
        };
      }
      case 'FORECAST_ACCURACY': {
        // Deliberately not computed. A forecast is only accurate or otherwise
        // against an outturn, and an outturn exists once. Reporting a number
        // here from a live project would be reporting the forecast against
        // itself, which is always 100%.
        return {
          ...base,
          basis:
            'Not measurable on a live project: forecast accuracy compares a prior estimate at completion against a final outturn, and no site-services account on this project has been closed out. It becomes measurable at final account.',
        };
      }
      case 'REINSTATEMENT_CLOSURE': {
        const demob = demobilisationPosition(ctx);
        const opened = demob.workstreams.reduce((sum, stream) => sum + stream.accepted + stream.open, 0);
        if (opened === 0) return { ...base, basis: 'No demobilisation workstream has been opened yet.' };
        const accepted = demob.workstreams.reduce((sum, stream) => sum + stream.accepted, 0);
        const value = percent(accepted, opened);
        return {
          ...base,
          ...(value === undefined ? {} : { value }),
          basis: `${accepted} of ${opened} workstreams accepted. ${demob.statement}`,
        };
      }
      default:
        return { ...base, basis: 'Not measured.' };
    }
  });

  const ratio = percent(agentDriven, eligibleTotal);
  const statement =
    eligibleTotal === 0
      ? 'No eligible ETABLIX activity has been recorded on this project, so there is no automation ratio to report. That is not zero percent automated; it is nothing to measure.'
      : `${agentDriven} of ${eligibleTotal} eligible activities were agent-driven — ${ratio}% against a ${AUTOMATION_TARGET_PERCENT}% target. ${humanControlled} further ${
          humanControlled === 1 ? 'activity is' : 'activities are'
        } Class C, human-controlled by design and never counted towards the ratio.`;

  return {
    classes: AUTOMATION_CLASSES,
    workflows: AUTOMATION_WORKFLOWS,
    metrics,
    target: AUTOMATION_TARGET_PERCENT,
    byWorkflow,
    activities,
    totals: { recorded, eligible: eligibleTotal, humanControlled, agentDriven },
    statement,
  };
}

/**
 * Whether this session may read commercial-in-confidence figures.
 *
 * Asked rather than caught, because catching a `ForbiddenError` to decide what
 * to show turns an authorisation refusal into control flow, and the day
 * somebody adds a second reason for that error the screen starts silently
 * hiding data for the wrong reason.
 */
function mayReadCommercial(ctx: EngineContext): boolean {
  const COMMERCIAL_ROLES = ['OWNER', 'EPC', 'QS', 'PM', 'ENTERPRISE_ADMIN'];
  return ctx.auth.roles.some((role) => COMMERCIAL_ROLES.includes(role));
}

// --- §13 The eight workspaces --------------------------------------------------------

export type SourceId =
  | 'appointment'
  | 'brief'
  | 'sbs'
  | 'mobilisation'
  | 'procurement'
  | 'operations'
  | 'commercial'
  | 'change'
  | 'demobilisation';

export type WorkspaceQuestion = {
  id: string;
  /** One question, split out of §13's sentence. */
  question: string;
  /** True where the platform holds the records to answer it. */
  answered: boolean;
  /** Which position answers it, or nothing where it is not answerable yet. */
  from?: SourceId;
  /** How it is answered, or precisely what is missing. Never omitted. */
  basis: string;
};

export type Workspace = {
  id: string;
  label: string;
  /** §13's "must answer immediately", verbatim. */
  mustAnswer: string;
  audience: string;
  sources: readonly SourceId[];
  /** True where the workspace shows figures that need commercial standing. */
  commercial: boolean;
  questions: readonly WorkspaceQuestion[];
};

export const WORKSPACES: readonly Workspace[] = [
  {
    id: 'EXECUTIVE_PORTFOLIO',
    label: 'Executive Portfolio',
    mustAnswer:
      'Which projects/site-services are unsafe, late, under-capacity, overspending or cash-exposed? What requires my approval today?',
    audience: 'Directors and the accountable executive.',
    sources: ['brief', 'sbs', 'mobilisation', 'operations', 'commercial', 'change', 'demobilisation'],
    commercial: true,
    questions: [
      {
        id: 'UNSAFE',
        question: 'Which site services are unsafe?',
        answered: true,
        from: 'operations',
        basis: 'Open P1 and P2 events, and safety-critical mobilisation gates not passed.',
      },
      {
        id: 'LATE',
        question: 'Which are late?',
        answered: true,
        from: 'mobilisation',
        basis: 'Systems not accepted whose deployment window has started, and gates blocked by a prior gate.',
      },
      {
        id: 'UNDER_CAPACITY',
        question: 'Which are under capacity?',
        answered: true,
        from: 'sbs',
        basis: 'Demand derivations against the frozen design basis, and the drift where the live brief no longer agrees with it.',
      },
      {
        id: 'OVERSPENDING',
        question: 'Which are overspending?',
        answered: true,
        from: 'commercial',
        basis: 'Commitment against budget by contract line, with certified value beside earned value.',
      },
      {
        id: 'CASH_EXPOSED',
        question: 'Which are cash-exposed?',
        answered: true,
        from: 'change',
        basis: 'Risk-adjusted change exposure carried on the forecast from the day each change was raised.',
      },
      {
        id: 'MY_APPROVALS',
        question: 'What requires my approval today?',
        answered: true,
        from: 'mobilisation',
        basis:
          'Every panel entry names the capability its decision needs; the route resolves that to the people who hold it, so an executive sees the subset that is theirs.',
      },
      {
        id: 'PORTFOLIO_ROLLUP',
        question: 'The same, across every project at once.',
        answered: true,
        from: 'commercial',
        basis:
          'The portfolio roll-up walks every project of the caller’s own company through the same project context every other read uses — budget, commitment, earned, certified, paid, outstanding, estimate at completion and open changes per project and in total. A project the caller may not read, or one with nothing appointed, is listed as skipped with the reason rather than summed as zero.',
      },
    ],
  },
  {
    id: 'CUSTOMER_PROJECT',
    label: 'Customer Project',
    mustAnswer:
      'What was briefed, what changed, what is mobilised, what is failing, what is forecast and who owns recovery?',
    audience: 'The customer’s project team.',
    sources: ['appointment', 'brief', 'sbs', 'mobilisation', 'operations', 'commercial', 'change', 'demobilisation'],
    commercial: true,
    questions: [
      {
        id: 'BRIEFED',
        question: 'What was briefed?',
        answered: true,
        from: 'brief',
        basis: 'The fact register: every figure in force, its source, and every value it has previously held.',
      },
      {
        id: 'CHANGED',
        question: 'What changed?',
        answered: true,
        from: 'change',
        basis: 'The six change triggers, each with its entitlement view, probability and value.',
      },
      {
        id: 'MOBILISED',
        question: 'What is mobilised?',
        answered: true,
        from: 'mobilisation',
        basis: 'Gate position per system, with evidence satisfied over evidence required.',
      },
      {
        id: 'FAILING',
        question: 'What is failing?',
        answered: true,
        from: 'operations',
        basis: 'Open events by severity, and availability against the required service minutes.',
      },
      {
        id: 'FORECAST',
        question: 'What is forecast?',
        answered: true,
        from: 'commercial',
        basis: 'Budget, commitment, earned and certified, with unagreed change carried at risk-adjusted value.',
      },
      {
        id: 'RECOVERY_OWNER',
        question: 'Who owns recovery?',
        answered: true,
        from: 'operations',
        basis: 'Every entry carries the capability its decision needs, resolved to named people holding it.',
      },
    ],
  },
  {
    id: 'CONTROL_TOWER',
    label: 'ETABLIX Control Tower',
    mustAnswer:
      'Cross-package constraints, mobilisation gates, P1/P2 events, supplier exceptions, decision deadlines and agent health.',
    audience: 'The ETABLIX operating team.',
    sources: ['brief', 'sbs', 'mobilisation', 'procurement', 'operations', 'demobilisation'],
    commercial: false,
    questions: [
      {
        id: 'CROSS_PACKAGE',
        question: 'Cross-package constraints?',
        answered: true,
        from: 'sbs',
        basis: 'The interface matrix — every non-negotiable interface, and the ones with no owner on either side.',
      },
      {
        id: 'GATES',
        question: 'Mobilisation gates?',
        answered: true,
        from: 'mobilisation',
        basis: 'G0 to G6 per system, with what each gate is waiting on.',
      },
      {
        id: 'P1_P2',
        question: 'P1/P2 events?',
        answered: true,
        from: 'operations',
        basis: 'Open events at the two severities that carry an acknowledgement window.',
      },
      {
        id: 'SUPPLIER_EXCEPTIONS',
        question: 'Supplier exceptions?',
        answered: true,
        from: 'procurement',
        basis: 'Engagements suspended or held below ACTIVE, with the entry check that is failing.',
      },
      {
        id: 'DEADLINES',
        question: 'Decision deadlines?',
        answered: true,
        from: 'mobilisation',
        basis: 'The NEXT list: everything falling due inside 2, 7 or 30 days, with what happens if it is missed.',
      },
      {
        id: 'AGENT_HEALTH',
        question: 'Agent health?',
        answered: true,
        basis:
          'The automation measure: activity counts by class and workflow, straight-through rate and the exception rate that says where agent output is being redone.',
      },
    ],
  },
  {
    id: 'COMMERCIAL',
    label: 'Commercial',
    mustAnswer: 'Budget, commitment, EV, certified, paid, accrual, change, contingency, EAC, cash and model-specific exposure.',
    audience: 'Commercial managers and quantity surveyors.',
    sources: ['appointment', 'commercial', 'change', 'procurement'],
    commercial: true,
    questions: [
      {
        id: 'BUDGET_COMMITMENT_EV',
        question: 'Budget, commitment and earned value?',
        answered: true,
        from: 'commercial',
        basis: 'Per contract line, with the earned-value method stated on each.',
      },
      {
        id: 'CERTIFIED',
        question: 'Certified?',
        answered: true,
        from: 'commercial',
        basis: 'Certified value per valuation, and the exceptions raised against each application.',
      },
      {
        id: 'CHANGE',
        question: 'Change?',
        answered: true,
        from: 'change',
        basis: 'Agreed value at face, plus unagreed exposure risk-adjusted.',
      },
      {
        id: 'MODEL_EXPOSURE',
        question: 'Model-specific exposure?',
        answered: true,
        from: 'appointment',
        basis: 'The appointment in force decides whether ETABLIX carries supplier payment liability at all.',
      },
      {
        id: 'PAID_ACCRUAL_CASH',
        question: 'Paid, accrual and cash?',
        answered: true,
        from: 'commercial',
        basis:
          'Payments are recorded against a certified valuation under the bank’s own reference, never above the certificate. The cash position keeps three numbers apart: earned (accepted work), certified (what a certificate says is owed) and paid (what has arrived) — accrual is earned above certified, outstanding is certified above paid, and the outstanding sum is split by who owes it under the appointment.',
      },
      {
        id: 'CONTINGENCY_EAC',
        question: 'Contingency and estimate at completion?',
        answered: true,
        from: 'commercial',
        basis:
          'A contingency pot is set with its basis and drawn against with a reason, never below what has already left it. The estimate at completion is the higher of commitment and earned, plus agreed change at face, plus unagreed change at risk-adjusted value; headroom is budget plus pot less the EAC, and every term is published beside the total.',
      },
    ],
  },
  {
    id: 'PROCUREMENT',
    label: 'Procurement',
    mustAnswer:
      'Package status, bidder coverage, return quality, evaluation conflicts, approvals, contract placement and supplier evidence.',
    audience: 'Buyers and the supply-chain team.',
    sources: ['sbs', 'procurement', 'mobilisation'],
    commercial: false,
    questions: [
      {
        id: 'PACKAGE_STATUS',
        question: 'Package status?',
        answered: true,
        from: 'procurement',
        basis: 'The twelve package requirements per package, five derived and seven stated, with what is outstanding.',
      },
      {
        id: 'BIDDER_COVERAGE',
        question: 'Bidder coverage?',
        answered: true,
        from: 'procurement',
        basis: 'Eligible bidders per package against the competition floor, from the trade register.',
      },
      {
        id: 'RETURN_QUALITY',
        question: 'Return quality?',
        answered: true,
        from: 'procurement',
        basis: 'Returns received against returns locked, and the normalisation bases each return failed.',
      },
      {
        id: 'EVALUATION_CONFLICTS',
        question: 'Evaluation conflicts?',
        answered: true,
        from: 'procurement',
        basis: 'Bid normalisation reports every exclusion, qualification and nil line rather than averaging over them.',
      },
      {
        id: 'CONTRACT_PLACEMENT',
        question: 'Contract placement?',
        answered: true,
        from: 'procurement',
        basis: 'The nine supplier control states, and the entry check blocking the next one.',
      },
      {
        id: 'SUPPLIER_EVIDENCE',
        question: 'Supplier evidence?',
        answered: true,
        from: 'mobilisation',
        basis: 'Gate evidence attested per system, with expiry, so a lapsed certificate reads as lapsed rather than missing.',
      },
    ],
  },
  {
    id: 'SUPPLIER_PORTAL',
    label: 'Supplier Portal',
    mustAnswer:
      'Required submittals, tender returns, mobilisation tasks, work orders, KPI, valuation, corrective actions and payment state.',
    audience: 'One named supplier.',
    sources: ['procurement', 'mobilisation', 'operations'],
    commercial: false,
    questions: [
      {
        id: 'SUBMITTALS',
        question: 'Required submittals?',
        answered: true,
        from: 'mobilisation',
        basis: 'Gate evidence not yet attested on the systems this supplier’s packages cover.',
      },
      {
        id: 'TENDER_RETURNS',
        question: 'Tender returns?',
        answered: true,
        from: 'procurement',
        basis: 'Packages issued to this supplier, and whether a return is in and locked.',
      },
      {
        id: 'MOBILISATION_TASKS',
        question: 'Mobilisation tasks?',
        answered: true,
        from: 'mobilisation',
        basis: 'The gate the system is at, and the evidence standing between it and the next one.',
      },
      {
        id: 'WORK_ORDERS',
        question: 'Work orders and corrective actions?',
        answered: true,
        from: 'operations',
        basis: 'Open service events on the systems this supplier delivers, with the closure evidence each demands.',
      },
      {
        id: 'KPI',
        question: 'KPI?',
        answered: true,
        from: 'operations',
        basis: 'Availability and the KPI families that apply to the families this supplier serves.',
      },
      {
        id: 'PAYMENT_STATE',
        question: 'Valuation and payment state?',
        answered: true,
        from: 'commercial',
        basis:
          'The firm’s own contract lines under award: earned, certified per certificate and paid, apportioned where a certificate carries other firms’ lines. Read by the supplier’s own sign-in, resolved to the firm by the party the invitation gave it (etablix/portal.ts).',
      },
    ],
  },
  {
    id: 'FIELD_MOBILE',
    label: 'Field Mobile',
    mustAnswer:
      'Offline inspections, QR asset scan, photo/video/voice evidence, work order, delivery check, occupancy and incident capture.',
    audience: 'Anyone standing on the site.',
    sources: ['sbs', 'mobilisation', 'operations'],
    commercial: false,
    questions: [
      {
        id: 'WORK_ORDER',
        question: 'Work order capture?',
        answered: true,
        from: 'operations',
        basis: 'A service event is the work order: raise, acknowledge, attend, evidence, close.',
      },
      {
        id: 'INCIDENT',
        question: 'Incident capture?',
        answered: true,
        from: 'operations',
        basis: 'P1 and P2 raise with a temporary control requirement and an unpausable clock.',
      },
      {
        id: 'EVIDENCE_CAPTURE',
        question: 'Photo, video and voice evidence?',
        answered: true,
        from: 'operations',
        basis:
          'Closure evidence carries a kind and a reference into the tenant-scoped object store; the installed field app records the device and the offline timestamp.',
      },
      {
        id: 'INSPECTION',
        question: 'Offline inspections?',
        answered: true,
        from: 'sbs',
        basis: 'Site observations record what was actually found against what the design basis assumed.',
      },
      {
        id: 'QR_ASSET',
        question: 'QR asset scan?',
        answered: true,
        from: 'operations',
        basis:
          'Every unit is registered under its composed system with the tag its code carries, unique on the project. A scan resolves the tag to the unit and records the scan, its location and its state against it; a tag that resolves to nothing says so.',
      },
      {
        id: 'DELIVERY_CHECK',
        question: 'Delivery check?',
        answered: true,
        from: 'operations',
        basis:
          'A delivery is scheduled with what is expected and when, and checked in against that: received, short with the discrepancy named, or refused. An expected delivery past its day is overdue on the desk.',
      },
      {
        id: 'OCCUPANCY',
        question: 'Occupancy?',
        answered: true,
        from: 'operations',
        basis:
          'Who is in which bed tonight, from check-ins against allocations under registered rooms; free beds, arrivals due and rooms awaiting housekeeping beside it, read against the bed demand the brief holds.',
      },
    ],
  },
  {
    id: 'ACCOMMODATION_DESK',
    label: 'Accommodation Desk',
    mustAnswer:
      'Room/bed inventory, allocations, arrivals/departures, housekeeping status, maintenance, transport and welfare requests.',
    audience: 'The accommodation and welfare team.',
    sources: ['brief', 'sbs', 'operations', 'demobilisation'],
    commercial: false,
    questions: [
      {
        id: 'BED_DEMAND',
        question: 'How many beds does the site need?',
        answered: true,
        from: 'sbs',
        basis: 'The demand engine derives bed requirement from the workforce curve, with the assumptions stated.',
      },
      {
        id: 'MAINTENANCE',
        question: 'Maintenance?',
        answered: true,
        from: 'operations',
        basis: 'Service events on the accommodation and welfare systems, with the defect types that apply to them.',
      },
      {
        id: 'WELFARE_REQUESTS',
        question: 'Welfare requests?',
        answered: true,
        from: 'operations',
        basis: 'Raised as P3 or P4 events against the welfare system, with the same clock and closure contract.',
      },
      {
        id: 'RUNDOWN',
        question: 'Departures, at the point they release accommodation?',
        answered: true,
        from: 'demobilisation',
        basis: 'A run-down proposal states the people remaining, and is refused where it would drop welfare below statutory provision.',
      },
      {
        id: 'INVENTORY',
        question: 'Room and bed inventory, allocations, arrivals and housekeeping status?',
        answered: true,
        from: 'operations',
        basis:
          'Rooms are registered beneath the composed accommodation system with their beds; a bed is allocated to a named occupant for dated nights, checked in and checked out. A vacated room goes to cleaning by the record, a room taken out of service refuses allocation, and the desk reads inventory against the demand the system was composed for.',
      },
      {
        id: 'TRANSPORT',
        question: 'Transport?',
        answered: true,
        from: 'operations',
        basis:
          'Journeys are scheduled with a vehicle, a route, a departure and seats; seats are booked by name, never beyond the seats; a journey departs, arrives or is cancelled with a reason. The desk reads today’s journeys and their load factor.',
      },
    ],
  },
];

const WORKSPACE_BY_ID = new Map(WORKSPACES.map((workspace) => [workspace.id, workspace]));

export type WorkspaceId = string;

// --- §13.1 The universal Now / Next / Why / Action panel ------------------------------

/** NOW's four subjects, from §13.1's sentence. */
export const NOW_SUBJECTS = [
  { id: 'SERVICE_HEALTH', label: 'Service health', detail: 'What the service is actually delivering, against what it was required to.' },
  { id: 'CRITICAL_EVENT', label: 'Active critical events', detail: 'What is failing right now, and whether its clock is running.' },
  { id: 'CAPACITY', label: 'Capacity against demand', detail: 'Whether what is on site still matches what the site needs.' },
  { id: 'CONSTRAINT', label: 'Mobilisation and delivery constraints', detail: 'What is stopping something arriving, connecting or starting.' },
] as const;

export type NowSubject = (typeof NOW_SUBJECTS)[number]['id'];

/** NEXT's six needs, from §13.1's sentence. */
export const NEXT_NEEDS = [
  { id: 'EVIDENCE', label: 'Evidence', detail: 'A certificate, test or record that has to exist by a date.' },
  { id: 'SPACE', label: 'Space', detail: 'Land or a footprint that has to be released or made available.' },
  { id: 'UTILITIES', label: 'Utilities', detail: 'A connection that has to be live before something can work.' },
  { id: 'SUPPLIER_ACTION', label: 'Supplier action', detail: 'Something a supplier owes, on a date.' },
  { id: 'APPROVAL', label: 'Approval', detail: 'A decision a named person has to take.' },
  { id: 'FUNDING', label: 'Funding', detail: 'Money that has to be committed, certified or released.' },
] as const;

export type NextNeed = (typeof NEXT_NEEDS)[number]['id'];

export type Tone = 'CRITICAL' | 'WARNING' | 'INFO' | 'OK';

/**
 * The owner of a decision, as the domain can express it.
 *
 * Roles rather than names, because the domain layer holds no identity
 * directory: `EngineContext` carries the caller's auth, not the project's
 * people. `nameOwners` resolves these to named individuals at the route, which
 * is the only layer that has the tenancy's identities to hand. Keeping the
 * resolution out of here is what stops this module growing a second, divergent
 * copy of the ownership rules in `identity/ownership.ts`.
 */
export type OwnerSpec = { roles: readonly string[]; basis: string; named?: DecisionOwner[] };

export type PanelEntry = {
  id: string;
  horizon: 'NOW' | 'NEXT';
  /**
   * The position this entry was derived from.
   *
   * Recorded so a tag can be checked rather than trusted. An entry listed on a
   * workspace whose `sources` do not include this is dead code — the workspace
   * never fetches that position, so the entry cannot appear there — and it is
   * the kind of dead code that looks like a working feature until somebody
   * opens the screen expecting it.
   */
  from: SourceId;
  /** NOW only. */
  subject?: NowSubject;
  /** NEXT only. */
  need?: NextNeed;
  headline: string;
  tone: Tone;
  workspaces: readonly WorkspaceId[];
  /**
   * §13.1's WHY, as a required field rather than a tab.
   *
   * `rule` is the rule that produced the status. `evidence` is what was read to
   * apply it. `source` is the record itself, so the reader can open it.
   */
  why: { rule: string; evidence: string; source?: EntityRef };
  /**
   * §13.1's ACTION, in full. Every field is required except the deadline, and
   * the deadline's absence is explained rather than left blank.
   */
  action: {
    decision: string;
    owner: OwnerSpec;
    dueAt?: string;
    /** How the deadline was arrived at, or that no date exists. Never omitted. */
    deadlineBasis: string;
    consequence: string;
    /** What an agent has already prepared, so the decision is not started cold. */
    prepared: string;
  };
  /** NEXT only: which of §13.1's three windows it falls in. */
  withinDays?: 2 | 7 | 30;
  /** True where the date has already passed. */
  overdue?: boolean;
};

export type CommandCentre = {
  workspace: Workspace;
  workspaces: { id: string; label: string; mustAnswer: string; audience: string }[];
  subjects: typeof NOW_SUBJECTS;
  needs: typeof NEXT_NEEDS;
  now: PanelEntry[];
  next: PanelEntry[];
  /** What the panel could not assemble, and why. */
  unanswered: WorkspaceQuestion[];
  statement: string;
};

const OWNER_SITE = {
  roles: ['CONSTRUCTION_MANAGER', 'SITE_MANAGER', 'PM'],
  basis: 'Site delivery: whoever is running the compound decides, escalating to the project manager.',
};
const OWNER_COMMERCIAL = {
  roles: ['QS', 'COMMERCIAL_MANAGER', 'PM'],
  basis: 'Commercial control: the quantity surveyor holds it, the commercial manager and PM behind them.',
};
const OWNER_DESIGN = {
  roles: ['DESIGNER', 'PM', 'CONSTRUCTION_MANAGER'],
  basis: 'Design basis: the designer answers it, delivery carries the consequence.',
};
const OWNER_SAFETY = {
  roles: ['SAFETY', 'CONSTRUCTION_MANAGER', 'PM'],
  basis: 'Safety-critical: the safety lead decides, delivery executes.',
};
const OWNER_BUYER = {
  roles: ['QS', 'PM', 'PROJECT_DIRECTOR'],
  basis: 'Procurement: the buyer holds it; award authority sits above them.',
};

function horizonOf(dueAt: string, today: string): { withinDays?: 2 | 7 | 30; overdue: boolean } {
  const days = daysBetween(today, dueAt);
  if (days < 0) return { withinDays: 2, overdue: true };
  if (days <= 2) return { withinDays: 2, overdue: false };
  if (days <= 7) return { withinDays: 7, overdue: false };
  if (days <= 30) return { withinDays: 30, overdue: false };
  return { overdue: false };
}

/** Utility interfaces, so a NEXT entry can say utilities rather than "an interface". */
const UTILITY_INTERFACES = new Set([
  'Power',
  'Potable water',
  'Foul drainage',
  'Surface water',
  'Comms',
  'Ground bearing',
]);

/**
 * Assemble one workspace's panel.
 *
 * `subjectId` scopes the workspaces that are about one thing — the supplier
 * portal is one supplier's obligations, and an unscoped one would be every
 * supplier's, which is a different screen and a confidentiality problem.
 */
export function commandCentre(
  ctx: EngineContext,
  workspaceId: WorkspaceId,
  options: { today?: string; supplierId?: string } = {},
): CommandCentre {
  requireModule(ctx.grantedModules, 'ETABLIX');
  authorise(ctx, 'SITE_SERVICES', 'R');

  const workspace = WORKSPACE_BY_ID.get(workspaceId);
  if (!workspace) {
    throw new DomainError(
      'WORKSPACE_UNKNOWN',
      `"${workspaceId}" is not one of the eight command centres: ${WORKSPACES.map((entry) => entry.id).join(', ')}`,
      404,
    );
  }
  if (workspace.commercial) authorise(ctx, 'SITE_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  if (workspace.id === 'SUPPLIER_PORTAL' && options.supplierId === undefined) {
    throw new DomainError(
      'SUPPLIER_REQUIRED',
      'The supplier portal is one supplier’s obligations. Name the supplier: an unscoped portal would show every supplier their competitors’ position.',
    );
  }

  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const uses = (source: SourceId): boolean => workspace.sources.includes(source);
  const entries: PanelEntry[] = [];

  // Only the positions this workspace declares are read. See the header: this
  // is authorisation, not tidiness.
  const brief = uses('brief') ? briefReadiness(ctx, today) : undefined;
  const design = uses('sbs') ? sbs(ctx, today) : undefined;
  const mobilisation = uses('mobilisation') ? mobilisationPosition(ctx, today) : undefined;
  const procurement = uses('procurement') ? procurementPosition(ctx, today) : undefined;
  const operations = uses('operations') ? operationsPosition(ctx, today) : undefined;
  const money = uses('commercial') ? commercialPosition(ctx) : undefined;
  const changes = uses('change') ? changePosition(ctx, today) : undefined;
  const demob = uses('demobilisation') ? demobilisationPosition(ctx) : undefined;
  const appointment = uses('appointment') ? appointmentPosition(ctx) : undefined;

  const systemLabels = new Map<string, string>();
  for (const system of design?.systems ?? []) systemLabels.set(system.id, `${system.label} (${system.zone})`);
  for (const system of mobilisation?.systems ?? []) systemLabels.set(system.systemId, `${system.label} (${system.zone})`);

  const on = (...ids: WorkspaceId[]): WorkspaceId[] => ids;

  // --- NOW: active critical events ------------------------------------------
  for (const event of operations?.events ?? []) {
    if (event.status === 'CLOSED') continue;
    const urgent = event.severity === 'P1' || event.severity === 'P2';
    if (!urgent && !event.acknowledgementBreached) continue;
    entries.push({
      id: `event:${event.id}`,
      horizon: 'NOW',
      from: 'operations',
      subject: 'CRITICAL_EVENT',
      headline: `${event.severityLabel} — ${event.summary}`,
      tone: event.severity === 'P1' ? 'CRITICAL' : event.acknowledgementBreached ? 'CRITICAL' : 'WARNING',
      workspaces: on('EXECUTIVE_PORTFOLIO', 'CUSTOMER_PROJECT', 'CONTROL_TOWER', 'SUPPLIER_PORTAL', 'FIELD_MOBILE', 'ACCOMMODATION_DESK'),
      why: {
        rule: `${event.severity} carries an acknowledgement window and a closure evidence contract; an unacknowledged event past its window is breached now, not once somebody acknowledges it.`,
        evidence: event.acknowledgementBreached
          ? `Raised ${event.raisedAt}, open ${event.minutesOpen} minutes, acknowledgement window exceeded.`
          : `Raised ${event.raisedAt}, open ${event.minutesOpen} minutes. ${
              event.blocking.length === 0 ? 'Nothing blocking closure.' : `Blocking closure: ${event.blocking.join('; ')}.`
            }`,
        source: { refType: 'ServiceEvent', refId: event.id },
      },
      action: {
        decision:
          event.blocking.length === 0
            ? 'Close the event against its evidence.'
            : `Clear what is blocking closure: ${event.blocking.join('; ')}.`,
        owner: event.severity === 'P1' ? OWNER_SAFETY : OWNER_SITE,
        // The day it was raised, because that is when it was due. Leaving the
        // deadline blank on the one thing with no grace period at all read as
        // "no date", which is the opposite of what a P1 means.
        dueAt: event.raisedAt.slice(0, 10),
        deadlineBasis:
          event.severity === 'P1'
            ? 'P1 has no acknowledgement grace at all and its clock cannot be paused, so it was due the moment it was raised.'
            : `The ${event.severity} acknowledgement window ran from the moment it was raised.`,
        consequence: `${event.defectLabel} on ${systemLabels.get(event.systemId) ?? event.zone}. An open event of this severity is a KPI failure and a service credit at the next valuation.`,
        prepared: `Classified as ${event.defectLabel} from ${event.source}, with the closure evidence contract for that defect already attached.`,
      },
    });
  }

  // --- NOW: service health ---------------------------------------------------
  for (const view of operations?.availability ?? []) {
    if (view.periods === 0) continue;
    if (view.availabilityPercent >= 100 && view.degradedMinutes === 0) continue;
    entries.push({
      id: `availability:${view.systemId}`,
      horizon: 'NOW',
      from: 'operations',
      subject: 'SERVICE_HEALTH',
      headline: `${view.label} available ${view.availabilityPercent}% of required minutes`,
      tone: view.availabilityPercent < 100 ? 'WARNING' : 'INFO',
      workspaces: on('EXECUTIVE_PORTFOLIO', 'CUSTOMER_PROJECT', 'CONTROL_TOWER', 'SUPPLIER_PORTAL', 'ACCOMMODATION_DESK'),
      why: {
        rule: 'Availability is available minutes over required minutes with approved exclusions removed from both. A planned exclusion counts only if it was approved before the event, and degraded capacity is never counted as available.',
        evidence: `${view.availableMinutes} available of ${view.requiredMinutes} required across ${view.periods} ${
          view.periods === 1 ? 'period' : 'periods'
        }; ${view.degradedMinutes} degraded, ${view.excludedMinutes} excluded. Ignoring every exclusion the figure is ${view.rawPercent}%.`,
        source: { refType: 'ServiceSystem', refId: view.systemId },
      },
      action: {
        decision:
          view.excludedMinutes > 0
            ? 'Confirm each exclusion was approved before the outage it covers, then agree the KPI position for the period.'
            : 'Agree the KPI position for the period and whether a service credit arises.',
        owner: OWNER_SITE,
        deadlineBasis: 'No contractual date: this is the standing position between service periods, and it settles at the next valuation.',
        consequence: `The gap between ${view.availabilityPercent}% and ${view.rawPercent}% is the size of the argument about what was planned. Unresolved, it is argued at the certificate.`,
        prepared: 'Both figures are derived from recorded periods rather than declared, and the exclusions are itemised.',
      },
    });
  }

  // --- NOW: capacity against demand -----------------------------------------
  for (const conflict of brief?.conflicts ?? []) {
    entries.push({
      id: `conflict:${conflict.id}`,
      horizon: 'NOW',
      from: 'brief',
      subject: 'CAPACITY',
      headline: conflict.statement,
      tone: conflict.severity === 'BLOCKING' ? 'CRITICAL' : 'WARNING',
      workspaces: on('EXECUTIVE_PORTFOLIO', 'CUSTOMER_PROJECT', 'CONTROL_TOWER', 'ACCOMMODATION_DESK'),
      why: {
        rule: 'A conflict is between two families’ figures, and it is recorded with both numbers in it rather than as a warning that something disagrees.',
        evidence: `Between ${conflict.families.join(' and ')}. ${conflict.severity === 'BLOCKING' ? 'Blocking: capacity cannot be approved while it stands.' : 'Material: approvable, but the consequence is priced.'}`,
      },
      action: {
        decision: conflict.resolution,
        owner: OWNER_DESIGN,
        deadlineBasis: 'No date: a brief conflict has no contractual clock, and it blocks the baseline rather than a milestone.',
        consequence: 'Approving capacity over an unresolved conflict is the single most expensive silent decision on a site-services baseline.',
        prepared: 'The conflict, both figures and the resolution are already stated; what is needed is a choice, not analysis.',
      },
    });
  }
  for (const missing of design?.demand.notDerivable ?? []) {
    entries.push({
      id: `notderivable:${missing.id}`,
      horizon: 'NOW',
      from: 'sbs',
      subject: 'CAPACITY',
      headline: `${missing.label} cannot be calculated`,
      tone: 'WARNING',
      workspaces: on('CUSTOMER_PROJECT', 'CONTROL_TOWER', 'ACCOMMODATION_DESK'),
      why: {
        rule: 'The demand engine refuses to derive a figure from facts it does not hold. A capacity nobody can calculate is reported as uncalculable, never as zero.',
        evidence: `Missing: ${missing.missing.join(', ')}.`,
      },
      action: {
        decision: `Record ${missing.missing.join(', ')}, or state a provisional value with a decision date against it.`,
        owner: OWNER_DESIGN,
        deadlineBasis: 'No date: the gap blocks a derivation, not a milestone, until something is sized against it.',
        consequence: 'Every system sized from this derivation is unsized until it is answered.',
        prepared: 'The engine names the exact inputs it is short of, so the question to ask is already written.',
      },
    });
  }
  for (const system of design?.systems ?? []) {
    for (const drift of system.drift) {
      const direction = drift.changePercent > 0 ? 'grown' : 'fallen';
      entries.push({
        id: `drift:${system.id}:${drift.derivationId}`,
        horizon: 'NOW',
        from: 'sbs',
        subject: 'CAPACITY',
        headline: `${system.label}: ${drift.label} has ${direction} ${Math.abs(drift.changePercent)}% since the basis was frozen`,
        tone: 'WARNING',
        workspaces: on('EXECUTIVE_PORTFOLIO', 'CUSTOMER_PROJECT', 'CONTROL_TOWER'),
        why: {
          rule: 'A system is composed against a frozen design basis. Where the live brief has moved past it, the system is sized to a number nobody is working to any more.',
          evidence: `Composed against ${drift.composedAt} ${drift.unit}; the live figure is ${drift.now} ${drift.unit}. ${drift.consequence}`,
          source: { refType: 'ServiceSystem', refId: system.id },
        },
        action: {
          decision: 'Recompose the system against the live basis, or record why the frozen basis still holds.',
          owner: OWNER_DESIGN,
          deadlineBasis: `No date: drift accumulates from the day the fact changed. The system is on site from ${system.fromDate}.`,
          consequence: 'A system sized to a superseded figure is under or over capacity for as long as it stands, and the hire cost is committed either way.',
          prepared: 'The live derivation and the frozen basis are both on the record, so the delta is already calculated.',
        },
      });
    }
  }

  // --- NOW: mobilisation and delivery constraints ---------------------------
  for (const system of mobilisation?.systems ?? []) {
    if (system.accepted) continue;
    const gate = system.gates.find((entry) => entry.id === system.atGate);
    const outstanding = gate?.evidence.filter((item) => !item.satisfied) ?? [];
    const startsAt = systemStart(design, system.systemId);
    entries.push({
      id: `gate:${system.systemId}`,
      horizon: 'NOW',
      from: 'mobilisation',
      subject: 'CONSTRAINT',
      headline: `${system.label} held at ${system.atGate}${gate ? ` — ${gate.name}` : ''}`,
      tone: startsAt !== undefined && startsAt <= today ? 'CRITICAL' : 'WARNING',
      workspaces: on('EXECUTIVE_PORTFOLIO', 'CUSTOMER_PROJECT', 'CONTROL_TOWER', 'PROCUREMENT', 'SUPPLIER_PORTAL', 'FIELD_MOBILE'),
      why: {
        rule: 'A gate passes on evidence, not on a declaration. A supplier declaring 100% moves nothing, and a prior gate that has not passed blocks every gate after it.',
        evidence:
          outstanding.length === 0
            ? `Evidence complete at ${system.atGate}; the gate is awaiting approval. ${system.evidencePercent}% of all gate evidence is in place.`
            : `Outstanding at ${system.atGate}: ${outstanding.map((item) => item.label).join('; ')}. ${system.evidencePercent}% of all gate evidence is in place.`,
        source: { refType: 'ServiceSystem', refId: system.systemId },
      },
      action: {
        decision:
          outstanding.length === 0 ? `Approve ${system.atGate}.` : `Obtain: ${outstanding.map((item) => item.label).join('; ')}.`,
        owner: gate?.safetyCritical ? OWNER_SAFETY : { roles: [...(gate?.approvers ?? OWNER_SITE.roles)], basis: 'The roles the gate itself nominates.' },
        ...(startsAt === undefined ? {} : { dueAt: startsAt }),
        deadlineBasis:
          startsAt === undefined
            ? 'No deployment date is recorded against this system, so the gate has no date to be late against.'
            : `The system is required on site from ${startsAt}.`,
        consequence:
          system.declarations.length > 0
            ? 'A supplier has declared progress on this system; the declaration is recorded and moves nothing. Without the gate there is no operational-ready state.'
            : 'Without the gate there is no operational-ready state, and nothing downstream of it may start.',
        prepared: `Every evidence item for ${system.atGate} is listed with what satisfies it, and the derived items are already evaluated.`,
      },
    });
  }
  for (const exception of design?.deployment ?? []) {
    entries.push({
      id: `deployment:${exception.systemId}:${exception.kind}`,
      horizon: 'NOW',
      from: 'sbs',
      subject: 'CONSTRAINT',
      headline: exception.statement,
      tone: exception.kind === 'PREMATURE_REMOVAL' ? 'CRITICAL' : 'WARNING',
      workspaces: on('EXECUTIVE_PORTFOLIO', 'CUSTOMER_PROJECT', 'CONTROL_TOWER', 'FIELD_MOBILE'),
      why: {
        rule: 'Stranded hire and premature removal are opposite failures read off the same deployment windows. Premature removal is the worse of the two: something still depends on what is being taken away.',
        evidence: exception.statement,
        source: { refType: 'ServiceSystem', refId: exception.systemId },
      },
      action: {
        decision: exception.resolution,
        owner: OWNER_SITE,
        deadlineBasis: 'No single date: the exception is read from the window itself, and the window is what has to move.',
        consequence:
          exception.kind === 'PREMATURE_REMOVAL'
            ? 'A system removed while a successor still depends on it takes the successor down with it.'
            : 'Hire charges continue against an asset nothing needs.',
        prepared: 'The clash is derived from the deployment windows and the interfaces between them, with the resolution already stated.',
      },
    });
  }
  const unowned = (design?.interfaceMatrix ?? []).filter((row) => row.unowned > 0);
  if (unowned.length > 0) {
    // One entry, not one per interface name. Six paragraphs each saying "name
    // the counterparty" is six paragraphs of the same decision by the same
    // person, and a panel that repeats itself is a panel people stop reading.
    // The names are all in it, so nothing is lost.
    const total = unowned.reduce((sum, row) => sum + row.unowned, 0);
    entries.push({
      id: 'interface-unowned',
      horizon: 'NOW',
      from: 'sbs',
      subject: 'CONSTRAINT',
      headline: `${total} ${total === 1 ? 'interface has' : 'interfaces have'} nobody on the other side`,
      tone: 'WARNING',
      workspaces: on('CONTROL_TOWER', 'CUSTOMER_PROJECT', 'PROCUREMENT'),
      why: {
        rule: 'An interface with nobody on the other side is not an open action; it is an action nobody has. It stays visible until a party is named.',
        evidence: unowned
          .map((row) => `${row.name}: ${row.unowned} unowned of ${row.open + row.accepted}`)
          .join('; '),
      },
      action: {
        decision: `Name the party on the other side of each: ${unowned.map((row) => row.name).join(', ')}.`,
        owner: OWNER_DESIGN,
        deadlineBasis: 'No date can exist: an unowned interface has nobody to owe one.',
        consequence: 'Each of these is a dependency somebody will discover on the day it fails.',
        prepared: 'The consequence of every interface never closing was stated when it was raised, not at failure.',
      },
    });
  }

  // --- NEXT: evidence expiring ----------------------------------------------
  for (const item of mobilisation?.expiringSoon ?? []) {
    const window = horizonOf(item.expiresAt, today);
    entries.push({
      id: `expiring:${item.systemId}:${item.itemId}`,
      horizon: 'NEXT',
      from: 'mobilisation',
      need: 'EVIDENCE',
      headline: `${item.label}: ${item.itemId} expires ${item.expiresAt}`,
      tone: window.overdue ? 'CRITICAL' : window.withinDays === 2 ? 'CRITICAL' : 'WARNING',
      workspaces: on('CONTROL_TOWER', 'PROCUREMENT', 'SUPPLIER_PORTAL', 'CUSTOMER_PROJECT'),
      ...window,
      why: {
        rule: 'Expired evidence is not evidence, and it is reported as expired rather than as missing — "it lapsed" and "it never existed" are different conversations with different people.',
        evidence: `Attested at ${item.reference}, expiring ${item.expiresAt}.`,
        source: { refType: 'ServiceSystem', refId: item.systemId },
      },
      action: {
        decision: 'Obtain the renewed certificate and attest it against the gate.',
        owner: OWNER_SITE,
        dueAt: item.expiresAt,
        deadlineBasis: 'The expiry date recorded on the evidence itself.',
        consequence: 'On expiry the gate reverts and anything accepted on the strength of it is no longer supported.',
        prepared: 'The item, the gate it satisfies and the reference it currently lives at are all on the record.',
      },
    });
  }

  // --- NEXT: utilities and other interfaces ---------------------------------
  for (const system of design?.systems ?? []) {
    for (const item of system.interfaces) {
      if (item.status === 'ACCEPTED') continue;
      const due = item.dueDate ?? system.fromDate;
      const window = horizonOf(due, today);
      if (window.withinDays === undefined) continue;
      const utility = UTILITY_INTERFACES.has(item.name);
      entries.push({
        id: `interface:${item.id}`,
        horizon: 'NEXT',
        from: 'sbs',
        need: utility ? 'UTILITIES' : 'SUPPLIER_ACTION',
        headline: `${system.label}: ${item.name} not accepted`,
        tone: window.overdue ? 'CRITICAL' : 'WARNING',
        workspaces: on('CONTROL_TOWER', 'CUSTOMER_PROJECT', 'PROCUREMENT', 'FIELD_MOBILE'),
        ...window,
        why: {
          rule: 'Every non-negotiable interface in §4 must be accepted by a named counterparty before the system it serves can work. Acceptance is a record, not a conversation.',
          evidence: `${item.counterparty === undefined ? 'No counterparty named' : `Counterparty ${item.counterparty}`}; ${
            item.owner === undefined ? 'no owner' : `owner ${item.owner}`
          }; due ${due}${item.dueDate === undefined ? ' (taken from the system’s own arrival date, as the interface carries none)' : ''}.`,
          source: { refType: 'ServiceInterface', refId: item.id },
        },
        action: {
          decision: `Accept the ${item.name} interface, or record what is preventing it.`,
          owner: utility ? OWNER_DESIGN : OWNER_SITE,
          dueAt: due,
          deadlineBasis:
            item.dueDate === undefined
              ? `The interface carries no date of its own, so it is measured against the system arriving on ${system.fromDate}.`
              : 'The date recorded on the interface.',
          consequence: item.consequence,
          prepared: 'The consequence was stated when the interface was raised, so it is not being invented under pressure now.',
        },
      });
    }
  }

  // --- NEXT: space, from the removal obligation ------------------------------
  for (const plan of demob?.plans ?? []) {
    if (plan.plan !== undefined) continue;
    const end = systemEnd(design, plan.systemId);
    const due = end ?? undefined;
    const window = due === undefined ? { overdue: false } : horizonOf(due, today);
    if (due !== undefined && window.withinDays === undefined) continue;
    entries.push({
      id: `removal:${plan.systemId}`,
      horizon: 'NEXT',
      from: 'demobilisation',
      need: 'SPACE',
      headline: `${plan.label} has no removal plan`,
      tone: window.overdue ? 'CRITICAL' : 'WARNING',
      workspaces: on('CONTROL_TOWER', 'CUSTOMER_PROJECT', 'EXECUTIVE_PORTFOLIO'),
      ...window,
      why: {
        rule: 'Demobilisation begins at design. A removal plan agreed while somebody still wants something costs what it costs; one agreed at the end costs whatever the last firm on site asks.',
        evidence: `Removal obligation on the composed system: ${plan.obligation}`,
        source: { refType: 'ServiceSystem', refId: plan.systemId },
      },
      action: {
        decision: 'Agree the removal plan: owner, method, trigger, cost, waste route and reinstatement criterion.',
        owner: OWNER_COMMERCIAL,
        ...(due === undefined ? {} : { dueAt: due }),
        deadlineBasis:
          due === undefined
            ? 'No deployment end date is recorded against this system, so nothing dates the removal.'
            : `The system leaves site on ${due}.`,
        consequence: 'The land, the waste route and the reinstatement standard are all negotiated from the weakest possible position.',
        prepared: 'The removal obligation §4 recorded at composition is already the scope of the plan.',
      },
    });
  }

  // --- NEXT: supplier action -------------------------------------------------
  for (const pack of procurement?.packages ?? []) {
    if (options.supplierId !== undefined && !pack.engagements.some((entry) => entry.supplierId === options.supplierId)) {
      continue;
    }
    if (pack.tenderedAt !== undefined && pack.lockedReturns === 0) {
      entries.push({
        id: `returns:${pack.id}`,
        horizon: 'NEXT',
        from: 'procurement',
        need: 'SUPPLIER_ACTION',
        headline: `${pack.reference} issued with ${pack.returns} ${pack.returns === 1 ? 'return' : 'returns'} in and none locked`,
        tone: pack.returns === 0 ? 'WARNING' : 'INFO',
        workspaces: on('PROCUREMENT', 'CONTROL_TOWER', 'SUPPLIER_PORTAL'),
        withinDays: 7,
        why: {
          rule: 'A return that is not locked can still change, and an evaluation over unlocked returns is an evaluation of a moving target.',
          evidence: `Issued ${pack.tenderedAt}. ${pack.returns} received, ${pack.lockedReturns} locked.`,
          source: { refType: 'ServicePackage', refId: pack.id },
        },
        action: {
          decision: pack.returns === 0 ? 'Chase the bidders, or reopen the bidder list.' : 'Lock the returns and normalise them.',
          owner: OWNER_BUYER,
          deadlineBasis: 'No return date is recorded on the package itself; this is shown inside a week because an unlocked return ages badly.',
          consequence: 'Without locked returns there is no defensible comparison and no award paper.',
          prepared: 'The normalisation bases are already declared, so a locked set can be compared the same day.',
        },
      });
    }
    for (const engagement of pack.engagements) {
      if (options.supplierId !== undefined && engagement.supplierId !== options.supplierId) continue;
      if (engagement.nextBlocked === undefined) continue;
      entries.push({
        id: `engagement:${engagement.id}`,
        horizon: 'NEXT',
        from: 'procurement',
        need: 'SUPPLIER_ACTION',
        headline: `${engagement.supplierName} held at ${engagement.state}`,
        tone: engagement.state === 'SUSPENDED_RECOVERY' ? 'CRITICAL' : 'WARNING',
        workspaces: on('PROCUREMENT', 'CONTROL_TOWER', 'SUPPLIER_PORTAL'),
        withinDays: 7,
        why: {
          rule: 'A supplier moves between control states on an entry check, not on somebody deciding they are ready. The check that fails is named.',
          evidence: engagement.nextBlocked,
          source: { refType: 'SupplierEngagement', refId: engagement.id },
        },
        action: {
          decision: `Clear the entry check for ${engagement.nextState ?? 'the next state'}.`,
          owner: OWNER_BUYER,
          deadlineBasis: 'No contractual date on the state itself; shown inside a week because a held engagement blocks mobilisation behind it.',
          consequence: 'The package cannot progress past this supplier, and anything depending on it inherits the delay.',
          prepared: 'The control state, its entry check and what is failing are all recorded.',
        },
      });
    }
  }

  // --- NEXT: approvals -------------------------------------------------------
  for (const fact of brief?.facts ?? []) {
    if (fact.status !== 'PROVISIONAL' || fact.decideBy === undefined) continue;
    const window = horizonOf(fact.decideBy, today);
    if (window.withinDays === undefined) continue;
    entries.push({
      id: `provisional:${fact.id}`,
      horizon: 'NEXT',
      from: 'brief',
      need: 'APPROVAL',
      headline: `${fact.itemId} is provisional at ${fact.value} ${fact.unit} and must be decided by ${fact.decideBy}`,
      tone: window.overdue ? 'CRITICAL' : 'WARNING',
      workspaces: on('CUSTOMER_PROJECT', 'CONTROL_TOWER', 'ACCOMMODATION_DESK'),
      ...window,
      why: {
        rule: 'A provisional value is tagged, given a consequence and given a decision date. It is never allowed to become the answer by nobody arguing with it.',
        evidence: `${fact.basis ?? 'No basis recorded.'} Source: ${fact.source}.`,
        source: { refType: 'SiteServiceFact', refId: fact.id },
      },
      action: {
        decision: `Confirm ${fact.itemId} or replace it with the real figure.`,
        owner: fact.owner === undefined ? OWNER_DESIGN : { roles: OWNER_DESIGN.roles, basis: `Recorded owner: ${fact.owner}.` },
        dueAt: fact.decideBy,
        deadlineBasis: 'The decision date set when the value was assumed.',
        consequence: 'Everything sized from this figure carries the assumption, and the cost of it lands when the real number arrives.',
        prepared: 'The assumption, its basis and everything derived from it are already linked.',
      },
    });
  }
  for (const system of mobilisation?.systems ?? []) {
    const gate = system.gates.find((entry) => entry.id === system.atGate);
    if (!gate || gate.satisfied < gate.total || gate.approval !== undefined) continue;
    const startsAt = systemStart(design, system.systemId);
    const window = startsAt === undefined ? { overdue: false } : horizonOf(startsAt, today);
    entries.push({
      id: `gate-approval:${system.systemId}:${gate.id}`,
      horizon: 'NEXT',
      from: 'mobilisation',
      need: 'APPROVAL',
      headline: `${system.label}: ${gate.id} is fully evidenced and awaiting approval`,
      tone: 'INFO',
      workspaces: on('CONTROL_TOWER', 'CUSTOMER_PROJECT', 'EXECUTIVE_PORTFOLIO', 'PROCUREMENT'),
      ...(window.withinDays === undefined ? { withinDays: 30 as const, overdue: window.overdue } : window),
      why: {
        rule: 'Evidence complete is not the same as gate passed. The approval is a named person taking responsibility for what the evidence shows.',
        evidence: `${gate.satisfied} of ${gate.total} evidence items satisfied. ${gate.approvalCondition}`,
        source: { refType: 'ServiceSystem', refId: system.systemId },
      },
      action: {
        decision: `Approve ${gate.id} — ${gate.name}.`,
        owner: { roles: [...gate.approvers], basis: 'The roles the gate itself nominates as approvers.' },
        ...(startsAt === undefined ? {} : { dueAt: startsAt }),
        deadlineBasis:
          startsAt === undefined
            ? 'No deployment date on the system, so the approval has no date to be late against.'
            : `The system is required on site from ${startsAt}.`,
        consequence: 'The gate holds, and so does every gate behind it, for as long as nobody signs.',
        prepared: 'All evidence is attested and the approval condition is on the screen beside it.',
      },
    });
  }
  for (const stream of demob?.workstreams ?? []) {
    for (const record of stream.records) {
      // Evidence is on the record but nobody has accepted it. `IN_PROGRESS`
      // with nothing recorded is a workstream somebody opened and left, which
      // is a different problem and belongs in the open count, not here.
      if (record.status !== 'IN_PROGRESS' || record.evidence.length === 0) continue;
      entries.push({
        id: `demob-approval:${record.id}`,
        horizon: 'NEXT',
        from: 'demobilisation',
        need: 'APPROVAL',
        headline: `${stream.label} evidenced and awaiting acceptance${record.systemLabel === undefined ? '' : ` — ${record.systemLabel}`}`,
        tone: 'INFO',
        workspaces: on('CONTROL_TOWER', 'CUSTOMER_PROJECT', 'EXECUTIVE_PORTFOLIO'),
        withinDays: 30,
        why: {
          rule: 'A demobilisation workstream closes on acceptance against a stated acceptance criterion, not on the work looking finished.',
          evidence: `${record.evidence.length} evidence ${record.evidence.length === 1 ? 'record' : 'records'}. Acceptance: ${stream.acceptance}`,
          source: { refType: 'DemobilisationRecord', refId: record.id },
        },
        action: {
          decision: `Accept the ${stream.label} workstream, or state what falls short.`,
          owner: OWNER_SITE,
          deadlineBasis: 'No contractual date on the workstream; shown at the month horizon because an unaccepted workstream is an open liability.',
          consequence: 'The liability stays open and the land is not handed back.',
          prepared: 'The evidence is linked and the acceptance criterion is stated against it.',
        },
      });
    }
  }

  // --- NEXT: funding ---------------------------------------------------------
  for (const change of changes?.changes ?? []) {
    if (change.status === 'AGREED' || change.status === 'REJECTED') continue;
    const due = change.noticeDueBy;
    const window = due === undefined ? { overdue: false } : horizonOf(due, today);
    if (due !== undefined && window.withinDays === undefined && !change.noticeOutstanding) continue;
    entries.push({
      id: `change:${change.id}`,
      horizon: 'NEXT',
      from: 'change',
      need: 'FUNDING',
      headline: `${change.reference}: ${change.summary}`,
      tone: change.noticeLapsed ? 'CRITICAL' : change.noticeOutstanding ? 'WARNING' : 'INFO',
      workspaces: on('EXECUTIVE_PORTFOLIO', 'CUSTOMER_PROJECT', 'COMMERCIAL'),
      ...(due === undefined ? { withinDays: 30 as const, overdue: false } : window),
      why: {
        rule: 'No change becomes forecast-neutral because it lacks an approved quotation. Entitlement, probability and value are carried as three separate fields, and the risk-adjusted exposure is on the forecast from the day it is raised.',
        evidence: `${change.triggerLabel}; entitlement ${change.entitlementLabel} at ${change.probabilityPercent}%. ${change.difference}`,
        source: { refType: 'ServiceChange', refId: change.id },
      },
      action: {
        decision: change.noticeOutstanding
          ? 'Give the contractual notice, then price it.'
          : `Progress the change from ${change.status.toLowerCase().replaceAll('_', ' ')}.`,
        owner: OWNER_COMMERCIAL,
        ...(due === undefined ? {} : { dueAt: due }),
        deadlineBasis:
          due !== undefined
            ? `The contract requires notice by ${due}.`
            : change.noticeOutstanding
              ? 'This trigger bears a contract notice and no date has been recorded against it. Shown at the month horizon; the period is whatever the contract says, and somebody has to read it.'
              : 'This trigger bears no contract notice, so there is no notice deadline. Shown at the month horizon because the exposure sits on the forecast either way.',
        consequence: change.noticeLapsed
          ? 'The notice period has passed with nothing sent. The entitlement is weaker than the entitlement view records, whatever the merits.'
          : 'Unresolved, the exposure stays on the forecast risk-adjusted rather than becoming a certainty in either direction.',
        prepared: 'The trigger analysis, the difference from baseline and the entitlement view are already recorded against it.',
      },
    });
  }
  for (const valuation of money?.valuations ?? []) {
    if (valuation.status === 'CERTIFIED') continue;
    const window = horizonOf(valuation.cutOff, today);
    entries.push({
      id: `valuation:${valuation.id}`,
      horizon: 'NEXT',
      from: 'commercial',
      need: 'FUNDING',
      headline: `${valuation.reference} is ${valuation.status.toLowerCase()} with ${valuation.exceptions} ${
        valuation.exceptions === 1 ? 'exception' : 'exceptions'
      }`,
      tone: valuation.exceptions > 0 ? 'WARNING' : 'INFO',
      workspaces: on('COMMERCIAL', 'CUSTOMER_PROJECT', 'EXECUTIVE_PORTFOLIO'),
      ...(window.withinDays === undefined ? { withinDays: 30 as const, overdue: window.overdue } : window),
      why: {
        rule: 'An invoice is not proof of value. What is certified is what accepted progress supports, and every difference from the application is raised as a named exception rather than netted off.',
        evidence: `Period ${valuation.periodFrom} to ${valuation.periodTo}, cut-off ${valuation.cutOff}. Gross applied ${valuation.grossMinor / 100}, assessed net ${valuation.netMinor / 100}.`,
        source: { refType: 'Valuation', refId: valuation.id },
      },
      action: {
        decision: valuation.status === 'OPEN' ? 'Record the application against the cut-off.' : 'Assess and certify.',
        owner: OWNER_COMMERCIAL,
        dueAt: valuation.cutOff,
        deadlineBasis: 'The valuation cut-off. Anything after it belongs to the next valuation.',
        consequence: 'A certificate issued without the assessment is a payment nobody can defend at the final account.',
        prepared: 'The exceptions are already computed against accepted progress, line by line.',
      },
    });
  }

  // --- Assemble the workspace's own view ------------------------------------
  const mine = entries.filter((entry) => entry.workspaces.includes(workspace.id));
  const toneRank: Record<Tone, number> = { CRITICAL: 0, WARNING: 1, INFO: 2, OK: 3 };
  const now = mine
    .filter((entry) => entry.horizon === 'NOW')
    .sort((a, b) => toneRank[a.tone] - toneRank[b.tone] || a.headline.localeCompare(b.headline));
  const next = mine
    .filter((entry) => entry.horizon === 'NEXT')
    .sort(
      (a, b) =>
        (a.withinDays ?? 99) - (b.withinDays ?? 99) ||
        toneRank[a.tone] - toneRank[b.tone] ||
        a.headline.localeCompare(b.headline),
    );

  const unanswered = workspace.questions.filter((question) => !question.answered);
  const critical = now.filter((entry) => entry.tone === 'CRITICAL').length;
  const dueNow = next.filter((entry) => entry.overdue === true || entry.withinDays === 2).length;

  const statement =
    now.length === 0 && next.length === 0
      ? `Nothing is outstanding on ${workspace.label} today. ${
          unanswered.length === 0
            ? 'Every question this workspace exists to answer is answerable from the records held.'
            : `${unanswered.length} of this workspace’s questions cannot be answered from the records held — see what is not built.`
        }`
      : `${now.length} ${now.length === 1 ? 'item' : 'items'} true now, ${critical} of them critical; ${next.length} falling due, ${dueNow} inside two days${
          appointment?.appointment === undefined
            ? ''
            : ` under the ${appointment.profile?.label.split(' — ')[0] ?? 'appointed'} model`
        }.${
          unanswered.length === 0
            ? ''
            : ` ${unanswered.length} of this workspace’s questions ${
                unanswered.length === 1 ? 'is' : 'are'
              } not answerable from the records held.`
        }`;

  return {
    workspace,
    workspaces: WORKSPACES.map(({ id, label, mustAnswer, audience }) => ({ id, label, mustAnswer, audience })),
    subjects: NOW_SUBJECTS,
    needs: NEXT_NEEDS,
    now,
    next,
    unanswered,
    statement,
  };
}

function systemStart(design: ReturnType<typeof sbs> | undefined, systemId: string): string | undefined {
  return design?.systems.find((system) => system.id === systemId)?.fromDate;
}

function systemEnd(design: ReturnType<typeof sbs> | undefined, systemId: string): string | undefined {
  return design?.systems.find((system) => system.id === systemId)?.toDate;
}

/**
 * Put names against every decision on a panel.
 *
 * Called by the route, which is the layer that holds the tenancy's identities.
 * Resolution itself is `identity/ownership.ts` — the ordering rule that puts the
 * narrowest remit first and treats wider remits as the escalation behind them
 * lives in one place, and this does not get a second opinion about it.
 *
 * An entry whose roles nobody holds keeps `named` as an empty array rather than
 * losing the field, because "nobody on this project can decide this" is a real
 * and reportable answer, and silently omitting it reads as an oversight.
 */
export function nameOwners<T extends { action: { owner: OwnerSpec } }>(
  entries: readonly T[],
  identities: readonly Identity[],
): T[] {
  return entries.map((entry) => ({
    ...entry,
    action: {
      ...entry.action,
      owner: { ...entry.action.owner, named: ownersByRole(identities, entry.action.owner.roles) },
    },
  }));
}
