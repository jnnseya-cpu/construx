import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as bim from '../src/engines/bim.ts';
import * as quality from '../src/engines/quality.ts';
import * as structure from '../src/domain/structure.ts';
import { assessCoverage, extractClauses, VERIFICATION_KINDS } from '../src/engines/maths/specification.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Reading a specification for what it requires.
 *
 * The specification decides whether work is acceptable and nobody reads it
 * until there is an argument. The clauses that cost money are not the ones
 * describing a material — those get priced — but the ones imposing a step
 * before or during the work: a sample to be approved, a test to be passed, a
 * hold point nobody may build through.
 *
 * The join is the point. A clause requiring a test with no inspection stage
 * against it is invisible to everybody: the quality manager reads the ITP, the
 * engineer reads the specification, and the gap exists only between the two.
 */

const SPEC = `
E10 IN SITU CONCRETE

3.1  Concrete shall comply with BS EN 206 and BS 8500-2, and shall be supplied
     by a plant holding current third party product conformity certification.

3.2  Submit the concrete mix design to the Engineer for approval not less than
     20 working days before the first pour is scheduled to take place.

3.3  A trial panel of the fair faced finish shall be constructed and approved
     before any permanent fair faced concrete is placed on the works.

3.4  Reinforcement shall not be covered until it has been inspected and released
     by the Engineer. This is a hold point.

3.5  Cube testing shall be carried out in accordance with BS EN 12390-3 at a
     rate of one set per 50 cubic metres or part thereof placed in any one day.

3.6  Formwork should be struck in a manner that avoids shock loading, having
     regard to the ambient temperature at the time of striking.

3.7  The finished surface tolerance shall be Class H20 measured in accordance
     with the National Structural Concrete Specification.
`;

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to ingest a specification section and write the inspection plan against it',
  });
});

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

describe('what a clause actually demands', () => {
  const clauses = extractClauses(SPEC, 'E10');

  const byRef = (suffix: string) => clauses.find((c) => c.clauseRef.endsWith(suffix));

  it('reads a hold point as a hold point, not as an inspection', () => {
    const clause = byRef('3.4');
    assert.ok(clause, 'clause 3.4 was found');
    assert.equal(clause.kind, 'HOLD_POINT');
    assert.equal(clause.mandatory, true);
    assert.ok(clause.triggers.length > 0, 'and says which words produced that');
  });

  it('ranks a hold point above the test wording that also appears in it', () => {
    // Clause 3.4 says both "inspected" and "shall not be covered". Reading it as
    // a test would lose the fact that work stops, which is the expensive half.
    const clause = byRef('3.4');
    assert.equal(clause?.kind, 'HOLD_POINT');
  });

  it('separates a submittal from a sample approval', () => {
    assert.equal(byRef('3.2')?.kind, 'SUBMITTAL');
    assert.equal(byRef('3.3')?.kind, 'SAMPLE_APPROVAL');
  });

  it('finds the test regime', () => {
    const clause = byRef('3.5');
    assert.equal(clause?.kind, 'TESTING');
    assert.deepEqual(clause?.standards, ['BS EN 12390-3']);
  });

  it('treats a material standard as priced rather than policed', () => {
    const clause = byRef('3.1');
    assert.equal(clause?.kind, 'MATERIAL_STANDARD');
    assert.equal(clause?.requiresVerification, false);
    assert.deepEqual(clause?.standards, ['BS EN 206', 'BS 8500-2']);
  });

  it('keeps shall and should apart, because a departure means different things', () => {
    assert.equal(byRef('3.5')?.mandatory, true, 'shall');
    assert.equal(byRef('3.6')?.mandatory, false, 'should');
  });

  it('reads an imperative as mandatory, which is how NBS writes obligations', () => {
    // "Submit the mix design" contains neither shall nor must, and is the most
    // common form of requirement in British specification writing. Reading it
    // as advisory would let most of a specification through as optional.
    assert.equal(byRef('3.2')?.mandatory, true);
    assert.equal(extractClauses('Provide certificates of conformity for all structural steelwork.', 'G10')[0]?.mandatory, true);
    assert.equal(
      extractClauses('Consideration should be given to the sequence of erection where practicable.', 'G10')[0]?.mandatory,
      false,
    );
  });

  it('marks exactly the kinds that put a step in front of the work', () => {
    for (const clause of clauses) {
      assert.equal(clause.requiresVerification, VERIFICATION_KINDS.includes(clause.kind));
    }
  });

  it('gives the same answer twice, so a classification can be argued with', () => {
    assert.deepEqual(extractClauses(SPEC, 'E10'), clauses);
  });

  it('references an unnumbered paragraph by position rather than dropping it', () => {
    const prose = extractClauses(
      'All work shall be carried out by operatives holding a current CSCS card appropriate to the trade.',
      'A12',
    );
    assert.equal(prose.length, 1);
    assert.match(prose[0]!.clauseRef, /^A12\/¶1$/);
  });

  it('ignores headings and page furniture', () => {
    const clauses = extractClauses('E10 IN SITU CONCRETE\n\nPage 4\n\n3.1 Something short.', 'E10');
    assert.equal(clauses.length, 0, 'none of those state a requirement');
  });
});

