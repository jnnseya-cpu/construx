import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rejectsCode } from './helpers.ts';
import { AIOrchestrator } from '../src/ai/orchestrator.ts';
import type { AIProviderAdapter, ProviderRequest, ProviderResponse } from '../src/ai/providers/types.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import * as perception from '../src/engines/perception.ts';
import { registerEvidence, type EngineContext } from '../src/engines/context.ts';
import * as planning from '../src/engines/planning.ts';
import * as progressverification from '../src/domain/progressverification.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The vision tasks: reading a site photograph.
 *
 * Progress estimation, PPE compliance, equipment recognition and defect
 * detection were specified as a separate "vision pipeline". They are built as
 * four more tasks on the perception pipeline, and this file is largely an
 * argument that they had to be: every one of them ends in a domain command a
 * person confirms, with the register's own rules — the unit against the
 * measurement basis, MINOR/MAJOR/CRITICAL, the observation category — running
 * unchanged.
 *
 * The assertions that carry the weight:
 *
 * - **No provider that can see means no reading.** The local adapter derives its
 *   answers from a hash of its inputs; asked how much of a wall is built it
 *   returns a confident number that is a hash. The refusal is the feature.
 * - **What a photograph cannot show is not asked of the model.** No task returns
 *   an activity id, a claim period, or the name of a person. Those are the
 *   confirmer's, and two of them decide who gets paid.
 * - **The domain rules are not bypassed.** A quantity read in the wrong unit is
 *   refused by the progress register exactly as a typed one would be.
 */

const PHOTOGRAPH = Buffer.from('JPEG-ish bytes standing in for a site photograph', 'utf8');
const PHOTOGRAPH_HASH = hashBytes(PHOTOGRAPH);
const DRAWING_PDF = Buffer.from('%PDF-1.7 a drawing, not a site photograph', 'utf8');
const DRAWING_PDF_HASH = hashBytes(DRAWING_PDF);

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;
let taskId: string;
let submissionId: string;

/** What the stub will answer with next. Set immediately before each call. */
let nextOutput: Record<string, unknown> = {};
let lastRequest: ProviderRequest | undefined;

/** A provider that can be handed a file, as a real multimodal one can. */
const multimodal: AIProviderAdapter = {
  name: 'GEMINI',
  capability: 'PERCEPTION',
  multimodal: true,
  transmits: true,
  estimateCostMinor: () => 40,
  healthy: () => true,
  async execute(request: ProviderRequest): Promise<ProviderResponse> {
    lastRequest = request;
    return {
      provider: 'GEMINI',
      modelClass: 'perception-standard',
      output: nextOutput,
      rawCostMinor: 40,
      latencyMs: 6,
      confidence: 0.88,
    };
  },
};

function ctxFor(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId, { correlationId: 'vision-test' });
}

