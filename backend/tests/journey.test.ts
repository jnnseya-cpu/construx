import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import * as structure from '../src/domain/structure.ts';
import { setCompanyProfile, type CompanyProfile } from '../src/domain/radar.ts';
import { bidFlow } from '../src/domain/bidflow.ts';
import { guidedJourney } from '../src/domain/journey.ts';
import * as business from '../src/domain/business.ts';
import * as tenderintake from '../src/domain/tenderintake.ts';

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

  it('reads the invitation of the tender in focus, not the one recorded last, when several are live', () => {
    // The gate that "could never pass": a tenancy running several tenders at
    // once, each a pursuit linked to its own project but all named for the same
    // buyer. The guide resolved the invitation by a fuzzy name match whose
    // `.at(-1)` picked the LAST-recorded one, so the job in focus — every return
    // owned — was reported against a different tender's unassigned returns, and
    // no amount of assigning on the right screen moved the gate. The guide must
    // read the invitation of the opportunity the open project actually is.
    const w = workspace();
    setCompanyProfile(w.governance, PROFILE);

    const openNamed = (name: string) => {
      const enterpriseId = String(w.platform.ledger.listByTenant(w.tenantId, 'Enterprise')[0]?.state.id ?? '');
      const { portfolioId } = structure.createPortfolio(w.governance, {
        name: `${name} portfolio`, enterpriseId, governanceModel: 'Sole director', continentCode: 'EU', city: 'Telford',
      });
      const { projectId } = structure.createProject(w.governance, {
        portfolioId, name, sectorType: 'RMI', assetType: 'Dwelling',
        location: { continentCode: 'EU', countryCode: 'GB', city: 'Telford' },
        contractValueMinor: 5_000_000, currency: 'GBP', plannedStart: '2026-12-01', plannedCompletion: '2027-03-31',
      });
      return { projectId, ctx: w.platform.context(w.auth, projectId, { source: 'WEB' }) };
    };
    const inv = (oppId: string, reference: string, issuedAt: string, deliverables: tenderintake.TenderDeliverable[]) => {
      const { invitationId } = tenderintake.recordInvitation(w.governance, oppId, {
        reference, issuedAt, returnLocal: '2027-01-04T12:00', timeZone: 'Europe/London', timeZoneStated: true, channel: 'PORTAL',
      });
      tenderintake.extractRequirements(w.governance, invitationId, { deliverables, analysisId: `an-${invitationId}` });
      return invitationId;
    };
    // A pursuit linked to a project takes its title, sector and value from that
    // project, so they are left to derive rather than restated.
    const opp = (projectId: string) =>
      business.registerOpportunity(w.governance, {
        clientName: 'Telford and Wrekin Council', sectorType: 'RMI', estimatedValueMinor: 5_000_000,
        source: 'In-Tend', projectId,
      }).opportunityId;

    // Two returns each, so both read as a submission to write (not a bare price).
    const owned = (reference: string, title: string): tenderintake.TenderDeliverable => ({
      reference, title, mandatory: true, owner: 'OWNER', internalDueBy: '2026-12-20', source: { document: 'ITT' },
    });
    // Job A — in focus — has both mandatory returns fully owned, dated and sourced.
    const a = openNamed('Telford and Wrekin Council A');
    inv(opp(a.projectId), 'TWC-A', '2026-11-01T09:00:00.000Z', [owned('A-1', 'Questionnaire'), owned('A-2', 'Declaration')]);
    // Job B — recorded LATER — has bare, unassigned mandatory returns.
    const b = openNamed('Telford and Wrekin Council B');
    inv(opp(b.projectId), 'TWC-B', '2026-11-02T09:00:00.000Z', [
      { reference: 'B-1', title: 'Bare return', mandatory: true },
      { reference: 'B-2', title: 'Bare return two', mandatory: true },
    ]);

    // Job A's guide sees A's own register — owned, done — not B's unassigned one.
    const regA = bidFlow(w.platform, a.ctx).steps.find((s) => s.id === 'RETURN_REGISTER')!;
    assert.equal(regA.state, 'DONE', `job A return register should be done, got: ${regA.detail}`);
    // Job B still shows its own blocking return, so the fix did not simply hide the block.
    const regB = bidFlow(w.platform, b.ctx).steps.find((s) => s.id === 'RETURN_REGISTER')!;
    assert.notEqual(regB.state, 'DONE', 'job B still has an unassigned mandatory return and must not read as done');
    // And the guide points at the button that actually clears the gate in one act
    // — the bulk "Clear all blocking returns", not the single "Assign a return"
    // that lets the fields go blank and never clears. This was the universal
    // blocker: the guide steered every tender to the control that did not work.
    assert.equal(regB.door, 'Clear all blocking returns', `the returns gate guides to "${regB.door}", not the one-press bulk clear`);
    assert.equal((regB as Record<string, unknown>).command, 'assign-all-returns', 'the returns gate does not open the bulk-clear command');
  });

  it('once a submission is in, stops pointing back at pre-submission steps and points at the outcome', () => {
    // Three real tenders a user reported: each submitted — one lost, one awaiting
    // the result — and each still headlined "Record what has to go back", looping
    // the guide back to assigning returns on a bid that had already gone out. Once
    // a submission is on the record, the pre-submission steps are behind the
    // bidder; the one live step is recording how it ended.
    const w = workspace();
    setCompanyProfile(w.governance, PROFILE);
    const enterpriseId = String(w.platform.ledger.listByTenant(w.tenantId, 'Enterprise')[0]?.state.id ?? '');
    const { portfolioId } = structure.createPortfolio(w.governance, {
      name: 'Hayward portfolio', enterpriseId, governanceModel: 'Sole director', continentCode: 'EU', city: 'London',
    });
    const { projectId } = structure.createProject(w.governance, {
      portfolioId, name: 'Hayward Architects bid', sectorType: 'RMI', assetType: 'Dwelling',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'London' },
      contractValueMinor: 5_000_000, currency: 'GBP', plannedStart: '2026-12-01', plannedCompletion: '2027-03-31',
    });
    const ctx = w.platform.context(w.auth, projectId, { source: 'WEB' });
    const { opportunityId } = business.registerOpportunity(w.governance, {
      clientName: 'Hayward Architects Limited', sectorType: 'RMI', estimatedValueMinor: 5_000_000, source: 'In-Tend', projectId,
    });
    const { invitationId } = tenderintake.recordInvitation(w.governance, opportunityId, {
      reference: 'ITT.2398.GD', issuedAt: '2026-10-01T09:00:00.000Z', returnLocal: '2026-11-20T12:00',
      timeZone: 'Europe/London', timeZoneStated: true, channel: 'PORTAL',
    });
    tenderintake.extractRequirements(w.governance, invitationId, {
      deliverables: [
        { reference: 'R-1', title: 'Questionnaire', mandatory: true },
        { reference: 'R-2', title: 'Declaration', mandatory: true },
      ],
      analysisId: `an-${invitationId}`,
    });

    // Before anything is submitted the guide points at a pre-submission step
    // (the returns are unassigned), never at the outcome.
    const before = bidFlow(w.platform, ctx);
    assert.ok(before.nowDo, 'expected a next step before submitting');
    assert.notEqual(before.nowDo!.id, 'AWARD', 'should not point at the outcome before anything is submitted');

    // A submission goes in — recorded against a piece of evidence, as the real
    // flow records the submitted bytes.
    w.platform.ledger.commit({
      tenantId: w.tenantId,
      projectId,
      actor: { refType: 'User', refId: w.auth.actorId },
      source: 'SYSTEM',
      correlationId: 'submit-test',
      eventType: 'EVIDENCE_REGISTERED',
      entity: { refType: 'EvidenceItem', refId: 'ev-sub' },
      nextState: {
        id: 'ev-sub', type: 'EXPORTED_DOCUMENT', hash: 'sha256:deadbeef',
        description: 'submission', capturedAt: new Date().toISOString(), capturedBy: w.auth.actorId, linkedEntities: [],
      },
    });
    w.platform.ledger.commit({
      tenantId: w.tenantId,
      projectId,
      actor: { refType: 'User', refId: w.auth.actorId },
      source: 'SYSTEM',
      correlationId: 'submit-test',
      eventType: 'BID_PACK_COMPILED',
      entity: { refType: 'BidSubmissionPack', refId: 'sub-hayward' },
      nextState: { id: 'sub-hayward' },
      evidenceRefs: [{ refType: 'EvidenceItem', refId: 'ev-sub' }],
    });

    const after = bidFlow(w.platform, ctx);
    assert.notEqual(after.nowDo?.id, 'RETURN_REGISTER', 'still looping back to returns after the submission is in');
    assert.equal(after.nowDo?.id, 'AWARD', `a submitted bid should point at recording the outcome, got: ${after.nowDo?.id ?? 'null'}`);
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
