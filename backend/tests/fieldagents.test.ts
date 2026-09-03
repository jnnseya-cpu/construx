import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { agentByName } from '../src/agents/registry.ts';
import type { AgentDefinition, Finding } from '../src/agents/types.ts';
import * as cdm from '../src/domain/cdm.ts';
import * as dailylog from '../src/domain/dailylog.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import type { EngineContext } from '../src/engines/context.ts';
import * as perception from '../src/engines/perception.ts';
import * as planning from '../src/engines/planning.ts';
import * as safety from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { bareConstructionProject } from './helpers.ts';

/**
 * The field fleet — specification E2's six agents, five of them new.
 *
 * What these tests are checking is narrower than "the agent produces findings",
 * and deliberately so. Every one of these agents exists because a record was
 * already sitting in the ledger with nobody reading it: a transcript nobody
 * confirmed, a photograph read twice, a permit open past its own end date, a
 * blocker written in a diary that never reached the constraint log. So each
 * test builds that condition through the ordinary domain commands — never by
 * writing state directly — and then asks whether the agent notices.
 *
 * The one invariant worth stating out loud: **none of these agents files a site
 * record.** Confirming a reading files it under the confirmer's name, so a
 * machine doing it would put a person's name on something they never saw. Four
 * of the five propose nothing at all; `AGT-HSE-FIELD` proposes a toolbox talk
 * *draft*, which is content assembled from an approved method statement's own
 * wording and which `recordToolboxTalk` still refuses to treat as a briefing
 * until somebody supplies an attendance list. Both halves are asserted here
 * rather than left to the contract test, because this is the property the whole
 * field fleet is safe on.
 */

let directory: string;
let store: EvidenceStore;

const agent = (name: string): AgentDefinition => {
  const found = agentByName(name);
  assert.ok(found, `no agent named ${name}`);
  assert.equal(typeof found.evaluate, 'function', `${name} is declared, not deployed`);
  return found;
};

const run = async (name: string, ctx: EngineContext): Promise<Finding[]> =>
  (await agent(name).evaluate!(ctx)).findings;

const keyed = (list: Finding[], prefix: string): Finding | undefined => list.find((f) => f.key.startsWith(prefix));

const isoDaysFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** A perception provider that can be handed a file, as a real one can. */
function multimodalStub(output: () => Record<string, unknown>): AIProviderAdapter {
  return {
    name: 'GEMINI',
    capability: 'PERCEPTION',
    multimodal: true,
    transmits: true,
    estimateCostMinor: () => 40,
    healthy: () => true,
    async execute(_request: ProviderRequest): Promise<ProviderResponse> {
      return {
        provider: 'GEMINI',
        modelClass: 'perception-standard',
        output: output(),
        rawCostMinor: 40,
        latencyMs: 8,
        confidence: 0.88,
      };
    },
  };
}

