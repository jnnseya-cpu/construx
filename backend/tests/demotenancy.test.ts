import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { demonstrationEnabled } from '../src/config.ts';
import { Platform } from '../src/platform.ts';
import { DEMO_TENANCY, seedDemoProject } from '../src/seed.ts';

/**
 * The demonstration tenancy in production.
 *
 * A production deployment showed a prospective customer nothing: the seed was
 * off, so the platform served a sign-in page onto an empty world and the
 * identity picker was refused. `DEMO_TENANCY_ENABLED` turns on a real seeded
 * tenancy whose identities sign in through the ordinary login and MFA path.
 *
 * That is a deliberate widening of what an anonymous caller may obtain, so it
 * is the thing this file exists to pin down. The claim under test, stated
 * plainly: **the switch publishes twelve seeded accounts and nothing else.**
 *
 * Concretely, and each of these is a test below —
 *
 * - No account outside the demonstration tenancy is affected, in either
 *   direction, whatever the switch is set to.
 * - No operator is ever reachable through it, because a `PLATFORM_ADMIN` sees
 *   across every tenancy on the platform.
 * - `POST /v1/console/session`, which mints a token with *no* challenge, is not
 *   governed by this switch and stays refused in production regardless.
 * - The mark that makes an account public is set by the seed and by nothing
 *   else, and it survives a replay — because a flag that lived only in memory
 *   would take the demonstration sign-in with it on the first restart.
 */

let server: Server;
let base: string;
let platform: Platform;

