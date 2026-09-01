import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  CONTROL_POINTS,
  FIT_FACTORS,
  appointmentPosition,
  assessModelFit,
  baselineAgreed,
  profileFor,
  setAppointment,
  transitionAppointment,
  type FitFactorId,
} from '../src/domain/etablix/appointment.ts';
import { TRADING_MODEL } from '../src/domain/integrator.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Which of three businesses ETABLIX is on this job.
 *
 * The same welfare, power, roads, cleaning and transport is delivered under
 * three appointments that differ on every control point that matters: who holds
 * the supplier contract, who pays it, who coordinates, who may enforce, what
 * ETABLIX is exposed to, what it is paid and what the customer receives as an
 * invoice. This is what the module's whole governance model hangs off, and the
 * failure it exists to prevent is the ordinary one — everybody proceeding on a
 * different assumption about which appointment is in force.
 *
 * Two rules carry most of the weight here.
 *
 * **A change of model after baseline is a transition, not a toggle.** Moving to
 * Prime means ETABLIX has agreed to fund a supply chain it was not funding that
 * morning. Recorded as a field edit, the two things anybody would later need —
 * what changed and who agreed to carry it — are both lost.
 *
 * **A blocked model is never recommended, however well it scores.** That is the
 * recommendation that puts a business into an appointment it cannot fund, and
 * the fit percentage is exactly what makes it persuasive.
 */

let platform: Platform;
let seed: SeedResult;

/** Every project in this suite is on a tenancy holding the module. */
function granted(who: string): EngineContext {
  return platform.context(seed.users[who]!.auth, seed.projectId);
}

function ungranted(who: string): EngineContext {
  return { ...granted(who), grantedModules: [] };
}

const ENTITY = 'Meridian Infrastructure Group Ltd';
const FUNDING = 'Client capital programme, drawn monthly against certificate';

/** A full set of scores, so a test can vary one factor and keep the rest fixed. */
function scores(overrides: Partial<Record<FitFactorId, number>> = {}): Record<FitFactorId, number> {
  const base = Object.fromEntries(FIT_FACTORS.map((factor) => [factor.id, 2])) as Record<FitFactorId, number>;
  return { ...base, ...overrides };
}

/** Evidence that passes every gate, so a test can knock out one at a time. */
function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mobilisationCostMinor: 400_000_00,
    creditLimitMinor: 750_000_00,
    mobilisationCashMinor: 500_000_00,
    insuranceCover: 'PI £10m, PL £10m, contract works £5m — Zurich, renewed 2026-04-01',
    bonds: 'Performance bond 10% on demand, in place',
    delegatedAuthority: 'Instruct suppliers to £50k, administer service credits, chair the weekly service review',
    paymentWorkflow: 'ETABLIX values by the 20th; the customer pays 30 days from the valuation date',
    advisoryOutputs: 'Requirements baseline, SBS, package strategy, ITT set and evaluation report',
    procurementOwner: 'Ruth Adeyemi, Head of Procurement',
    handoverDate: '2027-01-15',
    postAwardResponsibilities:
      'ETABLIX has none after award. The customer’s site team coordinates every supplier from the mobilisation date.',
    ...overrides,
  };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  // Through the operator's own command, not by writing a constant onto the
  // context. Every other test in this file then runs against a tenancy that
  // holds the module the way a real one would.
  platform.setModuleGrant({
    moduleId: 'ETABLIX',
    tenantId: seed.users.pm!.auth.tenantId,
    status: 'ACTIVE',
    reason: 'Appointed as ETABLIX site-services delivery partner',
    decidedBy: seed.users.operator!.id,
  });
});

beforeEach(() => {
  // Every test starts from a project with no appointment. A fresh platform per
  // test would re-seed a whole lifecycle each time; a fresh *project* is the
  // same isolation for a fraction of the work.
  seed.projectId = `${seed.users.pm!.auth.tenantId}-${Math.random().toString(36).slice(2, 10)}`;
});

