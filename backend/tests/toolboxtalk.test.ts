import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { agentByName } from '../src/agents/registry.ts';
import * as cdm from '../src/domain/cdm.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as planning from '../src/engines/planning.ts';
import * as safety from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { bareConstructionProject, throwsCode } from './helpers.ts';

/**
 * The toolbox talk, in the two halves it actually has.
 *
 * `recordToolboxTalk` refused a talk with no attendance and always will — a
 * briefing nobody attended briefed nobody. That refusal is correct, and it was
 * also the reason nothing could prepare a talk in advance: the only command
 * available demanded the audience at the moment the content was written.
 *
 * So the content and the attendance are two acts against one record.
 * `draftToolboxTalk` assembles the briefing from an approved method statement
 * and stops; `recordToolboxTalk` takes the register when it is given. Neither
 * half can pretend to be the other, and that is what the tests below are for:
 * a drafted talk must never count as one that was delivered, because the CDM
 * position reports on briefings and a number a site can raise without briefing
 * anybody is worse than no number.
 *
 * **Nothing is generated.** Every point is the method statement's own wording,
 * in its own step sequence. A safety briefing whose words a model chose cannot
 * be traced to an approved control, and the first question after an incident is
 * which document the instruction came from.
 */

let platform: Platform;
let seed: SeedResult;
let ctx: EngineContext;
let safetyCtx: EngineContext;
let ramsId: string;

/** A method statement with `steps` steps, approved and ready to brief. */
async function approvedRams(steps: number, activity = 'Excavate and support the zone 2 chamber'): Promise<string> {
  const { workPackageId } = planning.createWorkPackage(ctx, {
    wbsCode: `EXC-${steps}`,
    title: activity,
    indicativeDurationDays: 15,
    scopeNarrative: 'Excavate and support the chamber, dispose off site, backfill on completion.',
    responsibleParty: 'SELF',
  });
  const drafted = await safety.draftRAMS(safetyCtx, {
    workPackageId,
    activityDescription: activity,
    location: 'Zone 2',
    steps: Array.from({ length: steps }, (_, index) => ({
      description: `Step ${index + 1}: proceed to the next section of the chamber`,
      activityType: 'EXCAVATION',
    })),
  });
  safety.approveRAMS(safetyCtx, drafted.ramsId, 'Sequence and controls are proportionate to the ground conditions.');
  return drafted.ramsId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  const { projectId } = await bareConstructionProject(platform, seed, 'Toolbox Talk Fixture');
  ctx = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'toolbox-test' });
  safetyCtx = platform.context(seed.users.safety!.auth, projectId, { correlationId: 'toolbox-test' });
  ramsId = await approvedRams(3);
});

describe('a talk is drafted from the method statement, not written fresh', () => {
  it('takes its points from the statement’s own steps, in sequence', () => {
    const draft = cdm.draftToolboxTalk(safetyCtx, { ramsId });
    const rams = platform.ledger.require({ refType: 'RAMS', refId: ramsId });
    const steps = rams.state.steps as Array<{ description: string; controls: string[] }>;

    // Every step reaches the talk, and each point carries the controls the
    // method statement states for it. Not a summary of them.
    for (const step of steps) {
      const point = draft.keyPoints.find((line) => line.startsWith(step.description));
      assert.ok(point, `"${step.description}" is in the method statement and not in the talk`);
      for (const control of step.controls) {
        assert.ok(point.includes(control), `the talk dropped the control "${control}"`);
      }
    }

    assert.equal(draft.coversSteps, steps.length);
    assert.equal(draft.ofSteps, steps.length);
    assert.deepEqual(draft.uncoveredSteps, []);
  });

  it('adds the PPE and competency schedules, which are what somebody is stopped at the workface for', () => {
    const record = platform.ledger.list(ctx.projectId, 'ToolboxTalk').at(-1)!;
    const points = record.state.keyPoints as string[];
    assert.ok(points.some((line) => line.startsWith('PPE for this work:')), 'the talk says nothing about PPE');
    assert.ok(points.some((line) => line.startsWith('Nobody does this work without:')), 'the talk names no competency');
  });

  it('takes its subject from the statement where nobody supplies one', () => {
    const record = platform.ledger.list(ctx.projectId, 'ToolboxTalk').at(-1)!;
    assert.match(String(record.state.subject), /Excavate and support the zone 2 chamber/);
    assert.match(String(record.state.subject), /Zone 2/);
  });

  /**
   * The revision, recorded because a talk outlives the version it was drafted
   * from. A briefing given on Friday from a draft written against revision 1,
   * where revision 2 was approved on Thursday, briefed the wrong method — and
   * this field is what says so afterwards.
   */
  it('records which revision of the statement it was drafted from', () => {
    const record = platform.ledger.list(ctx.projectId, 'ToolboxTalk').at(-1)!;
    const rams = platform.ledger.require({ refType: 'RAMS', refId: ramsId });
    assert.equal(record.state.ramsVersion, rams.state.version);
    assert.equal(record.state.ramsId, ramsId);
  });
});

