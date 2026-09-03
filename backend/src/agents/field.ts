import { SITE_OBSERVATION_CATEGORY, values } from '../../../shared/vocabulary.js';
import type { EngineContext } from '../engines/context.ts';
import type { AgentDefinition, AgentOutput, Finding } from './types.ts';

/**
 * The field fleet — the agents that run for somebody standing on site.
 *
 * Specification E2 names six of them. `AGT-SITE-PROGRESS` was already built as
 * the `field` agent in `registry.ts` and is extended there rather than rebuilt
 * here, because two agents holding one id is exactly the duplication the
 * fleet's own uniqueness invariant exists to catch. The other five are these.
 *
 * They are separate from the delivery fleet in `registry.ts` for one reason
 * that shows up in every one of them: **the delivery fleet watches a project
 * and these watch a day.** A programme agent asks whether the job will finish
 * late. These ask whether the thing that happened this morning reached the
 * record before the person who saw it went home — and the answer decays. A
 * voice note nobody confirmed by Friday is a voice note whose speaker has
 * forgotten what they meant.
 *
 * Three rules run through all five, and they are the reason this fleet does not
 * quietly become a way of filing site records without a person.
 *
 * **Nothing here proposes a write.** Every one of them carries
 * `maxUnattended: 'OBSERVE'` and an empty `proposes`. Confirming a reading is
 * an attribution: `perception.confirm` files the observation against
 * `ctx.auth.actorId`, so a machine confirming it would be putting a person's
 * name on something that person never saw. The specification says the same
 * thing about the photo agent in four words — "never auto-filed" — and it is
 * true of all of them.
 *
 * **The trigger is arithmetic over the record**, as everywhere else in the
 * fleet. No agent here asks a model whether a photograph shows a defect; the
 * perception engine already asked, a draft already holds the answer, and what
 * these agents do is notice that the answer is sitting unread.
 *
 * **A refusal is reported before it happens.** The commonest thing these find
 * is not an error but a confirmation that *will* be refused — a voice note the
 * model marked as needing action, which `captureSiteObservation` will not
 * accept without a date, or a permit whose competency has lapsed. The platform
 * already refuses these correctly. What nobody had was the sentence in advance.
 */

const list = (ctx: EngineContext, refType: string) => ctx.ledger.list(ctx.projectId, refType);
const states = (ctx: EngineContext, refType: string) => list(ctx, refType).map((r) => r.state);
const empty: AgentOutput = { findings: [], proposals: [] };

const DAY_MS = 86_400_000;

/** Today, as the record writes dates. Overridable nowhere: an agent reads the clock once. */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