describe('the three appointments', () => {
  it('answers all seven control points for every one of them', () => {
    // The table is the module's governance model. A control point with a gap in
    // it is a question that will be answered by whoever assumes hardest.
    const models = Object.keys(TRADING_MODEL);
    assert.equal(CONTROL_POINTS.length, 7);
    for (const point of CONTROL_POINTS) {
      for (const model of models) {
        const answer = point.answers[model as keyof typeof TRADING_MODEL];
        assert.ok(answer && answer.length > 10, `${point.id} has no answer under ${model}`);
      }
      assert.ok(point.matters.length > 20, `${point.id} does not say why it matters`);
    }
  });

  it('lets ETABLIX enforce directly under Prime and nowhere else', () => {
    // The distinction the module exists to keep. Under Management ETABLIX runs
    // the operation and still cannot enforce — it is not a party to the
    // contract — and a platform that let it act as though it were would be
    // manufacturing an authority that does not exist.
    assert.equal(profileFor('PRINCIPAL_SERVICE_CONTRACTOR').mayEnforceDirectly, true);
    assert.equal(profileFor('MANAGEMENT_INTEGRATOR').mayEnforceDirectly, false);
    assert.equal(profileFor('ADVISORY').mayEnforceDirectly, false);

    // And instructing is a different question again: Management may instruct,
    // Advisory may not.
    assert.equal(profileFor('MANAGEMENT_INTEGRATOR').mayInstructSupplier, true);
    assert.equal(profileFor('ADVISORY').mayInstructSupplier, false);
  });

  it('brings the agent ceiling down where the money is ETABLIX’s own', () => {
    assert.equal(profileFor('PRINCIPAL_SERVICE_CONTRACTOR').agentCeiling, 'A');
    assert.equal(profileFor('MANAGEMENT_INTEGRATOR').agentCeiling, 'B');
  });

  it('takes the commercial half from the integrator model rather than restating it', () => {
    // One source of truth for what each model costs a business. A second copy
    // would disagree the first time either was corrected.
    for (const model of Object.keys(TRADING_MODEL) as (keyof typeof TRADING_MODEL)[]) {
      assert.equal(profileFor(model).cashRisk, TRADING_MODEL[model].cashRisk);
      assert.equal(profileFor(model).fundsSupplierCost, TRADING_MODEL[model].fundsSupplierCost);
    }
  });
});

describe('appointing', () => {
  it('records the model, the entity, the funding and why', () => {
    const made = setAppointment(granted('pm'), {
      model: 'MANAGEMENT_INTEGRATOR',
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
      basis: 'The customer holds framework terms with four of the six suppliers and wants to keep them.',
    });

    assert.equal(made.model, 'MANAGEMENT_INTEGRATOR');
    assert.equal(made.contractingEntity, ENTITY);
    assert.equal(made.baselined, false);
    assert.equal(made.history.length, 1);
    assert.equal(made.history[0]!.from, undefined);
  });

  it('refuses an appointment with no contracting entity or no funding source', () => {
    // The two blocking rules from the model-fit specification, enforced at the
    // write as well as in the assessment — an assessment can be skipped and
    // this cannot.
    throwsCode(
      () =>
        setAppointment(granted('pm'), {
          model: 'ADVISORY',
          contractingEntity: '  ',
          fundingSource: FUNDING,
          basis: 'x y z',
        }),
      'APPOINTMENT_ENTITY_REQUIRED',
    );
    throwsCode(
      () =>
        setAppointment(granted('pm'), {
          model: 'ADVISORY',
          contractingEntity: ENTITY,
          fundingSource: '',
          basis: 'x y z',
        }),
      'APPOINTMENT_FUNDING_REQUIRED',
    );
  });

  it('refuses a second appointment, because that is a transition', () => {
    setAppointment(granted('pm'), {
      model: 'ADVISORY',
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
      basis: 'Customer runs its own procurement',
    });
    const error = throwsCode(
      () =>
        setAppointment(granted('pm'), {
          model: 'PRINCIPAL_SERVICE_CONTRACTOR',
          contractingEntity: ENTITY,
          fundingSource: FUNDING,
          basis: 'Changed our minds',
        }),
      'APPOINTMENT_EXISTS',
    );
    assert.match(String(error.message), /transition/);
  });

  it('refuses a tenancy that does not hold the module, whatever the role', () => {
    // The module gate and the capability check ask different questions and both
    // have to pass. This is the one where the answer to the second is yes.
    throwsCode(
      () =>
        setAppointment(ungranted('pm'), {
          model: 'ADVISORY',
          contractingEntity: ENTITY,
          fundingSource: FUNDING,
          basis: 'x y z',
        }),
      'MODULE_NOT_GRANTED',
    );
    throwsCode(() => appointmentPosition(ungranted('pm')), 'MODULE_NOT_GRANTED');
  });

  it('refuses a role that holds the module but not the authority', () => {
    // The planner reads site services and does not appoint anybody.
    assert.throws(
      () =>
        setAppointment(granted('planner'), {
          model: 'ADVISORY',
          contractingEntity: ENTITY,
          fundingSource: FUNDING,
          basis: 'x y z',
        }),
      /SITE_SERVICES|not permitted|holds/i,
    );
    // And still reads it, which is the point of the two being separate.
    assert.doesNotThrow(() => appointmentPosition(granted('planner')));
  });
});