describe('what a draft refuses', () => {
  it('will not brief a method statement nobody has approved', async () => {
    const { workPackageId } = planning.createWorkPackage(ctx, {
      wbsCode: 'UNAPPROVED-1',
      title: 'Break out the existing headwall',
      indicativeDurationDays: 4,
      scopeNarrative: 'Break out and remove the existing headwall structure.',
      responsibleParty: 'SELF',
    });
    const drafted = await safety.draftRAMS(safetyCtx, {
      workPackageId,
      activityDescription: 'Break out the existing headwall',
      location: 'Outfall',
      steps: [{ description: 'Break out in sections from the crown down', activityType: 'GENERAL' }],
    });

    throwsCode(
      () => cdm.draftToolboxTalk(safetyCtx, { ramsId: drafted.ramsId }),
      'TOOLBOX_TALK_RAMS_NOT_APPROVED',
    );
  });

  it('will not draft a second talk against a statement that already has one waiting', () => {
    throwsCode(() => cdm.draftToolboxTalk(safetyCtx, { ramsId }), 'TOOLBOX_TALK_ALREADY_DRAFTED');
  });

  /**
   * The most useful thing in this file.
   *
   * A method statement with more steps than a talk can carry is not a longer
   * talk — it is two talks. Silently truncating a safety briefing is the one
   * failure mode here that could hurt somebody, so the draft says which steps it
   * did not reach and the screen shows that as a warning.
   */
  it('says which steps a long method statement leaves out rather than dropping them', async () => {
    const long = await approvedRams(cdm.MAX_TALK_POINTS + 4, 'Install the pumping station mechanical package');
    const draft = cdm.draftToolboxTalk(safetyCtx, { ramsId: long });

    assert.equal(draft.coversSteps, cdm.MAX_TALK_POINTS);
    assert.equal(draft.ofSteps, cdm.MAX_TALK_POINTS + 4);
    assert.equal(draft.uncoveredSteps.length, 4, 'four steps went missing without being named');
    for (const step of draft.uncoveredSteps) {
      assert.ok(step.length > 0);
      assert.ok(
        !draft.keyPoints.some((point) => point.startsWith(step)),
        'a step is reported as uncovered and is in the talk',
      );
    }
  });
});

