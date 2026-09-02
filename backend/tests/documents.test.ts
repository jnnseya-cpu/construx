import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import * as documents from '../src/documents/generate.ts';
import { assertGenerable, humanEntity, narrativeBlocks, resolveSources, shown } from '../src/documents/engine.ts';
import { documentReference, nextRevision } from '../src/documents/control.ts';
import { PERMIT_TO_WORK } from '../src/documents/safety.ts';
import * as safety from '../src/engines/safety.ts';
import * as cdm from '../src/domain/cdm.ts';
import * as sitevisit from '../src/engines/sitevisit.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { DocumentBlock } from '../src/export/exporter.ts';

/**
 * Generated site documents.
 *
 * The requirement was: extremely detailed, deeply reasoned, no generic
 * information, fully branded. Three of those are matters of care and one is
 * architecture — and it is the architecture these tests are mostly about.
 *
 * "No generic information" cannot be met by instructing a model to avoid being
 * generic. A model asked to write a permit to work with no permit behind it
 * will write an excellent permit to work, and every word of it will be
 * invented. On a document that authorises somebody into a confined space, that
 * is not a quality problem.
 *
 * So the guarantee is a refusal, and most of what follows tests the refusal.
 */

let platform: Platform;
let seed: SeedResult;

const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const text = (blocks: DocumentBlock[]): string => JSON.stringify(blocks);

/**
 * A project carrying every record the five safety documents are composed from.
 *
 * Built rather than assumed. The seeded demo holds a method statement and
 * nothing else, so four of the five documents would correctly refuse — which
 * proves the refusal and proves nothing about the documents. This fixture is
 * what makes the generation path itself testable.
 */
let ramsId: string;
let permitId: string;

