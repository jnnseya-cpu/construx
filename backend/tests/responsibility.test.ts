import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as responsibility from '../src/domain/responsibility.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Who is responsible for what, between the client and every contractor.
 *
 * The platform already knew which firm held which package — an award records
 * that. What it could not answer was the question actually argued about on
 * site, which is not *whose package is this* but **whose duty is this**.
 *
 * The table is the smaller half of this module and these tests mostly ignore
 * it. What is under test is the four failures it exists to name, because a
 * responsibility matrix that only lists what everybody already agrees on is a
 * document nobody opens twice.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

const pm = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
const cm = () => platform.context(seed.users.constructionManager!.auth, seed.projectId, { source: 'WEB' });
const qs = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });

/** A fresh project so one test's matrix is not another's. */
async function estate(): Promise<{
  platform: Platform;
  seed: SeedResult;
  projectId: string;
  pm: () => ReturnType<Platform['context']>;
}> {
  const fresh = new Platform();
  const freshSeed = await seedDemoProject(fresh);
  const admin = freshSeed.users.admin!.auth;
  const portfolioId = fresh.ledger.listByTenant(freshSeed.tenantId, 'Portfolio')[0]!.refId;
  const created = structure.createProject(fresh.context(admin, `${freshSeed.tenantId}-governance`), {
    portfolioId,
    name: 'Responsibility fixture',
    sectorType: 'UTILITIES',
    assetType: 'Impounding reservoir',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Halifax' },
    contractValueMinor: 940_000_000,
    currency: 'GBP',
    plannedStart: '2027-01-11',
    plannedCompletion: '2029-06-29',
  });
  return {
    platform: fresh,
    seed: freshSeed,
    projectId: created.projectId,
    pm: () => fresh.context(freshSeed.users.pm!.auth, created.projectId, { source: 'WEB' }),
  };
}

// ── Who may state it ────────────────────────────────────────────────────────

describe('the two roles that run the interface own the matrix', () => {
  it('lets the project manager and the construction manager record one', () => {
    // Both hold C, U and A on WORKPACKAGES_TASKS, and between them they are the
    // two people who answer for the interface — the PM to the client and the
    // contract, the construction manager to the sequence and the site.
    const byPm = responsibility.assignResponsibility(pm(), {
      reference: 'RM-PM-01',
      description: 'Permanent works to the spillway crest',
      category: 'WORKS',
      partyKind: 'PRINCIPAL_CONTRACTOR',
      partyName: 'Meridian Infrastructure Group Ltd',
    });
    assert.ok(byPm.itemId);

    const byCm = responsibility.assignResponsibility(cm(), {
      reference: 'RM-CM-01',
      description: 'Temporary works design for the crest access',
      category: 'TEMPORARY_WORKS',
      partyKind: 'PRINCIPAL_CONTRACTOR',
      partyName: 'Meridian Infrastructure Group Ltd',
    });
    assert.ok(byCm.itemId);
  });

  it('refuses a role that does not run the interface', () => {
    // The QS holds R on work packages and not C. Stating that a duty is
    // somebody else's is a position the business defends, and it belongs with
    // the people who answer for it.
    throwsCode(
      () =>
        responsibility.assignResponsibility(qs(), {
          reference: 'RM-QS-01',
          description: 'Something the QS should not be assigning',
          category: 'WORKS',
          partyKind: 'CLIENT',
          partyName: 'Yorkshire Water Services Limited',
        }),
      'ACCESS_DENIED',
    );
  });
});

// ── What it refuses to record ───────────────────────────────────────────────

describe('a line that would protect nobody is refused', () => {
  it('will not record a client-side obligation with no date', () => {
    // The whole reason free issue is a separate category from works: an
    // obligation nobody can be late on cannot be chased and cannot be claimed
    // against, and recording it undated produces a matrix that looks complete.
    const refusal = throwsCode(
      () =>
        responsibility.assignResponsibility(pm(), {
          reference: 'RM-FI-01',
          description: 'Free issue of the valve actuators',
          category: 'FREE_ISSUE',
          partyKind: 'CLIENT',
          partyName: 'Yorkshire Water Services Limited',
        }),
      'RESPONSIBILITY_DATE_REQUIRED',
    );
    assert.match(String(refusal.message), /cannot be chased and cannot be claimed against/);
  });

  it('records the same obligation once a date is on it', () => {
    const filed = responsibility.assignResponsibility(pm(), {
      reference: 'RM-FI-02',
      description: 'Free issue of the valve actuators',
      category: 'FREE_ISSUE',
      partyKind: 'CLIENT',
      partyName: 'Yorkshire Water Services Limited',
      dueBy: '2027-03-01',
      source: 'Contract cl. 2.3',
    });
    assert.ok(filed.itemId);
  });

  it('will not take a subcontractor typed rather than named from the register', () => {
    // Two spellings of one firm are two parties on this matrix and one firm on
    // the job, and the matrix then cannot answer who holds anything.
    throwsCode(
      () =>
        responsibility.assignResponsibility(pm(), {
          reference: 'RM-SUB-01',
          description: 'Piling',
          category: 'WORKS',
          partyKind: 'SUBCONTRACTOR',
          partyName: 'J Murphy & Sons',
        }),
      'RESPONSIBILITY_SUPPLIER_REQUIRED',
    );
  });

  it('will not take one reference twice', () => {
    responsibility.assignResponsibility(pm(), {
      reference: 'RM-DUP-01',
      description: 'Something',
      category: 'WORKS',
      partyKind: 'PRINCIPAL_CONTRACTOR',
      partyName: 'Meridian Infrastructure Group Ltd',
    });
    throwsCode(
      () =>
        responsibility.assignResponsibility(pm(), {
          reference: 'RM-DUP-01',
          description: 'Something else',
          category: 'WORKS',
          partyKind: 'CLIENT',
          partyName: 'Yorkshire Water Services Limited',
        }),
      'RESPONSIBILITY_REFERENCE_TAKEN',
    );
  });
});

