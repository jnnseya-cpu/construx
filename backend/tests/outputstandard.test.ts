import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
  AI_OUTPUT_FIELDS,
  RISK_LEVELS,
  attributeAccountability,
  conformToOutputStandard,
  correctionFor,
  outputStandardInstruction,
  outputStandardSchema,
  outputStandardVersion,
  validateAiOutput,
} from '../src/ai/outputstandard.ts';
import { DomainError } from '../src/core/errors.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import * as claims from '../src/engines/claims.ts';
import { hashEvidence } from '../src/core/canonical.ts';

/**
 * The AI Output Standard.
 *
 * The specification states it as a hard requirement and states its enforcement
 * in the same breath: *"Responses failing schema validation are rejected and
 * retried; never shown raw to the user."* Before this, an entitlement
 * assessment reached the ledger as `String(output.narrative ?? '')` — one
 * unchecked paragraph from a provider, stored on a record somebody prices a
 * variation off.
 *
 * The failure that matters is not a model returning garbage; that is obvious
 * and gets noticed. It is a model returning something that reads exactly like
 * an assessment and contains none — a commercial impact paragraph with no
 * position in it, a source reference that is a sentence rather than a record.
 * Those survive review because they look right. So the assertions below are
 * mostly about *plausible* bad answers rather than broken ones.
 */

const GOOD = {
  summary: 'The temporary works redesign extends the diversion by two weeks.',
  evidence: 'CR-014 requires a second sheet-pile run that was not in the accepted programme.',
  riskLevel: 'HIGH',
  commercialImpact: { amountMinor: 4_200_000, currency: 'GBP', statement: 'Additional plant and labour for the second run.' },
  programmeImpact: { days: 14, statement: 'Two weeks on the critical path through the diversion.' },
  contractImpact: { clause: 'NEC4 60.1(1)', statement: 'A compensation event: the Project Manager instructed a change to the Scope.' },
  recommendedAction: 'Serve the early warning today and price the quotation against the revised temporary works.',
  requiredBy: { date: '2026-03-31', statement: 'The early warning period under the contract closes at the end of March.' },
  requiredAuthority: { area: 'CONTRACTS_CLAIMS', level: 'A', statement: 'Serving an early warning commits a contractual position.' },
  confidence: 0.78,
  sourceReferences: [{ refType: 'ChangeRequest', refId: 'CR-014', note: 'The instruction being assessed.' }],
  approvalRequired: true,
};

const answer = (over: Record<string, unknown>) => ({ ...GOOD, ...over });

function problems(raw: unknown, resolve?: (r: { refType: string; refId: string }) => boolean) {
  const result = validateAiOutput(raw, resolve ? { resolve } : {});
  assert.equal(result.ok, false, 'the answer was accepted');
  return result.ok ? [] : result.problems;
}

describe('a conforming answer is accepted and normalised', () => {
  it('accepts the ten fields', () => {
    const result = validateAiOutput(GOOD);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.output.riskLevel, 'HIGH');
    assert.equal(result.output.commercialImpact.amountMinor, 4_200_000);
    assert.equal(result.output.sourceReferences.length, 1);
  });

  it('accepts an honest nothing, which is a real finding', () => {
    // "No commercial impact" is an answer. It is only worthless when it is not
    // said — which is why the quantity may be null and the statement may not.
    const result = validateAiOutput(
      answer({
        commercialImpact: { amountMinor: null, statement: 'No cost effect: the work falls inside the existing provisional sum.' },
        programmeImpact: { days: null, statement: 'Float absorbs it; the critical path is unmoved.' },
        contractImpact: { clause: null, statement: 'No contractual mechanism is engaged.' },
      }),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.output.commercialImpact.amountMinor, null);
  });

  it('takes a risk level in any case, because that is a spelling difference', () => {
    const result = validateAiOutput(answer({ riskLevel: 'critical' }));
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.output.riskLevel, 'CRITICAL');
  });

  it('reads a negative amount as a saving rather than refusing it', () => {
    const result = validateAiOutput(
      answer({
        commercialImpact: { amountMinor: -150_000, currency: 'GBP', statement: 'Omission of the second manhole.' },
        programmeImpact: { days: -3, statement: 'Three days recovered.' },
      }),
    );
    assert.equal(result.ok, true);
  });
});