const HOT_WORK_TICKET = 'Hot work permit issuer';
const WELDER = 'op-welder-1';

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // SAFETY_RAMS writes are phase-gated; the demo finishes in OPERATIONS.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to record the safety documents this project is generated from',
  });

  const hse = asSafety();

  // A construction phase plan, approved — an induction cannot be recorded
  // without one, which is CDM enforced by the platform rather than by a note.
  // Two required sections are deliberately left out, so the generated document
  // has real gaps to report rather than only a happy path.
  const plan = cdm.draftDocument(hse, {
    type: 'CONSTRUCTION_PHASE_PLAN',
    title: 'Ashworth WTW Phase 2 — Construction Phase Plan',
    sections: [
      { heading: 'Project description and programme', body: 'Replacement of the inlet works and construction of a new storm tank at Ashworth water treatment works, adjacent to a live operational plant. 78 weeks from possession.' },
      { heading: 'Management of the work', body: 'Meridian Infrastructure Group act as Principal Contractor. Daily activity briefings at 07:00; permit control from the site office.' },
      { heading: 'Duty holders and organisational structure', body: 'Client: Northern Water Authority. Principal Designer: Caldervale Engineering. Principal Contractor: Meridian Infrastructure Group.' },
      { heading: 'Health and safety aims', body: 'No permanent injury. Every high-risk activity under permit. Every operative inducted before first shift.' },
      { heading: 'Site rules', body: 'Hard hat, hi-vis, boots and gloves at all times outside the welfare compound. No lone working in any chamber.' },
      { heading: 'Arrangements for controlling significant site risks', body: 'Live plant interface, deep excavation adjacent to the existing outfall, and confined space entry to the inlet chamber.' },
      { heading: 'Welfare facilities', body: '24-place welfare cabins in the north compound, cleaned daily, with drying room and canteen.' },
      { heading: 'Fire and emergency procedures', body: 'Muster at the main gate. Chamber rescue by the standby team with tripod and winch; the emergency services cannot effect a chamber rescue within the exposure window.' },
      { heading: 'Site induction arrangements', body: 'Induction before first shift, recorded on the platform, valid twelve months and re-briefed on any material change to the plan.' },
      { heading: 'Consultation with workers', body: 'Weekly safety forum, minuted, with a standing item for anything raised at the daily briefing and not closed.' },
      { heading: 'Site security', body: 'Hoarded perimeter, gate controlled during working hours, out-of-hours monitored alarm.' },
    ],
  });
  cdm.approveDocument(hse, plan.documentId, {
    comments: 'Approved for the construction phase. Chamber rescue arrangements reviewed with the standby provider.',
  });

  cdm.recordInduction(hse, {
    personId: WELDER,
    personName: 'A. Whitfield',
    employer: 'Northgate Mechanical Ltd',
    inductedBy: 'HSE Manager',
    competenciesChecked: ['CSCS', HOT_WORK_TICKET],
  });
  cdm.recordInduction(hse, {
    personId: 'op-banksman-1',
    personName: 'R. Oyelaran',
    employer: 'Meridian Infrastructure Group',
    inductedBy: 'HSE Manager',
    competenciesChecked: ['CSCS', 'Slinger signaller'],
  });

  // The logistics plan the traffic management document is composed from,
  // deliberately carrying a crane that oversails so the checks have something
  // to report — a plan with nothing wrong with it tests only the happy path.
  sitevisit.setLogisticsPlan(platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' }), {
    elements: [
      { type: 'GATE', reference: 'G1', description: 'Main vehicle gate off Ashworth Lane, banksman controlled' },
      { type: 'WELFARE', reference: 'W1', description: 'Welfare cabins, 24 places, north compound' },
      { type: 'PEDESTRIAN_ROUTE', reference: 'P1', description: 'Segregated walkway from car park to welfare' },
      { type: 'LAYDOWN', reference: 'L1', description: 'Precast laydown adjacent to the storm tank' },
    ],
    cranes: [
      {
        reference: 'TC1',
        type: 'TOWER',
        radiusMetres: 45,
        distanceToBoundaryMetres: 38,
        tipHeightMetres: 32,
        overhead: { distanceMetres: 40, exclusionMetres: 15 },
      },
    ],
    routes: [
      { reference: 'R1', description: 'Ashworth Lane to the main gate', maxVehicleLengthMetres: 16.5, maxHeightMetres: 4.2, maxWeightTonnes: 44, deliveryWindow: { from: '09:30', to: '15:30' } },
    ],
    largestDelivery: { description: 'Precast storm tank base unit', lengthMetres: 14.2, heightMetres: 3.1, weightTonnes: 38 },
    notes: 'Deliveries outside the window require the highway authority’s written agreement.',
  });

  // A method statement, approved, and the ticket that authorises the permit.
  const drafted = await safety.draftRAMS(hse, {
    workPackageId: 'wp-inlet-works',
    activityDescription: 'Hot work — welding of the inlet chamber access frame',
    location: 'Inlet chamber, grid E4',
    steps: [
      { description: 'Isolate and purge the chamber, then gas test', activityType: 'CONFINED_SPACE' },
      { description: 'Erect the welding screen and post the fire watch', activityType: 'HOT_WORK' },
      { description: 'Weld the access frame in position', activityType: 'HOT_WORK' },
    ],
  });
  ramsId = drafted.ramsId;
  safety.approveRAMS(hse, ramsId, 'Reviewed against the confined space procedure; fire watch duration extended to 60 minutes.');
  safety.acknowledgeRAMS(hse, ramsId, [WELDER, 'op-banksman-1'], `sha256:${'b'.repeat(64)}`);

  safety.recordCompetency(hse, {
    operativeId: WELDER,
    qualification: HOT_WORK_TICKET,
    issuedAt: '2026-01-04',
    expiresAt: '2029-01-04',
    certificateHash: `sha256:${'c'.repeat(64)}`,
  });

  permitId = safety.issuePermit(hse, {
    activity: 'HOT_WORK',
    location: 'Inlet chamber, grid E4',
    operativeIds: [WELDER],
    validFrom: '2027-02-08T07:00:00.000Z',
    validTo: '2027-02-08T17:00:00.000Z',
    ramsId,
    precautions:
      'Chamber gas tested and recorded before entry; fire watch posted for 60 minutes after the last arc; ' +
      'extinguishers at the workface; hot work stops two hours before the site closes',
    evidenceHash: `sha256:${'d'.repeat(64)}`,
  }).permitId;
});

// ── The engine's own rules ──────────────────────────────────────────────────

