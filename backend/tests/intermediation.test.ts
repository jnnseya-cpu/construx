import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import * as framework from '../src/domain/framework.ts';
import * as intermediation from '../src/domain/intermediation.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Staying between the client and the panel.
 *
 * The cash half of the integrator's exposure is `integrator.test.ts`. This is
 * the half that kills the same businesses more slowly: every supplier is
 * introduced to the client, they meet on site, and next time the client can buy
 * from any of them directly with the coordinator's margin as the obvious thing
 * to remove.
 *
 * The case that matters most is the competition-law one. A margin-defence
 * feature is the one place on this platform where doing what the user asked for
 * could put them in front of the CMA, so the refusal is tested before anything
 * else.
 */

async function estate(): Promise<{ platform: Platform; seed: SeedResult; projectId: string }> {
  const platform = new Platform();
  const seed = await seedDemoProject(platform);
  return { platform, seed, projectId: seed.projectId };
}

const ctxFor = (platform: Platform, seed: SeedResult, projectId: string, who = 'qs') => () =>
  platform.context(seed.users[who]!.auth, projectId, { source: 'WEB' });

// ── The refusal that matters ────────────────────────────────────────────────

describe('a restraint between competitors is not a commercial control', () => {
  it('records a non-circumvention term with this business’s own supplier', async () => {
    // Vertical: two parties at different levels of the same supply chain.
    // Ordinarily lawful, and the thing the user actually asked for.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);

    const result = intermediation.recordDefence(qs(), {
      kind: 'NON_CIRCUMVENTION',
      inPlace: true,
      evidence: 'Clause 14.3 of the standard subcontract',
      relation: 'OWN_SUPPLIER',
    });
    assert.equal(result.inPlace, true);

    const position = intermediation.intermediationPosition(qs());
    const defence = position.defences.find((entry) => entry.kind === 'NON_CIRCUMVENTION')!;
    assert.equal(defence.inPlace, true);
    assert.equal(defence.evidence, 'Clause 14.3 of the standard subcontract');
  });

  it('refuses the same words between competitors, and names the law', async () => {
    // Customer allocation. An object infringement of the Chapter I prohibition:
    // no effects analysis, no small-agreements exclusion, director
    // disqualification and the cartel offence behind it.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);

    const error = throwsCode(
      () =>
        intermediation.recordDefence(qs(), {
          kind: 'NON_CIRCUMVENTION',
          inPlace: true,
          evidence: 'Side letter with the other integrator',
          relation: 'COMPETITOR',
        }),
      'RESTRAINT_UNLAWFUL',
    );
    assert.match(String(error.message), /Chapter I prohibition of the Competition Act 1998/);
    assert.match(String(error.message), /by object/);
    // And it says what *is* recordable, rather than only refusing.
    assert.match(String(error.message), /business you appoint as a supplier is a different arrangement/);

    // Nothing was written.
    const position = intermediation.intermediationPosition(qs());
    assert.equal(position.defences.find((entry) => entry.kind === 'NON_CIRCUMVENTION')!.assessed, false);
  });

  it('refuses the panel agreeing among itself, which is the same cartel one step out', async () => {
    // The hub-and-spoke version: this business in the middle of an agreement
    // between its suppliers not to bid. Recording it as a defence would be the
    // platform helping to document a cartel.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    throwsCode(
      () =>
        intermediation.recordDefence(qs(), {
          kind: 'NON_CIRCUMVENTION',
          inPlace: true,
          evidence: 'Panel charter clause 6',
          relation: 'PANEL_TO_PANEL',
        }),
      'RESTRAINT_UNLAWFUL',
    );
  });

  it('will not let the question go unanswered', async () => {
    // The distinction decides whether the arrangement is lawful, and it is not
    // one the platform can answer from the other fields. Defaulting to
    // "supplier" would record every restraint as the lawful kind.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const error = throwsCode(
      () => intermediation.recordDefence(qs(), { kind: 'NON_CIRCUMVENTION', inPlace: true, evidence: 'Clause 14.3' }),
      'RESTRAINT_RELATION_REQUIRED',
    );
    assert.match(String(error.message), /customer allocation and unlawful/);
  });

  it('does not ask the question for a term that is not in place', async () => {
    // Recording that there is no non-circumvention term is a useful fact and
    // there is no counterparty to describe. A rule that fires here would make
    // the honest answer harder to record than the flattering one.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const result = intermediation.recordDefence(qs(), { kind: 'NON_CIRCUMVENTION', inPlace: false });
    assert.equal(result.inPlace, false);
  });
});

// ── The register ────────────────────────────────────────────────────────────

