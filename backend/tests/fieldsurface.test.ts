import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import {
  FIELD_MODULES,
  moduleBySlug,
  onFieldSurface,
  webOnlyRefusal,
} from '../src/field/modules.ts';
import { enrolDevice, proofFor, resetDevices } from '../src/identity/devices.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Controls that never belong on a handset.
 *
 * Each field module names a short list — baseline approval, payment
 * certification, adjudication, award, regulatory submission — and the
 * temptation is to gate them on the `?client=` parameter the application
 * already sends. That would be worthless, and `sourceOf` says so itself: the
 * client asserts the value, so a handset reaching for an adjudication screen
 * would simply not send it.
 *
 * So the gate reads the **enrolled device**, which is fixed at enrolment inside
 * an MFA-satisfied session and proved on every request. These tests drive a
 * real bound device over HTTP, because a unit test of the predicate would pass
 * whether or not the gateway ever called it — and the gateway calling it is the
 * whole control.
 *
 * The last test is the important one. It states the limit rather than leaving
 * somebody to assume the gate covers more than it does.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

/** A device of a given class, enrolled and bound to a fresh session. */
function bind(platform_: Platform, actorId: string, tenantId: string, label: string, deviceClass: 'MOBILE' | 'DESKTOP') {
  const enrolled = enrolDevice({ actorId, tenantId, label, platform: deviceClass });
  return enrolled;
}

before(async () => {
  resetDevices();
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  resetDevices();
});

/** Sign a session to a device, so the request can prove which surface it is. */
function sessionOn(deviceClass: 'MOBILE' | 'DESKTOP' | 'NONE') {
  const auth = authOf(platform, seed.users.admin!.id);
  if (deviceClass === 'NONE') {
    const tokens = issueTokens({
      actorId: auth.actorId,
      tenantId: auth.tenantId,
      partyId: auth.partyId,
      roles: auth.roles,
      mfaSatisfied: true,
    });
    return { token: tokens.accessToken, headers: {} as Record<string, string> };
  }

  const enrolled = bind(platform, auth.actorId, auth.tenantId, `${deviceClass} test device`, deviceClass);
  const tokens = issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    partyId: auth.partyId,
    roles: auth.roles,
    mfaSatisfied: true,
    deviceId: enrolled.device.id,
  });
  const claims = JSON.parse(Buffer.from(tokens.accessToken.split('.')[1]!, 'base64url').toString('utf8')) as {
    jti: string;
  };
  return {
    token: tokens.accessToken,
    headers: {
      'x-device-id': enrolled.device.id,
      // `proofFor` is the derivation a real client uses; the server holds only
      // the secret's digest and checks against that.
      'x-device-proof': proofFor(enrolled.deviceSecret, claims.jti),
    },
  };
}

