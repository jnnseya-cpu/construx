import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { ROUTES, tenantScoped } from '../src/api/routes.ts';
import { createGateway } from '../src/api/gateway.ts';
import * as invitation from '../src/domain/invitation.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { authOf, seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * What a guest from another organisation can reach.
 *
 * A membership confines somebody invited from another company to the project
 * they were invited onto. That gate reads the project out of the path — so on a
 * route that names no project it checked nothing, and every tenant-scoped read
 * answered a guest in full.
 *
 * This was not a theory. A subcontractor invited onto one project could read
 * the host's opportunity pipeline with client names and values, its entire
 * supplier list with contact names and addresses, its estate forecast and
 * variance, the API keys the tenancy had issued, its people directory and the
 * tenancy's whole change feed. Five routes had been closed one at a time with
 * `externalsRefused` as somebody noticed each; sixty had not, and nothing in
 * the codebase could say which was which.
 *
 * The rule is now inverted and enforced once in the gateway: a tenant-scoped
 * route refuses a guest unless it declares why it is safe. This file is what
 * keeps it that way — the first test fails the moment a route is added without
 * a classification, and the second states what each classification is worth.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base = '';
let guestToken = '';
let guestProjectId = '';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  guestProjectId = seed.projectId;
  const pmCtx = platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
  // VIEWER deliberately: it holds ENTERPRISE_STRUCTURE:R on the matrix, which
  // is what made the people directory and the role register readable. A guest
  // with no capability at all would prove nothing.
  const sent = invitation.inviteToProject(platform, pmCtx, {
    name: 'Olu Adesina',
    email: 'olu@othercompany.example',
    roles: ['VIEWER'],
    external: true,
    organisation: 'Other Company Ltd',
    because: 'Client-side observer for the works described in the enquiry.',
  });
  const userId = invitation.acceptInvitation(platform, pmCtx, { invitationId: sent.invitationId }).userId;
  const guest = authOf(platform, userId);
  assert.equal(platform.user(userId).external, true, 'the fixture must actually be a guest');
  guestToken = issueTokens({
    actorId: guest.actorId,
    tenantId: guest.tenantId,
    partyId: guest.partyId,
    roles: guest.roles,
    mfaSatisfied: true,
  }).accessToken;
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server?.close();
});

async function asGuest(path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(base + path, { headers: { Authorization: `Bearer ${guestToken}` } });
  return { status: response.status, body: await response.text() };
}

describe('a guest from another organisation', () => {
  it('reaches no tenant-scoped read that has not said why it is safe', async () => {
    // Zero unclassified, with no exemption list. A route that answers a guest
    // and carries no `guest` classification is the defect this file exists to
    // prevent, and naming them is the point: a count tells whoever reads the
    // failure nothing about what leaked.
    const reachable: string[] = [];
    for (const route of ROUTES.filter((r) => r.method === 'GET' && tenantScoped(r))) {
      if (route.guest) continue;
      const answer = await asGuest(route.pattern.replace(/:[A-Za-z]+/g, 'x'));
      if (answer.status === 200) reachable.push(route.pattern);
    }
    assert.deepEqual(
      reachable,
      [],
      `${reachable.length} tenant-scoped reads answer a guest from another organisation with no classification ` +
        `saying why that is safe:\n  ${reachable.join('\n  ')}`,
    );
  });

  it('is refused the host organisation’s own business, by name', async () => {
    // One per kind of thing that was open, because a single sample would not
    // show that the rule is general.
    for (const path of [
      '/v1/pipeline', // what the business is bidding for, and for how much
      '/v1/supply-chain', // every supplier, with contact names and addresses
      '/v1/enterprise/command', // the estate's forecast, cost and variance
      '/v1/developer/keys', // the API keys this tenancy has issued
      '/v1/team', // every name, address and role in the business
      '/v1/custom-roles', // the roles the company wrote for itself
      '/v1/ownership', // who signs what, by name
      '/v1/changes', // the tenancy's entire change feed
      '/v1/briefing', // the morning briefing across the whole business
    ]) {
      const answer = await asGuest(path);
      assert.equal(answer.status, 403, `${path} answered a guest ${answer.status}`);
      assert.match(answer.body, /EXTERNAL_MEMBER_SCOPE/, `${path} refused for the wrong reason`);
    }
  });

  it('keeps its own record, the platform’s vocabulary, and its own project', async () => {
    // The classifications are worth something only if they still work.
    for (const path of ['/v1/users/me', '/v1/me/security', '/v1/notifications/inbox']) {
      assert.equal((await asGuest(path)).status, 200, `${path} is the guest's own record and must answer`);
    }
    for (const path of ['/v1/units', '/v1/permissions/matrix', '/v1/lifecycle/gates', '/v1/commands']) {
      assert.equal((await asGuest(path)).status, 200, `${path} is platform vocabulary and must answer`);
    }

    // SCOPED is the only classification that claims a handler filters, so it is
    // the only one worth proving rather than reading.
    const answer = await asGuest('/v1/projects');
    assert.equal(answer.status, 200);
    const projects = (JSON.parse(answer.body) as { projects: Array<{ id: string }> }).projects;
    assert.deepEqual(
      projects.map((project) => project.id),
      [guestProjectId],
      'a guest sees the one project they were invited onto, not the estate',
    );
  });

  it('is told it is a guest, so the console can draw a menu that works', async () => {
    // Without this the console had no way to know, and drew the host's own
    // screens for a subcontractor — seven doors that all answered 403.
    const me = JSON.parse((await asGuest('/v1/users/me')).body) as {
      guest: { external: boolean; homeOrganisation: string | null } | null;
    };
    assert.deepEqual(me.guest, { external: true, homeOrganisation: 'Other Company Ltd' });
  });

  it('marks in the console every screen the gateway will refuse it', async () => {
    // The console's `hostOnly` flag and the gateway's refusal are two
    // statements of one rule, and a screen marked in one and not the other is
    // either a door that errors or a door that should not be there. Read out of
    // the console's own source rather than restated here.
    const console_ = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'frontend', 'app.js'), 'utf8');
    for (const [screen, probe] of [
      ['team', '/v1/team'],
      ['pipeline', '/v1/pipeline'],
      ['portfolio', '/v1/enterprise/command'],
      ['developer', '/v1/developer/keys'],
    ] as const) {
      const entry = new RegExp(`\\{ id: '${screen}',[^}]*\\}`).exec(console_)?.[0] ?? '';
      assert.ok(entry, `no nav entry for ${screen}`);
      assert.match(entry, /hostOnly: true/, `the ${screen} screen is not marked hostOnly`);
      assert.equal((await asGuest(probe)).status, 403, `${probe} answers a guest, so ${screen} should not be hidden`);
    }
  });

  it('still reaches the project it was invited onto', async () => {
    // The refusal must not have taken the guest's actual work with it.
    assert.equal((await asGuest(`/v1/projects/${guestProjectId}/programme`)).status, 200);
  });
});
