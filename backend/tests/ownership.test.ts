import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ownersFor, ownershipMap, type Identity } from '../src/identity/ownership.ts';
import { CAPABILITY_AREA_LIST, PERMISSION_CODE_LIST, PERMISSION_MATRIX, roleAllows } from '../src/identity/roles.ts';

/**
 * Who owns the decision.
 *
 * The failure this prevents is not a wrong name. It is the same name against
 * every item on every screen — an enterprise admin holds approval over most of
 * the business, so naming holders in matrix order puts the director against the
 * payment application, the variation, the RAMS and the drawing alike. A screen
 * that names everybody names nobody.
 */

const TEAM: Identity[] = [
  { id: 'u-admin', name: 'Amara Osei', email: 'amara@example', roles: ['ENTERPRISE_ADMIN'] },
  { id: 'u-owner', name: 'Client Representative', email: 'owner@example', roles: ['OWNER'] },
  { id: 'u-qs', name: 'Bea Nkemdirim', email: 'qs@example', roles: ['QS'] },
  { id: 'u-pm', name: 'Cal Iverson', email: 'pm@example', roles: ['PM'] },
  { id: 'u-planner', name: 'Esi Mensah', email: 'planner@example', roles: ['PLANNER'] },
  { id: 'u-safety', name: 'Dev Rahman', email: 'hse@example', roles: ['SAFETY'] },
  { id: 'u-ops', name: 'Platform Operator', email: 'ops@example', roles: ['PLATFORM_ADMIN'] },
];

describe('naming the owner', () => {
  it('names the specialist before the generalist', () => {
    // PLANNER approves in one area, PM in eight, OWNER in ten. A baseline is
    // the planner's decision, escalating upward — not the other way round.
    const owners = ownersFor(TEAM, 'PROGRAMME_BASELINES', 'A');
    assert.ok(owners.length >= 2, 'the seeded roles hold baseline approval; nobody was named');
    assert.equal(owners[0]!.role, 'PLANNER', `named ${owners[0]!.role} ahead of the planner`);
    assert.deepEqual(owners.map((o) => o.role), ['PLANNER', 'PM', 'OWNER']);
  });

  it('marks the wider remit as an escalation rather than the person to chase', () => {
    const owners = ownersFor(TEAM, 'PROGRAMME_BASELINES', 'A');
    assert.equal(owners[0]!.escalation, false, 'the narrowest holder was marked as an escalation');
    assert.ok(
      owners.slice(1).every((o) => o.escalation),
      'a wider-remit holder was offered as the first port of call',
    );
  });

  it('counts the permission code, not every area the role touches', () => {
    // The obvious version — count all areas — does not discriminate: PM touches
    // 22 and OWNER 21, so one area of noise would decide who a screen names.
    // Counting approvals separates them: PM approves in 8, OWNER in 10.
    const owners = ownersFor(TEAM, 'CHANGE_VARIATION', 'A');
    assert.deepEqual(owners.map((o) => o.role), ['PM', 'OWNER']);
  });

  it('invents no hierarchy where holders are equal', () => {
    // Two people in the same role are two equal owners. Marking one of them as
    // an escalation would assert a seniority the matrix does not carry.
    const twoPlanners: Identity[] = [
      { id: 'a', name: 'Ada', email: 'a@example', roles: ['PLANNER'] },
      { id: 'b', name: 'Bo', email: 'b@example', roles: ['PLANNER'] },
    ];
    const owners = ownersFor(twoPlanners, 'PROGRAMME_BASELINES', 'A');
    assert.equal(owners.length, 2);
    assert.deepEqual(owners.map((o) => o.escalation), [false, false]);
  });

  it('never names the platform operator against a delivery decision', () => {
    // The operator account layer is deliberately blind to delivery. Naming it
    // as the owner of a site decision would misrepresent the separation the
    // account layers exist to enforce — and would be a name nobody can act on.
    for (const area of ['SAFETY_RAMS', 'PAYMENT_APPLICATIONS', 'DESIGN_INFORMATION', 'FIELD_EXECUTION'] as const) {
      for (const owner of ownersFor(TEAM, area, 'A')) {
        assert.notEqual(owner.role, 'PLATFORM_ADMIN', `the operator was named as an owner in ${area}`);
      }
    }
  });

  it('still names the operator where the capability is genuinely theirs', () => {
    const owners = ownersFor(TEAM, 'BILLING_ACU', 'A');
    assert.ok(
      owners.some((o) => o.role === 'PLATFORM_ADMIN'),
      'the operator was excluded from a capability that is theirs alone',
    );
  });

  it('takes the narrowest role a person holds, not the first one listed', () => {
    // A PM who is also an enterprise admin owns a programme decision as a PM.
    const wearingTwoHats: Identity[] = [
      { id: 'x', name: 'Ines Boateng', email: 'x@example', roles: ['ENTERPRISE_ADMIN', 'PM'] },
    ];
    const owners = ownersFor(wearingTwoHats, 'PROGRAMME_BASELINES', 'A');
    if (owners.length > 0) {
      assert.equal(owners[0]!.role, 'PM', 'the wider role was used to describe a specialist decision');
    }
  });

  it('names nobody where nobody holds the capability', () => {
    const justSafety: Identity[] = [{ id: 's', name: 'Solo', email: 's@example', roles: ['SAFETY'] }];
    assert.deepEqual(ownersFor(justSafety, 'PAYMENT_APPLICATIONS', 'A'), []);
  });

  it('returns only people who really hold it, checked against the matrix itself', () => {
    // Not a restatement of the implementation: the matrix is the authority, and
    // this asserts the resolver never widens it.
    for (const owner of ownersFor(TEAM, 'CHANGE_VARIATION', 'A')) {
      assert.ok(
        roleAllows(owner.role, 'CHANGE_VARIATION', 'A'),
        `${owner.name} was named under a role that does not hold the capability`,
      );
    }
  });
});

