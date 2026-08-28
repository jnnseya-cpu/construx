import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
  AI_OUTPUT_FIELDS,
  RISK_LEVELS,
  conformToOutputStandard,
  correctionFor,
  outputStandardInstruction,
  outputStandardSchema,
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
