import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import * as agents from '../src/agents/runtime.ts';
import type { AgentRunReport } from '../src/agents/types.ts';
import { AGENTS, deployedAgents, runnableAgents } from '../src/agents/registry.ts';

/**
 * Trigger routing — the contract's `triggers`, enforced.
 *
 * Every agent declared what wakes it and nothing read the declaration. The
 * fleet had one mode: run all forty-eight and see what they say. So an agent
 * whose entire purpose is to answer `DELAYEVENT_RECORDED` woke on the same
 * schedule as one watching the market, and the only way to ask "something just
 * happened, who cares" was to ask everybody — forty-eight evaluations, and a
 * queue where yesterday's findings are re-derived alongside today's.
 *
 * What is asserted here is the distinction that makes routing safe rather than
 * a quiet way of switching agents off:
 *
 * **A sweep still runs everything.** It is a person, or the morning briefing,
 * saying *look at everything now*. Narrowing it to `CONTINUOUS` agents would
 * have silently taken eighteen agents off the one path the whole product
 * already uses, which is a regression dressed as a feature.
 *
 * "Everything" means every agent *this tenancy may run*, which is the deployed
 * fleet minus any agent belonging to a private module the tenancy has not been
 * granted. That narrowing happens before the run rather than inside it, and the
 * distinction matters: the phase gate reports the agents it skipped, and a
 * module agent reported as skipped would tell a company a module exists that it
 * has not been given. So it is absent from the fleet, not absent from the run —
 * and a sweep still covers, exactly, the fleet.
 *
 * **A routed run is a strict subset, and the report says why each agent is in
 * it.** A run listing four agents out of forty-eight has to be readable as a
 * deliberate selection rather than a fleet that mostly failed to appear.
 *
 * **The loop is closed by construction.** A run writes `AGENT_RUN_COMPLETED`
 * and an `AGENT_PROPOSAL_RAISED` per finding. If those counted as changes, a
 * change-driven run would wake the fleet on its own output for ever.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

/** Agents that actually evaluated, as opposed to being gated out by phase. */
const ran = (report: AgentRunReport) => report.agents.filter((a) => a.skipped === undefined).map((a) => a.agent);

describe('a sweep is still a sweep', () => {
  it('runs the whole deployed fleet, as it always has', async () => {
    const report = await agents.runAgents(ctx());
    assert.equal(report.because, 'full sweep');
    assert.equal(
      report.agents.length,
      runnableAgents(ctx().grantedModules).length,
      'the sweep no longer covers the fleet this tenancy may run',
    );
  });

  it('leaves a module agent out of the fleet entirely for a tenancy without the grant', async () => {
    // Not "reports it as skipped" — out. A tenancy that has not been granted a
    // private module is never told it exists, and a run report naming an agent
    // called `etablix-welfare` would say so plainly.
    const withModule = runnableAgents(['ETABLIX']);
    const without = runnableAgents([]);
    assert.ok(withModule.length > without.length, 'no module agents to prove the point with');
    assert.ok(without.every((agent) => agent.module === undefined));

    const report = await agents.runAgents(ctx());
    assert.equal(ctx().grantedModules.length, 0, 'the demonstration tenancy holds no module');
    assert.ok(
      !report.agents.some((entry) => entry.agent.startsWith('etablix-')),
      'a module agent appeared in the report of a tenancy that does not hold the module',
    );
  });

  it('still runs agents that declare no continuous trigger', async () => {
    // The regression this guards. Eighteen deployed agents declare only EVENT
    // or SCHEDULE triggers; if a sweep routed, every one of them would go
    // quiet on the path the briefing and the console both use.
    const eventOnly = deployedAgents()
      .filter((agent) => agent.triggers.every((t) => t.kind === 'EVENT'))
      .map((agent) => agent.name);
    assert.ok(eventOnly.length > 0, 'no event-only agents left to prove the point with');

    const report = await agents.runAgents(ctx());
    const covered = new Set(report.agents.map((a) => a.agent));
    for (const name of eventOnly) {
      assert.ok(covered.has(name), `${name} declares only event triggers and a sweep left it out`);
    }
  });
});

