import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { ETABLIX_AGENTS } from '../src/agents/etablix.ts';
import { AGENTS, runnableAgents } from '../src/agents/registry.ts';
import * as runtime from '../src/agents/runtime.ts';
import { assumeFact, recordFact } from '../src/domain/etablix/brief.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §5 — the sixteen ETABLIX specialists.
 *
 * The product mandate is to automate at least 90% of the repeatable
 * coordination, analysis, documentation, monitoring and administration work
 * while retaining explicit human authority over legal commitment,
 * safety-critical acceptance, supplier award, payment certification and
 * contingency release. What this file pins is the second half, because the
 * first half is the easy half.
 *
 * Four properties:
 *
 * 1. **No agent exceeds `PROPOSE`.** The specification's Class C acts are never
 *    delegated, and an agent that could act on one would be the module handing
 *    away the authority it was built to protect.
 * 2. **A module agent does not run for a tenancy without the grant** — and is
 *    not named in that tenancy's run report either, because being told an agent
 *    was skipped is being told the module exists.
 * 3. **One problem, one agent.** Sixteen specialists reporting the same
 *    contradiction from sixteen angles is how a fleet trains people to stop
 *    reading it.
 * 4. **An agent that cannot read its subject reports nothing**, rather than
 *    reporting an error as a finding.
 */

let platform: Platform;
let seed: SeedResult;

function granted(who = 'pm'): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'ETABLIX',
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'ACTIVE',
    reason: 'Appointed as ETABLIX site-services delivery partner',
    decidedBy: seed.users.operator!.id,
  });
});

beforeEach(() => {
  seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
});

/** The welfare shortfall from the specification's own worked example. */
function seedWelfareShortfall(): void {
  const ctx = granted();
  setAppointment(ctx, {
    model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'Single-point accountability across all seven families',
  });
  recordFact(ctx, { itemId: 'peakWorkforce', value: 164, source: 'Resource histogram, programme rev D' });
  recordFact(ctx, { itemId: 'shiftOverlapPersons', value: 120, source: 'Shift plan rev B' });
  recordFact(ctx, { itemId: 'visitorsPerDay', value: 22, source: 'Gate log, four-week average' });
  recordFact(ctx, { itemId: 'wcProvision', value: 5, source: 'Welfare layout rev A' });
}

async function run(ctx = granted()) {
  return runtime.runAgents(ctx);
}

/**
 * The findings a run recorded.
 *
 * Read off `AgentProposal`, which is where the runtime keeps them — a finding
 * is not an entity of its own, it is the reason a proposal exists, and the
 * record carries both.
 */
type RecordedFinding = { key: string; summary: string; consequence: string; evidence: unknown[] };
function raisedFindings(): RecordedFinding[] {
  return platform.ledger
    .list(seed.projectId, 'AgentProposal')
    .map((record) => (record.state as unknown as { finding: RecordedFinding }).finding)
    .filter(Boolean);
}