describe('the ownership map', () => {
  it('covers every capability area any role touches', () => {
    const declared = new Set<string>();
    for (const matrix of Object.values(PERMISSION_MATRIX)) {
      for (const area of Object.keys(matrix)) declared.add(area);
    }

    const mapped = new Set(ownershipMap(TEAM).map((row) => row.area));
    for (const area of declared) {
      assert.ok(mapped.has(area as never), `${area} is in the matrix and missing from the ownership map`);
    }
  });

  it('calls an empty seat a seat gap', () => {
    // A queue that cannot drain is a seat-provisioning problem the enterprise
    // admin needs to see, not an empty list that reads as "nothing pending".
    const thin: Identity[] = [{ id: 's', name: 'Solo', email: 's@example', roles: ['SUPERVISOR'] }];
    const rows = ownershipMap(thin);

    const gaps = rows.filter((row) => row.noApprover === 'SEAT_GAP');
    assert.ok(gaps.length > 0, 'a one-supervisor tenancy reported an approver for every area');
    for (const row of gaps) assert.deepEqual(row.approve, []);

    // Specific and checkable: somebody approves a baseline, and it is not a
    // supervisor, so this tenancy is short a seat rather than fully staffed.
    assert.equal(rows.find((row) => row.area === 'PROGRAMME_BASELINES')!.noApprover, 'SEAT_GAP');
  });

  it('does not call an unapprovable area a gap', () => {
    /*
     * Nothing in the audit feed is approved — it is read. Reporting it as a
     * missing seat would send an administrator looking for a role that does not
     * exist, which is worse than saying nothing.
     *
     * The tenancy under test has an owner, and an owner holds every capability
     * in their own business — so the question "is anything approved here?" can
     * no longer be asked of the whole matrix, because the owner's blanket row
     * answers yes everywhere. It is asked of the roles that describe a job,
     * which is what `ownershipMap` now does.
     */
    const rows = ownershipMap(TEAM);
    for (const area of ['EVIDENCE_AUDIT', 'AI_EXECUTION', 'SUPPLIER_SUBMISSION'] as const) {
      const row = rows.find((entry) => entry.area === area)!;
      assert.equal(
        row.noApprover,
        undefined,
        `${area} reported no approver; the owner approves everywhere in their own tenancy`,
      );
      assert.deepEqual(
        row.approve.map((owner) => owner.role),
        ['OWNER'],
        `${area} is approved by somebody other than the owner; no specialist role approves there`,
      );
      assert.equal(row.ownerOnly, undefined, `${area} is not a seat anybody can be put in, so it is not an owner-only gap`);
    }
  });

  it('says when the owner is the only cover, so a seat gap is still visible', () => {
    /*
     * The regression this exists to stop. An owner holds every capability in
     * the tenancy, so once one exists no area can report `SEAT_GAP` — the owner
     * covers it — and the table that tells an administrator nobody is doing a
     * job would have gone quiet for good.
     *
     * A quantity surveying seat does not stop being unfilled because the
     * managing director could sign it themselves.
     */
    const justTheOwner: Identity[] = [{ id: 'o', name: 'Founder', email: 'o@example', roles: ['OWNER'] }];
    const rows = ownershipMap(justTheOwner);

    const flagged = rows.filter((row) => row.ownerOnly);
    assert.ok(flagged.length > 0, 'a tenancy of one owner reported a staffed seat for every area');
    for (const row of flagged) {
      assert.deepEqual(row.approve.map((owner) => owner.role), ['OWNER']);
      assert.equal(row.noApprover, undefined, 'the owner can approve, so this is not "no approver"');
    }

    // Specific and checkable, and the same area the seat-gap test uses.
    assert.equal(rows.find((row) => row.area === 'PROGRAMME_BASELINES')!.ownerOnly, true);

    // Staffed areas are not flagged: the owner is cover, not the only cover.
    assert.equal(rows.find((row) => row.area === 'EVIDENCE_AUDIT')!.ownerOnly, undefined);
    assert.equal(ownershipMap(TEAM).find((row) => row.area === 'PROGRAMME_BASELINES')!.ownerOnly, undefined);
  });

  it('gives the owner every capability in their own tenancy, and none outside it', () => {
    // The instruction this implements, asserted where it can be read: absolute
    // access to the business they own, and nothing at all on the operator's
    // cross-tenant area, which governs every other customer as well.
    const owner = PERMISSION_MATRIX.OWNER;
    const codes = PERMISSION_CODE_LIST;
    for (const area of CAPABILITY_AREA_LIST) {
      if (area === 'PLATFORM_ADMINISTRATION') {
        assert.equal(owner[area], undefined, 'the owner of one tenancy holds the operator area over all of them');
        continue;
      }
      for (const code of codes) {
        assert.ok(owner[area]?.includes(code), `the owner does not hold "${code}" on ${area}`);
      }
    }
  });

  it('reports no gap where the tenancy is staffed for the area', () => {
    const rows = ownershipMap(TEAM);
    const commercial = rows.find((row) => row.area === 'PAYMENT_APPLICATIONS')!;
    assert.equal(commercial.noApprover, undefined);
    assert.ok(commercial.approve.length > 0);
  });

  it('is stable in order, so a screen does not reshuffle between reads', () => {
    const first = ownershipMap(TEAM).map((row) => row.area);
    const second = ownershipMap(TEAM).map((row) => row.area);
    assert.deepEqual(first, second);
  });
});
