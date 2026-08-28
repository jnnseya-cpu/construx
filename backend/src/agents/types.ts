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
  /** Which division this agent reports into. */
  division: AgentDivision;
  /** One sentence: what this agent is for. Shown to the approver. */
  purpose: string;
  mandate: AgentMandate;
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
    error?: string;
  }>;
  proposals: AgentProposal[];
  /** Findings that were already open, so nothing was raised twice. */
  suppressed: number;
};
