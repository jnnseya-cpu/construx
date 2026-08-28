import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import {
  grantableScopes,
  isSandboxTenant,
  issueKey,
  keyRegister,
  MAX_KEY_DAYS,
  rehydrateKeys,
  resetKeys,
  resolveKey,
  revokeKey,
  sandboxTenantOf,
} from '../src/developer/keys.ts';
import {
  assertDeliverableUrl,
  attempt,
  backoffSeconds,
  enqueue,
  envelope,
  matching,
  recordDelivery,
  sign,
  subscribe,
  subscriptionRegister,
  unsubscribe,
  verifySignature,
  webhookPosition,
  FAILURES_BEFORE_DISABLE,
  MAX_ATTEMPTS,
  type Delivery,
  type Subscription,
} from '../src/developer/webhooks.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The developer surface: a credential that is not a person, and a way to be
 * told what happened.
 *
 * Two things here are worth more than the happy paths.
 *
 * **A key is never wider than the person who issued it.** Every API key model
 * that gets breached badly got that wrong: a key created by somebody with
 * limited authority that nonetheless carries the platform's. It is enforced by
 * intersecting against the creator's live scopes, refused by name rather than
 * silently trimmed, and `admin:*` is refused for everybody including an
 * operator who holds it.
 *
 * **A webhook endpoint is an outbound request to an address a customer chose.**
 * That is a server-side request forgery primitive handed to whoever can create a
 * subscription, unless it is constrained — so https only, no credentials in the
 * URL, and nothing that resolves inside the deployment.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let port = 0;

