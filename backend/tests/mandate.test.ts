import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  envelopeRegister,
  grantEnvelope,
  liveEnvelope,
  mayActUnattended,
  revokeEnvelope,
  AUTOMATABLE_COMMANDS,
  assertCommandMayBeAutomated,
  MAX_ENVELOPE_DAYS,
} from '../src/agents/mandate.ts';
import { AGENTS, deployedAgents } from '../src/agents/registry.ts';
import { executableCommands, executeAct } from '../src/agents/acts.ts';
import { fleetManifest } from '../src/agents/runtime.ts';
import { AGENT_DIVISIONS, AUTONOMY_LADDER, exceeds } from '../src/agents/types.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The mandate ladder, and the one property the whole thing rests on.
 *
 * OBSERVE → DRAFT → PROPOSE → ACT. The first three rungs need no mechanism: an
 * observation is a finding, a draft is held, a proposal waits for somebody with
 * the capability. ACT is the rung that removes the human, and everything below
 * is written to make it hard to reach by accident.
 *
 * The property under test throughout: **an agent cannot grant itself ACT.**
 * Declaring a ceiling of `ACT` in the registry is eligibility. Authority comes
 * from an envelope a person granted, recorded as a governed event that an AI
 * actor cannot author. Those two facts have to stay separate, because if the
 * registry alone conferred autonomy then editing a source file would be how a
 * machine acquired unattended authority over a customer's project.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const as = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

/** A window that is live today, so a grant under test is actually in force. */
function window_(days = 30): { from: string; until: string } {
  const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const until = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  return { from, until };
}

describe('the ladder has four rungs and they are ordered', () => {
  it('orders them so "higher than" is a comparison rather than a convention', () => {
    assert.deepEqual(AUTONOMY_LADDER, ['OBSERVE', 'DRAFT', 'PROPOSE', 'ACT']);
    assert.equal(exceeds('ACT', 'PROPOSE'), true);
    assert.equal(exceeds('PROPOSE', 'DRAFT'), true);
    assert.equal(exceeds('DRAFT', 'OBSERVE'), true);
    assert.equal(exceeds('OBSERVE', 'ACT'), false);
    assert.equal(exceeds('PROPOSE', 'PROPOSE'), false);
  });
});

describe('the fleet declares itself honestly', () => {
  it('runs only the agents that have something to run', () => {
    for (const agent of AGENTS) {
      if (agent.deployment === 'DECLARED') {
        assert.equal(typeof agent.evaluate, 'undefined', `${agent.name} is declared but carries an evaluate`);
      } else {
        assert.equal(typeof agent.evaluate, 'function', `${agent.name} is deployed with nothing to run`);
      }
    }
    assert.equal(
      deployedAgents().every((agent) => typeof agent.evaluate === 'function'),
      true,
    );
  });

  it('makes every declared agent say what it is waiting on', () => {
    for (const agent of AGENTS.filter((candidate) => candidate.deployment === 'DECLARED')) {
      // An agent listed in a manifest with no reason for being absent is how a
      // roadmap becomes a claim about capability.
      assert.ok(
        (agent.needs ?? '').length > 40,
        `${agent.name} is declared without saying what it needs`,
      );
    }
  });

  it('publishes the whole roster, running or not, with its blast radius', () => {
    const manifest = fleetManifest();
    assert.equal(manifest.length, AGENTS.length);
    const declared = manifest.filter((entry) => entry.deployment === 'DECLARED');
    assert.ok(declared.length > 0, 'nothing is declared, so the honesty of the manifest is untested');
    for (const entry of manifest) {
      // "What could this thing have done" must have a short fixed answer for
      // every agent in the list, including the ones not running.
      assert.ok(Array.isArray(entry.reads));
      assert.ok(entry.maxUnattended);
      assert.ok(entry.division);
    }
  });

  it('puts at least one agent in every division it declares', () => {
    for (const { division } of AGENT_DIVISIONS) {
      assert.ok(
        AGENTS.some((agent) => agent.division === division),
        `${division} is a division with nobody in it`,
      );
    }
  });

  it('gives every ACT-eligible agent a declared envelope, and nobody else one', () => {
    for (const agent of AGENTS) {
      if (agent.mandate.maxUnattended === 'ACT') {
        const envelope = agent.mandate.envelope;
        assert.ok(envelope, `${agent.name} is ACT-eligible with no declared envelope`);
        assert.ok(envelope!.commands.length > 0, `${agent.name} declares an envelope covering nothing`);
        assert.ok(envelope!.because.length > 40, `${agent.name} does not say why it should act unattended`);
        for (const command of envelope!.commands) {
          assert.ok(AUTOMATABLE_COMMANDS[command], `${agent.name} may be granted "${command}", which is not automatable`);
        }
      } else {
        assert.equal(agent.mandate.envelope, undefined, `${agent.name} declares an envelope it can never use`);
      }
    }
  });
});