/** Read a photograph under `who`'s authority, with `output` as the answer. */
async function read(
  who: string,
  task: perception.PerceptionTask,
  output: Record<string, unknown>,
  hash = PHOTOGRAPH_HASH,
): Promise<string> {
  nextOutput = output;
  const result = await perception.extract(ctxFor(who), store, { hash, task });
  return result.draftId;
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'construx-vision-'));
  store = new EvidenceStore(directory);
  platform = new Platform(new AIOrchestrator({ perception: multimodal }), store);
  seed = await seedDemoProject(platform);

  // The seeded project is in OPERATIONS, where the planning, cost and design
  // engines are all out of contract. A project that has come back to site is a
  // real regression and the lifecycle allows it, so the fixture uses the real
  // transition rather than writing a phase in by hand.
  structure.transitionPhase(ctxFor('owner'), {
    to: 'CONSTRUCTION',
    justification: 'Remedial works; the site is open again and progress is being measured.',
  });

  const workPackageId = planning.createWorkPackage(ctxFor('pm'), {
    wbsCode: 'VIS-001',
    title: 'Retaining wall',
    indicativeDurationDays: 30,
  }).workPackageId;
  taskId = planning.createTasks(ctxFor('pm'), [
    { activityCode: 'VIS-01', name: 'Construct retaining wall', workPackageId, durationDays: 20 },
  ])[0]!;
  progressverification.setMeasurementBasis(ctxFor('pm'), {
    taskId,
    unit: 'm2',
    controlTotal: 400,
    measurementRule: 'Face area of wall constructed, measured to the design line.',
    source: 'C-3301 rev P02, bill item 5.2.1',
  });

  registerEvidence(ctxFor('pm'), {
    type: 'SITE_OBSERVATION_MEDIA',
    hash: PHOTOGRAPH_HASH,
    description: 'Site photograph, retaining wall',
  });
  store.put(seed.tenantId, PHOTOGRAPH_HASH, PHOTOGRAPH, 'image/jpeg');

  registerEvidence(ctxFor('pm'), {
    type: 'DRAWING_FILE',
    hash: DRAWING_PDF_HASH,
    description: 'Retaining wall general arrangement',
  });
  store.put(seed.tenantId, DRAWING_PDF_HASH, DRAWING_PDF, 'application/pdf');
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the four vision tasks are the perception pipeline, not a second one', () => {
  it('declares each against the authority of the command it feeds', () => {
    const expected: Array<[perception.PerceptionTask, string, string]> = [
      ['PROGRESS_FROM_IMAGES', 'FIELD_EXECUTION', 'C'],
      ['PPE_COMPLIANCE', 'SAFETY_RAMS', 'C'],
      ['EQUIPMENT_RECOGNITION', 'FIELD_EXECUTION', 'C'],
      ['DEFECT_DETECTION', 'QUALITY_COMMISSIONING', 'C'],
    ];
    for (const [task, area, code] of expected) {
      const definition = perception.PERCEPTION_TASKS[task];
      // Not a permission of the pipeline's own. Nobody may ask a model to draft
      // something they could not have recorded themselves.
      assert.equal(definition.area, area, `${task} area`);
      assert.equal(definition.code, code, `${task} code`);
    }
  });

  it('will not be pointed at a drawing', async () => {
    // A PDF is a document about what is intended; these four report what is
    // there. Accepting one would let somebody read progress off the programme.
    for (const task of ['PROGRESS_FROM_IMAGES', 'PPE_COMPLIANCE', 'DEFECT_DETECTION'] as const) {
      assert.equal(perception.PERCEPTION_TASKS[task].accepts.includes('application/pdf'), false);
    }
    await rejectsCode(
      () => read('siteManager', 'PROGRESS_FROM_IMAGES', {}, DRAWING_PDF_HASH),
      'PERCEPTION_MEDIA_UNSUPPORTED',
    );
  });

  it('asks for nothing a photograph cannot show', () => {
    for (const task of ['PROGRESS_FROM_IMAGES', 'PPE_COMPLIANCE', 'EQUIPMENT_RECOGNITION', 'DEFECT_DETECTION'] as const) {
      const schema = JSON.stringify(perception.PERCEPTION_TASKS[task].responseSchema);
      // The activity a claim is against and the period it falls in decide who
      // gets paid, and neither is in the frame.
      assert.equal(/taskId|activityId|periodFrom|periodTo/.test(schema), false, `${task} asks for a field it cannot see`);
    }
  });

  it('does not ask the model to name anybody in a PPE photograph', () => {
    const definition = perception.PERCEPTION_TASKS.PPE_COMPLIANCE;
    // A model identifying an operative from a photograph is a disciplinary
    // allegation produced by a machine.
    assert.match(definition.prompt, /Do not identify or describe any individual/);
    assert.equal(/name|person(?!nel)|individual/i.test(JSON.stringify(definition.responseSchema)), false);
  });

  it('sends the file as media rather than stringified into the prompt', async () => {
    await read('siteManager', 'EQUIPMENT_RECOGNITION', {
      items: [{ description: '30t excavator', count: 1, state: 'WORKING' }],
      location: 'Grid C4',
    });
    assert.equal(lastRequest?.media?.hash, PHOTOGRAPH_HASH);
    assert.equal(lastRequest?.media?.contentType, 'image/jpeg');
  });
});

