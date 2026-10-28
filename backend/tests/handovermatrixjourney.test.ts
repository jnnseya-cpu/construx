import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The H-WF-01 requirements-matrix spine, driven through the real HTTP gateway
 * with the exact request bodies the console's new commands send.
 *
 * The requirements matrix is the spine of the handover stage — readiness is the
 * arithmetic over it — and every route in this chain was complete and tested,
 * but none of it could be *run* from the product: `handover.js` offered no way
 * to record a requirement, assign a deliverable, baseline the matrix, submit
 * against a requirement, decide it, or waive one. This proves the commands
 * added to `handover.js` each post a body their route accepts and that a
 * requirement actually moves through its lifecycle:
 *
 *   record → assign → baseline matrix → submit → decide (accept)
 *
 * with waive proven as the exception path. The bodies below are the ones the
 * command transforms in `handover.js` produce — the `assign`, `submit`, `decide`
 * and `waive` commands put the requirement id in the URL and transform it out of
 * the body, and `decide` reads `forParty` from the selected requirement's own
 * acceptance party rather than having a person retype it.
 *
 * Actors are chosen by capability: the FM holds HANDOVER_OM create, update and
 * approve and runs the whole accept spine; a waiver is an act of project
 * authority (PROJECT_SETUP approve), which the FM does not hold, so the owner
 * waives — exactly the split the two command gates express.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

type Actor = 'fm' | 'owner';

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