function registerEvidenceFor(ctx: EngineContext, hash: string, type: string): void {
  ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: 'WEB',
    correlationId: ctx.correlationId,
    eventType: 'EVIDENCE_REGISTERED',
    entity: { refType: 'EvidenceItem', refId: `ev-${hash.slice(-12)}` },
    nextState: { id: `ev-${hash.slice(-12)}`, type, hash, projectId: ctx.projectId },
  });
}

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-fieldagents-'));
  store = new EvidenceStore(directory);
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('the field fleet never files a site record itself', () => {
  it('proposes nothing and can never act unattended', () => {
    for (const name of ['voice-structure', 'photo-classification', 'field-answers', 'today']) {
      const definition = agent(name);
      assert.deepEqual(definition.mandate.proposes, [], `${definition.agentId} proposes a write`);
      assert.equal(
        definition.mandate.maxUnattended,
        'OBSERVE',
        `${definition.agentId} may do more than look, and confirming a site record attributes it to a person`,
      );
      assert.deepEqual(definition.emits, [], `${definition.agentId} claims to emit an event it never writes`);
    }
  });

  /**
   * The one exception, pinned so widening it is an edit to this test.
   *
   * `AGT-HSE-FIELD` proposes `cdm:draftToolboxTalk`, which assembles a briefing
   * out of an approved method statement's own wording and stops. It is the only
   * proposal in this fleet, and what makes it safe is not the agent — it is that
   * `recordToolboxTalk` still refuses without an attendance list. Nothing the
   * agent can do makes it look as though anybody was briefed.
   */
  it('lets the safety agent draft a briefing and nothing else', () => {
    const definition = agent('hse-field');
    assert.deepEqual(definition.mandate.proposes, ['SAFETY_RAMS']);
    assert.equal(definition.mandate.maxUnattended, 'PROPOSE', 'a safety briefing may not be drafted unattended');
    assert.equal(definition.mandate.envelope, undefined, 'PROPOSE needs no envelope, and one here would read as a grant');
    assert.deepEqual(definition.emits, ['TOOLBOX_TALK_DRAFTED']);
    assert.equal(definition.hitl, 'APPROVAL');
  });
});

// ---------------------------------------------------------------------------

describe('AGT-VOICE-STRUCT watches dictation nobody confirmed', () => {
  let platform: Platform;
  let seed: SeedResult;
  let ctx: EngineContext;

  /** What the stub reads out of the next recording. Mutated per test. */
  let heard: Record<string, unknown> = {};

  before(async () => {
    platform = new Platform(new AIOrchestrator({ perception: multimodalStub(() => heard) }), store);
    seed = await seedDemoProject(platform);
    const { projectId } = await bareConstructionProject(platform, seed, 'Voice Agent Fixture');
    ctx = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'field-agent-test' });
  });

  async function recordNote(bytes: string): Promise<void> {
    const audio = Buffer.from(bytes, 'utf8');
    const hash = hashBytes(audio);
    registerEvidenceFor(ctx, hash, 'SITE_PHOTO');
    await store.put(ctx.tenantId, hash, audio, 'audio/webm');
    await perception.extract(ctx, store, { hash, task: 'VOICE_NOTE' });
  }

  it('says nothing when there is no dictation waiting', async () => {
    assert.deepEqual(await run('voice-structure', ctx), []);
  });

  it('raises an unconfirmed transcript and cites the recording as well as the reading', async () => {
    heard = { transcript: 'Third pour on the south wall went in at ten past seven.', category: 'PROGRESS', requiresAction: false };
    await recordNote('audio-one');

    const found = keyed(await run('voice-structure', ctx), 'voice:unconfirmed:');
    assert.ok(found, 'an unconfirmed voice note raised nothing');
    assert.match(found.summary, /still unconfirmed/);

    // Both halves. The transcript is an interpretation; the audio is the
    // evidence, and a finding that cited only the reading would point at the
    // opinion and not at the fact.
    const types = found.evidence.map((item) => item.refType).sort();
    assert.deepEqual(types, ['EvidenceItem', 'PerceptionDraft']);
    assert.equal(found.confidence, 0.88, "the model's own confidence was dropped rather than carried through");
  });

  /**
   * The refusal named before somebody meets it.
   *
   * `captureSiteObservation` requires a date on anything marked as requiring
   * action, and the confirmation screen cannot supply one from the recording
   * because a deadline is not audible. Somebody discovering that at the moment
   * they press confirm learns it as a bug in the product.
   */
  it('says in advance why confirming an actionable note would be refused', async () => {
    heard = {
      transcript: 'The handrail at the top of the east stair is loose, somebody needs to sort it.',
      category: 'SAFETY_CONCERN',
      requiresAction: true,
    };
    await recordNote('audio-two');

    const all = await run('voice-structure', ctx);
    const actionable = all.find((f) => f.key.startsWith('voice:unconfirmed:') && /action date/.test(f.summary));
    assert.ok(actionable, 'a note read as requiring action gave no warning that it cannot be confirmed without a date');
    assert.match(actionable.summary, /a deadline is not audible/);
  });

  it('names the correction where the category is not one the register holds', async () => {
    heard = { transcript: 'Nothing much to report.', category: 'GENERAL_CHAT', requiresAction: false };
    await recordNote('audio-three');

    const all = await run('voice-structure', ctx);
    const wrong = all.find((f) => /GENERAL_CHAT/.test(f.summary));
    assert.ok(wrong, 'a category the observation register does not hold was not flagged');
    assert.match(wrong.summary, /has to be one of/);
  });

  /**
   * The second path dictation takes, and the comment that has been waiting for
   * this agent since `dailylog.ts` was written: "A person confirmed the
   * mapping. The agent may propose it; it may not file it."
   */
  it('raises dictation on a daily log that nobody has confirmed the mapping of', async () => {
    const drafted = dailylog.draftDailyLog(ctx, {
      clientUuid: 'field-agent-log-1',
      deviceId: 'device-a',
      capturedAt: new Date().toISOString(),
      diaryDate: isoDaysFromNow(0),
      shift: 'DAY',
      weather: { conditions: 'Dry all day', temperatureC: 11, workingStopped: false },
      labour: [{ trade: 'Groundworks', headcount: 6, hours: 9 }],
      plant: [{ description: '13t excavator', hoursWorked: 8, hoursIdle: 0 }],
      progressNarrative: 'Trench excavation continued along the Bacup Road verge.',
      workedTaskIds: [],
      location: 'Bacup Road verge',
      voiceSegments: [
        { segmentId: 'seg-1', audioHash: hashBytes(Buffer.from('seg-1')), transcript: 'Two loads of stone arrived at half eight.', mappedTo: 'deliveries' },
        { segmentId: 'seg-2', audioHash: hashBytes(Buffer.from('seg-2')), transcript: 'The lads were stood about for an hour.', mappedTo: 'UNMAPPED' },
      ],
    });
    assert.equal(drafted.status, 'DRAFT');

    const found = keyed(await run('voice-structure', ctx), 'voice:log-segments:');
    assert.ok(found, 'unconfirmed dictation on a daily log raised nothing');
    assert.match(found.summary, /2 dictated segments/);
    assert.match(found.summary, /1 of them maps to no field of the log at all/);
  });
});

