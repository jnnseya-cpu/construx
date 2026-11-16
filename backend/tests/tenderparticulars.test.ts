import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanScale, mergeParticulars, particularsFromReading } from '../src/domain/tenderparticulars.ts';
import { minimumScoreOf } from '../src/domain/answercheck.ts';
import { checkTenderReading } from '../src/domain/tenderreading.ts';

/**
 * What a tender says about itself — its documents, precedence, evaluation,
 * submission rules and dates — read with the requirements, kept with the passage
 * each came from, and checked in code before anybody confirms it.
 */

const documents = [
  {
    ingestionId: 'F1',
    filename: 'ITT.pdf',
    text:
      '1.3 Order of precedence: the Conditions of Contract, then the Specification, then the Drawings. ' +
      'Tenders shall remain open for acceptance for 90 days. Quality 40%, price 60%. A minimum score of 2 is required on every question. ' +
      'The Site Investigation Report is available on the portal.',
  },
];

const reading = {
  documentsListed: [{ title: 'Specification', reference: 'Vol 2', revision: 'C', issuedOn: '2026-10-01', sourceQuote: null }, { title: '' }],
  documentsNotSupplied: [{ title: 'Site Investigation Report', sourceQuote: 'The Site Investigation Report is available on the portal.' }],
  precedence: { order: ['Conditions of Contract', 'Specification', 'Drawings'], sourceQuote: 'Order of precedence: the Conditions of Contract, then the Specification' },
  evaluation: { qualityPercent: 40, pricePercent: 60, minimumQualityScore: 'a score of 2 on every question', qualificationsPermitted: false, sourceQuote: 'Quality 40%, price 60%.' },
  submissionRules: null,
  tenderValidityDays: 90,
  validitySourceQuote: 'Tenders shall remain open for acceptance for 90 days.',
  awardOn: 'mid-January',
  milestones: [
    { label: 'Section 1 handover', date: '2027-05-01', mandatory: true, sourceQuote: null },
    { label: 'No date', date: 'TBC', mandatory: true },
  ],
};

describe('reading what the tender says about itself', () => {
  const particulars = particularsFromReading(reading, documents);

  it('keeps what is stated, each cited to where it is found, and drops what is not a value', () => {
    assert.equal(particulars.documentsListed.length, 1, 'an untitled entry is not a document');
    assert.equal(particulars.documentsListed[0]!.revision, 'C');
    assert.deepEqual(particulars.precedence?.order, ['Conditions of Contract', 'Specification', 'Drawings']);
    assert.equal(particulars.precedence?.source?.located, true);
    assert.equal(particulars.evaluation?.minimumQualityScore, 'a score of 2 on every question');
    assert.equal(particulars.evaluation?.qualificationsPermitted, false);
    assert.equal(particulars.tenderValidityDays, 90);
    assert.equal(particulars.validitySource?.document, 'ITT.pdf');
    assert.equal(particulars.awardOn, undefined, '"mid-January" is not a date and is not stored as one');
    assert.deepEqual(particulars.milestones.map((entry) => entry.label), ['Section 1 handover'], 'a milestone with no date is not one');
    assert.equal(particulars.submission, undefined, 'nothing stated, nothing stored');
  });

  it('merges a second reading in without erasing what the first found', () => {
    const later = particularsFromReading(
      { documentsListed: [{ title: 'Drawings', reference: 'Vol 3' }], evaluation: { scoringMethod: '0–5 scale' }, milestones: [] },
      documents,
    );
    const merged = mergeParticulars(particulars, later);
    assert.deepEqual(merged.documentsListed.map((entry) => entry.reference), ['Vol 2', 'Vol 3']);
    assert.equal(merged.evaluation?.qualityPercent, 40, 'the first reading’s split survives');
    assert.equal(merged.evaluation?.scoringMethod, '0–5 scale');
    assert.equal(merged.tenderValidityDays, 90);
    assert.equal(merged.milestones.length, 1);
  });
});

describe('the checks on what the tender says about itself', () => {
  const base = {
    returnByLocal: '2099-01-10T12:00',
    returnTimeZone: 'Europe/London',
    worksStartOn: '2099-02-01',
    requirements: [{ reference: 'Q1', requirement: 'Describe your approach to the works', mandatory: false, sourceQuote: 'Describe your approach to the works' }],
    deliverables: [{ reference: 'R1', title: 'Form of Tender', mandatory: true, sourceQuote: 'Form of Tender' }],
  };
  const pack = '=== Document: ITT.pdf (invitation) ===\nForm of Tender. Q1 Describe your approach to the works.';
  const ids = (extraction: Record<string, unknown>) => checkTenderReading(extraction, pack, { today: '2026-11-16' }).checks.map((check) => check.id);

  it('catches a quality and price split that does not add to 100', () => {
    assert.ok(ids({ ...base, evaluation: { qualityPercent: 40, pricePercent: 70 } }).includes('EVALUATION_SPLIT'));
    assert.ok(!ids({ ...base, evaluation: { qualityPercent: 40, pricePercent: 60 } }).includes('EVALUATION_SPLIT'));
  });

  it('catches an award before the return and one after the works start', () => {
    assert.ok(ids({ ...base, awardOn: '2099-01-01' }).includes('AWARD_BEFORE_RETURN'));
    assert.ok(ids({ ...base, awardOn: '2099-03-01' }).includes('AWARD_AFTER_START'));
    assert.deepEqual(ids({ ...base, awardOn: '2099-01-20' }).filter((id) => id.startsWith('AWARD')), []);
  });

  it('says which documents the pack refers to but does not contain', () => {
    const checks = checkTenderReading({ ...base, documentsNotSupplied: [{ title: 'Site Investigation Report' }] }, pack, { today: '2026-11-16' });
    const missing = checks.checks.find((check) => check.id === 'DOCUMENTS_NOT_SUPPLIED')!;
    assert.equal(missing.severity, 'ATTENTION');
    assert.match(missing.detail, /Site Investigation Report/);
  });

  it('notes that qualified bids are not permitted', () => {
    assert.ok(ids({ ...base, evaluation: { qualificationsPermitted: false } }).includes('NO_QUALIFICATIONS'));
  });
});

describe('the scale and the minimum, as published', () => {
  it('keeps a scale of distinct marks with their words, lowest first, and nothing less than two', () => {
    assert.deepEqual(cleanScale([{ score: 3, descriptor: 'Good' }, { score: 0, descriptor: 'None' }, { score: 3, descriptor: 'dup' }, { score: 1, descriptor: '' }]), [
      { score: 0, descriptor: 'None' },
      { score: 3, descriptor: 'Good' },
    ]);
    assert.equal(cleanScale([{ score: 5, descriptor: 'Excellent' }]), undefined);
  });

  it('reads a minimum mark per answer, and not a percentage threshold on the whole', () => {
    assert.equal(minimumScoreOf('a score of 2 on every quality question'), 2);
    assert.equal(minimumScoreOf('minimum of 3 on each question'), 3);
    assert.equal(minimumScoreOf('a minimum score of 60% overall'), undefined);
    assert.equal(minimumScoreOf('minimum 60 per cent'), undefined);
    assert.equal(minimumScoreOf(undefined), undefined);
  });
});
