import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  DEFECT_TYPES,
  KPI_FAMILIES,
  LOOP_STEPS,
  SEVERITIES,
  closeEvent,
  operationsPosition,
  pauseClock,
  progressEvent,
  raiseEvent,
  recordClosureEvidence,
  recordPeriod,
  resumeClock,
  routeToChange,
} from '../src/domain/etablix/operations.ts';
import { acceptInterface, assignInterface, composeSystem } from '../src/domain/etablix/composer.ts';
import { recordFact } from '../src/domain/etablix/brief.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §9 — live operations and service assurance.
 *
 * Two properties, and they are the two the industry gets wrong.
 *
 * 1. **Verify is a step, not a formality.** An event closes on the evidence its
 *    defect type demands, and the person closing it does not get to choose the
 *    cheapest kind. A service desk whose closure evidence is "closed by
 *    supplier" measures how quickly people press buttons.
 * 2. **A KPI without an enforced anti-gaming control is a target.**
 *    Availability improves the moment an outage can be declared planned after
 *    it happened; response improves the moment the clock can be paused without
 *    the customer knowing. Both are refused here rather than described.
 */

let platform: Platform;
let seed: SeedResult;

function as(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

const WINDOW = { fromDate: '2026-11-01', toDate: '2027-09-01', leadDays: 30 };

function appoint(): void {
  // Idempotent: a test that raises two events calls this twice, and a second
  // appointment is a commercial transition rather than a repeat.
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
    ['connectedLoadKva', 900],
    ['gateThroughputPerHour', 120],
    ['travellingWorkforce', 96],
  ] as [string, number][]) {
    recordFact(as('pm'), { itemId, value, source: 'Programme rev D' });
  }
}

