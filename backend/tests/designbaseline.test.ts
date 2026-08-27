import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as constructability from '../src/domain/constructability.ts';
import * as designbaseline from '../src/domain/designbaseline.ts';
import * as designplan from '../src/domain/designplan.ts';
import * as enquiryModule from '../src/domain/enquiry.ts';
import * as structure from '../src/domain/structure.ts';
import * as stagegate from '../src/domain/stagegate.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * D-WF-08 — design cost, programme, compliance and the baseline, plus the 7.4
 * stage gate.
 *
 * What is tested is not that a package can be marked frozen. It is the four
 * failures that make a baseline worth having:
 *
 * A baseline that does not say what it froze. A partial freeze with no stated
 * boundary. A freeze that quietly goes stale when somebody revises a drawing.
 * And a tender priced on information the design stage has already left behind.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds A on DESIGN_INFORMATION: freezes and baselines. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
/** Holds C and U: plans and publishes. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds R only on design information. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let sequence = 0;

/**
 * A package with two published deliverables, ready to freeze.
 *
 * Built through `designplan.ts`'s own commands rather than written into the
 * ledger, so the fixture cannot drift from what the platform will accept.
 */
function publishedPackage(options: { interfaces?: boolean; publish?: boolean } = {}): {
  packageId: string;
  reference: string;
} {
  sequence += 1;
  const reference = `PKG-T${String(sequence).padStart(2, '0')}`;
  const { packageId } = designplan.createPackage(asPM(), {
    reference,
    title: `Test package ${sequence}`,
    discipline: 'CIVIL',
    zone: 'Inlet works',
    leadDesigner: 'D. Whyte',
    leadOrganisation: 'Caldervale Engineering',
  });

  for (const suffix of ['A', 'B']) {
    designplan.planDeliverable(asPM(), packageId, {
      reference: `${reference}-${suffix}`,
      title: `General arrangement ${suffix}`,
      kind: 'DRAWING',
      purpose: 'For construction',
      format: 'PDF',
      author: 'J. Mensah',
      checker: 'D. Whyte',
      approver: 'A. Okafor',
      acceptingParty: 'Northern Water Authority',
      dueBy: day(10),
      neededBy: day(40),
      neededFor: 'the civils enquiry',
      reviewDays: 10,
    });
  }

  if (options.interfaces) {
    designplan.recordInterface(asPM(), packageId, {
      reference: `${reference}-INT-1`,
      description: 'Duct entry through the wall at grid C4',
      withPackage: 'PKG-MEP',
      ourOwner: 'D. Whyte',
      theirOwner: 'S. Rahman',
      resolveBy: day(20),
    });
  }

  if (options.publish !== false) {
    for (const suffix of ['A', 'B']) {
      for (const to of ['SHARED', 'PUBLISHED'] as const) {
        designplan.advanceDeliverable(asPM(), packageId, { reference: `${reference}-${suffix}`, to });
      }
    }
  }

  return { packageId, reference };
}

