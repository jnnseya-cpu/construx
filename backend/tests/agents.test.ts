import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { AGENTS } from '../src/agents/registry.ts';
import { AUTOMATABLE_COMMANDS, mayActUnattended } from '../src/agents/mandate.ts';
import { approveProposal, pendingProposals, rejectProposal, runAgents } from '../src/agents/runtime.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { rolesAllow } from '../src/identity/roles.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The autopilot, and the gate that keeps a human in charge of it.
 *
 * The tests that matter here are the negative ones. An agent fleet that finds
 * things is easy; one that cannot quietly act on its own findings is the
 * product.
 */

describe('agent fleet', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  const context = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

  it('every agent proposes only inside its own mandate', () => {
    for (const agent of AGENTS) {
      for (const area of agent.mandate.proposes) {
        assert.ok(
          agent.mandate.reads.includes(area) || agent.mandate.proposes.includes(area),
          `${agent.name} proposes in ${area} without reading it`,
        );
      }
      assert.ok(agent.mandate.approvers.length > 0, `${agent.name} has no approvers`);
      assert.ok(agent.purpose.length > 20, `${agent.name} does not say what it is for`);
    }
  });

  it('never proposes a command none of its approvers could approve', () => {
    // The runtime enforces this at raise time; asserting it statically means a
    // new agent fails the suite rather than the queue.
    for (const agent of AGENTS) {
      for (const area of agent.mandate.proposes) {
        const someoneCanRead = agent.mandate.approvers.some((role) => rolesAllow([role], area, 'R'));
        assert.ok(someoneCanRead, `no approver of ${agent.name} can even read ${area}`);
      }
    }
  });

  it('finds real things in the seeded project and names the records it read', async () => {
    const report = await runAgents(context('pm'));

    assert.ok(report.proposals.length > 0, 'the fleet found nothing in a project with a critical delay');
    assert.equal(report.agents.filter((a) => a.error).length, 0, 'an agent failed');

    for (const proposal of report.proposals) {
      assert.ok(proposal.finding.summary.length > 10);
      assert.ok(proposal.finding.consequence.length > 10, 'a finding must say why it matters');
      assert.equal(proposal.status, 'OPEN');
      assert.equal(proposal.decidedBy, undefined, 'a raised proposal must not arrive already decided');
    }
  });

  it('does not raise the same finding twice', async () => {
    // The fleet has already run in the test above, so everything it can see is
    // open. A further pass must suppress rather than repeat itself.
    const again = await runAgents(context('pm'));

    assert.ok(again.suppressed > 0, 'the run repeated findings that were already open');
    assert.equal(again.proposals.length, 0, 'nothing new happened, so nothing new should be raised');
  });

  it('records the run itself, so a quiet fleet is distinguishable from a stopped one', () => {
    const runs = platform.ledger.list(seed.projectId, 'AgentRun');
    assert.ok(runs.length >= 2);
    assert.ok(Number(runs.at(-1)!.state.proposalsRaised) >= 0);
  });
});

describe('the approval gate', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    await runAgents(platform.context(seed.users.pm!.auth, seed.projectId));
  });

  const context = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);
  const riskProposal = () =>
    pendingProposals(context('pm')).find((p) => p.command?.area === 'RISK_REGISTER')!;

  it('refuses a decision from someone the mandate does not nominate', () => {
    // QA/QC can read the risk register. Reading is not authorising.
    throwsCode(() => approveProposal(context('qaqc'), riskProposal().id), 'NOT_A_NOMINATED_APPROVER');
  });

  it('refuses a rejection from the same, so the queue cannot be quietly cleared', () => {
    throwsCode(() => rejectProposal(context('qaqc'), riskProposal().id, 'not now'), 'NOT_A_NOMINATED_APPROVER');
  });

  it('requires a reason to reject, because the rejection is part of the record', () => {
    throwsCode(() => rejectProposal(context('safety'), riskProposal().id, '   '), 'REASON_REQUIRED');
  });

  it('records who decided and what they said', () => {
    const proposal = riskProposal();
    const { proposal: decided } = approveProposal(context('safety'), proposal.id, 'Exposure has moved');

    assert.equal(decided.status, 'APPROVED');
    assert.equal(decided.decidedBy, seed.users.safety!.id);
    assert.equal(decided.decisionNote, 'Exposure has moved');
    assert.ok(decided.decidedAt);
  });

  it('refuses to decide the same proposal twice', () => {
    const decided = platform.ledger
      .list(seed.projectId, 'AgentProposal')
      .find((p) => p.state.status === 'APPROVED')!;

    throwsCode(() => approveProposal(context('safety'), decided.refId), 'PROPOSAL_NOT_OPEN');
    throwsCode(() => rejectProposal(context('safety'), decided.refId, 'changed my mind'), 'PROPOSAL_NOT_OPEN');
  });

  it('keeps a rejected proposal in the record rather than deleting it', () => {
    const open = pendingProposals(context('pm')).find((p) => p.agent === 'contracts');
    if (!open) return;

    const rejected = rejectProposal(context('pm'), open.id, 'Handled outside the platform this week');
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.decisionNote, 'Handled outside the platform this week');

    const stored = platform.ledger.get({ refType: 'AgentProposal', refId: open.id });
    assert.equal(stored?.state.status, 'REJECTED', 'a rejected proposal must still be readable');
  });
});