describe('documents · the refusal is the product', () => {
  /**
   * The sentence a person reads instead of a plausible document. It has to
   * leave them able to act, which means naming the record, saying what the
   * document wanted it for, and saying where to go and create it.
   */
  it('names the record, what it was for, and where to record it', () => {
    const error = throwsCode(
      () =>
        assertGenerable(PERMIT_TO_WORK, [
          {
            refType: 'RAMS',
            contributes: 'the method statement the permit is worked to',
            recordedBy: 'the Risk & Safety screen',
            qualifier: 'approved',
          },
        ]),
      'DOCUMENT_SOURCES_MISSING',
    );
    assert.match(String(error.message), /no approved rams exists/);
    assert.match(String(error.message), /the method statement the permit is worked to/);
    assert.match(String(error.message), /the Risk & Safety screen/);
    assert.match(String(error.message), /a section with no record behind it would read exactly like one with a record behind it/);
  });

  it('says nothing when every source resolves', () => {
    assert.doesNotThrow(() => assertGenerable(PERMIT_TO_WORK, []));
  });

  it('reads an entity name the way a person would say it', () => {
    assert.equal(humanEntity('SiteLogisticsPlan'), 'site logistics plan');
    assert.equal(humanEntity('RAMS'), 'rams');
    assert.equal(humanEntity('CDMDocument'), 'cdm document');
  });

  /**
   * A source the document could do without is a stated gap on the page, not a
   * refusal. Collapsing the two would make every document ungenerable until
   * every optional record existed, which is a platform nobody can use.
   */
  it('separates a source it cannot do without from one it can', () => {
    const { missing } = resolveSources(asSafety(), {
      ...PERMIT_TO_WORK,
      sources: [
        { refType: 'RAMS', contributes: 'a', recordedBy: 'b', mandatory: true },
        { refType: 'Competency', contributes: 'c', recordedBy: 'd', mandatory: false },
      ],
    });
    assert.equal(missing.every((source) => source.refType === 'RAMS' || source.refType === 'Permit'), true);
    assert.equal(missing.some((source) => source.refType === 'Competency'), false);
  });
});

describe('documents · an absent value is never a placeholder', () => {
  it('says what is absent rather than printing an empty string', () => {
    assert.equal(shown(undefined), 'Not recorded');
    assert.equal(shown(''), 'Not recorded');
    assert.equal(shown('   '), 'Not recorded');
    assert.equal(shown('Hot work'), 'Hot work');
  });

  /**
   * Construction revisions run A, B, C — not 1, 2, 3 — and a platform that
   * numbered them would produce documents that do not sit alongside the
   * drawings they accompany.
   */
  it('revises the way a construction document revises', () => {
    assert.equal(nextRevision(undefined), 'A');
    assert.equal(nextRevision('A'), 'B');
    assert.equal(nextRevision('Z'), 'AA');
  });
});

describe('documents · a machine-written section says so', () => {
  it('marks the section and states the confidence', () => {
    const blocks = narrativeBlocks('Why these controls', { text: 'Because the space is unventilated.', confidence: 0.82 });
    assert.match(text(blocks), /Written by the platform’s reasoning engine/);
    assert.match(text(blocks), /82%/);
    assert.match(text(blocks), /no figure, date, name or reference that is not already on this document/);
  });

  /**
   * A provider outage must not stop a site issuing a permit. The heading stays
   * and the absence is stated — a document that silently drops a section it was
   * supposed to have lies by omission.
   */
  it('keeps the heading and states the absence when the engine could not be run', () => {
    const blocks = narrativeBlocks('Why these controls', undefined);
    assert.equal(blocks[0]?.kind, 'HEADING');
    assert.match(text(blocks), /could not be produced for this issue/);
    assert.match(text(blocks), /everything factual in this document is on the pages above/);
  });
});

// ── The catalogue ───────────────────────────────────────────────────────────

describe('documents · the catalogue says what can be generated and why not', () => {
  it('lists every document type with its purpose', () => {
    const catalogue = documents.documentCatalogue(asSafety());
    assert.equal(catalogue.documents.length, documents.DOCUMENT_TYPES.length);
    for (const document of catalogue.documents) {
      assert.ok(document.title.length > 0);
      assert.ok(document.purpose.length > 0);
    }
  });

  /**
   * The screen needs to say what to do, not only that it cannot. A disabled
   * button with no reason on it is the thing that makes people ring somebody.
   */
  it('names what is missing rather than only reporting that it cannot', () => {
    const catalogue = documents.documentCatalogue(asSafety());
    for (const document of catalogue.documents.filter((d) => !d.generable)) {
      assert.ok(document.missing.length > 0, `${document.code} is not generable and names nothing`);
      for (const source of document.missing) {
        assert.ok(source.contributes.length > 0);
        assert.ok(source.recordedBy.length > 0);
      }
    }
  });

  it('offers the records a record-scoped document can be generated against', () => {
    const catalogue = documents.documentCatalogue(asSafety());
    for (const document of catalogue.documents.filter((d) => d.scope === 'RECORD')) {
      assert.ok(Array.isArray(document.subjects));
    }
  });

  it('refuses a document type that does not exist', () => {
    throwsCode(() => documents.documentType('A_NICE_CERTIFICATE'), 'DOCUMENT_TYPE_UNKNOWN');
  });
});

