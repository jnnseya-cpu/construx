import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { decideGate, gridWorkboard, openGridEngagement, updateStep } from '../src/domain/grid/store.ts';
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
