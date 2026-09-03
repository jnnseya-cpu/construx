import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import * as mobilisation from '../src/domain/mobilisation.ts';
import * as structure from '../src/domain/structure.ts';
import * as planning from '../src/engines/planning.ts';
import * as quality from '../src/engines/quality.ts';
import * as safety from '../src/engines/safety.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-01 — mobilisation and start-work readiness.
 *
 * The failure this is written against: work starts on a Monday because the
 * programme said Monday. The method statement is still in draft, the temporary
 * works design has not been checked, and the drawing the gang is working to was
 * superseded on the Friday. Nobody decided any of that — it happened because
 * start was a date rather than an authorisation.
 *
 * What is tested is therefore not that a start can be recorded. It is that a
 * start cannot be recorded over a failed critical prerequisite, that a tick
 * cannot replace a check the platform can perform itself, that a conditional
 * readiness expires, and that a Not Ready package stops work.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds FIELD_EXECUTION C, U — runs the readiness check. Cannot authorise. */
const asSiteManager = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'WEB' });
/** Holds A — the construction manager's authority to put people to work. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds SAFETY_RAMS A — approves the method statement and issues permits. */
const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });
/** Holds QUALITY_COMMISSIONING C — writes the inspection plan. */
const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
/** Holds no field execution at all. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const WINDOW = { from: day(1), to: day(14) };

/** Every non-verifiable prerequisite answered yes, by a named person. */
const DECLARATIONS = (
  [
    ['CONTRACT', 'Notice to proceed issued 4 March under clause 11.1.'],
    ['ACCESS', 'Possession of the inlet works compound taken 6 March; boundary fenced.'],
    ['WELFARE', 'Canteen, drying room and two WCs commissioned; first aiders rostered.'],
    ['SURVEY', 'Setting out checked against the control network; pre-condition survey issued.'],
    ['RESOURCE', 'Gang of six, 13t excavator and the first delivery of pipe on site.'],
    ['LOGISTICS', 'Haul route agreed with the authority; storage compound marked out.'],
  ] as Array<[mobilisation.PrerequisiteKind, string]>
).map(([kind, detail]) => ({ kind, met: true, detail, declaredBy: 'A. Okafor' }));

let sequence = 0;

/** The RAMS drafted for each package, so a test can approve or brief it later. */
const ramsIds = new Map<string, string>();

/**
 * A work package with an approved and briefed RAMS, an ITP, and a ticketed gang.
 *
 * Built through the platform's own commands rather than written into the
 * ledger, so the fixture cannot drift from what the platform will accept.
 * Async because drafting a method statement is an AI act in this platform.
 */
async function readyPackage(options: { briefed?: boolean; itp?: boolean } = {}): Promise<{
  workPackageId: string;
  wbsCode: string;
  operativeIds: string[];
}> {
  sequence += 1;
  const wbsCode = `CN-${String(sequence).padStart(3, '0')}`;
  const { workPackageId } = planning.createWorkPackage(asPM(), {
    wbsCode,
    title: `Inlet works package ${sequence}`,
    indicativeDurationDays: 20,
  });

  const { ramsId } = await safety.draftRAMS(asSafety(), {
    workPackageId,
    activityDescription: 'Bulk excavation to formation',
    location: 'Inlet works',
    steps: [{ description: 'Excavate in 300mm lifts', activityType: 'EXCAVATION' }],
  });
  ramsIds.set(workPackageId, ramsId);

  if (options.briefed !== false) {
    safety.approveRAMS(asSafety(), ramsId, 'Reviewed against the excavation standard; controls adequate.');
    safety.acknowledgeRAMS(asSafety(), ramsId, ['OP-100', 'OP-101'], `briefing-${wbsCode}`);
  }

  if (options.itp !== false) {
    quality.createInspectionPlan(asQAQC(), {
      workPackageId,
      title: `ITP for ${wbsCode}`,
      discipline: 'CIVIL',
      stages: [
        {
          reference: 'S-01',
          description: 'Formation level and bearing check',
          acceptanceCriteria: 'CBR not less than 5% over the full formation.',
          type: 'HOLD',
          responsible: 'QAQC',
        },
      ],
    });
  }

  const operativeIds = ['OP-100', 'OP-101'];
  for (const operativeId of operativeIds) {
    safety.recordCompetency(asSafety(), {
      operativeId,
      qualification: 'Excavation / CPCS',
      issuedAt: day(-365),
      expiresAt: day(365),
      certificateHash: `cert-${operativeId}-${sequence}`,
    });
  }

  return { workPackageId, wbsCode, operativeIds };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Mobilising the inlet works packages',
  });
});

