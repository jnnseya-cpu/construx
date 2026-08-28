import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AGENTS } from '../src/agents/registry.ts';
import { LIFECYCLE_AGENTS } from '../src/agents/lifecycle.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';
import { LIFECYCLE_ORDER } from '../src/lifecycle/phases.ts';
import { AUTONOMY_LADDER } from '../src/agents/types.ts';

/**
 * The Agent Contract, held to what the specification requires.
 *
 * Part 2 says every agent declares twelve fields, and six of them had nowhere
 * to live: `active_in_states`, `triggers`, `emits`, `confidence_floor`,
 * `acu_tier` and `memory_access`. A declaration nothing checks is decoration,
 * so these assertions are what make the contract real — the type system forces
 * the fields to exist, and this file forces them to mean something.
 *
 * What is deliberately *not* asserted: that the fleet is exactly thirty-five.
 * The specification names thirty-five and this platform also runs agents it
 * never named — a tender radar, a pipeline agent, twenty that watch the
 * platform rather than a project. Pinning a total would make adding a useful
 * agent a test failure, which is the wrong incentive. What is pinned is that
 * every agent the specification *does* name exists.
 */

const SPEC_AGENTS = [
  'AGT-FEASIBILITY', 'AGT-BENCH-COST', 'AGT-CONSENTS', 'AGT-CARBON-ESG', 'AGT-CONCEPT-RISK',
  'AGT-SCOPE-GAP', 'AGT-SPEC-INTEL', 'AGT-COST-PLAN', 'AGT-BIM-TWIN', 'AGT-DESIGN-RISK',
  'AGT-DESIGN-COORD', 'AGT-TENDER-INTEL', 'AGT-ESTIMATE', 'AGT-RETURN-INTEL', 'AGT-CONTRACT-RISK',
  'AGT-BID-PROG', 'AGT-CHANGE', 'AGT-PAYMENT', 'AGT-QUALITY', 'AGT-CLAIMS', 'AGT-PROCURE',
  'AGT-PROG-DELAY', 'AGT-COMMERCIAL', 'AGT-SITE-PROGRESS', 'AGT-HSE', 'AGT-CONTRACT-OBS',
  'AGT-COMMISSIONING', 'AGT-PC-READINESS', 'AGT-OM-CHASE', 'AGT-COBIE', 'AGT-HANDOVER',
  'AGT-GOLDEN-THREAD', 'AGT-FM-ASSET', 'AGT-LESSONS', 'AGT-SPEC-INTEL',
];

describe('every agent the specification names exists', () => {
  it('carries all thirty-five', () => {
    const built = new Set(AGENTS.map((a) => a.agentId));
    const missing = [...new Set(SPEC_AGENTS)].filter((id) => !built.has(id)).sort();
    assert.deepEqual(missing, [], `agents named in the specification with nothing built:\n  ${missing.join('\n  ')}`);
  });

  it('gives every agent a unique id and a unique name', () => {
    const ids = AGENTS.map((a) => a.agentId);
    const names = AGENTS.map((a) => a.name);
    assert.equal(new Set(ids).size, ids.length, 'two agents share an id');
    assert.equal(new Set(names).size, names.length, 'two agents share a name');
  });
});

