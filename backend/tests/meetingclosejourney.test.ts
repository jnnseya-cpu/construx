import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Closing a meeting action, through the real HTTP gateway with the exact body
 * the console's new "Close an action" command sends.
 *
 * Actions could be recorded but never closed from the product — the close route
 * had no console affordance — so the "worst first" open-actions register only
 * ever grew. This drives open a meeting → record an action → issue the minutes
 * → close the action, and asserts the action leaves the open register. It also
 * confirms an action cannot be closed before the minutes are issued, which is
 * why the command offers only actions in an issued set.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

const token = (): string => {
  // CONSTRUCTION_MANAGER holds R/C/U/A on LOOKAHEAD_CONSTRAINTS — open, record,
  // issue and close all sit under that area.
  const auth = seed.users.constructionManager!.auth;
  return issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    enterpriseId: auth.enterpriseId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;
};

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
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

describe('the meeting-action close vertical completes through the gateway', () => {
  const p = () => seed.projectId;
  const openActionRefs = async (): Promise<string[]> => {
    const { json } = await call('GET', `/v1/projects/${p()}/meetings`);
    return (json.openActions as Array<Record<string, unknown>>).map((a) => String(a.reference));
  };

  it('opens a meeting, records and issues an action, then closes it off the register', async () => {
    const meeting = await call('POST', `/v1/projects/${p()}/meetings`, {
      type: 'PROGRESS',
      title: 'Weekly progress — gateway journey',
      heldAt: '2026-10-20',
      location: 'Site office',
      chair: 'A. Okafor',
      attendees: [{ name: 'A. Okafor', organisation: 'JNseya', role: 'PM', attended: true }],
    });
    assert.equal(meeting.status, 201, JSON.stringify(meeting.json));
    const meetingId = String(meeting.json.meetingId);

    // Minute an item so the meeting has something to issue.
    await call('POST', `/v1/projects/${p()}/meetings/${meetingId}/agenda`, {
      subject: 'Structural steel delivery',
      discussion: 'Lead time at risk; action raised to chase the confirmed date.',
    });

    const action = await call('POST', `/v1/projects/${p()}/meetings/${meetingId}/actions`, {
      what: 'Chase the structural steel delivery date.',
      owner: 'R. Sandhu',
      ownerOrganisation: 'JNseya',
      by: '2026-10-27',
    });
    assert.equal(action.status, 201, JSON.stringify(action.json));
    const actionRef = String(action.json.reference);
    assert.ok((await openActionRefs()).includes(actionRef), 'the recorded action is open');

    // A closure note is required — "closed" with nothing beside it is refused.
    const empty = await call('POST', `/v1/projects/${p()}/meetings/${meetingId}/actions/close`, {
      reference: actionRef,
      closureNote: '   ',
    });
    assert.ok(empty.status >= 400, 'a closure with no note is refused');

    // Issuing the minutes does not freeze the action register — the action is
    // still closable afterwards (the deliberate design), which is why the
    // command offers open actions whether or not their minutes are issued.
    const issued = await call('POST', `/v1/projects/${p()}/meetings/${meetingId}/issue`, {});
    assert.equal(issued.status, 201, JSON.stringify(issued.json));

    // close-action: the body the command's transform produces.
    const closed = await call('POST', `/v1/projects/${p()}/meetings/${meetingId}/actions/close`, {
      reference: actionRef,
      closureNote: 'Steel confirmed for 2026-11-03; email filed against the action.',
    });
    assert.equal(closed.status, 201, JSON.stringify(closed.json));
    assert.ok(!(await openActionRefs()).includes(actionRef), 'the closed action has left the open register');
  });
});