// ---------------------------------------------------------------------------

describe('AGT-PHOTO-CLASS watches photography the platform has read and nobody filed', () => {
  let platform: Platform;
  let seed: SeedResult;
  let ctx: EngineContext;
  let seen: Record<string, unknown> = {};

  before(async () => {
    platform = new Platform(new AIOrchestrator({ perception: multimodalStub(() => seen) }), store);
    seed = await seedDemoProject(platform);
    const { projectId } = await bareConstructionProject(platform, seed, 'Photo Agent Fixture');
    ctx = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'field-agent-test' });
  });

  /**
   * Read as the person whose capability the reading needs.
   *
   * A PPE reading authorises on SAFETY_RAMS and a defect reading on
   * QUALITY_COMMISSIONING — the perception task carries the area and code of
   * the command its confirmation will run, which is the platform being right
   * rather than a fixture inconvenience. The PM holds neither, and using them
   * for all four would have tested a permission model that does not exist.
   */
  async function readPhoto(bytes: string, task: 'PPE_COMPLIANCE' | 'DEFECT_DETECTION', held = false): Promise<string> {
    const who = task === 'PPE_COMPLIANCE' ? seed.users.safety! : seed.users.qaqc!;
    const reader = platform.context(who.auth, ctx.projectId, { correlationId: 'field-agent-test' });
    const image = Buffer.from(bytes, 'utf8');
    const hash = hashBytes(image);
    // One file, one evidence record. Registering it twice is refused by the
    // ledger — which is the point of the duplicate case below: the *file* is
    // registered once and read twice, and it is the readings that duplicate.
    if (!held) {
      registerEvidenceFor(reader, hash, 'SITE_PHOTO');
      await store.put(reader.tenantId, hash, image, 'image/jpeg');
    }
    await perception.extract(reader, store, { hash, task });
    return hash;
  }

  it('says nothing before any photograph has been read', async () => {
    assert.deepEqual(await run('photo-classification', ctx), []);
  });

  it('raises a PPE breach read and never logged as urgent, on its own', async () => {
    seen = {
      compliant: false,
      breaches: [{ item: 'HARNESS', description: 'Working at the leading edge unclipped' }],
      narrative: 'Operative at the leading edge of the slab with a harness worn but not clipped on.',
      location: 'Level 3 north edge',
    };
    await readPhoto('ppe-photo', 'PPE_COMPLIANCE');

    const found = keyed(await run('photo-classification', ctx), 'photo:ppe-breach-unlogged:');
    assert.ok(found, 'a photographed PPE breach that never reached the safety log raised nothing');
    assert.equal(found.severity, 'URGENT');
    assert.match(found.summary, /not on the safety log/);
  });

  /**
   * The same bytes read twice.
   *
   * Drafts are keyed by their own id and not by the evidence they read, so the
   * same task run twice over the same file produces two drafts that are both
   * valid and both confirmable. Confirmed, one defect becomes two
   * non-conformances under two references, each to be closed out separately.
   * The hash is what makes this checkable — it is the same file by definition.
   */
  it('flags a photograph read twice for the same thing', async () => {
    seen = {
      defects: [{ description: 'Honeycombing to the base of the column', severity: 'MAJOR', proposedAction: 'Break out and recast' }],
    };
    await readPhoto('defect-photo', 'DEFECT_DETECTION');
    await readPhoto('defect-photo', 'DEFECT_DETECTION', true);

    const found = keyed(await run('photo-classification', ctx), 'photo:duplicate-readings:');
    assert.ok(found, 'the same file read twice for the same thing was not flagged');
    assert.match(found.summary, /read more than once/);
    assert.match(found.consequence, /two\s+non-conformances/);
  });

  it('says what confirming each remaining reading needs, rather than counting a backlog', async () => {
    // The defect drafts above are the duplicate pair, so the remaining-by-kind
    // finding must not double-count them.
    const all = await run('photo-classification', ctx);
    const duplicate = keyed(all, 'photo:duplicate-readings:');
    const unfiled = all.filter((f) => f.key.startsWith('photo:unfiled:'));
    assert.ok(duplicate, 'the duplicate finding vanished');
    assert.ok(
      unfiled.every((f) => !f.key.includes('DEFECT_DETECTION')),
      'a reading counted as a duplicate was counted again in the backlog',
    );
  });
});

