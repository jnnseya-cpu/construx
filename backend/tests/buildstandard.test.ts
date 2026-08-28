import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import * as agents from '../src/agents/runtime.ts';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { ownersByRole, ownersFor } from '../src/identity/ownership.ts';
import { evaluateControl } from '../src/lifecycle/control.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The Build Standard, on the delivery screens.
 *
 * Two of its clauses were met on exactly one screen — the operator console —
 * and on none of the screens a project person actually works in:
 *
 *   - every dashboard KPI drills to its source events;
 *   - every command centre carries an AI Insight / Recommendation panel with
 *     Review, Accept, Mitigate and Assign.
 *
 * Both were failures of *reach* rather than of machinery. The ledger has always
 * held the events behind every figure and there was no way to ask it from a
 * tile. The agent fleet has always produced findings with evidence, proposed
 * commands and mandated approvers, and it lived on the one screen a person only
 * opens once they have already decided to look at what the agents found — which
 * is backwards, because a recommendation is worth something at the moment
 * somebody is looking at the number it is about.
 *
 * What is tested here is the four things that had to be built rather than
 * reached for: the events filter a drill uses, the two missing decisions, the
 * area scoping that lets one panel serve nine screens, and the evidence refs
 * the control report was throwing away.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

async function call(method: string, path: string, who: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json().catch(() => undefined)) as any };
}

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

// --- the drill -------------------------------------------------------------

describe('a figure opens to the events behind it', () => {
  it('narrows the audit feed to the records a tile was computed from', async () => {
    const cvr = platform.ledger.list(seed.projectId, 'CVR').at(-1)!;
    const filtered = await call('GET', `/v1/projects/${seed.projectId}/audit/events?refs=CVR:${cvr.refId}`, 'qs');

    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.events.length > 0, 'the CVR carries no events');
    assert.ok(
      filtered.body.events.every((event: any) => event.entity.refType === 'CVR' && event.entity.refId === cvr.refId),
      'the filter let through an event from another record',
    );
  });

  it('leaves the unfiltered feed exactly as it was', async () => {
    // The filter is an addition to the route the audit trail already uses. A
    // regression here is a regression in the audit trail, which matters more
    // than the tile that prompted it.
    const all = await call('GET', `/v1/projects/${seed.projectId}/audit/events`, 'qs');

    assert.equal(all.status, 200);
    assert.ok(all.body.events.length > 50);
    assert.equal(all.body.requestedRefs, undefined, 'an unfiltered read reported a filter');
    assert.ok(all.body.chainHead, 'the chain head is missing');
  });

  it('takes several records at once, because most figures are a sum', async () => {
    const variations = platform.ledger.list(seed.projectId, 'Variation').slice(0, 3);
    assert.ok(variations.length >= 2, 'the seed produced too few variations to test a sum');

    const refs = variations.map((record) => `Variation:${record.refId}`).join(',');
    const drilled = await call('GET', `/v1/projects/${seed.projectId}/audit/events?refs=${encodeURIComponent(refs)}`, 'qs');

    assert.equal(drilled.body.requestedRefs.length, variations.length);
    assert.equal(drilled.body.matchedRefs, variations.length, 'not every named record was found');
  });

  it('splits a ref on its first colon only', async () => {
    // A ULID carries no colon and an imported reference might. Splitting on
    // every colon would truncate the id and quietly return another record's
    // events, which is the worst possible failure for an audit drill.
    const drilled = await call(
      'GET',
      `/v1/projects/${seed.projectId}/audit/events?refs=${encodeURIComponent('Contract:legacy:ref:001')}`,
      'qs',
    );

    assert.deepEqual(drilled.body.requestedRefs, ['Contract:legacy:ref:001']);
    assert.equal(drilled.body.events.length, 0, 'a malformed id matched something');
  });

  it('withholds content the reader may not see rather than dropping the row', async () => {
    // The same decision the audit feed makes. A drill that silently omitted
    // withheld rows would be a way round the capability model; one that shows
    // the envelope and withholds the content is the audit trail working.
    const cvr = platform.ledger.list(seed.projectId, 'CVR').at(-1)!;
    const restricted = await call('GET', `/v1/projects/${seed.projectId}/audit/events?refs=CVR:${cvr.refId}`, 'safety');

    assert.equal(restricted.status, 200);
    assert.ok(restricted.body.events.length > 0, 'the row was dropped rather than withheld');
    assert.ok(restricted.body.withheldCount > 0);
    assert.ok(restricted.body.events.every((event: any) => event.diff === undefined));
  });
});

