import { ulid } from '../core/ids.ts';
import { DomainError, ForbiddenError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { rolesAllow } from '../identity/roles.ts';
import { mayActUnattended } from './mandate.ts';
import { AGENTS, agentByName, deployedAgents } from './registry.ts';
import { exceeds, type AgentDefinition, type AgentProposal, type AgentRunReport, type Finding } from './types.ts';

/**
 * The agent runtime.
 *
 * Runs the fleet, records what each agent found, and raises proposals for what
 * it wants done. Then it stops, because the next step belongs to a person.
 *
 * Three rules hold the whole thing together:
 *
 *   1. An agent never writes project state. It returns findings; the runtime
 *      records them. So looking at a project cannot change it.
 *   2. An agent cannot propose outside its mandate. The mandate is checked here,
 *      not inside the agent, so a bug in an agent's own logic cannot widen it.
 *   3. An agent cannot approve. Approval requires a human holding the capability
 *      the command needs, and the command then executes as that human — which is
 *      what makes the resulting event attributable to someone who chose it.
 */

/** How long a proposal stays open before it is treated as stale. */
const PROPOSAL_TTL_HOURS = 72;

function openProposals(ctx: EngineContext): AgentProposal[] {
  return ctx.ledger
    .list(ctx.projectId, 'AgentProposal')
    .map((record) => record.state as unknown as AgentProposal)
    .filter((p) => p.status === 'OPEN');
}

/**
 * Run the fleet once.
 *
 * Findings already open are suppressed rather than raised again — an autopilot
 * that repeats itself daily trains people to ignore it, which is worse than one
 * that says nothing.
 */
export async function runAgents(
  ctx: EngineContext,
  options: { only?: string[] } = {},
): Promise<AgentRunReport> {
  authorise(ctx, 'AI_EXECUTION', 'X');

  const runId = ulid();
  const ranAt = new Date().toISOString();
  const existing = new Set(openProposals(ctx).map((p) => p.finding.key));

  // Declared agents are in the manifest and not in the fleet: they carry a
  // mandate so the org chart is inspectable, and no `evaluate`, so there is
  // nothing to run. Naming one explicitly does not conjure one either.
  const fleet = options.only?.length
    ? options.only
        .map((name) => agentByName(name))
        .filter((a): a is AgentDefinition => Boolean(a) && typeof a?.evaluate === 'function')
    : deployedAgents();

  const report: AgentRunReport = { runId, ranAt, agents: [], proposals: [], suppressed: 0 };

  for (const agent of fleet) {
    try {
      const output = await agent.evaluate!(ctx);
      let raised = 0;
      let suppressed = 0;

      for (const finding of output.findings) {
        if (existing.has(finding.key)) {
          suppressed += 1;
          continue;
        }
        existing.add(finding.key);

        const proposed = output.proposals.find((p) => p.findingKey === finding.key);

        if (proposed) {
          // Rule 2: the mandate is the ceiling, checked outside the agent.
          if (!agent.mandate.proposes.includes(proposed.command.area)) {
            throw new DomainError(
              'AGENT_EXCEEDED_MANDATE',
              `Agent ${agent.name} proposed in ${proposed.command.area}, which is outside its mandate`,
            );
          }
          if (exceeds(proposed.autonomy, agent.mandate.maxUnattended)) {
            throw new DomainError(
              'AGENT_EXCEEDED_AUTONOMY',
              `Agent ${agent.name} wants to ${proposed.autonomy} and its ceiling is ${agent.mandate.maxUnattended}`,
            );
          }
          if (proposed.autonomy === 'ACT') {
            // Declaring is not granting. A ceiling of ACT in the registry says
            // this agent *may be* trusted to act; whether it *is* comes from an
            // envelope a person granted, on the record, with an end date.
            //
            // Degraded rather than refused: the finding still matters and the
            // work still needs doing, so an ungranted act becomes a proposal
            // with the reason attached. Refusing would trade a small safety
            // gain for the loss of the finding entirely.
            const permitted = mayActUnattended(ctx, agent.name, {
              command: proposed.command.command,
              valueMinor: proposed.command.estimatedAcuMinor,
            });
            if (!permitted.permitted) {
              proposed.autonomy = 'PROPOSE';
              proposed.command.effect = `${proposed.command.effect} (queued rather than run: ${permitted.because})`;
            }
          }
          // A proposal nobody is permitted to approve is noise that will sit in
          // the queue for ever. Catching it here turns an agent declaring the
          // wrong capability into a loud failure rather than a silent backlog.
          const approvable = agent.mandate.approvers.some((role) =>
            rolesAllow([role], proposed.command.area, proposed.command.code),
          );
          if (!approvable) {
            throw new DomainError(
              'AGENT_PROPOSAL_UNAPPROVABLE',
              `Agent ${agent.name} proposed ${proposed.command.command} needing "${proposed.command.code}" on ${proposed.command.area}, which none of its approvers (${agent.mandate.approvers.join(', ')}) hold`,
            );
          }
        }

        const proposal = raiseProposal(ctx, agent, finding, proposed, runId);
        report.proposals.push(proposal);
        raised += 1;
      }

      report.suppressed += suppressed;
      report.agents.push({ agent: agent.name, findings: output.findings.length, proposalsRaised: raised, suppressed });
    } catch (error) {
      // One agent failing must not stop the fleet, and the failure is recorded
      // rather than swallowed — a silent agent looks identical to a calm project.
      report.agents.push({
        agent: agent.name,
        findings: 0,
        proposalsRaised: 0,
        suppressed: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  write(ctx, {
    eventType: 'AGENT_RUN_COMPLETED',
    entity: { refType: 'AgentRun', refId: runId },
    nextState: {
      id: runId,
      projectId: ctx.projectId,
      ranAt,
      agents: report.agents,
      proposalsRaised: report.proposals.length,
      suppressed: report.suppressed,
    },
  });

  return report;
}

function raiseProposal(
  ctx: EngineContext,
  agent: AgentDefinition,
  finding: Finding,
  proposed: { command: AgentProposal['command']; autonomy: AgentProposal['autonomy'] } | undefined,
  runId: string,
): AgentProposal {
  const proposal: AgentProposal = {
    id: ulid(),
    agent: agent.name,
    raisedAt: new Date().toISOString(),
    finding,
    command: proposed?.command,
    autonomy: proposed?.autonomy ?? 'OBSERVE',
    status: 'OPEN',
  };

  write(ctx, {
    eventType: 'AGENT_PROPOSAL_RAISED',
    entity: { refType: 'AgentProposal', refId: proposal.id },
    nextState: {
      ...proposal,
      runId,
      // Recorded on the proposal so an approver can see who may decide it
      // without having to look the agent up.
      approvers: agent.mandate.approvers,
      purpose: agent.purpose,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_HOURS * 3_600_000).toISOString(),
    } as unknown as Record<string, unknown>,
  });

  return proposal;
}

/**
 * Approve a proposal.
 *
 * The approver must hold the capability the command needs — not merely be
 * senior. Approval is recorded before the command runs, so if execution fails
 * the record still shows who authorised the attempt.
 *
 * This returns the command to execute rather than executing it. The caller —
 * the API layer, which already knows how to dispatch commands — runs it as the
 * approver. Keeping dispatch out of here means the runtime cannot become a
 * second, weaker path into the engines.
 */
export function approveProposal(
  ctx: EngineContext,
  proposalId: string,
  note?: string,
): { proposal: AgentProposal; execute?: AgentProposal['command'] } {
  const record = ctx.ledger.require({ refType: 'AgentProposal', refId: proposalId });
  const proposal = record.state as unknown as AgentProposal;

  if (proposal.status !== 'OPEN') {
    throw new DomainError('PROPOSAL_NOT_OPEN', `This proposal is ${proposal.status.toLowerCase()} and cannot be decided again`);
  }

  const agent = agentByName(proposal.agent);
  if (!agent) throw new DomainError('UNKNOWN_AGENT', `No agent named ${proposal.agent}`);

  // Rule 3: an agent cannot approve. Only a human identity reaches this path,
  // and only one holding the capability the command actually needs.
  if (ctx.source === 'SYSTEM') {
    throw new ForbiddenError('A proposal must be approved by a person, not by the system', 'HUMAN_APPROVAL_REQUIRED');
  }
  // Approving is an authorisation act, not merely doing the thing. It needs
  // both halves: the capability the command will exercise, and standing as one
  // of the roles this agent's mandate names as its approvers. Holding only the
  // first would let a read-only reviewer authorise the platform to act.
  if (!ctx.auth.roles.some((role) => agent.mandate.approvers.includes(role))) {
    throw new ForbiddenError(
      `Proposals from the ${agent.name} agent are approved by ${agent.mandate.approvers.join(', ')}`,
      'NOT_A_NOMINATED_APPROVER',
    );
  }

  if (proposal.command) {
    authorise(ctx, proposal.command.area, proposal.command.code);
    if (!rolesAllow(ctx.auth.roles, proposal.command.area, proposal.command.code)) {
      throw new ForbiddenError(
        `Approving this needs "${proposal.command.code}" on ${proposal.command.area}`,
        'APPROVAL_CAPABILITY_REQUIRED',
      );
    }
  }

  const decided: AgentProposal = {
    ...proposal,
    status: 'APPROVED',
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
    decisionNote: note,
  };

  write(ctx, {
    eventType: 'AGENT_PROPOSAL_APPROVED',
    entity: { refType: 'AgentProposal', refId: proposalId },
    nextState: { ...record.state, ...decided } as unknown as Record<string, unknown>,
  });

  return { proposal: decided, execute: proposal.command };
}

/**
 * Reject a proposal, with a reason.
 *
 * The reason is required. A rejected proposal is evidence — it shows the
 * platform raised something and a named person decided against it, which is
 * exactly the question asked after an incident.
 */
export function rejectProposal(ctx: EngineContext, proposalId: string, reason: string): AgentProposal {
  const record = ctx.ledger.require({ refType: 'AgentProposal', refId: proposalId });
  const proposal = record.state as unknown as AgentProposal;

  if (proposal.status !== 'OPEN') {
    throw new DomainError('PROPOSAL_NOT_OPEN', `This proposal is ${proposal.status.toLowerCase()} and cannot be decided again`);
  }
  if (!reason?.trim()) {
    throw new DomainError('REASON_REQUIRED', 'Rejecting a proposal requires a reason, because the rejection is part of the record');
  }

  // Rejecting is a decision, so it needs the same standing as approving —
  // otherwise anyone could clear the queue of things they did not want to see.
  const agent = agentByName(proposal.agent);
  if (agent && !ctx.auth.roles.some((role) => agent.mandate.approvers.includes(role))) {
    throw new ForbiddenError(
      `Proposals from the ${agent.name} agent are decided by ${agent.mandate.approvers.join(', ')}`,
      'NOT_A_NOMINATED_APPROVER',
    );
  }

  const decided: AgentProposal = {
    ...proposal,
    status: 'REJECTED',
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
    decisionNote: reason,
  };

  write(ctx, {
    eventType: 'AGENT_PROPOSAL_REJECTED',
    entity: { refType: 'AgentProposal', refId: proposalId },
    nextState: { ...record.state, ...decided } as unknown as Record<string, unknown>,
  });

  return decided;
}

/**
 * Mitigate: the finding was right, and it is being handled another way.
 *
 * The Build Standard puts four actions on every command centre — Review,
 * Accept, Mitigate, Assign — and only two of them existed. Approve was Accept
 * and Reject was neither, because rejecting says the finding was wrong.
 *
 * Most findings on a real project are neither approved nor wrong. An agent
 * proposes re-sequencing a package and the project manager has already agreed
 * a different recovery with the subcontractor; the finding was correct and the
 * command is not what is being done about it. Without this, that outcome had to
 * be recorded as a rejection, which is a lie about the finding, or left open,
 * which is a queue that fills with things somebody has already dealt with.
 *
 * **The mitigation text is mandatory.** A status of MITIGATED with no statement
 * of what is being done instead is worse than leaving the proposal open: it
 * reads as a control and it is a shrug. The same reasoning that makes a
 * rejection reason mandatory.
 */
export function mitigateProposal(ctx: EngineContext, proposalId: string, mitigation: string): AgentProposal {
  const record = ctx.ledger.require({ refType: 'AgentProposal', refId: proposalId });
  const proposal = record.state as unknown as AgentProposal;

  if (proposal.status !== 'OPEN') {
    throw new DomainError('PROPOSAL_NOT_OPEN', `This proposal is ${proposal.status.toLowerCase()} and cannot be decided again`);
  }
  if (!mitigation?.trim() || mitigation.trim().length < 10) {
    throw new DomainError(
      'MITIGATION_REQUIRED',
      'Closing a finding as mitigated requires a statement of what is being done instead',
    );
  }

  // Same standing as approving or rejecting. Closing a finding is a decision
  // however it is closed, and anyone who could do it without standing could
  // clear the queue of everything they did not want to look at.
  const agent = agentByName(proposal.agent);
  if (agent && !ctx.auth.roles.some((role) => agent.mandate.approvers.includes(role))) {
    throw new ForbiddenError(
      `Proposals from the ${agent.name} agent are decided by ${agent.mandate.approvers.join(', ')}`,
      'NOT_A_NOMINATED_APPROVER',
    );
  }

  const decided: AgentProposal = {
    ...proposal,
    status: 'MITIGATED',
    decidedBy: ctx.auth.actorId,
    decidedAt: new Date().toISOString(),
    mitigation: mitigation.trim(),
  };

  write(ctx, {
    eventType: 'AGENT_PROPOSAL_MITIGATED',
    entity: { refType: 'AgentProposal', refId: proposalId },
    nextState: { ...record.state, ...decided } as unknown as Record<string, unknown>,
  });

  return decided;
}

/**
 * Assign: name the person who is going to decide this.
 *
 * Deliberately **not** a decision. The proposal stays open, because assigning
 * something is not dealing with it, and a status that said otherwise would let
 * a queue be emptied by moving items around.
 *
 * What it changes is that "a QS may approve this" becomes "this QS is dealing
 * with it". `ownersFor` already resolves a capability to named identities and
 * orders them by specialisation; this records which of them took it.
 *
 * **The assignee must actually be able to decide it.** Assigning a proposal to
 * somebody who cannot approve it produces an item that looks owned and cannot
 * move, which is worse than an unassigned one — at least an unassigned item is
 * visibly nobody's. Checked against the raising agent's own approver list, the
 * same list every other decision here is checked against.
 */
export function assignProposal(
  ctx: EngineContext,
  proposalId: string,
  input: { assignee: { id: string; name: string; roles: readonly string[] }; note?: string },
): AgentProposal {
  const record = ctx.ledger.require({ refType: 'AgentProposal', refId: proposalId });
  const proposal = record.state as unknown as AgentProposal;

  if (proposal.status !== 'OPEN') {
    throw new DomainError('PROPOSAL_NOT_OPEN', `This proposal is ${proposal.status.toLowerCase()} and can no longer be assigned`);
  }

  const agent = agentByName(proposal.agent);
  if (agent && !input.assignee.roles.some((role) => agent.mandate.approvers.includes(role as never))) {
    throw new DomainError(
      'ASSIGNEE_CANNOT_DECIDE',
      `${input.assignee.name} holds no role that may decide a ${proposal.agent} proposal ` +
        `(${agent.mandate.approvers.join(', ')}). Assigning it would produce an item nobody can move.`,
    );
  }

  const assigned: AgentProposal = {
    ...proposal,
    assignedTo: input.assignee.id,
    assignedToName: input.assignee.name,
    assignedBy: ctx.auth.actorId,
    assignedAt: new Date().toISOString(),
    assignmentNote: input.note?.trim() || undefined,
  };

  write(ctx, {
    eventType: 'AGENT_PROPOSAL_ASSIGNED',
    entity: { refType: 'AgentProposal', refId: proposalId },
    nextState: { ...record.state, ...assigned } as unknown as Record<string, unknown>,
  });

  return assigned;
}

/** Mark an approved proposal as executed, once the command has actually run. */
export function markExecuted(ctx: EngineContext, proposalId: string, result: Record<string, unknown>): void {
  const record = ctx.ledger.require({ refType: 'AgentProposal', refId: proposalId });

  write(ctx, {
    eventType: 'AGENT_PROPOSAL_EXECUTED',
    entity: { refType: 'AgentProposal', refId: proposalId },
    nextState: {
      ...record.state,
      status: 'EXECUTED',
      executedAt: new Date().toISOString(),
      result,
    } as unknown as Record<string, unknown>,
  });
}

/** Everything currently awaiting a decision, most urgent first. */
/**
 * A proposal with the one thing the reader needs before anything else: whether
 * it is theirs to decide.
 *
 * The queue was undifferentiated — every open proposal, every role, one list.
 * That is four command centres sharing a panel that answers "what needs action
 * today" with somebody else's work. A QS scrolling past four design proposals
 * to find the variation is a QS who stops opening the panel.
 *
 * `mine` is read from the raising agent's own mandate, which already names the
 * roles that may approve it. Nothing new is asserted here and no capability is
 * granted: approval is still checked at the point of approval. This only says
 * whose queue an item belongs in, which is a question the data could always
 * answer and nothing was asking.
 *
 * A proposal that is not the caller's is marked rather than hidden. Somebody
 * needs to be able to see that a design decision has been sitting for a week,
 * and a queue that hides everything outside its owner's remit makes a stalled
 * item invisible to everyone but the person who is already not acting on it.
 */
export type QueuedProposal = AgentProposal & {
  /** True where a role the caller holds may approve this agent's proposals. */
  mine: boolean;
  /** Roles that may decide it. Named so an item that is not yours says who. */
  approvers: string[];
};

export function pendingProposals(ctx: EngineContext): QueuedProposal[] {
  const order = { URGENT: 0, ATTENTION: 1, INFO: 2 } as const;
  const roles = new Set(ctx.auth.roles);

  return openProposals(ctx)
    .map((proposal) => {
      const approvers = agentByName(proposal.agent)?.mandate.approvers ?? [];
      return {
        ...proposal,
        approvers: [...approvers],
        mine: approvers.some((role) => roles.has(role)),
      };
    })
    .sort(
      (a, b) =>
        // Mine first, then severity, then oldest. Severity ahead of ownership
        // would put somebody else's urgent item above the reader's own overdue
        // one, which is the ordering that made the panel unusable.
        Number(b.mine) - Number(a.mine) ||
        order[a.finding.severity] - order[b.finding.severity] ||
        a.raisedAt.localeCompare(b.raisedAt),
    );
}

/**
 * The fleet as published to a client, so the UI never hardcodes the roster.
 *
 * Every agent appears, running or not. `deployment` and `needs` are what stop
 * the manifest becoming a claim: an agent listed without an `evaluate` and
 * without a reason would read as capability the platform does not have, which
 * is exactly the failure the rest of it refuses.
 */
export function fleetManifest() {
  return AGENTS.map((agent) => ({
    name: agent.name,
    division: agent.division,
    purpose: agent.purpose,
    reads: agent.mandate.reads,
    proposes: agent.mandate.proposes,
    approvers: agent.mandate.approvers,
    maxUnattended: agent.mandate.maxUnattended,
    /** What an ACT grant against this agent could ever cover. Absent below ACT. */
    envelope: agent.mandate.envelope,
    deployment: agent.deployment ?? 'DEPLOYED',
    needs: agent.needs,
  }));
}