// ---------------------------------------------------------------------------

describe('AGT-FIELD-ANSWERS says which questions come back empty', () => {
  let platform: Platform;
  let seed: SeedResult;
  let bare: EngineContext;
  let stocked: EngineContext;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    const { projectId } = await bareConstructionProject(platform, seed, 'Answers Agent Fixture');
    bare = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'field-agent-test' });

    const site = seed.workingProjects.find((project) => project.name === 'Rossendale Trunk Main Diversion');
    assert.ok(site, 'the project that is on site is no longer in the demonstration estate');
    stocked = platform.context(seed.users.pm!.auth, site.projectId, { correlationId: 'field-agent-test' });
  });

  /**
   * An absence names the register that was searched, not the nearest record.
   *
   * The whole point of this agent is that the answer is "nothing" — so it has
   * no evidence to cite and must not borrow any. `Finding.absence` is where a
   * search that came back empty is recorded.
   */
  it('names each empty register and cites no record at all', async () => {
    const found = keyed(await run('field-answers', bare), 'answers:empty-registers:');
    assert.ok(found, 'a project holding almost nothing reported no unanswerable questions');
    assert.deepEqual(found.evidence, [], 'an absence borrowed a record it could not support');
    assert.ok(found.absence && found.absence.length > 0, 'the finding claims an absence and names no search');
    for (const searched of found.absence) {
      assert.equal(searched.found, 0);
      assert.ok(searched.looked.length > 10, `${searched.refType} was searched for nothing in particular`);
    }
  });

  it('finds fewer empty registers on the project that is actually on site', async () => {
    const onSite = keyed(await run('field-answers', stocked), 'answers:empty-registers:');
    const onPaper = keyed(await run('field-answers', bare), 'answers:empty-registers:');
    assert.ok(onPaper, 'the bare project stopped reporting');
    const emptyOnSite = onSite?.absence?.length ?? 0;
    assert.ok(
      emptyOnSite < onPaper.absence!.length,
      `the project with a delivery record answers no more questions than the empty one (${emptyOnSite} empty either way)`,
    );
  });
});

