import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { bareConstructionProject } from './helpers.ts';
import * as planning from '../src/engines/planning.ts';

/**
 * CN-WF-04 progress claim and verification, driven through the real HTTP
 * gateway with the exact request bodies the console's new commands send.
 *
 * The backend measure/claim/verify flow was already complete and tested, but
 * the "Progress verification" card on Construction only ever *read* the
 * register — there was no door to set a measurement basis, make a claim, or
 * certify one. This proves the three commands added to `construction.js` post a
 * body each route accepts, that a claim moves through to an accepted figure
 * that writes the task's percentage, that the submitted quantity survives an
 * adjustment unchanged, and that the two-person rule holds through the gateway:
 * the person who claimed the progress cannot certify it.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let projectId: string;
let taskA: string;
let taskB: string;
let taskSelf: string;

type Who = 'pm' | 'siteManager';

const tokenFor = (who: Who): string => {
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
  who: Who,
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

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const activitiesFrom = async (): Promise<Array<Record<string, unknown>>> => {
  const { json } = await call('GET', `/v1/projects/${projectId}/progress-verification`, 'pm');
  return (json.activities as Array<Record<string, unknown>>) ?? [];
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  ({ projectId } = await bareConstructionProject(platform, seed, 'Progress gateway fixture'));

  // A work package and the activities to measure against it — the fixture the
  // claims are made on, created the same way the programme engine makes them.
  const pmCtx = platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' });
  const { workPackageId } = planning.createWorkPackage(pmCtx, {
    wbsCode: 'PJ-001',
    title: 'Bulk earthworks',
    indicativeDurationDays: 40,
  });
  [taskA, taskB, taskSelf] = planning.createTasks(pmCtx, [
    { activityCode: 'PJ-A', name: 'Excavate the inlet works', workPackageId, durationDays: 10 },
    { activityCode: 'PJ-B', name: 'Place blinding to the base slab', workPackageId, durationDays: 8 },
    { activityCode: 'PJ-S', name: 'Backfill behind the headwall', workPackageId, durationDays: 6 },
  ]) as [string, string, string];

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the progress vertical completes through the gateway', () => {
  it('sets a basis, claims, accepts, and writes the activity percentage', async () => {
    // set-measurement-basis: taskId travels in the path, body is the four
    // fields the transform emits.
    const basis = await call('POST', `/v1/projects/${projectId}/tasks/${taskA}/measurement-basis`, 'pm', {
      unit: 'm3',
      controlTotal: 500,
      measurementRule: 'Net excavated volume to design formation, from the survey model.',
      source: 'C-2101 rev P05, bill item 2.4.1',
    });
    assert.equal(basis.status, 201, JSON.stringify(basis.json));

    // submit-progress-claim: the site manager (FIELD_EXECUTION C) claims. The
    // unit is the basis unit the transform looked up; taskId is not in the body.
    const claim = await call('POST', `/v1/projects/${projectId}/tasks/${taskA}/progress-claims`, 'siteManager', {
      quantity: 120,
      unit: 'm3',
      location: 'Grid A4, pour 1',
      periodFrom: day(-7),
      periodTo: day(-1),
      rework: false,
      evidenceDescription: 'Survey pick-up, sheet 4',
      evidenceHash: 'pj-evidence-0001',
    });
    assert.equal(claim.status, 201, JSON.stringify(claim.json));
    const submissionId = String(claim.json.submissionId);

    // It is awaiting a verifier, read through the position the card renders.
    const before = await activitiesFrom();
    const rowBefore = before.find((a) => a.taskId === taskA)!;
    assert.equal(rowBefore.awaitingVerification, 1);
    assert.equal(rowBefore.accepted, 0);

    // verify-claim: the PM (FIELD_EXECUTION A), a different person, certifies.
    const verified = await call('POST', `/v1/projects/${projectId}/progress-claims/${submissionId}/verify`, 'pm', {
      decision: 'ACCEPTED',
      rationale: 'Checked against the survey pick-up; the pour matches the claim.',
    });
    assert.equal(verified.status, 201, JSON.stringify(verified.json));
    assert.equal(verified.json.acceptedQuantity, 120);
    assert.equal(verified.json.submittedQuantity, 120);

    // The accepted figure moved the activity: 120 of 500 is 24%.
    const after = await activitiesFrom();
    const rowAfter = after.find((a) => a.taskId === taskA)!;
    assert.equal(rowAfter.accepted, 120);
    assert.equal(rowAfter.percentComplete, 24);
    assert.equal(rowAfter.awaitingVerification, 0);
  });

  it('keeps the submitted quantity when a claim is adjusted down', async () => {
    await call('POST', `/v1/projects/${projectId}/tasks/${taskB}/measurement-basis`, 'pm', {
      unit: 'm2',
      controlTotal: 300,
      measurementRule: 'Blinded area to the slab edge, measured off the setting-out drawing.',
      source: 'C-2110 rev P02',
    });
    const claim = await call('POST', `/v1/projects/${projectId}/tasks/${taskB}/progress-claims`, 'siteManager', {
      quantity: 200,
      unit: 'm2',
      location: 'Base slab, bay 2',
      periodFrom: day(-5),
      periodTo: day(-2),
      rework: false,
      evidenceDescription: 'Photographs of the blinded bay',
      evidenceHash: 'pj-evidence-0002',
    });
    const submissionId = String(claim.json.submissionId);

    // ADJUSTED carries the accepted quantity and the evidence the verifier saw.
    const adjusted = await call('POST', `/v1/projects/${projectId}/progress-claims/${submissionId}/verify`, 'pm', {
      decision: 'ADJUSTED',
      acceptedQuantity: 180,
      rationale: 'The eastern 20m2 had not been blinded when measured.',
      evidenceDescription: 'Site measure, 180m2 blinded',
      evidenceHash: 'pj-evidence-0002-verify',
    });
    assert.equal(adjusted.status, 201, JSON.stringify(adjusted.json));
    // AC-CN-WF-04-01: the gap between claimed and accepted is the finding, and
    // the claim is not overwritten.
    assert.equal(adjusted.json.submittedQuantity, 200);
    assert.equal(adjusted.json.acceptedQuantity, 180);

    const row = (await activitiesFrom()).find((a) => a.taskId === taskB)!;
    assert.equal(row.submitted, 200);
    assert.equal(row.accepted, 180);
  });

  it('refuses the submitter certifying their own claim (the two-person check holds)', async () => {
    await call('POST', `/v1/projects/${projectId}/tasks/${taskSelf}/measurement-basis`, 'pm', {
      unit: 'm3',
      controlTotal: 100,
      measurementRule: 'Compacted fill behind the headwall.',
      source: 'C-2130 rev P01',
    });
    // The PM holds both C and A, so the PM can both claim and attempt to verify
    // — which is exactly the case the self-verification bar exists for.
    const claim = await call('POST', `/v1/projects/${projectId}/tasks/${taskSelf}/progress-claims`, 'pm', {
      quantity: 40,
      unit: 'm3',
      location: 'Headwall, lift 1',
      periodFrom: day(-3),
      periodTo: day(-1),
      rework: false,
      evidenceDescription: 'Compaction test results',
      evidenceHash: 'pj-evidence-0003',
    });
    const submissionId = String(claim.json.submissionId);

    const self = await call('POST', `/v1/projects/${projectId}/progress-claims/${submissionId}/verify`, 'pm', {
      decision: 'ACCEPTED',
      rationale: 'Attempting to certify my own claim.',
    });
    assert.ok(self.status >= 400, 'the submitter must not be able to certify their own claim');
    assert.equal(self.json.title, 'SELF_VERIFICATION_REFUSED', JSON.stringify(self.json));
  });
});
