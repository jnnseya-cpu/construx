import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import * as structure from '../src/domain/structure.ts';
import { setCompanyProfile, type CompanyProfile } from '../src/domain/radar.ts';
import { bidFlow } from '../src/domain/bidflow.ts';
import { guidedJourney } from '../src/domain/journey.ts';

/**
 * The guided walkthrough, from an empty account to an open job.
 *
 * What `bidFlow` could never answer is the question a brand-new subscriber has:
 * no company facts, no job, and so no flow to read. The journey answers it, and
 * then hands over to `bidFlow` unchanged once a job exists — which is the
 * behaviour these tests pin, in the order a real subscriber meets them.
 */

function workspace() {
  const platform = new Platform();
  const { tenant } = platform.createTenant({
    legalName: 'Guided Journey Test Ltd',
    enterpriseName: 'Guided',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
  });
  const user = platform.createUser({ tenantId: tenant.id, name: 'Owner', email: `owner-${Math.random().toString(36).slice(2)}@gj.test`, roles: ['OWNER'] });
  const auth = authOf(platform, user.id);
  const governance = platform.context(auth, `${tenant.id}-governance`, { source: 'WEB' });
  return { platform, tenantId: tenant.id, auth, governance };
}

const PROFILE: CompanyProfile = {
  legalName: 'Guided Journey Test Ltd',
  turnoverMinorByYear: [50_000_000, 42_000_000],
  netAssetsMinor: 8_000_000,
  workingCapitalMinor: 3_000_000,
  regions: ['Lincolnshire'],
  sectors: ['RMI'],
  cpvCodes: ['45211000'],
  valueBandMinor: { min: 1_000_000, max: 15_000_000 },
  insurances: [],
  accreditations: [],
  references: [],
  selfDeliveredTrades: ['Groundworks'],
  targetMarginPercent: { min: 8, max: 15 },
  capacity: { concurrentProjects: 3, committedProjects: 0 },
};

function openJob(platform: Platform, tenantId: string, governance: ReturnType<Platform['context']>, auth: ReturnType<typeof authOf>) {
  const enterpriseId = String(platform.ledger.listByTenant(tenantId, 'Enterprise')[0]?.state.id ?? '');
  const { portfolioId } = structure.createPortfolio(governance, {
    name: 'Adaptations',
    enterpriseId,
    governanceModel: 'Sole director',
    continentCode: 'EU',
    city: 'Spalding',
  });
  const { projectId } = structure.createProject(governance, {
    portfolioId,
    name: 'SHDC 000189',
    sectorType: 'RMI',
    assetType: 'Dwelling',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Spalding' },
    contractValueMinor: 7_200_000,
    currency: 'GBP',
    plannedStart: '2026-12-01',
    plannedCompletion: '2027-03-31',
  });
  return { projectId, ctx: platform.context(auth, projectId, { source: 'WEB' }) };
}

describe('the guided journey', () => {
  it('on an empty account, sends the subscriber to record the company facts', () => {
    const w = workspace();
    const journey = guidedJourney(w.governance, { projectFlow: null, projectId: null });

    assert.equal(journey.hasProfile, false);
    assert.equal(journey.hasProject, false);
    assert.equal(journey.road, null);
    assert.equal(journey.stages.length, 2);
    assert.equal(journey.nowDo?.id, 'COMPANY_FACTS');
    assert.equal(journey.nowDo?.group, 'SETUP');
    assert.equal(journey.nowDo?.screen, 'pipeline');
  });

  it('once the facts are on file, moves the subscriber on to opening a job', () => {
    const w = workspace();
    setCompanyProfile(w.governance, PROFILE);
    const journey = guidedJourney(w.governance, { projectFlow: null, projectId: null });

    assert.equal(journey.hasProfile, true);
    assert.equal(journey.hasProject, false);
    assert.equal(journey.nowDo?.id, 'FIRST_JOB');
    assert.equal(journey.nowDo?.screen, 'enterprise');
  });

  it('once a job is open, folds in that job’s own flow and hands the next step to it', () => {
    const w = workspace();
    setCompanyProfile(w.governance, PROFILE);
    const job = openJob(w.platform, w.tenantId, w.governance, w.auth);
    const flow = bidFlow(w.platform, job.ctx);

    const journey = guidedJourney(w.governance, { projectFlow: flow, projectId: job.projectId });

    assert.equal(journey.hasProfile, true);
    assert.equal(journey.hasProject, true);
    // Both setup stages are done, so the next step comes from the job's own road.
    assert.equal(journey.stages.filter((s) => s.group === 'SETUP' && s.state === 'DONE').length, 2);
    assert.ok(journey.stages.some((s) => s.group === 'WIN'), 'the job’s flow steps are folded in');
    assert.equal(journey.nowDo?.group, 'WIN');
    // A freshly opened job with no drawings filed: the first thing to do is file the pack.
    assert.equal(journey.nowDo?.id, 'PACK_FILED');
    assert.equal(journey.road, flow.road);
    // Every WIN stage carried its flow identity across unchanged.
    const win = journey.stages.find((s) => s.group === 'WIN');
    assert.ok(win && win.title.length > 0 && win.screen.length > 0);
  });

  it('when a job’s flow cannot be read, still guides setup rather than failing', () => {
    const w = workspace();
    setCompanyProfile(w.governance, PROFILE);
    openJob(w.platform, w.tenantId, w.governance, w.auth);
    // The route passes null when the project flow is unreadable (no access, stale
    // id). The journey still answers from the tenancy facts.
    const journey = guidedJourney(w.governance, { projectFlow: null, projectId: 'p-unreadable' });

    assert.equal(journey.hasProfile, true);
    assert.equal(journey.hasProject, true);
    // Both setup stages done and no flow folded in — nothing outstanding to point at.
    assert.equal(journey.nowDo, null);
    assert.match(journey.summary, /nothing is outstanding/i);
  });
});