describe('no agent can grant itself the authority to act', () => {
  it('is eligible and still holds nothing until a person grants it', () => {
    // The single most important assertion in this file. `health` declares a
    // ceiling of ACT in the registry, and that declaration confers nothing.
    const ctx = as('admin');
    assert.equal(liveEnvelope(ctx, 'health'), undefined);

    const verdict = mayActUnattended(ctx, 'health', { command: 'ops:alert' });
    assert.equal(verdict.permitted, false);
    assert.match(
      verdict.permitted === false ? verdict.because : '',
      /eligible to act but holds no live grant/,
    );
  });

  it('records the grant as a decision no AI actor may author', () => {
    // The other half. Even if something contrived a call to grantEnvelope, the
    // event it writes is a governance decision, and the ledger refuses an AI
    // author on one — so there is no path from an agent to its own envelope.
    const granted = lookupEventType('AGENT_ENVELOPE_GRANTED');
    const revoked = lookupEventType('AGENT_ENVELOPE_REVOKED');
    assert.equal(granted?.aiAllowed, false);
    assert.equal(revoked?.aiAllowed, false);
  });

  it('refuses a grant from somebody without governance over the enterprise', () => {
    // Every role holds AI_EXECUTION X. If granting keyed on that, every user
    // could hand a machine unattended authority.
    throwsCode(
      () => grantEnvelope(as('pm'), { agent: 'health', commands: ['ops:alert'], ...window_(), note: 'Wants the alerts' }),
      'ACCESS_DENIED',
    );
    throwsCode(
      () => grantEnvelope(as('qs'), { agent: 'health', commands: ['ops:alert'], ...window_(), note: 'Wants the alerts' }),
      'ACCESS_DENIED',
    );
  });

  it('refuses to grant an agent that was never written to act', () => {
    throwsCode(
      () =>
        grantEnvelope(as('admin'), {
          agent: 'commercial',
          commands: ['ops:alert'],
          ...window_(),
          note: 'Would like the CVR run automatically',
        }),
      'AGENT_NOT_ACT_ELIGIBLE',
    );
  });
});

describe('a grant may narrow the declaration and never widen it', () => {
  it('refuses a command outside what the agent declares', () => {
    throwsCode(
      () =>
        grantEnvelope(as('admin'), {
          agent: 'health',
          commands: ['cost:certifyPayment'],
          ...window_(),
          note: 'Certification is slow',
        }),
      'AGENT_ENVELOPE_EXCEEDS_DECLARATION',
    );
  });

  it('refuses a ceiling above the declared one', () => {
    throwsCode(
      () =>
        grantEnvelope(as('admin'), {
          agent: 'health',
          commands: ['ops:alert'],
          valueCeilingMinor: 500_000,
          ...window_(),
          note: 'Give it some headroom',
        }),
      'AGENT_ENVELOPE_EXCEEDS_DECLARATION',
    );
  });

  it('refuses an open-ended grant', () => {
    const from = new Date().toISOString().slice(0, 10);
    const until = new Date(Date.now() + (MAX_ENVELOPE_DAYS + 30) * 86_400_000).toISOString().slice(0, 10);
    throwsCode(
      () => grantEnvelope(as('admin'), { agent: 'health', commands: ['ops:alert'], from, until, note: 'Indefinitely please' }),
      'AGENT_ENVELOPE_TOO_LONG',
    );
  });

  it('refuses a grant that covers nothing', () => {
    throwsCode(
      () => grantEnvelope(as('admin'), { agent: 'health', commands: [], ...window_(), note: 'Just in case' }),
      'AGENT_ENVELOPE_EMPTY',
    );
  });

  it('makes the granter say why', () => {
    throwsCode(
      () => grantEnvelope(as('admin'), { agent: 'health', commands: ['ops:alert'], ...window_(), note: 'ok' }),
      'AGENT_ENVELOPE_REASON_REQUIRED',
    );
  });
});

