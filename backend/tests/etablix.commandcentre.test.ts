import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  ACTIVITIES,
  AUTOMATION_CLASSES,
  AUTOMATION_METRICS,
  AUTOMATION_TARGET_PERCENT,
  AUTOMATION_WORKFLOWS,
  NEXT_NEEDS,
  NOW_SUBJECTS,
  WORKSPACES,
  automationMeasure,
  commandCentre,
  nameOwners,
} from '../src/domain/etablix/commandcentre.ts';
import { EVENT_TYPES } from '../src/goldenthread/eventTypes.ts';
import { acceptInterface, assignInterface, composeSystem, recordObservation } from '../src/domain/etablix/composer.ts';
import { assumeFact, recordFact } from '../src/domain/etablix/brief.ts';
import { setAppointment } from '../src/domain/etablix/appointment.ts';
import { raiseEvent } from '../src/domain/etablix/operations.ts';
import { giveNotice, raiseChange } from '../src/domain/etablix/change.ts';
import { agreeRemovalPlan, openWorkstream } from '../src/domain/etablix/demobilisation.ts';
import { attestEvidence } from '../src/domain/etablix/mobilisation.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * §13 the eight command centres, §13.1 the universal panel, §17 the measure.
 *
 * The failure this module exists to prevent is a dashboard that looks like an
 * answer. Every assertion below is aimed at one of the two ways that happens:
 * a tile with no rule behind it, and a metric that reports zero when it means
 * "nothing has happened yet".
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

function compose(family = 'WELFARE_ACCOMMODATION', zone = 'Main compound'): string {
  appoint();
  const existing = platform.ledger
    .list(seed.projectId, 'ServiceSystem')
    .map((record) => record.state as unknown as { id: string; family: string; zone: string })
    .find((entry) => entry.family === family && entry.zone === zone);
  if (existing) return existing.id;
  const { system } = composeSystem(as('pm'), { family, zone, ...WINDOW });
  return system.id;
}

