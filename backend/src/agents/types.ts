import type { EngineContext } from '../engines/context.ts';
import type { CapabilityArea, PermissionCode, Role } from '../identity/roles.ts';
import type { LifecyclePhase } from '../lifecycle/phases.ts';

/**
 * The agent contract.
 *
 * An agent watches the project, forms a view, and proposes what to do about it.
 * It does not decide. The separation is the whole design: an agent that could
 * approve its own proposal would be a way round the separation of duties the
 * rest of the platform enforces, and the first serious incident would be one
 * nobody could explain because no human ever chose it.
 *
 * So the loop is: observe → find → propose → a human with the authority
 * approves → the platform executes as that human. The agent's reasoning is
 * recorded either way, including when a human rejects it, because a rejected
 * proposal is evidence too.
 */

/**
 * What an agent may do without being asked.
 *
 * This is bounded autonomy, and the bound is per agent per action. `OBSERVE` is
 * the floor and needs no approval because it changes nothing. `ACT` exists for
 * work that is genuinely mechanical and reversible, and every use of it is
 * declared here rather than decided at runtime.
 */
export type AutonomyLevel =
  /** Read state, write a finding. No project state changes. */
  | 'OBSERVE'
  /**
   * Prepares a complete, valid command and holds it. Nothing reaches the ledger.
   *
   * The rung between looking and asking, and the one that is easiest to leave
   * out. It matters because a draft is checkable: a person can read the exact
   * body that would be submitted, rather than a summary of it. The perception
   * pipeline already works this way — a draft extraction that a person confirms
   * into the ordinary domain command — and this names that behaviour so the
   * ladder has a rung for it instead of calling it a proposal it is not.
   */
  | 'DRAFT'
  /** Wants to run a command. Always requires a human approval. */
  | 'PROPOSE'
  /** May run the command itself, within a granted envelope, and is recorded. */
  | 'ACT';

/** Rungs in order, so "higher than" is a comparison rather than a convention. */
export const AUTONOMY_LADDER: AutonomyLevel[] = ['OBSERVE', 'DRAFT', 'PROPOSE', 'ACT'];

/** True where `level` sits above `ceiling` on the ladder. */
export function exceeds(level: AutonomyLevel, ceiling: AutonomyLevel): boolean {
  return AUTONOMY_LADDER.indexOf(level) > AUTONOMY_LADDER.indexOf(ceiling);
}

/**
 * The envelope an agent may act inside, as *declared in code*.
 *
 * Declaring eligibility is not granting it. An agent whose mandate says
 * `maxUnattended: 'ACT'` still cannot act until a human with governance
 * authority grants a live envelope against it — see `agents/mandate.ts`. The
 * two are kept apart on purpose: if the registry alone conferred autonomy, then
 * editing the registry would be the way to give a machine unattended authority
 * over a customer's project, and that is a code review rather than a decision
 * anybody made.
 */
export type EnvelopeSpec = {
  /**
   * The only commands this agent may ever be granted. A grant may narrow this
   * list; nothing can widen it.
   */
  commands: string[];
  /**
   * The most a single unattended act may be worth, in minor units. Zero means
   * the agent's acts carry no value at all — a notification, a re-run — which
   * is the only envelope granted anywhere today.
   */
  valueCeilingMinor: number;
  /** One sentence an approver reads before granting. Not a restatement of the list. */
  because: string;
};


// --- The Agent Contract ------------------------------------------------------
//
// The specification requires every agent to declare twelve fields, and six of
// them had nowhere to live: `active_in_states`, `triggers`, `emits`,
// `confidence_floor`, `acu_tier` and `memory_access`. The consequences were not
// cosmetic. An agent could not be blocked from running in the wrong lifecycle
// state; nothing could route a domain event to the agent that exists to answer
// it; an agent could not declare what it publishes, so the fleet's own graph
// was unknowable; there was no floor below which it must escalate rather than
// act; the ACU meter could not price a run before making it; and the three
// memory layers had no per-agent access control at all.
//
// They are added here beside the fields that already existed. Nothing is
// replaced: `mandate`, `division` and `purpose` remain exactly what they were,
// and `maxUnattended` is still the load-bearing autonomy ceiling. These are the
// declarations the runtime now enforces.

/**
 * Lifecycle states an agent may run in.
 *
 * The specification's `active_in_states[]`, and it is a refusal rather than a
 * preference: a tender agent that wakes on a project in operations is reading a
 * job whose tender closed years ago, and whatever it concludes is noise
 * presented with the same confidence as a real finding.
 *
 * `ANY` is written out rather than left implicit. An agent that genuinely runs
 * everywhere — the Golden Thread auditor, the lessons agent — is making a claim
 * about itself, and a claim is better than an omission that reads the same way.
 */