function compose(family: string, zone = 'Main compound'): string {
  // One system per family per zone, so a test that wants a second event
  // against the same service re-uses the one already composed.
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

/** A welfare system with an event on it, at the severity asked for. */
function welfareEvent(severity = 'P3', defectType = 'WELFARE_UNAVAILABLE') {
  appoint();
  const systemId = compose('WELFARE_ACCOMMODATION');
  const event = raiseEvent(as('pm'), {
    systemId,
    defectType,
    severity,
    summary: 'No WCs available in the north cabin block since 0600',
    source: 'Helpdesk call 4471, site supervisor',
  });
  return { systemId, event };
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

describe('§9.1 the loop and the four severities', () => {
  it('is five steps, and the fourth is verify', () => {
    assert.deepEqual(
      LOOP_STEPS.map((step) => step.id),
      ['SENSE', 'INTERPRET', 'ACT', 'VERIFY', 'LEARN'],
    );
    for (const step of LOOP_STEPS) assert.ok(step.detail.length > 40, `${step.id} says nothing`);
  });

  it('declares four severities, each with what the platform does about it', () => {
    assert.deepEqual(SEVERITIES.map((entry) => entry.id), ['P1', 'P2', 'P3', 'P4']);
    for (const entry of SEVERITIES) {
      assert.ok(entry.definition.length > 40, `${entry.id} has no operational definition`);
      assert.ok(entry.behaviour.length >= 3, `${entry.id} does almost nothing`);
    }
    const p1 = SEVERITIES.find((entry) => entry.id === 'P1')!;
    assert.equal(p1.acknowledgeWithinMinutes, 0, 'a critical event is acknowledged immediately');
    assert.equal(p1.requiresTemporaryControl, true);
    assert.equal(p1.clockUnpausable, true);
    assert.equal(SEVERITIES.find((entry) => entry.id === 'P2')!.acknowledgeWithinMinutes, 15);
  });

  it('refuses an event against a service the defect does not belong to', () => {
    appoint();
    const cleaning = compose('CLEANING_FM');
    const error = throwsCode(
      () =>
        raiseEvent(as('pm'), {
          systemId: cleaning,
          defectType: 'HOT_WATER_LOSS',
          severity: 'P2',
          summary: 'No hot water',
          source: 'Helpdesk',
        }),
      'SERVICE_DEFECT_WRONG_FAMILY',
    );
    assert.match(String(error.message), /the wrong supplier answers for/);
  });

  it('refuses an event with no source and no description', () => {
    appoint();
    const systemId = compose('WELFARE_ACCOMMODATION');
    throwsCode(
      () =>
        raiseEvent(as('pm'), {
          systemId,
          defectType: 'WELFARE_UNAVAILABLE',
          severity: 'P3',
          summary: 'WCs out',
          source: '  ',
        }),
      'SERVICE_EVENT_UNSOURCED',
    );
    // "Fault" is not a description of a fault, and the person who picks this up
    // at 0600 has nothing to go on.
    throwsCode(
      () =>
        raiseEvent(as('pm'), {
          systemId,
          defectType: 'WELFARE_UNAVAILABLE',
          severity: 'P3',
          summary: '  ',
          source: 'Helpdesk',
        }),
      'SERVICE_EVENT_UNDESCRIBED',
    );
  });

  it('breaches the acknowledgement window while nobody has acknowledged, not once they do', () => {
    // The measure that matters at 0700 is the one that says a P2 raised at
    // 0630 is already late — not the one that stays silent until somebody
    // finally picks it up and then reports the breach retrospectively.
    const { event } = welfareEvent('P2');
    const later = new Date(Date.parse(event.raisedAt) + 60 * 60_000).toISOString();
    const breached = operationsPosition(as('pm'), later).events.find((entry) => entry.id === event.id)!;
    assert.equal(breached.acknowledgementBreached, true, 'an hour is well past fifteen minutes');
    assert.equal(breached.minutesToAcknowledge, undefined, 'nobody has acknowledged it');

    // A P4 has an eight-hour window, so the same hour is not a breach.
    const { event: request } = welfareEvent('P4');
    const stillFine = operationsPosition(as('pm'), later).events.find((entry) => entry.id === request.id)!;
    assert.equal(stillFine.acknowledgementBreached, false);

    // P1's window is zero minutes: acknowledge on receipt. A guard reading zero
    // as "no window" made the one severity with no grace the only one that
    // could never be late, and §17's service-restoration metric then reported
    // a perfect score against an unacknowledged critical event.
    const { event: critical } = welfareEvent('P1');
    const hourLater = new Date(Date.parse(critical.raisedAt) + 60 * 60_000).toISOString();
    const unacknowledged = operationsPosition(as('pm'), hourLater).events.find(
      (entry) => entry.id === critical.id,
    )!;
    assert.equal(unacknowledged.acknowledgementBreached, true, 'a P1 unacknowledged for an hour is late');
  });

  it('refuses attendance recorded before acknowledgement', () => {
    const { event } = welfareEvent('P2');
    const error = throwsCode(
      () => progressEvent(as('pm'), { eventId: event.id, to: 'ATTENDED' }),
      'SERVICE_EVENT_UNACKNOWLEDGED',
    );
    // The reason it matters: a response measure whose clock starts at
    // attendance measures nothing.
    assert.match(String(error.message), /makes the response clock read zero/);
  });

  it('refuses a temporary control that does not say what it is', () => {
    const { event } = welfareEvent('P1');
    progressEvent(as('pm'), { eventId: event.id, to: 'ACKNOWLEDGED' });
    throwsCode(
      () => progressEvent(as('pm'), { eventId: event.id, to: 'TEMPORARILY_RESTORED', note: '   ' }),
      'SERVICE_CONTROL_UNSTATED',
    );
  });
});

describe('§9.1 verify is a step, not a formality', () => {
  it('refuses evidence of a kind the defect does not close on', () => {
    const { event } = welfareEvent('P3', 'HOT_WATER_LOSS');
    const error = throwsCode(
      () => recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-9931' }),
      'SERVICE_EVIDENCE_IRRELEVANT',
    );
    assert.match(String(error.message), /A photograph of a tap proves nothing about what came out of it/);
  });

  it('refuses evidence with no reference behind it', () => {
    const { event } = welfareEvent('P3');
    throwsCode(
      () => recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: '   ' }),
      'SERVICE_EVIDENCE_UNREFERENCED',
    );
  });

  it('refuses a closure while any required evidence is missing, and names what', () => {
    const { event } = welfareEvent('P3');
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-4471' });
    throwsCode(
      () => closeEvent(as('pm'), { eventId: event.id, note: '   ' }),
      'SERVICE_CLOSURE_UNEXPLAINED',
    );
    const error = throwsCode(
      () => closeEvent(as('pm'), { eventId: event.id, note: 'Cleared the blockage' }),
      'SERVICE_CLOSURE_UNEVIDENCED',
    );
    assert.match(String(error.message), /1 (is|are) missing: user confirmation/);
    assert.match(String(error.message), /Somebody who uses it says it works/);
  });

  it('closes when every kind the defect demands is on the record', () => {
    const { event } = welfareEvent('P3');
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-4471' });
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'USER_CONFIRMATION', reference: 'Supervisor J. Amos, 0910' });
    const closed = closeEvent(as('pm'), { eventId: event.id, note: 'Blockage cleared, both cubicles back in service' });
    assert.equal(closed.status, 'CLOSED');

    // And it is idempotent. Counted in the ledger rather than compared on the
    // timestamp: two closes in the same millisecond would carry the same time
    // and the second write would still be there, which is the thing that must
    // not happen — a closure recorded twice is a response time recorded twice.
    closeEvent(as('pm'), { eventId: event.id, note: 'Again' });
    const closures = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((entry) => entry.eventType === 'SERVICE_EVENT_CLOSED');
    assert.equal(closures.length, 1);
  });

  it('acknowledges once, and refuses to move a closed event at all', () => {
    const { event } = welfareEvent('P2');
    const first = progressEvent(as('pm'), { eventId: event.id, to: 'ACKNOWLEDGED' });
    // A retried acknowledgement must not reset the clock the service credit is
    // calculated from.
    const again = progressEvent(as('pm'), { eventId: event.id, to: 'ACKNOWLEDGED' });
    assert.equal(again.acknowledgedAt, first.acknowledgedAt);
    assert.equal(
      platform.ledger
        .events({ projectId: seed.projectId })
        .filter((entry) => entry.eventType === 'SERVICE_EVENT_PROGRESSED').length,
      1,
    );

    // Attendance is the same: recorded once, because the attendance time is
    // the second half of the response measure.
    const attended = progressEvent(as('pm'), { eventId: event.id, to: 'ATTENDED' });
    assert.equal(progressEvent(as('pm'), { eventId: event.id, to: 'ATTENDED' }).attendedAt, attended.attendedAt);
    assert.equal(
      platform.ledger
        .events({ projectId: seed.projectId })
        .filter((entry) => entry.eventType === 'SERVICE_EVENT_PROGRESSED').length,
      2,
    );

    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-1' });
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'USER_CONFIRMATION', reference: 'Supervisor' });
    closeEvent(as('pm'), { eventId: event.id, note: 'Restored' });

    // Re-opening is a new event with a reference to this one, so the response
    // time on the original stays what it was.
    const error = throwsCode(
      () => progressEvent(as('pm'), { eventId: event.id, to: 'ATTENDED' }),
      'SERVICE_EVENT_CLOSED',
    );
    assert.match(String(error.message), /a new event with a reference to this one/);
  });

  it('supersedes evidence of the same kind rather than stacking it', () => {
    const { event } = welfareEvent('P3');
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-0001' });
    const updated = recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-0002' });
    assert.equal(updated.evidence.filter((entry) => entry.kind === 'PHOTO').length, 1);
    assert.equal(updated.evidence.find((entry) => entry.kind === 'PHOTO')!.reference, 'IMG-0002');
  });

  it('refuses to close a critical event that nobody ever controlled', () => {
    const { event } = welfareEvent('P1');
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-1' });
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'USER_CONFIRMATION', reference: 'Supervisor' });
    const error = throwsCode(
      () => closeEvent(as('pm'), { eventId: event.id, note: 'Sorted' }),
      'SERVICE_CONTROL_ABSENT',
    );
    assert.match(String(error.message), /nobody controlled/);

    progressEvent(as('pm'), { eventId: event.id, to: 'ACKNOWLEDGED' });
    progressEvent(as('pm'), {
      eventId: event.id,
      to: 'TEMPORARILY_RESTORED',
      note: 'Four portable units brought to the north gate and signed for',
    });
    assert.equal(closeEvent(as('pm'), { eventId: event.id, note: 'Mains restored' }).status, 'CLOSED');
  });

  it('shows what is still blocking a closure, before anybody tries', () => {
    const { event } = welfareEvent('P1');
    const view = operationsPosition(as('pm')).events.find((entry) => entry.id === event.id)!;
    assert.ok(view.blocking.includes('photo not recorded'));
    assert.ok(view.blocking.includes('user confirmation not recorded'));
    assert.ok(view.blocking.includes('no temporary control recorded'));
  });
});