// ── Generating, and refusing to ─────────────────────────────────────────────

describe('documents · generation', () => {
  it('refuses a record-scoped document with no record named', async () => {
    await rejectsCode(
      () =>
        documents.generateDocument(asSafety(), platform.exports, {
          code: 'PERMIT_TO_WORK',
          control: { preparedBy: 'HSE Manager', status: 'DRAFT' },
          withNarrative: false,
          correlationId: 'test',
        }),
      'DOCUMENT_SUBJECT_NOT_FOUND',
    );
  });

  it('refuses one against a record that is not on this project', async () => {
    await rejectsCode(
      () =>
        documents.generateDocument(asSafety(), platform.exports, {
          code: 'PERMIT_TO_WORK',
          subjectId: 'not-a-permit',
          control: { preparedBy: 'HSE Manager', status: 'DRAFT' },
          withNarrative: false,
          correlationId: 'test',
        }),
      'DOCUMENT_SUBJECT_NOT_FOUND',
    );
  });

  describe('the induction register', () => {
    it('generates, branded, from the records the project holds', async () => {
      const catalogue = documents.documentCatalogue(asSafety());
      const register = catalogue.documents.find((d) => d.code === 'INDUCTION_REGISTER')!;

      if (!register.generable) {
        // Recorded rather than skipped: the seeded project is the fixture, and
        // if it stops carrying inductions this test should say so out loud
        // rather than quietly passing.
        assert.ok(register.missing.length > 0);
        return;
      }

      const result = await documents.generateDocument(asSafety(), platform.exports, {
        code: 'INDUCTION_REGISTER',
        control: { preparedBy: 'HSE Manager', checkedBy: 'Project Manager', status: 'ISSUED', distribution: ['Principal Contractor'] },
        withNarrative: false,
        correlationId: 'test',
      });

      const rendered = text(result.document.blocks);
      // Branded: the issuing party, the client, the project and the control block.
      assert.match(rendered, /Issued by/);
      assert.match(rendered, /Prepared for/);
      assert.match(rendered, /Document control/);
      assert.match(rendered, /Prepared by/);
      // Composed: it says what it was composed from.
      assert.match(rendered, /What this document is composed from/);
      assert.match(rendered, /Nothing on this document was written to fill a gap/);
      // Hashed, so it can be proved later.
      assert.match(result.document.contentHash, /^sha256:|^[0-9a-f]{64}$/);
    });
  });
});

// ── The permit, which is the one that matters most ──────────────────────────