describe('the answers that look right and are not', () => {
  it('refuses an impact with a number and no statement', () => {
    const found = problems(answer({ commercialImpact: { amountMinor: 4_200_000, currency: 'GBP', statement: '   ' } }));
    assert.ok(found.some((p) => p.field === 'commercialImpact.statement'));
  });

  it('refuses an impact with neither a number nor a statement', () => {
    // The failure this exists for. "I did not consider the commercial impact"
    // and "there is no commercial impact" are different findings, and once the
    // statement is missing they are the same record.
    const found = problems(answer({ programmeImpact: { days: null, statement: '' } }));
    assert.ok(found.some((p) => p.field === 'programmeImpact.statement'));
  });

  it('refuses a figure with no currency', () => {
    // Minor units are not comparable across currencies, so an amount without
    // one is a number nobody can add up.
    const found = problems(answer({ commercialImpact: { amountMinor: 4_200_000, statement: 'Additional plant.' } }));
    assert.ok(found.some((p) => p.field === 'commercialImpact.currency'));
  });

  it('refuses prose where a source reference belongs', () => {
    const found = problems(answer({ sourceReferences: ['As per the contract and the site records'] }));
    assert.ok(found.some((p) => p.field === 'sourceReferences[0]'));
  });

  it('refuses a finding that cites nothing at all', () => {
    const found = problems(answer({ sourceReferences: [] }));
    assert.ok(found.some((p) => p.field === 'sourceReferences'));
  });

  it('refuses a reference to a record that does not exist', () => {
    // Well-formed is not traceable. A model will cite
    // `Contract:the-main-contract` quite happily, and a link that resolves to
    // nothing is worse than no link because it looks checked.
    const found = problems(GOOD, (reference) => reference.refId === 'CR-REAL');
    assert.ok(found.some((p) => p.message.includes('not a record on this project')));
  });

  it('refuses a confidence outside the scale, including the confident 100', () => {
    assert.ok(problems(answer({ confidence: 1.4 })).some((p) => p.field === 'confidence'));
    assert.ok(problems(answer({ confidence: 100 })).some((p) => p.field === 'confidence'));
    assert.ok(problems(answer({ confidence: 'high' })).some((p) => p.field === 'confidence'));
  });

  it('refuses a risk level it does not recognise', () => {
    assert.ok(problems(answer({ riskLevel: 'SEVERE' })).some((p) => p.field === 'riskLevel'));
  });

  it('refuses approvalRequired as a word', () => {
    // "Y" is what the specification writes and what a model will send. It is
    // still not a boolean, and `Boolean('N')` is true.
    assert.ok(problems(answer({ approvalRequired: 'Y' })).some((p) => p.field === 'approvalRequired'));
    assert.ok(problems(answer({ approvalRequired: 'N' })).some((p) => p.field === 'approvalRequired'));
  });

  it('refuses an answer that is valid JSON and not an object', () => {
    for (const raw of [null, [], 42, 'no comment']) {
      assert.ok(problems(raw).some((p) => p.field === 'output'));
    }
  });

  it('reports every problem at once, not the first', () => {
    // A model corrected one field at a time takes ten round trips and ten
    // charges to produce one answer.
    const found = problems({ summary: 'Something happened.' });
    assert.ok(found.length >= 6, `only ${found.length} problems reported from an almost-empty answer`);
  });
});

