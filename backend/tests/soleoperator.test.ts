import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { secondPerson } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import * as structure from '../src/domain/structure.ts';
import { decideGate, gateReviews, submitForGate } from '../src/lifecycle/stages.ts';

/**
 * One person, running the whole business.
 *
 * Four rules on this platform refuse a second act from whoever took the first
 * — a gate decision, a design check, a design acceptance and a payment
 * certification. They are right. Separation of duties is not expressible in the
 * permission matrix, because it is a rule about *two acts by one person* rather
 * than about roles, so each engine checks it against its own record.
 *
 * What none of them could see is whether a second person exists. A sole trader
 * was not being held to a control; they were stopped by it permanently, with
 * the remedy — "assign it to another identity with payment authority" — naming
 * somebody who does not exist. A control nobody can satisfy is a dead end, and
 * it made the platform unusable for the smallest businesses it is sold to.
 *
 * The rule now asks first whether anybody else could take the second act. Where
 * somebody could, nothing changed. Where nobody could, the act proceeds and the
 * event carries, in words, that one person did both — which is more than the
 * record said when the act was simply impossible.
 */

/** A company, and the people in it. */
function company(people: Array<{ name: string; roles: string[] }>) {
  const platform = new Platform();
  const { tenant } = platform.createTenant({
    legalName: 'Sole Trader Construction Ltd',
    enterpriseName: 'Sole Trader',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
  });
  const users = people.map((person) =>
    platform.createUser({
      tenantId: tenant.id,
      name: person.name,
      email: `${person.name.toLowerCase()}-${Math.random().toString(36).slice(2)}@sole.test`,
      roles: person.roles as Parameters<Platform['createUser']>[0]['roles'],
    }),
  );
  return { platform, tenantId: tenant.id, users };
}

describe('whether anybody else could take the second act', () => {
  it('is false in a company of one, and true as soon as there are two', () => {
    const solo = company([{ name: 'Ana', roles: ['OWNER'] }]);
    const soloCtx = solo.platform.context(authOf(solo.platform, solo.users[0]!.id), `${solo.tenantId}-governance`, { source: 'WEB' });
    assert.equal(soloCtx.secondPersonCould?.('PAYMENT_APPLICATIONS', 'A'), false);
    assert.equal(soloCtx.secondPersonCould?.('DESIGN_INFORMATION', 'A'), false);

    const pair = company([
      { name: 'Ana', roles: ['OWNER'] },
      { name: 'Bo', roles: ['COMMERCIAL_MANAGER'] },
    ]);
    const pairCtx = pair.platform.context(authOf(pair.platform, pair.users[0]!.id), `${pair.tenantId}-governance`, { source: 'WEB' });
    // The commercial manager holds 'A' on payment applications, so there is a
    // second party and the control is exercisable. Nothing about it changes.
    assert.equal(pairCtx.secondPersonCould?.('PAYMENT_APPLICATIONS', 'A'), true);
  });

  it('counts only people who could actually do it', () => {
    // A second identity that holds no payment authority is not a second party.
    // Counting heads rather than authority would open the control to any
    // company that had ever created a viewer.
    const withViewer = company([
      { name: 'Ana', roles: ['OWNER'] },
      { name: 'Vic', roles: ['VIEWER'] },
    ]);
    const ctx = withViewer.platform.context(
      authOf(withViewer.platform, withViewer.users[0]!.id),
      `${withViewer.tenantId}-governance`,
      { source: 'WEB' },
    );
    assert.equal(ctx.secondPersonCould?.('PAYMENT_APPLICATIONS', 'A'), false);
  });

  it('refuses where no resolver is carried, because the safe answer is that somebody exists', () => {
    const stub = { auth: { actorId: 'u-1' } } as never;
    const verdict = secondPerson(stub, 'u-1', 'PAYMENT_APPLICATIONS', 'A');
    assert.deepEqual(verdict, { same: true, refuse: true, note: null });
  });

  it('is not consulted at all when two different people acted', () => {
    const stub = { auth: { actorId: 'u-2' }, secondPersonCould: () => false } as never;
    assert.deepEqual(secondPerson(stub, 'u-1', 'PAYMENT_APPLICATIONS', 'A'), { same: false, refuse: false, note: null });
  });
});

describe('a gate on a one-person company', () => {
  function projectFor(people: Array<{ name: string; roles: string[] }>) {
    const made = company(people);
    const auth = authOf(made.platform, made.users[0]!.id);
    const governance = made.platform.context(auth, `${made.tenantId}-governance`, { source: 'WEB' });
    const enterpriseId = String(made.platform.ledger.listByTenant(made.tenantId, 'Enterprise')[0]?.state.id ?? '');
    const { portfolioId } = structure.createPortfolio(governance, {
      name: 'Repairs and maintenance',
      enterpriseId,
      governanceModel: 'Sole director',
      continentCode: 'EU',
      city: 'Rawtenstall',
    });
    const { projectId } = structure.createProject(governance, {
      portfolioId,
      name: 'Church wall repair',
      sectorType: 'RMI',
      assetType: 'Boundary wall',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Rawtenstall' },
      contractValueMinor: 2_000_000,
      currency: 'GBP',
      plannedStart: '2026-02-02',
      plannedCompletion: '2026-04-30',
    });
    const ctx = made.platform.context(auth, projectId, { source: 'WEB' });
    // The concept gate asks for at least one scope package, and rightly: a gate
    // that passes with nothing defining what is being built is a formality.
    structure.createScopePackage(ctx, {
      name: 'Boundary wall repair',
      discipline: 'CIVILS',
      scopeOfWorks: 'Repoint, rebuild the collapsed section and replace the coping.',
      inclusions: ['Repointing in lime mortar'],
      exclusions: ['Anything beyond the churchyard boundary'],
      acceptanceCriteria: ['Accepted when the conservation officer signs it off'],
      estimatedValueMinor: 2_000_000,
      designResponsibility: 'CONTRACTOR',
    });
    return { ...made, auth, ctx, projectId };
  }

  it('is decided by the person who submitted it, and says so on the record', () => {
    const solo = projectFor([{ name: 'Ana', roles: ['OWNER'] }]);

    submitForGate(solo.ctx, { comments: 'The concept is settled and the wall is measured' });
    const review = gateReviews(solo.ctx)[0]!;

    // The act that used to be impossible.
    decideGate(solo.ctx, {
      gateReviewId: String(review.id),
      result: 'APPROVED',
      authorityBasis: 'Sole director',
      comments: 'Approved by the owner; this company has one authorised person.',
    });

    const decided = gateReviews(solo.ctx)[0]!;
    assert.equal(decided.result, 'APPROVED');
    assert.equal(decided.decidedBy, solo.auth.actorId);
    // And the record says a single person took both halves, rather than leaving
    // a reader to notice that two identifiers match.
    assert.match(String(decided.segregation), /no other active identity/i);
  });

  it('still refuses it the moment the company has somebody else who could decide', () => {
    const staffed = projectFor([
      { name: 'Ana', roles: ['OWNER'] },
      { name: 'Bo', roles: ['PROJECT_DIRECTOR'] },
    ]);

    submitForGate(staffed.ctx, { comments: 'The concept is settled and the wall is measured' });
    const review = gateReviews(staffed.ctx)[0]!;

    throwsCode(
      () =>
        decideGate(staffed.ctx, {
          gateReviewId: String(review.id),
          result: 'APPROVED',
          authorityBasis: 'Sole director',
          comments: 'Approving my own gate.',
        }),
      'GATE_SELF_APPROVAL',
    );
  });
});