describe('the event catalogue is the real boundary', () => {
  it('refuses to automate anything a person is required to decide', () => {
    // Not a list this module maintains: the answer comes from the catalogue,
    // which is also what fails the commit. One source of truth for "a person
    // decides this".
    for (const code of [
      'APPLICATION_CERTIFIED',
      'VARIATION_INSTRUCTED',
      'STAGE_GATE_DECIDED',
      'NCR_CLOSED',
      'HANDOVER_ACCEPTED',
      'USER_ROLE_ASSIGNED',
    ]) {
      const definition = lookupEventType(code);
      if (!definition) continue;
      assert.equal(definition.aiAllowed, false, `${code} is open to an AI actor`);
    }
  });

  it('refuses a command it has never been told about', () => {
    // "Not listed" is not "harmless". An unknown command cannot be shown to be
    // safe, so it is refused rather than allowed by omission.
    const verdict = mayActUnattended(as('admin'), 'health', { command: 'something:invented' });
    assert.equal(verdict.permitted, false);
  });

  it('declares what every automatable command writes, including nothing', () => {
    for (const [command, entry] of Object.entries(AUTOMATABLE_COMMANDS)) {
      assert.ok(entry.note.length > 20, `${command} does not say what it does`);
      for (const type of entry.writes) {
        assert.equal(lookupEventType(type)?.aiAllowed, true, `${command} writes ${type}, which a machine may not author`);
      }
    }
  });
});

