import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { foreignSenderDomain } from '../src/config.ts';

/**
 * The sender-domain check in `assertProductionSafety`.
 *
 * It exists because the one thing a first deploy cannot survive is silently
 * broken outbound mail: the confirmation email is what turns a signup into an
 * account, and mail sent as a domain the deployment does not serve fails at the
 * receiving end rather than at ours. Nothing in the logs says "email" — the
 * symptom is a queue of people who registered and never appeared.
 */
describe('outbound mail must claim a domain this deployment serves', () => {
  it('warns when the from address is a different domain to the public origin', () => {
    const foreign = foreignSenderDomain('hello@construx.ai', 'https://construxvg.com');
    assert.deepEqual(foreign, { sender: 'construx.ai', origin: 'construxvg.com' });
  });

  it('accepts the matching case', () => {
    assert.equal(foreignSenderDomain('no-reply@construxvg.com', 'https://construxvg.com'), null);
  });

  it('accepts a sender on a subdomain, which is how transactional providers are set up', () => {
    // mail.example.com is authorised by the parent domain's SPF. Warning here
    // would train people to ignore the warning.
    assert.equal(foreignSenderDomain('no-reply@mail.construxvg.com', 'https://construxvg.com'), null);
  });

  it('ignores the www prefix on the origin rather than reporting a false mismatch', () => {
    assert.equal(foreignSenderDomain('no-reply@construxvg.com', 'https://www.construxvg.com'), null);
  });

  it('compares case-insensitively, because neither a domain nor a mailbox host is case-sensitive', () => {
    assert.equal(foreignSenderDomain('No-Reply@ConstruxVG.com', 'https://CONSTRUXVG.com'), null);
  });

  it('stays quiet when there is nothing to compare against', () => {
    // A malformed base URL and an unset from address are separate defects with
    // their own warnings. Reporting them here would blame the wrong variable.
    assert.equal(foreignSenderDomain('no-reply@construxvg.com', 'not-a-url'), null);
    assert.equal(foreignSenderDomain('', 'https://construxvg.com'), null);
    assert.equal(foreignSenderDomain('no-reply', 'https://construxvg.com'), null);
  });

  it('is not fooled by a domain that merely ends with the origin', () => {
    // notconstruxvg.com ends with "construxvg.com" as a string but is a
    // different registration entirely, and its mail is somebody else's.
    const foreign = foreignSenderDomain('no-reply@notconstruxvg.com', 'https://construxvg.com');
    assert.deepEqual(foreign, { sender: 'notconstruxvg.com', origin: 'construxvg.com' });
  });
});

describe('the deployment says when its production gates are open', () => {
  /**
   * The defect, and it is the one an audit would put at the top.
   *
   * Every warning in `assertProductionSafety` sat inside
   * `if (config.env === 'production')`. So the deployment that most needs the
   * warnings — one that is live but was never told it is production — is
   * precisely the one that gets none of them. It gets no warning about the
   * published development signing secret, none about an in-memory ledger, and
   * none about the two things that matter most:
   *
   *   - `POST /v1/auth/login` returns `devCode`, the live one-time sign-in
   *     code, to any anonymous caller, for any address on the deployment;
   *   - `POST /v1/console/session` returns a working PM access token to
   *     anybody who asks, with no credential and no challenge.
   *
   * Both gates read `isProduction()` and both are correct. Reproduced against
   * two running servers: with `NODE_ENV=production` the console route answers
   * 403 DEMO_DISABLED and the login response for a known address is
   * byte-identical in shape to one for an address that does not exist. With
   * `NODE_ENV` unset and everything else configured identically, the same
   * login returned `"devCode":"A777DF"` and the console route returned a
   * token — and readiness reported zero warnings.
   *
   * `config` is read from the environment at module load, so this has to run
   * in a child process to say anything true about a different environment.
   */
  function warningsUnder(env: Record<string, string>): string[] {
    const script =
      "import('./backend/src/config.ts').then((m) => " +
      'process.stdout.write(JSON.stringify(m.assertProductionSafety())));';
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `child failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as string[];
  }

  /** A deployment that is plainly live: https, TLS declared, real secret, mail. */
  const LIVE_LOOKING = {
    PUBLIC_BASE_URL: 'https://construxvg.com',
    TLS_TERMINATION: 'EDGE_PROXY',
    SMTP_HOST: 'smtp.example.com',
    GATEWAY_JWT_SECRET: 'a-real-deployment-secret-value',
    LEDGER_JOURNAL_PATH: '/var/lib/construx/journal',
  };

  it('warns when a live-looking deployment is not in production mode', () => {
    const warnings = warningsUnder(LIVE_LOOKING);
    const found = warnings.find((line) => line.includes('NODE_ENV'));
    assert.ok(found, `no NODE_ENV warning among:\n  ${warnings.join('\n  ')}`);
    // The warning has to name the consequence, not the setting. "NODE_ENV is
    // not production" is a fact an operator can read past; "anyone can get a
    // sign-in code for any address" is not.
    assert.match(found, /one-time sign-in code/);
    assert.match(found, /console\/session/);
  });

  it('says nothing when the same deployment is in production mode', () => {
    const warnings = warningsUnder({ ...LIVE_LOOKING, NODE_ENV: 'production' });
    assert.equal(
      warnings.filter((line) => line.includes('NODE_ENV is')).length,
      0,
      `a correctly configured deployment was warned anyway:\n  ${warnings.join('\n  ')}`,
    );
  });

  it('says nothing on a developer machine, which is not a live deployment', () => {
    // One signal is not enough. A developer with a journal path set, and
    // nothing else, is doing ordinary local work — warning there is how a
    // warning becomes furniture.
    const warnings = warningsUnder({ LEDGER_JOURNAL_PATH: '/tmp/journal' });
    assert.equal(
      warnings.filter((line) => line.includes('NODE_ENV is')).length,
      0,
      `a local development environment was warned:\n  ${warnings.join('\n  ')}`,
    );
  });
});
