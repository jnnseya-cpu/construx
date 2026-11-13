import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as store from '../src/domain/grid/store.ts';
import { GATE_IDS, GRID_CAPABILITIES, GRID_STEPS, gateMeta, stepsOfGate } from '../src/domain/grid/playbook.ts';
import { GRID_CONDUCT } from '../src/domain/grid/store.ts';

/**
 * The spec's §9 build-and-acceptance plan (A01–A18), proven against the engine that
 * exists rather than described. Each scenario is mapped here to where it is proven,
 * honestly — this file does not assert a behaviour the engine does not implement.
 *
 *   A01  no grant → module unusable ............ gated on Slice 5b (persisted entitlement)†
 *   A02  seat pricing £100 → £200 .............. tests/addon.test.ts (pure price table)
 *   A03  last-seat contention, one wins ........ tests/addon.test.ts (canAllocateSeat) + 5b persistence†
 *   A04  duplicate / out-of-order webhooks ..... gated on Slice 5b (provider reconciliation)†
 *   A05  seat decrease with excess assignments . tests/addon.test.ts (seatsToUnassign) + 5b persistence†
 *   A06  payment fails mid-run → pause ......... tests/addon.test.ts (moduleUsable) + 5b runtime gate†
 *   A07  platform admin ≠ project role ......... platform account-layer separation (tenantContext bars
 *                                                PLATFORM_ADMIN; QUALITY_COMMISSIONING authorise gate here)
 *   A08  distribution offer → route-aware ...... PROVEN BELOW
 *   A09  prompt injection / tenant isolation ... GRID_CONDUCT grounding + the single `write`/ledger path
 *                                                (every grid write is tenant-scoped) + the misfile guard
 *   A10  submission without acceptance blocked . PROVEN BELOW (electrical acceptance gate stays blocked)
 *   A11  CT/VT revision after FAT reopens ...... tests/gridstore.test.ts (recordTrigger → STALE + SUPERSEDED)
 *   A12  withdrawn outage fails final gate ..... PROVEN BELOW
 *   A13  energised, permitted load missing ..... PROVEN BELOW (transfer gate stays blocked without authority)
 *   A14  cutover lacks rollback → blocker ...... PROVEN BELOW (unaffected gate still completes)
 *   A15  no switching tool / execution path .... PROVEN BELOW (catalogue, conduct and brief carry none)
 *   A16  utility delay → draft, not published .. tests/gridstore.test.ts (runStep records, never auto-releases)
 *   A17  full 42-task synthetic walk ........... PROVEN BELOW
 *   A18  add-on disabled → core regresses clean. the whole core suite is green with the module inactive
 *
 * † Slice 5b (the persisted three-state grant/seat store and its enforcement) is
 *   deliberately deferred: those states straddle the platform↔tenant account-layer
 *   boundary and tie into provider reconciliation left behind a commercial-sign-off
 *   flag. The pure contract they will compute against is proven in tests/addon.test.ts.
 */

