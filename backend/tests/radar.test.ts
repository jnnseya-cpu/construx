import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import * as radar from '../src/domain/radar.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Tender radar.
 *
 * The value is not in finding more opportunities. It is in not reading the ones
 * that were never winnable, so the tests that matter are about what it refuses
 * and why — and about the one thing it must never do, which is claim a
 * capability the company has not recorded.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = () => platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });

const profile = (over: Partial<radar.CompanyProfile> = {}): radar.CompanyProfile => ({
  legalName: 'Test Contractor Ltd',
  turnoverMinorByYear: [8_000_000_00, 7_000_000_00],
  netAssetsMinor: 1_500_000_00,
  workingCapitalMinor: 400_000_00,
  regions: ['Manchester', 'Leeds'],
  sectors: ['TRANSPORT'],
  cpvCodes: ['45232400'],
  valueBandMinor: { min: 200_000_00, max: 4_000_000_00 },
  insurances: [
    { type: 'Public liability', limitMinor: 1_000_000_000 },
    { type: 'Employers liability', limitMinor: 1_000_000_000 },
  ],
  accreditations: ['CHAS', 'ISO 9001'],
  references: [
    { clientName: 'A Water Co', projectName: 'Pumping station', sector: 'TRANSPORT', valueMinor: 900_000_00, completedYear: 2024, verified: true },
    { clientName: 'B Council', projectName: 'Depot', sector: 'COMMERCIAL', valueMinor: 300_000_00, completedYear: 2023, verified: false },
  ],
  selfDeliveredTrades: ['GROUNDWORKS', 'CONCRETE'],
  targetMarginPercent: { min: 8, max: 12 },
  capacity: { concurrentProjects: 6, committedProjects: 3 },
  ...over,
});

const notice = (over: Partial<radar.OpportunityNotice> = {}): radar.OpportunityNotice => ({
  reference: 'FTS-1',
  title: 'Pumping station refurbishment',
  clientName: 'A Water Co',
  region: 'Manchester',
  sector: 'TRANSPORT',
  cpvCodes: ['45232400'],
  estimatedValueMinor: 1_200_000_00,
  durationWeeks: 30,
  deadline: '2026-06-01',
  scope: 'Refurbishment of the inlet works',
  estimatedBidders: 4,
  source: 'Find a Tender',
  ...over,
});

const screen = (p: Partial<radar.CompanyProfile> = {}, n: Partial<radar.OpportunityNotice> = {}) =>
  radar.screenOpportunity(profile(p), notice(n), '2026-04-01');

// ── Screening ───────────────────────────────────────────────────────────────

