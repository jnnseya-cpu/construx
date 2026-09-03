import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { agentByName } from '../src/agents/registry.ts';
import { bareConstructionProject } from './helpers.ts';
import type { AgentDefinition, Finding } from '../src/agents/types.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as planning from '../src/engines/planning.ts';
import * as tender from '../src/engines/tender.ts';
import * as programmecontrol from '../src/domain/programmecontrol.ts';
import * as procurement from '../src/domain/procurement.ts';
import * as structure from '../src/domain/structure.ts';
import * as supplychain from '../src/domain/supplychain.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The two capability areas that had nobody watching them.
 *
 * Every other area in the permission matrix had at least one agent naming it in
 * `mandate.reads`. `LOOKAHEAD_CONSTRAINTS` and `SUPPLIER_SUBMISSION` had none,
 * and both are areas where the record going stale is silent by construction —
 * an unreviewed week does not lower PPC, it disappears from it, and an enquiry
 * that closed thin looks exactly like one that closed well until somebody opens
 * it.
 *
 * These tests build the conditions with the ordinary domain commands rather
 * than writing state directly, so what an agent finds is something a project
 * could actually get itself into. Both use a seeded project whose lifecycle
 * phase permits the writes: the flagship is in operations, where the phase
 * gates close planning and procurement to everybody.
 */

const agent = (name: string): AgentDefinition => {
  const found = agentByName(name);
  assert.ok(found, `no agent named ${name}`);
  assert.equal(typeof found.evaluate, 'function', `${name} is declared, not deployed`);
  return found;
};

/**
 * `evaluate` may be synchronous or asynchronous under the contract. Awaiting
 * covers the contract rather than these two implementations, so a later change
 * to either does not silently start comparing against a promise.
 */
const findings = async (definition: AgentDefinition, ctx: EngineContext): Promise<Finding[]> =>
  (await definition.evaluate!(ctx)).findings;

const keyed = (list: Finding[], prefix: string): Finding | undefined => list.find((f) => f.key.startsWith(prefix));

const isoDaysFromNow = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