// ---------------------------------------------------------------------------

describe('AGT-HSE-FIELD watches the shift rather than the project', () => {
  let platform: Platform;
  let seed: SeedResult;
  let ctx: EngineContext;
  let safetyCtx: EngineContext;
  let plannerCtx: EngineContext;
  let taskId: string;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    const { projectId } = await bareConstructionProject(platform, seed, 'HSE Field Agent Fixture');
    ctx = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'field-agent-test' });
    // The safety lead holds SAFETY_RAMS; the PM does not, and the platform is
    // right about that. The planner holds LOOKAHEAD_CONSTRAINTS.
    safetyCtx = platform.context(seed.users.safety!.auth, projectId, { correlationId: 'field-agent-test' });
    plannerCtx = platform.context(seed.users.planner!.auth, projectId, { correlationId: 'field-agent-test' });

    const { workPackageId } = planning.createWorkPackage(ctx, {
      wbsCode: 'EXC-01',
      title: 'Deep excavation, zone 2',
      indicativeDurationDays: 15,
      scopeNarrative: 'Excavate and support the zone 2 chamber, dispose off site, backfill on completion.',
      responsibleParty: 'SELF',
    });
    taskId = planning.createTasks(ctx, [
      { activityCode: 'EXC-100', name: 'Excavate zone 2 chamber', workPackageId, durationDays: 10, costCode: 'CIV-01' },
    ])[0]!;
  });

  it('does not read a CDM document, which is the other safety agent’s job', () => {
    const definition = agent('hse-field');
    const source = String(definition.evaluate);
    assert.ok(!source.includes('CDMDocument'), 'the field safety agent has started duplicating AGT-HSE');
    assert.ok(!source.includes('TrainingRecord'), 'competency expiry is AGT-HSE, and two agents raising it is two alerts');
  });

  it('raises an approved method statement nobody was ever briefed on', async () => {
    // A RAMS reaches APPROVED through the ordinary route, and no toolbox talk
    // is delivered against it.
    const found = keyed(await run('hse-field', ctx), 'hse-field:brief-rams:');
    assert.equal(found, undefined, 'a project with no approved method statement was told to brief one');

    await safety.draftRAMS(safetyCtx, {
      workPackageId: platform.ledger.list(ctx.projectId, 'WorkPackage')[0]!.refId,
      activityDescription: 'Excavate and support the zone 2 chamber',
      location: 'Zone 2',
      steps: [{ description: 'Set out and scan for services before breaking ground', activityType: 'EXCAVATION' }],
    });
    const ramsId = platform.ledger.list(ctx.projectId, 'RAMS')[0]!.refId;
    safety.approveRAMS(safetyCtx, ramsId, 'Sequence and controls are proportionate to the ground conditions.');

    // The per-statement finding, which is the one that names what to brief. The
    // roll-up above it is raised only where more than one statement is
    // unbriefed — with a single one it was the same sentence twice, and a queue
    // that repeats itself teaches its reader to skim.
    const briefed = keyed(await run('hse-field', ctx), 'hse-field:brief-rams:');
    assert.ok(briefed, 'an approved method statement with no talk against it raised nothing');
    assert.match(briefed.summary, /never been briefed/);
    assert.equal(briefed.evidence[0]?.refType, 'RAMS');

    // And it stops once somebody has actually briefed the gang.
    cdm.recordToolboxTalk(safetyCtx, {
      subject: 'Zone 2 excavation — set-back and access',
      deliveredBy: seed.users.pm!.id,
      keyPoints: ['3m spoil set-back', 'Access by the ladder in the access bay only'],
      attendees: ['op-1', 'op-2', 'op-3'],
    });
    assert.equal(
      keyed(await run('hse-field', ctx), 'hse-field:brief-rams:'),
      undefined,
      'the finding survived somebody actually delivering the talk',
    );
  });

  it('raises the same hazard reported three times at one location', async () => {
    const log = async (description: string): Promise<void> => {
      await safety.logSafetyObservation(safetyCtx, {
        description,
        location: 'Zone 2 crest',
        mediaHash: hashBytes(Buffer.from(description)),
        observationType: 'UNSAFE_CONDITION',
        reportedBy: seed.users.pm!.id,
      });
    };
    await log('Spoil pushed inside the set-back line on the north side.');
    await log('Spoil inside the set-back again, north side.');

    assert.equal(
      keyed(await run('hse-field', ctx), 'hse-field:repeat-location:'),
      undefined,
      'two reports were treated as a pattern; two is a coincidence',
    );

    await log('Reinforcement bundles stacked at the crest, north side.');
    const found = keyed(await run('hse-field', ctx), 'hse-field:repeat-location:');
    assert.ok(found, 'three unsafe conditions in one place raised nothing');
    assert.equal(found.severity, 'URGENT');
    assert.match(found.consequence, /one control that is not working/);
  });

  it('raises a permit that expires before the work promised against it falls due', async () => {
    const ramsId = platform.ledger.list(ctx.projectId, 'RAMS')[0]!.refId;
    safety.recordCompetency(safetyCtx, {
      operativeId: 'op-1',
      qualification: 'Excavation supervisor',
      issuedAt: isoDaysFromNow(-400),
      expiresAt: isoDaysFromNow(400),
      certificateHash: hashBytes(Buffer.from('excavation-ticket-op-1')),
    });

    safety.issuePermit(safetyCtx, {
      activity: 'EXCAVATION',
      location: 'Zone 2 chamber',
      operativeIds: ['op-1'],
      validFrom: isoDaysFromNow(0),
      validTo: isoDaysFromNow(2),
      ramsId,
      precautions: 'Support system installed before entry; atmosphere tested before each entry.',
      evidenceHash: hashBytes(Buffer.from('permit-authority')),
    });

    // Nothing is promised yet, so nothing is expiring "early".
    assert.equal(keyed(await run('hse-field', ctx), 'hse-field:permit-expires-in-week:'), undefined);

    planning.publishLookahead(plannerCtx, {
      weekStarting: isoDaysFromNow(0),
      plannedTaskIds: [taskId],
      commitments: [
        { taskId, promise: 'Chamber excavated to formation', promisedBy: 'Site supervisor', dueDate: isoDaysFromNow(5) },
      ],
    });

    const found = keyed(await run('hse-field', ctx), 'hse-field:permit-expires-in-week:');
    assert.ok(found, 'work promised past the end of its own permit raised nothing');
    assert.match(found.summary, /before the last promise of this week/);
  });
});