describe('changing the appointment', () => {
  function appoint(model: 'ADVISORY' | 'MANAGEMENT_INTEGRATOR' | 'PRINCIPAL_SERVICE_CONTRACTOR' = 'ADVISORY') {
    return setAppointment(granted('pm'), {
      model,
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
      basis: 'Initial appointment',
    });
  }

  it('is an ordinary correction before the baseline is agreed', () => {
    appoint();
    const moved = transitionAppointment(granted('pm'), {
      model: 'MANAGEMENT_INTEGRATOR',
      basis: 'The customer asked ETABLIX to run the operation as well as specify it',
    });
    assert.equal(moved.model, 'MANAGEMENT_INTEGRATOR');
    assert.equal(moved.history.length, 2);
    assert.equal(moved.history[1]!.from, 'ADVISORY');
    assert.equal(moved.history[1]!.commercialBasis, undefined);
  });

  it('refuses a change after baseline with no commercial basis', () => {
    appoint();
    baselineAgreed(granted('pm'));
    const error = throwsCode(
      () =>
        transitionAppointment(granted('pm'), {
          model: 'PRINCIPAL_SERVICE_CONTRACTOR',
          basis: 'Customer wants single-point accountability',
        }),
      'APPOINTMENT_TRANSITION_UNCOMMERCIAL',
    );
    // The whole rule, in the refusal: this is not a settings change.
    assert.match(String(error.message), /commercial transition/);

    // And the appointment is unmoved. A refusal that half-applied would be
    // worse than no gate at all.
    assert.equal(appointmentPosition(granted('pm')).appointment!.model, 'ADVISORY');
  });

  it('records the transition with its commercial basis once one is given', () => {
    appoint();
    baselineAgreed(granted('pm'));
    const moved = transitionAppointment(granted('pm'), {
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
      basis: 'Customer wants single-point accountability across all seven families',
      commercialBasis:
        'Fee converts from £180k fixed to an integrated price at 14.5% on supplier cost; ETABLIX novates the six ' +
        'live supplier contracts from 2026-11-01 and takes a £600k advance replenished monthly.',
    });
    assert.equal(moved.model, 'PRINCIPAL_SERVICE_CONTRACTOR');
    assert.match(String(moved.history[1]!.commercialBasis), /novates/);
    // The earlier appointment is still on the record. What ETABLIX used to be
    // answerable for is the first thing asked when something goes wrong.
    assert.equal(moved.history[0]!.model, 'ADVISORY');
  });

  it('refuses a transition to the model already in force', () => {
    appoint('MANAGEMENT_INTEGRATOR');
    throwsCode(
      () => transitionAppointment(granted('pm'), { model: 'MANAGEMENT_INTEGRATOR', basis: 'No change really' }),
      'APPOINTMENT_UNCHANGED',
    );
  });

  it('refuses a transition on a project with no appointment', () => {
    throwsCode(
      () => transitionAppointment(granted('pm'), { model: 'ADVISORY', basis: 'From nothing' }),
      'APPOINTMENT_ABSENT',
    );
  });
});