/** Compose and close every interface, so a test about gates is not about interfaces. */
function composeClosed(family = 'WELFARE_ACCOMMODATION', zone = 'Main compound'): string {
  appoint();
  const { system, interfaces } = composeSystem(as('pm'), { family, zone, ...WINDOW });
  for (const entry of interfaces) {
    assignInterface(as('pm'), { interfaceId: entry.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-15' });
    acceptInterface(as('pm'), { interfaceId: entry.id, note: `${entry.name} agreed` });
  }
  return system.id;
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

describe('§1.2 the automation boundary', () => {
  it('is three classes, each stating an authority rather than a difficulty', () => {
    assert.equal(AUTOMATION_CLASSES.length, 3);
    assert.deepEqual(
      AUTOMATION_CLASSES.map((entry) => entry.id),
      ['A', 'B', 'C'],
    );
    for (const entry of AUTOMATION_CLASSES) {
      assert.ok(entry.authority.length > 20, `${entry.id} does not state its authority`);
      assert.ok(entry.examples.length > 30, `${entry.id} gives no examples`);
    }
  });

  it('classifies every ETABLIX event exactly once, and classifies nothing that is not one', () => {
    // Read from the catalogue's own source rather than a second list here. A
    // §6 event added later with no class would otherwise fall silently out of
    // §17's denominator, which is exactly how an automation metric becomes
    // marketing.
    const source = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'goldenthread', 'eventTypes.ts'),
      'utf8',
    );
    const start = source.indexOf('--- ETABLIX site services');
    assert.ok(start > 0, 'the ETABLIX block marker has moved; this test can no longer find the catalogue');
    const declared = new Set([...source.slice(start).matchAll(/def\('([A-Z_0-9]+)'/g)].map((match) => match[1]!));

    const classified = new Set(Object.keys(ACTIVITIES));
    const unclassified = [...declared].filter((code) => !classified.has(code));
    const invented = [...classified].filter((code) => !declared.has(code));

    assert.deepEqual(unclassified, [], `ETABLIX events with no automation class: ${unclassified.join(', ')}`);
    assert.deepEqual(invented, [], `classified codes that are not ETABLIX events: ${invented.join(', ')}`);
    assert.ok(declared.size >= 50, 'the ETABLIX block should hold every section’s events');
  });

  it('never puts a Class A activity on an event an agent is forbidden to author', () => {
    // The two declarations have to agree or the class is a fiction: an agent
    // cannot autonomously complete something the ledger refuses it.
    const byCode = new Map(EVENT_TYPES.map((entry) => [entry.code, entry]));
    for (const [code, activity] of Object.entries(ACTIVITIES)) {
      if (activity.class !== 'A') continue;
      assert.equal(byCode.get(code)!.aiAllowed, true, `${code} is Class A but the catalogue forbids an AI author`);
    }
  });

  it('never puts a Class C activity on an event an agent is permitted to author', () => {
    const byCode = new Map(EVENT_TYPES.map((entry) => [entry.code, entry]));
    for (const [code, activity] of Object.entries(ACTIVITIES)) {
      if (activity.class !== 'C') continue;
      assert.equal(byCode.get(code)!.aiAllowed, false, `${code} is human-controlled but an agent may author it`);
    }
  });

  it('keeps the acts that decide money and identity out of Class A', () => {
    for (const code of [
      'SITE_SERVICES_APPOINTED',
      'SERVICE_AWARD_RECOMMENDED',
      'SERVICE_VALUATION_CERTIFIED',
      'MOBILISATION_ACCEPTED',
      'DEMOBILISATION_ACCEPTED',
    ]) {
      assert.equal(ACTIVITIES[code]!.class, 'C', `${code} must be human-controlled`);
    }
  });

  it('assigns every activity to one of the nine workflows', () => {
    const known = new Set(AUTOMATION_WORKFLOWS.map((entry) => entry.id));
    for (const [code, activity] of Object.entries(ACTIVITIES)) {
      assert.ok(known.has(activity.workflow), `${code} names workflow ${activity.workflow}, which does not exist`);
    }
    // Every workflow has to own something, or it is a heading with no content.
    for (const workflow of AUTOMATION_WORKFLOWS) {
      const owned = Object.values(ACTIVITIES).filter((entry) => entry.workflow === workflow.id);
      assert.ok(owned.length > 0, `${workflow.id} classifies no activity`);
    }
  });
});

describe('§17 the measure', () => {
  it('reports nothing rather than zero on a project where nothing has happened', () => {
    const measure = automationMeasure(as('pm'));
    assert.equal(measure.totals.recorded, 0);
    const ratio = measure.metrics.find((metric) => metric.id === 'AGENT_DRIVEN_RATIO')!;
    assert.equal(ratio.value, undefined, 'an empty project must not report 0% automated');
    assert.match(ratio.basis, /nothing to take a ratio of/);
    assert.match(measure.statement, /not zero percent automated/);
  });

  it('counts a human-authored activity against the ratio rather than leaving it out', () => {
    appoint();
    const measure = automationMeasure(as('pm'));
    const ratio = measure.metrics.find((metric) => metric.id === 'AGENT_DRIVEN_RATIO')!;
    assert.ok(measure.totals.eligible > 0);
    assert.equal(ratio.value, 0, 'five facts recorded by a person is genuinely 0% agent-driven');
    assert.ok(measure.totals.agentDriven === 0);
  });

  it('excludes Class C from the denominator and says how many it excluded', () => {
    appoint();
    const measure = automationMeasure(as('pm'));
    // The appointment itself is Class C; the five facts are Class A.
    assert.equal(measure.totals.humanControlled, 1);
    assert.equal(measure.totals.eligible, measure.totals.recorded - 1);
    assert.match(measure.statement, /Class C, human-controlled by design/);
  });

  it('counts an activity an agent completed unattended as autonomous', () => {
    appoint();
    // An agent working inside a granted envelope: same command, same
    // authorisation, different author on the event. That difference is the
    // whole numerator of §17, so it is asserted rather than assumed.
    const agent = { ...as('pm'), actingAs: { refType: 'AI' as const, refId: 'brief-extraction-agent' } };
    recordFact(agent, { itemId: 'busSeatsPerShift', value: 48, source: 'Transport strategy rev B, page 4' });

    const measure = automationMeasure(as('pm'));
    const fact = measure.activities.find((entry) => entry.code === 'SITE_SERVICE_FACT_RECORDED')!;
    assert.equal(fact.count, 6);
    assert.equal(fact.autonomous, 1);
    assert.equal(fact.agentPrepared, 0);
    assert.equal(measure.totals.agentDriven, 1);

    const brief = measure.byWorkflow.find((entry) => entry.workflow === 'BRIEF')!;
    assert.equal(brief.autonomous, 1);
    assert.equal(brief.ratioPercent, 16.7);
  });

  it('counts a person’s act carrying an agent’s work as agent-prepared, not as their own', () => {
    appoint();
    const agent = { ...as('pm'), actingAs: { refType: 'AI' as const, refId: 'brief-extraction-agent' } };
    const found = recordFact(agent, { itemId: 'busSeatsPerShift', value: 48, source: 'Transport strategy rev B' });
    const cause = platform.ledger.eventsForEntity({ refType: 'SiteServiceFact', refId: found.id }).at(-1)!;
    const ctx = as('pm');

    // Written at the ledger rather than through a command, deliberately: no
    // ETABLIX engine calls an AI provider yet, so neither an `ai` block nor a
    // causation link is reachable through a domain command today. The two
    // branches exist because the platform's own write path produces both the
    // moment one does, and the failure they prevent — a person pressing go on
    // an agent's draft being counted as entirely human work — is the exact
    // number §17 asks for. Asserted here so the classifier is proven against
    // the shape of the events, not against an engine that has not been built.
    platform.ledger.commit({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      actor: { refType: 'User', refId: ctx.auth.actorId },
      source: 'WEB',
      eventType: 'SITE_SERVICE_FACT_SUPERSEDED',
      entity: { refType: 'SiteServiceFact', refId: found.id },
      nextState: { ...found, supersededBy: 'later', supersededAt: '2026-10-21T09:00:00.000Z' },
      correlationId: ctx.correlationId,
      causationId: cause.eventId,
    });

    const measure = automationMeasure(as('pm'));
    const superseded = measure.activities.find((entry) => entry.code === 'SITE_SERVICE_FACT_SUPERSEDED')!;
    assert.equal(superseded.count, 1);
    assert.equal(superseded.autonomous, 0);
    assert.equal(superseded.agentPrepared, 1, 'an act caused by an agent’s finding is not the person’s own work');
    assert.equal(measure.totals.agentDriven, 2);
  });

  it('counts an act carrying an AI block as agent-prepared even with a person as its author', () => {
    appoint();
    const ctx = as('pm');
    const found = recordFact(ctx, { itemId: 'busSeatsPerShift', value: 48, source: 'Transport strategy rev B' });
    platform.ledger.commit({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      actor: { refType: 'User', refId: ctx.auth.actorId },
      source: 'WEB',
      eventType: 'SITE_SERVICE_FACT_SUPERSEDED',
      entity: { refType: 'SiteServiceFact', refId: found.id },
      nextState: { ...found, supersededBy: 'later', supersededAt: '2026-10-21T09:00:00.000Z' },
      correlationId: ctx.correlationId,
      // Held but not consumed: the agent's output was prepared and a person
      // committed it, so the spend is not billed against this event. The
      // ledger permits an AI block on a human-authored event only in exactly
      // that case — anything that consumed ACUs must name an AI author.
      ai: { aiRequestId: 'req-0001', provider: 'ANTHROPIC', acuHeld: 4, acuConsumed: 0, confidence: 0.82 },
    });

    const measure = automationMeasure(as('pm'));
    const superseded = measure.activities.find((entry) => entry.code === 'SITE_SERVICE_FACT_SUPERSEDED')!;
    assert.equal(superseded.agentPrepared, 1);
    assert.equal(superseded.autonomous, 0, 'a person authored it; the agent prepared it');
  });

  it('measures straight-through and the exception rate on the arithmetic, not on the vibe', () => {
    // A fixture with one of each case, so both figures have a hand-checkable
    // answer rather than "some number appeared".
    //
    //   F1  agent records a fact, a person writes over it   → corrected, weight 1
    //   F2  agent records a fact, nobody touches it         → clean,     weight 1
    //   C1  agent raises a change, a person gives notice    → corrected, weight 2
    //   R1  agent agrees a removal plan (Class B)           → not eligible for
    //                                                         straight-through
    const systemId = composeClosed();
    const agent = { ...as('pm'), actingAs: { refType: 'AI' as const, refId: 'site-services-agent' } };

    const f1 = recordFact(agent, { itemId: 'busSeatsPerShift', value: 48, source: 'Transport strategy rev B' });
    recordFact(agent, { itemId: 'gateThroughputPerHour', value: 240, source: 'Access control datasheet' });
    const c1 = raiseChange(agent, {
      trigger: 'PROGRAMME_MOVEMENT',
      summary: 'Compound stays six weeks longer',
      difference: 'The baseline off-hires the compound in July; the revised programme needs it to September.',
      entitlement: 'CLEAR',
      probabilityPercent: 85,
      valueMinor: 60_000_00,
    });
    agreeRemovalPlan(agent, {
      systemId,
      owner: 'Northern Site Services Ltd',
      method: 'Cabins craned out, slab broken to 300mm and carted',
      trigger: 'Successor welfare accepted at the north compound',
      costMinor: 18_000_00,
      wasteRoute: 'Licensed inert transfer station, Bradford',
      reinstatementCriterion: 'Topsoil to 300mm against the pre-works ground survey',
    });

    // The two corrections, both on the same record the agent wrote.
    const ctx = as('pm');
    platform.ledger.commit({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      actor: { refType: 'User', refId: ctx.auth.actorId },
      source: 'WEB',
      eventType: 'SITE_SERVICE_FACT_SUPERSEDED',
      entity: { refType: 'SiteServiceFact', refId: f1.id },
      nextState: { ...f1, supersededBy: 'later', supersededAt: '2026-10-21T09:00:00.000Z' },
      correlationId: ctx.correlationId,
    });
    giveNotice(as('pm'), { changeId: c1.id, reference: 'EW-014' });

    const measure = automationMeasure(as('pm'));

    // Straight-through: Class A, agent-completed, never written over. Three
    // qualify (two facts and the change); one of the three was corrected.
    const straight = measure.metrics.find((metric) => metric.id === 'STRAIGHT_THROUGH')!;
    assert.equal(straight.value, 33.3);
    assert.match(straight.basis, /1 of 3 agent-completed Class A activities/);

    // Exceptions: the change is a commercial record and counts double, so two
    // corrected outputs weigh 3 against 4 of agent output.
    const exceptions = measure.metrics.find((metric) => metric.id === 'HUMAN_EXCEPTION_RATE')!;
    assert.equal(exceptions.value, 75);
    assert.match(exceptions.basis, /3 of 4 weighted agent outputs/);
  });

  it('does not count a person’s earlier work as a correction of the agent that followed it', () => {
    // A person records the figure and an agent supersedes it later. The agent's
    // act went straight through: the human touch is *before* it, not a
    // correction of it, and reading the whole record rather than what came
    // after would report the opposite.
    appoint();
    const found = recordFact(as('pm'), { itemId: 'busSeatsPerShift', value: 48, source: 'Transport strategy rev B' });
    const ctx = as('pm');
    platform.ledger.commit({
      tenantId: ctx.tenantId,
      projectId: ctx.projectId,
      actor: { refType: 'AI', refId: 'brief-extraction-agent' },
      source: 'AI',
      eventType: 'SITE_SERVICE_FACT_SUPERSEDED',
      entity: { refType: 'SiteServiceFact', refId: found.id },
      nextState: { ...found, supersededBy: 'later', supersededAt: '2026-10-21T09:00:00.000Z' },
      correlationId: ctx.correlationId,
    });

    const straight = automationMeasure(as('pm')).metrics.find((metric) => metric.id === 'STRAIGHT_THROUGH')!;
    assert.equal(straight.value, 100);
    assert.match(straight.basis, /1 of 1 agent-completed Class A activities/);
  });

  it('splits the ratio by workflow rather than blending it', () => {
    appoint();
    const measure = automationMeasure(as('pm'));
    const brief = measure.byWorkflow.find((entry) => entry.workflow === 'BRIEF')!;
    const appointmentWorkflow = measure.byWorkflow.find((entry) => entry.workflow === 'APPOINTMENT')!;
    assert.equal(brief.eligible, 5);
    // The appointment event is Class C, so its workflow has no eligible
    // activity at all — and reports that rather than a ratio.
    assert.equal(appointmentWorkflow.eligible, 0);
    assert.equal(appointmentWorkflow.ratioPercent, undefined);
  });

  it('names every one of §17’s ten metrics, each with a definition, target and basis', () => {
    assert.equal(AUTOMATION_METRICS.length, 10);
    const measure = automationMeasure(as('pm'));
    assert.equal(measure.metrics.length, 10);
    for (const metric of measure.metrics) {
      assert.ok(metric.definition.length > 40, `${metric.id} has no definition`);
      assert.ok(metric.target.length > 3, `${metric.id} has no target`);
      assert.ok(metric.basis.length > 20, `${metric.id} does not say what it was measured from`);
    }
    assert.equal(AUTOMATION_TARGET_PERCENT, 90);
  });

  it('never reports a negative elapsed time on a cycle that is still running', () => {
    // The brief opened minutes ago. Measured against midnight of the current
    // day it opened "-1 days ago", which reads as a broken clock rather than
    // as a new project.
    appoint();
    const metric = automationMeasure(as('pm')).metrics.find((entry) => entry.id === 'BRIEF_TO_BASELINE')!;
    assert.match(metric.basis, /The brief opened 0 days ago/);
  });

  it('counts one excluded Class C activity as one activity, not as one activities', () => {
    appoint();
    const ratio = automationMeasure(as('pm')).metrics.find((entry) => entry.id === 'AGENT_DRIVEN_RATIO')!;
    assert.match(ratio.basis, /1 further activity is Class C and excluded/);
  });

  it('refuses to report forecast accuracy on a live project, and says why', () => {
    appoint();
    const metric = automationMeasure(as('pm')).metrics.find((entry) => entry.id === 'FORECAST_ACCURACY')!;
    assert.equal(metric.value, undefined);
    assert.match(metric.basis, /no site-services account on this project has been closed out/);
  });

  it('times the brief-to-baseline cycle from the first fact, and reports it as still running', () => {
    appoint();
    const metric = automationMeasure(as('pm')).metrics.find((entry) => entry.id === 'BRIEF_TO_BASELINE')!;
    assert.equal(metric.value, undefined, 'a cycle that has not finished has no elapsed figure');
    assert.match(metric.basis, /no baseline has been agreed/);
  });

  it('counts a correction as an exception, and a clean agent output as straight through', () => {
    appoint();
    const before = automationMeasure(as('pm'));
    assert.equal(before.metrics.find((metric) => metric.id === 'STRAIGHT_THROUGH')!.value, undefined);
    // Nothing agent-authored exists, so straight-through has nothing to measure
    // — which is reported as nothing, not as 100%.
    assert.match(before.metrics.find((metric) => metric.id === 'HUMAN_EXCEPTION_RATE')!.basis, /No agent output/);
  });

  it('withholds the certified-value metric from somebody without commercial standing', () => {
    appoint();
    const metric = automationMeasure(as('siteManager')).metrics.find(
      (entry) => entry.id === 'EVIDENCE_BACKED_VALUATION',
    )!;
    assert.equal(metric.value, undefined);
    assert.match(metric.basis, /Withheld/);
  });

  it('reports mobilisation predictability from gates rather than from a declaration', () => {
    composeClosed();
    const metric = automationMeasure(as('pm')).metrics.find((entry) => entry.id === 'MOBILISATION_PREDICTABILITY')!;
    assert.equal(metric.value, 0, 'one composed system, none accepted');
    assert.match(metric.basis, /is at G0/);
  });
});

describe('§13 the eight workspaces', () => {
  it('is eight, each with the question §13 says it must answer immediately', () => {
    assert.equal(WORKSPACES.length, 8);
    for (const workspace of WORKSPACES) {
      assert.ok(workspace.mustAnswer.length > 40, `${workspace.id} has no question`);
      assert.ok(workspace.audience.length > 5, `${workspace.id} names no audience`);
      assert.ok(workspace.sources.length > 0, `${workspace.id} reads nothing`);
      assert.ok(workspace.questions.length >= 5, `${workspace.id} has not decomposed its sentence`);
    }
  });

  it('says of every question whether the platform can answer it, and from what', () => {
    for (const workspace of WORKSPACES) {
      for (const question of workspace.questions) {
        assert.ok(question.basis.length > 30, `${workspace.id}/${question.id} has no basis`);
        if (question.answered) {
          // An answered question either names the position it reads or is
          // answered by the panel itself; either way the basis has to say so.
          assert.ok(question.basis.length > 30);
        } else {
          assert.match(
            question.basis,
            /Not built/,
            `${workspace.id}/${question.id} is unanswered but does not say what is missing`,
          );
        }
      }
    }
  });

  it('records the gaps it cannot answer rather than showing a green tile', () => {
    // Four of the eight have a real gap, and each is an entity family that does
    // not exist rather than a screen that was not drawn. Stated here so that
    // building one of them fails this assertion and forces the count down.
    const withGaps = WORKSPACES.filter((workspace) => workspace.questions.some((question) => !question.answered));
    assert.deepEqual(
      withGaps.map((workspace) => workspace.id).sort(),
      ['ACCOMMODATION_DESK', 'COMMERCIAL', 'EXECUTIVE_PORTFOLIO', 'FIELD_MOBILE', 'SUPPLIER_PORTAL'],
    );
  });

  it('never lists an entry on a workspace that does not read the position it came from', () => {
    // A tag with no fetch behind it is dead code that looks like a feature. The
    // fixture is deliberately broad so most derivations produce something.
    const systemId = composeClosed();
    raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    compose('CLEANING_FM', 'North compound');
    assumeFact(as('pm'), {
      itemId: 'busSeatsPerShift',
      value: 50,
      basis: 'No bus contract is let, so the seat count is the transport strategy’s figure',
      decideBy: '2026-10-24',
      owner: 'Logistics manager',
    });
    raiseChange(as('pm'), {
      trigger: 'DEMAND_VARIANCE',
      summary: 'Peak workforce above the sizing basis',
      difference: 'The compound was sized for 164 and the programme now peaks at 190.',
      entitlement: 'ARGUABLE',
      probabilityPercent: 60,
      valueMinor: 25_000_00,
    });

    const byId = new Map(WORKSPACES.map((entry) => [entry.id, entry]));
    for (const workspace of WORKSPACES) {
      if (workspace.id === 'SUPPLIER_PORTAL') continue;
      const centre = commandCentre(as('pm'), workspace.id, { today: '2026-10-20' });
      for (const entry of [...centre.now, ...centre.next]) {
        assert.ok(
          byId.get(workspace.id)!.sources.includes(entry.from),
          `${workspace.id} shows ${entry.id}, derived from ${entry.from}, which it does not read`,
        );
      }
    }
  });

  it('refuses every workspace it declares commercial to a reader without commercial standing', () => {
    appoint();
    const commercial = WORKSPACES.filter((workspace) => workspace.commercial);
    assert.ok(commercial.length >= 3);
    for (const workspace of commercial) {
      throwsCode(
        () => commandCentre(as('siteManager'), workspace.id),
        'ACCESS_DENIED',
        `${workspace.id} is declared commercial and does not refuse`,
      );
    }
    // And the ones that are not declared commercial answer for the same reader,
    // or the declaration is doing nothing.
    for (const workspace of WORKSPACES.filter((entry) => !entry.commercial && entry.id !== 'SUPPLIER_PORTAL')) {
      assert.doesNotThrow(() => commandCentre(as('siteManager'), workspace.id));
    }
  });

  it('reads only the positions its own workspace declares', () => {
    // The control tower shows no money, so it must not call a position that
    // authorises at COMMERCIAL_L3 — otherwise a site manager gets a refusal
    // for the whole screen instead of the screen they are entitled to.
    const tower = WORKSPACES.find((workspace) => workspace.id === 'CONTROL_TOWER')!;
    assert.equal(tower.commercial, false);
    assert.ok(!tower.sources.includes('commercial'));
    assert.ok(!tower.sources.includes('change'));
  });

  it('assembles for somebody with no commercial standing at all', () => {
    composeClosed();
    const centre = commandCentre(as('siteManager'), 'CONTROL_TOWER', { today: '2026-10-20' });
    assert.equal(centre.workspace.id, 'CONTROL_TOWER');
    assert.ok(centre.now.length > 0);
  });

  it('refuses a commercial workspace to somebody without commercial standing', () => {
    appoint();
    const error = throwsCode(() => commandCentre(as('siteManager'), 'COMMERCIAL'), 'ACCESS_DENIED');
    assert.match(error.message!, /Commercial-L3/);
  });

  it('refuses a workspace that does not exist, and lists the eight', () => {
    const error = throwsCode(() => commandCentre(as('pm'), 'DASHBOARD'), 'WORKSPACE_UNKNOWN');
    assert.match(error.message!, /EXECUTIVE_PORTFOLIO/);
    assert.match(error.message!, /ACCOMMODATION_DESK/);
  });

  it('refuses an unscoped supplier portal, because it would show a supplier its competitors', () => {
    appoint();
    const error = throwsCode(() => commandCentre(as('pm'), 'SUPPLIER_PORTAL'), 'SUPPLIER_REQUIRED');
    assert.match(error.message!, /competitors/);
  });
});

describe('§13.1 the universal panel', () => {
  it('carries a rule and an action on every entry, in both horizons', () => {
    composeClosed();
    raiseEvent(as('pm'), {
      systemId: compose(),
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });

    assert.ok(centre.now.length + centre.next.length > 0, 'nothing to assert against');
    for (const entry of [...centre.now, ...centre.next]) {
      assert.ok(entry.why.rule.length > 40, `${entry.id} has no rule behind it`);
      assert.ok(entry.why.evidence.length > 10, `${entry.id} has no evidence`);
      assert.ok(entry.action.decision.length > 10, `${entry.id} asks for no decision`);
      assert.ok(entry.action.owner.roles.length > 0, `${entry.id} names no owner`);
      assert.ok(entry.action.deadlineBasis.length > 20, `${entry.id} does not explain its deadline`);
      assert.ok(entry.action.consequence.length > 20, `${entry.id} states no consequence of inaction`);
      assert.ok(entry.action.prepared.length > 20, `${entry.id} says nothing an agent has prepared`);
    }
  });

  it('gives a NOW entry a record the reader can open, wherever one exists', () => {
    composeClosed();
    const systemId = compose();
    raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const event = centre.now.find((entry) => entry.subject === 'CRITICAL_EVENT');
    assert.ok(event, 'a P1 does not appear on the control tower');
    assert.equal(event.why.source?.refType, 'ServiceEvent');
    assert.equal(event.tone, 'CRITICAL');
  });

  it('puts a P1 on the field app and the accommodation desk, not only the control tower', () => {
    const systemId = composeClosed();
    raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    for (const workspace of ['FIELD_MOBILE', 'ACCOMMODATION_DESK'] as const) {
      const centre = commandCentre(as('pm'), workspace, { today: '2026-10-20' });
      assert.ok(
        centre.now.some((entry) => entry.subject === 'CRITICAL_EVENT'),
        `a P1 does not reach ${workspace}`,
      );
    }
  });

  it('buckets a NEXT entry into 2, 7 or 30 days from the date on the record', () => {
    const systemId = composeClosed();
    attestEvidence(as('pm'), {
      systemId,
      gate: 'G0',
      itemId: 'insurance',
      reference: 'POL-2026-0041',
      expiresAt: '2026-10-25',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const expiring = centre.next.find((entry) => entry.need === 'EVIDENCE');
    assert.ok(expiring, 'expiring evidence does not reach the panel');
    assert.equal(expiring.withinDays, 7);
    assert.equal(expiring.overdue, false);
    assert.equal(expiring.action.dueAt, '2026-10-25');
  });

  it('buckets a date three weeks out into the month window, and drops one beyond it', () => {
    appoint();
    const near = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'East compound', ...WINDOW });
    assignInterface(as('pm'), { interfaceId: near.interfaces[0]!.id, owner: 'Ruth Adeyemi', dueDate: '2026-11-09' });
    assignInterface(as('pm'), { interfaceId: near.interfaces[1]!.id, owner: 'Ruth Adeyemi', dueDate: '2027-02-01' });

    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const inMonth = centre.next.find((entry) => entry.id === `interface:${near.interfaces[0]!.id}`);
    assert.ok(inMonth, 'a date twenty days out does not reach the month window');
    assert.equal(inMonth.withinDays, 30);

    assert.equal(
      centre.next.find((entry) => entry.id === `interface:${near.interfaces[1]!.id}`),
      undefined,
      'a date three months out is not what NEXT is for',
    );
  });

  it('marks a date that has already passed as overdue rather than as due in two days', () => {
    // An interface owed a fortnight ago. Used rather than lapsed evidence
    // because lapsed evidence leaves the expiring list entirely and reappears
    // as an unsatisfied gate item — correctly, since it is no longer evidence.
    appoint();
    const { interfaces } = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'North compound', ...WINDOW });
    assignInterface(as('pm'), { interfaceId: interfaces[0]!.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-06' });

    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const late = centre.next.find((entry) => entry.id === `interface:${interfaces[0]!.id}`);
    assert.ok(late, 'an interface a fortnight overdue does not reach the panel');
    assert.equal(late.overdue, true);
    assert.equal(late.withinDays, 2);
    assert.equal(late.tone, 'CRITICAL');
  });

  it('drops lapsed evidence out of the expiring list and shows it as an unsatisfied gate instead', () => {
    const systemId = composeClosed();
    attestEvidence(as('pm'), {
      systemId,
      gate: 'G0',
      itemId: 'insurance',
      reference: 'POL-2026-0041',
      expiresAt: '2026-10-25',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-28' });
    assert.equal(centre.next.find((entry) => entry.need === 'EVIDENCE'), undefined);
    const gate = centre.now.find((entry) => entry.id === `gate:${systemId}`)!;
    assert.match(gate.why.evidence, /Insurance in place/);
  });

  it('says a notice date is missing rather than that the trigger bears no notice', () => {
    // Programme movement is one of the four notice-bearing triggers. A change
    // raised under it with no date recorded is a date somebody has to go and
    // find in the contract — which is a different sentence from "this trigger
    // needs no notice", and the wrong one on the panel loses the entitlement.
    appoint();
    raiseChange(as('pm'), {
      trigger: 'PROGRAMME_MOVEMENT',
      summary: 'Compound stays six weeks longer',
      difference: 'The baseline off-hires the compound in April; the revised programme needs it to June.',
      entitlement: 'CLEAR',
      probabilityPercent: 85,
      valueMinor: 60_000_00,
    });
    const bearing = commandCentre(as('pm'), 'COMMERCIAL', { today: '2026-10-20' }).next.find((entry) =>
      entry.id.startsWith('change:'),
    )!;
    assert.match(bearing.action.deadlineBasis, /bears a contract notice and no date has been recorded/);

    // And a trigger that genuinely bears none says so.
    raiseChange(as('pm'), {
      trigger: 'DEMAND_VARIANCE',
      summary: 'Peak workforce above the sizing basis',
      difference: 'The compound was sized for 164 and the programme now peaks at 190.',
      entitlement: 'ARGUABLE',
      probabilityPercent: 60,
      valueMinor: 25_000_00,
    });
    const notBearing = commandCentre(as('pm'), 'COMMERCIAL', { today: '2026-10-20' }).next.find(
      (entry) => entry.id.startsWith('change:') && entry.headline.includes('Peak workforce'),
    )!;
    assert.match(notBearing.action.deadlineBasis, /bears no contract notice/);
  });

  it('dates a P1 to the moment it was raised, because that is when it was due', () => {
    const systemId = composeClosed();
    const raised = raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const event = centre.now.find((entry) => entry.subject === 'CRITICAL_EVENT')!;
    assert.equal(event.action.dueAt, raised.raisedAt.slice(0, 10));
    assert.match(event.action.deadlineBasis, /due the moment it was raised/);
  });

  it('collapses unowned interfaces into the one decision they actually are', () => {
    // Six paragraphs saying "name the counterparty", one per interface name, is
    // six paragraphs of the same decision by the same person.
    compose('WELFARE_ACCOMMODATION');
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const unowned = centre.now.filter((entry) => entry.id.startsWith('interface-unowned'));
    assert.equal(unowned.length, 1, 'the unowned interfaces are not collapsed');
    assert.match(unowned[0]!.headline, /interfaces have nobody on the other side/);
    // And every name is still in it, so collapsing lost nothing.
    assert.match(unowned[0]!.action.decision, /Cleaning/);
    assert.match(unowned[0]!.why.evidence, /unowned of/);
  });

  it('explains the absence of a deadline instead of leaving it blank', () => {
    // An interface with nobody named on the other side cannot have a deadline:
    // there is nobody to owe one. It still has to say that rather than show a
    // blank date.
    compose('WELFARE_ACCOMMODATION');
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const undated = [...centre.now, ...centre.next].filter((entry) => entry.action.dueAt === undefined);
    assert.ok(undated.length > 0, 'nothing undated to assert against');
    for (const entry of undated) {
      assert.match(
        entry.action.deadlineBasis,
        /No date|no date|No single date|No deployment|no contractual date|No contractual date|no deployment|No return date|bears no contractual notice/,
        `${entry.id} has no deadline and does not say why`,
      );
    }
  });

  it('takes an interface’s deadline from the system’s arrival where the interface carries none', () => {
    compose('WELFARE_ACCOMMODATION');
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const iface = centre.next.find((entry) => entry.id.startsWith('interface:'));
    assert.ok(iface, 'an open interface on a system arriving in twelve days does not reach the panel');
    assert.equal(iface.action.dueAt, WINDOW.fromDate);
    assert.match(iface.action.deadlineBasis, /carries no date of its own/);
  });

  it('names the four NOW subjects and the six NEXT needs from §13.1, and nothing else', () => {
    assert.deepEqual(
      NOW_SUBJECTS.map((entry) => entry.id),
      ['SERVICE_HEALTH', 'CRITICAL_EVENT', 'CAPACITY', 'CONSTRAINT'],
    );
    assert.deepEqual(
      NEXT_NEEDS.map((entry) => entry.id),
      ['EVIDENCE', 'SPACE', 'UTILITIES', 'SUPPLIER_ACTION', 'APPROVAL', 'FUNDING'],
    );
    const subjects = new Set<string>(NOW_SUBJECTS.map((entry) => entry.id));
    const needs = new Set<string>(NEXT_NEEDS.map((entry) => entry.id));
    composeClosed();
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    for (const entry of centre.now) assert.ok(subjects.has(entry.subject!), `${entry.subject} is not a §13.1 subject`);
    for (const entry of centre.next) assert.ok(needs.has(entry.need!), `${entry.need} is not a §13.1 need`);
  });

  it('shows a provisional value as an approval falling due on its decision date', () => {
    appoint();
    assumeFact(as('pm'), {
      itemId: 'busSeatsPerShift',
      value: 50,
      basis: 'No bus contract is let, so the seat count is the transport strategy’s figure',
      decideBy: '2026-10-24',
      owner: 'Logistics manager',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const decision = centre.next.find((entry) => entry.id.startsWith('provisional:'));
    assert.ok(decision, 'a provisional value with a decision date does not reach the panel');
    assert.equal(decision.need, 'APPROVAL');
    assert.equal(decision.withinDays, 7);
    assert.match(decision.why.rule, /never allowed to become the answer/);
  });

  it('sorts NOW by severity and NEXT by how soon it falls due', () => {
    const systemId = composeClosed();
    raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    assert.equal(centre.now[0]!.tone, 'CRITICAL');
    const windows = centre.next.map((entry) => entry.withinDays ?? 99);
    assert.deepEqual([...windows].sort((a, b) => a - b), windows, 'NEXT is not in date order');
  });

  it('says on the customer project what the appointment in force is', () => {
    composeClosed();
    const centre = commandCentre(as('pm'), 'CUSTOMER_PROJECT', { today: '2026-10-20' });
    assert.match(centre.statement, /under the Principal model/);
  });

  it('reports a workspace with nothing outstanding as nothing outstanding, not as empty', () => {
    appoint();
    const centre = commandCentre(as('pm'), 'PROCUREMENT', { today: '2026-10-20' });
    assert.equal(centre.now.length, 0);
    assert.equal(centre.next.length, 0);
    assert.match(centre.statement, /Nothing is outstanding on Procurement today/);
  });

  it('surfaces a change on the commercial workspace with the golden rule as its reason', () => {
    appoint();
    raiseChange(as('pm'), {
      trigger: 'CUSTOMER_INSTRUCTION',
      summary: 'A second drying room at the north compound',
      difference: 'The baseline welfare schedule has one drying room; the instruction adds a second.',
      entitlement: 'CLEAR',
      probabilityPercent: 90,
      valueMinor: 40_000_00,
    });
    const centre = commandCentre(as('pm'), 'COMMERCIAL', { today: '2026-10-20' });
    const change = centre.next.find((entry) => entry.id.startsWith('change:'));
    assert.ok(change, 'a live change does not reach the commercial workspace');
    assert.equal(change.need, 'FUNDING');
    assert.match(change.why.rule, /No change becomes forecast-neutral/);
  });

  it('records an observation as capacity drift once the live basis moves', () => {
    const systemId = composeClosed();
    recordObservation(as('pm'), {
      derivationId: 'potableDemandLitresPerDay',
      observed: 12_000,
      over: 'November 2026',
      source: 'Meter reading, main compound',
    });
    // The observation itself does not drift the system; the fact behind it
    // does. Asserted so the panel is not credited with a signal it invents.
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-12-02' });
    assert.ok(centre.now.every((entry) => !entry.id.startsWith('drift:')));
  });
});

describe('what the panel leaves out', () => {
  it('drops an interface once it is accepted', () => {
    const systemId = composeClosed();
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    assert.equal(
      centre.next.find((entry) => entry.need === 'UTILITIES' || entry.id.startsWith('interface:')),
      undefined,
      'an accepted interface is not outstanding',
    );
    assert.ok(centre.now.some((entry) => entry.id === `gate:${systemId}`), 'the fixture produced nothing at all');
  });

  it('drops a system once its removal plan is agreed', () => {
    const systemId = composeClosed();
    const before = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2027-08-20' });
    assert.ok(before.next.some((entry) => entry.id === `removal:${systemId}`));

    agreeRemovalPlan(as('pm'), {
      systemId,
      owner: 'Northern Site Services Ltd',
      method: 'Cabins craned out, slab broken to 300mm and carted',
      trigger: 'Successor welfare accepted at the north compound',
      costMinor: 18_000_00,
      wasteRoute: 'Licensed inert transfer station, Bradford',
      reinstatementCriterion: 'Topsoil to 300mm against the pre-works ground survey',
    });
    const after = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2027-08-20' });
    assert.equal(after.next.find((entry) => entry.id === `removal:${systemId}`), undefined);
  });

  it('keeps a P4 request off the critical list while its window is still running', () => {
    // Read as at the day it was raised. Read a month later the same P4 *does*
    // appear, because a breached acknowledgement window is a breach at any
    // severity — which is the behaviour, not an accident of the fixture.
    const systemId = composeClosed();
    const raised = raiseEvent(as('pm'), {
      systemId,
      defectType: 'ROOM_DEFECT',
      severity: 'P4',
      summary: 'A shelf in room 12 is loose',
      source: 'Occupant, by app',
    });
    const sameDay = commandCentre(as('pm'), 'CONTROL_TOWER', { today: raised.raisedAt.slice(0, 10) });
    assert.equal(sameDay.now.find((entry) => entry.subject === 'CRITICAL_EVENT'), undefined);

    const muchLater = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2027-01-04' });
    const breached = muchLater.now.find((entry) => entry.subject === 'CRITICAL_EVENT');
    assert.ok(breached, 'a P4 unacknowledged for months is a breach and belongs on the panel');
    assert.equal(breached.tone, 'CRITICAL');
  });

  it('does not call a workstream ready for acceptance until something is evidenced against it', () => {
    const systemId = composeClosed();
    openWorkstream(as('pm'), { workstream: 'DEMAND_RUNDOWN', systemId });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    assert.equal(
      centre.next.find((entry) => entry.id.startsWith('demob-approval:')),
      undefined,
      'an empty workstream is not awaiting a decision',
    );
  });

  it('does not offer a gate for approval until its evidence is complete', () => {
    const systemId = composeClosed();
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    assert.equal(
      centre.next.find((entry) => entry.id.startsWith(`gate-approval:${systemId}`)),
      undefined,
      'G0 has unattested evidence and is not a decision yet',
    );
    assert.ok(centre.now.some((entry) => entry.id === `gate:${systemId}`), 'it is a constraint instead');
  });

  it('puts the soonest thing first when the windows actually differ', () => {
    appoint();
    const system = composeSystem(as('pm'), { family: 'WELFARE_ACCOMMODATION', zone: 'South compound', ...WINDOW });
    assignInterface(as('pm'), { interfaceId: system.interfaces[0]!.id, owner: 'Ruth Adeyemi', dueDate: '2026-11-14' });
    assignInterface(as('pm'), { interfaceId: system.interfaces[1]!.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-21' });
    assignInterface(as('pm'), { interfaceId: system.interfaces[2]!.id, owner: 'Ruth Adeyemi', dueDate: '2026-10-26' });

    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const windows = centre.next.map((entry) => entry.withinDays ?? 99);
    assert.deepEqual(windows.slice(0, 3), [2, 7, 30], 'the three windows are not in order');
  });
});

describe('naming the owner', () => {
  it('resolves the capability to people who hold it, most specialised first', () => {
    const systemId = composeClosed();
    raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const identities = platform
      .users(seed.users.pm!.auth.tenantId)
      .map((user) => ({ id: user.id, name: user.name, email: user.email, roles: user.roles }));

    const named = nameOwners(centre.now, identities);
    const event = named.find((entry) => entry.subject === 'CRITICAL_EVENT')!;
    assert.ok(event.action.owner.named!.length > 0, 'a P1 is assigned to nobody');
    assert.ok(event.action.owner.named!.some((person) => person.role === 'SAFETY'));
  });

  it('says nobody holds it rather than dropping the field', () => {
    const systemId = composeClosed();
    raiseEvent(as('pm'), {
      systemId,
      defectType: 'WELFARE_UNAVAILABLE',
      severity: 'P1',
      summary: 'Main welfare water supply lost',
      source: 'Site manager, by radio',
    });
    const centre = commandCentre(as('pm'), 'CONTROL_TOWER', { today: '2026-10-20' });
    const named = nameOwners(centre.now, []);
    for (const entry of named) {
      assert.ok(Array.isArray(entry.action.owner.named), `${entry.id} lost its owner field`);
      assert.equal(entry.action.owner.named!.length, 0);
    }
  });
});

describe('the module gate', () => {
  it('refuses both reads to a tenancy that does not hold ETABLIX', () => {
    // A real tenancy user without the grant, not the platform operator: the
    // operator is refused a delivery capability by account-layer separation
    // long before the module gate is reached, which proves a different rule.
    const ungranted = platform.createTenant({
      legalName: 'No Module Contracting Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'No Module Contracting',
    });
    const user = platform.createUser({
      tenantId: ungranted.tenant.id,
      name: 'Their project manager',
      email: 'pm@nomodule.example',
      roles: ['PM'],
    });
    const ctx = platform.context(
      { ...seed.users.pm!.auth, actorId: user.id, tenantId: ungranted.tenant.id, roles: ['PM'] },
      `${ungranted.tenant.id}-governance`,
    );
    throwsCode(() => commandCentre(ctx, 'CONTROL_TOWER'), 'MODULE_NOT_GRANTED');
    throwsCode(() => automationMeasure(ctx), 'MODULE_NOT_GRANTED');
  });
});