// ---------------------------------------------------------------------------

describe('AGT-TODAY answers what is on this job today', () => {
  let platform: Platform;
  let seed: SeedResult;
  let ctx: EngineContext;
  let plannerCtx: EngineContext;
  let taskId: string;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    const { projectId } = await bareConstructionProject(platform, seed, 'Today Agent Fixture');
    ctx = platform.context(seed.users.pm!.auth, projectId, { correlationId: 'field-agent-test' });

    const { workPackageId } = planning.createWorkPackage(ctx, {
      wbsCode: 'RTM-01',
      title: 'Trunk main diversion',
      indicativeDurationDays: 20,
      scopeNarrative: 'Divert the 600mm trunk main clear of the proposed carriageway realignment.',
      responsibleParty: 'SELF',
    });
    taskId = planning.createTasks(ctx, [
      { activityCode: 'RTM-100', name: 'Divert 600mm main', workPackageId, durationDays: 12, costCode: 'CIV-01' },
    ])[0]!;
    plannerCtx = platform.context(seed.users.planner!.auth, projectId, { correlationId: 'field-agent-test' });
  });

  it('raises a promise that fell due with no outcome against it', async () => {
    planning.publishLookahead(plannerCtx, {
      weekStarting: isoDaysFromNow(-3),
      plannedTaskIds: [taskId],
      commitments: [{ taskId, promise: 'Main diverted and pressure tested', promisedBy: 'Site supervisor', dueDate: isoDaysFromNow(-1) }],
    });

    const found = keyed(await run('today', ctx), 'today:promises-due:');
    assert.ok(found, 'a promise past its date with no answer raised nothing');
    assert.match(found.summary, /already past the date/);
    assert.match(found.consequence, /Every promise gets an answer/);
    assert.equal(found.evidence[0]?.refType, 'LookaheadPlan');
  });

  /**
   * A promise for Thursday is not a promise that fell due.
   *
   * Found by mutation: removing the due-date filter left every test passing,
   * because the fixture only ever promised work in the past. An agent that
   * reported the whole week's promises every morning as "due, with no outcome"
   * would train its reader to close the card, and the one that had actually
   * gone by would go with it.
   */
  it('leaves a promise still in the future alone', async () => {
    const already = keyed(await run('today', ctx), 'today:promises-due:');
    assert.ok(already, 'the overdue promise stopped being reported');
    const countBefore = Number(already.key.split(':').at(-1));

    planning.publishLookahead(plannerCtx, {
      weekStarting: isoDaysFromNow(0),
      plannedTaskIds: [taskId],
      commitments: [{ taskId, promise: 'Carriageway reinstated', promisedBy: 'Site supervisor', dueDate: isoDaysFromNow(4) }],
    });

    const after = keyed(await run('today', ctx), 'today:promises-due:');
    assert.ok(after, 'the overdue promise vanished when a future one was added');
    assert.equal(
      Number(after.key.split(':').at(-1)),
      countBefore,
      'a promise due later this week was reported as having fallen due today',
    );
  });

  /**
   * Yesterday specifically, which is not the same finding as diary coverage.
   *
   * `AGT-SITE-PROGRESS` watches how much of the job carries a diary at all.
   * This watches the one day whose detail is still in somebody's head — and it
   * distinguishes "nobody wrote it" from "it is written and still sitting on a
   * phone", because those have different remedies.
   */
  it('distinguishes a log nobody wrote from one still in draft on a device', async () => {
    const yesterday = isoDaysFromNow(-1);
    assert.equal(
      keyed(await run('today', ctx), 'today:diary-missing:'),
      undefined,
      'a project with no diaries at all was told yesterday was missing — that is the coverage agent’s finding',
    );

    dailylog.draftDailyLog(ctx, {
      clientUuid: 'today-log-1',
      deviceId: 'device-b',
      capturedAt: new Date(Date.now() - 86_400_000).toISOString(),
      diaryDate: yesterday,
      shift: 'DAY',
      weather: { conditions: 'Rain to midday, dry after', temperatureC: 9, workingStopped: false },
      labour: [{ trade: 'Groundworks', headcount: 5, hours: 8 }],
      plant: [{ description: '13t excavator', hoursWorked: 7, hoursIdle: 1 }],
      progressNarrative: 'Trench excavation continued.',
      workedTaskIds: [taskId],
      location: 'Bacup Road',
    });

    const found = keyed(await run('today', ctx), 'today:diary-missing:');
    assert.ok(found, 'a draft sitting on a device for yesterday raised nothing');
    assert.match(found.summary, /still a draft on a device/);
    assert.equal(found.evidence[0]?.refType, 'SiteDiary');
  });
});

