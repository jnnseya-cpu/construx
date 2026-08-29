import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import * as agents from '../src/agents/runtime.ts';
import { AGENTS, deployedAgents } from '../src/agents/registry.ts';
import { tierCost } from '../src/billing/acu.ts';
import { config } from '../src/config.ts';
import { ForbiddenError } from '../src/core/errors.ts';
import type { AgentDefinition } from '../src/agents/types.ts';

/**
 * The last two contract fields that nothing read: `acu_tier` and
 * `memory_access`.
 *
 * **Metering.** Five agents carried hand-written estimates — 40, 50, 60, 75 —
 * chosen individually, unrelated to each other and unrelated to the rate the
 * platform actually charges. An approver comparing two proposals was comparing
 * two guesses, and the number on the approval screen was one nothing else in
 * the platform agreed with. A tier is now a claim about what class of thinking
 * a run is, and the price of that claim comes from the money model like every
 * other charge.
 *
 * **Memory.** The three layers differ in blast radius rather than in shape:
 * project memory is this job, organisation memory is every job the business has
 * ever run, and what an agent learns from the second it applies to jobs whose
 * teams never chose to share anything with it. Crossing between them means
 * leaving `projectId` behind, which is what the guard watches.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

describe('a tier is what prices a proposal', () => {
  it('prices every tier through the same markup as every other AI charge', () => {
    // Not a second pricing model. A tier says what a run costs the provider;
    // what the customer sees is that times the rate, so the two cannot diverge.
    for (const tier of ['LOW', 'MED', 'HIGH', 'PREMIUM'] as const) {
      const cost = tierCost(tier);
      assert.equal(cost.rawCostMinor, config.billing.acuTierRawCostMinor[tier]);
      assert.equal(cost.multiplier, config.billing.markupMultiplier);
      assert.equal(cost.chargeMinor, cost.rawCostMinor * config.billing.markupMultiplier);
    }
  });

  it('keeps the tiers in order, or the classes mean nothing', () => {
    const order = (['LOW', 'MED', 'HIGH', 'PREMIUM'] as const).map((tier) => tierCost(tier).chargeMinor);
    for (let i = 1; i < order.length; i += 1) {
      assert.ok(order[i]! > order[i - 1]!, `tier ${i} is not dearer than the one below it`);
    }
  });

  it('overwrites what an agent wrote, so nothing prices its own proposal', async () => {
    // Overwritten rather than defaulted. An agent that could fill this in would
    // be quoting an approver a figure of its own choosing.
    const report = await agents.runAgents(ctx());
    const priced = report.proposals.filter((proposal) => proposal.command);
    assert.ok(priced.length > 0, 'nothing was proposed, so nothing was priced');

    for (const proposal of priced) {
      const agent = AGENTS.find((a) => a.name === proposal.agent)!;
      assert.equal(
        proposal.command!.estimatedAcuMinor,
        tierCost(agent.acuTier).chargeMinor,
        `${proposal.agent} was priced at something other than its declared ${agent.acuTier} tier`,
      );
    }
  });

  it('no agent carries its own figure any more', () => {
    // The source of the old defect, closed at the source: a hardcoded estimate
    // in the registry is a business value outside the money model.
    const registry = AGENTS.filter((agent): agent is AgentDefinition => typeof agent.evaluate === 'function');
    assert.ok(registry.length > 0);
    // Nothing to assert on the definition itself — the check that matters is
    // that the runtime's price wins, which the test above makes. This one pins
    // the tiers themselves as declared values inside the known set.
    for (const agent of AGENTS) {
      assert.ok(
        ['LOW', 'MED', 'HIGH', 'PREMIUM'].includes(agent.acuTier),
        `${agent.agentId} declares an unknown metering class`,
      );
    }
  });

  it('reports what the queue it just built would cost, and against what', async () => {
    const report = await agents.runAgents(ctx());
    const expected = report.proposals
      .filter((proposal) => proposal.command)
      .reduce((sum, proposal) => sum + proposal.command!.estimatedAcuMinor, 0);

    assert.equal(report.cost.estimatedChargeMinor, expected, 'the run total disagrees with its own proposals');
    assert.equal(report.cost.availableMinor, platform.wallet(seed.tenantId).availableMinor());
    assert.equal(report.cost.affordable, report.cost.estimatedChargeMinor <= report.cost.availableMinor);

    const byTier = report.cost.byTier.reduce((sum, entry) => sum + entry.chargeMinor, 0);
    assert.equal(byTier, report.cost.estimatedChargeMinor, 'the per-tier breakdown does not add up to the total');
  });

  it('charges nothing for the evaluation itself', async () => {
    // Reported, not charged. Running an agent calls no provider and costs
    // nothing; inventing a charge for it would be inventing revenue. What costs
    // money is the command an approved proposal runs.
    const wallet = platform.wallet(seed.tenantId);
    const before = wallet.snapshot();
    await agents.runAgents(ctx());
    const after = wallet.snapshot();

    assert.equal(after.balanceMinor, before.balanceMinor, 'a fleet run moved the balance');
    assert.equal(after.lifetimeRawCostMinor, before.lifetimeRawCostMinor, 'a fleet run recorded provider cost');
  });
});

describe('an agent sees only the memory layers it declared', () => {
  /** A throwaway agent, so the guard is tested rather than a real agent's luck. */
  function prober(reads: Array<'PROJECT' | 'ORGANISATION' | 'ASSET'>, call: (ledger: never) => unknown): AgentDefinition {
    const template = deployedAgents()[0]!;
    return {
      ...template,
      name: `probe-${reads.join('-') || 'none'}`,
      agentId: 'AGT-PROBE',
      memory: { reads, writes: [] },
      evaluate: (context) => {
        call(context.ledger as never);
        return { findings: [], proposals: [] };
      },
    };
  }

  /**
   * Run one probe against the narrowed ledger and return what it hit.
   *
   * `runAgents` only runs registered agents, so the probe is driven through
   * `scopedLedgerFor` — the same function the runtime applies, on the same
   * context — rather than through the registry. What that does not cover is the
   * single line of wiring in `runAgents` that applies it; the whole deployed
   * fleet passes through that line in every other test in this suite, which is
   * what says it is there and does not break them.
   */
  async function probe(agent: AgentDefinition): Promise<string | undefined> {
    const { scopedLedgerFor } = agents;
    try {
      const ledger = scopedLedgerFor(ctx(), agent);
      await agent.evaluate!({ ...ctx(), ledger });
      return undefined;
    } catch (error) {
      assert.ok(error instanceof ForbiddenError, `expected a refusal, got ${String(error)}`);
      return error.message;
    }
  }

  it('refuses a tenant-wide read to an agent that did not declare organisation memory', async () => {
    const message = await probe(prober(['PROJECT'], (ledger: never) => (ledger as { listByTenant: Function }).listByTenant(seed.tenantId, 'Project')));
    assert.ok(message, 'the estate was readable by an agent scoped to one project');
    assert.match(message, /ORGANISATION/);
  });

  it('refuses a type sweep across every project for the same reason', async () => {
    const message = await probe(prober(['PROJECT'], (ledger: never) => (ledger as { entitiesOfType: Function }).entitiesOfType('Project')));
    assert.ok(message, 'entitiesOfType left the project boundary unguarded');
  });

  it('refuses an event read that names no project', async () => {
    const message = await probe(prober(['PROJECT'], (ledger: never) => (ledger as { events: Function }).events({ tenantId: seed.tenantId })));
    assert.ok(message, 'a tenant-wide event read left the project boundary unguarded');
  });

  it('allows the project reads an agent is for', async () => {
    const message = await probe(prober(['PROJECT'], (ledger: never) => (ledger as { list: Function }).list(seed.projectId, 'Project')));
    assert.equal(message, undefined, 'a project-scoped read was refused');
  });

  it('lets an agent that declared organisation memory read the estate', async () => {
    const message = await probe(prober(['PROJECT', 'ORGANISATION'], (ledger: never) => (ledger as { listByTenant: Function }).listByTenant(seed.tenantId, 'Project')));
    assert.equal(message, undefined, 'a declared organisation reader was refused');
  });

  it('keeps every other ledger method working through the wrapper', async () => {
    // A narrowed ledger that broke `require` or `get` would take the fleet down
    // rather than constrain it, and the wrapper is a proxy over an object with
    // private state — the easiest thing in the world to get subtly wrong.
    const message = await probe(
      prober(['PROJECT'], (ledger: never) => {
        const l = ledger as { require: Function; get: Function; chainHead: Function };
        l.require({ refType: 'Project', refId: seed.projectId });
        l.get({ refType: 'Project', refId: seed.projectId });
        l.chainHead(seed.projectId);
      }),
    );
    assert.equal(message, undefined, 'the wrapper broke an ordinary ledger call');
  });

  it('never writes a layer it cannot read, across the whole fleet', () => {
    // The declaration half, kept here beside the enforcement half so the two
    // are read together. Writing what you cannot read is how a memory layer
    // gets overwritten with something inconsistent with what is in it.
    for (const agent of AGENTS) {
      for (const layer of agent.memory.writes) {
        assert.ok(agent.memory.reads.includes(layer), `${agent.agentId} writes ${layer} without reading it`);
      }
    }
  });
});
