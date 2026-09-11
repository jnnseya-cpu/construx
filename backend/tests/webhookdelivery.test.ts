import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { resetIdempotency } from '../src/api/middleware.ts';
import { config } from '../src/config.ts';
import { resetWebhookHealth, webhookHealth, webhookSecretShape } from '../src/billing/stripe.ts';
import { resetKodaWebhookHealth, kodaWebhookHealth } from '../src/billing/koda.ts';
import {
  REFUSALS,
  deliveryHealth,
  diagnose,
  dominantCode,
  recordAccepted,
  recordRefused,
  resetDelivery,
  secretShape,
  type WebhookHealthRecord,
} from '../src/billing/webhookdelivery.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject } from '../src/seed.ts';

/**
 * "The Stripe webhook is not working."
 *
 * That sentence was the whole of what a deployment could say about a failing
 * payment rail, and it is true of eight different causes with eight different
 * fixes. The platform knew which one it was every time — `verifyWebhook`
 * refuses with a specific code — and published a count instead of the code,
 * beside a screen that named a wrong signing secret as the cause whatever had
 * actually happened.
 *
 * These tests are the argument that the deployment can now name its own
 * failure. In order:
 *
 *   1. Every refusal either rail can produce is explained. Enforced by reading
 *      the rails' source, so a code added later without an explanation fails
 *      here rather than reaching an operator as a bare string.
 *   2. The tally counts by code, and counts the two refusals decided in the
 *      gateway that never reach the rail — the failure mode where a webhook
 *      nothing can get through reads as a healthy endpoint nobody has used.
 *   3. A secret is measured without being read out, and the two mistakes no
 *      other check can see are caught.
 *   4. The verdict distinguishes "never delivered" from "healthy", which the
 *      two-integer panel could not.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src', 'billing');
const SECRET = 'whsec_test_secret_for_the_suite_only';

type MutableSecrets = { secretKey: string; webhookSecret: string };
const stripeConfig = config.stripe as unknown as MutableSecrets;

let platform: Platform;
let server: Server;
let base: string;

function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac('sha256', secret).update(`${at}.${body}`).digest('hex');
  return `t=${at},v1=${v1}`;
}

before(async () => {
  stripeConfig.secretKey = 'sk_test_suite';
  stripeConfig.webhookSecret = SECRET;
  platform = new Platform();
  await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

beforeEach(() => {
  resetIdempotency();
  resetWebhookHealth();
  resetKodaWebhookHealth();
});

after(() => {
  server.close();
});

const blank = (): WebhookHealthRecord => ({ accepted: 0, rejected: 0, byCode: {} });
const goodShape = () => secretShape(SECRET, 'whsec_');

describe('every refusal a rail can issue is explained', () => {
  /**
   * The rails refuse through one wrapper each, so the codes an operator can
   * ever be shown are exactly the ones passed to `reject`. Read out of the
   * source rather than listed here: a list would be a second copy that drifts,
   * and the drift is silent — a code with no entry renders as a bare
   * `STRIPE_SOMETHING` with no remedy beside it.
   */
  const railCodes = (): string[] => {
    const source = ['stripe.ts', 'koda.ts'].map((file) => readFileSync(join(SRC, file), 'utf8')).join('\n');
    const found = new Set<string>();
    for (const match of source.matchAll(/reject\(\s*\n?\s*new DomainError\(\s*\n?\s*'([A-Z_]+)'/g)) {
      found.add(match[1]!);
    }
    return [...found];
  };

  it('finds the refusals in the source rather than trusting a list', () => {
    const codes = railCodes();
    // A regex that silently matched nothing would make every assertion below
    // vacuous, which is the one way this invariant could pass while failing.
    assert.ok(codes.length >= 10, `only ${codes.length} refusal codes found in the rails — the scan is broken`);
    assert.ok(codes.includes('STRIPE_SIGNATURE_INVALID'));
    assert.ok(codes.includes('KODA_SIGNATURE_INVALID'));
  });

  it('explains each one, with a remedy and a verdict on the money', () => {
    for (const code of railCodes()) {
      const refusal = REFUSALS[code];
      assert.ok(refusal, `${code} is refused by a rail and has no entry in REFUSALS`);
      assert.ok(refusal.meaning.length > 40, `${code} has no real explanation`);
      assert.ok(refusal.remedy.length > 40, `${code} has no real remedy`);
      assert.equal(typeof refusal.moneyAtRisk, 'boolean');
    }
  });

  it('explains the two refusals the gateway decides, which no rail ever sees', () => {
    for (const code of ['UPLOAD_TOO_LARGE', 'RATE_LIMITED']) {
      assert.ok(REFUSALS[code], `${code} can refuse a delivery and is not explained`);
    }
  });

  it('names no secret and no signature anywhere in the table', () => {
    const serialised = JSON.stringify(REFUSALS);
    assert.ok(!serialised.includes(SECRET));
    assert.ok(!serialised.includes('whsec_test'));
  });
});

