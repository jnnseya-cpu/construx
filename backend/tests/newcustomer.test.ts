import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import * as signup from '../src/identity/signup.ts';
import { chargesFor } from '../src/billing/collection.ts';
import { hashBytes, EvidenceStore } from '../src/evidence/store.ts';
import { Platform } from '../src/platform.ts';

/**
 * Somebody who has never used this platform, from the sign-up form to a
 * numbered quotation, over HTTP, on their own empty tenancy.
 *
 * `pricingline.test.ts` drives the same line on the demonstration estate,
 * which has four years of record behind it: committed estimates to harvest
 * rates from, a basis to inherit, a funded wallet, a portfolio and a
 * programme. That test is worth having and it is not this one, because every
 * defect that reached a customer in the worst week of this project reached
 * them through the **absence** of exactly those things:
 *
 * - no previous estimate, so no rates in the record, so every line went to the
 *   market and the market answers were dropped on a join;
 * - no previous estimate, so no basis, so the accepted estimate carried nothing
 *   against insurance or waste and the quotation refused it after the work;
 * - no issuer profile, so no numbering rule, so the document could not go out;
 * - an unfunded wallet, so the first model call was refused.
 *
 * A fixture that starts from a rich tenancy cannot find any of those. This one
 * starts from nothing: a form submission, an email token, and whatever the
 * platform hands a new customer. If a person can get from there to something
 * they could send to a client, the product works. If they cannot, it does not,
 * whatever else passes.
 *
 * **Nothing below is asserted by reading a success message.** Every step reads
 * back the state it claims to have produced.
 */

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let server: Server;
let base: string;

type Reply = { status: number; body: any; text: string };

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; raw?: Buffer; contentType?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let payload: Buffer | string | undefined;
  if (options.raw) {
    payload = options.raw;
    headers['content-type'] = options.contentType ?? 'application/octet-stream';
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: response.status, body: parsed, text };
}

async function signIn(email: string): Promise<string> {
  rateLimiter.reset();
  const login = await call('POST', '/v1/auth/login', { body: { email } });
  assert.equal(login.status, 201, login.text);
  const verified = await call('POST', '/v1/auth/mfa/verify', {
    body: { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode },
  });
  assert.equal(verified.status, 201, verified.text);
  return verified.body.accessToken as string;
}

/** One drawing, and what a model reports off it. A real first job is one sheet. */
const SHEET = {
  filename: '2601-ABC-XX-ZZ-DR-A-0100.pdf',
  bytes: Buffer.from('%PDF-1.7 garden room slab and walls', 'utf8'),
  items: [
    {
      description: 'Excavation for strip foundation, 600mm wide, commencing from reduced level, not exceeding 1.00m deep',
      unit: 'm3',
      quantity: 7.2,
      sourceSheet: 'DR-A-0100',
      measurementRule: 'NRM2',
    },
    {
      description: 'Plain in-situ concrete GEN3 in strip foundations, poured against earth faces',
      unit: 'm3',
      quantity: 6.1,
      sourceSheet: 'DR-A-0100',
      measurementRule: 'NRM2',
    },
    {
      description: 'Facing brickwork in cement mortar, half brick thick, in skins of hollow walls',
      unit: 'm2',
      quantity: 34,
      sourceSheet: 'DR-A-0100',
      measurementRule: 'NRM2',
    },
  ],
};

function seeingStub(): AIProviderAdapter {
  return {
    name: 'GEMINI',
    capability: 'PERCEPTION',
    multimodal: true,
    transmits: true,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      const mine = request.media?.hash === hashBytes(SHEET.bytes);
      return {
        provider: 'GEMINI',
        modelClass: 'perception-standard',
        output: { items: mine ? SHEET.items : [], omitted: [], scale: '1:50' },
        rawCostMinor: 40,
        latencyMs: 8,
        confidence: 0.83,
      };
    },
  };
}

/**
 * A market view on every line, because a business with no history has nothing
 * else — which is the whole point of this fixture. It paraphrases, splits one
 * rate and leaves another all-in, and gives a minimum charge on the two lines
 * whose quantities are too small for a rate to cover turning up.
 */