describe('CN-WF-01 the register', () => {
  it('registers its four event types', () => {
    for (const [code, entity, action] of [
      ['MOBILISATION_STARTED', 'MobilisationPlan', 'CREATE'],
      ['READINESS_CHECK_COMPLETED', 'ReadinessCheck', 'CREATE'],
      ['WORK_NOT_READY', 'ReadinessCheck', 'CREATE'],
      ['START_WORK_AUTHORISED', 'StartWorkAuthorisation', 'APPROVE'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      assert.equal(definition.action, action);
      // "Cannot authorise work, declare competence or waive safety control."
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('classifies all three entities under field execution', () => {
    for (const entity of ['MobilisationPlan', 'ReadinessCheck', 'StartWorkAuthorisation']) {
      assert.equal(classifyEntity(entity)?.area, 'FIELD_EXECUTION');
    }
  });

  it('refuses a mobilisation plan from a role with no field execution', async () => {
    const { workPackageId } = await readyPackage();
    throwsCode(
      () =>
        mobilisation.openMobilisation(asQS(), {
          reference: 'MOB-X',
          site: 'Inlet works',
          workPackageIds: [workPackageId],
        }),
      'ACCESS_DENIED',
    );
  });

  it('refuses a plan over no package at all', () => {
    throwsCode(
      () => mobilisation.openMobilisation(asPM(), { reference: 'MOB-EMPTY', site: 'Inlet works', workPackageIds: [] }),
      'MOBILISATION_EMPTY',
    );
  });

  it('refuses an unnamed plan', async () => {
    const { workPackageId } = await readyPackage();
    throwsCode(
      () => mobilisation.openMobilisation(asPM(), { reference: '  ', site: 'Inlet works', workPackageIds: [workPackageId] }),
      'MOBILISATION_UNNAMED',
    );
  });
});

describe('CN-WF-01 what the platform can check, it checks', () => {
  it('reads the RAMS rather than asking whether it is approved', async () => {
    const { workPackageId, operativeIds } = await readyPackage({ briefed: false });
    const results = mobilisation.verifyPrerequisites(platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' }), {
      workPackageId,
      window: WINDOW,
      operativeIds,
    });
    const rams = results.find((entry) => entry.kind === 'RAMS')!;
    assert.equal(rams.status, 'NOT_MET');
    assert.equal(rams.source, 'VERIFIED');
    assert.match(rams.detail, /none approved/);
  });

  it('counts an approved method statement nobody has been briefed on as not met', async () => {
    // The briefing is the control. An approved RAMS in a drawer is a document.
    const { workPackageId } = await readyPackage({ briefed: false });
    const ramsId = ramsIds.get(workPackageId)!;
    safety.approveRAMS(asSafety(), ramsId, 'Reviewed; controls adequate.');
    const results = mobilisation.verifyPrerequisites(asPM(), { workPackageId, window: WINDOW, operativeIds: ['OP-100'] });
    const rams = results.find((entry) => entry.kind === 'RAMS')!;
    assert.equal(rams.status, 'NOT_MET');
    assert.match(rams.detail, /none briefed out/);
  });

  it('reads the tickets against the whole window, not against today', async () => {
    const { workPackageId } = await readyPackage();
    safety.recordCompetency(asSafety(), {
      operativeId: 'OP-LAPSING',
      qualification: 'Excavation / CPCS',
      issuedAt: day(-365),
      // In date today, expired before the window ends.
      expiresAt: day(3),
      certificateHash: 'cert-lapsing',
    });
    const results = mobilisation.verifyPrerequisites(asPM(), {
      workPackageId,
      window: WINDOW,
      operativeIds: ['OP-LAPSING'],
    });
    const competence = results.find((entry) => entry.kind === 'COMPETENCE')!;
    assert.equal(competence.status, 'NOT_MET');
    assert.match(competence.detail, /before the window ends/);
  });

  it('never leaves competence unanswered when nobody is named', async () => {
    // An unanswerable question reported as not applicable reads as satisfied.
    const { workPackageId } = await readyPackage();
    const results = mobilisation.verifyPrerequisites(asPM(), { workPackageId, window: WINDOW });
    const competence = results.find((entry) => entry.kind === 'COMPETENCE')!;
    assert.equal(competence.status, 'NOT_MET');
    assert.match(competence.detail, /No operative is named/);
  });

  it('refuses a declaration over something it has verified', async () => {
    // Somebody typing "RAMS: yes" over a record the platform has read is the
    // exact failure the workflow exists against.
    const { workPackageId, operativeIds } = await readyPackage({ briefed: false });
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    throwsCode(
      () =>
        mobilisation.checkReadiness(asSiteManager(), planId, {
          workPackageId,
          window: WINDOW,
          operativeIds,
          declarations: [
            ...DECLARATIONS,
            { kind: 'RAMS', met: true, detail: 'It is fine.', declaredBy: 'A. Okafor' },
          ],
          note: 'Ready.',
        }),
      'ALREADY_VERIFIED',
    );
  });

  it('refuses a declaration with nobody behind it', async () => {
    const { workPackageId, operativeIds } = await readyPackage();
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-N-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    throwsCode(
      () =>
        mobilisation.checkReadiness(asSiteManager(), planId, {
          workPackageId,
          window: WINDOW,
          operativeIds,
          declarations: [{ kind: 'CONTRACT', met: true, detail: 'Signed.', declaredBy: '  ' }],
          note: 'Ready.',
        }),
      'DECLARATION_UNATTRIBUTED',
    );
  });

  it('records which answers were read and which were typed', async () => {
    const { workPackageId, operativeIds } = await readyPackage();
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-S-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    const { checkId } = mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      note: 'Walked the area with the ganger; everything in place.',
    });
    void checkId;

    const position = mobilisation.mobilisationPosition(asPM());
    const check = position.checks.at(-1)!;
    // Six declarations, and the rest read from records. An audit six months
    // later needs to know which of the twelve somebody typed.
    assert.equal(check.declared, DECLARATIONS.length);
  });
});

describe('CN-WF-01 no start over a failed critical prerequisite', () => {
  it('finds a package not ready and says which critical prerequisites failed', async () => {
    const { workPackageId, operativeIds } = await readyPackage({ briefed: false, itp: false });
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-NR-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    const result = mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      note: 'Method statement still in draft.',
    });
    assert.equal(result.readiness, 'NOT_READY');
    assert.deepEqual(result.failing, ['RAMS']);
  });

  it('writes not ready as its own event', () => {
    // The fact somebody has to find in the ledger without opening state.
    const codes = platform.ledger
      .events({ projectId: seed.projectId })
      .map((event) => event.eventType);
    assert.ok(codes.includes('WORK_NOT_READY'));
  });

  it('refuses to authorise a start over it', async () => {
    const { workPackageId, operativeIds } = await readyPackage({ briefed: false });
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-NA-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    const { checkId } = mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      note: 'Method statement still in draft.',
    });
    const refusal = throwsCode(
      () =>
        mobilisation.authoriseStart(asPM(), checkId, {
          scope: 'Bulk excavation to formation',
          location: 'Inlet works, grid A1 to C4',
          window: WINDOW,
          informationRevisions: [{ reference: 'C-2101', revision: 'P05', source: 'Design package PKG-CIV' }],
        }),
      'NOT_READY',
    );
    assert.match(refusal.message ?? '', /rams/);
  });

  it('refuses a start authority from the site manager, who runs the check but does not give the authority', async () => {
    const { workPackageId, operativeIds } = await readyPackage();
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-AU-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    const { checkId } = mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      note: 'All in place.',
    });
    throwsCode(
      () =>
        mobilisation.authoriseStart(asSiteManager(), checkId, {
          scope: 'Bulk excavation',
          location: 'Inlet works',
          window: WINDOW,
          informationRevisions: [{ reference: 'C-2101', revision: 'P05', source: 'PKG-CIV' }],
        }),
      'ACCESS_DENIED',
    );
  });
});