describe('drafted is not delivered', () => {
  it('does not count towards the briefings the CDM position reports', () => {
    const position = cdm.principalContractorPosition(ctx);
    assert.ok(position.toolboxTalks.drafted >= 2, 'the drafts are not being counted at all');
    assert.equal(position.toolboxTalks.delivered, 0, 'a talk nobody has given was counted as one that was');
    assert.equal(position.toolboxTalks.attendances, 0);
  });

  it('still refuses an attendance list with nobody on it', () => {
    const draft = platform.ledger
      .list(ctx.projectId, 'ToolboxTalk')
      .find((record) => record.state.status === 'DRAFTED')!;
    throwsCode(
      () => cdm.recordToolboxTalk(safetyCtx, { draftId: draft.refId, deliveredBy: 'Site supervisor', attendees: [] }),
      'ATTENDANCE_REQUIRED',
    );
  });

  it('becomes delivered on the same record, keeping what it was drafted from', () => {
    const draft = platform.ledger
      .list(ctx.projectId, 'ToolboxTalk')
      .find((record) => record.state.status === 'DRAFTED' && record.state.ramsId === ramsId)!;
    const before = platform.ledger.list(ctx.projectId, 'ToolboxTalk').length;

    const given = cdm.recordToolboxTalk(safetyCtx, {
      draftId: draft.refId,
      deliveredBy: 'Site supervisor',
      attendees: ['op-1', 'op-2', 'op-3'],
    });

    assert.equal(given.talkId, draft.refId, 'delivering a draft created a second talk');
    assert.equal(platform.ledger.list(ctx.projectId, 'ToolboxTalk').length, before, 'the register grew');

    const delivered = platform.ledger.require({ refType: 'ToolboxTalk', refId: draft.refId });
    assert.equal(delivered.state.status, 'DELIVERED');
    assert.equal(delivered.state.attendees ? (delivered.state.attendees as string[]).length : 0, 3);
    // Carried forward rather than replaced. Which method statement it briefed
    // and which steps it did not reach are the two facts an incident
    // investigation asks for, and delivery must not erase either.
    assert.equal(delivered.state.ramsId, ramsId);
    assert.deepEqual(delivered.state.keyPoints, draft.state.keyPoints);

    const position = cdm.principalContractorPosition(ctx);
    assert.equal(position.toolboxTalks.delivered, 1);
    assert.equal(position.toolboxTalks.attendances, 3);
  });

  it('will not record a second attendance against a briefing already given', () => {
    const delivered = platform.ledger
      .list(ctx.projectId, 'ToolboxTalk')
      .find((record) => record.state.status === 'DELIVERED')!;
    throwsCode(
      () => cdm.recordToolboxTalk(safetyCtx, { draftId: delivered.refId, deliveredBy: 'Someone else', attendees: ['op-9'] }),
      'TOOLBOX_TALK_NOT_DRAFTED',
    );
  });

  /**
   * The path every existing site uses, unchanged.
   *
   * A talk given straight, with no draft behind it, is still recorded exactly as
   * it was before drafts existed — and it still has to say what it was about,
   * because nothing else on the record does.
   */
  it('records a talk given straight, and refuses one with no content', () => {
    throwsCode(
      () => cdm.recordToolboxTalk(safetyCtx, { deliveredBy: 'Site supervisor', attendees: ['op-4'] }),
      'TOOLBOX_TALK_CONTENT_REQUIRED',
    );

    const straight = cdm.recordToolboxTalk(safetyCtx, {
      subject: 'Reversing vehicles at the north gate',
      deliveredBy: 'Site supervisor',
      keyPoints: ['Nobody walks through the gate while a wagon is reversing', 'The banksman has the only say'],
      attendees: ['op-4', 'op-5'],
    });
    assert.equal(straight.attendees, 2);

    const record = platform.ledger.require({ refType: 'ToolboxTalk', refId: straight.talkId });
    assert.equal(record.state.status, 'DELIVERED');
    assert.equal(record.state.ramsId, undefined, 'a talk given straight was given a method statement it never had');
  });
});

