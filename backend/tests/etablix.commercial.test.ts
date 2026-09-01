import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  EV_METHODS,
  RECORD_KINDS,
  VALUATION_STEPS,
  approveServiceCredit,
  assessValuation,
  certifyValuation,
  commercialPosition,
  openLine,
  earnedFor,
  openValuation,
  raiseServiceCredit,
  recordAcceptedProgress,
  recordApplication,
} from '../src/domain/etablix/commercial.ts';
import { createPackage, statePackageField } from '../src/domain/etablix/procurement.ts';
import { raiseEvent } from '../src/domain/etablix/operations.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §10 — commercial control and earned value.
 *
 * **"An invoice is not proof of value."** The specification's own sentence, and
 * everything here is that sentence enforced. A claim, what the evidence
 * supports, and what was certified are three numbers that every commercial
 * system on the market collapses into one — which is how a job can be 40% paid,
 * 25% delivered and reported as on track.
 */

let platform: Platform;
let seed: SeedResult;

function as(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

function appoint(): void {
  if (platform.ledger.list(seed.projectId, 'SiteServicesAppointment').length > 0) return;
  setAppointment(as('pm'), {
    model: 'PRINCIPAL_SERVICE_CONTRACTOR',
    contractingEntity: 'Meridian Infrastructure Group Ltd',
    fundingSource: 'Client capital programme',
    basis: 'Single-point accountability across all seven families',
  });
  for (const [itemId, value] of [
    ['peakWorkforce', 164],
    ['shiftOverlapPersons', 120],
    ['visitorsPerDay', 22],
    ['accommodatedWorkers', 120],
    ['cleanableAreaSqm', 1800],
  ] as [string, number][]) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
  }
}

function compose(family: string, zone = 'Main compound'): string {
  const existing = platform.ledger
    .list(seed.projectId, 'ServiceSystem')
    .map((record) => record.state as unknown as { id: string; family: string; zone: string })
    .find((entry) => entry.family === family && entry.zone === zone);
  if (existing) return existing.id;
  const { system, interfaces } = composeSystem(as('pm'), { family, zone, ...WINDOW });
  for (const entry of interfaces) {
    assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
  }
  return system.id;
}

/** A package to hang contract lines from. */
function packaged(): { packageId: string; systemId: string } {
  appoint();
  const systemId = compose('WELFARE_ACCOMMODATION');
  const existing = platform.ledger
    .list(seed.projectId, 'ServicePackage')
    .map((record) => record.state as unknown as { id: string });
  if (existing.length > 0) return { packageId: existing[0]!.id, systemId };
  const created = createPackage(as('pm'), { title: 'Welfare and accommodation', systemIds: [systemId] });
  statePackageField(as('pm'), { packageId: created.id, field: 'scope', value: 'Supply, service and remove all welfare units' });
  return { packageId: created.id, systemId };
}