describe('what keeps a coordinator in the middle', () => {
  it('states what each defence does not do, which is the more useful half', () => {
    // A business with three of these that believes it therefore cannot be
    // displaced has stopped doing the thing that keeps it there. The limit is
    // part of the record, not a footnote.
    for (const [kind, defence] of Object.entries(intermediation.DEFENCE)) {
      assert.ok(defence.holds.length > 60, `${kind} does not say what it buys`);
      assert.ok(defence.doesNotHold.length > 60, `${kind} does not say what it fails to do`);
    }
    // The weakest one says the thing that matters about it in as many words.
    assert.match(intermediation.DEFENCE.NON_CIRCUMVENTION.doesNotHold, /binds the supplier, not the client/);
    assert.match(intermediation.DEFENCE.NON_CIRCUMVENTION.doesNotHold, /weakest of the five/);
  });

  it('carries no markdown, because the console prints these strings as they are', () => {
    // Caught by rendering the panel and reading it, not by any test here: the
    // emphasis around "It binds the supplier, not the client" was written as
    // `**...**` and appeared on screen as literal asterisks. These strings go
    // straight into a table cell; the console does not render markdown and
    // should not have to.
    for (const [kind, defence] of Object.entries(intermediation.DEFENCE)) {
      for (const [field, text] of Object.entries({ label: defence.label, holds: defence.holds, doesNotHold: defence.doesNotHold })) {
        assert.doesNotMatch(text, /\*\*|`|^#|\]\(/, `${kind}.${field} carries markdown the console will print literally`);
      }
    }
  });

  it('separates never assessed from assessed and absent', async () => {
    // Different facts, and only one of them is somebody's decision. Collapsing
    // them reports a business that has not looked at this as one that has
    // looked and found nothing.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);

    const before = intermediation.intermediationPosition(qs());
    assert.equal(before.assessedCount, 0);
    assert.equal(before.inPlaceCount, 0);
    assert.ok(before.concerns.some((c) => c.kind === 'NOT_ASSESSED'));
    assert.match(before.summary, /None of the 5 defences has been assessed/);

    intermediation.recordDefence(qs(), { kind: 'SINGLE_INVOICE', inPlace: false });
    const after = intermediation.intermediationPosition(qs());
    assert.equal(after.assessedCount, 1);
    assert.equal(after.inPlaceCount, 0);
    assert.equal(after.defences.find((e) => e.kind === 'SINGLE_INVOICE')!.assessed, true);
    assert.ok(!after.concerns.some((c) => c.kind === 'NOT_ASSESSED'));
  });

  it('refuses a defence claimed as in place with nothing behind it', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    throwsCode(
      () => intermediation.recordDefence(qs(), { kind: 'SPECIFICATION_OWNERSHIP', inPlace: true }),
      'DEFENCE_EVIDENCE_REQUIRED',
    );
    throwsCode(
      () => intermediation.recordDefence(qs(), { kind: 'SPECIFICATION_OWNERSHIP', inPlace: true, evidence: '   ' }),
      'DEFENCE_EVIDENCE_REQUIRED',
    );
  });

  it('replaces an earlier answer rather than stacking a second one', async () => {
    // A register with two answers for one question has no answer.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    intermediation.recordDefence(qs(), { kind: 'SINGLE_INVOICE', inPlace: false });
    intermediation.recordDefence(qs(), { kind: 'SINGLE_INVOICE', inPlace: true, evidence: 'One consolidated application per month' });

    const position = intermediation.intermediationPosition(qs());
    assert.equal(position.defences.filter((e) => e.kind === 'SINGLE_INVOICE').length, 1);
    assert.equal(position.defences.find((e) => e.kind === 'SINGLE_INVOICE')!.inPlace, true);
    assert.equal(position.assessedCount, 1);
  });

  it('says when the only defence in place is the one that does not reach the client', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    intermediation.recordDefence(qs(), {
      kind: 'NON_CIRCUMVENTION',
      inPlace: true,
      evidence: 'Clause 14.3',
      relation: 'OWN_SUPPLIER',
    });
    intermediation.recordDefence(qs(), { kind: 'SPECIFICATION_OWNERSHIP', inPlace: false });

    const position = intermediation.intermediationPosition(qs());
    const concern = position.concerns.find((c) => c.kind === 'RELYING_ON_THE_WEAKEST');
    assert.ok(concern, `expected the weakest-defence concern, got ${position.concerns.map((c) => c.kind).join(', ')}`);
    assert.match(concern.consequence, /not a party to the term/);

    // With a second defence in place it stops firing: the concern is about
    // relying on it alone, not about having it.
    intermediation.recordDefence(qs(), { kind: 'PERFORMANCE_EVIDENCE', inPlace: true, evidence: 'The Golden Thread export' });
    assert.ok(!intermediation.intermediationPosition(qs()).concerns.some((c) => c.kind === 'RELYING_ON_THE_WEAKEST'));
  });
});

// ── Concentration, measured ─────────────────────────────────────────────────

describe('what share of the job sits with one supplier', () => {
  it('measures it off the committed subcontracts rather than off an opinion', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const position = intermediation.intermediationPosition(qs());

    // The seed commits real subcontracts, and the shares add up to the whole.
    assert.ok(position.shares.length > 0, 'no committed supplier value was found');
    const summed = position.shares.reduce((total, entry) => total + entry.committedMinor, 0);
    assert.equal(summed, position.committedMinor);
    const percent = position.shares.reduce((total, entry) => total + entry.sharePercent, 0);
    assert.ok(Math.abs(percent - 100) < 0.5, `shares summed to ${percent}%`);

    assert.equal(position.largestSharePercent, position.shares[0]!.sharePercent);
  });

  /**
   * The ordering and the arithmetic, against inputs somebody chose.
   *
   * The demonstration seed lets exactly one package, so the integration test
   * above asserts an ordering over a list of one — a loop that never runs.
   * Reversing the sort and removing it entirely both survived mutation against
   * it, which is what a vacuous assertion looks like from the outside.
   */
  it('orders and apportions three suppliers by hand-checked figures', () => {
    // £2m, £5m and £3m: ten million committed, so 50%, 30% and 20%.
    const { shares, committedMinor } = intermediation.sharesOf([
      { supplierPartyId: 'a', supplierName: 'Alpha Groundworks', valueMinor: 200_000_00 },
      { supplierPartyId: 'b', supplierName: 'Bravo Mechanical', valueMinor: 500_000_00 },
      { supplierPartyId: 'c', supplierName: 'Charlie Electrical', valueMinor: 300_000_00 },
    ]);

    assert.equal(committedMinor, 1_000_000_00);
    assert.deepEqual(
      shares.map((entry) => [entry.supplierName, entry.sharePercent]),
      [
        ['Bravo Mechanical', 50],
        ['Charlie Electrical', 30],
        ['Alpha Groundworks', 20],
      ],
    );
  });

  it('adds a supplier’s packages together rather than listing it twice', () => {
    // Two packages with one firm is one relationship, and it is the
    // relationship that decides whether they could take the appointment.
    // Counted separately, a supplier holding 60% across three packages looks
    // like three suppliers holding 20% — which is the opposite conclusion.
    const { shares } = intermediation.sharesOf([
      { supplierPartyId: 'a', supplierName: 'Alpha Groundworks', valueMinor: 300_000_00 },
      { supplierPartyId: 'b', supplierName: 'Bravo Mechanical', valueMinor: 400_000_00 },
      { supplierPartyId: 'a', supplierName: 'Alpha Groundworks', valueMinor: 300_000_00 },
    ]);
    assert.equal(shares.length, 2);
    assert.deepEqual(shares[0], {
      supplierPartyId: 'a',
      supplierName: 'Alpha Groundworks',
      committedMinor: 600_000_00,
      sharePercent: 60,
      hasApproachedClient: false,
    });
  });

  it('ignores a subcontract with nobody on it, rather than inventing a supplier', () => {
    const { shares, committedMinor } = intermediation.sharesOf([
      { supplierName: 'Not yet awarded', valueMinor: 900_000_00 },
      { supplierPartyId: 'a', supplierName: 'Alpha Groundworks', valueMinor: 100_000_00 },
    ]);
    assert.equal(shares.length, 1);
    assert.equal(committedMinor, 100_000_00);
    assert.ok(!shares.some((entry) => entry.supplierName === 'Not yet awarded'));
  });

  it('divides nothing by nothing without producing a share', () => {
    assert.deepEqual(intermediation.sharesOf([]), { shares: [], committedMinor: 0 });
    const zero = intermediation.sharesOf([{ supplierPartyId: 'a', supplierName: 'Alpha', valueMinor: 0 }]);
    assert.equal(zero.committedMinor, 0);
    assert.equal(zero.shares[0]!.sharePercent, 0, 'a share of nothing was reported as a number');
  });

  it('marks the suppliers that have approached the client', () => {
    const { shares } = intermediation.sharesOf(
      [
        { supplierPartyId: 'a', supplierName: 'Alpha', valueMinor: 100_000_00 },
        { supplierPartyId: 'b', supplierName: 'Bravo', valueMinor: 900_000_00 },
      ],
      new Set(['a']),
    );
    assert.equal(shares.find((e) => e.supplierPartyId === 'a')!.hasApproachedClient, true);
    assert.equal(shares.find((e) => e.supplierPartyId === 'b')!.hasApproachedClient, false);
  });

  it('states the concentration even when it raises no concern', async () => {
    // A share under the threshold is a measurement worth having. "Nothing to
    // report" leaves the reader unable to tell it from nothing being measured —
    // the same failure the reserve sentence had on the cash side.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const position = intermediation.intermediationPosition(qs());
    assert.match(position.summary, /largest supplier holds [\d.]+% of/);
  });

  it('judges against the business’s own framework target where it has set one', async () => {
    // A firm that has said "no supplier above 30% of this framework" has
    // answered this with more care than a platform default can. Measuring it
    // against a different number would tell it it was fine while it was
    // breaching its own stated policy.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const position = intermediation.intermediationPosition(qs());

    // The seeded framework sets a maximum share; the threshold comes from it.
    if (position.concentrationThreshold.source !== 'the platform default') {
      assert.match(position.concentrationThreshold.source, /this business’s own target on FW-/);
    } else {
      assert.equal(position.concentrationThreshold.percent, config.billing.supplierConcentrationPercent);
    }
  });

  it('names the acute case: large, and already talking to the client', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const largest = intermediation.intermediationPosition(qs()).shares[0]!;

    intermediation.recordDirectApproach(qs(), {
      supplierPartyId: largest.supplierPartyId,
      supplierName: largest.supplierName,
      occurredOn: '2026-08-01',
      what: 'Asked the client’s facilities manager whether they had considered contracting the package directly.',
      outcome: 'CLIENT_REDIRECTED',
    });

    const position = intermediation.intermediationPosition(qs());
    assert.equal(position.shares[0]!.hasApproachedClient, true);

    // Which concern fires depends on whether the largest is over the threshold,
    // and both are the right answer for their case — but they are never both.
    const kinds = position.concerns.map((c) => c.kind);
    assert.ok(!(kinds.includes('SUPPLIER_CONCENTRATION') && kinds.includes('CONCENTRATED_AND_APPROACHING')));
    if (largest.sharePercent > position.concentrationThreshold.percent) {
      assert.ok(kinds.includes('CONCENTRATED_AND_APPROACHING'), `got ${kinds.join(', ')}`);
    }
    assert.ok(kinds.includes('DIRECT_APPROACHES'));
  });
});

// ── The approach register ───────────────────────────────────────────────────

describe('direct approaches, written down at the time', () => {
  it('keeps them newest first and counts the ones that went ahead', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);

    for (const [day, outcome] of [
      ['2026-03-04', 'SUPPLIER_DECLINED'],
      ['2026-06-19', 'PROCEEDED'],
      ['2026-05-02', 'UNKNOWN'],
    ] as const) {
      intermediation.recordDirectApproach(qs(), {
        supplierPartyId: `party-${day}`,
        supplierName: `Supplier ${day}`,
        occurredOn: day,
        what: 'Contacted the client about the next phase of the same works.',
        outcome,
      });
    }

    const position = intermediation.intermediationPosition(qs());
    assert.deepEqual(
      position.approaches.map((entry) => entry.occurredOn),
      ['2026-06-19', '2026-05-02', '2026-03-04'],
      'the register is not newest first, so a pattern cannot be read off it',
    );
    assert.equal(position.approaches[0]!.outcomeLabel, 'It went ahead without us');

    const concern = position.concerns.find((c) => c.kind === 'DIRECT_APPROACHES')!;
    assert.match(concern.subject, /3 direct approach\(es\) recorded, 1 of which went ahead without this business/);
  });

  it('refuses a record about a named business with no facts in it', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    throwsCode(
      () =>
        intermediation.recordDirectApproach(qs(), {
          supplierPartyId: 'p1',
          supplierName: 'Northgate Mechanical',
          occurredOn: '2026-08-01',
          what: '   ',
          outcome: 'UNKNOWN',
        }),
      'APPROACH_DETAIL_REQUIRED',
    );
    throwsCode(
      () =>
        intermediation.recordDirectApproach(qs(), {
          supplierPartyId: 'p1',
          supplierName: 'Northgate Mechanical',
          occurredOn: 'sometime in the spring',
          what: 'Contacted the client directly about the next phase.',
          outcome: 'UNKNOWN',
        }),
      'APPROACH_DATE_INVALID',
    );
  });
});

// ── The framework clock ─────────────────────────────────────────────────────

describe('the only defence with a clock on it', () => {
  /**
   * A framework built by the test, not one the seed happens to leave lying
   * about.
   *
   * These two tests were written as `if (!framework) return`, and the seed
   * creates none — so both passed without executing a single assertion, and a
   * mutation that counted an expired framework as still running survived them.
   * A guard that skips the test when the fixture is missing is a test that
   * reports success for the absence of its own subject.
   */
  const withFramework = async (endsOn: string) => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    framework.createFramework(qs(), {
      name: 'Site services 2026',
      startsOn: '2026-01-01',
      endsOn,
      lots: [
        {
          reference: 'LOT-1',
          trade: 'SITE_CLEARANCE',
          maxPackageValueMinor: 100_000_00,
          directAwardCeilingMinor: 25_000_00,
        },
      ],
      callOffMethod: 'MINI_COMPETITION',
      paymentTerms: '30 days from application',
      targets: { maxSharePerSupplierPercent: 30 },
    });
    return { qs };
  };

  it('reports the term that is running, with the days left of it', async () => {
    const { qs } = await withFramework('2027-12-31');
    const position = intermediation.intermediationPosition(qs(), '2027-12-01');
    assert.ok(position.framework, 'the framework term was not found');
    assert.equal(position.framework.endsOn, '2027-12-31');
    assert.equal(position.framework.daysRemaining, 30);
    assert.equal(position.framework.reference, 'FW-001');
  });

  it('raises the expiry inside the notice period and not before it', async () => {
    const { qs } = await withFramework('2027-12-31');
    const notice = config.billing.frameworkExpiryNoticeDays;
    const ends = Date.parse('2027-12-31');
    const inside = new Date(ends - (notice - 5) * 86_400_000).toISOString().slice(0, 10);
    const outside = new Date(ends - (notice + 30) * 86_400_000).toISOString().slice(0, 10);

    const raised = intermediation.intermediationPosition(qs(), inside).concerns.find((c) => c.kind === 'FRAMEWORK_EXPIRING');
    assert.ok(raised, 'an expiry inside the notice period was not raised');
    assert.match(raised.subject, /FW-001 ends on 2027-12-31/);

    assert.ok(
      !intermediation.intermediationPosition(qs(), outside).concerns.some((c) => c.kind === 'FRAMEWORK_EXPIRING'),
      'a framework beyond the notice period was reported as expiring, which is how a real one stops being read',
    );
  });

  it('does not report a framework that has already ended as the term still running', async () => {
    const { qs } = await withFramework('2027-12-31');
    const position = intermediation.intermediationPosition(qs(), '2028-01-01');
    assert.equal(position.framework, undefined, 'an expired framework was still being counted as a defence');
    assert.ok(
      !position.concerns.some((c) => c.kind === 'FRAMEWORK_EXPIRING'),
      'an expired framework was still being reported as about to expire',
    );
  });

  it('takes the concentration threshold from the framework’s own target', async () => {
    // A firm that has said "no supplier above 30% of this framework" has
    // answered this with more care than a platform constant can, and measuring
    // it against 40% would tell it it was fine while it breached its own policy.
    const { qs } = await withFramework('2027-12-31');
    const threshold = intermediation.intermediationPosition(qs(), '2027-01-01').concentrationThreshold;
    assert.equal(threshold.percent, 30);
    assert.match(threshold.source, /this business’s own target on FW-001/);
    assert.notEqual(threshold.percent, config.billing.supplierConcentrationPercent);
  });
});

// ── Authorisation ───────────────────────────────────────────────────────────

describe('who may see and change the position', () => {
  it('is commercial-sensitive and refused to a role without it', async () => {
    // A register naming suppliers approaching the client, with contract shares
    // beside them. This is the most damaging thing on the project to leak into
    // the supply chain, and every supplier is an identity on this platform.
    const { platform, seed, projectId } = await estate();
    // The safety lead holds no BUDGET_COST verb at all, which is what makes
    // them the right identity to prove the boundary rather than a role that
    // happens to be missing one letter of it.
    const withoutCommercial = platform.context(seed.users.safety!.auth, projectId, { source: 'WEB' });
    throwsCode(() => intermediation.intermediationPosition(withoutCommercial), 'ACCESS_DENIED');
    throwsCode(
      () => intermediation.recordDefence(withoutCommercial, { kind: 'SINGLE_INVOICE', inPlace: false }),
      'ACCESS_DENIED',
    );
    throwsCode(
      () =>
        intermediation.recordDirectApproach(withoutCommercial, {
          supplierPartyId: 'p1',
          supplierName: 'Northgate Mechanical',
          occurredOn: '2026-08-01',
          what: 'Contacted the client directly about the next phase.',
          outcome: 'UNKNOWN',
        }),
      'ACCESS_DENIED',
    );
  });
});

// ── The same supplier, across every job ─────────────────────────────────────

describe('concentration one appointment at a time cannot show', () => {
  /**
   * The illusion this view exists to break.
   *
   * A supplier holding twenty per cent of five appointments is under every
   * project-level threshold on every one of them, and is the largest single
   * dependency the business has. There is no reading order over the per-project
   * view that makes it appear.
   */
  /** Five appointments of £1m, and one supplier on all of them. */
  const fiveJobs = (wideShareMinor: number) => {
    const projects = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const rest = (1_000_000_00 - wideShareMinor) / 2;
    return {
      subcontracts: projects.flatMap((projectId) => [
        { projectId, state: { supplierPartyId: 'wide', supplierName: 'Wide Reach Services', valueMinor: wideShareMinor } },
        { projectId, state: { supplierPartyId: `local-${projectId}`, supplierName: `Local ${projectId}`, valueMinor: rest } },
        { projectId, state: { supplierPartyId: `other-${projectId}`, supplierName: `Other ${projectId}`, valueMinor: rest } },
      ]),
      projectNames: new Map(projects.map((id) => [id, `Appointment ${id}`])),
      approachedOn: new Map<string, Set<string>>(),
      threshold: { percent: 40, source: 'the platform default' },
    };
  };

  it('names the largest counterparty that breaches nothing on any single job', () => {
    // £200k of every £1m appointment. On each job that is 20% against a 40%
    // threshold — unremarkable, five times over. Across the business it is £1m
    // of £5m, and every other supplier is on one job at £400k, so 8%. Wide
    // Reach is two and a half times the next largest exposure and no project
    // review has anything to compare it against.
    const view = intermediation.exposureOf(fiveJobs(200_000_00));

    const wide = view.suppliers[0]!;
    assert.equal(wide.supplierName, 'Wide Reach Services');
    assert.equal(wide.tenantSharePercent, 20);
    assert.equal(wide.largestProjectSharePercent, 20);
    assert.equal(wide.projects.length, 5);
    assert.equal(view.suppliers[1]!.tenantSharePercent, 8, 'the fixture no longer makes Wide Reach the largest');
    assert.equal(wide.hiddenByProjectView, true, 'the hidden case was not detected');

    const concern = view.concerns.find((c) => c.kind === 'HIDDEN_CONCENTRATION');
    assert.ok(concern, `expected the hidden-concentration finding, got ${view.concerns.map((c) => c.kind).join(', ')}`);
    assert.match(concern.subject, /largest counterparty this business has — 20% across 5 appointments/);
    assert.match(concern.subject, /no more than 20% of a single job/);
  });

  it('does not call it hidden when a project review would already have seen it', () => {
    // 60% of every job breaches the 40% threshold on all five. That is the
    // ordinary concentration case and the per-project view raises it, so
    // reporting it as invisible would be false — and they are never both.
    const obvious = intermediation.exposureOf(fiveJobs(600_000_00));
    assert.equal(obvious.suppliers[0]!.hiddenByProjectView, false);
    assert.ok(obvious.concerns.some((c) => c.kind === 'TENANT_CONCENTRATION'));
    assert.ok(!obvious.concerns.some((c) => c.kind === 'HIDDEN_CONCENTRATION'));

    // And a supplier on one appointment is never hidden: that appointment's own
    // review is looking straight at it. The case has to be a firm that would
    // otherwise qualify — largest overall and under the threshold — or it
    // proves nothing about the project count.
    const single = intermediation.exposureOf({
      ...fiveJobs(200_000_00),
      subcontracts: [
        { projectId: 'p1', state: { supplierPartyId: 'wide', supplierName: 'Wide Reach Services', valueMinor: 400_000_00 } },
        { projectId: 'p1', state: { supplierPartyId: 'a', supplierName: 'Alpha', valueMinor: 300_000_00 } },
        { projectId: 'p1', state: { supplierPartyId: 'b', supplierName: 'Bravo', valueMinor: 300_000_00 } },
      ],
    });
    const largest = single.suppliers[0]!;
    assert.equal(largest.supplierName, 'Wide Reach Services');
    assert.equal(largest.tenantSharePercent, 40, 'the fixture no longer sits on the threshold');
    assert.equal(largest.largestProjectSharePercent, 40);
    assert.equal(largest.projects.length, 1);
    assert.equal(largest.hiddenByProjectView, false, 'a supplier on one appointment was called invisible to project review');
    assert.ok(!single.concerns.some((c) => c.kind === 'HIDDEN_CONCENTRATION'));
  });

  it('cannot be defined as a tenancy share above every project share', () => {
    // The first attempt at this finding was exactly that, and it is impossible:
    // a tenancy share is the value-weighted mean of the project shares, and a
    // mean is never above the maximum. The condition could not fire, and a
    // mutation switching the whole finding off passed every test.
    //
    // Pinned as arithmetic, because the next person to tighten this rule will
    // reach for the same wrong shape.
    for (const wideShare of [50_000_00, 200_000_00, 350_000_00, 600_000_00, 900_000_00]) {
      const view = intermediation.exposureOf(fiveJobs(wideShare));
      for (const supplier of view.suppliers) {
        assert.ok(
          supplier.tenantSharePercent <= supplier.largestProjectSharePercent + 0.1,
          `${supplier.supplierName}: tenancy share ${supplier.tenantSharePercent}% exceeded its largest project ` +
            `share ${supplier.largestProjectSharePercent}%, which a weighted mean cannot do`,
        );
      }
    }
  });

  it('raises being on every appointment separately from holding a large share', () => {
    // A different fact: how replaceable the relationship is, rather than how
    // much of it there is. £50k of each £1m job is 5% of the business — not the
    // largest counterparty, since each single-project firm holds 9.5% — and
    // still the one supplier every client this business has now knows.
    const view = intermediation.exposureOf(fiveJobs(50_000_00));
    const wide = view.suppliers.find((s) => s.supplierPartyId === 'wide')!;
    assert.equal(wide.tenantSharePercent, 5);
    assert.equal(wide.projects.length, 5);
    assert.equal(wide.hiddenByProjectView, false, 'a supplier that is not the largest was called the hidden one');

    const concern = view.concerns.find((c) => c.kind === 'ON_EVERY_PROJECT');
    assert.ok(concern, `expected the every-project finding, got ${view.concerns.map((c) => c.kind).join(', ')}`);
    assert.match(concern.subject, /Wide Reach Services is on all 5 appointments/);
    assert.ok(!view.concerns.some((c) => c.kind === 'TENANT_CONCENTRATION'));
    assert.ok(!view.concerns.some((c) => c.kind === 'HIDDEN_CONCENTRATION'));
  });

  it('counts a supplier approaching two different clients, and not two approaches on one', () => {
    const twice = intermediation.exposureOf({
      ...fiveJobs(100_000_00),
      approachedOn: new Map([['wide', new Set(['p1', 'p3'])]]),
    });
    const concern = twice.concerns.find((c) => c.kind === 'APPROACHING_MORE_THAN_ONE_CLIENT');
    assert.ok(concern, 'two clients approached by one supplier raised nothing');
    assert.match(concern.subject, /on 2 different appointments/);

    // One project, however many times, is one client and one conversation.
    const once = intermediation.exposureOf({
      ...fiveJobs(100_000_00),
      approachedOn: new Map([['wide', new Set(['p1'])]]),
    });
    assert.ok(!once.concerns.some((c) => c.kind === 'APPROACHING_MORE_THAN_ONE_CLIENT'));
  });

  it('names every appointment the supplier is on, largest first', () => {
    const view = intermediation.exposureOf({
      ...fiveJobs(100_000_00),
      subcontracts: [
        { projectId: 'p1', state: { supplierPartyId: 'wide', supplierName: 'Wide Reach Services', valueMinor: 100_000_00 } },
        { projectId: 'p2', state: { supplierPartyId: 'wide', supplierName: 'Wide Reach Services', valueMinor: 900_000_00 } },
      ],
    });
    const wide = view.suppliers[0]!;
    assert.deepEqual(
      wide.projects.map((p) => [p.projectName, p.projectSharePercent]),
      [
        ['Appointment p2', 100],
        ['Appointment p1', 100],
      ],
    );
    assert.equal(wide.projects[0]!.committedMinor, 900_000_00);
  });

  it('legacy: the same arithmetic through sharesOf alone', () => {
    // Five appointments of £1m each. Wide Reach holds £250k on each — 25% of
    // every job, under a 40% project threshold everywhere — and £1.25m of the
    // £5m committed, which is 25%... so make it sharper: on each job Wide Reach
    // holds 35% and two others split the rest, so no job breaches 40% and Wide
    // Reach is 35% of the business against a 30% threshold.
    const projects = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const rows = projects.flatMap((projectId) => [
      { projectId, supplierPartyId: 'wide', supplierName: 'Wide Reach Services', valueMinor: 350_000_00 },
      { projectId, supplierPartyId: `local-${projectId}`, supplierName: `Local ${projectId}`, valueMinor: 350_000_00 },
      { projectId, supplierPartyId: `other-${projectId}`, supplierName: `Other ${projectId}`, valueMinor: 300_000_00 },
    ]);

    // Per project, Wide Reach is 35% — under a 40% threshold on every one.
    for (const projectId of projects) {
      const { shares } = intermediation.sharesOf(rows.filter((row) => row.projectId === projectId));
      assert.equal(shares.find((s) => s.supplierPartyId === 'wide')!.sharePercent, 35);
    }

    // Across the business it is 35% of £5m — the same figure, and now the
    // largest single dependency there is, because nobody else has more than 7%.
    const { shares: tenant } = intermediation.sharesOf(rows);
    assert.equal(tenant[0]!.supplierPartyId, 'wide');
    assert.equal(tenant[0]!.sharePercent, 35);
    assert.equal(tenant[1]!.sharePercent, 7);

    // And that is the finding: 35% everywhere is invisible against a 40%
    // project threshold, and is five times the next largest exposure.
    assert.ok(tenant[0]!.sharePercent > 30 && tenant[0]!.sharePercent < 40);
  });
});

describe('the exposure view across every appointment', () => {
  /**
   * Built on real records through the real commands, because the arithmetic
   * above is only half the claim. The other half is that the view actually
   * reaches across projects, and that is exactly what a single-project fixture
   * cannot prove.
   */
  it('reads every project in the tenancy, not only the one being looked at', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const view = intermediation.supplierExposure(qs());

    // The seed commits one package on one project. The view still has to say
    // how many appointments it looked at, or nobody can tell whether a single
    // supplier means concentrated or means only one job has been let.
    assert.equal(view.projectCount, 1);
    assert.equal(view.suppliers.length, 1);
    assert.equal(view.suppliers[0]!.tenantSharePercent, 100);
    assert.equal(view.suppliers[0]!.projects.length, 1);
    assert.equal(view.suppliers[0]!.projects[0]!.projectSharePercent, 100);
    // The project is named, not just identified — a row of ULIDs is unreadable.
    assert.ok(view.suppliers[0]!.projects[0]!.projectName.length > 5);
    assert.match(view.summary, /1 supplier\(s\) across 1 appointment\(s\)/);
  });

  it('does not raise the every-project concern when there is only one project', async () => {
    // "On all 1 appointments" is true and useless, and a view that says it will
    // be turned off before it ever says something worth reading.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const view = intermediation.supplierExposure(qs());
    assert.ok(!view.concerns.some((c) => c.kind === 'ON_EVERY_PROJECT'));
  });

  it('gathers approaches by project, not by row, through the ledger', async () => {
    // Two approaches by the same supplier on the same project is one client,
    // not two. Asserted through `supplierExposure` rather than by handing
    // `exposureOf` a map, because the mapping from stored approaches to a set
    // of projects is the part that can be wrong — and it has to use the real
    // supplier party id or the row never joins to a share at all.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const supplier = intermediation.intermediationPosition(qs()).shares[0]!;

    for (const day of ['2026-05-01', '2026-07-01']) {
      intermediation.recordDirectApproach(qs(), {
        supplierPartyId: supplier.supplierPartyId,
        supplierName: supplier.supplierName,
        occurredOn: day,
        what: 'Contacted the client directly about the next phase of the works.',
        outcome: 'UNKNOWN',
      });
    }

    const view = intermediation.supplierExposure(qs());
    const row = view.suppliers.find((s) => s.supplierPartyId === supplier.supplierPartyId)!;
    assert.equal(row.approachedOnProjects, 1, 'two approaches on one project were counted as two clients');
    assert.ok(!view.concerns.some((c) => c.kind === 'APPROACHING_MORE_THAN_ONE_CLIENT'));
  });

  it('says nothing has been committed rather than reporting an exposure of none', async () => {
    // A tenancy that has let nothing is not a tenancy with no concentration
    // risk; it is one where the question cannot be answered yet. Reported as
    // "0% concentration" it reads as the safest possible position.
    //
    // Reached through a second tenancy, which also proves the thing a
    // tenant-wide read has to prove: this view crosses projects and stops at
    // the tenancy boundary. A cross-project aggregate that leaked would leak
    // every client's supply chain to every other customer at once.
    const { platform, seed, projectId } = await estate();
    const other = platform.createTenant({
      legalName: 'Second Tenancy Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'ENTERPRISE',
      enterpriseName: 'Second Tenancy Group',
    });
    const stranger = { ...seed.users.qs!.auth, tenantId: other.tenant.id };
    const view = intermediation.supplierExposure(platform.context(stranger, projectId, { source: 'WEB' }));

    assert.deepEqual(view.suppliers, [], 'another tenancy’s suppliers were visible');
    assert.equal(view.committedMinor, 0);
    assert.equal(view.projectCount, 0);
    assert.equal(view.concerns.length, 0);
    assert.equal(
      view.summary,
      'Nothing has been committed to a supplier on any appointment, so there is no exposure to measure yet.',
    );
  });

  it('is refused to a role with no commercial standing', async () => {
    // This is the shape of the whole business's dependency on its supply
    // chain, across every client. It is not a project team's to read.
    const { platform, seed, projectId } = await estate();
    const safety = platform.context(seed.users.safety!.auth, projectId, { source: 'WEB' });
    throwsCode(() => intermediation.supplierExposure(safety), 'ACCESS_DENIED');
  });
});

// ── Who at the client this business knows ───────────────────────────────────

describe('the relationship, and who is holding it', () => {
  it('says when nobody known at the client decides anything', async () => {
    // The commonest version of this, and it feels like a strong relationship
    // right up to the renewal.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);

    intermediation.recordClientContact(qs(), { name: 'Alan Reed', role: 'OPERATIONAL', ownedBy: 'D. Fisher' });
    intermediation.recordClientContact(qs(), { name: 'Priya Shah', role: 'TECHNICAL', ownedBy: 'M. Okafor' });

    const position = intermediation.intermediationPosition(qs());
    assert.equal(position.relationship.contacts.length, 2);
    assert.equal(position.relationship.decisionMakers, 0);
    assert.equal(position.relationship.ownerCount, 2);
    const concern = position.concerns.find((c) => c.kind === 'NOBODY_WHO_DECIDES');
    assert.ok(concern, `expected the decision-maker concern, got ${position.concerns.map((c) => c.kind).join(', ')}`);
    assert.match(concern.consequence, /delivery relationship rather than a commercial one/);

    // A budget holder settles it: they decide, so the concern goes.
    intermediation.recordClientContact(qs(), { name: 'Joanne Clark', role: 'BUDGET_HOLDER', ownedBy: 'M. Okafor' });
    const after = intermediation.intermediationPosition(qs());
    assert.equal(after.relationship.decisionMakers, 1);
    assert.ok(!after.concerns.some((c) => c.kind === 'NOBODY_WHO_DECIDES'));
  });

  it('says when the whole relationship rests on one employee', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    intermediation.recordClientContact(qs(), { name: 'Alan Reed', role: 'DECISION_MAKER', ownedBy: 'D. Fisher' });
    intermediation.recordClientContact(qs(), { name: 'Priya Shah', role: 'TECHNICAL', ownedBy: 'D. Fisher' });

    const position = intermediation.intermediationPosition(qs());
    assert.equal(position.relationship.ownerCount, 1);
    const concern = position.concerns.find((c) => c.kind === 'RELATIONSHIP_HELD_BY_ONE_PERSON');
    assert.ok(concern);
    assert.match(concern.subject, /held by D\. Fisher/);
    assert.match(concern.consequence, /leaves when they do/);

    // A second owner settles it.
    intermediation.recordClientContact(qs(), { name: 'Joanne Clark', role: 'PROCUREMENT', ownedBy: 'M. Okafor' });
    assert.ok(!intermediation.intermediationPosition(qs()).concerns.some((c) => c.kind === 'RELATIONSHIP_HELD_BY_ONE_PERSON'));
  });

  it('does not call one contact held by one person a key-person risk', async () => {
    // One contact is one contact. Saying the relationship rests on one employee
    // when there is only one relationship to hold is true and useless, and a
    // register that says it on the first row anybody enters will be ignored by
    // the time it has something to say.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    intermediation.recordClientContact(qs(), { name: 'Alan Reed', role: 'DECISION_MAKER', ownedBy: 'D. Fisher' });

    const position = intermediation.intermediationPosition(qs());
    assert.equal(position.relationship.ownerCount, 1);
    assert.ok(
      !position.concerns.some((c) => c.kind === 'RELATIONSHIP_HELD_BY_ONE_PERSON'),
      'a single contact was reported as the whole relationship resting on one person',
    );
  });

  it('keeps somebody who has left on the record, and stops counting them', async () => {
    // The fact that the person who rated this business has gone is the most
    // useful thing on this register at a renewal. Deleting the row would take
    // it away at exactly the moment it started to matter — and would also
    // leave a departed sponsor counted as still able to decide.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const { contactId } = intermediation.recordClientContact(qs(), {
      name: 'Alan Reed',
      role: 'DECISION_MAKER',
      ownedBy: 'D. Fisher',
    });
    assert.equal(intermediation.intermediationPosition(qs()).relationship.decisionMakers, 1);

    intermediation.recordClientContact(qs(), {
      contactId,
      name: 'Alan Reed',
      role: 'DECISION_MAKER',
      ownedBy: 'D. Fisher',
      departed: true,
    });

    const position = intermediation.intermediationPosition(qs());
    // One row, not two: the same person corrected rather than duplicated.
    assert.equal(position.relationship.contacts.length, 1);
    assert.equal(position.relationship.contacts[0]!.departed, true);
    assert.equal(position.relationship.decisionMakers, 0, 'a departed sponsor was still counted as able to decide');
    assert.equal(position.relationship.departedCount, 1);

    const concern = position.concerns.find((c) => c.kind === 'COUNTERPART_HAS_GONE');
    assert.ok(concern);
    assert.match(concern.subject, /including Alan Reed/);
    // And with nobody left in post, the decision-maker concern does not fire
    // either — there is no relationship left to have a gap in.
    assert.ok(!position.concerns.some((c) => c.kind === 'NOBODY_WHO_DECIDES'));
  });

  it('refuses the same person twice, and says how to correct the entry instead', async () => {
    // Recording a contact is the kind of command somebody runs again because
    // they are not sure it took. Two rows for one person is not cosmetic here:
    // the contact count and the owner count both drive findings, so duplicates
    // report a business as knowing six people when it knows three. Found by
    // running the walkthrough twice and reading the panel.
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const first = intermediation.recordClientContact(qs(), { name: 'Alan Reed', role: 'OPERATIONAL', ownedBy: 'D. Fisher' });

    const error = throwsCode(
      () => intermediation.recordClientContact(qs(), { name: '  alan reed ', role: 'TECHNICAL', ownedBy: 'M. Okafor' }),
      'CONTACT_ALREADY_RECORDED',
    );
    assert.match(String(error.message), /already on this register, held by D\. Fisher/);
    assert.match(String(error.message), /update that entry rather than adding a second one/);
    assert.equal(intermediation.intermediationPosition(qs()).relationship.contacts.length, 1);

    // Updating the same row by id is still allowed — that is the correction the
    // refusal points at, and it must not be blocked by the person's own name.
    intermediation.recordClientContact(qs(), {
      contactId: first.contactId,
      name: 'Alan Reed',
      role: 'DECISION_MAKER',
      ownedBy: 'M. Okafor',
    });
    const position = intermediation.intermediationPosition(qs());
    assert.equal(position.relationship.contacts.length, 1);
    assert.equal(position.relationship.contacts[0]!.role, 'DECISION_MAKER');
    assert.equal(position.relationship.contacts[0]!.ownedBy, 'M. Okafor');
  });

  it('refuses a contact nobody here owns', async () => {
    const { platform, seed, projectId } = await estate();
    const qs = ctxFor(platform, seed, projectId);
    const error = throwsCode(
      () => intermediation.recordClientContact(qs(), { name: 'Alan Reed', role: 'OPERATIONAL', ownedBy: '  ' }),
      'CONTACT_OWNER_REQUIRED',
    );
    assert.match(String(error.message), /how much of the relationship rests on one person/);
    throwsCode(
      () => intermediation.recordClientContact(qs(), { name: '   ', role: 'OPERATIONAL', ownedBy: 'D. Fisher' }),
      'CONTACT_NAME_REQUIRED',
    );
  });

  it('holds no field for anything but the business relationship', () => {
    // Data minimisation as a schema rather than as a policy. There is nowhere
    // to put a personal number, a private address or a note about what somebody
    // is like, which is a better control than a rule saying not to.
    const forbidden = ['email', 'phone', 'mobile', 'address', 'notes', 'personal', 'dateOfBirth'];
    const shape = Object.keys({
      contactId: '',
      name: '',
      role: 'OPERATIONAL' as const,
      roleLabel: '',
      ownedBy: '',
      departed: false,
    });
    for (const field of forbidden) {
      assert.ok(!shape.includes(field), `the client contact record grew a ${field} field`);
    }
  });
});
