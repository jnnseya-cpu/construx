import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import * as structure from '../src/domain/structure.ts';
import {
  CHAIN_EXCEPTION_ROLES,
  consistencyReport,
  escalateChainBreaks,
} from '../src/domain/consistency.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The chain, and what happens when it breaks.
 *
 * Bid → Contract → Subcontract → Commitment → Application → CVR is one enforced
 * data flow, and the rule is that a break anywhere raises an exception to the
 * Commercial Manager. Every other consistency check compares two records that
 * *disagree*; this one looks for a record that is **unattached** — money
 * committed against nothing, an application outside every cycle, a CVR whose
 * contract sum came from a place no longer traceable.
 *
 * An orphan is quieter than a disagreement and worse. A disagreement is two
 * numbers that do not match, and somebody eventually notices. An orphan looks
 * entirely correct on its own screen and simply never reaches the screen
 * downstream.
 *
 * The first draft of this check named fields that did not exist — `estimateId`
 * on a Contract, `subcontractId` on a Commitment — and would have reported a
 * total break on a perfectly connected project. The keys asserted below are the
 * ones the writing engines actually set, which is not always the name the link
 * suggests: a Commitment names its subcontract in a field called `contractId`,
 * because a commitment can stand against either.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

const ctx = (who = 'qs', projectId = seed.projectId) => platform.context(seed.users[who]!.auth, projectId);

const CHAIN_CHECKS = [
  'Contract from the winning bid',
  'Subcontract from the awarded enquiry',
  'Commitment against a subcontract',
  'Payment cycle against the contract',
  'Application against a payment cycle',
  'CVR from the contract',
];

/** A project with nothing on it, for testing what a link does when it cannot run. */
function bareProject(name: string): string {
  const admin = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const portfolios = platform.ledger.listByTenant(seed.tenantId, 'Portfolio');
  return structure.createProject(admin, {
    portfolioId: String(portfolios[0]!.state.id),
    name,
    sectorType: 'TRANSPORT',
    assetType: 'Pumping station',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Derby' },
    contractValueMinor: 500_000_00,
    currency: 'GBP',
    plannedStart: '2027-01-04',
    plannedCompletion: '2027-10-01',
  }).projectId;
}

describe('the chain is checked by reference, not by count', () => {
  it('finds every link on the seeded project traceable end to end', () => {
    // The seeded project runs the whole flow through the real engines. If any
    // link here reports a break, either the seed is broken or the check is
    // asserting a field the engines do not write — and the second is the
    // failure mode that matters, because it fires on every customer at once.
    const report = consistencyReport(ctx());

    for (const check of CHAIN_CHECKS) {
      const broke = report.findings.find((finding) => finding.check === check);
      assert.equal(broke, undefined, `${check} reported a break on a project built by the engines themselves`);
    }
  });

  it('actually ran the links rather than skipping all of them', () => {
    // A check that skips everything would pass the test above while proving
    // nothing. At least one link must have real records behind it.
    const report = consistencyReport(ctx());
    const ran = CHAIN_CHECKS.filter((check) => report.passed.some((entry) => entry.startsWith(check)));

    assert.ok(ran.length > 0, `no chain link ran; all of them skipped: ${JSON.stringify(report.skipped)}`);
  });

  it('names how many of how many, so a partial break is not read as total', () => {
    const report = consistencyReport(ctx());
    const passed = report.passed.filter((entry) => CHAIN_CHECKS.some((check) => entry.startsWith(check)));

    for (const entry of passed) assert.match(entry, /all traceable/);
  });
});

describe('a link with nothing to attach to is skipped, not failed', () => {
  it('skips every link on a project with no commercial records at all', () => {
    const report = consistencyReport(ctx('qs', bareProject('Nothing procured')));

    for (const check of CHAIN_CHECKS) {
      assert.ok(
        report.skipped.some((entry) => entry.check === check),
        `${check} was not skipped on a project with no records`,
      );
      assert.equal(report.findings.find((finding) => finding.check === check), undefined);
    }
  });

  it('says which record is missing rather than reporting a generic gap', () => {
    const report = consistencyReport(ctx('qs', bareProject('Nothing procured either')));
    const skipped = report.skipped.find((entry) => entry.check === 'CVR from the contract')!;

    assert.match(skipped.reason, /No CVR record exists yet/);
  });
});