/** A time-based hire line: 40 weeks, £200,000 budget. */
function hireLine() {
  const { packageId, systemId } = packaged();
  return openLine(as('pm'), {
    packageId,
    systemId,
    description: 'Welfare cabin hire, 40 weeks',
    budgetMinor: 200_000_00,
    commitmentMinor: 200_000_00,
    currency: 'GBP',
    method: 'TIME',
    contractWeeks: 40,
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  platform.setModuleGrant({
    moduleId: 'ETABLIX',
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'ACTIVE',
    reason: 'Appointed as ETABLIX site-services delivery partner',
    decidedBy: seed.users.operator!.id,
  });
});

beforeEach(() => {
  seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
});

describe('§10 the eight records and the four methods', () => {
  it('keeps eight records apart, each with the control that defines it', () => {
    assert.equal(RECORD_KINDS.length, 8);
    for (const record of RECORD_KINDS) {
      assert.ok(record.control.length > 40, `${record.id} does not say what it controls`);
    }
    const ids = RECORD_KINDS.map((entry) => entry.id);
    // The three the industry collapses into one.
    assert.ok(ids.includes('COMMITMENT'));
    assert.ok(ids.includes('ACTUAL'));
    assert.ok(ids.includes('EARNED_VALUE'));
  });

  it('declares four earned-value methods, each saying what it suits', () => {
    assert.deepEqual(EV_METHODS.map((entry) => entry.id), ['MILESTONE', 'QUANTITY', 'TIME', 'WEIGHTED_EVIDENCE']);
    for (const method of EV_METHODS) {
      assert.ok(method.detail.length > 30, `${method.id} does not say how it earns`);
      assert.ok(method.suits.length > 10, `${method.id} does not say what it suits`);
    }
    assert.match(EV_METHODS.find((entry) => entry.id === 'TIME')!.detail, /cannot be accelerated by working harder/);
  });

  it('is seven valuation steps in order', () => {
    assert.deepEqual(
      VALUATION_STEPS.map((step) => step.id),
      ['OPEN', 'APPLY', 'RECONCILE', 'EXCEPTIONS', 'REVIEW', 'ISSUE', 'UPDATE'],
    );
  });

  it('refuses a line whose method has nothing to measure against', () => {
    const { packageId } = packaged();
    const base = { packageId, description: 'Hire', budgetMinor: 100_00, commitmentMinor: 100_00, currency: 'GBP' };
    throwsCode(() => openLine(as('pm'), { ...base, method: 'TIME' }), 'CONTRACT_LINE_UNTIMED');
    throwsCode(() => openLine(as('pm'), { ...base, method: 'QUANTITY' }), 'CONTRACT_LINE_UNQUANTIFIED');
    throwsCode(() => openLine(as('pm'), { ...base, method: 'GUESSWORK' }), 'EV_METHOD_UNKNOWN');
    // A budget of zero earns zero however much is delivered.
    throwsCode(
      () => openLine(as('pm'), { ...base, budgetMinor: 0, method: 'MILESTONE' }),
      'CONTRACT_LINE_UNBUDGETED',
    );
  });

  it('refuses progress beyond what was ever bought', () => {
    const line = hireLine();
    const error = throwsCode(
      () =>
        recordAcceptedProgress(as('pm'), {
          lineId: line.id,
          periodTo: '2027-01-31',
          accepted: 45,
          evidence: 'Hire docket',
        }),
      'PROGRESS_EXCEEDS_CONTRACT',
    );
    assert.match(String(error.message), /more than was ever bought/);
  });

  it('refuses progress with nothing behind it', () => {
    const line = hireLine();
    const error = throwsCode(
      () => recordAcceptedProgress(as('pm'), { lineId: line.id, periodTo: '2027-01-31', accepted: 10, evidence: '  ' }),
      'PROGRESS_UNEVIDENCED',
    );
    assert.match(String(error.message), /the difference between the two is the entire valuation/);
  });
});

describe('§10 earned value is a position, not a sum', () => {
  it('takes the latest accepted position rather than adding the readings up', () => {
    const line = hireLine();
    for (const [periodTo, weeks] of [
      ['2026-12-31', 8],
      ['2027-01-31', 12],
      ['2027-02-28', 20],
    ] as [string, number][]) {
      recordAcceptedProgress(as('pm'), {
        lineId: line.id,
        periodTo,
        accepted: weeks,
        evidence: `Hire dockets to ${periodTo}`,
      });
    }
    const position = commercialPosition(as('pm'));
    // 20 of 40 weeks against a £200,000 budget is £100,000 earned. Summing the
    // three readings would give 40 weeks and the whole budget.
    assert.equal(position.lines[0]!.earnedMinor, 100_000_00);
  });

  it('never earns more than the budget, whatever it is handed', () => {
    // The command refuses progress beyond the contract figure, so this clamp is
    // only reachable through `earnedFor` itself — which is exported, and is
    // what a forecast or a report would call. A line earning 110% of its budget
    // is a line that has stopped being a measure, and the clamp is the reason
    // that cannot be reported however the number got there.
    const line = hireLine();
    const beyond = [
      {
        id: 'x',
        projectId: seed.projectId,
        lineId: line.id,
        periodTo: '2027-01-31',
        accepted: 60,
        evidence: 'Sixty weeks against a forty-week contract',
        recordedBy: 'x',
        recordedAt: new Date().toISOString(),
      },
    ];
    assert.equal(earnedFor(line, beyond), 200_000_00, 'the whole budget, and not a penny more');
  });

  it('earns nothing on a milestone line until the milestone is accepted', () => {
    const { packageId } = packaged();
    const line = openLine(as('pm'), {
      packageId,
      description: 'Compound platform complete',
      budgetMinor: 80_000_00,
      commitmentMinor: 80_000_00,
      currency: 'GBP',
      method: 'MILESTONE',
    });
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 0,
      evidence: 'Platform 90% laid, not accepted',
    });
    assert.equal(commercialPosition(as('pm')).lines.find((entry) => entry.id === line.id)!.earnedMinor, 0);

    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-02-28',
      accepted: 1,
      evidence: 'Platform accepted, survey CP-114',
    });
    assert.equal(commercialPosition(as('pm')).lines.find((entry) => entry.id === line.id)!.earnedMinor, 80_000_00);
  });
});