function freeze(packageId: string, overrides: Record<string, unknown> = {}) {
  return designbaseline.freezePackage(asDesigner(), packageId, {
    scope: 'FULL',
    note: 'Every deliverable published and accepted; nothing open against it.',
    ...overrides,
  } as Parameters<typeof designbaseline.freezePackage>[2]);
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('D-WF-08 the register', () => {
  it('registers its two event types', () => {
    const frozen = lookupEventType('DESIGN_PACKAGE_FROZEN');
    assert.ok(frozen);
    assert.equal(frozen.entity, 'FrozenPackage');
    // FREEZE rather than UPDATE: a freeze is its own kind of act and the 7.4
    // gate's approval clause reads every APPROVE and FREEZE in the ledger.
    assert.equal(frozen.action, 'FREEZE');
    assert.equal(frozen.aiAllowed, false);

    const baseline = lookupEventType('DESIGN_BASELINE_APPROVED');
    assert.ok(baseline);
    assert.equal(baseline.entity, 'DesignBaseline');
    assert.equal(baseline.action, 'APPROVE');
    assert.equal(baseline.aiAllowed, false);
  });

  it('classifies both under design information', () => {
    assert.equal(classifyEntity('FrozenPackage')?.area, 'DESIGN_INFORMATION');
    assert.equal(classifyEntity('DesignBaseline')?.area, 'DESIGN_INFORMATION');
  });

  it('refuses a freeze from somebody who can only read', () => {
    const { packageId } = publishedPackage();
    throwsCode(
      () => designbaseline.freezePackage(asQS(), packageId, { scope: 'FULL', note: 'Freezing.' }),
      'ACCESS_DENIED',
    );
  });
});

describe('D-WF-08 a baseline says what it froze', () => {
  it('copies the exact revisions, suitabilities and acceptance records', () => {
    // AC-D-WF-08-01. "Design is frozen" without the revisions is worth nothing.
    const { packageId, reference } = publishedPackage();
    const result = freeze(packageId);
    assert.equal(result.deliverables, 2);
    assert.match(result.reference, new RegExp(`^BL-${reference}-\\d{2}$`));

    const readiness = designbaseline.packageReadiness(asDesigner(), reference);
    assert.equal(readiness.frozen, true);
    assert.equal(readiness.ready, true);

    const position = designbaseline.designBaselinePosition(asDesigner());
    const entry = position.freezes.find((freezeRow) => freezeRow.reference === result.reference)!;
    assert.equal(entry.deliverables, 2);
    assert.equal(entry.scope, 'FULL');
  });

  it('refuses to freeze work in progress', () => {
    // The failure the whole step exists to prevent.
    const { packageId } = publishedPackage({ publish: false });
    throwsCode(() => freeze(packageId), 'NOT_PUBLISHED');
  });

  it('refuses a freeze over nothing', () => {
    sequence += 1;
    const { packageId } = designplan.createPackage(asPM(), {
      reference: `PKG-EMPTY${sequence}`,
      title: 'Nothing planned yet',
      discipline: 'CIVIL',
      zone: 'Inlet works',
      leadDesigner: 'D. Whyte',
      leadOrganisation: 'Caldervale Engineering',
    });
    throwsCode(() => freeze(packageId), 'NOTHING_TO_FREEZE');
  });

  it('refuses an unexplained freeze', () => {
    const { packageId } = publishedPackage();
    throwsCode(() => freeze(packageId, { note: '   ' }), 'FREEZE_UNEXPLAINED');
  });

  it('refuses a deliverable the package does not have', () => {
    const { packageId } = publishedPackage();
    throwsCode(() => freeze(packageId, { deliverableRefs: ['NOT-A-THING'] }), 'DELIVERABLE_NOT_FOUND');
  });
});

describe('D-WF-08 a partial freeze needs a boundary and its interfaces checked', () => {
  it('refuses a partial freeze with no stated boundary', () => {
    // Without one, two halves of a package carry the same reference.
    const { packageId, reference } = publishedPackage();
    throwsCode(
      () => freeze(packageId, { scope: 'PARTIAL', deliverableRefs: [`${reference}-A`] }),
      'BOUNDARY_REQUIRED',
    );
  });

  it('refuses a partial freeze whose open interfaces nobody has looked at', () => {
    const { packageId, reference } = publishedPackage({ interfaces: true });
    throwsCode(
      () =>
        freeze(packageId, {
          scope: 'PARTIAL',
          boundary: 'The inlet channel only, up to the wall at grid C4.',
          deliverableRefs: [`${reference}-A`],
        }),
      'INTERFACE_UNCHECKED',
    );
  });

  it('refuses a check with nobody behind it', () => {
    const { packageId, reference } = publishedPackage({ interfaces: true });
    throwsCode(
      () =>
        freeze(packageId, {
          scope: 'PARTIAL',
          boundary: 'The inlet channel only.',
          deliverableRefs: [`${reference}-A`],
          interfaceChecks: [
            { reference: `${reference}-INT-1`, withPackage: 'PKG-MEP', finding: 'Fine', checkedBy: '' },
          ],
        }),
      'INTERFACE_CHECK_EMPTY',
    );
  });

  it('takes a partial freeze with all three, and gives it its own reference', () => {
    const { packageId, reference } = publishedPackage({ interfaces: true });
    const result = freeze(packageId, {
      scope: 'PARTIAL',
      boundary: 'The inlet channel only, up to the wall at grid C4. The pumping chamber is excluded.',
      deliverableRefs: [`${reference}-A`],
      interfaceChecks: [
        {
          reference: `${reference}-INT-1`,
          withPackage: 'PKG-MEP',
          finding: 'The duct entry sits outside the frozen boundary; nothing inside it depends on the MEP position.',
          checkedBy: 'D. Whyte',
        },
      ],
    });
    assert.equal(result.deliverables, 1);

    const readiness = designbaseline.packageReadiness(asDesigner(), reference);
    assert.equal(readiness.scope, 'PARTIAL');
    assert.match(readiness.boundary ?? '', /pumping chamber is excluded/);
    // The unfrozen half is reported rather than silently absent.
    assert.deepEqual(readiness.notInFreeze, [`${reference}-B`]);
  });
});

describe('D-WF-08 a critical finding blocks the affected baseline', () => {
  it('refuses to freeze over an open access or testability finding', () => {
    // The specification's second exception control, answered by reusing
    // D-WF-07's own rule rather than re-deriving it.
    const { packageId, reference } = publishedPackage();
    const { reviewId } = constructability.holdReview(asPM(), {
      packageReference: reference,
      zone: 'Inlet works',
      heldAt: day(-2),
      attendees: [
        { name: 'A. Okafor', organisation: 'Meridian Infrastructure Group', discipline: 'CONSTRUCTION' },
        { name: 'D. Whyte', organisation: 'Caldervale Engineering', discipline: 'DESIGN' },
        { name: 'M. Osei', organisation: 'Meridian Infrastructure Group', discipline: 'HSE' },
        { name: 'R. Sandhu', organisation: 'Northern Water Authority', discipline: 'OPERATIONS' },
      ],
    });
    constructability.recordFinding(asPM(), reviewId, {
      area: 'ACCESS',
      severity: 'CRITICAL',
      what: 'There is no safe access to the valve chamber for the pressure test.',
      location: 'Inlet chamber, grid B2',
      raisedBy: 'A. Okafor',
      disposition: 'DESIGN_CHANGE',
      rationale: 'No sequence resolves it; the chamber needs a second opening.',
      owner: 'D. Whyte',
      by: day(14),
    });

    const refusal = throwsCode(() => freeze(packageId), 'BASELINE_BLOCKED');
    assert.match(refusal.message ?? '', /safe access/);

    // And the validation says so before anybody presses the button.
    const validation = designbaseline.validateDesignStage(asDesigner());
    const entry = validation.packages.find((row) => row.reference === reference)!;
    assert.equal(entry.mayFreeze, false);
    assert.equal(entry.mayFreezePartially, false);
    assert.match(entry.why, /critical or major constructability finding/);
  });
});

describe('D-WF-08 a later revision invalidates what depended on it', () => {
  it('reports a frozen package as stale once a deliverable moves', () => {
    // Derived on every read, never a stored flag — which is the only way the
    // answer can be honest the morning after somebody revises a drawing.
    const { packageId, reference } = publishedPackage();
    freeze(packageId);
    assert.equal(designbaseline.packageReadiness(asDesigner(), reference).ready, true);

    designplan.advanceDeliverable(asPM(), packageId, { reference: `${reference}-A`, to: 'ARCHIVED' });

    const readiness = designbaseline.packageReadiness(asDesigner(), reference);
    assert.equal(readiness.ready, false);
    assert.match(readiness.why, /was published and is now archived/);

    const position = designbaseline.designBaselinePosition(asDesigner());
    assert.ok(position.invalidated.some((entry) => entry.package === reference));
  });

  it('revalidates by re-freezing, and the earlier baseline stays readable', () => {
    const { packageId, reference } = publishedPackage();
    const first = freeze(packageId);
    designplan.advanceDeliverable(asPM(), packageId, { reference: `${reference}-A`, to: 'ARCHIVED' });

    const second = designbaseline.freezePackage(asDesigner(), packageId, {
      scope: 'PARTIAL',
      boundary: 'B only. A has been withdrawn and will be reissued under DC-0004.',
      deliverableRefs: [`${reference}-B`],
      note: 'Re-frozen after A was withdrawn.',
    });
    assert.equal(second.supersedes, first.reference);
    assert.equal(designbaseline.packageReadiness(asDesigner(), reference).ready, true);

    // The superseded freeze is still there, still holding what it saw.
    const position = designbaseline.designBaselinePosition(asDesigner());
    const earlier = position.freezes.find((entry) => entry.reference === first.reference)!;
    assert.equal(earlier.supersededBy, second.reference);
    assert.equal(earlier.deliverables, 2);
  });
});

describe('D-WF-08 the baseline', () => {
  it('approves over frozen packages and records what it rests on', () => {
    const { packageId, reference } = publishedPackage();
    const { freezeId } = freeze(packageId);
    const result = designbaseline.approveBaseline(asDesigner(), {
      reference: `DB-${reference}`,
      cutOff: day(0),
      freezeIds: [freezeId],
      snapshots: { costMinor: 4_200_000, costSource: `${reference}-A rev P05 and ${reference}-B rev P03`, programmeRef: 'PRG-04' },
      note: 'Design baseline for the civils enquiry.',
    });
    assert.deepEqual(result.packages, [reference]);
  });

  it('refuses a cost snapshot that cannot say what it was measured from', () => {
    // AC-D-WF-08-02. A figure with no source is the one the tender is built on.
    const { packageId, reference } = publishedPackage();
    const { freezeId } = freeze(packageId);
    throwsCode(
      () =>
        designbaseline.approveBaseline(asDesigner(), {
          reference: `DB-NOSRC-${reference}`,
          cutOff: day(0),
          freezeIds: [freezeId],
          snapshots: { costMinor: 900_000 },
          note: 'Baseline.',
        }),
      'COST_SOURCE_REQUIRED',
    );
  });

  it('refuses a baseline over nothing', () => {
    throwsCode(
      () =>
        designbaseline.approveBaseline(asDesigner(), {
          reference: 'DB-EMPTY',
          cutOff: day(0),
          freezeIds: [],
          snapshots: {},
          note: 'Baseline.',
        }),
      'BASELINE_EMPTY',
    );
  });

  it('refuses a baseline over a freeze a later one superseded', () => {
    const { packageId, reference } = publishedPackage();
    const first = freeze(packageId);
    freeze(packageId, { note: 'Re-frozen at the same revisions after a review.' });
    throwsCode(
      () =>
        designbaseline.approveBaseline(asDesigner(), {
          reference: `DB-OLD-${reference}`,
          cutOff: day(0),
          freezeIds: [first.freezeId],
          snapshots: {},
          note: 'Baseline.',
        }),
      'FREEZE_SUPERSEDED',
    );
  });

  it('refuses a baseline over a freeze the project has already left behind', () => {
    const { packageId, reference } = publishedPackage();
    const { freezeId } = freeze(packageId);
    designplan.advanceDeliverable(asPM(), packageId, { reference: `${reference}-A`, to: 'ARCHIVED' });
    throwsCode(
      () =>
        designbaseline.approveBaseline(asDesigner(), {
          reference: `DB-STALE-${reference}`,
          cutOff: day(0),
          freezeIds: [freezeId],
          snapshots: {},
          note: 'Baseline.',
        }),
      'BASELINE_STALE',
    );
  });

  it('refuses two baselines with one reference', () => {
    const { packageId, reference } = publishedPackage();
    const { freezeId } = freeze(packageId);
    const input = {
      reference: `DB-DUP-${reference}`,
      cutOff: day(0),
      freezeIds: [freezeId],
      snapshots: {},
      note: 'Baseline.',
    };
    designbaseline.approveBaseline(asDesigner(), input);
    throwsCode(() => designbaseline.approveBaseline(asDesigner(), input), 'BASELINE_REFERENCE_TAKEN');
  });

  it('refuses an unnamed or undated baseline', () => {
    const { packageId } = publishedPackage();
    const { freezeId } = freeze(packageId);
    throwsCode(
      () =>
        designbaseline.approveBaseline(asDesigner(), {
          reference: '  ',
          cutOff: day(0),
          freezeIds: [freezeId],
          snapshots: {},
          note: 'Baseline.',
        }),
      'BASELINE_UNNAMED',
    );
    throwsCode(
      () =>
        designbaseline.approveBaseline(asDesigner(), {
          reference: 'DB-NODATE',
          cutOff: 'soon',
          freezeIds: [freezeId],
          snapshots: {},
          note: 'Baseline.',
        }),
      'CUT_OFF_REQUIRED',
    );
  });
});

describe('D-WF-08 the stage validation', () => {
  it('names what is unpublished rather than counting it', () => {
    const { reference } = publishedPackage({ publish: false });
    const validation = designbaseline.validateDesignStage(asDesigner());
    const entry = validation.packages.find((row) => row.reference === reference)!;
    assert.equal(entry.notPublished.length, 2);
    assert.ok(entry.notPublished.every((name) => name.includes('wip')));
    // The partial route stays open — isolating the settled part is what it is
    // for — but there is nothing published to isolate yet.
    assert.equal(entry.mayFreeze, false);
    assert.equal(entry.mayFreezePartially, false);
  });

  it('separates evidence-backed compliance from pending opinion', () => {
    // Step 3 asks for exactly this. A single "verified" column hides which one
    // a consent actually rests on.
    const validation = designbaseline.validateDesignStage(asDesigner());
    assert.ok(Array.isArray(validation.compliance.evidenceBacked));
    assert.ok(Array.isArray(validation.compliance.pendingOpinion));
  });

  it('produces the tender readiness worklist as what is missing, by package', () => {
    const { reference } = publishedPackage({ publish: false });
    const validation = designbaseline.validateDesignStage(asDesigner());
    const entry = validation.tenderReadinessWorklist.find((row) => row.package === reference)!;
    assert.ok(entry.missing.length > 0);
  });

  it('is readable by a role that cannot freeze anything', () => {
    assert.ok(designbaseline.validateDesignStage(asQS()).packages.length > 0);
  });
});

describe('7.4 the design stage gate', () => {
  it('answers the same seven clauses as 8.4', () => {
    const report = stagegate.evaluateDesignGate(asPM());
    assert.deepEqual(
      report.clauses.map((clause) => clause.clause),
      [...stagegate.GATE_CLAUSE],
    );
  });

  it('never reports a clause it cannot assess as passed', () => {
    // The rule that matters more than any individual clause.
    const report = stagegate.evaluateDesignGate(asPM());
    for (const clause of report.clauses) {
      if (clause.state !== 'NOT_ASSESSABLE') continue;
      assert.ok(clause.blocking.length > 0, `${clause.clause} is unassessable but names nothing it cannot see`);
    }
    assert.equal(report.passed, report.failed.length === 0 && report.unassessable.length === 0);
  });

  it('names the three things the platform does not record against an AI output', () => {
    const report = stagegate.evaluateDesignGate(asPM());
    const ai = report.clauses.find((clause) => clause.clause === 'AI_ACCOUNTED')!;
    if (ai.state === 'NOT_ASSESSABLE') {
      assert.match(ai.detail, /assumptions/);
      assert.match(ai.detail, /prompt version/);
      assert.match(ai.detail, /human disposition/);
      // And it says which stage it is talking about.
      assert.match(ai.detail, /design stage/);
    }
  });

  it('fails inputs while nothing has been baselined', () => {
    const report = stagegate.evaluateDesignGate(asPM());
    const inputs = report.clauses.find((clause) => clause.clause === 'INPUTS_COMPLETE')!;
    assert.equal(inputs.state, 'FAIL');
    assert.ok(inputs.blocking.length > 0);
  });

  it('carries the constructability blocker into the gate rather than re-deriving it', () => {
    const report = stagegate.evaluateDesignGate(asPM());
    const blockers = report.clauses.find((clause) => clause.clause === 'BLOCKERS_CLOSED')!;
    assert.ok(blockers.blocking.some((entry) => entry.includes('safe access')));
  });

  it('replays the whole event log as part of the gate', () => {
    const report = stagegate.evaluateDesignGate(asPM());
    const replay = report.clauses.find((clause) => clause.clause === 'REPLAYABLE')!;
    assert.equal(replay.state, 'PASS');
  });

  it('picks the gate by phase, leaving a non-design project on the tender gate', () => {
    // The demo project ends in OPERATIONS, so `gateFor` must still answer 8.4.
    const chosen = stagegate.gateFor(asPM());
    const tender = stagegate.evaluateTenderGate(asPM());
    assert.equal(chosen.contentHash, tender.contentHash);
  });
});

describe('AC-D-WF-08-03 a tender cannot issue on superseded design information', () => {
  const DOCUMENTS = [
    { reference: 'D-01', title: 'Scope', revision: 'A', kind: 'SCOPE' },
    { reference: 'D-02', title: 'Pricing schedule', revision: 'A', kind: 'PRICING_SCHEDULE' },
    { reference: 'D-03', title: 'Drawings', revision: 'A', kind: 'DRAWINGS' },
    { reference: 'D-04', title: 'Specification', revision: 'A', kind: 'SPECIFICATION' },
    { reference: 'D-05', title: 'Programme', revision: 'A', kind: 'PROGRAMME' },
    { reference: 'D-06', title: 'Contract terms', revision: 'A', kind: 'CONTRACT_TERMS' },
  ];

  // Its own project, in its own phase. `PROCUREMENT_AWARD` is gated to TENDER
  // and CONSTRUCTION, and the demo project ends in OPERATIONS — so an enquiry
  // needs a project standing where an enquiry is actually issued.
  let tenderPlatform: Platform;
  let tenderSeed: SeedResult;

  const asQSCommercial = () =>
    tenderPlatform.context(tenderSeed.users.qs!.auth, tenderSeed.projectId, { source: 'WEB' });
  const asDesignAuthority = () =>
    tenderPlatform.context(tenderSeed.users.designer!.auth, tenderSeed.projectId, { source: 'WEB' });
  const asPlanner = () =>
    tenderPlatform.context(tenderSeed.users.pm!.auth, tenderSeed.projectId, { source: 'WEB' });

  let tenderSequence = 0;

  /** The same fixture as above, against the tender-phase project. */
  function tenderPackage(publish: boolean): { packageId: string; reference: string } {
    tenderSequence += 1;
    const reference = `PKG-E${String(tenderSequence).padStart(2, '0')}`;
    const { packageId } = designplan.createPackage(asPlanner(), {
      reference,
      title: `Enquiry package ${tenderSequence}`,
      discipline: 'CIVIL',
      zone: 'Inlet works',
      leadDesigner: 'D. Whyte',
      leadOrganisation: 'Caldervale Engineering',
    });
    designplan.planDeliverable(asPlanner(), packageId, {
      reference: `${reference}-A`,
      title: 'General arrangement',
      kind: 'DRAWING',
      purpose: 'For construction',
      format: 'PDF',
      author: 'J. Mensah',
      checker: 'D. Whyte',
      approver: 'A. Okafor',
      acceptingParty: 'Northern Water Authority',
      dueBy: day(10),
      neededBy: day(40),
      neededFor: 'the civils enquiry',
      reviewDays: 10,
    });
    if (publish) {
      for (const to of ['SHARED', 'PUBLISHED'] as const) {
        designplan.advanceDeliverable(asPlanner(), packageId, { reference: `${reference}-A`, to });
      }
    }
    return { packageId, reference };
  }

  before(async () => {
    tenderPlatform = new Platform();
    tenderSeed = await seedDemoProject(tenderPlatform);
    structure.transitionPhase(
      tenderPlatform.context(tenderSeed.users.owner!.auth, tenderSeed.projectId, { source: 'WEB' }),
      { to: 'TENDER', justification: 'Reopened to issue the civils enquiry against the design baseline' },
    );
  });

  it('refuses a pack for a package this project designs and has not frozen', () => {
    const { reference } = tenderPackage(false);
    const { enquiryId } = enquiryModule.openEnquiry(asQSCommercial(), {
      packageReference: reference,
      title: 'Civils works',
      returnDeadline: day(21),
    });
    const refusal = throwsCode(
      () => enquiryModule.composeRevision(asQSCommercial(), enquiryId, { documents: DOCUMENTS }),
      'DESIGN_NOT_BASELINED',
    );
    assert.match(refusal.message ?? '', /never been frozen/);
  });

  it('lets it out with an authorised exception, which the bidder then sees', () => {
    const { reference } = tenderPackage(false);
    const { enquiryId } = enquiryModule.openEnquiry(asQSCommercial(), {
      packageReference: reference,
      title: 'Civils works',
      returnDeadline: day(21),
    });
    enquiryModule.composeRevision(asQSCommercial(), enquiryId, {
      documents: DOCUMENTS,
      exception: {
        missing: [],
        supersededDesign: 'The civils package is not yet frozen; drawings are issued at P03 for pricing only.',
        reason: 'The enquiry cannot wait for the freeze without losing the plant delivery slot.',
        authorisedBy: 'A. Okafor',
      },
    });

    // "Visibly included" means the firm pricing it can read it, so the test
    // reads it the way a bidder would rather than checking a field exists.
    enquiryModule.approveRevision(asPlanner(), enquiryId);
    enquiryModule.issueTo(asQSCommercial(), enquiryId, { recipients: [{ partyId: 'party-amey', name: 'Amey' }] });
    const view = enquiryModule.bidderView(asQSCommercial(), enquiryId, 'party-amey');
    assert.match(view.exception?.supersededDesign ?? '', /not yet frozen/);
    assert.match(view.exception?.reason ?? '', /plant delivery slot/);
  });

  it('refuses an exception on a package that is frozen and current', () => {
    const { packageId, reference } = tenderPackage(true);
    designbaseline.freezePackage(asDesignAuthority(), packageId, {
      scope: 'FULL',
      note: 'Published and accepted; nothing open against it.',
    });
    const { enquiryId } = enquiryModule.openEnquiry(asQSCommercial(), {
      packageReference: reference,
      title: 'Civils works',
      returnDeadline: day(21),
    });
    throwsCode(
      () =>
        enquiryModule.composeRevision(asQSCommercial(), enquiryId, {
          documents: DOCUMENTS,
          exception: {
            missing: [],
            supersededDesign: 'Just in case.',
            reason: 'Belt and braces.',
            authorisedBy: 'A. Okafor',
          },
        }),
      'EXCEPTION_NOT_NEEDED',
    );
  });

  it('leaves a project that runs no design packages alone', () => {
    // A straight tender off client information has no design baseline, and
    // refusing it for want of one would be inventing a requirement.
    const readiness = designbaseline.tenderReadinessFor(asQSCommercial(), 'A-PACKAGE-NOBODY-DESIGNS');
    assert.equal(readiness, null);
  });
});