/** A date offset from today, as the `date` form fields produce it. */
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** One requirement's materialised state, read through the generic entity route the console sources ids from. */
async function requirement(refId: string): Promise<Record<string, unknown> | undefined> {
  const { json } = await call('GET', `/v1/projects/${project()}/entities/HandoverRequirement`, 'fm');
  const entities = (json.entities as Array<{ refId: string; state: Record<string, unknown> }>) ?? [];
  return entities.find((entry) => entry.refId === refId)?.state;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // The matrix workflow (H-WF-01) is assessed in the HANDOVER phase; the demo
  // project ends in OPERATIONS, so the fixture re-opens the stage exactly as the
  // acceptance journey does. HANDOVER_OM writes are gated to COMMISSIONING,
  // HANDOVER and OPERATIONS, so this phase accepts the whole spine.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Re-opening the handover stage to run the requirements-matrix workflow',
  });

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the requirements-matrix vertical completes through the gateway', () => {
  it('records a requirement, assigns it, baselines the matrix, submits and accepts it', async () => {
    const ACCEPTANCE_PARTY = 'Client estates director';

    // 1. Record the requirement (the `createrequirement` command — no transform,
    //    so this is the collected field body, with the two booleans and the
    //    numeric weight the form sends).
    const created = await call('POST', `/v1/projects/${project()}/handover-requirements`, 'fm', {
      reference: 'REQ-OM-100',
      source: 'Employer information requirements (EIR)',
      sourceVersion: 'Rev C',
      sourceClause: 'Section 4.2',
      description: 'Commissioning certificates for the air-handling plant, witnessed and signed off',
      acceptanceCriteria: 'Every AHU carries a witnessed commissioning certificate referenced to its asset tag',
      evidenceRule: 'The witnessed commissioning record for each AHU, verified against the asset register, not a PDF of it',
      acceptanceParty: ACCEPTANCE_PARTY,
      dependency: 'TEST',
      weight: 10,
      mandatory: true,
      statutory: false,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const requirementId = String(created.json.requirementId);
    assert.ok(requirementId && requirementId !== 'undefined', `a requirement id should come back: ${JSON.stringify(created.json)}`);

    const afterCreate = await requirement(requirementId);
    assert.ok(afterCreate, 'the requirement should be readable through the entity route the console sources ids from');
    assert.equal(afterCreate!.status, 'NOT_STARTED', 'a freshly recorded requirement has not started');

    // 2. Assign the deliverable (the `assignrequirement` command — id in the URL,
    //    transformed out of the body; three distinct people or separation fails).
    const assigned = await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/assign`, 'fm', {
      producer: 'Mechanical commissioning engineer',
      checker: 'Independent commissioning manager',
      approver: 'Project quality lead',
      requiredBy: iso(30),
    });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.json));

    const afterAssign = await requirement(requirementId);
    assert.ok(afterAssign!.assignment, 'the deliverable is now assigned');
    assert.equal(afterAssign!.status, 'DRAFT', 'assigning an unstarted requirement moves it to draft');

    // 3. Baseline the matrix (the `baselinematrix` command). Only the assigned
    //    requirement exists, so the all-rows-assigned rule is satisfied.
    const baselined = await call('POST', `/v1/projects/${project()}/handover-matrices`, 'fm', {
      baselinedBy: 'Client estates director',
    });
    assert.equal(baselined.status, 201, JSON.stringify(baselined.json));
    assert.ok(Number(baselined.json.requirements) >= 1, 'the baseline names the requirements it froze');

    const afterBaseline = await requirement(requirementId);
    assert.equal(afterBaseline!.baselined, true, 'the requirement is now baselined');

    // 4. Submit against it (the `submitrequirement` command — id in the URL,
    //    transformed out of the body).
    const submitted = await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/submit`, 'fm', {
      evidence: 'Witnessed commissioning certificates AHU-01..04, cross-checked against the asset register',
      submittedBy: 'Mechanical commissioning engineer',
    });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.json));

    const afterSubmit = await requirement(requirementId);
    assert.equal(afterSubmit!.status, 'SUBMITTED', 'the requirement is now submitted and awaiting a decision');

    // 5. Decide it (the `deciderequirement` command — accept, with `forParty`
    //    read from the requirement's own acceptance party as the transform does).
    const decided = await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/decide`, 'fm', {
      decision: 'ACCEPTED',
      acceptedBy: 'Client estates director',
      forParty: ACCEPTANCE_PARTY,
      reason: 'Every AHU carries a witnessed certificate verified against the register, meeting the evidence rule',
    });
    assert.equal(decided.status, 201, JSON.stringify(decided.json));
    assert.equal(decided.json.status, 'ACCEPTED');

    const afterDecide = await requirement(requirementId);
    assert.equal(afterDecide!.status, 'ACCEPTED', 'the requirement is now accepted');

    // The accepted mandatory requirement shows up as met in the readiness
    // arithmetic the matrix drives.
    const readiness = await call('GET', `/v1/projects/${project()}/handover-readiness`, 'fm');
    assert.equal(readiness.status, 200, JSON.stringify(readiness.json));
    assert.ok(
      !(readiness.json.unmet as Array<{ reference: string }>).some((entry) => entry.reference === 'REQ-OM-100'),
      'an accepted requirement is not counted as unmet',
    );
  });

  it('waives an ordinary requirement by project authority (the owner, not the FM)', async () => {
    // A second, non-statutory requirement, recorded after the baseline so it does
    // not re-open the all-rows-assigned rule the baseline step depended on.
    const created = await call('POST', `/v1/projects/${project()}/handover-requirements`, 'fm', {
      reference: 'REQ-OM-200',
      source: 'Client fit-out brief',
      sourceVersion: 'Rev A',
      sourceClause: 'Appendix 2',
      description: 'Spare-parts schedule for the tenant kitchenette appliances',
      acceptanceCriteria: 'A spare-parts schedule naming the appliances and their part numbers is provided',
      evidenceRule: 'The spare-parts schedule itself, cross-referenced to the asset register entries it covers',
      acceptanceParty: 'Client facilities manager',
      dependency: 'ASSET_DATA',
      weight: 2,
      mandatory: false,
      statutory: false,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const requirementId = String(created.json.requirementId);

    // The FM holds HANDOVER_OM approve but not PROJECT_SETUP approve, so the FM
    // cannot waive — the command gate on `handover.js` hides it from them.
    const fmRefused = await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/waive`, 'fm', {
      reason: 'Superseded by the manufacturer maintenance contract, which carries the parts obligation instead',
      approvedBy: 'Janet Kirkbride',
      expiresOn: iso(180),
    });
    assert.equal(fmRefused.status, 403, `the FM lacks the project authority to waive: ${JSON.stringify(fmRefused.json)}`);

    // The owner holds every capability in the tenancy, PROJECT_SETUP approve
    // among them, and waives it (the `waiverequirement` command body).
    const waived = await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/waive`, 'owner', {
      reason: 'Superseded by the manufacturer maintenance contract, which carries the parts obligation instead',
      approvedBy: 'Priya Raghunathan',
      expiresOn: iso(180),
    });
    assert.equal(waived.status, 201, JSON.stringify(waived.json));

    const afterWaive = await requirement(requirementId);
    assert.ok(afterWaive!.waiver, 'a live waiver is now recorded against the requirement');
  });

  it('refuses a decision whose stated party is not the acceptance party — the domain rule holds through the gateway', async () => {
    const created = await call('POST', `/v1/projects/${project()}/handover-requirements`, 'fm', {
      reference: 'REQ-OM-300',
      source: 'Building regulations',
      sourceVersion: '2010 (2023 amendments)',
      sourceClause: 'Part B',
      description: 'Fire compartmentation completion certificate',
      acceptanceCriteria: 'A signed fire compartmentation certificate is issued for the whole building',
      evidenceRule: 'The signed fire compartmentation certificate, verified against the as-built fire strategy',
      acceptanceParty: 'Building control body',
      dependency: 'STATUTORY',
      weight: 20,
      mandatory: true,
      statutory: true,
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const requirementId = String(created.json.requirementId);

    await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/assign`, 'fm', {
      producer: 'Fire engineer',
      checker: 'Principal designer',
      approver: 'Project director',
      requiredBy: iso(20),
    });
    await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/submit`, 'fm', {
      evidence: 'Signed fire compartmentation certificate, verified against the as-built fire strategy',
      submittedBy: 'Fire engineer',
    });

    const refused = await call('POST', `/v1/projects/${project()}/handover-requirements/${requirementId}/decide`, 'fm', {
      decision: 'ACCEPTED',
      acceptedBy: 'Site manager',
      forParty: 'Someone other than building control',
      reason: 'The certificate is on file and looks complete to me, so I am closing it out',
    });
    assert.ok(refused.status >= 400, 'a requirement closed by anybody other than its acceptance party must be refused');
  });
});