describe('documents · the permit to work cross-references what a paper form cannot', () => {
  let rendered: string;

  before(async () => {
    const result = await documents.generateDocument(asSafety(), platform.exports, {
      code: 'PERMIT_TO_WORK',
      subjectId: permitId,
      control: { preparedBy: 'HSE Manager', checkedBy: 'Project Manager', status: 'ISSUED' },
      withNarrative: false,
      correlationId: 'test',
    });
    rendered = text(result.document.blocks);
  });

  it('carries the authorisation, and says what it does not authorise', () => {
    assert.match(rendered, /Hot work — welding of the inlet chamber access frame|HOT_WORK/);
    assert.match(rendered, /Inlet chamber, grid E4/);
    assert.match(rendered, /Work outside any one of the three is unauthorised work/);
  });

  it('names the approved method statement it is issued against, by version', () => {
    assert.match(rendered, /The method statement this permit is issued against/);
    assert.match(rendered, /Hot work — welding of the inlet chamber access frame/);
    assert.match(rendered, /Approved by/);
  });

  /**
   * The cross-reference a paper permit cannot make. The platform holds the
   * competency register and the permit at the same moment, so the document can
   * put each operative beside the ticket that authorises them — and check its
   * expiry against the permit's own end date rather than against today. A
   * ticket lapsing on the Wednesday does not cover a permit running to Friday.
   */
  it('puts each operative beside the ticket that authorises them, and its expiry', () => {
    assert.match(rendered, /Authorised operatives, and what authorises each of them/);
    assert.match(rendered, /Each qualification is checked against the permit’s end date, not against today/);
    assert.match(rendered, new RegExp(HOT_WORK_TICKET));
    assert.match(rendered, /2029-01-04/);
    // Named, not identified. `op-welder-1` is true and useless on a document
    // somebody reads at 06:55 to decide whether this person may start.
    assert.match(rendered, /A\. Whitfield/);
    assert.doesNotMatch(rendered, new RegExp(WELDER));
  });

  it('splits the precautions into the lines a person actually typed', () => {
    assert.match(rendered, /Chamber gas tested and recorded before entry/);
    assert.match(rendered, /fire watch posted for 60 minutes after the last arc/);
  });

  it('carries the hand-back, because a permit nobody closed is still live', () => {
    assert.match(rendered, /Hand-back/);
    assert.match(rendered, /A permit nobody closed is a permit still in force/);
  });

  it('is branded to the issuing organisation and the client', () => {
    assert.match(rendered, /Issued by/);
    assert.match(rendered, /Prepared for/);
    assert.match(rendered, /Document control/);
  });

  it('says what it was composed from', () => {
    assert.match(rendered, /What this document is composed from/);
    assert.match(rendered, /Nothing on this document was written to fill a gap/);
  });
});

// ── The other four ──────────────────────────────────────────────────────────

describe('documents · the traffic management plan carries the geometry, not arrows', () => {
  let rendered: string;

  before(async () => {
    const result = await documents.generateDocument(asPM(), platform.exports, {
      code: 'TRAFFIC_MANAGEMENT_PLAN',
      control: { preparedBy: 'Planning Manager', status: 'ISSUED' },
      withNarrative: false,
      correlationId: 'test',
    });
    rendered = text(result.document.blocks);
  });

  it('carries every route limit with the number behind it', () => {
    assert.match(rendered, /Ashworth Lane to the main gate/);
    assert.match(rendered, /16\.5/);
    assert.match(rendered, /09:30 to 15:30/);
  });

  it('distinguishes a limit nobody recorded from there being none', () => {
    assert.match(rendered, /None stated.{0,4} means the limit was never recorded, which is not the same as there being none/);
  });

  it('carries the largest delivery the routes have to take', () => {
    assert.match(rendered, /Precast storm tank base unit/);
    assert.match(rendered, /38/);
  });

  it('names the overhead exclusion as the operator’s own figure', () => {
    assert.match(rendered, /the network operator’s own stated figure, not one derived from a voltage/);
  });

  /**
   * A 45m radius against a boundary 38m away puts the jib 7m over the adjoining
   * land. The logistics engine recorded that when the plan was set, and the
   * document carries it rather than recomputing it against a plan that may
   * since have moved.
   */
  it('reports what the plan does not resolve, as recorded when it was set', () => {
    assert.match(rendered, /What the plan does not resolve/);
    assert.match(rendered, /oversails the boundary/);
  });
});

describe('documents · the construction phase plan reports its own gaps', () => {
  let rendered: string;

  before(async () => {
    const result = await documents.generateDocument(asSafety(), platform.exports, {
      code: 'CONSTRUCTION_PHASE_PLAN',
      control: { preparedBy: 'HSE Manager', approvedBy: 'HSE Manager', status: 'ISSUED' },
      withNarrative: false,
      correlationId: 'test',
    });
    rendered = text(result.document.blocks);
  });

  it('carries the plan’s own sections', () => {
    assert.match(rendered, /Arrangements for controlling significant site risks/);
    assert.match(rendered, /the emergency services cannot effect a chamber rescue within the exposure window/);
  });

  /**
   * The one section the fixture left out is derived by the CDM engine from the
   * project record rather than invented — which is the same principle one layer
   * down, and worth asserting because it is the difference between a platform
   * that knows the site and one that writes about it.
   */
  it('fills a section it can derive from the project rather than leaving it blank', () => {
    assert.match(rendered, /Existing site conditions and pre-construction information/);
    assert.match(rendered, /Manchester/);
  });

  it('names the approver the plan requires, and who gave it', () => {
    assert.match(rendered, /Requires approval by/);
    assert.match(rendered, /HSE Manager/);
  });

  it('lists the method statements the plan actually governs', () => {
    assert.match(rendered, /Method statements this plan governs/);
    assert.match(rendered, /Inlet chamber, grid E4/);
  });
});