describe('an unattached record is found and priced', () => {
  it('finds a commitment that names no subcontract, and totals what is committed', () => {
    // Written straight to the ledger rather than through `executeSubcontract`,
    // because the engine cannot produce this — which is the point. A break
    // arrives from an import, a migration or a hand-corrected record, and the
    // check has to find it whatever door it came through.
    const project = bareProject('An orphan commitment');
    const admin = platform.context(seed.users.admin!.auth, project, { source: 'WEB' });
    const subcontracts = platform.ledger.list(seed.projectId, 'Subcontract');
    assert.ok(subcontracts.length > 0, 'the seed produced no subcontract to copy');

    // One real subcontract on this project, so the link has an upstream and
    // therefore runs rather than skipping.
    platform.ledger.commit({
      eventType: 'SUBCONTRACT_ASSEMBLED',
      entity: { refType: 'Subcontract', refId: 'SC-REAL' },
      nextState: { id: 'SC-REAL', projectId: project, rfqId: 'RFQ-1', valueMinor: 100_000_00, status: 'ASSEMBLED' },
      tenantId: seed.tenantId,
      projectId: project,
      actor: { refType: 'User', refId: admin.auth.actorId },
      source: 'WEB',
      correlationId: 'test-orphan',
    });
    platform.ledger.commit({
      eventType: 'COMMITMENT_RAISED',
      entity: { refType: 'Commitment', refId: 'CMT-ORPHAN' },
      nextState: {
        id: 'CMT-ORPHAN',
        projectId: project,
        type: 'SUBCONTRACT',
        // No contractId at all. Never linked.
        valueMinor: 250_000_00,
        status: 'ACTIVE',
      },
      tenantId: seed.tenantId,
      projectId: project,
      actor: { refType: 'User', refId: admin.auth.actorId },
      source: 'WEB',
      correlationId: 'test-orphan',
    });

    const finding = consistencyReport(ctx('qs', project)).findings.find(
      (entry) => entry.check === 'Commitment against a subcontract',
    );

    assert.ok(finding, 'a commitment attached to nothing was not found');
    assert.equal(finding.severity, 'CRITICAL');
    assert.equal(finding.exposureMinor, 250_000_00, 'the money standing behind the break was not totalled');
    assert.match(finding.finding, /1 of 1 Commitment record/);
    assert.match(finding.consequence, /committed against nothing/);
    assert.deepEqual(finding.sources, [{ refType: 'Commitment', refId: 'CMT-ORPHAN' }]);
  });

  it('counts a dangling reference as a break, not only an absent one', () => {
    // Two different mistakes: one was never linked, the other points at
    // something that is not there. A check that only caught the first would
    // pass a record whose subcontract has since been superseded.
    const project = bareProject('A dangling reference');
    const admin = platform.context(seed.users.admin!.auth, project, { source: 'WEB' });

    for (const [refType, refId, state] of [
      ['Subcontract', 'SC-EXISTS', { id: 'SC-EXISTS', rfqId: 'RFQ-1', valueMinor: 10_000_00 }],
      ['Commitment', 'CMT-DANGLING', { id: 'CMT-DANGLING', type: 'SUBCONTRACT', contractId: 'SC-DELETED', valueMinor: 40_000_00 }],
    ] as const) {
      platform.ledger.commit({
        eventType: refType === 'Subcontract' ? 'SUBCONTRACT_ASSEMBLED' : 'COMMITMENT_RAISED',
        entity: { refType, refId },
        nextState: { ...state, projectId: project },
        tenantId: seed.tenantId,
        projectId: project,
        actor: { refType: 'User', refId: admin.auth.actorId },
        source: 'WEB',
        correlationId: 'test-dangling',
      });
    }

    const finding = consistencyReport(ctx('qs', project)).findings.find(
      (entry) => entry.check === 'Commitment against a subcontract',
    );

    assert.ok(finding, 'a commitment pointing at a subcontract that does not exist was not found');
    assert.equal(finding.exposureMinor, 40_000_00);
  });

  it('withholds the money from a role with no commercial clearance and keeps the break', () => {
    // A safety lead should know the chain is broken — that is a fact about the
    // job. What they have no business reading is what is standing behind it.
    const project = bareProject('Withheld exposure');
    const admin = platform.context(seed.users.admin!.auth, project, { source: 'WEB' });

    for (const [refType, refId, state] of [
      ['Subcontract', 'SC-W', { id: 'SC-W', rfqId: 'RFQ-1' }],
      ['Commitment', 'CMT-W', { id: 'CMT-W', type: 'SUBCONTRACT', valueMinor: 99_000_00 }],
    ] as const) {
      platform.ledger.commit({
        eventType: refType === 'Subcontract' ? 'SUBCONTRACT_ASSEMBLED' : 'COMMITMENT_RAISED',
        entity: { refType, refId },
        nextState: { ...state, projectId: project },
        tenantId: seed.tenantId,
        projectId: project,
        actor: { refType: 'User', refId: admin.auth.actorId },
        source: 'WEB',
        correlationId: 'test-withheld',
      });
    }

    const restricted = consistencyReport(platform.context(seed.users.safety!.auth, project));
    const finding = restricted.findings.find((entry) => entry.check === 'Commitment against a subcontract');

    assert.ok(finding, 'the break itself was hidden, not just the money');
    assert.equal(finding.exposureMinor, undefined);
    assert.match(finding.consequence, /withheld from this role/);
  });
});

