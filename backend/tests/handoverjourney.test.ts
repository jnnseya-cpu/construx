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
 * The H-WF-09 handover acceptance spine, driven through the real HTTP gateway
 * with the exact request bodies the console's new commands send.
 *
 * Every engine and route in this chain was already complete and tested, but
 * none of it could be *run* from the product — `handover.js` rendered twenty
 * read-only panels and printed the "permitted next command" as a sentence with
 * no button behind it. The register could reach the operating position and go
 * no further: a pack could not be compiled, decided, activated, baselined or
 * its residuals transferred.
 *
 * This proves the six commands added to `handover.js` each post a body their
 * route accepts and that the handover actually moves:
 *
 *   compile pack → decide → activate operations → freeze baseline
 *                → transfer residuals
 *
 * i.e. the vertical works end to end, not just that the buttons exist. The
 * bodies below are the ones the command transforms in `handover.js` produce.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

const tokenFor = (who: 'fm'): string => {
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
  who: 'fm',
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

/** The acceptance position, which the console reads to gate and re-read each command. */
async function position(): Promise<Record<string, unknown>> {
  const { json } = await call('GET', `/v1/projects/${project()}/handover-acceptance`, 'fm');
  return json;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // The demo project runs the whole lifecycle and lands in OPERATIONS, having
  // already accepted handover through the older `engines/handover` path. The
  // acceptance *workflow* (H-WF-09) is assessed in the HANDOVER phase, so the
  // fixture puts it back there — exactly as `handoveracceptance.test.ts` does.
  // Because the seed's own `acceptHandover` succeeded, the eight-domain
  // validation on this project passes, which is what lets a fresh pack be
  // accepted cleanly.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Re-opening the handover stage to run the acceptance workflow',
  });

  // Compiling a pack reaches the local deterministic AI engine (AI_MODE=local),
  // which opens no socket but still charges the wallet. The lifecycle seed
  // spends against the same wallet, so the fixture tops it up to guarantee the
  // compile step is affordable rather than depending on a residual balance.
  try {
    platform.creditFromPayment({
      tenantId: seed.users.fm!.auth.tenantId,
      amountMinor: 500_000_00,
      method: 'BANK_TRANSFER',
      reference: `HANDOVER-JOURNEY-TOPUP-${Date.now()}`,
      recordedBy: 'handover-journey-test',
      note: 'Top-up so the handover-pack compile step is affordable in the gateway journey',
    });
  } catch {
    // If the wallet cannot be topped up (subscription gate), the existing
    // balance is used; the compile step asserts its own success below.
  }

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the handover acceptance vertical completes through the gateway', () => {
  it('compiles a pack, decides it with a condition, activates operations, baselines and transfers residuals', async () => {
    // 1. Compile the handover pack (the `compilepack` command — Engine G, AI).
    const compiled = await call('POST', `/v1/projects/${project()}/handover/pack`, 'fm', {
      receivingPartyName: 'Meridian Infrastructure Group',
      receivingPartyId: 'org-client-estates',
    });
    assert.equal(compiled.status, 201, JSON.stringify(compiled.json));
    const packId = String(compiled.json.packId);
    assert.ok(packId && packId !== 'undefined', `a pack id should come back: ${JSON.stringify(compiled.json)}`);

    // The pack is present and undecided in the acceptance position the console reads.
    const afterCompile = await position();
    const compiledPack = (afterCompile.packs as Array<Record<string, unknown>>).find((p) => p.packId === packId);
    assert.ok(compiledPack, 'the compiled pack should appear in the acceptance position');
    assert.equal(compiledPack.decision, undefined, 'a freshly compiled pack carries no decision');

    // 2. Decide it (the `decidehandover` command — accept with one condition, so
    //    there is a residual obligation to transfer at the end of the spine).
    //    This is exactly the body the command's transform assembles.
    const decided = await call('POST', `/v1/projects/${project()}/handover-packs/${packId}/decide`, 'fm', {
      decision: 'ACCEPTED_WITH_CONDITIONS',
      decidedBy: 'Client estates director',
      forOrganisation: 'Meridian Infrastructure Group',
      reasons: 'All eight domains reported ready and the pack reflects the accepted record',
      conditions: [
        {
          description: 'The landscaping irrigation controller is to be commissioned before the first growing season',
          riskOwner: 'Main contractor project manager',
          dueDate: iso(60),
          expiresOn: iso(120),
          escalateTo: 'Commercial director',
        },
      ],
    });
    assert.equal(decided.status, 201, JSON.stringify(decided.json));
    assert.equal(decided.json.decision, 'ACCEPTED_WITH_CONDITIONS');

    const afterDecide = await position();
    const decidedPack = (afterDecide.packs as Array<Record<string, unknown>>).find((p) => p.packId === packId);
    assert.equal(decidedPack!.decision, 'ACCEPTED_WITH_CONDITIONS', 'the pack is now decided');
    assert.ok(
      (afterDecide.residual as unknown[]).length > 0,
      'the acceptance condition should surface immediately as a residual obligation',
    );

    // 3. Activate operations (the `activateoperations` command — who and when only).
    const activated = await call('POST', `/v1/projects/${project()}/handover-packs/${packId}/activate-operations`, 'fm', {
      activatedBy: 'Client asset manager',
      maintenanceStartsOn: iso(1),
    });
    assert.equal(activated.status, 201, JSON.stringify(activated.json));
    assert.ok(Number(activated.json.assets) > 0, 'operations activate against the accepted register');

    const afterActivate = await position();
    assert.ok(afterActivate.activation, 'the activation is now recorded in the position');
    assert.ok(Number((afterActivate.activation as Record<string, unknown>).assets) > 0);

    // 4. Freeze the handover baseline (the `baselinehandover` command).
    const baselined = await call('POST', `/v1/projects/${project()}/handover-baseline`, 'fm', {
      baselinedBy: 'Client estates director',
      retentionPolicy: 'Retained for the life of the asset plus twelve years under the group records policy',
      retainUntil: iso(365 * 30),
      legalHold: false,
    });
    assert.equal(baselined.status, 201, JSON.stringify(baselined.json));
    assert.ok(Number(baselined.json.entries) > 0, 'the frozen set names the records it holds');

    const afterBaseline = await position();
    assert.ok(afterBaseline.baseline, 'the baseline is now recorded in the position');

    // 5. Transfer the residual obligations (the `transferresiduals` command).
    const transferred = await call('POST', `/v1/projects/${project()}/residual-obligations/transfer`, 'fm', {
      toOperations: 'Estates manager',
      toAftercare: 'Main contractor aftercare lead',
      note: 'Handing the outstanding items to their operations and aftercare owners',
    });
    assert.equal(transferred.status, 201, JSON.stringify(transferred.json));
    assert.ok(Number(transferred.json.transferred) >= 1, 'at least the acceptance condition transfers');

    const afterTransfer = await position();
    assert.equal(afterTransfer.transferred, true, 'the position now reports the residuals transferred');
  });

  it('refuses a decision with no stated reasons — the domain rule holds through the gateway', async () => {
    const compiled = await call('POST', `/v1/projects/${project()}/handover/pack`, 'fm', {
      receivingPartyName: 'Meridian Infrastructure Group',
      receivingPartyId: 'org-client-estates',
    });
    assert.equal(compiled.status, 201, JSON.stringify(compiled.json));
    const packId = String(compiled.json.packId);

    const refused = await call('POST', `/v1/projects/${project()}/handover-packs/${packId}/decide`, 'fm', {
      decision: 'ACCEPTED',
      decidedBy: 'Client estates director',
      forOrganisation: 'Meridian Infrastructure Group',
      reasons: 'Fine',
    });
    assert.ok(refused.status >= 400, 'a decision with no stated basis must be refused');
  });
});