export type AgentStates = LifecyclePhase[] | 'ANY';

/**
 * What wakes an agent.
 *
 * Domain event codes from the closed catalogue, and/or a schedule. The
 * distinction matters for cost as much as correctness: an agent triggered by
 * `TENDER_RETURN_RECEIVED` runs when there is something to look at, and one on
 * a daily schedule runs whether or not anything happened.
 *
 * `CONTINUOUS` is the fleet sweep the runtime already performs — every agent
 * that carried no trigger before this existed is exactly that, so migrating the
 * twelve built agents onto the contract is a statement of what they already do.
 */
export type AgentTrigger =
  | { kind: 'EVENT'; eventType: string }
  /** `at` is 24-hour local time, "06:00". Days omitted means every day. */
  | { kind: 'SCHEDULE'; at: string; days?: number[] }
  | { kind: 'CONTINUOUS' }
  /** A person asked for it. Always allowed; declared so the list is complete. */
  | { kind: 'ON_DEMAND' };

/**
 * How much human involvement a run requires, from the specification.
 *
 * Distinct from `maxUnattended`, and the two answer different questions.
 * `maxUnattended` is the ceiling on what the agent may *do*; `hitl` is what a
 * person must do with the *output*. An agent can be `OBSERVE` — changing
 * nothing — and still be `APPROVAL`, because a bid/no-bid recommendation
 * changes nothing by itself and must not reach a decision maker as though
 * nobody needed to sign it.
 */
export type HumanInTheLoop =
  /** Output is published. Used only where being wrong costs nothing. */
  | 'NONE'
  /** A person must read it before it counts as seen. */
  | 'REVIEW'
  /** A person with authority must approve before anything follows from it. */
  | 'APPROVAL';

/**
 * The metering class for one run, from the specification's Part H.
 *
 * A class rather than a price. The price of a tier is configuration and lives
 * with the rest of the money model; what belongs on the agent is the claim
 * about how expensive its thinking is, so a run can be quoted before it is made
 * and refused against an empty wallet before a provider is called.
 */
export type AcuTier = 'LOW' | 'MED' | 'HIGH' | 'PREMIUM';

/**
 * The three memory layers, and which of them an agent may touch.
 *
 * Read and write are separate because the failure modes are. An agent reading
 * organisation memory is using what the business has learned; an agent
 * *writing* it is changing what every future project on every other job will be
 * told — so the estimating agent reads the rate library and does not edit it,
 * and the lessons agent is the one that writes.
 *
 * Asset memory outlives the project and the contract both. An agent that may
 * write it is writing into a record somebody will read in year twenty-nine.
 */
export type MemoryLayer = 'PROJECT' | 'ORGANISATION' | 'ASSET';

export type MemoryAccess = {
  reads: MemoryLayer[];
  writes: MemoryLayer[];
};

/** Severity of a finding, which drives what a human sees first. */
export type FindingSeverity = 'INFO' | 'ATTENTION' | 'URGENT';

export type Finding = {
  /** Stable id per agent+subject so the same finding is not raised twice. */
  key: string;
  severity: FindingSeverity;
  /** What the agent observed, in the language a project person would use. */
  summary: string;
  /** Why it matters — the consequence, not a restatement of the observation. */
  consequence: string;
  /**
   * The records the finding was read from. A finding that cannot name its
   * source is an opinion, and the platform does not store opinions as facts.
   */
  evidence: Array<{ refType: string; refId: string; note: string }>;
  /**
   * How sure the agent is, 0–1. Optional, and its absence means something.
   *
   * An agent whose trigger is pure arithmetic over the record — "this permit
   * expired yesterday" — has no confidence to report, because it is not
   * estimating anything. Confidence belongs on a finding that involved a
   * judgement, and the runtime only applies the floor where one is stated.
   */
  confidence?: number;
};

/**
 * A command the agent wants run, with everything a human needs in order to
 * decide: what it will do, what it costs, and what happens if it is not done.
 */
export type ProposedCommand = {
  /** The engine command, e.g. `planning:forecastDelay`. */
  command: string;
  /** The capability the executing human must hold. */
  area: CapabilityArea;
  code: PermissionCode;
  /** Body the command will be called with. */
  input: Record<string, unknown>;
  /** Plain statement of the effect, for the approval screen. */
  effect: string;
  /** What happens if this is not approved. */
  ifDeclined: string;
  /** Estimated ACU cost, so approval is a commercial decision as well. */
  estimatedAcuMinor: number;
};

