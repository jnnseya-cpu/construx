import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The design-change and design-baseline verticals, driven through the real HTTP
 * gateway with the exact request bodies the console's new commands send.
 *
 * Both registers were read-only in the product: the design-change engine could
 * propose, assess six domains, decide, implement, confirm and close, and the
 * baseline engine could freeze a package, approve a baseline and approve the
 * MIDP — and none of it had a console affordance, so each register dead-ended
 * at its first screen. This proves the commands added to `design.js` post a
 * body each route accepts and that the records actually move:
 *
 *   design change  PROPOSED → ASSESSED → APPROVED → IMPLEMENTED → CLOSED
 *   design package                       → FROZEN
 *   design baseline                      → APPROVED
 *   MIDP                                 → APPROVED
 *
 * i.e. the verticals work end to end, not just that the buttons exist.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

type Actor = 'pm' | 'designer';

const tokenFor = (who: Actor): string => {
  const auth = seed.users[who]!.auth;
  return issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    enterpriseId: auth.enterpriseId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;
};

async function call(
  method: string,
  path: string,
  who: Actor,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const project = () => seed.projectId;

const changeStatusOf = async (changeId: string): Promise<string> => {
  const { json } = await call('GET', `/v1/projects/${project()}/design-changes`, 'designer');
  const row = (json.changes as Array<Record<string, unknown>>).find((c) => c.changeId === changeId);
  return String(row?.status);
};

const changeRowOf = async (changeId: string): Promise<Record<string, unknown>> => {
  const { json } = await call('GET', `/v1/projects/${project()}/design-changes`, 'designer');
  return (json.changes as Array<Record<string, unknown>>).find((c) => c.changeId === changeId) ?? {};
};

const day = (offset: number): string => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const IMPACT_DOMAINS = ['DESIGN', 'COMMERCIAL', 'PLANNING', 'SAFETY', 'PROCUREMENT', 'INFORMATION'] as const;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the design-change vertical completes through the gateway', () => {
  it('is proposed, assessed on six domains, approved, implemented, confirmed and closed', async () => {
    // propose-change: the body shape the "Raise a design change" transform
    // produces — booleans resolved, cost in minor units, `affects` parsed into
    // kind/reference pairs. Proposed by the PM, who holds C but not A.
    const proposed = await call('POST', `/v1/projects/${project()}/design-changes`, 'pm', {
      title: 'Raise the inlet weir crest by 150mm',
      classification: 'CORRECTION',
      origin: 'RFI-204 answer',
      reason: 'The hydraulic check showed the weir 150mm low for the design storm.',
      currentRevision: 'C-101 Rev B',
      proposedRevision: 'C-101 Rev C',
      affects: [{ kind: 'Drawing', reference: 'C-101' }],
      touchesSafety: false,
      touchesStatutoryApproval: false,
      estimatedCostMinor: 1_500_000,
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.json));
    const changeId = String(proposed.json.changeId);
    assert.equal(await changeStatusOf(changeId), 'PROPOSED');

    // decide-change refuses approval while any of the six domains is unassessed
    // — the gateway holds the acceptance criterion, not just the engine.
    const premature = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/decision`, 'designer', {
      decision: 'APPROVE',
      rationale: 'Trying to approve before the domains are assessed.',
    });
    assert.equal(premature.status, 409, JSON.stringify(premature.json));

    // assess-impact: one domain at a time, the shape the form sends. The PM
    // holds U. After the sixth the change becomes ASSESSED.
    for (const domain of IMPACT_DOMAINS) {
      const assessed = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/impacts`, 'pm', {
        domain,
        applicable: true,
        assessment: `${domain.toLowerCase()} impact: the 150mm crest change carries no consequence here.`,
        assessedBy: 'E. Vasquez',
      });
      assert.equal(assessed.status, 201, JSON.stringify(assessed.json));
    }
    assert.equal(await changeStatusOf(changeId), 'ASSESSED');

    // The submitter cannot be the decider: the PM proposed it, so the PM
    // approving it is refused through the gateway.
    const selfDecided = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/decision`, 'pm', {
      decision: 'APPROVE',
      rationale: 'The proposer trying to approve their own change.',
    });
    assert.ok(selfDecided.status >= 400, 'the proposer must not be able to decide their own change');

    // decide-change: approved by the designer, who holds A and did not propose it.
    const decided = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/decision`, 'designer', {
      decision: 'APPROVE',
      rationale: 'All six domains assessed; cost and programme neutral.',
    });
    assert.equal(decided.status, 201, JSON.stringify(decided.json));
    assert.equal(await changeStatusOf(changeId), 'APPROVED');

    // record-change-implemented: the change made in the design, by the PM (U).
    const implemented = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/implemented`, 'pm', {
      note: 'C-101 reissued at Rev C with the raised crest.',
    });
    assert.equal(implemented.status, 201, JSON.stringify(implemented.json));
    assert.equal(await changeStatusOf(changeId), 'IMPLEMENTED');

    // close-change is refused while the one affected item is unconfirmed — the
    // closure list is derived from what the change named, so it cannot be
    // shortened at the end.
    const closedEarly = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/close`, 'designer', {
      note: 'Trying to close with C-101 still unconfirmed.',
    });
    assert.equal(closedEarly.status, 409, JSON.stringify(closedEarly.json));

    // confirm-affected: the body shape the "Confirm an affected item" transform
    // produces — the change id travels in the path, the reference in the body.
    const beforeConfirm = await changeRowOf(changeId);
    assert.equal(Number(beforeConfirm.affectedConfirmed), 0);
    const confirmed = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/affected`, 'pm', {
      reference: 'C-101',
      outcome: 'REVISED',
      note: 'Reissued at Rev C.',
    });
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.json));
    const afterConfirm = await changeRowOf(changeId);
    assert.equal(Number(afterConfirm.affectedConfirmed), 1);

    // close-change: now that every affected item is confirmed, the designer closes it.
    const closed = await call('POST', `/v1/projects/${project()}/design-changes/${changeId}/close`, 'designer', {
      note: 'Change made, C-101 confirmed revised at Rev C.',
    });
    assert.equal(closed.status, 201, JSON.stringify(closed.json));
    assert.equal(await changeStatusOf(changeId), 'CLOSED');
  });
});

describe('the design-baseline vertical completes through the gateway', () => {
  it('plans and publishes a package, approves the MIDP, freezes it, and approves a baseline', async () => {
    // --- Setup: a package with two published deliverables, built through the
    // plan's own routes so the fixture cannot drift from what the platform
    // accepts. These routes already have console affordances; the new commands
    // are the three that follow.
    const packageRef = 'PKG-GW01';
    const createdPkg = await call('POST', `/v1/projects/${project()}/design-packages`, 'pm', {
      reference: packageRef,
      title: 'Inlet works — gateway journey',
      discipline: 'CIVIL',
      zone: 'Inlet works',
      leadDesigner: 'D. Whyte',
      leadOrganisation: 'Caldervale Engineering',
    });
    assert.equal(createdPkg.status, 201, JSON.stringify(createdPkg.json));
    const packageId = String(createdPkg.json.packageId);

    for (const suffix of ['A', 'B']) {
      const planned = await call('POST', `/v1/projects/${project()}/design-packages/${packageId}/deliverables`, 'pm', {
        reference: `${packageRef}-${suffix}`,
        title: `General arrangement ${suffix}`,
        kind: 'DRAWING',
        purpose: 'For construction',
        format: 'PDF',
        author: 'J. Mensah',
        checker: 'D. Whyte',
        approver: 'A. Okafor',
        acceptingParty: 'Northern Water Authority',
        dueBy: day(10),
        neededBy: day(40),
        neededFor: 'the civils enquiry',
        reviewDays: 10,
      });
      assert.equal(planned.status, 201, JSON.stringify(planned.json));
      for (const to of ['SHARED', 'PUBLISHED']) {
        const advanced = await call('POST', `/v1/projects/${project()}/design-packages/${packageId}/deliverables/advance`, 'pm', {
          reference: `${packageRef}-${suffix}`,
          to,
        });
        assert.equal(advanced.status, 201, JSON.stringify(advanced.json));
      }
    }

    // approve-midp: the body shape the "Approve the MIDP" form sends. The
    // designer holds A. The plan reconciles — one package, two deliverables,
    // nothing duplicated, no dangling interface, nothing late for its need date.
    const midp = await call('POST', `/v1/projects/${project()}/midp`, 'designer', {
      cutOff: day(0),
      note: 'Plan reconciles: one package, two deliverables, no open contradiction.',
    });
    assert.equal(midp.status, 201, JSON.stringify(midp.json));
    const plan = await call('GET', `/v1/projects/${project()}/design-packages`, 'designer');
    assert.ok(plan.json.approvedMIDP, `the MIDP shows as approved: ${JSON.stringify(plan.json.approvedMIDP)}`);

    // freeze-package: the body shape the "Freeze a design package" transform
    // produces for a full freeze (no boundary, no interface checks, all
    // deliverables published). Frozen by the designer (A).
    const frozen = await call('POST', `/v1/projects/${project()}/design-packages/${packageId}/freeze`, 'designer', {
      scope: 'FULL',
      note: 'Every deliverable published and accepted; nothing open against it.',
    });
    assert.equal(frozen.status, 201, JSON.stringify(frozen.json));
    const freezeId = String(frozen.json.freezeId);
    assert.equal(Number(frozen.json.deliverables), 2, JSON.stringify(frozen.json));

    const afterFreeze = await call('GET', `/v1/projects/${project()}/design-baselines`, 'designer');
    const freezeRow = (afterFreeze.json.freezes as Array<Record<string, unknown>>).find(
      (f) => f.freezeId === freezeId,
    );
    assert.ok(freezeRow, 'the freeze appears on the baseline register');
    assert.equal(freezeRow!.packageReference, packageRef);
    assert.equal(freezeRow!.ready, true, 'nothing has moved since the freeze, so it is current');

    // approve-baseline: the body shape the "Approve a design baseline" transform
    // produces — the chosen freeze ids as an array, the cost snapshot nested
    // under `snapshots` with the source that makes the figure traceable.
    const baselineRef = 'DB-GW-01';
    const baseline = await call('POST', `/v1/projects/${project()}/design-baselines`, 'designer', {
      reference: baselineRef,
      cutOff: day(0),
      freezeIds: [freezeId],
      snapshots: { costMinor: 5_000_000, costSource: 'C-101 Rev C take-off' },
      note: 'Baseline over the inlet works freeze.',
    });
    assert.equal(baseline.status, 201, JSON.stringify(baseline.json));

    const afterBaseline = await call('GET', `/v1/projects/${project()}/design-baselines`, 'designer');
    const baselineRow = (afterBaseline.json.baselines as Array<Record<string, unknown>>).find(
      (b) => b.reference === baselineRef,
    );
    assert.ok(baselineRow, `the approved baseline appears on the register: ${JSON.stringify(afterBaseline.json.baselines)}`);
    assert.deepEqual(baselineRow!.packages, [packageRef]);
    assert.equal(Number(baselineRow!.costMinor), 5_000_000);
  });

  it('refuses a cost snapshot with no source through the gateway (AC-D-WF-08-02)', async () => {
    // A second package, frozen, so this assertion stands on its own freeze.
    const packageRef = 'PKG-GW02';
    const createdPkg = await call('POST', `/v1/projects/${project()}/design-packages`, 'pm', {
      reference: packageRef,
      title: 'Outfall — gateway journey',
      discipline: 'CIVIL',
      zone: 'Outfall',
      leadDesigner: 'D. Whyte',
      leadOrganisation: 'Caldervale Engineering',
    });
    const packageId = String(createdPkg.json.packageId);
    const planned = await call('POST', `/v1/projects/${project()}/design-packages/${packageId}/deliverables`, 'pm', {
      reference: `${packageRef}-A`,
      title: 'Outfall general arrangement',
      kind: 'DRAWING',
      purpose: 'For construction',
      format: 'PDF',
      author: 'J. Mensah',
      checker: 'D. Whyte',
      approver: 'A. Okafor',
      acceptingParty: 'Northern Water Authority',
      dueBy: day(10),
      neededBy: day(40),
      neededFor: 'the civils enquiry',
      reviewDays: 10,
    });
    assert.equal(planned.status, 201, JSON.stringify(planned.json));
    for (const to of ['SHARED', 'PUBLISHED']) {
      await call('POST', `/v1/projects/${project()}/design-packages/${packageId}/deliverables/advance`, 'pm', {
        reference: `${packageRef}-A`,
        to,
      });
    }
    const frozen = await call('POST', `/v1/projects/${project()}/design-packages/${packageId}/freeze`, 'designer', {
      scope: 'FULL',
      note: 'Outfall GA published; nothing open.',
    });
    const freezeId = String(frozen.json.freezeId);

    const refused = await call('POST', `/v1/projects/${project()}/design-baselines`, 'designer', {
      reference: 'DB-GW-02',
      cutOff: day(0),
      freezeIds: [freezeId],
      snapshots: { costMinor: 7_000_000 },
      note: 'A baseline whose cost names no source.',
    });
    assert.ok(refused.status >= 400, 'a cost snapshot with no source is refused');
    assert.equal(refused.json.code ?? refused.json.title, 'COST_SOURCE_REQUIRED', JSON.stringify(refused.json));
  });
});
