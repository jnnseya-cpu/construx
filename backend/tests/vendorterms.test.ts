import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { clearanceFor, retentionFor, retentionStatement } from '../src/ai/sensitivity.ts';
import { resetDeclaredVendorTerms } from '../src/ai/vendorterms.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * What the agreement with an AI vendor says, declared from the console.
 *
 * Two facts decide whether the platform may hand a customer's record to a third
 * party: what that vendor is cleared to receive, and what it does with it
 * afterwards. Neither is knowable from the software. Both lived in `.env`,
 * which meant the refusal a bid manager meets on the afternoon of a return —
 * *"AI_CLEARANCE_REQUIRED until AI_PROVIDER_CLEARANCE names your vendor at
 * COMMERCIAL_L3"* — could only be cleared by somebody with SSH and a container
 * restart, and the record of the decision was a string in a file with nobody's
 * name on it.
 *
 * These assert the three properties that make moving it to the console an
 * improvement rather than a loosening:
 *
 *   - **it actually takes effect**, in the function the gate reads;
 *   - **nothing above internal is cleared on an unanswered question** — the
 *     agreement, the region and the training term are asked for, because a
 *     reassurance on a screen with no contract behind it is worse than the
 *     refusal it replaces;
 *   - **it is on the chain**, with who, when and which agreement — which an
 *     environment variable answers none of.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

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

async function call(method: string, path: string, token: string, payload?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (payload !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, text };
}

const COMPLETE = {
  clearance: 'COMMERCIAL_L3' as const,
  retention: { route: 'ZERO', region: 'eu-west', trainingExcluded: true },
  agreementReference: 'Enterprise agreement, zero-retention addendum, 14 Oct 2026',
  reason: 'Zero-retention addendum signed and EU processing confirmed in writing',
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server.close();
  // The overlay is process-wide, so a test that left a vendor cleared would
  // clear it for every suite that runs after this one in the same process.
  resetDeclaredVendorTerms();
});