before(async () => {
  platform = new Platform();
  await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

/**
 * Run a block with the environment set, restoring both variables afterwards.
 *
 * `config.env` and `config.demo.enabled` are snapshots taken at module load, so
 * setting the variables here cannot reach them. The request-time gates call
 * `isProduction()` and `demonstrationEnabled()`, which read `process.env`
 * fresh — that is the whole reason both exist.
 */
async function withEnv<T>(vars: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const asProductionWithDemo = <T>(run: () => Promise<T>): Promise<T> =>
  withEnv({ NODE_ENV: 'production', DEMO_TENANCY_ENABLED: 'true' }, run);

const asProductionWithoutDemo = <T>(run: () => Promise<T>): Promise<T> =>
  withEnv({ NODE_ENV: 'production', DEMO_TENANCY_ENABLED: undefined }, run);

async function login(email: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  return (await response.json()) as Record<string, unknown>;
}

// --- the switch itself ------------------------------------------------------

describe('reading the switch', () => {
  it('is off when the variable is absent, empty or anything but a truth', async () => {
    for (const value of [undefined, '', 'false', '0', 'yes', 'TRUE', 'enabled']) {
      const on = await withEnv({ DEMO_TENANCY_ENABLED: value }, async () => demonstrationEnabled());
      assert.equal(on, false, `DEMO_TENANCY_ENABLED=${String(value)} switched it on`);
    }
  });

  it('is on for the two spellings the config loader itself accepts', async () => {
    // Not a stricter rule than `bool()`. A gate that took `true` where the
    // loader also takes `1` would leave a deployment set to `1` seeding a
    // demonstration at boot that every route then refused to show.
    for (const value of ['true', '1']) {
      assert.equal(await withEnv({ DEMO_TENANCY_ENABLED: value }, async () => demonstrationEnabled()), true, value);
    }
  });
});

// --- what carries the mark --------------------------------------------------

describe('the demonstration mark', () => {
  it('is on every seeded delivery identity', () => {
    const seeded = platform.demonstrationUsers();
    // Twelve: the enterprise administrator plus the eleven-strong delivery
    // team. A count rather than a spot check, so an identity added to the seed
    // without the mark fails here instead of silently being unreachable.
    assert.equal(seeded.length, 12, 'the seeded delivery team is not all marked');
    for (const user of seeded) {
      assert.equal(user.demonstration, true, `${user.email} is listed as a demonstration identity without the mark`);
      assert.match(user.email, /@meridian\.example$/);
    }
  });

  it('is on no operator, so no platform administrator is ever reachable through it', () => {
    for (const operator of platform.operators()) {
      assert.notEqual(operator.demonstration, true, `${operator.email} carries the demonstration mark`);
    }
    assert.equal(
      platform.demonstrationUsers().some((u) => u.roles.includes('PLATFORM_ADMIN')),
      false,
    );
  });

  it('is absent — not false — on an ordinary customer account', () => {
    const { tenant } = platform.createTenant({
      legalName: 'Ordinary Contracting Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      enterpriseName: 'Ordinary Contracting',
    });
    const real = platform.createUser({
      tenantId: tenant.id,
      name: 'A Real Customer',
      email: 'real@ordinary.example',
      roles: ['PM'],
    });
    assert.equal('demonstration' in real, false, 'a real account carries the key at all');
    assert.equal(
      platform.demonstrationUsers().some((u) => u.id === real.id),
      false,
    );
  });

  it('survives a replay, or the demonstration dies on the first restart', () => {
    // The flag is written into USER_CREATED, not held in the process. Rebuilt
    // here the way `main.ts` rebuilds a deployment: events off the journal,
    // replayed into a fresh platform.
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();

    const before = platform.demonstrationUsers().map((u) => u.email).sort();
    const after = rebuilt.demonstrationUsers().map((u) => u.email).sort();
    assert.deepEqual(after, before, 'the demonstration mark did not survive the replay');
  });
});

// --- adoption ---------------------------------------------------------------

describe('a second seed on a deployment that already has one', () => {
  it('can find the existing tenancy by its own constants', () => {
    // The lookup the console bootstrap performs before it decides to seed. If
    // it fails, a restart builds a second Meridian — a second project, a second
    // wallet, a second set of twelve identities — and the sign-in page fills
    // with duplicate Project Managers.
    const seeded = platform.demonstrationUsers();
    const tenantId = seeded[0]?.tenantId as string;
    const project = platform.ledger
      .entitiesOfType('Project')
      .find((record) => record.tenantId === tenantId && record.state.name === DEMO_TENANCY.projectName);
    assert.ok(project, 'the seeded project could not be found by the name the adoption path looks for');
  });

  it('adopts an operator that already exists rather than adding a demonstration one', async () => {
    const fresh = new Platform();
    const real = fresh.createOperator({ name: 'Real Operator', email: 'ops@example.com' });
    await seedDemoProject(fresh);
    assert.deepEqual(
      fresh.operators().map((o) => o.email),
      [real.email],
      'seeding added a second operator to a platform that already had one',
    );
  });
});

// --- production, switched off ----------------------------------------------

describe('production with the demonstration switched off', () => {
  it('refuses to list identities', async () => {
    const response = await asProductionWithoutDemo(() =>
      fetch(`${base}/v1/console/identities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    assert.equal(response.status, 403);
  });

  it('returns no code for a seeded identity — the accounts exist but are not published', async () => {
    const challenge = await asProductionWithoutDemo(() => login(DEMO_TENANCY.primaryEmail));
    assert.equal('devCode' in challenge, false);
    assert.equal('demoCode' in challenge, false);
    assert.equal(challenge.mfaRequired, true);
  });
});

// --- production, switched on ------------------------------------------------

describe('production with the demonstration switched on', () => {
  it('returns a one-time code for a seeded identity, under its own key', async () => {
    const challenge = await asProductionWithDemo(() => login(DEMO_TENANCY.primaryEmail));
    assert.equal(typeof challenge.demoCode, 'string');
    assert.match(String(challenge.demoCode), /^[0-9A-F]{6}$/);
    // Not `devCode`. One key means "this is not a real deployment"; the other
    // means "this is a real deployment and this one account is published".
    assert.equal('devCode' in challenge, false);
  });

  it('returns nothing for a real customer account on the same deployment', async () => {
    // The whole safety argument in one assertion. The switch is on, production
    // is on, and this address still gets what every address got before.
    const challenge = await asProductionWithDemo(() => login('real@ordinary.example'));
    assert.equal('demoCode' in challenge, false);
    assert.equal('devCode' in challenge, false);
    assert.equal(challenge.mfaRequired, true);
  });

  it('returns nothing for an address that has no account, and looks identical doing it', async () => {
    const challenge = await asProductionWithDemo(() => login('nobody@nowhere.example'));
    assert.equal('demoCode' in challenge, false);
    assert.equal(challenge.mfaRequired, true);
    assert.equal(typeof challenge.actorId, 'string');
  });

  it('returns no code for an operator, whatever else is set', async () => {
    const operator = platform.operators()[0];
    assert.ok(operator);
    const challenge = await asProductionWithDemo(() => login(operator.email));
    assert.equal('demoCode' in challenge, false);
    assert.equal('devCode' in challenge, false);
  });

  it('still makes the code go through the real verification step', async () => {
    const challenge = await asProductionWithDemo(() => login(DEMO_TENANCY.primaryEmail));

    // Wrong code first: the shortcut is the delivery of the code, not the check.
    const refused = await fetch(`${base}/v1/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actorId: challenge.actorId, challengeId: challenge.challengeId, code: 'AAAAAA' }),
    });
    assert.equal(refused.status, 401);

    // And the real one is single-use: the refusal above did not consume it,
    // but the acceptance below does.
    const accepted = await fetch(`${base}/v1/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actorId: challenge.actorId,
        challengeId: challenge.challengeId,
        code: challenge.demoCode,
      }),
    });
    // 201, not 200: the gateway answers a successful POST with Created.
    assert.equal(accepted.status, 201);
    const tokens = (await accepted.json()) as { accessToken: string; user: { roles: string[] } };
    assert.equal(typeof tokens.accessToken, 'string');
    assert.deepEqual(tokens.user.roles, ['PM']);

    const replayed = await fetch(`${base}/v1/auth/mfa/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        actorId: challenge.actorId,
        challengeId: challenge.challengeId,
        code: challenge.demoCode,
      }),
    });
    assert.equal(replayed.status, 401, 'a demonstration code could be used twice');
  });

  it('lists the seeded identities and no operator', async () => {
    const response = await asProductionWithDemo(() =>
      fetch(`${base}/v1/console/identities`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      identities: Array<{ email: string; layer: string }>;
      enterprise: string;
    };

    assert.equal(body.enterprise, DEMO_TENANCY.enterpriseName);
    assert.equal(body.identities.length, 12);
    assert.equal(
      body.identities.some((i) => i.layer === 'PLATFORM_ADMIN'),
      false,
      'an operator was offered as a demonstration identity in production',
    );
    for (const identity of body.identities) {
      assert.match(identity.email, /@meridian\.example$/, `${identity.email} is not a demonstration address`);
    }
  });

  it('does not reopen the console session, which skips the challenge entirely', async () => {
    // The line the switch does not cross. `/v1/console/identities` publishes
    // accounts that still have to authenticate; this route hands over a working
    // access token to an anonymous caller with no challenge at all, and no
    // setting should turn it back on in production.
    const response = await asProductionWithDemo(() =>
      fetch(`${base}/v1/console/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    assert.equal(response.status, 403);
    const problem = (await response.json()) as { title: string };
    assert.equal(problem.title, 'DEMO_DISABLED');
  });
});

// --- what a restart actually reads -----------------------------------------

describe('the mark in the record', () => {
  it('is in the committed state, which is what a restart replays', () => {
    const pm = platform.demonstrationUsers().find((u) => u.email === DEMO_TENANCY.primaryEmail);
    assert.ok(pm);
    const record = platform.ledger.require({ refType: 'User', refId: pm.id });
    assert.equal(record.state.demonstration, true, 'the mark is not in the ledger state');
  });
});