describe('Screening a notice against the company', () => {
  it('shortlists a job that fits, and says why it fits', () => {
    const result = screen();

    assert.equal(result.eligible, true);
    assert.equal(result.qualification.recommendation, 'BID');
    assert.ok(result.strengths.some((s) => s.includes('Manchester')));
    assert.ok(result.strengths.some((s) => s.includes('TRANSPORT reference')));
    assert.ok(result.strengths.some((s) => s.includes('CPV')));
    assert.equal(result.competition, 'LOW');
  });

  it('fails a mandatory requirement outright rather than deducting points for it', () => {
    // The whole time saving is here: this is a four-second decision once the
    // company's own facts are written down.
    const turnover = screen({}, { requirements: { minimumTurnoverMinor: 20_000_000_00 } });
    assert.equal(turnover.eligible, false);
    assert.ok(turnover.eligibilityFailures.some((f) => f.requirement === 'Minimum turnover'));
    // Money is reported in pounds, not in the minor units it is stored in.
    assert.match(turnover.eligibilityFailures[0]!.reason, /£20,000,000 against our last filed £8,000,000/);

    const assets = screen({}, { requirements: { minimumNetAssetsMinor: 5_000_000_00 } });
    assert.ok(assets.eligibilityFailures.some((f) => f.requirement === 'Minimum net assets'));
  });

  it('checks insurance by type and by limit, not by having heard of it', () => {
    const missing = screen({}, { requirements: { insurances: [{ type: 'Professional indemnity', minimumLimitMinor: 100_000_000 }] } });
    assert.ok(missing.eligibilityFailures.some((f) => f.reason.includes('No policy of this type')));

    const tooLow = screen({}, { requirements: { insurances: [{ type: 'Public liability', minimumLimitMinor: 5_000_000_000 }] } });
    assert.ok(tooLow.eligibilityFailures.some((f) => f.reason.includes('of cover against our')));

    const enough = screen({}, { requirements: { insurances: [{ type: 'public liability', minimumLimitMinor: 500_000_000 }] } });
    assert.equal(enough.eligible, true, 'matching should not be defeated by the portal using different case');
  });

  it('never counts an unverified reference as capability', () => {
    // The building reference on the profile is unverified. Claiming it is
    // exactly the kind of thing a bid gets disqualified for.
    const result = screen({}, { sector: 'COMMERCIAL', requirements: { experience: [{ sector: 'COMMERCIAL', minimumProjects: 1 }] } });

    assert.equal(result.eligible, false);
    assert.ok(result.risks.some((r) => r.includes('No verified corporate reference in COMMERCIAL')));
    assert.ok(!result.strengths.some((s) => s.includes('COMMERCIAL reference')));
  });

  it('states the value threshold it applied, so the failure does not contradict the strength', () => {
    // Without the threshold in the reason, "0 references" sits next to "1
    // verified reference" and the reader cannot tell which is wrong.
    const result = screen({}, { requirements: { experience: [{ sector: 'TRANSPORT', minimumProjects: 1, minimumValueMinor: 2_000_000_00 }] } });

    const failure = result.eligibilityFailures.find((f) => f.requirement.includes('TRANSPORT'))!;
    assert.match(failure.requirement, /at £2,000,000\+/);
    assert.match(failure.reason, /1 verified reference in sector, largest £900,000/);
  });

  it('offers a real route round a missing accreditation rather than only refusing', () => {
    const result = screen({}, { requirements: { accreditations: ['ISO 14001'] } });

    assert.equal(result.eligible, false);
    assert.ok(result.mitigations.some((m) => m.includes('equivalent')));
  });

  it('offers to partner the package when the reference is what is missing', () => {
    const result = screen({}, { sector: 'COMMERCIAL', requirements: { experience: [{ sector: 'COMMERCIAL', minimumProjects: 2 }] } });
    assert.ok(result.mitigations.some((m) => m.includes('Partner or subcontract')));
    assert.ok(result.mitigations.some((m) => m.includes('named personnel experience')));
  });

  it('treats a closed notice as ineligible rather than as a tight deadline', () => {
    const closed = screen({}, { deadline: '2026-03-01' });
    assert.ok(closed.daysToDeadline < 0);
    assert.ok(closed.eligibilityFailures.some((f) => f.requirement === 'Return deadline'));

    const tight = screen({}, { deadline: '2026-04-08' });
    assert.equal(tight.eligible, true);
    assert.ok(tight.risks.some((r) => r.includes('days to the deadline')));
  });

  it('flags work outside the patch and outside the value band', () => {
    const far = screen({}, { region: 'Plymouth' });
    assert.ok(far.risks.some((r) => r.includes('outside our recorded operating regions')));
    assert.ok(far.mitigations.some((m) => m.includes('accommodation and travel')));

    const huge = screen({}, { estimatedValueMinor: 40_000_000_00 });
    assert.ok(huge.risks.some((r) => r.includes('one job would carry the business')));
    assert.ok(huge.mitigations.some((m) => m.includes('joint venture')));

    const tiny = screen({}, { estimatedValueMinor: 50_000_00 });
    assert.ok(tiny.risks.some((r) => r.includes('bid cost may not be recovered')));
  });

  it('notices when there is no capacity left to deliver it', () => {
    const full = screen({ capacity: { concurrentProjects: 6, committedProjects: 6 } });
    assert.ok(full.risks.some((r) => r.includes('No spare delivery capacity')));
  });

  it('moves the margin target with the competition rather than inventing one', () => {
    const quiet = screen({}, { estimatedBidders: 3 });
    const crowded = screen({}, { estimatedBidders: 14 });
    const silent = screen({}, { estimatedBidders: undefined });

    assert.equal(quiet.competition, 'LOW');
    assert.equal(crowded.competition, 'HIGH');
    assert.equal(silent.competition, 'UNKNOWN');

    assert.ok(crowded.marginTargetPercent.max < quiet.marginTargetPercent.max);
    // With nothing to go on it holds the company's own target rather than guessing.
    assert.equal(silent.marginTargetPercent.min, 8);
    assert.equal(silent.marginTargetPercent.max, 12);
  });

  it('suggests scores for the one scoring model rather than scoring separately', () => {
    const result = screen();

    // Every suggestion is on the 1–5 scale the algorithm validates, so handing
    // them straight to qualify() cannot throw.
    for (const [factor, value] of Object.entries(result.suggestedScores)) {
      assert.ok(Number.isInteger(value) && value >= 1 && value <= 5, `${factor} suggested ${value}`);
    }
    // And the recommendation comes from that model, not from the radar.
    assert.equal(result.qualification.score, result.qualification.score);
    assert.ok(['BID', 'DIRECTOR_REVIEW', 'NO_BID'].includes(result.qualification.recommendation));

    // Two factors a portal notice cannot answer are left neutral for a person,
    // rather than guessed from the client's name or from nothing at all.
    assert.equal(result.suggestedScores.clientAttractiveness, 3);
    assert.equal(result.suggestedScores.cashflowRisk, 3);
  });
});