describe('the tally', () => {
  it('counts by code, so a mix of causes is visible rather than one number', () => {
    resetDelivery('CARD');
    recordRefused('CARD', 'STRIPE_SIGNATURE_INVALID');
    recordRefused('CARD', 'STRIPE_SIGNATURE_INVALID');
    recordRefused('CARD', 'STRIPE_TEST_EVENT');
    const health = deliveryHealth('CARD');
    assert.equal(health.rejected, 3);
    assert.deepEqual(health.byCode, { STRIPE_SIGNATURE_INVALID: 2, STRIPE_TEST_EVENT: 1 });
    assert.equal(dominantCode(health), 'STRIPE_SIGNATURE_INVALID');
  });

  it('keeps the first refusal as well as the last, so "since when" is answerable', () => {
    resetDelivery('CARD');
    recordRefused('CARD', 'STRIPE_SIGNATURE_STALE');
    recordRefused('CARD', 'STRIPE_SIGNATURE_INVALID');
    const health = deliveryHealth('CARD');
    assert.equal(health.lastRejection?.code, 'STRIPE_SIGNATURE_INVALID');
    assert.ok(health.firstRejectionAt, 'the first refusal was not kept');
    assert.ok(health.firstRejectionAt! <= health.lastRejection!.at);
  });

  it('hands out a copy, so a caller cannot move the count by holding it', () => {
    resetDelivery('CARD');
    recordRefused('CARD', 'STRIPE_SIGNATURE_INVALID');
    const held = deliveryHealth('CARD');
    held.rejected = 99;
    held.byCode.INVENTED = 5;
    const fresh = deliveryHealth('CARD');
    assert.equal(fresh.rejected, 1);
    assert.equal(fresh.byCode.INVENTED, undefined);
  });

  it('keeps the two rails apart', () => {
    resetDelivery('CARD');
    resetDelivery('MOBILE_MONEY');
    recordRefused('CARD', 'STRIPE_SIGNATURE_INVALID');
    recordAccepted('MOBILE_MONEY');
    assert.equal(deliveryHealth('CARD').rejected, 1);
    assert.equal(deliveryHealth('CARD').accepted, 0);
    assert.equal(deliveryHealth('MOBILE_MONEY').rejected, 0);
    assert.equal(deliveryHealth('MOBILE_MONEY').accepted, 1);
  });

  it('counts the unconfigured mobile-money rail, which used to refuse invisibly', async () => {
    // The card rail counted its own `STRIPE_UNCONFIGURED`; KODA threw past the
    // tally, so a mobile-money rail refusing every delivery for want of a key
    // reported nothing at all.
    const kodaConfig = config.koda as unknown as MutableSecrets;
    const before = { secretKey: kodaConfig.secretKey, webhookSecret: kodaConfig.webhookSecret };
    kodaConfig.secretKey = '';
    kodaConfig.webhookSecret = '';
    resetKodaWebhookHealth();
    try {
      const res = await fetch(`${base}/v1/webhooks/koda`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-koda-signature': 'anything' },
        body: '{}',
      });
      assert.equal(res.status, 503);
      const health = kodaWebhookHealth();
      assert.equal(health.rejected, 1, 'an unconfigured rail refused a delivery and did not count it');
      assert.equal(health.byCode.KODA_UNCONFIGURED, 1);
    } finally {
      kodaConfig.secretKey = before.secretKey;
      kodaConfig.webhookSecret = before.webhookSecret;
    }
  });
});

