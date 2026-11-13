import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EVENT_TYPES, lookupEventType } from '../src/goldenthread/eventTypes.ts';
import {
  ACTION_CLASS_META,
  REASON_CODES,
  actionClassOf,
  aiExecutableReservedDecisions,
  delegatedExecutionEvents,
  isReasonCode,
  reservedDecisionEvents,
} from '../src/goldenthread/autonomy.ts';

/**
 * The agent-autonomy enforcement boundary (Tier-1 Agent OS spec §1 and §5),
 * asserted against the live event catalogue. The point of the module is that
 * the boundary is checkable rather than conventional, so these tests are the
 * boundary.
 */

describe('agent autonomy · the enforcement boundary holds across the catalogue', () => {
  it('classifies every catalogue event into A1/A2/A3, with reserved decisions present', () => {
    for (const definition of EVENT_TYPES) {
      const cls = actionClassOf(definition);
      assert.ok(cls === 'A1' || cls === 'A2' || cls === 'A3', `${definition.code} classified ${cls}, outside A1/A2/A3`);
    }
    assert.ok(reservedDecisionEvents().length > 0, 'the catalogue has reserved-decision events for a human to take');
  });

  it('NEVER lets an AI actor take a decision — the A4 prohibition on self-authorising', () => {
    // The irreducible human act is a decision: accepting or refusing a thing.
    // No approve/reject event, which is always reserved (A3), may be producible
    // by an AI actor.
    const offenders = aiExecutableReservedDecisions();
    assert.deepEqual(
      offenders.map((d) => d.code),
      [],
      'a reserved decision (approve / reject, or a formal reserved issue) must never be aiAllowed',
    );
    const aiDecisions = EVENT_TYPES.filter((d) => (d.action === 'APPROVE' || d.action === 'REJECT') && d.aiAllowed);
    assert.deepEqual(aiDecisions.map((d) => d.code), [], 'no accept/refuse event is executable by an AI actor');
  });

  it('separates a delegated outbound (A2) from a reserved decision (A3) and an internal record (A1)', () => {
    const verified = lookupEventType('EVIDENCE_CLAIM_VERIFIED');
    assert.ok(verified);
    assert.equal(actionClassOf(verified), 'A3', 'verifying a claim is a reserved decision');
    assert.equal(verified.aiAllowed, false);

    const asserted = lookupEventType('EVIDENCE_CLAIM_ASSERTED');
    assert.ok(asserted);
    assert.equal(actionClassOf(asserted), 'A1', 'attaching a claim is an internal, reversible record');

    // Issuing correspondence is an outbound action the catalogue lets an agent
    // produce — delegated execution (A2), not a reserved decision.
    const correspondence = lookupEventType('CORRESPONDENCE_ISSUED');
    assert.ok(correspondence);
    assert.equal(actionClassOf(correspondence), 'A2', 'issuing correspondence is delegated outbound, not a decision');
    assert.ok(delegatedExecutionEvents().some((d) => d.code === 'CORRESPONDENCE_ISSUED'));

    assert.equal(ACTION_CLASS_META.A3.title, 'Reserved decision');
    assert.equal(ACTION_CLASS_META.A2.title, 'Delegated execution');
    assert.equal(ACTION_CLASS_META.A0.title, 'Observe');
  });
});

describe('agent autonomy · the reason-code vocabulary matches the specification', () => {
  it('carries exactly the specification’s §5 reason codes', () => {
    assert.equal(REASON_CODES.length, 15, 'the spec defines fifteen reason codes');
    for (const code of [
      'SOURCE_MISSING',
      'SCOPE_MISMATCH',
      'REVISION_STALE',
      'AUTHORITY_MISSING',
      'SAFETY_HOLD',
      'REGULATORY_HOLD',
      'RECEIPT_UNCONFIRMED',
      'CONNECTOR_DISABLED',
    ]) {
      assert.ok(isReasonCode(code), `${code} is a recognised reason code`);
    }
    assert.ok(!isReasonCode('NOT_A_REASON'), 'an unknown code is not recognised');
    assert.equal(new Set(REASON_CODES).size, REASON_CODES.length, 'no duplicate reason codes');
  });
});
