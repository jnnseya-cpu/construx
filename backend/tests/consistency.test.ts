import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as structure from '../src/domain/structure.ts';
import { consistencyReport } from '../src/domain/consistency.ts';
import * as claims from '../src/engines/claims.ts';
import * as planning from '../src/engines/planning.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Cross-consistency.
 *
 * Every module in this platform is individually correct and none of them looks
 * at the others, which is where the expensive mistakes live. A programme that
 * finishes after the contract date is liquidated damages — computable from two
 * facts already on record — and nobody notices, because the planner is looking
 * at a critical path and the commercial manager at a contract.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const ctx = (who = 'pm', projectId = seed.projectId) => platform.context(seed.users[who]!.auth, projectId);

/** A project with nothing on it, for testing what a check does when it cannot run. */
function bareProject(name: string): string {
  const admin = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');
  return structure.createProject(admin, {
    portfolioId: String(portfolios[0]!.state.id),
    name,
    sectorType: 'TRANSPORT',
    assetType: 'Pumping station',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Derby' },
    contractValueMinor: 500_000_00,
    currency: 'GBP',
    plannedStart: '2027-01-04',
    plannedCompletion: '2027-10-01',
  }).projectId;
}

describe('a check that cannot run says so, rather than passing', () => {
  it('skips the contract comparison on a project with no contract', () => {
    // A project with no contract has not passed the contract check. It has not
    // taken it, and the two are different things.
    const report = consistencyReport(ctx('pm', bareProject('No contract here')));

    const skipped = report.skipped.find((s) => s.check === 'Contract against programme');
    assert.ok(skipped);
    assert.match(skipped.reason, /No contract is recorded/);
    assert.ok(!report.passed.some((p) => p.startsWith('Contract against programme')));
  });

  it('counts skipped checks separately in the summary', () => {
    const report = consistencyReport(ctx('pm', bareProject('Nothing recorded')));
    assert.equal(report.findings.length, 0);
    assert.match(report.summary, /could not run for want of a record/);
  });
});

describe('contract against programme — the one that costs money', () => {
  it('passes, and says by how much, where the programme fits', () => {
    // Run first, against the pristine seed: the demo programme finishes well
    // inside its contract date.
    const report = consistencyReport(ctx('pm'));
    const passed = report.passed.find((p) => p.startsWith('Contract against programme'));

    assert.ok(passed);
    assert.match(passed, /days inside the contract date/);
  });
});

describe('slippage the programme was never told about', () => {
  it('finds the delay that has already happened on the seeded project', () => {
    // Five activities finished late. They are finished, so nothing flags them
    // as overrunning — and the network still holds their original durations, so
    // the forecast completion is optimistic by history rather than by forecast.
    const report = consistencyReport(ctx('pm'));
    const finding = report.findings.find((f) => f.check === 'Slippage absorbed into the programme');

    assert.ok(finding, 'the seeded project finished several activities late');
    assert.ok((finding.exposureDays ?? 0) >= 40);
    assert.match(finding.finding, /still holds their original durations/);
    assert.match(finding.consequence, /Re-baseline/);
  });

  it('skips rather than passes where nothing has finished', () => {
    const report = consistencyReport(ctx('pm', bareProject('Nothing finished')));
    assert.ok(report.skipped.some((s) => s.check === 'Slippage absorbed into the programme'));
  });
});

describe('the checks that agree on the seeded project', () => {
  it('finds no duplicate activity codes', () => {
    const report = consistencyReport(ctx('pm'));
    assert.ok(report.passed.some((p) => p.startsWith('Duplicate activity codes')));
  });

  it('finds every committed cost code inside its budget', () => {
    const report = consistencyReport(ctx('pm'));
    assert.ok(report.passed.some((p) => p.startsWith('Commitments against budget')));
  });

  it('names what disagrees in the summary rather than reporting a status', () => {
    const report = consistencyReport(ctx('pm'));
    assert.match(report.summary, /disagree/);
    assert.ok(report.findings.every((f) => f.consequence.length > 40), 'every finding carries what to do about it');
  });
});