describe('refusals decided before the rail is reached', () => {
  it('counts a body over the ceiling, which never reaches verification', async () => {
    resetWebhookHealth();
    // 256KB is the route's ceiling. Refused as it arrives, in the gateway,
    // long before any signature is checked.
    const body = JSON.stringify({ padding: 'x'.repeat(300 * 1024) });
    const res = await fetch(`${base}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
      body,
    });
    assert.equal(res.status, 413);
    const health = webhookHealth();
    assert.equal(health.rejected, 1, 'an oversized delivery left the tally reading as a healthy, unused endpoint');
    assert.equal(health.byCode.UPLOAD_TOO_LARGE, 1);
  });

  it('does not count a rail refusal twice', async () => {
    resetWebhookHealth();
    const body = JSON.stringify({ id: 'evt_x', type: 'checkout.session.completed', livemode: true, data: { object: {} } });
    const res = await fetch(`${base}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body, 'whsec_a_different_secret') },
      body,
    });
    assert.equal(res.status, 400);
    const health = webhookHealth();
    // The rail counted it on the way out; the gateway must not count it again
    // as the error passes through.
    assert.equal(health.rejected, 1);
    assert.equal(health.byCode.STRIPE_SIGNATURE_INVALID, 1);
  });

  it('counts an accepted delivery once and leaves no refusal behind', async () => {
    resetWebhookHealth();
    const body = JSON.stringify({
      id: 'evt_ok',
      type: 'customer.created',
      livemode: true,
      data: { object: {} },
    });
    const res = await fetch(`${base}/v1/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sign(body) },
      body,
    });
    assert.equal(res.status, 201);
    const health = webhookHealth();
    assert.equal(health.accepted, 1);
    assert.equal(health.rejected, 0);
    assert.ok(health.lastAcceptedAt);
  });
});

describe('the shape of a secret, measured without reading it', () => {
  it('passes a correct Stripe signing secret', () => {
    const shape = webhookSecretShape();
    assert.equal(shape.present, true);
    assert.equal(shape.prefixOk, true);
    assert.equal(shape.padded, false);
    assert.equal(shape.quoted, false);
  });

  it('catches the API key pasted into the signing-secret variable', () => {
    const shape = secretShape('sk_live_51AbcdEfghIjklMnop', 'whsec_');
    assert.equal(shape.prefixOk, false);
  });

  it('catches a value that carried its quotes into the environment', () => {
    assert.equal(secretShape('"whsec_abc123"', 'whsec_').quoted, true);
    assert.equal(secretShape("'whsec_abc123'", 'whsec_').quoted, true);
  });

  it('reads the prefix inside the quotes, so one fault reports as one fault', () => {
    // Reported as both quoted and not-a-signing-secret, this sends somebody
    // looking for a second mistake that does not exist.
    const shape = secretShape('"whsec_abc123def456"', 'whsec_');
    assert.equal(shape.quoted, true);
    assert.equal(shape.prefixOk, true);
  });

  it('catches whitespace that survives an env file and breaks every signature', () => {
    assert.equal(secretShape('whsec_abc123\n', 'whsec_').padded, true);
    assert.equal(secretShape(' whsec_abc123', 'whsec_').padded, true);
  });

  it('asserts no prefix where the provider publishes none', () => {
    // KODA does not publish a signing-secret prefix. Inventing one would report
    // a perfectly good secret as malformed, which is worse than saying nothing.
    assert.equal(secretShape('some_koda_secret').prefixOk, undefined);
  });

  it('never carries the secret itself', () => {
    const serialised = JSON.stringify(secretShape(SECRET, 'whsec_'));
    assert.ok(!serialised.includes(SECRET));
    assert.ok(!serialised.includes('secret_for_the_suite'));
  });
});

describe('the verdict', () => {
  it('separates "nothing has arrived" from "everything is fine"', () => {
    const verdict = diagnose({ rail: 'CARD', configured: true, shape: goodShape(), health: blank() });
    assert.equal(verdict.state, 'NEVER_DELIVERED');
    // The old panel showed 0 and 0 here and read as health. It is not health:
    // it is the state a wrong endpoint URL produces.
    assert.ok(verdict.remedy.toLowerCase().includes('url'));
  });

  it('calls a rail healthy only once deliveries have verified', () => {
    const health = { ...blank(), accepted: 4 };
    const verdict = diagnose({ rail: 'CARD', configured: true, shape: goodShape(), health });
    assert.equal(verdict.state, 'HEALTHY');
    assert.equal(verdict.moneyAtRisk, false);
  });

  it('names the dominant refusal when every delivery fails', () => {
    const health = { ...blank(), rejected: 12, byCode: { STRIPE_SIGNATURE_STALE: 12 } };
    const verdict = diagnose({ rail: 'CARD', configured: true, shape: goodShape(), health });
    assert.equal(verdict.state, 'ALL_REFUSED');
    // The refusal a drifted container clock produces, and the remedy that fixes
    // it — not "check your signing secret", which is correct for a different code.
    assert.ok(verdict.because.includes('tolerance'));
    assert.ok(verdict.remedy.toLowerCase().includes('clock'));
    assert.equal(verdict.moneyAtRisk, true);
  });

  it('gives the test-mode refusal its own answer, which is that the rail is working', () => {
    const health = { ...blank(), rejected: 3, byCode: { STRIPE_TEST_EVENT: 3 } };
    const verdict = diagnose({ rail: 'CARD', configured: true, shape: goodShape(), health });
    assert.equal(verdict.state, 'ALL_REFUSED');
    assert.equal(verdict.moneyAtRisk, false, 'test money is not money at risk');
    assert.ok(verdict.remedy.toLowerCase().includes('live mode'));
  });

  it('treats a handful of refusals beside a working rail as the probes they are', () => {
    const health = { ...blank(), accepted: 30, rejected: 2, byCode: { STRIPE_SIGNATURE_MISSING: 2 } };
    const verdict = diagnose({ rail: 'CARD', configured: true, shape: goodShape(), health });
    assert.equal(verdict.state, 'SOME_REFUSED');
    assert.equal(verdict.moneyAtRisk, false);
  });

  it('blames a malformed secret before it blames the deliveries', () => {
    const health = { ...blank(), rejected: 40, byCode: { STRIPE_SIGNATURE_INVALID: 40 } };
    const verdict = diagnose({
      rail: 'CARD',
      configured: true,
      shape: secretShape('"whsec_abc"', 'whsec_'),
      health,
    });
    assert.equal(verdict.state, 'SECRET_MALFORMED');
    assert.ok(verdict.because.includes('quotes'));
    assert.equal(verdict.moneyAtRisk, true, '40 refusals and no acceptance is money at risk');
  });

  it('does not call a rail nothing has been sent to money at risk', () => {
    const verdict = diagnose({
      rail: 'CARD',
      configured: true,
      shape: secretShape('"whsec_abc123def456"', 'whsec_'),
      health: blank(),
    });
    assert.equal(verdict.state, 'SECRET_MALFORMED');
    assert.equal(verdict.moneyAtRisk, false, 'a badge that overstates risk is a badge people stop reading');
  });

  it('says an unkeyed rail is unkeyed rather than broken', () => {
    const verdict = diagnose({
      rail: 'CARD',
      configured: false,
      shape: secretShape('', 'whsec_'),
      health: blank(),
    });
    assert.equal(verdict.state, 'NOT_CONFIGURED');
    assert.equal(verdict.moneyAtRisk, false);
    assert.ok(verdict.remedy.includes('STRIPE_WEBHOOK_SECRET'));
  });

  it('carries no secret into the verdict', () => {
    const serialised = JSON.stringify(
      diagnose({ rail: 'CARD', configured: true, shape: goodShape(), health: blank() }),
    );
    assert.ok(!serialised.includes(SECRET));
  });
});