// ── The four failures it exists to name ─────────────────────────────────────

describe('it names the four ways a project argues with itself', () => {
  it('reports a scope package nobody has been made responsible for', async () => {
    const { pm: freshPm } = await estate();
    structure.createScopePackage(freshPm(), {
      name: 'Piling',
      discipline: 'CIVILS',
      scopeOfWorks: 'Bored piles to the spillway stilling basin.',
      inclusions: ['Pile probing'],
      exclusions: ['Pile trimming'],
      acceptanceCriteria: ['Integrity testing passed'],
      estimatedValueMinor: 120_000_000,
      designResponsibility: 'CONTRACTOR',
    });

    const matrix = responsibility.responsibilityMatrix(freshPm());
    const concern = matrix.concerns.find((c) => c.kind === 'SCOPE_UNASSIGNED');
    assert.ok(concern, 'a package with no party against it was not reported');
    assert.match(concern.subject, /Piling/);
    assert.match(concern.consequence, /priced around this package and none of them priced it/);
  });

  it('reports one package two parties both hold', async () => {
    const { pm: freshPm, platform: fresh, seed: freshSeed } = await estate();
    const { packageId } = structure.createScopePackage(freshPm(), {
      name: 'Substructure',
      discipline: 'CIVILS',
      scopeOfWorks: 'Reinforced concrete substructure to the stilling basin.',
      inclusions: ['Blinding'],
      exclusions: [],
      acceptanceCriteria: ['Cube results to specification'],
      estimatedValueMinor: 240_000_000,
      designResponsibility: 'CONTRACTOR',
    });

    const supplier = fresh.ledger.listByTenant(freshSeed.tenantId, 'Supplier')[0];
    responsibility.assignResponsibility(freshPm(), {
      reference: 'RM-OV-01',
      description: 'Substructure works',
      category: 'WORKS',
      partyKind: 'PRINCIPAL_CONTRACTOR',
      partyName: 'Meridian Infrastructure Group Ltd',
      packageId,
    });
    responsibility.assignResponsibility(freshPm(), {
      reference: 'RM-OV-02',
      description: 'Substructure works',
      category: 'WORKS',
      partyKind: 'SUBCONTRACTOR',
      partyName: String(supplier?.state.legalName ?? 'A subcontractor'),
      supplierId: supplier?.refId ?? 'supplier-1',
      packageId,
    });

    const matrix = responsibility.responsibilityMatrix(freshPm());
    const concern = matrix.concerns.find((c) => c.kind === 'SCOPE_DOUBLE_ASSIGNED');
    assert.ok(concern, 'one package held by two parties was not reported');
    assert.match(concern.consequence, /One will be paid for doing it and the other has a claim/);
  });

  it('reports a shared design responsibility that was never split', async () => {
    const { pm: freshPm } = await estate();
    structure.createScopePackage(freshPm(), {
      name: 'Mechanical valve gallery',
      discipline: 'MECHANICAL',
      scopeOfWorks: 'Valve gallery mechanical installation and commissioning.',
      inclusions: ['Actuator installation'],
      exclusions: [],
      acceptanceCriteria: ['Functional test passed'],
      estimatedValueMinor: 80_000_000,
      // The single most common origin of "I thought you were doing it".
      designResponsibility: 'SHARED',
    });

    const matrix = responsibility.responsibilityMatrix(freshPm());
    const concern = matrix.concerns.find((c) => c.kind === 'SHARED_DESIGN_UNSPLIT');
    assert.ok(concern, 'a shared design responsibility with no split was not reported');
    assert.match(concern.consequence, /answer to who pays and not to who draws it/);
  });

  it('stops reporting it once the split is recorded', async () => {
    const { pm: freshPm } = await estate();
    const { packageId } = structure.createScopePackage(freshPm(), {
      name: 'Mechanical valve gallery',
      discipline: 'MECHANICAL',
      scopeOfWorks: 'Valve gallery mechanical installation and commissioning.',
      inclusions: ['Actuator installation'],
      exclusions: [],
      acceptanceCriteria: ['Functional test passed'],
      estimatedValueMinor: 80_000_000,
      designResponsibility: 'SHARED',
    });
    responsibility.assignResponsibility(freshPm(), {
      reference: 'RM-DS-01',
      description: 'Gallery pipework general arrangement drawings',
      category: 'DESIGN',
      partyKind: 'PRINCIPAL_CONTRACTOR',
      partyName: 'Meridian Infrastructure Group Ltd',
      packageId,
    });

    const matrix = responsibility.responsibilityMatrix(freshPm());
    assert.equal(
      matrix.concerns.filter((c) => c.kind === 'SHARED_DESIGN_UNSPLIT').length,
      0,
      'a split design responsibility is still reported as unsplit',
    );
  });

  it('reports a client obligation that has gone past its date', async () => {
    const { pm: freshPm } = await estate();
    responsibility.assignResponsibility(freshPm(), {
      reference: 'RM-CL-01',
      description: 'Reservoir drawdown consent',
      category: 'PERMIT_OR_CONSENT',
      partyKind: 'CLIENT',
      partyName: 'Yorkshire Water Services Limited',
      dueBy: '2026-01-15',
      source: 'Contract cl. 3.1',
    });

    const matrix = responsibility.responsibilityMatrix(freshPm(), '2026-06-01T00:00:00Z');
    const concern = matrix.concerns.find((c) => c.kind === 'OBLIGATION_UNDATED');
    assert.ok(concern, 'a client obligation past its date was not reported');
    assert.match(concern.consequence, /most common root of a contractor delay claim/);
    assert.match(concern.consequence, /notice clock/);
  });

  it('says something different when the party is one this business answers for', async () => {
    // The consequence is not the same sentence with a different name in it: a
    // client obligation missed is a claim this business makes, and one missed
    // by a firm working under it is this business's own delay.
    const { pm: freshPm } = await estate();
    responsibility.assignResponsibility(freshPm(), {
      reference: 'RM-PC-01',
      description: 'Decision on the crest finish',
      category: 'DECISION',
      partyKind: 'PRINCIPAL_CONTRACTOR',
      partyName: 'Meridian Infrastructure Group Ltd',
      dueBy: '2026-01-15',
    });

    const matrix = responsibility.responsibilityMatrix(freshPm(), '2026-06-01T00:00:00Z');
    const concern = matrix.concerns.find((c) => c.kind === 'OBLIGATION_UNDATED');
    assert.ok(concern);
    assert.match(concern.consequence, /this business’s delay/);
  });

  it('says so plainly when there is nothing outstanding', async () => {
    const { pm: freshPm } = await estate();
    const matrix = responsibility.responsibilityMatrix(freshPm());
    assert.deepEqual(matrix.concerns, []);
    assert.match(matrix.summary, /Nothing is recorded against a party/);
  });
});

