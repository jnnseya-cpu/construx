import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { openEngagement } from '../src/domain/consultancy/store.ts';
import {
  claimLineage,
  evidenceRegister,
  recordClaim,
  registerEvidence,
  supersedeEvidence,
} from '../src/domain/consultancy/evidence.ts';
import type { MinimumIntake } from '../src/domain/consultancy/engagement.ts';

/**
 * Evidence and lineage: a claim traces to a cited source, assumption or
 * calculation, and cannot be recorded against nothing or against a source that
 * has been superseded. The spec's completion measure — every released finding
 * traces to a cited source, governed assumption or reproducible calculation —
 * made checkable.
 */

let platform: Platform;
let seed: SeedResult;
const ctx = (): EngineContext => platform.context(seed.users.admin!.auth, seed.projectId, { correlationId: 'ev-test' });

const INTAKE: MinimumIntake = {
  decisionRequested: 'Reinstate hourly + Sunday service',
  decisionAuthority: 'North Lincolnshire Council',
  client: 'North Lincolnshire Council',
  partySide: 'CLIENT',
  assetOrService: 'Doncaster–Scunthorpe rail service',
  location: 'North Lincolnshire',
};

function newEngagement(): string {
  return openEngagement(ctx(), { route: 'DELIVER_COMMISSION', assignment: 'COMBINED', intake: INTAKE }).engagementId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('registering evidence', () => {
  it('registers a source with its locator, authority and confidence, and lists it on the register', () => {
    const eng = newEngagement();
    const { evidenceId } = registerEvidence(ctx(), eng, {
      source: 'ORR station usage 2024-25', locator: 'table 2, p.4', authority: 'ORR', confidence: 'HIGH',
    });
    const register = evidenceRegister(ctx(), eng);
    const e = register.find((x) => x.id === evidenceId)!;
    assert.equal(e.source, 'ORR station usage 2024-25');
    assert.equal(e.authority, 'ORR');
    assert.equal(e.status, 'CURRENT');
    assert.equal(e.confidence, 'HIGH');
  });

  it('defaults confidence to UNVERIFIED when none is given', () => {
    const eng = newEngagement();
    const { evidenceId } = registerEvidence(ctx(), eng, { source: 'Operator email, undated' });
    assert.equal(evidenceRegister(ctx(), eng).find((x) => x.id === evidenceId)!.confidence, 'UNVERIFIED');
  });
});

describe('recording a claim with lineage', () => {
  it('records a claim that cites a current source, and the lineage resolves it', () => {
    const eng = newEngagement();
    const { evidenceId } = registerEvidence(ctx(), eng, { source: 'MOIRA2 demand run', confidence: 'MEDIUM' });
    const { claimId } = recordClaim(ctx(), eng, { statement: 'Forecast demand supports an hourly service', sourceRefs: [evidenceId] });
    const lineage = claimLineage(ctx(), claimId);
    assert.equal(lineage.claim.statement, 'Forecast demand supports an hourly service');
    assert.equal(lineage.evidence.length, 1);
    assert.equal(lineage.evidence[0]!.source, 'MOIRA2 demand run');
    assert.equal(lineage.supersededSince.length, 0);
  });

  it('refuses a claim that cites nothing — no unsupported finding', () => {
    const eng = newEngagement();
    assert.throws(
      () => recordClaim(ctx(), eng, { statement: 'The service will succeed' }),
      (e) => (e as { code?: string }).code === 'UNSUPPORTED_CLAIM',
    );
  });

  it('accepts a claim supported only by an assumption or calculation (not just a source)', () => {
    const eng = newEngagement();
    const { claimId } = recordClaim(ctx(), eng, { statement: 'Break-even at 150,000 uses', calculationRefs: ['calc_breakeven'] });
    assert.equal(claimLineage(ctx(), claimId).calculationRefs[0], 'calc_breakeven');
  });

  it('refuses a claim that cites an unknown source', () => {
    const eng = newEngagement();
    assert.throws(
      () => recordClaim(ctx(), eng, { statement: 'x', sourceRefs: ['not-a-real-id'] }),
      (e) => (e as { code?: string }).code === 'UNKNOWN_EVIDENCE',
    );
  });

  it('refuses a claim that cites a superseded source — no silent reuse of a stale fact', () => {
    const eng = newEngagement();
    const { evidenceId } = registerEvidence(ctx(), eng, { source: 'Draft timetable v1' });
    supersedeEvidence(ctx(), evidenceId);
    assert.throws(
      () => recordClaim(ctx(), eng, { statement: 'Paths are available', sourceRefs: [evidenceId] }),
      (e) => (e as { code?: string }).code === 'SUPERSEDED_SOURCE',
    );
  });

  it('shows on the lineage when a cited source is superseded after the claim was made', () => {
    const eng = newEngagement();
    const { evidenceId } = registerEvidence(ctx(), eng, { source: 'Cost estimate rev A' });
    const { claimId } = recordClaim(ctx(), eng, { statement: 'Affordable within the grant', sourceRefs: [evidenceId] });
    // The ground moves after the claim was recorded.
    supersedeEvidence(ctx(), evidenceId);
    const lineage = claimLineage(ctx(), claimId);
    assert.deepEqual(lineage.supersededSince, [evidenceId], 'the lineage flags the source that has since been superseded');
  });

  it('scopes the evidence register to its engagement', () => {
    const a = newEngagement();
    const b = newEngagement();
    registerEvidence(ctx(), a, { source: 'A-only source' });
    assert.ok(evidenceRegister(ctx(), b).every((e) => e.source !== 'A-only source'));
  });
});