describe('coverage against the inspection plan', () => {
  it('reports a clause with a matching acceptance criterion as covered', () => {
    const clauses = extractClauses(SPEC, 'E10').map((c) => ({ ...c, specificationRef: 'E10' }));
    const coverage = assessCoverage(clauses, ['Reinforcement release — E10/3.4', 'Cube results to E10/3.5'], 1);

    assert.equal(coverage.covered, 2);
    assert.equal(coverage.requiringVerification, 4);
    assert.equal(coverage.gaps.length, 2);
  });

  it('matches on the bare clause number too, because an ITP author writes either', () => {
    const clauses = extractClauses(SPEC, 'E10').map((c) => ({ ...c, specificationRef: 'E10' }));
    const coverage = assessCoverage(clauses, ['Witness cube sampling, spec clause 3.5'], 1);

    assert.ok(coverage.covered >= 1);
  });

  it('leads on the hold point, because that is the one that stops work', () => {
    const clauses = extractClauses(SPEC, 'E10').map((c) => ({ ...c, specificationRef: 'E10' }));
    const coverage = assessCoverage(clauses, [], 1);

    assert.match(coverage.summary, /hold point/i);
    assert.match(coverage.gaps[0]!.consequence, /whatever the finished quality/);
  });

  it('does not let one section\'s plan cover another section\'s clause 3.4', () => {
    // Specifications number 3.4 in every section they have. Matching on the
    // bare number alone reported a dozen sections as covered by one plan — a
    // false all-clear, which is worse than a false alarm because nobody looks
    // again. The bare number counts only where the criterion names no other
    // section.
    const e20 = extractClauses(SPEC, 'E20').map((c) => ({ ...c, specificationRef: 'E20' }));
    const coveredByE10 = assessCoverage(e20, ['E10/3.4 — reinforcement released by the Engineer'], 2);

    assert.equal(coveredByE10.covered, 0);
    assert.ok(coveredByE10.gaps.some((g) => g.clauseRef === 'E20/3.4'));

    // A criterion naming no section at all still matches on the number, because
    // an ITP written against one specification does not repeat its name.
    const bareNumber = assessCoverage(e20, ['Reinforcement release, clause 3.4'], 1);
    assert.equal(bareNumber.covered, 1);
  });

  it('says a clause is uncovered rather than guessing it might be', () => {
    // An acceptance criterion written as prose does not join. The report says
    // uncovered, which is correctable; a fuzzy match that said covered would
    // not be, and nobody would look again.
    const clauses = extractClauses(SPEC, 'E10').map((c) => ({ ...c, specificationRef: 'E10' }));
    const coverage = assessCoverage(clauses, ['Check the concrete is alright before pouring'], 1);

    assert.equal(coverage.covered, 0);
    assert.equal(coverage.coveragePercent, 0);
  });

  it('separates an advisory gap from a mandatory one', () => {
    const clauses = extractClauses(
      '4.1  Samples of the paint finish should be submitted for comment.',
      'M60',
    ).map((c) => ({ ...c, specificationRef: 'M60' }));
    const coverage = assessCoverage(clauses, [], 1);

    assert.equal(coverage.advisoryGaps, 1);
    assert.match(coverage.gaps[0]!.consequence, /conversation, not a non-conformance/);
  });

  it('says nothing has been ingested rather than reporting perfect coverage', () => {
    // Zero of zero is 100%, which reads as excellent and means no data.
    const coverage = assessCoverage([], [], 0);
    assert.match(coverage.summary, /No specification has been ingested/);
  });
});