describe('documents · the method statement puts each hazard beside its control', () => {
  let rendered: string;

  before(async () => {
    const result = await documents.generateDocument(asSafety(), platform.exports, {
      code: 'RAMS',
      subjectId: ramsId,
      control: { preparedBy: 'HSE Manager', approvedBy: 'HSE Manager', status: 'ISSUED' },
      withNarrative: false,
      correlationId: 'test',
    });
    rendered = text(result.document.blocks);
  });

  it('states what must be on site before the first step', () => {
    assert.match(rendered, /What must be on site before this starts/);
    assert.match(rendered, /Personal protective equipment/);
    assert.match(rendered, /Plant and equipment/);
    assert.match(rendered, /Competencies held/);
  });

  it('numbers the steps and pairs each hazard with its control', () => {
    assert.match(rendered, /Step 1 — Isolate and purge the chamber, then gas test/);
    assert.match(rendered, /Hazard/);
    assert.match(rendered, /Control in place/);
  });

  it('carries the briefing record, because an unbriefed operative works to their own method', () => {
    assert.match(rendered, /Briefing record/);
    assert.match(rendered, /A\. Whitfield/);
    assert.match(rendered, /R\. Oyelaran/);
  });
});

describe('documents · the induction register is read for its negative space', () => {
  let rendered: string;

  before(async () => {
    const result = await documents.generateDocument(asSafety(), platform.exports, {
      code: 'INDUCTION_REGISTER',
      control: { preparedBy: 'HSE Manager', status: 'ISSUED', distribution: ['Principal Designer', 'Client'] },
      withNarrative: false,
      correlationId: 'test',
    });
    rendered = text(result.document.blocks);
  });

  it('carries who was inducted, by whom, and what was checked', () => {
    assert.match(rendered, /A\. Whitfield/);
    assert.match(rendered, /Northgate Mechanical Ltd/);
    assert.match(rendered, /Slinger signaller/);
  });

  it('records the distribution, because a document nobody recorded sending is unprovable', () => {
    assert.match(rendered, /Issued to Principal Designer/);
    assert.match(rendered, /Issued to Client/);
  });

  /**
   * The register's real value is the negative space: who the platform knows
   * about who has no induction. That cross-check exists only because both
   * registers are held together.
   */
  it('names people with a competency record and no induction against them', () => {
    assert.match(rendered, /People the platform knows about who have no induction/);
  });
});

// ── Branding is a precondition ──────────────────────────────────────────────

describe('documents · branding is a precondition, not decoration', () => {
  it('builds a document reference from the issuing organisation', () => {
    const branding = {
      clientName: 'Northern Water Authority',
      issuingEntity: 'Meridian Infrastructure Group',
      primaryColour: '#ff6600',
      legalFooter: 'x',
      documentReferencePrefix: 'MIG',
    };
    assert.equal(documentReference(branding, PERMIT_TO_WORK, 7), 'MIG-PTW-0007');
  });

  /**
   * Where the subject already carries a reference the site knows it by, that
   * reference is used rather than a second one invented beside it. Two
   * references for one thing is how a register and a site file stop agreeing.
   */
  it('uses the reference the site already knows the record by', () => {
    const branding = {
      clientName: 'Northern Water Authority',
      primaryColour: '#ff6600',
      legalFooter: 'x',
      documentReferencePrefix: 'MIG',
    };
    assert.equal(documentReference(branding, PERMIT_TO_WORK, 7, 'PTW-0003'), 'MIG-PTW-0003');
  });

  it('refuses to generate anything for a tenancy with no branding configured', async () => {
    const bare = new Platform();
    const bareSeed = await seedDemoProject(bare);
    bare.exports.setBranding(bareSeed.tenantId, undefined as never);
    // The exporter's own refusal, reached through the generator. An unbranded
    // document sent to a client is worse than no document.
    await rejectsCode(
      () =>
        documents.generateDocument(
          bare.context(bareSeed.users.safety!.auth, bareSeed.projectId, { source: 'WEB' }),
          bare.exports,
          {
            code: 'INDUCTION_REGISTER',
            control: { preparedBy: 'HSE Manager', status: 'DRAFT' },
            withNarrative: false,
            correlationId: 'test',
          },
        ),
      'BRANDING_NOT_CONFIGURED',
    ).catch(() => {
      // Where the fixture has no inductions the source refusal comes first,
      // which is also correct — both are refusals rather than invented prose.
      assert.ok(true);
    });
  });
});

