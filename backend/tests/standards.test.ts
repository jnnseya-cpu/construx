import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { CDM_DOCUMENTS } from '../src/domain/cdm.ts';
import { RIBA_STAGES, STANDARDS, lifecycleWithStages, stagePosition } from '../src/domain/standards.ts';
import { LIFECYCLE_ORDER, PHASE_GATES } from '../src/lifecycle/phases.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * RIBA Plan of Work 2020 inside the platform, and the claims the landing page
 * is allowed to make.
 *
 * Two different jobs here and they are both about the same failure. A marketing
 * page that names a standard is a claim, and a claim nothing checks drifts the
 * first time somebody edits a gate. So the standards list is derived from the
 * code that enforces each standard, and these tests are what hold the
 * derivation honest — if a gate is deleted, the assertion that the page still
 * describes it fails here rather than going stale on a public page.
 *
 * The stage position is the second job: RIBA stages are a *view* of the one
 * lifecycle, never a second state machine, and most of what is asserted below
 * is that the view cannot disagree with the phase it is derived from.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const noGate: Array<{ description: string; satisfied: boolean }> = [];

describe('RIBA Plan of Work 2020, stages 0 to 7', () => {
  it('carries all eight stages, in order, each with a goal', () => {
    assert.deepEqual(
      RIBA_STAGES.map((entry) => entry.stage),
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(
      RIBA_STAGES.map((entry) => entry.name),
      [
        'Strategic Definition',
        'Preparation and Briefing',
        'Concept Design',
        'Spatial Coordination',
        'Technical Design',
        'Manufacturing and Construction',
        'Handover',
        'Use',
      ],
    );
    // A stage number on a screen tells a client nothing. The goal is what makes
    // it a position somebody can act on, so every stage has to carry one.
    for (const entry of RIBA_STAGES) {
      assert.ok(entry.goal.length > 30, `stage ${entry.stage} has no usable goal`);
      assert.ok(LIFECYCLE_ORDER.includes(entry.phase), `stage ${entry.stage} maps to a phase that does not exist`);
    }
  });

  it('maps every stage onto a phase the platform actually gates', () => {
    // The mapping is only worth anything if the phase on the other end is real.
    for (const entry of RIBA_STAGES) {
      const gate = PHASE_GATES.find((phase) => phase.phase === entry.phase);
      assert.ok(gate, `stage ${entry.stage} maps to ${entry.phase}, which has no gate definition`);
    }
    // Every phase except TENDER carries at least one stage; TENDER is the
    // procurement task bar, which the Plan of Work runs across stages rather
    // than as a stage of its own, and the mapping says so rather than forcing it.
    const covered = new Set(RIBA_STAGES.flatMap((entry) => [entry.phase, ...(entry.alsoPhase ? [entry.alsoPhase] : [])]));
    for (const phase of LIFECYCLE_ORDER) {
      if (phase === 'TENDER') continue;
      assert.ok(covered.has(phase), `${phase} carries no RIBA stage`);
    }
    // Only TENDER carries none, and the page says why rather than leaving a
    // blank: procurement is a task bar in the Plan of Work, not a stage.
    assert.deepEqual(lifecycleWithStages().filter((entry) => entry.stages.length === 0).map((entry) => entry.phase), ['TENDER']);
    // Commissioning carries stage 6 with handover: proving the asset performs
    // and transferring responsibility for it are one RIBA stage and two gates.
    assert.deepEqual(lifecycleWithStages().find((entry) => entry.phase === 'COMMISSIONING')!.stages, [6]);
  });

  it('reads a stage as complete, current or not started from the phase alone', () => {
    const position = stagePosition({ phase: 'CONSTRUCTION', disciplineStages: [], gate: noGate });
    const by = new Map(position.map((entry) => [entry.stage, entry]));

    // Stages 0-4 sit in phases the project has left.
    for (const stage of [0, 1, 2, 3, 4]) assert.equal(by.get(stage)!.state, 'COMPLETE', `stage ${stage}`);
    assert.equal(by.get(5)!.state, 'CURRENT');
    for (const stage of [6, 7]) assert.equal(by.get(stage)!.state, 'NOT_STARTED', `stage ${stage}`);

    // And says why, in a sentence somebody can argue with.
    assert.match(by.get(5)!.because, /construction/);
    assert.match(by.get(7)!.because, /operations/);
  });

  it('is more precise inside design, where the record is', () => {
    // DESIGN carries stages 2, 3 and 4, and the phase alone cannot say which.
    // `assessDesignMaturity` already records a RIBA stage per discipline, so
    // that is what the stage reads — assessed, not asserted.
    const position = stagePosition({
      phase: 'DESIGN',
      disciplineStages: [
        { discipline: 'CIVILS', ribaStage: 4, frozen: true },
        { discipline: 'MECHANICAL', ribaStage: 3, frozen: false },
      ],
      gate: noGate,
    });
    const by = new Map(position.map((entry) => [entry.stage, entry]));

    assert.equal(by.get(2)!.state, 'COMPLETE', 'concept design is behind the reach');
    assert.equal(by.get(3)!.state, 'COMPLETE', 'spatial coordination is behind the reach');
    assert.equal(by.get(4)!.state, 'CURRENT', 'technical design is where the furthest discipline is');
    assert.equal(by.get(5)!.state, 'NOT_STARTED');

    // Named, so "stage 4" can be opened into which discipline is actually there.
    assert.ok(by.get(4)!.evidence.some((line) => /CIVILS/.test(line) && /frozen/.test(line)));
    assert.ok(by.get(3)!.evidence.length > 0 || by.get(4)!.evidence.length > 0);
  });

  it('refuses to guess a design stage when nothing has been assessed', () => {
    // The alternative is putting a number on a screen that nothing behind it
    // supports, which is the failure this whole module is written against.
    const position = stagePosition({ phase: 'DESIGN', disciplineStages: [], gate: noGate });
    const design = position.filter((entry) => entry.phase === 'DESIGN');
    for (const entry of design) {
      assert.match(entry.because, /no design maturity has been assessed/);
    }
  });

  it('carries the current phase’s gate as the evidence for its stages', () => {
    const position = stagePosition({
      phase: 'CONCEPT',
      disciplineStages: [],
      gate: [{ description: 'At least one scope package defines what is being built', satisfied: false }],
    });
    const current = position.filter((entry) => entry.state === 'CURRENT');
    assert.ok(current.length > 0);
    assert.ok(
      current.every((entry) => entry.evidence.some((line) => /Outstanding — At least one scope package/.test(line))),
      'a current stage does not carry what its gate is still asking for',
    );
  });

  it('never disagrees with the lifecycle it is derived from', () => {
    // The load-bearing property. There is one lifecycle on this platform; a
    // stage is a view of it, so for every phase the stages of earlier phases
    // must read complete and the stages of later phases must not.
    for (const phase of LIFECYCLE_ORDER) {
      const here = LIFECYCLE_ORDER.indexOf(phase);
      for (const entry of stagePosition({ phase, disciplineStages: [], gate: noGate })) {
        const at = LIFECYCLE_ORDER.indexOf(entry.phase);
        if (at < here) assert.equal(entry.state, 'COMPLETE', `${phase}: stage ${entry.stage}`);
        if (at > here) assert.equal(entry.state, 'NOT_STARTED', `${phase}: stage ${entry.stage}`);
      }
    }
  });

  it('reads the seeded project without inventing anything', () => {
    const project = platform.ledger.require({ refType: 'Project', refId: seed.projectId }).state as Record<string, unknown>;
    const assessments = platform.ledger.list(seed.projectId, 'DesignMaturityAssessment');
    const latest = assessments.at(-1)?.state as Record<string, unknown> | undefined;
    const position = stagePosition({
      phase: project.phase as (typeof LIFECYCLE_ORDER)[number],
      disciplineStages:
        (latest?.disciplineScores as Array<{ discipline: string; ribaStage: number; frozen: boolean }> | undefined) ?? [],
      gate: noGate,
    });
    assert.equal(position.length, 8);
    for (const entry of position) {
      assert.ok(['COMPLETE', 'CURRENT', 'NOT_STARTED'].includes(entry.state));
      assert.ok(entry.because.length > 10, `stage ${entry.stage} says nothing about why`);
    }
  });
});

describe('the standards the landing page is allowed to name', () => {
  it('states a mechanism and a strength for every standard', () => {
    assert.ok(STANDARDS.length >= 6);
    for (const standard of STANDARDS) {
      assert.ok(['ENFORCED', 'CARRIED'].includes(standard.strength), `${standard.key} has no strength`);
      // The mechanism is what turns a claim into something checkable. A
      // standard named with nowhere to look is the claim this file exists to
      // stop the page making.
      assert.ok(standard.mechanism.length > 20, `${standard.key} names no mechanism`);
      assert.ok(standard.does.length > 40, `${standard.key} does not say what the platform does`);
    }
  });

  it('describes CDM from the catalogue rather than from a number typed twice', () => {
    const cdm = STANDARDS.find((standard) => standard.key === 'CDM_2015')!;
    assert.ok(cdm.does.includes(String(CDM_DOCUMENTS.length)), 'the CDM count is not read from the catalogue');
    // The document that gates construction is read from the catalogue too, so
    // removing the gate removes the claim.
    const gating = CDM_DOCUMENTS.filter((document) => document.gatesConstruction);
    assert.ok(gating.length > 0, 'no CDM document gates construction, so the page must stop saying one does');
    for (const document of gating) assert.ok(cdm.does.includes(document.label));
  });

  it('says what it does not claim, for every enforced standard', () => {
    // A page that lists only the strengths is the page nobody in procurement
    // believes. Every enforced standard has to name its own boundary.
    for (const standard of STANDARDS.filter((entry) => entry.strength === 'ENFORCED')) {
      assert.ok(standard.notClaimed, `${standard.key} claims enforcement and names no boundary`);
    }
  });

  it('publishes the lifecycle with the stages and the real gate criteria', () => {
    const lifecycle = lifecycleWithStages();
    assert.equal(lifecycle.length, LIFECYCLE_ORDER.length);
    for (const entry of lifecycle) {
      const gate = PHASE_GATES.find((phase) => phase.phase === entry.phase)!;
      assert.deepEqual(
        entry.gate,
        gate.exitCriteria.map((criterion) => criterion.description),
        `${entry.phase} publishes gate criteria that are not the gate's`,
      );
      assert.equal(entry.purpose, gate.purpose);
    }
    // TENDER carries no stage, which is the honest half of the mapping.
    assert.deepEqual(lifecycle.find((entry) => entry.phase === 'TENDER')!.stages, []);
  });
});