describe('a vendor’s terms, declared from the console', () => {
  it('starts undeclared, which is an answer and not a comfortable one', () => {
    assert.equal(retentionFor('OPENAI').route, 'NOT_DECLARED');
    assert.match(retentionStatement('OPENAI', true), /Nobody has declared what OPENAI does with it/);
    // INTERNAL is the deliberate middle: ordinary project work runs, and the
    // three categories that matter are refused until somebody says otherwise.
    assert.equal(clearanceFor('OPENAI'), 'INTERNAL');
  });

  it('takes effect in the function the gate actually reads', () => {
    platform.declareVendorTerms({ ...COMPLETE, provider: 'OPENAI', decidedBy: seed.users.operator!.id });

    assert.equal(clearanceFor('OPENAI'), 'COMMERCIAL_L3');
    assert.equal(retentionFor('OPENAI').route, 'ZERO');
    assert.equal(retentionFor('OPENAI').region, 'eu-west');
    assert.equal(retentionFor('OPENAI').trainingExcluded, true);
    // And in the sentence a person reads before the button.
    const statement = retentionStatement('OPENAI', true);
    assert.match(statement, /keeps nothing/);
    assert.match(statement, /Processed in eu-west/);
    assert.match(statement, /excludes it from model training/);
  });

  it('leaves the vendors nobody declared exactly as they were', () => {
    assert.equal(clearanceFor('GEMINI'), 'INTERNAL');
    assert.equal(retentionFor('GEMINI').route, 'NOT_DECLARED');
  });

  describe('and nothing above internal is cleared on an unanswered question', () => {
    const attempt = (over: Record<string, unknown>) =>
      platform.declareVendorTerms({
        provider: 'ANTHROPIC',
        clearance: 'COMMERCIAL_L3',
        retention: { route: 'ZERO', region: 'eu-west', trainingExcluded: true },
        agreementReference: 'Data processing agreement, 2026',
        decidedBy: seed.users.operator!.id,
        reason: 'Clearing the failover vendor for commercial material',
        ...over,
      });

    it('refuses it with no agreement named', () => {
      throwsCode(() => attempt({ agreementReference: '' }), 'AGREEMENT_REQUIRED');
    });

    it('refuses it with no processing region', () => {
      throwsCode(() => attempt({ retention: { route: 'ZERO', trainingExcluded: true } }), 'AGREEMENT_REQUIRED');
    });

    it('refuses it with the training question unanswered', () => {
      throwsCode(() => attempt({ retention: { route: 'ZERO', region: 'eu-west' } }), 'AGREEMENT_REQUIRED');
    });

    it('names every missing answer at once, not the first one', () => {
      assert.throws(
        () => attempt({ agreementReference: '', retention: { route: 'NOT_DECLARED' } }),
        (error: unknown) => {
          const fields = (error as { fieldErrors: Array<{ field: string }> }).fieldErrors.map((entry) => entry.field);
          assert.deepEqual(fields.sort(), ['agreementReference', 'region', 'retentionRoute', 'trainingExcluded']);
          return true;
        },
      );
    });

    it('refuses a period that is not stated, where the route keeps it for one', () => {
      throwsCode(
        () => attempt({ retention: { route: 'TRANSIENT', region: 'eu-west', trainingExcluded: true } }),
        'RETENTION_DAYS_REQUIRED',
      );
    });

    it('asks none of it below internal, where nothing sensitive is at stake', () => {
      const terms = platform.declareVendorTerms({
        provider: 'GEMINI',
        clearance: 'PUBLIC',
        retention: { route: 'NOT_DECLARED' },
        agreementReference: '',
        decidedBy: seed.users.operator!.id,
        reason: 'Public material only until the terms are read',
      });
      assert.equal(terms.clearance, 'PUBLIC');
      assert.equal(clearanceFor('GEMINI'), 'PUBLIC');
    });

    it('still refuses the declaration nobody could act on', () => {
      throwsCode(
        () =>
          platform.declareVendorTerms({
            provider: 'ANTHROPIC',
            clearance: 'SOMETHING_ELSE' as never,
            retention: { route: 'ZERO' },
            agreementReference: 'x',
            decidedBy: seed.users.operator!.id,
            reason: 'A level that is not one',
          }),
        'CLEARANCE_UNKNOWN',
      );
    });
  });

  it('is on the chain, with who, when and which agreement', () => {
    const events = platform.ledger.events().filter((event) => event.eventType === 'PLATFORM_VENDOR_TERMS_DECLARED');
    assert.ok(events.length > 0, 'declaring a vendor’s terms wrote nothing to the chain');

    const record = platform.ledger.get({ refType: 'VendorTerms', refId: 'OPENAI' })!;
    const state = record.state as { agreementReference: string; declaredBy: string; clearance: string };
    assert.equal(state.clearance, 'COMMERCIAL_L3');
    assert.equal(state.declaredBy, seed.users.operator!.id);
    assert.match(state.agreementReference, /zero-retention addendum/);

    // Never an agent's. An agent clearing a vendor to receive privileged
    // material is the one act this whole mechanism exists to make impossible.
    assert.notEqual(lookupEventType('PLATFORM_VENDOR_TERMS_DECLARED')?.aiAllowed, true);
    assert.equal(classifyEntity('VendorTerms')?.area, 'PLATFORM_ADMINISTRATION');
  });

  it('is the operator’s and nobody else’s', async () => {
    for (const who of ['admin', 'pm']) {
      const read = await call('GET', '/v1/admin/vendor-terms', tokenFor(who));
      assert.equal(read.status, 403, `${who} could read the vendor register`);
      const write = await call('POST', '/v1/admin/vendor-terms/OPENAI', tokenFor(who), {
        clearance: 'LEGAL_L4',
        retentionRoute: 'ZERO',
        region: 'eu-west',
        trainingExcluded: true,
        agreementReference: 'Trying it on',
        reason: 'Trying it on from a customer tenancy',
      });
      assert.equal(write.status, 403, `${who} could declare a vendor’s terms`);
    }
    // Unchanged by the attempts.
    assert.equal(clearanceFor('OPENAI'), 'COMMERCIAL_L3');
  });

  it('lists every provider, declared or not, because silence reads as yes', async () => {
    const reply = await call('GET', '/v1/admin/vendor-terms', tokenFor('operator'));
    assert.equal(reply.status, 200);
    const names = reply.body.vendors.map((entry: { provider: string }) => entry.provider);
    assert.deepEqual(names.slice().sort(), ['ANTHROPIC', 'GEMINI', 'OPENAI']);
    const anthropic = reply.body.vendors.find((entry: { provider: string }) => entry.provider === 'ANTHROPIC');
    assert.equal(anthropic.declared, false, 'a vendor nobody declared is reported as declared');
    assert.equal(anthropic.clearance, 'INTERNAL');
  });

  it('refuses a vendor this platform cannot call', async () => {
    const reply = await call('POST', '/v1/admin/vendor-terms/MISTRAL', tokenFor('operator'), {
      clearance: 'INTERNAL',
      retentionRoute: 'ZERO',
      agreementReference: '',
      reason: 'A vendor that is not wired up',
    });
    assert.equal(reply.status, 404);
    assert.equal(reply.body.title, 'PROVIDER_UNKNOWN');
    assert.match(reply.body.detail, /would change nothing/);
  });

  it('says what it changed, in the terms somebody asked the question in', async () => {
    const reply = await call('POST', '/v1/admin/vendor-terms/ANTHROPIC', tokenFor('operator'), {
      clearance: 'COMMERCIAL_L3',
      retentionRoute: 'TRANSIENT',
      days: 30,
      region: 'eu-west',
      trainingExcluded: true,
      agreementReference: 'Commercial terms, 2026, clause 9',
      reason: 'Failover vendor cleared on the same terms as the primary',
    });
    assert.equal(reply.status, 201);
    assert.match(reply.body.effect, /may now be handed commercial l3 material/);
    assert.match(reply.body.statement, /30 days/);
  });
});