describe('§10.1 reconcile, then identify', () => {
  it('finds an overclaim and refuses to certify over it', () => {
    const line = hireLine();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10, gate log',
    });
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), {
      valuationId: valuation.id,
      lines: [{ lineId: line.id, claimed: 16, narrative: 'Sixteen weeks on site' }],
    });

    const assessment = assessValuation(as('pm'), valuation.id);
    const overclaim = assessment.exceptions.find((entry) => entry.kind === 'OVERCLAIM')!;
    assert.match(overclaim.statement, /claims 16 and the accepted evidence supports 10/);
    assert.match(overclaim.statement, /Hire dockets W1–W10/);
    // Six weeks of a forty-week, £200,000 line is £30,000.
    assert.equal(overclaim.effectMinor, -30_000_00);
    assert.equal(assessment.certifiable, false);

    const error = throwsCode(
      () => certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Certified as applied' }),
      'VALUATION_NOT_CERTIFIABLE',
    );
    assert.match(String(error.message), /An invoice is not proof of value/);
  });

  it('certifies what the evidence supports, and pays the movement rather than the position', () => {
    const line = hireLine();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10',
    });
    const first = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), { valuationId: first.id, lines: [{ lineId: line.id, claimed: 10, narrative: 'Ten weeks' }] });
    const certified = certifyValuation(as('pm'), { valuationId: first.id, note: 'Ten weeks against the dockets' });
    assert.equal(certified.certifiedMinor, 50_000_00);

    // Second period: twenty weeks cumulative, so ten weeks of movement.
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-02-28',
      accepted: 20,
      evidence: 'Hire dockets W11–W20',
    });
    const second = openValuation(as('pm'), { periodFrom: '2027-02-01', periodTo: '2027-02-28' });
    recordApplication(as('pm'), { valuationId: second.id, lines: [{ lineId: line.id, claimed: 20, narrative: 'Twenty weeks' }] });
    const assessment = assessValuation(as('pm'), second.id);
    assert.equal(assessment.lines[0]!.earnedMinor, 100_000_00, 'the position');
    assert.equal(assessment.lines[0]!.priorEarnedMinor, 50_000_00);
    assert.equal(assessment.grossMinor, 50_000_00, 'the movement, which is what the certificate pays');
  });

  it('reports work earned and never claimed, because it lands anyway', () => {
    const line = hireLine();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10',
    });
    const { packageId } = packaged();
    const second = openLine(as('pm'), {
      packageId,
      description: 'Cleaning, weekly',
      budgetMinor: 40_000_00,
      commitmentMinor: 40_000_00,
      currency: 'GBP',
      method: 'WEIGHTED_EVIDENCE',
    });
    recordAcceptedProgress(as('pm'), {
      lineId: second.id,
      periodTo: '2027-01-31',
      accepted: 0.5,
      evidence: 'Half the inspection sample passed',
    });

    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    // The supplier claims only the hire.
    recordApplication(as('pm'), { valuationId: valuation.id, lines: [{ lineId: line.id, claimed: 10, narrative: 'Ten weeks' }] });

    const assessment = assessValuation(as('pm'), valuation.id);
    const unclaimed = assessment.exceptions.find((entry) => entry.kind === 'UNCLAIMED')!;
    assert.equal(unclaimed.reference, second.reference);
    assert.match(unclaimed.statement, /lands next month as a surprise unless it is accrued now/);
  });

  it('flags a claim resting on evidence dated after the cut-off', () => {
    const line = hireLine();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10',
    });
    // Progress recorded for next month, and claimed this month.
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-02-28',
      accepted: 18,
      evidence: 'Hire dockets W11–W18, February',
    });
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), { valuationId: valuation.id, lines: [{ lineId: line.id, claimed: 18, narrative: 'Eighteen weeks' }] });

    const assessment = assessValuation(as('pm'), valuation.id);
    const premature = assessment.exceptions.find((entry) => entry.kind === 'PREMATURE')!;
    assert.match(premature.statement, /dated 2027-02-28, after the 2027-01-31 cut-off/);
    assert.match(premature.statement, /belongs to the next valuation/);
    // And the earned position for this valuation stops at the cut-off.
    assert.equal(assessment.lines[0]!.earnedMinor, 50_000_00);
  });

  it('flags progress that has gone backwards since the last certificate', () => {
    const line = hireLine();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10',
    });
    const first = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), { valuationId: first.id, lines: [{ lineId: line.id, claimed: 10, narrative: 'Ten weeks' }] });
    certifyValuation(as('pm'), { valuationId: first.id, note: 'Ten weeks' });

    // A later position that is lower: four of the ten dockets were for another
    // site. Progress does not go backwards without somebody deciding it did.
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-02-28',
      accepted: 6,
      evidence: 'Four of the January dockets were against the Rossendale compound',
    });
    const second = openValuation(as('pm'), { periodFrom: '2027-02-01', periodTo: '2027-02-28' });
    recordApplication(as('pm'), { valuationId: second.id, lines: [{ lineId: line.id, claimed: 6, narrative: 'Six weeks' }] });

    const assessment = assessValuation(as('pm'), second.id);
    const drift = assessment.exceptions.find((entry) => entry.kind === 'PRIOR_DRIFT')!;
    assert.match(drift.statement, /has less accepted now than at VAL-001/);
    // And the movement is floored at zero: a negative certificate is a credit
    // note, and it is not issued by accident.
    assert.equal(assessment.grossMinor, 0);
  });

  it('refuses an application against a valuation already certified', () => {
    const line = hireLine();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10',
    });
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), { valuationId: valuation.id, lines: [{ lineId: line.id, claimed: 10, narrative: 'Ten weeks' }] });
    certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Ten weeks' });

    const error = throwsCode(
      () =>
        recordApplication(as('pm'), {
          valuationId: valuation.id,
          lines: [{ lineId: line.id, claimed: 14, narrative: 'Actually fourteen' }],
        }),
      'VALUATION_CERTIFIED',
    );
    assert.match(String(error.message), /is next month's application/);
  });

  it('flags a claim with no accepted progress at all', () => {
    const line = hireLine();
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), { valuationId: valuation.id, lines: [{ lineId: line.id, claimed: 6, narrative: 'Six weeks' }] });
    const assessment = assessValuation(as('pm'), valuation.id);
    assert.ok(assessment.exceptions.some((entry) => entry.kind === 'UNSUPPORTED'));
    assert.equal(assessment.certifiable, false);
  });

  it('refuses a second open valuation', () => {
    hireLine();
    openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    const error = throwsCode(
      () => openValuation(as('pm'), { periodFrom: '2027-02-01', periodTo: '2027-02-28' }),
      'VALUATION_ALREADY_OPEN',
    );
    assert.match(String(error.message), /paid twice for one week/);
  });

  it('refuses to certify a valuation nobody applied against', () => {
    hireLine();
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    const error = throwsCode(
      () => certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Pay it' }),
      'VALUATION_NOT_CERTIFIABLE',
    );
    assert.match(String(error.message), /certifies what the buyer assumed the supplier would claim/);
  });

  it('refuses one line claimed twice in one application', () => {
    const line = hireLine();
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    const error = throwsCode(
      () =>
        recordApplication(as('pm'), {
          valuationId: valuation.id,
          lines: [
            { lineId: line.id, claimed: 5, narrative: 'Five weeks' },
            { lineId: line.id, claimed: 5, narrative: 'Five more' },
          ],
        }),
      'APPLICATION_LINE_DUPLICATED',
    );
    assert.match(String(error.message), /the duplicate the reconciliation exists to find/);
  });

  it('says which instrument the appointment actually issues', () => {
    hireLine();
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    // Under Prime, ETABLIX holds both sides.
    assert.match(assessValuation(as('pm'), valuation.id).issues, /customer invoice and a supplier certificate/);
  });
});

