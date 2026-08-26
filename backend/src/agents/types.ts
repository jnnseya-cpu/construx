import type { EngineContext } from '../engines/context.ts';
import type { CapabilityArea, PermissionCode, Role } from '../identity/roles.ts';

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
  /** Wants to run a command. Always requires a human approval. */
  | 'PROPOSE'
  /** May run the command itself, within the declared limit, and is recorded. */
  | 'ACT';

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
  /** The ceiling on anything the agent may do unattended. */
  maxUnattended: AutonomyLevel;
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
export type AgentDivision = 'MARKET_INTEL' | 'BID' | 'DELIVERY' | 'SUPPLY_CHAIN';

export const AGENT_DIVISIONS: Array<{ division: AgentDivision; label: string; question: string }> = [
  { division: 'MARKET_INTEL', label: 'Market intelligence', question: 'What work is out there, and which of it could we actually win?' },
  { division: 'BID', label: 'Bid engine', question: 'Should we chase this, at what price, and can we fund it?' },
  { division: 'DELIVERY', label: 'Delivery engine', question: 'Are the jobs we already have going wrong, and how early can we tell?' },
  { division: 'SUPPLY_CHAIN', label: 'Supply chain', question: 'Can we still buy what we sell?' },
];

export type AgentDefinition = {
  name: string;
  /** Which division this agent reports into. */
  division: AgentDivision;
  /** One sentence: what this agent is for. Shown to the approver. */
  purpose: string;
  mandate: AgentMandate;
  /**
   * Evaluate project state and return what the agent has found.
   *
   * Pure with respect to project state: an agent reads, it does not write. The
   * runtime is what records findings and raises proposals, so an agent cannot
   * quietly change something as a side effect of looking at it.
   */
  evaluate(ctx: EngineContext): Promise<AgentOutput> | AgentOutput;
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
    error?: string;
  }>;
  proposals: AgentProposal[];
  /** Findings that were already open, so nothing was raised twice. */
  suppressed: number;
};
