import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { ROUTES } from '../src/api/routes.ts';
import { config } from '../src/config.ts';
import * as aiclearance from '../src/domain/aiclearance.ts';
import { tenderReadiness } from '../src/domain/tenderreadiness.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { issuerProfile, legalReadiness, setIssuerProfile } from '../src/group/profile.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Ready to tender: the five refusals a tender used to meet one at a time, read
 * up front, each by the same test the refusing command applies.
 */

let platform: Platform;
let seed: SeedResult;

const adapter: AIProviderAdapter = {
  name: 'OPENAI',
  capability: 'REASONING',
  multimodal: false,
  transmits: true,
  estimateCostMinor: () => 25,
  healthy: () => true,
  async execute(_request: ProviderRequest): Promise<ProviderResponse> {
    return { provider: 'OPENAI', modelClass: 'reasoning-standard', output: {}, rawCostMinor: 25, latencyMs: 5 };
  },
};

const gov = (who: string): EngineContext =>
  platform.context(seed.users[who]!.auth, `${seed.tenantId}-governance`, { correlationId: 'readiness-test' });
const item = (id: string) => tenderReadiness(platform, gov('qs')).items.find((entry) => entry.id === id)!;

before(async () => {
  for (const key of Object.keys(config.ai.providerClearance)) delete config.ai.providerClearance[key];
  platform = new Platform(new AIOrchestrator({ reasoning: adapter, perception: adapter }));
  seed = await seedDemoProject(platform);
});

describe('ready to tender', () => {
  it('reads all five, in the order a tender meets them, each with where it is fixed', () => {
    const readiness = tenderReadiness(platform, gov('qs'));
    assert.deepEqual(
      readiness.items.map((entry) => entry.id),
      ['COMPANY_FACTS', 'BRANDING', 'REGISTERED_DETAILS', 'NUMBERING', 'AI_CLEARANCE'],
    );
    for (const entry of readiness.items) assert.ok(entry.fix.screen && entry.fix.label, `${entry.id} names its fix`);
    assert.equal(readiness.ready, readiness.items.every((entry) => entry.ready));
  });

  it('applies the same tests the refusing commands apply', () => {
    assert.equal(item('COMPANY_FACTS').ready, Boolean(platform.ledger.get({ refType: 'CompanyProfile', refId: `${seed.tenantId}-profile` })));
    assert.equal(item('BRANDING').ready, platform.exports.brandingIfConfigured(seed.tenantId) !== undefined);
    const legal = legalReadiness(issuerProfile(platform, seed.tenantId));
    assert.equal(item('REGISTERED_DETAILS').ready, legal.complete);
    if (!legal.complete) assert.match(item('REGISTERED_DETAILS').detail, new RegExp(legal.missingLabels[0]!));
  });

  it('says a quotation cannot be issued until it has a numbering rule, and sees one once it is set', () => {
    const before = item('NUMBERING');
    if (before.ready) return; // a seed that already numbers quotations
    assert.match(before.detail, /cannot be issued/);
    setIssuerProfile(platform, seed.users.owner!.auth, {
      numberingRules: { ...issuerProfile(platform, seed.tenantId).numberingRules, quotation: { prefix: 'Q', pattern: '-{YYYY}-{seq:4}', seqScope: 'year' } },
    });
    assert.equal(item('NUMBERING').ready, true);
  });

  it('names the provider that is not cleared for commercial material, and sees the owner’s clearance at once', () => {
    const before = item('AI_CLEARANCE');
    assert.equal(before.ready, false);
    assert.match(before.detail, /OPENAI is not cleared for commercial material/);
    assert.equal(before.fix.screen, 'billing');
    aiclearance.grantClearance(gov('owner'), { provider: 'OPENAI', level: 'COMMERCIAL_L3', reason: 'Data processing addendum signed' });
    const after = item('AI_CLEARANCE');
    assert.equal(after.ready, true);
    assert.match(after.detail, /OPENAI may receive tender answers/);
  });

  it('is published on its own read route', () => {
    assert.ok(ROUTES.some((route) => route.method === 'GET' && route.pattern === '/v1/tender/readiness'));
  });
});