describe('the break raises an exception rather than waiting to be read', () => {
  /**
   * A project carrying one unattached commitment, ready to escalate.
   *
   * The ids are suffixed per project. An entity reference is unique across the
   * tenancy, not within a project — reusing `SC-E` on a second project is a
   * tenant isolation breach, and the ledger refuses it, correctly.
   */
  function brokenProject(name: string, suffix: string): { project: string; subcontractId: string } {
    const project = bareProject(name);
    const admin = platform.context(seed.users.admin!.auth, project, { source: 'WEB' });
    const subcontractId = `SC-${suffix}`;

    for (const [refType, refId, state] of [
      ['Subcontract', subcontractId, { id: subcontractId, rfqId: 'RFQ-1' }],
      // Pointed at a subcontract that is not there — a dangling reference, so
      // the fix in the clearing test is to supply the record it names rather
      // than to rewrite the commitment (which the catalogue would refuse: a
      // COMMITMENT_RAISED event creates, and the entity already exists).
      [
        'Commitment',
        `CMT-${suffix}`,
        { id: `CMT-${suffix}`, type: 'SUBCONTRACT', contractId: `SC-MISSING-${suffix}`, valueMinor: 175_000_00 },
      ],
    ] as const) {
      platform.ledger.commit({
        eventType: refType === 'Subcontract' ? 'SUBCONTRACT_ASSEMBLED' : 'COMMITMENT_RAISED',
        entity: { refType, refId },
        nextState: { ...state, projectId: project },
        tenantId: seed.tenantId,
        projectId: project,
        actor: { refType: 'User', refId: admin.auth.actorId },
        source: 'WEB',
        correlationId: `test-${suffix}`,
      });
    }
    return { project, subcontractId };
  }

  it('records the exception, carrying the finding and who is owed it', () => {
    // Recorded rather than only sent. An alert that exists in an inbox and
    // nowhere else cannot be shown as open, cannot be shown as closed, and
    // cannot be counted.
    const { project } = brokenProject('Escalates', 'ESC');
    const escalation = escalateChainBreaks(ctx('qs', project));

    assert.equal(escalation.raised.length, 1);
    const raised = escalation.raised[0]!;
    assert.equal(raised.check, 'Commitment against a subcontract');
    assert.equal(raised.exposureMinor, 175_000_00);
    assert.deepEqual(raised.sources, [{ refType: 'Commitment', refId: 'CMT-ESC' }]);

    // The requirement names the Commercial Manager. The record says so.
    assert.ok(CHAIN_EXCEPTION_ROLES.includes('COMMERCIAL_MANAGER'));
    assert.deepEqual(escalation.owedTo, CHAIN_EXCEPTION_ROLES);

    const stored = platform.ledger.list(project, 'ChainException');
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.state.status, 'OPEN');
    assert.deepEqual(stored[0]!.state.owedTo, [...CHAIN_EXCEPTION_ROLES]);
  });

  it('raises the same break once, however many times it runs', () => {
    // An escalation that re-fires on every sweep is one people filter to a
    // folder — and then the one that mattered goes to the folder too.
    const { project } = brokenProject('Raised once', 'ONCE');

    const first = escalateChainBreaks(ctx('qs', project));
    const second = escalateChainBreaks(ctx('qs', project));
    const third = escalateChainBreaks(ctx('qs', project));

    assert.equal(first.raised.length, 1);
    assert.equal(second.raised.length, 0);
    assert.equal(third.raised.length, 0);

    // Not re-raised, and not hidden either — the break is still reported open.
    assert.deepEqual(second.alreadyOpen, ['Commitment against a subcontract']);
    assert.equal(second.open.length, 1);
    assert.equal(platform.ledger.list(project, 'ChainException').length, 1);
  });

  it('closes the exception itself once the link traces again', () => {
    // Nobody has to remember to tidy up after a fix, which is what makes an
    // exception still open evidence of a break that is still real.
    const { project } = brokenProject('Self closing', 'CLEAR');
    assert.equal(escalateChainBreaks(ctx('qs', project)).raised.length, 1);

    // Supply the subcontract the commitment was pointing at all along.
    platform.ledger.commit({
      eventType: 'SUBCONTRACT_ASSEMBLED',
      entity: { refType: 'Subcontract', refId: 'SC-MISSING-CLEAR' },
      nextState: { id: 'SC-MISSING-CLEAR', projectId: project, rfqId: 'RFQ-1', valueMinor: 175_000_00 },
      tenantId: seed.tenantId,
      projectId: project,
      actor: { refType: 'User', refId: seed.users.admin!.auth.actorId },
      source: 'WEB',
      correlationId: 'test-clear-fix',
    });

    const escalation = escalateChainBreaks(ctx('qs', project));

    assert.deepEqual(escalation.cleared, ['Commitment against a subcontract']);
    assert.equal(escalation.open.length, 0);
    assert.equal(platform.ledger.list(project, 'ChainException')[0]!.state.status, 'CLEARED');
  });

  it('raises nothing on a project whose chain is whole', () => {
    const escalation = escalateChainBreaks(ctx());

    assert.deepEqual(escalation.raised, []);
    assert.deepEqual(escalation.open, []);
  });

  it('lets the Commercial Manager run it, which is the role it exists for', () => {
    // The Commercial Manager holds approval rather than authorship in this
    // area. An escalation gated behind authorship would lock out the person the
    // exception is addressed to.
    const { project } = brokenProject('Commercial manager runs it', 'CM');
    const auth = { ...seed.users.qs!.auth, roles: ['COMMERCIAL_MANAGER' as const] };

    const escalation = escalateChainBreaks(platform.context(auth, project));
    assert.equal(escalation.raised.length, 1);
  });

  it('refuses a role with no commercial clearance at all', () => {
    // The exception names unattached money. Reading it is reading the
    // commercial position, so the door is the same one.
    const { project } = brokenProject('No clearance', 'REF');

    assert.throws(
      () => escalateChainBreaks(platform.context(seed.users.safety!.auth, project)),
      /forbidden|permission|denied|BUDGET_COST/i,
    );
  });
});