describe('CN-WF-01 the authority identifies what it covers', () => {
  let checkId: string;

  before(async () => {
    const { workPackageId, operativeIds } = await readyPackage();
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-OK-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    checkId = mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      note: 'Walked the area; everything in place.',
    }).checkId;
  });

  it('refuses an authority that names no scope or location', () => {
    // AC-CN-WF-01-03. "Start work" covers the whole site, which is the same as
    // covering nothing.
    throwsCode(
      () =>
        mobilisation.authoriseStart(asPM(), checkId, {
          scope: '  ',
          location: 'Inlet works',
          window: WINDOW,
          informationRevisions: [{ reference: 'C-2101', revision: 'P05', source: 'PKG-CIV' }],
        }),
      'AUTHORITY_UNSCOPED',
    );
  });

  it('refuses an authority naming no information revisions', () => {
    throwsCode(
      () =>
        mobilisation.authoriseStart(asPM(), checkId, {
          scope: 'Bulk excavation',
          location: 'Inlet works',
          window: WINDOW,
          informationRevisions: [],
        }),
      'INFORMATION_REVISIONS_REQUIRED',
    );
  });

  it('refuses a window outside the one that was checked', () => {
    throwsCode(
      () =>
        mobilisation.authoriseStart(asPM(), checkId, {
          scope: 'Bulk excavation',
          location: 'Inlet works',
          window: { from: WINDOW.from, to: day(60) },
          informationRevisions: [{ reference: 'C-2101', revision: 'P05', source: 'PKG-CIV' }],
        }),
      'WINDOW_EXCEEDS_CHECK',
    );
  });

  it('authorises a start with all four, and records who gave it', () => {
    const result = mobilisation.authoriseStart(asPM(), checkId, {
      scope: 'Bulk excavation to formation, grids A1 to C4',
      location: 'Inlet works, north compound',
      window: { from: WINDOW.from, to: day(10) },
      informationRevisions: [
        { reference: 'C-2101', revision: 'P05', source: 'Design package PKG-CIV' },
        { reference: 'C-2102', revision: 'P02', source: 'Design package PKG-CIV' },
      ],
    });
    assert.match(result.reference, /^SWA-\d{4}$/);
    assert.equal(result.conditional, false);

    const position = mobilisation.mobilisationPosition(asPM());
    const authority = position.authorisations.find((entry) => entry.reference === result.reference)!;
    assert.equal(authority.approvedBy, seed.users.pm!.id);
    assert.match(authority.scope, /grids A1 to C4/);
    assert.equal(authority.window.to, day(10));
  });

  it('withdraws an authority rather than deleting it', () => {
    const position = mobilisation.mobilisationPosition(asPM());
    const authority = position.authorisations.at(-1)!;
    assert.deepEqual(
      mobilisation.revokeAuthorisation(asPM(), authority.authorisationId, {
        reason: 'A service strike in the adjacent bay; all excavation stopped pending a resurvey.',
      }),
      { revoked: true },
    );
    throwsCode(
      () => mobilisation.revokeAuthorisation(asPM(), authority.authorisationId, { reason: 'Again.' }),
      'ALREADY_REVOKED',
    );
    // Still there, still saying what it authorised.
    const after = mobilisation
      .mobilisationPosition(asPM())
      .authorisations.find((entry) => entry.authorisationId === authority.authorisationId)!;
    assert.equal(after.revoked, true);
    assert.equal(after.scope, authority.scope);
  });
});

