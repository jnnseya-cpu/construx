import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  ENTITLEMENT_VIEWS,
  TRIGGERS,
  changePosition,
  giveNotice,
  progressChange,
  raiseChange,
} from '../src/domain/etablix/change.ts';
import {
  WORKSTREAMS,
  acceptWorkstream,
  agreeRemovalPlan,
  demobilisationPosition,
  openWorkstream,
  proposeRunDown,
  recordDemobEvidence,
} from '../src/domain/etablix/demobilisation.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §11 change and §12 demobilisation.
 *
 * Two rules, one each, and both are things the industry does wrong on purpose
 * because doing them right is uncomfortable.
 *
 * **§11's golden rule.** No change becomes forecast-neutral because it lacks an
 * approved quotation. A job carrying three hundred thousand pounds of
 * instructed-but-unpriced work reports itself on budget right up until somebody
 * agrees a number, and the only fix is to keep entitlement, probability and
 * value as three separate fields and put the risk-adjusted exposure on the
 * forecast from day one.
 *
 * **§12's first workstream.** Prevent premature loss of statutory welfare.
 * Demobilisation is the phase where the last WCs go back because the compound
 * is "finishing" and there are still forty people working, and the arithmetic
 * that stops it is the same Schedule 1 table the welfare was sized from.
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

function welfare(): string {
  appoint();
  return compose('WELFARE_ACCOMMODATION');
}