describe('through the platform', () => {
  let specificationId: string;

  it('ingests a section and writes a clause for each requirement', async () => {
    // A different section from the one the seed already carries: this suite is
    // testing the extraction, not competing with the fixture for clause refs.
    const result = await bim.ingestSpecification(ctx('bim'), {
      sectionRef: 'E20',
      title: 'Formwork for in situ concrete',
      revision: 'A',
      specificationText: SPEC,
      documentHash: hashEvidence('spec-e20-rev-a'),
    });

    specificationId = result.specificationId;
    assert.equal(result.clauses, 7);
    assert.equal(result.requiringVerification, 4);
    assert.equal(result.clauseIds.length, 7);

    const record = platform.ledger.require({ refType: 'Specification', refId: specificationId });
    assert.equal(record.state.sectionRef, 'E20');
    assert.equal(record.state.source, 'SUPPLIED_TEXT', 'and says the text was supplied, not read');
  });

  it('refuses a scan, and says why rather than producing nothing', async () => {
    await rejectsCode(
      () =>
        bim.ingestSpecification(ctx('bim'), {
          sectionRef: 'E20',
          title: 'Scanned section',
          revision: 'A',
          specificationText: '[scanned image]',
          documentHash: hashEvidence('scan'),
        }),
      'SPECIFICATION_TOO_SHORT',
    );
  });

  it('reports a section that imposes nothing as imposing nothing, rather than refusing it', async () => {
    // A contents page and a section of general guidance look the same from
    // here, and claiming to tell them apart would be inventing. What the
    // platform can say is that nothing in the text imposes a step before or
    // during the work, which is true of both and useful about either.
    const result = await bim.ingestSpecification(ctx('bim'), {
      sectionRef: 'A00',
      title: 'Contents',
      revision: 'A',
      specificationText: [
        'CONTENTS',
        '',
        'A12  Preliminaries',
        'A13  Contract administration',
        'E10  In situ concrete',
        'E20  Formwork',
        'E30  Reinforcement',
        'M60  Painting and clear finishes',
      ].join('\n'),
      documentHash: hashEvidence('contents'),
    });

    assert.equal(result.requiringVerification, 0);
  });

  it('refuses text with no clause in it at all', async () => {
    await rejectsCode(
      () =>
        bim.ingestSpecification(ctx('bim'), {
          sectionRef: 'A01',
          title: 'Nothing',
          revision: 'A',
          specificationText: `${'-'.repeat(60)}\n\n${'='.repeat(60)}\n\n${'.'.repeat(30)}`,
          documentHash: hashEvidence('rules'),
        }),
      'NO_CLAUSES_FOUND',
    );
  });

  it('reports the newly ingested section as entirely uncovered', () => {
    // The seeded E10 already has an inspection plan against two of its clauses.
    // E20 has none, so every one of its verification clauses is a gap — and the
    // report leads on the hold point, which is the one that stops work.
    const coverage = bim.specificationCoverage(ctx('bim'));

    assert.ok(coverage.specifications >= 2);
    assert.ok(coverage.gaps.some((g) => g.kind === 'HOLD_POINT' && g.clauseRef.startsWith('E20/')));
    assert.match(coverage.summary, /hold point/i);
  });

  it('closes the gap once an inspection stage names the clause', () => {
    const before = bim.specificationCoverage(ctx('bim'));
    const workPackageId = platform.ledger.list(seed.projectId, 'WorkPackage')[0]?.refId ?? 'WP-1';

    quality.createInspectionPlan(ctx('qaqc'), {
      workPackageId,
      title: 'Formwork — clarifier walls',
      discipline: 'CIVILS',
      specificationRef: 'E20',
      stages: [
        {
          reference: 'S1',
          description: 'Reinforcement inspection before covering',
          acceptanceCriteria: 'E20/3.4 — reinforcement released by the Engineer',
          type: 'HOLD',
          responsible: 'Engineer',
        },
        {
          reference: 'S2',
          description: 'Cube sampling at the rate specified',
          acceptanceCriteria: 'E20/3.5 — one set per 50m³ to BS EN 12390-3',
          type: 'WITNESS',
          responsible: 'QA engineer',
        },
      ],
    });

    const after = bim.specificationCoverage(ctx('bim'));

    assert.equal(after.covered, before.covered + 2);
    assert.ok(
      !after.gaps.some((g) => g.kind === 'HOLD_POINT' && g.clauseRef.startsWith('E20/')),
      'the E20 hold point is now inspected',
    );
    assert.ok(
      after.gaps.some((g) => g.clauseRef.startsWith('E20/') && (g.kind === 'SUBMITTAL' || g.kind === 'SAMPLE_APPROVAL')),
      'the submittal and the trial panel remain uncovered',
    );
    assert.ok(after.coveragePercent > before.coveragePercent);
  });

  it('refuses the coverage report to a role with no design access', () => {
    assert.throws(() => bim.specificationCoverage(platform.context(seed.users.fm!.auth, seed.projectId)), /holds|ACCESS_DENIED/);
  });
});