describe('§10 service credits stay separate', () => {
  function creditable() {
    const line = hireLine();
    const systemId = compose('WELFARE_ACCOMMODATION');
    const event = raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P2',
      summary: 'North block WCs unavailable for two shifts',
      source: 'Helpdesk 4471',
    });
    return { line, event };
  }

  it('refuses a credit with no KPI event behind it', () => {
    const line = hireLine();
    const error = throwsCode(
      () =>
        raiseServiceCredit(as('pm'), {
          lineId: line.id,
          eventId: 'SVE-NOTHING',
          formula: '2% of the weekly rate per shift lost',
          amountMinor: 2_000_00,
        }),
      'SERVICE_CREDIT_UNFOUNDED',
    );
    assert.match(String(error.message), /a number somebody chose/);
  });

  it('refuses a credit with no contract formula and one over its cap', () => {
    const { line, event } = creditable();
    throwsCode(
      () => raiseServiceCredit(as('pm'), { lineId: line.id, eventId: event.id, formula: '  ', amountMinor: 100 }),
      'SERVICE_CREDIT_UNFORMULATED',
    );
    const error = throwsCode(
      () =>
        raiseServiceCredit(as('pm'), {
          lineId: line.id,
          eventId: event.id,
          formula: '2% of the weekly rate per shift lost',
          amountMinor: 10_000_00,
          capMinor: 5_000_00,
        }),
      'SERVICE_CREDIT_OVER_CAP',
    );
    assert.match(String(error.message), /unenforceable in its entirety/);
  });

  it('will not approve a credit inside its cure period', () => {
    const { line, event } = creditable();
    const credit = raiseServiceCredit(as('pm'), {
      lineId: line.id,
      eventId: event.id,
      formula: '2% of the weekly rate per shift lost',
      amountMinor: 2_000_00,
      cureUntil: '2099-01-01',
    });
    const error = throwsCode(
      () => approveServiceCredit(as('pm'), { creditId: credit.id }),
      'SERVICE_CREDIT_IN_CURE',
    );
    assert.match(String(error.message), /still contractually entitled to fix/);
  });

  it('deducts an approved credit as a separate transparent adjustment', () => {
    const { line, event } = creditable();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10',
    });
    const credit = raiseServiceCredit(as('pm'), {
      lineId: line.id,
      eventId: event.id,
      formula: '2% of the weekly rate per shift lost, capped at 10% of the period',
      amountMinor: 2_000_00,
    });

    // Raised is not approved. A credit deducted before somebody agreed it is a
    // deduction the supplier discovers on the certificate, which is how a
    // credit becomes a dispute instead of a remedy.
    const early = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), { valuationId: early.id, lines: [{ lineId: line.id, claimed: 10, narrative: 'Ten weeks' }] });
    const unapproved = assessValuation(as('pm'), early.id);
    assert.equal(unapproved.deductions.length, 0, 'an unapproved credit is not a deduction');
    assert.equal(unapproved.netMinor, unapproved.grossMinor);
    certifyValuation(as('pm'), { valuationId: early.id, note: 'Ten weeks, credit still under review' });

    approveServiceCredit(as('pm'), { creditId: credit.id });

    const valuation = openValuation(as('pm'), { periodFrom: '2027-02-01', periodTo: '2027-02-28' });
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-02-28',
      accepted: 20,
      evidence: 'Hire dockets W11–W20',
    });
    recordApplication(as('pm'), { valuationId: valuation.id, lines: [{ lineId: line.id, claimed: 20, narrative: 'Twenty weeks' }] });
    const assessment = assessValuation(as('pm'), valuation.id);
    assert.equal(assessment.grossMinor, 50_000_00, 'ten more weeks of movement');
    assert.equal(assessment.netMinor, 48_000_00);
    const deduction = assessment.deductions.find((entry) => entry.kind === 'KPI')!;
    assert.match(deduction.basis, /2% of the weekly rate per shift lost/);
    // Never netted into a rate: it is on the face of the assessment as its own
    // line, with the formula it was calculated under.
    const exception = assessment.exceptions.find((entry) => entry.kind === 'KPI_DEDUCTION')!;
    assert.match(exception.statement, /rather than netted into a rate, so it can be checked and disputed/);

    const certified = certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Ten weeks less the credit' });
    assert.equal(certified.certifiedMinor, 48_000_00);
  });
});

