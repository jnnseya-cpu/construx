import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { bareConstructionProject } from './helpers.ts';
import * as commissioningclose from '../src/domain/commissioningclose.ts';
import * as systemisation from '../src/domain/systemisation.ts';

/**
 * Commissioning dossier compilation, driven through the real HTTP gateway with
 * the exact request body the console's new command sends.
 *
 * The `accept-system` command was already on Construction and already
 * dead-ended with NO_DOSSIER, because there was no door to compile a dossier.
 * The compile-dossier command added to `construction.js` is that door. This
 * proves it posts a body the route accepts, that acceptance is refused until it
 * exists, and that once a complete dossier is compiled the existing
 * accept-system command succeeds — i.e. the dead end is actually removed.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let projectId: string;

const tokenFor = (who: 'qaqc'): string => {
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
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor('qaqc')}`, 'content-type': 'application/json' },
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

// The body the compile-dossier transform emits for a full dossier: one entry
// per required record, each resolved to a controlled reference and revision.
const FULL_ENTRIES = commissioningclose.DOSSIER_RECORD.map((record) => ({
  key: record.key,
  reference: `DOC-${record.key}`,
  revision: 'C',
  evidenceRef: `EV-${record.key}`,
}));

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  ({ projectId } = await bareConstructionProject(platform, seed, 'Dossier gateway fixture'));

  // A defined system to compile a dossier for — QUALITY_COMMISSIONING C, the
  // same authority the compile route takes, writable in construction.
  const qaqcCtx = platform.context(seed.users.qaqc!.auth, projectId, { source: 'WEB' });
  // A system sits under a facility, so the facility is defined first.
  systemisation.defineSystem(qaqcCtx, {
    tag: 'FAC-01',
    level: 'FACILITY',
    name: 'Riverside Facility',
    boundary: 'The whole demised premises within the site boundary, excluding incoming utility connections.',
  });
  systemisation.defineSystem(qaqcCtx, {
    tag: 'MEC-VENT',
    level: 'SYSTEM',
    parentTag: 'FAC-01',
    name: 'Ventilation',
    boundary: 'All supply and extract air handling from intake louvre to terminal device.',
    assetTags: ['AHU-01'],
  });

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the commissioning dossier vertical completes through the gateway', () => {
  it('refuses acceptance of a system with no dossier compiled', async () => {
    const premature = await call('POST', `/v1/projects/${projectId}/system-acceptances`, {
      systemTag: 'MEC-VENT',
      decision: 'ACCEPTED',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Trying to accept before the dossier exists.',
    });
    assert.ok(premature.status >= 400, 'acceptance must be refused with no dossier');
    assert.equal(premature.json.title, 'NO_DOSSIER', JSON.stringify(premature.json));
  });

  it('compiles the dossier and then lets accept-system succeed', async () => {
    // compile-dossier: the exact body the transform produces from the textarea.
    const compiled = await call('POST', `/v1/projects/${projectId}/commissioning-dossiers`, {
      systemTag: 'MEC-VENT',
      compiledBy: 'S. Kaur',
      entries: FULL_ENTRIES,
    });
    assert.equal(compiled.status, 201, JSON.stringify(compiled.json));
    assert.equal(compiled.json.completenessPercent, 100);
    assert.deepEqual(compiled.json.missing, []);

    // The dead end is gone: accept-system, unchanged, now succeeds.
    const accepted = await call('POST', `/v1/projects/${projectId}/system-acceptances`, {
      systemTag: 'MEC-VENT',
      decision: 'ACCEPTED',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Ventilation accepted with the dossier complete.',
    });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));
    assert.equal(accepted.json.decision, 'ACCEPTED');
  });

  it('refuses acceptance while the dossier is missing a record an operator cannot start without', async () => {
    systemisation.defineSystem(platform.context(seed.users.qaqc!.auth, projectId, { source: 'WEB' }), {
      tag: 'ELE-LV',
      level: 'SYSTEM',
      parentTag: 'FAC-01',
      name: 'LV distribution',
      boundary: 'From the incoming LV panel to every final distribution board.',
      assetTags: ['DB-01'],
    });

    // A dossier missing a critical record — the O&M manual — compiles, but
    // acceptance over it is refused.
    const partial = await call('POST', `/v1/projects/${projectId}/commissioning-dossiers`, {
      systemTag: 'ELE-LV',
      compiledBy: 'S. Kaur',
      entries: FULL_ENTRIES.filter((entry) => entry.key !== 'OM_MANUAL'),
    });
    assert.equal(partial.status, 201, JSON.stringify(partial.json));
    assert.ok((partial.json.completenessPercent as number) < 100);
    assert.deepEqual(partial.json.missing, ['OM_MANUAL']);

    const refused = await call('POST', `/v1/projects/${projectId}/system-acceptances`, {
      systemTag: 'ELE-LV',
      decision: 'ACCEPTED',
      acknowledgedBy: 'K. Mensah',
      acknowledgedForOrganisation: 'Riverside Estates',
      note: 'Trying to accept over an incomplete dossier.',
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.json));
    assert.equal(refused.json.title, 'DOSSIER_INCOMPLETE');
  });
});
