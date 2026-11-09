import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { openEngagement } from '../src/domain/consultancy/store.ts';
import { registerEvidence, supersedeEvidence } from '../src/domain/consultancy/evidence.ts';
import { promoteAward, release, triggerReappraisal } from '../src/domain/consultancy/lifecycle.ts';
import type { MinimumIntake } from '../src/domain/consultancy/engagement.ts';

/**
 * The late lifecycle: award promotion (C05), reappraisal (C08) and the controlled
 * release (C09/C11/C14). The spec's safety rules made checkable — only authorised
 * commitments transfer, the approved baseline persists through a reappraisal, a
 * superseded source blocks a release, a retry yields one side effect, and a
 * revoked permission fails before exposure.
 */

let platform: Platform;
let seed: SeedResult;
const admin = (): EngineContext => platform.context(seed.users.admin!.auth, seed.projectId, { correlationId: 'lc-test' });
const pm = (): EngineContext => platform.context(seed.users.pm!.auth, seed.projectId, { correlationId: 'lc-test' });

const INTAKE: MinimumIntake = {
  decisionRequested: 'Reinstate hourly + Sunday service',
  decisionAuthority: 'North Lincolnshire Council',
  client: 'North Lincolnshire Council',
  partySide: 'BIDDER',
  assetOrService: 'Doncaster–Scunthorpe rail service',
  location: 'North Lincolnshire',
};

const newEngagement = () => openEngagement(admin(), { route: 'RESPOND_TO_RFQ', assignment: 'COMBINED', intake: INTAKE }).engagementId;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('award promotion (C05)', () => {
  it('links the winning bid and signed terms and transfers only the named commitments', () => {
    const eng = newEngagement();
    const { workflowState, award } = promoteAward(admin(), eng, {
      winningBidRef: 'BID-0007', signedTermsRef: 'TERMS-signed-2026-12', transferredCommitments: ['fee', 'programme'],
    });
    assert.equal(workflowState, 'ISSUED');
    assert.equal(award.winningBidRef, 'BID-0007');
    assert.equal(award.signedTermsRef, 'TERMS-signed-2026-12');
    assert.deepEqual(award.transferredCommitments, ['fee', 'programme']);
  });

  it('refuses an award with no signed terms to reconcile against', () => {
    const eng = newEngagement();
    assert.throws(
      () => promoteAward(admin(), eng, { winningBidRef: 'BID-1', signedTermsRef: '' }),
      (e) => (e as { code?: string }).code === 'NO_SIGNED_TERMS',
    );
  });
});

describe('reappraisal (C08)', () => {
  it('produces the decision delta and keeps the approved baseline version', () => {
    const eng = newEngagement();
    const { delta, baselineVersion } = triggerReappraisal(admin(), eng, {
      event: 'Construction CAPEX increased at Stage 5',
      baseline: { capexMinor: 15_750_000, timeMonths: 43 },
      revised: { capexMinor: 17_000_000, timeMonths: 45 },
    });
    assert.equal(delta.capexMinor, 1_250_000, 'the CAPEX delta');
    assert.equal(delta.timeMonths, 2);
    assert.equal(baselineVersion, 1, 'the approved baseline version persists; the event does not overwrite it');
  });
});

describe('controlled release (C09/C11/C14)', () => {
  it('C09 — blocks a release whose cited source has been superseded, and issues once it is current', () => {
    const eng = newEngagement();
    const current = registerEvidence(admin(), eng, { source: 'Timetable v2' }).evidenceId;
    const stale = registerEvidence(admin(), eng, { source: 'Timetable v1' }).evidenceId;
    supersedeEvidence(admin(), stale);

    const blockedRes = release(admin(), eng, { idempotencyKey: 'rel-1', citedEvidenceIds: [current, stale] });
    assert.equal(blockedRes.released, false);
    if (blockedRes.released === false) assert.deepEqual(blockedRes.blocked, [stale]);

    const okRes = release(admin(), eng, { idempotencyKey: 'rel-2', citedEvidenceIds: [current] });
    assert.equal(okRes.released, true);
  });

  it('C11 — a repeated idempotency key yields one release, not two', () => {
    const eng = newEngagement();
    const before = admin().ledger.list(seed.projectId, 'ConsultancyRelease').length;
    const first = release(admin(), eng, { idempotencyKey: 'once' });
    const second = release(admin(), eng, { idempotencyKey: 'once' });
    assert.equal(first.released, true);
    assert.equal(second.released, true);
    if (first.released && second.released) {
      assert.equal(second.releaseId, first.releaseId, 'the retry returns the same release');
      assert.equal(second.duplicate, true);
    }
    const after = admin().ledger.list(seed.projectId, 'ConsultancyRelease').length;
    assert.equal(after - before, 1, 'only one release was written');
  });

  it('C14 — a release by an actor without issue authority fails before anything is exposed', () => {
    const eng = newEngagement();
    // PM holds BUSINESS_DEVELOPMENT read only, not approve/issue.
    assert.throws(() => release(pm(), eng, { idempotencyKey: 'rel-x' }));
  });
});