describe('a granted envelope, and taking it back', () => {
  it('permits exactly what it names, once a person has granted it', () => {
    const ctx = as('admin');
    const envelope = grantEnvelope(ctx, {
      agent: 'health',
      commands: ['ops:alert'],
      ...window_(),
      note: 'Nobody is on call overnight and an alert that waits for approval is not an alert.',
    });

    assert.equal(envelope.valueCeilingMinor, 0);
    assert.ok(envelope.until > envelope.from);

    const permitted = mayActUnattended(ctx, 'health', { command: 'ops:alert' });
    assert.equal(permitted.permitted, true);

    // Granted one command, not two. The declaration covers both; the grant
    // narrowed it, and narrowing has to actually bind.
    const other = mayActUnattended(ctx, 'health', { command: 'ops:resolve' });
    assert.equal(other.permitted, false);
    assert.match(other.permitted === false ? other.because : '', /does not cover/);

    revokeEnvelope(ctx, { envelopeId: envelope.id, reason: 'Test case complete' });
  });

  it('refuses a second overlapping grant for the same agent', () => {
    const ctx = as('admin');
    const first = grantEnvelope(ctx, {
      agent: 'health',
      commands: ['ops:alert'],
      ...window_(),
      note: 'The first grant, which the second one must not silently join.',
    });
    // Two live grants for one agent is ambiguous authority: the union widens
    // what somebody granted, the newest narrows it, and the first makes the
    // second do nothing. Refused, naming the grant in the way.
    throwsCode(
      () =>
        grantEnvelope(ctx, {
          agent: 'health',
          commands: ['ops:resolve'],
          ...window_(),
          note: 'A second grant overlapping the first.',
        }),
      'AGENT_ENVELOPE_OVERLAPS',
    );
    revokeEnvelope(ctx, { envelopeId: first.id, reason: 'Test case complete' });
  });

  it('stops permitting once withdrawn', () => {
    const ctx = as('admin');
    const envelope = grantEnvelope(ctx, {
      agent: 'health',
      commands: ['ops:alert', 'ops:resolve'],
      ...window_(),
      note: 'Overnight alerting while the on-call rota is being set up.',
    });
    assert.equal(mayActUnattended(ctx, 'health', { command: 'ops:resolve' }).permitted, true);

    revokeEnvelope(ctx, { envelopeId: envelope.id, reason: 'On-call rota now staffed' });

    // Takes effect on the next evaluation, which is this one.
    assert.equal(mayActUnattended(ctx, 'health', { command: 'ops:resolve' }).permitted, false);
    assert.equal(liveEnvelope(ctx, 'health'), undefined);
    assert.equal(mayActUnattended(ctx, 'health', { command: 'ops:alert' }).permitted, false);
  });

  it('refuses to withdraw the same grant twice', () => {
    const ctx = as('admin');
    const envelope = grantEnvelope(ctx, {
      agent: 'health',
      commands: ['ops:alert'],
      ...window_(),
      note: 'A grant made in order to be withdrawn twice.',
    });
    revokeEnvelope(ctx, { envelopeId: envelope.id, reason: 'No longer needed' });

    throwsCode(
      () => revokeEnvelope(ctx, { envelopeId: envelope.id, reason: 'No longer needed' }),
      'AGENT_ENVELOPE_ALREADY_REVOKED',
    );
  });

  it('does not treat a grant outside its window as live', () => {
    const ctx = as('admin');
    const from = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const until = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    grantEnvelope(ctx, {
      agent: 'health',
      commands: ['ops:alert'],
      from,
      until,
      note: 'Cover for the maintenance window later this month.',
    });
    // Granted, recorded, and not yet in force.
    assert.equal(mayActUnattended(ctx, 'health', { command: 'ops:alert', today: new Date().toISOString().slice(0, 10) }).permitted, false);
    assert.equal(mayActUnattended(ctx, 'health', { command: 'ops:alert', today: from }).permitted, true);
  });

  it('keeps every grant on the record, withdrawn or not', () => {
    const register = envelopeRegister(as('admin'));
    assert.ok(register.length >= 3);
    assert.ok(register.some((entry) => entry.revokedAt), 'no withdrawal is visible in the register');
    for (const entry of register) {
      // Who, what, until when, and why. A grant nobody can account for later is
      // the one that matters most.
      assert.ok(entry.grantedBy);
      assert.ok(entry.note.length >= 8);
      assert.ok(entry.until);
    }
  });
});

describe('an ungranted act is queued, not lost', () => {
  it('says plainly why it is asking rather than acting', () => {
    // The degrade path. Refusing outright would trade a small safety gain for
    // the loss of the finding, so an act with no envelope becomes a proposal
    // carrying the reason it was not taken.
    const verdict = mayActUnattended(as('owner'), 'defect-triage', { command: 'ops:alert' });
    assert.equal(verdict.permitted, false);
    assert.match(verdict.permitted === false ? verdict.because : '', /ceiling of OBSERVE/);
  });
});

// ── The rung that runs ───────────────────────────────────────────────────────

/**
 * ACT was a declaration with nothing under it.
 *
 * Every part of the authority story was built: an agent could be declared
 * eligible, a person could grant an envelope, the runtime checked the grant and
 * degraded to a proposal without one. And when there *was* one it raised a
 * proposal anyway, because nothing anywhere executed a command. An envelope
 * granted permission to do something the platform had no way to do.
 *
 * The first act with governed state behind it is the ITT return register, and
 * the decision about where the line falls is the point of these tests. Reading
 * an invitation is two jobs: transcribing forty return items with their dates
 * and formats, and judging whether the job is worth chasing on those terms. The
 * first is automated; the second is `ITT_ANALYSED`, which the catalogue marks
 * as a decision a person takes, so no envelope can reach it and the ledger
 * refuses an AI author on it. The safety does not rest on this agent behaving.
 */
