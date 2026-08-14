import assert from 'node:assert/strict';
import { describe, it, before } from 'node:test';
import { throwsCode } from './helpers.ts';
import { GoldenThreadLedger } from '../src/goldenthread/ledger.ts';
import { replayProject } from '../src/goldenthread/replay.ts';
import { EVENT_TYPES, lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

const TENANT = 'tenant-test';
const PROJECT = 'project-test';

function newLedger(): GoldenThreadLedger {
  return new GoldenThreadLedger();
}

const baseCommit = {
  tenantId: TENANT,
  projectId: PROJECT,
  actor: { refType: 'User' as const, refId: 'user-1' },
  source: 'WEB' as const,
  correlationId: 'corr-1',
};

describe('event catalogue', () => {
  it('has no duplicate codes', () => {
    const codes = EVENT_TYPES.map((t) => t.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  it('never marks an AI_EXECUTE event as forbidden to AI', () => {
    for (const definition of EVENT_TYPES) {
      if (definition.action === 'AI_EXECUTE') assert.ok(definition.aiAllowed, `${definition.code} is contradictory`);
    }
  });
});

describe('ledger invariants', () => {
  it('rejects an event type that is not in the catalogue', () => {
    const ledger = newLedger();
    throwsCode(
      () => ledger.commit({ ...baseCommit, eventType: 'MADE_UP_EVENT', entity: { refType: 'Task', refId: 't1' }, nextState: {} }),
      'EVENT_TYPE_UNKNOWN',
    );
  });

  it('rejects an event applied to the wrong entity type', () => {
    const ledger = newLedger();
    throwsCode(
      () => ledger.commit({ ...baseCommit, eventType: 'TASK_CREATED', entity: { refType: 'Contract', refId: 'c1' }, nextState: {} }),
      'EVENT_ENTITY_MISMATCH',
    );
  });

  it('refuses an evidence-requiring event with no evidence', () => {
    const ledger = newLedger();
    throwsCode(
      () =>
        ledger.commit({
          ...baseCommit,
          eventType: 'PROGRESS_RECORDED',
          entity: { refType: 'ProgressMeasurement', refId: 'p1' },
          nextState: { id: 'p1' },
        }),
      'EVIDENCE_REQUIRED',
    );
  });

  it('refuses to let an AI actor emit an event the catalogue reserves for humans', () => {
    const ledger = newLedger();
    throwsCode(
      () =>
        ledger.commit({
          ...baseCommit,
          actor: { refType: 'AI', refId: 'engine' },
          source: 'AI',
          eventType: 'TASK_CREATED',
          entity: { refType: 'Task', refId: 't1' },
          nextState: { id: 't1' },
        }),
      'AI_NOT_PERMITTED',
    );
  });

  it('refuses to update an entity that does not exist', () => {
    const ledger = newLedger();
    throwsCode(
      () => ledger.commit({ ...baseCommit, eventType: 'TASK_UPDATED', entity: { refType: 'Task', refId: 'ghost' }, nextState: { id: 'ghost' } }),
      'ENTITY_NOT_FOUND',
    );
  });

  it('refuses to create the same entity twice', () => {
    const ledger = newLedger();
    const entity = { refType: 'Task', refId: 't1' };
    ledger.commit({ ...baseCommit, eventType: 'TASK_CREATED', entity, nextState: { id: 't1', name: 'A' } });
    throwsCode(
      () => ledger.commit({ ...baseCommit, eventType: 'TASK_CREATED', entity, nextState: { id: 't1', name: 'B' } }),
      'ENTITY_EXISTS',
    );
  });

  it('rejects a write from a different tenant against an existing entity', () => {
    const ledger = newLedger();
    const entity = { refType: 'Task', refId: 't1' };
    ledger.commit({ ...baseCommit, eventType: 'TASK_CREATED', entity, nextState: { id: 't1', name: 'A' } });
    throwsCode(
      () =>
        ledger.commit({
          ...baseCommit,
          tenantId: 'other-tenant',
          eventType: 'TASK_UPDATED',
          entity,
          nextState: { id: 't1', name: 'B' },
        }),
      'TENANT_ISOLATION_BREACH',
    );
  });

  it('rejects a stale write when the caller passes an out-of-date state hash', () => {
    const ledger = newLedger();
    const entity = { refType: 'Task', refId: 't1' };
    const { record } = ledger.commit({ ...baseCommit, eventType: 'TASK_CREATED', entity, nextState: { id: 't1', name: 'A' } });
    ledger.commit({ ...baseCommit, eventType: 'TASK_UPDATED', entity, nextState: { id: 't1', name: 'B' } });
    throwsCode(
      () =>
        ledger.commit({
          ...baseCommit,
          eventType: 'TASK_UPDATED',
          entity,
          nextState: { id: 't1', name: 'C' },
          expectedStateHash: record.stateHash,
        }),
      'STALE_STATE',
    );
  });

  it('rejects a commit that changes nothing', () => {
    const ledger = newLedger();
    const entity = { refType: 'Task', refId: 't1' };
    ledger.commit({ ...baseCommit, eventType: 'TASK_CREATED', entity, nextState: { id: 't1', name: 'A' } });
    throwsCode(
      () => ledger.commit({ ...baseCommit, eventType: 'TASK_UPDATED', entity, nextState: { id: 't1', name: 'A' } }),
      'NO_OP_CHANGE',
    );
  });

  it('chains each event to its predecessor', () => {
    const ledger = newLedger();
    const entity = { refType: 'Task', refId: 't1' };
    ledger.commit({ ...baseCommit, eventType: 'TASK_CREATED', entity, nextState: { id: 't1', name: 'A' } });
    ledger.commit({ ...baseCommit, eventType: 'TASK_UPDATED', entity, nextState: { id: 't1', name: 'B' } });

    const events = ledger.events({ projectId: PROJECT });
    assert.equal(events[1]?.previousChainHash, events[0]?.chainHash);
    assert.equal(ledger.chainHead(PROJECT), events[1]?.chainHash);
  });
});

describe('replay against a full lifecycle', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('reconstructs the project and verifies every event', () => {
    const report = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString());
    assert.equal(report.verificationStatus, 'VERIFIED');
    assert.equal(report.failures.length, 0);
    assert.ok(report.eventsReplayed > 100, 'a full lifecycle should produce a substantial event log');
    assert.equal(report.summary.VERIFIED, report.eventsReplayed);
  });

  it('produces the same root hash on repeated replays', () => {
    const at = new Date().toISOString();
    const first = replayProject(platform.ledger, seed.tenantId, seed.projectId, at);
    const second = replayProject(platform.ledger, seed.tenantId, seed.projectId, at);
    assert.equal(first.rootHash, second.rootHash);
  });

  it('detects a hash altered directly in storage', () => {
    const event = platform.ledger.events({ projectId: seed.projectId }).find((e) => e.eventType === 'ESTIMATE_FROZEN');
    assert.ok(event, 'the seeded lifecycle should contain a frozen estimate');

    const original = event.afterHash;
    (event as { afterHash: string }).afterHash = `sha256:${'0'.repeat(64)}`;

    const report = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString());
    assert.equal(report.verificationStatus, 'FAILED');
    assert.ok(report.failures.some((f) => f.status === 'FAILED_HASH' || f.status === 'FAILED_CHAIN'));

    (event as { afterHash: string }).afterHash = original;
    assert.equal(replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString()).verificationStatus, 'VERIFIED');
  });

  it('withholds commercially sensitive entities from a regulator audience', () => {
    const at = new Date().toISOString();
    const internal = replayProject(platform.ledger, seed.tenantId, seed.projectId, at, { audience: 'INTERNAL' });
    const regulator = replayProject(platform.ledger, seed.tenantId, seed.projectId, at, { audience: 'REGULATOR' });

    assert.ok(regulator.entities.length < internal.entities.length);
    assert.ok(regulator.redactionLog.length > 0);
    assert.ok(!regulator.entities.some((e) => e.refType === 'Estimate'));
    // The attestation covers the full verified state, so both audiences agree.
    assert.equal(regulator.rootHash, internal.rootHash);
  });

  it('reports which baselines were in force', () => {
    const report = replayProject(platform.ledger, seed.tenantId, seed.projectId, new Date().toISOString());
    assert.ok(report.baselinesInForce.programmeBaselineId);
    assert.ok(report.baselinesInForce.budgetBaselineId);
    assert.ok(report.baselinesInForce.contractId);
  });

  it('excludes events after the requested point in time', () => {
    const events = platform.ledger.events({ projectId: seed.projectId });
    const midpoint = events[Math.floor(events.length / 2)]?.timestamp as string;
    const partial = replayProject(platform.ledger, seed.tenantId, seed.projectId, midpoint);
    assert.ok(partial.eventsReplayed < events.length);
    assert.equal(partial.verificationStatus, 'VERIFIED');
  });

  it('attributes AI-authored events to an AI actor with a funded execution', () => {
    const aiEvents = platform.ledger.events({ projectId: seed.projectId }).filter((e) => e.actor.refType === 'AI');
    assert.ok(aiEvents.length > 0);
    for (const event of aiEvents) {
      assert.ok(event.ai, `${event.eventType} was written by AI but carries no AI block`);
      assert.ok(lookupEventType(event.eventType)?.aiAllowed);
    }
  });
});