// ── The morning run ─────────────────────────────────────────────────────────

describe('The morning run', () => {
  it('refuses to screen anything before the company records its own facts', async () => {
    const fresh = new Platform();
    const other = await seedDemoProject(fresh);
    // The seed sets a profile, so remove it to reach the unset case.
    const record = fresh.ledger.get({ refType: 'CompanyProfile', refId: `${other.tenantId}-profile` });
    assert.ok(record, 'the seed should record a profile');

    const empty = new Platform();
    const { tenant } = empty.createTenant({
      legalName: 'No Profile Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'No Profile Group',
    });
    const bare = empty.context({ ...seed.users.admin!.auth, tenantId: tenant.id }, `${tenant.id}-governance`, { source: 'WEB' });

    throwsCode(() => radar.runRadar(bare, { notices: [notice()] }), 'COMPANY_PROFILE_NOT_SET');
  });

  it('refuses a profile that cannot describe the business', () => {
    throwsCode(() => radar.setCompanyProfile(ctx(), profile({ turnoverMinorByYear: [] })), 'PROFILE_INCOMPLETE');
    throwsCode(
      () => radar.setCompanyProfile(ctx(), profile({ valueBandMinor: { min: 10_000_00, max: 1_000_00 } })),
      'VALUE_BAND_INVALID',
    );
  });

  it('sorts the shortlist by score and keeps the rejections with their reasons', () => {
    const run = radar.latestRadarRun(ctx()) as Record<string, unknown>;
    assert.ok(run, 'the seed should leave a radar run');

    const results = run.results as radar.ScreenedOpportunity[];
    assert.equal(results.length, 5);
    assert.equal(run.screened, 5);

    // Everything screened is kept, not just the shortlist. "Why did we not bid
    // that one" is asked months later.
    const rejected = results.filter((r) => !r.eligible);
    assert.equal(rejected.length, 3);
    for (const item of rejected) {
      assert.ok(item.eligibilityFailures.length > 0, `${item.reference} is ineligible for no stated reason`);
    }
  });

  it('names the requirement that keeps disqualifying the business', () => {
    const run = radar.latestRadarRun(ctx()) as Record<string, unknown>;
    const observations = run.observations as string[];

    // Two notices needed ISO 14001, which the company does not hold. Failing
    // the same requirement repeatedly is a decision about the business rather
    // than about any one bid, and only the batch view can see it.
    assert.ok(observations.some((o) => o.includes('ISO 14001') && o.includes('decision about the business')));
    assert.ok(observations.some((o) => o.includes('worth reading')));
  });

  it('warns about anything on the shortlist closing within a fortnight', () => {
    const run = radar.latestRadarRun(ctx()) as Record<string, unknown>;
    assert.ok((run.observations as string[]).some((o) => o.includes('close within a fortnight')));
  });

  it('registers nothing automatically — the radar reads, a person decides', () => {
    const pipelineBefore = platform.ledger.list(`${seed.tenantId}-governance`, 'Opportunity').length;
    radar.runRadar(ctx(), { notices: [notice({ reference: 'FTS-NEW' })], today: '2026-04-01' });
    const pipelineAfter = platform.ledger.list(`${seed.tenantId}-governance`, 'Opportunity').length;

    assert.equal(pipelineAfter, pipelineBefore, 'the radar registered an opportunity nobody chose to chase');
  });

  it('keeps the radar events in the catalogue and off the AI', () => {
    for (const code of ['COMPANY_PROFILE_SET', 'RADAR_RUN_COMPLETED']) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.aiAllowed, false, `${code} must not be writable by a model`);
    }
    assert.equal(lookupEventType('COMPANY_PROFILE_SET')!.entity, 'CompanyProfile');
  });
});
