import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as documents from '../src/documents/generate.ts';
import { resolveSources } from '../src/documents/engine.ts';
import * as measurement from '../src/domain/measurement.ts';
import * as meetings from '../src/domain/meetings.ts';
import * as structure from '../src/domain/structure.ts';
import * as quality from '../src/engines/quality.ts';
import * as submittals from '../src/domain/submittals.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { DocumentBlock } from '../src/export/exporter.ts';

/**
 * The ten planning and quality documents.
 *
 * The safety five are built around cross-reference. These ten are built around
 * arithmetic the platform does and a person does not: a formula re-evaluated
 * against the quantity it produced, a day named because no diary entry covers
 * it, an approval date worked back from a lead time, a hold point with no
 * release against it.
 *
 * So most of what follows composes a document against records that are
 * *deliberately wrong in one specific way* and asserts the document says so.
 * A generator tested only against a clean fixture proves it can print a table.
 */

let platform: Platform;
let seed: SeedResult;

const asAdmin = () => platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
const asQaqc = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/**
 * Compose one document's body without going near the exporter.
 *
 * The exporter path — branding, redaction, hashing — is already covered by the
 * safety suite and is the same seam for all fifteen types. What is untested is
 * what each new generator *says*, and this is the smallest thing that exercises
 * exactly that.
 */
function compose(code: string, subjectId?: string): string {
  const ctx = asAdmin();
  const definition = documents.documentType(code);
  const subject =
    definition.scope === 'RECORD'
      ? (platform.ledger.get({ refType: definition.subject!, refId: subjectId! })?.state as Record<string, unknown>)
      : undefined;
  const { sources, missing } = resolveSources(ctx, definition, subject);
  assert.deepEqual(missing, [], `${code} could not be composed: ${missing.map((m) => m.refType).join(', ')}`);
  const blocks: DocumentBlock[] = definition.compose({
    ctx,
    project: platform.ledger.require({ refType: 'Project', refId: seed.projectId }).state,
    sources,
    subject,
    narrative: new Map(),
    today: new Date().toISOString().slice(0, 10),
  });
  return JSON.stringify(blocks);
}

