import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessClause, reviewContract } from '../src/domain/contractreview.ts';

/**
 * The contract read clause by clause for what each does to the bid — a first
 * pass by rule, written down so a reviewer can disagree with it, never a
 * sign-off.
 */

describe('each clause judged by rule', () => {
  it('a short time bar on notices is severe; a long one is material', () => {
    assert.equal(assessClause({ topic: 'NOTICES', stated: 'Notify within 14 days.', value: 14, unit: 'days' }).severity, 'SEVERE');
    assert.equal(assessClause({ topic: 'NOTICES', stated: 'Notify within eight weeks.', value: 8, unit: 'weeks' }).severity, 'MATERIAL');
  });

  it('payment terms and retention are judged on their figures, and sent to finance', () => {
    assert.equal(assessClause({ topic: 'PAYMENT_CERTIFICATION', stated: 'Paid in 30 days.', value: 30, unit: 'days' }).severity, 'ROUTINE');
    const slow = assessClause({ topic: 'PAYMENT_CERTIFICATION', stated: 'Paid in 45 days.', value: 45, unit: 'days' });
    assert.equal(slow.severity, 'MATERIAL');
    assert.deepEqual(slow.review, ['FINANCE']);
    assert.equal(assessClause({ topic: 'PAYMENT_CERTIFICATION', stated: 'Paid in 90 days.', value: 90, unit: 'days' }).severity, 'SEVERE');
    assert.equal(assessClause({ topic: 'RETENTION_RELEASE', stated: '5% retention.', value: 5, unit: '%' }).severity, 'MATERIAL');
    assert.equal(assessClause({ topic: 'RETENTION_RELEASE', stated: '3% retention.', value: 3, unit: '%' }).severity, 'ROUTINE');
  });

  it('fitness for purpose, an unlimited liability and a broad indemnity are severe', () => {
    assert.equal(assessClause({ topic: 'DESIGN_LIABILITY', stated: 'The design shall be fit for its purpose.' }).severity, 'SEVERE');
    assert.equal(assessClause({ topic: 'DESIGN_LIABILITY', stated: 'Reasonable skill and care.' }).severity, 'MATERIAL');
    assert.equal(assessClause({ topic: 'LIABILITY_CAP', stated: 'Liability is unlimited.' }).severity, 'SEVERE');
    assert.match(assessClause({ topic: 'LIABILITY_CAP', stated: 'Capped at the contract sum.', value: 100, unit: '%' }).effect, /100% of the contract sum/);
    assert.equal(assessClause({ topic: 'INDEMNITIES', stated: 'Indemnify against any and all losses howsoever arising.' }).severity, 'SEVERE');
  });

  it('a fixed price carries inflation; a long defects period is material', () => {
    assert.equal(assessClause({ topic: 'PRICE_ADJUSTMENT', stated: 'Fixed price, no fluctuations.' }).severity, 'MATERIAL');
    assert.equal(assessClause({ topic: 'DEFECTS', stated: '24 months.', value: 24, unit: 'months' }).severity, 'MATERIAL');
    assert.equal(assessClause({ topic: 'DEFECTS', stated: '52 weeks.', value: 52, unit: 'weeks' }).severity, 'ROUTINE');
  });
});

describe('the review as a whole', () => {
  it('says what the pack does not state and what cannot be compared', () => {
    const review = reviewContract({ documentsListed: [], documentsNotSupplied: [], milestones: [], contract: { form: 'JCT Design and Build', edition: '2016', options: [], amendmentsStated: true, amendmentsSupplied: true, clauses: [] } });
    assert.equal(review.rows.length, 0);
    assert.equal(review.notStated.length, 18);
    assert.ok(review.cannotCompare.some((line) => /standard wording of JCT Design and Build 2016 is not held/.test(line)));
    assert.ok(!review.cannotCompare.some((line) => /not in it/.test(line)), 'the amendments were supplied');
  });

  it('asks for the form when the pack names none', () => {
    assert.match(reviewContract(undefined).cannotCompare[0]!, /does not name the form of contract/);
  });
});
