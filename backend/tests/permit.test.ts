import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { issuePermit, permitRequirements } from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import { throwsCode } from './helpers.ts';

/**
 * Permits to work.
 *
 * The competency register existed and nothing consulted it, so a permit could
 * name an operative whose confined-space ticket lapsed eight months ago and the
 * platform would record it as a control.
 *
 * This is the one place in the codebase that refuses rather than records. A
 * permit *is* the authorisation: issuing one against an expired ticket does not
 * document a risk, it creates the authority the ticket was the basis for. There
 * is nothing to preserve, because the thing being written is the harm.
 */

let platform: Platform;
let seed: SeedResult;
let ramsId: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  ramsId = platform.ledger
    .list(seed.projectId, 'RAMS')
    .filter((r) => r.state.status === 'APPROVED')
    .at(-1)!.refId;
});

const hse = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });

function competency(operativeId: string, qualification: string, expiresAt: string) {
  platform.ledger.commit({
    tenantId: seed.tenantId,
    projectId: seed.projectId,
    actor: { refType: 'User', refId: seed.users.safety!.id },
    source: 'WEB',
    correlationId: `test-${operativeId}-${qualification}`,
    eventType: 'COMPETENCY_RECORDED',
    entity: { refType: 'Competency', refId: `comp-${operativeId}-${qualification.replace(/\s/g, '')}` },
    evidenceRefs: [{ refType: 'Evidence', refId: `sha256:${'c'.repeat(64)}` }],
    nextState: { operativeId, qualification, issuedAt: '2025-01-01', expiresAt, status: 'IN_DATE' },
    timestamp: new Date().toISOString(),
  });
}

const permit = (over: Partial<Parameters<typeof issuePermit>[1]> = {}) =>
  issuePermit(hse(), {
    activity: 'CONFINED_SPACE',
    location: 'Wet well, pumping station 2',
    operativeIds: ['op-alpha'],
    validFrom: '2026-09-01',
    validTo: '2026-09-05',
    ramsId,
    precautions: 'Gas monitor, tripod and winch, top man in constant attendance',
    evidenceHash: `sha256:${'b'.repeat(64)}`,
    ...over,
  });

describe('competency gates the permit', () => {
  it('refuses an operative with no qualification for the activity', () => {
    throwsCode(() => permit({ operativeIds: ['op-unqualified'] }), 'PERMIT_COMPETENCY_NOT_HELD');
  });

  it('refuses a ticket that expires before the permit does', () => {
    // The failure a today-check would miss entirely: valid this morning, lapsed
    // on the Wednesday, and the permit runs to Friday.
    competency('op-lapsing', 'Confined space entry', '2026-09-03');
    throwsCode(
      () => permit({ operativeIds: ['op-lapsing'], validTo: '2026-09-05' }),
      'PERMIT_COMPETENCY_NOT_HELD',
    );
  });

  it('issues where the qualification covers the whole permit', () => {
    competency('op-alpha', 'Confined space entry', '2027-06-30');
    const result = permit();
    assert.ok(result.reference.startsWith('PTW-'));
    assert.equal(result.authorisedOperatives, 1);
  });

  it('checks every operative, not just the first', () => {
    // A gang of six where the fifth ticket lapsed is the realistic failure.
    competency('op-bravo', 'Confined space entry', '2027-06-30');
    throwsCode(
      () => permit({ operativeIds: ['op-alpha', 'op-bravo', 'op-unqualified'] }),
      'PERMIT_COMPETENCY_NOT_HELD',
    );
  });

  it('accepts any of the qualifications an activity recognises', () => {
    // Work at height is IPAF or PASMA or a general ticket — not one card.
    competency('op-charlie', 'IPAF 3a operator', '2027-06-30');
    const result = permit({ activity: 'WORK_AT_HEIGHT', operativeIds: ['op-charlie'] });
    assert.equal(result.authorisedOperatives, 1);
  });
});

describe('what else a permit needs', () => {
  it('refuses a permit under a method statement nobody approved', () => {
    const draft = platform.ledger.list(seed.projectId, 'RAMS').find((r) => r.state.status !== 'APPROVED');
    if (draft) {
      competency('op-delta', 'Confined space entry', '2027-06-30');
      throwsCode(() => permit({ ramsId: draft.refId, operativeIds: ['op-delta'] }), 'PERMIT_RAMS_NOT_APPROVED');
    }
  });

  it('refuses a permit naming nobody', () => {
    throwsCode(() => permit({ operativeIds: [] }), 'PERMIT_NO_OPERATIVES');
  });

  it('refuses a permit that ends before it starts', () => {
    competency('op-echo', 'Confined space entry', '2027-06-30');
    throwsCode(
      () => permit({ operativeIds: ['op-echo'], validFrom: '2026-09-10', validTo: '2026-09-01' }),
      'VALIDATION_FAILED',
    );
  });
});

describe('the requirements are published', () => {
  it('says what each activity needs, so a form can explain a refusal', () => {
    const requirements = permitRequirements();
    assert.ok(requirements.length >= 6);
    for (const entry of requirements) {
      assert.ok(entry.requires.length > 0, `${entry.activity} requires nothing`);
    }
  });
});