// ── Moving one ──────────────────────────────────────────────────────────────

describe('moving a duty is a position, and is recorded as one', () => {
  it('keeps the line, records who it moved from, and demands a reason', async () => {
    const { pm: freshPm, platform: fresh } = await estate();
    const { itemId } = responsibility.assignResponsibility(freshPm(), {
      reference: 'RM-MV-01',
      description: 'Existing services diversion',
      category: 'EXISTING_SERVICES',
      partyKind: 'CLIENT',
      partyName: 'Yorkshire Water Services Limited',
      dueBy: '2027-02-01',
    });

    throwsCode(
      () => responsibility.reassignResponsibility(freshPm(), itemId, {
        partyKind: 'PRINCIPAL_CONTRACTOR',
        partyName: 'Meridian Infrastructure Group Ltd',
        reason: 'moved',
      }),
      'RESPONSIBILITY_REASON_REQUIRED',
    );

    const moved = responsibility.reassignResponsibility(freshPm(), itemId, {
      partyKind: 'PRINCIPAL_CONTRACTOR',
      partyName: 'Meridian Infrastructure Group Ltd',
      reason: 'Agreed at the March progress meeting in exchange for an extension of time',
    });

    assert.equal(moved.from.kind, 'CLIENT');
    assert.equal(moved.to.kind, 'PRINCIPAL_CONTRACTOR');

    // The history is the point: "it was always theirs" and "we moved it to them
    // in March" are different positions, and a matrix that overwrote the first
    // could not tell them apart.
    const state = fresh.ledger.require({ refType: 'ResponsibilityItem', refId: itemId }).state;
    assert.equal((state.reassignedFrom as { kind: string }).kind, 'CLIENT');
    assert.match(String(state.reassignmentReason), /March progress meeting/);

    const events = fresh.ledger
      .eventsForEntity({ refType: 'ResponsibilityItem', refId: itemId })
      .map((event) => event.eventType);
    assert.deepEqual(events, ['RESPONSIBILITY_ASSIGNED', 'RESPONSIBILITY_REASSIGNED']);
  });
});