describe('the prompt and the validator cannot drift', () => {
  it('asks for exactly the fields it checks', () => {
    // A prompt asking for nine fields against a validator requiring ten is a
    // retry loop that can never terminate, and it would fail on a customer's
    // project rather than here.
    const asked = AI_OUTPUT_FIELDS.map((f) => f.field).sort();
    const required = (outputStandardSchema().required as string[]).sort();
    assert.deepEqual(required, asked);

    const instruction = outputStandardInstruction();
    for (const { field } of AI_OUTPUT_FIELDS) {
      assert.ok(instruction.includes(field), `the instruction never mentions ${field}`);
    }
  });

  it('offers the schema the risk levels the validator accepts', () => {
    const schema = outputStandardSchema() as { properties: { riskLevel: { enum: string[] } } };
    assert.deepEqual(schema.properties.riskLevel.enum, [...RISK_LEVELS]);
  });

  it('names the failing fields in the correction, so a retry can succeed', () => {
    const correction = correctionFor([{ field: 'confidence', message: 'confidence must be a number between 0 and 1' }]);
    assert.ok(correction.includes('confidence'));
    assert.ok(correction.includes('rejected'));
    // The full instruction goes with it: a model told only what was wrong
    // frequently returns just that field.
    assert.ok(correction.includes('sourceReferences'));
  });
});

describe('rejected and retried, and refused after that', () => {
  it('accepts a first answer without asking twice', async () => {
    let asked = 0;
    const result = await conformToOutputStandard(async () => {
      asked += 1;
      return GOOD;
    });
    assert.equal(asked, 1);
    assert.equal(result.attempts, 1);
    assert.equal(result.rejected, undefined);
  });

  it('retries once with the problems named, and keeps what was wrong', async () => {
    const corrections: Array<string | undefined> = [];
    const result = await conformToOutputStandard(async (correction) => {
      corrections.push(correction);
      return corrections.length === 1 ? answer({ confidence: 42 }) : GOOD;
    });

    assert.equal(result.attempts, 2);
    assert.equal(corrections[0], undefined, 'the first ask carried a correction');
    assert.ok(corrections[1]?.includes('confidence'), 'the retry did not say what was wrong');
    // Kept rather than discarded: a model corrected on the same field across
    // many runs is a prompt defect, and this is the only place it shows.
    assert.ok(result.rejected?.some((p) => p.field === 'confidence'));
  });

  it('refuses after two failures rather than passing prose through', async () => {
    let asked = 0;
    await assert.rejects(
      () =>
        conformToOutputStandard(async () => {
          asked += 1;
          return { narrative: 'It depends on the circumstances of the delay.' };
        }),
      (error: unknown) => {
        assert.ok(error instanceof DomainError);
        assert.equal(error.code, 'AI_OUTPUT_STANDARD_FAILED');
        assert.equal(error.status, 502);
        assert.ok(error.fieldErrors.length > 0, 'the refusal named no problems');
        // The refusal must not carry the model's text. "Never shown raw to the
        // user" includes inside an error message.
        assert.ok(!error.message.includes('circumstances of the delay'));
        assert.ok(!JSON.stringify(error.fieldErrors).includes('circumstances of the delay'));
        return true;
      },
    );
    assert.equal(asked, 2, 'a loop, not one retry');
  });
});