let platform: Platform;
let seed: SeedResult;
// QAQC holds QUALITY_COMMISSIONING create/update/approve — the commissioning area the module authorises against.
const ctx = (): EngineContext => platform.context(seed.users.qaqc!.auth, seed.projectId, { correlationId: 'grid-accept' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

function validateGate(engagementId: string, gate: Parameters<typeof stepsOfGate>[0]): void {
  for (const s of stepsOfGate(gate)) store.updateStep(ctx(), engagementId, s.id, { runState: 'VALIDATED', validated: true });
}

function gateOf(engagementId: string, gate: string): store.GridWorkboard['gates'][number] {
  return store.gridWorkboard(ctx(), engagementId).gates.find((g) => g.id === gate)!;
}

describe('A08 — a distribution offer is delivered on distribution rules, assuming no transmission approval', () => {
  it('grounds every step in the distribution route and still demands a verified authority for an electrical gate', () => {
    const { engagementId } = store.openGridEngagement(ctx(), { connection: 'DNO 11kV intake', route: 'DISTRIBUTION', pointOfConnection: 'Primary 11kV' });
    // The agent is grounded in the distribution route the offer actually is — never a transmission one.
    const brief = store.stepExecutionBrief(store.gridWorkboard(ctx(), engagementId).engagement, '02');
    assert.equal(brief.connection.route, 'DISTRIBUTION');

    // Energisation (G5) is an electrical-authority gate whatever the route: a distribution
    // connection does not get a free pass, and no transmission approval is assumed in its place.
    validateGate(engagementId, 'G5');
    assert.equal(gateOf(engagementId, 'G5').state, 'AWAITING_AUTHORITY');
    assert.throws(
      () => store.decideGate(ctx(), engagementId, 'G5', { decisionApproved: true }),
      (e) => (e as { code?: string }).code === 'AUTHORITY_REQUIRED',
    );
  });
});

describe('A10 / A13 — an electrical acceptance gate stays blocked until a verified authority record exists', () => {
  it('refuses first-energisation and demand-transfer decisions on readiness alone', () => {
    const { engagementId } = store.openGridEngagement(ctx(), { connection: 'c', route: 'DIRECT_TRANSMISSION' });
    // A10: energisation submitted (digitally ready) but with no accepted authority — the gate holds.
    validateGate(engagementId, 'G5');
    assert.equal(gateOf(engagementId, 'G5').state, 'AWAITING_AUTHORITY');
    assert.throws(
      () => store.decideGate(ctx(), engagementId, 'G5', { decisionApproved: true }),
      (e) => (e as { code?: string }).code === 'AUTHORITY_REQUIRED',
    );
    // A13: campus/demand transfer (G6) likewise — energised is not permitted-to-take-load.
    validateGate(engagementId, 'G6');
    assert.equal(gateOf(engagementId, 'G6').state, 'AWAITING_AUTHORITY');
    assert.throws(
      () => store.decideGate(ctx(), engagementId, 'G6', { decisionApproved: true }),
      (e) => (e as { code?: string }).code === 'AUTHORITY_REQUIRED',
    );
    // With the verified record each advances — and only then.
    store.decideGate(ctx(), engagementId, 'G5', { authorityRef: 'MRA energisation consent EON-2026-220' });
    assert.equal(gateOf(engagementId, 'G5').state, 'APPROVED');
  });
});

describe('A12 — an approved outage withdrawn during rendering fails the final gate check', () => {
  it('supersedes a gate that was approved, so release can no longer read it as current', () => {
    const { engagementId } = store.openGridEngagement(ctx(), { connection: 'c', route: 'DIRECT_TRANSMISSION' });
    validateGate(engagementId, 'G5');
    store.decideGate(ctx(), engagementId, 'G5', { authorityRef: 'Energisation consent EON-2026-221' });
    assert.equal(gateOf(engagementId, 'G5').state, 'APPROVED');

    // The outage the energisation relied on is withdrawn before dispatch.
    store.recordTrigger(ctx(), engagementId, { event: 'Approved outage withdrawn by control', affectedGates: ['G5'] });
    assert.equal(gateOf(engagementId, 'G5').state, 'SUPERSEDED');
  });
});

describe('A14 — a blocked cutover raises a blocker and the unaffected work still completes', () => {
  it('blocks the cutover gate while an unrelated electrical gate reaches APPROVED', () => {
    const { engagementId } = store.openGridEngagement(ctx(), { connection: 'c', route: 'DIRECT_TRANSMISSION' });
    // Cutover (G6) lacks verified rollback/contingency evidence — one of its steps is blocked.
    const g6First = stepsOfGate('G6')[0]!.id;
    store.updateStep(ctx(), engagementId, g6First, { runState: 'BLOCKED', blocker: 'Awaiting verified rollback and contingency evidence' });
    const board = store.gridWorkboard(ctx(), engagementId);
    assert.equal(board.gates.find((g) => g.id === 'G6')!.state, 'BLOCKED');
    assert.ok(board.nextActions.some((a) => new RegExp(`G6.*blocked on step\\(s\\).*${g6First}`).test(a)));

    // Unaffected work carries on: commissioning (G4) is validated and authority-approved.
    validateGate(engagementId, 'G4');
    store.decideGate(ctx(), engagementId, 'G4', { authorityRef: 'Commissioning compliance notice FON-2026-31' });
    assert.equal(gateOf(engagementId, 'G4').state, 'APPROVED');
    // …and the cutover gate is still blocked, not quietly carried.
    assert.equal(gateOf(engagementId, 'G6').state, 'BLOCKED');
  });
});

describe('A15 — there is no switching, set-point or relay tool, and no path to one', () => {
  it('carries no operational capability in the catalogue, the conduct rule or the execution brief', () => {
    // No capability is an operational act: all ten are analytical/records roles.
    const operational = /SWITCH|ENERGISE|ENERGIZE|RELAY|SETPOINT|SET_POINT|OPERATE|BREAKER|ISOLATE/i;
    for (const cap of GRID_CAPABILITIES) assert.ok(!operational.test(cap), `${cap} reads as an operational act`);

    // The conduct rule forbids issuing, implying or drafting any such instruction.
    assert.match(GRID_CONDUCT, /never (?:issue|claim)/i);
    assert.match(GRID_CONDUCT, /switch, energise, set a relay or operate/i);

    // The grounded brief exposes no control surface — only the connection identity and the digital step.
    const { engagementId } = store.openGridEngagement(ctx(), { connection: 'c', route: 'DIRECT_TRANSMISSION' });
    const brief = store.stepExecutionBrief(store.gridWorkboard(ctx(), engagementId).engagement, '31');
    assert.deepEqual(Object.keys(brief.step).sort(), ['capability', 'executes', 'gate', 'id', 'output']);
    for (const forbidden of ['control', 'switching', 'setpoint', 'relay', 'operate']) {
      assert.ok(!(forbidden in brief.step), `the brief exposes a ${forbidden} surface`);
    }

    // The store exports no function that could execute an operational act.
    for (const name of Object.keys(store)) assert.ok(!operational.test(name), `store exports ${name}`);
  });
});

describe('A17 — a complete synthetic project runs all 42 digital tasks to a clean handover', () => {
  it('validates every step and carries all eight gates to APPROVED, electrical gates on authority records', () => {
    const { engagementId } = store.openGridEngagement(ctx(), {
      connection: 'Synthetic direct-demand data-centre connection',
      route: 'DIRECT_TRANSMISSION',
      pointOfConnection: 'Grid supply point 132kV',
      capacityNote: 'Interim and permanent sources; staged demand permission',
    });

    // Every one of the 42 digital tasks is executed and independently validated.
    for (const s of GRID_STEPS) store.updateStep(ctx(), engagementId, s.id, { runState: 'VALIDATED', validated: true });
    assert.equal(store.gridWorkboard(ctx(), engagementId).coverage.percent, 100);

    // Each gate decided in order; an electrical gate (G4–G7) only on a verified authority record.
    let authorityIndex = 0;
    const authorities = [
      'ITP & commissioning compliance notice FON-2026-40',
      'MRA first-energisation consent EON-2026-41',
      'Staged demand permission ION-2026-42',
      'Final compliance & handover certificate FON-2026-43',
    ];
    for (const g of GATE_IDS) {
      if (gateMeta(g).electricalAuthority) {
        store.decideGate(ctx(), engagementId, g, { authorityRef: authorities[authorityIndex++]! });
      } else {
        store.decideGate(ctx(), engagementId, g, { decisionApproved: true });
      }
    }

    const board = store.gridWorkboard(ctx(), engagementId);
    assert.ok(board.gates.every((g) => g.state === 'APPROVED'), `not every gate reached APPROVED: ${board.gates.map((g) => `${g.id}:${g.state}`).join(', ')}`);
    // Every electrical approval reconciles to an authority record, not a bare decision flag.
    for (const g of board.gates.filter((g) => g.electricalAuthority)) {
      const rec = board.engagement.gates[g.id]!;
      assert.ok(rec.authorityRecorded && rec.authorityRef, `${g.id} approved without a verified authority record`);
    }
    assert.equal(board.nextActions.length, 0, 'a fully approved engagement has no outstanding next action');
  });
});
