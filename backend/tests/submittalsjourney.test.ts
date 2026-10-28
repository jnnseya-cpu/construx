import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The submittal lifecycle, driven through the real HTTP gateway with the exact
 * request bodies the console's new commands send.
 *
 * The backend submit/resubmit/review/order flow was already complete and
 * tested, but a raised submittal could never be *sent for review* from the
 * product — the `submit`, `resubmit` and `ordered` routes had no console
 * affordance, so the register dead-ended in DRAFT. This proves the three
 * commands added to `design.js` post a body each route accepts and that the
 * record actually moves DRAFT → UNDER_REVIEW → (revise) → DRAFT → UNDER_REVIEW
 * → APPROVED, with an order recorded — i.e. the vertical works end to end, not
 * just that the buttons exist.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let clauseId: string;

const tokenFor = (who: 'pm' | 'designer'): string => {
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
  who: 'pm' | 'designer',
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
const statusOf = async (submittalId: string): Promise<string> => {
  const { json } = await call('GET', `/v1/projects/${project()}/submittals`, 'pm');
  const row = (json.submittals as Array<Record<string, unknown>>).find((s) => s.submittalId === submittalId);
  return String(row?.status);
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  const clause = platform.ledger
    .list(seed.projectId, 'SpecClause')
    .find((record) => record.state.clauseRef === 'E10/3.2');
  assert.ok(clause, 'the seeded specification carries the E10/3.2 submittal clause');
  clauseId = clause.refId;
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the submittal vertical completes through the gateway', () => {
  it('raises, submits, is returned, resubmits, is approved, and records an order', async () => {
    // Raise (the existing command — the body shape the "Raise a submittal" form sends).
    const raised = await call('POST', `/v1/projects/${project()}/submittals`, 'pm', {
      clauseId,
      kind: 'MATERIAL',
      title: 'Concrete mix design — gateway journey',
      manufacturer: 'Aggregate Industries',
      productReference: 'AI-C3240-XC4-GGBS50',
      claims: [{ requirement: 'Strength class', specified: 'C32/40', offered: 'C32/40', compliant: true }],
      requiredOnSiteBy: '2027-09-01',
      procurementLeadTimeDays: 28,
      reviewPeriodDays: 14,
    });
    assert.equal(raised.status, 201, JSON.stringify(raised.json));
    const submittalId = String(raised.json.submittalId);
    assert.equal(await statusOf(submittalId), 'DRAFT');

    // submit-submittal: the route takes no body (transform: () => ({})).
    const submitted = await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/submit`, 'pm', {});
    assert.equal(submitted.status, 201, JSON.stringify(submitted.json));
    assert.equal(await statusOf(submittalId), 'UNDER_REVIEW');

    // The designer (not the submitter) returns it for revision.
    const returned = await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/review`, 'designer', {
      outcome: 'REVISE_AND_RESUBMIT',
      comments: 'Confirm the GGBS source named in the specification.',
    });
    assert.equal(returned.status, 201, JSON.stringify(returned.json));
    assert.equal(await statusOf(submittalId), 'REVISE_AND_RESUBMIT');

    // resubmit-submittal: the body shape the resubmit form's transform produces.
    const resubmitted = await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/resubmit`, 'pm', {
      manufacturer: 'Aggregate Industries',
      productReference: 'AI-C3240-XC4-GGBS50',
      whatChanged: 'Named the GGBS source the specification requires.',
      claims: [{ requirement: 'Cement type', specified: 'CEM IIIA', offered: 'CEM IIIA, 50% GGBS', compliant: true }],
    });
    assert.equal(resubmitted.status, 201, JSON.stringify(resubmitted.json));
    assert.equal(await statusOf(submittalId), 'DRAFT');

    // Round it out: submit again, approve, and record the order.
    await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/submit`, 'pm', {});
    assert.equal(await statusOf(submittalId), 'UNDER_REVIEW');
    const approved = await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/review`, 'designer', {
      outcome: 'APPROVED',
      comments: '',
    });
    assert.equal(approved.status, 201, JSON.stringify(approved.json));

    // order-submittal: the body shape the order form sends (approved, so not at risk).
    const ordered = await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/ordered`, 'pm', {
      orderReference: 'PO-GATEWAY-0001',
    });
    assert.equal(ordered.status, 201, JSON.stringify(ordered.json));
  });

  it('refuses the submitter approving their own submittal (the two-person check holds through the gateway)', async () => {
    const raised = await call('POST', `/v1/projects/${project()}/submittals`, 'pm', {
      clauseId,
      kind: 'MATERIAL',
      title: 'Self-approval attempt',
      claims: [{ requirement: 'Strength class', specified: 'C32/40', offered: 'C32/40', compliant: true }],
      requiredOnSiteBy: '2027-09-01',
      procurementLeadTimeDays: 28,
      reviewPeriodDays: 14,
    });
    const submittalId = String(raised.json.submittalId);
    await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/submit`, 'pm', {});
    const selfApproved = await call('POST', `/v1/projects/${project()}/submittals/${submittalId}/review`, 'pm', {
      outcome: 'APPROVED',
      comments: '',
    });
    assert.ok(selfApproved.status >= 400, 'the submitter must not be able to approve their own submittal');
  });
});