before(async () => {
  resetKeys();
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(() => server.close());

const as = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

describe('a key is never wider than the person who issued it', () => {
  /**
   * An enterprise administrator whose scopes have been narrowed.
   *
   * Governance authority and scope breadth are two different things, and the
   * governance check fires first — so testing the scope intersection needs
   * somebody who passes the first gate and fails the second. Narrowing the
   * scopes on the auth context is exactly what a scoped token does, which is
   * also what this feature exists to produce.
   */
  const narrowedAdmin = (scopes: string[]) =>
    platform.context({ ...seed.users.admin!.auth, scopes }, seed.projectId);

  it('refuses a scope the creator does not hold, by name', () => {
    // Silently trimming would produce a key that half works and a support call
    // nobody can answer.
    const refusal = throwsCode(
      () =>
        // Holds the governance scope the authorisation needs, and not the one
        // the key asks for. That separation is the point: passing the first
        // gate must not imply passing the second.
        issueKey(narrowedAdmin(['projects:read', 'projects:write']), {
          name: 'Progress integration',
          mode: 'LIVE',
          scopes: ['commercial:write'],
        }),
      'API_KEY_SCOPE_EXCEEDS_CREATOR',
    );
    assert.match(refusal.message ?? '', /commercial:write/);
  });

  it('refuses admin:* even from somebody holding it', () => {
    // There is no integration whose correct answer is "everything", and a
    // credential that can do anything is the one that ends up in a public
    // repository. Refused before the intersection, so holding admin:* does not
    // let it through as "a scope the creator holds".
    throwsCode(
      () => issueKey(narrowedAdmin(['admin:*']), { name: 'Ops integration', mode: 'LIVE', scopes: ['admin:*'] }),
      'API_KEY_SCOPE_FORBIDDEN',
    );
  });

  it('does not let admin:* smuggle a wider key through the intersection', () => {
    // A creator holding admin:* passes the intersection for anything. That is
    // correct — they genuinely hold it — and it is worth pinning, because the
    // guard above is the only thing between that and a key that can do
    // everything.
    const { key } = issueKey(narrowedAdmin(['admin:*']), {
      name: 'Broad but bounded',
      mode: 'LIVE',
      scopes: ['commercial:read'],
    });
    assert.deepEqual(key.scopes, ['commercial:read']);
    assert.equal(key.scopes.includes('admin:*'), false);
  });

  it('refuses a key from somebody without governance over the enterprise', () => {
    // Handing out a credential that acts on this tenancy's record is a decision
    // about the enterprise, not an ordinary write.
    throwsCode(
      () => issueKey(as('pm'), { name: 'Site integration', mode: 'LIVE', scopes: ['field:read'] }),
      'ACCESS_DENIED',
    );
  });

  it('issues one the creator does hold, and carries exactly those scopes', () => {
    const { key } = issueKey(as('admin'), {
      name: 'Programme sync',
      mode: 'LIVE',
      scopes: ['projects:read'],
    });
    assert.deepEqual(key.scopes, ['projects:read']);
    assert.equal(key.mode, 'LIVE');
    assert.equal(key.tenantId, seed.tenantId);
  });

  it('publishes what a role could grant, so a screen offers real choices', () => {
    const scopes = grantableScopes(['QS']);
    assert.ok(scopes.length > 0);
    assert.equal(scopes.includes('admin:*'), false, 'admin:* is offered as a choice');
  });
});

describe('the secret is shown once and never stored', () => {
  it('returns a secret that does not appear in the record', () => {
    const { key, secret } = issueKey(as('admin'), {
      name: 'Evidence uploader',
      mode: 'LIVE',
      scopes: ['audit:read'],
    });

    assert.match(secret, /^ck_live_[0-9a-f]{12}\./);
    // A leaked database is not a leaked key.
    assert.equal(key.secretHash.length, 64);
    assert.equal(key.secretHash.includes(secret), false);

    const stored = platform.ledger.get({ refType: 'ApiKey', refId: key.id })!;
    assert.equal(JSON.stringify(stored.state).includes(secret), false, 'the secret reached the ledger');
  });

  it('withholds the digest from every read, so a register cannot be brute-forced offline', () => {
    const register = keyRegister(as('admin'));
    assert.ok(register.length > 0);
    for (const entry of register) {
      assert.equal('secretHash' in entry, false, 'the register publishes the digest');
    }
  });

  it('refuses an unnamed key and one with no scopes', () => {
    throwsCode(() => issueKey(as('admin'), { name: 'x', mode: 'LIVE', scopes: ['audit:read'] }), 'API_KEY_NAME_REQUIRED');
    throwsCode(() => issueKey(as('admin'), { name: 'Nameless', mode: 'LIVE', scopes: [] }), 'API_KEY_SCOPES_REQUIRED');
  });

  it('refuses an open-ended key', () => {
    throwsCode(
      () => issueKey(as('admin'), { name: 'Forever', mode: 'LIVE', scopes: ['audit:read'], expiresInDays: MAX_KEY_DAYS + 1 }),
      'API_KEY_EXPIRY_INVALID',
    );
  });
});

describe('sandbox is a tenancy, not a flag', () => {
  it('puts a sandbox key in a different tenancy from the live one', () => {
    // A flag is a filter, and every filter is one forgotten `if` away from a
    // sandbox integration writing into a live payment cycle. A separate tenancy
    // is enforced by the isolation already applied to every read and write.
    const live = issueKey(as('admin'), { name: 'Live sync', mode: 'LIVE', scopes: ['projects:read'] });
    const sandbox = issueKey(as('admin'), { name: 'Sandbox sync', mode: 'SANDBOX', scopes: ['projects:read'] });

    assert.equal(live.key.tenantId, seed.tenantId);
    assert.equal(sandbox.key.tenantId, sandboxTenantOf(seed.tenantId));
    assert.notEqual(sandbox.key.tenantId, live.key.tenantId);

    // And it is traceable back to the customer that owns it.
    assert.equal(sandbox.key.ownerTenantId, seed.tenantId);
    assert.equal(isSandboxTenant(sandbox.key.tenantId), true);
    assert.equal(isSandboxTenant(live.key.tenantId), false);
  });

  it('resolves a sandbox key to the sandbox tenancy, so every downstream read is scoped to it', () => {
    const { secret } = issueKey(as('admin'), { name: 'Sandbox reader', mode: 'SANDBOX', scopes: ['projects:read'] });
    const identity = resolveKey(secret)!;
    assert.ok(identity);
    assert.equal(identity.tenantId, sandboxTenantOf(seed.tenantId));
    assert.match(secret, /^ck_test_/);
  });
});

describe('resolving a presented key', () => {
  it('resolves a live one to a usable identity', () => {
    const { key, secret } = issueKey(as('admin'), { name: 'Reader', mode: 'LIVE', scopes: ['projects:read'] });
    const identity = resolveKey(secret)!;

    assert.equal(identity.actorId, seed.users.admin!.id);
    assert.deepEqual(identity.scopes, ['projects:read']);
    // The key's own id, so "revoke the key that did this" is a possible
    // instruction rather than a guess at which person it was.
    assert.equal(identity.tokenId, key.id);
    // A credential in a config file is not a person performing a ceremony.
    assert.equal(identity.mfaSatisfied, false);
  });

  it('refuses a revoked key immediately, not on the next reload', () => {
    const { key, secret } = issueKey(as('admin'), { name: 'Doomed', mode: 'LIVE', scopes: ['projects:read'] });
    assert.ok(resolveKey(secret));

    revokeKey(as('admin'), { keyId: key.id, reason: 'Rotated' });
    assert.equal(resolveKey(secret), undefined);
  });

  it('refuses an expired key', () => {
    const { secret } = issueKey(as('admin'), { name: 'Short lived', mode: 'LIVE', scopes: ['projects:read'], expiresInDays: 1 });
    assert.ok(resolveKey(secret));
    assert.equal(resolveKey(secret, Date.now() + 2 * 86_400_000), undefined);
  });

  it('gives one answer for unknown, revoked and expired', () => {
    // Three different answers would let somebody enumerate which keys exist.
    assert.equal(resolveKey('ck_live_aaaaaaaaaaaa.nonsense'), undefined);
    assert.equal(resolveKey('not-a-key'), undefined);
    assert.equal(resolveKey(''), undefined);
  });

  it('refuses a valid prefix with the wrong secret', () => {
    const { secret } = issueKey(as('admin'), { name: 'Guessable', mode: 'LIVE', scopes: ['projects:read'] });
    const prefix = secret.split('.')[0]!;
    assert.equal(resolveKey(`${prefix}.wrong-secret-entirely`), undefined);
  });

  it('survives a restart, because a restart must not invalidate every integration', () => {
    const { secret } = issueKey(as('admin'), { name: 'Long running', mode: 'LIVE', scopes: ['projects:read'] });
    // The index is what authentication reads; a restart rebuilds it from the
    // ledger the same way the people who can sign in are rebuilt.
    resetKeys();
    assert.equal(resolveKey(secret), undefined, 'the index was not actually cleared');

    rehydrateKeys(platform.ledger);
    assert.ok(resolveKey(secret), 'a restart invalidated a live key');
  });

  it('refuses to revoke the same key twice', () => {
    const { key } = issueKey(as('admin'), { name: 'Twice revoked', mode: 'LIVE', scopes: ['projects:read'] });
    revokeKey(as('admin'), { keyId: key.id, reason: 'No longer needed' });
    throwsCode(() => revokeKey(as('admin'), { keyId: key.id, reason: 'No longer needed' }), 'API_KEY_ALREADY_REVOKED');
  });
});

describe('a key authenticates through the gateway like anything else', () => {
  const call = async (path: string, token: string) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.text() };
  };

  it('is accepted on a route inside its scopes', async () => {
    const { secret } = issueKey(as('admin'), { name: 'Gateway reader', mode: 'LIVE', scopes: ['projects:read'] });
    const reply = await call('/v1/permissions/matrix', secret);
    assert.equal(reply.status, 200, reply.body);
  });

  it('is refused on a route outside them, by the same scope check every caller meets', async () => {
    const { secret } = issueKey(as('admin'), { name: 'Narrow reader', mode: 'LIVE', scopes: ['projects:read'] });
    // The key holds no commercial scope, and the enforcement is the platform's
    // ordinary one — no new check was added for keys.
    const reply = await call(`/v1/projects/${seed.projectId}/entities/Estimate`, secret);
    assert.ok(reply.status === 403 || reply.status === 404, `${reply.status}: ${reply.body}`);
  });

  it('is refused once revoked, on the very next request', async () => {
    const { key, secret } = issueKey(as('admin'), { name: 'Live then not', mode: 'LIVE', scopes: ['projects:read'] });
    assert.equal((await call('/v1/permissions/matrix', secret)).status, 200);

    revokeKey(as('admin'), { keyId: key.id, reason: 'Leaked in a support ticket' });
    assert.equal((await call('/v1/permissions/matrix', secret)).status, 401);
  });
});