async function post(session: ReturnType<typeof sessionOn>, path: string, payload: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.token}`,
      ...session.headers,
    },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('the module definitions', () => {
  it('covers every stage that runs work in the field, each with its own slug', () => {
    assert.deepEqual(
      Object.values(FIELD_MODULES).map((entry) => entry.slug),
      ['tender', 'construction', 'commissioning', 'handover'],
    );
    // A slug collision would route two modules to one workspace.
    const slugs = Object.values(FIELD_MODULES).map((entry) => entry.slug);
    assert.equal(new Set(slugs).size, slugs.length);
  });

  it('names indicators and web-only controls for every module, from the specification', () => {
    for (const module of Object.values(FIELD_MODULES)) {
      assert.ok(module.indicators.length >= 7, `${module.id} has too few home indicators`);
      assert.ok(module.webOnly.length >= 5, `${module.id} names too few web-only controls`);
      assert.ok(module.phases.length > 0, `${module.id} is open in no lifecycle phase`);
    }
  });

  it('resolves a module from its path slug and nothing else', () => {
    assert.equal(moduleBySlug('commissioning')?.id, 'COMMISSIONING');
    assert.equal(moduleBySlug('COMMISSIONING'), undefined);
    assert.equal(moduleBySlug('finance'), undefined);
  });
});

describe('what counts as a field surface', () => {
  it('reads the enrolled device class, not a self-declared parameter', () => {
    assert.equal(onFieldSurface({ platform: 'MOBILE' }), true);
    assert.equal(onFieldSurface({ platform: 'TABLET' }), true);
    assert.equal(onFieldSurface({ platform: 'DESKTOP' }), false);
    assert.equal(onFieldSurface({ platform: 'BROWSER' }), false);
  });

  it('treats an unidentified session as not a field surface, and says why in the refusal', () => {
    // The honest default. Refusing what cannot be identified would break every
    // ordinary console session on a deployment that does not bind devices.
    assert.equal(onFieldSurface(undefined), false);
    assert.equal(onFieldSurface({}), false);
    assert.equal(onFieldSurface({ platform: 'UNKNOWN' }), false);
  });

  it('tells the person where to do it rather than only that they may not', () => {
    const refusal = webOnlyRefusal('CVR approval');
    assert.match(refusal, /CVR approval/);
    assert.match(refusal, /Open it in the console/);
  });
});

describe('every web-only control the routes declare', () => {
  it('is a control one of the modules actually names', () => {
    const named = new Set(Object.values(FIELD_MODULES).flatMap((entry) => entry.webOnly));
    const declared = ROUTES.filter((route) => route.webOnly).map((route) => route.webOnly!);
    assert.ok(declared.length > 0, 'no route is marked web-only, so the gate protects nothing');
    for (const control of declared) {
      assert.ok(named.has(control), `"${control}" is on a route and in no module's list`);
    }
  });

  it('is a write, because a read of a baseline is not the act being controlled', () => {
    for (const route of ROUTES.filter((entry) => entry.webOnly)) {
      assert.notEqual(route.method, 'GET', `${route.pattern} is a read marked web-only`);
      assert.notEqual(route.readOnly, true, `${route.pattern} changes nothing and is marked web-only`);
    }
  });
});

describe('the gate, over HTTP', () => {
  it('refuses a web-only control on a session bound to a handset', async () => {
    const field = sessionOn('MOBILE');
    const result = await post(field, `/v1/projects/${seed.projectId}/programme/baseline`, {});
    assert.equal(result.status, 403, JSON.stringify(result.body));
    assert.equal(result.body.title, 'WEB_ONLY_CONTROL');
    assert.match(String(result.body.detail), /Baseline edit and approval/);
    assert.match(String(result.body.detail), /Open it in the console/);
  });

  it('refuses before the body is read, so a malformed payload is not the answer given', async () => {
    // The refusal must not depend on the body validating: a handset sending
    // rubbish should be told the surface is wrong, not that field three is
    // missing — otherwise fixing field three looks like the way through.
    const field = sessionOn('MOBILE');
    const result = await post(field, `/v1/projects/${seed.projectId}/tender/adjudicate`, { nonsense: true });
    assert.equal(result.status, 403);
    assert.equal(result.body.title, 'WEB_ONLY_CONTROL');
  });

  it('admits the same control from a desktop, so the gate is about the surface and not the person', async () => {
    const desk = sessionOn('DESKTOP');
    const result = await post(desk, `/v1/projects/${seed.projectId}/programme/baseline`, {});
    // Whatever the domain then says — a validation error, a phase gate, a
    // missing baseline — it is not the surface refusal. That is the assertion.
    assert.notEqual(result.status, 403, JSON.stringify(result.body));
    assert.notEqual(result.body.title, 'WEB_ONLY_CONTROL');
  });

  it('does not touch a control nobody marked web-only', async () => {
    const field = sessionOn('MOBILE');
    const result = await post(field, `/v1/projects/${seed.projectId}/daily-logs`, {});
    assert.notEqual(result.body.title, 'WEB_ONLY_CONTROL');
  });

  /**
   * The limit, stated rather than left to be assumed.
   *
   * A session with no device binding cannot be identified as a field surface,
   * so this gate does not see it. That is a property of
   * `config.auth.requireDeviceBinding`, which is off by default. The test
   * exists so that turning binding on is understood as what closes the gap,
   * rather than somebody later believing the gate covered the estate all along.
   */
  it('cannot see a session that is bound to no device at all', async () => {
    const unbound = sessionOn('NONE');
    const result = await post(unbound, `/v1/projects/${seed.projectId}/programme/baseline`, {});
    assert.notEqual(result.body.title, 'WEB_ONLY_CONTROL');
  });
});
