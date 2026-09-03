import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { issueTokens, verifyToken } from '../src/identity/auth.ts';
import { write } from '../src/engines/context.ts';
import { replayTimeline } from '../src/goldenthread/replay.ts';
import type { EngineContext } from '../src/engines/context.ts';

/**
 * The immutable audit event — Rule 5.
 *
 * The record already carried who acted, on what, when, in which tenancy, and
 * both hashes. Four things it did not carry, and each of them is a question an
 * auditor asks first:
 *
 * **Under what authority?** Roles change. Somebody promoted, moved team or
 * removed from a project still acted under the mandate they held at the time, so
 * an audit that resolves their *current* roles reports the wrong authority for
 * every historic act. Under an append-only record, a snapshot taken at the
 * moment of the act is the only version that can never become wrong.
 *
 * **Where in the lifecycle?** The phase governs what may be written and which
 * engines may run, so an approval or a refusal only means anything read against
 * the phase it happened in. Without it on the event, understanding one line of
 * audit means replaying the whole project up to that instant.
 *
 * **Why?** Several commands already demanded a reason and buried it in entity
 * state, reachable only by knowing which field of which record to look in. A
 * record of a consequential act with no stated reason is useless the day
 * somebody asks why it happened.
 *
 * **How sure was the model?** The confidence already reached the engine and was
 * used to decide what to write. It was then discarded, at exactly the moment it
 * became evidence.
 *
 * All four are filled at the single write path rather than by each command,
 * because "every command remembers" is not a property a codebase can hold. The
 * tests below are therefore about the choke point, not about any one command.
 */

function contextFor(platform: Platform, tenantId: string, projectId: string, actorId: string, roles: string[]): EngineContext {
  const token = issueTokens({ actorId, tenantId, roles: roles as never, mfaSatisfied: true }).accessToken;
  return {
    ledger: platform.ledger,
    orchestrator: platform.orchestrator,
    wallet: platform.wallet(tenantId),
    auth: verifyToken(token),
    source: 'WEB',
    correlationId: 'test-correlation',
    tenantId,
    projectId,
    standing: { mayWrite: true, mayRunAI: true, mayExport: true, mayTopUp: true },
  } as EngineContext;
}

function estate(): { platform: Platform; tenantId: string; actorId: string } {
  const platform = new Platform();
  const { tenant } = platform.createTenant({
    legalName: 'Meridian Infrastructure Ltd',
    enterpriseName: 'Meridian Group',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
  });
  const user = platform.createUser({
    tenantId: tenant.id,
    name: 'Rowan',
    email: `rowan-${Math.random().toString(36).slice(2)}@meridian.test`,
    roles: ['ENTERPRISE_ADMIN', 'QS'],
  });
  return { platform, tenantId: tenant.id, actorId: user.id };
}

describe('the roles held at the moment of the act', () => {
  it('is written onto every event', () => {
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-1', actorId, ['ENTERPRISE_ADMIN', 'QS']);

    const { event } = write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-1' },
      nextState: { id: 'p-1', name: 'Meridian Bridge', phase: 'CONCEPT' },
    });

    assert.deepEqual(event.roleAtAction, ['ENTERPRISE_ADMIN', 'QS']);
  });

  it('is a snapshot, so a later role change cannot rewrite history', () => {
    // The whole point. If the audit resolved the actor's roles at read time,
    // removing somebody from a role would retroactively change the authority
    // every one of their past acts appears to have been taken under.
    const { platform, tenantId, actorId } = estate();
    const before = contextFor(platform, tenantId, 'p-2', actorId, ['QS']);
    const { event } = write(before, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-2' },
      nextState: { id: 'p-2', name: 'Northgate', phase: 'CONCEPT' },
    });

    // The same person, now holding something else entirely.
    const after = contextFor(platform, tenantId, 'p-2', actorId, ['SUPERVISOR']);
    write(after, {
      eventType: 'PROJECT_PHASE_TRANSITIONED',
      entity: { refType: 'Project', refId: 'p-2' },
      nextState: { id: 'p-2', name: 'Northgate', phase: 'DESIGN' },
      // The catalogue refuses a phase transition with no evidence behind it,
      // which is the platform enforcing that a gate is passed on a record
      // rather than on somebody's word.
      evidenceRefs: [{ refType: 'GateReview', refId: 'g-1' }],
    });

    const first = platform.ledger.events({ projectId: 'p-2' })[0]!;
    assert.equal(first.eventId, event.eventId);
    assert.deepEqual(first.roleAtAction, ['QS'], 'the historic act was rewritten by a later role change');
  });

  it('cannot be forged by a caller, because no caller supplies it', () => {
    // Taken from the verified token on the context, not from anything the
    // request carries. A command cannot claim an authority it does not hold.
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-3', actorId, ['SUPERVISOR']);

    const { event } = write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-3' },
      nextState: { id: 'p-3', name: 'Southgate', phase: 'CONCEPT' },
      // A caller trying to inflate its own recorded authority.
      roleAtAction: ['PLATFORM_ADMIN'],
    } as never);

    assert.deepEqual(event.roleAtAction, ['SUPERVISOR'], 'a caller overwrote the recorded authority');
  });
});

