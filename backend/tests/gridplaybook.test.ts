import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  coverage,
  gateState,
  GATE_IDS,
  GRID_CAPABILITIES,
  GRID_GATES,
  GRID_STEPS,
  stepsOfGate,
  type StepStatus,
} from '../src/domain/grid/playbook.ts';

/**
 * The grid playbook is the module's engineering truth, so its integrity is asserted
 * rather than trusted: 42 steps across G0–G7, every step owned by a known agent, and
 * a gate that advances only as the spec's rule allows — an electrical gate never on
 * digital readiness alone.
 */

describe('the grid playbook catalogue (spec §5)', () => {
  it('has exactly 42 steps with unique, ordered two-digit ids', () => {
    assert.equal(GRID_STEPS.length, 42);
    const ids = GRID_STEPS.map((s) => s.id);
    assert.deepEqual(ids, Array.from({ length: 42 }, (_, i) => String(i + 1).padStart(2, '0')));
    assert.equal(new Set(ids).size, 42);
  });

  it('assigns every step to a known gate and a known agent capability', () => {
    for (const s of GRID_STEPS) {
      assert.ok(GATE_IDS.includes(s.gate), `${s.id} has gate ${s.gate}`);
      assert.ok((GRID_CAPABILITIES as readonly string[]).includes(s.capability), `${s.id} has capability ${s.capability}`);
      assert.ok(s.executes.length > 0 && s.output.length > 0);
    }
  });

  it('covers the eight gates in the spec step ranges', () => {
    const ranges: Record<string, [number, number]> = { G0: [1, 6], G1: [7, 12], G2: [13, 18], G3: [19, 22], G4: [23, 28], G5: [29, 31], G6: [32, 37], G7: [38, 42] };
    for (const g of GRID_GATES) {
      const [lo, hi] = ranges[g.id]!;
      const steps = stepsOfGate(g.id);
      assert.equal(steps.length, hi - lo + 1, `${g.id} count`);
      assert.deepEqual(steps.map((s) => Number(s.id)), Array.from({ length: hi - lo + 1 }, (_, i) => lo + i), `${g.id} ids`);
    }
  });

  it('marks exactly the electrical gates G4–G7 as requiring an authority record', () => {
    const electrical = GRID_GATES.filter((g) => g.electricalAuthority).map((g) => g.id);
    assert.deepEqual(electrical, ['G4', 'G5', 'G6', 'G7']);
  });

  it('never carries any switching, set-point or relay capability on a step', () => {
    // Safety is in the shape of the data — there is no field to carry an OT action.
    for (const s of GRID_STEPS) assert.ok(!('control' in s) && !('setpoint' in s) && !('switching' in s));
  });
});

describe('gateState (spec §6.5 — digital readiness never advances an electrical gate)', () => {
  const allValidated = (gate: Parameters<typeof stepsOfGate>[0]): Record<string, StepStatus> =>
    Object.fromEntries(stepsOfGate(gate).map((s) => [s.id, 'VALIDATED' as StepStatus]));

  it('PENDING until every required digital step is validated', () => {
    const statuses = allValidated('G0');
    statuses['06'] = 'OPEN';
    assert.equal(gateState('G0', statuses), 'PENDING');
  });

  it('BLOCKED when a required step is blocked', () => {
    const statuses = allValidated('G0');
    statuses['03'] = 'BLOCKED';
    assert.equal(gateState('G0', statuses), 'BLOCKED');
  });

  it('a non-electrical gate reaches CANDIDATE_READY, then APPROVED on its decision', () => {
    assert.equal(gateState('G0', allValidated('G0')), 'CANDIDATE_READY');
    assert.equal(gateState('G0', allValidated('G0'), { decisionApproved: true }), 'APPROVED');
  });

  it('an electrical gate reaches AWAITING_AUTHORITY on readiness, APPROVED only with a verified authority record', () => {
    assert.equal(gateState('G5', allValidated('G5')), 'AWAITING_AUTHORITY');
    // A gate "decision" without an authority record does NOT advance an electrical gate.
    assert.equal(gateState('G5', allValidated('G5'), { decisionApproved: true }), 'AWAITING_AUTHORITY');
    assert.equal(gateState('G5', allValidated('G5'), { authorityRecorded: true }), 'APPROVED');
  });

  it('EXPIRED / SUPERSEDED take precedence (a reopened candidate)', () => {
    assert.equal(gateState('G7', allValidated('G7'), { authorityRecorded: true, superseded: true }), 'SUPERSEDED');
    assert.equal(gateState('G7', allValidated('G7'), { authorityRecorded: true, expired: true }), 'EXPIRED');
  });
});

describe('coverage', () => {
  it('counts validated required digital steps over all required', () => {
    const statuses: Record<string, StepStatus> = { '01': 'VALIDATED', '02': 'VALIDATED', '03': 'BLOCKED' };
    const c = coverage(statuses);
    assert.equal(c.requiredDigital, 42);
    assert.equal(c.validated, 2);
    assert.equal(c.percent, Math.round((2 / 42) * 100));
  });
});