describe('an agent cannot decide for itself', () => {
  let fresh: Platform;
  let freshSeed: SeedResult;

  before(async () => {
    // Its own tenancy, deliberately. The point being tested is what an agent
    // may do where nobody has granted it anything, so a platform another
    // describe has been granting envelopes in would prove nothing.
    fresh = new Platform();
    freshSeed = await seedDemoProject(fresh);
  });

  const owner = () => fresh.context(freshSeed.users.owner!.auth, freshSeed.projectId);

  it('the ledger refuses an AI actor committing a decision', () => {
    // Defence in depth: even if the runtime guard were bypassed, the event
    // catalogue does not permit an AI actor to author an approval.
    const approved = lookupEventType('AGENT_PROPOSAL_APPROVED');
    const rejected = lookupEventType('AGENT_PROPOSAL_REJECTED');

    assert.equal(approved?.aiAllowed, false, 'an AI actor must not be able to approve');
    assert.equal(rejected?.aiAllowed, false, 'an AI actor must not be able to reject');

    // Raising one, by contrast, is exactly what an agent is for.
    assert.equal(lookupEventType('AGENT_PROPOSAL_RAISED')?.aiAllowed, true);
  });

  it('no agent grants itself unattended authority to act', () => {
    // This used to assert that no agent declared `ACT` at all. That was a
    // placeholder for a mechanism that did not exist yet, and its own failure
    // message said so: acting unattended "needs an explicit product decision,
    // not a default". The decision has now been taken for exactly one agent,
    // and the mechanism it needed is built — so the blanket ban is replaced by
    // the thing it was standing in for, which is strictly stronger.
    //
    // A ceiling of ACT in the registry is *eligibility*. Authority comes from an
    // envelope a person granted, recorded as a governed event no AI actor may
    // author, with an end date. See `mandate.test.ts`, which fails if an agent
    // can reach ACT without one.
    for (const agent of AGENTS) {
      if (agent.mandate.maxUnattended !== 'ACT') continue;

      const envelope = agent.mandate.envelope;
      assert.ok(envelope, `${agent.name} is ACT-eligible without declaring what such a grant could ever cover`);

      for (const command of envelope!.commands) {
        const entry = AUTOMATABLE_COMMANDS[command];
        assert.ok(entry, `${agent.name} may be granted "${command}", which is not in the automatable set`);
        for (const type of entry!.writes) {
          // The catalogue is the boundary. An agent may never be granted
          // anything that writes a decision a person is required to take.
          assert.equal(
            lookupEventType(type)?.aiAllowed,
            true,
            `${agent.name} could be granted ${command}, which writes ${type} — a decision a person must take`,
          );
        }
      }
    }
  });

  it('holds no unattended authority in a tenancy where nobody granted any', () => {
    // The property that matters more than the declaration: a fresh tenancy has
    // granted nothing, so nothing acts, however the registry is written.
    for (const agent of AGENTS.filter((candidate) => candidate.mandate.maxUnattended === 'ACT')) {
      for (const command of agent.mandate.envelope!.commands) {
        const verdict = mayActUnattended(owner(), agent.name, { command });
        assert.equal(verdict.permitted, false, `${agent.name} may run ${command} with nobody having granted it`);
      }
    }
  });
});