export type AgentProposal = {
  id: string;
  agent: string;
  raisedAt: string;
  finding: Finding;
  command?: ProposedCommand;
  autonomy: AutonomyLevel;
  /**
   * `MITIGATED` is not a softer rejection and the distinction is the point.
   * Rejected means the finding was wrong or does not matter. Mitigated means it
   * was right and is being dealt with another way — so the record has to say
   * what that way is, or the platform has stored "somebody said they would
   * handle it" as though it were a control.
   */
  status: 'OPEN' | 'APPROVED' | 'REJECTED' | 'MITIGATED' | 'EXECUTED' | 'SUPERSEDED';
  /** Set when a human decides. Never set by the agent. */
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  /**
   * Who is going to decide this, where somebody has been named.
   *
   * Assignment is not a decision: the proposal stays open. What it does is turn
   * "a QS may approve this" into "this QS is dealing with it", which is the
   * difference between a queue and a list of things nobody has picked up.
   */
  assignedTo?: string;
  assignedToName?: string;
  assignedBy?: string;
  assignedAt?: string;
  assignmentNote?: string;
  /** What is being done instead, where the finding was mitigated. */
  mitigation?: string;
};

/**
 * An agent's mandate: the narrowest set of capabilities it can ever touch.
 *
 * The runtime checks a proposal against this before it is raised, so an agent
 * cannot propose outside its remit even if its own logic is wrong. The mandate
 * is also what makes an agent explainable to an auditor — "what could this
 * thing have done" has a short, fixed answer.
 */
export type AgentMandate = {
  /** Areas the agent may read. */
  reads: CapabilityArea[];
  /** Areas the agent may propose action in. Never wider than `reads`. */
  proposes: CapabilityArea[];
  /** Roles that may approve this agent's proposals. */
  approvers: Role[];
  /**
   * The ceiling on anything the agent may do unattended.
   *
   * The load-bearing field. Everything else on a mandate narrows *what* an
   * agent touches; this decides whether a human is in the loop at all.
   */
  maxUnattended: AutonomyLevel;
  /**
   * What an ACT grant against this agent may cover. Required where
   * `maxUnattended` is `ACT`, meaningless otherwise, and checked by a test.
   */
  envelope?: EnvelopeSpec;
};

/**
 * Where an agent sits in the fleet.
 *
 * The divisions are not decoration. They are the answer to "who is watching
 * what", and they map onto the three questions a contracting business actually
 * runs on: what work is out there, should we chase it and at what price, and
 * are the jobs we already have going wrong. The supply chain sits under all
 * three because it is the constraint on all three.
 */
export type AgentDivision =
  | 'MARKET_INTEL'
  | 'BID'
  | 'DELIVERY'
  | 'SUPPLY_CHAIN'
  /** The platform watching itself, rather than watching a project. */
  | 'PLATFORM_OPS'
  | 'SECURITY'
  | 'REVENUE'
  | 'CUSTOMER'
  | 'COMPLIANCE';

export const AGENT_DIVISIONS: Array<{ division: AgentDivision; label: string; question: string }> = [
  { division: 'MARKET_INTEL', label: 'Market intelligence', question: 'What work is out there, and which of it could we actually win?' },
  { division: 'BID', label: 'Bid engine', question: 'Should we chase this, at what price, and can we fund it?' },
  { division: 'DELIVERY', label: 'Delivery engine', question: 'Are the jobs we already have going wrong, and how early can we tell?' },
  { division: 'SUPPLY_CHAIN', label: 'Supply chain', question: 'Can we still buy what we sell?' },
  { division: 'PLATFORM_OPS', label: 'Platform operations', question: 'Is the platform itself healthy, and does anybody know before a customer does?' },
  { division: 'SECURITY', label: 'Security', question: 'Who reached what, and is that normal for them?' },
  { division: 'REVENUE', label: 'Revenue', question: 'Is what the customer bought still what the customer needs?' },
  { division: 'CUSTOMER', label: 'Customer', question: 'Is the customer getting the outcome they bought, and can we tell before they leave?' },
  { division: 'COMPLIANCE', label: 'Compliance', question: 'Are the obligations that carry a statutory date still current?' },
];

/**
 * Whether an agent is running, or is declared and waiting on something.
 *
 * A fleet manifest that listed thirty-one agents when twelve of them read from
 * a data source that does not exist would be a lie told in a table. `DECLARED`
 * agents appear with their mandate — so the org chart and the blast radius are
 * both inspectable — and name, in `needs`, exactly what is missing. The runtime
 * never runs one.
 */
export type AgentDeployment = 'DEPLOYED' | 'DECLARED';