describe('§10 the position', () => {
  it('says nothing is valuable until a line exists', () => {
    appoint();
    const position = commercialPosition(as('pm'));
    assert.equal(position.lines.length, 0);
    assert.match(position.statement, /a service nobody can pay for or measure/);
  });

  it('reports certified against earned, because they are different numbers', () => {
    const line = hireLine();
    recordAcceptedProgress(as('pm'), {
      lineId: line.id,
      periodTo: '2027-01-31',
      accepted: 10,
      evidence: 'Hire dockets W1–W10',
    });
    const valuation = openValuation(as('pm'), { periodFrom: '2027-01-01', periodTo: '2027-01-31' });
    recordApplication(as('pm'), { valuationId: valuation.id, lines: [{ lineId: line.id, claimed: 10, narrative: 'Ten weeks' }] });
    certifyValuation(as('pm'), { valuationId: valuation.id, note: 'Ten weeks' });

    const position = commercialPosition(as('pm'));
    assert.equal(position.totals.earnedMinor, 50_000_00);
    assert.equal(position.totals.certifiedMinor, 50_000_00);
    assert.equal(position.totals.budgetMinor, 200_000_00);
    assert.match(position.statement, /Certified 50,000\.00 against 50,000\.00 earned and 200,000\.00 budgeted/);
    assert.match(position.statement, /three different numbers on purpose/);
  });

  it('is refused to a tenancy without the module', () => {
    const line = hireLine();
    const ungranted = { ...as('pm'), grantedModules: [] };
    throwsCode(() => commercialPosition(ungranted), 'MODULE_NOT_GRANTED');
    throwsCode(() => openValuation(ungranted, { periodFrom: '2027-01-01', periodTo: '2027-01-31' }), 'MODULE_NOT_GRANTED');
    throwsCode(
      () => recordAcceptedProgress(ungranted, { lineId: line.id, periodTo: '2027-01-31', accepted: 1, evidence: 'x' }),
      'MODULE_NOT_GRANTED',
    );
  });
});