describe('§9.2 the anti-gaming controls', () => {
  it('is seven families, each with a control and an honest word for whether it is enforced', () => {
    assert.equal(KPI_FAMILIES.length, 7);
    for (const family of KPI_FAMILIES) {
      assert.ok(family.method.length > 30, `${family.id} does not say how it is measured`);
      assert.ok(family.antiGaming.length > 30, `${family.id} has no anti-gaming control`);
      assert.ok(['ENFORCED', 'REPORTED'].includes(family.enforcement));
    }
    // The two the platform cannot enforce without a roster or a GPS feed say
    // so rather than implying a control that is not there.
    assert.equal(KPI_FAMILIES.find((entry) => entry.id === 'AVAILABILITY')!.enforcement, 'ENFORCED');
    assert.equal(KPI_FAMILIES.find((entry) => entry.id === 'SECURITY_ACCESS')!.enforcement, 'REPORTED');
  });

  it('refuses an exclusion approved after the outage began', () => {
    appoint();
    const systemId = compose('WELFARE_ACCOMMODATION');
    const error = throwsCode(
      () =>
        recordPeriod(as('pm'), {
          systemId,
          from: '2027-01-01T00:00:00.000Z',
          to: '2027-01-08T00:00:00.000Z',
          requiredMinutes: 10_080,
          availableMinutes: 9_000,
          plannedExclusions: [
            {
              from: '2027-01-03T08:00:00.000Z',
              to: '2027-01-03T20:00:00.000Z',
              reason: 'Tank clean',
              // Signed off two days after it started.
              approvedAt: '2027-01-05T09:00:00.000Z',
              approvedBy: 'Client FM',
            },
          ],
        }),
      'SERVICE_EXCLUSION_RETROSPECTIVE',
    );
    assert.match(String(error.message), /a failure with a note on it/);
  });

  it('counts an exclusion approved beforehand, and shows the raw figure beside it', () => {
    appoint();
    const systemId = compose('WELFARE_ACCOMMODATION');
    recordPeriod(as('pm'), {
      systemId,
      from: '2027-01-01T00:00:00.000Z',
      to: '2027-01-08T00:00:00.000Z',
      requiredMinutes: 10_080,
      availableMinutes: 9_360,
      degradedMinutes: 240,
      plannedExclusions: [
        {
          from: '2027-01-03T08:00:00.000Z',
          to: '2027-01-03T20:00:00.000Z',
          reason: 'Planned tank clean, agreed at the Monday meeting',
          approvedAt: '2026-12-20T09:00:00.000Z',
          approvedBy: 'Client FM, Janet Kirkbride',
        },
      ],
    });
    const view = operationsPosition(as('pm')).availability.find((entry) => entry.systemId === systemId)!;
    assert.equal(view.excludedMinutes, 720);
    // 9,360 available against 10,080 − 720 = 9,360 required. Full marks with
    // the exclusion, 92.9% without it, and both are on the screen.
    assert.equal(view.availabilityPercent, 100);
    assert.equal(view.rawPercent, 92.9);
    // Degraded minutes are tracked separately and never counted as available.
    assert.equal(view.degradedMinutes, 240);
  });

  it('refuses a period that claims more availability than was required', () => {
    appoint();
    const systemId = compose('WELFARE_ACCOMMODATION');
    // Availability against a requirement of zero is a percentage of nothing,
    // and it is always 100%.
    throwsCode(
      () =>
        recordPeriod(as('pm'), {
          systemId,
          from: '2027-01-01T00:00:00.000Z',
          to: '2027-01-08T00:00:00.000Z',
          requiredMinutes: 0,
          availableMinutes: 0,
        }),
      'SERVICE_PERIOD_UNREQUIRED',
    );
    throwsCode(
      () =>
        recordPeriod(as('pm'), {
          systemId,
          from: '2027-01-01T00:00:00.000Z',
          to: '2027-01-08T00:00:00.000Z',
          requiredMinutes: 100,
          availableMinutes: 200,
        }),
      'SERVICE_PERIOD_IMPOSSIBLE',
    );
    throwsCode(
      () =>
        recordPeriod(as('pm'), {
          systemId,
          from: '2027-01-01T00:00:00.000Z',
          to: '2027-01-08T00:00:00.000Z',
          requiredMinutes: 100,
          availableMinutes: 50,
          degradedMinutes: 80,
        }),
      'SERVICE_PERIOD_DEGRADED_IMPOSSIBLE',
    );
  });

  it('will not pause a critical clock at all', () => {
    const { event } = welfareEvent('P1');
    const error = throwsCode(
      () => pauseClock(as('pm'), { eventId: event.id, reason: 'Awaiting parts', approvedBy: 'Client FM' }),
      'SERVICE_CLOCK_UNPAUSABLE',
    );
    assert.match(String(error.message), /agreed in the room where the pressure is/);
  });

  it('pauses a major clock only with a reason and a named customer approval', () => {
    const { event } = welfareEvent('P2');
    throwsCode(
      () => pauseClock(as('pm'), { eventId: event.id, reason: 'Waiting', approvedBy: '  ' }),
      'SERVICE_PAUSE_UNAPPROVED',
    );
    const paused = pauseClock(as('pm'), {
      eventId: event.id,
      reason: 'Access to the block withdrawn for a lift over it',
      approvedBy: 'Client FM, Janet Kirkbride',
    });
    assert.equal(paused.pauses.length, 1);
    throwsCode(
      () => pauseClock(as('pm'), { eventId: event.id, reason: 'Again', approvedBy: 'Somebody' }),
      'SERVICE_CLOCK_ALREADY_PAUSED',
    );
  });

  it('will not close an event whose clock is still stopped', () => {
    const { event } = welfareEvent('P2');
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'PHOTO', reference: 'IMG-1' });
    recordClosureEvidence(as('pm'), { eventId: event.id, kind: 'USER_CONFIRMATION', reference: 'Supervisor' });
    pauseClock(as('pm'), { eventId: event.id, reason: 'Access withdrawn', approvedBy: 'Client FM' });

    const error = throwsCode(
      () => closeEvent(as('pm'), { eventId: event.id, note: 'Done' }),
      'SERVICE_CLOCK_PAUSED',
    );
    assert.match(String(error.message), /whatever it read when somebody stopped it/);

    // And the register says so before anybody tries, rather than only at the
    // refusal.
    const blocked = operationsPosition(as('pm')).events.find((entry) => entry.id === event.id)!;
    assert.ok(blocked.blocking.includes('clock still paused'));

    resumeClock(as('pm'), { eventId: event.id });
    // Resuming a clock nobody stopped is a no-op, not a second resume event.
    const before = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((entry) => entry.eventType === 'SERVICE_CLOCK_RESUMED').length;
    resumeClock(as('pm'), { eventId: event.id });
    assert.equal(
      platform.ledger
        .events({ projectId: seed.projectId })
        .filter((entry) => entry.eventType === 'SERVICE_CLOCK_RESUMED').length,
      before,
    );
    assert.equal(closeEvent(as('pm'), { eventId: event.id, note: 'Done' }).status, 'CLOSED');
  });

  it('takes the paused minutes out of the response time rather than out of the record', () => {
    const { event } = welfareEvent('P2');
    const paused = pauseClock(as('pm'), {
      eventId: event.id,
      reason: 'Access withdrawn',
      approvedBy: 'Client FM',
    });
    resumeClock(as('pm'), { eventId: event.id });
    const view = operationsPosition(as('pm')).events.find((entry) => entry.id === event.id)!;
    assert.equal(view.pauses.length, 1);
    assert.equal(view.pauses[0]!.approvedBy, 'Client FM');
    assert.ok(view.pausedMinutes >= 0);
    assert.equal(paused.pauses[0]!.reason, 'Access withdrawn');
  });
});