/** A change at whatever certainty the test needs. */
function change(over: Partial<Parameters<typeof raiseChange>[1]> = {}) {
  return raiseChange(as('pm'), {
    trigger: 'CUSTOMER_INSTRUCTION',
    summary: 'A second drying room at the north compound',
    difference: 'The baseline welfare schedule has one drying room; the instruction adds a second at the north end.',
    entitlement: 'CLEAR',
    probabilityPercent: 90,
    valueMinor: 40_000_00,
    ...over,
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

describe('§11 the six triggers', () => {
  it('is six, each asking a different question and saying what a controlled result looks like', () => {
    assert.equal(TRIGGERS.length, 6);
    for (const trigger of TRIGGERS) {
      assert.ok(trigger.analysis.length > 40, `${trigger.id} does not say what is analysed`);
      assert.ok(trigger.result.length > 20, `${trigger.id} has no controlled result`);
    }
    // Four start a contract clock and two do not, and the difference decides
    // whether a notice is a formality or the thing the entitlement rests on.
    assert.equal(TRIGGERS.filter((entry) => entry.noticeBearing).length, 4);
    assert.equal(TRIGGERS.find((entry) => entry.id === 'DEMAND_VARIANCE')!.noticeBearing, false);
  });

  it('refuses a trigger it does not recognise, and says why one free-text reason is not enough', () => {
    appoint();
    const error = throwsCode(
      () =>
        change({ trigger: 'SOMETHING_HAPPENED' }),
      'SERVICE_CHANGE_TRIGGER_UNKNOWN',
    );
    assert.match(String(error.message), /collapses all six into whichever is easiest to write down/);
  });

  it('refuses a change that cannot say what moved', () => {
    appoint();
    const error = throwsCode(() => change({ difference: '  ' }), 'SERVICE_CHANGE_UNBASELINED');
    assert.match(String(error.message), /"As discussed" is not a difference/);
  });
});

describe('§11 the golden rule', () => {
  it('refuses a change with no probability and no value, because both become zero silently', () => {
    appoint();
    const unlikely = throwsCode(
      () => change({ probabilityPercent: Number.NaN }),
      'SERVICE_CHANGE_UNLIKELY',
    );
    assert.match(String(unlikely.message), /sits at zero in the forecast until somebody agrees a number/);

    const unvalued = throwsCode(() => change({ valueMinor: Number.NaN }), 'SERVICE_CHANGE_UNVALUED');
    assert.match(String(unvalued.message), /Zero is a value and it is allowed; absent is not/);
  });

  it('carries a pending change as risk-adjusted exposure, not as nothing', () => {
    appoint();
    change({ valueMinor: 40_000_00, probabilityPercent: 75, entitlement: 'ARGUABLE' });
    const position = changePosition(as('pm'));
    assert.equal(position.agreedMinor, 0, 'nothing has been agreed');
    // 75% of £40,000 is £30,000 on the forecast today, with no quotation
    // anywhere near it.
    assert.equal(position.exposureMinor, 30_000_00);
    assert.equal(position.exposureAtFaceMinor, 40_000_00);
    assert.match(position.statement, /worth 40,000\.00 at face and 30,000\.00 risk-adjusted/);
    assert.match(position.statement, /None of it is zero in the forecast, whatever the quotation position is/);
    assert.match(position.goldenRule, /^No change becomes forecast-neutral because it lacks an approved quotation/);
  });

  it('keeps entitlement, probability and value as three separate fields', () => {
    appoint();
    // A change worth a lot, very likely to be argued, with a weak entitlement.
    // Collapsed into one expected value, nobody can see which of the three is
    // the weak one — and it is always a different one.
    change({ valueMinor: 100_000_00, probabilityPercent: 30, entitlement: 'WEAK' });
    const view = changePosition(as('pm')).changes[0]!;
    assert.equal(view.valueMinor, 100_000_00);
    assert.equal(view.probabilityPercent, 30);
    assert.equal(view.entitlement, 'WEAK');
    assert.equal(view.entitlementLabel, 'Weak');
    assert.equal(view.exposureMinor, 30_000_00);
    assert.equal(ENTITLEMENT_VIEWS.length, 4);
  });

  it('moves an agreed change to certainty rather than leaving it a guess', () => {
    appoint();
    const raised = change({ valueMinor: 40_000_00, probabilityPercent: 60 });
    progressChange(as('pm'), { changeId: raised.id, to: 'QUOTED', basis: 'Quotation Q-118 received', valueMinor: 44_000_00 });
    const agreed = progressChange(as('pm'), {
      changeId: raised.id,
      to: 'AGREED',
      basis: 'Agreed at the commercial meeting, instruction CI-042',
      valueMinor: 42_000_00,
    });
    assert.equal(agreed.probabilityPercent, 100, 'an agreed change is certain by definition');

    const position = changePosition(as('pm'));
    assert.equal(position.agreedMinor, 42_000_00);
    assert.equal(position.exposureMinor, 0, 'nothing pending');
  });

  it('refuses to agree a change that is still a probability', () => {
    appoint();
    const raised = change();
    progressChange(as('pm'), { changeId: raised.id, to: 'QUOTED', basis: 'Quoted' });
    const error = throwsCode(
      () =>
        progressChange(as('pm'), {
          changeId: raised.id,
          to: 'AGREED',
          basis: 'Probably fine',
          probabilityPercent: 80,
        }),
      'SERVICE_CHANGE_AGREED_UNCERTAIN',
    );
    assert.match(String(error.message), /it has been quoted, and the forecast should carry it as exposure/);
  });

  it('refuses to move a change backwards, or after it is settled', () => {
    appoint();
    const raised = change();
    progressChange(as('pm'), { changeId: raised.id, to: 'QUOTED', basis: 'Quoted' });
    const backwards = throwsCode(
      () => progressChange(as('pm'), { changeId: raised.id, to: 'NOTIFIED', basis: 'Undo' }),
      'SERVICE_CHANGE_BACKWARDS',
    );
    assert.match(String(backwards.message), /that decision is a rejection/);

    progressChange(as('pm'), { changeId: raised.id, to: 'REJECTED', basis: 'Withdrawn by the customer' });
    throwsCode(
      () => progressChange(as('pm'), { changeId: raised.id, to: 'AGREED', basis: 'Actually yes' }),
      'SERVICE_CHANGE_CLOSED',
    );
    // A rejected change is out of the exposure, because it is not going to
    // happen — and it is still on the register, because it did.
    const position = changePosition(as('pm'));
    assert.equal(position.exposureMinor, 0);
    assert.equal(position.changes.length, 1);
  });
});

describe('§11 the notice', () => {
  it('records a notice with its reference, and flags one still outstanding', () => {
    appoint();
    const raised = change({ noticeDueBy: '2027-01-15' });
    const before = changePosition(as('pm'), '2027-01-10').changes[0]!;
    assert.equal(before.noticeOutstanding, true);
    assert.equal(before.noticeLapsed, false);

    // Past the date with nothing sent: the entitlement is the thing at risk.
    const lapsed = changePosition(as('pm'), '2027-02-01').changes[0]!;
    assert.equal(lapsed.noticeLapsed, true);

    throwsCode(() => giveNotice(as('pm'), { changeId: raised.id, reference: '  ' }), 'SERVICE_CHANGE_NOTICE_UNREFERENCED');
    const notified = giveNotice(as('pm'), { changeId: raised.id, reference: 'EW-2027-014 sent 12 January' });
    assert.equal(notified.status, 'NOTIFIED');
    assert.equal(changePosition(as('pm'), '2027-02-01').changes[0]!.noticeLapsed, false);

    // A second notice does not overwrite the first. The date the notice was
    // actually given is the date the entitlement turns on, and re-sending a
    // covering letter in March does not move it to March.
    const again = giveNotice(as('pm'), { changeId: raised.id, reference: 'EW-2027-014 resent in error' });
    assert.equal(again.noticeGivenAt, notified.noticeGivenAt);
    assert.equal(again.noticeReference, 'EW-2027-014 sent 12 January');
    assert.equal(
      platform.ledger
        .events({ projectId: seed.projectId })
        .filter((entry) => entry.eventType === 'SERVICE_CHANGE_NOTIFIED').length,
      1,
    );
  });

  it('refuses a notice against a trigger that starts no clock', () => {
    appoint();
    const raised = change({ trigger: 'DEMAND_VARIANCE' });
    const error = throwsCode(
      () => giveNotice(as('pm'), { changeId: raised.id, reference: 'EW-1' }),
      'SERVICE_CHANGE_NOT_NOTIFIABLE',
    );
    assert.match(String(error.message), /a formality on the file that the contract never asked for/);
  });

  it('is refused to a tenancy without the module', () => {
    appoint();
    const ungranted = { ...as('pm'), grantedModules: [] };
    throwsCode(() => changePosition(ungranted), 'MODULE_NOT_GRANTED');
  });
});

describe('§12 demobilisation begins at design', () => {
  it('is seven workstreams, each with its controls and the evidence it closes on', () => {
    assert.equal(WORKSTREAMS.length, 7);
    for (const workstream of WORKSTREAMS) {
      assert.ok(workstream.controls.length > 40, `${workstream.id} has no controls`);
      assert.ok(workstream.acceptance.length > 20, `${workstream.id} closes on nothing`);
    }
  });

  it('refuses a removal plan missing any of its six fields, and names them', () => {
    const systemId = welfare();
    const error = throwsCode(
      () =>
        agreeRemovalPlan(as('pm'), {
          systemId,
          owner: 'Halcyon Welfare Systems Ltd',
          method: '  ',
          trigger: '  ',
          costMinor: 12_000_00,
          wasteRoute: 'Licensed transfer station, Bolton',
          reinstatementCriterion: 'Pre-occupation condition survey CS-01',
        }),
      'REMOVAL_PLAN_INCOMPLETE',
    );
    assert.match(String(error.message), /"removed" is not a method/);
    assert.match(String(error.message), /a trigger — a date, a milestone or a successor being ready/);
    assert.match(String(error.message), /agreed at the end instead of now, when somebody still wants something from you/);
  });

  it('refuses an unpriced plan and allows a free one', () => {
    const systemId = welfare();
    const base = {
      systemId,
      owner: 'Halcyon Welfare Systems Ltd',
      method: 'Units drained, disconnected, lifted and returned to depot',
      trigger: 'Successor welfare accepted at the south compound',
      wasteRoute: 'Licensed transfer station, Bolton, WCL-4471',
      reinstatementCriterion: 'Pre-occupation condition survey CS-01, hardstanding left in place by agreement',
    };
    const error = throwsCode(
      () => agreeRemovalPlan(as('pm'), { ...base, costMinor: Number.NaN }),
      'REMOVAL_PLAN_UNPRICED',
    );
    assert.match(String(error.message), /discovered at the end when there is nothing left to negotiate with/);
    // Zero is a real answer: a supplier collecting its own hire costs nothing.
    assert.equal(agreeRemovalPlan(as('pm'), { ...base, costMinor: 0 }).costMinor, 0);
  });

  it('names every composed system with no removal plan', () => {
    appoint();
    compose('WELFARE_ACCOMMODATION');
    compose('CLEANING_FM');
    const position = demobilisationPosition(as('pm'));
    assert.equal(position.unplanned, 2);
    assert.match(position.statement, /2 of 2 composed systems have no removal plan/);
    // And each carries what §4 already said the removal obligation was.
    assert.ok(position.plans.every((entry) => entry.obligation.length > 30));
  });
});

describe('§12 premature loss of statutory welfare', () => {
  it('refuses a run-down that leaves fewer WCs than the people still there require', () => {
    const systemId = welfare();
    const error = throwsCode(
      () =>
        proposeRunDown(as('pm'), {
          systemId,
          remainingPersons: 40,
          remainingWcs: 1,
          effectiveFrom: '2027-07-01',
          basis: 'Programme rev F, north compound closing',
        }),
      'RUNDOWN_BELOW_STATUTORY',
    );
    // Schedule 1 Table 1: 40 people need 3.
    assert.match(String(error.message), /40 people still on site require 3 WCs under Schedule 1 Table 1/);
    assert.match(String(error.message), /there are still people working/);
    assert.match(String(error.message), /Name the successor facility, or leave the provision where it is/);
  });

  it('allows it where the provision moves rather than goes', () => {
    const systemId = welfare();
    const record = proposeRunDown(as('pm'), {
      systemId,
      remainingPersons: 40,
      remainingWcs: 1,
      effectiveFrom: '2027-07-01',
      successor: 'South compound welfare block, accepted 2027-06-20 and 400m from the workface',
      basis: 'Programme rev F, north compound closing',
    });
    assert.match(String(record.successor), /South compound welfare block/);
    // And the register still shows it as below the statutory minimum on its
    // own, because the successor is the reason it is acceptable rather than a
    // reason it is not true.
    const view = demobilisationPosition(as('pm')).runDowns[0]!;
    assert.equal(view.requiredWcs, 3);
    assert.equal(view.belowStatutory, true);
    assert.ok(view.successor);
  });

  it('allows a run-down that stays above the minimum', () => {
    const systemId = welfare();
    const record = proposeRunDown(as('pm'), {
      systemId,
      remainingPersons: 40,
      remainingWcs: 4,
      effectiveFrom: '2027-07-01',
      basis: 'Programme rev F',
    });
    assert.equal(record.remainingWcs, 4);
    assert.equal(demobilisationPosition(as('pm')).runDowns[0]!.belowStatutory, false);
  });

  it('refuses a run-down against a headcount nobody sourced', () => {
    const systemId = welfare();
    const error = throwsCode(
      () =>
        proposeRunDown(as('pm'), {
          systemId,
          remainingPersons: 10,
          remainingWcs: 4,
          effectiveFrom: '2027-07-01',
          basis: '  ',
        }),
      'RUNDOWN_UNBASED',
    );
    assert.match(String(error.message), /how the last WCs leave while forty people are still working/);
  });

  it('does not apply the welfare arithmetic to a service that provides none', () => {
    appoint();
    const cleaning = compose('CLEANING_FM');
    // A cleaning contract running down to one operative is not a statutory
    // welfare question, and refusing it on that basis would be nonsense.
    const record = proposeRunDown(as('pm'), {
      systemId: cleaning,
      remainingPersons: 40,
      remainingWcs: 0,
      effectiveFrom: '2027-07-01',
      basis: 'Cleaning scope reduces to the south compound only',
    });
    assert.equal(record.remainingWcs, 0);
  });
});

describe('§12 closeout is accepted on evidence', () => {
  it('refuses acceptance on a narrative', () => {
    welfare();
    const record = openWorkstream(as('pm'), { workstream: 'TEMPORARY_CIVILS' });
    const error = throwsCode(
      () => acceptWorkstream(as('pm'), { recordId: record.id, note: 'All done and the client is happy' }),
      'DEMOB_ACCEPTANCE_UNEVIDENCED',
    );
    assert.match(String(error.message), /reopens the day the landowner walks the site/);
    assert.match(String(error.message), /Survey, tickets, compaction/);
  });

  it('accepts once the evidence is on the record', () => {
    welfare();
    const record = openWorkstream(as('pm'), { workstream: 'TEMPORARY_CIVILS' });
    recordDemobEvidence(as('pm'), {
      recordId: record.id,
      reference: 'SUR-2027-088',
      description: 'As-left survey against the pre-occupation condition record',
    });
    recordDemobEvidence(as('pm'), {
      recordId: record.id,
      reference: 'WTN-4471 to WTN-4488',
      description: 'Waste transfer notes for 340 tonnes of hardcore to the licensed transfer station',
    });
    const accepted = acceptWorkstream(as('pm'), {
      recordId: record.id,
      note: 'Hardstanding broken out, drainage capped, land returned to CS-01',
    });
    assert.equal(accepted.status, 'ACCEPTED');
    // Idempotent, and closed to further evidence. Counted in the ledger rather
    // than compared on the timestamp: two acceptances in the same millisecond
    // would carry the same time and the second write would still be there,
    // which is the thing that must not happen — a workstream accepted twice is
    // a closeout with two acceptances and no rule for choosing.
    acceptWorkstream(as('pm'), { recordId: record.id, note: 'Again' });
    assert.equal(
      platform.ledger
        .events({ projectId: seed.projectId })
        .filter((entry) => entry.eventType === 'DEMOBILISATION_ACCEPTED').length,
      1,
    );
    assert.ok(accepted.acceptedAt);
    throwsCode(
      () => recordDemobEvidence(as('pm'), { recordId: record.id, reference: 'X', description: 'Late' }),
      'DEMOB_ALREADY_ACCEPTED',
    );
  });

  it('refuses to close the run-down workstream with no run-down behind it', () => {
    welfare();
    const record = openWorkstream(as('pm'), { workstream: 'DEMAND_RUNDOWN' });
    recordDemobEvidence(as('pm'), {
      recordId: record.id,
      reference: 'REL-01',
      description: 'Phase release signed by the construction manager',
    });
    const error = throwsCode(
      () => acceptWorkstream(as('pm'), { recordId: record.id, note: 'Everybody has gone' }),
      'DEMOB_RUNDOWN_UNPLANNED',
    );
    assert.match(String(error.message), /removes the last WCs from under forty people/);
  });

  it('refuses to close an asset removal that was never planned', () => {
    const systemId = welfare();
    const record = openWorkstream(as('pm'), { workstream: 'ASSET_REMOVAL', systemId });
    recordDemobEvidence(as('pm'), {
      recordId: record.id,
      reference: 'COL-9931',
      description: 'Collection note for eight welfare units',
    });
    const error = throwsCode(
      () => acceptWorkstream(as('pm'), { recordId: record.id, note: 'All collected' }),
      'DEMOB_REMOVAL_UNPLANNED',
    );
    assert.match(String(error.message), /at whatever cost, to whatever standard/);

    agreeRemovalPlan(as('pm'), {
      systemId,
      owner: 'Halcyon Welfare Systems Ltd',
      method: 'Units drained, disconnected, lifted and returned to depot',
      trigger: 'Successor welfare accepted',
      costMinor: 12_000_00,
      wasteRoute: 'Returned to supplier depot; consumables to licensed transfer station WCL-4471',
      reinstatementCriterion: 'Hardstanding left in place by agreement, surveyed against CS-01',
    });
    assert.equal(acceptWorkstream(as('pm'), { recordId: record.id, note: 'All collected' }).status, 'ACCEPTED');
  });

  it('opens a workstream once, and totals what removal actually costs', () => {
    const systemId = welfare();
    const first = openWorkstream(as('pm'), { workstream: 'FINAL_ACCOUNT' });
    assert.equal(openWorkstream(as('pm'), { workstream: 'FINAL_ACCOUNT' }).id, first.id);

    agreeRemovalPlan(as('pm'), {
      systemId,
      owner: 'Halcyon Welfare Systems Ltd',
      method: 'Units drained, disconnected, lifted and returned',
      trigger: 'Successor welfare accepted',
      costMinor: 12_000_00,
      wasteRoute: 'Supplier depot, consumables to WCL-4471',
      reinstatementCriterion: 'Surveyed against CS-01',
    });
    const position = demobilisationPosition(as('pm'));
    assert.equal(position.removalCostMinor, 12_000_00);
    assert.equal(position.unplanned, 0);
    assert.match(position.statement, /Known at design rather than discovered at the end/);
    assert.equal(position.workstreams.length, 7);
    assert.equal(position.workstreams.find((entry) => entry.id === 'FINAL_ACCOUNT')!.open, 1);
  });

  it('supersedes a removal plan rather than keeping two', () => {
    const systemId = welfare();
    const base = {
      systemId,
      owner: 'Halcyon Welfare Systems Ltd',
      method: 'Units lifted and returned',
      trigger: 'Successor accepted',
      wasteRoute: 'Supplier depot',
      reinstatementCriterion: 'Surveyed against CS-01',
    };
    agreeRemovalPlan(as('pm'), { ...base, costMinor: 12_000_00 });
    agreeRemovalPlan(as('pm'), { ...base, costMinor: 15_000_00, method: 'Units lifted, hardstanding broken out' });
    const position = demobilisationPosition(as('pm'));
    // One system, one removal method — not two plans and no rule for choosing.
    assert.equal(position.removalCostMinor, 15_000_00);
    assert.match(String(position.plans[0]!.plan!.method), /hardstanding broken out/);
  });

  it('is refused to a tenancy without the module', () => {
    welfare();
    const ungranted = { ...as('pm'), grantedModules: [] };
    throwsCode(() => demobilisationPosition(ungranted), 'MODULE_NOT_GRANTED');
  });
});