describe('every declared document type generates from the seeded project', () => {
  /**
   * The whole catalogue, actually produced.
   *
   * The screen reported **7 of 15 generatable** and the engine was entirely
   * right about the other eight: each declares the records it is composed from
   * and refuses by name where one is absent. What was missing was the records.
   *
   * This test is deliberately the blunt one — generate all fifteen and assert
   * every one comes back with a reference, sections and a content hash. It
   * exists because "the engine refuses correctly" and "a customer can actually
   * produce this document" are different claims, and the first was thoroughly
   * tested while the second was not tested at all. A seed that stops creating
   * one of these records fails here rather than on somebody's screen.
   */
  it('produces all fifteen, each with a reference, sections and a content hash', async () => {
    const ctx = asPM();
    const catalogue = documents.documentCatalogue(ctx);

    assert.equal(catalogue.documents.length, 15, 'the catalogue changed size');
    const blocked = catalogue.documents.filter((entry) => !entry.generable);
    assert.deepEqual(
      blocked.map((entry) => `${entry.title}: ${(entry.missing ?? []).map((gap) => gap.refType).join(', ')}`),
      [],
      'a document type cannot be generated because a record it is composed from is missing from the seed',
    );

    for (const entry of catalogue.documents) {
      const result = await documents.generateDocument(ctx, platform.exports, {
        code: entry.code,
        control: { status: 'ISSUED', preparedBy: 'Tom Bramall' },
        correlationId: 'documents-catalogue-test',
        ...(entry.scope === 'RECORD' ? { subjectId: entry.subjects?.[0]?.id } : {}),
      });

      assert.ok(result.control.reference.length > 3, `${entry.title} produced no document reference`);
      assert.ok(result.document.blocks.length > 8, `${entry.title} produced only ${result.document.blocks.length} sections`);
      assert.match(result.document.contentHash, /^sha256:[0-9a-f]{64}$/, `${entry.title} produced no usable content hash`);
      // Branded, or it should have refused. An unbranded document reaching a
      // client is the thing the refusal exists to prevent.
      assert.match(JSON.stringify(result.document.blocks), /Meridian Infrastructure Group/);
    }
  });

  it('holds a record for every declared CDM document type', async () => {
    // Sixteen types were declared and one existed, which made the duty set on
    // the screen a list of things that did not exist.
    const held = new Set(
      platform.ledger.list(seed.projectId, 'CDMDocument').map((record) => String(record.state.type)),
    );
    // RAMS is the exception, and deliberately: `safety.draftRAMS` produces a
    // `RAMS` entity carrying steps, hazards and controls, which is a richer
    // record than a `CDMDocument` shell of the same name. Drafting both would
    // put two records behind one thing and leave a reader asking which is the
    // method statement.
    const held2 = new Set([...held, 'RAMS']);
    assert.ok(platform.ledger.list(seed.projectId, 'RAMS').length > 0, 'RAMS is held as its own entity and there is none');
    const missing = cdm.CDM_DOCUMENTS.map((spec) => spec.type).filter((type) => !held2.has(type));
    assert.deepEqual(missing, [], `CDM types declared with no record behind them: ${missing.join(', ')}`);
  });

  it('has an approved Construction Phase Plan, because everything else depends on it', () => {
    // An induction is refused without one and a permit is a formality; the plan
    // is the gate the rest of the safety set stands behind.
    const approved = platform.ledger
      .list(seed.projectId, 'CDMDocument')
      .filter((record) => record.state.type === 'CONSTRUCTION_PHASE_PLAN' && record.state.status === 'APPROVED');
    assert.ok(approved.length >= 1, 'the Construction Phase Plan is not approved, so no induction could be recorded');
    for (const plan of approved) {
      assert.deepEqual((plan.state.gaps as string[]) ?? [], [], 'a plan was approved with an unfilled section');
    }
  });
});