describe('§9.1 P4 is a request, not a failure', () => {
  it('routes a request to change control, and refuses to route a defect there', () => {
    const { event } = welfareEvent('P4');
    const routed = routeToChange(as('pm'), {
      eventId: event.id,
      reason: 'A second drying room is more welfare than the brief established, not a failure of what was agreed',
    });
    assert.match(String(routed.routedToChange), /second drying room/);

    const { event: defect } = welfareEvent('P2');
    const error = throwsCode(
      () => routeToChange(as('pm'), { eventId: defect.id, reason: 'Send it to change' }),
      'SERVICE_ROUTING_NOT_A_REQUEST',
    );
    assert.match(String(error.message), /a defect nobody fixed/);
  });
});

describe('§9.1 learn', () => {
  it('calls a second failure of one thing in one place a pattern', () => {
    appoint();
    const systemId = compose('WELFARE_ACCOMMODATION');
    for (const summary of ['No WCs in the north block', 'North block WCs out again']) {
      raiseEvent(as('pm'), {
        systemId,
        defectType: 'WELFARE_UNAVAILABLE',
        severity: 'P3',
        summary,
        source: 'Helpdesk',
      });
    }
    raiseEvent(as('pm'), {
      systemId,
      defectType: 'ROOM_DEFECT',
      severity: 'P3',
      summary: 'Room 14 heater failed',
      source: 'Inspection',
    });

    const patterns = operationsPosition(as('pm')).patterns;
    assert.equal(patterns.length, 1, 'one failure is a defect; two in one place is a pattern');
    assert.equal(patterns[0]!.occurrences, 2);
    assert.match(patterns[0]!.statement, /a question about the regime or the asset, not about the last repair/);
  });

  it('names which KPI families each composed service is measured under', () => {
    appoint();
    compose('WELFARE_ACCOMMODATION');
    compose('SECURITY_LOGISTICS');
    const measured = operationsPosition(as('pm')).measuredUnder;
    const welfare = measured.find((entry) => entry.family === 'WELFARE_ACCOMMODATION')!;
    assert.ok(welfare.kpis.some((entry) => entry.id === 'ACCOMMODATION'));
    assert.ok(welfare.kpis.some((entry) => entry.id === 'AVAILABILITY'));
    const security = measured.find((entry) => entry.family === 'SECURITY_LOGISTICS')!;
    assert.ok(security.kpis.some((entry) => entry.id === 'TRANSPORT_LOGISTICS'));
    assert.ok(!security.kpis.some((entry) => entry.id === 'ACCOMMODATION'));
  });

  it('declares a defect type per family, each saying why its evidence and not something cheaper', () => {
    assert.ok(DEFECT_TYPES.length >= 12);
    for (const defect of DEFECT_TYPES) {
      assert.ok(defect.closure.length > 0, `${defect.id} closes on nothing`);
      assert.ok(defect.matters.length > 40, `${defect.id} does not say why that evidence`);
    }
    // The families that actually carry a service each have somewhere to file a
    // failure. Procurement control is a workflow rather than a service, and has
    // none deliberately.
    const covered = new Set(DEFECT_TYPES.map((entry) => entry.family));
    for (const family of [
      'WELFARE_ACCOMMODATION',
      'CLEANING_FM',
      'TEMPORARY_MEP',
      'SECURITY_LOGISTICS',
      'TEMPORARY_INFRASTRUCTURE',
      'ENABLING_CIVILS',
    ]) {
      assert.ok(covered.has(family as never), `${family} has no defect type`);
    }
  });

  it('is refused to a tenancy without the module', () => {
    const { event, systemId } = welfareEvent('P3');
    const ungranted = { ...as('pm'), grantedModules: [] };
    throwsCode(() => operationsPosition(ungranted), 'MODULE_NOT_GRANTED');
    throwsCode(() => closeEvent(ungranted, { eventId: event.id, note: 'x' }), 'MODULE_NOT_GRANTED');
    throwsCode(
      () =>
        raiseEvent(ungranted, {
          systemId,
          defectType: 'WELFARE_UNAVAILABLE',
          severity: 'P3',
          summary: 'x',
          source: 'y',
        }),
      'MODULE_NOT_GRANTED',
    );
  });
});