describe('a webhook endpoint is an outbound request to an address somebody chose', () => {
  it('refuses plain http', () => {
    throwsCode(() => assertDeliverableUrl('http://example.com/hook'), 'WEBHOOK_URL_INSECURE');
  });

  it('refuses credentials in the URL', () => {
    // They would be stored in this record and printed in every delivery log.
    throwsCode(() => assertDeliverableUrl('https://user:pass@example.com/hook'), 'WEBHOOK_URL_CREDENTIALS');
  });

  it('refuses an address inside the deployment', () => {
    // Otherwise the feature is a way of making the platform fetch its own
    // internals on request.
    for (const url of [
      'https://localhost/hook',
      'https://127.0.0.1/hook',
      'https://10.0.0.5/hook',
      'https://192.168.1.10/hook',
      'https://172.16.0.9/hook',
      'https://169.254.169.254/latest/meta-data/',
      'https://redis.internal/hook',
      'https://db.local/hook',
    ]) {
      throwsCode(() => assertDeliverableUrl(url), 'WEBHOOK_URL_INTERNAL', `${url} was accepted`);
    }
  });

  it('accepts an ordinary external https endpoint', () => {
    const url = assertDeliverableUrl('https://hooks.example.com/construx');
    assert.equal(url.hostname, 'hooks.example.com');
  });

  it('refuses a subscription to an event that does not exist', () => {
    // A subscription that silently never fires is the support call that takes a
    // day to answer.
    throwsCode(
      () =>
        subscribe(as('admin'), {
          name: 'Typo integration',
          url: 'https://hooks.example.com/x',
          eventTypes: ['PAYMENT_CERTIFED'],
        }),
      'WEBHOOK_EVENT_UNKNOWN',
    );
  });

  it('withholds the signing secret from every read', () => {
    const created = subscribe(as('admin'), { name: 'Cost sync', url: 'https://hooks.example.com/cost' });
    assert.match(created.secret, /^whsec_/);
    assert.equal('secret' in created.subscription, false);

    for (const entry of subscriptionRegister(as('admin'))) {
      assert.equal('secret' in entry, false, 'the register publishes the signing secret');
    }
  });
});