describe('an event wakes the agents that declared it, and no others', () => {
  it('selects a strict subset', async () => {
    const sweep = await agents.runAgents(ctx());
    const routed = await agents.runAgents(ctx(), {
      trigger: { kind: 'EVENT', eventTypes: ['DELAYEVENT_RECORDED'] },
    });

    assert.ok(routed.agents.length > 0, 'nothing woke on a delay event, which several agents declare');
    assert.ok(
      routed.agents.length < sweep.agents.length,
      `routing selected ${routed.agents.length} of ${sweep.agents.length} — that is not a selection`,
    );

    // Everything selected must actually declare that trigger. Reading the
    // registry rather than trusting the runtime's own answer.
    for (const entry of routed.agents) {
      const agent = AGENTS.find((a) => a.name === entry.agent)!;
      assert.ok(
        agent.triggers.some((t) => t.kind === 'EVENT' && t.eventType === 'DELAYEVENT_RECORDED'),
        `${entry.agent} ran on a delay event it does not declare`,
      );
    }
  });

  it('wakes nothing at all for an event no agent watches', async () => {
    // Correct and worth stating: a quiet fleet is the right answer to an event
    // nobody declared, and it costs nothing.
    const report = await agents.runAgents(ctx(), {
      trigger: { kind: 'EVENT', eventTypes: ['MARKETING_CONSENT_SET'] },
    });
    assert.deepEqual(report.agents, []);
    assert.equal(report.proposals.length, 0);
  });

  it('says why each agent is in the run', async () => {
    const report = await agents.runAgents(ctx(), {
      trigger: { kind: 'EVENT', eventTypes: ['DELAYEVENT_RECORDED'] },
    });
    assert.match(report.because, /DELAYEVENT_RECORDED/);
    for (const entry of report.agents) {
      assert.match(entry.because ?? '', /woken by DELAYEVENT_RECORDED/, `${entry.agent} does not say why it ran`);
    }
  });

  it('counts an agent the event woke and the phase then declined', async () => {
    // Two different facts. "The event happened and the agent for it cannot run
    // in this phase" is a gap somebody may need to close; "no agent watches
    // that event" is not. Collapsing them would hide the first.
    const report = await agents.runAgents(ctx(), {
      trigger: { kind: 'EVENT', eventTypes: ['APPLICATION_SUBMITTED', 'DELAYEVENT_RECORDED'] },
    });
    assert.equal(report.gated, report.agents.filter((a) => a.skipped !== undefined).length);
  });
});

describe('a schedule wakes the agents that named that hour', () => {
  it('matches on the hour an agent declared', async () => {
    const report = await agents.runAgents(ctx(), { trigger: { kind: 'SCHEDULE', at: '06:00' } });
    assert.ok(report.agents.length > 0, 'nothing is scheduled at 06:00, which several agents declare');
    for (const entry of report.agents) {
      const agent = AGENTS.find((a) => a.name === entry.agent)!;
      assert.ok(agent.triggers.some((t) => t.kind === 'SCHEDULE' && t.at === '06:00'));
    }
  });

  it('leaves an hour nobody named alone', async () => {
    const report = await agents.runAgents(ctx(), { trigger: { kind: 'SCHEDULE', at: '03:17' } });
    assert.deepEqual(report.agents, []);
  });

  it('honours the days an agent named', async () => {
    // The weekly commercial agent runs on Mondays. A Wednesday tick must not
    // wake it, and a tick that does not say which day it is must — guessing
    // there means a Monday agent that silently never runs.
    const weekly = deployedAgents().find((agent) =>
      agent.triggers.some((t) => t.kind === 'SCHEDULE' && t.days !== undefined),
    );
    assert.ok(weekly, 'no agent declares days, so this cannot be tested');
    const schedule = weekly.triggers.find((t) => t.kind === 'SCHEDULE' && t.days !== undefined)!;
    assert.ok(schedule.kind === 'SCHEDULE' && schedule.days);

    const wrongDay = (schedule.days[0]! + 3) % 7;
    const onWrongDay = await agents.runAgents(ctx(), { trigger: { kind: 'SCHEDULE', at: schedule.at, day: wrongDay } });
    assert.ok(!ran(onWrongDay).includes(weekly.name), `${weekly.name} ran on a day it did not name`);

    const onItsDay = await agents.runAgents(ctx(), { trigger: { kind: 'SCHEDULE', at: schedule.at, day: schedule.days[0] } });
    assert.ok(
      onItsDay.agents.some((a) => a.agent === weekly.name),
      `${weekly.name} did not run on the day it named`,
    );
  });
});