// --- the panel's scoping ---------------------------------------------------

describe('one panel serves every command centre', () => {
  before(async () => {
    await agents.runAgents(ctx('pm'));
  });

  it('narrows to the areas a screen owns, and says how many it left out', async () => {
    const all = await call('GET', `/v1/projects/${seed.projectId}/proposals`, 'pm');
    const commercial = await call(
      'GET',
      `/v1/projects/${seed.projectId}/proposals?area=BUDGET_COST,PAYMENT_APPLICATIONS,CHANGE_VARIATION,CONTRACTS_CLAIMS`,
      'pm',
    );

    assert.ok(all.body.proposals.length > 0, 'the fleet raised nothing to scope');
    assert.ok(commercial.body.proposals.length < all.body.proposals.length, 'the scope let everything through');
    assert.equal(commercial.body.ofTotal, all.body.proposals.length);
  });

  it('matches an observation on the agent that raised it, not on a command it does not have', async () => {
    // Most findings are observations with nothing to run. Matching only on the
    // command's area would drop every one of them off every screen, which is
    // the majority of what the fleet produces.
    const scoped = await call('GET', `/v1/projects/${seed.projectId}/proposals?area=CONTRACTS_CLAIMS`, 'pm');
    const observations = scoped.body.proposals.filter((proposal: any) => !proposal.command);

    assert.ok(observations.length > 0, 'no observation reached a screen');
  });

  it('shows an item that is not the reader\'s, marked rather than hidden', () => {
    // A panel that hides everything outside its reader's remit makes a stalled
    // item invisible to everyone except the person already not acting on it.
    const queue = agents.pendingProposals(ctx('safety'));
    const theirs = queue.filter((proposal) => proposal.mine);

    assert.ok(queue.length > 0);
    assert.ok(theirs.length < queue.length, 'every proposal claimed to belong to a safety lead');
    assert.ok(queue.every((proposal) => proposal.approvers.length > 0), 'an item that is not yours does not say who decides it');
  });
});

// --- mitigate --------------------------------------------------------------