export type AgentDefinition = {
  name: string;
  /**
   * The specification's stable `agent_id`, e.g. `AGT-TENDER-RETURN`.
   *
   * Beside `name` rather than instead of it. `name` is what the console, the
   * proposal records and the existing ledger entries already use, and rewriting
   * it would rename every agent in every historical proposal on an append-only
   * chain. The id is the contract's identifier; the name is this platform's.
   */
  agentId: string;
  /** Which division this agent reports into. */
  division: AgentDivision;
  /** One sentence: what this agent is for. Shown to the approver. */
  purpose: string;
  mandate: AgentMandate;
  /** Lifecycle states this agent may run in. The runtime refuses elsewhere. */
  activeIn: AgentStates;
  /** What wakes it. */
  triggers: AgentTrigger[];
  /** Named data sources, for the contract's `inputs`. Plain language. */
  inputs: string[];
  /** Named artefacts it produces, for the contract's `outputs`. */
  outputs: string[];
  /** Event codes this agent's proposals lead to, once approved and executed. */
  emits: string[];
  /** What a person must do with the output before anything follows from it. */
  hitl: HumanInTheLoop;
  /**
   * Below this the agent must escalate rather than act, 0–1.
   *
   * Enforced by the runtime: a finding under the floor is still recorded — it
   * is evidence that the agent looked — but it cannot carry a proposal, because
   * a proposal is a request to change the project and the agent has just said
   * it is not sure.
   */
  confidenceFloor: number;
  /** Metering class for one run. */
  acuTier: AcuTier;
  /** Which memory layers it may read and write. */
  memory: MemoryAccess;
  /** Running, or declared and waiting. Defaults to running. */
  deployment?: AgentDeployment;
  /** What a `DECLARED` agent is waiting on. Required for one, and tested. */
  needs?: string;
  /**
   * Evaluate project state and return what the agent has found.
   *
   * Pure with respect to project state: an agent reads, it does not write. The
   * runtime is what records findings and raises proposals, so an agent cannot
   * quietly change something as a side effect of looking at it.
   *
   * Absent on a `DECLARED` agent, which is the point: there is nothing to run.
   */
  evaluate?(ctx: EngineContext): Promise<AgentOutput> | AgentOutput;
};

export type AgentOutput = {
  findings: Finding[];
  /** Proposals, each tied to one of the findings by key. */
  proposals: Array<{ findingKey: string; command: ProposedCommand; autonomy: AutonomyLevel }>;
};

/** What one pass of the whole fleet produced. */
export type AgentRunReport = {
  runId: string;
  ranAt: string;
  agents: Array<{
    agent: string;
    findings: number;
    proposalsRaised: number;
    suppressed: number;
    /**
     * How many of those proposals the agent then ran itself, inside a granted
     * envelope. Reported separately from `proposalsRaised` rather than folded
     * into it: a fleet that raised nine proposals and executed one is a very
     * different day from a fleet that raised nine and executed nine, and a
     * single number cannot say which happened.
     */
    acted?: number;
    error?: string;
    /**
     * Why this agent did not run. Set where the lifecycle state gate declined
     * it — reported rather than omitted, so a fleet run that skipped half the
     * fleet says so instead of looking like a fleet half this size.
     */
    skipped?: string;
    /**
     * Why this agent was in this run.
     *
     * A routed run selects a handful of agents out of forty-eight, and without
     * this the report is a list of names with no way to tell a deliberate
     * selection from a fleet that mostly failed to appear.
     */
    because?: string;
  }>;
  proposals: AgentProposal[];
  /** Findings that were already open, so nothing was raised twice. */
  suppressed: number;
  /**
   * Findings whose confidence fell below their agent's floor, so the finding
   * was kept and its proposal was not raised.
   */
  belowFloor: number;
  /**
   * What put this run together — a sweep, the events that landed, a clock tick,
   * or a person naming agents. Recorded on the run so a proposal can be traced
   * back to the thing that woke the agent that raised it.
   */
  because: string;
  /**
   * Agents that declare a trigger for this run and were then declined by the
   * lifecycle state gate. Counted separately from the fleet that never matched:
   * "the event happened and the agent for it cannot run in this phase" is a
   * different fact from "no agent watches that event".
   */
  gated: number;
  /**
   * What the proposals this run raised would cost to execute, and whether the
   * wallet covers it.
   *
   * The contract's `acu_tier`, made useful rather than merely declared: a queue
   * of proposals is a queue of things somebody is going to press, and an
   * approver offered work the tenancy cannot pay for finds out at the moment
   * they approve it. Priced from each agent's declared tier through the same
   * markup as every other AI charge.
   */
  cost: {
    estimatedChargeMinor: number;
    availableMinor: number;
    affordable: boolean;
    /** Per tier, so an expensive queue can be read rather than guessed at. */
    byTier: Array<{ tier: AcuTier; proposals: number; chargeMinor: number }>;
  };
};
