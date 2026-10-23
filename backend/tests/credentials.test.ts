import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import {
  CREDENTIALS,
  clearCredential,
  credential,
  credentialStates,
  environmentRetired,
  keyIdOf,
  resetCredentialCache,
  secretFor,
  useCredentialStore,
  setCredential,
} from '../src/identity/credentials.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The credentials an operator sets without a shell.
 *
 * Asked for in those words — "admin must be able to add all apis, included for
 * ai and payment gateway" — after an afternoon of `sed -i` on a production
 * `.env`, two keys pasted as placeholder text and one 401 that cost an hour.
 *
 * The tests that matter are not that a value round-trips. They are the three
 * properties that make this safe to have at all, each of which is a way the
 * feature could have been built wrong and looked right:
 *
 *   - **no route returns a value**, to anybody, ever
 *   - **no value reaches the ledger**, which is append-only and in every backup
 *   - **the file on disk is not the key**, so a stolen volume is not a breach
 *
 * The fourth is that it actually overrides the environment, because a store
 * nothing reads is a screen that lies about what is configured.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
const directory = mkdtempSync(join(tmpdir(), 'construx-credentials-'));
/*
 * Deliberately not shaped like anybody's key.
 *
 * The first version of this file used a live-Stripe-shaped value and GitHub's push protection
 * refused the push — correctly. A fixture that matches a vendor's key format is
 * indistinguishable from a leak to every scanner that will ever read this
 * repository, and "it is only a test value" is exactly what a real leak looks
 * like in a commit message. Nothing here depends on the shape.
 */
const KEY = 'not-a-real-key-openai-fixture-0000000000000000';

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

async function call(method: string, path: string, token: string, payload?: unknown): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

before(async () => {
  // The store writes beside the journal, so the journal path is what puts this
  // test's file in a temporary directory rather than anywhere real.
  useCredentialStore(join(directory, 'credentials.enc'));

  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  rmSync(directory, { recursive: true, force: true });
  useCredentialStore(undefined);
});