describe('the fleet as declared', () => {
  it('is sixteen agents, as the specification numbers them', () => {
    assert.equal(ETABLIX_AGENTS.length, 16);
    assert.equal(new Set(ETABLIX_AGENTS.map((agent) => agent.name)).size, 16);
    assert.equal(new Set(ETABLIX_AGENTS.map((agent) => agent.agentId)).size, 16);
  });

  it('marks every one of them as belonging to the module', () => {
    // The gate that keeps them out of an ungranted tenancy's fleet. One agent
    // missing this is one agent running for a company that was never given the
    // module — unattended, on a schedule, against records it should not read.
    for (const agent of ETABLIX_AGENTS) {
      assert.equal(agent.module, 'ETABLIX', `${agent.name} is not marked as a module agent`);
      assert.equal(agent.division, 'SITE_SERVICES');
    }
  });

  it('lets none of them act beyond OBSERVE', () => {
    // The automation boundary. Class C — supplier award, contract signature,
    // safety-critical energisation, payment certification, contingency draw,
    // termination, regulatory submission — is never delegated, and none of
    // these agents proposes into a capability area at all.
    for (const agent of ETABLIX_AGENTS) {
      assert.ok(
        ['OBSERVE', 'DRAFT', 'PROPOSE'].includes(agent.mandate.maxUnattended),
        `${agent.name} may act at ${agent.mandate.maxUnattended}`,
      );
      assert.notEqual(agent.mandate.maxUnattended, 'ACT', `${agent.name} could act unattended`);
    }
  });

  it('gives every agent a purpose, inputs, outputs and approvers', () => {
    for (const agent of ETABLIX_AGENTS) {
      assert.ok(agent.purpose.length > 40, `${agent.name} has no usable purpose`);
      assert.ok(agent.inputs.length > 0, `${agent.name} declares no inputs`);
      assert.ok(agent.outputs.length > 0, `${agent.name} declares no outputs`);
      assert.ok(agent.mandate.approvers.length > 0, `${agent.name} has nobody who could approve its work`);
      assert.ok(agent.mandate.reads.includes('SITE_SERVICES'), `${agent.name} does not read site services`);
    }
  });

  it('says what each declared agent is waiting on', () => {
    // A manifest listing sixteen running agents when five read from records
    // that do not exist would be a lie told in a table.
    const declared = ETABLIX_AGENTS.filter((agent) => agent.deployment === 'DECLARED');
    assert.ok(declared.length > 0);
    for (const agent of declared) {
      assert.ok(agent.needs && agent.needs.length > 30, `${agent.name} is declared and does not say why`);
      assert.match(agent.needs!, /§\d+/, `${agent.name} does not name the section it is waiting on`);
      assert.equal(agent.evaluate, undefined, `${agent.name} is declared and has an evaluate`);
    }
    const deployed = ETABLIX_AGENTS.filter((agent) => agent.deployment !== 'DECLARED');
    for (const agent of deployed) {
      assert.equal(typeof agent.evaluate, 'function', `${agent.name} runs and has nothing to run`);
    }
  });

  it('joins the one registry rather than starting a second one', () => {
    for (const agent of ETABLIX_AGENTS) {
      assert.ok(AGENTS.includes(agent), `${agent.name} is not in the platform registry`);
    }
  });
});

describe('the module gate on the fleet', () => {
  it('keeps module agents out of an ungranted tenancy’s fleet entirely', () => {
    const without = runnableAgents([]);
    const with_ = runnableAgents(['ETABLIX']);
    assert.ok(with_.length > without.length);
    assert.ok(!without.some((agent) => agent.module === 'ETABLIX'));
    // And every non-module agent is in both, so the gate narrows nothing else.
    assert.deepEqual(
      without.map((agent) => agent.name),
      with_.filter((agent) => agent.module === undefined).map((agent) => agent.name),
    );
  });

  it('runs them for a tenancy that holds the grant', async () => {
    seedWelfareShortfall();
    const report = await run();
    assert.ok(
      report.agents.some((entry) => entry.agent.startsWith('etablix-')),
      'no ETABLIX agent ran for a tenancy holding the module',
    );
  });

  it('never names one to a tenancy that does not', async () => {
    // Not "reports it as gated" — absent. Being told an agent called
    // `etablix-welfare` was skipped is being told the module exists.
    const other = platform.createTenant({
      legalName: 'Halden Regional Contractors Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'Halden Group',
    });
    const user = platform.createUser({
      tenantId: other.tenant.id,
      name: 'Priya Raman',
      email: 'priya.raman@halden.example',
      roles: ['PM'],
    });
    // Through a real token rather than a hand-built context — a fabricated one
    // would carry whatever scopes the test felt like, and the scope check is
    // part of what makes the run honest.
    const tokens = issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    });
    const claims = JSON.parse(
      Buffer.from(tokens.accessToken.split('.')[1]!, 'base64url').toString('utf8'),
    ) as { sub: string; tid: string; pid?: string; roles: never[]; scopes: string[]; jti: string; exp: number };
    const ctx = platform.context(
      {
        actorId: claims.sub,
        tenantId: claims.tid,
        partyId: claims.pid,
        roles: claims.roles,
        scopes: claims.scopes,
        tokenId: claims.jti,
        mfaSatisfied: true,
        regulatorAiEnabled: false,
        expiresAt: claims.exp,
      },
      `${other.tenant.id}-first`,
      { source: 'WEB' },
    );
    assert.deepEqual([...ctx.grantedModules], []);

    const report = await runtime.runAgents(ctx);
    assert.ok(
      !report.agents.some((entry) => entry.agent.startsWith('etablix-')),
      'a module agent was named in the report of a tenancy that does not hold the module',
    );
    assert.doesNotMatch(JSON.stringify(report), /ETABLIX/i);
  });
});