describe('the signature an integrator has to implement', () => {
  const SECRET = 'whsec_test_not_a_real_credential';
  const BODY = '{"eventType":"RFI_RAISED"}';

  it('verifies what it signs', () => {
    const now = 1_800_000_000;
    const header = sign(SECRET, BODY, now);
    assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
    assert.deepEqual(verifySignature(SECRET, header, BODY, now), { valid: true });
  });

  it('refuses a body that changed after signing', () => {
    const now = 1_800_000_000;
    const header = sign(SECRET, BODY, now);
    const outcome = verifySignature(SECRET, header, '{"eventType":"PAYMENT_CERTIFIED"}', now);
    assert.equal(outcome.valid, false);
    assert.match(outcome.valid === false ? outcome.because : '', /does not match/);
  });

  it('refuses the wrong secret', () => {
    const now = 1_800_000_000;
    assert.equal(verifySignature('whsec_something_else', sign(SECRET, BODY, now), BODY, now).valid, false);
  });

  it('refuses a replay, which is the half a naive implementation misses', () => {
    // Without the age check a captured delivery verifies perfectly for ever.
    const signedAt = 1_800_000_000;
    const header = sign(SECRET, BODY, signedAt);
    const outcome = verifySignature(SECRET, header, BODY, signedAt + 3_600);
    assert.equal(outcome.valid, false);
    assert.match(outcome.valid === false ? outcome.because : '', /replay/);
  });

  it('refuses a timestamp moved to defeat the age check', () => {
    // The timestamp is inside the signed material, so moving it invalidates the
    // digest — which is the whole reason it is signed rather than sent beside.
    const header = sign(SECRET, BODY, 1_800_000_000);
    const moved = header.replace('t=1800000000', 't=1800003600');
    assert.equal(verifySignature(SECRET, moved, BODY, 1_800_003_600).valid, false);
  });

  it('refuses a malformed header rather than throwing', () => {
    for (const header of ['', 'nonsense', 't=abc,v1=x', 'v1=only']) {
      assert.equal(verifySignature(SECRET, header, BODY).valid, false);
    }
  });
});