describe('the report still writes nothing', () => {
  it('separates detecting from escalating, so reading the report raises no alert', () => {
    // The report answers "what disagrees"; the escalation answers "who has been
    // told". Collapsing them would mean opening a screen sent somebody an
    // exception, and every dashboard refresh would be an alert.
    const project = bareProject('Read only');
    const before = platform.ledger.list(project, 'ChainException').length;

    consistencyReport(ctx('qs', project));
    consistencyReport(ctx('qs', project));

    assert.equal(platform.ledger.list(project, 'ChainException').length, before);
  });
});

describe('the door the console actually calls', () => {
  it('raises the exception over HTTP and reports what it did', async () => {
    // Exercised through the gateway rather than the engine, because the route
    // is where authorisation, the schema and the notification are wired — and a
    // green engine test says nothing about any of the three.
    const project = bareProject('Over the wire');
    const admin = platform.context(seed.users.admin!.auth, project, { source: 'WEB' });

    for (const [refType, refId, state] of [
      ['Subcontract', 'SC-HTTP', { id: 'SC-HTTP', rfqId: 'RFQ-1' }],
      ['Commitment', 'CMT-HTTP', { id: 'CMT-HTTP', type: 'SUBCONTRACT', valueMinor: 60_000_00 }],
    ] as const) {
      platform.ledger.commit({
        eventType: refType === 'Subcontract' ? 'SUBCONTRACT_ASSEMBLED' : 'COMMITMENT_RAISED',
        entity: { refType, refId },
        nextState: { ...state, projectId: project },
        tenantId: seed.tenantId,
        projectId: project,
        actor: { refType: 'User', refId: admin.auth.actorId },
        source: 'WEB',
        correlationId: 'test-http',
      });
    }

    const response = await fetch(`${base}/v1/projects/${project}/consistency/chain-exceptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('qs')}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const body = (await response.json()) as {
      raised: Array<{ check: string; exposureMinor?: number }>;
      unaddressed: boolean;
    };

    assert.equal(response.status, 201, `${response.status}: ${JSON.stringify(body)}`);
    assert.equal(body.raised.length, 1);
    assert.equal(body.raised[0]!.check, 'Commitment against a subcontract');
    assert.equal(body.raised[0]!.exposureMinor, 60_000_00);
  });

  it('refuses the write to a role with no commercial clearance, as a denial rather than a zero', async () => {
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/consistency/chain-exceptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenFor('safety')}`, 'content-type': 'application/json' },
      body: '{}',
    });

    assert.equal(response.status, 403);
    // RFC 7807: the machine-readable code is the title, and a denial must never
    // come back as an empty successful result.
    const problem = (await response.json()) as { title?: string };
    assert.ok(problem.title, 'the denial carries no code');
  });
});