describe('the Model Fit agent', () => {
  it('refuses to recommend anything when the contracting entity is unknown', () => {
    // Blocking rule one, and it is absolute. Which appointments are available
    // at all depends on who is contracting and where the money comes from.
    const fit = assessModelFit(granted('pm'), {
      scores: scores(),
      evidence: evidence(),
      fundingSource: FUNDING,
    });
    assert.equal(fit.recommended, undefined);
    assert.equal(fit.fallback, undefined);
    assert.match(String(fit.refusedBecause), /contracting entity/);
    // It still scores every model. A refusal to recommend is not a refusal to
    // analyse — the paper is what tells somebody what to go and find out.
    assert.equal(fit.viability.length, 3);
  });

  it('refuses to recommend anything when the funding source is unknown', () => {
    const fit = assessModelFit(granted('pm'), {
      scores: scores(),
      evidence: evidence(),
      contractingEntity: ENTITY,
    });
    assert.equal(fit.recommended, undefined);
    assert.match(String(fit.refusedBecause), /funding source/);
  });

  it('refuses a partial score sheet', () => {
    const partial = scores();
    delete (partial as Record<string, unknown>).etablixCreditStrength;
    const error = throwsCode(
      () =>
        assessModelFit(granted('pm'), {
          scores: partial,
          evidence: evidence(),
          contractingEntity: ENTITY,
          fundingSource: FUNDING,
        }),
      'MODEL_FIT_INCOMPLETE',
    );
    assert.match(String(error.message), /opinion with arithmetic on it/);
  });

  it('refuses a score outside the scale', () => {
    throwsCode(
      () =>
        assessModelFit(granted('pm'), {
          scores: scores({ programmeUrgency: 7 }),
          evidence: evidence(),
          contractingEntity: ENTITY,
          fundingSource: FUNDING,
        }),
      'MODEL_FIT_SCORE_INVALID',
    );
  });

  it('blocks Prime when the credit facility does not cover mobilisation', () => {
    const fit = assessModelFit(granted('pm'), {
      // Scored to favour Prime on every factor that argues for it, so the
      // blocker has to be what stops it rather than the arithmetic.
      scores: scores({
        singlePointAccountability: 4,
        contractRiskTransfer: 4,
        programmeUrgency: 4,
        customerDeliveryCapacity: 0,
      }),
      evidence: evidence({ creditLimitMinor: 100_000_00 }),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });

    const prime = fit.viability.find((entry) => entry.model === 'PRINCIPAL_SERVICE_CONTRACTOR')!;
    assert.equal(prime.viable, false);
    assert.ok(prime.blockers.some((blocker) => /Treasury/.test(blocker)));
    // The recommendation that would have put the business into an appointment
    // it cannot fund. It is the highest-scoring model here and it is not
    // recommended, which is the entire point of the gate.
    assert.notEqual(fit.recommended, 'PRINCIPAL_SERVICE_CONTRACTOR');
    assert.ok(
      prime.fitPercent > (fit.viability.find((entry) => entry.model === fit.recommended)?.fitPercent ?? 0),
      'the blocked model should have out-scored the recommended one — otherwise this test proves nothing',
    );
  });

  /**
   * Every gate, one at a time.
   *
   * Written as a table because the first version of this file tested one
   * blocker per model — treasury for Prime, delegated authority for Management,
   * post-award for Advisory — and four of the nine gates could be deleted
   * outright with the suite still green. A gate nothing exercises is a gate
   * that will be removed by somebody tidying up.
   */
  const GATES: { what: string; evidence: Record<string, unknown>; model: string; names: RegExp }[] = [
    {
      what: 'the credit facility does not cover mobilisation',
      evidence: { creditLimitMinor: 1_00 },
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
      names: /Treasury/,
    },
    {
      what: 'there is not enough cash in hand to mobilise',
      evidence: { mobilisationCashMinor: 1_00 },
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
      names: /Mobilisation/,
    },
    {
      what: 'the mobilisation cost is not stated at all',
      evidence: { mobilisationCostMinor: undefined },
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
      names: /no treasury test can be run/,
    },
    {
      what: 'no insurance is named',
      evidence: { insuranceCover: '' },
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
      names: /insurance/i,
    },
    {
      what: 'the bond position is silent',
      evidence: { bonds: '  ' },
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
      names: /bond/i,
    },
    {
      what: 'ETABLIX holds no delegated authority',
      evidence: { delegatedAuthority: '' },
      model: 'MANAGEMENT_INTEGRATOR',
      names: /no power to instruct/,
    },
    {
      what: 'there is no payment workflow to recommend into',
      evidence: { paymentWorkflow: '' },
      model: 'MANAGEMENT_INTEGRATOR',
      names: /payment recommendation would go nowhere/,
    },
    {
      what: 'the advisory deliverables are undefined',
      evidence: { advisoryOutputs: '' },
      model: 'ADVISORY',
      names: /deliverables are not defined/,
    },
    {
      what: 'no customer procurement owner is named',
      evidence: { procurementOwner: '' },
      model: 'ADVISORY',
      names: /nobody to hand the tender to/,
    },
    {
      what: 'no handover date is set',
      evidence: { handoverDate: '' },
      model: 'ADVISORY',
      names: /handover date/,
    },
    {
      what: 'post-award responsibilities are unstated',
      evidence: { postAwardResponsibilities: '' },
      model: 'ADVISORY',
      names: /assumed either way/,
    },
  ];

  for (const gate of GATES) {
    it(`blocks ${gate.model.split('_')[0]!.toLowerCase()} when ${gate.what}`, () => {
      const fit = assessModelFit(granted('pm'), {
        scores: scores(),
        evidence: evidence(gate.evidence),
        contractingEntity: ENTITY,
        fundingSource: FUNDING,
      });
      const entry = fit.viability.find((candidate) => candidate.model === gate.model)!;
      assert.equal(entry.viable, false, `${gate.model} stayed viable with ${gate.what}`);
      assert.ok(
        entry.blockers.some((blocker) => gate.names.test(blocker)),
        `no blocker named it — got: ${entry.blockers.join(' | ')}`,
      );
      // And it cannot be recommended, which is the consequence that matters.
      assert.notEqual(fit.recommended, gate.model);
      // The other two are untouched: one failing gate must not fail the rest,
      // or a single missing document would block every route out of the job.
      const others = fit.viability.filter((candidate) => candidate.model !== gate.model);
      assert.ok(others.every((candidate) => candidate.viable), 'one missing fact blocked an unrelated model');
    });
  }

  it('blocks Prime when the bond position is merely silent', () => {
    // "None required" is an answer. Silence is the thing that turns up in a
    // dispute as an assumption nobody made on purpose.
    const fit = assessModelFit(granted('pm'), {
      scores: scores(),
      evidence: evidence({ bonds: '   ' }),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    const prime = fit.viability.find((entry) => entry.model === 'PRINCIPAL_SERVICE_CONTRACTOR')!;
    assert.equal(prime.viable, false);
    assert.ok(prime.blockers.some((blocker) => /bond/i.test(blocker)));
  });

  it('blocks Management where ETABLIX has no authority to enforce', () => {
    const fit = assessModelFit(granted('pm'), {
      scores: scores(),
      evidence: evidence({ delegatedAuthority: '' }),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    const management = fit.viability.find((entry) => entry.model === 'MANAGEMENT_INTEGRATOR')!;
    assert.equal(management.viable, false);
    assert.ok(management.blockers.some((blocker) => /accountable for an operation it has no power to instruct/.test(blocker)));
  });

  it('blocks Advisory where post-award responsibilities are left unstated', () => {
    const fit = assessModelFit(granted('pm'), {
      scores: scores(),
      evidence: evidence({ postAwardResponsibilities: '' }),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    const advisory = fit.viability.find((entry) => entry.model === 'ADVISORY')!;
    assert.equal(advisory.viable, false);
    assert.ok(advisory.blockers.some((blocker) => /assumed either way/.test(blocker)));
  });

  it('recommends the highest-scoring model that is actually viable, with a fallback', () => {
    const fit = assessModelFit(granted('pm'), {
      scores: scores({
        customerDeliveryCapacity: 4,
        customerProcurementMaturity: 4,
        geographicSupplyDepth: 4,
        singlePointAccountability: 0,
        contractRiskTransfer: 0,
        programmeUrgency: 0,
        operationalComplexity: 0,
      }),
      evidence: evidence(),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    assert.equal(fit.recommended, 'ADVISORY');
    assert.ok(fit.fallback);
    assert.notEqual(fit.fallback, fit.recommended);
  });

  it('shows what every factor contributed to every model', () => {
    // The reason this is a decision paper rather than a number. A
    // recommendation somebody cannot argue with is one nobody can rely on.
    const fit = assessModelFit(granted('pm'), {
      scores: scores({ singlePointAccountability: 4 }),
      evidence: evidence(),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    assert.equal(fit.factors.length, FIT_FACTORS.length);
    const single = fit.factors.find((factor) => factor.id === 'singlePointAccountability')!;
    assert.equal(single.contribution.PRINCIPAL_SERVICE_CONTRACTOR, 8);
    assert.equal(single.contribution.ADVISORY, -8);
  });

  it('never appoints anybody', () => {
    // The spec's own words: a decision paper, not an automatic commercial
    // commitment. An assessment that quietly set the appointment would be the
    // module deciding which business ETABLIX is.
    assessModelFit(granted('pm'), {
      scores: scores(),
      evidence: evidence(),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    assert.equal(appointmentPosition(granted('pm')).appointment, undefined);
  });

  it('is refused to a tenancy without the module', () => {
    throwsCode(
      () => assessModelFit(ungranted('pm'), { scores: scores(), evidence: evidence() }),
      'MODULE_NOT_GRANTED',
    );
  });
});

describe('the position a screen reads', () => {
  it('shows all three models whether or not one is in force', () => {
    const empty = appointmentPosition(granted('pm'));
    assert.equal(empty.appointment, undefined);
    assert.equal(empty.controlPoints.length, 0);
    // The comparison is there before the choice is made, because that is when
    // somebody is making it.
    assert.equal(empty.models.length, 3);

    setAppointment(granted('pm'), {
      model: 'PRINCIPAL_SERVICE_CONTRACTOR',
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
      basis: 'Single-point accountability across all seven families',
    });

    const held = appointmentPosition(granted('pm'));
    assert.equal(held.controlPoints.length, 7);
    assert.equal(held.profile!.mayEnforceDirectly, true);
    // And still shows the other two, which is now what they gave up.
    assert.equal(held.models.length, 3);
    assert.match(
      held.controlPoints.find((point) => point.id === 'SUPPLIER_PAYMENT')!.answer,
      /ETABLIX, under its own supplier terms/,
    );
  });

  it('carries the most recent assessment, not the first', () => {
    const first = assessModelFit(granted('pm'), {
      scores: scores(),
      evidence: evidence(),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    const second = assessModelFit(granted('pm'), {
      scores: scores({ programmeUrgency: 4 }),
      evidence: evidence(),
      contractingEntity: ENTITY,
      fundingSource: FUNDING,
    });
    assert.notEqual(first.id, second.id);
    assert.equal(appointmentPosition(granted('pm')).assessment!.id, second.id);
  });
});