describe('CN-WF-01 a conditional readiness expires', () => {
  async function conditional(expiresAt?: string, conditions?: mobilisation.ReadinessCondition[]) {
    // ITP missing is a non-critical failure, which is what makes it conditional
    // rather than not ready.
    const { workPackageId, operativeIds } = await readyPackage({ itp: false });
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-C-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    return mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      ...(conditions ? { conditions } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      note: 'Ready apart from the inspection plan, which is with QA.',
    });
  }

  const CONDITION = [{ what: 'Issue the ITP for the excavation package', owner: 'S. Duarte', by: day(5) }];

  it('refuses a conditional readiness with no conditions on it', async () => {
    await rejectsCode(() => conditional(day(20)), 'CONDITIONS_REQUIRED');
  });

  it('refuses a condition with no date', async () => {
    await rejectsCode(
      () => conditional(day(20), [{ what: 'Issue the ITP', owner: 'S. Duarte', by: 'soon' }]),
      'CONDITION_UNBOUND',
    );
  });

  it('refuses a condition with no owner', async () => {
    await rejectsCode(
      () => conditional(day(20), [{ what: 'Issue the ITP', owner: '', by: day(5) }]),
      'CONDITION_UNBOUND',
    );
  });

  it('refuses a conditional readiness with no expiry', async () => {
    // Without one the conditions stop being conditions and become a
    // description of the site.
    await rejectsCode(() => conditional(undefined, CONDITION), 'READINESS_EXPIRY_REQUIRED');
  });

  it('refuses an authority running past the expiry', async () => {
    const { checkId } = await conditional(day(6), CONDITION);
    throwsCode(
      () =>
        mobilisation.authoriseStart(asPM(), checkId, {
          scope: 'Bulk excavation',
          location: 'Inlet works',
          window: { from: WINDOW.from, to: day(12) },
          informationRevisions: [{ reference: 'C-2101', revision: 'P05', source: 'PKG-CIV' }],
        }),
      'READINESS_EXPIRED',
    );
  });

  it('authorises inside the expiry, and marks the authority conditional', async () => {
    const { checkId, readiness } = await conditional(day(12), CONDITION);
    assert.equal(readiness, 'READY_WITH_CONDITIONS');
    const result = mobilisation.authoriseStart(asPM(), checkId, {
      scope: 'Bulk excavation to formation',
      location: 'Inlet works',
      window: { from: WINDOW.from, to: day(10) },
      informationRevisions: [{ reference: 'C-2101', revision: 'P05', source: 'PKG-CIV' }],
    });
    assert.equal(result.conditional, true);
  });

  it('surfaces a condition past its date', async () => {
    await conditional(day(20), [{ what: 'Issue the ITP', owner: 'S. Duarte', by: day(-3) }]);
    const position = mobilisation.mobilisationPosition(asPM());
    assert.ok(position.overdueConditions.some((entry) => entry.by === day(-3)));
    assert.match(position.summary, /past their date/);
  });
});

