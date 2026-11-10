import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { decideGate, gridWorkboard, openGridEngagement, recordTrigger, runStep, stepExecutionBrief, updateStep } from '../src/domain/grid/store.ts';
import { stepsOfGate } from '../src/domain/grid/playbook.ts';

/**
 * The persisted grid engagement runs the 42-step / 8-gate playbook on the Golden
 * Thread. These prove the spec's authority rule is enforced, not just described:
 * a gate is decided only at digital readiness, and an electrical gate (G4–G7)
 * cannot be approved without a verified authority record.
 */

let platform: Platform;
let seed: SeedResult;
// QAQC holds QUALITY_COMMISSIONING create/update/approve — the commissioning area the module authorises against.
const ctx = (): EngineContext => platform.context(seed.users.qaqc!.auth, seed.projectId, { correlationId: 'grid-test' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

function validateGate(engagementId: string, gate: Parameters<typeof stepsOfGate>[0]): void {
  for (const s of stepsOfGate(gate)) updateStep(ctx(), engagementId, s.id, { runState: 'VALIDATED', validated: true });
}

describe('opening a grid engagement', () => {
  it('opens GRID-0001 with 42 PLANNED steps and every gate PENDING', () => {
    const { engagementId, reference } = openGridEngagement(ctx(), { connection: 'Bay 1 HV intake', route: 'DISTRIBUTION', pointOfConnection: 'Primary 33kV' });
    assert.match(reference, /^GRID-\d{4}$/);
    const board = gridWorkboard(ctx(), engagementId);
    assert.equal(board.steps.length, 42);
    assert.ok(board.steps.every((s) => s.runState === 'PLANNED'));
    assert.ok(board.gates.every((g) => g.state === 'PENDING'));
    assert.equal(board.coverage.percent, 0);
  });
});

describe('updating steps and gate readiness', () => {
  it('rejects an unknown step and an invalid run state', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DISTRIBUTION' });
    assert.throws(() => updateStep(ctx(), engagementId, '99', { validated: true }), (e) => (e as { code?: string }).code === 'UNKNOWN_STEP');
    assert.throws(() => updateStep(ctx(), engagementId, '01', { runState: 'DONE' as never }), (e) => (e as { code?: string }).code === 'BAD_RUN_STATE');
  });

  it('a non-electrical gate reaches CANDIDATE_READY, then APPROVED on its decision', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DISTRIBUTION' });
    validateGate(engagementId, 'G0');
    assert.equal(gridWorkboard(ctx(), engagementId).gates.find((g) => g.id === 'G0')!.state, 'CANDIDATE_READY');
    decideGate(ctx(), engagementId, 'G0', { decisionApproved: true });
    assert.equal(gridWorkboard(ctx(), engagementId).gates.find((g) => g.id === 'G0')!.state, 'APPROVED');
  });

  it('refuses a decision on a gate that is not at digital readiness', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DISTRIBUTION' });
    assert.throws(() => decideGate(ctx(), engagementId, 'G0', { decisionApproved: true }), (e) => (e as { code?: string }).code === 'GATE_BLOCKED');
  });
});

describe('the electrical authority rule (spec §6.5)', () => {
  it('an electrical gate reaches AWAITING_AUTHORITY and refuses a decision without a verified authority record', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DIRECT_TRANSMISSION' });
    validateGate(engagementId, 'G5');
    assert.equal(gridWorkboard(ctx(), engagementId).gates.find((g) => g.id === 'G5')!.state, 'AWAITING_AUTHORITY');
    // Digital readiness and a decision flag do NOT advance an electrical gate.
    assert.throws(() => decideGate(ctx(), engagementId, 'G5', { decisionApproved: true }), (e) => (e as { code?: string }).code === 'AUTHORITY_REQUIRED');
    // With a verified authority record it advances to APPROVED.
    decideGate(ctx(), engagementId, 'G5', { authorityRef: 'MRA energisation consent EON-2026-114' });
    assert.equal(gridWorkboard(ctx(), engagementId).gates.find((g) => g.id === 'G5')!.state, 'APPROVED');
  });

  it('a blocked step blocks its gate and surfaces as a next action', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DISTRIBUTION' });
    updateStep(ctx(), engagementId, '03', { runState: 'BLOCKED', blocker: 'Awaiting power-factor basis to convert MW↔MVA' });
    const board = gridWorkboard(ctx(), engagementId);
    assert.equal(board.gates.find((g) => g.id === 'G0')!.state, 'BLOCKED');
    assert.ok(board.nextActions.some((a) => /G0.*blocked on step\(s\).*03/.test(a)));
  });
});