describe('delivery: owed rather than lost', () => {
  const event = {
    eventId: 'evt-1',
    eventType: 'RFI_RAISED',
    timestamp: '2026-08-28T09:00:00.000Z',
    tenantId: 'tenant-a',
    projectId: 'project-a',
    entity: { refType: 'RFI', refId: 'rfi-1' },
    action: 'CREATE',
    actor: { refType: 'User', refId: 'user-1' },
    correlationId: 'corr-1',
    chainHash: 'sha256:abc',
  } as never;

  const subscription = (over: Partial<Subscription> = {}): Subscription => ({
    id: 'sub-1',
    tenantId: 'tenant-a',
    name: 'Test',
    url: 'https://hooks.example.com/x',
    mode: 'LIVE',
    eventTypes: [],
    secret: 'whsec_x',
    createdBy: 'user-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    active: true,
    consecutiveFailures: 0,
    ...over,
  });

  it('matches an empty subscription to everything and a specific one to only its own', () => {
    assert.equal(matching([subscription()], event).length, 1);
    assert.equal(matching([subscription({ eventTypes: ['RFI_RAISED'] })], event).length, 1);
    assert.equal(matching([subscription({ eventTypes: ['PAYMENT_CERTIFIED'] })], event).length, 0);
  });

  it('never delivers one tenancy’s event to another tenancy’s endpoint', () => {
    assert.equal(matching([subscription({ tenantId: 'tenant-b' })], event).length, 0);
  });

  it('never delivers to a disabled subscription', () => {
    assert.equal(matching([subscription({ active: false })], event).length, 0);
  });

  it('sends the event rather than a rendering of it, and says where in the chain it sits', () => {
    const body = JSON.parse(envelope(event, 'del-1')) as Record<string, unknown>;
    assert.equal(body.eventType, 'RFI_RAISED');
    assert.equal(body.deliveryId, 'del-1');
    // Without a sequence an at-least-once feed is also an unknowably-lossy one.
    assert.equal(body.sequence, 'sha256:abc');
    // No state. An integrator reads the entity back with their key; state here
    // would be stale on arrival and a second definition of every entity.
    assert.equal('state' in body, false);
  });

  it('backs off, and stops short of an hour', () => {
    assert.equal(backoffSeconds(1), 10);
    assert.equal(backoffSeconds(2), 20);
    assert.equal(backoffSeconds(3), 40);
    // An unbounded exponential means a receiver down for a morning gets its
    // backlog a week later, which is worse than being told it was abandoned.
    assert.equal(backoffSeconds(20), 3_600);
  });
});