describe('progress read from a photograph reaches the register through its own door', () => {
  it('claims against the activity and period the confirmer names', async () => {
    const draftId = await read('siteManager', 'PROGRESS_FROM_IMAGES', {
      items: [
        {
          description: 'Retaining wall, panels 1 to 6',
          unit: 'm2',
          quantity: 96,
          basisOfMeasurement: 'Six panels at 4.0m × 4.0m, counted against the setting-out grid visible in the frame.',
        },
      ],
      location: 'Grid C4 to C10',
      obstructed: ['Panels 7 and 8 are behind the site cabin'],
    });

    const confirmed = await perception.confirm(ctxFor('siteManager'), {
      draftId,
      taskId,
      periodFrom: '2026-08-17',
      periodTo: '2026-08-23',
    });

    assert.equal(confirmed.task, 'PROGRESS_FROM_IMAGES');
    assert.equal(confirmed.result.cumulativeIfAccepted, 96);
    assert.equal(confirmed.result.exceedsControlTotal, false);
    submissionId = String(confirmed.result.submissionId);

    // The claim went in as an ordinary submission: unverified, and awaiting
    // somebody with the authority to certify it.
    const submission = platform.ledger.require({ refType: 'ProgressSubmission', refId: submissionId })
      .state as Record<string, unknown>;
    assert.equal(submission.submittedQuantity, 96);
  });

  it('records the provenance of the figure beside the claim, not instead of it', () => {
    const events = platform.ledger.events({ projectId: seed.projectId }).map((event) => event.eventType);
    assert.ok(events.includes('PROGRESS_REPORTED'));
    assert.ok(events.includes('PROGRESS_EXTRACTED_FROM_IMAGES'));

    const submission = platform.ledger.require({ refType: 'ProgressSubmission', refId: submissionId })
      .state as Record<string, unknown>;
    // The claim survives the provenance being written against it. One entity
    // holds one state, so writing the provenance alone would have replaced the
    // quantity a valuation is built on.
    assert.equal(submission.submittedQuantity, 96);

    const provenance = submission.extractedFromImages as Record<string, unknown>;
    assert.equal(provenance.provider, 'GEMINI');
    assert.equal(provenance.readQuantity, 96);
    assert.match(String(provenance.basisOfMeasurement), /setting-out grid/);
    // What the model said it could not see. A claim argued over in three years
    // is answered as much by this as by the quantity.
    assert.deepEqual(provenance.obstructed, ['Panels 7 and 8 are behind the site cabin']);
  });

  it('is an AI event, and the claim it sits beside is not', () => {
    assert.equal(lookupEventType('PROGRESS_EXTRACTED_FROM_IMAGES')?.aiAllowed, true);
    // "Never certify payment or progress alone."
    assert.equal(lookupEventType('PROGRESS_REPORTED')?.aiAllowed, false);
    assert.equal(lookupEventType('PROGRESS_VERIFIED')?.aiAllowed, false);
  });

  it('refuses a claim with no activity or period, rather than inventing one', async () => {
    const draftId = await read('siteManager', 'PROGRESS_FROM_IMAGES', {
      items: [{ description: 'Wall', unit: 'm2', quantity: 12, basisOfMeasurement: 'One panel' }],
    });
    await rejectsCode(() => perception.confirm(ctxFor('siteManager'), { draftId }), 'PERCEPTION_TARGET_REQUIRED');
  });

  it('is refused by the register when the model measured in the wrong unit', async () => {
    const draftId = await read('siteManager', 'PROGRESS_FROM_IMAGES', {
      items: [{ description: 'Wall', unit: 'm3', quantity: 40, basisOfMeasurement: 'Volume of panels' }],
    });
    // The progress register's own rule, running unchanged. Two units against
    // one activity is two honest numbers that cannot be added together.
    await rejectsCode(
      () =>
        perception.confirm(ctxFor('siteManager'), {
          draftId,
          taskId,
          periodFrom: '2026-08-17',
          periodTo: '2026-08-23',
        }),
      'UNIT_MISMATCH',
    );
  });

  it('will not confirm a reading of nothing', async () => {
    // `usable` refuses the draft at extraction: a photograph the model measured
    // nothing from is not worth anybody's confirmation.
    await rejectsCode(
      () => read('siteManager', 'PROGRESS_FROM_IMAGES', { items: [], obstructed: ['The whole frame is scaffolded'] }),
      'PERCEPTION_NOT_LEGIBLE',
    );
  });

  it('says which item is claimed when the photograph showed several', async () => {
    const draftId = await read('siteManager', 'PROGRESS_FROM_IMAGES', {
      items: [
        { description: 'Wall', unit: 'm2', quantity: 20, basisOfMeasurement: 'Two panels' },
        { description: 'Blinding', unit: 'm2', quantity: 60, basisOfMeasurement: 'Bay 3' },
      ],
    });
    await rejectsCode(
      () =>
        perception.confirm(ctxFor('siteManager'), {
          draftId,
          taskId,
          periodFrom: '2026-08-17',
          periodTo: '2026-08-23',
          itemIndex: 5,
        }),
      'PERCEPTION_ITEM_UNKNOWN',
    );
  });
});