describe('agent execution and reappraisal triggers', () => {
  it('grounds the step execution brief in the connection and the step, and never carries an OT action', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'Bay 1 HV intake', route: 'DISTRIBUTION', pointOfConnection: 'Primary 33kV' });
    const state = gridWorkboard(ctx(), engagementId).engagement;
    const brief = stepExecutionBrief(state, '03');
    assert.equal(brief.connection.connection, 'Bay 1 HV intake');
    assert.equal(brief.step.id, '03');
    assert.equal(brief.step.capability, 'CONNECTION_CODE');
    assert.ok(!('control' in brief.step) && !('switching' in brief.step));
    assert.throws(() => stepExecutionBrief(state, '99'), (e) => (e as { code?: string }).code === 'UNKNOWN_STEP');
  });

  it('a step run with no reasoning provider parks the step WAITING_EVIDENCE, uncharged, and never fakes a result', async () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DISTRIBUTION' });
    const state = await runStep(ctx(), engagementId, '01');
    const rec = state.steps['01']!;
    assert.equal(rec.runState, 'WAITING_EVIDENCE');
    assert.equal(rec.validated, false, 'a parked run never validates');
    assert.equal(rec.lastRun, undefined);
  });

  it('refuses to re-run a validated step', async () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DISTRIBUTION' });
    updateStep(ctx(), engagementId, '01', { runState: 'VALIDATED', validated: true });
    await assert.rejects(() => runStep(ctx(), engagementId, '01'), (e) => (e as { code?: string }).code === 'STEP_NOT_RUNNABLE');
  });

  it('a reappraisal trigger reopens impacted steps to STALE and supersedes impacted gates', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DIRECT_TRANSMISSION' });
    // Validate and approve G4 (an electrical gate) first.
    for (const s of stepsOfGate('G4')) updateStep(ctx(), engagementId, s.id, { runState: 'VALIDATED', validated: true });
    decideGate(ctx(), engagementId, 'G4', { authorityRef: 'Commissioning compliance notice FON-2026-9' });
    assert.equal(gridWorkboard(ctx(), engagementId).gates.find((g) => g.id === 'G4')!.state, 'APPROVED');

    // A late protection revision reopens the SAT step and supersedes G4.
    recordTrigger(ctx(), engagementId, { event: 'CT/VT ratio revision after FAT', affectedSteps: ['26'], affectedGates: ['G4'] });
    const board = gridWorkboard(ctx(), engagementId);
    assert.equal(board.steps.find((s) => s.id === '26')!.runState, 'STALE');
    assert.equal(board.steps.find((s) => s.id === '26')!.validated, false);
    assert.equal(board.gates.find((g) => g.id === 'G4')!.state, 'SUPERSEDED');
  });

  it('rejects a trigger naming an unknown step or gate', () => {
    const { engagementId } = openGridEngagement(ctx(), { connection: 'c', route: 'DISTRIBUTION' });
    assert.throws(() => recordTrigger(ctx(), engagementId, { event: 'x', affectedSteps: ['99'] }), (e) => (e as { code?: string }).code === 'UNKNOWN_STEP');
    assert.throws(() => recordTrigger(ctx(), engagementId, { event: 'x', affectedGates: ['G9' as never] }), (e) => (e as { code?: string }).code === 'UNKNOWN_GATE');
  });
});