describe('against an endpoint that answers, and one that does not', () => {
  let endpoint: Server;
  let received: Array<{ headers: Record<string, string | undefined>; body: string }> = [];
  let answer = 200;
  let url = '';

  before(async () => {
    endpoint = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          headers: request.headers as Record<string, string | undefined>,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(answer);
        response.end();
      });
    });
    await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(endpoint.address() as { port: number }).port}/hook`;
  });

  after(() => endpoint.close());

  const delivery = (over: Partial<Delivery> = {}): Delivery => ({
    id: 'del-1',
    subscriptionId: 'sub-1',
    tenantId: 'tenant-a',
    eventId: 'evt-1',
    eventType: 'RFI_RAISED',
    body: '{"eventType":"RFI_RAISED"}',
    status: 'QUEUED',
    attempts: 0,
    queuedAt: '2026-08-28T09:00:00.000Z',
    nextAttemptAt: '2026-08-28T09:00:00.000Z',
    ...over,
  });

  const sub = (): Subscription => ({
    id: 'sub-1',
    tenantId: 'tenant-a',
    name: 'Test',
    url,
    mode: 'LIVE',
    eventTypes: [],
    secret: 'whsec_test',
    createdBy: 'user-1',
    createdAt: '2026-08-28T00:00:00.000Z',
    active: true,
    consecutiveFailures: 0,
  });

  it('signs what it sends, and the receiver can verify it', async () => {
    received = [];
    answer = 200;
    const outcome = await attempt(sub(), delivery());

    assert.equal(outcome.delivered, true);
    assert.equal(received.length, 1);

    const header = received[0]!.headers['x-construx-signature']!;
    assert.deepEqual(verifySignature('whsec_test', header, received[0]!.body), { valid: true });
    // Stable across retries, so an at-least-once feed can be made exactly-once
    // on the receiver's side.
    assert.equal(received[0]!.headers['x-construx-delivery-id'], 'del-1');
    assert.equal(received[0]!.headers['x-construx-event-type'], 'RFI_RAISED');
  });

  it('treats a non-2xx as a failure rather than acceptance', async () => {
    received = [];
    answer = 500;
    const outcome = await attempt(sub(), delivery());
    assert.equal(outcome.delivered, false);
    assert.equal(outcome.status, 500);
  });

  it('does not throw when the endpoint is unreachable', async () => {
    // One broken subscription must not hold up every other tenancy's.
    const outcome = await attempt({ ...sub(), url: 'https://127.0.0.1:1/hook' }, delivery(), 300);
    assert.equal(outcome.delivered, false);
    assert.ok((outcome.error ?? '').length > 0);
  });

  it('abandons a delivery once the allowance is spent, and says so', async () => {
    const outcome = await attempt({ ...sub(), url: 'https://127.0.0.1:1/hook' }, delivery({ attempts: MAX_ATTEMPTS - 1 }), 300);
    assert.equal(outcome.abandoned, true);
  });

  /**
   * A real queued delivery against a real subscription.
   *
   * `recordDelivery` writes an UPDATE, and the ledger refuses an update to an
   * entity that was never created — correctly. Constructing the delivery object
   * by hand and recording against it tested nothing but the shape of a literal.
   */
  function queued(): { subscription: Subscription; delivery: Delivery } {
    const context = as('admin');
    const created = subscribe(context, {
      name: `Endpoint ${Math.random().toString(36).slice(2, 8)}`,
      url: 'https://hooks.example.com/real',
    });
    const stored = platform.ledger.get({ refType: 'WebhookSubscription', refId: created.subscription.id })!;
    const subscription = stored.state as unknown as Subscription;

    const [delivered] = enqueue(context, {
      eventId: `evt-${Math.random().toString(36).slice(2)}`,
      eventType: 'RFI_RAISED',
      timestamp: new Date().toISOString(),
      tenantId: seed.tenantId,
      projectId: seed.projectId,
      entity: { refType: 'RFI', refId: 'rfi-1' },
      action: 'CREATE',
      actor: { refType: 'User', refId: seed.users.admin!.id },
      correlationId: 'corr-1',
      chainHash: 'sha256:abc',
    } as never);

    return { subscription, delivery: delivered! };
  }

  it('disables a subscription that has been refusing long enough', () => {
    const context = as('admin');
    const { subscription, delivery: real } = queued();

    const { subscriptionDisabled } = recordDelivery(context, {
      subscription: { ...subscription, consecutiveFailures: FAILURES_BEFORE_DISABLE - 1 },
      delivery: real,
      outcome: { deliveryId: real.id, delivered: false, error: 'connection refused' },
    });

    // Continuing to post to an endpoint that has been refusing all day is a
    // slow outbound flood against somebody else's server.
    assert.equal(subscriptionDisabled, true);
  });

  it('records an abandoned delivery rather than hiding it', () => {
    const context = as('admin');
    const { subscription, delivery: real } = queued();

    recordDelivery(context, {
      subscription,
      delivery: { ...real, attempts: MAX_ATTEMPTS - 1 },
      outcome: { deliveryId: real.id, delivered: false, error: 'gone' },
    });

    const position = webhookPosition(context);
    // Data an integrator never received. A screen showing only successes lets a
    // customer believe their integration is complete when it has gaps.
    assert.ok(position.abandoned >= 1, 'an abandoned delivery is not reported');
  });

  it('clears the failure count once an endpoint answers again', () => {
    const context = as('admin');
    const { subscription, delivery: real } = queued();

    recordDelivery(context, {
      subscription: { ...subscription, consecutiveFailures: 3 },
      delivery: real,
      outcome: { deliveryId: real.id, delivered: true, status: 200 },
    });

    const stored = platform.ledger.get({ refType: 'WebhookSubscription', refId: subscription.id })!;
    const after = stored.state as unknown as Subscription;
    assert.equal(after.consecutiveFailures, 0, 'a recovered endpoint keeps its failure count');
    assert.equal(after.active, true);
  });
});

describe('a subscription can be stopped', () => {
  it('stops delivering, and refuses to be stopped twice', () => {
    const created = subscribe(as('admin'), { name: 'Temporary', url: 'https://hooks.example.com/temp' });
    unsubscribe(as('admin'), { subscriptionId: created.subscription.id, reason: 'Integration retired' });
    throwsCode(
      () => unsubscribe(as('admin'), { subscriptionId: created.subscription.id, reason: 'Integration retired' }),
      'WEBHOOK_ALREADY_DISABLED',
    );
  });

  it('refuses a subscription from somebody without governance authority', () => {
    throwsCode(
      () => subscribe(as('pm'), { name: 'PM integration', url: 'https://hooks.example.com/pm' }),
      'ACCESS_DENIED',
    );
  });
});
