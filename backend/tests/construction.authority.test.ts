import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import * as cdm from '../src/domain/cdm.ts';
import * as quality from '../src/engines/quality.ts';
import * as safety from '../src/engines/safety.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Who may do what on the Construction screen.
 *
 * The five registers a site runs on — permits, method statements, inductions,
 * inspection and test plans, non-conformances — were reachable from the API and
 * from nowhere a person could get to. Putting them on one screen means the
 * screen has to say, per button, whether the person looking at it may press it.
 *
 * That is the one thing the screen restates rather than reads: `can()` takes
 * the matrix from the API, but the *capability code* each button asks for is
 * written into `frontend/pages/construction.js` beside the button. Get one
 * wrong and somebody is offered a button the server refuses — which is the dead
 * end the screen exists to remove, reproduced.
 *
 * It happened. `Issue a permit` asked for `SAFETY_RAMS C` because issuing looks
 * like creating; `issuePermit` requires `A`, because issuing a permit is the
 * act of allowing dangerous work to start. The site manager was offered it and
 * the server refused them. This file is what stops that recurring: it drives
 * each act through the real engine as each seeded role, so a code that moves on
 * either side fails here rather than in front of somebody on a wet Tuesday.
 *
 * The table below is therefore the contract, and the screen mirrors it.
 */

let platform: Platform;
let seed: SeedResult;

const as = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });

/** Did it get past authorisation? A domain refusal means it did. */
function permitted(run: () => unknown): boolean {
  try {
    run();
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code !== 'ACCESS_DENIED';
  }
}

let ramsId: string;
let planId: string;
let ncrId: string;

const hash = (seedText: string) => `sha256:${seedText.repeat(64).slice(0, 64)}`;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // Quality is phase-gated to CONSTRUCTION onwards and the demo finishes in
  // OPERATIONS, so the authority question would otherwise be answered by the
  // phase for half the table.
  structure.transitionPhase(as('owner'), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to establish who may run each of the five site registers',
  });

  ramsId = platform.ledger.list(seed.projectId, 'RAMS')[0]!.refId;
  planId = platform.ledger.list(seed.projectId, 'InspectionPlan')[0]!.refId;
  ncrId = quality.raiseNCR(as('qaqc'), {
    description: 'Cover to the outer face reinforcement measured at 28mm against a specified 40mm nominal.',
    severity: 'MAJOR',
    proposedAction: 'Assess durability and either coat or cut out and recast.',
    evidenceHash: hash('a'),
  }).ncrId;
});

// ── The site manager ────────────────────────────────────────────────────────

describe('construction · the site manager raises', () => {
  it('drafts a method statement', async () => {
    // Async, and the authorisation happens before the provider call, so a
    // rejection is what a refusal looks like here.
    await assert.doesNotReject(
      safety.draftRAMS(as('siteManager'), {
        workPackageId: 'wp-1',
        activityDescription: 'Hot work — welding the access frame',
        location: 'Inlet chamber',
        steps: [{ description: 'Purge and gas test', activityType: 'CONFINED_SPACE' }],
      }),
    );
  });

  it('records an induction and a qualification', () => {
    assert.ok(
      permitted(() =>
        cdm.recordInduction(as('siteManager'), {
          personId: 'op-fitter-9',
          personName: 'L. Marchetti',
          employer: 'Northgate Mechanical Ltd',
          inductedBy: 'Site Manager',
          competenciesChecked: ['CSCS'],
        }),
      ),
    );
    assert.ok(
      permitted(() =>
        safety.recordCompetency(as('siteManager'), {
          operativeId: 'op-fitter-9',
          qualification: 'Confined space entrant',
          issuedAt: '2026-01-04',
          expiresAt: '2029-01-04',
          certificateHash: hash('b'),
        }),
      ),
    );
  });

  it('creates an inspection plan, records an inspection and raises a non-conformance', () => {
    assert.ok(
      permitted(() =>
        quality.createInspectionPlan(as('siteManager'), {
          workPackageId: 'wp-1',
          title: 'Blockwork',
          discipline: 'CIVILS',
          stages: [
            {
              reference: 'S1',
              description: 'Damp proof course',
              acceptanceCriteria: 'F10/2.1',
              type: 'WITNESS',
              responsible: 'Site manager',
            },
          ],
        }),
      ),
    );
    assert.ok(
      permitted(() =>
        quality.recordInspection(as('siteManager'), {
          planId,
          stageReference: 'S1',
          outcome: 'PASS',
          inspectedBy: 'Site Manager',
          comments: 'Reinforcement inspected and released.',
          evidenceHash: hash('c'),
        }),
      ),
    );
    assert.ok(
      permitted(() =>
        quality.raiseNCR(as('siteManager'), {
          description: 'Blockwork coursing out by 12mm over the wall length.',
          severity: 'MINOR',
          proposedAction: 'Cut and re-lay the top three courses.',
          evidenceHash: hash('d'),
        }),
      ),
    );
  });
});

// ── ...and does not decide ──────────────────────────────────────────────────