describe('the lifecycle phase at the moment of the act', () => {
  it('is written onto events against a project that has one', () => {
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-4', actorId, ['ENTERPRISE_ADMIN']);

    write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-4' },
      nextState: { id: 'p-4', name: 'Eastgate', phase: 'CONSTRUCTION' },
    });

    // The next write reads the phase the project is now in.
    const { event } = write(ctx, {
      eventType: 'RISK_REGISTERED',
      entity: { refType: 'RiskRegisterItem', refId: 'r-1' },
      nextState: { id: 'r-1', title: 'Piling rig availability', owner: 'Rowan' },
    });

    assert.equal(event.lifecyclePhase, 'CONSTRUCTION');
  });

  it('is absent rather than guessed where the project has no phase yet', () => {
    // Absent means "not applicable", and that is a different statement from any
    // particular phase. Guessing one would be a claim.
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-5', actorId, ['ENTERPRISE_ADMIN']);

    const { event } = write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-5' },
      nextState: { id: 'p-5', name: 'Westgate', phase: 'CONCEPT' },
    });

    // The creating event itself: the project did not exist when it was written.
    assert.equal(event.lifecyclePhase, undefined);
  });

  it('is absent on a write against a different project than the context', () => {
    // Reporting the wrong project's phase is worse than reporting none.
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-6', actorId, ['ENTERPRISE_ADMIN']);
    write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-6' },
      nextState: { id: 'p-6', name: 'Cross', phase: 'TENDER' },
    });

    const { event } = write(ctx, {
      projectId: `${tenantId}-governance`,
      eventType: 'RISK_REGISTERED',
      entity: { refType: 'RiskRegisterItem', refId: 'r-gov-1' },
      nextState: { id: 'r-gov-1', title: 'Corporate insurance renewal', owner: 'Rowan' },
    });

    assert.equal(event.lifecyclePhase, undefined, "another project's phase was recorded");
  });
});

describe('the stated reason', () => {
  it('is carried on the event, beside the change it explains', () => {
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-7', actorId, ['QS']);

    const { event } = write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-7' },
      nextState: { id: 'p-7', name: 'Harbour', phase: 'CONCEPT' },
      reason: 'Client instruction of 12 August, minuted at the board',
    });

    assert.equal(event.reason, 'Client instruction of 12 August, minuted at the board');
  });

  it('is absent rather than empty when none was given', () => {
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-8', actorId, ['QS']);

    const { event } = write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-8' },
      nextState: { id: 'p-8', name: 'Quay', phase: 'CONCEPT' },
    });

    assert.equal(event.reason, undefined, 'an empty reason was recorded as though one had been given');
  });
});