describe('mitigate is not a softer rejection', () => {
  /** A fresh open proposal to decide, so these do not fight over one another. */
  function openProposal(): string {
    const open = agents.pendingProposals(ctx('pm')).filter((proposal) => proposal.mine && proposal.status === 'OPEN');
    assert.ok(open.length > 0, 'no open proposal the PM may decide');
    return open[0]!.id;
  }

  it('records what is being done instead, and refuses to close without it', async () => {
    const id = openProposal();

    const empty = await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/mitigate`, 'pm', { mitigation: 'done' });
    assert.equal(empty.status, 400, 'a mitigation with nothing behind it was accepted');

    const closed = await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/mitigate`, 'pm', {
      mitigation: 'Re-sequenced with the subcontractor on site; recovery is on the two-week lookahead.',
    });
    assert.equal(closed.status, 201);
    assert.equal(closed.body.status, 'MITIGATED');
    assert.match(closed.body.mitigation, /Re-sequenced/);
    assert.ok(closed.body.decidedBy, 'nobody is named on the decision');
  });

  it('is kept apart from rejection, so the fleet\'s accuracy stays measurable', async () => {
    // Rejected means the finding was wrong. Mitigated means it was right and is
    // being handled another way. Collapsing them would lose the only signal the
    // platform has about whether its own findings are any good.
    const id = openProposal();
    await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/reject`, 'pm', {
      reason: 'The activity was re-baselined last week; this reads stale data.',
    });

    const record = platform.ledger.require({ refType: 'AgentProposal', refId: id });
    assert.equal(record.state.status, 'REJECTED');
    assert.equal(record.state.mitigation, undefined, 'a rejection recorded a mitigation');
  });

  it('cannot decide the same finding twice, whichever way it went', async () => {
    const id = openProposal();
    await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/mitigate`, 'pm', {
      mitigation: 'Covered by the early warning already issued under the subcontract.',
    });

    const again = await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/approve`, 'pm', {});
    assert.equal(again.status, 422);
    assert.equal(again.body.title, 'PROPOSAL_NOT_OPEN');
  });

  it('needs the same standing as approving', () => {
    // Closing a finding is a decision however it is closed. Anyone who could do
    // it without standing could clear the queue of everything they did not want
    // to look at. A regulator is the sharpest case: read-only over the whole
    // record by design, so if anybody could close a finding without standing it
    // would be them.
    const id = agents.pendingProposals(ctx('pm')).find((p) => p.status === 'OPEN')!.id;

    assert.throws(
      () => agents.mitigateProposal(ctx('regulator'), id, 'Handled on site, nothing further needed here.'),
      /NOT_A_NOMINATED_APPROVER|forbidden/i,
    );
  });
});

// --- assign ----------------------------------------------------------------

describe('assign names who decides, and is not a decision', () => {
  function openProposal(): string {
    const open = agents.pendingProposals(ctx('pm')).filter((proposal) => proposal.mine && proposal.status === 'OPEN');
    assert.ok(open.length > 0, 'no open proposal the PM may decide');
    return open[0]!.id;
  }

  /**
   * An open proposal a safety lead has no standing to decide.
   *
   * Chosen by reading the proposal's own approver list rather than taking the
   * first item in the queue. The fleet's composition is not this test's
   * subject, and pinning it to whichever agent happens to sort first turns any
   * change in the fleet into a failure here — which is exactly what happened
   * when the commercial and contracts agents were let into operations.
   */
  function beyondTheSafetyLead(): string {
    // The seeded HSE Manager holds exactly one role, and it is named here
    // rather than read back off the user so this reads as the statement it is:
    // a safety lead cannot decide a commercial or contractual proposal.
    const open = agents
      .pendingProposals(ctx('pm'))
      .filter((proposal) => proposal.mine && proposal.status === 'OPEN')
      .find((proposal) => !proposal.approvers.includes('SAFETY'));
    assert.ok(open, 'every open proposal can be decided by a safety lead, so the refusal cannot be tested');
    return open.id;
  }

  it('leaves the proposal open, because moving it is not dealing with it', async () => {
    const id = openProposal();
    const owners = await call('GET', `/v1/projects/${seed.projectId}/proposals/${id}/owners`, 'pm');
    assert.ok(owners.body.owners.length > 0, `nobody can decide this proposal: ${JSON.stringify(owners.body)}`);

    const assigned = await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/assign`, 'pm', {
      userId: owners.body.owners[0].userId,
      note: 'Yours before the next application',
    });

    assert.equal(assigned.status, 201);
    assert.equal(assigned.body.status, 'OPEN', 'assigning closed the proposal');
    assert.equal(assigned.body.assignedTo, owners.body.owners[0].userId);
    assert.ok(assigned.body.assignedToName);

    // Still in the queue, now with a name against it.
    const queue = agents.pendingProposals(ctx('pm'));
    const still = queue.find((proposal) => proposal.id === id);
    assert.ok(still, 'the assigned proposal left the open queue');
    assert.equal(still.assignedToName, owners.body.owners[0].name);
  });

  it('refuses an assignee who could not decide it, and says why', async () => {
    // An item assigned to somebody who cannot act looks owned and cannot move,
    // which is worse than an unassigned one — at least that is visibly nobody's.
    const id = beyondTheSafetyLead();
    const refused = await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/assign`, 'pm', {
      userId: seed.users.safety!.id,
    });

    assert.equal(refused.status, 422);
    assert.equal(refused.body.title, 'ASSIGNEE_CANNOT_DECIDE');
    assert.match(refused.body.detail, /nobody can move|no role that may decide/i);
  });

  it('resolves the assignee from the tenancy rather than from the request', async () => {
    // A client that could name the assignee's roles could assign a proposal to
    // somebody who cannot decide it by simply claiming they can.
    const id = openProposal();
    const stranger = await call('POST', `/v1/projects/${seed.projectId}/proposals/${id}/assign`, 'pm', {
      userId: 'not-an-identity-in-this-tenancy',
    });

    assert.equal(stranger.status, 404);
  });
});

// --- who can decide it -----------------------------------------------------

describe('who could decide this', () => {
  const identities = () =>
    platform.users(seed.tenantId).map((user) => ({ id: user.id, name: user.name, email: user.email, roles: user.roles }));

  it('answers for an observation, where there is no capability to intersect with', () => {
    // The defect this replaced: an observation has no command, the route asked
    // `ownersFor` for an invented area, and the invented one — approve on
    // EVIDENCE_AUDIT — is held by no role in the matrix. Every observation
    // reported that it could not be assigned to anybody.
    const byRole = ownersByRole(identities(), ['QS', 'PM', 'OWNER']);
    const byCapability = ownersFor(identities(), 'EVIDENCE_AUDIT', 'A');

    assert.ok(byRole.length > 0, 'no holder of QS, PM or OWNER was found');
    assert.equal(byCapability.length, 0, 'the old fallback found somebody, so this test proves nothing');
  });

  it('names the specialist first and the wider remit as the escalation', () => {
    const owners = ownersByRole(identities(), ['QS', 'PM', 'OWNER']);

    assert.equal(owners[0]!.escalation, false);
    assert.ok(owners.some((owner) => owner.escalation), 'nobody is the escalation, on three roles of different remit');
    assert.equal(owners[0]!.role, 'QS', 'the narrowest remit is not named first');
  });

  it('never names the platform operator as the owner of a delivery decision', () => {
    // The account layers exist to keep the operator out of customer delivery.
    // Naming one as the owner of a project decision would misrepresent that.
    const withOperator = [
      ...identities(),
      { id: 'op-1', name: 'Platform Operator', email: 'op@construx', roles: ['PLATFORM_ADMIN'] },
    ];

    assert.ok(!ownersByRole(withOperator, ['PLATFORM_ADMIN', 'QS']).some((owner) => owner.userId === 'op-1'));
  });
});

// --- the control report's own figures --------------------------------------

describe('the control standard names the records behind its counts', () => {
  const report = () =>
    evaluateControl(
      'CONSTRUCTION',
      (refType) => platform.ledger.list(seed.projectId, refType).map((record) => record.state),
      500_000_00,
    );

  it('carries the evidence refs for an item that is in place', () => {
    // The evaluation already had them and kept only `.length`. A screen showing
    // "4 of 5 in place" with no way to reach the four asks to be trusted.
    const present = report()
      .stages.flatMap((stage) => stage.items)
      .filter((item) => item.status === 'PRESENT');

    assert.ok(present.length > 0, 'nothing is in place on the seeded project');
    assert.ok(
      present.some((item) => (item.evidenceRefs ?? []).length > 0),
      'no item in place names a single record',
    );
    for (const item of present) {
      for (const ref of item.evidenceRefs ?? []) {
        assert.ok(ref.refId, `${item.id} carries a ref with no id`);
        assert.ok(platform.ledger.get(ref), `${item.id} names ${ref.refType}:${ref.refId}, which does not exist`);
      }
    }
  });

  it('names nothing for a gap, because a gap is the absence of records', () => {
    const missing = report()
      .stages.flatMap((stage) => stage.items)
      .filter((item) => item.status === 'MISSING');

    for (const item of missing) {
      assert.equal((item.evidenceRefs ?? []).length, 0, `${item.id} is missing and yet names evidence`);
    }
  });

  it('caps a long list and says it capped it', () => {
    // An item evidenced by four hundred records makes a drill nobody can read.
    // A truncated list must not be mistaken for the whole one.
    const items = report().stages.flatMap((stage) => stage.items);

    for (const item of items) {
      assert.ok((item.evidenceRefs ?? []).length <= 25, `${item.id} returned more than the cap`);
      if (item.evidenceTruncated) assert.equal(item.evidenceRefs!.length, 25);
    }
  });
});
