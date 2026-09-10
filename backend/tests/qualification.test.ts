import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as award from '../src/domain/award.ts';
import * as structure from '../src/domain/structure.ts';
import { ROUTES } from '../src/api/routes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * A qualification the award said nothing about — `AWD-002`.
 *
 * ---
 *
 * **The assumption this removes.** A term the award is silent on carries the bid
 * figure. That is right for a contract sum or a retention percentage, and it is
 * why silence is not a departure for either of them. A qualification is the
 * opposite: it is only in the contract if the contract says it is.
 *
 * So a platform that carried bid qualifications into delivery because nobody
 * struck them out would manufacture a commercial position the contract does not
 * support — one the business discovers the first time it tries to rely on it,
 * usually in an argument about scope it is going to lose.
 *
 * Before this, `departuresBetween` only looked at qualifications when the award
 * named the ones it accepted. An award that said nothing produced no departures
 * and no record, and the bid's qualifications rode into the delivery baseline
 * unexamined. There are three standings, not two, and the third is the whole
 * point.
 */

let platform: Platform;
let seed: SeedResult;
let packId: string;

const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds both award approval and budget approval, which converting needs. */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const pack = platform.ledger.list(seed.projectId, 'BidSubmissionPack')[0];
  assert.ok(pack, 'the seeded project no longer builds a bid submission pack');
  packId = pack.refId;

  // An award is a tender-stage act; the demonstration finishes in operations.
  // Moved back through the platform's own governed regression rather than
  // around the phase gate.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to record the award against the bid pack this project was won on',
  });
});

describe('the standing of a qualification is computed, not assumed', () => {
  const submitted = { qualifications: ['Rock excavation excluded', 'Asbestos survey by others', 'Winter working excluded'] };

  it('reads silence as unresolved rather than as acceptance', () => {
    const standings = award.qualificationStandings(submitted, { contractSumMinor: 1_000_00 });

    assert.equal(standings.length, 3);
    for (const standing of standings) {
      assert.equal(standing.standing, 'UNRESOLVED', `${standing.qualification} should be unresolved`);
      assert.match(standing.basis, /silence is not acceptance/);
    }
  });

  it('reads a named acceptance as accepted and an omission as struck out', () => {
    const standings = award.qualificationStandings(submitted, {
      acceptedQualifications: ['Rock excavation excluded', 'Winter working excluded'],
    });

    const by = new Map(standings.map((entry) => [entry.qualification, entry]));
    assert.equal(by.get('Rock excavation excluded')!.standing, 'ACCEPTED');
    assert.equal(by.get('Winter working excluded')!.standing, 'ACCEPTED');
    assert.equal(by.get('Asbestos survey by others')!.standing, 'STRUCK_OUT');
    // Every standing names what says so. None of them is an inference.
    for (const standing of standings) assert.ok(standing.basis.trim().length > 0);
  });

  it('says nothing about a bid that carried no qualifications', () => {
    assert.deepEqual(award.qualificationStandings({ qualifications: [] }, {}), []);
  });
});

