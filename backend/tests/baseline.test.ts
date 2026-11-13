import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ROUTES } from '../src/api/routes.ts';
import { ALL_ROLES } from '../src/identity/roles.ts';
import { DISCIPLINES, RIBA_STAGE_NUMBERS, ROLE_EXPERTISE } from '../src/ai/expertise.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';

/**
 * The stability lock: nothing silently changes or drops.
 *
 * Every other test here guards *behaviour* — that a thing does what it should.
 * This one guards *inventory* — that the things still exist. The two fail in
 * different ways: a behaviour regression breaks the test for that behaviour; a
 * whole route, event type, role or discipline deleted by a careless merge or a
 * bad rebase breaks nothing at all, because the test that covered it leaves with
 * it. That is the silent drop this file exists to make loud.
 *
 * The numbers are **floors, not fixtures**. `>=` is deliberate: adding a route
 * or an event type is the platform growing and must never break this test, so
 * growth passes untouched. Only a *shrink* fails — the catalogue came back
 * smaller than the locked baseline, which is a drop somebody needs to have
 * decided on, not discovered in production. When a removal is genuine and
 * intended, lowering a floor here is the one line that records the decision; a
 * floor lowered without that intent is the bug.
 *
 * Baseline locked at commit 8fdfd42 (2026-11-08): the chartered-expert framing,
 * the RIBA 0–7 model, the verify-and-improve loops, the risk/change managers,
 * and the fully branded PDF / Word / Excel exports all present and green.
 */

// The floor each catalogue was locked at. Lower a number here ONLY with a
// deliberate, recorded removal — never to make a surprised test pass.
const LOCKED = {
  routes: 1362,
  roles: 22,
  disciplines: 19,
  eventTypes: 878,
} as const;

describe('the stability lock — nothing silently drops', () => {
  it('keeps every API route the baseline had', () => {
    assert.ok(
      ROUTES.length >= LOCKED.routes,
      `the route table shrank from ${LOCKED.routes} to ${ROUTES.length} — a route was dropped, ` +
        'or lower the floor if the removal was intended',
    );
  });

  it('keeps every closed event type the Golden Thread catalogue had', () => {
    assert.ok(
      EVENT_TYPES.length >= LOCKED.eventTypes,
      `the event catalogue shrank from ${LOCKED.eventTypes} to ${EVENT_TYPES.length} — an event type ` +
        'was dropped from a closed catalogue, which breaks replay of any ledger that used it',
    );
  });

  it('keeps every role in the identity matrix', () => {
    assert.ok(
      ALL_ROLES.length >= LOCKED.roles,
      `the role matrix shrank from ${LOCKED.roles} to ${ALL_ROLES.length} — a role was dropped`,
    );
  });

  it('keeps every construction discipline the agents reason as', () => {
    assert.ok(
      DISCIPLINES.length >= LOCKED.disciplines,
      `the discipline set shrank from ${LOCKED.disciplines} to ${DISCIPLINES.length} — an expert was dropped`,
    );
  });

  it('keeps the full RIBA 0–7 lifecycle', () => {
    // Exact, not a floor: the RIBA plan of work is a fixed eight stages, and a
    // stage missing from the middle is as wrong as one dropped off the end.
    assert.deepEqual(RIBA_STAGE_NUMBERS, [0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps an expert mapping for every role, so no seat silently loses its agent', () => {
    for (const role of ALL_ROLES) {
      assert.ok(role in ROLE_EXPERTISE, `${role} lost its expert mapping — the seat reasons as nobody`);
    }
  });
});