describe('an entitlement assessment is held to it end to end', () => {
  let platform: Platform;
  let seed: SeedResult;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
  });

  it('records a validated assessment rather than an unchecked paragraph', async () => {
    const ctx = platform.context(seed.users.qs!.auth, seed.projectId, { source: 'WEB' });
    const change = claims.submitChangeRequest(ctx, {
      description: 'Ground conditions require a second run of temporary works to the trunk main diversion.',
      origin: 'CLIENT',
      noticeType: 'CCI',
      reason: 'Instructed following the ground investigation review',
      impactedPackageIds: [],
      affectedSubcontractIds: [],
      supportingEvidenceHash: hashEvidence('second sheet-pile run'),
    });

    const assessed = await claims.assessImpact(ctx, {
      changeRequestId: change.changeRequestId,
      costImpactMinor: 4_200_000,
      timeImpactDays: 14,
      affectedTaskIds: [],
      qualityImpact: 'None.',
      safetyImpact: 'Additional plant movements in the compound.',
    });

    const record = platform.ledger.require({ refType: 'ImpactAssessment', refId: assessed.assessmentId });
    const assessment = record.state.aiAssessment as Record<string, unknown> | undefined;
    assert.ok(assessment, 'the assessment was stored without the standard');

    // Every field established, on a deployment with no provider configured.
    const revalidated = validateAiOutput(assessment);
    assert.equal(revalidated.ok, true, 'what was stored does not itself satisfy the standard');

    // And the stand-in is honest about what it is. A deterministic adapter has
    // no judgement to offer, so it must not offer one: null quantities, zero
    // confidence, and a statement saying no model was called.
    if (revalidated.ok) {
      assert.equal(revalidated.output.commercialImpact.amountMinor, null);
      assert.equal(revalidated.output.confidence, 0);
      assert.match(revalidated.output.commercialImpact.statement, /no model was called/i);
      // It cites the record it was given, and nothing it was not.
      assert.deepEqual(
        revalidated.output.sourceReferences.map((r) => r.refType),
        ['ChangeRequest'],
      );
    }

    // The assessor's own figures are untouched beside it. The AI answer sits
    // next to the record, it does not become the record.
    assert.equal(record.state.costImpactMinor, 4_200_000);
    assert.equal(record.state.timeImpactDays, 14);

    // And the provenance says it was held to the standard, so a reader can
    // tell a checked answer from one that was never checked.
    const provenance = record.state.aiProvenance as Record<string, unknown>;
    assert.equal(provenance.outputStandard, true);
    assert.equal(provenance.standardAttempts, 1);
    assert.equal(provenance.synthetic, true);
  });
});

/**
 * Accountability — §16.3.
 *
 * Three fields, and the reason they are three rather than one is who is
 * entitled to answer each.
 *
 * **The model says what authority the action takes**, in the platform's own
 * vocabulary, and is refused when it names anything else. That refusal is the
 * whole value of the field: `SENIOR_COMMERCIAL_APPROVAL` is a string a model
 * will produce without hesitation and it resolves to nobody, which is worse
 * than nothing because it looks checked.
 *
 * **The model never names a person.** `attributeAccountability` turns the
 * authority into who holds it here, through the same resolver the rest of the
 * platform names owners with. A model naming an accountable owner would be
 * inventing an org chart.
 *
 * **A finding nobody can act on is reportable, not blank.** Where the authority
 * is real and nobody on the estate holds it, that is a fact about the estate
 * and it is said, rather than rendered as an empty name.
 */
