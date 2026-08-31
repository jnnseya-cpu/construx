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