describe('AC-CN-WF-01-02 not ready prevents work', () => {
  it('refuses progress against a task on a package found not ready', async () => {
    const { workPackageId, operativeIds } = await readyPackage({ briefed: false });
    const [taskId] = planning.createTasks(asPM(), [
      {
        activityCode: `ACT-${workPackageId.slice(-5)}`,
        name: 'Excavate to formation',
        workPackageId,
        durationDays: 10,
      },
    ]);
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-P-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      note: 'Method statement still in draft.',
    });

    const refusal = throwsCode(
      () =>
        planning.recordProgress(asPM(), {
          taskId: taskId!,
          percentComplete: 20,
          elapsedDays: 2,
          evidenceDescription: 'Two days of digging',
          evidenceHash: 'progress-1',
        }),
      'WORK_NOT_AUTHORISED',
    );
    assert.match(refusal.message ?? '', /not ready/);
  });

  it('leaves a package this workflow has never seen alone', () => {
    // The acceptance criterion is about Not Ready. Refusing progress on every
    // project that does not run mobilisation would be inventing a requirement.
    sequence += 1;
    const { workPackageId } = planning.createWorkPackage(asPM(), {
      wbsCode: `CN-UNSEEN-${sequence}`,
      title: 'Never mobilised',
      indicativeDurationDays: 5,
    });
    const [taskId] = planning.createTasks(asPM(), [
      { activityCode: `ACT-UNSEEN-${sequence}`, name: 'Something else', workPackageId, durationDays: 5 },
    ]);
    planning.recordProgress(asPM(), {
      taskId: taskId!,
      percentComplete: 10,
      elapsedDays: 1,
      evidenceDescription: 'A day of work',
      evidenceHash: `progress-unseen-${sequence}`,
    });
    assert.equal(mobilisation.startBlockedReason(asPM(), workPackageId), null);
  });

  it('stops work again once a conditional readiness has expired', async () => {
    const { workPackageId, operativeIds } = await readyPackage({ itp: false });
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-X-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    mobilisation.checkReadiness(asSiteManager(), planId, {
      workPackageId,
      window: WINDOW,
      operativeIds,
      declarations: DECLARATIONS,
      conditions: [{ what: 'Issue the ITP', owner: 'S. Duarte', by: day(-10) }],
      expiresAt: day(-1),
      note: 'Conditional on the ITP.',
    });
    const blocked = mobilisation.startBlockedReason(asPM(), workPackageId);
    assert.ok(blocked);
    assert.match(blocked, /expired/);
  });
});