let scheduleId: string;
let meetingId: string;
let submittalId: string;
let ncrId: string;
let planId: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const phase = (to: 'TENDER' | 'CONSTRUCTION', justification: string) =>
    structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
      to,
      justification,
    });

  // --- A bill with one formula that no longer agrees with its quantity ------
  phase('TENDER', 'Reopened to record the measurement schedule the bill is composed from');
  scheduleId = measurement.openSchedule(asQS(), {
    packageReference: 'PKG-CIV',
    title: 'Civils — inlet works',
    measurementRule: 'NRM2',
  }).scheduleId;
  measurement.recordItems(asQS(), scheduleId, [
    {
      reference: 'A10',
      description: 'Bulk excavation in made ground, depth not exceeding 4m',
      unit: 'm3',
      quantity: 18_400,
      basis: 'FIRM',
      source: 'DRAWING',
      formula: '92 * 50 * 4',
      measurementRule: 'NRM2',
    },
    {
      reference: 'A2',
      description: 'Disposal of excavated material off site',
      unit: 'm3',
      quantity: 4600,
      basis: 'PROVISIONAL',
      source: 'ESTIMATED',
      measurementRule: 'NRM2',
    },
    // The defect the document has to find: dimensions that evaluate to 95.48,
    // billed at 610. Both fields look entirely plausible on their own.
    {
      reference: 'A3',
      description: 'In situ concrete C32/40 to walls',
      unit: 'm3',
      quantity: 610,
      basis: 'FIRM',
      source: 'DRAWING',
      formula: '12.4 * 3.85 * 2',
      measurementRule: 'NRM2',
    },
    // And a dimension that is not arithmetic at all, which must be reported as
    // unchecked rather than silently counted as fine.
    {
      reference: 'A4',
      description: 'Formwork to walls, both faces',
      unit: 'm2',
      quantity: 980,
      basis: 'FIRM',
      source: 'DRAWING',
      formula: 'per the wall schedule, sheet C-1204',
      measurementRule: 'NRM2',
    },
  ] as Parameters<typeof measurement.recordItems>[2]);
  measurement.priceItem(asQS(), scheduleId, {
    reference: 'A10',
    components: [
      { kind: 'PLANT', description: '30t excavator', unitCostMinor: 6500, constant: 0.04 },
      { kind: 'LABOUR', description: 'Groundworker', unitCostMinor: 3200, constant: 0.06 },
    ],
  });

  // --- A meeting, issued, with an action carried from months earlier --------
  meetingId = meetings.openMeeting(asPlanner(), {
    type: 'PROGRESS',
    title: 'Monthly progress meeting no.7',
    heldAt: daysAgo(30),
    location: 'Site office, meeting room 1',
    chair: 'A. Okafor',
    attendees: [
      { name: 'A. Okafor', organisation: 'Meridian Infrastructure Group', role: 'Project manager', attended: true },
      { name: 'R. Sandhu', organisation: 'Northern Water Authority', role: 'Client representative', attended: true },
      { name: 'T. Brennan', organisation: 'Northgate Mechanical Ltd', role: 'Package manager', attended: false },
    ],
  }).meetingId;
  meetings.recordAgendaItem(asPlanner(), meetingId, {
    subject: 'Programme',
    discussion:
      'Inlet chamber pours are four days behind the June baseline. The contractor attributes this to the late ' +
      'reinforcement details; the client reserves its position.',
  });
  meetings.recordAction(asPlanner(), meetingId, {
    what: 'Issue the revised roof build-up to the cladding subcontractor',
    owner: 'D. Whyte',
    ownerOrganisation: 'Caldervale Engineering',
    by: daysAgo(-14).slice(0, 10),
    raisedAtMeeting: 'PROGRESS-002',
    originallyDue: daysAgo(112).slice(0, 10),
  });
  meetings.issueMinutes(asPM(), meetingId);
  meetings.recordCorrection(asPlanner(), meetingId, {
    raisedBy: 'R. Sandhu, Northern Water Authority',
    what: 'The client did not reserve its position; it rejected the attribution outright.',
  });

  // --- A submittal with a departure, a substitution and an approval ---------
  const clause = platform.ledger
    .list(seed.projectId, 'SpecClause')
    .find((record) => record.state.clauseRef === 'E10/3.2')!;
  submittalId = submittals.raiseSubmittal(asPM(), {
    kind: 'MATERIAL',
    title: 'Concrete mix design — clarifier walls',
    clauseId: clause.refId,
    manufacturer: 'Aggregate Industries',
    productReference: 'AI-C3240-XC4-GGBS50',
    claims: [
      { requirement: 'Strength class', specified: 'C32/40', offered: 'C32/40', compliant: true },
      {
        requirement: 'Cement type',
        specified: 'CEM I with 25% PFA',
        offered: 'CEM IIIA, 50% GGBS',
        compliant: false,
        justification:
          'The PFA source named in the specification closed. GGBS at 50% gives equal or better sulfate resistance for ' +
          'DS-3 ground to BS 8500-1 Table A.9.',
      },
    ],
    procurementLeadTimeDays: 28,
    requiredOnSiteBy: '2027-09-01',
    reviewPeriodDays: 14,
    substitution: {
      differsFrom: 'The specified CEM I mix with 25% PFA',
      whyProposed: 'PFA source closure; GGBS meets the DS-3 requirement and is available locally.',
    },
  }).submittalId;
  submittals.submitForReview(asPM(), submittalId);
  submittals.reviewSubmittal(asDesigner(), submittalId, {
    outcome: 'APPROVED_WITH_COMMENTS',
    comments: 'Approved. Confirm the plant’s conformity certificate before the first delivery, per E10/3.1.',
  });

  // --- A non-conformance closed as use-as-is --------------------------------
  phase('CONSTRUCTION', 'Reopened to record the quality documents this project is generated from');
  planId = platform.ledger.list(seed.projectId, 'InspectionPlan')[0]!.refId;
  ncrId = quality.raiseNCR(asQaqc(), {
    description:
      'Cover to the outer face reinforcement of clarifier wall pour CW-03 measured at 28mm against a specified 40mm ' +
      'nominal, over approximately 6m2.',
    severity: 'MAJOR',
    proposedAction: 'Assess durability against the DS-3 exposure class and either coat or cut out and recast.',
    evidenceHash: `sha256:${'e'.repeat(64)}`,
  }).ncrId;
  quality.closeNCR(asPM(), ncrId, {
    disposition: 'USE_AS_IS',
    justification:
      'Durability reassessed by Caldervale Engineering (CE-DUR-114): 28mm cover with the 50% GGBS mix gives a design ' +
      'life of 62 years against the 60 required.',
    evidenceHash: `sha256:${'f'.repeat(64)}`,
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('documents · all fifteen types are in one catalogue behind one command', () => {
  it('carries five of each category', () => {
    const byCategory = new Map<string, number>();
    for (const definition of documents.DOCUMENT_TYPES) {
      byCategory.set(definition.category, (byCategory.get(definition.category) ?? 0) + 1);
    }
    assert.equal(documents.DOCUMENT_TYPES.length, 15);
    assert.equal(byCategory.get('SAFETY_AND_HEALTH'), 5);
    assert.equal(byCategory.get('PROJECT_MANAGEMENT'), 5);
    assert.equal(byCategory.get('QUALITY_AND_COMPLIANCE'), 5);
  });

  it('gives every type a distinct code, a purpose and at least one narrative brief', () => {
    const codes = new Set<string>();
    for (const definition of documents.DOCUMENT_TYPES) {
      assert.equal(codes.has(definition.code), false, `${definition.code} is defined twice`);
      codes.add(definition.code);
      assert.ok(definition.purpose.length > 60, `${definition.code} has no real purpose statement`);
      assert.ok(definition.narrative.length > 0, `${definition.code} asks the engine for nothing`);
      // Every brief has to forbid the model inventing facts, in the brief
      // itself and not only in the engine's constraint. Two statements of the
      // same rule is deliberate: the brief is what the model reads first.
      for (const section of definition.narrative) {
        assert.match(section.brief, /not already on the document/, `${definition.code}: ${section.heading}`);
      }
    }
  });

  it('names a subject entity for every record-scoped type', () => {
    for (const definition of documents.DOCUMENT_TYPES) {
      if (definition.scope === 'RECORD') {
        assert.ok(definition.subject, `${definition.code} is record-scoped with no subject entity`);
        assert.ok(definition.reference, `${definition.code} is record-scoped with no reference on the document`);
      }
    }
  });
});

// ── Master programme ────────────────────────────────────────────────────────

describe('documents · the master programme joins the critical path to what is blocking it', () => {
  let rendered: string;

  before(() => {
    rendered = compose('MASTER_PROGRAMME');
  });

  it('states the confidence attached to the duration, not only the duration', () => {
    assert.match(rendered, /Duration at this baseline/);
    assert.match(rendered, /Duration at 80% confidence/);
    assert.match(rendered, /Probability of completing to this duration/);
  });

  it('marks every activity as on or off the critical path', () => {
    assert.match(rendered, /On the critical path/);
    assert.match(rendered, /Currently blocked by/);
  });

  it('states the logic between the activities rather than only their durations', () => {
    assert.match(rendered, /The logic between the activities/);
    assert.match(rendered, /Finish to start/);
  });

  it('reports slippage as a signed number of days rather than as a blank', () => {
    // A blank in a slippage column reads as "not measured", and zero and
    // unmeasured are different facts about an activity.
    assert.match(rendered, /\+\d+ days|0 days/);
  });
});

// ── Bill of quantities ──────────────────────────────────────────────────────

describe('documents · the bill re-evaluates its own dimensions', () => {
  let rendered: string;

  before(() => {
    rendered = compose('BILL_OF_QUANTITIES');
  });

  it('finds the item whose formula no longer produces the quantity billed', () => {
    assert.match(rendered, /Where a dimension and its quantity no longer agree/);
    // 12.4 * 3.85 * 2 = 95.48, billed at 610. Both fields look plausible alone.
    assert.match(rendered, /95\.48/);
    assert.match(rendered, /In situ concrete C32\/40 to walls/);
  });

  it('does not report the item whose formula does agree', () => {
    // 92 * 50 * 4 = 18400, which is what is billed. It must not appear in the
    // disagreement table, or the check reports noise and stops being read.
    const disagreement = rendered.slice(rendered.indexOf('no longer agree'));
    const table = disagreement.slice(0, disagreement.indexOf('Quantities that are not firm'));
    assert.equal(table.includes('Bulk excavation in made ground'), false);
  });

  it('names the dimension it could not evaluate rather than counting it as fine', () => {
    // Silence here would let the document report full coverage of a check it
    // never ran on that item.
    assert.match(rendered, /not arithmetic this platform can evaluate/);
    assert.match(rendered, /per the wall schedule, sheet C-1204/);
  });

  it('says how many items were actually checked', () => {
    assert.match(rendered, /2 of the 4 items in this bill carry a dimension formula that could be re-evaluated/);
  });

  it('warns that a bill off an unfrozen schedule can still move', () => {
    assert.match(rendered, /still open/);
    assert.match(rendered, /pricing against a moving target/);
  });

  it('separates provisional quantities from firm ones and says which is which', () => {
    assert.match(rendered, /Quantities that are not firm/);
    assert.match(rendered, /Provisional/);
    assert.match(rendered, /1 of the 4 items in this bill carries a quantity that is not firm/);
  });

  it('shows unpriced items as unpriced rather than as zero', () => {
    // A denial rendered as zero is the failure the whole platform is built
    // against; an unpriced item shown at nil is the same failure on paper.
    assert.match(rendered, /Not priced/);
    assert.equal(rendered.includes('"£0.00"'), false);
  });
});

// ── Site diary ──────────────────────────────────────────────────────────────

describe('documents · the site diary is read for the days that are not in it', () => {
  let rendered: string;

  before(() => {
    rendered = compose('SITE_DIARY');
  });

  it('states for every entry whether it was written on the day', () => {
    assert.match(rendered, /Recorded on the day/);
  });

  it('reports the days in the period with no entry at all', () => {
    assert.match(rendered, /Days in this period with no entry/);
  });

  it('totals the period rather than only listing it', () => {
    assert.match(rendered, /Labour hours/);
    assert.match(rendered, /Plant idle hours/);
    assert.match(rendered, /Idle plant as a share of labour effort/);
  });

  it('pulls out the days weather stopped work, which is what a weather claim rests on', () => {
    assert.match(rendered, /Days on which weather stopped work/);
    assert.match(rendered, /the evidence behind any weather claim/);
  });
});

// ── Meeting minutes ─────────────────────────────────────────────────────────

describe('documents · the minutes show who was absent and what is genuinely overdue', () => {
  let rendered: string;

  before(() => {
    rendered = compose('MEETING_MINUTES', meetingId);
  });

  it('shows apologies rather than listing only the people who turned up', () => {
    assert.match(rendered, /Apologies/);
    assert.match(rendered, /was agreed in their absence/);
  });

  it('measures a carried action against the date it was originally given', () => {
    assert.match(rendered, /keeps the date it was originally given/);
    // 112 days before the meeting, which was 30 days ago: 82 days overdue on
    // the day, not "due in a fortnight" as the restated date would suggest.
    assert.match(rendered, /82 days/);
  });

  it('prints the correction beside the text rather than instead of it', () => {
    assert.match(rendered, /Corrections raised against these minutes/);
    assert.match(rendered, /rejected the attribution outright/);
    // The original sentence survives.
    assert.match(rendered, /the client reserves its position/);
  });
});

// ── RFI ─────────────────────────────────────────────────────────────────────

describe('documents · the RFI states the revision its answer was given against', () => {
  let rendered: string;

  before(() => {
    rendered = compose('RFI', platform.ledger.list(seed.projectId, 'RFI')[0]!.refId);
  });

  it('carries the drawing, the revision asked against and the revision now current', () => {
    assert.match(rendered, /Revision the question was asked against/);
    assert.match(rendered, /Revision currently on the register/);
  });

  it('says outright when the answer is a design change', () => {
    assert.match(rendered, /The answer changes the design/);
    assert.match(rendered, /should be assessed as one before it is built to/);
  });
});

// ── Inspection and test plan ────────────────────────────────────────────────

describe('documents · the ITP names hold points with no recorded release', () => {
  let rendered: string;

  before(() => {
    rendered = compose('INSPECTION_TEST_PLAN', planId);
  });

  it('puts the inspection actually carried out beside the stage that required it', () => {
    assert.match(rendered, /Each stage, and the inspection actually carried out against it/);
  });

  it('names the hold point nobody has released', () => {
    assert.match(rendered, /Hold points with no recorded release/);
    assert.match(rendered, /Reinforcement inspection before covering/);
    assert.match(rendered, /that is a non-conformance whether or not one has been raised/);
  });

  it('explains what the three stage types mean rather than assuming the reader knows', () => {
    assert.match(rendered, /A hold point stops the work/);
    assert.match(rendered, /A witness point does not stop the work but must be attended/);
  });
});

// ── Material submittal ──────────────────────────────────────────────────────

describe('documents · the submittal shows both sides of every claim', () => {
  let rendered: string;

  before(() => {
    rendered = compose('MATERIAL_SUBMITTAL', submittalId);
  });

  it('carries the specified value and the offered value in the same row', () => {
    assert.match(rendered, /What is specified, and what is offered/);
    assert.match(rendered, /CEM I with 25% PFA/);
    assert.match(rendered, /CEM IIIA, 50% GGBS/);
  });

  it('tells the reviewer they are signing for the departure', () => {
    assert.match(rendered, /1 of the 2 requirements above is offered as not complying/);
    assert.match(rendered, /a reviewer signing this is signing for it/);
  });

  it('says a substitution is a change, in those words', () => {
    assert.match(rendered, /This is offered as a substitution/);
    assert.match(rendered, /approved a product and was not told they were approving a change/);
  });

  it('shows the approval date as derived rather than as typed', () => {
    assert.match(rendered, /Therefore approval is needed by/);
    assert.match(rendered, /derived from the two figures above, not typed/);
    // 1 September less 28 days.
    assert.match(rendered, /2027-08-04/);
  });

  it('carries the clause the submittal answers, and whether it is mandatory', () => {
    assert.match(rendered, /E10\/3\.2/);
    assert.match(rendered, /Mandatory — the clause says shall or must/);
  });
});

// ── Non-conformance ─────────────────────────────────────────────────────────

describe('documents · the NCR says what use-as-is actually means', () => {
  let rendered: string;

  before(() => {
    rendered = compose('NON_CONFORMANCE_REPORT', ncrId);
  });

  it('carries the disposition rather than only that it is closed', () => {
    assert.match(rendered, /Disposition/);
    assert.match(rendered, /Use as is/);
  });

  it('states in plain words that a departure has been accepted into the permanent works', () => {
    // The paragraph nobody wants to write, and the one the building owner needs.
    assert.match(rendered, /does not meet the specification and has been accepted into the permanent works/);
    assert.match(rendered, /Anybody relying on this project meeting its specification in this respect should read that reason/);
  });

  it('says when there is no recorded inspection behind it rather than implying there is', () => {
    assert.match(rendered, /raised directly rather than by a recorded inspection/);
  });
});

// ── As-built register ───────────────────────────────────────────────────────

describe('documents · the as-built register refuses to present a P-revision as as-built', () => {
  let rendered: string;

  before(() => {
    rendered = compose('AS_BUILT_REGISTER');
  });

  it('lists the file hash beside every drawing', () => {
    assert.match(rendered, /File hash/);
    assert.match(rendered, /sha256:/);
  });

  it('names the drawings still at a preliminary revision', () => {
    assert.match(rendered, /Drawings still at a preliminary revision/);
    assert.match(rendered, /not a complete as-built record/);
  });

  it('does not claim every model held is an as-built model', () => {
    assert.match(rendered, /Models held against this project/);
    assert.match(rendered, /recorded as as-built/);
    assert.equal(rendered.includes('Models forming part of the as-built record'), false);
  });
});

// ── O&M manual ──────────────────────────────────────────────────────────────

describe('documents · the O&M manual crosses warranties against open defects', () => {
  let rendered: string;

  before(() => {
    rendered = compose('OM_MANUAL');
  });

  it('lists the open defects against each warranty, which are two separate registers', () => {
    assert.match(rendered, /Open defects against it/);
    assert.match(rendered, /DEF-0001/);
  });

  it('does not call a warranty in force before it has commenced', () => {
    // Checking only the expiry date reported a warranty starting in 2027 as
    // currently in force. Both ends of the period are checked.
    assert.match(rendered, /does not commence until/);
  });

  it('gives the commissioning readings rather than a pass mark', () => {
    assert.match(rendered, /The readings themselves, not a pass mark/);
    assert.match(rendered, /Within tolerance/);
  });

  it('marks the extracted maintenance regime as extracted, with its confidence', () => {
    assert.match(rendered, /read from the supplied documentation by the platform, not transcribed by a person/);
  });

  it('states the replacement cost is a planning figure and not a quotation', () => {
    assert.match(rendered, /not a quotation/);
  });
});

// ── The refusal still governs the ten new types ─────────────────────────────

describe('documents · the ten new types refuse as loudly as the five original ones', () => {
  it('refuses a bill of quantities on a project with no measurement schedule', async () => {
    const bare = new Platform();
    const other = await seedDemoProject(bare);
    const catalogue = documents.documentCatalogue(
      bare.context(other.users.admin!.auth, other.projectId, { source: 'WEB' }),
    );
    const bill = catalogue.documents.find((document) => document.code === 'BILL_OF_QUANTITIES')!;
    assert.equal(bill.generable, false);
    assert.equal(bill.missing[0]?.refType, 'MeasurementSchedule');
    // Named, so the screen can say what to do rather than only that it cannot.
    assert.match(bill.missing[0]!.recordedBy, /screen/);
    assert.ok(bill.missing[0]!.contributes.length > 10);
  });

  it('sends people to a screen the console actually has', () => {
    // Found by rendering the documents screen. Four types said "the screen that
    // creates it", and several source bindings named screens the navigation has
    // never had — "the Quality screen", "the Delivery screen". A refusal that
    // sends somebody somewhere that does not exist is the same dead end as a
    // greyed-out button with no reason on it.
    const NAV_LABELS = new Set([
      'Project Command Centre', 'Copilot', 'Autopilot', 'Enterprise & Portfolio',
      'Programme', 'Field Execution', 'Design & BIM',
      'Pipeline & Bids', 'Cost & Value', 'Tender & Procurement', 'Change & Claims',
      'Project Control', 'Risk & Safety', 'Handover & O&M', 'Golden Thread', 'Site Documents', 'All commands',
      'ACU & Billing', 'Platform Admin', 'Newsletter', 'Communications', 'Account',
    ]);
    const named = (where: string): string[] =>
      [...where.matchAll(/the ([A-Z][^,.—]*?) screen/g)].map((match) => match[1]!.trim());

    for (const definition of documents.DOCUMENT_TYPES) {
      const places = [
        ...(definition.subjectRecordedBy ? named(definition.subjectRecordedBy) : []),
        ...definition.sources.flatMap((source) => named(source.recordedBy)),
      ];
      assert.ok(places.length > 0 || definition.sources.length === 0, `${definition.code} names no screen at all`);
      for (const place of places) {
        assert.ok(NAV_LABELS.has(place), `${definition.code} sends people to "${place}", which is not in the navigation`);
      }
    }
  });

  it('names where a record-scoped subject is created, rather than "the screen that creates it"', () => {
    for (const definition of documents.DOCUMENT_TYPES) {
      if (definition.scope !== 'RECORD') continue;
      assert.ok(definition.subjectRecordedBy, `${definition.code} does not say where its subject is recorded`);
    }
  });

  it('offers every record-scoped type the records there are to generate one against', () => {
    const catalogue = documents.documentCatalogue(asAdmin());
    const minutes = catalogue.documents.find((document) => document.code === 'MEETING_MINUTES')!;
    assert.equal(minutes.generable, true);
    assert.equal(minutes.subjects.length, 1);
    assert.match(minutes.subjects[0]!.label, /^PROGRESS-\d{3}$/);
  });
});