// ---------------------------------------------------------------------------

describe('AGT-SITE-PROGRESS reports the position, not only the coverage', () => {
  let platform: Platform;
  let seed: SeedResult;
  let ctx: EngineContext;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    const site = seed.workingProjects.find((project) => project.name === 'Rossendale Trunk Main Diversion');
    assert.ok(site, 'the project that is on site is no longer in the demonstration estate');
    ctx = platform.context(seed.users.pm!.auth, site.projectId, { correlationId: 'field-agent-test' });
  });

  /**
   * The three things specification E2 asks of this agent that it did not do.
   *
   * It watched measurement coverage and unrouted snags — both real, both kept.
   * What it did not report was the position those readings add up to:
   * productivity against the baseline, the planned-against-actual delta
   * underneath it, and a delay event with the contemporaneous record attached.
   */
  it('reads the productivity position from the engine that already computes it', async () => {
    const position = planning.productivityPosition(ctx);
    const all = await run('field', ctx);

    if (position.projectFactor !== null && position.projectFactor < 0.9) {
      const found = keyed(all, 'field:productivity:');
      assert.ok(found, `productivity is ${position.projectFactor} and the agent said nothing`);
      assert.match(found.summary, /days earned per day spent/);
      // Planned against actual, on each cited activity rather than as a
      // project-level percentage nobody can act on.
      assert.match(found.evidence[0]?.note ?? '', /% in \d+(\.\d+)? of \d+(\.\d+)? planned days/);
    } else if (position.unmeasurable.length > 0) {
      assert.ok(keyed(all, 'field:unmeasurable:'), 'progress with no elapsed time was reported by the engine and not by the agent');
    }
  });

  it('raises a blocker written in a diary that never reached the constraint log', async () => {
    const before = keyed(await run('field', ctx), 'field:unraised-delay-events:');

    planning.recordSiteDiary(ctx, {
      diaryDate: isoDaysFromNow(0),
      weather: { conditions: 'Heavy rain all day', temperatureC: 7, workingStopped: true, hoursLost: 4 },
      labour: [{ trade: 'Groundworks', headcount: 6, hours: 4 }],
      plant: [{ description: '13t excavator', hoursWorked: 2, hoursIdle: 6 }],
      progressNarrative: 'Stood down at midday. Trench flooded and the pump could not keep up.',
      blockers: ['Trench flooded; no dewatering capacity on site'],
      evidenceHash: hashBytes(Buffer.from(`diary-blocker-${Date.now()}`)),
    });

    const found = keyed(await run('field', ctx), 'field:unraised-delay-events:');
    assert.ok(found, 'a blocker recorded on the day raised nothing');
    assert.equal(found.severity, 'URGENT');
    // The evidence link is the whole value of it: the diary entry written on
    // the day is what a delay claim stands on. Every cited item is the diary
    // itself carrying the blocker text — not the task, not the project.
    assert.ok(found.evidence.length > 0, 'a delay event was raised with nothing to open');
    for (const item of found.evidence) {
      assert.equal(item.refType, 'SiteDiary');
      assert.ok(item.note.length > 10, 'a diary was cited with nothing said about why');
    }

    const countBefore = Number(before?.key.split(':').at(-1) ?? 0);
    const countAfter = Number(found.key.split(':').at(-1));
    assert.ok(countAfter > countBefore, 'the new blocker did not change the count, so the agent is not reading diaries');
  });
});