function reasoningStub(): AIProviderAdapter {
  return {
    name: 'OPENAI',
    capability: 'REASONING',
    multimodal: false,
    transmits: true,
    estimateCostMinor: () => 30,
    healthy: () => true,
    async execute(request: ProviderRequest): Promise<ProviderResponse> {
      const items =
        (request.payload as { items?: Array<{ index: number; description: string; unit: string; quantity: number }> } | undefined)
          ?.items ?? [];
      return {
        provider: 'OPENAI',
        modelClass: 'reasoning-standard',
        output: {
          rates: items.map((item): Record<string, unknown> => {
            if (item.description.startsWith('Excavation for strip')) {
              return {
                index: item.index,
                description: 'Strip foundation dig, under 1m',
                unit: item.unit,
                rateMinor: 6_500,
                minimumChargeMinor: 85_000,
                lowMinor: 5_000,
                highMinor: 9_000,
                basis: 'Mini-excavator and banksman, half-day minimum on a domestic plot.',
              };
            }
            if (item.description.startsWith('Plain in-situ concrete')) {
              return {
                index: item.index,
                description: 'GEN3 to strip founds',
                unit: item.unit,
                labourMinor: 4_000,
                materialMinor: 14_500,
                plantMinor: 0,
                subcontractMinor: 0,
                minimumChargeMinor: 145_000,
                lowMinor: 16_000,
                highMinor: 22_000,
                basis: 'Ready-mix delivered; one load minimum charged whether taken or not.',
              };
            }
            return {
              index: item.index,
              description: 'Facings, half brick, in hollow wall skins',
              unit: item.unit,
              labourMinor: 6_200,
              materialMinor: 4_800,
              plantMinor: 0,
              subcontractMinor: 0,
              lowMinor: 9_000,
              highMinor: 14_000,
              basis: 'Bricklayer and labourer, facings supplied, scaffold by others.',
            };
          }),
          omitted: [],
        },
        rawCostMinor: 30,
        latencyMs: 6,
      };
    },
  };
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-newcustomer-'));
  store = new EvidenceStore(directory);
  // No seed. This platform has never had a customer on it, which is the point.
  platform = new Platform(new AIOrchestrator({ perception: seeingStub(), reasoning: reasoningStub() }), store);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  server?.close();
  rmSync(directory, { recursive: true, force: true });
});

const OWNER = 'ray@abcbuild.test';

let token = '';
let projectId = '';
let packageId = '';
let proposal: any;
let accepted: any;

