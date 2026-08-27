import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as structure from '../src/domain/structure.ts';
import * as valuechain from '../src/domain/valuechain.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-09 and CN-WF-10 — the two commercial controls neither workflow had.
 *
 * Change requests, variations, upstream/downstream reconciliation, delay
 * events, the obligations calendar with its clause citations, the payment
 * cycle, the notices and the CVR were all already built. What is tested here is
 * the two things that were not: five values that stay separate, and a deadline
 * a person has actually checked.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds CHANGE_VARIATION C and U — submits and assesses. Cannot certify. */
const asQS = () => platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
/** Holds CHANGE_VARIATION A — certifies, agrees and records payment. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/**
 * Holds CONTRACTS_CLAIMS A. Validating a time bar is not the same authority as
 * certifying a variation: the QS derives it and the PM runs the commercial
 * cycle, but neither carries 'A' on the contract itself. Signing off the rule
 * the platform applied to a clause sits with the party the clause binds.
 */
const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let sequence = 0;

function subject(): string {
  sequence += 1;
  return `VAR-${String(sequence).padStart(4, '0')}`;
}

function value(
  subjectRef: string,
  stage: valuechain.ValueStage,
  amountMinor: number,
  ctx = stage === 'SUBMITTED' || stage === 'ASSESSED' ? asQS() : asPM(),
) {
  return valuechain.recordValue(ctx, {
    subjectType: 'Variation',
    subjectRef,
    title: 'Additional ground investigation and the diversion that followed',
    stage,
    amountMinor,
    basis: `Measured against the bill rates for ${stage.toLowerCase()}, with dayworks for the standing time.`,
    by: 'S. Iqbal',
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Running the commercial cycle',
  });
});