describe('an agent that acts, and the half it can never reach', () => {
  const REGISTER = 'tenderintake:extractRequirements';

  it('declares the register automatable and the analysis not', () => {
    // Both directions, because the pair is the whole argument. The register is
    // an UPDATE the catalogue opens to machines; the analysis is a CREATE it
    // does not, and `assertCommandMayBeAutomated` refuses it at grant time
    // rather than leaving the ledger to refuse it at two in the morning.
    assertCommandMayBeAutomated(REGISTER);
    assert.equal(lookupEventType('TENDER_REQUIREMENTS_EXTRACTED')?.aiAllowed, true);
    assert.equal(lookupEventType('ITT_ANALYSED')?.aiAllowed, false);
  });

  it('cannot be granted the analysis, however the envelope is written', () => {
    // The agent's declared envelope names one command. A grant naming the
    // analyst is refused for being outside the declaration; and were it ever
    // added to the declaration, `assertCommandMayBeAutomated` refuses it for
    // what it writes. Two independent refusals, checked separately.
    throwsCode(
      () =>
        grantEnvelope(as('admin'), {
          agent: 'itt-register',
          commands: ['itt:analyseITT'],
          ...window_(),
          note: 'Trying to widen the envelope to the judgement half',
        }),
      'AGENT_ENVELOPE_EXCEEDS_DECLARATION',
    );
  });

  it('files nothing without a granted envelope, and says why', () => {
    const verdict = mayActUnattended(as('qs'), 'itt-register', { command: REGISTER });
    assert.equal(verdict.permitted, false);
    assert.ok(
      (verdict.permitted === false ? verdict.because : '').length > 0,
      'an ungranted act has to say why it is asking rather than acting',
    );
  });

  it('permits the act once a person has granted the envelope', () => {
    const envelope = grantEnvelope(as('admin'), {
      agent: 'itt-register',
      commands: [REGISTER],
      ...window_(),
      note: 'The bid team accepts the register being filed from a high-confidence reading',
    });
    assert.deepEqual(envelope.commands, [REGISTER]);
    assert.equal(envelope.valueCeilingMinor, 0);

    const verdict = mayActUnattended(as('qs'), 'itt-register', { command: REGISTER });
    assert.equal(verdict.permitted, true, 'a granted envelope did not permit the act it names');

    // And it still refuses the command it does not name, live envelope or not.
    const other = mayActUnattended(as('qs'), 'itt-register', { command: 'ops:alert' });
    assert.equal(other.permitted, false);
  });

  it('knows how to run exactly what it is allowed to run', () => {
    // The pair that has to stay in step. A command that can be *granted* and
    // not *run* is an envelope that promises something the platform cannot do;
    // a command that can be run and was never declared automatable is the
    // dangerous half, because nothing checked what it writes.
    for (const command of executableCommands()) {
      assert.ok(
        AUTOMATABLE_COMMANDS[command],
        `${command} has an executor and is not declared automatable — nothing has checked what it writes`,
      );
      assertCommandMayBeAutomated(command);
    }
  });

  it('refuses to run a command it has no executor for', () => {
    // `ops:alert` is declared automatable and is executed elsewhere, so this is
    // a real state rather than a contrived one: the answer is a refusal the
    // caller turns back into a proposal, not a silent success.
    throwsCode(() => executeAct(as('qs'), 'ops:alert', {}), 'AGENT_ACT_NOT_EXECUTABLE');
  });

  it('refuses to run a command nobody declared automatable', () => {
    throwsCode(() => executeAct(as('qs'), 'itt:analyseITT', {}), 'AGENT_COMMAND_NOT_AUTOMATABLE');
  });
});

/**
 * The act, end to end, on a real invitation.
 *
 * Everything above tests the authority. This tests that the authority is
 * connected to something: an ITT reading lands, the agent wakes on it, and with
 * an envelope in force the return register is filled in without anybody
 * pressing anything — while the compliance matrix, which is the judgement half,
 * is exactly as absent as it was before.
 */