function daysSince(iso: string, today: string): number {
  return Math.floor((Date.parse(today) - Date.parse(iso.slice(0, 10))) / DAY_MS);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** A draft the perception engine produced and nobody has confirmed or discarded. */
type Draft = {
  id: string;
  task: string;
  status: string;
  evidenceId: string;
  evidenceHash: string;
  producedAt: string;
  confidence?: number;
  extraction?: Record<string, unknown>;
};

function openDrafts(ctx: EngineContext, tasks: readonly string[]): Draft[] {
  return (states(ctx, 'PerceptionDraft') as unknown as Draft[]).filter(
    (draft) => draft.status === 'DRAFT' && tasks.includes(draft.task),
  );
}

// ------------------------------------------------------------ AGT-VOICE-STRUCT

/**
 * The two places dictation lands, and neither of them files itself.
 *
 * A site voice note reaches the platform by one of two paths, and they are not
 * variants of each other. `perception.extract` on an audio file produces a
 * `PerceptionDraft` holding a transcript and a classification, which becomes a
 * site observation when somebody confirms it. `dailylog.ts` holds
 * `VoiceSegment[]` on the daily log itself — dictation mapped onto a field of
 * the log, with a comment that has been waiting for this agent since it was
 * written: *"A person confirmed the mapping. The agent may propose it; it may
 * not file it."*
 *
 * Both stall the same way. The recording is made, the platform reads it, and
 * then nothing happens, because confirming is somebody's job and nothing tells
 * them it is waiting. A transcript nobody confirmed is not evidence of
 * anything: the audio is evidence, and the transcript is an unread opinion
 * about it.
 */
const voiceStructAgent: AgentDefinition = {
  name: 'voice-structure',
  agentId: 'AGT-VOICE-STRUCT',
  division: 'DELIVERY',
  purpose:
    'Watches dictation that the platform has read and nobody has confirmed — and says, before anybody tries, what a ' +
    'confirmation will be refused for.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING'],
  triggers: [
    { kind: 'EVENT', eventType: 'PERCEPTION_DRAFT_PRODUCED' },
    { kind: 'EVENT', eventType: 'SITE_DIARY_RECORDED' },
    { kind: 'ON_DEMAND' },
  ],
  inputs: ['Voice notes read into perception drafts', 'Dictated segments on a daily log'],
  outputs: ['Unconfirmed transcriptions', 'Dictation not yet mapped to a field of the log', 'Why a confirmation would be refused'],
  // Nothing. The observation this leads to is written by the person who
  // confirms the transcript, under their own name, through the ordinary
  // command — so the agent emits nothing and says so rather than claiming
  // SITE_OBSERVATION_CAPTURED it will never write.
  emits: [],
  hitl: 'REVIEW',
  // The confidence on the finding is the model's own confidence in the
  // transcript, carried through rather than invented. The floor is low because
  // the finding is "this is waiting", which is true whatever the model made of
  // the audio — a badly transcribed note is more in need of a person, not less.
  confidenceFloor: 0.3,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  mandate: {
    reads: ['FIELD_EXECUTION', 'EVIDENCE_AUDIT'],
    proposes: [],
    approvers: ['PM', 'SUPERVISOR', 'CONSTRUCTION_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const today = todayIso();
    const categories = values(SITE_OBSERVATION_CATEGORY) as string[];

    const drafts = openDrafts(ctx, ['VOICE_NOTE']);
    for (const draft of drafts) {
      const extraction = draft.extraction ?? {};
      const category = String(extraction.category ?? '');
      const age = daysSince(draft.producedAt, today);

      // Named in advance, because the platform's refusals here are correct and
      // opaque. `captureSiteObservation` requires a date on anything marked as
      // requiring action, and a deadline is not audible — so a note the model
      // read as actionable cannot be confirmed at all until a person supplies
      // one. Somebody finding that out at the moment they press confirm learns
      // it as a bug.
      const blockers: string[] = [];
      if (!categories.includes(category)) {
        blockers.push(`the category reads "${category || 'nothing'}" and has to be one of ${categories.join(', ')}`);
      }
      if (extraction.requiresAction === true) {
        blockers.push('it was read as requiring action, and an action date has to be supplied — a deadline is not audible');
      }

      findings.push({
        key: `voice:unconfirmed:${draft.id}`,
        severity: age >= 3 ? 'ATTENTION' : 'INFO',
        summary:
          `A site voice note read ${age === 0 ? 'today' : `${age} ${plural(age, 'day')} ago`} is still unconfirmed` +
          (blockers.length > 0 ? `, and confirming it now would be refused: ${blockers.join('; ')}.` : '.'),
        consequence:
          'Until somebody confirms it there is no observation on the record — only an audio file and an unread transcript. ' +
          'The person who made the recording is the only one who can say whether the transcript is what they meant, and ' +
          'that is the part that decays.',
        evidence: [
          { refType: 'PerceptionDraft', refId: draft.id, note: `${String(extraction.transcript ?? '').slice(0, 120)}` },
          { refType: 'EvidenceItem', refId: draft.evidenceId, note: 'the recording itself, which the transcript never replaces' },
        ],
        ...(typeof draft.confidence === 'number' ? { confidence: draft.confidence } : {}),
      });
    }

    // The second path: dictation already attached to a daily log, mapped onto a
    // field of it or explicitly not mapped, and in either case not yet
    // confirmed by a person.
    type Segment = { segmentId: string; transcript: string; mappedTo: string; confirmedBy?: string };
    for (const record of list(ctx, 'SiteDiary')) {
      const segments = (record.state.voiceSegments ?? []) as unknown as Segment[];
      const unconfirmed = segments.filter((segment) => !segment.confirmedBy);
      if (unconfirmed.length === 0) continue;

      const unmapped = unconfirmed.filter((segment) => segment.mappedTo === 'UNMAPPED').length;
      findings.push({
        key: `voice:log-segments:${record.refId}`,
        severity: 'ATTENTION',
        summary:
          `${unconfirmed.length} dictated ${plural(unconfirmed.length, 'segment')} on the log for ` +
          `${String(record.state.diaryDate ?? 'an unstated date')} ${plural(unconfirmed.length, 'has', 'have')} not been confirmed` +
          (unmapped > 0 ? `, and ${unmapped} of them ${plural(unmapped, 'maps', 'map')} to no field of the log at all.` : '.'),
        consequence:
          'A mapping nobody confirmed is the platform\'s guess at which part of the day a sentence belongs to. Submitted ' +
          'unchecked it becomes the contemporaneous record, and a delay claim is argued on exactly these sentences.',
        evidence: unconfirmed.slice(0, 3).map((segment) => ({
          refType: 'SiteDiary',
          refId: record.refId,
          note: `${segment.mappedTo}: ${segment.transcript.slice(0, 100)}`,
        })),
      });
    }

    if (findings.length === 0 && drafts.length === 0) return empty;
    return { findings, proposals: [] };
  },
};

// ------------------------------------------------------------ AGT-PHOTO-CLASS

const PHOTO_TASKS = ['PROGRESS_FROM_IMAGES', 'PPE_COMPLIANCE', 'EQUIPMENT_RECOGNITION', 'DEFECT_DETECTION'] as const;

/** What confirming each kind of photograph reading needs from the person doing it. */
const PHOTO_CONFIRMATION: Record<string, { becomes: string; needs?: string }> = {
  PROGRESS_FROM_IMAGES: {
    becomes: 'a progress claim against an activity',
    needs: 'the activity it is against and the period it falls in — neither is visible in an image, and a claim without them cannot be valued',
  },
  PPE_COMPLIANCE: { becomes: 'a safety observation' },
  EQUIPMENT_RECOGNITION: { becomes: 'a site observation recording what plant was on site' },
  DEFECT_DETECTION: { becomes: 'one non-conformance per defect, each closed out separately' },
};

/**
 * Photographs the platform has read, and the two ways that reading goes wrong
 * quietly.
 *
 * A photograph on this platform is not a photograph — it is evidence with a
 * hash, read by `perception.extract` into a draft that becomes a progress
 * claim, a safety observation, a plant record or a set of NCRs when a person
 * confirms it. That confirmation is where the record is actually made, and
 * nothing was watching it.
 *
 * The duplicate check is the half worth explaining. Drafts are keyed by their
 * own id, not by the evidence they read, so running the same task twice over
 * the same bytes produces two drafts that are both perfectly valid and both
 * confirmable — and confirming both files the same defect twice, under two NCR
 * references, to be closed out twice. The hash is what makes this checkable: it
 * is the same file by definition, not a similar one.
 */
const photoClassAgent: AgentDefinition = {
  name: 'photo-classification',
  agentId: 'AGT-PHOTO-CLASS',
  division: 'DELIVERY',
  purpose:
    'Watches site photography the platform has read and nobody has filed — and flags the ones read twice, which would ' +
    'file the same defect under two references.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING'],
  triggers: [{ kind: 'EVENT', eventType: 'PERCEPTION_DRAFT_PRODUCED' }, { kind: 'ON_DEMAND' }],
  inputs: ['Perception drafts read from site photographs', 'The evidence register'],
  outputs: ['Unfiled readings by kind', 'Duplicate readings of the same file', 'Safety breaches read and never logged'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.3,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  mandate: {
    reads: ['FIELD_EXECUTION', 'QUALITY_COMMISSIONING', 'SAFETY_RAMS', 'EVIDENCE_AUDIT'],
    // Empty, and the specification says why in four words: never auto-filed.
    // Confirming a reading files a record under the confirmer's name.
    proposes: [],
    approvers: ['PM', 'SUPERVISOR', 'CONSTRUCTION_MANAGER', 'QAQC', 'SAFETY'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const drafts = openDrafts(ctx, PHOTO_TASKS);
    if (drafts.length === 0) return empty;

    const findings: Finding[] = [];
    const today = todayIso();

    // A PPE breach the platform read and nobody logged is the one that cannot
    // wait. It is separated from the general backlog rather than counted in it,
    // because "eleven readings unfiled" and "somebody was photographed without
    // a harness and it is not on the safety log" are not the same sentence.
    const breaches = drafts.filter((draft) => {
      if (draft.task !== 'PPE_COMPLIANCE') return false;
      const found = (draft.extraction?.breaches as unknown[] | undefined) ?? [];
      return found.length > 0;
    });
    if (breaches.length > 0) {
      findings.push({
        key: `photo:ppe-breach-unlogged:${breaches.length}`,
        severity: 'URGENT',
        summary: `${breaches.length} ${plural(breaches.length, 'photograph')} read as showing a PPE breach ${plural(breaches.length, 'is', 'are')} not on the safety log.`,
        consequence:
          'An unsafe act that was photographed, read and never logged is worse evidentially than one nobody photographed: ' +
          'the platform holds the file and the reading, and the record shows nobody acted on either.',
        evidence: breaches.slice(0, 5).map((draft) => ({
          refType: 'PerceptionDraft',
          refId: draft.id,
          note: `${((draft.extraction?.breaches as unknown[]) ?? []).length} breach(es) read — ${String(draft.extraction?.location ?? 'location not stated')}`,
        })),
      });
    }

    // The same bytes read twice. Grouped on the hash and the task together: the
    // same photograph read once for progress and once for defects is two
    // different questions of one image and entirely legitimate.
    const byHashTask = new Map<string, Draft[]>();
    for (const draft of drafts) {
      const key = `${draft.evidenceHash}:${draft.task}`;
      byHashTask.set(key, [...(byHashTask.get(key) ?? []), draft]);
    }
    const duplicated = [...byHashTask.values()].filter((group) => group.length > 1);
    if (duplicated.length > 0) {
      const extra = duplicated.reduce((total, group) => total + group.length - 1, 0);
      findings.push({
        key: `photo:duplicate-readings:${duplicated.length}`,
        severity: 'ATTENTION',
        summary: `${duplicated.length} ${plural(duplicated.length, 'photograph')} ${plural(duplicated.length, 'has', 'have')} been read more than once for the same thing — ${extra} extra ${plural(extra, 'reading')}.`,
        consequence:
          'Both readings are confirmable and each files its own record. Confirmed twice, one defect becomes two ' +
          'non-conformances to close out, or one pour becomes two progress claims against the same activity.',
        evidence: duplicated.slice(0, 5).flatMap((group) =>
          group.slice(0, 2).map((draft) => ({
            refType: 'PerceptionDraft',
            refId: draft.id,
            note: `${draft.task} over evidence ${draft.evidenceHash.slice(0, 12)}…`,
          })),
        ),
      });
    }

    // Everything else, by kind, saying what confirming it needs. One finding per
    // kind rather than per draft: eleven separate INFO findings about the same
    // backlog is a queue nobody reads.
    const duplicateIds = new Set(duplicated.flat().map((draft) => draft.id));
    const breachIds = new Set(breaches.map((draft) => draft.id));
    const remaining = drafts.filter((draft) => !duplicateIds.has(draft.id) && !breachIds.has(draft.id));

    for (const task of PHOTO_TASKS) {
      const group = remaining.filter((draft) => draft.task === task);
      if (group.length === 0) continue;
      const oldest = group.reduce((worst, draft) => (draft.producedAt < worst.producedAt ? draft : worst));
      const age = daysSince(oldest.producedAt, today);
      const shape = PHOTO_CONFIRMATION[task]!;

      findings.push({
        key: `photo:unfiled:${task}:${group.length}`,
        severity: age >= 7 ? 'ATTENTION' : 'INFO',
        summary:
          `${group.length} ${plural(group.length, 'reading')} waiting to become ${shape.becomes}` +
          (age > 0 ? `, the oldest ${age} ${plural(age, 'day')} old.` : '.'),
        consequence: shape.needs
          ? `Confirming one needs ${shape.needs}. Until then the photograph is filed and the record it was taken for is not.`
          : 'The photograph is filed as evidence and the record it was taken for does not exist yet.',
        evidence: group.slice(0, 3).map((draft) => ({
          refType: 'PerceptionDraft',
          refId: draft.id,
          note: `read ${draft.producedAt.slice(0, 10)}${typeof draft.confidence === 'number' ? ` at ${Math.round(draft.confidence * 100)}% confidence` : ''}`,
        })),
      });
    }

    return { findings, proposals: [] };
  },
};

// ----------------------------------------------------------- AGT-FIELD-ANSWERS

/**
 * The registers a question at the workface lands on.
 *
 * Held here as one list because two things read it: this agent, and the
 * copilot's grounding for a field question in `ai/conversation.ts`. A person
 * asking "what's the fire rating on the L3 risers" is answered out of the
 * drawing and specification registers; "can I start in the chamber" out of
 * permits and RAMS. Where a register is empty the honest answer is that the
 * project holds nothing on it — and knowing that *before* somebody asks is
 * what this agent is for.
 */
export const WORKFACE_REGISTERS: Array<{ refType: string; asked: string }> = [
  { refType: 'Drawing', asked: 'what the drawing says — dimensions, levels, ratings, revisions' },
  { refType: 'Specification', asked: 'what the specification requires of the work' },
  { refType: 'RAMS', asked: 'the method statement for the activity' },
  { refType: 'Permit', asked: 'whether a permit is open for the area and who it covers' },
  { refType: 'InspectionPlan', asked: 'what is inspected, against what, and at which hold point' },
  { refType: 'Induction', asked: 'who has been inducted onto the site' },
  { refType: 'Competency', asked: 'what tickets somebody holds and when they run out' },
  { refType: 'Task', asked: 'what the activity is and where it sits in the programme' },
];

/**
 * The copilot at the workface, and the honest half of it.
 *
 * `ai/conversation.ts` answers a question from materialised state and never
 * from a model's memory of construction generally — that is the copilot, and it
 * is what this agent is the field face of. What the copilot cannot do is tell
 * somebody in advance which questions it is about to answer with "the project
 * holds no data on that", and on site that is the answer that costs an hour:
 * the person is already standing at the workface when they find out.
 *
 * So the agent's sweep is the inverse of a question. It reads the registers a
 * workface question lands on and reports the ones that are empty, as an absence
 * with the register named — which is what `Finding.absence` exists for. It
 * proposes nothing and requires no approval, because an answer that changes
 * nothing needs neither.
 */
const fieldAnswersAgent: AgentDefinition = {
  name: 'field-answers',
  agentId: 'AGT-FIELD-ANSWERS',
  division: 'DELIVERY',
  purpose:
    'The copilot at the workface: says which questions this project can answer from its own record, and which will come ' +
    'back empty, before somebody is standing there asking.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING'],
  triggers: [{ kind: 'ON_DEMAND' }, { kind: 'SCHEDULE', at: '06:00' }],
  inputs: WORKFACE_REGISTERS.map((register) => register.refType),
  outputs: ['Registers a workface question would find empty', 'Superseded drawings still the only answer available'],
  emits: [],
  // Advisory. Nothing follows from an answer except that somebody knows
  // something, and requiring an approval on that would make asking a question
  // into a governance act.
  hitl: 'NONE',
  confidenceFloor: 0,
  acuTier: 'MED',
  memory: { reads: ['PROJECT'], writes: [] },
  mandate: {
    reads: ['FIELD_EXECUTION', 'SAFETY_RAMS', 'QUALITY_COMMISSIONING', 'DESIGN_INFORMATION', 'WORKPACKAGES_TASKS'],
    proposes: [],
    approvers: ['PM', 'SUPERVISOR', 'CONSTRUCTION_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];

    const emptyRegisters = WORKFACE_REGISTERS.filter((register) => list(ctx, register.refType).length === 0);
    if (emptyRegisters.length > 0) {
      findings.push({
        key: `answers:empty-registers:${emptyRegisters.map((r) => r.refType).join('-')}`,
        severity: emptyRegisters.length >= 4 ? 'ATTENTION' : 'INFO',
        summary:
          `${emptyRegisters.length} of the ${WORKFACE_REGISTERS.length} ${plural(WORKFACE_REGISTERS.length, 'register')} a question at the ` +
          `workface is answered from ${plural(emptyRegisters.length, 'is', 'are')} empty.`,
        consequence:
          'Asked one of these, the platform answers that it holds nothing — which is correct and is not what the person ' +
          'needed. They ring somebody, or they guess.',
        // No record to cite, because the point is that there is none. The
        // absence names the register and what was looked for, which is the
        // whole reason `absence` exists separately from `evidence`.
        evidence: [],
        absence: emptyRegisters.map((register) => ({
          refType: register.refType,
          looked: register.asked,
          found: 0,
        })),
      });
    }

    // A drawing register that holds only superseded revisions is worse than an
    // empty one: it answers, and the answer is out of date. `registerDrawing`
    // marks the previous revision SUPERSEDED, so this is a status read rather
    // than a comparison of revision strings.
    const drawings = list(ctx, 'Drawing');
    const current = drawings.filter((record) => record.state.status === 'CURRENT');
    if (drawings.length > 0 && current.length === 0) {
      findings.push({
        key: 'answers:no-current-drawing',
        severity: 'URGENT',
        summary: `All ${drawings.length} ${plural(drawings.length, 'drawing')} on the register ${plural(drawings.length, 'is', 'are')} superseded, so a dimension asked for on site is answered from a drawing nobody should be building to.`,
        consequence:
          'A superseded drawing answers confidently. Work set out from one is rework at best, and the revision that ' +
          'superseded it is the one that changed the dimension somebody just asked about.',
        evidence: drawings.slice(0, 3).map((record) => ({
          refType: 'Drawing',
          refId: record.refId,
          note: `${String(record.state.drawingNumber ?? record.refId)} rev ${String(record.state.revision ?? '?')} — ${String(record.state.status)}`,
        })),
        absence: [{ refType: 'Drawing', looked: 'a drawing at CURRENT status', found: 0 }],
      });
    }

    return { findings, proposals: [] };
  },
};

// --------------------------------------------------------------- AGT-HSE-FIELD

/**
 * Safety on the day, which is not the same subject as safety on the project.
 *
 * `AGT-HSE` watches the duties that are law and carry a statutory date: the
 * Construction Phase Plan, the RIDDOR determination, competency expiry. Those
 * are project-level and they are somebody's job for the month. This one watches
 * the shift — the permit that runs out on Thursday while the work is promised
 * to Friday, the permit still open with nobody having handed the area back, and
 * the condition three people have now reported in the same place.
 *
 * They do not overlap: nothing here reads a CDM document, and nothing there
 * reads a lookahead.
 *
 * `hitl: 'APPROVAL'` because the specification says so, and because it is
 * right: a decision that work carries on under an expired permit is a decision
 * a person with safety authority takes and signs. The agent's job is to make
 * sure that decision is taken deliberately rather than by nobody noticing.
 *
 * What it does not do is draft the toolbox talk. The specification asks for
 * "toolbox talk drafts from active RAMS", and `recordToolboxTalk` refuses a
 * talk with no attendance — correctly, because a talk that briefed nobody is
 * not a talk. An agent cannot know who will be standing there, so it names the
 * approved method statement the talk should be given from and leaves the
 * briefing to the person giving it.
 */
const hseFieldAgent: AgentDefinition = {
  name: 'hse-field',
  agentId: 'AGT-HSE-FIELD',
  division: 'DELIVERY',
  purpose:
    'Watches the shift rather than the project: permits running out under promised work, areas never handed back, and ' +
    'the same hazard reported in the same place more than once.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING'],
  triggers: [
    { kind: 'SCHEDULE', at: '06:00' },
    { kind: 'EVENT', eventType: 'SAFETY_OBSERVATION_LOGGED' },
    { kind: 'EVENT', eventType: 'INCIDENT_RECORDED' },
    { kind: 'EVENT', eventType: 'LOOKAHEAD_PUBLISHED' },
  ],
  inputs: ['Permits and their validity', 'Approved method statements', 'Safety observations', 'This week’s lookahead and its commitments'],
  outputs: ['Permits expiring under promised work', 'Areas never handed back', 'Repeated hazards at one location', 'The RAMS a toolbox talk is due from'],
  emits: [],
  hitl: 'APPROVAL',
  confidenceFloor: 0.6,
  acuTier: 'MED',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  mandate: {
    reads: ['SAFETY_RAMS', 'FIELD_EXECUTION', 'LOOKAHEAD_CONSTRAINTS'],
    proposes: [],
    approvers: ['SAFETY', 'PM', 'CONSTRUCTION_MANAGER', 'EPC'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const today = todayIso();

    const permits = list(ctx, 'Permit');
    const open = permits.filter((record) => record.state.status === 'ISSUED');

    // Open, and its own end date has gone. The handback sentence is what the
    // next person into the area is relying on, and an open permit says nobody
    // has written it.
    const lapsed = open.filter((record) => String(record.state.validTo ?? '') < today);
    if (lapsed.length > 0) {
      findings.push({
        key: `hse-field:permit-not-handed-back:${lapsed.length}`,
        severity: 'URGENT',
        summary: `${lapsed.length} ${plural(lapsed.length, 'permit')} ${plural(lapsed.length, 'is', 'are')} still open past the date ${plural(lapsed.length, 'it', 'they')} expired, with no handback recorded.`,
        consequence:
          'Nobody has said what state the area was left in or who checked it. The commonest injury after a confined-space ' +
          'entry is to the person who goes in next, and that sentence is what they are relying on.',
        evidence: lapsed.slice(0, 5).map((record) => ({
          refType: 'Permit',
          refId: record.refId,
          note: `${String(record.state.reference)} — ${String(record.state.activity)} at ${String(record.state.location)}, expired ${String(record.state.validTo)}`,
        })),
      });
    }

    // A permit that ends inside the week the work is promised in. Arithmetic
    // over two dates the record already holds, and the failure it prevents is
    // the ordinary one: the gang turns up on Friday and the paperwork stopped
    // on Wednesday.
    const currentWeek = list(ctx, 'LookaheadPlan')
      .filter((plan) => plan.state.status !== 'REVIEWED')
      .sort((a, b) => (String(a.state.weekStarting) < String(b.state.weekStarting) ? 1 : -1))
      .at(0);
    if (currentWeek) {
      const commitments = (currentWeek.state.commitments ?? []) as Array<{ taskId: string; promise: string; promisedBy: string; dueDate: string }>;
      const latestPromise = commitments.map((commitment) => commitment.dueDate).sort().at(-1);
      if (latestPromise) {
        const expiring = open.filter((record) => {
          const validTo = String(record.state.validTo ?? '');
          return validTo >= today && validTo < latestPromise;
        });
        if (expiring.length > 0) {
          findings.push({
            key: `hse-field:permit-expires-in-week:${expiring.length}`,
            severity: 'ATTENTION',
            summary: `${expiring.length} open ${plural(expiring.length, 'permit')} ${plural(expiring.length, 'expires', 'expire')} before the last promise of this week falls due on ${latestPromise}.`,
            consequence:
              'The work is promised past the date its authorisation ends. Either the permit is extended — which is refused ' +
              'if a ticket lapses inside the extension — or the promise is one nobody can keep lawfully.',
            evidence: expiring.slice(0, 5).map((record) => ({
              refType: 'Permit',
              refId: record.refId,
              note: `${String(record.state.reference)} — ${String(record.state.activity)}, valid to ${String(record.state.validTo)}`,
            })),
          });
        }
      }
    }

    // The same thing seen in the same place more than once. A single unsafe
    // condition is an observation; the third one at the same location is a
    // control that is not working, and counting is the only way that shows.
    const observations = list(ctx, 'SafetyObservation').filter(
      (record) => record.state.observationType === 'UNSAFE_CONDITION' || record.state.observationType === 'UNSAFE_ACT',
    );
    const byLocation = new Map<string, typeof observations>();
    for (const record of observations) {
      const location = String(record.state.location ?? '').trim().toLowerCase();
      if (!location || location === 'not stated') continue;
      byLocation.set(location, [...(byLocation.get(location) ?? []), record]);
    }
    const repeated = [...byLocation.entries()].filter(([, group]) => group.length >= 3);
    for (const [location, group] of repeated) {
      findings.push({
        key: `hse-field:repeat-location:${location}`,
        severity: 'URGENT',
        summary: `${group.length} unsafe acts or conditions have been reported at ${String(group[0]!.state.location)}.`,
        consequence:
          'Three reports in one place is not three observations, it is one control that is not working. The next report ' +
          'from there is as likely to be an incident.',
        evidence: group.slice(0, 5).map((record) => ({
          refType: 'SafetyObservation',
          refId: record.refId,
          note: `${String(record.state.observationType)} — ${String(record.state.description ?? '').slice(0, 100)}`,
        })),
      });
    }

    // A toolbox talk is due against approved method statements and none has been
    // given. Named rather than drafted: the talk needs an audience, and the
    // agent does not know who will be standing there.
    const approvedRams = list(ctx, 'RAMS').filter((record) => record.state.status === 'APPROVED');
    const talks = list(ctx, 'ToolboxTalk');
    if (approvedRams.length > 0 && talks.length === 0) {
      findings.push({
        key: `hse-field:no-toolbox-talk:${approvedRams.length}`,
        severity: 'ATTENTION',
        summary: `${approvedRams.length} approved ${plural(approvedRams.length, 'method statement')} on site and no toolbox talk delivered against any of them.`,
        consequence:
          'An approved method statement nobody was briefed on is a document, not a control. The gang works to what they ' +
          'were told, and nothing on the record says they were told anything.',
        evidence: approvedRams.slice(0, 5).map((record) => ({
          refType: 'RAMS',
          refId: record.refId,
          note: `${String(record.state.activityDescription ?? record.refId)} at ${String(record.state.location ?? 'an unstated location')} — approved, never briefed`,
        })),
        absence: [{ refType: 'ToolboxTalk', looked: 'a talk delivered against an approved method statement', found: 0 }],
      });
    }

    return { findings, proposals: [] };
  },
};

// ------------------------------------------------------------------ AGT-TODAY

/**
 * The day, for the person having it.
 *
 * Distinct from the morning briefing in `briefing.ts`, and the distinction is
 * not a matter of emphasis. That briefing reads across the whole tenancy — the
 * market, the pipeline, cash, the estate — and authorises on
 * `BUSINESS_DEVELOPMENT`, which a supervisor and a subcontractor seat do not
 * hold. It answers "what should the business do today". This answers "what is
 * on this job today", from the field capability, for whoever opens it.
 *
 * Distinct from `AGT-LOOKAHEAD` too, which watches the week: constraints past
 * their need-by date, blocks that never became constraints, weeks nobody
 * reviewed. Everything here is dated today or yesterday.
 */
const todayAgent: AgentDefinition = {
  name: 'today',
  agentId: 'AGT-TODAY',
  division: 'DELIVERY',
  purpose:
    'What is on this job today: promises falling due, yesterday’s record not yet made, and what is authorised to happen ' +
    'on site right now.',
  activeIn: ['CONSTRUCTION', 'COMMISSIONING'],
  // 05:30, which is before the shift rather than during it. A card that appears
  // at nine is a card about a decision already taken.
  triggers: [{ kind: 'SCHEDULE', at: '05:30' }, { kind: 'EVENT', eventType: 'LOOKAHEAD_PUBLISHED' }, { kind: 'ON_DEMAND' }],
  inputs: ['This week’s commitments', 'Daily logs and their status', 'Open permits'],
  outputs: ['Promises due today', 'Yesterday’s record still missing', 'What is authorised on site today'],
  emits: [],
  hitl: 'REVIEW',
  confidenceFloor: 0.5,
  acuTier: 'LOW',
  memory: { reads: ['PROJECT'], writes: ['PROJECT'] },
  mandate: {
    reads: ['FIELD_EXECUTION', 'LOOKAHEAD_CONSTRAINTS', 'SAFETY_RAMS'],
    proposes: [],
    approvers: ['PM', 'SUPERVISOR', 'CONSTRUCTION_MANAGER'],
    maxUnattended: 'OBSERVE',
  },
  evaluate(ctx) {
    const findings: Finding[] = [];
    const today = todayIso();
    const yesterday = new Date(Date.parse(today) - DAY_MS).toISOString().slice(0, 10);

    // Promises whose due date is today or has gone, on a week nobody has
    // reviewed yet. A promise past its date and still PROMISED is not a missed
    // promise — it is one nobody has answered, and PPC counts answers.
    const plans = list(ctx, 'LookaheadPlan').filter((plan) => plan.state.status !== 'REVIEWED');
    type Promise_ = { taskId: string; promise: string; promisedBy: string; dueDate: string; status?: string };
    const due: Array<{ planId: string; commitment: Promise_ }> = [];
    for (const plan of plans) {
      for (const commitment of (plan.state.commitments ?? []) as Promise_[]) {
        if (commitment.status && commitment.status !== 'PROMISED') continue;
        if (commitment.dueDate > today) continue;
        due.push({ planId: plan.refId, commitment });
      }
    }
    if (due.length > 0) {
      const overdue = due.filter((entry) => entry.commitment.dueDate < today);
      findings.push({
        key: `today:promises-due:${due.length}`,
        severity: overdue.length > 0 ? 'ATTENTION' : 'INFO',
        summary:
          `${due.length} ${plural(due.length, 'promise')} ${plural(due.length, 'falls', 'fall')} due today or earlier and ${plural(due.length, 'has', 'have')} no outcome against ${plural(due.length, 'it', 'them')}` +
          (overdue.length > 0 ? `, ${overdue.length} of ${plural(overdue.length, 'it', 'them')} already past the date.` : '.'),
        consequence:
          'Every promise gets an answer, including the ones nobody wants to discuss. A promise left unanswered does not ' +
          'lower PPC — it vanishes from it, and so does the reason it was missed.',
        evidence: due.slice(0, 5).map((entry) => ({
          refType: 'LookaheadPlan',
          refId: entry.planId,
          note: `${entry.commitment.promise} — ${entry.commitment.promisedBy}, due ${entry.commitment.dueDate}`,
        })),
      });
    }

    // Yesterday's record. Not "diary coverage", which the field agent already
    // watches across the whole job — one specific day, the one whose detail is
    // still in somebody's head this morning.
    const diaries = list(ctx, 'SiteDiary');
    const yesterdayRecorded = diaries.some(
      (record) => String(record.state.diaryDate ?? '').slice(0, 10) === yesterday && record.state.status !== 'DRAFT',
    );
    const yesterdayDraft = diaries.find(
      (record) => String(record.state.diaryDate ?? '').slice(0, 10) === yesterday && record.state.status === 'DRAFT',
    );
    if (diaries.length > 0 && !yesterdayRecorded) {
      findings.push({
        key: `today:diary-missing:${yesterday}`,
        severity: 'ATTENTION',
        summary: yesterdayDraft
          ? `Yesterday’s log (${yesterday}) is still a draft on a device and has not been submitted.`
          : `No log has been recorded for yesterday (${yesterday}).`,
        consequence:
          'A diary written a week late is not contemporaneous, and the record says so on its own face — `daysLate` is ' +
          'stamped on it. It is the entry a delay claim is argued on, and its weight is set by when it was written.',
        evidence: yesterdayDraft
          ? [{ refType: 'SiteDiary', refId: yesterdayDraft.refId, note: `draft on device ${String(yesterdayDraft.state.deviceId ?? 'unknown')}` }]
          : [],
        ...(yesterdayDraft
          ? {}
          : { absence: [{ refType: 'SiteDiary', looked: `a log for ${yesterday}`, found: diaries.length }] }),
      });
    }

    // What is authorised right now. Stated positively rather than as a gap: it
    // is the one card on this screen a person reads before walking out, and a
    // day with three permits open is a different day from one with none.
    const openToday = list(ctx, 'Permit').filter(
      (record) =>
        record.state.status === 'ISSUED' &&
        String(record.state.validFrom ?? '') <= today &&
        String(record.state.validTo ?? '') >= today,
    );
    if (openToday.length > 0) {
      findings.push({
        key: `today:permits-open:${openToday.length}`,
        severity: 'INFO',
        summary: `${openToday.length} ${plural(openToday.length, 'permit')} ${plural(openToday.length, 'is', 'are')} valid on site today.`,
        consequence:
          'High-risk work is authorised only inside a permit. Anyone doing this work outside the named operatives on ' +
          'these is doing it without authorisation, whatever else is on the programme.',
        evidence: openToday.slice(0, 5).map((record) => ({
          refType: 'Permit',
          refId: record.refId,
          note: `${String(record.state.reference)} — ${String(record.state.activity)} at ${String(record.state.location)}, to ${String(record.state.validTo)}`,
        })),
      });
    }

    return { findings, proposals: [] };
  },
};

/**
 * The five field agents. `AGT-SITE-PROGRESS` is the sixth and lives in
 * `registry.ts`, where it was already built.
 */
export const FIELD_AGENTS: AgentDefinition[] = [
  voiceStructAgent,
  photoClassAgent,
  fieldAnswersAgent,
  hseFieldAgent,
  todayAgent,
];
