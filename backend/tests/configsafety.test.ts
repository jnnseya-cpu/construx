import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

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