describe('AGT-HSE-FIELD proposes the draft rather than describing it', () => {
  let agentCtx: EngineContext;
  let agentSafety: EngineContext;

  before(async () => {
    const { projectId } = await bareConstructionProject(platform, seed, 'Toolbox Agent Fixture');
    agentCtx = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'toolbox-test' });
    agentSafety = platform.context(seed.users.safety!.auth, projectId, { correlationId: 'toolbox-test' });

    const { workPackageId } = planning.createWorkPackage(agentCtx, {
      wbsCode: 'AGT-01',
      title: 'Deep excavation, zone 4',
      indicativeDurationDays: 12,
      scopeNarrative: 'Excavate and support the zone 4 chamber.',
      responsibleParty: 'SELF',
    });
    const drafted = await safety.draftRAMS(agentSafety, {
      workPackageId,
      activityDescription: 'Excavate and support the zone 4 chamber',
      location: 'Zone 4',
      steps: [{ description: 'Set out and scan for services before breaking ground', activityType: 'EXCAVATION' }],
    });
    safety.approveRAMS(agentSafety, drafted.ramsId, 'Controls are proportionate to the ground conditions.');
  });

  it('raises one proposal per method statement, carrying a command that runs', async () => {
    const definition = agentByName('hse-field')!;
    const output = await definition.evaluate!(agentCtx);
    const proposal = output.proposals.find((entry) => entry.command.command === 'cdm:draftToolboxTalk');
    assert.ok(proposal, 'the agent found an unbriefed method statement and proposed nothing');
    assert.equal(proposal.autonomy, 'PROPOSE', 'the agent may not draft a safety briefing unattended');
    assert.equal(proposal.command.valueMinor, 0);

    // The proposed body is the one the command takes. A proposal an approver
    // presses and that then fails is worse than no proposal.
    const result = cdm.draftToolboxTalk(agentSafety, proposal.command.input as { ramsId: string });
    assert.ok(result.keyPoints.length > 0);
  });

  /**
   * Approving the agent's own proposal must not silence the agent.
   *
   * A drafted talk is content waiting for an audience. If drafting closed the
   * finding, the fleet would report the briefing gap as handled while nobody on
   * site had been told anything — which is the exact failure the whole
   * drafted/delivered split exists to prevent.
   */
  it('stops proposing once drafted, and stops finding only once it is given', async () => {
    const definition = agentByName('hse-field')!;

    const afterDraft = await definition.evaluate!(agentCtx);
    assert.equal(
      afterDraft.proposals.filter((entry) => entry.command.command === 'cdm:draftToolboxTalk').length,
      0,
      'the agent proposed a second draft against a statement that already has one — the command would refuse it',
    );
    // The specific finding, not any finding from this agent. Asserting the
    // looser thing let a mutant through: making a drafted talk count as briefed
    // left every test passing, because the permit and observation findings kept
    // the agent talking. That mutant is the exact failure the drafted/delivered
    // split exists to prevent — the fleet reporting the briefing gap as handled
    // while nobody on site has been told anything.
    assert.ok(
      afterDraft.findings.some((finding) => finding.key.startsWith('hse-field:brief-rams:')),
      'drafting the talk silenced the finding, and nobody has been briefed',
    );

    const draft = platform.ledger
      .list(agentCtx.projectId, 'ToolboxTalk')
      .find((record) => record.state.status === 'DRAFTED')!;
    cdm.recordToolboxTalk(agentSafety, {
      draftId: draft.refId,
      deliveredBy: 'Site supervisor',
      attendees: ['op-a', 'op-b'],
    });

    const afterDelivery = await definition.evaluate!(agentCtx);
    assert.equal(
      afterDelivery.findings.filter((finding) => finding.key.startsWith('hse-field:brief-rams:')).length,
      0,
      'the talk was given and the agent still says the statement was never briefed',
    );
  });

  /**
   * The mutant that survived twice.
   *
   * Counting a *drafted* talk as briefed only matters once something has
   * actually been delivered — before that, every approved statement is unbriefed
   * either way, so the fixture could not tell the two apart. This is the shape
   * that can: one statement briefed for real, a second with a draft waiting.
   * With drafts counted as briefings the second one vanishes from the fleet, and
   * the gang working to it has been told nothing.
   */
  it('keeps a second statement’s gap open while one has genuinely been briefed', async () => {
    const definition = agentByName('hse-field')!;

    const { workPackageId } = planning.createWorkPackage(agentCtx, {
      wbsCode: 'AGT-02',
      title: 'Lift the precast chamber rings',
      indicativeDurationDays: 3,
      scopeNarrative: 'Lift and set the precast chamber rings.',
      responsibleParty: 'SELF',
    });
    const second = await safety.draftRAMS(agentSafety, {
      workPackageId,
      activityDescription: 'Lift the precast chamber rings',
      location: 'Zone 4',
      steps: [{ description: 'Establish the exclusion zone before the lift begins', activityType: 'LIFTING' }],
    });
    safety.approveRAMS(agentSafety, second.ramsId, 'Lift plan and exclusion zone are proportionate.');
    cdm.draftToolboxTalk(agentSafety, { ramsId: second.ramsId });

    const output = await definition.evaluate!(agentCtx);
    const gap = output.findings.find((finding) => finding.key === `hse-field:brief-rams:${second.ramsId}`);
    assert.ok(gap, 'a statement with a talk drafted and never given is not being reported as unbriefed');
    assert.match(gap.summary, /drafted and waiting/);
    assert.equal(
      output.proposals.filter((entry) => (entry.command.input as { ramsId: string }).ramsId === second.ramsId).length,
      0,
      'the agent proposed a draft against a statement that already has one waiting',
    );
  });
});