describe('the return register fills itself, and the matrix does not', () => {
  const REGISTER = 'tenderintake:extractRequirements';

  /** A platform with a tender project, an invitation, and a reading of it. */
  async function estate(): Promise<{
    platform: Platform;
    seed: SeedResult;
    projectId: string;
    invitationId: string;
    qs: () => EngineContext;
    admin: () => EngineContext;
  }> {
    const platform = new Platform();
    const seed = await seedDemoProject(platform);
    const project = platform.ledger
      .listByTenant(seed.tenantId, 'Project')
      .map((r) => r.state)
      .find((p) => p.phase === 'TENDER') as { id: string } | undefined;
    assert.ok(project, 'the demonstration has no project at tender');

    const invitation = platform.ledger
      .listByTenant(seed.tenantId, 'TenderInvitation')
      .map((r) => r.state)[0] as { id: string; reference: string } | undefined;
    assert.ok(invitation, 'the demonstration has no invitation');

    return {
      platform,
      seed,
      projectId: project.id,
      invitationId: invitation.id,
      qs: () => platform.context(seed.users.qs!.auth, project.id, { source: 'WEB' }),
      admin: () => platform.context(seed.users.admin!.auth, project.id, { source: 'WEB' }),
    };
  }

  // Driven through the executor rather than a full fleet run. The reading that
  // wakes the agent needs a multimodal provider this environment does not have,
  // and a test that stubbed one would be testing the stub. What matters here is
  // the act itself: that a granted command reaches the domain, writes its
  // event, is attributed to the agent, and stops where the catalogue stops it.
  it('runs the command, attributes it to the agent, and leaves the analysis alone', async () => {
    const { platform, seed, projectId, invitationId, qs, admin } = await estate();

    grantEnvelope(admin(), {
      agent: 'itt-register',
      commands: [REGISTER],
      ...window_(),
      note: 'The bid team accepts the register being filed from a high-confidence reading',
    });

    const analysesBefore = platform.ledger.listByTenant(seed.tenantId, 'ITTAnalysis').length;

    // The act, as the runtime takes it: the agent's identity on the context.
    const acting: EngineContext = {
      ...qs(),
      actingAs: { refType: 'AI', refId: 'AGT-ITT-REGISTER' },
    };
    const effect = executeAct(acting, REGISTER, {
      invitationId,
      deliverables: [
        { reference: 'AR-01', title: 'Technical submission', mandatory: true, format: 'PDF', internalDueBy: '2026-12-18' },
        { reference: 'AR-02', title: 'Priced schedule', mandatory: true, format: 'XLSX', internalDueBy: '2027-01-04' },
      ],
    });
    assert.match(effect, /Filed 2 return item\(s\), 2 of them mandatory/);

    // The register is on the invitation.
    const invitation = platform.ledger.require({ refType: 'TenderInvitation', refId: invitationId }).state;
    assert.equal((invitation.deliverables as unknown[]).length, 2);
    assert.equal(invitation.requirementsExtracted, true);

    // The event says the agent did it, not the person whose session ran it.
    const filing = platform.ledger
      .eventsForEntity({ refType: 'TenderInvitation', refId: invitationId })
      .filter((event) => event.eventType === 'TENDER_REQUIREMENTS_EXTRACTED')
      .at(-1);
    assert.ok(filing);
    assert.equal(filing.actor.refType, 'AI');
    assert.equal(filing.actor.refId, 'AGT-ITT-REGISTER');

    // And the judgement half is untouched: no analysis was produced, and the
    // one the demonstration already carries is still the only one.
    assert.equal(
      platform.ledger.listByTenant(seed.tenantId, 'ITTAnalysis').length,
      analysesBefore,
      'filing the register produced a compliance matrix, which is a decision a person takes',
    );
  });

  it('refuses the analysis outright when an agent tries to author one', async () => {
    const { platform, seed, projectId } = await estate();

    // The last line of defence, tested directly: even with the command list,
    // the executor and the envelope all bypassed, the ledger refuses an AI
    // author on the event the catalogue closed to machines.
    throwsCode(
      () =>
        platform.ledger.commit({
          tenantId: seed.tenantId,
          projectId,
          actor: { refType: 'AI', refId: 'AGT-ITT-REGISTER' },
          source: 'AI',
          eventType: 'ITT_ANALYSED',
          entity: { refType: 'ITTAnalysis', refId: 'forged-analysis' },
          nextState: { id: 'forged-analysis' },
          correlationId: 'test-correlation',
        }),
      'AI_NOT_PERMITTED',
    );
  });
});