describe('duplicate activity codes', () => {
  it('finds two activities sharing a code', () => {
    // Reopened to construction, because creating activities is phase-gated in
    // operations — which is the gate working, not a fixture problem.
    structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
      to: 'CONSTRUCTION',
      justification: 'Reopened to add the north and south excavation activities',
    });

    const workPackageId = platform.ledger.list(seed.projectId, 'ScopePackage')[0]?.refId ?? 'WP-1';
    planning.createTasks(ctx('planner'), [
      { activityCode: 'DUP1', name: 'Excavation to the north', workPackageId, durationDays: 10 },
      { activityCode: 'dup1', name: 'Excavation to the south', workPackageId, durationDays: 10 },
    ]);

    const finding = consistencyReport(ctx('pm')).findings.find((f) => f.check === 'Duplicate activity codes');

    assert.ok(finding, 'the same code in different case is still the same code');
    assert.match(finding.consequence, /counts the work twice/);
  });
});

describe('the report writes nothing', () => {
  it('changes no state, because a disagreement is a question for a person', () => {
    const before = platform.ledger.list(seed.projectId, 'Task').length;
    consistencyReport(ctx('pm'));
    consistencyReport(ctx('pm'));
    assert.equal(platform.ledger.list(seed.projectId, 'Task').length, before);
  });

  it('withholds the money from a role with no commercial clearance, and keeps the fact', () => {
    // A safety lead should know the programme disagrees with the contract —
    // that is a fact about the job. What they have no business reading is what
    // it costs. Keep the envelope, withhold the content, the same decision the
    // audit feed makes.
    const restricted = consistencyReport(platform.context(seed.users.safety!.auth, seed.projectId));
    const full = consistencyReport(ctx('pm'));

    assert.equal(restricted.commercialWithheld, true);
    assert.equal(full.commercialWithheld, false);

    // The same disagreements are visible.
    assert.deepEqual(
      restricted.findings.map((f) => f.check),
      full.findings.map((f) => f.check),
    );

    // And no figure survives anywhere in them.
    assert.equal(restricted.totalExposureMinor, 0);
    assert.ok(restricted.findings.every((f) => f.exposureMinor === undefined));
    assert.doesNotMatch(JSON.stringify(restricted.findings.map((f) => f.consequence)), /£/);
  });
});

describe('contract against programme, once a tighter contract is on record', () => {
  /**
   * These mutate the seeded project, so they run last. The report reads the
   * most recent contract, which is what a contractor would expect: a
   * supplemental agreement supersedes.
   */
  it('prices the overrun in liquidated damages, capped at the contractual cap', () => {
    claims.createContract(ctx('qs'), {
      suite: 'JCT',
      form: 'JCT Design and Build 2016 — accelerated section',
      parties: [{ role: 'CLIENT', partyId: 'C', name: 'Ashworth Water Authority' }],
      contractSumMinor: 500_000_00,
      commencementDate: '2026-07-01',
      // Far earlier than the 326-day programme can reach.
      completionDate: '2026-10-01',
      liquidatedDamagesPerDayMinor: 250_00,
      ldCapPercent: 10,
      retentionPercent: 3,
      defectsLiabilityMonths: 12,
    });

    const finding = consistencyReport(ctx('pm')).findings.find((f) => f.check === 'Contract against programme');

    assert.ok(finding, 'a 326-day programme against a 92-day contract should be found');
    assert.equal(finding.severity, 'CRITICAL');
    assert.ok((finding.exposureDays ?? 0) > 100);

    // What is payable is the rate times the overrun, or the contractual cap if
    // that is lower — the cap is part of the contract, so the exposure is what
    // the contract allows rather than the arithmetic before it applies.
    const uncapped = 250_00 * finding.exposureDays!;
    assert.equal(finding.exposureMinor, Math.min(uncapped, 50_000_00));
    // Both records are named, so the finding can be checked rather than believed.
    assert.ok(finding.sources.some((s) => s.refType === 'Contract'));
    assert.ok(finding.sources.some((s) => s.refType === 'Project'));
  });

  it('says the overrun is real even where no damages rate is recorded', () => {
    claims.createContract(ctx('qs'), {
      suite: 'NEC4',
      form: 'NEC4 ECC Option A — no delay damages',
      parties: [{ role: 'CLIENT', partyId: 'C', name: 'Ashworth Water Authority' }],
      contractSumMinor: 500_000_00,
      commencementDate: '2026-07-01',
      completionDate: '2026-10-01',
      liquidatedDamagesPerDayMinor: 0,
      ldCapPercent: 0,
      retentionPercent: 0,
      defectsLiabilityMonths: 12,
    });

    const finding = consistencyReport(ctx('pm')).findings.find((f) => f.check === 'Contract against programme');

    assert.ok(finding);
    assert.equal(finding.exposureMinor, undefined, 'no rate means no figure, not a guessed one');
    assert.match(finding.consequence, /The overrun is real either way/);
  });
});
