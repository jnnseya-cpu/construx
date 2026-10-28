import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Inviting somebody onto a project and accepting it, through the real gateway.
 *
 * The invite worked and emailed the invitee "you can sign in once this is
 * accepted" — but no console screen ever called the accept route, and the
 * invitee has no identity to sign in and accept it themselves, so every
 * invitation dead-ended PENDING until it lapsed. The accept/decline buttons
 * added to team.js are host-side (a project member resolves it), and the domain
 * now guards both the way invite and withdraw are guarded. This proves the
 * happy path creates the identity and goes live, and that a member who does not
 * work on the project is refused.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

const tokenFor = (who: string): string => {
  const auth = seed.users[who]!.auth;
  return issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    enterpriseId: auth.enterpriseId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;
};

// A real user carrying only a read role — to prove the acceptance guard refuses
// anyone who does not actually work on the project.
const viewerTokenFor = (who: string): string => {
  const auth = seed.users[who]!.auth;
  return issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    enterpriseId: auth.enterpriseId,
    roles: ['VIEWER'],
    mfaSatisfied: true,
  }).accessToken;
};

async function call(method: string, path: string, who: string, body?: unknown) {
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

describe('the project-invitation vertical completes through the gateway', () => {
  const project = () => seed.projectId;
  const invitee = `journey.invitee.${Date.now()}@example.test`;

  it('invites, then accepts host-side, creating an identity that can then be seen', async () => {
    const invited = await call('POST', `/v1/projects/${project()}/invitations`, 'pm', {
      name: 'Journey Invitee',
      email: invitee,
      roles: ['SUPERVISOR'],
      external: false,
      because: 'Needed on site for the journey test fixture.',
    });
    assert.equal(invited.status, 201, JSON.stringify(invited.json));
    const invitationId = String(invited.json.invitationId);

    // Before acceptance the identity does not exist.
    assert.equal(
      platform.users(seed.users.pm!.auth.tenantId).some((u) => u.email.toLowerCase() === invitee.toLowerCase()),
      false,
      'no identity exists until the invitation is accepted',
    );

    // Accept host-side — the button sends no body (transform: () => ({})).
    const accepted = await call(
      'POST',
      `/v1/projects/${project()}/invitations/${invitationId}/accept`,
      'pm',
      {},
    );
    assert.equal(accepted.status, 201, JSON.stringify(accepted.json));

    // The identity now exists and can begin a sign-in (it is a real user).
    const created = platform
      .users(seed.users.pm!.auth.tenantId)
      .find((u) => u.email.toLowerCase() === invitee.toLowerCase());
    assert.ok(created, 'acceptance created the invitee identity');
  });

  it('refuses acceptance by a member who does not work on the project', async () => {
    const invited = await call('POST', `/v1/projects/${project()}/invitations`, 'pm', {
      name: 'Second Invitee',
      email: `journey.invitee2.${Date.now()}@example.test`,
      roles: ['SUPERVISOR'],
      external: false,
      because: 'A second fixture for the authz check.',
    });
    const invitationId = String(invited.json.invitationId);
    // A VIEWER can read the project but delivers no part of it, so it must not
    // be able to mint an identity by accepting an invitation.
    const res = await fetch(`${base}/v1/projects/${project()}/invitations/${invitationId}/accept`, {
      method: 'POST',
      headers: { authorization: `Bearer ${viewerTokenFor('qs')}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
    // And the invitation is still pending for a proper host to accept.
    const stillPending = await call('POST', `/v1/projects/${project()}/invitations/${invitationId}/accept`, 'pm', {});
    assert.equal(stillPending.status, 201, JSON.stringify(stillPending.json));
  });
});