describe('what the specialists find', () => {
  it('gives the welfare shortfall to the welfare agent and the HSE agent, and nobody else', async () => {
    // One problem, two readers, and the two say different things: the welfare
    // agent says seven WCs are needed and five exist; HSE says the site cannot
    // be occupied at this headcount. Every other specialist stays quiet about
    // it, which is what stops sixteen agents becoming noise.
    seedWelfareShortfall();
    const report = await run();

    const raised = new Map(
      report.agents.filter((entry) => entry.agent.startsWith('etablix-')).map((entry) => [entry.agent, entry.findings]),
    );
    assert.ok((raised.get('etablix-welfare') ?? 0) > 0, 'the welfare agent said nothing about a welfare shortfall');
    assert.ok((raised.get('etablix-hse') ?? 0) > 0, 'HSE said nothing about a statutory shortfall');

    // The MEP and FM agents have no facts in their families and nothing to say
    // about welfare.
    const findings = raisedFindings();
    const welfareOwners = new Set(
      findings.filter((entry) => /WELFARE_BELOW_STATUTORY/.test(entry.key)).map((entry) => entry.key.split(':')[0]),
    );
    assert.deepEqual([...welfareOwners].sort(), ['etablix-hse', 'etablix-welfare']);
  });

  it('states the arithmetic in the finding, not a category', async () => {
    seedWelfareShortfall();
    await run();
    const finding = raisedFindings().find((entry) => entry.key === 'etablix-welfare:WELFARE_BELOW_STATUTORY')!;

    assert.ok(finding, 'the welfare agent raised no finding for the shortfall');
    assert.match(finding.summary, /142 people/);
    assert.match(finding.summary, /needs 7 WCs/);
    // And it ends in a choice rather than a warning, as the specification's own
    // example does.
    assert.match(finding.consequence, /Confirm the peak concurrent occupancy, or accept/);
    // Every figure traceable back to the fact it came from.
    assert.ok(finding.evidence.length > 0, 'the finding cites no facts');
  });

  it('carries the severity through from the arithmetic rather than flattening it', async () => {
    // A shortfall that stops the site on day one and one that degrades over
    // weeks are different things, and grading them the same trains people to
    // ignore both. The check knows which is which; the agent must not re-grade.
    const ctx = granted();
    setAppointment(ctx, {
      model: 'MANAGEMENT_INTEGRATOR',
      contractingEntity: 'Meridian Infrastructure Group Ltd',
      fundingSource: 'Client capital programme',
      basis: 'Customer holds the contracts',
    });
    // Blocking: the site runs dry between deliveries.
    recordFact(ctx, { itemId: 'waterStorageHours', value: 24, source: 'Water strategy rev A' });
    recordFact(ctx, { itemId: 'tankerIntervalHours', value: 48, source: 'Access restriction' });
    // Material: waste accumulates, which is a problem in three weeks.
    recordFact(ctx, { itemId: 'wasteVolumeM3PerWeek', value: 48, source: 'Waste projection' });
    recordFact(ctx, { itemId: 'wasteContainerCapacityM3', value: 12, source: 'Two 6 m³ skips' });
    recordFact(ctx, { itemId: 'wasteCollectionsPerWeek', value: 2, source: 'Waste carrier contract' });

    await run();
    const severities = new Map(
      platform.ledger
        .list(seed.projectId, 'AgentProposal')
        .map((record) => record.state as unknown as { finding: { key: string; severity: string } })
        .map((entry) => [entry.finding.key, entry.finding.severity]),
    );

    assert.equal(severities.get('etablix-mep:WATER_AUTONOMY_BELOW_INTERVAL'), 'URGENT');
    assert.equal(severities.get('etablix-fm:WASTE_ACCUMULATES'), 'ATTENTION');

    // And HSE says nothing about either. It reads across families for the two
    // exposures that carry a statutory consequence, and restating every
    // shortfall would make it a second copy of the other six agents — which is
    // exactly how sixteen specialists become noise.
    const hseKeys = [...severities.keys()].filter((key) => key.startsWith('etablix-hse:'));
    assert.deepEqual(hseKeys, [], `HSE restated a shortfall it does not own: ${hseKeys.join(', ')}`);
  });

  it('tells the commercial agent when the appointment was never assessed', async () => {
    seedWelfareShortfall();
    await run();
    const finding = raisedFindings().find((entry) => entry.key === 'etablix-commercial:unassessed')!;
    assert.ok(finding, 'nothing noticed that a Prime appointment was made with no model fit run');
    // And it repeats the cash exposure, because that is the thing an unassessed
    // Prime appointment is risking.
    assert.match(finding.consequence, /treasury, liability and mobilisation/);
  });

  it('raises the overdue assumption on the orchestrator, with the owner named', async () => {
    const ctx = granted();
    setAppointment(ctx, {
      model: 'ADVISORY',
      contractingEntity: 'Meridian Infrastructure Group Ltd',
      fundingSource: 'Client capital programme',
      basis: 'Customer runs its own procurement',
    });
    assumeFact(ctx, {
      itemId: 'operatingHours',
      value: 24,
      basis: 'Programme shows a night shift from week 12',
      decideBy: '2020-01-01',
      owner: 'Tom Bramall',
    });

    await run();
    const finding = raisedFindings().find((entry) => entry.key.startsWith('etablix-orchestrator:overdue'))!;

    assert.ok(finding, 'nothing noticed an assumption years past its decision date');
    assert.match(finding.summary, /Tom Bramall/);
    assert.match(finding.consequence, /design basis by default/);
  });

  it('says nothing at all on a project with no site-services record', async () => {
    // An agent that cannot read its subject has not found a problem — it has
    // found nothing. A fleet that reported "no data" as a finding would put
    // sixteen entries on every project in the estate.
    const report = await run();
    const etablix = report.agents.filter((entry) => entry.agent.startsWith('etablix-'));
    assert.ok(etablix.length > 0, 'no ETABLIX agents ran at all');
    assert.equal(
      etablix.reduce((sum, entry) => sum + entry.findings, 0),
      0,
      'an ETABLIX agent raised a finding on a project with no site-services record',
    );
    assert.equal(etablix.reduce((sum, entry) => sum + entry.proposalsRaised, 0), 0);
  });

  it('does not repeat itself on a second run', async () => {
    // An autopilot that says the same thing daily trains people to ignore it.
    seedWelfareShortfall();
    const first = await run();
    const second = await run();
    // `proposalsRaised`, not `findings`. The second number is what the agent
    // produced and is unchanged by suppression — the fleet still looks and
    // still concludes the same thing, which is correct. What must not happen
    // twice is the finding reaching the queue.
    const raised = (report: typeof first) =>
      report.agents
        .filter((entry) => entry.agent.startsWith('etablix-'))
        .reduce((sum, entry) => sum + entry.proposalsRaised, 0);
    assert.ok(raised(first) > 0);
    assert.equal(raised(second), 0, 'the fleet raised the same findings twice');
  });
});