describe('CN-WF-01 the plan scopes what can be readied', () => {
  it('refuses a readiness check on a package the plan never listed', async () => {
    const first = await readyPackage();
    const other = await readyPackage();
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-SC-${first.workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [first.workPackageId],
    });
    throwsCode(
      () =>
        mobilisation.checkReadiness(asSiteManager(), planId, {
          workPackageId: other.workPackageId,
          window: WINDOW,
          operativeIds: other.operativeIds,
          declarations: DECLARATIONS,
          note: 'Ready.',
        }),
      'NOT_IN_MOBILISATION_PLAN',
    );
  });

  it('refuses a check with no window, or one that ends before it starts', async () => {
    const { workPackageId, operativeIds } = await readyPackage();
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-W-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    throwsCode(
      () =>
        mobilisation.checkReadiness(asSiteManager(), planId, {
          workPackageId,
          window: { from: 'whenever', to: day(10) },
          operativeIds,
          declarations: DECLARATIONS,
          note: 'Ready.',
        }),
      'WINDOW_REQUIRED',
    );
    throwsCode(
      () =>
        mobilisation.checkReadiness(asSiteManager(), planId, {
          workPackageId,
          window: { from: day(10), to: day(2) },
          operativeIds,
          declarations: DECLARATIONS,
          note: 'Ready.',
        }),
      'WINDOW_REQUIRED',
    );
  });

  it('refuses an unexplained disposition', async () => {
    const { workPackageId, operativeIds } = await readyPackage();
    const { planId } = mobilisation.openMobilisation(asPM(), {
      reference: `MOB-U-${workPackageId.slice(-4)}`,
      site: 'Inlet works',
      workPackageIds: [workPackageId],
    });
    throwsCode(
      () =>
        mobilisation.checkReadiness(asSiteManager(), planId, {
          workPackageId,
          window: WINDOW,
          operativeIds,
          declarations: DECLARATIONS,
          note: '   ',
        }),
      'READINESS_UNEXPLAINED',
    );
  });

  it('refuses a plan naming a work package that does not exist', () => {
    throwsCode(
      () =>
        mobilisation.openMobilisation(asPM(), {
          reference: 'MOB-GHOST',
          site: 'Inlet works',
          workPackageIds: ['not-a-package'],
        }),
      'WORK_PACKAGE_NOT_FOUND',
    );
  });
});

/**
 * The route the console reads mobilisation through.
 *
 * `GET /v1/projects/:projectId/mobilisation` was bound to the ETABLIX control
 * tower, which already has its own route at `/site-services/mobilisation`. So
 * the generic route duplicated the ETABLIX one and the CONSTRUX
 * `mobilisationPosition` had no route at all — while every write on the
 * construction screen (open a plan, run a readiness check, authorise a start)
 * went to the CONSTRUX module.
 *
 * Mobilisation was therefore write-only. A tenancy could record all of it and
 * had no way to read any of it back, and the panel meant to show it displayed
 * "This tenancy does not hold the ETABLIX AI Site Services module" — telling a
 * paying customer that mobilisation was something they had not bought.
 *
 * Mobilisation is part of the CONSTRUX subscription. ETABLIX's seven-gate tower
 * over site services is a different question on a different path.
 */
describe('mobilisation is readable without the site-services module', () => {
  it('answers the CONSTRUX position, not an ETABLIX refusal', async () => {
    const local = new Platform();
    const local_seed = await seedDemoProject(local);
    const server = createGateway(local);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;

    try {
      const token = issueTokens({
        actorId: local_seed.users.pm!.id,
        tenantId: local.user(local_seed.users.pm!.id).tenantId,
        partyId: local.user(local_seed.users.pm!.id).partyId,
        roles: local.user(local_seed.users.pm!.id).roles,
        mfaSatisfied: true,
      }).accessToken;

      const response = await fetch(`http://127.0.0.1:${port}/v1/projects/${local_seed.projectId}/mobilisation`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200, JSON.stringify(body));
      // The shape the console panel names its three sections from. The ETABLIX
      // position has gates and families instead, so this is what tells the two
      // apart rather than the status code.
      assert.ok(Array.isArray(body.checks), 'no readiness checks — this is not the CONSTRUX position');
      assert.ok(Array.isArray(body.authorisations), 'no start authorities');
      assert.ok(Array.isArray(body.overdueConditions), 'no overdue conditions');
      assert.equal(typeof body.summary, 'string');

      // And the refusal that was reaching the screen must be gone.
      assert.doesNotMatch(JSON.stringify(body), /ETABLIX/i);
    } finally {
      server.close();
    }
  });
});