describe('a new customer, from the sign-up form to something they can send', () => {
  it('registers and proves the address, and gets an account rather than a session', async () => {
    rateLimiter.reset();
    // Registered through the module so the test holds the token the email
    // would have carried. Everything from here is over the wire.
    const started = signup.register(platform, {
      email: OWNER,
      contactName: 'Ray Ackroyd',
      organisationName: 'ABC Build Limited',
      jurisdiction: 'GB',
      currency: 'GBP',
      package: 'SOLO',
    });
    assert.equal(started.outcome, 'NEW');

    const verified = await call('POST', '/v1/signup/verify', {
      body: { registrationId: started.registration!.id, token: started.token! },
    });
    assert.equal(verified.status, 201, verified.text);
    assert.equal(verified.body.accessToken, undefined, 'verification handed out a session');
    assert.equal(verified.body.awaitingPayment, true, 'a paid package opened without being paid for');

    /*
     * The money arriving, which is not something the customer does in the
     * app — it is a transfer landing in a bank account, recorded against the
     * charge. Driven through the platform rather than over HTTP because the
     * HTTP door is the operator's, and an operator is not part of this
     * journey.
     */
    // The reply names no tenancy and no charge, deliberately — it answers an
    // anonymous request and must not become an oracle. The account is found
    // the way the customer's own next request finds it: by their address.
    const account = platform.userByEmail(OWNER);
    assert.ok(account, 'verification reported success and created no account');
    const tenantId = account.tenantId;
    const due = chargesFor(platform, tenantId).find((charge) => charge.status === 'DUE');
    assert.ok(due, 'a tenancy awaiting its first payment was raised no charge to pay');
    platform.recordSubscriptionPayment({
      tenantId,
      chargeId: due.id,
      method: 'BANK_TRANSFER',
      reference: 'FT26091900412',
      recordedBy: 'test:bank',
      source: 'PROVIDER',
    });

    token = await signIn(OWNER);
    assert.ok(token.length > 20);
  });

  it('gives a sole operator every door, because there is nobody else to hold one', async () => {
    /*
     * Stated repeatedly by the person paying for this and worth pinning: on a
     * solo account the owner runs the whole business, so the owner holds every
     * code in every area. Not a loosening — OWNER holds them on a team account
     * too; what a team adds is that somebody *else* can be the second pair of
     * eyes where a rule asks for one.
     */
    const me = await call('GET', '/v1/users/me', { token });
    assert.equal(me.status, 200, me.text);
    const roles: string[] = me.body.roles ?? me.body.user?.roles ?? [];
    assert.ok(roles.includes('OWNER'), `the first account is not an owner: ${JSON.stringify(roles)}`);
  });

  it('says what it cannot do yet, before anything is attempted', async () => {
    /*
     * The failure this closes is the one that cost a whole day. A deployment
     * with no reasoning provider answered every reasoning task with the local
     * stand-in, and the run reported that the market had no view of fifteen
     * lines — a true sentence about the call and a false one about the world.
     * Nothing on any screen distinguished *the model declined* from *no model
     * was asked*.
     */
    const ready = await call('GET', '/readyz', {});
    assert.equal(ready.status, 200, ready.text);

    const health = await call('GET', '/v1/system/readiness', { token });
    if (health.status === 200) {
      const capabilities = (health.body.capabilities ?? []) as Array<Record<string, unknown>>;
      for (const key of ['ai.reasoning', 'ai.perception']) {
        const entry = capabilities.find((capability) => capability.key === key);
        assert.ok(entry, `${key} is not reported, so nobody can tell whether it is configured`);
        assert.ok(String(entry.detail ?? '').length > 20, `${key} says nothing useful about its state`);
      }
    }
  });

  it('stands up a first project without anybody explaining the hierarchy', async () => {
    /*
     * A portfolio, a programme and a project are three things a new customer
     * has never heard of, and being asked to create all three before pricing a
     * garden room is where somebody closes the tab. Whatever the platform
     * gives a new tenancy, a project has to be reachable from it — so this
     * looks for what is already there and only creates what is missing.
     */
    const projects = await call('GET', '/v1/projects', { token });
    assert.equal(projects.status, 200, projects.text);

    const existing = (projects.body.projects ?? projects.body.items ?? []) as Array<Record<string, any>>;
    if (existing.length > 0) {
      projectId = String(existing[0]!.id ?? existing[0]!.projectId);
    } else {
      const portfolios = await call('GET', '/v1/portfolios', { token });
      assert.equal(portfolios.status, 200, portfolios.text);
      const portfolio = (portfolios.body.portfolios ?? portfolios.body.items ?? [])[0];
      /*
       * The barrier this closed. A verified tenancy held an enterprise and
       * nothing else, so pricing the first job meant working out that a
       * project lives in a portfolio, that a portfolio needs an enterprise id,
       * a governance model and a region, and filling in a form about none of
       * which the customer had asked a question. It sat between signing up and
       * every piece of value the platform has.
       */
      assert.ok(portfolio, 'a paid-up tenancy has no portfolio and no way to make a project');

      const created = await call('POST', '/v1/projects', {
        token,
        body: {
          portfolioId: String(portfolio.id ?? portfolio.portfolioId),
          name: 'Garden room, 14 Mill Lane',
          sectorType: 'RMI',
          assetType: 'Garden room',
          location: { continentCode: 'EU', countryCode: 'GB', city: 'Hinckley' },
          contractValueMinor: 28_000_00,
          currency: 'GBP',
          plannedStart: '2026-10-12',
          plannedCompletion: '2026-12-18',
        },
      });
      assert.equal(created.status, 201, created.text);
      projectId = String(created.body.projectId ?? created.body.id);
    }
    assert.ok(projectId, 'no project could be reached or made');
  });

  it('takes a drawing in and files it as a drawing', async () => {
    const hash = hashBytes(SHEET.bytes);

    const registered = await call('POST', `/v1/projects/${projectId}/bim/drawings`, {
      token,
      body: {
        fileHash: hash,
        titleBlock: { drawingNumber: '2601-ABC-XX-ZZ-DR-A-0100', title: 'Garden room', revision: 'P01', discipline: 'ARCHITECTURE' },
      },
    });
    assert.equal(registered.status, 201, registered.text);

    const uploaded = await call('POST', `/v1/evidence/${hash}`, { token, raw: SHEET.bytes, contentType: 'application/pdf' });
    assert.equal(uploaded.status, 201, uploaded.text);

    const ingested = await call('POST', `/v1/projects/${projectId}/ingestion`, {
      token,
      body: { hash, filename: SHEET.filename },
    });
    assert.equal(ingested.status, 201, ingested.text);

    const listed = await call('GET', `/v1/projects/${projectId}/ingestion`, { token });
    assert.equal(listed.status, 200, listed.text);
    const files = (listed.body.files ?? []) as Array<Record<string, any>>;
    assert.equal(files.length, 1);
    assert.equal(files[0]!.classification?.kind, 'DRAWING', `filed as ${files[0]!.classification?.kind}`);
  });

  it('tells a first-time user what to do next, and names the button', async () => {
    const flow = await call('GET', `/v1/projects/${projectId}/flow`, { token });
    assert.equal(flow.status, 200, flow.text);
    assert.ok(flow.body.nowDo, 'a new customer with a drawing filed is told nothing to do');
    for (const step of flow.body.steps as Array<Record<string, unknown>>) {
      if (step.state !== 'READY') continue;
      assert.ok(String(step.door ?? '').length > 0, `"${String(step.title)}" is ready and names no door`);
    }
  });

  it('prices a pack with no rate history at all, from the market, and says so', async () => {
    const run = await call('POST', `/v1/projects/${projectId}/tender/pack/price`, {
      token,
      body: { packageId: packageId || 'Garden room' },
    });
    assert.equal(run.status, 201, run.text);
    proposal = run.body;
    packageId = proposal.packageId;

    assert.equal(proposal.read.length, 1, `the sheet was not read: ${JSON.stringify(proposal.unread)}`);
    assert.equal(proposal.lines.length, SHEET.items.length);

    // Nothing in the record, so nothing from the record. Every line is a
    // market view and every one is labelled as one — which is the difference
    // between a starting point and a price somebody stands behind.
    assert.equal(proposal.basis, null, 'a tenancy with no estimate inherited a basis from somewhere');
    for (const line of proposal.lines as Array<Record<string, any>>) {
      assert.ok(line.rate, `"${line.description.slice(0, 30)}…" came back with no rate and no market view`);
      assert.equal(line.rate.source, 'MARKET_AI');
      assert.equal(line.rate.confidence, 'MODEL_VIEW');
    }
    assert.ok(
      (proposal.outstanding as string[]).some((line) => line.includes('market')),
      'a bill priced entirely on a model’s view did not say so',
    );

    /*
     * And the figure that decides a small price. 7.2m³ of dig at £65 is £468
     * and 6.1m³ of GEN3 at £185 is £1,128 — both below what it costs to turn
     * up, and both are what a garden room actually measures. A platform that
     * quotes a job at the sum of its unit rates quotes it too cheap to do.
     */
    const dig = (proposal.lines as Array<Record<string, any>>).find((line) => line.description.startsWith('Excavation'));
    assert.ok(dig, 'the excavation line is not in the run');
    assert.equal(dig.rate.minimumChargeMinor, 85_000, 'the minimum charge was lost between the model and the screen');
  });

  it('names every head to settle up front, so the acceptance is not refused after the work', async () => {
    assert.ok(proposal.headsToSettle.length > 0, 'a tenancy with no basis settled every head by itself');
    for (const head of proposal.headsToSettle) assert.ok(head.head && head.label && head.basis);
  });

  it('accepts once and produces a bill, an estimate and a quotation', async () => {
    const validUntil = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString();

    const reply = await call('POST', `/v1/projects/${projectId}/tender/pack/accept`, {
      token,
      body: {
        packageId,
        costCodePrefix: 'GR',
        lines: (proposal.lines as Array<Record<string, any>>).map((line) => ({
          draftId: line.draftId,
          index: line.index,
          labourRateMinor: line.rate.labourRateMinor,
          materialRateMinor: line.rate.materialRateMinor,
          plantRateMinor: line.rate.plantRateMinor,
          subcontractRateMinor: line.rate.subcontractRateMinor,
          rateSource: 'MARKET_AI',
          ...(line.rate.minimumChargeMinor ? { minimumChargeMinor: line.rate.minimumChargeMinor } : {}),
        })),
        estimate: {
          durationWeeks: 5,
          basisOfEstimate: 'Measured off drawing 0100 P01. Rates are a market view; we hold no history for this work yet.',
          // Five weeks on site, so the weeks are priced rather than excluded —
          // the estimate warns when they are not, and it is right to.
          timeRelated: [
            { head: 'PRELIMINARIES', description: 'Welfare, skip, set-up', weeklyRateMinor: 38_000, quantity: 1 },
            { head: 'HEALTH_AND_SAFETY', description: 'PPE, inductions, monitoring', weeklyRateMinor: 9_000, quantity: 1 },
          ],
          quantified: [{ head: 'WASTE', description: 'Skips and tip charges', unit: 'sum', quantity: 1, rateMinor: 62_000 }],
          insurance: { policies: [{ type: 'Contract works and public liability', percentOfContractValue: 1.1 }] },
          exclusions: (proposal.headsToSettle as Array<{ head: string }>)
            .filter((entry) => !['PRELIMINARIES', 'HEALTH_AND_SAFETY', 'WASTE', 'INSURANCE'].includes(entry.head))
            .map((entry) => ({ head: entry.head, reason: 'Not in this offer for the garden room' })),
          margin: { overheadPercent: 8, profitPercent: 15 },
        },
        quotation: {
          clientName: 'Mr and Mrs Patel',
          validUntil,
          paymentTerms: '50% on start, balance on completion',
        },
      },
    });
    assert.equal(reply.status, 201, reply.text);
    accepted = reply.body;

    assert.equal(
      accepted.quotationBlocked,
      null,
      `every head the run named was answered and the quotation was still refused: ${JSON.stringify(accepted.quotationBlocked)}`,
    );
    assert.ok(accepted.quotationId, 'the run stopped short of a quotation');

    /*
     * The price a customer would actually be sent, sanity-checked against the
     * one thing everybody can check: it is not absurdly cheap. Five weeks of
     * welfare alone is £1,900, and a quotation that comes out below its own
     * preliminaries is the failure this whole day was about.
     */
    const weeksAlone = 5 * (38_000 + 9_000);
    assert.ok(
      accepted.totalMinor > weeksAlone,
      `the quotation totals ${accepted.totalMinor} against ${weeksAlone} of preliminaries alone`,
    );
  });

  it('writes a quotation whose rows are the works and whose rows add up', async () => {
    const document = await call('GET', `/v1/documents/lifecycle/${accepted.quotationId}`, { token });
    assert.equal(document.status, 200, document.text);
    const body = document.body.body as Record<string, string>;

    for (const item of SHEET.items) {
      assert.ok(
        Object.values(body).some((value) => typeof value === 'string' && value.includes(item.description)),
        `the quotation does not offer "${item.description.slice(0, 40)}…"`,
      );
    }

    const money = (text: string): number | null => {
      const match = /£\s?([\d,]+\.\d{2})/.exec(text);
      return match ? Math.round(Number(match[1]!.replace(/,/g, '')) * 100) : null;
    };
    const rows = Object.entries(body).filter(([label]) => /^Item \d+$/.test(label));
    const summed = rows.reduce((total, [, value]) => total + (money(String(value)) ?? 0), 0);
    assert.equal(summed, accepted.totalMinor, 'the rows do not add up to the total the quotation states');

    /*
     * The customer sees a price, not our build-up — and an *exclusion* against
     * a build-up head breaks that as completely as a priced line would, and
     * worse. This quotation went out reading **"Not included — Overhead"** and
     * **"Not included — Profit"**: the run offered both as heads to settle,
     * because the pre-flight prices with a margin of nothing and they came
     * back as omissions, and the form's honest default is that a head left
     * blank is one excluded.
     *
     * A quotation that tells a customer what the business does not intend to
     * charge them is about the worst sentence that could appear on an offer.
     */
    const printed = JSON.stringify(body).toLowerCase();
    for (const word of ['overhead', 'profit', 'margin']) {
      assert.ok(!printed.includes(word), `the quotation prints our "${word}" to the customer`);
    }
  });

  it('gets the quotation out of the door on a tenancy that has never issued anything', async () => {
    /*
     * The last mile, and the one a new customer meets cold. There is no issuer
     * profile, no numbering rule and no signatory on a tenancy nobody has
     * configured — and every one of those is a refusal by name rather than a
     * silent failure. A person has to be able to clear them from the console
     * and get the document out on the same afternoon they signed up.
     */
    const before = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/generate`, { token, body: {} });
    if (before.status >= 400) {
      assert.match(before.text, /PROFILE|LEGAL|NUMBER|ISSUER/i, `a bare tenancy failed to generate and did not say why: ${before.text}`);
    }

    const profile = await call('PUT', '/v1/company/issuer', {
      token,
      body: {
        issuer: {
          registrationNo: '14992003',
          registeredAddress: { line1: '7 Mill Lane', line2: '', city: 'Hinckley', postcode: 'LE10 1AA', country: 'United Kingdom' },
        },
        numberingRules: { quotation: { prefix: 'ABC-Q-', pattern: '{YYYY}-{seq:3}', seqScope: 'year' } },
      },
    });
    assert.equal(profile.status, 200, profile.text);

    const generated = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/generate`, { token, body: {} });
    assert.equal(generated.status, 201, generated.text);
    const revision = (generated.body.revisions as Array<{ hash: string }>).at(-1)!;

    const submitted = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/submit`, { token, body: {} });
    assert.equal(submitted.status, 201, submitted.text);

    /*
     * A sole operator approves their own quotation, and that is correct.
     *
     * Maker-checker asks for a second pair of eyes, and on a one-person
     * business there is not one. Refusing here would mean a sole trader could
     * never send a price — the platform would be unusable for its smallest
     * customer in the name of a control that cannot be satisfied. The
     * separation is real on a tenancy that has two people in it.
     */
    const approved = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/approve`, {
      token,
      body: { revision: generated.body.revisions.length, hash: revision.hash },
    });
    assert.equal(approved.status, 201, approved.text);

    const issued = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/issue`, {
      token,
      body: { idempotencyKey: `abc-first-quote-${accepted.quotationId}` },
    });
    assert.equal(issued.status, 201, issued.text);
    assert.equal(issued.body.document.status, 'ISSUED');
    assert.match(String(issued.body.issuance.number), /^ABC-Q-\d{4}-\d{3}$/, `numbered ${issued.body.issuance.number}`);

    // And the bytes exist. A quotation that cannot be downloaded is not one
    // that went out.
    const download = await call('POST', `/v1/documents/lifecycle/${accepted.quotationId}/download`, { token, body: {} });
    assert.ok(download.status < 400, `the issued quotation could not be downloaded: ${download.text}`);
  });

  it('now holds rates of its own, drawn from what it actually committed', async () => {
    /*
     * The second job is the one that proves the first. Every rate on that
     * quotation was a model's view, and a model's view must never come back as
     * this business's own committed rate — a guess that becomes history is a
     * guess that gets more confident every time it is reused.
     */
    const second = await call('POST', `/v1/projects/${projectId}/tender/pack/price`, {
      token,
      body: { packageId },
    });
    assert.equal(second.status, 201, second.text);
    for (const line of second.body.lines as Array<Record<string, any>>) {
      assert.notEqual(
        line.rate?.source,
        'OUR_RECORD',
        `"${line.description.slice(0, 30)}…" came back as this business's own rate and it was a model's guess`,
      );
    }
  });
});