describe('the lookahead agent watches the constraint log and the weekly promise', () => {
  let platform: Platform;
  let seed: SeedResult;
  let ctx: EngineContext;
  let taskIds: string[];

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    // A construction project of this suite's own, with an empty constraint log
    // and no lookahead ever published.
    //
    // It used to borrow the demonstration estate's construction project, which
    // held only while that project stayed empty. It does not: it now carries a
    // full delivery record, and six tests here broke at once. A fixture that
    // depends on another fixture staying poor fails the moment the product
    // improves, which is a bad trade for the setup it saved.
    const { projectId } = await bareConstructionProject(platform, seed, 'Lookahead Agent Fixture');
    ctx = platform.context(seed.users.planner!.auth, projectId);

    const { workPackageId } = planning.createWorkPackage(ctx, {
      wbsCode: 'RTM-01',
      title: 'Trunk main diversion — Bacup Road',
      indicativeDurationDays: 25,
      scopeNarrative: 'Divert the 600mm trunk main clear of the proposed carriageway realignment, reinstate and recommission.',
      responsibleParty: 'SUBCONTRACTOR',
    });

    taskIds = planning.createTasks(ctx, [
      { activityCode: 'RTM-100', name: 'Divert 600mm main at Bacup Road', workPackageId, durationDays: 12, costCode: 'CIV-01' },
      { activityCode: 'RTM-110', name: 'Reinstate carriageway', workPackageId, durationDays: 6, costCode: 'CIV-02' },
      { activityCode: 'RTM-120', name: 'Pressure test and chlorinate', workPackageId, durationDays: 4, costCode: 'MEC-01' },
    ]);
  });

  it('says nothing about a project that has done nothing wrong beyond having no plan', async () => {
    // Before anything is raised, the only true statement is that there is no
    // lookahead. An agent that also invented a constraint problem here would be
    // reporting on an empty log.
    const found = await findings(agent('lookahead'), ctx);
    assert.equal(found.length, 1, found.map((f) => f.key).join(', '));
    assert.equal(found[0]!.key, 'lookahead:none');
    assert.match(found[0]!.summary, /in construction and no lookahead has ever been published/);
  });

  it('does not raise "no lookahead" against a project that is not building yet', async () => {
    const concept = seed.workingProjects.find((project) => project.phase === 'CONCEPT');
    assert.ok(concept);
    const conceptCtx = platform.context(seed.users.planner!.auth, concept.projectId);
    assert.equal(keyed(await findings(agent('lookahead'), conceptCtx), 'lookahead:none'), undefined);
  });

  it('raises a constraint that is past the date it was needed by', async () => {
    planning.raiseConstraint(ctx, {
      taskId: taskIds[0]!,
      category: 'PERMIT',
      description: 'Section 50 street works licence not yet granted for Bacup Road',
      owner: 'Highways liaison',
      needByDate: isoDaysFromNow(-9),
    });

    const found = keyed(await findings(agent('lookahead'), ctx), 'lookahead:constraints-overdue');
    assert.ok(found, 'an open constraint nine days past its need-by date went unreported');
    assert.match(found.summary, /1 open constraint is past the date it was needed by/);
    assert.match(found.consequence, /stops being clearable and becomes a delay/);
    assert.equal(found.evidence.length, 1);
    assert.equal(found.evidence[0]!.refType, 'Constraint');
    assert.match(found.evidence[0]!.note, /CON-0001 \(permit\)/);
    assert.match(found.evidence[0]!.note, /owner Highways liaison/);
  });

  it('leaves a constraint alone while its date is still ahead of it', async () => {
    planning.raiseConstraint(ctx, {
      taskId: taskIds[1]!,
      category: 'MATERIALS',
      description: 'Type 1 sub-base delivery not confirmed',
      owner: 'Buyer',
      needByDate: isoDaysFromNow(21),
    });

    const found = keyed(await findings(agent('lookahead'), ctx), 'lookahead:constraints-overdue');
    assert.ok(found);
    // Still one. The second constraint is open and unresolved, which is not the
    // same thing as late.
    assert.match(found.summary, /^1 open constraint is past/);
  });

  it('stops reporting a constraint once it is cleared', async () => {
    const constraints = ctx.ledger
      .list(ctx.projectId, 'Constraint')
      .filter((record) => record.state.reference === 'CON-0001');
    assert.equal(constraints.length, 1);

    planning.closeConstraint(ctx, {
      constraintId: constraints[0]!.refId,
      resolution: 'Licence granted 14 days after application; works window confirmed with the authority.',
    });

    assert.equal(keyed(await findings(agent('lookahead'), ctx), 'lookahead:constraints-overdue'), undefined);
  });

  it('finds work blocked on site that never reached the constraint log', async () => {
    const site = platform.context(seed.users.siteManager!.auth, ctx.projectId);
    programmecontrol.updateTaskStatus(site, {
      taskId: taskIds[2]!,
      status: 'BLOCKED',
      blocked: {
        reason: 'No chlorination certificate from the water undertaker',
        owner: 'Commissioning engineer',
        impact: 'The main cannot be brought into supply, and the road stays closed',
        nextAction: 'Chase the undertaker for the sampling slot',
      },
    });

    const found = keyed(await findings(agent('lookahead'), ctx), 'lookahead:blocked-unlogged');
    assert.ok(found, 'a task blocked on site with no constraint against it went unreported');
    assert.equal(found.severity, 'URGENT');
    assert.match(found.summary, /1 task is blocked on site with no constraint raised against it/);
    assert.match(found.evidence[0]!.note, /No chlorination certificate/);
    assert.match(found.evidence[0]!.note, /Commissioning engineer named/);
  });

  it('goes quiet on that task once the block is entered as a constraint with a date and an owner', async () => {
    planning.raiseConstraint(ctx, {
      taskId: taskIds[2]!,
      category: 'APPROVAL',
      description: 'Chlorination certificate outstanding from the water undertaker',
      owner: 'Commissioning engineer',
      needByDate: isoDaysFromNow(10),
    });

    assert.equal(keyed(await findings(agent('lookahead'), ctx), 'lookahead:blocked-unlogged'), undefined);
  });

  it('finds a week that ended without the promises being reviewed', async () => {
    planning.publishLookahead(ctx, {
      weekStarting: isoDaysFromNow(-21),
      plannedTaskIds: taskIds,
      commitments: [
        {
          // The only task with no open constraint against it. `publishLookahead`
          // refuses a promise made over constrained work, which is the rule
          // that makes this Last Planner rather than a bar chart.
          taskId: taskIds[0]!,
          promise: '600mm main diverted and tied in between chambers 4 and 7',
          promisedBy: 'Ganger, civils gang 2',
          dueDate: isoDaysFromNow(-15),
        },
      ],
    });

    const found = keyed(await findings(agent('lookahead'), ctx), 'lookahead:unreviewed-weeks');
    assert.ok(found, 'a week three weeks past its end was never reported as unreviewed');
    assert.match(found.summary, /1 week has ended without the promises being reviewed/);
    assert.match(found.consequence, /does not lower it — it vanishes from it/);
    assert.match(found.evidence[0]!.note, /1 promises, still PUBLISHED/);

    // And the "no lookahead at all" finding is now false, so it stops.
    assert.equal(keyed(await findings(agent('lookahead'), ctx), 'lookahead:none'), undefined);
  });

  it('leaves the current week alone — it has not ended yet', async () => {
    planning.publishLookahead(ctx, {
      weekStarting: isoDaysFromNow(-1),
      plannedTaskIds: taskIds,
      commitments: [
        {
          taskId: taskIds[0]!,
          promise: 'Diversion pressure-tested to 16 bar and held for two hours',
          promisedBy: 'Ganger, civils gang 2',
          dueDate: isoDaysFromNow(5),
        },
      ],
    });

    const found = keyed(await findings(agent('lookahead'), ctx), 'lookahead:unreviewed-weeks');
    assert.ok(found);
    // Still one. A week that is running is not a week that was skipped.
    assert.match(found.summary, /^1 week has ended/);
  });

  it('stops once the week is reviewed and its reasons are counted', async () => {
    const stale = ctx.ledger
      .list(ctx.projectId, 'LookaheadPlan')
      .find((record) => record.state.weekStarting === isoDaysFromNow(-21));
    assert.ok(stale);

    planning.reviewLookahead(ctx, {
      lookaheadId: stale.refId,
      outcomes: [{ taskId: taskIds[0]!, completed: false, reason: 'MATERIALS', note: 'Tie-in fittings delivered two days late' }],
    });

    assert.equal(keyed(await findings(agent('lookahead'), ctx), 'lookahead:unreviewed-weeks'), undefined);
  });

  it('observes and never proposes', async () => {
    const definition = agent('lookahead');
    assert.deepEqual(definition.mandate.proposes, []);
    assert.equal(definition.mandate.maxUnattended, 'OBSERVE');
    assert.deepEqual((await definition.evaluate!(ctx)).proposals, []);
  });

  it('declares the area that had nobody watching it', () => {
    assert.ok(agent('lookahead').mandate.reads.includes('LOOKAHEAD_CONSTRAINTS'));
  });
});