describe('who is accountable, and by when', () => {
  it('takes a real capability area and level out of the matrix', () => {
    const result = validateAiOutput(GOOD);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.output.requiredAuthority, {
      area: 'CONTRACTS_CLAIMS',
      level: 'A',
      statement: 'Serving an early warning commits a contractual position.',
    });
    assert.equal(result.output.requiredBy.date, '2026-03-31');
  });

  it('refuses an authority the platform does not have, however plausible it reads', () => {
    const found = problems(
      answer({
        requiredAuthority: { area: 'SENIOR_COMMERCIAL_APPROVAL', level: 'A', statement: 'Needs sign-off.' },
      }),
    );
    assert.ok(found.some((problem) => problem.field === 'requiredAuthority.area'));
    assert.ok(found.some((problem) => /not a capability area/.test(problem.message)));
  });

  it('refuses a permission code that is not one', () => {
    const found = problems(
      answer({ requiredAuthority: { area: 'CONTRACTS_CLAIMS', level: 'APPROVE', statement: 'Needs sign-off.' } }),
    );
    assert.ok(found.some((problem) => problem.field === 'requiredAuthority.level'));
  });

  it('refuses an area with no level, because half an authority resolves to nobody', () => {
    const found = problems(
      answer({ requiredAuthority: { area: 'CONTRACTS_CLAIMS', level: null, statement: 'Needs sign-off.' } }),
    );
    assert.ok(found.some((problem) => problem.field === 'requiredAuthority'));
  });

  it('accepts an action that needs no authority, said out loud', () => {
    const result = validateAiOutput(
      answer({
        requiredAuthority: { area: null, level: null, statement: 'Reading the revised drawing takes no authority.' },
      }),
    );
    assert.equal(result.ok, true);
  });

  it('refuses an authority with no statement, exactly as an impact with no statement is refused', () => {
    const found = problems(answer({ requiredAuthority: { area: null, level: null, statement: '  ' } }));
    assert.ok(found.some((problem) => problem.field === 'requiredAuthority.statement'));
  });

  it('refuses a date that is not one, and a date that is not a real day', () => {
    assert.ok(
      problems(answer({ requiredBy: { date: 'end of next month', statement: 'Soon.' } })).some(
        (problem) => problem.field === 'requiredBy.date',
      ),
    );
    // `2026-02-30` is well-formed and not a day. It parses in some engines and
    // rolls forward in others, which is how an impossible deadline becomes a
    // real one nobody chose.
    assert.ok(
      problems(answer({ requiredBy: { date: '2026-02-30', statement: 'End of February.' } })).some((problem) =>
        /not a real calendar date/.test(problem.message),
      ),
    );
  });

  it('accepts no date where there honestly is none', () => {
    const result = validateAiOutput(
      answer({ requiredBy: { date: null, statement: 'No deadline: this is a standing improvement to the method.' } }),
    );
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.output.requiredBy.date, null);
  });

  it('names the person who holds the authority, from the platform and never from the model', () => {
    const result = validateAiOutput(GOOD);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const attributed = attributeAccountability(result.output, (authority) => {
      assert.deepEqual(authority, { area: 'CONTRACTS_CLAIMS', level: 'A' });
      return { userId: 'u-1', name: 'Ama Boateng', role: 'COMMERCIAL_MANAGER' };
    });
    assert.deepEqual(attributed.accountableOwner, {
      resolved: true,
      userId: 'u-1',
      name: 'Ama Boateng',
      role: 'COMMERCIAL_MANAGER',
    });

    // And the model's own answer never carried a name to begin with.
    assert.equal('accountableOwner' in result.output, false);
  });

  it('says so when nobody on the estate holds the authority, rather than showing a blank', () => {
    const result = validateAiOutput(GOOD);
    if (!result.ok) return;
    const attributed = attributeAccountability(result.output, () => undefined);
    assert.equal(attributed.accountableOwner.resolved, false);
    if (attributed.accountableOwner.resolved) return;
    assert.equal(attributed.accountableOwner.because, 'UNRESOLVED');
    assert.match(attributed.accountableOwner.statement, /Nobody on this estate holds CONTRACTS_CLAIMS A/);
  });

  it('resolves nobody, and asks nobody, where the action needs no authority', () => {
    const result = validateAiOutput(
      answer({ requiredAuthority: { area: null, level: null, statement: 'Takes no authority.' } }),
    );
    if (!result.ok) return;
    let asked = false;
    const attributed = attributeAccountability(result.output, () => {
      asked = true;
      return undefined;
    });
    assert.equal(asked, false, 'an authority of none was still looked up');
    assert.equal(attributed.accountableOwner.resolved, false);
    if (attributed.accountableOwner.resolved) return;
    assert.equal(attributed.accountableOwner.because, 'NONE_NEEDED');
  });
});

describe('which version of the standard an answer was held to', () => {
  it('is stable while the field list is, and changes when it is not', () => {
    // Derived rather than declared, exactly as promptVersion is. Without it the
    // record says an answer conformed and cannot say to what — a claim that
    // quietly changes meaning every time a field is added, as two just were.
    assert.match(outputStandardVersion(), /^aios@[0-9a-f]{8}$/);
    assert.equal(outputStandardVersion(), outputStandardVersion());
  });

  it('covers the fields the validator actually requires', () => {
    // The drift this catches: a field added to the type and the validator but
    // not to AI_OUTPUT_FIELDS would leave the version unchanged while the bar
    // moved.
    const names = AI_OUTPUT_FIELDS.map((entry) => entry.field);
    assert.ok(names.includes('requiredBy'));
    assert.ok(names.includes('requiredAuthority'));
    const schema = outputStandardSchema() as { required: string[] };
    assert.deepEqual([...schema.required].sort(), [...names].sort());
  });
});