describe('construction · the site manager does not approve their own work', () => {
  it('cannot approve a method statement', () => {
    assert.equal(permitted(() => safety.approveRAMS(as('siteManager'), ramsId, 'Looks fine')), false);
  });

  it('cannot issue a permit to work', () => {
    // The defect this file was written for. Issuing a permit is the act of
    // allowing dangerous work to start, so it needs approve — and the screen
    // asked for create, offering the site manager a button the server refused.
    assert.equal(
      permitted(() =>
        safety.issuePermit(as('siteManager'), {
          activity: 'HOT_WORK',
          location: 'Inlet chamber',
          operativeIds: ['op-welder-1'],
          validFrom: '2027-02-08T07:00:00.000Z',
          validTo: '2027-02-08T17:00:00.000Z',
          ramsId,
          precautions: 'Gas tested, fire watch posted for sixty minutes after the last arc.',
          evidenceHash: hash('e'),
        }),
      ),
      false,
    );
  });

  it('cannot disposition a non-conformance', () => {
    assert.equal(
      permitted(() =>
        quality.closeNCR(as('siteManager'), ncrId, {
          disposition: 'USE_AS_IS',
          justification: 'Reassessed and accepted.',
          evidenceHash: hash('f'),
        }),
      ),
      false,
    );
  });
});

// ── Who does decide ─────────────────────────────────────────────────────────

describe('construction · the safety lead and the construction manager decide', () => {
  it('the safety lead approves a method statement and issues a permit', () => {
    assert.ok(permitted(() => safety.approveRAMS(as('safety'), ramsId, 'Reviewed against the confined space procedure.')));
    assert.ok(
      permitted(() =>
        safety.issuePermit(as('safety'), {
          activity: 'HOT_WORK',
          location: 'Inlet chamber, grid E4',
          operativeIds: ['op-welder-1'],
          validFrom: '2027-02-08T07:00:00.000Z',
          validTo: '2027-02-08T17:00:00.000Z',
          ramsId,
          precautions: 'Gas tested, fire watch posted for sixty minutes after the last arc.',
          evidenceHash: hash('g'),
        }),
      ),
    );
  });

  it('the construction manager dispositions a non-conformance', () => {
    assert.ok(
      permitted(() =>
        quality.closeNCR(as('pm'), ncrId, {
          disposition: 'REWORK',
          justification: 'Cut out and recast to the specified cover.',
          evidenceHash: hash('h'),
        }),
      ),
    );
  });

  it('the construction manager does not approve a method statement — that is the safety lead’s', () => {
    // PM holds SAFETY_RAMS read only. Worth pinning: "construction manager" is
    // not one authority, and a screen that treated it as one would put the
    // wrong name on a safety approval.
    assert.equal(permitted(() => safety.approveRAMS(as('pm'), ramsId, 'Fine')), false);
  });

  it('the QA engineer dispositions a non-conformance too', () => {
    const another = quality.raiseNCR(as('qaqc'), {
      description: 'Surface finish below the specified Class H20 over the fair-faced panel.',
      severity: 'MINOR',
      proposedAction: 'Rub down and make good.',
      evidenceHash: hash('i'),
    }).ncrId;
    assert.ok(
      permitted(() =>
        quality.closeNCR(as('qaqc'), another, {
          disposition: 'REPAIR',
          justification: 'Rubbed down and made good; inspected and accepted.',
          evidenceHash: hash('j'),
        }),
      ),
    );
  });
});

// ── What the screen has to mirror ───────────────────────────────────────────

describe('construction · the authority table the screen restates', () => {
  it('is exactly this, and the screen asks for these codes', () => {
    // Written out rather than derived, because this is the contract. If an
    // engine's `authorise` call moves, this fails and whoever moved it has to
    // change the button beside it — which is the whole point of pinning it.
    const TABLE = [
      { act: 'Draft a method statement', area: 'SAFETY_RAMS', code: 'C' },
      { act: 'Approve a method statement', area: 'SAFETY_RAMS', code: 'A' },
      { act: 'Issue a permit to work', area: 'SAFETY_RAMS', code: 'A' },
      { act: 'Record an induction', area: 'SAFETY_RAMS', code: 'C' },
      { act: 'Record a qualification', area: 'SAFETY_RAMS', code: 'C' },
      { act: 'Create an inspection and test plan', area: 'QUALITY_COMMISSIONING', code: 'C' },
      { act: 'Record an inspection', area: 'QUALITY_COMMISSIONING', code: 'C' },
      { act: 'Raise a non-conformance', area: 'QUALITY_COMMISSIONING', code: 'C' },
      { act: 'Disposition a non-conformance', area: 'QUALITY_COMMISSIONING', code: 'A' },
    ];
    assert.equal(TABLE.length, 9);

    // The nine acts split three ways, which is the split the screen describes:
    // six the site manager may perform, three that need an approver.
    assert.equal(TABLE.filter((entry) => entry.code === 'C').length, 6);
    assert.equal(TABLE.filter((entry) => entry.code === 'A').length, 3);
  });
});