describe('what the fields do not break', () => {
  it('leaves the hash chain intact', () => {
    // The fields are part of the event body, so they are inside the hash. A
    // change to the event shape that broke the chain would make every existing
    // record unverifiable.
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-9', actorId, ['ENTERPRISE_ADMIN']);

    write(ctx, {
      eventType: 'PROJECT_CREATED',
      entity: { refType: 'Project', refId: 'p-9' },
      nextState: { id: 'p-9', name: 'Dockside', phase: 'CONCEPT' },
    });
    const { event } = write(ctx, {
      eventType: 'PROJECT_PHASE_TRANSITIONED',
      entity: { refType: 'Project', refId: 'p-9' },
      nextState: { id: 'p-9', name: 'Dockside', phase: 'DESIGN' },
      evidenceRefs: [{ refType: 'GateReview', refId: 'g-9' }],
    });

    assert.ok(event.chainHash, 'the second event has no chain hash');
    assert.ok(event.previousChainHash, 'the chain does not link back');
    assert.notEqual(event.chainHash, event.previousChainHash);
  });

  it('does not require the fields, so a restored journal still replays', () => {
    // Forward-compatible, not backward-compatible. Events written before these
    // fields existed carry none, and must still load.
    const { platform, tenantId } = estate();
    const events = platform.ledger.events({ tenantId });

    assert.ok(events.length > 0);
    // The tenancy's own creation events predate any engine context and legitimately
    // carry no role snapshot. They must still be valid events.
    assert.ok(
      events.some((event) => event.roleAtAction === undefined),
      'the fixture proves nothing — every event happened to carry a role snapshot',
    );
  });
});

/**
 * The audit narrative names the engine, never the vendor behind it.
 *
 * The Golden Thread screen read `AI · GEMINI` on every AI-authored row and
 * `AI engine (GEMINI) — takeoff completed on …` in the timeline beside it. The
 * ledger is right to hold `ai.provider`: it is what the ACU charge reconciles
 * against and what a regulator would ask about. Publishing it to whoever can
 * read a project's audit trail is a different act, and it is a sub-processor
 * disclosure made by accident.
 *
 * It matters more than the screen. `replayTimeline` also feeds the project
 * export and the delay-claim evidence pack, so the vendor name was travelling
 * into documents issued to a client and, in a claim, to a tribunal. It also
 * moves: routing and failover choose the provider per call, so two identical
 * acts could narrate differently for a reason that has nothing to do with the
 * project.
 */
describe('the audit narrative does not name the AI vendor', () => {
  it('says who acted without saying whose model answered', () => {
    const { platform, tenantId, actorId } = estate();
    const ctx = contextFor(platform, tenantId, 'p-ai', actorId, ['ENTERPRISE_ADMIN', 'QS']);

    write(ctx, {
      // An event the catalogue actually permits an AI to author. It refuses
      // PROJECT_CREATED outright, which is the governance rule working: the
      // acts that constitute a project are human by construction.
      eventType: 'TAKEOFF_COMPLETED',
      entity: { refType: 'Takeoff', refId: 'tk-ai' },
      nextState: { id: 'tk-ai', packageId: 'pkg-1', quantity: 12 },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: 'ev-1' }],
      actor: { refType: 'AI', refId: 'AI:TENDER:quantity_extraction' },
      ai: { provider: 'GEMINI', model: 'gemini-2.5-pro', acuCost: 4, confidence: 0.9 },
    } as never);

    const [entry] = replayTimeline(platform.ledger, tenantId, 'p-ai', '2000-01-01', '2100-01-01');
    assert.ok(entry, 'no timeline entry was produced');
    assert.match(entry.narrative, /AI engine/, 'the narrative stopped saying an engine acted at all');

    // The whole point: every provider this platform can route to, by name.
    for (const vendor of ['GEMINI', 'OPENAI', 'ANTHROPIC', 'gemini-2.5-pro']) {
      assert.doesNotMatch(entry.narrative, new RegExp(vendor, 'i'), `the narrative names ${vendor}`);
    }

    // And the ledger still holds it. Removing the field would break the ACU
    // reconciliation and lose a fact the record is required to keep — the fix
    // is to stop publishing it, not to stop recording it.
    const event = platform.ledger.events({ projectId: 'p-ai' })[0]!;
    assert.equal(event.ai?.provider, 'GEMINI', 'the provider was deleted from the ledger rather than withheld');
  });
});