describe('an unresolved qualification cannot become a delivery baseline', () => {
  it('records the standing when the award is silent, rather than dropping it', () => {
    award.recordSubmission(asQS(), packId, {
      reference: 'ASH/2027/014/SUB/0091',
      channel: 'PORTAL',
      receivedAt: '2027-03-12T11:52:00.000Z',
      evidenceHash: `sha256:${'c'.repeat(64)}`,
    });

    const bid = (platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!.state.assembly as {
      qualifications: string[];
      estimateTotalMinor: number;
    });
    assert.ok(bid.qualifications.length >= 1, 'the seeded pack carries no qualifications to leave unresolved');

    // The award names a sum and says nothing at all about the qualifications,
    // which is what a letter of intent normally does.
    const { departures } = award.recordAward(asPM(), packId, {
      outcome: 'WON',
      reference: 'AW-2027-014',
      receivedOn: '2027-04-02',
      terms: { contractSumMinor: bid.estimateTotalMinor },
    });

    // Silence is not a departure — reporting it as one would fill the list with
    // noise on every letter of intent and the real departures would be read
    // past. It is the third thing.
    assert.equal(departures.filter((entry) => entry.field === 'Qualification struck out').length, 0);

    const position = award.awardPosition(asQS());
    const row = position.packs.find((entry) => entry.packId === packId)!;
    assert.equal(row.qualificationsUnresolved, bid.qualifications.length);
    assert.equal(position.unresolvedQualifications.length, bid.qualifications.length);
    assert.match(position.summary, /neither accepted nor struck out/);
  });

  it('refuses the conversion and names each one', () => {
    const bid = (platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!.state.assembly as {
      qualifications: string[];
    });

    const error = throwsCode(
      () =>
        award.convertAward(asOwner(), packId, {
          budgetVersion: 'v1',
          contingencyMinor: 0,
          managementReserveMinor: 0,
          tenderMarginPercent: 6,
        }),
      'QUALIFICATIONS_UNRESOLVED',
    );
    assert.match(String(error.message), /silence is not acceptance/);
    assert.match(String(error.message), new RegExp(bid.qualifications[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('refuses a resolution with no basis, and one against a qualification that does not exist', () => {
    const bid = (platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!.state.assembly as {
      qualifications: string[];
    });

    throwsCode(
      () =>
        award.resolveQualification(asPM(), packId, {
          qualification: bid.qualifications[0]!,
          standing: 'ACCEPTED',
          basis: 'agreed',
        }),
      'RESOLUTION_BASIS_REQUIRED',
    );

    throwsCode(
      () =>
        award.resolveQualification(asPM(), packId, {
          qualification: 'A qualification this bid never carried',
          standing: 'ACCEPTED',
          basis: 'The contract carries it at clause 12.4 of the amended conditions',
        }),
      'QUALIFICATION_NOT_FOUND',
    );
  });

  it('lets each be resolved against something the client actually said', () => {
    const bid = (platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!.state.assembly as {
      qualifications: string[];
    });

    let remaining = bid.qualifications.length;
    for (const [index, qualification] of bid.qualifications.entries()) {
      const result = award.resolveQualification(asPM(), packId, {
        qualification,
        // Struck out is a legitimate outcome and not a failure. What is refused
        // is the third state surviving into the baseline.
        standing: index === 0 ? 'ACCEPTED' : 'STRUCK_OUT',
        basis:
          index === 0
            ? 'Carried into the contract at clause 12.4 of the amended conditions, confirmed in the award letter'
            : 'The award letter states the works are to be priced complete, which removes this exclusion',
      });
      remaining -= 1;
      assert.equal(result.unresolved, remaining);
    }

    const position = award.awardPosition(asQS());
    assert.equal(position.unresolvedQualifications.length, 0);
    assert.equal(position.packs.find((entry) => entry.packId === packId)!.qualificationsUnresolved, 0);
  });

  it('refuses to resolve one twice', () => {
    const bid = (platform.ledger.get({ refType: 'BidSubmissionPack', refId: packId })!.state.assembly as {
      qualifications: string[];
    });
    throwsCode(
      () =>
        award.resolveQualification(asPM(), packId, {
          qualification: bid.qualifications[0]!,
          standing: 'STRUCK_OUT',
          basis: 'Changing the answer after the fact, which the record should not allow silently',
        }),
      'QUALIFICATION_ALREADY_RESOLVED',
    );
  });

  it('is reachable from the console', () => {
    assert.ok(
      ROUTES.some(
        (route) =>
          route.method === 'POST' &&
          route.pattern === '/v1/projects/:projectId/bid-packs/:packId/qualifications/resolve',
      ),
      'the resolution has no route, so the refusal above is a dead end',
    );
  });
});