describe('PPE compliance lands in the safety log, under the confirmer', () => {
  it('files a breach as an unsafe act, reported by the person confirming', async () => {
    const draftId = await read('safety', 'PPE_COMPLIANCE', {
      compliant: false,
      ppeObserved: ['hi-vis', 'boots'],
      breaches: [{ item: 'hard hat', description: 'Two operatives under a suspended load without head protection', peopleAffected: 2 }],
      notJudgeable: ['eye protection — faces turned away'],
      immediateRisk: true,
      location: 'Grid C4, west lift zone',
      narrative: 'Two operatives working beneath a suspended load without head protection.',
    });

    nextOutput = { classification: 'HIGH', narrative: 'Stop the lift and brief the gang before work resumes.' };
    const confirmed = await perception.confirm(ctxFor('safety'), { draftId });

    assert.equal(confirmed.result.compliant, false);
    assert.equal(confirmed.result.breaches, 1);
    assert.equal(confirmed.result.severity, 'HIGH');

    const observation = platform.ledger.require({
      refType: 'SafetyObservation',
      refId: String(confirmed.result.observationId),
    }).state as Record<string, unknown>;
    assert.equal(observation.observationType, 'UNSAFE_ACT');
    // The person confirming, not anybody in the photograph.
    assert.equal(observation.reportedBy, seed.users.safety!.id);
    // A classification never closes an observation; a person does.
    assert.equal(observation.requiresHumanReview, true);
  });

  it('files a compliant photograph as good practice', async () => {
    const draftId = await read('safety', 'PPE_COMPLIANCE', {
      compliant: true,
      ppeObserved: ['hard hat', 'hi-vis', 'boots', 'gloves'],
      breaches: [],
      immediateRisk: false,
      location: 'Grid D2',
      narrative: 'Full PPE worn by the whole gang at the reinforcement bay.',
    });
    nextOutput = { classification: 'LOW', narrative: 'No action.' };
    const confirmed = await perception.confirm(ctxFor('safety'), { draftId });

    const observation = platform.ledger.require({
      refType: 'SafetyObservation',
      refId: String(confirmed.result.observationId),
    }).state as Record<string, unknown>;
    assert.equal(observation.observationType, 'GOOD_PRACTICE');
  });

  it('lets the confirmer overrule the mapping, because they were there', async () => {
    const draftId = await read('safety', 'PPE_COMPLIANCE', {
      compliant: false,
      breaches: [{ item: 'harness', description: 'Lanyard not clipped at the leading edge' }],
      immediateRisk: true,
      location: 'Roof level',
      narrative: 'Lanyard not clipped at the leading edge.',
    });
    nextOutput = { classification: 'HIGH', narrative: 'Stop work at height.' };
    const confirmed = await perception.confirm(ctxFor('safety'), { draftId, observationType: 'NEAR_MISS' });

    const observation = platform.ledger.require({
      refType: 'SafetyObservation',
      refId: String(confirmed.result.observationId),
    }).state as Record<string, unknown>;
    assert.equal(observation.observationType, 'NEAR_MISS');
  });

  it('needs the authority the safety log itself takes', async () => {
    // The project manager can read the safety log and cannot write to it. The
    // task is gated on exactly what `logSafetyObservation` requires, so nobody
    // can ask a model to draft what they could not have recorded themselves.
    await rejectsCode(
      () =>
        read('pm', 'PPE_COMPLIANCE', {
          compliant: true,
          narrative: 'Everything looks fine.',
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('equipment recognition is an observation, because there is no plant register', () => {
  it('records what was seen, in the platform’s own observation categories', async () => {
    const draftId = await read('siteManager', 'EQUIPMENT_RECOGNITION', {
      items: [
        { description: '30t tracked excavator', count: 1, identifier: 'PL-4471', state: 'IDLE', basis: 'Bucket grounded, no operator in cab' },
        { description: 'Telehandler', count: 2, state: 'WORKING' },
      ],
      location: 'Compound, north end',
      narrative: 'Excavator standing at the compound.',
    });

    const confirmed = await perception.confirm(ctxFor('siteManager'), { draftId, category: 'PROGRESS' });
    assert.equal(confirmed.result.itemsRecorded, 2);
    assert.equal(confirmed.result.idle, 1);

    const observation = platform.ledger.require({
      refType: 'SiteObservation',
      refId: String(confirmed.result.observationId),
    }).state as Record<string, unknown>;
    assert.match(String(observation.description), /PL-4471/);
    assert.match(String(observation.description), /IDLE/);
    // Nothing to act on unless the confirmer said so — a photograph is not an
    // instruction.
    assert.equal(observation.requiresAction, false);
  });

  it('refuses a category the platform does not have', async () => {
    const draftId = await read('siteManager', 'EQUIPMENT_RECOGNITION', {
      items: [{ description: 'Crawler crane', count: 1, state: 'WORKING' }],
    });
    await rejectsCode(
      () => perception.confirm(ctxFor('siteManager'), { draftId, category: 'PLANT' }),
      'PERCEPTION_CATEGORY_INVALID',
    );
  });

  it('takes an action only where the confirmer gives it a date, and owns it', async () => {
    const draftId = await read('siteManager', 'EQUIPMENT_RECOGNITION', {
      items: [{ description: '30t excavator', count: 1, state: 'LAID_UP', basis: 'Tracks off, tarpaulin over the cab' }],
      location: 'Compound',
    });
    const confirmed = await perception.confirm(ctxFor('siteManager'), {
      draftId,
      category: 'ACCESS',
      actionByDate: '2026-09-04',
    });

    const observation = platform.ledger.require({
      refType: 'SiteObservation',
      refId: String(confirmed.result.observationId),
    }).state as Record<string, unknown>;
    assert.equal(observation.requiresAction, true);
    // An action nobody owns is not an action — the register's own rule, and it
    // is satisfied by a real person rather than by the model.
    assert.equal(observation.actionOwner, seed.users.siteManager!.id);
  });
});

describe('defect detection raises one NCR per defect', () => {
  it('raises each separately, so each can be closed on its own', async () => {
    const draftId = await read('qaqc', 'DEFECT_DETECTION', {
      defects: [
        {
          description: 'Honeycombing to the base of panel 3, approximately 300mm × 150mm',
          element: 'Retaining wall panel 3',
          severity: 'MAJOR',
          standardBreached: 'NSCS Class 2 surface finish',
          proposedAction: 'Break out to sound concrete and reinstate with an approved repair mortar.',
        },
        {
          description: 'Cover to the outer layer of reinforcement measured short at the panel 4 construction joint',
          element: 'Retaining wall panel 4',
          severity: 'CRITICAL',
          standardBreached: 'BS EN 1992-1-1 nominal cover',
          proposedAction: 'Survey cover across the panel and refer to the designer before any further pour.',
        },
      ],
      workInProgress: ['Panel 5 is still shuttered'],
      location: 'Grid C4 to C10',
    });

    const confirmed = await perception.confirm(ctxFor('qaqc'), { draftId });
    assert.equal(confirmed.result.raised, 2);

    const ncrs = confirmed.result.ncrs as Array<{ ncrId: string; severity: string }>;
    assert.deepEqual(
      ncrs.map((ncr) => ncr.severity),
      ['MAJOR', 'CRITICAL'],
    );

    const first = platform.ledger.require({ refType: 'NCR', refId: ncrs[0]!.ncrId }).state as Record<string, unknown>;
    // The element and the standard travel into the description, because an NCR
    // that does not say what was breached cannot be argued with.
    assert.match(String(first.description), /Retaining wall panel 3/);
    assert.match(String(first.description), /NSCS Class 2/);
  });

  it('refuses a severity the register does not record, naming which defect', async () => {
    const draftId = await read('qaqc', 'DEFECT_DETECTION', {
      defects: [
        { description: 'Minor surface blemish', severity: 'MINOR', proposedAction: 'Make good.' },
        { description: 'Spalling to the nib', severity: 'HIGH', proposedAction: 'Break out and reinstate.' },
      ],
    });
    await assert.rejects(
      () => perception.confirm(ctxFor('qaqc'), { draftId }),
      (error: { code?: string; message?: string }) => {
        assert.equal(error.code, 'PERCEPTION_SEVERITY_INVALID');
        // Names which one, so the confirmer knows what to correct.
        assert.match(String(error.message), /Defect 2/);
        return true;
      },
    );
  });

  it('will not confirm a photograph the model found nothing wrong in', async () => {
    await rejectsCode(() => read('qaqc', 'DEFECT_DETECTION', { defects: [], workInProgress: ['All of it'] }), 'PERCEPTION_NOT_LEGIBLE');
  });
});

describe('with no provider that can see, none of it runs', () => {
  it('refuses every vision task rather than returning a number derived from a hash', async () => {
    // The local adapter answers anything, deterministically, from a hash of its
    // inputs. Asked how much of a wall is built it returns a confident figure
    // that is a hash — and that figure would become a payment claim.
    const local = new Platform(undefined, store);
    const localSeed = await seedDemoProject(local);
    const localCtx = local.context(localSeed.users.safety!.auth, localSeed.projectId);

    await rejectsCode(
      () => perception.extract(localCtx, store, { hash: PHOTOGRAPH_HASH, task: 'PPE_COMPLIANCE' }),
      'PERCEPTION_EVIDENCE_UNKNOWN',
    );

    // Published so a screen can refuse at the control rather than after
    // somebody has tried.
    const capability = perception.perceptionCapability(localCtx);
    assert.equal(capability.available, false);
    assert.match(capability.reason ?? '', /cannot be shown a file/);
    assert.equal(capability.tasks.length, Object.keys(perception.PERCEPTION_TASKS).length);
  });
});