describe('a person naming agents is not routed', () => {
  it('runs what was asked for whatever its triggers say', async () => {
    const report = await agents.runAgents(ctx(), { only: ['risk'] });
    assert.deepEqual(report.agents.map((a) => a.agent), ['risk']);
    assert.match(report.because, /asked for/);
    assert.match(report.agents[0]!.because ?? '', /asked for/);
  });
});

describe('running on what changed cannot wake itself', () => {
  it('never counts its own output as a change', async () => {
    // The re-entrancy cut, proved rather than commented. A run writes
    // AGENT_RUN_COMPLETED and one AGENT_PROPOSAL_RAISED per finding; if those
    // were changes, the second call would see them and go round again.
    await agents.runAgents(ctx());
    const first = await agents.runAgentsForChanges(ctx());
    assert.ok(
      !first.window.eventTypes.some((code) => code.startsWith('AGENT_')),
      `the window carried the runtime's own events: ${first.window.eventTypes.filter((c) => c.startsWith('AGENT_')).join(', ')}`,
    );

    const second = await agents.runAgentsForChanges(ctx());
    assert.deepEqual(second.window.eventTypes, [], 'a second pass found changes that were its own');
    assert.deepEqual(second.agents, []);
  });

  it('no agent declares a trigger on the runtime’s own events', () => {
    // The control behind the cut. If an agent declared AGENT_PROPOSAL_RAISED
    // the filter would be the only thing between the fleet and a loop, and a
    // filter is easier to relax than a test is to delete.
    for (const agent of AGENTS) {
      for (const trigger of agent.triggers) {
        if (trigger.kind !== 'EVENT') continue;
        assert.ok(
          !trigger.eventType.startsWith('AGENT_'),
          `${agent.agentId} triggers on ${trigger.eventType}, which the runtime writes itself`,
        );
      }
    }
  });

  it('wakes the right agent when a real event lands between runs', async () => {
    // The behaviour, end to end and on a live project rather than on a
    // constructed event list: sweep, let something actually happen, then ask
    // what changed. The commercial agent declares CVR_PUBLISHED and nothing
    // else in this window does.
    const construction = platform.ledger
      .entitiesOfType('Project')
      .find((record) => record.tenantId === seed.tenantId && record.state.phase === 'CONSTRUCTION');
    assert.ok(construction, 'the demonstration has no project in construction');

    const site = platform.context(seed.users.qs!.auth, String(construction.state.id), { source: 'WEB' });
    await agents.runAgents(site);

    // A real domain write, through the ledger the router reads.
    platform.ledger.commit({
      tenantId: seed.tenantId,
      projectId: String(construction.state.id),
      actor: { refType: 'User', refId: seed.users.qs!.id },
      source: 'WEB',
      correlationId: 'trigger-routing-test',
      eventType: 'CVR_PUBLISHED',
      entity: { refType: 'CVR', refId: 'cvr-routing-test' },
      nextState: { id: 'cvr-routing-test', publishedAt: new Date().toISOString() },
    });

    const routed = await agents.runAgentsForChanges(site);
    assert.deepEqual(routed.window.eventTypes, ['CVR_PUBLISHED'], 'the window did not see the write');
    assert.ok(
      routed.agents.some((a) => a.agent === 'commercial'),
      `the commercial agent declares CVR_PUBLISHED and did not wake: ${routed.agents.map((a) => a.agent).join(', ') || 'nothing ran'}`,
    );
    assert.ok(routed.agents.length < deployedAgents().length, 'a change woke the whole fleet');
  });

  it('takes its window from the last run rather than from all of history', async () => {
    const report = await agents.runAgentsForChanges(ctx());
    const lastRun = platform.ledger
      .list(seed.projectId, 'AgentRun')
      .map((r) => String(r.state.ranAt))
      .sort();
    // The window opens at a previous run, not at the project's first event.
    assert.ok(lastRun.includes(report.window.from), 'the window did not start at an agent run');
  });
});