describe('the returns agent watches what came back against an enquiry', () => {
  let platform: Platform;
  let seed: SeedResult;
  /** The tender-phase project. Procurement writes are phase-closed elsewhere. */
  let ctx: EngineContext;
  let suppliers: Array<{ supplierId: string; partyId: string; legalName: string }>;
  let packageId: string;
  let tenderPackageId: string;

  /** Create, compose and issue an enquiry, returning the RFQ it produced. */
  const issue = async (title: string, deadline: string): Promise<string> => {
    const { rfqId } = procurement.createRFQ(ctx, {
      packageId,
      title,
      pricingBasis: 'REMEASURABLE',
      returnDeadline: deadline,
      invitedSupplierIds: suppliers.map((supplier) => supplier.supplierId),
      trade: 'GROUNDWORKS',
      packageValueMinor: 1_200_000_00,
      requiredInsurances: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY'],
      contractSuite: 'NEC4',
    });
    procurement.issueRFQ(ctx, { rfqId, tenderPackageId });
    return rfqId;
  };

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    const tenderProject = seed.workingProjects.find((project) => project.phase === 'TENDER');
    assert.ok(tenderProject, 'the demonstration tenancy no longer holds a tender-phase project');
    ctx = platform.context(seed.users.qs!.auth, tenderProject.projectId);

    // The supplier register is tenant-wide, so the firms the flagship
    // prequalified are the firms this enquiry may go to. Which of them are
    // eligible is the platform's own answer, not a status this test decides:
    // `createRFQ` refuses the whole enquiry if any invitee fails the same test.
    suppliers = supplychain
      .findSuppliers(ctx, { trade: 'GROUNDWORKS', packageValueMinor: 1_200_000_00 })
      .filter((record) => record.eligible)
      .slice(0, 3)
      .map((record) => ({
        supplierId: String(record.id),
        partyId: String(record.partyId),
        legalName: String(record.legalName),
      }));
    assert.equal(suppliers.length, 3, 'the demonstration register no longer holds three eligible groundworks firms');

    // Each act under the role that actually holds it: the planner defines the
    // package, the designer assesses its maturity, the QS takes it to market.
    const planner = platform.context(seed.users.planner!.auth, tenderProject.projectId);
    const designer = platform.context(seed.users.designer!.auth, tenderProject.projectId);

    packageId = planning.createWorkPackage(planner, {
      wbsCode: 'CRR-01',
      title: 'Reservoir draw-off and scour — civils',
      indicativeDurationDays: 90,
      scopeNarrative: 'Construct the draw-off tower base, scour chamber and associated pipework civils.',
      responsibleParty: 'SUBCONTRACTOR',
    }).workPackageId;

    // Design maturity governs the pricing basis, and `createRFQ` refuses a
    // package that has not been assessed.
    structure.assessDesignMaturity(designer, {
      packageId,
      disciplineScores: [
        { discipline: 'CIVIL', ribaStage: 4, completenessPercent: 78, frozen: true },
        { discipline: 'STRUCTURAL', ribaStage: 4, completenessPercent: 72, frozen: false },
      ],
      informationGaps: ['Ground investigation report for the scour chamber'],
      assessorNotes: 'Civils frozen at stage 4; structural still moving on the chamber roof.',
    });

    tenderPackageId = (
      await tender.composeTenderPackage(ctx, {
        rfqId: 'pending',
        packageId,
        scopeNarrative:
          'The subcontractor shall construct the draw-off tower base and scour chamber including temporary works design, dewatering and reinstatement.',
        designResponsibilityMatrix: [
          { element: 'Permanent works design', responsibleParty: 'CLIENT_CONSULTANT' },
          { element: 'Temporary works design', responsibleParty: 'SUBCONTRACTOR' },
        ],
        attendances: ['Welfare facilities', 'Site-wide power distribution'],
        paymentTerms: 'Monthly application, 30 days from due date, 5% retention',
        programmeRef: { refType: 'Project', refId: ctx.projectId },
        documents: [{ name: 'C-2001 rev P01', ref: { refType: 'WorkPackage', refId: packageId } }],
      })
    ).packageRefId;
  });

  it('says nothing while there is no enquiry out', async () => {
    const found = await findings(agent('returns'), ctx);
    assert.deepEqual(
      found.map((f) => f.key),
      [],
      `the returns agent invented something: ${found.map((f) => f.summary).join(' | ')}`,
    );
  });

  it('raises an enquiry closing inside five days with nothing back, while something can still be done', async () => {
    const rfqId = await issue(
      'Mechanical plant — pumps and valves',
      new Date(Date.now() + 3 * 86_400_000).toISOString(),
    );

    const found = keyed(await findings(agent('returns'), ctx), `returns:thin:${rfqId}`);
    assert.ok(found, 'an enquiry closing in three days with nothing returned went unreported');
    assert.equal(found.severity, 'URGENT');
    assert.match(found.summary, /closes in 3 days with 0 of 3 invited firms returned/);
    assert.match(found.consequence, /refused outright/);
    assert.match(found.consequence, /paying the lead time twice/);
  });

  it('softens once a return arrives, and goes quiet at three', async () => {
    const rfqId = ctx.ledger.list(ctx.projectId, 'RFQ').at(-1)!.refId;

    const submit = (index: number, priceMinor: number) =>
      procurement.receiveSubmission(ctx, {
        rfqId,
        supplierPartyId: suppliers[index]!.partyId,
        supplierName: suppliers[index]!.legalName,
        priceMinor,
        durationDays: 40,
        exclusions: [],
        contractExceptions: [],
        provisionalSumsMinor: 0,
        insurancesHeld: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY'],
        peakLabour: 6,
        submissionHash: hashEvidence(`returns-agent-submission-${index}`),
      });

    submit(0, 1_180_000_00);
    let found = keyed(await findings(agent('returns'), ctx), `returns:thin:${rfqId}`);
    assert.ok(found);
    assert.equal(found.severity, 'ATTENTION', 'one return is thin, not empty');
    assert.match(found.summary, /with 1 of 3 invited firms returned/);

    submit(1, 1_242_000_00);
    submit(2, 1_206_000_00);
    assert.equal(
      keyed(await findings(agent('returns'), ctx), `returns:thin:${rfqId}`),
      undefined,
      'three returns is a competition and should not be raised',
    );
  });

  it('raises a return carrying exclusions that has not been levelled against the others', async () => {
    const rfqId = await issue(
      'Instrumentation and telemetry',
      new Date(Date.now() + 20 * 86_400_000).toISOString(),
    );

    procurement.receiveSubmission(ctx, {
      rfqId,
      supplierPartyId: suppliers[0]!.partyId,
      supplierName: suppliers[0]!.legalName,
      priceMinor: 310_000_00,
      durationDays: 30,
      exclusions: ['Outstation power supplies', 'Builder’s work in connection'],
      contractExceptions: ['Liquidated damages capped at 5% of the subcontract sum'],
      provisionalSumsMinor: 0,
      insurancesHeld: ['PUBLIC_LIABILITY', 'EMPLOYERS_LIABILITY'],
      submissionHash: hashEvidence('returns-agent-exclusions'),
    });

    const found = keyed(await findings(agent('returns'), ctx), 'returns:unnormalised');
    assert.ok(found, 'a return carrying exclusions and exceptions was never flagged for levelling');
    assert.match(found.summary, /1 return carries exclusions or contract exceptions/);
    assert.match(found.consequence, /the cheapest return is whichever firm excluded most/);
    assert.match(found.evidence[0]!.note, /2 exclusion\(s\), 1 contract exception\(s\)/);
  });

  it('goes quiet on that return once it has been levelled against the others', async () => {
    const rfq = ctx.ledger
      .list(ctx.projectId, 'RFQ')
      .find((record) => record.state.title === 'Instrumentation and telemetry')!;
    const submission = ctx.ledger
      .list(ctx.projectId, 'SupplierSubmission')
      .find((record) => record.state.rfqId === rfq.refId)!;

    const line = (rateMinor: number) => ({
      reference: 'INS-01',
      description: 'Supply and install flow instrumentation',
      unit: 'nr',
      quantity: 12,
      rateMinor,
      totalMinor: rateMinor * 12,
    });

    await tender.analyseReturns(ctx, {
      rfqId: rfq.refId,
      baseline: [line(24_000_00)],
      returns: [{ submissionId: submission.refId, supplierName: suppliers[0]!.legalName, lines: [line(25_833_00)] }],
    });

    assert.equal(
      keyed(await findings(agent('returns'), ctx), 'returns:unnormalised'),
      undefined,
      'a levelled return is still being reported as needing levelling',
    );
  });

  it('raises an enquiry whose deadline has passed with nothing returned', async () => {
    // `receiveSubmission` refuses a return after the deadline, which is exactly
    // why the position is worth stating: nothing can now change it.
    const rfqId = await issue(
      'Site establishment and temporary works',
      new Date(Date.now() - 2 * 86_400_000).toISOString(),
    );

    const found = keyed(await findings(agent('returns'), ctx), `returns:closed-thin:${rfqId}`);
    assert.ok(found, 'an enquiry that closed with nothing back went unreported');
    assert.equal(found.severity, 'URGENT');
    assert.match(found.summary, /closed with nothing returned/);
    assert.match(found.consequence, /nothing here to award/);
  });

  it('says nothing about the enquiry the flagship already awarded', async () => {
    // The flagship's RFQ is awarded, its three returns carry exclusions and
    // contract exceptions, and none was normalised through the AI path. That is
    // settled history rather than an open exposure: the levelling either
    // happened in the adjudication that awarded it or it did not, and raising
    // it now asks somebody to re-open a decision rather than take one.
    const flagship = platform.context(seed.users.qs!.auth, seed.projectId);
    assert.ok(flagship.ledger.list(seed.projectId, 'SupplierSubmission').length >= 3);

    const found = await findings(agent('returns'), flagship);
    assert.deepEqual(
      found.map((f) => f.key),
      [],
      `the returns agent reported on a closed enquiry: ${found.map((f) => f.summary).join(' | ')}`,
    );
  });

  it('observes and never proposes', async () => {
    const definition = agent('returns');
    assert.deepEqual(definition.mandate.proposes, []);
    assert.equal(definition.mandate.maxUnattended, 'OBSERVE');
    assert.deepEqual((await definition.evaluate!(ctx)).proposals, []);
  });

  it('declares the area that had nobody watching it', () => {
    assert.ok(agent('returns').mandate.reads.includes('SUPPLIER_SUBMISSION'));
  });
});

describe('every capability area now has an agent watching it', () => {
  it('leaves none uncovered', async () => {
    const { AGENTS } = await import('../src/agents/registry.ts');
    const { PERMISSION_MATRIX } = await import('../src/identity/roles.ts');

    const areas = new Set<string>();
    for (const matrix of Object.values(PERMISSION_MATRIX)) for (const area of Object.keys(matrix)) areas.add(area);

    const watched = new Set(AGENTS.flatMap((definition) => definition.mandate.reads as string[]));
    const uncovered = [...areas].filter((area) => !watched.has(area)).sort();

    assert.deepEqual(uncovered, [], `capability areas with nobody watching them:\n  ${uncovered.join('\n  ')}`);
  });
});