describe('the contract fields mean something', () => {
  it('declares lifecycle states that exist', () => {
    for (const agent of AGENTS) {
      if (agent.activeIn === 'ANY') continue;
      assert.ok(agent.activeIn.length > 0, `${agent.agentId} declares an empty state list, which can never run`);
      for (const phase of agent.activeIn) {
        assert.ok(LIFECYCLE_ORDER.includes(phase), `${agent.agentId} names ${phase}, which is not a lifecycle phase`);
      }
    }
  });

  it('triggers on events the catalogue actually holds', () => {
    // An agent triggered by an event nothing can emit never wakes. The
    // catalogue is closed, so this is checkable rather than a matter of
    // spelling discipline.
    const codes = new Set(EVENT_TYPES.map((e) => e.code));
    for (const agent of AGENTS) {
      assert.ok(agent.triggers.length > 0, `${agent.agentId} has no trigger, so nothing would ever wake it`);
      for (const trigger of agent.triggers) {
        if (trigger.kind !== 'EVENT') continue;
        assert.ok(
          codes.has(trigger.eventType),
          `${agent.agentId} triggers on ${trigger.eventType}, which is not in the closed event catalogue`,
        );
      }
    }
  });

  it('emits only events the catalogue holds', () => {
    const codes = new Set(EVENT_TYPES.map((e) => e.code));
    for (const agent of AGENTS) {
      for (const code of agent.emits) {
        assert.ok(codes.has(code), `${agent.agentId} claims to emit ${code}, which does not exist`);
      }
    }
  });

  it('sets a confidence floor inside 0 and 1', () => {
    for (const agent of AGENTS) {
      assert.ok(
        agent.confidenceFloor >= 0 && agent.confidenceFloor <= 1,
        `${agent.agentId} has a confidence floor of ${agent.confidenceFloor}`,
      );
    }
  });

  it('never writes a memory layer it cannot read', () => {
    // Writing what you cannot read is how a memory layer gets overwritten with
    // something inconsistent with what is already in it.
    for (const agent of AGENTS) {
      for (const layer of agent.memory.writes) {
        assert.ok(
          agent.memory.reads.includes(layer),
          `${agent.agentId} writes ${layer} memory without reading it`,
        );
      }
    }
  });

  it('keeps organisation memory writable by very few', () => {
    // What one agent writes here, every future project on every other job is
    // told. It is not a per-project decision and the list should be short
    // enough to name.
    const writers = AGENTS.filter((a) => a.memory.writes.includes('ORGANISATION')).map((a) => a.agentId);
    assert.ok(
      writers.length <= 3,
      `${writers.length} agents write organisation memory: ${writers.join(', ')}. That is estate-wide learning, and it needs a short list.`,
    );
  });

  it('requires approval wherever the output binds the business', () => {
    // The specification's `hitl`, and the check that it is not decorative: an
    // agent whose output leads to a commitment must not be NONE.
    const binding = ['AGT-TENDER-INTEL', 'AGT-CONTRACT-RISK', 'AGT-PAYMENT', 'AGT-CLAIMS', 'AGT-PC-READINESS', 'AGT-GOLDEN-THREAD'];
    for (const id of binding) {
      const agent = AGENTS.find((a) => a.agentId === id);
      assert.ok(agent, `${id} is missing`);
      assert.equal(agent.hitl, 'APPROVAL', `${id} produces a binding output and does not require approval`);
    }
  });

  it('never lets an agent propose outside what it reads', () => {
    for (const agent of AGENTS) {
      for (const area of agent.mandate.proposes) {
        assert.ok(
          agent.mandate.reads.includes(area),
          `${agent.agentId} proposes in ${area} without reading it`,
        );
      }
    }
  });

  it('keeps unattended action rare, declared and worth nothing', () => {
    // `ACT` is the only rung that changes anything without a person, so the
    // whole list is pinned here: adding an agent to it is an edit to this test,
    // which is a code review rather than a quiet widening of what machines may
    // do on their own.
    //
    // Eligibility is still not authority — `agents/mandate.ts` requires a human
    // with governance authority to grant a live envelope before any of this
    // runs — but the list is the ceiling on what could ever be granted.
    const acting = AGENTS.filter((a) => a.mandate.maxUnattended === 'ACT').map((a) => a.agentId).sort();
    assert.deepEqual(acting, ['CX-PLATFORM-HEALTH'], 'the set of agents eligible to act unattended has changed');

    for (const agent of AGENTS) {
      assert.ok(AUTONOMY_LADDER.includes(agent.mandate.maxUnattended), `${agent.agentId} has an unknown ceiling`);
      if (agent.mandate.maxUnattended !== 'ACT') continue;

      // An envelope is required at `ACT`, and every one of them carries a value
      // ceiling of zero. Unattended work is confined to what costs nothing to
      // be wrong about — raising an alert, closing one — and no agent may
      // commit a customer to money without a human.
      const envelope = agent.mandate.envelope;
      assert.ok(envelope, `${agent.agentId} may act unattended with no envelope declaring what that covers`);
      assert.ok(envelope.commands.length > 0, `${agent.agentId} has an envelope covering no commands`);
      assert.equal(
        envelope.valueCeilingMinor,
        0,
        `${agent.agentId} may commit ${envelope.valueCeilingMinor} minor units without a human`,
      );
      assert.ok(envelope.because.length > 20, `${agent.agentId}'s envelope gives an approver nothing to read`);
    }
  });
});

describe('an agent that cannot see its inputs is declared, not deployed', () => {
  it('names what each declared agent is waiting on', () => {
    for (const agent of LIFECYCLE_AGENTS) {
      if (agent.deployment !== 'DECLARED') continue;
      assert.ok(agent.needs && agent.needs.length > 30, `${agent.agentId} is declared without saying what it needs`);
      assert.equal(agent.evaluate, undefined, `${agent.agentId} is declared and still carries an evaluate`);
    }
  });

  it('gives every deployed agent something to run', () => {
    for (const agent of LIFECYCLE_AGENTS) {
      if (agent.deployment === 'DECLARED') continue;
      assert.equal(typeof agent.evaluate, 'function', `${agent.agentId} is deployed with nothing to run`);
    }
  });
});