describe('a credential set from the console', () => {
  it('is readable by the platform and by nothing else', () => {
    // Through the operator's own command, which writes the store and the
    // chain — the two halves that must stay apart and must both happen.
    platform.setPlatformCredential({ name: 'OPENAI_API_KEY', value: KEY, decidedBy: seed.users.operator!.id, reason: 'Rotated after the old key was revoked' });

    // The platform's own call sites get the value.
    assert.equal(credential('OPENAI_API_KEY'), KEY);

    // Everything a screen can know, and no more.
    const state = credentialStates().find((entry) => entry.name === 'OPENAI_API_KEY')!;
    assert.equal(state.stored, true);
    assert.equal(state.keyId, keyIdOf(KEY));
    assert.equal(state.reason, 'Rotated after the old key was revoked');
    assert.equal(JSON.stringify(state).includes(KEY), false, 'the state carries the key itself');
    // Eight hex characters identify a key; they are not one.
    assert.match(state.keyId!, /^[0-9a-f]{8}$/);
  });

  it('is not the key on disk', () => {
    const raw = readFileSync(join(directory, 'credentials.enc'), 'utf8');
    assert.equal(raw.includes(KEY), false, 'the credential file holds the key in the clear');
    assert.equal(raw.includes(KEY.slice(8, 40)), false, 'part of the key is readable on disk');
    // What it does hold, so a reader of the file can tell what it is.
    assert.match(raw, /"sealed":/);
    assert.match(raw, new RegExp(`"keyId":"${keyIdOf(KEY)}"`));
  });

  it('never reaches the ledger, which could not give it back', () => {
    const events = platform.ledger.events().filter((event) => event.eventType === 'PLATFORM_CREDENTIAL_SET');
    assert.ok(events.length > 0, 'setting a credential wrote nothing to the chain');

    // The whole chain, not just this event: the assertion worth having is that
    // the value is nowhere on an append-only record that is copied into every
    // backup and could never be corrected.
    const chain = JSON.stringify(platform.ledger.events());
    assert.equal(chain.includes(KEY), false, 'the key is on the chain and can never be removed from it');

    // What the chain does say, because "who gave this platform a key to spend
    // money with" is an access-review question.
    assert.equal(events.at(-1)!.entity.refId, 'OPENAI_API_KEY');
    const record = platform.ledger.get({ refType: 'PlatformCredential', refId: 'OPENAI_API_KEY' })!;
    assert.equal((record.state as { keyId?: string }).keyId, keyIdOf(KEY));
    assert.equal((record.state as { reason?: string }).reason, 'Rotated after the old key was revoked');
  });

  it('comes back from no route, to the operator least of all', async () => {
    const token = tokenFor('operator');
    const register = await call('GET', '/v1/admin/platform-credentials', token);
    assert.equal(register.status, 200);
    assert.equal(register.text.includes(KEY), false, 'the register returned the key');

    const entry = register.body.credentials.find((row: { name: string }) => row.name === 'OPENAI_API_KEY');
    assert.equal(entry.stored, true);
    assert.equal(entry.keyId, keyIdOf(KEY));

    // And setting one answers with its state, not with what was sent.
    const set = await call('POST', '/v1/admin/platform-credentials/ANTHROPIC_API_KEY', token, {
      value: 'not-a-real-key-anthropic-fixture-00000000',
      reason: 'Added as the failover vendor',
    });
    assert.equal(set.status, 201);
    assert.equal(set.text.includes('not-a-real-key-anthropic-fixture-00000000'), false, 'the response echoed the key back');
  });

  it('is refused to everybody but the platform operator', async () => {
    for (const who of ['admin', 'pm']) {
      const reply = await call('GET', '/v1/admin/platform-credentials', tokenFor(who));
      assert.equal(reply.status, 403, `${who} could read the credential register`);
      const attempt = await call('POST', '/v1/admin/platform-credentials/OPENAI_API_KEY', tokenFor(who), {
        value: 'not-a-real-key-attempt-fixture-0000000000',
        reason: 'Trying it on',
      });
      assert.equal(attempt.status, 403, `${who} could set a credential`);
    }
    // Unchanged by the attempts.
    assert.equal(credential('OPENAI_API_KEY'), KEY);
  });

  it('refuses a name the platform does not read', async () => {
    const reply = await call('POST', '/v1/admin/platform-credentials/OPENAI_KEY', tokenFor('operator'), {
      value: 'not-a-real-key-unknown-fixture-0000000000',
      reason: 'A name that is nearly right',
    });
    assert.equal(reply.status, 404);
    assert.equal(reply.body.title, 'CREDENTIAL_UNKNOWN');
    // The point of refusing: an open store would have shown this as configured.
    assert.match(reply.body.detail, /would change nothing and would show as configured/);
  });

  it('clears back to the environment rather than to nothing', async () => {
    const reply = await call('POST', '/v1/admin/platform-credentials/OPENAI_API_KEY/clear', tokenFor('operator'), {
      reason: 'Moving back to the environment for this deployment',
    });
    assert.equal(reply.status, 201);
    assert.equal(credential('OPENAI_API_KEY'), undefined, 'the store still answers after a clear');

    const cleared = platform.ledger.events().filter((event) => event.eventType === 'PLATFORM_CREDENTIAL_CLEARED');
    assert.ok(cleared.length > 0);
    // Whether anything still supplies it is on the record, because "cleared"
    // with nothing behind it is a capability that has stopped.
    const record = platform.ledger.get({ refType: 'PlatformCredential', refId: 'OPENAI_API_KEY' })!;
    assert.equal(typeof (record.state as { fallsBackToEnvironment?: boolean }).fallsBackToEnvironment, 'boolean');
  });

  it('survives a reload, which is the only reason to write a file at all', () => {
    setCredential('STRIPE_SECRET_KEY', 'not-a-real-key-stripe-fixture-00000000', seed.users.operator!.id, 'Key for the first settlement');
    resetCredentialCache();
    assert.equal(credential('STRIPE_SECRET_KEY'), 'not-a-real-key-stripe-fixture-00000000');
    clearCredential('STRIPE_SECRET_KEY');
  });

  /**
   * The copy in `.env`, after a rotation.
   *
   * Reported from a live deployment: a key was rotated from the console and the
   * superseded one stayed in the file on the host. The store overrode it, so
   * everything worked — and the platform would have fallen straight back to a
   * revoked key the moment anybody cleared the store, with a 401 nobody could
   * account for.
   *
   * Nothing here can delete that file: it is the deployment's configuration,
   * not this application's data. What the platform can do is refuse to read it
   * again, and that is what these assert — including that the refusal survives
   * the store being cleared, which is the whole point of it.
   */
  describe('the copy in the environment', () => {
    // A credential this test owns outright, so retiring it cannot disturb the
    // assertions above about the OpenAI key.
    const NAME = 'GEMINI_API_KEY' as const;

    it('is read where nothing overrides it, and refused once retired', () => {
      // Stood up as the environment would: the store holds nothing for it.
      assert.equal(credential(NAME), undefined);

      platform.setPlatformCredentialEnvironment({
        name: NAME,
        retired: true,
        decidedBy: seed.users.operator!.id,
        reason: 'Rotated on 23 October; the old key is revoked at the vendor',
      });

      assert.equal(environmentRetired(NAME), true);
      // The resolver is what every call site uses, and it is the thing that
      // must come back empty — `credential` only ever spoke for the store.
      assert.equal(secretFor(NAME), '');
    });

    it('stays retired when the store is cleared, which is the point of it', () => {
      setCredential(NAME, 'not-a-real-key-gemini-fixture-000000000', seed.users.operator!.id, 'Replacement key');
      assert.equal(secretFor(NAME), 'not-a-real-key-gemini-fixture-000000000');

      clearCredential(NAME);
      // Without the retirement this would now be whatever is in `.env`.
      assert.equal(secretFor(NAME), '', 'clearing the store fell back to a retired environment key');
    });

    it('says what is still outstanding, because the platform has done half of it', async () => {
      const reply = await call('POST', `/v1/admin/platform-credentials/${NAME}/environment`, tokenFor('operator'), {
        retired: true,
        reason: 'Superseded; removing it from the host file today',
      });
      assert.equal(reply.status, 201);
      assert.match(reply.body.effect, /delete GEMINI_API_KEY from \.env on the host/);
      assert.match(reply.body.effect, /revoke that key at the vendor/);
    });

    it('can be put back, so a wrong decision is not a trip to the host', () => {
      platform.setPlatformCredentialEnvironment({
        name: NAME,
        retired: false,
        decidedBy: seed.users.operator!.id,
        reason: 'Retired the wrong one; the environment copy is the live key',
      });
      assert.equal(environmentRetired(NAME), false);
    });

    it('is on the chain, carrying the decision and never a value', () => {
      const events = platform.ledger
        .events()
        .filter((event) => event.eventType === 'PLATFORM_CREDENTIAL_ENV_RETIRED' || event.eventType === 'PLATFORM_CREDENTIAL_ENV_RESTORED');
      assert.ok(events.length >= 2, 'retiring and restoring wrote nothing to the chain');
      assert.equal(lookupEventType('PLATFORM_CREDENTIAL_ENV_RETIRED')?.entity, 'PlatformCredential');
      assert.notEqual(lookupEventType('PLATFORM_CREDENTIAL_ENV_RETIRED')?.aiAllowed, true);

      const chain = JSON.stringify(platform.ledger.events());
      assert.equal(chain.includes('not-a-real-key-gemini-fixture-000000000'), false, 'a key reached the chain');
    });

    it('is refused to everybody but the platform operator', async () => {
      const reply = await call('POST', `/v1/admin/platform-credentials/${NAME}/environment`, tokenFor('admin'), {
        retired: true,
        reason: 'Trying it on from a customer tenancy',
      });
      assert.equal(reply.status, 403);
    });
  });

  it('names only credentials the platform actually reads', () => {
    // The list is closed so the screen cannot become evidence that a key was
    // configured when nothing consumes it. Each one is read somewhere.
    for (const entry of CREDENTIALS) {
      assert.ok(entry.unlocks.length > 20, `${entry.name} does not say what stops without it`);
      assert.ok(entry.group.length > 0);
    }
    assert.deepEqual(
      CREDENTIALS.map((entry) => entry.name).slice().sort(),
      ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
    );
  });
});