describe('CN-WF-09/10 the register', () => {
  it('registers its three event types', () => {
    for (const [code, entity] of [
      ['VALUE_STAGE_RECORDED', 'ValueChain'],
      ['NOTICE_DEADLINE_DERIVED', 'NoticeDeadline'],
      ['NOTICE_DEADLINE_VALIDATED', 'NoticeDeadline'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Cannot submit/certify payment, set forecast or interpret law."
      assert.equal(definition.aiAllowed, false);
    }
  });

  it('treats what was claimed against what was assessed as commercial-in-confidence', () => {
    // It is the negotiating position, for the same reason the variation
    // register is.
    assert.equal(classifyEntity('ValueChain')?.sensitivity, 'COMMERCIAL_L3');
    assert.equal(classifyEntity('NoticeDeadline')?.area, 'CONTRACTS_CLAIMS');
  });
});

describe('AC-CN-WF-09-03 five values that stay separate', () => {
  it('holds all five, and computes the three gaps that matter', () => {
    const ref = subject();
    value(ref, 'SUBMITTED', 4_200_000);
    const assessed = value(ref, 'ASSESSED', 2_800_000);
    // The negotiation, as a movement rather than a replacement.
    assert.equal(assessed.movementMinor, -1_400_000);

    value(ref, 'CERTIFIED', 2_800_000);
    value(ref, 'AGREED', 3_100_000);
    value(ref, 'PAID', 2_800_000);

    const chain = valuechain.valueChainFor(asQS(), ref)!;
    assert.equal(chain.submittedMinor, 4_200_000);
    assert.equal(chain.assessedMinor, 2_800_000);
    assert.equal(chain.certifiedMinor, 2_800_000);
    assert.equal(chain.agreedMinor, 3_100_000);
    assert.equal(chain.paidMinor, 2_800_000);

    // Submitted against assessed is the negotiation.
    assert.equal(chain.negotiationMinor, 1_400_000);
    // Certified against paid is the cashflow.
    assert.equal(chain.unpaidMinor, 0);
    // Agreed against paid is the dispute.
    assert.equal(chain.outstandingMinor, 300_000);
    assert.equal(chain.stages.length, 5);
  });

  it('refuses to overwrite a value that has already been recorded', () => {
    const ref = subject();
    value(ref, 'SUBMITTED', 1_000_000);
    throwsCode(() => value(ref, 'SUBMITTED', 900_000), 'STAGE_ALREADY_RECORDED');
  });

  it('refuses to assess what nobody claimed', () => {
    const ref = subject();
    const refusal = throwsCode(() => value(ref, 'ASSESSED', 500_000), 'NOTHING_SUBMITTED');
    assert.match(refusal.message ?? '', /Record what was claimed first/);
  });

  it('does not insist on an order between certified and agreed', () => {
    // Contracts differ, and a platform that insisted on one order would be
    // wrong on half of them.
    const ref = subject();
    value(ref, 'SUBMITTED', 2_000_000);
    value(ref, 'AGREED', 1_800_000);
    assert.ok(value(ref, 'CERTIFIED', 1_800_000));
  });

  it('refuses to pay above what was certified', () => {
    const ref = subject();
    value(ref, 'SUBMITTED', 2_000_000);
    value(ref, 'CERTIFIED', 1_500_000);
    const refusal = throwsCode(() => value(ref, 'PAID', 1_800_000), 'PAID_ABOVE_CERTIFIED');
    assert.match(refusal.message ?? '', /certificate nobody recorded/);
  });

  it('lets a payment fall short of the certificate, and reports it as cashflow', () => {
    const ref = subject();
    value(ref, 'SUBMITTED', 2_000_000);
    value(ref, 'CERTIFIED', 1_500_000);
    value(ref, 'PAID', 1_000_000);
    const chain = valuechain.valueChainFor(asQS(), ref)!;
    assert.equal(chain.unpaidMinor, 500_000);

    const position = valuechain.commercialControlPosition(asQS());
    assert.ok(position.unpaid.some((entry) => entry.subjectRef === ref && entry.unpaidMinor === 500_000));
  });

  it('refuses a figure with no basis behind it', () => {
    const ref = subject();
    throwsCode(
      () =>
        valuechain.recordValue(asQS(), {
          subjectType: 'Variation',
          subjectRef: ref,
          title: 'Something',
          stage: 'SUBMITTED',
          amountMinor: 100,
          basis: 'Agreed',
          by: 'S. Iqbal',
        }),
      'BASIS_REQUIRED',
    );
  });

  it('refuses certification from the role that submits and assesses', () => {
    // The authority follows the stage rather than being one blanket permission
    // for five different acts.
    const ref = subject();
    value(ref, 'SUBMITTED', 1_000_000);
    throwsCode(() => value(ref, 'CERTIFIED', 900_000, asQS()), 'ACCESS_DENIED');
  });

  it('ranks the negotiations by how far apart the two figures are', () => {
    const position = valuechain.commercialControlPosition(asQS());
    assert.ok(position.largestNegotiations.length > 0);
    const gaps = position.largestNegotiations.map((entry) => Math.abs(entry.gapMinor));
    assert.deepEqual(gaps, [...gaps].sort((a, b) => b - a));
  });
});

describe('AC-CN-WF-09-01 a deadline somebody checked', () => {
  const DERIVATION = {
    reference: 'TB-0001',
    category: 'COMPENSATION_EVENT_NOTICE',
    description: 'Notification of a compensation event arising from the unforeseen obstruction at 12+40.',
    ruleSource: 'NEC4 clause 61.3',
    inputs: {
      triggerEvent: 'Obstruction encountered and recorded in the site diary',
      triggerDate: '2026-08-03',
      periodDays: 8,
      calendar: 'CALENDAR_DAYS' as const,
    },
    dueDate: '2026-08-11',
    timeBarred: true,
  };

  it('records the rule, the arithmetic and that nobody has checked it yet', () => {
    const result = valuechain.deriveDeadline(asQS(), DERIVATION);
    assert.equal(result.validated, false);

    const position = valuechain.commercialControlPosition(asQS());
    const deadline = position.deadlines.find((entry) => entry.reference === 'TB-0001')!;
    assert.equal(deadline.ruleSource, 'NEC4 clause 61.3');
    assert.equal(deadline.timeBarred, true);
    assert.equal(deadline.validated, false);
    // A time bar nobody has checked is the one that cannot be recovered.
    assert.ok(position.unvalidatedTimeBars.includes('TB-0001'));
    assert.match(position.summary, /nobody has checked/);
  });

  it('refuses a deadline with no rule behind it', () => {
    throwsCode(
      () => valuechain.deriveDeadline(asQS(), { ...DERIVATION, reference: 'TB-X', ruleSource: '  ' }),
      'RULE_SOURCE_REQUIRED',
    );
  });

  it('refuses a derivation with no trigger or no period', () => {
    throwsCode(
      () =>
        valuechain.deriveDeadline(asQS(), {
          ...DERIVATION,
          reference: 'TB-Y',
          inputs: { ...DERIVATION.inputs, triggerEvent: '  ' },
        }),
      'TRIGGER_REQUIRED',
    );
    throwsCode(
      () =>
        valuechain.deriveDeadline(asQS(), {
          ...DERIVATION,
          reference: 'TB-Z',
          inputs: { ...DERIVATION.inputs, periodDays: 0 },
        }),
      'PERIOD_REQUIRED',
    );
  });

  it('validates it, and clears it off the unchecked list', () => {
    const { deadlineId } = valuechain.deriveDeadline(asQS(), { ...DERIVATION, reference: 'TB-0002' });
    const result = valuechain.validateDeadline(asOwner(), deadlineId, {
      agrees: true,
      note: 'Checked against clause 61.3 and the diary entry for the 3rd. Eight calendar days, not working days.',
      validatedBy: 'S. Iqbal',
    });
    assert.equal(result.corrected, false);
    assert.equal(result.dueDate, '2026-08-11');

    const position = valuechain.commercialControlPosition(asQS());
    assert.ok(!position.unvalidatedTimeBars.includes('TB-0002'));
  });

  it('keeps the derivation when a person corrects it', () => {
    // A correction is a fact about the platform's rule as well as about the
    // date, and the pattern of corrections is how a wrong rule gets found.
    const { deadlineId } = valuechain.deriveDeadline(asQS(), { ...DERIVATION, reference: 'TB-0003' });
    const result = valuechain.validateDeadline(asOwner(), deadlineId, {
      agrees: false,
      correctedDueDate: '2026-08-13',
      note: 'The trigger is the date the obstruction was reported, not the date it was encountered — the 5th, not the 3rd.',
      validatedBy: 'S. Iqbal',
    });
    assert.equal(result.corrected, true);
    assert.equal(result.dueDate, '2026-08-13');

    const position = valuechain.commercialControlPosition(asQS());
    const deadline = position.deadlines.find((entry) => entry.reference === 'TB-0003')!;
    assert.equal(deadline.dueDate, '2026-08-13');
    assert.equal(deadline.derivedDueDate, '2026-08-11');
  });

  it('refuses a disagreement that does not say what the right date is', () => {
    // Marking it wrong and leaving it there is worse than the derivation.
    const { deadlineId } = valuechain.deriveDeadline(asQS(), { ...DERIVATION, reference: 'TB-0004' });
    throwsCode(
      () =>
        valuechain.validateDeadline(asOwner(), deadlineId, {
          agrees: false,
          note: 'This looks wrong.',
          validatedBy: 'S. Iqbal',
        }),
      'CORRECTION_REQUIRED',
    );
  });

  it('refuses an unsigned validation, and a second one', () => {
    const { deadlineId } = valuechain.deriveDeadline(asQS(), { ...DERIVATION, reference: 'TB-0005' });
    throwsCode(
      () => valuechain.validateDeadline(asOwner(), deadlineId, { agrees: true, note: 'Fine.', validatedBy: '  ' }),
      'VALIDATION_UNSIGNED',
    );
    valuechain.validateDeadline(asOwner(), deadlineId, {
      agrees: true,
      note: 'Checked against the clause and the diary.',
      validatedBy: 'S. Iqbal',
    });
    throwsCode(
      () =>
        valuechain.validateDeadline(asOwner(), deadlineId, {
          agrees: true,
          note: 'Again.',
          validatedBy: 'S. Iqbal',
        }),
      'ALREADY_VALIDATED',
    );
  });

  it('refuses validation from the role that derived it but cannot approve', () => {
    const { deadlineId } = valuechain.deriveDeadline(asQS(), { ...DERIVATION, reference: 'TB-0006' });
    throwsCode(
      () =>
        valuechain.validateDeadline(asQS(), deadlineId, {
          agrees: true,
          note: 'Mine.',
          validatedBy: 'S. Iqbal',
        }),
      'ACCESS_DENIED',
    );
    void day;
  });
});
