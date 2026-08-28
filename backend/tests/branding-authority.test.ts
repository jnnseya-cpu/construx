import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Who may decide what a document says about who issued it.
 *
 * `PUT /v1/branding` enforced nothing. Any authenticated identity in a tenancy
 * — a site supervisor, a facilities manager, anybody with a session — could
 * change the name, the mark and the registered legal detail that every document
 * the tenancy produces goes out under. That includes instruments a client, an
 * adjudicator or a regulator reads and acts on.
 *
 * It survived because nothing had a door for it: the console never offered the
 * button, so nobody pressed it, so nothing failed. A capability with no door is
 * not a capability nobody has — it is one nobody is watching.
 *
 * This is here rather than folded into a broader "every route authorises" check
 * because such a check cannot be written honestly: many routes authorise inside
 * the domain function they call, and a static scan for `authorise(` would either
 * miss those or demand a redundant call in every one of them. What can be tested
 * exactly is the behaviour, so that is what is tested.
 *
 * The pairing matters as much as the refusal. A rule that refuses everybody is
 * not a permission model, so both directions are asserted: the enterprise
 * administrator whose job this is may do it, and the project manager may not.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

const tokenFor = (userId: string): string => {
  const user = platform.user(userId);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
};

const identity = (clientName: string) => ({
  clientName,
  primaryColour: '#1d4ed8',
  legalFooter: 'Meridian Infrastructure Group Ltd · registered in England',
  documentReferencePrefix: 'MIGL',
});

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

// Not awaited. `close` waits for keep-alive connections that `fetch` holds
// open, and awaiting it hangs the run — the same shape every other gateway
// test in this suite handles the same way.
after(() => server.close());

describe("the identity a tenancy's documents carry", () => {
  it('refuses an identity that does not administer the tenancy', async () => {
    const response = await fetch(`${base}/v1/branding`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokenFor(seed.users.pm!.id)}`, 'content-type': 'application/json' },
      body: JSON.stringify(identity('Somebody Else Entirely Ltd')),
    });
    // A project manager runs projects. Deciding what the company's documents say
    // about the company is not a project decision.
    assert.equal(response.status, 403);
  });

  it('permits the enterprise administrator, whose job it is', async () => {
    const response = await fetch(`${base}/v1/branding`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tokenFor(seed.users.admin!.id)}`, 'content-type': 'application/json' },
      body: JSON.stringify(identity('Meridian Infrastructure Group Ltd')),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { clientName: string };
    assert.equal(body.clientName, 'Meridian Infrastructure Group Ltd');
  });

  it('survives a restart, because it is in the record rather than in a map', () => {
    // It was a map, and the failure was the same shape as the landing-page
    // pictures: configure a tenancy, redeploy, and every document reverts to
    // BRANDING_NOT_CONFIGURED. A second service reading the same ledger must
    // reach the same answer with nothing handed to it but the chain.
    const restored = new Platform();
    restored.ledger.restore(platform.ledger.events());
    const count = restored.exports.rehydrateBranding();
    assert.ok(count > 0, 'no branding was written to the chain to restore');
    assert.equal(
      restored.exports.branding(seed.tenantId).clientName,
      'Meridian Infrastructure Group Ltd',
    );
  });

  it('refuses a cover image outright when there is nowhere to keep it', async () => {
    // The honest failure, and the one that actually happens. A cover image is
    // held in the content-addressed evidence store, and with no store
    // configured there is nowhere for it to go — so the upload is refused with
    // that reason rather than succeeding into memory and vanishing on the next
    // deploy. That is exactly how the landing-page pictures were lost, and it
    // is not repeated here.
    const response = await fetch(`${base}/v1/branding/cover`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(seed.users.admin!.id)}`, 'content-type': 'image/png' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });
    assert.equal(response.status, 503);
    assert.match(JSON.stringify(await response.json()), /object store/i);
  });

  it('refuses a file that is not an image, read from the bytes rather than the header', async () => {
    // Content-Type says PNG and the bytes do not. The claim is ignored: an SVG
    // renamed to .png is still a document that can carry script, and the check
    // that stops it has to look at what was actually sent. Refused before the
    // store is reached, so this holds whether or not one is configured.
    const response = await fetch(`${base}/v1/branding/cover`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor(seed.users.admin!.id)}`, 'content-type': 'image/png' },
      body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    });
    assert.equal(response.status, 415);
    const problem = (await response.json()) as { title?: string };
    assert.equal(problem.title, 'NOT_AN_IMAGE');
  });
});
